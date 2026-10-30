// ============================================================================
// FAST LANE COPY-2 RUNNER: the scanner's checks run the way the sidecar runs
// every copy-2 check (review H3 / integration item 4).
//
// Plain English:
//   The scanner (scan.rs) asks "does this route pay?" through a CheckRunner.
//   The plain runner just runs the size search on the state it is given.
//   That is exact for most pools, but copy 2 knows a few things the plain
//   run doesn't (copy2/checkview.rs, server.rs copy2_runs):
//     - a V4 PoolManager's coin balances are only known as a proven LOWER
//       BOUND, so a run that reads one is repeated with the balance far
//       higher; the answer stands only if both runs agree exactly,
//     - a V4 protocol-fee counter copy 2 never holds is run as 0 and not 0;
//       the answer stands only if the two differ in gas alone (the higher
//       gas is kept, so profit is never over-stated),
//     - far, empty tick-map words of V4 pools it walked are known zero,
//     - a pool that may still be missing reports of the block ("pending")
//       or that is not ready gives "unknown", never an answer,
//     - the check's CALLER (the bot's sim caller, a plain wallet copy 2
//       never follows) is treated as an empty account, exactly as the
//       sidecar does for every copy-2 check (server.rs caller_as_empty).
//   This runner does exactly that, by calling the SAME code the sidecar
//   uses (server::copy2_runs, the same C2View facts, the same pending /
//   unsure rules), with the size search as the run. So a fast-lane answer
//   on copy 2's state is the answer the bot's own sidecar check would give.
//
//   Works on copy 2's confirmed versions AND on the predicted view (copy2/
//   ahead.rs): the facts are taken for the view's block (pools ready since
//   then), and pending reports of earlier blocks still block an answer.
//
//   ONE CHECK CORE PER BLOCK (Oct 30): every check needs copy 2's "check
//   core" (copy2/checkcore.rs: pending / not-ready pools and the facts).
//   Each route's check used to ask for it (core_for), which REBUILDS it
//   whenever copy 2's pool registry changed since the last build: live
//   ~20 rebuilds a second at ~11 ms each (lane.steps.coreBuild), paid
//   inside route checks, so most routes "didn't fit" the scan budget. Now
//   the scanner says when a block's scan starts and ends (begin_block /
//   end_block): the first check of the block gets a current core, and the
//   block's other checks on the SAME state reuse it. Same rule as before:
//   a core read after the block's version was picked (here: at the first
//   check, so the block's checks all count as made at that moment, which
//   is what the sidecar accepts for any check: checkcore.rs header). Outside
//   a scan (practice re-checks) each check still asks for its own.
//
//   FAST LANE FILLS (Oct 30): a check that answers "miss" names the values
//   copy 2 doesn't hold. The bot's own sidecar checks always asked copy 2
//   to fetch those (server.rs after_pick_with -> fill); the fast lane never
//   did. So a value only fast-lane routes need stayed missing for good, and
//   the same route answered "unknown" every block. Live Oct 30 20:00-20:16:
//   USDG (0x5fc5..) 3,657 misses, the blocklist contract 0xe10b.. 367: e.g.
//   USDG keeps a per-address flag (mapping slot 6) it reads for BOTH sides
//   of every transfer; copy 2 follows balances, not flags, so flag[pool]
//   is held only once some check fetched it. Now the fast lane asks too,
//   paced by FastFillBook (each value at most once per
//   ARBSIM_FASTLANE_FILL_REPEAT_S [120] seconds, at most
//   ARBSIM_FASTLANE_FILL_PER_HOUR [3600] values an hour, the first
//   ARBSIM_FASTLANE_FILL_MAX_ITEMS [8] items of one answer;
//   ARBSIM_FASTLANE_FILL=0 turns it off). A fill is copy 2's ordinary fill:
//   the node's value at a block, placed and refreshed by copy 2's own rules
//   (it refuses what it can't hold exactly). Nothing is guessed: until the
//   value is held, the check keeps answering "unknown".
//   Status fastlane.copy2Runs: fillOffered / fillSent / fillRepeat /
//   fillOverCap; fastlane.copy2Unknown: WHICH value each "miss" stopped on
//   (account + slot) and WHICH pool each "unsure_pool" named (top 10).
//
//   Counted on their own (final review, low): copy 2's PoolManager-bound and
//   protocol-fee counters (pm_bound_*, pm_high_*, protocol_fee_*) are about
//   the BOT's checks. Runs made from here are counted in this file instead
//   (status "fastlane" -> "copy2Runs"), so the fast lane can't blur them.
// ============================================================================
use std::cell::Cell;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use revm::primitives::U256;
use serde_json::{json, Value};

