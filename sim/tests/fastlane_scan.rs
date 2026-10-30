// ============================================================================
// FAST LANE SCAN tests (workstream B): sim/src/fastlane/scan.rs.
//
// Plain English: the scanner must
//   - give the same answer as the existing check (check/search.rs size
//     search) on the real recorded fixtures,
//   - find a profitable route, value it with the bot's facts, and keep the
//     minimum profit after gas,
//   - skip routes on pools the view can't vouch for,
//   - not hand out the same route twice for unchanged pools,
//   - stay inside its time budget,
//   - revisit EVERY route within a known number of blocks (rolling sweep),
//   - re-check a found trade on later state (practice "was it real?").
// The "trade" in most tests is a tiny contract with a known profit hill,
// called with real execute(...) calldata (so the trade decoding is real).
// ============================================================================
mod check_util;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use arbsim::arb::BlockCtx;
use arbsim::check::entry::{Row, Table};
use arbsim::check::fixture::Fixture;
use arbsim::check::hexutil::{quantity, to_hex};
use arbsim::check::{size_search, CheckUnknown, Overrides, SizeSearchAmounts, SizeSearchResult};
use arbsim::fastlane::scan::*;
use arbsim::fastlane::types::*;
use arbsim::state::mem::MemState;
use arbsim::state::StateRead;
use check_util::*;
use revm::primitives::{keccak256, Address, U256};
use serde_json::{json, Value};

/// Our contract's test address (simulator.ts SIM_EXECUTOR_ADDRESS).
fn exec() -> Address {
    "0x00000000000000000000000000000000a7b51e00".parse().unwrap()
}
const LENDER: u64 = 0x1e0;

/// The profit hill contract, reading amountIn where execute() keeps it
/// (calldata byte 4 + 96): same code as check_util's, one byte changed.
fn hill_code(k: u64, scale: u64) -> Vec<u8> {
    let mut c = code_profit_curve(U256::from(k), U256::from(scale), None);
    assert_eq!(&c[..3], &[0x60, 0x04, 0x35]);
    c[1] = 0x64;
    c
}

/// execute calldata for a 2-hop round trip start(1) -> mid -> start, V3 flash.
fn trade_data(amount: u64, pa: u64, pb: u64) -> Vec<u8> {
    let hop = |p, i, o| Hop { kind: KIND_V3, pool: addr(p), token_in: addr(i), token_out: addr(o), fee_bps: 0, v4_fee: 0, v4_tick_spacing: 0, v4_native: false };
    encode_trade(&DecodedTrade {
        token: addr(1),
        amount_in: U256::from(amount),
        min_profit: U256::MAX,
        max_block: U256::MAX,
        hops: vec![hop(pa, 1, 2), hop(pb, 2, 1)],
        flash: FlashLender::V3Flash(addr(LENDER)),
    })
}

fn key(n: u64) -> String {
    format!("{:#x}", addr(n))
}

/// A table row for route pa > pb at sizes $50/$150/$400 (token: 6 decimals, $1).
fn row(rid: &str, pa: u64, pb: u64, held: bool, score: Option<f64>, gas_usd: f64) -> Row {
    let data = trade_data(400_000_000, pa, pb);
    let c = json!({
        "calls": [{ "from": "0x00000000000000000000000000000000000b0751", "to": format!("{:#x}", exec()), "gas": "0x7a1200", "data": to_hex(&data) }],
        "overrides": {},
        "sizes": { "amountOffset": 96, "amounts": ["0x2faf080", "0x8f0d180"] },
        "route": [key(pa), key(pb), key(LENDER)],
        "stop": "0x1", "amt": "0x17d78400",
    });
    Row { rid: rid.into(), held, score, e: Some("x".into()), c: Some(Arc::new(c)), f: Some(Arc::new(json!({ "l": rid, "px": 1.0, "d": 6, "g": gas_usd, "lp": 500 }))) }
}

/// State with the hill contract at our test address. Peak 1e9 units ($1000).
fn hill_state(k: u64) -> MemState {
    state_with(&[(exec(), hill_code(k, 200_000_000_000), vec![])], false)
}

fn table(rows: Vec<(u64, Row)>) -> Arc<Mutex<Table>> {
    let mut t = Table { gen: 1, ..Default::default() };
    for (p, r) in rows {
        t.pools.entry(key(p)).or_default().push(r);
    }
    Arc::new(Mutex::new(t))
}

fn scanner(t: Arc<Mutex<Table>>, cfg: ScanConfig) -> Scanner {
    Scanner::new(cfg, Box::new(TableSource::owned(t)), Box::new(PlainRunner))
}

fn input<'a>(view: &'a dyn StateRead, ctx: &'a BlockCtx, block: u64, changed: &'a [String], unsure: &'a HashSet<String>) -> BlockInput<'a> {
    BlockInput { view, ctx, block, kind: ViewKind::Confirmed, changed, unsure, snap: None }
}

/// Test settings: big budget, and the $0.10 minimum these tests' numbers
/// were written for (the default now follows the bot's $0.25, review L5).
fn cfg() -> ScanConfig {
    ScanConfig { budget_us: 1_000_000, min_net_usd: 0.10, ..ScanConfig::default() }
}

