// ============================================================================
// COPY 2 REPLAY (workstream B): keep V3 / PancakeSwap V3 / Algebra / Uniswap
// V4 pools current by RE-DOING each event's action with the pool's own code.
//
// Plain English:
//   A pool's events don't contain everything the pool changed (fee counters,
//   price history, the Algebra plugin's fee history...). But they DO contain
//   everything needed to do the same action again: who, how much, which
//   price range, the final price. So for each event we run that action again
//   on our copy of the pool, inside arbsim's private EVM (revm with Nitro
//   rules), with the pool's real code. The pool then updates every one of
//   its own storage slots exactly as on the chain. Proven offline: exact on
//   21,618 checks (bench/event-copy-test, "replay" rows).
//
//   How one replay works:
//     1. A pretend trader (ReplayHelper.sol, compiled code embedded below) is
//        placed at the SAME address that did the action on the chain (the
//        event's "sender"), so the pool sees the same caller.
//     2. Both coins of the pool are replaced, for this run only, by a tiny
//        stand-in coin (StubToken): the pool only asks "balanceOf" and moves
//        coins with "transfer". Real coin balances are kept separately by the
//        event intake (coin Transfer events), so nothing about the coins is
//        kept from the replay.
//     3. We run the action at the event's block (time, block numbers).
//     4. CHECK: the pool must emit exactly the same event (every topic and
//        every byte of data: amounts, final price, tick, liquidity, fees).
//        If it doesn't, the pool is UNSURE (never a guess).
//     5. Keep ONLY the storage changes of the real contracts that ran (the
//        pool, its Algebra plugin, a PancakeSwap farm, the V4 PoolManager);
//        throw away everything about the pretend trader and stand-in coins.
//   Anything our copy doesn't have (MISSING, never zero) -> NeedItems(list):
//   the intake fetches those from the node and calls again with the SAME log.
//
//   A swap event doesn't say whether the trader asked for "exactly X in" or
//   "exactly Y out" or "stop at price P". We try those in order and keep the
//   first one that reproduces the event exactly (same as the offline proof).
//
// Algebra specifics:
//   - The pool asks its PLUGIN for the fee on every swap (the plugin keeps a
//     price history). Re-running the pool's swap runs the plugin too, so the
//     plugin's storage follows exactly.
//   - Algebra keeps "reserves" and counts coins sent to it without a trade
//     as extra fees. It reports that with an ExcessTokens event, BEFORE the
//     action's main event (Swap / Mint / Burn / Flash). Some actions also
//     report extra events before (Fee) or after (SwapFee, BurnFee) the main
//     one. So for Algebra we keep short "notes" between logs of the same
//     transaction (stored in our copy under a private made-up address, see
//     notes_address()): side events seen before the main event are written
//     down, and the replay of the main event must produce exactly those
//     events too; side events the replay produced after the main event must
//     then arrive from the chain, in that order.
//     If side events are left over when the transaction ends (e.g. coins
//     counted by a plugin-triggered sync), they are applied on their own:
//     ExcessTokens by running the pool's own sync(); anything else = UNSURE.
//     THE INTAKE MUST CALL finish_block() for every Algebra pool that had
//     events, after the block's last event and before publishing the block.
//
// Interface (agreed with workstream A, see copy2/overlay.rs):
//   apply_replay(db, pool, log, ctx) -> ApplyResult
//   finish_block(db, pool, ctx) -> ApplyResult
//   has_pending(db, pool) -> bool, notes_address(pool) -> Address
//   - `db` is changed ONLY when the answer is Applied.
//   - Token (coin) contract slots are never written here.
//   - V4: only the pool's own events (topic 1 = the pool id) are applied;
//     the PoolManager's claim-token (ERC-6909) events are accepted and
//     ignored (they don't change any pool's prices or liquidity).
// ============================================================================
use std::sync::OnceLock;

use revm::context::TxEnv;
use revm::context_interface::result::{EVMError, ExecutionResult, Output};
use revm::database_interface::Database;
use revm::primitives::{keccak256, Address, Bytes, Log, StorageKey, StorageValue, TxKind, B256, KECCAK_EMPTY, U256};
use revm::state::{AccountInfo, Bytecode, EvmState};
use revm::ExecuteEvm;

use super::overlay::Overlay;
use super::{word, ApplyResult, BlockCtx, PoolKind, PoolLog, TrackedPool};
use crate::arb::{self, ArbConfig};
use crate::state::db::{DbMiss, MAX_COLLECT};
use crate::state::{AccountDiff, Lookup, MissItem, StateDiff, StateRead};

// ---------------------------------------------------------------------------
// Embedded compiled code (built by sim/tools/copy2/build.js from
// ReplayHelper.sol in this folder).
// ---------------------------------------------------------------------------
const HELPER_HEX: &str = include_str!("replay_helper.hex");
const STUB_TOKEN_HEX: &str = include_str!("stub_token.hex");

/// Made-up address that sends the replay transactions (never a real account).
pub const REPLAY_CALLER: Address = Address::new([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xc0, 0xb2, 0xfe, 0xed,
]);
/// Gas for one replay run (far more than any pool action needs).
const REPLAY_GAS: u64 = 30_000_000;
/// Starting coin balance of everyone except the pool, in the stand-in coin
/// (and ETH of the pretend trader): plenty, and far from any overflow.
fn big() -> U256 {
    U256::from(1u8) << 160
}

/// (code hash, code) of an embedded hex file, analysed once.
fn code_of(hex: &'static str, cell: &'static OnceLock<(B256, Bytecode)>) -> &'static (B256, Bytecode) {
    cell.get_or_init(|| {
        let b = crate::check::hexutil::parse_bytes(hex.trim()).expect("embedded replay code is valid hex");
        assert!(!b.is_empty(), "embedded replay code is empty (run sim/tools/copy2/build.js)");
        (keccak256(&b), Bytecode::new_raw(b))
    })
}
fn helper_code() -> &'static (B256, Bytecode) {
    static C: OnceLock<(B256, Bytecode)> = OnceLock::new();
    code_of(HELPER_HEX, &C)
}
fn stub_code() -> &'static (B256, Bytecode) {
    static C: OnceLock<(B256, Bytecode)> = OnceLock::new();
    code_of(STUB_TOKEN_HEX, &C)
}

// ---------------------------------------------------------------------------
// Event and function identifiers.
// ---------------------------------------------------------------------------
fn topic(sig: &str) -> B256 {
    keccak256(sig.as_bytes())
}
fn sel(sig: &str) -> [u8; 4] {
    let h = keccak256(sig.as_bytes());
    [h[0], h[1], h[2], h[3]]
}

/// Event ids (topic 0) we understand, computed once.
struct Topics {
    // Uniswap V3 (and the same shapes in PancakeSwap V3 / Algebra Integral 1.2)
    swap: B256,
    mint: B256,
    burn: B256,
    collect: B256,
    flash: B256,
    obs_next: B256,
    init_v3: B256,
    fee_protocol_v3: B256,
    collect_protocol: B256,
    // PancakeSwap V3 only
    swap_pancake: B256,
    fee_protocol_pancake: B256,
    set_lm_pool: B256,
    // Algebra Integral 1.2 side events
    excess_tokens: B256,
    // Uniswap V4 PoolManager
    v4_swap: B256,
    v4_modify: B256,
    v4_donate: B256,
    v4_init: B256,
    v4_protocol_fee: B256,
    erc6909_transfer: B256,
    erc6909_approval: B256,
    erc6909_operator: B256,
}

