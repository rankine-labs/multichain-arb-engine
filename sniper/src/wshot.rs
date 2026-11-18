// ============================================================================
// HOT-POOL WEBSOCKET WAKE-UP (run 12 plan B) + its FREE COST ESTIMATE.
//
// Plain English:
//   The paper trader finds swaps by asking the node "anything new?" every
//   0.4-1 s. The dex bot measured (docs/FAST_CHECK.md) that Chainstack's
//   WebSocket pushes a pool's events about as fast as the sequencer feed
//   (median 7 ms earlier) and it follows only ITS OWN pools that way
//   (copy 2), because Chainstack bills every pushed message as a request.
//   This file does the same for the sniper, for the few pools that matter:
//
//   1. HOT SET: pools with a swap or a rush in the last
//      SNIPER_WS_HOT_ACTIVE_MIN minutes (default 30) that already pass the
//      cheap filters (known and tradable, not blocklisted, V4 hook safe,
//      old enough for the min-age rule or the young-test window). Rushed
//      pools first (newest rush first), then the most recently traded.
//      Capped: SNIPER_WS_HOT_MAX_POOLS V3/V2 pools (default 200) and
//      SNIPER_WS_HOT_MAX_V4 V4 pool ids (default 200). Hard limit 1,000
//      each (the node's address/topic limit, dex bot PRs #210/#230); lists
//      are sent in pieces of at most 400 (the dex bot's proven size).
//   2. SUBSCRIBE (eth_subscribe "logs", SNIPER_RHC_WSS) to the Swap events
//      the trader already uses, filtered BY ADDRESS (V3 Swap, V2 Swap +
//      Sync) and, for V4 (one PoolManager for every pool), by topic1 =
//      pool id. Never an empty list (an empty filter would mean "the whole
//      chain").
//   3. RENEW when the hot set changes, at most every SNIPER_WS_HOT_RENEW_SECS
//      (default 30). Renewal is "make before break" on the same connection:
//      the new subscription is confirmed first, then the old one dropped,
//      so nothing is missed in between. Still, on EVERY renewal and every
//      reconnect a FILL-IN asks the HTTP node (eth_getLogs, same filters)
//      for the blocks since the last moment we were sure to be covered, so
//      no swap is lost (the dex bot's "fill-in", FAST_CHECK.md). Logs seen
//      twice (overlap, fill-in) are dropped by transaction hash + log index.
//   4. SAME PATH: every pushed log goes into the trader's normal swap
//      handling (same rush detector, filters and buy path), tagged source
//      "ws". The trader's dedupe (feedwake.rs Merge: transaction + pool)
//      counts each swap once whichever source showed it first. Normal node
//      polling keeps running as backup (SNIPER_RHC_POLL_MS_WHEN_WS can slow
//      it while the WebSocket is healthy; default: normal pace, because
//      rushes on pools that are not hot yet are only found by polling).
//      No message for SNIPER_WS_HOT_STALE_SECS (30; a keep-alive ping goes
//      out every 10 s, its answer counts) = stale: reconnect, and polling
//      is at normal pace until it is healthy again.
//   5. MEASURE: every pushed message is counted (and added to the node
//      request count: it is billed), projected per day; rushes first seen
//      by ws / poll / feed; ws lead over polling (p50/p95); renewals,
//      reconnects, fill-ins, fallbacks. Status line every minute and a
//      paper-report section.
//
//   FREE ESTIMATE (SNIPER_WS_HOT_ESTIMATE, default ON, costs nothing): from
//   the logs polling fetches anyway, count how many would match the current
//   hot set's subscription (one pushed message per log). Projected per day,
//   so we know the WebSocket bill BEFORE turning it on. Compared with the
//   spare node budget SNIPER_WS_HOT_BUDGET_DAY (default 300,000: Chainstack
//   plan ~650k a day, sniper today ~300-350k).
//
// Settings (all off unless stated):
//   SNIPER_WS_HOT=1                 turn the WebSocket on (needs SNIPER_RHC_WSS)
//   SNIPER_WS_HOT_ESTIMATE          free estimate (default 1 = on; 0 = off)
//   SNIPER_WS_HOT_MAX_POOLS         V3/V2 pools in the hot set (200, max 1000)
//   SNIPER_WS_HOT_MAX_V4            V4 pool ids in the hot set (200, max 1000)
//   SNIPER_WS_HOT_ACTIVE_MIN        "recent" window in minutes (30)
//   SNIPER_WS_HOT_RENEW_SECS        least time between renewals (30, min 1)
//   SNIPER_WS_HOT_STALE_SECS        silence that counts as stale (30)
//   SNIPER_WS_HOT_FILL_MAX_BLOCKS   longest fill-in (600 blocks, ~1 min);
//                                   older gaps are left to polling (counted)
//   SNIPER_WS_HOT_BUDGET_DAY        spare node requests a day (300000)
//   SNIPER_RHC_POLL_MS_WHEN_WS      node poll pace while healthy (0 = normal)
//
// Read-only: no keys, never sends a transaction, never prints a node link.
// ============================================================================
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::fourmeme::hex_u64;
use crate::rhc::V4_POOL_MANAGER;
use crate::sellcheck::Rpc;

/// The run-folder file for this feature (stats, estimates, health changes).
pub const FILE: &str = "wshot.jsonl";
/// Most entries in one address or topic list (the node refuses 1,000+).
pub const HARD_MAX: usize = 1000;
/// Lists are sent in pieces of at most this many (dex bot: 400).
pub const CHUNK: usize = 400;
/// Keep-alive ping after this much silence.
const PING_EVERY: Duration = Duration::from_secs(10);
/// A renewal whose confirmation never comes is given up after this.
const RENEW_TIMEOUT: Duration = Duration::from_secs(10);
/// Wait this long before a fill-in, so the HTTP node has the newest blocks.
const FILL_DELAY: Duration = Duration::from_millis(1000);
/// Remember this many (transaction, log index) keys for dedupe.
const SEEN_CAP: usize = 100_000;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct WsHotCfg {
    pub on: bool,
    pub estimate: bool,
    pub max_pools: usize,
    pub max_v4: usize,
    pub active: Duration,
    pub renew_min: Duration,
    pub stale: Duration,
    pub fill_max_blocks: u64,
    pub budget_day: f64,
    /// Node poll pace while the WebSocket is healthy. None = normal pace.
    pub poll_when_ws: Option<Duration>,
}

