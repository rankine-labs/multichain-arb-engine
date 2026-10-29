// ============================================================================
// Mirror tests (workstream A): feed frames -> replay -> versions, fills,
// gaps, verification, pinned views and the socket server, all offline with
// a fake node.
//
// The "chain" used: a counter contract C (slot 0 += 1 per call, returns the
// new value) holding 5 at block 9, called by a test key. Feed message N =
// L2 block N (offset 0).
// ============================================================================
mod check_util;
mod mirror_util;

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use arbsim::feed::frame::parse_frame;
use arbsim::node::NodeApi;
use arbsim::state::fill::FillQueue;
use arbsim::state::mirror::{At, Config, Shared};
use arbsim::state::snap::View;
use arbsim::state::updater;
use arbsim::state::{Lookup, StateRead};
use check_util::*;
use mirror_util::*;
use revm::primitives::{keccak256, Address, U256};
use serde_json::{json, Value};

const KEY: [u8; 32] = [
    0xac, 0x09, 0x74, 0xbe, 0xc3, 0x9a, 0x17, 0xe3, 0x6b, 0xa4, 0xa6, 0xb4, 0xd2, 0x38, 0xff, 0x94, 0x4b, 0xac, 0xb4,
    0x78, 0xcb, 0xed, 0x5e, 0xfc, 0xae, 0x78, 0x4d, 0x7b, 0xf4, 0xf2, 0xff, 0x80,
];

/// The counter's code as hex text (geth's prestate lists code in `pre`).
fn code_hex() -> String {
    arbsim::check::hexutil::to_hex(&code_counter())
}

fn counter_addr() -> Address {
    addr(0xc0de)
}

/// Signed 1559 call to the counter.
fn bump_tx(nonce: u64) -> Vec<u8> {
    sign_typed(&KEY, 2, &TestTx { nonce, gas: 100_000, to: Some(counter_addr()), value: U256::ZERO, data: vec![], access_list: vec![] }, 4663)
}

/// Fake chain: counter = `v` at `block`.
fn chain_with(node: &FakeNode, block: u64, v: u64) {
    let mut m = HashMap::new();
    m.insert(counter_addr(), FakeAcct { nonce: 1, code: code_counter(), storage: HashMap::from([(U256::ZERO, U256::from(v))]), ..Default::default() });
    m.insert(key_address(&KEY), FakeAcct { balance: U256::from(10u64).pow(U256::from(18)), nonce: 0, ..Default::default() });
    node.set_state(block, m);
}

fn setup(cfg: Config) -> (Arc<FakeNode>, Arc<Shared>, updater::Updater, updater::UpdaterHandle) {
    let node = Arc::new(FakeNode { base_fee: 10_000_000, ..Default::default() });
    let dyn_node: Arc<dyn NodeApi> = node.clone();
    let shared = Shared::new(cfg, Some(dyn_node), Arc::new(arbsim::serve::default_volatile()));
    let fills = Arc::new(FillQueue::new(1000, 100));
    let (u, h) = updater::manual(shared.clone(), fills);
    (node, shared, u, h)
}

fn head_slot(sh: &Shared) -> Lookup<U256> {
    sh.head().unwrap().snap.storage(counter_addr(), U256::ZERO)
}

