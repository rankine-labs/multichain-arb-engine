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
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use revm::primitives::{Address, B256};
use serde_json::{json, Value};

use crate::arb::BlockCtx;
use crate::check::proto_types::{handle_call, handle_size_search, CallRequest, SizeSearchRequest};
use crate::copy2::checkview::{fee_nonzero, high_offset, C2View};
use crate::copy2::intake::Copy2Handle;
use crate::jobq::{is_fast, JobQueue};
use crate::node::env_u64;
use crate::proto::{bad_request, parse_at, parse_missing, parse_missing_keys, parse_missing_pre, parse_warm, read_msg_keep, unknown, write_msg, Incoming};
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
    /// Socket thread: microseconds to read the JSON, and its size (speed-3
    /// phase timing: a question carrying the whole feed was ~0.5 MB).
    read_us: u64,
    bytes: u64,
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
    // FAST LANE TRIGGER (fastlane/trigger.rs): fire-first decided inside
    // Rust. Starts only when the fast lane loop runs (FASTLANE practice /
    // live) and FASTLANE_TRIGGER is not off; otherwise nothing happens.
    crate::fastlane::trigger::start(ctx.clone());
    // Workers: more than the machine's CPU cores does not help (they only
    // take turns on the same cores); the default stays 2 (the live server
    // has 2 vCPUs). Trigger-entry work skips the line instead (jobq.rs).
    let workers = env_u64("ARBSIM_WORKERS", 2).clamp(1, 16) as usize;
    // Bounded: if the workers are swamped, new questions get "busy" at once.
    // ARBSIM_PRIO_BURST [4]: most trigger-entry jobs in a row while other
    // questions wait (0 = no fast lane, first come first served).
    let burst = env_u64("ARBSIM_PRIO_BURST", 4).min(64) as usize;
    let jobs: Arc<JobQueue<Job>> = Arc::new(JobQueue::new(256, burst));
    for i in 0..workers {
        let jobs = jobs.clone();
        let ctx = ctx.clone();
        std::thread::Builder::new().name(format!("arbsim-worker-{i}")).spawn(move || worker(ctx, jobs))?;
    }
    for conn in listener.incoming() {
        let Ok(stream) = conn else { continue };
        let ctx = ctx.clone();
        let jobs = jobs.clone();
        std::thread::Builder::new().name("arbsim-conn".into()).spawn(move || {
            // ZERO-ROUTES FIX (Oct 27): a connection that ends with an error
            // is said out loud (it used to be dropped without a word).
            if let Err(e) = connection(ctx, stream, jobs) {
                eprintln!("[arbsim] socket: connection closed with an error: {e}");
            }
        })?;
    }
    Ok(())
}

fn worker(ctx: Arc<Ctx>, jobs: Arc<JobQueue<Job>>) {
    while let Some(job) = jobs.pop() {
        let mut tm = Tm { queue_us: job.queued.elapsed().as_micros() as u64, ..Tm::default() };
        // Trigger-first phase timing (timing.rs): a fresh list per question.
        crate::timing::ph_reset();
        crate::timing::ph_add("read", job.read_us);
        crate::timing::ph_count("bytes", job.bytes);
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

fn connection(ctx: Arc<Ctx>, stream: UnixStream, jobs: Arc<JobQueue<Job>>) -> std::io::Result<()> {
    let out: Writer = Arc::new(Mutex::new(BufWriter::new(stream.try_clone()?)));
    let mut r = std::io::BufReader::new(stream);
    loop {
        let body = match read_msg_keep(&mut r)? {
            None => break,
            Some(Incoming::Msg(b)) => b,
            Some(Incoming::TooLarge(n)) => {
                // ZERO-ROUTES FIX (Oct 27): thrown away, counted, logged; the
                // connection stays open for everything else.
                note_too_large(n);
                continue;
            }
        };
        let t_read = Instant::now();
        let req: Value = match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(_) => {
                send(&out, &bad_request(&Value::Null, "not JSON"));
                continue;
            }
        };
        let read_us = t_read.elapsed().as_micros() as u64;
        // Copy 2 block reports: straight to the copy-2 thread, no answer.
        let ty = req.get("type").and_then(|t| t.as_str());
        // FEED STORE (check/feedstore.rs): a new feed message, sent once by
        // the bot; kept here, no answer. Read before any later question on
        // this connection, so a question naming it always finds it.
        if ty == Some("feed_put") {
            crate::check::feedstore::store().put_json(&req);
            continue;
        }
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
        // Trigger-entry candidate table (check/entry.rs): stored right here
        // (no worker needed, it only swaps the table), answered at once.
        if ty == Some("trig_table") {
            crate::check::entry::note_table_bytes(body.len() as u64);
            send(&out, &crate::check::entry::apply_table(&id, &req));
            continue;
        }
        // Trigger-entry work goes in the fast lane (jobq.rs).
        let fast = is_fast(&req);
        if jobs.push(Job { req, out: out.clone(), queued: Instant::now(), read_us, bytes: body.len() as u64 }, fast).is_err() {
            send(&out, &unknown(&id, "not_ready", "sidecar busy", 0));
        }
    }
    Ok(())
}

/// Over-size messages thrown away (status "socket"); the newest size.
static TOO_LARGE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static TOO_LARGE_LAST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn note_too_large(n: usize) {
    use std::sync::atomic::Ordering::Relaxed;
    let k = TOO_LARGE.fetch_add(1, Relaxed) + 1;
    TOO_LARGE_LAST.store(n as u64, Relaxed);
    // The first one and then every 100th: never floods the log.
    if k == 1 || k % 100 == 0 {
        eprintln!("[arbsim] socket: a message of {n} bytes is over the {} byte limit: dropped ({k} so far; the connection stays open)", crate::proto::MAX_MESSAGE);
    }
}

/// Status "socket": over-size messages dropped so far.
pub fn socket_status_json() -> Value {
    use std::sync::atomic::Ordering::Relaxed;
    json!({ "tooLarge": TOO_LARGE.load(Relaxed), "tooLargeLastBytes": TOO_LARGE_LAST.load(Relaxed), "maxBytes": crate::proto::MAX_MESSAGE })
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
                // The bot's "wanted" hint rides on its status poll (copy2-relist).
                c.note_wanted(req.get("wanted"));
                s["copy2"] = c.status_json(req.get("pools").and_then(|p| p.as_bool()).unwrap_or(false));
                // (Oct 27) Why copy 2 trails the feed (copy2/lag.rs).
                s["copy2Lag"] = crate::copy2::lag::status_json();
            }
            if let Value::Object(t) = crate::timing::status() {
                for (k, v) in t {
                    s[k] = v;
                }
            }
            s["feedStore"] = crate::check::feedstore::store().status_json();
            // (Oct 27) What discovery's misses fetched (DiscoverFillBook).
            if let Some(c) = &ctx.copy2 {
                s["discoverFill"] = c.c2.discover_fill.lock().map(|b| b.json()).unwrap_or(Value::Null);
            }
            // ZERO-ROUTES FIX (Oct 27): the candidate table as the sidecar
            // holds it, and over-size socket messages dropped.
            s["trigTable"] = crate::check::entry::status_json();
            s["socket"] = socket_status_json();
            // FAST LANE A (copy2/ahead.rs): only when FASTLANE is on.
            if let Some(a) = crate::copy2::ahead::status_json() {
                s["fastlaneAhead"] = a;
            }
            // FAST LANE loop summary (ahead, scan, gun, safety, practice).
            if let Some(f) = crate::fastlane::lane::status_json() {
                s["fastlane"] = f;
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
            let req = &*caller_as_empty(ctx, req);
            // (read straight from the request: no copy of it, which for a
            // trigger-first check used to include the whole feed)
            let r: CallRequest = match serde::Deserialize::deserialize(req) {
                Ok(r) => r,
                Err(e) => return bad_request(&id, &format!("call: {e}")),
            };
            tm.prep_us = t0.elapsed().as_micros() as u64;
            // Trigger-first (check/ordered.rs): the feed's transactions in
            // sequence order on a copy version, then our calls.
            if let Some(f) = r.feed.as_ref().filter(|f| !f.is_null()) {
                return trig_check(ctx, &id, &r, f, t0, tm);
            }
            check(ctx, &id, &r.at, t0, tm, |view, c| handle_call(view, c, &r))
        }
        Some("size_search") => {
            warm_check_accounts(ctx, req);
            let req = &*caller_as_empty(ctx, req);
            let r: SizeSearchRequest = match serde::Deserialize::deserialize(req) {
                Ok(r) => r,
                Err(e) => return bad_request(&id, &format!("size_search: {e}")),
            };
            tm.prep_us = t0.elapsed().as_micros() as u64;
            check(ctx, &id, &r.at, t0, tm, |view, c| handle_size_search(view, c, &r))
        }
        Some("trig_discover") => trig_discover(ctx, &id, req, t0, tm),
        Some("trig_entry") => trig_entry(ctx, &id, req, t0, tm),
        Some("trig_table") => crate::check::entry::apply_table(&id, req),
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
fn caller_as_empty<'a>(ctx: &Ctx, req: &'a Value) -> std::borrow::Cow<'a, Value> {
    let Some(_) = &ctx.copy2 else { return std::borrow::Cow::Borrowed(req) };
    // Copied only if an override has to be added (speed-3: the request can
    // be large; the answer is the same either way).
    let mut out: Option<Value> = None;
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
        let o = out.get_or_insert_with(|| req.clone());
        if !o.get("overrides").is_some_and(|o| o.is_object()) {
            o["overrides"] = json!({});
        }
        o["overrides"][format!("{a:#x}")] = json!({ "balance": "0x0", "nonce": "0x0", "code": "0x" });
    }
    match out {
        Some(v) => std::borrow::Cow::Owned(v),
        None => std::borrow::Cow::Borrowed(req),
    }
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
    after_pick(ctx, picked, t0, tm, &run, true)
}

