// ============================================================================
// FAST LANE SAFETY: every check the Node bot makes before a real send, in Rust.
//
// Plain English:
//   Before the fast lane sends (or, in practice mode, "would send") a trade,
//   `Safety::check` runs the same safeguards the Node bot runs before its own
//   real sends, with the SAME .env names and defaults. Any one failing stops
//   the trade and says why (BlockReason: a short code for counting plus a
//   plain-English detail for the log). The Node original of each check is
//   named next to it below (file:line on main 536717c).
//
//   Some facts only Node has (money lost today, blocked pairs, allowed
//   coins, pools cleared for live, scoreboard pauses, own-money balances,
//   live readiness). Those come from data/fastlane-state.json (bridge.rs).
//   If that file is missing, unreadable or older than 10 s, EVERY trade is
//   blocked (fail closed).
//
//   Where both sides have a limit (e.g. MAX_TRADE_USD), the stricter one wins.
//   A setting that is not a positive number (e.g. "5,000") blocks every send
//   until fixed, like fastSender.ts safetyConfigProblems.
//
//   After a real send (or practice "would send") call `record_send`: it
//   counts the send for MAX_SENDS_PER_MIN, holds the route's pools for
//   GAP_SENT_POOL_HOLD_MS (one send per gap) and reserves 2x the trade's gas
//   against the daily loss cap until Node has picked the send up from
//   data/fastlane-sends.jsonl (then Node's own pending figure covers it).
//   "Picked up" is decided by the record's sequence number (seq) and Node's
//   ackSeq in the state file, never by time (many sends can share one ms).
//
//   One sender (H1): a live send also needs Node's OWN RUST_SENDER to be on
//   (state file "rustSender": true). If Node's .env says the Node bot is the
//   sender, or the field is missing, Rust does not broadcast.
//
//   Rules Node applies that are NOT checked here, on purpose:
//     - the 6 h "pool pair blocked for live" list: Node skips it for
//       standing gaps and trigger-first entry sends (each is sent right after
//       its own exact check). FASTLANE_LIVE_BLOCKS=on applies it here too.
//     - FIRE_FIRST_ONLY: switches Node's older paths; the fast lane has its
//       own switch (FASTLANE).
//     - outlier second check on another node: too slow for the fast lane, so
//       an outlier is simply never sent (like Node's live trigger outliers).
//     - deadline block / gas limit / nonce: the sender (gun) owns those.
// ============================================================================
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use crate::fastlane::bridge::{env_num, wall_ms, KillSwitch, SharedState, StateReader};
use crate::fastlane::mode::{FastlaneMode, Mode};

// ---------------------------------------------------------------------------
// What the safety check needs to know about one trade.
// ---------------------------------------------------------------------------

/// What kind of route (decides which pause / limits apply).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteKind {
    /// Two pools, a standing gap (Node path "gap").
    Pair,
    /// Three or more pools (Node path "loop").
    Loop,
}

/// The facts of one trade the gates look at. Integration note: workstream B
/// defines `fastlane::types::Opportunity`; this is filled from it (see
/// `SafetyInput::new`), so safety has no hard dependency on B's struct.
#[derive(Clone, Debug)]
pub struct SafetyInput {
    pub block: u64,
    pub label: String,
    pub kind: RouteKind,
    /// The coin the trade starts and ends in.
    pub token_in: String,
    /// Every coin the route touches (start coin included).
    pub tokens: Vec<String>,
    /// Pools in route order.
    pub pools: Vec<String>,
    /// Raw amount of token_in put in.
    pub amount_in: u128,
    pub size_usd: f64,
    /// Expected profit after gas and loan fee.
    pub expected_net_usd: f64,
    pub gas_usd: f64,
    /// Flash-loan lender pool, None = own money.
    pub lender: Option<String>,
    /// When the opportunity was found (feed message applied + scan).
    pub found_at: Instant,
    /// A fire-first trade (fastlane/trigger.rs): the scoreboard's
    /// "trig_first" pause applies (Node's pausedWhy('trig_first')), not the
    /// standing-gap one. false = as before.
    pub trig: bool,
}

impl SafetyInput {
    /// Pools are 2 = pair, more = loop.
    #[allow(clippy::too_many_arguments)]
    pub fn new(block: u64, label: String, token_in: String, tokens: Vec<String>, pools: Vec<String>, amount_in: u128, size_usd: f64, expected_net_usd: f64, gas_usd: f64, lender: Option<String>, found_at: Instant) -> SafetyInput {
        let kind = if pools.len() > 2 { RouteKind::Loop } else { RouteKind::Pair };
        SafetyInput { block, label, kind, token_in, tokens, pools, amount_in, size_usd, expected_net_usd, gas_usd, lender, found_at, trig: false }
    }
}

/// Why a trade was stopped.
#[derive(Clone, Debug, PartialEq)]
pub struct BlockReason {
    /// Short fixed code, for counting ("kill", "max_trade", ...).
    pub code: &'static str,
    /// Plain-English detail for the log (no secrets, addresses shortened).
    pub detail: String,
}

impl BlockReason {
    fn new(code: &'static str, detail: impl Into<String>) -> BlockReason {
        BlockReason { code, detail: detail.into() }
    }
}

impl std::fmt::Display for BlockReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

fn short(a: &str) -> String {
    a.chars().take(10).collect()
}