#[test]
fn finds_a_paying_route_with_the_bots_facts() {
    let s = hill_state(2_000_000_000);
    let t = table(vec![(0xa, row("a>b:1", 0xa, 0xb, true, Some(1.0), 0.05))]);
    let mut sc = scanner(t, cfg());
    let none = HashSet::new();
    let ch = vec![key(0xa)];
    let rep = sc.scan(&input(&s, &ctx(), 77, &ch, &none));
    assert_eq!(rep.opps.len(), 1, "{:?}", rep.checked);
    let o = &rep.opps[0];
    // Best of the ladder: $400 = 4e8 units; profit 4e8*(2e9-4e8)/2e11 = 3.2e6 = $3.20.
    assert_eq!(o.amount_in, U256::from(400_000_000u64));
    assert_eq!(o.profit_units, U256::from(3_200_000u64));
    assert!((o.expected_net_usd - 3.15).abs() < 1e-9, "net {}", o.expected_net_usd);
    assert!((o.size_usd - 400.0).abs() < 1e-9);
    assert_eq!(o.loan_fee_usd, Some(400.0 * 500.0 / 1e6));
    assert_eq!(o.block, 77);
    assert_eq!(o.flash, FlashLender::V3Flash(addr(LENDER)));
    assert_eq!(o.hops.len(), 2);
    assert_eq!(o.pools, vec![key(0xa), key(0xb)], "lender not counted as a pool");
    assert_eq!(o.tokens, vec![addr(1), addr(2)]);
    assert_eq!(o.source, "changed");
    assert!(o.gas_used > 21_000);
    // Same answer as the existing size search at the same sizes.
    let direct = size_search(&s, &ctx(), &Overrides::none(), &[], &o.check.template(), &SizeSearchAmounts::List(o.check.sizes.clone())).unwrap();
    assert_eq!(direct.best.unwrap().profit, o.profit_units);
    assert_eq!(o.check.sizes, vec![U256::from(50_000_000u64), U256::from(150_000_000u64), U256::from(400_000_000u64)]);
    assert!(rep.timing.total_us >= rep.timing.changed_us);
    let j = opp_json(o);
    assert_eq!(j["amountIn"], json!(quantity(U256::from(400_000_000u64))));
}

#[test]
fn refine_finds_a_better_size_inside_the_ladder() {
    // Peak at 2e8 ($200): between the $150 and $400 ladder sizes.
    let s = hill_state(400_000_000);
    let t = table(vec![(0xa, row("a>b:1", 0xa, 0xb, true, None, 0.0))]);
    let none = HashSet::new();
    let ch = vec![key(0xa)];
    let ladder = scanner(t.clone(), cfg()).scan(&input(&s, &ctx(), 1, &ch, &none)).opps[0].profit_units;
    let refined = scanner(t, ScanConfig { refine_steps: 12, ..cfg() }).scan(&input(&s, &ctx(), 1, &ch, &none)).opps[0].profit_units;
    assert!(refined > ladder, "refined {refined} vs ladder {ladder}");
}

#[test]
fn minimum_profit_after_gas_is_kept() {
    let s = hill_state(2_000_000_000);
    let none = HashSet::new();
    let ch = vec![key(0xa)];
    // Gas $3.20 + minimum $0.10 > $3.20 profit: below the minimum.
    let t = table(vec![(0xa, row("a>b:1", 0xa, 0xb, true, None, 3.15))]);
    let rep = scanner(t, cfg()).scan(&input(&s, &ctx(), 1, &ch, &none));
    assert!(rep.opps.is_empty());
    assert!(matches!(rep.checked[0].outcome, Outcome::BelowMin { .. }), "{:?}", rep.checked[0].outcome);
    // Exactly at the minimum: kept.
    let t = table(vec![(0xa, row("a>b:1", 0xa, 0xb, true, None, 3.10))]);
    assert_eq!(scanner(t, cfg()).scan(&input(&s, &ctx(), 1, &ch, &none)).opps.len(), 1);
    // A higher FASTLANE_MIN_NET_USD.
    let t = table(vec![(0xa, row("a>b:1", 0xa, 0xb, true, None, 0.05))]);
    assert!(scanner(t, ScanConfig { min_net_usd: 5.0, ..cfg() }).scan(&input(&s, &ctx(), 1, &ch, &none)).opps.is_empty());
    // No profit at all (past the hill).
    let flat = hill_state(10_000_000);
    let t = table(vec![(0xa, row("a>b:1", 0xa, 0xb, true, None, 0.0))]);
    let rep = scanner(t, cfg()).scan(&input(&flat, &ctx(), 1, &ch, &none));
    assert_eq!(rep.checked[0].outcome, Outcome::NoProfit);
}

#[test]
fn unsure_pools_and_missing_facts_are_skipped() {
    let s = hill_state(2_000_000_000);
    let ch = vec![key(0xa)];
    let t = table(vec![(0xa, row("a>b:1", 0xa, 0xb, true, None, 0.05))]);
    let unsure: HashSet<String> = [key(0xb)].into_iter().collect();
    let rep = scanner(t.clone(), cfg()).scan(&input(&s, &ctx(), 1, &ch, &unsure));
    assert!(rep.opps.is_empty());
    assert_eq!(rep.checked[0].outcome, Outcome::SkippedUnsure);
    // The lender unsure: skipped too.
    let unsure: HashSet<String> = [key(LENDER)].into_iter().collect();
    assert_eq!(scanner(t, cfg()).scan(&input(&s, &ctx(), 1, &ch, &unsure)).checked[0].outcome, Outcome::SkippedUnsure);
    // No "f" facts (FASTLANE off on the bot side): never valued, never sent.
    let mut r = row("a>b:1", 0xa, 0xb, true, None, 0.05);
    r.f = None;
    let rep = scanner(table(vec![(0xa, r)]), cfg()).scan(&input(&s, &ctx(), 1, &ch, &HashSet::new()));
    assert_eq!(rep.checked[0].outcome, Outcome::NoFacts);
    assert!(rep.opps.is_empty());
}

#[test]
fn missing_state_is_unknown_never_a_guess() {
    // Strict view without our contract: the check can't be sure.
    let s = state_with(&[], true);
    let ch = vec![key(0xa)];
    let t = table(vec![(0xa, row("a>b:1", 0xa, 0xb, true, None, 0.05))]);
    let rep = scanner(t, cfg()).scan(&input(&s, &ctx(), 1, &ch, &HashSet::new()));
    assert_eq!(rep.checked[0].outcome, Outcome::Unknown("miss".into()));
    assert!(rep.opps.is_empty());
    // (Oct 30) Counted by reason, with where it missed (status JSON; the
    // counters are process-wide and tests run in parallel: at least).
    let j = status_json();
    assert!(j["unknownWhy"]["miss"].as_u64().unwrap_or(0) >= 1, "{j}");
    assert!(j["unknownMissTop"].as_object().is_some_and(|o| !o.is_empty()), "{j}");
}

