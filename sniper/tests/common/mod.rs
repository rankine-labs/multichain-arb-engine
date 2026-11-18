// ============================================================================
// Shared pieces of the feed wake-up end-to-end tests (feedwake_e2e.rs and
// feedwake_paper_e2e.rs): a fake node, a fake feed relay and the real
// arbsim engine. Everything is local; nothing here touches a real chain.
//
// The fake node holds:
//   - a pretend Uniswap V3 "pool" at POOL (TOKEN / USDG, our factory):
//       slot0()              returns its stored price word (sqrtPriceX96)
//       any other call       stores word 1 of the call data as the new price
//       0xdeadbeef(...)      stores the price, then REVERTS (a failed swap)
//     plus token0()/token1()/fee()/factory() answers for the pool lookup;
//   - a pretend QuoterV2 that answers amountOut = amountIn (no loss);
//   - a log store the test fills: eth_getLogs returns stored logs once they
//     are "visible" (to play a node that is behind the sequencer).
// ============================================================================
#![allow(dead_code)]
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ruint::aliases::U256;
use serde_json::{json, Value};

pub const POOL: &str = "0x00000000000000000000000000000000000f0011";
pub const TOKEN: &str = "0x00000000000000000000000000000000000c0123";
/// The pretend pool (see the top). Hand-assembled:
///   selector = calldata[0..4]
///   slot0()      -> SLOAD(0) as the first of two words
///   0xdeadbeef   -> SSTORE(0, word1) then REVERT
///   otherwise    -> SSTORE(0, word1), STOP
pub const POOL_CODE: &str = "0x60003560e01c80633850c7bd146021578063deadbeef14602d57600435600055005b60005460005260406000f35b600435600055600060006000fd";

/// Starting price word: sqrtPriceX96 = 2^96 (price 1.0).
pub fn q96(x: f64) -> U256 {
    U256::from((x * 1e12) as u128) * (U256::from(1u64) << 96) / U256::from(1_000_000_000_000u64)
}

pub static TIP: AtomicU64 = AtomicU64::new(0);
/// How many blocks the fake node's "latest" is behind the feed (a node that
/// lags the sequencer). 0 = in step.
pub static NODE_LAG: AtomicU64 = AtomicU64::new(0);

/// While set, the fake relay sends no frames (a feed outage).
pub static PAUSE: AtomicBool = AtomicBool::new(false);

/// Logs the fake node will show: (block, log, visible from).
pub static LOGS: Mutex<Vec<(u64, Value, Instant)>> = Mutex::new(Vec::new());

fn word_addr(a: &str) -> String {
    format!("0x{}{}", "0".repeat(24), a.trim_start_matches("0x"))
}

