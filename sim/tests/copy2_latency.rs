// ============================================================================
// COPY 2 CHECK SPEED ON A PRACTICE CHAIN (live Oct 22 16:19-17:35 UTC: the
// bot measured its fast check at p50 63 ms / p90 122 ms, slower than the
// node; the whole point of copy 2 is ~10 ms).
//
// Plain English:
//   A private practice chain (anvil) with the live shape, smaller or full
//   size: one V4 PoolManager with "stock coin / USDG" pools (some with a
//   protocol fee on, like the live stock pools), the same pairs as Uniswap
//   V3 pools (with long price histories, so the copy holds many walked
//   values), plus the USDG / WETH pair on both. Copy 2 follows all of them
//   exactly like live: its own thread, loader threads asking the chain,
//   tick walks, the bot's report shape (no PoolManager coin transfers).
//   While a "block maker" thread trades on random pools ~9 blocks a second
//   and passes each block on (like the bot), a "bot" sends its real check
//   (our contract's 2-pool round trip, V3 then V4 or back) over arbsim's
//   REAL socket server and times each answer, like the bot does. A few
//   answers are compared with the chain itself (never a wrong answer).
//
//   Printed: the bot-side time (p50 / p90 / p99 / max) and arbsim's own
//   split (queue / prep / resolve / facts / each EVM run / post), block
//   apply times and lock holds.
//
//   The normal test (small: 24 pairs = 50 pools) FAILS if the bot-side p50
//   is above COPY2_LAT_MAX_P50_MS (default 10 ms) or p99 above
//   COPY2_LAT_MAX_P99_MS (default 40 ms).
//   Full size (live: ~650 pools):
//     COPY2_LAT_PAIRS=320 COPY2_LAT_CHECKS=300 cargo test --release \
//       --test copy2_latency -- --nocapture
//   Skipped (passes with a note) when anvil isn't installed.
// ============================================================================
mod copy2_util;
#[allow(dead_code)]
mod check_util;

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use arbsim::check::{run_calls, CallReq, Overrides};
use arbsim::copy2::intake::{manual, BlockMsg, C2Config, Copy2Handle, PoolState};
use arbsim::copy2::{PoolKind, PoolLog, TrackedPool};
use arbsim::node::{CallResult, Class, NodeApi, NodeErr, RpcErr};
use arbsim::server::Ctx;
use arbsim::state::fill::FillQueue;
use arbsim::state::mirror::{Config, Shared};
use arbsim::state::pinned::PinnedCache;
use arbsim::state::snap::Volatile;
use copy2_util::*;
use revm::primitives::{Address, Bytes, B256, U256};
use serde_json::{json, Value};

const SIM_EXECUTOR: Address = Address::new([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xa7, 0xb5, 0x1e, 0x00]);
const SIM_CALLER: Address = Address::new([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x0b, 0x07, 0x51]);