/// Trigger-first check (`call` with `feed`, see check/ordered.rs): pick the
/// copy version for `at` (the bot asks for the newest), work out which feed
/// messages it already holds, replay the rest in sequence order, then our
/// calls. Everything after that is the same as any check (copy 2's lower
/// bound / far-above runs, reports-pending rule, "unsure pool" label),
/// EXCEPT that missing items are NOT queued for fetching here: node reads
/// for trigger-first checks only happen through the bot's budgeted warming
/// (execution/triggerFirst.ts TrigWarmer -> `warm`).
fn trig_check(ctx: &Ctx, id: &Value, r: &CallRequest, feed_v: &Value, t0: Instant, tm: &mut Tm) -> Value {
    let cpu0 = crate::timing::thread_cpu_us();
    let mut a = trig_inner(ctx, id, r, feed_v, t0, tm);
    let used = tm.prep_us + tm.resolve_us + tm.facts_us + tm.runs_us.iter().sum::<u64>();
    tm.post_us = (t0.elapsed().as_micros() as u64).saturating_sub(used);
    a["t"] = tm.json();
    trig_phases(&mut a, "call", t0, cpu0, tm);
    a
}

/// TRIGGER-FIRST PHASES (timing.rs, speed-3): put this question's phase
/// list into its answer ("ph" microseconds, "pn" counts, "cpu" = the
/// worker thread's CPU microseconds for the question, next to "us" wall)
/// and keep it for status "trigTiming". Measurement only.
fn trig_phases(a: &mut Value, kind: &'static str, t0: Instant, cpu0: u64, tm: &Tm) {
    let total = t0.elapsed().as_micros() as u64;
    let cpu = crate::timing::thread_cpu_us().saturating_sub(cpu0);
    crate::timing::ph_add("resolve", tm.resolve_us);
    crate::timing::ph_add("facts", tm.facts_us);
    crate::timing::ph_add("evm", tm.runs_us.iter().sum());
    crate::timing::ph_count("runs", tm.runs_us.len() as u64);
    let (ph, pn) = crate::timing::ph_json();
    a["ph"] = ph;
    a["pn"] = pn;
    a["cpu"] = json!(cpu);
    crate::timing::record_trig(kind, &[("total", total), ("cpu", cpu), ("queue", tm.queue_us)]);
}

/// A trigger-first request's `feed`: read straight from the request (no
/// copy of it), and, when it names messages the bot already handed over
/// (`refs`, check/feedstore.rs), those messages from the feed store.
/// Err = the answer to give (bad request, or unknown "feed_ref_missing":
/// the bot then asks again with the messages themselves).
type HeldMsgs = Option<Vec<Arc<crate::check::feedstore::BinMsg>>>;
fn feed_of(id: &Value, v: &Value) -> Result<(crate::check::ordered::WireFeed, HeldMsgs), Value> {
    let t = Instant::now();
    let feed: crate::check::ordered::WireFeed = match serde::Deserialize::deserialize(v) {
        Ok(f) => f,
        Err(e) => return Err(bad_request(id, &format!("feed: {e}"))),
    };
    crate::timing::ph_add("feedRead", t.elapsed().as_micros() as u64);
    let Some(refs) = feed.refs.as_ref() else { return Ok((feed, None)) };
    if !feed.msgs.is_empty() {
        return Err(bad_request(id, "feed: refs and msgs can't be combined"));
    }
    let t = Instant::now();
    let held = crate::check::feedstore::store().resolve(refs);
    crate::timing::ph_add("feedRefs", t.elapsed().as_micros() as u64);
    match held {
        Ok(h) => Ok((feed, Some(h))),
        Err(detail) => Err(json!({ "id": id, "ok": false, "unknown": "feed_ref_missing", "detail": detail })),
    }
}

fn trig_inner(ctx: &Ctx, id: &Value, r: &CallRequest, feed_v: &Value, t0: Instant, tm: &mut Tm) -> Value {
    let sh = &ctx.shared;
    let (feed, held) = match feed_of(id, feed_v) {
        Ok(x) => x,
        Err(a) => return a,
    };
    // The plan sets every block detail itself; mixing in other ways of
    // changing the state or the block would make the order unclear.
    if !r.raw_txs.is_empty() || !r.block_overrides.is_null() || r.next_block {
        return bad_request(id, "feed can't be combined with rawTxs / blockOverrides / nextBlock");
    }
    Stats::inc(&sh.stats.checks);
    let at = match parse_at(&r.at) {
        Ok(a) => a,
        Err(e) => return bad_request(id, &e),
    };
    if matches!(at, At::Pinned { .. }) {
        return bad_request(id, "feed checks run on the live copy, not on pinned blocks");
    }
    let t_res = Instant::now();
    let resolved = sh.resolve(&at);
    tm.resolve_us = t_res.elapsed().as_micros() as u64;
    let picked = match resolved {
        Ok(p) => p,
        Err(e) => {
            Stats::inc(&sh.stats.checks_unknown);
            return unknown(id, e.reason, &e.detail, t0.elapsed().as_micros() as u64);
        }
    };
    let t_plan = Instant::now();
    let built = crate::check::ordered::build_plan_with(&feed, held.as_deref(), picked.seq, sh.cfg.l2_offset, &picked.ctx);
    crate::timing::ph_add("plan", t_plan.elapsed().as_micros() as u64);
    let (plan, info) = match built {
        Ok(x) => x,
        Err(u) => {
            Stats::inc(&sh.stats.checks_unknown);
            return crate::check::proto_types::unknown_json(id, &u, t0.elapsed().as_micros());
        }
    };
    // Copy 2: one registry summary for the whole check (checkcore.rs), also
    // used for "which values are exact" (no registry lock, speed-3).
    let t_core = Instant::now();
    let core = ctx.copy2.as_ref().map(|c| c.core_for(picked.from.as_ref()));
    tm.facts_us += t_core.elapsed().as_micros() as u64;
    // Which copy values are exact at the version's block (copy 2: only what
    // it follows from reports; copy 1 replays everything: all of them).
    let block = picked.seq + sh.cfg.l2_offset;
    let t_prov = Instant::now();
    let prov: Arc<dyn crate::check::ordered::Provenance + Send + Sync> = match (&ctx.copy2, &core) {
        (Some(c), Some(k)) => c.provenance_with(k, block, &override_code_accounts(&r.overrides)),
        _ => Arc::new(crate::check::ordered::AllExact),
    };
    crate::timing::ph_add("prov", t_prov.elapsed().as_micros() as u64);
    // Best effort (check/ordered.rs BEST EFFORT): which assumptions this
    // check may make (this program's setting, then the bot's request).
    let (strict, mut assume) = trig_assume(trig_trust(), &feed, |keys| ctx.copy2.as_ref().and_then(|c| c.route_for(keys)));
    // V4 BLIND SPOT (Oct 25): write down hash inputs, so a miss can say
    // WHOSE PoolManager value it was (copy2/v4blind.rs). Not an assumption.
    assume.record_hashes = true;
    // WARM HOT TARGETS (copy2/warm.rs): values copy 2 doesn't hold, from memory.
    let (picked, prov, warm_used) = warm_apply(ctx, picked, prov, &plan);
    let run = |view: &dyn StateRead, _c: &BlockCtx| crate::check::proto_types::handle_trig_call_with(view, &plan, &info, r, prov.as_ref(), strict, &assume);
    let a = after_pick_with(ctx, picked, t0, tm, &run, false, core);
    warm_learn(ctx, &a, warm_used);
    a
}

