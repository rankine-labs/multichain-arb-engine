// ============================================================================
// COPY 2 WARM RESTART: SIZES AND TIMES (copy2/persist.rs, intake.rs).
//
// Plain English:
//   A made-up copy the size of the live one (full size: 650 pools, ~265k
//   held values: 576 tick pools with ~440 walked values each, half of them
//   V4 with far-zero lists, 74 V2 pools with coin balances) and a fake node
//   that answers like Chainstack (logs carry blockTimestamp; the
//   parent-chain block changes every 120 blocks = 12 s; every request takes
//   ARBSIM_BENCH_LATENCY_MS). Measures:
//     1. save: the intake thread's part (it must not hold up blocks), the
//        file size, the writing time (saver thread), the reading time;
//     2. block application while saves run (every second) vs without;
//     3. the catch-up after a 5 minute and a 30 minute gap (3,000 / 18,000
//        blocks, ~1 transaction with 3 reports per block): node requests,
//        headers read, seconds until the copy answers again.
//   Default size runs in the normal suite (small, with loose limits);
//   COPY2_RESUME_BENCH_FULL=1 for the full-size numbers (release build):
//     COPY2_RESUME_BENCH_FULL=1 cargo test --release --test copy2_resume_bench -- --nocapture --test-threads=1
// ============================================================================
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use arbsim::copy2::coins::BalanceLayout;
use arbsim::copy2::intake::{manual, BlockMsg, C2Config, Copy2Handle, FarZero, Intake, PoolEntry, PoolState, WalkInfo};
use arbsim::copy2::persist;
use arbsim::copy2::{BlockCtx as ReplayCtx, PoolKind, PoolLog, TrackedPool};
use arbsim::node::{CallResult, Class, NodeApi, NodeErr};
use arbsim::state::fill::FillQueue;
use arbsim::state::mirror::{Config, Shared};
use arbsim::state::snap::{Fact, Snapshot, Volatile};
use revm::primitives::{keccak256, Address, Bytes, B256, U256};
use revm::state::{AccountInfo, Bytecode};
use serde_json::{json, Value};

fn full() -> bool {
    std::env::var("COPY2_RESUME_BENCH_FULL").is_ok_and(|v| v == "1")
}

fn h(tag: &str, i: u64) -> U256 {
    U256::from_be_bytes(keccak256(format!("{tag}{i}").as_bytes()).0)
}

fn addr(tag: u8, i: u64) -> Address {
    let mut b = [0u8; 20];
    b[0] = tag;
    b[12..20].copy_from_slice(&i.to_be_bytes());
    Address::from(b)
}

fn bal_slot(holder: Address) -> U256 {
    BalanceLayout::solidity(0).key(holder)
}

const PM: u8 = 0xee;
const S: u64 = 1_000_000;
const T0: u64 = 1_760_000_000;

fn ts_of(b: u64) -> u64 {
    T0 + b / 10
}
fn l1_of(b: u64) -> u64 {
    20_000_000 + b / 120
}

struct Sizes {
    v3: u64,
    v2: u64,
    walked: u64,
    far: u64,
}

fn sizes() -> Sizes {
    if full() {
        Sizes { v3: 576, v2: 74, walked: 440, far: 700 }
    } else {
        Sizes { v3: 60, v2: 20, walked: 100, far: 100 }
    }
}

fn v2_pool(i: u64) -> TrackedPool {
    TrackedPool { address: addr(0xa2, i), v4_id: None, kind: PoolKind::V2, token0: addr(0xc0, i % 30), token1: addr(0xc0, 30 + i % 30), fee: 0, tick_spacing: 0 }
}

