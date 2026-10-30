// ============================================================================
// FAST LANE SCAN (workstream B): the standing-gap scanner, inside arbsim.
//
// Plain English:
//   Measured Oct 26: 71% of rivals' profit on Robinhood is STANDING GAPS
//   (a price difference that just sits there) taken at the top of the next
//   block, mostly on pools we already follow. Our old Node gap scanner only
//   saw them after the block was reported: always 2-3+ blocks late. This
//   scanner runs inside arbsim on whatever state it is handed (copy 2's
//   confirmed state now; the predicted "ahead" state of workstream A later)
//   as soon as that state exists, and answers "which trades pay right now?".
//
//   What it checks: the CANDIDATE TABLE the bot already keeps here
//   (check/entry.rs, refreshed ~1/s): for every pool copy 2 follows, the
//   2-pool routes the bot could trade (same pair on another exchange, both
//   directions, start coin we hold, venue + coin rules), each with the
//   bot's EXACT check question (our contract at a test address, the trade's
//   calldata, the size ladder). So the scanner checks exactly what the bot
//   would, with the same contract code, on our copy: no second set of
//   route rules to drift apart. (Scope, owner Oct 26: 2-pool routes as the
//   table hands them; this file never invents routes or loops. A ported
//   loop list can plug in later through `RouteSource`.)
//
//   Each block (one `scan` call):
//     1. PRIORITY 1: routes through a pool that changed in this block,
//        ranked the bot's way (start coin we hold first, then the bot's
//        quick price score, then table order; entry.rs select).
//     2. PRIORITY 2, the ROLLING SWEEP: a few more routes from a list of
//        ALL routes, carried on from where the last block stopped, so every
//        route is re-checked every few blocks even if nothing we saw moved
//        it. (Oct 26, claude/Rival_Loops: much of the rivals' standing-gap
//        money sits for 1+ second, so revisiting everything every few
//        blocks catches it.) How many blocks a full pass takes is recorded.
//     Routes touching an "unsure" pool (copy 2 / the predicted view can't
//     vouch for it) are skipped. Everything stops at the time budget
//     (FASTLANE_SCAN_BUDGET_MS); part of it is kept for the sweep so busy
//     blocks can't starve it.
//   Each route is checked with the same size search the sidecar already
//   uses (check/search.rs) at the bot's ladder sizes. A route pays when
//   profit (start-coin units, the check's own number: pool fees and the
//   flash-loan fee are already paid inside it) x the coin's price - the
//   bot's gas estimate >= the minimum (FASTLANE_MIN_NET_USD, else
//   MIN_EXEC_NET_USD, else $0.25, the bot's own default). The same route is not handed out again
//   for the same result while none of its pools changed (dedupe).
//
//   Review fixes (integration, Oct 26):
//     H1 the rolling sweep keeps its PLACE (route id order) when the table
//        changes (it changes about every second); only the pass count restarts.
//     H2 table sync: the code list is compared once per sync, parsed codes
//        are cached by number, a row whose only change is its price facts
//        keeps its parsed check, and the time budget starts AFTER the sync
//        (the fast lane also syncs between blocks: Scanner::sync_now).
//     M4 a handed-out route is handed out again after FASTLANE_DEDUPE_BLOCKS
//        blocks, or at once when the sender reports it never left
//        (Scanner::forget).
//     M5 profit above MAX_PLAUSIBLE_PROFIT_SHARE of the size (bot default
//        0.25) = broken data, never returned.
//     M6 a route is started only if its last run time still fits the budget;
//        a route slower than FASTLANE_ROUTE_MAX_US rests for 50 blocks.
//        (One EVM run can't be stopped half way; this caps the overrun.)
//     L5 the default minimum follows the bot: MIN_EXEC_NET_USD, else $0.25.
//
//   Output: Opportunity list, best first, plus microseconds per phase and
//   per route, and hourly counters (status "fastlaneScan").
//   Off unless FASTLANE=practice|live (same words as fastlane/mode.rs).
//   Nothing here sends anything; nothing here changes existing paths.
// ============================================================================
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use revm::primitives::{Address, U256};
use serde_json::{json, Value};

use super::types::{decode_trade, DecodedTrade, FlashLender, Opportunity, ViewKind};
use crate::arb::BlockCtx;
use crate::check::entry::Table;
use crate::check::hexutil::{parse_u256, quantity};
use crate::check::proto_types::{call_from_wire, WireCall};
use crate::check::run::CheckOptions;
use crate::check::search::{size_search_opts, SizeSearchAmounts, SizeSearchResult, SizeTemplate, SizeTry};
use crate::check::{CallReq, CheckUnknown, Overrides};
use crate::state::StateRead;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// FASTLANE: off (default) | practice | live. Same words as fastlane/mode.rs
/// parse_mode (workstream D): unset / empty / unknown = off.
pub fn fastlane_on(raw: Option<&str>) -> bool {
    super::mode::Mode::parse(raw) != super::mode::Mode::Off
}

/// Scanner settings (env names in brackets with defaults).
#[derive(Clone, Debug, PartialEq)]
pub struct ScanConfig {
    /// FASTLANE_SCAN_BUDGET_MS [5]: wall time one block's scan may use
    /// (final review H-1: was 15; at ~10 blocks a second, 15 ms per block
    /// could keep a whole CPU of the 2 busy).
    pub budget_us: u64,
    /// FASTLANE_SWEEP_PER_BLOCK [8]: rolling-sweep routes per block (at most).
    pub sweep_per_block: usize,
    /// FASTLANE_SWEEP_RESERVE_PCT [25]: share of the budget kept for the
    /// sweep (changed-pool routes stop when only this much is left).
    pub sweep_reserve_pct: u64,
    /// FASTLANE_MAX_CHANGED_ROUTES [64]: changed-pool routes per block (at most).
    pub max_changed: usize,
    /// FASTLANE_MIN_NET_USD [MIN_EXEC_NET_USD, else 0.25]: minimum profit
    /// after gas. (The safety gates apply the bot's own minimum again.)
    pub min_net_usd: f64,
    /// FASTLANE_SCAN_MAX_RESULTS [4]: opportunities returned per block.
    pub max_results: usize,
    /// FASTLANE_SCAN_REFINE_STEPS [0]: 0 = the bot's size ladder only (same
    /// sizes as the trigger-first check); N > 0 = a size search with N runs
    /// between the smallest ladder size and the biggest (finds a better size,
    /// costs ~N runs per route instead of ~3).
    pub refine_steps: usize,
    /// MAX_PLAUSIBLE_PROFIT_SHARE [0.25] (review M5, the bot's setting):
    /// net profit above this share of the trade size = broken data.
    pub max_plausible_share: f64,
    /// FASTLANE_DEDUPE_BLOCKS [20] (review M4): the same result is handed
    /// out again after this many blocks even if no pool changed.
    pub dedupe_blocks: u64,
    /// FASTLANE_ROUTE_MAX_US [5000] (review M6): a route whose check took
    /// longer rests for 50 blocks (counted "slow").
    pub route_max_us: u64,
}

/// The bot's default send minimum (types.ts readMinExecNetUsd).
pub const BOT_MIN_NET_USD: f64 = 0.25;

impl Default for ScanConfig {
    fn default() -> Self {
        ScanConfig {
            budget_us: 5_000,
            sweep_per_block: 8,
            sweep_reserve_pct: 25,
            max_changed: 64,
            min_net_usd: BOT_MIN_NET_USD,
            max_results: 4,
            refine_steps: 0,
            max_plausible_share: 0.25,
            dedupe_blocks: 20,
            route_max_us: 5_000,
        }
    }
}

