// ============================================================================
// FAST LANE A, LIVE SPEED (Oct 31 night: the first observe hour live had the
// prediction "too slow" half the time, the keeper restarting, and sure-but-
// wrong 82 against 62 right).
//
// Plain English: the same tiny hand-written contracts as the accuracy tests,
// to prove each live-speed rule in copy2/ahead.rs:
//   - the per-message budget can count CPU time (waiting for a CPU is not
//     work), and a message that runs past the budget is NEVER compared as
//     sure (no partial prediction)
//   - a lazy rebase gives the same predictions and comparisons with fewer
//     re-applies
//   - a keeper re-publish of the same block does not rebuild everything again
//   - with the keeper on, a base without the keeper's values predicts
//     nothing ("keeper_behind") until they come
//   - sure answers are split by whether the base had the keeper's values
//   - the settings and their per-mode defaults
// ============================================================================
#![allow(dead_code)]
mod check_util;

use std::collections::HashSet;
use std::sync::Arc;

use arbsim::arb::BlockCtx;
use arbsim::check::feedstore::BinMsg;
use arbsim::check::moved::FollowedPool;
use arbsim::check::ordered::{AllExact, WireFeedMsg};
use arbsim::copy2::ahead::{thread_cpu_us, Ahead, AheadCfg, Confirmed, PoolSet};
use arbsim::copy2::keeper::KeptVersion;
use arbsim::state::snap::{Fact, Snapshot};
use arbsim::state::{Lookup, StateDiff, StateRead};
use check_util::*;
use revm::primitives::{keccak256, Address, B256, U256};
use revm::state::{AccountInfo, Bytecode};

const KEY: [u8; 32] = [
    0xac, 0x09, 0x74, 0xbe, 0xc3, 0x9a, 0x17, 0xe3, 0x6b, 0xa4, 0xa6, 0xb4, 0xd2, 0x38, 0xff, 0x94, 0x4b, 0xac, 0xb4,
    0x78, 0xcb, 0xed, 0x5e, 0xfc, 0xae, 0x78, 0x4d, 0x7b, 0xf4, 0xf2, 0xff, 0x80,
];

// POOL: a 32-byte call adds the word to slot 0 (its "price"); anything else
// reverts with a custom error. DEP: a 32-byte call sets slot 0. ROUTER: reads
// DEP, then "swaps" x * DEP on POOL (POOL is in its CODE, not its data).
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

fn put(s: &mut Snapshot, a: Address, code: Vec<u8>, slots: &[(u64, u64)]) {
    let bc = Bytecode::new_raw(code.clone().into());
    let info = AccountInfo { balance: U256::ZERO, nonce: 1, code_hash: keccak256(&code), code: None, ..Default::default() };
    s.apply_fact(&Fact::Basics { addr: a, info: Some(info), code: Some(bc) });
    for (k, v) in slots {
        s.apply_fact(&Fact::Slot(a, U256::from(*k), U256::from(*v)));
    }
}

