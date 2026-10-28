// ============================================================================
// FIRE-FIRST OFFLINE REPLAY: `arbsim trig-replay <capture file>`.
//
// Plain English:
//   The build machine has no chain data. The server can record a short
//   stretch of real traffic (copy2/ahead_capture.rs: every feed message and
//   every copy-2 version, in the order arbsim received them, plus, since Oct
//   27, the bot's candidate table in <file>.table.json). This command plays
//   that recording through the fire-first decision Rust now makes by itself
//   (fastlane/trigger.rs), with NO future information: each feed message is
//   judged on the newest copy-2 version that had arrived BEFORE it.
//
//   Per feed message it reports:
//     - COPY LAG: how many blocks the newest confirmed copy-2 version was
//       behind that message (the "report delay" the standing-gap plan needs
//       measured first), and how many feed transactions a check therefore
//       has to replay before the trigger,
//     - per transaction: the bot's quick skip test, then DISCOVERY (the
//       trigger replayed alone on that version with the trigger-first rules,
//       check/ordered.rs, and the pools it moved, check/moved.rs),
//     - with the table: the candidates the bot's picking chooses
//       (check/entry.rs select), each checked like a live candidate (the feed
//       up to the trigger replayed in order, then our trade at the size
//       ladder), the stop rule (entry.rs good_enough), and the trade that
//       would reach the gun (fastlane/trigger.rs opportunity),
//     - each would-fire re-checked later on copy 2's confirmed version of
//       the trigger's block (end of that block; the chain's own state):
//       still profitable there or not,
//     - this machine's time per trigger (p50 / p90 / p99).
//
//   COVERAGE DIAGNOSIS (Oct 27, "fix prediction coverage"; one run should
//   say what to fix). For every transaction asked about:
//     - every "unknown" by WHERE (fastlane/coverage.rs: the trigger itself,
//       a transaction replayed only because copy 2 lags, the trigger's own
//       block, the whole run), by REASON, and by TARGET contract with the
//       role of the first missing item (code / account / slot of the target,
//       the sender, our pool, a coin of our pools, another contract), top 20
//       by count and top 20 by "the chain says it moved our pools";
//     - transactions we couldn't unpack at all (type byte, error), and how
//       many triggers the old rule ("one anywhere in the window fails the
//       whole plan") failed because of them;
//     - "moved none": did our run of the trigger succeed or revert (and why),
//       against the chain's answer;
//     - "moved our pools" / "already in copy": what happened, against the
//       chain's answer;
//     - FULL REPLAY (what each candidate check must do: every transaction
//       from copy 2's version to the trigger, the trigger, the rest of its
//       block): answerable or not, blamed where / why / on which contract,
//       with no skipping and with PROVEN SKIPPING (check/ordered.rs), for
//       every trigger whose own run worked (candidates need the table; this
//       part doesn't);
//     - WITH NO LAG (hindsight): each trigger asked on a lagging version is
//       asked again on the version right before its block once that arrives
//       later in the recording: does the answer change?
//     - WHAT TO WARM: the first missing items that come back (2+ times),
//       with the node requests a one-time fetch would cost.
//   "The chain's answer" (which of our pools a transaction moved) comes from
//   copy 2's pool reports recorded in the capture (CapEv::Moves, known only
//   AFTER the block; used for labels only, never for a decision). A
//   transaction the capture holds no answer for is "not recorded".
//
//   OFFLINE DIFFERENCES (said out loud; all make it MORE cautious, never
//   less): copy 2's V4 PoolManager double runs and "reports pending" rule
//   are not available (a check that needs them answers unknown), the bot's
//   best-effort skipping (FASTLANE_TRIG_SKIP=bot) needs copy 2's route
//   facts and is not applied (proven skipping, the default, needs none),
//   no fills are fetched without --fetch (a miss stays a miss: live
//   fetches some, see WHAT TO WARM), and the safety gates are not applied (a "would reach the gun"
//   count). Nothing is signed or sent. Times are this machine's.
//
//   --fetch (Oct 27, round 2; fastlane/replay_fetch.rs): discovery
//   answers "unknown: miss" / "sender_funds_revert" are asked AGAIN after
//   fetching the missing (or only assumed) values from a node, at the block
//   of the copy version the question was asked on (exact there), free
//   public node first, the paid node only for what it can't give, hard
//   caps on calls. The FETCH section reports every asked trigger's answer
//   after the fetch, what we say about the triggers the chain says moved
//   our pools (known / WRONG / still unknown), the sender-funds reverts with
//   real values, the requests used, and what is still unknown. Every other
//   section stays the recording alone. SELF-ONLY TARGETS (always): unknown
//   triggers whose target contract's code can't reach any other contract
//   (provably "moves none of our pools").
//     --fetch-max N [3000]  calls in total; --fetch-paid on|off [on];
//     --fetch-paid-max N [= --fetch-max]; --fetch-scope all|moved [all]
//     (moved = only triggers the chain says moved our pools: the prize
//     first); --fetch-rounds N [6]; --fetch-url-env NAME (the setting that
//     holds the free node's URL, e.g. ROBINHOOD_RPC_HTTP; ./.env is read).
//
//   `--json` prints the whole result; `--ours <addr,addr>` lists our
//   contract / wallet (skipped like live); `--table <file>` a table message
//   (default <capture>.table.json); `--partial` replays a cut-off capture;
//   `--no-full` skips the FULL REPLAY part (faster). FASTLANE_TRIG_SKIP=bot
//   in the environment replays the old revert rule (see trigger.rs).
// ============================================================================
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use revm::primitives::{Address, B256};
use serde_json::{json, Value};

use super::coverage::{miss_role, origin, Tally};
use super::replay_fetch::{item_calls, item_of, owner_of, proven_untouching, target_code, value_text, Overlay, OverlayProv, ReplayFetcher, TargetCode};
use super::scan::{evaluate, CheckRunner, PreparedCheck};
use super::trigger::{opportunity, quick_skip, TrigCfg};
use super::types::Opportunity;
use crate::arb::BlockCtx;
use crate::check::entry::{call_for, good_enough, select, Table};
use crate::check::feedstore::BinMsg;
use crate::check::moved::{FollowedPool, MovedIndex};
use crate::check::ordered::{build_plan_with, revert_text, run_ordered_with, trigger_only, Assume, OrderedOut, OrderedPlan, Provenance, WireFeed};
use crate::check::{CheckUnknown, TxAt, UnknownReason};
use crate::copy2::ahead_capture::{CapEv, CapFile, ProvSets};
use crate::server::CheckedRow;
use crate::state::snap::{Snapshot, View};
use crate::state::MissItem;

/// Settings of one replay.
#[derive(Clone, Debug, Default)]
pub struct TrigReplayOpts {
    pub ours: Vec<Address>,
    pub samples: usize,
    /// Skip the FULL REPLAY part (see the file header).
    pub no_full: bool,
    /// --warm-sim N: simulate keeping the top N hot targets warm
    /// (copy2/warm.rs) over the capture (needs --fetch).
    pub warm_sim: Option<usize>,
    /// --warm-per-hour: the simulated hourly cap (default 25000).
    pub warm_per_hour: Option<u64>,
}

/// --warm-sim results.
#[derive(Default)]
struct WarmSimReport {
    asked_hot: u64,
    answered: u64,
    chain_moved: Tally,
    chain_none: Tally,
    wrong: Vec<Value>,
    plain_calls: u64,
    moved_by_target: HashMap<Address, u64>,
}

fn pct(v: &mut [u64]) -> Value {
    crate::timing::pct_of(v)
}

fn bump<K: Ord>(m: &mut BTreeMap<K, u64>, k: K) {
    *m.entry(k).or_default() += 1;
}

/// A would-fire waiting for its block's confirmed version.
struct Waiting {
    opp: Opportunity,
    block: u64,
}

/// The chain's answer for one transaction (copy 2's pool reports).
fn chain_says(truth: &HashMap<B256, Option<Vec<String>>>, h: &B256) -> &'static str {
    match truth.get(h) {
        Some(Some(p)) if !p.is_empty() => "chain: moved our pools",
        Some(_) => "chain: moved none",
        None => "chain: not recorded",
    }
}

fn chain_moved(truth: &HashMap<B256, Option<Vec<String>>>, h: &B256) -> bool {
    matches!(truth.get(h), Some(Some(p)) if !p.is_empty())
}

/// One missing item as text (for the warm list).
fn item_text(m: &MissItem) -> String {
    match m {
        MissItem::Code(h) => format!("code {h:#x}"),
        MissItem::Account(a) => format!("account {a:#x}"),
        MissItem::Slot(a, s) => format!("slot {a:#x} {s:#x}"),
    }
}

/// What blocked one target contract (see the file header).
#[derive(Default)]
struct TargetRow {
    n: u64,
    /// ...of which the chain says the blamed transaction moved our pools.
    chain_moved: u64,
    why: Tally,
    first: Tally,
}

impl TargetRow {
    fn json(&self, target: &str) -> Value {
        json!({"target": target, "n": self.n, "chainMovedOurPools": self.chain_moved, "why": self.why.json(4), "firstMissing": self.first.json(3)})
    }
}

/// Every "unknown" of one stage (discovery / full replay), attributed.
#[derive(Default)]
struct Blame {
    n: u64,
    by_where: Tally,
    by_target: HashMap<String, TargetRow>,
    first_role: Tally,
    /// First missing item -> times (the warm list).
    items: Tally,
    /// The blamed transaction's chain answer.
    chain: Tally,
}

impl Blame {
    #[allow(clippy::too_many_arguments)]
    fn add(&mut self, u: &CheckUnknown, trigger_seq: u64, trigger: &TxAt, truth: &HashMap<B256, Option<Vec<String>>>, pools: &HashSet<Address>, coins: &HashSet<Address>) {
        self.n += 1;
        let reason = u.reason.as_str();
        // No transaction named: the plan / the run as a whole (the trigger's
        // own target is the best name for it).
        let at = u.at.unwrap_or(*trigger);
        let place = origin(u.at.as_ref(), trigger_seq);
        self.by_where.add(format!("{place}|{reason}"));
        let target = match (at.to, at.tx_type) {
            (Some(t), _) => format!("{t:#x}"),
            (None, None) => "(not unpacked)".into(),
            (None, Some(_)) => "(contract creation)".into(),
        };
        let row = self.by_target.entry(target).or_default();
        row.n += 1;
        let moved = chain_moved(truth, &at.hash);
        if moved {
            row.chain_moved += 1;
        }
        self.chain.add(chain_says(truth, &at.hash));
        let detail_kind = if reason == "sender_funds_revert" || reason == "replay_watch" || reason == "unsupported_tx" { format!("{reason}: {}", short_detail(&u.detail)) } else { reason.to_string() };
        row.why.add(format!("{place}|{detail_kind}"));
        if let Some(m) = u.missing.first() {
            let role = miss_role(m, Some(&at), &|a| pools.contains(&a), &|a| coins.contains(&a));
            row.first.add(role.clone());
            self.first_role.add(role);
            self.items.add(item_text(m));
        }
    }