// ---------------------------------------------------------------------------
// Settings (same names and defaults as the Node bot)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct SafetyConfig {
    /// MAX_TRADE_USD [20000] (fastSender.ts:42)
    pub max_trade_usd: f64,
    /// DAILY_LOSS_CAP_USD [25] (fastSender.ts:43)
    pub daily_loss_cap_usd: f64,
    /// MAX_SENDS_PER_MIN [6] (fastSender.ts:44)
    pub max_sends_per_min: f64,
    /// MIN_EXEC_NET_USD [0.25] (core/types.ts:138)
    pub min_net_usd: f64,
    /// AUTO_VET_MAX_TRADE_USD [300] (shadowMain.ts:1418)
    pub auto_vet_max_trade_usd: f64,
    /// LOOP_LIVE_MAX_TRADE_USD [10000] (execution/loopLive.ts:69)
    pub loop_max_trade_usd: f64,
    /// LOOP_LIVE_LOSS_CAP_USD [2] (execution/loopLive.ts:68)
    pub loop_loss_cap_usd: f64,
    /// OUTLIER_GUARD / OUTLIER_MAX_USD [50] / OUTLIER_MAX_PCT [2] / OUTLIER_MIN_USD [20] (core/outlierGuard.ts:57)
    pub outlier_on: bool,
    pub outlier_max_usd: f64,
    pub outlier_max_pct: f64,
    pub outlier_min_usd: f64,
    /// MAX_PLAUSIBLE_PROFIT_SHARE [0.25] (shadowMain.ts:739)
    pub max_plausible_share: f64,
    /// GAP_SENT_POOL_HOLD_MS [3000] (shadowMain.ts:3912)
    pub pool_hold_ms: u64,
    /// FASTLANE_MAX_OPP_AGE_MS [150] (new): an opportunity older than this
    /// is not sent (the next block has most likely come already).
    pub max_opp_age_ms: u64,
    /// FASTLANE_LIVE_BLOCKS [off] (new): also honour Node's 6 h live block list.
    pub honour_live_blocks: bool,
    /// FASTLANE_PRACTICE_SCORE_PAUSED [on] (Oct 28, owner: "I want to score
    /// trades"): in PRACTICE mode only, the pause / kill switch (data/KILL,
    /// KILL_SWITCH=on, or Node's state saying killed) does not stop a
    /// "would send", so practice can score what it would have done while
    /// the Node bot is paused. Practice never broadcasts (Gun::broadcasting
    /// needs FASTLANE=live), and in LIVE mode the kill switch blocks exactly
    /// as before. "off" = practice obeys the kill switch too (old behaviour).
    pub practice_score_paused: bool,
    /// Settings that are not positive numbers (any = block every send).
    pub problems: Vec<String>,
}

/// Same rule as outlierGuard.ts `num`: missing / junk / not above 0 = default.
fn outlier_num(get: &dyn Fn(&str) -> Option<String>, key: &str, dflt: f64) -> f64 {
    match get(key).map(|s| s.trim().to_string()) {
        Some(s) if !s.is_empty() => s.parse::<f64>().ok().filter(|n| n.is_finite() && *n > 0.0).unwrap_or(dflt),
        _ => dflt,
    }
}

impl SafetyConfig {
    pub fn from_lookup(get: &dyn Fn(&str) -> Option<String>) -> SafetyConfig {
        let max_trade_usd = env_num(get, "MAX_TRADE_USD", 20_000.0);
        let daily_loss_cap_usd = env_num(get, "DAILY_LOSS_CAP_USD", 25.0);
        let max_sends_per_min = env_num(get, "MAX_SENDS_PER_MIN", 6.0);
        // MIN_EXEC_NET_USD: unset / empty / junk / not above 0 -> $0.25 (types.ts readMinExecNetUsd).
        let min_net_usd = outlier_num(get, "MIN_EXEC_NET_USD", 0.25);
        let auto_vet_max_trade_usd = env_num(get, "AUTO_VET_MAX_TRADE_USD", 300.0);
        // loopLive.ts num(): out of range -> default.
        let ranged = |key: &str, d: f64, lo: f64, hi: f64| {
            let v = env_num(get, key, d);
            if v.is_finite() && v >= lo && v <= hi { v } else { d }
        };
        let loop_loss_cap_usd = ranged("LOOP_LIVE_LOSS_CAP_USD", 2.0, 0.0, 1_000.0);
        let loop_max_trade_usd = ranged("LOOP_LIVE_MAX_TRADE_USD", 10_000.0, 1.0, 1e6);
        let outlier_on = !matches!(get("OUTLIER_GUARD").map(|s| s.trim().to_ascii_lowercase()).as_deref(), Some("0" | "off" | "false" | "no"));
        let mut problems = Vec::new();
        for (name, v) in [("MAX_TRADE_USD", max_trade_usd), ("DAILY_LOSS_CAP_USD", daily_loss_cap_usd), ("MAX_SENDS_PER_MIN", max_sends_per_min), ("AUTO_VET_MAX_TRADE_USD", auto_vet_max_trade_usd)] {
            if !(v.is_finite() && v > 0.0) {
                problems.push(format!("{name}={v}"));
            }
        }
        let hold = env_num(get, "GAP_SENT_POOL_HOLD_MS", 3_000.0);
        let age = env_num(get, "FASTLANE_MAX_OPP_AGE_MS", 150.0);
        SafetyConfig {
            max_trade_usd,
            daily_loss_cap_usd,
            max_sends_per_min,
            min_net_usd,
            auto_vet_max_trade_usd,
            loop_max_trade_usd,
            loop_loss_cap_usd,
            outlier_on,
            outlier_max_usd: outlier_num(get, "OUTLIER_MAX_USD", 50.0),
            outlier_max_pct: outlier_num(get, "OUTLIER_MAX_PCT", 2.0),
            outlier_min_usd: outlier_num(get, "OUTLIER_MIN_USD", 20.0),
            max_plausible_share: outlier_num(get, "MAX_PLAUSIBLE_PROFIT_SHARE", 0.25),
            pool_hold_ms: if hold.is_finite() && hold >= 0.0 { hold as u64 } else { 3_000 },
            max_opp_age_ms: if age.is_finite() && age > 0.0 { age as u64 } else { 150 },
            honour_live_blocks: crate::fastlane::mode::parse_on(get("FASTLANE_LIVE_BLOCKS").as_deref()),
            practice_score_paused: !crate::fastlane::mode::parse_off(get("FASTLANE_PRACTICE_SCORE_PAUSED").as_deref()),
            problems,
        }
    }

    /// Node's isOutlier (core/outlierGuard.ts:66), same maths.
    pub fn is_outlier(&self, net_usd: f64, size_usd: f64) -> bool {
        if !self.outlier_on {
            return false;
        }
        if !net_usd.is_finite() {
            return true;
        }
        if net_usd <= self.outlier_min_usd {
            return false;
        }
        if net_usd > self.outlier_max_usd {
            return true;
        }
        if !(size_usd > 0.0) {
            return true;
        }
        (net_usd / size_usd) * 100.0 > self.outlier_max_pct
    }
}

