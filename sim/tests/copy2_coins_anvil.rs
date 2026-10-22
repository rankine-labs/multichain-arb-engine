// ============================================================================
// COPY 2 INTAKE ON A PRACTICE CHAIN: coin balances and node refusals
// (dry run #16 problems), with a REAL Uniswap V3 pool.
//
// Plain English:
//   A private practice chain (anvil) plays "the node". Our intake follows a
//   real Uniswap V3 pool on it exactly like live: `track`, block messages
//   built from the chain's own logs, node questions answered by the chain.
//   A small gate in front of the chain lets the test hold a node answer
//   back, or answer "You've exceeded the RPS limit" like Chainstack did.
//
//   1. late_coin_transfer_while_a_load_waits_for_values_is_not_lost
//      The pool is loading; its replay of a swap needs more values (ticks)
//      and waits for the node. Meanwhile the swap's coin Transfers arrive
//      LATE (separate subscription). Before the fix they were dropped: the
//      waiting load had already passed their place and the copy didn't hold
//      the balance yet, so the pool became ready with a balance missing
//      exactly those transfers (0x52e65b17 in dry run #16: off by exactly
//      one Transfer made while pools were loading).
//   2. ready_pool_survives_a_short_rps_refusal_without_a_full_reload
//      A ready pool needs one more value for a swap while the node refuses
//      (-32005) for a few seconds. It must wait and retry, NOT restart its
//      whole load (which asks for everything it ever held again: the
//      request storm of dry run #16), and be exact afterwards.
//
//   Skipped (passes with a note) when anvil isn't installed.
// ============================================================================
mod copy2_util;

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use arbsim::copy2::intake::{manual, BlockMsg, C2Config, Copy2Handle, Intake, PoolState};
use arbsim::copy2::{PoolKind, PoolLog, TrackedPool};
use arbsim::node::{CallResult, Class, NodeApi, NodeErr, RpcErr};
use arbsim::state::fill::FillQueue;
use arbsim::state::mirror::{Config, Shared};
use arbsim::state::snap::Volatile;
use arbsim::state::{Lookup, StateRead};
use copy2_util::*;
use revm::primitives::{Address, B256, U256};
use serde_json::{json, Value};

fn q(n: u32) -> U256 {
    U256::from(10u8).pow(U256::from(n))
}

/// The practice chain as "the node", with a gate the test controls.
struct Gate {
    a: Arc<Anvil>,
    /// Hold load answers (batches with state reads AND eth_calls).
    hold_load: AtomicBool,
    /// Hold catch-up / need answers (state reads, no eth_call).
    hold_need: AtomicBool,
    /// Threads currently held at the gate.
    held: AtomicU32,
    /// Answer state reads with Chainstack's -32005 "RPS limit" item error.
    refuse: AtomicBool,
    /// HTTP-like requests that reached the chain / were refused.
    sent: AtomicU64,
    refused: AtomicU64,
}

impl Gate {
    fn wait_while(&self, f: &AtomicBool) {
        if !f.load(Ordering::SeqCst) {
            return;
        }
        self.held.fetch_add(1, Ordering::SeqCst);
        let t0 = Instant::now();
        while f.load(Ordering::SeqCst) && t0.elapsed() < Duration::from_secs(60) {
            std::thread::sleep(Duration::from_millis(2));
        }
        self.held.fetch_sub(1, Ordering::SeqCst);
    }
}

impl NodeApi for Gate {
    fn call_batch(&self, _c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        let state = calls.iter().any(|(m, _)| *m == "eth_getProof" || *m == "eth_getStorageAt");
        let call = calls.iter().any(|(m, _)| *m == "eth_call");
        if state && call {
            self.wait_while(&self.hold_load);
        } else if state {
            self.wait_while(&self.hold_need);
        }
        self.sent.fetch_add(1, Ordering::Relaxed);
        if state && self.refuse.load(Ordering::SeqCst) {
            self.refused.fetch_add(1, Ordering::Relaxed);
            return Ok(calls
                .iter()
                .map(|(m, p)| {
                    if *m == "eth_getProof" || *m == "eth_getStorageAt" {
                        Err(RpcErr { code: -32005, message: "You've exceeded the RPS limit available on the current plan.".into() })
                    } else {
                        one(&self.a, m, p)
                    }
                })
                .collect());
        }
        let reqs: Vec<(&str, Value)> = calls.iter().map(|(m, p)| (*m, p.clone())).collect();
        Ok(self
            .a
            .batch(&reqs)
            .into_iter()
            .map(|r| match r {
                Ok(v) => Ok(v),
                Err(e) => {
                    let v: Value = serde_json::from_str(&e).unwrap_or(json!({"code": -1, "message": e}));
                    Err(RpcErr { code: v["code"].as_i64().unwrap_or(-1), message: v["message"].as_str().unwrap_or("").to_string() })
                }
            })
            .collect())
    }
}

