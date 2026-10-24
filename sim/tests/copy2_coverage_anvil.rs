// ============================================================================
// COPY 2 COVERAGE + ACCURACY ON A PRACTICE CHAIN (dry run #17 findings)
//
// Plain English:
//   A private practice chain (anvil) plays "the node" for copy 2's intake,
//   exactly like live: `track`, one block message per block built from the
//   chain's own logs (+ the header's logsBloom), node questions answered by
//   the chain (incl. debug_traceCall with the prestateTracer and
//   eth_getLogs). Checks go through arbsim's real socket handler
//   (server::handle) and are compared with the SAME check run on the chain's
//   real state (RemoteView) at the same block: success, output and gas.
//
//   1. big_checks_*: the bot's 2-pool round trip (ArbExecutor) through a
//      V3 / PancakeSwap V3 / Algebra / V4 pool with many positions and a
//      second V3 pool. Without tick walks (dry run #17 behaviour) a large
//      check on two READY pools answers "miss" on the pools' own slots
//      (tick map words / ticks / price history). With tick walks every size
//      is answered by the copy and is exact.
//   2. pancake_farm_*: a PancakeSwap pool with a farm (LM pool) whose state
//      changes WITHOUT pool events (dry run #17: copy said "LS", node said
//      the trade completes). The copy must never answer wrong: replays stay
//      exact, checks through the farm answer "unknown".
//   3. late_*: reports of a block arriving after the block was passed on
//      (dry run #17: 4 probes with a wrong price / coin balances). With the
//      header bloom (or a swap whose coin transfers are missing) the copy
//      answers "unknown" for that pool until it has settled the block from
//      the node's logs, then exactly.
//
//   Skipped (passes with a note) when anvil isn't installed.
// ============================================================================
mod copy2_util;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use arbsim::check::{run_calls, CallReq, Overrides};
use arbsim::copy2::intake::{manual, BlockMsg, C2Config, Copy2Handle, Intake, PoolState};
use arbsim::copy2::{PoolKind, PoolLog, TrackedPool};
use arbsim::node::{CallResult, Class, NodeApi, NodeErr, RpcErr};
use arbsim::server::Ctx;
use arbsim::state::fill::FillQueue;
use arbsim::state::mirror::{Config, Shared};
use arbsim::state::pinned::PinnedCache;
use arbsim::state::snap::Volatile;
use arbsim::state::{Lookup, StateRead};
use copy2_util::*;
use revm::primitives::{Address, Bytes, B256, U256};
use serde_json::{json, Value};

const SIM_EXECUTOR: Address = Address::new([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xa7, 0xb5, 0x1e, 0x00]);
const SIM_CALLER: Address = Address::new([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x0b, 0x07, 0x51]);
const ALGEBRA_VAULT: Address = Address::new([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x0c, 0xa1, 0x1e]);

fn q(n: u32) -> U256 {
    U256::from(10u8).pow(U256::from(n))
}
fn signed(w: U256) -> i64 {
    if w.bit(255) {
        -((!w).wrapping_add(U256::from(1u8)).to::<i64>())
    } else {
        w.to::<i64>()
    }
}

/// The practice chain as "the node", counting requests per method.
struct Node {
    a: Arc<Anvil>,
    calls: Mutex<HashMap<String, u64>>,
    requests: AtomicU64,
}