/// (Oct 30) Unknown answers are counted by a short reason word.
#[test]
fn unknown_answers_are_counted_by_reason() {
    use arbsim::check::UnknownReason;
    let u = |r: UnknownReason, d: &str| CheckUnknown::new(r, d);
    assert_eq!(unknown_key(&u(UnknownReason::Miss, "x")), "miss");
    assert_eq!(unknown_key(&u(UnknownReason::Engine, "x")), "engine_error");
    assert_eq!(unknown_key(&u(UnknownReason::Copy2Unsure, "unsure_pool: V3 pool 0x.. is walking")), "unsure_pool");
    assert_eq!(unknown_key(&u(UnknownReason::Copy2Unsure, "pending_reports: settling")), "pending_reports");
    assert_eq!(unknown_key(&u(UnknownReason::Copy2Unsure, "pool_manager_balance: differ")), "pool_manager_balance");
    assert_eq!(unknown_key(&u(UnknownReason::Copy2Unsure, "protocol_fee: differ")), "protocol_fee");
    assert_eq!(unknown_key(&u(UnknownReason::Copy2Unsure, "something_new: x")), "other");
}

#[test]
fn same_route_not_returned_twice_for_unchanged_pools() {
    let s = hill_state(2_000_000_000);
    let t = table(vec![(0xa, row("a>b:1", 0xa, 0xb, true, None, 0.05))]);
    let mut sc = scanner(t, cfg());
    let none = HashSet::new();
    let a = vec![key(0xa)];
    let other = vec![key(0xc)];
    assert_eq!(sc.scan(&input(&s, &ctx(), 1, &a, &none)).opps.len(), 1);
    // Next block: seen by the sweep, nothing on it changed: a repeat.
    let rep = sc.scan(&input(&s, &ctx(), 2, &other, &none));
    assert!(rep.opps.is_empty());
    assert!(matches!(rep.checked[0].outcome, Outcome::Found { dup: true, .. }));
    // Its pool changed again (same result, new state): handed out again.
    assert_eq!(sc.scan(&input(&s, &ctx(), 3, &a, &none)).opps.len(), 1);
    // A different result (state changed under it) without a reported change: new.
    let s2 = hill_state(3_000_000_000);
    assert_eq!(sc.scan(&input(&s2, &ctx(), 4, &other, &none)).opps.len(), 1);
}

#[test]
fn changed_pool_routes_ranked_like_the_bot() {
    // Same picking order as check/entry.rs select: held first, then score.
    let s = hill_state(2_000_000_000);
    let t = table(vec![
        (0xa, row("a>b:1", 0xa, 0xb, true, Some(1.0), 0.05)),
        (0xa, row("b>a:1", 0xb, 0xa, true, Some(3.0), 0.05)),
        (0xa, row("a>c:1", 0xa, 0xc, false, Some(9.0), 0.05)),
        (0xd, row("d>e:1", 0xd, 0xe, true, None, 0.05)),
    ]);
    let mut sc = scanner(t, ScanConfig { sweep_per_block: 0, ..cfg() });
    let ch = vec![key(0xa), key(0xd)];
    let rep = sc.scan(&input(&s, &ctx(), 1, &ch, &HashSet::new()));
    let order: Vec<&str> = rep.checked.iter().map(|c| c.rid.as_str()).collect();
    assert_eq!(order, vec!["b>a:1", "a>b:1", "d>e:1", "a>c:1"]);
    assert_eq!(rep.opps.len(), 4);
}

/// Counts runs and takes a fixed time per route (budget tests).
struct SlowRunner {
    us: u64,
    runs: Arc<AtomicUsize>,
    seen: Arc<Mutex<Vec<U256>>>,
}
impl CheckRunner for SlowRunner {
    fn run(&self, _v: &dyn StateRead, _c: &BlockCtx, p: &PreparedCheck, _a: &SizeSearchAmounts) -> Result<SizeSearchResult, CheckUnknown> {
        let t = std::time::Instant::now();
        while (t.elapsed().as_micros() as u64) < self.us {
            std::hint::spin_loop();
        }
        self.runs.fetch_add(1, Ordering::Relaxed);
        // Remember which route ran (by its first pool address word).
        self.seen.lock().unwrap().push(U256::from_be_slice(&p.call.data[4 + 32 * 9 + 12..4 + 32 * 10]));
        Ok(SizeSearchResult { best: None, tried: vec![] })
    }
}

fn many(n: u64) -> Arc<Mutex<Table>> {
    table((0..n).map(|i| (0x100 + i, row(&format!("r{i:03}"), 0x100 + i, 0x900, true, None, 0.05))).collect())
}

#[test]
fn time_budget_is_respected() {
    let runs = Arc::new(AtomicUsize::new(0));
    let r = SlowRunner { us: 2_000, runs: runs.clone(), seen: Default::default() };
    let budget = 10_000;
    let mut sc = Scanner::new(ScanConfig { budget_us: budget, sweep_per_block: 50, ..ScanConfig::default() }, Box::new(TableSource::owned(many(40))), Box::new(r));
    let s = hill_state(1);
    let ch: Vec<String> = (0..40).map(|i| key(0x100 + i)).collect();
    let rep = sc.scan(&input(&s, &ctx(), 1, &ch, &HashSet::new()));
    let n = runs.load(Ordering::Relaxed);
    // ~75% of 10 ms for changed routes at 2 ms each, then the sweep's share.
    assert!((3..=6).contains(&n), "ran {n}");
    assert!(rep.cut_changed > 30, "cut {}", rep.cut_changed);
    // At most one route's time over the budget.
    assert!(rep.timing.total_us < budget + 2_000 + 1_500, "took {} us", rep.timing.total_us);
    assert!(rep.checked.iter().any(|c| c.source == "sweep"), "the sweep keeps its share of a busy block");
}