fn one(a: &Anvil, m: &str, p: &Value) -> CallResult {
    a.rpc(m, p.clone()).map_err(|e| RpcErr { code: -1, message: e })
}

struct World {
    a: Arc<Anvil>,
    gate: Arc<Gate>,
    sh: Arc<Shared>,
    intake: Intake,
    h: Copy2Handle,
    pool: TrackedPool,
    trader: Address,
    zfo_in_u: bool,
    ts: u64,
    last_sent: u64,
}

impl World {
    fn start() -> Option<World> {
        let a = Arc::new(Anvil::start()?);
        let arts = artifacts();
        let tok = art(&arts, "Token");
        let uu = a.deploy(&tok, &encode(&[Arg::D(b"USD".to_vec()), Arg::W(U256::from(6))]));
        let ww = a.deploy(&tok, &encode(&[Arg::D(b"WETH".to_vec()), Arg::W(U256::from(18))]));
        let trader = a.deploy(&art(&arts, "Trader"), &[]);
        for t in [uu, ww] {
            a.send_ok(t, &calldata("mint(address,uint256)", &[Arg::A(trader), Arg::W(q(36))]));
        }
        let f = a.deploy(&art(&arts, "UniswapV3Factory"), &[]);
        a.send_ok(f, &calldata("createPool(address,address,uint24)", &[Arg::A(uu), Arg::A(ww), Arg::W(U256::from(3000))]));
        let r = a.call(f, &calldata("getPool(address,address,uint24)", &[Arg::A(uu), Arg::A(ww), Arg::W(U256::from(3000))])).unwrap();
        let pool = Address::from_slice(&r[12..32]);
        a.send_ok(pool, &calldata("initialize(uint160)", &[Arg::W(sqrt_price_for(2500.0, uu, ww))]));
        let s0 = a.call(pool, &calldata("slot0()", &[])).unwrap();
        let tick = {
            let w = word(&s0, 1);
            let lo = w.as_limbs()[0] as i64;
            lo as i32 as i64
        };
        let b = tick.div_euclid(60) * 60;
        for k in 1..=14i64 {
            a.send_ok(trader, &calldata("mintV3(address,int24,int24,uint128)", &[Arg::A(pool), Arg::I((b - 60 * k * 6) as i128), Arg::I((b + 60 * k * 5) as i128), Arg::W(q(16) * U256::from(2u8))]));
        }
        let (t0, t1) = if uu < ww { (uu, ww) } else { (ww, uu) };
        let tp = TrackedPool { address: pool, v4_id: None, kind: PoolKind::V3, token0: t0, token1: t1, fee: 3000, tick_spacing: 60 };
        a.ok("evm_setAutomine", json!([false]));
        let ts = u64v(&a.ok("eth_getBlockByNumber", json!(["latest", false]))["timestamp"]);
        let gate = Arc::new(Gate {
            a: a.clone(),
            hold_load: AtomicBool::new(false),
            hold_need: AtomicBool::new(false),
            held: AtomicU32::new(0),
            refuse: AtomicBool::new(false),
            sent: AtomicU64::new(0),
            refused: AtomicU64::new(0),
        });
        let node: Arc<dyn NodeApi> = gate.clone();
        let sh = Shared::new(Config::for_tests(), Some(node), Arc::new(Volatile::default()));
        let (intake, h) = manual(sh.clone(), Arc::new(FillQueue::new(1000, 100)), C2Config::for_tests());
        // The coins' balance places (as the bot's balance-slots.json would).
        let mut slots = serde_json::Map::new();
        for c in [uu, ww] {
            let bal = word(&a.call(c, &calldata("balanceOf(address)", &[Arg::A(trader)])).unwrap(), 0);
            let n = (0..30u64).find(|n| u(&a.ok("eth_getStorageAt", json!([ha(c), hx64(map_slot(U256::from_be_slice(trader.as_slice()), U256::from(*n))), "latest"]))) == bal).expect("coin balance slot");
            slots.insert(ha(c), json!({"layout": "solidity", "slot": n}));
        }
        h.coin_slots_json(&json!(1), &json!({"type": "coin_slots", "coinSlots": slots}));
        let ans = h.track_json(&json!(2), &json!({"pools": [{"address": ha(pool), "kind": "v3", "token0": ha(t0), "token1": ha(t1), "fee": 3000, "tickSpacing": 60}]}));
        assert_eq!(ans["ok"], json!(true));
        let zfo_in_u = uu < ww;
        Some(World { a, gate, sh, intake, h, pool: tp, trader, zfo_in_u, ts, last_sent: 0 })
    }