impl ScanConfig {
    /// From any key -> value lookup (tests pass a map; `from_env` the real one).
    /// Bad values fall back to the default (never to "no limit").
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> ScanConfig {
        let d = ScanConfig::default();
        let num = |k: &str| get(k).and_then(|v| v.trim().parse::<f64>().ok()).filter(|v| v.is_finite());
        let min_net = num("FASTLANE_MIN_NET_USD").filter(|v| *v > 0.0).or_else(|| num("MIN_EXEC_NET_USD").filter(|v| *v > 0.0)).unwrap_or(d.min_net_usd);
        ScanConfig {
            budget_us: num("FASTLANE_SCAN_BUDGET_MS").filter(|v| *v >= 0.0 && *v <= 1000.0).map(|v| (v * 1000.0) as u64).unwrap_or(d.budget_us),
            sweep_per_block: num("FASTLANE_SWEEP_PER_BLOCK").filter(|v| *v >= 0.0 && *v <= 10_000.0).map(|v| v as usize).unwrap_or(d.sweep_per_block),
            sweep_reserve_pct: num("FASTLANE_SWEEP_RESERVE_PCT").filter(|v| *v >= 0.0 && *v <= 100.0).map(|v| v as u64).unwrap_or(d.sweep_reserve_pct),
            max_changed: num("FASTLANE_MAX_CHANGED_ROUTES").filter(|v| *v >= 0.0 && *v <= 10_000.0).map(|v| v as usize).unwrap_or(d.max_changed),
            min_net_usd: min_net,
            max_results: num("FASTLANE_SCAN_MAX_RESULTS").filter(|v| *v >= 1.0 && *v <= 64.0).map(|v| v as usize).unwrap_or(d.max_results),
            refine_steps: num("FASTLANE_SCAN_REFINE_STEPS").filter(|v| *v >= 0.0 && *v <= 64.0).map(|v| v as usize).unwrap_or(d.refine_steps),
            max_plausible_share: num("MAX_PLAUSIBLE_PROFIT_SHARE").filter(|v| *v > 0.0).unwrap_or(d.max_plausible_share),
            dedupe_blocks: num("FASTLANE_DEDUPE_BLOCKS").filter(|v| *v >= 1.0 && *v <= 100_000.0).map(|v| v as u64).unwrap_or(d.dedupe_blocks),
            route_max_us: num("FASTLANE_ROUTE_MAX_US").filter(|v| *v >= 100.0 && *v <= 1_000_000.0).map(|v| v as u64).unwrap_or(d.route_max_us),
        }
    }
    pub fn from_env() -> ScanConfig {
        Self::from_lookup(|k| std::env::var(k).ok())
    }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/// One route's check, ready to run (parsed once, reused every block).
#[derive(Debug)]
pub struct PreparedCheck {
    /// Our contract call at the main (biggest ladder) size.
    pub call: CallReq,
    /// Pretend-state ("$code:<n>" already put back).
    pub overrides: Overrides,
    /// amountIn word position after the 4-byte selector (96 for execute).
    pub amount_offset: usize,
    /// Pretend balance slots that hold the trade size (own money).
    pub amount_slots: Vec<(Address, U256)>,
    /// Main size and the ladder (ascending, main last, no duplicates).
    pub main_amount: U256,
    pub sizes: Vec<U256>,
    /// The trade decoded from the call (hops, coin, lender).
    pub trade: DecodedTrade,
}

impl PreparedCheck {
    /// Build from a table row's check `c` ({calls, overrides, sizes, route,
    /// stop, amt}) and the table's long-code list. Err = can't use it
    /// (counted, never guessed).
    pub fn from_row(c: &Value, codes: &[String]) -> Result<PreparedCheck, String> {
        Self::from_row_cached(c, codes, &mut HashMap::new())
    }

    /// `from_row` with parsed codes remembered by their number in the
    /// table's code list (review H2: the same few contract codes are used by
    /// hundreds of rows; hex-decoding + hashing each one per row was the
    /// main cost of a table sync). `cache` must be cleared when the list changes.
    pub fn from_row_cached(c: &Value, codes: &[String], cache: &mut HashMap<usize, (revm::primitives::B256, revm::bytecode::Bytecode)>) -> Result<PreparedCheck, String> {
        let calls = c.get("calls").and_then(|x| x.as_array()).ok_or("check without calls")?;
        if calls.len() != 1 {
            return Err(format!("{} calls (need exactly 1)", calls.len()));
        }
        let wc: WireCall = serde_json::from_value(calls[0].clone()).map_err(|e| format!("call: {e}"))?;
        let call = call_from_wire(&wc)?;
        // "$code:<n>" -> the code itself (same as entry.rs call_for). The
        // reference is taken out of the JSON and the parsed code (cached by
        // n) put straight into the override: same result as parsing the text.
        let mut ov = c.get("overrides").cloned().unwrap_or_else(|| json!({}));
        let mut by_ref: Vec<(String, usize)> = Vec::new();
        if let Some(o) = ov.as_object_mut() {
            for (addr, acct) in o.iter_mut() {
                if let Some(s) = acct.get("code").and_then(|x| x.as_str()) {
                    if let Some(n) = s.strip_prefix("$code:") {
                        let i: usize = n.parse().map_err(|_| format!("bad code ref {s}"))?;
                        if i >= codes.len() {
                            return Err(format!("code ref {s} not in the table's list"));
                        }
                        by_ref.push((addr.clone(), i));
                        if let Some(m) = acct.as_object_mut() {
                            m.remove("code");
                        }
                    }
                }
            }
        }
        let mut overrides = Overrides::from_json(&ov)?;
        for (addr, i) in by_ref {
            let a = crate::check::hexutil::parse_address(&addr)?;
            let code = match cache.get(&i) {
                Some(x) => x.clone(),
                None => {
                    let bytes = crate::check::hexutil::parse_bytes(&codes[i])?;
                    let x = crate::check::overrides::analysed_code(&bytes);
                    cache.insert(i, x.clone());
                    x
                }
            };
            overrides.accounts.entry(a).or_default().code = Some(code);
        }
        let trade = decode_trade(&call.data)?;
        let amount_offset = c.get("sizes").and_then(|s| s.get("amountOffset")).and_then(|x| x.as_u64()).map(|x| x as usize).unwrap_or(96);
        let start = 4 + amount_offset;
        let main_amount = call.data.get(start..start + 32).map(U256::from_be_slice).ok_or("amountOffset past the call data")?;
        if main_amount.is_zero() || main_amount != trade.amount_in {
            return Err("amountIn word is not the trade's size".into());
        }
        // Trading-money slots: pretend values equal to the size (as
        // proto_types.rs ladder_of does for the trigger-first ladder).
        let mut amount_slots = Vec::new();
        for (a, acc) in &overrides.accounts {
            for (k, v) in &acc.state_diff {
                if *v == main_amount {
                    amount_slots.push((*a, *k));
                }
            }
        }
        amount_slots.sort();
        if !matches!(trade.flash, FlashLender::V3Flash(_) | FlashLender::Aave(_)) && amount_slots.len() != 1 {
            return Err(format!("own-money check with {} trading-money slots (need 1)", amount_slots.len()));
        }
        let mut sizes: Vec<U256> = c
            .get("sizes")
            .and_then(|s| s.get("amounts"))
            .and_then(|a| a.as_array())
            .map(|a| a.iter().take(8).filter_map(|x| x.as_str()).filter_map(|x| parse_u256(x).ok()).filter(|x| !x.is_zero() && *x < main_amount).collect())
            .unwrap_or_default();
        sizes.sort();
        sizes.dedup();
        sizes.push(main_amount);
        Ok(PreparedCheck { call, overrides, amount_offset, amount_slots, main_amount, sizes, trade })
    }

