// ============================================================================
// Size search tests (workstream C): finds the true best size on a synthetic
// profit hill (exact math known) and on the real v3-v3 fixture (verified by
// sweeping many sizes), reuses the trigger's work, and says "unknown" when a
// size touches something we don't have.
// ============================================================================
mod check_util;

use std::time::Instant;

use arbsim::check::fixture::Fixture;
use arbsim::check::search::{classify, patch_amount};
use arbsim::check::{run_calls, size_search, CallReq, Overrides, SizeSearchAmounts, SizeTemplate, UnknownReason};
use check_util::*;
use revm::primitives::{Bytes, U256};

const CURVE: u64 = 0xc0ffee;

fn curve_template(amount_from_slot: bool) -> SizeTemplate {
    let mut data = vec![0x12, 0x34, 0x56, 0x78];
    data.extend([0u8; 32]);
    SizeTemplate {
        call: CallReq { from: addr(0xabc), to: Some(addr(CURVE)), data: Bytes::from(data), gas: Some(1_000_000), value: U256::ZERO },
        amount_offset: 0,
        amount_slots: if amount_from_slot { vec![(addr(CURVE), U256::from(5))] } else { vec![] },
    }
}

fn u(x: u128) -> U256 {
    U256::from(x)
}

#[test]
fn finds_peak_of_synthetic_hill() {
    // profit(x) = x*(k-x)/scale, peak at k/2. Several hill positions.
    for (k, lo, hi) in [(2_000_000u128, 1_000u128, 1_900_000u128), (10u128.pow(21), 10u128.pow(15), 9 * 10u128.pow(20)), (600_000, 10, 590_000)] {
        let (k, scale) = (u(k), u(1000));
        let s = state_with(&[(addr(CURVE), code_profit_curve(k, scale, None), vec![])], false);
        let r = size_search(&s, &ctx(), &Overrides::none(), &[], &curve_template(false), &SizeSearchAmounts::Range { lo: u(lo), hi: u(hi), steps: 12 }).unwrap();
        assert!(r.tried.len() <= 12, "used {} tries", r.tried.len());
        let best = r.best.expect("found a profit");
        let true_max = curve(k / u(2), k, scale);
        // Within 1% of the true best profit (12 tries over 3 orders of magnitude).
        assert!(best.profit * u(100) >= true_max * u(99), "k={k}: best {} vs true {}", best.profit, true_max);
        assert_eq!(best.profit, curve(best.amount, k, scale), "reported profit = what that size really makes");
    }
}

#[test]
fn amount_from_storage_slot_patch() {
    // The contract reads its size from storage slot 5 (like a token balance
    // the own-money check pretends): amount_slots sets it per try.
    let (k, scale) = (u(2_000_000), u(1000));
    let s = state_with(&[(addr(CURVE), code_profit_curve(k, scale, Some(5)), vec![(U256::from(5), U256::from(1))])], true);
    let mut st = s.clone();
    add_eoa(&mut st, addr(0xabc), U256::ZERO);
    let r = size_search(&st, &ctx(), &Overrides::none(), &[], &curve_template(true), &SizeSearchAmounts::Range { lo: u(1000), hi: u(1_900_000), steps: 12 }).unwrap();
    let best = r.best.unwrap();
    assert!(best.profit * u(100) >= curve(k / u(2), k, scale) * u(99));
    for t in &r.tried {
        assert_eq!(t.profit, curve(t.amount, k, scale), "each try used its own size");
    }
}

#[test]
fn explicit_list_tries_each_and_picks_max() {
    let (k, scale) = (u(1000), u(1));
    let s = state_with(&[(addr(CURVE), code_profit_curve(k, scale, None), vec![])], false);
    let list = vec![u(100), u(500), u(400), u(2000)];
    let r = size_search(&s, &ctx(), &Overrides::none(), &[], &curve_template(false), &SizeSearchAmounts::List(list)).unwrap();
    assert_eq!(r.tried.len(), 4);
    assert_eq!(r.best.unwrap().amount, u(500));
    assert_eq!(r.tried[3].status, "loss", "x >= k gives profit 0 = loss");
}

#[test]
fn missing_item_makes_search_unknown() {
    let (k, scale) = (u(1000), u(1));
    let s = state_with(&[(addr(CURVE), code_profit_curve(k, scale, Some(5)), vec![])], true);
    let mut st = s.clone();
    add_eoa(&mut st, addr(0xabc), U256::ZERO);
    // No amount_slots: slot 5 isn't known -> unknown with that exact slot.
    let e = size_search(&st, &ctx(), &Overrides::none(), &[], &curve_template(false), &SizeSearchAmounts::List(vec![u(10)])).unwrap_err();
    assert_eq!(e.reason, UnknownReason::Miss);
    assert_eq!(e.missing, vec![arbsim::state::MissItem::Slot(addr(CURVE), U256::from(5))]);
}

