// ============================================================================
// TAX / TRAP CHECK (copied from the dex bot's src/core/coinTax.ts idea)
//
// Plain English:
//   Some tokens take a cut every time they move, or refuse to move at all
//   (blacklists, paused trading, "can buy but can't sell" traps). The
//   Uniswap quoter can't see that on the SELL side, so the paper trader kept
//   buying tokens it later couldn't sell (8 of them in run 3, about -$400).
//
//   Before buying, this runs ONE free simulation on the real chain
//   (eth_simulateV1, nothing is sent), the same test the dex bot uses:
//     1. move 0.1% of what the pool holds of the token, pool -> test wallet
//        (like a buy): did the full amount arrive?
//     2. move 90% of that back, test wallet -> pool (like a sell): did the
//        pool receive the full amount?
//   Either move refused  = BLOCKED. Either move short by more than 0.05%
//   = TAXED. Both skip the trade. Results are cached: a pass is re-tested
//   after 6 h (owners can switch a tax on later), a fail after 24 h.
//   If the test can't run (node error), the trade is skipped too: we never
//   buy a token we couldn't check.
// ============================================================================
use std::collections::HashMap;
use std::time::{Duration, Instant};

use ruint::aliases::U256;
use serde_json::{json, Value};

use crate::sellcheck::Rpc;

/// A wallet with no code and no history, used only inside the simulation.
const TEST_WALLET: &str = "0x5afe0000000000000000000000000000c0ffee01";
/// Largest loss per move we still call "no tax" (0.05%).
const MAX_LOSS_BPS: u64 = 5;

#[derive(Clone, Debug, PartialEq)]
pub enum Verdict {
    Ok,
    Taxed { buy_bps: u64, sell_bps: u64 },
    Blocked(String),
}

fn word_addr(a: &str) -> String {
    format!("{:0>64}", a.trim_start_matches("0x").to_ascii_lowercase())
}

fn data_transfer(to: &str, amount: U256) -> String {
    format!("0xa9059cbb{}{:064x}", word_addr(to), amount)
}

fn data_balance(of: &str) -> String {
    format!("0x70a08231{}", word_addr(of))
}

fn u256_of(v: &Value) -> Option<U256> {
    let h = v.as_str()?.trim_start_matches("0x");
    if h.is_empty() {
        return None;
    }
    U256::from_str_radix(&h[..h.len().min(64)], 16).ok()
}

/// Loss in basis points, rounded UP (a 0.049% cut must not hide as 4 bps).
fn loss_bps(sent: U256, got: U256) -> u64 {
    if got >= sent || sent.is_zero() {
        return 0;
    }
    let lost = sent - got;
    let num = lost * U256::from(10_000u64) + sent - U256::from(1u64);
    u64::try_from(num / sent).unwrap_or(u64::MAX)
}

/// Decide from the four simulated calls:
/// [transfer pool->test, balanceOf(test), transfer test->pool, balanceOf(pool)].
pub fn judge(calls: &[Value], amount: U256, back: U256, pool_before: U256) -> Verdict {
    if calls.len() < 4 {
        return Verdict::Blocked("simulation returned too few results".into());
    }
    let ok = |c: &Value| c["status"].as_str() == Some("0x1");
    if !ok(&calls[0]) {
        return Verdict::Blocked("token refused to leave the pool".into());
    }
    if !ok(&calls[2]) {
        return Verdict::Blocked("token refused to go back to the pool (can't sell)".into());
    }
    let got_buy = u256_of(&calls[1]["returnData"]).unwrap_or(U256::ZERO);
    let pool_after = u256_of(&calls[3]["returnData"]).unwrap_or(U256::ZERO);
    let got_sell = pool_after.saturating_sub(pool_before.saturating_sub(amount));
    let (b, s) = (loss_bps(amount, got_buy), loss_bps(back, got_sell));
    if b > MAX_LOSS_BPS || s > MAX_LOSS_BPS {
        Verdict::Taxed { buy_bps: b, sell_bps: s }
    } else {
        Verdict::Ok
    }
}

