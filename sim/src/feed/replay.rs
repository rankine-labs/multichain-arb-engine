// ============================================================================
// FEED REPLAY: run each feed message's transactions on our copy, in order.
//
// Plain English:
//   This is how the mirror stays current WITHOUT asking the node every block:
//   every transaction of every block is re-run locally (revm with Nitro rules
//   from arb/), exactly like the chain ran it, and the changes it made become
//   the next version of our copy.
//
//   Exactness rules (what we do when we can't be exact):
//     * A transaction reads something our copy doesn't have (MISSING): we
//       stop, list ALL items the rest of the message seems to need (a quick
//       "collect" run that guesses zero just to discover them; its results
//       are thrown away), and report NeedItems. The mirror fetches them from
//       the node AS OF THE BLOCK BEFORE this message, and replays the message
//       again from the start. Never a guess.
//     * Gas fees are NOT charged (Nitro's fee includes an L1 part we can't
//       compute). So after a transaction its sender's ETH balance is only
//       approximately right: marked "inexact" (state/snap.rs). A transaction
//       that READS an inexact balance (BALANCE / SELFBALANCE opcodes) is
//       treated like a miss for that account (fresh exact value fetched).
//     * Unknown sender (never loaded): the sequencer accepted the tx, so its
//       nonce and balance were fine; we "pretend" them for the run and do
//       NOT record the sender's own new state. If anything else in the run
//       looks at that sender (calls it, reads its code or balance), it's
//       treated as a miss for the sender instead.
//     * Things we can't do at all (BLOCKHASH, Nitro precompiles we don't
//       imitate, ArbOS internal state, a tx revm refuses although the chain
//       accepted it): NeedTrace -> the mirror asks the node for its own list
//       of what the block changed (one debug_trace call, budgeted).
// ============================================================================
use std::collections::HashSet;
use std::sync::Arc;

use revm::context_interface::result::{EVMError, ExecutionResult};
use revm::inspector::Inspector;
use revm::interpreter::interpreter::EthInterpreter;
use revm::interpreter::interpreter_types::{InputsTr, Jumps};
use revm::interpreter::{CallInputs, CallOutcome, Interpreter};
use revm::primitives::{Address, B256, KECCAK_EMPTY};
use revm::state::{AccountInfo, EvmState};
use revm::{ExecuteEvm, InspectEvm};

use super::frame::FeedMessage;
use super::tx::FeedTx;
use crate::arb::{self, evm::build_evm_with_inspector, ArbConfig, BlockCtx};
use crate::state::db::{DbMiss, ViewDb};
use crate::state::diff::{from_evm_state, merge};
use crate::state::snap::Snapshot;
use crate::state::{Lookup, MissItem, StateDiff, StatePosition, StateRead};

/// Most items one message may ask for in one round.
pub const MAX_ITEMS_PER_ROUND: usize = 256;

/// Settings for replay (same for every message).
#[derive(Clone, Debug)]
pub struct ReplayEnv {
    pub cfg: ArbConfig,
    pub arbsys_gas: u64,
    /// true = BlockCtx.basefee is the real base fee of the block being
    /// replayed (Robinhood keeps it at the ArbOS minimum almost always; the
    /// updater sets this while the last header's base fee equals the
    /// minimum it has seen). false = txs reading it need the node's trace.
    pub basefee_known: bool,
}

impl Default for ReplayEnv {
    fn default() -> Self {
        ReplayEnv { cfg: ArbConfig::default(), arbsys_gas: crate::check::run::default_arbsys_gas(), basefee_known: false }
    }
}

/// Something in the run made the result unsure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Unsure {
    /// Read an ETH balance we only know approximately.
    InexactBalance(Address),
    /// Touched the pretended sender beyond being the caller.
    Pretended(Address),
    /// Read its own sender's balance (always inexact during our run).
    SenderBalance,
    /// Read BASEFEE / GASPRICE while the block's base fee isn't known.
    BaseFee,
}

/// Watches the run for the "unsure" cases above.
struct Watch<'a> {
    view: &'a Snapshot,
    /// Is ctx.basefee the block's real base fee?
    basefee_known: bool,
    sender: Address,
    pretended: Option<Address>,
    unsure: Option<Unsure>,
}

impl Watch<'_> {
    fn balance_read(&mut self, a: Address) {
        if self.unsure.is_some() {
            return;
        }
        if Some(a) == self.pretended {
            self.unsure = Some(Unsure::Pretended(a));
        } else if a == self.sender {
            self.unsure = Some(Unsure::SenderBalance);
        } else if !self.view.balance_exact(a) {
            self.unsure = Some(Unsure::InexactBalance(a));
        }
    }
    fn other_read(&mut self, a: Address) {
        if self.unsure.is_none() && Some(a) == self.pretended {
            self.unsure = Some(Unsure::Pretended(a));
        }
    }
}