impl WsHotCfg {
    /// Read the settings. `wss` = SNIPER_RHC_WSS is set. Returns the config
    /// and a warning to print, if any.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>, wss: bool) -> (Self, Option<String>) {
        let num = |k: &str, d: u64| get(k).and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(d);
        let flag = |k: &str, d: bool| match get(k).as_deref().map(str::trim) {
            Some("1") | Some("on") | Some("true") => true,
            Some("0") | Some("off") | Some("false") => false,
            _ => d,
        };
        let asked = flag("SNIPER_WS_HOT", false);
        let cfg = WsHotCfg {
            on: asked && wss,
            estimate: flag("SNIPER_WS_HOT_ESTIMATE", true),
            max_pools: (num("SNIPER_WS_HOT_MAX_POOLS", 200) as usize).min(HARD_MAX),
            max_v4: (num("SNIPER_WS_HOT_MAX_V4", 200) as usize).min(HARD_MAX),
            active: Duration::from_secs(num("SNIPER_WS_HOT_ACTIVE_MIN", 30).clamp(1, 24 * 60) * 60),
            renew_min: Duration::from_secs(num("SNIPER_WS_HOT_RENEW_SECS", 30).clamp(1, 3600)),
            stale: Duration::from_secs(num("SNIPER_WS_HOT_STALE_SECS", 30).clamp(2, 600)),
            fill_max_blocks: num("SNIPER_WS_HOT_FILL_MAX_BLOCKS", 600).clamp(1, 10_000),
            budget_day: num("SNIPER_WS_HOT_BUDGET_DAY", 300_000) as f64,
            poll_when_ws: Some(num("SNIPER_RHC_POLL_MS_WHEN_WS", 0)).filter(|m| *m > 0).map(|m| Duration::from_millis(m.clamp(100, 60_000))),
        };
        let warn = (asked && !wss).then(|| "SNIPER_WS_HOT=1 needs SNIPER_RHC_WSS (the paid WebSocket node); hot-pool WebSocket stays OFF".to_string());
        (cfg, warn)
    }

    pub fn from_env() -> (Self, Option<String>) {
        let wss = std::env::var("SNIPER_RHC_WSS").ok().is_some_and(|s| !s.trim().is_empty());
        Self::from_lookup(|k| std::env::var(k).ok(), wss)
    }

    /// Either part needs the hot set worked out.
    pub fn needs_hot_set(&self) -> bool {
        self.on || self.estimate
    }
}

// ---------------------------------------------------------------------------
// Hot set
// ---------------------------------------------------------------------------

/// The pools to subscribe to: V3/V2 addresses and V4 pool ids (lowercase).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HotSet {
    pub addrs: BTreeSet<String>,
    pub v4: BTreeSet<String>,
}

impl HotSet {
    pub fn is_empty(&self) -> bool {
        self.addrs.is_empty() && self.v4.is_empty()
    }
    pub fn len(&self) -> usize {
        self.addrs.len() + self.v4.len()
    }
    pub fn contains(&self, key: &str) -> bool {
        let k = key.to_ascii_lowercase();
        self.addrs.contains(&k) || self.v4.contains(&k)
    }
    /// Every key (addresses and ids), for the trader's coverage counters.
    pub fn keys(&self) -> HashSet<String> {
        self.addrs.iter().chain(self.v4.iter()).cloned().collect()
    }
}

/// One pool the trader saw recently, with what the cheap filters need.
#[derive(Clone, Debug, PartialEq)]
pub struct Cand {
    pub key: String,
    pub v4: bool,
    pub last_swap_ms: u64,
    pub last_rush_ms: Option<u64>,
    /// Pool age in seconds if known (seen created, or looked up before).
    pub age_s: Option<f64>,
    pub blocked: bool,
    pub unsafe_hook: bool,
}

/// The cheap-filter rules and caps for the hot set.
#[derive(Clone, Debug, PartialEq)]
pub struct HotRules {
    pub window_ms: u64,
    /// SNIPER_MIN_POOL_AGE_SECS (0 = no age rule).
    pub min_age_s: f64,
    /// Young-pool test on: pools at least this old also count (its window).
    pub young_min_age_s: Option<f64>,
    pub max_pools: usize,
    pub max_v4: usize,
}

/// Would a rush on this pool get past the cheap filters (no node calls)?
/// An unknown age only passes when there is no age rule (safe side).
pub fn passes(c: &Cand, r: &HotRules, now_ms: u64) -> bool {
    let recent = now_ms.saturating_sub(c.last_swap_ms.max(c.last_rush_ms.unwrap_or(0))) <= r.window_ms;
    if !recent || c.blocked || c.unsafe_hook {
        return false;
    }
    if r.min_age_s <= 0.0 {
        return true;
    }
    match c.age_s {
        None => false,
        Some(a) => a >= r.min_age_s || r.young_min_age_s.is_some_and(|y| a >= y),
    }
}

/// Pick the hot set: candidates that pass, rushed pools first (newest rush
/// first), then the most recently traded; capped per kind.
pub fn select_hot(cands: &[Cand], r: &HotRules, now_ms: u64) -> HotSet {
    let mut ok: Vec<&Cand> = cands.iter().filter(|c| passes(c, r, now_ms)).collect();
    let rush_recent = |c: &Cand| c.last_rush_ms.filter(|t| now_ms.saturating_sub(*t) <= r.window_ms);
    ok.sort_by(|a, b| {
        rush_recent(b).is_some().cmp(&rush_recent(a).is_some()).then(rush_recent(b).cmp(&rush_recent(a))).then(b.last_swap_ms.cmp(&a.last_swap_ms)).then(a.key.cmp(&b.key))
    });
    let mut h = HotSet::default();
    for c in ok {
        let k = c.key.to_ascii_lowercase();
        if c.v4 {
            if h.v4.len() < r.max_v4.min(HARD_MAX) {
                h.v4.insert(k);
            }
        } else if h.addrs.len() < r.max_pools.min(HARD_MAX) {
            h.addrs.insert(k);
        }
    }
    h
}

/// Recent swap / rush times per pool (kept by the trader).
#[derive(Default)]
pub struct Activity {
    map: HashMap<String, (u64, Option<u64>)>,
}

