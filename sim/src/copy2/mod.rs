// ============================================================================
// COPY 2: our pools' copy, kept current from the pools' OWN EVENTS
// (design 2, see sim/COPY2_PLAN.md).
//
// Plain English:
//   Copy 1 replayed every transaction on the chain to stay current; that
//   needed ~2 million node reads a day and failed (go/no-go #2). Copy 2 only
//   follows the pools we trade: the bot hands us each block's swap / mint /
//   burn / sync / transfer reports ("logs") for those pools, and we apply
//   them to our copy:
//     - V2 / Solidly pools: write the numbers the events state (exact,
//       proven offline: 0 node reads)
//     - V3 / PancakeSwap V3 / Algebra / Uniswap V4 (no hook): re-run the
//       same action with the pool's own code on our copy ("replay"; exact,
//       proven offline on 21,618 checks)
//   Anything we can't apply exactly marks that ONE pool "unsure"; checks
//   touching it answer "unknown" and the bot asks the node, as today.
//
//   This file holds the shared shapes between the event intake (copy2/intake.rs,
//   workstream A) and the replayers (copy2/replay.rs, workstream B).
//   Keep these names stable; extend, don't change.
// ============================================================================
use revm::primitives::{Address, Bytes, B256, U256};

use crate::state::MissItem;

// V2 / Solidly: write the numbers the events state (workstream A).
pub mod fields;
// Working copy the events are applied to (workstream A; B runs revm on it).
pub mod overlay;
// Replay of V3 / PancakeV3 / Algebra / V4 events (workstream B; placeholder
// answering Unsure until B's file replaces it).
pub mod replay;

/// Which kind of pool (decides how its events are applied).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PoolKind {
    /// Uniswap V2 copy (Sync / Transfer / Mint / Burn / Swap).
    V2,
    /// Solidly / Velodrome V2 (Sync / Fees / Claim / Transfer).
    Solidly,
    /// Uniswap V3 layout (slot0 at 0).
    V3,
    /// PancakeSwap V3 layout (storage shifted by one slot vs Uniswap V3).
    PancakeV3,
    /// Algebra Integral (+ plugin: its beforeSwap must be replayed too).
    Algebra,
    /// Uniswap V4, hook-free, inside the PoolManager.
    V4,
}

/// One pool we follow.
#[derive(Clone, Debug)]
pub struct TrackedPool {
    /// Pool contract address; for V4 the PoolManager address.
    pub address: Address,
    /// V4 only: the 32-byte pool id. None for contract pools.
    pub v4_id: Option<B256>,
    pub kind: PoolKind,
    pub token0: Address,
    pub token1: Address,
    /// V4 key details (fee in pips, tick spacing); 0 for other kinds.
    pub fee: u32,
    pub tick_spacing: i32,
}

/// One raw event, as the node reported it.
#[derive(Clone, Debug)]
pub struct PoolLog {
    pub address: Address,
    pub topics: Vec<B256>,
    pub data: Bytes,
    pub block: u64,
    pub tx_index: u32,
    pub log_index: u32,
    pub tx_hash: B256,
    /// Reorg: the node took this event back.
    pub removed: bool,
}

/// The block the events belong to (what the pool code sees when replayed).
#[derive(Clone, Copy, Debug)]
pub struct BlockCtx {
    pub number: u64,
    pub timestamp: u64,
    /// Parent-chain (L1) block number, as Nitro's NUMBER opcode returns it.
    pub l1_number: u64,
}

/// What applying one event did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApplyResult {
    /// Applied exactly; the copy is current for this pool.
    Applied,
    /// Needs these items first (fetch at the copy's block, then retry).
    NeedItems(Vec<MissItem>),
    /// Can't be applied exactly (unknown event, replay mismatch with the
    /// event's own numbers, ...). The pool becomes UNSURE until reloaded.
    Unsure(String),
}

/// A U256 helper for event words (kept here so both sides decode the same way).
pub fn word(data: &[u8], i: usize) -> U256 {
    let s = i * 32;
    if data.len() < s + 32 { return U256::ZERO; }
    U256::from_be_slice(&data[s..s + 32])
}
