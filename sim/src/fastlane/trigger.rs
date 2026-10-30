// ============================================================================
// FAST LANE TRIGGER: fire-first decided AND fired inside Rust (Oct 27).
//
// Plain English:
//   Fire-first is the one path that has shown it can replay a trigger: the
//   moment the sequencer feed shows a swap, it replays that swap on copy 2
//   (check/ordered.rs, strict "unknown" rules) and checks our trade right
//   after it. Until now the bot (Node) drove it with several round trips
//   ("which pools?" -> build candidates -> "check this" -> decide -> sign ->
//   send), ~140 ms before a send was ready, and our sends landed 2+ blocks
//   late.
//
//   This file does the SAME work inside arbsim, with the SAME code, the
//   moment a feed message is stored (check/feedstore.rs `feed_put`):
//     1. each transaction of the message (up to FASTLANE_TRIG_MAX_TXS) that
//        could be a swap (the bot's quick skip test, trigEntry.ts quickSkip:
//        not ours, not a contract creation, not a plain transfer, not a
//        coin's own approve / transfer / deposit / withdraw / permit),
//     2. is asked the bot's one-trip question, answered by the existing
//        server code (server.rs trig_entry_run): discover which of our pools
//        it moves (trigger replayed on copy 2's newest version + the feed
//        messages after it, in sequence order), pick candidates from the
//        bot's candidate table (check/entry.rs select: same ranking, same
//        cap TRIG_ENTRY_MAX_CANDIDATES), check them best-ranked first with
//        the size ladder, stop at the first answer the bot would send
//        (entry.rs good_enough: profit >= the bot's send minimum after gas,
//        confidence >= TRIG_FIRST_MIN_CONFIDENCE),
//     3. that answer becomes a trade (Opportunity: the table row's exact
//        route + the answer's best size, valued with the bot's price / gas
//        facts) and goes straight to the existing safety gates + gun
//        (fastlane/lane.rs Firer: the one fire lock, every Node gate,
//        practice = sign with a throwaway key and NEVER broadcast; live only
//        with FASTLANE=live + RUST_SENDER=on on both sides + the key).
//   No round trip to Node, no waiting for pool reports, receipts or a node
//   request: the inputs are copy 2's newest confirmed version (already in
//   memory), the feed messages (already stored) and the table (refreshed
//   by the bot ~1/s, in memory).
//
//   NOT HERE (stay in Node, listed so nothing is dropped silently):
//     - 3/4/5-pool loops (execution/trigEntryLoops.ts, coin tax test
//       core/coinTax.ts): the table carries 2-pool routes only.
//     - The bot's "two-step" candidates built per trigger
//       (shadowMain.ts entryCandidatesFor) are the same routes the table
//       carries, refreshed ~1/s: a route new since the last refresh is only
//       in Node's list.
//     - Hot-target extra places (GAP FIX 2) and the later same-block
//       agreement re-check (agreeLater): Node keeps doing them.
//     - Node's own fire-first path keeps running as today. With RUST_SENDER
//       off (default) Node is the sender and this file only practises;
//       with RUST_SENDER=on Node never broadcasts (fastSender.ts).
//
//   Measured (status "fastlane.trigger", hourly line "[fastlane trigger]"):
//   coverage (feed txs seen / skipped by reason / asked / moved our pools),
//   discovery unknown reasons, routes checked, answers by result, would-
//   sends / live sends / safety blocks, and INSIDE-RUST times from the
//   moment the feed message reached arbsim: to the decision, and to the
//   signed bytes being ready (p50 / p90 / p99). Network delivery (sequencer
//   -> bot -> arbsim) and block inclusion are NOT in these numbers.
//
//   Settings (env, defaults in brackets; the TRIG_* ones are the bot's own):
//     FASTLANE_TRIGGER          [on]  off = this file does nothing
//     FASTLANE_TRIG_MAX_TXS     [16]  transactions looked at per feed message
//     FASTLANE_TRIG_BUDGET_MS   [40]  most time for one feed message
//     FASTLANE_TRIG_MAX_LAG_MS  [60]  a message older than this when its turn
//                                     comes is skipped (counted "late")
//     TRIG_ENTRY_MAX_CANDIDATES [6], TRIG_ENTRY_MAX_POOLS [4],
//     TRIG_FIRST_MIN_CONFIDENCE [medium], TRIG_FIRST_BACK_MSGS [8],
//     TRIG_FIRST_MAX_MSGS [48], TRIG_FIRST_STRICT [0],
//     TRIG_FIRST_ASSUME [sender_funds,recent_fill,skip],
//     FASTLANE_MIN_NET_USD / MIN_EXEC_NET_USD [0.25], MAX_PLAUSIBLE_PROFIT_SHARE [0.25]
//     FASTLANE_TRIG_SKIP        [proven] how feed transactions we can't run
//                               are treated when TRIG_FIRST_ASSUME allows
//                               "skip": proven = left out ONLY when provably
//                               unrelated (check/ordered.rs PROVEN SKIPPING;
//                               otherwise the route is unknown, and any revert
//                               after reading an assumed sender value is
//                               unknown too); bot = the bot's best-effort
//                               rules (skipped_unrelated / skipped_related)
//   (Oct 27) Every "unknown" is also counted by WHERE it came from (the
//   trigger, a transaction replayed only because copy 2 lags, the
//   trigger's own block, a later one) and by target contract + the role of
//   the first missing item (fastlane/coverage.rs): status
//   "fastlane.trigger.unknownWhere" / "unknownTop".
//   Only when FASTLANE is practice / live (nothing runs when off). One
//   thread, lower CPU priority (FASTLANE_NICE, default 10), a bounded queue
//   of 64 messages (newest kept: an old message is useless).
// ============================================================================
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use revm::primitives::Address;
use serde_json::{json, Value};