    /// Mine one block with these transactions; returns its number.
    fn mine(&mut self, txs: &[(Address, Vec<u8>)]) -> u64 {
        let hs: Vec<B256> = txs.iter().map(|(to, d)| self.a.send(Some(*to), d).unwrap()).collect();
        self.ts += 2;
        self.a.ok("evm_setNextBlockTimestamp", json!([self.ts]));
        self.a.ok("evm_mine", json!([]));
        for h in hs {
            assert_eq!(self.a.receipt(h)["status"], "0x1", "practice transaction failed");
        }
        self.a.block_number()
    }

    /// A swap of `usd` dollars of the USD coin into the pool.
    fn swap_tx(&self, usd: u64) -> (Address, Vec<u8>) {
        (self.trader, calldata("swapV3(address,bool,int256,uint160)", &[Arg::A(self.pool.address), Arg::B(self.zfo_in_u), Arg::W(U256::from(usd) * q(6)), Arg::W(U256::ZERO)]))
    }

    /// The block's reports as the bot sends them: the pool's own logs and
    /// its coins' Transfers to / from it.
    fn reports(&self, n: u64) -> Vec<PoolLog> {
        let logs = self.a.ok("eth_getLogs", json!([{ "fromBlock": format!("{n:#x}"), "toBlock": format!("{n:#x}") }]));
        let p = self.pool.address;
        let side = |t: &B256| Address::from_slice(&t.as_slice()[12..]);
        logs.as_array()
            .unwrap()
            .iter()
            .map(to_pool_log)
            .filter(|l| {
                l.address == p
                    || ((l.address == self.pool.token0 || l.address == self.pool.token1)
                        && l.topics.len() == 3
                        && (side(&l.topics[1]) == p || side(&l.topics[2]) == p))
            })
            .collect()
    }

    fn msg(&mut self, n: u64, logs: Vec<PoolLog>) -> BlockMsg {
        let ts = u64v(&self.a.ok("eth_getBlockByNumber", json!([format!("{n:#x}"), false]))["timestamp"]);
        let prev = if self.last_sent > 0 && n > self.last_sent { Some(self.last_sent) } else { None };
        if n > self.last_sent {
            self.last_sent = n;
        }
        BlockMsg { block: n, timestamp: ts, l1_block: Some(n), base_fee: Some(0), prev_block: prev, tick: logs.is_empty(), logs }
    }

    fn send(&mut self, m: BlockMsg) {
        self.h.block(m);
        self.intake.pump();
    }

