// ============================================================================
// SELL CHECK: "if we buy this token now, can we actually sell it, and what
// would we really get back?" Asked of the real chain, before every buy.
//
// Plain English:
//   We ask the node to SIMULATE our own wallet doing the trade, on the
//   current chain state. Nothing is signed or sent; nothing is spent.
//   (eth_simulateV1: runs several calls in a row, each seeing the previous
//   one's effects; we give our wallet a pretend balance for the test.)
//
//     step 1: buy with the planned amount, then read our token balance
//             -> did the buy work? did we receive what the trade event says?
//                (less = a transfer tax)
//     step 2: buy, approve, then sell EVERYTHING we received
//             -> did the sell work? how much BNB comes back after fees?
//
//   Verdict: PASS only if both work, no hidden tax, and the immediate
//   round-trip loss (fees and any hidden cost) is within the limit.
//   Anything that fails, errors or can't be read is a REJECT: per the
//   project rules, no check = no entry.
//
//   This proves sellability on the CURRENT state only. It cannot promise
//   the token stays sellable (a creator could still change things later);
//   the registry's risk flags cover what we can watch for after entry.
//
// Test harness: tests/sellcheck_anvil.rs runs this against a local chain
// with mock "normal", "taxed" and "unsellable" tokens.
// ============================================================================
use std::time::{Duration, Instant};

use ruint::aliases::U256;
use serde_json::{json, Value};

use crate::fourmeme::{decode_log, keccak, Kind, Topics};

/// Minimal JSON-RPC over HTTPS client (blocking, kept-alive, like arbsim's).
pub struct Rpc {
    url: String,
    agent: ureq::Agent,
}

impl Rpc {
    pub fn new(url: &str) -> Self {
        let agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(10))).build().new_agent();
        Rpc { url: url.to_string(), agent }
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
        let mut resp = self.agent.post(&self.url).send_json(&body).map_err(|e| format!("{method}: {e}"))?;
        let v: Value = resp.body_mut().read_json().map_err(|e| format!("{method}: bad reply: {e}"))?;
        if let Some(err) = v.get("error") {
            return Err(format!("{method}: node error: {err}"));
        }
        Ok(v["result"].clone())
    }
}

// ---- ABI encoding (just what we need) ----

fn selector(sig: &str) -> String {
    crate::fourmeme::hex(&keccak(sig.as_bytes())[..4])
}
fn word_addr(a: &str) -> String {
    format!("{:0>64}", a.trim_start_matches("0x").to_ascii_lowercase())
}
fn word_u(x: U256) -> String {
    format!("{x:064x}")
}
fn hex_u(x: U256) -> String {
    format!("0x{x:x}")
}

pub fn data_buy(token: &str, funds: U256) -> String {
    format!("0x{}{}{}{}", selector("buyTokenAMAP(address,uint256,uint256)"), word_addr(token), word_u(funds), word_u(U256::ZERO))
}
pub fn data_sell(token: &str, amount: U256) -> String {
    format!("0x{}{}{}", selector("sellToken(address,uint256)"), word_addr(token), word_u(amount))
}
pub fn data_balance(owner: &str) -> String {
    format!("0x{}{}", selector("balanceOf(address)"), word_addr(owner))
}
pub fn data_approve(spender: &str) -> String {
    format!("0x{}{}{}", selector("approve(address,uint256)"), word_addr(spender), word_u(U256::MAX))
}

/// What to check.
#[derive(Clone, Debug)]
pub struct Request {
    /// TokenManager contract (Four.meme TokenManager2 in production).
    pub manager: String,
    pub token: String,
    /// OUR trading wallet address (simulated as the sender).
    pub wallet: String,
    /// Planned buy size, fee included (quote smallest units).
    pub funds: U256,
    /// Block to simulate on ("latest" normally).
    pub block: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct CheckResult {
    pub block: Option<u64>,
    pub buy_ok: bool,
    pub buy_error: Option<String>,
    /// Tokens the TokenPurchase event says we bought.
    pub tokens_event: Option<U256>,
    /// Tokens that actually landed in our wallet.
    pub tokens_received: Option<U256>,
    pub sell_ok: bool,
    pub sell_error: Option<String>,
    /// Quote paid out (TokenSale cost) and fee, and what we keep.
    pub sell_gross: Option<U256>,
    pub sell_fee: Option<U256>,
    pub sell_net: Option<U256>,
    pub gas_buy: Option<u64>,
    pub gas_sell: Option<u64>,
    /// Time the node took to answer both steps.
    pub latency_ms: f64,
}

/// part / whole in basis points, rounded UP (never understate a cost).
fn ceil_bps(part: U256, whole: U256) -> u64 {
    let n = part * U256::from(10_000u64);
    let (q, r) = n.div_rem(whole);
    (if r.is_zero() { q } else { q + U256::from(1) }).to::<u64>()
}

impl CheckResult {
    /// Transfer tax on the buy, in basis points (0 = none).
    pub fn buy_tax_bps(&self) -> Option<u64> {
        let (ev, got) = (self.tokens_event?, self.tokens_received?);
        if ev.is_zero() {
            return None;
        }
        let lost = ev.saturating_sub(got);
        Some(ceil_bps(lost, ev))
    }