fn topics() -> &'static Topics {
    static T: OnceLock<Topics> = OnceLock::new();
    T.get_or_init(|| Topics {
        swap: topic("Swap(address,address,int256,int256,uint160,uint128,int24)"),
        mint: topic("Mint(address,address,int24,int24,uint128,uint256,uint256)"),
        burn: topic("Burn(address,int24,int24,uint128,uint256,uint256)"),
        collect: topic("Collect(address,address,int24,int24,uint128,uint128)"),
        flash: topic("Flash(address,address,uint256,uint256,uint256,uint256)"),
        obs_next: topic("IncreaseObservationCardinalityNext(uint16,uint16)"),
        init_v3: topic("Initialize(uint160,int24)"),
        fee_protocol_v3: topic("SetFeeProtocol(uint8,uint8,uint8,uint8)"),
        collect_protocol: topic("CollectProtocol(address,address,uint128,uint128)"),
        swap_pancake: topic("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)"),
        fee_protocol_pancake: topic("SetFeeProtocol(uint32,uint32,uint32,uint32)"),
        set_lm_pool: topic("SetLmPoolEvent(address)"),
        excess_tokens: topic("ExcessTokens(uint256,uint256)"),
        v4_swap: topic("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"),
        v4_modify: topic("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)"),
        v4_donate: topic("Donate(bytes32,address,uint256,uint256)"),
        v4_init: topic("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"),
        v4_protocol_fee: topic("ProtocolFeeUpdated(bytes32,uint24)"),
        erc6909_transfer: topic("Transfer(address,address,address,uint256,uint256)"),
        erc6909_approval: topic("Approval(address,address,uint256,uint256)"),
        erc6909_operator: topic("OperatorSet(address,address,bool)"),
    })
}

// ---------------------------------------------------------------------------
// Small ABI helpers (all arguments here are fixed-size words).
// ---------------------------------------------------------------------------
fn addr_word(a: Address) -> U256 {
    U256::from_be_slice(a.as_slice())
}
fn word_addr(w: U256) -> Address {
    Address::from_slice(&w.to_be_bytes::<32>()[12..])
}
fn topic_addr(t: &B256) -> Address {
    Address::from_slice(&t[12..])
}
fn topic_word(t: &B256) -> U256 {
    U256::from_be_bytes(t.0)
}
/// Two's complement: is this signed word negative?
fn is_neg(w: U256) -> bool {
    w.bit(255)
}
/// Two's complement negation of a signed word.
fn neg(w: U256) -> U256 {
    (!w).wrapping_add(U256::from(1u8))
}
/// Signed word from a small signed number.
fn int_word(v: i128) -> U256 {
    if v < 0 {
        neg(U256::from(v.unsigned_abs()))
    } else {
        U256::from(v as u128)
    }
}
/// Calldata: selector + words.
fn call(sig: &str, words: &[U256]) -> Bytes {
    let mut out = Vec::with_capacity(4 + 32 * words.len());
    out.extend_from_slice(&sel(sig));
    for w in words {
        out.extend_from_slice(&w.to_be_bytes::<32>());
    }
    Bytes::from(out)
}
/// Storage slot of mapping[key] for a mapping at `base` (Solidity rule).
fn map_slot(key: U256, base: U256) -> U256 {
    let mut b = [0u8; 64];
    b[..32].copy_from_slice(&key.to_be_bytes::<32>());
    b[32..].copy_from_slice(&base.to_be_bytes::<32>());
    U256::from_be_bytes(keccak256(b).0)
}
/// Hash identifying one log (address + topics + data), for the Algebra notes.
fn log_hash(address: Address, topics: &[B256], data: &[u8]) -> B256 {
    let mut b = Vec::with_capacity(20 + 32 * topics.len() + data.len() + 1);
    b.extend_from_slice(address.as_slice());
    b.push(topics.len() as u8);
    for t in topics {
        b.extend_from_slice(t.as_slice());
    }
    b.extend_from_slice(data);
    keccak256(b)
}
fn revm_log_hash(l: &Log) -> B256 {
    log_hash(l.address, l.data.topics(), &l.data.data)
}
fn same_log(l: &Log, p: &PoolLog) -> bool {
    l.address == p.address && l.data.topics() == p.topics.as_slice() && l.data.data == p.data
}

// ---------------------------------------------------------------------------
// The private EVM's database: our copy (strict) + the pretend pieces.
// ---------------------------------------------------------------------------

/// What to pretend during one replay run.
#[derive(Clone, Debug, Default)]
struct Pretend {
    /// Addresses that run ReplayHelper code (the event's sender).
    helpers: Vec<Address>,
    /// Coin addresses replaced by StubToken.
    stubs: Vec<Address>,
    /// Starting stand-in coin balances that are NOT the default "plenty":
    /// (coin, storage slot, value). Used for the Algebra pool's own balance.
    seeds: Vec<(Address, U256, U256)>,
    /// Accounts we don't need to know (callers): empty if we don't have them.
    callers: Vec<Address>,
    /// Accounts given plenty of ETH (V4 PoolManager pays out native ETH).
    rich: Vec<Address>,
}

impl Pretend {
    /// Accounts whose changes are never kept.
    fn is_pretend(&self, a: &Address) -> bool {
        *a == REPLAY_CALLER || self.helpers.contains(a) || self.stubs.contains(a) || self.callers.contains(a)
    }
}

struct ReplayDb<'a> {
    view: &'a dyn StateRead,
    p: &'a Pretend,
    /// Missing items seen (collect mode: keep going to find them all at once;
    /// the run's result is then thrown away, only the list is used).
    missing: Vec<MissItem>,
}

impl ReplayDb<'_> {
    fn miss<T>(&mut self, m: MissItem, guess: T) -> Result<T, DbMiss> {
        if !self.missing.contains(&m) {
            self.missing.push(m);
        }
        if self.missing.len() >= MAX_COLLECT {
            return Err(DbMiss::TooMany);
        }
        Ok(guess)
    }
}

impl Database for ReplayDb<'_> {
    type Error = DbMiss;

    fn basic(&mut self, address: Address) -> Result<Option<AccountInfo>, DbMiss> {
        if self.p.helpers.contains(&address) {
            let (h, c) = helper_code();
            return Ok(Some(AccountInfo { balance: big(), nonce: 1, code_hash: *h, code: Some(c.clone()), ..Default::default() }));
        }
        if self.p.stubs.contains(&address) {
            let (h, c) = stub_code();
            return Ok(Some(AccountInfo { nonce: 1, code_hash: *h, code: Some(c.clone()), ..Default::default() }));
        }
        let rich = self.p.rich.contains(&address);
        match self.view.account(address) {
            Lookup::Known(Some(mut info)) => {
                if info.code.is_none() && info.code_hash != KECCAK_EMPTY && !info.code_hash.is_zero() {
                    match self.view.code_by_hash(info.code_hash) {
                        Lookup::Known(c) => info.code = Some(c),
                        Lookup::Missing => return self.miss(MissItem::Account(address), None),
                    }
                }
                if rich && info.balance < big() {
                    info.balance = big();
                }
                Ok(Some(info))
            }
            Lookup::Known(None) => {
                if rich {
                    return Ok(Some(AccountInfo { balance: big(), ..Default::default() }));
                }
                Ok(None)
            }
            Lookup::Missing => {
                if address == REPLAY_CALLER || self.p.callers.contains(&address) {
                    return Ok(Some(AccountInfo::default()));
                }
                self.miss(MissItem::Account(address), None)
            }
        }
    }

    fn code_by_hash(&mut self, code_hash: B256) -> Result<Bytecode, DbMiss> {
        if code_hash == KECCAK_EMPTY || code_hash.is_zero() {
            return Ok(Bytecode::default());
        }
        for (h, c) in [helper_code(), stub_code()] {
            if *h == code_hash {
                return Ok(c.clone());
            }
        }
        match self.view.code_by_hash(code_hash) {
            Lookup::Known(c) => Ok(c),
            Lookup::Missing => self.miss(MissItem::Code(code_hash), Bytecode::default()),
        }
    }

    fn storage(&mut self, address: Address, index: StorageKey) -> Result<StorageValue, DbMiss> {
        if self.p.stubs.contains(&address) {
            for (a, s, v) in &self.p.seeds {
                if *a == address && *s == index {
                    return Ok(*v);
                }
            }
            return Ok(big());
        }
        if self.p.helpers.contains(&address) {
            // ReplayHelper has no storage of its own.
            return Ok(U256::ZERO);
        }
        match self.view.storage(address, index) {
            Lookup::Known(v) => Ok(v),
            Lookup::Missing => self.miss(MissItem::Slot(address, index), U256::ZERO),
        }
    }

    fn block_hash(&mut self, number: u64) -> Result<B256, DbMiss> {
        Err(DbMiss::BlockHash(number))
    }
}

// ---------------------------------------------------------------------------
// Running calls in the private EVM.
// ---------------------------------------------------------------------------

