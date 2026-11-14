// ============================================================================
// RUSH TAP tests (copy2/rushtap.rs inside copy2/ahead.rs).
//
// Plain English: the same tiny copy as tests/fastlane_ahead.rs (POOL's slot
// 0 is its "price"; ROUTER reaches POOL through its code, not its call
// data). We turn the tap on for POOL and check that:
//   - a predicted swap on POOL gives one "swap" line (before / after price,
//     transaction hash, block), and nothing for the untapped POOL2
//   - a swap through a ROUTER is tapped too (the predicted copy runs it)
//   - a block predicted again on a newer base is not written twice
//   - a transaction we can't run exactly gives an "unsure" line (no prices)
//   - with the tap OFF nothing is produced and FASTLANE_AHEAD_ROUTES_ONLY
//     works exactly as before; ON, a tapped pool no route uses is still run
// ============================================================================
mod check_util;

use std::collections::HashSet;
use std::sync::Arc;

use arbsim::arb::BlockCtx;
use arbsim::check::feedstore::BinMsg;
use arbsim::check::moved::FollowedPool;
use arbsim::check::ordered::{AllExact, WireFeedMsg};
use arbsim::copy2::ahead::{Ahead, AheadCfg, Confirmed, PoolSet};
use arbsim::copy2::rushtap::{Followed, RowKind, TapSet, Want};
use arbsim::copy2::PoolKind;
use arbsim::state::snap::{Fact, Snapshot};
use arbsim::state::{AccountDiff, Lookup, StateDiff, StateRead};
use check_util::*;
use revm::primitives::{keccak256, Address, B256, U256};
use revm::state::{AccountInfo, Bytecode};

// anvil / hardhat test account #0 (public test key, no funds).
const KEY: [u8; 32] = [
    0xac, 0x09, 0x74, 0xbe, 0xc3, 0x9a, 0x17, 0xe3, 0x6b, 0xa4, 0xa6, 0xb4, 0xd2, 0x38, 0xff, 0x94, 0x4b, 0xac, 0xb4,
    0x78, 0xcb, 0xed, 0x5e, 0xfc, 0xae, 0x78, 0x4d, 0x7b, 0xf4, 0xf2, 0xff, 0x80,
];

fn pool() -> Address {
    addr(0x1001)
}
fn pool2() -> Address {
    addr(0x2001)
}
fn dep() -> Address {
    addr(0x1002)
}
fn router() -> Address {
    addr(0x1003)
}
// POOL: a 32-byte call adds the word to slot 0; anything else reverts.
fn pool_code() -> Vec<u8> {
    hex("36 6020 14 6023 57 634e88422a 60e0 1b 6000 52 6000 54 6004 52 6000 19 6024 52 6044 6000 fd 5b 6000 35 6000 54 01 6000 55 00")
}
// DEP: a 32-byte call sets slot 0; an empty call returns it.
fn dep_code() -> Vec<u8> {
    hex("36 6020 14 6012 57 6000 54 6000 52 6020 6000 f3 5b 6000 35 6000 55 00")
}
// ROUTER: reads DEP, then "swaps" x * DEP on POOL (POOL is in its code).
fn router_code() -> Vec<u8> {
    let mut c = hex("6020 6000 6000 6000 73");
    c.extend_from_slice(dep().as_slice());
    c.extend(hex("5a fa 50 6000 51 6000 35 02 6000 52 6000 6000 6020 6000 6000 73"));
    c.extend_from_slice(pool().as_slice());
    c.extend(hex("5a f1 50 00"));
    c
}

fn put(s: &mut Snapshot, a: Address, code: Vec<u8>, slots: &[(u64, u64)]) {
    let bc = Bytecode::new_raw(code.clone().into());
    let info = AccountInfo { balance: U256::ZERO, nonce: 1, code_hash: keccak256(&code), code: None, ..Default::default() };
    s.apply_fact(&Fact::Basics { addr: a, info: Some(info), code: Some(bc) });
    for (k, v) in slots {
        s.apply_fact(&Fact::Slot(a, U256::from(*k), U256::from(*v)));
    }
}

/// The confirmed copy at block 10: POOL 100, POOL2 7, DEP 2, ROUTER.
fn copy10() -> Snapshot {
    let mut s = Snapshot::default();
    put(&mut s, pool(), pool_code(), &[(0, 100)]);
    put(&mut s, pool2(), pool_code(), &[(0, 7)]);
    put(&mut s, dep(), dep_code(), &[(0, 2)]);
    put(&mut s, router(), router_code(), &[]);
    s
}

fn ctx_at(seq: u64) -> BlockCtx {
    BlockCtx { l1_block_number: 500, l2_block_number: Some(seq), timestamp: 1_700_000_000 + seq, basefee: 0, coinbase: Address::ZERO, gas_limit: 1 << 50, prevrandao: B256::with_last_byte(1) }
}

