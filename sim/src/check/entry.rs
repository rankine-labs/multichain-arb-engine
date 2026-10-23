// ============================================================================
// TRIGGER-ENTRY "ONE TRIP" (Oct 23): the candidate table and how candidates
// are picked for a trigger.
//
// Plain English:
//   Before, the bot asked the sidecar TWO things per feed transaction, one
//   after the other: "which of our pools does it move?" (trig_discover), then,
//   after building our candidate trades, "check these trades" (one `call`
//   per candidate). Live, ~1000x more time was spent WAITING between those
//   steps than working.
//
//   Now the bot keeps a CANDIDATE TABLE here, refreshed about once a second
//   (`trig_table`): for every pool it watches, the routes it could trade if
//   that pool moved (same pair on another exchange, both directions, start
//   coin we hold), each with the bot's ranking facts and our EXACT check
//   call, already built by the bot (same code the two-step path uses). So
//   ONE question (`trig_entry`, server.rs) does it all: discover the moved
//   pools, pick the candidates for them the same way the bot does, check
//   them on the replayed feed (with the calculated size, check/sizing.rs,
//   or the size ladder), and answer once.
//
//   Picking (must equal the bot's execution/trigEntry.ts enumerateRoutes +
//   rankRoutes, tested with one shared fixture by both sides):
//     1. walk the moved pools in the order discovery named them; for each,
//        its table rows in order; a route already seen (same buy > sell :
//        start coin) is skipped. Each new route gets the next number.
//        found = how many routes.
//     2. sort: routes from a coin we hold first, then the higher quick-price
//        score (no score = last), then the number (stable).
//     3. keep the best `limit`.
//     4. rows the bot could not build (`e` null) are dropped AFTER the cap
//        (they still used a place, like the bot's host skipping them).
//
//   STOP RULE: candidates are checked best-ranked first; the sidecar stops at
//   the first answer the bot would SEND (profit at some size >= the row's
//   `stop` units = the send minimum after gas, worked out by the bot, at or
//   above the confidence floor). The bot then reads the answers itself, with
//   its own code; if it disagrees it checks the rest the old way.
// ============================================================================
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock, RwLock};

use revm::primitives::U256;
use serde_json::{json, Value};

use super::hexutil::{parse_bytes, parse_u256};
use super::search::INSUFFICIENT_PROFIT_SELECTOR;

/// One route of one watched pool.
#[derive(Clone, Debug)]
pub struct Row {
    /// Route id "buy>sell:start" (lowercase), for skipping repeats.
    pub rid: String,
    /// A start coin we hold (ranked first).
    pub held: bool,
    /// The bot's quick price check (higher = better); None = unknown (last).
    pub score: Option<f64>,
    /// Entry id (the bot's name for this candidate); None = the bot could
    /// not build it (uses a place in the cap, then dropped).
    pub e: Option<String>,
    /// Our check: {calls, overrides, sizes, route, stop, amt}; None = the
    /// candidate has no check (no size fits): counted, nothing run.
    pub c: Option<Arc<Value>>,
}

/// The whole table.
#[derive(Default, Debug)]
pub struct Table {
    pub gen: u64,
    /// Long contract codes, sent once per table message; checks name them
    /// "$code:<n>" in their overrides.
    pub codes: Arc<Vec<String>>,
    pub pools: HashMap<String, Vec<Row>>,
}

fn store() -> &'static RwLock<Option<Table>> {
    static T: OnceLock<RwLock<Option<Table>>> = OnceLock::new();
    T.get_or_init(|| RwLock::new(None))
}

/// What a trigger needs from the table, copied out (so the table's lock is
/// never held while checks run): generation, codes, picked rows, routes found.
pub fn pick(moved: &[String], limit: usize) -> Option<(u64, Arc<Vec<String>>, Vec<Row>, usize)> {
    with_table(|t| {
        let t = t?;
        let (rows, found) = select(t, moved, limit);
        Some((t.gen, t.codes.clone(), rows.into_iter().cloned().collect(), found))
    })
}

