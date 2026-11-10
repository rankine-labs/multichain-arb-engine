// ============================================================================
// REPORT: turn a probe run into the go/no-go numbers.
//
// Plain English, the two questions it answers:
//
//   1. VISIBILITY  "Of the Four.meme buys that actually happened, how many
//      did we see pending, and how early?"
//        coverage   = buys seen pending / all confirmed buys
//                     (by count, and by size bucket: are the BIG buys visible?)
//        lead time  = when the block arrived - when we first saw the tx
//        actionable = share of buys with lead time >= --min-lead-ms
//      Periods when a pending feed was disconnected are excluded for that
//      feed, so an outage can't make coverage look worse than it is.
//
//   2. FOLLOW-THROUGH  "If a token gets a burst of buying in one block and we
//      buy in the next block, does the price keep rising long enough for us
//      to sell at a profit?"
//        burst      = a block with >= --burst-buys buys from that many
//                     different wallets, more bought than sold, and the
//                     price up >= --min-rise-pct within the block
//        entry      = price of the last trade in the burst block
//        exit window= trades from 2 blocks later (we buy in the next block,
//                     sell at the earliest the block after) up to N blocks
//        reported   = best and worst price in the window vs entry, and how
//                     often the best clears --hurdle-pct
//      This ignores our own price impact and fees beyond the hurdle, so it is
//      an UPPER BOUND on what a real strategy could capture.
// ============================================================================
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub struct Opts {
    /// Lead time we need to act on a pending buy (detect + decide + reach a builder).
    pub min_lead_ms: f64,
    /// Ignore this long after each (re)connect: txs already pending when we
    /// connected are never announced to us.
    pub warmup_secs: f64,
    pub burst_buys: usize,
    /// The burst block must also lift the price by at least this much
    /// (filters out swarms of dust-sized bot buys that move nothing).
    pub min_rise_pct: f64,
    pub hurdle_pct: f64,
    pub windows: Vec<u64>,
}

impl Default for Opts {
    fn default() -> Self {
        Opts { min_lead_ms: 150.0, warmup_secs: 10.0, burst_buys: 3, min_rise_pct: 2.0, hurdle_pct: 3.0, windows: vec![3, 10, 30] }
    }
}

/// Read a JSONL file (missing file = empty).
fn read_jsonl(dir: &Path, name: &str) -> Vec<Value> {
    fs::read_to_string(dir.join(name))
        .map(|s| s.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
        .unwrap_or_default()
}

/// Nearest-rank percentile of an already sorted slice.
pub fn pct(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    Some(sorted[rank.clamp(1, sorted.len()) - 1])
}

fn dec(v: &Value) -> f64 {
    v.as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0)
}

/// Time windows (ns) during which a named source was connected, minus warm-up.
fn watch_windows(meta: &[Value], source: &str, warmup_ns: u64, end: u64) -> Vec<(u64, u64)> {
    let mut out = Vec::new();
    let mut up_at: Option<u64> = None;
    for m in meta {
        if m["source"].as_str() != Some(source) {
            continue;
        }
        let t = m["t"].as_u64().unwrap_or(0);
        match m["event"].as_str() {
            Some("up") if up_at.is_none() => up_at = Some(t),
            Some("down") => {
                if let Some(u) = up_at.take() {
                    if t > u + warmup_ns {
                        out.push((u + warmup_ns, t));
                    }
                }
            }
            _ => {}
        }
    }
    if let Some(u) = up_at {
        if end > u + warmup_ns {
            out.push((u + warmup_ns, end));
        }
    }
    out
}

fn inside(w: &[(u64, u64)], t: u64) -> bool {
    w.iter().any(|(a, b)| t >= *a && t <= *b)
}

fn summary(sorted: &[f64]) -> Value {
    json!({
        "n": sorted.len(),
        "p10": pct(sorted, 10.0), "p50": pct(sorted, 50.0), "p90": pct(sorted, 90.0),
        "p95": pct(sorted, 95.0), "p99": pct(sorted, 99.0),
    })
}

/// Size bucket label for a buy (quote units, usually BNB).
fn bucket(x: f64) -> &'static str {
    if x < 0.1 {
        "<0.1"
    } else if x < 1.0 {
        "0.1-1"
    } else if x < 5.0 {
        "1-5"
    } else {
        ">=5"
    }
}