    fn wait(&mut self, what: &str, f: impl Fn(&World) -> bool) {
        let t0 = Instant::now();
        while !f(self) {
            self.intake.pump();
            assert!(t0.elapsed() < Duration::from_secs(30), "timed out waiting for: {what}; status {}", self.h.status_json(true));
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn settle(&mut self) {
        let t0 = Instant::now();
        loop {
            self.intake.pump();
            if self.intake.outstanding() == 0 {
                return;
            }
            assert!(t0.elapsed() < Duration::from_secs(30), "background work never finished: {}", self.h.status_json(true));
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn state(&self) -> (PoolState, String) {
        let reg = self.h.c2.reg.read().unwrap();
        let e = &reg.pools[&(self.pool.address, None)];
        (e.state, e.reason.clone())
    }

    fn loads(&self) -> u64 {
        self.h.c2.stats.loads.load(Ordering::Relaxed)
    }

    /// The chain's balanceOf(pool) for each coin at block n, vs the copy's head.
    fn balances(&self, n: u64) -> Vec<(Address, U256, Lookup<U256>)> {
        let head = self.sh.head().unwrap();
        let reg = self.h.c2.reg.read().unwrap();
        [self.pool.token0, self.pool.token1]
            .into_iter()
            .map(|c| {
                let r = self.a.ok("eth_call", json!([{"to": ha(c), "data": hb(&calldata("balanceOf(address)", &[Arg::A(self.pool.address)]))}, format!("{n:#x}")]));
                let truth = u(&r);
                let slot = reg.bal_slot(c, self.pool.address).expect("balance slot known");
                (c, truth, head.snap.storage(c, slot))
            })
            .collect()
    }
}

#[test]
fn late_coin_transfer_while_a_load_waits_for_values_is_not_lost() {
    let Some(mut w) = World::start() else {
        eprintln!("copy2 coins anvil test SKIPPED: no ~/.foundry/bin/anvil");
        return;
    };
    // The copy starts at block S; the pool's load is fetched at S and held.
    w.gate.hold_load.store(true, Ordering::SeqCst);
    w.gate.hold_need.store(true, Ordering::SeqCst);
    let s = w.a.block_number();
    let m = w.msg(s, vec![]);
    w.send(m);
    w.wait("the load to be asked", |w| w.gate.held.load(Ordering::SeqCst) == 1);
    // Block S+1: a swap. Its pool event arrives first; its coin Transfers
    // (another subscription) come later.
    let tx = w.swap_tx(400_000);
    let n = w.mine(&[tx]);
    let all = w.reports(n);
    let (pool_ev, transfers): (Vec<PoolLog>, Vec<PoolLog>) = all.into_iter().partition(|l| l.address == w.pool.address);
    assert_eq!(pool_ev.len(), 1, "one Swap event");
    assert_eq!(transfers.len(), 2, "two coin transfers");
    let m = w.msg(n, pool_ev);
    w.send(m);
    // The load answer comes back; carrying it forward, the swap's replay
    // needs ticks: the load waits for them (held at the gate).
    w.gate.hold_load.store(false, Ordering::SeqCst);
    w.wait("the load to wait for more values", |w| w.h.c2.stats.need_item_rounds.load(Ordering::SeqCst) >= 1 && w.gate.held.load(Ordering::SeqCst) == 1);
    assert_eq!(w.state().0, PoolState::Loading);
    // NOW the swap's coin transfers arrive (late, for an applied block).
    let m = w.msg(n, transfers);
    w.send(m);
    w.gate.hold_need.store(false, Ordering::SeqCst);
    w.settle();
    assert_eq!(w.state().0, PoolState::Ready, "{:?}", w.state());
    for (c, truth, copy) in w.balances(n) {
        assert!(copy == Lookup::Known(truth) || copy == Lookup::Missing, "coin {c}: copy {copy:?} vs chain {truth} (a wrong balance, not unknown)");
        assert_eq!(copy, Lookup::Known(truth), "coin {c}: the late transfer must be counted");
    }
}

#[test]
fn ready_pool_survives_a_short_rps_refusal_without_a_full_reload() {
    let Some(mut w) = World::start() else {
        eprintln!("copy2 coins anvil test SKIPPED: no ~/.foundry/bin/anvil");
        return;
    };
    let s = w.a.block_number();
    let m = w.msg(s, vec![]);
    w.send(m);
    w.settle();
    assert_eq!(w.state().0, PoolState::Ready, "{:?}", w.state());
    let loads_before = w.loads();
    // The provider starts refusing state reads; a swap needs new ticks.
    w.gate.refuse.store(true, Ordering::SeqCst);
    let sent0 = w.gate.sent.load(Ordering::Relaxed);
    let tx = w.swap_tx(400_000);
    let n = w.mine(&[tx]);
    let logs = w.reports(n);
    let m = w.msg(n, logs);
    w.send(m);
    assert_ne!(w.state().0, PoolState::Ready, "the swap needs values the copy doesn't hold");
    // ~4 s of refusals while blocks keep coming (4 per second).
    let t0 = Instant::now();
    while t0.elapsed() < Duration::from_secs(4) {
        let n = w.mine(&[]);
        let m = w.msg(n, vec![]);
        w.send(m);
        for _ in 0..25 {
            w.intake.pump();
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    let during = w.gate.sent.load(Ordering::Relaxed) - sent0;
    w.gate.refuse.store(false, Ordering::SeqCst);
    w.wait("the pool to be ready again", |w| w.state().0 == PoolState::Ready);
    w.settle();
    eprintln!("refusal test: {during} node requests during 4 s of refusals; loads {loads_before} -> {}", w.loads());
    assert_eq!(w.loads(), loads_before, "a short refusal restarted the pool's whole load (request storm)");
    assert!(during <= 20, "{during} node requests in 4 s while the node refused: retries must back off");
    // Exact afterwards: price, tick, liquidity and balances vs the chain.
    let last = w.a.block_number();
    let head = w.sh.head().unwrap();
    for sl in [0u64, 4] {
        let truth = u(&w.a.ok("eth_getStorageAt", json!([ha(w.pool.address), hx64(U256::from(sl)), format!("{last:#x}")])));
        assert_eq!(head.snap.storage(w.pool.address, U256::from(sl)), Lookup::Known(truth), "pool slot {sl}");
    }
    for (c, truth, copy) in w.balances(last) {
        assert_eq!(copy, Lookup::Known(truth), "coin {c}");
    }
    let _ = head.snap.position();
}

fn to_pool_log(l: &Value) -> PoolLog {
    PoolLog {
        address: arbsim::check::hexutil::parse_address(l["address"].as_str().unwrap()).unwrap(),
        topics: l["topics"].as_array().unwrap().iter().map(|t| B256::from(u(t).to_be_bytes::<32>())).collect(),
        data: arbsim::check::hexutil::parse_bytes(l["data"].as_str().unwrap()).unwrap(),
        block: u64v(&l["blockNumber"]),
        tx_index: u64v(&l["transactionIndex"]) as u32,
        log_index: u64v(&l["logIndex"]) as u32,
        tx_hash: B256::from(u(&l["transactionHash"]).to_be_bytes::<32>()),
        removed: l["removed"].as_bool().unwrap_or(false),
    }
}
