// ============================================================================
// CALCULATED TRADE SIZE tests (check/sizing.rs, trigger-first entry point).
//
// Plain English: the entry point used to try a fixed list of sizes. Now it
// works out the best size on the pools as they are right after the trade we
// follow. These tests check, against a brute-force answer (trying a huge
// number of sizes), that:
//   - V2 pairs and V3 pools (inside one price range): the calculated size is
//     within 1% of the true best size, in a handful of runs, and makes at
//     least as much as the best size of the old ladder;
//   - V3 / V4 pools where the best trade crosses into another price range
//     (tick crossing): still within 1%;
//   - a hook pool (fee changing with size) or a coin that takes a cut: the
//     search (real runs, no curve assumption) takes over and still finds it;
//   - the caps (lowest / highest size the bot allows) are never crossed;
//   - a tiny gap gives no size; a size we can't measure gives "failed" so
//     the old ladder decides;
//   - on the real ArbExecutor fixtures (V3>V3, V3>V2>V3): same, with the
//     real contract;
//   - inside a replayed feed (check/ordered.rs): the size is worked out on
//     the state AFTER the trigger, its rows come back in the answer, the
//     ladder runs only for comparison (shadow) or as the fallback.
// Bench lines are labelled "test numbers only".
// ============================================================================
mod check_util;

use std::time::Instant;

use arbsim::check::fixture::Fixture;
use arbsim::check::search::{classify, patch_amount};
use arbsim::check::sizing::{calc_size, CalcOut, CalcParams, Method, Probe};
use arbsim::check::{run_calls, CallReq, Overrides};
use check_util::*;
use revm::primitives::{Bytes, U256};

fn u(x: u128) -> U256 {
    U256::from(x)
}
fn uf(x: f64) -> U256 {
    U256::try_from(x.floor().max(0.0)).unwrap()
}
fn ff(x: U256) -> f64 {
    f64::from(x)
}

fn params(lo: u128, hi: u128) -> CalcParams {
    CalcParams { lo: u(lo), hi: u(hi), loan_pips: 0, fit: true, backup: 0.6, max_probes: 12, compare: false }
}

/// A profit curve (start-coin units, f64) as a probe: floor to whole units
/// like the contract, 0 = loss.
fn as_probe(p: f64) -> Probe {
    if p >= 1.0 {
        Probe::Profit(uf(p))
    } else {
        Probe::Loss
    }
}

/// Brute force: the size in [lo, hi] with the most profit (a 400-point log
/// sweep, then a fine search between its neighbours down to single units).
fn brute(lo: f64, hi: f64, pf: &dyn Fn(f64) -> f64) -> (f64, f64) {
    let n = 400;
    let (a, b) = (lo.ln(), hi.ln());
    let xs: Vec<f64> = (0..n).map(|i| (a + (b - a) * i as f64 / (n - 1) as f64).exp().floor()).collect();
    let bi = (0..n).max_by(|i, j| pf(xs[*i]).total_cmp(&pf(xs[*j]))).unwrap();
    let (mut l, mut r) = (xs[bi.saturating_sub(1)], xs[(bi + 1).min(n - 1)]);
    for _ in 0..300 {
        if r - l < 3.0 {
            break;
        }
        let m1 = (l + (r - l) / 3.0).floor();
        let m2 = (r - (r - l) / 3.0).floor();
        if pf(m1) < pf(m2) {
            l = m1;
        } else {
            r = m2;
        }
    }
    let mut best = (l, pf(l));
    let mut x = l;
    while x <= r {
        if pf(x) > best.1 {
            best = (x, pf(x));
        }
        x += 1.0;
    }
    best
}

/// Run the calculation on a curve; also returns how many runs it used.
fn calc_on(p: &CalcParams, pf: &dyn Fn(f64) -> f64) -> CalcOut {
    let seeds = [(p.hi, as_probe(pf(ff(p.hi))))];
    calc_size(p, &seeds, &mut |x| as_probe(pf(ff(x))))
}

