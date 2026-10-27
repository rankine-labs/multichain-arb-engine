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
//       measured first),
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
//   OFFLINE DIFFERENCES (said out loud; all make it MORE cautious, never
//   less): copy 2's V4 PoolManager double runs and "reports pending" rule
//   are not available (a check that needs them answers unknown), feed
//   transactions are never skipped as unrelated (no route lookup), and the
//   safety gates are not applied (a "would reach the gun" count). Nothing is
//   signed or sent. Times are this machine's, not the server's.
//
//   `--json` prints the whole result; `--ours <addr,addr>` lists our
//   contract / wallet (skipped like live); `--table <file>` a table message
//   (default <capture>.table.json); `--partial` replays a cut-off capture.
// ============================================================================
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use revm::primitives::{Address, B256};
use serde_json::{json, Value};

use super::scan::{evaluate, CheckRunner, PreparedCheck};
use super::trigger::{opportunity, quick_skip, TrigCfg};
use super::types::Opportunity;
use crate::arb::BlockCtx;
use crate::check::entry::{call_for, good_enough, select, Table};
use crate::check::feedstore::BinMsg;
use crate::check::moved::{FollowedPool, MovedIndex};
use crate::check::ordered::{build_plan_with, run_ordered_with, trigger_only, Assume, Provenance, WireFeed};
use crate::copy2::ahead_capture::{CapEv, CapFile, ProvSets};
use crate::server::CheckedRow;
use crate::state::snap::{Snapshot, View};

