// ============================================================================
// FAST LANE A, accuracy fixes (Oct 27, second practice run: agree 16,
// disagree 933, 906 labelled "missedRan").
//
// Plain English: tiny hand-written contracts (same as tests/fastlane_ahead.rs)
// and signed test transactions, to prove each fix in copy2/ahead.rs:
//   - a transaction we could NOT run is labelled missedFailed (it used to be
//     counted as "missedRan"); a run that REVERTED is missedReverted; the
//     sample says why, with the slots that differ and the values
//   - a replaced version of the base block (copy 2 wrote late reports into
//     it) rebases the prediction on the corrected copy
//   - agreement waits and compares against the SETTLED versions: a block
//     whose first version lacked a late report is no longer a false
//     "phantom"; a base corrected later is labelled "staleBase"
//   - a failed run marks native-ETH pools of a named coin and the router's
//     learned sister pools unsure (a sure pool must never be the wrong one)
//   - routers are learned from every transaction copy 2 says moved our
//     pools (not only skipped ones)
//   - CAPTURE + REPLAY round trip: everything the predicted copy saw is
//     written, read back, and the offline replay gives the SAME counts.
// ============================================================================
mod check_util;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use arbsim::arb::BlockCtx;
use arbsim::check::feedstore::BinMsg;
use arbsim::check::moved::FollowedPool;
use arbsim::check::ordered::{AllExact, WireFeedMsg};
use arbsim::copy2::ahead::{Ahead, AheadCfg, Confirmed, PoolSet, Settled};
use arbsim::copy2::ahead_capture::{print_report, read_capture, replay, CapEv, Capture, ProvSets, ReplayOpts};
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

// ---------------------------------------------------------------------------
// 6. Honest miss labels
// ---------------------------------------------------------------------------

/// A transaction we could NOT run (its router's code is not in our copy):
/// before, its miss was counted "missedRan". Now missedFailed, and the
/// sample says why (by role, no address), which transaction, the slots.
#[test]
fn a_transaction_we_could_not_run_is_missed_failed_not_missed_ran() {
    // ROUTER learned as a mover of POOL2 only (an older block; the filter
    // skipped that transaction, copy 2's reports named POOL2).
    let mut a = ahead_on(AheadCfg::default(), copy_at(100, 7));
    let r0 = stx(0, router(), w(3));
    a.on_feed_message(msg(11, &[r0.clone()]));
    let h0 = keccak256(&r0);
    a.on_confirmed(confirmed(11, Arc::new(copy_at(106, 7))), &move |x: &B256| (*x == h0).then(|| vec![key(pool2())]));
    assert!(a.is_toucher(&router()), "learned from copy 2's reports");
    // Now its code is unknown to copy 2: the run fails; the only thing known
    // about it is its old pool (POOL2), which is marked unsure. On chain it
    // moved POOL.
    let mut s11 = copy_at(106, 7);
    s11.apply_fact(&Fact::Forget(router()));
    let s11 = Arc::new(s11);
    a.on_confirmed(confirmed(12, s11.clone()), &no_moves);
    let r1 = stx(1, router(), w(4));
    a.on_feed_message(msg(13, &[r1.clone()]));
    assert_eq!(a.tip().unwrap().unsure_pools, vec![key(pool2())]);
    let mut s13 = (*s11).clone();
    s13.apply_fact(&Fact::Slot(pool(), U256::ZERO, U256::from(114u64)));
    let h1 = keccak256(&r1);
    a.on_confirmed(confirmed(13, Arc::new(s13)), &move |x: &B256| (*x == h1).then(|| vec![key(pool())]));
    assert_eq!((a.total.missed, a.total.missed_failed, a.total.missed_ran), (1, 1, 0), "a failed run is not 'missedRan'");
    let sm = a.total.samples.last().unwrap();
    assert_eq!(sm["kind"], "missedFailed");
    assert_eq!(sm["txFate"], "failed");
    assert_eq!(sm["tx"], format!("{h1:#x}"));
    assert!(sm["txWhy"].as_str().unwrap().contains("target"), "why, by role: {sm}");
    assert_eq!(sm["slots"][0]["conf"], "0x72", "confirmed 114: {sm}");
    assert_eq!(sm["slots"][0]["pred"], "0x6a", "predicted 106 (never moved): {sm}");
    assert_eq!(sm["block"], 13);
    assert_eq!(sm["baseBlock"], 12);
    assert!(a.is_toucher(&router()));
}