    pub fn template(&self) -> SizeTemplate {
        SizeTemplate { call: self.call.clone(), amount_offset: self.amount_offset, amount_slots: self.amount_slots.clone() }
    }
}

/// The bot's facts about a route (table row "f", sent only when FASTLANE
/// is on): label, start coin's USD price and decimals, gas estimate (USD),
/// loan fee (pips).
#[derive(Clone, Debug, PartialEq)]
pub struct Facts {
    pub label: String,
    pub usd_per_token: f64,
    pub decimals: u32,
    pub gas_usd: f64,
    pub loan_pips: Option<u32>,
}

impl Facts {
    pub fn from_json(f: &Value) -> Option<Facts> {
        let usd = f.get("px").and_then(|x| x.as_f64()).filter(|x| x.is_finite() && *x > 0.0)?;
        let dec = f.get("d").and_then(|x| x.as_u64()).filter(|x| *x <= 36)? as u32;
        let gas = f.get("g").and_then(|x| x.as_f64()).filter(|x| x.is_finite() && *x >= 0.0)?;
        Some(Facts {
            label: f.get("l").and_then(|x| x.as_str()).unwrap_or("").chars().take(80).collect(),
            usd_per_token: usd,
            decimals: dec,
            gas_usd: gas,
            loan_pips: f.get("lp").and_then(|x| x.as_u64()).filter(|x| *x <= 1_000_000).map(|x| x as u32),
        })
    }
    /// USD value of `units` raw units of the start coin (same arithmetic as
    /// the bot's usdOf: units / 10^dec x price).
    pub fn usd_of(&self, units: U256) -> f64 {
        f64::from(units) / 10f64.powi(self.decimals as i32) * self.usd_per_token
    }
}

/// One route the scanner can check.
#[derive(Debug)]
pub struct Route {
    /// "buy>sell:start" (lowercase), the bot's route id.
    pub rid: String,
    pub held: bool,
    pub score: Option<f64>,
    /// Keys the route depends on (pools + lender), lowercase, as the bot
    /// names them (address or V4 pool id).
    pub keys: Vec<String>,
    /// The trade's pools (keys without the lender), route order.
    pub pools: Vec<String>,
    pub check: Arc<PreparedCheck>,
    pub facts: Option<Facts>,
}

/// WHERE ROUTES COME FROM (extension point). Today: the bot's candidate
/// table (TableSource). Later a ported loop list (or anything else) can
/// implement this and be scanned by the same code.
pub trait RouteSource: Send {
    /// Bring the route list up to date (cheap when nothing changed).
    /// Returns the routes that could not be used this time, with why.
    fn sync(&mut self) -> Vec<(String, String)>;
    /// Routes through any of these pools (keys, lowercase), best-ranked first.
    fn ranked_for(&self, changed: &[String]) -> Vec<Arc<Route>>;
    /// Every route, in a stable order (for the rolling sweep).
    fn all(&self) -> &[Arc<Route>];
    /// Changes whenever the route list changes (resets the sweep counting).
    fn generation(&self) -> u64;
}

/// Routes from the bot's candidate table (check/entry.rs).
pub struct TableSource {
    /// Read the table: the global one (live) or a test's own.
    read: Box<dyn Fn(&mut dyn FnMut(Option<&Table>)) + Send>,
    table_gen: Option<u64>,
    gen: u64,
    /// Sorted by route id, so the full list (`all`) comes out in route-id
    /// order without a sort (SPEED FIX, Oct 28).
    by_rid: BTreeMap<String, Arc<Route>>,
    /// The raw row check + facts each route was built from (to rebuild only changed ones).
    built_from: HashMap<String, (Arc<Value>, Option<Arc<Value>>)>,
    /// The code list the routes were built with, and its parsed codes by number.
    codes: Arc<Vec<String>>,
    code_cache: HashMap<usize, (revm::primitives::B256, revm::bytecode::Bytecode)>,
    /// Per pool key: its rows (rid, held, score) in table order.
    per_pool: HashMap<String, Vec<(String, bool, Option<f64>)>>,
    /// How many pools list each route (a route through 2 pools is in both
    /// pools' rows); 0 = the route is gone.
    rid_refs: HashMap<String, usize>,
    all: Vec<Arc<Route>>,
    /// Syncs done by copying the whole table vs only the changed pools.
    pub full_syncs: u64,
    pub delta_syncs: u64,
}

impl TableSource {
    /// The live table the bot refreshes (`trig_table`).
    pub fn global() -> TableSource {
        Self::with_reader(Box::new(|f: &mut dyn FnMut(Option<&Table>)| crate::check::entry::with_table(|t| f(t))))
    }
    /// A table held by the caller (tests, tools).
    pub fn owned(t: Arc<Mutex<Table>>) -> TableSource {
        Self::with_reader(Box::new(move |f: &mut dyn FnMut(Option<&Table>)| {
            let g = t.lock().unwrap_or_else(|e| e.into_inner());
            f(Some(&g))
        }))
    }
    fn with_reader(read: Box<dyn Fn(&mut dyn FnMut(Option<&Table>)) + Send>) -> TableSource {
        TableSource {
            read, table_gen: None, gen: 0, by_rid: BTreeMap::new(), built_from: HashMap::new(), codes: Arc::new(Vec::new()), code_cache: HashMap::new(),
            per_pool: HashMap::new(), rid_refs: HashMap::new(), all: Vec::new(), full_syncs: 0, delta_syncs: 0,
        }
    }
}

type RowCopy = (String, String, bool, Option<f64>, Arc<Value>, Option<Arc<Value>>);
/// One pool's usable rows: (rid, held, score, check, facts).
type PoolRows = Vec<(String, bool, Option<f64>, Arc<Value>, Option<Arc<Value>>)>;

/// What one sync copied out of the table (its lock is held only for this).
enum TableSnap {
    /// Every row (first table, a new FULL table, or a changed code list).
    Full(u64, Arc<Vec<String>>, Vec<RowCopy>),
    /// SPEED FIX (Oct 28): only the pools changed since the generation we
    /// hold: Some(rows) = replaced, None = removed.
    Delta(u64, Vec<(String, Option<PoolRows>)>),
}

fn usable_rows(rs: &[crate::check::entry::Row]) -> PoolRows {
    rs.iter().filter_map(|r| match (&r.e, &r.c) { (Some(_), Some(c)) => Some((r.rid.clone(), r.held, r.score, c.clone(), r.f.clone())), _ => None }).collect()
}

/// One route from its row: the old Route reused when its check text (and
/// code list) did not change (only new facts / rank make a new Route around
/// the same parsed check); else the check is parsed. Ok(None) = unchanged
/// (the very same Route can stay).
#[allow(clippy::too_many_arguments)]
fn route_from_row(
    old: Option<&Arc<Route>>, old_from: Option<&(Arc<Value>, Option<Arc<Value>>)>, codes_same: bool,
    rid: &str, held: bool, score: Option<f64>, c: &Arc<Value>, f: &Option<Arc<Value>>,
    codes: &[String], code_cache: &mut HashMap<usize, (revm::primitives::B256, revm::bytecode::Bytecode)>,
) -> Result<Arc<Route>, String> {
    if let (Some(old), Some((oc, of))) = (old, old_from) {
        if codes_same && (Arc::ptr_eq(oc, c) || **oc == **c) {
            let same_f = match (of, f) {
                (None, None) => true,
                (Some(a), Some(b)) => Arc::ptr_eq(a, b) || a == b,
                _ => false,
            };
            return Ok(if same_f && old.held == held && old.score == score {
                old.clone()
            } else {
                Arc::new(Route { rid: rid.to_string(), held, score, keys: old.keys.clone(), pools: old.pools.clone(), check: old.check.clone(), facts: f.as_deref().and_then(Facts::from_json) })
            });
        }
    }
    let p = PreparedCheck::from_row_cached(c, codes, code_cache)?;
    let keys: Vec<String> = c.get("route").and_then(|r| r.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).map(|s| s.to_ascii_lowercase()).collect()).unwrap_or_default();
    let lender = p.trade.flash.lender().map(|a| format!("{a:#x}"));
    let pools: Vec<String> = keys.iter().filter(|k| Some(k.as_str()) != lender.as_deref()).cloned().collect();
    Ok(Arc::new(Route { rid: rid.to_string(), held, score, keys, pools, check: Arc::new(p), facts: f.as_deref().and_then(Facts::from_json) }))
}