impl NodeApi for Node {
    fn call_batch(&self, _c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        self.requests.fetch_add(1, Ordering::Relaxed);
        {
            let mut g = self.calls.lock().unwrap();
            for (m, _) in calls {
                *g.entry(m.to_string()).or_default() += 1;
            }
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum K {
    V3,
    Pancake,
    Algebra,
    V4,
}

struct World {
    a: Arc<Anvil>,
    node: Arc<Node>,
    sh: Arc<Shared>,
    intake: Intake,
    h: Copy2Handle,
    ctx: Ctx,
    kind: K,
    /// [test pool, reference V3 pool]
    pools: Vec<TrackedPool>,
    trader: Address,
    plain: Address,
    uu: Address,
    ww: Address,
    lm: Option<Address>,
    runtime: String,
    ts: u64,
    last_sent: u64,
    /// The bot's report rule: coin Transfers only for CONTRACT pools (the
    /// bot never subscribes to the V4 PoolManager's transfers).
    bot_shape: bool,
}

/// World options (World::start = the defaults).
#[derive(Clone, Copy)]
struct Opts {
    walks: bool,
    lm_credit: Option<u64>,
    bot_shape: bool,
    /// C2Config.pm_bound (false = the old stale PoolManager balances).
    pm_bound: bool,
    /// WalkCfg.full_words (0 = window only, the old walk).
    full_words: u64,
    /// Test pool: every position ABOVE the price (no liquidity below it).
    one_sided: bool,
    /// V4 only: a second, deep V4 pool on the same two coins (0.3 %,
    /// spacing 60) at pools[2] (copy2-p: the PoolManager balance bound).
    second_v4: bool,
    /// Test pool positions 100x thinner (a check can drain it).
    thin: bool,
    /// Narrow coins (copy2-r / copy2-s): the USD coin counts only the low
    /// 64 bits of its balance word (live USDG), WETH the low 128, and each
    /// trader gets this many USD base units (WETH: 1e30).
    narrow_usd_mint: Option<u64>,
}

impl Default for Opts {
    fn default() -> Self {
        Opts { walks: true, lm_credit: None, bot_shape: false, pm_bound: true, full_words: arbsim::copy2::walk::WalkCfg::default().full_words, one_sided: false, second_v4: false, thin: false, narrow_usd_mint: None }
    }
}

fn tracked(address: Address, kind: PoolKind, t0: Address, t1: Address) -> TrackedPool {
    TrackedPool { address, v4_id: None, kind, token0: t0, token1: t1, fee: 0, tick_spacing: 0 }
}

fn kind_str(k: PoolKind) -> &'static str {
    match k {
        PoolKind::V3 => "v3",
        PoolKind::PancakeV3 => "pancake-v3",
        PoolKind::Algebra => "algebra",
        PoolKind::V4 => "v4",
        PoolKind::V2 => "v2",
        PoolKind::Solidly => "solidly",
    }
}

impl World {
    /// `walks`: tick walks on (false = dry run #17 behaviour).
    fn start(kind: K, walks: bool, lm_credit: Option<u64>) -> Option<World> {
        World::start_with(kind, Opts { walks, lm_credit, ..Opts::default() })
    }

    fn start_with(kind: K, o: Opts) -> Option<World> {
        let (walks, lm_credit) = (o.walks, o.lm_credit);
        let a = Arc::new(Anvil::start()?);
        let arts = artifacts();
        let (uu, ww, usd_big, weth_big) = match o.narrow_usd_mint {
            None => {
                let tok = art(&arts, "Token");
                let uu = a.deploy(&tok, &encode(&[Arg::D(b"USD".to_vec()), Arg::W(U256::from(6))]));
                let ww = a.deploy(&tok, &encode(&[Arg::D(b"WETH".to_vec()), Arg::W(U256::from(18))]));
                (uu, ww, q(36), q(36))
            }
            Some(m) => {
                let tok = art(&arts, "TokenNarrow");
                let uu = a.deploy(&tok, &encode(&[Arg::D(b"USD".to_vec()), Arg::W(U256::from(6)), Arg::W(U256::from(64))]));
                let ww = a.deploy(&tok, &encode(&[Arg::D(b"WETH".to_vec()), Arg::W(U256::from(18)), Arg::W(U256::from(128))]));
                (uu, ww, U256::from(m), q(30))
            }
        };
        let big = |t: Address| if t == uu { usd_big } else { weth_big };
        let (t0, t1) = if uu < ww { (uu, ww) } else { (ww, uu) };
        let plain = a.deploy(&art(&arts, "Trader"), &[]);
        let mut trader = plain;
        for t in [uu, ww] {
            a.send_ok(t, &calldata("mint(address,uint256)", &[Arg::A(plain), Arg::W(big(t))]));
        }
        // Reference pool: Uniswap V3, 0.05 %, spacing 10, priced 2 % off.
        let f = a.deploy(&art(&arts, "UniswapV3Factory"), &[]);
        a.send_ok(f, &calldata("enableFeeAmount(uint24,int24)", &[Arg::W(U256::from(100)), Arg::I(1)]));
        let v3pool = |fee: u32, price: f64| -> Address {
            a.send_ok(f, &calldata("createPool(address,address,uint24)", &[Arg::A(uu), Arg::A(ww), Arg::W(U256::from(fee))]));
            let r = a.call(f, &calldata("getPool(address,address,uint24)", &[Arg::A(uu), Arg::A(ww), Arg::W(U256::from(fee))])).unwrap();
            let p = Address::from_slice(&r[12..32]);
            a.send_ok(p, &calldata("initialize(uint160)", &[Arg::W(sqrt_price_for(price, uu, ww))]));
            p
        };
        let refp = v3pool(500, 2550.0);
        let mut lm = None;
        let (test, spacing): (TrackedPool, i64) = match kind {
            K::V3 => {
                // 0.01 %, tick spacing 1: the widest tick map.
                let p = v3pool(100, 2500.0);
                a.send_ok(p, &calldata("increaseObservationCardinalityNext(uint16)", &[Arg::W(U256::from(40))]));
                (tracked(p, PoolKind::V3, t0, t1), 1)
            }
            K::Pancake => {
                let d = a.deploy(&art(&arts, "PancakeDeployer"), &[]);
                let init = arbsim::check::hexutil::parse_bytes(&art(&arts, "PancakeV3Pool")).unwrap().to_vec();
                a.send_ok(d, &calldata("deploy(bytes,address,address,address,uint24,int24)", &[Arg::D(init), Arg::A(a.me), Arg::A(t0), Arg::A(t1), Arg::W(U256::from(2500)), Arg::I(50)]));
                let p = create_address(d, 1);
                a.send_ok(p, &calldata("initialize(uint160)", &[Arg::W(sqrt_price_for(2500.0, uu, ww))]));
                a.send_ok(p, &calldata("increaseObservationCardinalityNext(uint16)", &[Arg::W(U256::from(25))]));
                if let Some(c) = lm_credit {
                    let l = a.deploy(&art(&arts, "TestLmPool"), &encode(&[Arg::W(U256::from(c))]));
                    a.send_ok(p, &calldata("setLmPool(address)", &[Arg::A(l)]));
                    lm = Some(l);
                }
                (tracked(p, PoolKind::PancakeV3, t0, t1), 50)
            }
            K::Algebra => {
                let n = a.nonce(a.me);
                let dep = create_address(a.me, n + 1);
                let af = a.deploy(&art(&arts, "AlgebraFactory"), &encode(&[Arg::A(dep)]));
                let d2 = a.deploy(&art(&arts, "AlgebraPoolDeployer"), &encode(&[Arg::A(af)]));
                assert_eq!(d2, dep);
                let pf = a.deploy(&art(&arts, "BasePluginV1Factory"), &encode(&[Arg::A(af)]));
                a.send_ok(af, &calldata("setDefaultPluginFactory(address)", &[Arg::A(pf)]));
                let v = a.deploy(&art(&arts, "AlgebraVaultFactoryStub"), &encode(&[Arg::A(ALGEBRA_VAULT)]));
                a.send_ok(af, &calldata("setVaultFactory(address)", &[Arg::A(v)]));
                a.send_ok(af, &calldata("createPool(address,address,bytes)", &[Arg::A(uu), Arg::A(ww), Arg::D(vec![])]));
                let r = a.call(af, &calldata("poolByPair(address,address)", &[Arg::A(uu), Arg::A(ww)])).unwrap();
                let p = Address::from_slice(&r[12..32]);
                a.send_ok(p, &calldata("initialize(uint160)", &[Arg::W(sqrt_price_for(2500.0, uu, ww))]));
                (tracked(p, PoolKind::Algebra, t0, t1), 60)
            }
            K::V4 => {
                let pm = a.deploy(&art(&arts, "PoolManager"), &encode(&[Arg::A(a.me)]));
                let vt = a.deploy(&art(&arts, "V4Trader"), &encode(&[Arg::A(pm)]));
                for t in [uu, ww] {
                    a.send_ok(t, &calldata("mint(address,uint256)", &[Arg::A(vt), Arg::W(big(t))]));
                }
                trader = vt;
                let mut p = TrackedPool { address: pm, v4_id: None, kind: PoolKind::V4, token0: t0, token1: t1, fee: 500, tick_spacing: 10 };
                p.v4_id = Some(arbsim::copy2::replay::v4_pool_id(&p));
                a.send_ok(pm, &calldata("initialize((address,address,uint24,int24,address),uint160)", &[Arg::A(t0), Arg::A(t1), Arg::W(U256::from(500)), Arg::I(10), Arg::A(Address::ZERO), Arg::W(sqrt_price_for(2500.0, uu, ww))]));
                (p, 10)
            }
        };
        let mut pools = vec![test, tracked(refp, PoolKind::V3, t0, t1)];
        if o.second_v4 && kind == K::V4 {
            let pm = pools[0].address;
            let mut p2 = TrackedPool { address: pm, v4_id: None, kind: PoolKind::V4, token0: t0, token1: t1, fee: 3000, tick_spacing: 60 };
            p2.v4_id = Some(arbsim::copy2::replay::v4_pool_id(&p2));
            a.send_ok(pm, &calldata("initialize((address,address,uint24,int24,address),uint160)", &[Arg::A(t0), Arg::A(t1), Arg::W(U256::from(3000)), Arg::I(60), Arg::A(Address::ZERO), Arg::W(sqrt_price_for(2500.0, uu, ww))]));
            let s0 = u(&a.ok("eth_getStorageAt", json!([ha(pm), hx64(map_slot(U256::from_be_bytes(p2.v4_id.unwrap().0), U256::from(6))), "latest"])));
            let t = ((s0 >> 160usize) & U256::from(0xff_ffffu32)).to::<i64>();
            let t = if t >= 1 << 23 { t - (1 << 24) } else { t };
            let b = t.div_euclid(60) * 60;
            // Deep: 100x the test pool's biggest position, +-12,000 ticks.
            a.send_ok(trader, &calldata(
                "modify((address,address,uint24,int24,address),int24,int24,int256,bytes32)",
                &[Arg::A(t0), Arg::A(t1), Arg::W(U256::from(3000)), Arg::I(60), Arg::A(Address::ZERO), Arg::I((b - 12_000) as i128), Arg::I((b + 12_000) as i128), Arg::W(q(18)), Arg::W(U256::ZERO)],
            ));
            pools.push(p2);
        }
        // The copy (it starts only with `track` + the first block message).
        let node = Arc::new(Node { a: a.clone(), calls: Mutex::new(HashMap::new()), requests: AtomicU64::new(0) });
        let nd: Arc<dyn NodeApi> = node.clone();
        let sh = Shared::new(Config::for_tests(), Some(nd), Arc::new(Volatile::default()));
        let mut cfg = C2Config::for_tests();
        if !walks {
            cfg.walks_inflight = 0;
        }
        cfg.pm_bound = o.pm_bound;
        cfg.walk.full_words = o.full_words;
        let fills = Arc::new(FillQueue::new(1000, 100));
        let (intake, h) = manual(sh.clone(), fills.clone(), cfg);
        let (_u, updater) = arbsim::state::updater::manual(sh.clone(), fills.clone());
        let ctx = Ctx { shared: sh.clone(), updater, fills, pinned: PinnedCache::new(4), copy2: Some(h.clone()) };
        let mut w = World { a: a.clone(), node, sh, intake, h, ctx, kind, pools, trader, plain, uu, ww, lm, runtime: arb_executor_runtime(), ts: 0, last_sent: 0, bot_shape: o.bot_shape };
        // Many positions, spread far (quadratic widths): big swaps cross
        // many ticks and many tick-map words.
        for k in 1..=18i64 {
            let liq = q(if o.thin { 13 } else { 15 }) * U256::from((k % 4 + 1) as u64);
            let tick = w.tick(0);
            let b = tick.div_euclid(spacing) * spacing;
            // Widest position ~30,000 ticks (inside the walked window).
            let f = (30_000 / (spacing * 18 * 18 * 12)).max(1);
            let (lo, hi) = if o.one_sided {
                (b + spacing * 10 * k, b + spacing * (10 * k + f * k * k * 9 + 1))
            } else {
                (b - spacing * f * k * k * 12 - spacing, b + spacing * f * k * k * 9 + spacing)
            };
            let (to, d) = w.mint_call(0, lo, hi, liq);
            a.send_ok(to, &d);
        }
        // Reference pool liquidity (deep, so the test pool decides).
        let rt = w.tick(1);
        let rb = rt.div_euclid(10) * 10;
        for k in 1..=6i64 {
            a.send_ok(w.plain, &calldata("mintV3(address,int24,int24,uint128)", &[Arg::A(refp), Arg::I((rb - 400 * k) as i128), Arg::I((rb + 400 * k) as i128), Arg::W(q(17))]));
        }
        a.ok("evm_setAutomine", json!([false]));
        w.ts = u64v(&a.ok("eth_getBlockByNumber", json!(["latest", false]))["timestamp"]);
        let mut slots = serde_json::Map::new();
        for c in [uu, ww] {
            slots.insert(ha(c), json!({"layout": "solidity", "slot": 0}));
        }
        w.h.coin_slots_json(&json!(1), &json!({"type": "coin_slots", "coinSlots": slots}));
        let list: Vec<Value> = w
            .pools
            .iter()
            .map(|p| json!({"address": ha(p.address), "kind": kind_str(p.kind), "token0": ha(p.token0), "token1": ha(p.token1), "fee": p.fee, "tickSpacing": p.tick_spacing, "v4Id": p.v4_id.map(|i| format!("{i}"))}))
            .collect();
        let ans = w.h.track_json(&json!(2), &json!({ "pools": list }));
        assert_eq!(ans["ok"], json!(true), "{ans}");
        Some(w)
    }

    /// The Uniswap-V3-style trader (holds coins in every world).
    fn plain_trader(&self) -> Address {
        self.plain
    }

    fn mint_call(&self, i: usize, lo: i64, hi: i64, liq: U256) -> (Address, Vec<u8>) {
        let p = &self.pools[i];
        match (self.kind, i) {
            (K::V4, 0) => (
                self.trader,
                calldata(
                    "modify((address,address,uint24,int24,address),int24,int24,int256,bytes32)",
                    &[Arg::A(p.token0), Arg::A(p.token1), Arg::W(U256::from(p.fee)), Arg::I(p.tick_spacing as i128), Arg::A(Address::ZERO), Arg::I(lo as i128), Arg::I(hi as i128), Arg::W(liq), Arg::W(U256::ZERO)],
                ),
            ),
            (K::Algebra, 0) => (self.plain_trader(), calldata("mintAlgebra(address,int24,int24,uint128)", &[Arg::A(p.address), Arg::I(lo as i128), Arg::I(hi as i128), Arg::W(liq)])),
            _ => (self.plain_trader(), calldata("mintV3(address,int24,int24,uint128)", &[Arg::A(p.address), Arg::I(lo as i128), Arg::I(hi as i128), Arg::W(liq)])),
        }
    }

    /// Current tick of pool i on the chain.
    fn tick(&self, i: usize) -> i64 {
        let p = &self.pools[i];
        let (acct, s) = match (p.kind, p.v4_id) {
            (PoolKind::V4, Some(id)) => (p.address, map_slot(U256::from_be_bytes(id.0), U256::from(6))),
            (PoolKind::Algebra, _) => {
                let r = self.a.call(p.address, &calldata("globalState()", &[])).unwrap();
                return signed(word(&r, 1));
            }
            _ => (p.address, U256::ZERO),
        };
        let v = u(&self.a.ok("eth_getStorageAt", json!([ha(acct), hx64(s), "latest"])));
        let t = ((v >> 160usize) & U256::from(0xff_ffffu32)).to::<i64>();
        if t >= 1 << 23 {
            t - (1 << 24)
        } else {
            t
        }
    }

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

    /// The block's reports as the bot sends them.
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
                        || (!(self.bot_shape && p.v4_id.is_some())
                            && (l.address == p.token0 || l.address == p.token1)
                            && l.topics.len() == 3
                            && (side(&l.topics[1]) == p.address || side(&l.topics[2]) == p.address))
                })
            })
            .collect()
    }

    fn bloom(&self, n: u64) -> Vec<u8> {
        let b = self.a.ok("eth_getBlockByNumber", json!([format!("{n:#x}"), false]));
        arbsim::check::hexutil::parse_bytes(b["logsBloom"].as_str().unwrap()).unwrap().to_vec()
    }

    fn msg(&mut self, n: u64, logs: Vec<PoolLog>, with_bloom: bool) -> BlockMsg {
        let ts = u64v(&self.a.ok("eth_getBlockByNumber", json!([format!("{n:#x}"), false]))["timestamp"]);
        let prev = if self.last_sent > 0 && n > self.last_sent { Some(self.last_sent) } else { None };
        if n > self.last_sent {
            self.last_sent = n;
        }
        let bloom = if with_bloom { Some(self.bloom(n)) } else { None };
        BlockMsg { block: n, timestamp: ts, l1_block: Some(n), base_fee: Some(0), prev_block: prev, tick: logs.is_empty(), logs, gap_reason: None, bloom }
    }

    fn send(&mut self, m: BlockMsg) {
        self.h.block(m);
        self.intake.pump();
    }

    /// Mine a block with these transactions and send its reports.
    fn block(&mut self, txs: &[(Address, Vec<u8>)]) -> u64 {
        let n = self.mine(txs);
        let logs = self.reports(n);
        let m = self.msg(n, logs, true);
        self.send(m);
        n
    }

    fn settle(&mut self) {
        let t0 = Instant::now();
        loop {
            self.intake.pump();
            if self.intake.outstanding() == 0 {
                return;
            }
            assert!(t0.elapsed() < Duration::from_secs(60), "background work never finished: {}", self.h.status_json(true));
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn wait(&mut self, what: &str, f: impl Fn(&World) -> bool) {
        let t0 = Instant::now();
        while !f(self) {
            self.intake.pump();
            assert!(t0.elapsed() < Duration::from_secs(60), "timed out waiting for: {what}; status {}", self.h.status_json(true));
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn state(&self, i: usize) -> PoolState {
        let reg = self.h.c2.reg.read().unwrap();
        reg.pools[&(self.pools[i].address, self.pools[i].v4_id)].state
    }

    fn all_ready(&self) -> bool {
        (0..self.pools.len()).all(|i| self.state(i) == PoolState::Ready)
    }

    fn walked(&self) -> bool {
        let reg = self.h.c2.reg.read().unwrap();
        self.pools.iter().all(|p| reg.pools[&(p.address, p.v4_id)].walk.as_ref().is_some_and(|w| w.done))
    }

    /// Start the copy at the current block and wait until both pools are ready.
    fn go_live(&mut self) {
        let s = self.a.block_number();
        let m = self.msg(s, vec![], true);
        self.send(m);
        self.wait("both pools ready", |w| w.all_ready());
        self.settle();
    }

    /// The bot's round trip: test pool then reference pool (or back), `usd`
    /// dollars of the USD coin, as (call, overrides JSON).
    fn round_trip(&self, usd: u64, test_first: bool) -> (CallReq, Value) {
        let sel = sel("execute((address,uint256,uint256,uint256,(uint8,address,address,address,uint16,uint24,int24,bool)[]),address)");
        let p = &self.pools[0];
        let test_hop = |tin: Address, tout: Address| match self.kind {
            K::V4 => hop_words(3, p.address, tin, tout, p.fee, p.tick_spacing),
            _ => hop_words(2, p.address, tin, tout, 0, 0),
        };
        let ref_hop = |tin: Address, tout: Address| hop_words(2, self.pools[1].address, tin, tout, 0, 0);
        let hops = if test_first { vec![test_hop(self.uu, self.ww), ref_hop(self.ww, self.uu)] } else { vec![ref_hop(self.uu, self.ww), test_hop(self.ww, self.uu)] };
        let amt = U256::from(usd) * q(6);
        let mut d = sel.to_vec();
        let mut words = vec![U256::from(0x40), U256::ZERO];
        words.extend([U256::from_be_slice(self.uu.as_slice()), amt, U256::MAX, U256::MAX, U256::from(0xa0), U256::from(hops.len())]);
        for h in &hops {
            words.extend(h.iter().copied());
        }
        for w in words {
            d.extend_from_slice(&w.to_be_bytes::<32>());
        }
        let mut exec_diff = json!({ hx64(U256::ZERO): hx64(U256::from_be_slice(SIM_CALLER.as_slice())) });
        if self.kind == K::V4 {
            exec_diff[hx64(U256::from(6))] = json!(hx64(U256::from_be_slice(p.address.as_slice())));
            exec_diff[hx64(U256::from(7))] = json!(hx64(U256::from_be_slice(self.ww.as_slice())));
        }
        let bal = map_slot(U256::from_be_slice(SIM_EXECUTOR.as_slice()), U256::ZERO);
        let ov = json!({
            ha(SIM_EXECUTOR): { "code": self.runtime, "stateDiff": exec_diff },
            ha(self.uu): { "stateDiff": { hx64(bal): hx64(amt) } },
        });
        (CallReq { from: SIM_CALLER, to: Some(SIM_EXECUTOR), data: Bytes::from(d), gas: Some(8_000_000), value: U256::ZERO }, ov)
    }

    /// Ask the copy (through the socket handler) at block n.
    fn ask(&self, n: u64, call: &CallReq, ov: &Value) -> Value {
        arbsim::server::handle(
            &self.ctx,
            &json!({"id": 7, "type": "call", "at": {"block": n}, "overrides": ov, "calls": [{
                "from": ha(call.from), "to": ha(call.to.unwrap()), "data": hb(&call.data), "gas": format!("{:#x}", call.gas.unwrap())}]}),
        )
    }

    /// The same check on the chain's real state at block n (same engine,
    /// same block details as the copy's version of n).
    fn truth(&self, n: u64, call: &CallReq, ov: &Value) -> (bool, String, u64) {
        let ctx = self.sh.published.read().unwrap().versions.iter().find(|v| v.block == n).and_then(|v| v.ctx.clone()).expect("copy has block n");
        let rv = RemoteView::new(&self.a, n);
        let o = Overrides::from_json(ov).unwrap();
        let r = run_calls(&rv, &ctx, &o, &[], std::slice::from_ref(call));
        let x = r.expect("truth run").into_iter().next().unwrap();
        (x.success, hb(&x.output), x.gas_used)
    }

    /// Copy vs truth for one check at block n: Some(true) same, Some(false)
    /// DIFFERENT (never allowed), None = the copy said unknown.
    fn compare(&self, n: u64, usd: u64, test_first: bool) -> (Option<bool>, Value) {
        let (call, ov) = self.round_trip(usd, test_first);
        let ans = self.ask(n, &call, &ov);
        if ans["ok"] != json!(true) {
            return (None, ans);
        }
        let r = &ans["results"][0];
        let (ts, to, tg) = self.truth(n, &call, &ov);
        let same = r["success"] == json!(ts) && r["output"] == json!(to) && r["gasUsed"] == json!(format!("{tg:#x}"));
        (Some(same), json!({"copy": r, "truth": {"success": ts, "output": to, "gasUsed": tg}}))
    }
}

fn hop_words(kind: u8, pool: Address, tin: Address, tout: Address, v4fee: u32, v4sp: i32) -> Vec<U256> {
    vec![
        U256::from(kind),
        U256::from_be_slice(pool.as_slice()),
        U256::from_be_slice(tin.as_slice()),
        U256::from_be_slice(tout.as_slice()),
        U256::ZERO,
        U256::from(v4fee),
        int_word(v4sp as i128),
        U256::ZERO,
    ]
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

/// Sizes the dry run used (USDG) plus big ones that cross many ticks (the
/// largest moves the test pool's price by ~x2: far beyond any real check).
const SIZES: [u64; 6] = [100, 1_000, 5_000, 20_000, 60_000, 150_000];
/// A size that uses up ALL the test pool's liquidity in one direction: the
/// swap then walks the tick map to the price limit, beyond the walked
/// window (ARBSIM_COPY2_WALK_TICKS): such a check may answer unknown,
/// never a wrong answer.
const EXHAUST: u64 = 50_000_000;

/// A few trades on the test pool so the copy has replayed real events.
fn trade_some(w: &mut World) {
    let p = w.pools[0].clone();
    let zfo_u = w.uu < w.ww;
    for (usd, in_u) in [(20_000u64, true), (35_000, false), (5_000, true)] {
        let amt = if in_u { U256::from(usd) * q(6) } else { U256::from(usd) * q(18) / U256::from(2500) };
        let zfo = in_u == zfo_u;
        let tx = match w.kind {
            K::V4 => (
                w.trader,
                calldata(
                    "swap((address,address,uint24,int24,address),bool,int256,uint160)",
                    &[Arg::A(p.token0), Arg::A(p.token1), Arg::W(U256::from(p.fee)), Arg::I(p.tick_spacing as i128), Arg::A(Address::ZERO), Arg::B(zfo), Arg::W(U256::ZERO.wrapping_sub(amt)), Arg::W(U256::ZERO)],
                ),
            ),
            _ => (w.plain_trader(), calldata("swapV3(address,bool,int256,uint160)", &[Arg::A(p.address), Arg::B(zfo), Arg::W(amt), Arg::W(U256::ZERO)])),
        };
        w.block(&[tx]);
    }
    w.settle();
}

fn big_checks(kind: K) {
    // 1. Dry run #17 behaviour: no tick walks.
    let Some(mut w) = World::start(kind, false, None) else {
        eprintln!("copy2 coverage anvil test SKIPPED: no ~/.foundry/bin/anvil");
        return;
    };
    w.go_live();
    trade_some(&mut w);
    let n = w.block(&[]);
    w.settle();
    // Warm up with a small check (executor slots, coin slots: filled once).
    for _ in 0..3 {
        let _ = w.compare(n, 100, true);
        w.settle();
    }
    let mut misses_before = 0;
    let mut answered_before = 0;
    for usd in SIZES {
        for dir in [true, false] {
            match w.compare(n, usd, dir) {
                (None, a) => {
                    // V4 without walks: the PoolManager balance bound only
                    // counts tick data the copy holds (~none): unknown too.
                    assert!(a["unknown"] == json!("miss") || (kind == K::V4 && a["unknown"] == json!("pool_manager_balance")), "{a}");
                    misses_before += 1;
                }
                (Some(same), d) => {
                    assert!(same, "copy answer DIFFERS from the chain ({kind:?}, {usd} USD): {d}");
                    answered_before += 1;
                }
            }
        }
    }
    let st = w.h.status_json(false);
    let ready_pool_misses = st["missesByClass"]["ready pool slot"].as_u64().unwrap_or(0);
    eprintln!("{kind:?} WITHOUT tick walks: {answered_before} answered, {misses_before} missed; missesByClass {}", st["missesByClass"]);
    assert!(misses_before > 0 && ready_pool_misses > 0, "{kind:?}: expected large checks to miss on ready pools' slots without walks: {st}");

    // 2. With tick walks.
    let Some(mut w) = World::start(kind, true, None) else { return };
    let req0 = w.node.requests.load(Ordering::Relaxed);
    w.go_live();
    w.wait("tick walks of both pools", |w| w.walked());
    w.settle();
    let req_load = w.node.requests.load(Ordering::Relaxed) - req0;
    trade_some(&mut w);
    let n = w.block(&[]);
    w.settle();
    for _ in 0..3 {
        let _ = w.compare(n, 100, true);
        w.settle();
    }
    let mut answered = 0;
    let mut missed = Vec::new();
    for usd in SIZES {
        for dir in [true, false] {
            match w.compare(n, usd, dir) {
                (None, a) => missed.push((usd, dir, a)),
                (Some(same), d) => {
                    assert!(same, "copy answer DIFFERS from the chain ({kind:?}, {usd} USD): {d}");
                    answered += 1;
                }
            }
        }
    }
    let st = w.h.status_json(true);
    let cov = &st["poolCoverage"];
    eprintln!(
        "{kind:?} WITH tick walks: {answered}/{} answered; node requests for load+walks {req_load} ({:?}); coverage {cov}; walked slots {}",
        SIZES.len() * 2,
        w.node.calls.lock().unwrap(),
        st["counters"]["walk_slots"]
    );
    assert!(missed.is_empty(), "{kind:?}: checks still missed with tick walks: {missed:?}");
    for dir in [true, false] {
        if let (Some(same), d) = w.compare(n, EXHAUST, dir) {
            assert!(same, "copy answer DIFFERS from the chain ({kind:?}, liquidity used up): {d}");
        }
    }
    assert_eq!(cov["fullTickData"], json!(2), "{cov}");
    w.h.stop();
}

#[test]
fn big_checks_v3() {
    big_checks(K::V3);
}
#[test]
fn big_checks_pancake_v3() {
    big_checks(K::Pancake);
}
#[test]
fn big_checks_algebra() {
    big_checks(K::Algebra);
}
#[test]
fn big_checks_v4() {
    big_checks(K::V4);
}

/// Ticks stay known after the walk: positions added later (new ticks /
/// tick map words written by replays) and swaps keep checks exact.
#[test]
fn walked_pool_stays_exact_through_new_positions() {
    let Some(mut w) = World::start(K::V3, true, None) else { return };
    w.go_live();
    w.wait("tick walks", |w| w.walked());
    w.settle();
    let t = w.tick(0);
    // New positions far out (new tick map words) + swaps.
    let (to, d) = w.mint_call(0, t - 40_000, t + 30_001, q(15));
    w.block(&[(to, d)]);
    w.settle();
    trade_some(&mut w);
    let n = w.block(&[]);
    w.settle();
    for _ in 0..3 {
        let _ = w.compare(n, 100, true);
        w.settle();
    }
    for usd in SIZES {
        for dir in [true, false] {
            let (r, d) = w.compare(n, usd, dir);
            assert_eq!(r, Some(true), "{usd} USD: {d}");
        }
    }
    w.h.stop();
}

/// Dry run #17: PancakeSwap pool with a farm whose state moves without pool
/// events. Replays must stay exact; checks through the farm answer unknown
/// (never "LS" when the chain's trade completes).
#[test]
fn pancake_farm_changed_outside_pool_events_never_gives_a_wrong_answer() {
    let Some(mut w) = World::start(K::Pancake, true, Some(1)) else { return };
    let lm = w.lm.unwrap();
    w.go_live();
    w.settle();
    // A big swap crosses ticks: the farm's credit runs out (1 -> 0) on chain.
    let p = w.pools[0].address;
    let zfo = w.uu < w.ww;
    let tx = (w.plain_trader(), calldata("swapV3(address,bool,int256,uint160)", &[Arg::A(p), Arg::B(zfo), Arg::W(U256::from(150_000u64) * q(6)), Arg::W(U256::ZERO)]));
    let n1 = w.block(&[tx]);
    w.settle();
    let credit = |w: &World, n: u64| u(&w.a.ok("eth_call", json!([{"to": ha(lm), "data": hb(&calldata("credit()", &[]))}, format!("{n:#x}")])));
    assert_eq!(credit(&w, n1), U256::ZERO, "test setup: the swap used the farm's credit");
    // The farm's owner adds credit OUTSIDE any pool event (MasterChef-like).
    let n2 = w.block(&[(lm, calldata("addCredit(uint256)", &[Arg::W(U256::from(5u8))]))]);
    assert_eq!(credit(&w, n2), U256::from(5u8));
    // Swaps back across the ticks: fine on chain (credit 5), would be "LS"
    // on a copy holding the farm's old credit (0).
    let tx = (w.plain_trader(), calldata("swapV3(address,bool,int256,uint160)", &[Arg::A(p), Arg::B(!zfo), Arg::W(U256::from(120u64) * q(18)), Arg::W(U256::ZERO)]));
    w.block(&[tx]);
    w.settle();
    assert_eq!(w.state(0), PoolState::Ready, "replays must not depend on the farm's state: {}", w.h.status_json(true));
    // Pool storage exact vs chain (price, liquidity, fee counters).
    let n = w.block(&[]);
    w.settle();
    let head = w.sh.head().unwrap();
    for s in 0..6u64 {
        let truth = u(&w.a.ok("eth_getStorageAt", json!([ha(p), hx64(U256::from(s)), format!("{n:#x}")])));
        assert_eq!(head.snap.storage(p, U256::from(s)), Lookup::Known(truth), "pool slot {s}");
    }
    // Checks through the pool: never a wrong answer.
    let mut unknown = 0;
    for usd in SIZES {
        for dir in [true, false] {
            match w.compare(n, usd, dir) {
                (None, _) => unknown += 1,
                (Some(same), d) => assert!(same, "copy answer DIFFERS ({usd} USD): {d}"),
            }
        }
    }
    let st = w.h.status_json(false);
    eprintln!("farm pool: {unknown} of {} checks unknown; outside contracts {}; misses {}", SIZES.len() * 2, st["outsideContracts"], st["missesByClass"]);
    assert!(unknown > 0, "checks through the farm must answer unknown");
    assert_eq!(st["outsideContracts"], json!(1));
    w.h.stop();
}

/// Dry run #17: probes with wrong price / balances = reports of the block
/// that had not arrived yet. The copy must say "unknown" for that pool until
/// it has settled the block from the node's logs, then be exact.
fn late_case(pool_event_on_time: bool, transfers_on_time: bool, with_bloom: bool) {
    let Some(mut w) = World::start(K::V3, true, None) else { return };
    w.go_live();
    // Tick data walked: the swap below replays without node values, so the
    // pool stays READY (the case where a stale answer could be given).
    w.wait("tick walks", |w| w.walked());
    w.settle();
    let p = w.pools[0].clone();
    let zfo = w.uu < w.ww;
    let n = w.mine(&[(w.plain_trader(), calldata("swapV3(address,bool,int256,uint160)", &[Arg::A(p.address), Arg::B(zfo), Arg::W(U256::from(40_000u64) * q(6)), Arg::W(U256::ZERO)]))]);
    let all = w.reports(n);
    // What arrives on time: without the coin transfers (other
    // subscriptions), and maybe without the pool's own event.
    let on_time: Vec<PoolLog> = all.iter().filter(|l| if l.address == p.address { pool_event_on_time } else { transfers_on_time }).cloned().collect();
    let m = w.msg(n, on_time, with_bloom);
    w.send(m);
    // A probe at block n: slot0 + both coin balances of the pool.
    let probe = |w: &World| -> Value {
        let calls: Vec<Value> = [
            (p.address, calldata("slot0()", &[])),
            (p.token0, calldata("balanceOf(address)", &[Arg::A(p.address)])),
            (p.token1, calldata("balanceOf(address)", &[Arg::A(p.address)])),
        ]
        .iter()
        .map(|(to, d)| json!({"from": ha(SIM_CALLER), "to": ha(*to), "data": hb(d), "gas": "0x200000"}))
        .collect();
        arbsim::server::handle(&w.ctx, &json!({"id": 3, "type": "call", "at": {"block": n}, "calls": calls}))
    };
    let a = probe(&w);
    assert_eq!(a["unknown"], json!("pending_reports"), "the copy must not answer for a pool whose reports may be missing: {a}");
    // Settled from the node's logs (pending_ms = 300 in tests).
    w.wait("settled", |w| w.h.status_json(false)["pendingPools"] == json!(0));
    w.settle();
    let a = probe(&w);
    assert_eq!(a["ok"], json!(true), "{a}");
    for (i, (to, d)) in [
        (p.address, calldata("slot0()", &[])),
        (p.token0, calldata("balanceOf(address)", &[Arg::A(p.address)])),
        (p.token1, calldata("balanceOf(address)", &[Arg::A(p.address)])),
    ]
    .iter()
    .enumerate()
    {
        let truth = w.a.ok("eth_call", json!([{"to": ha(*to), "data": hb(d)}, format!("{n:#x}")]));
        assert_eq!(a["results"][i]["output"], truth, "call {i} after settling");
    }
    let st = w.h.status_json(false);
    eprintln!("late case (pool event on time {pool_event_on_time}, transfers on time {transfers_on_time}, bloom {with_bloom}): counters pending_marked {} settles {} found {}", st["counters"]["pending_marked"], st["counters"]["pending_settles"], st["counters"]["pending_found"]);
    w.h.stop();
}

#[test]
fn late_coin_transfers_with_bloom_answer_unknown_until_settled() {
    late_case(true, false, true);
}
#[test]
fn late_coin_transfers_without_bloom_are_noticed_from_the_swap() {
    late_case(true, false, false);
}
#[test]
fn late_swap_and_transfers_with_bloom_answer_unknown_until_settled() {
    late_case(false, false, true);
}
#[test]
fn late_swap_without_bloom_is_noticed_from_its_coin_transfers() {
    late_case(false, true, false);
}

// ---------------------------------------------------------------------------
// The BOT's check shape on V4 (live Oct 22, shadow hour 08:26-09:31 UTC: of
// 44 real checks 7 answered; missesTop: 503 "ready pool slot" at the V4
// PoolManager, 22 + 12 "coin slot" at USDG / WETH). The bot's reports never
// include the PoolManager's coin transfers (bot_shape), its contract swaps
// with the min / max price limit, and many of its checks were on thin
// stock-token pools ("ZeroAmount(): pool gave back nothing").
// ---------------------------------------------------------------------------

fn zero_amount_selector() -> String {
    hb(&sel("ZeroAmount()"))
}

/// A V4 pool with NO liquidity below its price: a check selling token0 into
/// it runs the price to the minimum (every tick-map word on the way) and
/// gets nothing (ZeroAmount). Before: missed on PoolManager words beyond
/// the walked window (the live 503). After (full walk + far zero words):
/// answered, exactly the chain's answer.
fn zero_amount_case(full: bool) -> Option<(usize, usize, Value)> {
    let o = Opts { bot_shape: true, one_sided: true, full_words: if full { 8000 } else { 0 }, pm_bound: full, ..Opts::default() };
    let mut w = World::start_with(K::V4, o)?;
    w.go_live();
    w.wait("tick walks", |w| w.walked());
    w.settle();
    let n = w.block(&[]);
    w.settle();
    // The test hop sells token0 (price down, into the empty side).
    let dir = w.uu < w.ww;
    // Warm up the check's own items (our contract's slots / coin balances)
    // with checks the old walk also answers (into the side with liquidity).
    for _ in 0..3 {
        let _ = w.compare(n, 100, !dir);
        w.settle();
    }
    let (mut answered, mut missed) = (0, 0);
    for usd in [100u64, 1_000, 2_000] {
        for _ in 0..3 {
            let (call, ov) = w.round_trip(usd, dir);
            let (_, out, _) = w.truth(n, &call, &ov);
            assert!(out.starts_with(&zero_amount_selector()), "test setup: the chain says ZeroAmount ({out})");
            match w.compare(n, usd, dir) {
                (Some(same), d) => {
                    assert!(same, "copy answer DIFFERS from the chain ({usd} USD): {d}");
                    answered += 1;
                }
                (None, a) => {
                    assert_eq!(a["unknown"], json!("miss"), "{a}");
                    missed += 1;
                }
            }
            w.settle();
        }
    }
    // The other way (pays token1 in): the PoolManager holds NO token1 (the
    // only pool's liquidity is all token0), so its balance goes 0 -> x on
    // chain (more gas); the copy can't prove it isn't 0: unknown, never wrong.
    for usd in [100u64, 1_000] {
        if let (Some(same), d) = w.compare(n, usd, !dir) {
            assert!(same, "copy answer DIFFERS from the chain ({usd} USD, other way): {d}");
        }
    }
    let st = w.h.status_json(false);
    w.h.stop();
    Some((answered, missed, st))
}

#[test]
fn bot_v4_check_into_an_empty_side_is_answered_exactly() {
    let Some((a, m, st)) = zero_amount_case(false) else {
        eprintln!("copy2 coverage anvil test SKIPPED: no ~/.foundry/bin/anvil");
        return;
    };
    eprintln!("ZeroAmount checks, OLD walk (window only): {a} answered, {m} missed; missesTopSlots {}", st["missesTopSlots"]);
    // (The old copy filled the missed words a few at a time (64 per check)
    // and, for the PoolManager, as values of ALL our V4 pools: answered
    // only after several misses, and unsound for another pool's words.)
    assert!(m >= 3, "the old walk misses checks that run the price to its limit ({a} answered, {m} missed)");
    let pm_misses = st["missesTop"].as_array().unwrap().iter().filter(|r| r[0] == json!("ready pool slot")).map(|r| r[2].as_u64().unwrap()).sum::<u64>();
    assert!(pm_misses >= 64, "expected the live pattern (PoolManager words beyond the walk): {st}");
    assert!(st["missesTopSlots"].as_array().unwrap().iter().any(|r| r[4].as_str().unwrap().starts_with("not a base slot")), "{}", st["missesTopSlots"]);
    let (a, m, st) = zero_amount_case(true).unwrap();
    eprintln!("ZeroAmount checks, FULL walk: {a} answered, {m} missed; far zero words {}; pm bound {} / same {} / differ {}",
        st["counters"]["walk_far_zero"], st["counters"]["pm_bound_checks"], st["counters"]["pm_bound_same"], st["counters"]["pm_bound_differ"]);
    assert_eq!(m, 0, "{st}");
    assert_eq!(a, 9);
    assert!(st["counters"]["walk_far_zero"].as_u64().unwrap() > 300, "{st}");
}

/// The PoolManager's coin balances are NOT reported to the copy (the bot
/// never subscribes to them). Old: the copy held the balance read at load
/// and answered with it after V4 trades / new liquidity moved it: a WRONG
/// answer when a check takes out more than that stale number. New: checks
/// run at a proven lower bound and far above it; same answer = exact.
fn pm_balance_case(pm_bound: bool) -> Option<(usize, usize, usize, Value)> {
    let o = Opts { bot_shape: true, pm_bound, full_words: if pm_bound { 8000 } else { 0 }, ..Opts::default() };
    let mut w = World::start_with(K::V4, o)?;
    w.go_live();
    w.wait("tick walks", |w| w.walked());
    w.settle();
    trade_some(&mut w);
    // Much more liquidity (its event is reported; the coins it brings into
    // the PoolManager are not).
    let t = w.tick(0);
    let b = t.div_euclid(10) * 10;
    let (to, d) = w.mint_call(0, b - 20_000, b + 20_000, q(19));
    w.block(&[(to, d)]);
    w.settle();
    let n = w.block(&[]);
    w.settle();
    for _ in 0..3 {
        let _ = w.compare(n, 100, true);
        w.settle();
    }
    let (mut same, mut differ, mut unknown) = (0, 0, 0);
    for usd in [1_000u64, 20_000, 150_000, 600_000, 2_000_000, 6_000_000] {
        for dir in [true, false] {
            match w.compare(n, usd, dir) {
                (Some(true), _) => same += 1,
                (Some(false), d) => {
                    eprintln!("DIFFERS ({usd} USD, test first {dir}): {d}");
                    differ += 1;
                }
                (None, a) => {
                    eprintln!("unknown ({usd} USD, test first {dir}): {}", a["unknown"]);
                    unknown += 1;
                }
            }
            w.settle();
        }
    }
    let st = w.h.status_json(false);
    w.h.stop();
    Some((same, differ, unknown, st))
}

#[test]
fn bot_v4_pool_manager_balance_is_never_stale() {
    let Some((s, d, u, st)) = pm_balance_case(false) else {
        eprintln!("copy2 coverage anvil test SKIPPED: no ~/.foundry/bin/anvil");
        return;
    };
    eprintln!("OLD (PoolManager balance held): same {s}, DIFFERENT {d}, unknown {u}; coin_balance_disagree {}", st["counters"]["coin_balance_disagree"]);
    assert!(d > 0, "expected the old copy to answer wrongly with a stale PoolManager balance");
    let (s, d, u, st) = pm_balance_case(true).unwrap();
    eprintln!("NEW (lower bound + second run): same {s}, different {d}, unknown {u}; pm bound checks {} same {} differ {}; fills refused (pm balance) {}",
        st["counters"]["pm_bound_checks"], st["counters"]["pm_bound_same"], st["counters"]["pm_bound_differ"], st["counters"]["fill_refused_pm_balance"]);
    assert_eq!(d, 0, "never a wrong answer");
    assert!(s >= 10, "most checks answered: same {s}, unknown {u}");
}

/// Size of one walk's answer and its gas (printed; run with --ignored --nocapture).
#[test]
#[ignore]
fn walk_cost() {
    for kind in [K::V3, K::Pancake, K::Algebra, K::V4] {
        let Some(mut w) = World::start(kind, false, None) else { return };
        w.go_live();
        let cfg = arbsim::copy2::walk::WalkCfg::default();
        let p = arbsim::copy2::walk::trace_params(&w.pools[0], &cfg, &json!("latest"));
        let t = w.a.ok("debug_traceCall", p.clone());
        let bytes = t.to_string().len();
        let out = arbsim::copy2::walk::read_walk(&t, &w.pools[0], &[]);
        let mut c = p.clone();
        c[2]["tracer"] = json!("callTracer");
        let g = w.a.ok("debug_traceCall", c);
        eprintln!("{kind:?}: walk answer {} KB, {} slots learned ({} ignored), {} ticks, {} words, done {}, gas {}", bytes / 1024, out.slots.len(), out.ignored, out.ticks, out.words, out.done, u64v(&g["gasUsed"]));
        if kind == K::V4 {
            // The biggest full walk: tick spacing 1 (6932 words).
            let mut p1 = w.pools[0].clone();
            p1.fee = 100;
            p1.tick_spacing = 1;
            p1.v4_id = Some(arbsim::copy2::replay::v4_pool_id(&p1));
            let init = calldata("initialize((address,address,uint24,int24,address),uint160)", &[Arg::A(p1.token0), Arg::A(p1.token1), Arg::W(U256::from(100)), Arg::I(1), Arg::A(Address::ZERO), Arg::W(sqrt_price_for(2500.0, w.uu, w.ww))]);
            w.mine(&[(p1.address, init)]);
            let p = arbsim::copy2::walk::trace_params(&p1, &cfg, &json!("latest"));
            let t = w.a.ok("debug_traceCall", p.clone());
            let out = arbsim::copy2::walk::read_walk(&t, &p1, &[]);
            let mut c = p.clone();
            c[2]["tracer"] = json!("callTracer");
            let g = w.a.ok("debug_traceCall", c);
            eprintln!("V4 spacing 1: walk answer {} KB, {} slots learned, {} far zero words, full {}, done {}, gas {}", t.to_string().len() / 1024, out.slots.len(), out.far_zero.len(), out.full, out.done, u64v(&g["gasUsed"]));
            assert!(out.done && out.full);
        }
    }
}

/// V4 pools with a protocol fee (live Oct 22 13:34: the bot's most common
/// checks, stock-coin V4 pools, all blocked on protocolFeesAccrued[coin],
/// which the copy can't follow: other pools' swaps add to it, collections
/// empty it without a PoolManager event). Its value only decides the gas of
/// one store (0 -> non-zero 20,000 vs non-zero 2,900); the swap amounts
/// never depend on it. The copy runs the check with it 0 and not 0 and
/// answers when only the gas differs, with the HIGHER gas: same success /
/// output as the chain, gas never below the chain's (the bot never
/// overestimates profit), at most ~17,100 above.
#[test]
fn bot_v4_protocol_fee_counter_answers_with_the_higher_gas() {
    let o = Opts { bot_shape: true, pm_bound: true, full_words: 8000, ..Opts::default() };
    let Some(mut w) = World::start_with(K::V4, o) else {
        eprintln!("copy2 coverage anvil test SKIPPED: no ~/.foundry/bin/anvil");
        return;
    };
    let p = w.pools[0].clone();
    let me = w.a.me;
    // Protocol fee on, both directions (0.1 % each; 12 bits per direction).
    let fee = U256::from(1000u32 | (1000u32 << 12));
    w.mine(&[(p.address, calldata("setProtocolFeeController(address)", &[Arg::A(me)]))]);
    w.mine(&[(
        p.address,
        calldata(
            "setProtocolFee((address,address,uint24,int24,address),uint24)",
            &[Arg::A(p.token0), Arg::A(p.token1), Arg::W(U256::from(p.fee)), Arg::I(p.tick_spacing as i128), Arg::A(Address::ZERO), Arg::W(fee)],
        ),
    )]);
    let counter = |w: &World, c: Address| -> U256 {
        let s = arbsim::copy2::checkview::protocol_fee_slot(c);
        u(&w.a.ok("eth_getStorageAt", json!([ha(p.address), hx64(s), "latest"])))
    };
    w.go_live();
    w.wait("tick walks", |w| w.walked());
    w.settle();
    // Counter zero on the chain: the copy's answer is exact (gas too).
    let n0 = w.block(&[]);
    w.settle();
    for _ in 0..3 {
        let _ = w.compare(n0, 100, true);
        w.settle();
    }
    assert!(counter(&w, w.uu).is_zero() && counter(&w, w.ww).is_zero());
    let mut exact0 = 0;
    for usd in [1_000u64, 20_000] {
        for dir in [true, false] {
            let (same, d) = w.compare(n0, usd, dir);
            assert_eq!(same, Some(true), "counter 0 on the chain: exact ({usd} USD, {dir}): {d}");
            exact0 += 1;
        }
    }
    // Trades: the counters become non-zero on the chain.
    trade_some(&mut w);
    let n = w.block(&[]);
    w.settle();
    assert!(!counter(&w, w.uu).is_zero() && !counter(&w, w.ww).is_zero(), "the protocol fee was charged");
    for _ in 0..3 {
        let _ = w.compare(n, 100, true);
        w.settle();
    }
    let (mut answered, mut unknown) = (0, 0);
    let mut extra: Vec<u64> = Vec::new();
    for usd in [1_000u64, 20_000, 150_000] {
        for dir in [true, false] {
            let (call, ov) = w.round_trip(usd, dir);
            let ans = w.ask(n, &call, &ov);
            if ans["ok"] != json!(true) {
                eprintln!("unknown ({usd} USD, {dir}): {ans}");
                unknown += 1;
                continue;
            }
            let r = &ans["results"][0];
            let (ts, to, tg) = w.truth(n, &call, &ov);
            assert_eq!(r["success"], json!(ts), "{ans}");
            assert_eq!(r["output"], json!(to), "success / output exact ({usd} USD, {dir})");
            let g = arbsim::check::hexutil::parse_u64(r["gasUsed"].as_str().unwrap()).unwrap();
            assert!(g >= tg, "gas never below the chain's: copy {g}, chain {tg}");
            assert!(g - tg <= 17_100, "at most one store's difference: copy {g}, chain {tg}");
            extra.push(g - tg);
            answered += 1;
        }
    }
    let st = w.h.status_json(false);
    eprintln!(
        "protocol fee: {exact0} exact with the counter 0; {answered} answered / {unknown} unknown with it non-zero, copy gas minus chain gas {extra:?}; counters checks {} same {} differ {}",
        st["counters"]["protocol_fee_checks"], st["counters"]["protocol_fee_same"], st["counters"]["protocol_fee_differ"]
    );
    assert_eq!(unknown, 0, "{st}");
    assert!(extra.iter().any(|x| *x == 17_100), "the costlier zero -> non-zero store is reported: {extra:?}");
    assert!(st["counters"]["protocol_fee_same"].as_u64().unwrap() >= 6);
    assert_eq!(st["counters"]["protocol_fee_differ"], json!(0));
    w.h.stop();
}

/// copy2-p (live Oct 22 16:19: checks ~120 ms): a check's PoolManager
/// balance bound is first summed over the pools the check itself traded on
/// (cheap); only if the two runs then differ is the check run again with
/// the full bound (every ready V4 pool), exactly the old way. Here: a
/// check that drains the test pool's USD side takes MORE than that pool's
/// own bound (rounding), so the route-only bound gives different runs; the
/// second, deep V4 pool on the same coins makes the full bound enough:
/// the check is answered, exactly as the chain does (and as before). Small
/// checks never need the full bound.
#[test]
fn bot_v4_route_bound_falls_back_to_the_full_bound() {
    // This test counts the confirming runs (route-only / full bound),
    // which LOSS FAST (server.rs) skips for zero-profit answers: off here.
    std::env::set_var("ARBSIM_LOSS_FAST", "0");
    // The test pool holds only token0 (every position above the price): a
    // check whose V4 hop pays token0 out can drain it.
    let o = Opts { bot_shape: true, pm_bound: true, full_words: 8000, second_v4: true, one_sided: true, thin: true, ..Opts::default() };
    let Some(mut w) = World::start_with(K::V4, o) else {
        eprintln!("copy2 coverage anvil test SKIPPED: no ~/.foundry/bin/anvil");
        return;
    };
    w.go_live();
    w.wait("tick walks", |w| w.walked());
    w.settle();
    let n = w.block(&[]);
    w.settle();
    // V4 first (USD in, WETH out) pays WETH; V3 first then V4 (WETH in,
    // USD out) pays USD: pick the one paying token0.
    let t0_is_weth = w.ww < w.uu;
    let dir = t0_is_weth;
    for _ in 0..3 {
        let _ = w.compare(n, 100, dir);
        w.settle();
    }
    let c = |w: &World, k: &str| w.h.status_json(false)["counters"][k].as_u64().unwrap_or(0);
    // Small checks: the route's own pool is enough.
    for usd in [100u64, 1_000] {
        let (same, d) = w.compare(n, usd, dir);
        assert_eq!(same, Some(true), "small check exact ({usd} USD): {d}");
    }
    assert_eq!(c(&w, "pm_bound_full_retry"), 0, "small checks never need the full bound");
    assert!(c(&w, "pm_bound_route_only") >= 2);
    // Bigger and bigger checks paying USD out of the test pool (V3 first,
    // then the V4 test pool sells WETH for USD): one drains its USD side.
    let (mut answered, mut retried_and_answered) = (0, 0);
    for usd in [10_000u64, 30_000, 100_000, 300_000, 1_000_000] {
        let before = c(&w, "pm_bound_full_retry");
        match w.compare(n, usd, dir) {
            (Some(same), d) => {
                assert!(same, "copy answer DIFFERS from the chain ({usd} USD): {d}");
                answered += 1;
                if c(&w, "pm_bound_full_retry") > before {
                    retried_and_answered += 1;
                }
                eprintln!("answered ({usd} USD): full bound needed {}: {}", c(&w, "pm_bound_full_retry") > before, d["copy"]["output"].as_str().unwrap_or("").get(..10).unwrap_or(""));
            }
            (None, a) => eprintln!("unknown ({usd} USD): {}", a["unknown"]),
        }
        w.settle();
    }
    let st = w.h.status_json(false);
    eprintln!(
        "route bound: answered {answered}, of which needed the full bound {retried_and_answered}; counters route-only {} full retry {} same {} differ {}",
        st["counters"]["pm_bound_route_only"], st["counters"]["pm_bound_full_retry"], st["counters"]["pm_bound_same"], st["counters"]["pm_bound_differ"]
    );
    assert!(retried_and_answered >= 1, "a drain of the test pool is answered with the full bound: {st}");
    w.h.stop();
}

/// copy2-r (live Oct 22 21:22-22:25, RIVN/USDG: copy 2 said "the trade
/// reverts" 4 times, the node AT THE SAME BLOCK "completes at a loss") and
/// copy2-s (after that fix, Oct 23 00:36: 53 of 74 checks "unknown:
/// pool_manager_balance"). Probed on the live chain (scripts/probe-rivn.ts):
/// USDG counts only the LOW 64 bits of its balance word (raw x + 2^k reads
/// back for k <= 63 only), supply 6.85e14 (~2^49.3). So "bound + 2^200" read
/// as the bound (copy2-r: a take slightly above the route's bound reverted
/// in both runs = a false revert), and copy2-r's candidates (2^200 ... 2^96)
/// all failed to read back (copy2-s: unknown). Now: the coin's own width is
/// found (binary search of the largest 2^k it reads back), the high value is
/// half of it, and it must be >= totalSupply x 2^8.
/// Here: USD = 64-bit coin, WETH = 128-bit coin; a drain of the test pool's
/// token0 side. The chain: InsufficientProfit. The copy must never say
/// "reverts": with a second V4 pool it answers exactly; without, "unknown";
/// with a USD supply too large for its field (> 2^54), "unknown" too.
fn coin_narrow_case(second_v4: bool, usd_mint: u64) -> Option<(usize, usize, Vec<String>, Value)> {
    let o = Opts { bot_shape: true, pm_bound: true, full_words: 8000, second_v4, one_sided: true, thin: true, narrow_usd_mint: Some(usd_mint), ..Opts::default() };
    let mut w = World::start_with(K::V4, o)?;
    w.go_live();
    w.wait("tick walks", |w| w.walked());
    w.settle();
    let n = w.block(&[]);
    w.settle();
    let dir = w.ww < w.uu; // the V4 hop pays token0 (the pool's only coin)
    for _ in 0..3 {
        let _ = w.compare(n, 100, dir);
        w.settle();
    }
    // The live mechanism on the chain itself: the USD coin reads "x + 2^64" as x.
    let pm = w.pools[0].address;
    let slot = map_slot(U256::from_be_slice(pm.as_slice()), U256::ZERO);
    let ov = json!({ ha(w.uu): { "stateDiff": { hx64(slot): hx64((U256::from(1u8) << 64usize) + U256::from(5u8)) } } });
    let seen = w.a.ok("eth_call", json!([{ "to": ha(w.uu), "data": hb(&[sel("balanceOf(address)").to_vec(), vec![0u8; 12], pm.as_slice().to_vec()].concat()) }, format!("{n:#x}"), ov]));
    assert_eq!(u(&seen), U256::from(5u8), "test setup: the USD coin counts only the low 64 bits");
    let (mut answered, mut unknown, mut whats) = (0, 0, Vec::new());
    for usd in [1_000u64, 10_000, 30_000, 100_000, 300_000, 1_000_000] {
        let (call, ov) = w.round_trip(usd, dir);
        let (ts, to, tg) = w.truth(n, &call, &ov);
        let mut ans = w.ask(n, &call, &ov);
        for _ in 0..3 {
            if ans["unknown"] != json!("miss") {
                break;
            }
            w.settle();
            ans = w.ask(n, &call, &ov);
        }
        whats.push(format!("{usd}: {} {}", ans["t"]["what"], ans["detail"].as_str().unwrap_or("")));
        if ans["ok"] == json!(true) {
            let r = &ans["results"][0];
            assert_eq!((r["success"].clone(), r["output"].clone(), r["gasUsed"].clone()), (json!(ts), json!(to), json!(format!("{tg:#x}"))), "copy answer DIFFERS from the chain ({usd} USD, chain {}): {ans}", &to[..10.min(to.len())]);
            answered += 1;
        } else {
            assert_eq!(ans["unknown"], json!("pool_manager_balance"), "{ans}");
            unknown += 1;
        }
        w.settle();
    }
    let st = w.h.status_json(false);
    w.h.stop();
    Some((answered, unknown, whats, st))
}

#[test]
fn bot_v4_coin_counting_part_of_its_balance_word_never_gives_a_false_revert() {
    // 5e15 USD base units per trader (supply ~1e16 = 2^53.2: x 2^8 fits
    // under the 64-bit field's half, 2^62).
    let Some((a, u, whats, st)) = coin_narrow_case(true, 5_000_000_000_000_000) else {
        eprintln!("copy2 coverage anvil test SKIPPED: no ~/.foundry/bin/anvil");
        return;
    };
    eprintln!("narrow coins, second V4 pool: {a} answered exactly, {u} unknown; runs {whats:#?}; counters narrow {} refused {} full retry {}", st["counters"]["pm_high_narrow"], st["counters"]["pm_high_refused"], st["counters"]["pm_bound_full_retry"]);
    assert_eq!(u, 0, "all answered: {whats:#?}");
    assert!(st["counters"]["pm_high_narrow"].as_u64().unwrap() > 0, "the high run used the coin's own range: {st}");
    assert!(st["counters"]["pm_bound_full_retry"].as_u64().unwrap() > 0, "a drain needed the full bound: {st}");
    let (a, u, whats, _) = coin_narrow_case(false, 5_000_000_000_000_000).unwrap();
    eprintln!("narrow coins, one V4 pool: {a} answered exactly, {u} unknown; runs {whats:#?}");
    // (Its only pool holds none of the coin paid in: bound 0, a 0 -> non-zero
    // store costs more gas than at any real balance: unknown, never wrong.)
    assert!(u >= 1, "unknown, never a revert ({a} answered)");
    // Supply too big for the field's half (2e17 = 2^57.5, x 2^8 > 2^62).
    let (a, u, whats, st) = coin_narrow_case(true, 100_000_000_000_000_000).unwrap();
    eprintln!("narrow coins, big supply: {a} answered, {u} unknown; runs {whats:#?}");
    assert!(u >= 1 && st["counters"]["pm_high_refused"].as_u64().unwrap() > 0, "{st}");
}