use super::scan::{CheckRunner, PreparedCheck, RunAt};
use crate::arb::BlockCtx;
use crate::check::hexutil::{parse_u256, parse_u64, quantity, quantity_u64};
use crate::check::run::CheckOptions;
use crate::check::search::{size_search_opts, SizeSearchAmounts, SizeSearchBest, SizeSearchResult, SizeTry};
use crate::check::{CheckUnknown, UnknownReason};
use crate::copy2::intake::Copy2Handle;
use crate::state::snap::View;
use crate::state::{MissItem, StateRead};

thread_local! {
    /// True while this thread runs a fast lane check through copy 2's code.
    static IN_FASTLANE: Cell<bool> = const { Cell::new(false) };
}

/// The fast lane's own copy-2 run counters (name -> count), process-wide.
static RUN_STATS: Mutex<BTreeMap<&'static str, u64>> = Mutex::new(BTreeMap::new());

/// copy2/intake.rs note_*: if this thread is running a fast lane check,
/// count `what` here and return true (copy 2's own counter is skipped).
pub fn note_if_fastlane(what: &'static str) -> bool {
    if !IN_FASTLANE.with(|f| f.get()) {
        return false;
    }
    *RUN_STATS.lock().unwrap_or_else(|e| e.into_inner()).entry(what).or_default() += 1;
    true
}

/// The fast lane's copy-2 run counters since start (status).
pub fn stats_json() -> Value {
    let m = RUN_STATS.lock().unwrap_or_else(|e| e.into_inner());
    Value::Object(m.iter().map(|(k, v)| (k.to_string(), json!(v))).collect())
}

/// Add `n` to one of the fast lane's copy-2 counters (status copy2Runs).
fn bump(what: &'static str, n: u64) {
    if n > 0 {
        *RUN_STATS.lock().unwrap_or_else(|e| e.into_inner()).entry(what).or_default() += n;
    }
}

/// (Oct 30) What the fast lane's "unknown" answers stopped on (status
/// fastlane.copy2Unknown): miss -> "account slot", unsure_pool -> the pool
/// copy 2 named. Bounded (coverage.rs Tally).
static UNKNOWN_DETAIL: Mutex<Option<(super::coverage::Tally, super::coverage::Tally)>> = Mutex::new(None);

fn note_unknown_detail(miss: Option<String>, unsure: Option<String>) {
    let mut g = UNKNOWN_DETAIL.lock().unwrap_or_else(|e| e.into_inner());
    let (m, u) = g.get_or_insert_with(Default::default);
    if let Some(k) = miss {
        m.add(k);
    }
    if let Some(k) = unsure {
        u.add(k);
    }
}

/// Status: the top 10 missed values and unsure pools since start.
pub fn unknown_detail_json() -> Value {
    let g = UNKNOWN_DETAIL.lock().unwrap_or_else(|e| e.into_inner());
    match g.as_ref() {
        Some((m, u)) => json!({ "missTop": m.json(10), "unsurePoolTop": u.json(10) }),
        None => json!({ "missTop": {}, "unsurePoolTop": {} }),
    }
}

/// The value a "miss" stopped on, as status text ("0xaccount 0xslot").
fn miss_key(m: &MissItem) -> String {
    match m {
        MissItem::Slot(a, s) => format!("{a:#x} {s:#x}"),
        MissItem::Account(a) => format!("{a:#x} basics"),
        MissItem::Code(h) => format!("code {h:#x}"),
    }
}

/// The pool named in an "unsure_pool" detail ("v3 pool 0x.. is unsure:
/// why" -> "v3 pool 0x.. is unsure: why", cut to 100 characters).
fn unsure_key(detail: &str) -> String {
    detail.chars().take(100).collect()
}