/// Our run REVERTED (it succeeded on chain): missedReverted, with the error.
/// (The old rule, FASTLANE_AHEAD_REVERT_UNSURE=off: a reverted run moved
/// nothing and its pools stayed sure.)
#[test]
fn a_run_that_reverted_is_missed_reverted() {
    let mut a = ahead_on(AheadCfg { revert_unsure: false, ..AheadCfg::default() }, copy_at(100, 7));
    // A 4-byte call: POOL reverts with its custom error in OUR run.
    let t = stx(0, pool(), vec![0xde, 0xad, 0xbe, 0xef]);
    a.on_feed_message(msg(11, &[t.clone()]));
    assert_eq!(a.total.txs_run, 1);
    assert_eq!(a.tip().unwrap().view().storage(pool(), U256::ZERO), known(100));
    let h = keccak256(&t);
    a.on_confirmed(confirmed(11, Arc::new(copy_at(150, 7))), &move |x: &B256| (*x == h).then(|| vec![key(pool())]));
    assert_eq!((a.total.missed_reverted, a.total.missed_ran, a.total.missed_failed), (1, 0, 0));
    let sm = a.total.samples.last().unwrap();
    assert_eq!(sm["txOk"], false);
    assert_eq!(sm["txWhy"], "revert 0x4e88422a", "{sm}");
}

/// FASTLANE_AHEAD_REVERT_UNSURE (default on, Oct 31): the same reverted
/// run now marks the pool it names unsure. The confirmed block moved it:
/// counted "unsure", never a sure-but-wrong "missedReverted".
#[test]
fn a_reverted_run_marks_its_pools_unsure_by_default() {
    assert!(AheadCfg::default().revert_unsure, "default on");
    let mut a = ahead_on(AheadCfg::default(), copy_at(100, 7));
    let t = stx(0, pool(), vec![0xde, 0xad, 0xbe, 0xef]);
    a.on_feed_message(msg(11, &[t.clone()]));
    assert_eq!(a.total.txs_run, 1);
    assert_eq!((a.total.reverts_marked, a.total.reverts_kept), (1, 0));
    let tip = a.tip().expect("prediction goes on (a revert never stops it)");
    assert!(tip.unsure_pools.contains(&key(pool())), "{:?}", tip.unsure_pools);
    assert!(matches!(tip.view().storage(pool(), U256::ZERO), Lookup::Missing), "its values are forgotten, never vouched for");
    let h = keccak256(&t);
    a.on_confirmed(confirmed(11, Arc::new(copy_at(150, 7))), &move |x: &B256| (*x == h).then(|| vec![key(pool())]));
    assert_eq!((a.total.missed_reverted, a.total.disagree), (0, 0));
    assert!(a.total.unsure >= 1);
}

/// A reverted run that names none of our pools (nothing narrows down what
/// it may touch): pools left as they were, prediction NOT stopped.
#[test]
fn a_reverted_run_naming_nothing_of_ours_keeps_the_prediction_going() {
    // OTHER: not a pool of ours, same code as POOL (a 4-byte call reverts).
    let other = addr(0x1009);
    let mut base = copy_at(100, 7);
    put(&mut base, other, pool_code(), &[(0, 1)]);
    let mut a = ahead_on(AheadCfg { run_all: true, ..AheadCfg::default() }, base);
    let t = stx(0, other, vec![0xde, 0xad, 0xbe, 0xef]);
    a.on_feed_message(msg(11, &[t]));
    assert_eq!((a.total.reverts_marked, a.total.reverts_kept), (0, 1), "{}", a.total.json_with(false));
    let tip = a.tip().expect("not stopped");
    assert!(tip.unsure_pools.is_empty(), "{:?}", tip.unsure_pools);
    assert_eq!(tip.view().storage(pool(), U256::ZERO), known(100));
}

/// The setting: unset = on, off / 0 / false / no = off.
#[test]
fn revert_unsure_setting() {
    let get = |v: Option<&str>| AheadCfg::from_lookup(|k| if k == "FASTLANE_AHEAD_REVERT_UNSURE" { v.map(String::from) } else { None }, 0).revert_unsure;
    assert!(get(None));
    assert!(get(Some("on")));
    for off in ["off", "0", "false", "NO"] {
        assert!(!get(Some(off)), "{off}");
    }
}

// ---------------------------------------------------------------------------
// 7. Late reports: rebase on a replaced version, settled agreement
// ---------------------------------------------------------------------------

/// Copy 2 replaced the version of the base block (a late report: POOL is
/// really 200 there): the prediction rebases on it at once.
#[test]
fn a_replaced_base_version_rebases_the_prediction() {
    let mut a = ahead_on(AheadCfg::default(), copy_at(100, 7));
    a.on_feed_message(msg(11, &[stx(0, pool(), w(5))]));
    assert_eq!(a.tip().unwrap().view().storage(pool(), U256::ZERO), known(105));
    a.on_confirmed(confirmed(10, Arc::new(copy_at(200, 7))), &no_moves);
    let t = a.tip().expect("re-applied on the corrected version");
    assert_eq!((t.seq, t.base_seq), (11, 10));
    assert_eq!(t.view().storage(pool(), U256::ZERO), known(205));
    assert_eq!(a.total.rebase_rewrites, 1);
    assert_eq!(a.total.compared + a.total.unpredicted, 0, "the same block: nothing compared");
}

