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
use arbsim::check::ordered::{build_plan, run_ordered, AllExact, OrderedOut, PlanInfo, Provenance, WireFeed, WireFeedMsg};
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
    WireFeed { trigger: hexs(keccak256(trigger).as_slice()), trigger_seq, msgs }
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