/// (Oct 30) FAST LANE FILLS: which missed values the fast lane asked copy 2
/// to fetch (see the file header). One per copy (Copy2Handle).
#[derive(Debug)]
pub struct FastFillBook {
    pub on: bool,
    /// The same value is asked again at most once per this long.
    pub repeat: Duration,
    /// At most this many values an hour (all routes together).
    pub per_hour: u64,
    /// At most this many items of one answer.
    pub max_items: usize,
    sent: HashMap<MissItem, Instant>,
    order: VecDeque<(MissItem, Instant)>,
    hour_start: Option<Instant>,
    pub hour_used: u64,
}

impl FastFillBook {
    /// Values remembered for the repeat rule (oldest forgotten first).
    pub const REMEMBER: usize = 20_000;

    pub fn new(on: bool, repeat: Duration, per_hour: u64, max_items: usize) -> FastFillBook {
        FastFillBook { on, repeat, per_hour, max_items, sent: HashMap::new(), order: VecDeque::new(), hour_start: None, hour_used: 0 }
    }

    /// Settings from the environment (file header).
    pub fn from_env() -> FastFillBook {
        let num = |k: &str, d: u64| std::env::var(k).ok().and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(d);
        let on = std::env::var("ARBSIM_FASTLANE_FILL").map(|s| s.trim() != "0").unwrap_or(true);
        FastFillBook::new(on, Duration::from_secs(num("ARBSIM_FASTLANE_FILL_REPEAT_S", 120)), num("ARBSIM_FASTLANE_FILL_PER_HOUR", 3600), num("ARBSIM_FASTLANE_FILL_MAX_ITEMS", 8) as usize)
    }

    /// A "miss" answer named these values: the ones to fetch now (counted
    /// in status copy2Runs). Code items are left out (copy 2 fetches code
    /// with the account's basics).
    pub fn offer(&mut self, missing: &[MissItem], now: Instant) -> Vec<MissItem> {
        if !self.on || missing.is_empty() {
            return Vec::new();
        }
        if self.hour_start.is_none_or(|t| now.saturating_duration_since(t) >= Duration::from_secs(3600)) {
            self.hour_start = Some(now);
            self.hour_used = 0;
        }
        let mut out = Vec::new();
        let (mut offered, mut repeat, mut over) = (0u64, 0u64, 0u64);
        for m in missing.iter().filter(|m| !matches!(m, MissItem::Code(_))).take(self.max_items) {
            offered += 1;
            if out.contains(m) {
                continue;
            }
            if self.sent.get(m).is_some_and(|t| now.saturating_duration_since(*t) < self.repeat) {
                repeat += 1;
                continue;
            }
            if self.hour_used >= self.per_hour {
                over += 1;
                continue;
            }
            self.hour_used += 1;
            self.sent.insert(m.clone(), now);
            self.order.push_back((m.clone(), now));
            out.push(m.clone());
        }
        while self.order.len() > Self::REMEMBER {
            if let Some((m, t)) = self.order.pop_front() {
                if self.sent.get(&m) == Some(&t) {
                    self.sent.remove(&m);
                }
            }
        }
        bump("fillOffered", offered);
        bump("fillSent", out.len() as u64);
        bump("fillRepeat", repeat);
        bump("fillOverCap", over);
        out
    }
}

/// Marks this thread as running a fast lane check until dropped.
struct FastlaneRun(bool);
impl FastlaneRun {
    fn enter() -> FastlaneRun {
        FastlaneRun(IN_FASTLANE.with(|f| f.replace(true)))
    }
}
impl Drop for FastlaneRun {
    fn drop(&mut self) {
        let prev = self.0;
        IN_FASTLANE.with(|f| f.set(prev));
    }
}

/// The scanner's runner on copy 2 (see the file header).
pub struct Copy2Runner {
    pub c2: Copy2Handle,
    /// (Oct 30) Inside one block's scan: Some(the core shared by that
    /// block's checks, once the first check got it, with the snapshot and
    /// block it is for). None = not inside a scan (each check gets its own).
    block_core: Mutex<Option<Option<BlockCore>>>,
    /// Times a check asked copy 2 for a core (tests / counting).
    core_asks: std::sync::atomic::AtomicU64,
}

