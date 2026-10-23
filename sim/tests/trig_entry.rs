// ============================================================================
// TRIGGER-ENTRY ONE TRIP: candidate picking (check/entry.rs select) against
// the fixture the bot's tests also use (src/test/trigSpeed.test.ts), so the
// sidecar picks exactly the candidates the bot would.
// ============================================================================
use arbsim::check::entry::{parse_rows, select, Table};
use serde_json::Value;

#[test]
fn picking_matches_the_shared_fixture() {
    let fx: Value = serde_json::from_str(include_str!("fixtures/trig_entry_select.json")).unwrap();
    let cases = fx["cases"].as_array().unwrap();
    assert!(cases.len() >= 5);
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let mut t = Table::default();
        for (k, rows) in c["table"].as_object().unwrap() {
            t.pools.insert(k.to_ascii_lowercase(), parse_rows(rows).unwrap());
        }
        let moved: Vec<String> = c["moved"].as_array().unwrap().iter().map(|m| m.as_str().unwrap().to_string()).collect();
        let (picked, found) = select(&t, &moved, c["limit"].as_u64().unwrap() as usize);
        let got: Vec<String> = picked.iter().map(|r| r.e.clone().unwrap()).collect();
        let want: Vec<String> = c["expect"].as_array().unwrap().iter().map(|e| e.as_str().unwrap().to_string()).collect();
        assert_eq!(got, want, "{name}");
        assert_eq!(found as u64, c["found"].as_u64().unwrap(), "{name}: found");
    }
}
