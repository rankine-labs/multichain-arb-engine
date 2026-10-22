// ============================================================================
// COPY 2 WARM RESTART ON A PRACTICE CHAIN (copy2/persist.rs, intake.rs
// "warm restart").
//
// Plain English:
//   A private practice chain (anvil) plays "the node". Two copies follow the
//   same three pools (Uniswap V3 0.01 %, Uniswap V3 0.05 %, and a Uniswap V4
//   pool), both fed the bot's messages built from the chain's own logs:
//     A  never restarts;
//     B  is saved to a file at block S and stops; while it is "down" the
//        chain moves on with swaps, mints, burns, collects and plain coin
//        transfers; a NEW copy B2 reads the file and gets the bot's next
//        block with "gap: start" (exactly what the bot sends after a restart).
//   1. warm_restart_catches_up_exactly
//      B2 must catch up from the node's logs and then hold exactly what the
//      chain holds (and what A holds) for every pool value and coin balance
//      it follows, without loading any pool again. B's message for block S
//      lacked one coin Transfer (a late report that never came before the
//      save): the catch-up's overlap must find it.
//   2. damaged_or_other_version_file_means_a_normal_load
//   3. too_big_a_gap_means_a_normal_load
//   4. bot_restart_gap_is_filled_from_logs_without_reloading
//      The sidecar keeps running, the bot restarts (blocks missing, then
//      "gap: start"): no pool may be reloaded; the gap comes from the logs.
//      The free node refuses getLogs here: the paid node must answer.
//
//   Skipped (passes with a note) when anvil isn't installed.
// ============================================================================
mod copy2_util;

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

/// The practice chain as "the node": counts requests (free / paid path),
/// adds the parent-chain block number to headers (Nitro has it; anvil
/// doesn't; the test messages use l1Block = block number), and can make
/// the free path refuse eth_getLogs.
struct Gate {
    a: Arc<Anvil>,
    public: AtomicU64,
    paid: AtomicU64,
    logs_calls: AtomicU64,
    headers: AtomicU64,
    public_refuses_logs: AtomicBool,
}

impl Gate {
    fn run(&self, calls: &[(&str, Value)]) -> Vec<CallResult> {
        let reqs: Vec<(&str, Value)> = calls.iter().map(|(m, p)| (*m, p.clone())).collect();
        for (m, _) in calls {
            match *m {
                "eth_getLogs" => self.logs_calls.fetch_add(1, Ordering::Relaxed),
                "eth_getBlockByNumber" => self.headers.fetch_add(1, Ordering::Relaxed),
                _ => 0,
            };
        }
        self.a
            .batch(&reqs)
            .into_iter()
            .zip(calls)
            .map(|(r, (m, _))| match r {
                Ok(mut v) => {
                    if *m == "eth_getBlockByNumber" && v.is_object() {
                        let n = v["number"].clone();
                        v["l1BlockNumber"] = n;
                    }
                    Ok(v)
                }
                Err(e) => {
                    let v: Value = serde_json::from_str(&e).unwrap_or(json!({"code": -1, "message": e}));
                    Err(RpcErr { code: v["code"].as_i64().unwrap_or(-1), message: v["message"].as_str().unwrap_or("").to_string() })
                }
            })
            .collect()
    }
}

impl NodeApi for Gate {
    fn call_batch(&self, _c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        self.public.fetch_add(1, Ordering::Relaxed);
        if self.public_refuses_logs.load(Ordering::SeqCst) && calls.iter().any(|(m, _)| *m == "eth_getLogs") {
            return Ok(calls
                .iter()
                .map(|(m, p)| if *m == "eth_getLogs" { Err(RpcErr { code: -32005, message: "query returned more than 10000 results".into() }) } else { self.run(&[(m, p.clone())]).remove(0) })
                .collect());
        }
        Ok(self.run(calls))
    }
    fn call_batch_paid(&self, _c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        self.paid.fetch_add(1, Ordering::Relaxed);
        Ok(self.run(calls))
    }
}

/// One copy (its own mirror, intake and node counters).
struct Copy {
    gate: Arc<Gate>,
    sh: Arc<Shared>,
    intake: Intake,
    h: Copy2Handle,
}