/// WARM HOT TARGETS (copy2/warm.rs, only when FASTLANE is not off): the
/// question's copy version with the warm values added where copy 2 holds
/// nothing, and the provenance that marks them not exact ("recent fill").
/// A value whose contract a transaction BEFORE the trigger goes to is left
/// out (unless stable). Never waits for the node.
fn warm_apply(
    ctx: &Ctx,
    mut picked: crate::state::mirror::Picked,
    prov: Arc<dyn crate::check::ordered::Provenance + Send + Sync>,
    plan: &crate::check::ordered::OrderedPlan,
) -> (crate::state::mirror::Picked, Arc<dyn crate::check::ordered::Provenance + Send + Sync>, bool) {
    let Some(c) = &ctx.copy2 else { return (picked, prov, false) };
    let mut w = c.c2.warm.lock().unwrap_or_else(|e| e.into_inner());
    if !w.on() {
        return (picked, prov, false);
    }
    let before: Vec<(u64, Option<Address>)> = plan
        .msgs
        .iter()
        .flat_map(|m| m.txs.iter().map(move |t| (m.seq, t.to, t.hash)))
        .take_while(|x| x.2 != plan.trigger)
        .map(|(sq, to, _)| (sq, to))
        .collect();
    let trig_seq = plan.msgs.iter().find(|m| m.txs.iter().any(|t| t.hash == plan.trigger)).map_or(u64::MAX, |m| m.seq);
    match w.layer(&picked.snap, c.c2.warm_now(), ctx.shared.cfg.l2_offset, trig_seq, &before) {
        Some(l) => {
            picked.snap = l.snap.clone();
            (picked, Arc::new(crate::copy2::warm::WarmProv { inner: prov, layer: l }), true)
        }
        None => (picked, prov, false),
    }
}

/// WARM HOT TARGETS: a fire-first miss teaches the recipe of the
/// transaction it got stuck on (its target); an answer that used warm
/// values is counted.
fn warm_learn(ctx: &Ctx, a: &Value, used: bool) {
    let Some(c) = &ctx.copy2 else { return };
    let mut w = c.c2.warm.lock().unwrap_or_else(|e| e.into_inner());
    if !w.on() {
        return;
    }
    if used && a.get("ok") == Some(&Value::Bool(true)) {
        w.stats.questions_used += 1;
    }
    if a.get("unknown").and_then(|u| u.as_str()) == Some("miss") {
        let target = a.get("at").and_then(|x| x.get("to")).and_then(|t| t.as_str()).and_then(|t| crate::check::hexutil::parse_address(t).ok());
        if let Some(t) = target {
            w.learn(t, &parse_missing(a));
        }
    }
}

/// TRIGGER-FIRST ENTRY POINT: `{"type":"trig_discover", "at":{"after":"head"},
/// "feed":{...same as a trigger-first call...}}`.
/// Plain English: "which of the pools you follow does this new feed
/// transaction move?" The trigger ALONE is run (check/ordered.rs
/// trigger_only, same replay rules and best-effort assumptions as every
/// trigger-first check, no node calls: a miss is "unknown") on the newest
/// copy version, and the storage it changed is matched against the pools
/// copy 2 follows. Answer: {"ok":true, "pools":[keys], "conf", "assumed",
/// "triggerOk", "snapBlock", "changed": n}. A trigger already in the copy
/// version answers unknown "already_in_copy" (its effect is already there,
/// we can't see it any more). Nothing is queued for fetching here.
fn trig_discover(ctx: &Ctx, id: &Value, req: &Value, t0: Instant, tm: &mut Tm) -> Value {
    let cpu0 = crate::timing::thread_cpu_us();
    let mut a = trig_discover_inner(ctx, id, req, t0, tm);
    let used = tm.prep_us + tm.resolve_us + tm.facts_us + tm.runs_us.iter().sum::<u64>();
    tm.post_us = (t0.elapsed().as_micros() as u64).saturating_sub(used);
    a["t"] = tm.json();
    trig_phases(&mut a, "discover", t0, cpu0, tm);
    a
}

