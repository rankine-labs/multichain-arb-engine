// ============================================================================
// SOCKET SERVER: the bot talks to the sidecar here.
//
// Plain English:
//   A Unix socket (a local pipe, no network) at $ARBSIM_SOCKET (default
//   /tmp/arbsim.sock). Each connection gets a reader thread. Feed frames are
//   handed to the updater instantly (never waiting on anything). Questions
//   (call / size_search / status / warm) go to a small pool of worker
//   threads, so a slow question never holds up the feed or other questions.
//   Answers are written back on the same connection, possibly out of order
//   (each carries its request id).
//
//   Live checks: the server picks the state for `at` (state/mirror.rs) and
//   hands it to the check engine (check::proto_types::handle_call /
//   handle_size_search, workstream C). If the check says "unknown: miss",
//   the missing items are queued for fetching so the next check is warm.
//   Pinned checks (`at.pinned`): run on a separate exact view of block N
//   that is filled from the node until the check is sure (state/pinned.rs).
//
//   Copy 2 (ARBSIM_SOURCE=pool-events, copy2/intake.rs): `pool_logs` and
//   `block_tick` go straight to the copy-2 thread like feed frames (no
//   answer); `track` answers {ok, tracked}; missed items and `warm` go to
//   copy 2 instead of the feed updater; a check whose missing items belong
//   to a pool that isn't ready answers "unknown: unsure_pool".
// ============================================================================
use std::io::BufWriter;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::arb::BlockCtx;
use crate::check::proto_types::{handle_call, handle_size_search, CallRequest, SizeSearchRequest};
use crate::copy2::checkview::{fee_nonzero, high_offset, C2View};
use crate::copy2::intake::Copy2Handle;
use crate::node::env_u64;
use crate::proto::{bad_request, parse_at, parse_missing, parse_warm, read_msg, unknown, write_msg};
use crate::state::fill::FillQueue;
use crate::state::mirror::{At, Shared, Stats};
use crate::state::pinned::{PinnedCache, PinnedErr};
use crate::state::snap::View;
use crate::state::updater::UpdaterHandle;
use crate::state::StateRead;
use crate::timing::Tm;

/// Everything request handlers need.
pub struct Ctx {
    pub shared: Arc<Shared>,
    pub updater: UpdaterHandle,
    pub fills: Arc<FillQueue>,
    pub pinned: PinnedCache,
    /// Copy 2 (pool-events source); None = the feed updater is the source.
    pub copy2: Option<Copy2Handle>,
}

impl Ctx {
    /// Items a check missed: to whichever thread keeps the copy.
    fn fill(&self, items: Vec<crate::state::MissItem>) {
        match &self.copy2 {
            Some(c) => c.fill(items),
            None => self.updater.fill(items),
        }
    }
}

type Writer = Arc<Mutex<BufWriter<UnixStream>>>;

/// One queued question.
struct Job {
    req: Value,
    out: Writer,
    /// When the socket thread read it (queue wait = until a worker takes it).
    queued: Instant,
}

/// Start the server (blocks forever, serving connections).
pub fn serve(ctx: Arc<Ctx>, path: &str) -> std::io::Result<()> {
    let listener = bind(path)?;
    run(ctx, listener)
}

/// Bind the socket (removing a stale one first), owner-only access.
pub fn bind(path: &str) -> std::io::Result<UnixListener> {
    let _ = std::fs::remove_file(path);
    let l = UnixListener::bind(path)?;
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    Ok(l)
}

/// Serve connections on an already-bound listener (tests use this).
pub fn run(ctx: Arc<Ctx>, listener: UnixListener) -> std::io::Result<()> {
    let workers = env_u64("ARBSIM_WORKERS", 2).clamp(1, 16) as usize;
    // Bounded: if the workers are swamped, new questions get "busy" at once.
    let (tx, rx) = sync_channel::<Job>(256);
    let rx = Arc::new(Mutex::new(rx));
    for i in 0..workers {
        let rx = rx.clone();
        let ctx = ctx.clone();
        std::thread::Builder::new().name(format!("arbsim-worker-{i}")).spawn(move || worker(ctx, rx))?;
    }
    for conn in listener.incoming() {
        let Ok(stream) = conn else { continue };
        let ctx = ctx.clone();
        let tx = tx.clone();
        std::thread::Builder::new().name("arbsim-conn".into()).spawn(move || {
            let _ = connection(ctx, stream, tx);
        })?;
    }
    Ok(())
}

