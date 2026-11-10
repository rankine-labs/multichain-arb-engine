// ============================================================================
// CALIBRATE: fit and verify the curve formula against REAL trades.
//
// Plain English:
//   Every TokenPurchase/TokenSale event tells us the trade (tokens, quote
//   cost, fee) AND where the token sits on its curve right after it
//   (`offers`, `funds`). From that we can:
//     1. check what offers/funds mean (do they move by exactly the trade?)
//     2. solve for the two hidden virtual-reserve numbers of the curve
//     3. replay every trade with our own integer maths and measure the error
//     4. measure the fee rate and minimum fee
//   Output: a plain verdict plus curve_fit.json with the fitted numbers.
//   The bot only uses local quotes once step 3 shows near-zero error.
//
// Fit maths (per trade, d_o / d_f = change in offers / funds):
//   (o_pre + A)(f_pre + B) = (o_post + A)(f_post + B)
//   =>  -A*d_f - B*d_o = o_post*d_f + f_post*d_o - d_o*d_f
//   one linear equation per trade in the unknowns A, B -> least squares.
// ============================================================================
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use ruint::aliases::U256;
use serde_json::{json, Value};

use crate::curve::{Curve, State};
use crate::report::pct;

/// One trade with exact integers.
#[derive(Clone, Debug)]
pub struct Trade {
    pub token: String,
    pub buy: bool,
    pub block: u64,
    pub log_index: u64,
    pub amount: U256,
    pub cost: U256,
    pub fee: U256,
    pub offers: U256,
    pub funds: U256,
}

fn u(v: &Value) -> Option<U256> {
    v.as_str()?.parse::<U256>().ok()
}