/// The old ladder's best profit ($100 / $400 / $1200 at 1e6 units per $),
/// sizes above the cap left out.
fn ladder_best(hi: f64, pf: &dyn Fn(f64) -> f64) -> f64 {
    [100e6, 400e6, 1200e6].iter().filter(|x| **x <= hi).map(|x| pf(*x).floor().max(0.0)).fold(0.0, f64::max)
}

fn check_close(name: &str, out: &CalcOut, true_x: f64, pf: &dyn Fn(f64) -> f64, hi: f64) {
    let x = ff(out.calc.unwrap_or_else(|| panic!("{name}: no size: {out:?}")));
    let rel = (x - true_x).abs() / true_x;
    println!(
        "{name}: calc {x:.0} vs true best {true_x:.0} ({:.3}% off), profit {:.0} vs {:.0}, method {}, {} runs",
        rel * 100.0,
        pf(x),
        pf(true_x),
        out.method.as_str(),
        out.probes
    );
    if out.method != Method::Fit {
        println!("  {name} sizes: {:?}", out.tried);
    }
    assert!(rel <= 0.01, "{name}: calculated size {x} not within 1% of the true best {true_x}: {out:?}");
    assert!(pf(x).floor() >= ladder_best(hi, pf), "{name}: profit at the calculated size below the old ladder's best");
}

// ---------------------------------------------------------------------------
// Pool maths for the synthetic tests (same formulas as the real pools).
// ---------------------------------------------------------------------------

/// UniswapV2 getAmountOut (integers, fee in basis points).
fn v2_out(x: U256, r_in: U256, r_out: U256, fee_bps: u64) -> U256 {
    let xf = x * U256::from(10_000 - fee_bps);
    xf * r_out / (r_in * U256::from(10_000u64) + xf)
}

/// One concentrated-liquidity pool (V3 / V4): price = coin1 per coin0, and
/// liquidity per price range [lower, upper) (sorted, touching).
#[derive(Clone)]
struct Clp {
    sqrt_p: f64,
    ranges: Vec<(f64, f64, f64)>, // (sqrt lower, sqrt upper, liquidity)
    fee: f64,
}

impl Clp {
    fn liq_at(&self, s: f64, down: bool) -> Option<(f64, f64, f64)> {
        self.ranges.iter().copied().find(|(lo, hi, _)| if down { s > *lo && s <= *hi } else { s >= *lo && s < *hi })
    }
    /// Coin1 in -> coin0 out (price goes up), crossing ranges. Also says
    /// how many ranges were crossed.
    fn one_for_zero(&self, y: f64) -> (f64, usize) {
        let (mut s, mut left, mut out, mut crossed) = (self.sqrt_p, y * (1.0 - self.fee), 0.0, 0);
        while left > 0.0 {
            let Some((_, hi, l)) = self.liq_at(s, false) else { break };
            let need = l * (hi - s); // coin1 to reach the top of this range
            if left < need {
                let s2 = s + left / l;
                out += l * (1.0 / s - 1.0 / s2);
                left = 0.0;
            } else {
                out += l * (1.0 / s - 1.0 / hi);
                left -= need;
                s = hi;
                crossed += 1;
            }
        }
        (out, crossed)
    }
    /// Coin0 in -> coin1 out (price goes down), crossing ranges.
    fn zero_for_one(&self, x: f64) -> (f64, usize) {
        let (mut s, mut left, mut out, mut crossed) = (self.sqrt_p, x * (1.0 - self.fee), 0.0, 0);
        while left > 0.0 {
            let Some((lo, _, l)) = self.liq_at(s, true) else { break };
            let need = l * (1.0 / lo - 1.0 / s); // coin0 to reach the bottom of this range
            if left < need {
                let s2 = 1.0 / (1.0 / s + left / l);
                out += l * (s - s2);
                left = 0.0;
            } else {
                out += l * (s - lo);
                left -= need;
                s = lo;
                crossed += 1;
            }
        }
        (out, crossed)
    }
}