/// Why a replay attempt could not finish.
#[derive(Debug)]
enum Stop {
    /// Our copy lacks these items.
    Need(Vec<MissItem>),
    /// Something we can't do exactly.
    Unsure(String),
}

/// One call to make: (from, to, calldata, ETH value).
#[derive(Clone, Debug)]
struct Call {
    from: Address,
    to: Address,
    data: Bytes,
}

/// What a run of one or more calls did.
struct RunOut {
    /// Every call succeeded.
    ok: bool,
    /// Output of the last call.
    output: Bytes,
    /// Logs of all calls, in order.
    logs: Vec<Log>,
    /// Everything touched (to pick out the storage changes we keep).
    state: EvmState,
}

/// The block details the pool code sees (Nitro: NUMBER = parent-chain block).
fn arb_ctx(ctx: &BlockCtx) -> arb::BlockCtx {
    arb::BlockCtx {
        l1_block_number: ctx.l1_number,
        l2_block_number: Some(ctx.number),
        timestamp: ctx.timestamp,
        basefee: 0,
        coinbase: arb::arbos::BATCH_POSTER_ADDRESS,
        gas_limit: arb::NITRO_BLOCK_GAS_LIMIT,
        prevrandao: B256::ZERO,
    }
}

/// Run `calls` in order (each sees the previous ones' changes) on `view`.
fn run(view: &dyn StateRead, p: &Pretend, ctx: &BlockCtx, calls: &[Call]) -> Result<RunOut, Stop> {
    let db = ReplayDb { view, p, missing: Vec::new() };
    let mut evm = arb::evm::build_evm(db, &arb_ctx(ctx), &ArbConfig::default(), arb::ARBSYS_GAS_DEFAULT, true);
    // No gas fees at all (like eth_call): the coinbase is never touched.
    evm.ctx.modify_cfg(|cfg| cfg.disable_fee_charge = true);
    let mut ok = true;
    let mut output = Bytes::new();
    let mut logs = Vec::new();
    for c in calls {
        let tx = TxEnv {
            tx_type: 0,
            caller: c.from,
            gas_limit: REPLAY_GAS,
            gas_price: 0,
            kind: TxKind::Call(c.to),
            value: U256::ZERO,
            data: c.data.clone(),
            nonce: 0,
            chain_id: Some(arb::CHAIN_ID),
            ..Default::default()
        };
        match evm.transact_one(tx) {
            Ok(ExecutionResult::Success { output: o, logs: l, .. }) => {
                output = match o {
                    Output::Call(b) => b,
                    Output::Create(b, _) => b,
                };
                logs.extend(l);
            }
            Ok(_) => {
                ok = false;
                break;
            }
            Err(EVMError::Database(DbMiss::BlockHash(n))) => return Err(Stop::Unsure(format!("pool code asked for block hash {n}"))),
            Err(EVMError::Database(_)) => {}
            Err(e) => return Err(Stop::Unsure(format!("engine: {e:?}"))),
        }
        if !evm.ctx.journaled_state.database.missing.is_empty() {
            break;
        }
    }
    let missing = std::mem::take(&mut evm.ctx.journaled_state.database.missing);
    if !missing.is_empty() {
        return Err(Stop::Need(missing));
    }
    if let Some(u) = evm.precompiles.unsupported() {
        return Err(Stop::Unsure(format!("pool code touched {u}")));
    }
    let state = evm.finalize();
    Ok(RunOut { ok, output, logs, state })
}

/// A read-only call to a real contract on our copy (pool getters).
fn view_call(view: &dyn StateRead, ctx: &BlockCtx, to: Address, data: Bytes) -> Result<Option<Bytes>, Stop> {
    let p = Pretend::default();
    let r = run(view, &p, ctx, &[Call { from: REPLAY_CALLER, to, data }])?;
    Ok(if r.ok { Some(r.output) } else { None })
}

/// Getter returning one address (e.g. token0(), factory(), plugin()).
fn view_addr(view: &dyn StateRead, ctx: &BlockCtx, to: Address, sig: &str) -> Result<Address, Stop> {
    match view_call(view, ctx, to, call(sig, &[]))? {
        Some(o) if o.len() >= 32 => Ok(word_addr(word(&o, 0))),
        _ => Err(Stop::Unsure(format!("{sig} on {to} did not answer"))),
    }
}

/// Storage changes to keep: every slot of a REAL contract (not pretend)
/// whose value after the run differs from our copy's value before.
fn kept_changes(view: &dyn StateRead, p: &Pretend, state: &EvmState) -> Result<StateDiff, Stop> {
    let mut d = StateDiff::default();
    for (addr, acc) in state.iter() {
        if p.is_pretend(addr) {
            continue;
        }
        if acc.is_selfdestructed() || acc.is_created() {
            return Err(Stop::Unsure(format!("replay created or destroyed {addr}")));
        }
        let mut ad = AccountDiff::default();
        for (slot, s) in acc.storage.iter() {
            let before = match view.storage(*addr, *slot) {
                Lookup::Known(v) => v,
                // Only possible for a slot the run wrote without reading;
                // SSTORE always reads first, so this means something is off.
                Lookup::Missing => return Err(Stop::Need(vec![MissItem::Slot(*addr, *slot)])),
            };
            if s.present_value != before {
                ad.storage.insert(*slot, s.present_value);
            }
        }
        if !ad.storage.is_empty() {
            d.accounts.insert(*addr, ad);
        }
    }
    Ok(d)
}

/// Read one slot of our copy (strict).
fn slot(view: &dyn StateRead, a: Address, s: U256) -> Result<U256, Stop> {
    match view.storage(a, s) {
        Lookup::Known(v) => Ok(v),
        Lookup::Missing => Err(Stop::Need(vec![MissItem::Slot(a, s)])),
    }
}

/// The result of trying a list of candidate replays.
enum Tried {
    /// This candidate reproduced the event: storage changes + all its logs.
    Hit(StateDiff, Vec<Log>),
    /// None matched; why (for the Unsure text).
    Miss(String),
}

/// Try candidate runs in order; the first one whose pool logs pass `accept`
/// wins. Missing items stop everything (the copy must be filled first).
fn try_runs(
    view: &dyn StateRead,
    p: &Pretend,
    ctx: &BlockCtx,
    candidates: &[(&str, Vec<Call>)],
    accept: &dyn Fn(&RunOut) -> Result<(), String>,
) -> Result<Tried, Stop> {
    let mut why = Vec::new();
    for (name, calls) in candidates {
        let r = run(view, p, ctx, calls)?;
        if !r.ok {
            why.push(format!("{name}: reverted"));
            continue;
        }
        match accept(&r) {
            Ok(()) => {
                let d = kept_changes(view, p, &r.state)?;
                return Ok(Tried::Hit(d, r.logs));
            }
            Err(e) => why.push(format!("{name}: {e}")),
        }
    }
    Ok(Tried::Miss(why.join("; ")))
}

/// Pool logs of a run (logs emitted by `pool`).
fn pool_logs(r: &RunOut, pool: Address) -> Vec<&Log> {
    r.logs.iter().filter(|l| l.address == pool).collect()
}

// ---------------------------------------------------------------------------
// Public entry points.
// ---------------------------------------------------------------------------

/// Apply one V3 / PancakeV3 / Algebra / V4 event to `db` by replay.
/// `db` is changed only when the answer is `Applied`.
pub fn apply_replay(db: &mut Overlay, pool: &TrackedPool, log: &PoolLog, ctx: &BlockCtx) -> ApplyResult {
    if log.removed {
        return ApplyResult::Unsure("reorg: the node took this event back".into());
    }
    if log.address != pool.address {
        return ApplyResult::Unsure(format!("event from {} given for pool {}", log.address, pool.address));
    }
    if log.topics.is_empty() {
        return ApplyResult::Unsure("event without topics".into());
    }
    let r = match pool.kind {
        PoolKind::V3 | PoolKind::PancakeV3 => v3_family(db, pool, log, ctx),
        PoolKind::Algebra => algebra(db, pool, log, ctx),
        PoolKind::V4 => v4(db, pool, log, ctx),
        PoolKind::V2 | PoolKind::Solidly => Err(Stop::Unsure("V2 / Solidly pools are applied from event fields, not replay".into())),
    };
    match r {
        Ok(diff) => {
            db.commit(&diff);
            ApplyResult::Applied
        }
        Err(Stop::Need(items)) => ApplyResult::NeedItems(items),
        Err(Stop::Unsure(why)) => ApplyResult::Unsure(why),
    }
}