fn trig_discover_inner(ctx: &Ctx, id: &Value, req: &Value, t0: Instant, tm: &mut Tm) -> Value {
    let sh = &ctx.shared;
    let Some(c2) = &ctx.copy2 else { return bad_request(id, "trig_discover needs ARBSIM_SOURCE=pool-events (copy 2)") };
    let (feed, held) = match req.get("feed").map(|f| feed_of(id, f)) {
        Some(Ok(x)) => x,
        Some(Err(a)) => return a,
        None => return bad_request(id, "trig_discover needs feed"),
    };
    let at = match parse_at(req.get("at").unwrap_or(&Value::Null)) {
        Ok(a) => a,
        Err(e) => return bad_request(id, &e),
    };
    if matches!(at, At::Pinned { .. }) {
        return bad_request(id, "feed checks run on the live copy, not on pinned blocks");
    }
    Stats::inc(&sh.stats.checks);
    tm.prep_us = t0.elapsed().as_micros() as u64;
    let t_res = Instant::now();
    let resolved = sh.resolve(&at);
    tm.resolve_us = t_res.elapsed().as_micros() as u64;
    let picked = match resolved {
        Ok(p) => p,
        Err(e) => {
            Stats::inc(&sh.stats.checks_unknown);
            return unknown(id, e.reason, &e.detail, t0.elapsed().as_micros() as u64);
        }
    };
    let t_plan = Instant::now();
    let built = crate::check::ordered::build_plan_with(&feed, held.as_deref(), picked.seq, sh.cfg.l2_offset, &picked.ctx);
    crate::timing::ph_add("plan", t_plan.elapsed().as_micros() as u64);
    let (plan, info) = match built {
        Ok(x) => x,
        Err(u) => {
            Stats::inc(&sh.stats.checks_unknown);
            return crate::check::proto_types::unknown_json(id, &u, t0.elapsed().as_micros());
        }
    };
    let Some((alone, others)) = crate::check::ordered::trigger_only(&plan) else {
        // GAP FIX 1 (Oct 24): the copy already holds the trigger, so the
        // gap it opened is IN the copy right now. Its pool reports said
        // which followed pools it moved (copy2 RECENT MOVES): answer those,
        // so the bot checks our routes on the current copy at once instead
        // of giving up (live: rivals took those gaps).
        if let Some(pools) = c2.c2.recent_moves.lock().ok().and_then(|rm| rm.pools_of(&info.trigger)) {
            return json!({
                "id": id, "ok": true, "pools": pools, "inCopy": true, "conf": "high", "assumed": [],
                "snapBlock": info.snap_block, "triggerOk": true, "us": t0.elapsed().as_micros() as u64,
            });
        }
        Stats::inc(&sh.stats.checks_unknown);
        return json!({ "id": id, "ok": false, "unknown": "already_in_copy", "detail": "the copy version already holds the trigger", "us": t0.elapsed().as_micros() as u64 });
    };
    let block = picked.seq + sh.cfg.l2_offset;
    // The trigger itself (its target: what the fill budget learns about,
    // and what the self-only proof looks at).
    let trig_dec: Option<crate::check::rawtx::DecodedTx> = alone.msgs.iter().flat_map(|m| m.txs.iter()).find(|t| t.hash == alone.trigger).cloned();
    // One registry summary for the whole question (checkcore.rs): the exact
    // values list and the moved-pool tables come from it, no registry lock.
    // SPEED (Oct 29): a check core built within the last second, without
    // waiting for the registry (live: getting a current core was the biggest
    // step of slow discoveries, p90 21 ms, mostly waiting while the copy's
    // thread wrote the registry). Discovery only names the moved pools; the
    // candidate checks that follow still use a current core. A pool that
    // went unsure in that second has its values forgotten (a miss, never a
    // wrong answer). ARBSIM_DISC_CORE_MAX_AGE_MS (1000; 0 = always current).
    let t_core = Instant::now();
    let max_age = env_u64("ARBSIM_DISC_CORE_MAX_AGE_MS", 1000);
    let core = if max_age == 0 { c2.core_for(picked.from.as_ref()) } else { c2.recent_core(std::time::Duration::from_millis(max_age), picked.from.as_ref()) };
    tm.facts_us += t_core.elapsed().as_micros() as u64;
    let prov = crate::timing::ph_time("prov", || c2.provenance_with(&core, block, &[]));
    // WARM HOT TARGETS (copy2/warm.rs): values copy 2 doesn't hold, from memory.
    let (picked, prov, warm_used) = crate::timing::ph_time("warm", || warm_apply(ctx, picked, prov, &plan));
    // Same assumptions as a trigger-first check (no skipping: only the
    // trigger runs, and the trigger is never skipped).
    let (strict, mut assume) = trig_assume(trig_trust(), &feed, |_| None);
    // Write down the hashes it computes: which pool a changed mapping value belongs to.
    assume.record_hashes = true;
    let snap_block = info.snap_block;
    let run = |view: &dyn StateRead, _c: &BlockCtx| -> Value {
        match crate::check::ordered::run_ordered_with(view, &alone, &crate::check::Overrides::none(), &[], prov.as_ref(), strict, &assume) {
            Ok(out) => {
                let mut labels = out.assumed.labels();
                let mut conf = out.assumed.confidence();
                if others > 0 {
                    labels.push(format!("alone:{others}"));
                    if conf == "high" {
                        conf = "medium";
                    }
                }
                // Only the pools' OWN state counts (check/moved.rs).
                let moved = crate::timing::ph_time("moved", || c2.pools_changed_with(&core, &out.changed, &out.hashes));
                // An auto-followed pool a feed transaction moves is in use (v4blind.rs).
                c2.note_moved(&moved.iter().map(|m| m.key.clone()).collect::<Vec<_>>());
                json!({
                    "id": id, "ok": true,
                    "pools": moved.iter().map(|m| m.key.clone()).collect::<Vec<_>>(),
                    // Debug: which kinds of each pool's values changed (first 8 pools).
                    "moved": moved.iter().take(8).map(|m| json!([m.key.clone(), m.kinds.clone()])).collect::<Vec<_>>(),
                    "changed": out.changed.len(),
                    "triggerOk": out.replayed.first().map(|r| r.outcome.success),
                    "conf": conf, "assumed": labels, "snapBlock": snap_block,
                })
            }
            Err(u) => {
                // (Oct 27, ARBSIM_DISCOVER_SELF_ONLY=1, off by default) SELF-
                // ONLY TARGET PROOF (fastlane/replay_fetch.rs): the trigger
                // calls a contract whose code can't reach any other contract
                // and that isn't one of our pools / their coins / a
                // PoolManager: it provably moves none of our pools, whatever
                // values we lack. Only turns an "unknown" into "moved none".
                if discover_self_only() {
                    if let Some(d) = &trig_dec {
                        if crate::fastlane::replay_fetch::proven_untouching(view, d, &|x| c2.followed_or_coin(&core, x)) {
                            return json!({
                                "id": id, "ok": true, "pools": [], "moved": [], "changed": 0, "triggerOk": null,
                                "conf": "high", "assumed": ["proven_no_touch"], "provenNoTouch": true, "snapBlock": snap_block,
                            });
                        }
                    }
                }
                crate::check::proto_types::unknown_json(id, &u, 0)
            }
        }
    };
    let mut a = crate::timing::ph_time("pick", || after_pick_with(ctx, picked, t0, tm, &run, false, Some(core.clone())));
    crate::timing::ph_time("warmLearn", || warm_learn(ctx, &a, warm_used));
    // (Oct 27) The fill budget learns which targets move our pools (copy 2's
    // reports tell for the unknown ones, a few seconds later).
    let t_learn = Instant::now();
    let trig_target = trig_dec.as_ref().and_then(|d| d.to);
    if let Some(t) = trig_target {
        let moved = (a.get("ok") == Some(&Value::Bool(true))).then(|| a["pools"].as_array().is_some_and(|p| !p.is_empty()));
        let now = Instant::now();
        if let Ok(mut b) = c2.c2.discover_fill.lock() {
            if a.get("provenNoTouch").is_some() {
                b.self_only_answers += 1;
            }
            b.note_answer(t, alone.trigger, moved, now);
            if let Ok(rm) = c2.c2.recent_moves.lock() {
                b.resolve(now, |h| rm.pools_of(h).is_some_and(|p| !p.is_empty()));
            }
        }
    }
    // DISCOVER LEARNS (Oct 24, live: 69% of looked-at feed transactions
    // answered "miss" here, and a miss was never fetched, so every trade
    // through a router / aggregator whose code or values copy 2 doesn't hold
    // stayed invisible forever). A miss of a FEW items (a router's code, its
    // own values) is now fetched once, like any check's miss, so the next
    // trade through it can be replayed. Many items = probably not a swap at
    // all (a game, a mint, an airdrop): not fetched. Paced so it can't crowd
    // out pool loads: ARBSIM_DISCOVER_FILL_MAX_ITEMS (16) per miss,
    // ARBSIM_DISCOVER_FILL_PER_S (60) items a second over all questions
    // (0 = off, as before).
    // (Oct 27) Each item at most once per ARBSIM_DISCOVER_FILL_REPEAT_S and
    // at most ARBSIM_DISCOVER_FILL_PER_HOUR items an hour (DiscoverFillBook),
    // counted in status "discoverFill".
    // A hot target the warm keeper handles (copy2/warm.rs) is not fetched here too.
    let warm_hot = trig_target.is_some_and(|t| c2.c2.warm.lock().map(|w| w.on() && w.is_hot(&t)).unwrap_or(false));
    if !warm_hot && a.get("unknown").and_then(|u| u.as_str()) == Some("miss") {
        let missing = parse_missing(&a);
        let max_items = env_u64("ARBSIM_DISCOVER_FILL_MAX_ITEMS", 16) as usize;
        let book = &c2.c2.discover_fill;
        let fresh = book.lock().map(|mut b| b.offer_for(trig_target, &missing, max_items, Instant::now())).unwrap_or_default();
        if !fresh.is_empty() && discover_fill_take(fresh.len()) {
            if let Ok(mut b) = book.lock() {
                b.taken(&fresh, Instant::now());
            }
            c2.note_misses(&fresh);
            crate::timing::ph_add("discFill", fresh.len() as u64);
            ctx.fill(fresh);
        } else if !fresh.is_empty() {
            if let Ok(mut b) = book.lock() {
                b.paced += fresh.len() as u64;
            }
        }
    }
    crate::timing::ph_add("learn", t_learn.elapsed().as_micros() as u64);
    a["us"] = json!(t0.elapsed().as_micros() as u64);
    a
}

/// ARBSIM_DISCOVER_SELF_ONLY=1: discovery's self-only target proof (see
/// trig_discover_inner). Off by default until a server replay
/// (`arbsim trig-replay`, SELF-ONLY TARGETS) shows it is worth it.
fn discover_self_only() -> bool {
    use std::sync::atomic::Ordering::Relaxed;
    // 0 = not read yet, 1 = off, 2 = on.
    match DISCOVER_SELF_ONLY.load(Relaxed) {
        0 => {
            let on = env_u64("ARBSIM_DISCOVER_SELF_ONLY", 0) == 1;
            DISCOVER_SELF_ONLY.store(if on { 2 } else { 1 }, Relaxed);
            on
        }
        v => v == 2,
    }
}
static DISCOVER_SELF_ONLY: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

/// Tests: switch the self-only proof on / off (overrides the setting).
pub fn set_discover_self_only(on: bool) {
    DISCOVER_SELF_ONLY.store(if on { 2 } else { 1 }, std::sync::atomic::Ordering::Relaxed);
}

/// DISCOVER LEARNS budget (Oct 27): what discovery's misses may fetch
/// (one per copy 2, kept in its shared state: C2Shared.discover_fill).
/// Plain English: a miss of a few items (a router's code, a coin's setting)
/// is worth fetching once: the next trade through it can then be replayed.
/// But the same item missed again and again is usually a value that keeps
/// changing (a bot's own counters / balances: copy 2 forgets a changed
/// fill), and fetching it each time costs a node request per trigger for
/// nothing. So:
///   - an item is fetched at most once per ARBSIM_DISCOVER_FILL_REPEAT_S
///     [600] (remembered: at most REMEMBER items, oldest forgotten first);
///   - at most ARBSIM_DISCOVER_FILL_PER_HOUR [3600] items an hour, a hard
///     cap (0 = no fetching at all), on top of the per-second pace below;
///   - more than ARBSIM_DISCOVER_FILL_MAX_ITEMS [16] items in one miss:
///     probably not a swap at all, nothing fetched (as before).
///   - (Oct 27, round 2) TARGETS THAT MOVE OUR POOLS FIRST. The book learns,
///     per target contract, how many of its feed transactions discovery
///     was asked about and how many copy 2's own pool reports later showed
///     moving one of our pools ("hot"). A hot target's misses may use the
///     whole hourly cap. Any other target's ("cold") may use only
///     ARBSIM_DISCOVER_FILL_COLD_PCT [50] % of it, and once a cold target
///     has been asked about ARBSIM_DISCOVER_FILL_COLD_AFTER [20] times
///     without ever moving our pools, its misses aren't fetched at all
///     (until a report shows it moving one: then it is hot). This only
///     decides what is FETCHED; it never changes an answer.
/// Counted (status "discoverFill"): offered, fetched, refused as repeats /
/// over the hour cap / too many / paced / cold. One item = about one node request
/// (an account's code + basics, or one value); see copy2 nodeRequests.
#[derive(Default)]
pub struct DiscoverFillBook {
    pub per_hour: u64,
    pub repeat_s: u64,
    hour_start: Option<Instant>,
    pub hour_used: u64,
    sent: HashMap<crate::state::MissItem, Instant>,
    order: std::collections::VecDeque<crate::state::MissItem>,
    pub offered: u64,
    pub fetched: u64,
    pub repeats: u64,
    pub over_cap: u64,
    pub too_many: u64,
    pub paced: u64,
    /// Share of the hourly cap a cold target may use (percent).
    pub cold_pct: u64,
    /// Asked this many times with no move: a cold target's misses aren't fetched.
    pub cold_after: u64,
    /// Target contract -> (asked, moved our pools, last seen).
    targets: HashMap<Address, (u64, u64, Instant)>,
    /// Misses waiting for copy 2's reports: (trigger hash, target, when).
    pending: std::collections::VecDeque<(B256, Address, Instant)>,
    pub refused_cold: u64,
    pub over_cap_cold: u64,
    /// (ARBSIM_DISCOVER_SELF_ONLY) unknowns answered "moved none" by the
    /// self-only target proof (fastlane/replay_fetch.rs proven_untouching).
    pub self_only_answers: u64,
}

