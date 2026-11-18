// Linux only: needs Unix sockets / bash (the server is Linux; the Windows
// desktop copy never runs the engine).
#![cfg(unix)]
// ============================================================================
// END-TO-END: the sniper's engine quoter against a REAL `arbsim serve`.
//
// Plain English:
//   Everything here is local and fake except the engine itself:
//     - a fake node (tiny HTTP server) holding a pretend "QuoterV2" contract
//       whose answer is amountOut = whatever is in its storage slot 0
//       (12345), so the engine must fetch code AND storage from the node;
//     - a fake feed relay (local websocket) sending empty Robinhood-style
//       feed frames (one per 100 ms), in the real feed's JSON layout;
//     - the real arbsim binary (sim/ crate, built separately, NOT changed)
//       started with its own socket, ARBSIM_SOURCE=feed.
//   The sniper's own forwarder threads carry the frames from the relay to
//   the engine, then EngineQuoter asks for a V3 quote until the engine
//   answers by itself (first answers are "not ready" / "miss" while it
//   loads), and the amount must be exactly 12345. Then check mode is run
//   against the same fake node, which must agree.
//
// Needs the arbsim binary, so it is skipped by plain `cargo test`. Run:
//   (cd sim && cargo build --release --bin arbsim)
//   (cd sniper && cargo test --test engine_e2e -- --ignored --nocapture)
// ARBSIM_BIN=/path/to/arbsim overrides where the binary is looked for.
// ============================================================================
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ruint::aliases::U256;
use serde_json::{json, Value};
use sniper::engine::{spawn_forwarder, EngineConfig, EngineQuoter, CHECK_FILE};
use sniper::paper::{ChainQuoter, Quoter, V3_QUOTER_V2};
use sniper::sellcheck::Rpc;
use sniper::venue::Venue;

/// Pretend QuoterV2: returns (SLOAD(0), 1, 0, 90000) as four words.
///   PUSH1 0 SLOAD PUSH1 0 MSTORE      amountOut = slot 0
///   PUSH1 1 PUSH1 0x20 MSTORE         sqrtPriceX96After = 1
///   PUSH3 0x015f90 PUSH1 0x60 MSTORE  gasEstimate = 90000
///   PUSH1 0x80 PUSH1 0 RETURN
const FAKE_QUOTER_CODE: &str = "0x600054600052600160205262015f9060605260806000f3";
const AMOUNT_OUT: u64 = 12345;

/// Newest feed sequence number sent (the fake node's "latest block").
static TIP: AtomicU64 = AtomicU64::new(0);

/// One JSON-RPC answer from the fake chain.
fn answer(method: &str, params: &Value) -> Value {
    let word = |x: u64| format!("0x{x:064x}");
    let is_quoter = |p: &Value| p[0].as_str().is_some_and(|a| a.eq_ignore_ascii_case(V3_QUOTER_V2));
    match method {
        "eth_blockNumber" => json!(format!("0x{:x}", TIP.load(Ordering::Relaxed))),
        "eth_getBlockByNumber" => {
            let n = params[0].as_str().and_then(|t| u64::from_str_radix(t.trim_start_matches("0x"), 16).ok()).unwrap_or_else(|| TIP.load(Ordering::Relaxed));
            json!({"number": format!("0x{n:x}"), "hash": word(n + 1), "parentHash": word(n), "timestamp": format!("0x{:x}", 1_700_000_000 + n),
                   "baseFeePerGas": "0x989680", "gasLimit": "0x4000000000000", "miner": "0xa4b000000000000000000073657175656e636572", "mixHash": word(0)})
        }
        "eth_getBalance" | "eth_getTransactionCount" => json!("0x0"),
        "eth_getCode" => json!(if is_quoter(params) { FAKE_QUOTER_CODE } else { "0x" }),
        "eth_getStorageAt" => json!(if is_quoter(params) && params[1].as_str().is_some_and(|s| s.trim_start_matches("0x").trim_start_matches('0').is_empty()) { word(AMOUNT_OUT) } else { word(0) }),
        // The node's own quote (check mode): same pretend contract.
        "eth_call" => json!(format!("{}{}{}{}", word(AMOUNT_OUT), &word(1)[2..], &word(0)[2..], &word(90_000)[2..])),
        "eth_gasPrice" => json!("0x989680"),
        _ => Value::Null,
    }
}

