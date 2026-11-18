// ============================================================================
// END-TO-END: feed wake-up (speed step 3) against a REAL `arbsim serve`.
//
// Plain English:
//   Everything is local and fake except the engine itself:
//     - a fake node (tiny HTTP server) holding a pretend "pool" contract:
//         slot0()              returns its stored price word (sqrtPriceX96)
//         any other call       stores word 1 of the call data as the new price
//                              (= a "swap" that moves the price)
//         0xdeadbeef(...)      stores the price, then REVERTS (a failed swap)
//     - a fake feed relay (local websocket) sending Robinhood-style frames
//       every 100 ms; the test can put real signed transactions into the
//       next frame (signed with the live sender's own signer, chain 4663);
//     - the real arbsim binary (sim/ crate, built separately, NOT changed),
//       ARBSIM_SOURCE=feed, its own socket.
//   The sniper's forwarder carries frames to the engine AND to the feed
//   wake-up tap; the wake-up worker finds the transactions that touch the
//   watched pool, asks the engine for the price before and after each, and
//   hands confirmed swaps over. They are then turned into swap records and
//   read with the trader's own functions (price, buyer, sell test) into the
//   trader's own rush Detector, which must fire a rush with the 3 real
//   signers. The reverted transaction must NOT appear.
//
// Needs the arbsim binary, so plain `cargo test` skips it. Run:
//   (cd sim && cargo build --release --bin arbsim)
//   (cd sniper && cargo test --test feedwake_e2e -- --ignored --nocapture)
// ARBSIM_BIN=/path/to/arbsim overrides where the binary is looked for.
// ============================================================================
mod common;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::*;
use serde_json::json;
use sniper::engine::{spawn_forwarder_tap, EngineConfig};
use sniper::feedwake::{self, FeedSwap, Kind, Shared, WatchIndex, WatchPool};
use sniper::live::Signer;
use sniper::paper::{is_sell_swap, swap_buyer, Detector, Rules};

/// Collect confirmed swaps until `n` arrived or time runs out.
fn collect(rx: &std::sync::mpsc::Receiver<FeedSwap>, n: usize, within: Duration) -> Vec<FeedSwap> {
    let until = Instant::now() + within;
    let mut out = Vec::new();
    while out.len() < n && Instant::now() < until {
        if let Ok(s) = rx.recv_timeout(Duration::from_millis(50)) {
            out.push(s);
        }
    }
    out
}