/// Run the updater until `cond` or ~60 steps.
fn pump_until(u: &mut updater::Updater, cond: impl Fn() -> bool) {
    for _ in 0..60 {
        u.pump();
        if cond() {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

// ---------------------------------------------------------------------------
#[test]
fn feed_frames_parse_like_nitro_feed_ts() {
    let a = bump_tx(0);
    let b = bump_tx(1);
    let transfer = sign_typed(&KEY, 2, &TestTx { nonce: 2, gas: 21_000, to: Some(addr(5)), value: U256::from(1u64), data: vec![], access_list: vec![] }, 4663);
    let legacy = sign_legacy(&KEY, &TestTx { nonce: 3, gas: 50_000, to: Some(addr(6)), value: U256::ZERO, data: vec![1, 2], access_list: vec![] }, 7, None);
    // Batch with a nested batch, like the bot's own test.
    let nested = batch_msg(&[signed_msg(&b)]);
    let batch = batch_msg(&[signed_msg(&a), nested, signed_msg(&transfer), signed_msg(&legacy)]);
    let msgs = parse_frame(&frame(101, &batch, 3, 777, 1_700_000_101)).unwrap();
    assert_eq!(msgs.len(), 1);
    let m = &msgs[0];
    assert_eq!((m.seq, m.l1_block, m.timestamp), (101, 777, 1_700_000_101));
    assert!(m.complete(), "{:?}", m.unreplayable);
    assert_eq!(m.txs.len(), 4, "plain transfers are kept (we replay whole blocks)");
    assert!(m.txs.iter().all(|t| t.from == key_address(&KEY)), "sender recovered");
    assert_eq!(m.txs[0].hash, keccak256(&a));
    assert_eq!(m.txs[1].nonce, 1);
    assert_eq!(m.txs[3].chain_id, None); // pre-EIP-155 legacy
    // Deposits / other header kinds: kept as "can't replay" (needs a trace).
    let dep = parse_frame(&frame(102, &signed_msg(&a), 12, 1, 1)).unwrap();
    assert!(!dep[0].complete());
    // Garbage and truncated input never crash; marked incomplete.
    let g = parse_frame(&frame(103, &[4, 1, 2, 3], 3, 1, 1)).unwrap();
    assert!(!g[0].complete() && g[0].txs.is_empty());
    let t = parse_frame(&frame(104, &[3, 0, 0, 0, 0, 0, 0, 0, 99, 4, 1], 3, 1, 1)).unwrap();
    assert!(!t[0].complete());
    assert!(parse_frame("{\"version\":1}").unwrap().is_empty());
    assert!(parse_frame("not json").is_err());
}

#[test]
fn eip7702_authorization_signer_is_recovered() {
    use arbsim::feed::rlp::{enc_bytes, enc_uint, wrap_list};
    // Authorization signed by KEY: keccak(0x05 || rlp([chainId, address, nonce])).
    let (cid, target, anonce) = (U256::from(4663u64), addr(0xbeef), U256::from(9u64));
    let inner = [enc_uint(cid), enc_bytes(target.as_slice()), enc_uint(anonce)];
    let mut m = vec![5u8];
    m.extend(wrap_list(&[&inner[0], &inner[1], &inner[2]]));
    let (y, r, s) = sign_hash(&KEY, keccak256(&m));
    let auth = wrap_list(&[&inner[0], &inner[1], &inner[2], &enc_uint(U256::from(y)), &enc_uint(r), &enc_uint(s)]);
    // Tx fields.
    let f: Vec<Vec<u8>> = vec![
        enc_uint(U256::from(4663u64)), enc_uint(U256::ZERO), enc_uint(U256::from(1u64)), enc_uint(U256::from(1_000_000_000u64)),
        enc_uint(U256::from(80_000u64)), enc_bytes(addr(7).as_slice()), enc_uint(U256::ZERO), enc_bytes(&[]),
        wrap_list(&[]), wrap_list(&[&auth]),
    ];
    let refs: Vec<&[u8]> = f.iter().map(|x| x.as_slice()).collect();
    let mut pre = vec![4u8];
    pre.extend(wrap_list(&refs));
    let (ty, tr, ts) = sign_hash(&KEY, keccak256(&pre));
    let mut all = f.clone();
    all.extend([enc_uint(U256::from(ty)), enc_uint(tr), enc_uint(ts)]);
    let refs: Vec<&[u8]> = all.iter().map(|x| x.as_slice()).collect();
    let mut raw = vec![4u8];
    raw.extend(wrap_list(&refs));
    let t = arbsim::feed::decode_tx(&raw).unwrap();
    assert_eq!(t.tx_type, 4);
    assert_eq!(t.from, key_address(&KEY));
    assert_eq!(t.authorizations.len(), 1);
    assert_eq!(t.authorizations[0].1, Some(key_address(&KEY)));
    assert_eq!(t.authorizations[0].0.address, target);
}

fn sign_hash(key: &[u8; 32], h: revm::primitives::B256) -> (u8, U256, U256) {
    use secp256k1::{Message, SecretKey, SECP256K1};
    let sk = SecretKey::from_byte_array(*key).unwrap();
    let sig = SECP256K1.sign_ecdsa_recoverable(Message::from_digest(h.0), &sk);
    let (rid, c) = sig.serialize_compact();
    (i32::from(rid) as u8, U256::from_be_slice(&c[..32]), U256::from_be_slice(&c[32..]))
}

// ---------------------------------------------------------------------------
#[test]
fn replay_fills_once_then_runs_without_the_node() {
    let (node, sh, mut u, h) = setup(Config::for_tests());
    chain_with(&node, 9, 5);
    // Message 10: one bump. Our copy starts empty right before block 10.
    h.frame(frame(10, &signed_msg(&bump_tx(0)), 3, 500, 1_700_000_010));
    pump_until(&mut u, || sh.head().is_some_and(|v| v.seq == 10));
    assert_eq!(head_slot(&sh), Lookup::Known(U256::from(6)), "replayed: 5 -> 6");
    let calls_after_first = node.total();
    assert!(node.count("eth_getStorageAt") >= 1, "the slot was fetched once");
    assert_eq!(node.count("debug_traceBlockByNumber"), 0, "no traces needed");
    // Messages 11 and 12 (batch of 2): replayed locally, NO node calls.
    h.frame(frame(11, &signed_msg(&bump_tx(1)), 3, 500, 1_700_000_011));
    h.frame(frame(12, &batch_msg(&[signed_msg(&bump_tx(2)), signed_msg(&bump_tx(3))]), 3, 501, 1_700_000_012));
    pump_until(&mut u, || sh.head().is_some_and(|v| v.seq == 12));
    assert_eq!(head_slot(&sh), Lookup::Known(U256::from(9)));
    assert_eq!(node.total(), calls_after_first, "steady state costs zero node requests");
    // Per-tx views (afterTx) and per-block views (afterSeq) are kept.
    let after_first_of_12 = sh.resolve(&At::AfterTx(keccak256(bump_tx(2)))).unwrap();
    assert_eq!(after_first_of_12.snap.storage(counter_addr(), U256::ZERO), Lookup::Known(U256::from(8)));
    let at11 = sh.resolve(&At::AfterSeq(11)).unwrap();
    assert_eq!(at11.snap.storage(counter_addr(), U256::ZERO), Lookup::Known(U256::from(7)));
    assert_eq!(at11.ctx.l2_block_number, Some(11));
    assert_eq!(at11.ctx.l1_block_number, 500);
    // The sender's ETH balance is approximate (fees not replayed) -> a check
    // that reads it gets Missing, never a guess.
    let v = View::new(sh.head().unwrap().snap.clone());
    assert_eq!(v.account(key_address(&KEY)), Lookup::Missing);
    let st = sh.status_json();
    assert_eq!(st["txs_replayed"], json!(4));
    assert!(st["dirty_events"].as_u64().unwrap() >= 1, "first message waited for node data");
}

#[test]
fn snapshot_isolation_old_versions_unchanged_while_new_ones_arrive() {
    let (node, sh, mut u, h) = setup(Config::for_tests());
    chain_with(&node, 9, 5);
    h.frame(frame(10, &signed_msg(&bump_tx(0)), 3, 500, 1));
    pump_until(&mut u, || sh.head().is_some());
    let old = sh.head().unwrap();
    // A reader thread holds the old version while the writer moves on.
    let reader = {
        let old = old.clone();
        std::thread::spawn(move || {
            for _ in 0..1000 {
                assert_eq!(old.snap.storage(counter_addr(), U256::ZERO), Lookup::Known(U256::from(6)));
            }
        })
    };
    for i in 0..5u64 {
        h.frame(frame(11 + i, &signed_msg(&bump_tx(1 + i)), 3, 500, 1));
    }
    pump_until(&mut u, || sh.head().is_some_and(|v| v.seq == 15));
    reader.join().unwrap();
    assert_eq!(old.snap.storage(counter_addr(), U256::ZERO), Lookup::Known(U256::from(6)));
    assert_eq!(head_slot(&sh), Lookup::Known(U256::from(11)));
}

#[test]
fn feed_gap_is_repaired_from_a_node_trace() {
    let (node, sh, mut u, h) = setup(Config::for_tests());
    chain_with(&node, 9, 5);
    h.frame(frame(10, &signed_msg(&bump_tx(0)), 3, 500, 1));
    pump_until(&mut u, || sh.head().is_some());
    // Block 11 never arrives on the feed; the node's trace says someone set
    // the counter to 100 in it.
    node.traces.lock().unwrap().insert(
        11,
        json!([{ "txHash": "0x01", "result": {
            "pre":  { format!("{:#x}", counter_addr()): { "balance": "0x0", "nonce": 1, "code": code_hex(), "storage": { "0x0": format!("{:#066x}", 6) } } },
            "post": { format!("{:#x}", counter_addr()): { "storage": { "0x0": format!("{:#066x}", 100) } } }
        }}]),
    );
    h.frame(frame(12, &signed_msg(&bump_tx(1)), 3, 500, 1));
    pump_until(&mut u, || sh.head().is_some_and(|v| v.seq == 12));
    assert_eq!(head_slot(&sh), Lookup::Known(U256::from(101)), "gap block from trace, then 12 replayed on top");
    let st = sh.status_json();
    assert_eq!(st["gaps"], json!(1));
    assert_eq!(st["gap_blocks"], json!(1));
    // The repaired block has no feed header -> checks AT it say not_ready.
    assert_eq!(sh.resolve(&At::AfterSeq(11)).err().unwrap().reason, "not_ready");
}

#[test]
fn node_down_means_dirty_never_wrong_then_recovers() {
    let (node, sh, mut u, h) = setup(Config::for_tests());
    chain_with(&node, 9, 5);
    *node.down.lock().unwrap() = true;
    h.frame(frame(10, &signed_msg(&bump_tx(0)), 3, 500, 1));
    u.pump();
    // Nothing replayed: head is only the empty start point, block 10 pending.
    let e = sh.resolve(&At::Head).err().unwrap();
    assert_eq!(e.reason, "dirty");
    // SPEED FIX 3 (Oct 29): "headNow" never waits for the pending block; it
    // picks the newest replayed version as it is (the caller replays the
    // feed after it), here the start point before block 10.
    // (Here that start point has no block details, so it answers not_ready
    // at once: the point is that it never says "dirty" and never waits.)
    let t = std::time::Instant::now();
    match sh.resolve(&At::HeadNow) {
        Ok(p) => assert!(p.seq < 10, "the pending block 10 is not in it (seq {})", p.seq),
        Err(e) => assert_ne!(e.reason, "dirty", "headNow never answers dirty"),
    }
    assert!(t.elapsed() < Duration::from_millis(20), "headNow did not wait");
    *node.down.lock().unwrap() = false;
    std::thread::sleep(Duration::from_millis(250)); // past the retry back-off
    pump_until(&mut u, || sh.head().is_some_and(|v| v.seq == 10));
    assert_eq!(head_slot(&sh), Lookup::Known(U256::from(6)));
    assert!(sh.resolve(&At::Head).is_ok());
    // Caught up: headNow gives the very same version as head.
    assert_eq!(sh.resolve(&At::HeadNow).unwrap().seq, sh.resolve(&At::Head).unwrap().seq);
    assert!(sh.status_json()["dirty_ms_total"].as_u64().unwrap() > 0);
}

#[test]
fn verification_matches_and_mismatches_are_counted_and_corrected() {
    let mut cfg = Config::for_tests();
    cfg.verify_every = 1;
    let (node, sh, mut u, h) = setup(cfg);
    chain_with(&node, 9, 5);
    let key = format!("{:#x}", counter_addr());
    // Block 10: node agrees (5 -> 6).
    node.traces.lock().unwrap().insert(10, json!([{ "result": {
        "pre": { &key: { "nonce": 1, "code": code_hex(), "storage": { "0x0": format!("{:#066x}", 5) } } },
        "post": { &key: { "storage": { "0x0": format!("{:#066x}", 6) } } } } }]));
    // Block 11: node says 42 (we will say 7) -> mismatch, account forgotten.
    node.traces.lock().unwrap().insert(11, json!([{ "result": {
        "pre": { &key: { "nonce": 1, "code": code_hex(), "storage": { "0x0": format!("{:#066x}", 6) } } },
        "post": { &key: { "storage": { "0x0": format!("{:#066x}", 42) } } } } }]));
    h.frame(frame(10, &signed_msg(&bump_tx(0)), 3, 500, 1));
    pump_until(&mut u, || sh.head().is_some_and(|v| v.seq == 10));
    assert_eq!(sh.stats.replay_match.load(Ordering::Relaxed), 1);
    h.frame(frame(11, &signed_msg(&bump_tx(1)), 3, 500, 1));
    pump_until(&mut u, || sh.head().is_some_and(|v| v.seq == 11));
    assert_eq!(sh.stats.replay_mismatch.load(Ordering::Relaxed), 1);
    assert_eq!(head_slot(&sh), Lookup::Missing, "a wrong account is forgotten, never kept");
}

// ---------------------------------------------------------------------------
// Server round trip over a real Unix socket (temp path).
fn sock_path(name: &str) -> String {
    std::env::temp_dir().join(format!("arbsim-test-{name}-{}.sock", std::process::id())).to_string_lossy().to_string()
}

struct Client(std::os::unix::net::UnixStream);
impl Client {
    fn send(&mut self, v: &Value) {
        arbsim::proto::write_msg(&mut self.0, &serde_json::to_vec(v).unwrap()).unwrap();
    }
    fn recv(&mut self) -> Value {
        serde_json::from_slice(&arbsim::proto::read_msg(&mut self.0).unwrap().unwrap()).unwrap()
    }
    fn ask(&mut self, v: Value) -> Value {
        self.send(&v);
        self.recv()
    }
}

fn start_server(name: &str, cfg: Config) -> (Arc<FakeNode>, Arc<arbsim::server::Ctx>, Client) {
    let node = Arc::new(FakeNode { base_fee: 10_000_000, ..Default::default() });
    chain_with(&node, 9, 5);
    let dyn_node: Arc<dyn NodeApi> = node.clone();
    let ctx = arbsim::serve::build(cfg, Some(dyn_node));
    let path = sock_path(name);
    let listener = arbsim::server::bind(&path).unwrap();
    let c2 = ctx.clone();
    std::thread::spawn(move || arbsim::server::run(c2, listener));
    let stream = std::os::unix::net::UnixStream::connect(&path).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    (node, ctx, Client(stream))
}

fn call_counter(id: u64, at: Value) -> Value {
    json!({ "id": id, "type": "call", "at": at,
            "calls": [{ "from": format!("{:#x}", addr(0x1111)), "to": format!("{:#x}", counter_addr()), "data": "0x", "gas": "0x30000" }] })
}

fn wait_for(mut f: impl FnMut() -> bool) {
    let t = Instant::now();
    while !f() {
        assert!(t.elapsed() < Duration::from_secs(10), "timed out");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn server_round_trip_feed_status_warm_call_and_miss_fill() {
    let (_node, ctx, mut c) = start_server("rt", Config::for_tests());
    // Not ready before any feed message.
    let r = c.ask(call_counter(1, json!({"after":"head"})));
    assert_eq!(r["id"], json!(1));
    assert_eq!(r["ok"], json!(false));
    assert_eq!(r["unknown"], json!("not_ready"));
    // Feed (no answer), then status until block 10 is replayed.
    c.send(&json!({ "id": 2, "type": "feed", "frame": frame(10, &signed_msg(&bump_tx(0)), 3, 500, 1_700_000_010) }));
    wait_for(|| ctx.shared.head().is_some_and(|v| v.seq == 10));
    let st = c.ask(json!({ "id": 3, "type": "status" }));
    assert_eq!(st["id"], json!(3));
    assert_eq!(st["head"]["seq"], json!(10));
    assert!(st["node"].is_object() || st["node"].is_null());
    // warm
    let w = c.ask(json!({ "id": 4, "type": "warm", "accounts": [format!("{:#x}", addr(0x1111))] }));
    assert_eq!(w["ok"], json!(true));
    // call: the caller account may still be missing on the first try (it is
    // warmed/filled in the background), then the answer is exact: 6 + 1.
    let mut answer = Value::Null;
    wait_for(|| {
        answer = c.ask(call_counter(5, json!({"after":"head"})));
        answer["ok"] == json!(true)
    });
    assert_eq!(answer["results"][0]["success"], json!(true));
    assert_eq!(answer["results"][0]["output"], json!(format!("{:#066x}", 7)));
    assert_eq!(answer["at"]["seq"], json!(10));
    // Pipelined requests on one connection: both answered, ids echoed.
    c.send(&json!({ "id": 10, "type": "status" }));
    c.send(&call_counter(11, json!({"afterSeq": 10})));
    let mut ids = vec![c.recv()["id"].as_u64().unwrap(), c.recv()["id"].as_u64().unwrap()];
    ids.sort();
    assert_eq!(ids, vec![10, 11]);
    // Bad request is answered, not dropped.
    let b = c.ask(json!({ "id": 12, "type": "nope" }));
    assert_eq!(b["unknown"], json!("bad_request"));
}

#[test]
fn pinned_view_waits_for_fills_at_that_block() {
    let (node, _ctx, mut c) = start_server("pin", Config::for_tests());
    // Pinned block 9 (counter = 5): the view is filled from the node at 9
    // until the check is sure, never mixed with the live copy.
    let r = c.ask(call_counter(1, json!({ "pinned": "0x9", "env": "next" })));
    assert_eq!(r["ok"], json!(true), "{r}");
    assert_eq!(r["results"][0]["output"], json!(format!("{:#066x}", 6)));
    let used = node.count("eth_getStorageAt");
    assert!(used >= 1);
    // Same block again: cached, no new storage fetches.
    let r2 = c.ask(call_counter(2, json!({ "pinned": "0x9", "env": "same" })));
    assert_eq!(r2["ok"], json!(true));
    assert_eq!(node.count("eth_getStorageAt"), used);
    // A block the node doesn't have: not_ready (not a guess).
    let r3 = c.ask(call_counter(3, json!({ "pinned": "0x63" })));
    assert_eq!(r3["unknown"], json!("not_ready"));
}

// Speed of state lookups on a realistic-size copy (run with --release --ignored).
#[test]
#[ignore]
fn lookup_speed() {
    use arbsim::state::snap::{Fact, Snapshot};
    let mut s = Snapshot::default();
    for i in 0..20_000u64 {
        let a = addr(i + 1);
        for k in 0..10u64 {
            s.apply_fact(&Fact::Slot(a, U256::from(k), U256::from(i * k)));
        }
    }
    let snap = Arc::new(s);
    let v = View::new(snap.clone());
    let t = Instant::now();
    let n = 1_000_000u64;
    let mut hit = 0u64;
    for i in 0..n {
        if let Lookup::Known(_) = v.storage(addr(i % 20_000 + 1), U256::from(i % 10)) {
            hit += 1;
        }
    }
    let ns = t.elapsed().as_nanos() as f64 / n as f64;
    // Cloning a version (what each new block costs before its changes).
    let t2 = Instant::now();
    for _ in 0..1000 {
        let mut c = (*snap).clone();
        c.apply_fact(&Fact::Slot(addr(7), U256::from(1), U256::from(1)));
    }
    let clone_us = t2.elapsed().as_micros() as f64 / 1000.0;
    eprintln!("storage lookup: {ns:.0} ns each ({hit} hits); new version + 1 change: {clone_us:.1} us; 200 lookups = {:.1} us", ns * 200.0 / 1000.0);
}
