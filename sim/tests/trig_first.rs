// ============================================================================
// Trigger-first tests (check/ordered.rs): the feed's transactions replayed in
// sequence order on a copy snapshot, then our trade.
//
// Plain English: tiny hand-written contracts stand in for the real ones:
//   POOL    a "pool" whose price is slot 0. A 32-byte call ("a swap") adds
//           the number to the price. Any other call ("our trade") reverts
//           InsufficientProfit(price, MAX), like our contract's check does,
//           so the answer tells us exactly which price our trade saw.
//   DEP     a contract the pool doesn't own (think: a coin's allowance or
//           another pool on the router's path). 32-byte call = set its
//           slot 0; empty call = read it.
//   ROUTER  what users call: reads DEP, then swaps x * DEP on POOL. So a
//           change to DEP (outside our watched pools) changes the trigger's
//           effect. ROUTER_REVERT does the same and then reverts.
// Transactions are signed with well-known test keys (never real funds).
// ============================================================================
mod check_util;

use arbsim::arb::BlockCtx;
use arbsim::check::ordered::{
    assumed_funds, build_plan, funds_error, run_ordered, run_ordered_with, AllExact, Assume, Assumed, OrderedOut, PlanInfo, Provenance, Route, WireFeed, WireFeedMsg,
};
use arbsim::check::{CallReq, CheckUnknown, Overrides, UnknownReason};
use arbsim::state::mem::MemState;
use arbsim::state::MissItem;
use check_util::*;
use revm::primitives::{keccak256, Address, Bytes, B256, U256};
use serde_json::json;

// anvil / hardhat test accounts #0 and #1 (public test keys, no funds).
const KEY_A: [u8; 32] = [
    0xac, 0x09, 0x74, 0xbe, 0xc3, 0x9a, 0x17, 0xe3, 0x6b, 0xa4, 0xa6, 0xb4, 0xd2, 0x38, 0xff, 0x94, 0x4b, 0xac, 0xb4,
    0x78, 0xcb, 0xed, 0x5e, 0xfc, 0xae, 0x78, 0x4d, 0x7b, 0xf4, 0xf2, 0xff, 0x80,
];
const KEY_B: [u8; 32] = [
    0x59, 0xc6, 0x99, 0x5e, 0x99, 0x8f, 0x97, 0xa5, 0xa0, 0x04, 0x49, 0x66, 0xf0, 0x94, 0x53, 0x89, 0xdc, 0x9e, 0x86,
    0xda, 0xe8, 0x8c, 0x7a, 0x84, 0x12, 0xf4, 0x60, 0x3b, 0x6b, 0x78, 0x69, 0x0d,
];

fn pool() -> Address {
    addr(0x1001)
}
fn dep() -> Address {
    addr(0x1002)
}
fn router() -> Address {
    addr(0x1003)
}
fn router_revert() -> Address {
    addr(0x1004)
}
fn reads_sender_balance() -> Address {
    addr(0x1005)
}
fn reads_basefee() -> Address {
    addr(0x1006)
}
fn caller() -> Address {
    addr(0xca11)
}

fn pool_code() -> Vec<u8> {
    hex("36 6020 14 6023 57 634e88422a 60e0 1b 6000 52 6000 54 6004 52 6000 19 6024 52 6044 6000 fd 5b 6000 35 6000 54 01 6000 55 00")
}
fn dep_code() -> Vec<u8> {
    hex("36 6020 14 6012 57 6000 54 6000 52 6020 6000 f3 5b 6000 35 6000 55 00")
}
fn router_code(revert: bool) -> Vec<u8> {
    let mut c = hex("6020 6000 6000 6000 73");
    c.extend_from_slice(dep().as_slice());
    c.extend(hex("5a fa 50 6000 51 6000 35 02 6000 52 6000 6000 6020 6000 6000 73"));
    c.extend_from_slice(pool().as_slice());
    c.extend(hex("5a f1 50"));
    c.extend(if revert { hex("6000 6000 fd") } else { hex("00") });
    c
}

/// The copy: pool price 100, DEP = 2, plus the helper contracts. Strict:
/// anything not listed is MISSING (like copy 2).
fn copy() -> MemState {
    let mut s = state_with(
        &[
            (pool(), pool_code(), vec![(U256::ZERO, U256::from(100u64))]),
            (dep(), dep_code(), vec![(U256::ZERO, U256::from(2u64))]),
            (router(), router_code(false), vec![]),
            (router_revert(), router_code(true), vec![]),
            (reads_sender_balance(), hex("33 31 50 00"), vec![]),
            (reads_basefee(), hex("48 50 00"), vec![]),
        ],
        true,
    );
    add_eoa(&mut s, caller(), U256::ZERO);
    s
}

/// The snapshot's block details: block 10 (sequence 10, offset 0).
fn base() -> BlockCtx {
    BlockCtx { l1_block_number: 500, l2_block_number: Some(10), timestamp: 1_700_000_000, basefee: 0, coinbase: Address::ZERO, gas_limit: 1 << 50, prevrandao: B256::with_last_byte(1) }
}

fn w(v: u64) -> Vec<u8> {
    word(U256::from(v)).to_vec()
}

/// A signed transaction (type 2) to `to` with `data`.
fn stx(key: &[u8; 32], nonce: u64, to: Address, data: Vec<u8>) -> Vec<u8> {
    sign_typed(key, 2, &TestTx { nonce, gas: 300_000, to: Some(to), value: U256::ZERO, data, access_list: vec![] }, 4663)
}