impl TableSource {
    /// Every row copied and every route rebuilt (reusing parsed checks).
    fn sync_full(&mut self, tgen: u64, codes: Arc<Vec<String>>, rows: Vec<RowCopy>) -> Vec<(String, String)> {
        self.full_syncs += 1;
        let mut bad = Vec::new();
        let mut per_pool: HashMap<String, Vec<(String, bool, Option<f64>)>> = HashMap::new();
        let mut by_rid: BTreeMap<String, Arc<Route>> = BTreeMap::new();
        let mut built_from = HashMap::new();
        let mut rid_refs: HashMap<String, usize> = HashMap::new();
        // H2: the code list compared ONCE (the bot resends it with every
        // table message); a different list = every check is re-parsed.
        let codes_same = Arc::ptr_eq(&self.codes, &codes) || *self.codes == *codes;
        if !codes_same {
            self.codes = codes.clone();
            self.code_cache.clear();
        }
        // Keep the table's per-pool row order (rows are walked per pool).
        for (pool, rid, held, score, c, f) in rows {
            per_pool.entry(pool).or_default().push((rid.clone(), held, score));
            *rid_refs.entry(rid.clone()).or_default() += 1;
            if by_rid.contains_key(&rid) {
                continue;
            }
            match route_from_row(self.by_rid.get(&rid), self.built_from.get(&rid), codes_same, &rid, held, score, &c, &f, &codes, &mut self.code_cache) {
                Ok(r) => {
                    by_rid.insert(rid.clone(), r);
                    built_from.insert(rid, (c, f));
                }
                Err(e) => bad.push((rid, e)),
            }
        }
        let all: Vec<Arc<Route>> = by_rid.values().cloned().collect();
        let changed = all.len() != self.all.len() || all.iter().zip(&self.all).any(|(a, b)| !Arc::ptr_eq(a, b));
        self.table_gen = Some(tgen);
        self.per_pool = per_pool;
        self.by_rid = by_rid;
        self.built_from = built_from;
        self.rid_refs = rid_refs;
        if changed {
            self.all = all;
            self.gen += 1;
        }
        bad
    }

    /// SPEED FIX (Oct 28): only the pools that changed since the generation
    /// we hold. Same routes as a full sync of the same table (test:
    /// delta_sync_matches_full_sync), at a fraction of the work.
    fn sync_delta(&mut self, tgen: u64, pools: Vec<(String, Option<PoolRows>)>) -> Vec<(String, String)> {
        self.delta_syncs += 1;
        let mut bad = Vec::new();
        let mut maybe_gone: Vec<String> = Vec::new();
        let mut changed = false;
        let codes = self.codes.clone();
        for (pool, rows) in pools {
            if let Some(old) = self.per_pool.remove(&pool) {
                for (rid, _, _) in old {
                    if let Some(n) = self.rid_refs.get_mut(&rid) {
                        *n = n.saturating_sub(1);
                        if *n == 0 {
                            maybe_gone.push(rid);
                        }
                    }
                }
            }
            let Some(rows) = rows else { continue };
            let mut list = Vec::with_capacity(rows.len());
            for (rid, held, score, c, f) in rows {
                list.push((rid.clone(), held, score));
                *self.rid_refs.entry(rid.clone()).or_default() += 1;
                match route_from_row(self.by_rid.get(&rid), self.built_from.get(&rid), true, &rid, held, score, &c, &f, &codes, &mut self.code_cache) {
                    Ok(r) => {
                        if !self.by_rid.get(&rid).is_some_and(|o| Arc::ptr_eq(o, &r)) {
                            changed = true;
                        }
                        self.by_rid.insert(rid.clone(), r);
                        self.built_from.insert(rid, (c, f));
                    }
                    Err(e) => {
                        // Unusable now: not scanned (as a full sync would leave it out).
                        if self.by_rid.remove(&rid).is_some() {
                            changed = true;
                        }
                        self.built_from.remove(&rid);
                        bad.push((rid, e));
                    }
                }
            }
            self.per_pool.insert(pool, list);
        }
        for rid in maybe_gone {
            if self.rid_refs.get(&rid).copied().unwrap_or(0) == 0 {
                self.rid_refs.remove(&rid);
                self.built_from.remove(&rid);
                if self.by_rid.remove(&rid).is_some() {
                    changed = true;
                }
            }
        }
        self.table_gen = Some(tgen);
        if changed {
            self.all = self.by_rid.values().cloned().collect();
            self.gen += 1;
        }
        bad
    }
}

impl RouteSource for TableSource {
    fn sync(&mut self) -> Vec<(String, String)> {
        // Copy what we need out of the table (its lock is held only for that).
        let mut snap: Option<TableSnap> = None;
        let mut gen_now: Option<u64> = None;
        let have = self.table_gen;
        let my_codes = self.codes.clone();
        (self.read)(&mut |t: Option<&Table>| {
            let Some(t) = t else { return };
            gen_now = Some(t.gen);
            if have == Some(t.gen) {
                return;
            }
            let same_codes = Arc::ptr_eq(&my_codes, &t.codes) || *my_codes == *t.codes;
            match have {
                // Only the pools changed since `h` (same code list, no new full table).
                Some(h) if t.tracked && t.full_gen <= h && t.gen > h && same_codes => {
                    let mut pools: Vec<(String, Option<PoolRows>)> = Vec::new();
                    for (k, g) in &t.pool_gen {
                        if *g > h {
                            pools.push((k.clone(), Some(t.pools.get(k).map(|rs| usable_rows(rs)).unwrap_or_default())));
                        }
                    }
                    for (k, g) in &t.removed {
                        if *g > h && !t.pools.contains_key(k) {
                            pools.push((k.clone(), None));
                        }
                    }
                    snap = Some(TableSnap::Delta(t.gen, pools));
                }
                _ => {
                    let mut rows = Vec::new();
                    for (pool, rs) in &t.pools {
                        for (rid, held, score, c, f) in usable_rows(rs) {
                            rows.push((pool.clone(), rid, held, score, c, f));
                        }
                    }
                    snap = Some(TableSnap::Full(t.gen, t.codes.clone(), rows));
                }
            }
        });
        match snap {
            Some(TableSnap::Full(tgen, codes, rows)) => self.sync_full(tgen, codes, rows),
            Some(TableSnap::Delta(tgen, pools)) => self.sync_delta(tgen, pools),
            None => {
                if gen_now.is_none() && self.table_gen.is_some() {
                    // Table gone (tests / restart): forget the routes.
                    self.table_gen = None;
                    self.by_rid.clear();
                    self.built_from.clear();
                    self.code_cache.clear();
                    self.codes = Arc::new(Vec::new());
                    self.per_pool.clear();
                    self.rid_refs.clear();
                    self.all.clear();
                    self.gen += 1;
                }
                Vec::new()
            }
        }
    }

