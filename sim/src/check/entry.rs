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
//   them on the replayed feed (with the size ladder), and answer once.
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
    /// (Fast lane, Oct 26) The bot's facts for valuing a result in USD:
    /// {l: label, px: start coin USD, d: decimals, g: gas USD, lp: loan
    /// pips}. Sent only when FASTLANE is on; read only by fastlane/scan.rs.
    /// Never used by trigger picking or checks.
    pub f: Option<Arc<Value>>,
}

/// The whole table.
#[derive(Default, Debug)]
pub struct Table {
    pub gen: u64,
    /// Long contract codes, sent once per table message; checks name them
    /// "$code:<n>" in their overrides.
    pub codes: Arc<Vec<String>>,
    pub pools: HashMap<String, Vec<Row>>,
    /// SPEED FIX (Oct 28): the generation at which each pool's rows were
    /// last replaced, pools removed since the last full table (pool -> the
    /// generation it went), and the generation of the last FULL table. The
    /// fast-lane scanner (fastlane/scan.rs TableSource) uses them to bring
    /// its route list up to date by touching only the pools that changed,
    /// instead of re-copying every row (~38,700) on every table message
    /// (measured live: ~30 ms per block). Bookkeeping only: picking and
    /// checks never read these.
    pub pool_gen: HashMap<String, u64>,
    pub removed: HashMap<String, u64>,
    pub full_gen: u64,
    /// True only for tables built from `trig_table` messages (every change
    /// goes through `set_pool`, so the bookkeeping above is complete). A
    /// table filled by hand (tests) is false: readers then always copy it all.
    pub tracked: bool,
}

/// Most removed-pool records kept between full tables; past it the table
/// says "full" so readers copy everything once (memory bound).
const MAX_REMOVED: usize = 50_000;

impl Table {
    /// One pool's rows replaced (Some) or removed (None) at generation `gen`.
    pub fn set_pool(&mut self, key: String, rows: Option<Vec<Row>>, gen: u64) {
        match rows {
            Some(r) => {
                self.removed.remove(&key);
                self.pool_gen.insert(key.clone(), gen);
                self.pools.insert(key, r);
            }
            None => {
                self.pools.remove(&key);
                self.pool_gen.remove(&key);
                self.removed.insert(key, gen);
                if self.removed.len() > MAX_REMOVED {
                    self.removed.clear();
                    self.full_gen = gen;
                }
            }
        }
    }
}

fn store() -> &'static RwLock<Option<Table>> {
    static T: OnceLock<RwLock<Option<Table>>> = OnceLock::new();
    T.get_or_init(|| RwLock::new(None))
}

// ---------------------------------------------------------------------------
// ZERO-ROUTES FIX (Oct 27): what the table looks like, visible in status.
//
// Plain English: live, the Rust scanner said "0 routes" and nothing showed
// whether a table had ever arrived. Every `trig_table` message is now
// counted here (taken / refused and why), with the rows it holds: rows the
// scanner and the fast-lane trigger can use (an entry id AND a check), rows
// with the bot's price facts, and the size of the last message. Status
// "trigTable" (server.rs). Counting only: nothing decides on these numbers.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct TableStats {
    taken: u64,
    refused: u64,
    last_refused: Option<String>,
    last_bytes: u64,
    last_at: Option<std::time::Instant>,
    full: u64,
    partial: u64,
}

fn stats() -> &'static std::sync::Mutex<TableStats> {
    static S: OnceLock<std::sync::Mutex<TableStats>> = OnceLock::new();
    S.get_or_init(|| std::sync::Mutex::new(TableStats::default()))
}

/// The socket reader saw a table message of `bytes` bytes (server.rs).
pub fn note_table_bytes(bytes: u64) {
    stats().lock().unwrap_or_else(|e| e.into_inner()).last_bytes = bytes;
}

/// Status "trigTable": did a table arrive, how many rows can be used.
pub fn status_json() -> Value {
    let (pools, rows, usable, facts, gen) = with_table(|t| match t {
        None => (0usize, 0usize, 0usize, 0usize, None),
        Some(t) => {
            let rows: usize = t.pools.values().map(|r| r.len()).sum();
            let usable = t.pools.values().flatten().filter(|r| r.e.is_some() && r.c.is_some()).count();
            let facts = t.pools.values().flatten().filter(|r| r.e.is_some() && r.c.is_some() && r.f.is_some()).count();
            (t.pools.len(), rows, usable, facts, Some(t.gen))
        }
    });
    let s = stats().lock().unwrap_or_else(|e| e.into_inner());
    json!({
        "held": gen.is_some(), "gen": gen, "pools": pools, "rows": rows, "usableRows": usable, "factRows": facts,
        "taken": s.taken, "full": s.full, "partial": s.partial, "refused": s.refused, "lastRefused": s.last_refused,
        "lastBytes": s.last_bytes, "lastAgoMs": s.last_at.map(|a| a.elapsed().as_millis() as u64),
    })
}