/// POOL at `p`, POOL2 at `q`, DEP 2, ROUTER.
fn copy_at(p: u64, q: u64) -> Snapshot {
    let mut s = Snapshot::default();
    put(&mut s, pool(), pool_code(), &[(0, p)]);
    put(&mut s, pool2(), pool_code(), &[(0, q)]);
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

fn stx_v(nonce: u64, to: Address, value: u64, data: Vec<u8>) -> Vec<u8> {
    sign_typed(&KEY, 2, &TestTx { nonce, gas: 300_000, to: Some(to), value: U256::from(value), data, access_list: vec![] }, 4663)
}

fn stx(nonce: u64, to: Address, data: Vec<u8>) -> Vec<u8> {
    stx_v(nonce, to, 0, data)
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

fn pool_list() -> Vec<(FollowedPool, Address, Address)> {
    let fp = |a: Address| (FollowedPool { key: key(a), address: a, v4_id: None }, Address::ZERO, Address::ZERO);
    vec![fp(pool()), fp(pool2())]
}

fn confirmed(seq: u64, snap: Arc<Snapshot>) -> Confirmed {
    Confirmed { seq, snap, ctx: Some(ctx_at(seq)), diff: Arc::new(StateDiff::default()), prov: Arc::new(AllExact) }
}

fn no_moves(_: &B256) -> Option<Vec<String>> {
    None
}

fn known(v: u64) -> Lookup<U256> {
    Lookup::Known(U256::from(v))
}

fn ahead_on(cfg: AheadCfg, base: Snapshot) -> Ahead {
    let mut a = Ahead::new(cfg);
    a.set_pools(Arc::new(PoolSet::build(&pool_list(), HashSet::new())));
    a.on_confirmed(confirmed(10, Arc::new(base)), &no_moves);
    a
}



/// The keeper's version of `block` holding DEP (value 2).
fn kept(block: u64) -> Arc<KeptVersion> {
    let mut k = Snapshot::default();
    put(&mut k, dep(), dep_code(), &[(0, 2)]);
    Arc::new(KeptVersion { block, accounts: k.accounts.clone(), codes: k.codes.clone() })
}

/// The thread CPU clock does not count time spent waiting.
#[test]
fn the_cpu_clock_does_not_count_waiting() {
    let c0 = thread_cpu_us();
    let t0 = std::time::Instant::now();
    std::thread::sleep(std::time::Duration::from_millis(60));
    let cpu = thread_cpu_us().saturating_sub(c0);
    assert!(t0.elapsed().as_millis() >= 60);
    assert!(cpu < 20_000, "sleeping used {cpu} us of CPU");
}

/// A message that runs past the budget leaves NO prediction for its block
/// (never a half-applied one), so its block is "unpredicted", never sure.
/// Both clocks.
#[test]
fn a_message_over_budget_is_never_compared_as_sure() {
    for cpu in [false, true] {
        let cfg = AheadCfg { msg_budget_us: 0, budget_cpu: cpu, ..AheadCfg::default() };
        let mut a = ahead_on(cfg, copy_at(100, 7));
        // Two transactions: the budget is looked at before the second.
        a.on_feed_message(msg(11, &[stx(0, pool(), w(5)), stx(1, pool2(), w(1))]));
        assert!(a.tip().is_none(), "no tip for a message cut short");
        assert_eq!(a.stopped().map(|s| s.1), Some("msg_budget"));
        a.on_confirmed(confirmed(11, Arc::new(copy_at(105, 8))), &no_moves);
        assert_eq!((a.total.agree, a.total.disagree, a.total.unsure), (0, 0, 0), "cpu clock {cpu}");
        assert_eq!((a.total.compared, a.total.unpredicted, a.total.over_budget), (0, 1, 1));
    }
}

/// Lazy rebase: two copy-2 versions in a row without a feed message in
/// between. Same comparisons as before (each block still compared with its
/// prediction), with fewer applies.
#[test]
fn a_lazy_rebase_gives_the_same_answers_with_fewer_applies() {
    let run = |lazy: bool| {
        let mut a = ahead_on(AheadCfg { lazy_rebase: lazy, ..AheadCfg::default() }, copy_at(100, 7));
        a.on_feed_message(msg(11, &[stx(0, pool(), w(5))]));
        a.on_feed_message(msg(12, &[stx(1, pool(), w(1))]));
        a.on_feed_message(msg(13, &[stx(2, pool2(), w(3))]));
        // Copy 2 publishes 11 and 12 back to back (the second one is WRONG
        // for pool: 107, not 106, so one disagreement).
        a.on_confirmed(confirmed(11, Arc::new(copy_at(105, 7))), &no_moves);
        a.on_confirmed(confirmed(12, Arc::new(copy_at(107, 7))), &no_moves);
        // The next feed message: everything is there again.
        a.on_feed_message(msg(14, &[stx(3, pool2(), w(1))]));
        let t = a.tip().expect("a tip after the next feed message");
        assert_eq!(t.view().storage(pool2(), U256::ZERO), known(11), "lazy {lazy}: 7 + 3 + 1");
        (a.total.agree, a.total.disagree, a.total.compared, a.total.applied)
    };
    let (ag0, dis0, cmp0, ap0) = run(false);
    let (ag1, dis1, cmp1, ap1) = run(true);
    assert_eq!((ag0, dis0, cmp0), (ag1, dis1, cmp1), "same answers");
    assert_eq!((ag1, dis1, cmp1), (1, 1, 2));
    assert!(ap1 < ap0, "fewer applies: {ap1} vs {ap0}");
}

/// The keeper re-publishes the SAME block (a seed came back): with
/// KEPT_REBUILD=once the merged base is kept; "every" rebuilds each time.
#[test]
fn a_keeper_republish_of_the_same_block_rebuilds_once() {
    for once in [false, true] {
        let mut base = copy_at(100, 7);
        base.apply_fact(&Fact::Forget(dep()));
        let mut a = ahead_on(AheadCfg { run_all: true, keeper: true, kept_rebuild_once: once, ..AheadCfg::default() }, base);
        a.on_feed_message(msg(11, &[stx(0, router(), w(3))]));
        a.on_kept(kept(10));
        a.on_kept(kept(10)); // a re-publish (new object, same block)
        assert_eq!(a.total.kept_rebases, if once { 1 } else { 2 }, "once {once}");
        assert_eq!(a.total.kept_skipped, if once { 1 } else { 0 });
        assert_eq!(a.tip().unwrap().view().storage(pool(), U256::ZERO), known(106));
    }
}

/// NEED_KEEPER: with the keeper on, no prediction on a base without the
/// keeper's values of that block; it comes once they arrive.
#[test]
fn no_prediction_without_the_keepers_values_when_asked() {
    let mut base = copy_at(100, 7);
    base.apply_fact(&Fact::Forget(dep()));
    let mut a = ahead_on(AheadCfg { run_all: true, keeper: true, need_keeper: true, ..AheadCfg::default() }, base.clone());
    a.on_feed_message(msg(11, &[stx(0, router(), w(3))]));
    assert!(a.tip().is_none());
    assert_eq!(a.stopped().map(|s| s.1), Some("keeper_behind"));
    a.on_kept(kept(10));
    let t = a.tip().expect("the keeper's values came: predicted");
    assert!(t.unsure_pools.is_empty());
    assert_eq!(t.view().storage(pool(), U256::ZERO), known(106));
    // Off (the old rule): predicted at once, on the plain base (pool unsure).
    let mut b = ahead_on(AheadCfg { run_all: true, keeper: true, need_keeper: false, ..AheadCfg::default() }, base);
    b.on_feed_message(msg(11, &[stx(0, router(), w(3))]));
    assert!(b.tip().unwrap().unsure_pools.contains(&key(pool())));
}

/// Sure answers are counted by whether the base had the keeper's values.
#[test]
fn sure_answers_are_split_by_keeper_base() {
    let mut a = ahead_on(AheadCfg { keeper: true, ..AheadCfg::default() }, copy_at(100, 7));
    a.on_kept(kept(10));
    a.on_feed_message(msg(11, &[stx(0, pool(), w(5))]));
    a.on_confirmed(confirmed(11, Arc::new(copy_at(105, 7))), &no_moves);
    assert_eq!((a.total.right_kept, a.total.right_plain), (1, 0));
    // Base 11 has no keeper version: plain.
    a.on_feed_message(msg(12, &[stx(1, pool(), w(1))]));
    a.on_confirmed(confirmed(12, Arc::new(copy_at(107, 7))), &no_moves);
    assert_eq!((a.total.wrong_kept, a.total.wrong_plain), (0, 1));
}

/// The live-speed settings: the new way only in observe mode by default.
#[test]
fn live_speed_settings_and_defaults() {
    let cfg = |ahead: &str, extra: Option<(&str, &str)>| {
        AheadCfg::from_lookup(
            |k| match k {
                "FASTLANE_AHEAD" => Some(ahead.to_string()),
                _ => extra.filter(|e| e.0 == k).map(|e| e.1.to_string()),
            },
            0,
        )
    };
    let o = cfg("observe", None);
    assert!(o.budget_cpu && o.lazy_rebase && o.kept_rebuild_once && o.need_keeper, "observe: the new way");
    let n = cfg("on", None);
    assert!(!n.budget_cpu && !n.lazy_rebase && !n.kept_rebuild_once && !n.need_keeper, "on: unchanged");
    assert!(!cfg("observe", Some(("FASTLANE_AHEAD_BUDGET_CLOCK", "wall"))).budget_cpu);
    assert!(cfg("on", Some(("FASTLANE_AHEAD_BUDGET_CLOCK", "cpu"))).budget_cpu);
    assert!(!cfg("observe", Some(("FASTLANE_AHEAD_LAZY_REBASE", "off"))).lazy_rebase);
    assert!(!cfg("observe", Some(("FASTLANE_AHEAD_KEPT_REBUILD", "every"))).kept_rebuild_once);
    assert!(!cfg("observe", Some(("FASTLANE_AHEAD_NEED_KEEPER", "off"))).need_keeper);
}