struct Chain {
    a: Arc<Anvil>,
    pools: Vec<TrackedPool>,
    /// V3 trader (pays callbacks) and V4 trader.
    plain: Address,
    vt: Address,
    uu: Address,
    ww: Address,
    ts: u64,
    rng: Rng,
    /// Open positions: (pool index, lo, hi, liquidity).
    positions: Vec<(usize, i64, i64, U256)>,
}

fn tick_of(v: U256) -> i64 {
    let t = ((v >> 160usize) & U256::from(0xff_ffffu32)).to::<i64>();
    if t >= 1 << 23 {
        t - (1 << 24)
    } else {
        t
    }
}

impl Chain {
    fn start() -> Option<Chain> {
        let a = Arc::new(Anvil::start()?);
        let arts = artifacts();
        let tok = art(&arts, "Token");
        let uu = a.deploy(&tok, &encode(&[Arg::D(b"USD".to_vec()), Arg::W(U256::from(6))]));
        let ww = a.deploy(&tok, &encode(&[Arg::D(b"WETH".to_vec()), Arg::W(U256::from(18))]));
        let (t0, t1) = if uu < ww { (uu, ww) } else { (ww, uu) };
        let plain = a.deploy(&art(&arts, "Trader"), &[]);
        let pm = a.deploy(&art(&arts, "PoolManager"), &encode(&[Arg::A(a.me)]));
        let vt = a.deploy(&art(&arts, "V4Trader"), &encode(&[Arg::A(pm)]));
        for t in [uu, ww] {
            for who in [plain, vt, a.me] {
                a.send_ok(t, &calldata("mint(address,uint256)", &[Arg::A(who), Arg::W(q(36))]));
            }
        }
        let f = a.deploy(&art(&arts, "UniswapV3Factory"), &[]);
        a.send_ok(f, &calldata("enableFeeAmount(uint24,int24)", &[Arg::W(U256::from(100)), Arg::I(1)]));
        let v3pool = |fee: u32, price: f64| -> Address {
            a.send_ok(f, &calldata("createPool(address,address,uint24)", &[Arg::A(uu), Arg::A(ww), Arg::W(U256::from(fee))]));
            let r = a.call(f, &calldata("getPool(address,address,uint24)", &[Arg::A(uu), Arg::A(ww), Arg::W(U256::from(fee))])).unwrap();
            let p = Address::from_slice(&r[12..32]);
            a.send_ok(p, &calldata("initialize(uint160)", &[Arg::W(sqrt_price_for(price, uu, ww))]));
            p
        };
        let pa = v3pool(100, 2500.0);
        a.send_ok(pa, &calldata("increaseObservationCardinalityNext(uint16)", &[Arg::W(U256::from(30))]));
        let pb = v3pool(500, 2520.0);
        let mut v4 = TrackedPool { address: pm, v4_id: None, kind: PoolKind::V4, token0: t0, token1: t1, fee: 500, tick_spacing: 10 };
        v4.v4_id = Some(arbsim::copy2::replay::v4_pool_id(&v4));
        a.send_ok(pm, &calldata("initialize((address,address,uint24,int24,address),uint160)", &[Arg::A(t0), Arg::A(t1), Arg::W(U256::from(500)), Arg::I(10), Arg::A(Address::ZERO), Arg::W(sqrt_price_for(2510.0, uu, ww))]));
        let tr = |p: Address, fee: u32, sp: i32| TrackedPool { address: p, v4_id: None, kind: PoolKind::V3, token0: t0, token1: t1, fee, tick_spacing: sp };
        let mut c = Chain { a: a.clone(), pools: vec![tr(pa, 100, 1), tr(pb, 500, 10), v4], plain, vt, uu, ww, ts: 0, rng: Rng::new(7), positions: Vec::new() };
        // Liquidity in every pool (several ranges).
        for i in 0..3 {
            for k in 1..=6i64 {
                // Wide (up to ~+-20,000 ticks): random swaps never use up a
                // pool's liquidity (that walks to the price limit, beyond
                // any tick data: both copies would reload such a pool).
                let sp = c.spacing(i);
                let b = c.tick(i).div_euclid(sp) * sp;
                let w = 600 * k * k / sp * sp;
                let (lo, hi) = (b - w - sp * k, b + w);
                let liq = q(15) * U256::from(k as u64);
                let tx = c.mint_tx(i, lo, hi, liq);
                a.send_ok(tx.0, &tx.1);
                c.positions.push((i, lo, hi, liq));
            }
        }
        a.ok("evm_setAutomine", json!([false]));
        c.ts = u64v(&a.ok("eth_getBlockByNumber", json!(["latest", false]))["timestamp"]);
        Some(c)
    }