#[test]
fn rolling_sweep_visits_every_route_and_counts_blocks() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let r = SlowRunner { us: 0, runs: Default::default(), seen: seen.clone() };
    let mut sc = Scanner::new(ScanConfig { sweep_per_block: 8, ..cfg() }, Box::new(TableSource::owned(many(25))), Box::new(r));
    let s = hill_state(1);
    let none = HashSet::new();
    let mut fulls = Vec::new();
    for b in 0..12u64 {
        let rep = sc.scan(&input(&s, &ctx(), b, &[], &none));
        assert!(rep.checked.len() <= 8);
        assert_eq!(rep.sweep_total, 25);
        if let Some(n) = rep.full_sweep_blocks {
            fulls.push((b, n));
        }
    }
    // 25 routes, 8 per block: a full pass every 4 blocks (8+8+8+1, then the
    // next pass carries on in the same block).
    assert!(!fulls.is_empty() && fulls.iter().all(|(_, n)| *n <= 4), "{fulls:?}");
    // Every route seen within any 4 consecutive blocks' worth of checks (32).
    let seen = seen.lock().unwrap();
    for w in seen.windows(32) {
        let set: HashSet<_> = w.iter().collect();
        assert_eq!(set.len(), 25);
    }
    // Changed-pool routes in a block are not run twice by the sweep.
    let r2 = SlowRunner { us: 0, runs: Default::default(), seen: Default::default() };
    let runs = r2.runs.clone();
    let mut sc = Scanner::new(ScanConfig { sweep_per_block: 100, ..cfg() }, Box::new(TableSource::owned(many(5))), Box::new(r2));
    let ch: Vec<String> = (0..5).map(|i| key(0x100 + i)).collect();
    let rep = sc.scan(&input(&s, &ctx(), 1, &ch, &none));
    assert_eq!(runs.load(Ordering::Relaxed), 5);
    assert_eq!(rep.full_sweep_blocks, Some(1));
}

#[test]
fn table_changes_rebuild_only_what_changed() {
    let t = many(3);
    let mut src = TableSource::owned(t.clone());
    assert!(src.sync().is_empty());
    let g1 = src.generation();
    let first: Vec<_> = src.all().to_vec();
    // Same generation: nothing to do.
    src.sync();
    assert_eq!(src.generation(), g1);
    // New generation, one row changed (gas): only that route rebuilt.
    {
        let mut g = t.lock().unwrap();
        g.gen = 2;
        let rows = g.pools.get_mut(&key(0x101)).unwrap();
        rows[0] = row("r001", 0x101, 0x900, true, None, 0.07);
    }
    src.sync();
    assert_ne!(src.generation(), g1);
    let now = src.all();
    assert!(Arc::ptr_eq(&first[0], &now[0]) && Arc::ptr_eq(&first[2], &now[2]));
    assert!(!Arc::ptr_eq(&first[1], &now[1]));
    // A row whose check we can't read is reported, not used.
    {
        let mut g = t.lock().unwrap();
        g.gen = 3;
        let mut bad = row("bad", 0x102, 0x900, true, None, 0.05);
        bad.c = Some(Arc::new(json!({ "calls": [{ "to": format!("{:#x}", exec()), "data": "0x12345678" }] })));
        g.pools.get_mut(&key(0x102)).unwrap().push(bad);
    }
    let bad = src.sync();
    assert_eq!(bad.len(), 1);
    assert_eq!(bad[0].0, "bad");
    assert_eq!(src.all().len(), 3);
}

#[test]
fn evaluation_rechecks_on_later_state() {
    let s = hill_state(2_000_000_000);
    let t = table(vec![(0xa, row("a>b:1", 0xa, 0xb, true, None, 0.05))]);
    let mut sc = scanner(t, cfg());
    let ch = vec![key(0xa)];
    let o = sc.scan(&input(&s, &ctx(), 5, &ch, &HashSet::new())).opps.remove(0);
    // Same state: real.
    let e = evaluate(&o, sc.runner(), &s, &ctx(), 0.10);
    assert_eq!(e.real, Some(true));
    assert!((e.net_usd.unwrap() - 3.15).abs() < 1e-9);
    // Later state where the gap closed: gone.
    let closed = hill_state(400_000_000);
    let e = evaluate(&o, sc.runner(), &closed, &ctx(), 0.10);
    assert_eq!(e.real, Some(false));
    assert_eq!(e.at_size.as_ref().unwrap().status, "loss");
    // State we can't read: unsure.
    let e = evaluate(&o, sc.runner(), &state_with(&[], true), &ctx(), 0.10);
    assert_eq!(e.real, None);
}

/// The real recorded checks (anvil, real UniswapV3/V2 code, live
/// ArbExecutor code): the scanner's answer equals the existing size search
/// and, at the recorded size, the recorded node answer.
#[test]
fn matches_the_existing_check_on_real_fixtures() {
    for name in ["offline-v3-v3-small", "offline-v3-v2-v3"] {
        let fx = Fixture::load(&fixture_path(name)).unwrap();
        let trade = decode_trade(&fx.call.data).unwrap();
        // The test contract's balance slot of the start coin (whatever
        // mapping position the coin uses): the slot holding its funding.
        let token = trade.token;
        let tstore = &fx.state.storage[&token];
        let bal_slot = (0u64..20)
            .map(|p| {
                let mut b = [0u8; 64];
                b[12..32].copy_from_slice(exec().as_slice());
                b[32..].copy_from_slice(&U256::from(p).to_be_bytes::<32>());
                U256::from_be_bytes(keccak256(b).0)
            })
            .find(|s| tstore.contains_key(s))
            .expect("balance slot of our contract");
        let amt = trade.amount_in;
        let c = json!({
            "calls": [{ "from": format!("{:#x}", fx.call.from), "to": format!("{:#x}", fx.call.to.unwrap()), "gas": quantity(U256::from(fx.call.gas.unwrap())), "data": to_hex(&fx.call.data) }],
            "overrides": { format!("{token:#x}"): { "stateDiff": { quantity(bal_slot): quantity(amt) } } },
            "sizes": { "amountOffset": 96, "amounts": [quantity(amt / U256::from(4u8)), quantity(amt / U256::from(2u8))] },
            "route": trade.hops.iter().map(|h| format!("{:#x}", h.pool)).collect::<Vec<_>>(),
            "stop": "0x1", "amt": quantity(amt),
        });
        let r = Row { rid: "fx".into(), held: true, score: None, e: Some("x".into()), c: Some(Arc::new(c)), f: Some(Arc::new(json!({ "l": name, "px": 1.0, "d": 18, "g": 0.0 }))) };
        let pool = format!("{:#x}", trade.hops[0].pool);
        let mut t = Table { gen: 1, ..Default::default() };
        t.pools.insert(pool.clone(), vec![r]);
        let mut src = TableSource::owned(Arc::new(Mutex::new(t)));
        assert!(src.sync().is_empty());
        let route = src.all()[0].clone();
        // Our runner = the existing size search, same inputs.
        let ours = PlainRunner.run(&fx.state, &fx.ctx, &route.check, &amounts_for(&route.check, 0)).unwrap();
        let direct = size_search(&fx.state, &fx.ctx, &route.check.overrides, &[], &route.check.template(), &SizeSearchAmounts::List(route.check.sizes.clone())).unwrap();
        assert_eq!(ours, direct, "{name}");
        // At the recorded size: the node's answer (InsufficientProfit(0) = loss, same gas).
        let main = ours.tried.iter().find(|t| t.amount == amt).unwrap();
        assert_eq!(main.status, "loss", "{name}");
        assert_eq!(main.gas_used, fx.expected.gas_used, "{name}: gas equals the node's");
        // The scanner itself reports exactly the size search's best (or no
        // profit); valued at $1 per 1e18 units it is far below $0.10.
        let mut sc = Scanner::new(cfg(), Box::new(src), Box::new(PlainRunner));
        let ch = vec![pool];
        let rep = sc.scan(&BlockInput { view: &fx.state, ctx: &fx.ctx, block: 1, kind: ViewKind::Confirmed, changed: &ch, unsure: &HashSet::new(), snap: None });
        match (&rep.checked[0].outcome, &direct.best) {
            (Outcome::BelowMin { amount, profit, .. }, Some(b)) => assert_eq!((*amount, *profit), (b.amount, b.profit), "{name}"),
            (Outcome::NoProfit, None) => {}
            (o, b) => panic!("{name}: scanner {o:?} vs size search {b:?}"),
        }
        assert!(rep.opps.is_empty());
    }
}