fn note_result(ok: bool, full: bool, why: Option<&str>) {
    let mut s = stats().lock().unwrap_or_else(|e| e.into_inner());
    if ok {
        s.taken += 1;
        if full {
            s.full += 1;
        } else {
            s.partial += 1;
        }
        s.last_at = Some(std::time::Instant::now());
    } else {
        s.refused += 1;
        s.last_refused = why.map(|w| w.chars().take(120).collect());
    }
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

/// (Fast lane, practice fixes Oct 27) Every pool key the table's usable
/// routes depend on (each row's check "route": its pools and lender),
/// lowercase, with the table's generation. None = no table yet. The
/// predicted copy runs only transactions that can move these (copy2/ahead.rs
/// FASTLANE_AHEAD_ROUTES_ONLY). Rows the bot could not build (no entry id or
/// no check) are left out: the scanner never checks them either.
pub fn route_keys() -> Option<(u64, HashSet<String>)> {
    with_table(|t| {
        let t = t?;
        let mut keys: HashSet<String> = HashSet::new();
        for rows in t.pools.values() {
            for r in rows {
                let (Some(_), Some(c)) = (&r.e, &r.c) else { continue };
                for k in c.get("route").and_then(|x| x.as_array()).into_iter().flatten() {
                    if let Some(k) = k.as_str() {
                        keys.insert(k.to_ascii_lowercase());
                    }
                }
            }
        }
        Some((t.gen, keys))
    })
}

/// The table's generation only (cheap; None = no table yet).
pub fn table_gen() -> Option<u64> {
    with_table(|t| t.map(|t| t.gen))
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
                f: r.get("f").filter(|f| f.is_object()).map(|f| Arc::new(f.clone())),
            })
        })
        .collect()
}

/// `{"type":"trig_table","gen":N,"full":true|false,"base":M,"codes":[..],
///   "pools":{"<key>":[rows] | null | {patch}}}`. full = replace everything;
/// else merge into the table of generation `base` (a different one =
/// refused: the bot then sends a full table). Answer {ok, gen, pools, patch}.
///
/// TRUE DELTA (Nov 1): a pool's value may also be a PATCH object
/// `{"r":[rows], "s":{"<rid>": score | null}}` (partial tables only):
/// `r` = whole rows that replace the rows with the same route id (same
/// place in the list), `s` = new quick-price scores for routes by id (the
/// rest of each row stays). Every route named must already be in that
/// pool, else the whole message is refused and nothing changes (the bot
/// then sends a full table). The answer says `"patch": true` so the bot
/// knows this arbsim understands patches; an older arbsim refuses a patch
/// ("pool rows must be a list"), which also ends in a full table.
pub fn apply_table(id: &Value, req: &Value) -> Value {
    let a = apply_table_inner(id, req);
    let full = req.get("full").and_then(|f| f.as_bool()).unwrap_or(true);
    let ok = a.get("ok") == Some(&Value::Bool(true));
    note_result(ok, full, a.get("detail").and_then(|d| d.as_str()));
    a
}

/// One pool's change in a table message.
enum PoolChange {
    Remove,
    Replace(Vec<Row>),
    /// TRUE DELTA: rows replaced by route id, scores set by route id.
    Patch { rows: Vec<Row>, scores: Vec<(String, Option<f64>)> },
}

/// A pool's value in a table message: null, a list of rows, or a patch.
fn parse_change(v: &Value) -> Result<PoolChange, String> {
    if v.is_null() {
        return Ok(PoolChange::Remove);
    }
    if v.is_array() {
        return parse_rows(v).map(PoolChange::Replace);
    }
    let Some(o) = v.as_object() else { return Err("pool rows must be a list".into()) };
    let rows = match o.get("r") {
        None | Some(Value::Null) => Vec::new(),
        Some(r) => parse_rows(r)?,
    };
    let mut scores = Vec::new();
    if let Some(s) = o.get("s").filter(|s| !s.is_null()) {
        let m = s.as_object().ok_or("patch scores must be an object")?;
        for (rid, x) in m {
            if !(x.is_null() || x.is_number()) {
                return Err(format!("patch score for {rid} must be a number or null"));
            }
            scores.push((rid.to_ascii_lowercase(), x.as_f64().filter(|x| x.is_finite())));
        }
    }
    Ok(PoolChange::Patch { rows, scores })
}