    fn spacing(&self, i: usize) -> i64 {
        self.pools[i].tick_spacing as i64
    }

    fn tick(&self, i: usize) -> i64 {
        let p = &self.pools[i];
        let (acct, s) = match p.v4_id {
            Some(id) => (p.address, map_slot(U256::from_be_bytes(id.0), U256::from(6))),
            None => (p.address, U256::ZERO),
        };
        tick_of(u(&self.a.ok("eth_getStorageAt", json!([ha(acct), hx64(s), "latest"]))))
    }

    fn key_args(&self, i: usize) -> Vec<Arg> {
        let p = &self.pools[i];
        vec![Arg::A(p.token0), Arg::A(p.token1), Arg::W(U256::from(p.fee)), Arg::I(p.tick_spacing as i128), Arg::A(Address::ZERO)]
    }

    fn mint_tx(&self, i: usize, lo: i64, hi: i64, liq: U256) -> (Address, Vec<u8>) {
        if self.pools[i].v4_id.is_some() {
            let mut a = self.key_args(i);
            a.extend([Arg::I(lo as i128), Arg::I(hi as i128), Arg::W(liq), Arg::W(U256::ZERO)]);
            (self.vt, calldata("modify((address,address,uint24,int24,address),int24,int24,int256,bytes32)", &a))
        } else {
            (self.plain, calldata("mintV3(address,int24,int24,uint128)", &[Arg::A(self.pools[i].address), Arg::I(lo as i128), Arg::I(hi as i128), Arg::W(liq)]))
        }
    }

    fn burn_tx(&self, i: usize, lo: i64, hi: i64, liq: U256, collect: bool) -> (Address, Vec<u8>) {
        if self.pools[i].v4_id.is_some() {
            let mut a = self.key_args(i);
            a.extend([Arg::I(lo as i128), Arg::I(hi as i128), Arg::W(U256::ZERO.wrapping_sub(liq)), Arg::W(U256::ZERO)]);
            (self.vt, calldata("modify((address,address,uint24,int24,address),int24,int24,int256,bytes32)", &a))
        } else {
            (self.plain, calldata("burnV3(address,int24,int24,uint128,bool)", &[Arg::A(self.pools[i].address), Arg::I(lo as i128), Arg::I(hi as i128), Arg::W(liq), Arg::B(collect)]))
        }
    }

    fn swap_tx(&self, i: usize, usd: u64, in_u: bool) -> (Address, Vec<u8>) {
        let amt = if in_u { U256::from(usd) * q(6) } else { U256::from(usd) * q(18) / U256::from(2500) };
        let zfo = in_u == (self.uu < self.ww);
        if self.pools[i].v4_id.is_some() {
            let mut a = self.key_args(i);
            a.extend([Arg::B(zfo), Arg::W(U256::ZERO.wrapping_sub(amt)), Arg::W(U256::ZERO)]);
            (self.vt, calldata("swap((address,address,uint24,int24,address),bool,int256,uint160)", &a))
        } else {
            (self.plain, calldata("swapV3(address,bool,int256,uint160)", &[Arg::A(self.pools[i].address), Arg::B(zfo), Arg::W(amt), Arg::W(U256::ZERO)]))
        }
    }