fn hexs(b: &[u8]) -> String {
    format!("0x{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())
}

fn msg(seq: u64, txs: &[Vec<u8>]) -> WireFeedMsg {
    WireFeedMsg { seq, ts: 1_700_000_000 + seq, l1: 500, txs: txs.iter().map(|t| hexs(t)).collect(), complete: true, why: None }
}

fn feed(trigger: &[u8], trigger_seq: u64, msgs: Vec<WireFeedMsg>) -> WireFeed {
    WireFeed { trigger: hexs(keccak256(trigger).as_slice()), trigger_seq, msgs, route: vec![], strict: false, assume: None }
}

/// Our trade: any non-32-byte call to the pool (reverts with the price).
fn our_trade() -> CallReq {
    let mut data = hex("deadbeef");
    data.extend(w(1));
    CallReq { from: caller(), to: Some(pool()), data: Bytes::from(data), gas: Some(1_000_000), value: U256::ZERO }
}

/// The price our trade saw (InsufficientProfit's first word).
fn price_seen(out: &OrderedOut) -> u64 {
    let o = &out.results[0];
    assert!(!o.success);
    assert_eq!(&o.output[..4], &hex("4e88422a")[..]);
    U256::from_be_slice(&o.output[4..36]).to::<u64>()
}

fn run(view: &MemState, f: &WireFeed, snap_seq: u64, ov: &Overrides) -> Result<(OrderedOut, PlanInfo), CheckUnknown> {
    let mut b = base();
    b.l2_block_number = Some(snap_seq);
    let (plan, info) = build_plan(f, snap_seq, 0, &b)?;
    run_ordered(view, &plan, ov, &[our_trade()], &AllExact, true).map(|o| (o, info))
}

fn reason(r: Result<(OrderedOut, PlanInfo), CheckUnknown>) -> UnknownReason {
    match r {
        Ok((o, _)) => panic!("expected unknown, got an answer: {o:?}"),
        Err(u) => u.reason,
    }
}

#[test]
fn successful_trigger_then_our_trade_sees_the_moved_price() {
    let trig = stx(&KEY_A, 0, pool(), w(5));
    let (out, info) = run(&copy(), &feed(&trig, 11, vec![msg(11, &[trig.clone()])]), 10, &Overrides::none()).unwrap();
    assert_eq!(price_seen(&out), 105, "trigger applied once, before our trade");
    assert!(out.replayed[0].outcome.success);
    assert_eq!((info.included, info.msgs, info.txs, info.later, info.last_seq), (false, 1, 1, 0, 11));
    // The copy itself is untouched (scratch pad only).
    let again = run(&copy(), &feed(&trig, 11, vec![msg(11, &[trig.clone()])]), 10, &Overrides::none()).unwrap();
    assert_eq!(price_seen(&again.0), 105);
}

#[test]
fn reverted_trigger_leaves_the_state_unchanged() {
    let trig = stx(&KEY_A, 0, router_revert(), w(5));
    let (out, _) = run(&copy(), &feed(&trig, 11, vec![msg(11, &[trig.clone()])]), 10, &Overrides::none()).unwrap();
    assert!(!out.replayed[0].outcome.success, "the trigger reverts");
    assert_eq!(price_seen(&out), 100, "its swap is rolled back: our trade sees the old price");
}

#[test]
fn missing_state_is_unknown_with_the_items_to_fetch() {
    let nowhere = addr(0xdead);
    let trig = stx(&KEY_A, 0, nowhere, w(5));
    let r = run(&copy(), &feed(&trig, 11, vec![msg(11, &[trig.clone()])]), 10, &Overrides::none());
    let u = r.expect_err("unknown");
    assert_eq!(u.reason, UnknownReason::Miss);
    assert!(u.missing.contains(&MissItem::Account(nowhere)), "{u:?}");
    // A missing slot of a known contract too.
    let mut c = copy();
    c.storage.get_mut(&dep()).unwrap().clear();
    let trig = stx(&KEY_A, 0, router(), w(5));
    let u = run(&c, &feed(&trig, 11, vec![msg(11, &[trig.clone()])]), 10, &Overrides::none()).expect_err("unknown");
    assert!(u.missing.contains(&MissItem::Slot(dep(), U256::ZERO)), "{u:?}");
}

#[test]
fn preceding_tx_on_a_non_watched_dependency_is_applied_first() {
    // Trigger through the router: x * DEP. DEP is 2 in the copy.
    let trig = stx(&KEY_A, 0, router(), w(5));
    let (out, _) = run(&copy(), &feed(&trig, 12, vec![msg(11, &[]), msg(12, &[trig.clone()])]), 10, &Overrides::none()).unwrap();
    assert_eq!(price_seen(&out), 110, "5 x 2");
    // Someone sets DEP to 3 one message before the trigger: 5 x 3.
    let set = stx(&KEY_B, 0, dep(), w(3));
    let (out, info) = run(&copy(), &feed(&trig, 12, vec![msg(11, &[set.clone()]), msg(12, &[trig.clone()])]), 10, &Overrides::none()).unwrap();
    assert_eq!(price_seen(&out), 115, "the earlier change to DEP is applied first");
    assert_eq!(info.txs, 2);
    // ... and in the SAME message, before the trigger: same.
    let (out, _) = run(&copy(), &feed(&trig, 12, vec![msg(11, &[]), msg(12, &[set.clone(), trig.clone()])]), 10, &Overrides::none()).unwrap();
    assert_eq!(price_seen(&out), 115);
    // A preceding transaction we can't apply (needs state we don't hold).
    let bad = stx(&KEY_B, 0, addr(0xbad), w(1));
    assert_eq!(reason(run(&copy(), &feed(&trig, 12, vec![msg(11, &[bad]), msg(12, &[trig.clone()])]), 10, &Overrides::none())), UnknownReason::Miss);
    // A preceding message the bot couldn't unpack (e.g. a deposit).
    let mut dep_msg = msg(11, &[]);
    dep_msg.complete = false;
    dep_msg.why = Some("header kind 12 (deposit)".into());
    assert_eq!(reason(run(&copy(), &feed(&trig, 12, vec![dep_msg, msg(12, &[trig.clone()])]), 10, &Overrides::none())), UnknownReason::FeedUnreplayable);
}

#[test]
fn txs_after_the_trigger_and_before_our_send_are_applied() {
    let trig = stx(&KEY_A, 0, pool(), w(5));
    let after_same_msg = stx(&KEY_B, 0, pool(), w(1));
    let next_msg = stx(&KEY_B, 1, pool(), w(2));
    let f = feed(&trig, 11, vec![msg(11, &[trig.clone(), after_same_msg]), msg(12, &[next_msg])]);
    let (out, info) = run(&copy(), &f, 10, &Overrides::none()).unwrap();
    assert_eq!(price_seen(&out), 108, "100 + 5 (trigger) + 1 + 2 (sequenced after it, before us)");
    assert_eq!((info.later, info.last_seq), (2, 12));
}

#[test]
fn sequence_gaps_and_uncertain_order_are_unknown() {
    let trig = stx(&KEY_A, 0, pool(), w(5));
    // Copy at 10, messages start at 12: message 11 unknown.
    assert_eq!(reason(run(&copy(), &feed(&trig, 12, vec![msg(12, &[trig.clone()])]), 10, &Overrides::none())), UnknownReason::FeedGap);
    // A hole in the middle.
    assert_eq!(reason(run(&copy(), &feed(&trig, 13, vec![msg(11, &[]), msg(13, &[trig.clone()])]), 10, &Overrides::none())), UnknownReason::FeedGap);
    // The trigger's own message not given.
    assert_eq!(reason(run(&copy(), &feed(&trig, 12, vec![msg(11, &[])]), 10, &Overrides::none())), UnknownReason::FeedGap);
    // Trigger twice / in another message than said / not in its message.
    assert_eq!(reason(run(&copy(), &feed(&trig, 11, vec![msg(11, &[trig.clone(), trig.clone()])]), 10, &Overrides::none())), UnknownReason::FeedOrder);
    assert_eq!(reason(run(&copy(), &feed(&trig, 12, vec![msg(11, &[trig.clone()]), msg(12, &[])]), 10, &Overrides::none())), UnknownReason::FeedOrder);
    assert_eq!(reason(run(&copy(), &feed(&trig, 11, vec![msg(11, &[])]), 10, &Overrides::none())), UnknownReason::FeedOrder);
    // Messages out of order / repeated.
    assert_eq!(reason(run(&copy(), &feed(&trig, 12, vec![msg(12, &[trig.clone()]), msg(11, &[])]), 10, &Overrides::none())), UnknownReason::FeedOrder);
    // The snapshot's block doesn't match its sequence number.
    let mut b = base();
    b.l2_block_number = Some(99);
    let e = build_plan(&feed(&trig, 11, vec![msg(11, &[trig.clone()])]), 10, 0, &b).expect_err("misaligned");
    assert_eq!(e.reason, UnknownReason::FeedOrder);
    // Too far behind.
    let many: Vec<WireFeedMsg> = (11..11 + 200).map(|s| msg(s, &[])).collect();
    assert_eq!(reason(run(&copy(), &feed(&trig, 300, many), 10, &Overrides::none())), UnknownReason::FeedGap);
}

#[test]
fn trigger_already_in_the_copy_is_not_applied_twice() {
    // The copy is at block 12 and already holds the trigger (price 105).
    let mut c = copy();
    c.storage.get_mut(&pool()).unwrap().insert(U256::ZERO, U256::from(105u64));
    let trig = stx(&KEY_A, 0, pool(), w(5));
    let later = stx(&KEY_B, 0, pool(), w(1));
    let f = feed(&trig, 12, vec![msg(11, &[]), msg(12, &[trig.clone()]), msg(13, &[later])]);
    let (out, info) = run(&c, &f, 12, &Overrides::none()).unwrap();
    assert!(info.included);
    assert_eq!(price_seen(&out), 106, "only the later tx is applied (never the trigger again: 111)");
    assert!(out.replayed.iter().all(|r| r.hash != keccak256(&trig)));
    // Nothing after it: our trade runs directly on the copy.
    let (out, info) = run(&c, &feed(&trig, 12, vec![msg(12, &[trig.clone()])]), 12, &Overrides::none()).unwrap();
    assert_eq!((price_seen(&out), info.txs, info.included), (105, 0, true));
    // Copy ahead of everything the bot has: still fine.
    let (out, _) = run(&c, &feed(&trig, 12, vec![]), 14, &Overrides::none()).unwrap();
    assert_eq!(price_seen(&out), 105);
    // But the trigger can't be "in the copy" and also be given after it.
    assert_eq!(reason(run(&c, &feed(&trig, 12, vec![msg(13, &[trig.clone()])]), 12, &Overrides::none())), UnknownReason::FeedOrder);
}

#[test]
fn funding_override_overlapping_what_the_trigger_reads_is_unknown() {
    let trig = stx(&KEY_A, 0, pool(), w(5));
    let f = feed(&trig, 11, vec![msg(11, &[trig.clone()])]);
    // Pretending the pool's price slot: the trigger reads it -> unknown.
    let ov = Overrides::from_json(&json!({ format!("{}", pool()): { "stateDiff": { "0x0": "0x7" } } })).unwrap();
    assert_eq!(reason(run(&copy(), &f, 10, &ov)), UnknownReason::FundingOverlap);
    // Pretending basics of an account the trigger touches -> unknown.
    let ov = Overrides::from_json(&json!({ format!("{}", pool()): { "balance": "0x1" } })).unwrap();
    assert_eq!(reason(run(&copy(), &f, 10, &ov)), UnknownReason::FundingOverlap);
    // A slot the trigger never reads (our contract's funding elsewhere):
    // provably no difference to it -> answered.
    let ov = Overrides::from_json(&json!({ format!("{}", pool()): { "stateDiff": { "0x5": "0x7" } }, format!("{}", addr(0x5e)): { "code": "0x00", "balance": "0x0", "nonce": "0x0" } })).unwrap();
    let (out, _) = run(&copy(), &f, 10, &ov).unwrap();
    assert_eq!(price_seen(&out), 105);
}

#[test]
fn replayed_tx_looking_at_what_we_only_pretend_is_unknown() {
    // Reads its own (unknown) sender's ETH balance.
    let t = stx(&KEY_A, 0, reads_sender_balance(), vec![]);
    let r = run(&copy(), &feed(&t, 11, vec![msg(11, &[t.clone()])]), 10, &Overrides::none());
    assert_eq!(reason(r), UnknownReason::ReplayWatch);
    // Reads BASEFEE (the block's real base fee isn't known).
    let t = stx(&KEY_A, 0, reads_basefee(), vec![]);
    assert_eq!(reason(run(&copy(), &feed(&t, 11, vec![msg(11, &[t.clone()])]), 10, &Overrides::none())), UnknownReason::ReplayWatch);
    // A later tx sends to the earlier tx's (unknown, pretended) sender.
    let trig = stx(&KEY_A, 0, pool(), w(5));
    let to_sender = sign_typed(&KEY_B, 2, &TestTx { nonce: 0, gas: 100_000, to: Some(key_address(&KEY_A)), value: U256::from(1u8), data: vec![], access_list: vec![] }, 4663);
    let r = run(&copy(), &feed(&trig, 11, vec![msg(11, &[trig.clone(), to_sender])]), 10, &Overrides::none());
    assert_eq!(reason(r), UnknownReason::ReplayWatch);
}

#[test]
fn unsupported_tx_kinds_in_the_range_are_unknown() {
    let trig = stx(&KEY_A, 0, pool(), w(5));
    let mut m = msg(11, &[trig.clone()]);
    m.txs.insert(0, "0x03c0".into()); // a blob transaction (type 3)
    assert_eq!(reason(run(&copy(), &feed(&trig, 11, vec![m]), 10, &Overrides::none())), UnknownReason::UnsupportedTx);
}

/// Benchmark (TEST NUMBERS, tiny contracts on an in-memory state, not live
/// numbers): time of one trigger-first run with 1 and with 20 replayed txs.
#[test]
fn bench_trigger_first_run_time_test_numbers_only() {
    let c = copy();
    let trig = stx(&KEY_A, 0, router(), w(5));
    let mut msgs: Vec<WireFeedMsg> = Vec::new();
    for s in 0..19u64 {
        msgs.push(msg(11 + s, &[stx(&KEY_B, s, pool(), w(1))]));
    }
    msgs.push(msg(30, &[trig.clone()]));
    let f = feed(&trig, 30, msgs);
    let one = feed(&trig, 11, vec![msg(11, &[trig.clone()])]);
    let t = std::time::Instant::now();
    for _ in 0..50 {
        run(&c, &one, 10, &Overrides::none()).unwrap();
    }
    let t1 = t.elapsed().as_micros() / 50;
    let t = std::time::Instant::now();
    for _ in 0..20 {
        run(&c, &f, 10, &Overrides::none()).unwrap();
    }
    let t20 = t.elapsed().as_micros() / 20;
    println!("[bench, test numbers only] trigger-first run: 1 tx {t1} us, 20 txs {t20} us ({} build: plan + decode + replay + our call)", if cfg!(debug_assertions) { "debug" } else { "release" });
}

/// Copy 2's provenance in miniature: only the listed accounts' values (and
/// balances) are exact at the snapshot's block; everything else is a fill.
struct Followed(Vec<Address>);
impl Provenance for Followed {
    fn slot_exact(&self, a: Address, _s: U256) -> bool {
        self.0.contains(&a)
    }
    fn balance_exact(&self, a: Address) -> bool {
        self.0.contains(&a)
    }
}

fn run_prov(f: &WireFeed, snap_seq: u64, prov: &dyn Provenance, strict_call: bool, calls: &[CallReq]) -> Result<OrderedOut, CheckUnknown> {
    let mut b = base();
    b.l2_block_number = Some(snap_seq);
    let (plan, _) = build_plan(f, snap_seq, 0, &b)?;
    run_ordered(&copy(), &plan, &Overrides::none(), calls, prov, strict_call)
}

#[test]
fn values_copy_2_does_not_follow_exactly_are_never_replayed_on() {
    // The pool is followed; DEP (think: a coin's allowance, another pool)
    // is only a fill. A trigger through the router reads DEP: unknown.
    let trig = stx(&KEY_A, 0, router(), w(5));
    let f = feed(&trig, 11, vec![msg(11, &[trig.clone()])]);
    let followed = Followed(vec![pool(), router()]);
    let u = run_prov(&f, 10, &followed, true, &[our_trade()]).expect_err("stale");
    assert_eq!(u.reason, UnknownReason::StaleFill, "{u:?}");
    assert!(u.detail.contains("replayed"), "{}", u.detail);
    // With DEP followed too: answered (5 x 2).
    let all = Followed(vec![pool(), router(), dep()]);
    let out = run_prov(&f, 10, &all, true, &[our_trade()]).unwrap();
    assert_eq!(price_seen(&out), 110);
    // A trigger touching only followed values: answered.
    let direct = stx(&KEY_A, 0, pool(), w(5));
    let out = run_prov(&feed(&direct, 11, vec![msg(11, &[direct.clone()])]), 10, &Followed(vec![pool()]), true, &[our_trade()]).unwrap();
    assert_eq!(price_seen(&out), 105);
}

#[test]
fn our_call_on_a_fill_is_unknown_when_strict_and_trusted_in_copy2_mode() {
    // Trigger already in the copy (nothing replayed). Our call reads DEP
    // through the router's read path: a DEP read = a fill.
    let trig = stx(&KEY_A, 0, pool(), w(5));
    let f = feed(&trig, 10, vec![]);
    let read_dep = CallReq { from: caller(), to: Some(dep()), data: Bytes::new(), gas: Some(100_000), value: U256::ZERO };
    let followed = Followed(vec![pool()]);
    let u = run_prov(&f, 10, &followed, true, &[read_dep.clone()]).expect_err("strict");
    assert_eq!(u.reason, UnknownReason::StaleFill);
    assert!(u.detail.contains("our call"), "{}", u.detail);
    let out = run_prov(&f, 10, &followed, false, &[read_dep]).unwrap();
    assert_eq!(U256::from_be_slice(&out.results[0].output), U256::from(2u8), "copy-2 trust: the held value");
}

#[test]
fn eth_balances_copy_2_does_not_follow_are_stale_for_replays() {
    // A replayed tx reads the ETH balance of the (known) pool contract.
    let mut c = copy();
    add_contract(&mut c, addr(0x1007), hex("73").into_iter().chain(pool().as_slice().iter().copied()).chain(hex("31 50 00")).collect(), &[]);
    let t = stx(&KEY_A, 0, addr(0x1007), vec![]);
    let mut b = base();
    b.l2_block_number = Some(10);
    let (plan, _) = build_plan(&feed(&t, 11, vec![msg(11, &[t.clone()])]), 10, 0, &b).unwrap();
    let u = run_ordered(&c, &plan, &Overrides::none(), &[our_trade()], &Followed(vec![pool(), addr(0x1007)]), true);
    assert!(u.is_ok(), "{u:?}");
    let u = run_ordered(&c, &plan, &Overrides::none(), &[our_trade()], &NoBalances(vec![pool(), addr(0x1007)]), true).expect_err("stale balance");
    assert_eq!(u.reason, UnknownReason::StaleFill, "{u:?}");
}

/// Storage of the listed accounts exact, no ETH balance exact.
struct NoBalances(Vec<Address>);
impl Provenance for NoBalances {
    fn slot_exact(&self, a: Address, _s: U256) -> bool {
        self.0.contains(&a)
    }
    fn balance_exact(&self, _a: Address) -> bool {
        false
    }
}


// ============================================================================
// BEST EFFORT (Oct 23): named assumptions instead of "unknown".
//
//   COIN       a coin: called with (owner, amount), it takes `amount` from
//              balance[owner] (slot keccak(owner . 0)); not enough ->
//              reverts ERC20InsufficientBalance.
//   COIN_NONCE like a Permit2 nonce check: balance[owner] must be exactly 7,
//              else reverts InvalidNonce().
//   ROUTER_F   what users call with (x, limit): pulls x of COIN from the
//              caller (its SENDER's funds), swaps x on POOL, then reads the
//              pool price and reverts "SLIP" if it is above `limit` (its own
//              slippage limit, computed from the pool: exact).
//   ROUTER_MISS swaps on POOL, then calls an account nobody holds.
// ============================================================================
fn coin() -> Address {
    addr(0x2001)
}
fn coin_nonce() -> Address {
    addr(0x2002)
}
fn router_f() -> Address {
    addr(0x2003)
}
fn router_f_nonce() -> Address {
    addr(0x2004)
}
fn router_miss() -> Address {
    addr(0x2005)
}

fn sel(sig: &str) -> [u8; 4] {
    let h = keccak256(sig.as_bytes());
    [h[0], h[1], h[2], h[3]]
}

/// PUSH4 selector, shift it to the top, store at 0, REVERT(0, 4).
fn revert_with(sel4: [u8; 4]) -> Vec<u8> {
    let mut c = vec![0x63];
    c.extend_from_slice(&sel4);
    c.extend(hex("60e0 1b 6000 52 6004 6000 fd"));
    c
}

/// Write a 2-byte jump target at `at`.
fn patch(c: &mut [u8], at: usize, to: usize) {
    c[at] = (to >> 8) as u8;
    c[at + 1] = to as u8;
}

/// keccak(owner . 0) of calldata word 0: the owner's place.
fn owner_place() -> Vec<u8> {
    hex("6000 35 6000 52 6000 6020 52 6040 6000 20")
}

fn coin_code() -> Vec<u8> {
    let mut c = owner_place();
    // DUP1 SLOAD CALLDATALOAD(32) DUP1 DUP3 LT PUSH2 fail JUMPI
    c.extend(hex("80 54 6020 35 80 82 10 61"));
    let j = c.len();
    c.extend([0, 0, 0x57]);
    // SWAP1 SUB SWAP1 SSTORE STOP
    c.extend(hex("90 03 90 55 00"));
    let fail = c.len();
    c.push(0x5b);
    c.extend(revert_with(sel("ERC20InsufficientBalance(address,uint256,uint256)")));
    patch(&mut c, j, fail);
    c
}

fn coin_nonce_code() -> Vec<u8> {
    let mut c = owner_place();
    // SLOAD, == 7 ? ok : revert InvalidNonce()
    c.extend(hex("54 6007 14 61"));
    let j = c.len();
    c.extend([0, 0, 0x57]);
    c.extend(revert_with(sel("InvalidNonce()")));
    let ok = c.len();
    c.extend(hex("5b 00"));
    patch(&mut c, j, ok);
    c
}

/// CALL(gas, to, 0, args 0..size, no return copy).
fn call_to(c: &mut Vec<u8>, to: Address, size: u8) {
    c.extend(hex("6000 6000 60"));
    c.push(size);
    c.extend(hex("6000 6000 73"));
    c.extend_from_slice(to.as_slice());
    c.extend(hex("5a f1"));
}

fn router_f_code(the_coin: Address) -> Vec<u8> {
    // mem[0] = CALLER, mem[32] = x; coin.call(owner, x); failed -> bubble
    let mut c = hex("33 6000 52 6000 35 6020 52");
    call_to(&mut c, the_coin, 0x40);
    c.extend(hex("15 61"));
    let j_bubble = c.len();
    c.extend([0, 0, 0x57]);
    // swap x on POOL
    c.extend(hex("6000 35 6000 52"));
    call_to(&mut c, pool(), 0x20);
    c.push(0x50);
    // the price: POOL reverts InsufficientProfit(price, MAX) for 36 bytes
    call_to(&mut c, pool(), 0x24);
    c.push(0x50);
    // RETURNDATACOPY(0, 4, 32); price > limit -> SLIP
    c.extend(hex("6020 6004 6000 3e 6000 51 6020 35 10 61"));
    let j_slip = c.len();
    c.extend([0, 0, 0x57, 0x00]);
    let bubble = c.len();
    c.extend(hex("5b 3d 6000 6000 3e 3d 6000 fd"));
    let slip = c.len();
    c.push(0x5b);
    c.extend(revert_with(*b"SLIP"));
    patch(&mut c, j_bubble, bubble);
    patch(&mut c, j_slip, slip);
    c
}

fn router_miss_code() -> Vec<u8> {
    let mut c = hex("6000 35 6000 52");
    call_to(&mut c, pool(), 0x20);
    c.push(0x50);
    call_to(&mut c, addr(0xbad2), 0);
    c.extend(hex("50 00"));
    c
}

/// The copy plus the best-effort contracts. `holder_balance`: the coin
/// balance the copy holds for KEY_A (None = not held: missing).
fn copy_be(holder_balance: Option<u64>) -> MemState {
    let mut s = copy();
    let place = keccak256([key_address(&KEY_A).into_word().as_slice(), &[0u8; 32]].concat());
    let held: Vec<(U256, U256)> = holder_balance.map(|b| vec![(U256::from_be_bytes(place.0), U256::from(b))]).unwrap_or_default();
    add_contract(&mut s, coin(), coin_code(), &held);
    add_contract(&mut s, coin_nonce(), coin_nonce_code(), &[]);
    add_contract(&mut s, router_f(), router_f_code(coin()), &[]);
    add_contract(&mut s, router_f_nonce(), router_f_code(coin_nonce()), &[]);
    add_contract(&mut s, router_miss(), router_miss_code(), &[]);
    s
}

fn route() -> Route {
    Route { accounts: [pool()].into_iter().collect(), ..Route::default() }
}

fn best() -> Assume {
    Assume { sender_funds: true, recent_fill: true, skip: Some(route()), record_hashes: false }
}

fn run_be(view: &MemState, f: &WireFeed, prov: &dyn Provenance, assume: &Assume) -> Result<OrderedOut, CheckUnknown> {
    let mut b = base();
    b.l2_block_number = Some(10);
    let (plan, _) = build_plan(f, 10, 0, &b)?;
    run_ordered_with(view, &plan, &Overrides::none(), &[our_trade()], prov, true, assume)
}

fn xl(x: u64, limit: u64) -> Vec<u8> {
    [w(x), w(limit)].concat()
}

#[test]
fn assumed_funds_reads_as_plenty_in_common_layouts() {
    let v = assumed_funds();
    let low160 = v & ((U256::from(1u8) << 160usize) - U256::from(1u8));
    assert!(low160 >= U256::from(1u8) << 150usize, "Permit2 amount");
    let exp = (v >> 160usize) & ((U256::from(1u8) << 48usize) - U256::from(1u8));
    assert_eq!(exp, (U256::from(1u8) << 48usize) - U256::from(1u8), "Permit2 expiration: never");
    assert_eq!(v >> 208usize, U256::ZERO, "Permit2 nonce 0");
    let low96 = v & ((U256::from(1u8) << 96usize) - U256::from(1u8));
    assert!(low96 >= U256::from(1u8) << 90usize && low96 < U256::from(1u8) << 95usize, "a 96-bit amount: big, with room to add");
    assert_eq!(funds_error(&sel("InvalidNonce()")), Some("InvalidNonce()"));
    let mut wrapped = vec![0xaa; 68];
    wrapped.extend_from_slice(&sel("ERC20InsufficientBalance(address,uint256,uint256)"));
    assert!(funds_error(&wrapped).is_some(), "found inside a router's wrapped error too");
    assert_eq!(funds_error(b"SLIP"), None, "a slippage revert is not a funds error");
}

#[test]
fn sender_funds_trigger_whose_coin_balance_we_dont_hold_is_answered_medium() {
    let trig = stx(&KEY_A, 0, router_f(), xl(5, 1_000));
    let f = feed(&trig, 11, vec![msg(11, &[trig.clone()])]);
    // Strict: the sender's coin balance isn't in the copy -> unknown (miss).
    let u = run_be(&copy_be(None), &f, &AllExact, &Assume::default()).expect_err("strict");
    assert_eq!(u.reason, UnknownReason::Miss, "{u:?}");
    assert!(u.missing.iter().any(|m| matches!(m, MissItem::Slot(a, _) if *a == coin())), "{u:?}");
    // Best effort: assumed enough; the pool effect is exact (5 on 100).
    let out = run_be(&copy_be(None), &f, &AllExact, &best()).unwrap();
    assert!(out.replayed[0].outcome.success, "the trigger succeeds");
    assert_eq!(price_seen(&out), 105);
    assert_eq!(out.assumed, Assumed { sender_funds: true, ..Assumed::default() });
    assert_eq!(out.assumed.confidence(), "medium");
    assert_eq!(out.assumed.labels(), vec!["sender_funds".to_string()]);
    // The copy holds an exact, sufficient balance: nothing assumed, high.
    let out = run_be(&copy_be(Some(50)), &f, &AllExact, &best()).unwrap();
    assert_eq!((price_seen(&out), out.assumed.confidence()), (105, "high"));
}

#[test]
fn sender_funds_trigger_reverting_on_its_own_slippage_limit_is_computed_exactly() {
    // Limit 102, but the swap moves the price to 105: the trigger reverts
    // on its own limit (computed from the pool), so our trade sees 100.
    let trig = stx(&KEY_A, 0, router_f(), xl(5, 102));
    let out = run_be(&copy_be(None), &feed(&trig, 11, vec![msg(11, &[trig.clone()])]), &AllExact, &best()).unwrap();
    assert!(!out.replayed[0].outcome.success, "the trigger reverts");
    assert_eq!(&out.replayed[0].outcome.output[..], b"SLIP", "on its slippage limit");
    assert_eq!(price_seen(&out), 100, "rolled back: our trade sees the old price");
    assert_eq!(out.assumed.confidence(), "medium");
    // A held, exact balance that is too small: a real, exact revert (no assumption).
    let trig = stx(&KEY_A, 0, router_f(), xl(5, 1_000));
    let out = run_be(&copy_be(Some(1)), &feed(&trig, 11, vec![msg(11, &[trig.clone()])]), &AllExact, &best()).unwrap();
    assert!(!out.replayed[0].outcome.success);
    assert_eq!((price_seen(&out), out.assumed.confidence()), (100, "high"));
}

#[test]
fn sender_funds_revert_with_a_nonce_error_after_an_assumed_value_is_unknown() {
    // Our assumed value (nonce 0) is not the 7 the transaction signed for:
    // it fails InvalidNonce -> our guess may be the cause -> unknown.
    let trig = stx(&KEY_A, 0, router_f_nonce(), xl(5, 1_000));
    let u = run_be(&copy_be(None), &feed(&trig, 11, vec![msg(11, &[trig.clone()])]), &AllExact, &best()).expect_err("unknown");
    assert_eq!(u.reason, UnknownReason::SenderFunds, "{u:?}");
}

#[test]
fn sender_funds_value_held_as_a_fill_is_labelled_sender_funds_not_recent_fill() {
    let trig = stx(&KEY_A, 0, router_f(), xl(5, 1_000));
    let f = feed(&trig, 11, vec![msg(11, &[trig.clone()])]);
    // Copy 2 follows the pool and the routers exactly; the coin is a fill.
    let followed = Followed(vec![pool(), router_f()]);
    let out = run_be(&copy_be(Some(50)), &f, &followed, &best()).unwrap();
    assert_eq!(price_seen(&out), 105);
    assert_eq!(out.assumed, Assumed { sender_funds: true, ..Assumed::default() });
    // Strict: stale fill.
    assert_eq!(run_be(&copy_be(Some(50)), &f, &followed, &Assume::default()).expect_err("strict").reason, UnknownReason::StaleFill);
}

#[test]
fn replayed_tx_reading_its_senders_eth_balance_is_assumed_with_sender_funds() {
    let t = stx(&KEY_A, 0, reads_sender_balance(), vec![]);
    let out = run_be(&copy_be(None), &feed(&t, 11, vec![msg(11, &[t.clone()])]), &AllExact, &best()).unwrap();
    assert_eq!((price_seen(&out), out.assumed.labels()), (100, vec!["sender_funds".to_string()]));
    // BASEFEE stays unknown (we don't know the block's real value).
    let t = stx(&KEY_A, 0, reads_basefee(), vec![]);
    assert_eq!(run_be(&copy_be(None), &feed(&t, 11, vec![msg(11, &[t.clone()])]), &AllExact, &best()).expect_err("unknown").reason, UnknownReason::ReplayWatch);
}

#[test]
fn unrelated_preceding_tx_missing_state_is_skipped_and_recorded() {
    let trig = stx(&KEY_A, 0, pool(), w(5));
    let other = stx(&KEY_B, 0, addr(0xbad), w(1));
    let f = feed(&trig, 12, vec![msg(11, &[other.clone()]), msg(12, &[trig.clone()])]);
    // Strict: unknown (miss).
    assert_eq!(run_be(&copy_be(None), &f, &AllExact, &Assume::default()).expect_err("strict").reason, UnknownReason::Miss);
    // Best effort: skipped, the trigger and our trade exact.
    let out = run_be(&copy_be(None), &f, &AllExact, &best()).unwrap();
    assert_eq!(price_seen(&out), 105);
    assert_eq!(out.replayed.len(), 1, "only the trigger was replayed");
    assert_eq!((out.assumed.skipped_unrelated, out.assumed.skipped_related), (1, 0));
    assert_eq!(out.assumed.labels(), vec!["skipped_unrelated:1".to_string()]);
    assert_eq!(out.assumed.confidence(), "medium");
    // One that uses a Nitro built-in we don't imitate: the same rules.
    let builtin = stx(&KEY_B, 0, addr(0x66), w(1));
    let f = feed(&trig, 12, vec![msg(11, &[builtin]), msg(12, &[trig.clone()])]);
    assert_eq!(run_be(&copy_be(None), &f, &AllExact, &Assume::default()).expect_err("strict").reason, UnknownReason::UnsupportedPrecompile);
    let out = run_be(&copy_be(None), &f, &AllExact, &best()).unwrap();
    assert_eq!((price_seen(&out), out.assumed.skipped_unrelated), (105, 1));
}

#[test]
fn preceding_tx_touching_our_pool_is_replayed_exactly() {
    let trig = stx(&KEY_A, 0, pool(), w(5));
    let before = stx(&KEY_B, 0, pool(), w(3));
    let out = run_be(&copy_be(None), &feed(&trig, 12, vec![msg(11, &[before]), msg(12, &[trig.clone()])]), &AllExact, &best()).unwrap();
    assert_eq!(price_seen(&out), 108, "100 + 3 + 5: both replayed");
    assert_eq!((out.replayed.len(), out.assumed.confidence()), (2, "high"));
}

#[test]
fn tx_that_uses_our_route_then_misses_is_unknown_and_one_that_names_it_is_low() {
    let trig = stx(&KEY_A, 0, pool(), w(5));
    // Swaps on our pool, then needs an account we don't hold: unknown.
    let touch = stx(&KEY_B, 0, router_miss(), w(3));
    let u = run_be(&copy_be(None), &feed(&trig, 12, vec![msg(11, &[touch]), msg(12, &[trig.clone()])]), &AllExact, &best()).expect_err("unknown");
    assert_eq!(u.reason, UnknownReason::Miss, "{u:?}");
    assert!(u.detail.contains("used our route"), "{}", u.detail);
    assert!(u.missing.contains(&MissItem::Account(addr(0xbad2))), "the miss is reported for warming: {u:?}");
    // Misses before touching anything, but its data names our pool: it MAY
    // touch our route -> skipped, LOW confidence.
    let mut data = vec![0u8; 12];
    data.extend_from_slice(pool().as_slice());
    let names = stx(&KEY_B, 0, addr(0xbad), data);
    let out = run_be(&copy_be(None), &feed(&trig, 12, vec![msg(11, &[names]), msg(12, &[trig.clone()])]), &AllExact, &best()).unwrap();
    assert_eq!(price_seen(&out), 105);
    assert_eq!((out.assumed.skipped_related, out.assumed.confidence()), (1, "low"));
    assert_eq!(out.assumed.labels(), vec!["skipped_related:1".to_string()]);
    // No route given (skipping not allowed): unknown as before.
    let no_skip = Assume { skip: None, ..best() };
    let other = stx(&KEY_B, 0, addr(0xbad), w(1));
    assert_eq!(run_be(&copy_be(None), &feed(&trig, 12, vec![msg(11, &[other]), msg(12, &[trig.clone()])]), &AllExact, &no_skip).expect_err("no skip").reason, UnknownReason::Miss);
}

#[test]
fn the_trigger_itself_is_never_skipped() {
    let trig = stx(&KEY_A, 0, addr(0xdead), w(5));
    let u = run_be(&copy_be(None), &feed(&trig, 11, vec![msg(11, &[trig.clone()])]), &AllExact, &best()).expect_err("unknown");
    assert_eq!(u.reason, UnknownReason::Miss);
    assert!(u.detail.contains("trigger"), "{}", u.detail);
}

#[test]
fn recent_fill_is_allowed_with_a_label_and_strict_restores_unknown() {
    // The trigger reads DEP, a fill (not followed): best effort answers, labelled.
    let trig = stx(&KEY_A, 0, router(), w(5));
    let f = feed(&trig, 11, vec![msg(11, &[trig.clone()])]);
    let followed = Followed(vec![pool(), router()]);
    let out = run_be(&copy_be(None), &f, &followed, &best()).unwrap();
    assert_eq!(price_seen(&out), 110);
    assert_eq!((out.assumed.labels(), out.assumed.confidence()), (vec!["recent_fill".to_string()], "medium"));
    assert_eq!(run_be(&copy_be(None), &f, &followed, &Assume::default()).expect_err("strict").reason, UnknownReason::StaleFill);
    // Our own call on a fill: call_fill.
    let read_dep = CallReq { from: caller(), to: Some(dep()), data: Bytes::new(), gas: Some(100_000), value: U256::ZERO };
    let mut b = base();
    b.l2_block_number = Some(10);
    let (plan, _) = build_plan(&feed(&trig, 10, vec![]), 10, 0, &b).unwrap();
    let out = run_ordered_with(&copy_be(None), &plan, &Overrides::none(), &[read_dep], &Followed(vec![pool()]), true, &best()).unwrap();
    assert_eq!(out.assumed.labels(), vec!["call_fill".to_string()]);
}

#[test]
fn route_names_rule() {
    let r = Route {
        accounts: [pool()].into_iter().collect(),
        ids: vec![B256::with_last_byte(9)],
        pairs: vec![(addr(0x3001), addr(0x3002)), (Address::ZERO, addr(0x3003))],
        ..Route::default()
    };
    assert!(r.named_by(Some(pool()), &[]), "sent to our pool");
    assert!(r.named_by(None, &[&[1u8; 3][..], pool().as_slice()].concat()), "pool address in the data");
    assert!(r.named_by(None, B256::with_last_byte(9).as_slice()), "our V4 pool id in the data");
    assert!(r.named_by(None, &[addr(0x3001).as_slice(), addr(0x3002).as_slice()].concat()), "both coins of one of our pools");
    assert!(!r.named_by(None, addr(0x3001).as_slice()), "one coin alone is not enough");
    assert!(!r.named_by(None, &[[0u8; 40].as_slice(), addr(0x3003).as_slice()].concat()), "an ETH pair (zero address) is left out");
    assert!(!r.named_by(Some(addr(0x77)), &w(1)), "unrelated");
}

// ---------------------------------------------------------------------------
// TRIGGER-FIRST ENTRY POINT (Oct 23): "which of our pools does this feed
// transaction move?" (ordered.rs trigger_only + OrderedOut.changed) and the
// size ladder on the replayed feed (proto_types.rs WireSizes).
// ---------------------------------------------------------------------------
use arbsim::check::ordered::trigger_only;
use arbsim::check::proto_types::{handle_trig_call_with, CallRequest, WireSizes};

fn discover(view: &MemState, f: &WireFeed, snap_seq: u64) -> Option<(OrderedOut, usize)> {
    let mut b = base();
    b.l2_block_number = Some(snap_seq);
    let (plan, _) = build_plan(f, snap_seq, 0, &b).unwrap();
    let (alone, others) = trigger_only(&plan)?;
    Some((run_ordered_with(view, &alone, &Overrides::none(), &[], &AllExact, true, &best()).unwrap(), others))
}

#[test]
fn entry_discover_a_swap_on_our_pool_shows_the_pool_changed() {
    let trig = stx(&KEY_A, 0, pool(), w(5));
    let (out, others) = discover(&copy(), &feed(&trig, 11, vec![msg(11, &[trig.clone()])]), 10).expect("runs");
    assert_eq!(others, 0);
    assert_eq!(out.changed, vec![(pool(), U256::ZERO)], "the pool's price slot changed");
    assert!(out.results.is_empty(), "no calls of ours in a discover run");
}

#[test]
fn entry_discover_a_tx_that_does_not_touch_our_pool_changes_only_other_state() {
    let trig = stx(&KEY_A, 0, dep(), w(7));
    let (out, _) = discover(&copy(), &feed(&trig, 11, vec![msg(11, &[trig.clone()])]), 10).expect("runs");
    assert_eq!(out.changed, vec![(dep(), U256::ZERO)]);
    assert!(!out.changed.iter().any(|(a, _)| *a == pool()), "our pool untouched");
    // A reverted trigger leaves nothing changed.
    let trig = stx(&KEY_A, 0, router_revert(), w(5));
    let (out, _) = discover(&copy(), &feed(&trig, 11, vec![msg(11, &[trig.clone()])]), 10).expect("runs");
    assert!(out.changed.is_empty(), "{:?}", out.changed);
}

#[test]
fn entry_discover_runs_the_trigger_alone_and_counts_the_others() {
    // Someone sets DEP before the trigger: left out of the discover run (counted).
    let set = stx(&KEY_B, 0, dep(), w(3));
    let trig = stx(&KEY_A, 0, router(), w(5));
    let (out, others) = discover(&copy(), &feed(&trig, 12, vec![msg(11, &[set.clone()]), msg(12, &[trig.clone()])]), 10).expect("runs");
    assert_eq!(others, 1);
    assert_eq!(out.replayed.len(), 1, "only the trigger ran");
    assert!(out.changed.contains(&(pool(), U256::ZERO)));
    // Already in the copy version: nothing to run.
    assert!(discover(&copy(), &feed(&trig, 10, vec![msg(10, &[trig.clone()])]), 10).is_none());
}

#[test]
fn entry_size_ladder_runs_each_size_on_the_same_replay() {
    let trig = stx(&KEY_A, 0, pool(), w(5));
    let f = feed(&trig, 11, vec![msg(11, &[trig.clone()])]);
    let mut b = base();
    b.l2_block_number = Some(10);
    let (plan, info) = build_plan(&f, 10, 0, &b).unwrap();
    let c = our_trade();
    let mk = |sizes: Option<WireSizes>| CallRequest {
        id: json!(1),
        calls: vec![serde_json::from_value(json!({ "from": format!("{:#x}", c.from), "to": format!("{:#x}", pool()), "data": hexs(&c.data), "gas": "0xf4240" })).unwrap()],
        sizes,
        ..CallRequest::default()
    };
    let a = handle_trig_call_with(&copy(), &plan, &info, &mk(Some(WireSizes { amount_offset: 0, amounts: vec!["0x2".into(), "0x3".into()] })), &AllExact, true, &best());
    assert_eq!(a["ok"], json!(true), "{a}");
    let sizes = a["sizes"].as_array().expect("sizes");
    assert_eq!(sizes.len(), 2);
    assert_eq!(sizes[0]["amount"], json!("0x2"));
    assert_eq!(sizes[1]["amount"], json!("0x3"));
    // Each size saw the trigger applied exactly once (price 105), same as the main run.
    for s in sizes {
        assert_eq!(s["status"], json!("profit"));
        assert_eq!(s["profit"], json!("0x69"));
    }
    // The amount word not where it should be (past the end): no ladder, the answer is unchanged.
    let a = handle_trig_call_with(&copy(), &plan, &info, &mk(Some(WireSizes { amount_offset: 4096, amounts: vec!["0x2".into()] })), &AllExact, true, &best());
    assert_eq!(a["ok"], json!(true));
    assert!(a.get("sizes").is_none());
    // No sizes asked: no `sizes` field (old answers unchanged).
    let a = handle_trig_call_with(&copy(), &plan, &info, &mk(None), &AllExact, true, &best());
    assert!(a.get("sizes").is_none());
}

// ---------------------------------------------------------------------------
// WHICH POOLS MOVED (check/moved.rs, entry point fix Oct 23): only a pool's
// OWN state counts. Live, PR #175 named all 56 V4 pools for every V4 swap
// (shared PoolManager values were matched against every pool).
// ---------------------------------------------------------------------------
use arbsim::check::moved::{moved_pools, v4_base, FollowedPool};

fn pm() -> Address {
    addr(0x4444)
}
fn v3p() -> Address {
    addr(0x3333)
}
fn id(n: u8) -> B256 {
    B256::with_last_byte(n)
}
fn followed() -> Vec<FollowedPool> {
    vec![
        FollowedPool { key: format!("{:#x}", id(0xa)), address: pm(), v4_id: Some(id(0xa)) },
        FollowedPool { key: format!("{:#x}", id(0xb)), address: pm(), v4_id: Some(id(0xb)) },
        FollowedPool { key: format!("{:#x}", v3p()), address: v3p(), v4_id: None },
    ]
}
/// keccak(key . slot) as a mapping entry, with its preimage row.
fn entry(key: U256, slot: U256) -> (U256, (U256, U256, U256)) {
    let mut b = [0u8; 64];
    b[..32].copy_from_slice(&key.to_be_bytes::<32>());
    b[32..].copy_from_slice(&slot.to_be_bytes::<32>());
    let h = U256::from_be_bytes(keccak256(b).0);
    (h, (h, key, slot))
}

#[test]
fn moved_a_single_v4_swap_moves_exactly_its_pool_id() {
    let base = v4_base(id(0xa));
    let (tick, tick_pre) = entry(U256::from(60u64), base + U256::from(4u64));
    let (bm, bm_pre) = entry(U256::from(1u64), base + U256::from(5u64));
    let coin_bal = (addr(0x7001), U256::from(12345u64));
    let changed = vec![
        (pm(), base),                          // slot0
        (pm(), base + U256::from(3u64)),       // liquidity
        (pm(), tick + U256::from(1u64)),       // a tick's 2nd field
        (pm(), bm),                            // tick bitmap word
        (pm(), U256::from(7u64)),              // a SHARED PoolManager value
        (pm(), U256::from(0xdead_beefu64) << 128), // another shared / unrelated value
        coin_bal,                              // a coin balance
    ];
    let m = moved_pools(&changed, &[tick_pre, bm_pre], &followed());
    assert_eq!(m.len(), 1, "{m:?}");
    assert_eq!(m[0].key, format!("{:#x}", id(0xa)));
    assert_eq!(m[0].kinds, vec!["bitmap".to_string(), "liquidity".into(), "slot0".into(), "ticks".into()]);
}

#[test]
fn moved_a_v3_swap_moves_exactly_that_pool() {
    let (lp, lp_pre) = entry(U256::from(9u64), U256::from(3u64));
    let changed = vec![(v3p(), U256::ZERO), (v3p(), U256::from(4u64)), (v3p(), lp), (addr(0x7001), U256::from(1u64))];
    let m = moved_pools(&changed, &[lp_pre], &followed());
    assert_eq!(m.len(), 1, "{m:?}");
    assert_eq!(m[0].key, format!("{:#x}", v3p()));
    assert_eq!(m[0].kinds, vec!["s0".to_string(), "s4".into()], "hashed entries alone don't count");
}

#[test]
fn moved_a_router_swap_through_two_pools_moves_exactly_those_two() {
    let changed = vec![(pm(), v4_base(id(0xb))), (v3p(), U256::ZERO), (pm(), U256::from(7u64))];
    let m = moved_pools(&changed, &[], &followed());
    let keys: Vec<String> = m.iter().map(|x| x.key.clone()).collect();
    let mut want = vec![format!("{:#x}", id(0xb)), format!("{:#x}", v3p())];
    want.sort();
    assert_eq!(keys, want);
}

#[test]
fn moved_a_non_swap_call_moves_nothing() {
    // An approve / transfer: coin storage only; an LP-token transfer on the
    // V3 pool (hashed balance) and a shared PoolManager value: no pool moved.
    let (lp, lp_pre) = entry(U256::from(9u64), U256::from(3u64));
    let changed = vec![(addr(0x7001), U256::from(55u64)), (v3p(), lp), (pm(), U256::from(7u64))];
    assert!(moved_pools(&changed, &[lp_pre], &followed()).is_empty());
    assert!(moved_pools(&[], &[], &followed()).is_empty());
}

/// A miniature PoolManager: calldata (id, tick). Writes _pools[id].slot0
/// (keccak(id . 6)), one field of ticks[tick] (keccak(tick . base+4) + 1),
/// and a SHARED slot 7 - like a real swap through the shared contract.
fn pm_code() -> Vec<u8> {
    hex("6000 35 6000 52 6006 6020 52 6040 6000 20 80 6001 90 55 6004 01 6020 52 6020 35 6000 52 6040 6000 20 6001 01 6005 90 55 6009 6007 55 00")
}

#[test]
fn moved_v4_swap_through_the_evm_names_one_pool_from_the_recorded_hashes() {
    let pbase = v4_base(id(0xa));
    let (tick, _) = entry(U256::from(60u64), pbase + U256::from(4u64));
    let mut c = state_with(&[(pm(), pm_code(), vec![(pbase, U256::ZERO), (tick + U256::from(1u64), U256::ZERO), (U256::from(7u64), U256::ZERO)])], true);
    add_eoa(&mut c, caller(), U256::ZERO);
    let mut data = id(0xa).to_vec();
    data.extend(w(60));
    let trig = stx(&KEY_A, 0, pm(), data);
    let mut b = base();
    b.l2_block_number = Some(10);
    let (plan, _) = build_plan(&feed(&trig, 11, vec![msg(11, &[trig.clone()])]), 10, 0, &b).unwrap();
    let (alone, _) = trigger_only(&plan).unwrap();
    let assume = Assume { record_hashes: true, ..best() };
    let out = run_ordered_with(&c, &alone, &Overrides::none(), &[], &AllExact, true, &assume).unwrap();
    assert!(out.replayed[0].outcome.success, "{:?}", out.replayed[0]);
    assert_eq!(out.changed.len(), 3, "slot0, the tick field and the shared slot changed: {:?}", out.changed);
    let m = moved_pools(&out.changed, &out.hashes, &followed());
    assert_eq!(m.len(), 1, "{m:?}");
    assert_eq!(m[0].key, format!("{:#x}", id(0xa)));
    assert_eq!(m[0].kinds, vec!["slot0".to_string(), "ticks".into()]);
    // Without recorded hashes the tick can't be placed (slot0 still is).
    let out2 = run_ordered_with(&c, &alone, &Overrides::none(), &[], &AllExact, true, &best()).unwrap();
    assert!(out2.hashes.is_empty());
}

/// Reverts InsufficientProfit(slot 5, MAX): "profit" = its slot 5 (think:
/// the test contract's trading money), so a ladder size shows which amount
/// the slot held for that run.
fn fund() -> Address {
    addr(0x5555)
}
fn fund_code() -> Vec<u8> {
    hex("634e88422a 60e0 1b 6000 52 6005 54 6004 52 6000 19 6024 52 6044 6000 fd")
}

#[test]
fn entry_ladder_one_replay_each_size_sees_its_own_trading_money() {
    use arbsim::check::ordered::{run_ordered_sizes, Ladder};
    let mut c = copy();
    add_contract(&mut c, fund(), fund_code(), &[(U256::from(5u64), U256::ZERO)]);
    let trig = stx(&KEY_A, 0, pool(), w(5));
    let mut b = base();
    b.l2_block_number = Some(10);
    let (plan, _) = build_plan(&feed(&trig, 11, vec![msg(11, &[trig.clone()])]), 10, 0, &b).unwrap();
    let mut data = hex("deadbeef");
    data.extend(w(1));
    let call = CallReq { from: caller(), to: Some(fund()), data: Bytes::from(data), gas: Some(1_000_000), value: U256::ZERO };
    let ov = Overrides::from_json(&json!({ format!("{:#x}", fund()): { "stateDiff": { "0x5": "0x1" } } })).unwrap();
    let lad = Ladder { amount_offset: 0, amounts: vec![U256::from(2u64), U256::from(3u64)], slots: vec![(fund(), U256::from(5u64))] };
    let out = run_ordered_sizes(&c, &plan, &ov, std::slice::from_ref(&call), &AllExact, true, &best(), Some(&lad)).unwrap();
    let got = |o: &arbsim::check::CallOutcome| U256::from_be_slice(&o.output[4..36]).to::<u64>();
    assert_eq!(got(&out.results[0]), 1, "main run: the original amount");
    assert_eq!(out.ladder.len(), 2);
    assert_eq!(out.ladder.iter().map(|r| got(r.outcome.as_ref().unwrap())).collect::<Vec<_>>(), vec![2, 3], "each size saw its own amount (state put back between sizes)");
    assert_eq!(out.replayed.len(), 1, "the feed was replayed once");
}

#[test]
fn bench_entry_candidate_check_test_numbers_only() {
    use arbsim::check::ordered::{run_ordered_sizes, Ladder};
    let mut c = copy();
    add_contract(&mut c, fund(), fund_code(), &[(U256::from(5u64), U256::ZERO)]);
    let trig = stx(&KEY_A, 0, router(), w(5));
    let mut msgs: Vec<WireFeedMsg> = Vec::new();
    for s in 0..19u64 {
        msgs.push(msg(11 + s, &[stx(&KEY_B, s, pool(), w(1))]));
    }
    msgs.push(msg(30, &[trig.clone()]));
    let mut b = base();
    b.l2_block_number = Some(10);
    let (plan, _) = build_plan(&feed(&trig, 30, msgs), 10, 0, &b).unwrap();
    let mut data = hex("deadbeef");
    data.extend(w(400));
    let call = CallReq { from: caller(), to: Some(fund()), data: Bytes::from(data), gas: Some(1_000_000), value: U256::ZERO };
    let ov = Overrides::from_json(&json!({ format!("{:#x}", fund()): { "stateDiff": { "0x5": format!("{:#x}", 400) } } })).unwrap();
    let lad = Ladder { amount_offset: 0, amounts: vec![U256::from(50u64), U256::from(150u64)], slots: vec![(fund(), U256::from(5u64))] };
    let n = 30;
    let t = std::time::Instant::now();
    for _ in 0..n {
        run_ordered_sizes(&c, &plan, &ov, std::slice::from_ref(&call), &AllExact, true, &best(), Some(&lad)).unwrap();
    }
    let one = t.elapsed().as_micros() / n;
    let t = std::time::Instant::now();
    for _ in 0..n {
        for _ in 0..3 {
            run_ordered_with(&c, &plan, &ov, std::slice::from_ref(&call), &AllExact, true, &best()).unwrap();
        }
    }
    let three = t.elapsed().as_micros() / n;
    let (alone, _) = trigger_only(&plan).unwrap();
    let t = std::time::Instant::now();
    for _ in 0..n {
        run_ordered_with(&c, &alone, &Overrides::none(), &[], &AllExact, true, &Assume { record_hashes: true, ..best() }).unwrap();
    }
    let disc = t.elapsed().as_micros() / n;
    println!("[bench, test numbers only] entry candidate check, 20 feed txs + 3 sizes: one replay + ladder {one} us vs 3 full replays {three} us; discover (trigger alone) {disc} us ({} build)", if cfg!(debug_assertions) { "debug" } else { "release" });
}
