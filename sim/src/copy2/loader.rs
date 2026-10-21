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
//   Node choice: the PAID node first (call_batch_paid), the free public node
//   only if the paid one refuses (daily allowance used up) or fails. The
//   daily allowance and speed limit of node.rs apply as always.
//   Several loader threads run side by side [ARBSIM_COPY2_LOADERS, 4].
// ============================================================================
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender, SyncSender};
use std::sync::{Arc, Mutex};

use revm::primitives::{Address, Bytes, U256};
use serde_json::{json, Value};

use super::coins::{probe_layout, BalanceLayout};
use super::intake::Input;
use crate::check::hexutil::{parse_bytes, parse_u256, parse_u64, to_hex};
use crate::node::{tag, CallResult, Class, Fetched, FetchedAccount, ItemErr, NodeApi, NodeErr};
use crate::state::MissItem;

/// A question for the node.
pub enum Job {
    Fetch { id: u64, block: u64, items: Vec<MissItem>, calls: Vec<(Address, Bytes)> },
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
    Probe { id: u64, coin: Address, res: Result<Option<BalanceLayout>, NodeErr> },
    Tip { id: u64, res: Result<(u64, u64), NodeErr> },
}

/// Handle to the loader threads.
pub struct Loaders {
    tx: Sender<Job>,
}

impl Loaders {
    /// Start `n` threads. Answers go into `out` (the intake's input).
    pub fn spawn(n: usize, node: Arc<dyn NodeApi>, out: SyncSender<Input>, requests: Arc<AtomicU64>) -> Loaders {
        let (tx, rx) = channel::<Job>();
        let rx = Arc::new(Mutex::new(rx));
        for i in 0..n.max(1) {
            let (rx, node, out, req) = (rx.clone(), node.clone(), out.clone(), requests.clone());
            std::thread::Builder::new().name(format!("arbsim-copy2-load-{i}")).spawn(move || run(rx, node, out, req)).expect("loader thread");
        }
        Loaders { tx }
    }

    pub fn send(&self, j: Job) {
        let _ = self.tx.send(j);
    }
}

fn run(rx: Arc<Mutex<Receiver<Job>>>, node: Arc<dyn NodeApi>, out: SyncSender<Input>, requests: Arc<AtomicU64>) {
    loop {
        let job = match rx.lock().unwrap().recv() {
            Ok(j) => j,
            Err(_) => return, // intake gone
        };
        let done = match job {
            Job::Fetch { id, block, items, calls } => {
                let n = count_calls(&items, &calls);
                requests.fetch_add(n, Ordering::Relaxed);
                Done::Fetch { id, block, res: fetch(&*node, block, &items, &calls) }
            }
            Job::Probe { id, coin, block } => {
                requests.fetch_add(2, Ordering::Relaxed);
                Done::Probe { id, coin, res: probe_layout(&*node, coin, block) }
            }
            Job::Tip { id } => {
                requests.fetch_add(2, Ordering::Relaxed);
                let res = crate::node::block_number(&*node, Class::Header).and_then(|t| {
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
pub fn fetch(node: &dyn NodeApi, block: u64, items: &[MissItem], calls: &[(Address, Bytes)]) -> Result<FetchOut, NodeErr> {
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