    /// Immediate buy-then-sell loss in basis points of what we put in.
    pub fn round_trip_loss_bps(&self, funds: U256) -> Option<u64> {
        let net = self.sell_net?;
        if funds.is_zero() {
            return None;
        }
        Some(ceil_bps(funds.saturating_sub(net), funds))
    }
}

#[derive(Clone, Debug)]
pub struct Limits {
    pub max_buy_tax_bps: u64,
    /// Fees (~1% each way on Four.meme, to be confirmed by curve-check) and any
    /// hidden cost. On a pure curve an IMMEDIATE buy+sell gets its price
    /// impact back, so position size risk is handled by the sizing engine,
    /// not here.
    pub max_round_trip_loss_bps: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { max_buy_tax_bps: 0, max_round_trip_loss_bps: 500 }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    Pass,
    Reject(Vec<String>),
}

pub fn verdict(r: &CheckResult, funds: U256, lim: &Limits) -> Verdict {
    let mut why = Vec::new();
    if !r.buy_ok {
        why.push(format!("buy fails: {}", r.buy_error.clone().unwrap_or_default()));
    } else {
        match r.buy_tax_bps() {
            None => why.push("could not confirm tokens received".into()),
            Some(t) if t > lim.max_buy_tax_bps => why.push(format!("buy tax {t} bps")),
            _ => {}
        }
        if !r.sell_ok {
            why.push(format!("sell fails: {}", r.sell_error.clone().unwrap_or_default()));
        } else {
            match r.round_trip_loss_bps(funds) {
                None => why.push("could not read sell proceeds".into()),
                Some(l) if l > lim.max_round_trip_loss_bps => why.push(format!("round trip loses {l} bps")),
                _ => {}
            }
        }
    }
    if why.is_empty() {
        Verdict::Pass
    } else {
        Verdict::Reject(why)
    }
}

fn call_obj(from: &str, to: &str, value: U256, data: String) -> Value {
    json!({"from": from, "to": to, "value": hex_u(value), "data": data})
}

fn gas(c: &Value) -> Option<u64> {
    c["gasUsed"].as_str().and_then(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16).ok())
}

fn ok(c: &Value) -> bool {
    c["status"].as_str() == Some("0x1")
}

fn err_text(c: &Value) -> String {
    c["error"]["message"].as_str().map(str::to_string).unwrap_or_else(|| "reverted".into())
}

/// Find our Four.meme event of `kind` among a call's logs.
fn find_event(topics: &Topics, manager: &str, c: &Value, kind: Kind) -> Option<Value> {
    c["logs"].as_array()?.iter().find_map(|l| {
        if !l["address"].as_str()?.eq_ignore_ascii_case(manager) {
            return None;
        }
        let (k, rec) = decode_log(topics, l)?;
        (k == kind).then_some(rec)
    })
}

fn rec_u(rec: &Value, k: &str) -> Option<U256> {
    rec[k].as_str()?.parse().ok()
}