/// The stricter (smaller) of our limit and Node's, ignoring a missing/bad Node value.
fn stricter(ours: f64, node: Option<f64>) -> f64 {
    match node {
        Some(n) if n.is_finite() && n > 0.0 => ours.min(n),
        _ => ours,
    }
}

/// UTC calendar day ("2026-10-26") for ms since 1970, like Node's
/// new Date(ms).toISOString().slice(0, 10). (Howard Hinnant's civil date.)
pub fn utc_day(ms: u64) -> String {
    let z = (ms / 86_400_000) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/// One of our sends Node has not picked up yet (reserved against the caps).
#[derive(Clone, Debug)]
struct Reserved {
    /// The send's record number in fastlane-sends.jsonl.
    seq: u64,
    /// When reserved (wall ms), only for the 10 min memory bound.
    t_ms: u64,
    usd: f64,
    is_loop: bool,
}

pub struct Safety {
    pub cfg: SafetyConfig,
    pub mode: FastlaneMode,
    pub kill: KillSwitch,
    pub state: StateReader,
    /// Wall clock (ms since 1970); replaceable in tests.
    pub wall: Box<dyn Fn() -> u64 + Send>,
    send_times: VecDeque<Instant>,
    pool_hold: HashMap<String, Instant>,
    reserved: VecDeque<Reserved>,
    /// Practice checks that passed although the kill switch was on
    /// (FASTLANE_PRACTICE_SCORE_PAUSED), for the status page.
    pub paused_passes: u64,
}

/// At most this many reservations / pool holds are remembered (memory bound).
const MAX_TRACKED: usize = 1_000;

impl Safety {
    pub fn new(cfg: SafetyConfig, mode: FastlaneMode, kill: KillSwitch, state: StateReader) -> Safety {
        Safety { cfg, mode, kill, state, wall: Box::new(wall_ms), send_times: VecDeque::new(), pool_hold: HashMap::new(), reserved: VecDeque::new(), paused_passes: 0 }
    }

    /// Everything from the environment (the program's real settings).
    pub fn from_env() -> Safety {
        let get = |k: &str| std::env::var(k).ok();
        Safety::new(SafetyConfig::from_lookup(&get), FastlaneMode::from_env(), KillSwitch::from_lookup(&get), StateReader::from_lookup(&get))
    }

    /// Kill switch right now (file looked at every call: no caching).
    pub fn killed(&self) -> bool {
        self.kill.on()
    }

    /// Does the kill switch stop this check? Always in live mode; in
    /// practice mode only when FASTLANE_PRACTICE_SCORE_PAUSED=off.
    pub fn kill_blocks_practice(&self) -> bool {
        !(self.mode.mode == Mode::Practice && self.cfg.practice_score_paused)
    }

    /// May the gun broadcast for real right now? FASTLANE=live AND our
    /// RUST_SENDER=on AND no kill switch AND Node's state file is usable and
    /// says Node's own RUST_SENDER is on too (H1: both sides must agree).
    /// Call right before sending (uses the state as last refreshed).
    pub fn may_broadcast(&self) -> bool {
        self.mode.may_broadcast(self.killed()) && self.node_agrees_rust_sends()
    }

    /// Node's state is fresh and Node's own RUST_SENDER is on.
    pub fn node_agrees_rust_sends(&self) -> bool {
        self.state.usable((self.wall)()).map(|s| s.raw.rust_sender).unwrap_or(false)
    }

    /// Our reservations Node has not counted yet (drops the ones it has).
    fn unpicked(&mut self, ack_seq: u64, now_ms: u64) -> (f64, f64) {
        // Node counted every record with seq <= ack_seq; anything older than
        // 10 min is dropped as a memory bound (a stale state file blocks
        // everything long before that).
        self.reserved.retain(|r| r.seq > ack_seq && now_ms.saturating_sub(r.t_ms) < 600_000);
        let all = self.reserved.iter().map(|r| r.usd).sum();
        let loops = self.reserved.iter().filter(|r| r.is_loop).map(|r| r.usd).sum();
        (all, loops)
    }

    /// Run every gate. Ok = may send (live) / would send (practice).
    pub fn check(&mut self, o: &SafetyInput, now: Instant) -> Result<(), BlockReason> {
        let now_ms = (self.wall)();
        // 1. Mode and the one-sender rule (new; see mode.rs).
        match self.mode.mode {
            Mode::Off => return Err(BlockReason::new("off", "FASTLANE=off")),
            Mode::Live if !self.mode.rust_sender => return Err(BlockReason::new("node_is_sender", "FASTLANE=live but RUST_SENDER=off: the Node bot is the sender")),
            _ => {}
        }
        // 2. Kill switch: data/KILL or KILL_SWITCH=on (fastSender.ts:104, trigEntry.ts:1026).
        // Practice + FASTLANE_PRACTICE_SCORE_PAUSED: noted, not blocked
        // (practice never broadcasts; see the setting).
        let mut paused = false;
        if self.killed() {
            if self.kill_blocks_practice() {
                return Err(BlockReason::new("kill", "kill switch on"));
            }
            paused = true;
        }
        // 3. Bad settings, ours (fastSender.ts:105 safetyConfigProblems).
        if !self.cfg.problems.is_empty() {
            return Err(BlockReason::new("bad_setting", format!("bad safety setting: {}", self.cfg.problems.join(", "))));
        }
        // 4. Node's shared state: missing / unreadable / older than 10 s = block (new, fail closed).
        self.state.refresh(now, false);
        let (unpicked_usd, unpicked_loop_usd) = {
            let ack = self.state.usable(now_ms).map(|s| s.raw.ack_seq).unwrap_or(0);
            self.unpicked(ack, now_ms)
        };
        let st: &SharedState = match self.state.usable(now_ms) {
            Ok(s) => s,
            Err(p) => return Err(BlockReason::new("state", p.to_string())),
        };
        let lim = &st.raw.limits;
        if st.raw.killed {
            if self.kill_blocks_practice() {
                return Err(BlockReason::new("kill", "kill switch on (seen by the Node bot)"));
            }
            paused = true;
        }
        if !st.raw.problems.is_empty() {
            return Err(BlockReason::new("bad_setting", format!("bad safety setting (Node): {}", st.raw.problems.join(", "))));
        }
        // 5. Opportunity too old (new: the fast lane only aims at the next block).
        let age = now.saturating_duration_since(o.found_at);
        if age > Duration::from_millis(self.cfg.max_opp_age_ms) {
            return Err(BlockReason::new("stale", format!("opportunity {} ms old (limit {} ms)", age.as_millis(), self.cfg.max_opp_age_ms)));
        }
        // 6. Size (fastSender.ts:106-107; stricter of ours and Node's).
        if !(o.size_usd > 0.0) || !o.size_usd.is_finite() || o.amount_in == 0 {
            return Err(BlockReason::new("no_size", "no trade size"));
        }
        let max_trade = stricter(self.cfg.max_trade_usd, lim.max_trade_usd);
        if o.size_usd > max_trade {
            return Err(BlockReason::new("max_trade", format!("size ${} over max ${}", o.size_usd.round(), max_trade)));
        }
        // 7. Send minimum after all costs (shadowMain.ts:2655 / trigEntry.ts:1027; MIN_EXEC_NET_USD).
        let min_net = self.cfg.min_net_usd.max(lim.min_net_usd.filter(|v| v.is_finite() && *v > 0.0).unwrap_or(0.0));
        if !(o.expected_net_usd >= min_net) {
            return Err(BlockReason::new("min_net", format!("expected ${:.4} under the send minimum ${}", o.expected_net_usd, min_net)));
        }
        // 8. Outlier guard (shadowMain.ts:2699; core/outlierGuard.ts:66): never sent by the fast lane.
        if self.cfg.is_outlier(o.expected_net_usd, o.size_usd) {
            return Err(BlockReason::new("outlier", format!("outlier profit ${:.2} on ${} (too good to be true; fast lane never sends these)", o.expected_net_usd, o.size_usd.round())));
        }
        // 9. Implausible profit share (shadowMain.ts:739 MAX_PLAUSIBLE_PROFIT_SHARE), in USD.
        if o.expected_net_usd / o.size_usd > self.cfg.max_plausible_share {
            return Err(BlockReason::new("implausible", format!("profit is {:.0}% of the trade (broken data)", 100.0 * o.expected_net_usd / o.size_usd)));
        }
        // 10. Daily loss cap incl. sends waiting for a receipt (fastSender.ts:108-109).
        let cap = stricter(self.cfg.daily_loss_cap_usd, lim.daily_loss_cap_usd);
        let today = utc_day(now_ms);
        let loss_today = if st.raw.loss_day == today { st.raw.loss_usd.max(0.0) } else { 0.0 };
        let lost = loss_today + st.raw.pending_usd.max(0.0) + unpicked_usd;
        if !lost.is_finite() || lost >= cap {
            return Err(BlockReason::new("loss_cap", format!("daily loss cap ${} reached (${:.2} incl. sends in flight)", cap, lost)));
        }
        // 11. Coin allowlist (fastSender.ts:110-111).
        if let Some(bad) = o.tokens.iter().chain(std::iter::once(&o.token_in)).find(|t| !st.allow.contains(&t.to_ascii_lowercase())) {
            return Err(BlockReason::new("allowlist", format!("token {} not on the allowlist", short(bad))));
        }
        // 12. Auto-vetted coins: smaller size limit (shadowMain.ts:2532, 1976).
        let av_max = stricter(self.cfg.auto_vet_max_trade_usd, lim.auto_vet_max_trade_usd);
        if o.size_usd > av_max && o.tokens.iter().any(|t| st.auto_vetted.contains(&t.to_ascii_lowercase())) {
            return Err(BlockReason::new("auto_vet", format!("auto-vetted coin: over the ${} limit", av_max)));
        }
        // 13. Pools cleared for live: exchange cleared, not practice-only, live coin rule (shadowMain.ts:133 liveBlocker).
        if let Some(p) = o.pools.iter().find(|p| !st.live_pools.contains(&p.to_ascii_lowercase())) {
            return Err(BlockReason::new("pool_not_live", format!("pool {} not cleared for live trading", short(p))));
        }
        // 14. Pair blocks. 30 min after a failed live trade (shadowMain.ts:2501 gapFailBlocks,
        //     trigEntry.ts:1030), and optionally the 6 h list (shadowMain.ts:2494 liveBlocks).
        for w in pair_steps(&o.pools) {
            if let Some(why) = SharedState::blocked(&st.fail_blocks, w.0, w.1, now_ms) {
                return Err(BlockReason::new("pair_fail_block", format!("live trade failed on this pair recently: {why}")));
            }
            if self.cfg.honour_live_blocks {
                if let Some(why) = SharedState::blocked(&st.live_blocks, w.0, w.1, now_ms) {
                    return Err(BlockReason::new("pair_live_block", format!("pool pair blocked for live: {why}")));
                }
            }
        }
        // 15. Scoreboard pauses (shadowMain.ts:2745 pausedWhy; loops 2010).
        match o.kind {
            // Fire-first pairs: the "trig_first" pause (Node's own fire-first
            // sends check pausedWhy('trig_first'), trigEntry.ts gates).
            RouteKind::Pair if o.trig => {
                if let Some(p) = &st.raw.paused.trig {
                    return Err(BlockReason::new("scoreboard", format!("scoreboard: fire-first paused ({p})")));
                }
            }
            RouteKind::Pair => {
                if let Some(p) = &st.raw.paused.gap {
                    return Err(BlockReason::new("scoreboard", format!("scoreboard: gap paused ({p})")));
                }
            }
            RouteKind::Loop => {
                if let Some(p) = &st.raw.paused.r#loop {
                    return Err(BlockReason::new("scoreboard", format!("scoreboard: loop paused ({p})")));
                }
                // 16. Loop size limit and loop loss cap counting sends in flight (trigEntryLoops.ts:556-563).
                let loop_max = stricter(self.cfg.loop_max_trade_usd, lim.loop_max_trade_usd);
                if o.size_usd > loop_max {
                    return Err(BlockReason::new("loop_max_trade", format!("loop over the ${} loop limit", loop_max)));
                }
                let loop_cap = match lim.loop_loss_cap_usd {
                    Some(n) if n.is_finite() && n >= 0.0 => self.cfg.loop_loss_cap_usd.min(n),
                    _ => self.cfg.loop_loss_cap_usd,
                };
                if st.raw.loop_paused || st.raw.loop_loss_usd.max(0.0) + unpicked_loop_usd + o.gas_usd.max(0.0) > loop_cap {
                    return Err(BlockReason::new("loop_loss_cap", "loop loss cap (counting trades in flight)"));
                }
            }
        }
        // 17. Pools a send just went out on are held (shadowMain.ts:4032 gapPoolBusy; trigEntryLoops.ts:561).
        self.pool_hold.retain(|_, until| *until > now);
        if let Some(p) = o.pools.iter().find(|p| self.pool_hold.contains_key(&p.to_ascii_lowercase())) {
            return Err(BlockReason::new("pool_busy", format!("a send on pool {} just went out", short(p))));
        }
        // 18. Sends per minute (fastSender.ts:112-114).
        while self.send_times.front().is_some_and(|t| now.saturating_duration_since(*t) >= Duration::from_secs(60)) {
            self.send_times.pop_front();
        }
        let per_min = stricter(self.cfg.max_sends_per_min, lim.max_sends_per_min);
        if (self.send_times.len() as f64) >= per_min {
            return Err(BlockReason::new("rate", "send rate limit"));
        }
        // Live only from here: Node's practice mode skips these too.
        if self.mode.mode == Mode::Live {
            // 19a. One sender (H1): Node's OWN RUST_SENDER must be on too, so a
            //      .env mismatch can never make both programs broadcast.
            if !st.raw.rust_sender {
                return Err(BlockReason::new("node_is_sender", "Node's RUST_SENDER is off (state file rustSender false/missing): Node is the sender"));
            }
            // 19. Live readiness checks passed (shadowMain.ts:2675).
            if !st.raw.live_ready {
                return Err(BlockReason::new("not_ready", "live checks not passed"));
            }
            // 20. Funding (shadowMain.ts:2685-2687): own money really held (read within
            //     60 s, ownMoney.ts:73), or an approved flash lender.
            match &o.lender {
                None => {
                    let fresh = st.raw.own_money.read_ms > 0 && now_ms.saturating_sub(st.raw.own_money.read_ms) <= 60_000;
                    let held = st.own.get(&o.token_in.to_ascii_lowercase()).copied().unwrap_or(0);
                    if !fresh || held < o.amount_in {
                        return Err(BlockReason::new("own_money", "own money too low and no approved lender"));
                    }
                }
                Some(l) => {
                    if !st.lenders.contains(&l.to_ascii_lowercase()) {
                        return Err(BlockReason::new("lender", "no approved flash lender for this token"));
                    }
                }
            }
        }
        if paused {
            self.paused_passes += 1;
        }
        Ok(())
    }

    /// Note a send (live) or "would send" (practice). `seq` is the record's
    /// sequence number in fastlane-sends.jsonl (`SendsLog::next_seq`, then
    /// write the record with that seq): its gas stays held until Node's
    /// ackSeq reaches it.
    pub fn record_send(&mut self, o: &SafetyInput, now: Instant, seq: u64) {
        let t_ms = (self.wall)();
        self.send_times.push_back(now);
        while self.send_times.len() > MAX_TRACKED {
            self.send_times.pop_front();
        }
        let until = now + Duration::from_millis(self.cfg.pool_hold_ms);
        for p in &o.pools {
            self.pool_hold.insert(p.to_ascii_lowercase(), until);
        }
        if self.pool_hold.len() > MAX_TRACKED {
            self.pool_hold.retain(|_, u| *u > now);
        }
        // Worst-case gas (2x) held against the loss caps until Node has the
        // send (fastSender.ts reservePending, shadowMain.ts:2801). Practice
        // sends cost nothing and Node never counts them: not reserved.
        if self.mode.mode == Mode::Live {
            self.reserved.push_back(Reserved { seq, t_ms, usd: 2.0 * o.gas_usd.max(0.0), is_loop: o.kind == RouteKind::Loop });
            while self.reserved.len() > MAX_TRACKED {
                self.reserved.pop_front();
            }
        }
    }
}