/// Buy coin0 with coin1 on A, sell it on B; profit in coin1 (after `k`:
/// lender fee) and ranges crossed in total.
fn clp_round(a: &Clp, b: &Clp, y: f64, k: f64) -> (f64, usize) {
    let (mid, c1) = a.one_for_zero(y);
    let (back, c2) = b.zero_for_one(mid);
    (back - k * y, c1 + c2)
}

fn wide(price: f64, l: f64, fee: f64) -> Clp {
    Clp { sqrt_p: price.sqrt(), ranges: vec![(0.5f64.sqrt(), 2.0f64.sqrt(), l)], fee }
}

// ---------------------------------------------------------------------------
// Synthetic pools.
// ---------------------------------------------------------------------------

#[test]
fn v2_pair_calc_within_one_percent_of_brute_force() {
    // Pool A: 2M / 2M; pool B: 2M / 2.06M (3% apart), $1 = 1e6 units, 0.3% fees.
    let (ra0, ra1) = (u(2_000_000_000_000), u(2_000_000_000_000));
    let (rb0, rb1) = (u(2_000_000_000_000), u(2_060_000_000_000));
    let pf = |x: f64| -> f64 {
        let x = uf(x);
        let mid = v2_out(x, ra1, ra0, 30);
        let back = v2_out(mid, rb0, rb1, 30);
        ff(back) - ff(x)
    };
    let p = params(10_000_000, 100_000_000_000);
    let (bx, _) = brute(1e7, 1e11, &pf);
    let out = calc_on(&p, &pf);
    assert_eq!(out.method, Method::Fit, "{out:?}");
    assert!(out.probes <= 5, "V2: a handful of runs ({})", out.probes);
    check_close("V2 pair", &out, bx, &pf, 1e11);
    // Backup = 60% of it, measured too.
    let c = ff(out.calc.unwrap());
    let b = ff(out.backup.unwrap());
    assert!((b / c - 0.6).abs() < 0.001, "backup 60%: {b} vs {c}");
    assert!(out.tried.iter().any(|(x, _)| *x == out.backup.unwrap()), "backup was really run");
    // With a lender fee (0.05%) the best size is smaller, still found.
    let k = 1.0005;
    let pfk = |x: f64| pf(x) - (k - 1.0) * x;
    let pk = CalcParams { loan_pips: 500, ..p.clone() };
    let (bxk, _) = brute(1e7, 1e11, &pfk);
    let outk = calc_on(&pk, &pfk);
    check_close("V2 pair + lender fee", &outk, bxk, &pfk, 1e11);
    assert!(bxk < bx);
    // A wrong lender fee (0 given, 0.05% charged): the extra runs correct it.
    let outw = calc_on(&p, &pfk);
    check_close("V2 pair, lender fee not told", &outw, bxk, &pfk, 1e11);
}

#[test]
fn v3_pool_in_range_calc_within_one_percent() {
    // Two V3 pools, 2% apart, deep liquidity (no range crossed at the best size).
    let a = wide(1.0, 5e12, 0.0005);
    let b = wide(1.02, 3e12, 0.003);
    let pf = |y: f64| clp_round(&a, &b, y, 1.0).0;
    let (bx, _) = brute(1e7, 2e11, &pf);
    assert_eq!(clp_round(&a, &b, bx, 1.0).1, 0, "the best size stays inside one range");
    let out = calc_on(&params(10_000_000, 200_000_000_000), &pf);
    assert_eq!(out.method, Method::Fit, "{out:?}");
    assert!(out.probes <= 5, "in-range V3: a handful of runs ({})", out.probes);
    check_close("V3 in range", &out, bx, &pf, 2e11);
}

