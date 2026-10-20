// ============================================================================
// Offline fixture tests with Nitro rules (workstream B).
//
// Fixtures in tests/fixtures come from a local anvil chain (Cancun). The
// non-arbsys ones must be EXACT under our Nitro EVM (spec Osaka for ArbOS 51
// makes no difference for these contracts). The "-arbsys" one ran against a
// Solidity STUB at 0x64; its expected gas differs from Nitro's native
// precompile by a fixed, fully explained amount:
//
//   stub (anvil):  STATICCALL to a cold ordinary contract   2600
//                  + stub bytecode execution                  145
//   native Nitro:  STATICCALL to a warm precompile             100
//                  + ArbSys.arbBlockNumber() charge            803
//   => arbsim - anvil = 903 - 2745 = -1842 (arbsim lower), output identical.
// `stub_offset_breakdown` proves it: replaying with the real stub bytecode at
// 0x64 in plain mode reproduces anvil's number exactly.
// ============================================================================
mod arb_util;
use arb_util::*;

use arbsim::arb::{evm::build_evm, ArbConfig, ARBSYS, ARBSYS_GAS_DEFAULT};
use arbsim::check::fixture::Fixture;
use revm::{
    context::TxEnv,
    context_interface::result::ExecutionResult,
    primitives::{Bytes, TxKind, U256},
    state::AccountInfo,
    ExecuteEvm,
};

const FIX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

/// ArbSys stub runtime used by make-offline.js (solc 0.8.26, optimizer 200, cancun).
const STUB: &str = "6080604052348015600e575f80fd5b50600436106026575f3560e01c8063a3b1b31d14602a575b5f80fd5b63075bcd1560405190815260200160405180910390f3fea2646970667358221220bcd83a0ecc7a7eef3169ad9b75aced73ca5148ea5986bff2d9f177bdff000d1964736f6c634300081a0033";

fn hex(s: &str) -> Vec<u8> {
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
}

fn load_db(f: &Fixture) -> Db {
    let mut db = Db::default();
    for (a, info) in &f.state.accounts {
        let mut i: AccountInfo = info.clone();
        if i.code.is_none() {
            i.code = f.state.codes.get(&i.code_hash).cloned();
        }
        db.insert_account_info(*a, i);
    }
    for (a, slots) in &f.state.storage {
        for (k, v) in slots {
            db.insert_account_storage(*a, *k, *v).unwrap();
        }
    }
    db
}

/// (success, output, gas) of the fixture call with Nitro rules.
fn run_fixture(f: &Fixture, db: Db, cfg: &ArbConfig, ctx: &arbsim::arb::BlockCtx) -> (bool, Bytes, u64) {
    let mut evm = build_evm(db, ctx, cfg, ARBSYS_GAS_DEFAULT, false);
    let tx = TxEnv {
        tx_type: 0,
        caller: f.call.from,
        gas_limit: f.call.gas.unwrap(),
        gas_price: 0,
        kind: TxKind::Call(f.call.to.unwrap()),
        value: f.call.value,
        data: f.call.data.clone(),
        chain_id: Some(4663),
        ..Default::default()
    };
    match evm.transact_one(tx).unwrap() {
        ExecutionResult::Success { gas, output, .. } => (true, output.into_data(), gas.tx_gas_used()),
        ExecutionResult::Revert { gas, output, .. } => (false, output, gas.tx_gas_used()),
        ExecutionResult::Halt { gas, .. } => (false, Bytes::new(), gas.tx_gas_used()),
    }
}

fn load(name: &str) -> Fixture {
    Fixture::load(&format!("{FIX}/{name}.json")).unwrap()
}

fn out_hex(b: &Bytes) -> String {
    format!("0x{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())
}

#[test]
fn plain_fixtures_exact_under_nitro_rules_all_specs() {
    for name in ["offline-v3-v3-small", "offline-v3-v2-v3"] {
        let f = load(name);
        for v in [32u64, 40, 51, 61] {
            let cfg = ArbConfig { arbos_version: v, ..cfg() };
            let (ok, out, gas) = run_fixture(&f, load_db(&f), &cfg, &f.ctx);
            assert_eq!(ok, f.expected.success, "{name} arbos {v}");
            assert_eq!(out_hex(&out), f.expected.output, "{name} arbos {v}");
            assert_eq!(gas, f.expected.gas_used, "{name} arbos {v}: gas must be exact");
        }
    }
}

#[test]
fn arbsys_fixture_output_exact_gas_offset_explained() {
    let f = load("offline-v3-v3-small-arbsys");
    let (ok, out, gas) = run_fixture(&f, load_db(&f), &cfg(), &f.ctx);
    assert_eq!(ok, f.expected.success);
    assert_eq!(out_hex(&out), f.expected.output);
    assert_eq!(gas as i64 - f.expected.gas_used as i64, -1842);
}

// Re-run the arbsys fixture in PLAIN mode with the real stub bytecode at 0x64:
// must reproduce anvil's number exactly. The difference to Nitro mode is then
// fully accounted for by the 0x64 frame alone.
#[test]
fn stub_offset_breakdown() {
    let f = load("offline-v3-v3-small-arbsys");
    let mut db = load_db(&f);
    put_code(&mut db, ARBSYS, hex(STUB));
    let plain = arbsim::arb::BlockCtx { l2_block_number: None, ..f.ctx.clone() };
    let (ok, out, gas_stub) = run_fixture(&f, db, &cfg(), &plain);
    assert_eq!(ok, f.expected.success);
    assert_eq!(out_hex(&out), f.expected.output);
    assert_eq!(gas_stub, f.expected.gas_used, "stub replay reproduces anvil exactly");
    let (_, _, gas_native) = run_fixture(&f, load_db(&f), &cfg(), &f.ctx);
    // Stub: cold 2600 + stub code; native: warm 100 + 803.
    let stub_exec = gas_stub as i64 - gas_native as i64 + 100 + 803 - 2600;
    assert_eq!(stub_exec, 145, "stub bytecode execution gas (incl. its memory)");
    assert_eq!(gas_native as i64 - gas_stub as i64, (100 + 803) - (2600 + 145));
}

#[test]
fn arbsys_fixture_l2_block_used_for_deadline() {
    // The fixture's maxBlock = L2_BLOCK + 5: if we returned NUMBER (60)
    // instead, the trade would not expire either; so check the OTHER way:
    // pretend the L2 block is beyond maxBlock -> Expired() (0x203d82d8).
    let f = load("offline-v3-v3-small-arbsys");
    let ctx = arbsim::arb::BlockCtx { l2_block_number: Some(123_456_789 + 6), ..f.ctx.clone() };
    let (ok, out, _) = run_fixture(&f, load_db(&f), &cfg(), &ctx);
    assert!(!ok);
    assert_eq!(&out[..4], &revm::primitives::keccak256("Expired()")[..4]);
    let _ = U256::ZERO;
}
