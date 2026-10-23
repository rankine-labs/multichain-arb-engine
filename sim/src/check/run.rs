// ============================================================================
// run_calls(): run a list of calls in order, eth_call style.
//
// Plain English:
//   A "Session" is one check's scratch pad: an EVM on top of our chain copy
//   plus the request's pretend-state. Each call runs on the result of the
//   previous ones (like transactions in one block). Nothing is written back:
//   when the session ends, all its changes are simply dropped.
//
//   eth_call rules: gas price 0, no nonce / balance / base-fee checks, calls
//   may come "from" a contract. The gas we report is transaction-level gas
//   (21,000 base + calldata + execution, after refunds) - the same number a
//   node's eth_simulateV1 / callTracer gives.
//
//   Signed raw transactions (e.g. the trade we follow) run first with their
//   real sender, target, value, data, gas limit and access list (gas price 0,
//   like the node's own replay with validation off).
//
//   Size search needs to run the same trade many times at different sizes on
//   the same starting point. The session can "snapshot" its scratch state
//   (after the trigger was applied) and go back to it before each try, so the
//   trigger is run only once.
//
//   Anything uncertain = CheckUnknown (see mod.rs): a missing item, an
//   Arbitrum built-in contract we don't imitate, BLOCKHASH, a tx kind we
//   can't replay.
// ============================================================================
use std::sync::OnceLock;

use revm::context::{JournalInner, TxEnv};
use revm::context_interface::result::{EVMError, ExecutionResult, Output};
use revm::context_interface::transaction::{AccessList, AccessListItem};
use revm::primitives::{Address, Bytes, TxKind, U256};
use revm::ExecuteEvm;

use super::db::{CheckDb, DbErr};
use super::overrides::Overrides;
use super::rawtx::{decode_signed_tx, DecodedTx, UNSUPPORTED_TX_PREFIX};
use super::{CallOutcome, CallReq, CheckUnknown, UnknownReason, DEFAULT_CALL_GAS};
use crate::arb::{self, evm::ArbEvm, ArbConfig, BlockCtx};
use crate::state::{MissItem, StateRead};

/// revm EVM for one check: workstream B's Nitro-rules EVM (arb::evm) on our
/// CheckDb (database borrowed for the session).
pub type CheckEvm<'a> = ArbEvm<CheckDb<'a>>;

/// Which block details the calls see.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockEnvMode {
    /// Like a node's eth_call / eth_simulateV1 with gas price 0 (the bot's
    /// checks): BASEFEE and GASPRICE read 0. Default.
    EthCall,
    /// Like a mined transaction: BASEFEE = the block's base fee. Used for the
    /// offline fixtures (recorded on anvil with its real base fee).
    Mined,
}

/// Knobs for a check (defaults are what the sidecar uses).
#[derive(Clone, Copy, Debug)]
pub struct CheckOptions {
    /// true (default): on a missing item keep going and list ALL missing items
    /// the check touches (faster warm-up); the answer is still "unknown".
    /// false: stop at the first missing item.
    pub collect_misses: bool,
    /// Gas charged per ArbSys.arbBlockNumber() call (workstream B's number).
    pub arbsys_gas: u64,
    /// eth_call block details (default) or mined-block details.
    pub block_env: BlockEnvMode,
}

impl Default for CheckOptions {
    fn default() -> Self {
        CheckOptions { collect_misses: true, arbsys_gas: default_arbsys_gas(), block_env: BlockEnvMode::EthCall }
    }
}

/// ARBSYS_GAS env override (read once), else arb's default.
pub fn default_arbsys_gas() -> u64 {
    static G: OnceLock<u64> = OnceLock::new();
    *G.get_or_init(|| {
        std::env::var("ARBSYS_GAS").ok().and_then(|s| s.parse().ok()).unwrap_or(arb::ARBSYS_GAS_DEFAULT)
    })
}


/// Scratch state saved by `Session::snapshot` (to go back to it later).
#[derive(Clone)]
pub struct Snapshot(JournalInner<revm::context::JournalEntry>);

/// One check's scratch pad. Create, run calls, read answers, drop.
pub struct Session<'a> {
    evm: CheckEvm<'a>,
    /// First "can't be sure" problem met (beyond plain misses).
    fatal: Option<CheckUnknown>,
}