pub fn build(dir: &Path, o: &Opts) -> Value {
    let meta = read_jsonl(dir, "meta.jsonl");
    let heads = read_jsonl(dir, "heads.jsonl");
    let trades: Vec<Value> = read_jsonl(dir, "trades.jsonl").into_iter().filter(|t| t["removed"] != json!(true)).collect();
    let late = read_jsonl(dir, "late.jsonl");
    let direct = read_jsonl(dir, "pending_direct.jsonl");

    let sources: Vec<String> = meta
        .iter()
        .find(|m| m["event"] == "start")
        .and_then(|m| m["sources"].as_array())
        .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let end = meta
        .iter()
        .chain(heads.iter())
        .chain(trades.iter())
        .filter_map(|v| v["t"].as_u64().or_else(|| v["t_log"].as_u64()))
        .max()
        .unwrap_or(0);
    let warm = (o.warmup_secs * 1e9) as u64;

    // Block arrival = earliest of: header arrival, first Four.meme log of it.
    let mut arrival: HashMap<u64, u64> = HashMap::new();
    for h in &heads {
        let (b, t) = (h["block"].as_u64().unwrap_or(0), h["t"].as_u64().unwrap_or(u64::MAX));
        let e = arrival.entry(b).or_insert(t);
        *e = (*e).min(t);
    }
    for tr in &trades {
        let (b, t) = (tr["block"].as_u64().unwrap_or(0), tr["t_log"].as_u64().unwrap_or(u64::MAX));
        let e = arrival.entry(b).or_insert(t);
        *e = (*e).min(t);
    }
    let block_arrival = |tr: &Value| arrival.get(&tr["block"].as_u64().unwrap_or(0)).copied().unwrap_or(0);

    // ---- 1. visibility, per source and for "any source" ----
    let mut windows: Vec<(String, Vec<(u64, u64)>)> = sources
        .iter()
        .map(|s| (s.clone(), watch_windows(&meta, &format!("pending:{s}"), warm, end)))
        .collect();
    // "any": watched by at least one source. First-seen = earliest across sources.
    let any_w: Vec<(u64, u64)> = windows.iter().flat_map(|(_, w)| w.clone()).collect();
    windows.push(("any".into(), any_w));

    let mut vis = serde_json::Map::new();
    for (name, w) in &windows {
        let mut stat = serde_json::Map::new();
        for side in ["buy", "sell"] {
            let mut total = 0u64;
            let mut seen = 0u64;
            let mut vol_total = 0.0;
            let mut vol_seen = 0.0;
            let mut leads: Vec<f64> = Vec::new();
            let mut by_bucket: BTreeMap<&str, (u64, u64)> = BTreeMap::new();
            for tr in trades.iter().filter(|t| t["kind"] == side) {
                let ba = block_arrival(tr);
                if !inside(w, ba) {
                    continue;
                }
                let size = (dec(&tr["cost"]) + dec(&tr["fee"])) / 1e18;
                let first = if name == "any" { tr["first_seen"].as_u64() } else { tr["seen"][name.as_str()].as_u64() };
                total += 1;
                vol_total += size;
                let b = by_bucket.entry(bucket(size)).or_default();
                b.0 += 1;
                if let Some(f) = first {
                    seen += 1;
                    vol_seen += size;
                    b.1 += 1;
                    leads.push((ba as f64 - f as f64) / 1e6);
                }
            }
            leads.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let actionable = leads.iter().filter(|l| **l >= o.min_lead_ms).count() as u64;
            let ratio = |a: u64, b: u64| if b > 0 { Some(100.0 * a as f64 / b as f64) } else { None };
            stat.insert(
                side.into(),
                json!({
                    "confirmed": total,
                    "seen_pending": seen,
                    "coverage_pct": ratio(seen, total),
                    "volume_coverage_pct": if vol_total > 0.0 { Some(100.0 * vol_seen / vol_total) } else { None },
                    "actionable": actionable,
                    "actionable_pct_of_all": ratio(actionable, total),
                    "lead_ms": summary(&leads),
                    "by_size": by_bucket.iter().map(|(k, (t, s))| (k.to_string(), json!({"confirmed": t, "seen": s, "coverage_pct": ratio(*s, *t)}))).collect::<serde_json::Map<_, _>>(),
                }),
            );
        }
        vis.insert(name.clone(), Value::Object(stat));
    }

    // Pending direct calls that never showed up as a trade (failed/dropped).
    let traded: HashSet<&str> = trades.iter().filter_map(|t| t["tx"].as_str()).collect();
    let ttl_ns = meta.iter().find(|m| m["event"] == "start").and_then(|m| m["ttl_secs"].as_u64()).unwrap_or(180) * 1_000_000_000;
    let direct_old: Vec<&Value> = direct.iter().filter(|d| d["t"].as_u64().unwrap_or(0) + ttl_ns < end).collect();
    let direct_never = direct_old.iter().filter(|d| !traded.contains(d["tx"].as_str().unwrap_or(""))).count();

    // ---- 2. follow-through after buying bursts ----
    // token -> block -> trades (sorted by log index)
    let mut by_token: HashMap<&str, BTreeMap<u64, Vec<&Value>>> = HashMap::new();
    for tr in &trades {
        by_token
            .entry(tr["token"].as_str().unwrap_or(""))
            .or_default()
            .entry(tr["block"].as_u64().unwrap_or(0))
            .or_default()
            .push(tr);
    }
    let mut follow = serde_json::Map::new();
    let max_n = *o.windows.iter().max().unwrap_or(&10);
    // Per window: (best gains, worst moves, count with any trade)
    let mut acc: BTreeMap<u64, (Vec<f64>, Vec<f64>, u64)> = o.windows.iter().map(|n| (*n, (vec![], vec![], 0))).collect();
    let mut bursts = 0u64;
    for blocks in by_token.values_mut() {
        for v in blocks.values_mut() {
            v.sort_by_key(|t| t["log_index"].as_u64().unwrap_or(0));
        }
        let keys: Vec<u64> = blocks.keys().copied().collect();
        let mut prev_price: Option<f64> = None;
        for &b in &keys {
            let txs = &blocks[&b];
            let buys: Vec<&&Value> = txs.iter().filter(|t| t["kind"] == "buy").collect();
            let buyers: HashSet<&str> = buys.iter().filter_map(|t| t["account"].as_str()).collect();
            let bought: f64 = buys.iter().map(|t| dec(&t["cost"])).sum();
            let sold: f64 = txs.iter().filter(|t| t["kind"] == "sell").map(|t| dec(&t["cost"])).sum();
            let entry = dec(&txs.last().unwrap()["price"]);
            // Price before this block: last trade of an earlier block, else
            // this block's first trade.
            let before = prev_price.unwrap_or_else(|| dec(&txs[0]["price"]));
            prev_price = Some(entry);
            if buys.len() < o.burst_buys || buyers.len() < o.burst_buys || bought <= sold {
                continue;
            }
            if entry <= 0.0 || before <= 0.0 || 100.0 * (entry / before - 1.0) < o.min_rise_pct {
                continue;
            }
            bursts += 1;
            for (&n, (best, worst, any)) in acc.iter_mut() {
                let later: Vec<f64> = blocks
                    .range(b + 2..=b + 1 + n.min(max_n))
                    .flat_map(|(_, v)| v.iter().map(|t| dec(&t["price"])))
                    .filter(|p| *p > 0.0)
                    .collect();
                if later.is_empty() {
                    continue;
                }
                *any += 1;
                let hi = later.iter().cloned().fold(f64::MIN, f64::max);
                let lo = later.iter().cloned().fold(f64::MAX, f64::min);
                best.push(100.0 * (hi / entry - 1.0));
                worst.push(100.0 * (lo / entry - 1.0));
            }
        }
    }
    for (n, (mut best, mut worst, any)) in acc {
        best.sort_by(|a, b| a.partial_cmp(b).unwrap());
        worst.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let clears = best.iter().filter(|g| **g >= o.hurdle_pct).count() as u64;
        follow.insert(
            format!("next_{n}_blocks"),
            json!({
                "bursts_with_later_trades": any,
                "pct_of_bursts_with_later_trades": if bursts > 0 { Some(100.0 * any as f64 / bursts as f64) } else { None },
                "best_gain_pct": summary(&best),
                "worst_move_pct": summary(&worst),
                "clears_hurdle": clears,
                "clears_hurdle_pct_of_bursts": if bursts > 0 { Some(100.0 * clears as f64 / bursts as f64) } else { None },
            }),
        );
    }

    json!({
        "run": {
            "duration_hours": end as f64 / 3.6e12,
            "sources": sources,
            "blocks_seen": heads.len(),
            "trades": trades.len(),
            "settings": {"min_lead_ms": o.min_lead_ms, "warmup_secs": o.warmup_secs, "burst_buys": o.burst_buys, "min_rise_pct": o.min_rise_pct, "hurdle_pct": o.hurdle_pct},
        },
        "visibility": vis,
        "late_pending_notices": late.len(),
        "pending_direct_calls": {"total_old_enough": direct_old.len(), "never_confirmed": direct_never},
        "follow_through": {"bursts": bursts, "windows": follow},
    })
}

