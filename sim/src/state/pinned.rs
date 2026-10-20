// ============================================================================
// PINNED VIEWS: an exact copy of ONE past block, for the comparison harness.
//
// Plain English:
//   The harness (workstream D) asks "what would this check have answered at
//   confirmed block N?" and compares it with the node's own answer. Such a
//   view is built separately from the live copy (never mixed with it):
//     - it starts empty and is filled from the node at exactly block N
//       (eth_getStorageAt / getCode / getBalance / getTransactionCount),
//     - a pinned check WAITS for those fills instead of answering "miss":
//       run, collect what's missing, fetch it at N, run again - up to
//       ARBSIM_PIN_ROUNDS rounds within ARBSIM_PIN_TIMEOUT_MS,
//     - the last few pinned blocks (ARBSIM_PIN_CACHE, default 3) are kept,
//       so many checks on the same block only fetch each item once,
//     - every node request counts against the same daily allowance
//       (class "pinned", which may use up to 90% of it).
//
//   Block details:
//     env "same" = block N's own header (like eth_call at N)
//     env "next" = the block after N (like eth_simulateV1 on N): L2 block
//                  N+1; parent-chain block number = block N+1's header value
//                  when the node has it, else N's; timestamp N+1's header if
//                  known, else N's (the request's "blockOverrides" time /
//                  gasLimit / number are applied on top by the check engine).
// ============================================================================
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::snap::{Fact, Snapshot, Volatile};
use super::{MissItem, StatePosition};
use crate::arb::{self, BlockCtx, HeaderInfo};
use crate::node::{self, Class, Header, NodeApi, NodeErr};

/// One cached past block.
struct PinnedBlock {
    block: u64,
    snap: Arc<Snapshot>,
    header: Header,
    next_header: Option<Header>,
}

/// The cache of pinned blocks (LRU).
pub struct PinnedCache {
    blocks: Mutex<VecDeque<Arc<Mutex<PinnedBlock>>>>,
    cap: usize,
}

/// A pinned view ready for a check.
pub struct PinnedView {
    pub snap: Arc<Snapshot>,
    pub ctx: BlockCtx,
}

/// Block details of block `h` (env "same").
pub fn header_ctx(h: &Header) -> BlockCtx {
    let info = HeaderInfo::from_mix_hash(h.mix_hash);
    BlockCtx {
        l1_block_number: info.l1_block_number,
        l2_block_number: Some(h.number),
        timestamp: h.timestamp,
        basefee: h.base_fee,
        coinbase: h.miner,
        gas_limit: if h.gas_limit > 0 { h.gas_limit } else { arb::NITRO_BLOCK_GAS_LIMIT },
        prevrandao: arb::NITRO_PREVRANDAO,
    }
}

/// Block details for "the block after `h`" (env "next").
pub fn next_ctx(h: &Header, next: Option<&Header>) -> BlockCtx {
    let mut c = header_ctx(h);
    c.l2_block_number = Some(h.number + 1);
    if let Some(n) = next {
        let ni = HeaderInfo::from_mix_hash(n.mix_hash);
        c.l1_block_number = ni.l1_block_number.max(c.l1_block_number);
        c.timestamp = n.timestamp.max(c.timestamp);
        c.basefee = n.base_fee;
    }
    c
}

impl PinnedCache {
    pub fn new(cap: usize) -> Self {
        PinnedCache { blocks: Mutex::new(VecDeque::new()), cap: cap.max(1) }
    }