    fn json(&self, n: usize) -> Value {
        let mut rows: Vec<(&String, &TargetRow)> = self.by_target.iter().collect();
        rows.sort_by(|a, b| b.1.n.cmp(&a.1.n).then(a.0.cmp(b.0)));
        let by_count: Vec<Value> = rows.iter().take(n).map(|(k, r)| r.json(k)).collect();
        rows.sort_by(|a, b| b.1.chain_moved.cmp(&a.1.chain_moved).then(b.1.n.cmp(&a.1.n)).then(a.0.cmp(b.0)));
        let by_moved: Vec<Value> = rows.iter().filter(|(_, r)| r.chain_moved > 0).take(n).map(|(k, r)| r.json(k)).collect();
        json!({"n": self.n, "where": self.by_where.json(30), "firstMissing": self.first_role.json(12), "chainSaysBlamedTx": self.chain.json(4),
            "targets": self.by_target.len(), "topByCount": by_count, "topByChainMovedOurPools": by_moved})
    }
}

/// The interesting part of a detail (addresses / hashes cut, so the same
/// kind of revert groups together).
fn short_detail(d: &str) -> String {
    let mut out = String::new();
    for w in d.split_whitespace() {
        let w = if w.trim_start_matches(['(', '"']).starts_with("0x") && w.len() > 12 { "0x.." } else { w };
        if out.len() + w.len() > 90 {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(w);
    }
    out
}

/// One discovery answer, as a short key (for the no-lag comparison).
fn outcome_key(r: &Result<(OrderedOut, Vec<String>), CheckUnknown>) -> String {
    match r {
        Ok((_, p)) if !p.is_empty() => format!("moved {}", p.join(",")),
        Ok((o, _)) if o.replayed.first().is_some_and(|x| !x.outcome.success) => "moved none (trigger reverted)".into(),
        Ok(_) => "moved none".into(),
        Err(u) => format!("unknown {}", u.reason.as_str()),
    }
}

/// A trigger asked on a lagging version, asked again with no lag later.
struct NoLag {
    msg: Arc<BinMsg>,
    hash: B256,
    before: String,
}

/// One discovery answer, as (kind, pools) for the --fetch comparison.
fn fx_class(r: &Result<(OrderedOut, Vec<String>), CheckUnknown>) -> (String, Vec<String>) {
    match r {
        Ok((_, p)) if !p.is_empty() => ("moved our pools".into(), p.clone()),
        Ok((o, _)) if o.replayed.first().is_some_and(|x| !x.outcome.success) => ("moved none (trigger reverted)".into(), Vec::new()),
        Ok(_) => ("moved none (trigger ran)".into(), Vec::new()),
        Err(u) => (format!("unknown {}", u.reason.as_str()), Vec::new()),
    }
}

/// SELF-ONLY TARGETS (replay_fetch.rs): unknown triggers whose target's
/// code can't reach another contract.
#[derive(Default)]
struct SelfOnly {
    /// Unknown triggers by their target's code kind.
    kinds: Tally,
    /// ...of which the rule "self-only target, not ours" would answer
    /// "moved none", and how many of those the chain says moved our pools
    /// (must be 0: the rule is a proof).
    rule: u64,
    rule_chain_moved: u64,
    /// target -> (kind, unknown triggers, chain moved).
    targets: HashMap<String, (TargetCode, u64, u64)>,
}

impl SelfOnly {
    fn add(&mut self, view: &View, dec: &crate::check::rawtx::DecodedTx, moved: bool, is_ours: &dyn Fn(Address) -> bool) {
        let kind = match dec.to {
            Some(t) => target_code(view, t),
            None => return,
        };
        self.kinds.add(kind.as_str());
        if proven_untouching(view, dec, is_ours) {
            self.rule += 1;
            self.rule_chain_moved += moved as u64;
        }
        let e = self.targets.entry(format!("{:#x}", dec.to.unwrap_or_default())).or_insert((kind, 0, 0));
        e.0 = kind;
        e.1 += 1;
        e.2 += moved as u64;
    }

    fn json(&self) -> Value {
        let mut rows: Vec<(&String, &(TargetCode, u64, u64))> = self.targets.iter().collect();
        rows.sort_by(|a, b| b.1 .1.cmp(&a.1 .1).then(a.0.cmp(b.0)));
        json!({"unknownTriggersByTargetCode": self.kinds.json(8), "ruleWouldAnswerMovedNone": self.rule, "ofWhichChainSaysMoved": self.rule_chain_moved,
            "topTargets": rows.iter().take(20).map(|(t, (k, n, m))| json!({"target": t, "code": k.as_str(), "n": n, "chainMovedOurPools": m})).collect::<Vec<_>>(),
            "note": "rule = the trigger's target contract has no opcode that can reach another contract and isn't one of our pools / their coins: it provably can't move our pools (any storage). ofWhichChainSaysMoved must be 0"})
    }
}

/// WARM COST (--fetch, Oct 27 round 3): what keeping the needed values
/// warm would cost. Per item: every value fetched for it (block, value).
/// Per asked-again trigger: its target and the values it needed.
#[derive(Default)]
struct Warm {
    hist: HashMap<MissItem, Vec<(u64, String)>>,
    trigs: Vec<WarmTrig>,
}

struct WarmTrig {
    target: Option<Address>,
    /// Block of the copy version its values were fetched at.
    block: u64,
    items: Vec<(MissItem, String)>,
    /// Answered (moved / moved none) after the fetch.
    covered: bool,
    chain_moved: bool,
}

impl Warm {
    fn note(&mut self, item: &MissItem, block: u64, v: &str) {
        let h = self.hist.entry(item.clone()).or_default();
        if !h.iter().any(|(b, _)| *b == block) {
            h.push((block, v.to_string()));
            h.sort_by_key(|x| x.0);
        }
    }

    fn changing(&self, item: &MissItem) -> bool {
        self.hist.get(item).is_some_and(|h| h.iter().any(|(_, v)| *v != h[0].1))
    }

    /// Would a warm copy have held this trigger's values with NO fetch at
    /// decision time? (strict: the newest earlier value is the same, or the
    /// value never changes in the capture; touch: also when it changed but a
    /// feed transaction to its contract came in between, so a refresh on
    /// that evidence would have caught it.)
    fn no_fetch(&self, t: &WarmTrig, l2: u64, touches: &HashMap<Address, Vec<u64>>) -> (bool, bool) {
        let (mut strict, mut touch) = (true, true);
        for (it, v) in &t.items {
            let Some(h) = self.hist.get(it) else { continue };
            if !h.iter().any(|(_, x)| x != v) {
                continue; // never changes in the capture
            }
            let prev = h.iter().rev().find(|(b, _)| *b < t.block);
            match prev {
                Some((_, pv)) if pv == v => {}
                Some((pb, _)) => {
                    strict = false;
                    let (from, to) = (pb.saturating_sub(l2), t.block.saturating_sub(l2));
                    let seen = owner_of(it).and_then(|o| touches.get(&o)).is_some_and(|ts| ts.iter().any(|s| *s > from && *s <= to));
                    if !seen {
                        touch = false;
                    }
                }
                None => {
                    strict = false;
                    touch = false;
                }
            }
        }
        (strict, touch)
    }

    fn json(&self, l2: u64, touches: &HashMap<Address, Vec<u64>>, dur_s: f64, calls_now: u64) -> Value {
        let h = (dur_s / 3600.0).max(1e-9);
        let kind = |m: &MissItem| match m {
            MissItem::Slot(..) => "slot",
            MissItem::Account(_) => "account (balance, nonce, code)",
            MissItem::Code(_) => "code",
        };
        let mut kinds = Tally::default();
        let (mut once, mut steady, mut changing) = (0u64, 0u64, 0u64);
        let mut by_owner: HashMap<Address, (u64, u64)> = HashMap::new();
        for (it, hist) in &self.hist {
            kinds.add(kind(it));
            let ch = self.changing(it);
            if hist.len() == 1 {
                once += 1;
            } else if ch {
                changing += 1;
            } else {
                steady += 1;
            }
            if let Some(o) = owner_of(it) {
                let e = by_owner.entry(o).or_default();
                e.0 += 1;
                e.1 += ch as u64;
            }
        }
        let mut owners: Vec<(Address, (u64, u64))> = by_owner.into_iter().collect();
        owners.sort_by(|a, b| b.1 .0.cmp(&a.1 .0).then(a.0.cmp(&b.0)));
        // Targets ranked by triggers the fetch made answerable.
        let mut per: HashMap<Address, (u64, u64)> = HashMap::new();
        for t in self.trigs.iter().filter(|t| t.covered) {
            if let Some(a) = t.target {
                let e = per.entry(a).or_default();
                e.0 += 1;
                e.1 += t.chain_moved as u64;
            }
        }
        let mut rank: Vec<(Address, (u64, u64))> = per.into_iter().collect();
        rank.sort_by(|a, b| b.1 .1.cmp(&a.1 .1).then(b.1 .0.cmp(&a.1 .0)).then(a.0.cmp(&b.0)));
        let mut curve = Vec::new();
        for n in [1usize, 3, 5, 10, 20, usize::MAX] {
            let top: HashSet<Address> = rank.iter().take(n).map(|x| x.0).collect();
            if n != usize::MAX && n > rank.len() && n != 1 {
                continue;
            }
            let trigs: Vec<&WarmTrig> = self.trigs.iter().filter(|t| t.covered && t.target.is_some_and(|a| top.contains(&a))).collect();
            let mut items: HashSet<&MissItem> = HashSet::new();
            for t in &trigs {
                items.extend(t.items.iter().map(|(i, _)| i));
            }
            let once_calls: u64 = items.iter().map(|i| item_calls(i)).sum();
            let ch: Vec<&&MissItem> = items.iter().filter(|i| self.changing(i)).collect();
            let ch_calls: u64 = ch.iter().map(|i| item_calls(i)).sum();
            let touch_calls: f64 = ch.iter().map(|i| owner_of(i).and_then(|o| touches.get(&o)).map_or(0, |v| v.len()) as f64 * item_calls(i) as f64).sum();
            let nf: Vec<(bool, bool)> = trigs.iter().map(|t| self.no_fetch(t, l2, touches)).collect();
            let share = |k: usize| if nf.is_empty() { 0.0 } else { (nf.iter().filter(|x| if k == 0 { x.0 } else { x.1 }).count() as f64 / nf.len() as f64 * 1000.0).round() / 10.0 };
            curve.push(json!({
                "topTargets": if n == usize::MAX { json!("all") } else { json!(n) },
                "triggersCovered": trigs.len(), "ofWhichChainMovedOurPools": trigs.iter().filter(|t| t.chain_moved).count(),
                "distinctItems": items.len(), "oneTimeCalls": once_calls, "itemsThatChange": ch.len(),
                "refreshOnTouchCallsPerHour": (touch_calls / h).round() as u64, "timer1sCallsPerHour": ch_calls * 3600, "timer10sCallsPerHour": ch_calls * 360,
                "noFetchAtDecisionPct": {"strict": share(0), "withRefreshOnTouch": share(1)},
            }));
        }
        json!({
            "captureSeconds": dur_s, "fetchOnDemandCallsPerHour": (calls_now as f64 / h).round() as u64,
            "distinctItems": self.hist.len(), "byKind": kinds.json(4),
            "itemsSeenAtOneBlockOnly": once, "itemsSameAtEveryBlock": steady, "itemsThatChange": changing,
            "topContracts": owners.iter().take(12).map(|(a, (n, c))| json!({"contract": format!("{a:#x}"), "items": n, "change": c, "feedTxsToIt": touches.get(a).map_or(0, |v| v.len())})).collect::<Vec<_>>(),
            "topTargets": rank.iter().take(20).map(|(a, (n, m))| json!([format!("{a:#x}"), n, m])).collect::<Vec<_>>(),
            "curve": curve,
            "note": "items = values the asked-again triggers needed (fetched at their copy version's block); 'change' = two different values at two blocks of the capture (an item seen at one block only counts as unchanging: optimistic); refresh on touch = re-read a changing item after every feed transaction TO its contract (misses changes made by calls from elsewhere, e.g. a coin balance moved through a router); timer = re-read every changing item every 1 s / 10 s; values fetched for the AT ITS OWN POSITION runs count as observations too; noFetchAtDecision = covered triggers whose every value a warm copy would already have held",
        })
    }
}

/// --fetch results (see replay_fetch.rs).
#[derive(Default)]
struct FetchReport {
    warm: Warm,
    /// AT ITS OWN POSITION: WRONG answers / correct ones (control) asked
    /// again on values fetched at the end of the block before the trigger.
    own_wrong: Tally,
    own_control: Tally,
    own_control_n: usize,
    /// Unknown discovery answers (miss / sender funds) the fetch was tried on.
    tried: u64,
    skipped_scope: u64,
    skipped_cap: u64,
    rounds: Vec<u64>,
    /// Every asked trigger's final answer (fetched where tried).
    after: Tally,
    /// Tried: "before -> after".
    change: Tally,
    /// Triggers the chain says moved our pools: what we say after the fetch.
    chain_moved: Tally,
    /// Triggers the chain says moved none of our pools: what we say.
    chain_none: Tally,
    /// Sender-funds reverts: what the real sender values give.
    sender: Tally,
    wrong: Vec<Value>,
    blame: Blame,
    self_only: SelfOnly,
}

/// Replay the capture (see the file header). `table`: the bot's table
/// messages (None = discovery only).
pub fn trig_replay(cap: &CapFile, table: Option<&Table>, cfg: &TrigCfg, opts: &TrigReplayOpts) -> Result<Value, String> {
    trig_replay_with(cap, table, cfg, opts, None)
}

/// trig_replay, with --fetch (`fetcher`: values the recording didn't hold
/// are fetched at the copy version's block and the question asked again).
pub fn trig_replay_with(cap: &CapFile, table: Option<&Table>, cfg: &TrigCfg, opts: &TrigReplayOpts, mut fetcher: Option<&mut ReplayFetcher>) -> Result<Value, String> {
    let t_all = Instant::now();
    let Some(CapEv::Header { l2_offset, .. }) = cap.events.first().cloned() else {
        return Err("the capture does not start with its settings".into());
    };
    let mut cfg = cfg.clone();
    cfg.l2_offset = l2_offset;
    let mut ours = cfg.ours.clone();
    ours.extend(opts.ours.iter().copied());
    // The chain's answers (hindsight, labels only; see the file header).
    let mut truth: HashMap<B256, Option<Vec<String>>> = HashMap::new();
    for ev in &cap.events {
        if let CapEv::Moves(v) = ev {
            for (h, r) in v {
                let e = truth.entry(*h).or_insert(None);
                if r.as_ref().is_some_and(|p| !p.is_empty()) || e.is_none() {
                    *e = Some(r.clone().unwrap_or_default());
                }
            }
        }
    }
    let mut prov: Arc<dyn Provenance + Send + Sync> = Arc::new(ProvSets::all_exact());
    let mut index = MovedIndex::build(&[]);
    let mut pools_n = 0usize;
    let (mut pool_addrs, mut coin_addrs): (HashSet<Address>, HashSet<Address>) = (HashSet::new(), HashSet::new());
    // The scanner's route pools, newest seen in the capture (None = arbsim held
    // NO candidate table then: the zero-routes symptom).
    let mut route_pools: Option<usize> = None;
    // The newest confirmed version received so far (seq, ctx, snapshot).
    let mut copy: Option<(u64, BlockCtx, Arc<Snapshot>)> = None;
    // Feed messages received so far, by sequence number (bounded).
    let mut held: BTreeMap<u64, Arc<BinMsg>> = BTreeMap::new();
    let mut seen: HashSet<B256> = HashSet::new();
    let mut waiting: Vec<Waiting> = Vec::new();
    let mut codes_cache = HashMap::new();
    // Counters.
    let (mut msgs, mut msgs_no_copy, mut txs, mut asked, mut moved, mut no_pools, mut too_many, mut in_copy, mut repeats) = (0u64, 0u64, 0u64, 0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
    let (mut no_cands, mut routes_checked, mut sure, mut good, mut would_fire) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let (mut real, mut gone, mut recheck_unknown) = (0u64, 0u64, 0u64);
    let mut skipped: BTreeMap<&'static str, u64> = BTreeMap::new();
    let mut disc_unknown: BTreeMap<String, u64> = BTreeMap::new();
    let mut answer_unknown: BTreeMap<String, u64> = BTreeMap::new();
    let mut not_trade: BTreeMap<&'static str, u64> = BTreeMap::new();
    let mut lag_blocks: Vec<u64> = Vec::new();
    let mut lag_ahead = 0u64; // messages the copy already held when they arrived
    let mut lag_txs: Vec<u64> = Vec::new(); // txs replayed only because of the lag, per asked trigger
    let mut trig_us: Vec<u64> = Vec::new();
    let mut fires: Vec<Value> = Vec::new();
    // Coverage diagnosis (see the file header).
    let mut disc_blame = Blame::default();
    let mut unreadable: Tally = Tally::default(); // "first byte | error"
    let mut unreadable_seen: HashSet<B256> = HashSet::new();
    let mut old_rule_failed = 0u64; // asked triggers the old plan rule failed (unsupported_tx / unreplayable)
    let mut type4 = 0u64;
    let mut none_split = Tally::default(); // moved none: our run x chain
    let mut none_reverts = Tally::default(); // moved none, trigger reverted: why
    let mut moved_vs_chain = Tally::default();
    let mut moved_samples: Vec<Value> = Vec::new();
    let mut in_copy_chain = Tally::default();
    let mut full_strict = Blame::default();
    let mut full_proven = Blame::default();
    let (mut full_n, mut full_ok_strict, mut full_ok_proven) = (0u64, 0u64, 0u64);
    let mut proven_skipped: Vec<u64> = Vec::new();
    let mut no_lag: BTreeMap<u64, Vec<NoLag>> = BTreeMap::new();
    let mut no_lag_out = Tally::default();
    let mut no_lag_missing = 0u64;
    let mut cand_where = Tally::default();
    // SELF-ONLY TARGETS on the recording alone (no fetch), and --fetch.
    let mut self_only_base = SelfOnly::default();
    let mut fxr = FetchReport::default();
    let mut overlay: Option<Overlay> = None;
    // --warm-sim (copy2/warm.rs over the capture).
    let mut ws: Option<crate::copy2::warm::WarmState> = match (opts.warm_sim, fetcher.is_some()) {
        (Some(n), true) => Some(crate::copy2::warm::WarmState::new(crate::copy2::warm::WarmCfg { on: true, targets: n, per_hour: opts.warm_per_hour.unwrap_or(25_000), ..Default::default() })),
        (Some(_), false) => return Err("--warm-sim needs --fetch (the values come from the node)".into()),
        _ => None,
    };
    let mut wsr = WarmSimReport::default();
    let mut sim_now = 0.0f64;
    let mut ts_first: Option<u64> = None;
    // Feed transactions to each contract (seq), and the capture's time span.
    let mut touches: HashMap<Address, Vec<u64>> = HashMap::new();
    let (mut ts_min, mut ts_max) = (u64::MAX, 0u64);
    let sender_funds = cfg.assume.iter().any(|a| a == "sender_funds") && !cfg.strict;
    let recent_fill = cfg.assume.iter().any(|a| a == "recent_fill") && !cfg.strict;
    let skip_allowed = cfg.assume.iter().any(|a| a == "skip") && !cfg.strict;
    // Discovery: as live (server.rs trig_discover, the fast lane's question).
    let assume = Assume { sender_funds, recent_fill, skip: None, record_hashes: true, proven_skip: cfg.proven_skip && skip_allowed };
    // Candidate checks: as live, except the bot's best-effort skipping (needs
    // copy 2's route facts; see OFFLINE DIFFERENCES).
    let cand_assume = Assume { record_hashes: false, ..assume.clone() };
    // Full replay: with no skipping, and with proven skipping.
    let strict_full = Assume { sender_funds, recent_fill, skip: None, record_hashes: false, proven_skip: false };
    let proven_full = Assume { proven_skip: true, ..strict_full.clone() };
    let discover = |view: &View, alone: &OrderedPlan, prov: &dyn Provenance, index: &MovedIndex| -> Result<(OrderedOut, Vec<String>), CheckUnknown> {
        let out = run_ordered_with(view, alone, &crate::check::Overrides::none(), &[], prov, true, &assume)?;
        let pools: Vec<String> = index.moved(&out.changed, &out.hashes).into_iter().map(|p| p.key.to_ascii_lowercase()).collect();
        Ok((out, pools))
    };
    for ev in &cap.events[1..] {
        match ev {
            CapEv::Pools { list, .. } => {
                let fps: Vec<FollowedPool> = list.iter().map(|(p, _, _)| p.clone()).collect();
                pools_n = fps.len();
                index = MovedIndex::build(&fps);
                pool_addrs = list.iter().map(|(p, _, _)| p.address).collect();
                coin_addrs = list.iter().flat_map(|(_, a, b)| [*a, *b]).collect();
            }
            CapEv::Prov(p) => prov = p.clone(),
            CapEv::Routes(r) => route_pools = r.as_ref().map(|v| v.len()),
            CapEv::Confirmed { seq, ctx, snap } => {
                let Some(ctx) = ctx.clone() else { continue };
                copy = Some((*seq, ctx.clone(), snap.clone()));
                // --warm-sim: the keeper's turn (fetch at this version's block).
                if let (Some(w), Some(f)) = (ws.as_mut(), fetcher.as_deref_mut()) {
                    w.sweep(sim_now);
                    let due: Vec<MissItem> = w.due(sim_now, l2_offset).into_iter().filter(|m| crate::copy2::warm::owner(m).is_none_or(|o| !pool_addrs.contains(&o))).collect();
                    if !due.is_empty() {
                        let calls = crate::copy2::loader::count_calls(&due, &[]);
                        let (req, plain) = crate::copy2::warm::job_cost(&due);
                        if w.charge(calls, req, sim_now) {
                            wsr.plain_calls += plain;
                            let block = *seq + l2_offset;
                            let got = f.fetch(block, &due, snap);
                            let res: Vec<(MissItem, Option<crate::node::Fetched>)> = due.iter().map(|m| (m.clone(), got.iter().find(|g| item_of(g) == *m).cloned())).collect();
                            w.store(block, sim_now, &res);
                        } else {
                            w.cap_hit(&due, sim_now);
                        }
                    }
                }
                // Would-fires whose block is now confirmed: re-checked at its end.
                let block = *seq + l2_offset;
                let view = View::new(snap.clone());
                waiting.retain(|w| {
                    if w.block != block {
                        return w.block > block;
                    }
                    let ev = evaluate(&w.opp, &ReplayRunner, &view, &ctx, cfg.min_net_usd);
                    match ev.real {
                        Some(true) => real += 1,
                        Some(false) => gone += 1,
                        None => recheck_unknown += 1,
                    }
                    false
                });
                // WITH NO LAG (hindsight): triggers of block seq+1 asked on
                // an older version, asked again on this one.
                let older: Vec<u64> = no_lag.range(..*seq).map(|(k, _)| *k).collect();
                for k in older {
                    no_lag_missing += no_lag.remove(&k).map_or(0, |v| v.len() as u64);
                }
                if let Some(list) = no_lag.remove(seq) {
                    for p in list {
                        let refs = vec![(p.msg.seq, p.msg.txs.len())];
                        let feed = WireFeed { trigger: format!("{:#x}", p.hash), trigger_seq: p.msg.seq, msgs: vec![], route: vec![], strict: cfg.strict, assume: Some(cfg.feed_assume()), refs: Some(refs) };
                        let after = match build_plan_with(&feed, Some(std::slice::from_ref(&p.msg)), *seq, l2_offset, &ctx) {
                            Ok((plan, _)) => match trigger_only(&plan) {
                                Some((alone, _)) => outcome_key(&discover(&view, &alone, prov.as_ref(), &index)),
                                None => "already in copy".into(),
                            },
                            Err(u) => format!("unknown {}", u.reason.as_str()),
                        };
                        let kind = |k: &str| k.split(' ').next().unwrap_or("").to_string();
                        no_lag_out.add(if after == p.before { "same answer".to_string() } else { format!("{} -> {}", kind(&p.before), kind(&after)) });
                    }
                }
            }
            CapEv::Feed(m) => {
                msgs += 1;
                ts_min = ts_min.min(m.ts);
                ts_max = ts_max.max(m.ts);
                let t0s = *ts_first.get_or_insert(m.ts);
                sim_now = sim_now.max(m.ts.saturating_sub(t0s) as f64);
                for t in &m.txs {
                    if let Ok(d) = t.decoded() {
                        if let Some(to) = d.to {
                            touches.entry(to).or_default().push(m.seq);
                            if let Some(w) = ws.as_mut() {
                                w.touch(to, m.seq);
                            }
                        }
                    }
                }
                held.insert(m.seq, m.clone());
                while held.len() > 256 {
                    let k = *held.keys().next().expect("non-empty");
                    held.remove(&k);
                }
                // Transactions we can't unpack at all (counted once each).
                for t in &m.txs {
                    match t.decoded() {
                        Err(e) => {
                            if unreadable_seen.insert(t.hash) {
                                let b = t.raw.first().map(|b| format!("first byte 0x{b:02x}")).unwrap_or_else(|| "empty".into());
                                unreadable.add(format!("{b} | {}", e.chars().take(60).collect::<String>()));
                            }
                        }
                        Ok(d) if d.tx_type == 4 && unreadable_seen.insert(t.hash) => type4 += 1,
                        Ok(_) => {}
                    }
                }
                let Some((cseq, cctx, csnap)) = copy.clone() else {
                    msgs_no_copy += 1;
                    continue;
                };
                if m.seq > cseq {
                    lag_blocks.push(m.seq - cseq);
                } else {
                    lag_ahead += 1;
                }
                if !m.complete || m.bad.is_some() {
                    continue;
                }
                let view = View::new(csnap.clone());
                for t in &m.txs {
                    txs += 1;
                    let dec = t.decoded();
                    let skip = match &dec {
                        Ok(d) => quick_skip(d, &ours),
                        Err(_) => Some("unreadable"),
                    };
                    if let Some(why) = skip {
                        bump(&mut skipped, why);
                        continue;
                    }
                    let Ok(dec) = dec else { continue };
                    if !seen.insert(t.hash) {
                        repeats += 1;
                        continue;
                    }
                    asked += 1;
                    let t0 = Instant::now();
                    let me = TxAt { seq: m.seq, hash: t.hash, to: dec.to, from: Some(dec.from), tx_type: Some(dec.tx_type), trigger: true };
                    // The messages a bot question would name, from those held NOW.
                    let newest = *held.keys().next_back().expect("just inserted");
                    let mut from = m.seq.min(cseq).saturating_sub(cfg.back_msgs);
                    from = from.max(newest.saturating_sub(cfg.max_msgs.saturating_sub(1)));
                    let list: Vec<Arc<BinMsg>> = held.range(from..=newest).map(|(_, x)| x.clone()).collect();
                    let refs: Vec<(u64, usize)> = list.iter().map(|x| (x.seq, x.txs.len())).collect();
                    let feed = WireFeed { trigger: format!("{:#x}", t.hash), trigger_seq: m.seq, msgs: vec![], route: vec![], strict: cfg.strict, assume: Some(cfg.feed_assume()), refs: Some(refs) };
                    let (plan, info) = match build_plan_with(&feed, Some(&list), cseq, l2_offset, &cctx) {
                        Ok(x) => x,
                        Err(u) => {
                            fxr.after.add(format!("unknown {}", u.reason.as_str()));
                            bump(&mut disc_unknown, u.reason.as_str().to_string());
                            disc_blame.add(&u, m.seq, &me, &truth, &pool_addrs, &coin_addrs);
                            continue;
                        }
                    };
                    if !plan.unrunnable.is_empty() {
                        old_rule_failed += 1;
                    }
                    lag_txs.push(plan.msgs.iter().filter(|x| x.seq < m.seq).map(|x| x.txs.len() as u64).sum::<u64>() + plan.unrunnable.iter().filter(|x| x.seq < m.seq).count() as u64);
                    let Some((alone, _others)) = trigger_only(&plan) else {
                        in_copy += 1;
                        fxr.after.add("already in copy");
                        // Live answers the pools copy 2's reports say it moved (server.rs GAP FIX 1).
                        in_copy_chain.add(chain_says(&truth, &t.hash));
                        continue;
                    };
                    let r = discover(&view, &alone, prov.as_ref(), &index);
                    let is_ours = |a: Address| pool_addrs.contains(&a) || coin_addrs.contains(&a);
                    let chain_did = chain_moved(&truth, &t.hash);
                    // --warm-sim: a hot target's trigger, answered from the warm
                    // values only (no fetch at decision time).
                    if let (Some(w), Some(to)) = (ws.as_mut(), dec.to) {
                        if w.is_hot(&to) {
                            wsr.asked_hot += 1;
                            let before: Vec<(u64, Option<Address>)> = plan.msgs.iter().flat_map(|x| x.txs.iter().map(move |y| (x.seq, y.to, y.hash))).take_while(|x| x.2 != t.hash).map(|(a, b, _)| (a, b)).collect();
                            let rw = match w.layer(&csnap, sim_now, l2_offset, m.seq, &before) {
                                Some(l) => {
                                    let pv = crate::copy2::warm::WarmProv { inner: prov.clone(), layer: l.clone() };
                                    discover(&View::new(l.snap.clone()), &alone, &pv, &index)
                                }
                                None => discover(&view, &alone, prov.as_ref(), &index),
                            };
                            if let Err(u) = &rw {
                                if u.reason == UnknownReason::Miss {
                                    w.learn(to, &u.missing);
                                }
                            }
                            let (kind, pools) = fx_class(&rw);
                            let chain_pools: Vec<String> = truth.get(&t.hash).cloned().flatten().unwrap_or_default().iter().map(|p| p.to_ascii_lowercase()).collect();
                            let unknown = kind.starts_with("unknown");
                            if !unknown {
                                wsr.answered += 1;
                            }
                            let v = if unknown {
                                format!("still {kind}")
                            } else if pools.is_empty() {
                                "we say moved none".into()
                            } else if chain_pools.is_empty() {
                                "we say moved".into()
                            } else if pools.iter().all(|p| chain_pools.contains(p)) && chain_pools.iter().all(|p| pools.contains(p)) {
                                "known: same pools".into()
                            } else {
                                "known: other pools".into()
                            };
                            if chain_did {
                                let v = if v == "we say moved none" { "WRONG: we say moved none".to_string() } else { v };
                                if v.starts_with("WRONG") && wsr.wrong.len() < 10 {
                                    wsr.wrong.push(json!({"trigger": format!("{:#x}", t.hash), "to": format!("{to:#x}"), "chainPools": chain_pools, "copyLagBlocks": m.seq.saturating_sub(cseq)}));
                                }
                                wsr.chain_moved.add(v);
                            } else if truth.contains_key(&t.hash) {
                                if v == "we say moved" && wsr.wrong.len() < 10 {
                                    wsr.wrong.push(json!({"trigger": format!("{:#x}", t.hash), "to": format!("{to:#x}"), "we": pools, "chain": "moved none of our pools"}));
                                }
                                wsr.chain_none.add(v);
                            }
                        }
                        // Hot = the chain showed its transactions moving our pools
                        // (known after the block: counted after the decision).
                        if chain_did {
                            *wsr.moved_by_target.entry(to).or_default() += 1;
                            let mut v: Vec<(&Address, &u64)> = wsr.moved_by_target.iter().collect();
                            v.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
                            let list: Vec<Address> = v.into_iter().map(|x| *x.0).collect();
                            w.set_hot(&list);
                        }
                    }
                    if r.is_err() {
                        self_only_base.add(&view, &dec, chain_did, &is_ours);
                    }
                    // --fetch: fetch what was missing (or only assumed) at this
                    // version's block, ask again (see replay_fetch.rs).
                    let mut after: Option<Result<(OrderedOut, Vec<String>), CheckUnknown>> = None;
                    let mut needed: Vec<(MissItem, String)> = Vec::new();
                    if let Some(f) = fetcher.as_deref_mut() {
                        if let Err(u) = &r {
                            if matches!(u.reason, UnknownReason::Miss | UnknownReason::SenderFunds) {
                                if f.opts.moved_only && !chain_did {
                                    fxr.skipped_scope += 1;
                                } else if f.capped() {
                                    fxr.skipped_cap += 1;
                                } else {
                                    fxr.tried += 1;
                                    // A fresh overlay per question (the cache keeps repeats
                                    // free), so every value it needed is known (WARM COST).
                                    let mut ov = Overlay::new(cseq, csnap.clone());
                                    let o = &mut ov;
                                    let block = cseq + l2_offset;
                                    let ask = |o: &Overlay| discover(&View::new(o.snap.clone()), &alone, &OverlayProv { inner: prov.as_ref(), o }, &index);
                                    let mut cur = ask(o);
                                    let mut rounds = 0u64;
                                    // Did any round revert after reading a made-up sender value?
                                    let mut saw_sender = u.reason == UnknownReason::SenderFunds;
                                    while (rounds as usize) < f.opts.rounds {
                                        saw_sender |= matches!(&cur, Err(x) if x.reason == UnknownReason::SenderFunds);
                                        let items = match &cur {
                                            Err(u) if u.reason == UnknownReason::Miss => u.missing.clone(),
                                            Err(u) if u.reason == UnknownReason::SenderFunds => u.assumed.clone(),
                                            _ => break,
                                        };
                                        if items.is_empty() {
                                            break;
                                        }
                                        let got = f.fetch(block, &items, &o.snap);
                                        if got.is_empty() {
                                            break;
                                        }
                                        for g in &got {
                                            let (k, v) = (item_of(g), value_text(g));
                                            fxr.warm.note(&k, block, &v);
                                            if !needed.iter().any(|(x, _)| *x == k) {
                                                needed.push((k, v));
                                            }
                                        }
                                        o.add(&got);
                                        cur = ask(o);
                                        rounds += 1;
                                    }
                                    overlay = Some(ov);
                                    fxr.rounds.push(rounds);
                                    let (b, _) = fx_class(&r);
                                    let (a, _) = fx_class(&cur);
                                    fxr.change.add(format!("{b} -> {a}"));
                                    saw_sender |= matches!(&cur, Err(x) if x.reason == UnknownReason::SenderFunds);
                                    if saw_sender {
                                        fxr.sender.add(a);
                                    }
                                    after = Some(cur);
                                }
                            }
                        }
                        let fin = after.as_ref().unwrap_or(&r);
                        let (kind, pools) = fx_class(fin);
                        fxr.after.add(kind.clone());
                        let chain_pools: Vec<String> = truth.get(&t.hash).cloned().flatten().unwrap_or_default().iter().map(|p| p.to_ascii_lowercase()).collect();
                        let verdict = if kind.starts_with("unknown") {
                            format!("still {kind}")
                        } else if !pools.is_empty() {
                            if chain_pools.is_empty() {
                                "we say moved".to_string()
                            } else if pools.iter().all(|p| chain_pools.contains(p)) && chain_pools.iter().all(|p| pools.contains(p)) {
                                "known: same pools".to_string()
                            } else {
                                "known: other pools".to_string()
                            }
                        } else {
                            "we say moved none".to_string()
                        };
                        if after.is_some() {
                            fxr.warm.trigs.push(WarmTrig { target: dec.to, block: cseq + l2_offset, items: needed.clone(), covered: !kind.starts_with("unknown"), chain_moved: chain_did });
                        }
                        if chain_did {
                            let v = if verdict == "we say moved none" { "WRONG: we say moved none".to_string() } else { verdict.clone() };
                            fxr.chain_moved.add(v.clone());
                            let wrong = v.starts_with("WRONG");
                            let control = verdict == "known: same pools" && after.is_some() && fxr.own_control_n < f.opts.own_control;
                            if wrong || control {
                                // AT ITS OWN POSITION: every value fetched at the end
                                // of the block before the trigger (no copy-2 values at
                                // all), the trigger run alone there (earlier
                                // transactions of its own block are not replayed:
                                // counted as earlierTxsInItsBlock).
                                let own_block = (m.seq + l2_offset).saturating_sub(1);
                                let mut o2 = Overlay::new(m.seq.saturating_sub(1), Arc::new(Snapshot::default()));
                                let allx = crate::check::ordered::AllExact;
                                let ask2 = |o: &Overlay| discover(&View::new(o.snap.clone()), &alone, &OverlayProv { inner: &allx, o }, &index);
                                let mut c2r = ask2(&o2);
                                let mut n2 = 0;
                                while n2 < 20 {
                                    let items = match &c2r {
                                        Err(u) if u.reason == UnknownReason::Miss => u.missing.clone(),
                                        Err(u) if u.reason == UnknownReason::SenderFunds => u.assumed.clone(),
                                        _ => break,
                                    };
                                    let got = f.fetch(own_block, &items, &o2.snap);
                                    if items.is_empty() || got.is_empty() {
                                        break;
                                    }
                                    for g in &got {
                                        fxr.warm.note(&item_of(g), own_block, &value_text(g));
                                    }
                                    o2.add(&got);
                                    c2r = ask2(&o2);
                                    n2 += 1;
                                }
                                let (k2, p2) = fx_class(&c2r);
                                let own = if k2 == "moved our pools" {
                                    if p2.iter().all(|p| chain_pools.contains(p)) && chain_pools.iter().all(|p| p2.contains(p)) { "same pools as the chain".to_string() } else { "other pools".to_string() }
                                } else {
                                    k2.clone()
                                };
                                if wrong {
                                    fxr.own_wrong.add(own.clone());
                                    let ours = match fin {
                                        Ok((o, _)) => o.replayed.first().map(|x| if x.outcome.success { "trigger ran, changed none of our pools".to_string() } else { format!("trigger reverted: {}", short_detail(&revert_text(&x.outcome))) }).unwrap_or_default(),
                                        Err(_) => String::new(),
                                    };
                                    let role = |it: &MissItem| miss_role(it, Some(&me), &|a| pool_addrs.contains(&a), &|a| coin_addrs.contains(&a));
                                    let diffs: Vec<String> = needed
                                        .iter()
                                        .filter_map(|(it, v)| f.cached(own_block, it).map(value_text).filter(|v2| v2 != v).map(|v2| format!("{} {}: {} -> {}", role(it), item_text(it), v.chars().take(40).collect::<String>(), v2.chars().take(40).collect::<String>())))
                                        .take(4)
                                        .collect();
                                    if fxr.wrong.len() < 25 {
                                        fxr.wrong.push(json!({
                                            "trigger": format!("{:#x}", t.hash), "to": dec.to.map(|a| format!("{a:#x}")), "chainPools": chain_pools,
                                            "ourRun": ours, "copyLagBlocks": m.seq.saturating_sub(cseq),
                                            "earlierTxsInItsBlock": m.txs.iter().position(|x| x.hash == t.hash).unwrap_or(0),
                                            "atItsOwnPosition": own, "ownPositionRounds": n2,
                                            "valuesDifferentAtItsOwnPosition": diffs,
                                        }));
                                    }
                                } else {
                                    fxr.own_control_n += 1;
                                    fxr.own_control.add(own);
                                }
                            }
                        } else if truth.contains_key(&t.hash) {
                            fxr.chain_none.add(verdict.clone());
                            if verdict == "we say moved" && fxr.wrong.len() < 20 {
                                fxr.wrong.push(json!({"trigger": format!("{:#x}", t.hash), "to": dec.to.map(|a| format!("{a:#x}")), "we": format!("moved {}", pools.join(",")), "chain": "moved none of our pools", "fetched": after.is_some()}));
                            }
                        } else {
                            fxr.chain_none.add(format!("(chain not recorded) {verdict}"));
                        }
                        if let Err(u) = fin {
                            fxr.blame.add(u, m.seq, &me, &truth, &pool_addrs, &coin_addrs);
                            let v = overlay.as_ref().filter(|o| o.seq == cseq).map(|o| View::new(o.snap.clone()));
                            fxr.self_only.add(v.as_ref().unwrap_or(&view), &dec, chain_did, &is_ours);
                        }
                    }
                    // WITH NO LAG: asked again on the version right before its block.
                    if m.seq > cseq + 1 {
                        no_lag.entry(m.seq - 1).or_default().push(NoLag { msg: m.clone(), hash: t.hash, before: outcome_key(&r) });
                    }
                    let (out, pools) = match r {
                        Ok(x) => x,
                        Err(u) => {
                            bump(&mut disc_unknown, u.reason.as_str().to_string());
                            disc_blame.add(&u, m.seq, &me, &truth, &pool_addrs, &coin_addrs);
                            trig_us.push(t0.elapsed().as_micros() as u64);
                            continue;
                        }
                    };
                    // FULL REPLAY (what a candidate check must do), for every
                    // trigger whose own run worked.
                    if !opts.no_full {
                        full_n += 1;
                        let none = crate::check::Overrides::none();
                        match run_ordered_with(&view, &plan, &none, &[], prov.as_ref(), true, &strict_full) {
                            Ok(_) => full_ok_strict += 1,
                            Err(u) => full_strict.add(&u, m.seq, &me, &truth, &pool_addrs, &coin_addrs),
                        }
                        match run_ordered_with(&view, &plan, &none, &[], prov.as_ref(), true, &proven_full) {
                            Ok(o) => {
                                full_ok_proven += 1;
                                proven_skipped.push(o.assumed.skipped_proven as u64);
                            }
                            Err(u) => full_proven.add(&u, m.seq, &me, &truth, &pool_addrs, &coin_addrs),
                        }
                    }
                    if pools.is_empty() {
                        no_pools += 1;
                        let ours_said = match out.replayed.first() {
                            Some(x) if !x.outcome.success => {
                                none_reverts.add(short_detail(&revert_text(&x.outcome)));
                                "trigger reverted in our run"
                            }
                            _ => "trigger ran",
                        };
                        none_split.add(format!("{ours_said} | {}", chain_says(&truth, &t.hash)));
                        trig_us.push(t0.elapsed().as_micros() as u64);
                        continue;
                    }
                    let chain_pools: Vec<String> = truth.get(&t.hash).cloned().flatten().unwrap_or_default().iter().map(|p| p.to_ascii_lowercase()).collect();
                    let agree = if !truth.contains_key(&t.hash) {
                        "chain: not recorded"
                    } else if chain_pools.is_empty() {
                        "chain: moved none (we said moved)"
                    } else if pools.iter().all(|p| chain_pools.contains(p)) && chain_pools.iter().all(|p| pools.contains(p)) {
                        "chain: same pools"
                    } else {
                        "chain: other pools"
                    };
                    moved_vs_chain.add(agree);
                    if moved_samples.len() < 20 {
                        moved_samples.push(json!({"trigger": format!("{:#x}", t.hash), "to": dec.to.map(|a| format!("{a:#x}")), "pools": pools, "chainPools": chain_pools, "conf": out.assumed.confidence(), "assumed": out.assumed.labels(), "copyLagBlocks": m.seq.saturating_sub(cseq)}));
                    }
                    if pools.len() > cfg.max_pools {
                        too_many += 1;
                        trig_us.push(t0.elapsed().as_micros() as u64);
                        continue;
                    }
                    moved += 1;
                    let Some(tb) = table else {
                        trig_us.push(t0.elapsed().as_micros() as u64);
                        continue;
                    };
                    let (picked, _found) = select(tb, &pools, cfg.max_candidates);
                    if picked.is_empty() {
                        no_cands += 1;
                        trig_us.push(t0.elapsed().as_micros() as u64);
                        continue;
                    }
                    for r in picked {
                        let Some(c) = &r.c else { continue };
                        routes_checked += 1;
                        let mut call = call_for(&tb.codes, c, &json!(0), &json!({"after": "head"}), &feed_json(&feed), true);
                        caller_as_empty(&view, &mut call);
                        let req: crate::check::proto_types::CallRequest = match serde::Deserialize::deserialize(&call) {
                            Ok(x) => x,
                            Err(e) => {
                                bump(&mut answer_unknown, format!("bad_request: {}", e.to_string().chars().take(40).collect::<String>()));
                                continue;
                            }
                        };
                        let a = crate::check::proto_types::handle_trig_call_with(&view, &plan, &info, &req, prov.as_ref(), true, &cand_assume);
                        if a.get("ok") == Some(&Value::Bool(true)) {
                            sure += 1;
                        } else {
                            bump(&mut answer_unknown, a.get("unknown").and_then(|u| u.as_str()).unwrap_or("error").to_string());
                            let (reason, place, to, _) = super::coverage::attribute_json(&a, m.seq);
                            cand_where.add(format!("{place}|{reason}|to {}", to.as_deref().unwrap_or("-")));
                        }
                        if !good_enough(&a, c, &cfg.min_conf) {
                            continue;
                        }
                        good += 1;
                        let row = CheckedRow { row: r.clone(), answer: Some(a), good: true };
                        let now = Instant::now();
                        match opportunity(&row, &tb.codes, &mut codes_cache, m.seq + l2_offset, &cfg, now, t0) {
                            Ok(o) => {
                                would_fire += 1;
                                if fires.len() < opts.samples.max(1) * 5 {
                                    fires.push(json!({"block": o.block, "label": o.route_label, "sizeUsd": o.size_usd, "netUsd": o.expected_net_usd, "trigger": format!("{:#x}", t.hash), "copyLagBlocks": m.seq.saturating_sub(cseq)}));
                                }
                                waiting.push(Waiting { block: o.block, opp: o });
                            }
                            Err(why) => bump(&mut not_trade, why),
                        }
                        break; // the stop rule: the first good answer
                    }
                    trig_us.push(t0.elapsed().as_micros() as u64);
                }
            }
            _ => {}
        }
    }
    no_lag_missing += no_lag.values().map(|v| v.len() as u64).sum::<u64>();
    let lag_over = |n: u64| lag_blocks.iter().filter(|x| **x > n).count() as u64;
    let lag_hist = json!({"0 (copy already had it)": lag_ahead, "1": lag_blocks.iter().filter(|x| **x == 1).count(), "2": lag_blocks.iter().filter(|x| **x == 2).count(), "3": lag_blocks.iter().filter(|x| **x == 3).count(), "more than 3": lag_over(3)});
    // WHAT TO WARM: first missing items that came back (discovery + full replay).
    let mut items = Tally::default();
    for b in [&disc_blame, &full_strict] {
        for (k, c) in &b.items.map {
            items.add_n(k.clone(), *c);
        }
    }
    let recurring: Vec<(String, u64)> = items.top(usize::MAX).into_iter().filter(|(_, c)| *c >= 2).collect();
    let once = items.map.values().filter(|c| **c == 1).count();
    let rec_accounts: HashSet<String> = recurring.iter().filter_map(|(k, _)| k.split(' ').nth(1).map(|s| s.to_string())).collect();
    let rec_whole = recurring.iter().filter(|(k, _)| !k.starts_with("slot")).count();
    let warm_cost = rec_accounts.len() + rec_whole;
    let blocked_by_recurring: u64 = recurring.iter().map(|(_, c)| *c).sum();
    Ok(json!({
        "capture": {"complete": cap.complete, "cut": cap.cut, "events": cap.events.len(), "pools": pools_n, "routePools": route_pools, "l2Offset": l2_offset, "table": table.map(|t| json!({"pools": t.pools.len(), "rows": t.pools.values().map(|r| r.len()).sum::<usize>()})), "chainAnswers": truth.len()},
        "copyLag": {"blocksBehindAtArrival": pct(&mut lag_blocks.clone()), "histogram": lag_hist, "lagReplayedTxsPerTrigger": pct(&mut lag_txs.clone()), "note": "how far copy 2's newest confirmed version was behind each feed message when it arrived (blocks); lagReplayedTxs = feed transactions in EARLIER blocks a check must replay before the trigger"},
        "coverage": {"msgs": msgs, "msgsBeforeAnyCopy": msgs_no_copy, "txs": txs, "skipped": skipped, "repeats": repeats, "asked": asked,
            "discovery": {"movedOurPools": moved, "noPools": no_pools, "tooManyPools": too_many, "alreadyInCopy": in_copy, "unknown": disc_unknown}},
        "diagnosis": {
            "settings": {"skip": if assume.proven_skip { "proven" } else { "none (FASTLANE_TRIG_SKIP=bot or skipping not allowed: the bot's rules need copy 2's route facts)" }, "assume": cfg.feed_assume()},
            "unreadable": {"distinctTxs": unreadable_seen.len() as u64 - type4, "byKind": unreadable.json(12), "eip7702Unpacked": type4, "triggersTheOldPlanRuleFailed": old_rule_failed},
            "discoveryUnknown": disc_blame.json(20),
            "movedNone": {"split": none_split.json(8), "ourRevertReasons": none_reverts.json(12)},
            "movedOurPools": {"vsChain": moved_vs_chain.json(4), "samples": moved_samples},
            "alreadyInCopy": in_copy_chain.json(4),
            "fullReplay": {"asked": full_n, "noSkipping": {"answerable": full_ok_strict, "unknown": full_strict.json(20)}, "provenSkipping": {"answerable": full_ok_proven, "skippedPerAnswer": pct(&mut proven_skipped.clone()), "unknown": full_proven.json(20)},
                "note": "every trigger whose own run worked: the replay a candidate check needs (copy 2's version -> trigger -> rest of its block), no calls"},
            "withNoLag": {"compared": no_lag_out.total(), "noExactVersionInCapture": no_lag_missing, "outcome": no_lag_out.json(10), "note": "hindsight: the same trigger on the version right before its block"},
            "candidateUnknownWhere": cand_where.json(20),
            "selfOnlyTargets": self_only_base.json(),
            "whatToWarm": {"recurringFirstMissingItems": recurring.len(), "unknownsTheyBlocked": blocked_by_recurring, "seenOnce": once, "estimatedNodeRequestsOnce": warm_cost, "top": recurring.iter().take(30).map(|(k, c)| json!([k, c])).collect::<Vec<_>>(), "note": "first missing items of discovery + full-replay unknowns seen 2+ times; one fetch each (accounts + whole-account items); a slot whose value keeps changing needs re-reads"},
        },
        "candidates": {"noCandidates": no_cands, "routesChecked": routes_checked, "sure": sure, "unknown": answer_unknown, "good": good, "notTrade": not_trade, "wouldReachGun": would_fire,
            "recheckAtBlockEnd": {"stillProfitable": real, "gone": gone, "unknown": recheck_unknown, "neverConfirmedInCapture": waiting.len()}},
        "fetch": match fetcher.as_deref() {
            None => Value::Null,
            Some(f) => json!({
                "requests": f.json(),
                "tried": fxr.tried, "notTriedOutOfScope": fxr.skipped_scope, "notTriedCapReached": fxr.skipped_cap, "roundsPerTried": pct(&mut fxr.rounds.clone()),
                "everyAskedTriggerAfter": fxr.after.json(12),
                "beforeToAfter": fxr.change.json(16),
                "chainSaysMovedOurPools": fxr.chain_moved.json(12),
                "chainSaysMovedNone": fxr.chain_none.json(12),
                "senderFundsRevertsWithRealValues": fxr.sender.json(8),
                "senderFundsNote": "questions that answered sender_funds_revert (before, or in a fetch round once the contract's code was there): the answer once the made-up sender values were replaced by the real ones",
                "wrongSamples": fxr.wrong,
                "wrongAtItsOwnPosition": fxr.own_wrong.json(8),
                "controlAtItsOwnPosition": fxr.own_control.json(8),
                "ownPositionNote": "every value fetched at the end of the block BEFORE the trigger (none from copy 2), the trigger run alone there; earlier transactions of its own block are not replayed. control = triggers we already answered right, asked the same way",
                "warmCost": fxr.warm.json(l2_offset, &touches, if ts_max > ts_min { (ts_max - ts_min) as f64 } else { 1.0 }, f.calls()),
                "stillUnknown": fxr.blame.json(20),
                "stillUnknownSelfOnly": fxr.self_only.json(),
                "note": "values fetched at the block of the copy version each question was asked on (exact there), free node first; 'known' = same pools as the chain; WRONG = we say moved none, the chain says it moved our pools",
            }),
        },
        "warmSim": match &ws {
            None => Value::Null,
            Some(w) => {
                let secs = if ts_max > ts_min { (ts_max - ts_min) as f64 } else { 1.0 };
                let per_h = |n: u64| (n as f64 * 3600.0 / secs).round() as u64;
                json!({
                    "topTargets": w.cfg.targets, "perHourCap": w.cfg.per_hour, "captureSeconds": secs,
                    "triggersToHotTargets": wsr.asked_hot, "answeredWithNoFetch": wsr.answered,
                    "chainSaysMovedOurPools": wsr.chain_moved.json(10), "chainSaysMovedNone": wsr.chain_none.json(10), "wrongSamples": wsr.wrong,
                    "nodeRequests": w.stats.requests, "nodeRequestsPerHour": per_h(w.stats.requests), "callsAsCapped": w.stats.calls, "callsAsCappedPerHour": per_h(w.stats.calls),
                    "plainCallsOneEach": wsr.plain_calls, "plainCallsPerHour": per_h(wsr.plain_calls),
                    "keeper": w.json(sim_now, l2_offset),
                    "note": "copy2/warm.rs run over the capture: a target is hot once the chain showed one of its transactions moving our pools (after that one); recipes learned from misses; values fetched at each copy version's block by the keeper (once, after a feed transaction to the contract unless stable, every 60 s), within the hourly cap (fail closed); each decision reads warm values only (no fetch). nodeRequests = one eth_getProof per account per job (what the live loader sends); plainCalls = one call per slot, three per account",
                })
            }
        },
        "timeUsThisMachine": {"perTrigger": pct(&mut trig_us.clone())},
        "wouldFireSamples": fires,
        "offlineNote": if fetcher.is_some() { "no copy-2 double runs / reports-pending rule, no best-effort (bot) skipping, no safety gates; --fetch: values fetched for DISCOVERY only (the FETCH section; every other section is the recording alone); nothing signed or sent" } else { "no copy-2 double runs / reports-pending rule, no best-effort (bot) skipping, no fills fetched, no safety gates: more cautious than live; nothing signed or sent" },
        "tookMs": t_all.elapsed().as_millis() as u64,
    }))
}

/// The re-check's runner: the plain size search with the server's
/// caller_as_empty rule (an unknown caller = an empty wallet), like
/// fastlane/c2runner.rs, without copy 2's double runs (offline).
struct ReplayRunner;

impl CheckRunner for ReplayRunner {
    fn run(&self, view: &dyn crate::state::StateRead, ctx: &BlockCtx, c: &PreparedCheck, amounts: &crate::check::search::SizeSearchAmounts) -> Result<crate::check::search::SizeSearchResult, crate::check::CheckUnknown> {
        let from = c.call.from;
        let mut ov = c.overrides.clone();
        if !ov.accounts.contains_key(&from) && matches!(view.account(from), crate::state::Lookup::Missing) {
            ov.accounts.insert(from, crate::check::overrides::AccountOverride { balance: Some(revm::primitives::U256::ZERO), nonce: Some(0), code: Some(crate::check::overrides::analysed_code(&[])), ..Default::default() });
        }
        crate::check::search::size_search_opts(view, ctx, &ov, &[], &c.template(), amounts, crate::check::run::CheckOptions::default())
    }
}

/// The server's caller_as_empty (server.rs), on the replay's view: a check's
/// caller our copy doesn't know is an empty wallet (a check charges no gas
/// and checks no balance / nonce), unless the check already says otherwise.
fn caller_as_empty(view: &View, call: &mut Value) {
    use crate::state::StateRead;
    let froms: Vec<String> = call.get("calls").and_then(|c| c.as_array()).map(|cs| cs.iter().filter_map(|c| c.get("from").and_then(|f| f.as_str()).map(|s| s.to_string())).collect()).unwrap_or_default();
    for f in froms {
        let Ok(a) = crate::check::hexutil::parse_address(&f) else { continue };
        let known = !matches!(view.account(a), crate::state::Lookup::Missing);
        let has_ov = call.get("overrides").and_then(|o| o.as_object()).is_some_and(|o| o.keys().any(|k| crate::check::hexutil::parse_address(k).ok() == Some(a)));
        if known || has_ov {
            continue;
        }
        if !call.get("overrides").is_some_and(|o| o.is_object()) {
            call["overrides"] = json!({});
        }
        call["overrides"][format!("{a:#x}")] = json!({ "balance": "0x0", "nonce": "0x0", "code": "0x" });
    }
}

/// The feed part of a question (what call_for puts in "feed").
fn feed_json(f: &WireFeed) -> Value {
    json!({"trigger": f.trigger, "triggerSeq": f.trigger_seq, "refs": f.refs, "route": f.route, "strict": f.strict, "assume": f.assume})
}

/// One Blame section, printed.
fn print_blame(o: &mut String, title: &str, b: &Value) {
    *o += &format!("  {title}: {} unknown; where|why {}\n", b["n"], b["where"]);
    *o += &format!("    first missing item {}\n", b["firstMissing"]);
    *o += &format!("    the blamed transaction, chain's answer: {}\n", b["chainSaysBlamedTx"]);
    *o += &format!("    top targets by count ({} targets):\n", b["targets"]);
    for r in b["topByCount"].as_array().into_iter().flatten() {
        *o += &format!("      {} n {} chainMoved {} why {} first {}\n", r["target"].as_str().unwrap_or("?"), r["n"], r["chainMovedOurPools"], r["why"], r["firstMissing"]);
    }
    *o += "    top targets by 'the chain says it moved our pools':\n";
    for r in b["topByChainMovedOurPools"].as_array().into_iter().flatten() {
        *o += &format!("      {} chainMoved {} of {} why {} first {}\n", r["target"].as_str().unwrap_or("?"), r["chainMovedOurPools"], r["n"], r["why"], r["firstMissing"]);
    }
}

/// The SELF-ONLY TARGETS part, printed.
fn print_self_only(o: &mut String, title: &str, s: &Value) {
    *o += &format!("  {title}: unknown triggers by target code {}\n", s["unknownTriggersByTargetCode"]);
    *o += &format!("    rule (self-only target, not ours) would answer moved none: {} (chain says moved: {}, must be 0)\n", s["ruleWouldAnswerMovedNone"], s["ofWhichChainSaysMoved"]);
    for t in s["topTargets"].as_array().into_iter().flatten().take(12) {
        *o += &format!("    {} {} n {} chainMoved {}\n", t["target"].as_str().unwrap_or("?"), t["code"].as_str().unwrap_or("?"), t["n"], t["chainMovedOurPools"]);
    }
}

/// Plain-English report.
pub fn print_report(r: &Value) -> String {
    let mut o = String::new();
    let c = &r["capture"];
    o += &format!("FIRE-FIRST REPLAY (offline, no future information): {} events, {} pools followed, chain answers {}, table {}\n", c["events"], c["pools"], c["chainAnswers"], if c["table"].is_null() { "NONE (discovery only; capture with FASTLANE_CAPTURE_FILE writes <file>.table.json)".to_string() } else { c["table"].to_string() });
    o += &format!("ROUTE POOLS arbsim held (newest seen in the capture): {} (null = no candidate table had arrived: the zero-routes symptom)\n", c["routePools"]);
    o += &format!("COPY LAG at each feed message (blocks behind): {}  histogram {}\n", r["copyLag"]["blocksBehindAtArrival"], r["copyLag"]["histogram"]);
    o += &format!("  feed txs in EARLIER blocks a check replays before the trigger (per asked trigger): {}\n", r["copyLag"]["lagReplayedTxsPerTrigger"]);
    let v = &r["coverage"];
    o += &format!("COVERAGE: feed msgs {} (before any copy {}), txs {}, skipped {}, repeats {}, asked {}\n", v["msgs"], v["msgsBeforeAnyCopy"], v["txs"], v["skipped"], v["repeats"], v["asked"]);
    let d = &v["discovery"];
    o += &format!("DISCOVERY: moved our pools {}, moved none {}, too many pools {}, already in copy {}, unknown {}\n", d["movedOurPools"], d["noPools"], d["tooManyPools"], d["alreadyInCopy"], d["unknown"]);
    let g = &r["diagnosis"];
    if !g.is_null() {
        o += &format!("DIAGNOSIS (settings {})\n", g["settings"]);
        o += &format!("  UNREADABLE txs: {}\n", g["unreadable"]);
        print_blame(&mut o, "DISCOVERY UNKNOWN", &g["discoveryUnknown"]);
        o += &format!("  MOVED NONE: {}\n    our run's revert reasons: {}\n", g["movedNone"]["split"], g["movedNone"]["ourRevertReasons"]);
        o += &format!("  MOVED OUR POOLS vs chain: {}\n", g["movedOurPools"]["vsChain"]);
        for s in g["movedOurPools"]["samples"].as_array().into_iter().flatten().take(10) {
            o += &format!("    {s}\n");
        }
        o += &format!("  ALREADY IN COPY, chain's answer (live answers those pools from copy 2's reports): {}\n", g["alreadyInCopy"]);
        let f = &g["fullReplay"];
        o += &format!("  FULL REPLAY (what a candidate check must replay), {} triggers: answerable with no skipping {}, with proven skipping {} (skipped per answer {})\n", f["asked"], f["noSkipping"]["answerable"], f["provenSkipping"]["answerable"], f["provenSkipping"]["skippedPerAnswer"]);
        print_blame(&mut o, "FULL REPLAY, no skipping", &f["noSkipping"]["unknown"]);
        print_blame(&mut o, "FULL REPLAY, proven skipping", &f["provenSkipping"]["unknown"]);
        o += &format!("  WITH NO LAG (hindsight): {}\n", g["withNoLag"]);
        o += &format!("  CANDIDATE UNKNOWN where|why|target: {}\n", g["candidateUnknownWhere"]);
        print_self_only(&mut o, "SELF-ONLY TARGETS (recording alone)", &g["selfOnlyTargets"]);
        let w = &g["whatToWarm"];
        o += &format!("  WHAT TO WARM: {} recurring first-missing items blocked {} unknowns ({} seen once); ~{} node requests to fetch once\n", w["recurringFirstMissingItems"], w["unknownsTheyBlocked"], w["seenOnce"], w["estimatedNodeRequestsOnce"]);
        for x in w["top"].as_array().into_iter().flatten().take(30) {
            o += &format!("    {x}\n");
        }
    }
    let x = &r["fetch"];
    if !x.is_null() {
        o += &format!("FETCH (discovery asked again with values fetched at the copy version's block):\n  requests {}\n", x["requests"]);
        o += &format!("  tried {} unknown answers (miss / sender funds), not tried: out of scope {}, cap reached {}; rounds per tried {}\n", x["tried"], x["notTriedOutOfScope"], x["notTriedCapReached"], x["roundsPerTried"]);
        o += &format!("  EVERY ASKED TRIGGER, after: {}\n", x["everyAskedTriggerAfter"]);
        o += &format!("  before -> after: {}\n", x["beforeToAfter"]);
        o += &format!("  CHAIN SAYS MOVED OUR POOLS, we say: {}\n", x["chainSaysMovedOurPools"]);
        o += &format!("  chain says moved none, we say: {}\n", x["chainSaysMovedNone"]);
        o += &format!("  SENDER-FUNDS REVERTS with the real sender values: {}\n", x["senderFundsRevertsWithRealValues"]);
        for w in x["wrongSamples"].as_array().into_iter().flatten() {
            o += &format!("    wrong: {w}\n");
        }
        o += &format!("  WRONG asked AT ITS OWN POSITION: {}   control (answered right before): {}\n", x["wrongAtItsOwnPosition"], x["controlAtItsOwnPosition"]);
        let wc = &x["warmCost"];
        o += &format!("  WARM COST (capture {} s; fetching on demand = {} calls/hour): {} distinct items {}; seen at one block only {}, same at every block {}, CHANGE {}\n", wc["captureSeconds"], wc["fetchOnDemandCallsPerHour"], wc["distinctItems"], wc["byKind"], wc["itemsSeenAtOneBlockOnly"], wc["itemsSameAtEveryBlock"], wc["itemsThatChange"]);
        for c in wc["topContracts"].as_array().into_iter().flatten() {
            o += &format!("    contract {c}\n");
        }
        o += &format!("    targets (target, triggers covered, of which chain moved): {}\n", wc["topTargets"]);
        for c in wc["curve"].as_array().into_iter().flatten() {
            o += &format!("    curve {c}\n");
        }
        print_blame(&mut o, "STILL UNKNOWN after fetch", &x["stillUnknown"]);
        print_self_only(&mut o, "STILL UNKNOWN, SELF-ONLY TARGETS", &x["stillUnknownSelfOnly"]);
    }
    let ws = &r["warmSim"];
    if !ws.is_null() {
        o += &format!("WARM SIM (top {} hot targets, cap {}/h, capture {} s): triggers to hot targets {}, ANSWERED WITH NO FETCH {}\n", ws["topTargets"], ws["perHourCap"], ws["captureSeconds"], ws["triggersToHotTargets"], ws["answeredWithNoFetch"]);
        o += &format!("  chain says moved our pools, we say: {}\n  chain says moved none, we say: {}\n", ws["chainSaysMovedOurPools"], ws["chainSaysMovedNone"]);
        o += &format!("  node requests {} (= {}/h; eth_getProof per account), as capped {} (= {}/h), plain calls {} (= {}/h)\n", ws["nodeRequests"], ws["nodeRequestsPerHour"], ws["callsAsCapped"], ws["callsAsCappedPerHour"], ws["plainCallsOneEach"], ws["plainCallsPerHour"]);
        o += &format!("  keeper {}\n", ws["keeper"]);
        for w in ws["wrongSamples"].as_array().into_iter().flatten() {
            o += &format!("    wrong: {w}\n");
        }
    }
    let k = &r["candidates"];
    o += &format!("CANDIDATES: no candidates {}, routes checked {}, sure {}, unknown {}, good {}, not a trade {}, WOULD REACH THE GUN {}\n", k["noCandidates"], k["routesChecked"], k["sure"], k["unknown"], k["good"], k["notTrade"], k["wouldReachGun"]);
    o += &format!("RE-CHECK at the trigger block's end (copy 2 confirmed): {}\n", k["recheckAtBlockEnd"]);
    o += &format!("TIME per trigger (THIS machine, us): {}\n", r["timeUsThisMachine"]["perTrigger"]);
    if let Some(s) = r["wouldFireSamples"].as_array().filter(|s| !s.is_empty()) {
        o += "would-fire samples:\n";
        for x in s {
            o += &format!("  {x}\n");
        }
    }
    o += &format!("NOTE: {} (took {} ms)\n", r["offlineNote"].as_str().unwrap_or(""), r["tookMs"]);
    o
}

/// `arbsim trig-replay <capture file> [--table <file>] [--ours a,b] [--json] [--samples N] [--partial] [--no-full]`
pub fn replay_main(args: &[String]) {
    let Some(path) = args.get(2).filter(|a| !a.starts_with("--")) else {
        eprintln!("usage: arbsim trig-replay <capture file> [--table <file>] [--ours 0x..,0x..] [--json] [--samples N] [--partial] [--no-full] [--fetch [--fetch-max 3000] [--fetch-paid on|off] [--fetch-paid-max N] [--fetch-scope all|moved] [--fetch-rounds 6] [--fetch-own-control 10] [--fetch-url-env NAME]] [--warm-sim N [--warm-per-hour 25000]]");
        std::process::exit(2);
    };
    let val = |f: &str| args.iter().position(|a| a == f).and_then(|i| args.get(i + 1)).cloned();
    let cap = match crate::copy2::ahead_capture::read_capture(path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("arbsim trig-replay: {e}");
            std::process::exit(2);
        }
    };
    if !cap.complete && !args.iter().any(|a| a == "--partial") {
        eprintln!("arbsim trig-replay: the capture is incomplete ({}); add --partial to replay what is there", cap.cut.as_deref().unwrap_or("no end record"));
        std::process::exit(2);
    }
    let table_path = val("--table").unwrap_or_else(|| format!("{path}.table.json"));
    let table = match std::fs::read_to_string(&table_path) {
        Ok(text) => {
            let v: Value = match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("arbsim trig-replay: {table_path}: {e}");
                    std::process::exit(2);
                }
            };
            let msgs = if v.is_array() { v.as_array().cloned().unwrap_or_default() } else { vec![v] };
            match crate::check::entry::table_from_messages(&msgs) {
                Ok(t) => Some(t),
                Err(e) => {
                    eprintln!("arbsim trig-replay: {table_path}: {e}");
                    std::process::exit(2);
                }
            }
        }
        Err(_) => None,
    };
    let ours: Vec<Address> = val("--ours").map(|s| s.split(',').filter_map(|x| crate::check::hexutil::parse_address(x.trim()).ok()).collect()).unwrap_or_default();
    let cfg = TrigCfg::from_lookup(&|k| std::env::var(k).ok());
    let opts = TrigReplayOpts {
        ours,
        samples: val("--samples").and_then(|s| s.parse().ok()).unwrap_or(10),
        no_full: args.iter().any(|a| a == "--no-full"),
        warm_sim: val("--warm-sim").and_then(|s| s.parse().ok()),
        warm_per_hour: val("--warm-per-hour").and_then(|s| s.parse().ok()),
    };
    // --fetch (replay_fetch.rs): fetch what the recording didn't hold.
    let mut fetcher = None;
    if args.iter().any(|a| a == "--fetch") {
        let num = |f: &str, d: u64| val(f).and_then(|s| s.parse::<u64>().ok()).unwrap_or(d);
        let max_calls = num("--fetch-max", 3000);
        let paid_on = val("--fetch-paid").is_none_or(|v| v != "off");
        let fo = super::replay_fetch::FetchOpts {
            max_calls,
            max_paid: if paid_on { num("--fetch-paid-max", max_calls) } else { 0 },
            rounds: num("--fetch-rounds", 6).clamp(1, 20) as usize,
            moved_only: val("--fetch-scope").is_some_and(|v| v == "moved"),
            own_control: num("--fetch-own-control", 10) as usize,
        };
        match ReplayFetcher::from_env(val("--fetch-url-env").as_deref(), fo) {
            Ok(f) => fetcher = Some(f),
            Err(e) => {
                eprintln!("arbsim trig-replay: {e}");
                std::process::exit(2);
            }
        }
    }
    match trig_replay_with(&cap, table.as_ref(), &cfg, &opts, fetcher.as_mut()) {
        Ok(r) => {
            if args.iter().any(|a| a == "--json") {
                println!("{r}");
            } else {
                print!("{}", print_report(&r));
            }
        }
        Err(e) => {
            eprintln!("arbsim trig-replay: {e}");
            std::process::exit(2);
        }
    }
}