impl Activity {
    pub fn note_swap(&mut self, key: &str, t_ms: u64) {
        let e = self.map.entry(key.to_ascii_lowercase()).or_insert((t_ms, None));
        e.0 = e.0.max(t_ms);
    }
    pub fn note_rush(&mut self, key: &str, t_ms: u64) {
        let e = self.map.entry(key.to_ascii_lowercase()).or_insert((t_ms, None));
        e.1 = Some(e.1.map_or(t_ms, |r| r.max(t_ms)));
    }
    /// Forget pools quiet for longer than the window.
    pub fn prune(&mut self, now_ms: u64, window_ms: u64) {
        self.map.retain(|_, (s, r)| now_ms.saturating_sub((*s).max(r.unwrap_or(0))) <= window_ms);
    }
    pub fn iter(&self) -> impl Iterator<Item = (&String, &(u64, Option<u64>))> {
        self.map.iter()
    }
    pub fn len(&self) -> usize {
        self.map.len()
    }
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

/// Renew now? Only when the wanted set differs from the live one and the
/// last subscription is at least `min_gap` old (no churn on a busy list).
pub fn renew_due(wanted: &HotSet, live: &HotSet, since_last_sub: Duration, min_gap: Duration) -> bool {
    wanted != live && since_last_sub >= min_gap
}

// ---------------------------------------------------------------------------
// Subscription filters
// ---------------------------------------------------------------------------

/// The event ids for one subscription: V3 Swap / V2 Swap / V2 Sync by
/// address, and the V4 Swap id (filtered by pool id) if V4 is traded.
#[derive(Clone, Debug, PartialEq)]
pub struct Topics {
    pub by_addr: Vec<String>,
    pub v4_swap: Option<String>,
}

impl Topics {
    /// From the trader's topic list (paper.rs topics_for).
    pub fn from_paper(t: &[(String, crate::paper::LogKind)]) -> Self {
        use crate::paper::LogKind as K;
        Topics {
            by_addr: t.iter().filter(|(_, k)| matches!(k, K::V3Swap | K::V2Swap | K::V2Sync)).map(|(t, _)| t.clone()).collect(),
            v4_swap: t.iter().find(|(_, k)| *k == K::V4Swap).map(|(t, _)| t.clone()),
        }
    }
}

/// The eth_subscribe "logs" / eth_getLogs filters for a hot set: address
/// lists and V4 id lists in pieces of at most `chunk`. Empty lists give no
/// filter at all (never "the whole chain").
pub fn filters(set: &HotSet, t: &Topics, chunk: usize) -> Vec<Value> {
    let mut out = Vec::new();
    let chunk = chunk.clamp(1, HARD_MAX);
    if !t.by_addr.is_empty() {
        let a: Vec<&String> = set.addrs.iter().collect();
        for part in a.chunks(chunk) {
            out.push(json!({"address": part, "topics": [t.by_addr]}));
        }
    }
    if let Some(v4) = &t.v4_swap {
        let ids: Vec<&String> = set.v4.iter().collect();
        for part in ids.chunks(chunk) {
            out.push(json!({"address": V4_POOL_MANAGER, "topics": [[v4], part]}));
        }
    }
    out
}

/// Would this log be pushed by the hot set's subscription? (Used by the
/// free estimate, on logs polling fetched anyway.)
pub fn would_push(log: &Value, set: &HotSet, t: &Topics) -> bool {
    let Some(t0) = log["topics"][0].as_str().map(str::to_ascii_lowercase) else { return false };
    let addr = log["address"].as_str().unwrap_or("").to_ascii_lowercase();
    if t.by_addr.iter().any(|x| x.eq_ignore_ascii_case(&t0)) {
        return set.addrs.contains(&addr);
    }
    if t.v4_swap.as_deref().is_some_and(|x| x.eq_ignore_ascii_case(&t0)) && addr == V4_POOL_MANAGER {
        return log["topics"][1].as_str().is_some_and(|id| set.v4.contains(&id.to_ascii_lowercase()));
    }
    false
}

// ---------------------------------------------------------------------------
// Dedupe and fill-in planning
// ---------------------------------------------------------------------------

/// (transaction hash, log index) keys already handed to the trader.
pub struct SeenLogs {
    set: HashSet<(String, u64)>,
    order: VecDeque<(String, u64)>,
    cap: usize,
}

impl SeenLogs {
    pub fn new(cap: usize) -> Self {
        SeenLogs { set: HashSet::new(), order: VecDeque::new(), cap: cap.max(1) }
    }
    /// True = first time (hand it over); false = a repeat (drop it).
    pub fn first_time(&mut self, log: &Value) -> bool {
        let k = (log["transactionHash"].as_str().unwrap_or("").to_ascii_lowercase(), hex_u64(log.get("logIndex")));
        if self.set.contains(&k) {
            return false;
        }
        if self.order.len() >= self.cap {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
        self.set.insert(k.clone());
        self.order.push_back(k);
        true
    }
}

/// The fill-in range: from `from` to the HTTP node's `head`, at most `max`
/// blocks (the newest part is kept; older blocks are left to polling).
/// None = nothing to fill. The bool = the gap was longer than `max`.
pub fn fill_range(from: u64, head: u64, max: u64) -> Option<(u64, u64, bool)> {
    if from > head {
        return None;
    }
    let max = max.max(1);
    if head - from + 1 > max {
        Some((head + 1 - max, head, true))
    } else {
        Some((from, head, false))
    }
}

// ---------------------------------------------------------------------------
// Free estimate
// ---------------------------------------------------------------------------

/// Counts polled logs the current hot set's subscription would have pushed.
pub struct Estimator {
    pub started: Instant,
    pub matched: u64,
    /// (when, matched so far) about once a minute, for a recent rate.
    marks: VecDeque<(Instant, u64)>,
}

impl Default for Estimator {
    fn default() -> Self {
        Estimator { started: Instant::now(), matched: 0, marks: VecDeque::new() }
    }
}

impl Estimator {
    pub fn count(&mut self, logs: &[Value], set: &HotSet, t: &Topics) {
        self.matched += logs.iter().filter(|l| would_push(l, set, t)).count() as u64;
    }
    /// Per day since it started.
    pub fn per_day(&self) -> Option<f64> {
        per_day(self.matched, self.started.elapsed())
    }
    /// Per day over (about) the last 10 minutes.
    pub fn recent_per_day(&mut self) -> Option<f64> {
        let now = Instant::now();
        self.marks.push_back((now, self.matched));
        while self.marks.len() > 2 && self.marks.front().is_some_and(|(t, _)| now.duration_since(*t) > Duration::from_secs(600)) {
            self.marks.pop_front();
        }
        let (t0, m0) = *self.marks.front()?;
        per_day(self.matched - m0, now.duration_since(t0))
    }
}

/// n events over `d`, projected to a day. None until 30 s have passed.
pub fn per_day(n: u64, d: Duration) -> Option<f64> {
    let s = d.as_secs_f64();
    (s >= 30.0).then(|| n as f64 / s * 86_400.0)
}

// ---------------------------------------------------------------------------
// Shared state between the WebSocket thread and the trader
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct Counters {
    /// Every data message the node pushed us (notifications and replies).
    pub messages: AtomicU64,
    pub logs: AtomicU64,
    pub dup_dropped: AtomicU64,
    pub sessions: AtomicU64,
    pub connect_errors: AtomicU64,
    pub renewals: AtomicU64,
    pub renew_errors: AtomicU64,
    pub stale_drops: AtomicU64,
    pub fills: AtomicU64,
    pub fill_logs: AtomicU64,
    pub fill_errors: AtomicU64,
    pub fill_cut: AtomicU64,
    pub sub_errors: AtomicU64,
}

pub struct Shared {
    pub born: Instant,
    /// What the trader wants subscribed (version bumps on every change).
    want: Mutex<(u64, HotSet)>,
    /// What is confirmed live right now.
    live: Mutex<HotSet>,
    pub subscribed: AtomicBool,
    /// ms (since `born`) of the last message or keep-alive answer.
    pub last_alive_ms: AtomicU64,
    /// Newest block the trader knows (from polling): where a fill-in starts.
    pub head_hint: AtomicU64,
    /// ms the first subscription went live (0 = never): for per-day rates.
    pub first_live_ms: AtomicU64,
    pub c: Counters,
    pub stop: Arc<AtomicBool>,
}

impl Shared {
    /// `born` = the trader's shared clock start (so "seen at" times of every
    /// source compare directly).
    pub fn new(stop: Arc<AtomicBool>, born: Instant) -> Arc<Self> {
        Arc::new(Shared {
            born,
            want: Mutex::new((0, HotSet::default())),
            live: Mutex::new(HotSet::default()),
            subscribed: AtomicBool::new(false),
            last_alive_ms: AtomicU64::new(0),
            head_hint: AtomicU64::new(0),
            first_live_ms: AtomicU64::new(0),
            c: Counters::default(),
            stop,
        })
    }
    pub fn now_ms(&self) -> u64 {
        self.born.elapsed().as_millis() as u64
    }
    /// The trader's new wish. Returns true if it changed.
    pub fn set_wanted(&self, h: HotSet) -> bool {
        let mut w = self.want.lock().unwrap();
        if w.1 == h {
            return false;
        }
        w.0 += 1;
        w.1 = h;
        true
    }
    pub fn wanted(&self) -> (u64, HotSet) {
        self.want.lock().unwrap().clone()
    }
    pub fn live(&self) -> HotSet {
        self.live.lock().unwrap().clone()
    }
    fn set_live(&self, h: HotSet) {
        *self.live.lock().unwrap() = h;
    }
    fn alive(&self) {
        self.last_alive_ms.store(self.now_ms(), Ordering::Relaxed);
    }
    /// Subscribed and something arrived within `stale`.
    pub fn healthy(&self, stale: Duration) -> bool {
        self.subscribed.load(Ordering::Relaxed) && self.now_ms().saturating_sub(self.last_alive_ms.load(Ordering::Relaxed)) <= stale.as_millis() as u64
    }
    /// Pushed messages projected per day (since the first subscription).
    pub fn messages_per_day(&self) -> Option<f64> {
        let f = self.first_live_ms.load(Ordering::Relaxed);
        if f == 0 {
            return None;
        }
        per_day(self.c.messages.load(Ordering::Relaxed), Duration::from_millis(self.now_ms().saturating_sub(f)))
    }
    pub fn json(&self) -> Value {
        let g = |a: &AtomicU64| a.load(Ordering::Relaxed);
        let live = self.live();
        let c = &self.c;
        json!({"messages": g(&c.messages), "messages_per_day": self.messages_per_day().map(f64::round), "logs": g(&c.logs), "dup_dropped": g(&c.dup_dropped),
               "sessions": g(&c.sessions), "connect_errors": g(&c.connect_errors), "renewals": g(&c.renewals), "renew_errors": g(&c.renew_errors),
               "sub_errors": g(&c.sub_errors), "stale_drops": g(&c.stale_drops), "fills": g(&c.fills), "fill_logs": g(&c.fill_logs),
               "fill_errors": g(&c.fill_errors), "fill_cut": g(&c.fill_cut), "live_pools": live.addrs.len(), "live_v4": live.v4.len(),
               "subscribed": self.subscribed.load(Ordering::Relaxed), "live_s": (self.now_ms().saturating_sub(g(&self.first_live_ms)) as f64 / 1000.0).round()})
    }
}

// ---------------------------------------------------------------------------
// The WebSocket thread
// ---------------------------------------------------------------------------

/// Tag a node log as ours and hand it over (if it is the first time).
fn hand_over(sh: &Shared, seen: &Mutex<SeenLogs>, out: &Sender<Value>, mut log: Value, fill: bool) {
    if !seen.lock().unwrap().first_time(&log) {
        sh.c.dup_dropped.fetch_add(1, Ordering::Relaxed);
        return;
    }
    log["_src"] = json!("ws");
    log["_seen_ms"] = json!(sh.now_ms());
    if fill {
        log["_fill"] = json!(true);
        sh.c.fill_logs.fetch_add(1, Ordering::Relaxed);
    } else {
        sh.c.logs.fetch_add(1, Ordering::Relaxed);
    }
    let _ = out.send(log);
}

/// FILL-IN: ask the HTTP node for this set's logs from block `from` to its
/// newest block (after a short wait so it has the newest blocks), in its own
/// thread so the WebSocket keeps being read meanwhile.
#[allow(clippy::too_many_arguments)]
fn spawn_fill(sh: Arc<Shared>, http: String, seen: Arc<Mutex<SeenLogs>>, out: Sender<Value>, set: HotSet, t: Topics, from: u64, max: u64) {
    std::thread::Builder::new()
        .name("wshot-fill".into())
        .spawn(move || {
            std::thread::sleep(FILL_DELAY);
            sh.c.fills.fetch_add(1, Ordering::Relaxed);
            let rpc = Rpc::new(&http);
            let head = match rpc.call("eth_blockNumber", json!([])) {
                Ok(v) => hex_u64(Some(&v)),
                Err(_) => {
                    sh.c.fill_errors.fetch_add(1, Ordering::Relaxed);
                    return;
                }
            };
            let Some((a, b, cut)) = fill_range(from, head, max) else { return };
            if cut {
                sh.c.fill_cut.fetch_add(1, Ordering::Relaxed);
            }
            for mut f in filters(&set, &t, CHUNK) {
                f["fromBlock"] = json!(format!("0x{a:x}"));
                f["toBlock"] = json!(format!("0x{b:x}"));
                match rpc.call("eth_getLogs", json!([f])) {
                    Ok(v) => {
                        let mut logs = v.as_array().cloned().unwrap_or_default();
                        logs.sort_by_key(|l| (hex_u64(l.get("blockNumber")), hex_u64(l.get("logIndex"))));
                        for l in logs {
                            hand_over(&sh, &seen, &out, l, true);
                        }
                    }
                    Err(_) => {
                        sh.c.fill_errors.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
        })
        .ok();
}

/// One subscription round: the filters sent for one version of the set.
struct Round {
    set: HotSet,
    /// request id -> waiting for its subscription id
    waiting: HashSet<u64>,
    /// subscription ids the node gave us
    ids: Vec<String>,
    asked_at: Instant,
    /// Block we were sure to be covered up to when this round was asked.
    from_hint: u64,
}

/// Start the WebSocket thread. Logs arrive on the returned channel.
pub fn spawn(url: String, http: String, cfg: WsHotCfg, topics: Topics, sh: Arc<Shared>) -> Receiver<Value> {
    let (tx, rx) = std::sync::mpsc::channel::<Value>();
    std::thread::Builder::new()
        .name("wshot".into())
        .spawn(move || run_thread(&url, &http, &cfg, &topics, sh, tx))
        .expect("wshot thread");
    rx
}

fn run_thread(url: &str, http: &str, cfg: &WsHotCfg, t: &Topics, sh: Arc<Shared>, out: Sender<Value>) {
    let seen = Arc::new(Mutex::new(SeenLogs::new(SEEN_CAP)));
    let mut backoff = Duration::from_secs(1);
    // Set when a live session ended: the next session fills in from here.
    let mut gap_from: Option<u64> = None;
    while !sh.stop.load(Ordering::Relaxed) {
        let (_, want) = sh.wanted();
        if want.is_empty() {
            // Nothing hot: no subscription at all (an empty filter would
            // mean the whole chain). Polling does everything meanwhile.
            std::thread::sleep(Duration::from_millis(500));
            continue;
        }
        let born = Instant::now();
        let r = session(url, http, cfg, t, &sh, &out, &seen, gap_from);
        sh.subscribed.store(false, Ordering::Relaxed);
        sh.set_live(HotSet::default());
        match r {
            Ok(was_live) | Err((was_live, _)) if was_live => {
                // Everything after the newest block we know may be missed now.
                gap_from = Some(sh.head_hint.load(Ordering::Relaxed).saturating_sub(2));
            }
            _ => {}
        }
        if let Err((_, e)) = &r {
            let shown = if e.contains("://") { crate::probe::redact(e) } else { e.clone() };
            eprintln!("paper: ws hot DOWN ({shown}); node polling covers meanwhile");
        }
        if sh.stop.load(Ordering::Relaxed) {
            break;
        }
        if born.elapsed() > Duration::from_secs(60) {
            backoff = Duration::from_secs(1);
        }
        std::thread::sleep(backoff);
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

type Ws = tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>;

/// Send one round of subscriptions for `set` (one per filter piece).
fn send_round(ws: &mut Ws, t: &Topics, set: HotSet, from_hint: u64, next_id: &mut u64) -> Result<Round, String> {
    let mut waiting = HashSet::new();
    for f in filters(&set, t, CHUNK) {
        let id = *next_id;
        *next_id += 1;
        waiting.insert(id);
        let req = json!({"jsonrpc": "2.0", "id": id, "method": "eth_subscribe", "params": ["logs", f]});
        ws.send(tungstenite::Message::text(req.to_string())).map_err(|e| format!("subscribe: {e}"))?;
    }
    Ok(Round { set, waiting, ids: Vec::new(), asked_at: Instant::now(), from_hint })
}

/// One connection. Ok(was_live) = ended on purpose (stop / nothing hot);
/// Err((was_live, why)) = dropped.
#[allow(clippy::too_many_arguments)]
fn session(url: &str, http: &str, cfg: &WsHotCfg, t: &Topics, sh: &Arc<Shared>, out: &Sender<Value>, seen: &Arc<Mutex<SeenLogs>>, gap_from: Option<u64>) -> Result<bool, (bool, String)> {
    use tungstenite::Message;
    let (mut ws, _) = tungstenite::connect(url).map_err(|e| {
        sh.c.connect_errors.fetch_add(1, Ordering::Relaxed);
        (false, format!("connect: {e}"))
    })?;
    crate::ws::set_timeout(&mut ws, Duration::from_millis(200));
    sh.c.sessions.fetch_add(1, Ordering::Relaxed);
    sh.alive();
    let mut next_id: u64 = 1;
    let mut live_ids: Vec<String> = Vec::new();
    let mut live_set = HotSet::default();
    let mut live = false;
    let mut last_sub = Instant::now();
    let mut last_ping = Instant::now();
    let mut last_msg = Instant::now();
    let (_, first) = sh.wanted();
    let mut round: Option<Round> = Some(send_round(&mut ws, t, first, gap_from.unwrap_or(0), &mut next_id).map_err(|e| (false, e))?);
    loop {
        if sh.stop.load(Ordering::Relaxed) {
            let _ = ws.close(None);
            return Ok(live);
        }
        match ws.read() {
            Ok(Message::Text(text)) => {
                sh.c.messages.fetch_add(1, Ordering::Relaxed);
                crate::sellcheck::count_calls(1); // each pushed message is billed
                sh.alive();
                last_msg = Instant::now();
                let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
                if v["method"] == "eth_subscription" {
                    let sid = v["params"]["subscription"].as_str().unwrap_or("");
                    let ours = live_ids.iter().any(|i| i == sid) || round.as_ref().is_some_and(|r| r.ids.iter().any(|i| i == sid));
                    if ours {
                        hand_over(sh, seen, out, v["params"]["result"].clone(), false);
                    }
                    continue;
                }
                let Some(id) = v["id"].as_u64() else { continue };
                let Some(r) = round.as_mut().filter(|r| r.waiting.contains(&id)) else { continue }; // unsubscribe replies
                r.waiting.remove(&id);
                match v["result"].as_str() {
                    Some(sid) => r.ids.push(sid.to_string()),
                    None => {
                        // Refused (too many entries, node trouble ...).
                        sh.c.sub_errors.fetch_add(1, Ordering::Relaxed);
                        let err = v["error"].to_string();
                        let r = round.take().unwrap();
                        if !live {
                            return Err((false, format!("node refused the subscription: {err}")));
                        }
                        // A refused renewal: keep the old one, drop what the
                        // new round got, try again after the rate limit.
                        sh.c.renew_errors.fetch_add(1, Ordering::Relaxed);
                        for sid in r.ids {
                            let _ = ws.send(Message::text(json!({"jsonrpc": "2.0", "id": 900_000 + next_id, "method": "eth_unsubscribe", "params": [sid]}).to_string()));
                            next_id += 1;
                        }
                        last_sub = Instant::now();
                        continue;
                    }
                }
                if !r.waiting.is_empty() {
                    continue;
                }
                // Round complete: it is live now. Drop the old subscriptions
                // (make before break), then fill in what may have been missed.
                let r = round.take().unwrap();
                for sid in std::mem::take(&mut live_ids) {
                    let _ = ws.send(Message::text(json!({"jsonrpc": "2.0", "id": 900_000 + next_id, "method": "eth_unsubscribe", "params": [sid]}).to_string()));
                    next_id += 1;
                }
                live_ids = r.ids;
                live_set = r.set.clone();
                sh.set_live(r.set.clone());
                live = true;
                sh.subscribed.store(true, Ordering::Relaxed);
                let _ = sh.first_live_ms.compare_exchange(0, sh.now_ms().max(1), Ordering::Relaxed, Ordering::Relaxed);
                // Fill-in: on a reconnect from where the old session ended,
                // on a renewal from where the renewal was asked. (A fresh
                // start has nothing to fill, hint 0: polling covered until now.)
                if r.from_hint > 0 {
                    spawn_fill(sh.clone(), http.to_string(), seen.clone(), out.clone(), r.set, t.clone(), r.from_hint, cfg.fill_max_blocks);
                }
            }
            Ok(Message::Pong(_)) => {
                sh.alive();
            }
            Ok(Message::Close(_)) => return Err((live, "closed by the node".into())),
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(e) => return Err((live, format!("read: {e}"))),
        }
        // ---- housekeeping ----
        if let Some(r) = &round {
            if r.asked_at.elapsed() > RENEW_TIMEOUT {
                if !live {
                    return Err((false, "no subscription confirmation".into()));
                }
                sh.c.renew_errors.fetch_add(1, Ordering::Relaxed);
                round = None;
                last_sub = Instant::now();
            }
        }
        if live && round.is_none() {
            let (_, want) = sh.wanted();
            if want.is_empty() {
                // Nothing hot any more: stop paying for pushes.
                let _ = ws.close(None);
                return Ok(true);
            }
            if renew_due(&want, &live_set, last_sub.elapsed(), cfg.renew_min) {
                sh.c.renewals.fetch_add(1, Ordering::Relaxed);
                last_sub = Instant::now();
                let hint = sh.head_hint.load(Ordering::Relaxed).saturating_sub(2);
                round = Some(send_round(&mut ws, t, want, hint, &mut next_id).map_err(|e| (live, e))?);
            }
        }
        if last_msg.elapsed() >= PING_EVERY && last_ping.elapsed() >= PING_EVERY {
            last_ping = Instant::now();
            let _ = ws.send(Message::Ping(Vec::new().into()));
        }
        if !sh.healthy(cfg.stale) && live {
            sh.c.stale_drops.fetch_add(1, Ordering::Relaxed);
            return Err((true, format!("nothing received for {} s", cfg.stale.as_secs())));
        }
    }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/// Report section from wshot.jsonl and the signals' source tags. Empty if
/// neither the estimate nor the WebSocket ever ran in this folder.
pub fn report_section(dir: &Path, sig: &[Value]) -> String {
    let lines: Vec<Value> = std::fs::read_to_string(dir.join(FILE)).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    if lines.is_empty() {
        return String::new();
    }
    let p = |v: &[f64], q: f64| crate::paper::pct(v, q).map_or("-".to_string(), |x| format!("{x:.0}"));
    let k = |x: f64| if x >= 10_000.0 { format!("{:.0}k", x / 1000.0) } else { format!("{x:.0}") };
    let mut t = String::from("hot-pool WebSocket (SNIPER_WS_HOT / SNIPER_WS_HOT_ESTIMATE):\n");
    if let Some(e) = lines.iter().rev().find(|l| l["ev"] == "estimate") {
        let pd = e["per_day"].as_f64();
        let budget = e["budget_day"].as_f64().unwrap_or(300_000.0);
        t += &format!(
            "  free estimate: the hot set ({} pools + {} V4 ids now) would push ~{} messages a day ({} matching logs in {:.1} h; last 10 min ~{}/day) | spare node budget {}/day: {}\n",
            e["pools"],
            e["v4"],
            pd.map_or("?".into(), k),
            e["matched"],
            e["secs"].as_f64().unwrap_or(0.0) / 3600.0,
            e["recent_per_day"].as_f64().map_or("?".into(), k),
            k(budget),
            match pd {
                Some(x) if x <= budget => "FITS",
                Some(_) => "does NOT fit",
                None => "too early to say",
            }
        );
    }
    let stats = lines.iter().rev().find(|l| l["ev"] == "stats");
    if let Some(s) = stats {
        let w = &s["ws"];
        t += &format!(
            "  live: {} pushed messages over {:.1} h = ~{}/day | {} log(s) handed over, {} repeat(s) dropped | renewals {} (refused {}), connections {} (failed {}), went quiet {} | fill-ins {} ({} logs, {} failed, {} longer than the limit)\n",
            w["messages"],
            w["live_s"].as_f64().unwrap_or(0.0) / 3600.0,
            w["messages_per_day"].as_f64().map_or("?".into(), k),
            w["logs"],
            w["dup_dropped"],
            w["renewals"],
            w["renew_errors"],
            w["sessions"],
            w["connect_errors"],
            w["stale_drops"],
            w["fills"],
            w["fill_logs"],
            w["fill_errors"],
            w["fill_cut"],
        );
        let m = &s["merge"];
        let g = |x: &str| m[x].as_u64().unwrap_or(0);
        t += &format!(
            "  swaps: ws pushed {} first | of {} polled swaps on subscribed pools ws had {} first ({}) | ws later than polling {} | swap-level ws lead over polling p50 {} ms p95 {} ms ({} swaps)\n",
            g("ws_swaps"),
            g("polled_ws_subscribed"),
            g("polled_ws_first"),
            if g("polled_ws_subscribed") > 0 { format!("{:.1}%", 100.0 * g("polled_ws_first") as f64 / g("polled_ws_subscribed") as f64) } else { "-".into() },
            g("ws_after_poll"),
            m["ws_lead_ms_p50"].as_f64().map_or("-".into(), |x| format!("{x:.0}")),
            m["ws_lead_ms_p95"].as_f64().map_or("-".into(), |x| format!("{x:.0}")),
            m["ws_leads"],
        );
    }
    // Rushes by the source that completed them (signals.jsonl "src").
    let rush_src = |s: &str| sig.iter().filter(|l| l.get("live_skip").is_none() && l["src"] == s).count();
    let (rw, rp, rf) = (rush_src("ws"), rush_src("poll"), rush_src("feed"));
    if rw + rp + rf > 0 {
        t += &format!("  rushes first seen by: ws {rw} | poll {rp} | feed {rf}\n");
    }
    // Rush leads (feedwake Merge events, written here or in feedwake.jsonl).
    let mut leads: Vec<Value> = lines.iter().filter(|l| l["ev"] == "rush_lead").cloned().collect();
    leads.extend(std::fs::read_to_string(dir.join(crate::feedwake::FILE)).unwrap_or_default().lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter(|l| l["ev"] == "rush_lead"));
    let ws_first: Vec<f64> = leads.iter().filter(|l| l["first"] == "ws").filter_map(|l| l["lead_ms"].as_f64()).collect();
    let ws_later = leads.iter().filter(|l| l["other"] == "ws").count();
    if !ws_first.is_empty() || ws_later > 0 {
        t += &format!(
            "  rush lead: ws first on {} rushes, ahead of the next source by p50 {} ms, p95 {} ms | ws later on {} rushes\n",
            ws_first.len(),
            p(&ws_first, 50.0),
            p(&ws_first, 95.0),
            ws_later
        );
    }
    let stale = lines.iter().filter(|l| l["ev"] == "stale").count();
    if stats.is_some() || stale > 0 {
        t += &format!("  fell back to normal polling {stale} time(s) (WebSocket not subscribed or quiet)\n");
    }
    let v: Vec<f64> = sig.iter().filter(|l| l["delay"]["src"] == "ws").filter_map(|l| l["delay"]["total_ms"].as_f64()).collect();
    if !v.is_empty() {
        t += &format!("  rush -> buy ready via ws: {} buys, p50 {} ms, p95 {} ms\n", v.len(), p(&v, 50.0), p(&v, 95.0));
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> HotRules {
        HotRules { window_ms: 60_000, min_age_s: 7200.0, young_min_age_s: None, max_pools: 2, max_v4: 1 }
    }
    fn cand(key: &str, v4: bool, swap: u64, rush: Option<u64>, age: Option<f64>) -> Cand {
        Cand { key: key.into(), v4, last_swap_ms: swap, last_rush_ms: rush, age_s: age, blocked: false, unsafe_hook: false }
    }

    #[test]
    fn settings_off_by_default_estimate_on() {
        let (c, w) = WsHotCfg::from_lookup(|_| None, true);
        assert!(!c.on && c.estimate && w.is_none());
        assert_eq!((c.max_pools, c.max_v4, c.renew_min, c.stale), (200, 200, Duration::from_secs(30), Duration::from_secs(30)));
        assert_eq!(c.poll_when_ws, None, "normal poll pace by default");
        let on = |k: &str| (k == "SNIPER_WS_HOT").then(|| "1".to_string());
        let (c, w) = WsHotCfg::from_lookup(on, false);
        assert!(!c.on && w.is_some(), "no WebSocket node: stays off, with a warning");
        assert!(WsHotCfg::from_lookup(on, true).0.on);
        let big = |k: &str| (k == "SNIPER_WS_HOT_MAX_POOLS" || k == "SNIPER_WS_HOT_MAX_V4").then(|| "5000".to_string());
        let c = WsHotCfg::from_lookup(big, true).0;
        assert_eq!((c.max_pools, c.max_v4), (1000, 1000), "never over the node's 1,000 limit");
        assert!(!WsHotCfg::from_lookup(|k| (k == "SNIPER_WS_HOT_ESTIMATE").then(|| "0".into()), true).0.estimate);
    }

    #[test]
    fn cheap_filters_decide_who_is_hot() {
        let r = rules();
        let now = 100_000;
        assert!(passes(&cand("a", false, now - 1000, None, Some(8000.0)), &r, now));
        assert!(!passes(&cand("a", false, now - 70_000, None, Some(8000.0)), &r, now), "quiet too long");
        assert!(passes(&cand("a", false, now - 70_000, Some(now - 10), Some(8000.0)), &r, now), "a recent rush keeps it hot");
        assert!(!passes(&cand("a", false, now, None, Some(100.0)), &r, now), "too young");
        assert!(!passes(&cand("a", false, now, None, None), &r, now), "age unknown with an age rule = not hot");
        let mut c = cand("a", false, now, None, Some(8000.0));
        c.blocked = true;
        assert!(!passes(&c, &r, now), "blocklisted");
        c.blocked = false;
        c.unsafe_hook = true;
        assert!(!passes(&c, &r, now), "unsafe V4 hook");
        let young = HotRules { young_min_age_s: Some(60.0), ..rules() };
        assert!(passes(&cand("a", false, now, None, Some(100.0)), &young, now), "young test window counts");
        assert!(!passes(&cand("a", false, now, None, Some(30.0)), &young, now));
        let no_rule = HotRules { min_age_s: 0.0, ..rules() };
        assert!(passes(&cand("a", false, now, None, None), &no_rule, now));
    }

    #[test]
    fn hot_set_rushes_first_then_newest_and_capped() {
        let now = 100_000;
        let c = vec![
            cand("0xOld", false, now - 50_000, None, Some(9000.0)),
            cand("0xNew", false, now - 100, None, Some(9000.0)),
            cand("0xRush", false, now - 40_000, Some(now - 30_000), Some(9000.0)),
            cand("0xYoung", false, now, Some(now), Some(10.0)),
            cand("0xv4a", true, now - 5, None, Some(9000.0)),
            cand("0xv4b", true, now - 1, None, Some(9000.0)),
        ];
        let h = select_hot(&c, &rules(), now);
        assert_eq!(h.addrs.iter().cloned().collect::<Vec<_>>(), vec!["0xnew", "0xrush"], "rush first, then newest; cap 2; old one cut");
        assert_eq!(h.v4.iter().cloned().collect::<Vec<_>>(), vec!["0xv4b"], "V4 cap 1: the newest");
        assert!(h.contains("0xRUSH") && !h.contains("0xyoung"));
        assert_eq!(h.len(), 3);
        // Caps never pass 1,000 even if asked.
        let many: Vec<Cand> = (0..1500).map(|i| cand(&format!("0x{i:040x}"), false, now, None, Some(9000.0))).collect();
        assert_eq!(select_hot(&many, &HotRules { max_pools: 5000, ..rules() }, now).addrs.len(), HARD_MAX);
    }

    #[test]
    fn activity_tracks_and_prunes() {
        let mut a = Activity::default();
        a.note_swap("0xA", 10);
        a.note_rush("0xa", 20);
        a.note_swap("0xB", 5);
        assert_eq!(a.iter().find(|(k, _)| *k == "0xa").map(|(_, v)| *v), Some((10, Some(20))));
        a.prune(1_000, 985);
        assert_eq!(a.len(), 1, "B (last seen 5) is past the window, A (rush 20) is not");
    }

    #[test]
    fn renewal_rate_limit() {
        let mut a = HotSet::default();
        a.addrs.insert("0x1".into());
        let mut b = a.clone();
        assert!(!renew_due(&a, &b, Duration::from_secs(999), Duration::from_secs(30)), "same set: never");
        b.addrs.insert("0x2".into());
        assert!(!renew_due(&b, &a, Duration::from_secs(29), Duration::from_secs(30)), "changed, but too soon");
        assert!(renew_due(&b, &a, Duration::from_secs(30), Duration::from_secs(30)));
    }

    #[test]
    fn filters_split_into_pieces_and_never_empty() {
        let t = Topics { by_addr: vec!["0xswap".into(), "0xsync".into()], v4_swap: Some("0xv4swap".into()) };
        assert!(filters(&HotSet::default(), &t, CHUNK).is_empty(), "empty set: no filter at all (never the whole chain)");
        let mut h = HotSet::default();
        for i in 0..900 {
            h.addrs.insert(format!("0x{i:040x}"));
        }
        h.v4.insert(format!("0x{}", "ab".repeat(32)));
        let f = filters(&h, &t, CHUNK);
        assert_eq!(f.len(), 4, "900 addresses = 400 + 400 + 100, plus one V4 filter");
        assert_eq!(f[0]["address"].as_array().unwrap().len(), 400);
        assert_eq!(f[2]["address"].as_array().unwrap().len(), 100);
        assert_eq!(f[0]["topics"], json!([["0xswap", "0xsync"]]));
        assert_eq!(f[3]["address"], json!(V4_POOL_MANAGER));
        assert_eq!(f[3]["topics"][0], json!(["0xv4swap"]));
        assert_eq!(f[3]["topics"][1].as_array().unwrap().len(), 1);
        // No V4 venue: no V4 filter.
        let t3 = Topics { v4_swap: None, ..t };
        assert_eq!(filters(&h, &t3, CHUNK).len(), 3);
    }

    #[test]
    fn dedupe_by_tx_and_log_index() {
        let mut s = SeenLogs::new(2);
        let l = |tx: &str, li: u64| json!({"transactionHash": tx, "logIndex": format!("0x{li:x}")});
        assert!(s.first_time(&l("0xAA", 1)));
        assert!(!s.first_time(&l("0xaa", 1)), "same log again (fill-in overlap)");
        assert!(s.first_time(&l("0xaa", 2)), "another log of the same tx is new");
        assert!(s.first_time(&l("0xbb", 1)));
        assert!(s.first_time(&l("0xaa", 1)), "oldest forgotten past the cap");
    }

    #[test]
    fn fill_range_limits() {
        assert_eq!(fill_range(100, 150, 600), Some((100, 150, false)));
        assert_eq!(fill_range(100, 1000, 600), Some((401, 1000, true)), "only the newest 600 blocks");
        assert_eq!(fill_range(200, 150, 600), None, "nothing missed yet");
        assert_eq!(fill_range(150, 150, 600), Some((150, 150, false)));
    }

    #[test]
    fn estimator_counts_what_the_subscription_would_push() {
        let t = Topics { by_addr: vec!["0xswap".into(), "0xsync".into()], v4_swap: Some("0xv4".into()) };
        let mut h = HotSet::default();
        h.addrs.insert("0xpool".into());
        h.v4.insert("0xid1".into());
        let logs = vec![
            json!({"address": "0xPOOL", "topics": ["0xSWAP"]}),                   // hot pool swap: yes
            json!({"address": "0xpool", "topics": ["0xsync"]}),                   // its V2 Sync: yes (also pushed)
            json!({"address": "0xother", "topics": ["0xswap"]}),                  // not hot
            json!({"address": "0xpool", "topics": ["0xcreated"]}),                // not a subscribed event
            json!({"address": V4_POOL_MANAGER, "topics": ["0xv4", "0xID1"]}),    // hot V4 id: yes
            json!({"address": V4_POOL_MANAGER, "topics": ["0xv4", "0xid2"]}),    // other V4 id
            json!({"address": "0xfake", "topics": ["0xv4", "0xid1"]}),            // not the PoolManager
        ];
        let mut e = Estimator::default();
        e.count(&logs, &h, &t);
        assert_eq!(e.matched, 3);
        assert_eq!(per_day(10, Duration::from_secs(10)), None, "too early");
        assert_eq!(per_day(100, Duration::from_secs(864)), Some(10_000.0));
    }

    #[test]
    fn report_section_reads_estimate_stats_and_sources() {
        let dir = std::env::temp_dir().join(format!("sniper-wshot-report-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let w = |v: Value| format!("{v}\n");
        let body = [
            w(json!({"ev": "estimate", "pools": 120, "v4": 30, "matched": 5000, "secs": 3600, "per_day": 120000.0, "recent_per_day": 130000.0, "budget_day": 300000.0})),
            w(json!({"ev": "stale"})),
            w(json!({"ev": "rush_lead", "first": "ws", "other": "poll", "lead_ms": 400.0})),
            w(json!({"ev": "stats", "ws": {"messages": 100, "live_s": 3600, "messages_per_day": 2400.0, "logs": 90, "dup_dropped": 4, "renewals": 3, "renew_errors": 0, "sessions": 2, "connect_errors": 0, "stale_drops": 1, "fills": 4, "fill_logs": 6, "fill_errors": 0, "fill_cut": 0},
                         "merge": {"ws_swaps": 80, "polled_ws_subscribed": 50, "polled_ws_first": 45, "ws_after_poll": 2, "ws_lead_ms_p50": 350.0, "ws_lead_ms_p95": 900.0, "ws_leads": 47}})),
        ]
        .concat();
        std::fs::write(dir.join(FILE), body).unwrap();
        let sig = vec![json!({"src": "ws", "delay": {"src": "ws", "total_ms": 60.0}}), json!({"src": "poll"}), json!({"src": "ws", "live_skip": "x"})];
        let r = report_section(&dir, &sig);
        assert!(r.contains("~120k messages a day") && r.contains("FITS"), "{r}");
        assert!(r.contains("100 pushed messages") && r.contains("fill-ins 4 (6 logs"), "{r}");
        assert!(r.contains("ws had 45 first (90.0%)") && r.contains("p50 350 ms"), "{r}");
        assert!(r.contains("rushes first seen by: ws 1 | poll 1 | feed 0"), "{r}");
        assert!(r.contains("ws first on 1 rushes, ahead of the next source by p50 400 ms"), "{r}");
        assert!(r.contains("fell back to normal polling 1 time(s)"), "{r}");
        assert!(r.contains("via ws: 1 buys"), "{r}");
        assert!(report_section(&dir.join("none"), &sig).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