    /// Get (or create, fetching the headers) the cached block N.
    fn get(&self, node: &dyn NodeApi, block: u64) -> Result<Arc<Mutex<PinnedBlock>>, String> {
        {
            let mut g = self.blocks.lock().unwrap();
            if let Some(i) = g.iter().position(|b| b.lock().unwrap().block == block) {
                // Move to the back (most recently used).
                let b = g.remove(i).unwrap();
                g.push_back(b.clone());
                return Ok(b);
            }
        }
        let header = match node::get_header(node, Class::Pinned, block) {
            Ok(Some(h)) => h,
            Ok(None) => return Err(format!("node doesn't have block {block}")),
            Err(e) => return Err(e.to_string()),
        };
        // Block N+1's header (for env "next"); fine if not there yet.
        let next_header = node::get_header(node, Class::Pinned, block + 1).ok().flatten();
        let snap = Snapshot {
            pos: StatePosition { base_block: block, after_seq: None },
            // Nothing is volatile in a pinned view: every value is exact at N.
            volatile: Arc::new(Volatile::default()),
            ..Default::default()
        };
        let b = Arc::new(Mutex::new(PinnedBlock { block, snap: Arc::new(snap), header, next_header }));
        let mut g = self.blocks.lock().unwrap();
        g.push_back(b.clone());
        while g.len() > self.cap {
            g.pop_front();
        }
        Ok(b)
    }

    /// Run `check` on a pinned view of block N, fetching missing items at N
    /// between rounds. `check` returns Ok(answer) when sure, Err(missing
    /// items) when it needs more. Returns the final answer or why not.
    pub fn run<T>(
        &self,
        node: &dyn NodeApi,
        block: u64,
        next_env: bool,
        rounds: usize,
        timeout: Duration,
        mut check: impl FnMut(&PinnedView) -> Result<T, Vec<MissItem>>,
        mut on_round: impl FnMut(),
    ) -> Result<T, PinnedErr> {
        let t0 = Instant::now();
        let pb = self.get(node, block).map_err(PinnedErr::NotReady)?;
        let mut last_missing = Vec::new();
        for _ in 0..rounds.max(1) {
            let view = {
                let g = pb.lock().unwrap();
                PinnedView {
                    snap: g.snap.clone(),
                    ctx: if next_env { next_ctx(&g.header, g.next_header.as_ref()) } else { header_ctx(&g.header) },
                }
            };
            let missing = match check(&view) {
                Ok(v) => return Ok(v),
                Err(m) => m,
            };
            // Code-by-hash can't be fetched; its account fetch covers it.
            let missing: Vec<MissItem> = missing.into_iter().filter(|m| !matches!(m, MissItem::Code(_))).collect();
            if missing.is_empty() || t0.elapsed() > timeout {
                return Err(PinnedErr::Miss(if missing.is_empty() { last_missing } else { missing }));
            }
            on_round();
            let r = super::updater::fetch_facts(node, Class::Pinned, block, &missing);
            let (facts, unavailable, failed) = match r {
                Ok(x) => x,
                Err(NodeErr::Budget(e)) => return Err(PinnedErr::NotReady(format!("node budget: {e}"))),
                Err(e) => return Err(PinnedErr::NotReady(e.to_string())),
            };
            if facts.is_empty() {
                return Err(PinnedErr::NotReady(format!(
                    "node gave no values at block {block} ({unavailable} unavailable, {failed} refused; it may not keep state that old)"
                )));
            }
            let mut g = pb.lock().unwrap();
            let mut s = (*g.snap).clone();
            for f in &facts {
                s.apply_fact(f);
            }
            g.snap = Arc::new(s);
            last_missing = missing;
        }
        Err(PinnedErr::Miss(last_missing))
    }

    /// Pre-load items into a pinned block (for tests and warm requests).
    pub fn learn(&self, node: &dyn NodeApi, block: u64, facts: &[Fact]) -> Result<(), String> {
        let pb = self.get(node, block)?;
        let mut g = pb.lock().unwrap();
        let mut s = (*g.snap).clone();
        for f in facts {
            s.apply_fact(f);
        }
        g.snap = Arc::new(s);
        Ok(())
    }

    /// Cached blocks (for status).
    pub fn cached(&self) -> Vec<u64> {
        self.blocks.lock().unwrap().iter().map(|b| b.lock().unwrap().block).collect()
    }
}

/// Why a pinned check couldn't finish.
#[derive(Debug)]
pub enum PinnedErr {
    /// Still missing these after all rounds / the timeout.
    Miss(Vec<MissItem>),
    /// The node can't help (block unknown, budget, errors).
    NotReady(String),
}

/// Parse the `pinned` block of an `at`: "0xN" or a number.
pub fn parse_block(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => crate::check::hexutil::parse_u64(s).ok(),
        _ => None,
    }
}