fn w(v: u64) -> Vec<u8> {
    word(U256::from(v)).to_vec()
}

fn stx(nonce: u64, to: Address, data: Vec<u8>) -> Vec<u8> {
    sign_typed(&KEY, 2, &TestTx { nonce, gas: 300_000, to: Some(to), value: U256::ZERO, data, access_list: vec![] }, 4663)
}

fn hexs(b: &[u8]) -> String {
    format!("0x{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())
}

fn msg(seq: u64, txs: &[Vec<u8>]) -> Arc<BinMsg> {
    let m = WireFeedMsg { seq, ts: 1_700_000_000 + seq, l1: 500, txs: txs.iter().map(|t| hexs(t)).collect(), complete: true, why: None };
    Arc::new(BinMsg::from_wire(&m, true))
}

fn key(a: Address) -> String {
    format!("{a:#x}")
}

fn pools() -> Arc<PoolSet> {
    let fp = |a: Address| (FollowedPool { key: key(a), address: a, v4_id: None }, Address::ZERO, Address::ZERO);
    Arc::new(PoolSet::build(&[fp(pool()), fp(pool2())], HashSet::new()))
}

/// The tap set as the runtime builds it: POOL and POOL2 followed (V3-style:
/// price word at slot 0), only `tapped` listed.
fn tap_set(tapped: &[Address]) -> Arc<TapSet> {
    let f = |a: Address| Followed { key: key(a), kind: PoolKind::V3, address: a, v4_id: None, token0: addr(0xaa), token1: addr(0xbb) };
    Arc::new(TapSet::build(&[f(pool()), f(pool2())], &Want::Keys(tapped.iter().map(|a| key(*a)).collect())))
}

fn confirmed(seq: u64, snap: Snapshot, diff: StateDiff) -> Confirmed {
    Confirmed { seq, snap: Arc::new(snap), ctx: Some(ctx_at(seq)), diff: Arc::new(diff), prov: Arc::new(AllExact) }
}

fn no_moves(_: &B256) -> Option<Vec<String>> {
    None
}

fn with_price(p: u64, q: u64) -> (Snapshot, StateDiff) {
    let mut s = copy10();
    s.apply_fact(&Fact::Slot(pool(), U256::ZERO, U256::from(p)));
    s.apply_fact(&Fact::Slot(pool2(), U256::ZERO, U256::from(q)));
    let mut d = StateDiff::default();
    d.accounts.insert(pool(), AccountDiff { storage: [(U256::ZERO, U256::from(p))].into_iter().collect(), ..Default::default() });
    (s, d)
}

fn ahead_with(cfg: AheadCfg, snap: Snapshot, tap: bool) -> Ahead {
    let mut a = Ahead::new(cfg);
    a.set_pools(pools());
    if tap {
        a.set_tap(tap_set(&[pool()]));
    }
    a.on_confirmed(confirmed(10, snap, StateDiff::default()), &no_moves);
    a
}

/// Test account #0's address (the key above).
fn rows_sender() -> Address {
    "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266".parse().unwrap()
}

fn price(a: &Ahead, p: Address) -> Lookup<U256> {
    a.tip().expect("tip").view().storage(p, U256::ZERO)
}

#[test]
fn a_predicted_swap_on_a_tapped_pool_gives_one_line() {
    let mut a = ahead_with(AheadCfg::default(), copy10(), true);
    let t1 = stx(0, pool(), w(5));
    let t2 = stx(1, pool2(), w(3));
    a.on_feed_message(msg(11, &[t1.clone(), t2]));
    let rows = a.take_tap_rows();
    assert_eq!(rows.len(), 1, "POOL only: POOL2 is not tapped");
    let r = &rows[0];
    assert_eq!((r.seq, r.block, r.base_seq, r.tx_index), (11, 11, 10, 0));
    assert_eq!(r.hash, keccak256(&t1));
    assert_eq!((r.row, r.fate, r.sure), (RowKind::Swap, "ran", true));
    assert_eq!((r.before, r.after), (Some(U256::from(100u8)), Some(U256::from(105u8))));
    assert_eq!(r.target.key, key(pool()));
    let v = r.json(0);
    assert_eq!(v["dir"], "buy0");
    assert_eq!(v["tx"], format!("{:#x}", keccak256(&t1)));
    assert_eq!(v["token0"], key(addr(0xaa)));
    assert_eq!(r.from, rows_sender(), "the buyer (test key #0)");
    // Taken once.
    assert!(a.take_tap_rows().is_empty());
    // The prediction itself is unchanged by the tap.
    assert_eq!(price(&a, pool()), Lookup::Known(U256::from(105u8)));
}

#[test]
fn a_swap_through_a_router_is_tapped_too() {
    // The router names nothing of ours in its data: run because every
    // transaction is run here (live: a learned router, or the keeper).
    let mut a = ahead_with(AheadCfg { run_all: true, ..AheadCfg::default() }, copy10(), true);
    a.on_feed_message(msg(11, &[stx(0, router(), w(3))]));
    let rows = a.take_tap_rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].to, Some(router()));
    assert_eq!((rows[0].before, rows[0].after), (Some(U256::from(100u8)), Some(U256::from(106u8))));
    assert!(rows[0].sure);
}