fn word_addr(w: revm::primitives::U256) -> Address {
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
            // GASPRICE / BASEFEE: only exact if we know the block's base fee.
            0x3a | 0x48 => {
                if !self.basefee_known && self.unsure.is_none() {
                    self.unsure = Some(Unsure::BaseFee);
                }
            }
            // EXTCODESIZE / EXTCODECOPY / EXTCODEHASH (addr)
            0x3b | 0x3c | 0x3f => {
                if let Ok(w) = interp.stack.peek(0) {
                    self.other_read(word_addr(w));
                }
            }
            _ => {}
        }
    }

    fn call(&mut self, _ctx: &mut CTX, inputs: &mut CallInputs) -> Option<CallOutcome> {
        self.other_read(inputs.target_address);
        self.other_read(inputs.bytecode_address);
        None
    }
}

/// Raw outcome of running one tx once.
struct RunOut {
    result: Result<ExecutionResult, EVMError<DbMiss>>,
    state: EvmState,
    missing: Vec<MissItem>,
    unsure: Option<Unsure>,
    pretended: Option<Address>,
    unsupported: Option<String>,
}

fn run_tx(view: &Snapshot, ctx: &BlockCtx, env: &ReplayEnv, tx: &FeedTx, collect: bool) -> RunOut {
    let mut db = if collect { ViewDb::collecting(view) } else { ViewDb::new(view) };
    // Unknown sender: pretend it (see file header).
    let pretended = match view.account(tx.from) {
        Lookup::Missing => {
            db.pretend.push((tx.from, AccountInfo { balance: tx.value, nonce: tx.nonce, code_hash: KECCAK_EMPTY, ..Default::default() }));
            Some(tx.from)
        }
        Lookup::Known(_) => None,
    };
    let watch = Watch { view, basefee_known: env.basefee_known, sender: tx.from, pretended, unsure: None };
    let mut evm = build_evm_with_inspector(db, ctx, &env.cfg, env.arbsys_gas, false, watch);
    // No gas fees charged or paid (see file header). Nonce / balance /
    // base-fee checks are already off (arb::configure_cfg).
    evm.ctx.cfg.disable_fee_charge = true;
    let result = evm.inspect_one_tx(tx.tx_env());
    let state = evm.finalize();
    let unsupported = evm.precompiles.unsupported().map(|u| u.to_string());
    RunOut {
        result,
        state,
        missing: std::mem::take(&mut evm.ctx.journaled_state.database.missing),
        unsure: evm.inspector.unsure,
        pretended,
        unsupported,
    }
}

/// What happened to one transaction.
pub enum TxOutcome {
    /// Replayed exactly. `success` = didn't revert/halt.
    Done { diff: StateDiff, touched: Vec<Address>, success: bool },
    /// Needs these items (fetch at the block before the message, retry).
    Miss(Vec<MissItem>),
    /// We can't replay this; ask the node for the block's changes.
    NeedTrace(String),
}

/// Is this item one we must never fetch (it changes inside every block)?
fn volatile_item(view: &Snapshot, m: &MissItem) -> bool {
    match m {
        MissItem::Account(a) | MissItem::Slot(a, _) => view.volatile.is_whole(a),
        MissItem::Code(_) => false,
    }
}

/// Replay one transaction exactly (strict mode).
pub fn replay_tx(view: &Snapshot, ctx: &BlockCtx, env: &ReplayEnv, tx: &FeedTx) -> TxOutcome {
    if !tx.replayable() {
        return TxOutcome::NeedTrace(format!("tx type {} not replayable", tx.tx_type));
    }
    let out = run_tx(view, ctx, env, tx, false);
    if let Some(u) = &out.unsupported {
        return TxOutcome::NeedTrace(u.clone());
    }
    let success = match &out.result {
        Ok(ExecutionResult::Success { .. }) => true,
        Ok(_) => false,
        Err(EVMError::Database(DbMiss::Miss(m))) => {
            if volatile_item(view, m) {
                return TxOutcome::NeedTrace(format!("needs ArbOS-internal state {m:?}"));
            }
            return TxOutcome::Miss(vec![m.clone()]);
        }
        Err(EVMError::Database(DbMiss::BlockHash(n))) => return TxOutcome::NeedTrace(format!("BLOCKHASH({n})")),
        Err(EVMError::Database(DbMiss::TooMany)) => return TxOutcome::NeedTrace("too many missing items".into()),
        Err(EVMError::Transaction(e)) => return TxOutcome::NeedTrace(format!("revm refused a sequenced tx: {e:?}")),
        Err(e) => return TxOutcome::NeedTrace(format!("engine: {e:?}")),
    };
    match out.unsure {
        Some(Unsure::InexactBalance(a)) | Some(Unsure::Pretended(a)) => return TxOutcome::Miss(vec![MissItem::Account(a)]),
        Some(Unsure::SenderBalance) => return TxOutcome::NeedTrace("tx reads its own sender's ETH balance".into()),
        Some(Unsure::BaseFee) => return TxOutcome::NeedTrace("tx reads BASEFEE/GASPRICE".into()),
        None => {}
    }
    let skip: Vec<Address> = out.pretended.into_iter().collect();
    let inexact = if skip.contains(&tx.from) { vec![] } else { vec![tx.from] };
    let diff = from_evm_state(&out.state, &inexact, &skip);
    let touched = out.state.keys().copied().collect();
    TxOutcome::Done { diff, touched, success }
}