impl DiscoverFillBook {
    pub const REMEMBER: usize = 20_000;
    /// Targets remembered (least recently seen forgotten first).
    pub const TARGETS: usize = 20_000;
    /// A miss's trigger is looked up in copy 2's reports after this long...
    pub const REPORT_AFTER: std::time::Duration = std::time::Duration::from_secs(3);
    /// ...and given up on (counted as "moved none") after this long.
    pub const REPORT_GIVE_UP: std::time::Duration = std::time::Duration::from_secs(60);

    pub fn new(per_hour: u64, repeat_s: u64) -> Self {
        DiscoverFillBook { per_hour, repeat_s, cold_pct: 50, cold_after: 20, ..Default::default() }
    }

    /// The hot targets, most moves first (at most `n`): copy2/warm.rs keeps
    /// their values warm.
    pub fn hot_list(&self, n: usize) -> Vec<Address> {
        let mut v: Vec<(&Address, &(u64, u64, Instant))> = self.targets.iter().filter(|(_, x)| x.1 > 0).collect();
        v.sort_by(|a, b| b.1 .1.cmp(&a.1 .1).then(a.0.cmp(b.0)));
        v.into_iter().take(n).map(|(a, _)| *a).collect()
    }

    /// A target is "hot": a report showed one of its transactions moving our pools.
    pub fn hot(&self, t: &Address) -> bool {
        self.targets.get(t).is_some_and(|x| x.1 > 0)
    }

    /// Discovery answered about a transaction to `target`: `moved` Some(true)
    /// = it moved our pools (answered), Some(false) = moved none (answered),
    /// None = unknown (copy 2's reports will tell, see resolve).
    pub fn note_answer(&mut self, target: Address, trigger: B256, moved: Option<bool>, now: Instant) {
        let e = self.targets.entry(target).or_insert((0, 0, now));
        e.0 += 1;
        e.2 = now;
        match moved {
            Some(true) => e.1 += 1,
            Some(false) => {}
            None => {
                self.pending.push_back((trigger, target, now));
                while self.pending.len() > 4096 {
                    self.pending.pop_front();
                }
            }
        }
        if self.targets.len() > Self::TARGETS {
            if let Some(old) = self.targets.iter().min_by_key(|(_, v)| v.2).map(|(k, _)| *k) {
                self.targets.remove(&old);
            }
        }
    }

    /// Look the waiting misses up in copy 2's reports (`moved_of`: did the
    /// report of that transaction show one of our pools moving?).
    pub fn resolve(&mut self, now: Instant, moved_of: impl Fn(&B256) -> bool) {
        while let Some((h, t, at)) = self.pending.front().copied() {
            let age = now.saturating_duration_since(at);
            if age < Self::REPORT_AFTER {
                break;
            }
            if moved_of(&h) {
                if let Some(e) = self.targets.get_mut(&t) {
                    e.1 += 1;
                }
            } else if age < Self::REPORT_GIVE_UP {
                break;
            }
            self.pending.pop_front();
        }
    }

    /// With the settings from the environment (one per copy 2: copy2/intake.rs).
    pub fn from_env() -> Self {
        let mut b = DiscoverFillBook::new(env_u64("ARBSIM_DISCOVER_FILL_PER_HOUR", 3600), env_u64("ARBSIM_DISCOVER_FILL_REPEAT_S", 600));
        b.cold_pct = env_u64("ARBSIM_DISCOVER_FILL_COLD_PCT", 50).min(100);
        b.cold_after = env_u64("ARBSIM_DISCOVER_FILL_COLD_AFTER", 20).max(1);
        b
    }

    /// The items of one miss that may be fetched now (the rest counted).
    /// `target`: the transaction's target contract (None = unknown: cold).
    pub fn offer(&mut self, items: &[crate::state::MissItem], max_items: usize, now: Instant) -> Vec<crate::state::MissItem> {
        self.offer_for(None, items, max_items, now)
    }

    pub fn offer_for(&mut self, target: Option<Address>, items: &[crate::state::MissItem], max_items: usize, now: Instant) -> Vec<crate::state::MissItem> {
        if items.is_empty() {
            return Vec::new();
        }
        self.offered += items.len() as u64;
        if items.len() > max_items {
            self.too_many += items.len() as u64;
            return Vec::new();
        }
        if self.hour_start.is_none_or(|h| now.saturating_duration_since(h) >= std::time::Duration::from_secs(3600)) {
            self.hour_start = Some(now);
            self.hour_used = 0;
        }
        let wait = std::time::Duration::from_secs(self.repeat_s);
        let fresh: Vec<crate::state::MissItem> = items.iter().filter(|m| self.sent.get(*m).is_none_or(|t| now.saturating_duration_since(*t) >= wait)).cloned().collect();
        self.repeats += (items.len() - fresh.len()) as u64;
        if fresh.is_empty() {
            return fresh;
        }
        if self.hour_used + fresh.len() as u64 > self.per_hour {
            self.over_cap += fresh.len() as u64;
            return Vec::new();
        }
        // TARGETS THAT MOVE OUR POOLS FIRST (see above).
        if !target.is_some_and(|t| self.hot(&t)) {
            if target.and_then(|t| self.targets.get(&t)).is_some_and(|x| x.1 == 0 && x.0 >= self.cold_after) {
                self.refused_cold += fresh.len() as u64;
                return Vec::new();
            }
            if (self.hour_used + fresh.len() as u64) * 100 > self.per_hour * self.cold_pct {
                self.over_cap_cold += fresh.len() as u64;
                return Vec::new();
            }
        }
        fresh
    }

    /// These items were handed to the fetcher.
    pub fn taken(&mut self, items: &[crate::state::MissItem], now: Instant) {
        self.hour_used += items.len() as u64;
        self.fetched += items.len() as u64;
        for m in items {
            if self.sent.insert(m.clone(), now).is_none() {
                self.order.push_back(m.clone());
            }
        }
        while self.order.len() > Self::REMEMBER {
            if let Some(old) = self.order.pop_front() {
                self.sent.remove(&old);
            }
        }
    }

    pub fn json(&self) -> Value {
        let mut hot: Vec<(&Address, &(u64, u64, Instant))> = self.targets.iter().filter(|(_, v)| v.1 > 0).collect();
        hot.sort_by(|a, b| b.1 .1.cmp(&a.1 .1).then(a.0.cmp(b.0)));
        let cold_closed = self.targets.values().filter(|v| v.1 == 0 && v.0 >= self.cold_after).count();
        json!({"perHour": self.per_hour, "repeatS": self.repeat_s, "hourUsed": self.hour_used, "offered": self.offered, "fetched": self.fetched,
            "refusedRepeat": self.repeats, "refusedHourCap": self.over_cap, "refusedTooMany": self.too_many, "paced": self.paced, "remembered": self.sent.len(),
            "coldPct": self.cold_pct, "coldAfter": self.cold_after, "targets": self.targets.len(), "hotTargets": hot.len(), "coldClosedTargets": cold_closed,
            "refusedCold": self.refused_cold, "refusedColdShare": self.over_cap_cold, "waitingForReports": self.pending.len(), "selfOnlyAnswers": self.self_only_answers,
            "topHot": hot.iter().take(5).map(|(a, v)| json!([format!("{a:#x}"), v.0, v.1])).collect::<Vec<_>>()})
    }
}