fn entry(p: TrackedPool, items: HashSet<(Address, U256)>, walked: Vec<(Address, U256)>, far: Option<FarZero>) -> PoolEntry {
    let now = Instant::now();
    PoolEntry {
        accounts: [p.address].into_iter().collect(),
        pool: p,
        state: PoolState::Ready,
        reason: String::new(),
        events: 0,
        strikes: 0,
        clean_events: 0,
        retry_at: now,
        owned: vec![],
        items,
        verified: true,
        gen: 0,
        ready_since: S - 100,
        busy: false,
        ever_ready: true,
        rounds: 0,
        fails: 0,
        walk: if walked.is_empty() { None } else { Some(WalkInfo { block: S - 50, done: true, center: 0, word_lo: -8, word_hi: 8, ticks: 40, slots: walked.len() }) },
        walk_busy: false,
        walk_retry_at: now,
        walk_fails: 0,
        walked,
        far_zero: far,
        pending_from: None,
        base_block: S - 100,
        need_base: 0,
    }
}

/// The made-up copy at block S.
fn state(z: &Sizes) -> persist::State {
    let mut s = Snapshot::default();
    let code = |n: u8| Bytecode::new_raw(Bytes::from(vec![0x60, n, 0x60, 0x00, 0x55, 0x00]));
    let put_contract = |s: &mut Snapshot, a: Address, n: u8| {
        let c = code(n);
        let hh = keccak256(c.original_byte_slice());
        s.apply_fact(&Fact::Basics { addr: a, info: Some(AccountInfo { balance: U256::ZERO, nonce: 1, code_hash: hh, ..Default::default() }), code: Some(c) });
    };
    let mut pools = Vec::new();
    for c in 0..60 {
        put_contract(&mut s, addr(0xc0, c), 1);
    }
    put_contract(&mut s, addr(PM, 0), 2);
    for i in 0..z.v3 {
        let v4 = i % 2 == 1;
        let (acct, p) = if v4 {
            let id = B256::from(h("id", i).to_be_bytes::<32>());
            (addr(PM, 0), TrackedPool { address: addr(PM, 0), v4_id: Some(id), kind: PoolKind::V4, token0: addr(0xc0, i % 60), token1: addr(0xc0, (i + 7) % 60), fee: 500, tick_spacing: 10 })
        } else {
            put_contract(&mut s, addr(0xa3, i), 3);
            (addr(0xa3, i), TrackedPool { address: addr(0xa3, i), v4_id: None, kind: PoolKind::V3, token0: addr(0xc0, i % 60), token1: addr(0xc0, (i + 7) % 60), fee: 3000, tick_spacing: 60 })
        };
        let mut items = HashSet::new();
        for k in 0..20 {
            let sl = h(&format!("it{i}"), k);
            s.apply_fact(&Fact::Slot(acct, sl, h("v", k + i)));
            items.insert((acct, sl));
        }
        let mut walked = Vec::new();
        for k in 0..z.walked {
            let sl = h(&format!("wk{i}"), k);
            s.apply_fact(&Fact::Slot(acct, sl, h("w", k * 7 + i)));
            walked.push((acct, sl));
        }
        walked.sort();
        if !v4 {
            for c in [p.token0, p.token1] {
                s.apply_fact(&Fact::Slot(c, bal_slot(p.address), U256::from(10u8).pow(U256::from(30u8))));
            }
        }
        let far = v4.then(|| {
            let mut v: Vec<U256> = (0..z.far).map(|k| h(&format!("fz{i}"), k)).collect();
            v.sort();
            FarZero { block: S - 50, slots: Arc::new(v) }
        });
        pools.push((entry(p, items, walked, far), Some((S, u32::MAX, u32::MAX))));
    }
    for i in 0..z.v2 {
        let p = v2_pool(i);
        put_contract(&mut s, p.address, 4);
        let mut items = HashSet::new();
        let reserves = U256::from(1u64 << 40) | (U256::from(1u64 << 41) << 112usize) | (U256::from(ts_of(S - 5)) << 224usize);
        for (sl, v) in [(0u64, U256::from(1_000_000u64)), (6, U256::ZERO), (7, U256::ZERO), (8, reserves), (9, U256::from(5u8)), (10, U256::from(6u8)), (12, U256::from(1u8))] {
            s.apply_fact(&Fact::Slot(p.address, U256::from(sl), v));
            items.insert((p.address, U256::from(sl)));
        }
        for c in [p.token0, p.token1] {
            s.apply_fact(&Fact::Slot(c, bal_slot(p.address), U256::from(10u8).pow(U256::from(30u8))));
        }
        pools.push((entry(p, items, vec![], None), Some((S, u32::MAX, u32::MAX))));
    }
    let layouts: Vec<(Address, BalanceLayout)> = (0..60).map(|c| (addr(0xc0, c), BalanceLayout::solidity(0))).collect();
    let mut coins = Vec::new();
    for (e, _) in &pools {
        if e.pool.v4_id.is_none() {
            for c in [e.pool.token0, e.pool.token1] {
                coins.push(((c, e.pool.address), Some((S, u32::MAX, u32::MAX)), Some(S - 100)));
            }
        }
    }
    // The last 64 blocks' reports (the copy had them all).
    let buf = (S - 63..=S).map(|b| (b, ReplayCtx { number: b, timestamp: ts_of(b), l1_number: l1_of(b) }, Arc::new(block_logs(b, z.v2)))).collect();
    persist::State {
        block: S,
        ctx: Some((ts_of(S), l1_of(S), 10_000_000)),
        saved_ms: persist::now_ms(),
        snap: Arc::new(s),
        strip: HashSet::new(),
        volatile_whole: vec![],
        volatile_balance: vec![],
        pools,
        layouts,
        pair_slots: vec![],
        per_pool_coins: vec![],
        coin_ok: (0..60).map(|c| addr(0xc0, c)).collect(),
        coins,
        buf,
    }
}

