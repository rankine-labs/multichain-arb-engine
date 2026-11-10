// ============================================================================
// REGISTRY: the live list of Four.meme tokens and what is happening to them.
//
// Plain English:
//   Fed by decoded Four.meme events (see fourmeme.rs), it keeps, per token:
//     - when and in which block we first saw it, its creator, launch time
//     - its exact position on the price curve (from the latest trade)
//     - buy/sell counts and volume, distinct buyers
//     - risk flags: creator sold, graduated to PancakeSwap
//   and raises a BURST signal the moment a token's buying in one block
//   crosses the threshold (N buys from N different wallets, more bought than
//   sold). It fires on the crossing itself, mid-block, so no waiting for the
//   next block header.
//
//   Pure logic: no network, no clock of its own. Easy to test, and the same
//   code will run inside the trading engine later.
// ============================================================================
use std::collections::{HashMap, HashSet};

use ruint::aliases::U256;
use serde_json::{json, Value};

use crate::curve::State;

#[derive(Clone, Debug, Default)]
pub struct TokenEntry {
    pub token: String,
    pub creator: Option<String>,
    pub created_block: Option<u64>,
    pub launch_time: Option<u64>,
    /// First block / local time (ns) we saw ANY event for this token.
    pub first_block: u64,
    pub first_t: u64,
    pub last_block: u64,
    pub last_t: u64,
    /// Curve position after the latest trade we saw.
    pub state: Option<State>,
    pub last_price: Option<U256>,
    pub buys: u64,
    pub sells: u64,
    pub buy_volume: U256,
    pub sell_volume: U256,
    pub buyers: HashSet<String>,
    pub creator_sold: bool,
    pub graduated: bool,
    /// Current block's activity, for burst detection.
    bucket: Bucket,
}

#[derive(Clone, Debug, Default)]
struct Bucket {
    block: u64,
    buys: u64,
    buyers: HashSet<String>,
    bought: U256,
    sold: U256,
    fired: bool,
}

/// Something worth acting on.
#[derive(Clone, Debug, PartialEq)]
pub enum Signal {
    NewToken { token: String, creator: Option<String>, block: u64 },
    Burst { token: String, block: u64, buys: u64, buyers: usize, net_bought: U256, state: Option<State> },
    CreatorSold { token: String, block: u64, amount: U256 },
    Graduated { token: String, block: u64 },
}

impl Signal {
    pub fn json(&self) -> Value {
        let st = |s: &Option<State>| s.map(|s| json!({"offers": s.offers.to_string(), "funds": s.funds.to_string()}));
        match self {
            Signal::NewToken { token, creator, block } => json!({"signal": "new_token", "token": token, "creator": creator, "block": block}),
            Signal::Burst { token, block, buys, buyers, net_bought, state } => json!({
                "signal": "burst", "token": token, "block": block, "buys": buys, "buyers": buyers,
                "net_bought": net_bought.to_string(), "state": st(state)}),
            Signal::CreatorSold { token, block, amount } => json!({"signal": "creator_sold", "token": token, "block": block, "amount": amount.to_string()}),
            Signal::Graduated { token, block } => json!({"signal": "graduated", "token": token, "block": block}),
        }
    }
}

pub struct Registry {
    pub tokens: HashMap<String, TokenEntry>,
    /// Buys AND distinct buyers in one block that make a burst.
    pub burst_buys: u64,
    /// Forget tokens with no activity for this long (ns).
    pub idle_ns: u64,
}

fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or("").to_ascii_lowercase()
}
fn num(v: &Value, k: &str) -> U256 {
    v[k].as_str().and_then(|x| x.parse().ok()).unwrap_or(U256::ZERO)
}

impl Registry {
    pub fn new(burst_buys: u64, idle_secs: u64) -> Self {
        Registry { tokens: HashMap::new(), burst_buys, idle_ns: idle_secs * 1_000_000_000 }
    }

