// ============================================================================
// TRIGGER-FIRST CHECKS: the feed's transactions in sequence order, then ours.
//
// Plain English (live Oct 23: all 7 real trades lost; each chance was real,
// but rivals land at the top of block N+1 while we landed N+2..N+11, because
// every path waited for the trade we follow to show up in a block first):
//
//   The moment the sequencer feed shows the trade we follow ("the trigger"),
//   the bot already holds its signed bytes. This file answers "what would
//   OUR exact trade do right after it?" WITHOUT waiting for any block:
//
//     1. Start from one published version of copy 2 (an immutable snapshot:
//        reports that arrive while we work can't change it). Copy 2's
//        version for block N holds every transaction the sequencer put in
//        feed messages up to N (one feed message = one block on Nitro).
//     2. Re-run, in sequence order, every feed transaction sequenced AFTER
//        that snapshot: the ones before the trigger, the trigger itself
//        (exactly once, only if the snapshot doesn't hold it already), and
//        the ones after it that we have already seen (our trade will be
//        sequenced after them). Each message runs with its own block
//        details (block number, time, parent-chain block).
//     3. Then run our calls (the test contract's trade) on top.
//   All of it happens in one scratch pad on top of the snapshot; nothing is
//   ever written back into copy 2.
//
//   STRICT, like everything in copy 2: any doubt = "unknown" (the bot then
//   uses its old, waiting path):
//     - a value our copy doesn't hold (any account, slot or code, anywhere:
//       routers, coins, other pools, PoolManager, hooks, lenders) = miss
//     - the messages don't reach back to the snapshot, or skip one
//       (feed_gap); the trigger isn't where the feed says it is, or shows up
//       twice (feed_order); a message holds something we can't replay
//       (feed_unreplayable, e.g. a deposit)
//     - a replayed transaction's SENDER is usually a wallet our copy doesn't
//       know. The sequencer accepted the transaction, so its nonce and
//       balance were fine: we pretend them (no code) for the run, and WATCH:
//       if anything reads that wallet's ETH balance, its code, or calls it,
//       the answer is unknown (replay_watch). Gas fees are not charged
//       (gas price 0, like every check), so ANY replayed sender's ETH
//       balance is not exact afterwards: reading it = unknown too. So is a
//       replayed transaction reading BASEFEE / GASPRICE / COINBASE (we don't
//       know the block's real values).
//     - our check's pretend-state ("overrides": the test contract's code and
//       its funding) must never change how the replayed transactions run.
//       Every account / slot they read is written down; if one of them is
//       overridden, the answer is unknown (funding_overlap). Otherwise the
//       overrides provably made no difference to them.
//
//     - PROVENANCE (stale_fill). Copy 2 follows some values exactly from the
//       pools' own reports (our pools' storage, their coin balances, the V4
//       PoolManager's pool data); everything else it holds is a "fill":
//       read from the node at SOME block, re-read about once a minute, and
//       possibly put into an older version than the one it was read at
//       (intake.rs place_block). Replaying feed transactions on top of such
//       a value could apply a change twice (the fill already holds it) or
//       miss one. So every value a replayed transaction reads or writes
//       must be EXACT at the snapshot's block (a `Provenance` says which),
//       and any ETH balance it reads or spends from too; otherwise the
//       answer is unknown (stale_fill) under the strict rules. Our own calls
//       follow the same rule when `strict_call`; `strict_call = false` gives
//       them the trust every other copy-2 check already has. Best effort
//       (below, the default since Oct 23) uses such values instead, labelled
//       recent_fill / call_fill (see server.rs ARBSIM_TRIG_CALL_TRUST).
//
//   Known limits (said out loud, measured in shadow mode):
//     - Nitro also charges an L1 "poster" part of each transaction's gas
//       limit before it runs. We run a replayed transaction with its whole
//       gas limit, so one that ran OUT OF GAS on the chain only because of
//       that part would succeed here. Senders set limits with a margin, so
//       this is rare; the contract's on-chain profit floor is the safety net.
//     - Values copy 2 holds but doesn't follow (fills of routers, coins'
//       other balances) carry copy 2's usual trust: re-read every
//       ARBSIM_COPY2_VERIFY_S. Same trust as every copy-2 check.
//   The answer proves profit against this simulated state only; the
//   contract's own min-profit check on chain stays the safety net.
//
//   BEST EFFORT (Oct 23, owner: "we don't need perfect knowledge of every
//   transaction; we need sufficiently accurate predictions, fast"). A wrong
//   prediction costs only gas (the contract reverts a trade that doesn't
//   make its minimum on chain); a late perfect answer earns nothing. So
//   instead of "unknown", a check may make a few NAMED assumptions, written
//   into the answer (`Assumed`), each one measured later in shadow:
//
//     sender_funds   values that belong to a replayed transaction's own
//                    SENDER (its ETH balance / nonce / code, its coin
//                    balances and allowances, Permit2 allowances it holds)
//                    are assumed to be enough: the sequencer accepted the
//                    transaction. How we know a value is the sender's: the
//                    storage place was computed (KECCAK256) from bytes that
//                    contain the sender's address (or from such a place:
//                    allowance[sender][spender], Permit2's
//                    allowance[sender][coin][spender]), up to 4 places
//                    further (struct fields). A missing one is given
//                    ASSUMED_FUNDS (a very large amount, "never expires",
//                    nonce 0). Everything that decides what the trade does
//                    to the POOLS stays exact: amounts and limits in its
//                    data, pool state, router / pool / hook code. A trade
//                    that reverts on its own slippage limit is still a
//                    computed revert. But one that reverts with a "not enough
//                    funds / allowance / bad nonce / bad signature" error
//                    after reading an assumed value = unknown
//                    (sender_funds_revert): our guess may be the cause.
//     recent_fill    a replayed transaction read a value copy 2 holds only as
//                    a fill (re-read about once a minute), see PROVENANCE.
//     call_fill      OUR trade read such a value (the same trust every other
//                    copy-2 check has).
//     skipped_unrelated:N / skipped_related:N
//                    SKIPPING. Only transactions that touch our route's
//                    state must be replayed. A feed transaction (never the
//                    trigger) that needs a value we don't hold (and not one
//                    of its sender's) is judged like this, in this order:
//                      1. it read or wrote our route's state (our route's
//                         pool contracts, our V4 pools' data in the
//                         PoolManager, our pools' coin balances) BEFORE the
//                         missing value: unknown (we can't run it, and it
//                         matters);
//                      2. its `to` or data names one of our route's pools,
//                         one of our V4 pool ids, or BOTH coins of one of our
//                         pools: it MAY touch our route: skipped, counted as
//                         skipped_related (LOW confidence);
//                      3. otherwise: skipped, counted as skipped_unrelated.
//                    "Skipped" = the whole run starts again without it (a
//                    run is a fraction of a millisecond), so nothing it did
//                    with a guessed value stays.
//
//   Confidence of an answer: high = no assumption; medium = only
//   sender_funds / recent_fill / call_fill / skipped_unrelated; low = a
//   skipped transaction that might matter (skipped_related). The bot decides
//   which levels may send (TRIG_FIRST_MIN_CONFIDENCE, default medium).
//   With no assumptions allowed (`Assume::default()`, the strict setting),
//   every rule above is the old strict "unknown".
//
//   Still "unknown" (we truly can't run it): unsupported transaction kinds,
//   messages we can't unpack, sequence gaps / a copy too far behind, missing
//   code / state of our route or of the trigger's own path (other than its
//   sender's funds), GASPRICE / BASEFEE / COINBASE reads, engine errors.
// ============================================================================
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use revm::context::TxEnv;
use revm::context_interface::result::{EVMError, ExecutionResult, Output};
use revm::context_interface::transaction::{AccessList, AccessListItem};
use revm::inspector::Inspector;
use revm::interpreter::interpreter::EthInterpreter;
use revm::interpreter::interpreter_types::{InputsTr, Jumps, MemoryTr};
use revm::interpreter::{CallInputs, CallOutcome as FrameOutcome, Interpreter};
use revm::primitives::{keccak256, Address, Bytes, TxKind, B256, KECCAK_EMPTY, U256};
use revm::state::AccountInfo;
use revm::InspectEvm;
use serde::Deserialize;

