// ============================================================================
// END-TO-END: the young-pool test group in the REAL paper trader
// (`paper::run`), POLLED path (no engine, no feed), against the fake node.
//
// Plain English:
//   The pretend pool is far younger than SNIPER_MIN_POOL_AGE_SECS. With
//   SNIPER_YOUNG_TEST=1 a rush on it must:
//     1. still be written as "pool too young" for the main results (no group),
//     2. then be bought as a "young" test trade (tagged "group":"young" with
//        its pool age), and closed by the normal exit logic,
//     3. stay out of every main number in the report, and show up in the
//        "young pool test group" section.
//   Runs in plain `cargo test` (~10 s, everything local, no binaries needed).
//   The feed wake-up twin of this test is young_feed_e2e.rs.
// ============================================================================
mod common;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use serde_json::Value;
use sniper::live::Signer;

fn lines(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

#[test]
fn polled_young_rush_is_a_separate_young_trade() {
    let dir = std::env::temp_dir().join(format!("sniper-young-poll-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let out = dir.join("run");
    let node = fake_node();
    // The chain moves on by itself: one block every 100 ms.
    let stop = Arc::new(AtomicBool::new(false));
    TIP.store(1000, Ordering::Relaxed);
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
        ("SNIPER_OUT", out.to_str().unwrap()),
        ("SNIPER_DURATION_SECS", "8"),
        ("SNIPER_VENUES", "v3"),
        ("SNIPER_TAXCHECK", "off"),
        // Every pool here is "too young" for main (the fake pool is ~100 s old).
        ("SNIPER_MIN_POOL_AGE_SECS", "1000000"),
        ("SNIPER_MIN_SELLS", "0"),
        ("SNIPER_MAX_RISE_PCT", "1000"),
        ("SNIPER_COIN_CUT_USD", "0"),
        ("SNIPER_MIN_PRIOR_RUSHES", "0"),
        ("SNIPER_AGE_BACKFILL_MIN", "0"),
        ("SNIPER_V4_LOOKUP", "off"),
        ("SNIPER_RHC_POLL_MS", "200"),
        ("SNIPER_HOLD_SECS", "1"),
        ("SNIPER_YOUNG_TEST", "1"),
    ];
    for (k, v) in set {
        // SAFETY: set before the trader thread starts; this test binary has one test.
        unsafe { std::env::set_var(k, v) };
    }
    let trader = std::thread::spawn(|| sniper::paper::run(sniper::paper::Config::from_env()));
    std::thread::sleep(Duration::from_millis(1000));

    // 1) one ordinary swap (price 1.0): the pool gets looked up.
    let w0 = Signer::random().unwrap();
    let b0 = TIP.load(Ordering::Relaxed) + 3; // ahead of what the trader has polled
    LOGS.lock().unwrap().push((b0, swap_log(&format!("0x{}", "aa".repeat(32)), b0, 1, w0.address(), q96(1.0), false), Instant::now()));
    std::thread::sleep(Duration::from_millis(1500));
    // 2) the rush: three different buyers in one block, price up 3%.
    let rush_block = TIP.load(Ordering::Relaxed) + 3;
    for (i, px) in [1.01, 1.02, 1.03].iter().enumerate() {
        let w = Signer::random().unwrap();
        let tx = format!("0x{:064x}", 0xb0 + i);
        LOGS.lock().unwrap().push((rush_block, swap_log(&tx, rush_block, i as u64 + 1, w.address(), q96(*px), true), Instant::now()));
    }
    let r = trader.join().expect("trader thread");
    stop.store(true, Ordering::Relaxed);
    assert!(r.is_ok(), "trader ended with {r:?}");

    let sig = lines(&out.join("signals.jsonl"));
    let trades = lines(&out.join("paper_trades.jsonl"));
    eprintln!("signals: {sig:#?}\ntrades: {trades:#?}");
    let at_rush: Vec<&Value> = sig.iter().filter(|l| l["pool"] == POOL && l["block"] == rush_block).collect();
    // Main result: exactly as before the test existed.
    let main: Vec<&&Value> = at_rush.iter().filter(|l| l.get("group").is_none()).collect();
    assert_eq!(main.len(), 1, "{at_rush:?}");
    assert!(main[0]["why"].as_str().unwrap().starts_with("pool too young"), "{}", main[0]);
    assert_eq!(main[0]["taken"], false);
    // Young test: bought, tagged, with its pool age.
    let young: Vec<&&Value> = at_rush.iter().filter(|l| l["group"] == "young").collect();
    assert_eq!(young.len(), 1, "{at_rush:?}");
    assert_eq!(young[0]["taken"], true, "went through the other filters and the buy path: {}", young[0]);
    let age = young[0]["pool_age_s"].as_f64().expect("pool age recorded");
    assert!(age > 0.0 && age < 1_000_000.0, "{age}");
    // Its trade closed by the normal exit logic, tagged young.
    let rows: Vec<&Value> = trades.iter().filter(|t| t.get("reason").is_some()).collect();
    assert_eq!(rows.len(), 1, "{trades:?}");
    assert_eq!(rows[0]["group"], "young");
    assert!(trades.iter().filter(|t| t.get("ladder_for").is_some()).all(|t| t["group"] == "young"), "size study line tagged too");
    assert!(lines(&out.join("meta.jsonl")).iter().any(|m| m["event"] == "young_test"));

    // Report: no main trade at all, one young trade in its own section.
    let rep = sniper::paper::report(&out);
    eprintln!("{rep}");
    assert!(rep.contains("| trades 0 |"), "main numbers exclude the young trade:\n{rep}");
    assert!(rep.contains("pool too young 1"), "{rep}");
    assert!(rep.contains("YOUNG POOL TEST GROUP"), "{rep}");
    assert!(rep.contains("young-pool rushes 1 | bought 1"), "{rep}");
    assert!(rep.contains("all: 1 trades"), "{rep}");
    let _ = std::fs::remove_dir_all(&dir);
}