impl<'a> Session<'a> {
    /// New scratch pad on `view` + `overrides`, in block `ctx`.
    pub fn new(view: &'a dyn StateRead, ctx: &BlockCtx, overrides: &'a Overrides, opts: CheckOptions) -> Self {
        let db = CheckDb::new(view, overrides, opts.collect_misses);
        // B's builder: EVM rule set for the ArbOS version, Nitro opcodes,
        // Nitro precompiles with exact gas, eth_call settings.
        let ethcall = opts.block_env == BlockEnvMode::EthCall;
        let mut evm = arb::evm::build_evm(db, ctx, &ArbConfig::default(), opts.arbsys_gas, ethcall);
        // eth_call: no gas fee is charged or paid out at all. Same answers as
        // gas price 0, but the coinbase account is never loaded (it would
        // otherwise be a needless "missing" item on the live copy).
        evm.ctx.modify_cfg(|cfg| cfg.disable_fee_charge = true);
        // Arbitrum mode (we know the chain's own block number): touching a
        // Nitro built-in we don't imitate (even just its balance or code)
        // makes the answer unsure. Without it (plain-EVM test fixtures)
        // those addresses are ordinary empty accounts, like a test chain.
        if ctx.l2_block_number.is_some() {
            let unsupported: Vec<Address> =
                arb::arbitrum_builtin_addresses().into_iter().filter(|a| !evm.precompiles.implements(a)).collect();
            evm.ctx.journaled_state.database.set_unsupported_builtins(unsupported);
        }
        Session { evm, fatal: None }
    }

    /// Database (to read missing items, set size patches).
    pub fn db(&mut self) -> &mut CheckDb<'a> {
        &mut self.evm.ctx.journaled_state.database
    }

    /// Run one call on top of everything run so far in this session.
    /// Err = the check can't be answered for sure (stop the whole check).
    pub fn call(&mut self, req: &CallReq) -> Result<CallOutcome, CheckUnknown> {
        let tx = TxEnv {
            tx_type: 0,
            caller: req.from,
            gas_limit: req.gas.unwrap_or(DEFAULT_CALL_GAS),
            gas_price: 0,
            kind: req.to.map(TxKind::Call).unwrap_or(TxKind::Create),
            value: req.value,
            data: req.data.clone(),
            nonce: 0,
            chain_id: Some(arb::CHAIN_ID),
            ..Default::default()
        };
        self.run_tx(tx)
    }

    /// Apply one signed transaction (already decoded) with its real fields.
    pub fn apply_decoded(&mut self, t: &DecodedTx) -> Result<CallOutcome, CheckUnknown> {
        let tx = TxEnv {
            // Access-list txs keep their list (it changes gas exactly like on chain).
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
        };
        self.run_tx(tx)
    }

    /// Decode and apply signed raw transactions, in order.
    pub fn apply_raw_txs(&mut self, raw: &[Bytes]) -> Result<Vec<CallOutcome>, CheckUnknown> {
        let mut out = Vec::with_capacity(raw.len());
        for (i, r) in raw.iter().enumerate() {
            let t = decode_signed_tx(r).map_err(|e| {
                let reason = if e.starts_with(UNSUPPORTED_TX_PREFIX) { UnknownReason::UnsupportedTx } else { UnknownReason::BadRequest };
                CheckUnknown::new(reason, format!("rawTxs[{i}]: {e}"))
            })?;
            out.push(self.apply_decoded(&t)?);
        }
        Ok(out)
    }

    fn run_tx(&mut self, tx: TxEnv) -> Result<CallOutcome, CheckUnknown> {
        if let Some(f) = &self.fatal {
            return Err(f.clone());
        }
        let r = self.evm.transact_one(tx);
        let out = match r {
            Ok(ExecutionResult::Success { gas, output, .. }) => CallOutcome {
                success: true,
                output: match output {
                    Output::Call(b) => b,
                    Output::Create(b, _) => b,
                },
                gas_used: gas.tx_gas_used(),
                halt: None,
            },
            Ok(ExecutionResult::Revert { gas, output, .. }) => {
                CallOutcome { success: false, output, gas_used: gas.tx_gas_used(), halt: None }
            }
            Ok(ExecutionResult::Halt { gas, reason, .. }) => CallOutcome {
                success: false,
                output: Bytes::new(),
                gas_used: gas.tx_gas_used(),
                halt: Some(format!("{reason:?}")),
            },
            // The node refuses such a call too (e.g. gas below the 21,000
            // minimum): a definite "it fails", not an engine problem.
            Err(EVMError::Transaction(e)) => {
                CallOutcome { success: false, output: Bytes::new(), gas_used: 0, halt: Some(format!("invalid: {e:?}")) }
            }
            Err(EVMError::Database(e)) => return Err(self.fail(db_unknown(e, &self.evm.ctx.journaled_state.database.missing))),
            // B's precompiles abort the run with this text when it touches
            // Nitro code we don't imitate (ArbRetryableTx, NodeInterface,
            // Stylus contracts, ...).
            Err(EVMError::Custom(m)) if m.starts_with(arb::UNSUPPORTED_PRECOMPILE_PREFIX) || self.evm.precompiles.unsupported().is_some() => {
                return Err(self.fail(CheckUnknown::new(UnknownReason::UnsupportedPrecompile, m)))
            }
            Err(e) => return Err(self.fail(CheckUnknown::new(UnknownReason::Engine, format!("{e:?}")))),
        };
        Ok(out)
    }

    // Remember a fatal problem (later calls in this session can't be trusted either).
    fn fail(&mut self, u: CheckUnknown) -> CheckUnknown {
        self.fatal = Some(u.clone());
        u
    }

    /// Missing items noted so far (collect mode).
    pub fn missing(&self) -> &[MissItem] {
        &self.evm.ctx.journaled_state.database.missing
    }

    /// Final verdict on the session: Ok if everything it read was known.
    pub fn verdict(&self) -> Result<(), CheckUnknown> {
        if let Some(f) = &self.fatal {
            return Err(f.clone());
        }
        // Belt and braces: an unsupported Nitro hit is never a sure answer.
        if let Some(h) = self.evm.precompiles.unsupported() {
            return Err(CheckUnknown::new(UnknownReason::UnsupportedPrecompile, h.to_string()));
        }
        let m = self.missing();
        if !m.is_empty() {
            return Err(CheckUnknown { reason: UnknownReason::Miss, missing: m.to_vec(), detail: format!("{} item(s) not in our copy", m.len()) });
        }
        Ok(())
    }

    /// Save the scratch state (everything run so far).
    pub fn snapshot(&self) -> Snapshot {
        Snapshot(self.evm.ctx.journaled_state.inner.clone())
    }

    /// Go back to a saved scratch state.
    pub fn restore(&mut self, s: &Snapshot) {
        self.evm.ctx.journaled_state.inner = s.0.clone();
    }

    /// Set storage slots for the next run (size search: "the contract holds
    /// <this size> of the token"). Applied both to slots already in the
    /// scratch state and to slots read later from the database.
    pub fn set_slots(&mut self, slots: &[(Address, U256, U256)]) {
        let inner = &mut self.evm.ctx.journaled_state.inner;
        for (a, s, v) in slots {
            // Already in the scratch state (an earlier step read it): overwrite
            // in place as if it had always been this value. Its warm/cold
            // status is untouched, so gas stays exact.
            if let Some(slot) = inner.state.get_mut(a).and_then(|acc| acc.storage.get_mut(s)) {
                slot.present_value = *v;
                slot.original_value = *v;
            }
        }
        // Not loaded yet: the database hands out the patched value when asked.
        self.db().set_patches(slots.to_vec());
    }
}

