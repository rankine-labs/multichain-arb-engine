// ============================================================================
// FAST LANE WIRING (practice fixes, Oct 27): the bot's REAL candidate table
// message -> the sidecar's table -> the standing-gap scanner's route list.
//
// Plain English:
//   In the first 30-minute practice run the scanner checked ZERO routes.
//   This proves the live wiring end to end with the message the bot really
//   sends with FASTLANE=practice (sim/tests/fixtures/fastlane_bot_table.json,
//   written by the bot's own code in src/test/fastlaneTableWire.test.ts):
//     1. check/entry.rs apply_table takes it (the same call the server makes
//        for every `trig_table`), into the ONE process-wide table,
//     2. the scanner's live route source (TableSource::global, what
//        fastlane/lane.rs uses) turns its 8 rows into 4 routes (two pools of
//        a pair list the same 2 routes), each with its facts
//        and the right route keys (pools + lender),
//     3. a block scan really runs them (sweep), and a partial table update
//        is seen too,
//     4. the predicted copy's "route pools" (check/entry.rs route_keys)
//        are exactly the routes' pools and lender,
//     5. the live failure: when the predicted view lists the routes' pools
//        unsure, every route is skipped ("skippedUnsure", not
//        "routesChecked"), which is what the live counters showed.
// One test function on purpose: the table is process-wide (the second test,
// ZERO-ROUTES FIX below, takes turns with it).
// ============================================================================
mod check_util;

use std::collections::HashSet;

use arbsim::check::entry::{apply_table, clear_table, route_keys};
use arbsim::fastlane::scan::*;
use arbsim::fastlane::types::ViewKind;
use arbsim::state::mem::MemState;
use check_util::*;
use serde_json::{json, Value};

fn bot_message() -> Value {
    let text = std::fs::read_to_string(fixture_path("fastlane_bot_table")).expect("fixture (src/test/fastlaneTableWire.test.ts writes it)");
    serde_json::from_str(&text).expect("json")
}

/// The table is process-wide: tests take turns.
static TURN: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn the_bots_real_table_message_gives_the_scanner_its_routes() {
    let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
    clear_table();
    reset_hour();
    let msg = bot_message();
    let pools: Vec<String> = msg["pools"].as_object().unwrap().keys().cloned().collect();
    let lender = "0x".to_string() + &"cd".repeat(20);

    // 1. The server's call for every trig_table message.
    let ans = apply_table(&json!(1), &msg);
    assert_eq!(ans["ok"], json!(true), "{ans}");
    assert_eq!(ans["pools"], json!(4));

    // 2. The live route source.
    let mut sc = Scanner::new(ScanConfig { sweep_per_block: 64, budget_us: 1_000_000, ..ScanConfig::default() }, Box::new(TableSource::global()), Box::new(PlainRunner));
    let bad = sc.sync_now();
    assert_eq!(bad, 0, "no row refused");
    assert_eq!(sc.routes(), 4, "every route of the bot's table (8 rows, 4 distinct routes)");

    // 3. A block scan runs them (an empty strict copy: every check answers
    // "unknown", but each one RAN; that is what routesChecked counts).
    let view = MemState::default();
    let c = ctx();
    let unsure = HashSet::new();
    let changed = vec![pools[0].clone()];
    let rep = sc.scan(&BlockInput { view: &view, ctx: &c, block: 7, kind: ViewKind::Predicted, changed: &changed, unsure: &unsure, snap: None });
    assert_eq!(rep.checked.len(), 4, "changed-pool routes + sweep cover all 4");
    assert!(rep.checked.iter().all(|r| !matches!(r.outcome, Outcome::NoFacts | Outcome::SkippedUnsure)), "{:?}", rep.checked);
    assert_eq!(rep.checked.iter().filter(|r| r.source == "changed").count(), 2, "the 2 routes through the changed pool first");
    let st = status_json();
    assert_eq!(st["routesChecked"], json!(4));
    assert_eq!(st["routes"], json!(4), "status shows how many routes the scanner holds");

    // 4. The predicted copy's route pools: the 4 pools + the lender.
    let (_, keys) = route_keys().expect("table held");
    let mut want: HashSet<String> = pools.iter().cloned().collect();
    want.insert(lender.clone());
    assert_eq!(keys, want);

    // 5. The live symptom: every route's pool listed unsure in the view
    // (before the fix, one failed transaction naming WETH / USDG did that
    // to every WETH / USDG pool): nothing runs, all "skippedUnsure".
    reset_hour();
    let all_unsure: HashSet<String> = pools.iter().cloned().collect();
    let rep = sc.scan(&BlockInput { view: &view, ctx: &c, block: 8, kind: ViewKind::Predicted, changed: &[], unsure: &all_unsure, snap: None });
    assert!(rep.checked.iter().all(|r| r.outcome == Outcome::SkippedUnsure));
    let st = status_json();
    assert_eq!((st["routesChecked"].as_u64(), st["skippedUnsure"].as_u64()), (Some(0), Some(4)), "{st}");

    // A partial update (one pair's two pools removed) is seen at the next sync.
    let first_pair: Vec<String> = pools.iter().filter(|k| k.ends_with("a000") || k.ends_with("a001")).cloned().collect();
    assert_eq!(first_pair.len(), 2);
    let mut part = json!({"type": "trig_table", "gen": 2, "full": false, "base": 1, "codes": [], "pools": {}});
    for k in &first_pair {
        part["pools"][k] = Value::Null;
    }
    assert_eq!(apply_table(&json!(2), &part)["ok"], json!(true));
    sc.sync_now();
    assert_eq!(sc.routes(), 2, "that pair's 2 routes are gone");
    clear_table();
    sc.sync_now();
    assert_eq!(sc.routes(), 0, "table gone: routes forgotten");
}