    /// A few random actions: swaps, mints, burns (with / without collect),
    /// collects, plain coin transfers into a pool.
    fn random_txs(&mut self) -> Vec<(Address, Vec<u8>)> {
        let n = self.rng.int(1, 3);
        let mut txs = Vec::new();
        for _ in 0..n {
            let i = self.rng.int(0, 2) as usize;
            let what = self.rng.int(0, 9);
            match what {
                0..=4 => {
                    let usd = self.rng.int(100, 10_000) as u64;
                    let in_u = self.rng.next() < 0.5;
                    txs.push(self.swap_tx(i, usd, in_u));
                }
                5 => {
                    let sp = self.spacing(i);
                    let b = self.tick(i).div_euclid(sp) * sp;
                    let st = sp.max(10);
                    let (lo, hi) = (b - st * self.rng.int(1, 300), b + st * self.rng.int(1, 300));
                    let liq = q(14) * U256::from(self.rng.int(1, 9) as u64);
                    txs.push(self.mint_tx(i, lo, hi, liq));
                    self.positions.push((i, lo, hi, liq));
                }
                6 | 7 => {
                    // Burn part of an open position of this pool.
                    if let Some(k) = self.positions.iter().position(|p| p.0 == i && p.3 > q(13)) {
                        let (pi, lo, hi, liq) = self.positions[k];
                        let part = liq / U256::from(3u8);
                        self.positions[k].3 = liq - part;
                        let collect = what == 7;
                        txs.push(self.burn_tx(pi, lo, hi, part, collect));
                    }
                }
                8 => {
                    // Collect fees of a V3 position (V4 collects through modify).
                    if let Some(p) = self.positions.iter().find(|p| p.0 == i && self.pools[i].v4_id.is_none()) {
                        txs.push((self.plain, calldata("collectV3(address,int24,int24)", &[Arg::A(self.pools[i].address), Arg::I(p.1 as i128), Arg::I(p.2 as i128)])));
                    }
                }
                _ => {
                    // A plain coin transfer into a V3 pool (only a Transfer).
                    let pool = self.pools[self.rng.int(0, 1) as usize].address;
                    let coin = if self.rng.next() < 0.5 { self.uu } else { self.ww };
                    txs.push((coin, calldata("transfer(address,uint256)", &[Arg::A(pool), Arg::W(U256::from(self.rng.int(1, 1_000_000) as u64))])));
                }
            }
        }
        txs
    }

    fn mine(&mut self, txs: &[(Address, Vec<u8>)]) -> u64 {
        let hs: Vec<B256> = txs.iter().map(|(to, d)| self.a.send(Some(*to), d).unwrap()).collect();
        self.ts += 2;
        self.a.ok("evm_setNextBlockTimestamp", json!([self.ts]));
        self.a.ok("evm_mine", json!([]));
        for h in hs {
            // Some random actions may revert (e.g. a collect with nothing
            // owed): fine, they just have no reports.
            let _ = self.a.receipt(h);
        }
        self.a.block_number()
    }

    /// The block's reports as the bot sends them (pool events; coin
    /// Transfers to / from CONTRACT pools, never the V4 PoolManager's).
    fn reports(&self, n: u64) -> Vec<PoolLog> {
        let logs = self.a.ok("eth_getLogs", json!([{ "fromBlock": format!("{n:#x}"), "toBlock": format!("{n:#x}") }]));
        let side = |t: &B256| Address::from_slice(&t.as_slice()[12..]);
        logs.as_array()
            .unwrap()
            .iter()
            .map(to_pool_log)
            .filter(|l| {
                self.pools.iter().any(|p| {
                    (p.v4_id.is_none() && l.address == p.address)
                        || (p.v4_id.is_some() && l.address == p.address && l.topics.get(1).is_some_and(|t| Some(*t) == p.v4_id))
                        || (p.v4_id.is_none()
                            && (l.address == p.token0 || l.address == p.token1)
                            && l.topics.len() == 3
                            && (side(&l.topics[1]) == p.address || side(&l.topics[2]) == p.address))
                })
            })
            .collect()
    }

    fn msg(&self, n: u64, logs: Vec<PoolLog>, prev: Option<u64>) -> BlockMsg {
        let ts = u64v(&self.a.ok("eth_getBlockByNumber", json!([format!("{n:#x}"), false]))["timestamp"]);
        BlockMsg { block: n, timestamp: ts, l1_block: Some(n), base_fee: Some(0), prev_block: prev, tick: logs.is_empty(), logs, gap_reason: None, bloom: None }
    }

    fn track_json(&self) -> Value {
        let list: Vec<Value> = self
            .pools
            .iter()
            .map(|p| json!({"address": ha(p.address), "kind": if p.v4_id.is_some() { "v4" } else { "v3" }, "token0": ha(p.token0), "token1": ha(p.token1), "fee": p.fee, "tickSpacing": p.tick_spacing, "v4Id": p.v4_id.map(|i| format!("{i}"))}))
            .collect();
        json!({ "pools": list })
    }

