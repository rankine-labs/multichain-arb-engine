// ============================================================================
// run_calls tests (workstream C): pretend-state (overrides) works exactly
// like geth's, calls see each other's changes, nothing is written back, and
// anything we don't know makes the answer "unknown" with the exact item.
// ============================================================================
mod check_util;

use arbsim::check::run::{run_calls_opts, CheckOptions};
use arbsim::check::{run_calls, CallReq, Overrides, UnknownReason};
use arbsim::state::MissItem;
use check_util::*;
use revm::primitives::{Bytes, U256};
use serde_json::json;

const C: u64 = 0xc0de;
const USER: u64 = 0xabc;

fn read_slot(slot: u64) -> CallReq {
    CallReq { from: addr(USER), to: Some(addr(C)), data: Bytes::from(word(U256::from(slot)).to_vec()), gas: Some(100_000), value: U256::ZERO }
}

fn out_u256(o: &arbsim::check::CallOutcome) -> U256 {
    U256::from_be_slice(&o.output)
}

fn ov(j: serde_json::Value) -> Overrides {
    Overrides::from_json(&j).unwrap()
}

fn hx(v: u64) -> String {
    format!("{:#066x}", v)
}

fn base() -> arbsim::state::mem::MemState {
    // Contract C returns storage[arg]; it holds slot1 = 11 and slot2 = 22.
    state_with(&[(addr(C), code_sload_arg(), vec![(U256::from(1), U256::from(11)), (U256::from(2), U256::from(22))])], false)
}

#[test]
fn plain_reads() {
    let s = base();
    let r = run_calls(&s, &ctx(), &Overrides::none(), &[], &[read_slot(1), read_slot(2), read_slot(3)]).unwrap();
    assert_eq!(r.iter().map(out_u256).collect::<Vec<_>>(), vec![U256::from(11), U256::from(22), U256::ZERO]);
    assert!(r.iter().all(|o| o.success && o.halt.is_none()));
}

#[test]
fn state_diff_patches_only_listed_slots() {
    let s = base();
    let o = ov(json!({ format!("{:?}", addr(C)): { "stateDiff": { hx(1): hx(99) } } }));
    let r = run_calls(&s, &ctx(), &o, &[], &[read_slot(1), read_slot(2)]).unwrap();
    assert_eq!(out_u256(&r[0]), U256::from(99), "patched slot");
    assert_eq!(out_u256(&r[1]), U256::from(22), "other slot unchanged");
}

#[test]
fn state_replaces_all_storage() {
    let s = base();
    let o = ov(json!({ format!("{:?}", addr(C)): { "state": { hx(1): hx(99) } } }));
    let r = run_calls(&s, &ctx(), &o, &[], &[read_slot(1), read_slot(2)]).unwrap();
    assert_eq!(out_u256(&r[0]), U256::from(99));
    assert_eq!(out_u256(&r[1]), U256::ZERO, "unlisted slot reads zero under `state`");
}

// With `state`, unknown slots are ZERO (not missing), even on a strict view.
#[test]
fn state_override_unlisted_is_zero_not_missing() {
    let mut s = state_with(&[(addr(C), code_sload_arg(), vec![])], true);
    add_eoa(&mut s, addr(USER), U256::ZERO); // the caller must be known too
    let o = ov(json!({ format!("{:?}", addr(C)): { "state": {} } }));
    let r = run_calls(&s, &ctx(), &o, &[], &[read_slot(7)]).unwrap();
    assert_eq!(out_u256(&r[0]), U256::ZERO);
}

#[test]
fn state_and_state_diff_together_refused() {
    let j = json!({ format!("{:?}", addr(C)): { "state": {}, "stateDiff": { hx(1): hx(1) } } });
    assert!(Overrides::from_json(&j).is_err());
    let j2 = json!({ format!("{:?}", addr(C)): { "storage": {} } });
    assert!(Overrides::from_json(&j2).is_err(), "unknown override fields are refused, never ignored");
}