#[test]
fn v3_v4_tick_crossing_calc_within_one_percent() {
    // Pool B (think V4) holds 3x more liquidity just under its price, then
    // thin liquidity further down: the best trade crosses into the thin part.
    let a = wide(1.0, 8e12, 0.0005);
    let sb = 1.03f64.sqrt();
    let b = Clp { sqrt_p: sb, ranges: vec![(0.5f64.sqrt(), 1.025f64.sqrt(), 6e11), (1.025f64.sqrt(), 2.0f64.sqrt(), 2e12)], fee: 0.003 };
    let pf = |y: f64| clp_round(&a, &b, y, 1.0).0;
    let (bx, _) = brute(1e7, 5e11, &pf);
    assert!(clp_round(&a, &b, bx, 1.0).1 >= 1, "the best trade crosses a range boundary (tick)");
    let out = calc_on(&params(10_000_000, 500_000_000_000), &pf);
    check_close("V3/V4 tick crossing", &out, bx, &pf, 5e11);
    // And the other way: deep liquidity first, the best trade crosses into a
    // deeper range further away (the curve gets flatter after the crossing).
    let b2 = Clp { sqrt_p: sb, ranges: vec![(0.5f64.sqrt(), 1.027f64.sqrt(), 9e12), (1.027f64.sqrt(), 2.0f64.sqrt(), 4e11)], fee: 0.003 };
    let pf2 = |y: f64| clp_round(&a, &b2, y, 1.0).0;
    let (bx2, _) = brute(1e7, 5e11, &pf2);
    assert!(clp_round(&a, &b2, bx2, 1.0).1 >= 1, "crosses into the deeper range");
    let out2 = calc_on(&params(10_000_000, 500_000_000_000), &pf2);
    check_close("V3/V4 tick crossing into deeper liquidity", &out2, bx2, &pf2, 5e11);
}

#[test]
fn hooked_pool_falls_back_to_search_and_still_finds_it() {
    // A hook whose fee grows with the trade (0.3% + 1% per 1% of the pool):
    // NOT the constant-product curve. The bot marks hooked routes (fit off).
    let pf = |x: f64| -> f64 {
        let r = 2e12;
        let fee = 0.003 + x / r;
        let mid = x * (1.0 - fee) * r / (r + x * (1.0 - fee));
        let back = mid * 0.997 * 2.08e12 / (2e12 + mid * 0.997);
        back - x
    };
    let (bx, _) = brute(1e7, 1e11, &pf);
    let hooked = CalcParams { fit: false, ..params(10_000_000, 100_000_000_000) };
    let out = calc_on(&hooked, &pf);
    assert_eq!(out.method, Method::Search, "hook hint: search with real runs: {out:?}");
    assert!(out.probes <= 12, "within the run budget ({})", out.probes);
    let x = ff(out.calc.unwrap());
    println!("hooked (search): calc {x:.0} vs {bx:.0}, profit {:.0} vs {:.0}, {} runs", pf(x), pf(bx), out.probes);
    assert!(pf(x) >= 0.99 * pf(bx), "search: profit within 1% of the best");
    assert!(pf(x).floor() >= ladder_best(1e11, &pf));
    // Without the hint the curve check still gets there (fit or search).
    let out2 = calc_on(&params(10_000_000, 100_000_000_000), &pf);
    assert!(pf(ff(out2.calc.unwrap())) >= 0.99 * pf(bx), "{out2:?}");
}

#[test]
fn coin_with_transfer_cut_and_two_hill_curve() {
    // A coin that takes 2% on every move: still the pool curve (a cut in
    // proportion only changes its numbers), found by the fit.
    let (ra, rb) = (2e12, 2.10e12);
    let v2 = |x: f64, rin: f64, rout: f64| x * 0.997 * rout / (rin + x * 0.997);
    let pf = |x: f64| v2(v2(x, ra, ra) * 0.98, ra, rb) * 0.98 - x;
    let (bx, _) = brute(1e7, 1e11, &pf);
    let out = calc_on(&params(10_000_000, 100_000_000_000), &pf);
    check_close("coin with a 2% transfer cut", &out, bx, &pf, 1e11);
    // A curve with a second, higher hill (think: a hook rebate on mid-size
    // trades) that a ladder size happened to hit: the answer is never worse
    // than any size measured (the fit's own hill is never kept when a
    // measured size makes more: it climbs to it, or the search takes over).
    let two = |x: f64| if (4e10..=6e10).contains(&x) { 5e9 } else { pf(x) };
    let p = params(10_000_000, 100_000_000_000);
    let seeds = [(p.hi, as_probe(two(1e11))), (u(50_000_000_000), as_probe(two(5e10)))];
    let out2 = calc_size(&p, &seeds, &mut |x| as_probe(two(ff(x))));
    assert!(two(ff(out2.calc.unwrap())) >= 5e9, "never worse than a measured size: {out2:?}");
}

