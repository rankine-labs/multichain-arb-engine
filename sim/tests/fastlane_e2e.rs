// ============================================================================
// FAST LANE END TO END (integration): feed message -> predicted copy ->
// scanner -> safety -> gun -> send log, practice and live.
//
// Plain English: a small copy with one "pool" contract whose stored price is
// what our trade would earn (calling it with the trade's execute(...) data
// answers "InsufficientProfit(price)", the same answer our real contract
// gives). Feed messages (signed test transactions, no funds) move that price.
// The whole fast lane runs on each message, exactly as in arbsim, except that
// the parts that would talk to the outside world are local fakes:
//   - the send endpoint is a tiny local HTTP server (counts what reaches it)
//   - the read node answers gas / nonce questions with fixed numbers
//   - Node's state file is written by the test
// Proven here:
//   1. practice: would-sends are signed and logged with a seq, NOTHING is
//      broadcast; once copy 2 confirms the blocks, each one is scored
//      (real / gone, taken by others in N+1) into the practice file
//   2. FASTLANE=live without RUST_SENDER, without Node's rustSender, without
//      the wallet key: nothing is broadcast (each for its own reason)
//   3. everything set, against the fake endpoint: exactly ONE broadcast, its
//      record carries a seq and the same hash the endpoint got, and the
//      sequencer's reply follows as a "reply" line. The log is written to
//      tests/fixtures/fastlane-sends-e2e.jsonl when FASTLANE_E2E_WRITE=1;
//      the Node test (src/test/fastlaneBridge.test.ts) reads that file and
//      proves Node picks the live send up and tracks it.
//   4. the bench (TEST numbers, this machine): microseconds per block for
//      ahead + scan + fire with ~650 pools and ~1,300 routes.
// ============================================================================
mod check_util;

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
#[allow(unused_imports)]
use std::fmt::Write as _;
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use arbsim::arb::BlockCtx;
use arbsim::check::entry::{Row, Table};
use arbsim::check::feedstore::BinMsg;
use arbsim::check::hexutil::{parse_bytes, to_hex};
use arbsim::check::moved::FollowedPool;
use arbsim::check::ordered::{AllExact, WireFeedMsg};
use arbsim::copy2::ahead::{Ahead, AheadCfg, Confirmed, PoolSet};
use arbsim::fastlane::bridge::{KillSwitch, NodeState, OwnMoney, SendRecord, SendsLog, StateReader};
use arbsim::fastlane::gun::rpc::ReadRpc;
use arbsim::fastlane::gun::send::SendOutcome;
use arbsim::fastlane::gun::{Gate, Gun, NoGate};
use arbsim::fastlane::lane::{reply_hook, Lane, LaneCfg, ReplyBook, SafetyGate};
use arbsim::fastlane::mode::FastlaneMode;
use arbsim::fastlane::practice::{ConfirmedBlock, Practice, PracticeCfg};
use arbsim::copy2::ahead::PredictionCounts;
use arbsim::fastlane::safety::{utc_day, Safety, SafetyConfig};
use arbsim::fastlane::scan::{CheckRunner, PlainRunner, ScanConfig, Scanner, TableSource};
use arbsim::fastlane::types::*;
use arbsim::state::snap::{Fact, Snapshot};
use arbsim::state::{AccountDiff, StateDiff};
use check_util::*;
use revm::primitives::{keccak256, Address, B256, U256};
use revm::state::{AccountInfo, Bytecode};
use serde_json::{json, Value};

// anvil test account #0 (public test key, no funds): signs the feed transactions.
const KEY: [u8; 32] = [
    0xac, 0x09, 0x74, 0xbe, 0xc3, 0x9a, 0x17, 0xe3, 0x6b, 0xa4, 0xa6, 0xb4, 0xd2, 0x38, 0xff, 0x94, 0x4b, 0xac, 0xb4,
    0x78, 0xcb, 0xed, 0x5e, 0xfc, 0xae, 0x78, 0x4d, 0x7b, 0xf4, 0xf2, 0xff, 0x80,
];
// anvil test account #1 (public test key, no funds): the "wallet" of the live test.
const WALLET_KEY: &str = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const LENDER: u64 = 0x1e0;
const CALLER: u64 = 0xb0751;

// ---------------------------------------------------------------------------
// The little world
// ---------------------------------------------------------------------------

fn pool() -> Address {
    addr(0x1001)
}
fn other() -> Address {
    addr(0x1002)
}
fn key(a: Address) -> String {
    format!("{a:#x}")
}
/// POOL: a 32-byte call adds the word to slot 0 (the "price"); any other call
/// reverts with InsufficientProfit(slot 0, MAX), our contract's answer.
fn pool_code() -> Vec<u8> {
    hex("36 6020 14 6023 57 634e88422a 60e0 1b 6000 52 6000 54 6004 52 6000 19 6024 52 6044 6000 fd 5b 6000 35 6000 54 01 6000 55 00")
}

fn put(s: &mut Snapshot, a: Address, code: Vec<u8>, slots: &[(u64, u64)]) {
    let (hash, bc) = if code.is_empty() { (revm::primitives::KECCAK_EMPTY, None) } else { (keccak256(&code), Some(Bytecode::new_raw(code.clone().into()))) };
    let info = AccountInfo { balance: U256::ZERO, nonce: 1, code_hash: hash, code: None, ..Default::default() };
    s.apply_fact(&Fact::Basics { addr: a, info: Some(info), code: bc });
    for (k, v) in slots {
        s.apply_fact(&Fact::Slot(a, U256::from(*k), U256::from(*v)));
    }
}

/// Confirmed copy: POOL price `p`, OTHER pool price 0, the check's caller.
fn copy_at(p: u64, q: u64) -> Snapshot {
    let mut s = Snapshot::default();
    put(&mut s, pool(), pool_code(), &[(0, p)]);
    put(&mut s, other(), pool_code(), &[(0, q)]);
    put(&mut s, addr(CALLER), vec![], &[]);
    s
}

