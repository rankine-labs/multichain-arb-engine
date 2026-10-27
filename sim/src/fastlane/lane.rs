// ============================================================================
// FAST LANE LOOP (integration): predicted copy -> scanner -> safety -> gun.
//
// Plain English:
//   One thread ("arbsim-fastlane"), only when FASTLANE is practice or live.
//   It sleeps until the predicted copy (copy2/ahead.rs) has a NEW tip, i.e.
//   the state after the feed message that just arrived (no busy polling:
//   ahead::wait_tip). For each new tip:
//     1. SCAN  the routes through the pools that message changed (plus the
//              rolling sweep), on the predicted state, with copy 2's own
//              check rules (fastlane/c2runner.rs). Routes on "unsure" pools
//              are skipped.
//     2. For the best opportunity (FASTLANE_FIRES_PER_BLOCK, default 1),
//        under ONE lock (review M5: no two fires can both squeeze under a
//        limit only one of them fits):
//          SAFETY  every Node safety gate (fastlane/safety.rs)
//          FIRE    calldata -> sign -> send (live) / "would send" (practice)
//                  (fastlane/gun). Whether this is a REAL send is decided by
//                  ONE answer: Gun::broadcasting() (review H3).
//          LOG     one line in data/fastlane-sends.jsonl with its seq
//                  (Node follows it: live -> tracked like its own send)
//          RECORD  Safety::record_send (rate limit, pool hold, gas held)
//     3. PRACTICE scoring (fastlane/practice.rs): every would-send is
//        remembered and labelled once copy 2 confirms the block.
//   CPU (final review H-1): this thread runs at a lower OS priority
//   (FASTLANE_NICE, default 10), the scan has a 5 ms budget per block
//   (FASTLANE_SCAN_BUDGET_MS) and practice re-checks a 3 ms budget per call
//   (FASTLANE_PRACTICE_BUDGET_MS).
//   Between tips it also:
//     - reads Node's feedback from the state file (review H4): dropsSeen
//       changed -> the gun's nonce is re-read; maxGasUsed -> gas limit tuning,
//     - brings the scanner's route list up to date (so a block's scan
//       rarely pays for it),
//     - writes the hourly lines.
//   The sequencer's reply to a live send arrives later on a sender thread:
//   it is written to the send log as a "reply" line (Node then releases a
//   refused send at once) and a refused / never-sent route may be handed
//   out again (review M4).
//
//   Live sends need ALL of: FASTLANE=live, RUST_SENDER=on on BOTH sides,
//   EXECUTION_ENABLED=true, LIVE_SEND_CONFIRM=yes-real-money, the wallet key
//   (BOT_PRIVATE_KEY, NOT passed to arbsim by deploy/arbsim-run.sh: owner
//   decision pending), ARB_EXECUTOR_ROBINHOOD, no kill switch, fresh Node
//   state. Anything missing = practice, and the start-up line says why.
// ============================================================================
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::bridge::{wall_ms, SendRecord, SendsLog};
use super::convert::{to_call_input, to_safety_input};
use super::gun::send::{SendOutcome, SendStatus};
use super::gun::{CallInput, FireRecord, Gate, Gun};
use super::mode::{FastlaneMode, Mode};
use super::practice::{Practice, PracticeCfg};
use super::safety::Safety;
use super::scan::{BlockInput, ScanConfig, Scanner};
use super::types::{Opportunity, ViewKind};
use crate::copy2::ahead::AheadTip;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// Loop settings (env names, defaults in brackets).
#[derive(Clone, Debug)]
pub struct LaneCfg {
    /// FASTLANE_FIRES_PER_BLOCK [1]: best opportunities fired per block
    /// (1..4). One is the safe choice: the next ones would wait for the
    /// first one's nonce anyway.
    pub fires_per_block: usize,
    /// FASTLANE_TIP_MAX_AGE_MS [60]: a tip older than this when the loop
    /// gets to it is skipped (it is about a block the chain already left).
    pub tip_max_age_ms: u64,
}

