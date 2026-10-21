// ============================================================================
// COPY 2 LOADER: the background threads that talk to the node for copy 2.
//
// Plain English:
//   Asking the node takes 100-1000 ms per request. The thread that applies
//   each block's events (copy2/intake.rs) must never wait for that, or the
//   copy falls behind the chain. So every node question goes through here:
//     Fetch  storage slots / account basics / read-only calls AT ONE BLOCK,
//            all in one JSON-RPC batch (the node client splits it into HTTP
//            requests of ARBSIM_NODE_BATCH calls each)
//     Trace  "where does this coin keep this pool's balance?":
//            balanceOf(pool) + debug_traceCall of it with the prestate tracer
//     Probe  where a coin keeps balances in general (coins.rs)
//     Tip    the node's newest block (for status)
//   Answers go back to the intake thread as messages; nothing is written
//   into the copy here.
//
//   THREE LANES, so slow things never hold up quick ones:
//     urgent  values a check missed, values a pool's catch-up needs, coin
//             probes, tip           -> general threads, before bulk
//     bulk    first loads of many pools at once -> general threads
//     trace   balance traces (slow, ~1 s each) -> their own threads
//   [ARBSIM_COPY2_LOADERS 16 general threads, ARBSIM_COPY2_TRACE_LOADERS 6]
//   Bulk loads use the node budget class "bulk", which never pushes the
//   speed limit (ARBSIM_NODE_RPS) into debt: they use the room the urgent
//   ones leave, so a check's missing value is never stuck behind loading.
//
//   Which block: the bot's websocket reports run a few blocks AHEAD of what
//   the node answers over HTTP. Loads, fills, probes and traces are fetched
//   at min(wanted block, node's newest block); the intake carries values
//   forward from there. A fetch that must be at one exact block answers
//   "not there yet" at once if the node isn't there (no thread waits); the
//   intake asks again shortly.
//   A node ERROR is never read as an answer: it comes back as an error and
//   the intake tries again later.
//
//   Node choice: the PAID node first (call_batch_paid), the free public node
//   only if the paid one refuses (daily allowance used up) or fails.
//   Status (copy2.loader): threads busy, queue lengths, node requests per
//   second over the last minute, average answer time per kind.
// ============================================================================
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use revm::primitives::{Address, Bytes, U256};
use serde_json::{json, Value};

use super::coins::{balance_of_data, probe_layout, BalanceLayout};
use super::intake::Input;
use crate::check::hexutil::{parse_bytes, parse_u256, parse_u64, to_hex};
use crate::node::{tag, CallResult, Class, Fetched, FetchedAccount, ItemErr, NodeApi, NodeErr};
use crate::state::MissItem;

/// Marker in the error text of an exact fetch whose block the node doesn't
/// have yet (not a real error: just ask again shortly).
pub const NOT_YET: &str = "not there yet";

/// A question for the node.
pub enum Job {
    /// `exact` = must be at `block`; otherwise at most `block` (an older
    /// block the node has is fine: the answer says which block was used).
    /// `bulk` = first loads (go after everything urgent).
    Fetch { id: u64, block: u64, exact: bool, bulk: bool, items: Vec<MissItem>, calls: Vec<(Address, Bytes)> },
    /// balanceOf(holder) on coin + its prestate trace, at most `block`.
    Trace { id: u64, block: u64, coin: Address, holder: Address },
    Probe { id: u64, coin: Address, block: u64 },
    Tip { id: u64 },
}

/// What a Fetch brought back (same order as asked).
pub struct FetchOut {
    pub items: Vec<(MissItem, Result<Fetched, ItemErr>)>,
    pub calls: Vec<Result<Bytes, String>>,
}

/// An answer, sent back to the intake thread.
pub enum Done {
    Fetch { id: u64, block: u64, res: Result<FetchOut, NodeErr> },
    /// (balance, trace {address: {balance, nonce, code, storage}}).
    Trace { id: u64, block: u64, coin: Address, holder: Address, res: Result<(U256, Value), NodeErr> },
    Probe { id: u64, coin: Address, res: Result<Option<BalanceLayout>, NodeErr> },
    Tip { id: u64, res: Result<(u64, u64), NodeErr> },
}