    /// A new copy (as the sidecar at start); `file` = the warm-restart file.
    fn copy(&self, file: Option<&str>, tweak: impl Fn(&mut C2Config)) -> Copy {
        let gate = Arc::new(Gate { a: self.a.clone(), public: AtomicU64::new(0), paid: AtomicU64::new(0), logs_calls: AtomicU64::new(0), headers: AtomicU64::new(0), public_refuses_logs: AtomicBool::new(false) });
        let node: Arc<dyn NodeApi> = gate.clone();
        let sh = Shared::new(Config::for_tests(), Some(node), Arc::new(Volatile::default()));
        let mut cfg = C2Config::for_tests();
        cfg.state_file = file.map(|s| s.to_string());
        tweak(&mut cfg);
        let (intake, h) = manual(sh.clone(), Arc::new(FillQueue::new(1000, 100)), cfg);
        Copy { gate, sh, intake, h }
    }

    /// What the bot does when it (re)connects: coin slots + track.
    fn connect(&self, c: &mut Copy) {
        let mut slots = serde_json::Map::new();
        for t in [self.uu, self.ww] {
            slots.insert(ha(t), json!({"layout": "solidity", "slot": 0}));
        }
        c.h.coin_slots_json(&json!(1), &json!({"type": "coin_slots", "coinSlots": slots}));
        let ans = c.h.track_json(&json!(2), &self.track_json());
        assert_eq!(ans["ok"], json!(true), "{ans}");
        c.intake.pump();
    }
}

impl Copy {
    fn send(&mut self, m: BlockMsg) {
        self.h.block(m);
        self.intake.pump();
    }