#[test]
fn settings_and_switch() {
    let env = |m: &[(&str, &str)]| {
        let m: HashMap<String, String> = m.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        ScanConfig::from_lookup(move |k| m.get(k).cloned())
    };
    assert_eq!(env(&[]), ScanConfig::default());
    assert_eq!(ScanConfig::default().min_net_usd, 0.25, "review L5: the bot's own default");
    assert_eq!(ScanConfig::default().budget_us, 5_000, "final review H-1: 5 ms per block");
    assert_eq!(env(&[("MIN_EXEC_NET_USD", "0.25")]).min_net_usd, 0.25);
    assert_eq!(env(&[("MIN_EXEC_NET_USD", "0.25"), ("FASTLANE_MIN_NET_USD", "0.5")]).min_net_usd, 0.5);
    assert_eq!(env(&[("FASTLANE_MIN_NET_USD", "-1")]).min_net_usd, 0.25);
    assert_eq!(env(&[("MAX_PLAUSIBLE_PROFIT_SHARE", "0.1")]).max_plausible_share, 0.1);
    assert_eq!(env(&[("FASTLANE_DEDUPE_BLOCKS", "5")]).dedupe_blocks, 5);
    assert_eq!(env(&[("FASTLANE_ROUTE_MAX_US", "junk")]).route_max_us, 5_000);
    assert_eq!(env(&[("FASTLANE_SCAN_BUDGET_MS", "7.5")]).budget_us, 7_500);
    assert_eq!(env(&[("FASTLANE_SCAN_BUDGET_MS", "junk")]).budget_us, 5_000);
    assert_eq!(env(&[("FASTLANE_SWEEP_PER_BLOCK", "3")]).sweep_per_block, 3);
    assert_eq!(ScanConfig::default().route_time_ttl_blocks, 100);
    assert_eq!(env(&[("FASTLANE_ROUTE_TIME_TTL_BLOCKS", "30")]).route_time_ttl_blocks, 30);
    assert_eq!(env(&[("FASTLANE_ROUTE_TIME_TTL_BLOCKS", "0")]).route_time_ttl_blocks, 100);
    for (v, on) in [(None, false), (Some(""), false), (Some("off"), false), (Some("bogus"), false), (Some("practice"), true), (Some(" LIVE "), true), (Some("shadow"), true)] {
        assert_eq!(fastlane_on(v), on, "{v:?}");
    }
}

#[test]
fn hourly_counters() {
    reset_hour();
    let s = hill_state(2_000_000_000);
    let t = table(vec![(0xa, row("a>b:1", 0xa, 0xb, true, None, 0.05))]);
    let mut sc = scanner(t, cfg());
    let ch = vec![key(0xa)];
    sc.scan(&input(&s, &ctx(), 1, &ch, &HashSet::new()));
    // Counters are process-wide and tests run in parallel: check at least.
    let j: Value = status_json();
    assert!(j["blocks"].as_u64().unwrap() >= 1);
    assert!(j["found"].as_u64().unwrap() >= 1);
    assert!(j["bestNetUsd"].as_f64().unwrap() >= 3.15 - 1e-9);
    let line = take_hour();
    assert!(line.starts_with("[fastlane scan] "), "{line}");
    assert!(line.contains("full sweep every"));
}

// ---------------------------------------------------------------------------
// Review fixes (integration)
// ---------------------------------------------------------------------------

/// H1: the table changes every block (live: every ~1 s); the sweep must
/// still reach EVERY route, carrying on from where it stopped.
#[test]
fn sweep_reaches_every_route_when_the_table_changes_every_block() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let r = SlowRunner { us: 0, runs: Default::default(), seen: seen.clone() };
    let t = many(40);
    let mut sc = Scanner::new(ScanConfig { sweep_per_block: 5, ..cfg() }, Box::new(TableSource::owned(t.clone())), Box::new(r));
    let s = hill_state(1);
    let none = HashSet::new();
    for b in 0..10u64 {
        // A new table generation every block, one row's gas changed.
        {
            let mut g = t.lock().unwrap();
            g.gen += 1;
            let k = key(0x100 + (b % 40));
            let rows = g.pools.get_mut(&k).unwrap();
            rows[0] = row(&format!("r{:03}", b % 40), 0x100 + (b % 40), 0x900, true, None, 0.05 + b as f64 * 0.001);
        }
        sc.scan(&input(&s, &ctx(), b, &[], &none));
    }
    let set: HashSet<_> = seen.lock().unwrap().iter().cloned().collect();
    assert_eq!(set.len(), 40, "8 blocks x 5 = 40: every route swept once despite the table changing each block");
}

