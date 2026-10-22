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
use crate::copy2::checkview::{high_offset, C2View};
use crate::copy2::intake::Copy2Handle;
use crate::node::env_u64;
use crate::proto::{bad_request, parse_at, parse_missing, parse_warm, read_msg, unknown, write_msg};
use crate::state::fill::FillQueue;
use crate::state::mirror::{At, Shared, Stats};
use crate::state::pinned::{PinnedCache, PinnedErr};
use crate::state::snap::View;
use crate::state::updater::UpdaterHandle;
use crate::state::StateRead;

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
        let answer = handle(&ctx, &job.req);
        send(&job.out, &answer);
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
        if jobs.try_send(Job { req, out: out.clone() }).is_err() {
            send(&out, &unknown(&id, "not_ready", "sidecar busy", 0));
        }
    }
    Ok(())
}

/// Answer one question (also used directly by tests).
pub fn handle(ctx: &Ctx, req: &Value) -> Value {
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
            check(ctx, &id, &r.at, t0, |view, c| handle_call(view, c, &r))
        }
        Some("size_search") => {
            warm_check_accounts(ctx, req);
            let req = &caller_as_empty(ctx, req);
            let r: SizeSearchRequest = match serde_json::from_value(req.clone()) {
                Ok(r) => r,
                Err(e) => return bad_request(&id, &format!("size_search: {e}")),
            };
            check(ctx, &id, &r.at, t0, |view, c| handle_size_search(view, c, &r))
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
fn check(ctx: &Ctx, id: &Value, at: &Value, t0: Instant, run: impl Fn(&dyn StateRead, &BlockCtx) -> Value) -> Value {
    let sh = &ctx.shared;
    Stats::inc(&sh.stats.checks);
    let at = match parse_at(at) {
        Ok(a) => a,
        Err(e) => return bad_request(id, &e),
    };
    if let At::Pinned { block, next } = at {
        return pinned_check(ctx, id, block, next, t0, run);
    }
    let picked = match sh.resolve(&at) {
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
    let view = View::new(picked.snap);
    let mut answer = match &ctx.copy2 {
        None => run(&view, &picked.ctx),
        Some(c) => copy2_run(c, &view, block, &picked.ctx, &run),
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
        if let Some(why) = if answered { c.pending_reason(&view.take_touched(), block, all) } else { None } {
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
            if let Some(why) = ctx.copy2.as_ref().and_then(|c| c.unsure_reason(&missing)) {
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
/// PoolManager's balances at a proven lower bound). A run that read a
/// PoolManager balance is repeated with that balance 2^200 higher; the
/// answer stands only if both runs agree exactly, else "unknown".
fn copy2_run(c: &Copy2Handle, view: &View, block: u64, bctx: &BlockCtx, run: &impl Fn(&dyn StateRead, &BlockCtx) -> Value) -> Value {
    let facts = c.check_facts(block);
    if facts.is_empty() {
        return run(view, bctx);
    }
    let low = C2View::new(view, &facts, revm::primitives::U256::ZERO);
    let answer = run(&low, bctx);
    if !low.used_bound() || answer.get("ok") != Some(&Value::Bool(true)) {
        return answer;
    }
    let high = C2View::new(view, &facts, high_offset());
    let again = run(&high, bctx);
    let strip = |v: &Value| {
        let mut v = v.clone();
        if let Some(m) = v.as_object_mut() {
            m.remove("us");
        }
        v
    };
    let same = strip(&answer) == strip(&again);
    c.note_pm_bound(same);
    if same {
        return answer;
    }
    let id = answer.get("id").cloned().unwrap_or(Value::Null);
    json!({ "id": id, "ok": false, "unknown": "pool_manager_balance",
            "detail": "the answer depends on the V4 PoolManager's coin / ETH balance, which copy 2 does not follow (same check at a proven lower bound and far above it differ)" })
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
