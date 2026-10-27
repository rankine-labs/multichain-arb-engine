// ============================================================================
// CHECKS (owner: workstream C) - run calls on a state view, eth_call style.
//
// Plain English:
//   This is the part that actually answers the bot's question "what would
//   happen if our contract ran this trade right now?". It takes:
//     - a read-only view of the chain (state/), which may say "I don't know
//       this item" (Missing),
//     - the block details (arb::BlockCtx),
//     - pretend-state for this one question (overrides: our contract's code
//       at a test address, a pretend token balance, ...),
//     - optionally some signed transactions to apply first (e.g. the trade
//       we are following, before it shows up in the feed),
//     - and the calls to run, in order.
//   It runs them on a scratch copy (nothing is ever written back) and returns
//   per call: did it succeed, what it returned (or the refusal data), and the
//   gas it used.
//
//   If ANY step needs something our copy of the chain doesn't have, the whole
//   answer is "unknown" plus the list of missing items. Never a guess.
//
// Files:
//   types (this file)   requests / answers shared by everything below
//   overrides.rs        geth-style pretend-state (code, balance, nonce, state, stateDiff)
//   db.rs               connects revm to our state view (+ overrides), detects misses
//   rawtx.rs            decodes signed transactions and recovers who sent them
//   run.rs              run_calls(): the main entry point
//   ordered.rs          trigger-first: feed transactions in sequence order
//                       (several blocks), then our calls, strictly watched
//   search.rs           size_search(): finds the most profitable trade size
//   proto_types.rs      socket request/answer shapes + handle_call/handle_size_search
//   fixture.rs, cli.rs  test files (fixtures) and the check-fixture/bench-fixture commands
// ============================================================================
use revm::primitives::{Address, Bytes, B256, U256};

use crate::state::MissItem;

pub mod cli;
pub mod db;
pub mod entry;
// Feed messages kept in the sidecar (sent once by the bot), speed-3.
pub mod feedstore;
pub mod fixture;
pub mod hexutil;
// Trigger-first: replay the feed's ordered transactions, then our calls.
pub mod moved;
pub mod ordered;
pub mod overrides;
pub mod proto_types;
pub mod rawtx;
pub mod run;
pub mod search;

pub use overrides::{AccountOverride, Overrides};
pub use run::{run_calls, run_calls_opts, BlockEnvMode, CheckOptions, Session};
pub use search::{size_search, SizeSearchAmounts, SizeSearchBest, SizeSearchResult, SizeTemplate, SizeTry};

/// Gas used for a call that doesn't say (same as geth's default eth_call cap).
pub const DEFAULT_CALL_GAS: u64 = 50_000_000;

/// One call to run, eth_call style.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CallReq {
    /// Who the call is "from" (geth default: the zero address).
    pub from: Address,
    /// Contract to call. None = contract creation (data = init code).
    pub to: Option<Address>,
    pub data: Bytes,
    /// Gas limit. None = DEFAULT_CALL_GAS.
    pub gas: Option<u64>,
    pub value: U256,
}

/// What one call did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CallOutcome {
    /// true = finished normally; false = reverted / halted / invalid.
    pub success: bool,
    /// Return data on success, revert data on revert, empty on a halt.
    pub output: Bytes,
    /// Gas used at transaction level: 21,000 base + calldata cost +
    /// execution, after refunds. This is EXECUTION gas only, and equals what
    /// a Nitro node's eth_simulateV1 reports (without a baseFeePerGas
    /// override, the bot's replay). It does NOT include Nitro's L1 data fee
    /// ("poster gas", receipt field gasUsedForL1): a mined tx's receipt /
    /// callTracer gasUsed, and eth_call / debug_traceCall gasUsed (which add
    /// an estimate), are higher by that amount. The bot's gas model adds the
    /// L1 fee separately. (Workstream B, sim/ARBITRUM_NOTES.md section 1.)
    pub gas_used: u64,
    /// Why it stopped abnormally (out of gas, invalid opcode, invalid tx...).
    /// None for success and for a normal revert.
    pub halt: Option<String>,
}

/// Why a check could not give a sure answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnknownReason {
    /// Our copy of the chain is missing something the check needed.
    Miss,
    /// The check touched an Arbitrum built-in contract we don't imitate.
    UnsupportedPrecompile,
    /// A signed transaction of a kind we can't replay (blob, 7702, Arbitrum system).
    UnsupportedTx,
    /// The request itself was malformed (bad hex, both state and stateDiff, ...).
    BadRequest,
    /// Anything else that went wrong inside the engine.
    Engine,
    /// Trigger-first (check/ordered.rs): the feed messages we were given
    /// don't reach back to the copy's block, or skip a message.
    FeedGap,
    /// Trigger-first: the order is not certain (trigger not where the feed
    /// says, seen twice, block / sequence numbers don't line up).
    FeedOrder,
    /// Trigger-first: a feed message in the range holds something we can't
    /// replay (deposit, retryable, a transaction the bot couldn't unpack).
    FeedUnreplayable,
    /// Trigger-first: a replayed transaction looked at something we only
    /// pretended or can't know exactly (an unknown sender's balance / code,
    /// BASEFEE, COINBASE, a sender's balance after fees we didn't charge).
    ReplayWatch,
    /// Trigger-first: our check's pretend-state (the test contract's
    /// funding) overlaps what the replayed transactions read, so it could
    /// have changed how they ran.
    FundingOverlap,
    /// Trigger-first: a replayed transaction (or our call, in strict mode)
    /// read or wrote a value copy 2 holds but does NOT follow exactly at the
    /// snapshot's block (a fill re-read only every minute, possibly placed
    /// at an older version): replaying the feed on top of it could apply a
    /// change twice, or miss one.
    StaleFill,
    /// Trigger-first, best effort: a replayed transaction read a value of
    /// its own sender that we only ASSUMED was enough (its coin balance or
    /// allowance) and then failed with a "not enough funds / bad
    /// signature / bad nonce" error: our guess may be what failed it.
    SenderFunds,
    /// Fast lane (fastlane/c2runner.rs): copy 2 declined to vouch for the
    /// answer (V4 PoolManager balance / protocol fee runs differ, a pool on
    /// the route may still miss reports, a pool not ready). `detail` holds
    /// the sidecar's own short reason ("pool_manager_balance", ...).
    Copy2Unsure,
}