/// End of a block for one pool: apply any Algebra side events still waiting
/// (see file header). No-op for other kinds. Call it after the block's last
/// event and before publishing the block.
pub fn finish_block(db: &mut Overlay, pool: &TrackedPool, ctx: &BlockCtx) -> ApplyResult {
    if pool.kind != PoolKind::Algebra {
        return ApplyResult::Applied;
    }
    let notes = Notes::load(db, pool.address);
    if notes.is_empty() {
        return ApplyResult::Applied;
    }
    let mut fork = db.fork();
    match flush_notes(&mut fork, pool, &notes, ctx) {
        Ok(()) => {
            Notes::default().store(&mut fork, pool.address, &notes);
            db.commit(fork.changes());
            ApplyResult::Applied
        }
        Err(Stop::Need(items)) => ApplyResult::NeedItems(items),
        Err(Stop::Unsure(why)) => ApplyResult::Unsure(why),
    }
}

/// Does this pool have Algebra side events waiting for their main event?
/// (While true, the pool's copy is not final for the block.)
pub fn has_pending(db: &Overlay, pool: &TrackedPool) -> bool {
    pool.kind == PoolKind::Algebra && !Notes::load(db, pool.address).is_empty()
}

// ---------------------------------------------------------------------------
// Uniswap V3 and PancakeSwap V3.
// ---------------------------------------------------------------------------

/// Candidate swap replays for a V3-style Swap event (V3, Pancake, Algebra):
/// exact in, exact out, each without and with the event's price as limit,
/// "as much as needed up to the event's price", and a tiny amount up to the
/// event's price (a swap through a range with no liquidity: 0/0 amounts).
fn v3_swap_candidates(pool: Address, sender: Address, recipient: Address, zero_for_one: bool, a0: U256, a1: U256, sqrt: U256) -> Vec<(&'static str, Vec<Call>)> {
    let amt_in = if zero_for_one { a0 } else { a1 };
    let amt_out = if zero_for_one { neg(a1) } else { neg(a0) };
    let huge = U256::from(1u8) << 200;
    let one = U256::from(1u8);
    let tries: [(&str, U256, U256); 8] = [
        ("exactIn", amt_in, U256::ZERO),
        ("exactOut", neg(amt_out), U256::ZERO),
        ("exactIn+limit", amt_in, sqrt),
        ("exactOut+limit", neg(amt_out), sqrt),
        ("toPrice", huge, sqrt),
        ("toPriceOut", neg(huge), sqrt),
        ("tinyIn", one, sqrt),
        ("tinyOut", neg(one), sqrt),
    ];
    let mut out = Vec::new();
    for (name, amount, limit) in tries {
        if amount.is_zero() {
            continue; // pools refuse a zero amount
        }
        let data = call(
            "swap(address,address,bool,int256,uint160)",
            &[addr_word(pool), addr_word(recipient), U256::from(zero_for_one as u8), amount, limit],
        );
        out.push((name, vec![Call { from: REPLAY_CALLER, to: sender, data }]));
    }
    out
}

/// Direction of a V3-style swap from its event: coin 0 paid in = zeroForOne;
/// if no coins moved (0/0), the price fell = zeroForOne.
fn v3_direction(a0: U256, a1: U256, sqrt_after: U256, sqrt_before: impl FnOnce() -> Result<U256, Stop>) -> Result<bool, Stop> {
    if !a0.is_zero() || !a1.is_zero() {
        return Ok(!a0.is_zero() && !is_neg(a0));
    }
    Ok(sqrt_after < sqrt_before()?)
}

/// The pretend setup shared by V3-style replays: helper at `helpers`, the
/// pool's two coins as stand-ins.
fn v3_pretend(view: &dyn StateRead, pool: &TrackedPool, ctx: &BlockCtx, helpers: Vec<Address>, callers: Vec<Address>) -> Result<Pretend, Stop> {
    // The coins the pool's own code will pay with (its token0()/token1()).
    let t0 = view_addr(view, ctx, pool.address, "token0()")?;
    let t1 = view_addr(view, ctx, pool.address, "token1()")?;
    if (pool.token0 != Address::ZERO && pool.token0 != t0) || (pool.token1 != Address::ZERO && pool.token1 != t1) {
        return Err(Stop::Unsure(format!("pool's coins {t0}/{t1} differ from the tracked ones")));
    }
    for h in helpers.iter().chain(callers.iter()) {
        if *h == t0 || *h == t1 || *h == pool.address {
            return Err(Stop::Unsure(format!("event sender {h} is the pool or one of its coins")));
        }
    }
    Ok(Pretend { helpers, stubs: vec![t0, t1], seeds: Vec::new(), callers, rich: Vec::new() })
}

/// Accept a run whose pool logs are exactly [the event].
fn exactly_the_event(pool: Address, log: &PoolLog) -> impl Fn(&RunOut) -> Result<(), String> + '_ {
    move |r: &RunOut| {
        let pl = pool_logs(r, pool);
        if pl.len() == 1 && same_log(pl[0], log) {
            Ok(())
        } else {
            Err(describe_mismatch(&pl, log))
        }
    }
}

fn describe_mismatch(pl: &[&Log], log: &PoolLog) -> String {
    match pl.iter().find(|l| l.data.topics().first() == log.topics.first()) {
        Some(l) => format!("event differs (replay data {} vs chain {})", hexs(&l.data.data), hexs(&log.data)),
        None => format!("replay emitted {} pool events, none like the chain's", pl.len()),
    }
}

fn hexs(b: &[u8]) -> String {
    crate::check::hexutil::to_hex(b)
}

