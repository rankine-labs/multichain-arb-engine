// ============================================================================
// Tests for copy 2's intake (copy2/intake.rs), offline with a fake node.
//
// Plain English: a tiny pretend chain holds a Uniswap V2 pool, a Solidly
// pool and two coins. We follow them the way the bot will (track, then
// pool_logs / block_tick per block) and check, slot by slot, that our copy
// ends up EXACTLY where hand-computed truth says, and that every "can't be
// sure" case (unknown event, wrong storage layout, reorg, lost message,
// re-sent block) makes the pool unsure and forgets it instead of guessing.
// ============================================================================
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

// Signing helpers (test keys only) for the trigger-first tests at the end.
mod check_util;

use arbsim::check::hexutil::{parse_address, parse_bytes, parse_u256, parse_u64};
use arbsim::copy2::coins::{BalanceLayout, PROBE_HOLDER};
use arbsim::copy2::fields::{map_slot, obs_slot, topic, topics};
use arbsim::copy2::intake::{manual, BlockMsg, C2Config, Copy2Handle, Intake, PoolState};
use arbsim::copy2::{PoolKind, PoolLog, TrackedPool};
use arbsim::node::{CallResult, Class, NodeApi, NodeErr, RpcErr};
use arbsim::state::fill::FillQueue;
use arbsim::state::mirror::{At, Config, Shared};
use arbsim::state::snap::Volatile;
use arbsim::state::{Lookup, MissItem, StateRead};
use revm::primitives::{keccak256, Address, Bytes, B256, U256};
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// Fake chain
// ---------------------------------------------------------------------------
type Storage = HashMap<Address, HashMap<U256, U256>>;

#[derive(Default)]
struct FakeChain {
    /// block -> storage (a block not listed uses the newest earlier one).
    states: Mutex<Vec<(u64, Storage)>>,
    /// Pools whose getters answer something else than storage (bad layout).
    lying: Mutex<Vec<Address>>,
    calls: Mutex<usize>,
    /// Calls that came through the paid-first path.
    paid_calls: Mutex<usize>,
    /// Pretend each batch takes this long (a slow node).
    delay_ms: Mutex<u64>,
    /// The node's newest block (eth_blockNumber). Asking about a newer
    /// block gets "header not found", like a node behind the websocket.
    tip: Mutex<u64>,
    /// The next N balance-place probes answer with an error object.
    probe_errors: Mutex<u32>,
    /// Balance-place probes seen.
    probes: Mutex<u32>,
    /// Coins that keep balances in a "namespaced" mapping (slot base 777):
    /// the probe can't find them; only a trace can.
    namespaced: Mutex<Vec<Address>>,
    traces: Mutex<u32>,
    /// eth_getProof requests seen.
    proofs: Mutex<u32>,
    /// Like this Nitro node: eth_getProof only at the newest block.
    proof_tip_only: Mutex<bool>,
    /// Real code for some contracts (others: one 0x00 byte).
    codes: Mutex<HashMap<Address, Vec<u8>>>,
    /// Blocks eth_getProof was asked at.
    proof_blocks: Mutex<Vec<u64>>,
    /// eth_getStorageAt requests seen.
    storage_reads: Mutex<u32>,
}

/// Balance slot of a holder in a namespaced coin.
fn ns_slot(h: Address) -> U256 {
    map_slot(h, 777)
}

impl FakeChain {
    fn new() -> Self {
        FakeChain { tip: Mutex::new(1_000_000), ..Default::default() }
    }
}

fn u(n: u128) -> U256 {
    U256::from(n)
}
fn a(n: u8) -> Address {
    Address::with_last_byte(n)
}
fn w(v: U256) -> String {
    format!("{v:#066x}")
}

impl FakeChain {
    fn set(&self, block: u64, s: Storage) {
        let mut g = self.states.lock().unwrap();
        g.retain(|x| x.0 != block);
        g.push((block, s));
        g.sort_by_key(|x| x.0);
    }
    fn at(&self, block: u64) -> Storage {
        let g = self.states.lock().unwrap();
        g.iter().rev().find(|x| x.0 <= block).map(|x| x.1.clone()).unwrap_or_default()
    }
    fn sload(&self, block: u64, acct: Address, slot: U256) -> U256 {
        self.at(block).get(&acct).and_then(|m| m.get(&slot).copied()).unwrap_or_default()
    }
}

fn sel(sig: &str) -> [u8; 4] {
    let h = keccak256(sig.as_bytes());
    [h[0], h[1], h[2], h[3]]
}

impl NodeApi for FakeChain {
    fn call_batch_paid(&self, class: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        *self.paid_calls.lock().unwrap() += calls.len();
        self.call_batch(class, calls)
    }
    fn call_batch(&self, _class: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        *self.calls.lock().unwrap() += calls.len();
        let d = *self.delay_ms.lock().unwrap();
        if d > 0 {
            std::thread::sleep(std::time::Duration::from_millis(d));
        }
        Ok(calls
            .iter()
            .map(|(m, p)| -> CallResult {
                let blk = |i: usize| p[i].as_str().and_then(|s| parse_u64(s).ok()).unwrap_or(0);
                match *m {
                    "eth_blockNumber" => Ok(json!(format!("{:#x}", *self.tip.lock().unwrap()))),
                    // Settling pools whose reports may be missing: nothing missing here.
                    "eth_getLogs" => Ok(json!([])),
                    "eth_getBlockByNumber" => Ok(Value::Null),
                    "eth_getStorageAt" | "eth_call" | "eth_getProof" if blk(if *m == "eth_call" { 1 } else { 2 }) > *self.tip.lock().unwrap() => {
                        Err(RpcErr { code: -32000, message: "header not found".into() })
                    }
                    "eth_getProof" if *self.proof_tip_only.lock().unwrap() && blk(2) < *self.tip.lock().unwrap() => {
                        *self.proofs.lock().unwrap() += 1;
                        Err(RpcErr { code: -32000, message: "historical state 27a8441d0f is not available".into() })
                    }
                    "eth_getProof" => {
                        // Like Nitro: balance, nonce, code hash + storage values in order.
                        *self.proofs.lock().unwrap() += 1;
                        self.proof_blocks.lock().unwrap().push(blk(2));
                        let acct = parse_address(p[0].as_str().unwrap()).unwrap();
                        let st = self.at(blk(2));
                        let exists = st.contains_key(&acct);
                        let code_hash = match self.codes.lock().unwrap().get(&acct) {
                            Some(c) => keccak256(c),
                            None if exists => keccak256([0u8]),
                            None => revm::primitives::KECCAK_EMPTY,
                        };
                        let sp: Vec<Value> = p[1]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|k| {
                                let key = parse_u256(k.as_str().unwrap()).unwrap();
                                json!({"key": k, "value": format!("{:#x}", self.sload(blk(2), acct, key)), "proof": []})
                            })
                            .collect();
                        Ok(json!({"address": format!("{acct:#x}"), "balance": "0x0", "nonce": if exists { "0x1" } else { "0x0" },
                                  "codeHash": format!("{code_hash}"), "storageHash": format!("{:#066x}", 0), "accountProof": [], "storageProof": sp}))
                    }
                    "eth_getStorageAt" => {
                        *self.storage_reads.lock().unwrap() += 1;
                        let acct = parse_address(p[0].as_str().unwrap()).unwrap();
                        let s = parse_u256(p[1].as_str().unwrap()).unwrap();
                        Ok(json!(w(self.sload(blk(2), acct, s))))
                    }
                    "eth_getBalance" | "eth_getTransactionCount" => Ok(json!("0x0")),
                    // Contracts (anything with storage) have code, like on chain.
                    "eth_getCode" => {
                        let acct = parse_address(p[0].as_str().unwrap()).unwrap();
                        if let Some(c) = self.codes.lock().unwrap().get(&acct) {
                            return Ok(json!(format!("0x{}", c.iter().map(|b| format!("{b:02x}")).collect::<String>())));
                        }
                        Ok(json!(if self.at(blk(1)).contains_key(&acct) { "0x00" } else { "0x" }))
                    }
                    "eth_call" => {
                        let to = parse_address(p[0]["to"].as_str().unwrap()).unwrap();
                        let data: Bytes = parse_bytes(p[0]["data"].as_str().unwrap()).unwrap();
                        let b = blk(1);
                        // Balance-place probe (state override): our fake coins
                        // keep balances at Solidity mapping slot 0.
                        if let Some(ov) = p.get(2).and_then(|o| o.as_object()) {
                            *self.probes.lock().unwrap() += 1;
                            {
                                let mut pe = self.probe_errors.lock().unwrap();
                                if *pe > 0 {
                                    *pe -= 1;
                                    return Err(RpcErr { code: 429, message: "rate limit".into() });
                                }
                            }
                            let diff = ov.values().next().unwrap()["stateDiff"].as_object().unwrap();
                            if self.namespaced.lock().unwrap().contains(&to) {
                                return Ok(json!(w(U256::ZERO))); // reads its real (empty) place
                            }
                            let k = w(BalanceLayout::solidity(0).key(PROBE_HOLDER));
                            return Ok(diff.get(&k).cloned().unwrap_or(json!(w(U256::ZERO))));
                        }
                        let s = |n: u64| self.sload(b, to, U256::from(n));
                        let lie = if self.lying.lock().unwrap().contains(&to) { u(1) } else { U256::ZERO };
                        let f = &data[..4];
                        let words: Vec<U256> = if f == sel("balanceOf(address)") {
                            let h = Address::from_slice(&data[16..36]);
                            let slot = if self.namespaced.lock().unwrap().contains(&to) { ns_slot(h) } else { map_slot(h, 0) };
                            vec![self.sload(b, to, slot)]
                        } else if f == sel("getReserves()") {
                            let r = s(8);
                            if r.is_zero() {
                                // Solidly layout
                                vec![s(17) + lie, s(18), s(19)]
                            } else {
                                let m = (U256::from(1) << 112usize) - U256::from(1);
                                vec![(r & m) + lie, (r >> 112usize) & m, r >> 224usize]
                            }
                        } else if f == sel("totalSupply()") {
                            vec![if s(8).is_zero() { s(2) } else { s(0) }]
                        } else if f == sel("price0CumulativeLast()") {
                            vec![s(9)]
                        } else if f == sel("price1CumulativeLast()") {
                            vec![s(10)]
                        } else if f == sel("reserve0CumulativeLast()") {
                            vec![s(20)]
                        } else if f == sel("reserve1CumulativeLast()") {
                            vec![s(21)]
                        } else if f == sel("index0()") {
                            vec![s(22)]
                        } else if f == sel("index1()") {
                            vec![s(23)]
                        } else if f == sel("observationLength()") {
                            vec![s(14)]
                        } else {
                            return Err(RpcErr { code: 3, message: "execution reverted".into() });
                        };
                        let mut out = String::from("0x");
                        for x in words {
                            out.push_str(&format!("{x:064x}"));
                        }
                        Ok(json!(out))
                    }
                    "debug_traceCall" => {
                        // prestateTracer of balanceOf(holder): the coin's code,
                        // the slot it read, and one setting it also read.
                        *self.traces.lock().unwrap() += 1;
                        let to = parse_address(p[0]["to"].as_str().unwrap()).unwrap();
                        let data: Bytes = parse_bytes(p[0]["data"].as_str().unwrap()).unwrap();
                        let h = Address::from_slice(&data[16..36]);
                        let b = blk(1);
                        let slot = if self.namespaced.lock().unwrap().contains(&to) { ns_slot(h) } else { map_slot(h, 0) };
                        let mut st = serde_json::Map::new();
                        st.insert(w(slot), json!(w(self.sload(b, to, slot))));
                        st.insert(w(u(5)), json!(w(self.sload(b, to, u(5)))));
                        let mut out = serde_json::Map::new();
                        out.insert(format!("{to:#x}"), json!({"balance": "0x0", "nonce": 1, "code": "0x00", "storage": st}));
                        Ok(Value::Object(out))
                    }
                    _ => Err(RpcErr { code: -32601, message: "method not found".into() }),
                }
            })
            .collect())
    }
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------
const COIN0: u8 = 0x01;
const COIN1: u8 = 0x02;
const V2P: u8 = 0xa2;
const SOLP: u8 = 0xb5;
const USER: u8 = 0x77;

fn v2_pool() -> TrackedPool {
    TrackedPool { address: a(V2P), v4_id: None, kind: PoolKind::V2, token0: a(COIN0), token1: a(COIN1), fee: 0, tick_spacing: 0 }
}
fn sol_pool() -> TrackedPool {
    TrackedPool { address: a(SOLP), v4_id: None, kind: PoolKind::Solidly, token0: a(COIN0), token1: a(COIN1), fee: 0, tick_spacing: 0 }
}

fn addr_word(x: Address) -> U256 {
    U256::from_be_slice(x.as_slice())
}

/// Chain state at block 100: V2 pool reserves 1000/4000 at t=50, coins.
fn genesis() -> Storage {
    let mut s: Storage = HashMap::new();
    let p = s.entry(a(V2P)).or_default();
    p.insert(u(0), u(2000));
    p.insert(u(6), addr_word(a(COIN0)));
    p.insert(u(7), addr_word(a(COIN1)));
    p.insert(u(8), u(1000) | (u(4000) << 112usize) | (u(50) << 224usize));
    p.insert(u(9), u(5));
    p.insert(u(10), u(6));
    let q = s.entry(a(SOLP)).or_default();
    q.insert(u(2), u(2_000_000_000_000_000_000));
    q.insert(u(10), addr_word(a(COIN0)) << 8usize);
    q.insert(u(11), addr_word(a(COIN1)));
    q.insert(u(14), u(1));
    q.insert(obs_slot(u(0), 0), u(40));
    q.insert(u(17), u(500));
    q.insert(u(18), u(800));
    q.insert(u(19), u(40));
    q.insert(u(20), u(0));
    q.insert(u(21), u(0));
    q.insert(u(22), u(0));
    q.insert(u(23), u(0));
    for (coin, bal_v2, bal_sol) in [(COIN0, 1000u128, 500u128), (COIN1, 4000, 800)] {
        let c = s.entry(a(coin)).or_default();
        c.insert(map_slot(a(V2P), 0), u(bal_v2));
        c.insert(map_slot(a(SOLP), 0), u(bal_sol));
        c.insert(map_slot(a(USER), 0), u(1_000_000));
    }
    s
}

struct Rig {
    chain: Arc<FakeChain>,
    sh: Arc<Shared>,
    intake: Intake,
    h: Copy2Handle,
}

fn rig() -> Rig {
    rig_with(C2Config::for_tests())
}

fn rig_with(cfg: C2Config) -> Rig {
    let chain = Arc::new(FakeChain::new());
    chain.set(100, genesis());
    let node: Arc<dyn NodeApi> = chain.clone();
    let sh = Shared::new(Config::for_tests(), Some(node), Arc::new(Volatile::default()));
    let fills = Arc::new(FillQueue::new(1000, 100));
    let (intake, h) = manual(sh.clone(), fills, cfg);
    Rig { chain, sh, intake, h }
}

fn topic_of(x: Address) -> B256 {
    let mut b = [0u8; 32];
    b[12..].copy_from_slice(x.as_slice());
    B256::from(b)
}
fn data(ws: &[U256]) -> Bytes {
    let mut v = Vec::new();
    for x in ws {
        v.extend_from_slice(&x.to_be_bytes::<32>());
    }
    Bytes::from(v)
}
fn lg(addr: Address, topics: Vec<B256>, d: Bytes, block: u64, tx: u32, li: u32) -> PoolLog {
    PoolLog { address: addr, topics, data: d, block, tx_index: tx, log_index: li, tx_hash: B256::with_last_byte(tx as u8), removed: false }
}
fn transfer(coin: Address, from: Address, to: Address, v: u128, block: u64, tx: u32, li: u32) -> PoolLog {
    lg(coin, vec![topics().transfer, topic_of(from), topic_of(to)], data(&[u(v)]), block, tx, li)
}
fn v2_sync(r0: u128, r1: u128, block: u64, tx: u32, li: u32) -> PoolLog {
    lg(a(V2P), vec![topics().v2_sync], data(&[u(r0), u(r1)]), block, tx, li)
}
fn msg(block: u64, ts: u64, logs: Vec<PoolLog>) -> BlockMsg {
    BlockMsg { block, timestamp: ts, l1_block: Some(9_000), base_fee: Some(10), prev_block: None, logs, tick: false, gap_reason: None, bloom: None }
}
fn tick(block: u64, ts: u64) -> BlockMsg {
    BlockMsg { tick: true, ..msg(block, ts, vec![]) }
}

impl Rig {
    fn track(&mut self, pools: Vec<TrackedPool>) {
        let pools: Vec<Value> = pools
            .iter()
            .map(|p| {
                json!({
                    "address": format!("{}", p.address), "kind": match p.kind { PoolKind::V2 => "v2", PoolKind::Solidly => "solidly", PoolKind::V3 => "v3", _ => "v4" },
                    "token0": format!("{}", p.token0), "token1": format!("{}", p.token1), "fee": p.fee, "tickSpacing": p.tick_spacing,
                    "v4Id": p.v4_id.map(|i| format!("{i}")),
                })
            })
            .collect();
        let ans = self.h.track_json(&json!(1), &json!({ "type": "track", "pools": pools }));
        assert_eq!(ans["ok"], json!(true), "{ans}");
        self.settle();
    }
    fn send(&mut self, m: BlockMsg) {
        self.h.block(m);
        self.settle();
    }
    /// Run until every background node job is answered and used.
    fn settle(&mut self) {
        let t0 = std::time::Instant::now();
        loop {
            self.intake.pump();
            if self.intake.outstanding() == 0 {
                return;
            }
            assert!(t0.elapsed().as_secs() < 10, "background work never finished");
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
    fn head_slot(&self, acct: Address, slot: U256) -> Lookup<U256> {
        self.sh.head().unwrap().snap.storage(acct, slot)
    }
    fn state(&self, p: &TrackedPool) -> (PoolState, String) {
        let reg = self.h.c2.reg.read().unwrap();
        let e = &reg.pools[&(p.address, p.v4_id)];
        (e.state, e.reason.clone())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[test]
fn v2_and_coins_follow_events_exactly() {
    let mut r = rig();
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60)); // first message: copy starts, pool loaded at block 100
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready, "{:?}", r.state(&v2_pool()));
    assert_eq!(r.head_slot(a(COIN0), map_slot(a(V2P), 0)), Lookup::Known(u(1000)));
    // Block 101 (t = 62): user swaps 100 coin0 in, gets 360 coin1 out.
    // Logs deliberately out of order: they must be applied by (tx, log index).
    let logs = vec![
        v2_sync(1100, 3640, 101, 3, 2),
        transfer(a(COIN0), a(USER), a(V2P), 100, 101, 3, 0),
        transfer(a(COIN1), a(V2P), a(USER), 360, 101, 3, 1),
        lg(a(V2P), vec![topics().v2_swap, topic_of(a(USER)), topic_of(a(USER))], data(&[u(100), u(0), u(0), u(360)]), 101, 3, 3),
    ];
    r.send(msg(101, 62, logs));
    let q = U256::from(1) << 112usize;
    // Hand-computed truth: 12 s since t=50 with old reserves 1000/4000.
    assert_eq!(r.head_slot(a(V2P), u(8)), Lookup::Known(u(1100) | (u(3640) << 112usize) | (u(62) << 224usize)));
    assert_eq!(r.head_slot(a(V2P), u(9)), Lookup::Known(u(5) + (u(4000) * q / u(1000)) * u(12)));
    assert_eq!(r.head_slot(a(V2P), u(10)), Lookup::Known(u(6) + (u(1000) * q / u(4000)) * u(12)));
    assert_eq!(r.head_slot(a(COIN0), map_slot(a(V2P), 0)), Lookup::Known(u(1100)));
    assert_eq!(r.head_slot(a(COIN1), map_slot(a(V2P), 0)), Lookup::Known(u(3640)));
    // The user's balance is not ours to vouch for: never loaded, still unknown.
    assert_eq!(r.head_slot(a(COIN0), map_slot(a(USER), 0)), Lookup::Missing);
    // The checks see it at head and at block 101; block 100 still has the old state.
    let p = r.sh.resolve(&At::Head).unwrap();
    assert_eq!(p.ctx.l2_block_number, Some(101));
    assert_eq!(p.ctx.timestamp, 62);
    let old = r.sh.resolve(&At::Block(100)).unwrap();
    assert_eq!(old.snap.storage(a(COIN0), map_slot(a(V2P), 0)), Lookup::Known(u(1000)));
    // Ticks move head forward without changing state.
    r.send(tick(102, 63));
    assert_eq!(r.sh.resolve(&At::Head).unwrap().ctx.l2_block_number, Some(102));
    assert_eq!(r.head_slot(a(V2P), u(8)), Lookup::Known(u(1100) | (u(3640) << 112usize) | (u(62) << 224usize)));
    let st = r.h.status_json(true);
    assert_eq!(st["ready"], json!(1));
    assert_eq!(st["counters"]["events_applied"], json!(2)); // Sync + Swap
    assert_eq!(st["counters"]["coin_transfers"], json!(2));
}

#[test]
fn solidly_loaded_and_followed() {
    let mut r = rig();
    r.track(vec![sol_pool()]);
    r.send(tick(100, 60));
    assert_eq!(r.state(&sol_pool()).0, PoolState::Ready, "{:?}", r.state(&sol_pool()));
    // Fees(2e15 coin0): index0 += 2e15 * 1e18 / 2e18 = 1e15. Then Sync at
    // t = 2000: 1960 s since t=40 -> cumulatives and a new observation.
    let fees = lg(a(SOLP), vec![topics().sol_fees, topic_of(a(USER))], data(&[u(2_000_000_000_000_000), u(0)]), 101, 0, 0);
    let sync = lg(a(SOLP), vec![topics().sol_sync], data(&[u(600), u(700)]), 101, 0, 1);
    r.send(msg(101, 2000, vec![fees, sync]));
    assert_eq!(r.state(&sol_pool()).0, PoolState::Ready, "{:?}", r.state(&sol_pool()));
    assert_eq!(r.head_slot(a(SOLP), u(22)), Lookup::Known(u(1_000_000_000_000_000)));
    assert_eq!(r.head_slot(a(SOLP), u(20)), Lookup::Known(u(500 * 1960)));
    assert_eq!(r.head_slot(a(SOLP), u(21)), Lookup::Known(u(800 * 1960)));
    assert_eq!(r.head_slot(a(SOLP), u(14)), Lookup::Known(u(2)));
    assert_eq!(r.head_slot(a(SOLP), obs_slot(u(1), 0)), Lookup::Known(u(2000)));
    assert_eq!(r.head_slot(a(SOLP), u(17)), Lookup::Known(u(600)));
}

#[test]
fn wrong_storage_layout_is_never_followed() {
    let mut r = rig();
    r.chain.lying.lock().unwrap().push(a(V2P));
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    let (s, why) = r.state(&v2_pool());
    assert_eq!(s, PoolState::Unsure);
    assert!(why.starts_with("layout"), "{why}");
    assert_eq!(r.head_slot(a(V2P), u(8)), Lookup::Missing);
}

#[test]
fn unknown_event_makes_pool_unsure_then_reload_from_node() {
    let mut r = rig();
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    let weird = lg(a(V2P), vec![topic("FeeChanged(uint256)")], data(&[u(1)]), 101, 0, 0);
    // Reload waits are 0 in tests, but the reload only happens AFTER the
    // block is published; check the state in between via the hand-driven
    // process() call.
    r.intake.process(msg(101, 61, vec![weird]));
    assert_eq!(r.state(&v2_pool()).0, PoolState::Unsure);
    assert_eq!(r.head_slot(a(V2P), u(8)), Lookup::Missing); // forgotten, not guessed
    // A check missing it is told why.
    let why = r.h.unsure_reason(&[MissItem::Slot(a(V2P), u(8))]).unwrap();
    assert!(why.contains("unknown V2 pool event"), "{why}");
    // While unsure, its events are skipped (they're in the node's state).
    r.intake.process(msg(102, 62, vec![v2_sync(1, 1, 102, 0, 0)]));
    assert_eq!(r.head_slot(a(V2P), u(8)), Lookup::Missing);
    // The chain at 102 (what the node reports): reserves 1/1 at t=62.
    let mut s = genesis();
    s.get_mut(&a(V2P)).unwrap().insert(u(8), u(1) | (u(1) << 112usize) | (u(62) << 224usize));
    r.chain.set(102, s);
    r.settle(); // reload at the head block (102)
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready);
    assert_eq!(r.head_slot(a(V2P), u(8)), Lookup::Known(u(1) | (u(1) << 112usize) | (u(62) << 224usize)));
}

#[test]
fn reorg_removed_log_forgets_pool_from_that_block() {
    let mut r = rig();
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    r.intake.process(msg(101, 61, vec![v2_sync(900, 4500, 101, 0, 0)]));
    r.intake.process(tick(102, 62));
    assert!(matches!(r.sh.resolve(&At::Block(101)).unwrap().snap.storage(a(V2P), u(8)), Lookup::Known(_)));
    // The node takes back block 101's report.
    let mut gone = v2_sync(900, 4500, 101, 0, 0);
    gone.removed = true;
    r.intake.process(msg(103, 63, vec![gone]));
    assert_eq!(r.state(&v2_pool()).0, PoolState::Unsure);
    for b in [101, 102, 103] {
        assert_eq!(r.sh.resolve(&At::Block(b)).unwrap().snap.storage(a(V2P), u(8)), Lookup::Missing, "block {b}");
    }
    // Block 100 (before the reorg) is untouched.
    assert!(matches!(r.sh.resolve(&At::Block(100)).unwrap().snap.storage(a(V2P), u(8)), Lookup::Known(_)));
    assert_eq!(r.h.status_json(false)["counters"]["reorgs"], json!(1));
}

#[test]
fn duplicate_block_ignored_but_different_resend_is_a_reorg() {
    let mut r = rig();
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    let m = msg(101, 61, vec![v2_sync(900, 4500, 101, 0, 5)]);
    r.intake.process(m.clone());
    r.intake.process(m); // same again: duplicate
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready);
    assert_eq!(r.h.status_json(false)["counters"]["duplicate_blocks"], json!(1));
    // A late report for the pool AFTER its applied one: applied (per pool).
    r.intake.process(msg(101, 61, vec![v2_sync(901, 4500, 101, 0, 7)]));
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready);
    assert_eq!(r.head_slot(a(V2P), u(8)), Lookup::Known(u(901) | (u(4500) << 112usize) | (u(61) << 224usize)));
    // A late report BEFORE an applied one of the same pool: can't be exact.
    r.intake.process(msg(101, 61, vec![v2_sync(902, 4500, 101, 0, 1)]));
    assert_eq!(r.state(&v2_pool()).0, PoolState::Unsure);
}

#[test]
fn late_report_for_an_older_block_is_applied_to_that_pool_in_every_kept_version() {
    let mut r = rig();
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    // Block 101 had the pool's Sync, but its coin transfers arrive only
    // after blocks 102 and 103 were applied.
    r.intake.process(msg(101, 62, vec![v2_sync(1100, 3640, 101, 3, 2)]));
    r.intake.process(tick(102, 63));
    r.intake.process(tick(103, 64));
    r.intake.process(msg(101, 62, vec![
        transfer(a(COIN0), a(USER), a(V2P), 100, 101, 3, 0),
        transfer(a(COIN1), a(V2P), a(USER), 360, 101, 3, 1),
    ]));
    // Transfers sit BEFORE the Sync in the block, but they touch only the
    // coin balances (no later transfer applied to them): exact.
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready);
    for b in [101, 102, 103] {
        let snap = r.sh.resolve(&At::Block(b)).unwrap().snap;
        assert_eq!(snap.storage(a(COIN0), map_slot(a(V2P), 0)), Lookup::Known(u(1100)), "block {b}");
        assert_eq!(snap.storage(a(COIN1), map_slot(a(V2P), 0)), Lookup::Known(u(3640)), "block {b}");
    }
    let old = r.sh.resolve(&At::Block(100)).unwrap().snap;
    assert_eq!(old.storage(a(COIN0), map_slot(a(V2P), 0)), Lookup::Known(u(1000)));
    // A late pool event for block 102 after nothing newer on the pool: applied
    // in 102 and 103 (not in 101).
    r.intake.process(msg(102, 63, vec![v2_sync(1200, 3500, 102, 0, 0)]));
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready);
    assert_eq!(r.sh.resolve(&At::Block(103)).unwrap().snap.storage(a(V2P), u(8)), Lookup::Known(u(1200) | (u(3500) << 112usize) | (u(63) << 224usize)));
    assert_eq!(r.sh.resolve(&At::Block(101)).unwrap().snap.storage(a(V2P), u(8)), Lookup::Known(u(1100) | (u(3640) << 112usize) | (u(62) << 224usize)));
    assert_eq!(r.h.c2.stats.reorgs.load(std::sync::atomic::Ordering::Relaxed), 0);
}

/// (copy2-n: a gap is first filled from the node's logs, see
/// tests/copy2_resume_anvil.rs; this is the reload when that is not
/// possible: here switched off, ARBSIM_COPY2_RESUME_MAX_BLOCKS=0.)
#[test]
fn lost_message_reloads_everything() {
    let mut r = rig_with(C2Config { resume_max_blocks: 0, ..C2Config::for_tests() });
    r.track(vec![v2_pool(), sol_pool()]);
    r.send(tick(100, 60));
    let mut m = tick(101, 61);
    m.prev_block = Some(100);
    r.intake.process(m);
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready);
    let mut m = tick(105, 65);
    m.prev_block = Some(104); // we never got 104
    r.intake.process(m);
    assert_eq!(r.state(&v2_pool()).0, PoolState::Unsure);
    assert_eq!(r.state(&sol_pool()).0, PoolState::Unsure);
    assert_eq!(r.h.status_json(false)["counters"]["gaps"], json!(1));
}

/// Oct 22 live failure: the bot sent "reload every pool" (prevBlock = this
/// block) every 2-25 s. Each signal used to count as a strike against EVERY
/// pool, doubling its wait before reloading (2 s, 4 s, ... 10 min), so after
/// a burst the copy sat at 0 loading / all unsure for minutes. Now: no
/// strike, one reload per pool, the reason counted in status, and the pools
/// come back as soon as the signals stop.
#[test]
fn gap_signal_burst_does_not_keep_the_copy_unsure() {
    // The reload path (when a gap can't be filled from the node's logs;
    // copy2-n fills it first: tests/copy2_resume_anvil.rs).
    let cfg = C2Config { reload_ms: 40, reload_max_ms: 600_000, resume_max_blocks: 0, ..C2Config::for_tests() };
    let mut r = rig_with(cfg);
    r.track(vec![v2_pool(), sol_pool()]);
    r.send(tick(100, 60));
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready);
    // A burst of 12 "I missed something" signals (prevBlock = the block itself).
    for b in 101..=112u64 {
        let mut m = tick(b, 60 + b - 100);
        m.prev_block = Some(b);
        m.gap_reason = Some("block time unknown".into());
        r.intake.process(m);
        r.intake.pump();
    }
    assert_eq!(r.state(&v2_pool()).0, PoolState::Unsure);
    {
        let reg = r.h.c2.reg.read().unwrap();
        for e in reg.pools.values() {
            assert_eq!(e.strikes, 0, "a gap signal is not the pool's fault: no strike");
            assert!(e.retry_at <= std::time::Instant::now() + std::time::Duration::from_millis(40), "reload not pushed back by the burst");
        }
    }
    let st = r.h.status_json(false);
    assert_eq!(st["counters"]["gaps"], json!(12));
    assert_eq!(st["gapReasons"]["block time unknown"], json!(12), "{st}");
    // The signals stop: the next blocks arrive in order, pools reload once.
    std::thread::sleep(std::time::Duration::from_millis(60));
    let mut m = tick(113, 73);
    m.prev_block = Some(112);
    r.send(m);
    let mut m = tick(114, 74);
    m.prev_block = Some(113);
    r.send(m);
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready, "{:?}", r.state(&v2_pool()));
    assert_eq!(r.state(&sol_pool()).0, PoolState::Ready, "{:?}", r.state(&sol_pool()));
    // A message really lost between bot and copy (no reason, prev != block).
    let mut m = tick(120, 80);
    m.prev_block = Some(119);
    r.intake.process(m);
    assert_eq!(r.h.status_json(false)["gapReasons"]["message lost on the way"], json!(1));
}

#[test]
fn coin_underflow_forgets_balance_and_other_side_is_forgotten() {
    let mut r = rig();
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    // A check loaded the user's coin0 balance (fill at head).
    r.h.fill(vec![MissItem::Slot(a(COIN0), map_slot(a(USER), 0))]);
    r.settle();
    assert_eq!(r.head_slot(a(COIN0), map_slot(a(USER), 0)), Lookup::Known(u(1_000_000)));
    // Pool sends 2000 coin0 while we think it holds 1000: our value was wrong.
    r.intake.process(msg(101, 61, vec![transfer(a(COIN0), a(V2P), a(USER), 2000, 101, 0, 0)]));
    assert_eq!(r.head_slot(a(COIN0), map_slot(a(V2P), 0)), Lookup::Missing);
    // The user's side: not followed -> forgotten.
    assert_eq!(r.head_slot(a(COIN0), map_slot(a(USER), 0)), Lookup::Missing);
}

