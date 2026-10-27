// ============================================================================
// FAST LANE "AHEAD" BENCH ON REAL POOL CODE (practice fixes, Oct 27).
//
// Plain English:
//   Live, applying one feed message to the predicted copy took p90 17 ms /
//   p99 47 ms, so the 10 ms budget stopped prediction ~70% of the time. The
//   old bench (tests/fastlane_ahead.rs) used 2 tiny pools and said ~1 ms.
//   This one is realistic:
//     - a private practice chain (anvil) with the REAL Uniswap V3 pool code
//       and a REAL Uniswap V4 PoolManager (two pools in it), lots of
//       liquidity positions so swaps cross ticks,
//     - feed messages shaped like Robinhood blocks: 4 real swaps (2 V3, 2 V4),
//       1 "rival bot" transaction (last) to a contract our copy doesn't know (its
//       data names the V4 PoolManager and USD, like an arb bot), 7 other
//       transactions with 200-2,000 bytes of data that touch nothing of ours,
//     - the copy follows ~1,800 pools like live (the 3 real ones + made-up
//       ones sharing the same coins, so the name filter has live-like work),
//     - our copy = exactly the state the chain had before the first message
//       (from the chain's own "prestate" traces), so the predicted pools can
//       be checked against the chain after every message (ACCURACY: the
//       predicted V3 / V4 prices must equal the chain's, value for value).
//   Prints apply us p50 / p90 / p99 (TEST numbers) and the pools listed
//   unsure after the rival-bot transaction.
//   Uses only the predicted copy's public calls that exist before AND after
//   the practice fixes, so the same file runs on the old code for a
//   before / after comparison. Skipped (passes with a note) without anvil.
//   Knob: FASTLANE_BENCH_MSGS (default 24, at most 30).
// ============================================================================
mod check_util;
mod copy2_util;

use std::collections::HashSet;
use std::sync::Arc;

use arbsim::arb::BlockCtx;
use arbsim::check::feedstore::BinMsg;
use arbsim::check::hexutil::{parse_bytes, parse_u256};
use arbsim::check::moved::FollowedPool;
use arbsim::check::ordered::{AllExact, WireFeedMsg};
use arbsim::copy2::ahead::{Ahead, AheadCfg, Confirmed, PoolSet};
use arbsim::copy2::{PoolKind, TrackedPool};
use arbsim::state::snap::{Fact, Snapshot};
use arbsim::state::{Lookup, StateDiff, StateRead};
use check_util::{key_address, sign_typed, TestTx};
use copy2_util::{art, artifacts, calldata, encode, map_slot, sqrt_price_for, Anvil, Arg, Rng};
use revm::primitives::{keccak256, Address, B256, KECCAK_EMPTY, U256};
use revm::state::{AccountInfo, Bytecode};
use serde_json::{json, Value};

// anvil test accounts #0 and #1 (public test keys, no real funds anywhere).
const KEY0: [u8; 32] = [
    0xac, 0x09, 0x74, 0xbe, 0xc3, 0x9a, 0x17, 0xe3, 0x6b, 0xa4, 0xa6, 0xb4, 0xd2, 0x38, 0xff, 0x94, 0x4b, 0xac, 0xb4, 0x78, 0xcb, 0xed, 0x5e, 0xfc, 0xae, 0x78, 0x4d, 0x7b, 0xf4,
    0xf2, 0xff, 0x80,
];
const KEY1: [u8; 32] = [
    0x59, 0xc6, 0x99, 0x5e, 0x99, 0x8f, 0x97, 0xa5, 0xa0, 0x04, 0x49, 0x66, 0xf0, 0x94, 0x53, 0x89, 0xdc, 0x9e, 0x86, 0xda, 0xe8, 0x8c, 0x7a, 0x84, 0x12, 0xf4, 0x60, 0x3b, 0x6b,
    0x78, 0x69, 0x0d,
];