fn worker(ctx: Arc<Ctx>, rx: Arc<Mutex<Receiver<Job>>>) {
    loop {
        let job = match rx.lock().unwrap().recv() {
            Ok(j) => j,
            Err(_) => return,
        };
        let mut tm = Tm { queue_us: job.queued.elapsed().as_micros() as u64, ..Tm::default() };
        let answer = handle_tm(&ctx, &job.req, &mut tm);
        let t_send = Instant::now();
        send(&job.out, &answer);
        if answer.get("t").is_some() {
            let inside = tm.queue_us + answer.get("us").and_then(|u| u.as_u64()).unwrap_or(0);
            crate::timing::record_check(&tm, inside, t_send.elapsed().as_micros() as u64);
        }
    }
}

fn send(out: &Writer, v: &Value) {
    let body = serde_json::to_vec(v).unwrap_or_default();
    let mut w = out.lock().unwrap();
    if write_msg(&mut *w, &body).is_ok() {
        let _ = std::io::Write::flush(&mut *w);
    }
}

fn connection(ctx: Arc<Ctx>, stream: UnixStream, jobs: SyncSender<Job>) -> std::io::Result<()> {
    let out: Writer = Arc::new(Mutex::new(BufWriter::new(stream.try_clone()?)));
    let mut r = std::io::BufReader::new(stream);
    while let Some(body) = read_msg(&mut r)? {
        let req: Value = match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(_) => {
                send(&out, &bad_request(&Value::Null, "not JSON"));
                continue;
            }
        };
        // Copy 2 block reports: straight to the copy-2 thread, no answer.
        let ty = req.get("type").and_then(|t| t.as_str());
        if ty == Some("pool_logs") || ty == Some("block_tick") {
            if let Some(c) = &ctx.copy2 {
                c.block_json(&req);
            }
            continue;
        }
        // Feed frames: straight to the updater, no answer, never blocks.
        // (Ignored in copy-2 mode: the feed is not the source then.)
        if req.get("type").and_then(|t| t.as_str()) == Some("feed") {
            if ctx.copy2.is_some() {
                continue;
            }
            if let Some(f) = req.get("frame") {
                let text = match f {
                    Value::String(s) => s.clone(),
                    other => other.to_string(), // already-parsed JSON frame
                };
                ctx.updater.frame(text);
            }
            continue;
        }
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        if jobs.try_send(Job { req, out: out.clone(), queued: Instant::now() }).is_err() {
            send(&out, &unknown(&id, "not_ready", "sidecar busy", 0));
        }
    }
    Ok(())
}

/// Answer one question (also used directly by tests).
pub fn handle(ctx: &Ctx, req: &Value) -> Value {
    handle_tm(ctx, req, &mut Tm::default())
}

/// Answer one question, noting where the time went (checks: answer "t").
pub fn handle_tm(ctx: &Ctx, req: &Value, tm: &mut Tm) -> Value {
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let t0 = Instant::now();
    match req.get("type").and_then(|t| t.as_str()) {
        Some("status") => {
            let mut s = ctx.shared.status_json();
            s["id"] = id;
            s["fillQueue"] = json!(ctx.fills.len());
            s["fillQueueDropped"] = json!(ctx.fills.dropped());
            s["warmItems"] = json!(ctx.fills.warm_len());
            s["pinnedBlocks"] = json!(ctx.pinned.cached());
            if let Some(c) = &ctx.copy2 {
                s["copy2"] = c.status_json(req.get("pools").and_then(|p| p.as_bool()).unwrap_or(false));
            }
            if let Value::Object(t) = crate::timing::status() {
                for (k, v) in t {
                    s[k] = v;
                }
            }
            s
        }
        Some("warm") => match parse_warm(req) {
            Ok(items) => {
                let n = items.len();
                match &ctx.copy2 {
                    Some(c) => c.fill(items),
                    None => ctx.updater.warm(items),
                }
                json!({ "id": id, "ok": true, "queued": n })
            }
            Err(e) => bad_request(&id, &e),
        },
        Some("track") => match &ctx.copy2 {
            Some(c) => c.track_json(&id, req),
            None => bad_request(&id, "track needs ARBSIM_SOURCE=pool-events"),
        },
        Some("coin_slots") => match &ctx.copy2 {
            Some(c) => c.coin_slots_json(&id, req),
            None => bad_request(&id, "coin_slots needs ARBSIM_SOURCE=pool-events"),
        },
        Some("call") => {
            warm_check_accounts(ctx, req);
            let req = &caller_as_empty(ctx, req);
            let r: CallRequest = match serde_json::from_value(req.clone()) {
                Ok(r) => r,
                Err(e) => return bad_request(&id, &format!("call: {e}")),
            };
            tm.prep_us = t0.elapsed().as_micros() as u64;
            check(ctx, &id, &r.at, t0, tm, |view, c| handle_call(view, c, &r))
        }
        Some("size_search") => {
            warm_check_accounts(ctx, req);
            let req = &caller_as_empty(ctx, req);
            let r: SizeSearchRequest = match serde_json::from_value(req.clone()) {
                Ok(r) => r,
                Err(e) => return bad_request(&id, &format!("size_search: {e}")),
            };
            tm.prep_us = t0.elapsed().as_micros() as u64;
            check(ctx, &id, &r.at, t0, tm, |view, c| handle_size_search(view, c, &r))
        }
        Some(t) => bad_request(&id, &format!("unknown request type '{t}'")),
        None => bad_request(&id, "request has no type"),
    }
}

