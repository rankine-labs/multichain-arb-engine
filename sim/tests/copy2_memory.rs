// ============================================================================
// Copy 2 memory bench (dry run #18: 331 MB after 150k walked slots).
//
// Plain English:
//   A pretend node holds N Uniswap-V3-style pools (each with S storage values
//   that its tick walk returns), some V2 pools that trade every block, and
//   coins. We follow them through the REAL intake path (track -> load ->
//   tick walk -> blocks) with the production history (64 versions kept), and
//   count every byte the program has allocated (a counting allocator wraps
//   the normal one) plus the process RSS.
//
//   Printed (run with --nocapture):
//     heap after loading, after all walks, after many blocks (must stay
//     flat), bytes per walked slot, RSS.
//   Asserted: the heap per walked slot stays small and does not grow over
//   blocks.
//
//   Size: COPY2_MEM_POOLS (default 200) x COPY2_MEM_SLOTS (default 375)
//   walked values; the full-coverage case is 800 x 375 = 300k:
//     COPY2_MEM_POOLS=800 cargo test --release --test copy2_memory -- --nocapture
//
//   A second test (version_churn_*) measures what each kept version costs
//   when pools' storage changes every block (what a V3 swap replay does):
//   the same Snapshot / Overlay code, without needing real pool code.
// ============================================================================
use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use arbsim::check::hexutil::{parse_address, parse_bytes, parse_u256};
use arbsim::copy2::fields::{map_slot, topics};
use arbsim::copy2::intake::{manual, BlockMsg, C2Config};
use arbsim::copy2::overlay::Overlay;
use arbsim::copy2::walk::LENS;
use arbsim::copy2::PoolLog;
use arbsim::node::{CallResult, Class, NodeApi, NodeErr, RpcErr};
use arbsim::state::fill::FillQueue;
use arbsim::state::mirror::{Config, Shared};
use arbsim::state::snap::{Snapshot, Volatile};
use arbsim::state::{StateDiff, StatePosition};
use revm::primitives::{keccak256, Address, Bytes, B256, U256};
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// Counting allocator: live bytes and peak, for the whole test binary.
// ---------------------------------------------------------------------------
struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            let n = LIVE.fetch_add(l.size(), Ordering::Relaxed) + l.size();
            PEAK.fetch_max(n, Ordering::Relaxed);
        }
        p
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        let p = System.alloc_zeroed(l);
        if !p.is_null() {
            let n = LIVE.fetch_add(l.size(), Ordering::Relaxed) + l.size();
            PEAK.fetch_max(n, Ordering::Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        System.dealloc(p, l);
        LIVE.fetch_sub(l.size(), Ordering::Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        let q = System.realloc(p, l, new);
        if !q.is_null() {
            if new >= l.size() {
                let n = LIVE.fetch_add(new - l.size(), Ordering::Relaxed) + (new - l.size());
                PEAK.fetch_max(n, Ordering::Relaxed);
            } else {
                LIVE.fetch_sub(l.size() - new, Ordering::Relaxed);
            }
        }
        q
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

fn live_mb() -> f64 {
    LIVE.load(Ordering::Relaxed) as f64 / 1_048_576.0
}
fn rss_mb() -> f64 {
    Shared::rss_mb()
}

/// The two tests measure the same counters: never at the same time.
static SERIAL: Mutex<()> = Mutex::new(());

fn env_usize(k: &str, d: usize) -> usize {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

// ---------------------------------------------------------------------------
// Pretend world
// ---------------------------------------------------------------------------
fn a2(tag: u8, i: u32) -> Address {
    let mut b = [0u8; 20];
    b[0] = tag;
    b[16..].copy_from_slice(&i.to_be_bytes());
    Address::from(b)
}
fn w(v: U256) -> String {
    format!("{v:#066x}")
}
fn rnd(seed: &[u8]) -> U256 {
    U256::from_be_bytes(keccak256(seed).0)
}
fn sel(sig: &str) -> [u8; 4] {
    let h = keccak256(sig.as_bytes());
    [h[0], h[1], h[2], h[3]]
}
fn addr_word(x: Address) -> U256 {
    U256::from_be_slice(x.as_slice())
}
fn topic_of(x: Address) -> B256 {
    let mut b = [0u8; 32];
    b[12..].copy_from_slice(x.as_slice());
    B256::from(b)
}

const USER: u8 = 0x77;

struct World {
    v3: Vec<Address>,
    v2: Vec<Address>,
    coins: Vec<Address>,
    /// account -> slot -> value (pools AND coins).
    storage: HashMap<Address, HashMap<U256, U256>>,
    /// Pool -> its walk answer slots.
    walk: HashMap<Address, Vec<(U256, U256)>>,
    code: Vec<u8>,
    tip: Mutex<u64>,
    trace_delay_ms: u64,
    traces: AtomicUsize,
}

fn tokens(i: usize, ncoins: usize) -> (usize, usize) {
    let t0 = i % ncoins;
    let t1 = (t0 + 1 + (i / ncoins) % (ncoins - 1)) % ncoins;
    (t0.min(t1), t0.max(t1))
}

impl World {
    fn new(n_v3: usize, slots: usize, n_v2: usize, ncoins: usize, trace_delay_ms: u64) -> World {
        let coins: Vec<Address> = (0..ncoins as u32).map(|i| a2(0xc0, i)).collect();
        let v3: Vec<Address> = (0..n_v3 as u32).map(|i| a2(0x33, i)).collect();
        let v2: Vec<Address> = (0..n_v2 as u32).map(|i| a2(0x22, i)).collect();
        let mut storage: HashMap<Address, HashMap<U256, U256>> = HashMap::new();
        let mut walk = HashMap::new();
        for (i, p) in v3.iter().enumerate() {
            let st = storage.entry(*p).or_default();
            // slot0 (tick 0 region), fee growth, protocol fees, liquidity
            for s in 0..5u64 {
                st.insert(U256::from(s), rnd(&[p.as_slice(), &s.to_be_bytes()].concat()) >> 8usize);
            }
            // slot0: sqrt price 2^96 (price 1), tick 0 = the walk's center.
            st.insert(U256::ZERO, U256::from(1) << 96usize);
            // Walk: tick-map words, ticks (4 slots each), price history: like
            // the real layout (mapping slots = hashed keys, history = small).
            let mut ws = Vec::with_capacity(slots);
            for s in 0..5u64 {
                ws.push((U256::from(s), st[&U256::from(s)]));
            }
            let mut j = 0u64;
            while ws.len() < slots {
                let key = if j % 5 == 4 { U256::from(8 + j / 5) } else { map_slot(Address::from_word(B256::from(U256::from(j))), 5 + (j % 2)) };
                let val = rnd(&[p.as_slice(), &j.to_be_bytes(), b"v"].concat());
                ws.push((key, val));
                st.insert(key, val);
                j += 1;
            }
            walk.insert(*p, ws);
            let (t0, t1) = tokens(i, ncoins);
            for c in [coins[t0], coins[t1]] {
                storage.entry(c).or_default().insert(map_slot(*p, 0), U256::from(10u128.pow(24)));
            }
        }
        for (i, p) in v2.iter().enumerate() {
            let (t0, t1) = tokens(i, ncoins);
            let st = storage.entry(*p).or_default();
            st.insert(U256::from(0), U256::from(2000));
            st.insert(U256::from(6), addr_word(coins[t0]));
            st.insert(U256::from(7), addr_word(coins[t1]));
            st.insert(U256::from(8), U256::from(1_000_000u64) | (U256::from(4_000_000u64) << 112usize) | (U256::from(50) << 224usize));
            st.insert(U256::from(9), U256::from(5));
            st.insert(U256::from(10), U256::from(6));
            for c in [coins[t0], coins[t1]] {
                storage.entry(c).or_default().insert(map_slot(*p, 0), U256::from(10u128.pow(24)));
            }
        }
        for c in &coins {
            storage.entry(*c).or_default().insert(map_slot(a2(USER, 0), 0), U256::from(10u128.pow(30)));
        }
        // ~20 KB of code, the same for every pool (one factory).
        let code: Vec<u8> = (0..20_000u32).map(|i| if i % 97 == 0 { 0x5b } else { 0x60 }).collect();
        World { v3, v2, coins, storage, walk, code, tip: Mutex::new(100), trace_delay_ms, traces: AtomicUsize::new(0) }
    }
    fn sload(&self, a: Address, s: U256) -> U256 {
        self.storage.get(&a).and_then(|m| m.get(&s).copied()).unwrap_or_default()
    }
    fn exists(&self, a: &Address) -> bool {
        self.storage.contains_key(a)
    }
    fn done_marker(&self) -> U256 {
        // Same as walk.rs done_base(): word_lo -8, word_hi 8, center 0.
        let base = U256::from_str_radix("c0b72d0e5a1f00d5c0b72d0e5a1f00d500000000000000000000000000000000", 16).unwrap();
        let low: u128 = 0xfff8 | (8 << 16) | (100 << 56) | (17 << 80);
        base | U256::from(low)
    }
}

impl NodeApi for World {
    fn call_batch(&self, _class: Class, calls: &[(&str, Value)]) -> Result<Vec<CallResult>, NodeErr> {
        Ok(calls
            .iter()
            .map(|(m, p)| -> CallResult {
                match *m {
                    "eth_blockNumber" => Ok(json!(format!("{:#x}", *self.tip.lock().unwrap()))),
                    "eth_getLogs" => Ok(json!([])),
                    "eth_getBlockByNumber" => Ok(Value::Null),
                    "eth_getProof" => {
                        let acct = parse_address(p[0].as_str().unwrap()).unwrap();
                        let code_hash = if self.exists(&acct) { keccak256(&self.code) } else { revm::primitives::KECCAK_EMPTY };
                        let sp: Vec<Value> = p[1]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|k| {
                                let key = parse_u256(k.as_str().unwrap()).unwrap();
                                json!({"key": k, "value": format!("{:#x}", self.sload(acct, key)), "proof": []})
                            })
                            .collect();
                        Ok(json!({"address": format!("{acct:#x}"), "balance": "0x0", "nonce": if self.exists(&acct) { "0x1" } else { "0x0" },
                                  "codeHash": format!("{code_hash}"), "storageHash": format!("{:#066x}", 0), "accountProof": [], "storageProof": sp}))
                    }
                    "eth_getStorageAt" => {
                        let acct = parse_address(p[0].as_str().unwrap()).unwrap();
                        let s = parse_u256(p[1].as_str().unwrap()).unwrap();
                        Ok(json!(w(self.sload(acct, s))))
                    }
                    "eth_getBalance" | "eth_getTransactionCount" => Ok(json!("0x0")),
                    "eth_getCode" => {
                        let acct = parse_address(p[0].as_str().unwrap()).unwrap();
                        Ok(json!(if self.exists(&acct) { format!("0x{}", self.code.iter().map(|b| format!("{b:02x}")).collect::<String>()) } else { "0x".into() }))
                    }
                    "eth_call" => {
                        let to = parse_address(p[0]["to"].as_str().unwrap()).unwrap();
                        let data: Bytes = parse_bytes(p[0]["data"].as_str().unwrap()).unwrap();
                        let f = &data[..4];
                        let s = |n: u64| self.sload(to, U256::from(n));
                        let words: Vec<U256> = if f == sel("balanceOf(address)") {
                            vec![self.sload(to, map_slot(Address::from_slice(&data[16..36]), 0))]
                        } else if f == sel("getReserves()") {
                            let r = s(8);
                            let m = (U256::from(1) << 112usize) - U256::from(1);
                            vec![r & m, (r >> 112usize) & m, r >> 224usize]
                        } else {
                            return Err(RpcErr { code: 3, message: "execution reverted".into() });
                        };
                        Ok(json!(format!("0x{}", words.iter().map(|x| format!("{x:064x}")).collect::<String>())))
                    }
                    "debug_traceCall" => {
                        // A tick walk (lens in the state override).
                        self.traces.fetch_add(1, Ordering::Relaxed);
                        if self.trace_delay_ms > 0 {
                            std::thread::sleep(Duration::from_millis(self.trace_delay_ms));
                        }
                        let data: Bytes = parse_bytes(p[0]["data"].as_str().unwrap()).unwrap();
                        // First argument of the lens call = the pool.
                        let pool = Address::from_slice(&data[48..68]);
                        let mut st = serde_json::Map::new();
                        for (k, v) in self.walk.get(&pool).map(|x| x.as_slice()).unwrap_or(&[]) {
                            st.insert(w(*k), json!(w(*v)));
                        }
                        let mut lens = serde_json::Map::new();
                        lens.insert(w(self.done_marker()), json!(w(U256::ZERO)));
                        let mut out = serde_json::Map::new();
                        out.insert(format!("{LENS:#x}"), json!({"balance": "0x0", "code": "0x00", "storage": lens}));
                        out.insert(format!("{pool:#x}"), json!({"balance": "0x0", "nonce": 1, "code": "0x00", "storage": st}));
                        Ok(Value::Object(out))
                    }
                    _ => Err(RpcErr { code: -32601, message: "method not found".into() }),
                }
            })
            .collect())
    }
}

fn data(ws: &[U256]) -> Bytes {
    let mut v = Vec::new();
    for x in ws {
        v.extend_from_slice(&x.to_be_bytes::<32>());
    }
    Bytes::from(v)
}
fn lg(addr: Address, topics: Vec<B256>, d: Bytes, block: u64, tx: u32, li: u32) -> PoolLog {
    PoolLog { address: addr, topics, data: d, block, tx_index: tx, log_index: li, tx_hash: B256::from(U256::from(block * 1000 + tx as u64)), removed: false }
}

/// One block: a few V2 pools trade (swap + sync + both coin transfers) so
/// pool AND coin storage changes in every kept version.
fn block_msg(world: &World, b: u64, trades: usize, reserves: &mut HashMap<Address, (u128, u128)>) -> BlockMsg {
    let mut logs = Vec::new();
    let user = a2(USER, 0);
    let ncoins = world.coins.len();
    for t in 0..trades.min(world.v2.len()) {
        let i = (b as usize * 7 + t * 13) % world.v2.len();
        let p = world.v2[i];
        let (t0, t1) = tokens(i, ncoins);
        let r = reserves.entry(p).or_insert((1_000_000, 4_000_000));
        // Alternate direction so reserves stay bounded.
        let (in0, out1) = if b % 2 == 0 { (100u128, 399u128) } else { (0, 0) };
        let (in1, out0) = if b % 2 == 1 { (399u128, 100u128) } else { (0, 0) };
        r.0 = r.0 + in0 - out0;
        r.1 = r.1 + in1 - out1;
        let tx = t as u32;
        let tr = topics().transfer;
        if in0 > 0 {
            logs.push(lg(world.coins[t0], vec![tr, topic_of(user), topic_of(p)], data(&[U256::from(in0)]), b, tx, 0));
            logs.push(lg(world.coins[t1], vec![tr, topic_of(p), topic_of(user)], data(&[U256::from(out1)]), b, tx, 1));
        } else {
            logs.push(lg(world.coins[t1], vec![tr, topic_of(user), topic_of(p)], data(&[U256::from(in1)]), b, tx, 0));
            logs.push(lg(world.coins[t0], vec![tr, topic_of(p), topic_of(user)], data(&[U256::from(out0)]), b, tx, 1));
        }
        logs.push(lg(p, vec![topics().v2_sync], data(&[U256::from(r.0), U256::from(r.1)]), b, tx, 2));
        logs.push(lg(p, vec![topics().v2_swap, topic_of(user), topic_of(user)], data(&[U256::from(in0), U256::from(in1), U256::from(out0), U256::from(out1)]), b, tx, 3));
    }
    BlockMsg { block: b, timestamp: 1000 + b, l1_block: Some(9_000), base_fee: Some(10), prev_block: Some(b - 1), logs, tick: false, bloom: None }
}

// ---------------------------------------------------------------------------
// The bench through the real intake
// ---------------------------------------------------------------------------
#[test]
fn walked_slots_memory_through_the_real_intake() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let n_v3 = env_usize("COPY2_MEM_POOLS", 200);
    let slots = env_usize("COPY2_MEM_SLOTS", 375);
    let blocks = env_usize("COPY2_MEM_BLOCKS", 600);
    // Blocks of reports kept for loads (production 2400 = ~10 min): the
    // flatness samples start once that buffer is full.
    let keep = env_usize("COPY2_MEM_KEEP", 400);
    let n_v2 = 40;
    let trades = env_usize("COPY2_MEM_TRADES", 5);
    let history = env_usize("COPY2_MEM_HISTORY", 64);
    let t_start = Instant::now();
    let base_live = live_mb();
    let base_rss = rss_mb();
    let world = Arc::new(World::new(n_v3, slots, n_v2, 60, env_usize("COPY2_MEM_TRACE_MS", 15) as u64));
    let world_live = live_mb() - base_live;
    let node: Arc<dyn NodeApi> = world.clone();
    let cfg = Config { history, ..Config::for_tests() };
    let sh = Shared::new(cfg, Some(node), Arc::new(Volatile::default()));
    let c2cfg = C2Config { loaders: 16, walks_inflight: env_usize("COPY2_MEM_WALKS", 4), keep_blocks: keep, max_keep_blocks: 40_000, ..C2Config::for_tests() };
    let (mut intake, h) = manual(sh.clone(), Arc::new(FillQueue::new(20_000, 100)), c2cfg);

    // Track: every pool + every coin's balance place.
    let mut pools: Vec<Value> = Vec::new();
    for (i, p) in world.v3.iter().enumerate() {
        let (t0, t1) = tokens(i, world.coins.len());
        pools.push(json!({"address": format!("{p}"), "kind": "v3", "token0": format!("{}", world.coins[t0]), "token1": format!("{}", world.coins[t1]), "fee": 3000, "tickSpacing": 60}));
    }
    for (i, p) in world.v2.iter().enumerate() {
        let (t0, t1) = tokens(i, world.coins.len());
        pools.push(json!({"address": format!("{p}"), "kind": "v2", "token0": format!("{}", world.coins[t0]), "token1": format!("{}", world.coins[t1])}));
    }
    let coin_slots: serde_json::Map<String, Value> = world.coins.iter().map(|c| (format!("{c:#x}"), json!({"layout": "solidity", "slot": 0}))).collect();
    let ans = h.track_json(&json!(1), &json!({"type": "track", "pools": pools, "coinSlots": coin_slots}));
    assert_eq!(ans["ok"], json!(true), "{ans}");

    // Blocks arrive every ~4 ms while loads and walks run in the background
    // (walk answers take COPY2_MEM_TRACE_MS, so several versions pass
    // between a walk's block and its answer, like on the server).
    let mut reserves = HashMap::new();
    let mut b = 100u64;
    let want_walked = n_v3;
    let t0 = Instant::now();
    let mut loaded_at: Option<(f64, f64)> = None;
    loop {
        b += 1;
        *world.tip.lock().unwrap() = b;
        h.block(block_msg(&world, b, trades, &mut reserves));
        let until = Instant::now() + Duration::from_millis(4);
        while Instant::now() < until {
            intake.pump();
            std::thread::sleep(Duration::from_micros(300));
        }
        let st = h.status_json(false);
        if loaded_at.is_none() && st["ready"].as_u64() == Some((n_v3 + n_v2) as u64) {
            loaded_at = Some((live_mb(), rss_mb()));
            eprintln!("  peak heap while loading: {:.1} MB", PEAK.load(Ordering::Relaxed) as f64 / 1_048_576.0);
            PEAK.store(LIVE.load(Ordering::Relaxed), Ordering::Relaxed);
        }
        let walked = {
            let reg = h.c2.reg.read().unwrap();
            reg.pools.values().filter(|e| e.walk.as_ref().is_some_and(|w| w.done)).count()
        };
        if walked >= want_walked {
            break;
        }
        assert!(t0.elapsed() < Duration::from_secs(600), "walks never finished: {walked}/{want_walked} {}", st["poolCoverage"]);
    }
    let walk_secs = t0.elapsed().as_secs_f64();
    let st = h.status_json(false);
    let walk_slots = st["poolCoverage"]["walkSlots"].as_u64().unwrap_or(0) as f64;
    let (loaded_live, loaded_rss) = loaded_at.unwrap_or((0.0, 0.0));
    let walked_live = live_mb();
    let walked_rss = rss_mb();
    let walk_peak = PEAK.load(Ordering::Relaxed) as f64 / 1_048_576.0;
    eprintln!("  peak heap while walking: {walk_peak:.1} MB");
    PEAK.store(LIVE.load(Ordering::Relaxed), Ordering::Relaxed);
    // Fill the report buffer (bounded by `keep`), then many more blocks: the
    // kept versions roll over; memory must stay flat.
    for _ in 0..keep {
        b += 1;
        *world.tip.lock().unwrap() = b;
        h.block(block_msg(&world, b, trades, &mut reserves));
        intake.pump();
    }
    let buffered_live = live_mb();
    let mut samples = Vec::new();
    for i in 0..blocks {
        b += 1;
        *world.tip.lock().unwrap() = b;
        h.block(block_msg(&world, b, trades, &mut reserves));
        intake.pump();
        if i % (blocks / 5).max(1) == 0 || i + 1 == blocks {
            samples.push((i, live_mb(), rss_mb()));
        }
    }
    let st = h.status_json(false);
    let end_live = live_mb();
    let end_rss = rss_mb();
    let head = sh.head().unwrap();
    let (accts, held, codes) = head.snap.counts();
    let copy_mb = end_live - base_live - world_live;
    eprintln!("=== copy2 memory bench: {n_v3} V3 pools x {slots} walked slots, {n_v2} V2 pools, history {history} ===");
    eprintln!("  pretend node's own data: {world_live:.1} MB (not part of the sidecar)");
    eprintln!("  start: heap {base_live:.1} MB, rss {base_rss:.1} MB");
    eprintln!("  all pools loaded: heap {loaded_live:.1} MB, rss {loaded_rss:.1} MB");
    eprintln!("  all walked ({walk_slots} walk slots, {walk_secs:.1} s): heap {walked_live:.1} MB, rss {walked_rss:.1} MB");
    eprintln!("  after {keep} more blocks (report buffer full): heap {buffered_live:.1} MB");
    for (i, l, r) in &samples {
        eprintln!("    +{i:>5} blocks: heap {l:.1} MB, rss {r:.1} MB");
    }
    eprintln!("  end: heap {end_live:.1} MB (copy 2 = {copy_mb:.1} MB), rss {end_rss:.1} MB, peak heap {:.1} MB", PEAK.load(Ordering::Relaxed) as f64 / 1_048_576.0);
    eprintln!("  head holds {accts} accounts, {held} slots, {codes} codes; versions kept {}", sh.published.read().unwrap().versions.len());
    eprintln!("  walks sent to the node: {} (counters: walks {} done {} partial {} refused {} errors {})", world.traces.load(Ordering::Relaxed), st["counters"]["walks"], st["counters"]["walks_done"], st["counters"]["walks_partial"], st["counters"]["walks_refused"], st["counters"]["walk_errors"]);
    eprintln!("  copy 2 heap per walked slot: {:.0} bytes", copy_mb * 1_048_576.0 / walk_slots.max(1.0));
    eprintln!("  status: walkSlots {} rssMb {} counters walk_slots {}", st["poolCoverage"]["walkSlots"], st["rssMb"], st["counters"]["walk_slots"]);
    assert_eq!(st["ready"].as_u64(), Some((n_v3 + n_v2) as u64), "every pool stays ready: {}", st["unsureReasons"]);
    // Flat: the last sample is within 5 % (+2 MB) of the first one after walks.
    let first = samples.first().unwrap().1;
    let last = samples.last().unwrap().1;
    assert!(last <= first * 1.05 + 2.0, "heap grew over {blocks} blocks: {first:.1} -> {last:.1} MB");
    // Budget: <= 400 bytes of heap per walked slot (all of copy 2 included).
    let per_slot = copy_mb * 1_048_576.0 / walk_slots.max(1.0);
    let limit = env_usize("COPY2_MEM_MAX_BYTES_PER_SLOT", 400) as f64;
    assert!(per_slot <= limit, "copy 2 uses {per_slot:.0} bytes per walked slot (limit {limit})");
    // No big passing bulge while walks are taken in (dry run #18: every
    // kept version got its own copy of each walked pool).
    assert!(walk_peak <= end_live * 1.5 + 16.0, "heap peaked at {walk_peak:.1} MB while walking (steady {end_live:.1} MB)");
    h.stop();
    eprintln!("  (took {:.1} s)", t_start.elapsed().as_secs_f64());
}

// ---------------------------------------------------------------------------
// Version churn: what each kept version costs when pools change every block.
// ---------------------------------------------------------------------------
#[test]
fn version_churn_keeps_memory_bounded() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let n = env_usize("COPY2_MEM_POOLS", 200);
    let slots = env_usize("COPY2_MEM_SLOTS", 375);
    let history = env_usize("COPY2_MEM_HISTORY", 64);
    let base = live_mb();
    // One snapshot holding n pools x slots values.
    let mut s = Snapshot::new(Arc::new(Volatile::default()));
    {
        let mut ov = Overlay::new(s.clone());
        for i in 0..n as u32 {
            let p = a2(0x33, i);
            for j in 0..slots as u64 {
                ov.learn(&arbsim::state::snap::Fact::Slot(p, rnd(&[p.as_slice(), &j.to_be_bytes()].concat()), U256::from(j)));
            }
        }
        s = ov.into_parts().0;
    }
    let one = live_mb() - base;
    let mut versions: std::collections::VecDeque<Arc<Snapshot>> = std::collections::VecDeque::new();
    versions.push_back(Arc::new(s));
    // Each block: 10 pools x 8 slots change (a V3 swap: slot0, liquidity,
    // fee growth, a crossed tick, a price-history entry).
    let mut samples = Vec::new();
    for b in 0..(history * 6) as u64 {
        let mut ov = Overlay::from_arc(versions.back().unwrap());
        ov.set_position(StatePosition { base_block: b, after_seq: None });
        for k in 0..10u64 {
            let p = a2(0x33, ((b * 31 + k * 17) % n as u64) as u32);
            for j in 0..8u64 {
                ov.set_slot(p, rnd(&[p.as_slice(), &((b * 8 + j) % slots as u64).to_be_bytes()].concat()), U256::from(b));
            }
        }
        let (snap, _diff): (Snapshot, StateDiff) = ov.into_parts();
        versions.push_back(Arc::new(snap));
        while versions.len() > history {
            versions.pop_front();
        }
        if b % history as u64 == 0 {
            samples.push(live_mb() - base);
        }
    }
    let all = live_mb() - base;
    let per_version_kb = (all - one) * 1024.0 / (history as f64 - 1.0);
    eprintln!("=== version churn: {n} pools x {slots} slots, 80 slot changes per block, {history} versions ===");
    eprintln!("  one version: {one:.1} MB ({:.0} bytes per slot); {history} versions: {all:.1} MB; each extra version {per_version_kb:.0} KB", one * 1_048_576.0 / (n * slots) as f64);
    eprintln!("  samples: {samples:.1?}");
    assert!(all <= one * 1.0 + history as f64 * 1.0, "versions cost too much: {all:.1} MB for {history} (one = {one:.1} MB)");
}

// ---------------------------------------------------------------------------
// Walk guards: the slot cap and the memory guard stop NEW walks, and say so.
// ---------------------------------------------------------------------------
fn small_rig(n: usize, c2cfg: C2Config) -> (Arc<World>, arbsim::copy2::intake::Intake, arbsim::copy2::intake::Copy2Handle) {
    let world = Arc::new(World::new(n, 100, 0, 6, 0));
    // The node is ahead of us (its cached tip never limits the walk's block).
    *world.tip.lock().unwrap() = 1_000_000;
    let node: Arc<dyn NodeApi> = world.clone();
    let sh = Shared::new(Config { history: 64, ..Config::for_tests() }, Some(node), Arc::new(Volatile::default()));
    let (intake, h) = manual(sh, Arc::new(FillQueue::new(1000, 100)), c2cfg);
    let mut pools: Vec<Value> = Vec::new();
    for (i, p) in world.v3.iter().enumerate() {
        let (t0, t1) = tokens(i, world.coins.len());
        pools.push(json!({"address": format!("{p}"), "kind": "v3", "token0": format!("{}", world.coins[t0]), "token1": format!("{}", world.coins[t1]), "fee": 3000, "tickSpacing": 60}));
    }
    let coin_slots: serde_json::Map<String, Value> = world.coins.iter().map(|c| (format!("{c:#x}"), json!({"layout": "solidity", "slot": 0}))).collect();
    assert_eq!(h.track_json(&json!(1), &json!({"type": "track", "pools": pools, "coinSlots": coin_slots}))["ok"], json!(true));
    (world, intake, h)
}

fn run_blocks(world: &World, intake: &mut arbsim::copy2::intake::Intake, h: &arbsim::copy2::intake::Copy2Handle, from: u64, n: u64) {
    let _ = world;
    for b in from..from + n {
        h.block(BlockMsg { block: b, timestamp: 1000 + b, l1_block: Some(9_000), base_fee: Some(10), prev_block: Some(b - 1), logs: vec![], tick: true, bloom: None });
        let until = Instant::now() + Duration::from_millis(5);
        while Instant::now() < until {
            intake.pump();
            std::thread::sleep(Duration::from_micros(300));
        }
    }
}

#[test]
fn walk_slot_cap_and_memory_guard_pause_new_walks() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    // Slot cap 250: 100 values per pool -> walks stop after 3 pools.
    let (world, mut intake, h) = small_rig(10, C2Config { walks_inflight: 1, walk_max_slots: 250, ..C2Config::for_tests() });
    run_blocks(&world, &mut intake, &h, 100, 300);
    let st = h.status_json(false);
    let cov = &st["poolCoverage"];
    assert_eq!(st["ready"], json!(10), "{st}");
    assert_eq!(cov["fullTickData"], json!(3), "{cov} {} traces {}", st["counters"], world.traces.load(Ordering::Relaxed));
    assert!(cov["walkPaused"].as_str().unwrap_or("").contains("ARBSIM_COPY2_WALK_MAX_SLOTS"), "{cov}");
    h.stop();
    // Memory guard 1 MB: no walk at all.
    let (world, mut intake, h) = small_rig(4, C2Config { walk_max_rss_mb: 1, ..C2Config::for_tests() });
    run_blocks(&world, &mut intake, &h, 100, 100);
    let st = h.status_json(false);
    let cov = &st["poolCoverage"];
    assert_eq!(st["ready"], json!(4), "{st}");
    assert_eq!(cov["fullTickData"], json!(0), "{cov}");
    assert!(cov["walkPaused"].as_str().unwrap_or("").contains("ARBSIM_COPY2_WALK_MAX_RSS_MB"), "{cov}");
    assert_eq!(world.traces.load(Ordering::Relaxed), 0);
    h.stop();
}
