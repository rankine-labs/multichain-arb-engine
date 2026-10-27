// ============================================================================
// FAST LANE A tests: the predicted copy (copy2/ahead.rs).
//
// Plain English: we build a small copy (tiny hand-written contracts, and
// one REAL Uniswap V2 pair from the offline fixtures), hand the predicted
// copy feed messages with signed transactions (test keys, no funds), and
// check that:
//   - its prediction equals what the chain's own replay gives (real V2
//     bytecode: copy 1's exact replay, feed/replay.rs, is the referee)
//   - rebasing on a newly confirmed version drops the old blocks and
//     re-applies the later messages on the new state
//   - agreement counts agree / disagree (missed, phantom, value) / unsure,
//     and a router the cheap filter skipped is learned once the confirmed
//     reports say it moved our pool
//   - a transaction that needs a value we don't hold marks ONLY the pools
//     it touches unsure (their values forgotten: Missing, never zero)
//   - memory is bounded (max blocks; a copy too far behind stops it)
//   - FASTLANE=off starts nothing
// ============================================================================
mod check_util;

use std::collections::HashSet;
use std::sync::Arc;

use arbsim::arb::BlockCtx;
use arbsim::check::feedstore::BinMsg;
use arbsim::check::moved::FollowedPool;
use arbsim::check::ordered::{AllExact, WireFeedMsg};
use arbsim::copy2::ahead::{Ahead, AheadCfg, Confirmed, PoolSet};
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

// ---------------------------------------------------------------------------
// Tiny contracts (same as tests/trig_first.rs):
//   POOL    32-byte call adds the word to slot 0 (its "price"); else reverts
//   DEP     32-byte call sets slot 0; empty call returns it
//   ROUTER  reads DEP, then "swaps" x * DEP on POOL (POOL is in its CODE,
//           not in the call data: the cheap filter can't see it)
// ---------------------------------------------------------------------------
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
fn pool_code() -> Vec<u8> {
    hex("36 6020 14 6023 57 634e88422a 60e0 1b 6000 52 6000 54 6004 52 6000 19 6024 52 6044 6000 fd 5b 6000 35 6000 54 01 6000 55 00")
}
fn dep_code() -> Vec<u8> {
    hex("36 6020 14 6012 57 6000 54 6000 52 6020 6000 f3 5b 6000 35 6000 55 00")
}
fn router_code() -> Vec<u8> {
    let mut c = hex("6020 6000 6000 6000 73");
    c.extend_from_slice(dep().as_slice());
    c.extend(hex("5a fa 50 6000 51 6000 35 02 6000 52 6000 6000 6020 6000 6000 73"));
    c.extend_from_slice(pool().as_slice());
    c.extend(hex("5a f1 50 00"));
    c
}

/// Put a contract into a snapshot (strict: unlisted slots stay Missing).
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

/// Our pools: POOL and POOL2 (contract pools, no coins).
fn pools() -> Arc<PoolSet> {
    let fp = |a: Address| (FollowedPool { key: key(a), address: a, v4_id: None }, Address::ZERO, Address::ZERO);
    Arc::new(PoolSet::build(&[fp(pool()), fp(pool2())], HashSet::new()))
}

/// A confirmed version at `seq` = `snap`, with `diff` = what that block changed.
fn confirmed(seq: u64, snap: Snapshot, diff: StateDiff) -> Confirmed {
    Confirmed { seq, snap: Arc::new(snap), ctx: Some(ctx_at(seq)), diff: Arc::new(diff), prov: Arc::new(AllExact) }
}

/// copy10 with POOL's price set (and the diff saying so).
fn with_price(p: u64, q: u64) -> (Snapshot, StateDiff) {
    let mut s = copy10();
    s.apply_fact(&Fact::Slot(pool(), U256::ZERO, U256::from(p)));
    s.apply_fact(&Fact::Slot(pool2(), U256::ZERO, U256::from(q)));
    let mut d = StateDiff::default();
    d.accounts.insert(pool(), AccountDiff { storage: [(U256::ZERO, U256::from(p))].into_iter().collect(), ..Default::default() });
    (s, d)
}

