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
//   sizing.rs           calc_size(): the best size on the replayed feed (entry point)
//   proto_types.rs      socket request/answer shapes + handle_call/handle_size_search
//   fixture.rs, cli.rs  test files (fixtures) and the check-fixture/bench-fixture commands
// ============================================================================
use revm::primitives::{Address, Bytes, U256};

use crate::state::MissItem;

pub mod cli;
pub mod db;
pub mod entry;
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
// Calculated trade size on the replayed feed (trigger-first entry point).
pub mod sizing;

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
}

impl CheckUnknown {
    pub fn new(reason: UnknownReason, detail: impl Into<String>) -> Self {
        CheckUnknown { reason, missing: Vec::new(), detail: detail.into() }
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