fn v3_family(db: &mut Overlay, pool: &TrackedPool, log: &PoolLog, ctx: &BlockCtx) -> Result<StateDiff, Stop> {
    let t = topics();
    let view: &dyn StateRead = db;
    let pa = pool.address;
    let t0 = log.topics[0];
    let d = &log.data[..];
    let pancake = pool.kind == PoolKind::PancakeV3;
    let is_swap = t0 == t.swap || (pancake && t0 == t.swap_pancake);
    if (pancake && t0 == t.swap) || (!pancake && t0 == t.swap_pancake) {
        return Err(Stop::Unsure("Swap event of the other V3 flavour (check the pool kind)".into()));
    }
    let need_topics = |n: usize| -> Result<(), Stop> {
        if log.topics.len() < n {
            Err(Stop::Unsure("event has too few topics".into()))
        } else {
            Ok(())
        }
    };
    let accept = exactly_the_event(pa, log);

    let (pretend, candidates): (Pretend, Vec<(&str, Vec<Call>)>) = if is_swap {
        need_topics(3)?;
        let (sender, recipient) = (topic_addr(&log.topics[1]), topic_addr(&log.topics[2]));
        let (a0, a1, sqrt) = (word(d, 0), word(d, 1), word(d, 2));
        // slot0 is slot 0 in both layouts; price = its low 160 bits.
        let zfo = v3_direction(a0, a1, sqrt, || Ok(slot(view, pa, U256::ZERO)? & ((U256::from(1u8) << 160) - U256::from(1u8))))?;
        let p = v3_pretend(view, pool, ctx, vec![sender], vec![])?;
        (p, v3_swap_candidates(pa, sender, recipient, zfo, a0, a1, sqrt))
    } else if t0 == t.mint {
        need_topics(4)?;
        let (owner, lo, hi) = (topic_addr(&log.topics[1]), topic_word(&log.topics[2]), topic_word(&log.topics[3]));
        let sender = word_addr(word(d, 0));
        let p = v3_pretend(view, pool, ctx, vec![sender], vec![])?;
        let data = call("mint(address,address,int24,int24,uint128)", &[addr_word(pa), addr_word(owner), lo, hi, word(d, 1)]);
        (p, vec![("mint", vec![Call { from: REPLAY_CALLER, to: sender, data }])])
    } else if t0 == t.burn {
        need_topics(4)?;
        let (owner, lo, hi) = (topic_addr(&log.topics[1]), topic_word(&log.topics[2]), topic_word(&log.topics[3]));
        let p = v3_pretend(view, pool, ctx, vec![], vec![owner])?;
        let data = call("burn(int24,int24,uint128)", &[lo, hi, word(d, 0)]);
        (p, vec![("burn", vec![Call { from: owner, to: pa, data }])])
    } else if t0 == t.collect {
        need_topics(4)?;
        let (owner, lo, hi) = (topic_addr(&log.topics[1]), topic_word(&log.topics[2]), topic_word(&log.topics[3]));
        let p = v3_pretend(view, pool, ctx, vec![], vec![owner])?;
        let data = call("collect(address,int24,int24,uint128,uint128)", &[word(d, 0), lo, hi, word(d, 1), word(d, 2)]);
        (p, vec![("collect", vec![Call { from: owner, to: pa, data }])])
    } else if t0 == t.flash {
        need_topics(3)?;
        let (sender, recipient) = (topic_addr(&log.topics[1]), topic_addr(&log.topics[2]));
        let p = v3_pretend(view, pool, ctx, vec![sender], vec![])?;
        let data = call(
            "flash(address,address,uint256,uint256,uint256,uint256)",
            &[addr_word(pa), addr_word(recipient), word(d, 0), word(d, 1), word(d, 2), word(d, 3)],
        );
        (p, vec![("flash", vec![Call { from: REPLAY_CALLER, to: sender, data }])])
    } else if t0 == t.obs_next {
        let p = v3_pretend(view, pool, ctx, vec![], vec![])?;
        let data = call("increaseObservationCardinalityNext(uint16)", &[word(d, 1)]);
        (p, vec![("growHistory", vec![Call { from: REPLAY_CALLER, to: pa, data }])])
    } else if t0 == t.init_v3 {
        let p = v3_pretend(view, pool, ctx, vec![], vec![])?;
        let data = call("initialize(uint160)", &[word(d, 0)]);
        (p, vec![("initialize", vec![Call { from: REPLAY_CALLER, to: pa, data }])])
    } else if (!pancake && t0 == t.fee_protocol_v3) || (pancake && t0 == t.fee_protocol_pancake) || t0 == t.collect_protocol || (pancake && t0 == t.set_lm_pool) {
        // Owner-only settings: run them as the address allowed to (Uniswap:
        // the factory's owner; PancakeSwap: the factory itself).
        let factory = view_addr(view, ctx, pa, "factory()")?;
        let admin = if pancake { factory } else { view_addr(view, ctx, factory, "owner()")? };
        let p = v3_pretend(view, pool, ctx, vec![], vec![admin])?;
        let data = if t0 == t.collect_protocol {
            need_topics(3)?;
            call("collectProtocol(address,uint128,uint128)", &[topic_word(&log.topics[2]), word(d, 0), word(d, 1)])
        } else if t0 == t.set_lm_pool {
            call("setLmPool(address)", &[word(d, 0)])
        } else if pancake {
            call("setFeeProtocol(uint32,uint32)", &[word(d, 2), word(d, 3)])
        } else {
            call("setFeeProtocol(uint8,uint8)", &[word(d, 2), word(d, 3)])
        };
        (p, vec![("admin", vec![Call { from: admin, to: pa, data }])])
    } else {
        return Err(Stop::Unsure(format!("unknown pool event {}", log.topics[0])));
    };

    match try_runs(view, &pretend, ctx, &candidates, &accept)? {
        Tried::Hit(diff, _) => Ok(diff),
        Tried::Miss(why) => Err(Stop::Unsure(format!("replay did not reproduce the event: {why}"))),
    }
}

// ---------------------------------------------------------------------------
// Algebra Integral (1.2.x) + its plugin.
// ---------------------------------------------------------------------------

/// Short memory between logs of one transaction (see file header), kept in
/// our copy under a made-up address so it follows the copy's forks/commits.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Notes {
    /// Transaction these notes belong to (zero = no notes).
    tx: B256,
    /// Side events seen before the main event (hashes, in order).
    pre: Vec<B256>,
    /// ExcessTokens amounts among `pre` (coins counted as fees).
    excess: Option<(U256, U256)>,
    /// Side events our replay produced after the main event, still to arrive.
    post: Vec<B256>,
}

const N_TX: u64 = 0;
const N_PRE: u64 = 1;
const N_POST: u64 = 2;
const N_EXCESS0: u64 = 3;
const N_EXCESS1: u64 = 4;
const N_HAS_EXCESS: u64 = 5;
const N_PRE_BASE: u64 = 0x100;
const N_POST_BASE: u64 = 0x200;
/// Most side events one action can produce (more = unsure).
const N_MAX: usize = 32;

/// The made-up address holding a pool's notes (no code, never a real account).
pub fn notes_address(pool: Address) -> Address {
    let mut b = b"arbsim.copy2.replay-notes".to_vec();
    b.extend_from_slice(pool.as_slice());
    Address::from_slice(&keccak256(b)[12..])
}

impl Notes {
    fn is_empty(&self) -> bool {
        self.pre.is_empty() && self.post.is_empty()
    }

    fn load(view: &dyn StateRead, pool: Address) -> Notes {
        let a = notes_address(pool);
        // Never written = no notes (this account is ours alone).
        let g = |s: u64| match view.storage(a, U256::from(s)) {
            Lookup::Known(v) => v,
            Lookup::Missing => U256::ZERO,
        };
        let n_pre = g(N_PRE).saturating_to::<usize>().min(N_MAX);
        let n_post = g(N_POST).saturating_to::<usize>().min(N_MAX);
        Notes {
            tx: B256::from(g(N_TX).to_be_bytes::<32>()),
            pre: (0..n_pre).map(|i| B256::from(g(N_PRE_BASE + i as u64).to_be_bytes::<32>())).collect(),
            excess: if g(N_HAS_EXCESS).is_zero() { None } else { Some((g(N_EXCESS0), g(N_EXCESS1))) },
            post: (0..n_post).map(|i| B256::from(g(N_POST_BASE + i as u64).to_be_bytes::<32>())).collect(),
        }
    }

    /// Write these notes over `old` (clearing slots `old` used and we don't).
    fn store(&self, db: &mut Overlay, pool: Address, old: &Notes) {
        if self == old {
            return;
        }
        let a = notes_address(pool);
        let mut d = AccountDiff::default();
        let mut put = |s: u64, v: U256| {
            d.storage.insert(U256::from(s), v);
        };
        put(N_TX, U256::from_be_bytes(self.tx.0));
        put(N_PRE, U256::from(self.pre.len()));
        put(N_POST, U256::from(self.post.len()));
        let (e0, e1) = self.excess.unwrap_or_default();
        put(N_EXCESS0, e0);
        put(N_EXCESS1, e1);
        put(N_HAS_EXCESS, U256::from(self.excess.is_some() as u8));
        for i in 0..self.pre.len().max(old.pre.len()) {
            put(N_PRE_BASE + i as u64, self.pre.get(i).map(|h| U256::from_be_bytes(h.0)).unwrap_or_default());
        }
        for i in 0..self.post.len().max(old.post.len()) {
            put(N_POST_BASE + i as u64, self.post.get(i).map(|h| U256::from_be_bytes(h.0)).unwrap_or_default());
        }
        let mut sd = StateDiff::default();
        sd.accounts.insert(a, d);
        db.commit(&sd);
    }
}

/// Algebra main actions (each runs the pool's own code end to end).
fn algebra_is_main(t0: &B256) -> bool {
    let t = topics();
    [t.swap, t.mint, t.burn, t.collect, t.flash, t.init_v3].contains(t0)
}

/// Pretend setup for Algebra: like V3, plus the pool's own stand-in coin
/// balance starts at its recorded reserves (+ coins counted as fees by an
/// ExcessTokens event in this action), exactly what the pool saw.
fn algebra_pretend(view: &dyn StateRead, pool: &TrackedPool, ctx: &BlockCtx, helpers: Vec<Address>, callers: Vec<Address>, excess: Option<(U256, U256)>) -> Result<Pretend, Stop> {
    let mut p = v3_pretend(view, pool, ctx, helpers, callers)?;
    let pa = pool.address;
    let reserves = match view_call(view, ctx, pa, call("getReserves()", &[]))? {
        Some(o) if o.len() >= 64 => (word(&o, 0), word(&o, 1)),
        _ => return Err(Stop::Unsure("Algebra pool without getReserves() (version not supported)".into())),
    };
    let (e0, e1) = excess.unwrap_or_default();
    let bal = map_slot(addr_word(pa), U256::ZERO);
    p.seeds.push((p.stubs[0], bal, reserves.0.wrapping_add(e0)));
    p.seeds.push((p.stubs[1], bal, reserves.1.wrapping_add(e1)));
    Ok(p)
}