/// Block 11's FIRST version lacks a late report (the swap we predicted):
/// compared at once that was a false "phantom". With the compare delay,
/// agreement uses the settled versions: agree.
#[test]
fn agreement_waits_for_the_settled_versions() {
    let s10 = Arc::new(copy_at(100, 7));
    let first_11 = Arc::new(copy_at(100, 7)); // published before the swap's report came
    let settled_11 = Arc::new(copy_at(105, 7)); // the late report written in
    // Old behaviour (compare at once): phantom.
    let mut now = ahead_on(AheadCfg::default(), (*s10).clone());
    now.on_feed_message(msg(11, &[stx(0, pool(), w(5))]));
    now.on_confirmed(confirmed(11, first_11.clone()), &no_moves);
    assert_eq!((now.total.phantom, now.total.agree), (1, 0), "compared with the incomplete version");
    // Delayed: compared with the settled versions.
    let mut a = ahead_on(AheadCfg { compare_delay: 2, ..AheadCfg::default() }, (*s10).clone());
    a.on_feed_message(msg(11, &[stx(0, pool(), w(5))]));
    a.on_confirmed(confirmed(11, first_11), &no_moves);
    assert_eq!(a.total.compared, 0, "waiting");
    assert!(a.due(12).is_empty() && a.due(13) == vec![11]);
    let (pools, keys, base) = a.pending_parts(11).unwrap();
    assert_eq!(keys, vec![key(pool())], "the pool our prediction moved");
    let st = Settled::build(&pools, 11, &s10, &settled_11, keys.iter(), Some(&base));
    assert_eq!(st.moved, vec![key(pool())]);
    assert!(a.compare_settled(&st, &no_moves));
    assert_eq!((a.total.agree, a.total.disagree, a.total.compared), (1, 0, 1));
    assert!(!a.compare_settled(&st, &no_moves), "compared once");
}

/// The base we predicted on was corrected later (late report for block 10:
/// POOL really 110). Our prediction for 11 (105) disagrees with the settled
/// 115: labelled staleBase (the base's miss), and counted in baseLate.
#[test]
fn a_disagreement_on_a_corrected_base_is_stale_base() {
    let s10 = Arc::new(copy_at(100, 7));
    let mut a = ahead_on(AheadCfg { compare_delay: 1, ..AheadCfg::default() }, (*s10).clone());
    a.on_feed_message(msg(11, &[stx(0, pool(), w(5))]));
    a.on_confirmed(confirmed(11, Arc::new(copy_at(115, 7))), &no_moves);
    let (pools, keys, base) = a.pending_parts(11).unwrap();
    let settled_10 = copy_at(110, 7);
    let st = Settled::build(&pools, 11, &settled_10, &copy_at(115, 7), keys.iter(), Some(&base));
    assert_eq!(st.late, vec![key(pool())]);
    a.compare_settled(&st, &no_moves);
    assert_eq!((a.total.disagree, a.total.stale_base, a.total.value_diff, a.total.base_late), (1, 1, 0, 1));
    assert_eq!(a.total.samples.last().unwrap()["kind"], "staleBase");
    assert_eq!(a.total.samples.last().unwrap()["cause"], "value");
}

// ---------------------------------------------------------------------------
// 8. Failed transactions: safer marks
// ---------------------------------------------------------------------------

/// A failed run (target unknown to our copy) naming pool P2 and coins C, D,
/// paying no ETH: P2 is marked (named), and now also
///   - P1, a native-ETH / C pool (a V4 "sell C for ETH" pays no ETH),
///   - P3, P2's sister of the same C / D pair that this router traded before
///     (a split route: before, sisters of a found pair stayed sure).
/// P4 (sister the router never traded) stays sure, as before.
#[test]
fn a_failed_run_marks_native_pools_and_the_routers_learned_sisters() {
    let (c, d) = (addr(0xc0c0), addr(0xd0d0));
    let (p1, p2, p3, p4) = (addr(0x5001), addr(0x5002), addr(0x5003), addr(0x5004));
    let stranger = addr(0x7777);
    let fp = |a: Address, t0: Address, t1: Address| (FollowedPool { key: key(a), address: a, v4_id: None }, t0, t1);
    let set = Arc::new(PoolSet::build(&[fp(p1, Address::ZERO, c), fp(p2, c, d), fp(p3, d, c), fp(p4, c, d)], HashSet::new()));
    let mut s = copy_at(100, 7);
    s.apply_fact(&Fact::Forget(stranger));
    for p in [p1, p2, p3, p4] {
        put(&mut s, p, pool_code(), &[(0, 1)]);
    }
    let mut a = Ahead::new(AheadCfg::default());
    a.set_pools(set);
    a.on_confirmed(confirmed(10, Arc::new(s.clone())), &no_moves);
    // The stranger's earlier trade moved P3 (copy 2's reports): learned.
    let mut data = vec![0u8; 12];
    data.extend_from_slice(p3.as_slice());
    let t0 = stx(0, stranger, data);
    a.on_feed_message(msg(11, &[t0.clone()]));
    let h0 = keccak256(&t0);
    a.on_confirmed(confirmed(11, Arc::new(s.clone())), &move |x: &B256| (*x == h0).then(|| vec![key(p3)]));
    assert!(a.is_toucher(&stranger));
    // Now: data names P2, C and D; no ETH paid; the target can't be run.
    let mut data = Vec::new();
    for x in [p2, c, d] {
        data.extend_from_slice(&[0u8; 12]);
        data.extend_from_slice(x.as_slice());
    }
    a.on_feed_message(msg(12, &[stx(1, stranger, data)]));
    let mut un = a.tip().unwrap().unsure_pools.clone();
    un.sort();
    let mut want = vec![key(p1), key(p2), key(p3)];
    want.sort();
    assert_eq!(un, want, "P4 (never traded by this router) stays sure");
    assert_eq!(a.total.failed_widened, 1);
}