/// DISCOVER LEARNS pacing: a token bucket of ARBSIM_DISCOVER_FILL_PER_S
/// items a second (bursts up to 2 s worth). true = these `n` items may be
/// fetched now.
fn discover_fill_take(n: usize) -> bool {
    let per_s = env_u64("ARBSIM_DISCOVER_FILL_PER_S", 60) as f64;
    if per_s <= 0.0 {
        return false;
    }
    static B: std::sync::OnceLock<Mutex<(f64, Instant)>> = std::sync::OnceLock::new();
    let b = B.get_or_init(|| Mutex::new((per_s * 2.0, Instant::now())));
    let mut g = b.lock().unwrap();
    let now = Instant::now();
    g.0 = (g.0 + now.duration_since(g.1).as_secs_f64() * per_s).min(per_s * 2.0);
    g.1 = now;
    if g.0 >= n as f64 {
        g.0 -= n as f64;
        true
    } else {
        false
    }
}

/// TRIGGER-ENTRY ONE TRIP (check/entry.rs): `{"type":"trig_entry", "at",
/// "feed", "limit", "maxPools", "minConf", "budgetUs"}`.
/// Plain English: discovery and the candidate checks in ONE question, so
/// the bot doesn't wait for two answers in a row:
///   1. discover the moved pools (exactly trig_discover; its answer goes
///      back unchanged as `disc`);
///   2. pick the candidates for those pools from the bot's table (same
///      picking as the bot);
///   3. check them best-ranked first, each exactly as the bot's own
///      trigger-first `call` would (same handler, same feed with that
///      route, same size ladder), stopping at the first answer the bot would
///      send, or when `budgetUs` is used up.
/// Answer: {ok:true, disc, found, sel:[entry ids], cands:[{e, a}], stopped,
/// cut, tableGen, us, t}. No table yet: `table:"none"` (the bot then checks
/// the old way). Each check's `a` is the very answer a `call` gives.
fn trig_entry(ctx: &Ctx, id: &Value, req: &Value, t0: Instant, tm: &mut Tm) -> Value {
    trig_entry_run(ctx, id, req, t0, tm).0
}

/// One picked candidate of a trigger and its check's answer (fast lane:
/// fastlane/trigger.rs turns the good one into a trade for the gun).
#[derive(Clone, Debug)]
pub struct CheckedRow {
    pub row: crate::check::entry::Row,
    /// The very answer a `call` gives for it (None = the row had no check).
    pub answer: Option<Value>,
    /// The bot would send on it (entry.rs good_enough at the floor asked).
    pub good: bool,
}

/// What one `trig_entry` question did, besides its JSON answer.
#[derive(Clone, Debug, Default)]
pub struct EntryRun {
    /// Moved pools discovery named (lowercase).
    pub pools: Vec<String>,
    /// The table generation and its long-code list (None = no table).
    pub table: Option<(u64, Arc<Vec<String>>)>,
    pub found: usize,
    pub checked: Vec<CheckedRow>,
    pub stopped: bool,
    pub cut: bool,
}

/// TRIGGER-ENTRY ONE TRIP, also used by the fast lane's own trigger path
/// (fastlane/trigger.rs: the very same discovery, picking and checks, run
/// inside Rust the moment a feed message arrives). The JSON answer is
/// exactly what `trig_entry` always answered; EntryRun (None when discovery
/// gave nothing to check) carries the picked rows with their answers.
pub fn trig_entry_run(ctx: &Ctx, id: &Value, req: &Value, t0: Instant, tm: &mut Tm) -> (Value, Option<EntryRun>) {
    let Some(disc) = trig_entry_discover(ctx, id, req) else { return (bad_request(id, "trig_entry needs feed"), None) };
    trig_entry_checks(ctx, id, req, disc, t0, tm)
}

/// Step 1 of trig_entry_run alone: discovery of the moved pools (exactly
/// trig_discover). None = the request has no feed. FAST LANE (Oct 29,
/// fastlane/trigger.rs DISCOVER FIRST): the trigger thread runs this for
/// every transaction of a feed message first (cheap), then the checks only
/// for the ones that moved our pools.
pub fn trig_entry_discover(ctx: &Ctx, id: &Value, req: &Value) -> Option<Value> {
    let at = req.get("at").cloned().unwrap_or_else(|| json!({ "after": "head" }));
    let feed = req.get("feed").filter(|f| f.is_object())?;
    let mut dtm = Tm::default();
    Some(trig_discover(ctx, id, &json!({ "id": id, "type": "trig_discover", "at": at, "feed": feed }), Instant::now(), &mut dtm))
}

/// Steps 2-3 of trig_entry_run, given step 1's discovery answer `disc`:
/// pick the candidates and check them (the answer and EntryRun are exactly
/// trig_entry_run's). `t0`: when the question started (the budget and `us`
/// count from it).
pub fn trig_entry_checks(ctx: &Ctx, id: &Value, req: &Value, disc: Value, t0: Instant, tm: &mut Tm) -> (Value, Option<EntryRun>) {
    let at = req.get("at").cloned().unwrap_or_else(|| json!({ "after": "head" }));
    let Some(feed) = req.get("feed").filter(|f| f.is_object()) else { return (bad_request(id, "trig_entry needs feed"), None) };
    let mut out = json!({ "id": id, "ok": true, "disc": disc });
    let finish = |mut o: Value, tm: &mut Tm| {
        o["us"] = json!(t0.elapsed().as_micros() as u64);
        tm.post_us = t0.elapsed().as_micros() as u64;
        o["t"] = tm.json();
        o
    };
    if out["disc"].get("ok") != Some(&Value::Bool(true)) {
        return (finish(out, tm), None);
    }
    let pools: Vec<String> = out["disc"].get("pools").and_then(|p| p.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_ascii_lowercase())).collect()).unwrap_or_default();
    let max_pools = req.get("maxPools").and_then(|m| m.as_u64()).unwrap_or(4) as usize;
    if pools.is_empty() || pools.len() > max_pools {
        return (finish(out, tm), Some(EntryRun { pools, ..Default::default() }));
    }
    let limit = req.get("limit").and_then(|m| m.as_u64()).unwrap_or(6).min(32) as usize;
    let min_conf = req.get("minConf").and_then(|m| m.as_str()).unwrap_or("medium").to_string();
    let budget = req.get("budgetUs").and_then(|b| b.as_u64()).unwrap_or(200_000);
    let mut run = EntryRun { pools: pools.clone(), ..Default::default() };
    let res = crate::check::entry::pick(&pools, limit).map(|(gen, codes, picked, found)| {
        let sel: Vec<Value> = picked.iter().map(|r| json!(r.e.clone())).collect();
        // 3. Check, best-ranked first.
        let (mut cands, mut stopped, mut cut) = (Vec::new(), false, false);
        let mut checked = Vec::new();
        for (i, r) in picked.iter().enumerate() {
            if t0.elapsed().as_micros() as u64 >= budget {
                cut = true;
                break;
            }
            let Some(c) = &r.c else {
                cands.push(json!({ "e": r.e, "a": null }));
                checked.push(CheckedRow { row: r.clone(), answer: None, good: false });
                continue;
            };
            let call = crate::check::entry::call_for(&codes, c, id, &at, feed, true);
            let mut ctm = Tm::default();
            let a = handle_tm(ctx, &call, &mut ctm);
            let good = crate::check::entry::good_enough(&a, c, &min_conf);
            cands.push(json!({ "e": r.e, "a": a }));
            checked.push(CheckedRow { row: r.clone(), answer: Some(a), good });
            if good {
                stopped = i + 1 < picked.len();
                break;
            }
        }
        (gen, codes, found, sel, cands, stopped, cut, checked)
    });
    match res {
        None => out["table"] = json!("none"),
        Some((gen, codes, found, sel, cands, stopped, cut, checked)) => {
            out["tableGen"] = json!(gen);
            out["found"] = json!(found);
            out["sel"] = json!(sel);
            out["cands"] = json!(cands);
            out["stopped"] = json!(stopped);
            out["cut"] = json!(cut);
            run.table = Some((gen, codes));
            run.found = found;
            run.checked = checked;
            run.stopped = stopped;
            run.cut = cut;
        }
    }
    (finish(out, tm), Some(run))
}

/// How much a trigger-first check may assume (ARBSIM_TRIG_CALL_TRUST).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrigTrust {
    /// `best` [default, Oct 23]: best effort, every assumption the bot
    /// allows (sender_funds, recent_fill / call_fill, skipping unrelated
    /// transactions), each written into the answer with a confidence.
    Best,
    /// `copy2` (the old opt-in): no assumptions for the replayed
    /// transactions; our own calls get the same trust as every other copy-2
    /// check (fills), unlabelled.
    Copy2,
    /// `strict` (the old default): no assumptions at all; any doubt = unknown.
    Strict,
}