/// Accept an Algebra run whose pool logs are: the noted side events, then
/// the chain's event, then anything (returned as the expected later events).
fn algebra_accept<'a>(pa: Address, log: &'a PoolLog, pre: &'a [B256]) -> impl Fn(&RunOut) -> Result<(), String> + 'a {
    move |r: &RunOut| {
        let pl = pool_logs(r, pa);
        let Some(m) = pl.iter().position(|l| same_log(l, log)) else {
            return Err(describe_mismatch(&pl, log));
        };
        let got: Vec<B256> = pl[..m].iter().map(|l| revm_log_hash(l)).collect();
        if got != pre {
            return Err(format!("side events before the main one differ ({} from replay vs {} from chain)", got.len(), pre.len()));
        }
        Ok(())
    }
}

/// Apply notes left over from a transaction on their own (see header).
fn flush_notes(fork: &mut Overlay, pool: &TrackedPool, notes: &Notes, ctx: &BlockCtx) -> Result<(), Stop> {
    if !notes.post.is_empty() {
        return Err(Stop::Unsure(format!("replay produced {} pool event(s) the chain did not", notes.post.len())));
    }
    if notes.pre.is_empty() {
        return Ok(());
    }
    // Only one kind of lone side event is understood: ExcessTokens (coins
    // counted as fees by sync() or by an action that emits no main event).
    let Some((e0, e1)) = notes.excess else {
        return Err(Stop::Unsure("Algebra side event(s) without a main event".into()));
    };
    if notes.pre.len() != 1 {
        return Err(Stop::Unsure("several Algebra side events without a main event".into()));
    }
    let view: &dyn StateRead = &*fork;
    let pa = pool.address;
    let plugin = view_addr(view, ctx, pa, "plugin()")?;
    let p = algebra_pretend(view, pool, ctx, vec![], vec![], Some((e0, e1)))?;
    let calls = vec![Call { from: plugin, to: pa, data: call("sync()", &[]) }];
    let want = notes.pre.clone();
    let accept = move |r: &RunOut| -> Result<(), String> {
        let got: Vec<B256> = pool_logs(r, pa).iter().map(|l| revm_log_hash(l)).collect();
        if got == want {
            Ok(())
        } else {
            Err("sync() did not reproduce the ExcessTokens event".into())
        }
    };
    match try_runs(view, &p, ctx, &[("sync", calls)], &accept)? {
        Tried::Hit(diff, _) => {
            fork.commit(&diff);
            Ok(())
        }
        Tried::Miss(why) => Err(Stop::Unsure(why)),
    }
}

fn algebra(db: &mut Overlay, pool: &TrackedPool, log: &PoolLog, ctx: &BlockCtx) -> Result<StateDiff, Stop> {
    let t = topics();
    let pa = pool.address;
    let old = Notes::load(db, pa);
    let mut fork = db.fork();
    let mut notes = old.clone();
    // Notes from an earlier transaction: settle them first.
    if !notes.is_empty() && notes.tx != log.tx_hash {
        flush_notes(&mut fork, pool, &notes, ctx)?;
        notes = Notes::default();
    }
    let t0 = log.topics[0];
    if !algebra_is_main(&t0) {
        // A side event: either one our replay already produced (expected
        // after the main event) or one that comes before the main event.
        let h = log_hash(log.address, &log.topics, &log.data);
        if !notes.post.is_empty() {
            if notes.post[0] != h {
                return Err(Stop::Unsure("Algebra side event differs from what the replay produced".into()));
            }
            notes.post.remove(0);
        } else {
            if notes.pre.len() >= N_MAX {
                return Err(Stop::Unsure("too many Algebra side events".into()));
            }
            if t0 == t.excess_tokens {
                if notes.excess.is_some() {
                    return Err(Stop::Unsure("two ExcessTokens events before one action".into()));
                }
                notes.excess = Some((word(&log.data, 0), word(&log.data, 1)));
            }
            notes.pre.push(h);
        }
        notes.tx = if notes.is_empty() { B256::ZERO } else { log.tx_hash };
        if notes.is_empty() {
            notes.excess = None;
        }
        notes.store(&mut fork, pa, &old);
        return Ok(fork.into_parts().1);
    }
    if !notes.post.is_empty() {
        return Err(Stop::Unsure("chain skipped Algebra side events the replay produced".into()));
    }
    // Collect doesn't count coins (no _updateReserves): side events noted
    // before it belong to something else (e.g. a silent burn(0) "poke");
    // settle them on their own first.
    if t0 == t.collect && !notes.pre.is_empty() {
        flush_notes(&mut fork, pool, &notes, ctx)?;
        notes = Notes::default();
    }

    let view: &dyn StateRead = &fork;
    let d = &log.data[..];
    let need = |n: usize| -> Result<(), Stop> {
        if log.topics.len() < n {
            Err(Stop::Unsure("event has too few topics".into()))
        } else {
            Ok(())
        }
    };
    let (pretend, candidates): (Pretend, Vec<(&str, Vec<Call>)>) = if t0 == t.swap {
        need(3)?;
        let (sender, recipient) = (topic_addr(&log.topics[1]), topic_addr(&log.topics[2]));
        let (a0, a1, price) = (word(d, 0), word(d, 1), word(d, 2));
        // Price before = the low 160 bits of globalState (slot 2), only needed for 0/0 swaps.
        let zfo = v3_direction(a0, a1, price, || {
            let gs = view_call(view, ctx, pa, call("globalState()", &[]))?.ok_or_else(|| Stop::Unsure("globalState() failed".into()))?;
            Ok(word(&gs, 0))
        })?;
        let p = algebra_pretend(view, pool, ctx, vec![sender], vec![], notes.excess)?;
        (p, v3_swap_candidates(pa, sender, recipient, zfo, a0, a1, price))
    } else if t0 == t.mint {
        need(4)?;
        let (owner, lo, hi) = (topic_addr(&log.topics[1]), topic_word(&log.topics[2]), topic_word(&log.topics[3]));
        let sender = word_addr(word(d, 0));
        let p = algebra_pretend(view, pool, ctx, vec![sender], vec![], notes.excess)?;
        let data = call("mintAlgebra(address,address,int24,int24,uint128)", &[addr_word(pa), addr_word(owner), lo, hi, word(d, 1)]);
        (p, vec![("mint", vec![Call { from: REPLAY_CALLER, to: sender, data }])])
    } else if t0 == t.burn {
        need(4)?;
        let (owner, lo, hi) = (topic_addr(&log.topics[1]), topic_word(&log.topics[2]), topic_word(&log.topics[3]));
        let p = algebra_pretend(view, pool, ctx, vec![], vec![owner], notes.excess)?;
        // burn(int24,int24,uint128,bytes ""): the empty bytes = offset 0x80, length 0.
        let data = call("burn(int24,int24,uint128,bytes)", &[lo, hi, word(d, 0), U256::from(0x80), U256::ZERO]);
        (p, vec![("burn", vec![Call { from: owner, to: pa, data }])])
    } else if t0 == t.collect {
        need(4)?;
        let (owner, lo, hi) = (topic_addr(&log.topics[1]), topic_word(&log.topics[2]), topic_word(&log.topics[3]));
        let p = algebra_pretend(view, pool, ctx, vec![], vec![owner], notes.excess)?;
        let collect = Call { from: owner, to: pa, data: call("collect(address,int24,int24,uint128,uint128)", &[word(d, 0), lo, hi, word(d, 1), word(d, 2)]) };
        // Algebra's burn(0) "poke" (fees moved into the position) emits no
        // event; a position manager does it right before collecting.
        let poke = Call { from: owner, to: pa, data: call("burn(int24,int24,uint128,bytes)", &[lo, hi, U256::ZERO, U256::from(0x80), U256::ZERO]) };
        (p, vec![("collect", vec![collect.clone()]), ("poke+collect", vec![poke, collect])])
    } else if t0 == t.flash {
        need(3)?;
        let (sender, recipient) = (topic_addr(&log.topics[1]), topic_addr(&log.topics[2]));
        let p = algebra_pretend(view, pool, ctx, vec![sender], vec![], notes.excess)?;
        let data = call(
            "flash(address,address,uint256,uint256,uint256,uint256)",
            &[addr_word(pa), addr_word(recipient), word(d, 0), word(d, 1), word(d, 2), word(d, 3)],
        );
        (p, vec![("flash", vec![Call { from: REPLAY_CALLER, to: sender, data }])])
    } else {
        // Initialize (pool creation): we load new pools from the node instead.
        return Err(Stop::Unsure("Algebra Initialize: load the pool from the node".into()));
    };
    let pre = notes.pre.clone();
    let accept = algebra_accept(pa, log, &pre);
    match try_runs(view, &pretend, ctx, &candidates, &accept)? {
        Tried::Hit(diff, logs) => {
            fork.commit(&diff);
            // Side events the replay produced after the main event must now
            // arrive from the chain (checked as they come).
            let pl: Vec<&Log> = logs.iter().filter(|l| l.address == pa).collect();
            let m = pl.iter().position(|l| same_log(l, log)).unwrap_or(pl.len());
            let post: Vec<B256> = pl.iter().skip(m + 1).map(|l| revm_log_hash(l)).collect();
            if post.len() > N_MAX {
                return Err(Stop::Unsure("too many Algebra side events".into()));
            }
            let new = Notes { tx: if post.is_empty() { B256::ZERO } else { log.tx_hash }, pre: Vec::new(), excess: None, post };
            new.store(&mut fork, pa, &old);
            Ok(fork.into_parts().1)
        }
        Tried::Miss(why) => Err(Stop::Unsure(format!("replay did not reproduce the event: {why}"))),
    }
}

