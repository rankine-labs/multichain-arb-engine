// ============================================================================
// COPY 2 REPLAY, PROVED ON A PRACTICE CHAIN (workstream B).
//
// Plain English:
//   For each pool type (Uniswap V3, PancakeSwap V3, Algebra Integral with its
//   dynamic-fee plugin, Uniswap V4 hook-free) this test:
//     1. starts a private practice chain (anvil) = "the TRUTH",
//     2. deploys the REAL pool code (same npm builds as the offline proof),
//        two coins, a random trader and two never-traded reference pools,
//     3. makes our COPY: it starts empty and only ever learns
//          - items it asks for, read at the START block (the first-load rule),
//          - the pools' EVENTS, applied with copy2::replay::apply_replay,
//     4. lets random traders hit the pool (swaps of $1..$3M both ways, exact
//        in / exact out / price limits, liquidity adds and removes, fee
//        collects, flash loans, coins sent straight to the pool, owner
//        settings...) in blocks of 1-4 actions with time jumps,
//     5. after EVERY block compares every storage slot of the followed
//        accounts that either side ever changed (pool, Algebra plugin, V4
//        PoolManager), copy vs truth,
//     6. every second block runs the bot's real check (ArbExecutor round trips
//        through the pool and a reference pool, $100 / $5k / $250k, run by
//        arbsim's own check engine) on the truth and on the copy, and
//        compares success, profit bytes and gas,
//     7. finally a "negative control": one more swap on the truth that the
//        copy is NOT told about must change some check answers (proves the
//        comparison is not blind).
//   Pass = 0 unsure replays, 0 slot differences, 0 check differences.
//
//   Skipped (passes with a note) when anvil isn't installed.
//   Knobs: COPY2_OPS (actions per pool type, default 90), COPY2_SEED.
// ============================================================================
mod copy2_util;

use std::collections::BTreeSet;

use arbsim::arb;
use arbsim::check::{run_calls, CallReq, Overrides};
use arbsim::copy2::overlay::Overlay;
use arbsim::copy2::replay::{apply_replay, finish_block, has_pending};
use arbsim::copy2::{ApplyResult, BlockCtx, PoolKind, PoolLog, TrackedPool};
use arbsim::state::snap::Snapshot;
use arbsim::state::Lookup;
use copy2_util::*;
use revm::primitives::{keccak256, Address, Bytes, B256, U256};
use serde_json::{json, Value};