/// Every neighbouring pool pair of a route (a 2-pool route = one pair; a
/// loop also the last-to-first pair), as the fail-block lists key them.
fn pair_steps(pools: &[String]) -> Vec<(&str, &str)> {
    let n = pools.len();
    if n < 2 {
        return Vec::new();
    }
    let mut v: Vec<(&str, &str)> = pools.windows(2).map(|w| (w[0].as_str(), w[1].as_str())).collect();
    if n > 2 {
        v.push((pools[n - 1].as_str(), pools[0].as_str()));
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fastlane::bridge::{NodeLimits, NodeState, OwnMoney, Paused};
    use std::collections::HashMap as Map;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    const NOW_MS: u64 = 1_793_000_000_000; // 2026-10-26-ish

    fn tmpdir(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!("fastlane-safety-{}-{}-{}", tag, std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn good_state() -> NodeState {
        NodeState {
            v: 1,
            written_ms: NOW_MS,
            loss_day: utc_day(NOW_MS),
            allowlist: vec!["0xweth".into(), "0xusdg".into(), "0xcoin".into()],
            live_pools: vec!["0xp1".into(), "0xp2".into(), "0xp3".into()],
            live_ready: true,
            rust_sender: true,
            approved_lenders: vec!["0xlender".into()],
            own_money: OwnMoney { read_ms: NOW_MS, balances: [("0xusdg".to_string(), "1000000000".to_string())].into_iter().collect() },
            ..Default::default()
        }
    }

    struct T {
        s: Safety,
        dir: PathBuf,
        clock: Arc<AtomicU64>,
    }

    impl T {
        fn new(env: &[(&str, &str)], st: NodeState) -> T {
            let dir = tmpdir("t");
            let mut m: Map<String, String> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            m.entry("FASTLANE".into()).or_insert_with(|| "live".into());
            m.entry("RUST_SENDER".into()).or_insert_with(|| "on".into());
            m.insert("KILL_FILE".into(), dir.join("KILL").to_string_lossy().into());
            m.insert("FASTLANE_STATE_FILE".into(), dir.join("state.json").to_string_lossy().into());
            let get = |k: &str| m.get(k).cloned();
            let mut s = Safety::new(SafetyConfig::from_lookup(&get), FastlaneMode::from_lookup(get), KillSwitch::from_lookup(&get), StateReader::from_lookup(&get));
            let clock = Arc::new(AtomicU64::new(NOW_MS));
            let c2 = clock.clone();
            s.wall = Box::new(move || c2.load(Ordering::Relaxed));
            let t = T { s, dir, clock };
            t.put(&st);
            t
        }
        fn put(&self, st: &NodeState) {
            let p = self.dir.join("state.json");
            let tmp = self.dir.join("state.tmp");
            std::fs::write(&tmp, serde_json::to_vec(st).unwrap()).unwrap();
            std::fs::rename(tmp, p).unwrap();
        }
        fn check(&mut self, o: &SafetyInput) -> Result<(), BlockReason> {
            self.s.state.refresh(Instant::now(), true);
            self.s.check(o, o.found_at)
        }
        fn code(&mut self, o: &SafetyInput) -> &'static str {
            match self.check(o) {
                Ok(()) => "ok",
                Err(r) => r.code,
            }
        }
    }

    fn pair() -> SafetyInput {
        SafetyInput::new(100, "USDG/COIN a>b".into(), "0xUSDG".into(), vec!["0xusdg".into(), "0xcoin".into()], vec!["0xP1".into(), "0xP2".into()], 1_000_000, 500.0, 1.0, 0.02, None, Instant::now())
    }

    #[test]
    fn all_good_passes() {
        let mut t = T::new(&[], good_state());
        assert_eq!(t.code(&pair()), "ok");
    }

    #[test]
    fn mode_gates() {
        assert_eq!(T::new(&[("FASTLANE", "off")], good_state()).code(&pair()), "off");
        assert_eq!(T::new(&[("RUST_SENDER", "off")], good_state()).code(&pair()), "node_is_sender");
        // Practice: allowed whoever the sender is (it never broadcasts).
        let mut p = T::new(&[("FASTLANE", "practice"), ("RUST_SENDER", "off")], good_state());
        assert_eq!(p.code(&pair()), "ok");
        assert!(!p.s.may_broadcast());
        let mut l = T::new(&[], good_state());
        assert!(!l.s.may_broadcast(), "state not read yet: no broadcast");
        assert_eq!(l.code(&pair()), "ok");
        assert!(l.s.may_broadcast());
    }

    #[test]
    fn one_sender_needs_both_sides() {
        // Rust RUST_SENDER=on, Node's RUST_SENDER=off: Rust must not broadcast.
        let mut a = T::new(&[], NodeState { rust_sender: false, ..good_state() });
        assert_eq!(a.code(&pair()), "node_is_sender");
        assert!(!a.s.may_broadcast());
        // Missing field in an older Node's file = false = block.
        let mut st = serde_json::to_value(good_state()).unwrap();
        st.as_object_mut().unwrap().remove("rustSender");
        let p = a.dir.join("state.json");
        std::fs::write(&p, serde_json::to_vec(&st).unwrap()).unwrap();
        assert_eq!(a.code(&pair()), "node_is_sender");
        // Node's RUST_SENDER=on, Rust's off: still no broadcast (Rust's own switch).
        let mut b = T::new(&[("RUST_SENDER", "off")], good_state());
        assert_eq!(b.code(&pair()), "node_is_sender");
        assert!(!b.s.may_broadcast());
        // Both on: broadcast; a stale state file then stops it.
        let mut c = T::new(&[], good_state());
        assert_eq!(c.code(&pair()), "ok");
        assert!(c.s.may_broadcast());
        c.clock.store(NOW_MS + 10_001, Ordering::Relaxed);
        assert!(!c.s.may_broadcast(), "stale state: no broadcast");
        // Practice doesn't need Node's agreement (never broadcasts).
        assert_eq!(T::new(&[("FASTLANE", "practice")], NodeState { rust_sender: false, ..good_state() }).code(&pair()), "ok");
    }

    #[test]
    fn kill_switch_file_env_and_node() {
        let mut t = T::new(&[], good_state());
        std::fs::write(t.dir.join("KILL"), b"").unwrap();
        assert_eq!(t.code(&pair()), "kill");
        assert!(!t.s.may_broadcast(), "kill stops broadcast at once");
        std::fs::remove_file(t.dir.join("KILL")).unwrap();
        assert_eq!(t.code(&pair()), "ok");
        assert_eq!(T::new(&[("KILL_SWITCH", "on")], good_state()).code(&pair()), "kill");
        assert_eq!(T::new(&[], NodeState { killed: true, ..good_state() }).code(&pair()), "kill");
    }

    // Oct 28 (owner: "I want to score trades"): practice scores while the
    // Node bot is paused; live is unchanged; the setting can turn it off.
    #[test]
    fn practice_scores_while_paused_live_does_not() {
        let pr = [("FASTLANE", "practice"), ("RUST_SENDER", "off")];
        // Kill file on: practice passes (and counts it), never may broadcast.
        let mut t = T::new(&pr, good_state());
        std::fs::write(t.dir.join("KILL"), b"").unwrap();
        assert_eq!(t.code(&pair()), "ok");
        assert_eq!(t.s.paused_passes, 1);
        assert!(!t.s.may_broadcast(), "practice never broadcasts, kill or not");
        // KILL_SWITCH=on and Node's state saying killed: same.
        assert_eq!(T::new(&[pr[0], pr[1], ("KILL_SWITCH", "on")], good_state()).code(&pair()), "ok");
        assert_eq!(T::new(&pr, NodeState { killed: true, ..good_state() }).code(&pair()), "ok");
        // Not paused: passes without counting.
        let mut n = T::new(&pr, good_state());
        assert_eq!(n.code(&pair()), "ok");
        assert_eq!(n.s.paused_passes, 0);
        // Setting off: practice obeys the kill switch again (old behaviour).
        let mut o = T::new(&[pr[0], pr[1], ("FASTLANE_PRACTICE_SCORE_PAUSED", "off")], good_state());
        std::fs::write(o.dir.join("KILL"), b"").unwrap();
        assert_eq!(o.code(&pair()), "kill");
        // LIVE: the setting changes nothing; the kill switch always blocks.
        let mut l = T::new(&[("FASTLANE_PRACTICE_SCORE_PAUSED", "on")], good_state());
        std::fs::write(l.dir.join("KILL"), b"").unwrap();
        assert_eq!(l.code(&pair()), "kill");
        assert!(!l.s.may_broadcast());
        assert_eq!(T::new(&[("FASTLANE_PRACTICE_SCORE_PAUSED", "on")], NodeState { killed: true, ..good_state() }).code(&pair()), "kill");
        assert!(l.s.kill_blocks_practice(), "live: kill always blocks");
    }

    #[test]
    fn bad_settings_block_everything() {
        assert_eq!(T::new(&[("MAX_TRADE_USD", "5,000")], good_state()).code(&pair()), "bad_setting");
        assert_eq!(T::new(&[("DAILY_LOSS_CAP_USD", "0")], good_state()).code(&pair()), "bad_setting");
        assert_eq!(T::new(&[], NodeState { problems: vec!["MAX_SENDS_PER_MIN=NaN".into()], ..good_state() }).code(&pair()), "bad_setting");
    }

    #[test]
    fn stale_or_missing_state_blocks() {
        let mut t = T::new(&[], good_state());
        t.clock.store(NOW_MS + 10_001, Ordering::Relaxed);
        assert_eq!(t.code(&pair()), "state");
        std::fs::remove_file(t.dir.join("state.json")).unwrap();
        t.clock.store(NOW_MS, Ordering::Relaxed);
        assert_eq!(t.code(&pair()), "state");
    }

    #[test]
    fn opportunity_age() {
        let mut t = T::new(&[], good_state());
        let mut o = pair();
        o.found_at = Instant::now();
        // check at found_at + 200 ms
        t.s.state.refresh(Instant::now(), true);
        let r = t.s.check(&o, o.found_at + Duration::from_millis(200));
        assert_eq!(r.unwrap_err().code, "stale");
    }

    #[test]
    fn size_and_min_net() {
        let mut t = T::new(&[], good_state());
        assert_eq!(t.code(&SafetyInput { size_usd: 0.0, ..pair() }), "no_size");
        assert_eq!(t.code(&SafetyInput { size_usd: 20_001.0, expected_net_usd: 1.0, ..pair() }), "max_trade");
        let mut t2 = T::new(&[], NodeState { limits: NodeLimits { max_trade_usd: Some(400.0), ..Default::default() }, ..good_state() });
        assert_eq!(t2.code(&pair()), "max_trade", "Node's stricter limit wins");
        assert_eq!(t.code(&SafetyInput { expected_net_usd: 0.24, ..pair() }), "min_net");
        assert_eq!(T::new(&[("MIN_EXEC_NET_USD", "2")], good_state()).code(&pair()), "min_net");
    }

    #[test]
    fn outlier_and_implausible() {
        let mut t = T::new(&[], good_state());
        assert_eq!(t.code(&SafetyInput { expected_net_usd: 60.0, size_usd: 10_000.0, ..pair() }), "outlier");
        assert_eq!(t.code(&SafetyInput { expected_net_usd: 25.0, size_usd: 500.0, ..pair() }), "outlier", "over 2% and over $20");
        assert_eq!(t.code(&SafetyInput { expected_net_usd: 15.0, size_usd: 40.0, ..pair() }), "implausible");
        let mut off = T::new(&[("OUTLIER_GUARD", "0")], good_state());
        assert_eq!(off.code(&SafetyInput { expected_net_usd: 60.0, size_usd: 10_000.0, ..pair() }), "ok");
    }

    #[test]
    fn loss_cap_incl_pending_and_unpicked() {
        let mut t = T::new(&[], NodeState { loss_usd: 25.0, ..good_state() });
        assert_eq!(t.code(&pair()), "loss_cap");
        // Yesterday's loss doesn't count.
        let mut y = T::new(&[], NodeState { loss_usd: 25.0, loss_day: "2000-01-01".into(), ..good_state() });
        assert_eq!(y.code(&pair()), "ok");
        let mut p = T::new(&[], NodeState { loss_usd: 20.0, pending_usd: 5.0, ..good_state() });
        assert_eq!(p.code(&pair()), "loss_cap", "pending counts");
        // Our own send, not yet picked up by Node, counts until it is.
        let mut u = T::new(&[("MAX_SENDS_PER_MIN", "100"), ("GAP_SENT_POOL_HOLD_MS", "0")], NodeState { loss_usd: 24.0, ..good_state() });
        let o = SafetyInput { gas_usd: 0.6, ..pair() };
        assert_eq!(u.code(&o), "ok");
        u.s.record_send(&o, o.found_at, 1);
        assert_eq!(u.code(&o), "loss_cap");
        u.put(&NodeState { loss_usd: 24.0, ack_seq: 1, ..good_state() });
        assert_eq!(u.code(&o), "ok", "Node picked it up (its pending covers it now)");
    }

    #[test]
    fn held_gas_released_by_seq_not_time() {
        // Three sends in the same millisecond (seq 1, 2, 3): $0.40 held each (2x gas).
        let mut u = T::new(&[("MAX_SENDS_PER_MIN", "100"), ("GAP_SENT_POOL_HOLD_MS", "0")], NodeState { loss_usd: 24.0, ..good_state() });
        let o = SafetyInput { gas_usd: 0.2, ..pair() };
        for seq in 1..=3 {
            u.s.record_send(&o, o.found_at, seq);
        }
        assert_eq!(u.code(&o), "loss_cap", "24 + 1.20 held >= 25");
        // Node acked seq 2 only: seq 3 stays held (a time mark would have freed all three).
        u.put(&NodeState { loss_usd: 24.6, ack_seq: 2, ..good_state() });
        assert_eq!(u.code(&o), "loss_cap", "24.6 + 0.40 (seq 3) >= 25");
        u.put(&NodeState { loss_usd: 24.6, ack_seq: 3, ..good_state() });
        assert_eq!(u.code(&o), "ok", "all acked: Node's own figures cover them");
        // Out of order: a later ack can never un-release (released entries are gone).
        u.put(&NodeState { loss_usd: 24.6, ack_seq: 1, ..good_state() });
        assert_eq!(u.code(&o), "ok");
    }

    #[test]
    fn allowlist_and_auto_vet() {
        let mut t = T::new(&[], good_state());
        assert_eq!(t.code(&SafetyInput { tokens: vec!["0xusdg".into(), "0xnope".into()], ..pair() }), "allowlist");
        let mut a = T::new(&[], NodeState { auto_vetted: vec!["0xCOIN".into()], ..good_state() });
        assert_eq!(a.code(&pair()), "auto_vet", "$500 over the $300 auto-vet limit");
        assert_eq!(a.code(&SafetyInput { size_usd: 300.0, ..pair() }), "ok");
    }

    #[test]
    fn pools_cleared_and_pair_blocks() {
        let mut t = T::new(&[], NodeState { live_pools: vec!["0xp1".into()], ..good_state() });
        assert_eq!(t.code(&pair()), "pool_not_live");
        let fb = NodeState { fail_blocks: vec![("0xp2".into(), "0xp1".into(), NOW_MS + 1_000, "failed".into())], ..good_state() };
        assert_eq!(T::new(&[], fb.clone()).code(&pair()), "pair_fail_block");
        let lb = NodeState { live_blocks: vec![("0xp1".into(), "0xp2".into(), NOW_MS + 1_000, "lost".into())], ..good_state() };
        assert_eq!(T::new(&[], lb.clone()).code(&pair()), "ok", "6 h list off by default (like standing gaps)");
        assert_eq!(T::new(&[("FASTLANE_LIVE_BLOCKS", "on")], lb).code(&pair()), "pair_live_block");
    }

    #[test]
    fn scoreboard_and_loop_limits() {
        assert_eq!(T::new(&[], NodeState { paused: Paused { gap: Some("lost".into()), r#loop: None, trig: None }, ..good_state() }).code(&pair()), "scoreboard");
        // Fire-first from Rust (fastlane/trigger.rs): its own pause, not the gap one.
        let trig = SafetyInput { trig: true, ..pair() };
        assert_eq!(T::new(&[], NodeState { paused: Paused { gap: Some("lost".into()), r#loop: None, trig: None }, ..good_state() }).code(&trig), "ok", "a gap pause does not stop fire-first");
        assert_eq!(T::new(&[], NodeState { paused: Paused { gap: None, r#loop: None, trig: Some("lost".into()) }, ..good_state() }).code(&trig), "scoreboard");
        assert_eq!(T::new(&[], NodeState { paused: Paused { gap: None, r#loop: None, trig: Some("lost".into()) }, ..good_state() }).code(&pair()), "ok", "and the fire-first pause does not stop gaps");
        let lp = SafetyInput::new(1, "loop".into(), "0xusdg".into(), vec!["0xusdg".into(), "0xcoin".into(), "0xweth".into()], vec!["0xp1".into(), "0xp2".into(), "0xp3".into()], 1_000, 500.0, 1.0, 0.05, Some("0xlender".into()), Instant::now());
        assert_eq!(T::new(&[], good_state()).code(&lp), "ok");
        assert_eq!(T::new(&[], NodeState { paused: Paused { gap: None, r#loop: Some("x".into()), trig: None }, ..good_state() }).code(&lp), "scoreboard");
        assert_eq!(T::new(&[], NodeState { loop_loss_usd: 1.96, ..good_state() }).code(&lp), "loop_loss_cap");
        assert_eq!(T::new(&[], NodeState { loop_paused: true, ..good_state() }).code(&lp), "loop_loss_cap");
        assert_eq!(T::new(&[("LOOP_LIVE_MAX_TRADE_USD", "400")], good_state()).code(&lp), "loop_max_trade");
        // Loop fail block on the closing pair (p3 -> p1).
        let fb = NodeState { fail_blocks: vec![("0xp3".into(), "0xp1".into(), NOW_MS + 1_000, "x".into())], ..good_state() };
        assert_eq!(T::new(&[], fb).code(&lp), "pair_fail_block");
    }

    #[test]
    fn pool_hold_and_rate_limit() {
        let mut t = T::new(&[("MAX_SENDS_PER_MIN", "2")], good_state());
        let o = pair();
        assert_eq!(t.code(&o), "ok");
        t.s.record_send(&o, o.found_at, 1);
        assert_eq!(t.code(&o), "pool_busy");
        // Other pools, same minute: rate limit after 2.
        let mut t2 = T::new(&[("MAX_SENDS_PER_MIN", "2"), ("GAP_SENT_POOL_HOLD_MS", "0")], good_state());
        let o2 = pair();
        t2.s.record_send(&o2, o2.found_at, 1);
        assert_eq!(t2.code(&o2), "ok");
        t2.s.record_send(&o2, o2.found_at, 2);
        assert_eq!(t2.code(&o2), "rate");
    }

    #[test]
    fn live_only_readiness_and_funding() {
        assert_eq!(T::new(&[], NodeState { live_ready: false, ..good_state() }).code(&pair()), "not_ready");
        assert_eq!(T::new(&[("FASTLANE", "practice")], NodeState { live_ready: false, ..good_state() }).code(&pair()), "ok");
        // Own money: too little, or an old read.
        assert_eq!(T::new(&[], good_state()).code(&SafetyInput { amount_in: 2_000_000_000, ..pair() }), "own_money");
        let old = NodeState { own_money: OwnMoney { read_ms: NOW_MS - 61_000, ..good_state().own_money }, ..good_state() };
        assert_eq!(T::new(&[], old).code(&pair()), "own_money");
        // Flash loan: approved lender only.
        assert_eq!(T::new(&[], good_state()).code(&SafetyInput { lender: Some("0xother".into()), ..pair() }), "lender");
        assert_eq!(T::new(&[], good_state()).code(&SafetyInput { lender: Some("0xLENDER".into()), ..pair() }), "ok");
    }

    #[test]
    fn utc_day_matches_node() {
        assert_eq!(utc_day(0), "1970-01-01");
        assert_eq!(utc_day(1_761_436_800_000), "2025-10-26");
        assert_eq!(utc_day(1_709_164_800_000), "2024-02-29");
    }
}
