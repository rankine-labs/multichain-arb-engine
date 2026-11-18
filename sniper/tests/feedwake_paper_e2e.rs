// ============================================================================
// END-TO-END: the REAL paper trader (`paper::run`) with feed wake-up on,
// against the real arbsim engine, a fake node and a fake feed relay.
//
// Plain English:
//   1. The fake node shows one ordinary swap in the pretend pool (polling
//      finds it, the trader looks the pool up and starts watching it).
//   2. Three wallets buy through the FEED (plus one failed swap). The node
//      shows the same three swaps only ~1.5 s later, like a node that is
//      behind the sequencer.
//   3. The trader must find the rush from the feed, run its normal filters
//      and buy path (paper), tag it "src":"feed", then count the node's
//      copies once (dedupe) and record how much earlier the feed was.
//
// Needs the arbsim binary, so plain `cargo test` skips it. Run:
//   (cd sim && cargo build --release --bin arbsim)
//   (cd sniper && cargo test --test feedwake_paper_e2e -- --ignored --nocapture)
// ============================================================================
mod common;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::*;
use serde_json::Value;
use sniper::live::Signer;

fn lines(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

#[test]
#[ignore = "needs the arbsim binary: see the top of this file"]
fn paper_trader_buys_a_rush_found_in_the_feed() {
    let dir = std::env::temp_dir().join(format!("sniper-feedwake-paper-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let socket = dir.join("engine.sock").to_string_lossy().to_string();
    let out = dir.join("run");
    let node = fake_node();
    let stop = Arc::new(AtomicBool::new(false));
    let outbox: Outbox = Arc::new(Mutex::new(Vec::new()));
    let sent: SentAt = Arc::new(Mutex::new(Vec::new()));
    let relay = fake_relay(stop.clone(), outbox.clone(), sent.clone());
    let _engine = start_engine(&dir, &socket, &node);
    // The node is 15 blocks (~1.5 s) behind the feed, like a real node.
    NODE_LAG.store(15, Ordering::Relaxed);

    // The trader's settings (its own test process, so plain env vars).
    let set = [
        ("SNIPER_RHC_HTTP", node.as_str()),
        ("SNIPER_RHC_FEED", relay.as_str()),
        ("SNIPER_OUT", out.to_str().unwrap()),
        ("SNIPER_DURATION_SECS", "16"),
        ("SNIPER_FEED_STALE_SECS", "2"),
        ("SNIPER_VENUES", "v3"),
        ("SNIPER_TAXCHECK", "off"),
        ("SNIPER_MIN_POOL_AGE_SECS", "0"),
        ("SNIPER_MIN_SELLS", "0"),
        ("SNIPER_MAX_RISE_PCT", "1000"),
        ("SNIPER_COIN_CUT_USD", "0"),
        ("SNIPER_MIN_PRIOR_RUSHES", "0"),
        ("SNIPER_AGE_BACKFILL_MIN", "0"),
        ("SNIPER_V4_LOOKUP", "off"),
        ("SNIPER_RHC_POLL_MS", "300"),
        ("SNIPER_RHC_POLL_MS_WHEN_FEED", "500"),
        ("SNIPER_ENGINE", "1"),
        ("SNIPER_ENGINE_SOCKET", socket.as_str()),
        ("SNIPER_FEED_WAKE", "1"),
    ];
    for (k, v) in set {
        // SAFETY: set before the trader thread starts; nothing else reads env here.
        unsafe { std::env::set_var(k, v) };
    }
    let trader = std::thread::spawn(|| sniper::paper::run(sniper::paper::Config::from_env()));

    // Wait for the engine to be ready (the feed is flowing by then).
    let eng = sniper::engine::EngineClient::new(&socket, Duration::from_millis(200), "head");
    let t0 = Instant::now();
    // (asks about the QUOTER, not the pool: the trader's own wake-up must
    // get the pool loaded by itself)
    while eng.call_at(&serde_json::json!({"after": "head"}), &[(sniper::paper::V3_QUOTER_V2.to_string(), "0x".to_string())]).is_err() {
        assert!(t0.elapsed() < Duration::from_secs(30), "engine never ready: {}", std::fs::read_to_string(dir.join("arbsim.log")).unwrap_or_default());
        std::thread::sleep(Duration::from_millis(50));
    }
    // 1) one ordinary swap the node shows (price 1.0, the engine's state): the pool
    //    gets looked up and watched. Then > 1 s (the rush window) passes.
    let w0 = Signer::random().unwrap();
    let b0 = TIP.load(Ordering::Relaxed) + 3;
    LOGS.lock().unwrap().push((b0, swap_log(&format!("0x{}", "aa".repeat(32)), b0, 1, w0.address(), q96(1.0), false), Instant::now()));
    std::thread::sleep(Duration::from_millis(2500));

    // 2) the rush, through the feed: 3 buyers and 1 failed swap.
    let (a, b, c, bad) = (Signer::random().unwrap(), Signer::random().unwrap(), Signer::random().unwrap(), Signer::random().unwrap());
    let prices = [1.01, 5.0, 1.02, 1.03];
    let who = [&a, &bad, &b, &c];
    let txs: Vec<_> = (0..4).map(|i| swap_tx(who[i], q96(prices[i]), i == 1)).collect();
    let n_sent = sent.lock().unwrap().len();
    outbox.lock().unwrap().extend(txs.iter().map(|t| t.raw.clone()));
    let t_wait = Instant::now();
    let seq = loop {
        if let Some((s, _)) = sent.lock().unwrap().get(n_sent).copied() {
            break s;
        }
        assert!(t_wait.elapsed() < Duration::from_secs(3), "relay never sent the rush frame");
        std::thread::sleep(Duration::from_millis(5));
    };
    // The node shows the same swaps (not the failed one) once its "latest"
    // reaches that block (~1.5 s later, see NODE_LAG).
    let later = Instant::now();
    for (i, t) in txs.iter().enumerate() {
        if i != 1 {
            LOGS.lock().unwrap().push((seq, swap_log(&t.hash, seq, i as u64 + 1, who[i].address(), q96(prices[i]), true), later));
        }
    }
    // 4) Feed outage: no frames for > SNIPER_FEED_STALE_SECS. The trader
    //    must say so and go back to normal polling, which still finds a
    //    swap only the node shows.
    std::thread::sleep(Duration::from_millis(2500));
    PAUSE.store(true, Ordering::Relaxed);
    std::thread::sleep(Duration::from_millis(2500));
    let b5 = TIP.load(Ordering::Relaxed).saturating_sub(15) + 2;
    let w5 = Signer::random().unwrap();
    LOGS.lock().unwrap().push((b5, swap_log(&format!("0x{}", "bb".repeat(32)), b5, 1, w5.address(), q96(1.0), false), Instant::now()));
    let r = trader.join().expect("trader thread");
    assert!(r.is_ok(), "trader ended with {r:?}");
    stop.store(true, Ordering::Relaxed);

    // 3) What the trader wrote.
    let sig = lines(&out.join("signals.jsonl"));
    let wake = lines(&out.join(sniper::feedwake::FILE));
    eprintln!("signals: {sig:#?}");
    eprintln!("feedwake: {wake:#?}");
    let rush: Vec<&Value> = sig.iter().filter(|l| l["pool"] == POOL && l["block"] == seq).collect();
    assert_eq!(rush.len(), 1, "exactly one rush at the rush block (the node's copies were not counted again)");
    let r = rush[0];
    assert_eq!(r["src"], "feed", "first seen by the feed");
    assert_eq!(r["taken"], true, "went through the normal filters and buy path: {r}");
    assert_eq!(r["delay"]["src"], "feed");
    eprintln!("rush -> buy ready via feed: {} ms (wait {} + work {})", r["delay"]["total_ms"], r["delay"]["wait_ms"], r["delay"]["work_ms"]);
    let lead: Vec<&Value> = wake.iter().filter(|l| l["ev"] == "rush_lead").collect();
    assert_eq!(lead.len(), 1, "{wake:?}");
    assert_eq!(lead[0]["first"], "feed");
    let ms = lead[0]["lead_ms"].as_f64().expect("the node's copy was matched");
    assert!(ms >= 1000.0, "the feed was ahead by about the node's 1.5 s lag (+ poll pace): {ms}");
    let stats = wake.iter().rev().find(|l| l["ev"] == "stats").expect("final stats");
    assert_eq!(stats["merge"]["polled_feed_first"], 3, "all 3 polled swaps were already known from the feed: {stats}");
    assert_eq!(stats["merge"]["feed_swaps"], 3, "the failed swap made no feed swap: {stats}");
    assert!(wake.iter().any(|l| l["ev"] == "healthy"));
    assert_eq!(wake.iter().filter(|l| l["ev"] == "stale").count(), 1, "the outage was noticed once: {wake:?}");
    assert_eq!(stats["merge"]["polled_all"], 5, "polling kept working during the outage (1 + 3 + 1 swaps): {stats}");
    // The report has the new section.
    let rep = sniper::paper::report(&out);
    eprintln!("{rep}");
    assert!(rep.contains("feed wake-up (speed step 3)"));
    assert!(rep.contains("rushes first seen by feed 1"));
    assert!(rep.contains("rush -> buy ready via feed: 1 buys"));
    assert!(rep.contains("feed went stale 1 time"));
}