#[test]
fn fills_refused_for_pools_not_ready() {
    let mut r = rig();
    r.chain.lying.lock().unwrap().push(a(V2P));
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    r.h.fill(vec![MissItem::Slot(a(V2P), u(8))]);
    r.settle();
    assert_eq!(r.head_slot(a(V2P), u(8)), Lookup::Missing);
    assert!(r.h.status_json(false)["counters"]["fill_refused"].as_u64().unwrap() >= 1);
}

#[test]
fn replay_kinds_wait_for_workstream_b() {
    let mut r = rig();
    let v3 = TrackedPool { address: a(0xc3), kind: PoolKind::V3, ..v2_pool() };
    {
        // The V3 pool holds coins too.
        let mut s = genesis();
        s.get_mut(&a(COIN0)).unwrap().insert(map_slot(a(0xc3), 0), u(7));
        s.get_mut(&a(COIN1)).unwrap().insert(map_slot(a(0xc3), 0), u(8));
        r.chain.set(100, s);
    }
    r.track(vec![v3.clone()]);
    r.send(tick(100, 60));
    assert_eq!(r.state(&v3).0, PoolState::Ready); // coins checked; pool state lazily
    assert_eq!(r.head_slot(a(COIN0), map_slot(a(0xc3), 0)), Lookup::Known(u(7)));
    let swap = lg(a(0xc3), vec![topic("Swap(address,address,int256,int256,uint160,uint128,int24)")], data(&[u(0); 5]), 101, 0, 0);
    r.intake.process(msg(101, 61, vec![swap]));
    // A malformed Swap: unsure whether replay is the placeholder ("replay
    // not built") or workstream B's real one ("too few topics").
    let (s, why) = r.state(&v3);
    assert_eq!(s, PoolState::Unsure, "{why}");
    assert!(!why.is_empty());
}

#[test]
fn untracked_pool_is_forgotten() {
    let mut r = rig();
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    assert!(matches!(r.head_slot(a(V2P), u(8)), Lookup::Known(_)));
    r.track(vec![]);
    assert_eq!(r.head_slot(a(V2P), u(8)), Lookup::Missing);
    assert_eq!(r.head_slot(a(COIN0), map_slot(a(V2P), 0)), Lookup::Missing);
}

#[test]
fn wire_messages_parse() {
    let v = json!({
        "type": "pool_logs", "block": "0x65", "timestamp": 61, "l1Block": 9000, "prevBlock": 100,
        "logs": [{
            "address": format!("{}", a(V2P)), "topics": [format!("{}", topics().v2_sync)],
            "data": format!("0x{:064x}{:064x}", 5, 6), "blockNumber": "0x65", "transactionIndex": "0x1",
            "logIndex": "0x2", "transactionHash": format!("{}", B256::with_last_byte(9)), "removed": false
        }]
    });
    let m = arbsim::copy2::intake::parse_block_msg(&v).unwrap();
    assert_eq!((m.block, m.timestamp, m.l1_block, m.prev_block, m.tick), (101, 61, Some(9000), Some(100), false));
    assert_eq!((m.logs[0].tx_index, m.logs[0].log_index), (1, 2));
    let t = arbsim::copy2::intake::parse_block_msg(&json!({"type":"block_tick","block":7,"timestamp":1})).unwrap();
    assert!(t.tick);
    let (pools, layouts, skipped) = arbsim::copy2::intake::parse_track(&json!({
        "pools": [
            {"address": format!("{}", a(1)), "kind": "v2", "token0": format!("{}", a(2)), "token1": format!("{}", a(3))},
            {"address": format!("{}", a(1)), "kind": "curve", "token0": format!("{}", a(2)), "token1": format!("{}", a(3))},
            {"address": format!("{}", a(1)), "kind": "v4", "token0": format!("{}", a(2)), "token1": format!("{}", a(3))}
        ],
        "coinSlots": {"robinhood:0x0000000000000000000000000000000000000002": {"layout": "solidity", "slot": 3}}
    }))
    .unwrap();
    assert_eq!(pools.len(), 1);
    assert_eq!(skipped.len(), 2); // unknown kind; v4 without id
    assert_eq!(layouts, vec![(a(2), BalanceLayout::solidity(3))]);
}

#[test]
fn server_answers_track_and_status_in_pool_events_mode() {
    let chain = Arc::new(FakeChain::new());
    chain.set(100, genesis());
    let ctx = arbsim::serve::build_with(Config::for_tests(), Some(chain as Arc<dyn NodeApi>), arbsim::serve::Source::PoolEvents);
    let ans = arbsim::server::handle(&ctx, &json!({"id": 1, "type": "track", "pools": [{
        "address": format!("{}", a(V2P)), "kind": "v2", "token0": format!("{}", a(COIN0)), "token1": format!("{}", a(COIN1))}]}));
    assert_eq!(ans["ok"], json!(true));
    assert_eq!(ans["tracked"], json!(1));
    let st = arbsim::server::handle(&ctx, &json!({"id": 2, "type": "status", "pools": true}));
    assert_eq!(st["copy2"]["source"], json!("pool-events"));
    // Feed mode refuses `track`.
    let feed = arbsim::serve::build(Config::for_tests(), None);
    let ans = arbsim::server::handle(&feed, &json!({"id": 3, "type": "track", "pools": []}));
    assert_eq!(ans["ok"], json!(false));
    ctx.copy2.as_ref().unwrap().stop();
}

#[test]
fn load_is_carried_forward_through_reports_after_the_fetch() {
    // The node answers slowly: block 101 arrives while the pool's values
    // (fetched AT block 100) are still on their way. Its reports for 101
    // must be applied to them from the buffer, exactly.
    let mut r = rig();
    *r.chain.delay_ms.lock().unwrap() = 30;
    r.track(vec![v2_pool()]); // nothing to do yet (no block)
    r.h.block(tick(100, 60));
    let t0 = std::time::Instant::now();
    // Wait until the load itself (not just the coin probes) is on its way.
    while r.h.c2.stats.loads.load(std::sync::atomic::Ordering::Relaxed) == 0 {
        r.intake.pump();
        assert!(t0.elapsed().as_secs() < 5);
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert_eq!(r.state(&v2_pool()).0, PoolState::Loading);
    let logs = vec![
        transfer(a(COIN0), a(USER), a(V2P), 100, 101, 3, 0),
        transfer(a(COIN1), a(V2P), a(USER), 360, 101, 3, 1),
        v2_sync(1100, 3640, 101, 3, 2),
    ];
    r.h.block(msg(101, 62, logs));
    r.intake.pump(); // applied at once, without waiting for the node
    assert_eq!(r.h.c2.last_block.load(std::sync::atomic::Ordering::Relaxed), 101);
    r.settle();
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready, "{:?}", r.state(&v2_pool()));
    assert!(r.h.c2.stats.carried_events.load(std::sync::atomic::Ordering::Relaxed) >= 1);
    let q = U256::from(1) << 112usize;
    assert_eq!(r.head_slot(a(V2P), u(8)), Lookup::Known(u(1100) | (u(3640) << 112usize) | (u(62) << 224usize)));
    assert_eq!(r.head_slot(a(V2P), u(9)), Lookup::Known(u(5) + (u(4000) * q / u(1000)) * u(12)));
    assert_eq!(r.head_slot(a(COIN0), map_slot(a(V2P), 0)), Lookup::Known(u(1100)));
    assert_eq!(r.head_slot(a(COIN1), map_slot(a(V2P), 0)), Lookup::Known(u(3640)));
    // Every node call went the paid-first way.
    assert_eq!(*r.chain.paid_calls.lock().unwrap(), *r.chain.calls.lock().unwrap());
}

#[test]
fn replay_pool_needing_values_loads_in_background_without_holding_the_block() {
    let mut r = rig();
    let v3 = TrackedPool { address: a(0xc3), kind: PoolKind::V3, ..v2_pool() };
    let mut s = genesis();
    s.get_mut(&a(COIN0)).unwrap().insert(map_slot(a(0xc3), 0), u(7));
    s.get_mut(&a(COIN1)).unwrap().insert(map_slot(a(0xc3), 0), u(8));
    r.chain.set(100, s);
    r.track(vec![v3.clone()]);
    r.send(tick(100, 60));
    assert_eq!(r.state(&v3).0, PoolState::Ready);
    *r.chain.delay_ms.lock().unwrap() = 30;
    // A well-formed V3 Swap: the replay needs the pool's code / storage,
    // which we never loaded.
    let swap = lg(
        a(0xc3),
        vec![topic("Swap(address,address,int256,int256,uint160,uint128,int24)"), topic_of(a(USER)), topic_of(a(USER))],
        data(&[u(100), U256::ZERO.wrapping_sub(u(90)), U256::from(1) << 96usize, u(1_000_000), u(0)]),
        101,
        0,
        0,
    );
    let t = std::time::Instant::now();
    r.intake.process(msg(101, 61, vec![swap]));
    r.intake.pump(); // sends the background fetch, doesn't wait for it
    assert!(t.elapsed() < std::time::Duration::from_millis(25), "block waited for the node");
    assert_eq!(r.h.c2.last_block.load(std::sync::atomic::Ordering::Relaxed), 101);
    let (st, why) = r.state(&v3);
    assert!(st != PoolState::Ready, "{why}");
    // Checks touching it are told it isn't ready.
    assert!(r.h.unsure_reason(&[MissItem::Slot(a(0xc3), u(0))]).is_some());
    r.settle();
}

/// A fake node that is slow like a real one: 20 ms per 25 calls.
struct SlowChain(Arc<FakeChain>);
impl NodeApi for SlowChain {
    fn call_batch(&self, c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        std::thread::sleep(std::time::Duration::from_millis(20 * calls.len().div_ceil(25) as u64));
        self.0.call_batch(c, calls)
    }
    fn call_batch_paid(&self, c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        *self.0.paid_calls.lock().unwrap() += calls.len();
        self.call_batch(c, calls)
    }
}

#[test]
fn loading_800_pools_does_not_delay_block_application() {
    use std::sync::atomic::Ordering::Relaxed;
    use std::time::{Duration, Instant};
    let chain = Arc::new(FakeChain::new());
    let pool_addr = |i: u16| {
        let mut b = [0u8; 20];
        b[0] = 0x99;
        b[18..].copy_from_slice(&i.to_be_bytes());
        Address::from(b)
    };
    let mut s = genesis();
    let mut pools = Vec::new();
    for i in 0..800u16 {
        let p = pool_addr(i);
        let st = s.entry(p).or_default();
        st.insert(u(0), u(2000));
        st.insert(u(6), addr_word(a(COIN0)));
        st.insert(u(7), addr_word(a(COIN1)));
        st.insert(u(8), u(1000) | (u(4000) << 112usize) | (u(1000) << 224usize));
        s.get_mut(&a(COIN0)).unwrap().insert(map_slot(p, 0), u(1000));
        s.get_mut(&a(COIN1)).unwrap().insert(map_slot(p, 0), u(4000));
        pools.push(TrackedPool { address: p, ..v2_pool() });
    }
    chain.set(100, s.clone());
    // Pool 0 trades at block 130 (all blocks share timestamp 1000, so the
    // price totals don't move): the node's state from 130 on shows it.
    let p0 = pool_addr(0);
    s.get_mut(&p0).unwrap().insert(u(8), u(1100) | (u(3640) << 112usize) | (u(1000) << 224usize));
    s.get_mut(&a(COIN0)).unwrap().insert(map_slot(p0, 0), u(1100));
    s.get_mut(&a(COIN1)).unwrap().insert(map_slot(p0, 0), u(3640));
    chain.set(130, s);

    let node: Arc<dyn NodeApi> = Arc::new(SlowChain(chain.clone()));
    let sh = Shared::new(Config::for_tests(), Some(node), Arc::new(Volatile::default()));
    let cfg = C2Config { loaders: 4, ..C2Config::for_tests() };
    let h = arbsim::copy2::intake::spawn(sh.clone(), Arc::new(FillQueue::new(1000, 100)), cfg);
    let pj: Vec<Value> = pools
        .iter()
        .map(|p| json!({"address": format!("{}", p.address), "kind": "v2", "token0": format!("{}", a(COIN0)), "token1": format!("{}", a(COIN1))}))
        .collect();
    assert_eq!(h.track_json(&json!(1), &json!({"pools": pj}))["tracked"], json!(800));

    let mut worst = Duration::ZERO;
    let mut loading_seen = 0;
    for b in 100..=160u64 {
        let logs = if b == 130 {
            vec![
                transfer(a(COIN0), a(USER), p0, 100, 130, 0, 0),
                transfer(a(COIN1), p0, a(USER), 360, 130, 0, 1),
                lg(p0, vec![topics().v2_sync], data(&[u(1100), u(3640)]), 130, 0, 2),
            ]
        } else {
            vec![]
        };
        let mut m = if logs.is_empty() { tick(b, 1000) } else { msg(b, 1000, logs) };
        m.prev_block = if b > 100 { Some(b - 1) } else { None };
        let t = Instant::now();
        h.block(m);
        while h.c2.last_block.load(Relaxed) < b {
            assert!(t.elapsed() < Duration::from_secs(5), "block {b} never applied");
            std::thread::sleep(Duration::from_micros(200));
        }
        worst = worst.max(t.elapsed());
        loading_seen = loading_seen.max(h.status_json(false)["loading"].as_u64().unwrap());
        std::thread::sleep(Duration::from_millis(10));
    }
    // Pools were still loading while blocks went in, and no block waited.
    assert!(loading_seen > 0, "the test should overlap loading and blocks");
    assert!(worst < Duration::from_millis(250), "a block waited {worst:?} (loading must never hold blocks up)");

    let t = Instant::now();
    loop {
        let st = h.status_json(false);
        if st["ready"] == json!(800) {
            break;
        }
        assert!(t.elapsed() < Duration::from_secs(30), "not all pools ready: {st}");
        std::thread::sleep(Duration::from_millis(20));
    }
    let head = sh.head().unwrap();
    assert_eq!(head.block, 160);
    assert_eq!(head.snap.storage(p0, u(8)), Lookup::Known(u(1100) | (u(3640) << 112usize) | (u(1000) << 224usize)));
    assert_eq!(head.snap.storage(a(COIN0), map_slot(p0, 0)), Lookup::Known(u(1100)));
    assert_eq!(head.snap.storage(pool_addr(799), u(8)), Lookup::Known(u(1000) | (u(4000) << 112usize) | (u(1000) << 224usize)));
    let st = h.status_json(false);
    eprintln!("800 pools: worst block wait {worst:?}; node requests {}; load round {}", st["nodeRequests"], st["loadRound"]);
    assert_eq!(*chain.paid_calls.lock().unwrap(), *chain.calls.lock().unwrap());
    h.stop();
}

#[test]
fn node_behind_the_copy_loads_at_its_block_and_carries_forward() {
    // The websocket reports run AHEAD of the node: the node only has block
    // 100 while the copy is at 103. Loading must fetch at 100 (not fail, and
    // never call a coin "not found") and apply 101..103 from the reports.
    let mut r = rig();
    *r.chain.tip.lock().unwrap() = 100;
    r.track(vec![v2_pool()]);
    r.h.block(tick(100, 60));
    r.h.block(tick(101, 61));
    r.h.block(msg(102, 62, vec![
        transfer(a(COIN0), a(USER), a(V2P), 100, 102, 0, 0),
        transfer(a(COIN1), a(V2P), a(USER), 360, 102, 0, 1),
        v2_sync(1100, 3640, 102, 0, 2),
    ]));
    r.h.block(tick(103, 63));
    r.settle();
    // (A load can still be "waiting for its turn" when nothing is in flight
    // - e.g. a short retry wait under a busy test run: keep pumping.)
    let t0 = std::time::Instant::now();
    while r.state(&v2_pool()).0 == PoolState::Loading && t0.elapsed().as_secs() < 10 {
        r.intake.pump();
        r.settle();
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready, "{:?}", r.state(&v2_pool()));
    let q = U256::from(1) << 112usize;
    assert_eq!(r.head_slot(a(V2P), u(8)), Lookup::Known(u(1100) | (u(3640) << 112usize) | (u(62) << 224usize)));
    assert_eq!(r.head_slot(a(V2P), u(9)), Lookup::Known(u(5) + (u(4000) * q / u(1000)) * u(12)));
    assert_eq!(r.head_slot(a(COIN0), map_slot(a(V2P), 0)), Lookup::Known(u(1100)));
    assert_eq!(r.sh.head().unwrap().block, 103);
}

#[test]
fn probe_errors_are_retried_not_called_not_found() {
    let mut r = rig();
    *r.chain.probe_errors.lock().unwrap() = 3; // rate limited three times
    r.track(vec![v2_pool()]);
    r.h.block(tick(100, 60));
    let t0 = std::time::Instant::now();
    while r.state(&v2_pool()).0 != PoolState::Ready {
        r.intake.pump();
        let (st, why) = r.state(&v2_pool());
        assert!(!why.contains("can't find"), "condemned on a node error: {why}");
        assert!(st != PoolState::Unsure, "{why}");
        assert!(t0.elapsed().as_secs() < 20, "never ready: {why}");
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(r.h.c2.stats.probe_errors.load(std::sync::atomic::Ordering::Relaxed) >= 1);
}

#[test]
fn coin_slots_from_the_bot_skip_probing() {
    let mut r = rig();
    let ans = r.h.coin_slots_json(&json!(5), &json!({"type": "coin_slots", "coinSlots": {
        format!("robinhood:{}", a(COIN0)): {"layout": "solidity", "slot": 0},
        format!("{}", a(COIN1)): {"layout": "solidity", "slot": 0}
    }}));
    assert_eq!(ans["accepted"], json!(2));
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready);
    assert_eq!(*r.chain.probes.lock().unwrap(), 0);
}

#[test]
fn late_reports_after_the_known_ones_are_applied_not_a_reorg() {
    let mut r = rig();
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    let first = vec![transfer(a(COIN0), a(USER), a(V2P), 100, 101, 3, 0)];
    r.intake.process(msg(101, 62, first.clone()));
    // Re-sent with the rest of the same transaction after it.
    let mut all = first.clone();
    all.push(transfer(a(COIN1), a(V2P), a(USER), 360, 101, 3, 1));
    all.push(v2_sync(1100, 3640, 101, 3, 2));
    r.intake.process(msg(101, 62, all));
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready, "{:?}", r.state(&v2_pool()));
    assert_eq!(r.h.c2.stats.reorgs.load(std::sync::atomic::Ordering::Relaxed), 0);
    assert_eq!(r.h.c2.stats.late_reports_applied.load(std::sync::atomic::Ordering::Relaxed), 1);
    assert_eq!(r.head_slot(a(V2P), u(8)), Lookup::Known(u(1100) | (u(3640) << 112usize) | (u(62) << 224usize)));
    assert_eq!(r.head_slot(a(COIN0), map_slot(a(V2P), 0)), Lookup::Known(u(1100)));
    assert_eq!(r.head_slot(a(COIN1), map_slot(a(V2P), 0)), Lookup::Known(u(3640)));
    assert_eq!(r.sh.head().unwrap().block, 101);
    // A late coin transfer BEFORE one already applied to that balance: it
    // used to make the balance forgotten; adding is exact in any order
    // (copy2-l), so it is added; the pool stays.
    let mut odd = vec![transfer(a(COIN0), a(USER), a(V2P), 1, 101, 1, 0)];
    odd.push(transfer(a(COIN0), a(USER), a(V2P), 100, 101, 3, 0));
    odd.push(transfer(a(COIN1), a(V2P), a(USER), 360, 101, 3, 1));
    odd.push(v2_sync(1100, 3640, 101, 3, 2));
    r.intake.process(msg(101, 62, odd));
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready);
    assert_eq!(r.head_slot(a(COIN0), map_slot(a(V2P), 0)), Lookup::Known(u(1101)));
    assert_eq!(r.head_slot(a(COIN1), map_slot(a(V2P), 0)), Lookup::Known(u(3640)));
}

#[test]
fn coin_with_namespaced_storage_is_found_by_trace_and_followed() {
    let mut r = rig();
    // A coin that keeps balances somewhere the probe can't see (namespaced).
    // (Not at 0x01..: traces never teach anything about precompile / system
    // addresses.)
    let coin = pa(0xc1);
    let pool = TrackedPool { address: pa(0xa4), token0: coin, ..v2_pool() };
    r.chain.namespaced.lock().unwrap().push(coin);
    let mut s = genesis();
    let mut p = s[&a(V2P)].clone();
    p.insert(u(6), addr_word(coin));
    s.insert(pool.address, p);
    let c0 = s.entry(coin).or_default();
    c0.insert(ns_slot(pool.address), u(1000));
    c0.insert(ns_slot(a(USER)), u(1_000_000));
    c0.insert(u(5), u(1)); // a setting balanceOf reads (e.g. "not paused")
    s.get_mut(&a(COIN1)).unwrap().insert(map_slot(pool.address, 0), u(4000));
    r.chain.set(100, s);
    r.track(vec![pool.clone()]);
    r.send(tick(100, 60));
    assert_eq!(r.state(&pool).0, PoolState::Ready, "{:?}", r.state(&pool));
    assert_eq!(*r.chain.traces.lock().unwrap(), 1);
    assert_eq!(r.head_slot(coin, ns_slot(pool.address)), Lookup::Known(u(1000)));
    assert_eq!(r.head_slot(coin, u(5)), Lookup::Known(u(1))); // what balanceOf read
    // Followed from Transfer events like any other coin.
    r.intake.process(msg(101, 61, vec![transfer(coin, a(USER), pool.address, 100, 101, 0, 0)]));
    assert_eq!(r.head_slot(coin, ns_slot(pool.address)), Lookup::Known(u(1100)));
    // The other side can't be named: anything else of that coin we held is forgotten.
    assert_eq!(r.head_slot(coin, u(5)), Lookup::Missing);
}

#[test]
fn ready_pools_hold_their_code_and_swap_slots() {
    let mut r = rig();
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready);
    let head = r.sh.head().unwrap();
    let view = arbsim::state::snap::View::new(head.snap.clone());
    assert!(matches!(view.account(a(V2P)), Lookup::Known(Some(_))), "pool code loaded");
    assert!(matches!(view.account(a(COIN0)), Lookup::Known(Some(_))), "coin code loaded");
    for sl in [0u128, 6, 7, 8, 9, 10, 12] {
        assert!(matches!(head.snap.storage(a(V2P), u(sl)), Lookup::Known(_)), "slot {sl}");
    }
}

#[test]
fn pools_with_recent_events_load_first() {
    // One loader, one pool per load: the order is visible.
    let mut r = rig_with(C2Config { loaders: 1, load_batch: 1, ..C2Config::for_tests() });
    let quiet = v2_pool();
    let busy = TrackedPool { address: a(0xa3), ..v2_pool() };
    let mut s = genesis();
    let g = s[&a(V2P)].clone();
    s.insert(a(0xa3), g);
    for c in [COIN0, COIN1] {
        let v = s[&a(c)][&map_slot(a(V2P), 0)];
        s.get_mut(&a(c)).unwrap().insert(map_slot(a(0xa3), 0), v);
    }
    r.chain.set(100, s);
    r.track(vec![quiet.clone(), busy.clone()]);
    // The busy pool trades in the first block we see.
    r.h.block(msg(100, 60, vec![lg(a(0xa3), vec![topics().v2_sync], data(&[u(1000), u(4000)]), 100, 0, 0)]));
    let t0 = std::time::Instant::now();
    loop {
        r.intake.pump();
        let (qs, bs) = (r.state(&quiet).0, r.state(&busy).0);
        if qs == PoolState::Ready || bs == PoolState::Ready {
            assert_eq!(bs, PoolState::Ready, "the pool with events should be ready first");
            break;
        }
        assert!(t0.elapsed().as_secs() < 10);
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    r.settle();
    let st = r.h.status_json(false);
    assert!(st["loader"]["threads"].as_u64().unwrap() >= 1, "{st}");
    assert!(st["loader"]["byKind"]["load"]["jobs"].as_u64().unwrap() >= 2, "{st}");
}

/// The fake node behind the REAL node budget (speed limit), used the way
/// NodeClient uses it: every chunk of 25 calls takes its share first.
struct RateLimited {
    chain: Arc<FakeChain>,
    budget: arbsim::node::Budget,
    per_chunk_ms: u64,
}
impl NodeApi for RateLimited {
    fn call_batch(&self, c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        let mut out = Vec::new();
        for ch in calls.chunks(25) {
            self.budget.take(c, ch.len() as u64)?;
            std::thread::sleep(std::time::Duration::from_millis(self.per_chunk_ms));
            out.extend(self.chain.call_batch(c, ch)?);
        }
        Ok(out)
    }
    fn call_batch_paid(&self, c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        *self.chain.paid_calls.lock().unwrap() += calls.len();
        self.call_batch(c, calls)
    }
}

#[test]
fn loading_keeps_flowing_under_the_speed_limit_with_checks_asking_too() {
    use std::sync::atomic::Ordering::Relaxed;
    use std::time::{Duration, Instant};
    let chain = Arc::new(FakeChain::new());
    let pool_addr = |i: u16| {
        let mut b = [0u8; 20];
        b[0] = 0x77;
        b[18..].copy_from_slice(&i.to_be_bytes());
        Address::from(b)
    };
    let n = 120u16;
    let mut s = genesis();
    let mut pj = Vec::new();
    for i in 0..n {
        let p = pool_addr(i);
        let st = s.entry(p).or_default();
        st.insert(u(0), u(2000));
        st.insert(u(6), addr_word(a(COIN0)));
        st.insert(u(7), addr_word(a(COIN1)));
        st.insert(u(8), u(1000) | (u(4000) << 112usize) | (u(1000) << 224usize));
        s.get_mut(&a(COIN0)).unwrap().insert(map_slot(p, 0), u(1000));
        s.get_mut(&a(COIN1)).unwrap().insert(map_slot(p, 0), u(4000));
        pj.push(json!({"address": format!("{p}"), "kind": "v2", "token0": format!("{}", a(COIN0)), "token1": format!("{}", a(COIN1))}));
    }
    chain.set(100, s);
    // 400 calls/s, chunks of 25 take 10 ms: ~1,700 calls needed -> ~4-5 s.
    let node: Arc<dyn NodeApi> = Arc::new(RateLimited { chain: chain.clone(), budget: arbsim::node::Budget::new(1_000_000, 400.0, None), per_chunk_ms: 10 });
    let sh = Shared::new(Config::for_tests(), Some(node), Arc::new(Volatile::default()));
    let cfg = C2Config { loaders: 8, load_batch: 25, ..C2Config::for_tests() };
    let h = arbsim::copy2::intake::spawn(sh.clone(), Arc::new(FillQueue::new(100_000, 100)), cfg);
    assert_eq!(h.track_json(&json!(1), &json!({"pools": pj}))["tracked"], json!(n as u64));
    let t0 = Instant::now();
    let mut b = 100u64;
    let mut last_req = 0;
    let mut last_move = Instant::now();
    loop {
        // Blocks keep coming, and checks keep asking for values (fills).
        let mut m = tick(b, 1000 + b);
        m.prev_block = if b > 100 { Some(b - 1) } else { None };
        h.block(m);
        b += 1;
        let miss: Vec<MissItem> = (0..40u64).map(|i| MissItem::Slot(a(USER), U256::from(b * 1000 + i))).collect();
        h.fill(miss);
        std::thread::sleep(Duration::from_millis(50));
        let st = h.status_json(false);
        let req = st["nodeRequests"].as_u64().unwrap();
        if req != last_req {
            last_req = req;
            last_move = Instant::now();
        }
        assert!(last_move.elapsed() < Duration::from_secs(5), "node requests stopped flowing: {st}");
        if st["ready"] == json!(n as u64) {
            break;
        }
        assert!(t0.elapsed() < Duration::from_secs(40), "not all ready in 40 s: {st}");
    }
    eprintln!("flowing test: {n} pools ready in {:?}", t0.elapsed());
    assert!(h.c2.last_block.load(Relaxed) >= 100);
    h.stop();
}

/// A node like Chainstack under a plan limit: HTTP requests of up to 25
/// calls, each taking `latency`; more than `limit` HTTP REQUESTS in any 1 s
/// window and the node answers "rate limited (429)".
struct PlanNode {
    chain: Arc<FakeChain>,
    limit: u64,
    latency: std::time::Duration,
    window: Mutex<std::collections::VecDeque<(std::time::Instant, u64)>>,
    sent: std::sync::atomic::AtomicU64,
    rejected: std::sync::atomic::AtomicU64,
    worst_second: std::sync::atomic::AtomicU64,
    /// The node client's own speed limit (node.rs Budget), as in production.
    budget: arbsim::node::Budget,
}
impl PlanNode {
    fn admit(&self, n: u64) -> bool {
        use std::sync::atomic::Ordering::Relaxed;
        let now = std::time::Instant::now();
        let mut w = self.window.lock().unwrap();
        while w.front().is_some_and(|x| now.duration_since(x.0) >= std::time::Duration::from_secs(1)) {
            w.pop_front();
        }
        let used: u64 = w.iter().map(|x| x.1).sum();
        self.sent.fetch_add(n, Relaxed);
        w.push_back((now, n));
        self.worst_second.fetch_max(used + n, Relaxed);
        if used + n > self.limit {
            self.rejected.fetch_add(n, Relaxed);
            return false;
        }
        true
    }
}
impl NodeApi for PlanNode {
    fn call_batch(&self, c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        let mut out = Vec::new();
        for ch in calls.chunks(25) {
            // As NodeClient: one token per HTTP request.
            self.budget.take(c, 1)?;
            std::thread::sleep(self.latency);
            if !self.admit(1) {
                return Err(NodeErr::Transport("node1: rate limited (429)".into()));
            }
            out.extend(self.chain.call_batch(c, ch)?);
        }
        Ok(out)
    }
    fn call_batch_paid(&self, c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        self.call_batch(c, calls)
    }
}

#[test]
fn soak_800_pools_at_the_plan_limit_with_checks_asking_twice_the_limit() {
    // Plan: 100 HTTP requests/s; ARBSIM_NODE_RPS 80; 8 in flight; answers in
    // 300 ms; checks miss values at 2x the rate. Time runs 40x fast.
    use std::sync::atomic::Ordering::Relaxed;
    use std::time::{Duration, Instant};
    const X: f64 = 40.0;
    let limit = (100.0 * X) as u64;
    let rps = 80.0 * X;
    let chain = Arc::new(FakeChain::new());
    let pool_addr = |i: u16| {
        let mut b = [0u8; 20];
        b[0] = 0x55;
        b[18..].copy_from_slice(&i.to_be_bytes());
        Address::from(b)
    };
    let n = 800u16;
    let mut s = genesis();
    let mut pj = Vec::new();
    for i in 0..n {
        let p = pool_addr(i);
        let st = s.entry(p).or_default();
        st.insert(u(0), u(2000));
        st.insert(u(6), addr_word(a(COIN0)));
        st.insert(u(7), addr_word(a(COIN1)));
        st.insert(u(8), u(1000) | (u(4000) << 112usize) | (u(1000) << 224usize));
        s.get_mut(&a(COIN0)).unwrap().insert(map_slot(p, 0), u(1000));
        s.get_mut(&a(COIN1)).unwrap().insert(map_slot(p, 0), u(4000));
        pj.push(json!({"address": format!("{p}"), "kind": "v2", "token0": format!("{}", a(COIN0)), "token1": format!("{}", a(COIN1))}));
    }
    chain.set(100, s);
    let node = Arc::new(PlanNode {
        chain: chain.clone(),
        limit,
        latency: Duration::from_secs_f64(0.3 / X),
        window: Mutex::new(Default::default()),
        sent: Default::default(),
        rejected: Default::default(),
        worst_second: Default::default(),
        budget: arbsim::node::Budget::new(u64::MAX / 4, rps, None),
    });
    let sh = Shared::new(Config::for_tests(), Some(node.clone() as Arc<dyn NodeApi>), Arc::new(Volatile::default()));
    // As in production: 8 in flight; reports kept 2,400 blocks (~10 min).
    let cfg = C2Config { loaders: 8, load_batch: 25, reload_ms: 1000, keep_blocks: 2400, max_keep_blocks: 40_000, ..C2Config::for_tests() };
    let h = arbsim::copy2::intake::spawn(sh.clone(), Arc::new(FillQueue::new(1_000_000, 100)), cfg);
    assert_eq!(h.track_json(&json!(1), &json!({"pools": pj}))["tracked"], json!(n as u64));
    let t0 = Instant::now();
    let mut b = 100u64;
    let mut worst_rate = 0f64;
    let (mut last_sent, mut last_t) = (0u64, Instant::now());
    let mut ready = 0;
    let mut all_ready_at: Option<f64> = None;
    // 2 simulated minutes.
    while t0.elapsed() < Duration::from_secs_f64(2.0 * 60.0 / X) {
        // A block every 250 ms of chain time; checks miss 2x the plan limit.
        let mut m = tick(b, 1000 + b);
        m.prev_block = if b > 100 { Some(b - 1) } else { None };
        h.block(m);
        b += 1;
        let per_tick = (2.0 * 80.0 * 0.25) as u64; // values missed per 250 ms of chain time: 2x the rate
        let miss: Vec<MissItem> = (0..per_tick.max(1)).map(|i| MissItem::Slot(a(USER), U256::from(b * 100_000 + i))).collect();
        h.fill(miss);
        std::thread::sleep(Duration::from_secs_f64(0.25 / X));
        if last_t.elapsed() >= Duration::from_secs(1) {
            let s = node.sent.load(Relaxed);
            worst_rate = worst_rate.max((s - last_sent) as f64 / last_t.elapsed().as_secs_f64());
            last_sent = s;
            last_t = Instant::now();
        }
        if b % 20 == 0 {
            ready = h.status_json(false)["ready"].as_u64().unwrap();
            if ready == n as u64 {
                all_ready_at = Some(t0.elapsed().as_secs_f64());
                break;
            }
        }
    }
    let st = h.status_json(false);
    eprintln!(
        "soak: {ready}/{n} ready after {:.1} simulated min (all ready at {:?} simulated s); node calls {} (copy 2 counted {}), rejected 429 {}, worst 1-s window {} (limit {limit}), worst rate {worst_rate:.0}/s; getProof {}; loader {}",
        t0.elapsed().as_secs_f64() * X / 60.0,
        all_ready_at.map(|t| (t * X) as u64),
        node.sent.load(Relaxed),
        st["nodeRequests"],
        node.rejected.load(Relaxed),
        node.worst_second.load(Relaxed),
        chain.proofs.lock().unwrap(),
        st["loader"]
    );
    // Never over the plan's limit, no retry storm, nearly everything ready.
    assert_eq!(node.rejected.load(Relaxed), 0, "sent over the plan limit");
    assert!(node.worst_second.load(Relaxed) <= limit);
    // Copy 2's count = real sends (a failed request may count calls not sent).
    let (counted, sent) = (st["nodeRequests"].as_u64().unwrap(), node.sent.load(Relaxed));
    // (Jobs still running are counted when they finish.)
    assert!(counted <= sent + sent / 20, "copy 2 counted {counted}, node got {sent}");
    assert!(ready * 10 >= n as u64 * 9, "only {ready} of {n} ready: {st}");
    h.stop();
}

#[test]
fn proofs_refused_for_older_blocks_are_read_the_plain_way_at_that_block() {
    // This Nitro node gives eth_getProof only at its newest block (103);
    // our copy (and so the load) is at 100: those accounts are read with
    // eth_getStorageAt at block 100 instead, exactly, in the same job.
    let mut r = rig();
    *r.chain.tip.lock().unwrap() = 103;
    *r.chain.proof_tip_only.lock().unwrap() = true;
    let mut later = genesis();
    later.get_mut(&a(V2P)).unwrap().insert(u(8), u(1) | (u(1) << 112usize) | (u(99) << 224usize));
    r.chain.set(103, later); // the node's newest state differs: must NOT be used
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready, "{:?}", r.state(&v2_pool()));
    assert_eq!(r.head_slot(a(V2P), u(8)), Lookup::Known(u(1000) | (u(4000) << 112usize) | (u(50) << 224usize)));
    assert!(*r.chain.proofs.lock().unwrap() >= 1);
    assert!(*r.chain.storage_reads.lock().unwrap() >= 1);
    assert_eq!(r.h.c2.stats.node_errors.load(std::sync::atomic::Ordering::Relaxed), 0);
}