use super::db::CheckDb;
use super::hexutil::parse_bytes;
use super::overrides::Overrides;
use super::rawtx::{decode_signed_tx, DecodedTx, UNSUPPORTED_TX_PREFIX};
use super::run::{db_unknown, default_arbsys_gas};
use super::{CallOutcome, CallReq, CheckUnknown, UnknownReason, DEFAULT_CALL_GAS};
use crate::arb::{self, evm::build_evm_with_inspector, evm::ArbEvm, ArbConfig, BlockCtx};
use crate::state::{Lookup, MissItem, StateRead};

/// Most feed messages one check may replay (about 13 s of blocks): a copy
/// further behind than that answers "feed_gap" (the old path decides).
pub const MAX_PLAN_MSGS: usize = 128;
/// Most transactions one check may replay.
pub const MAX_PLAN_TXS: usize = 1024;

// ---------------------------------------------------------------------------
// The plan: which messages, in which order, with which block details.
// ---------------------------------------------------------------------------

/// One feed message to replay (= one block on Nitro).
#[derive(Clone, Debug)]
pub struct PlanMsg {
    pub seq: u64,
    /// The block details its transactions see.
    pub ctx: BlockCtx,
    /// Its transactions, in the order the sequencer put them.
    pub txs: Vec<DecodedTx>,
}

/// Everything to replay before our calls, plus the block our calls run in.
#[derive(Clone, Debug)]
pub struct OrderedPlan {
    pub msgs: Vec<PlanMsg>,
    /// The trigger's hash (never skipped, see BEST EFFORT).
    pub trigger: B256,
    /// Our calls' block details: those of the last message replayed (or the
    /// snapshot's own, if none), the same convention as every copy-2 check
    /// ("state after block X, run in block X's details").
    pub call_ctx: BlockCtx,
}

/// What the plan says about the trigger and the snapshot (for the answer
/// and the bot's log).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanInfo {
    /// The trigger's hash.
    pub trigger: B256,
    /// Sequence number / block of the snapshot.
    pub snap_seq: u64,
    pub snap_block: u64,
    /// The snapshot already holds the trigger (it is NOT replayed again).
    pub included: bool,
    /// Messages / transactions replayed.
    pub msgs: usize,
    pub txs: usize,
    /// Of those, transactions sequenced AFTER the trigger (our trade lands
    /// after them too).
    pub later: usize,
    /// Last message replayed (= snap_seq when none).
    pub last_seq: u64,
}

/// `feed` part of a trigger-first request (what the bot sends).
#[derive(Clone, Debug, Deserialize)]
pub struct WireFeed {
    /// The trigger's hash.
    pub trigger: String,
    /// The trigger's feed sequence number.
    #[serde(rename = "triggerSeq")]
    pub trigger_seq: u64,
    /// Feed messages the bot holds around it, oldest first, each with ALL
    /// its transactions as signed bytes.
    #[serde(default)]
    pub msgs: Vec<WireFeedMsg>,
    /// Best effort (see the file header): our trade's route pools as the
    /// bot names them (pool contract addresses, V4 pool ids), for deciding
    /// which feed transactions could matter. Empty = never skip.
    #[serde(default)]
    pub route: Vec<String>,
    /// true = the bot's TRIG_FIRST_STRICT=1: no assumptions at all.
    #[serde(default)]
    pub strict: bool,
    /// Which assumptions the bot allows ("sender_funds", "recent_fill",
    /// "skip"); missing = all of them.
    #[serde(default)]
    pub assume: Option<Vec<String>>,
}

/// One feed message as the bot sends it.
#[derive(Clone, Debug, Deserialize)]
pub struct WireFeedMsg {
    pub seq: u64,
    /// Block time and parent-chain block number from the message header.
    #[serde(default)]
    pub ts: u64,
    #[serde(default)]
    pub l1: u64,
    /// Every transaction in it, signed bytes as hex, in order.
    #[serde(default)]
    pub txs: Vec<String>,
    /// false = the bot couldn't unpack all of it (deposit, retryable,
    /// compressed / unsigned transaction, broken batch...): not replayable.
    #[serde(default = "yes")]
    pub complete: bool,
    #[serde(default)]
    pub why: Option<String>,
}

fn yes() -> bool {
    true
}

fn order(detail: String) -> CheckUnknown {
    CheckUnknown::new(UnknownReason::FeedOrder, detail)
}
fn gap(detail: String) -> CheckUnknown {
    CheckUnknown::new(UnknownReason::FeedGap, detail)
}

