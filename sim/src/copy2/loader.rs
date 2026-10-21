// ============================================================================
// COPY 2 LOADER: the background threads that talk to the node for copy 2.
//
// Plain English:
//   Asking the node takes 100-300 ms per request (more when the public node
//   makes us wait). The thread that applies each block's events
//   (copy2/intake.rs) must never wait for that, or the copy falls behind the
//   chain. So every node question goes through here instead:
//     Fetch  storage slots / account basics / read-only calls AT ONE BLOCK,
//            all in one JSON-RPC batch (the node client splits it into
//            requests of ARBSIM_NODE_BATCH calls each)
//     Probe  where a coin keeps balances (coins.rs, 2 requests per coin)
//     Tip    the node's newest block (for status: how far behind are we?)
//   Answers go back to the intake thread as messages; it decides what to do
//   with them (nothing is written into the copy here).
//
//   Which block: the bot's reports (websocket) usually run a few blocks
//   AHEAD of what the node answers over HTTP. A fetch "at the copy's newest
//   block" would then fail ("header not found"). So loads, fills and coin
//   probes are fetched at min(wanted block, node's newest block); the
//   intake carries the values forward from there with the kept reports.
//   Fetches that must be at one exact block (values a working copy needs
//   right before a report) wait here, in the background, until the node
//   has that block (up to ~3 s), then try.
//   A node ERROR is never read as an answer: it comes back as an error and
//   the intake tries again later.
//
//   Node choice: the PAID node first (call_batch_paid), the free public node
//   only if the paid one refuses (daily allowance used up) or fails. The
//   daily allowance and speed limit of node.rs apply as always.
//   Several loader threads run side by side [ARBSIM_COPY2_LOADERS, 4].
//
//   Two queues: URGENT (values a check missed, values a pool's catch-up
//   needs, coin probes, the node's newest block) always go before BULK
//   (first loads of many pools at once). Otherwise a check's missing value
//   would wait behind minutes of initial loading.
//
//   `traces`: debug_traceCall with the prestate tracer = "which storage
//   slots did this call read, and their values" (used to find where a coin
//   keeps one pool's balance, see intake.rs).
// ============================================================================
use std::sync::atomic::{AtomicU64, Ordering};
use std::collections::VecDeque;
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use revm::primitives::{Address, Bytes, U256};
use serde_json::{json, Value};

use super::coins::{probe_layout, BalanceLayout};
use super::intake::Input;
use crate::check::hexutil::{parse_bytes, parse_u256, parse_u64, to_hex};
use crate::node::{tag, CallResult, Class, Fetched, FetchedAccount, ItemErr, NodeApi, NodeErr};
use crate::state::MissItem;

/// A question for the node.
pub enum Job {
    /// `exact` = must be at `block`; otherwise at most `block` (an older
    /// block the node has is fine: the answer says which block was used).
    /// `bulk` = first loads (go after everything urgent).
    Fetch { id: u64, block: u64, exact: bool, bulk: bool, items: Vec<MissItem>, calls: Vec<(Address, Bytes)>, traces: Vec<(Address, Bytes)> },
    Probe { id: u64, coin: Address, block: u64 },
    Tip { id: u64 },
}

/// What a Fetch brought back (same order as asked).
pub struct FetchOut {
    pub items: Vec<(MissItem, Result<Fetched, ItemErr>)>,
    pub calls: Vec<Result<Bytes, String>>,
    /// Prestate traces: {address: {storage: {slot: value}}} per trace asked.
    pub traces: Vec<Result<Value, String>>,
}

/// An answer, sent back to the intake thread.
pub enum Done {
    Fetch { id: u64, block: u64, res: Result<FetchOut, NodeErr> },
    Probe { id: u64, coin: Address, res: Result<Option<BalanceLayout>, NodeErr> },
    Tip { id: u64, res: Result<(u64, u64), NodeErr> },
}