// ---------------------------------------------------------------------------
// Numbers for status
// ---------------------------------------------------------------------------
/// What the loaders are doing (shared with status).
#[derive(Default)]
pub struct LoaderStats {
    pub busy: AtomicU64,
    pub threads: AtomicU64,
    /// Recent jobs: (finished, kind, node requests, milliseconds), last minute.
    recent: Mutex<VecDeque<(Instant, &'static str, u64, u64)>>,
    /// Since start: kind -> (jobs, total ms).
    total: Mutex<Vec<(&'static str, u64, u64)>>,
    /// Queue lengths (urgent, bulk, trace).
    pub queued: Mutex<(usize, usize, usize)>,
}

impl LoaderStats {
    fn note(&self, kind: &'static str, requests: u64, ms: u64) {
        let now = Instant::now();
        let mut r = self.recent.lock().unwrap();
        r.push_back((now, kind, requests, ms));
        while r.front().is_some_and(|x| now.duration_since(x.0) > Duration::from_secs(60)) || r.len() > 20_000 {
            r.pop_front();
        }
        drop(r);
        let mut t = self.total.lock().unwrap();
        match t.iter_mut().find(|x| x.0 == kind) {
            Some(x) => {
                x.1 += 1;
                x.2 += ms;
            }
            None => t.push((kind, 1, ms)),
        }
    }

    /// Status block.
    pub fn json(&self) -> Value {
        let now = Instant::now();
        let r = self.recent.lock().unwrap();
        let in_min: Vec<_> = r.iter().filter(|x| now.duration_since(x.0) <= Duration::from_secs(60)).collect();
        let reqs: u64 = in_min.iter().map(|x| x.2).sum();
        let mut kinds = serde_json::Map::new();
        for k in ["load", "catchup", "fill", "trace", "probe", "tip"] {
            let v: Vec<_> = in_min.iter().filter(|x| x.1 == k).collect();
            let all = self.total.lock().unwrap().iter().find(|x| x.0 == k).map(|x| (x.1, x.2));
            if v.is_empty() && all.is_none() {
                continue;
            }
            let avg = |n: u64, ms: u64| if n == 0 { Value::Null } else { json!(ms / n) };
            kinds.insert(
                k.into(),
                json!({
                    "jobsLastMin": v.len(),
                    "avgMsLastMin": avg(v.len() as u64, v.iter().map(|x| x.3).sum()),
                    "jobs": all.map(|a| a.0).unwrap_or(0),
                    "avgMs": all.map(|a| avg(a.0, a.1)).unwrap_or(Value::Null),
                }),
            );
        }
        let (u, b, t) = *self.queued.lock().unwrap();
        json!({
            "threads": self.threads.load(Ordering::Relaxed),
            "busy": self.busy.load(Ordering::Relaxed),
            "queued": { "urgent": u, "bulk": b, "trace": t },
            "requestsPerSecLastMin": (reqs as f64 / 60.0 * 10.0).round() / 10.0,
            "byKind": Value::Object(kinds),
        })
    }
}

// ---------------------------------------------------------------------------
// Queues + threads
// ---------------------------------------------------------------------------
struct Lanes {
    urgent: VecDeque<Job>,
    bulk: VecDeque<Job>,
    trace: VecDeque<Job>,
    closed: bool,
}

struct Queue {
    m: Mutex<Lanes>,
    cv: Condvar,
    stats: Arc<LoaderStats>,
}

impl Queue {
    fn publish_len(&self, l: &Lanes) {
        *self.stats.queued.lock().unwrap() = (l.urgent.len(), l.bulk.len(), l.trace.len());
    }
    /// Next job for a general (trace = false) or trace thread. None = stop.
    fn take(&self, trace: bool) -> Option<Job> {
        let mut g = self.m.lock().unwrap();
        loop {
            if g.closed {
                return None;
            }
            let j = if trace { g.trace.pop_front() } else { g.urgent.pop_front().or_else(|| g.bulk.pop_front()) };
            if let Some(j) = j {
                self.publish_len(&g);
                return Some(j);
            }
            g = self.cv.wait(g).unwrap();
        }
    }
}

/// Handle to the loader threads.
pub struct Loaders {
    q: Arc<Queue>,
}

impl Drop for Loaders {
    fn drop(&mut self) {
        self.q.m.lock().unwrap().closed = true;
        self.q.cv.notify_all();
    }
}

/// Everything a loader thread uses.
#[derive(Clone)]
struct Env {
    node: Arc<dyn NodeApi>,
    out: SyncSender<Input>,
    requests: Arc<AtomicU64>,
    tip: Arc<Tip>,
    stats: Arc<LoaderStats>,
}

impl Loaders {
    /// Start `n` general + `n_trace` trace threads. Answers go into `out`
    /// (the intake's input). `tip_out`: the node's newest block (status).
    pub fn spawn(
        n: usize,
        n_trace: usize,
        node: Arc<dyn NodeApi>,
        out: SyncSender<Input>,
        requests: Arc<AtomicU64>,
        tip_out: Arc<AtomicU64>,
        stats: Arc<LoaderStats>,
    ) -> Loaders {
        let q = Arc::new(Queue {
            m: Mutex::new(Lanes { urgent: VecDeque::new(), bulk: VecDeque::new(), trace: VecDeque::new(), closed: false }),
            cv: Condvar::new(),
            stats: stats.clone(),
        });
        let env = Env { node, out, requests, tip: Arc::new(Tip { known: Mutex::new((0, None)), out: tip_out }), stats: stats.clone() };
        let (n, n_trace) = (n.max(1), n_trace.max(1));
        stats.threads.store((n + n_trace) as u64, Ordering::Relaxed);
        for i in 0..n + n_trace {
            let (q, env) = (q.clone(), env.clone());
            let trace = i >= n;
            let name = if trace { format!("arbsim-copy2-trace-{}", i - n) } else { format!("arbsim-copy2-load-{i}") };
            std::thread::Builder::new().name(name).spawn(move || run(q, env, trace)).expect("loader thread");
        }
        Loaders { q }
    }

    pub fn send(&self, j: Job) {
        let mut g = self.q.m.lock().unwrap();
        match &j {
            Job::Fetch { bulk: true, .. } => g.bulk.push_back(j),
            Job::Trace { .. } => g.trace.push_back(j),
            _ => g.urgent.push_back(j),
        }
        self.q.publish_len(&g);
        drop(g);
        self.q.cv.notify_all();
    }
}

/// The node's newest block, shared by the loader threads (asked at most
/// every 250 ms, only when a job wants a newer block than we know of).
struct Tip {
    known: Mutex<(u64, Option<Instant>)>,
    out: Arc<AtomicU64>,
}

impl Tip {
    fn get(&self, node: &dyn NodeApi, want: u64, requests: &AtomicU64) -> Result<u64, NodeErr> {
        {
            let g = self.known.lock().unwrap();
            if g.0 >= want || g.1.is_some_and(|t| t.elapsed() < Duration::from_millis(250)) {
                return Ok(g.0);
            }
        }
        requests.fetch_add(1, Ordering::Relaxed);
        // Ask the node that will serve the fetch (paid first).
        let r = node.call_batch_paid(Class::Fill, &[("eth_blockNumber", json!([]))])?;
        let t = match r.into_iter().next() {
            Some(Ok(Value::String(s))) => parse_u64(&s).map_err(NodeErr::BadResponse)?,
            Some(Err(e)) => return Err(NodeErr::BadResponse(format!("eth_blockNumber: {}", e.message))),
            _ => return Err(NodeErr::BadResponse("eth_blockNumber: no number".into())),
        };
        let mut g = self.known.lock().unwrap();
        *g = (g.0.max(t), Some(Instant::now()));
        self.out.fetch_max(g.0, Ordering::Relaxed);
        Ok(g.0)
    }

    /// At most `want`, at most the node's newest block.
    fn at_most(&self, node: &dyn NodeApi, want: u64, requests: &AtomicU64) -> Result<u64, NodeErr> {
        self.get(node, want, requests).map(|t| if t == 0 { want } else { want.min(t) })
    }
}

fn run(q: Arc<Queue>, env: Env, trace_lane: bool) {
    while let Some(job) = q.take(trace_lane) {
        env.stats.busy.fetch_add(1, Ordering::Relaxed);
        let t0 = Instant::now();
        let r0 = env.requests.load(Ordering::Relaxed);
        let (kind, done) = one(&env, job);
        let used = env.requests.load(Ordering::Relaxed).saturating_sub(r0);
        env.stats.note(kind, used, t0.elapsed().as_millis() as u64);
        env.stats.busy.fetch_sub(1, Ordering::Relaxed);
        if env.out.send(Input::Done(done)).is_err() {
            return;
        }
    }
}

fn one(env: &Env, job: Job) -> (&'static str, Done) {
    let node = &*env.node;
    let req = &*env.requests;
    match job {
        Job::Fetch { id, block, exact, bulk, items, calls } => {
            let kind = if bulk { "load" } else if exact { "catchup" } else { "fill" };
            let at = if exact {
                match env.tip.get(node, block, req) {
                    Ok(t) if t >= block => Ok(block),
                    Ok(t) => Err(NodeErr::BadResponse(format!("node at block {t}, block {block} {NOT_YET}"))),
                    Err(e) => Err(e),
                }
            } else {
                env.tip.at_most(node, block, req)
            };
            let res = at.and_then(|b| {
                req.fetch_add(count_calls(&items, &calls), Ordering::Relaxed);
                let class = if bulk { Class::Bulk } else { Class::Fill };
                fetch(node, class, b, &items, &calls).map(|o| (b, o))
            });
            match res {
                Ok((b, o)) => (kind, Done::Fetch { id, block: b, res: Ok(o) }),
                Err(e) => (kind, Done::Fetch { id, block, res: Err(e) }),
            }
        }
        Job::Trace { id, block, coin, holder } => {
            let res = env.tip.at_most(node, block, req).and_then(|b| {
                req.fetch_add(2, Ordering::Relaxed);
                trace_balance(node, b, coin, holder).map(|r| (b, r))
            });
            match res {
                Ok((b, r)) => ("trace", Done::Trace { id, block: b, coin, holder, res: Ok(r) }),
                Err(e) => ("trace", Done::Trace { id, block, coin, holder, res: Err(e) }),
            }
        }
        Job::Probe { id, coin, block } => {
            let res = env.tip.at_most(node, block, req).and_then(|b| {
                req.fetch_add(2, Ordering::Relaxed);
                probe_layout(node, coin, b)
            });
            ("probe", Done::Probe { id, coin, res })
        }
        Job::Tip { id } => {
            req.fetch_add(2, Ordering::Relaxed);
            let res = crate::node::block_number(node, Class::Header).and_then(|t| {
                {
                    let mut g = env.tip.known.lock().unwrap();
                    *g = (g.0.max(t), Some(Instant::now()));
                }
                env.tip.out.fetch_max(t, Ordering::Relaxed);
                let bf = crate::node::get_header(node, Class::Header, t)?.map(|h| h.base_fee).unwrap_or(0);
                Ok((t, bf))
            });
            ("tip", Done::Tip { id, res })
        }
    }
}

fn count_calls(items: &[MissItem], calls: &[(Address, Bytes)]) -> u64 {
    let i: u64 = items
        .iter()
        .map(|m| match m {
            MissItem::Slot(..) => 1,
            MissItem::Account(_) => 3,
            MissItem::Code(_) => 0,
        })
        .sum();
    i + calls.len() as u64
}

/// balanceOf(holder) + its prestate trace, one batch at `block`.
fn trace_balance(node: &dyn NodeApi, block: u64, coin: Address, holder: Address) -> Result<(U256, Value), NodeErr> {
    let t = tag(block);
    let c = to_hex(coin.as_slice());
    let data = balance_of_data(holder);
    let rpc = vec![
        ("eth_call", json!([{ "to": c, "data": data }, t])),
        ("debug_traceCall", json!([{ "to": c, "data": data }, t, { "tracer": "prestateTracer" }])),
    ];
    let r = node.call_batch_paid(Class::Fill, &rpc)?;
    let bal = match r.first() {
        Some(Ok(Value::String(s))) => {
            let b = parse_bytes(s).map_err(NodeErr::BadResponse)?;
            if b.len() < 32 {
                return Err(NodeErr::BadResponse(format!("balanceOf answer too short ({} bytes)", b.len())));
            }
            super::word(&b, 0)
        }
        Some(Err(e)) => return Err(NodeErr::BadResponse(format!("balanceOf: {}", e.message))),
        _ => return Err(NodeErr::BadResponse("balanceOf: no answer".into())),
    };
    match r.get(1) {
        Some(Ok(v @ Value::Object(_))) => Ok((bal, v.clone())),
        Some(Err(e)) => Err(NodeErr::BadResponse(format!("trace: {}", e.message))),
        _ => Err(NodeErr::BadResponse("trace: no answer".into())),
    }
}

/// One batch at `block`: slots, account basics (3 calls each) and eth_calls.
pub fn fetch(node: &dyn NodeApi, class: Class, block: u64, items: &[MissItem], calls: &[(Address, Bytes)]) -> Result<FetchOut, NodeErr> {
    let t = tag(block);
    let mut rpc: Vec<(&str, Value)> = Vec::new();
    let mut at: Vec<Option<usize>> = Vec::with_capacity(items.len());
    for it in items {
        match it {
            MissItem::Slot(a, s) => {
                at.push(Some(rpc.len()));
                rpc.push(("eth_getStorageAt", json!([to_hex(a.as_slice()), format!("{s:#066x}"), t])));
            }
            MissItem::Account(a) => {
                at.push(Some(rpc.len()));
                let ah = to_hex(a.as_slice());
                rpc.push(("eth_getBalance", json!([ah, t])));
                rpc.push(("eth_getTransactionCount", json!([ah, t])));
                rpc.push(("eth_getCode", json!([ah, t])));
            }
            MissItem::Code(_) => at.push(None),
        }
    }
    let call_at = rpc.len();
    for (to, data) in calls {
        rpc.push(("eth_call", json!([{ "to": to_hex(to.as_slice()), "data": to_hex(data) }, t])));
    }
    let res = if rpc.is_empty() { Vec::new() } else { node.call_batch_paid(class, &rpc)? };
    if res.len() != rpc.len() {
        return Err(NodeErr::BadResponse(format!("{} answers for {} calls", res.len(), rpc.len())));
    }
    let conv = |r: &CallResult| -> Result<Value, ItemErr> {
        match r {
            Ok(Value::Null) => Err(ItemErr::BlockUnavailable),
            Ok(v) => Ok(v.clone()),
            Err(e) if e.is_block_unavailable() => Err(ItemErr::BlockUnavailable),
            Err(e) => Err(ItemErr::Other(e.message.clone())),
        }
    };
    let text = |r: &CallResult| -> Result<String, ItemErr> {
        conv(r)?.as_str().map(|s| s.to_string()).ok_or(ItemErr::Other("answer not text".into()))
    };
    let mut out = Vec::with_capacity(items.len());
    for (it, i) in items.iter().zip(at) {
        let r = match (it, i) {
            (MissItem::Slot(a, s), Some(i)) => text(&res[i]).and_then(|v| parse_u256(&v).map_err(ItemErr::Other)).map(|v| Fetched::Slot(*a, *s, v)),
            (MissItem::Account(a), Some(i)) => (|| {
                let bal = parse_u256(&text(&res[i])?).map_err(ItemErr::Other)?;
                let nonce = parse_u64(&text(&res[i + 1])?).map_err(ItemErr::Other)?;
                let code = parse_bytes(&text(&res[i + 2])?).map_err(ItemErr::Other)?;
                let empty = bal.is_zero() && nonce == 0 && code.is_empty();
                Ok(Fetched::Account(*a, if empty { None } else { Some(FetchedAccount { balance: bal, nonce, code }) }))
            })(),
            _ => Err(ItemErr::Unsupported),
        };
        out.push((it.clone(), r));
    }
    let calls_out = res[call_at..]
        .iter()
        .map(|r| match r {
            Ok(Value::String(s)) => parse_bytes(s),
            Ok(_) => Err("node has no answer for that block yet".into()),
            Err(e) => Err(format!("node error: {}", e.message)),
        })
        .collect();
    Ok(FetchOut { items: out, calls: calls_out })
}

/// Word `w` of a call answer.
pub fn out_word(r: &Result<Bytes, String>, w: usize) -> Result<U256, String> {
    let b = r.as_ref().map_err(|e| e.clone())?;
    if b.len() < (w + 1) * 32 {
        return Err(format!("answer too short ({} bytes)", b.len()));
    }
    Ok(super::word(b, w))
}