/// Work out what to replay on a snapshot at feed sequence `snap_seq`
/// (block = snap_seq + `offset`), whose block details are `base`.
/// Err = the answer is "unknown" (or a bad request), see the file header.
pub fn build_plan(feed: &WireFeed, snap_seq: u64, offset: u64, base: &BlockCtx) -> Result<(OrderedPlan, PlanInfo), CheckUnknown> {
    let trigger = parse_bytes(&feed.trigger)
        .ok()
        .filter(|b| b.len() == 32)
        .map(|b| B256::from_slice(&b))
        .ok_or_else(|| CheckUnknown::bad_request("feed.trigger must be a 32-byte hash"))?;
    // The snapshot's own block must be the one its sequence number says
    // (one feed message = one block). Anything else: we can't line them up.
    if let Some(b) = base.l2_block_number {
        if b != snap_seq + offset {
            return Err(order(format!("copy block {b} doesn't match feed sequence {snap_seq} + offset {offset}")));
        }
    }
    // Oldest first, each message once.
    for w in feed.msgs.windows(2) {
        if w[1].seq <= w[0].seq {
            return Err(order(format!("feed messages out of order or repeated ({} then {})", w[0].seq, w[1].seq)));
        }
    }
    // Hash of every transaction the bot gave (decoding comes later, only
    // for the messages we replay): the trigger must be exactly where the
    // feed says, and nowhere else.
    let mut hashes: Vec<Vec<(B256, Bytes)>> = Vec::with_capacity(feed.msgs.len());
    for m in &feed.msgs {
        let mut v = Vec::with_capacity(m.txs.len());
        for (i, t) in m.txs.iter().enumerate() {
            let raw = parse_bytes(t).map_err(|e| CheckUnknown::bad_request(format!("feed message {} tx {i}: {e}", m.seq)))?;
            v.push((keccak256(&raw), raw));
        }
        hashes.push(v);
    }
    let mut seen = 0usize;
    for (m, hs) in feed.msgs.iter().zip(&hashes) {
        let here = hs.iter().filter(|(h, _)| *h == trigger).count();
        if here > 0 && m.seq != feed.trigger_seq {
            return Err(order(format!("trigger found in feed message {} but said to be in {}", m.seq, feed.trigger_seq)));
        }
        if m.seq == feed.trigger_seq && here == 0 {
            return Err(order(format!("trigger not in its feed message {}", m.seq)));
        }
        seen += here;
    }
    if seen > 1 {
        return Err(order("trigger appears more than once in the feed".into()));
    }
    let included = feed.trigger_seq <= snap_seq;
    // The messages after the snapshot: they must start right after it and
    // follow each other with no message missing.
    let needed: Vec<usize> = (0..feed.msgs.len()).filter(|i| feed.msgs[*i].seq > snap_seq).collect();
    if let Some(first) = needed.first() {
        let s = feed.msgs[*first].seq;
        if s != snap_seq + 1 {
            return Err(gap(format!("feed messages {}..{} missing (copy is at {snap_seq})", snap_seq + 1, s - 1)));
        }
    }
    for w in needed.windows(2) {
        let (a, b) = (feed.msgs[w[0]].seq, feed.msgs[w[1]].seq);
        if b != a + 1 {
            return Err(gap(format!("feed messages {}..{} missing", a + 1, b - 1)));
        }
    }
    if !included && needed.last().is_none_or(|i| feed.msgs[*i].seq < feed.trigger_seq) {
        return Err(gap(format!("trigger's feed message {} not given (copy is at {snap_seq})", feed.trigger_seq)));
    }
    if needed.len() > MAX_PLAN_MSGS {
        return Err(gap(format!("copy is {} feed messages behind (limit {MAX_PLAN_MSGS})", needed.len())));
    }
    // Decode and lay out each message with its own block details. Nitro
    // never lets a block's time or parent-chain block go backwards.
    let mut msgs = Vec::with_capacity(needed.len());
    let mut prev = base.clone();
    let (mut txs, mut later, mut after_trigger) = (0usize, 0usize, included);
    for i in needed {
        let m = &feed.msgs[i];
        if !m.complete {
            return Err(CheckUnknown::new(
                UnknownReason::FeedUnreplayable,
                format!("feed message {}: {}", m.seq, m.why.clone().unwrap_or_else(|| "not replayable".into())),
            ));
        }
        if m.ts == 0 {
            return Err(CheckUnknown::new(UnknownReason::FeedUnreplayable, format!("feed message {} has no block time", m.seq)));
        }
        let ctx = BlockCtx {
            l1_block_number: m.l1.max(prev.l1_block_number),
            l2_block_number: base.l2_block_number.map(|_| m.seq + offset),
            timestamp: m.ts.max(prev.timestamp),
            basefee: 0,
            coinbase: prev.coinbase,
            gas_limit: prev.gas_limit,
            prevrandao: prev.prevrandao,
        };
        let mut decoded = Vec::with_capacity(m.txs.len());
        for (j, (h, raw)) in hashes[i].iter().enumerate() {
            let t = decode_signed_tx(raw).map_err(|e| {
                let reason = if e.starts_with(UNSUPPORTED_TX_PREFIX) { UnknownReason::UnsupportedTx } else { UnknownReason::FeedUnreplayable };
                CheckUnknown::new(reason, format!("feed message {} tx {j}: {e}", m.seq))
            })?;
            if after_trigger {
                later += 1;
            }
            if *h == trigger {
                after_trigger = true;
            }
            decoded.push(t);
        }
        txs += decoded.len();
        if txs > MAX_PLAN_TXS {
            return Err(gap(format!("more than {MAX_PLAN_TXS} transactions to replay")));
        }
        prev = ctx.clone();
        msgs.push(PlanMsg { seq: m.seq, ctx, txs: decoded });
    }
    let last_seq = msgs.last().map_or(snap_seq, |m| m.seq);
    let info = PlanInfo { trigger, snap_seq, snap_block: snap_seq + offset, included, msgs: msgs.len(), txs, later, last_seq };
    Ok((OrderedPlan { msgs, trigger, call_ctx: prev }, info))
}

// ---------------------------------------------------------------------------
// Provenance: which values of the copy are exact at the snapshot's block.
// ---------------------------------------------------------------------------
/// Says which values the copy holds EXACTLY at the snapshot's block (see
/// the file header). Copy 2: copy2/intake.rs Copy2Prov. Copy 1 (every
/// transaction replayed, nothing filled from the node later): AllExact.
pub trait Provenance {
    /// This storage value is exact at the snapshot's block.
    fn slot_exact(&self, a: Address, slot: U256) -> bool;
    /// This account's ETH balance is exact (or vouched for) at that block.
    fn balance_exact(&self, a: Address) -> bool;
}

/// Every value is exact (copy 1 / tests).
pub struct AllExact;
impl Provenance for AllExact {
    fn slot_exact(&self, _a: Address, _s: U256) -> bool {
        true
    }
    fn balance_exact(&self, _a: Address) -> bool {
        true
    }
}

// ---------------------------------------------------------------------------
// Best effort: what a check may assume, and what it did assume.
// ---------------------------------------------------------------------------

/// Our trade's route, used to decide whether a feed transaction we can't
/// fully replay could matter to us (see SKIPPING in the file header).
#[derive(Clone, Debug, Default)]
pub struct Route {
    /// Our route's pool contracts (and accounts they own, e.g. an Algebra
    /// plugin): any use of them = touching our route.
    pub accounts: HashSet<Address>,
    /// Single values that belong to our route: our V4 pools' data inside the
    /// PoolManager, our pools' coin balances.
    pub slots: HashSet<(Address, U256)>,
    /// Addresses that, as a transaction's `to` or inside its data, mean "it
    /// may touch our route" (our pool contracts, the V4 PoolManager).
    pub names: Vec<Address>,
    /// Our V4 pool ids (inside a transaction's data = may touch).
    pub ids: Vec<B256>,
    /// Coin pairs of our pools (both inside the data = may touch).
    pub pairs: Vec<(Address, Address)>,
}

impl Route {
    /// Does this transaction NAME our route (rule 2 of SKIPPING)?
    pub fn named_by(&self, to: Option<Address>, data: &[u8]) -> bool {
        if to.is_some_and(|t| self.names.contains(&t) || self.accounts.contains(&t)) {
            return true;
        }
        let has = |needle: &[u8]| !needle.is_empty() && data.len() >= needle.len() && data.windows(needle.len()).any(|w| w == needle);
        self.names.iter().chain(self.accounts.iter()).any(|a| has(a.as_slice()))
            || self.ids.iter().any(|id| has(id.as_slice()))
            // (a pair with native ETH, address zero, is left out: twenty zero
            // bytes are in almost every transaction's data)
            || self.pairs.iter().any(|(x, y)| !x.is_zero() && !y.is_zero() && has(x.as_slice()) && has(y.as_slice()))
    }
    fn touches_slot(&self, a: Address, s: U256) -> bool {
        self.accounts.contains(&a) || self.slots.contains(&(a, s))
    }
}