use super::lane::{Firer, FiredWhat};
use super::mode::Mode;
use super::scan::{Facts, PreparedCheck, BOT_MIN_NET_USD};
use super::types::{FlashLender, Opportunity, ViewKind};
use crate::check::feedstore::BinMsg;
use crate::server::{CheckedRow, Ctx, EntryRun};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct TrigCfg {
    pub on: bool,
    pub max_txs: usize,
    pub budget_us: u64,
    pub max_lag_ms: u64,
    pub max_candidates: usize,
    pub max_pools: usize,
    pub min_conf: String,
    pub back_msgs: u64,
    pub max_msgs: u64,
    pub strict: bool,
    pub assume: Vec<String>,
    /// FASTLANE_TRIG_SKIP: true = proven skipping (default), false = the
    /// bot's best-effort skipping rules.
    pub proven_skip: bool,
    pub min_net_usd: f64,
    pub max_plausible_share: f64,
    pub l2_offset: u64,
    /// Addresses whose transactions are ours (never triggers): our
    /// contract (ARB_EXECUTOR_ROBINHOOD) and our wallet (the gun's).
    pub ours: Vec<Address>,
    /// SPEED FIX 3 (Oct 29), FASTLANE_TRIG_WAIT [off]: off = questions use
    /// copy 2's newest replayed block NOW ("headNow") and replay the feed
    /// messages after it; on = wait (up to ARBSIM_WAIT_MS) for a block that
    /// has arrived but isn't replayed yet, as before. Live: the wait was
    /// ~30 ms on most questions (disc p90 30.1 ms, checks p50 28 ms).
    pub wait_for_copy: bool,
    /// SPEED FIX 4 (Oct 29), FASTLANE_TRIG_DISCOVER_FIRST [off]: on = for a
    /// feed message, first run the cheap "which of our pools does it move?"
    /// discovery for EVERY transaction, then the slow candidate checks only
    /// for the ones that moved our pools. off = each transaction fully (its
    /// checks too) before the next, as before. Live before: a pool-moving
    /// trigger waited behind the whole work of the transactions ahead of it
    /// (decide p50 ~30-35 ms while its own checks were ~9 ms).
    /// MEASURED SLOWER live (Oct 29 22:40-22:55): the wait came mostly from
    /// the discoveries ahead, not from checks, and discover-first made each
    /// pool-moving trigger wait for EVERY discovery of the message (line p50
    /// 10 -> 23 ms, decide 27 -> 40 ms). Off by default.
    pub discover_first: bool,
    /// SPEED (Oct 29), FASTLANE_TRIG_COLD_SKIP [observe]: a transaction to a
    /// contract asked about FASTLANE_TRIG_COLD_AFTER (50) times that never
    /// moved our pools. off = no check; observe = still run it, count what
    /// skipping would save and how often it would have been wrong; on =
    /// skip it ("cold_target").
    pub cold_skip: String,
    pub cold_after: u64,
}

impl Default for TrigCfg {
    fn default() -> Self {
        TrigCfg {
            on: true,
            max_txs: 16,
            budget_us: 40_000,
            max_lag_ms: 60,
            max_candidates: 6,
            max_pools: 4,
            min_conf: "medium".into(),
            back_msgs: 8,
            max_msgs: 48,
            strict: false,
            assume: vec!["sender_funds".into(), "recent_fill".into(), "skip".into()],
            proven_skip: true,
            min_net_usd: BOT_MIN_NET_USD,
            max_plausible_share: 0.25,
            l2_offset: 0,
            ours: Vec::new(),
            wait_for_copy: false,
            discover_first: false,
            cold_skip: "observe".into(),
            cold_after: 50,
        }
    }
}

impl TrigCfg {
    /// The assumptions a question names (`feed.assume`): the bot's list,
    /// with "skip" turned into "skip_proven" in proven mode (server.rs
    /// trig_assume: proven skipping, the best-effort rules off).
    pub fn feed_assume(&self) -> Vec<String> {
        self.assume.iter().map(|a| if a == "skip" && self.proven_skip { "skip_proven".to_string() } else { a.clone() }).collect()
    }

    /// From any key -> value lookup. Bad values fall back to the default.
    pub fn from_lookup(get: &dyn Fn(&str) -> Option<String>) -> TrigCfg {
        let d = TrigCfg::default();
        let num = |k: &str| get(k).and_then(|v| v.trim().parse::<f64>().ok()).filter(|v| v.is_finite());
        let on = !matches!(get("FASTLANE_TRIGGER").map(|v| v.trim().to_ascii_lowercase()).as_deref(), Some("off" | "0" | "false" | "no"));
        let conf = get("TRIG_FIRST_MIN_CONFIDENCE").map(|v| v.trim().to_ascii_lowercase()).unwrap_or_default();
        let strict = get("TRIG_FIRST_STRICT").is_some_and(|v| v.trim() == "1");
        let assume: Vec<String> = match get("TRIG_FIRST_ASSUME") {
            None => d.assume.clone(),
            Some(v) => v.split(',').map(|x| x.trim().to_ascii_lowercase()).filter(|x| matches!(x.as_str(), "sender_funds" | "recent_fill" | "skip")).collect(),
        };
        let min_net = num("FASTLANE_MIN_NET_USD").filter(|v| *v > 0.0).or_else(|| num("MIN_EXEC_NET_USD").filter(|v| *v > 0.0)).unwrap_or(d.min_net_usd);
        let mut ours = Vec::new();
        if let Some(a) = get("ARB_EXECUTOR_ROBINHOOD").and_then(|s| crate::check::hexutil::parse_address(s.trim()).ok()) {
            ours.push(a);
        }
        TrigCfg {
            on,
            max_txs: num("FASTLANE_TRIG_MAX_TXS").filter(|v| (1.0..=256.0).contains(v)).map(|v| v as usize).unwrap_or(d.max_txs),
            budget_us: num("FASTLANE_TRIG_BUDGET_MS").filter(|v| (1.0..=1000.0).contains(v)).map(|v| (v * 1000.0) as u64).unwrap_or(d.budget_us),
            max_lag_ms: num("FASTLANE_TRIG_MAX_LAG_MS").filter(|v| (1.0..=10_000.0).contains(v)).map(|v| v as u64).unwrap_or(d.max_lag_ms),
            max_candidates: num("TRIG_ENTRY_MAX_CANDIDATES").filter(|v| (1.0..=32.0).contains(v)).map(|v| v.round() as usize).unwrap_or(d.max_candidates),
            max_pools: num("TRIG_ENTRY_MAX_POOLS").filter(|v| (1.0..=64.0).contains(v)).map(|v| v.round() as usize).unwrap_or(d.max_pools),
            // The bot's minConfidenceOf: high / low as given, anything else medium.
            min_conf: if conf == "high" || conf == "low" { conf } else { "medium".into() },
            back_msgs: num("TRIG_FIRST_BACK_MSGS").filter(|v| *v >= 0.0).map(|v| v.round() as u64).unwrap_or(d.back_msgs),
            max_msgs: num("TRIG_FIRST_MAX_MSGS").filter(|v| *v >= 2.0).map(|v| v.round() as u64).unwrap_or(d.max_msgs),
            strict,
            assume: if strict { Vec::new() } else { assume },
            proven_skip: !matches!(get("FASTLANE_TRIG_SKIP").map(|v| v.trim().to_ascii_lowercase()).as_deref(), Some("bot" | "best" | "heuristic")),
            min_net_usd: min_net,
            max_plausible_share: num("MAX_PLAUSIBLE_PROFIT_SHARE").filter(|v| *v > 0.0).unwrap_or(d.max_plausible_share),
            l2_offset: num("ARBSIM_L2_BLOCK_OFFSET").filter(|v| *v >= 0.0).map(|v| v as u64).unwrap_or(0),
            ours,
            wait_for_copy: crate::fastlane::mode::parse_on(get("FASTLANE_TRIG_WAIT").as_deref()),
            discover_first: crate::fastlane::mode::parse_on(get("FASTLANE_TRIG_DISCOVER_FIRST").as_deref()),
            cold_skip: match get("FASTLANE_TRIG_COLD_SKIP").map(|v| v.trim().to_ascii_lowercase()).as_deref() {
                Some("on") => "on".into(),
                Some("off") => "off".into(),
                _ => d.cold_skip.clone(),
            },
            cold_after: num("FASTLANE_TRIG_COLD_AFTER").filter(|v| *v >= 1.0).map(|v| v.round() as u64).unwrap_or(d.cold_after),
        }
    }
}

