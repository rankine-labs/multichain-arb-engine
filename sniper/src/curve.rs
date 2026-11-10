// ============================================================================
// CURVE: exact Four.meme bonding-curve quotes, computed locally.
//
// Plain English:
//   Before a token "graduates" to PancakeSwap, its price is set by a formula.
//   If we know the formula and the token's current state, we can work out
//   EXACTLY what a buy costs or a sell returns, in microseconds, without
//   asking the chain. Sizing, entries and exits all stand on this.
//
// The model (standard launchpad "virtual reserve" curve):
//     X = tokens left on the curve + VIRTUAL_TOKENS
//     Y = quote raised (BNB)      + VIRTUAL_QUOTE
//     X * Y stays constant on every trade
//   Fees are charged on the quote side: max(amount * rate, minimum fee).
//
// IMPORTANT: Four.meme has not published its contract source. The SHAPE
// above is the standard one; the two virtual-reserve numbers, the fee rate
// and rounding are NOT assumed: `calibrate.rs` fits them from real trades
// recorded by the probe and reports how exactly they reproduce each trade.
// Nothing here should be used for sizing until that check passes.
//
// All maths is integer (256-bit), in the token's smallest units, rounding
// against us (we get slightly fewer tokens / slightly less BNB), so a quote
// is never optimistic.
// ============================================================================
use ruint::aliases::U256;

/// Curve shape constants for one token template.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Curve {
    pub virt_tokens: U256,
    pub virt_quote: U256,
}

/// A token's position on its curve (as in TokenPurchase/TokenSale events:
/// `offers` = tokens still for sale on the curve, `funds` = quote raised).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct State {
    pub offers: U256,
    pub funds: U256,
}