/// Which assumptions a check may make. `Assume::default()` = none at all:
/// the old strict rules, every doubt is "unknown".
#[derive(Clone, Debug, Default)]
pub struct Assume {
    /// sender_funds (see the file header).
    pub sender_funds: bool,
    /// recent_fill / call_fill: values copy 2 holds only as fills may be
    /// used (labelled) instead of answering "stale_fill".
    pub recent_fill: bool,
    /// Skip feed transactions that miss state and don't touch this route
    /// (None = never skip).
    pub skip: Option<Route>,
}

/// The assumptions a check actually made (empty = an exact answer).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Assumed {
    pub sender_funds: bool,
    pub recent_fill: bool,
    pub call_fill: bool,
    pub skipped_unrelated: usize,
    pub skipped_related: usize,
}

impl Assumed {
    /// The labels written into the answer, e.g. ["sender_funds", "skipped_unrelated:2"].
    pub fn labels(&self) -> Vec<String> {
        let mut v = Vec::new();
        if self.sender_funds {
            v.push("sender_funds".to_string());
        }
        if self.recent_fill {
            v.push("recent_fill".to_string());
        }
        if self.call_fill {
            v.push("call_fill".to_string());
        }
        if self.skipped_unrelated > 0 {
            v.push(format!("skipped_unrelated:{}", self.skipped_unrelated));
        }
        if self.skipped_related > 0 {
            v.push(format!("skipped_related:{}", self.skipped_related));
        }
        v
    }
    /// high = no assumption; medium = only sender_funds / recent_fill /
    /// call_fill / skipped_unrelated; low = a skipped transaction that might
    /// matter (skipped_related).
    pub fn confidence(&self) -> &'static str {
        if self.skipped_related > 0 {
            "low"
        } else if self.sender_funds || self.recent_fill || self.call_fill || self.skipped_unrelated > 0 {
            "medium"
        } else {
            "high"
        }
    }
}

/// The value a missing coin balance / allowance of a replayed transaction's
/// sender is given (sender_funds). Read as an amount it is huge in every
/// common layout (a whole 256-bit word ~2^207, a 160-bit amount 2^158, a
/// 128- or 96-bit amount 2^94) with room left to add; in Permit2's packed
/// allowance (amount 160 bits | expiration 48 | nonce 48) it reads as a huge
/// amount, "never expires", nonce 0.
pub fn assumed_funds() -> U256 {
    (((U256::from(1u8) << 48usize) - U256::from(1u8)) << 160usize) | (U256::from(1u8) << 158usize) | (U256::from(1u8) << 94usize)
}

/// Revert errors that mean "not enough funds / allowance, bad nonce or
/// signature": seen after reading an assumed sender value, our guess may be
/// the cause (unknown "sender_funds_revert"). Error signatures (their 4-byte
/// selectors are searched anywhere in the revert data, so a router that
/// wraps the inner error still matches) and plain-text reasons.
const FUNDS_ERROR_SIGS: &[&str] = &[
    "InvalidNonce()",
    "AllowanceExpired(uint256)",
    "InsufficientAllowance(uint256)",
    "SignatureExpired(uint256)",
    "InvalidSigner()",
    "InvalidSignature()",
    "InvalidSignatureLength()",
    "InvalidAmount(uint256)",
    "ERC20InsufficientBalance(address,uint256,uint256)",
    "ERC20InsufficientAllowance(address,uint256,uint256)",
    "InsufficientBalance()",
    "InsufficientAllowance()",
    "TransferFromFailed()",
    "TransferFailed()",
];
const FUNDS_ERROR_TEXT: &[&str] = &[
    "STF",
    "TRANSFER_FROM_FAILED",
    "exceeds balance",
    "exceeds allowance",
    "insufficient allowance",
    "insufficient balance",
    "Insufficient balance",
    "Insufficient allowance",
    "SafeERC20",
];

/// Which funds error the revert data carries, if any.
pub fn funds_error(out: &[u8]) -> Option<&'static str> {
    static SELS: std::sync::OnceLock<Vec<([u8; 4], &'static str)>> = std::sync::OnceLock::new();
    let sels = SELS.get_or_init(|| {
        FUNDS_ERROR_SIGS
            .iter()
            .map(|s| {
                let h = keccak256(s.as_bytes());
                ([h[0], h[1], h[2], h[3]], *s)
            })
            .collect()
    });
    let has = |needle: &[u8]| out.len() >= needle.len() && out.windows(needle.len()).any(|w| w == needle);
    sels.iter().find(|(sel, _)| has(sel)).map(|(_, s)| *s).or_else(|| FUNDS_ERROR_TEXT.iter().find(|t| has(t.as_bytes())).copied())
}

// ---------------------------------------------------------------------------
// The watch (see the file header).
// ---------------------------------------------------------------------------
struct Watch<'p> {
    prov: &'p dyn Provenance,
    /// Accounts the request pretends (their balance is the request's own).
    pretend_accts: HashSet<Address>,
    /// Apply the provenance rule to balances now (replays; our calls when strict).
    strict: bool,
    /// Best effort: a non-exact balance read is labelled (recent_fill /
    /// call_fill) instead of being a problem.
    fill_ok: bool,
    /// First provenance problem seen.
    stale: Option<String>,
    /// true while a feed transaction runs (false for our own calls).
    replaying: bool,
    /// Senders whose basics we only pretend (our copy doesn't know them).
    pretended: HashSet<Address>,
    /// Every sender of a replayed transaction: its ETH balance isn't exact
    /// any more (gas fees not charged).
    senders: HashSet<Address>,
    /// First problem seen.
    unsure: Option<String>,

    // ---- best effort (see the file header) ----
    /// sender_funds allowed.
    sender_funds: bool,
    /// The sender of the transaction running now.
    cur_sender: Option<Address>,
    /// Storage places computed (KECCAK256) from the current sender's address
    /// or from such a place.
    derived: HashSet<U256>,
    /// The KECCAK256 running now had sender bytes in its input.
    pending_hash: bool,
    /// Every (account, slot) read or written that belongs to a sender.
    sender_slots: HashSet<(Address, U256)>,
    /// The current transaction read a sender's value that we only ASSUMED
    /// (given ASSUMED_FUNDS, or held but not exact).
    tx_sender_read: bool,
    /// The sender values given ASSUMED_FUNDS this round.
    patched: HashSet<(Address, U256)>,
    /// Our route (skipping allowed), else None.
    route: Option<&'p Route>,
    /// The database's miss counter (CheckDb::miss_calls), and its value
    /// when the current transaction started.
    misses: Arc<AtomicU64>,
    tx_miss_base: u64,
    /// The current transaction used our route's state before any miss.
    tx_route_clean: bool,
    /// Labels made by the watch itself (balances / pretended senders).
    labels: Assumed,
}