// ---------------------------------------------------------------------------
// Quick skip (the bot's trigEntry.ts quickSkip, same rules)
// ---------------------------------------------------------------------------

/// Calls that never move a pool by themselves (a coin's own functions):
/// approve, transfer, transferFrom, WETH deposit / withdraw, permit,
/// setApprovalForAll (trigEntry.ts NON_SWAP).
pub const NON_SWAP: [[u8; 4]; 7] = [
    [0x09, 0x5e, 0xa7, 0xb3],
    [0xa9, 0x05, 0x9c, 0xbb],
    [0x23, 0xb8, 0x72, 0xdd],
    [0xd0, 0xe3, 0x0d, 0xb0],
    [0x2e, 0x1a, 0x7d, 0x4d],
    [0xd5, 0x05, 0xac, 0xcf],
    [0xa2, 0x2c, 0xb4, 0x65],
];

/// Why a feed transaction needs no work at all (None = look at it).
pub fn quick_skip(tx: &crate::check::rawtx::DecodedTx, ours: &[Address]) -> Option<&'static str> {
    if ours.contains(&tx.from) {
        return Some("ours");
    }
    let Some(to) = tx.to else { return Some("create") };
    if ours.contains(&to) {
        return Some("ours");
    }
    if tx.data.len() < 4 {
        return Some("plain_transfer");
    }
    if NON_SWAP.iter().any(|s| tx.data[..4] == s[..]) {
        return Some("coin_call");
    }
    None
}

// ---------------------------------------------------------------------------
// The answer -> a trade for the gun
// ---------------------------------------------------------------------------

/// Turn the stop rule's accepted answer into an Opportunity: the table
/// row's exact route (its check, parsed the scanner's way) at the answer's
/// best size, valued with the bot's facts. Err = why not (counted).
pub fn opportunity(c: &CheckedRow, codes: &[String], cache: &mut HashMap<usize, (revm::primitives::B256, revm::bytecode::Bytecode)>, block: u64, cfg: &TrigCfg, found_at: Instant, arrived: Instant) -> Result<Opportunity, &'static str> {
    let check = c.row.c.as_ref().ok_or("no_check")?;
    let answer = c.answer.as_ref().ok_or("no_answer")?;
    let f = c.row.f.as_deref().and_then(Facts::from_json).ok_or("no_facts")?;
    let prep = PreparedCheck::from_row_cached(check, codes, cache).map_err(|_| "bad_row")?;
    let (amount, profit, gas_used) = crate::check::entry::best_profit(answer, check).ok_or("no_profit")?;
    let net = f.usd_of(profit) - f.gas_usd;
    if !net.is_finite() || net < cfg.min_net_usd {
        return Err("below_min");
    }
    let size_usd = f.usd_of(amount);
    if !(size_usd > 0.0) || net / size_usd > cfg.max_plausible_share {
        return Err("implausible");
    }
    let keys: Vec<String> = check.get("route").and_then(|r| r.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).map(|s| s.to_ascii_lowercase()).collect()).unwrap_or_default();
    let t = &prep.trade;
    let lender = t.flash.lender().map(|a| format!("{a:#x}"));
    let pools: Vec<String> = keys.iter().filter(|k| Some(k.as_str()) != lender.as_deref()).cloned().collect();
    let mut tokens = vec![t.token];
    for h in &t.hops {
        for x in [h.token_in, h.token_out] {
            if !tokens.contains(&x) {
                tokens.push(x);
            }
        }
    }
    Ok(Opportunity {
        block,
        view: ViewKind::Trigger,
        route_label: f.label.clone(),
        rid: c.row.rid.clone(),
        token_in: t.token,
        token_in_decimals: f.decimals,
        usd_per_token_in: f.usd_per_token,
        amount_in: amount,
        size_usd,
        hops: t.hops.clone(),
        flash: t.flash,
        profit_units: profit,
        expected_net_usd: net,
        gas_usd: f.gas_usd,
        gas_used,
        loan_fee_usd: match t.flash {
            FlashLender::Own => Some(0.0),
            _ => f.loan_pips.map(|p| size_usd * p as f64 / 1_000_000.0),
        },
        pools,
        keys,
        tokens,
        found_at,
        scan_us: found_at.saturating_duration_since(arrived).as_micros() as u64,
        source: "trigger",
        check: Arc::new(prep),
    })
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct TrigHour {
    pub msgs: u64,
    pub msgs_late: u64,
    pub msgs_no_copy: u64,
    pub queue_dropped: u64,
    pub txs: u64,
    pub skipped: BTreeMap<&'static str, u64>,
    /// Transactions not looked at: over FASTLANE_TRIG_MAX_TXS / the budget.
    pub cut: u64,
    pub asked: u64,
    /// Discovery said "unknown" (why -> count).
    pub disc_unknown: BTreeMap<String, u64>,
    pub no_pools: u64,
    pub too_many_pools: u64,
    pub moved: u64,
    pub no_table: u64,
    pub no_candidates: u64,
    /// Candidate routes checked (each one: the trigger replayed + our trade
    /// at the size ladder).
    pub routes_checked: u64,
    /// Candidate answers: unknown reasons / sure (any verdict) / good enough.
    pub answer_unknown: BTreeMap<String, u64>,
    pub answers_sure: u64,
    pub good: u64,
    /// Good answers that could not become a trade (why -> count).
    pub not_trade: BTreeMap<&'static str, u64>,
    pub fired: u64,
    pub would_send: u64,
    pub live_sent: u64,
    pub blocked: BTreeMap<&'static str, u64>,
    pub gun_refused: BTreeMap<String, u64>,
    pub not_left: u64,
    pub repeats: u64,
    /// Feed message reached arbsim -> work on it started (us).
    pub queue_us: Vec<u64>,
    /// Feed message reached arbsim -> the decision for a trigger that moved
    /// our pools (us), whether it paid or not.
    pub decide_us: Vec<u64>,
    /// Feed message reached arbsim -> signed bytes ready (practice) /
    /// handed to the socket (live), would-sends and sends only (us).
    pub ready_us: Vec<u64>,
    /// Per feed message, all of its work (us).
    pub msg_us: Vec<u64>,
    /// SPEED STEPS (Oct 28): per asked trigger, the whole one-trip run, its
    /// "which pools?" discovery, and the candidate checks (us).
    pub entry_us: Vec<u64>,
    pub disc_us: Vec<u64>,
    pub checks_us: Vec<u64>,
    /// LINE TIMER (Oct 29): for triggers that moved our pools, the time from
    /// the feed message reaching arbsim to THIS trigger's own work starting
    /// (us), i.e. how long it waited in line behind the message's earlier
    /// transactions. decideUs = lineUs + this trigger's own work.
    pub line_us: Vec<u64>,
    /// Same triggers: their place in the message (0 = first transaction).
    pub line_pos: Vec<u64>,
    /// DISCOVERY PHASES (Oct 29): per discovery, each phase's time (us), for
    /// all discoveries and for the slow ones (over 2 ms) apart, plus the
    /// thread's CPU time. Discovery is p50 ~0.2 ms but p90 4+ ms and is
    /// most of the wait in line: this shows which step makes it slow.
    pub disc_ph: BTreeMap<String, Vec<u64>>,
    pub disc_ph_slow: BTreeMap<String, Vec<u64>>,
    pub disc_cpu: Vec<u64>,
    pub disc_slow: u64,
    /// COLD TARGETS: transactions to a cold target (skipped when on), their
    /// work time (us, observe), and how many of them moved our pools anyway.
    pub cold: u64,
    pub cold_us: u64,
    pub cold_moved: u64,
    /// ENTRY STEPS (Oct 29), triggers that moved our pools only (us): the
    /// whole one-trip question, its route picking, its checks as the caller
    /// saw them (wall), the checks' own `us` sum, and the question building.
    pub mv_entry: Vec<u64>,
    pub mv_pick: Vec<u64>,
    pub mv_checks_wall: Vec<u64>,
    pub mv_checks_own: Vec<u64>,
    pub mv_build: Vec<u64>,
    pub mv_disc: Vec<u64>,
    /// Same triggers: candidates checked, and each check phase summed over
    /// its candidates (us; counts like rounds as numbers).
    pub mv_cands: Vec<u64>,
    pub mv_check_ph: BTreeMap<String, Vec<u64>>,
    /// (Oct 27) Every unknown (discovery and candidate checks) by
    /// "where|reason" and by "reason|where|target|first missing item"
    /// (fastlane/coverage.rs). Bounded.
    pub unknown_where: super::coverage::Tally,
    pub unknown_top: super::coverage::Tally,
}

