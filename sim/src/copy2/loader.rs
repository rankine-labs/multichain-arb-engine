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
//     Tip    the node's newest block (for status; loads / fills use the
//            last known one, refreshed at most every 2 s, catch-ups every
//            0.5 s; a refused refresh never fails a job when a tip is known)
//   Answers go back to the intake thread as messages; nothing is written
//   into the copy here.
//
//   SIMPLE BY DESIGN (after dry runs #6-#10):
//     - A fixed number of worker threads [ARBSIM_COPY2_INFLIGHT, 16] = at
//       most that many node requests in flight. Nothing else limits copy 2.
//       A worker never sleeps inside a job: a job that has to wait (node not
//       at the block yet, backoff) is handed back to the intake, which
//       queues it again later.
//     - ONE queue, two priorities: urgent (values a pool's catch-up needs,
//       the one fill job at a time, coin probes and traces (loads wait for
//       them), the node tip) before bulk (first loads, most-recently-active
//       first, small jobs of ARBSIM_COPY2_LOAD_BATCH (5) pools).
//     - JSON batches of at most 50 calls (Chainstack's limit; ARBSIM_NODE_BATCH
//       25 by default); an item refused for a limit (-32005) is asked once more.
//     - Status per job kind: time waiting in the queue, time the node took,
//       time spent locally (where does the time go?).
//     - The node client's speed limit (node.rs) is one plain token bucket at
//       ARBSIM_NODE_RPS counting HTTP REQUESTS (a batch or a proof = 1); it
//       makes a request wait for its token, it never refuses.
//     - Status counts real HTTP requests (ceil(calls / ARBSIM_NODE_BATCH)).
//     - Copy 2 only uses the paid node (no public fallback, no re-routing).

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
//   Status (copy2.loader): in-flight requests (busy workers), queue lengths,
//   HTTP requests per second over the last minute, answer time per kind.
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
    /// Recent jobs, last minute: (finished, kind, node requests, total ms,
    /// queue-wait ms, node ms).
    recent: Mutex<VecDeque<(Instant, &'static str, u64, u64, u64, u64)>>,
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

    fn note(&self, kind: &'static str, requests: u64, ms: u64, queue_ms: u64, node_ms: u64) {
        let now = Instant::now();
        *self.last_done.lock().unwrap() = Some(now);
        let mut r = self.recent.lock().unwrap();
        r.push_back((now, kind, requests, ms, queue_ms, node_ms));
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
                    "avgQueueMsLastMin": avg(v.len() as u64, v.iter().map(|x| x.4).sum()),
                    "avgNodeMsLastMin": avg(v.len() as u64, v.iter().map(|x| x.5).sum()),
                    "avgLocalMsLastMin": avg(v.len() as u64, v.iter().map(|x| x.3.saturating_sub(x.5)).sum()),
                    "requestsLastMin": v.iter().map(|x| x.2).sum::<u64>(),
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
            "inFlight": self.busy.load(Ordering::Relaxed),
            "byKind": Value::Object(kinds),
        })
    }
}

// ---------------------------------------------------------------------------
// One queue, N workers
// ---------------------------------------------------------------------------
struct Lanes {
    /// (queued at, job)
    urgent: VecDeque<(Instant, Job)>,
    bulk: VecDeque<(Instant, Job)>,
    closed: bool,
}

struct Queue {
    m: Mutex<Lanes>,
    cv: Condvar,
    stats: Arc<LoaderStats>,
}