impl Watch<'_> {
    fn stale_balance(&mut self, a: Address, what: &str) {
        if self.strict && self.stale.is_none() && !self.pretend_accts.contains(&a) && !self.senders.contains(&a) && !self.prov.balance_exact(a) {
            if self.fill_ok {
                if self.replaying {
                    self.labels.recent_fill = true;
                } else {
                    self.labels.call_fill = true;
                }
                return;
            }
            self.stale = Some(format!("{} {what} the ETH balance of {a}, which copy 2 doesn't follow exactly", if self.replaying { "a replayed transaction" } else { "our call" }));
        }
    }
    fn flag(&mut self, why: String) {
        if self.unsure.is_none() {
            self.unsure = Some(why);
        }
    }
    fn balance_read(&mut self, a: Address) {
        self.stale_balance(a, "reads");
        self.route_touch_account(a);
        if self.pretended.contains(&a) || self.senders.contains(&a) {
            // sender_funds: a sender's own ETH balance is assumed enough.
            if self.sender_funds {
                self.labels.sender_funds = true;
            } else if self.pretended.contains(&a) {
                self.flag(format!("reads the ETH balance of {a}, a sender our copy doesn't know"));
            } else {
                self.flag(format!("reads the ETH balance of {a}, which sent a replayed transaction (fees not charged: not exact)"));
            }
        }
    }
    fn looked_at(&mut self, a: Address) {
        if self.pretended.contains(&a) {
            // sender_funds: a sender is a plain wallet (no code), which is
            // what we pretend.
            if self.sender_funds {
                self.labels.sender_funds = true;
            } else {
                self.flag(format!("looks at {a} (code or call), a sender our copy doesn't know"));
            }
        }
    }
    /// A new replayed transaction starts.
    fn begin_tx(&mut self, sender: Address) {
        self.cur_sender = Some(sender);
        self.derived.clear();
        self.pending_hash = false;
        self.tx_sender_read = false;
        self.tx_route_clean = false;
        self.tx_miss_base = self.misses.load(Ordering::Relaxed);
    }
    /// Our route was used: remember it if nothing was missing yet.
    fn route_used(&mut self) {
        if self.replaying && self.misses.load(Ordering::Relaxed) == self.tx_miss_base {
            self.tx_route_clean = true;
        }
    }
    fn route_touch_account(&mut self, a: Address) {
        if self.route.is_some_and(|r| r.accounts.contains(&a)) {
            self.route_used();
        }
    }
    /// Is this storage place one of the current sender's (computed from its
    /// address, up to 4 places further for struct fields)?
    fn is_sender_place(&self, s: U256) -> bool {
        (0u8..=4).any(|k| s >= U256::from(k) && self.derived.contains(&(s - U256::from(k))))
    }
    /// SLOAD / SSTORE of (a, s).
    fn storage_access(&mut self, a: Address, s: U256) {
        let on_route = self.route.is_some_and(|r| r.touches_slot(a, s));
        if on_route {
            self.route_used();
        }
        // Our route's values are followed exactly: never "the sender's".
        if self.replaying && self.sender_funds && !on_route && self.is_sender_place(s) {
            self.sender_slots.insert((a, s));
            if self.patched.contains(&(a, s)) || !self.prov.slot_exact(a, s) {
                self.tx_sender_read = true;
            }
        }
    }
    /// KECCAK256 input: does it contain the sender's address, or a place
    /// already computed from it?
    fn hash_input_is_senders(&self, input: &[u8]) -> bool {
        let Some(sender) = self.cur_sender else { return false };
        let sb = sender.as_slice();
        if input.len() >= 20 && input.windows(20).any(|w| w == sb) {
            return true;
        }
        input.chunks(32).filter(|c| c.len() == 32).any(|c| self.derived.contains(&U256::from_be_slice(c)))
    }
}

fn word_addr(w: U256) -> Address {
    Address::from_word(B256::from(w.to_be_bytes::<32>()))
}

/// Longest KECCAK256 input looked at for sender places (mapping keys are
/// 32-96 bytes; longer inputs are hashes of data, not storage places).
const MAX_HASH_INPUT: usize = 256;

impl<CTX> Inspector<CTX, EthInterpreter> for Watch<'_> {
    fn step(&mut self, interp: &mut Interpreter<EthInterpreter>, _ctx: &mut CTX) {
        match interp.bytecode.opcode() {
            // KECCAK256(offset, size): note storage places computed from the sender.
            0x20 => {
                if self.replaying && self.sender_funds {
                    if let (Ok(off), Ok(len)) = (interp.stack.peek(0), interp.stack.peek(1)) {
                        if len <= U256::from(MAX_HASH_INPUT) && off < U256::from(u32::MAX) {
                            let (off, len) = (off.to::<usize>(), len.to::<usize>());
                            let size = interp.memory.size();
                            let mut input = vec![0u8; len];
                            if off < size {
                                let end = (off + len).min(size);
                                input[..end - off].copy_from_slice(&interp.memory.slice(off..end));
                            }
                            self.pending_hash = self.hash_input_is_senders(&input);
                        }
                    }
                }
            }
            // SLOAD(slot) / SSTORE(slot, value)
            0x54 | 0x55 => {
                if let Ok(s) = interp.stack.peek(0) {
                    let a = interp.input.target_address();
                    self.storage_access(a, s);
                }
            }
            // BALANCE(addr)
            0x31 => {
                if let Ok(w) = interp.stack.peek(0) {
                    self.balance_read(word_addr(w));
                }
            }
            // SELFBALANCE
            0x47 => {
                let a = interp.input.target_address();
                self.balance_read(a);
            }
            // GASPRICE / BASEFEE / COINBASE: the block's real values aren't
            // known for a replayed message (our own calls: eth_call rules).
            0x3a | 0x48 | 0x41 => {
                if self.replaying {
                    self.flag("a replayed transaction reads GASPRICE / BASEFEE / COINBASE".into());
                }
            }
            // EXTCODESIZE / EXTCODECOPY / EXTCODEHASH (addr), SELFDESTRUCT (to)
            0x3b | 0x3c | 0x3f | 0xff => {
                if let Ok(w) = interp.stack.peek(0) {
                    self.looked_at(word_addr(w));
                }
            }
            _ => {}
        }
    }

    fn step_end(&mut self, interp: &mut Interpreter<EthInterpreter>, _ctx: &mut CTX) {
        // The KECCAK256 just ran: its result (top of the stack) is a place
        // computed from the sender.
        if self.pending_hash {
            self.pending_hash = false;
            if let Ok(h) = interp.stack.peek(0) {
                self.derived.insert(h);
            }
        }
    }

    fn call(&mut self, _ctx: &mut CTX, inputs: &mut CallInputs) -> Option<FrameOutcome> {
        self.looked_at(inputs.target_address);
        self.looked_at(inputs.bytecode_address);
        self.route_touch_account(inputs.target_address);
        self.route_touch_account(inputs.bytecode_address);
        // ETH sent along: the sender's balance decides whether it can pay.
        if inputs.transfers_value() {
            self.stale_balance(inputs.caller, "spends");
        }
        None
    }
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

