// ============================================================================
// RHC REPORT: turn a Robinhood Chain probe run into the go/no-go numbers.
//
// Plain English, three answers:
//   1. HEAD START: how much earlier the sequencer feed shows a block than a
//      normal node does. That is the copy's advantage over bots that wait
//      for normal block data. (Includes our own polling delay of about half
//      the poll interval, noted in the output.)
//   2. RUSHES: on every token/WETH or token/USDG pool, blocks where the
//      token got >= N buys (from N different transactions) and its price
//      rose >= the minimum rise.
//   3. FAST TRADES: for each rush, pretend we buy right after it and sell
//      at a take-profit, a stop-loss or a time limit, paying the pool fee
//      both ways. Two timings:
//        first  = we get in right after the rush block (we beat everyone)
//        late   = we only get in after one more block (rivals beat us)
//      Ignores our own price impact (fine for small sizes) and gas (cents).
//
// The price of the token comes from each swap's sqrtPriceX96 (exact pool
// price after that swap), so this works the same for meme coins, stock
// tokens and anything else trading against WETH or USDG.
// ============================================================================
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use crate::report::pct;

#[derive(Clone, Debug)]
pub struct Opts {
    /// Block number = feed sequence number + offset (0 on Robinhood Chain).
    pub offset: i64,
    pub rush_buys: usize,
    pub min_rise_pct: f64,
    /// A rush is counted over this many seconds (Robinhood makes a block
    /// about every 0.1 s, so one block is too short to see a crowd).
    pub window_s: f64,
    /// "First big buy" signal: one single buy that lifts the price by at
    /// least this much. With the copy we see it the moment it's ordered and
    /// can get in before the crowd that follows.
    pub jump_pct: f64,
}

impl Default for Opts {
    fn default() -> Self {
        Opts { offset: 0, rush_buys: 3, min_rise_pct: 2.0, window_s: 1.0, jump_pct: 3.0 }
    }
}