fn ctx_at(seq: u64) -> BlockCtx {
    BlockCtx { l1_block_number: 500, l2_block_number: Some(seq), timestamp: 1_700_000_000 + seq, basefee: 0, coinbase: Address::ZERO, gas_limit: 1 << 50, prevrandao: B256::with_last_byte(1) }
}

fn confirmed(seq: u64, s: Snapshot, moved: &[(Address, u64)]) -> Confirmed {
    let mut d = StateDiff::default();
    for (a, v) in moved {
        d.accounts.insert(*a, AccountDiff { storage: [(U256::ZERO, U256::from(*v))].into_iter().collect(), ..Default::default() });
    }
    Confirmed { seq, snap: Arc::new(s), ctx: Some(ctx_at(seq)), diff: Arc::new(d), prov: Arc::new(AllExact) }
}

fn stx(nonce: u64, to: Address, v: u64) -> Vec<u8> {
    sign_typed(&KEY, 2, &TestTx { nonce, gas: 300_000, to: Some(to), value: U256::ZERO, data: word(U256::from(v)).to_vec(), access_list: vec![] }, 4663)
}

/// A real feed message (the bot's wire shape, hex transactions).
fn msg(seq: u64, txs: &[Vec<u8>]) -> Arc<BinMsg> {
    let m = WireFeedMsg { seq, ts: 1_700_000_000 + seq, l1: 500, txs: txs.iter().map(|t| to_hex(t)).collect(), complete: true, why: None };
    Arc::new(BinMsg::from_wire(&m, true))
}

/// execute calldata for POOL -> OTHER, V3 flash from LENDER, 400 USDG (6 dec).
fn trade_data(pa: Address, pb: Address) -> Vec<u8> {
    let hop = |p, i, o| Hop { kind: KIND_V3, pool: p, token_in: addr(i), token_out: addr(o), fee_bps: 0, v4_fee: 0, v4_tick_spacing: 0, v4_native: false };
    encode_trade(&DecodedTrade { token: addr(1), amount_in: U256::from(400_000_000u64), min_profit: U256::MAX, max_block: U256::MAX, hops: vec![hop(pa, 1, 2), hop(pb, 2, 1)], flash: FlashLender::V3Flash(addr(LENDER)) })
}

/// The bot's table row for route pa > pb (its check calls POOL `pa` itself).
fn row(pa: Address, pb: Address) -> Row {
    let c = json!({
        "calls": [{ "from": key(addr(CALLER)), "to": key(pa), "gas": "0x7a1200", "data": to_hex(&trade_data(pa, pb)) }],
        "overrides": {},
        "sizes": { "amountOffset": 96, "amounts": ["0x2faf080", "0x8f0d180"] },
        "route": [key(pa), key(pb), key(addr(LENDER))],
        "stop": "0x1", "amt": "0x17d78400",
    });
    let rid = format!("{}>{}:{}", key(pa), key(pb), key(addr(1)));
    Row { rid, held: true, score: Some(1.0), e: Some("x".into()), c: Some(Arc::new(c)), f: Some(Arc::new(json!({ "l": "USDG/COIN test", "px": 1.0, "d": 6, "g": 0.05, "lp": 500 }))) }
}

fn table() -> Arc<Mutex<Table>> {
    let mut t = Table { gen: 1, ..Default::default() };
    t.pools.insert(key(pool()), vec![row(pool(), other())]);
    Arc::new(Mutex::new(t))
}

fn pools() -> Arc<PoolSet> {
    let fp = |a: Address| (FollowedPool { key: key(a), address: a, v4_id: None }, Address::ZERO, Address::ZERO);
    Arc::new(PoolSet::build(&[fp(pool()), fp(other())], HashSet::new()))
}

fn ahead_at(seq: u64, s: Snapshot) -> Ahead {
    let mut a = Ahead::new(AheadCfg::default());
    a.set_pools(pools());
    a.on_confirmed(confirmed(seq, s, &[]), &|_| None);
    a
}

// ---------------------------------------------------------------------------
// Fakes: read node, send endpoint
// ---------------------------------------------------------------------------

struct FakeRead {
    nonce: AtomicU64,
}
impl ReadRpc for FakeRead {
    fn call(&self, method: &str, _p: Value) -> Result<Value, String> {
        match method {
            "eth_getBlockByNumber" => Ok(json!({"number": "0x1f4", "baseFeePerGas": "0x989680"})),
            "eth_getTransactionCount" => Ok(json!(format!("{:#x}", self.nonce.load(Ordering::Relaxed)))),
            "eth_call" => Ok(json!(format!("0x{:064x}{:064x}{:064x}", 20_000u64, 0, 0))),
            _ => Err("unsupported".into()),
        }
    }
}

/// Local send endpoint: answers eth_sendRawTransaction with the tx hash and
/// reports every raw transaction it received.
fn fake_endpoint(got: mpsc::Sender<Vec<u8>>) -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for s in l.incoming() {
            let Ok(s) = s else { continue };
            let got = got.clone();
            std::thread::spawn(move || {
                let mut rd = BufReader::new(s.try_clone().unwrap());
                let mut w = s;
                loop {
                    let mut line = String::new();
                    if rd.read_line(&mut line).unwrap_or(0) == 0 {
                        return;
                    }
                    let mut len = 0usize;
                    loop {
                        let mut h = String::new();
                        if rd.read_line(&mut h).unwrap_or(0) == 0 {
                            return;
                        }
                        if h.trim().is_empty() {
                            break;
                        }
                        if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                            len = v.trim().parse().unwrap();
                        }
                    }
                    let mut body = vec![0u8; len];
                    if rd.read_exact(&mut body).is_err() {
                        return;
                    }
                    let req: Value = serde_json::from_slice(&body).unwrap();
                    let reply = match req["method"].as_str().unwrap() {
                        "eth_chainId" => json!({"jsonrpc": "2.0", "id": 1, "result": "0x1237"}),
                        "eth_sendRawTransaction" => {
                            let raw = parse_bytes(req["params"][0].as_str().unwrap()).unwrap().to_vec();
                            let h = format!("{:#x}", keccak256(&raw));
                            let _ = got.send(raw);
                            json!({"jsonrpc": "2.0", "id": 1, "result": h})
                        }
                        _ => json!({"jsonrpc": "2.0", "id": 1, "error": {"code": -32601, "message": "nope"}}),
                    };
                    let b = reply.to_string();
                    let msg = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}", b.len(), b);
                    if w.write_all(msg.as_bytes()).is_err() {
                        return;
                    }
                }
            });
        }
    });
    format!("http://127.0.0.1:{port}")
}