fn f(v: &Value) -> String {
    v.as_f64().map(|x| format!("{x:.1}")).unwrap_or_else(|| "n/a".into())
}

/// Plain-English summary for the terminal.
pub fn render(r: &Value) -> String {
    let mut s = String::new();
    let run = &r["run"];
    s += &format!(
        "PROBE REPORT  ({} h, {} blocks, {} Four.meme trades)\n\n",
        f(&run["duration_hours"]),
        run["blocks_seen"],
        run["trades"]
    );
    s += "1. VISIBILITY OF BUYS (seen pending before the block arrived)\n";
    if let Some(vis) = r["visibility"].as_object() {
        for (name, st) in vis {
            let b = &st["buy"];
            s += &format!(
                "  {name:<8} coverage {}% of {} buys ({}% of volume) | lead p50 {} ms, p90 {} ms | actionable (>= {} ms): {}% of all buys\n",
                f(&b["coverage_pct"]),
                b["confirmed"],
                f(&b["volume_coverage_pct"]),
                f(&b["lead_ms"]["p50"]),
                f(&b["lead_ms"]["p90"]),
                run["settings"]["min_lead_ms"],
                f(&b["actionable_pct_of_all"]),
            );
            if let Some(bs) = b["by_size"].as_object() {
                let parts: Vec<String> = bs.iter().map(|(k, v)| format!("{k}: {}%", f(&v["coverage_pct"]))).collect();
                s += &format!("           by buy size: {}\n", parts.join(", "));
            }
        }
    }
    s += &format!(
        "  late notices (pending AFTER the trade confirmed): {}\n  pending direct Four.meme calls never confirmed: {} of {}\n\n",
        r["late_pending_notices"], r["pending_direct_calls"]["never_confirmed"], r["pending_direct_calls"]["total_old_enough"]
    );
    s += &format!(
        "2. FOLLOW-THROUGH AFTER BUYING BURSTS ({} bursts; upper bound, ignores our own impact)\n",
        r["follow_through"]["bursts"]
    );
    if let Some(w) = r["follow_through"]["windows"].as_object() {
        for (name, v) in w {
            s += &format!(
                "  {name:<15} later trades in {}% | best gain p50 {}%, p90 {}% | worst move p50 {}% | clears {}% hurdle: {}% of bursts\n",
                f(&v["pct_of_bursts_with_later_trades"]),
                f(&v["best_gain_pct"]["p50"]),
                f(&v["best_gain_pct"]["p90"]),
                f(&v["worst_move_pct"]["p50"]),
                run["settings"]["hurdle_pct"],
                f(&v["clears_hurdle_pct_of_bursts"]),
            );
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles() {
        let v = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];
        assert_eq!(pct(&v, 50.0), Some(5.0));
        assert_eq!(pct(&v, 90.0), Some(9.0));
        assert_eq!(pct(&v, 99.0), Some(10.0));
        assert_eq!(pct(&[], 50.0), None);
    }

    #[test]
    fn follow_through_measures_best_and_worst_after_burst() {
        let dir = std::env::temp_dir().join(format!("sniper-ft-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let tr = |block: u64, li: u64, kind: &str, acct: &str, price: &str| {
            json!({"kind": kind, "token": "0xt", "account": acct, "block": block, "log_index": li,
                   "price": price, "cost": "1000000000000000000", "fee": "0", "t_log": block * 1000,
                   "removed": false, "seen": {}, "first_seen": null}).to_string()
        };
        let lines = [
            // Burst: block 10, three different buyers, last price 100.
            tr(10, 0, "buy", "0xa", "90"),
            tr(10, 1, "buy", "0xb", "95"),
            tr(10, 2, "buy", "0xc", "100"),
            // Block 11 = our entry block: excluded from the exit window.
            tr(11, 0, "buy", "0xd", "200"),
            // Exit window trades.
            tr(12, 0, "buy", "0xe", "110"),
            tr(14, 0, "sell", "0xa", "90"),
            // Outside the 3-block window (12..=13 is b+2..=b+1+3 = 12..=14).
            tr(20, 0, "buy", "0xf", "500"),
            // Not a burst: 2 buys only.
            tr(30, 0, "buy", "0xa", "1"),
            tr(30, 1, "buy", "0xb", "1"),
        ];
        fs::write(dir.join("trades.jsonl"), lines.join("\n")).unwrap();
        let o = Opts { windows: vec![3], ..Default::default() };
        let r = build(&dir, &o);
        let ft = &r["follow_through"];
        assert_eq!(ft["bursts"], 1);
        let w = &ft["windows"]["next_3_blocks"];
        assert!((w["best_gain_pct"]["p50"].as_f64().unwrap() - 10.0).abs() < 1e-9);
        assert!((w["worst_move_pct"]["p50"].as_f64().unwrap() + 10.0).abs() < 1e-9);
        assert_eq!(w["clears_hurdle"], 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn watch_windows_apply_warmup_and_outages() {
        let s = 1_000_000_000u64;
        let meta = vec![
            json!({"event": "up", "source": "pending:a", "t": 0}),
            json!({"event": "down", "source": "pending:a", "t": 100 * s}),
            json!({"event": "up", "source": "pending:a", "t": 200 * s}),
        ];
        let w = watch_windows(&meta, "pending:a", 10 * s, 300 * s);
        assert_eq!(w, vec![(10 * s, 100 * s), (210 * s, 300 * s)]);
        assert!(!inside(&w, 150 * s));
        assert!(inside(&w, 250 * s));
    }
}