fn read(dir: &Path, name: &str) -> Vec<Value> {
    fs::read_to_string(dir.join(name))
        .map(|s| s.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
        .unwrap_or_default()
}

#[derive(Clone, Debug)]
pub struct Swap {
    pub pool: String,
    pub token: String,
    pub base: String,
    pub block: u64,
    pub log_index: u64,
    pub tx: String,
    /// Token price in base units (raw units, only ratios matter).
    pub price: f64,
    pub fee: f64,
    /// Base-coin amount (whole coins) that would move the token price +1%
    /// at this point (from the pool's active liquidity; rough, ignores
    /// liquidity changing across price bands). None if not recorded.
    pub size_1pct: Option<f64>,
}

/// Base amount (whole coins) that lifts the token price by ~1%, from the
/// pool's active liquidity L and sqrtPriceX96 (concentrated-liquidity maths:
/// d(token1) = L * d(sqrtP); d(token0) = L * d(1/sqrtP)). 1% on price is
/// ~0.4988% on sqrtP.
pub fn size_for_1pct(sqrt_price: &str, liquidity: &str, token_is0: bool, base: &str) -> Option<f64> {
    let sp: f64 = sqrt_price.parse::<f64>().ok()? / 2f64.powi(96);
    let l: f64 = liquidity.parse().ok()?;
    if sp <= 0.0 || l <= 0.0 {
        return None;
    }
    let k = 1.01f64.sqrt() - 1.0;
    // Buying the token = paying base. token_is0: base is token1 (raw = L*dsqrtP).
    let raw = if token_is0 { l * sp * k } else { l * (1.0 / sp) * k };
    Some(raw / 10f64.powi(crate::rhc::base_decimals(base)))
}

pub fn token_price(sqrt_price: &str, token_is0: bool) -> Option<f64> {
    let s: f64 = sqrt_price.parse().ok()?;
    let x = s / 2f64.powi(96);
    let p = x * x; // token1 per token0
    if p <= 0.0 || !p.is_finite() {
        return None;
    }
    Some(if token_is0 { p } else { 1.0 / p })
}

pub fn load_swaps(dir: &Path) -> Vec<Swap> {
    let mut v: Vec<Swap> = read(dir, "swaps.jsonl")
        .iter()
        .filter_map(|s| {
            Some(Swap {
                pool: s["pool"].as_str()?.to_string(),
                token: s["token"].as_str()?.to_string(),
                base: s["base"].as_str()?.to_string(),
                block: s["block"].as_u64()?,
                log_index: s["log_index"].as_u64()?,
                tx: s["tx"].as_str().unwrap_or("").to_string(),
                price: token_price(s["sqrt_price"].as_str()?, s["token_is0"].as_bool()?)?,
                fee: s["fee_ppm"].as_u64().unwrap_or(3000) as f64 / 1e6,
                size_1pct: s["liquidity"]
                    .as_str()
                    .and_then(|l| size_for_1pct(s["sqrt_price"].as_str()?, l, s["token_is0"].as_bool()?, s["base"].as_str()?)),
            })
        })
        .collect();
    v.sort_by_key(|s| (s.block, s.log_index));
    v.dedup_by(|a, b| a.block == b.block && a.log_index == b.log_index);
    v
}

/// One rush: pool, block, price after it, fee.
#[derive(Clone, Debug)]
pub struct Rush {
    pub pool: String,
    pub token: String,
    pub base: String,
    pub block: u64,
    pub fee: f64,
    pub size_1pct: Option<f64>,
}

/// Per pool: block -> last price in that block.
pub type PricePath = BTreeMap<u64, f64>;

/// Rushes: at block b, the pool's buys over the last `window` blocks (b
/// included) come from >= rush_buys different transactions, and the price
/// rose >= min_rise_pct from just before the window. After a rush, the pool
/// is quiet for one window (no double counting of the same rush).
pub fn find_rushes(swaps: &[Swap], o: &Opts, window: u64) -> (Vec<Rush>, HashMap<String, PricePath>) {
    let window = window.max(1);
    let mut by_pool: HashMap<&str, Vec<&Swap>> = HashMap::new();
    for s in swaps {
        by_pool.entry(&s.pool).or_default().push(s);
    }
    let mut rushes = Vec::new();
    let mut paths: HashMap<String, PricePath> = HashMap::new();
    for (pool, v) in by_pool {
        let mut path = PricePath::new();
        // (block, tx) of every buy, in order.
        let mut buys: Vec<(u64, &str)> = Vec::new();
        let mut last: Option<f64> = None;
        let mut i = 0;
        let mut quiet_until = 0u64;
        while i < v.len() {
            let b = v[i].block;
            while i < v.len() && v[i].block == b {
                let p = v[i].price;
                if let Some(q) = last {
                    if p > q {
                        buys.push((b, &v[i].tx));
                    }
                }
                last = Some(p);
                i += 1;
            }
            path.insert(b, last.unwrap());
            if b < quiet_until {
                continue;
            }
            let lo = b.saturating_sub(window - 1);
            let txs: HashSet<&str> = buys.iter().filter(|(bb, _)| *bb >= lo).map(|(_, t)| *t).collect();
            let n_buys = buys.iter().filter(|(bb, _)| *bb >= lo).count();
            let Some((_, p0)) = path.range(..lo).next_back() else { continue };
            let end = path[&b];
            if n_buys >= o.rush_buys && txs.len() >= o.rush_buys && 100.0 * (end / p0 - 1.0) >= o.min_rise_pct {
                let s = v.iter().find(|s| s.block == b).unwrap();
                let size_1pct = v.iter().rev().find(|s| s.block == b).and_then(|s| s.size_1pct);
                rushes.push(Rush { pool: pool.to_string(), token: s.token.clone(), base: s.base.clone(), block: b, fee: s.fee, size_1pct });
                quiet_until = b + window;
            }
        }
        paths.insert(pool.to_string(), path);
    }
    rushes.sort_by_key(|r| r.block);
    (rushes, paths)
}

/// "First big buy": a single swap that lifts the token price >= jump_pct
/// from the swap just before it. Entry is right after that block. After a
/// jump the pool is quiet for one window (no double counting).
pub fn find_jumps(swaps: &[Swap], o: &Opts, window: u64) -> Vec<Rush> {
    let mut by_pool: HashMap<&str, Vec<&Swap>> = HashMap::new();
    for s in swaps {
        by_pool.entry(&s.pool).or_default().push(s);
    }
    let mut out = Vec::new();
    for (pool, v) in by_pool {
        let mut quiet_until = 0u64;
        for w in v.windows(2) {
            let (a, b) = (w[0], w[1]);
            if b.block < quiet_until || a.price <= 0.0 {
                continue;
            }
            if 100.0 * (b.price / a.price - 1.0) >= o.jump_pct {
                // Enter after the whole block the jump landed in.
                out.push(Rush { pool: pool.to_string(), token: b.token.clone(), base: b.base.clone(), block: b.block, fee: b.fee, size_1pct: b.size_1pct });
                quiet_until = b.block + window.max(1);
            }
        }
    }
    out.sort_by_key(|r| r.block);
    out
}

/// Simulate one trade. Returns net return (0.01 = +1%) after fees both ways.
/// `delay` = blocks after the rush before we're in (0 = right after it).
pub fn simulate(path: &PricePath, r: &Rush, delay: u64, tp: f64, sl: f64, horizon: u64) -> Option<f64> {
    // Entry: last price at or before rush block + delay.
    let entry = *path.range(..=r.block + delay).next_back()?.1;
    let later: Vec<f64> = path.range(r.block + delay + 1..=r.block + delay + horizon).map(|(_, p)| *p).collect();
    let mut exit = *later.last().unwrap_or(&entry);
    for p in &later {
        let g = p / entry - 1.0;
        if g >= tp || g <= -sl {
            exit = *p;
            break;
        }
    }
    let keep = (1.0 - r.fee) * (1.0 - r.fee);
    Some(exit / entry * keep - 1.0)
}

fn stats(mut v: Vec<f64>) -> Value {
    if v.is_empty() {
        return json!({"n": 0});
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len() as f64;
    let mean = v.iter().sum::<f64>() / n;
    let sd = (v.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n - 1.0).max(1.0)).sqrt();
    json!({
        "n": v.len(),
        "avg_pct": 100.0 * mean,
        "median_pct": 100.0 * pct(&v, 50.0).unwrap(),
        "win_pct": 100.0 * v.iter().filter(|x| **x > 0.0).count() as f64 / n,
        "worst_pct": 100.0 * v[0],
        "best_pct": 100.0 * v[v.len() - 1],
        // Rough 95% range for the average: if it includes 0, no proven edge.
        "avg_low_pct": 100.0 * (mean - 1.96 * sd / n.sqrt()),
        "avg_high_pct": 100.0 * (mean + 1.96 * sd / n.sqrt()),
    })
}

pub fn build(dir: &Path, o: &Opts) -> Value {
    let feed = read(dir, "feed.jsonl");
    let blocks = read(dir, "blocks.jsonl");
    let meta = read(dir, "meta.jsonl");
    let poll_ms = meta.iter().find(|m| m["event"] == "start").and_then(|m| m["poll_ms"].as_u64()).unwrap_or(200);

    // ---- 1. head start ----
    let mut t_feed: HashMap<u64, u64> = HashMap::new();
    for f in &feed {
        if let (Some(seq), Some(t)) = (f["seq"].as_u64(), f["t"].as_u64()) {
            let b = (seq as i64 + o.offset) as u64;
            t_feed.entry(b).or_insert(t);
        }
    }
    let mut t_node: HashMap<u64, u64> = HashMap::new();
    for b in &blocks {
        let (Some(from), Some(to), Some(t)) = (b["from"].as_u64(), b["to"].as_u64(), b["t"].as_u64()) else { continue };
        for n in from..=to {
            t_node.entry(n).or_insert(t);
        }
    }
    let mut heads: Vec<f64> = t_node.iter().filter_map(|(b, tn)| t_feed.get(b).map(|tf| (*tn as f64 - *tf as f64) / 1e6)).collect();
    heads.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let feed_first = heads.iter().filter(|h| **h > 0.0).count();
    // Average block interval from the feed.
    let mut fb: Vec<(&u64, &u64)> = t_feed.iter().collect();
    fb.sort();
    // Block interval and run length: from the feed if we have it, else from
    // the node's block numbers and arrival times.
    let mut nb: Vec<(&u64, &u64)> = t_node.iter().collect();
    nb.sort();
    let span = |v: &Vec<(&u64, &u64)>| -> Option<(f64, f64)> {
        if v.len() < 2 {
            return None;
        }
        let ms = (*v.last().unwrap().1 as f64 - *v[0].1 as f64) / 1e6;
        Some((ms / (*v.last().unwrap().0 - *v[0].0).max(1) as f64, ms / 3.6e6))
    };
    let (block_ms, hours) = span(&fb).or_else(|| span(&nb)).unwrap_or((250.0, 0.0));

    // ---- 2 + 3. rushes and simulated fast trades ----
    let swaps = load_swaps(dir);
    let window = ((o.window_s * 1000.0 / block_ms.max(1.0)).round() as u64).max(1);
    let (rushes, paths) = find_rushes(&swaps, o, window);
    let tokens: HashSet<&str> = swaps.iter().map(|s| s.token.as_str()).collect();
    let grid = [(0.03, 0.03), (0.05, 0.05), (0.10, 0.05), (0.10, 0.10)];
    let horizons_s = [2.0, 10.0, 30.0];
    let run_sims = |signals: &[Rush]| -> Vec<Value> {
        let mut sims = Vec::new();
        // Entry timing: right after the signal block (we're first, as the
        // copy allows), or 0.3 s / 1 s later (rivals were faster).
        for (timing, delay_ms) in [("first", 0.0), ("+0.3s", 300.0), ("+1s", 1000.0)] {
            let delay = (delay_ms / block_ms.max(1.0)).round() as u64;
            for &hs in &horizons_s {
                let h = ((hs * 1000.0 / block_ms.max(1.0)).round() as u64).max(1);
                for &(tp, sl) in &grid {
                    let res: Vec<f64> = signals.iter().filter_map(|r| simulate(&paths[&r.pool], r, delay, tp, sl, h)).collect();
                    let mut st = stats(res);
                    st["timing"] = json!(timing);
                    st["horizon_s"] = json!(hs);
                    st["tp_pct"] = json!(tp * 100.0);
                    st["sl_pct"] = json!(sl * 100.0);
                    sims.push(st);
                }
            }
        }
        sims
    };
    let sims = run_sims(&rushes);
    let jumps = find_jumps(&swaps, o, window);
    let jump_sims = run_sims(&jumps);
    // How much money a rush can take: base amount that moves the price 1%.
    let mut depth = serde_json::Map::new();
    for base in ["WETH", "ETH", "USDG"] {
        let mut d: Vec<f64> = rushes.iter().filter(|r| r.base == base).filter_map(|r| r.size_1pct).collect();
        if d.is_empty() {
            continue;
        }
        d.sort_by(|a, b| a.partial_cmp(b).unwrap());
        depth.insert(base.into(), json!({"rushes": d.len(), "p25": pct(&d, 25.0), "p50": pct(&d, 50.0), "p75": pct(&d, 75.0)}));
    }
    let mut per_token: HashMap<&str, u64> = HashMap::new();
    for r in &rushes {
        *per_token.entry(r.token.as_str()).or_default() += 1;
    }
    let mut top: Vec<(&str, u64)> = per_token.into_iter().collect();
    top.sort_by_key(|t| std::cmp::Reverse(t.1));
    top.truncate(10);

    json!({
        "run": {"hours": hours, "feed_blocks": t_feed.len(), "node_blocks": t_node.len(), "swaps": swaps.len(), "tokens": tokens.len(), "pools": paths.len(), "block_ms": block_ms, "poll_ms": poll_ms},
        "head_start_ms": {
            "matched_blocks": heads.len(),
            "feed_first_pct": if heads.is_empty() { None } else { Some(100.0 * feed_first as f64 / heads.len() as f64) },
            "p10": pct(&heads, 10.0), "p50": pct(&heads, 50.0), "p90": pct(&heads, 90.0),
        },
        "rushes": {"count": rushes.len(), "per_hour": if hours > 0.0 { rushes.len() as f64 / hours } else { 0.0 },
                   "top_tokens": top.iter().map(|(t, n)| json!({"token": t, "rushes": n})).collect::<Vec<_>>(),
                   "settings": {"rush_buys": o.rush_buys, "min_rise_pct": o.min_rise_pct, "window_s": o.window_s, "window_blocks": window},
                   "size_for_1pct_move": depth},
        "fast_trades": sims,
        "jumps": {"count": jumps.len(), "per_hour": if hours > 0.0 { jumps.len() as f64 / hours } else { 0.0 }, "jump_pct": o.jump_pct},
        "fast_trades_after_jump": jump_sims,
    })
}

pub fn render(r: &Value) -> String {
    let f = |v: &Value| v.as_f64().map(|x| format!("{x:.1}")).unwrap_or_else(|| "n/a".into());
    let g = |v: &Value| v.as_f64().map(|x| format!("{x:.4}")).unwrap_or_else(|| "n/a".into());
    let run = &r["run"];
    let h = &r["head_start_ms"];
    let mut s = format!(
        "ROBINHOOD SPEED TEST  ({} h, {} blocks from the node, {} from the feed, {} swaps, {} tokens, block every {} ms)\n\n",
        f(&run["hours"]),
        run["node_blocks"],
        run["feed_blocks"],
        run["swaps"],
        run["tokens"],
        f(&run["block_ms"])
    );
    s += &format!(
        "1. HEAD START of the feed over a normal node: feed first in {}% of blocks, by p50 {} ms (p10 {}, p90 {})\n   (includes our polling delay of about {} ms; a node subscription would shave that)\n\n",
        f(&h["feed_first_pct"]),
        f(&h["p50"]),
        f(&h["p10"]),
        f(&h["p90"]),
        run["poll_ms"].as_u64().unwrap_or(200) / 2
    );
    s += &format!(
        "2. RUSHES: {} ({}/hour) = {}+ buys from {}+ transactions within {} s, price up {}%+\n\n",
        r["rushes"]["count"],
        f(&r["rushes"]["per_hour"]),
        r["rushes"]["settings"]["rush_buys"],
        r["rushes"]["settings"]["rush_buys"],
        f(&r["rushes"]["settings"]["window_s"]),
        f(&r["rushes"]["settings"]["min_rise_pct"])
    );
    if let Some(d) = r["rushes"]["size_for_1pct_move"].as_object() {
        if !d.is_empty() {
            s += "   how much money moves the price 1% at a rush (typical, i.e. median; quarter of pools below / above):\n";
            for (b, v) in d {
                s += &format!("     {b}: {} (p25 {}, p75 {}) over {} rushes\n", g(&v["p50"]), g(&v["p25"]), g(&v["p75"]), v["rushes"]);
            }
            s += "\n";
        }
    }
    s += "3. FAST TRADES after rushes (fees both ways included; avg range = rough 95% range)\n";
    s += &table(&r["fast_trades"]);
    s += &format!(
        "\n4. FIRST BIG BUY: {} single buys lifting the price {}%+ ({}/hour). Trades entering right after it:\n",
        r["jumps"]["count"],
        f(&r["jumps"]["jump_pct"]),
        f(&r["jumps"]["per_hour"])
    );
    s += &table(&r["fast_trades_after_jump"]);
    s
}

fn table(v: &Value) -> String {
    let f = |v: &Value| v.as_f64().map(|x| format!("{x:.1}")).unwrap_or_else(|| "n/a".into());
    let mut s = String::new();
    if let Some(a) = v.as_array() {
        for t in a {
            if t["n"] == 0 {
                continue;
            }
            s += &format!(
                "   {:<6} {:>4}s TP {:>2}% SL {:>2}%: avg {:>6}% [{} .. {}] | median {:>6}% | win {:>4}% | worst {:>6}% | n {}\n",
                t["timing"].as_str().unwrap_or(""),
                f(&t["horizon_s"]),
                t["tp_pct"].as_f64().unwrap_or(0.0) as u64,
                t["sl_pct"].as_f64().unwrap_or(0.0) as u64,
                f(&t["avg_pct"]),
                f(&t["avg_low_pct"]),
                f(&t["avg_high_pct"]),
                f(&t["median_pct"]),
                f(&t["win_pct"]),
                f(&t["worst_pct"]),
                t["n"]
            );
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sw(pool: &str, block: u64, li: u64, tx: &str, price: f64) -> Swap {
        Swap { pool: pool.into(), token: "0xt".into(), base: "WETH".into(), block, log_index: li, tx: tx.into(), price, fee: 0.003, size_1pct: None }
    }

    #[test]
    fn price_from_sqrt_price_both_orientations() {
        // sqrtPriceX96 = 2^96 -> price 1
        let one = format!("{:.0}", 2f64.powi(96));
        assert!((token_price(&one, true).unwrap() - 1.0).abs() < 1e-9);
        let two = format!("{:.0}", 2f64.powi(96) * 2f64.sqrt());
        assert!((token_price(&two, true).unwrap() - 2.0).abs() < 1e-6);
        assert!((token_price(&two, false).unwrap() - 0.5).abs() < 1e-6);
    }

    #[test]
    fn size_for_one_percent_matches_concentrated_liquidity_maths() {
        // sqrtP = 1 (price 1), L = 1e18 raw, base = token1 (WETH, 18 dp):
        // d(token1) = L * (sqrt(1.01) - 1) = ~0.004988 WETH
        let sp = format!("{:.0}", 2f64.powi(96));
        let got = size_for_1pct(&sp, "1000000000000000000", true, "WETH").unwrap();
        assert!((got - (1.01f64.sqrt() - 1.0)).abs() < 1e-9);
        // USDG has 6 decimals.
        let got = size_for_1pct(&sp, "1000000000000000000", true, "USDG").unwrap();
        assert!((got - (1.01f64.sqrt() - 1.0) * 1e12).abs() < 1e-3);
    }

    #[test]
    fn rush_needs_buys_from_several_txs_and_a_price_rise() {
        let o = Opts::default();
        let mut v = vec![sw("p", 1, 0, "a", 100.0)];
        // block 2: three buys from three txs, +6%
        v.push(sw("p", 2, 0, "b", 102.0));
        v.push(sw("p", 2, 1, "c", 104.0));
        v.push(sw("p", 2, 2, "d", 106.0));
        // block 3: three buys from ONE tx (a bot splitting) -> not a rush
        v.push(sw("p", 3, 0, "e", 108.0));
        v.push(sw("p", 3, 1, "e", 110.0));
        v.push(sw("p", 3, 2, "e", 112.0));
        let (r, paths) = find_rushes(&v, &o, 1);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].block, 2);
        assert_eq!(paths["p"][&3], 112.0);
    }

    #[test]
    fn rush_can_build_over_several_blocks() {
        let o = Opts::default();
        let v = vec![
            sw("p", 1, 0, "a", 100.0),
            sw("p", 2, 0, "b", 101.0),
            sw("p", 3, 0, "c", 102.0),
            sw("p", 4, 0, "d", 103.0),
            sw("p", 5, 0, "e", 104.0),
        ];
        // One block at a time: never 3 buys in a block.
        assert_eq!(find_rushes(&v, &o, 1).0.len(), 0);
        // Window of 3 blocks: blocks 2-4 give 3 buys from 3 txs, +3%.
        let (r, _) = find_rushes(&v, &o, 3);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].block, 4);
    }

    #[test]
    fn simulate_take_profit_stop_loss_and_fees() {
        let mut path = PricePath::new();
        path.insert(10, 100.0);
        path.insert(11, 103.0);
        path.insert(12, 111.0);
        let r = Rush { pool: "p".into(), token: "t".into(), base: "WETH".into(), block: 10, fee: 0.003, size_1pct: None };
        // first: entry 100, TP 10% hit at 111 -> 1.11 * 0.997^2 - 1
        let got = simulate(&path, &r, 0, 0.10, 0.05, 5).unwrap();
        assert!((got - (1.11 * 0.997 * 0.997 - 1.0)).abs() < 1e-12);
        // late: entry 103, nothing hit, time stop at 111
        let got = simulate(&path, &r, 1, 0.10, 0.05, 5).unwrap();
        assert!((got - (111.0 / 103.0 * 0.997 * 0.997 - 1.0)).abs() < 1e-12);
        // stop loss
        path.insert(13, 90.0);
        let r2 = Rush { block: 12, ..r };
        let got = simulate(&path, &r2, 0, 0.10, 0.05, 5).unwrap();
        assert!((got - (90.0 / 111.0 * 0.997 * 0.997 - 1.0)).abs() < 1e-12);
    }

    #[test]
    fn report_runs_end_to_end_on_a_small_folder() {
        let dir = std::env::temp_dir().join(format!("sniper-rhc-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let q = 2f64.powi(96);
        let sp = |p: f64| format!("{:.0}", q * p.sqrt());
        let mut swaps = Vec::new();
        let mut feed = Vec::new();
        let mut blocks = Vec::new();
        for b in 1..=40u64 {
            feed.push(json!({"seq": b, "t": b * 250_000_000}).to_string());
            blocks.push(json!({"from": b, "to": b, "t": b * 250_000_000 + 80_000_000}).to_string());
        }
        // price 1.0 at block 1, rush in block 2 to 1.06, then drifts to 1.2
        swaps.push(json!({"pool": "p", "token": "0xt", "base": "WETH", "token_is0": true, "sqrt_price": sp(1.0), "fee_ppm": 3000, "block": 1, "log_index": 0, "tx": "a"}).to_string());
        for (i, p) in [1.02, 1.04, 1.06].iter().enumerate() {
            swaps.push(json!({"pool": "p", "token": "0xt", "base": "WETH", "token_is0": true, "sqrt_price": sp(*p), "fee_ppm": 3000, "block": 2, "log_index": i, "tx": format!("t{i}")}).to_string());
        }
        for b in 3..=20u64 {
            let p = 1.06 + 0.01 * (b - 2) as f64;
            swaps.push(json!({"pool": "p", "token": "0xt", "base": "WETH", "token_is0": true, "sqrt_price": sp(p), "fee_ppm": 3000, "block": b, "log_index": 0, "tx": format!("x{b}")}).to_string());
        }
        fs::write(dir.join("feed.jsonl"), feed.join("\n")).unwrap();
        fs::write(dir.join("blocks.jsonl"), blocks.join("\n")).unwrap();
        fs::write(dir.join("swaps.jsonl"), swaps.join("\n")).unwrap();
        fs::write(dir.join("meta.jsonl"), json!({"event": "start", "poll_ms": 200}).to_string()).unwrap();
        // One-block window (0.25 s at 250 ms blocks) for this tiny fixture.
        let r = build(&dir, &Opts { window_s: 0.25, ..Opts::default() });
        assert_eq!(r["head_start_ms"]["feed_first_pct"].as_f64(), Some(100.0));
        assert!((r["head_start_ms"]["p50"].as_f64().unwrap() - 80.0).abs() < 1e-6);
        assert_eq!(r["rushes"]["count"], 1);
        assert!((r["run"]["block_ms"].as_f64().unwrap() - 250.0).abs() < 1e-6);
        let first = r["fast_trades"].as_array().unwrap().iter().find(|t| t["timing"] == "first" && t["n"] == 1).unwrap();
        assert!(first["avg_pct"].as_f64().unwrap() > 0.0);
        assert!(render(&r).contains("HEAD START"));
        let _ = fs::remove_dir_all(&dir);
    }
}
