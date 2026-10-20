// ============================================================================
// Fixture tests (workstream C): our check must give EXACTLY the node's answer
// (success, output, gas) on the saved offline cases. The -arbsys fixture was
// made with a Solidity stand-in for ArbSys, so only its output is exact and
// its gas is off by a known, constant amount (documented below).
// ============================================================================
mod check_util;

use arbsim::check::fixture::Fixture;
use arbsim::check::hexutil::to_hex;
use arbsim::check::{run_calls, CallReq, Overrides};
use check_util::fixture_path;

fn run(name: &str) -> (Fixture, arbsim::check::CallOutcome) {
    let f = Fixture::load(&fixture_path(name)).unwrap();
    let out = run_calls(&f.state, &f.ctx, &Overrides::none(), &[], std::slice::from_ref(&f.call)).unwrap();
    let o = out.into_iter().next().unwrap();
    (f, o)
}

#[test]
fn v3_v3_small_is_exact() {
    let (f, o) = run("offline-v3-v3-small");
    let c = f.compare(&o);
    assert!(c.exact(), "success {} output {} gas {} (diff {})", c.success_match, c.output_match, c.gas_match, c.gas_diff);
    assert_eq!(o.gas_used, 340_182);
}

#[test]
fn v3_v2_v3_is_exact() {
    let (f, o) = run("offline-v3-v2-v3");
    let c = f.compare(&o);
    assert!(c.exact(), "gas diff {}", c.gas_diff);
    assert_eq!(o.gas_used, 1_243_121);
}

// The fixture's expected gas came from a Solidity ArbSys STUB at 0x64 (on
// anvil); we answer arbBlockNumber() natively. Output must match exactly; the
// gas gap is a fixed property of the stub vs. our precompile charge (with the
// default ARBSYS_GAS=803 it is -1,842 gas). If workstream B changes the
// ArbSys gas charge, this difference changes by the same amount.
#[test]
fn v3_v3_small_arbsys_output_exact_gas_documented() {
    let (f, o) = run("offline-v3-v3-small-arbsys");
    let c = f.compare(&o);
    assert!(c.success_match && c.output_match);
    assert!(f.expected.gas_approx, "fixture marks its gas as approximate");
    let charge = arbsim::check::run::default_arbsys_gas() as i64;
    assert_eq!(c.gas_diff, -1842 + (charge - 803), "stub-vs-native gas gap");
}

// Same answer every time, and the state view is never changed by a check.
#[test]
fn repeatable_and_base_untouched() {
    let f = Fixture::load(&fixture_path("offline-v3-v3-small")).unwrap();
    let before_storage = f.state.storage.clone();
    let before_accounts: Vec<_> = f.state.accounts.iter().map(|(a, i)| (*a, i.balance, i.nonce, i.code_hash)).collect();
    let calls = std::slice::from_ref(&f.call);
    let a = run_calls(&f.state, &f.ctx, &Overrides::none(), &[], calls).unwrap();
    for _ in 0..5 {
        assert_eq!(run_calls(&f.state, &f.ctx, &Overrides::none(), &[], calls).unwrap(), a);
    }
    assert_eq!(f.state.storage, before_storage);
    for (addr, bal, nonce, ch) in before_accounts {
        let i = &f.state.accounts[&addr];
        assert_eq!((i.balance, i.nonce, i.code_hash), (bal, nonce, ch));
    }
}

// Chained on a real trade: A = the trade with minProfit = 1 wei. At the
// fixture's size it loses money, so A is refused (InsufficientProfit(0, 1))
// and its changes are undone; B (the original check) must then give exactly
// the same answer as on its own. (Chaining that DOES change state is proven
// in check_calls.rs with a counter contract and in check_search.rs.)
#[test]
fn chained_reverted_trade_leaves_no_trace() {
    let f = Fixture::load(&fixture_path("offline-v3-v3-small")).unwrap();
    let a = arbsim::check::cli::with_min_profit_one(&f.call.data).unwrap();
    let ta = CallReq { data: a, ..f.call.clone() };
    let alone = run_calls(&f.state, &f.ctx, &Overrides::none(), &[], std::slice::from_ref(&f.call)).unwrap();
    let both = run_calls(&f.state, &f.ctx, &Overrides::none(), &[], &[ta, f.call.clone()]).unwrap();
    assert_eq!(to_hex(&both[0].output[..4]), "0x4e88422a");
    assert!(!both[0].success);
    assert_eq!(both[1], alone[0]);
}