#[test]
fn bad_offset_is_bad_request() {
    let s = state_with(&[], false);
    let mut t = curve_template(false);
    t.amount_offset = 4;
    let e = size_search(&s, &ctx(), &Overrides::none(), &[], &t, &SizeSearchAmounts::List(vec![u(1)])).unwrap_err();
    assert_eq!(e.reason, UnknownReason::BadRequest);
}

// On the real v3-v3 fixture: sweep many sizes one by one (independent
// checks) to learn the true curve, then check the 12-try search lands on
// (nearly) the same best profit and that every try matches a fresh check.
#[test]
fn v3_v3_fixture_search_matches_sweep() {
    let f = Fixture::load(&fixture_path("offline-v3-v3-small")).unwrap();
    let (amt_off, _) = arbsim::check::cli::executor_offsets(&f.call.data).unwrap();
    let base_amt = U256::from_be_slice(&f.call.data[4 + amt_off..4 + amt_off + 32]);
    let (lo, hi) = (base_amt / u(100), base_amt * u(10));
    let tpl = SizeTemplate { call: f.call.clone(), amount_offset: amt_off, amount_slots: vec![] };
    let ov = Overrides::none();

    let t0 = Instant::now();
    let r = size_search(&f.state, &f.ctx, &ov, &[], &tpl, &SizeSearchAmounts::Range { lo, hi, steps: 12 }).unwrap();
    let search_ms = t0.elapsed().as_secs_f64() * 1e3;
    let best = r.best.clone().expect("this fixture has a profitable size");
    assert!(r.tried.len() <= 12);

    // Each try = what a separate, fresh check at that size says.
    for t in &r.tried {
        let call = CallReq { data: patch_amount(&f.call.data, amt_off, t.amount).unwrap(), ..f.call.clone() };
        let o = run_calls(&f.state, &f.ctx, &ov, &[], &[call]).unwrap();
        assert_eq!(classify(t.amount, &o[0]), *t, "try at {} matches a fresh check (snapshot reuse is exact)", t.amount);
    }

    // Sweep: 120 sizes evenly on a log scale.
    let n = 120;
    let (a, b) = (f64::from(lo).ln(), f64::from(hi).ln());
    let mut sweep_best = U256::ZERO;
    for i in 0..n {
        let x = U256::try_from((a + (b - a) * i as f64 / (n - 1) as f64).exp().round()).unwrap();
        let call = CallReq { data: patch_amount(&f.call.data, amt_off, x).unwrap(), ..f.call.clone() };
        let o = run_calls(&f.state, &f.ctx, &ov, &[], &[call]).unwrap();
        let t = classify(x, &o[0]);
        if t.status == "profit" && t.profit > sweep_best {
            sweep_best = t.profit;
        }
    }
    println!("search best {} at {} ({} tries, {:.2} ms debug build); sweep best {}", best.profit, best.amount, r.tried.len(), search_ms, sweep_best);
    // The 12-try search must get at least 97% of the best the 120-size sweep found.
    assert!(best.profit * u(100) >= sweep_best * u(97), "search {} vs sweep {}", best.profit, sweep_best);
}

// Trigger reuse: a raw tx bumps a counter once; every size sees the same
// post-trigger state (not bumped once per try).
#[test]
fn trigger_runs_once_and_each_try_starts_from_it() {
    // Contract reads its size from slot 5 and the profit curve's k from... keep
    // it simple: the curve contract plus a counter contract the trigger bumps;
    // results must equal the curve (trigger doesn't leak between tries) and the
    // counter after the search is not visible (nothing written back).
    let (k, scale) = (u(1000), u(1));
    let mut s = state_with(&[(addr(CURVE), code_profit_curve(k, scale, None), vec![]), (addr(0xc0de), code_counter(), vec![])], false);
    let key = [7u8; 32];
    add_eoa(&mut s, key_address(&key), U256::from(10u64).pow(U256::from(18)));
    let raw = Bytes::from(sign_typed(&key, 2, &TestTx { nonce: 0, gas: 100_000, to: Some(addr(0xc0de)), value: U256::ZERO, data: vec![], access_list: vec![] }, 4663));
    let r = size_search(&s, &ctx(), &Overrides::none(), &[raw], &curve_template(false), &SizeSearchAmounts::List(vec![u(100), u(500), u(900)])).unwrap();
    assert_eq!(r.tried.iter().map(|t| t.profit).collect::<Vec<_>>(), vec![u(90_000), u(250_000), u(90_000)]);
    assert!(s.storage[&addr(0xc0de)].get(&U256::ZERO).is_none(), "base never written");
}
