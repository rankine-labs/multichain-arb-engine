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
//       answer is unknown (stale_fill). By default our own calls follow the
//       same rule (strict); `strict_call = false` gives them the trust every
//       other copy-2 check already has (see server.rs ARBSIM_TRIG_CALL_TRUST).
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
// ============================================================================
use std::collections::HashSet;

use revm::context::TxEnv;
use revm::context_interface::result::{EVMError, ExecutionResult, Output};
use revm::context_interface::transaction::{AccessList, AccessListItem};
use revm::inspector::Inspector;
use revm::interpreter::interpreter::EthInterpreter;
use revm::interpreter::interpreter_types::{InputsTr, Jumps};
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
use crate::state::{Lookup, StateRead};

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
    Ok((OrderedPlan { msgs, call_ctx: prev }, info))
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
// The watch (see the file header).
// ---------------------------------------------------------------------------
struct Watch<'p> {
    prov: &'p dyn Provenance,
    /// Accounts the request pretends (their balance is the request's own).
    pretend_accts: HashSet<Address>,
    /// Apply the provenance rule to balances now (replays; our calls when strict).
    strict: bool,
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
}

impl Watch<'_> {
    fn stale_balance(&mut self, a: Address, what: &str) {
        if self.strict && self.stale.is_none() && !self.pretend_accts.contains(&a) && !self.senders.contains(&a) && !self.prov.balance_exact(a) {
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
        if self.pretended.contains(&a) {
            self.flag(format!("reads the ETH balance of {a}, a sender our copy doesn't know"));
        } else if self.senders.contains(&a) {
            self.flag(format!("reads the ETH balance of {a}, which sent a replayed transaction (fees not charged: not exact)"));
        }
    }
    fn looked_at(&mut self, a: Address) {
        if self.pretended.contains(&a) {
            self.flag(format!("looks at {a} (code or call), a sender our copy doesn't know"));
        }
    }
}

fn word_addr(w: U256) -> Address {
    Address::from_word(B256::from(w.to_be_bytes::<32>()))
}

impl<CTX> Inspector<CTX, EthInterpreter> for Watch<'_> {
    fn step(&mut self, interp: &mut Interpreter<EthInterpreter>, _ctx: &mut CTX) {
        match interp.bytecode.opcode() {
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

    fn call(&mut self, _ctx: &mut CTX, inputs: &mut CallInputs) -> Option<FrameOutcome> {
        self.looked_at(inputs.target_address);
        self.looked_at(inputs.bytecode_address);
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

/// The first copy value read from the copy that isn't exact at the
/// snapshot's block (see "PROVENANCE" in the file header).
fn stale_slot(prov: &dyn Provenance, slots: &HashSet<(Address, U256)>, who: &str) -> Option<CheckUnknown> {
    let mut bad: Vec<&(Address, U256)> = slots.iter().filter(|(a, s)| !prov.slot_exact(*a, *s)).collect();
    bad.sort();
    bad.first().map(|(a, s)| {
        CheckUnknown::new(
            UnknownReason::StaleFill,
            format!("{who} read slot {s:#x} of {a} ({} such value(s)), which copy 2 doesn't follow exactly at this block", bad.len()),
        )
    })
}

/// Replay `plan` on `view` (in order, each message in its own block), then
/// run `calls` with `overrides`. Nothing is written back to `view`.
/// `prov` says which copy values are exact at the snapshot's block; replays
/// must only use those; our calls too when `strict_call`.
pub fn run_ordered(
    view: &dyn StateRead,
    plan: &OrderedPlan,
    overrides: &Overrides,
    calls: &[CallReq],
    prov: &dyn Provenance,
    strict_call: bool,
) -> Result<OrderedOut, CheckUnknown> {
    let db = CheckDb::new(view, overrides, true);
    let first = plan.msgs.first().map(|m| &m.ctx).unwrap_or(&plan.call_ctx);
    let watch = Watch {
        prov,
        pretend_accts: overrides.accounts.keys().copied().collect(),
        strict: true,
        stale: None,
        replaying: false,
        pretended: HashSet::new(),
        senders: HashSet::new(),
        unsure: None,
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
        for t in &m.txs {
            // Unknown sender: pretend it (watched), see the file header.
            if matches!(view.account(t.from), Lookup::Missing) && overrides.get(&t.from).is_none() {
                let info = AccountInfo { balance: t.value, nonce: t.nonce, code_hash: KECCAK_EMPTY, ..Default::default() };
                evm.ctx.journaled_state.database.add_pretend(t.from, info);
                evm.inspector.pretended.insert(t.from);
            }
            evm.inspector.senders.insert(t.from);
            let outcome = run_one(&mut evm, tx_env_of(t))?;
            if let Some(u) = watch_problem(&mut evm) {
                return Err(u);
            }
            replayed.push(ReplayedTx { hash: t.hash, seq: m.seq, outcome });
        }
    }
    // 2. Our pretend-state must not have changed how they ran, and every
    //    copy value they used must be exact at the snapshot's block. (A
    //    miss is reported first: fetching it is what helps next time.)
    let reads = std::mem::take(&mut evm.ctx.journaled_state.database.reads);
    if let Some(d) = funding_overlap(overrides, &reads) {
        return Err(CheckUnknown::new(UnknownReason::FundingOverlap, d));
    }
    if evm.ctx.journaled_state.database.missing.is_empty() {
        if let Some(u) = stale_slot(prov, &reads.view_slots, "a replayed transaction") {
            return Err(u);
        }
    }
    // 3. Our calls, in the block of the last message replayed.
    evm.inspector.replaying = false;
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
    // copy values exact too).
    if let Some(h) = evm.precompiles.unsupported() {
        return Err(CheckUnknown::new(UnknownReason::UnsupportedPrecompile, h.to_string()));
    }
    let m = &evm.ctx.journaled_state.database.missing;
    if !m.is_empty() {
        return Err(CheckUnknown { reason: UnknownReason::Miss, missing: m.clone(), detail: format!("{} item(s) not in our copy", m.len()) });
    }
    if strict_call {
        if let Some(u) = stale_slot(prov, &evm.ctx.journaled_state.database.reads.view_slots, "our call") {
            return Err(u);
        }
    }
    Ok(OrderedOut { replayed, results })
}