#[test]
fn ready_pool_answers_a_getter_call_from_an_unknown_caller_at_a_recent_block() {
    use std::time::{Duration, Instant};
    let chain = Arc::new(FakeChain::new());
    chain.set(100, genesis());
    // getReserves-like getter: return slot 8.
    chain.codes.lock().unwrap().insert(a(V2P), vec![0x60, 0x08, 0x54, 0x60, 0x00, 0x52, 0x60, 0x20, 0x60, 0x00, 0xf3]);
    let ctx = arbsim::serve::build_with(Config::for_tests(), Some(chain.clone() as Arc<dyn NodeApi>), arbsim::serve::Source::PoolEvents);
    let c2 = ctx.copy2.clone().unwrap();
    c2.track_json(&json!(1), &json!({"pools": [{"address": format!("{}", a(V2P)), "kind": "v2", "token0": format!("{}", a(COIN0)), "token1": format!("{}", a(COIN1))}]}));
    let t0 = Instant::now();
    let mut b = 100u64;
    while c2.status_json(false)["ready"] != json!(1) {
        let mut m = tick(b, 1000 + b);
        m.prev_block = if b > 100 { Some(b - 1) } else { None };
        c2.block(m);
        b += 1;
        assert!(t0.elapsed() < Duration::from_secs(10));
        std::thread::sleep(Duration::from_millis(5));
    }
    for _ in 0..3 {
        let mut m = tick(b, 1000 + b);
        m.prev_block = Some(b - 1);
        c2.block(m);
        b += 1;
    }
    std::thread::sleep(Duration::from_millis(50));
    let caller = Address::with_last_byte(0xe0); // an EOA nobody tracks
    let call = |block: u64| {
        arbsim::server::handle(&ctx, &json!({"id": 9, "type": "call", "at": {"block": block}, "calls": [{
            "from": format!("{caller}"), "to": format!("{}", a(V2P)), "data": "0x0902f1ac", "gas": "0x100000"}]}))
    };
    // A block two behind the head (where the checker asks).
    let ans = call(b - 3);
    assert_eq!(ans["ok"], json!(true), "{ans}");
    let want = format!("{:#066x}", u(1000) | (u(4000) << 112usize) | (u(50) << 224usize));
    assert_eq!(ans["results"][0]["output"], json!(want), "{ans}");
    c2.stop();
}

#[test]
fn queued_loads_read_at_the_newest_block_when_they_start() {
    // One worker, slow node: loads queued at block 100 start much later; they
    // must read at the copy's newest block then, not at 100 (old blocks are
    // slow archive reads on the real node).
    let mut r = rig_with(C2Config { loaders: 1, load_batch: 1, ..C2Config::for_tests() });
    *r.chain.delay_ms.lock().unwrap() = 20;
    let pools: Vec<TrackedPool> = (0..4u8).map(|i| TrackedPool { address: a(0xd0 + i), ..v2_pool() }).collect();
    let mut s = genesis();
    for p in &pools {
        let g = s[&a(V2P)].clone();
        s.insert(p.address, g);
        for c in [COIN0, COIN1] {
            let v = s[&a(c)][&map_slot(a(V2P), 0)];
            s.get_mut(&a(c)).unwrap().insert(map_slot(p.address, 0), v);
        }
    }
    r.chain.set(100, s);
    r.track(pools.clone());
    for b in 100..140u64 {
        r.h.block(tick(b, 1000 + b));
        r.intake.pump();
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    r.settle();
    for p in &pools {
        assert_eq!(r.state(p).0, PoolState::Ready);
    }
    let asked = r.chain.proof_blocks.lock().unwrap().clone();
    assert!(asked.iter().any(|b| *b >= 110), "loads read at old blocks: {asked:?}");
}

// ---------------------------------------------------------------------------
// Proxy coins (dry run with 7a8a2e5 + d5a54b1: balanceOf on EIP-1967 proxy
// coins answered success with EMPTY output on the copy)
// ---------------------------------------------------------------------------
// (Addresses above 0x100: 0x01..0x0a are Ethereum precompiles.)
fn pa(n: u8) -> Address {
    let mut b = [0u8; 20];
    b[0] = 0x77;
    b[19] = n;
    Address::from(b)
}
fn pcoin() -> Address {
    pa(0xc0)
}
fn pimpl() -> Address {
    pa(0x5e)
}
fn ppool() -> Address {
    pa(0xa3)
}

fn eip1967_slot() -> U256 {
    parse_u256("0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc").unwrap()
}

/// Minimal EIP-1967 proxy: delegatecall everything to sload(IMPL_SLOT).
fn proxy_code() -> Vec<u8> {
    let mut c = vec![0x36, 0x60, 0x00, 0x60, 0x00, 0x37, 0x60, 0x00, 0x60, 0x00, 0x36, 0x60, 0x00, 0x7f];
    c.extend_from_slice(&eip1967_slot().to_be_bytes::<32>());
    c.extend_from_slice(&[0x54, 0x5a, 0xf4, 0x3d, 0x60, 0x00, 0x60, 0x00, 0x3e, 0x3d, 0x60, 0x00, 0xf3]);
    c
}

/// Implementation: balanceOf(holder) = sload(keccak(holder . 0)).
fn impl_code() -> Vec<u8> {
    vec![
        0x60, 0x04, 0x35, 0x60, 0x00, 0x52, 0x60, 0x00, 0x60, 0x20, 0x52, 0x60, 0x40, 0x60, 0x00, 0x20, 0x54, 0x60, 0x00, 0x52, 0x60, 0x20,
        0x60, 0x00, 0xf3,
    ]
}

/// The V2 pool `ppool()` trading the proxy coin against COIN1.
fn proxy_pool() -> TrackedPool {
    TrackedPool { address: ppool(), token0: pcoin(), ..v2_pool() }
}

fn proxy_chain() -> Arc<FakeChain> {
    let chain = Arc::new(FakeChain::new());
    let mut g = genesis();
    let mut p = g[&a(V2P)].clone();
    p.insert(u(6), addr_word(pcoin()));
    g.insert(ppool(), p);
    let c = g.entry(pcoin()).or_default();
    c.insert(eip1967_slot(), addr_word(pimpl()));
    c.insert(map_slot(ppool(), 0), u(1000));
    g.get_mut(&a(COIN1)).unwrap().insert(map_slot(ppool(), 0), u(4000));
    chain.set(100, g);
    chain.codes.lock().unwrap().insert(pcoin(), proxy_code());
    chain.codes.lock().unwrap().insert(pimpl(), impl_code());
    chain
}

fn balance_of(h: Address) -> String {
    let mut data = sel("balanceOf(address)").to_vec();
    data.extend_from_slice(&[0u8; 12]);
    data.extend_from_slice(h.as_slice());
    format!("0x{}", data.iter().map(|x| format!("{x:02x}")).collect::<String>())
}

/// Follow the pool, then ask balanceOf(pool) on the proxy coin until the
/// copy answers (fills bring what it misses). Returns every answer.
fn proxy_balance_answers(chain: Arc<FakeChain>) -> Vec<Value> {
    use std::time::{Duration, Instant};
    let ctx = arbsim::serve::build_with(Config::for_tests(), Some(chain.clone() as Arc<dyn NodeApi>), arbsim::serve::Source::PoolEvents);
    let c2 = ctx.copy2.clone().unwrap();
    let pp = proxy_pool();
    c2.track_json(&json!(1), &json!({"pools": [{"address": format!("{}", pp.address), "kind": "v2", "token0": format!("{}", pp.token0), "token1": format!("{}", pp.token1)}]}));
    let t0 = Instant::now();
    let mut b = 100u64;
    let next = |b: &mut u64| {
        let mut m = tick(*b, 1000 + *b);
        m.prev_block = if *b > 100 { Some(*b - 1) } else { None };
        c2.block(m);
        *b += 1;
    };
    while c2.status_json(false)["ready"] != json!(1) {
        next(&mut b);
        assert!(t0.elapsed() < Duration::from_secs(10), "pool never ready: {}", c2.status_json(true));
        std::thread::sleep(Duration::from_millis(5));
    }
    let mut out = Vec::new();
    for _ in 0..40 {
        next(&mut b);
        std::thread::sleep(Duration::from_millis(30));
        let ans = arbsim::server::handle(&ctx, &json!({"id": 9, "type": "call", "calls": [{
            "from": format!("{}", pa(0xe0)), "to": format!("{}", pcoin()), "data": balance_of(pp.address), "gas": "0x100000"}]}));
        let done = ans["ok"] == json!(true);
        out.push(ans);
        if done {
            break;
        }
    }
    c2.stop();
    out
}

#[test]
fn proxy_coin_balance_is_the_real_balance_or_unknown_never_empty() {
    let answers = proxy_balance_answers(proxy_chain());
    for ans in &answers {
        if ans["ok"] == json!(true) {
            assert_eq!(ans["results"][0]["output"], json!(w(u(1000))), "{answers:?}");
        }
    }
    assert_eq!(answers.last().unwrap()["ok"], json!(true), "never answered: {answers:?}");
}

// ---------------------------------------------------------------------------
// Coin balances that drifted in dry run #16 (wrong value, not "unsure")
// ---------------------------------------------------------------------------
/// Two followed pools, both ready at block 100 (pool B = 0xa3, same coins).
fn two_pool_rig() -> (Rig, TrackedPool, TrackedPool) {
    let mut r = rig();
    let pa_ = v2_pool();
    let pb = TrackedPool { address: a(0xa3), ..v2_pool() };
    let mut s = genesis();
    let g = s[&a(V2P)].clone();
    s.insert(pb.address, g);
    for c in [COIN0, COIN1] {
        let v = s[&a(c)][&map_slot(a(V2P), 0)];
        s.get_mut(&a(c)).unwrap().insert(map_slot(pb.address, 0), v);
    }
    r.chain.set(100, s);
    r.track(vec![pa_.clone(), pb.clone()]);
    r.send(tick(100, 60));
    assert_eq!(r.state(&pa_).0, PoolState::Ready);
    assert_eq!(r.state(&pb).0, PoolState::Ready);
    (r, pa_, pb)
}

#[test]
fn the_same_report_twice_in_one_message_is_applied_once() {
    // Dry run #16: the checker subscribes to coin Transfers FROM our pools
    // and TO our pools separately, so a transfer from one followed pool to
    // another (a multi-hop route) arrives twice and was put twice into the
    // same block message. arbsim applied it twice: both pools' balances
    // drifted by exactly that amount, for good.
    let (mut r, pa_, pb) = two_pool_rig();
    let t = transfer(a(COIN0), pa_.address, pb.address, 100, 101, 0, 0);
    r.send(msg(101, 61, vec![t.clone(), t.clone()]));
    assert_eq!(r.head_slot(a(COIN0), map_slot(pa_.address, 0)), Lookup::Known(u(900)));
    assert_eq!(r.head_slot(a(COIN0), map_slot(pb.address, 0)), Lookup::Known(u(1100)));
    // Two messages for a block not applied yet, each with the report twice.
    let t2 = transfer(a(COIN0), pa_.address, pb.address, 7, 102, 0, 0);
    r.h.block(msg(102, 62, vec![t2.clone(), t2.clone()]));
    r.h.block(msg(102, 62, vec![t2.clone(), t2]));
    r.settle();
    assert_eq!(r.head_slot(a(COIN0), map_slot(pa_.address, 0)), Lookup::Known(u(893)));
    assert_eq!(r.head_slot(a(COIN0), map_slot(pb.address, 0)), Lookup::Known(u(1107)));
}

#[test]
fn reload_that_disagrees_with_a_followed_coin_balance_forgets_it() {
    // Safety net: when a pool is (re)loaded while the copy already follows
    // one of its coin balances, the load's own value (node value carried to
    // the same block) must agree. If not, one of them is wrong: the balance
    // becomes MISSING (a check then misses it and a fill reads it fresh).
    let mut r = rig();
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    // A transfer the chain never had (stands for any report applied wrongly):
    // the copy now says 1100 while the node keeps 1000.
    r.intake.process(msg(101, 61, vec![transfer(a(COIN0), a(USER), a(V2P), 100, 101, 0, 0)]));
    assert_eq!(r.head_slot(a(COIN0), map_slot(a(V2P), 0)), Lookup::Known(u(1100)));
    // Something makes the pool reload (an event we can't apply).
    let weird = lg(a(V2P), vec![topic("FeeChanged(uint256)")], data(&[u(1)]), 102, 0, 0);
    r.intake.process(msg(102, 62, vec![weird]));
    r.settle();
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready, "{:?}", r.state(&v2_pool()));
    assert_eq!(r.head_slot(a(COIN0), map_slot(a(V2P), 0)), Lookup::Missing, "a balance two sources disagree on must be MISSING");
    // The other coin agreed: still followed.
    assert_eq!(r.head_slot(a(COIN1), map_slot(a(V2P), 0)), Lookup::Known(u(4000)));
    assert_eq!(r.h.c2.stats.coin_balance_disagree.load(std::sync::atomic::Ordering::Relaxed), 1);
}

/// Chainstack under a plan SHARED with another program (the live bot): it
/// lets `limit` HTTP requests per second through for us; more and every
/// value in the request is answered -32005 "You've exceeded the RPS limit".
/// In front of it, our node client's real speed limit (node.rs Budget),
/// which sees those answers exactly like NodeClient does (Budget::observe).
struct SharedPlan {
    chain: Arc<FakeChain>,
    limit: u64,
    window: Mutex<std::collections::VecDeque<std::time::Instant>>,
    log: Mutex<Vec<(std::time::Instant, bool)>>,
    budget: arbsim::node::Budget,
}
impl NodeApi for SharedPlan {
    fn call_batch(&self, c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        let mut out = Vec::new();
        for ch in calls.chunks(25) {
            self.budget.take(c, 1)?;
            std::thread::sleep(std::time::Duration::from_millis(15));
            let now = std::time::Instant::now();
            let ok = {
                let mut w = self.window.lock().unwrap();
                while w.front().is_some_and(|t| now.duration_since(*t) >= std::time::Duration::from_secs(1)) {
                    w.pop_front();
                }
                let ok = (w.len() as u64) < self.limit;
                if ok {
                    w.push_back(now);
                }
                ok
            };
            self.log.lock().unwrap().push((now, ok));
            let ans: Result<Vec<CallResult>, NodeErr> = if ok {
                self.chain.call_batch(c, ch)
            } else {
                Ok(ch.iter().map(|_| Err(RpcErr { code: -32005, message: "You've exceeded the RPS limit available on the current plan.".into() })).collect())
            };
            self.budget.observe(&ans);
            out.extend(ans?);
        }
        Ok(out)
    }
    fn call_batch_paid(&self, c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        self.call_batch(c, calls)
    }
    fn usage(&self) -> Value {
        self.budget.usage()
    }
}

#[test]
fn provider_refusing_for_rps_makes_us_slow_down_instead_of_storming() {
    // Dry run #16: our limit 100/s, the shared plan refused us (-32005) and
    // we kept sending ~95/s for 10 minutes. Here: our limit 60/s, the plan
    // lets 20/s through; 300 pools to load and checks asking for values.
    use std::time::{Duration, Instant};
    let chain = Arc::new(FakeChain::new());
    let pool_addr = |i: u16| {
        let mut b = [0u8; 20];
        b[0] = 0x66;
        b[18..].copy_from_slice(&i.to_be_bytes());
        Address::from(b)
    };
    let n = 300u16;
    let mut s = genesis();
    let mut pj = Vec::new();
    for i in 0..n {
        let p = pool_addr(i);
        let st = s.entry(p).or_default();
        st.insert(u(0), u(2000));
        st.insert(u(6), addr_word(a(COIN0)));
        st.insert(u(7), addr_word(a(COIN1)));
        st.insert(u(8), u(1000) | (u(4000) << 112usize) | (u(1000) << 224usize));
        s.get_mut(&a(COIN0)).unwrap().insert(map_slot(p, 0), u(1000));
        s.get_mut(&a(COIN1)).unwrap().insert(map_slot(p, 0), u(4000));
        pj.push(json!({"address": format!("{p}"), "kind": "v2", "token0": format!("{}", a(COIN0)), "token1": format!("{}", a(COIN1))}));
    }
    chain.set(100, s);
    let node = Arc::new(SharedPlan { chain: chain.clone(), limit: 20, window: Mutex::new(Default::default()), log: Mutex::new(Vec::new()), budget: arbsim::node::Budget::new(u64::MAX / 4, 60.0, None) });
    let sh = Shared::new(Config::for_tests(), Some(node.clone() as Arc<dyn NodeApi>), Arc::new(Volatile::default()));
    let cfg = C2Config { loaders: 16, load_batch: 1, reload_ms: 1000, ..C2Config::for_tests() };
    let h = arbsim::copy2::intake::spawn(sh.clone(), Arc::new(FillQueue::new(100_000, 100)), cfg);
    h.coin_slots_json(&json!(1), &json!({"coinSlots": {format!("{}", a(COIN0)): {"layout": "solidity", "slot": 0}, format!("{}", a(COIN1)): {"layout": "solidity", "slot": 0}}}));
    assert_eq!(h.track_json(&json!(2), &json!({"pools": pj}))["tracked"], json!(n as u64));
    let t0 = Instant::now();
    let mut b = 100u64;
    while t0.elapsed() < Duration::from_secs(10) {
        let mut m = tick(b, 1000 + b);
        m.prev_block = if b > 100 { Some(b - 1) } else { None };
        h.block(m);
        b += 1;
        let miss: Vec<MissItem> = (0..10u64).map(|i| MissItem::Slot(a(USER), U256::from(b * 1000 + i))).collect();
        h.fill(miss);
        std::thread::sleep(Duration::from_millis(100));
    }
    let log = node.log.lock().unwrap().clone();
    let late: Vec<&(Instant, bool)> = log.iter().filter(|x| x.0.duration_since(t0) >= Duration::from_secs(5)).collect();
    let sent = late.len() as f64 / 5.0;
    let refused = late.iter().filter(|x| !x.1).count() as f64 / late.len().max(1) as f64;
    let st = h.status_json(false);
    eprintln!("shared plan: last 5 s: {sent:.1} requests/s, {:.0} % refused; ready {}; nodeRate {}; status {}", refused * 100.0, st["ready"], st["nodeRate"], st);
    assert!(sent <= 32.0, "still sending {sent:.1}/s into a plan that lets 20/s through");
    assert!(refused <= 0.35, "{:.0} % of requests refused in the last 5 s: no storm allowed", refused * 100.0);
    assert!(st["nodeRate"]["providerRefusals"].as_u64().unwrap() > 0, "{st}");
    assert!(st["counters"]["node_refusals"].as_u64().unwrap() > 0, "{st}");
    assert!(st["ready"].as_u64().unwrap() > 0, "loading must go on (slower): {st}");
    h.stop();
}

/// Memory (dry run #18 sizing): while a slow load holds old blocks of
/// reports, the buffer is bounded in REPORTS (ARBSIM_COPY2_MAX_KEEP_LOGS),
/// not only in blocks: past keep_blocks the oldest blocks go once too many
/// reports are kept.
#[test]
fn kept_reports_are_bounded_while_a_slow_load_holds_them() {
    let cfg = C2Config { keep_blocks: 16, max_keep_blocks: 4000, max_keep_logs: 200, ..C2Config::for_tests() };
    let mut r = rig_with(cfg);
    *r.chain.delay_ms.lock().unwrap() = 1500;
    let pools: Vec<Value> = vec![json!({"address": format!("{}", a(V2P)), "kind": "v2", "token0": format!("{}", a(COIN0)), "token1": format!("{}", a(COIN1))})];
    assert_eq!(r.h.track_json(&json!(1), &json!({"type": "track", "pools": pools, "coinSlots": {format!("{:#x}", a(COIN0)): {"layout": "solidity", "slot": 0}, format!("{:#x}", a(COIN1)): {"layout": "solidity", "slot": 0}}}))["ok"], json!(true));
    r.h.block(tick(100, 60));
    r.intake.pump();
    // 100 blocks x 10 reports of other coins while the load is in flight.
    for b in 101..201u64 {
        let logs: Vec<PoolLog> = (0..10u32).map(|i| transfer(a(0x55), a(USER), a(0x56), 1, b, i, 0)).collect();
        r.h.block(msg(b, 60 + b, logs));
        r.intake.pump();
    }
    let (blocks, reports) = r.intake.buffered();
    assert!(blocks >= 16, "keep_blocks are always kept: {blocks}");
    assert!(reports <= 200, "{reports} reports kept in {blocks} blocks (cap 200)");
    // Without the report cap the load in flight would hold all ~100 blocks.
    let cfg2 = C2Config { keep_blocks: 16, max_keep_blocks: 4000, max_keep_logs: 1_000_000, ..C2Config::for_tests() };
    let mut r2 = rig_with(cfg2);
    *r2.chain.delay_ms.lock().unwrap() = 1500;
    let pools: Vec<Value> = vec![json!({"address": format!("{}", a(V2P)), "kind": "v2", "token0": format!("{}", a(COIN0)), "token1": format!("{}", a(COIN1))})];
    r2.h.track_json(&json!(1), &json!({"type": "track", "pools": pools, "coinSlots": {format!("{:#x}", a(COIN0)): {"layout": "solidity", "slot": 0}, format!("{:#x}", a(COIN1)): {"layout": "solidity", "slot": 0}}}));
    r2.h.block(tick(100, 60));
    r2.intake.pump();
    for b in 101..201u64 {
        let logs: Vec<PoolLog> = (0..10u32).map(|i| transfer(a(0x55), a(USER), a(0x56), 1, b, i, 0)).collect();
        r2.h.block(msg(b, 60 + b, logs));
        r2.intake.pump();
    }
    assert!(r2.intake.buffered().1 > 500, "control: the slow load holds the blocks: {:?}", r2.intake.buffered());
    // The load still finishes (it may start over) and the pool gets ready.
    *r.chain.delay_ms.lock().unwrap() = 0;
    r.settle();
    let t0 = std::time::Instant::now();
    let mut b = 201u64;
    while r.state(&v2_pool()).0 != PoolState::Ready && t0.elapsed().as_secs() < 10 {
        r.send(tick(b, 100 + b));
        b += 1;
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready, "{:?}", r.state(&v2_pool()));
}

// ---------------------------------------------------------------------------
// copy2-l (live Oct 22 shadow): the busiest pool's coin balances went
// MISSING over and over ("coin slot" misses of WETH / USDG at
// 0x52e65b17, 33 in 89 min).
// ---------------------------------------------------------------------------

fn bal_at(r: &Rig, block: u64, coin: u8, holder: u8) -> Lookup<U256> {
    r.sh.resolve(&At::Block(block)).unwrap().snap.storage(a(coin), map_slot(a(holder), 0))
}

/// Cause 1: a late coin Transfer (its subscription delivered it after the
/// block went out, or a settle found it ~1.5 s later) arriving after a
/// LATER transfer of the same balance had been applied made the balance
/// MISSING ("a transfer older than one already applied forgets that
/// balance"). On a pool trading every few blocks that is almost every late
/// transfer. Adding is exact in any order: now the late amount is added to
/// every kept version from its block on, and nothing is forgotten.
#[test]
fn late_coin_transfer_after_a_later_one_is_added_not_forgotten() {
    let mut r = rig();
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    assert_eq!(bal_at(&r, 100, COIN0, V2P), Lookup::Known(u(1000)));
    // Blocks 101 and 102 arrive with one transfer each.
    r.intake.process(msg(101, 61, vec![transfer(a(COIN0), a(USER), a(V2P), 100, 101, 1, 0)]));
    r.intake.process(msg(102, 62, vec![transfer(a(COIN0), a(USER), a(V2P), 50, 102, 0, 0)]));
    assert_eq!(bal_at(&r, 102, COIN0, V2P), Lookup::Known(u(1150)));
    // Block 101's other transfer (the pool paid 30 out, tx 0) arrives late.
    r.intake.process(msg(101, 61, vec![transfer(a(COIN0), a(V2P), a(USER), 30, 101, 0, 0)]));
    assert_eq!(bal_at(&r, 100, COIN0, V2P), Lookup::Known(u(1000)), "before the transfer: unchanged");
    assert_eq!(bal_at(&r, 101, COIN0, V2P), Lookup::Known(u(1070)));
    assert_eq!(bal_at(&r, 102, COIN0, V2P), Lookup::Known(u(1120)), "the late amount is in every version from its block on");
    let c = |n: &str| r.h.status_json(false)["counters"][n].as_u64().unwrap();
    assert_eq!(c("late_coin_deltas"), 1);
    assert_eq!(c("coin_slot_mismatch"), 0, "nothing forgotten");
    // A late transfer that would take a version below zero: that version's
    // value was wrong -> forgotten there and after (never a guess).
    r.intake.process(msg(102, 62, vec![transfer(a(COIN0), a(V2P), a(USER), 1_100, 102, 1, 0)]));
    assert_eq!(bal_at(&r, 102, COIN0, V2P), Lookup::Known(u(20)));
    r.intake.process(msg(101, 61, vec![transfer(a(COIN0), a(V2P), a(USER), 1_080, 101, 2, 0)]));
    assert_eq!(bal_at(&r, 101, COIN0, V2P), Lookup::Missing, "1070 - 1080 < 0: wrong, forgotten");
    assert_eq!(bal_at(&r, 102, COIN0, V2P), Lookup::Missing, "and in every newer version");
    assert_eq!(bal_at(&r, 100, COIN0, V2P), Lookup::Known(u(1000)), "older versions untouched");
}

/// A late Transfer from a block at or before the block the held value was
/// read from the node at is already inside that value: nothing is added
/// (the old rule forgot the balance here too).
#[test]
fn late_coin_transfer_already_in_the_node_value_changes_nothing() {
    let mut r = rig();
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60)); // loaded at block 100: the node value has block 100 in it
    r.intake.process(tick(101, 61));
    r.intake.process(msg(100, 60, vec![transfer(a(COIN0), a(USER), a(V2P), 77, 100, 0, 0)]));
    assert_eq!(bal_at(&r, 101, COIN0, V2P), Lookup::Known(u(1000)));
    assert_eq!(bal_at(&r, 100, COIN0, V2P), Lookup::Known(u(1000)));
    assert_eq!(r.h.status_json(false)["counters"]["late_coin_included"], json!(1));
}

/// Cause 2: once missing, the balance of a pool that trades every few
/// blocks was never filled: a fill read at block k was thrown away (asked
/// again in 1 s) whenever the pool had a transfer after k, i.e. always.
/// Now the node value at k is carried forward through the kept Transfers
/// since k, exactly, into every version from k on; a Transfer for a block
/// after k that arrives later still is added (it is not in the node value),
/// one for a block <= k is not (it is).
#[test]
fn busy_pool_coin_balance_fill_is_carried_forward_exactly() {
    let mut r = rig();
    *r.chain.tip.lock().unwrap() = 102; // the node trails the copy
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    let slot = map_slot(a(V2P), 0);
    // The chain: the pool gets 10 coin0 in every block 101..=105.
    let mut st = genesis();
    for b in 101..=105u64 {
        st.get_mut(&a(COIN0)).unwrap().insert(slot, u(1000 + 10 * (b as u128 - 100)));
        r.chain.set(b, st.clone());
    }
    // The copy lost the balance (stands for any forget) before block 101.
    {
        let mut p = r.sh.published.write().unwrap();
        for i in 0..p.versions.len() {
            let v = p.versions[i].clone();
            let mut s = (*v.snap).clone();
            if let Some(acct) = s.accounts.get_mut(&a(COIN0)) {
                acct.storage.remove(&slot);
            }
            p.versions[i] = Arc::new(arbsim::state::mirror::Version { snap: Arc::new(s), ..(*v).clone() });
        }
    }
    for b in 101..=105u64 {
        r.intake.process(msg(b, 60 + b - 100, vec![transfer(a(COIN0), a(USER), a(V2P), 10, b, 0, 0)]));
    }
    assert_eq!(bal_at(&r, 105, COIN0, V2P), Lookup::Missing);
    // A check misses it: the fill reads block 102 (the node's newest).
    r.h.fill(vec![MissItem::Slot(a(COIN0), slot)]);
    r.settle();
    for b in 102..=105u64 {
        assert_eq!(bal_at(&r, b, COIN0, V2P), Lookup::Known(u(1000 + 10 * (b as u128 - 100))), "block {b}");
    }
    assert_eq!(bal_at(&r, 101, COIN0, V2P), Lookup::Missing, "older than the node read: not vouched for");
    let c = |n: &str| r.h.status_json(false)["counters"][n].as_u64().unwrap();
    assert_eq!(c("fill_balance_carried"), 1);
    assert_eq!(c("fill_retry"), 0, "not asked again");
    // A late transfer for block 104 (after the node read): added from 104 on.
    r.intake.process(msg(104, 64, vec![transfer(a(COIN0), a(USER), a(V2P), 5, 104, 1, 0)]));
    assert_eq!(bal_at(&r, 103, COIN0, V2P), Lookup::Known(u(1030)));
    assert_eq!(bal_at(&r, 104, COIN0, V2P), Lookup::Known(u(1045)));
    assert_eq!(bal_at(&r, 105, COIN0, V2P), Lookup::Known(u(1055)));
    // A late transfer for block 102 (inside the node read): nothing to add.
    r.intake.process(msg(102, 62, vec![transfer(a(COIN0), a(USER), a(V2P), 7, 102, 1, 0)]));
    assert_eq!(bal_at(&r, 105, COIN0, V2P), Lookup::Known(u(1055)));
    assert_eq!(bal_at(&r, 102, COIN0, V2P), Lookup::Known(u(1020)));
    // The next on-time transfer is followed as usual.
    r.intake.process(msg(106, 66, vec![transfer(a(COIN0), a(V2P), a(USER), 55, 106, 0, 0)]));
    assert_eq!(bal_at(&r, 106, COIN0, V2P), Lookup::Known(u(1000)));
}

