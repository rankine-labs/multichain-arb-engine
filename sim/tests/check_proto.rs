// ============================================================================
// Socket message tests (workstream C): JSON "call" / "size_search" requests
// in, JSON answers out, in the shapes of DESIGN.md "Socket protocol".
// ============================================================================
mod check_util;

use arbsim::check::fixture::Fixture;
use arbsim::check::proto_types::{handle_call, handle_size_search, CallRequest, SizeSearchRequest};
use check_util::*;
use revm::primitives::U256;
use serde_json::json;

fn hexs(b: &[u8]) -> String {
    format!("0x{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())
}

#[test]
fn call_request_matches_fixture_answer() {
    let f = Fixture::load(&fixture_path("offline-v3-v3-small")).unwrap();
    let t = &f.raw["tx"];
    let req: CallRequest = serde_json::from_value(json!({
        "id": 3, "type": "call", "at": {"after": "head"},
        "calls": [{ "from": t["from"], "to": t["to"], "data": t["data"], "gas": t["gas"], "value": "0x0" }],
    }))
    .unwrap();
    let a = handle_call(&f.state, &f.ctx, &req);
    assert_eq!(a["id"], 3);
    assert_eq!(a["ok"], true);
    assert_eq!(a["results"][0]["success"], false);
    assert_eq!(a["results"][0]["output"], f.raw["expected"]["output"]);
    assert_eq!(a["results"][0]["gasUsed"], f.raw["expected"]["gasUsed"]);
    assert_eq!(a["at"]["after"], "head");
    assert!(a["us"].as_u64().is_some());
}

#[test]
fn missing_slot_answer_shape() {
    let mut s = state_with(&[(addr(0xc0de), code_sload_arg(), vec![])], true);
    add_eoa(&mut s, addr(0xabc), U256::ZERO);
    let req: CallRequest = serde_json::from_value(json!({
        "id": "x7", "calls": [{ "from": format!("{:?}", addr(0xabc)), "to": format!("{:?}", addr(0xc0de)), "data": hexs(&word(U256::from(9))) }],
    }))
    .unwrap();
    let a = handle_call(&s, &ctx(), &req);
    assert_eq!(a["ok"], false);
    assert_eq!(a["unknown"], "miss");
    assert_eq!(a["missing"][0]["account"], format!("{:?}", addr(0xc0de)));
    assert_eq!(a["missing"][0]["slot"], format!("{:#066x}", 9));
}

#[test]
fn bad_request_is_unknown_not_a_crash() {
    let s = state_with(&[], false);
    for bad in [
        json!({ "id": 1, "calls": [{ "to": "0x12" }] }),
        json!({ "id": 1, "calls": [{ "to": format!("{:?}", addr(1)), "data": "0xabc" }] }),
        json!({ "id": 1, "calls": [] }),
        json!({ "id": 1, "calls": [{ "to": format!("{:?}", addr(1)) }], "overrides": { format!("{:?}", addr(1)): { "foo": 1 } } }),
    ] {
        let req: CallRequest = serde_json::from_value(bad).unwrap();
        let a = handle_call(&s, &ctx(), &req);
        assert_eq!(a["ok"], false);
        assert_eq!(a["unknown"], "bad_request", "{a}");
    }
}

#[test]
fn size_search_request() {
    let (k, scale) = (U256::from(1000u64), U256::from(1u64));
    let s = state_with(&[(addr(0xc0ffee), code_profit_curve(k, scale, None), vec![])], false);
    let mut data = vec![0x12, 0x34, 0x56, 0x78];
    data.extend([0u8; 32]);
    let req: SizeSearchRequest = serde_json::from_value(json!({
        "id": 4, "type": "size_search", "at": {"after": "head"},
        "template": { "from": format!("{:?}", addr(0xabc)), "to": format!("{:?}", addr(0xc0ffee)), "gas": "0xf4240", "data": hexs(&data) },
        "amountOffset": 0, "amounts": ["0x64", "0x1f4", "0x384"],
    }))
    .unwrap();
    let a = handle_size_search(&s, &ctx(), &req);
    assert_eq!(a["ok"], true, "{a}");
    assert_eq!(a["best"]["amount"], "0x1f4");
    assert_eq!(a["best"]["profit"], format!("{:#x}", 250_000));
    assert_eq!(a["tried"].as_array().unwrap().len(), 3);

    let req2: SizeSearchRequest = serde_json::from_value(json!({
        "id": 5, "template": { "to": format!("{:?}", addr(0xc0ffee)), "data": hexs(&data) },
        "amountOffset": 0, "range": { "lo": "0x1", "hi": "0x3e7", "steps": 12 },
    }))
    .unwrap();
    let a2 = handle_size_search(&s, &ctx(), &req2);
    assert_eq!(a2["ok"], true);
    assert!(a2["tried"].as_array().unwrap().len() <= 12);
}

// blockOverrides.time changes TIMESTAMP; unknown fields are refused;
// nextBlock bumps ArbSys's block number.
#[test]
fn block_overrides_and_next_block() {
    use arbsim::check::proto_types::apply_block_overrides;
    let mut c = ctx();
    c.l2_block_number = Some(50);
    let n = apply_block_overrides(&c, &json!({"time": "0x10", "gasLimit": "0x77359400"}), true).unwrap();
    assert_eq!((n.timestamp, n.gas_limit, n.l2_block_number), (16, 2_000_000_000, Some(51)));
    assert!(apply_block_overrides(&c, &json!({"baseFee": "0x1"}), false).is_err());
    assert_eq!(apply_block_overrides(&c, &json!({"number": "0x99"}), true).unwrap().l2_block_number, Some(0x99));
    assert_eq!(apply_block_overrides(&ctx(), &json!({"number": "0x99"}), false).unwrap().l1_block_number, 0x99);
    // TIMESTAMP opcode really sees it: contract returning TIMESTAMP.
    let s = state_with(&[(addr(0x7173), hex("42600052 6020 6000 f3"), vec![])], false);
    let req: CallRequest = serde_json::from_value(json!({
        "id": 1, "blockOverrides": {"time": "0x1234"},
        "calls": [{ "to": format!("{:?}", addr(0x7173)) }],
    })).unwrap();
    let a = handle_call(&s, &ctx(), &req);
    assert_eq!(a["results"][0]["output"], format!("0x{:064x}", 0x1234));
}