impl Default for LaneCfg {
    fn default() -> Self {
        LaneCfg { fires_per_block: 1, tip_max_age_ms: 60 }
    }
}

impl LaneCfg {
    pub fn from_lookup(get: &dyn Fn(&str) -> Option<String>) -> LaneCfg {
        let d = LaneCfg::default();
        let num = |k: &str| get(k).and_then(|v| v.trim().parse::<u64>().ok());
        LaneCfg {
            fires_per_block: num("FASTLANE_FIRES_PER_BLOCK").filter(|v| (1..=4).contains(v)).map(|v| v as usize).unwrap_or(d.fires_per_block),
            tip_max_age_ms: num("FASTLANE_TIP_MAX_AGE_MS").filter(|v| (1..=10_000).contains(v)).unwrap_or(d.tip_max_age_ms),
        }
    }
}

// ---------------------------------------------------------------------------
// Safety as the gun's gate
// ---------------------------------------------------------------------------

/// The gun's safety gate, backed by D's Safety (review H2/H3: a REAL gate).
///
/// Safety::check needs exclusive access, and the lane runs it under the
/// fire lock right before Gun::fire. So the gate itself does not re-run the
/// checks: `allow` only lets through the ONE trade the lane has just cleared
/// (same block, size, route), so nothing can be fired around the checks.
/// `may_broadcast_now` is Safety::may_broadcast: FASTLANE=live and our
/// RUST_SENDER=on and no kill switch (the file is looked at on every call)
/// and Node's fresh state says Node's RUST_SENDER is on too (that last part
/// is refreshed under the fire lock right before every fire).
pub struct SafetyGate {
    mode: FastlaneMode,
    kill: super::bridge::KillSwitch,
    node_agrees: AtomicBool,
    cleared: Mutex<Option<(u64, String, revm::primitives::U256)>>,
}