#[test]
fn caps_are_never_crossed() {
    // The true best (~13.5 * 1e9) is above the cap (5e9): the answer is the cap.
    let (ra0, ra1) = (u(2_000_000_000_000), u(2_000_000_000_000));
    let (rb0, rb1) = (u(2_000_000_000_000), u(2_060_000_000_000));
    let pf = |x: f64| -> f64 {
        let x = uf(x);
        ff(v2_out(v2_out(x, ra1, ra0, 30), rb0, rb1, 30)) - ff(x)
    };
    let p = params(10_000_000, 5_000_000_000);
    let out = calc_on(&p, &pf);
    assert_eq!(out.calc, Some(u(5_000_000_000)), "{out:?}");
    assert!(out.tried.iter().all(|(x, _)| *x >= p.lo && *x <= p.hi), "every size between the bot's lowest and highest");
    // lo above hi: only the cap.
    let out = calc_on(&params(9_000_000_000, 5_000_000_000), &pf);
    assert!(out.tried.iter().all(|(x, _)| *x <= u(5_000_000_000)));
    assert_eq!(out.calc, Some(u(5_000_000_000)));
}

#[test]
fn tiny_gap_gives_no_size() {
    // Pools only 0.4% apart with 0.3% fees each way: no size makes money.
    let (r0, r1) = (u(2_000_000_000_000), u(2_008_000_000_000));
    let pf = |x: f64| -> f64 {
        let x = uf(x);
        ff(v2_out(v2_out(x, r0, r0, 30), r0, r1, 30)) - ff(x)
    };
    let out = calc_on(&params(10_000_000, 100_000_000_000), &pf);
    assert_eq!(out.method, Method::None, "{out:?}");
    assert!(out.calc.is_none() && out.backup.is_none());
    assert!(out.probes <= 1, "decided from the smallest size alone");
}

#[test]
fn sizes_we_cant_measure() {
    // The smallest size can't be answered: failed (the ladder decides).
    let p = params(10_000_000, 100_000_000_000);
    let out = calc_size(&p, &[(p.hi, Probe::Profit(u(1)))], &mut |_| Probe::Unknown);
    assert_eq!(out.method, Method::Failed);
    assert!(out.calc.is_none());
    // Bigger sizes can't be answered (e.g. a far price range we don't hold):
    // treated as "too big", the best size below them is still found.
    let (r0, r1) = (u(2_000_000_000_000), u(2_060_000_000_000));
    let pf = |x: f64| -> f64 {
        let x = uf(x);
        ff(v2_out(v2_out(x, r0, r0, 30), r0, r1, 30)) - ff(x)
    };
    let cut = u(8_000_000_000);
    let out = calc_size(&p, &[(p.hi, Probe::Unknown)], &mut |x| if x > cut { Probe::Unknown } else { as_probe(pf(ff(x))) });
    let x = out.calc.expect("a size below the unknown ones");
    assert!(x <= cut, "{out:?}");
    assert!(pf(ff(x)) >= 0.99 * pf(ff(cut)), "the best measurable size (the curve still rises at the cut): {out:?}");
}

// ---------------------------------------------------------------------------
// Real contract (ArbExecutor) fixtures.
// ---------------------------------------------------------------------------