impl TrigHour {
    /// Discovery phase times as {phase: percentiles (+ n, sum)}.
    fn disc_ph_json(&self, slow: bool) -> Value {
        let m = if slow { &self.disc_ph_slow } else { &self.disc_ph };
        let mut out = serde_json::Map::new();
        for (k, v) in m {
            let mut p = pctl(v);
            p["sum"] = json!(v.iter().sum::<u64>());
            out.insert(k.clone(), p);
        }
        Value::Object(out)
    }
}

fn push(v: &mut Vec<u64>, x: u64) {
    if v.len() >= 5_000 {
        v.remove(0);
    }
    v.push(x);
}

fn pctl(v: &[u64]) -> Value {
    let mut s = v.to_vec();
    crate::timing::pct_of(&mut s)
}

fn top<K: std::fmt::Display>(m: &BTreeMap<K, u64>, n: usize) -> String {
    let mut v: Vec<(String, u64)> = m.iter().map(|(k, c)| (k.to_string(), *c)).collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    v.into_iter().take(n).map(|(k, c)| format!("{k}:{c}")).collect::<Vec<_>>().join(" ")
}

impl TrigHour {
    pub fn json(&self) -> Value {
        let mut j = json!({
            "msgs": self.msgs, "msgsLate": self.msgs_late, "msgsNoCopy": self.msgs_no_copy, "queueDropped": self.queue_dropped,
            "txs": self.txs, "skipped": self.skipped, "cut": self.cut, "asked": self.asked,
            "discUnknown": self.disc_unknown, "noPools": self.no_pools, "tooManyPools": self.too_many_pools, "moved": self.moved,
            "noTable": self.no_table, "noCandidates": self.no_candidates, "routesChecked": self.routes_checked,
            "answerUnknown": self.answer_unknown, "answersSure": self.answers_sure, "good": self.good, "notTrade": self.not_trade,
            "fired": self.fired, "wouldSend": self.would_send, "liveSent": self.live_sent, "blocked": self.blocked,
            "gunRefused": self.gun_refused, "notLeft": self.not_left, "repeats": self.repeats,
            "queueUs": pctl(&self.queue_us), "decideUs": pctl(&self.decide_us), "readyUs": pctl(&self.ready_us), "msgUs": pctl(&self.msg_us),
            "entryUs": pctl(&self.entry_us), "discUs": pctl(&self.disc_us), "checksUs": pctl(&self.checks_us),
            "lineUs": pctl(&self.line_us), "linePos": pctl(&self.line_pos),
            "unknownWhere": self.unknown_where.json(24), "unknownTop": self.unknown_top.json(20),
            "timesNote": "inside arbsim, from the moment the feed message reached it; excludes sequencer -> bot -> arbsim delivery and block inclusion",
        });
        j["discCpuUs"] = pctl(&self.disc_cpu);
        j["discSlow"] = json!(self.disc_slow);
        j["cold"] = json!({"n": self.cold, "us": self.cold_us, "movedAnyway": self.cold_moved});
        let mut ph = serde_json::Map::new();
        for (k, v) in &self.mv_check_ph {
            ph.insert(k.clone(), pctl(v));
        }
        j["movedCheckPh"] = Value::Object(ph);
        j["movedCands"] = pctl(&self.mv_cands);
        j["movedSteps"] = json!({
            "entry": pctl(&self.mv_entry), "disc": pctl(&self.mv_disc), "pick": pctl(&self.mv_pick),
            "checksWall": pctl(&self.mv_checks_wall), "checksOwn": pctl(&self.mv_checks_own), "build": pctl(&self.mv_build),
        });
        j["discPh"] = self.disc_ph_json(false);
        j["discPhSlow"] = self.disc_ph_json(true);
        j
    }

