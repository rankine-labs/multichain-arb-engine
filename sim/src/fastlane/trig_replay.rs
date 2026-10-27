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
//   no fills are fetched (a miss stays a miss: live fetches some, see WHAT
//   TO WARM), and the safety gates are not applied (a "would reach the gun"
//   count). Nothing is signed or sent. Times are this machine's.
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
use super::scan::{evaluate, CheckRunner, PreparedCheck};
use super::trigger::{opportunity, quick_skip, TrigCfg};
use super::types::Opportunity;
use crate::arb::BlockCtx;
use crate::check::entry::{call_for, good_enough, select, Table};
use crate::check::feedstore::BinMsg;
use crate::check::moved::{FollowedPool, MovedIndex};
use crate::check::ordered::{build_plan_with, revert_text, run_ordered_with, trigger_only, Assume, OrderedOut, OrderedPlan, Provenance, WireFeed};
use crate::check::{CheckUnknown, TxAt};
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

/// Replay the capture (see the file header). `table`: the bot's table
/// messages (None = discovery only).
pub fn trig_replay(cap: &CapFile, table: Option<&Table>, cfg: &TrigCfg, opts: &TrigReplayOpts) -> Result<Value, String> {
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
                        // Live answers the pools copy 2's reports say it moved (server.rs GAP FIX 1).
                        in_copy_chain.add(chain_says(&truth, &t.hash));
                        continue;
                    };
                    let r = discover(&view, &alone, prov.as_ref(), &index);
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
            "whatToWarm": {"recurringFirstMissingItems": recurring.len(), "unknownsTheyBlocked": blocked_by_recurring, "seenOnce": once, "estimatedNodeRequestsOnce": warm_cost, "top": recurring.iter().take(30).map(|(k, c)| json!([k, c])).collect::<Vec<_>>(), "note": "first missing items of discovery + full-replay unknowns seen 2+ times; one fetch each (accounts + whole-account items); a slot whose value keeps changing needs re-reads"},
        },
        "candidates": {"noCandidates": no_cands, "routesChecked": routes_checked, "sure": sure, "unknown": answer_unknown, "good": good, "notTrade": not_trade, "wouldReachGun": would_fire,
            "recheckAtBlockEnd": {"stillProfitable": real, "gone": gone, "unknown": recheck_unknown, "neverConfirmedInCapture": waiting.len()}},
        "timeUsThisMachine": {"perTrigger": pct(&mut trig_us.clone())},
        "wouldFireSamples": fires,
        "offlineNote": "no copy-2 double runs / reports-pending rule, no best-effort (bot) skipping, no fills fetched, no safety gates: more cautious than live; nothing signed or sent",
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
        let w = &g["whatToWarm"];
        o += &format!("  WHAT TO WARM: {} recurring first-missing items blocked {} unknowns ({} seen once); ~{} node requests to fetch once\n", w["recurringFirstMissingItems"], w["unknownsTheyBlocked"], w["seenOnce"], w["estimatedNodeRequestsOnce"]);
        for x in w["top"].as_array().into_iter().flatten().take(30) {
            o += &format!("    {x}\n");
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
        eprintln!("usage: arbsim trig-replay <capture file> [--table <file>] [--ours 0x..,0x..] [--json] [--samples N] [--partial] [--no-full]");
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
    let opts = TrigReplayOpts { ours, samples: val("--samples").and_then(|s| s.parse().ok()).unwrap_or(10), no_full: args.iter().any(|a| a == "--no-full") };
    match trig_replay(&cap, table.as_ref(), &cfg, &opts) {
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