/// M5: a profit above MAX_PLAUSIBLE_PROFIT_SHARE of the size is broken data.
#[test]
fn implausible_share_is_never_returned() {
    let s = hill_state(2_000_000_000);
    let t = table(vec![(0xa, row("a>b:1", 0xa, 0xb, true, None, 0.05))]);
    let none = HashSet::new();
    let ch = vec![key(0xa)];
    // $3.15 on $400 = 0.79 %: fine at 0.25, implausible at 0.005.
    assert_eq!(scanner(t.clone(), cfg()).scan(&input(&s, &ctx(), 1, &ch, &none)).opps.len(), 1);
    let rep = scanner(t, ScanConfig { max_plausible_share: 0.005, ..cfg() }).scan(&input(&s, &ctx(), 1, &ch, &none));
    assert!(rep.opps.is_empty());
    assert_eq!(rep.checked[0].outcome, Outcome::Implausible);
}

/// M4: the same result is handed out again after FASTLANE_DEDUPE_BLOCKS,
/// and at once after `forget` (the sender says it never left).
#[test]
fn dedupe_expires_and_can_be_forgotten() {
    let s = hill_state(2_000_000_000);
    let t = table(vec![(0xa, row("a>b:1", 0xa, 0xb, true, None, 0.05))]);
    let mut sc = scanner(t, ScanConfig { dedupe_blocks: 3, ..cfg() });
    let none = HashSet::new();
    let a = vec![key(0xa)];
    let other = vec![key(0xc)];
    assert_eq!(sc.scan(&input(&s, &ctx(), 1, &a, &none)).opps.len(), 1);
    assert!(sc.scan(&input(&s, &ctx(), 2, &other, &none)).opps.is_empty());
    assert!(sc.scan(&input(&s, &ctx(), 3, &other, &none)).opps.is_empty());
    assert_eq!(sc.scan(&input(&s, &ctx(), 4, &other, &none)).opps.len(), 1, "3 blocks later: handed out again");
    assert!(sc.scan(&input(&s, &ctx(), 5, &other, &none)).opps.is_empty());
    sc.forget("a>b:1");
    assert_eq!(sc.scan(&input(&s, &ctx(), 6, &other, &none)).opps.len(), 1, "forgotten: handed out at once");
}

/// M6: a slow route rests; a route whose last time doesn't fit the budget
/// left is not started (the overrun is bounded).
#[test]
fn slow_routes_rest_and_the_budget_is_not_overrun() {
    let runs = Arc::new(AtomicUsize::new(0));
    let r = SlowRunner { us: 3_000, runs: runs.clone(), seen: Default::default() };
    let mut sc = Scanner::new(ScanConfig { budget_us: 10_000, sweep_per_block: 50, route_max_us: 2_000, ..cfg() }, Box::new(TableSource::owned(many(6))), Box::new(r));
    let s = hill_state(1);
    let none = HashSet::new();
    let rep = sc.scan(&input(&s, &ctx(), 1, &[], &none));
    let first = runs.load(Ordering::Relaxed);
    assert!(first >= 1 && rep.timing.total_us < 10_000 + 3_000 + 1_500, "ran {first}, took {}", rep.timing.total_us);
    // Every route checked so far took 3 ms > 2 ms: they rest now.
    let rep = sc.scan(&input(&s, &ctx(), 2, &[], &none));
    assert!(rep.resting >= 1, "{:?}", rep.resting);
}

// SPEED FIX (Oct 28): the scanner brings its route list up to date by
// touching only the pools whose rows changed (live: re-copying all ~38,700
// rows on every table message cost ~30 ms per block). The result must be
// exactly what a fresh full copy of the same table gives.
fn msg_rows(rows: &[Row]) -> Value {
    Value::Array(rows.iter().map(|r| json!({ "rid": r.rid, "h": r.held, "s": r.score, "e": r.e, "c": r.c.as_deref(), "f": r.f.as_deref() })).collect())
}

fn route_ids(src: &TableSource) -> Vec<(String, bool, Option<f64>, String)> {
    src.all().iter().map(|r| (r.rid.clone(), r.held, r.score, r.facts.as_ref().map(|f| format!("{:.4}", f.gas_usd)).unwrap_or_default())).collect()
}

#[test]
fn delta_sync_matches_full_sync() {
    use arbsim::check::entry::table_from_messages;
    // Full table: 6 pools, route r2 listed under two pools.
    let rows_of = |n: u64, gas: f64| vec![row(&format!("r{n}"), 0x100 + n, 0x900, n % 2 == 0, Some(n as f64), gas)];
    let mut pools = serde_json::Map::new();
    for n in 0..6u64 {
        pools.insert(key(0x100 + n), msg_rows(&rows_of(n, 0.05)));
    }
    pools.insert(key(0x200), msg_rows(&rows_of(2, 0.05)));
    let full = json!({ "type": "trig_table", "gen": 1, "full": true, "codes": [], "pools": Value::Object(pools) });
    let shared = Arc::new(Mutex::new(table_from_messages(std::slice::from_ref(&full)).unwrap()));
    let mut live = TableSource::owned(shared.clone());
    assert!(live.sync().is_empty());
    assert_eq!(live.all().len(), 6);
    assert_eq!((live.full_syncs, live.delta_syncs), (1, 0));
    let before: Vec<_> = live.all().to_vec();

    // Partial updates, applied the way arbsim applies them (set_pool):
    //   gen 2: pool 1 new facts (gas), pool 3 removed, a new pool 7
    //   gen 3: pool 0x200 (2nd listing of r2) removed: r2 stays (pool 2 still lists it)
    //   gen 4: pool 2 removed: r2 now gone
    let parts = vec![
        json!({ "type": "trig_table", "gen": 2, "full": false, "base": 1, "codes": [], "pools": { key(0x101): msg_rows(&rows_of(1, 0.09)), key(0x103): null, key(0x107): msg_rows(&rows_of(7, 0.05)) } }),
        json!({ "type": "trig_table", "gen": 3, "full": false, "base": 2, "codes": [], "pools": { key(0x200): null } }),
        json!({ "type": "trig_table", "gen": 4, "full": false, "base": 3, "codes": [], "pools": { key(0x102): null } }),
    ];
    let mut msgs = vec![full.clone()];
    for (i, p) in parts.iter().enumerate() {
        msgs.push(p.clone());
        // Bring the shared table to this generation (same steps as apply_table).
        {
            let mut g = shared.lock().unwrap();
            *g = table_from_messages(&msgs).unwrap();
        }
        assert!(live.sync().is_empty());
        let mut fresh = TableSource::owned(Arc::new(Mutex::new(table_from_messages(&msgs).unwrap())));
        fresh.sync();
        assert_eq!(route_ids(&live), route_ids(&fresh), "after part {} the delta-updated list equals a fresh full copy", i + 1);
        assert_eq!(live.ranked_for(&[key(0x101), key(0x107)]).len(), fresh.ranked_for(&[key(0x101), key(0x107)]).len());
    }
    assert_eq!(live.full_syncs, 1, "only the first sync copied the whole table");
    assert_eq!(live.delta_syncs, 3);
    // r2 survived gen 3 (still listed by pool 2) and went at gen 4; r3 went at gen 2.
    let ids: Vec<String> = live.all().iter().map(|r| r.rid.clone()).collect();
    assert_eq!(ids, vec!["r0", "r1", "r4", "r5", "r7"]);
    // Untouched routes keep the very same Route (no rebuild).
    let r0_before = before.iter().find(|r| r.rid == "r0").unwrap();
    let r0_now = live.all().iter().find(|r| r.rid == "r0").unwrap();
    assert!(Arc::ptr_eq(r0_before, r0_now));
    // A new FULL table: copied whole again.
    let mut m2 = msgs.clone();
    m2.push(json!({ "type": "trig_table", "gen": 9, "full": true, "codes": [], "pools": { key(0x100): msg_rows(&rows_of(0, 0.05)) } }));
    *shared.lock().unwrap() = table_from_messages(&m2).unwrap();
    live.sync();
    assert_eq!(live.full_syncs, 2);
    assert_eq!(live.all().iter().map(|r| r.rid.clone()).collect::<Vec<_>>(), vec!["r0"]);
}

