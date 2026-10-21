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
//
//   SELF-PACING (after dry runs #6/#7): copy 2 never hands the node client
//   more than it may send. A job only leaves the queue when copy 2's own
//   call budget has room for its calls: ARBSIM_COPY2_RATE_PCT (80) % of
//   ARBSIM_NODE_RPS calls per second, with at most 0.1 s worth let out at once.
//   So the node client's speed limit never has to refuse, nothing piles up,
//   and nothing is retried in a loop. While both are waiting, urgent work
//   gets at most ARBSIM_COPY2_URGENT_PCT (25) % of that budget and loading
//   the rest; alone, either gets all of it. Calls are counted when really
//   sent (a refusal by our own limiter is not a node request).
//   Bulk work (loads, traces, probes) never falls back to the public node.
//
//   ONE REQUEST PER ACCOUNT (dry run #8): every value a job needs is grouped
//   by account into one eth_getProof(account, [slots], block). Its answer
//   has the account's balance, nonce, code hash AND the storage values.
//   Contract code is fetched with eth_getCode once per code hash, then
//   kept (most pools share their code). A V2 pool costs ~2 requests instead
//   of ~14. If the node doesn't know eth_getProof, the old way (one request
//   per value) is used instead.
//   This node (Nitro, path-based state) answers eth_getProof only for very
//   recent blocks ("historical state ... is not available"), while
//   eth_getStorageAt / eth_getCode / eth_call work at older blocks. So an
//   account whose proof is refused that way is read the plain way AT THE
//   SAME BLOCK, in the same job (exact; no retry loop).
//   The first 5 errors of each kind are logged (job, method, message).
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

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::AtomicBool;
use std::sync::OnceLock;

use revm::primitives::{keccak256, Address, Bytes, B256, KECCAK_EMPTY, U256};
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
    /// What each thread is doing right now (watchdog): (what, since).
    states: Mutex<Vec<(String, Instant)>>,
    /// When a job last finished.
    last_done: Mutex<Option<Instant>>,
    /// Errors seen per kind, and the first few messages (status + log).
    errors: Mutex<(HashMap<String, u64>, Vec<String>)>,
    pace: Mutex<Option<Pace>>,
}

impl LoaderStats {
    fn set_state(&self, i: usize, what: String) {
        let mut g = self.states.lock().unwrap();
        if g.len() <= i {
            g.resize(i + 1, ("idle".into(), Instant::now()));
        }
        g[i] = (what, Instant::now());
    }

    /// Seconds since a job last finished (None = none finished yet).
    pub fn since_last_done(&self) -> Option<Duration> {
        self.last_done.lock().unwrap().map(|t| t.elapsed())
    }

    /// Note a node error of a job kind; the first 5 per kind are logged.
    pub fn note_error(&self, kind: &str, what: &str) {
        let mut g = self.errors.lock().unwrap();
        let n = {
            let c = g.0.entry(kind.to_string()).or_insert(0);
            *c += 1;
            *c
        };
        if n <= 5 {
            let line: String = format!("{kind}: {what}").chars().take(300).collect();
            eprintln!("[arbsim] copy2 node error #{n} ({line})");
            g.1.push(line);
            if g.1.len() > 30 {
                g.1.remove(0);
            }
        }
    }

    /// Busy threads: "thread N: what (for S s)".
    pub fn thread_states(&self) -> Vec<String> {
        self.states
            .lock()
            .unwrap()
            .iter()
            .enumerate()
            .filter(|(_, s)| s.0 != "idle")
            .map(|(i, s)| format!("#{i}: {} ({:.1} s)", s.0, s.1.elapsed().as_secs_f64()))
            .collect()
    }

    pub fn queue_lengths(&self) -> (usize, usize, usize) {
        *self.queued.lock().unwrap()
    }