/// ARBSIM_TRIG_CALL_TRUST, read once: best (default) / copy2 / strict.
pub fn trig_trust() -> TrigTrust {
    static S: std::sync::OnceLock<TrigTrust> = std::sync::OnceLock::new();
    *S.get_or_init(|| trig_trust_from(std::env::var("ARBSIM_TRIG_CALL_TRUST").ok().as_deref()))
}

/// The setting's text -> TrigTrust (anything unknown = best, the default).
pub fn trig_trust_from(v: Option<&str>) -> TrigTrust {
    match v.map(|x| x.trim().to_ascii_lowercase()).as_deref() {
        Some("strict") => TrigTrust::Strict,
        Some("copy2") => TrigTrust::Copy2,
        _ => TrigTrust::Best,
    }
}

/// Our calls strict?, and the assumptions allowed, for one request:
/// strict (here or the bot's TRIG_FIRST_STRICT=1, `feed.strict`) = none;
/// copy2 = none, our calls trusted like any copy-2 check; best = those the
/// bot allows (`feed.assume`, missing = all). Skipping also needs the route
/// (`route_of(feed.route)`; None = never skip).
pub fn trig_assume(trust: TrigTrust, feed: &crate::check::ordered::WireFeed, route_of: impl Fn(&[String]) -> Option<crate::check::ordered::Route>) -> (bool, crate::check::ordered::Assume) {
    use crate::check::ordered::Assume;
    if feed.strict || trust == TrigTrust::Strict {
        return (true, Assume::default());
    }
    if trust == TrigTrust::Copy2 {
        return (false, Assume::default());
    }
    let allow = |k: &str| feed.assume.as_ref().is_none_or(|l| l.iter().any(|x| x.trim() == k));
    // (Oct 27) PROVEN SKIPPING: only when asked for by name (the fast lane's
    // trigger path, FASTLANE_TRIG_SKIP=proven); the bot never sends it, so
    // its questions are answered exactly as before. It replaces "skip".
    let proven_skip = feed.assume.as_ref().is_some_and(|l| l.iter().any(|x| x.trim() == "skip_proven"));
    let skip = if !proven_skip && allow("skip") && !feed.route.is_empty() { route_of(&feed.route) } else { None };
    (true, Assume { sender_funds: allow("sender_funds"), recent_fill: allow("recent_fill"), skip, record_hashes: false, proven_skip })
}

/// Accounts a request gives contract code by override (the test contract).
fn override_code_accounts(ov: &Value) -> Vec<revm::primitives::Address> {
    ov.as_object()
        .map(|o| o.iter().filter(|(_, v)| v.get("code").is_some()).filter_map(|(k, _)| crate::check::hexutil::parse_address(k).ok()).collect())
        .unwrap_or_default()
}

/// Run the check on the picked version and judge the answer (shared by
/// normal and trigger-first checks). `learn`: queue missing items for
/// fetching and count them in copy 2's status (normal checks only).
fn after_pick(ctx: &Ctx, picked: crate::state::mirror::Picked, t0: Instant, tm: &mut Tm, run: &impl Fn(&dyn StateRead, &BlockCtx) -> Value, learn: bool) -> Value {
    after_pick_with(ctx, picked, t0, tm, run, learn, None)
}

