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
// ============================================================================
use std::io::BufWriter;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::arb::BlockCtx;
use crate::check::proto_types::{handle_call, handle_size_search, CallRequest, SizeSearchRequest};
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
        // Feed frames: straight to the updater, no answer, never blocks.
        if req.get("type").and_then(|t| t.as_str()) == Some("feed") {
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
            s
        }
        Some("warm") => match parse_warm(req) {
            Ok(items) => {
                let n = items.len();
                ctx.updater.warm(items);
                json!({ "id": id, "ok": true, "queued": n })
            }
            Err(e) => bad_request(&id, &e),
        },
        Some("call") => {
            let r: CallRequest = match serde_json::from_value(req.clone()) {
                Ok(r) => r,
                Err(e) => return bad_request(&id, &format!("call: {e}")),
            };
            check(ctx, &id, &r.at, t0, |view, c| handle_call(view, c, &r))
        }
        Some("size_search") => {
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
            return unknown(id, e.reason, &e.detail, t0.elapsed().as_micros() as u64);
        }
    };
    let view = View::new(picked.snap);
    let mut answer = run(&view, &picked.ctx);
    ctx.updater.touched(view.take_touched());
    if answer.get("ok") == Some(&Value::Bool(true)) {
        Stats::inc(&sh.stats.checks_ok);
    } else {
        Stats::inc(&sh.stats.checks_unknown);
        let missing = parse_missing(&answer);
        if !missing.is_empty() {
            Stats::inc(&sh.stats.misses);
            ctx.updater.fill(missing);
        }
    }
    // Total time inside the sidecar (state pick + check).
    answer["us"] = json!(t0.elapsed().as_micros() as u64);
    answer
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
