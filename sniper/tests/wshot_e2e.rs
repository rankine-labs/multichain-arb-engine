// ============================================================================
// END-TO-END: the hot-pool WebSocket (wshot.rs) in the REAL paper trader,
// against a fake HTTP node AND a fake WebSocket node. Everything is local.
//
// Plain English:
//   1. One ordinary swap is polled from the fake HTTP node: the pool gets
//      looked up and becomes "hot". The trader must then subscribe to it on
//      the fake WebSocket node, filtered BY ADDRESS (only that pool).
//   2. A rush (3 buyers, price up 3%) is pushed over the WebSocket at once,
//      while the HTTP node is 2 s (20 blocks) behind, so polling only gets
//      those logs ~2 s later. The rush must be
//      found from the WebSocket ("src":"ws"), bought, and counted ONCE (the
//      later polled copies are recognised as the same swaps).
//   3. The fake WebSocket node drops the connection. While it is down a swap
//      happens that is never pushed. The trader must reconnect, subscribe
//      again and FILL IN the gap from the HTTP node (eth_getLogs), so that
//      swap is not lost; repeats are dropped (tx hash + log index).
//   4. Every pushed message is counted; the report has the WebSocket
//      section (rushes first seen by ws, fill-ins, messages per day).
//   Runs in plain `cargo test` (~15 s, no binaries needed).
// ============================================================================
mod common;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use serde_json::{json, Value};
use sniper::live::Signer;