fn env_n(k: &str, d: u64) -> u64 {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

fn q(n: u32) -> U256 {
    U256::from(10u8).pow(U256::from(n))
}

/// The practice chain as "the node".
struct Node {
    a: Arc<Anvil>,
}

impl NodeApi for Node {
    fn call_batch(&self, _c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
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

/// tick of a raw price (token1 units per token0 unit), rounded down to spacing.
fn tick_of(sqrt_x96: U256, spacing: i64) -> i64 {
    let s = sqrt_x96.to::<u128>() as f64 / 2f64.powi(96);
    let t = ((s * s).ln() / 1.0001f64.ln()).floor() as i64;
    t.div_euclid(spacing) * spacing
}

/// One pair: the same two coins as a V3 pool and a V4 pool.
#[derive(Clone)]
struct Pair {
    coin: Address,
    usd: Address,
    v3: TrackedPool,
    v4: TrackedPool,
    /// Whole coins per... price of 1 coin in USD.
    price: f64,
}

struct World {
    a: Arc<Anvil>,
    pm: Address,
    vt: Address,
    plain: Address,
    usd: Address,
    weth: Address,
    pairs: Vec<Pair>,
    runtime: String,
}

/// Send many transactions and mine them in blocks of `per` (fast setup).
fn send_all(a: &Anvil, txs: &[(Address, Vec<u8>)], per: usize) {
    for chunk in txs.chunks(per.max(1)) {
        let hs: Vec<B256> = chunk.iter().map(|(to, d)| a.send(Some(*to), d).unwrap()).collect();
        a.ok("evm_mine", json!([]));
        for h in hs {
            assert_eq!(a.receipt(h)["status"], "0x1", "setup transaction failed");
        }
    }
}

fn build_world(pairs: usize) -> Option<World> {
    let a = Arc::new(Anvil::start()?);
    a.ok("evm_setAutomine", json!([false]));
    let arts = artifacts();
    let tok = art(&arts, "Token");
    let deploy = |init: &str, args: &[u8]| -> Address {
        let h = a.send(None, &[arbsim::check::hexutil::parse_bytes(init).unwrap().to_vec(), args.to_vec()].concat()).unwrap();
        a.ok("evm_mine", json!([]));
        let r = a.receipt(h);
        assert_eq!(r["status"], "0x1");
        arbsim::check::hexutil::parse_address(r["contractAddress"].as_str().unwrap()).unwrap()
    };
    let usd = deploy(&tok, &encode(&[Arg::D(b"USDG".to_vec()), Arg::W(U256::from(6))]));
    let weth = deploy(&tok, &encode(&[Arg::D(b"WETH".to_vec()), Arg::W(U256::from(18))]));
    let plain = deploy(&art(&arts, "Trader"), &[]);
    let pm = deploy(&art(&arts, "PoolManager"), &encode(&[Arg::A(a.me)]));
    let vt = deploy(&art(&arts, "V4Trader"), &encode(&[Arg::A(pm)]));
    let f = deploy(&art(&arts, "UniswapV3Factory"), &[]);
    // Coins: pair 0 is WETH / USDG (the busiest live pair), the rest "stock" coins.
    let mut coins = vec![(weth, 2500.0)];
    let mut txs = Vec::new();
    for i in 1..pairs {
        let h = a.send(None, &[arbsim::check::hexutil::parse_bytes(&tok).unwrap().to_vec(), encode(&[Arg::D(format!("S{i}").into_bytes()), Arg::W(U256::from(18))])].concat()).unwrap();
        txs.push(h);
        if txs.len() >= 200 {
            a.ok("evm_mine", json!([]));
            for h in txs.drain(..) {
                let r = a.receipt(h);
                coins.push((arbsim::check::hexutil::parse_address(r["contractAddress"].as_str().unwrap()).unwrap(), 20.0 + (i as f64 * 7.3) % 400.0));
            }
        }
    }
    a.ok("evm_mine", json!([]));
    for h in txs.drain(..) {
        let r = a.receipt(h);
        let i = coins.len();
        coins.push((arbsim::check::hexutil::parse_address(r["contractAddress"].as_str().unwrap()).unwrap(), 20.0 + (i as f64 * 7.3) % 400.0));
    }
    // Money for the traders, the protocol fee controller.
    let mut setup = Vec::new();
    for (c, _) in coins.iter().chain([(usd, 1.0)].iter()) {
        for t in [plain, vt] {
            setup.push((*c, calldata("mint(address,uint256)", &[Arg::A(t), Arg::W(q(40))])));
        }
    }
    setup.push((pm, calldata("setProtocolFeeController(address)", &[Arg::A(a.me)])));
    send_all(&a, &setup, 400);
    // Pools: createPool (V3), then initialize both, then positions.
    let mut creates = Vec::new();
    for (c, _) in &coins {
        creates.push((f, calldata("createPool(address,address,uint24)", &[Arg::A(*c), Arg::A(usd), Arg::W(U256::from(3000))])));
    }
    send_all(&a, &creates, 100);
    let mut out = Vec::new();
    let mut inits = Vec::new();
    for (i, (c, price)) in coins.iter().enumerate() {
        let r = a.call(f, &calldata("getPool(address,address,uint24)", &[Arg::A(*c), Arg::A(usd), Arg::W(U256::from(3000))])).unwrap();
        let v3a = Address::from_slice(&r[12..32]);
        let (t0, t1) = if *c < usd { (*c, usd) } else { (usd, *c) };
        let sp = sqrt_price_for(*price, usd, *c);
        // V4: pair 0 like the live USDG / WETH pool (0.05 %, spacing 10),
        // stock pools 0.3 % / spacing 60.
        let (fee, spacing) = if i == 0 { (500u32, 10i32) } else { (3000, 60) };
        let v3 = TrackedPool { address: v3a, v4_id: None, kind: PoolKind::V3, token0: t0, token1: t1, fee: 3000, tick_spacing: 60 };
        let mut v4 = TrackedPool { address: pm, v4_id: None, kind: PoolKind::V4, token0: t0, token1: t1, fee, tick_spacing: spacing };
        v4.v4_id = Some(arbsim::copy2::replay::v4_pool_id(&v4));
        inits.push((v3a, calldata("initialize(uint160)", &[Arg::W(sp)])));
        // Long price history: the walk reads it (live pools hold ~400 walked values each).
        inits.push((v3a, calldata("increaseObservationCardinalityNext(uint16)", &[Arg::W(U256::from(150))])));
        let key = |p: &TrackedPool| vec![Arg::A(p.token0), Arg::A(p.token1), Arg::W(U256::from(p.fee)), Arg::I(p.tick_spacing as i128), Arg::A(Address::ZERO)];
        let mut init4 = key(&v4);
        init4.push(Arg::W(sp));
        inits.push((pm, calldata("initialize((address,address,uint24,int24,address),uint160)", &init4)));
        // Protocol fee on half of the V4 pools (live: the stock pools the bot checks most).
        if i % 2 == 0 {
            let mut k = key(&v4);
            k.push(Arg::W(U256::from(1000u32 | (1000u32 << 12))));
            inits.push((pm, calldata("setProtocolFee((address,address,uint24,int24,address),uint24)", &k)));
        }
        out.push(Pair { coin: *c, usd, v3, v4, price: *price });
    }
    send_all(&a, &inits, 300);
    let mut pos = Vec::new();
    for p in &out {
        let sp = sqrt_price_for(p.price, usd, p.coin);
        for (pool, spacing) in [(&p.v3, 60i64), (&p.v4, p.v4.tick_spacing as i64)] {
            let b = tick_of(sp, spacing);
            for k in 1..=6i64 {
                let (lo, hi) = (b - spacing * 8 * k * k, b + spacing * 7 * k * k + spacing);
                let liq = q(14) * U256::from((k % 3 + 1) as u64);
                if pool.kind == PoolKind::V4 {
                    pos.push((
                        vt,
                        calldata(
                            "modify((address,address,uint24,int24,address),int24,int24,int256,bytes32)",
                            &[Arg::A(pool.token0), Arg::A(pool.token1), Arg::W(U256::from(pool.fee)), Arg::I(pool.tick_spacing as i128), Arg::A(Address::ZERO), Arg::I(lo as i128), Arg::I(hi as i128), Arg::W(liq), Arg::W(U256::ZERO)],
                        ),
                    ));
                } else {
                    pos.push((plain, calldata("mintV3(address,int24,int24,uint128)", &[Arg::A(pool.address), Arg::I(lo as i128), Arg::I(hi as i128), Arg::W(liq)])));
                }
            }
        }
    }
    send_all(&a, &pos, 300);
    Some(World { a, pm, vt, plain, usd, weth, pairs: out, runtime: arb_executor_runtime() })
}

impl World {
    fn all_pools(&self) -> Vec<TrackedPool> {
        self.pairs.iter().flat_map(|p| [p.v3.clone(), p.v4.clone()]).collect()
    }

    /// A trade on pair i's V3 or V4 pool (small, random direction).
    fn trade(&self, i: usize, v4: bool, coin_in: bool, usd_amt: f64) -> (Address, Vec<u8>) {
        let p = &self.pairs[i];
        let amt = if coin_in { U256::from((usd_amt / p.price * 1e18) as u128) } else { U256::from((usd_amt * 1e6) as u128) };
        let zfo = (if coin_in { p.coin } else { p.usd }) == p.v3.token0;
        if v4 {
            let k = &p.v4;
            (
                self.vt,
                calldata(
                    "swap((address,address,uint24,int24,address),bool,int256,uint160)",
                    &[Arg::A(k.token0), Arg::A(k.token1), Arg::W(U256::from(k.fee)), Arg::I(k.tick_spacing as i128), Arg::A(Address::ZERO), Arg::B(zfo), Arg::W(U256::ZERO.wrapping_sub(amt)), Arg::W(U256::ZERO)],
                ),
            )
        } else {
            (self.plain, calldata("swapV3(address,bool,int256,uint160)", &[Arg::A(p.v3.address), Arg::B(zfo), Arg::W(amt), Arg::W(U256::ZERO)]))
        }
    }

    /// The bot's check: USD -> coin on one pool, coin -> USD on the other.
    fn round_trip(&self, i: usize, usd_amt: u64, v3_first: bool) -> (CallReq, Value) {
        let p = &self.pairs[i];
        let s = sel("execute((address,uint256,uint256,uint256,(uint8,address,address,address,uint16,uint24,int24,bool)[]),address)");
        let v3h = |tin, tout| hop_words(2, p.v3.address, tin, tout, 0, 0);
        let v4h = |tin, tout| hop_words(3, p.v4.address, tin, tout, p.v4.fee, p.v4.tick_spacing);
        let hops = if v3_first { vec![v3h(p.usd, p.coin), v4h(p.coin, p.usd)] } else { vec![v4h(p.usd, p.coin), v3h(p.coin, p.usd)] };
        let amt = U256::from(usd_amt) * q(6);
        let mut d = s.to_vec();
        let mut words = vec![U256::from(0x40), U256::ZERO];
        words.extend([U256::from_be_slice(p.usd.as_slice()), amt, U256::MAX, U256::MAX, U256::from(0xa0), U256::from(hops.len())]);
        for h in &hops {
            words.extend(h.iter().copied());
        }
        for w in words {
            d.extend_from_slice(&w.to_be_bytes::<32>());
        }
        let exec_diff = json!({
            hx64(U256::ZERO): hx64(U256::from_be_slice(SIM_CALLER.as_slice())),
            hx64(U256::from(6)): hx64(U256::from_be_slice(self.pm.as_slice())),
            hx64(U256::from(7)): hx64(U256::from_be_slice(self.weth.as_slice())),
        });
        let bal = map_slot(U256::from_be_slice(SIM_EXECUTOR.as_slice()), U256::ZERO);
        let ov = json!({
            ha(SIM_EXECUTOR): { "code": self.runtime, "stateDiff": exec_diff },
            ha(p.usd): { "stateDiff": { hx64(bal): hx64(amt) } },
        });
        (CallReq { from: SIM_CALLER, to: Some(SIM_EXECUTOR), data: Bytes::from(d), gas: Some(8_000_000), value: U256::ZERO }, ov)
    }

    /// The block's reports in the bot's shape (no PoolManager coin transfers).
    fn reports(&self, n: u64, pools: &HashSet<Address>, ids: &HashSet<B256>) -> Vec<PoolLog> {
        let logs = self.a.ok("eth_getLogs", json!([{ "fromBlock": format!("{n:#x}"), "toBlock": format!("{n:#x}") }]));
        let side = |t: &B256| Address::from_slice(&t.as_slice()[12..]);
        logs.as_array()
            .unwrap()
            .iter()
            .map(to_pool_log)
            .filter(|l| {
                (l.address == self.pm && l.topics.get(1).is_some_and(|t| ids.contains(t)))
                    || (l.address != self.pm && pools.contains(&l.address))
                    || (l.topics.len() == 3 && l.topics[0] == transfer_topic() && (pools.contains(&side(&l.topics[1])) || pools.contains(&side(&l.topics[2]))))
            })
            .collect()
    }
}

fn transfer_topic() -> B256 {
    revm::primitives::keccak256(b"Transfer(address,address,uint256)")
}

fn msg_for(a: &Anvil, n: u64, prev: Option<u64>, logs: Vec<PoolLog>) -> BlockMsg {
    let ts = u64v(&a.ok("eth_getBlockByNumber", json!([format!("{n:#x}"), false]))["timestamp"]);
    BlockMsg { block: n, timestamp: ts, l1_block: Some(n), base_fee: Some(0), prev_block: prev, tick: logs.is_empty(), logs, gap_reason: None, bloom: None }
}

/// Talk to arbsim's socket like the bot (4-byte length + JSON).
struct Client {
    s: UnixStream,
    id: u64,
}

impl Client {
    /// A one-way message (no answer), e.g. `feed_put`.
    fn tell(&mut self, v: &Value) {
        let body = serde_json::to_vec(v).unwrap();
        self.s.write_all(&(body.len() as u32).to_be_bytes()).unwrap();
        self.s.write_all(&body).unwrap();
    }

    fn ask(&mut self, mut v: Value) -> Value {
        self.id += 1;
        v["id"] = json!(self.id);
        let body = serde_json::to_vec(&v).unwrap();
        self.s.write_all(&(body.len() as u32).to_be_bytes()).unwrap();
        self.s.write_all(&body).unwrap();
        loop {
            let mut len = [0u8; 4];
            self.s.read_exact(&mut len).unwrap();
            let mut b = vec![0u8; u32::from_be_bytes(len) as usize];
            self.s.read_exact(&mut b).unwrap();
            let a: Value = serde_json::from_slice(&b).unwrap();
            if a["id"] == json!(self.id) {
                return a;
            }
        }
    }
}

fn pctl(v: &mut [f64], p: f64) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[(((v.len() - 1) as f64) * p).round() as usize]
}

fn line(name: &str, v: &mut [f64]) -> String {
    format!("{name:>16}: p50 {:7.2}  p90 {:7.2}  p99 {:7.2}  max {:7.2}", pctl(v, 0.5), pctl(v, 0.9), pctl(v, 0.99), pctl(v, 1.0))
}

struct Results {
    bot_ms: Vec<f64>,
    /// Bot-side time of the checks the copy answered (the goal's numbers).
    answered_ms: Vec<f64>,
    /// Checks asked while the copy's thread held a lock for 300 ms.
    held_ms: Vec<f64>,
    answered: usize,
    unknown: HashMap<String, usize>,
    compared: usize,
    report: String,
}

fn bench(pairs: usize, checks: usize) -> Option<Results> {
    let t_setup = Instant::now();
    let w = Arc::new(build_world(pairs)?);
    let a = w.a.clone();
    let pools = w.all_pools();
    eprintln!("[bench] practice chain ready: {} pools in {:.1} s", pools.len(), t_setup.elapsed().as_secs_f64());
    // The copy (live settings: Config / C2Config from the environment).
    let node: Arc<dyn NodeApi> = Arc::new(Node { a: a.clone() });
    let mut cfg = Config::from_env();
    cfg.l2_offset = 0;
    cfg.max_stale_ms = 3_600_000;
    let sh = Shared::new(cfg, Some(node), Arc::new(Volatile::default()));
    let mut c2cfg = C2Config::from_env();
    c2cfg.walk_max_rss_mb = 0;
    let fills = Arc::new(FillQueue::new(20_000, 20_000));
    let (mut intake, h): (_, Copy2Handle) = manual(sh.clone(), fills.clone(), c2cfg);
    let (_u, updater) = arbsim::state::updater::manual(sh.clone(), fills.clone());
    let ctx = Arc::new(Ctx { shared: sh.clone(), updater, fills, pinned: PinnedCache::new(2), copy2: Some(h.clone()) });
    let mut slots = serde_json::Map::new();
    let mut coins: Vec<Address> = w.pairs.iter().map(|p| p.coin).collect();
    coins.push(w.usd);
    for c in &coins {
        slots.insert(ha(*c), json!({"layout": "solidity", "slot": 0}));
    }
    h.coin_slots_json(&json!(1), &json!({"type": "coin_slots", "coinSlots": slots}));
    let list: Vec<Value> = pools
        .iter()
        .map(|p| json!({"address": ha(p.address), "kind": kind_str(p.kind), "token0": ha(p.token0), "token1": ha(p.token1), "fee": p.fee, "tickSpacing": p.tick_spacing, "v4Id": p.v4_id.map(|i| format!("{i}"))}))
        .collect();
    assert_eq!(h.track_json(&json!(2), &json!({ "pools": list }))["ok"], json!(true));
    let addr_set: HashSet<Address> = pools.iter().filter(|p| p.v4_id.is_none()).map(|p| p.address).collect();
    let ids: HashSet<B256> = pools.iter().filter_map(|p| p.v4_id).collect();
    // Start: the copy loads every pool and walks its ticks (intake driven here).
    let mut ts = u64v(&a.ok("eth_getBlockByNumber", json!(["latest", false]))["timestamp"]);
    let start = a.block_number();
    h.block(msg_for(&a, start, None, vec![]));
    let mut last_sent = start;
    let t_load = Instant::now();
    loop {
        intake.pump();
        let (ready, walked) = {
            let reg = h.c2.reg.read().unwrap();
            (reg.pools.values().filter(|e| e.state == PoolState::Ready).count(), reg.pools.values().filter(|e| e.walk.as_ref().is_some_and(|x| x.done)).count())
        };
        if ready == pools.len() && walked == pools.len() && intake.outstanding() == 0 {
            break;
        }
        assert!(t_load.elapsed() < Duration::from_secs(600), "copy never got ready: {}", h.status_json(false));
        std::thread::sleep(Duration::from_millis(2));
    }
    eprintln!("[bench] copy ready + walked in {:.1} s; status {}", t_load.elapsed().as_secs_f64(), json!({"poolCoverage": h.status_json(false)["poolCoverage"]}));
    // From here everything runs like live: the copy's own thread, the
    // socket server with its workers, a block maker, the "bot".
    let stop = Arc::new(AtomicBool::new(false));
    // COPY2_LAT_HOG=N: N threads burning CPU (live: the bot shares the
    // server's 2 vCPUs with arbsim).
    for _ in 0..env_n("COPY2_LAT_HOG", 0) {
        let stop = stop.clone();
        std::thread::spawn(move || {
            let mut x: u64 = 1;
            while !stop.load(Ordering::Relaxed) {
                for _ in 0..100_000 {
                    x = x.wrapping_mul(6364136223846793005).wrapping_add(1);
                }
                std::hint::black_box(x);
            }
        });
    }
    let intake_t = std::thread::spawn(move || intake.run());
    let sock = format!("{}/arbsim-lat-{}.sock", std::env::temp_dir().display(), std::process::id());
    let listener = arbsim::server::bind(&sock).unwrap();
    {
        let ctx = ctx.clone();
        std::thread::spawn(move || arbsim::server::run(ctx, listener));
    }
    let sent = Arc::new(AtomicU64::new(last_sent));
    let maker = {
        let (w, h, stop, sent) = (w.clone(), h.clone(), stop.clone(), sent.clone());
        let a = a.clone();
        std::thread::spawn(move || {
            let mut rng = Rng::new(7);
            let block_ms = env_n("COPY2_LAT_BLOCK_MS", 110);
            while !stop.load(Ordering::Relaxed) {
                let t0 = Instant::now();
                let n_tx = rng.int(0, 3) as usize;
                let txs: Vec<(Address, Vec<u8>)> = (0..n_tx)
                    .map(|_| {
                        let i = rng.int(0, w.pairs.len() as i64 - 1) as usize;
                        w.trade(i, rng.next() < 0.5, rng.next() < 0.5, 50.0 + rng.next() * 3000.0)
                    })
                    .collect();
                let hs: Vec<B256> = txs.iter().map(|(to, d)| a.send(Some(*to), d).unwrap()).collect();
                ts += 1;
                a.ok("evm_setNextBlockTimestamp", json!([ts]));
                a.ok("evm_mine", json!([]));
                let _ = hs;
                let n = a.block_number();
                let logs = w.reports(n, &addr_set, &ids);
                h.block(msg_for(&a, n, Some(last_sent), logs));
                last_sent = n;
                sent.store(n, Ordering::Relaxed);
                let el = t0.elapsed();
                if el < Duration::from_millis(block_ms) {
                    std::thread::sleep(Duration::from_millis(block_ms) - el);
                }
            }
        })
    };
    // The bot.
    let mut cl = Client { s: UnixStream::connect(&sock).unwrap(), id: 0 };
    let mut rng = Rng::new(11);
    let ask = |cl: &mut Client, i: usize, usd: u64, v3_first: bool, n: u64| -> (Value, f64, CallReq, Value) {
        let (call, ov) = w.round_trip(i, usd, v3_first);
        let req = json!({"type": "call", "at": {"block": format!("{n:#x}")}, "overrides": ov, "calls": [{
            "from": ha(call.from), "to": ha(call.to.unwrap()), "data": hb(&call.data), "gas": format!("{:#x}", call.gas.unwrap())}]});
        let t = Instant::now();
        let ans = cl.ask(req);
        (ans, t.elapsed().as_secs_f64() * 1000.0, call, ov)
    };
    // Warm-up: the check's own values (our contract's coin balances...) are
    // fetched the first time; every pair once, until answered.
    let t_warm = Instant::now();
    let (mut wn, mut wms, mut wmax) = (0usize, 0f64, 0f64);
    let mut wwhy: HashMap<String, usize> = HashMap::new();
    for i in 0..w.pairs.len() {
        for v3_first in [true, false] {
            for _ in 0..40 {
                let n = sent.load(Ordering::Relaxed);
                let (ans, ms, _, _) = ask(&mut cl, i, 500, v3_first, n);
                wn += 1;
                wms += ms;
                wmax = wmax.max(ms);
                if wn % 200 == 1 {
                    eprintln!("[bench] warm-up check {wn}: {ms:.1} ms, t {}", ans["t"]);
                }
                *wwhy.entry(ans["unknown"].as_str().unwrap_or("ok").to_string()).or_default() += 1;
                if ans["ok"] == json!(true) || !["miss", "dirty", "not_ready", "pending_reports"].contains(&ans["unknown"].as_str().unwrap_or("")) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(30));
            }
        }
    }
    eprintln!("[bench] warm-up {:.1} s: {wn} checks, avg {:.1} ms, max {wmax:.1} ms, {wwhy:?}", t_warm.elapsed().as_secs_f64(), wms / wn.max(1) as f64);
    arbsim::timing::reset();
    let mut r = Results { bot_ms: Vec::new(), answered_ms: Vec::new(), held_ms: Vec::new(), answered: 0, unknown: HashMap::new(), compared: 0, report: String::new() };
    let mut steps: HashMap<&str, Vec<f64>> = HashMap::new();
    let gap_ms = env_n("COPY2_LAT_GAP_MS", 40);
    for k in 0..checks {
        let i = rng.int(0, w.pairs.len() as i64 - 1) as usize;
        let usd = [100u64, 500, 2_000, 10_000][rng.int(0, 3) as usize];
        // Like the bot: the newest block it passed on.
        let n = sent.load(Ordering::Relaxed);
        let (ans, ms, call, ov) = ask(&mut cl, i, usd, rng.next() < 0.5, n);
        r.bot_ms.push(ms);
        let t = &ans["t"];
        for (name, key) in [("queue", "queue"), ("prep", "prep"), ("resolve", "resolve"), ("facts", "facts"), ("post", "post")] {
            steps.entry(name).or_default().push(t[key].as_f64().unwrap_or(0.0) / 1000.0);
        }
        let runs: Vec<f64> = t["runs"].as_array().map(|v| v.iter().map(|x| x.as_f64().unwrap() / 1000.0).collect()).unwrap_or_default();
        steps.entry("runs (count)").or_default().push(runs.len() as f64);
        steps.entry("runs (sum)").or_default().push(runs.iter().sum());
        steps.entry("one run").or_default().extend(runs.iter().copied());
        steps.entry("inside arbsim").or_default().push(ans["us"].as_f64().unwrap_or(0.0) / 1000.0 + t["queue"].as_f64().unwrap_or(0.0) / 1000.0);
        if ans["ok"] == json!(true) {
            r.answered += 1;
            r.answered_ms.push(ms);
            // The bot's size search (on mode, after a sure answer): every 4th.
            if k % 4 == 0 {
                let amt = U256::from(usd) * q(6);
                let bal = map_slot(U256::from_be_slice(SIM_EXECUTOR.as_slice()), U256::ZERO);
                let req = json!({"type": "size_search", "at": {"block": format!("{n:#x}")}, "overrides": ov,
                    "template": {"from": ha(call.from), "to": ha(call.to.unwrap()), "data": hb(&call.data), "gas": format!("{:#x}", call.gas.unwrap())},
                    "amountOffset": 96, "amountSlots": [{"account": ha(w.pairs[i].usd), "slot": hx64(bal)}],
                    "range": {"lo": hx(amt / U256::from(8)), "hi": hx(amt), "steps": 10}});
                let t = Instant::now();
                let sa = cl.ask(req);
                steps.entry("size_search").or_default().push(t.elapsed().as_secs_f64() * 1000.0);
                steps.entry("search runs").or_default().push(sa["t"]["runs"].as_array().map(|v| v.len()).unwrap_or(0) as f64);
                if sa["ok"] != json!(true) {
                    *r.unknown.entry(format!("size_search {}", sa["unknown"].as_str().unwrap_or("?"))).or_default() += 1;
                }
            }
            // Every 5th answer: compared with the chain itself.
            if k % 5 == 0 {
                let vctx = sh.published.read().unwrap().versions.iter().find(|v| v.block == n).and_then(|v| v.ctx.clone());
                if let Some(vctx) = vctx {
                    let rv = RemoteView::new(&a, n);
                    let o = Overrides::from_json(&ov).unwrap();
                    let x = run_calls(&rv, &vctx, &o, &[], std::slice::from_ref(&call)).expect("truth").into_iter().next().unwrap();
                    let res = &ans["results"][0];
                    assert_eq!(res["success"], json!(x.success), "copy vs chain: {ans}");
                    assert_eq!(res["output"], json!(hb(&x.output)), "copy vs chain output: {ans}");
                    let g = arbsim::check::hexutil::parse_u64(res["gasUsed"].as_str().unwrap()).unwrap();
                    assert!(g >= x.gas_used && g - x.gas_used <= 17_100, "gas: copy {g}, chain {}", x.gas_used);
                    r.compared += 1;
                }
            }
        } else {
            *r.unknown.entry(ans["unknown"].as_str().unwrap_or("?").to_string()).or_default() += 1;
        }
        std::thread::sleep(Duration::from_millis(gap_ms));
    }
    // SPEED-3: the trigger-first "which pools does it move?" question on
    // real pool contracts (COPY2_LAT_DISCOVER questions, 0 = skip).
    let disc_n = env_n("COPY2_LAT_DISCOVER", 60) as usize;
    let disc_report = if disc_n > 0 { discover_bench(&w, &mut cl, &sent, &a, disc_n) } else { String::new() };
    // copy2-q (live: 484 lock holds over 1 ms, up to 197 ms, and checks
    // waited): while the copy's thread holds the published versions or the
    // pool registry for 300 ms, checks still answer at once.
    for which in ["published", "registry"] {
        let (sh2, h2) = (sh.clone(), h.clone());
        let held = Arc::new(AtomicBool::new(false));
        let held2 = held.clone();
        let t = std::thread::spawn(move || {
            if which == "published" {
                let _g = sh2.published.write().unwrap();
                held2.store(true, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(300));
            } else {
                let _g = h2.c2.reg.write().unwrap();
                held2.store(true, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(300));
            }
        });
        // A block the copy has applied already (while the copy's thread is
        // held, newer blocks wait: those checks rightly answer "dirty"
        // after ARBSIM_WAIT_MS).
        let n = h.c2.last_block.load(Ordering::SeqCst);
        while !held.load(Ordering::SeqCst) {
            std::thread::yield_now();
        }
        for _ in 0..5 {
            let i = rng.int(0, w.pairs.len() as i64 - 1) as usize;
            let (ans, ms, _, _) = ask(&mut cl, i, 500, true, n);
            r.held_ms.push(ms);
            eprintln!("[bench] check while the copy holds the {which} lock: {ms:.1} ms ({})", ans["unknown"].as_str().unwrap_or("answered"));
        }
        t.join().unwrap();
    }
    let st = cl.ask(json!({"type": "status"}));
    stop.store(true, Ordering::Relaxed);
    maker.join().unwrap();
    h.stop();
    let _ = intake_t.join();
    let _ = std::fs::remove_file(&sock);
    let mut rep = format!(
        "[bench] {} pools ({} pairs), {} checks, workers {}: answered {}, unknown {:?}, compared with the chain {}\n",
        pools.len(),
        w.pairs.len(),
        checks,
        env_n("ARBSIM_WORKERS", 2),
        r.answered,
        r.unknown,
        r.compared
    );
    rep += &format!("{}   (ms, all checks)\n", line("bot-side answer", &mut r.bot_ms.clone()));
    rep += &format!("{}   (ms, answered checks)\n", line("bot-side answered", &mut r.answered_ms.clone()));
    for k in ["inside arbsim", "queue", "prep", "resolve", "facts", "runs (count)", "runs (sum)", "one run", "post", "size_search", "search runs"] {
        rep += &format!("{}\n", line(k, steps.get_mut(k).map(|v| v.as_mut_slice()).unwrap_or(&mut [])));
    }
    let c = &st["copy2"]["counters"];
    rep += &format!(
        "  pm bound: checks {} same {} differ {} route-only {} full retry {}; protocol fee checks {} same {} differ {}\n",
        c["pm_bound_checks"], c["pm_bound_same"], c["pm_bound_differ"], c["pm_bound_route_only"], c["pm_bound_full_retry"], c["protocol_fee_checks"], c["protocol_fee_same"], c["protocol_fee_differ"]
    );
    rep += &format!("  applyTiming (us) {}\n  lockHold (us) {}\n  walked slots {} rss {} MB", st["applyTiming"], st["lockHold"], st["copy2"]["poolCoverage"]["walkSlots"], st["rssMb"]);
    rep += &disc_report;
    eprintln!("{rep}");
    r.report = rep;
    Some(r)
}

/// anvil / hardhat test accounts #0 (deployer, holds nothing the trigger
/// uses) and #1 (filler transactions). Public test keys, no real funds.
const KEY0: [u8; 32] = [
    0xac, 0x09, 0x74, 0xbe, 0xc3, 0x9a, 0x17, 0xe3, 0x6b, 0xa4, 0xa6, 0xb4, 0xd2, 0x38, 0xff, 0x94, 0x4b, 0xac, 0xb4,
    0x78, 0xcb, 0xed, 0x5e, 0xfc, 0xae, 0x78, 0x4d, 0x7b, 0xf4, 0xf2, 0xff, 0x80,
];
const KEY1: [u8; 32] = [
    0x59, 0xc6, 0x99, 0x5e, 0x99, 0x8f, 0x97, 0xa5, 0xa0, 0x04, 0x49, 0x66, 0xf0, 0x94, 0x53, 0x89, 0xdc, 0x9e, 0x86,
    0xda, 0xe8, 0x8c, 0x7a, 0x84, 0x12, 0xf4, 0x60, 0x3b, 0x6b, 0x78, 0x69, 0x0d,
];

/// SPEED-3 discover bench (TEST NUMBERS on the practice chain, not live):
/// a feed transaction that swaps on one of our V4 / V3 pools (signed, like
/// a user's), asked as the bot asks it: 48 feed messages of ~10 x ~1 KB
/// transactions (the trigger near the end, the copy a few messages behind),
/// first with the messages inline (the old way), then naming them
/// (feed store). Prints the bot-side time, the sidecar's wall / CPU time and
/// its phase list (EVM runs, rounds, ...). Misses are warmed like the bot's
/// TrigWarmer does (`warm`), then asked again.
fn discover_bench(w: &World, cl: &mut Client, sent: &AtomicU64, a: &Anvil, n_q: usize) -> String {
    let mut rng = Rng::new(23);
    let mut filler_nonce = 0u64;
    let mut filler = |n: usize| -> Vec<String> {
        (0..n)
            .map(|_| {
                filler_nonce += 1;
                hb(&check_util::sign_typed(&KEY1, 2, &check_util::TestTx { nonce: filler_nonce, gas: 100_000, to: Some(Address::with_last_byte(0x77)), value: U256::ZERO, data: vec![0xab; 900], access_list: vec![] }, 4663))
            })
            .collect()
    };
    // Warm the traders' code and coin balances once (the bot's warmer would).
    let mut slots = serde_json::Map::new();
    let mut coins: Vec<Address> = w.pairs.iter().map(|p| p.coin).collect();
    coins.push(w.usd);
    for c in &coins {
        slots.insert(ha(*c), json!([hx64(map_slot(U256::from_be_slice(w.vt.as_slice()), U256::ZERO)), hx64(map_slot(U256::from_be_slice(w.plain.as_slice()), U256::ZERO))]));
    }
    let _ = cl.ask(json!({"type": "warm", "accounts": [ha(w.vt), ha(w.plain)], "slots": slots}));
    std::thread::sleep(Duration::from_millis(1500));
    let mut seq_seen = 0u64;
    let mut rows: Vec<(String, f64, f64, f64, Value)> = Vec::new(); // (way, bot ms, us, cpu, answer)
    let mut why: HashMap<String, usize> = HashMap::new();
    let (mut same, mut compared) = (0usize, 0usize);
    let mut nonce0 = 1_000_000u64;
    for q in 0..n_q {
        let i = rng.int(0, w.pairs.len() as i64 - 1) as usize;
        let v4 = rng.next() < 0.5;
        let (to, data) = w.trade(i, v4, rng.next() < 0.5, 50.0 + rng.next() * 2000.0);
        nonce0 += 1;
        let trig = check_util::sign_typed(&KEY0, 2, &check_util::TestTx { nonce: nonce0, gas: 2_000_000, to: Some(to), value: U256::ZERO, data, access_list: vec![] }, 4663);
        let th = hb(revm::primitives::keccak256(&trig).as_slice());
        // Messages: the copy's block - 40 .. + 7 (48), the trigger in the last.
        let n = sent.load(Ordering::Relaxed);
        let ts0 = u64v(&a.ok("eth_getBlockByNumber", json!([format!("{n:#x}"), false]))["timestamp"]);
        let mut msgs = Vec::new();
        for s in (n - 40)..=(n + 7) {
            let mut txs = filler(10);
            if s == n + 7 {
                txs[4] = hb(&trig);
            }
            msgs.push(json!({"seq": s, "ts": ts0 + s.saturating_sub(n), "l1": 9000, "txs": txs}));
        }
        // Hand the new messages to the store once (feed_put), like the bot.
        let fresh: Vec<Value> = msgs.iter().filter(|m| m["seq"].as_u64().unwrap() > seq_seen || q == 0).cloned().collect();
        seq_seen = n + 7;
        cl.tell(&json!({"type": "feed_put", "msgs": fresh}));
        let refs: Vec<Value> = msgs.iter().map(|m| json!([m["seq"].clone(), m["txs"].as_array().unwrap().len()])).collect();
        let f_inline = json!({"trigger": th, "triggerSeq": n + 7, "msgs": msgs});
        let f_refs = json!({"trigger": th, "triggerSeq": n + 7, "refs": refs});
        let mut ans = Vec::new();
        for (way, f) in [("refs", &f_refs), ("inline", &f_inline)] {
            let t = Instant::now();
            let d = cl.ask(json!({"type": "trig_discover", "at": {"after": "head"}, "feed": f}));
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            // Misses: warmed (like the bot's warmer), not timed.
            if d["unknown"] == json!("miss") {
                let mut s2 = serde_json::Map::new();
                let mut accts = Vec::new();
                for m in d["missing"].as_array().cloned().unwrap_or_default() {
                    match m.get("slot").and_then(|x| x.as_str()) {
                        Some(sl) => s2.entry(m["account"].as_str().unwrap().to_string()).or_insert_with(|| json!([])).as_array_mut().unwrap().push(json!(sl)),
                        None => accts.push(m["account"].clone()),
                    }
                }
                let _ = cl.ask(json!({"type": "warm", "accounts": accts, "slots": s2}));
            }
            *why.entry(format!("{way} {}", d["unknown"].as_str().unwrap_or("ok"))).or_default() += 1;
            rows.push((way.to_string(), ms, d["us"].as_f64().unwrap_or(0.0), d["cpu"].as_f64().unwrap_or(0.0), d.clone()));
            ans.push(d);
        }
        if ans[0]["snapBlock"] == ans[1]["snapBlock"] && ans[0]["ok"] == json!(true) {
            compared += 1;
            let st = |v: &Value| {
                let mut v = v.clone();
                for k in ["us", "t", "id", "ph", "pn", "cpu"] {
                    v.as_object_mut().unwrap().remove(k);
                }
                v
            };
            if st(&ans[0]) == st(&ans[1]) {
                same += 1;
            }
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    // Only answered questions after the first third (warm-up) count.
    let mut out = format!("\n[bench] trig_discover on real pools ({} questions, 48 msgs x 10 txs x ~1 KB): {why:?}; inline vs refs same answer {same}/{compared}\n", n_q);
    for way in ["inline", "refs"] {
        let sel: Vec<&(String, f64, f64, f64, Value)> = rows.iter().skip(rows.len() / 3).filter(|r| r.0 == way && r.4["ok"] == json!(true)).collect();
        let mut bot: Vec<f64> = sel.iter().map(|r| r.1).collect();
        let mut us: Vec<f64> = sel.iter().map(|r| r.2 / 1000.0).collect();
        let mut cpu: Vec<f64> = sel.iter().map(|r| r.3 / 1000.0).collect();
        let mut evm: Vec<f64> = sel.iter().map(|r| r.4["ph"]["evm"].as_f64().unwrap_or(0.0) / 1000.0).collect();
        let mut plan: Vec<f64> = sel.iter().map(|r| r.4["ph"]["plan"].as_f64().unwrap_or(0.0) / 1000.0).collect();
        let mut runs: Vec<f64> = sel.iter().map(|r| r.4["pn"]["runs"].as_f64().unwrap_or(0.0)).collect();
        let mut rounds: Vec<f64> = sel.iter().map(|r| r.4["pn"]["rounds"].as_f64().unwrap_or(0.0)).collect();
        out += &format!("  {way}:\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n", line("    bot-side ms", &mut bot), line("    sidecar wall ms", &mut us), line("    sidecar cpu ms", &mut cpu), line("    plan ms", &mut plan), line("    evm ms", &mut evm), line("    evm runs", &mut runs), line("    replay rounds", &mut rounds));
        if let Some(r) = sel.last() {
            out += &format!("    last answer phases (us) {} counts {} pools {}\n", r.4["ph"], r.4["pn"], r.4["pools"]);
        }
    }
    out
}

#[test]
fn copy2_check_latency() {
    let pairs = env_n("COPY2_LAT_PAIRS", 120) as usize;
    let checks = env_n("COPY2_LAT_CHECKS", 120) as usize;
    let Some(mut r) = bench(pairs, checks) else {
        eprintln!("copy2 latency test SKIPPED: no ~/.foundry/bin/anvil");
        return;
    };
    assert!(r.answered * 10 >= checks * 7, "most checks answered: {}", r.report);
    // The goal: checks the copy answers (unknown ones go to the node anyway).
    let p50 = pctl(&mut r.answered_ms, 0.5);
    let p99 = pctl(&mut r.answered_ms, 0.99);
    let max50 = env_n("COPY2_LAT_MAX_P50_MS", 10) as f64;
    let max99 = env_n("COPY2_LAT_MAX_P99_MS", 40) as f64;
    let held_max = r.held_ms.iter().cloned().fold(0.0, f64::max);
    assert!(held_max < 100.0, "a check waited for the copy's lock: {held_max:.1} ms ({:?})", r.held_ms);
    assert!(p50 <= max50, "bot-side p50 {p50:.1} ms > {max50} ms\n{}", r.report);
    assert!(p99 <= max99, "bot-side p99 {p99:.1} ms > {max99} ms\n{}", r.report);
}