// ---------------------------------------------------------------------------
// Uniswap V4 (hook-free) inside the PoolManager.
// ---------------------------------------------------------------------------

/// The 5 words of a V4 PoolKey (currency0, currency1, fee, tickSpacing, hooks=0).
fn v4_key_words(pool: &TrackedPool) -> [U256; 5] {
    [addr_word(pool.token0), addr_word(pool.token1), U256::from(pool.fee), int_word(pool.tick_spacing as i128), U256::ZERO]
}

/// V4 pool id = keccak256(abi.encode(PoolKey)).
pub fn v4_pool_id(pool: &TrackedPool) -> B256 {
    let mut b = Vec::with_capacity(160);
    for w in v4_key_words(pool) {
        b.extend_from_slice(&w.to_be_bytes::<32>());
    }
    keccak256(b)
}

fn v4(db: &mut Overlay, pool: &TrackedPool, log: &PoolLog, ctx: &BlockCtx) -> Result<StateDiff, Stop> {
    let t = topics();
    let view: &dyn StateRead = db;
    let pm = pool.address;
    let t0 = log.topics[0];
    // Claim-token bookkeeping of the PoolManager: not part of any pool.
    if t0 == t.erc6909_transfer || t0 == t.erc6909_approval || t0 == t.erc6909_operator {
        return Ok(StateDiff::default());
    }
    let Some(id) = pool.v4_id else {
        return Err(Stop::Unsure("V4 pool without its pool id".into()));
    };
    if v4_pool_id(pool) != id {
        return Err(Stop::Unsure("V4 pool id doesn't match its key (hooked pool?)".into()));
    }
    if log.topics.len() < 2 || log.topics[1] != id {
        return Err(Stop::Unsure("V4 event of another pool given for this pool".into()));
    }
    let d = &log.data[..];
    let key = v4_key_words(pool);
    let with_key = |sig: &str, pre: &[U256], post: &[U256]| -> Bytes {
        let mut w: Vec<U256> = pre.to_vec();
        w.extend_from_slice(&key);
        w.extend_from_slice(post);
        call(sig, &w)
    };
    // Stand-in coins for the pool's coins (native ETH = no coin contract).
    let stubs: Vec<Address> = [pool.token0, pool.token1].into_iter().filter(|a| *a != Address::ZERO).collect();
    let mk = |helpers: Vec<Address>, callers: Vec<Address>| -> Result<Pretend, Stop> {
        for h in helpers.iter().chain(callers.iter()) {
            if stubs.contains(h) || *h == pm {
                return Err(Stop::Unsure(format!("event sender {h} is the PoolManager or a coin")));
            }
        }
        Ok(Pretend { helpers, stubs: stubs.clone(), seeds: Vec::new(), callers, rich: vec![pm] })
    };

    let (pretend, candidates): (Pretend, Vec<(&str, Vec<Call>)>) = if t0 == t.v4_swap {
        if log.topics.len() < 3 {
            return Err(Stop::Unsure("event has too few topics".into()));
        }
        let sender = topic_addr(&log.topics[2]);
        let (a0, a1, sqrt) = (word(d, 0), word(d, 1), word(d, 2));
        // Amounts are the trader's: negative = paid in.
        let zfo = if !a0.is_zero() || !a1.is_zero() {
            is_neg(a0)
        } else {
            // 0/0: a range with no liquidity; the price fell = zeroForOne.
            let base = map_slot(U256::from_be_bytes(id.0), U256::from(6u8));
            let before = slot(view, pm, base)? & ((U256::from(1u8) << 160) - U256::from(1u8));
            sqrt < before
        };
        let paid = if zfo { neg(a0) } else { neg(a1) };
        let got = if zfo { a1 } else { a0 };
        let huge = U256::from(1u8) << 120;
        let one = U256::from(1u8);
        let tries: [(&str, U256, U256); 8] = [
            ("exactIn", neg(paid), U256::ZERO),
            ("exactOut", got, U256::ZERO),
            ("exactIn+limit", neg(paid), sqrt),
            ("exactOut+limit", got, sqrt),
            ("toPrice", neg(huge), sqrt),
            ("toPriceOut", huge, sqrt),
            ("tinyIn", neg(one), sqrt),
            ("tinyOut", one, sqrt),
        ];
        let mut c = Vec::new();
        for (name, amount, limit) in tries {
            if amount.is_zero() {
                continue;
            }
            let data = with_key("v4Swap(address,(address,address,uint24,int24,address),bool,int256,uint160)", &[addr_word(pm)], &[U256::from(zfo as u8), amount, limit]);
            c.push((name, vec![Call { from: REPLAY_CALLER, to: sender, data }]));
        }
        (mk(vec![sender], vec![])?, c)
    } else if t0 == t.v4_modify {
        if log.topics.len() < 3 {
            return Err(Stop::Unsure("event has too few topics".into()));
        }
        let sender = topic_addr(&log.topics[2]);
        let data = with_key(
            "v4Modify(address,(address,address,uint24,int24,address),int24,int24,int256,bytes32)",
            &[addr_word(pm)],
            &[word(d, 0), word(d, 1), word(d, 2), word(d, 3)],
        );
        (mk(vec![sender], vec![])?, vec![("modifyLiquidity", vec![Call { from: REPLAY_CALLER, to: sender, data }])])
    } else if t0 == t.v4_donate {
        if log.topics.len() < 3 {
            return Err(Stop::Unsure("event has too few topics".into()));
        }
        let sender = topic_addr(&log.topics[2]);
        let data = with_key("v4Donate(address,(address,address,uint24,int24,address),uint256,uint256)", &[addr_word(pm)], &[word(d, 0), word(d, 1)]);
        (mk(vec![sender], vec![])?, vec![("donate", vec![Call { from: REPLAY_CALLER, to: sender, data }])])
    } else if t0 == t.v4_init {
        let data = with_key("initialize((address,address,uint24,int24,address),uint160)", &[], &[word(d, 3)]);
        (mk(vec![], vec![])?, vec![("initialize", vec![Call { from: REPLAY_CALLER, to: pm, data }])])
    } else if t0 == t.v4_protocol_fee {
        let controller = view_addr(view, ctx, pm, "protocolFeeController()")?;
        let data = with_key("setProtocolFee((address,address,uint24,int24,address),uint24)", &[], &[word(d, 0)]);
        (mk(vec![], vec![controller])?, vec![("protocolFee", vec![Call { from: controller, to: pm, data }])])
    } else {
        return Err(Stop::Unsure(format!("unknown PoolManager event {t0}")));
    };
    let accept = exactly_the_event(pm, log);
    match try_runs(view, &pretend, ctx, &candidates, &accept)? {
        Tried::Hit(diff, _) => Ok(diff),
        Tried::Miss(why) => Err(Stop::Unsure(format!("replay did not reproduce the event: {why}"))),
    }
}

