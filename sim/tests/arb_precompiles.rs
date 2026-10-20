// ============================================================================
// Nitro precompile tests (workstream B): answers, EXACT gas, warmness,
// "unsupported" reporting. Gas numbers come from Nitro source, see
// src/arb/precompiles.rs header and sim/ARBITRUM_NOTES.md.
// ============================================================================
mod arb_util;
use arb_util::*;

use arbsim::arb::{
    self, arbos, precompiles::{ARB_RETRYABLE_TX, NODE_INTERFACE}, ArbPrecompiles, ARBGASINFO_ONE_READ_GAS, ARBSYS, ARBSYS_GAS_DEFAULT,
    ARB_GAS_INFO, UNSUPPORTED_PRECOMPILE_PREFIX,
};
use revm::{handler::PrecompileProvider, primitives::U256};

const ARB_BLOCK_NUMBER: [u8; 4] = [0xa3, 0xb1, 0xb3, 0x1d];
const ARB_CHAIN_ID: [u8; 4] = [0xd1, 0x27, 0xf5, 0x4a];
const ARB_OS_VERSION: [u8; 4] = [0x05, 0x10, 0x38, 0xf2];
const IS_TOP_LEVEL: [u8; 4] = [0x08, 0xbd, 0x62, 0x4c];
const STORAGE_GAS: [u8; 4] = [0xa9, 0x45, 0x97, 0xff];
const WAS_ALIASED: [u8; 4] = [0x17, 0x5a, 0x26, 0x0b];
const CALLERS_NO_ALIAS: [u8; 4] = [0xd7, 0x45, 0x23, 0xb3];
const MAP_ALIAS: [u8; 4] = [0x4d, 0xbb, 0xd5, 0x06];
const ARB_BLOCK_HASH: [u8; 4] = [0x2b, 0x40, 0x7a, 0x82];
const GET_MIN_GAS_PRICE: [u8; 4] = [0xf9, 0x18, 0x37, 0x9a];
const GET_CURRENT_TX_L1_FEES: [u8; 4] = [0xc6, 0xf7, 0xde, 0x0e];

#[test]
fn arbsys_gas_constant_is_nitro_derivation() {
    // 800 (open ArbOS state) + 0 args + 3 (one result word).
    assert_eq!(ARBSYS_GAS_DEFAULT, 803);
    assert_eq!(arb::ARBSYS_VIEW_GAS, 803);
    // ArbGasInfo one-slot getter: open (800) + one read (800) + 3.
    assert_eq!(ARBGASINFO_ONE_READ_GAS, 1603);
}

#[test]
fn arb_block_number_answer_and_exact_gas_top_level() {
    let db = Db::default();
    let data = sel(ARB_BLOCK_NUMBER);
    let o = run(&db, &arb_ctx(), &cfg(), false, ARBSYS, data.clone(), 100_000);
    assert_eq!(o.status, "ok");
    assert_eq!(o.word(), U256::from(123_456_789u64));
    assert_eq!(o.gas, intrinsic(&data) + 803);
}

#[test]
fn arbsys_view_methods() {
    let db = Db::default();
    let c = arb_ctx();
    let w = |s: [u8; 4]| run(&db, &c, &cfg(), false, ARBSYS, sel(s), 100_000);
    let o = w(ARB_CHAIN_ID);
    assert_eq!((o.status, o.word()), ("ok", U256::from(4663)));
    assert_eq!(o.gas, intrinsic(&ARB_CHAIN_ID) + 803);
    // arbOSVersion() = 55 + ArbOS version (ArbSys.go L67-70).
    assert_eq!(w(ARB_OS_VERSION).word(), U256::from(55 + 51));
    assert_eq!(w(STORAGE_GAS).word(), U256::ZERO);
    assert_eq!(w(WAS_ALIASED).word(), U256::ZERO);
    // Top-level tx straight to ArbSys: Nitro depth 1 <= 2 -> true.
    assert_eq!(w(IS_TOP_LEVEL).word(), U256::from(1));
}