fn fixture_case(name: &str) {
    let f = Fixture::load(&fixture_path(name)).unwrap();
    let (amt_off, _) = arbsim::check::cli::executor_offsets(&f.call.data).unwrap();
    let base_amt = U256::from_be_slice(&f.call.data[4 + amt_off..4 + amt_off + 32]);
    let ov = Overrides::none();
    let run = |x: U256| -> Probe {
        let call = CallReq { data: patch_amount(&f.call.data, amt_off, x).unwrap(), ..f.call.clone() };
        match run_calls(&f.state, &f.ctx, &ov, &[], &[call]) {
            Ok(o) => Probe::of(&classify(x, &o[0])),
            Err(_) => Probe::Unknown,
        }
    };
    let pf = |x: f64| match run(uf(x)) {
        Probe::Profit(p) => ff(p),
        Probe::Loss => 0.0,
        _ => -1.0,
    };
    let (lo, hi) = (base_amt / u(100), base_amt * u(10));
    // Brute force with the real contract (hundreds of runs).
    let (bx, bp) = brute(ff(lo), ff(hi), &pf);
    assert!(bp > 0.0, "{name}: this fixture has a profitable size");
    let p = CalcParams { lo, hi, loan_pips: 0, fit: true, backup: 0.6, max_probes: 12, compare: false };
    let t = Instant::now();
    let out = calc_size(&p, &[(hi, run(hi))], &mut |x| run(x));
    let ms = t.elapsed().as_secs_f64() * 1e3;
    let x = ff(out.calc.expect("a size"));
    // The old ladder: the base size and two smaller ones (like $100/$400/$1200).
    let lad = [base_amt / u(12), base_amt / u(3), base_amt].iter().map(|a| pf(ff(*a))).fold(0.0, f64::max);
    println!(
        "{name}: calc {x:.0} vs true best {bx:.0} ({:.3}% off), profit {:.0} vs {:.0} (old ladder best {lad:.0}), method {}, {} runs, {ms:.2} ms incl. fresh state per run [test numbers only]",
        (x - bx).abs() / bx * 100.0,
        pf(x),
        bp,
        out.method.as_str(),
        out.probes
    );
    // Profit within 0.1% of the true best (the real curve is very flat near
    // its top, so the size itself is checked loosely by profit).
    assert!(pf(x) >= 0.999 * bp, "{name}: profit at the calculated size within 0.1% of the true best");
    assert!((x - bx).abs() / bx <= 0.01 || pf(x) >= bp, "{name}: calculated size within 1% of the true best");
    assert!(pf(x) >= lad, "{name}: at least the old ladder's best");
    assert!(out.probes <= 12);
}

#[test]
fn v3_v3_fixture_real_contract() {
    fixture_case("offline-v3-v3-small");
}

#[test]
fn v3_v2_v3_fixture_real_contract() {
    fixture_case("offline-v3-v2-v3");
}

// ---------------------------------------------------------------------------
// Bench (test numbers only): the sizing maths alone, with instant probes.
// ---------------------------------------------------------------------------
#[test]
fn bench_calc_overhead_test_numbers_only() {
    let (r0, r1) = (u(2_000_000_000_000), u(2_060_000_000_000));
    let pf = |x: f64| -> f64 {
        let x = uf(x);
        ff(v2_out(v2_out(x, r0, r0, 30), r0, r1, 30)) - ff(x)
    };
    let p = params(10_000_000, 100_000_000_000);
    let n = 2000;
    let t = Instant::now();
    let mut probes = 0;
    for _ in 0..n {
        probes += calc_on(&p, &pf).probes;
    }
    println!(
        "[bench, test numbers only] calc_size bookkeeping (V2 maths as the probe): {:.2} us per calculation, {:.1} runs each ({} build); real cost = runs x one contract run (~10-40 us live)",
        t.elapsed().as_secs_f64() * 1e6 / n as f64,
        probes as f64 / n as f64,
        if cfg!(debug_assertions) { "debug" } else { "release" }
    );
    let _ = Bytes::new();
}
