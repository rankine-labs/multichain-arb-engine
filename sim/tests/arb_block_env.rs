// ============================================================================
// Block context / opcode / spec tests (workstream B): what NUMBER, PREVRANDAO,
// GASPRICE, BASEFEE, BLOCKHASH, BLOBBASEFEE, CHAINID... return on Nitro, the
// ArbOS-version -> EVM rules mapping, header decoding, feed seq -> L2 block.
// ============================================================================
mod arb_util;
use arb_util::*;

use arbsim::arb::{
    self, arbos, block_env, block_env_ethcall, configure_cfg, ArbConfig, HeaderInfo, NITRO_BLOCK_GAS_LIMIT,
};
use revm::{
    context::CfgEnv,
    primitives::{hardfork::SpecId, B256, U256},
};

/// Deploy a contract that returns the word one opcode pushes, call it.
fn opcode_value(db: &mut Db, ctx: &arb::BlockCtx, c: &ArbConfig, ethcall: bool, op: u8) -> Out {
    let a = addr(0x0b0b);
    put_code(db, a, returns_word(&[op]));
    run(db, ctx, c, ethcall, a, vec![], 1_000_000)
}

#[test]
fn number_is_parent_chain_block() {
    let mut db = Db::default();
    let o = opcode_value(&mut db, &arb_ctx(), &cfg(), false, 0x43);
    assert_eq!(o.word(), U256::from(1000));
}

#[test]
fn prevrandao_is_one_on_nitro_mixhash_in_plain_mode() {
    // core/evm.go L61-68: ArbOS blocks -> Random = difficulty (1).
    let mut db = Db::default();
    assert_eq!(opcode_value(&mut db, &arb_ctx(), &cfg(), false, 0x44).word(), U256::from(1));
    // Plain-EVM fixtures (anvil) keep their own prevrandao.
    let o = opcode_value(&mut db, &plain_ctx(), &cfg(), false, 0x44);
    assert_eq!(o.word(), U256::from_be_bytes([0xab; 32]));
}

#[test]
fn basefee_and_gasprice_mined_vs_ethcall() {
    let mut db = Db::default();
    // Mined tx: BASEFEE = block base fee; GASPRICE = base fee (tips not collected).
    assert_eq!(opcode_value(&mut db, &arb_ctx(), &cfg(), false, 0x48).word(), U256::from(7));
    assert_eq!(opcode_value(&mut db, &arb_ctx(), &cfg(), false, 0x3a).word(), U256::from(7));
    // eth_call with gas price 0: BASEFEE lowered to 0 -> both read 0.
    assert_eq!(opcode_value(&mut db, &arb_ctx(), &cfg(), true, 0x48).word(), U256::ZERO);
    assert_eq!(opcode_value(&mut db, &arb_ctx(), &cfg(), true, 0x3a).word(), U256::ZERO);
}

#[test]
fn gasprice_with_tips_collected_is_tx_price() {
    let mut db = Db::default();
    let c = ArbConfig { collect_tips: true, arbos_version: 61, ..cfg() };
    // Our test tx has gas_price 0 -> revm effective price 0.
    assert_eq!(opcode_value(&mut db, &arb_ctx(), &c, false, 0x3a).word(), U256::ZERO);
}

#[test]
fn chainid_timestamp_coinbase_gaslimit() {
    let mut db = Db::default();
    let ctx = arb_ctx();
    assert_eq!(opcode_value(&mut db, &ctx, &cfg(), false, 0x46).word(), U256::from(4663));
    assert_eq!(opcode_value(&mut db, &ctx, &cfg(), false, 0x42).word(), U256::from(1_760_000_000u64));
    assert_eq!(opcode_value(&mut db, &ctx, &cfg(), false, 0x41).word(), U256::from(0xc0ffeeu64));
    assert_eq!(opcode_value(&mut db, &ctx, &cfg(), false, 0x45).word(), U256::from(NITRO_BLOCK_GAS_LIMIT));
}

#[test]
fn blobbasefee_fails_on_nitro() {
    // core/vm/eips.go L293-296: error -> frame fails, all its gas used.
    let mut db = Db::default();
    let o = opcode_value(&mut db, &arb_ctx(), &cfg(), false, 0x4a);
    assert_eq!(o.status, "halt");
    assert_eq!(o.gas, 1_000_000);
}

#[test]
fn blockhash_reads_parent_chain_hashes_from_arbos_state() {
    let mut db = Db::default();
    let h = U256::from_be_bytes([0x42; 32]);
    db.insert_account_storage(arbos::ARBOS_STATE_ADDRESS, arbos::l1_block_hash_slot(999), h).unwrap();
    let a = addr(0x0c0c);
    // BLOCKHASH(arg) where arg = PUSH2 value
    let call = |db: &mut Db, n: u16| {
        put_code(db, a, returns_word(&[0x61, (n >> 8) as u8, n as u8, 0x40]));
        run(db, &arb_ctx(), &cfg(), false, a, vec![], 1_000_000)
    };
    assert_eq!(call(&mut db, 999).word(), h); // NUMBER-1 in range
    assert_eq!(call(&mut db, 1000).word(), U256::ZERO); // current: 0
    assert_eq!(call(&mut db, 743).word(), U256::ZERO); // below NUMBER-256: 0
    assert_eq!(call(&mut db, 744).word(), U256::ZERO); // in range, slot empty in this DB -> its value (0)
}