// ---------------------------------------------------------------------------
// The chain's reports: ~1 transaction per block on a V2 pool (Sync + a coin
// in + a coin out), the same for the bot's messages and the node's logs.
// ---------------------------------------------------------------------------
fn topic(sig: &str) -> B256 {
    keccak256(sig.as_bytes())
}

fn pad(a: Address) -> B256 {
    let mut b = [0u8; 32];
    b[12..].copy_from_slice(a.as_slice());
    B256::from(b)
}

fn block_logs(b: u64, n_v2: u64) -> Vec<PoolLog> {
    let r = h("blk", b);
    let txs = (r.as_limbs()[0] % 3) as u32; // 0, 1 or 2: ~1 per block
    let mut out = Vec::new();
    let user = addr(0x99, 1);
    for t in 0..txs {
        let i = (r.as_limbs()[1].wrapping_add(t as u64 * 7919)) % n_v2;
        let p = v2_pool(i);
        let th = B256::from(h(&format!("tx{b}"), t as u64).to_be_bytes::<32>());
        let amt = U256::from(1000 + (r.as_limbs()[2] % 1000));
        let mk = |a: Address, topics: Vec<B256>, data: Vec<u8>, li: u32| PoolLog { address: a, topics, data: Bytes::from(data), block: b, tx_index: t, log_index: li, tx_hash: th, removed: false };
        out.push(mk(p.token0, vec![topic("Transfer(address,address,uint256)"), pad(user), pad(p.address)], amt.to_be_bytes::<32>().to_vec(), t * 3));
        out.push(mk(p.token1, vec![topic("Transfer(address,address,uint256)"), pad(p.address), pad(user)], amt.to_be_bytes::<32>().to_vec(), t * 3 + 1));
        let mut d = Vec::new();
        d.extend(U256::from((1u64 << 40) + b).to_be_bytes::<32>());
        d.extend(U256::from((1u64 << 41) - b).to_be_bytes::<32>());
        out.push(mk(p.address, vec![topic("Sync(uint112,uint112)")], d, t * 3 + 2));
    }
    out
}