    fn entry(&mut self, token: &str, block: u64, t: u64) -> (&mut TokenEntry, bool) {
        let new = !self.tokens.contains_key(token);
        let e = self.tokens.entry(token.to_string()).or_insert_with(|| TokenEntry {
            token: token.to_string(),
            first_block: block,
            first_t: t,
            ..Default::default()
        });
        e.last_block = e.last_block.max(block);
        e.last_t = t;
        (e, new)
    }

    /// Feed one decoded Four.meme event record (fourmeme::decode_log output)
    /// received at local time `t`. Returns any signals it triggers.
    pub fn on_event(&mut self, rec: &Value, t: u64) -> Vec<Signal> {
        let mut out = Vec::new();
        if rec["removed"] == json!(true) {
            return out; // reorged away; the replacement block will re-send
        }
        let token = s(rec, "token");
        if token.is_empty() {
            return out;
        }
        let block = rec["block"].as_u64().unwrap_or(0);
        let burst_buys = self.burst_buys;
        let kind = rec["kind"].as_str().unwrap_or("");
        let (e, new) = self.entry(&token, block, t);
        match kind {
            "create" => {
                e.creator = Some(s(rec, "creator"));
                e.created_block = Some(block);
                e.launch_time = rec["launch_time"].as_str().and_then(|x| x.parse().ok());
                out.push(Signal::NewToken { token: token.clone(), creator: e.creator.clone(), block });
            }
            "buy" | "sell" => {
                if new {
                    // Token created before we started (or create missed).
                    out.push(Signal::NewToken { token: token.clone(), creator: None, block });
                }
                let buy = kind == "buy";
                let account = s(rec, "account");
                let cost = num(rec, "cost");
                e.state = Some(State { offers: num(rec, "offers"), funds: num(rec, "funds") });
                e.last_price = Some(num(rec, "price"));
                if e.bucket.block != block {
                    e.bucket = Bucket { block, ..Default::default() };
                }
                if buy {
                    e.buys += 1;
                    e.buy_volume += cost;
                    e.buyers.insert(account.clone());
                    e.bucket.buys += 1;
                    e.bucket.bought += cost;
                    e.bucket.buyers.insert(account);
                } else {
                    e.sells += 1;
                    e.sell_volume += cost;
                    e.bucket.sold += cost;
                    if e.creator.as_deref() == Some(account.as_str()) && !e.creator_sold {
                        e.creator_sold = true;
                        out.push(Signal::CreatorSold { token: token.clone(), block, amount: num(rec, "amount") });
                    }
                }
                let b = &mut e.bucket;
                if !b.fired && b.buys >= burst_buys && b.buyers.len() as u64 >= burst_buys && b.bought > b.sold {
                    b.fired = true;
                    out.push(Signal::Burst {
                        token: token.clone(),
                        block,
                        buys: b.buys,
                        buyers: b.buyers.len(),
                        net_bought: b.bought - b.sold,
                        state: e.state,
                    });
                }
            }
            "graduate" if !e.graduated => {
                e.graduated = true;
                out.push(Signal::Graduated { token: token.clone(), block });
            }
            _ => {}
        }
        out
    }

    /// Drop idle and graduated tokens (graduated ones trade on PancakeSwap,
    /// a separate venue handled later).
    pub fn prune(&mut self, now: u64) {
        let idle = self.idle_ns;
        self.tokens.retain(|_, e| !e.graduated && now.saturating_sub(e.last_t) <= idle);
    }