/// Read access to the current table (None = none received yet).
pub fn with_table<R>(f: impl FnOnce(Option<&Table>) -> R) -> R {
    let g = store().read().unwrap_or_else(|e| e.into_inner());
    f(g.as_ref())
}

/// Forget the table (tests).
pub fn clear_table() {
    *store().write().unwrap_or_else(|e| e.into_inner()) = None;
}

pub fn parse_rows(v: &Value) -> Result<Vec<Row>, String> {
    let arr = v.as_array().ok_or("pool rows must be a list")?;
    arr.iter()
        .map(|r| {
            Ok(Row {
                rid: r.get("rid").and_then(|x| x.as_str()).ok_or("row without rid")?.to_ascii_lowercase(),
                held: r.get("h").and_then(|x| x.as_bool()).unwrap_or(false),
                score: r.get("s").and_then(|x| x.as_f64()).filter(|x| x.is_finite()),
                e: r.get("e").and_then(|x| x.as_str()).map(|s| s.to_string()),
                c: r.get("c").filter(|c| c.is_object()).map(|c| Arc::new(c.clone())),
            })
        })
        .collect()
}

/// `{"type":"trig_table","gen":N,"full":true|false,"base":M,"codes":[..],
///   "pools":{"<key>":[rows] | null}}`. full = replace everything; else
/// merge into the table of generation `base` (a different one = refused:
/// the bot then sends a full table). Answer {ok, gen, pools}.
pub fn apply_table(id: &Value, req: &Value) -> Value {
    let gen = req.get("gen").and_then(|g| g.as_u64()).unwrap_or(0);
    let full = req.get("full").and_then(|f| f.as_bool()).unwrap_or(true);
    let Some(pools) = req.get("pools").and_then(|p| p.as_object()) else {
        return json!({ "id": id, "ok": false, "unknown": "bad_request", "detail": "trig_table needs pools" });
    };
    let mut parsed: Vec<(String, Option<Vec<Row>>)> = Vec::with_capacity(pools.len());
    for (k, v) in pools {
        if v.is_null() {
            parsed.push((k.to_ascii_lowercase(), None));
            continue;
        }
        match parse_rows(v) {
            Ok(r) => parsed.push((k.to_ascii_lowercase(), Some(r))),
            Err(e) => return json!({ "id": id, "ok": false, "unknown": "bad_request", "detail": format!("pool {k}: {e}") }),
        }
    }
    let codes: Vec<String> = req.get("codes").and_then(|c| c.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
    let mut g = store().write().unwrap_or_else(|e| e.into_inner());
    if !full {
        let base = req.get("base").and_then(|b| b.as_u64());
        if g.as_ref().map(|t| t.gen) != base {
            return json!({ "id": id, "ok": false, "unknown": "table_gen", "detail": "partial table for a generation we don't hold: send a full one" });
        }
    }
    let t = if full { g.insert(Table::default()) } else { g.as_mut().expect("checked above") };
    t.gen = gen;
    if !codes.is_empty() || full {
        t.codes = Arc::new(codes);
    }
    for (k, rows) in parsed {
        match rows {
            Some(r) => {
                t.pools.insert(k, r);
            }
            None => {
                t.pools.remove(&k);
            }
        }
    }
    json!({ "id": id, "ok": true, "gen": t.gen, "pools": t.pools.len() })
}

/// PICKING (see the file header). Returns the picked rows (best first, only
/// buildable ones) and how many routes were found before the cap.
pub fn select<'a>(t: &'a Table, moved: &[String], limit: usize) -> (Vec<&'a Row>, usize) {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut list: Vec<(usize, &Row)> = Vec::new();
    for k in moved {
        let Some(rows) = t.pools.get(&k.to_ascii_lowercase()) else { continue };
        for r in rows {
            if seen.insert(r.rid.as_str()) {
                list.push((list.len(), r));
            }
        }
    }
    let found = list.len();
    // held first; then higher score (None = lowest); then the number.
    list.sort_by(|(ia, a), (ib, b)| {
        (!a.held)
            .cmp(&!b.held)
            .then_with(|| b.score.unwrap_or(f64::NEG_INFINITY).total_cmp(&a.score.unwrap_or(f64::NEG_INFINITY)))
            .then_with(|| ia.cmp(ib))
    });
    let picked = list.into_iter().take(limit).map(|(_, r)| r).filter(|r| r.e.is_some()).collect();
    (picked, found)
}