pub fn load(dir: &Path) -> Vec<Trade> {
    let mut v: Vec<Trade> = fs::read_to_string(dir.join("trades.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|t| t["removed"] != json!(true))
        .filter_map(|t| {
            Some(Trade {
                token: t["token"].as_str()?.to_string(),
                buy: t["kind"] == "buy",
                block: t["block"].as_u64()?,
                log_index: t["log_index"].as_u64()?,
                amount: u(&t["amount"])?,
                cost: u(&t["cost"])?,
                fee: u(&t["fee"])?,
                offers: u(&t["offers"])?,
                funds: u(&t["funds"])?,
            })
        })
        .collect();
    v.sort_by_key(|t| (t.block, t.log_index));
    v
}

fn f(x: U256) -> f64 {
    f64::from(x)
}

/// State just before the trade, assuming offers/funds move by exactly the
/// trade's amount/cost (step 1 checks this assumption).
pub fn pre_state(t: &Trade) -> Option<State> {
    if t.buy {
        Some(State { offers: t.offers + t.amount, funds: t.funds.checked_sub(t.cost)? })
    } else {
        Some(State { offers: t.offers.checked_sub(t.amount)?, funds: t.funds + t.cost })
    }
}

/// Least-squares fit of (A, B) over a set of trades. Columns are scaled
/// (A in 1e27, B in 1e18 units) and rows normalised so big and small trades
/// count equally.
pub fn fit(trades: &[&Trade]) -> Option<(f64, f64)> {
    const SA: f64 = 1e27;
    const SB: f64 = 1e18;
    let (mut s11, mut s12, mut s22, mut r1, mut r2) = (0.0, 0.0, 0.0, 0.0, 0.0);
    let mut n = 0;
    for t in trades {
        let (o, fu, a, c) = (f(t.offers), f(t.funds), f(t.amount), f(t.cost));
        if a <= 0.0 || c <= 0.0 {
            continue;
        }
        let (d_o, d_f) = if t.buy { (-a, c) } else { (a, -c) };
        let rhs = o * d_f + fu * d_o - d_o * d_f;
        let (x1, x2) = (-d_f * SA, -d_o * SB);
        let norm = (x1 * x1 + x2 * x2).sqrt();
        if norm == 0.0 {
            continue;
        }
        let (x1, x2, y) = (x1 / norm, x2 / norm, rhs / norm);
        s11 += x1 * x1;
        s12 += x1 * x2;
        s22 += x2 * x2;
        r1 += x1 * y;
        r2 += x2 * y;
        n += 1;
    }
    let det = s11 * s22 - s12 * s12;
    if n < 2 || det.abs() < 1e-12 {
        return None;
    }
    let a = (r1 * s22 - r2 * s12) / det;
    let b = (s11 * r2 - s12 * r1) / det;
    Some((a * SA, b * SB))
}

fn to_u256(x: f64) -> U256 {
    if x <= 0.0 {
        return U256::ZERO;
    }
    // f64 -> integer via decimal string (exact enough: the fit is checked by replay).
    format!("{x:.0}").parse::<U256>().unwrap_or(U256::ZERO)
}

/// Relative error of our replay of each trade with the given curve.
pub fn replay_errors(c: &Curve, trades: &[&Trade]) -> Vec<f64> {
    trades
        .iter()
        .filter_map(|t| {
            let pre = pre_state(t)?;
            if t.buy {
                let got = c.tokens_for_cost(pre, t.cost)?;
                Some(((f(got) - f(t.amount)) / f(t.amount).max(1.0)).abs())
            } else {
                let got = c.proceeds_for_tokens(pre, t.amount)?;
                Some(((f(got) - f(t.cost)) / f(t.cost).max(1.0)).abs())
            }
        })
        .collect()
}

pub fn build(dir: &Path) -> Value {
    let trades = load(dir);
    let mut by_token: BTreeMap<&str, Vec<&Trade>> = BTreeMap::new();
    for t in &trades {
        by_token.entry(t.token.as_str()).or_default().push(t);
    }

    // 1. Do offers/funds move by exactly the trade? (consecutive pairs)
    let (mut pairs, mut exact_o, mut exact_f, mut exact_f_with_fee) = (0u64, 0u64, 0u64, 0u64);
    for v in by_token.values() {
        for w in v.windows(2) {
            let (p, t) = (w[0], w[1]);
            pairs += 1;
            let (d_o_ok, d_f_ok, d_ff_ok) = if t.buy {
                (
                    p.offers.checked_sub(t.offers) == Some(t.amount),
                    t.funds.checked_sub(p.funds) == Some(t.cost),
                    t.funds.checked_sub(p.funds) == Some(t.cost + t.fee),
                )
            } else {
                (
                    t.offers.checked_sub(p.offers) == Some(t.amount),
                    p.funds.checked_sub(t.funds) == Some(t.cost),
                    p.funds.checked_sub(t.funds) == Some(t.cost + t.fee),
                )
            };
            exact_o += d_o_ok as u64;
            exact_f += d_f_ok as u64;
            exact_f_with_fee += d_ff_ok as u64;
        }
    }
    let share = |a: u64| if pairs > 0 { Some(100.0 * a as f64 / pairs as f64) } else { None };

    // 2. Fit A, B per token (tokens with >= 5 trades), then the median.
    let mut per_a = Vec::new();
    let mut per_b = Vec::new();
    for v in by_token.values().filter(|v| v.len() >= 5) {
        if let Some((a, b)) = fit(v) {
            if a > 0.0 && b > 0.0 {
                per_a.push(a);
                per_b.push(b);
            }
        }
    }
    per_a.sort_by(|x, y| x.partial_cmp(y).unwrap());
    per_b.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let spread = |v: &[f64]| match (pct(v, 25.0), pct(v, 50.0), pct(v, 75.0)) {
        (Some(lo), Some(mid), Some(hi)) if mid > 0.0 => Some(100.0 * (hi - lo) / mid),
        _ => None,
    };

    // 3. Replay every trade with the shared (median) curve.
    let all: Vec<&Trade> = trades.iter().collect();
    let curve = match (pct(&per_a, 50.0), pct(&per_b, 50.0)) {
        (Some(a), Some(b)) => Some(Curve { virt_tokens: to_u256(a), virt_quote: to_u256(b) }),
        _ => None,
    };
    let mut errs = curve.map(|c| replay_errors(&c, &all)).unwrap_or_default();
    errs.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let within = |e: f64| {
        if errs.is_empty() {
            None
        } else {
            Some(100.0 * errs.iter().filter(|x| **x <= e).count() as f64 / errs.len() as f64)
        }
    };

    // 4. Fees.
    let mut ratios: Vec<f64> = trades.iter().filter(|t| !t.cost.is_zero()).map(|t| f(t.fee) / f(t.cost)).collect();
    ratios.sort_by(|x, y| x.partial_cmp(y).unwrap());
    let rate = pct(&ratios, 50.0);
    let min_fee = rate.and_then(|r| {
        trades.iter().filter(|t| !t.cost.is_zero() && f(t.fee) / f(t.cost) > r * 1.05).map(|t| t.fee).min()
    });

    json!({
        "trades": trades.len(),
        "tokens": by_token.len(),
        "state_semantics": {
            "consecutive_pairs": pairs,
            "offers_moves_by_amount_pct": share(exact_o),
            "funds_moves_by_cost_pct": share(exact_f),
            "funds_moves_by_cost_plus_fee_pct": share(exact_f_with_fee),
        },
        "fit": {
            "tokens_fitted": per_a.len(),
            "virt_tokens_median": pct(&per_a, 50.0),
            "virt_quote_median": pct(&per_b, 50.0),
            "virt_tokens_spread_pct": spread(&per_a),
            "virt_quote_spread_pct": spread(&per_b),
        },
        "replay": {
            "checked": errs.len(),
            "within_0_0001pct": within(1e-6),
            "within_0_01pct": within(1e-4),
            "within_0_1pct": within(1e-3),
            "error_p50": pct(&errs, 50.0),
            "error_p99": pct(&errs, 99.0),
        },
        "fees": {"rate_bps_median": rate.map(|r| r * 1e4), "min_fee_observed": min_fee.map(|m| m.to_string())},
        "curve": curve.map(|c| json!({"virt_tokens": c.virt_tokens.to_string(), "virt_quote": c.virt_quote.to_string()})),
    })
}

pub fn render(r: &Value) -> String {
    let p = |v: &Value| v.as_f64().map(|x| format!("{x:.2}")).unwrap_or_else(|| "n/a".into());
    let s = &r["state_semantics"];
    let rp = &r["replay"];
    let verdict = match rp["within_0_01pct"].as_f64() {
        Some(x) if x >= 99.0 => "PASS: local quotes match the chain. Safe to use for sizing.",
        Some(x) if x >= 90.0 => "CLOSE: most trades match; check outliers before relying on it.",
        Some(_) => "FAIL: the model does not reproduce real trades. Do not use local quotes.",
        None => "NO DATA: not enough trades yet.",
    };
    format!(
        "CURVE CHECK  ({} trades, {} tokens)\n\
         1. state fields: offers moves by trade amount in {}% of pairs, funds by cost in {}% (by cost+fee {}%)\n\
         2. fitted curve: virtual tokens {} (spread {}%), virtual quote {} (spread {}%) from {} tokens\n\
         3. replay: {}% of trades within 0.01%, {}% within 0.1% (p99 error {})\n\
         4. fees: median {} bps, minimum fee seen {}\n\
         VERDICT: {verdict}\n",
        r["trades"],
        r["tokens"],
        p(&s["offers_moves_by_amount_pct"]),
        p(&s["funds_moves_by_cost_pct"]),
        p(&s["funds_moves_by_cost_plus_fee_pct"]),
        r["fit"]["virt_tokens_median"],
        p(&r["fit"]["virt_tokens_spread_pct"]),
        r["fit"]["virt_quote_median"],
        p(&r["fit"]["virt_quote_spread_pct"]),
        r["fit"]["tokens_fitted"],
        p(&rp["within_0_01pct"]),
        p(&rp["within_0_1pct"]),
        rp["error_p99"],
        p(&r["fees"]["rate_bps_median"]),
        r["fees"]["min_fee_observed"],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::curve::{quote_buy, quote_sell, Fees};

    fn e18(x: u64) -> U256 {
        U256::from(x) * U256::from(10u64).pow(U256::from(18))
    }

    /// Generate a realistic trade log from a KNOWN curve, write it like the
    /// probe does, and check calibration recovers the curve and passes.
    #[test]
    fn recovers_a_known_curve_from_trade_log() {
        let truth = Curve { virt_tokens: e18(273_000_000), virt_quote: e18(7) };
        let fees = Fees { rate_bps: 100, min_fee: U256::ZERO };
        let dir = std::env::temp_dir().join(format!("sniper-cal-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut lines = Vec::new();
        let mut block = 1u64;
        for tok in 0..6 {
            let mut s = State { offers: e18(800_000_000), funds: U256::ZERO };
            let mut held: Vec<U256> = Vec::new();
            for i in 0..20u64 {
                block += 1;
                let sell = i % 4 == 3 && !held.is_empty();
                let rec = if sell {
                    let amt = held.pop().unwrap();
                    let q = quote_sell(&truth, &fees, s, amt).unwrap();
                    s = q.after;
                    ("sell", amt, q.gross, q.fee)
                } else {
                    let spend = e18(1) / U256::from(10) * U256::from(1 + (i * 7 + tok) % 15);
                    let q = quote_buy(&truth, &fees, s, spend).unwrap();
                    s = q.after;
                    held.push(q.tokens);
                    ("buy", q.tokens, q.cost, q.fee)
                };
                lines.push(
                    json!({"kind": rec.0, "token": format!("0xt{tok}"), "block": block, "log_index": 0,
                           "amount": rec.1.to_string(), "cost": rec.2.to_string(), "fee": rec.3.to_string(),
                           "offers": s.offers.to_string(), "funds": s.funds.to_string(), "price": "1", "removed": false})
                    .to_string(),
                );
            }
        }
        fs::write(dir.join("trades.jsonl"), lines.join("\n")).unwrap();
        let r = build(&dir);
        assert_eq!(r["state_semantics"]["offers_moves_by_amount_pct"].as_f64(), Some(100.0));
        assert_eq!(r["state_semantics"]["funds_moves_by_cost_pct"].as_f64(), Some(100.0));
        let a = r["fit"]["virt_tokens_median"].as_f64().unwrap();
        let b = r["fit"]["virt_quote_median"].as_f64().unwrap();
        assert!((a / 273e24 - 1.0).abs() < 1e-6, "A {a}");
        assert!((b / 7e18 - 1.0).abs() < 1e-6, "B {b}");
        assert!(r["replay"]["within_0_01pct"].as_f64().unwrap() >= 99.0, "{r:#}");
        assert!((r["fees"]["rate_bps_median"].as_f64().unwrap() - 100.0).abs() < 0.5);
        assert!(render(&r).contains("PASS"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_wrong_model_fails_loudly() {
        // Trades that follow a LINEAR price, not a constant product.
        let dir = std::env::temp_dir().join(format!("sniper-cal-bad-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut lines = Vec::new();
        let (mut offers, mut funds) = (e18(800_000_000), U256::ZERO);
        for i in 0..30u64 {
            let amount = e18(5_000_000 + i * 1_000_000);
            let cost = e18(1) * U256::from(1 + i * i) / U256::from(10);
            offers -= amount;
            funds += cost;
            lines.push(
                json!({"kind": "buy", "token": "0xbad", "block": i + 1, "log_index": 0,
                       "amount": amount.to_string(), "cost": cost.to_string(), "fee": "0",
                       "offers": offers.to_string(), "funds": funds.to_string(), "removed": false})
                .to_string(),
            );
        }
        fs::write(dir.join("trades.jsonl"), lines.join("\n")).unwrap();
        let r = build(&dir);
        assert!(!render(&r).contains("PASS"), "{}", render(&r));
        let _ = fs::remove_dir_all(&dir);
    }
}