// A database error -> "unknown" with the details.
pub(crate) fn db_unknown(e: DbErr, missing: &[MissItem]) -> CheckUnknown {
    match e {
        DbErr::Miss(_) | DbErr::TooManyMisses => CheckUnknown {
            reason: UnknownReason::Miss,
            missing: missing.to_vec(),
            detail: if matches!(e, DbErr::TooManyMisses) { "too many missing items".into() } else { "missing item".into() },
        },
        DbErr::UnsupportedBuiltin(a) => {
            CheckUnknown::new(UnknownReason::UnsupportedPrecompile, format!("Arbitrum built-in {a} is not imitated"))
        }
        DbErr::Unsupported(w) => CheckUnknown::new(UnknownReason::Engine, format!("unsupported: {w}")),
    }
}

/// Run `raw_txs` (signed, applied first) then `calls`, in order, each on top
/// of the previous ones' changes, with eth_call rules and `overrides`.
/// Nothing is written back to `view`.
pub fn run_calls(
    view: &dyn StateRead,
    ctx: &BlockCtx,
    overrides: &Overrides,
    raw_txs: &[Bytes],
    calls: &[CallReq],
) -> Result<Vec<CallOutcome>, CheckUnknown> {
    run_calls_opts(view, ctx, overrides, raw_txs, calls, CheckOptions::default())
}

/// Same as `run_calls`, with explicit options.
pub fn run_calls_opts(
    view: &dyn StateRead,
    ctx: &BlockCtx,
    overrides: &Overrides,
    raw_txs: &[Bytes],
    calls: &[CallReq],
    opts: CheckOptions,
) -> Result<Vec<CallOutcome>, CheckUnknown> {
    let mut s = Session::new(view, ctx, overrides, opts);
    s.apply_raw_txs(raw_txs)?;
    let mut out = Vec::with_capacity(calls.len());
    for c in calls {
        out.push(s.call(c)?);
    }
    s.verdict()?;
    Ok(out)
}