#[test]
fn a_block_predicted_again_is_not_written_twice() {
    let mut a = ahead_with(AheadCfg::default(), copy10(), true);
    a.on_feed_message(msg(11, &[stx(0, pool(), w(5))]));
    a.on_feed_message(msg(12, &[stx(1, pool(), w(10))]));
    let rows = a.take_tap_rows();
    assert_eq!(rows.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![11, 12]);
    assert_eq!((rows[1].before, rows[1].after), (Some(U256::from(105u8)), Some(U256::from(115u8))));
    // Copy 2 confirms 11 with another price: 12 is predicted again on it.
    let (s11, d11) = with_price(200, 7);
    a.on_confirmed(confirmed(11, s11, d11), &no_moves);
    assert_eq!(price(&a, pool()), Lookup::Known(U256::from(210u8)));
    assert!(a.take_tap_rows().is_empty(), "block 12 was already written");
    assert_eq!(a.tap.as_ref().unwrap().counts.rebuilt, 1);
    // The next new block is written, on the new base.
    a.on_feed_message(msg(13, &[stx(2, pool(), w(1))]));
    let rows = a.take_tap_rows();
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0].seq, rows[0].base_seq, rows[0].before), (13, 11, Some(U256::from(210u8))));
}

#[test]
fn a_transaction_we_cannot_run_gives_an_unsure_line() {
    // DEP's value is not in our copy: the router can't be run exactly.
    let mut s = copy10();
    s.apply_fact(&Fact::Forget(dep()));
    put(&mut s, dep(), dep_code(), &[]);
    let mut a = ahead_with(AheadCfg { run_all: true, ..AheadCfg::default() }, s, true);
    a.on_feed_message(msg(11, &[stx(0, router(), w(3)), stx(1, pool(), w(2))]));
    let rows = a.take_tap_rows();
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert_eq!((rows[0].tx_index, rows[0].row, rows[0].fate, rows[0].sure), (0, RowKind::Unsure, "failed", false));
    assert_eq!((rows[0].before, rows[0].after), (None, None));
    assert!(rows[0].why.is_some());
    // POOL's value was forgotten (old rule): the next swap on it can't run.
    assert_eq!((rows[1].tx_index, rows[1].row, rows[1].sure), (1, RowKind::Unsure, false));
    // FASTLANE_AHEAD_UNSURE_KEEP (live default): POOL keeps its value, the
    // next swap runs on it, but it is never vouched for (sure = false).
    let mut s = copy10();
    s.apply_fact(&Fact::Forget(dep()));
    put(&mut s, dep(), dep_code(), &[]);
    let mut k = ahead_with(AheadCfg { run_all: true, unsure_keep: true, ..AheadCfg::default() }, s, true);
    k.on_feed_message(msg(11, &[stx(0, router(), w(3)), stx(1, pool(), w(2))]));
    let rows = k.take_tap_rows();
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert_eq!((rows[0].row, rows[0].sure), (RowKind::Unsure, false));
    assert_eq!((rows[1].row, rows[1].sure, rows[1].before, rows[1].after), (RowKind::Swap, false, Some(U256::from(100u8)), Some(U256::from(102u8))));
}

#[test]
fn off_nothing_changes_and_on_a_tapped_pool_no_route_uses_is_still_run() {
    let route = |a: &mut Ahead| a.set_route_pools(Some(Arc::new([key(pool2())].into_iter().collect())));
    // OFF: POOL is on no route: its transaction is not run (as before).
    let mut off = ahead_with(AheadCfg::default(), copy10(), false);
    route(&mut off);
    off.on_feed_message(msg(11, &[stx(0, pool(), w(5))]));
    assert_eq!(price(&off, pool()), Lookup::Missing, "not run (marked unsure, forgotten)");
    assert_eq!(off.total.txs_off_route, 1);
    assert!(off.take_tap_rows().is_empty() && off.tap.is_none());
    // ON: POOL is tapped: run, and its line written.
    let mut on = ahead_with(AheadCfg::default(), copy10(), true);
    route(&mut on);
    on.on_feed_message(msg(11, &[stx(0, pool(), w(5))]));
    assert_eq!(price(&on, pool()), Lookup::Known(U256::from(105u8)));
    assert_eq!(on.total.txs_off_route, 0);
    assert_eq!(on.tap.as_ref().unwrap().counts.off_route_run, 1);
    assert_eq!(on.take_tap_rows().len(), 1);
}