/// Copy 2 only: accounts the request gives contract CODE by override (the
/// bot's simulated ArbExecutor): their coin balance slots are fetched ahead
/// (Copy2Handle::warm_check_accounts), so a check through a new coin doesn't
/// miss them the first time.
fn warm_check_accounts(ctx: &Ctx, req: &Value) {
    let Some(c) = &ctx.copy2 else { return };
    let Some(ov) = req.get("overrides").and_then(|o| o.as_object()) else { return };
    let accts: Vec<revm::primitives::Address> = ov
        .iter()
        .filter(|(_, v)| v.get("code").is_some())
        .filter_map(|(k, _)| crate::check::hexutil::parse_address(k).ok())
        .collect();
    c.warm_check_accounts(&accts);
}

/// Copy 2 only: the CALLER (`from`) of a check is usually a plain wallet
/// (the bot's sim caller, the checker's probe address) that copy 2 never
/// follows, so its basics are unknown and every check would answer "miss".
/// A check runs with gas price 0, no fee charged, no balance / nonce checks,
/// so the caller's basics only matter if the called code reads the caller's
/// own ETH balance / code / nonce. We therefore answer as if the request had
/// the override {from: {balance 0, nonce 0, code empty}} (only when the
/// request doesn't override `from` itself and the copy doesn't know it).
/// The answer is EXACTLY what the node gives for the same call with that
/// override (the checker should pass it to the node too when comparing).
fn caller_as_empty(ctx: &Ctx, req: &Value) -> Value {
    let Some(_) = &ctx.copy2 else { return req.clone() };
    let mut out = req.clone();
    let mut froms: Vec<String> = Vec::new();
    if let Some(cs) = req.get("calls").and_then(|c| c.as_array()) {
        froms.extend(cs.iter().filter_map(|c| c.get("from").and_then(|f| f.as_str()).map(|s| s.to_string())));
    }
    if let Some(f) = req.get("template").and_then(|t| t.get("from")).and_then(|f| f.as_str()) {
        froms.push(f.to_string());
    }
    let head = ctx.shared.head();
    for f in froms {
        let Ok(a) = crate::check::hexutil::parse_address(&f) else { continue };
        let known = head.as_ref().is_some_and(|h| !matches!(h.snap.account(a), crate::state::Lookup::Missing));
        let has_ov = req.get("overrides").and_then(|o| o.as_object()).is_some_and(|o| {
            o.keys().any(|k| crate::check::hexutil::parse_address(k).ok() == Some(a))
        });
        if known || has_ov {
            continue;
        }
        if !out.get("overrides").is_some_and(|o| o.is_object()) {
            out["overrides"] = json!({});
        }
        out["overrides"][format!("{a:#x}")] = json!({ "balance": "0x0", "nonce": "0x0", "code": "0x" });
    }
    out
}

/// Pick the state for `at`, run the check, learn from misses.
fn check(ctx: &Ctx, id: &Value, at: &Value, t0: Instant, tm: &mut Tm, run: impl Fn(&dyn StateRead, &BlockCtx) -> Value) -> Value {
    let mut a = check_inner(ctx, id, at, t0, tm, run);
    let used = tm.prep_us + tm.resolve_us + tm.facts_us + tm.runs_us.iter().sum::<u64>();
    tm.post_us = (t0.elapsed().as_micros() as u64).saturating_sub(used);
    a["t"] = tm.json();
    a
}