/// A pool's rows after a patch (a new list; the held one is not touched).
/// Err = a route the pool does not hold (the message is then refused).
fn patched(old: &[Row], rows: Vec<Row>, scores: &[(String, Option<f64>)]) -> Result<Vec<Row>, String> {
    let mut out = old.to_vec();
    let mut at: HashMap<&str, usize> = HashMap::with_capacity(old.len());
    for (i, r) in old.iter().enumerate() {
        at.entry(r.rid.as_str()).or_insert(i);
    }
    let mut put: Vec<(usize, Row)> = Vec::with_capacity(rows.len());
    for r in rows {
        let Some(&i) = at.get(r.rid.as_str()) else { return Err(format!("patch names route {} the pool does not hold", r.rid)) };
        put.push((i, r));
    }
    for (rid, s) in scores {
        let Some(&i) = at.get(rid.as_str()) else { return Err(format!("patch names route {rid} the pool does not hold")) };
        out[i].score = *s;
    }
    // (Whole rows after scores: a row sent whole carries its own score.)
    for (i, r) in put {
        out[i] = r;
    }
    Ok(out)
}

/// Every pool change of one message, worked out against `t` (the table
/// held, None for a full table) BEFORE anything is changed, so a refused
/// message leaves the table exactly as it was.
fn resolve(t: Option<&Table>, parsed: Vec<(String, PoolChange)>) -> Result<Vec<(String, Option<Vec<Row>>)>, String> {
    let mut out = Vec::with_capacity(parsed.len());
    for (k, ch) in parsed {
        match ch {
            PoolChange::Remove => out.push((k, None)),
            PoolChange::Replace(r) => out.push((k, Some(r))),
            PoolChange::Patch { rows, scores } => {
                // (A pool named twice in one message: patch the newer list.)
                let held = out.iter().rev().find(|(key, _)| *key == k).map(|(_, r)| r.clone());
                let base: Vec<Row> = match held {
                    Some(Some(r)) => r,
                    Some(None) => return Err(format!("patch for pool {k} removed in the same message")),
                    None => match t.and_then(|t| t.pools.get(&k)) {
                        Some(r) => r.clone(),
                        None => return Err(format!("patch for pool {k} we don't hold")),
                    },
                };
                out.push((k, Some(patched(&base, rows, &scores)?)));
            }
        }
    }
    Ok(out)
}

