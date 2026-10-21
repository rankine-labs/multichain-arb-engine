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
                    "eth_blockNumber" => Ok(json!("0x0")),
                    "eth_getBlockByNumber" => Ok(Value::Null),
                    "eth_getStorageAt" => {
                        let acct = parse_address(p[0].as_str().unwrap()).unwrap();
                        let s = parse_u256(p[1].as_str().unwrap()).unwrap();
                        Ok(json!(w(self.sload(blk(2), acct, s))))
                    }
                    "eth_getBalance" | "eth_getTransactionCount" => Ok(json!("0x0")),
                    "eth_getCode" => Ok(json!("0x")),
                    "eth_call" => {
                        let to = parse_address(p[0]["to"].as_str().unwrap()).unwrap();
                        let data: Bytes = parse_bytes(p[0]["data"].as_str().unwrap()).unwrap();
                        let b = blk(1);
                        // Balance-place probe (state override): our fake coins
                        // keep balances at Solidity mapping slot 0.
                        if let Some(ov) = p.get(2).and_then(|o| o.as_object()) {
                            let diff = ov.values().next().unwrap()["stateDiff"].as_object().unwrap();
                            let k = w(BalanceLayout { vyper: false, slot: 0 }.key(PROBE_HOLDER));
                            return Ok(diff.get(&k).cloned().unwrap_or(json!(w(U256::ZERO))));
                        }
                        let s = |n: u64| self.sload(b, to, U256::from(n));
                        let lie = if self.lying.lock().unwrap().contains(&to) { u(1) } else { U256::ZERO };
                        let f = &data[..4];
                        let words: Vec<U256> = if f == sel("balanceOf(address)") {
                            vec![self.sload(b, to, map_slot(Address::from_slice(&data[16..36]), 0))]
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
    let chain = Arc::new(FakeChain::default());
    chain.set(100, genesis());
    let node: Arc<dyn NodeApi> = chain.clone();
    let sh = Shared::new(Config::for_tests(), Some(node), Arc::new(Volatile::default()));
    let fills = Arc::new(FillQueue::new(1000, 100));
    let (intake, h) = manual(sh.clone(), fills, C2Config::for_tests());
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
    let m = msg(101, 61, vec![v2_sync(900, 4500, 101, 0, 0)]);
    r.intake.process(m.clone());
    r.intake.process(m); // same again: duplicate
    assert_eq!(r.state(&v2_pool()).0, PoolState::Ready);
    assert_eq!(r.h.status_json(false)["counters"]["duplicate_blocks"], json!(1));
    r.intake.process(msg(101, 61, vec![v2_sync(901, 4500, 101, 0, 1)])); // other reports
    assert_eq!(r.state(&v2_pool()).0, PoolState::Unsure);
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
    assert_eq!(layouts, vec![(a(2), BalanceLayout { vyper: false, slot: 3 })]);
}

#[test]
fn server_answers_track_and_status_in_pool_events_mode() {
    let chain = Arc::new(FakeChain::default());
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
    assert!(r.h.c2.stats.need_item_rounds.load(std::sync::atomic::Ordering::Relaxed) >= 1 || st == PoolState::Unsure, "{why}");
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
    let chain = Arc::new(FakeChain::default());
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