fn q(n: u32) -> U256 {
    U256::from(10u8).pow(U256::from(n))
}
fn ha(a: Address) -> String {
    format!("{a:#x}")
}
fn hb(b: &[u8]) -> String {
    format!("0x{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())
}
fn uv(v: &Value) -> U256 {
    v.as_str().and_then(|s| parse_u256(s).ok()).unwrap_or(U256::ZERO)
}
fn signed24(w: U256, at: usize) -> i64 {
    let t = ((w >> at) & U256::from(0xff_ffffu32)).to::<i64>();
    if t >= 1 << 23 {
        t - (1 << 24)
    } else {
        t
    }
}

/// The practice market: 2 coins, a V3 pool and two V4 pools, deep liquidity.
struct Market {
    usd: Address,
    weth: Address,
    trader: Address,
    v4trader: Address,
    v3: Address,
    pm: Address,
    v4: Vec<TrackedPool>,
}

fn key_args(p: &TrackedPool) -> Vec<Arg> {
    vec![Arg::A(p.token0), Arg::A(p.token1), Arg::W(U256::from(p.fee)), Arg::I(p.tick_spacing as i128), Arg::A(Address::ZERO)]
}

fn setup(a: &Anvil) -> Market {
    let arts = artifacts();
    let tok = art(&arts, "Token");
    let usd = a.deploy(&tok, &encode(&[Arg::D(b"USD".to_vec()), Arg::W(U256::from(6))]));
    let weth = a.deploy(&tok, &encode(&[Arg::D(b"WETH".to_vec()), Arg::W(U256::from(18))]));
    let (t0, t1) = if usd < weth { (usd, weth) } else { (weth, usd) };
    let trader = a.deploy(&art(&arts, "Trader"), &[]);
    let f = a.deploy(&art(&arts, "UniswapV3Factory"), &[]);
    a.send_ok(f, &calldata("createPool(address,address,uint24)", &[Arg::A(usd), Arg::A(weth), Arg::W(U256::from(3000))]));
    let r = a.call(f, &calldata("getPool(address,address,uint24)", &[Arg::A(usd), Arg::A(weth), Arg::W(U256::from(3000))])).unwrap();
    let v3 = Address::from_slice(&r[12..32]);
    a.send_ok(v3, &calldata("initialize(uint160)", &[Arg::W(sqrt_price_for(2500.0, usd, weth))]));
    a.send_ok(v3, &calldata("increaseObservationCardinalityNext(uint16)", &[Arg::W(U256::from(25))]));
    a.send_ok(v3, &calldata("setFeeProtocol(uint8,uint8)", &[Arg::W(U256::from(6)), Arg::W(U256::from(6))]));
    let pm = a.deploy(&art(&arts, "PoolManager"), &encode(&[Arg::A(a.me)]));
    let v4trader = a.deploy(&art(&arts, "V4Trader"), &encode(&[Arg::A(pm)]));
    for t in [usd, weth] {
        for who in [trader, v4trader] {
            a.send_ok(t, &calldata("mint(address,uint256)", &[Arg::A(who), Arg::W(q(36))]));
        }
    }
    let mut v4 = Vec::new();
    for (fee, spacing) in [(3000u32, 60i32), (500, 10)] {
        let mut p = TrackedPool { address: pm, v4_id: None, kind: PoolKind::V4, token0: t0, token1: t1, fee, tick_spacing: spacing };
        p.v4_id = Some(arbsim::copy2::replay::v4_pool_id(&p));
        let mut args = key_args(&p);
        args.push(Arg::W(sqrt_price_for(2500.0, usd, weth)));
        a.send_ok(pm, &calldata("initialize((address,address,uint24,int24,address),uint160)", &args));
        v4.push(p);
    }
    let m = Market { usd, weth, trader, v4trader, v3, pm, v4 };
    // Many overlapping positions so swaps cross many ticks.
    let mut rng = Rng::new(7);
    let tick_now = |a: &Anvil, acct: Address, slot: U256| signed24(uv(&a.ok("eth_getStorageAt", json!([ha(acct), format!("{slot:#x}"), "latest"]))), 160);
    let b3 = tick_now(a, v3, U256::ZERO).div_euclid(60) * 60;
    for k in 1..=14i64 {
        let liq = q(16) * U256::from(rng.int(1, 4) as u64);
        a.send_ok(trader, &calldata("mintV3(address,int24,int24,uint128)", &[Arg::A(v3), Arg::I((b3 - 60 * k * 6) as i128), Arg::I((b3 + 60 * k * 5) as i128), Arg::W(liq)]));
    }
    for p in &m.v4 {
        let sp = p.tick_spacing as i64;
        let b = tick_now(a, pm, map_slot(U256::from_be_bytes(p.v4_id.unwrap().0), U256::from(6))).div_euclid(sp) * sp;
        for k in 1..=14i64 {
            let liq = q(16) * U256::from(rng.int(1, 4) as u64);
            let mut args = key_args(p);
            args.extend([Arg::I((b - sp * k * 6) as i128), Arg::I((b + sp * k * 5) as i128), Arg::W(liq), Arg::W(U256::ZERO)]);
            a.send_ok(v4trader, &calldata("modify((address,address,uint24,int24,address),int24,int24,int256,bytes32)", &args));
        }
    }
    m
}

fn int_neg(v: U256) -> U256 {
    (!v).wrapping_add(U256::from(1u8))
}

/// One real swap: V3 (Trader.swapV3) or V4 (V4Trader.swap), random size / side.
fn swap_call(m: &Market, v4: Option<&TrackedPool>, rng: &mut Rng) -> (Address, Vec<u8>) {
    let usd_in = rng.next() < 0.5;
    let zfo = usd_in == (m.usd < m.weth);
    let usd = rng.log_big(10.0, 200_000.0);
    let amt = if usd_in { usd * q(6) } else { usd * q(18) / U256::from(2500) };
    match v4 {
        Some(p) => {
            let mut args = key_args(p);
            args.extend([Arg::B(zfo), Arg::W(int_neg(amt)), Arg::W(U256::ZERO)]);
            (m.v4trader, calldata("swap((address,address,uint24,int24,address),bool,int256,uint160)", &args))
        }
        None => (m.trader, calldata("swapV3(address,bool,int256,uint160)", &[Arg::A(m.v3), Arg::B(zfo), Arg::W(amt), Arg::W(U256::ZERO)])),
    }
}

/// Add one transaction's prestate (the chain's own trace) to our copy;
/// the FIRST time an item is seen wins (= its value before the message).
fn add_prestate(s: &mut Snapshot, seen_acct: &mut HashSet<Address>, seen_slot: &mut HashSet<(Address, U256)>, pre: &Value) {
    for (k, v) in pre.as_object().unwrap() {
        let a: Address = k.parse().unwrap();
        if seen_acct.insert(a) {
            let code = v.get("code").and_then(|c| c.as_str()).map(|c| parse_bytes(c).unwrap()).unwrap_or_default();
            let bal = v.get("balance").map(uv).unwrap_or(U256::ZERO);
            let nonce = v.get("nonce").and_then(|n| n.as_u64()).unwrap_or(0);
            let (h, bc) = if code.is_empty() { (KECCAK_EMPTY, None) } else { (keccak256(&code), Some(Bytecode::new_raw(code.clone()))) };
            let info = AccountInfo { balance: bal, nonce, code_hash: h, code: None, ..Default::default() };
            s.apply_fact(&Fact::Basics { addr: a, info: Some(info), code: bc });
        }
        for (sk, sv) in v.get("storage").and_then(|x| x.as_object()).into_iter().flatten() {
            let slot = parse_u256(sk).unwrap();
            if seen_slot.insert((a, slot)) {
                s.apply_fact(&Fact::Slot(a, slot, uv(sv)));
            }
        }
    }
}

fn pct(v: &mut [u64]) -> (u64, u64, u64, u64) {
    v.sort();
    let p = |x: f64| v[((v.len() as f64 - 1.0) * x).round() as usize];
    (p(0.5), p(0.9), p(0.99), *v.last().unwrap())
}

#[test]
fn bench_apply_on_real_v3_v4_pools_test_numbers_only() {
    let Some(a) = Anvil::start() else {
        eprintln!("[bench] anvil not installed: skipped");
        return;
    };
    let me = key_address(&KEY0);
    assert_eq!(me, a.me, "anvil account #0 is our test key");
    let other = key_address(&KEY1);
    let m = setup(&a);
    if std::env::var("AHEAD_DEBUG").is_ok() {
        eprintln!("[bench] usd {} weth {} trader {} v4trader {} v3 {} pm {}", m.usd, m.weth, m.trader, m.v4trader, m.v3, m.pm);
    }
    let n_msgs: usize = std::env::var("FASTLANE_BENCH_MSGS").ok().and_then(|v| v.parse().ok()).filter(|n| (1..=30).contains(n)).unwrap_or(24);
    let mut rng = Rng::new(11);
    // The rival bot: a contract our copy doesn't know (never in our copy).
    let rival = Address::from([0x7a; 20]);
    a.ok("anvil_setCode", json!([ha(rival), "0x00"]));
    // Mine the messages one block each, with known times.
    a.ok("evm_setAutomine", json!([false]));
    let base_block = a.block_number();
    let t_base = 1_800_000_000u64;
    let mut nonce0 = a.nonce(me);
    let mut nonce1 = a.nonce(other);
    let mut msgs: Vec<(u64, Vec<Vec<u8>>)> = Vec::new();
    for i in 0..n_msgs {
        let ts = t_base + i as u64;
        let mut txs: Vec<Vec<u8>> = Vec::new();
        let mut push = |to: Address, data: Vec<u8>, key: &[u8; 32], nonce: &mut u64, gas: u64| {
            let raw = sign_typed(key, 2, &TestTx { nonce: *nonce, gas, to: Some(to), value: U256::ZERO, data, access_list: vec![] }, 4663);
            *nonce += 1;
            txs.push(raw);
        };
        for j in 0..12 {
            match j {
                0 | 6 => {
                    let (to, d) = swap_call(&m, None, &mut rng);
                    push(to, d, &KEY0, &mut nonce0, 5_000_000);
                }
                2 | 8 => {
                    let p = &m.v4[(j / 6) as usize];
                    let (to, d) = swap_call(&m, Some(p), &mut rng);
                    push(to, d, &KEY0, &mut nonce0, 5_000_000);
                }
                11 => {
                    // Rival arb bot (last in the block): data names the
                    // PoolManager and USD only; its code is unknown to us.
                    let mut d = vec![0x12, 0x34, 0x56, 0x78];
                    d.extend(encode(&[Arg::A(m.pm), Arg::A(m.usd), Arg::W(U256::from(rng.int(1, 1 << 40) as u64)), Arg::I(60)]));
                    push(rival, d, &KEY1, &mut nonce1, 500_000);
                }
                _ => {
                    // Unrelated: random data to a plain account.
                    let len = rng.int(200, 2000) as usize;
                    let d: Vec<u8> = (0..len).map(|_| (rng.next() * 256.0) as u8).collect();
                    let to = Address::from_slice(&keccak256(d.as_slice())[12..]);
                    push(to, d, &KEY1, &mut nonce1, 1_000_000);
                }
            }
        }
        for t in &txs {
            a.ok("eth_sendRawTransaction", json!([hb(t)]));
        }
        a.ok("anvil_setNextBlockBaseFeePerGas", json!(["0x0"]));
        a.ok("evm_setNextBlockTimestamp", json!([ts]));
        a.ok("evm_mine", json!([]));
        msgs.push((ts, txs));
    }
    // Our copy = the chain's state before the first message (prestate
    // traces); then, block by block, the chain's own changes (diff traces):
    // what copy 2 would confirm for each block.
    let mut snap = Snapshot::default();
    let (mut sa, mut ss) = (HashSet::new(), HashSet::new());
    let mut posts: Vec<Vec<(B256, Value)>> = Vec::new();
    for (_, txs) in &msgs {
        let mut block_posts = Vec::new();
        for t in txs {
            let h = keccak256(t);
            let r = a.ok("eth_getTransactionReceipt", json!([hb(h.as_slice())]));
            assert!(!r.is_null(), "every transaction was mined");
            if r["to"].as_str() == Some(ha(m.trader).as_str()) || r["to"].as_str() == Some(ha(m.v4trader).as_str()) {
                assert_eq!(r["status"], "0x1", "real swaps succeed on the chain");
            }
            let pre = a.ok("debug_traceTransaction", json!([hb(h.as_slice()), {"tracer": "prestateTracer"}]));
            add_prestate(&mut snap, &mut sa, &mut ss, &pre);
            let d = a.ok("debug_traceTransaction", json!([hb(h.as_slice()), {"tracer": "prestateTracer", "tracerConfig": {"diffMode": true}}]));
            block_posts.push((h, d["post"].clone()));
        }
        posts.push(block_posts);
    }
    // The rival contract is unknown to our copy (like a live arb bot's code).
    snap.apply_fact(&Fact::Forget(rival));
    // Our pools: the 3 real ones + made-up ones (live: ~1,800 followed).
    let mut list: Vec<(FollowedPool, Address, Address)> = Vec::new();
    let (t0, t1) = (m.v4[0].token0, m.v4[0].token1);
    list.push((FollowedPool { key: ha(m.v3), address: m.v3, v4_id: None }, t0, t1));
    for p in &m.v4 {
        let id = p.v4_id.unwrap();
        list.push((FollowedPool { key: format!("{id:#x}"), address: m.pm, v4_id: Some(id) }, t0, t1));
    }
    let coins: Vec<Address> = (0..60u8).map(|i| Address::from_slice(&keccak256([i, 0xc0]).0[12..])).collect();
    for i in 0..1_800u32 {
        let h = keccak256(i.to_be_bytes());
        let addr = Address::from_slice(&h[12..]);
        let c0 = if i % 9 == 0 { m.usd } else if i % 9 == 1 { m.weth } else { coins[(i % 60) as usize] };
        let c1 = coins[((i / 7) % 60) as usize];
        if i % 6 == 0 {
            list.push((FollowedPool { key: format!("{h:#x}"), address: Address::from([0x99; 20]), v4_id: Some(h) }, c0, c1));
        } else {
            list.push((FollowedPool { key: ha(addr), address: addr, v4_id: None }, c0, c1));
        }
    }
    let set = Arc::new(PoolSet::build(&list, HashSet::new()));
    let ctx_of = |n: u64, ts: u64| BlockCtx { l1_block_number: 500, l2_block_number: Some(n), timestamp: ts, basefee: 0, coinbase: Address::ZERO, gas_limit: 1_000_000_000, prevrandao: B256::ZERO };
    // No per-message budget here: every message is applied and timed (the
    // share over the live 10 ms budget is counted from the samples).
    let mut ah = Ahead::new(AheadCfg { max_blocks: 32, msg_budget_us: 1_000_000, ..AheadCfg::default() });
    ah.set_pools(set);
    let mut truth = snap;
    ah.on_confirmed(Confirmed { seq: base_block, snap: Arc::new(truth.clone()), ctx: Some(ctx_of(base_block, t_base - 1)), diff: Arc::new(StateDiff::default()), prov: Arc::new(AllExact) }, &|_: &B256| None);
    let v3_key = ha(m.v3);
    let v4_keys: Vec<String> = m.v4.iter().map(|p| format!("{:#x}", p.v4_id.unwrap())).collect();
    // Which of our pools a chain diff touched (copy 2's "recent moves").
    let pools_in = |post: &Value| -> Vec<String> {
        let mut out = Vec::new();
        for (k, v) in post.as_object().into_iter().flatten() {
            let acct: Address = k.parse().unwrap();
            let slots: Vec<U256> = v.get("storage").and_then(|x| x.as_object()).into_iter().flatten().map(|(s, _)| parse_u256(s).unwrap()).collect();
            if acct == m.v3 && !slots.is_empty() {
                out.push(v3_key.clone());
            }
            if acct == m.pm {
                for (p, key) in m.v4.iter().zip(&v4_keys) {
                    let base = map_slot(U256::from_be_bytes(p.v4_id.unwrap().0), U256::from(6));
                    if slots.iter().any(|s| *s >= base && *s < base + U256::from(4u8)) {
                        out.push(key.clone());
                    }
                }
            }
        }
        out
    };
    let mut moves: std::collections::HashMap<B256, Vec<String>> = std::collections::HashMap::new();
    let mut checked = 0;
    let mut unsure_counts = Vec::new();
    let mut confirmed: Vec<(u64, Snapshot, StateDiff, u64)> = Vec::new();
    for (i, (ts, txs)) in msgs.iter().enumerate() {
        let seq = base_block + 1 + i as u64;
        // The chain's changes in this block: copy 2's confirmed version (handed
        // over ONE block later, as live: reports come after the feed).
        let mut diff = StateDiff::default();
        for (h, post) in &posts[i] {
            moves.insert(*h, pools_in(post));
            for (k, v) in post.as_object().into_iter().flatten() {
                let acct: Address = k.parse().unwrap();
                let old = truth.accounts.get(&acct).and_then(|x| match &x.basics {
                    arbsim::state::snap::Basics::Known(Some(i)) => Some(i.clone()),
                    _ => None,
                });
                if v.get("balance").is_some() || v.get("nonce").is_some() {
                    let mut info = old.unwrap_or_default();
                    if let Some(b) = v.get("balance") {
                        info.balance = uv(b);
                    }
                    if let Some(n) = v.get("nonce").and_then(|n| n.as_u64()) {
                        info.nonce = n;
                    }
                    if info.code_hash == B256::ZERO {
                        info.code_hash = KECCAK_EMPTY;
                    }
                    truth.apply_fact(&Fact::Basics { addr: acct, info: Some(info), code: None });
                }
                for (sk, sv) in v.get("storage").and_then(|x| x.as_object()).into_iter().flatten() {
                    let slot = parse_u256(sk).unwrap();
                    truth.apply_fact(&Fact::Slot(acct, slot, uv(sv)));
                    diff.accounts.entry(acct).or_default().storage.insert(slot, uv(sv));
                }
            }
        }
        confirmed.push((seq, truth.clone(), diff, *ts));
        let wm = WireFeedMsg { seq, ts: *ts, l1: 500, txs: txs.iter().map(|t| hb(t)).collect(), complete: true, why: None };
        let bm = Arc::new(BinMsg::from_wire(&wm, true));
        for t in &bm.txs {
            let _ = t.decoded(); // the feed store's thread does this live
        }
        if std::env::var("AHEAD_DEBUG").is_ok() {
            eprintln!("[bench] message {i} (seq {seq})");
        }
        ah.on_feed_message(bm);
        match ah.tip() {
            None => eprintln!("[bench] message {i}: no tip (stopped: {:?})", ah.stopped()),
            Some(tip) => {
                unsure_counts.push(tip.unsure_pools.len());
                // ACCURACY: every pool we predict as sure equals the chain, value for value.
                let view = tip.view();
                let chain = |acct: Address, slot: U256| uv(&a.ok("eth_getStorageAt", json!([ha(acct), format!("{slot:#x}"), format!("{seq:#x}")])));
                if !tip.unsure_pools.contains(&v3_key) {
                    assert_eq!(view.storage(m.v3, U256::ZERO), Lookup::Known(chain(m.v3, U256::ZERO)), "V3 slot0 after message {i}");
                    checked += 1;
                }
                for (p, k) in m.v4.iter().zip(&v4_keys) {
                    if !tip.unsure_pools.contains(k) {
                        let base = map_slot(U256::from_be_bytes(p.v4_id.unwrap().0), U256::from(6));
                        for d in 0..4u8 {
                            let s = base + U256::from(d);
                            assert_eq!(view.storage(m.pm, s), Lookup::Known(chain(m.pm, s)), "V4 pool value {d} after message {i}");
                        }
                        checked += 1;
                    }
                }
            }
        }
        // Copy 2 confirms the PREVIOUS block now (one behind, like live).
        if i >= 1 {
            let (cs, csnap, cdiff, cts) = confirmed[i - 1].clone();
            let mv = moves.clone();
            ah.on_confirmed(Confirmed { seq: cs, snap: Arc::new(csnap), ctx: Some(ctx_of(cs, cts)), diff: Arc::new(cdiff), prov: Arc::new(AllExact) }, &move |h: &B256| mv.get(h).cloned().filter(|v| !v.is_empty()));
        }
    }
    let j = ah.total.json();
    let mut samples = ah.total.apply_us.clone();
    let over_10ms = samples.iter().filter(|x| **x > 10_000).count();
    let (p50, p90, p99, max) = pct(&mut samples);
    unsure_counts.sort();
    eprintln!(
        "[bench, TEST numbers] predicted copy on REAL V3 + V4 pools, {} msgs x 12 txs (4 real swaps, 1 rival bot, 7 unrelated), 1,803 followed pools, confirmed one block behind: apply us p50 {p50} p90 {p90} p99 {p99} max {max} over {} applies (incl. re-applies after rebases), {over_10ms} over 10 ms; txs run {} skipped {} failed {}; agree {} disagree {} (missed {}) unsure {}; unsure pools per tip: median {} max {}; sure pool predictions checked against the chain: {checked} (all equal)",
        n_msgs, samples.len(), j["txsRun"], j["txsSkipped"], j["txsFailed"], j["agree"], j["disagree"], j["missed"], j["unsure"],
        unsure_counts.get(unsure_counts.len() / 2).copied().unwrap_or(0), unsure_counts.last().copied().unwrap_or(0),
    );
    assert!(checked > 0, "some predictions were sure and checked");
}