fn check_inner(ctx: &Ctx, id: &Value, at: &Value, t0: Instant, tm: &mut Tm, run: impl Fn(&dyn StateRead, &BlockCtx) -> Value) -> Value {
    let sh = &ctx.shared;
    Stats::inc(&sh.stats.checks);
    let at = match parse_at(at) {
        Ok(a) => a,
        Err(e) => return bad_request(id, &e),
    };
    if let At::Pinned { block, next } = at {
        return pinned_check(ctx, id, block, next, t0, run);
    }
    let t_res = Instant::now();
    let resolved = sh.resolve(&at);
    tm.resolve_us = t_res.elapsed().as_micros() as u64;
    let picked = match resolved {
        Ok(p) => p,
        Err(e) => {
            Stats::inc(&sh.stats.checks_unknown);
            if let Some(c) = &ctx.copy2 {
                c.note_unknown(e.reason, &[]);
            }
            return unknown(id, e.reason, &e.detail, t0.elapsed().as_micros() as u64);
        }
    };
    let block = picked.seq + sh.cfg.l2_offset;
    // Copy 2: one registry summary for the whole check (checkcore.rs: no
    // waiting for the copy's thread while it is valid for this version).
    let t_core = Instant::now();
    let core = ctx.copy2.as_ref().map(|c| c.core_for(picked.from.as_ref()));
    tm.facts_us = t_core.elapsed().as_micros() as u64;
    let view = View::new(picked.snap);
    let mut answer = match &ctx.copy2 {
        None => {
            let t = Instant::now();
            let a = run(&view, &picked.ctx);
            tm.runs_us.push(t.elapsed().as_micros() as u64);
            a
        }
        Some(c) => copy2_run(c, core.as_deref().expect("copy 2 core"), &view, block, &picked.ctx, tm, &run),
    };
    if ctx.copy2.is_none() {
        ctx.updater.touched(view.take_touched());
    } else if let Some(c) = &ctx.copy2 {
        // Copy 2: a pool on the route may still be missing reports of this
        // block (header bloom / coin transfers not in yet): never answer
        // from such a version (dry run #17: 4 probes with a wrong price /
        // coin balances).
        // (Only an ANSWER is withheld: a miss stays a miss, so its fills run.)
        let all = view.touched_overflow();
        let answered = answer.get("ok") == Some(&Value::Bool(true));
        if let Some(why) = if answered { c.pending_reason_with(core.as_deref().expect("copy 2 core"), &view.take_touched(), block, all) } else { None } {
            let id = answer.get("id").cloned().unwrap_or(Value::Null);
            answer = json!({ "id": id, "ok": false, "unknown": "pending_reports", "detail": why });
        }
    }
    if answer.get("ok") == Some(&Value::Bool(true)) {
        Stats::inc(&sh.stats.checks_ok);
    } else {
        Stats::inc(&sh.stats.checks_unknown);
        let missing = parse_missing(&answer);
        if !missing.is_empty() {
            Stats::inc(&sh.stats.misses);
            if let Some(c) = &ctx.copy2 {
                c.note_misses(&missing);
            }
            // Copy 2: missing because a pool on the route isn't ready?
            if let Some(why) = ctx.copy2.as_ref().zip(core.as_deref()).and_then(|(c, k)| c.unsure_reason_with(k, &missing)) {
                answer["unknown"] = json!("unsure_pool");
                answer["detail"] = json!(why);
            }
        }
        // Copy 2: every unanswered check counted by its reason (status
        // checks.unknownBy) and, for misses, by what it missed (blockedBy).
        if let Some(c) = &ctx.copy2 {
            let why = answer.get("unknown").and_then(|u| u.as_str()).unwrap_or("error");
            c.note_unknown(why, &missing);
        }
        if !missing.is_empty() {
            ctx.fill(missing);
        }
    }
    // Total time inside the sidecar (state pick + check).
    answer["us"] = json!(t0.elapsed().as_micros() as u64);
    answer
}