fn answer(method: &str, params: &Value) -> Value {
    let word = |x: u64| format!("0x{x:064x}");
    let is_pool = |p: &Value| p[0].as_str().is_some_and(|a| a.eq_ignore_ascii_case(POOL));
    match method {
        "eth_blockNumber" => json!(format!("0x{:x}", TIP.load(Ordering::Relaxed).saturating_sub(NODE_LAG.load(Ordering::Relaxed)))),
        "eth_getBlockByNumber" => {
            let n = params[0].as_str().and_then(|t| u64::from_str_radix(t.trim_start_matches("0x"), 16).ok()).unwrap_or_else(|| TIP.load(Ordering::Relaxed));
            json!({"number": format!("0x{n:x}"), "hash": word(n + 1), "parentHash": word(n), "timestamp": format!("0x{:x}", 1_700_000_000 + n),
                   "baseFeePerGas": "0x989680", "gasLimit": "0x4000000000000", "miner": "0xa4b000000000000000000073657175656e636572", "mixHash": word(0)})
        }
        "eth_getBalance" | "eth_getTransactionCount" => json!("0x0"),
        "eth_getCode" => json!(if is_pool(params) { POOL_CODE } else { "0x" }),
        "eth_getStorageAt" => {
            let zero_slot = params[1].as_str().is_some_and(|s| s.trim_start_matches("0x").trim_start_matches('0').is_empty());
            json!(if is_pool(params) && zero_slot { format!("0x{:064x}", q96(1.0)) } else { word(0) })
        }
        "eth_gasPrice" => json!("0x989680"),
        "eth_call" => {
            let to = params[0]["to"].as_str().unwrap_or("").to_ascii_lowercase();
            let data = params[0]["data"].as_str().or(params[0]["input"].as_str()).unwrap_or("").to_ascii_lowercase();
            let sel = data.get(..10).unwrap_or("");
            if to == sniper::paper::V3_QUOTER_V2 {
                // amountOut = amountIn (word 2 of quoteExactInputSingle's tuple), gas 90000
                let amount = data.get(10 + 128..10 + 192).unwrap_or(&word(0)[2..]).to_string();
                return json!(format!("0x{amount}{}{}{}", &word(1)[2..], &word(0)[2..], &word(90_000)[2..]));
            }
            if to == POOL {
                return json!(match sel {
                    "0x0dfe1681" => word_addr(TOKEN),
                    "0xd21220a7" => word_addr(sniper::paper::USDG),
                    "0xddca3f43" => word(3000),
                    "0xc45a0155" => word_addr(sniper::paper::V3_FACTORY),
                    "0x3850c7bd" => format!("0x{:064x}{}", q96(1.0), &word(0)[2..]),
                    _ => "0x".to_string(),
                });
            }
            json!("0x")
        }
        "eth_getLogs" => {
            let n = |k: &str| params[0][k].as_str().and_then(|t| u64::from_str_radix(t.trim_start_matches("0x"), 16).ok()).unwrap_or(0);
            let (from, to) = (n("fromBlock"), n("toBlock"));
            let now = Instant::now();
            json!(LOGS.lock().unwrap().iter().filter(|(b, _, vis)| *b >= from && *b <= to && *vis <= now).map(|(_, l, _)| l.clone()).collect::<Vec<_>>())
        }
        _ => Value::Null,
    }
}

pub fn fake_node() -> String {
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

pub fn b64(b: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..=c.len() {
            s.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
        for _ in c.len()..3 {
            s.push('=');
        }
    }
    s
}

/// A feed frame like Robinhood's: one L2 message (kind 3), a batch of txs.
pub fn frame(seq: u64, txs: &[Vec<u8>]) -> String {
    let mut l2 = vec![3u8];
    for t in txs {
        let mut inner = vec![4u8];
        inner.extend(t);
        l2.extend((inner.len() as u64).to_be_bytes());
        l2.extend(inner);
    }
    json!({"version": 1, "messages": [{
        "sequenceNumber": seq,
        "message": {"message": {"header": {"kind": 3, "sender": "0xa4b000000000000000000073657175656e636572", "blockNumber": 500 + seq,
                                            "timestamp": 1_700_000_000 + seq, "requestId": null, "baseFeeL1": null},
                                "l2Msg": b64(&l2)},
                    "delayedMessagesRead": 1},
        "signature": null}]})
    .to_string()
}

/// Transactions waiting for the next frame, and when each frame was SENT.
pub type Outbox = Arc<Mutex<Vec<Vec<u8>>>>;
pub type SentAt = Arc<Mutex<Vec<(u64, Instant)>>>;

pub fn fake_relay(stop: Arc<AtomicBool>, outbox: Outbox, sent: SentAt) -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("ws://{}", l.local_addr().unwrap());
    std::thread::spawn(move || {
        for c in l.incoming() {
            let Ok(c) = c else { continue };
            let (stop, outbox, sent) = (stop.clone(), outbox.clone(), sent.clone());
            std::thread::spawn(move || {
                let Ok(mut ws) = tungstenite::accept(c) else { return };
                let mut seq = 100u64;
                while !stop.load(Ordering::Relaxed) {
                    TIP.store(seq, Ordering::Relaxed);
                    if PAUSE.load(Ordering::Relaxed) {
                        // Feed outage: the chain goes on, no frames are sent.
                        seq += 1;
                        std::thread::sleep(Duration::from_millis(100));
                        continue;
                    }
                    let txs: Vec<Vec<u8>> = std::mem::take(&mut *outbox.lock().unwrap());
                    let has = !txs.is_empty();
                    if ws.send(tungstenite::Message::Text(frame(seq, &txs).into())).is_err() {
                        return;
                    }
                    if has {
                        sent.lock().unwrap().push((seq, Instant::now()));
                    }
                    seq += 1;
                    std::thread::sleep(Duration::from_millis(100));
                }
            });
        }
    });
    url
}