    /// entry.rs `select` picking (moved pools in order, each pool's rows in
    /// order, a route seen twice counted once; then held first, higher score,
    /// table order), without the bot's per-trigger cap (the time budget and
    /// FASTLANE_MAX_CHANGED_ROUTES cap instead).
    fn ranked_for(&self, changed: &[String]) -> Vec<Arc<Route>> {
        let mut seen: HashSet<&str> = HashSet::new();
        let mut list: Vec<(usize, bool, Option<f64>, &str)> = Vec::new();
        for k in changed {
            let Some(rows) = self.per_pool.get(&k.to_ascii_lowercase()) else { continue };
            for (rid, held, score) in rows {
                if seen.insert(rid.as_str()) {
                    list.push((list.len(), *held, *score, rid.as_str()));
                }
            }
        }
        list.sort_by(|a, b| (!a.1).cmp(&!b.1).then_with(|| b.2.unwrap_or(f64::NEG_INFINITY).total_cmp(&a.2.unwrap_or(f64::NEG_INFINITY))).then_with(|| a.0.cmp(&b.0)));
        list.into_iter().filter_map(|(_, _, _, rid)| self.by_rid.get(rid).cloned()).collect()
    }

    fn all(&self) -> &[Arc<Route>] {
        &self.all
    }

    fn generation(&self) -> u64 {
        self.gen
    }
}

// ---------------------------------------------------------------------------
// Running one route's check
// ---------------------------------------------------------------------------

/// Runs a route's check on a view. The default (PlainRunner) is the size
/// search on the view as given. Integration can plug in copy 2's runner
/// (the V4 PoolManager balance bound / protocol-fee double runs of
/// server.rs copy2_runs) without changing the scanner.
pub trait CheckRunner: Send + Sync {
    fn run(&self, view: &dyn StateRead, ctx: &BlockCtx, c: &PreparedCheck, amounts: &SizeSearchAmounts) -> Result<SizeSearchResult, CheckUnknown>;
    /// With the state's snapshot and block when the caller has them (copy
    /// 2's runner needs both: fastlane/c2runner.rs). Default: `run`.
    fn run_at(&self, at: &RunAt, c: &PreparedCheck, amounts: &SizeSearchAmounts) -> Result<SizeSearchResult, CheckUnknown> {
        self.run(at.view, at.ctx, c, amounts)
    }
}

/// Where one check runs: the strict view, its block details, its L2 block
/// and (when it is a copy-2 snapshot, confirmed or predicted) the snapshot.
pub struct RunAt<'a> {
    pub view: &'a dyn StateRead,
    pub ctx: &'a BlockCtx,
    pub block: u64,
    pub snap: Option<&'a Arc<crate::state::snap::Snapshot>>,
}

/// The plain size search (check/search.rs), eth_call rules, strict view.
pub struct PlainRunner;

impl CheckRunner for PlainRunner {
    fn run(&self, view: &dyn StateRead, ctx: &BlockCtx, c: &PreparedCheck, amounts: &SizeSearchAmounts) -> Result<SizeSearchResult, CheckUnknown> {
        size_search_opts(view, ctx, &c.overrides, &[], &c.template(), amounts, CheckOptions::default())
    }
}

/// The sizes a route is checked at under these settings.
pub fn amounts_for(c: &PreparedCheck, refine_steps: usize) -> SizeSearchAmounts {
    if refine_steps > 0 && c.sizes.len() > 1 {
        SizeSearchAmounts::Range { lo: c.sizes[0], hi: c.main_amount, steps: refine_steps }
    } else {
        SizeSearchAmounts::List(c.sizes.clone())
    }
}

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

/// One block's input. `view` must be strict (missing = Missing, never zero).
pub struct BlockInput<'a> {
    pub view: &'a dyn StateRead,
    pub ctx: &'a BlockCtx,
    /// L2 block whose end state `view` is.
    pub block: u64,
    pub kind: ViewKind,
    /// Our pools changed by this block (keys as the bot names them).
    pub changed: &'a [String],
    /// Pools the view can't vouch for: routes through them are skipped.
    pub unsure: &'a HashSet<String>,
    /// The view's snapshot, when it is a copy-2 one (copy 2's runner).
    pub snap: Option<&'a Arc<crate::state::snap::Snapshot>>,
}

/// What happened to one route this block.
#[derive(Clone, Debug, PartialEq)]
pub enum Outcome {
    /// Pays (and was returned, unless `dup`).
    Found { amount: U256, profit: U256, net_usd: f64, dup: bool },
    /// Profit at some size, but below the minimum after gas.
    BelowMin { amount: U256, profit: U256, net_usd: f64 },
    /// No size made a profit.
    NoProfit,
    /// Profit bigger than the trade itself (bad data, never used).
    Implausible,
    /// The bot gave no price / gas facts for it (can't value it).
    NoFacts,
    /// The check could not be sure (missing item, unsupported...).
    Unknown(String),
    /// A pool on it is unsure in this view.
    SkippedUnsure,
}

#[derive(Clone, Debug)]
pub struct RouteCheck {
    pub rid: String,
    /// "changed" | "sweep"
    pub source: &'static str,
    pub outcome: Outcome,
    pub us: u64,
}

/// Microseconds per phase of one block's scan.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScanTiming {
    /// Route list brought up to date (table changes).
    pub sync_us: u64,
    pub changed_us: u64,
    pub sweep_us: u64,
    pub total_us: u64,
}

#[derive(Clone, Debug, Default)]
pub struct ScanReport {
    /// Best first (expected_net_usd), at most max_results.
    pub opps: Vec<Opportunity>,
    pub checked: Vec<RouteCheck>,
    pub timing: ScanTiming,
    /// Changed-pool routes left unchecked because the budget ran out.
    pub cut_changed: usize,
    /// Routes passed over: a pool not followed and ready in copy 2.
    pub unfollowed: usize,
    /// Routes in the sweep list.
    pub sweep_total: usize,
    /// Completed a full sweep pass this block: how many blocks it took.
    pub full_sweep_blocks: Option<u64>,
    /// M6: routes not started because they rest (slow) / didn't fit the budget left.
    pub resting: usize,
    pub cut_fit: usize,
}

/// The standing-gap scanner (one per state stream: confirmed / predicted).
pub struct Scanner {
    pub cfg: ScanConfig,
    src: Box<dyn RouteSource>,
    runner: Box<dyn CheckRunner>,
    /// Rolling sweep (H1): the last route id the sweep visited (the next
    /// block carries on after it in id order, whatever the table did), and
    /// the source generation seen last.
    last_rid: Option<String>,
    cursor_gen: u64,
    /// Blocks since the current sweep pass started.
    pass_blocks: u64,
    /// The pass under way started at the beginning with an unchanged route
    /// list (only such a pass is counted as "full sweep in N blocks").
    pass_valid: bool,
    /// M6: per route, its last check time (us) and the epoch it rests until.
    route_us: HashMap<String, (u64, u64)>,
    /// Dedupe: route -> (amount, profit, pool epoch when returned).
    returned: HashMap<String, (U256, U256, u64)>,
    /// Pool key -> epoch (scan call number) it last changed.
    pool_epoch: HashMap<String, u64>,
    epoch: u64,
}

impl Scanner {
    pub fn new(cfg: ScanConfig, src: Box<dyn RouteSource>, runner: Box<dyn CheckRunner>) -> Scanner {
        Scanner { cfg, src, runner, last_rid: None, cursor_gen: u64::MAX, pass_blocks: 0, pass_valid: true, route_us: HashMap::new(), returned: HashMap::new(), pool_epoch: HashMap::new(), epoch: 0 }
    }

    /// The live scanner: None unless FASTLANE=practice|live.
    pub fn from_env() -> Option<Scanner> {
        if !fastlane_on(std::env::var("FASTLANE").ok().as_deref()) {
            return None;
        }
        Some(Scanner::new(ScanConfig::from_env(), Box::new(TableSource::global()), Box::new(PlainRunner)))
    }

    pub fn runner(&self) -> &dyn CheckRunner {
        &*self.runner
    }

    /// Bring the route list up to date now (the fast lane calls this
    /// between blocks, so a block's scan rarely pays for it). H2.
    pub fn sync_now(&mut self) -> usize {
        let bad = self.src.sync();
        HOUR.with(|h| h.bad_rows += bad.len() as u64);
        bad.len()
    }