#[test]
fn code_override_puts_code_at_empty_address() {
    let s = base();
    let target = addr(0x7777);
    let o = ov(json!({ format!("{:?}", target): { "code": format!("0x{}", hexs(&code_sload_arg())), "stateDiff": { hx(5): hx(55) } } }));
    let call = CallReq { to: Some(target), ..read_slot(5) };
    let r = run_calls(&s, &ctx(), &o, &[], &[call]).unwrap();
    assert_eq!(out_u256(&r[0]), U256::from(55));
}

#[test]
fn balance_and_nonce_override() {
    let mut s = base();
    let who = addr(0x5151);
    add_eoa(&mut s, who, U256::from(5));
    add_contract(&mut s, addr(0xba1), code_balance_of_arg(), &[]);
    let call = CallReq { from: addr(USER), to: Some(addr(0xba1)), data: Bytes::from(word(U256::from_be_slice(who.as_slice())).to_vec()), gas: Some(100_000), value: U256::ZERO };
    let r0 = run_calls(&s, &ctx(), &Overrides::none(), &[], std::slice::from_ref(&call)).unwrap();
    assert_eq!(out_u256(&r0[0]), U256::from(5));
    let o = ov(json!({ format!("{:?}", who): { "balance": "0x1234", "nonce": "0x7" } }));
    let r1 = run_calls(&s, &ctx(), &o, &[], &[call]).unwrap();
    assert_eq!(out_u256(&r1[0]), U256::from(0x1234));
}

#[test]
fn chained_calls_see_previous_changes_and_base_untouched() {
    let s = state_with(&[(addr(C), code_counter(), vec![(U256::ZERO, U256::from(40))])], false);
    let inc = CallReq { from: addr(USER), to: Some(addr(C)), data: Bytes::new(), gas: Some(100_000), value: U256::ZERO };
    let r = run_calls(&s, &ctx(), &Overrides::none(), &[], &[inc.clone(), inc.clone(), inc.clone()]).unwrap();
    assert_eq!(r.iter().map(out_u256).collect::<Vec<_>>(), vec![U256::from(41), U256::from(42), U256::from(43)]);
    // First write to a slot costs more than later ones in the same block
    // (cold -> warm across txs is reset, but "original value" changes): gas
    // numbers must be plausible tx-level numbers (> 21000).
    assert!(r.iter().all(|o| o.gas_used > 21_000));
    // Nothing written back: a fresh run starts from 40 again.
    let again = run_calls(&s, &ctx(), &Overrides::none(), &[], &[inc]).unwrap();
    assert_eq!(out_u256(&again[0]), U256::from(41));
    assert_eq!(s.storage[&addr(C)][&U256::ZERO], U256::from(40));
}

// The same overrides object is not changed by a run either.
#[test]
fn overrides_unchanged_by_run() {
    let s = state_with(&[(addr(C), code_counter(), vec![])], false);
    let o = ov(json!({ format!("{:?}", addr(C)): { "stateDiff": { hx(0): hx(7) } } }));
    let inc = CallReq { from: addr(USER), to: Some(addr(C)), data: Bytes::new(), gas: Some(100_000), value: U256::ZERO };
    for _ in 0..3 {
        let r = run_calls(&s, &ctx(), &o, &[], std::slice::from_ref(&inc)).unwrap();
        assert_eq!(out_u256(&r[0]), U256::from(8));
    }
}

#[test]
fn missing_slot_gives_unknown_with_exact_item() {
    let mut s = base();
    s.unlisted_is_empty = false;
    add_eoa(&mut s, addr(USER), U256::ZERO); // the caller must be known too
    // Slot 2 is known; remove it -> must be reported missing, never read as 0.
    s.storage.get_mut(&addr(C)).unwrap().remove(&U256::from(2));
    let e = run_calls(&s, &ctx(), &Overrides::none(), &[], &[read_slot(1), read_slot(2)]).unwrap_err();
    assert_eq!(e.reason, UnknownReason::Miss);
    assert_eq!(e.missing, vec![MissItem::Slot(addr(C), U256::from(2))]);
    // Stop-at-first mode gives the same item.
    let e2 = run_calls_opts(&s, &ctx(), &Overrides::none(), &[], &[read_slot(2)], CheckOptions { collect_misses: false, ..Default::default() }).unwrap_err();
    assert_eq!(e2.missing, vec![MissItem::Slot(addr(C), U256::from(2))]);
}