/// One replayed feed transaction's result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplayedTx {
    pub hash: B256,
    pub seq: u64,
    pub outcome: CallOutcome,
}

/// Everything a trigger-first run produced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderedOut {
    pub replayed: Vec<ReplayedTx>,
    /// One result per call of ours, in order.
    pub results: Vec<CallOutcome>,
    /// The assumptions made (empty = exact). See the file header.
    pub assumed: Assumed,
    /// Storage values the replayed transactions left changed (account,
    /// slot), sorted. Exact for a one-transaction plan (`trigger_only`,
    /// the trigger-first entry point's "which of our pools did it move?");
    /// with several transactions it is "changed by one of them".
    pub changed: Vec<(Address, U256)>,
}

/// TRIGGER-FIRST ENTRY POINT ("discover", server.rs trig_discover):
/// the plan cut down to the trigger ALONE, in its own message's block
/// details. Plain English: to learn quickly which of our pools a new feed
/// transaction moves, we run just that transaction on the newest copy
/// version (one run, a fraction of a millisecond) and look at what it
/// changed. Feed transactions sequenced between the copy version and the
/// trigger are left out (counted, `alone:N` in the answer, confidence at
/// most medium): the full ordered check of each candidate trade afterwards
/// replays every one of them anyway.
/// Returns None when the trigger isn't in the plan (it is already in the
/// copy version: nothing to run). The number is how many other replayable
/// transactions were left out.
pub fn trigger_only(plan: &OrderedPlan) -> Option<(OrderedPlan, usize)> {
    let mut others = 0usize;
    let mut found: Option<PlanMsg> = None;
    for m in &plan.msgs {
        for t in &m.txs {
            if t.hash == plan.trigger && found.is_none() {
                found = Some(PlanMsg { seq: m.seq, ctx: m.ctx.clone(), txs: vec![t.clone()] });
            } else if found.is_none() {
                others += 1;
            }
        }
    }
    let m = found?;
    let call_ctx = m.ctx.clone();
    Some((OrderedPlan { msgs: vec![m], trigger: plan.trigger, call_ctx }, others))
}

type WatchedEvm<'a> = ArbEvm<CheckDb<'a>, Watch<'a>>;

/// Put the EVM in this block (block details + what ArbSys says).
fn enter_block(evm: &mut WatchedEvm<'_>, ctx: &BlockCtx) {
    evm.ctx.block = arb::block_env_ethcall(ctx);
    evm.precompiles.set_l2_block(ctx.l2_block_number.map(U256::from));
}

/// Run one transaction (inspected), shaped like run.rs Session::run_tx.
fn run_one(evm: &mut WatchedEvm<'_>, tx: TxEnv) -> Result<CallOutcome, CheckUnknown> {
    let r = evm.inspect_one_tx(tx);
    match r {
        Ok(ExecutionResult::Success { gas, output, .. }) => Ok(CallOutcome {
            success: true,
            output: match output {
                Output::Call(b) => b,
                Output::Create(b, _) => b,
            },
            gas_used: gas.tx_gas_used(),
            halt: None,
        }),
        Ok(ExecutionResult::Revert { gas, output, .. }) => Ok(CallOutcome { success: false, output, gas_used: gas.tx_gas_used(), halt: None }),
        Ok(ExecutionResult::Halt { gas, reason, .. }) => {
            Ok(CallOutcome { success: false, output: Bytes::new(), gas_used: gas.tx_gas_used(), halt: Some(format!("{reason:?}")) })
        }
        Err(EVMError::Transaction(e)) => Ok(CallOutcome { success: false, output: Bytes::new(), gas_used: 0, halt: Some(format!("invalid: {e:?}")) }),
        Err(EVMError::Database(e)) => Err(db_unknown(e, &evm.ctx.journaled_state.database.missing)),
        Err(EVMError::Custom(m)) if m.starts_with(arb::UNSUPPORTED_PRECOMPILE_PREFIX) || evm.precompiles.unsupported().is_some() => {
            Err(CheckUnknown::new(UnknownReason::UnsupportedPrecompile, m))
        }
        Err(e) => Err(CheckUnknown::new(UnknownReason::Engine, format!("{e:?}"))),
    }
}

/// A replayed feed transaction with its real fields (gas price 0, like the
/// node's own replay with validation off; see run.rs apply_decoded).
fn tx_env_of(t: &DecodedTx) -> TxEnv {
    TxEnv {
        tx_type: if t.access_list.is_empty() { 0 } else { 1 },
        caller: t.from,
        gas_limit: t.gas,
        gas_price: 0,
        kind: t.to.map(TxKind::Call).unwrap_or(TxKind::Create),
        value: t.value,
        data: t.data.clone(),
        nonce: t.nonce,
        chain_id: t.chain_id.or(Some(arb::CHAIN_ID)),
        access_list: AccessList(t.access_list.iter().map(|i| AccessListItem { address: i.address, storage_keys: i.storage_keys.clone() }).collect()),
        ..Default::default()
    }
}

/// Our own call, eth_call style (see run.rs Session::call).
fn call_env_of(c: &CallReq) -> TxEnv {
    TxEnv {
        tx_type: 0,
        caller: c.from,
        gas_limit: c.gas.unwrap_or(DEFAULT_CALL_GAS),
        gas_price: 0,
        kind: c.to.map(TxKind::Call).unwrap_or(TxKind::Create),
        value: c.value,
        data: c.data.clone(),
        nonce: 0,
        chain_id: Some(arb::CHAIN_ID),
        ..Default::default()
    }
}

/// Did our pretend-state touch anything the replayed transactions read?
/// Some(detail) = yes (the answer must be unknown).
fn funding_overlap(ov: &Overrides, reads: &super::db::ReadLog) -> Option<String> {
    for (a, o) in &ov.accounts {
        let basics = o.balance.is_some() || o.nonce.is_some() || o.code.is_some();
        if (basics || o.state.is_some()) && reads.accounts.contains(a) {
            return Some(format!("replayed transactions read account {a}, which the check pretends"));
        }
        if let Some(s) = o.state_diff.keys().find(|s| reads.slots.contains(&(*a, **s))) {
            return Some(format!("replayed transactions read slot {s:#x} of {a}, which the check pretends"));
        }
    }
    None
}

/// The copy values read that aren't exact at the snapshot's block (see
/// "PROVENANCE" in the file header), sorted; `except` are left out (values
/// of a sender, labelled sender_funds instead).
fn stale_slots(prov: &dyn Provenance, slots: &HashSet<(Address, U256)>, except: &HashSet<(Address, U256)>) -> Vec<(Address, U256)> {
    let mut bad: Vec<(Address, U256)> = slots.iter().filter(|(a, s)| !prov.slot_exact(*a, *s) && !except.contains(&(*a, *s))).copied().collect();
    bad.sort();
    bad
}