/// Run both simulation steps. Errors = could not complete (treat as reject).
pub fn run_check(rpc: &Rpc, req: &Request) -> Result<CheckResult, String> {
    let topics = Topics::new();
    let started = Instant::now();
    // Pretend balance: the buy plus 1 BNB for gas.
    let balance = req.funds + U256::from(10u64).pow(U256::from(18));
    let overrides = json!({ req.wallet.clone(): {"balance": hex_u(balance)} });
    let simulate = |calls: Vec<Value>| -> Result<Value, String> {
        let res = rpc.call(
            "eth_simulateV1",
            json!([{"blockStateCalls": [{"stateOverrides": overrides, "calls": calls}], "validation": false}, req.block]),
        )?;
        res.as_array().and_then(|a| a.first()).cloned().ok_or_else(|| "eth_simulateV1: empty result".to_string())
    };
    let buy = call_obj(&req.wallet, &req.manager, req.funds, data_buy(&req.token, req.funds));

    // ---- step 1: buy + read balance ----
    let b1 = simulate(vec![buy.clone(), call_obj(&req.wallet, &req.token, U256::ZERO, data_balance(&req.wallet))])?;
    let calls1 = b1["calls"].as_array().ok_or("step 1: no calls in result")?;
    let mut r = CheckResult {
        block: b1["number"].as_str().and_then(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16).ok()),
        ..Default::default()
    };
    let c_buy = calls1.first().ok_or("step 1: missing buy result")?;
    r.buy_ok = ok(c_buy);
    r.gas_buy = gas(c_buy);
    if !r.buy_ok {
        r.buy_error = Some(err_text(c_buy));
        r.latency_ms = started.elapsed().as_secs_f64() * 1e3;
        return Ok(r);
    }
    r.tokens_event = find_event(&topics, &req.manager, c_buy, Kind::Buy).and_then(|e| rec_u(&e, "amount"));
    r.tokens_received = calls1
        .get(1)
        .filter(|c| ok(c))
        .and_then(|c| c["returnData"].as_str())
        .and_then(|h| U256::from_str_radix(h.trim_start_matches("0x"), 16).ok());
    let Some(received) = r.tokens_received.filter(|x| !x.is_zero()) else {
        r.latency_ms = started.elapsed().as_secs_f64() * 1e3;
        return Ok(r);
    };

    // ---- step 2: buy + approve + sell everything received ----
    let b2 = simulate(vec![
        buy,
        call_obj(&req.wallet, &req.token, U256::ZERO, data_approve(&req.manager)),
        call_obj(&req.wallet, &req.manager, U256::ZERO, data_sell(&req.token, received)),
    ])?;
    let calls2 = b2["calls"].as_array().ok_or("step 2: no calls in result")?;
    let c_sell = calls2.get(2).ok_or("step 2: missing sell result")?;
    r.sell_ok = ok(c_sell);
    r.gas_sell = gas(c_sell);
    if r.sell_ok {
        if let Some(ev) = find_event(&topics, &req.manager, c_sell, Kind::Sell) {
            r.sell_gross = rec_u(&ev, "cost");
            r.sell_fee = rec_u(&ev, "fee");
            r.sell_net = match (r.sell_gross, r.sell_fee) {
                (Some(g), Some(f)) => g.checked_sub(f),
                _ => None,
            };
        }
    } else {
        r.sell_error = Some(err_text(c_sell));
    }
    r.latency_ms = started.elapsed().as_secs_f64() * 1e3;
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selectors_match_known_values() {
        // Standard ERC20 selectors (well known).
        assert_eq!(selector("balanceOf(address)"), "70a08231");
        assert_eq!(selector("approve(address,uint256)"), "095ea7b3");
        let d = data_sell("0x00000000000000000000000000000000000000aa", U256::from(5));
        assert_eq!(d.len(), 2 + 8 + 64 * 2);
        assert!(d.ends_with(&format!("{:064x}", 5)));
    }

    fn passing() -> CheckResult {
        CheckResult {
            buy_ok: true,
            tokens_event: Some(U256::from(1_000u64)),
            tokens_received: Some(U256::from(1_000u64)),
            sell_ok: true,
            sell_net: Some(U256::from(9_700u64)),
            ..Default::default()
        }
    }

    #[test]
    fn verdict_pass_and_each_reject_reason() {
        let funds = U256::from(10_000u64);
        let lim = Limits::default();
        assert_eq!(verdict(&passing(), funds, &lim), Verdict::Pass);

        let mut taxed = passing();
        taxed.tokens_received = Some(U256::from(950u64));
        assert!(matches!(verdict(&taxed, funds, &lim), Verdict::Reject(w) if w[0].contains("buy tax 500")));

        let mut stuck = passing();
        stuck.sell_ok = false;
        stuck.sell_error = Some("sell blocked".into());
        assert!(matches!(verdict(&stuck, funds, &lim), Verdict::Reject(w) if w[0].contains("sell fails")));

        let mut lossy = passing();
        lossy.sell_net = Some(U256::from(9_000u64));
        assert!(matches!(verdict(&lossy, funds, &lim), Verdict::Reject(w) if w[0].contains("1000 bps")));

        let no_buy = CheckResult { buy_error: Some("x".into()), ..Default::default() };
        assert!(matches!(verdict(&no_buy, funds, &lim), Verdict::Reject(_)));

        let mut unreadable = passing();
        unreadable.sell_net = None;
        assert!(matches!(verdict(&unreadable, funds, &lim), Verdict::Reject(w) if w[0].contains("proceeds")));
    }
}