impl UnknownReason {
    /// Wire name used in socket answers (`"unknown": "<this>"`).
    pub fn as_str(self) -> &'static str {
        match self {
            UnknownReason::Miss => "miss",
            UnknownReason::UnsupportedPrecompile => "unsupported_precompile",
            UnknownReason::UnsupportedTx => "unsupported_tx",
            UnknownReason::BadRequest => "bad_request",
            UnknownReason::Engine => "engine_error",
            UnknownReason::FeedGap => "feed_gap",
            UnknownReason::FeedOrder => "feed_order",
            UnknownReason::FeedUnreplayable => "feed_unreplayable",
            UnknownReason::ReplayWatch => "replay_watch",
            UnknownReason::FundingOverlap => "funding_overlap",
            UnknownReason::StaleFill => "stale_fill",
            UnknownReason::SenderFunds => "sender_funds_revert",
            UnknownReason::Copy2Unsure => "copy2_unsure",
        }
    }
}

/// "Can't answer for sure": why, and (for misses) exactly what to fetch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckUnknown {
    pub reason: UnknownReason,
    /// Items our state didn't have (fetch these, then ask again).
    pub missing: Vec<MissItem>,
    /// Short human-readable detail for logs.
    pub detail: String,
    /// (Oct 25) For misses: the recorded inputs of the hashes that name the
    /// missing slots, (hash, first word, second word); see
    /// check/moved.rs resolve_v4_slot. Lets copy 2 tell WHOSE PoolManager
    /// value was missing (our pool beyond its walk / a pool we don't follow).
    /// Empty when nothing was recorded.
    pub pre: Vec<(revm::primitives::U256, revm::primitives::U256, revm::primitives::U256)>,
    /// (Oct 26, auto-follow rebuild) For misses: the full KEY of each V4
    /// pool named by `pre`, when the run computed it: (pool id, the 5 key
    /// words currency0, currency1, fee, tickSpacing, hooks). The PoolManager
    /// computes id = keccak(key) at the start of every swap / liquidity
    /// change, and the run writes that hash's input down (check/ordered.rs
    /// Watch, 160-byte hashes). Lets copy 2 hand the bot a pool's key with
    /// no node request (copy2/v4blind.rs). Empty when nothing was recorded.
    pub keys: Vec<(revm::primitives::U256, [revm::primitives::U256; 5])>,
    /// (Oct 27, prediction coverage) Trigger-first: WHICH replayed feed
    /// transaction the answer got stuck on (None = our own calls, or not a
    /// trigger-first check). Lets the bot's status and `arbsim trig-replay`
    /// tell "the trigger itself" from "a transaction replayed only because
    /// copy 2 is behind the feed".
    pub at: Option<TxAt>,
}

/// Trigger-first: one replayed feed transaction, as named in an "unknown"
/// answer (CheckUnknown.at).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TxAt {
    /// Its feed message (= block on Nitro).
    pub seq: u64,
    pub hash: B256,
    /// Its target contract (None: a contract creation, or a transaction we
    /// couldn't unpack at all).
    pub to: Option<Address>,
    /// Its sender (None: couldn't unpack it).
    pub from: Option<Address>,
    /// Its type byte (0 legacy, 1, 2, 4 = EIP-7702; None: couldn't unpack).
    pub tx_type: Option<u8>,
    /// It is the trigger itself.
    pub trigger: bool,
}

impl TxAt {
    /// As the answers carry it.
    pub fn json(&self) -> serde_json::Value {
        serde_json::json!({
            "seq": self.seq, "hash": format!("{:#x}", self.hash), "to": self.to.map(|a| format!("{a:#x}")),
            "from": self.from.map(|a| format!("{a:#x}")), "type": self.tx_type, "trigger": self.trigger,
        })
    }
}

impl CheckUnknown {
    pub fn new(reason: UnknownReason, detail: impl Into<String>) -> Self {
        CheckUnknown { reason, missing: Vec::new(), detail: detail.into(), pre: Vec::new(), keys: Vec::new(), at: None }
    }
    pub fn bad_request(detail: impl Into<String>) -> Self {
        Self::new(UnknownReason::BadRequest, detail)
    }
}

impl std::fmt::Display for CheckUnknown {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {} ({} missing)", self.reason.as_str(), self.detail, self.missing.len())
    }
}