#[test]
fn is_top_level_call_depth_rule() {
    // Nitro: evm.Depth() <= 2 inside the precompile (ArbSys.go L78-80).
    let mut db = Db::default();
    let a = addr(0xaaaa);
    let b = addr(0xbbbb);
    put_code(&mut db, a, forwarder(ARBSYS)); // a -> ArbSys        (depth 2: true)
    put_code(&mut db, b, forwarder(a)); //      b -> a -> ArbSys   (depth 3: false)
    assert_eq!(run(&db, &arb_ctx(), &cfg(), false, a, sel(IS_TOP_LEVEL), 1_000_000).word(), U256::from(1));
    assert_eq!(run(&db, &arb_ctx(), &cfg(), false, b, sel(IS_TOP_LEVEL), 1_000_000).word(), U256::ZERO);
}

#[test]
fn map_l1_alias_is_pure_and_exact() {
    // mapL1SenderContractAddressToL2Alias is pure: no ArbOS open; gas = 2 arg words * 3 + 1 result word * 3 = 9.
    let db = Db::default();
    let mut data = sel(MAP_ALIAS);
    let mut a = [0u8; 32];
    a[12..].copy_from_slice(&[0xff; 20]); // 0xfff...f + 0x1111..1111 wraps
    data.extend_from_slice(&a);
    data.extend_from_slice(&[0u8; 32]);
    let o = run(&db, &arb_ctx(), &cfg(), false, ARBSYS, data.clone(), 100_000);
    assert_eq!(o.status, "ok");
    let expect = U256::from_str_radix("1111000000000000000000000000000000001110", 16).unwrap();
    assert_eq!(o.word(), expect);
    assert_eq!(o.gas, intrinsic(&data) + 9);
}

#[test]
fn arb_block_hash_out_of_range_is_solidity_error() {
    // Asking for the current (or a future) block -> InvalidBlockNumber(req, cur),
    // gas = open 800 + 1 arg word 3 + 2 error words 6... error data = 4+64 bytes = 3 words -> 9.
    let db = Db::default();
    let mut data = sel(ARB_BLOCK_HASH);
    data.extend_from_slice(&U256::from(123_456_789u64).to_be_bytes::<32>());
    let o = run(&db, &arb_ctx(), &cfg(), false, ARBSYS, data.clone(), 100_000);
    assert_eq!(o.status, "revert");
    assert_eq!(&o.output[..4], &[0xd5, 0xdc, 0x64, 0x2d]);
    assert_eq!(o.output.len(), 68);
    assert_eq!(o.gas, intrinsic(&data) + 800 + 3 + 9);
}

#[test]
fn arb_block_hash_of_recent_block_is_unsupported() {
    let db = Db::default();
    let mut data = sel(ARB_BLOCK_HASH);
    data.extend_from_slice(&U256::from(123_456_780u64).to_be_bytes::<32>());
    let o = run(&db, &arb_ctx(), &cfg(), false, ARBSYS, data, 100_000);
    assert_eq!(o.status, "error");
    assert!(o.error.starts_with(UNSUPPORTED_PRECOMPILE_PREFIX), "{}", o.error);
}

#[test]
fn arb_block_number_out_of_gas_burns_everything() {
    let db = Db::default();
    let data = sel(ARB_BLOCK_NUMBER);
    let limit = intrinsic(&data) + 802;
    let o = run(&db, &arb_ctx(), &cfg(), false, ARBSYS, data, limit);
    assert_eq!(o.status, "halt");
    assert_eq!(o.gas, limit);
}

#[test]
fn unknown_selector_and_short_input_revert_with_all_gas() {
    // precompile.go L743-751: revert, all supplied gas consumed.
    let db = Db::default();
    for data in [vec![0xde, 0xad, 0xbe, 0xef], vec![0x01]] {
        let o = run(&db, &arb_ctx(), &cfg(), false, ARBSYS, data.clone(), 100_000);
        assert_eq!(o.status, "revert");
        assert_eq!(o.gas, 100_000);
        assert!(o.unsupported.is_none());
    }
}