fn no_moves(_: &B256) -> Option<Vec<String>> {
    None
}

fn ahead(max_blocks: usize) -> Ahead {
    let mut a = Ahead::new(AheadCfg { max_blocks, ..AheadCfg::default() });
    a.set_pools(pools());
    a.on_confirmed(confirmed(10, copy10(), StateDiff::default()), &no_moves);
    a
}

fn price(a: &Ahead, p: Address) -> Lookup<U256> {
    a.tip().expect("tip").view().storage(p, U256::ZERO)
}

fn known(v: u64) -> Lookup<U256> {
    Lookup::Known(U256::from(v))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn feed_messages_move_the_predicted_copy_and_name_the_changed_pools() {
    let mut a = ahead(32);
    // Block 11: a swap of 5 on POOL. Block 12: nothing of ours.
    a.on_feed_message(msg(11, &[stx(0, pool(), w(5))]));
    let t = a.tip().expect("tip after 11");
    assert_eq!((t.seq, t.block, t.base_seq), (11, 11, 10));
    assert_eq!(t.changed_pools, vec![key(pool())]);
    assert!(t.unsure_pools.is_empty());
    assert_eq!(price(&a, pool()), known(105));
    assert_eq!(price(&a, pool2()), known(7));
    a.on_feed_message(msg(12, &[stx(1, dep(), w(3))]));
    let t = a.tip().unwrap();
    assert_eq!(t.seq, 12);
    assert!(t.changed_pools.is_empty(), "DEP is not one of our pools");
    // The view is strict: a value nobody loaded is Missing, never zero.
    assert_eq!(t.view().storage(pool(), U256::from(9u8)), Lookup::Missing);
    // DEP's transaction names none of our pools: skipped by the cheap
    // filter (not run), so DEP keeps its confirmed value here.
    assert_eq!(t.view().storage(dep(), U256::ZERO), known(2));
    assert_eq!((a.total.txs_run, a.total.txs_skipped), (1, 1));
}

#[test]
fn rebase_drops_confirmed_blocks_and_reapplies_the_rest() {
    let mut a = ahead(32);
    a.on_feed_message(msg(11, &[stx(0, pool(), w(5))]));
    a.on_feed_message(msg(12, &[stx(1, pool(), w(10))]));
    a.on_feed_message(msg(13, &[stx(2, pool2(), w(1))]));
    assert_eq!((a.depth(), price(&a, pool()), price(&a, pool2())), (3, known(115), known(8)));
    // Copy 2 confirms block 11 exactly as predicted: same tip after the rebase.
    let (s11, d11) = with_price(105, 7);
    a.on_confirmed(confirmed(11, s11, d11), &no_moves);
    assert_eq!((a.base_seq(), a.depth()), (Some(11), 2));
    let t = a.tip().unwrap();
    assert_eq!((t.seq, t.base_seq), (13, 11));
    assert_eq!((price(&a, pool()), price(&a, pool2())), (known(115), known(8)));
    assert_eq!((a.total.agree, a.total.disagree), (1, 0));
    // Copy 2 confirms block 12 with a DIFFERENT pool price (something we
    // never saw moved it): the prediction for 13 is rebuilt on top of it.
    let (s12, d12) = with_price(1000, 7);
    a.on_confirmed(confirmed(12, s12, d12), &no_moves);
    assert_eq!((a.base_seq(), a.depth()), (Some(12), 1));
    assert_eq!((price(&a, pool()), price(&a, pool2())), (known(1000), known(8)));
    assert_eq!((a.total.disagree, a.total.value_diff), (1, 1));
    assert_eq!(a.hour.samples[0]["pool"], serde_json::json!(key(pool())));
    assert_eq!(a.hour.samples[0]["block"], serde_json::json!(12));
    // Confirmed past everything held: nothing predicted, no tip.
    let (s14, _) = with_price(1001, 8);
    a.on_confirmed(confirmed(14, s14, StateDiff::default()), &no_moves);
    assert_eq!((a.depth(), a.held_msgs()), (0, 0));
    assert!(a.tip().is_none());
    assert_eq!(a.total.unpredicted, 1, "block 14 was never predicted (no message 14)");
    // A feed message the copy already confirmed is only counted.
    a.on_feed_message(msg(13, &[stx(9, pool(), w(1))]));
    assert_eq!((a.total.late_msgs, a.depth()), (1, 0));
}

#[test]
fn router_the_filter_skips_is_counted_then_learned_from_the_confirmed_reports() {
    let mut a = ahead(32);
    // Swap through the router: its data is just the amount (3), POOL is in
    // its code. The cheap filter can't see it: skipped, prediction says 100.
    let r1 = stx(0, router(), w(3));
    a.on_feed_message(msg(11, &[r1.clone()]));
    assert_eq!(price(&a, pool()), known(100));
    assert_eq!(a.total.txs_skipped, 1);
    // Copy 2's reports: that transaction moved POOL to 106.
    let (s11, d11) = with_price(106, 7);
    let h = keccak256(&r1);
    let moves = move |x: &B256| (*x == h).then(|| vec![key(pool())]);
    a.on_confirmed(confirmed(11, s11, d11), &moves);
    assert_eq!((a.total.missed, a.total.filter_missed), (1, 1), "visible, not silent");
    assert!(a.is_toucher(&router()), "the router is learned");
    // Next swap through it is run: 106 + 4 x 2.
    a.on_feed_message(msg(12, &[stx(1, router(), w(4))]));
    assert_eq!(price(&a, pool()), known(114));
    assert_eq!(a.tip().unwrap().changed_pools, vec![key(pool())]);
}

#[test]
fn filter_all_runs_every_transaction() {
    let mut a = Ahead::new(AheadCfg { run_all: true, ..AheadCfg::default() });
    a.set_pools(pools());
    a.on_confirmed(confirmed(10, copy10(), StateDiff::default()), &no_moves);
    a.on_feed_message(msg(11, &[stx(0, router(), w(3))]));
    assert_eq!(price(&a, pool()), known(106));
    assert!(a.is_toucher(&router()), "learned from our own run too");
}

#[test]
fn a_transaction_needing_missing_data_marks_only_the_pools_it_touches_unsure() {
    // DEP's value is not in our copy: the router can't be run exactly.
    let mut s = copy10();
    s.apply_fact(&Fact::Forget(dep()));
    put(&mut s, dep(), dep_code(), &[]);
    let mut a = Ahead::new(AheadCfg { run_all: true, ..AheadCfg::default() });
    a.set_pools(pools());
    a.on_confirmed(confirmed(10, s, StateDiff::default()), &no_moves);
    a.on_feed_message(msg(11, &[stx(0, router(), w(3)), stx(1, pool2(), w(2))]));
    let t = a.tip().unwrap();
    assert_eq!(t.unsure_pools, vec![key(pool())], "only POOL (the router reaches it), never POOL2");
    assert_eq!(t.view().storage(pool(), U256::ZERO), Lookup::Missing, "forgotten: missing is never zero, never the old value");
    assert_eq!(t.view().storage(pool2(), U256::ZERO), known(9), "the other pool moves on exactly");
    let mut ch = t.changed_pools.clone();
    ch.sort();
    let mut want = vec![key(pool()), key(pool2())];
    want.sort();
    assert_eq!(ch, want);
    assert_eq!((a.total.txs_failed, a.total.txs_marked), (1, 1));
    // Stays unsure in later predicted blocks, until a confirmed version.
    a.on_feed_message(msg(12, &[]));
    assert_eq!(a.tip().unwrap().unsure_pools, vec![key(pool())]);
    // Agreement for block 11 counts POOL as unsure, POOL2 as agreed.
    let (mut s11, mut d11) = with_price(106, 9);
    s11.apply_fact(&Fact::Slot(dep(), U256::ZERO, U256::from(2u8)));
    d11.accounts.insert(pool2(), AccountDiff { storage: [(U256::ZERO, U256::from(9u8))].into_iter().collect(), ..Default::default() });
    a.on_confirmed(confirmed(11, s11, d11), &no_moves);
    assert_eq!((a.total.unsure, a.total.agree, a.total.disagree), (1, 1, 0));
    assert!(a.tip().unwrap().unsure_pools.is_empty(), "the rebase starts clean");
}

#[test]
fn unreadable_messages_stop_prediction_until_confirmed() {
    let mut a = ahead(32);
    let m = WireFeedMsg { seq: 11, ts: 1_700_000_011, l1: 500, txs: vec![], complete: false, why: Some("deposit".into()) };
    a.on_feed_message(Arc::new(BinMsg::from_wire(&m, true)));
    assert!(a.tip().is_none());
    assert_eq!(a.stopped(), Some((11, "unreplayable_msg")));
    a.on_feed_message(msg(12, &[stx(0, pool(), w(1))]));
    assert!(a.tip().is_none(), "never predicts past a block it couldn't read");
    let (s11, d11) = with_price(100, 7);
    a.on_confirmed(confirmed(11, s11, d11), &no_moves);
    assert_eq!(price(&a, pool()), known(101), "resumes from the confirmed block");
}

#[test]
fn a_missing_message_holds_the_tip_until_it_arrives() {
    let mut a = ahead(32);
    a.on_feed_message(msg(12, &[stx(1, pool(), w(10))]));
    assert!(a.tip().is_none(), "11 not here yet");
    a.on_feed_message(msg(11, &[stx(0, pool(), w(5))]));
    assert_eq!(a.tip().unwrap().seq, 12);
    assert_eq!(price(&a, pool()), known(115));
}

#[test]
fn memory_is_bounded_and_a_copy_too_far_behind_stops_prediction() {
    let mut a = ahead(4);
    for i in 0..40u64 {
        a.on_feed_message(msg(11 + i, &[stx(i, pool(), w(1))]));
        assert!(a.depth() <= 4, "at most max_blocks predicted blocks");
        assert!(a.held_msgs() <= 8, "at most 2 x max_blocks messages held");
    }
    assert!(a.tip().is_none());
    assert_eq!(a.stopped().map(|s| s.1), Some("behind"));
    // The copy catches up to 48: prediction resumes from there (49, 50 held).
    let (s48, _) = with_price(500, 7);
    a.on_confirmed(confirmed(48, s48, StateDiff::default()), &no_moves);
    let t = a.tip().unwrap();
    assert_eq!((t.seq, t.base_seq), (50, 48));
    assert_eq!(price(&a, pool()), known(502));
    let line = a.hour.line();
    assert!(line.contains("stopped [behind:") && line.contains("apply us p50"), "{line}");
}

#[test]
fn fastlane_off_starts_nothing() {
    use arbsim::copy2::ahead::{feed_hook, global_tip, start_with, status_json, Mode};
    use arbsim::copy2::intake::{manual, C2Config};
    use arbsim::state::fill::FillQueue;
    use arbsim::state::mirror::{Config, Shared};
    let sh = Shared::new(Config::for_tests(), None, Arc::new(arbsim::state::snap::Volatile::default()));
    let (_intake, h) = manual(sh, Arc::new(FillQueue::new(10, 10)), C2Config::for_tests());
    assert!(!start_with(Mode::Off, h, AheadCfg::default()));
    feed_hook(&[msg(11, &[])]);
    assert!(global_tip().is_none() && status_json().is_none(), "no thread, no tip, no status section");
}

// ---------------------------------------------------------------------------
// Real bytecode: the Uniswap V2 pair of the offline fixture (offline-v3-v2-v3).
// The fixture lists every account / slot one real check read; anything not
// listed is empty (prestate tracer). A feed transaction calls the pair's
// sync() (anyone may): it writes reserves, timestamp and the price
// accumulators. The predicted copy must equal copy 1's exact replay
// (feed/replay.rs, proven against the node's own traces) value for value.
// ---------------------------------------------------------------------------
const V2_PAIR: &str = "0xc71ea6d6f624b22ea26c8c6b09b475b889a85b25";

fn fixture_snapshot() -> (Snapshot, BlockCtx) {
    let f = arbsim::check::fixture::Fixture::load(&fixture_path("offline-v3-v2-v3")).unwrap();
    let mut s = Snapshot::default();
    for (a, info) in &f.state.accounts {
        let code = f.state.codes.get(&info.code_hash).cloned();
        s.apply_fact(&Fact::Basics { addr: *a, info: Some(AccountInfo { code: None, ..info.clone() }), code });
        // Fixture rule: unlisted slots are empty -> "storage complete".
        let mut d = AccountDiff { storage_cleared: true, ..Default::default() };
        d.storage = f.state.storage.get(a).cloned().unwrap_or_default();
        s.apply_account_diff(*a, &d);
    }
    (s, f.ctx)
}

#[test]
fn predicted_equals_the_chains_own_replay_on_a_real_v2_pair() {
    use arbsim::feed::replay::{replay_tx, ReplayEnv, TxOutcome};
    let pair: Address = V2_PAIR.parse().unwrap();
    let (base, ctx) = fixture_snapshot();
    let mut a = Ahead::new(AheadCfg::default());
    a.set_pools(Arc::new(PoolSet::build(&[(FollowedPool { key: key(pair), address: pair, v4_id: None }, Address::ZERO, Address::ZERO)], HashSet::new())));
    let seq = 1000u64;
    a.on_confirmed(Confirmed { seq, snap: Arc::new(base.clone()), ctx: Some(ctx.clone()), diff: Arc::new(StateDiff::default()), prov: Arc::new(AllExact) }, &no_moves);
    // Two blocks, each a sync() at a later time (the accumulators move).
    let sync = keccak256(b"sync()")[..4].to_vec();
    let txs = [stx(0, pair, sync.clone()), stx(1, pair, sync.clone())];
    let mut truth = base.clone();
    let mut prev = ctx.clone();
    for (i, raw) in txs.iter().enumerate() {
        let s = seq + 1 + i as u64;
        let ts = ctx.timestamp + 13 * (i as u64 + 1);
        let wm = WireFeedMsg { seq: s, ts, l1: ctx.l1_block_number, txs: vec![hexs(raw)], complete: true, why: None };
        a.on_feed_message(Arc::new(BinMsg::from_wire(&wm, true)));
        // The referee: copy 1's exact replay of the same transaction.
        let bctx = BlockCtx { timestamp: ts.max(prev.timestamp), basefee: 0, ..prev.clone() };
        let tx = arbsim::feed::decode_tx(raw).unwrap();
        match replay_tx(&truth, &bctx, &ReplayEnv::default(), &tx) {
            TxOutcome::Done { diff, success, .. } => {
                assert!(success, "sync() must succeed on the real pair");
                truth.apply_diff(&diff);
            }
            _ => panic!("the referee could not replay sync()"),
        }
        prev = bctx;
        let t = a.tip().expect("tip");
        assert_eq!(t.changed_pools, vec![key(pair)], "block {s}");
        assert!(t.unsure_pools.is_empty());
        // Every storage value of the pair: prediction == referee.
        let held = truth.held_slots(&pair);
        assert!(held.len() >= 6, "{held:?}");
        let v = t.view();
        for sl in held {
            assert_eq!(v.storage(pair, sl), truth.storage(pair, sl), "slot {sl:#x} at block {s}");
        }
    }
    // The block-1 accumulators really moved (proves the comparison bites).
    assert_ne!(truth.storage(pair, U256::from(9u8)), base.storage(pair, U256::from(9u8)));
}

/// TEST NUMBERS ONLY (this machine, toy contracts): microseconds to apply
/// one feed message with 10 transactions, 2 of them on our pools.
#[test]
fn bench_apply_us_test_numbers_only() {
    let mut a = ahead(32);
    let mut nonce = 0u64;
    let mut seq = 11u64;
    for _ in 0..200 {
        let mut txs = Vec::new();
        for j in 0..10u64 {
            let to = if j < 2 { pool() } else { dep() };
            txs.push(stx(nonce, to, w(1)));
            nonce += 1;
        }
        let m = msg(seq, &txs);
        for t in &m.txs {
            let _ = t.decoded(); // the feed store's background thread does this live
        }
        a.on_feed_message(m);
        // Keep the copy close behind (normal live shape: 1-3 blocks).
        let (s, d) = with_price(100, 7);
        a.on_confirmed(confirmed(seq, s, d), &no_moves);
        seq += 1;
    }
    let j = a.total.json();
    eprintln!("[test numbers] apply us per message (10 txs, 2 ours): {}", j["applyUs"]);
    assert!(j["applyUs"]["n"].as_u64().unwrap() >= 200);
}

// ---------------------------------------------------------------------------
// Review fixes (integration)
// ---------------------------------------------------------------------------

/// H4: a picked transaction that FAILS and whose probe finds none of our
/// pools (here: the router's code is unknown in our copy) must not leave
/// the pools looking exact. Known router: the pools it moved before become
/// unsure. Unknown target, nothing named: prediction stops until confirmed.
#[test]
fn a_failing_tx_with_unknown_effect_never_leaves_pools_looking_exact() {
    // ROUTER learned as a toucher of POOL (block 11 confirmed it moved POOL).
    let mut a = ahead(32);
    let r1 = stx(0, router(), w(3));
    a.on_feed_message(msg(11, &[r1.clone()]));
    let (s11, d11) = with_price(106, 7);
    let h = keccak256(&r1);
    a.on_confirmed(confirmed(11, s11.clone(), d11), &move |x: &B256| (*x == h).then(|| vec![key(pool())]));
    assert!(a.is_toucher(&router()));
    // Now the router's CODE is unknown in copy 2 (a value we don't hold):
    // the run fails, the probe reads nothing of ours.
    let mut s12 = s11.clone();
    s12.apply_fact(&Fact::Forget(router()));
    a.on_confirmed(confirmed(12, s12, StateDiff::default()), &no_moves);
    a.on_feed_message(msg(13, &[stx(1, router(), w(4))]));
    let t = a.tip().expect("tip");
    assert_eq!(t.unsure_pools, vec![key(pool())], "the pools this router moved before");
    assert_eq!(t.view().storage(pool(), U256::ZERO), Lookup::Missing);
    assert_eq!(a.total.failed_unknown, 1);
    // An address never seen, naming nothing of ours, failing: stop.
    let stranger = addr(0x7777);
    a.on_feed_message(msg(14, &[stx(2, stranger, w(1))]));
    // (A transaction to an EMPTY account just succeeds: nothing to do. Make
    // it fail instead: our copy doesn't know the stranger at all.)
    let mut b = Ahead::new(AheadCfg { run_all: true, ..AheadCfg::default() });
    b.set_pools(pools());
    let mut s = copy10();
    s.apply_fact(&Fact::Forget(stranger));
    b.on_confirmed(confirmed(10, s, StateDiff::default()), &no_moves);
    b.on_feed_message(msg(11, &[stx(0, stranger, w(1))]));
    assert!(b.tip().is_none(), "unknown effect: no prediction until confirmed");
    assert_eq!(b.stopped(), Some((11, "failed_tx_unknown_effect")));
}

/// M1: a run that used a value copy 2 only holds as a FILL (re-read every
/// minute, not followed exactly: labelled recent_fill) or an assumed
/// sender's funds: the pools it moved are unsure in the predicted view.
struct DepIsAFill;
impl arbsim::check::ordered::Provenance for DepIsAFill {
    fn slot_exact(&self, a: Address, _s: U256) -> bool {
        a != dep()
    }
    fn balance_exact(&self, _a: Address) -> bool {
        true
    }
}

#[test]
fn results_built_on_assumed_values_are_unsure() {
    let cfg = AheadCfg::from_lookup(|k| (k == "FASTLANE_AHEAD_TRUST_SENDER_FUNDS").then(|| "on".to_string()), 0);
    assert!(cfg.trust_sender_funds);
    assert!(!AheadCfg::default().trust_sender_funds, "default: not trusted");
    let mut a = Ahead::new(AheadCfg { run_all: true, ..AheadCfg::default() });
    a.set_pools(pools());
    a.on_confirmed(Confirmed { seq: 10, snap: Arc::new(copy10()), ctx: Some(ctx_at(10)), diff: Arc::new(StateDiff::default()), prov: Arc::new(DepIsAFill) }, &no_moves);
    // The router reads DEP (a fill) and moves POOL with it.
    a.on_feed_message(msg(11, &[stx(0, router(), w(3)), stx(1, pool2(), w(2))]));
    let t = a.tip().unwrap();
    assert!(a.total.assumed >= 1 && a.total.assumed_unsure == 1, "assumed {} assumedUnsure {}", a.total.assumed, a.total.assumed_unsure);
    assert_eq!(t.unsure_pools, vec![key(pool())], "built on a fill: unsure, never exact");
    assert_eq!(t.view().storage(pool(), U256::ZERO), Lookup::Missing);
    assert_eq!(t.view().storage(pool2(), U256::ZERO), known(9), "a pool moved exactly stays exact");
}

/// M3: a native-ETH pool (one coin = address zero) traded by a router that
/// pays ETH and names only the other coin is picked by the filter.
#[test]
fn native_eth_router_trades_are_picked() {
    let coin = addr(0x5555);
    let fp = |a: Address, t0: Address, t1: Address| (FollowedPool { key: key(a), address: a, v4_id: None }, t0, t1);
    let set = Arc::new(PoolSet::build(&[fp(pool(), Address::ZERO, coin), fp(pool2(), Address::ZERO, Address::ZERO)], HashSet::new()));
    let mut a = Ahead::new(AheadCfg::default());
    a.set_pools(set);
    a.on_confirmed(confirmed(10, copy10(), StateDiff::default()), &no_moves);
    // Router call: pays 1 wei of ETH, data names the coin (not the pool).
    let mut data = vec![0u8; 12];
    data.extend_from_slice(coin.as_slice());
    let tx = sign_typed(&KEY, 2, &TestTx { nonce: 0, gas: 300_000, to: Some(dep()), value: U256::from(1u8), data, access_list: vec![] }, 4663);
    a.on_feed_message(msg(11, &[tx]));
    assert_eq!(a.total.native_picks, 1, "picked for the native pool");
    assert_eq!(a.total.txs_skipped, 0);
}

/// L1: several blocks confirmed at once: every predicted block's skipped
/// list is still checked (learned), and agreement is not miscounted.
#[test]
fn several_blocks_confirmed_at_once_learn_every_skipped_tx() {
    let mut a = ahead(32);
    let r1 = stx(0, router(), w(3));
    a.on_feed_message(msg(11, &[r1.clone()]));
    a.on_feed_message(msg(12, &[stx(1, dep(), w(5))]));
    let (s12, d12) = with_price(106, 7);
    let h = keccak256(&r1);
    // Copy 2 publishes block 12 only (11 and 12 confirmed together).
    a.on_confirmed(confirmed(12, s12, d12), &move |x: &B256| (*x == h).then(|| vec![key(pool())]));
    assert!(a.is_toucher(&router()), "block 11's skipped router learned too");
    assert_eq!(a.total.filter_missed, 1);
    assert_eq!((a.total.agree, a.total.disagree), (0, 0), "a 2-block jump is not compared");
    assert_eq!(a.total.unpredicted, 1);
}

/// L2: timing samples keep moving after the per-hour cap (a ring).
#[test]
fn timing_samples_keep_the_newest() {
    let mut a = ahead(32);
    for i in 0..30u64 {
        a.on_feed_message(msg(11 + i, &[]));
        if i % 8 == 7 {
            let (s, _) = with_price(100, 7);
            a.on_confirmed(confirmed(11 + i, s, StateDiff::default()), &no_moves);
        }
    }
    assert!(a.hour.time_n >= 30);
    assert_eq!(a.hour.apply_us.len() as u64, a.hour.time_n.min(20_000));
}