// ============================================================================
// ZERO-ROUTES FIX (Oct 27, third practice run: the bot logged "two steps
// (table for the fast lane every 1000 ms)" yet the scanner held 0 routes).
//
// Plain English: the table goes to arbsim on the bot's ONE socket, the same
// one that carries copy 2's pool reports and every check. arbsim refuses
// messages over 8 MB, and before the fix a refused message closed that
// socket WITHOUT A WORD (server.rs dropped the error): the table never
// arrived, the bot reconnected, sent the full table again a second later,
// and so on. A table row is ~2.5 KB, so ~3,300 rows (about 1,800 pools x
// their routes) are enough. Proven here, over a REAL Unix socket with the
// real server loop:
//   1. a 9 MB table message no longer closes the connection: it is dropped,
//      counted (status "socket.tooLarge"), and the next question on the
//      same connection is answered;
//   2. the bot's table in PARTS (sim/tests/fixtures/fastlane_bot_table_parts.json,
//      written by src/test/fastlaneTableWire.test.ts with the live settings
//      TRIG_ENTRY_ONE_TRIP=0 + FASTLANE=practice and a small part limit)
//      arrives whole: status "trigTable" shows every row usable, and the
//      scanner's live route source holds every route.
// ============================================================================
#[test]
fn an_oversize_message_no_longer_closes_the_socket_and_a_table_in_parts_arrives_whole() {
    let _turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
    clear_table();
    let ctx = arbsim::serve::build(arbsim::state::mirror::Config::for_tests(), None);
    let path = std::env::temp_dir().join(format!("arbsim-test-zero-routes-{}.sock", std::process::id())).to_string_lossy().to_string();
    let listener = arbsim::server::bind(&path).unwrap();
    let c2 = ctx.clone();
    std::thread::spawn(move || arbsim::server::run(c2, listener));
    let mut s = std::os::unix::net::UnixStream::connect(&path).unwrap();
    s.set_read_timeout(Some(std::time::Duration::from_secs(20))).unwrap();
    let mut ask = |v: Value| -> Value {
        arbsim::proto::write_msg(&mut s, &serde_json::to_vec(&v).unwrap()).unwrap();
        serde_json::from_slice(&arbsim::proto::read_msg(&mut s).expect("answer (connection still open)").expect("not closed")).unwrap()
    };
    // 1. The live failure: one table message over 8 MB.
    let pad = "a".repeat(9 * 1024 * 1024);
    let big = json!({"id": 1, "type": "trig_table", "gen": 1, "full": true, "codes": [], "pools": {"0x00000000000000000000000000000000000000a0": [{"rid": "x", "pad": pad}]}});
    {
        let mut w = std::os::unix::net::UnixStream::connect(&path).unwrap();
        // (on its own connection too: written in full, then that connection is used again)
        arbsim::proto::write_msg(&mut w, &serde_json::to_vec(&big).unwrap()).unwrap();
        w.set_read_timeout(Some(std::time::Duration::from_secs(20))).unwrap();
        arbsim::proto::write_msg(&mut w, &serde_json::to_vec(&json!({"id": 2, "type": "status"})).unwrap()).unwrap();
        let st: Value = serde_json::from_slice(&arbsim::proto::read_msg(&mut w).expect("the connection that sent 9 MB still answers").expect("open")).unwrap();
        assert_eq!(st["socket"]["tooLarge"], json!(1), "{}", st["socket"]);
        assert!(st["socket"]["tooLargeLastBytes"].as_u64().unwrap() > 9 * 1024 * 1024);
        assert_eq!(st["trigTable"]["held"], json!(false), "the over-size table was dropped, not half-read");
    }
    // 2. The bot's table in parts (live settings), on the bot's connection.
    let text = std::fs::read_to_string(fixture_path("fastlane_bot_table_parts")).expect("fixture (src/test/fastlaneTableWire.test.ts writes it)");
    let parts: Vec<Value> = serde_json::from_str(&text).unwrap();
    assert!(parts.len() > 1, "the fixture is a split table");
    let mut want_rids = HashSet::new();
    let mut rows = 0;
    for (i, p) in parts.iter().enumerate() {
        let mut m = p.clone();
        m["id"] = json!(10 + i);
        let a = ask(m);
        assert_eq!(a["ok"], json!(true), "part {i}: {a}");
        for r in p["pools"].as_object().unwrap().values().flat_map(|v| v.as_array().unwrap().clone()) {
            want_rids.insert(r["rid"].as_str().unwrap().to_string());
            rows += 1;
        }
    }
    let st = ask(json!({"id": 99, "type": "status"}));
    let t = &st["trigTable"];
    assert_eq!((t["held"].clone(), t["rows"].clone(), t["usableRows"].clone(), t["factRows"].clone()), (json!(true), json!(rows), json!(rows), json!(rows)), "{t}");
    assert_eq!((t["full"].clone(), t["partial"].clone(), t["refused"].clone()), (json!(1), json!(parts.len() - 1), json!(0)), "{t}");
    // The scanner's live route source (what fastlane/lane.rs uses).
    let mut sc = Scanner::new(ScanConfig::default(), Box::new(TableSource::global()), Box::new(PlainRunner));
    assert_eq!(sc.sync_now(), 0, "no row refused");
    assert_eq!(sc.routes(), want_rids.len(), "every route of every part");
    clear_table();
    let _ = std::fs::remove_file(&path);
}