fn log_json(l: &PoolLog) -> Value {
    json!({
        "address": format!("{:#x}", l.address),
        "topics": l.topics.iter().map(|t| format!("{t}")).collect::<Vec<_>>(),
        "data": format!("0x{}", l.data.iter().map(|x| format!("{x:02x}")).collect::<String>()),
        "blockNumber": format!("{:#x}", l.block),
        "transactionIndex": format!("{:#x}", l.tx_index),
        "logIndex": format!("{:#x}", l.log_index),
        "transactionHash": format!("{}", l.tx_hash),
        "blockTimestamp": format!("{:#x}", ts_of(l.block)),
        "removed": false,
    })
}

fn qty(v: &Value) -> u64 {
    u64::from_str_radix(v.as_str().unwrap().trim_start_matches("0x"), 16).unwrap()
}

/// A node like Chainstack (see header): every request waits `latency`.
struct FakeNode {
    tip: AtomicU64,
    n_v2: u64,
    latency: Duration,
    public: AtomicU64,
    paid: AtomicU64,
    log_calls: AtomicU64,
    headers: AtomicU64,
    logs_out: AtomicU64,
    _m: Mutex<()>,
}

impl FakeNode {
    fn answer(&self, m: &str, p: &Value) -> CallResult {
        Ok(match m {
            "eth_blockNumber" => json!(format!("{:#x}", self.tip.load(Ordering::Relaxed))),
            "eth_getBlockByNumber" => {
                self.headers.fetch_add(1, Ordering::Relaxed);
                let b = qty(&p[0]);
                if b > self.tip.load(Ordering::Relaxed) {
                    Value::Null
                } else {
                    json!({ "number": format!("{b:#x}"), "timestamp": format!("{:#x}", ts_of(b)), "l1BlockNumber": format!("{:#x}", l1_of(b)) })
                }
            }
            "eth_getLogs" => {
                self.log_calls.fetch_add(1, Ordering::Relaxed);
                let f = &p[0];
                let (from, to) = (qty(&f["fromBlock"]), qty(&f["toBlock"]));
                let topics = f.get("topics").and_then(|t| t.as_array()).cloned().unwrap_or_default();
                let mut out = Vec::new();
                for b in from..=to {
                    for l in block_logs(b, self.n_v2) {
                        let is_transfer = l.topics.len() == 3;
                        let keep = match topics.len() {
                            0 => !is_transfer,                                   // pools' own events
                            2 => is_transfer && !topics[1].is_null(),             // transfers FROM pools
                            3 => is_transfer && topics[1].is_null() && !topics[2].is_null(), // ... TO pools
                            _ => false,
                        };
                        let keep = keep
                            && match topics.len() {
                                2 => l.topics[1] != pad(addr(0x99, 1)),
                                3 => l.topics[2] != pad(addr(0x99, 1)),
                                _ => true,
                            };
                        // The V4 PoolManager filter ([null, ids]) matches nothing here.
                        if keep && !(topics.len() == 2 && topics[0].is_null()) {
                            out.push(log_json(&l));
                        }
                    }
                }
                self.logs_out.fetch_add(out.len() as u64, Ordering::Relaxed);
                Value::Array(out)
            }
            _ => Value::Null,
        })
    }
}

impl NodeApi for FakeNode {
    fn call_batch(&self, _c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        self.public.fetch_add(1, Ordering::Relaxed);
        std::thread::sleep(self.latency);
        Ok(calls.iter().map(|(m, p)| self.answer(m, p)).collect())
    }
    fn call_batch_paid(&self, _c: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        self.paid.fetch_add(1, Ordering::Relaxed);
        std::thread::sleep(self.latency);
        Ok(calls.iter().map(|(m, p)| self.answer(m, p)).collect())
    }
}