// ---------------------------------------------------------------------------
// Unban fixes (Oct 30). Live: a route whose last check took longer than the
// budget was never tried again (its time only changed by running it), and
// the rolling sweep stopped at such a route every block (0 sweep checks and
// 0 full passes an hour).
// ---------------------------------------------------------------------------

/// Takes `first_us` on a route's FIRST run (by its first pool), then 0;
/// remembers which routes ran, in order.
struct OnceSlowRunner {
    first_us: HashMap<U256, u64>,
    ran: Arc<Mutex<Vec<U256>>>,
}
impl CheckRunner for OnceSlowRunner {
    fn run(&self, _v: &dyn StateRead, _c: &BlockCtx, p: &PreparedCheck, _a: &SizeSearchAmounts) -> Result<SizeSearchResult, CheckUnknown> {
        let pool = U256::from_be_slice(&p.call.data[4 + 32 * 9 + 12..4 + 32 * 10]);
        let first = !self.ran.lock().unwrap().contains(&pool);
        let us = if first { self.first_us.get(&pool).copied().unwrap_or(0) } else { 0 };
        let t = std::time::Instant::now();
        while (t.elapsed().as_micros() as u64) < us {
            std::hint::spin_loop();
        }
        self.ran.lock().unwrap().push(pool);
        Ok(SizeSearchResult { best: None, tried: vec![] })
    }
}

/// A route whose recorded time is over the whole budget is tried again:
/// as the first check of a block, and anywhere once its time has expired
/// (FASTLANE_ROUTE_TIME_TTL_BLOCKS).
#[test]
fn a_route_over_the_budget_is_not_banned_for_good() {
    let p0 = U256::from(0x100u64);
    let count = |ran: &Arc<Mutex<Vec<U256>>>| ran.lock().unwrap().iter().filter(|p| **p == p0).count();
    let none = HashSet::new();
    let s = hill_state(1);
    // (1) Alone: 12 ms once (budget 10 ms), then it runs as the block's first check.
    let ran = Arc::new(Mutex::new(Vec::new()));
    let r = OnceSlowRunner { first_us: HashMap::from([(p0, 12_000)]), ran: ran.clone() };
    let c = ScanConfig { budget_us: 10_000, sweep_per_block: 50, route_max_us: 1_000_000, ..cfg() };
    let mut sc = Scanner::new(c.clone(), Box::new(TableSource::owned(many(1))), Box::new(r));
    sc.scan(&input(&s, &ctx(), 1, &[], &none));
    let rep = sc.scan(&input(&s, &ctx(), 2, &[], &none));
    assert_eq!(count(&ran), 2, "first check of the block: tried again");
    assert_eq!(rep.cut_fit, 0);
    // (2) With another route checked first every block: passed over (counted)
    // until its time expires (TTL 4 blocks), then checked again.
    let ran = Arc::new(Mutex::new(Vec::new()));
    let r = OnceSlowRunner { first_us: HashMap::from([(p0, 12_000)]), ran: ran.clone() };
    let mut sc = Scanner::new(ScanConfig { route_time_ttl_blocks: 4, ..c }, Box::new(TableSource::owned(many(3))), Box::new(r));
    sc.scan(&input(&s, &ctx(), 1, &[], &none));
    assert_eq!(count(&ran), 1, "block 1: r000 ran (12 ms)");
    let ch = vec![key(0x101)];
    let mut again = None;
    let mut cut = 0;
    for epoch in 2..=8u64 {
        let rep = sc.scan(&input(&s, &ctx(), epoch, &ch, &none));
        cut += rep.cut_fit;
        if again.is_none() && count(&ran) == 2 {
            again = Some(epoch);
        }
    }
    assert!(cut >= 1, "passed over while its 12 ms time is remembered");
    assert_eq!(again, Some(5), "measured at epoch 1, TTL 4: checked again at epoch 5");
    // Re-measured fast: it fits again (no more "not fitting" for it).
    let rep = sc.scan(&input(&s, &ctx(), 9, &ch, &none));
    assert_eq!(rep.cut_fit, 0);
}