/// Handle to the loader threads.
pub struct Loaders {
    q: Arc<Queue>,
}

/// The two job queues (urgent, bulk) shared by the loader threads.
struct Queue {
    m: Mutex<(VecDeque<Job>, VecDeque<Job>, bool)>,
    cv: Condvar,
}

impl Queue {
    /// Next job, urgent first. None = shutting down.
    fn take(&self) -> Option<Job> {
        let mut g = self.m.lock().unwrap();
        loop {
            if g.2 {
                return None;
            }
            if let Some(j) = g.0.pop_front() {
                return Some(j);
            }
            if let Some(j) = g.1.pop_front() {
                return Some(j);
            }
            g = self.cv.wait(g).unwrap();
        }
    }
}

impl Drop for Loaders {
    fn drop(&mut self) {
        self.q.m.lock().unwrap().2 = true;
        self.q.cv.notify_all();
    }
}

impl Loaders {
    /// Start `n` threads. Answers go into `out` (the intake's input).
    /// `tip_out`: where the node's newest block is published (status).
    pub fn spawn(n: usize, node: Arc<dyn NodeApi>, out: SyncSender<Input>, requests: Arc<AtomicU64>, tip_out: Arc<AtomicU64>) -> Loaders {
        let q = Arc::new(Queue { m: Mutex::new((VecDeque::new(), VecDeque::new(), false)), cv: Condvar::new() });
        let tip = Arc::new(Tip { known: Mutex::new((0, None)), out: tip_out });
        for i in 0..n.max(1) {
            let (q, node, out, req, tip) = (q.clone(), node.clone(), out.clone(), requests.clone(), tip.clone());
            std::thread::Builder::new().name(format!("arbsim-copy2-load-{i}")).spawn(move || run(q, node, out, req, tip)).expect("loader thread");
        }
        Loaders { q }
    }

    pub fn send(&self, j: Job) {
        let bulk = matches!(j, Job::Fetch { bulk: true, .. });
        let mut g = self.q.m.lock().unwrap();
        if bulk {
            g.1.push_back(j);
        } else {
            g.0.push_back(j);
        }
        drop(g);
        self.q.cv.notify_one();
    }
}

/// The node's newest block, shared by the loader threads (asked at most
/// every 250 ms, only when a job wants a newer block than we know of).
struct Tip {
    known: Mutex<(u64, Option<Instant>)>,
    out: Arc<AtomicU64>,
}

impl Tip {
    /// Newest block the node has; asked again only if what we know is
    /// below `want` and older than `max_age`.
    fn get(&self, node: &dyn NodeApi, want: u64, requests: &AtomicU64, max_age: Duration) -> Result<u64, NodeErr> {
        let mut g = self.known.lock().unwrap();
        if g.0 >= want || g.1.is_some_and(|t| t.elapsed() < max_age) {
            return Ok(g.0);
        }
        requests.fetch_add(1, Ordering::Relaxed);
        // Ask the node that will serve the fetch (paid first).
        let r = node.call_batch_paid(Class::Fill, &[("eth_blockNumber", json!([]))])?;
        let t = match r.into_iter().next() {
            Some(Ok(Value::String(s))) => parse_u64(&s).map_err(NodeErr::BadResponse)?,
            Some(Err(e)) => return Err(NodeErr::BadResponse(format!("eth_blockNumber: {}", e.message))),
            _ => return Err(NodeErr::BadResponse("eth_blockNumber: no number".into())),
        };
        *g = (g.0.max(t), Some(Instant::now()));
        self.out.fetch_max(g.0, Ordering::Relaxed);
        Ok(g.0)
    }
}