fn latency() -> Duration {
    Duration::from_millis(std::env::var("ARBSIM_BENCH_LATENCY_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(if full() { 80 } else { 5 }))
}

fn fake(tip: u64, n_v2: u64) -> Arc<FakeNode> {
    Arc::new(FakeNode { tip: AtomicU64::new(tip), n_v2, latency: latency(), public: AtomicU64::new(0), paid: AtomicU64::new(0), log_calls: AtomicU64::new(0), headers: AtomicU64::new(0), logs_out: AtomicU64::new(0), _m: Mutex::new(()) })
}

fn copy(node: Arc<FakeNode>, file: Option<String>, save_every_s: u64) -> (Arc<Shared>, Intake, Copy2Handle) {
    let nd: Arc<dyn NodeApi> = node;
    let sh = Shared::new(Config { history: 64, ..Config::for_tests() }, Some(nd), Arc::new(Volatile::default()));
    let cfg = C2Config { state_file: file, save_every_s, walks_inflight: 0, keep_blocks: 2400, ..C2Config::for_tests() };
    let (i, hd) = manual(sh.clone(), Arc::new(FillQueue::new(1000, 100)), cfg);
    (sh, i, hd)
}

fn msg(b: u64, prev: Option<u64>, n_v2: u64) -> BlockMsg {
    let logs = block_logs(b, n_v2);
    BlockMsg { block: b, timestamp: ts_of(b), l1_block: Some(l1_of(b)), base_fee: None, prev_block: prev, tick: logs.is_empty(), logs, gap_reason: None, bloom: None }
}

fn counter(hd: &Copy2Handle, name: &str) -> u64 {
    hd.status_json(false)["counters"][name].as_u64().unwrap_or(0)
}

/// Feed block messages until the restored copy has caught up.
fn catch_up(intake: &mut Intake, hd: &Copy2Handle, first: u64, n_v2: u64) -> Duration {
    let t0 = Instant::now();
    let mut m = msg(first, Some(first), n_v2);
    m.gap_reason = Some("start".into());
    hd.block(m);
    while counter(hd, "catchups_done") + counter(hd, "catchups_failed") == 0 {
        intake.pump();
        std::thread::sleep(Duration::from_millis(1));
        assert!(t0.elapsed() < Duration::from_secs(600), "catch-up never finished: {}", hd.status_json(false)["resume"]);
    }
    intake.pump();
    t0.elapsed()
}

fn pct(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() as f64 - 1.0) * p).round() as usize]
}

