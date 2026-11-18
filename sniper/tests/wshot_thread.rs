// ============================================================================
// The hot-pool WebSocket thread (wshot.rs) on its own, against the fake
// WebSocket node and the fake HTTP node. Checks the RENEWAL rules:
//   1. the first hot set is subscribed by address; no fill-in at a fresh
//      start (polling covered until then);
//   2. a changed hot set is renewed only after SNIPER_WS_HOT_RENEW_SECS,
//      several changes in that time = ONE renewal;
//   3. renewal is make-before-break: the new subscription is confirmed,
//      then the old one dropped (eth_unsubscribe), on the same connection;
//      a fill-in runs for the renewal window;
//   4. a refused renewal (too many addresses) keeps the old subscription
//      working and is counted;
//   5. logs pushed twice (overlap) are handed over once.
// ============================================================================
mod common;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use serde_json::json;
use sniper::wshot::{HotSet, Shared, Topics, WsHotCfg};

fn set(addrs: &[&str]) -> HotSet {
    let mut h = HotSet::default();
    for a in addrs {
        h.addrs.insert(a.to_string());
    }
    h
}

fn wait_for(what: &str, secs: u64, f: impl Fn() -> bool) {
    let t = Instant::now();
    while !f() {
        assert!(t.elapsed() < Duration::from_secs(secs), "timed out waiting for: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn renewal_is_rate_limited_make_before_break_and_refusals_keep_the_old_one() {
    let node = fake_node();
    let wss = fake_ws();
    TIP.store(5000, Ordering::Relaxed);
    let stop = Arc::new(AtomicBool::new(false));
    let sh = Shared::new(stop.clone(), Instant::now());
    sh.head_hint.store(4990, Ordering::Relaxed);
    let get = |k: &str| match k {
        "SNIPER_WS_HOT" => Some("1".to_string()),
        "SNIPER_WS_HOT_RENEW_SECS" => Some("2".to_string()),
        _ => None,
    };
    let (cfg, _) = WsHotCfg::from_lookup(get, true);
    let topics = Topics { by_addr: vec![sniper::rhc::sig_v3_swap()], v4_swap: None };
    let a = "0x00000000000000000000000000000000000000a1";
    let b = "0x00000000000000000000000000000000000000b2";
    let c = "0x00000000000000000000000000000000000000c3";
    sh.set_wanted(set(&[a]));
    let rx = sniper::wshot::spawn(wss, node, cfg, topics, sh.clone());
    let g = |x: &std::sync::atomic::AtomicU64| x.load(Ordering::Relaxed);

    // 1. subscribed by address, no fill-in at a fresh start.
    wait_for("first subscription", 5, || sh.subscribed.load(Ordering::Relaxed));
    assert_eq!(SUBS_SEEN.lock().unwrap().len(), 1);
    assert_eq!(SUBS_SEEN.lock().unwrap()[0]["address"], json!([a]));
    let t_first = Instant::now();

    // 2. two quick changes: only ONE renewal, not before the 2 s limit.
    sh.set_wanted(set(&[a, b]));
    std::thread::sleep(Duration::from_millis(300));
    sh.set_wanted(set(&[a, b, c]));
    std::thread::sleep(Duration::from_millis(700));
    assert_eq!(g(&sh.c.renewals), 0, "too soon to renew");
    wait_for("the renewal", 5, || sh.live() == set(&[a, b, c]));
    assert!(t_first.elapsed() >= Duration::from_millis(1900), "renewed after the rate limit");
    assert_eq!(g(&sh.c.renewals), 1, "two changes, one renewal");
    assert_eq!(SUBS_SEEN.lock().unwrap().last().unwrap()["address"], json!([a, b, c]));
    // 3. same connection, old subscription dropped, a fill-in for the window.
    assert_eq!(g(&sh.c.sessions), 1, "renewed on the same connection");
    wait_for("old subscription dropped", 3, || UNSUBS.load(Ordering::Relaxed) == 1);
    wait_for("renewal fill-in", 5, || g(&sh.c.fills) == 1);

    // 5. a pushed log arrives once; the same log again is dropped.
    let log = json!({"address": b, "topics": [sniper::rhc::sig_v3_swap()], "data": "0x", "blockNumber": "0x1388", "logIndex": "0x0", "transactionHash": "0x01"});
    PUSH.lock().unwrap().push(log.clone());
    let got = rx.recv_timeout(Duration::from_secs(3)).expect("pushed log");
    assert_eq!(got["_src"], "ws");
    assert!(got["_seen_ms"].as_u64().is_some());
    PUSH.lock().unwrap().push(log);
    wait_for("repeat dropped", 3, || g(&sh.c.dup_dropped) == 1);
    assert!(rx.recv_timeout(Duration::from_millis(300)).is_err(), "repeat not handed over");

    // 4. refused renewal: old subscription (a, b, c) keeps working.
    REFUSE_OVER.store(3, Ordering::Relaxed);
    let d = "0x00000000000000000000000000000000000000d4";
    sh.set_wanted(set(&[a, b, c, d]));
    wait_for("refused renewal counted", 6, || g(&sh.c.renew_errors) == 1);
    assert_eq!(sh.live(), set(&[a, b, c]), "old subscription kept");
    assert!(sh.subscribed.load(Ordering::Relaxed));
    let log2 = json!({"address": c, "topics": [sniper::rhc::sig_v3_swap()], "data": "0x", "blockNumber": "0x1389", "logIndex": "0x0", "transactionHash": "0x02"});
    PUSH.lock().unwrap().push(log2);
    assert_eq!(rx.recv_timeout(Duration::from_secs(3)).expect("old subscription still pushes")["transactionHash"], "0x02");
    assert_eq!(g(&sh.c.sessions), 1, "no reconnect for a refused renewal");
    assert!(g(&sh.c.messages) >= 4, "every pushed message counted");
    stop.store(true, Ordering::Relaxed);
}