/// One block's shared check core (Copy2Runner::block_core).
/// (Held only until the block's scan ends.)
struct BlockCore {
    snap: Arc<crate::state::snap::Snapshot>,
    block: u64,
    core: Arc<crate::copy2::checkcore::CheckCore>,
}

impl Copy2Runner {
    pub fn new(c2: Copy2Handle) -> Copy2Runner {
        Copy2Runner { c2, block_core: Mutex::new(None), core_asks: std::sync::atomic::AtomicU64::new(0) }
    }

    /// How many times this runner asked copy 2 for a check core.
    pub fn core_asks(&self) -> u64 {
        self.core_asks.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// The check core for a check on `snap` (block `block`): inside a
    /// block's scan the one its first check got (same snapshot and block),
    /// else a current one (file header: ONE CHECK CORE PER BLOCK).
    fn core_for_check(&self, snap: &Arc<crate::state::snap::Snapshot>, block: u64) -> Arc<crate::copy2::checkcore::CheckCore> {
        let mut g = self.block_core.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(Some(bc)) = g.as_ref() {
            if Arc::ptr_eq(&bc.snap, snap) && bc.block == block {
                return bc.core.clone();
            }
        }
        self.core_asks.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let pv = self.c2.sh.published.view();
        let core = self.c2.core_for(Some(&pv));
        if let Some(slot) = g.as_mut() {
            *slot = Some(BlockCore { snap: snap.clone(), block, core: core.clone() });
        }
        core
    }
}

/// A size-search result as the sidecar's JSON answer (handle_size_search's
/// shape, so copy2_runs can compare two runs exactly / merge gas).
pub fn result_json(r: &Result<SizeSearchResult, CheckUnknown>) -> Value {
    match r {
        Ok(r) => json!({
            "ok": true,
            "best": r.best.as_ref().map(|b| json!({ "amount": quantity(b.amount), "profit": quantity(b.profit), "gasUsed": quantity_u64(b.gas_used) })),
            "tried": r.tried.iter().map(|t| json!({
                "amount": quantity(t.amount), "status": t.status, "profit": quantity(t.profit),
                "gasUsed": quantity_u64(t.gas_used), "reason": t.reason,
            })).collect::<Vec<_>>(),
        }),
        Err(u) => {
            let mut v = crate::check::proto_types::unknown_json(&Value::Null, u, 0);
            if let Some(o) = v.as_object_mut() {
                o.remove("us");
            }
            v
        }
    }
}

/// Back from the JSON answer (statuses are the size search's own words).
pub fn result_from_json(v: &Value) -> Result<SizeSearchResult, CheckUnknown> {
    if v.get("ok") != Some(&Value::Bool(true)) {
        let why = v.get("unknown").and_then(|x| x.as_str()).unwrap_or("error");
        let detail = v.get("detail").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let reason = match why {
            "miss" => UnknownReason::Miss,
            "unsupported_precompile" => UnknownReason::UnsupportedPrecompile,
            "bad_request" => UnknownReason::BadRequest,
            "engine_error" => UnknownReason::Engine,
            _ => UnknownReason::Copy2Unsure,
        };
        let mut u = CheckUnknown::new(reason, if reason == UnknownReason::Copy2Unsure { format!("{why}: {detail}") } else { detail });
        if reason == UnknownReason::Miss {
            u.missing = crate::proto::parse_missing(v);
        }
        return Err(u);
    }
    let u256 = |x: &Value| x.as_str().and_then(|s| parse_u256(s).ok()).unwrap_or(U256::ZERO);
    let u64v = |x: &Value| x.as_str().and_then(|s| parse_u64(s).ok()).unwrap_or(0);
    let status = |s: &str| -> &'static str {
        match s {
            "profit" => "profit",
            "loss" => "loss",
            _ => "fail",
        }
    };
    let tried = v
        .get("tried")
        .and_then(|t| t.as_array())
        .map(|a| {
            a.iter()
                .map(|t| SizeTry {
                    amount: u256(&t["amount"]),
                    status: status(t["status"].as_str().unwrap_or("")),
                    profit: u256(&t["profit"]),
                    gas_used: u64v(&t["gasUsed"]),
                    reason: t["reason"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    let best = v.get("best").filter(|b| !b.is_null()).map(|b| SizeSearchBest { amount: u256(&b["amount"]), profit: u256(&b["profit"]), gas_used: u64v(&b["gasUsed"]) });
    Ok(SizeSearchResult { best, tried })
}

impl CheckRunner for Copy2Runner {
    /// Without a snapshot there is nothing for copy 2 to add: the plain run.
    fn run(&self, view: &dyn StateRead, ctx: &BlockCtx, c: &PreparedCheck, amounts: &SizeSearchAmounts) -> Result<SizeSearchResult, CheckUnknown> {
        size_search_opts(view, ctx, &c.overrides, &[], &c.template(), amounts, CheckOptions::default())
    }

    fn run_at(&self, at: &RunAt, c: &PreparedCheck, amounts: &SizeSearchAmounts) -> Result<SizeSearchResult, CheckUnknown> {
        let Some(snap) = at.snap else { return self.run(at.view, at.ctx, c, amounts) };
        let core = self.core_for_check(snap, at.block);
        run_on_copy2_with(&self.c2, &core, snap, at.block, at.ctx, c, amounts)
    }

    fn begin_block(&self) {
        *self.block_core.lock().unwrap_or_else(|e| e.into_inner()) = Some(None);
    }

    fn end_block(&self) {
        *self.block_core.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// One size search on copy 2's snapshot, with copy 2's rules (file header).
pub fn run_on_copy2(c2: &Copy2Handle, snap: &Arc<crate::state::snap::Snapshot>, block: u64, ctx: &BlockCtx, c: &PreparedCheck, amounts: &SizeSearchAmounts) -> Result<SizeSearchResult, CheckUnknown> {
    let pv = c2.sh.published.view();
    let core = c2.core_for(Some(&pv));
    run_on_copy2_with(c2, &core, snap, block, ctx, c, amounts)
}

/// `run_on_copy2` with a check core the caller already has (one per block
/// in a scan: file header). The core must have been read AFTER the version
/// `snap` belongs to was published (core_for at or after that moment).
pub fn run_on_copy2_with(
    c2: &Copy2Handle, core: &crate::copy2::checkcore::CheckCore, snap: &Arc<crate::state::snap::Snapshot>, block: u64, ctx: &BlockCtx, c: &PreparedCheck, amounts: &SizeSearchAmounts,
) -> Result<SizeSearchResult, CheckUnknown> {
    let facts = c2.check_facts_with(core, block);
    let view = View::new(snap.clone());
    let template = c.template();
    // server.rs caller_as_empty: an unknown caller without an override of
    // its own = {balance 0, nonce 0, no code} (the same answer the node
    // gives for the call with that override).
    let from = c.call.from;
    let caller_empty = !c.overrides.accounts.contains_key(&from) && matches!(view.account(from), crate::state::Lookup::Missing);
    let ov_owned;
    let overrides = if caller_empty {
        let mut o = c.overrides.clone();
        o.accounts.insert(
            from,
            crate::check::overrides::AccountOverride { balance: Some(U256::ZERO), nonce: Some(0), code: Some(crate::check::overrides::analysed_code(&[])), ..Default::default() },
        );
        ov_owned = o;
        &ov_owned
    } else {
        &c.overrides
    };
    let run = |v: &dyn StateRead, b: &BlockCtx| result_json(&size_search_opts(v, b, overrides, &[], &template, amounts, CheckOptions::default()));
    let runs = std::cell::RefCell::new(crate::server::RunLog::default());
    let mut answer = {
        let _mark = FastlaneRun::enter();
        crate::server::copy2_runs(c2, &view, &facts, ctx, &runs, &run)
    };
    if answer.get("ok") == Some(&Value::Bool(true)) {
        // A pool on the route may still be missing reports of this block
        // (same rule as server.rs after_pick_with): never answer from it.
        let touched = view.take_touched();
        if let Some(why) = c2.pending_reason_with(core, &touched, block, view.touched_overflow()) {
            answer = json!({ "ok": false, "unknown": "pending_reports", "detail": why });
        }
    } else {
        let missing = crate::proto::parse_missing(&answer);
        if let Some(why) = c2.unsure_reason_with(core, &missing) {
            note_unknown_detail(None, Some(unsure_key(&why)));
            answer = json!({ "ok": false, "unknown": "unsure_pool", "detail": why });
        } else if answer.get("unknown").and_then(|u| u.as_str()) == Some("miss") {
            // (Oct 30) FAST LANE FILLS (file header): ask copy 2 to fetch
            // what this check missed, paced. The answer stays "unknown".
            note_unknown_detail(missing.first().map(miss_key), None);
            let fresh = c2.c2.fastlane_fill.lock().map(|mut b| b.offer(&missing, Instant::now())).unwrap_or_default();
            c2.fill(fresh);
        }
    }
    result_from_json(&answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fastlane_runs_are_counted_apart() {
        assert!(!note_if_fastlane("pmBoundSame"), "outside a fast lane run: copy 2's own counter");
        {
            let _m = FastlaneRun::enter();
            assert!(note_if_fastlane("pmBoundSame"));
            {
                let _inner = FastlaneRun::enter();
            }
            assert!(note_if_fastlane("pmBoundSame"), "nested marks restore the outer one");
        }
        assert!(!note_if_fastlane("pmBoundSame"), "the mark ends with the run");
        assert!(stats_json()["pmBoundSame"].as_u64().unwrap() >= 2);
    }

    /// (Oct 30) The fast lane's fill pacing: each value once per window,
    /// at most `max_items` of one answer, a hard hourly cap, code skipped,
    /// off = nothing asked.
    #[test]
    fn fast_fill_book_paces_what_the_fast_lane_asks_for() {
        use revm::primitives::{Address, B256};
        let a = Address::with_last_byte(5);
        let item = |n: u8| MissItem::Slot(a, U256::from(n));
        let t0 = Instant::now();
        let mut b = FastFillBook::new(true, Duration::from_secs(120), 4, 2);
        assert_eq!(b.offer(&[MissItem::Code(B256::ZERO), item(1), item(2), item(3)], t0), vec![item(1), item(2)], "code skipped, 2 items per answer");
        assert!(b.offer(&[item(1), item(2)], t0 + Duration::from_secs(5)).is_empty(), "same values within the window: not again");
        assert_eq!(b.offer(&[item(1), item(3)], t0 + Duration::from_secs(121)), vec![item(1), item(3)], "after the window: again");
        assert!(b.offer(&[item(4)], t0 + Duration::from_secs(122)).is_empty(), "hourly cap (4) reached");
        assert_eq!(b.offer(&[item(4)], t0 + Duration::from_secs(3700)), vec![item(4)], "a new hour");
        let mut off = FastFillBook::new(false, Duration::from_secs(120), 4, 2);
        assert!(off.offer(&[item(1)], t0).is_empty());
    }

    #[test]
    fn json_round_trip_keeps_every_field() {
        let r = SizeSearchResult {
            best: Some(SizeSearchBest { amount: U256::from(5u8), profit: U256::from(2u8), gas_used: 300_000 }),
            tried: vec![
                SizeTry { amount: U256::from(5u8), status: "profit", profit: U256::from(2u8), gas_used: 300_000, reason: String::new() },
                SizeTry { amount: U256::from(9u8), status: "fail", profit: U256::ZERO, gas_used: 20_000, reason: "0x90b8ec18".into() },
            ],
        };
        assert_eq!(result_from_json(&result_json(&Ok(r.clone()))).unwrap(), r);
        let u = CheckUnknown::new(UnknownReason::Miss, "x");
        assert_eq!(result_from_json(&result_json(&Err(u))).unwrap_err().reason, UnknownReason::Miss);
        let pm = json!({"ok": false, "unknown": "pool_manager_balance", "detail": "differ"});
        let e = result_from_json(&pm).unwrap_err();
        assert_eq!(e.reason, UnknownReason::Copy2Unsure);
        assert!(e.detail.starts_with("pool_manager_balance"));
    }
}
