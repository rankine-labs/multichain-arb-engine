// ============================================================================
// End-to-end: run the real probe against two fake BSC websocket nodes.
//
// Fake pending node:
//   connection 1: refuses the full-tx subscription form, accepts the
//                 hash-only fallback, then drops the connection (outage)
//   connection 2: accepts again and announces tx 0xaa..aa as pending
// Fake block node:
//   sends block 100's header, then two Four.meme buys: 0xaa..aa (which was
//   announced pending) and 0xbb..bb (which never was = "private").
// Expected: reconnect happens, 1 of 2 buys covered, lead time > 0.
// ============================================================================
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use sniper::fourmeme::{Topics, TOKEN_MANAGER_1, TOKEN_MANAGER_2};
use sniper::{probe, report};
use tungstenite::{accept, Message};

const TX_A: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TX_B: &str = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn note(sub: &str, result: Value) -> Message {
    Message::text(json!({"jsonrpc": "2.0", "method": "eth_subscription", "params": {"subscription": sub, "result": result}}).to_string())
}

fn read_req(ws: &mut tungstenite::WebSocket<std::net::TcpStream>) -> Value {
    loop {
        if let Message::Text(t) = ws.read().unwrap() {
            return serde_json::from_str(&t).unwrap();
        }
    }
}

fn buy_log(tx: &str, account_byte: u8, price: u64) -> Value {
    let t = Topics::new();
    let mut data = String::from("0x");
    data.push_str(&format!("{:0>64}", "4444000000000000000000000000000000000001")); // token
    data.push_str(&format!("{:0>64}", format!("{account_byte:02x}").repeat(20))); // account
    for v in [price, 10u64.pow(18), 5 * 10u64.pow(17), 10u64.pow(15), 0, 0] {
        data.push_str(&format!("{v:064x}"));
    }
    json!({"address": TOKEN_MANAGER_2, "topics": [t.purchase], "data": data, "transactionHash": tx,
           "blockNumber": "0x64", "logIndex": "0x0", "transactionIndex": "0x0", "removed": false})
}

#[test]
fn probe_measures_coverage_and_survives_reconnect() {
    // ---- fake pending node ----
    let pl = TcpListener::bind("127.0.0.1:0").unwrap();
    let paddr = pl.local_addr().unwrap();
    let conns = Arc::new(AtomicUsize::new(0));
    let c2 = conns.clone();
    thread::spawn(move || {
        for stream in pl.incoming() {
            let n = c2.fetch_add(1, Ordering::SeqCst);
            let mut ws = accept(stream.unwrap()).unwrap();
            let req = read_req(&mut ws);
            if req["params"].as_array().unwrap().len() == 2 {
                // Refuse full-tx form, expect hash-only fallback next.
                ws.send(Message::text(json!({"jsonrpc":"2.0","id":req["id"],"error":{"code":-32602,"message":"no full tx"}}).to_string())).unwrap();
                let fb = read_req(&mut ws);
                assert_eq!(fb["params"], json!(["newPendingTransactions"]));
                ws.send(Message::text(json!({"jsonrpc":"2.0","id":fb["id"],"result":"0xp1"}).to_string())).unwrap();
            } else {
                ws.send(Message::text(json!({"jsonrpc":"2.0","id":req["id"],"result":"0xp1"}).to_string())).unwrap();
            }
            if n == 0 {
                // Simulated outage: drop the first connection.
                drop(ws);
                continue;
            }
            thread::sleep(Duration::from_millis(100));
            ws.send(note("0xp1", json!(TX_A))).unwrap();
            // Keep the connection open until the test ends.
            thread::sleep(Duration::from_secs(10));
        }
    });

    // ---- fake block node ----
    let bl = TcpListener::bind("127.0.0.1:0").unwrap();
    let baddr = bl.local_addr().unwrap();
    thread::spawn(move || {
        let mut ws = accept(bl.incoming().next().unwrap().unwrap()).unwrap();
        for _ in 0..2 {
            let req = read_req(&mut ws);
            let kind = req["params"][0].as_str().unwrap().to_string();
            if kind == "logs" {
                // Filter must cover both TokenManagers and our event ids.
                let f = &req["params"][1];
                assert!(f["address"].as_array().unwrap().iter().any(|a| a == TOKEN_MANAGER_2));
                assert!(f["address"].as_array().unwrap().iter().any(|a| a == TOKEN_MANAGER_1));
                assert_eq!(f["topics"][0].as_array().unwrap().len(), 4);
            }
            let sid = if kind == "newHeads" { "0xh" } else { "0xl" };
            ws.send(Message::text(json!({"jsonrpc":"2.0","id":req["id"],"result":sid}).to_string())).unwrap();
        }
        // Wait until the pending node has (re)connected and announced TX_A.
        thread::sleep(Duration::from_millis(2_500));
        ws.send(note("0xh", json!({"number": "0x64", "hash": "0x01", "timestamp": "0x10"}))).unwrap();
        ws.send(note("0xl", buy_log(TX_A, 0x11, 100))).unwrap();
        ws.send(note("0xl", buy_log(TX_B, 0x22, 101))).unwrap();
        thread::sleep(Duration::from_secs(10));
    });

    let out: PathBuf = std::env::temp_dir().join(format!("sniper-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out);
    let cfg = probe::Config {
        pending: vec![("node".into(), format!("ws://{paddr}"))],
        block_ws: format!("ws://{baddr}"),
        out: out.clone(),
        duration: Some(Duration::from_secs(4)),
        ttl_secs: 180,
        hash_only: false,
        contracts: vec![TOKEN_MANAGER_2.into(), TOKEN_MANAGER_1.into()],
    };
    probe::run(cfg).unwrap();

    assert!(conns.load(Ordering::SeqCst) >= 2, "probe should have reconnected");

    let opts = report::Opts { warmup_secs: 0.0, ..Default::default() };
    let r = report::build(&out, &opts);
    let buy = &r["visibility"]["node"]["buy"];
    assert_eq!(buy["confirmed"], 2, "report: {r:#}");
    assert_eq!(buy["seen_pending"], 1);
    assert_eq!(buy["coverage_pct"].as_f64().unwrap(), 50.0);
    assert!(buy["lead_ms"]["p50"].as_f64().unwrap() > 0.0);
    // The rendered text mentions the coverage line.
    assert!(report::render(&r).contains("coverage 50.0%"));
    let _ = std::fs::remove_dir_all(&out);
}