    pub fn line(&self) -> String {
        let p = |v: &[u64], k: &str| pctl(v).get(k).and_then(|x| x.as_u64()).map(|x| x.to_string()).unwrap_or_else(|| "-".into());
        format!(
            "[fastlane trigger] (last hour) feed msgs {} (late {}, no copy {}, queue full {}) | txs {} skipped [{}] cut {} | asked {}: moved our pools {}, none {}, too many {}, unknown [{}] (where [{}]) | no table {} no candidates {} | routes checked {}: sure {}, unknown [{}], good {} (not a trade [{}]) | fired {}: would send {}, live sent {}, safety blocked [{}], gun refused {}, never left {} | repeats {} | us inside arbsim: queue p50 {} p90 {} | decision p50 {} p90 {} p99 {} | ready-to-send p50 {} p90 {} p99 {}",
            self.msgs, self.msgs_late, self.msgs_no_copy, self.queue_dropped, self.txs, top(&self.skipped, 5), self.cut, self.asked, self.moved, self.no_pools, self.too_many_pools, top(&self.disc_unknown, 5),
            self.unknown_where.top(6).into_iter().map(|(k, c)| format!("{k}:{c}")).collect::<Vec<_>>().join(" "),
            self.no_table, self.no_candidates, self.routes_checked, self.answers_sure, top(&self.answer_unknown, 5), self.good, top(&self.not_trade, 4),
            self.fired, self.would_send, self.live_sent, top(&self.blocked, 5), self.gun_refused.values().sum::<u64>(), self.not_left, self.repeats,
            p(&self.queue_us, "p50"), p(&self.queue_us, "p90"), p(&self.decide_us, "p50"), p(&self.decide_us, "p90"), p(&self.decide_us, "p99"),
            p(&self.ready_us, "p50"), p(&self.ready_us, "p90"), p(&self.ready_us, "p99"),
        )
    }
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

/// Did this outcome come from a trigger that moved our pools?
fn moved_outcome(o: &TrigOutcome) -> bool {
    !matches!(o, TrigOutcome::DiscoverUnknown(_) | TrigOutcome::NoPools | TrigOutcome::TooManyPools | TrigOutcome::Skipped(_) | TrigOutcome::Repeat)
}

/// Discovery answered and named 1..=max_pools of our pools (the cases
/// trig_entry goes on to check; decide() treats the rest without checks).
pub fn moves_ours(disc: &Value, max_pools: usize) -> bool {
    if disc.get("ok") != Some(&Value::Bool(true)) {
        return false;
    }
    let n = disc.get("pools").and_then(|p| p.as_array()).map(|a| a.len()).unwrap_or(0);
    n > 0 && n <= max_pools
}

/// What happened to one trigger (tests and the per-message loop).
#[derive(Clone, Debug, PartialEq)]
pub enum TrigOutcome {
    Skipped(&'static str),
    Repeat,
    DiscoverUnknown(String),
    NoPools,
    TooManyPools,
    NoTable,
    NoCandidates,
    /// Candidates checked, none good enough.
    NotGood,
    /// Good, but no trade could be made of it (why).
    NotTrade(&'static str),
    /// Fired: blocked by safety / refused by the gun / never left / written.
    Fired(FiredWhat),
}

pub struct Trigger {
    pub cfg: TrigCfg,
    pub firer: Firer,
    pub hour: TrigHour,
    /// Codes parsed per table generation (the scanner's cache, own copy).
    cache_gen: Option<u64>,
    cache: HashMap<usize, (revm::primitives::B256, revm::bytecode::Bytecode)>,
    /// Trigger hashes already worked on (one decision per trigger): bounded.
    seen: HashSet<revm::primitives::B256>,
    seen_order: VecDeque<revm::primitives::B256>,
    /// Practice would-sends go to the lane's practice scoring (false in tests
    /// that score nothing).
    pub to_practice: bool,
}

impl Trigger {
    pub fn new(cfg: TrigCfg, firer: Firer) -> Trigger {
        Trigger { cfg, firer, hour: TrigHour::default(), cache_gen: None, cache: HashMap::new(), seen: HashSet::new(), seen_order: VecDeque::new(), to_practice: true }
    }

    fn remember(&mut self, h: revm::primitives::B256) -> bool {
        if !self.seen.insert(h) {
            return false;
        }
        self.seen_order.push_back(h);
        while self.seen_order.len() > 4_096 {
            if let Some(x) = self.seen_order.pop_front() {
                self.seen.remove(&x);
            }
        }
        true
    }

    /// One feed message: every possible trigger in it, in order, within the
    /// budget. `arrived` = when arbsim stored it. Returns each trigger's outcome.
    pub fn on_message(&mut self, ctx: &Ctx, m: &BinMsg, arrived: Instant) -> Vec<TrigOutcome> {
        let start = Instant::now();
        self.hour.msgs += 1;
        push(&mut self.hour.queue_us, start.saturating_duration_since(arrived).as_micros() as u64);
        let mut out = Vec::new();
        if arrived.elapsed() > Duration::from_millis(self.cfg.max_lag_ms) {
            self.hour.msgs_late += 1;
            return out;
        }
        if !m.complete || m.bad.is_some() {
            // (the bot's plan answers feed_unreplayable for it anyway)
            return out;
        }
        let Some(head) = ctx.shared.head() else {
            self.hour.msgs_no_copy += 1;
            return out;
        };
        let newest = crate::check::feedstore::store().newest().unwrap_or(m.seq).max(m.seq);
        // DISCOVER FIRST: (place in `out`, place in message, question,
        // discovery answer, discovery time us) of triggers that moved ours.
        let mut later: Vec<(usize, usize, Value, Value, u64)> = Vec::new();
        for (i, tx) in m.txs.iter().enumerate() {
            if i >= self.cfg.max_txs || start.elapsed().as_micros() as u64 >= self.cfg.budget_us {
                self.hour.cut += (m.txs.len() - i) as u64;
                break;
            }
            self.hour.txs += 1;
            let mut cold = false;
            let skip = match tx.decoded() {
                Ok(d) => {
                    let q = quick_skip(&d, &self.cfg.ours);
                    if q.is_none() && self.cfg.cold_skip != "off" {
                        cold = d.to.is_some_and(|t| ctx.copy2.as_ref().is_some_and(|c| c.c2.discover_fill.lock().map(|b| b.cold(&t, self.cfg.cold_after)).unwrap_or(false)));
                    }
                    q
                }
                Err(_) => Some("unreadable"),
            };
            if cold {
                self.hour.cold += 1;
            }
            // (on: every 20th still runs, so a target that starts moving our
            // pools is learned again)
            let skip = if cold && self.cfg.cold_skip == "on" && !self.hour.cold.is_multiple_of(20) { skip.or(Some("cold_target")) } else { skip };
            if let Some(why) = skip {
                *self.hour.skipped.entry(why).or_default() += 1;
                out.push(TrigOutcome::Skipped(why));
                continue;
            }
            if !self.remember(tx.hash) {
                self.hour.repeats += 1;
                out.push(TrigOutcome::Repeat);
                continue;
            }
            let left = self.cfg.budget_us.saturating_sub(start.elapsed().as_micros() as u64).max(1_000);
            let started = Instant::now();
            if !self.cfg.discover_first {
                let o = self.one_trigger(ctx, m.seq, head.seq, newest, tx.hash, arrived, left);
                if cold {
                    self.hour.cold_us += started.elapsed().as_micros() as u64;
                    if moved_outcome(&o) {
                        self.hour.cold_moved += 1;
                    }
                }
                if moved_outcome(&o) {
                    // Moved our pools: how long it waited in line, and where.
                    push(&mut self.hour.line_us, started.saturating_duration_since(arrived).as_micros() as u64);
                    push(&mut self.hour.line_pos, i as u64);
                }
                out.push(o);
                continue;
            }
            // DISCOVER FIRST: the cheap step now; the checks of a trigger
            // that moved our pools wait until every transaction of the
            // message has been through discovery.
            self.hour.asked += 1;
            let req = self.trigger_req(m.seq, head.seq, newest, tx.hash, left);
            crate::timing::ph_reset();
            let Some(disc) = crate::server::trig_entry_discover(ctx, &json!(0), &req) else {
                out.push(TrigOutcome::DiscoverUnknown("error".into()));
                continue;
            };
            let disc_us = started.elapsed().as_micros() as u64;
            if moves_ours(&disc, self.cfg.max_pools) {
                out.push(TrigOutcome::Repeat); // placeholder, replaced below
                later.push((out.len() - 1, i, req, disc, disc_us));
            } else {
                // Nothing of ours to check: finish it now (counts as before).
                let mut tm = crate::timing::Tm::default();
                let (mut ans, run) = crate::server::trig_entry_checks(ctx, &json!(0), &req, disc, started, &mut tm);
                ans["us"] = json!(started.elapsed().as_micros() as u64);
                out.push(self.after_entry(ans, run, m.seq, arrived));
            }
        }
        // Checks of the triggers that moved our pools, in message order.
        for (slot, i, mut req, disc, disc_us) in later {
            let t = Instant::now();
            push(&mut self.hour.line_us, t.saturating_duration_since(arrived).as_micros() as u64);
            push(&mut self.hour.line_pos, i as u64);
            let left = self.cfg.budget_us.saturating_sub(start.elapsed().as_micros() as u64).max(1_000);
            req["budgetUs"] = json!(left);
            let mut tm = crate::timing::Tm::default();
            let (mut ans, run) = crate::server::trig_entry_checks(ctx, &json!(0), &req, disc, t, &mut tm);
            // `us` = this trigger's own work: its discovery + its checks.
            ans["us"] = json!(disc_us + t.elapsed().as_micros() as u64);
            out[slot] = self.after_entry(ans, run, m.seq, arrived);
        }
        push(&mut self.hour.msg_us, start.elapsed().as_micros() as u64);
        out
    }

    /// The trig_entry question the bot would ask for one trigger.
    fn trigger_req(&self, seq: u64, copy_seq: u64, newest: u64, hash: revm::primitives::B256, budget_us: u64) -> Value {
        // The feed messages a bot question would name (triggerFirst.ts
        // buildFeed): from a little before the copy's newest block (or the
        // trigger, if older) up to the newest message held.
        let mut from = seq.min(copy_seq).saturating_sub(self.cfg.back_msgs);
        from = from.max(newest.saturating_sub(self.cfg.max_msgs.saturating_sub(1)));
        let refs = crate::check::feedstore::store().refs_range(from, newest);
        let feed = json!({
            "trigger": format!("{hash:#x}"), "triggerSeq": seq, "refs": refs,
            "route": [], "strict": self.cfg.strict, "assume": self.cfg.feed_assume(),
        });
        json!({
            "type": "trig_entry", "at": {"after": if self.cfg.wait_for_copy { "head" } else { "headNow" }}, "feed": feed, "limit": self.cfg.max_candidates,
            "maxPools": self.cfg.max_pools, "minConf": self.cfg.min_conf, "budgetUs": budget_us,
        })
    }

    /// Count a trig_entry answer's step times, then decide on it.
    fn after_entry(&mut self, ans: Value, run: Option<EntryRun>, seq: u64, arrived: Instant) -> TrigOutcome {
        if run.as_ref().is_some_and(|r| !r.pools.is_empty() && r.pools.len() <= self.cfg.max_pools) {
            let g = |v: &Value| v.as_u64().unwrap_or(0);
            push(&mut self.hour.mv_entry, g(&ans["us"]));
            push(&mut self.hour.mv_disc, g(&ans["disc"]["us"]));
            push(&mut self.hour.mv_pick, g(&ans["pickUs"]));
            push(&mut self.hour.mv_checks_wall, g(&ans["checksWallUs"]));
            let cands = ans.get("cands").and_then(|c| c.as_array());
            push(&mut self.hour.mv_checks_own, cands.map(|c| c.iter().map(|x| g(&x["a"]["us"])).sum()).unwrap_or(0));
            push(&mut self.hour.mv_build, cands.map(|c| c.iter().map(|x| g(&x["a"]["buildUs"])).sum()).unwrap_or(0));
            push(&mut self.hour.mv_cands, cands.map(|c| c.len() as u64).unwrap_or(0));
            let mut sums: BTreeMap<String, u64> = BTreeMap::new();
            for x in cands.into_iter().flatten() {
                for key in ["ph", "pn"] {
                    if let Some(o) = x["a"].get(key).and_then(|p| p.as_object()) {
                        for (k, v) in o {
                            *sums.entry(if key == "pn" { format!("n:{k}") } else { k.clone() }).or_default() += v.as_u64().unwrap_or(0);
                        }
                    }
                }
            }
            for (k, v) in sums {
                push(self.hour.mv_check_ph.entry(k).or_default(), v);
            }
        }
        if let Some(u) = ans.get("us").and_then(|v| v.as_u64()) {
            push(&mut self.hour.entry_us, u);
        }
        if let Some(u) = ans.get("disc").and_then(|d| d.get("us")).and_then(|v| v.as_u64()) {
            push(&mut self.hour.disc_us, u);
            let slow = u > 2_000;
            if slow {
                self.hour.disc_slow += 1;
            }
            if let Some(c) = ans["disc"].get("cpu").and_then(|v| v.as_u64()) {
                push(&mut self.hour.disc_cpu, c);
            }
            if let Some(ph) = ans["disc"].get("ph").and_then(|p| p.as_object()) {
                for (k, v) in ph {
                    let Some(x) = v.as_u64() else { continue };
                    push(self.hour.disc_ph.entry(k.clone()).or_default(), x);
                    if slow {
                        push(self.hour.disc_ph_slow.entry(k.clone()).or_default(), x);
                    }
                }
                // the rest of the time: not inside any named phase
                let named: u64 = ph.values().filter_map(|v| v.as_u64()).sum();
                push(self.hour.disc_ph.entry("other".into()).or_default(), u.saturating_sub(named));
                if slow {
                    push(self.hour.disc_ph_slow.entry("other".into()).or_default(), u.saturating_sub(named));
                }
            }
        }
        if let Some(c) = ans.get("cands").and_then(|c| c.as_array()) {
            push(&mut self.hour.checks_us, c.iter().filter_map(|x| x.get("a").and_then(|a| a.get("us")).and_then(|v| v.as_u64())).sum());
        }
        self.decide(&ans, run, seq, arrived)
    }

    /// The bot's one-trip question for one trigger, answered by the server's
    /// own code, then (good answer) the trade straight to safety + gun.
    #[allow(clippy::too_many_arguments)]
    pub fn one_trigger(&mut self, ctx: &Ctx, seq: u64, copy_seq: u64, newest: u64, hash: revm::primitives::B256, arrived: Instant, budget_us: u64) -> TrigOutcome {
        self.hour.asked += 1;
        let req = self.trigger_req(seq, copy_seq, newest, hash, budget_us);
        let mut tm = crate::timing::Tm::default();
        crate::timing::ph_reset();
        let (ans, run) = crate::server::trig_entry_run(ctx, &json!(0), &req, Instant::now(), &mut tm);
        self.after_entry(ans, run, seq, arrived)
    }

    /// Count one unknown answer by where it came from and what it missed
    /// (fastlane/coverage.rs). `stage`: discover / check.
    fn attribute(&mut self, stage: &str, a: &Value, trigger_seq: u64) {
        let (reason, place, to, first) = super::coverage::attribute_json(a, trigger_seq);
        self.hour.unknown_where.add(format!("{stage}|{place}|{reason}"));
        self.hour.unknown_top.add(format!("{reason}|{place}|to {}|{}", to.as_deref().unwrap_or("-"), first.as_deref().unwrap_or("-")));
    }

    /// From the one-trip answer to a fire (separate so tests can hand it an
    /// answer). Counts everything.
    pub fn decide(&mut self, ans: &Value, run: Option<EntryRun>, seq: u64, arrived: Instant) -> TrigOutcome {
        let disc = &ans["disc"];
        if disc.get("ok") != Some(&Value::Bool(true)) {
            let why = disc.get("unknown").and_then(|u| u.as_str()).or_else(|| ans.get("unknown").and_then(|u| u.as_str())).unwrap_or("error").to_string();
            *self.hour.disc_unknown.entry(why.clone()).or_default() += 1;
            self.attribute("discover", disc, seq);
            return TrigOutcome::DiscoverUnknown(why);
        }
        let Some(run) = run else {
            *self.hour.disc_unknown.entry("error".into()).or_default() += 1;
            return TrigOutcome::DiscoverUnknown("error".into());
        };
        if run.pools.is_empty() {
            self.hour.no_pools += 1;
            return TrigOutcome::NoPools;
        }
        if run.pools.len() > self.cfg.max_pools {
            self.hour.too_many_pools += 1;
            return TrigOutcome::TooManyPools;
        }
        self.hour.moved += 1;
        let Some((gen, codes)) = run.table.clone() else {
            self.hour.no_table += 1;
            push(&mut self.hour.decide_us, arrived.elapsed().as_micros() as u64);
            return TrigOutcome::NoTable;
        };
        if run.checked.is_empty() {
            self.hour.no_candidates += 1;
            push(&mut self.hour.decide_us, arrived.elapsed().as_micros() as u64);
            return TrigOutcome::NoCandidates;
        }
        let mut good: Option<&CheckedRow> = None;
        for c in &run.checked {
            let Some(a) = &c.answer else {
                *self.hour.answer_unknown.entry("no_check".into()).or_default() += 1;
                continue;
            };
            self.hour.routes_checked += 1;
            if a.get("ok") == Some(&Value::Bool(true)) {
                self.hour.answers_sure += 1;
            } else {
                let why = a.get("unknown").and_then(|u| u.as_str()).unwrap_or("error").to_string();
                *self.hour.answer_unknown.entry(why).or_default() += 1;
                self.attribute("check", a, seq);
            }
            if c.good && good.is_none() {
                good = Some(c);
            }
        }
        let found_at = Instant::now();
        push(&mut self.hour.decide_us, found_at.saturating_duration_since(arrived).as_micros() as u64);
        let Some(g) = good else { return TrigOutcome::NotGood };
        self.hour.good += 1;
        if self.cache_gen != Some(gen) {
            // A new table may renumber its code list: parsed codes start over.
            self.cache.clear();
            self.cache_gen = Some(gen);
        }
        let block = seq + self.cfg.l2_offset;
        let o = match opportunity(g, &codes, &mut self.cache, block, &self.cfg, found_at, arrived) {
            Ok(o) => o,
            Err(why) => {
                *self.hour.not_trade.entry(why).or_default() += 1;
                return TrigOutcome::NotTrade(why);
            }
        };
        let d = self.firer.fire(&o, arrived, 0);
        match &d.what {
            FiredWhat::Blocked(code) => *self.hour.blocked.entry(code).or_default() += 1,
            FiredWhat::NotLeft => {
                self.hour.fired += 1;
                self.hour.not_left += 1;
            }
            FiredWhat::GunRefused(why) => {
                self.hour.fired += 1;
                *self.hour.gun_refused.entry(why.clone()).or_default() += 1;
            }
            FiredWhat::Written { seq, hand_us } => {
                self.hour.fired += 1;
                push(&mut self.hour.ready_us, *hand_us);
                if d.res.live {
                    self.hour.live_sent += 1;
                } else {
                    self.hour.would_send += 1;
                    if self.to_practice {
                        super::lane::trigger_inbox_push(o.clone(), *seq, *hand_us);
                    }
                }
            }
        }
        TrigOutcome::Fired(d.what)
    }
}

// ---------------------------------------------------------------------------
// Runtime (the running sidecar)
// ---------------------------------------------------------------------------

struct Rt {
    tx: std::sync::mpsc::SyncSender<(Arc<BinMsg>, Instant)>,
    status: Mutex<Value>,
    last_hour: Mutex<Option<TrigHour>>,
    dropped: std::sync::atomic::AtomicU64,
}

static RT: OnceLock<Rt> = OnceLock::new();
static HOUR_LINE: Mutex<Option<String>> = Mutex::new(None);

/// check/feedstore.rs: new feed messages stored (nothing when off).
pub fn feed_hook(added: &[Arc<BinMsg>]) {
    let Some(rt) = RT.get() else { return };
    let at = Instant::now();
    for m in added {
        if rt.tx.try_send((m.clone(), at)).is_err() {
            rt.dropped.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
}

/// Start the trigger thread (server.rs, once its context exists). Nothing
/// unless the fast lane loop runs (FASTLANE practice / live) and
/// FASTLANE_TRIGGER is not off. Returns true when started.
pub fn start(ctx: Arc<Ctx>) -> bool {
    if RT.get().is_some() || ctx.copy2.is_none() {
        return false;
    }
    let Some(firer) = super::lane::global_firer() else { return false };
    let get = |k: &str| std::env::var(k).ok();
    let mut cfg = TrigCfg::from_lookup(&get);
    if !cfg.on || super::lane::global_mode().is_none_or(|m| m == Mode::Off) {
        return false;
    }
    cfg.l2_offset = ctx.shared.cfg.l2_offset;
    let wallet = firer.gun.address();
    if !cfg.ours.contains(&wallet) {
        cfg.ours.push(wallet);
    }
    let (tx, rx) = std::sync::mpsc::sync_channel::<(Arc<BinMsg>, Instant)>(64);
    if RT.set(Rt { tx, status: Mutex::new(json!({})), last_hour: Mutex::new(None), dropped: Default::default() }).is_err() {
        return false;
    }
    eprintln!(
        "[fastlane] trigger ON: fire-first decided in Rust ({} candidates, {} pools max, confidence >= {}, {} txs / {} ms per message); fires through the fast lane's safety + gun",
        cfg.max_candidates, cfg.max_pools, cfg.min_conf, cfg.max_txs, cfg.budget_us / 1000
    );
    eprintln!("[fastlane] trigger: NOT in Rust (Node keeps them): 3/4/5-pool loops (trigEntryLoops.ts, coin tax test), routes newer than the bot's last table refresh (~1 s), hot-target extra places, the later same-block agreement re-check");
    std::thread::Builder::new()
        .name("arbsim-fl-trigger".into())
        .spawn(move || {
            super::mode::lower_this_thread_from_env("arbsim-fl-trigger");
            let mut t = Trigger::new(cfg, firer);
            let mut hour = Instant::now();
            let mut status_at = Instant::now();
            loop {
                match rx.recv_timeout(Duration::from_millis(500)) {
                    Ok((m, at)) => {
                        // In arrival order; a message that waited too long
                        // behind a slow one is skipped (FASTLANE_TRIG_MAX_LAG_MS).
                        t.on_message(&ctx, &m, at);
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                }
                if status_at.elapsed() >= Duration::from_secs(1) {
                    status_at = Instant::now();
                    if let Some(rt) = RT.get() {
                        t.hour.queue_dropped = rt.dropped.load(std::sync::atomic::Ordering::Relaxed);
                        *rt.status.lock().unwrap_or_else(|e| e.into_inner()) = t.hour.json();
                    }
                }
                if hour.elapsed() >= Duration::from_secs(3600) {
                    hour = Instant::now();
                    let h = std::mem::take(&mut t.hour);
                    *HOUR_LINE.lock().unwrap_or_else(|e| e.into_inner()) = Some(h.line());
                    if let Some(rt) = RT.get() {
                        rt.dropped.store(0, std::sync::atomic::Ordering::Relaxed);
                        *rt.last_hour.lock().unwrap_or_else(|e| e.into_inner()) = Some(h);
                    }
                }
            }
        })
        .is_ok()
}

/// Status "fastlane.trigger" (null when off).
pub fn status_json() -> Value {
    let Some(rt) = RT.get() else { return Value::Null };
    let mut v = rt.status.lock().unwrap_or_else(|e| e.into_inner()).clone();
    v["lastHour"] = rt.last_hour.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|h| h.json()).unwrap_or(Value::Null);
    v
}

/// The last full hour's line (the lane prints it with its own hourly lines).
pub fn take_hour() -> String {
    HOUR_LINE.lock().unwrap_or_else(|e| e.into_inner()).take().unwrap_or_else(|| {
        if RT.get().is_some() {
            "[fastlane trigger] (last hour) not finished yet".into()
        } else {
            "[fastlane trigger] off".into()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_follow_the_bots_names() {
        let m: HashMap<&str, &str> = [
            ("TRIG_ENTRY_MAX_CANDIDATES", "3"), ("TRIG_ENTRY_MAX_POOLS", "5"), ("TRIG_FIRST_MIN_CONFIDENCE", "HIGH"),
            ("TRIG_FIRST_ASSUME", "skip, junk"), ("MIN_EXEC_NET_USD", "0.1"), ("FASTLANE_TRIG_BUDGET_MS", "25"),
            ("ARB_EXECUTOR_ROBINHOOD", "0x00000000000000000000000000000000000000aa"),
        ].into_iter().collect();
        let c = TrigCfg::from_lookup(&|k| m.get(k).map(|v| v.to_string()));
        assert_eq!((c.max_candidates, c.max_pools, c.min_conf.as_str(), c.budget_us), (3, 5, "high", 25_000));
        assert_eq!(c.assume, vec!["skip".to_string()]);
        assert_eq!(c.min_net_usd, 0.1);
        assert_eq!(c.ours, vec![Address::with_last_byte(0xaa)]);
        assert!(c.on);
        let d = TrigCfg::from_lookup(&|k| (k == "TRIG_FIRST_STRICT" || k == "FASTLANE_TRIGGER").then(|| if k == "FASTLANE_TRIGGER" { "off".into() } else { "1".into() }));
        assert!(!d.on);
        assert!(d.strict && d.assume.is_empty(), "strict = no assumptions");
        assert_eq!(d.min_conf, "medium");
    }

    #[test]
    fn quick_skip_is_the_bots() {
        use crate::check::rawtx::DecodedTx;
        use revm::primitives::U256;
        let tx = |to: Option<Address>, data: &[u8], from: Address| DecodedTx { tx_type: 2, hash: Default::default(), from, to, value: U256::ZERO, data: data.to_vec().into(), gas: 1, nonce: 0, chain_id: None, access_list: vec![], auth: vec![] };
        let me = Address::with_last_byte(1);
        let router = Address::with_last_byte(2);
        assert_eq!(quick_skip(&tx(None, &[1, 2, 3, 4], Address::ZERO), &[me]), Some("create"));
        assert_eq!(quick_skip(&tx(Some(me), &[1, 2, 3, 4], Address::ZERO), &[me]), Some("ours"));
        assert_eq!(quick_skip(&tx(Some(router), &[1, 2, 3, 4], me), &[me]), Some("ours"), "sent by our wallet");
        assert_eq!(quick_skip(&tx(Some(router), &[1, 2], Address::ZERO), &[me]), Some("plain_transfer"));
        assert_eq!(quick_skip(&tx(Some(router), &[0x09, 0x5e, 0xa7, 0xb3, 0], Address::ZERO), &[me]), Some("coin_call"));
        assert_eq!(quick_skip(&tx(Some(router), &[0x38, 0xed, 0x17, 0x39], Address::ZERO), &[me]), None, "a swap is looked at");
    }
}
