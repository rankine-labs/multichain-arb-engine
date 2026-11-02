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

// What a check reads from copy 2 (far zero tick-map words, PoolManager
// balances by a proven lower bound + a confirming second run).
pub mod checkcore;
pub mod checkview;
// Where coins keep balances; coin Transfer -> pool balances (workstream A).
pub mod coins;
// V2 / Solidly: write the numbers the events state (workstream A).
pub mod fields;
// The thread that applies each block's events and publishes versions (A).
pub mod intake;
// Why copy 2 trails the feed: feed -> report -> queue -> publish times (status copy2Lag).
pub mod lag;
// FAST LANE A: the predicted copy (copy 2 + the feed messages after it).
// Runs only with FASTLANE=practice|live.
pub mod ahead;
// Capture of what the predicted copy saw + offline replay (`arbsim
// ahead-replay`). Only with FASTLANE on and FASTLANE_CAPTURE_FILE set.
pub mod ahead_capture;
// FAST LANE A: the hot-contract keeper (Oct 31): other bots' / routers'
// values the predicted copy needs, kept exact from the node's block diffs.
pub mod keeper;
// ...and its offline replay on recorded block diffs (`ahead-replay --keeper`).
pub mod keeper_replay;
// Background threads that ask the node for copy 2 (never the intake thread).
pub mod loader;
// Working copy the events are applied to (workstream A; B runs revm on it).
pub mod overlay;
// Warm restart: the copy saved to a file and read back at start.
pub mod persist;
// (Nov 2) `arbsim copy2-replay-check`: the replay run on recorded chain
// state, event by event (proof for new pool kinds).
pub mod replay_check;
// Replay of V3 / PancakeV3 / Algebra / V4 events (workstream B; placeholder
// answering Unsure until B's file replaces it).
pub mod replay;
// Tick walk: all the tick data a ready V3-style pool needs (one trace each).
pub mod walk;
// Whose PoolManager value a check missed; far ticks of our V4 pools kept;
// V4 pools checks keep running into listed for auto-follow (Oct 25).
pub mod v4blind;
pub mod warm;

/// Which kind of pool (decides how its events are applied).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
pub enum PoolKind {
    /// Uniswap V2 copy (Sync / Transfer / Mint / Burn / Swap).
    #[default]
    V2,
    /// Solidly / Velodrome V2 (Sync / Fees / Claim / Transfer).
    Solidly,
    /// Uniswap V3 layout (slot0 at 0).
    V3,
    /// PancakeSwap V3 layout (storage shifted by one slot vs Uniswap V3).
    PancakeV3,
    /// Algebra Integral (+ plugin: its beforeSwap must be replayed too).
    Algebra,
    /// Uniswap V4 inside the PoolManager. Hook-free, or (Nov 2, flag
    /// ARBSIM_COPY2_FOLLOW_HOOKED_V4) with a hook (`TrackedPool::hooks`):
    /// the hook's own code then runs in every replay and check, and its
    /// storage is followed as a WATCHED account (see `TrackedPool::watch`).
    V4,
    /// (Nov 2) Velodrome Slipstream copies (UP CL, Raphael; flags
    /// ARBSIM_COPY2_FOLLOW_UPCL / ARBSIM_COPY2_FOLLOW_RAPHAEL): Uniswap V3
    /// events and callbacks, but a different storage layout (slot0 is not
    /// slot 0), the fee asked from the factory's fee modules on every swap,
    /// and a "gauge" that stakes liquidity in the pool WITHOUT a pool event.
    /// Replayed like V3 with the pool's own code (the factory and fee
    /// modules are watched accounts, the gauge reloads the pool).
    Slipstream,
}

/// One pool we follow.
#[derive(Clone, Debug, Default)]
pub struct TrackedPool {
    /// Pool contract address; for V4 the PoolManager address.
    pub address: Address,
    /// V4 only: the 32-byte pool id. None for contract pools.
    pub v4_id: Option<B256>,
    pub kind: PoolKind,
    pub token0: Address,
    pub token1: Address,
    /// V4 key details (fee in pips, tick spacing); 0 for other kinds.
    /// (A hooked V4 pool may have the dynamic-fee flag 0x800000 here.)
    pub fee: u32,
    pub tick_spacing: i32,
    /// (Nov 2) V4 only: the pool key's hook contract (zero = no hook).
    pub hooks: Address,
    /// (Nov 2) WATCHED accounts: outside contracts every swap of this pool
    /// READS but never writes (a V4 hook, a Slipstream factory and its fee
    /// modules). Their values are held exact the same way for every pool
    /// that watches them: any event of a watched account makes its held
    /// values "pending" (checks touching it answer unknown) until they are
    /// read again from the node at that block (changed ones replaced). The
    /// bot subscribes to all their events. Empty for the older kinds.
    pub watch: Vec<Address>,
    /// (Nov 2) Accounts whose events change THIS POOL's storage without a
    /// pool event (a Slipstream gauge staking liquidity): any of their
    /// events makes the pool unsure from that block (it reloads).
    pub reload_on: Vec<Address>,
}

impl TrackedPool {
    /// A V4 pool with a hook (followed only with ARBSIM_COPY2_FOLLOW_HOOKED_V4).
    pub fn is_hooked_v4(&self) -> bool {
        self.kind == PoolKind::V4 && self.hooks != Address::ZERO
    }
    /// Kinds added on Nov 2 (hooked V4, Slipstream): never saved to the
    /// warm-restart file (copy2/persist.rs keeps its format; they simply
    /// load normally after a restart).
    pub fn is_new_kind(&self) -> bool {
        self.kind == PoolKind::Slipstream || self.is_hooked_v4()
    }
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