/// Copy 2: run the check on the copy's view plus what the copy vouches for
/// without holding it (copy2/checkview.rs: far zero tick-map words, the V4
/// PoolManager's balances at a proven lower bound, the V4 protocol fee
/// counters). A run that read a PoolManager balance is repeated with that
/// balance far higher; the answer stands only if both runs agree exactly,
/// else "unknown". A run that read a protocolFeesAccrued counter (never
/// held) is repeated with the counter not zero (and that run's balance pair
/// too, if it read a balance): the answer stands only if the two differ in
/// gas alone; it then reports the HIGHER gas of each gas field (counter 0 =
/// the costlier 0 -> non-zero store), so the bot never overestimates profit.
///
/// copy2-r (live Oct 22, RIVN/USDG: copy "the trade reverts", the node at
/// the same block "completes at a loss"): the "far higher" run must make the
/// COIN see a balance above any real one. Live USDG counts only the low 128
/// bits of its balance word, so "bound + 2^200" read as "bound": both runs
/// ran at the (too small) lower bound, both reverted the same way in the
/// PoolManager's take, and that agreement was reported as a proven revert.
/// Now each coin's high value is checked first (coin_highs): the coin must
/// read back the bound exactly and the high value exactly, and the high
/// value must be above the coin's whole supply; else "unknown".
fn copy2_run(c: &Copy2Handle, core: &crate::copy2::checkcore::CheckCore, view: &View, block: u64, bctx: &BlockCtx, tm: &mut Tm, run: &impl Fn(&dyn StateRead, &BlockCtx) -> Value) -> Value {
    let t_facts = Instant::now();
    let facts = c.check_facts_with(core, block);
    tm.facts_us += t_facts.elapsed().as_micros() as u64;
    let runs = std::cell::RefCell::new(RunLog::default());
    let a = copy2_runs(c, view, &facts, bctx, &runs, run);
    let r = runs.into_inner();
    tm.runs_us = r.us;
    tm.runs_what = r.what;
    tm.far_used = r.far;
    a
}

/// The EVM runs of one copy-2 check: time, what each was, far words read.
#[derive(Default)]
pub struct RunLog {
    pub us: Vec<u64>,
    /// "b" bound run / "h" high run, then the protocol fee counter value
    /// ("0" / "1"), then "f" when the bound was the full one; "p" = a plain
    /// run (nothing assumed); "c" = a coin's balanceOf / totalSupply read
    /// to pick its high value.
    pub what: Vec<String>,
    pub far: u64,
}

/// One word returned by a view call on `v` (None: reverted / short output).
fn view_word(v: &dyn StateRead, bctx: &BlockCtx, to: revm::primitives::Address, data: Vec<u8>) -> Result<Option<revm::primitives::U256>, crate::check::CheckUnknown> {
    let call = crate::check::CallReq { from: revm::primitives::Address::ZERO, to: Some(to), data: data.into(), gas: Some(1_000_000), value: revm::primitives::U256::ZERO };
    let out = crate::check::run_calls(v, bctx, &crate::check::Overrides::default(), &[], std::slice::from_ref(&call))?;
    Ok(out.first().filter(|o| o.success && o.output.len() >= 32).map(|o| revm::primitives::U256::from_be_slice(&o.output[..32])))
}

fn abi_addr(sel: &str, a: revm::primitives::Address) -> Vec<u8> {
    let mut d = revm::primitives::keccak256(sel.as_bytes())[..4].to_vec();
    d.extend_from_slice(&[0u8; 12]);
    d.extend_from_slice(a.as_slice());
    d
}

/// Remembered per coin: the high exponent that worked last time (only a
/// starting point: it is checked again every time).
fn high_hint() -> &'static Mutex<std::collections::HashMap<revm::primitives::Address, usize>> {
    static H: std::sync::OnceLock<Mutex<std::collections::HashMap<revm::primitives::Address, usize>>> = std::sync::OnceLock::new();
    H.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// The high run's value must be at least the coin's totalSupply times this
/// (2^8): no balance can exceed the supply, and the held supply is at most
/// one verify round (ARBSIM_COPY2_VERIFY_S, 60 s) old.
pub const SUPPLY_MARGIN_BITS: usize = 8;