/// Settings of one replay.
#[derive(Clone, Debug, Default)]
pub struct TrigReplayOpts {
    pub ours: Vec<Address>,
    pub samples: usize,
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
    let mut prov: Arc<dyn Provenance + Send + Sync> = Arc::new(ProvSets::all_exact());
    let mut index = MovedIndex::build(&[]);
    let mut pools_n = 0usize;
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
    let mut trig_us: Vec<u64> = Vec::new();
    let mut fires: Vec<Value> = Vec::new();
    let assume = Assume { sender_funds: cfg.assume.iter().any(|a| a == "sender_funds") && !cfg.strict, recent_fill: cfg.assume.iter().any(|a| a == "recent_fill") && !cfg.strict, skip: None, record_hashes: true, proven_skip: false };
    for ev in &cap.events[1..] {
        match ev {
            CapEv::Pools { list, .. } => {
                let fps: Vec<FollowedPool> = list.iter().map(|(p, _, _)| p.clone()).collect();
                pools_n = fps.len();
                index = MovedIndex::build(&fps);
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
            }
            CapEv::Feed(m) => {
                msgs += 1;
                held.insert(m.seq, m.clone());
                while held.len() > 256 {
                    let k = *held.keys().next().expect("non-empty");
                    held.remove(&k);
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
                    let skip = match t.decoded() {
                        Ok(d) => quick_skip(&d, &ours),
                        Err(_) => Some("unreadable"),
                    };
                    if let Some(why) = skip {
                        bump(&mut skipped, why);
                        continue;
                    }
                    if !seen.insert(t.hash) {
                        repeats += 1;
                        continue;
                    }
                    asked += 1;
                    let t0 = Instant::now();
                    // The messages a bot question would name, from those held NOW.
                    let newest = *held.keys().next_back().expect("just inserted");
                    let mut from = m.seq.min(cseq).saturating_sub(cfg.back_msgs);
                    from = from.max(newest.saturating_sub(cfg.max_msgs.saturating_sub(1)));
                    let list: Vec<Arc<BinMsg>> = held.range(from..=newest).map(|(_, x)| x.clone()).collect();
                    let refs: Vec<(u64, usize)> = list.iter().map(|x| (x.seq, x.txs.len())).collect();
                    let feed = WireFeed { trigger: format!("{:#x}", t.hash), trigger_seq: m.seq, msgs: vec![], route: vec![], strict: cfg.strict, assume: Some(cfg.assume.clone()), refs: Some(refs) };
                    let (plan, info) = match build_plan_with(&feed, Some(&list), cseq, l2_offset, &cctx) {
                        Ok(x) => x,
                        Err(u) => {
                            bump(&mut disc_unknown, u.reason.as_str().to_string());
                            continue;
                        }
                    };
                    let Some((alone, _others)) = trigger_only(&plan) else {
                        in_copy += 1;
                        continue;
                    };
                    let out = match run_ordered_with(&view, &alone, &crate::check::Overrides::none(), &[], prov.as_ref(), true, &assume) {
                        Ok(o) => o,
                        Err(u) => {
                            bump(&mut disc_unknown, u.reason.as_str().to_string());
                            trig_us.push(t0.elapsed().as_micros() as u64);
                            continue;
                        }
                    };
                    let pools: Vec<String> = index.moved(&out.changed, &out.hashes).into_iter().map(|p| p.key.to_ascii_lowercase()).collect();
                    if pools.is_empty() {
                        no_pools += 1;
                        trig_us.push(t0.elapsed().as_micros() as u64);
                        continue;
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
                        let a = crate::check::proto_types::handle_trig_call_with(&view, &plan, &info, &req, prov.as_ref(), true, &assume);
                        if a.get("ok") == Some(&Value::Bool(true)) {
                            sure += 1;
                        } else {
                            bump(&mut answer_unknown, a.get("unknown").and_then(|u| u.as_str()).unwrap_or("error").to_string());
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
    let lag_over = |n: u64| lag_blocks.iter().filter(|x| **x > n).count() as u64;
    let lag_hist = json!({"0 (copy already had it)": lag_ahead, "1": lag_blocks.iter().filter(|x| **x == 1).count(), "2": lag_blocks.iter().filter(|x| **x == 2).count(), "3": lag_blocks.iter().filter(|x| **x == 3).count(), "more than 3": lag_over(3)});
    Ok(json!({
        "capture": {"complete": cap.complete, "cut": cap.cut, "events": cap.events.len(), "pools": pools_n, "routePools": route_pools, "l2Offset": l2_offset, "table": table.map(|t| json!({"pools": t.pools.len(), "rows": t.pools.values().map(|r| r.len()).sum::<usize>()}))},
        "copyLag": {"blocksBehindAtArrival": pct(&mut lag_blocks.clone()), "histogram": lag_hist, "note": "how far copy 2's newest confirmed version was behind each feed message when it arrived (blocks)"},
        "coverage": {"msgs": msgs, "msgsBeforeAnyCopy": msgs_no_copy, "txs": txs, "skipped": skipped, "repeats": repeats, "asked": asked,
            "discovery": {"movedOurPools": moved, "noPools": no_pools, "tooManyPools": too_many, "alreadyInCopy": in_copy, "unknown": disc_unknown}},
        "candidates": {"noCandidates": no_cands, "routesChecked": routes_checked, "sure": sure, "unknown": answer_unknown, "good": good, "notTrade": not_trade, "wouldReachGun": would_fire,
            "recheckAtBlockEnd": {"stillProfitable": real, "gone": gone, "unknown": recheck_unknown, "neverConfirmedInCapture": waiting.len()}},
        "timeUsThisMachine": {"perTrigger": pct(&mut trig_us.clone())},
        "wouldFireSamples": fires,
        "offlineNote": "no copy-2 double runs / reports-pending rule, no unrelated-tx skipping, no safety gates: more cautious than live; nothing signed or sent",
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

/// Plain-English report.
pub fn print_report(r: &Value) -> String {
    let mut o = String::new();
    let c = &r["capture"];
    o += &format!("FIRE-FIRST REPLAY (offline, no future information): {} events, {} pools followed, table {}\n", c["events"], c["pools"], if c["table"].is_null() { "NONE (discovery only; capture with FASTLANE_CAPTURE_FILE writes <file>.table.json)".to_string() } else { c["table"].to_string() });
    o += &format!("ROUTE POOLS arbsim held (newest seen in the capture): {} (null = no candidate table had arrived: the zero-routes symptom)\n", c["routePools"]);
    o += &format!("COPY LAG at each feed message (blocks behind): {}  histogram {}\n", r["copyLag"]["blocksBehindAtArrival"], r["copyLag"]["histogram"]);
    let v = &r["coverage"];
    o += &format!("COVERAGE: feed msgs {} (before any copy {}), txs {}, skipped {}, repeats {}, asked {}\n", v["msgs"], v["msgsBeforeAnyCopy"], v["txs"], v["skipped"], v["repeats"], v["asked"]);
    let d = &v["discovery"];
    o += &format!("DISCOVERY: moved our pools {}, moved none {}, too many pools {}, already in copy {}, unknown {}\n", d["movedOurPools"], d["noPools"], d["tooManyPools"], d["alreadyInCopy"], d["unknown"]);
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
    o += &format!("NOTE: {}\n", r["offlineNote"].as_str().unwrap_or(""));
    o
}

/// `arbsim trig-replay <capture file> [--table <file>] [--ours a,b] [--json] [--samples N] [--partial]`
pub fn replay_main(args: &[String]) {
    let Some(path) = args.get(2).filter(|a| !a.starts_with("--")) else {
        eprintln!("usage: arbsim trig-replay <capture file> [--table <file>] [--ours 0x..,0x..] [--json] [--samples N] [--partial]");
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
    let opts = TrigReplayOpts { ours, samples: val("--samples").and_then(|s| s.parse().ok()).unwrap_or(10) };
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