    /// M4: hand this route out again at once (the sender reports its trade
    /// never left: refused, stale in the queue, not written).
    pub fn forget(&mut self, rid: &str) {
        self.returned.remove(rid);
    }

    /// Routes known (status).
    pub fn routes(&self) -> usize {
        self.src.all().len()
    }

    /// Scan one block. See the file header.
    pub fn scan(&mut self, b: &BlockInput) -> ScanReport {
        let t0 = Instant::now();
        let mut rep = ScanReport::default();
        self.epoch += 1;
        let epoch = self.epoch;
        // Remember which pools changed (dedupe). Bounded: pool keys are our
        // followed pools (hundreds); a flood of odd keys just starts over.
        if self.pool_epoch.len() > 50_000 {
            self.pool_epoch.clear();
            self.returned.clear();
        }
        for k in b.changed {
            self.pool_epoch.insert(k.to_ascii_lowercase(), epoch);
        }
        self.sync_now();
        rep.timing.sync_us = t0.elapsed().as_micros() as u64;
        // H2: the time budget starts after the table sync.
        let t0 = Instant::now();
        // Forget dedupe entries of routes that are gone.
        if self.returned.len() > self.src.all().len() * 2 + 64 {
            let live: HashSet<&str> = self.src.all().iter().map(|r| r.rid.as_str()).collect();
            self.returned.retain(|k, _| live.contains(k.as_str()));
        }

        let budget = self.cfg.budget_us;
        let changed_limit = budget.saturating_sub(budget * self.cfg.sweep_reserve_pct / 100);
        // M6: bounded memory for per-route timings.
        if self.route_us.len() > self.src.all().len() * 2 + 64 {
            self.route_us.retain(|_, (_, until)| *until > epoch);
        }
        let mut done: HashSet<String> = HashSet::new();
        let mut found: Vec<Opportunity> = Vec::new();

        // 1. Routes through pools changed in this block.
        let tc = Instant::now();
        let ranked = if b.changed.is_empty() { Vec::new() } else { self.src.ranked_for(b.changed) };
        let mut tried = 0usize;
        for (i, r) in ranked.iter().enumerate() {
            if tried >= self.cfg.max_changed || t0.elapsed().as_micros() as u64 >= changed_limit {
                rep.cut_changed = ranked.len() - i;
                break;
            }
            // (Oct 30) A route through a pool copy 2 doesn't follow and hold
            // ready can never be sent (lane.rs follow_block): don't spend
            // the block's budget on it (live: ~1 in 3 "found" were such).
            if crate::fastlane::lane::follow_block(&r.pools).is_some() {
                rep.unfollowed += 1;
                continue;
            }
            if !self.may_start(r, t0, changed_limit, epoch, &mut rep) {
                continue;
            }
            tried += 1;
            done.insert(r.rid.clone());
            let c = self.check_route(r, b, "changed", t0, epoch, &mut found);
            rep.checked.push(c);
        }
        rep.timing.changed_us = tc.elapsed().as_micros() as u64;

        // 2. Rolling sweep over every route.
        let ts = Instant::now();
        let gen = self.src.generation();
        let all: Vec<Arc<Route>> = self.src.all().to_vec();
        rep.sweep_total = all.len();
        if gen != self.cursor_gen {
            // H1: a new route list keeps the sweep's PLACE (route id order);
            // only the pass in progress is no longer counted as a full pass.
            if self.cursor_gen != u64::MAX && self.last_rid.is_some() {
                self.pass_valid = false;
            }
            self.cursor_gen = gen;
        }
        // Carry on after the last route visited (by id; `all` is sorted by id).
        let mut cursor = match &self.last_rid {
            Some(l) => all.partition_point(|r| r.rid.as_str() <= l.as_str()),
            None => 0,
        };
        if !all.is_empty() {
            if self.pass_blocks > 0 {
                // The pass under way spans one more block.
                self.pass_blocks += 1;
            }
            let mut swept = 0usize;
            let mut steps = 0usize;
            // Each route at most once per block; routes already checked in
            // step 1 count as covered without another run.
            // (A route visited by the sweep but already checked in step 1
            // counts as covered without a second run.)
            while steps < all.len() && swept < self.cfg.sweep_per_block && (t0.elapsed().as_micros() as u64) < budget {
                if cursor >= all.len() {
                    cursor = 0;
                }
                if self.pass_blocks == 0 {
                    // A new pass starts in this block: this block is its first.
                    self.pass_blocks = 1;
                }
                let r = &all[cursor];
                if !done.contains(&r.rid) && crate::fastlane::lane::follow_block(&r.pools).is_some() {
                    // Never sendable (see step 1): passed over, counted.
                    rep.unfollowed += 1;
                    done.insert(r.rid.clone());
                    cursor += 1;
                    steps += 1;
                    self.last_rid = Some(r.rid.clone());
                    if cursor >= all.len() {
                        if self.pass_valid {
                            rep.full_sweep_blocks = Some(self.pass_blocks);
                        }
                        self.pass_blocks = 0;
                        self.pass_valid = true;
                        cursor = 0;
                        self.last_rid = None;
                    }
                    continue;
                }
                if !done.contains(&r.rid) && !self.may_start(r, t0, budget, epoch, &mut rep) {
                    // Doesn't fit what is left of the budget: next block.
                    break;
                }
                cursor += 1;
                steps += 1;
                self.last_rid = Some(r.rid.clone());
                if !done.contains(&r.rid) {
                    done.insert(r.rid.clone());
                    let c = self.check_route(r, b, "sweep", t0, epoch, &mut found);
                    rep.checked.push(c);
                    swept += 1;
                }
                if cursor >= all.len() {
                    // A full pass is complete: every route visited once.
                    if self.pass_valid {
                        rep.full_sweep_blocks = Some(self.pass_blocks);
                    }
                    self.pass_blocks = 0;
                    self.pass_valid = true;
                    cursor = 0;
                    self.last_rid = None;
                }
            }
        }
        rep.timing.sweep_us = ts.elapsed().as_micros() as u64;

        found.sort_by(|a, b| b.expected_net_usd.total_cmp(&a.expected_net_usd));
        found.truncate(self.cfg.max_results);
        rep.opps = found;
        rep.timing.total_us = t0.elapsed().as_micros() as u64;
        let held = self.src.all().len() as u64;
        HOUR.with(|h| h.routes = held);
        record_block(&rep);
        rep
    }

    /// M6: may route `r` start now? Not while it rests (it was slower than
    /// FASTLANE_ROUTE_MAX_US), and only if its last run time still fits
    /// before `limit` (us since t0). A route never timed always may.
    fn may_start(&mut self, r: &Arc<Route>, t0: Instant, limit: u64, epoch: u64, rep: &mut ScanReport) -> bool {
        let Some((us, until)) = self.route_us.get(&r.rid).copied() else { return true };
        if until > epoch {
            rep.resting += 1;
            return false;
        }
        if (t0.elapsed().as_micros() as u64).saturating_add(us) > limit {
            rep.cut_fit += 1;
            return false;
        }
        true
    }

    fn check_route(&mut self, r: &Arc<Route>, b: &BlockInput, source: &'static str, t0: Instant, epoch: u64, found: &mut Vec<Opportunity>) -> RouteCheck {
        let c = self.check_route_inner(r, b, source, t0, epoch, found);
        // M6: remember how long it took; a slow route rests 50 blocks.
        let until = if c.us > self.cfg.route_max_us { epoch + 50 } else { 0 };
        if until > 0 {
            HOUR.with(|h| h.slow_routes += 1);
        }
        self.route_us.insert(r.rid.clone(), (c.us, until));
        c
    }