/// copy2-r / copy2-s: for each PoolManager coin balance the bound run read,
/// the value H the high run adds to the bound P, such that
///   - the coin reads back P and P + H exactly (balanceOf(PoolManager)),
///   - P + H is above any balance the coin can have: H = 2^200, or (a coin
///     that counts only part of its balance word: live USDG counts the low
///     64 bits) H = 2^(k-1) where 2^k is the largest power the coin still
///     reads back, and only if P + H >= totalSupply x 2^8,
///   - and coins paid in during the check can't overflow its field (H is
///     half the field: P + H + anything up to the supply still fits).
/// Err = the answer to give (unknown "pool_manager_balance", or a "miss"
/// for the coin values the reads needed, which then get filled).
pub fn coin_highs(
    view: &dyn StateRead,
    facts: &crate::copy2::checkview::C2Facts,
    bctx: &BlockCtx,
    coins: &[(revm::primitives::Address, revm::primitives::Address)],
    runs: &std::cell::RefCell<RunLog>,
) -> Result<(std::collections::HashMap<revm::primitives::Address, revm::primitives::U256>, bool), (String, Option<crate::check::CheckUnknown>)> {
    use revm::primitives::{Address, U256};
    let mut out = std::collections::HashMap::new();
    let mut narrow = false;
    let timed = |f: &mut dyn FnMut() -> Result<Option<U256>, crate::check::CheckUnknown>| {
        let t = Instant::now();
        let r = f();
        let mut l = runs.borrow_mut();
        l.us.push(t.elapsed().as_micros() as u64);
        l.what.push("c".into());
        r
    };
    let miss = |u| (String::new(), Some(u));
    for (pm, coin) in coins {
        if *coin == Address::ZERO {
            continue; // ETH: a plain account balance, every bit counts
        }
        let low = C2View::new(view, facts, U256::ZERO);
        let p = low.lower_bound(*pm, *coin);
        let bal = abi_addr("balanceOf(address)", *pm);
        let seen = timed(&mut || view_word(&low, bctx, *coin, bal.clone())).map_err(miss)?;
        if seen != Some(p) {
            return Err((format!("coin {coin}: balanceOf(PoolManager) does not read the stored balance word (stored {p:#x}, reads {seen:?}): its bound can't be put in"), None));
        }
        // Does the coin read back P + 2^k exactly?
        let reads = |k: usize| -> Result<bool, crate::check::CheckUnknown> {
            let h = U256::from(1u8) << k;
            let hv = C2View::with_offsets(view, facts, crate::copy2::checkview::high_offset(), U256::ZERO, std::collections::HashMap::from([(*coin, h)]));
            Ok(timed(&mut || view_word(&hv, bctx, *coin, bal.clone()))? == Some(p.saturating_add(h)))
        };
        let hint = high_hint().lock().unwrap().get(coin).copied().filter(|h| *h < 200);
        // A remembered half-field exponent: it still reads back and the
        // field still ends where it did (2 runs). Else 2^200 (1 run), else
        // the search.
        let k = if let Some(h) = hint.filter(|h| reads(*h).unwrap_or(false) && !reads(*h + 2).unwrap_or(true)) {
            h
        } else if reads(200).map_err(miss)? {
            200
        } else {
            // Largest k the coin reads back: the coin keeps the low w bits,
            // P + 2^k reads back exactly while P + 2^k < 2^w (monotone for
            // k above P's own bits). Binary search over [bits(P), 199].
            let (mut lo, mut hi) = (p.bit_len().max(8), 199usize);
            if !reads(lo).map_err(miss)? {
                return Err((format!("coin {coin}: reads back no larger PoolManager balance than the bound {p:#x}"), None));
            }
            while lo < hi {
                let mid = (lo + hi).div_ceil(2);
                if reads(mid).map_err(miss)? {
                    lo = mid;
                } else {
                    hi = mid - 1;
                }
            }
            // Half the field (room for coins paid in during the check),
            // checked to read back too.
            let k = lo.saturating_sub(1);
            if !reads(k).map_err(miss)? {
                high_hint().lock().unwrap().remove(coin);
                return Err((format!("coin {coin}: no high balance value the coin reads back"), None));
            }
            k
        };
        if k < 200 {
            let supply = timed(&mut || view_word(&low, bctx, *coin, revm::primitives::keccak256(b"totalSupply()")[..4].to_vec())).map_err(miss)?;
            let want = p.saturating_add(U256::from(1u8) << k);
            if !supply.is_some_and(|s| s.bit_len() + SUPPLY_MARGIN_BITS < 256 && (s << SUPPLY_MARGIN_BITS) <= want) {
                high_hint().lock().unwrap().insert(*coin, k);
                return Err((format!("coin {coin}: counts only {} bits of its balance word; the high value ({want:#x}) is not far enough above its totalSupply ({supply:?})", k + 2), None));
            }
            narrow = true;
        }
        high_hint().lock().unwrap().insert(*coin, k);
        out.insert(*coin, U256::from(1u8) << k);
    }
    Ok((out, narrow))
}

