// ============================================================================
// END-TO-END: the young-pool test group with FEED WAKE-UP on (the twin of
// young_poll_e2e.rs, which covers the polled path).
//
// Plain English: the same rush as feedwake_paper_e2e.rs, but on a pool far
// younger than SNIPER_MIN_POOL_AGE_SECS, with SNIPER_YOUNG_TEST=1. The rush
// is first seen in the feed; it must be routed exactly like a polled one:
// a main "pool too young" line, then a young test buy tagged
// "group":"young" with "src":"feed", kept out of the main report numbers.
//
// Needs the arbsim binary, so plain `cargo test` skips it. Run:
//   (cd sim && cargo build --release --bin arbsim)
//   (cd sniper && cargo test --test young_feed_e2e -- --ignored --nocapture)
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
fn feed_young_rush_is_routed_like_a_polled_one() {
    let dir = std::env::temp_dir().join(format!("sniper-young-feed-e2e-{}", std::process::id()));
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
        ("SNIPER_DURATION_SECS", "10"),
        ("SNIPER_FEED_STALE_SECS", "2"),
        ("SNIPER_VENUES", "v3"),
        ("SNIPER_TAXCHECK", "off"),
        // Every pool here is "too young" for main.
        ("SNIPER_MIN_POOL_AGE_SECS", "1000000"),
        ("SNIPER_YOUNG_TEST", "1"),
        ("SNIPER_HOLD_SECS", "1"),
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
    let r = trader.join().expect("trader thread");
    assert!(r.is_ok(), "trader ended with {r:?}");
    stop.store(true, Ordering::Relaxed);

    let sig = lines(&out.join("signals.jsonl"));
    eprintln!("signals: {sig:#?}");
    let at_rush: Vec<&Value> = sig.iter().filter(|l| l["pool"] == POOL && l["block"] == seq).collect();
    // Main result: one "pool too young" line, as without the test.
    let main: Vec<&&Value> = at_rush.iter().filter(|l| l.get("group").is_none()).collect();
    assert_eq!(main.len(), 1, "the node's copies were not counted again: {at_rush:?}");
    assert!(main[0]["why"].as_str().unwrap().starts_with("pool too young"), "{}", main[0]);
    assert_eq!(main[0]["src"], "feed");
    // Young test: bought from the feed rush, tagged.
    let young: Vec<&&Value> = at_rush.iter().filter(|l| l["group"] == "young").collect();
    assert_eq!(young.len(), 1, "{at_rush:?}");
    assert_eq!(young[0]["taken"], true, "{}", young[0]);
    assert_eq!(young[0]["src"], "feed");
    assert_eq!(young[0]["delay"]["src"], "feed");
    assert!(young[0]["pool_age_s"].as_f64().is_some());
    let trades = lines(&out.join("paper_trades.jsonl"));
    assert!(trades.iter().filter(|t| t.get("reason").is_some()).all(|t| t["group"] == "young"), "{trades:?}");
    let rep = sniper::paper::report(&out);
    eprintln!("{rep}");
    assert!(rep.contains("| trades 0 |"), "{rep}");
    assert!(rep.contains("young-pool rushes 1 | bought 1"), "{rep}");
}