/// The rolling sweep passes over a route it can't fit instead of stopping
/// there for good: full passes keep completing.
#[test]
fn the_sweep_passes_over_a_route_that_does_not_fit() {
    let p2 = U256::from(0x102u64);
    let ran = Arc::new(Mutex::new(Vec::new()));
    let r = OnceSlowRunner { first_us: HashMap::from([(p2, 12_000)]), ran: ran.clone() };
    // No expiry in this test (TTL 1000 blocks): only the pass-over helps.
    let c = ScanConfig { budget_us: 10_000, sweep_per_block: 50, route_max_us: 1_000_000, route_time_ttl_blocks: 1_000, ..cfg() };
    let mut sc = Scanner::new(c, Box::new(TableSource::owned(many(6))), Box::new(r));
    let s = hill_state(1);
    let none = HashSet::new();
    // Block 1: r000, r001, then r002 takes 12 ms (budget gone).
    sc.scan(&input(&s, &ctx(), 1, &[], &none));
    // Then a changed-pool route (r005) runs first every block, so r002
    // (12 ms remembered) never fits.
    let ch = vec![key(0x105)];
    let mut passes = Vec::new();
    let mut cut = 0;
    for b in 2..=8u64 {
        let rep = sc.scan(&input(&s, &ctx(), b, &ch, &none));
        assert!(rep.checked.iter().any(|c| c.source == "sweep"), "block {b}: the sweep keeps moving");
        cut += rep.cut_fit;
        if let Some(n) = rep.full_sweep_blocks {
            passes.push(n);
        }
    }
    assert!(passes.len() >= 5, "a full pass (nearly) every block: {passes:?}");
    assert!(passes.iter().all(|n| *n <= 2), "{passes:?}");
    assert!(cut >= 5, "r002 counted as not fitting each time it is passed over: {cut}");
    assert_eq!(ran.lock().unwrap().iter().filter(|p| **p == p2).count(), 1, "r002 not run again (no expiry here)");
    for i in [0u64, 1, 3, 4] {
        let n = ran.lock().unwrap().iter().filter(|p| **p == U256::from(0x100 + i)).count();
        assert!(n >= 5, "r00{i} checked {n} times");
    }
}

/// Takes a fixed time per route (by its first pool), every run.
struct FixedRunner {
    us: HashMap<U256, u64>,
    ran: Arc<Mutex<Vec<U256>>>,
}
impl CheckRunner for FixedRunner {
    fn run(&self, _v: &dyn StateRead, _c: &BlockCtx, p: &PreparedCheck, _a: &SizeSearchAmounts) -> Result<SizeSearchResult, CheckUnknown> {
        let pool = U256::from_be_slice(&p.call.data[4 + 32 * 9 + 12..4 + 32 * 10]);
        let us = self.us.get(&pool).copied().unwrap_or(0);
        let t = std::time::Instant::now();
        while (t.elapsed().as_micros() as u64) < us {
            std::hint::spin_loop();
        }
        self.ran.lock().unwrap().push(pool);
        Ok(SizeSearchResult { best: None, tried: vec![] })
    }
}

/// (Review, Oct 30) The changed-pool step used ~90% of the budget: FAST
/// timed sweep routes (1.5 ms, inside the sweep's own 2.5 ms share) must
/// NOT be passed over (marked visited without a check); the sweep waits for
/// the next block and carries on from them.
#[test]
fn a_busy_changed_step_does_not_make_the_sweep_skip_fast_routes() {
    let ran = Arc::new(Mutex::new(Vec::new()));
    let mut us: HashMap<U256, u64> = (0..5u64).map(|i| (U256::from(0x100 + i), 1_500)).collect();
    us.insert(U256::from(0x105u64), 8_800);
    let r = FixedRunner { us, ran: ran.clone() };
    let c = ScanConfig { budget_us: 10_000, sweep_per_block: 50, route_max_us: 1_000_000, route_time_ttl_blocks: 1_000, ..cfg() };
    let mut sc = Scanner::new(c, Box::new(TableSource::owned(many(6))), Box::new(r));
    let s = hill_state(1);
    let none = HashSet::new();
    // Block 1: every route timed (r000..r004 1.5 ms each, r005 8.8 ms).
    sc.scan(&input(&s, &ctx(), 1, &[], &none));
    assert_eq!(ran.lock().unwrap().len(), 6);
    // Block 2: r005's pool changed: 8.8 ms of the 10 ms used before the sweep.
    let ch = vec![key(0x105)];
    let rep = sc.scan(&input(&s, &ctx(), 2, &ch, &none));
    assert_eq!(rep.checked.len(), 1, "only r005 ran: {:?}", rep.checked);
    assert_eq!(rep.cut_fit, 1, "the sweep stopped at the first fast route (no skipping run)");
    assert_eq!(rep.full_sweep_blocks, None, "no pass counted over routes never checked");
    // Block 3 (quiet): the sweep carries on from where it stopped and checks them.
    ran.lock().unwrap().clear();
    let rep = sc.scan(&input(&s, &ctx(), 3, &[], &none));
    let order = ran.lock().unwrap().clone();
    assert_eq!(order.first(), Some(&U256::from(0x100u64)), "{order:?}");
    assert!(rep.checked.iter().filter(|c| c.source == "sweep").count() >= 5, "{:?}", rep.checked);
}

/// (Review, Oct 30) A quick answer (route on an unsure pool) is not "the
/// block's first check": a route timed over the budget may still start.
#[test]
fn a_quick_unsure_answer_does_not_end_the_first_check_exception() {
    let p0 = U256::from(0x100u64);
    let ran = Arc::new(Mutex::new(Vec::new()));
    let r = OnceSlowRunner { first_us: HashMap::from([(p0, 12_000)]), ran: ran.clone() };
    let c = ScanConfig { budget_us: 10_000, sweep_per_block: 50, route_max_us: 1_000_000, ..cfg() };
    // r000 (pool 0x100) and r001 (pool 0x101).
    let mut sc = Scanner::new(c, Box::new(TableSource::owned(many(2))), Box::new(r));
    let s = hill_state(1);
    let none = HashSet::new();
    sc.scan(&input(&s, &ctx(), 1, &[], &none));
    // Block 2: r001's pool is unsure and changed: answered "skipped" at once
    // (no engine run); r000 (12 ms remembered) still counts as first.
    let unsure: HashSet<String> = [key(0x101)].into_iter().collect();
    let ch = vec![key(0x101)];
    let rep = sc.scan(&input(&s, &ctx(), 2, &ch, &unsure));
    assert_eq!(rep.checked[0].outcome, Outcome::SkippedUnsure);
    assert_eq!(rep.cut_fit, 0, "{:?}", rep.checked);
    assert_eq!(ran.lock().unwrap().iter().filter(|p| **p == p0).count(), 2, "r000 ran again");
}