#[test]
fn view_method_via_delegatecall_reverts() {
    // precompile.go L754-756: view method not acting as the precompile -> revert.
    // DELEGATECALL(gas, 0x64, 0, 4, 0, 32) with selector in memory.
    let mut db = Db::default();
    let c = addr(0xdddd);
    let mut code = vec![0x63];
    code.extend(ARB_BLOCK_NUMBER);
    code.extend([0x60, 0xe0, 0x1b, 0x5f, 0x52]); // sel << 224; MSTORE(0)
    code.extend([0x60, 0x20, 0x5f, 0x60, 0x04, 0x5f, 0x60, 0x64, 0x5a, 0xf4]); // DELEGATECALL
    code.extend([0x5f, 0x52, 0x60, 0x20, 0x5f, 0xf3]); // return success flag
    put_code(&mut db, c, code);
    let o = run(&db, &arb_ctx(), &cfg(), false, c, vec![], 1_000_000);
    assert_eq!(o.status, "ok");
    assert_eq!(o.word(), U256::ZERO, "delegatecall into ArbSys view method must fail");
}

#[test]
fn precompiles_are_warm_exact_call_cost() {
    // Same forwarder bytecode calling 0x64:
    //   Arbitrum mode: warm precompile, 100 + 803
    //   plain mode   : cold EMPTY account, 2600 + 0
    // Every other opcode is identical except RETURNDATACOPY copying the
    // 32-byte answer (+3, memory already 32 bytes) => exactly -1694.
    let mut db = Db::default();
    let f = addr(0xf0f0);
    put_code(&mut db, f, forwarder(ARBSYS));
    let data = sel(ARB_BLOCK_NUMBER);
    let a = run(&db, &arb_ctx(), &cfg(), false, f, data.clone(), 1_000_000);
    let p = run(&db, &plain_ctx(), &cfg(), false, f, data, 1_000_000);
    assert_eq!(a.status, "ok");
    assert_eq!(a.word(), U256::from(123_456_789u64));
    assert_eq!(p.status, "ok");
    assert!(p.output.is_empty(), "plain mode: 0x64 is an empty account");
    assert_eq!(a.gas as i64 - p.gas as i64, (100 + 803 + 3) - 2600);
}

#[test]
fn all_nitro_precompiles_warm_but_only_imitated_ones_contained() {
    let p = ArbPrecompiles::new(Some(U256::from(1)), 803);
    type Ctx = revm::Context;
    let warm = <ArbPrecompiles as PrecompileProvider<Ctx>>::warm_addresses(&p);
    for a in arb::nitro_precompile_addresses(51) {
        assert!(warm.contains(&a), "{a} must start warm (Nitro access list)");
    }
    assert!(warm.contains(&addr(0x100)), "P256VERIFY is a precompile on Nitro");
    let has = |a| <ArbPrecompiles as PrecompileProvider<Ctx>>::contains(&p, &a);
    assert!(has(ARBSYS) && has(ARB_GAS_INFO) && has(addr(1)));
    assert!(!has(ARB_RETRYABLE_TX) && !has(NODE_INTERFACE));
    // Plain mode: no Nitro precompiles at all.
    let q = ArbPrecompiles::new(None, 803);
    assert!(!<ArbPrecompiles as PrecompileProvider<Ctx>>::warm_addresses(&q).contains(&ARBSYS));
    // Check-engine list = builtins minus contains(): ArbSys/ArbGasInfo excluded.
    let unsupported: Vec<_> = arb::arbitrum_builtin_addresses().into_iter().filter(|a| !has(*a)).collect();
    assert!(unsupported.contains(&ARB_RETRYABLE_TX) && unsupported.contains(&NODE_INTERFACE));
    assert!(!unsupported.contains(&ARBSYS) && !unsupported.contains(&ARB_GAS_INFO));
}