/// The status says why each unanswered check was unknown, and what the
/// "miss" ones missed (live Oct 22: 4 of 62 answered; this tells whether
/// every unknown check is explained by a missed value and which value
/// alone blocks how many checks).
#[test]
fn status_counts_unknown_checks_by_reason_and_missed_value() {
    let mut r = rig();
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    r.h.note_unknown("pending_reports", &[]);
    r.h.note_unknown("miss", &[MissItem::Slot(a(COIN0), map_slot(a(V2P), 0))]);
    r.h.note_unknown("miss", &[MissItem::Slot(a(COIN0), map_slot(a(V2P), 0)), MissItem::Account(a(0x99))]);
    let st = r.h.status_json(false);
    assert_eq!(st["checks"]["unknownBy"]["miss"], json!(2), "{st}");
    assert_eq!(st["checks"]["unknownBy"]["pending_reports"], json!(1));
    let bb = st["checks"]["blockedBy"].as_array().unwrap();
    let row = |needle: &str| bb.iter().find(|x| x[0].as_str().unwrap().contains(needle)).cloned().unwrap_or(json!(null));
    assert_eq!(row("other account basics"), json!(["other account basics 0x00000000", 1, 0]), "{bb:?}");
    assert_eq!(row("coin slot")[1], json!(2), "{bb:?}");
    assert_eq!(row("coin slot")[2], json!(1), "{bb:?}");
}

/// Values the copy holds but nothing follows (a coin's settings, another
/// contract's storage, read once by a fill) are re-read every
/// ARBSIM_COPY2_VERIFY_S; one the chain changed is forgotten everywhere,
/// put in again from the re-read's block on (like a fill) and counted (live Oct 22: a stock coin's namespaced settings and the
/// contract 0xe10b6f6b.. were read by the bot's checks and then kept with
/// nothing to say when they change). Followed values (our pools' coin
/// balances) are not re-read.
#[test]
fn values_nothing_follows_are_reread_and_forgotten_when_the_chain_changed_them() {
    let cfg = C2Config { verify_every_s: 1, ..C2Config::for_tests() };
    let mut r = rig_with(cfg);
    let mut st = genesis();
    st.get_mut(&a(COIN0)).unwrap().insert(u(5), u(7)); // a coin setting
    st.entry(a(0xe1)).or_default().insert(u(3), u(1)); // another contract
    r.chain.set(100, st.clone());
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    r.h.fill(vec![MissItem::Slot(a(COIN0), u(5)), MissItem::Slot(a(0xe1), u(3))]);
    r.settle();
    assert_eq!(r.head_slot(a(COIN0), u(5)), Lookup::Known(u(7)));
    assert_eq!(r.head_slot(a(0xe1), u(3)), Lookup::Known(u(1)));
    // Nothing changed: a round re-reads both and forgets nothing.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    r.send(tick(101, 61));
    let c = |r: &Rig, n: &str| r.h.status_json(false)["counters"][n].as_u64().unwrap();
    assert_eq!(c(&r, "verify_rounds"), 1);
    assert_eq!(c(&r, "verify_items"), 2, "only the two unfollowed values (not the pool's balances)");
    assert_eq!(c(&r, "unfollowed_changed"), 0);
    assert_eq!(r.head_slot(a(COIN0), u(5)), Lookup::Known(u(7)));
    // The chain changes the setting at block 102.
    st.get_mut(&a(COIN0)).unwrap().insert(u(5), u(8));
    r.chain.set(102, st.clone());
    r.send(tick(102, 62));
    std::thread::sleep(std::time::Duration::from_millis(1100));
    r.send(tick(103, 63));
    assert_eq!(c(&r, "unfollowed_changed"), 1);
    assert_eq!(r.head_slot(a(COIN0), u(5)), Lookup::Known(u(8)), "changed on the chain: refreshed");
    assert_eq!(r.sh.resolve(&At::Block(101)).unwrap().snap.storage(a(COIN0), u(5)), Lookup::Missing, "older versions: forgotten (since when it changed is unknown)");
    assert_eq!(r.head_slot(a(0xe1), u(3)), Lookup::Known(u(1)));
    assert_eq!(r.head_slot(a(COIN0), map_slot(a(V2P), 0)), Lookup::Known(u(1000)));
    let st = r.h.status_json(false);
    assert_eq!(st["unfollowedChanged"][0][1], json!("0x5"), "{st}");
}

// ---------------------------------------------------------------------------
// copy2-m: live Oct 22 13:34 restart (bot + arbsim restarted together)
// ---------------------------------------------------------------------------
fn counter(r: &Rig, n: &str) -> u64 {
    r.h.status_json(false)["counters"][n].as_u64().unwrap_or_else(|| panic!("no counter {n}"))
}

/// After a restart the bot's first seconds deliver reports for blocks
/// BEFORE the copy's first block (late, on another subscription). Every
/// pool's values are read at or after the copy's first block, so such a
/// report is already in them. Old code: "late report for a block no longer
/// kept" made each touched pool unsure WITH a strike, every time (the wait
/// doubles: 2 s ... 10 min), for a pool still loading too (its load
/// cancelled). Live: ~290 pools unsure for 15+ minutes.
#[test]
fn late_reports_from_before_the_copy_started_change_nothing() {
    let mut r = rig();
    r.track(vec![v2_pool(), sol_pool()]);
    r.send(tick(100, 60)); // the copy starts at 100; loads read at 100
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready);
    let before = r.head_slot(a(V2P), u(8));
    for i in 0..10u32 {
        // Blocks 95..99 (before the copy's first block), pool events and
        // coin transfers of the pool.
        let b = 95 + (i as u64 % 5);
        r.send(msg(b, 55, vec![v2_sync(1, 2, b, i, 0), transfer(a(COIN0), a(USER), a(V2P), 5, b, i, 1)]));
    }
    let (s, why) = r.state(&v2_pool());
    assert_eq!(s, PoolState::Ready, "{why}");
    assert_eq!(r.head_slot(a(V2P), u(8)), before, "already in the node values read at block 100");
    assert_eq!(r.head_slot(a(COIN0), map_slot(a(V2P), 0)), Lookup::Known(u(1000)));
    assert_eq!(r.state(&sol_pool()).0, PoolState::Ready);
    let reg = r.h.c2.reg.read().unwrap();
    assert!(reg.pools.values().all(|e| e.strikes == 0));
    drop(reg);
    assert!(counter(&r, "late_old_covered") >= 10);
    assert_eq!(counter(&r, "unsure_marked"), 0);
}

/// The same while the pool is still LOADING (the burst comes in the first
/// seconds, when nothing is ready yet): the load in flight is not cancelled
/// and nothing counts against the pool.
#[test]
fn late_reports_from_before_the_copy_started_do_not_cancel_loads() {
    let mut r = rig();
    *r.chain.delay_ms.lock().unwrap() = 40;
    r.track(vec![v2_pool()]);
    r.h.block(tick(100, 60));
    let t0 = std::time::Instant::now();
    while r.h.c2.stats.loads.load(std::sync::atomic::Ordering::Relaxed) == 0 {
        r.intake.pump();
        assert!(t0.elapsed().as_secs() < 5);
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert_eq!(r.state(&v2_pool()).0, PoolState::Loading);
    for b in [97u64, 98, 99, 98] {
        r.h.block(msg(b, 58, vec![v2_sync(1, 2, b, 0, 0)]));
        r.intake.pump();
    }
    r.settle();
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready, "{:?}", r.state(&v2_pool()));
    assert_eq!(counter(&r, "loads"), 1, "the load in flight was kept, not cancelled and sent again");
    assert_eq!(r.h.c2.reg.read().unwrap().pools.values().next().unwrap().strikes, 0);
    assert_eq!(counter(&r, "unsure_marked"), 0);
}

/// Per pool, not per address: a late V4 PoolManager report is about ONE
/// pool id. Old code made every pool at the PoolManager unsure (live: all
/// ~290 V4 stock pools at once). A late report the pool's values can't
/// contain (read before it) makes only that pool unsure, with no strike.
#[test]
fn late_pool_manager_report_touches_only_its_own_pool() {
    let mut r = rig_with(C2Config { walks_inflight: 0, ..C2Config::for_tests() });
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    let pm = a(0x44);
    let ids: Vec<B256> = (1..=5u8).map(B256::with_last_byte).collect();
    {
        let mut reg = r.h.c2.reg.write().unwrap();
        let tmpl = reg.pools.values().next().unwrap().clone();
        for id in &ids {
            let mut e = tmpl.clone();
            e.pool = TrackedPool { address: pm, v4_id: Some(*id), kind: PoolKind::V4, token0: a(COIN0), token1: a(COIN1), fee: 3000, tick_spacing: 60 };
            e.items.clear();
            e.base_block = 100;
            e.ready_since = 100;
            reg.pools.insert((pm, Some(*id)), e);
            reg.by_addr.entry(pm).or_default().push((pm, Some(*id)));
        }
    }
    r.send(tick(101, 61));
    let swap = |id: B256, b: u64| lg(pm, vec![topic("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"), id], data(&[u(0); 6]), b, 0, 0);
    // Before the copy's first block: already in every pool's values.
    r.intake.process(msg(97, 57, vec![swap(ids[0], 97)]));
    let reg = r.h.c2.reg.read().unwrap();
    assert!(reg.pools.values().all(|e| e.state == PoolState::Ready), "nothing to do for a report its values already contain");
    drop(reg);
    assert_eq!(counter(&r, "unsure_marked"), 0);
    // Pool 0's values pretend to come from an older read (block 50): this
    // report (block 97, not kept) is missing from them -> only pool 0 unsure.
    r.h.c2.reg.write().unwrap().pools.get_mut(&(pm, Some(ids[0]))).unwrap().base_block = 50;
    r.intake.process(msg(97, 57, vec![swap(ids[0], 97)]));
    let reg = r.h.c2.reg.read().unwrap();
    let e0 = &reg.pools[&(pm, Some(ids[0]))];
    assert_eq!(e0.state, PoolState::Unsure);
    assert_eq!(e0.strikes, 0, "not the pool's fault: no strike");
    for id in &ids[1..] {
        assert_eq!(reg.pools[&(pm, Some(*id))].state, PoolState::Ready, "another pool at the same PoolManager");
    }
    drop(reg);
    assert_eq!(counter(&r, "unsure_marked"), 1, "one pool, not all five");
    let reg = r.h.c2.reg.read().unwrap();
    assert_eq!(reg.pools[&(a(V2P), None)].state, PoolState::Ready);
}

/// The bot sends a message only for blocks with reports (and a tick for the
/// newest quiet one). A block whose every report came late has NO message:
/// old code called it "no longer kept" and made the pool unsure. Now it is
/// placed with the late message's own block time, exactly.
#[test]
fn late_reports_for_a_block_without_a_message_are_placed_exactly() {
    let mut r = rig();
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    r.send(tick(101, 61));
    r.send(tick(104, 64)); // 102, 103: quiet, no message
    let logs = vec![
        transfer(a(COIN0), a(USER), a(V2P), 100, 102, 3, 0),
        transfer(a(COIN1), a(V2P), a(USER), 360, 102, 3, 1),
        v2_sync(1100, 3640, 102, 3, 2),
    ];
    r.send(msg(102, 62, logs));
    let (s, why) = r.state(&v2_pool());
    assert_eq!(s, PoolState::Ready, "{why}");
    let want = Lookup::Known(u(1100) | (u(3640) << 112usize) | (u(62) << 224usize));
    assert_eq!(r.head_slot(a(V2P), u(8)), want);
    assert_eq!(r.head_slot(a(COIN0), map_slot(a(V2P), 0)), Lookup::Known(u(1100)));
    assert_eq!(r.head_slot(a(COIN1), map_slot(a(V2P), 0)), Lookup::Known(u(3640)));
    // Versions before 102 keep the old values.
    assert_eq!(r.sh.resolve(&At::Block(101)).unwrap().snap.storage(a(COIN0), map_slot(a(V2P), 0)), Lookup::Known(u(1000)));
    assert_eq!(counter(&r, "late_hole_blocks"), 1);
    // The kept reports have it (a later load carries through it).
    assert_eq!(r.intake.buffered(), (4, 3));
}

/// A node that is "not at the block yet" (header not found) for reads of
/// some storage values (any block): those fetches wait and are retried.
struct NotYetFor {
    inner: Arc<FakeChain>,
    slots: Mutex<Vec<U256>>,
}
impl NodeApi for NotYetFor {
    fn call_batch(&self, c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        let mut out = self.inner.call_batch(c, calls)?;
        let slots = self.slots.lock().unwrap();
        for (i, (m, p)) in calls.iter().enumerate() {
            let asks: Vec<U256> = match *m {
                "eth_getProof" => p[1].as_array().map(|v| v.iter().filter_map(|x| x.as_str().and_then(|s| parse_u256(s).ok())).collect()).unwrap_or_default(),
                "eth_getStorageAt" => p[1].as_str().and_then(|s| parse_u256(s).ok()).into_iter().collect(),
                _ => continue,
            };
            if asks.iter().any(|x| slots.contains(x)) {
                out[i] = Err(RpcErr { code: -32000, message: "header not found".into() });
            }
        }
        Ok(out)
    }
}