/// Run the test once against the live chain.
pub fn test_token(rpc: &Rpc, token: &str, pool: &str) -> Result<Verdict, String> {
    let bal = rpc.call("eth_call", json!([{"to": token, "data": data_balance(pool)}, "latest"]))?;
    let pool_before = u256_of(&bal).ok_or("pool balance unreadable")?;
    let amount = pool_before / U256::from(1000u64);
    if amount.is_zero() {
        return Err("pool holds none of the token".into());
    }
    let back = amount * U256::from(9u64) / U256::from(10u64);
    let calls = json!([
        {"from": pool, "to": token, "data": data_transfer(TEST_WALLET, amount)},
        {"to": token, "data": data_balance(TEST_WALLET)},
        {"from": TEST_WALLET, "to": token, "data": data_transfer(pool, back)},
        {"to": token, "data": data_balance(pool)},
    ]);
    let r = rpc.call("eth_simulateV1", json!([{"blockStateCalls": [{"calls": calls}], "validation": false}, "latest"]))?;
    let results = r[0]["calls"].as_array().cloned().ok_or("simulation: no calls in reply")?;
    Ok(judge(&results, amount, back, pool_before))
}

/// Cached checker: pass re-tested after 6 h, fail after 24 h, errors not cached.
#[derive(Default)]
pub struct Checker {
    cache: HashMap<String, (Verdict, Instant)>,
}

impl Checker {
    pub fn check(&mut self, rpc: &Rpc, token: &str, pool: &str) -> Result<Verdict, String> {
        if let Some((v, at)) = self.cache.get(token) {
            let ttl = if *v == Verdict::Ok { Duration::from_secs(6 * 3600) } else { Duration::from_secs(24 * 3600) };
            if at.elapsed() < ttl {
                return Ok(v.clone());
            }
        }
        let v = test_token(rpc, token, pool)?;
        self.cache.insert(token.to_string(), (v.clone(), Instant::now()));
        Ok(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(status: &str, ret: U256) -> Value {
        json!({"status": status, "returnData": format!("0x{ret:064x}")})
    }

    #[test]
    fn clean_token_passes() {
        let (pool, amt) = (U256::from(1_000_000u64), U256::from(1_000u64));
        let back = U256::from(900u64);
        let calls = [call("0x1", U256::ZERO), call("0x1", amt), call("0x1", U256::ZERO), call("0x1", pool - amt + back)];
        assert_eq!(judge(&calls, amt, back, pool), Verdict::Ok);
    }

    #[test]
    fn sell_tax_is_caught() {
        let (pool, amt) = (U256::from(1_000_000u64), U256::from(1_000u64));
        let back = U256::from(900u64);
        // pool only receives 873 of 900 (3% sell tax)
        let calls = [call("0x1", U256::ZERO), call("0x1", amt), call("0x1", U256::ZERO), call("0x1", pool - amt + U256::from(873u64))];
        assert_eq!(judge(&calls, amt, back, pool), Verdict::Taxed { buy_bps: 0, sell_bps: 300 });
    }

    #[test]
    fn refused_sell_is_blocked() {
        let (pool, amt) = (U256::from(1_000_000u64), U256::from(1_000u64));
        let calls = [call("0x1", U256::ZERO), call("0x1", amt), call("0x0", U256::ZERO), call("0x1", pool - amt)];
        assert!(matches!(judge(&calls, amt, U256::from(900u64), pool), Verdict::Blocked(_)));
    }

    #[test]
    fn tiny_cut_rounds_up() {
        assert_eq!(loss_bps(U256::from(10_000u64), U256::from(9_999u64)), 1);
        assert_eq!(loss_bps(U256::from(10_000u64), U256::from(10_000u64)), 0);
    }

    #[test]
    fn calldata_layout() {
        let d = data_transfer("0x00000000000000000000000000000000000000aa", U256::from(5u64));
        assert!(d.starts_with("0xa9059cbb"));
        assert_eq!(d.len(), 2 + 8 + 128);
        assert!(data_balance("0xab").ends_with("ab"));
    }
}