impl SafetyGate {
    pub fn new(s: &Safety) -> SafetyGate {
        SafetyGate { mode: s.mode, kill: s.kill.clone(), node_agrees: AtomicBool::new(s.node_agrees_rust_sends()), cleared: Mutex::new(None) }
    }
    /// Refresh "Node agrees Rust sends" from the Safety (fire lock held).
    pub fn sync_from(&self, s: &Safety) {
        self.node_agrees.store(s.node_agrees_rust_sends(), Ordering::SeqCst);
    }
    fn clear_for(&self, c: &CallInput) {
        *self.cleared.lock().unwrap_or_else(|e| e.into_inner()) = Some((c.block, c.route_label.clone(), c.amount_in));
    }
    fn reset(&self) {
        *self.cleared.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

impl Gate for SafetyGate {
    fn allow(&self, c: &CallInput) -> Result<(), String> {
        let g = self.cleared.lock().unwrap_or_else(|e| e.into_inner());
        match &*g {
            Some((b, l, a)) if *b == c.block && *l == c.route_label && *a == c.amount_in => {
                // A kill switch turned on since the check: stop here too.
                if self.kill.on() {
                    return Err("kill switch on".into());
                }
                Ok(())
            }
            _ => Err("not cleared by the safety checks".into()),
        }
    }
    fn is_real(&self) -> bool {
        true
    }
    fn may_broadcast_now(&self) -> bool {
        self.mode.may_broadcast(self.kill.on()) && self.node_agrees.load(Ordering::SeqCst)
    }
}

// ---------------------------------------------------------------------------
// Reply book: hash -> (seq, route id) for the reply hook (bounded)
// ---------------------------------------------------------------------------

#[derive(Default)]
struct BookInner {
    /// hash -> (seq, route id) of live sends written to the log.
    by_hash: HashMap<String, (u64, String)>,
    order: VecDeque<String>,
    /// Replies that arrived BEFORE their send record was written (a fast
    /// endpoint answers while the lane is still writing): held here and
    /// written right after the send record, so the log is always in order.
    early: HashMap<String, SendOutcome>,
    /// Early replies that did not fit (more than 64 waiting): counted, not
    /// silently lost (final review, low). Node then simply waits for the
    /// receipt of that send (as if no reply had come).
    early_dropped: u64,
}

#[derive(Default)]
pub struct ReplyBook {
    inner: Mutex<BookInner>,
    /// Routes to hand out again (sent trade never left / refused): M4.
    forget: Mutex<Vec<String>>,
    pub replies: Mutex<BTreeMap<&'static str, u64>>,
}

impl ReplyBook {
    /// The send record of `hash` is written (seq): returns its reply if it
    /// already came (to be written now).
    fn note(&self, hash: &str, seq: u64, rid: &str) -> Option<SendOutcome> {
        let h = hash.to_ascii_lowercase();
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(o) = g.early.remove(&h) {
            return Some(o);
        }
        g.by_hash.insert(h.clone(), (seq, rid.to_string()));
        g.order.push_back(h);
        while g.order.len() > 512 {
            if let Some(x) = g.order.pop_front() {
                g.by_hash.remove(&x);
            }
        }
        None
    }
    /// A reply: its send's (seq, route), or None = its record is not written
    /// yet (the reply is kept for `note`).
    fn take_or_hold(&self, o: &SendOutcome) -> Option<(u64, String)> {
        let h = o.hash.to_ascii_lowercase();
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(x) = g.by_hash.remove(&h) {
            return Some(x);
        }
        if g.early.len() < 64 {
            g.early.insert(h, o.clone());
        } else {
            g.early_dropped += 1;
        }
        None
    }
    /// Early replies dropped because too many were waiting (status).
    pub fn early_dropped(&self) -> u64 {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).early_dropped
    }
    fn forget_later(&self, rid: String) {
        let mut f = self.forget.lock().unwrap_or_else(|e| e.into_inner());
        if f.len() < 256 {
            f.push(rid);
        }
    }
    fn drain_forget(&self) -> Vec<String> {
        std::mem::take(&mut *self.forget.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

/// Write one "reply" line for send `seq` (route `rid`).
fn write_reply(log: &SendsLog, book: &ReplyBook, o: &SendOutcome, seq: u64, rid: String) {
    *book.replies.lock().unwrap_or_else(|e| e.into_inner()).entry(o.status.as_str()).or_default() += 1;
    if matches!(o.status, SendStatus::Refused | SendStatus::StaleInQueue | SendStatus::NotWritten) && !rid.is_empty() {
        book.forget_later(rid.clone());
    }
    let mut t = BTreeMap::new();
    t.insert("reply".to_string(), o.reply_us);
    t.insert("sequencer".to_string(), o.wait_us);
    // Blocker 4: mode "reply" (never "live"): an older Node follower can't
    // read it as a failed live send. seq 0 = handed out under the log's
    // write lock (blocker 1), so it lands after its send in seq order.
    let rec = SendRecord {
        seq: 0,
        t: wall_ms(),
        mode: "reply".into(),
        kind: Some("reply".into()),
        reply_to: Some(seq),
        reply_hash: Some(o.hash.clone()),
        status: Some(o.status.as_str().into()),
        error: o.result.as_ref().err().map(|e| e.chars().take(200).collect()),
        label: rid,
        timings_us: t,
        ..Default::default()
    };
    let _ = log.append(&rec);
}

/// The reply hook the gun calls on its sender thread (live only): one
/// "reply" line in the send log, always AFTER its send record (Node: a
/// refused send is released at once, not left waiting for a receipt), and
/// a route whose trade never got in may be handed out again.
pub fn reply_hook(log: Arc<SendsLog>, book: Arc<ReplyBook>) -> Arc<dyn Fn(&SendOutcome) + Send + Sync> {
    Arc::new(move |o: &SendOutcome| {
        if let Some((seq, rid)) = book.take_or_hold(o) {
            write_reply(&log, &book, o, seq, rid);
        }
    })
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct LaneHour {
    pub tips: u64,
    pub tips_old: u64,
    pub opps: u64,
    /// Safety refusals by code.
    pub blocked: BTreeMap<&'static str, u64>,
    pub fired: u64,
    pub would_send: u64,
    pub live_sent: u64,
    /// The gun refused before signing / sending (why -> count).
    pub gun_refused: BTreeMap<String, u64>,
    /// Signed, never left (stale in queue / not written).
    pub not_left: u64,
    pub log_errors: u64,
    /// Feed message -> would hand to socket (us), newest 5,000.
    pub latency_us: Vec<u64>,
    /// Per block: ahead apply + scan + fire (us), newest 5,000.
    pub block_us: Vec<u64>,
    /// Practice fixes (Oct 27): per block, the LANE's own time only (scan +
    /// fire, no ahead apply), newest 5,000. Live, "blockUs" looked like a
    /// 5-17 ms lane cost; it was the predicted copy's apply time added in.
    pub lane_us: Vec<u64>,
    pub drops_seen: u64,
    pub gas_notes: u64,
}

fn push_bounded(v: &mut Vec<u64>, x: u64) {
    if v.len() >= 5_000 {
        v.remove(0);
    }
    v.push(x);
}

fn pctl(v: &[u64]) -> Value {
    let mut s = v.to_vec();
    crate::timing::pct_of(&mut s)
}

/// What one fire did (tests and logs).
#[derive(Clone, Debug)]
pub struct FireResult {
    pub blocked: Option<&'static str>,
    pub record: Option<FireRecord>,
    pub written: Option<SendRecord>,
    pub live: bool,
}

// ---------------------------------------------------------------------------
// The lane
// ---------------------------------------------------------------------------

/// Everything the fire lock covers (review M5).
pub struct FireCore {
    pub safety: Safety,
}

pub struct Lane {
    pub cfg: LaneCfg,
    pub scanner: Scanner,
    pub core: Mutex<FireCore>,
    pub gate: Arc<SafetyGate>,
    pub gun: Arc<Gun>,
    pub log: Arc<SendsLog>,
    pub book: Arc<ReplyBook>,
    pub practice: Practice,
    pub hour: LaneHour,
    pub last_hour: Option<LaneHour>,
    last_drops: Option<u64>,
    last_gas: u64,
    pub started: Instant,
}

impl Lane {
    /// Assemble from parts (tests and `start`).
    #[allow(clippy::too_many_arguments)]
    pub fn new(cfg: LaneCfg, scanner: Scanner, safety: Safety, gate: Arc<SafetyGate>, gun: Arc<Gun>, log: Arc<SendsLog>, book: Arc<ReplyBook>, practice: Practice) -> Lane {
        Lane {
            cfg,
            scanner,
            core: Mutex::new(FireCore { safety }),
            gate,
            gun,
            log,
            book,
            practice,
            hour: LaneHour::default(),
            last_hour: None,
            last_drops: None,
            last_gas: 0,
            started: Instant::now(),
        }
    }

    /// One new predicted tip: scan, then fire the best (see file header).
    pub fn on_tip(&mut self, tip: &AheadTip) -> Vec<FireResult> {
        let t0 = Instant::now();
        self.hour.tips += 1;
        if tip.built_at.elapsed() > Duration::from_millis(self.cfg.tip_max_age_ms) {
            self.hour.tips_old += 1;
            return Vec::new();
        }
        let view = tip.view();
        // The tip's own set (built once by the predicted copy, not per tip here).
        let input = BlockInput { view: &view, ctx: &tip.ctx, block: tip.block, kind: ViewKind::Predicted, changed: &tip.changed_pools, unsure: &tip.unsure_set, snap: Some(&tip.snap) };
        let rep = self.scanner.scan(&input);
        self.hour.opps += rep.opps.len() as u64;
        let mut out = Vec::new();
        for o in rep.opps.iter().take(self.cfg.fires_per_block) {
            out.push(self.fire_one(o, tip.feed_at, tip.apply_us));
        }
        let lane_us = t0.elapsed().as_micros() as u64;
        push_bounded(&mut self.hour.block_us, tip.apply_us + lane_us);
        push_bounded(&mut self.hour.lane_us, lane_us);
        out
    }

    /// Safety -> fire -> log -> record, under ONE lock (review M5).
    pub fn fire_one(&mut self, o: &Opportunity, feed_at: Instant, apply_us: u64) -> FireResult {
        let mut res = FireResult { blocked: None, record: None, written: None, live: false };
        let inp = match to_safety_input(o) {
            Ok(x) => x,
            Err(_) => {
                *self.hour.blocked.entry("bad_size").or_default() += 1;
                res.blocked = Some("bad_size");
                return res;
            }
        };
        let call = to_call_input(o);
        let mut core = self.core.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        // Blocker 3: always look at the state file right before a fire (one
        // stat; re-read only if it changed), so Node's startup guard
        // ("rustSender": false) stops the very next fire, not up to 200 ms later.
        core.safety.state.refresh(now, true);
        self.gate.sync_from(&core.safety);
        if let Err(r) = core.safety.check(&inp, now) {
            *self.hour.blocked.entry(r.code).or_default() += 1;
            res.blocked = Some(r.code);
            return res;
        }
        // H3: THE answer to "is this a real send" (checked again by fire()
        // right before the bytes go out; a flip then is a refusal, never a
        // silent practice send).
        let live = self.gun.broadcasting();
        res.live = live;
        self.gate.clear_for(&call);
        let fire_at = Instant::now();
        let rec = self.gun.fire(&call);
        self.gate.reset();
        self.hour.fired += 1;
        // Feed message -> handed to the socket (live) / would hand (practice:
        // the signed bytes are ready right at the end of fire()).
        let to_fire = fire_at.saturating_duration_since(feed_at).as_micros() as u64;
        let hand_us = to_fire + rec.handed_us.unwrap_or_else(|| fire_at.elapsed().as_micros() as u64);
        let on_chain_maybe = rec.send_status.is_some_and(|s| s.maybe_on_chain());
        let write = if live { on_chain_maybe && rec.hash.is_some() } else { rec.signed };
        if !write {
            if rec.signed && live {
                // Signed but never left us (stale in the queue / not written):
                // nothing to track; the route may be handed out again (M4).
                self.hour.not_left += 1;
                self.scanner.forget(&o.rid);
            } else {
                *self.hour.gun_refused.entry(rec.why.clone().unwrap_or_else(|| "?".into()).chars().take(60).collect()).or_default() += 1;
                self.scanner.forget(&o.rid);
            }
            res.record = Some(rec);
            return res;
        }
        let mut t = BTreeMap::new();
        t.insert("apply".to_string(), apply_us);
        t.insert("scan".to_string(), o.scan_us);
        t.insert("feedToFire".to_string(), to_fire);
        t.insert("calldata".to_string(), rec.calldata_us);
        t.insert("gate".to_string(), rec.gate_us);
        t.insert("sign".to_string(), rec.sign_us);
        if let Some(h) = rec.handed_us {
            t.insert("handed".to_string(), h);
        }
        let lender_fee_pips = match (o.flash.lender(), o.loan_fee_usd) {
            (Some(_), Some(fee)) if o.size_usd > 0.0 => Some((fee / o.size_usd * 1_000_000.0).round() as u32),
            _ => None,
        };
        let mut sr = SendRecord {
            seq: 0,
            t: wall_ms(),
            mode: if live { "live".into() } else { "practice".into() },
            hash: rec.hash.clone(),
            error: None,
            label: o.route_label.clone(),
            block: o.block,
            token_in: format!("{:#x}", o.token_in),
            amount_in: o.amount_in.to_string(),
            size_usd: o.size_usd,
            expected_net_usd: o.expected_net_usd,
            gas_usd: o.gas_usd,
            lender: o.flash.lender().map(|a| format!("{a:#x}")),
            lender_fee_pips,
            pools: o.pools.clone(),
            kinds: o.hops.iter().map(|h| h.kind).collect(),
            nonce: rec.nonce,
            timings_us: t,
            total_us: hand_us,
            status: rec.send_status.map(|s| s.as_str().to_string()),
            ..Default::default()
        };
        // Blocker 1: the seq is handed out under the log's write lock, so a
        // reply line written by the sender thread at the same moment can
        // never land before this record with a lower seq.
        let (seq, wrote) = self.log.append_new(&sr);
        sr.seq = seq;
        if wrote.is_err() {
            // Trading goes on (bridge.rs); the seq stays used, Safety keeps
            // holding the gas until Node's ack passes it.
            self.hour.log_errors += 1;
        }
        core.safety.record_send(&inp, now, seq);
        drop(core);
        if live {
            self.hour.live_sent += 1;
            if let Some(h) = &rec.hash {
                if let Some(early) = self.book.note(h, seq, &o.rid) {
                    write_reply(&self.log, &self.book, &early, seq, o.rid.clone());
                }
            }
        } else {
            self.hour.would_send += 1;
            self.practice.note_would_send(o, seq, hand_us);
        }
        push_bounded(&mut self.hour.latency_us, hand_us);
        res.record = Some(rec);
        res.written = Some(sr);
        res
    }

    /// Between tips: Node's feedback (H4), routes to hand out again (M4),
    /// and the route list sync (H2).
    pub fn tick(&mut self) {
        for rid in self.book.drain_forget() {
            self.scanner.forget(&rid);
        }
        let (drops, gas) = {
            let mut core = self.core.lock().unwrap_or_else(|e| e.into_inner());
            core.safety.state.refresh(Instant::now(), false);
            self.gate.sync_from(&core.safety);
            let now_ms = (core.safety.wall)();
            match core.safety.state.usable(now_ms) {
                Ok(s) => (Some(s.raw.drops_seen), s.raw.max_gas_used),
                Err(_) => (None, 0),
            }
        };
        self.apply_feedback(drops, gas);
        self.scanner.sync_now();
    }

    /// H4: dropsSeen CHANGED (any change: it starts over when Node restarts)
    /// -> a tracked Rust send was never mined: re-read the nonce. maxGasUsed
    /// went up -> the gas limit is tuned from it.
    pub fn apply_feedback(&mut self, drops: Option<u64>, max_gas: u64) {
        if let Some(d) = drops {
            if self.last_drops.is_some_and(|x| x != d) {
                self.gun.trade_dropped();
                self.hour.drops_seen += 1;
            }
            self.last_drops = Some(d);
        }
        if max_gas > self.last_gas {
            self.last_gas = max_gas;
            self.gun.gas().note_gas_used(max_gas);
            self.hour.gas_notes += 1;
        }
    }

    /// Practice scoring against copy 2's confirmed versions (see practice.rs).
    pub fn score_confirmed(&mut self, c2: &crate::copy2::intake::Copy2Handle) {
        let runner = super::c2runner::Copy2Runner::new(c2.clone());
        self.practice.on_confirmed(c2, &runner);
    }

    /// Status section "fastlane" (summary of every part).
    pub fn status_json(&self) -> Value {
        let h = &self.hour;
        let core = self.core.lock().unwrap_or_else(|e| e.into_inner());
        let state = match core.safety.state.usable((core.safety.wall)()) {
            Ok(s) => json!({"usable": true, "rustSender": s.raw.rust_sender, "ackSeq": s.raw.ack_seq, "dropsSeen": s.raw.drops_seen, "maxGasUsed": s.raw.max_gas_used}),
            Err(p) => json!({"usable": false, "why": p.to_string()}),
        };
        let killed = core.safety.killed();
        drop(core);
        json!({
            "mode": self.gun.mode().as_str(),
            "upS": self.started.elapsed().as_secs(),
            "ahead": crate::copy2::ahead::status_json().map(|a| {
                let p = crate::copy2::ahead::prediction_counts().unwrap_or_default();
                json!({"tip": a.get("tip"), "stopped": a.get("stopped"), "agreementPct": p.agreement_pct(), "unsurePct": p.unsure_pct(), "unpredictedPct": p.unpredicted_pct(), "stoppedPct": p.stopped_pct(), "overBudget": p.over_budget,
                    // Practice fixes: the counts behind the %s (agreementPct is per POOL
                    // compared, agree / (agree + disagree); null = nothing compared).
                    "agree": p.agree, "disagree": p.disagree, "unsure": p.unsure, "compared": p.compared, "unpredicted": p.unpredicted})
            }),
            "copy2Runs": super::c2runner::stats_json(),
            "scan": {"routes": self.scanner.routes(), "hour": super::scan::status_json()},
            "gun": {
                "broadcasting": self.gun.broadcasting(),
                "whyNot": self.gun.why_not_broadcasting(),
                "liveBlocked": live_block_reason(),
                "fires": self.gun.fires.load(Ordering::Relaxed),
                "nonceInFlight": self.gun.nonce().in_flight(),
                "replies": *self.book.replies.lock().unwrap_or_else(|e| e.into_inner()),
                "earlyRepliesDropped": self.book.early_dropped(),
            },
            "safety": {"killed": killed, "state": state, "blockedThisHour": h.blocked},
            "lane": {
                "tips": h.tips, "tipsOld": h.tips_old, "opps": h.opps, "fired": h.fired, "wouldSend": h.would_send, "liveSent": h.live_sent,
                "notLeft": h.not_left, "gunRefused": h.gun_refused, "logErrors": h.log_errors, "dropsSeen": h.drops_seen,
                "feedToHandUs": pctl(&h.latency_us), "blockUs": pctl(&h.block_us), "laneUs": pctl(&h.lane_us),
                "blockUsNote": "blockUs = predicted-copy apply + lane; laneUs = lane only (scan + fire)",
            },
            "practice": self.practice.status_json(),
        })
    }

    /// The hourly lines (then a new hour starts). Returns the lines printed.
    pub fn take_hour(&mut self) -> Vec<String> {
        let h = std::mem::take(&mut self.hour);
        let l = |v: &[u64], p: &str| pctl(v).get(p).and_then(|x| x.as_u64()).unwrap_or(0);
        let mut blocked: Vec<String> = h.blocked.iter().map(|(k, v)| format!("{k}:{v}")).collect();
        blocked.sort();
        let lane = format!(
            "[arbsim] fastlane (last hour): mode {} ({}) | tips {} (too old {}) | opportunities {} | safety blocked [{}] | fired {}: would send {}, live sent {}, never left {}, gun refused {} | feed -> hand us p50 {} p90 {} | per block us (apply + lane) p50 {} p90 {} max {}, lane only p50 {} p90 {} | drops seen {} gas notes {}",
            self.gun.mode().as_str(),
            self.gun.why_not_broadcasting().unwrap_or("broadcasting"),
            h.tips, h.tips_old, h.opps, blocked.join(" "), h.fired, h.would_send, h.live_sent, h.not_left,
            h.gun_refused.values().sum::<u64>(),
            l(&h.latency_us, "p50"), l(&h.latency_us, "p90"), l(&h.block_us, "p50"), l(&h.block_us, "p90"), l(&h.block_us, "max"), l(&h.lane_us, "p50"), l(&h.lane_us, "p90"),
            h.drops_seen, h.gas_notes,
        );
        self.last_hour = Some(h);
        let practice = self.practice.take_hour(crate::copy2::ahead::prediction_counts());
        vec![lane, super::scan::take_hour(), practice]
    }
}

/// Prediction agreement % so far this hour (copy2/ahead.rs), None = no data / off.
pub fn agreement_pct() -> Option<f64> {
    let (a, d) = crate::copy2::ahead::agreement_counts()?;
    (a + d > 0).then(|| 100.0 * a as f64 / (a + d) as f64)
}

/// Why live sending can't happen because of the KEY (owner decision): the
/// deploy script never passes BOT_PRIVATE_KEY to arbsim.
pub fn live_block_reason() -> Option<&'static str> {
    if std::env::var("BOT_PRIVATE_KEY").map_or(true, |k| k.trim().is_empty()) {
        Some("live blocked: no key passed to arbsim (owner decision pending)")
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// Runtime (the running sidecar)
// ---------------------------------------------------------------------------

struct Rt {
    status: Mutex<Value>,
    last_practice: Mutex<Value>,
}

static RT: std::sync::OnceLock<Rt> = std::sync::OnceLock::new();
static TIPS_SEEN: AtomicU64 = AtomicU64::new(0);

/// Start the fast lane loop (copy 2 mode). Nothing when FASTLANE=off or the
/// predicted copy is not running. Returns true when started.
pub fn start(c2: crate::copy2::intake::Copy2Handle) -> bool {
    let fm = FastlaneMode::from_env();
    if fm.mode == Mode::Off || RT.get().is_some() {
        return false;
    }
    let get = |k: &str| std::env::var(k).ok();
    let safety = Safety::from_env();
    let gate = Arc::new(SafetyGate::new(&safety));
    let log = Arc::new(SendsLog::from_lookup(&get));
    let book = Arc::new(ReplyBook::default());
    if let Some(why) = live_block_reason() {
        if fm.mode == Mode::Live {
            eprintln!("[fastlane] {why}: running as practice");
        }
    }
    let gun = match Gun::from_env(gate.clone(), reply_hook(log.clone(), book.clone())) {
        Ok(Some(g)) => Arc::new(g),
        Ok(None) => return false,
        Err(e) => {
            eprintln!("[fastlane] gun could not start ({e}): fast lane OFF");
            return false;
        }
    };
    let scanner = Scanner::new(ScanConfig::from_env(), Box::new(super::scan::TableSource::global()), Box::new(super::c2runner::Copy2Runner::new(c2.clone())));
    let practice = Practice::new(PracticeCfg::from_lookup(&get), c2.sh.cfg.l2_offset);
    let mut lane = Lane::new(LaneCfg::from_lookup(&get), scanner, safety, gate, gun, log, book, practice);
    if RT.set(Rt { status: Mutex::new(json!({})), last_practice: Mutex::new(Value::Null) }).is_err() {
        return false;
    }
    eprintln!("[fastlane] loop ON: {}; gun {} ({})", fm.describe(), lane.gun.mode().as_str(), lane.gun.why_not_broadcasting().unwrap_or("broadcasting"));
    std::thread::Builder::new()
        .name("arbsim-fastlane".into())
        .spawn(move || {
            // H-1: lower CPU priority (FASTLANE_NICE, default 10).
            super::mode::lower_this_thread_from_env("arbsim-fastlane");
            let mut last = 0u64;
            let mut hour = Instant::now();
            let mut status_at = Instant::now();
            loop {
                if let Some((n, tip)) = crate::copy2::ahead::wait_tip(last, Duration::from_millis(250)) {
                    if n > last + 1 && last > 0 {
                        // Tips we never got to (the loop was busy): counted.
                        lane.hour.tips_old += n - last - 1;
                    }
                    last = n;
                    TIPS_SEEN.store(n, Ordering::Relaxed);
                    lane.on_tip(&tip);
                }
                lane.tick();
                lane.score_confirmed(&c2);
                if status_at.elapsed() >= Duration::from_secs(1) {
                    status_at = Instant::now();
                    if let Some(rt) = RT.get() {
                        *rt.status.lock().unwrap_or_else(|e| e.into_inner()) = lane.status_json();
                    }
                }
                if hour.elapsed() >= Duration::from_secs(3600) {
                    hour = Instant::now();
                    for l in lane.take_hour() {
                        eprintln!("{l}");
                    }
                    if let Some(rt) = RT.get() {
                        *rt.last_practice.lock().unwrap_or_else(|e| e.into_inner()) = lane.practice.last_hour_json();
                    }
                }
            }
        })
        .is_ok()
}

/// Status "fastlane" (None when off). `lastHourPractice` = the practice
/// numbers of the last full hour (Node's hourly practice line reads them).
pub fn status_json() -> Option<Value> {
    let rt = RT.get()?;
    let mut v = rt.status.lock().unwrap_or_else(|e| e.into_inner()).clone();
    v["lastHourPractice"] = rt.last_practice.lock().unwrap_or_else(|e| e.into_inner()).clone();
    v["tipsSeen"] = json!(TIPS_SEEN.load(Ordering::Relaxed));
    Some(v)
}