/// The check request for one picked row: the row's check with "$code:<n>"
/// put back, plus the request basics and the feed (with this route).
pub fn call_for(codes: &[String], c: &Value, id: &Value, at: &Value, feed: &Value, prio: bool) -> Value {
    let mut call = json!({ "id": id, "type": "call", "at": at, "prio": prio });
    call["calls"] = c.get("calls").cloned().unwrap_or(Value::Array(vec![]));
    if let Some(s) = c.get("sizes").filter(|s| !s.is_null()) {
        call["sizes"] = s.clone();
    }
    let mut ov = c.get("overrides").cloned().unwrap_or_else(|| json!({}));
    if let Some(o) = ov.as_object_mut() {
        for (_, acct) in o.iter_mut() {
            if let Some(code) = acct.get("code").and_then(|x| x.as_str()).and_then(|s| s.strip_prefix("$code:")).and_then(|n| n.parse::<usize>().ok()) {
                acct["code"] = json!(codes.get(code).cloned().unwrap_or_default());
            }
        }
    }
    call["overrides"] = ov;
    let mut f = feed.clone();
    f["route"] = c.get("route").cloned().unwrap_or(Value::Array(vec![]));
    call["feed"] = f;
    call
}

const CONF: [&str; 3] = ["low", "medium", "high"];
fn conf_rank(c: &str) -> usize {
    CONF.iter().position(|x| *x == c).unwrap_or(2)
}