#[test]
fn warm_restart_sizes_and_times() {
    let z = sizes();
    let dir = std::env::temp_dir().join(format!("arbsim-resume-bench-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path0 = dir.join("made-up.bin").to_str().unwrap().to_string();
    // Each copy below gets its own file, a fresh copy of the made-up one.
    let fresh = |name: &str| -> String {
        let p = dir.join(name).to_str().unwrap().to_string();
        std::fs::copy(&path0, &p).unwrap();
        p
    };
    // ---- 1. save / load ----
    let st0 = state(&z);
    let (n_acc, n_slots, _) = st0.snap.counts();
    let rep = persist::save(&st0, &path0).unwrap();
    eprintln!("made-up copy: {} pools, {n_acc} accounts, {n_slots} values", st0.pools.len());
    let t = Instant::now();
    let back = persist::load(&path0, Arc::new(Volatile::default())).unwrap();
    let load_ms = t.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(back.snap.counts().1, n_slots);
    drop(back);
    // A real copy restored from it, caught up (no gap) so it can save.
    let node = fake(S + 1, z.v2);
    let (sh, mut intake, hd) = copy(node.clone(), Some(fresh("one.bin")), 3600);
    assert_eq!(counter(&hd, "resume_pools"), z.v3 + z.v2);
    catch_up(&mut intake, &hd, S + 1, z.v2);
    assert_eq!(counter(&hd, "catchups_done"), 1, "{}", hd.status_json(false)["resume"]);
    let mut prep = Vec::new();
    for _ in 0..7 {
        let t = Instant::now();
        let st = intake.save_state().expect("something to save");
        prep.push(t.elapsed().as_secs_f64() * 1000.0);
        drop(st);
    }
    let t = Instant::now();
    let rep2 = intake.save_now().unwrap();
    let save_wall = t.elapsed().as_secs_f64() * 1000.0;
    eprintln!(
        "SAVE: file {:.1} MB ({} values, {} pools); intake thread's part (prepare) median {:.2} ms, max {:.2} ms; writing (saver thread) {:.0} ms (save_now total {:.0} ms); first file written in {:.0} ms; reading it back {load_ms:.0} ms",
        rep2.bytes as f64 / 1e6,
        rep2.slots,
        rep2.pools,
        pct(&mut prep.clone(), 0.5),
        pct(&mut prep, 1.0),
        rep2.write_ms,
        save_wall,
        rep.write_ms
    );
    drop(intake);
    drop(hd);
    drop(sh);
    // ---- 2. block application with / without saves running ----
    let apply = |save_every: u64| -> (f64, f64, f64, u64) {
        let node = fake(S + 1, z.v2);
        let (_sh, mut intake, hd) = copy(node, Some(fresh(&format!("apply{save_every}.bin"))), save_every);
        catch_up(&mut intake, &hd, S + 1, z.v2);
        let mut times = Vec::new();
        let t0 = Instant::now();
        let mut b = S + 2;
        while t0.elapsed() < Duration::from_secs(if full() { 8 } else { 3 }) {
            hd.block(msg(b, Some(b - 1), z.v2));
            let t = Instant::now();
            intake.pump();
            times.push(t.elapsed().as_secs_f64() * 1000.0);
            b += 1;
            std::thread::sleep(Duration::from_millis(5));
        }
        let saves = counter(&hd, "saves");
        assert_eq!(counter(&hd, "unsure_marked"), 0);
        (pct(&mut times.clone(), 0.5), pct(&mut times.clone(), 0.99), pct(&mut times, 1.0), saves)
    };
    let (p50a, p99a, maxa, _) = apply(3600);
    let (p50b, p99b, maxb, saves) = apply(1);
    eprintln!("APPLY (one block message, intake thread): no saves p50 {p50a:.2} / p99 {p99a:.2} / max {maxa:.2} ms; saving every second ({saves} saves) p50 {p50b:.2} / p99 {p99b:.2} / max {maxb:.2} ms");
    assert!(saves >= 2, "saves ran during the test");
    // The save's part on the intake thread is small (generous limit: a
    // debug build and a shared test machine).
    assert!(maxb < maxa + 250.0, "a save held up a block: max {maxb:.1} ms vs {maxa:.1} ms without");
    // ---- 3. catch-up cost ----
    let gaps: Vec<(u64, &str)> = if full() { vec![(3000, "5 min"), (18_000, "30 min")] } else { vec![(600, "1 min"), (3000, "5 min")] };
    for (gap, label) in gaps {
        let first = S + gap + 1;
        let node = fake(first, z.v2);
        let (sh, mut intake, hd) = copy(node.clone(), Some(fresh(&format!("gap{gap}.bin"))), 3600);
        let took = catch_up(&mut intake, &hd, first, z.v2);
        let r = hd.status_json(false)["resume"].clone();
        assert_eq!(counter(&hd, "catchups_done"), 1, "{label}: {r}");
        assert_eq!(counter(&hd, "unsure_marked"), 0, "{label}: no pool unsure");
        assert_eq!(sh.head().unwrap().block, first, "{label}: at the bot's block");
        let (pubr, paid) = (node.public.load(Ordering::Relaxed), node.paid.load(Ordering::Relaxed));
        eprintln!(
            "CATCH-UP {label} ({gap} blocks, {} reports): {:.1} s until answering ({} ms per request), {} HTTP requests ({pubr} free node, {paid} paid), {} eth_getLogs calls, {} headers (copy's own count: {} s)",
            node.logs_out.load(Ordering::Relaxed),
            took.as_secs_f64(),
            latency().as_millis(),
            pubr + paid,
            node.log_calls.load(Ordering::Relaxed),
            node.headers.load(Ordering::Relaxed),
            r["lastCatchUp"]["seconds"],
        );
        // Requests: one per 500-block range + a few header rounds.
        assert!(pubr + paid <= gap / 500 * 2 + 40, "{label}: {pubr} + {paid} requests");
    }
    let _ = std::fs::remove_dir_all(&dir);
}