#[test]
fn missing_account_and_code_reported() {
    let mut s = base();
    s.unlisted_is_empty = false;
    // Caller USER isn't in the state at all.
    let e = run_calls(&s, &ctx(), &Overrides::none(), &[], &[read_slot(1)]).unwrap_err();
    assert!(e.missing.contains(&MissItem::Account(addr(USER))), "{:?}", e.missing);
    // Overriding the caller's basics fully removes that miss.
    let o = ov(json!({ format!("{:?}", addr(USER)): { "balance": "0x0", "nonce": "0x0", "code": "0x" } }));
    let r = run_calls(&s, &ctx(), &o, &[], &[read_slot(1)]).unwrap();
    assert_eq!(out_u256(&r[0]), U256::from(11));
    // Code missing.
    let h = s.accounts[&addr(C)].code_hash;
    s.codes.remove(&h);
    s.accounts.get_mut(&addr(C)).unwrap().code = None;
    let e = run_calls(&s, &ctx(), &o, &[], &[read_slot(1)]).unwrap_err();
    assert_eq!(e.missing, vec![MissItem::Code(h)]);
}

// A stateDiff on a missing slot fills it; `state` makes the whole account's
// storage known.
#[test]
fn overrides_fill_misses() {
    let mut s = base();
    s.unlisted_is_empty = false;
    add_eoa(&mut s, addr(USER), U256::ZERO);
    let o = ov(json!({ format!("{:?}", addr(C)): { "stateDiff": { hx(9): hx(3) } } }));
    let r = run_calls(&s, &ctx(), &o, &[], &[read_slot(9)]).unwrap();
    assert_eq!(out_u256(&r[0]), U256::from(3));
}

// On Robinhood (ArbSys known), touching a Nitro built-in we don't imitate
// (here 0x6e ArbRetryableTx, or the ArbOS "acts" address 0x...0a4b05) =
// unknown, never a guess. ArbSys (0x64) and ArbGasInfo (0x6c) are imitated.
#[test]
fn unsupported_arbitrum_builtin_is_unknown() {
    let mut s = base();
    add_contract(&mut s, addr(0xca11), code_staticcall(0x6e), &[]);
    add_contract(&mut s, addr(0xca12), code_staticcall(0x64), &[]);
    // BALANCE of the ArbOS acts address (only its account is touched).
    let mut bal = hex("73"); // PUSH20 <addr> BALANCE STOP
    bal.extend(arbsim::arb::arbos::ARBOS_ACTS_ADDRESS.as_slice());
    bal.extend(hex("31 00"));
    add_contract(&mut s, addr(0xca13), bal, &[]);
    let mut c = ctx();
    c.l2_block_number = Some(123);
    let call = |to: u64| CallReq { from: addr(USER), to: Some(addr(to)), data: Bytes::new(), gas: Some(200_000), value: U256::ZERO };
    let e = run_calls(&s, &c, &Overrides::none(), &[], &[call(0xca11)]).unwrap_err();
    assert_eq!(e.reason, UnknownReason::UnsupportedPrecompile, "{e}");
    let e = run_calls(&s, &c, &Overrides::none(), &[], &[call(0xca13)]).unwrap_err();
    assert_eq!(e.reason, UnknownReason::UnsupportedPrecompile, "{e}");
    assert!(run_calls(&s, &c, &Overrides::none(), &[], &[call(0xca12)]).is_ok());
    // Plain-EVM mode (no ArbSys): 0x6e is just an empty account.
    assert!(run_calls(&s, &ctx(), &Overrides::none(), &[], &[call(0xca11)]).is_ok());
}

#[test]
fn too_little_gas_is_a_definite_failure() {
    let s = base();
    let call = CallReq { gas: Some(1000), ..read_slot(1) };
    let r = run_calls(&s, &ctx(), &Overrides::none(), &[], &[call]).unwrap();
    assert!(!r[0].success && r[0].halt.as_deref().unwrap_or("").starts_with("invalid"));
}

fn hexs(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

