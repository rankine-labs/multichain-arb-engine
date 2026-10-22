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
    BlockMsg { block, timestamp: ts, l1_block: Some(9_000), base_fee: Some(10), prev_block: None, logs, tick: false }
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

#[test]
fn lost_message_reloads_everything() {
    let mut r = rig();
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
    // A late coin transfer BEFORE one already applied to that balance: not
    // exact -> that balance is forgotten (fetched again), the pool stays.
    let mut odd = vec![transfer(a(COIN0), a(USER), a(V2P), 1, 101, 1, 0)];
    odd.push(transfer(a(COIN0), a(USER), a(V2P), 100, 101, 3, 0));
    odd.push(transfer(a(COIN1), a(V2P), a(USER), 360, 101, 3, 1));
    odd.push(v2_sync(1100, 3640, 101, 3, 2));
    r.intake.process(msg(101, 62, odd));
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready);
    assert_eq!(r.head_slot(a(COIN0), map_slot(a(V2P), 0)), Lookup::Missing);
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