    fn check_route_inner(&mut self, r: &Arc<Route>, b: &BlockInput, source: &'static str, t0: Instant, epoch: u64, found: &mut Vec<Opportunity>) -> RouteCheck {
        let tr = Instant::now();
        let fin = |outcome: Outcome| RouteCheck { rid: r.rid.clone(), source, outcome, us: tr.elapsed().as_micros() as u64 };
        if r.keys.iter().chain(r.pools.iter()).any(|k| b.unsure.contains(k)) {
            if !r.pools.iter().any(|k| b.unsure.contains(k)) {
                HOUR.with(|h| h.skipped_unsure_lender += 1);
            }
            return fin(Outcome::SkippedUnsure);
        }
        let Some(f) = &r.facts else { return fin(Outcome::NoFacts) };
        let at = RunAt { view: b.view, ctx: b.ctx, block: b.block, snap: b.snap };
        let res = match self.runner.run_at(&at, &r.check, &amounts_for(&r.check, self.cfg.refine_steps)) {
            Ok(x) => x,
            Err(u) => return fin(Outcome::Unknown(u.reason.as_str().to_string())),
        };
        let Some(best) = res.best else { return fin(Outcome::NoProfit) };
        if best.profit > best.amount {
            return fin(Outcome::Implausible);
        }
        let net = f.usd_of(best.profit) - f.gas_usd;
        if !net.is_finite() || net < self.cfg.min_net_usd {
            return fin(Outcome::BelowMin { amount: best.amount, profit: best.profit, net_usd: net });
        }
        // M5: profit above the bot's plausible share of the size = broken data.
        let size_usd = f.usd_of(best.amount);
        if !(size_usd > 0.0) || net / size_usd > self.cfg.max_plausible_share {
            return fin(Outcome::Implausible);
        }
        // Dedupe: same result, no pool of the route changed since we last
        // handed it out, and not more than FASTLANE_DEDUPE_BLOCKS ago (M4).
        let last_change = r.keys.iter().filter_map(|k| self.pool_epoch.get(k)).copied().max().unwrap_or(0);
        let fresh = self.cfg.dedupe_blocks;
        let dup = matches!(self.returned.get(&r.rid), Some((a, p, e)) if *a == best.amount && *p == best.profit && last_change <= *e && epoch.saturating_sub(*e) < fresh);
        if !dup {
            self.returned.insert(r.rid.clone(), (best.amount, best.profit, epoch));
            let t = &r.check.trade;
            let mut tokens = vec![t.token];
            for h in &t.hops {
                for x in [h.token_in, h.token_out] {
                    if !tokens.contains(&x) {
                        tokens.push(x);
                    }
                }
            }
            found.push(Opportunity {
                block: b.block,
                view: b.kind,
                route_label: f.label.clone(),
                rid: r.rid.clone(),
                token_in: t.token,
                token_in_decimals: f.decimals,
                usd_per_token_in: f.usd_per_token,
                amount_in: best.amount,
                size_usd,
                hops: t.hops.clone(),
                flash: t.flash,
                profit_units: best.profit,
                expected_net_usd: net,
                gas_usd: f.gas_usd,
                gas_used: best.gas_used,
                loan_fee_usd: match t.flash {
                    FlashLender::Own => Some(0.0),
                    _ => f.loan_pips.map(|p| size_usd * p as f64 / 1_000_000.0),
                },
                pools: r.pools.clone(),
                keys: r.keys.clone(),
                tokens,
                found_at: Instant::now(),
                scan_us: t0.elapsed().as_micros() as u64,
                source,
                check: r.check.clone(),
            });
        }
        fin(Outcome::Found { amount: best.amount, profit: best.profit, net_usd: net, dup })
    }
}

// ---------------------------------------------------------------------------
// Practice mode: was it real?
// ---------------------------------------------------------------------------

/// Re-check of one opportunity on a later (confirmed) state.
#[derive(Clone, Debug, PartialEq)]
pub struct Evaluation {
    /// The exact size found, on the given state.
    pub at_size: Result<SizeTry, String>,
    /// Net USD at that size (profit x price - gas), None when not sure.
    pub net_usd: Option<f64>,
    /// true = still pays at least `min_net_usd` at the size found.
    pub real: Option<bool>,
}

/// Re-run the opportunity's check at exactly its size on `view` (e.g. the
/// confirmed state of block N, and of N+1 = what our trade would have met).
/// Same contract, same call, same pretend-state as when it was found.
pub fn evaluate(opp: &Opportunity, runner: &dyn CheckRunner, view: &dyn StateRead, ctx: &BlockCtx, min_net_usd: f64) -> Evaluation {
    evaluate_at(opp, runner, &RunAt { view, ctx, block: 0, snap: None }, min_net_usd)
}

/// `evaluate` with the snapshot / block (copy 2's runner: fastlane/c2runner.rs).
pub fn evaluate_at(opp: &Opportunity, runner: &dyn CheckRunner, at: &RunAt, min_net_usd: f64) -> Evaluation {
    let r = runner.run_at(at, &opp.check, &SizeSearchAmounts::List(vec![opp.amount_in]));
    let ev = match r {
        Err(u) => Evaluation { at_size: Err(u.reason.as_str().to_string()), net_usd: None, real: None },
        Ok(res) => {
            let t = res.tried.into_iter().next();
            match t {
                None => Evaluation { at_size: Err("no try".into()), net_usd: None, real: None },
                Some(t) => {
                    let gross = f64::from(t.profit) / 10f64.powi(opp.token_in_decimals as i32) * opp.usd_per_token_in;
                    let net = if t.status == "profit" && t.profit <= t.amount { gross - opp.gas_usd } else { -opp.gas_usd };
                    Evaluation { real: Some(t.status == "profit" && t.profit <= t.amount && net >= min_net_usd), net_usd: Some(net), at_size: Ok(t) }
                }
            }
        }
    };
    HOUR.with(|h| match ev.real {
        Some(true) => h.eval_real += 1,
        Some(false) => h.eval_gone += 1,
        None => h.eval_unknown += 1,
    });
    ev
}

// ---------------------------------------------------------------------------
// Hourly counters (status "fastlaneScan"; reset by take_hour)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct Hour {
    pub blocks: u64,
    pub routes_checked: u64,
    pub changed_checked: u64,
    pub sweep_checked: u64,
    pub found: u64,
    pub found_dup: u64,
    pub below_min: u64,
    pub no_profit: u64,
    pub unknown: u64,
    pub skipped_unsure: u64,
    pub no_facts: u64,
    pub implausible: u64,
    pub cut_changed: u64,
    pub unfollowed: u64,
    pub bad_rows: u64,
    pub best_net_usd: Option<f64>,
    pub best_label: String,
    pub time_us: u64,
    pub max_block_us: u64,
    pub full_sweeps: u64,
    pub last_full_sweep_blocks: Option<u64>,
    pub max_full_sweep_blocks: u64,
    pub eval_real: u64,
    pub eval_gone: u64,
    pub eval_unknown: u64,
    /// M6: route checks slower than FASTLANE_ROUTE_MAX_US (then rested).
    pub slow_routes: u64,
    /// M6: routes not started this hour (resting / didn't fit the budget left).
    pub resting: u64,
    pub cut_fit: u64,
    /// Practice fixes (Oct 27): routes the scanner holds right now (from the
    /// bot's candidate table); 0 = no table / nothing usable.
    pub routes: u64,
    /// Routes skipped as unsure because of their LENDER key (the pools
    /// themselves were fine), apart from pools.
    pub skipped_unsure_lender: u64,
}

struct HourCell {
    h: Mutex<Hour>,
    /// Per-block total time (us), last 1000 (p50/p90/p99/max).
    ring: Mutex<VecDeque<u64>>,
}

impl HourCell {
    fn with(&self, f: impl FnOnce(&mut Hour)) {
        let mut g = self.h.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut g);
    }
}