// ---------------------------------------------------------------------------
// Unit tests (no chain needed). The full proof against real pool code on a
// practice chain is tests/copy2_replay_anvil.rs.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::snap::{Fact, Snapshot};

    fn pool(kind: PoolKind) -> TrackedPool {
        TrackedPool {
            address: Address::with_last_byte(0x77),
            v4_id: None,
            kind,
            token0: Address::with_last_byte(1),
            token1: Address::with_last_byte(2),
            fee: 0,
            tick_spacing: 0,
        }
    }
    fn ctx() -> BlockCtx {
        BlockCtx { number: 100, timestamp: 1_700_000_000, l1_number: 20_000_000 }
    }
    fn log(p: &TrackedPool, topics: Vec<B256>, data: Vec<u8>) -> PoolLog {
        PoolLog { address: p.address, topics, data: Bytes::from(data), block: 100, tx_index: 0, log_index: 0, tx_hash: B256::with_last_byte(9), removed: false }
    }

    #[test]
    fn embedded_code_is_present() {
        // ReplayHelper must expose the functions replay.rs calls.
        let (_, h) = helper_code();
        let code = h.original_bytes();
        for s in [
            "swap(address,address,bool,int256,uint160)",
            "mint(address,address,int24,int24,uint128)",
            "mintAlgebra(address,address,int24,int24,uint128)",
            "flash(address,address,uint256,uint256,uint256,uint256)",
            "v4Swap(address,(address,address,uint24,int24,address),bool,int256,uint160)",
            "v4Modify(address,(address,address,uint24,int24,address),int24,int24,int256,bytes32)",
            "v4Donate(address,(address,address,uint24,int24,address),uint256,uint256)",
            "unlockCallback(bytes)",
            "algebraSwapCallback(int256,int256,bytes)",
            "pancakeV3SwapCallback(int256,int256,bytes)",
        ] {
            let s4 = sel(s);
            assert!(code.windows(4).any(|w| w == s4), "selector of {s} not in ReplayHelper code");
        }
        assert!(!stub_code().1.original_bytes().is_empty());
    }

    #[test]
    fn signed_word_helpers() {
        assert_eq!(int_word(-1), U256::MAX);
        assert_eq!(neg(int_word(-5)), U256::from(5));
        assert!(is_neg(int_word(-887272)));
        assert!(!is_neg(U256::from(3)));
    }

    #[test]
    fn empty_copy_asks_for_the_pool() {
        // Nothing loaded: the replay must ask for items, never guess zero.
        let p = pool(PoolKind::V3);
        let mut db = Overlay::new(Snapshot::default());
        let t = topics();
        let mut data = vec![0u8; 160];
        data[31] = 5; // amount0 = 5
        data[63] = 0xff; // (garbage, irrelevant)
        let l = log(&p, vec![t.swap, B256::with_last_byte(3), B256::with_last_byte(4)], data);
        match apply_replay(&mut db, &p, &l, &ctx()) {
            ApplyResult::NeedItems(items) => assert!(items.contains(&MissItem::Account(p.address))),
            other => panic!("expected NeedItems, got {other:?}"),
        }
        // And nothing was written.
        assert!(db.changes().accounts.is_empty());
    }

    #[test]
    fn unknown_event_and_reorg_are_unsure() {
        let p = pool(PoolKind::V3);
        let mut db = Overlay::new(Snapshot::default());
        let mut l = log(&p, vec![B256::with_last_byte(1)], vec![]);
        l.removed = true;
        assert!(matches!(apply_replay(&mut db, &p, &l, &ctx()), ApplyResult::Unsure(_)));
        let v2 = pool(PoolKind::V2);
        let l = log(&v2, vec![B256::with_last_byte(1)], vec![]);
        assert!(matches!(apply_replay(&mut db, &v2, &l, &ctx()), ApplyResult::Unsure(_)));
    }

    #[test]
    fn v4_id_and_foreign_events() {
        let mut p = pool(PoolKind::V4);
        p.fee = 3000;
        p.tick_spacing = 60;
        let id = v4_pool_id(&p);
        p.v4_id = Some(id);
        let mut db = Overlay::new(Snapshot::default());
        // Another pool's swap given for this pool: unsure (routing error).
        let l = log(&p, vec![topics().v4_swap, B256::with_last_byte(1), B256::ZERO], vec![0u8; 192]);
        assert!(matches!(apply_replay(&mut db, &p, &l, &ctx()), ApplyResult::Unsure(_)));
        // Claim-token events are accepted and change nothing.
        let l = log(&p, vec![topics().erc6909_transfer], vec![0u8; 64]);
        assert_eq!(apply_replay(&mut db, &p, &l, &ctx()), ApplyResult::Applied);
        assert!(db.changes().accounts.is_empty());
        // A wrong id (key mismatch) is unsure.
        p.v4_id = Some(B256::with_last_byte(5));
        let l = log(&p, vec![topics().v4_swap, B256::with_last_byte(5), B256::ZERO], vec![0u8; 192]);
        assert!(matches!(apply_replay(&mut db, &p, &l, &ctx()), ApplyResult::Unsure(_)));
    }

    #[test]
    fn algebra_notes_round_trip_and_flush_rules() {
        let p = pool(PoolKind::Algebra);
        let mut db = Overlay::new(Snapshot::default());
        assert!(!has_pending(&db, &p));
        // A side event (not ExcessTokens) before any main event: noted.
        let side = log(&p, vec![topic("Fee(uint16)")], U256::from(500).to_be_bytes::<32>().to_vec());
        assert_eq!(apply_replay(&mut db, &p, &side, &ctx()), ApplyResult::Applied);
        assert!(has_pending(&db, &p));
        let n = Notes::load(&db, p.address);
        assert_eq!(n.pre.len(), 1);
        assert_eq!(n.tx, side.tx_hash);
        // Block ends with it still waiting: a lone Fee event can't be applied
        // exactly on its own -> unsure, and nothing changes.
        let before = db.changes().clone();
        assert!(matches!(finish_block(&mut db, &p, &ctx()), ApplyResult::Unsure(_)));
        assert_eq!(db.changes().accounts.len(), before.accounts.len());
        // Notes encode / decode.
        let full = Notes { tx: B256::with_last_byte(7), pre: vec![B256::with_last_byte(1)], excess: Some((U256::from(3), U256::from(4))), post: vec![B256::with_last_byte(2), B256::with_last_byte(8)] };
        let mut db2 = Overlay::new(Snapshot::default());
        full.store(&mut db2, p.address, &Notes::default());
        assert_eq!(Notes::load(&db2, p.address), full);
        Notes::default().store(&mut db2, p.address, &full);
        assert!(Notes::load(&db2, p.address).is_empty());
        // A main event with a known pool account but missing storage asks for items.
        let mut db3 = Overlay::new(Snapshot::default());
        db3.learn(&Fact::Basics { addr: p.address, info: Some(AccountInfo { nonce: 1, ..Default::default() }), code: None });
        let l = log(&p, vec![topics().flash, B256::with_last_byte(3), B256::with_last_byte(4)], vec![0u8; 128]);
        assert!(matches!(apply_replay(&mut db3, &p, &l, &ctx()), ApplyResult::NeedItems(_) | ApplyResult::Unsure(_)));
    }
}

/// End of a block for one pool (Algebra side events; see B's file). The
/// placeholder has nothing waiting.
pub fn finish_block(_db: &mut Overlay, _pool: &TrackedPool, _ctx: &BlockCtx) -> ApplyResult {
    ApplyResult::Applied
}

/// Algebra side events waiting for their main event? (placeholder: never)
pub fn has_pending(_db: &Overlay, _pool: &TrackedPool) -> bool {
    false
}