// ---------------------------------------------------------------------------
// 9. Capture + replay round trip
// ---------------------------------------------------------------------------

/// Drives a predicted copy exactly the way the sidecar's thread does
/// (copy2/ahead.rs run_loop) and captures every event.
struct Drive {
    a: Ahead,
    cap: Capture,
    published: Vec<(u64, Arc<Snapshot>)>,
    moves: HashMap<B256, Vec<String>>,
}

impl Drive {
    fn new(cfg: AheadCfg, path: &str) -> Drive {
        let mut a = Ahead::new(cfg);
        let set = Arc::new(PoolSet::build(&pool_list(), HashSet::new()));
        a.set_pools(set);
        let mut cap = Capture::start(path, 64 << 20).unwrap();
        assert!(cap.send(CapEv::Header { cfg: a.cfg().clone(), l2_offset: 0, live: a.total.json_with(false).to_string() }));
        assert!(cap.send(CapEv::Pools { list: pool_list(), not_ready: vec![] }));
        assert!(cap.send(CapEv::Routes(None)));
        assert!(cap.send(CapEv::Touchers(a.touchers_list())));
        assert!(cap.send(CapEv::Prov(Arc::new(ProvSets::all_exact()))));
        Drive { a, cap, published: Vec::new(), moves: HashMap::new() }
    }

    fn feed(&mut self, m: Arc<BinMsg>) {
        self.a.on_feed_message(m.clone());
        assert!(self.cap.send(CapEv::Feed(m)));
    }

    /// Copy 2 publishes (or replaces) block `seq`'s version.
    fn publish(&mut self, seq: u64, snap: Snapshot, moved: &[(B256, String)]) {
        for (h, k) in moved {
            self.moves.entry(*h).or_default().push(k.clone());
        }
        let snap = Arc::new(snap);
        self.published.retain(|(s, _)| *s != seq);
        self.published.push((seq, snap.clone()));
        let asked = std::cell::RefCell::new(Vec::new());
        let mv = self.moves.clone();
        self.a.on_confirmed(confirmed(seq, snap.clone()), &|h| {
            let r = mv.get(h).cloned();
            asked.borrow_mut().push((*h, r.clone()));
            r
        });
        assert!(self.cap.send(CapEv::Moves(asked.into_inner())));
        assert!(self.cap.send(CapEv::Confirmed { seq, ctx: Some(ctx_at(seq)), snap }));
        // Agreement for blocks whose turn has come.
        let head = self.published.iter().map(|x| x.0).max().unwrap();
        for s in self.a.due(head) {
            let (pools, keys, base) = self.a.pending_parts(s).unwrap();
            let get = |n: u64| self.published.iter().find(|x| x.0 == n).map(|x| x.1.clone());
            let (Some(prev), Some(now)) = (get(s - 1), get(s)) else {
                self.a.drop_pending(s);
                continue;
            };
            let st = Settled::build(&pools, s, &prev, &now, keys.iter(), Some(&base));
            let asked = std::cell::RefCell::new(Vec::new());
            let mv = self.moves.clone();
            self.a.compare_settled(&st, &|h| {
                let r = mv.get(h).cloned();
                asked.borrow_mut().push((*h, r.clone()));
                r
            });
            assert!(self.cap.send(CapEv::Moves(asked.into_inner())));
            assert!(self.cap.send(CapEv::Settled(st)));
        }
    }
}