    fn note(&self, kind: &'static str, requests: u64, ms: u64) {
        let now = Instant::now();
        *self.last_done.lock().unwrap() = Some(now);
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
        drop(r);
        let (u, b, t) = *self.queued.lock().unwrap();
        let states = self.thread_states();
        json!({
            "busyThreads": states,
            "errorsByKind": self.errors.lock().unwrap().0.clone(),
            "firstErrors": self.errors.lock().unwrap().1.clone(),
            "secondsSinceLastAnswer": self.since_last_done().map(|d| d.as_secs()),
            "threads": self.threads.load(Ordering::Relaxed),
            "busy": self.busy.load(Ordering::Relaxed),
            "queued": { "urgent": u, "bulk": b, "trace": t },
            "requestsPerSecLastMin": (reqs as f64 / 60.0 * 10.0).round() / 10.0,
            "pace": self.pace.lock().unwrap().map(|p| json!({ "callsPerSec": (p.rate * 10.0).round() / 10.0, "urgentShare": p.urgent_share })),
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
    /// Copy 2's call budget (see file header).
    tokens: f64,
    last: Instant,
    /// Recent calls per lane (urgent, bulk+trace), fading over ~10 s.
    used: [f64; 2],
}

/// Copy 2's own pacing settings.
#[derive(Clone, Copy, Debug)]
pub struct Pace {
    /// Calls per second copy 2 may send.
    pub rate: f64,
    /// Share of `rate` urgent work may use while loading waits (0..1).
    pub urgent_share: f64,
}

impl Pace {
    /// ARBSIM_NODE_RPS x ARBSIM_COPY2_RATE_PCT, urgent ARBSIM_COPY2_URGENT_PCT.
    pub fn from_env() -> Self {
        let rps = std::env::var("ARBSIM_NODE_RPS").ok().and_then(|s| s.parse::<f64>().ok()).unwrap_or(8.0);
        let pct = crate::node::env_u64("ARBSIM_COPY2_RATE_PCT", 80).clamp(1, 100) as f64;
        let up = crate::node::env_u64("ARBSIM_COPY2_URGENT_PCT", 25).clamp(1, 99) as f64;
        Pace { rate: (rps * pct / 100.0).max(0.5), urgent_share: up / 100.0 }
    }
    /// Most calls let out at once (0.1 s worth, at least one 25-call request).
    fn burst(&self) -> f64 {
        (self.rate * 0.1).max(25.0)
    }
}

struct Queue {
    m: Mutex<Lanes>,
    cv: Condvar,
    stats: Arc<LoaderStats>,
    pace: Pace,
}

/// Calls a job will send (charged before it leaves the queue; the
/// difference to what it really sent is settled afterwards).
fn cost(j: &Job) -> f64 {
    match j {
        Job::Fetch { items, calls, .. } => count_calls(items, calls) as f64,
        Job::Trace { .. } => 2.0,
        Job::Probe { .. } => 3.0,
        Job::Tip { .. } => 2.0,
    }
}

impl Queue {
    fn publish_len(&self, l: &Lanes) {
        *self.stats.queued.lock().unwrap() = (l.urgent.len(), l.bulk.len(), l.trace.len());
    }
    /// Next job for a general (trace = false) or trace thread, once copy 2's
    /// call budget has room for it. None = stop.
    fn take(&self, trace: bool) -> Option<Job> {
        let mut g = self.m.lock().unwrap();
        loop {
            if g.closed {
                return None;
            }
            // Refill the budget, fade the usage memory.
            let now = Instant::now();
            let el = now.duration_since(g.last).as_secs_f64();
            g.last = now;
            g.tokens = (g.tokens + el * self.pace.rate).min(self.pace.burst());
            let fade = (-el / 10.0).exp();
            g.used[0] *= fade;
            g.used[1] *= fade;
            // Which lane may go: urgent first unless it already had its share
            // while loading waits.
            let loading_waits = !g.bulk.is_empty() || !g.trace.is_empty();
            let total = g.used[0] + g.used[1];
            let urgent_ok = !g.urgent.is_empty() && (!loading_waits || g.used[0] <= self.pace.urgent_share * total + 1.0);
            let lane: Option<usize> = if trace {
                if g.trace.is_empty() || urgent_ok { None } else { Some(2) }
            } else if urgent_ok {
                Some(0)
            } else if !g.bulk.is_empty() {
                Some(1)
            } else if !g.urgent.is_empty() {
                Some(0)
            } else {
                None
            };
            let Some(lane) = lane else {
                g = self.cv.wait_timeout(g, Duration::from_millis(100)).unwrap().0;
                continue;
            };
            let front = match lane {
                0 => g.urgent.front(),
                1 => g.bulk.front(),
                _ => g.trace.front(),
            };
            let c = front.map(cost).unwrap_or(1.0);
            let need = c.min(self.pace.burst());
            if g.tokens >= need {
                g.tokens -= c;
                g.used[usize::from(lane != 0)] += c;
                let j = match lane {
                    0 => g.urgent.pop_front(),
                    1 => g.bulk.pop_front(),
                    _ => g.trace.pop_front(),
                };
                self.publish_len(&g);
                self.cv.notify_all();
                return j;
            }
            let wait = Duration::from_secs_f64(((need - g.tokens) / self.pace.rate).clamp(0.001, 1.0));
            g = self.cv.wait_timeout(g, wait).unwrap().0;
        }
    }

    /// Settle a job's real calls against what it was charged.
    fn settle(&self, charged: f64, sent: u64) {
        let extra = sent as f64 - charged;
        if extra.abs() > 0.0 {
            let mut g = self.m.lock().unwrap();
            g.tokens -= extra;
            if g.tokens > self.pace.burst() {
                g.tokens = self.pace.burst();
            }
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
        pace: Pace,
        node: Arc<dyn NodeApi>,
        out: SyncSender<Input>,
        requests: Arc<AtomicU64>,
        tip_out: Arc<AtomicU64>,
        stats: Arc<LoaderStats>,
    ) -> Loaders {
        let q = Arc::new(Queue {
            m: Mutex::new(Lanes {
                urgent: VecDeque::new(),
                bulk: VecDeque::new(),
                trace: VecDeque::new(),
                closed: false,
                tokens: pace.burst(),
                last: Instant::now(),
                used: [0.0, 0.0],
            }),
            cv: Condvar::new(),
            stats: stats.clone(),
            pace,
        });
        *stats.pace.lock().unwrap() = Some(pace);
        let env = Env { node, out, requests, tip: Arc::new(Tip { known: Mutex::new((0, None)), out: tip_out }), stats: stats.clone() };
        let (n, n_trace) = (n.max(1), n_trace.max(1));
        stats.threads.store((n + n_trace) as u64, Ordering::Relaxed);
        for i in 0..n + n_trace {
            let (q, env) = (q.clone(), env.clone());
            let trace = i >= n;
            let name = if trace { format!("arbsim-copy2-trace-{}", i - n) } else { format!("arbsim-copy2-load-{i}") };
            std::thread::Builder::new().name(name).spawn(move || run(q, env, trace, i)).expect("loader thread");
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
        let _ = requests;
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

fn run(q: Arc<Queue>, env: Env, trace_lane: bool, me: usize) {
    env.stats.set_state(me, "idle".into());
    // This thread's node, counting the calls it really sends.
    let counter = Arc::new(Counting { inner: env.node.clone(), sent: AtomicU64::new(0) });
    let mut env = env;
    env.node = counter.clone();
    while let Some(job) = q.take(trace_lane) {
        env.stats.set_state(me, describe(&job));
        env.stats.busy.fetch_add(1, Ordering::Relaxed);
        let t0 = Instant::now();
        let charged = cost(&job);
        let s0 = counter.sent.load(Ordering::Relaxed);
        let (kind, done) = one(&env, job);
        let used = counter.sent.load(Ordering::Relaxed) - s0;
        report_errors(&env.stats, kind, &done);
        env.requests.fetch_add(used, Ordering::Relaxed);
        q.settle(charged, used);
        env.stats.note(kind, used, t0.elapsed().as_millis() as u64);
        env.stats.busy.fetch_sub(1, Ordering::Relaxed);
        env.stats.set_state(me, "idle".into());
        if env.out.send(Input::Done(done)).is_err() {
            return;
        }
    }
}

/// A node that counts the calls really sent: a refusal by a speed limit or
/// the daily allowance (nothing sent) is not counted.
struct Counting {
    inner: Arc<dyn NodeApi>,
    sent: AtomicU64,
}

impl Counting {
    fn count<T>(&self, n: usize, r: &Result<T, NodeErr>) {
        if !matches!(r, Err(NodeErr::Budget(_)) | Err(NodeErr::NoNode)) {
            self.sent.fetch_add(n as u64, Ordering::Relaxed);
        }
    }
}

impl NodeApi for Counting {
    fn call_batch(&self, class: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        let r = self.inner.call_batch(class, calls);
        self.count(calls.len(), &r);
        r
    }
    fn call_batch_paid(&self, class: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        let r = self.inner.call_batch_paid(class, calls);
        self.count(calls.len(), &r);
        r
    }
    fn usage(&self) -> Value {
        self.inner.usage()
    }
}

/// Log what went wrong in a job (first 5 per kind, see LoaderStats).
fn report_errors(stats: &LoaderStats, kind: &str, d: &Done) {
    match d {
        Done::Fetch { res: Err(e), .. } | Done::Probe { res: Err(e), .. } | Done::Tip { res: Err(e), .. } | Done::Trace { res: Err(e), .. } => {
            if !e.to_string().contains(crate::node::SPEED_LIMIT) {
                stats.note_error(kind, &e.to_string());
            }
        }
        Done::Fetch { res: Ok(o), .. } => {
            if let Some((it, e)) = o.items.iter().find_map(|(it, r)| match r {
                Err(ItemErr::Other(m)) => Some((it, m.clone())),
                _ => None,
            }) {
                stats.note_error(kind, &format!("item {it:?}: {e}"));
            }
            if let Some(Err(e)) = o.calls.iter().find(|c| c.is_err()) {
                stats.note_error(kind, &format!("eth_call: {e}"));
            }
        }
        _ => {}
    }
}

/// One line about a job (watchdog).
fn describe(j: &Job) -> String {
    match j {
        Job::Fetch { block, exact, bulk, items, calls, .. } => format!(
            "{} at block {block}: {} calls",
            if *bulk { "bulk load" } else if *exact { "catch-up fetch" } else { "fill" },
            count_calls(items, calls)
        ),
        Job::Trace { coin, holder, .. } => format!("balance trace {coin} / {holder}"),
        Job::Probe { coin, .. } => format!("coin probe {coin}"),
        Job::Tip { .. } => "node tip".into(),
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
                let class = if bulk { Class::Bulk } else { Class::Fill };
                fetch(node, class, b, &items, &calls).map(|o| (b, o))
            });
            match res {
                Ok((b, o)) => (kind, Done::Fetch { id, block: b, res: Ok(o) }),
                Err(e) => (kind, Done::Fetch { id, block, res: Err(e) }),
            }
        }
        Job::Trace { id, block, coin, holder } => {
            let res = env.tip.at_most(node, block, req).and_then(|b| trace_balance(node, b, coin, holder).map(|r| (b, r)));
            match res {
                Ok((b, r)) => ("trace", Done::Trace { id, block: b, coin, holder, res: Ok(r) }),
                Err(e) => ("trace", Done::Trace { id, block, coin, holder, res: Err(e) }),
            }
        }
        Job::Probe { id, coin, block } => {
            let res = env.tip.at_most(node, block, req).and_then(|b| probe_layout(node, coin, b));
            ("probe", Done::Probe { id, coin, res })
        }
        Job::Tip { id } => {
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
    if NO_PROOF.load(Ordering::Relaxed) {
        let i: u64 = items
            .iter()
            .map(|m| match m {
                MissItem::Slot(..) => 1,
                MissItem::Account(_) => 3,
                MissItem::Code(_) => 0,
            })
            .sum();
        return i + calls.len() as u64;
    }
    let mut per: HashMap<Address, u64> = HashMap::new();
    for m in items {
        match m {
            MissItem::Slot(a, _) => *per.entry(*a).or_insert(0) += 1,
            MissItem::Account(a) => {
                per.entry(*a).or_insert(0);
            }
            MissItem::Code(_) => {}
        }
    }
    per.values().map(|n| n.div_ceil(PROOF_SLOTS).max(1)).sum::<u64>() + calls.len() as u64
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
    let r = node.call_batch_paid(Class::Bulk, &rpc)?;
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

/// Most storage keys asked in one eth_getProof.
const PROOF_SLOTS: u64 = 100;
/// Set when the node doesn't know eth_getProof: the plain way from then on.
static NO_PROOF: AtomicBool = AtomicBool::new(false);

/// Contract code by hash, shared by all loader threads (capped).
fn code_cache() -> &'static Mutex<HashMap<B256, Bytes>> {
    static C: OnceLock<Mutex<HashMap<B256, Bytes>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One job's values at `block`: eth_getProof per account (see file header),
/// eth_getCode for code we haven't seen, plus the eth_calls.
pub fn fetch(node: &dyn NodeApi, class: Class, block: u64, items: &[MissItem], calls: &[(Address, Bytes)]) -> Result<FetchOut, NodeErr> {
    if !NO_PROOF.load(Ordering::Relaxed) {
        match fetch_proof(node, class, block, items, calls) {
            Err(NodeErr::BadResponse(m)) if m.starts_with("eth_getProof unsupported") => {
                eprintln!("[arbsim] copy2: the node doesn't support eth_getProof ({m}); using one request per value");
                NO_PROOF.store(true, Ordering::Relaxed);
            }
            r => return r,
        }
    }
    fetch_plain(node, class, block, items, calls)
}

fn fetch_proof(node: &dyn NodeApi, class: Class, block: u64, items: &[MissItem], calls: &[(Address, Bytes)]) -> Result<FetchOut, NodeErr> {
    let t = tag(block);
    // Group by account: (slots asked, in order).
    let mut by: BTreeMap<Address, Vec<U256>> = BTreeMap::new();
    for m in items {
        match m {
            MissItem::Slot(a, s) => {
                let v = by.entry(*a).or_default();
                if !v.contains(s) {
                    v.push(*s);
                }
            }
            MissItem::Account(a) => {
                by.entry(*a).or_default();
            }
            MissItem::Code(_) => {}
        }
    }
    let mut rpc: Vec<(&str, Value)> = Vec::new();
    // (account, slots in this request)
    let mut asked: Vec<(Address, Vec<U256>)> = Vec::new();
    for (a, slots) in &by {
        let chunks: Vec<Vec<U256>> = if slots.is_empty() { vec![vec![]] } else { slots.chunks(PROOF_SLOTS as usize).map(|c| c.to_vec()).collect() };
        for c in chunks {
            let keys: Vec<String> = c.iter().map(|s| format!("{s:#066x}")).collect();
            rpc.push(("eth_getProof", json!([to_hex(a.as_slice()), keys, t])));
            asked.push((*a, c));
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
    // Per account: basics (balance, nonce, code hash) and slot values.
    type Basics = (U256, u64, B256);
    // Accounts to read the plain way (no proof for that block).
    let mut plain: Vec<Address> = Vec::new();
    let mut basics: HashMap<Address, Result<Basics, ItemErr>> = HashMap::new();
    let mut slots: HashMap<(Address, U256), Result<U256, ItemErr>> = HashMap::new();
    for ((a, keys), r) in asked.iter().zip(res[..call_at].iter()) {
        let parsed = (|| -> Result<(Basics, Vec<U256>), ItemErr> {
            let v = match r {
                Ok(Value::Null) => return Err(ItemErr::BlockUnavailable),
                Ok(v) => v,
                Err(e) if e.is_block_unavailable() => return Err(ItemErr::BlockUnavailable),
                Err(e) => return Err(ItemErr::Other(format!("eth_getProof: {}", e.message))),
            };
            let txt = |k: &str| v.get(k).and_then(|x| x.as_str()).ok_or(ItemErr::Other(format!("eth_getProof: no {k}")));
            let bal = parse_u256(txt("balance")?).map_err(ItemErr::Other)?;
            let nonce = parse_u64(txt("nonce")?).map_err(ItemErr::Other)?;
            let ch = parse_u256(txt("codeHash")?).map_err(ItemErr::Other)?;
            let sp = v.get("storageProof").and_then(|x| x.as_array()).ok_or(ItemErr::Other("eth_getProof: no storageProof".into()))?;
            if sp.len() != keys.len() {
                return Err(ItemErr::Other(format!("eth_getProof: {} values for {} keys", sp.len(), keys.len())));
            }
            let mut vals = Vec::with_capacity(keys.len());
            for e in sp {
                let val = e.get("value").and_then(|x| x.as_str()).ok_or(ItemErr::Other("eth_getProof: value missing".into()))?;
                vals.push(parse_u256(val).map_err(ItemErr::Other)?);
            }
            Ok(((bal, nonce, B256::from(ch.to_be_bytes::<32>())), vals))
        })();
        match parsed {
            Ok((b, vals)) => {
                basics.insert(*a, Ok(b));
                for (k, v) in keys.iter().zip(vals) {
                    slots.insert((*a, *k), Ok(v));
                }
            }
            Err(e) => {
                // A node that doesn't know the method at all: plain way.
                if let ItemErr::Other(m) = &e {
                    let l = m.to_ascii_lowercase();
                    if l.contains("method not found") || l.contains("not supported") || l.contains("does not exist") || l.contains("not available") && l.contains("method") {
                        return Err(NodeErr::BadResponse(format!("eth_getProof unsupported: {m}")));
                    }
                    // No proof for an older block: read it the plain way.
                    if l.contains("historical state") || l.contains("missing trie node") || l.contains("state not available") || l.contains("not available") {
                        if !plain.contains(a) {
                            plain.push(*a);
                        }
                        continue;
                    }
                }
                basics.insert(*a, Err(e.clone()));
                for k in keys {
                    slots.insert((*a, *k), Err(e.clone()));
                }
            }
        }
    }
    // Accounts without a proof for this block: plain reads, same block.
    let mut plain_out: HashMap<MissItem, Result<Fetched, ItemErr>> = HashMap::new();
    if !plain.is_empty() {
        let pitems: Vec<MissItem> = items
            .iter()
            .filter(|m| matches!(m, MissItem::Slot(a, _) | MissItem::Account(a) if plain.contains(a)))
            .cloned()
            .collect();
        let o = fetch_plain(node, class, block, &pitems, &[])?;
        for (it, r) in o.items {
            plain_out.insert(it, r);
        }
    }
    // Code for accounts asked as accounts, by hash (cached).
    let mut need_code: Vec<(Address, B256)> = Vec::new();
    for m in items {
        if let MissItem::Account(a) = m {
            if let Some(Ok((_, _, h))) = basics.get(a) {
                if *h != KECCAK_EMPTY && !h.is_zero() && !code_cache().lock().unwrap().contains_key(h) && !need_code.iter().any(|x| x.1 == *h) {
                    need_code.push((*a, *h));
                }
            }
        }
    }
    if !need_code.is_empty() {
        let rpc: Vec<(&str, Value)> = need_code.iter().map(|(a, _)| ("eth_getCode", json!([to_hex(a.as_slice()), tag(block)]))).collect();
        let res = node.call_batch_paid(class, &rpc)?;
        for ((a, h), r) in need_code.iter().zip(res) {
            match r {
                Ok(Value::String(sx)) => {
                    let code = parse_bytes(&sx).map_err(NodeErr::BadResponse)?;
                    if keccak256(&code) == *h {
                        let mut c = code_cache().lock().unwrap();
                        if c.len() > 5000 {
                            c.clear();
                        }
                        c.insert(*h, code);
                    } else {
                        basics.insert(*a, Err(ItemErr::Other("eth_getCode: code doesn't match the account's code hash".into())));
                    }
                }
                Ok(_) => {
                    basics.insert(*a, Err(ItemErr::BlockUnavailable));
                }
                Err(e) => {
                    basics.insert(*a, Err(ItemErr::Other(format!("eth_getCode: {}", e.message))));
                }
            }
        }
    }
    let mut out = Vec::with_capacity(items.len());
    for it in items {
        if let Some(r) = plain_out.get(it) {
            out.push((it.clone(), r.clone()));
            continue;
        }
        let r = match it {
            MissItem::Slot(a, sl) => slots.get(&(*a, *sl)).cloned().unwrap_or(Err(ItemErr::Unsupported)).map(|v| Fetched::Slot(*a, *sl, v)),
            MissItem::Account(a) => match basics.get(a).cloned().unwrap_or(Err(ItemErr::Unsupported)) {
                Ok((bal, nonce, h)) => {
                    let no_code = h == KECCAK_EMPTY || h.is_zero();
                    let code = if no_code { Some(Bytes::new()) } else { code_cache().lock().unwrap().get(&h).cloned() };
                    match code {
                        Some(code) => {
                            let empty = bal.is_zero() && nonce == 0 && code.is_empty();
                            Ok(Fetched::Account(*a, if empty { None } else { Some(FetchedAccount { balance: bal, nonce, code }) }))
                        }
                        None => Err(ItemErr::Other("code not fetched".into())),
                    }
                }
                Err(e) => Err(e),
            },
            MissItem::Code(_) => Err(ItemErr::Unsupported),
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

/// The old way: one request per slot, 3 per account, plus the eth_calls.
fn fetch_plain(node: &dyn NodeApi, class: Class, block: u64, items: &[MissItem], calls: &[(Address, Bytes)]) -> Result<FetchOut, NodeErr> {
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