pub struct Engine(pub Child);
impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub fn arbsim_bin() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("ARBSIM_BIN") {
        return Some(PathBuf::from(p));
    }
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sim/target");
    ["release/arbsim", "debug/arbsim"].iter().map(|p| base.join(p)).find(|p| p.exists())
}

/// Start the real engine exactly as sniper/deploy/sniper-engine.sh does
/// (pointed at the fake node). Its log goes to <dir>/arbsim.log.
pub fn start_engine(dir: &Path, socket: &str, node: &str) -> Engine {
    let bin = arbsim_bin().expect("arbsim binary not found: build sim/ first or set ARBSIM_BIN");
    let child = Command::new(&bin)
        .arg("serve")
        .current_dir(dir)
        .env("ARBSIM_SOCKET", socket)
        .env("ARBSIM_SOURCE", "feed")
        .env("ARBSIM_NODE_URL", node)
        .env("ARBSIM_PUBLIC_URL", "off")
        .env("ARBSIM_BUDGET_FILE", dir.join("budget.json"))
        .env("ARBSIM_NODE_DAILY_CAP", "3000")
        .env("ARBSIM_VERIFY_EVERY_N_BLOCKS", "0")
        .env("ARBSIM_HEADER_EVERY_S", "2")
        .env("ARBSIM_HISTORY", "128")
        .env("FASTLANE", "off")
        .stdout(Stdio::null())
        .stderr(std::fs::File::create(dir.join("arbsim.log")).unwrap())
        .spawn()
        .expect("start arbsim");
    Engine(child)
}

/// A signed "swap": call the pool, setting its price to `sqrt` (or the
/// failing variant). The token address rides along in the call data.
pub fn swap_tx(who: &sniper::live::Signer, sqrt: U256, fail: bool) -> sniper::live::SignedTx {
    let mut data = if fail { vec![0xde, 0xad, 0xbe, 0xef] } else { vec![0x12, 0x34, 0x56, 0x78] };
    data.extend(sqrt.to_be_bytes::<32>());
    data.extend([0u8; 12]);
    data.extend((0..20).map(|i| u8::from_str_radix(&TOKEN[2 + 2 * i..4 + 2 * i], 16).unwrap()));
    who.sign(&sniper::live::TxFields { nonce: 0, max_priority_fee: 0, max_fee: 20_000_000, gas_limit: 300_000, to: POOL.into(), value: U256::ZERO, data }).unwrap()
}

/// The V3 Swap log the node would show for one of our pretend swaps (the
/// pool's side: buy = USDG in (+), TOKEN out (-); token is token0).
pub fn swap_log(tx: &str, block: u64, txi: u64, recipient: &str, sqrt: U256, buy: bool) -> Value {
    let (one, minus) = (format!("{:064x}", 1), "f".repeat(64));
    let (a0, a1) = if buy { (minus.clone(), one.clone()) } else { (one.clone(), minus.clone()) };
    json!({"address": POOL, "topics": [sniper::rhc::sig_v3_swap(), word_addr(sniper::live::SWAP_ROUTER_02), word_addr(recipient)],
           "data": format!("0x{a0}{a1}{:064x}{}{}", sqrt, "0".repeat(64), "0".repeat(64)),
           "blockNumber": format!("0x{block:x}"), "transactionIndex": format!("0x{txi:x}"), "logIndex": "0x0", "transactionHash": tx, "removed": false})
}