fn apply_table_inner(id: &Value, req: &Value) -> Value {
    let gen = req.get("gen").and_then(|g| g.as_u64()).unwrap_or(0);
    let full = req.get("full").and_then(|f| f.as_bool()).unwrap_or(true);
    let Some(pools) = req.get("pools").and_then(|p| p.as_object()) else {
        return json!({ "id": id, "ok": false, "unknown": "bad_request", "detail": "trig_table needs pools" });
    };
    let mut parsed: Vec<(String, PoolChange)> = Vec::with_capacity(pools.len());
    for (k, v) in pools {
        match parse_change(v) {
            Ok(PoolChange::Patch { .. }) if full => return json!({ "id": id, "ok": false, "unknown": "bad_request", "detail": format!("pool {k}: a patch in a full table") }),
            Ok(ch) => parsed.push((k.to_ascii_lowercase(), ch)),
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
    // Patches are checked against the table held before anything changes.
    let changes = match resolve(if full { None } else { g.as_ref() }, parsed) {
        Ok(c) => c,
        Err(e) => return json!({ "id": id, "ok": false, "unknown": "patch_miss", "detail": e }),
    };
    let t = if full { g.insert(Table::default()) } else { g.as_mut().expect("checked above") };
    t.gen = gen;
    t.tracked = true;
    if full {
        t.full_gen = gen;
    }
    if !codes.is_empty() || full {
        t.codes = Arc::new(codes);
    }
    for (k, rows) in changes {
        t.set_pool(k, rows, gen);
    }
    json!({ "id": id, "ok": true, "gen": t.gen, "pools": t.pools.len(), "patch": true })
}

/// The table held right now as ONE full `trig_table` message (None = no
/// table). Fast lane capture (copy2/ahead_capture.rs) writes it next to a
/// capture so `arbsim trig-replay` can pick and check candidates offline.
pub fn table_message() -> Option<Value> {
    with_table(|t| {
        let t = t?;
        let row = |r: &Row| json!({ "rid": r.rid, "h": r.held, "s": r.score, "e": r.e, "c": r.c.as_deref(), "f": r.f.as_deref() });
        let pools: serde_json::Map<String, Value> = t.pools.iter().map(|(k, rows)| (k.clone(), Value::Array(rows.iter().map(row).collect()))).collect();
        Some(json!({ "type": "trig_table", "gen": t.gen, "full": true, "codes": &*t.codes, "pools": pools }))
    })
}

/// A table built from `trig_table` messages in order (a full one first,
/// then parts), without touching the process-wide one (offline replay).
pub fn table_from_messages(msgs: &[Value]) -> Result<Table, String> {
    let mut t: Option<Table> = None;
    for (i, m) in msgs.iter().enumerate() {
        let full = m.get("full").and_then(|f| f.as_bool()).unwrap_or(true);
        let pools = m.get("pools").and_then(|p| p.as_object()).ok_or(format!("message {i}: no pools"))?;
        if full || t.is_none() {
            t = Some(Table::default());
        }
        let tb = t.as_mut().expect("set above");
        tb.gen = m.get("gen").and_then(|g| g.as_u64()).unwrap_or(0);
        tb.tracked = true;
        if full {
            tb.full_gen = tb.gen;
        }
        let codes: Vec<String> = m.get("codes").and_then(|c| c.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
        if !codes.is_empty() || full {
            tb.codes = Arc::new(codes);
        }
        let g = tb.gen;
        // (TRUE DELTA patches are applied exactly as apply_table does.)
        let mut parsed = Vec::with_capacity(pools.len());
        for (k, v) in pools {
            parsed.push((k.to_ascii_lowercase(), parse_change(v).map_err(|e| format!("message {i} pool {k}: {e}"))?));
        }
        for (k, rows) in resolve(Some(&*tb), parsed).map_err(|e| format!("message {i}: {e}"))? {
            tb.set_pool(k, rows, g);
        }
    }
    t.ok_or_else(|| "no table message".to_string())
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
/// `min_conf` with a profit (main size or a ladder size) of at least `stop`
/// units and not more than the size itself.
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
    // Ladder sizes.
    answer.get("sizes").and_then(|s| s.as_array()).is_some_and(|rows| {
        rows.iter().any(|row| {
            row.get("status").and_then(|s| s.as_str()) == Some("profit")
                && match (row.get("amount").and_then(|a| a.as_str()).and_then(|a| parse_u256(a).ok()), row.get("profit").and_then(|p| p.as_str()).and_then(|p| parse_u256(p).ok())) {
                    (Some(a), Some(p)) => ok_row(a, p),
                    _ => false,
                }
        })
    })
}

/// FAST LANE TRIGGER (fastlane/trigger.rs): the best size of an answer the
/// stop rule accepted, read with EXACTLY good_enough's rules (main size from
/// the contract's InsufficientProfit(profit, min) refusal, ladder sizes from
/// "profit" rows; profit > 0 and not above the size). Returns (amount,
/// profit, gas used) of the biggest profit (same coin, same gas estimate:
/// the biggest profit is the best net), None = no profitable size.
pub fn best_profit(answer: &Value, c: &Value) -> Option<(U256, U256, u64)> {
    if answer.get("ok") != Some(&Value::Bool(true)) {
        return None;
    }
    let ok_row = |amount: U256, profit: U256| !profit.is_zero() && profit <= amount;
    let gas_of = |v: Option<&Value>| v.and_then(|g| g.as_str()).and_then(|g| parse_u256(g).ok()).map(|g| g.saturating_to::<u64>()).unwrap_or(0);
    let mut best: Option<(U256, U256, u64)> = None;
    let mut take = |a: U256, p: U256, g: u64| {
        if ok_row(a, p) && best.as_ref().is_none_or(|b| p > b.1) {
            best = Some((a, p, g));
        }
    };
    if let (Some(r), Some(amt)) = (answer.get("results").and_then(|r| r.get(0)), c.get("amt").and_then(|a| a.as_str()).and_then(|a| parse_u256(a).ok())) {
        let failed = r.get("success") == Some(&Value::Bool(false)) && r.get("halt").is_none_or(|h| h.is_null());
        if failed {
            if let Some(out) = r.get("output").and_then(|o| o.as_str()).and_then(|o| parse_bytes(o).ok()) {
                if out.len() == 68 && out[..4] == INSUFFICIENT_PROFIT_SELECTOR {
                    take(amt, U256::from_be_slice(&out[4..36]), gas_of(r.get("gasUsed")));
                }
            }
        }
    }
    for row in answer.get("sizes").and_then(|s| s.as_array()).into_iter().flatten() {
        if row.get("status").and_then(|s| s.as_str()) != Some("profit") {
            continue;
        }
        if let (Some(a), Some(p)) = (row.get("amount").and_then(|a| a.as_str()).and_then(|a| parse_u256(a).ok()), row.get("profit").and_then(|p| p.as_str()).and_then(|p| parse_u256(p).ok())) {
            take(a, p, gas_of(row.get("gasUsed")));
        }
    }
    best
}

/// The answer's confidence ("high" when it says none, like good_enough).
pub fn answer_conf(answer: &Value) -> &str {
    answer.get("trig").and_then(|t| t.get("conf")).and_then(|x| x.as_str()).unwrap_or("high")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Tests that use the process-wide table take this first.
    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn best_profit_reads_like_the_stop_rule() {
        let mut out = vec![0u8; 68];
        out[..4].copy_from_slice(&INSUFFICIENT_PROFIT_SELECTOR);
        out[35] = 50; // main size profit 50
        let hex = |b: &[u8]| format!("0x{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>());
        let c = json!({"stop": "0x32", "amt": "0x3e8"});
        let a = json!({"ok": true, "results": [{"success": false, "output": hex(&out), "gasUsed": "0x10"}],
            "sizes": [{"amount": "0x64", "status": "profit", "profit": "0x40", "gasUsed": "0x20"}, {"amount": "0x10", "status": "profit", "profit": "0x40"}, {"amount": "0x200", "status": "loss", "profit": "0x0"}]});
        // 0x40 (64) at 100 beats 50 at 1000; the row with profit above its size is bad data.
        assert_eq!(best_profit(&a, &c), Some((U256::from(100u64), U256::from(64u64), 32)));
        assert!(good_enough(&a, &c, "medium"));
        assert_eq!(best_profit(&json!({"ok": false}), &c), None);
        let only_main = json!({"ok": true, "results": [{"success": false, "output": hex(&out), "gasUsed": "0x10"}]});
        assert_eq!(best_profit(&only_main, &c), Some((U256::from(1000u64), U256::from(50u64), 16)));
        assert_eq!(answer_conf(&json!({"trig": {"conf": "low"}})), "low");
        assert_eq!(answer_conf(&json!({})), "high");
    }

    fn row(rid: &str, held: bool, s: Option<f64>, e: Option<&str>) -> Row {
        Row { rid: rid.into(), held, score: s, e: e.map(|x| x.into()), c: None, f: None }
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

    // TRUE DELTA (Nov 1): patches replace rows / scores by route id, keep
    // the rest of the pool (same order), and a patch naming a route the pool
    // does not hold refuses the whole message without changing anything.
    #[test]
    fn patches_replace_by_route_id_and_refuse_unknown_routes() {
        let rows = |v: Vec<(&str, f64, &str)>| Value::Array(v.into_iter().map(|(rid, s, e)| json!({"rid": rid, "h": true, "s": s, "e": e, "c": {"stop": "0x1"}})).collect());
        let full = json!({"type": "trig_table", "gen": 1, "full": true, "codes": [], "pools": {"p": rows(vec![("a", 1.0, "1.1"), ("b", 2.0, "1.2"), ("c", 3.0, "1.3")]), "q": rows(vec![("x", 9.0, "1.4")])}});
        // Scores for a and c, row b replaced whole (new entry id, new check).
        let part = json!({"type": "trig_table", "gen": 2, "full": false, "base": 1, "codes": [], "pools": {"p": {"s": {"A": 5.0, "c": null}, "r": [{"rid": "b", "h": false, "s": 7.0, "e": "2.9", "c": {"stop": "0x2"}}]}}});
        let t = table_from_messages(&[full.clone(), part.clone()]).unwrap();
        let p = &t.pools["p"];
        assert_eq!(p.iter().map(|r| (r.rid.as_str(), r.score, r.e.as_deref(), r.held)).collect::<Vec<_>>(),
            vec![("a", Some(5.0), Some("1.1"), true), ("b", Some(7.0), Some("2.9"), false), ("c", None, Some("1.3"), true)]);
        assert_eq!(p[1].c.as_deref().unwrap()["stop"], "0x2");
        assert_eq!(p[0].c.as_deref().unwrap()["stop"], "0x1", "a score patch keeps the rest of the row");
        assert_eq!(t.pools["q"].len(), 1, "pools not named are untouched");
        assert_eq!(t.pool_gen["p"], 2, "a patched pool counts as changed (fast-lane scanner bookkeeping)");
        // Same result as sending the pool whole.
        let whole = json!({"type": "trig_table", "gen": 2, "full": false, "base": 1, "codes": [], "pools": {"p": [
            {"rid": "a", "h": true, "s": 5.0, "e": "1.1", "c": {"stop": "0x1"}}, {"rid": "b", "h": false, "s": 7.0, "e": "2.9", "c": {"stop": "0x2"}}, {"rid": "c", "h": true, "s": null, "e": "1.3", "c": {"stop": "0x1"}}]}});
        let w = table_from_messages(&[full.clone(), whole]).unwrap();
        let view = |rs: &Vec<Row>| rs.iter().map(|r| format!("{}|{}|{:?}|{:?}|{}", r.rid, r.held, r.score, r.e, r.c.as_deref().map(|c| c.to_string()).unwrap_or_default())).collect::<Vec<_>>();
        assert_eq!(view(p), view(&w.pools["p"]));
        // A route the pool does not hold / a pool we don't hold: refused.
        let miss = json!({"type": "trig_table", "gen": 2, "full": false, "base": 1, "codes": [], "pools": {"p": {"s": {"zz": 1.0}}}});
        assert!(table_from_messages(&[full.clone(), miss]).unwrap_err().contains("does not hold"));
        let nopool = json!({"type": "trig_table", "gen": 2, "full": false, "base": 1, "codes": [], "pools": {"nope": {"s": {"a": 1.0}}}});
        assert!(table_from_messages(&[full.clone(), nopool]).unwrap_err().contains("don't hold"));
        // Not a list / patch / null: refused as before.
        assert!(parse_change(&json!(5)).is_err());
        assert!(parse_change(&json!({"s": {"a": "x"}})).is_err());
        // Patch on a pool replaced earlier in the same message: patches the new list.
        let both = vec![("p".to_string(), parse_change(&rows(vec![("k", 1.0, "3.1")])).unwrap()), ("p".to_string(), parse_change(&json!({"s": {"k": 4.0}})).unwrap())];
        let out = resolve(None, both).unwrap();
        assert_eq!(out[1].1.as_ref().unwrap()[0].score, Some(4.0));
    }

    // The process-wide table: a refused patch changes nothing, the answer
    // says patches are understood. (Own pool keys, so other tests using the
    // process-wide table are not disturbed; the generation is read first.)
    #[test]
    fn apply_table_patch_answer_and_refusal_leave_table_intact() {
        let _l = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let full = json!({"type": "trig_table", "gen": 41, "full": true, "codes": [], "pools": {"0xpp": [{"rid": "a", "h": true, "s": 1.0, "e": "41.1"}]}});
        let a = apply_table(&json!(1), &full);
        assert_eq!(a["ok"], true);
        assert_eq!(a["patch"], true, "the answer tells the bot patches are understood");
        let bad = json!({"type": "trig_table", "gen": 42, "full": false, "base": 41, "codes": [], "pools": {"0xpp": {"s": {"nope": 2.0}}}});
        let b = apply_table(&json!(2), &bad);
        assert_eq!(b["ok"], false);
        assert_eq!(b["unknown"], "patch_miss");
        assert_eq!(table_gen(), Some(41), "refused: generation unchanged");
        with_table(|t| assert_eq!(t.unwrap().pools["0xpp"][0].score, Some(1.0)));
        let good = json!({"type": "trig_table", "gen": 42, "full": false, "base": 41, "codes": [], "pools": {"0xpp": {"s": {"a": 2.0}}}});
        assert_eq!(apply_table(&json!(3), &good)["ok"], true);
        with_table(|t| assert_eq!(t.unwrap().pools["0xpp"][0].score, Some(2.0)));
        // A patch inside a FULL table is refused (a full table must list every row).
        let pf = json!({"type": "trig_table", "gen": 43, "full": true, "codes": [], "pools": {"0xpp": {"s": {"a": 2.0}}}});
        assert_eq!(apply_table(&json!(4), &pf)["ok"], false);
        assert_eq!(table_gen(), Some(42));
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
    }
}