/// Live Oct 22 13:34: ~260 pools "loading" for tens of minutes with 0 node
/// jobs. Cause: a retry left over from an EARLIER load of a pool (the pool
/// went unsure and reloaded meanwhile) took the NEWER load's working copy
/// away when it came due (dispatch_delayed / on_need removed the pool's
/// working copy before checking whose it was), leaving the pool "loading"
/// with nothing working for it, for good. Reproduced: a Solidly load's
/// catch-up fetch (its last observation) waits for the node ("not at that
/// block yet": asked again in 300 ms), the pool goes unsure (a report taken
/// back) and loads again, and the new load waits the same way; the first
/// retry comes due first.
#[test]
fn an_old_loads_retry_never_takes_the_new_loads_working_copy() {
    let chain = Arc::new(FakeChain::new());
    chain.set(100, genesis());
    let node = Arc::new(NotYetFor { inner: chain.clone(), slots: Mutex::new(vec![obs_slot(u(0), 0)]) });
    let sh = Shared::new(Config::for_tests(), Some(node.clone() as Arc<dyn NodeApi>), Arc::new(Volatile::default()));
    let (intake, h) = manual(sh.clone(), Arc::new(FillQueue::new(1000, 100)), C2Config::for_tests());
    let mut r = Rig { chain, sh, intake, h };
    r.track(vec![sol_pool()]);
    r.h.block(tick(100, 60));
    let need_rounds = |r: &Rig| r.h.c2.stats.need_item_rounds.load(std::sync::atomic::Ordering::Relaxed);
    let t0 = std::time::Instant::now();
    while need_rounds(&r) < 1 {
        r.intake.pump();
        assert!(t0.elapsed().as_secs() < 2);
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    // The catch-up fetch is answered "not yet" (retried in 300 ms).
    std::thread::sleep(std::time::Duration::from_millis(20));
    r.intake.pump();
    assert_eq!(r.state(&sol_pool()).0, PoolState::Loading);
    // A report of the pool is taken back: unsure, loaded again at once;
    // that load's catch-up waits the same way.
    let mut gone = lg(a(SOLP), vec![topics().sol_sync], data(&[u(1), u(2)]), 100, 0, 0);
    gone.removed = true;
    r.intake.process(msg(101, 61, vec![gone]));
    let t0 = std::time::Instant::now();
    while need_rounds(&r) < 2 {
        r.intake.pump();
        assert!(t0.elapsed() < std::time::Duration::from_millis(250), "reload too slow for this test");
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    // The first retry comes due first.
    let t0 = std::time::Instant::now();
    while t0.elapsed() < std::time::Duration::from_millis(330) {
        r.intake.pump();
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    // The node catches up: everything waiting is answered.
    node.slots.lock().unwrap().clear();
    r.settle();
    let reg = r.h.c2.reg.read().unwrap();
    let e = &reg.pools[&(a(SOLP), None)];
    assert!(!(e.state == PoolState::Loading && e.busy), "stuck loading with nothing working for it: {:?} {}", e.state, e.reason);
    assert_eq!(e.state, PoolState::Ready, "{}", e.reason);
}

/// The guard: a pool "loading" with nothing working for it (no node job,
/// working copy or answer) for ARBSIM_COPY2_STALL_S is rescheduled and
/// logged, so a bookkeeping slip can never freeze a pool again.
#[test]
fn a_loading_pool_with_nothing_working_for_it_is_rescheduled() {
    let mut r = rig_with(C2Config { stall_s: 0, ..C2Config::for_tests() });
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    {
        let mut reg = r.h.c2.reg.write().unwrap();
        let e = reg.pools.get_mut(&(a(V2P), None)).unwrap();
        e.state = PoolState::Loading;
        e.busy = true;
        e.reason = "loading: fetching from the node".into();
    }
    r.send(tick(101, 61));
    std::thread::sleep(std::time::Duration::from_millis(1100));
    r.send(tick(102, 62));
    std::thread::sleep(std::time::Duration::from_millis(1100));
    r.send(tick(103, 63));
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready, "{:?}", r.state(&v2_pool()));
    assert_eq!(counter(&r, "stall_rescheduled"), 1);
}

/// A load that read the node BEFORE a late report that could not be placed
/// (not kept) would lack it: it reads again.
#[test]
fn a_load_older_than_an_unplaceable_late_report_reads_again() {
    let mut r = rig();
    r.track(vec![v2_pool()]);
    {
        let mut reg = r.h.c2.reg.write().unwrap();
        reg.pools.get_mut(&(a(V2P), None)).unwrap().need_base = 150;
    }
    *r.chain.tip.lock().unwrap() = 100;
    r.h.block(tick(100, 60));
    let t0 = std::time::Instant::now();
    while counter(&r, "loads") < 2 {
        r.intake.pump();
        assert!(t0.elapsed().as_secs() < 5, "read at 100 < 150 must be read again");
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert_ne!(r.state(&v2_pool()).0, PoolState::Ready);
}

// ---------------------------------------------------------------------------
// copy2-t: live Oct 23 02:22 shadow (quiet night): 13 of 27 checks missed
// ONLY USDG's totalSupply (the narrow-coin check needs it), over and over.
// USDG's supply moves every few minutes (bridge mints / burns), so the 60 s
// re-read forgot it, and its fill came back "too old": fills and re-reads
// read at the node's tip when it is behind the copy, and on a quiet night
// the copy has no version at exactly that block (it keeps one per message:
// blocks with reports, plus the newest quiet one), so reconcile dropped the
// value. Such a value is now placed at the copy's newest version before
// that block (nothing the copy follows changed in between: no reports).
// ---------------------------------------------------------------------------
#[test]
fn fills_and_rereads_at_a_node_block_the_copy_has_no_version_for_are_kept() {
    let cfg = C2Config { verify_every_s: 1, ..C2Config::for_tests() };
    let mut r = rig_with(cfg);
    let mut st = genesis();
    st.get_mut(&a(COIN0)).unwrap().insert(u(5), u(7)); // e.g. a coin's totalSupply
    st.get_mut(&a(COIN0)).unwrap().insert(u(6), u(9)); // another setting
    r.chain.set(100, st.clone());
    *r.chain.tip.lock().unwrap() = 103; // the node: 2 blocks behind the copy's head below
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    r.h.fill(vec![MissItem::Slot(a(COIN0), u(5))]);
    r.settle();
    assert_eq!(r.head_slot(a(COIN0), u(5)), Lookup::Known(u(7)));
    // The chain moves the supply at 101; the copy's next message is block
    // 105 (quiet blocks in between); the node is at 103.
    st.get_mut(&a(COIN0)).unwrap().insert(u(5), u(8));
    r.chain.set(101, st.clone());
    r.send(tick(105, 65));
    // (> ARBSIM_COPY2_TIP_MS, 2 s: the loaders learn the node's new tip.)
    std::thread::sleep(std::time::Duration::from_millis(2100));
    r.intake.pump(); // the 60 s re-read (1 s here), at the node's block 103
    r.settle();
    let c = |r: &Rig, n: &str| r.h.status_json(false)["counters"][n].as_u64().unwrap();
    assert_eq!(c(&r, "unfollowed_changed"), 1, "the re-read saw the change");
    assert_eq!(r.head_slot(a(COIN0), u(5)), Lookup::Known(u(8)), "refreshed, not lost");
    // A first fill while the node is behind: kept too.
    r.h.fill(vec![MissItem::Slot(a(COIN0), u(6))]);
    r.settle();
    assert_eq!(r.head_slot(a(COIN0), u(6)), Lookup::Known(u(9)));
    // Placed at the newest version before the node's block (100): that
    // version and the head have it.
    assert_eq!(r.sh.resolve(&At::Block(100)).unwrap().snap.storage(a(COIN0), u(6)), Lookup::Known(u(9)));
}

// ---------------------------------------------------------------------------
// Trigger-first checks on real copy-2 versions (check/ordered.rs + server.rs)
// ---------------------------------------------------------------------------

/// An outside contract copy 2 doesn't follow (trigger-first tests).
const OUTSIDE: u8 = 0x99;

/// anvil / hardhat test account #0 (public test key, no funds).
const TEST_KEY: [u8; 32] = [
    0xac, 0x09, 0x74, 0xbe, 0xc3, 0x9a, 0x17, 0xe3, 0x6b, 0xa4, 0xa6, 0xb4, 0xd2, 0x38, 0xff, 0x94, 0x4b, 0xac, 0xb4,
    0x78, 0xcb, 0xed, 0x5e, 0xfc, 0xae, 0x78, 0x4d, 0x7b, 0xf4, 0xf2, 0xff, 0x80,
];

/// A signed transaction (type 2) from the test key.
fn signed(nonce: u64, to: Address, data: Vec<u8>) -> Vec<u8> {
    check_util::sign_typed(&TEST_KEY, 2, &check_util::TestTx { nonce, gas: 200_000, to: Some(to), value: U256::ZERO, data, access_list: vec![] }, 4663)
}

fn hexb(b: &[u8]) -> String {
    format!("0x{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())
}

/// Copy 2 following the V2 pool (with a real getReserves-like getter that
/// returns slot 8), plus a server context for `server::handle`.
fn trig_world() -> (Rig, arbsim::server::Ctx) {
    trig_world_code(vec![0x60, 0x08, 0x54, 0x60, 0x00, 0x52, 0x60, 0x20, 0x60, 0x00, 0xf3])
}

/// trig_world with the V2 pool's code given.
fn trig_world_code(pool_code: Vec<u8>) -> (Rig, arbsim::server::Ctx) {
    let chain = Arc::new(FakeChain::new());
    // Plus an outside contract (think: a router's settings) holding 42 in
    // slot 5, returning the slot named by its call data: copy 2 never
    // follows it, it can only hold it as a fill.
    let mut g = genesis();
    g.entry(a(OUTSIDE)).or_default().insert(u(5), u(42));
    chain.set(100, g);
    chain.codes.lock().unwrap().insert(a(V2P), pool_code);
    chain.codes.lock().unwrap().insert(a(OUTSIDE), vec![0x60, 0x00, 0x35, 0x54, 0x60, 0x00, 0x52, 0x60, 0x20, 0x60, 0x00, 0xf3]);
    let node: Arc<dyn NodeApi> = chain.clone();
    let sh = Shared::new(Config::for_tests(), Some(node), Arc::new(Volatile::default()));
    let fills = Arc::new(FillQueue::new(1000, 100));
    let (intake, h) = manual(sh.clone(), fills.clone(), C2Config::for_tests());
    let (_u, updater) = arbsim::state::updater::manual(sh.clone(), fills.clone());
    let ctx = arbsim::server::Ctx { shared: sh.clone(), updater, fills, pinned: arbsim::state::pinned::PinnedCache::new(2), copy2: Some(h.clone()) };
    let mut r = Rig { chain, sh, intake, h };
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready, "{:?}", r.state(&v2_pool()));
    // Block 101: a user swap (100 coin0 in, 360 coin1 out).
    r.send(msg(101, 62, vec![
        v2_sync(1100, 3640, 101, 3, 2),
        transfer(a(COIN0), a(USER), a(V2P), 100, 101, 3, 0),
        transfer(a(COIN1), a(V2P), a(USER), 360, 101, 3, 1),
        lg(a(V2P), vec![topics().v2_swap, topic_of(a(USER)), topic_of(a(USER))], data(&[u(100), u(0), u(0), u(360)]), 101, 3, 3),
    ]));
    (r, ctx)
}

fn reserves_word(r0: u128, r1: u128, t: u128) -> String {
    w(u(r0) | (u(r1) << 112usize) | (u(t) << 224usize))
}

/// Our "trade": the pool's getter, from a wallet nobody tracks.
fn trig_call(ctx: &arbsim::server::Ctx, feed: Value) -> Value {
    arbsim::server::handle(ctx, &json!({"id": 7, "type": "call", "at": {"after": "head"}, "feed": feed, "calls": [{
        "from": format!("{}", a(0xe0)), "to": format!("{}", a(V2P)), "data": "0x0902f1ac", "gas": "0x100000"}]}))
}

#[test]
fn trigger_first_on_copy_2_versions_through_the_server() {
    let (mut r, ctx) = trig_world();
    // The trigger: a signed transaction the copy can replay (it reads the pool).
    let trig = signed(0, a(V2P), vec![0x09, 0x02, 0xf1, 0xac]);
    let th = hexb(keccak256(&trig).as_slice());
    // 1. Sequenced after the copy's block 101: replayed, then our call.
    let ans = trig_call(&ctx, json!({"trigger": th, "triggerSeq": 102, "msgs": [{"seq": 102, "ts": 63, "l1": 9000, "txs": [hexb(&trig)]}]}));
    assert_eq!(ans["ok"], json!(true), "{ans}");
    assert_eq!(ans["results"][0]["output"], json!(reserves_word(1100, 3640, 62)), "{ans}");
    assert_eq!((ans["trig"]["snapBlock"].clone(), ans["trig"]["included"].clone(), ans["trig"]["txs"].clone(), ans["trig"]["triggerOk"].clone()), (json!(101), json!(false), json!(1), json!(true)), "{ans}");
    // 2. Already in the copy (sequence 101 <= the copy's 101): not replayed.
    let ans = trig_call(&ctx, json!({"trigger": th, "triggerSeq": 101, "msgs": [{"seq": 101, "ts": 62, "l1": 9000, "txs": [hexb(&trig)]}]}));
    assert_eq!(ans["ok"], json!(true), "{ans}");
    assert_eq!((ans["trig"]["included"].clone(), ans["trig"]["txs"].clone(), ans["trig"]["triggerOk"].clone()), (json!(true), json!(0), Value::Null), "{ans}");
    // 3. A gap between the copy and the trigger's message: unknown.
    let ans = trig_call(&ctx, json!({"trigger": th, "triggerSeq": 104, "msgs": [{"seq": 104, "ts": 64, "l1": 9000, "txs": [hexb(&trig)]}]}));
    assert_eq!(ans["unknown"], json!("feed_gap"), "{ans}");
    // 4. A replayed tx needs state the copy doesn't hold: unknown, and NO
    //    node request is queued for it (trigger-first reads the node only
    //    through the bot's budgeted warming). A normal check's miss does.
    let nowhere = a(0x77);
    let t2 = signed(0, nowhere, vec![1]);
    let ans = trig_call(&ctx, json!({"trigger": hexb(keccak256(&t2).as_slice()), "triggerSeq": 102, "msgs": [{"seq": 102, "ts": 63, "l1": 9000, "txs": [hexb(&t2)]}]}));
    assert_eq!(ans["ok"], json!(false), "{ans}");
    assert!(ans["missing"].as_array().is_some_and(|m| m.iter().any(|x| x["account"] == json!(format!("{nowhere:#x}")))), "{ans}");
    let before = *r.chain.calls.lock().unwrap() + *r.chain.paid_calls.lock().unwrap();
    r.settle();
    let after = *r.chain.calls.lock().unwrap() + *r.chain.paid_calls.lock().unwrap();
    assert_eq!(before, after, "trigger-first misses must not reach the node by themselves");
    let plain = arbsim::server::handle(&ctx, &json!({"id": 8, "type": "call", "calls": [{"from": format!("{}", a(0xe0)), "to": format!("{nowhere}"), "data": "0x01", "gas": "0x100000"}]}));
    assert_eq!(plain["ok"], json!(false), "{plain}");
    r.settle();
    let later = *r.chain.calls.lock().unwrap() + *r.chain.paid_calls.lock().unwrap();
    assert!(later > after, "a normal check's miss is fetched (contrast)");
    // 5. Feed fields that can't be mixed: refused.
    let bad = arbsim::server::handle(&ctx, &json!({"id": 9, "type": "call", "rawTxs": [hexb(&trig)], "feed": {"trigger": th, "triggerSeq": 102, "msgs": []}, "calls": [{"to": format!("{}", a(V2P)), "data": "0x0902f1ac"}]}));
    assert_eq!(bad["unknown"], json!("bad_request"), "{bad}");
}

#[test]
fn reports_arriving_during_a_trigger_first_check_dont_change_it() {
    let (mut r, _ctx) = trig_world();
    let trig = signed(0, a(V2P), vec![0x09, 0x02, 0xf1, 0xac]);
    let feed: arbsim::check::ordered::WireFeed = serde_json::from_value(json!({"trigger": hexb(keccak256(&trig).as_slice()), "triggerSeq": 102, "msgs": [{"seq": 102, "ts": 63, "l1": 9000, "txs": [hexb(&trig)]}]})).unwrap();
    let req: arbsim::check::proto_types::CallRequest = serde_json::from_value(json!({"id": 1, "overrides": {format!("{}", a(0xe0)): {"balance": "0x0", "nonce": "0x0", "code": "0x"}}, "calls": [{
        "from": format!("{}", a(0xe0)), "to": format!("{}", a(V2P)), "data": "0x0902f1ac", "gas": "0x100000"}]})).unwrap();
    // The check picks copy version 101 ...
    let picked = r.sh.resolve(&At::Head).unwrap();
    let prov = r.h.provenance_at(picked.seq, &[]);
    let (plan, info) = arbsim::check::ordered::build_plan(&feed, picked.seq, 0, &picked.ctx).unwrap();
    let view = arbsim::state::snap::View::new(picked.snap.clone());
    let first = arbsim::check::proto_types::handle_trig_call(&view, &plan, &info, &req, &prov, true);
    // ... a report for block 102 arrives and is applied while it works ...
    r.send(msg(102, 63, vec![
        v2_sync(1200, 3340, 102, 1, 2),
        transfer(a(COIN0), a(USER), a(V2P), 100, 102, 1, 0),
        transfer(a(COIN1), a(V2P), a(USER), 300, 102, 1, 1),
        lg(a(V2P), vec![topics().v2_swap, topic_of(a(USER)), topic_of(a(USER))], data(&[u(100), u(0), u(0), u(300)]), 102, 1, 3),
    ]));
    assert_eq!(r.head_slot(a(V2P), u(8)), Lookup::Known(u(1200) | (u(3340) << 112usize) | (u(63) << 224usize)), "the copy moved on");
    // ... and the check still answers from the version it picked.
    let second = arbsim::check::proto_types::handle_trig_call(&view, &plan, &info, &req, &prov, true);
    assert_eq!(first["results"], second["results"], "{first} vs {second}");
    assert_eq!(first["results"][0]["output"], json!(reserves_word(1100, 3640, 62)));
    assert_eq!(first["trig"]["digest"], second["trig"]["digest"]);
}

#[test]
fn trigger_first_never_replays_on_a_fill_copy_2_does_not_follow() {
    let (mut r, ctx) = trig_world();
    // A normal check reads the outside contract: copy 2 fills it from the
    // node (it then holds 42 as a fill, re-read about once a minute).
    let slot5 = format!("0x{:064x}", 5);
    let mut held = false;
    for _ in 0..20 {
        let ans = arbsim::server::handle(&ctx, &json!({"id": 3, "type": "call", "calls": [{"from": format!("{}", a(0xe0)), "to": format!("{}", a(OUTSIDE)), "data": slot5, "gas": "0x100000"}]}));
        if ans["ok"] == json!(true) {
            assert_eq!(ans["results"][0]["output"], json!(w(u(42))));
            held = true;
            break;
        }
        r.settle();
        r.send(tick(r.sh.head().unwrap().block + 1, 70));
    }
    assert!(held, "the fill never arrived");
    let head = r.sh.head().unwrap().block;
    // A trigger that reads that fill. Strict (the bot's TRIG_FIRST_STRICT=1,
    // or ARBSIM_TRIG_CALL_TRUST=strict): never replayed on it (stale_fill).
    let trig = signed(0, a(OUTSIDE), hex_word(5));
    let feed = json!({"trigger": hexb(keccak256(&trig).as_slice()), "triggerSeq": head + 1, "strict": true, "msgs": [{"seq": head + 1, "ts": 80, "l1": 9000, "txs": [hexb(&trig)]}]});
    let ans = trig_call(&ctx, feed);
    assert_eq!(ans["unknown"], json!("stale_fill"), "{ans}");
    // The bot allowing only sender_funds: still stale_fill.
    let feed = json!({"trigger": hexb(keccak256(&trig).as_slice()), "triggerSeq": head + 1, "assume": ["sender_funds"], "msgs": [{"seq": head + 1, "ts": 80, "l1": 9000, "txs": [hexb(&trig)]}]});
    assert_eq!(trig_call(&ctx, feed)["unknown"], json!("stale_fill"));
    // Default (best effort): answered on the fill, labelled recent_fill, medium.
    let feed = json!({"trigger": hexb(keccak256(&trig).as_slice()), "triggerSeq": head + 1, "msgs": [{"seq": head + 1, "ts": 80, "l1": 9000, "txs": [hexb(&trig)]}]});
    let ans = trig_call(&ctx, feed);
    assert_eq!(ans["ok"], json!(true), "{ans}");
    assert_eq!((ans["trig"]["conf"].clone(), ans["trig"]["assumed"].clone()), (json!("medium"), json!(["recent_fill"])), "{ans}");
    // A trigger reading only what copy 2 follows (the pool): answered, exact.
    let trig = signed(0, a(V2P), vec![0x09, 0x02, 0xf1, 0xac]);
    let feed = json!({"trigger": hexb(keccak256(&trig).as_slice()), "triggerSeq": head + 1, "msgs": [{"seq": head + 1, "ts": 80, "l1": 9000, "txs": [hexb(&trig)]}]});
    let ans = trig_call(&ctx, feed);
    assert_eq!(ans["ok"], json!(true), "{ans}");
    assert_eq!((ans["trig"]["conf"].clone(), ans["trig"]["assumed"].clone(), ans["trig"]["skipped"].clone()), (json!("high"), json!([]), json!(0)), "{ans}");
}

#[test]
fn trigger_first_route_from_the_bots_keys_and_skipping_through_the_server() {
    let (mut r, ctx) = trig_world();
    // The route of our V2 pool: its contract, its two coin balances, its pair.
    let route = r.h.route_for(&[format!("{:#x}", a(V2P))]).expect("followed pool");
    assert!(route.accounts.contains(&a(V2P)));
    assert_eq!(route.pairs, vec![(a(COIN0), a(COIN1))]);
    assert_eq!(route.slots.iter().filter(|(c, _)| *c == a(COIN0) || *c == a(COIN1)).count(), 2, "{route:?}");
    assert!(r.h.route_for(&[format!("{:#x}", a(0x55))]).is_none(), "a pool copy 2 doesn't follow: no route (nothing skipped)");
    // A transaction we can't run (an account nobody holds) BEFORE the
    // trigger, not touching or naming our pool: skipped with the route, unknown without.
    let other = signed(0, a(0x3c), vec![1]);
    let trig = signed(1, a(V2P), vec![0x09, 0x02, 0xf1, 0xac]);
    let head = r.sh.head().unwrap().block;
    let msgs = json!([{"seq": head + 1, "ts": 80, "l1": 9000, "txs": [hexb(&other)]}, {"seq": head + 2, "ts": 81, "l1": 9000, "txs": [hexb(&trig)]}]);
    let th = hexb(keccak256(&trig).as_slice());
    let ans = trig_call(&ctx, json!({"trigger": th, "triggerSeq": head + 2, "msgs": msgs, "route": [format!("{:#x}", a(V2P))]}));
    assert_eq!(ans["ok"], json!(true), "{ans}");
    assert_eq!((ans["trig"]["assumed"].clone(), ans["trig"]["skipped"].clone(), ans["trig"]["conf"].clone()), (json!(["skipped_unrelated:1"]), json!(1), json!("medium")), "{ans}");
    let ans = trig_call(&ctx, json!({"trigger": th, "triggerSeq": head + 2, "msgs": msgs}));
    assert_eq!(ans["unknown"], json!("miss"), "no route given: never skipped {ans}");
    let _ = &mut r;
}

#[test]
fn trigger_first_trust_setting_and_the_bots_flags() {
    use arbsim::server::{trig_assume, trig_trust_from, TrigTrust};
    assert_eq!(trig_trust_from(None), TrigTrust::Best, "default: best effort");
    assert_eq!(trig_trust_from(Some("strict")), TrigTrust::Strict);
    assert_eq!(trig_trust_from(Some(" copy2 ")), TrigTrust::Copy2);
    assert_eq!(trig_trust_from(Some("whatever")), TrigTrust::Best);
    let feed = |v: Value| -> arbsim::check::ordered::WireFeed { serde_json::from_value(v).unwrap() };
    let route = |_: &[String]| Some(arbsim::check::ordered::Route::default());
    let f = feed(json!({"trigger": "0x00", "triggerSeq": 1, "route": ["0x01"]}));
    let (strict, a) = trig_assume(TrigTrust::Best, &f, route);
    assert!(strict && a.sender_funds && a.recent_fill && a.skip.is_some(), "best: everything");
    let (strict, a) = trig_assume(TrigTrust::Strict, &f, route);
    assert!(strict && !a.sender_funds && !a.recent_fill && a.skip.is_none(), "strict: nothing");
    let (strict, a) = trig_assume(TrigTrust::Copy2, &f, route);
    assert!(!strict && !a.sender_funds && a.skip.is_none(), "copy2: the old opt-in");
    let (_, a) = trig_assume(TrigTrust::Best, &feed(json!({"trigger": "0x00", "triggerSeq": 1, "strict": true, "route": ["0x01"]})), route);
    assert!(!a.sender_funds && a.skip.is_none(), "the bot's TRIG_FIRST_STRICT=1 wins");
    let (_, a) = trig_assume(TrigTrust::Best, &feed(json!({"trigger": "0x00", "triggerSeq": 1, "assume": ["recent_fill"], "route": ["0x01"]})), route);
    assert!(!a.sender_funds && a.recent_fill && a.skip.is_none(), "only what the bot allows");
    let (_, a) = trig_assume(TrigTrust::Best, &feed(json!({"trigger": "0x00", "triggerSeq": 1})), route);
    assert!(a.skip.is_none(), "no route: never skip");
}

fn hex_word(n: u64) -> Vec<u8> {
    u(n as u128).to_be_bytes::<32>().to_vec()
}

// TRIGGER-FIRST ENTRY POINT (server.rs trig_discover): "which pools copy 2
// follows does this feed transaction move?", answered from the trigger
// alone, no node.
#[test]
fn trig_discover_names_the_followed_pool_a_feed_tx_moves() {
    // The V2 pool: 4-byte call = getter (slot 8); 32-byte call = "swap" (writes slot 8).
    let code = vec![0x36, 0x60, 0x20, 0x14, 0x60, 0x12, 0x57, 0x60, 0x08, 0x54, 0x60, 0x00, 0x52, 0x60, 0x20, 0x60, 0x00, 0xf3, 0x5b, 0x60, 0x00, 0x35, 0x60, 0x08, 0x55, 0x00];
    let (mut r, ctx) = trig_world_code(code);
    let disc = |trig: &[u8], seq: u64| {
        arbsim::server::handle(&ctx, &json!({"id": 11, "type": "trig_discover", "at": {"after": "head"},
            "feed": {"trigger": hexb(keccak256(trig).as_slice()), "triggerSeq": seq, "msgs": [{"seq": seq, "ts": 63, "l1": 9000, "txs": [hexb(trig)]}]}}))
    };
    // 1. A "swap" on the followed pool: named.
    let mut word = vec![0u8; 32];
    word[31] = 9;
    let swap = signed(0, a(V2P), word);
    let ans = disc(&swap, 102);
    assert_eq!(ans["ok"], json!(true), "{ans}");
    assert_eq!(ans["pools"], json!([format!("{:#x}", a(V2P))]), "{ans}");
    assert_eq!((ans["triggerOk"].clone(), ans["snapBlock"].clone()), (json!(true), json!(101)), "{ans}");
    // 2. Only reading the pool: nothing moved, no pools.
    let read = signed(0, a(V2P), vec![0x09, 0x02, 0xf1, 0xac]);
    let ans = disc(&read, 102);
    assert_eq!(ans["ok"], json!(true), "{ans}");
    assert_eq!(ans["pools"], json!([]), "{ans}");
    // 3. Already in the copy version: unknown already_in_copy.
    let ans = disc(&swap, 101);
    assert_eq!(ans["unknown"], json!("already_in_copy"), "{ans}");
    // 4. Needs state we don't hold: unknown "miss" (the answer never waits
    //    for the node) ...
    let t2 = signed(0, a(0x77), vec![1]);
    let before = *r.chain.calls.lock().unwrap() + *r.chain.paid_calls.lock().unwrap();
    let ans = disc(&t2, 102);
    assert_eq!(ans["ok"], json!(false), "{ans}");
    assert_eq!(ans["unknown"], json!("miss"), "{ans}");
    r.settle();
    // ... but DISCOVER LEARNS (Oct 24): the few missing values are fetched
    // once in the background, so the same kind of trade can be replayed
    // next time (live: 69% of feed txs missed here and never got fetched).
    let after = *r.chain.calls.lock().unwrap() + *r.chain.paid_calls.lock().unwrap();
    assert!(after > before, "the missing values were fetched");
    let ans = disc(&t2, 102);
    assert_eq!(ans["ok"], json!(true), "after the fetch the trade is replayed: {ans}");
    assert_eq!(ans["pools"], json!([]), "it moves none of our pools: {ans}");
}

// Entry point fix (Oct 23, live): PR #175 named ALL V4 pools for every V4
// swap, because each V4 pool's followed values also hold SHARED PoolManager
// values (here slot 7, as filled for every pool keyed on the PoolManager).
// pools_changed now counts only each pool's own state (check/moved.rs).
#[test]
fn pools_changed_ignores_shared_pool_manager_values() {
    let mut r = rig_with(C2Config { walks_inflight: 0, ..C2Config::for_tests() });
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    let pm = a(0x44);
    let ids: Vec<B256> = (1..=5u8).map(B256::with_last_byte).collect();
    {
        let mut reg = r.h.c2.reg.write().unwrap();
        let tmpl = reg.pools.values().next().unwrap().clone();
        for id in &ids {
            let mut e = tmpl.clone();
            e.pool = TrackedPool { address: pm, v4_id: Some(*id), kind: PoolKind::V4, token0: a(COIN0), token1: a(COIN1), fee: 3000, tick_spacing: 60 };
            e.items.clear();
            e.items.insert((pm, u(7))); // the shared value, like live
            reg.pools.insert((pm, Some(*id)), e);
            reg.by_addr.entry(pm).or_default().push((pm, Some(*id)));
        }
    }
    let base1 = arbsim::check::moved::v4_base(ids[1]);
    // A V4 swap on pool 1: its slot0 + the shared value.
    let m = r.h.pools_changed(&[(pm, base1), (pm, u(7))], &[]);
    assert_eq!(m.iter().map(|x| x.key.clone()).collect::<Vec<_>>(), vec![format!("{:#x}", ids[1])], "{m:?}");
    // Only the shared value: nothing moved.
    assert!(r.h.pools_changed(&[(pm, u(7))], &[]).is_empty());
    // The V2 pool's own reserves: that pool.
    let m = r.h.pools_changed(&[(a(V2P), u(8))], &[]);
    assert_eq!(m.iter().map(|x| x.key.clone()).collect::<Vec<_>>(), vec![format!("{:#x}", a(V2P))]);
}

#[test]
fn bench_entry_server_path_test_numbers_only() {
    let (_r, ctx) = trig_world();
    let trig = signed(0, a(V2P), vec![0x09, 0x02, 0xf1, 0xac]);
    let feed = json!({"trigger": hexb(keccak256(&trig).as_slice()), "triggerSeq": 102, "msgs": [{"seq": 102, "ts": 63, "l1": 9000, "txs": [hexb(&trig)]}]});
    let n = 200u128;
    let t = std::time::Instant::now();
    for _ in 0..n {
        let d = arbsim::server::handle(&ctx, &json!({"id": 1, "type": "trig_discover", "at": {"after": "head"}, "feed": feed}));
        assert_eq!(d["ok"], json!(true), "{d}");
    }
    let disc = t.elapsed().as_micros() / n;
    // A candidate check with a 2-size ladder (the getter stands in for our trade: amount word at offset 0).
    let mut data = vec![0x09, 0x02, 0xf1, 0xac];
    data.extend([0u8; 31]);
    data.push(9);
    let t = std::time::Instant::now();
    for _ in 0..n {
        let c = arbsim::server::handle(&ctx, &json!({"id": 2, "type": "call", "at": {"after": "head"}, "feed": feed,
            "sizes": {"amountOffset": 0, "amounts": ["0x3", "0x5"]},
            "calls": [{"from": format!("{}", a(0xe0)), "to": format!("{}", a(V2P)), "data": hexb(&data), "gas": "0x100000"}]}));
        assert_eq!(c["ok"], json!(true), "{c}");
    }
    let chk = t.elapsed().as_micros() / n;
    println!("[bench, test numbers only] server path (copy 2 rig, 1 feed tx): trig_discover {disc} us, candidate check + 2-size ladder {chk} us ({} build)", if cfg!(debug_assertions) { "debug" } else { "release" });
}

// ---------------------------------------------------------------------------
// SPEED-3 (Oct 24): feed store, lock-free exact-values list / moved pools,
// per-phase timing. Every answer must be EXACTLY the old one.
// ---------------------------------------------------------------------------

/// Tests that use the process-wide feed store take turns (and start empty):
/// sequence numbers are reused between tests.
static FEED_STORE_TURN: Mutex<()> = Mutex::new(());

/// An answer without its timing / id fields (those differ run to run).
fn strip_timing(v: &Value) -> Value {
    let mut v = v.clone();
    if let Some(o) = v.as_object_mut() {
        for k in ["us", "t", "id", "ph", "pn", "cpu"] {
            o.remove(k);
        }
    }
    v
}

/// The bot's feed (as sent inline) -> the same feed naming the messages,
/// after handing them to the store (`feed_put`).
fn feed_as_refs(feed: &Value) -> Value {
    arbsim::check::feedstore::store().put_json(&json!({"type": "feed_put", "msgs": feed["msgs"].clone()}));
    let refs: Vec<Value> = feed["msgs"].as_array().unwrap().iter().map(|m| json!([m["seq"].clone(), m["txs"].as_array().map_or(0, |t| t.len())])).collect();
    let mut f = feed.clone();
    f.as_object_mut().unwrap().remove("msgs");
    f["refs"] = json!(refs);
    f
}

#[test]
fn feed_store_answers_equal_inline_answers_through_the_server() {
    let _turn = FEED_STORE_TURN.lock().unwrap_or_else(|e| e.into_inner());
    arbsim::check::feedstore::store().clear();
    let code = vec![0x36, 0x60, 0x20, 0x14, 0x60, 0x12, 0x57, 0x60, 0x08, 0x54, 0x60, 0x00, 0x52, 0x60, 0x20, 0x60, 0x00, 0xf3, 0x5b, 0x60, 0x00, 0x35, 0x60, 0x08, 0x55, 0x00];
    let (_r, ctx) = trig_world_code(code);
    let mut word = vec![0u8; 32];
    word[31] = 9;
    let swap = signed(0, a(V2P), word);
    let read = signed(1, a(V2P), vec![0x09, 0x02, 0xf1, 0xac]);
    let nowhere = signed(2, a(0x77), vec![1]);
    let pool = format!("{:#x}", a(V2P));
    let mut data = vec![0x09, 0x02, 0xf1, 0xac];
    data.extend([0u8; 31]);
    data.push(9);
    for (trig, seq, msgs) in [
        (&swap, 102u64, json!([{"seq": 101, "ts": 62, "l1": 9000, "txs": [hexb(&read)]}, {"seq": 102, "ts": 63, "l1": 9000, "txs": [hexb(&read), hexb(&swap)]}, {"seq": 103, "ts": 64, "l1": 9000, "txs": [hexb(&read)]}])),
        (&read, 102, json!([{"seq": 102, "ts": 63, "l1": 9000, "txs": [hexb(&read)]}])),
        (&swap, 101, json!([{"seq": 101, "ts": 63, "l1": 9000, "txs": [hexb(&swap)]}])),
        (&nowhere, 102, json!([{"seq": 102, "ts": 63, "l1": 9000, "txs": [hexb(&nowhere)]}])),
        (&swap, 104, json!([{"seq": 104, "ts": 63, "l1": 9000, "txs": [hexb(&swap)]}])),
    ] {
        arbsim::check::feedstore::store().clear();
        let feed = json!({"trigger": hexb(keccak256(trig).as_slice()), "triggerSeq": seq, "msgs": msgs, "route": [pool.clone()]});
        let refs = feed_as_refs(&feed);
        // Discover.
        let d1 = arbsim::server::handle(&ctx, &json!({"id": 1, "type": "trig_discover", "at": {"after": "head"}, "feed": feed}));
        let d2 = arbsim::server::handle(&ctx, &json!({"id": 1, "type": "trig_discover", "at": {"after": "head"}, "feed": refs}));
        assert_eq!(strip_timing(&d1), strip_timing(&d2), "discover: inline vs refs");
        assert!(d2.get("ph").is_some() && d2.get("cpu").is_some(), "phase timing in the answer: {d2}");
        // A candidate check with a ladder.
        let call = |f: &Value| {
            arbsim::server::handle(&ctx, &json!({"id": 2, "type": "call", "at": {"after": "head"}, "feed": f, "prio": true,
                "sizes": {"amountOffset": 0, "amounts": ["0x3", "0x5"]}, "overrides": {},
                "calls": [{"from": format!("{}", a(0xe0)), "to": pool.clone(), "data": hexb(&data), "gas": "0x100000"}]}))
        };
        let (c1, c2) = (call(&feed), call(&refs));
        assert_eq!(strip_timing(&c1), strip_timing(&c2), "call: inline vs refs");
    }
    // A message the sidecar doesn't hold: "feed_ref_missing" (the bot then sends it inline).
    arbsim::check::feedstore::store().clear();
    let miss = json!({"trigger": hexb(keccak256(&swap).as_slice()), "triggerSeq": 102, "refs": [[102, 1]]});
    let d = arbsim::server::handle(&ctx, &json!({"id": 3, "type": "trig_discover", "at": {"after": "head"}, "feed": miss}));
    assert_eq!(d["unknown"], json!("feed_ref_missing"), "{d}");
    let c = arbsim::server::handle(&ctx, &json!({"id": 4, "type": "call", "at": {"after": "head"}, "feed": miss,
        "calls": [{"from": format!("{}", a(0xe0)), "to": pool.clone(), "data": "0x0902f1ac", "gas": "0x100000"}]}));
    assert_eq!(c["unknown"], json!("feed_ref_missing"), "{c}");
    // Both at once: refused.
    let both = json!({"trigger": hexb(keccak256(&swap).as_slice()), "triggerSeq": 102, "refs": [[102, 1]], "msgs": [{"seq": 102, "ts": 63, "l1": 9000, "txs": [hexb(&swap)]}]});
    let d = arbsim::server::handle(&ctx, &json!({"id": 5, "type": "trig_discover", "at": {"after": "head"}, "feed": both}));
    assert_eq!(d["unknown"], json!("bad_request"), "{d}");
    // One trip: the discovery part names the same pools with refs.
    arbsim::check::feedstore::store().clear();
    let feed = json!({"trigger": hexb(keccak256(&swap).as_slice()), "triggerSeq": 102, "msgs": [{"seq": 102, "ts": 63, "l1": 9000, "txs": [hexb(&swap)]}]});
    let refs = feed_as_refs(&feed);
    let e1 = arbsim::server::handle(&ctx, &json!({"id": 6, "type": "trig_entry", "at": {"after": "head"}, "feed": feed, "limit": 6, "maxPools": 4, "minConf": "medium", "budgetUs": 5_000_000}));
    let e2 = arbsim::server::handle(&ctx, &json!({"id": 6, "type": "trig_entry", "at": {"after": "head"}, "feed": refs, "limit": 6, "maxPools": 4, "minConf": "medium", "budgetUs": 5_000_000}));
    assert_eq!(strip_timing(&e1["disc"]), strip_timing(&e2["disc"]), "{e1} vs {e2}");
    // Status shows the store and the phase percentiles.
    let st = arbsim::server::handle(&ctx, &json!({"id": 7, "type": "status"}));
    assert!(st["feedStore"]["msgs"].as_u64().is_some(), "{}", st["feedStore"]);
    assert!(st["trigTiming"]["discover"]["n"].as_u64().unwrap_or(0) > 0, "{}", st["trigTiming"]);
    arbsim::check::feedstore::store().clear();
}

/// Copy 2 with `n` extra followed pools (half V4 pools inside one
/// PoolManager, half contract pools with followed coin balances and an
/// owned account each), in mixed states, written straight into the registry.
fn add_pools(r: &Rig, n: usize) -> Address {
    let pm = a(0x44);
    let mut reg = r.h.c2.reg.write().unwrap();
    let tmpl = reg.pools.values().next().unwrap().clone();
    for i in 0..n {
        let mut e = tmpl.clone();
        let half = i % 2 == 0;
        let (addr, id) = if half {
            (pm, Some(B256::from(U256::from(1_000_000 + i as u64))))
        } else {
            (Address::from_word(B256::from(U256::from(0x5000_0000u64 + i as u64))), None)
        };
        e.pool = TrackedPool { address: addr, v4_id: id, kind: if half { PoolKind::V4 } else { PoolKind::V2 }, token0: a(COIN0), token1: a(COIN1), fee: 3000, tick_spacing: 60 };
        e.items.clear();
        // Mixed: most ready since different blocks, some loading.
        e.state = if i % 7 == 3 { PoolState::Loading } else { PoolState::Ready };
        e.ready_since = 95 + (i as u64 % 10);
        e.owned = if !half && i % 3 == 0 { vec![Address::from_word(B256::from(U256::from(0x6000_0000u64 + i as u64)))] } else { vec![] };
        reg.pools.insert((addr, id), e.clone());
        reg.by_addr.entry(addr).or_default().push((addr, id));
        for o in &e.owned {
            reg.owner_of.insert(*o, (addr, id));
        }
        if !half {
            reg.holders.entry(a(COIN0)).or_default().insert(addr);
            reg.holders.entry(a(COIN1)).or_default().insert(addr);
        }
    }
    pm
}

#[test]
fn exact_values_and_moved_pools_from_the_summary_equal_the_registry_walk() {
    let mut r = rig_with(C2Config { walks_inflight: 0, ..C2Config::for_tests() });
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    let pm = add_pools(&r, 200);
    let core = r.h.core_for(None);
    let extra = [a(0xe7)];
    for n in 90..110u64 {
        for x in [&[][..], &extra[..]] {
            let old = r.h.provenance_at(n, x);
            let new = r.h.provenance_with(&core, n, x);
            assert_eq!(old.flat(), new.flat(), "block {n}");
        }
    }
    // Moved pools: V4 slot0 of some ids, a contract pool's reserves, shared values.
    let ids: Vec<B256> = (0..10u64).map(|i| B256::from(U256::from(1_000_000 + 2 * i))).collect();
    let mut changed: Vec<(Address, U256)> = ids.iter().take(3).map(|id| (pm, arbsim::check::moved::v4_base(*id))).collect();
    changed.push((Address::from_word(B256::from(U256::from(0x5000_0001u64))), u(8)));
    changed.push((pm, u(7)));
    changed.push((a(V2P), u(8)));
    changed.sort();
    assert_eq!(r.h.pools_changed(&changed, &[]), r.h.pools_changed_with(&core, &changed, &[]));
    assert_eq!(r.h.pools_changed_with(&core, &changed, &[]).len(), 5);
    assert!(r.h.pools_changed_with(&core, &[], &[]).is_empty());
}

/// Benchmark (TEST NUMBERS: a tiny trigger contract on the in-memory copy,
/// not live numbers). The live question shape: 48 feed messages x 10
/// transactions x ~1 KB, the trigger 3 messages after the copy's block,
/// copy 2 following ~640 pools. Old way (messages inline) vs feed store
/// (messages named), through the server, plus the socket thread's JSON
/// read of each question, plus the exact-values list / moved-pool match.
#[test]
fn bench_discover_payload_and_registry_test_numbers_only() {
    let _turn = FEED_STORE_TURN.lock().unwrap_or_else(|e| e.into_inner());
    arbsim::check::feedstore::store().clear();
    let code = vec![0x36, 0x60, 0x20, 0x14, 0x60, 0x12, 0x57, 0x60, 0x08, 0x54, 0x60, 0x00, 0x52, 0x60, 0x20, 0x60, 0x00, 0xf3, 0x5b, 0x60, 0x00, 0x35, 0x60, 0x08, 0x55, 0x00];
    let (r, ctx) = trig_world_code(code);
    add_pools(&r, 640);
    let mut word = vec![0u8; 32];
    word[31] = 9;
    let swap = signed(0, a(V2P), word);
    // 48 messages 57..104 (the copy is at 101): 10 filler transactions of
    // ~1 KB each, the trigger in 104.
    let mut nonce = 1u64;
    let mut msgs = Vec::new();
    for seq in 57..=104u64 {
        let mut txs: Vec<String> = (0..10)
            .map(|_| {
                nonce += 1;
                hexb(&signed(nonce, a(0x77), vec![0xab; 900]))
            })
            .collect();
        if seq == 104 {
            txs[5] = hexb(&swap);
        }
        msgs.push(json!({"seq": seq, "ts": 60 + seq, "l1": 9000, "txs": txs}));
    }
    let feed = json!({"trigger": hexb(keccak256(&swap).as_slice()), "triggerSeq": 104, "msgs": msgs});
    let refs = feed_as_refs(&feed);
    let q_inline = json!({"id": 1, "type": "trig_discover", "at": {"after": "head"}, "feed": feed});
    let q_refs = json!({"id": 1, "type": "trig_discover", "at": {"after": "head"}, "feed": refs});
    let (b_inline, b_refs) = (serde_json::to_vec(&q_inline).unwrap(), serde_json::to_vec(&q_refs).unwrap());
    // Warm both (the first question decodes the new transactions).
    let w1 = arbsim::server::handle(&ctx, &q_inline);
    let w2 = arbsim::server::handle(&ctx, &q_refs);
    assert_eq!(w1["ok"], json!(true), "{w1}");
    assert_eq!(strip_timing(&w1), strip_timing(&w2));
    let n = 100u128;
    let time = |b: &[u8]| {
        let (mut read, mut work) = (0u128, 0u128);
        for _ in 0..n {
            let t = std::time::Instant::now();
            let q: Value = serde_json::from_slice(b).unwrap();
            read += t.elapsed().as_micros();
            let t = std::time::Instant::now();
            let d = arbsim::server::handle(&ctx, &q);
            work += t.elapsed().as_micros();
            assert_eq!(d["ok"], json!(true));
        }
        (read / n, work / n)
    };
    let (ri, wi) = time(&b_inline);
    let (rr, wr) = time(&b_refs);
    arbsim::timing::ph_reset();
    let last = arbsim::server::handle(&ctx, &q_refs);
    arbsim::timing::ph_reset();
    let last_inline = arbsim::server::handle(&ctx, &q_inline);
    // Exact-values list + moved pools, old (registry walk under its lock) vs new (summary).
    let core = r.h.core_for(None);
    let changed = vec![(a(V2P), u(8))];
    let t = std::time::Instant::now();
    for _ in 0..n {
        let _ = r.h.provenance_at(101, &[]);
        let _ = r.h.pools_changed(&changed, &[]);
    }
    let old_reg = t.elapsed().as_micros() / n;
    let t = std::time::Instant::now();
    for i in 0..n {
        // (a new block each time: the cached list is not reused)
        let _ = r.h.provenance_with(&core, 101 + (i as u64 % 2) * 1000 + i as u64, &[]);
        let _ = r.h.pools_changed_with(&core, &changed, &[]);
    }
    let new_reg = t.elapsed().as_micros() / n;
    println!(
        "[bench, test numbers only] trig_discover, 48 msgs x 10 txs x ~1 KB, copy 2 following {} pools ({} build):\n  old (messages inline): question {} KB, socket-thread JSON read {ri} us, worker {wi} us\n  new (feed store refs): question {} KB, socket-thread JSON read {rr} us, worker {wr} us\n  exact-values list + moved pools per question: registry walk {old_reg} us, summary {new_reg} us (new block each time; same block: cached)\n  phases (us) of one new-way question: {} counts {}\n  phases (us) of one old-way question: {} counts {}",
        641,
        if cfg!(debug_assertions) { "debug" } else { "release" },
        b_inline.len() / 1024,
        b_refs.len() / 1024,
        last["ph"],
        last["pn"],
        last_inline["ph"],
        last_inline["pn"]
    );
    arbsim::check::feedstore::store().clear();
}

// TRIGGER-ENTRY ONE TRIP (server.rs trig_entry + check/entry.rs): discovery
// and the candidate checks in one question. Each candidate's answer must be
// EXACTLY what the bot's own trigger-first `call` gets (same handler, same
// feed with that route, same size ladder), so the bot's decision can't
// differ from the two-step path.
#[test]
fn trig_entry_one_trip_equals_discover_then_call() {
    // The V2 pool: 4-byte-plus call = getter (slot 8); exactly 32 bytes = "swap" (writes slot 8).
    let code = vec![0x36, 0x60, 0x20, 0x14, 0x60, 0x12, 0x57, 0x60, 0x08, 0x54, 0x60, 0x00, 0x52, 0x60, 0x20, 0x60, 0x00, 0xf3, 0x5b, 0x60, 0x00, 0x35, 0x60, 0x08, 0x55, 0x00];
    let (_r, ctx) = trig_world_code(code);
    let mut word = vec![0u8; 32];
    word[31] = 9;
    let swap = signed(0, a(V2P), word);
    let feed = json!({"trigger": hexb(keccak256(&swap).as_slice()), "triggerSeq": 102, "msgs": [{"seq": 102, "ts": 63, "l1": 9000, "txs": [hexb(&swap)]}]});
    let pool = format!("{:#x}", a(V2P));
    let mut data = vec![0x09, 0x02, 0xf1, 0xac];
    data.extend([0u8; 31]);
    data.push(9);
    let check = json!({"calls": [{"from": format!("{}", a(0xe0)), "to": pool.clone(), "data": hexb(&data), "gas": "0x100000"}],
        "overrides": {}, "sizes": {"amountOffset": 0, "amounts": ["0x3", "0x5"]}, "route": [pool.clone()], "stop": "0x1", "amt": "0x9"});
    let entry = |id: u64| arbsim::server::handle(&ctx, &json!({"id": id, "type": "trig_entry", "at": {"after": "head"}, "feed": feed, "limit": 6, "maxPools": 4, "minConf": "medium", "budgetUs": 5_000_000}));
    // No table yet: discovery still answered, candidates left to the bot.
    arbsim::check::entry::clear_table();
    let a0 = entry(1);
    assert_eq!(a0["ok"], json!(true), "{a0}");
    assert_eq!(a0["disc"]["pools"], json!([pool.clone()]), "{a0}");
    assert_eq!(a0["table"], json!("none"), "{a0}");
    // The table: two routes for the pool (one better scored), one the bot couldn't build.
    let t = arbsim::server::handle(&ctx, &json!({"id": 2, "type": "trig_table", "gen": 7, "full": true, "codes": [], "pools": {pool.clone(): [
        {"rid": "r1", "h": true, "s": 1.0, "e": "e1", "c": check},
        {"rid": "r2", "h": true, "s": 2.0, "e": "e2", "c": check},
        {"rid": "r3", "h": true, "s": 3.0, "e": null},
    ]}}));
    assert_eq!(t["ok"], json!(true), "{t}");
    let a1 = entry(3);
    assert_eq!(a1["tableGen"], json!(7), "{a1}");
    assert_eq!(a1["sel"], json!(["e2", "e1"]), "best score first; the unbuildable row dropped: {a1}");
    assert_eq!(a1["found"], json!(3), "{a1}");
    // The one-trip discovery equals a plain trig_discover...
    let d = arbsim::server::handle(&ctx, &json!({"id": 3, "type": "trig_discover", "at": {"after": "head"}, "feed": feed}));
    // (timing fields differ run to run: us / t, and the speed-3 phase list ph / pn / cpu)
    // (and the entry-step timings, Oct 29: buildUs / wallUs)
    let strip = |v: &Value| { let mut v = v.clone(); for k in ["us", "t", "id", "ph", "pn", "cpu", "buildUs", "wallUs"] { v.as_object_mut().unwrap().remove(k); } v };
    assert_eq!(strip(&a1["disc"]), strip(&d), "discovery part");
    // ... and each candidate's answer equals the bot's own call.
    let mut f = feed.clone();
    f["route"] = json!([pool.clone()]);
    let c = arbsim::server::handle(&ctx, &json!({"id": 3, "type": "call", "at": {"after": "head"}, "feed": f, "prio": true,
        "sizes": {"amountOffset": 0, "amounts": ["0x3", "0x5"]}, "overrides": {},
        "calls": [{"from": format!("{}", a(0xe0)), "to": pool.clone(), "data": hexb(&data), "gas": "0x100000"}]}));
    assert_eq!(c["ok"], json!(true), "{c}");
    let cands = a1["cands"].as_array().unwrap();
    assert_eq!(cands.len(), 2, "not good enough to send: both checked: {a1}");
    for x in cands {
        assert_eq!(strip(&x["a"]), strip(&c), "candidate {} answer", x["e"]);
    }
    // A partial update for a generation the sidecar doesn't hold is refused.
    let bad = arbsim::server::handle(&ctx, &json!({"id": 4, "type": "trig_table", "gen": 9, "full": false, "base": 3, "pools": {}}));
    assert_eq!(bad["unknown"], json!("table_gen"), "{bad}");
    arbsim::check::entry::clear_table();
}

// ---------------------------------------------------------------------------
// WANTED (copy2-relist): route pools the bot's checks found "loading" come
// with its status poll; they load before every other waiting pool, even
// one that had events more recently.
// ---------------------------------------------------------------------------
fn hex_addr(x: Address) -> String {
    format!("0x{}", x.as_slice().iter().map(|b| format!("{b:02x}")).collect::<String>())
}

#[test]
fn wanted_pools_load_first() {
    // One loader, one pool per load: the order is visible.
    let mut r = rig_with(C2Config { loaders: 1, load_batch: 1, ..C2Config::for_tests() });
    let wanted = v2_pool();
    let busy = TrackedPool { address: a(0xa3), ..v2_pool() };
    let mut s = genesis();
    let g = s[&a(V2P)].clone();
    s.insert(a(0xa3), g);
    for c in [COIN0, COIN1] {
        let v = s[&a(c)][&map_slot(a(V2P), 0)];
        s.get_mut(&a(c)).unwrap().insert(map_slot(a(0xa3), 0), v);
    }
    r.chain.set(100, s);
    // The bot's checks wait for the quiet pool (status `wanted`).
    r.h.note_wanted(Some(&json!([hex_addr(wanted.address), "not a pool", 7])));
    assert_eq!(r.h.c2.wanted.lock().unwrap().len(), 1, "only the valid key is kept");
    r.track(vec![wanted.clone(), busy.clone()]);
    r.h.block(msg(100, 60, vec![lg(a(0xa3), vec![topics().v2_sync], data(&[u(1000), u(4000)]), 100, 0, 0)]));
    let t0 = std::time::Instant::now();
    loop {
        r.intake.pump();
        let (ws, bs) = (r.state(&wanted).0, r.state(&busy).0);
        if ws == PoolState::Ready || bs == PoolState::Ready {
            assert_eq!(ws, PoolState::Ready, "the wanted pool should be ready first");
            break;
        }
        assert!(t0.elapsed().as_secs() < 10);
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    r.settle();
    assert_eq!(r.state(&busy).0, PoolState::Ready);
    let st = r.h.status_json(false);
    assert!(st["counters"]["wanted_loads"].as_u64().unwrap() >= 1, "{st}");
}

#[test]
fn wanted_hint_rides_on_the_status_request() {
    let chain = Arc::new(FakeChain::new());
    chain.set(100, genesis());
    let ctx = arbsim::serve::build_with(Config::for_tests(), Some(chain as Arc<dyn NodeApi>), arbsim::serve::Source::PoolEvents);
    let id = format!("0x{}", "ab".repeat(32));
    let st = arbsim::server::handle(&ctx, &json!({"id": 2, "type": "status", "pools": true, "wanted": [hex_addr(a(V2P)), id]}));
    assert_eq!(st["copy2"]["source"], json!("pool-events"));
    let c2 = ctx.copy2.as_ref().unwrap();
    {
        let w = c2.c2.wanted.lock().unwrap();
        assert_eq!((w.addrs.len(), w.ids.len()), (1, 1), "an address and a V4 pool id noted");
        let now = std::time::Instant::now();
        assert!(w.has(&v2_pool(), now));
        assert!(!w.has(&sol_pool(), now));
    }
    // Bounded: a flood keeps at most 512.
    let many: Vec<String> = (0..2000u32).map(|i| format!("0x{:040x}", i + 1)).collect();
    arbsim::server::handle(&ctx, &json!({"id": 3, "type": "status", "wanted": many}));
    assert!(c2.c2.wanted.lock().unwrap().len() <= 512);
    // No hint: nothing changes, and an old bot (no field) is fine.
    arbsim::server::handle(&ctx, &json!({"id": 4, "type": "status"}));
    c2.stop();
}

// ---------------------------------------------------------------------------
// V4 BLIND SPOT (Oct 25, copy2/v4blind.rs). Live: 38,950 PoolManager values
// refused with one vague reason. Now a check's hash inputs name each one:
// a far tick of OUR ready pool is fetched and kept with that pool (fix b);
// a value of a pool we don't follow stays refused but is counted and listed
// (auto-follow list when on, fix a); anything unnamed stays refused.
// ---------------------------------------------------------------------------
fn h2(x: U256, y: U256) -> U256 {
    let mut b = [0u8; 64];
    b[..32].copy_from_slice(&x.to_be_bytes::<32>());
    b[32..].copy_from_slice(&y.to_be_bytes::<32>());
    U256::from_be_bytes(keccak256(b).0)
}

/// (hash inputs a check recorded, tick slot, bitmap-word slot) for pool `id`.
fn v4_far(id: B256, tick: u64, word: u64) -> (Vec<(U256, U256, U256)>, U256, U256) {
    let idw = U256::from_be_bytes(id.0);
    let base = arbsim::check::moved::v4_base(id);
    let t = h2(u(tick as u128), base + u(4));
    let wd = h2(u(word as u128), base + u(5));
    (vec![(base, idw, u(6)), (t, u(tick as u128), base + u(4)), (wd, u(word as u128), base + u(5))], t, wd)
}

/// A rig with one ready V4 pool of ours (id 0x01) at PoolManager 0x44.
fn blind_rig(cfg: C2Config) -> (Rig, Address, B256) {
    let mut r = rig_with(C2Config { walks_inflight: 0, ..cfg });
    r.track(vec![v2_pool()]);
    r.send(tick(100, 60));
    let pm = a(0x44);
    let ours = B256::with_last_byte(1);
    {
        let mut reg = r.h.c2.reg.write().unwrap();
        let mut e = reg.pools.values().next().unwrap().clone();
        e.pool = TrackedPool { address: pm, v4_id: Some(ours), kind: PoolKind::V4, token0: a(COIN0), token1: a(COIN1), fee: 3000, tick_spacing: 60 };
        e.items.clear();
        e.base_block = 100;
        e.ready_since = 100;
        reg.pools.insert((pm, Some(ours)), e);
        reg.by_addr.entry(pm).or_default().push((pm, Some(ours)));
    }
    r.send(tick(101, 61));
    (r, pm, ours)
}

#[test]
fn v4_blind_far_tick_of_our_pool_is_kept_others_refused_by_class() {
    let (mut r, pm, ours) = blind_rig(C2Config::for_tests());
    let theirs = B256::with_last_byte(0x77);
    let (mut pre, t_ours, w_ours) = v4_far(ours, 887_000, 3000);
    let (pre_theirs, t_theirs, _) = v4_far(theirs, 5, 0);
    pre.extend(pre_theirs);
    let unnamed = u(0xabcdef);
    // The chain's values (block 100 on).
    let mut s = r.chain.at(100);
    let m = s.entry(pm).or_default();
    m.insert(t_ours, u(0x1234));
    m.insert(w_ours, u(0x8000));
    m.insert(t_theirs, u(0x99));
    m.insert(unnamed, u(0x55));
    r.chain.set(100, s);
    let missing = vec![MissItem::Slot(pm, t_ours), MissItem::Slot(pm, w_ours), MissItem::Slot(pm, t_theirs), MissItem::Slot(pm, unnamed)];
    // 1. The check that missed them names them (status counters by class).
    let core = r.h.c2.check_core();
    r.h.note_pm_pre(&core, &missing, &pre);
    assert_eq!(counter(&r, "pm_miss_own_far"), 2);
    assert_eq!(counter(&r, "pm_miss_unfollowed"), 1);
    assert_eq!(counter(&r, "pm_miss_unknown"), 1);
    assert_eq!(counter(&r, "pm_named"), 3);
    let st = r.h.status_json(false);
    assert_eq!(st["v4Blind"]["topUnfollowed"][0]["id"], json!(format!("{theirs:#x}")), "{}", st["v4Blind"]);
    assert_eq!(st["v4Blind"]["autoFollow"]["ids"], json!([]), "auto-follow is off by default");
    // 2. The fill: our pool's far tick + bitmap word fetched and KEPT;
    //    the other pool's tick and the unnamed value refused, by class.
    r.h.fill(missing);
    r.settle();
    assert_eq!(r.head_slot(pm, t_ours), Lookup::Known(u(0x1234)));
    assert_eq!(r.head_slot(pm, w_ours), Lookup::Known(u(0x8000)));
    assert_eq!(r.head_slot(pm, t_theirs), Lookup::Missing, "never held: nothing would keep it current");
    assert_eq!(r.head_slot(pm, unnamed), Lookup::Missing);
    assert_eq!(counter(&r, "pm_far_sent"), 2);
    assert_eq!(counter(&r, "pm_far_kept"), 2);
    assert_eq!(counter(&r, "fill_refused_pm_slot"), 2);
    assert_eq!(counter(&r, "pm_refused_unfollowed"), 1);
    assert_eq!(counter(&r, "pm_refused_unknown"), 1);
    // Kept WITH our pool: followed by its events, forgotten with it.
    {
        let reg = r.h.c2.reg.read().unwrap();
        let e = &reg.pools[&(pm, Some(ours))];
        assert!(e.items.contains(&(pm, t_ours)) && e.items.contains(&(pm, w_ours)));
    }
    // 3. The pool goes unsure (the node takes back one of its reports):
    //    the kept values are forgotten with its other values, from that
    //    block on, never left behind with an old number.
    let mut gone = lg(pm, vec![topic("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"), ours], data(&[u(0); 6]), 101, 0, 0);
    gone.removed = true;
    r.intake.process(msg(102, 62, vec![gone]));
    assert_ne!(r.state(&TrackedPool { address: pm, v4_id: Some(ours), kind: PoolKind::V4, token0: a(COIN0), token1: a(COIN1), fee: 3000, tick_spacing: 60 }).0, PoolState::Ready);
    assert_eq!(r.head_slot(pm, t_ours), Lookup::Missing, "forgotten with the pool");
    assert_eq!(r.head_slot(pm, w_ours), Lookup::Missing);
}

#[test]
fn v4_blind_far_fill_off_or_pool_not_ready_refuses_as_before() {
    // Setting off.
    let mut cfg = C2Config::for_tests();
    cfg.blind.far_fill = false;
    let (mut r, pm, ours) = blind_rig(cfg);
    let (pre, t_ours, _) = v4_far(ours, 600, 2);
    let core = r.h.c2.check_core();
    r.h.note_pm_pre(&core, &[MissItem::Slot(pm, t_ours)], &pre);
    r.h.fill(vec![MissItem::Slot(pm, t_ours)]);
    r.settle();
    assert_eq!(r.head_slot(pm, t_ours), Lookup::Missing);
    assert_eq!(counter(&r, "pm_refused_own_far"), 1);
    assert_eq!(counter(&r, "pm_far_sent"), 0);
    // On, but the pool isn't ready: refused (its load brings what it needs).
    let (mut r, pm, ours) = blind_rig(C2Config::for_tests());
    {
        let mut reg = r.h.c2.reg.write().unwrap();
        let e = reg.pools.get_mut(&(pm, Some(ours))).unwrap();
        e.state = PoolState::Unsure;
        e.retry_at = std::time::Instant::now() + std::time::Duration::from_secs(3600); // no reload during the test
    }
    let core = r.h.c2.check_core();
    r.h.note_pm_pre(&core, &[MissItem::Slot(pm, t_ours)], &pre);
    r.h.fill(vec![MissItem::Slot(pm, t_ours)]);
    r.settle();
    assert_eq!(r.head_slot(pm, t_ours), Lookup::Missing);
    assert_eq!(counter(&r, "pm_refused_own_far"), 1);
}

#[test]
fn v4_blind_autofollow_lists_a_pool_checks_keep_missing() {
    let mut cfg = C2Config::for_tests();
    cfg.blind.autofollow = true;
    cfg.blind.af_min_misses = 3;
    let (r, pm, _ours) = blind_rig(cfg);
    let theirs = B256::with_last_byte(0x77);
    let (pre, t, w) = v4_far(theirs, 5, 0);
    let core = r.h.c2.check_core();
    // Two values of the same pool in one check count once for that check.
    r.h.note_pm_pre(&core, &[MissItem::Slot(pm, t), MissItem::Slot(pm, w)], &pre);
    r.h.note_pm_pre(&core, &[MissItem::Slot(pm, t)], &pre);
    assert_eq!(r.h.status_json(false)["v4Blind"]["autoFollow"]["ids"], json!([]), "2 checks < 3");
    // Later checks without hash inputs (e.g. a plain eth_call check): the
    // slot was named before, so they count too.
    r.h.note_pm_pre(&core, &[MissItem::Slot(pm, t)], &[]);
    let st = r.h.status_json(false);
    assert_eq!(st["v4Blind"]["autoFollow"]["ids"], json!([format!("{theirs:#x}")]), "{}", st["v4Blind"]);
    assert_eq!(st["v4Blind"]["topUnfollowed"][0]["misses"], json!(3));
    assert_eq!(st["v4Blind"]["topUnfollowed"][0]["autoFollow"], json!(true));
}

/// A V4 key (5 words) and the pool id it hashes to.
fn v4_key(c1: u64, fee: u64, ts: u64, hooks: u64) -> ([U256; 5], B256) {
    let words = [U256::ZERO, U256::from(c1), U256::from(fee), U256::from(ts), U256::from(hooks)];
    (words, B256::from(arbsim::check::moved::key_hash(&words).to_be_bytes::<32>()))
}

/// AUTO-FOLLOW REBUILD (Oct 26): a check's miss carries the key of the
/// unfollowed pool it ran into (`missingKeys`). Copy 2 checks it (hash ==
/// id), keeps it, and puts it in status next to the listed id, so the bot
/// follows the pool with no node request.
#[test]
fn v4_blind_autofollow_hands_the_bot_the_key_seen_in_our_runs() {
    let mut cfg = C2Config::for_tests();
    cfg.blind.autofollow = true;
    cfg.blind.af_min_misses = 3;
    let (r, pm, _ours) = blind_rig(cfg);
    let (words, theirs) = v4_key(0xc2, 7800, 78, 0);
    let (pre, t, _) = v4_far(theirs, 5, 0);
    let core = r.h.c2.check_core();
    let keys = vec![(U256::from_be_bytes(theirs.0), words)];
    for _ in 0..3 {
        r.h.note_pm_pre_keys(&core, &[MissItem::Slot(pm, t)], &pre, &keys);
    }
    let st = r.h.status_json(false);
    let af = &st["v4Blind"]["autoFollow"];
    let id = format!("{theirs:#x}");
    assert_eq!(af["ids"], json!([id.clone()]), "{af}");
    assert_eq!(af["keys"][&id]["fee"], json!(7800), "{af}");
    assert_eq!(af["keys"][&id]["tickSpacing"], json!(78));
    assert_eq!(af["keys"][&id]["currency1"], json!(format!("{:#x}", Address::with_last_byte(0xc2))));
    assert_eq!(af["keys"][&id]["hooks"], json!(format!("{:#x}", Address::ZERO)));
    assert_eq!(af["keysLearned"], json!(1));
    assert_eq!(counter(&r, "pm_keys_learned"), 1, "learned once, not per check");
    assert_eq!(counter(&r, "pm_keys_bad"), 0);
}

#[test]
fn v4_blind_autofollow_refuses_a_key_that_does_not_hash_to_the_pool() {
    let mut cfg = C2Config::for_tests();
    cfg.blind.autofollow = true;
    cfg.blind.af_min_misses = 1;
    let (r, pm, _ours) = blind_rig(cfg);
    let (mut words, theirs) = v4_key(0xc2, 7800, 78, 0);
    words[2] = U256::from(3000u64); // not this pool's fee
    let (pre, t, _) = v4_far(theirs, 5, 0);
    let core = r.h.c2.check_core();
    r.h.note_pm_pre_keys(&core, &[MissItem::Slot(pm, t)], &pre, &[(U256::from_be_bytes(theirs.0), words)]);
    let st = r.h.status_json(false);
    let af = &st["v4Blind"]["autoFollow"];
    assert_eq!(af["ids"], json!([format!("{theirs:#x}")]), "still listed (the bot may find the key itself)");
    assert_eq!(af["keys"], json!({}), "no key handed out");
    assert_eq!(counter(&r, "pm_keys_bad"), 1);
    assert_eq!(counter(&r, "pm_keys_learned"), 0);
}

#[test]
fn v4_blind_autofollow_never_lists_a_pool_whose_key_has_a_hook() {
    let mut cfg = C2Config::for_tests();
    cfg.blind.autofollow = true;
    cfg.blind.af_min_misses = 1;
    let (r, pm, _ours) = blind_rig(cfg);
    let (words, hooked) = v4_key(0xc2, 3000, 60, 0xbeef);
    let (pre, t, _) = v4_far(hooked, 5, 0);
    let core = r.h.c2.check_core();
    for _ in 0..3 {
        r.h.note_pm_pre_keys(&core, &[MissItem::Slot(pm, t)], &pre, &[(U256::from_be_bytes(hooked.0), words)]);
    }
    let st = r.h.status_json(false);
    let af = &st["v4Blind"]["autoFollow"];
    assert_eq!(af["ids"], json!([]), "a hooked pool can't be followed: not listed, {af}");
    assert_eq!(af["hookedNotListed"], json!(1));
    assert_eq!(st["v4Blind"]["topUnfollowed"][0]["misses"], json!(3), "still counted as a blind spot");
}

#[test]
fn v4_blind_keys_not_learned_while_autofollow_is_off() {
    let (r, pm, _ours) = blind_rig(C2Config::for_tests());
    let (words, theirs) = v4_key(0xc2, 7800, 78, 0);
    let (pre, t, _) = v4_far(theirs, 5, 0);
    let core = r.h.c2.check_core();
    r.h.note_pm_pre_keys(&core, &[MissItem::Slot(pm, t)], &pre, &[(U256::from_be_bytes(theirs.0), words)]);
    let st = r.h.status_json(false);
    assert_eq!(counter(&r, "pm_keys_learned"), 0);
    assert_eq!(st["v4Blind"]["autoFollow"]["keysHeld"], json!(0));
    assert_eq!(counter(&r, "pm_miss_unfollowed"), 1, "the blind-spot count is unchanged");
}

// PACED FAR FILLS (Oct 25, live): far-tick fills used the node budget and
// starved pool loads after a restart. At most far_per_job far ticks per fill
// job; the rest are deferred (not refused) and go in a later job.
#[test]
fn v4_blind_far_fills_are_paced_per_job_and_deferred_not_refused() {
    let mut cfg = C2Config::for_tests();
    cfg.blind.far_per_job = 1;
    let (mut r, pm, ours) = blind_rig(cfg);
    let (pre, t_ours, w_ours) = v4_far(ours, 887_000, 3000);
    let mut s = r.chain.at(100);
    let m = s.entry(pm).or_default();
    m.insert(t_ours, u(0x1234));
    m.insert(w_ours, u(0x8000));
    r.chain.set(100, s);
    let missing = vec![MissItem::Slot(pm, t_ours), MissItem::Slot(pm, w_ours)];
    let core = r.h.c2.check_core();
    r.h.note_pm_pre(&core, &missing, &pre);
    // First fill: one far tick sent, the other deferred (not counted refused).
    r.h.fill(missing.clone());
    r.settle();
    assert_eq!(counter(&r, "pm_far_sent"), 1);
    assert_eq!(counter(&r, "pm_far_deferred"), 1);
    assert_eq!(counter(&r, "fill_refused_pm_slot"), 0);
    assert_eq!(counter(&r, "fill_refused"), 0, "a deferred value is not a refusal");
    // The check asks again: the other one goes now (gap 0 in tests).
    r.h.fill(missing);
    r.settle();
    assert_eq!(r.head_slot(pm, t_ours), Lookup::Known(u(0x1234)));
    assert_eq!(r.head_slot(pm, w_ours), Lookup::Known(u(0x8000)));
    assert_eq!(counter(&r, "pm_far_kept"), 2);
}

// ---------------------------------------------------------------------------
// FAST LANE A (copy2/ahead.rs): the predicted copy against copy 2's real
// intake. The feed message for block 102 (a "swap" writing the V2 pool's
// reserves) is predicted from the confirmed version 101; then copy 2 gets
// block 102's own reports and publishes 102. The prediction must agree,
// value for value, and the rebase must leave nothing predicted behind.
// ---------------------------------------------------------------------------
#[test]
fn fastlane_ahead_prediction_agrees_with_copy_2s_confirmed_block() {
    use arbsim::copy2::ahead::{Ahead, AheadCfg, Confirmed, PoolSet};
    // The V2 pool: 4-byte call = getter (slot 8); 32-byte call = "swap"
    // (writes the word into slot 8, the reserves word).
    let code = vec![0x36, 0x60, 0x20, 0x14, 0x60, 0x12, 0x57, 0x60, 0x08, 0x54, 0x60, 0x00, 0x52, 0x60, 0x20, 0x60, 0x00, 0xf3, 0x5b, 0x60, 0x00, 0x35, 0x60, 0x08, 0x55, 0x00];
    let (mut r, _ctx) = trig_world_code(code);
    let confirmed = |r: &Rig| {
        let v = r.sh.head().unwrap();
        let prov: Arc<dyn arbsim::check::ordered::Provenance + Send + Sync> = Arc::new(r.h.provenance_at(v.block, &[]));
        Confirmed { seq: v.seq, snap: v.snap.clone(), ctx: v.ctx.clone(), diff: v.diff.clone(), prov }
    };
    let fp = arbsim::check::moved::FollowedPool { key: format!("{:#x}", a(V2P)), address: a(V2P), v4_id: None };
    let mut ah = Ahead::new(AheadCfg::default());
    ah.set_pools(Arc::new(PoolSet::build(&[(fp, a(COIN0), a(COIN1))], Default::default())));
    ah.on_confirmed(confirmed(&r), &|_| None);
    assert_eq!(ah.base_seq(), Some(101));
    // Block 102 on the feed, same block time as 101 (62), so a V2 pair's
    // price accumulators don't move (this stand-in pool has none): the
    // swap leaves reserves 1200 / 3340.
    let word = u(1200) | (u(3340) << 112usize) | (u(62) << 224usize);
    let swap = signed(0, a(V2P), word.to_be_bytes::<32>().to_vec());
    let wm = arbsim::check::ordered::WireFeedMsg { seq: 102, ts: 62, l1: 9000, txs: vec![hexb(&swap)], complete: true, why: None };
    ah.on_feed_message(Arc::new(arbsim::check::feedstore::BinMsg::from_wire(&wm, true)));
    let t = ah.tip().expect("predicted 102");
    assert_eq!((t.block, t.changed_pools.clone()), (102, vec![format!("{:#x}", a(V2P))]));
    assert_eq!(t.view().storage(a(V2P), u(8)), Lookup::Known(word), "predicted BEFORE the reports arrive");
    // Now the block's reports (what the pool emitted) reach copy 2.
    r.send(msg(102, 62, vec![
        v2_sync(1200, 3340, 102, 1, 2),
        transfer(a(COIN0), a(USER), a(V2P), 100, 102, 1, 0),
        transfer(a(COIN1), a(V2P), a(USER), 300, 102, 1, 1),
        lg(a(V2P), vec![topics().v2_swap, topic_of(a(USER)), topic_of(a(USER))], data(&[u(100), u(0), u(0), u(300)]), 102, 1, 3),
    ]));
    assert_eq!(r.head_slot(a(V2P), u(8)), Lookup::Known(word));
    ah.on_confirmed(confirmed(&r), &|_| None);
    assert_eq!((ah.total.agree, ah.total.disagree, ah.total.unsure), (1, 0, 0), "{}", ah.total.json());
    assert_eq!((ah.base_seq(), ah.depth()), (Some(102), 0));
}

// ---------------------------------------------------------------------------
// FIRE-FIRST FROM RUST (Oct 27, fastlane/trigger.rs): a feed message reaches
// arbsim; Rust replays the trigger on copy 2's newest CONFIRMED version
// (block 101: block 102's pool reports never arrive in this test), picks the
// bot's table row for the moved pool, checks our trade, and hands the good
// answer straight to the fast lane's safety gates + gun. Proven here:
//   1. the would-send is signed and logged with the trigger's block, with
//      NO report for that block, NO receipt and NO request to copy 2's node;
//   2. practice NEVER broadcasts (a local send endpoint sees nothing);
//   3. live without RUST_SENDER: blocked by the one-sender rule, nothing sent;
//   4. a trigger is decided once (a repeat of the same tx is not re-fired);
//   5. the scoreboard's fire-first pause (Node's state "paused.trig") blocks it.
// ---------------------------------------------------------------------------

/// A local "send endpoint": counts every connection made to it (nothing may
/// ever connect in practice).
fn fl_endpoint() -> (String, Arc<std::sync::atomic::AtomicU64>) {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    let n = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let n2 = n.clone();
    std::thread::spawn(move || {
        for s in l.incoming() {
            if s.is_ok() {
                n2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        }
    });
    (url, n)
}

struct FlRead;
impl arbsim::fastlane::gun::rpc::ReadRpc for FlRead {
    fn call(&self, method: &str, _p: Value) -> Result<Value, String> {
        match method {
            "eth_getBlockByNumber" => Ok(json!({"number": "0x1f4", "baseFeePerGas": "0x989680"})),
            "eth_getTransactionCount" => Ok(json!("0x7")),
            "eth_call" => Ok(json!(format!("0x{:064x}{:064x}{:064x}", 20_000u64, 0, 0))),
            _ => Err("unsupported".into()),
        }
    }
}

/// Firing parts (the fast lane's) in a temp folder: `env` = FASTLANE etc.,
/// `paused_trig` = the scoreboard's fire-first pause in Node's state file.
fn fl_firer(tag: &str, env: &[(&str, &str)], paused_trig: Option<&str>) -> (arbsim::fastlane::lane::Firer, std::path::PathBuf, Arc<std::sync::atomic::AtomicU64>) {
    use arbsim::fastlane::bridge::{wall_ms, KillSwitch, NodeState, OwnMoney, SendsLog, StateReader};
    use arbsim::fastlane::lane::{reply_hook, FireCore, Firer, ReplyBook, SafetyGate};
    use arbsim::fastlane::safety::{utc_day, Safety, SafetyConfig};
    let dir = std::env::temp_dir().join(format!("fl-trig-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let (url, hits) = fl_endpoint();
    let mut m: HashMap<String, String> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    m.insert("KILL_FILE".into(), dir.join("KILL").to_string_lossy().into());
    m.insert("FASTLANE_STATE_FILE".into(), dir.join("fastlane-state.json").to_string_lossy().into());
    m.insert("FASTLANE_SENDS_FILE".into(), dir.join("fastlane-sends.jsonl").to_string_lossy().into());
    m.insert("ROBINHOOD_SEND_RPC".into(), url);
    m.insert("ARB_EXECUTOR_ROBINHOOD".into(), "0x00000000000000000000000000000000000000ee".into());
    m.insert("GAP_SENT_POOL_HOLD_MS".into(), "0".into());
    m.insert("FASTLANE_MAX_OPP_AGE_MS".into(), "5000".into());
    let now = wall_ms();
    let k = |x: Address| format!("{x:#x}");
    let mut st = NodeState {
        v: 1, written_ms: now, loss_day: utc_day(now),
        allowlist: vec![k(check_util::addr(1)), k(check_util::addr(2))],
        live_pools: vec![k(a(V2P)), k(check_util::addr(0x1002))],
        live_ready: true, rust_sender: false,
        approved_lenders: vec![k(check_util::addr(0x1e0))],
        own_money: OwnMoney { read_ms: now, balances: Default::default() },
        ..Default::default()
    };
    st.paused.trig = paused_trig.map(|s| s.to_string());
    std::fs::write(dir.join("fastlane-state.json"), serde_json::to_vec(&st).unwrap()).unwrap();
    let get = |key: &str| m.get(key).cloned();
    let safety = Safety::new(SafetyConfig::from_lookup(&get), arbsim::fastlane::mode::FastlaneMode::from_lookup(get), KillSwitch::from_lookup(&get), StateReader::from_lookup(&get));
    let gate = Arc::new(SafetyGate::new(&safety));
    let log = Arc::new(SendsLog::from_lookup(&get));
    let book = Arc::new(ReplyBook::default());
    let gun = Arc::new(arbsim::fastlane::gun::Gun::from_lookup(&get, gate.clone(), reply_hook(log.clone(), book.clone()), Some(Arc::new(FlRead))).unwrap().expect("FASTLANE on"));
    let t = std::time::Instant::now();
    while gun.not_ready().is_some() && t.elapsed() < std::time::Duration::from_secs(5) {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    (Firer { core: Arc::new(Mutex::new(FireCore { safety })), gate, gun, log, book }, dir, hits)
}

/// The bot's table row for "buy on V2P, sell on 0x1002" (flash loan from
/// 0x1e0, start coin addr(1), 6 decimals at $1): its check calls V2P itself,
/// whose code answers InsufficientProfit(slot 8) like our contract does.
fn fl_table_row() -> Value {
    use arbsim::fastlane::types::{encode_trade, DecodedTrade, FlashLender, Hop, KIND_V3};
    let ad = check_util::addr;
    let hop = |p: Address, i: u64, o: u64| Hop { kind: KIND_V3, pool: p, token_in: ad(i), token_out: ad(o), fee_bps: 0, v4_fee: 0, v4_tick_spacing: 0, v4_native: false };
    let data = encode_trade(&DecodedTrade { token: ad(1), amount_in: U256::from(400_000_000u64), min_profit: U256::MAX, max_block: U256::MAX, hops: vec![hop(a(V2P), 1, 2), hop(ad(0x1002), 2, 1)], flash: FlashLender::V3Flash(ad(0x1e0)) });
    let k = |x: Address| format!("{x:#x}");
    json!({
        "rid": format!("{}>{}:{}", k(a(V2P)), k(ad(0x1002)), k(ad(1))), "h": true, "s": 1.0, "e": "1.1",
        "c": {
            "calls": [{ "from": k(ad(0xb0751)), "to": k(a(V2P)), "gas": "0x7a1200", "data": hexb(&data) }],
            "overrides": {},
            "sizes": { "amountOffset": 96, "amounts": ["0x2faf080", "0x8f0d180"] },
            "route": [k(a(V2P)), k(ad(0x1002)), k(ad(0x1e0))],
            "stop": "0x30d40", "amt": "0x17d78400",
        },
        "f": { "l": "COIN/USDG test", "px": 1.0, "d": 6, "g": 0.05, "lp": 500 },
    })
}

/// V2P for the fast-lane tests: a 32-byte call STORES the word in slot 8
/// (the "swap"); any other call reverts with InsufficientProfit(reserve0,
/// MAX), reserve0 = the low 112 bits of slot 8 (our contract's answer, with
/// the "profit" read from the pool's own reserves).
fn fl_pool_code() -> Vec<u8> {
    check_util::hex("36 6020 14 6033 57 634e88422a 60e0 1b 6000 52 6008 54 6dffffffffffffffffffffffffffff 16 6004 52 6000 19 6024 52 6044 6000 fd 5b 6000 35 6008 55 00")
}

#[test]
fn fastlane_trigger_fires_from_rust_without_waiting_for_reports() {
    use arbsim::fastlane::lane::FiredWhat;
    use arbsim::fastlane::trigger::{TrigCfg, TrigOutcome, Trigger};
    let _turn = FEED_STORE_TURN.lock().unwrap_or_else(|e| e.into_inner());
    arbsim::check::feedstore::store().clear();
    let (r, ctx) = trig_world_code(fl_pool_code());
    assert_eq!(r.sh.head().unwrap().block, 101);
    // The bot's candidate table (what `trig_table` carries), V2P's routes.
    let k = format!("{:#x}", a(V2P));
    let ans = arbsim::check::entry::apply_table(&json!(1), &json!({"type": "trig_table", "gen": 1, "full": true, "codes": [], "pools": {k.clone(): [fl_table_row()]}}));
    assert_eq!(ans["ok"], json!(true), "{ans}");
    // The trigger: someone's "swap" leaves 2 USDG (2,000,000 units) of profit for our route.
    let swap = signed(0, a(V2P), u(2_000_000).to_be_bytes::<32>().to_vec());
    let put = |seq: u64, txs: &[&Vec<u8>]| {
        let m = json!({"seq": seq, "ts": 63, "l1": 9000, "txs": txs.iter().map(|t| hexb(t)).collect::<Vec<_>>()});
        arbsim::check::feedstore::store().put_json(&json!({"type": "feed_put", "msgs": [m]}));
        arbsim::check::feedstore::store().get(seq).unwrap()
    };
    let m102 = put(102, &[&swap]);
    let cfg = TrigCfg { max_lag_ms: 60_000, ..TrigCfg::default() };

    // 1 + 2. Practice: decided and signed in Rust; nothing broadcast.
    let (firer, dir, hits) = fl_firer("practice", &[("FASTLANE", "practice")], None);
    let mut t = Trigger::new(cfg.clone(), firer);
    t.to_practice = false;
    let node_before = *r.chain.calls.lock().unwrap() + *r.chain.paid_calls.lock().unwrap();
    let arrived = std::time::Instant::now();
    let out = t.on_message(&ctx, &m102, arrived);
    let node_after = *r.chain.calls.lock().unwrap() + *r.chain.paid_calls.lock().unwrap();
    assert_eq!(out.len(), 1, "{out:?}");
    let TrigOutcome::Fired(FiredWhat::Written { seq, hand_us }) = &out[0] else { panic!("{out:?} {}", t.hour.json()) };
    assert_eq!(node_before, node_after, "no node request on the way to the gun");
    assert_eq!(r.sh.head().unwrap().block, 101, "block 102's reports never came: copy 2 is still at 101");
    assert_eq!((t.hour.would_send, t.hour.live_sent, t.hour.routes_checked, t.hour.moved), (1, 0, 1, 1), "{}", t.hour.json());
    let rec: Value = serde_json::from_str(std::fs::read_to_string(dir.join("fastlane-sends.jsonl")).unwrap().lines().next().unwrap()).unwrap();
    assert_eq!((rec["mode"].clone(), rec["seq"].clone(), rec["block"].clone()), (json!("practice"), json!(*seq), json!(102)), "{rec}");
    assert_eq!(rec["amountIn"], json!("400000000"), "the answer's best size: {rec}");
    assert!((rec["expectedNetUsd"].as_f64().unwrap() - 1.95).abs() < 1e-9, "2 USDG profit - $0.05 gas: {rec}");
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0, "practice never connects to the send endpoint");
    println!("[test numbers only] feed message in arbsim -> signed bytes ready: {hand_us} us (decision {} us)", t.hour.decide_us[0]);

    // 4. The same trigger again (a reconnect's repeat): decided once.
    let out = t.on_message(&ctx, &m102, std::time::Instant::now());
    assert_eq!(out, vec![TrigOutcome::Repeat]);

    // 3. Live without RUST_SENDER: the one-sender rule blocks it; nothing sent.
    let (firer, _d, hits) = fl_firer("live-no-rs", &[("FASTLANE", "live"), ("EXECUTION_ENABLED", "true"), ("LIVE_SEND_CONFIRM", "yes-real-money")], None);
    let mut t = Trigger::new(cfg.clone(), firer);
    t.to_practice = false;
    let out = t.on_message(&ctx, &m102, std::time::Instant::now());
    assert_eq!(out, vec![TrigOutcome::Fired(FiredWhat::Blocked("node_is_sender"))], "{}", t.hour.json());
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0);

    // 5. Scoreboard paused fire-first (Node's state): blocked.
    let (firer, _d, _h) = fl_firer("paused", &[("FASTLANE", "practice")], Some("bucket trig_first paused (test)"));
    let mut t = Trigger::new(cfg.clone(), firer);
    t.to_practice = false;
    let out = t.on_message(&ctx, &m102, std::time::Instant::now());
    assert_eq!(out, vec![TrigOutcome::Fired(FiredWhat::Blocked("scoreboard"))], "{}", t.hour.json());

    // A swap leaving too little profit: checked, not good (no fire).
    let small = signed(1, a(V2P), u(1_000).to_be_bytes::<32>().to_vec());
    let m103 = put(103, &[&small]);
    let (firer, _d, _h) = fl_firer("small", &[("FASTLANE", "practice")], None);
    let mut t = Trigger::new(cfg.clone(), firer);
    let out = t.on_message(&ctx, &m103, std::time::Instant::now());
    assert_eq!(out, vec![TrigOutcome::NotGood], "{}", t.hour.json());
    // A plain transfer is skipped by the bot's quick test; a read moves nothing.
    let read = signed(2, a(V2P), vec![0x09, 0x02, 0xf1, 0xac]);
    let plain = signed(3, a(V2P), vec![]);
    let m104 = put(104, &[&plain, &read]);
    let out = t.on_message(&ctx, &m104, std::time::Instant::now());
    assert_eq!(out, vec![TrigOutcome::Skipped("plain_transfer"), TrigOutcome::NoPools], "{}", t.hour.json());
    arbsim::check::entry::clear_table();
    arbsim::check::feedstore::store().clear();
}

// FAST LANE SAFETY (Oct 29): a trade may only use pools copy 2 follows and
// holds ready (a pool it doesn't follow may hold an old one-time fill).
#[test]
fn fastlane_only_followed_ready_pools_may_fire() {
    let _turn = FEED_STORE_TURN.lock().unwrap_or_else(|e| e.into_inner());
    let (_r, ctx) = trig_world_code(fl_pool_code());
    let c2 = ctx.copy2.as_ref().unwrap();
    let ours = format!("{:#x}", a(V2P));
    assert_eq!(c2.unfollowed_pool(&[ours.clone()]), None, "the followed, ready pool");
    let other = "0xfae65eaa11943f45e83d5b45dc7a7c801c51bfb0".to_string();
    let why = c2.unfollowed_pool(&[ours.clone(), other]).expect("a pool copy 2 doesn't follow");
    assert!(why.contains("not followed"), "{why}");
    let id = format!("{:#066x}", 7u64);
    assert!(c2.unfollowed_pool(&[id]).is_some(), "an unknown V4 id");
    assert!(c2.unfollowed_pool(&["junk".into()]).is_some());
}

// DISCOVER FIRST (Oct 29): a message [a read that moves nothing, our
// pool's swap, a plain transfer]: the same outcomes, in message order, with
// discover-first on (default) and off; the swap's place in the message is
// recorded (linePos) and its wait in line is counted once.
#[test]
fn fastlane_trigger_discover_first_gives_the_same_outcomes_in_order() {
    use arbsim::fastlane::lane::FiredWhat;
    use arbsim::fastlane::trigger::{TrigCfg, TrigOutcome, Trigger};
    let _turn = FEED_STORE_TURN.lock().unwrap_or_else(|e| e.into_inner());
    arbsim::check::feedstore::store().clear();
    let (_r, ctx) = trig_world_code(fl_pool_code());
    let k = format!("{:#x}", a(V2P));
    let ans = arbsim::check::entry::apply_table(&json!(1), &json!({"type": "trig_table", "gen": 1, "full": true, "codes": [], "pools": {k.clone(): [fl_table_row()]}}));
    assert_eq!(ans["ok"], json!(true), "{ans}");
    let read = signed(0, a(V2P), vec![0x09, 0x02, 0xf1, 0xac]);
    let swap = signed(1, a(V2P), u(2_000_000).to_be_bytes::<32>().to_vec());
    let plain = signed(2, a(V2P), vec![]);
    let m = json!({"seq": 102, "ts": 63, "l1": 9000, "txs": [hexb(&read), hexb(&swap), hexb(&plain)]});
    arbsim::check::feedstore::store().put_json(&json!({"type": "feed_put", "msgs": [m]}));
    let m102 = arbsim::check::feedstore::store().get(102).unwrap();
    for first in [true, false] {
        let cfg = TrigCfg { max_lag_ms: 60_000, discover_first: first, ..TrigCfg::default() };
        let (firer, _d, _h) = fl_firer(if first { "df-on" } else { "df-off" }, &[("FASTLANE", "practice")], None);
        let mut t = Trigger::new(cfg, firer);
        t.to_practice = false;
        let out = t.on_message(&ctx, &m102, std::time::Instant::now());
        assert_eq!(out.len(), 3, "{out:?}");
        assert_eq!(out[0], TrigOutcome::NoPools, "discover_first {first}: {out:?}");
        assert!(matches!(out[1], TrigOutcome::Fired(FiredWhat::Written { .. })), "discover_first {first}: {out:?} {}", t.hour.json());
        assert_eq!(out[2], TrigOutcome::Skipped("plain_transfer"), "discover_first {first}: {out:?}");
        assert_eq!((t.hour.asked, t.hour.moved, t.hour.would_send), (2, 1, 1), "discover_first {first}: {}", t.hour.json());
        assert_eq!((t.hour.line_pos.clone(), t.hour.line_us.len(), t.hour.decide_us.len()), (vec![1], 1, 1), "discover_first {first}: {}", t.hour.json());
    }
    arbsim::check::entry::clear_table();
    arbsim::check::feedstore::store().clear();
}

// STANDING GAPS ON COPY 2 (Oct 27): with the predicted copy off (the new
// default) the fast lane scans the routes through the pools each NEW copy-2
// version moved, on that confirmed state, and fires the best through the same
// safety + gun. Block 101: our route earns 1,100 units ($0.0011, under the
// minimum): nothing. Block 102's reports leave reserve0 at 2,000,000 ($2):
// one practice would-send, nothing broadcast. The same version again: nothing.
#[test]
fn fastlane_lane_scans_copy_2s_confirmed_versions_when_the_predicted_copy_is_off() {
    use arbsim::fastlane::lane::{Lane, LaneCfg};
    use arbsim::fastlane::practice::{Practice, PracticeCfg};
    use arbsim::fastlane::scan::{ScanConfig, Scanner, TableSource};
    let (mut r, _ctx) = trig_world_code(fl_pool_code());
    let k = format!("{:#x}", a(V2P));
    let mut t = arbsim::check::entry::Table { gen: 1, ..Default::default() };
    t.pools.insert(k.clone(), arbsim::check::entry::parse_rows(&json!([fl_table_row()])).unwrap());
    let (firer, dir, hits) = fl_firer("lane", &[("FASTLANE", "practice")], None);
    let get = |key: &str| (key == "FASTLANE_PRACTICE_FILE").then(|| dir.join("practice.jsonl").to_string_lossy().to_string());
    let scanner = Scanner::new(ScanConfig { budget_us: 1_000_000, ..ScanConfig::default() }, Box::new(TableSource::owned(Arc::new(Mutex::new(t)))), Box::new(arbsim::fastlane::c2runner::Copy2Runner::new(r.h.clone())));
    let safety = std::sync::Arc::try_unwrap(firer.core).ok().unwrap().into_inner().unwrap().safety;
    let mut lane = Lane::new(LaneCfg { tip_max_age_ms: 5_000, ..LaneCfg::default() }, scanner, safety, firer.gate, firer.gun, firer.log, firer.book, Practice::new(PracticeCfg::from_lookup(&get), 0));
    let fired = lane.on_confirmed_version(&r.h);
    assert!(fired.is_empty(), "block 101: under the minimum: {fired:?}");
    assert_eq!(lane.hour.confirmed, 1);
    r.send(msg(102, 63, vec![
        v2_sync(2_000_000, 3340, 102, 1, 2),
        lg(a(V2P), vec![topics().v2_swap, topic_of(a(USER)), topic_of(a(USER))], data(&[u(100), u(0), u(0), u(300)]), 102, 1, 3),
    ]));
    assert_eq!(r.sh.head().unwrap().block, 102);
    let fired = lane.on_confirmed_version(&r.h);
    assert_eq!(fired.len(), 1, "{:?}", lane.status_json());
    let w = fired[0].written.as_ref().expect("written");
    assert_eq!((w.mode.as_str(), w.block), ("practice", 102));
    assert!(!fired[0].live);
    assert_eq!((lane.hour.would_send, lane.hour.live_sent), (1, 0));
    assert!(lane.on_confirmed_version(&r.h).is_empty(), "the same version is scanned once");
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0, "practice never connects to the send endpoint");
}

// ONE CHECK CORE PER BLOCK (Oct 30, fastlane/c2runner.rs): inside one
// block's scan the copy-2 runner asks copy 2 for its check core ONCE and
// every check of that block on the same state reuses it (live: ~20 core
// rebuilds a second, ~11 ms each, paid inside route checks). Same answers
// as a check that gets its own core; outside a scan each check asks again.
#[test]
fn fastlane_copy2_runner_shares_one_check_core_per_block() {
    use arbsim::fastlane::c2runner::{run_on_copy2, Copy2Runner};
    use arbsim::fastlane::scan::{amounts_for, CheckRunner, PreparedCheck, RunAt};
    let (r, _ctx) = trig_world_code(fl_pool_code());
    let head = r.sh.head().unwrap();
    let bctx = head.ctx.clone().unwrap();
    let pc = PreparedCheck::from_row(&fl_table_row()["c"], &[]).unwrap();
    let amounts = amounts_for(&pc, 0);
    let view = arbsim::state::snap::View::new(head.snap.clone());
    let at = RunAt { view: &view, ctx: &bctx, block: head.block, snap: Some(&head.snap) };
    let runner = Copy2Runner::new(r.h.clone());
    let own = run_on_copy2(&r.h, &head.snap, head.block, &bctx, &pc, &amounts);
    runner.begin_block();
    let a = runner.run_at(&at, &pc, &amounts);
    let b = runner.run_at(&at, &pc, &amounts);
    runner.end_block();
    assert_eq!(runner.core_asks(), 1, "one core for the block's checks");
    assert_eq!(a, own, "same answer as a check with its own core");
    assert_eq!(b, own);
    // Outside a scan: each check asks for its own (as before).
    let c = runner.run_at(&at, &pc, &amounts);
    assert_eq!(runner.core_asks(), 2);
    assert_eq!(c, own);
    // (Review) Inside one scan, a check on ANOTHER snapshot, or on the same
    // snapshot for another block, gets a new core (never the shared one).
    let snap2 = Arc::new((*head.snap).clone());
    let view2 = arbsim::state::snap::View::new(snap2.clone());
    let at2 = RunAt { view: &view2, ctx: &bctx, block: head.block, snap: Some(&snap2) };
    let at3 = RunAt { view: &view, ctx: &bctx, block: head.block + 1, snap: Some(&head.snap) };
    runner.begin_block();
    let _ = runner.run_at(&at, &pc, &amounts);
    assert_eq!(runner.core_asks(), 3);
    let _ = runner.run_at(&at2, &pc, &amounts);
    assert_eq!(runner.core_asks(), 4, "another snapshot: a new core");
    let _ = runner.run_at(&at3, &pc, &amounts);
    assert_eq!(runner.core_asks(), 5, "another block: a new core");
    // A scan that never said end_block: the next begin_block starts afresh
    // (no core carried over from the earlier block).
    runner.begin_block();
    let _ = runner.run_at(&at, &pc, &amounts);
    assert_eq!(runner.core_asks(), 6, "begin_block forgets the last block's core");
    let _ = runner.run_at(&at, &pc, &amounts);
    assert_eq!(runner.core_asks(), 6, "then shared again within the block");
    runner.end_block();
}

// FAST LANE FILLS (Oct 30, fastlane/c2runner.rs): a fast-lane check that
// misses a value copy 2 doesn't hold (here: a value of an outside contract;
// live: USDG's per-address flag, slot 6, of a pool only fast-lane routes
// use) asks copy 2 to fetch it, once per window. Until it is held the check
// answers "unknown" (never a guess); after the fill the same check runs
// through. The same miss right away is not asked again (repeat rule).
#[test]
fn fastlane_misses_ask_copy_2_to_fetch_the_value_once() {
    use arbsim::fastlane::c2runner::run_on_copy2;
    use arbsim::fastlane::scan::{amounts_for, PreparedCheck};
    let (mut r, _ctx) = trig_world_code(fl_pool_code());
    // The route's call goes to the outside contract (code: return
    // sload(first call-data word)): it reads a value nobody follows.
    let mut row = fl_table_row();
    row["c"]["calls"][0]["to"] = json!(format!("{:#x}", a(OUTSIDE)));
    let pc = PreparedCheck::from_row(&row["c"], &[]).unwrap();
    let amounts = amounts_for(&pc, 0);
    let first_word = U256::from_be_slice(&pc.call.data[..32]);
    let run = |r: &Rig| {
        let head = r.sh.head().unwrap();
        run_on_copy2(&r.h, &head.snap, head.block, &head.ctx.clone().unwrap(), &pc, &amounts)
    };
    let asked = |r: &Rig| r.h.c2.fastlane_fill.lock().unwrap().hour_used;
    assert_eq!(asked(&r), 0);
    let e = run(&r).expect_err("not held yet: unknown");
    assert_eq!(e.reason, arbsim::check::UnknownReason::Miss, "{e:?}");
    let n1 = asked(&r);
    assert!(n1 >= 1, "asked copy 2 to fetch what it missed");
    // The same miss again before the fill arrived: not asked twice.
    let _ = run(&r).expect_err("still not held");
    assert_eq!(asked(&r), n1, "repeat rule: the same values are not asked again");
    // Copy 2 fetches (its own fill rules); later versions hold the values.
    let mut through = false;
    for _ in 0..10 {
        r.settle();
        r.send(tick(r.sh.head().unwrap().block + 1, 70));
        match run(&r) {
            Err(e) if e.reason == arbsim::check::UnknownReason::Miss => continue,
            other => {
                assert!(other.is_ok(), "{other:?}");
                through = true;
                break;
            }
        }
    }
    assert!(through, "the fast lane's own fills never arrived");
    assert_eq!(r.head_slot(a(OUTSIDE), first_word), Lookup::Known(U256::ZERO), "the slot it read is held (the node's 0)");
    // What a miss stopped on is named in status (copy2Unknown.missTop).
    let top = arbsim::fastlane::c2runner::unknown_detail_json();
    assert!(top["missTop"].as_object().unwrap().keys().any(|k| k.starts_with(&format!("{:#x}", a(OUTSIDE)))), "{top}");
}

// FIRE-FIRST OFFLINE REPLAY (`arbsim trig-replay`, fastlane/trig_replay.rs):
// a recording in arrival order (copy-2 version 101, then feed message 102
// with the "swap", then copy 2's version 102 once its reports came) played
// through the Rust fire-first decision with no future information:
//   - message 102 is judged on version 101 (copy lag 1 block),
//   - discovery names V2P, the bot's table row is checked, the stop rule
//     accepts it: one trade would reach the gun,
//   - when version 102 arrives (later in the recording) the trade is
//     re-checked at the end of block 102: still profitable;
//   - without a table: discovery only (no candidates), same coverage.
#[test]
fn fastlane_trig_replay_plays_a_recording_in_arrival_order() {
    use arbsim::copy2::ahead::AheadCfg;
    use arbsim::copy2::ahead_capture::{CapEv, CapFile, ProvSets};
    use arbsim::fastlane::trig_replay::{print_report, trig_replay, TrigReplayOpts};
    use arbsim::fastlane::trigger::TrigCfg;
    let (mut r, _ctx) = trig_world_code(fl_pool_code());
    let version = |r: &Rig| {
        let v = r.sh.head().unwrap();
        CapEv::Confirmed { seq: v.seq, ctx: v.ctx.clone(), snap: v.snap.clone() }
    };
    let prov = |r: &Rig, b: u64| CapEv::Prov(Arc::new(ProvSets::from_copy2(&r.h.provenance_at(b, &[]))));
    let fp = arbsim::check::moved::FollowedPool { key: format!("{:#x}", a(V2P)), address: a(V2P), v4_id: None };
    let swap = signed(0, a(V2P), u(2_000_000).to_be_bytes::<32>().to_vec());
    let plain = signed(1, a(V2P), vec![]);
    let wm = arbsim::check::ordered::WireFeedMsg { seq: 102, ts: 62, l1: 9000, txs: vec![hexb(&plain), hexb(&swap)], complete: true, why: None };
    let mut events = vec![
        CapEv::Header { cfg: AheadCfg::default(), l2_offset: 0, live: "{}".into() },
        CapEv::Pools { list: vec![(fp, a(COIN0), a(COIN1))], not_ready: vec![] },
        prov(&r, 101),
        version(&r),
        CapEv::Feed(Arc::new(arbsim::check::feedstore::BinMsg::from_wire(&wm, true))),
    ];
    r.send(msg(102, 62, vec![
        v2_sync(2_000_000, 3340, 102, 1, 2),
        lg(a(V2P), vec![topics().v2_swap, topic_of(a(USER)), topic_of(a(USER))], data(&[u(100), u(0), u(0), u(300)]), 102, 1, 3),
    ]));
    events.push(prov(&r, 102));
    events.push(version(&r));
    events.push(CapEv::End { live: "{}".into(), why: "done".into() });
    let cap = CapFile { events, complete: true, cut: None };
    let table = arbsim::check::entry::table_from_messages(&[json!({"type": "trig_table", "gen": 1, "full": true, "codes": [], "pools": {format!("{:#x}", a(V2P)): [fl_table_row()]}})]).unwrap();
    let cfg = TrigCfg::default();
    let rep = trig_replay(&cap, Some(&table), &cfg, &TrigReplayOpts::default()).unwrap();
    println!("{}", print_report(&rep));
    assert_eq!(rep["copyLag"]["histogram"]["1"], json!(1), "{}", rep["copyLag"]);
    assert_eq!((rep["coverage"]["txs"].clone(), rep["coverage"]["skipped"]["plain_transfer"].clone(), rep["coverage"]["asked"].clone()), (json!(2), json!(1), json!(1)), "{}", rep["coverage"]);
    assert_eq!(rep["coverage"]["discovery"]["movedOurPools"], json!(1), "{}", rep["coverage"]);
    let k = &rep["candidates"];
    assert_eq!((k["routesChecked"].clone(), k["good"].clone(), k["wouldReachGun"].clone()), (json!(1), json!(1), json!(1)), "{k}");
    assert_eq!(k["recheckAtBlockEnd"]["stillProfitable"], json!(1), "{k}");
    assert!((rep["wouldFireSamples"][0]["netUsd"].as_f64().unwrap() - 1.95).abs() < 1e-9);
    // Without the table: discovery only.
    let rep = trig_replay(&cap, None, &cfg, &TrigReplayOpts::default()).unwrap();
    assert_eq!((rep["coverage"]["discovery"]["movedOurPools"].clone(), rep["candidates"]["routesChecked"].clone()), (json!(1), json!(0)));
}

// ---------------------------------------------------------------------------
// PREDICTION COVERAGE (Oct 27) through the fast lane's own trigger path.
// ---------------------------------------------------------------------------

/// anvil / hardhat test account #1 (public test key, no funds).
const TEST_KEY_B: [u8; 32] = [
    0x59, 0xc6, 0x99, 0x5e, 0x99, 0x8f, 0x97, 0xa5, 0xa0, 0x04, 0x49, 0x66, 0xf0, 0x94, 0x53, 0x89, 0xdc, 0x9e, 0x86,
    0xda, 0xe8, 0x8c, 0x7a, 0x84, 0x12, 0xf4, 0x60, 0x3b, 0x6b, 0x78, 0x69, 0x0d,
];

fn signed_b(nonce: u64, to: Address, data: Vec<u8>) -> Vec<u8> {
    check_util::sign_typed(&TEST_KEY_B, 2, &check_util::TestTx { nonce, gas: 200_000, to: Some(to), value: U256::ZERO, data, access_list: vec![] }, 4663)
}

// Copy 2 at block H. Feed: H+1 = someone's transfer on a coin-like contract
// that only ever writes its own storage (its holder's balance: not in our
// copy), H+2 = a swap leaving 2 USDG for our route. The trigger arrives
// while copy 2 is 2 blocks behind, so the check must replay H+1 first:
//   - proven skipping (FASTLANE_TRIG_SKIP default): H+1 is left out
//     (provably unrelated) and the trade reaches the gun (practice: signed,
//     never sent), answer "high";
//   - H+3 = a transaction to a contract our copy doesn't hold, H+4 = another
//     swap: that one could be anything (a bot trading on our pool) -> the
//     check is unknown, counted "check|lag|miss" with its target.
#[test]
fn fastlane_trigger_proven_skipping_through_the_server() {
    use arbsim::fastlane::lane::FiredWhat;
    use arbsim::fastlane::trigger::{TrigCfg, TrigOutcome, Trigger};
    let _turn = FEED_STORE_TURN.lock().unwrap_or_else(|e| e.into_inner());
    arbsim::check::feedstore::store().clear();
    let (mut r, ctx) = trig_world_code(fl_pool_code());
    let coin = check_util::addr(0x5ca1);
    r.chain.codes.lock().unwrap().insert(coin, check_util::hex("36 15 6010 57 6000 35 54 50 6007 6000 55 00 5b 6000 54 6000 52 6020 6000 f3"));
    // Copy 2 learns the coin's code the usual way: a check misses it, it is filled.
    let mut held = false;
    for _ in 0..20 {
        let ans = arbsim::server::handle(&ctx, &json!({"id": 3, "type": "call", "calls": [{"from": format!("{}", a(0xe0)), "to": format!("{coin:#x}"), "data": "0x", "gas": "0x100000"}]}));
        if ans["ok"] == json!(true) {
            held = true;
            break;
        }
        r.settle();
        r.send(tick(r.sh.head().unwrap().block + 1, 70));
    }
    assert!(held, "the fill never arrived");
    let h = r.sh.head().unwrap().block;
    let k = format!("{:#x}", a(V2P));
    let ans = arbsim::check::entry::apply_table(&json!(1), &json!({"type": "trig_table", "gen": 1, "full": true, "codes": [], "pools": {k.clone(): [fl_table_row()]}}));
    assert_eq!(ans["ok"], json!(true), "{ans}");
    let put = |seq: u64, txs: &[&Vec<u8>]| {
        let m = json!({"seq": seq, "ts": 90 + seq, "l1": 9000, "txs": txs.iter().map(|t| hexb(t)).collect::<Vec<_>>()});
        arbsim::check::feedstore::store().put_json(&json!({"type": "feed_put", "msgs": [m]}));
        arbsim::check::feedstore::store().get(seq).unwrap()
    };
    let unrelated = signed_b(0, coin, u(77).to_be_bytes::<32>().to_vec());
    let swap = signed(0, a(V2P), u(2_000_000).to_be_bytes::<32>().to_vec());
    put(h + 1, &[&unrelated]);
    let m2 = put(h + 2, &[&swap]);
    let cfg = TrigCfg { max_lag_ms: 60_000, ..TrigCfg::default() };
    assert!(cfg.proven_skip, "proven is the default");
    assert_eq!(cfg.feed_assume(), vec!["sender_funds".to_string(), "recent_fill".into(), "skip_proven".into()]);
    let (firer, _dir, hits) = fl_firer("proven", &[("FASTLANE", "practice")], None);
    let mut t = Trigger::new(cfg.clone(), firer);
    t.to_practice = false;
    let out = t.on_message(&ctx, &m2, std::time::Instant::now());
    assert!(matches!(out.as_slice(), [TrigOutcome::Fired(FiredWhat::Written { .. })]), "{out:?} {}", t.hour.json());
    assert_eq!((t.hour.answers_sure, t.hour.would_send), (1, 1), "{}", t.hour.json());
    // A transaction to a contract we don't hold, then another swap.
    let unknown_bot = signed_b(1, check_util::addr(0x7bad), u(1).to_be_bytes::<32>().to_vec());
    let swap2 = signed(1, a(V2P), u(2_000_000).to_be_bytes::<32>().to_vec());
    put(h + 3, &[&unknown_bot]);
    let m4 = put(h + 4, &[&swap2]);
    let out = t.on_message(&ctx, &m4, std::time::Instant::now());
    assert_eq!(out, vec![TrigOutcome::NotGood], "{}", t.hour.json());
    let st = t.hour.json();
    assert_eq!(st["unknownWhere"]["check|lag|miss"], json!(1), "{st}");
    let top = st["unknownTop"].to_string();
    assert!(top.contains("0x0000000000000000000000000000000000007bad"), "the blamed target is named: {top}");
    // FASTLANE_TRIG_SKIP=bot: the question asks for the bot's rules again
    // (their guess on such a transaction: tests/trig_first.rs
    // proven_skipping_never_skips_what_could_matter).
    let bot = TrigCfg::from_lookup(&|k| (k == "FASTLANE_TRIG_SKIP").then(|| "bot".to_string()));
    assert_eq!(bot.feed_assume(), vec!["sender_funds".to_string(), "recent_fill".into(), "skip".into()]);
    std::thread::sleep(std::time::Duration::from_millis(200));
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0, "practice never connects to the send endpoint");
    arbsim::check::entry::clear_table();
    arbsim::check::feedstore::store().clear();
}

// `arbsim trig-replay` COVERAGE DIAGNOSIS on a recording in arrival order:
// copy 2 at 101; feed 102 holds a transaction we can't unpack (blob type
// 3) and arrives before its reports; feed 103 holds the swap (copy 2 is 2
// blocks behind); copy 2's version 102 arrives later (with the chain's
// answer: the swap moved V2P). Asserted:
//   - discovery still names V2P (before Oct 27 the unreadable transaction
//     failed it: "unsupported_tx"), counted as one the old rule failed;
//   - the full replay a candidate check needs is unknown, blamed on a
//     LAG-replayed transaction of type 3 (and the candidate check too);
//   - "moved our pools" agrees with the chain; WITH NO LAG (on version
//     102) the answer is the same.
#[test]
fn fastlane_trig_replay_diagnoses_coverage() {
    use arbsim::copy2::ahead::AheadCfg;
    use arbsim::copy2::ahead_capture::{CapEv, CapFile, ProvSets};
    use arbsim::fastlane::trig_replay::{print_report, trig_replay, TrigReplayOpts};
    use arbsim::fastlane::trigger::TrigCfg;
    let (mut r, _ctx) = trig_world_code(fl_pool_code());
    let version = |r: &Rig| {
        let v = r.sh.head().unwrap();
        CapEv::Confirmed { seq: v.seq, ctx: v.ctx.clone(), snap: v.snap.clone() }
    };
    let prov = |r: &Rig, b: u64| CapEv::Prov(Arc::new(ProvSets::from_copy2(&r.h.provenance_at(b, &[]))));
    let fp = arbsim::check::moved::FollowedPool { key: format!("{:#x}", a(V2P)), address: a(V2P), v4_id: None };
    let swap = signed(0, a(V2P), u(2_000_000).to_be_bytes::<32>().to_vec());
    let blob = vec![0x03u8, 0xc0];
    let wm = |seq: u64, txs: &[&Vec<u8>]| arbsim::check::ordered::WireFeedMsg { seq, ts: 60 + seq, l1: 9000, txs: txs.iter().map(|t| hexb(t)).collect(), complete: true, why: None };
    let mut events = vec![
        CapEv::Header { cfg: AheadCfg::default(), l2_offset: 0, live: "{}".into() },
        CapEv::Pools { list: vec![(fp, a(COIN0), a(COIN1))], not_ready: vec![] },
        prov(&r, 101),
        version(&r),
        CapEv::Feed(Arc::new(arbsim::check::feedstore::BinMsg::from_wire(&wm(102, &[&blob]), true))),
        CapEv::Feed(Arc::new(arbsim::check::feedstore::BinMsg::from_wire(&wm(103, &[&swap]), true))),
    ];
    r.send(msg(102, 62, vec![v2_sync(1100, 3640, 102, 0, 0)]));
    events.push(CapEv::Moves(vec![(keccak256(&swap), Some(vec![format!("{:#x}", a(V2P))])), (keccak256(&blob), None)]));
    events.push(prov(&r, 102));
    events.push(version(&r));
    events.push(CapEv::End { live: "{}".into(), why: "done".into() });
    let cap = CapFile { events, complete: true, cut: None };
    let table = arbsim::check::entry::table_from_messages(&[json!({"type": "trig_table", "gen": 1, "full": true, "codes": [], "pools": {format!("{:#x}", a(V2P)): [fl_table_row()]}})]).unwrap();
    let rep = trig_replay(&cap, Some(&table), &TrigCfg::default(), &TrigReplayOpts::default()).unwrap();
    println!("{}", print_report(&rep));
    assert_eq!((rep["copyLag"]["histogram"]["1"].clone(), rep["copyLag"]["histogram"]["2"].clone()), (json!(1), json!(1)), "{}", rep["copyLag"]);
    assert_eq!(rep["copyLag"]["lagReplayedTxsPerTrigger"]["max"], json!(1));
    assert_eq!((rep["coverage"]["skipped"]["unreadable"].clone(), rep["coverage"]["asked"].clone()), (json!(1), json!(1)), "{}", rep["coverage"]);
    assert_eq!(rep["coverage"]["discovery"]["movedOurPools"], json!(1), "{}", rep["coverage"]);
    let g = &rep["diagnosis"];
    assert_eq!(g["unreadable"]["distinctTxs"], json!(1), "{g}");
    assert!(g["unreadable"]["byKind"].to_string().contains("first byte 0x03"), "{}", g["unreadable"]);
    assert_eq!(g["unreadable"]["triggersTheOldPlanRuleFailed"], json!(1));
    assert_eq!(g["movedOurPools"]["vsChain"]["chain: same pools"], json!(1), "{}", g["movedOurPools"]);
    let f = &g["fullReplay"];
    assert_eq!((f["asked"].clone(), f["noSkipping"]["answerable"].clone(), f["provenSkipping"]["answerable"].clone()), (json!(1), json!(0), json!(0)), "{f}");
    assert_eq!(f["noSkipping"]["unknown"]["where"]["lag|unsupported_tx"], json!(1), "{f}");
    assert_eq!(f["noSkipping"]["unknown"]["chainSaysBlamedTx"]["chain: moved none"], json!(1), "the blob moved none of our pools: {f}");
    assert_eq!(g["candidateUnknownWhere"]["lag|unsupported_tx|to -"], json!(1), "{g}");
    assert_eq!(rep["candidates"]["wouldReachGun"], json!(0));
    assert_eq!(g["withNoLag"]["compared"], json!(1), "{}", g["withNoLag"]);
    assert_eq!(g["withNoLag"]["outcome"]["same answer"], json!(1), "{}", g["withNoLag"]);
}

// `arbsim trig-replay --fetch` (fastlane/replay_fetch.rs): values the
// recording didn't hold are fetched (a fake node here) at the block of the
// copy version the question was asked on, and discovery asks again.
// Copy 2 at 101; feed 102 (lag 1) holds three transactions, none of whose
// target contracts copy 2 holds:
//   S  a self-only contract (only writes its own storage),
//   R  a router that forwards its data to our pool V2P (the chain says it
//      moved V2P),
//   W  a bot-style contract that reverts unless whitelist[sender] (a bool:
//      only the lowest byte counts) is set; our made-up "sender funds"
//      value reads as "no", the real one (1) says yes.
// Asserted: without fetching all three are unknown; with it R is "known:
// same pools", W "moved none (trigger ran)" with the real sender value, S
// "moved none"; nothing wrong; the free node answered everything (the paid
// node is never asked). With a cap of 3 calls only S's account is fetched:
// S stays unknown but its code is now known to be self-only, so the
// "doesn't touch us" rule would answer it (chain: moved none), and the
// other two are "not tried: cap reached".
#[test]
fn fastlane_trig_replay_fetch_asks_again_with_fetched_values() {
    use arbsim::copy2::ahead::AheadCfg;
    use arbsim::copy2::ahead_capture::{CapEv, CapFile, ProvSets};
    use arbsim::fastlane::replay_fetch::{FetchOpts, ReplayFetcher};
    use arbsim::fastlane::trig_replay::{print_report, trig_replay, trig_replay_with, TrigReplayOpts};
    use arbsim::fastlane::trigger::TrigCfg;
    let (r, _ctx) = trig_world_code(fl_pool_code());
    let v = r.sh.head().unwrap();
    let base_block = v.seq;
    let s_addr = check_util::addr(0x5e1f);
    let r_addr = check_util::addr(0x4077);
    let w_addr = check_util::addr(0x3b17);
    let s_code = check_util::hex("6001 6000 55 00");
    let mut r_code = check_util::hex("36 6000 6000 37 6000 6000 36 6000 6000 73");
    r_code.extend_from_slice(a(V2P).as_slice());
    r_code.extend(check_util::hex("5a f1 50 00"));
    let w_code = check_util::hex("33 6000 52 6000 6020 52 6040 6000 20 54 60ff 16 6019 57 6000 80 fd 5b 6001 6005 55 00");
    let sender_b = check_util::key_address(&TEST_KEY_B);
    let mut wl = [0u8; 64];
    wl[12..32].copy_from_slice(sender_b.as_slice());
    let wl_slot = U256::from_be_bytes(keccak256(wl).0);
    // The fake node: the three contracts' code, whitelist[sender] = 1,
    // everything else empty / zero. Counts calls; remembers the blocks asked.
    struct Fake {
        codes: HashMap<Address, Vec<u8>>,
        slots: HashMap<(Address, U256), U256>,
        calls: Mutex<(u64, Vec<String>)>,
    }
    impl NodeApi for Fake {
        fn call_batch(&self, _c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
            let mut g = self.calls.lock().unwrap();
            g.0 += calls.len() as u64;
            Ok(calls
                .iter()
                .map(|(m, p)| {
                    let addr = parse_address(p[0].as_str().unwrap()).unwrap();
                    let tag = p.as_array().unwrap().last().unwrap().as_str().unwrap().to_string();
                    if !g.1.contains(&tag) {
                        g.1.push(tag);
                    }
                    Ok(match *m {
                        "eth_getStorageAt" => {
                            let s = parse_u256(p[1].as_str().unwrap()).unwrap();
                            json!(format!("{:#x}", self.slots.get(&(addr, s)).copied().unwrap_or_default()))
                        }
                        "eth_getBalance" => json!("0x0"),
                        "eth_getTransactionCount" => json!(if self.codes.contains_key(&addr) { "0x1" } else { "0x0" }),
                        "eth_getCode" => json!(arbsim::check::hexutil::to_hex(self.codes.get(&addr).map(|c| c.as_slice()).unwrap_or(&[]))),
                        _ => return Err(RpcErr { code: -32601, message: "method not found".into() }),
                    })
                })
                .collect())
        }
    }
    let fake = || Fake {
        codes: [(s_addr, s_code.clone()), (r_addr, r_code.clone()), (w_addr, w_code.clone()), (a(V2P), fl_pool_code())].into_iter().collect(),
        slots: [((w_addr, wl_slot), U256::from(1u8))].into_iter().collect(),
        calls: Mutex::new((0, Vec::new())),
    };
    let fp = arbsim::check::moved::FollowedPool { key: format!("{:#x}", a(V2P)), address: a(V2P), v4_id: None };
    let tx_s = signed_b(5, s_addr, vec![0xde, 0xad, 0xbe, 0xef]);
    let tx_r = signed(0, r_addr, u(2_000_000).to_be_bytes::<32>().to_vec());
    let tx_w = signed_b(6, w_addr, vec![0x12, 0x34, 0x56, 0x78]);
    let wm = |seq: u64, txs: &[&Vec<u8>]| arbsim::check::ordered::WireFeedMsg { seq, ts: 60 + seq, l1: 9000, txs: txs.iter().map(|t| hexb(t)).collect(), complete: true, why: None };
    let events = vec![
        CapEv::Header { cfg: AheadCfg::default(), l2_offset: 0, live: "{}".into() },
        CapEv::Pools { list: vec![(fp, a(COIN0), a(COIN1))], not_ready: vec![] },
        CapEv::Prov(Arc::new(ProvSets::from_copy2(&r.h.provenance_at(base_block, &[])))),
        CapEv::Confirmed { seq: v.seq, ctx: v.ctx.clone(), snap: v.snap.clone() },
        CapEv::Feed(Arc::new(arbsim::check::feedstore::BinMsg::from_wire(&wm(base_block + 1, &[&tx_s, &tx_r, &tx_w]), true))),
        CapEv::Moves(vec![(keccak256(&tx_r), Some(vec![format!("{:#x}", a(V2P))])), (keccak256(&tx_s), None), (keccak256(&tx_w), None)]),
        CapEv::End { live: "{}".into(), why: "done".into() },
    ];
    let cap = CapFile { events, complete: true, cut: None };
    let cfg = TrigCfg::default();
    let opts = TrigReplayOpts { no_full: true, ..Default::default() };
    // Without fetching: all three unknown.
    let rep = trig_replay(&cap, None, &cfg, &opts).unwrap();
    assert_eq!(rep["coverage"]["asked"], json!(3), "{}", rep["coverage"]);
    assert_eq!(rep["coverage"]["discovery"]["unknown"]["miss"], json!(3), "{}", rep["coverage"]);
    assert!(rep["fetch"].is_null());
    // With fetching (free node only; the paid node would be a second fake).
    let paid = Box::new(fake());
    let mut f = ReplayFetcher::new(Some(Box::new(fake())), Some(paid), FetchOpts::default());
    let rep = trig_replay_with(&cap, None, &cfg, &opts, Some(&mut f)).unwrap();
    println!("{}", print_report(&rep));
    let x = &rep["fetch"];
    assert_eq!(x["tried"], json!(3), "{x}");
    assert_eq!(x["chainSaysMovedOurPools"]["known: same pools"], json!(1), "{x}");
    assert_eq!(x["chainSaysMovedNone"]["we say moved none"], json!(2), "{x}");
    assert!(x["wrongSamples"].as_array().unwrap().is_empty(), "{x}");
    assert_eq!(x["senderFundsRevertsWithRealValues"]["moved none (trigger ran)"], json!(1), "the real whitelist value lets W run: {x}");
    assert_eq!(x["beforeToAfter"]["unknown miss -> moved none (trigger ran)"], json!(2), "{x}");
    assert_eq!((x["requests"]["callsPaidNode"].clone(), x["stillUnknown"]["n"].clone()), (json!(0), json!(0)), "{x}");
    assert!(x["requests"]["callsFreeNode"].as_u64().unwrap() >= 9, "{x}");
    // The control (R, answered right) asked AT ITS OWN POSITION agrees.
    assert_eq!(x["controlAtItsOwnPosition"]["same pools as the chain"], json!(1), "{x}");
    // Every value was asked at the copy version's block, never "latest".
    let asked = f.json();
    assert_eq!(asked["valuesFailed"], json!(0), "{asked}");
    // A cap of 3 calls: only S's account (the first question).
    let mut g = ReplayFetcher::new(Some(Box::new(fake())), None, FetchOpts { max_calls: 3, max_paid: 0, ..Default::default() });
    let rep = trig_replay_with(&cap, None, &cfg, &opts, Some(&mut g)).unwrap();
    let x = &rep["fetch"];
    assert_eq!((x["tried"].clone(), x["notTriedCapReached"].clone()), (json!(1), json!(2)), "{x}");
    let so = &x["stillUnknownSelfOnly"];
    assert_eq!((so["ruleWouldAnswerMovedNone"].clone(), so["ofWhichChainSaysMoved"].clone()), (json!(1), json!(0)), "{so}");
    assert_eq!(rep["diagnosis"]["selfOnlyTargets"]["unknownTriggersByTargetCode"]["code not held"], json!(3), "{}", rep["diagnosis"]["selfOnlyTargets"]);
}

// DISCOVERY'S SELF-ONLY PROOF (ARBSIM_DISCOVER_SELF_ONLY=1, server.rs):
// a feed transaction to a contract whose code only writes its own storage
// provably moves none of our pools, whatever values we lack. Copy 2 holds
// the contract's code (fetched after the first miss) but not its storage:
// the question is "unknown: miss" with the proof off, "moved none"
// (conf high, "proven_no_touch") with it on. A contract that calls out
// (a router) stays unknown either way. The fill budget learns targets.
#[test]
fn trig_discover_self_only_target_proof() {
    let _turn = FEED_STORE_TURN.lock().unwrap_or_else(|e| e.into_inner());
    let (mut r, ctx) = trig_world_code(fl_pool_code());
    let s_addr = check_util::addr(0x5e1f);
    let r_addr = check_util::addr(0x4077);
    r.chain.codes.lock().unwrap().insert(s_addr, check_util::hex("6001 6000 55 00"));
    let mut rc = check_util::hex("36 6000 6000 37 6000 6000 36 6000 6000 73");
    rc.extend_from_slice(a(V2P).as_slice());
    rc.extend(check_util::hex("5a f1 50 00"));
    r.chain.codes.lock().unwrap().insert(r_addr, rc);
    let disc = |trig: &[u8], seq: u64| {
        arbsim::server::handle(&ctx, &json!({"id": 12, "type": "trig_discover", "at": {"after": "head"},
            "feed": {"trigger": hexb(keccak256(trig).as_slice()), "triggerSeq": seq, "msgs": [{"seq": seq, "ts": 63, "l1": 9000, "txs": [hexb(trig)]}]}}))
    };
    let h = r.sh.head().unwrap().block;
    let tx_s = signed_b(0, s_addr, vec![0xde, 0xad, 0xbe, 0xef]);
    let tx_r = signed_b(1, r_addr, u(5).to_be_bytes::<32>().to_vec());
    arbsim::server::set_discover_self_only(false);
    // First: the code itself is missing; DISCOVER LEARNS fetches it.
    for t in [&tx_s, &tx_r] {
        let ans = disc(t, h + 1);
        assert_eq!(ans["unknown"], json!("miss"), "{ans}");
    }
    r.settle();
    // With the proof on, ask until answered: once the code is held the
    // proof answers (storage is never missed, so never fetched: the first
    // answer is the proof's, with no race against a fill).
    arbsim::server::set_discover_self_only(true);
    let mut ans = Value::Null;
    for _ in 0..20 {
        ans = disc(&tx_s, h + 1);
        if ans["ok"] == json!(true) {
            break;
        }
        assert_eq!(ans["unknown"], json!("miss"), "{ans}");
        r.settle();
    }
    assert_eq!((ans["ok"].clone(), ans["pools"].clone(), ans["conf"].clone()), (json!(true), json!([]), json!("high")), "{ans}");
    assert_eq!(ans["assumed"], json!(["proven_no_touch"]), "{ans}");
    // With it off, the same question is a storage miss.
    arbsim::server::set_discover_self_only(false);
    let ans = disc(&tx_s, h + 1);
    assert_eq!(ans["unknown"], json!("miss"), "{ans}");
    assert!(ans["missing"].to_string().contains(&format!("{s_addr:#x}")), "{ans}");
    // The router: never proven, whatever the setting.
    arbsim::server::set_discover_self_only(true);
    let ans = disc(&tx_r, h + 1);
    assert!(ans["assumed"] != json!(["proven_no_touch"]), "a contract that calls out is never proven: {ans}");
    arbsim::server::set_discover_self_only(false);
    let st = arbsim::server::handle(&ctx, &json!({"id": 14, "type": "status"}));
    let d = &st["discoverFill"];
    assert!(d["targets"].as_u64().unwrap() >= 2, "{d}");
}

// trig-replay --fetch, round 3: a WRONG answer explained, and WARM COST.
// Copy 2 at H; the trigger (block H+2, copy 2 blocks behind) calls a router
// that forwards to our pool V2P only when its own flag (slot 0) is set. The
// flag is 0 at H and 1 at H+1 (a transaction in between set it: the copy
// lag). Fetched at the copy version's block (H) our answer is "moved none",
// the chain says it moved V2P: WRONG. Asked AT ITS OWN POSITION (every value
// fetched at the end of H+1) it moves V2P: same pools as the chain, and the
// flag is named as the value that differs. WARM COST counts the flag as a
// value that changes, and the router as a feed transaction's target.
#[test]
fn fastlane_trig_replay_fetch_explains_wrong_by_own_position() {
    use arbsim::copy2::ahead::AheadCfg;
    use arbsim::copy2::ahead_capture::{CapEv, CapFile, ProvSets};
    use arbsim::fastlane::replay_fetch::{FetchOpts, ReplayFetcher};
    use arbsim::fastlane::trig_replay::{print_report, trig_replay_with, TrigReplayOpts};
    use arbsim::fastlane::trigger::TrigCfg;
    let (r, _ctx) = trig_world_code(fl_pool_code());
    let v = r.sh.head().unwrap();
    let h = v.seq;
    let r2 = check_util::addr(0x4078);
    let mut code = check_util::hex("6000 54 6007 57 00 5b 36 6000 6000 37 6000 6000 36 6000 6000 73");
    code.extend_from_slice(a(V2P).as_slice());
    code.extend(check_util::hex("5a f1 50 00"));
    struct Fake {
        codes: HashMap<Address, Vec<u8>>,
        flag_from: String,
        flag_at: Address,
    }
    impl NodeApi for Fake {
        fn call_batch(&self, _c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
            Ok(calls
                .iter()
                .map(|(m, p)| {
                    let addr = parse_address(p[0].as_str().unwrap()).unwrap();
                    let tag = p.as_array().unwrap().last().unwrap().as_str().unwrap().to_string();
                    Ok(match *m {
                        "eth_getStorageAt" => {
                            let s = parse_u256(p[1].as_str().unwrap()).unwrap();
                            let set = addr == self.flag_at && s.is_zero() && tag == self.flag_from;
                            json!(if set { "0x1" } else { "0x0" })
                        }
                        "eth_getBalance" => json!("0x0"),
                        "eth_getTransactionCount" => json!(if self.codes.contains_key(&addr) { "0x1" } else { "0x0" }),
                        "eth_getCode" => json!(arbsim::check::hexutil::to_hex(self.codes.get(&addr).map(|c| c.as_slice()).unwrap_or(&[]))),
                        _ => return Err(RpcErr { code: -32601, message: "method not found".into() }),
                    })
                })
                .collect())
        }
    }
    let fake = Fake { codes: [(r2, code), (a(V2P), fl_pool_code())].into_iter().collect(), flag_from: format!("{:#x}", h + 1), flag_at: r2 };
    let fp = arbsim::check::moved::FollowedPool { key: format!("{:#x}", a(V2P)), address: a(V2P), v4_id: None };
    let trig = signed(0, r2, u(2_000_000).to_be_bytes::<32>().to_vec());
    let wm = |seq: u64, txs: &[&Vec<u8>]| arbsim::check::ordered::WireFeedMsg { seq, ts: 60 + seq, l1: 9000, txs: txs.iter().map(|t| hexb(t)).collect(), complete: true, why: None };
    let setter = signed_b(0, r2, vec![0x12, 0x34, 0x56, 0x78]);
    let events = vec![
        CapEv::Header { cfg: AheadCfg::default(), l2_offset: 0, live: "{}".into() },
        CapEv::Pools { list: vec![(fp, a(COIN0), a(COIN1))], not_ready: vec![] },
        CapEv::Prov(Arc::new(ProvSets::from_copy2(&r.h.provenance_at(h, &[])))),
        CapEv::Confirmed { seq: v.seq, ctx: v.ctx.clone(), snap: v.snap.clone() },
        CapEv::Feed(Arc::new(arbsim::check::feedstore::BinMsg::from_wire(&wm(h + 1, &[&setter]), true))),
        CapEv::Feed(Arc::new(arbsim::check::feedstore::BinMsg::from_wire(&wm(h + 2, &[&trig]), true))),
        CapEv::Moves(vec![(keccak256(&trig), Some(vec![format!("{:#x}", a(V2P))]))]),
        CapEv::End { live: "{}".into(), why: "done".into() },
    ];
    let cap = CapFile { events, complete: true, cut: None };
    let mut f = ReplayFetcher::new(Some(Box::new(fake)), None, FetchOpts { max_paid: 0, moved_only: true, ..Default::default() });
    let rep = trig_replay_with(&cap, None, &TrigCfg::default(), &TrigReplayOpts { no_full: true, ..Default::default() }, Some(&mut f)).unwrap();
    println!("{}", print_report(&rep));
    let x = &rep["fetch"];
    assert_eq!(x["chainSaysMovedOurPools"]["WRONG: we say moved none"], json!(1), "{x}");
    assert_eq!(x["wrongAtItsOwnPosition"]["same pools as the chain"], json!(1), "{x}");
    let w = &x["wrongSamples"][0];
    assert_eq!((w["copyLagBlocks"].clone(), w["earlierTxsInItsBlock"].clone()), (json!(2), json!(0)), "{w}");
    assert!(w["valuesDifferentAtItsOwnPosition"].to_string().contains("0x0 -> 0x1"), "the flag is named: {w}");
    let wc = &x["warmCost"];
    assert_eq!(wc["itemsThatChange"], json!(1), "{wc}");
    assert!(wc["topContracts"].to_string().contains("\"feedTxsToIt\":2"), "the setter and the trigger: {wc}");
    assert_eq!(wc["curve"][0]["triggersCovered"], json!(1), "{wc}");
    // The one covered trigger's flag had no earlier value: a warm copy
    // couldn't have held it with no fetch.
    assert_eq!(wc["curve"][0]["noFetchAtDecisionPct"]["strict"], json!(0.0), "{wc}");
}

// ---------------------------------------------------------------------------
// WARM HOT TARGETS (Oct 27, copy2/warm.rs) through the server.
// ---------------------------------------------------------------------------

/// A router that forwards its call data to our pool V2P only when its own
/// flag (slot 0) is set; on the chain the flag is 1. Copy 2 holds nothing
/// of it. Returns (rig, ctx, router, current block).
fn warm_world(cfg: Option<arbsim::copy2::warm::WarmCfg>) -> (Rig, arbsim::server::Ctx, Address, u64) {
    let (mut r, ctx) = trig_world_code(fl_pool_code());
    let r2 = check_util::addr(0x4079);
    let mut code = check_util::hex("6000 54 6007 57 00 5b 36 6000 6000 37 6000 6000 36 6000 6000 73");
    code.extend_from_slice(a(V2P).as_slice());
    code.extend(check_util::hex("5a f1 50 00"));
    r.chain.codes.lock().unwrap().insert(r2, code);
    let h = r.sh.head().unwrap().block;
    let mut st = r.chain.at(h);
    st.entry(r2).or_default().insert(u(0), u(1));
    r.chain.set(h, st);
    if let Some(c) = cfg {
        *r.h.c2.warm.lock().unwrap() = arbsim::copy2::warm::WarmState::new(c);
    }
    r.settle();
    (r, ctx, r2, h)
}

fn warm_disc(ctx: &arbsim::server::Ctx, msgs: &[(u64, Vec<&Vec<u8>>)], trig: &[u8]) -> Value {
    let seq = msgs.last().unwrap().0;
    let m: Vec<Value> = msgs.iter().map(|(s, txs)| json!({"seq": s, "ts": 63, "l1": 9000, "txs": txs.iter().map(|t| hexb(t)).collect::<Vec<_>>()})).collect();
    arbsim::server::handle(ctx, &json!({"id": 21, "type": "trig_discover", "at": {"after": "head"}, "feed": {"trigger": hexb(keccak256(trig).as_slice()), "triggerSeq": seq, "msgs": m}}))
}

fn node_calls(r: &Rig) -> usize {
    *r.chain.calls.lock().unwrap() + *r.chain.paid_calls.lock().unwrap()
}

// Learned from the first misses, fetched once in the background, then the
// hot router's trades are answered from memory: NO node call at decision
// time, "recent_fill" (never exact). A transaction to the router BEFORE
// the trigger in the same question leaves its values out (unknown); the
// keeper re-reads them after a feed transaction to it. Past
// ARBSIM_WARM_MAX_AGE_S a value counts as missing.
#[test]
fn warm_hot_target_answered_from_memory_refreshed_on_touch_never_stale() {
    use arbsim::copy2::warm::WarmCfg;
    let _turn = FEED_STORE_TURN.lock().unwrap_or_else(|e| e.into_inner());
    arbsim::check::feedstore::store().clear();
    let (mut r, ctx, r2, h) = warm_world(Some(WarmCfg { per_hour: 1000, ..WarmCfg::default() }));
    // The router is HOT: a report showed one of its trades moving our pools.
    r.h.c2.discover_fill.lock().unwrap().note_answer(r2, B256::ZERO, Some(true), std::time::Instant::now());
    r.settle();
    let trig = signed(0, r2, u(2_000_000).to_be_bytes::<32>().to_vec());
    let mut ans = Value::Null;
    for _ in 0..8 {
        ans = warm_disc(&ctx, &[(h + 1, vec![&trig])], &trig);
        if ans["ok"] == json!(true) {
            break;
        }
        assert_eq!(ans["unknown"], json!("miss"), "{ans}");
        r.settle();
    }
    assert_eq!(ans["pools"], json!([format!("{:#x}", a(V2P))]), "{ans}");
    // From memory: copy 2 itself still holds nothing of the router.
    assert!(matches!(r.sh.head().unwrap().snap.account(r2), Lookup::Missing), "the copy never took it in");
    let before = node_calls(&r);
    let ans = warm_disc(&ctx, &[(h + 1, vec![&trig])], &trig);
    assert_eq!((ans["ok"].clone(), ans["pools"].clone()), (json!(true), json!([format!("{:#x}", a(V2P))])), "{ans}");
    assert!(ans["assumed"].to_string().contains("recent_fill"), "never exact: {ans}");
    assert_eq!(node_calls(&r), before, "no node call at decision time");
    let st = arbsim::server::handle(&ctx, &json!({"id": 22, "type": "status"}));
    let w = &st["copy2"]["warm"];
    assert!(w["questionsUsedWarm"].as_u64().unwrap() >= 1 && w["fetchedOnce"].as_u64().unwrap() >= 2, "{w}");
    assert_eq!(w["on"], json!(true));
    // A transaction to the router BEFORE the trigger (same question): its
    // values (not stable yet) are left out.
    let toucher = signed_b(0, r2, vec![0x12, 0x34, 0x56, 0x78]);
    let ans = warm_disc(&ctx, &[(h + 1, vec![&toucher, &trig])], &trig);
    assert_eq!(ans["unknown"], json!("miss"), "{ans}");
    // The keeper sees that feed transaction and re-reads the router's values.
    arbsim::check::feedstore::store().put_json(&json!({"type": "feed_put", "msgs": [{"seq": h + 1, "ts": 63, "l1": 9000, "txs": [hexb(&toucher)]}]}));
    let calls0 = node_calls(&r);
    // The chain moves on to h+1 (the toucher's block); copy 2 follows.
    r.send(tick(h + 1, 64));
    r.settle();
    let w = r.h.c2.warm.lock().unwrap().json(r.h.c2.warm_now(), 0);
    assert!(w["refreshTouch"].as_u64().unwrap() >= 1, "{w}");
    assert!(node_calls(&r) > calls0, "re-read from the node");
    let ans = warm_disc(&ctx, &[(h + 2, vec![&trig])], &trig);
    assert_eq!(ans["ok"], json!(true), "after the re-read: {ans}");
    // Stale: past the window (shrunk for the test) it counts as missing.
    r.h.c2.warm.lock().unwrap().cfg.max_age_s = 0.05;
    std::thread::sleep(std::time::Duration::from_millis(120));
    let ans = warm_disc(&ctx, &[(h + 2, vec![&trig])], &trig);
    assert_eq!(ans["unknown"], json!("miss"), "never used stale: {ans}");
    arbsim::check::feedstore::store().clear();
}

// The hourly cap is hard: a fetch that doesn't fit is not sent and the
// values stay missing (unknown answers), never kept on trust.
#[test]
fn warm_cap_fails_closed() {
    use arbsim::copy2::warm::WarmCfg;
    let (mut r, ctx, r2, h) = warm_world(Some(WarmCfg { per_hour: 0, ..WarmCfg::default() }));
    r.h.c2.discover_fill.lock().unwrap().note_answer(r2, B256::ZERO, Some(true), std::time::Instant::now());
    r.settle();
    let trig = signed(0, r2, u(2_000_000).to_be_bytes::<32>().to_vec());
    let before = node_calls(&r);
    for _ in 0..3 {
        let ans = warm_disc(&ctx, &[(h + 1, vec![&trig])], &trig);
        assert_eq!(ans["unknown"], json!("miss"), "{ans}");
        r.settle();
    }
    assert_eq!(node_calls(&r), before, "nothing fetched over the cap (and the hot target isn't fetched by discovery's own fill either)");
    let w = r.h.c2.warm.lock().unwrap().json(r.h.c2.warm_now(), 0);
    assert!(w["capDropped"].as_u64().unwrap() >= 1 && w["calls"] == json!(0) && w["held"] == json!(0), "{w}");
}

// FASTLANE off (the tests' environment): nothing is learned, fetched or
// used; discovery behaves exactly as before (its own fill fetches the miss).
#[test]
fn warm_off_with_fastlane_off_changes_nothing() {
    let (mut r, ctx, r2, h) = warm_world(None);
    assert!(!r.h.c2.warm.lock().unwrap().on(), "FASTLANE is not set in tests");
    r.h.c2.discover_fill.lock().unwrap().note_answer(r2, B256::ZERO, Some(true), std::time::Instant::now());
    r.settle();
    let trig = signed(0, r2, u(2_000_000).to_be_bytes::<32>().to_vec());
    let ans = warm_disc(&ctx, &[(h + 1, vec![&trig])], &trig);
    assert_eq!(ans["unknown"], json!("miss"), "{ans}");
    let before = node_calls(&r);
    r.settle();
    assert!(node_calls(&r) > before, "discovery's own fill, as before");
    let w = r.h.c2.warm.lock().unwrap().json(r.h.c2.warm_now(), 0);
    assert_eq!((w["on"].clone(), w["learned"].clone(), w["values"].clone(), w["calls"].clone()), (json!(false), json!(0), json!(0), json!(0)), "{w}");
}

// `arbsim trig-replay --warm-sim N` (copy2/warm.rs over a recording): four
// trades through a router (the chain says each moved V2P). Trade 1 makes
// the router hot (after it); trade 2 misses (nothing learned yet) and
// teaches its recipe; the keeper fetches it at the next copy version;
// trades 3 and 4 are answered from warm values only, with the right pools,
// although each is itself a feed transaction to the router.
#[test]
fn fastlane_trig_replay_warm_sim() {
    use arbsim::copy2::ahead::AheadCfg;
    use arbsim::copy2::ahead_capture::{CapEv, CapFile, ProvSets};
    use arbsim::fastlane::replay_fetch::{FetchOpts, ReplayFetcher};
    use arbsim::fastlane::trig_replay::{print_report, trig_replay_with, TrigReplayOpts};
    use arbsim::fastlane::trigger::TrigCfg;
    let (mut r, _ctx) = trig_world_code(fl_pool_code());
    let v = r.sh.head().unwrap();
    let h = v.seq;
    let ro = check_util::addr(0x407a);
    let mut code = check_util::hex("36 6000 6000 37 6000 6000 36 6000 6000 73");
    code.extend_from_slice(a(V2P).as_slice());
    code.extend(check_util::hex("5a f1 50 00"));
    struct Fake {
        code: Vec<u8>,
        at: Address,
    }
    impl NodeApi for Fake {
        fn call_batch(&self, _c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
            Ok(calls
                .iter()
                .map(|(m, p)| {
                    let addr = parse_address(p[0].as_str().unwrap()).unwrap();
                    Ok(match *m {
                        "eth_getStorageAt" | "eth_getBalance" => json!("0x0"),
                        "eth_getTransactionCount" => json!(if addr == self.at { "0x1" } else { "0x0" }),
                        "eth_getCode" => json!(arbsim::check::hexutil::to_hex(if addr == self.at { &self.code } else { &[] })),
                        _ => return Err(RpcErr { code: -32601, message: "method not found".into() }),
                    })
                })
                .collect())
        }
    }
    let fp = arbsim::check::moved::FollowedPool { key: format!("{:#x}", a(V2P)), address: a(V2P), v4_id: None };
    let wm = |seq: u64, txs: &[&Vec<u8>]| arbsim::check::ordered::WireFeedMsg { seq, ts: 60 + seq, l1: 9000, txs: txs.iter().map(|t| hexb(t)).collect(), complete: true, why: None };
    let mut events = vec![
        CapEv::Header { cfg: AheadCfg::default(), l2_offset: 0, live: "{}".into() },
        CapEv::Pools { list: vec![(fp, a(COIN0), a(COIN1))], not_ready: vec![] },
        CapEv::Prov(Arc::new(ProvSets::from_copy2(&r.h.provenance_at(h, &[])))),
        CapEv::Confirmed { seq: h, ctx: v.ctx.clone(), snap: v.snap.clone() },
    ];
    for i in 1..=4u64 {
        let t = signed(i - 1, ro, u(2_000_000).to_be_bytes::<32>().to_vec());
        events.push(CapEv::Feed(Arc::new(arbsim::check::feedstore::BinMsg::from_wire(&wm(h + i, &[&t]), true))));
        events.push(CapEv::Moves(vec![(keccak256(&t), Some(vec![format!("{:#x}", a(V2P))]))]));
        r.send(tick(h + i, 70 + i));
        let vi = r.sh.head().unwrap();
        assert_eq!(vi.seq, h + i);
        events.push(CapEv::Confirmed { seq: vi.seq, ctx: vi.ctx.clone(), snap: vi.snap.clone() });
    }
    events.push(CapEv::End { live: "{}".into(), why: "done".into() });
    let cap = CapFile { events, complete: true, cut: None };
    let mut f = ReplayFetcher::new(Some(Box::new(Fake { code, at: ro })), None, FetchOpts { max_paid: 0, moved_only: true, ..Default::default() });
    let opts = TrigReplayOpts { no_full: true, warm_sim: Some(5), ..Default::default() };
    let rep = trig_replay_with(&cap, None, &TrigCfg::default(), &opts, Some(&mut f)).unwrap();
    println!("{}", print_report(&rep));
    let w = &rep["warmSim"];
    assert_eq!((w["triggersToHotTargets"].clone(), w["answeredWithNoFetch"].clone()), (json!(3), json!(2)), "{w}");
    assert_eq!(w["chainSaysMovedOurPools"]["known: same pools"], json!(2), "{w}");
    assert_eq!(w["chainSaysMovedOurPools"]["still unknown miss"], json!(1), "{w}");
    assert!(w["wrongSamples"].as_array().unwrap().is_empty(), "{w}");
    // One eth_getProof once, then one after each later trade TO the router
    // (its values aren't proven stable yet: re-read after every touch).
    assert_eq!((w["nodeRequests"].clone(), w["keeper"]["fetchedOnce"].clone(), w["keeper"]["refreshTouch"].clone()), (json!(3), json!(1), json!(2)), "{w}");
    // Without --fetch: refused.
    assert!(arbsim::fastlane::trig_replay::trig_replay(&cap, None, &TrigCfg::default(), &opts).is_err());
}