fn lines(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

fn wait_for(what: &str, secs: u64, f: impl Fn() -> bool) {
    let t = Instant::now();
    while !f() {
        assert!(t.elapsed() < Duration::from_secs(secs), "timed out waiting for: {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn hot_pool_websocket_finds_the_rush_first_and_fills_gaps() {
    let dir = std::env::temp_dir().join(format!("sniper-wshot-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let out = dir.join("run");
    let node = fake_node();
    let wss = fake_ws();
    // The chain moves on by itself: one block every 100 ms.
    let stop = Arc::new(AtomicBool::new(false));
    TIP.store(1000, Ordering::Relaxed);
    // The HTTP node is 20 blocks (~2 s) behind the chain, like a node that
    // lags the sequencer; the WebSocket node pushes at once.
    NODE_LAG.store(20, Ordering::Relaxed);
    {
        let stop = stop.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(100));
                TIP.fetch_add(1, Ordering::Relaxed);
            }
        });
    }
    let set = [
        ("SNIPER_RHC_HTTP", node.as_str()),
        ("SNIPER_RHC_WSS", wss.as_str()),
        ("SNIPER_OUT", out.to_str().unwrap()),
        ("SNIPER_DURATION_SECS", "16"),
        ("SNIPER_VENUES", "v3"),
        ("SNIPER_TAXCHECK", "off"),
        ("SNIPER_MIN_POOL_AGE_SECS", "0"),
        ("SNIPER_MIN_SELLS", "0"),
        ("SNIPER_MAX_RISE_PCT", "1000"),
        ("SNIPER_COIN_CUT_USD", "0"),
        ("SNIPER_MIN_PRIOR_RUSHES", "0"),
        ("SNIPER_AGE_BACKFILL_MIN", "0"),
        ("SNIPER_V4_LOOKUP", "off"),
        ("SNIPER_RHC_POLL_MS", "200"),
        ("SNIPER_HOLD_SECS", "1"),
        ("SNIPER_WS_HOT", "1"),
        ("SNIPER_WS_HOT_RENEW_SECS", "1"),
    ];
    for (k, v) in set {
        // SAFETY: set before the trader thread starts; this test binary has one test.
        unsafe { std::env::set_var(k, v) };
    }
    let trader = std::thread::spawn(|| sniper::paper::run(sniper::paper::Config::from_env()));
    std::thread::sleep(Duration::from_millis(800));

    // 1) one ordinary polled swap: the pool becomes hot and is subscribed BY ADDRESS.
    let w0 = Signer::random().unwrap();
    let b0 = TIP.load(Ordering::Relaxed) + 2;
    LOGS.lock().unwrap().push((b0, swap_log(&format!("0x{}", "aa".repeat(32)), b0, 1, w0.address(), q96(1.0), false), Instant::now()));
    wait_for("a subscription for the hot pool", 8, || SUBS_SEEN.lock().unwrap().iter().any(|f| f["address"].as_array().is_some_and(|a| a.iter().any(|x| x == POOL))));
    {
        let subs = SUBS_SEEN.lock().unwrap();
        for f in subs.iter() {
            let a = f["address"].as_array().expect("every subscription has an address list (never the whole chain)");
            assert!(!a.is_empty() && a.len() <= 400, "{f}");
        }
    }

    // 2) the rush: pushed NOW; polling sees it once the lagging node has that block.
    let rush_block = TIP.load(Ordering::Relaxed) + 1;
    for (i, px) in [1.01, 1.02, 1.03].iter().enumerate() {
        let w = Signer::random().unwrap();
        let tx = format!("0x{:064x}", 0xb0 + i);
        let l = swap_log(&tx, rush_block, i as u64 + 1, w.address(), q96(*px), true);
        let mut l = l;
        l["logIndex"] = json!(format!("0x{i:x}"));
        PUSH.lock().unwrap().push(l.clone());
        LOGS.lock().unwrap().push((rush_block, l, Instant::now()));
    }
    std::thread::sleep(Duration::from_millis(3500));

    // 3) outage: the connection drops; a swap happens that is never pushed.
    let conns = CONNS.load(Ordering::Relaxed);
    DOWN.store(true, Ordering::Relaxed);
    DROP.store(true, Ordering::Relaxed);
    std::thread::sleep(Duration::from_millis(500));
    // A block the (lagging) HTTP node already has, after the outage began.
    let gap_block = TIP.load(Ordering::Relaxed) - 18;
    let gap_tx = format!("0x{}", "cc".repeat(32));
    LOGS.lock().unwrap().push((gap_block, swap_log(&gap_tx, gap_block, 1, Signer::random().unwrap().address(), q96(1.03), false), Instant::now()));
    std::thread::sleep(Duration::from_millis(300));
    DOWN.store(false, Ordering::Relaxed);
    wait_for("a reconnect", 10, || CONNS.load(Ordering::Relaxed) > conns);

    let r = trader.join().expect("trader thread");
    stop.store(true, Ordering::Relaxed);
    assert!(r.is_ok(), "trader ended with {r:?}");

    let sig = lines(&out.join("signals.jsonl"));
    let ws = lines(&out.join(sniper::wshot::FILE));
    eprintln!("signals: {sig:#?}\nwshot: {ws:#?}");
    // The rush: found once, from the WebSocket, and bought.
    let at_rush: Vec<&Value> = sig.iter().filter(|l| l["pool"] == POOL && l["block"] == rush_block && l.get("live_skip").is_none()).collect();
    assert_eq!(at_rush.len(), 1, "counted once across ws + poll: {at_rush:?}");
    assert_eq!(at_rush[0]["src"], "ws", "{}", at_rush[0]);
    assert_eq!(at_rush[0]["taken"], true, "{}", at_rush[0]);
    assert_eq!(at_rush[0]["delay"]["src"], "ws");
    assert_eq!(at_rush[0]["delay"]["fetch_ms"], 0.0, "no node fetch of our own for a pushed rush");

    // Final stats: messages counted, a reconnect, a fill-in that found the gap swap.
    let stats = ws.iter().rev().find(|l| l["ev"] == "stats").expect("final stats line");
    let w = &stats["ws"];
    assert!(w["messages"].as_u64().unwrap() > 3, "3 rush logs + subscription replies counted: {w}");
    assert!(w["sessions"].as_u64().unwrap() >= 2, "reconnected: {w}");
    assert!(w["fills"].as_u64().unwrap() >= 1, "fill-in after the reconnect: {w}");
    assert!(w["fill_logs"].as_u64().unwrap() >= 1, "the never-pushed gap swap came in through the fill-in: {w}");
    let m = &stats["merge"];
    assert!(m["ws_swaps"].as_u64().unwrap() >= 3, "{m}");
    assert!(m["polled_ws_first"].as_u64().unwrap() >= 3, "the polled rush logs were recognised as already pushed: {m}");
    // Free estimate ran too (default on) and saw the polled logs of the hot pool.
    let est = ws.iter().rev().find(|l| l["ev"] == "estimate").expect("estimate line");
    assert!(est["matched"].as_u64().unwrap() >= 3, "{est}");
    assert!(ws.iter().any(|l| l["ev"] == "healthy"), "went healthy");
    assert!(lines(&out.join("meta.jsonl")).iter().any(|m| m["event"] == "wshot" && m["on"] == true));

    let rep = sniper::paper::report(&out);
    eprintln!("{rep}");
    assert!(rep.contains("hot-pool WebSocket"), "{rep}");
    assert!(rep.contains("rushes first seen by: ws 1"), "{rep}");
    assert!(rep.contains("fill-ins "), "{rep}");
    let _ = std::fs::remove_dir_all(&dir);
}