/// Trading fee: `rate_bps` basis points of the quote amount, at least `min_fee`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fees {
    pub rate_bps: u64,
    pub min_fee: U256,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuyQuote {
    /// Quote that goes into the curve.
    pub cost: U256,
    pub fee: U256,
    /// Tokens we receive.
    pub tokens: U256,
    pub after: State,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SellQuote {
    /// Quote the curve pays out before fee.
    pub gross: U256,
    pub fee: U256,
    /// What lands in our wallet.
    pub net: U256,
    pub after: State,
}

const BPS: u64 = 10_000;

fn ceil_div(a: U256, b: U256) -> U256 {
    let (q, r) = a.div_rem(b);
    if r.is_zero() {
        q
    } else {
        q + U256::from(1)
    }
}

impl Fees {
    pub fn fee(&self, amount: U256) -> U256 {
        let f = ceil_div(amount * U256::from(self.rate_bps), U256::from(BPS));
        f.max(self.min_fee)
    }
}

impl Curve {
    fn reserves(&self, s: State) -> (U256, U256) {
        (s.offers + self.virt_tokens, s.funds + self.virt_quote)
    }

    /// Tokens out for putting `cost` of quote into the curve (no fee here).
    /// None if it would buy more than what is left on the curve.
    pub fn tokens_for_cost(&self, s: State, cost: U256) -> Option<U256> {
        let (x, y) = self.reserves(s);
        let new_x = ceil_div(x * y, y + cost);
        let out = x.checked_sub(new_x)?;
        (out <= s.offers).then_some(out)
    }

    /// Quote needed to take exactly `amount` tokens off the curve (no fee).
    pub fn cost_for_tokens(&self, s: State, amount: U256) -> Option<U256> {
        if amount > s.offers {
            return None;
        }
        let (x, y) = self.reserves(s);
        let new_y = ceil_div(x * y, x - amount);
        Some(new_y - y)
    }

    /// Quote paid out for putting `amount` tokens back (no fee). Rounded down.
    pub fn proceeds_for_tokens(&self, s: State, amount: U256) -> Option<U256> {
        let (x, y) = self.reserves(s);
        let new_y = ceil_div(x * y, x + amount);
        let out = y.checked_sub(new_y)?;
        (out <= s.funds).then_some(out)
    }

    /// Spot price (quote per token, both in smallest units). For display and
    /// rough checks only; trading decisions use the exact functions above.
    pub fn spot_price(&self, s: State) -> f64 {
        let (x, y) = self.reserves(s);
        f64::from(y) / f64::from(x)
    }
}

/// Buy spending `total_in` in all (fee included).
pub fn quote_buy(c: &Curve, f: &Fees, s: State, total_in: U256) -> Option<BuyQuote> {
    // Split total_in into cost + fee with fee = max(cost * rate, min).
    let mut cost = total_in * U256::from(BPS) / U256::from(BPS + f.rate_bps);
    let mut fee = total_in - cost;
    if fee < f.fee(cost) {
        // Rounding or minimum fee: take the fee first, rest goes in.
        fee = f.fee(cost);
        cost = total_in.checked_sub(fee)?;
    }
    let tokens = c.tokens_for_cost(s, cost)?;
    Some(BuyQuote { cost, fee, tokens, after: State { offers: s.offers - tokens, funds: s.funds + cost } })
}

/// Sell `tokens`, fee taken from the proceeds.
pub fn quote_sell(c: &Curve, f: &Fees, s: State, tokens: U256) -> Option<SellQuote> {
    let gross = c.proceeds_for_tokens(s, tokens)?;
    let fee = f.fee(gross).min(gross);
    Some(SellQuote { gross, fee, net: gross - fee, after: State { offers: s.offers + tokens, funds: s.funds - gross } })
}

/// The core profitability question, exactly:
/// "If we buy with `total_in`, then these other buys (quote amounts going in,
/// fee already excluded) land, and then we sell everything, what do we get
/// back?" Returns (our buy, our sell). Our sell's `net` minus `total_in` is
/// the result before gas.
pub fn round_trip(c: &Curve, f: &Fees, s: State, total_in: U256, others_buy_costs: &[U256]) -> Option<(BuyQuote, SellQuote)> {
    let buy = quote_buy(c, f, s, total_in)?;
    let mut st = buy.after;
    for cost in others_buy_costs {
        let t = c.tokens_for_cost(st, *cost)?;
        st = State { offers: st.offers - t, funds: st.funds + *cost };
    }
    let sell = quote_sell(c, f, st, buy.tokens)?;
    Some((buy, sell))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e18(x: u64) -> U256 {
        U256::from(x) * U256::from(10u64).pow(U256::from(18))
    }

    // Illustrative parameters only (NOT Four.meme's real numbers, which come
    // from calibration): 800M tokens on the curve, 1.06B virtual-ish shape.
    fn curve() -> Curve {
        Curve { virt_tokens: e18(260_000_000), virt_quote: e18(8) }
    }
    fn start() -> State {
        State { offers: e18(800_000_000), funds: U256::ZERO }
    }
    fn fees() -> Fees {
        Fees { rate_bps: 100, min_fee: U256::ZERO }
    }

    #[test]
    fn product_never_decreases() {
        let c = curve();
        let s = start();
        let (x, y) = c.reserves(s);
        let k = x * y;
        let t = c.tokens_for_cost(s, e18(1)).unwrap();
        let after = State { offers: s.offers - t, funds: s.funds + e18(1) };
        let (x2, y2) = c.reserves(after);
        assert!(x2 * y2 >= k, "rounding must favour the curve, not us");
    }

    #[test]
    fn buy_then_sell_immediately_loses_only_fees_and_rounding() {
        let (c, f, s) = (curve(), fees(), start());
        let (buy, sell) = round_trip(&c, &f, s, e18(1), &[]).unwrap();
        // ~1% fee in, ~1% fee out: get back ~98%.
        let back = f64::from(sell.net) / 1e18;
        assert!(back > 0.979 && back < 0.981, "got back {back}");
        assert_eq!(buy.cost + buy.fee, e18(1));
    }

    #[test]
    fn others_buying_after_us_makes_the_round_trip_profitable() {
        let (c, f, s) = (curve(), fees(), start());
        let (_, sell) = round_trip(&c, &f, s, e18(1), &[e18(3)]).unwrap();
        assert!(sell.net > e18(1), "net {}", sell.net);
    }

    #[test]
    fn exact_cost_and_exact_tokens_are_consistent() {
        let c = curve();
        let s = start();
        let amount = e18(10_000_000);
        let cost = c.cost_for_tokens(s, amount).unwrap();
        // Cost is rounded up, so spending it buys at least the requested
        // amount, and only a rounding-sized bit more.
        let got = c.tokens_for_cost(s, cost).unwrap();
        assert!(got >= amount && got - amount < U256::from(1_000_000_000_000u64), "got {got} want {amount}");
    }

    #[test]
    fn cannot_buy_past_the_curve_or_sell_more_than_raised() {
        let c = curve();
        let s = start();
        assert!(c.cost_for_tokens(s, s.offers + U256::from(1)).is_none());
        assert!(c.tokens_for_cost(s, e18(1_000_000)).is_none());
        assert!(c.proceeds_for_tokens(s, e18(1)).is_none()); // nothing raised yet
    }

    #[test]
    fn minimum_fee_applies() {
        let f = Fees { rate_bps: 100, min_fee: U256::from(5_000u64) };
        assert_eq!(f.fee(U256::from(100u64)), U256::from(5_000u64));
        assert_eq!(f.fee(e18(1)), e18(1) / U256::from(100));
    }
}