#[test]
fn spec_follows_arbos_version() {
    let s = |v| ArbConfig { arbos_version: v, ..cfg() }.spec();
    assert_eq!(s(11), SpecId::SHANGHAI);
    assert_eq!(s(20), SpecId::CANCUN);
    assert_eq!(s(32), SpecId::CANCUN);
    assert_eq!(s(40), SpecId::PRAGUE);
    assert_eq!(s(51), SpecId::OSAKA);
    assert_eq!(s(61), SpecId::OSAKA);
}

#[test]
fn clz_only_from_arbos_50() {
    // CLZ (0x1e) is an Osaka opcode: present at ArbOS 51, invalid at 32.
    let mut db = Db::default();
    let ops = [0x60, 0x01, 0x1e]; // CLZ(1) = 255
    let a = addr(0x0d0d);
    put_code(&mut db, a, returns_word(&ops));
    let o = run(&db, &arb_ctx(), &cfg(), false, a, vec![], 100_000);
    assert_eq!(o.word(), U256::from(255));
    let old = ArbConfig { arbos_version: 32, ..cfg() };
    assert_eq!(run(&db, &arb_ctx(), &old, false, a, vec![], 100_000).status, "halt");
}

#[test]
fn p256verify_present_with_version_gas() {
    // P256VERIFY at 0x100: Nitro has it from ArbOS 30 (3,450 gas) and charges
    // 6,900 from ArbOS 50. Invalid input -> empty output, gas still charged.
    let mut db = Db::default();
    let f = addr(0x0e0e);
    put_code(&mut db, f, forwarder(addr(0x100)));
    let input = vec![0u8; 160];
    let new = run(&db, &arb_ctx(), &cfg(), false, f, input.clone(), 1_000_000);
    let old = run(&db, &arb_ctx(), &ArbConfig { arbos_version: 32, ..cfg() }, false, f, input, 1_000_000);
    assert_eq!(new.status, "ok");
    assert_eq!(new.gas - old.gas, 6900 - 3450);
}

#[test]
fn no_osaka_tx_gas_cap_on_nitro() {
    // Nitro skips EIP-7825 (16.7M per-tx cap) -> a 30M-gas eth_call is fine.
    let mut db = Db::default();
    let a = addr(0x0f0f);
    put_code(&mut db, a, vec![0x00]);
    let o = run(&db, &arb_ctx(), &cfg(), true, a, vec![], 30_000_000);
    assert_eq!(o.status, "ok");
    let mut c = CfgEnv::default();
    configure_cfg(&mut c);
    assert_eq!(c.chain_id, 4663);
    assert_eq!(c.tx_gas_limit_cap, Some(u64::MAX));
}

#[test]
fn block_env_mapping() {
    let ctx = arb_ctx();
    let b = block_env(&ctx);
    assert_eq!(b.number, U256::from(1000));
    assert_eq!(b.basefee, 7);
    assert_eq!(b.prevrandao, Some(B256::with_last_byte(1)));
    assert_eq!(b.difficulty, U256::from(1));
    assert_eq!(block_env_ethcall(&ctx).basefee, 0);
    assert_eq!(block_env(&plain_ctx()).prevrandao, Some(B256::repeat_byte(0xab)));
}

#[test]
fn header_info_from_mix_hash() {
    // mixHash = sendCount(8) | l1BlockNumber(8) | arbosVersion(8) | flags
    let mut m = [0u8; 32];
    m[7] = 5;
    m[8..16].copy_from_slice(&23_456_789u64.to_be_bytes());
    m[16..24].copy_from_slice(&51u64.to_be_bytes());
    let h = HeaderInfo::from_mix_hash(B256::from(m));
    assert_eq!((h.send_count, h.l1_block_number, h.arbos_version, h.collect_tips), (5, 23_456_789, 51, false));
    m[25] = 1;
    assert!(HeaderInfo::from_mix_hash(B256::from(m)).collect_tips);
    assert_eq!(HeaderInfo::from_mix_hash(B256::from(m)).config().spec(), SpecId::OSAKA);
}

#[test]
fn feed_sequence_to_l2_block() {
    assert_eq!(arb::l2_block_for_seq(1_234, arb::ROBINHOOD_GENESIS_BLOCK_NUM), 1_234);
    assert_eq!(arb::l2_block_for_seq(10, 22_207_817), 22_207_827); // Arbitrum One style
    assert_eq!(arb::seq_for_l2_block(22_207_827, 22_207_817), Some(10));
    assert_eq!(arb::seq_for_l2_block(5, 10), None);
}