pub fn copy2_runs(c: &Copy2Handle, view: &View, facts: &crate::copy2::checkview::C2Facts, bctx: &BlockCtx, runs: &std::cell::RefCell<RunLog>, run: &impl Fn(&dyn StateRead, &BlockCtx) -> Value) -> Value {
    use std::sync::atomic::Ordering::Relaxed;
    if facts.is_empty() {
        let t = Instant::now();
        let a = run(view, bctx);
        let mut r = runs.borrow_mut();
        r.us.push(t.elapsed().as_micros() as u64);
        r.what.push("p".into());
        return a;
    }
    let zero = revm::primitives::U256::ZERO;
    type Highs = std::collections::HashMap<revm::primitives::Address, revm::primitives::U256>;
    let run_at = |high: Option<&Highs>, fee: revm::primitives::U256| {
        let v = match high {
            None => C2View::with_fee(view, facts, zero, fee),
            Some(m) => C2View::with_offsets(view, facts, high_offset(), fee, m.clone()),
        };
        let t = Instant::now();
        let a = run(&v, bctx);
        let (b, f) = (v.used_bound(), v.used_fee());
        let mut r = runs.borrow_mut();
        r.us.push(t.elapsed().as_micros() as u64);
        r.what.push(format!("{}{}{}", if high.is_some() { "h" } else { "b" }, if fee.is_zero() { "0" } else { "1" }, if facts.full.load(Relaxed) { "f" } else { "" }));
        r.far = r.far.max(v.far_hits());
        (a, b, f, v.read_coins())
    };
    let ok = |v: &Value| v.get("ok") == Some(&Value::Bool(true));
    let unknown = |a: &Value, why: &str, detail: &str| {
        let id = a.get("id").cloned().unwrap_or(Value::Null);
        json!({ "id": id, "ok": false, "unknown": why, "detail": detail })
    };
    const PM_DETAIL: &str = "the answer depends on the V4 PoolManager's coin / ETH balance, which copy 2 does not follow (same check at a proven lower bound and far above it differ)";
    // One fee value: the run at the bound, confirmed far above it if it read
    // a PoolManager balance. Err = the unknown answer to give.
    // The bound is first summed over the pools this check traded on only
    // (checkview.rs: any proven lower bound is sound; a too small one only
    // makes the two runs differ). If they differ with that smaller bound,
    // both runs again with the full bound (every ready V4 pool), as before.
    let confirmed = |fee| -> Result<(Value, bool), Value> {
        loop {
            let (a, used_bound, used_fee, coins) = run_at(None, fee);
            if !used_bound || !ok(&a) {
                return Ok((a, used_fee));
            }
            let highs = match coin_highs(view, facts, bctx, &coins, runs) {
                Ok((m, narrow)) => {
                    if narrow {
                        c.note_pm_high(true);
                    }
                    m
                }
                Err((why, miss)) => {
                    let id = a.get("id").cloned().unwrap_or(Value::Null);
                    return Err(match miss {
                        Some(u) => crate::check::proto_types::unknown_json(&id, &u, 0),
                        None => {
                            c.note_pm_high(false);
                            unknown(&a, "pool_manager_balance", &why)
                        }
                    });
                }
            };
            let (again, _, _, _) = run_at(Some(&highs), fee);
            let same = strip_us(&a) == strip_us(&again);
            let partial = facts.partial_used.load(Relaxed) && !facts.full.load(Relaxed);
            if !same && partial {
                c.note_pm_bound_kind(true);
                facts.go_full();
                continue;
            }
            if partial {
                c.note_pm_bound_kind(false);
            }
            c.note_pm_bound(same);
            return if same { Ok((a, used_fee)) } else { Err(unknown(&a, "pool_manager_balance", PM_DETAIL)) };
        }
    };
    let (a, used_fee) = match confirmed(zero) {
        Ok(x) => x,
        Err(u) => return u,
    };
    if !used_fee || !ok(&a) {
        return a;
    }
    let (b, _) = match confirmed(fee_nonzero()) {
        Ok(x) => x,
        Err(u) => return u,
    };
    if !ok(&b) {
        // e.g. the other path reads a value the copy doesn't hold: that
        // answer (its misses get filled).
        c.note_protocol_fee(false);
        return b;
    }
    let merged = same_but_gas(&strip_us(&a), &strip_us(&b));
    c.note_protocol_fee(merged.is_some());
    match merged {
        Some(mut m) => {
            if let (Some(us), Some(o)) = (a.get("us").cloned(), m.as_object_mut()) {
                o.insert("us".into(), us);
            }
            m
        }
        None => unknown(
            &a,
            "protocol_fee",
            "the answer depends on a V4 protocolFeesAccrued counter beyond gas (copy 2 does not follow it; the check with it 0 and not 0 differ)",
        ),
    }
}

fn strip_us(v: &Value) -> Value {
    let mut v = v.clone();
    if let Some(m) = v.as_object_mut() {
        m.remove("us");
    }
    v
}