/// One replayed transaction inside a message.
#[derive(Clone, Debug)]
pub struct TxSnap {
    pub hash: B256,
    /// State right after this tx.
    pub snap: Arc<Snapshot>,
    /// What this tx changed.
    pub diff: Arc<StateDiff>,
}

/// Result of replaying a whole message.
pub enum MsgOutcome {
    Done {
        /// State after the message.
        snap: Arc<Snapshot>,
        txs: Vec<TxSnap>,
        /// All changes of the message, merged.
        diff: StateDiff,
        /// Every account the message looked at.
        touched: Vec<Address>,
        /// How many txs reverted / halted.
        failed: usize,
    },
    NeedItems(Vec<MissItem>),
    NeedTrace(String),
}

/// Replay every transaction of `msg` on `base` (the state before it).
/// `pos` = where the resulting snapshots sit (block / seq of this message).
pub fn replay_message(base: &Arc<Snapshot>, msg: &FeedMessage, ctx: &BlockCtx, env: &ReplayEnv, pos: StatePosition) -> MsgOutcome {
    if !msg.complete() {
        return MsgOutcome::NeedTrace(msg.unreplayable.first().cloned().unwrap_or_else(|| format!("header kind {}", msg.kind)));
    }
    let mut cur = base.clone();
    let mut txs = Vec::with_capacity(msg.txs.len());
    let mut merged = StateDiff::default();
    let mut touched: HashSet<Address> = HashSet::new();
    let mut failed = 0usize;
    for (i, tx) in msg.txs.iter().enumerate() {
        match replay_tx(&cur, ctx, env, tx) {
            TxOutcome::Done { diff, touched: t, success } => {
                if !success {
                    failed += 1;
                }
                touched.extend(t);
                let mut next = (*cur).clone();
                next.apply_diff(&diff);
                next.pos = pos;
                cur = Arc::new(next);
                merge(&mut merged, &diff);
                txs.push(TxSnap { hash: tx.hash, snap: cur.clone(), diff: Arc::new(diff) });
            }
            TxOutcome::Miss(first) => return MsgOutcome::NeedItems(discover_more(&cur, ctx, env, &msg.txs[i..], first)),
            TxOutcome::NeedTrace(why) => return MsgOutcome::NeedTrace(format!("tx {}: {why}", tx.hash)),
        }
    }
    if msg.txs.is_empty() {
        let mut s = (*cur).clone();
        s.pos = pos;
        cur = Arc::new(s);
    }
    MsgOutcome::Done { snap: cur, txs, diff: merged, touched: touched.into_iter().collect(), failed }
}

/// After a miss: run the rest of the message in "collect" mode on a scratch
/// copy to discover (most of) what else it will need, so one node round trip
/// usually fixes the whole message. Results are discarded.
fn discover_more(from: &Arc<Snapshot>, ctx: &BlockCtx, env: &ReplayEnv, rest: &[FeedTx], first: Vec<MissItem>) -> Vec<MissItem> {
    let mut items = first;
    let mut scratch = (**from).clone();
    for tx in rest {
        if items.len() >= MAX_ITEMS_PER_ROUND || !tx.replayable() {
            break;
        }
        let out = run_tx(&scratch, ctx, env, tx, true);
        for m in out.missing {
            if !items.contains(&m) && !volatile_item(&scratch, &m) {
                items.push(m);
            }
        }
        if let Some(Unsure::InexactBalance(a) | Unsure::Pretended(a)) = out.unsure {
            let m = MissItem::Account(a);
            if !items.contains(&m) {
                items.push(m);
            }
        }
        if out.result.is_ok() {
            let skip: Vec<Address> = out.pretended.into_iter().collect();
            scratch.apply_diff(&from_evm_state(&out.state, &[], &skip));
        }
    }
    items.truncate(MAX_ITEMS_PER_ROUND);
    items
}

/// Block details for replaying a message (see arb/ notes: NUMBER = the
/// header's L1 block, never going backwards; timestamp never going backwards;
/// coinbase = the poster).
pub fn message_ctx(msg: &FeedMessage, prev: Option<&BlockCtx>, l2_block: u64, basefee: u64) -> BlockCtx {
    let (pl1, pts) = prev.map(|p| (p.l1_block_number, p.timestamp)).unwrap_or((0, 0));
    BlockCtx {
        l1_block_number: msg.l1_block.max(pl1),
        l2_block_number: Some(l2_block),
        timestamp: msg.timestamp.max(pts),
        basefee,
        coinbase: msg.sender.unwrap_or(arb::arbos::BATCH_POSTER_ADDRESS),
        gas_limit: arb::NITRO_BLOCK_GAS_LIMIT,
        prevrandao: arb::NITRO_PREVRANDAO,
    }
}