#[test]
#[ignore = "needs the arbsim binary: see the top of this file"]
fn feed_swap_reaches_the_rush_detector() {
    let dir = std::env::temp_dir().join(format!("sniper-feedwake-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let socket = dir.join("engine.sock").to_string_lossy().to_string();
    let node = fake_node();
    let stop = Arc::new(AtomicBool::new(false));
    let outbox: Outbox = Arc::new(Mutex::new(Vec::new()));
    let sent: SentAt = Arc::new(Mutex::new(Vec::new()));
    let relay = fake_relay(stop.clone(), outbox.clone(), sent.clone());

    // The engine exactly as sniper/deploy/sniper-engine.sh starts it.
    let _engine = start_engine(&dir, &socket, &node);

    // Sniper side, settings as the paper trader reads them.
    let env = |k: &str| match k {
        "SNIPER_ENGINE" => Some("1".to_string()),
        "SNIPER_ENGINE_SOCKET" => Some(socket.clone()),
        "SNIPER_RHC_FEED" => Some(relay.clone()),
        "SNIPER_FEED_WAKE" => Some("1".to_string()),
        _ => None,
    };
    let (ecfg, _) = EngineConfig::from_lookup(env);
    let (wcfg, warn) = feedwake::WakeConfig::from_lookup(env, ecfg.on);
    assert!(wcfg.on && warn.is_none());
    let (tap, tap_rx) = std::sync::mpsc::sync_channel(256);
    let fwd = spawn_forwarder_tap(&ecfg, stop.clone(), Some(tap));
    let sh = Shared::new(stop.clone());
    let pool = WatchPool { key: POOL.into(), kind: Kind::V3, token: TOKEN.into(), token_is0: true };
    sh.set_watch(WatchIndex::build([pool.clone()]));
    let rx = feedwake::spawn_worker(sh.clone(), &ecfg.socket, ecfg.timeout, wcfg.wait, tap_rx);

    // Warm up: the engine loads the pool (first answers are "not ready" /
    // "miss" while it fetches code and storage from the fake node).
    let eng = sniper::engine::EngineClient::new(&socket, Duration::from_millis(200), "head");
    let t0 = Instant::now();
    loop {
        if eng.call_at(&json!({"after": "head"}), &[pool.price_call()]).is_ok() {
            break;
        }
        assert!(t0.elapsed() < Duration::from_secs(30), "engine never ready: {} | log: {}", fwd.summary(), std::fs::read_to_string(dir.join("arbsim.log")).unwrap_or_default());
        std::thread::sleep(Duration::from_millis(50));
    }
    eprintln!("engine ready after {:.0} ms", t0.elapsed().as_secs_f64() * 1000.0);
    assert!(sh.healthy(wcfg.stale), "frames arriving: feed healthy");

    // 1) one earlier price move (a sell), well before the rush window.
    let w0 = Signer::random().unwrap();
    outbox.lock().unwrap().push(swap_tx(&w0, q96(0.99), false).raw);
    let first = collect(&rx, 1, Duration::from_secs(5));
    assert_eq!(first.len(), 1, "earlier swap confirmed: {}", sh.summary());
    assert!(first[0].sold, "price down = a sell");
    std::thread::sleep(Duration::from_millis(1500)); // > the 1 s rush window

    // 2) the rush: three buyers lifting the price, and one FAILED swap.
    let (a, b, c, bad) = (Signer::random().unwrap(), Signer::random().unwrap(), Signer::random().unwrap(), Signer::random().unwrap());
    let txs = [swap_tx(&a, q96(1.00), false), swap_tx(&bad, q96(5.0), true), swap_tx(&b, q96(1.01), false), swap_tx(&c, q96(1.02), false)];
    outbox.lock().unwrap().extend(txs.iter().map(|t| t.raw.clone()));
    let got = collect(&rx, 3, Duration::from_secs(5));
    std::thread::sleep(Duration::from_millis(300));
    let extra: Vec<FeedSwap> = rx.try_iter().collect();
    assert_eq!(got.len(), 3, "three real swaps confirmed: {} | {got:?}", sh.summary());
    assert!(extra.is_empty(), "the reverted swap made no record: {extra:?}");
    assert_eq!(got.iter().map(|s| s.tx.clone()).collect::<Vec<_>>(), vec![txs[0].hash.clone(), txs[2].hash.clone(), txs[3].hash.clone()]);
    assert_eq!(got.iter().map(|s| s.txi).collect::<Vec<_>>(), vec![1, 3, 4], "block positions (internal tx = 0)");
    assert!(got.iter().all(|s| !s.sold && s.block == got[0].block && s.block > first[0].block));
    assert!(sh.json()["no_change"].as_u64().unwrap() >= 1, "the failed tx was checked and showed no change");

    // Frame sent -> swap confirmed (real, local).
    let sent_at = sent.lock().unwrap().clone();
    let (_, sent_t) = *sent_at.last().unwrap();
    let ms: Vec<f64> = got.iter().map(|s| (sh.born + Duration::from_millis(s.done_ms)).saturating_duration_since(sent_t).as_secs_f64() * 1000.0).collect();
    eprintln!("frame sent -> confirmed swap (ms): {ms:?} | frame arrived -> confirmed: {:?}", got.iter().map(|s| s.done_ms - s.seen_ms).collect::<Vec<_>>());
    eprintln!("{}", sh.summary());

    // 3) Into the trader's own rush detector, through the same record
    //    reading as polled node logs (price word 2, recipient, sell test).
    let rules = Rules { buys: 3, window_blocks: 10, rise_pct: 2.0 };
    let mut det = Detector::default();
    let mut rush = None;
    for s in first.iter().chain(got.iter()) {
        for log in feedwake::synth_logs(s) {
            let data = log["data"].as_str().unwrap();
            let w = sniper::venue::words(data);
            let price = sniper::rhc_report::token_price(&sniper::fourmeme::word_dec(w[2]), true).unwrap();
            assert_eq!(is_sell_swap(&w, true), s.sold);
            let block = sniper::fourmeme::hex_u64(log.get("blockNumber"));
            if let Some(r) = det.on_swap(POOL, block, &swap_buyer(&log), price, &rules) {
                rush = Some(r);
            }
        }
    }
    let r = rush.expect("the feed swaps make a rush");
    let mut want = vec![a.address().to_string(), b.address().to_string(), c.address().to_string()];
    want.sort();
    assert_eq!(r.buyers, want, "buyers are the real signers; the failed tx's signer is not one");
    eprintln!("rush at block {} with {} buyers, price {:.4} (start {:.4})", r.block, r.buyers.len(), r.price, r.start_price);
    stop.store(true, Ordering::Relaxed);
}
