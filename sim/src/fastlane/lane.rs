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
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
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
    /// Practice + FASTLANE_PRACTICE_SCORE_PAUSED: the kill switch does not
    /// stop a would-send here either (Safety::kill_blocks_practice). Live:
    /// always false, so the kill switch stops the gun exactly as before.
    practice_ignores_kill: bool,
    node_agrees: AtomicBool,
    cleared: Mutex<Option<(u64, String, revm::primitives::U256)>>,
}

impl SafetyGate {
    pub fn new(s: &Safety) -> SafetyGate {
        SafetyGate { mode: s.mode, kill: s.kill.clone(), practice_ignores_kill: !s.kill_blocks_practice(), node_agrees: AtomicBool::new(s.node_agrees_rust_sends()), cleared: Mutex::new(None) }
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
                if self.kill.on() && !self.practice_ignores_kill {
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
    /// Copy-2 versions scanned (predicted copy off: standing gaps on copy 2).
    pub confirmed: u64,
    /// SPEED FIX (Oct 28): copy 2 applied a block -> the lane started on it
    /// (us), newest 5,000. Live: the lane was often still busy with the
    /// previous block.
    pub wait_us: Vec<u64>,
    /// SPEED STEPS (Oct 28): per block, the lane's steps (us), newest 5,000:
    /// copy 2's check core, which pools changed, the scan (incl. route-list
    /// update), firing.
    pub core_us: Vec<u64>,
    pub changed_us: Vec<u64>,
    pub scan_us: Vec<u64>,
    pub fire_us: Vec<u64>,
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

/// What one fire did, for the caller's counting.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FiredWhat {
    /// A safety gate said no (its code).
    Blocked(&'static str),
    /// Signed but never left us (live: stale in the queue / not written).
    NotLeft,
    /// The gun refused before signing / sending (why, first 60 characters).
    GunRefused(String),
    /// Sent (live) / would send (practice): its send-log seq and the time
    /// from the feed message to the bytes handed over / ready (us).
    Written { seq: u64, hand_us: u64 },
}

/// One fire's result (Firer::fire).
#[derive(Clone, Debug)]
pub struct Fired {
    pub res: FireResult,
    pub what: FiredWhat,
    /// The send record could not be written (the trade itself went on).
    pub log_error: bool,
}

/// THE ONE WAY TO FIRE (integration; fire-first from Rust, Oct 27): safety
/// -> gun -> send log -> safety record, under ONE lock (review M5). The
/// standing-gap lane (Lane::fire_one) and the fire-first trigger thread
/// (fastlane/trigger.rs) both fire through clones of the same parts, so
/// every gate, the rate limit, the pool hold, the one-sender rule and
/// "practice never broadcasts" (Gun::broadcasting) hold for both alike.
#[derive(Clone)]
pub struct Firer {
    pub core: Arc<Mutex<FireCore>>,
    pub gate: Arc<SafetyGate>,
    pub gun: Arc<Gun>,
    pub log: Arc<SendsLog>,
    pub book: Arc<ReplyBook>,
}

/// FAST LANE SAFETY (Oct 29): copy 2, for "is every pool of this trade
/// followed and ready?" (set by start(); unset = no check, e.g. tests that
/// build a Firer by hand). FASTLANE_REQUIRE_FOLLOWED=off turns it off.
static FOLLOW: std::sync::OnceLock<crate::copy2::intake::Copy2Handle> = std::sync::OnceLock::new();

/// Why this trade's pools can't be trusted (a pool copy 2 doesn't follow
/// and hold ready: its values may be an old one-time fill), or None.
pub fn follow_block(pools: &[String]) -> Option<String> {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if !*ON.get_or_init(|| !crate::fastlane::mode::parse_off(std::env::var("FASTLANE_REQUIRE_FOLLOWED").ok().as_deref())) {
        return None;
    }
    let c = FOLLOW.get()?;
    // A copy of the ready set, refreshed at most once a second: no
    // registry lock per route (the copy's thread may hold it for a while).
    static READY: Mutex<Option<(Instant, Arc<HashSet<String>>)>> = Mutex::new(None);
    let ready = {
        let mut g = READY.lock().unwrap_or_else(|e| e.into_inner());
        match g.as_ref() {
            Some((t, set)) if t.elapsed() < std::time::Duration::from_secs(1) => set.clone(),
            _ => {
                let set = Arc::new(c.ready_keys());
                *g = Some((Instant::now(), set.clone()));
                set
            }
        }
    };
    pools.iter().find(|k| !ready.contains(&k.trim().to_ascii_lowercase())).map(|k| format!("{} not followed and ready", &k[..k.len().min(12)]))
}

impl Firer {
    /// Safety -> fire -> log -> record (see the file header).
    pub fn fire(&self, o: &Opportunity, feed_at: Instant, apply_us: u64) -> Fired {
        let mut res = FireResult { blocked: None, record: None, written: None, live: false };
        if let Some(why) = follow_block(&o.pools) {
            let _ = why;
            res.blocked = Some("pool_not_followed");
            return Fired { res, what: FiredWhat::Blocked("pool_not_followed"), log_error: false };
        }
        let inp = match to_safety_input(o) {
            Ok(x) => x,
            Err(_) => {
                res.blocked = Some("bad_size");
                return Fired { res, what: FiredWhat::Blocked("bad_size"), log_error: false };
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
            res.blocked = Some(r.code);
            return Fired { res, what: FiredWhat::Blocked(r.code), log_error: false };
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
        // Feed message -> handed to the socket (live) / would hand (practice:
        // the signed bytes are ready right at the end of fire()).
        let to_fire = fire_at.saturating_duration_since(feed_at).as_micros() as u64;
        let hand_us = to_fire + rec.handed_us.unwrap_or_else(|| fire_at.elapsed().as_micros() as u64);
        let on_chain_maybe = rec.send_status.is_some_and(|s| s.maybe_on_chain());
        let write = if live { on_chain_maybe && rec.hash.is_some() } else { rec.signed };
        if !write {
            // Signed but never left us (stale in the queue / not written), or
            // refused by the gun: nothing to track; the route may be handed
            // out again (M4).
            let what = if rec.signed && live { FiredWhat::NotLeft } else { FiredWhat::GunRefused(rec.why.clone().unwrap_or_else(|| "?".into()).chars().take(60).collect()) };
            res.record = Some(rec);
            return Fired { res, what, log_error: false };
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
        // Trading goes on if the record could not be written (bridge.rs); the
        // seq stays used, Safety keeps holding the gas until Node's ack passes it.
        let log_error = wrote.is_err();
        core.safety.record_send(&inp, now, seq);
        drop(core);
        if live {
            if let Some(h) = &rec.hash {
                if let Some(early) = self.book.note(h, seq, &o.rid) {
                    write_reply(&self.log, &self.book, &early, seq, o.rid.clone());
                }
            }
        }
        res.record = Some(rec);
        res.written = Some(sr);
        Fired { res, what: FiredWhat::Written { seq, hand_us }, log_error }
    }
}

pub struct Lane {
    pub cfg: LaneCfg,
    pub scanner: Scanner,
    pub core: Arc<Mutex<FireCore>>,
    pub gate: Arc<SafetyGate>,
    pub gun: Arc<Gun>,
    pub log: Arc<SendsLog>,
    pub book: Arc<ReplyBook>,
    pub practice: Practice,
    pub hour: LaneHour,
    pub last_hour: Option<LaneHour>,
    last_drops: Option<u64>,
    last_gas: u64,
    /// Newest copy-2 block scanned (on_confirmed_version).
    last_confirmed: Option<u64>,
    pub started: Instant,
}

impl Lane {
    /// Assemble from parts (tests and `start`).
    #[allow(clippy::too_many_arguments)]
    pub fn new(cfg: LaneCfg, scanner: Scanner, safety: Safety, gate: Arc<SafetyGate>, gun: Arc<Gun>, log: Arc<SendsLog>, book: Arc<ReplyBook>, practice: Practice) -> Lane {
        Lane {
            cfg,
            scanner,
            core: Arc::new(Mutex::new(FireCore { safety })),
            gate,
            gun,
            log,
            book,
            practice,
            hour: LaneHour::default(),
            last_hour: None,
            last_drops: None,
            last_gas: 0,
            last_confirmed: None,
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

    /// STANDING GAPS ON COPY 2 (Oct 27, owner: "keep standing-gap scanning
    /// (fixed routes) as complementary, on copy 2"; the predicted copy is
    /// off by default). When copy 2 publishes a newer version, scan the
    /// routes through the pools that block moved (plus the rolling sweep)
    /// on that CONFIRMED state, then fire the best like a tip. Time is
    /// counted from the moment copy 2 applied the block. Returns what fired.
    pub fn on_confirmed_version(&mut self, c2: &crate::copy2::intake::Copy2Handle) -> Vec<FireResult> {
        let pv = c2.sh.published.view();
        let Some(head) = pv.head().cloned() else { return Vec::new() };
        if self.last_confirmed.is_some_and(|b| head.block <= b) {
            return Vec::new();
        }
        self.last_confirmed = Some(head.block);
        let Some(ctx) = head.ctx.clone() else { return Vec::new() };
        let t0 = Instant::now();
        self.hour.confirmed += 1;
        push_bounded(&mut self.hour.wait_us, t0.saturating_duration_since(head.applied).as_micros() as u64);
        if head.applied.elapsed() > Duration::from_millis(self.cfg.tip_max_age_ms) {
            self.hour.tips_old += 1;
            return Vec::new();
        }
        let ts = Instant::now();
        // Only `moved` is used here: a core up to 1 s old is fine (SPEED FIX 2).
        let core = c2.recent_core(Duration::from_millis(1_000), Some(&pv));
        push_bounded(&mut self.hour.core_us, ts.elapsed().as_micros() as u64);
        let ts = Instant::now();
        let changed_slots: Vec<(revm::primitives::Address, revm::primitives::U256)> = head.diff.accounts.iter().flat_map(|(a, d)| d.storage.keys().map(move |s| (*a, *s))).collect();
        let changed: Vec<String> = c2.pools_changed_with(&core, &changed_slots, &[]).into_iter().map(|m| m.key.to_ascii_lowercase()).collect();
        push_bounded(&mut self.hour.changed_us, ts.elapsed().as_micros() as u64);
        let ts = Instant::now();
        let view = crate::state::snap::View::new(head.snap.clone());
        // (Oct 30) Routes through a pool copy 2 has not ready are skipped
        // ("skippedUnsure"), as on the predicted view. They used to be run
        // to the end every block and answer "unsure_pool" (live Oct 30:
        // 4,088 of 8,700 unknowns in 16 minutes; 37 pools unsure, 27 of
        // them Solidly-like pools whose getters revert). The list comes
        // from a core up to 1 s old: a pool that just became ready is
        // skipped one block more; one that just became unsure is still
        // checked and answers "unsure_pool" as before. Never an answer
        // from a pool that isn't ready either way.
        let unsure = &core.unsure_keys;
        let input = BlockInput { view: &view, ctx: &ctx, block: head.block, kind: ViewKind::Confirmed, changed: &changed, unsure, snap: Some(&head.snap) };
        let rep = self.scanner.scan(&input);
        push_bounded(&mut self.hour.scan_us, ts.elapsed().as_micros() as u64);
        self.hour.opps += rep.opps.len() as u64;
        let ts = Instant::now();
        let mut out = Vec::new();
        for o in rep.opps.iter().take(self.cfg.fires_per_block) {
            out.push(self.fire_one(o, head.applied, 0));
        }
        push_bounded(&mut self.hour.fire_us, ts.elapsed().as_micros() as u64);
        let lane_us = t0.elapsed().as_micros() as u64;
        push_bounded(&mut self.hour.block_us, lane_us);
        push_bounded(&mut self.hour.lane_us, lane_us);
        out
    }

    /// Fire-first would-sends handed over by the trigger thread: scored by
    /// practice like the lane's own (same re-check on confirmed blocks).
    pub fn take_trigger_would_sends(&mut self) {
        for (o, seq, hand_us) in trigger_inbox_drain() {
            self.practice.note_would_send(&o, seq, hand_us);
        }
    }

    /// Safety -> fire -> log -> record, under ONE lock (review M5), then
    /// this lane's own counting (hour, scanner hand-out, practice scoring).
    pub fn fire_one(&mut self, o: &Opportunity, feed_at: Instant, apply_us: u64) -> FireResult {
        let d = self.firer().fire(o, feed_at, apply_us);
        self.note_fire(o, &d);
        d.res
    }

    /// The shared firing parts (the fast lane's trigger thread fires with
    /// the very same ones: one fire lock, one gate, one gun, one send log).
    pub fn firer(&self) -> Firer {
        Firer { core: self.core.clone(), gate: self.gate.clone(), gun: self.gun.clone(), log: self.log.clone(), book: self.book.clone() }
    }

    /// This lane's counting after one fire (scanner routes handed out again,
    /// practice scoring, hour counters). `d` from Firer::fire.
    pub fn note_fire(&mut self, o: &Opportunity, d: &Fired) {
        match &d.what {
            FiredWhat::Blocked(code) => *self.hour.blocked.entry(code).or_default() += 1,
            FiredWhat::NotLeft => {
                self.hour.fired += 1;
                self.hour.not_left += 1;
                self.scanner.forget(&o.rid);
            }
            FiredWhat::GunRefused(why) => {
                self.hour.fired += 1;
                *self.hour.gun_refused.entry(why.clone()).or_default() += 1;
                self.scanner.forget(&o.rid);
            }
            FiredWhat::Written { seq, hand_us } => {
                self.hour.fired += 1;
                if d.res.live {
                    self.hour.live_sent += 1;
                } else {
                    self.hour.would_send += 1;
                    self.practice.note_would_send(o, *seq, *hand_us);
                }
                if d.log_error {
                    self.hour.log_errors += 1;
                }
                push_bounded(&mut self.hour.latency_us, *hand_us);
            }
        }
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
        let paused_passes = core.safety.paused_passes;
        let score_paused = !core.safety.kill_blocks_practice();
        drop(core);
        json!({
            "mode": self.gun.mode().as_str(),
            "upS": self.started.elapsed().as_secs(),
            "ahead": crate::copy2::ahead::status_json().map(|a| {
                let p = crate::copy2::ahead::prediction_counts().unwrap_or_default();
                json!({"tip": a.get("tip"), "stopped": a.get("stopped"), "agreementPct": p.agreement_pct(), "unsurePct": p.unsure_pct(), "unpredictedPct": p.unpredicted_pct(), "stoppedPct": p.stopped_pct(), "overBudget": p.over_budget,
                    // Practice fixes: the counts behind the %s (agreementPct is per POOL
                    // compared, agree / (agree + disagree); null = nothing compared).
                    "agree": p.agree, "disagree": p.disagree, "unsure": p.unsure, "compared": p.compared, "unpredicted": p.unpredicted,
                    // Accuracy fixes (Oct 27): this hour's disagreements by cause
                    // and the newest samples (full ones: fastlaneAhead.hour / .total).
                    "why": a.get("hour").map(|h| json!({"missedFilter": h["missedFilter"], "missedRan": h["missedRan"], "missedReverted": h["missedReverted"], "missedFailed": h["missedFailed"], "missedOffRoute": h["missedOffRoute"], "phantom": h["phantom"], "value": h["valueDiff"], "staleBase": h["staleBase"], "baseLate": h["baseLate"], "notFromTx": h["notFromTx"], "confGone": h["confGone"]})),
                    "newestSamples": a.get("total").and_then(|t| t["samples"].as_array()).map(|v| v.iter().rev().take(3).cloned().collect::<Vec<_>>()),
                    "capture": a.get("capture")})
            }),
            "copy2Runs": super::c2runner::stats_json(),
            // (Oct 30) What "unknown" answers stopped on (c2runner.rs).
            "copy2Unknown": super::c2runner::unknown_detail_json(),
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
            "safety": {"killed": killed, "state": state, "blockedThisHour": h.blocked,
                // Practice while the bot is paused (FASTLANE_PRACTICE_SCORE_PAUSED):
                // would-sends that passed with the kill switch on (never broadcast).
                "practiceScoresWhilePaused": score_paused, "passedWhilePaused": paused_passes},
            "lane": {
                "tips": h.tips, "confirmedScanned": h.confirmed, "tipsOld": h.tips_old, "opps": h.opps, "fired": h.fired, "wouldSend": h.would_send, "liveSent": h.live_sent,
                "notLeft": h.not_left, "gunRefused": h.gun_refused, "logErrors": h.log_errors, "dropsSeen": h.drops_seen,
                "feedToHandUs": pctl(&h.latency_us), "blockUs": pctl(&h.block_us), "laneUs": pctl(&h.lane_us), "waitUs": pctl(&h.wait_us),
                "steps": {"coreUs": pctl(&h.core_us), "changedUs": pctl(&h.changed_us), "scanUs": pctl(&h.scan_us), "fireUs": pctl(&h.fire_us), "coreBuild": crate::copy2::checkcore::build_stats_json()},
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
    /// The firing parts, for the fire-first trigger thread (fastlane/trigger.rs).
    firer: Firer,
    /// Copy 2's practice scoring needs the lane's view of the mode.
    mode: Mode,
}

static RT: std::sync::OnceLock<Rt> = std::sync::OnceLock::new();
static TIPS_SEEN: AtomicU64 = AtomicU64::new(0);

/// The running lane's firing parts (None = the fast lane is off).
pub fn global_firer() -> Option<Firer> {
    RT.get().map(|rt| rt.firer.clone())
}

/// The running fast lane's mode (None = off).
pub fn global_mode() -> Option<Mode> {
    RT.get().map(|rt| rt.mode)
}

// Copy 2 published a version: wakes the lane (standing gaps on copy 2).
static CONFIRMED: (Mutex<u64>, std::sync::Condvar) = (Mutex::new(0), std::sync::Condvar::new());

/// copy2/intake.rs: a version was published (cheap; nothing when off).
pub fn confirmed_hook() {
    if RT.get().is_none() {
        return;
    }
    let mut g = CONFIRMED.0.lock().unwrap_or_else(|e| e.into_inner());
    *g += 1;
    CONFIRMED.1.notify_all();
}

/// Wait (at most `timeout`) for a copy-2 version newer than number `after`.
fn wait_confirmed(after: u64, timeout: Duration) -> u64 {
    let g = CONFIRMED.0.lock().unwrap_or_else(|e| e.into_inner());
    let (g, _) = CONFIRMED.1.wait_timeout_while(g, timeout, |n| *n <= after).unwrap_or_else(|e| e.into_inner());
    *g
}

// Fire-first would-sends (trigger thread) waiting for practice scoring.
type Inbox = Mutex<Vec<(Opportunity, u64, u64)>>;
static TRIG_INBOX: Inbox = Mutex::new(Vec::new());

/// fastlane/trigger.rs: a fire-first would-send to score (bounded: 256).
pub fn trigger_inbox_push(o: Opportunity, seq: u64, hand_us: u64) {
    let mut g = TRIG_INBOX.lock().unwrap_or_else(|e| e.into_inner());
    if g.len() < 256 {
        g.push((o, seq, hand_us));
    }
}

fn trigger_inbox_drain() -> Vec<(Opportunity, u64, u64)> {
    std::mem::take(&mut *TRIG_INBOX.lock().unwrap_or_else(|e| e.into_inner()))
}

/// Start the fast lane loop (copy 2 mode). Nothing when FASTLANE=off.
/// Returns true when started. Fire-first from Rust (Oct 27): the lane no
/// longer needs the predicted copy. With it (FASTLANE_AHEAD=on) the
/// scanner runs on each predicted tip as before; without it (the default)
/// the scanner runs on each new copy-2 version (standing gaps on copy 2),
/// and the fire-first trigger thread (fastlane/trigger.rs, started by the
/// server once its context exists) fires through this lane's parts.
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
    let _ = FOLLOW.set(c2.clone());
    let scanner = Scanner::new(ScanConfig::from_env(), Box::new(super::scan::TableSource::global()), Box::new(super::c2runner::Copy2Runner::new(c2.clone())));
    let practice = Practice::new(PracticeCfg::from_lookup(&get), c2.sh.cfg.l2_offset);
    let mut lane = Lane::new(LaneCfg::from_lookup(&get), scanner, safety, gate, gun, log, book, practice);
    if RT.set(Rt { status: Mutex::new(json!({})), last_practice: Mutex::new(Value::Null), firer: lane.firer(), mode: fm.mode }).is_err() {
        return false;
    }
    let ahead_on = crate::copy2::ahead::status_json().is_some();
    eprintln!(
        "[fastlane] loop ON: {}; gun {} ({}); standing gaps scanned on {}",
        fm.describe(),
        lane.gun.mode().as_str(),
        lane.gun.why_not_broadcasting().unwrap_or("broadcasting"),
        if ahead_on { "the predicted copy (FASTLANE_AHEAD=on)" } else { "copy 2's confirmed versions" }
    );
    std::thread::Builder::new()
        .name("arbsim-fastlane".into())
        .spawn(move || {
            // H-1: lower CPU priority (FASTLANE_NICE, default 10).
            super::mode::lower_this_thread_from_env("arbsim-fastlane");
            let mut last = 0u64;
            let mut seen_confirmed = 0u64;
            let mut hour = Instant::now();
            let mut status_at = Instant::now();
            loop {
                if ahead_on {
                    if let Some((n, tip)) = crate::copy2::ahead::wait_tip(last, Duration::from_millis(250)) {
                        if n > last + 1 && last > 0 {
                            // Tips we never got to (the loop was busy): counted.
                            lane.hour.tips_old += n - last - 1;
                        }
                        last = n;
                        TIPS_SEEN.store(n, Ordering::Relaxed);
                        lane.on_tip(&tip);
                    }
                } else {
                    let n = wait_confirmed(seen_confirmed, Duration::from_millis(250));
                    if n > seen_confirmed {
                        seen_confirmed = n;
                        TIPS_SEEN.store(n, Ordering::Relaxed);
                        lane.on_confirmed_version(&c2);
                    }
                }
                lane.take_trigger_would_sends();
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
                    eprintln!("{}", super::trigger::take_hour());
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
    // Fire-first from Rust (fastlane/trigger.rs): its own section.
    v["trigger"] = super::trigger::status_json();
    Some(v)
}