static HOUR: HourCell = HourCell { h: Mutex::new(Hour {
    blocks: 0, routes_checked: 0, changed_checked: 0, sweep_checked: 0, found: 0, found_dup: 0, below_min: 0, no_profit: 0, unknown: 0,
    skipped_unsure: 0, no_facts: 0, implausible: 0, cut_changed: 0, unfollowed: 0, bad_rows: 0, best_net_usd: None, best_label: String::new(), time_us: 0,
    max_block_us: 0, full_sweeps: 0, last_full_sweep_blocks: None, max_full_sweep_blocks: 0, eval_real: 0, eval_gone: 0, eval_unknown: 0,
    slow_routes: 0, resting: 0, cut_fit: 0, routes: 0, skipped_unsure_lender: 0,
}), ring: Mutex::new(VecDeque::new()) };

fn record_block(rep: &ScanReport) {
    HOUR.with(|h| {
        h.blocks += 1;
        h.cut_changed += rep.cut_changed as u64;
        h.unfollowed += rep.unfollowed as u64;
        h.resting += rep.resting as u64;
        h.cut_fit += rep.cut_fit as u64;
        h.time_us += rep.timing.total_us;
        h.max_block_us = h.max_block_us.max(rep.timing.total_us);
        for c in &rep.checked {
            let ran = !matches!(c.outcome, Outcome::SkippedUnsure | Outcome::NoFacts);
            if ran {
                h.routes_checked += 1;
                if c.source == "changed" {
                    h.changed_checked += 1;
                } else {
                    h.sweep_checked += 1;
                }
            }
            match &c.outcome {
                Outcome::Found { dup: false, .. } => h.found += 1,
                Outcome::Found { dup: true, .. } => h.found_dup += 1,
                Outcome::BelowMin { .. } => h.below_min += 1,
                Outcome::NoProfit => h.no_profit += 1,
                Outcome::Unknown(_) => h.unknown += 1,
                Outcome::SkippedUnsure => h.skipped_unsure += 1,
                Outcome::NoFacts => h.no_facts += 1,
                Outcome::Implausible => h.implausible += 1,
            }
        }
        if let Some(o) = rep.opps.first() {
            if h.best_net_usd.is_none_or(|b| o.expected_net_usd > b) {
                h.best_net_usd = Some(o.expected_net_usd);
                h.best_label = o.route_label.clone();
            }
        }
        if let Some(n) = rep.full_sweep_blocks {
            h.full_sweeps += 1;
            h.last_full_sweep_blocks = Some(n);
            h.max_full_sweep_blocks = h.max_full_sweep_blocks.max(n);
        }
    });
    let mut r = HOUR.ring.lock().unwrap_or_else(|e| e.into_inner());
    if r.len() >= 1000 {
        r.pop_front();
    }
    r.push_back(rep.timing.total_us);
    drop(r);
    // SPEED FIX (Oct 28): the route-list update before each scan, timed
    // apart ("blockUs" starts after it), last 1000 blocks.
    let mut q = SYNC_RING.lock().unwrap_or_else(|e| e.into_inner());
    if q.len() >= 1000 {
        q.pop_front();
    }
    q.push_back(rep.timing.sync_us);
}

static SYNC_RING: Mutex<VecDeque<u64>> = Mutex::new(VecDeque::new());

/// Counters so far this hour, as JSON (status "fastlaneScan").
pub fn status_json() -> Value {
    let h = HOUR.h.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mut ring: Vec<u64> = HOUR.ring.lock().unwrap_or_else(|e| e.into_inner()).iter().copied().collect();
    json!({
        "blocks": h.blocks, "routesChecked": h.routes_checked, "changedChecked": h.changed_checked, "sweepChecked": h.sweep_checked,
        "found": h.found, "foundDup": h.found_dup, "belowMin": h.below_min, "noProfit": h.no_profit, "unknown": h.unknown,
        "skippedUnsure": h.skipped_unsure, "noFacts": h.no_facts, "implausible": h.implausible, "cutChanged": h.cut_changed, "unfollowed": h.unfollowed, "badRows": h.bad_rows,
        "bestNetUsd": h.best_net_usd, "bestLabel": h.best_label, "timeUs": h.time_us, "maxBlockUs": h.max_block_us,
        "fullSweeps": h.full_sweeps, "lastFullSweepBlocks": h.last_full_sweep_blocks, "maxFullSweepBlocks": h.max_full_sweep_blocks,
        "evalReal": h.eval_real, "evalGone": h.eval_gone, "evalUnknown": h.eval_unknown,
        "slowRoutes": h.slow_routes, "resting": h.resting, "cutFit": h.cut_fit,
        "routes": h.routes, "skippedUnsureLender": h.skipped_unsure_lender,
        "blockUs": crate::timing::pct(&mut ring),
        "syncUs": crate::timing::pct(&mut SYNC_RING.lock().unwrap_or_else(|e| e.into_inner()).iter().copied().collect::<Vec<u64>>()),
    })
}

/// One plain-English hourly line, then start a new hour.
pub fn take_hour() -> String {
    let h = std::mem::take(&mut *HOUR.h.lock().unwrap_or_else(|e| e.into_inner()));
    let line = format!(
        "[fastlane scan] {} blocks, {} routes held, {} routes checked ({} changed-pool, {} sweep), {} found (+{} repeats), {} below minimum, {} no profit, {} unsure answers, {} skipped (unsure pool; {} only for the lender), {} without price facts; best ${}{}; time {} ms (worst block {} ms); full sweep every {} blocks (worst {}, {} passes){}",
        h.blocks, h.routes, h.routes_checked, h.changed_checked, h.sweep_checked, h.found, h.found_dup, h.below_min, h.no_profit, h.unknown, h.skipped_unsure, h.skipped_unsure_lender, h.no_facts,
        h.best_net_usd.map(|v| format!("{v:.2}")).unwrap_or_else(|| "-".into()),
        if h.best_label.is_empty() { String::new() } else { format!(" ({})", h.best_label) },
        h.time_us / 1000, h.max_block_us / 1000,
        h.last_full_sweep_blocks.map(|v| v.to_string()).unwrap_or_else(|| "-".into()), h.max_full_sweep_blocks, h.full_sweeps,
        if h.eval_real + h.eval_gone + h.eval_unknown > 0 { format!("; practice re-checks: {} real, {} gone, {} unsure", h.eval_real, h.eval_gone, h.eval_unknown) } else { String::new() },
    );
    let line = if h.slow_routes + h.resting + h.cut_fit > 0 { format!("{line}; slow routes {} (rested {}, not fitting the budget left {})", h.slow_routes, h.resting, h.cut_fit) } else { line };
    line
}

/// Was anything scanned yet (status shows the section only then)?
pub fn any_activity() -> bool {
    HOUR.h.lock().map(|h| h.blocks > 0).unwrap_or(false)
}

/// Forget the counters (tests).
pub fn reset_hour() {
    *HOUR.h.lock().unwrap_or_else(|e| e.into_inner()) = Hour::default();
    HOUR.ring.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

/// An opportunity as a short JSON record (practice "would send" logs).
pub fn opp_json(o: &Opportunity) -> Value {
    json!({
        "block": o.block, "view": o.view.as_str(), "label": o.route_label, "rid": o.rid, "src": o.source,
        "tokenIn": format!("{:#x}", o.token_in), "amountIn": quantity(o.amount_in), "sizeUsd": o.size_usd,
        "profit": quantity(o.profit_units), "netUsd": o.expected_net_usd, "gasUsd": o.gas_usd, "gasUsed": o.gas_used,
        "loanFeeUsd": o.loan_fee_usd, "flash": o.flash.name(), "pools": o.pools, "scanUs": o.scan_us,
    })
}