impl Queue {
    fn publish_len(&self, l: &Lanes) {
        *self.stats.queued.lock().unwrap() = (l.urgent.len(), l.bulk.len(), 0);
    }
    /// Next job, urgent first (with when it was queued). None = stop.
    fn take(&self) -> Option<(Instant, Job)> {
        let mut g = self.m.lock().unwrap();
        loop {
            if g.closed {
                return None;
            }
            if let Some(j) = g.urgent.pop_front().or_else(|| g.bulk.pop_front()) {
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
    head: Arc<AtomicU64>,
}

impl Loaders {
    /// Start `n` workers (= at most `n` node requests in flight). Answers go
    /// into `out` (the intake's input). `tip_out`: node's newest block.
    /// `head`: the copy's newest block (loads read at min(head, node tip)
    /// as of when the job STARTS, not when it was queued).
    pub fn spawn(n: usize, node: Arc<dyn NodeApi>, out: SyncSender<Input>, requests: Arc<AtomicU64>, tip_out: Arc<AtomicU64>, stats: Arc<LoaderStats>, head: Arc<AtomicU64>) -> Loaders {
        let q = Arc::new(Queue { m: Mutex::new(Lanes { urgent: VecDeque::new(), bulk: VecDeque::new(), closed: false }), cv: Condvar::new(), stats: stats.clone() });
        let env = Env { node, out, requests, tip: Arc::new(Tip::new(tip_out)), stats: stats.clone(), head };
        let n = n.max(1);
        stats.threads.store(n as u64, Ordering::Relaxed);
        for i in 0..n {
            let (q, env) = (q.clone(), env.clone());
            std::thread::Builder::new().name(format!("arbsim-copy2-load-{i}")).spawn(move || run(q, env, i)).expect("loader thread");
        }
        Loaders { q }
    }

    /// Queue a job: first loads are bulk; everything else urgent (probes and
    /// traces too: loads wait for them).
    pub fn send(&self, j: Job) {
        let bulk = matches!(j, Job::Fetch { bulk: true, .. });
        let mut g = self.q.m.lock().unwrap();
        if bulk {
            g.bulk.push_back((Instant::now(), j));
        } else {
            g.urgent.push_back((Instant::now(), j));
        }
        self.q.publish_len(&g);
        drop(g);
        self.q.cv.notify_one();
    }
}

/// The node's newest block, shared by the loader threads.
///
/// eth_blockNumber is asked RARELY (dry run #16: it was refused for the RPS
/// limit and that failed whole jobs):
///   - one refresh at a time; the others use the known tip meanwhile
///   - exact catch-up fetches (must be AT a block) refresh at most every
///     ARBSIM_COPY2_TIP_EXACT_MS (500 ms); everything else (loads, fills,
///     probes, traces: an older block is fine, the intake carries forward)
///     at most every ARBSIM_COPY2_TIP_MS (2000 ms)
///   - after a failed refresh: none for 5 s, and the jobs use the tip we
///     already know instead of failing (only with no tip known at all does
///     the error reach the job)
struct Tip {
    /// (newest block known, when a refresh was last tried, last one failed)
    known: Mutex<(u64, Option<Instant>, bool)>,
    out: Arc<AtomicU64>,
    exact_every: Duration,
    every: Duration,
}

impl Tip {
    fn new(out: Arc<AtomicU64>) -> Tip {
        Tip {
            known: Mutex::new((0, None, false)),
            out,
            exact_every: Duration::from_millis(crate::node::env_u64("ARBSIM_COPY2_TIP_EXACT_MS", 500)),
            every: Duration::from_millis(crate::node::env_u64("ARBSIM_COPY2_TIP_MS", 2000)),
        }
    }

    /// The node's newest block as far as we know, refreshed if it is below
    /// `want` and the last try is older than `every` (5 s after a failure).
    fn get(&self, node: &dyn NodeApi, want: u64, every: Duration) -> Result<u64, NodeErr> {
        {
            let mut g = self.known.lock().unwrap();
            let wait = if g.2 { every.max(Duration::from_secs(5)) } else { every };
            if g.0 >= want || g.1.is_some_and(|t| t.elapsed() < wait) {
                return Ok(g.0);
            }
            g.1 = Some(Instant::now()); // others use the known tip meanwhile
        }
        let r = node.call_batch_paid(Class::Fill, &[("eth_blockNumber", json!([]))]).and_then(|r| match r.into_iter().next() {
            Some(Ok(Value::String(s))) => parse_u64(&s).map_err(NodeErr::BadResponse),
            Some(Err(e)) => Err(NodeErr::BadResponse(format!("eth_blockNumber: {}", e.message))),
            _ => Err(NodeErr::BadResponse("eth_blockNumber: no number".into())),
        });
        let mut g = self.known.lock().unwrap();
        match r {
            Ok(t) => {
                *g = (g.0.max(t), Some(Instant::now()), false);
                self.out.fetch_max(g.0, Ordering::Relaxed);
                Ok(g.0)
            }
            // A refusal (RPS limit) or other trouble: keep using what we know.
            Err(e) => {
                g.2 = true;
                if g.0 > 0 {
                    Ok(g.0)
                } else {
                    Err(e)
                }
            }
        }
    }

    /// For an exact fetch at `block`.
    fn for_exact(&self, node: &dyn NodeApi, block: u64) -> Result<u64, NodeErr> {
        self.get(node, block, self.exact_every)
    }

    /// At most `want`, at most the node's newest block.
    fn at_most(&self, node: &dyn NodeApi, want: u64) -> Result<u64, NodeErr> {
        self.get(node, want, self.every).map(|t| if t == 0 { want } else { want.min(t) })
    }
}

fn run(q: Arc<Queue>, env: Env, me: usize) {
    env.stats.set_state(me, "idle".into());
    // This worker's node, counting the HTTP requests it really sends.
    let counter = Arc::new(Counting {
        inner: env.node.clone(),
        sent: AtomicU64::new(0),
        node_us: AtomicU64::new(0),
        batch: crate::node::env_u64("ARBSIM_NODE_BATCH", 25).clamp(1, 50),
    });
    let mut env = env;
    env.node = counter.clone();
    while let Some((queued, job)) = q.take() {
        env.stats.set_state(me, describe(&job));
        env.stats.busy.fetch_add(1, Ordering::Relaxed);
        let t0 = Instant::now();
        let queue_ms = t0.duration_since(queued).as_millis() as u64;
        let (s0, n0) = (counter.sent.load(Ordering::Relaxed), counter.node_us.load(Ordering::Relaxed));
        let (kind, done) = one(&env, job);
        let used = counter.sent.load(Ordering::Relaxed) - s0;
        let node_ms = (counter.node_us.load(Ordering::Relaxed) - n0) / 1000;
        report_errors(&env.stats, kind, &done);
        env.requests.fetch_add(used, Ordering::Relaxed);
        env.stats.note(kind, used, t0.elapsed().as_millis() as u64, queue_ms, node_ms);
        env.stats.busy.fetch_sub(1, Ordering::Relaxed);
        env.stats.set_state(me, "idle".into());
        if env.out.send(Input::Done(done)).is_err() {
            return;
        }
    }
}

/// A node that counts the HTTP requests really sent (a batch of up to
/// ARBSIM_NODE_BATCH calls = 1); a refusal (nothing sent) is not counted.
struct Counting {
    inner: Arc<dyn NodeApi>,
    sent: AtomicU64,
    /// Time spent inside node calls (microseconds).
    node_us: AtomicU64,
    batch: u64,
}

impl Counting {
    fn count<T>(&self, n: usize, r: &Result<T, NodeErr>) {
        if !matches!(r, Err(NodeErr::Budget(_)) | Err(NodeErr::NoNode)) {
            self.sent.fetch_add((n as u64).div_ceil(self.batch), Ordering::Relaxed);
        }
    }
}

impl NodeApi for Counting {
    fn call_batch(&self, class: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        let t = Instant::now();
        let r = self.inner.call_batch(class, calls);
        self.node_us.fetch_add(t.elapsed().as_micros() as u64, Ordering::Relaxed);
        self.count(calls.len(), &r);
        r
    }
    fn call_batch_paid(&self, class: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        let t = Instant::now();
        let r = self.inner.call_batch_paid(class, calls);
        self.node_us.fetch_add(t.elapsed().as_micros() as u64, Ordering::Relaxed);
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
    match job {
        Job::Fetch { id, block, exact, bulk, items, calls } => {
            let kind = if bulk { "load" } else if exact { "catchup" } else { "fill" };
            let at = if exact {
                match env.tip.for_exact(node, block) {
                    Ok(t) if t >= block => Ok(block),
                    Ok(t) => Err(NodeErr::BadResponse(format!("node at block {t}, block {block} {NOT_YET}"))),
                    Err(e) => Err(e),
                }
            } else {
                // Read at the NEWEST block (old blocks are slow archive reads
                // on this node and have no proofs): the copy's head now, or
                // the node's tip if it is behind. The intake carries forward.
                env.tip.at_most(node, block.max(env.head.load(Ordering::Relaxed)))
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
            let want = block.max(env.head.load(Ordering::Relaxed));
            let res = env.tip.at_most(node, want).and_then(|b| trace_balance(node, b, coin, holder).map(|r| (b, r)));
            match res {
                Ok((b, r)) => ("trace", Done::Trace { id, block: b, coin, holder, res: Ok(r) }),
                Err(e) => ("trace", Done::Trace { id, block, coin, holder, res: Err(e) }),
            }
        }
        Job::Probe { id, coin, block } => {
            let want = block.max(env.head.load(Ordering::Relaxed));
            let res = env.tip.at_most(node, want).and_then(|b| probe_layout(node, coin, b));
            ("probe", Done::Probe { id, coin, res })
        }
        Job::Tip { id } => {
            let res = crate::node::block_number(node, Class::Header).and_then(|t| {
                {
                    let mut g = env.tip.known.lock().unwrap();
                    *g = (g.0.max(t), Some(Instant::now()), false);
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
/// Accounts with more values than this are read with plain batches.
const PROOF_MAX_SLOTS: usize = 12;
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
    let mut out = fetch_once(node, class, block, items, calls)?;
    // Items the node refused for a limit (-32005 etc.): ask those once more.
    let limited = |e: &ItemErr| matches!(e, ItemErr::Other(m) if is_limit(m));
    let again: Vec<MissItem> = out.items.iter().filter(|(_, r)| matches!(r, Err(e) if limited(e))).map(|(it, _)| it.clone()).collect();
    if !again.is_empty() {
        if let Ok(o2) = fetch_once(node, class, block, &again, &[]) {
            let fixed: HashMap<MissItem, Result<Fetched, ItemErr>> = o2.items.into_iter().collect();
            for (it, r) in out.items.iter_mut() {
                if matches!(r, Err(e) if limited(e)) {
                    if let Some(nr) = fixed.get(it) {
                        *r = nr.clone();
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Does this node error text mean "a limit" (rate / batch size), not "no"?
pub fn is_limit(m: &str) -> bool {
    let l = m.to_ascii_lowercase();
    l.contains("-32005") || l.contains("limit") || l.contains("too many") || l.contains("exceeded")
}

fn fetch_once(node: &dyn NodeApi, class: Class, block: u64, items: &[MissItem], calls: &[(Address, Bytes)]) -> Result<FetchOut, NodeErr> {
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
    // Accounts to read the plain way (many values, or no proof for that block).
    let mut plain: Vec<Address> = Vec::new();
    let mut rpc: Vec<(&str, Value)> = Vec::new();
    // (account, slots in this request)
    let mut asked: Vec<(Address, Vec<U256>)> = Vec::new();
    for (a, slots) in &by {
        // Proofs are big (every value carries its proof path): accounts with
        // many values (coins holding balances of many pools) are read with
        // plain eth_getStorageAt batches instead.
        if slots.len() > PROOF_MAX_SLOTS {
            plain.push(*a);
            continue;
        }
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
    let mut basics: HashMap<Address, Result<Basics, ItemErr>> = HashMap::new();
    let mut slots: HashMap<(Address, U256), Result<U256, ItemErr>> = HashMap::new();
    for ((a, keys), r) in asked.iter().zip(res[..call_at].iter()) {
        let parsed = (|| -> Result<(Basics, Vec<U256>), ItemErr> {
            let v = match r {
                Ok(Value::Null) => return Err(ItemErr::BlockUnavailable),
                Ok(v) => v,
                Err(e) if e.is_block_unavailable() => return Err(ItemErr::BlockUnavailable),
                Err(e) => return Err(ItemErr::Other(format!("eth_getProof: {} (code {})", e.message, e.code))),
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
            Err(e) => Err(ItemErr::Other(format!("{} (code {})", e.message, e.code))),
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
