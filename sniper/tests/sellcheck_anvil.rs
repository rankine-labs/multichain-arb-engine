// ============================================================================
// Sell check against a REAL local EVM (anvil, from Foundry).
//
// Deploys the test-only mocks (tests/fixtures/Mocks.sol): a Four.meme-like
// manager and three tokens (normal, 5% buy tax, sells blocked), then runs the
// production sell check on each through eth_simulateV1, exactly as it would
// run against a BSC node. Expected: PASS, REJECT (tax), REJECT (can't sell).
//
// Needs the `anvil` binary: on PATH or in ANVIL_BIN. Skips (with a message)
// if not found, so `cargo test` still works on machines without Foundry.
// ============================================================================
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use ruint::aliases::U256;
use serde_json::{json, Value};
use sniper::sellcheck::{run_check, verdict, Limits, Request, Rpc, Verdict};

struct Anvil(Child);
impl Drop for Anvil {
    fn drop(&mut self) {
        let _ = self.0.kill();
    }
}

fn anvil_bin() -> Option<String> {
    if let Ok(p) = std::env::var("ANVIL_BIN") {
        return Some(p);
    }
    Command::new("anvil").arg("--version").stdout(Stdio::null()).status().ok().filter(|s| s.success()).map(|_| "anvil".into())
}

fn e18(x: u64) -> U256 {
    U256::from(x) * U256::from(10u64).pow(U256::from(18))
}

fn word(x: U256) -> String {
    format!("{x:064x}")
}

fn addr_word(a: &str) -> String {
    format!("{:0>64}", a.trim_start_matches("0x"))
}

/// Wait for a transaction's receipt (anvil mines each tx right away, but the
/// receipt can take a moment to appear).
fn receipt(rpc: &Rpc, h: &Value) -> Value {
    let t0 = Instant::now();
    loop {
        let rc = rpc.call("eth_getTransactionReceipt", json!([h])).unwrap();
        if !rc.is_null() {
            return rc;
        }
        assert!(t0.elapsed() < Duration::from_secs(10), "no receipt for {h}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn deploy(rpc: &Rpc, from: &str, code: String) -> String {
    let h = rpc.call("eth_sendTransaction", json!([{"from": from, "data": code, "gas": "0x989680"}])).unwrap();
    let rc = receipt(rpc, &h);
    assert_eq!(rc["status"], "0x1", "deploy failed: {rc}");
    rc["contractAddress"].as_str().unwrap().to_string()
}

fn send(rpc: &Rpc, from: &str, to: &str, data: String) {
    let h = rpc.call("eth_sendTransaction", json!([{"from": from, "to": to, "data": data, "gas": "0x989680"}])).unwrap();
    let rc = receipt(rpc, &h);
    assert_eq!(rc["status"], "0x1", "tx failed: {rc}");
}

#[test]
fn sell_check_passes_good_token_and_rejects_taxed_and_unsellable() {
    let Some(bin) = anvil_bin() else {
        eprintln!("SKIPPED: anvil not found (install Foundry or set ANVIL_BIN)");
        return;
    };
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let _node = Anvil(
        Command::new(bin)
            .args(["--port", &port.to_string(), "--silent"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start anvil"),
    );
    let rpc = Rpc::new(&format!("http://127.0.0.1:{port}"));
    let t0 = Instant::now();
    while rpc.call("eth_blockNumber", json!([])).is_err() {
        assert!(t0.elapsed() < Duration::from_secs(15), "anvil did not start");
        std::thread::sleep(Duration::from_millis(100));
    }

    let mocks: Value = serde_json::from_str(include_str!("fixtures/mocks.json")).unwrap();
    let deployer = rpc.call("eth_accounts", json!([])).unwrap()[0].as_str().unwrap().to_string();
    let manager = deploy(&rpc, &deployer, mocks["MockTokenManager"]["bytecode"].as_str().unwrap().to_string());

    let token_code = mocks["MockToken"]["bytecode"].as_str().unwrap();
    let make = |tax_bps: u64, blocked: bool| {
        let args = format!("{}{}{}{}", addr_word(&manager), word(e18(1_000_000_000)), word(U256::from(tax_bps)), word(U256::from(blocked as u64)));
        let t = deploy(&rpc, &deployer, format!("{token_code}{args}"));
        // list(address,uint256): 800M tokens for sale on the curve
        let sel = &sniper::fourmeme::hex(&sniper::fourmeme::keccak(b"list(address,uint256)")[..4]);
        send(&rpc, &deployer, &manager, format!("0x{sel}{}{}", addr_word(&t), word(e18(800_000_000))));
        t
    };
    let normal = make(0, false);
    let taxed = make(500, false);
    let blocked = make(0, true);

    // A fresh wallet with NO balance: the check gives it a pretend balance.
    let wallet = "0x00000000000000000000000000000000c0ffee01".to_string();
    let funds = e18(1) / U256::from(2); // 0.5 BNB
    let lim = Limits::default();
    let check = |token: &str| {
        let req = Request { manager: manager.clone(), token: token.to_string(), wallet: wallet.clone(), funds, block: "latest".into() };
        run_check(&rpc, &req).expect("check should complete")
    };

    let r = check(&normal);
    eprintln!("normal: {r:?}");
    assert!(r.buy_ok && r.sell_ok, "{r:?}");
    assert_eq!(r.tokens_event, r.tokens_received);
    let loss = r.round_trip_loss_bps(funds).unwrap();
    assert!((180..=220).contains(&loss), "expected ~2% (two 1% fees), got {loss} bps");
    assert_eq!(verdict(&r, funds, &lim), Verdict::Pass);

    let r = check(&taxed);
    eprintln!("taxed: {r:?}");
    assert_eq!(r.buy_tax_bps(), Some(500));
    assert!(matches!(verdict(&r, funds, &lim), Verdict::Reject(w) if w.iter().any(|x| x.contains("buy tax"))));

    let r = check(&blocked);
    eprintln!("blocked: {r:?}");
    assert!(r.buy_ok && !r.sell_ok);
    assert!(matches!(verdict(&r, funds, &lim), Verdict::Reject(w) if w.iter().any(|x| x.contains("sell fails"))));

    // Nothing was actually spent: the real wallet still has zero balance.
    let bal = rpc.call("eth_getBalance", json!([wallet, "latest"])).unwrap();
    assert_eq!(bal, "0x0");
}