/// Made-up addresses the bot's simulator uses (src/execution/simulator.ts).
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
/// int24 packed at bit `at` of a storage word.
fn tick_at(w: U256, at: usize) -> i64 {
    let t = ((w >> at) & U256::from(0xff_ffffu32)).to::<i64>();
    if t >= 1 << 23 {
        t - (1 << 24)
    } else {
        t
    }
}
fn low160(w: U256) -> U256 {
    w & ((U256::from(1u8) << 160) - U256::from(1u8))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum K {
    V3,
    Pancake,
    Algebra,
    V4,
}

/// One liquidity position the random traders hold.
#[derive(Clone, Debug)]
struct Pos {
    pool_i: usize,
    lo: i64,
    hi: i64,
    salt: u8,
    liq: U256,
}

/// What a sent action does to our position list if it succeeds.
enum Effect {
    None,
    Add(Pos),
    Sub(usize, U256),
}

/// Everything about one pool type's run.
struct Sc {
    kind: K,
    u: Address,
    w: Address,
    trader: Address,
    refs: Vec<(Address, f64)>,
    /// Pools followed by the copy (V4: two pools inside one PoolManager).
    pools: Vec<TrackedPool>,
    /// Accounts whose storage is compared slot for slot.
    tracked: Vec<Address>,
    spacing: Vec<i64>,
    positions: Vec<Pos>,
}

impl Sc {
    fn zero_is_u(&self) -> bool {
        self.u < self.w
    }
    fn key_args(&self, i: usize) -> Vec<Arg> {
        let p = &self.pools[i];
        vec![Arg::A(p.token0), Arg::A(p.token1), Arg::W(U256::from(p.fee)), Arg::I(p.tick_spacing as i128), Arg::A(Address::ZERO)]
    }
    /// Current (price, tick) of pool i on the truth chain.
    fn price_tick(&self, a: &Anvil, i: usize) -> (U256, i64) {
        let (acct, s) = match self.kind {
            K::V3 | K::Pancake => (self.pools[i].address, U256::ZERO),
            K::Algebra => (self.pools[i].address, U256::from(2)),
            K::V4 => (self.pools[i].address, map_slot(U256::from_be_bytes(self.pools[i].v4_id.unwrap().0), U256::from(6))),
        };
        let v = u(&a.ok("eth_getStorageAt", json!([ha(acct), hx64(s), "latest"])));
        (low160(v), tick_at(v, 160))
    }
}

// ---------------------------------------------------------------------------
// Setup.
// ---------------------------------------------------------------------------

/// Two coins, the trader (with plenty of both) and the reference pools.
fn setup_base(a: &Anvil, arts: &Value) -> (Address, Address, Address, Address, Vec<(Address, f64)>) {
    let tok = art(arts, "Token");
    let uu = a.deploy(&tok, &encode(&[Arg::D(b"USD".to_vec()), Arg::W(U256::from(6))]));
    let ww = a.deploy(&tok, &encode(&[Arg::D(b"WETH".to_vec()), Arg::W(U256::from(18))]));
    let trader = a.deploy(&art(arts, "Trader"), &[]);
    for t in [uu, ww] {
        a.send_ok(t, &calldata("mint(address,uint256)", &[Arg::A(trader), Arg::W(q(36))]));
    }
    // Reference pools (Uniswap V3, never traded by the workload): one priced
    // 2% off (realistic gap), one so far off that the round trip is ALWAYS
    // profitable (the profit number then always depends on the test pool).
    let f = a.deploy(&art(arts, "UniswapV3Factory"), &[]);
    a.send_ok(f, &calldata("enableFeeAmount(uint24,int24)", &[Arg::W(U256::from(100)), Arg::I(1)]));
    let mut refs = Vec::new();
    for (fee, spacing, price) in [(500u32, 10i64, 2550.0f64), (100, 1, 5000.0)] {
        a.send_ok(f, &calldata("createPool(address,address,uint24)", &[Arg::A(uu), Arg::A(ww), Arg::W(U256::from(fee))]));
        let r = a.call(f, &calldata("getPool(address,address,uint24)", &[Arg::A(uu), Arg::A(ww), Arg::W(U256::from(fee))])).unwrap();
        let pool = Address::from_slice(&r[12..32]);
        a.send_ok(pool, &calldata("initialize(uint160)", &[Arg::W(sqrt_price_for(price, uu, ww))]));
        let s0 = a.call(pool, &calldata("slot0()", &[])).unwrap();
        let tick = signed(word(&s0, 1));
        let b = tick.div_euclid(spacing) * spacing;
        let wdt = if spacing == 1 { 200 } else { spacing * 20 };
        for k in 1..=6 {
            a.send_ok(trader, &calldata("mintV3(address,int24,int24,uint128)", &[Arg::A(pool), Arg::I((b - wdt * k) as i128), Arg::I((b + wdt * k) as i128), Arg::W(q(17) * U256::from(3))]));
        }
        refs.push((pool, price));
    }
    (uu, ww, trader, f, refs)
}

fn tracked(address: Address, kind: PoolKind, t0: Address, t1: Address) -> TrackedPool {
    TrackedPool { address, v4_id: None, kind, token0: t0, token1: t1, fee: 0, tick_spacing: 0 }
}

fn setup(a: &Anvil, kind: K, rng: &mut Rng) -> Sc {
    let arts = artifacts();
    let (uu, ww, trader, v3f, refs) = setup_base(a, &arts);
    let (t0, t1) = if uu < ww { (uu, ww) } else { (ww, uu) };
    let mut sc = Sc { kind, u: uu, w: ww, trader, refs, pools: Vec::new(), tracked: Vec::new(), spacing: Vec::new(), positions: Vec::new() };
    match kind {
        K::V3 => {
            a.send_ok(v3f, &calldata("createPool(address,address,uint24)", &[Arg::A(uu), Arg::A(ww), Arg::W(U256::from(3000))]));
            let r = a.call(v3f, &calldata("getPool(address,address,uint24)", &[Arg::A(uu), Arg::A(ww), Arg::W(U256::from(3000))])).unwrap();
            let pool = Address::from_slice(&r[12..32]);
            a.send_ok(pool, &calldata("initialize(uint160)", &[Arg::W(sqrt_price_for(2500.0, uu, ww))]));
            a.send_ok(pool, &calldata("increaseObservationCardinalityNext(uint16)", &[Arg::W(U256::from(25))]));
            // Protocol fee on (1/6 of each swap fee), like many live V3 forks.
            a.send_ok(pool, &calldata("setFeeProtocol(uint8,uint8)", &[Arg::W(U256::from(6)), Arg::W(U256::from(6))]));
            sc.pools.push(tracked(pool, PoolKind::V3, t0, t1));
            sc.tracked = vec![pool];
            sc.spacing = vec![60];
        }
        K::Pancake => {
            let d = a.deploy(&art(&arts, "PancakeDeployer"), &[]);
            let init = parse_hex(&art(&arts, "PancakeV3Pool"));
            // factory = our own account (allowed to change pool settings).
            a.send_ok(d, &calldata("deploy(bytes,address,address,address,uint24,int24)", &[Arg::D(init), Arg::A(a.me), Arg::A(t0), Arg::A(t1), Arg::W(U256::from(2500)), Arg::I(50)]));
            let pool = create_address(d, 1);
            a.send_ok(pool, &calldata("initialize(uint160)", &[Arg::W(sqrt_price_for(2500.0, uu, ww))]));
            a.send_ok(pool, &calldata("increaseObservationCardinalityNext(uint16)", &[Arg::W(U256::from(25))]));
            sc.pools.push(tracked(pool, PoolKind::PancakeV3, t0, t1));
            sc.tracked = vec![pool];
            sc.spacing = vec![50];
        }
        K::Algebra => {
            let n = a.nonce(a.me);
            let dep = create_address(a.me, n + 1);
            let f = a.deploy(&art(&arts, "AlgebraFactory"), &encode(&[Arg::A(dep)]));
            let d2 = a.deploy(&art(&arts, "AlgebraPoolDeployer"), &encode(&[Arg::A(f)]));
            assert_eq!(d2, dep);
            let pf = a.deploy(&art(&arts, "BasePluginV1Factory"), &encode(&[Arg::A(f)]));
            a.send_ok(f, &calldata("setDefaultPluginFactory(address)", &[Arg::A(pf)]));
            let v = a.deploy(&art(&arts, "AlgebraVaultFactoryStub"), &encode(&[Arg::A(ALGEBRA_VAULT)]));
            a.send_ok(f, &calldata("setVaultFactory(address)", &[Arg::A(v)]));
            a.send_ok(f, &calldata("setDefaultCommunityFee(uint16)", &[Arg::W(U256::from(100))])); // 10% to the vault
            a.send_ok(f, &calldata("createPool(address,address,bytes)", &[Arg::A(uu), Arg::A(ww), Arg::D(vec![])]));
            let r = a.call(f, &calldata("poolByPair(address,address)", &[Arg::A(uu), Arg::A(ww)])).unwrap();
            let pool = Address::from_slice(&r[12..32]);
            a.send_ok(pool, &calldata("initialize(uint160)", &[Arg::W(sqrt_price_for(2500.0, uu, ww))]));
            let r = a.call(pool, &calldata("plugin()", &[])).unwrap();
            let plugin = Address::from_slice(&r[12..32]);
            assert_ne!(plugin, Address::ZERO, "Algebra pool got no plugin");
            sc.pools.push(tracked(pool, PoolKind::Algebra, t0, t1));
            sc.tracked = vec![pool, plugin];
            sc.spacing = vec![60];
        }
        K::V4 => {
            let pm = a.deploy(&art(&arts, "PoolManager"), &encode(&[Arg::A(a.me)]));
            let vt = a.deploy(&art(&arts, "V4Trader"), &encode(&[Arg::A(pm)]));
            for t in [uu, ww] {
                a.send_ok(t, &calldata("mint(address,uint256)", &[Arg::A(vt), Arg::W(q(36))]));
            }
            sc.trader = vt;
            // Two pools in one PoolManager, both traded (the copy must keep them apart).
            for (fee, spacing) in [(3000u32, 60i32), (500, 10)] {
                let mut p = TrackedPool { address: pm, v4_id: None, kind: PoolKind::V4, token0: t0, token1: t1, fee, tick_spacing: spacing };
                p.v4_id = Some(arbsim::copy2::replay::v4_pool_id(&p));
                sc.pools.push(p);
                sc.spacing.push(spacing as i64);
            }
            for i in 0..2 {
                let mut args = sc.key_args(i);
                args.push(Arg::W(sqrt_price_for(2500.0, uu, ww)));
                a.send_ok(pm, &calldata("initialize((address,address,uint24,int24,address),uint160)", &args));
            }
            sc.tracked = vec![pm];
        }
    }
    // Many overlapping positions so swaps cross many ticks.
    for i in 0..sc.pools.len() {
        let (_, tick) = sc.price_tick(a, i);
        let sp = sc.spacing[i];
        let b = tick.div_euclid(sp) * sp;
        for k in 1..=14 {
            let (lo, hi) = (b - sp * k * 6, b + sp * k * 5);
            let liq = q(16) * U256::from(rng.int(1, 4) as u64);
            let (to, data) = mint_call(&sc, i, lo, hi, 0, liq);
            a.send_ok(to, &data);
            sc.positions.push(Pos { pool_i: i, lo, hi, salt: 0, liq });
        }
    }
    sc
}

fn parse_hex(s: &str) -> Vec<u8> {
    arbsim::check::hexutil::parse_bytes(s).unwrap().to_vec()
}

fn mint_call(sc: &Sc, i: usize, lo: i64, hi: i64, salt: u8, liq: U256) -> (Address, Vec<u8>) {
    let p = sc.pools[i].address;
    match sc.kind {
        K::V3 | K::Pancake => (sc.trader, calldata("mintV3(address,int24,int24,uint128)", &[Arg::A(p), Arg::I(lo as i128), Arg::I(hi as i128), Arg::W(liq)])),
        K::Algebra => (sc.trader, calldata("mintAlgebra(address,int24,int24,uint128)", &[Arg::A(p), Arg::I(lo as i128), Arg::I(hi as i128), Arg::W(liq)])),
        K::V4 => {
            let mut args = sc.key_args(i);
            args.extend([Arg::I(lo as i128), Arg::I(hi as i128), Arg::W(liq), Arg::W(U256::from(salt))]);
            (sc.trader, calldata("modify((address,address,uint24,int24,address),int24,int24,int256,bytes32)", &args))
        }
    }
}

// ---------------------------------------------------------------------------
// Random market activity (same mix as the offline bench).
// ---------------------------------------------------------------------------
fn random_op(a: &Anvil, sc: &Sc, rng: &mut Rng) -> (Address, Vec<u8>, Effect) {
    let i = if sc.kind == K::V4 && rng.next() >= 0.75 { 1 } else { 0 };
    let pool = sc.pools[i].address;
    let (cur, tick) = sc.price_tick(a, i);
    let sp = sc.spacing[i];
    let r = rng.next();
    let t = sc.trader;
    if r < 0.62 {
        let usd = rng.log_big(1.0, 3_000_000.0);
        let in_u = rng.next() < 0.5;
        let zfo = in_u == sc.zero_is_u();
        let amt_in = if in_u { usd * q(6) } else { usd * q(18) / U256::from(2500) };
        let mode = rng.next();
        let (amount, limit): (U256, U256) = if mode < 0.15 {
            let out = if in_u { usd * q(18) / U256::from(2600) } else { usd * q(6) * U256::from(9) / U256::from(10) };
            // V3 style: negative = exact output. V4: positive = exact output.
            (if sc.kind == K::V4 { out } else { int_neg(out) }, U256::ZERO)
        } else if mode < 0.25 && !cur.is_zero() {
            let f = U256::from(rng.int(1, 30) as u64);
            let mut lim = if zfo { cur - cur * f / U256::from(1000) } else { cur + cur * f / U256::from(1000) };
            let (minp, maxp) = (U256::from(4295128740u64), U256::from_str_radix("1461446703485210103287273052203988822378723970341", 10).unwrap());
            if lim <= minp {
                lim = minp;
            }
            if lim >= maxp {
                lim = maxp;
            }
            (if sc.kind == K::V4 { int_neg(amt_in) } else { amt_in }, lim)
        } else {
            (if sc.kind == K::V4 { int_neg(amt_in) } else { amt_in }, U256::ZERO)
        };
        if sc.kind == K::V4 {
            let mut args = sc.key_args(i);
            args.extend([Arg::B(zfo), Arg::W(amount), Arg::W(limit)]);
            return (t, calldata("swap((address,address,uint24,int24,address),bool,int256,uint160)", &args), Effect::None);
        }
        return (t, calldata("swapV3(address,bool,int256,uint160)", &[Arg::A(pool), Arg::B(zfo), Arg::W(amount), Arg::W(limit)]), Effect::None);
    }
    if r < 0.70 {
        // Coins sent straight to the pool (V4: to the PoolManager), or a V4 donate.
        let in_u = rng.next() < 0.5;
        let amt = if in_u { rng.log_big(1.0, 50_000.0) * q(6) } else { rng.log_big(1.0, 50_000.0) * q(18) / U256::from(2500) };
        if sc.kind == K::V4 && rng.next() < 0.5 {
            let mut args = sc.key_args(i);
            args.extend([Arg::W(rng.log_big(1.0, 1e12)), Arg::W(rng.log_big(1.0, 1e12))]);
            return (t, calldata("donate((address,address,uint24,int24,address),uint256,uint256)", &args), Effect::None);
        }
        let sig = if sc.kind == K::V4 { "coinDonate(address,address,uint256)" } else { "donate(address,address,uint256)" };
        return (t, calldata(sig, &[Arg::A(if in_u { sc.u } else { sc.w }), Arg::A(pool), Arg::W(amt)]), Effect::None);
    }
    if r < 0.80 {
        let b = tick.div_euclid(sp) * sp;
        let lo = b - sp * rng.int(-20, 120);
        let hi = lo + sp * rng.int(1, 150);
        let liq = q(14) * U256::from(rng.int(1, 300) as u64);
        let salt = if sc.kind == K::V4 { rng.int(0, 1) as u8 } else { 0 };
        let (to, data) = mint_call(sc, i, lo, hi, salt, liq);
        return (to, data, Effect::Add(Pos { pool_i: i, lo, hi, salt, liq }));
    }
    let mine: Vec<usize> = (0..sc.positions.len()).filter(|&k| sc.positions[k].liq > U256::ZERO && sc.positions[k].pool_i == i).collect();
    if r < 0.88 && !mine.is_empty() {
        let k = mine[rng.int(0, mine.len() as i64 - 1) as usize];
        let p = &sc.positions[k];
        let amt = if rng.next() < 0.3 { p.liq } else { p.liq * U256::from(rng.int(1, 60) as u64) / U256::from(100) };
        if amt.is_zero() {
            return (t, Vec::new(), Effect::None);
        }
        let both = rng.next() < 0.5;
        let data = match sc.kind {
            K::V3 | K::Pancake => calldata("burnV3(address,int24,int24,uint128,bool)", &[Arg::A(pool), Arg::I(p.lo as i128), Arg::I(p.hi as i128), Arg::W(amt), Arg::B(both)]),
            K::Algebra => calldata("burnAlgebra(address,int24,int24,uint128,bool)", &[Arg::A(pool), Arg::I(p.lo as i128), Arg::I(p.hi as i128), Arg::W(amt), Arg::B(both)]),
            K::V4 => {
                let mut args = sc.key_args(i);
                args.extend([Arg::I(p.lo as i128), Arg::I(p.hi as i128), Arg::W(int_neg(amt)), Arg::W(U256::from(p.salt))]);
                calldata("modify((address,address,uint24,int24,address),int24,int24,int256,bytes32)", &args)
            }
        };
        return (t, data, Effect::Sub(k, amt));
    }
    if r < 0.93 && !mine.is_empty() && sc.kind != K::V4 {
        let p = &sc.positions[mine[rng.int(0, mine.len() as i64 - 1) as usize]];
        return (t, calldata("collectV3(address,int24,int24)", &[Arg::A(pool), Arg::I(p.lo as i128), Arg::I(p.hi as i128)]), Effect::None);
    }
    if r < 0.97 && sc.kind != K::V4 {
        let (a0, a1) = (rng.log_big(1.0, 1e12), rng.log_big(1.0, 1e12));
        return (t, calldata("flashV3(address,uint256,uint256)", &[Arg::A(pool), Arg::W(a0), Arg::W(a1)]), Effect::None);
    }
    // Owner / housekeeping actions.
    match sc.kind {
        K::V3 => {
            let x = rng.next();
            if x < 0.4 {
                let next = 25 + rng.int(1, 40) as u64;
                (pool, calldata("increaseObservationCardinalityNext(uint16)", &[Arg::W(U256::from(next))]), Effect::None)
            } else if x < 0.7 {
                let (f0, f1) = (rng.int(4, 10) as u64, rng.int(4, 10) as u64);
                (pool, calldata("setFeeProtocol(uint8,uint8)", &[Arg::W(U256::from(f0)), Arg::W(U256::from(f1))]), Effect::None)
            } else {
                let m = (U256::from(1u8) << 128) - U256::from(1u8);
                (pool, calldata("collectProtocol(address,uint128,uint128)", &[Arg::A(a.me), Arg::W(m), Arg::W(m)]), Effect::None)
            }
        }
        K::Pancake => {
            if rng.next() < 0.5 {
                let next = 25 + rng.int(1, 40) as u64;
                (pool, calldata("increaseObservationCardinalityNext(uint16)", &[Arg::W(U256::from(next))]), Effect::None)
            } else {
                let m = (U256::from(1u8) << 128) - U256::from(1u8);
                (pool, calldata("collectProtocol(address,uint128,uint128)", &[Arg::A(a.me), Arg::W(m), Arg::W(m)]), Effect::None)
            }
        }
        _ => {
            let in_u = rng.next() < 0.5;
            let zfo = in_u == sc.zero_is_u();
            let amt = if in_u { U256::from(1000) * q(6) } else { q(18) };
            if sc.kind == K::V4 {
                let mut args = sc.key_args(i);
                args.extend([Arg::B(zfo), Arg::W(int_neg(amt)), Arg::W(U256::ZERO)]);
                (t, calldata("swap((address,address,uint24,int24,address),bool,int256,uint160)", &args), Effect::None)
            } else {
                (t, calldata("swapV3(address,bool,int256,uint160)", &[Arg::A(pool), Arg::B(zfo), Arg::W(amt), Arg::W(U256::ZERO)]), Effect::None)
            }
        }
    }
}

fn int_neg(v: U256) -> U256 {
    (!v).wrapping_add(U256::from(1u8))
}

// ---------------------------------------------------------------------------
// The bot's check (ArbExecutor.execute, own-money style, minProfit = max).
// ---------------------------------------------------------------------------
struct Check {
    name: String,
    call: CallReq,
    ov: Overrides,
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

fn checks(sc: &Sc, runtime: &str) -> Vec<Check> {
    let sel = sel("execute((address,uint256,uint256,uint256,(uint8,address,address,address,uint16,uint24,int24,bool)[]),address)");
    assert_eq!(hexs(&sel), "8da2b32d", "selector mismatch vs bot");
    let test_hop = |tin, tout| match sc.kind {
        K::V4 => hop_words(3, sc.pools[0].address, tin, tout, sc.pools[0].fee, sc.pools[0].tick_spacing),
        _ => hop_words(2, sc.pools[0].address, tin, tout, 0, 0),
    };
    let mut out = Vec::new();
    for (r, price) in &sc.refs {
        for usd in [100u64, 5_000, 250_000] {
            let amt = U256::from(usd) * q(6);
            let mut routes = Vec::new();
            routes.push((format!("test>ref{price}-{usd}"), vec![test_hop(sc.u, sc.w), hop_words(2, *r, sc.w, sc.u, 0, 0)]));
            if *price < 3000.0 {
                routes.push((format!("ref{price}>test-{usd}"), vec![hop_words(2, *r, sc.u, sc.w, 0, 0), test_hop(sc.w, sc.u)]));
            }
            for (name, hops) in routes {
                let mut d = sel.to_vec();
                let mut words = vec![U256::from(0x40), U256::ZERO]; // (tuple offset, flashPool = none)
                words.extend([U256::from_be_slice(sc.u.as_slice()), amt, U256::MAX, U256::MAX, U256::from(0xa0), U256::from(hops.len())]);
                for h in &hops {
                    words.extend(h.iter().copied());
                }
                for w in words {
                    d.extend_from_slice(&w.to_be_bytes::<32>());
                }
                let mut exec_diff = json!({ hx64(U256::ZERO): hx64(U256::from_be_slice(SIM_CALLER.as_slice())) });
                if sc.kind == K::V4 {
                    // The contract needs V4 switched on: PoolManager (slot 6) + WETH (slot 7).
                    exec_diff[hx64(U256::from(6))] = json!(hx64(U256::from_be_slice(sc.pools[0].address.as_slice())));
                    exec_diff[hx64(U256::from(7))] = json!(hx64(U256::from_be_slice(sc.w.as_slice())));
                }
                let bal = map_slot(U256::from_be_slice(SIM_EXECUTOR.as_slice()), U256::ZERO);
                let ov = json!({
                    ha(SIM_EXECUTOR): { "code": runtime, "stateDiff": exec_diff },
                    ha(sc.u): { "stateDiff": { hx64(bal): hx64(amt) } },
                });
                out.push(Check {
                    name,
                    call: CallReq { from: SIM_CALLER, to: Some(SIM_EXECUTOR), data: Bytes::from(d), gas: Some(8_000_000), value: U256::ZERO },
                    ov: Overrides::from_json(&ov).unwrap(),
                });
            }
        }
    }
    out
}

fn check_ctx(n: u64, ts: u64) -> arb::BlockCtx {
    arb::BlockCtx { l1_block_number: n, l2_block_number: Some(n), timestamp: ts, basefee: 0, coinbase: Address::ZERO, gas_limit: arb::NITRO_BLOCK_GAS_LIMIT, prevrandao: B256::ZERO }
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------
#[derive(Default, Debug)]
struct Stats {
    ops: usize,
    ops_ok: usize,
    blocks: usize,
    events: usize,
    fill_rounds: usize,
    items_filled: usize,
    unsure: Vec<String>,
    slots_compared: usize,
    slot_diffs: Vec<String>,
    checks: usize,
    check_diffs: Vec<String>,
    checks_profit: usize,
    neg_control_diffs: usize,
    slot_neg_control: bool,
    /// Algebra: side events applied on their own at the block's end.
    lone_flushes: usize,
    /// Time spent inside apply_replay on warm calls (no items missing), and how many.
    warm_us: u128,
    warm_n: usize,
    by_event: std::collections::BTreeMap<String, usize>,
}

/// Readable name of a pool event (for the coverage line).
fn event_name(t: &B256) -> String {
    for sig in [
        "Swap(address,address,int256,int256,uint160,uint128,int24)",
        "Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)",
        "Mint(address,address,int24,int24,uint128,uint256,uint256)",
        "Burn(address,int24,int24,uint128,uint256,uint256)",
        "Collect(address,address,int24,int24,uint128,uint128)",
        "Flash(address,address,uint256,uint256,uint256,uint256)",
        "IncreaseObservationCardinalityNext(uint16,uint16)",
        "SetFeeProtocol(uint8,uint8,uint8,uint8)",
        "CollectProtocol(address,address,uint128,uint128)",
        "ExcessTokens(uint256,uint256)",
        "SwapFee(address,uint24,uint24)",
        "BurnFee(address,uint24)",
        "Fee(uint16)",
        "PluginConfig(uint8)",
        "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)",
        "ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)",
        "Donate(bytes32,address,uint256,uint256)",
    ] {
        if keccak256(sig.as_bytes()) == *t {
            return sig.split('(').next().unwrap().to_string() + if sig.ends_with("uint128,uint128)") && sig.starts_with("Swap") { "(pancake)" } else { "" };
        }
    }
    format!("{t}")
}

fn to_pool_log(l: &Value) -> PoolLog {
    PoolLog {
        address: parse_addr(&l["address"]),
        topics: l["topics"].as_array().unwrap().iter().map(|t| B256::from(u(t).to_be_bytes::<32>())).collect(),
        data: arbsim::check::hexutil::parse_bytes(l["data"].as_str().unwrap()).unwrap(),
        block: u64v(&l["blockNumber"]),
        tx_index: u64v(&l["transactionIndex"]) as u32,
        log_index: u64v(&l["logIndex"]) as u32,
        tx_hash: B256::from(u(&l["transactionHash"]).to_be_bytes::<32>()),
        removed: l["removed"].as_bool().unwrap_or(false),
    }
}

fn parse_addr(v: &Value) -> Address {
    arbsim::check::hexutil::parse_address(v.as_str().unwrap()).unwrap()
}

/// Apply one event to the copy, fetching what it asks for; Err = unsure.
fn apply_one(ov: &mut Overlay, start: &RemoteView, pool: &TrackedPool, pl: &PoolLog, ctx: &BlockCtx, st: &mut Stats) -> Result<(), String> {
    for _ in 0..200 {
        let t0 = std::time::Instant::now();
        let r = apply_replay(ov, pool, pl, ctx);
        match r {
            ApplyResult::Applied => {
                st.warm_us += t0.elapsed().as_micros();
                st.warm_n += 1;
                return Ok(());
            }
            ApplyResult::NeedItems(items) => {
                st.fill_rounds += 1;
                st.items_filled += fill(ov, start, &items);
            }
            ApplyResult::Unsure(w) => return Err(w),
        }
    }
    Err("too many fill rounds".into())
}

fn run_kind(kind: K) {
    let Some(a) = Anvil::start() else {
        eprintln!("copy2 replay anvil test SKIPPED: no ~/.foundry/bin/anvil");
        return;
    };
    let ops: usize = std::env::var("COPY2_OPS").ok().and_then(|s| s.parse().ok()).unwrap_or(90);
    let seed: u32 = std::env::var("COPY2_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(1) + kind as u32 * 1000;
    let mut rng = Rng::new(seed);
    let mut sc = setup(&a, kind, &mut rng);
    let runtime = arb_executor_runtime();
    let specs = checks(&sc, &runtime);

    // The copy starts EMPTY at block S; it learns only what it asks for (read at S) and the events.
    let s_block = a.block_number();
    let start = RemoteView::new(&a, s_block);
    let mut ov = Overlay::new(Snapshot::default());
    let mut st = Stats::default();
    let mut ever: BTreeSet<(Address, U256)> = BTreeSet::new();
    a.ok("evm_setAutomine", json!([false]));
    let mut ts = u64v(&a.ok("eth_getBlockByNumber", json!(["latest", false]))["timestamp"]);
    let mut block_i = 0usize;

    'run: while st.ops < ops {
        // ---- one block on the truth chain ----
        let n_ops = rng.int(1, 4) as usize;
        let mut sent = Vec::new();
        for _ in 0..n_ops {
            // Algebra only: now and then the PLUGIN makes the pool count coins
            // sent to it (sync()): a lone ExcessTokens event, applied by
            // finish_block() on its own.
            if kind == K::Algebra && rng.next() < 0.04 {
                let gift = calldata("donate(address,address,uint256)", &[Arg::A(sc.u), Arg::A(sc.pools[0].address), Arg::W(U256::from(rng.int(1, 5000) as u64) * q(6))]);
                sent.push((a.send(Some(sc.trader), &gift).unwrap(), Effect::None));
                let h = a.send_from(sc.tracked[1], Some(sc.pools[0].address), &calldata("sync()", &[])).unwrap();
                sent.push((h, Effect::None));
                st.ops += 1;
                continue;
            }
            let (to, data, eff) = random_op(&a, &sc, &mut rng);
            if data.is_empty() {
                continue;
            }
            let h = a.send(Some(to), &data).unwrap();
            sent.push((h, eff));
            st.ops += 1;
        }
        let jump = [0u64, 1, 12, 60, 300, 3600][rng.int(0, 5) as usize];
        if a.rpc("evm_setNextBlockTimestamp", json!([ts + jump])).is_err() {
            a.ok("evm_setNextBlockTimestamp", json!([ts + 1]));
        }
        a.ok("evm_mine", json!([]));
        let blk = a.ok("eth_getBlockByNumber", json!(["latest", false]));
        let n = u64v(&blk["number"]);
        ts = u64v(&blk["timestamp"]);
        st.blocks += 1;
        block_i += 1;
        for (h, eff) in sent.iter() {
            let r = a.receipt(*h);
            if r["status"] == "0x1" {
                st.ops_ok += 1;
                match eff {
                    Effect::Add(p) => sc.positions.push(p.clone()),
                    Effect::Sub(k, amt) => sc.positions[*k].liq -= *amt,
                    Effect::None => {}
                }
            }
        }

        // ---- the copy: apply ONLY the pools' events ----
        let ctx = BlockCtx { number: n, timestamp: ts, l1_number: n };
        let logs = a.ok("eth_getLogs", json!([{ "fromBlock": format!("{n:#x}"), "toBlock": format!("{n:#x}") }]));
        let mut logs: Vec<PoolLog> = logs.as_array().unwrap().iter().map(to_pool_log).collect();
        logs.sort_by_key(|l| (l.tx_index, l.log_index));
        for pl in &logs {
            if !sc.pools.iter().any(|p| p.address == pl.address) {
                continue;
            }
            // V4: route by pool id (topic 1); other PoolManager events go to the first pool.
            let pool = sc.pools.iter().find(|p| p.v4_id.is_some() && pl.topics.get(1) == p.v4_id.as_ref()).unwrap_or(&sc.pools[0]).clone();
            st.events += 1;
            *st.by_event.entry(event_name(&pl.topics[0])).or_default() += 1;
            if let Err(w) = apply_one(&mut ov, &start, &pool, pl, &ctx, &mut st) {
                st.unsure.push(format!("block {n} log {}: {w}", pl.log_index));
                break 'run;
            }
        }
        for p in sc.pools.clone() {
            if has_pending(&ov, &p) {
                st.lone_flushes += 1;
            }
            loop {
                match finish_block(&mut ov, &p, &ctx) {
                    ApplyResult::Applied => break,
                    ApplyResult::NeedItems(items) => {
                        st.items_filled += fill(&mut ov, &start, &items);
                    }
                    ApplyResult::Unsure(w) => {
                        st.unsure.push(format!("block {n} finish: {w}"));
                        break 'run;
                    }
                }
            }
        }

        // ---- slot-for-slot comparison ----
        for (h, _) in &sent {
            let tr = a.ok("debug_traceTransaction", json!([hb(h.as_slice()), {"tracer": "prestateTracer", "tracerConfig": {"diffMode": true}}]));
            for side in ["pre", "post"] {
                if let Some(m) = tr[side].as_object() {
                    for (addr_s, acct) in m {
                        let addr = arbsim::check::hexutil::parse_address(addr_s).unwrap();
                        if !sc.tracked.contains(&addr) {
                            continue;
                        }
                        if let Some(s) = acct["storage"].as_object() {
                            for k in s.keys() {
                                ever.insert((addr, arbsim::check::hexutil::parse_u256(k).unwrap()));
                            }
                        }
                    }
                }
            }
        }
        for (addr, ad) in &ov.changes().accounts {
            if sc.tracked.contains(addr) {
                for s in ad.storage.keys() {
                    ever.insert((*addr, *s));
                }
            }
        }
        let items: Vec<(Address, U256)> = ever.iter().copied().collect();
        let now = RemoteView::new(&a, n);
        let truth = now.fetch_slots(&items);
        let unknown: Vec<(Address, U256)> = items.iter().copied().filter(|(ad, s)| ov.slot(*ad, *s) == Lookup::Missing).collect();
        let at_start = start.fetch_slots(&unknown);
        let mut k = 0;
        for (i, (ad, s)) in items.iter().enumerate() {
            let copy = match ov.slot(*ad, *s) {
                Lookup::Known(v) => v,
                Lookup::Missing => {
                    k += 1;
                    at_start[k - 1]
                }
            };
            st.slots_compared += 1;
            if copy != truth[i] && st.slot_diffs.len() < 20 {
                st.slot_diffs.push(format!("block {n} {ad} slot {s:#x}: copy {copy:#x} truth {:#x}", truth[i]));
            }
        }
        if !st.slot_diffs.is_empty() {
            break 'run;
        }

        // ---- the bot's check on truth vs copy (every second block) ----
        if block_i % 2 == 0 {
            let cv = CopyView { ov: &ov, tracked: sc.tracked.clone(), start: &start, now: &now };
            let cctx = check_ctx(n, ts);
            for c in &specs {
                let t = run_calls(&now, &cctx, &c.ov, &[], std::slice::from_ref(&c.call));
                let m = run_calls(&cv, &cctx, &c.ov, &[], std::slice::from_ref(&c.call));
                st.checks += 1;
                if let Ok(o) = &t {
                    if o[0].output.len() == 68 {
                        st.checks_profit += 1;
                    }
                }
                if t != m && st.check_diffs.len() < 20 {
                    st.check_diffs.push(format!("block {n} {}: truth {:?} copy {:?}", c.name, t.as_ref().map(|o| (o[0].success, hexs(&o[0].output), o[0].gas_used)), m.as_ref().map(|o| (o[0].success, hexs(&o[0].output), o[0].gas_used))));
                }
            }
        }
    }

    // ---- negative control: a swap the copy is NOT told about ----
    if st.unsure.is_empty() && st.slot_diffs.is_empty() {
        // Try a few sizes / both directions until one goes through.
        let mut done = false;
        for (usd, zfo) in [(20_000u64, true), (20_000, false), (1_000, true), (1_000, false)] {
            let amt = U256::from(usd) * q(6);
            let zfo = if zfo { sc.zero_is_u() } else { !sc.zero_is_u() };
            let amt = if zfo == sc.zero_is_u() { amt } else { amt * q(12) / U256::from(2500) };
            let data = if kind == K::V4 {
                let mut args = sc.key_args(0);
                args.extend([Arg::B(zfo), Arg::W(int_neg(amt)), Arg::W(U256::ZERO)]);
                calldata("swap((address,address,uint24,int24,address),bool,int256,uint160)", &args)
            } else {
                calldata("swapV3(address,bool,int256,uint160)", &[Arg::A(sc.pools[0].address), Arg::B(zfo), Arg::W(amt), Arg::W(U256::ZERO)])
            };
            let h = a.send(Some(sc.trader), &data).unwrap();
            ts += 1;
            a.ok("evm_setNextBlockTimestamp", json!([ts]));
            a.ok("evm_mine", json!([]));
            if a.receipt(h)["status"] == "0x1" {
                done = true;
                break;
            }
        }
        assert!(done, "negative-control swap failed");
        let n = a.block_number();
        let now = RemoteView::new(&a, n);
        let cv = CopyView { ov: &ov, tracked: sc.tracked.clone(), start: &start, now: &now };
        let cctx = check_ctx(n, ts);
        for c in &specs {
            let t = run_calls(&now, &cctx, &c.ov, &[], std::slice::from_ref(&c.call));
            let m = run_calls(&cv, &cctx, &c.ov, &[], std::slice::from_ref(&c.call));
            if t != m {
                st.neg_control_diffs += 1;
            }
        }
    }

    // ---- negative control for the slot comparison: change one slot of the
    // copy on purpose; the comparison must notice it. ----
    if let Some((ad, sl)) = ever.iter().copied().find(|(ad, sl)| matches!(ov.slot(*ad, *sl), Lookup::Known(_))) {
        let Lookup::Known(v) = ov.slot(ad, sl) else { unreachable!() };
        let mut bad = ov.fork();
        bad.set_slot(ad, sl, v ^ U256::from(1u8));
        let n = a.block_number();
        let truth_v = RemoteView::new(&a, n).fetch_slot(ad, sl);
        let copy_v = match bad.slot(ad, sl) {
            Lookup::Known(x) => x,
            Lookup::Missing => U256::ZERO,
        };
        // (The negative-control swap may itself have changed this slot.)
        st.slot_neg_control = copy_v != truth_v;
    }

    eprintln!("copy2 replay {kind:?}: events by type {:?}; lone side events applied at block end: {}; time per applied replay: {} us (this build)", st.by_event, st.lone_flushes, st.warm_us / st.warm_n.max(1) as u128);
    eprintln!(
        "copy2 replay {kind:?}: {} actions ({} succeeded) in {} blocks, {} pool events replayed, {} fill rounds ({} items read at start), \
         {} unsure, {} slot comparisons / {} different, {} checks ({} with a profit number) / {} different, negative control: {} of {} checks changed",
        st.ops, st.ops_ok, st.blocks, st.events, st.fill_rounds, st.items_filled, st.unsure.len(), st.slots_compared, st.slot_diffs.len(),
        st.checks, st.checks_profit, st.check_diffs.len(), st.neg_control_diffs, specs.len()
    );
    for x in st.unsure.iter().chain(&st.slot_diffs).chain(&st.check_diffs) {
        eprintln!("  {x}");
    }
    assert!(st.unsure.is_empty(), "{kind:?}: replay answered unsure");
    assert!(st.slot_diffs.is_empty(), "{kind:?}: copy storage differs from the truth");
    assert!(st.check_diffs.is_empty(), "{kind:?}: check answers differ");
    assert!(st.events >= ops / 2, "{kind:?}: too few pool events replayed ({})", st.events);
    assert!(st.checks > 0 && st.checks_profit > 0, "{kind:?}: no profitable checks compared");
    assert!(st.slot_neg_control, "{kind:?}: slot comparison did not notice a planted difference");
    assert!(st.neg_control_diffs > 0, "{kind:?}: negative control changed no check (comparison blind?)");
    let _ = keccak256([0u8]);
}

#[test]
fn copy2_replay_uniswap_v3() {
    run_kind(K::V3);
}

#[test]
fn copy2_replay_pancake_v3() {
    run_kind(K::Pancake);
}

#[test]
fn copy2_replay_algebra_integral() {
    run_kind(K::Algebra);
}

#[test]
fn copy2_replay_uniswap_v4() {
    run_kind(K::V4);
}