/// Fake node: plain HTTP/1.1, one request per connection, batches allowed.
fn fake_node() -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    std::thread::spawn(move || {
        for c in l.incoming() {
            let Ok(c) = c else { continue };
            std::thread::spawn(move || serve_http(c));
        }
    });
    url
}

fn serve_http(c: TcpStream) {
    let mut r = BufReader::new(c.try_clone().unwrap());
    let mut len = 0usize;
    loop {
        let mut line = String::new();
        if r.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        if line == "\r\n" {
            break;
        }
        if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            len = v.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; len];
    if r.read_exact(&mut body).is_err() {
        return;
    }
    let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let one = |q: &Value| json!({"jsonrpc": "2.0", "id": q["id"], "result": answer(q["method"].as_str().unwrap_or(""), &q["params"])});
    let out = match &req {
        Value::Array(a) => Value::Array(a.iter().map(one).collect()),
        q => one(q),
    }
    .to_string();
    let mut c = c;
    let _ = write!(c, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}", out.len());
}

/// A feed frame like Robinhood's: one L2 message (kind 3), an empty batch.
fn frame(seq: u64) -> String {
    json!({"version": 1, "messages": [{
        "sequenceNumber": seq,
        "message": {"message": {"header": {"kind": 3, "sender": "0xa4b000000000000000000073657175656e636572", "blockNumber": 500 + seq,
                                            "timestamp": 1_700_000_000 + seq, "requestId": null, "baseFeeL1": null},
                                "l2Msg": "Aw=="}, // base64 of [3] = batch with no transactions
                    "delayedMessagesRead": 1},
        "signature": null}]})
    .to_string()
}

/// Fake feed relay: a local websocket sending a new frame every 100 ms.
fn fake_relay(stop: Arc<AtomicBool>) -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("ws://{}", l.local_addr().unwrap());
    std::thread::spawn(move || {
        for c in l.incoming() {
            let Ok(c) = c else { continue };
            let stop = stop.clone();
            std::thread::spawn(move || {
                let Ok(mut ws) = tungstenite::accept(c) else { return };
                let mut seq = 100u64;
                while !stop.load(Ordering::Relaxed) {
                    TIP.store(seq, Ordering::Relaxed);
                    if ws.send(tungstenite::Message::Text(frame(seq).into())).is_err() {
                        return;
                    }
                    seq += 1;
                    std::thread::sleep(Duration::from_millis(100));
                }
            });
        }
    });
    url
}

struct Engine(Child);
impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// The engine's own status answer (shown when something fails).
fn status(socket: &str) -> Value {
    let Ok(mut s) = std::os::unix::net::UnixStream::connect(socket) else { return Value::Null };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = sniper::engine::write_msg(&mut s, json!({"id": 1, "type": "status"}).to_string().as_bytes());
    sniper::engine::read_msg(&mut s).ok().flatten().and_then(|m| serde_json::from_slice(&m).ok()).unwrap_or(Value::Null)
}

fn arbsim_bin() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("ARBSIM_BIN") {
        return Some(PathBuf::from(p));
    }
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sim/target");
    ["release/arbsim", "debug/arbsim"].iter().map(|p| base.join(p)).find(|p| p.exists())
}