/// Two answers that are identical except for `gasUsed` fields: one answer
/// with the higher value of each gas field. None if anything else differs.
pub fn same_but_gas(a: &Value, b: &Value) -> Option<Value> {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            if x.len() != y.len() {
                return None;
            }
            let mut out = serde_json::Map::new();
            for (k, va) in x {
                let vb = y.get(k)?;
                if k == "gasUsed" {
                    let (ga, gb) = (gas_num(va)?, gas_num(vb)?);
                    out.insert(k.clone(), if gb > ga { vb.clone() } else { va.clone() });
                } else {
                    out.insert(k.clone(), same_but_gas(va, vb)?);
                }
            }
            Some(Value::Object(out))
        }
        (Value::Array(x), Value::Array(y)) => {
            if x.len() != y.len() {
                return None;
            }
            Some(Value::Array(x.iter().zip(y).map(|(p, q)| same_but_gas(p, q)).collect::<Option<Vec<_>>>()?))
        }
        _ => (a == b).then(|| a.clone()),
    }
}

fn gas_num(v: &Value) -> Option<u64> {
    match v {
        Value::String(s) => crate::check::hexutil::parse_u64(s).ok(),
        Value::Number(n) => n.as_u64(),
        _ => None,
    }
}

fn pinned_check(ctx: &Ctx, id: &Value, block: u64, next: bool, t0: Instant, run: impl Fn(&dyn StateRead, &BlockCtx) -> Value) -> Value {
    let sh = &ctx.shared;
    Stats::inc(&sh.stats.pinned_checks);
    let Some(node) = sh.node.clone() else {
        return unknown(id, "not_ready", "pinned views need a node (ARBSIM_NODE_URL)", 0);
    };
    let r = ctx.pinned.run(
        &*node,
        block,
        next,
        sh.cfg.pin_rounds,
        Duration::from_millis(sh.cfg.pin_timeout_ms),
        |pv| {
            let v = run(&*pv.snap, &pv.ctx);
            if v.get("ok") == Some(&Value::Bool(true)) || v.get("unknown").and_then(|u| u.as_str()) != Some("miss") {
                Ok(v)
            } else {
                let m = parse_missing(&v);
                if m.is_empty() { Ok(v) } else { Err(m) }
            }
        },
        || Stats::inc(&sh.stats.pinned_fetch_rounds),
    );
    let mut answer = match r {
        Ok(v) => v,
        Err(PinnedErr::Miss(m)) => json!({
            "id": id, "ok": false, "unknown": "miss",
            "detail": format!("still missing {} item(s) after the fetch rounds", m.len()),
            "missing": m.iter().map(crate::check::proto_types::miss_json).collect::<Vec<_>>(),
        }),
        Err(PinnedErr::NotReady(e)) => unknown(id, "not_ready", &e, 0),
    };
    if answer.get("ok") == Some(&Value::Bool(true)) {
        Stats::inc(&sh.stats.checks_ok);
    } else {
        Stats::inc(&sh.stats.checks_unknown);
    }
    answer["us"] = json!(t0.elapsed().as_micros() as u64);
    answer
}

#[cfg(test)]
mod tests {
    use super::same_but_gas;
    use serde_json::json;

    #[test]
    fn same_but_gas_takes_the_higher_gas_and_nothing_else_may_differ() {
        let a = json!({"ok": true, "results": [{"success": true, "output": "0x01", "gasUsed": "0x10"}, {"success": false, "output": "0x", "gasUsed": "0x30"}]});
        let b = json!({"ok": true, "results": [{"success": true, "output": "0x01", "gasUsed": "0x20"}, {"success": false, "output": "0x", "gasUsed": "0x05"}]});
        let m = same_but_gas(&a, &b).unwrap();
        assert_eq!(m["results"][0]["gasUsed"], json!("0x20"));
        assert_eq!(m["results"][1]["gasUsed"], json!("0x30"));
        let c = json!({"ok": true, "results": [{"success": true, "output": "0x02", "gasUsed": "0x10"}, {"success": false, "output": "0x", "gasUsed": "0x30"}]});
        assert!(same_but_gas(&a, &c).is_none(), "output differs");
        let s1 = json!({"ok": true, "best": {"amount": "0x5", "profit": "0x7", "gasUsed": "0x100"}, "tried": [{"amount": "0x5", "status": "profit", "profit": "0x7", "gasUsed": "0x100", "reason": null}]});
        let s2 = json!({"ok": true, "best": {"amount": "0x5", "profit": "0x7", "gasUsed": "0x90"}, "tried": [{"amount": "0x5", "status": "profit", "profit": "0x7", "gasUsed": "0x90", "reason": null}]});
        assert_eq!(same_but_gas(&s1, &s2).unwrap(), s1);
        let s3 = json!({"ok": true, "best": null, "tried": []});
        assert!(same_but_gas(&s1, &s3).is_none());
    }
}