/// STOP RULE: would the bot send on this answer? A sure answer at or above
/// `min_conf` with a profit (main size, a calculated size, or a ladder size
/// when no size was calculated) of at least `stop` units and not more than
/// the size itself.
pub fn good_enough(answer: &Value, c: &Value, min_conf: &str) -> bool {
    if answer.get("ok") != Some(&Value::Bool(true)) {
        return false;
    }
    let conf = answer.get("trig").and_then(|t| t.get("conf")).and_then(|x| x.as_str()).unwrap_or("high");
    if conf_rank(conf) < conf_rank(min_conf) {
        return false;
    }
    let Some(stop) = c.get("stop").and_then(|s| s.as_str()).and_then(|s| parse_u256(s).ok()) else { return false };
    if stop.is_zero() {
        return false;
    }
    let ok_row = |amount: U256, profit: U256| !profit.is_zero() && profit >= stop && profit <= amount;
    // Main size: our contract refuses with InsufficientProfit(profit, min).
    if let (Some(r), Some(amt)) = (answer.get("results").and_then(|r| r.get(0)), c.get("amt").and_then(|a| a.as_str()).and_then(|a| parse_u256(a).ok())) {
        let failed = r.get("success") == Some(&Value::Bool(false)) && r.get("halt").is_none_or(|h| h.is_null());
        if failed {
            if let Some(out) = r.get("output").and_then(|o| o.as_str()).and_then(|o| parse_bytes(o).ok()) {
                if out.len() == 68 && out[..4] == INSUFFICIENT_PROFIT_SELECTOR && ok_row(amt, U256::from_be_slice(&out[4..36])) {
                    return true;
                }
            }
        }
    }
    // Extra sizes. With a calculated size (calc.how not "failed") the bot
    // picks only the main size and the calculated rows (src calc / backup);
    // ladder rows there are for comparison only. Otherwise the ladder rows.
    let calc_ok = answer.get("calc").and_then(|c| c.get("how")).and_then(|h| h.as_str()).is_some_and(|h| h != "failed");
    answer.get("sizes").and_then(|s| s.as_array()).is_some_and(|rows| {
        rows.iter().filter(|row| !calc_ok || row.get("src").is_some()).any(|row| {
            row.get("status").and_then(|s| s.as_str()) == Some("profit")
                && match (row.get("amount").and_then(|a| a.as_str()).and_then(|a| parse_u256(a).ok()), row.get("profit").and_then(|p| p.as_str()).and_then(|p| parse_u256(p).ok())) {
                    (Some(a), Some(p)) => ok_row(a, p),
                    _ => false,
                }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(rid: &str, held: bool, s: Option<f64>, e: Option<&str>) -> Row {
        Row { rid: rid.into(), held, score: s, e: e.map(|x| x.into()), c: None }
    }

    #[test]
    fn select_dedups_ranks_caps_then_drops_unbuildable() {
        let mut t = Table::default();
        t.pools.insert("a".into(), vec![row("a>b:u", true, Some(1.0), Some("e1")), row("b>a:u", true, Some(3.0), Some("e2")), row("a>c:w", false, Some(9.0), Some("e3"))]);
        // b repeats route a>b:u (skipped), adds one unbuildable and one without score.
        t.pools.insert("b".into(), vec![row("a>b:u", true, Some(1.0), Some("x")), row("b>d:u", true, None, Some("e4")), row("d>b:u", true, Some(2.0), None)]);
        let (p, found) = select(&t, &["a".into(), "b".into()], 4);
        assert_eq!(found, 5);
        // held: e2 (3), [unbuildable] (2), e1 (1), e4 (none); e3 not held (last, beyond cap).
        assert_eq!(p.iter().map(|r| r.e.clone().unwrap()).collect::<Vec<_>>(), vec!["e2", "e1", "e4"]);
        // Order of moved pools decides ties.
        let mut t2 = Table::default();
        t2.pools.insert("a".into(), vec![row("1", true, None, Some("p"))]);
        t2.pools.insert("b".into(), vec![row("2", true, None, Some("q"))]);
        let (p, _) = select(&t2, &["b".into(), "a".into()], 6);
        assert_eq!(p.iter().map(|r| r.e.clone().unwrap()).collect::<Vec<_>>(), vec!["q", "p"]);
    }

    #[test]
    fn good_enough_reads_main_and_ladder() {
        let mut out = vec![0u8; 68];
        out[..4].copy_from_slice(&INSUFFICIENT_PROFIT_SELECTOR);
        out[35] = 50; // profit 50
        let hex = |b: &[u8]| format!("0x{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>());
        let a = json!({"ok": true, "trig": {"conf": "medium"}, "results": [{"success": false, "output": hex(&out), "gasUsed": "0x1"}]});
        let c = |stop: &str| json!({"stop": stop, "amt": "0x3e8"});
        assert!(good_enough(&a, &c("0x32"), "medium"));
        assert!(!good_enough(&a, &c("0x33"), "medium"), "below the stop");
        assert!(!good_enough(&a, &c("0x32"), "high"), "confidence floor");
        let lad = json!({"ok": true, "results": [{"success": false, "output": "0x", "gasUsed": "0x1"}], "sizes": [{"amount": "0x64", "status": "profit", "profit": "0x40"}]});
        assert!(good_enough(&lad, &c("0x32"), "medium"));
        let silly = json!({"ok": true, "results": [], "sizes": [{"amount": "0x10", "status": "profit", "profit": "0x40"}]});
        assert!(!good_enough(&silly, &c("0x32"), "medium"), "profit above the size is bad data");
        // Calculated size: only its rows count (the ladder ran for comparison).
        let cmp = json!({"ok": true, "results": [], "calc": {"how": "fit"}, "sizes": [{"amount": "0x64", "status": "profit", "profit": "0x40"}, {"amount": "0x50", "status": "profit", "profit": "0x20", "src": "calc"}]});
        assert!(!good_enough(&cmp, &c("0x32"), "medium"), "a ladder row doesn't count when a size was calculated");
        assert!(good_enough(&cmp, &c("0x20"), "medium"), "the calculated row counts");
        let failed = json!({"ok": true, "results": [], "calc": {"how": "failed"}, "sizes": [{"amount": "0x64", "status": "profit", "profit": "0x40"}]});
        assert!(good_enough(&failed, &c("0x32"), "medium"), "calculation failed: the ladder decides");
    }
}