#[test]
#[ignore = "needs the arbsim binary: see the top of this file"]
fn real_engine_quotes_through_the_sniper() {
    let bin = arbsim_bin().expect("arbsim binary not found: build sim/ first or set ARBSIM_BIN");
    let dir = std::env::temp_dir().join(format!("sniper-engine-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let socket = dir.join("engine.sock").to_string_lossy().to_string();
    let node = fake_node();
    let stop = Arc::new(AtomicBool::new(false));
    let relay = fake_relay(stop.clone());

    // The second engine, exactly as sniper/deploy/sniper-engine.sh starts it
    // (here pointed at the fake node; the free public node switched off).
    let child = Command::new(&bin)
        .arg("serve")
        .current_dir(&dir)
        .env("ARBSIM_SOCKET", &socket)
        .env("ARBSIM_SOURCE", "feed")
        .env("ARBSIM_NODE_URL", &node)
        .env("ARBSIM_PUBLIC_URL", "off")
        .env("ARBSIM_BUDGET_FILE", dir.join("budget.json"))
        .env("ARBSIM_NODE_DAILY_CAP", "3000")
        .env("ARBSIM_VERIFY_EVERY_N_BLOCKS", "0")
        // Needed in feed mode on a ~10 blocks/s chain: the engine fills a
        // missing value at the node's newest block, which it re-reads only
        // every ARBSIM_HEADER_EVERY_S (default 300 s); once that block is
        // older than the ARBSIM_HISTORY blocks it keeps (default 64, ~7 s)
        // every fill is thrown away as "too old". Found by this test.
        .env("ARBSIM_HEADER_EVERY_S", "2")
        .env("ARBSIM_HISTORY", "128")
        .env("FASTLANE", "off")
        .stdout(Stdio::null())
        .stderr(std::fs::File::create(dir.join("arbsim.log")).unwrap())
        .spawn()
        .expect("start arbsim");
    let _engine = Engine(child);

    // The sniper side: settings as the paper trader reads them.
    let env = |k: &str| match k {
        "SNIPER_ENGINE" => Some("1".to_string()),
        "SNIPER_ENGINE_SOCKET" => Some(socket.clone()),
        "SNIPER_RHC_FEED" => Some(relay.clone()),
        _ => None,
    };
    let (cfg, warn) = EngineConfig::from_lookup(env);
    assert!(cfg.on && warn.is_none());
    let fwd = spawn_forwarder(&cfg, stop.clone());
    // Node fallback = a dead port, so a quote only succeeds if the ENGINE answered.
    let q = EngineQuoter::new(ChainQuoter { rpc: Rpc::new("http://127.0.0.1:9") }, "http://127.0.0.1:9", &cfg, &dir).unwrap();
    let v3 = Venue::V3 { fee: 3000 };
    let (a, b) = ("0x0bd7d308f8e1639fab988df18a8011f41eacad73", "0x5fc5360d0400a0fd4f2af552add042d716f1d168");
    let t0 = Instant::now();
    let got = loop {
        if let Ok(r) = q.quote(&v3, a, b, U256::from(10u64).pow(U256::from(18u64))) {
            break r;
        }
        assert!(t0.elapsed() < Duration::from_secs(30), "engine never answered: {} | {} | status: {} | log: {}", q.stats.summary(), fwd.summary(), status(&socket), std::fs::read_to_string(dir.join("arbsim.log")).unwrap_or_default());
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(got, (U256::from(AMOUNT_OUT), 90_000));
    eprintln!("first engine answer after {:.0} ms: {} | {}", t0.elapsed().as_secs_f64() * 1000.0, q.stats.summary(), fwd.summary());
    assert!(fwd.sent.load(Ordering::Relaxed) > 0);

    // Warm now: 200 quotes in a row, every one answered by the engine.
    let before = q.stats.fallback_total();
    let mut ms = Vec::new();
    for _ in 0..200 {
        let t = Instant::now();
        assert_eq!(q.quote(&v3, a, b, U256::from(1000u64)).unwrap().0, U256::from(AMOUNT_OUT));
        ms.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    assert_eq!(q.stats.fallback_total(), before, "a warm engine answered everything");
    eprintln!("warm local round trip ms: p50 {:.3} p95 {:.3} max {:.3}", sniper::paper::pct(&ms, 50.0).unwrap(), sniper::paper::pct(&ms, 95.0).unwrap(), sniper::paper::pct(&ms, 100.0).unwrap());

    // Check mode against the same engine and the fake node: both agree.
    let mut ccfg = cfg.clone();
    ccfg.check = true;
    let qc = EngineQuoter::new(ChainQuoter { rpc: Rpc::new(&node) }, &node, &ccfg, &dir).unwrap();
    for _ in 0..5 {
        assert_eq!(qc.quote(&v3, a, b, U256::from(7u64)).unwrap().0, U256::from(AMOUNT_OUT));
    }
    let lines: Vec<Value> = std::fs::read_to_string(dir.join(CHECK_FILE)).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(lines.len(), 5);
    assert!(lines.iter().all(|l| l["match"] == json!(true) && l["engine_block"].as_u64().is_some()), "{lines:?}");
    eprintln!("{}", sniper::engine::report_section(&dir, &[]));
    stop.store(true, Ordering::Relaxed);
}