/// `after_pick` with copy 2's registry summary already picked for this
/// version (trigger-first checks pick it first: their exact-values list
/// comes from it too). None = picked here, as always.
fn after_pick_with(
    ctx: &Ctx,
    picked: crate::state::mirror::Picked,
    t0: Instant,
    tm: &mut Tm,
    run: &impl Fn(&dyn StateRead, &BlockCtx) -> Value,
    learn: bool,
    pre: Option<Arc<crate::copy2::checkcore::CheckCore>>,
) -> Value {
    let sh = &ctx.shared;
    let block = picked.seq + sh.cfg.l2_offset;
    // Copy 2: one registry summary for the whole check (checkcore.rs: no
    // waiting for the copy's thread while it is valid for this version).
    let core = match pre {
        Some(k) => Some(k),
        None => {
            let t_core = Instant::now();
            let k = ctx.copy2.as_ref().map(|c| c.core_for(picked.from.as_ref()));
            tm.facts_us = t_core.elapsed().as_micros() as u64;
            k
        }
    };
    let view = View::new(picked.snap);
    let mut answer = match &ctx.copy2 {
        None => {
            let t = Instant::now();
            let a = run(&view, &picked.ctx);
            tm.runs_us.push(t.elapsed().as_micros() as u64);
            a
        }
        Some(c) => copy2_run(c, core.as_deref().expect("copy 2 core"), &view, block, &picked.ctx, tm, run),
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
        // V4 BLIND SPOT (Oct 25, copy2/v4blind.rs): every copy-2 check that
        // missed something (normal, trigger-first, discover) tells copy 2
        // whose PoolManager values they were (from the hash inputs the run
        // recorded, `missingPre`), then that list leaves the answer.
        // (Oct 26) `missingKeys` too: the V4 pool keys the run computed,
        // so auto-follow learns a pool's key without a node request.
        let keys = answer.as_object_mut().and_then(|o| o.remove("missingKeys")).map(|k| parse_missing_keys(&json!({ "missingKeys": k }))).unwrap_or_default();
        if let Some(pre) = answer.as_object_mut().and_then(|o| o.remove("missingPre")) {
            if let (Some(c), Some(k)) = (&ctx.copy2, core.as_deref()) {
                c.note_pm_pre_keys(k, &missing, &parse_missing_pre(&json!({ "missingPre": pre })), &keys);
            }
        } else if let (Some(c), Some(k), false) = (&ctx.copy2, core.as_deref(), missing.is_empty()) {
            c.note_pm_pre(k, &missing, &[]);
        }
        if !missing.is_empty() {
            Stats::inc(&sh.stats.misses);
            if let (Some(c), true) = (&ctx.copy2, learn) {
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
        if let (Some(c), true) = (&ctx.copy2, learn) {
            let why = answer.get("unknown").and_then(|u| u.as_str()).unwrap_or("error");
            c.note_unknown(why, &missing);
        }
        if !missing.is_empty() && learn {
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

/// ARBSIM_LOSS_FAST (default on): see LOSS FAST in copy2_runs.
/// Read every time (cheap) so a test can turn it off for itself.
fn loss_fast_on() -> bool {
    std::env::var("ARBSIM_LOSS_FAST").map(|v| v.trim() != "0").unwrap_or(true)
}

/// A check answer that says "no profit at all": every call reverted (normal
/// end, no halt) with one of our contract's own no-profit answers:
///   - InsufficientProfit(got, wanted) with got = 0, or
///   - TransferFailed() (0x90b8ec18): our contract could not pay a coin it
///     owed out of its own balance. With a flash loan this is the usual way
///     a losing trade ends (the loan can't be repaid from the proceeds; live
///     Oct 24: no InsufficientProfit(0) at all, the bot reads these as
///     "loss"); without one the bot reads it as "fail". Never sent either
///     way, and our contract's balance doesn't depend on the PoolManager
///     balance / fee counter the confirming runs vary.
/// and every size of the size ladder (if any) is a loss or that same
/// TransferFailed. Anything else (a profit, another revert, a size not
/// answered) = false.
pub fn clear_loss(a: &Value) -> bool {
    if a.get("ok") != Some(&Value::Bool(true)) {
        return false;
    }
    let Some(results) = a.get("results").and_then(|r| r.as_array()) else { return false };
    if results.is_empty() {
        return false;
    }
    // InsufficientProfit(uint256 got, uint256 wanted): 4 + 32 + 32 bytes.
    let zero_got = |o: &Value| -> bool {
        if o.get("success") != Some(&Value::Bool(false)) || o.get("halt").is_some_and(|h| !h.is_null()) {
            return false;
        }
        let Some(out) = o.get("output").and_then(|x| x.as_str()) else { return false };
        let out = out.strip_prefix("0x").unwrap_or(out).to_ascii_lowercase();
        out == "90b8ec18" || (out.len() == 136 && out.starts_with("4e88422a") && out[8..72].bytes().all(|c| c == b'0'))
    };
    if !results.iter().all(zero_got) {
        return false;
    }
    match a.get("sizes") {
        None | Some(Value::Null) => true,
        Some(Value::Array(rows)) => rows.iter().all(|r| {
            let st = r.get("status").and_then(|s| s.as_str());
            st == Some("loss") || (st == Some("fail") && r.get("reason").and_then(|x| x.as_str()).is_some_and(|x| x.eq_ignore_ascii_case("0x90b8ec18")))
        }),
        Some(_) => false,
    }
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
        }
        .with_snap(view.snap.clone());
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
            let (mut a, used_bound, used_fee, coins) = run_at(None, fee);
            if !used_bound || !ok(&a) {
                return Ok((a, used_fee));
            }
            // LOSS FAST (Oct 24, speed): the first run already says "no
            // profit at all" (our trade went through every swap and the
            // profit check saw 0, at every size). The PoolManager balance
            // and the protocol-fee counter can't turn that into a profit
            // (they only decide whether a coin transfer goes through, and the
            // gas), and a loss is never sent, so the confirming runs (far
            // above the bound, fee not 0: ~4-12 more full runs) are skipped.
            // Anything else (profit, a revert, an unsure size) is still
            // confirmed exactly as before. ARBSIM_LOSS_FAST=0 turns it off.
            if loss_fast_on() && clear_loss(&a) {
                crate::timing::ph_add("lossFast", 1);
                a["lossFast"] = json!(true);
                return Ok((a, false));
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

    // LOSS FAST: only a plain "profit 0 at every size" answer skips the confirming runs.
    #[test]
    fn clear_loss_only_for_zero_profit_everywhere() {
        use super::clear_loss;
        let ip = |got: &str| format!("0x4e88422a{got}0000000000000000000000000000000000000000000000000000000000000001");
        let loss = json!({"ok": true, "results": [{"success": false, "output": ip("0000000000000000000000000000000000000000000000000000000000000000"), "gasUsed": "0x10"}]});
        assert!(clear_loss(&loss));
        let profit = json!({"ok": true, "results": [{"success": false, "output": ip("0000000000000000000000000000000000000000000000000000000000000001"), "gasUsed": "0x10"}]});
        assert!(!clear_loss(&profit), "a profit must be confirmed");
        let other = json!({"ok": true, "results": [{"success": false, "output": "0x08c379a0", "gasUsed": "0x10"}]});
        assert!(!clear_loss(&other), "another revert must be confirmed");
        let halted = json!({"ok": true, "results": [{"success": false, "output": ip("0000000000000000000000000000000000000000000000000000000000000000"), "gasUsed": "0x10", "halt": "OutOfGas"}]});
        assert!(!clear_loss(&halted));
        let ok_call = json!({"ok": true, "results": [{"success": true, "output": "0x", "gasUsed": "0x10"}, {"success": false, "output": ip("0000000000000000000000000000000000000000000000000000000000000000"), "gasUsed": "0x10"}]});
        assert!(!clear_loss(&ok_call), "every call must be the zero-profit revert");
        let mut sized = loss.clone();
        sized["sizes"] = json!([{"status": "loss"}, {"status": "loss"}]);
        assert!(clear_loss(&sized));
        sized["sizes"] = json!([{"status": "loss"}, {"status": "profit"}]);
        assert!(!clear_loss(&sized), "a profitable size must be confirmed");
        sized["sizes"] = json!([{"status": "unknown"}]);
        assert!(!clear_loss(&sized));
        assert!(!clear_loss(&json!({"ok": false, "unknown": "miss"})));
        assert!(!clear_loss(&json!({"ok": true, "results": []})));
        assert!(!clear_loss(&json!({"ok": true, "best": null, "tried": []})));
        // Flash-loan loss: TransferFailed() (loan not repaid).
        let tf = json!({"ok": true, "results": [{"success": false, "output": "0x90b8ec18", "gasUsed": "0x10"}]});
        assert!(clear_loss(&tf));
        let mut tfs = tf.clone();
        tfs["sizes"] = json!([{"status": "fail", "reason": "0x90b8ec18"}, {"status": "loss"}]);
        assert!(clear_loss(&tfs));
        tfs["sizes"] = json!([{"status": "fail", "reason": "0x12345678"}]);
        assert!(!clear_loss(&tfs), "another failing size must be confirmed");
        let tf_long = json!({"ok": true, "results": [{"success": false, "output": "0x90b8ec1800", "gasUsed": "0x10"}]});
        assert!(!clear_loss(&tf_long), "exactly the 4-byte error only");
    }

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

    // DISCOVER LEARNS budget: one fetch per item per repeat window, a hard
    // hourly cap, too-big misses never fetched; all counted.
    #[test]
    fn discover_fill_book_fetches_each_item_once_within_the_hour_cap() {
        use super::DiscoverFillBook;
        use crate::state::MissItem;
        use std::time::{Duration, Instant};
        use revm::primitives::{Address, U256};
        let t0 = Instant::now();
        let mut b = DiscoverFillBook::new(3, 600);
        b.cold_pct = 100; // the hot / cold split: next test
        let a = Address::with_last_byte(1);
        let one = vec![MissItem::Account(a), MissItem::Slot(a, U256::from(1u8))];
        let got = b.offer(&one, 16, t0);
        assert_eq!(got, one);
        b.taken(&got, t0);
        // The same items again within 10 minutes: refused as repeats.
        assert!(b.offer(&one, 16, t0 + Duration::from_secs(60)).is_empty());
        assert_eq!(b.repeats, 2);
        // Two new items would make 4 > 3 this hour: refused (hard cap).
        let two = vec![MissItem::Slot(a, U256::from(2u8)), MissItem::Slot(a, U256::from(3u8))];
        assert!(b.offer(&two, 16, t0 + Duration::from_secs(61)).is_empty());
        assert_eq!(b.over_cap, 2);
        // Too many in one miss: never fetched.
        let many: Vec<MissItem> = (0..17u8).map(|i| MissItem::Slot(a, U256::from(i))).collect();
        assert!(b.offer(&many, 16, t0).is_empty());
        assert_eq!(b.too_many, 17);
        // A new hour, and past the repeat window: allowed again.
        let later = t0 + Duration::from_secs(3_601);
        assert_eq!(b.offer(&one, 16, later), one);
        assert_eq!(b.offer(&two, 16, later), two);
        let j = b.json();
        assert_eq!((j["fetched"].clone(), j["offered"].clone()), (json!(2), json!(27)), "{j}");
        // 0 an hour = nothing fetched.
        let mut off = DiscoverFillBook::new(0, 600);
        assert!(off.offer(&one, 16, t0).is_empty());
    }

    // TARGETS THAT MOVE OUR POOLS FIRST: a cold target gets half the hourly
    // cap and is closed after COLD_AFTER asks with no move; a target whose
    // transaction copy 2's reports later show moving our pools is hot and
    // gets the whole cap.
    #[test]
    fn discover_fill_book_prefers_targets_that_moved_our_pools() {
        use super::DiscoverFillBook;
        use crate::state::MissItem;
        use revm::primitives::{Address, B256, U256};
        use std::time::{Duration, Instant};
        let t0 = Instant::now();
        let mut b = DiscoverFillBook::new(10, 600);
        b.cold_after = 3;
        let (hot, cold) = (Address::with_last_byte(0xa), Address::with_last_byte(0xb));
        let item = |i: u8| MissItem::Slot(Address::with_last_byte(0xc), U256::from(i));
        // A miss on `hot`'s transaction h1; the report (3+ s later) shows it moved our pools.
        let h1 = B256::with_last_byte(1);
        b.note_answer(hot, h1, None, t0);
        b.resolve(t0 + Duration::from_secs(1), |h| *h == h1);
        assert!(!b.hot(&hot), "too early to look");
        b.resolve(t0 + Duration::from_secs(4), |h| *h == h1);
        assert!(b.hot(&hot));
        // Cold: at most 50% of 10 = 5 items an hour.
        b.note_answer(cold, B256::with_last_byte(2), None, t0);
        let got = b.offer_for(Some(cold), &[item(1), item(2), item(3), item(4), item(5)], 16, t0);
        assert_eq!(got.len(), 5);
        b.taken(&got, t0);
        assert!(b.offer_for(Some(cold), &[item(6)], 16, t0).is_empty());
        assert_eq!(b.over_cap_cold, 1);
        // Hot: the rest of the cap.
        let got = b.offer_for(Some(hot), &[item(7), item(8), item(9)], 16, t0);
        assert_eq!(got.len(), 3);
        b.taken(&got, t0);
        // A report never shows `cold` moving our pools: after 60 s its misses
        // count as "moved none"; at COLD_AFTER asks it is closed.
        b.note_answer(cold, B256::with_last_byte(3), Some(false), t0);
        b.note_answer(cold, B256::with_last_byte(4), None, t0);
        b.resolve(t0 + Duration::from_secs(61), |_| false);
        let later = t0 + Duration::from_secs(3_601);
        assert!(b.offer_for(Some(cold), &[item(20)], 16, later).is_empty());
        assert_eq!(b.refused_cold, 1);
        assert!(!b.offer_for(Some(hot), &[item(21)], 16, later).is_empty(), "hot is never closed");
        let j = b.json();
        assert_eq!((j["hotTargets"].clone(), j["coldClosedTargets"].clone(), j["waitingForReports"].clone()), (json!(1), json!(1), json!(0)), "{j}");
    }
}