#[test]
fn unsupported_precompile_is_reported_never_guessed() {
    let mut db = Db::default();
    let f = addr(0xf1f1);
    put_code(&mut db, f, forwarder(ARB_RETRYABLE_TX));
    // Nested call into a Nitro precompile we don't imitate.
    let o = run(&db, &arb_ctx(), &cfg(), false, f, vec![0x12, 0x34, 0x56, 0x78], 1_000_000);
    assert_eq!(o.status, "error");
    assert!(o.error.starts_with(UNSUPPORTED_PRECOMPILE_PREFIX), "{}", o.error);
    let u = o.unsupported.expect("flag set");
    assert!(u.contains("0x000000000000000000000000000000000000006E") || u.to_lowercase().contains("6e"), "{u}");
    // An ArbSys method we don't imitate (needs Nitro's own call stack).
    let o = run(&db, &arb_ctx(), &cfg(), false, ARBSYS, sel(CALLERS_NO_ALIAS), 100_000);
    assert_eq!(o.status, "error");
    assert!(o.unsupported.unwrap().contains("selector 0xd74523b3"));
    // ArbGasInfo method we don't imitate.
    let o = run(&db, &arb_ctx(), &cfg(), false, ARB_GAS_INFO, sel(GET_CURRENT_TX_L1_FEES), 100_000);
    assert_eq!(o.status, "error");
    // Plain-EVM mode: 0x6e is just an empty account (call succeeds, no data).
    let o = run(&db, &plain_ctx(), &cfg(), false, f, vec![0x12, 0x34, 0x56, 0x78], 1_000_000);
    assert_eq!(o.status, "ok");
    assert!(o.unsupported.is_none());
}

#[test]
fn stylus_contract_is_unsupported() {
    let mut db = Db::default();
    let s = addr(0x5757);
    put_code(&mut db, s, vec![0xEF, 0xF0, 0x00, 0x01, 0x02, 0x03]); // Stylus program prefix
    let f = addr(0xf2f2);
    put_code(&mut db, f, forwarder(s));
    let o = run(&db, &arb_ctx(), &cfg(), false, f, vec![1, 2, 3, 4], 1_000_000);
    assert_eq!(o.status, "error");
    assert!(o.unsupported.unwrap().contains("Stylus"));
    assert!(arb::is_stylus_code(&[0xEF, 0xF0, 0x02, 0x00], 60));
    assert!(!arb::is_stylus_code(&[0xEF, 0xF0, 0x02, 0x00], 51));
    assert!(!arb::is_stylus_code(&[0xEF, 0xF0, 0x00, 0x00], 20));
}

#[test]
fn arbgasinfo_getter_reads_arbos_state_exact_gas() {
    let mut db = Db::default();
    // L2 pricing (subspace 1) offset 3 = minBaseFeeWei.
    let slot = arbos::arbos_slot(&[arbos::L2_PRICING_SUBSPACE], arbos::l2::MIN_BASE_FEE_WEI);
    db.insert_account_storage(arbos::ARBOS_STATE_ADDRESS, slot, U256::from(10_000_000u64)).unwrap();
    let data = sel(GET_MIN_GAS_PRICE);
    let o = run(&db, &arb_ctx(), &cfg(), false, ARB_GAS_INFO, data.clone(), 100_000);
    assert_eq!(o.status, "ok");
    assert_eq!(o.word(), U256::from(10_000_000u64));
    assert_eq!(o.gas, intrinsic(&data) + 1603);
}

#[test]
fn arbos_slot_vectors() {
    // Cross-checked with an independent ethers.js implementation of Nitro's
    // mapAddress (storage.go L119-126). The version slot is the well-known
    // eth_getStorageAt(0xA4B05FFF..., <slot>) used to read the ArbOS version.
    let h = |s: &str| U256::from_str_radix(s, 16).unwrap();
    assert_eq!(arbos::version_slot(), h("15fed0451499512d95f3ec5a41c878b9de55f21878b5b4e190d4667ec709b400"));
    assert_eq!(arbos::arbos_slot(&[0], 7), h("a9f6f085d78d1d37c5819e5c16c9e03198bd14e08cd1f6f8191bc6207b9e9707"));
    assert_eq!(arbos::arbos_slot(&[1], 2), h("e54de2a4cdacc0a0059d2b6e16348103df8c4aff409c31e40ec73d11926c8202"));
    assert_eq!(arbos::l1_block_number_slot(), h("3c79da47f96b0f39664f73c0a1f350580be90742947dddfa21ba64d578dfe600"));
    assert_eq!(arbos::l1_block_hash_slot(1000), h("3c79da47f96b0f39664f73c0a1f350580be90742947dddfa21ba64d578dfe6e9"));
}