    /// Most active tokens over the last `window_ns`, by buy count.
    pub fn hottest(&self, now: u64, window_ns: u64, n: usize) -> Vec<&TokenEntry> {
        let mut v: Vec<&TokenEntry> = self.tokens.values().filter(|e| now.saturating_sub(e.last_t) <= window_ns && !e.graduated).collect();
        v.sort_by(|a, b| b.buys.cmp(&a.buys));
        v.truncate(n);
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trade(kind: &str, token: &str, account: &str, block: u64, cost: u64) -> Value {
        json!({"kind": kind, "token": token, "account": account, "block": block, "cost": cost.to_string(),
               "amount": "1000", "offers": "500", "funds": "70", "price": "9", "removed": false})
    }

    #[test]
    fn create_then_trades_track_state() {
        let mut r = Registry::new(3, 600);
        let sig = r.on_event(&json!({"kind": "create", "token": "0xT", "creator": "0xC", "block": 5, "launch_time": "100"}), 1);
        assert_eq!(sig, vec![Signal::NewToken { token: "0xt".into(), creator: Some("0xc".into()), block: 5 }]);
        r.on_event(&trade("buy", "0xt", "0xa", 6, 10), 2);
        let e = &r.tokens["0xt"];
        assert_eq!(e.buys, 1);
        assert_eq!(e.state.unwrap().offers, U256::from(500));
        assert_eq!(e.created_block, Some(5));
        assert_eq!(e.launch_time, Some(100));
    }

    #[test]
    fn burst_fires_once_on_the_crossing() {
        let mut r = Registry::new(3, 600);
        assert!(r.on_event(&trade("buy", "0xt", "0xa", 10, 5), 1).iter().all(|s| !matches!(s, Signal::Burst { .. })));
        assert!(r.on_event(&trade("buy", "0xt", "0xb", 10, 5), 2).is_empty());
        let sig = r.on_event(&trade("buy", "0xt", "0xc", 10, 5), 3);
        assert!(matches!(sig[0], Signal::Burst { buys: 3, buyers: 3, .. }), "{sig:?}");
        // 4th buy same block: no second signal.
        assert!(r.on_event(&trade("buy", "0xt", "0xd", 10, 5), 4).is_empty());
        // Next block starts fresh.
        r.on_event(&trade("buy", "0xt", "0xa", 11, 5), 5);
        assert_eq!(r.tokens["0xt"].bucket.buys, 1);
    }

    #[test]
    fn same_wallet_three_times_is_not_a_burst() {
        let mut r = Registry::new(3, 600);
        for i in 0..3 {
            let sig = r.on_event(&trade("buy", "0xt", "0xa", 10, 5), i);
            assert!(sig.iter().all(|s| !matches!(s, Signal::Burst { .. })));
        }
    }

    #[test]
    fn heavier_selling_blocks_a_burst() {
        let mut r = Registry::new(3, 600);
        r.on_event(&trade("sell", "0xt", "0xz", 10, 100), 0);
        for (i, a) in ["0xa", "0xb", "0xc"].iter().enumerate() {
            let sig = r.on_event(&trade("buy", "0xt", a, 10, 5), i as u64 + 1);
            assert!(sig.iter().all(|s| !matches!(s, Signal::Burst { .. })));
        }
    }

    #[test]
    fn creator_selling_is_flagged() {
        let mut r = Registry::new(3, 600);
        r.on_event(&json!({"kind": "create", "token": "0xt", "creator": "0xc", "block": 1}), 0);
        let sig = r.on_event(&trade("sell", "0xt", "0xC", 2, 50), 1);
        assert!(matches!(sig[0], Signal::CreatorSold { .. }));
        assert!(r.tokens["0xt"].creator_sold);
    }

    #[test]
    fn graduation_and_idle_tokens_are_pruned() {
        let mut r = Registry::new(3, 1);
        r.on_event(&trade("buy", "0xg", "0xa", 1, 5), 0);
        r.on_event(&trade("buy", "0xi", "0xa", 1, 5), 0);
        r.on_event(&trade("buy", "0xk", "0xa", 1, 5), 2_500_000_000);
        let sig = r.on_event(&json!({"kind": "graduate", "token": "0xg", "block": 2}), 2_500_000_000);
        assert_eq!(sig, vec![Signal::Graduated { token: "0xg".into(), block: 2 }]);
        r.prune(2_500_000_000);
        let left: Vec<&String> = r.tokens.keys().collect();
        assert_eq!(left, vec!["0xk"]);
    }

    #[test]
    fn reorged_events_are_ignored() {
        let mut r = Registry::new(3, 600);
        let mut t = trade("buy", "0xt", "0xa", 1, 5);
        t["removed"] = json!(true);
        assert!(r.on_event(&t, 0).is_empty());
        assert!(r.tokens.is_empty());
    }
}