#[test]
fn capture_then_offline_replay_gives_the_same_counts() {
    let dir = std::env::temp_dir().join(format!("arbsim-cap-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("cap.bin").to_string_lossy().to_string();
    let mut d = Drive::new(AheadCfg { compare_delay: 1, ..AheadCfg::default() }, &path);
    d.publish(10, copy_at(100, 7), &[]);
    // 11: two swaps we run (POOL +5, POOL2 +2) and one through the router
    // the filter can't see (moves POOL by 6 on chain).
    let r = stx(2, router(), w(3));
    d.feed(msg(11, &[stx(0, pool(), w(5)), stx(1, pool2(), w(2)), r.clone()]));
    // 12: a POOL swap; its block's first version lacks a late report.
    d.feed(msg(12, &[stx(3, pool(), w(1))]));
    d.publish(11, copy_at(111, 9), &[(keccak256(&r), key(pool()))]);
    d.publish(12, copy_at(111, 9), &[]); // POOL's report for 12 not in yet
    d.publish(12, copy_at(112, 9), &[]); // ... written in: replaced version
    // 13: a reverted run on POOL2 (it really moved), a router swap now
    // learned (runs: POOL + 2 x 4).
    let bad = stx(4, pool2(), vec![1, 2, 3, 4]);
    d.feed(msg(13, &[bad.clone(), stx(5, router(), w(4))]));
    d.feed(msg(14, &[]));
    d.publish(13, copy_at(120, 50), &[(keccak256(&bad), key(pool2()))]);
    d.publish(14, copy_at(120, 50), &[]);
    d.publish(15, copy_at(120, 50), &[]);
    let live = d.a.total.clone();
    let s = d.cap.finish(d.a.total.json_with(false).to_string(), "done");
    assert!(s.complete, "{s:?}");
    assert!(live.compared >= 3, "compared {}", live.compared);
    // (FASTLANE_AHEAD_REVERT_UNSURE, default on: the reverted run on POOL2
    // in 13 now marks POOL2 unsure instead of a sure-but-wrong miss.)
    assert!(live.agree >= 3 && live.disagree >= 1, "agree {} disagree {}", live.agree, live.disagree);
    assert_eq!(live.missed_reverted, 0);
    assert!(live.reverts_marked >= 1);
    // Read back + replay.
    let cap = read_capture(&path).unwrap();
    assert!(cap.complete && cap.cut.is_none());
    let r1 = replay(&cap, &ReplayOpts::default()).unwrap();
    let r2 = replay(&cap, &ReplayOpts::default()).unwrap();
    let g = &r1["agreement"];
    assert_eq!((g["agree"].as_u64(), g["disagree"].as_u64(), g["unsure"].as_u64()), (Some(live.agree), Some(live.disagree), Some(live.unsure)), "{r1}");
    let k = &r1["disagreements"]["byKind"];
    assert_eq!(k["missedFilter"].as_u64(), Some(live.missed_filter));
    assert_eq!(k["missedReverted"].as_u64(), Some(live.missed_reverted));
    assert_eq!(r1["prediction"]["rebaseRewrites"].as_u64(), Some(live.rebase_rewrites));
    assert_eq!(r1["prediction"]["txsRun"].as_u64(), Some(live.txs_run));
    // Deterministic: the same report twice (timings aside).
    let strip = |mut v: serde_json::Value| {
        v["replay"]["tookMs"] = serde_json::Value::Null;
        v["replay"]["applyUsThisMachine"] = serde_json::Value::Null;
        v
    };
    assert_eq!(strip(r1.clone()), strip(r2));
    // The live counters of the same stretch are carried along.
    assert_eq!(r1["liveSameStretch"]["agree"].as_u64(), Some(live.agree));
    // Before / after on the same capture: `--revert-sure` (the old rule)
    // turns that unsure pool back into a sure-but-wrong missedReverted.
    let old_rule = replay(&cap, &ReplayOpts { revert_unsure: Some(false), ..Default::default() }).unwrap();
    assert_eq!(old_rule["disagreements"]["byKind"]["missedReverted"].as_u64(), Some(1), "{old_rule}");
    assert_eq!(old_rule["agreement"]["disagree"].as_u64(), Some(live.disagree + 1));
    assert_eq!(old_rule["prediction"]["revertsMarked"].as_u64(), Some(0));
    let text = print_report(&old_rule, 3);
    assert!(text.contains("AGREEMENT") && text.contains("missedReverted"), "{text}");
    let text = print_report(&r1, 3);
    assert!(text.contains("reverted runs marked unsure"), "{text}");
    eprintln!("{text}");
    // A cut-off file is read as far as it goes, and says so.
    let buf = std::fs::read(&path).unwrap();
    let cut = arbsim::copy2::ahead_capture::decode_capture(&buf[..buf.len() - 7]).unwrap();
    assert!(!cut.complete && cut.cut.is_some());
    let _ = std::fs::remove_dir_all(&dir);
}

/// The settings of the capture (FASTLANE_CAPTURE_*): unset = no capture.
#[test]
fn capture_settings() {
    use arbsim::copy2::ahead_capture::CapCfg;
    assert!(CapCfg::from_lookup(|_| None).is_none());
    let m: HashMap<&str, &str> = [("FASTLANE_CAPTURE_FILE", "/tmp/x.bin")].into_iter().collect();
    let c = CapCfg::from_lookup(|k| m.get(k).map(|s| s.to_string())).unwrap();
    assert_eq!((c.blocks, c.after.as_secs(), c.max_bytes), (300, 60, 512 << 20));
    let m: HashMap<&str, &str> = [("FASTLANE_CAPTURE_FILE", "/tmp/x.bin"), ("FASTLANE_CAPTURE_BLOCKS", "50"), ("FASTLANE_CAPTURE_AFTER_S", "0"), ("FASTLANE_CAPTURE_MAX_MB", "8")].into_iter().collect();
    let c = CapCfg::from_lookup(|k| m.get(k).map(|s| s.to_string())).unwrap();
    assert_eq!((c.blocks, c.after.as_secs(), c.max_bytes), (50, 0, 8 << 20));
    let d = AheadCfg::from_lookup(|_| None, 0);
    assert_eq!(d.compare_delay, 5, "the sidecar compares 5 blocks later by default");
    assert_eq!(AheadCfg::default().compare_delay, 0);
}

/// Routers are learned from EVERY transaction copy 2 says moved our pools,
/// also ones we ran (before: only ones the filter skipped). Here our run of
/// the router moved POOL, but on chain it also moved POOL2: when its code is
/// later unknown, a failing call marks BOTH unsure.
#[test]
fn routers_are_learned_from_transactions_we_ran_too() {
    let mut a = ahead_on(AheadCfg { run_all: true, ..AheadCfg::default() }, copy_at(100, 7));
    let r0 = stx(0, router(), w(3));
    a.on_feed_message(msg(11, &[r0.clone()]));
    let h0 = keccak256(&r0);
    let mut s11 = copy_at(106, 8);
    a.on_confirmed(confirmed(11, Arc::new(s11.clone())), &move |x: &B256| (*x == h0).then(|| vec![key(pool()), key(pool2())]));
    s11.apply_fact(&Fact::Forget(router()));
    a.on_confirmed(confirmed(12, Arc::new(s11)), &no_moves);
    a.on_feed_message(msg(13, &[stx(1, router(), w(4))]));
    let mut un = a.tip().unwrap().unsure_pools.clone();
    un.sort();
    assert_eq!(un, vec![key(pool()), key(pool2())]);
}

/// A failed call to a router whose effect can't be traced (its code is not
/// in our copy) naming ONE coin T and paying no ETH (a V4 "sell T for ETH"):
/// the ETH / T pool is marked unsure (it used to stay sure: only the
/// router's 64 first-learned pools were marked). The router's learned pools
/// not holding T stay sure. And a busy router keeps learning: its list holds
/// its 64 most RECENT pools.
#[test]
fn a_failed_sell_for_eth_marks_the_native_pool_and_busy_routers_keep_learning() {
    let tok = addr(0x7070);
    let other = addr(0x8080);
    let native = addr(0x6001);
    let ur = addr(0x9999);
    let fp = |a: Address, t0: Address, t1: Address| (FollowedPool { key: key(a), address: a, v4_id: None }, t0, t1);
    // 70 pools of OTHER / i (the router traded them all, oldest first) + the native pool.
    let many: Vec<Address> = (0..70u64).map(|i| addr(0x4000 + i)).collect();
    let mut list: Vec<_> = many.iter().enumerate().map(|(i, a)| fp(*a, other, addr(0x3000 + i as u64))).collect();
    list.push(fp(native, Address::ZERO, tok));
    let mut s = copy_at(100, 7);
    s.apply_fact(&Fact::Forget(ur));
    let mut a = Ahead::new(AheadCfg::default());
    a.set_pools(Arc::new(PoolSet::build(&list, HashSet::new())));
    a.on_confirmed(confirmed(10, Arc::new(s.clone())), &no_moves);
    // Block 11: 70 router calls, copy 2 says each moved one of the 70 pools.
    let txs: Vec<Vec<u8>> = (0..70u64).map(|i| stx(i, ur, w(i))).collect();
    a.on_feed_message(msg(11, &txs));
    let hs: Vec<B256> = txs.iter().map(keccak256).collect();
    let many2 = many.clone();
    a.on_confirmed(confirmed(11, Arc::new(s.clone())), &move |x: &B256| hs.iter().position(|h| h == x).map(|i| vec![key(many2[i])]));
    // Block 12: the router sells T for ETH (names T only, no ETH paid).
    let mut data = vec![0u8; 12];
    data.extend_from_slice(tok.as_slice());
    a.on_feed_message(msg(12, &[stx(70, ur, data)]));
    let un = a.tip().unwrap().unsure_pools.clone();
    assert_eq!(un, vec![key(native)], "only the ETH / T pool: the router's 70 OTHER pools hold no T");
    // Block 13: an opaque call (names no coin): the router's 64 most recent pools.
    a.on_confirmed(confirmed(12, Arc::new(s.clone())), &no_moves);
    a.on_feed_message(msg(13, &[stx(71, ur, w(1))]));
    let un: HashSet<String> = a.tip().unwrap().unsure_pools.iter().cloned().collect();
    assert_eq!(un.len(), 64);
    assert!(un.contains(&key(many[69])) && !un.contains(&key(many[0])), "the newest kept, the oldest dropped");
}

// ---------------------------------------------------------------------------
// Observe-mode build (Oct 31): FASTLANE_AHEAD=observe and
// FASTLANE_AHEAD_UNKNOWN_CONTINUE.
// ---------------------------------------------------------------------------

/// A picked transaction we can't run and that nothing ties to our pools
/// (its target has no code in our copy, it names nothing of ours): by
/// default the whole prediction stops (the old rule). With
/// FASTLANE_AHEAD_UNKNOWN_CONTINUE it goes on, nothing is marked, and a pool
/// that transaction really moved is counted "missedUnknown".
#[test]
fn an_unknown_effect_transaction_stops_by_default_and_is_predicted_past_when_asked() {
    let ghost = addr(0x1077); // no code in our copy
    // Default: stops.
    let mut a = ahead_on(AheadCfg { run_all: true, ..AheadCfg::default() }, copy_at(100, 7));
    a.on_feed_message(msg(11, &[stx(0, ghost, w(1))]));
    assert!(a.tip().is_none());
    assert_eq!(a.stopped().map(|s| s.1), Some("failed_tx_unknown_effect"));
    // Continue: a tip, nothing unsure, the next transaction runs exactly.
    let mut a = ahead_on(AheadCfg { run_all: true, unknown_continue: true, ..AheadCfg::default() }, copy_at(100, 7));
    let g = stx(0, ghost, w(1));
    a.on_feed_message(msg(11, &[g.clone(), stx(1, pool(), w(5))]));
    let tip = a.tip().expect("predicted past the unknown-effect transaction");
    assert!(tip.unsure_pools.is_empty(), "{:?}", tip.unsure_pools);
    assert_eq!(tip.view().storage(pool(), U256::ZERO), known(105));
    assert_eq!(a.total.unknown_continued, 1);
    // On chain the ghost transaction moved POOL2: a sure-but-wrong pool,
    // counted on its own so the rule is measured.
    let hg = keccak256(&g);
    let mut s11 = copy_at(105, 9);
    s11.apply_fact(&Fact::Slot(pool2(), U256::ZERO, U256::from(9u64)));
    a.on_confirmed(confirmed(11, Arc::new(s11)), &move |x: &B256| (*x == hg).then(|| vec![key(pool2())]));
    assert_eq!((a.total.missed_unknown, a.total.missed_failed, a.total.disagree), (1, 0, 1), "{}", a.total.json_with(false));
    assert_eq!(a.total.samples.last().unwrap()["kind"], "missedUnknown");
    assert_eq!(a.total.agree, 1, "POOL (moved by the exact run) agrees");
}

/// FASTLANE_AHEAD words and the per-mode default of
/// FASTLANE_AHEAD_UNKNOWN_CONTINUE: on in observe (nothing decides on it),
/// off with on (unchanged semantics), an explicit word always wins.
#[test]
fn ahead_mode_words_and_unknown_continue_defaults() {
    use arbsim::copy2::ahead::{ahead_wanted, AheadMode};
    assert_eq!(AheadMode::parse(None), AheadMode::Off);
    assert_eq!(AheadMode::parse(Some("")), AheadMode::Off);
    assert_eq!(AheadMode::parse(Some("junk")), AheadMode::Off);
    assert_eq!(AheadMode::parse(Some("off")), AheadMode::Off);
    for w in ["on", "ON", "1", "true", "yes"] {
        assert_eq!(AheadMode::parse(Some(w)), AheadMode::On, "{w}");
    }
    for w in ["observe", " Observe ", "watch", "measure"] {
        assert_eq!(AheadMode::parse(Some(w)), AheadMode::Observe, "{w}");
    }
    assert!(ahead_wanted(Some("observe")) && ahead_wanted(Some("on")) && !ahead_wanted(None));
    let cfg = |ahead: Option<&str>, cont: Option<&str>| {
        AheadCfg::from_lookup(
            |k| match k {
                "FASTLANE_AHEAD" => ahead.map(String::from),
                "FASTLANE_AHEAD_UNKNOWN_CONTINUE" => cont.map(String::from),
                _ => None,
            },
            0,
        )
        .unknown_continue
    };
    assert!(!cfg(None, None));
    assert!(!cfg(Some("on"), None), "on keeps the old rule");
    assert!(cfg(Some("observe"), None), "observe measures the new rule");
    assert!(!cfg(Some("observe"), Some("off")));
    assert!(cfg(Some("on"), Some("on")));
    assert!(!AheadCfg::default().unknown_continue);
}

/// The "blocks fresher" gain: per feed message, how many blocks the tip is
/// ahead of copy 2's confirmed version (0 = no tip).
#[test]
fn blocks_ahead_are_counted_per_message() {
    let mut a = ahead_on(AheadCfg::default(), copy_at(100, 7));
    a.on_feed_message(msg(11, &[stx(0, pool(), w(1))]));
    a.on_feed_message(msg(12, &[stx(1, pool(), w(1))]));
    a.on_feed_message(msg(14, &[stx(3, pool(), w(1))])); // 13 missing: no tip
    assert_eq!(a.total.ahead_blocks, vec![1, 2, 0]);
    assert_eq!(a.total.tips, 2);
    let j = a.hour.json();
    assert_eq!(j["aheadBlocks"]["max"], 2, "{j}");
    assert!(a.hour.line().contains("blocks ahead p50"), "{}", a.hour.line());
}

// ---------------------------------------------------------------------------
// The hot-contract keeper (Oct 31, copy2/keeper.rs): the predicted copy
// lays the keeper's exact values of its base block over copy 2's.
// ---------------------------------------------------------------------------

/// ROUTER reads DEP, which copy 2 does not hold: the run fails, POOL is
/// marked unsure and DEP's value is handed to the keeper to learn. When the
/// keeper's version of the base block (with DEP) arrives, the prediction is
/// rebuilt on it: the run is exact and POOL is sure, with the right value.
/// A keeper version of ANOTHER block is never used.
#[test]
fn the_keepers_values_make_a_failed_run_exact() {
    use arbsim::copy2::keeper::KeptVersion;
    use arbsim::state::MissItem;
    let mut base = copy_at(100, 7);
    base.apply_fact(&Fact::Forget(dep()));
    let mut a = ahead_on(AheadCfg { run_all: true, keeper: true, ..AheadCfg::default() }, base);
    a.on_feed_message(msg(11, &[stx(0, router(), w(3))]));
    let tip = a.tip().expect("a failed run marks its pools, it does not stop");
    assert!(tip.unsure_pools.contains(&key(pool())), "{:?}", tip.unsure_pools);
    assert!(a.learned.iter().any(|m| matches!(m, MissItem::Account(x) | MissItem::Slot(x, _) if *x == dep())), "DEP learned: {:?}", a.learned);
    assert!(!a.learned.iter().any(|m| matches!(m, MissItem::Slot(x, _) | MissItem::Account(x) if *x == pool())), "our pools are copy 2's, never the keeper's");
    // The keeper's DEP at block 10 (the base block).
    let mut k = Snapshot::default();
    put(&mut k, dep(), dep_code(), &[(0, 2)]);
    let kept = |block: u64| Arc::new(KeptVersion { block, accounts: k.accounts.clone(), codes: k.codes.clone() });
    a.on_kept(kept(9));
    assert_eq!(a.total.kept_rebases, 0, "another block's version is never used");
    a.on_kept(kept(10));
    assert_eq!(a.total.kept_rebases, 1);
    let tip = a.tip().unwrap();
    assert!(tip.unsure_pools.is_empty(), "{:?}", tip.unsure_pools);
    assert_eq!(tip.view().storage(pool(), U256::ZERO), known(106), "100 + 3 x DEP (2)");
    // The next confirmed block without a keeper version: the plain base again.
    a.on_confirmed(confirmed(11, Arc::new(copy_at(106, 7))), &no_moves);
    assert_eq!((a.total.kept_bases, a.total.kept_missing), (1, 0), "base 10 was merged");
    a.on_confirmed(confirmed(12, Arc::new(copy_at(106, 7))), &no_moves);
    assert_eq!(a.total.kept_missing, 1, "base 11 had no keeper version");
}

/// FASTLANE_AHEAD_KEEPER per-mode default: on in observe, off with on.
#[test]
fn keeper_setting_defaults() {
    let cfg = |ahead: Option<&str>, k: Option<&str>| {
        AheadCfg::from_lookup(
            |key| match key {
                "FASTLANE_AHEAD" => ahead.map(String::from),
                "FASTLANE_AHEAD_KEEPER" => k.map(String::from),
                _ => None,
            },
            0,
        )
        .keeper
    };
    assert!(!cfg(None, None) && !cfg(Some("on"), None) && cfg(Some("observe"), None));
    assert!(cfg(Some("on"), Some("on")) && !cfg(Some("observe"), Some("off")));
}