// ---------------------------------------------------------------------------
// The rig: one lane with its files in a temp folder
// ---------------------------------------------------------------------------

fn tmpdir(tag: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let d = std::env::temp_dir().join(format!("fastlane-e2e-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Node's state file: everything a live send of our test route needs.
fn node_state(rust_sender: bool) -> NodeState {
    let now = arbsim::fastlane::bridge::wall_ms();
    NodeState {
        v: 1,
        written_ms: now,
        loss_day: utc_day(now),
        allowlist: vec![key(addr(1)), key(addr(2))],
        live_pools: vec![key(pool()), key(other())],
        live_ready: true,
        rust_sender,
        approved_lenders: vec![key(addr(LENDER))],
        own_money: OwnMoney { read_ms: now, balances: Default::default() },
        ..Default::default()
    }
}

struct Rig {
    lane: Lane,
    dir: PathBuf,
    sends: PathBuf,
    got: mpsc::Receiver<Vec<u8>>,
}

fn write_state(dir: &PathBuf, st: &NodeState) {
    let tmp = dir.join("state.tmp");
    std::fs::write(&tmp, serde_json::to_vec(st).unwrap()).unwrap();
    std::fs::rename(tmp, dir.join("fastlane-state.json")).unwrap();
}

/// `env`: the settings (FASTLANE, RUST_SENDER, key ...). `st`: Node's state.
fn rig(tag: &str, env: &[(&str, &str)], st: Option<NodeState>) -> Rig {
    let dir = tmpdir(tag);
    let (gtx, grx) = mpsc::channel();
    let url = fake_endpoint(gtx);
    let sends = dir.join("fastlane-sends.jsonl");
    let mut m: std::collections::HashMap<String, String> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    m.insert("KILL_FILE".into(), dir.join("KILL").to_string_lossy().into());
    m.insert("FASTLANE_STATE_FILE".into(), dir.join("fastlane-state.json").to_string_lossy().into());
    m.insert("FASTLANE_SENDS_FILE".into(), sends.to_string_lossy().into());
    m.insert("FASTLANE_PRACTICE_FILE".into(), dir.join("fastlane-practice.jsonl").to_string_lossy().into());
    m.insert("ROBINHOOD_SEND_RPC".into(), url);
    m.insert("ARB_EXECUTOR_ROBINHOOD".into(), "0x00000000000000000000000000000000000000ee".into());
    m.insert("GAP_SENT_POOL_HOLD_MS".into(), "0".into());
    m.insert("FASTLANE_MAX_OPP_AGE_MS".into(), "5000".into());
    let get = |k: &str| m.get(k).cloned();
    if let Some(st) = st {
        write_state(&dir, &st);
    }
    let safety = Safety::new(SafetyConfig::from_lookup(&get), FastlaneMode::from_lookup(get), KillSwitch::from_lookup(&get), StateReader::from_lookup(&get));
    let gate = Arc::new(SafetyGate::new(&safety));
    let log = Arc::new(SendsLog::from_lookup(&get));
    let book = Arc::new(ReplyBook::default());
    let read: Arc<dyn ReadRpc> = Arc::new(FakeRead { nonce: AtomicU64::new(7) });
    let gun = Arc::new(Gun::from_lookup(&get, gate.clone(), reply_hook(log.clone(), book.clone()), Some(read)).unwrap().expect("FASTLANE on"));
    // Gas price (and, live, the nonce) are read in the background: wait.
    let t = Instant::now();
    while gun.not_ready().is_some() && t.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(5));
    }
    let scanner = Scanner::new(ScanConfig { budget_us: 1_000_000, ..ScanConfig::default() }, Box::new(TableSource::owned(table())), Box::new(PlainRunner));
    let practice = Practice::new(PracticeCfg::from_lookup(&get), 0);
    let lane = Lane::new(LaneCfg { tip_max_age_ms: 5_000, ..LaneCfg::default() }, scanner, safety, gate, gun, log, book, practice);
    Rig { lane, dir, sends, got: grx }
}

fn records(p: &PathBuf) -> Vec<SendRecord> {
    std::fs::read_to_string(p).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

fn nothing_broadcast(r: &Rig) {
    assert!(r.got.recv_timeout(Duration::from_millis(300)).is_err(), "nothing may reach the send endpoint");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// 1. Practice: full path, would-sends logged with seq, nothing broadcast,
/// then scored once copy 2 confirms N and N+1.
#[test]
fn practice_runs_everything_and_never_broadcasts() {
    let mut r = rig("practice", &[("FASTLANE", "practice")], Some(node_state(false)));
    assert_eq!(r.lane.gun.mode().as_str(), "practice");
    assert!(!r.lane.gun.broadcasting());
    let mut a = ahead_at(10, copy_at(0, 0));
    // Block 11: a trade moves POOL's price to 1,000,000 ($1 profit at any size).
    a.on_feed_message(msg(11, &[stx(0, pool(), 1_000_000)]));
    let tip = a.tip().expect("predicted tip");
    assert_eq!(tip.changed_pools, vec![key(pool())]);
    let out = r.lane.on_tip(&tip);
    assert_eq!(out.len(), 1, "one opportunity fired");
    let f = &out[0];
    assert!(f.blocked.is_none() && !f.live, "{f:?}");
    let rec = f.record.as_ref().unwrap();
    assert!(rec.signed && !rec.sent && rec.hash.is_some(), "{rec:?}");
    // Block 12: another trade (price 2,000,000): a new result, sent again.
    a.on_feed_message(msg(12, &[stx(1, pool(), 1_000_000)]));
    let out = r.lane.on_tip(&a.tip().unwrap());
    assert_eq!(out.len(), 1);
    assert!(out[0].written.is_some(), "{:?}", out[0]);
    nothing_broadcast(&r);
    let recs = records(&r.sends);
    assert_eq!(recs.len(), 2);
    assert!(recs.iter().all(|x| x.mode == "practice" && x.hash.is_some() && x.seq > 0 && x.total_us > 0));
    assert_eq!(recs[1].seq, recs[0].seq + 1, "seq goes up by one");
    assert_eq!(recs[0].pools, vec![key(pool()), key(other())]);
    assert_eq!(recs[0].block, 11);
    assert!(recs[0].timings_us.contains_key("sign") && recs[0].timings_us.contains_key("scan"));
    // Copy 2 confirms: 11 as predicted (real), 12 differently (price back to
    // 0: gone) and in 13 somebody moved POOL (taken).
    assert_eq!(r.lane.practice.waiting(), 2);
    let blocks = |n: u64| -> Option<ConfirmedBlock> {
        let (p, moved): (u64, Vec<String>) = match n {
            11 => (1_000_000, vec![key(pool())]),
            12 => (0, vec![]),
            13 => (0, vec![key(pool())]),
            _ => return None,
        };
        Some(ConfirmedBlock { snap: Arc::new(copy_at(p, 0)), ctx: ctx_at(n), moved })
    };
    r.lane.practice.score(12, &blocks, &PlainRunner);
    assert_eq!(r.lane.practice.waiting(), 1, "block 12's would-send waits for block 13");
    r.lane.practice.score(13, &blocks, &PlainRunner);
    let h = r.lane.practice.hour.clone();
    assert_eq!((h.would_send, h.scored, h.real, h.gone, h.taken), (2, 2, 1, 1, 1), "{h:?}");
    // Final review: est $ = min(expected, net at N) of the real untouched
    // one MINUS the gas of the gone one (it would have reverted, gas paid).
    let pf = std::fs::read_to_string(r.dir.join("fastlane-practice.jsonl")).unwrap();
    let scores: Vec<Value> = pf.lines().map(|l| serde_json::from_str::<Value>(l).unwrap()).filter(|v| v["kind"] == "score").collect();
    assert_eq!(scores.len(), 2);
    let real = scores.iter().find(|v| v["result"] == "real").unwrap();
    let gone = scores.iter().find(|v| v["result"] == "gone").unwrap();
    let gas = recs.iter().find(|x| x.seq == gone["seq"].as_u64().unwrap()).unwrap().gas_usd;
    assert!(gas > 0.0);
    let want = real["expectedNetUsd"].as_f64().unwrap().min(real["netAtNUsd"].as_f64().unwrap()) - gas;
    assert!((h.est_usd - want).abs() < 1e-9, "est ${} want ${want}", h.est_usd);
    assert!((h.lost_gas_usd - gas).abs() < 1e-9);
    let pred = PredictionCounts { agree: 99, disagree: 1, unsure: 10, compared: 50, unpredicted: 50, msgs: 200, msgs_stopped: 20, over_budget: 3 };
    let line = r.lane.practice.take_hour(Some(pred));
    assert!(line.contains("real 1 (50%)") && line.contains("agreement 99.0% (unsure 9%, unpredicted 50%, stopped 10%, over budget 3)"), "{line}");
    assert!(line.contains(&format!("est. ${want:.2}")) && line.contains("excludes the sequencer trip") && line.contains("upper bound"), "{line}");
    let pf = std::fs::read_to_string(r.dir.join("fastlane-practice.jsonl")).unwrap();
    let hour: Value = pf.lines().map(|l| serde_json::from_str::<Value>(l).unwrap()).find(|v| v["kind"] == "hour").unwrap();
    assert_eq!((hour["unpredictedPct"].as_f64(), hour["stoppedPct"].as_f64()), (Some(50.0), Some(10.0)));
    assert!(pf.lines().any(|l| l.contains("\"kind\":\"hour\"")));
    // Status and hourly lines exist and say practice.
    let st = r.lane.status_json();
    assert_eq!(st["mode"], json!("practice"));
    assert_eq!(st["lane"]["wouldSend"], json!(2));
    assert!(r.lane.take_hour()[0].contains("would send 2"));
}

/// One practice would-send record, as the lane writes it (for the fixture).
fn one_practice_record() -> SendRecord {
    let mut r = rig("fixture-practice", &[("FASTLANE", "practice")], Some(node_state(false)));
    let mut a = ahead_at(10, copy_at(0, 0));
    a.on_feed_message(msg(11, &[stx(0, pool(), 1_000_000)]));
    r.lane.on_tip(&a.tip().unwrap());
    records(&r.sends).remove(0)
}

/// 2. FASTLANE=live, but one condition missing each time: no broadcast.
#[test]
fn live_without_every_switch_never_broadcasts() {
    let all: Vec<(&str, &str)> = vec![("FASTLANE", "live"), ("RUST_SENDER", "on"), ("EXECUTION_ENABLED", "true"), ("LIVE_SEND_CONFIRM", "yes-real-money"), ("BOT_PRIVATE_KEY", WALLET_KEY)];
    let without = |k: &str| all.iter().filter(|x| x.0 != k).cloned().collect::<Vec<_>>();
    // a) RUST_SENDER off (Node is the sender): the gun stays practice and
    //    the safety check refuses (node_is_sender).
    let mut r = rig("no-rust-sender", &without("RUST_SENDER"), Some(node_state(true)));
    assert_eq!(r.lane.gun.mode().as_str(), "practice");
    let mut a = ahead_at(10, copy_at(0, 0));
    a.on_feed_message(msg(11, &[stx(0, pool(), 1_000_000)]));
    let out = r.lane.on_tip(&a.tip().unwrap());
    assert_eq!(out[0].blocked, Some("node_is_sender"));
    nothing_broadcast(&r);
    // b) Node's own RUST_SENDER off (state file rustSender false).
    let mut r = rig("node-not-agreeing", &all, Some(node_state(false)));
    assert_eq!(r.lane.gun.mode().as_str(), "live", "built for live");
    let out = r.lane.on_tip(&a.tip().unwrap());
    assert_eq!(out[0].blocked, Some("node_is_sender"));
    assert!(!r.lane.gun.broadcasting());
    nothing_broadcast(&r);
    // c) No wallet key passed to arbsim (deploy default): practice only.
    let mut r = rig("no-key", &without("BOT_PRIVATE_KEY"), Some(node_state(true)));
    assert_eq!(r.lane.gun.mode().as_str(), "practice");
    assert!(!r.lane.gun.broadcasting());
    let out = r.lane.on_tip(&a.tip().unwrap());
    assert!(!out[0].live && out[0].record.as_ref().is_some_and(|x| !x.sent));
    nothing_broadcast(&r);
    assert!(records(&r.sends).iter().all(|x| x.mode == "practice"));
    // d) A gate that is not a real safety gate: never live (gun's own rule).
    let get = |k: &str| all.iter().find(|x| x.0 == k).map(|x| x.1.to_string()).or_else(|| (k == "ARB_EXECUTOR_ROBINHOOD").then(|| "0x00000000000000000000000000000000000000ee".into()));
    let g = Gun::from_lookup(&get, Arc::new(NoGate), Arc::new(|_: &SendOutcome| {}), Some(Arc::new(FakeRead { nonce: AtomicU64::new(1) }))).unwrap().unwrap();
    assert_eq!(g.mode().as_str(), "practice");
    // e) Kill switch on: blocked at the safety check.
    let mut r = rig("killed", &all, Some(node_state(true)));
    std::fs::write(r.dir.join("KILL"), b"").unwrap();
    assert!(!r.lane.gate.may_broadcast_now());
    let out = r.lane.on_tip(&a.tip().unwrap());
    assert_eq!(out[0].blocked, Some("kill"));
    nothing_broadcast(&r);
    // f) No state file at all (Node not running): fail closed.
    let mut r = rig("no-state", &all, None);
    let out = r.lane.on_tip(&a.tip().unwrap());
    assert_eq!(out[0].blocked, Some("state"));
    nothing_broadcast(&r);
}

/// 3. Everything set against the fake endpoint: exactly one broadcast.
#[test]
fn live_with_everything_set_broadcasts_exactly_once() {
    let env = [("FASTLANE", "live"), ("RUST_SENDER", "on"), ("EXECUTION_ENABLED", "true"), ("LIVE_SEND_CONFIRM", "yes-real-money"), ("BOT_PRIVATE_KEY", WALLET_KEY)];
    let mut r = rig("live", &env, Some(node_state(true)));
    assert_eq!(r.lane.gun.mode().as_str(), "live");
    r.lane.tick();
    assert!(r.lane.gun.broadcasting(), "{:?}", r.lane.gun.why_not_broadcasting());
    let mut a = ahead_at(10, copy_at(0, 0));
    a.on_feed_message(msg(11, &[stx(0, pool(), 1_000_000)]));
    let out = r.lane.on_tip(&a.tip().unwrap());
    assert_eq!(out.len(), 1);
    assert!(out[0].live && out[0].blocked.is_none(), "{:?}", out[0]);
    let raw = r.got.recv_timeout(Duration::from_secs(3)).expect("the endpoint got our transaction");
    assert!(r.got.recv_timeout(Duration::from_millis(300)).is_err(), "exactly one broadcast");
    let hash = format!("{:#x}", keccak256(&raw));
    // The same opportunity again in the next block (same pools): the pool
    // hold / dedupe / rate rules stop a second send of the same gap.
    let rec = out[0].record.as_ref().unwrap();
    assert!(rec.sent && rec.nonce == Some(7), "{rec:?}");
    assert_eq!(rec.hash.as_deref(), Some(hash.as_str()));
    // Its record: live, seq, the same hash. Then the reply line follows.
    let t = Instant::now();
    while records(&r.sends).len() < 2 && t.elapsed() < Duration::from_secs(3) {
        std::thread::sleep(Duration::from_millis(5));
    }
    let recs = records(&r.sends);
    assert_eq!(recs.len(), 2, "{recs:?}");
    assert_eq!((recs[0].mode.as_str(), recs[0].hash.as_deref()), ("live", Some(hash.as_str())));
    assert!(recs[0].seq > 0 && recs[0].kind.is_none());
    assert_eq!(recs[1].kind.as_deref(), Some("reply"));
    assert_eq!(recs[1].reply_to, Some(recs[0].seq));
    assert_eq!(recs[1].status.as_deref(), Some("accepted"));
    assert_eq!(recs[1].reply_hash.as_deref(), Some(hash.as_str()));
    // The live send's gas is held against the loss cap until Node acks it.
    let st = r.lane.status_json();
    assert_eq!(st["lane"]["liveSent"], json!(1));
    assert_eq!(st["gun"]["broadcasting"], json!(true));
    // FASTLANE_E2E_WRITE=1: (re)write the fixture the Node test reads:
    // one practice would-send (seq 9), this live send (10) and its reply (11).
    if std::env::var("FASTLANE_E2E_WRITE").is_ok() {
        let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fastlane-sends-e2e.jsonl");
        let mut out = String::new();
        let mut pr = serde_json::to_value(one_practice_record()).unwrap();
        pr["seq"] = json!(9);
        out.push_str(&format!("{pr}\n"));
        for (i, rec) in recs.iter().enumerate() {
            let mut v = serde_json::to_value(rec).unwrap();
            v["seq"] = json!(10 + i as u64);
            if v.get("replyTo").is_some() {
                v["replyTo"] = json!(10);
            }
            out.push_str(&format!("{v}\n"));
        }
        std::fs::write(p, out).unwrap();
    }
}

/// H4 feedback: Node's dropsSeen CHANGING re-reads the nonce; maxGasUsed
/// tunes the gas limit.
#[test]
fn node_feedback_reaches_the_gun() {
    let env = [("FASTLANE", "live"), ("RUST_SENDER", "on"), ("EXECUTION_ENABLED", "true"), ("LIVE_SEND_CONFIRM", "yes-real-money"), ("BOT_PRIVATE_KEY", WALLET_KEY)];
    let mut r = rig("feedback", &env, Some(node_state(true)));
    let before = r.lane.gun.gas().current_gas_limit();
    r.lane.apply_feedback(Some(0), 0);
    assert_eq!(r.lane.hour.drops_seen, 0, "the first value seen is only remembered");
    let resyncs = r.lane.gun.nonce().resyncs();
    r.lane.apply_feedback(Some(3), 0);
    assert_eq!(r.lane.hour.drops_seen, 1);
    // The gun now wants its nonce re-read (the background tick does it).
    let t = Instant::now();
    while !(r.lane.gun.nonce().wants_resync() || r.lane.gun.nonce().resyncs() > resyncs) && t.elapsed() < Duration::from_secs(3) {
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(r.lane.gun.nonce().wants_resync() || r.lane.gun.nonce().resyncs() > resyncs, "dropsSeen changed: nonce re-read");
    r.lane.apply_feedback(Some(0), 2_000_000);
    assert!(r.lane.gun.gas().current_gas_limit() > before, "gas limit tuned from the receipts");
    // Through the state file too (the loop's tick).
    let mut st = node_state(true);
    st.drops_seen = 5;
    write_state(&r.dir, &st);
    std::thread::sleep(Duration::from_millis(250));
    r.lane.tick();
    assert_eq!(r.lane.hour.drops_seen, 3);
}

/// The gate as the gun sees it: a real gate that lets through only the one
/// trade the lane just cleared.
#[test]
fn safety_gate_is_real_and_only_lets_the_cleared_trade_through() {
    let mut r = rig("gate", &[("FASTLANE", "practice")], Some(node_state(false)));
    assert!(r.lane.gate.is_real());
    let mut a = ahead_at(10, copy_at(0, 0));
    a.on_feed_message(msg(11, &[stx(0, pool(), 1_000_000)]));
    let tip = a.tip().unwrap();
    let out = r.lane.on_tip(&tip);
    let o = &out[0];
    assert!(o.record.as_ref().unwrap().signed);
    // Firing directly (around the safety checks) is refused by the gate.
    let rep = r.lane.scanner.scan(&arbsim::fastlane::scan::BlockInput {
        view: &tip.view(),
        ctx: &tip.ctx,
        block: 99,
        kind: ViewKind::Predicted,
        changed: &[key(pool())],
        unsure: &HashSet::new(),
        snap: None,
    });
    let o2 = rep.opps.first().expect("the scanner finds it again (its pool changed)");
    let rec = r.lane.gun.fire(&arbsim::fastlane::convert::to_call_input(o2));
    assert!(!rec.signed && rec.why.as_deref().unwrap_or("").contains("not cleared"), "{rec:?}");
}

/// 4. BENCH (TEST NUMBERS ONLY, this machine, not the server): one block =
/// ahead apply (20 transactions, 3 on our pools) + scan (~650 pools, ~1,300
/// routes in the table; the changed pools' routes + the sweep) + fire
/// (practice: calldata, safety, sign, log).
#[test]
fn bench_per_block_test_numbers_only() {
    const N: u64 = 650;
    let base = 0x10_000u64;
    let pa = |i: u64| addr(base + i);
    // Copy: 650 pools, each its own price slot.
    let mut s = Snapshot::default();
    for i in 0..N {
        put(&mut s, pa(i), pool_code(), &[(0, 0)]);
    }
    put(&mut s, addr(CALLER), vec![], &[]);
    put(&mut s, other(), pool_code(), &[(0, 0)]);
    // Table: two routes per pool (to OTHER and to the next pool).
    let mut t = Table { gen: 1, ..Default::default() };
    for i in 0..N {
        t.pools.insert(key(pa(i)), vec![row(pa(i), other()), row(pa(i), pa((i + 1) % N))]);
    }
    let fp: Vec<_> = (0..N).map(|i| (FollowedPool { key: key(pa(i)), address: pa(i), v4_id: None }, Address::ZERO, Address::ZERO)).collect();
    let mut a = Ahead::new(AheadCfg::default());
    a.set_pools(Arc::new(PoolSet::build(&fp, HashSet::new())));
    a.on_confirmed(Confirmed { seq: 10, snap: Arc::new(s), ctx: Some(ctx_at(10)), diff: Arc::new(StateDiff::default()), prov: Arc::new(AllExact) }, &|_| None);
    let mut st = node_state(false);
    st.allowlist = vec![key(addr(1)), key(addr(2))];
    st.live_pools = (0..N).map(|i| key(pa(i))).chain([key(other())]).collect();
    let mut r = rig("bench", &[("FASTLANE", "practice"), ("MAX_SENDS_PER_MIN", "100000")], Some(st));
    r.lane.scanner = Scanner::new(ScanConfig::default(), Box::new(TableSource::owned(Arc::new(Mutex::new(t)))), Box::new(PlainRunner));
    r.lane.scanner.sync_now();
    let mut apply = Vec::new();
    let mut scan_fire = Vec::new();
    let mut total = Vec::new();
    let rss0 = rss_kb();
    let mut nonce = 0u64;
    for b in 0..200u64 {
        // 17 transactions on other things + 3 on our pools.
        let mut txs = Vec::new();
        for j in 0..17 {
            txs.push(sign_typed(&KEY, 2, &TestTx { nonce, gas: 50_000, to: Some(addr(0xdead_0000 + j)), value: U256::ZERO, data: vec![1, 2, 3], access_list: vec![] }, 4663));
            nonce += 1;
        }
        for j in 0..3 {
            txs.push(stx(nonce, pa((b * 3 + j) % N), if b % 2 == 0 { 1_000_000 } else { 1 }));
            nonce += 1;
        }
        let t0 = Instant::now();
        a.on_feed_message(msg(11 + b, &txs));
        let t1 = Instant::now();
        let tip = a.tip().expect("tip");
        r.lane.on_tip(&tip);
        let t2 = Instant::now();
        apply.push((t1 - t0).as_micros() as u64);
        scan_fire.push((t2 - t1).as_micros() as u64);
        total.push((t2 - t0).as_micros() as u64);
        // Keep the predicted copy shallow (copy 2 confirms as it goes).
        if b % 8 == 7 {
            let tip = a.tip().unwrap();
            let snap = (*tip.snap).clone();
            a.on_confirmed(Confirmed { seq: tip.seq, snap: Arc::new(snap), ctx: Some(tip.ctx.clone()), diff: Arc::new(StateDiff::default()), prov: Arc::new(AllExact) }, &|_| None);
        }
    }
    let p = |v: &mut Vec<u64>| {
        v.sort();
        (v[v.len() / 2], v[v.len() * 9 / 10], v[v.len() - 1])
    };
    let (a50, a90, amax) = p(&mut apply);
    let (s50, s90, smax) = p(&mut scan_fire);
    let (t50, t90, tmax) = p(&mut total);
    let st = r.lane.status_json();
    eprintln!(
        "TEST NUMBERS ONLY (this machine): {N} pools, {} routes; per block us: ahead apply p50 {a50} p90 {a90} max {amax} | scan+safety+fire p50 {s50} p90 {s90} max {smax} | total p50 {t50} p90 {t90} max {tmax}; would-sends {}; RSS +{} KB",
        r.lane.scanner.routes(),
        st["lane"]["wouldSend"],
        rss_kb().saturating_sub(rss0)
    );
    assert_eq!(r.lane.scanner.routes() as u64, 2 * N);
    assert!(st["lane"]["wouldSend"].as_u64().unwrap() > 0);
    // Generous sanity bound for a shared 2-CPU build box (the target is ~10-15 ms).
    assert!(t50 < 50_000, "per block p50 {t50} us");
}

fn rss_kb() -> u64 {
    std::fs::read_to_string("/proc/self/status").ok().and_then(|s| s.lines().find(|l| l.starts_with("VmRSS:")).and_then(|l| l.split_whitespace().nth(1)?.parse().ok())).unwrap_or(0)
}

/// Final review blocker 3: Rust is live and broadcasting; Node restarts with
/// RUST_SENDER off and its startup guard rewrites the state file with
/// rustSender:false (the same shape fastlaneBridge.ts writeStartupSenderGuard
/// writes). The VERY NEXT fire is refused (no 200 ms poll wait, no 10 s
/// staleness wait) and nothing reaches the endpoint.
#[test]
fn node_startup_guard_stops_rust_at_the_next_fire() {
    let env = [("FASTLANE", "live"), ("RUST_SENDER", "on"), ("EXECUTION_ENABLED", "true"), ("LIVE_SEND_CONFIRM", "yes-real-money"), ("BOT_PRIVATE_KEY", WALLET_KEY)];
    let mut r = rig("startup-guard", &env, Some(node_state(true)));
    r.lane.tick();
    assert!(r.lane.gun.broadcasting(), "{:?}", r.lane.gun.why_not_broadcasting());
    // Node's startup guard (exact JSON shape of the TS function).
    let guard = serde_json::json!({"v": 1, "writtenMs": arbsim::fastlane::bridge::wall_ms(), "rustSender": false, "ackSeq": 0, "dropsSeen": 0, "maxGasUsed": 0, "startupGuard": true});
    let tmp = r.dir.join("state.tmp");
    std::fs::write(&tmp, guard.to_string()).unwrap();
    std::fs::rename(&tmp, r.dir.join("fastlane-state.json")).unwrap();
    let mut a = ahead_at(10, copy_at(0, 0));
    a.on_feed_message(msg(11, &[stx(0, pool(), 1_000_000)]));
    let out = r.lane.on_tip(&a.tip().unwrap());
    // Blocked by the safety check (the guard file also allows no coin, so
    // the first refusal is "allowlist"); either way never sent, and the gun
    // itself no longer counts as broadcasting (Node says it is the sender).
    assert!(out[0].blocked.is_some() && out[0].record.is_none(), "{:?}", out[0]);
    assert!(!r.lane.gate.may_broadcast_now(), "Node's rustSender:false seen at once");
    assert!(!r.lane.gun.broadcasting());
    nothing_broadcast(&r);
}

/// Final review blocker 1: a reply line racing with send records never lands
/// out of seq order, and its mode is "reply" (blocker 4).
#[test]
fn reply_lines_follow_their_send_in_seq_order() {
    let env = [("FASTLANE", "live"), ("RUST_SENDER", "on"), ("EXECUTION_ENABLED", "true"), ("LIVE_SEND_CONFIRM", "yes-real-money"), ("BOT_PRIVATE_KEY", WALLET_KEY)];
    let mut r = rig("reply-order", &env, Some(node_state(true)));
    r.lane.tick();
    let mut a = ahead_at(10, copy_at(0, 0));
    a.on_feed_message(msg(11, &[stx(0, pool(), 1_000_000)]));
    let out = r.lane.on_tip(&a.tip().unwrap());
    assert!(out[0].live, "{:?}", out[0]);
    let t = Instant::now();
    while records(&r.sends).len() < 2 && t.elapsed() < Duration::from_secs(3) {
        std::thread::sleep(Duration::from_millis(5));
    }
    let recs = records(&r.sends);
    assert!(recs.windows(2).all(|w| w[0].seq < w[1].seq), "file order = seq order");
    let reply = recs.iter().find(|x| x.kind.as_deref() == Some("reply")).expect("reply line");
    assert_eq!(reply.mode, "reply", "never \"live\": an older follower can't take it for a failed send");
    assert!(reply.reply_to.unwrap() < reply.seq);
    assert_eq!(r.lane.book.early_dropped(), 0);
}

/// Final review H-1: practice re-checks stay within FASTLANE_PRACTICE_BUDGET_MS
/// per call (at least one each call; the rest wait, counted "deferred").
/// And the est $ rule per scored would-send.
#[test]
fn practice_scoring_keeps_to_its_budget() {
    use arbsim::fastlane::practice::est_gain;
    struct Slow;
    impl CheckRunner for Slow {
        fn run(&self, v: &dyn arbsim::state::StateRead, c: &arbsim::arb::BlockCtx, p: &arbsim::fastlane::scan::PreparedCheck, a: &arbsim::check::search::SizeSearchAmounts) -> Result<arbsim::check::search::SizeSearchResult, arbsim::check::CheckUnknown> {
            std::thread::sleep(Duration::from_millis(3));
            PlainRunner.run(v, c, p, a)
        }
    }
    let mut r = rig("practice-budget", &[("FASTLANE", "practice"), ("FASTLANE_PRACTICE_BUDGET_MS", "1")], Some(node_state(false)));
    assert_eq!(r.lane.practice.cfg.budget_us, 1_000);
    let mut a = ahead_at(10, copy_at(0, 0));
    for n in 0..3u64 {
        a.on_feed_message(msg(11 + n, &[stx(n, pool(), 1_000_000)]));
        r.lane.on_tip(&a.tip().unwrap());
    }
    assert_eq!(r.lane.practice.waiting(), 3);
    let blocks = |n: u64| -> Option<ConfirmedBlock> { Some(ConfirmedBlock { snap: Arc::new(copy_at(1_000_000 * (n - 10), 0)), ctx: ctx_at(n), moved: vec![] }) };
    r.lane.practice.score(20, &blocks, &Slow);
    assert_eq!((r.lane.practice.waiting(), r.lane.practice.hour.deferred), (2, 1), "one re-check, then the budget ran out");
    r.lane.practice.score(20, &blocks, &Slow);
    r.lane.practice.score(20, &blocks, &Slow);
    assert_eq!((r.lane.practice.waiting(), r.lane.practice.hour.scored), (0, 3));
    // est $ rule.
    assert_eq!(est_gain("real", false, 1.0, Some(0.4), 0.05), 0.4, "never more than the confirmed state paid");
    assert_eq!(est_gain("real", false, 1.0, Some(3.0), 0.05), 1.0, "never more than expected");
    assert_eq!(est_gain("real", false, 1.0, None, 0.05), 1.0);
    assert_eq!(est_gain("real", true, 1.0, Some(1.0), 0.05), -0.05, "taken: our trade reverts, gas paid");
    assert_eq!(est_gain("gone", false, 1.0, Some(-0.05), 0.05), -0.05);
    assert_eq!(est_gain("unsure", true, 1.0, None, 0.05), 0.0);
}

/// Practice fixes (Oct 27), task 2: with NO routes (the live symptom) the
/// lane's own work per tip (scan, status bookkeeping, between-tips tick)
/// stays far under 1 ms, also with ~1,800 followed pools and a big unsure
/// list. Live "blockUs" p50 5.2 ms was the predicted copy's apply time added
/// in; the lane now reports its own time apart ("laneUs").
#[test]
fn lane_per_tip_cost_with_no_routes_is_tiny() {
    const N: u64 = 1_800;
    let pa = |i: u64| addr(0x20_000 + i);
    let mut s = Snapshot::default();
    for i in 0..N {
        put(&mut s, pa(i), pool_code(), &[(0, 0)]);
    }
    let fp: Vec<_> = (0..N).map(|i| (FollowedPool { key: key(pa(i)), address: pa(i), v4_id: None }, Address::ZERO, Address::ZERO)).collect();
    // Half the pools "not ready" in copy 2: a 900-key unsure list on every tip.
    let not_ready: HashSet<String> = (0..N / 2).map(|i| key(pa(i))).collect();
    let mut a = Ahead::new(AheadCfg::default());
    a.set_pools(Arc::new(PoolSet::build(&fp, not_ready)));
    a.on_confirmed(Confirmed { seq: 10, snap: Arc::new(s), ctx: Some(ctx_at(10)), diff: Arc::new(StateDiff::default()), prov: Arc::new(AllExact) }, &|_| None);
    let mut r = rig("notable", &[("FASTLANE", "practice")], Some(node_state(false)));
    r.lane.scanner = Scanner::new(ScanConfig::default(), Box::new(TableSource::owned(Arc::new(Mutex::new(Table::default())))), Box::new(PlainRunner));
    let mut lane_us = Vec::new();
    for b in 0..300u64 {
        a.on_feed_message(msg(11 + b, &[stx(b, pa(N - 1 - (b % 100)), 1)]));
        let tip = a.tip().expect("tip");
        assert!(tip.unsure_pools.len() >= 900);
        let t0 = Instant::now();
        r.lane.on_tip(&tip);
        r.lane.tick();
        lane_us.push(t0.elapsed().as_micros() as u64);
        if b % 8 == 7 {
            let snap = (*tip.snap).clone();
            a.on_confirmed(Confirmed { seq: tip.seq, snap: Arc::new(snap), ctx: Some(tip.ctx.clone()), diff: Arc::new(StateDiff::default()), prov: Arc::new(AllExact) }, &|_| None);
        }
    }
    lane_us.sort();
    let (p50, p90, max) = (lane_us[lane_us.len() / 2], lane_us[lane_us.len() * 9 / 10], lane_us[lane_us.len() - 1]);
    let st = r.lane.status_json();
    eprintln!("TEST NUMBERS ONLY (this machine): lane per tip with no routes, {N} pools, 900 unsure: p50 {p50} us p90 {p90} us max {max} us; status laneUs {}", st["lane"]["laneUs"]);
    assert_eq!(r.lane.scanner.routes(), 0);
    assert!(st["lane"]["laneUs"]["p90"].as_u64().is_some(), "the lane's own time is reported apart");
    assert!(p90 < 1_000, "lane per tip p90 {p90} us (target well under 1 ms)");
}