fn run(q: Arc<Queue>, node: Arc<dyn NodeApi>, out: SyncSender<Input>, requests: Arc<AtomicU64>, tip: Arc<Tip>) {
    let fresh = Duration::from_millis(250);
    loop {
        let Some(job) = q.take() else { return }; // intake gone
        let done = match job {
            Job::Fetch { id, block, exact, items, calls, traces, .. } => {
                // Pick the block (see file header).
                let at = if exact {
                    let t0 = Instant::now();
                    loop {
                        match tip.get(&*node, block, &requests, fresh) {
                            Ok(t) if t >= block => break Ok(block),
                            Ok(_) if t0.elapsed() < Duration::from_secs(3) => std::thread::sleep(fresh),
                            Ok(t) => break Err(NodeErr::BadResponse(format!("node at block {t}, block {block} not there yet"))),
                            Err(e) => break Err(e),
                        }
                    }
                } else {
                    tip.get(&*node, block, &requests, fresh).map(|t| if t == 0 { block } else { block.min(t) })
                };
                match at {
                    Ok(b) => {
                        requests.fetch_add(count_calls(&items, &calls) + traces.len() as u64, Ordering::Relaxed);
                        Done::Fetch { id, block: b, res: fetch(&*node, b, &items, &calls, &traces) }
                    }
                    Err(e) => Done::Fetch { id, block, res: Err(e) },
                }
            }
            Job::Probe { id, coin, block } => {
                let res = tip.get(&*node, block, &requests, fresh).and_then(|t| {
                    requests.fetch_add(2, Ordering::Relaxed);
                    probe_layout(&*node, coin, if t == 0 { block } else { block.min(t) })
                });
                Done::Probe { id, coin, res }
            }
            Job::Tip { id } => {
                requests.fetch_add(2, Ordering::Relaxed);
                let res = crate::node::block_number(&*node, Class::Header).and_then(|t| {
                    {
                        let mut g = tip.known.lock().unwrap();
                        *g = (g.0.max(t), Some(Instant::now()));
                    }
                    tip.out.fetch_max(t, Ordering::Relaxed);
                    let bf = crate::node::get_header(&*node, Class::Header, t)?.map(|h| h.base_fee).unwrap_or(0);
                    Ok((t, bf))
                });
                Done::Tip { id, res }
            }
        };
        if out.send(Input::Done(done)).is_err() {
            return;
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

/// One batch at `block`: slots, account basics (3 calls each) and eth_calls.
pub fn fetch(node: &dyn NodeApi, block: u64, items: &[MissItem], calls: &[(Address, Bytes)], traces: &[(Address, Bytes)]) -> Result<FetchOut, NodeErr> {
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
    let trace_at = rpc.len();
    for (to, data) in traces {
        rpc.push((
            "debug_traceCall",
            json!([{ "to": to_hex(to.as_slice()), "data": to_hex(data) }, t, { "tracer": "prestateTracer" }]),
        ));
    }
    let res = if rpc.is_empty() { Vec::new() } else { node.call_batch_paid(Class::Fill, &rpc)? };
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
    let traces_out = res[trace_at..]
        .iter()
        .map(|r| match r {
            Ok(v @ Value::Object(_)) => Ok(v.clone()),
            Ok(_) => Err("node has no trace for that block yet".to_string()),
            Err(e) => Err(format!("node error: {}", e.message)),
        })
        .collect();
    let calls_out = res[call_at..trace_at]
        .iter()
        .map(|r| match r {
            Ok(Value::String(s)) => parse_bytes(s),
            Ok(_) => Err("node has no answer for that block yet".into()),
            Err(e) => Err(format!("node error: {}", e.message)),
        })
        .collect();
    Ok(FetchOut { items: out, calls: calls_out, traces: traces_out })
}

/// Word `w` of a call answer.
pub fn out_word(r: &Result<Bytes, String>, w: usize) -> Result<U256, String> {
    let b = r.as_ref().map_err(|e| e.clone())?;
    if b.len() < (w + 1) * 32 {
        return Err(format!("answer too short ({} bytes)", b.len()));
    }
    Ok(super::word(b, w))
}