fn stale_unknown(bad: &[(Address, U256)], who: &str) -> CheckUnknown {
    let (a, s) = bad[0];
    CheckUnknown::new(
        UnknownReason::StaleFill,
        format!("{who} read slot {s:#x} of {a} ({} such value(s)), which copy 2 doesn't follow exactly at this block", bad.len()),
    )
}

/// Most times one check may start its run again (each time with more
/// assumed sender values, or one more skipped transaction). More = unknown.
pub const MAX_ROUNDS: usize = 16;

/// Replay `plan` on `view` (in order, each message in its own block), then
/// run `calls` with `overrides`. Nothing is written back to `view`.
/// `prov` says which copy values are exact at the snapshot's block; replays
/// must only use those; our calls too when `strict_call`.
/// The old strict rules: no assumptions (see `run_ordered_with`).
pub fn run_ordered(
    view: &dyn StateRead,
    plan: &OrderedPlan,
    overrides: &Overrides,
    calls: &[CallReq],
    prov: &dyn Provenance,
    strict_call: bool,
) -> Result<OrderedOut, CheckUnknown> {
    run_ordered_with(view, plan, overrides, calls, prov, strict_call, &Assume::default())
}

/// What one round asks for next.
enum Next {
    /// Finished: the answer.
    Done(OrderedOut),
    /// Start again, giving these missing sender values ASSUMED_FUNDS.
    Patch(Vec<(Address, U256)>),
    /// Start again without this transaction (message seq, index in it);
    /// true = it may touch our route (skipped_related).
    Skip((u64, usize), bool),
}

/// `run_ordered` with best-effort assumptions (see BEST EFFORT in the file
/// header). Runs the whole plan from the start each round; a round stops at
/// the first replayed transaction that needs a value we don't hold, and
/// either gives its sender's missing values an assumed amount, skips it, or
/// answers unknown.
pub fn run_ordered_with(
    view: &dyn StateRead,
    plan: &OrderedPlan,
    overrides: &Overrides,
    calls: &[CallReq],
    prov: &dyn Provenance,
    strict_call: bool,
    assume: &Assume,
) -> Result<OrderedOut, CheckUnknown> {
    let mut patched: Vec<(Address, U256)> = Vec::new();
    let mut skip: HashMap<(u64, usize), bool> = HashMap::new();
    for _ in 0..MAX_ROUNDS {
        match one_round(view, plan, overrides, calls, prov, strict_call, assume, &patched, &skip)? {
            Next::Done(mut out) => {
                out.assumed.sender_funds |= !patched.is_empty();
                out.assumed.skipped_related = skip.values().filter(|r| **r).count();
                out.assumed.skipped_unrelated = skip.len() - out.assumed.skipped_related;
                return Ok(out);
            }
            Next::Patch(more) => {
                let before = patched.len();
                for p in more {
                    if !patched.contains(&p) {
                        patched.push(p);
                    }
                }
                if patched.len() == before {
                    // Nothing new to assume, yet still missing: give up.
                    return Err(CheckUnknown::new(UnknownReason::Miss, "a sender's value is still missing after assuming it"));
                }
            }
            Next::Skip(at, related) => {
                skip.insert(at, related);
            }
        }
    }
    Err(CheckUnknown::new(UnknownReason::Miss, format!("still not answerable after {MAX_ROUNDS} runs (assumed sender values / skipped transactions)")))
}