    fn wait(&mut self, what: &str, f: impl Fn(&Copy) -> bool) {
        let t0 = Instant::now();
        while !f(self) {
            self.intake.pump();
            assert!(t0.elapsed() < Duration::from_secs(60), "timed out waiting for: {what}; status {}", self.h.status_json(true));
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// Wait until every background job is done.
    fn settle(&mut self) {
        let t0 = Instant::now();
        loop {
            self.intake.pump();
            if self.intake.outstanding() == 0 && self.c("catchups") == self.c("catchups_done") + self.c("catchups_failed") {
                // Twice in a row (an answer may be on its way).
                std::thread::sleep(Duration::from_millis(20));
                self.intake.pump();
                if self.intake.outstanding() == 0 {
                    return;
                }
            }
            assert!(t0.elapsed() < Duration::from_secs(90), "background work never finished: {}", self.h.status_json(true));
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn c(&self, name: &str) -> u64 {
        self.h.status_json(false)["counters"][name].as_u64().unwrap_or(0)
    }

    fn states(&self) -> Vec<(Address, PoolState, String)> {
        let reg = self.h.c2.reg.read().unwrap();
        let mut v: Vec<_> = reg.pools.values().map(|e| (e.pool.address, e.state, e.reason.clone())).collect();
        v.sort_by_key(|x| x.0);
        v
    }

    fn all_ready(&self) -> bool {
        let reg = self.h.c2.reg.read().unwrap();
        !reg.pools.is_empty() && reg.pools.values().all(|e| e.state == PoolState::Ready)
    }

    fn walked_all(&self) -> bool {
        let reg = self.h.c2.reg.read().unwrap();
        reg.pools.values().all(|e| e.walk.as_ref().is_some_and(|w| w.done))
    }
}

/// Every value `c` holds for the pools (their own slots, walked tick data)
/// and the contract pools' coin balances, compared with the chain at the
/// copy's head block. Returns how many values were compared.
fn exact_vs_chain(ch: &Chain, c: &Copy, label: &str) -> usize {
    let head = c.sh.head().unwrap();
    let n = head.block;
    let reg = c.h.c2.reg.read().unwrap();
    let mut held: Vec<(Address, U256)> = Vec::new();
    for e in reg.pools.values() {
        assert_eq!(e.state, PoolState::Ready, "{label}: pool {} is {:?} ({})", e.pool.address, e.state, e.reason);
        held.extend(e.items.iter().copied());
        held.extend(e.walked.iter().copied());
        if e.pool.v4_id.is_none() {
            for t in [e.pool.token0, e.pool.token1] {
                held.push((t, reg.bal_slot(t, e.pool.address).expect("balance slot")));
            }
        }
    }
    drop(reg);
    held.sort();
    held.dedup();
    let mut compared = 0;
    let mut missing = 0;
    for (a, s) in &held {
        match head.snap.storage(*a, *s) {
            Lookup::Known(v) => {
                let truth = u(&ch.a.ok("eth_getStorageAt", json!([ha(*a), hx64(*s), format!("{n:#x}")])));
                assert_eq!(v, truth, "{label}: {a} slot {s:#x} at block {n}: copy {v:#x}, chain {truth:#x}");
                compared += 1;
            }
            Lookup::Missing => missing += 1,
        }
    }
    eprintln!("{label}: {compared} values exact at block {n} ({missing} not held)");
    compared
}

/// Held values of A (the never-restarted copy) that B2 doesn't hold, and
/// values both hold that differ (must be none).
fn same_as(a: &Copy, b: &Copy, label: &str) {
    let (ha_, hb_) = (a.sh.head().unwrap(), b.sh.head().unwrap());
    assert_eq!(ha_.block, hb_.block, "{label}: both copies at the same block");
    let reg = a.h.c2.reg.read().unwrap();
    let mut keys: Vec<(Address, U256)> = Vec::new();
    for e in reg.pools.values() {
        keys.extend(e.items.iter().copied());
        if e.pool.v4_id.is_none() {
            for t in [e.pool.token0, e.pool.token1] {
                keys.push((t, reg.bal_slot(t, e.pool.address).unwrap()));
            }
        }
    }
    drop(reg);
    let mut lacking = 0;
    for (acct, s) in &keys {
        match (ha_.snap.storage(*acct, *s), hb_.snap.storage(*acct, *s)) {
            (Lookup::Known(x), Lookup::Known(y)) => assert_eq!(x, y, "{label}: {acct} slot {s:#x}: never-restarted {x:#x}, restarted {y:#x}"),
            (Lookup::Known(_), Lookup::Missing) => lacking += 1,
            _ => {}
        }
    }
    assert_eq!(lacking, 0, "{label}: the restarted copy lacks {lacking} value(s) the never-restarted copy holds");
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

fn state_path(name: &str) -> String {
    let d = std::env::temp_dir().join(format!("arbsim-resume-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d.join("arbsim-copy2-state.bin").to_str().unwrap().to_string()
}

/// Start a chain and a copy that follows it to READY (+ walked); `blocks`
/// blocks of random activity sent to every copy in `copies`.
fn run_blocks(ch: &mut Chain, copies: &mut [&mut Copy], blocks: usize, last: &mut u64) {
    for _ in 0..blocks {
        let txs = ch.random_txs();
        let n = ch.mine(&txs);
        let logs = ch.reports(n);
        for c in copies.iter_mut() {
            let prev = if *last > 0 { Some(*last) } else { None };
            c.send(ch.msg(n, logs.clone(), prev));
        }
        *last = n;
    }
}

#[test]
fn warm_restart_catches_up_exactly() {
    let Some(mut ch) = Chain::start() else {
        eprintln!("copy2 resume anvil test SKIPPED: no ~/.foundry/bin/anvil");
        return;
    };
    let path = state_path("exact");
    let mut a = ch.copy(None, |_| {});
    let mut b = ch.copy(Some(&path), |_| {});
    ch.connect(&mut a);
    ch.connect(&mut b);
    // First block: both copies start; pools load and get walked.
    let mut last = 0u64;
    run_blocks(&mut ch, &mut [&mut a, &mut b], 1, &mut last);
    for c in [&mut a, &mut b] {
        c.wait("every pool ready and walked", |c| c.all_ready() && c.walked_all());
        c.settle();
    }
    run_blocks(&mut ch, &mut [&mut a, &mut b], 12, &mut last);
    a.settle();
    b.settle();
    // Block S: a swap on the V3 pool; B gets it WITHOUT one coin Transfer
    // (a late report that hadn't come before the save).
    let tx = ch.swap_tx(0, 8_000, true);
    let s = ch.mine(&[tx]);
    let logs = ch.reports(s);
    let xfer = logs.iter().position(|l| l.address == ch.uu || l.address == ch.ww).expect("a coin transfer");
    let mut short = logs.clone();
    short.remove(xfer);
    a.send(ch.msg(s, logs, Some(last)));
    b.send(ch.msg(s, short, Some(last)));
    last = s;
    let rep = b.intake.save_now().expect("saved");
    eprintln!("saved: {rep:?}");
    assert_eq!(rep.block, s);
    assert_eq!(rep.pools, 3, "every ready pool saved");
    drop(b);
    // The sidecar is down: the chain moves on (A follows).
    run_blocks(&mut ch, &mut [&mut a], 25, &mut last);
    // A new sidecar reads the file.
    let mut b2 = ch.copy(Some(&path), |_| {});
    assert_eq!(b2.c("resume_pools"), 3);
    assert!(b2.all_ready(), "restored pools are ready (waiting for the catch-up): {:?}", b2.states());
    ch.connect(&mut b2);
    // The bot's next block, with "gap: start" (prevBlock = itself).
    let txs = ch.random_txs();
    let n = ch.mine(&txs);
    let logs = ch.reports(n);
    a.send(ch.msg(n, logs.clone(), Some(last)));
    let mut m = ch.msg(n, logs, Some(n));
    m.gap_reason = Some("start".into());
    b2.send(m);
    last = n;
    b2.settle();
    a.settle();
    let st = b2.h.status_json(true);
    eprintln!("resume status: {}", st["resume"]);
    assert_eq!(b2.c("catchups_done"), 1, "{}", st["resume"]);
    assert_eq!(b2.c("catchups_failed"), 0);
    assert!(b2.c("catchup_late_found") >= 1, "the withheld coin Transfer of block S was found again: {}", st["resume"]);
    assert_eq!(b2.c("loads"), 0, "no pool was loaded again: {:?}", b2.states());
    assert_eq!(b2.c("unsure_marked"), 0, "no pool went unsure: {:?}", b2.states());
    assert!(b2.gate.logs_calls.load(Ordering::Relaxed) >= 1);
    exact_vs_chain(&ch, &a, "never restarted");
    let k = exact_vs_chain(&ch, &b2, "restarted");
    assert!(k > 100, "restarted copy compared {k} values");
    same_as(&a, &b2, "after the catch-up");
    // And it keeps following normally.
    run_blocks(&mut ch, &mut [&mut a, &mut b2], 10, &mut last);
    a.settle();
    b2.settle();
    exact_vs_chain(&ch, &b2, "restarted, 10 blocks later");
    same_as(&a, &b2, "10 blocks later");
    assert_eq!(b2.c("loads"), 0, "{:?}", b2.states());
    // Its own periodic / final save works too.
    let rep2 = b2.intake.save_now().expect("saved again");
    assert_eq!(rep2.block, last);
}

/// A copy that followed the chain and saved itself; returns the file.
fn saved_copy(ch: &mut Chain, name: &str, last: &mut u64) -> String {
    let path = state_path(name);
    let mut b = ch.copy(Some(&path), |_| {});
    ch.connect(&mut b);
    run_blocks(ch, &mut [&mut b], 1, last);
    b.wait("every pool ready", |c| c.all_ready() && c.walked_all());
    run_blocks(ch, &mut [&mut b], 4, last);
    b.settle();
    b.intake.save_now().expect("saved");
    path
}

/// After a restart that can't resume: the first block starts a normal load
/// and the copy ends exact.
fn normal_load_then_exact(ch: &mut Chain, b2: &mut Copy, last: &mut u64, label: &str) {
    ch.connect(b2);
    let txs = ch.random_txs();
    let n = ch.mine(&txs);
    let logs = ch.reports(n);
    let mut m = ch.msg(n, logs, Some(n));
    m.gap_reason = Some("start".into());
    b2.send(m);
    *last = n;
    b2.wait("every pool ready after the normal load", |c| c.all_ready());
    run_blocks(ch, &mut [b2], 3, last);
    b2.settle();
    assert!(b2.c("loads") >= 3, "{label}: pools were loaded normally");
    exact_vs_chain(ch, b2, label);
}

#[test]
fn damaged_or_other_version_file_means_a_normal_load() {
    let Some(mut ch) = Chain::start() else {
        eprintln!("copy2 resume anvil test SKIPPED: no ~/.foundry/bin/anvil");
        return;
    };
    let mut last = 0;
    let path = saved_copy(&mut ch, "damaged", &mut last);
    let good = std::fs::read(&path).unwrap();
    // 1. One byte damaged in the middle.
    let mut bad = good.clone();
    let mid = bad.len() / 2;
    bad[mid] ^= 0x40;
    std::fs::write(&path, &bad).unwrap();
    let mut b2 = ch.copy(Some(&path), |_| {});
    assert_eq!(b2.c("resume_refused"), 1);
    assert_eq!(b2.c("resume_pools"), 0);
    assert!(b2.h.status_json(false)["resume"]["state"].as_str().unwrap().contains("checksum"), "{}", b2.h.status_json(false)["resume"]);
    normal_load_then_exact(&mut ch, &mut b2, &mut last, "damaged file");
    drop(b2);
    // 2. Another format version (an older / newer sidecar's file).
    let mut other = good.clone();
    other[16] ^= 0x7f;
    std::fs::write(&path, &other).unwrap();
    let mut b3 = ch.copy(Some(&path), |_| {});
    assert_eq!(b3.c("resume_refused"), 1);
    assert!(b3.h.status_json(false)["resume"]["state"].as_str().unwrap().contains("format version"));
    normal_load_then_exact(&mut ch, &mut b3, &mut last, "other format version");
    drop(b3);
    // 3. No file at all.
    std::fs::remove_file(&path).unwrap();
    let mut b4 = ch.copy(Some(&path), |_| {});
    assert_eq!(b4.c("resume_refused"), 0);
    normal_load_then_exact(&mut ch, &mut b4, &mut last, "no file");
}

#[test]
fn too_big_a_gap_means_a_normal_load() {
    let Some(mut ch) = Chain::start() else {
        eprintln!("copy2 resume anvil test SKIPPED: no ~/.foundry/bin/anvil");
        return;
    };
    let mut last = 0;
    let path = saved_copy(&mut ch, "biggap", &mut last);
    // 12 blocks pass; this sidecar only catches up 5.
    let mut nothing: [&mut Copy; 0] = [];
    run_blocks(&mut ch, &mut nothing, 12, &mut last);
    let mut b2 = ch.copy(Some(&path), |c| c.resume_max_blocks = 5);
    assert_eq!(b2.c("resume_pools"), 3);
    normal_load_then_exact(&mut ch, &mut b2, &mut last, "gap too big");
    assert_eq!(b2.c("catchups_failed"), 1);
    assert!(b2.h.status_json(false)["resume"]["state"].as_str().unwrap().contains("normal load"), "{}", b2.h.status_json(false)["resume"]);
}

#[test]
fn bot_restart_gap_is_filled_from_logs_without_reloading() {
    let Some(mut ch) = Chain::start() else {
        eprintln!("copy2 resume anvil test SKIPPED: no ~/.foundry/bin/anvil");
        return;
    };
    let mut c = ch.copy(None, |_| {});
    ch.connect(&mut c);
    let mut last = 0;
    run_blocks(&mut ch, &mut [&mut c], 1, &mut last);
    c.wait("every pool ready", |c| c.all_ready() && c.walked_all());
    run_blocks(&mut ch, &mut [&mut c], 5, &mut last);
    c.settle();
    let loads = c.c("loads");
    let unsure = c.c("unsure_marked");
    // The bot restarts: 15 blocks never sent; the free node refuses the
    // logs (too many results): the paid node must answer.
    let mut nothing: [&mut Copy; 0] = [];
    run_blocks(&mut ch, &mut nothing, 15, &mut last);
    c.gate.public_refuses_logs.store(true, Ordering::SeqCst);
    let paid0 = c.gate.paid.load(Ordering::Relaxed);
    ch.connect(&mut c); // the new bot sends track again (same pools)
    let txs = ch.random_txs();
    let n = ch.mine(&txs);
    let logs = ch.reports(n);
    let mut m = ch.msg(n, logs, Some(n));
    m.gap_reason = Some("start".into());
    c.send(m);
    last = n;
    c.settle();
    let st = c.h.status_json(false);
    eprintln!("bot restart: {}", st["resume"]);
    assert_eq!(c.c("gaps"), 1, "the bot's gap was seen");
    assert_eq!(c.c("catchups_done"), 1, "{}", st["resume"]);
    assert_eq!(c.c("loads"), loads, "no pool loaded again");
    assert_eq!(c.c("unsure_marked"), unsure, "no pool went unsure");
    assert!(c.c("catchup_blocks") >= 10, "the missing blocks came from the logs: {}", st["resume"]);
    assert!(c.gate.paid.load(Ordering::Relaxed) > paid0, "the paid node answered what the free one refused");
    exact_vs_chain(&ch, &c, "after the bot's restart");
    run_blocks(&mut ch, &mut [&mut c], 5, &mut last);
    c.settle();
    exact_vs_chain(&ch, &c, "5 blocks later");
    let _ = HashSet::<u8>::new();
}