#[allow(clippy::too_many_arguments)]
fn one_round(
    view: &dyn StateRead,
    plan: &OrderedPlan,
    overrides: &Overrides,
    calls: &[CallReq],
    prov: &dyn Provenance,
    strict_call: bool,
    assume: &Assume,
    patched: &[(Address, U256)],
    skip: &HashMap<(u64, usize), bool>,
) -> Result<Next, CheckUnknown> {
    let mut db = CheckDb::new(view, overrides, true);
    // Assumed sender values (sender_funds), served before anything else.
    db.set_patches(patched.iter().map(|(a, s)| (*a, *s, assumed_funds())).collect());
    let misses = db.miss_calls.clone();
    let first = plan.msgs.first().map(|m| &m.ctx).unwrap_or(&plan.call_ctx);
    let watch = Watch {
        prov,
        pretend_accts: overrides.accounts.keys().copied().collect(),
        strict: true,
        fill_ok: assume.recent_fill,
        stale: None,
        replaying: false,
        pretended: HashSet::new(),
        senders: HashSet::new(),
        unsure: None,
        sender_funds: assume.sender_funds,
        cur_sender: None,
        derived: HashSet::new(),
        pending_hash: false,
        sender_slots: HashSet::new(),
        tx_sender_read: false,
        patched: patched.iter().copied().collect(),
        route: assume.skip.as_ref(),
        misses,
        tx_miss_base: 0,
        tx_route_clean: false,
        labels: Assumed::default(),
    };
    let mut evm = build_evm_with_inspector(db, first, &ArbConfig::default(), default_arbsys_gas(), true, watch);
    // eth_call rules: no gas fee charged or paid (see run.rs Session::new).
    evm.ctx.modify_cfg(|cfg| cfg.disable_fee_charge = true);
    if first.l2_block_number.is_some() {
        let unsupported: Vec<Address> = arb::arbitrum_builtin_addresses().into_iter().filter(|a| !evm.precompiles.implements(a)).collect();
        evm.ctx.journaled_state.database.set_unsupported_builtins(unsupported);
    }
    let watch_problem = |evm: &mut WatchedEvm<'_>| {
        if let Some(w) = evm.inspector.unsure.take() {
            return Some(CheckUnknown::new(UnknownReason::ReplayWatch, w));
        }
        evm.inspector.stale.take().map(|w| CheckUnknown::new(UnknownReason::StaleFill, w))
    };

    // 1. The feed's transactions, in sequence order.
    let mut replayed = Vec::with_capacity(plan.msgs.iter().map(|m| m.txs.len()).sum());
    evm.ctx.journaled_state.database.set_recording(true);
    evm.inspector.replaying = true;
    for m in &plan.msgs {
        enter_block(&mut evm, &m.ctx);
        for (j, t) in m.txs.iter().enumerate() {
            // Skipped (best effort): as if it weren't there at all.
            if skip.contains_key(&(m.seq, j)) {
                continue;
            }
            // Unknown sender: pretend it (watched), see the file header.
            if matches!(view.account(t.from), Lookup::Missing) && overrides.get(&t.from).is_none() {
                let info = AccountInfo { balance: t.value, nonce: t.nonce, code_hash: KECCAK_EMPTY, ..Default::default() };
                evm.ctx.journaled_state.database.add_pretend(t.from, info);
                evm.inspector.pretended.insert(t.from);
            }
            evm.inspector.senders.insert(t.from);
            evm.inspector.begin_tx(t.from);
            let miss_before = evm.ctx.journaled_state.database.missing.len();
            let outcome = match run_one(&mut evm, tx_env_of(t)) {
                Ok(o) => Some(o),
                // Too many misses at once: judged like any miss below.
                Err(u) if u.reason == UnknownReason::Miss => None,
                // A Nitro built-in we don't imitate: we can't run THIS
                // transaction; it may be skipped by the same rules as a miss.
                Err(u) if u.reason == UnknownReason::UnsupportedPrecompile => return judge_cant_run(&evm, plan, t, (m.seq, j), assume, u),
                Err(u) => return Err(u),
            };
            if let Some(h) = evm.precompiles.unsupported() {
                let u = CheckUnknown::new(UnknownReason::UnsupportedPrecompile, h.to_string());
                return judge_cant_run(&evm, plan, t, (m.seq, j), assume, u);
            }
            let new_misses: Vec<MissItem> = evm.ctx.journaled_state.database.missing[miss_before..].to_vec();
            if !new_misses.is_empty() {
                return judge_miss(&evm, plan, t, (m.seq, j), assume, new_misses);
            }
            let Some(outcome) = outcome else {
                return Err(CheckUnknown { reason: UnknownReason::Miss, missing: evm.ctx.journaled_state.database.missing.clone(), detail: "too many missing items".into() });
            };
            if let Some(u) = watch_problem(&mut evm) {
                return Err(u);
            }
            // sender_funds: failed with a "not enough funds / bad nonce or
            // signature" error after reading a value we only assumed.
            if !outcome.success && evm.inspector.tx_sender_read {
                if let Some(e) = funds_error(&outcome.output) {
                    return Err(CheckUnknown::new(
                        UnknownReason::SenderFunds,
                        format!("a replayed transaction ({:#x}) reverted with \"{e}\" after reading its sender's coin balance / allowance, which we only assumed", t.hash),
                    ));
                }
            }
            replayed.push(ReplayedTx { hash: t.hash, seq: m.seq, outcome });
        }
    }
    // What the replayed transactions left changed (the entry point's
    // "which pools did the trigger move?"; see OrderedOut.changed).
    let mut changed: Vec<(Address, U256)> = evm
        .ctx
        .journaled_state
        .state
        .iter()
        .flat_map(|(a, acc)| acc.storage.iter().filter(|(_, v)| v.is_changed()).map(move |(k, _)| (*a, *k)))
        .collect();
    changed.sort();
    // 2. Our pretend-state must not have changed how they ran, and every
    //    copy value they used must be exact at the snapshot's block (or,
    //    best effort, labelled: a sender's value = sender_funds, a fill =
    //    recent_fill).
    let reads = std::mem::take(&mut evm.ctx.journaled_state.database.reads);
    if let Some(d) = funding_overlap(overrides, &reads) {
        return Err(CheckUnknown::new(UnknownReason::FundingOverlap, d));
    }
    let mut assumed = Assumed::default();
    let sender_slots = std::mem::take(&mut evm.inspector.sender_slots);
    if reads.view_slots.iter().any(|x| sender_slots.contains(x) && !prov.slot_exact(x.0, x.1)) {
        assumed.sender_funds = true;
    }
    let bad = stale_slots(prov, &reads.view_slots, &sender_slots);
    if !bad.is_empty() {
        if assume.recent_fill {
            assumed.recent_fill = true;
        } else {
            return Err(stale_unknown(&bad, "a replayed transaction"));
        }
    }
    // 3. Our calls, in the block of the last message replayed.
    evm.inspector.replaying = false;
    evm.inspector.cur_sender = None;
    evm.inspector.strict = strict_call;
    enter_block(&mut evm, &plan.call_ctx);
    let mut results = Vec::with_capacity(calls.len());
    for c in calls {
        results.push(run_one(&mut evm, call_env_of(c))?);
        if let Some(u) = watch_problem(&mut evm) {
            return Err(u);
        }
    }
    evm.ctx.journaled_state.database.set_recording(false);
    // Final verdict, as run.rs Session::verdict (plus, strict: our calls'
    // copy values exact too, or best effort: labelled call_fill).
    if let Some(h) = evm.precompiles.unsupported() {
        return Err(CheckUnknown::new(UnknownReason::UnsupportedPrecompile, h.to_string()));
    }
    let m = &evm.ctx.journaled_state.database.missing;
    if !m.is_empty() {
        return Err(CheckUnknown { reason: UnknownReason::Miss, missing: m.clone(), detail: format!("{} item(s) not in our copy", m.len()) });
    }
    if strict_call {
        let bad = stale_slots(prov, &evm.ctx.journaled_state.database.reads.view_slots, &HashSet::new());
        if !bad.is_empty() {
            if assume.recent_fill {
                assumed.call_fill = true;
            } else {
                return Err(stale_unknown(&bad, "our call"));
            }
        }
    }
    let l = &evm.inspector.labels;
    assumed.sender_funds |= l.sender_funds;
    assumed.recent_fill |= l.recent_fill;
    assumed.call_fill |= l.call_fill;
    Ok(Next::Done(OrderedOut { replayed, results, assumed, changed }))
}

/// A replayed transaction needed values we don't hold: assume its sender's,
/// skip it, or answer unknown (see BEST EFFORT in the file header).
fn judge_miss(evm: &WatchedEvm<'_>, plan: &OrderedPlan, t: &DecodedTx, at: (u64, usize), assume: &Assume, new_misses: Vec<MissItem>) -> Result<Next, CheckUnknown> {
    let w = &evm.inspector;
    let all_missing = || evm.ctx.journaled_state.database.missing.clone();
    let (senders, other): (Vec<MissItem>, Vec<MissItem>) =
        new_misses.into_iter().partition(|m| matches!(m, MissItem::Slot(a, s) if w.sender_slots.contains(&(*a, *s))));
    // Only its sender's coin balances / allowances: assume them, run again.
    if other.is_empty() && assume.sender_funds {
        let p = senders
            .into_iter()
            .filter_map(|m| match m {
                MissItem::Slot(a, s) => Some((a, s)),
                _ => None,
            })
            .collect();
        return Ok(Next::Patch(p));
    }
    let unknown = CheckUnknown { reason: UnknownReason::Miss, missing: all_missing(), detail: format!("{} item(s) not in our copy", evm.ctx.journaled_state.database.missing.len()) };
    judge_cant_run(evm, plan, t, at, assume, unknown)
}

/// A replayed transaction we can't run (it needs values we don't hold, or
/// a Nitro built-in we don't imitate): skip it by the SKIPPING rules (file
/// header), or answer `unknown` (with a clearer detail).
fn judge_cant_run(evm: &WatchedEvm<'_>, plan: &OrderedPlan, t: &DecodedTx, at: (u64, usize), assume: &Assume, mut unknown: CheckUnknown) -> Result<Next, CheckUnknown> {
    let Some(route) = &assume.skip else { return Err(unknown) };
    // The trigger itself is never skipped: its effect on our pools must be computed.
    if t.hash == plan.trigger {
        unknown.detail = format!("the trigger can't be run ({}; other than its sender's funds)", unknown.detail);
        return Err(unknown);
    }
    // 1. It used our route's state before it got stuck: it matters.
    if evm.inspector.tx_route_clean {
        unknown.detail = format!("feed transaction {:#x} used our route's state and then couldn't be run ({})", t.hash, unknown.detail);
        return Err(unknown);
    }
    // 2. / 3. Skip it; "related" if it names our route.
    Ok(Next::Skip(at, route.named_by(t.to, &t.data)))
}
