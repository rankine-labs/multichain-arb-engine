// ============================================================================
// FAST LANE A: THE PREDICTED COPY ("ahead").
//
// Plain English:
//   Copy 2 moves forward only when a block is FINISHED and the bot has
//   handed us that block's pool reports. The sequencer feed tells us the
//   same block's transactions earlier: each feed message (= one L2 block)
//   arrives with every signed transaction in it. Rivals take standing gaps
//   at the top of the NEXT block, so waiting for the reports is too late.
//
//   This file keeps a PREDICTED copy:
//     predicted = the newest confirmed copy-2 version
//               + every feed message after it, applied in order.
//   For each new feed message (block N right after the predicted tip):
//     1. Pick the transactions that can move our pools (see "WHICH
//        TRANSACTIONS WE RUN" below). The rest are skipped.
//     2. Run each picked one on the predicted copy with the chain's own
//        rules (check/ordered.rs, the same engine and the same best-effort
//        rules trigger-first checks use) and keep what it changed.
//     3. A transaction that can't be run exactly (a value our copy doesn't
//        hold, a Nitro built-in we don't imitate, ...) is NEVER guessed: we
//        find out which of our pools it touches (one more run in "collect"
//        mode that only records what it reads) plus the pools its target /
//        data name, and mark ONLY those pools "unsure": their values are
//        forgotten in the predicted copy (a check through them answers
//        unknown, missing is never zero) and they are listed as unsure.
//   When copy 2 confirms block N (its normal intake publishes a version),
//   we "rebase": drop predicted blocks <= N and re-apply the feed messages
//   after N on top of the new confirmed version (normally 1-3 blocks).
//
//   AGREEMENT (practice mode proof): when block N is confirmed and we had
//   predicted it, every pool that changed in either one is compared value
//   by value (a contract pool's own declared values; a V4 pool's 4 base
//   values in the PoolManager):
//     agree      same values
//     disagree   different values; split into
//                  missed  the confirmed block moved it, our prediction didn't
//                  phantom we moved it, the confirmed block didn't
//                  value   both moved it, to different values
//     unsure     we had marked it unsure
//   Counted per hour, with a few disagreement samples (pool + block), on
//   the hourly line and in status ("fastlaneAhead").
//
//   WHICH TRANSACTIONS WE RUN (cheap filter + what we learn):
//     - its target is one of our pool contracts or a V4 PoolManager
//     - its data names one of our pool contracts, one of our V4 pool ids,
//       or BOTH coins of one of our pools (router / aggregator calls carry
//       the path: pools or coins)
//     - its target is a "toucher": an address whose transaction moved one
//       of our pools before. Learned from our own runs AND from copy 2's
//       confirmed reports (RECENT MOVES: tx hash -> pools it moved). A
//       transaction we skipped that the confirmed reports say DID move our
//       pools is counted ("filterMissed") and its target is learned, so the
//       next trade through that router is run.
//     - FASTLANE_AHEAD_FILTER=all: simply every transaction.
//
//   NEVER asks the node: zero new node reads. A missing value marks the
//   pools that need it unsure; it is never fetched from here.
//
//   Cheap: the copy uses persistent maps (a fork is a pointer copy). Only
//   runs when FASTLANE is practice / live (default off: nothing here runs,
//   no thread, no memory). Bounded: at most FASTLANE_AHEAD_MAX_BLOCKS
//   predicted blocks (32); a confirmed copy further behind than that stops
//   the prediction ("behind": no tip) until it catches up.
//
// API (scanner and integration):
//   Ahead::on_feed_message(Arc<BinMsg>)            a new feed message
//   Ahead::on_confirmed(Confirmed, moved_by_tx)     copy 2 published a version
//   Ahead::tip() -> Option<Arc<AheadTip>>           the predicted tip:
//       block / seq, `view()` (strict StateRead, like every check's view),
//       `changed_pools` (by THIS message), `unsure_pools`, built_at, apply_us
//   Process-wide (the running sidecar): start(), global_tip(), status_json(),
//   feed_hook() (check/feedstore.rs), confirmed_hook() (copy2/intake.rs).
// ============================================================================
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use revm::primitives::{Address, B256, KECCAK_EMPTY, U256};
use revm::state::AccountInfo;
use serde_json::{json, Value};

use super::overlay::Overlay;
use crate::arb::BlockCtx;
use crate::check::feedstore::BinMsg;
use crate::check::moved::{v4_base, FollowedPool, MovedIndex};
use crate::check::ordered::{run_ordered_keep, Assume, OrderedPlan, PlanMsg, Provenance, Route};
use crate::check::rawtx::DecodedTx;
use crate::check::run::{CheckOptions, Session};
use crate::check::Overrides;
use crate::state::snap::{Snapshot, View};
use crate::state::{Lookup, StateDiff, StatePosition, StateRead};

// ---------------------------------------------------------------------------
// The FASTLANE switch (same words as fastlane/mode.rs, workstream D; parsed
// here too so this file never depends on that branch being merged).
// ---------------------------------------------------------------------------

/// FASTLANE setting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Nothing new runs (default).
    Off,
    /// Everything runs, nothing is broadcast.
    Practice,
    /// Real sends may happen (decided elsewhere).
    Live,
}

/// Parse FASTLANE. Unset / empty / unknown = off (the safe choice).
pub fn parse_mode(raw: Option<&str>) -> Mode {
    match raw.map(|s| s.trim().to_ascii_lowercase()).unwrap_or_default().as_str() {
        "practice" | "shadow" | "dry" => Mode::Practice,
        "live" => Mode::Live,
        _ => Mode::Off,
    }
}

/// FASTLANE of this process (read once).
pub fn mode() -> Mode {
    static M: OnceLock<Mode> = OnceLock::new();
    *M.get_or_init(|| parse_mode(std::env::var("FASTLANE").ok().as_deref()))
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// Knobs (env, read once at start).
#[derive(Clone, Debug)]
pub struct AheadCfg {
    /// FASTLANE_AHEAD_MAX_BLOCKS [32]: most predicted blocks kept; a
    /// confirmed copy further behind stops the prediction until it catches up.
    pub max_blocks: usize,
    /// FASTLANE_AHEAD_FILTER [smart]: "all" runs every feed transaction.
    pub run_all: bool,
    /// FASTLANE_AHEAD_MAX_TXS [256]: most transactions run per message
    /// (more = the message is "too big": prediction stops until confirmed).
    pub max_txs: usize,
    /// Most learned "toucher" addresses kept (oldest dropped).
    pub max_touchers: usize,
    /// Feed sequence number + this = L2 block number (mirror Config.l2_offset).
    pub l2_offset: u64,
}

impl Default for AheadCfg {
    fn default() -> Self {
        AheadCfg { max_blocks: 32, run_all: false, max_txs: 256, max_touchers: 4096, l2_offset: 0 }
    }
}

impl AheadCfg {
    /// From any key -> value lookup (tests pass a map).
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>, l2_offset: u64) -> AheadCfg {
        let d = AheadCfg::default();
        let num = |k: &str| get(k).and_then(|v| v.trim().parse::<usize>().ok());
        AheadCfg {
            max_blocks: num("FASTLANE_AHEAD_MAX_BLOCKS").filter(|v| (1..=1024).contains(v)).unwrap_or(d.max_blocks),
            run_all: get("FASTLANE_AHEAD_FILTER").is_some_and(|v| v.trim().eq_ignore_ascii_case("all")),
            max_txs: num("FASTLANE_AHEAD_MAX_TXS").filter(|v| (1..=100_000).contains(v)).unwrap_or(d.max_txs),
            max_touchers: d.max_touchers,
            l2_offset,
        }
    }
}

// ---------------------------------------------------------------------------
// Our pools, as the prediction needs them
// ---------------------------------------------------------------------------

/// Where one pool's own state lives (what is forgotten when it is unsure,
/// and what agreement compares).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Place {
    /// A pool contract: its declared values (slots below 2^32).
    Contract(Address),
    /// A V4 pool: its 4 base values (slot0, fee growth x2, liquidity) at
    /// base = keccak(id . 6) in the PoolManager.
    V4(Address, U256),
}

/// Declared variables of a pool contract: slots below this (check/moved.rs).
const DECLARED_MAX: u64 = 1 << 32;

/// The pools copy 2 follows, with the lookup tables the prediction uses.
#[derive(Default)]
pub struct PoolSet {
    /// Key (the bot's name) -> where its state is.
    places: HashMap<String, Place>,
    /// "Which pools did it move" (check/moved.rs, the same rules as
    /// trig_discover: only a pool's OWN state counts).
    moved: MovedIndex,
    /// Names our pools for the cheap filter (to / data).
    route: Route,
    /// Pool contract -> key.
    by_contract: HashMap<Address, String>,
    /// (PoolManager, a V4 pool's slot0 slot) -> key: a run that read it
    /// went through that pool.
    v4_slot0: HashMap<(Address, U256), String>,
    /// V4 pool id -> key.
    by_id: HashMap<B256, String>,
    /// Coin pair -> keys of our pools with those two coins.
    by_pair: HashMap<(Address, Address), Vec<String>>,
    /// Pools copy 2 itself can't vouch for right now (loading / unsure):
    /// always listed unsure in the predicted tip.
    pub not_ready: HashSet<String>,
}

impl PoolSet {
    /// `pools`: (followed pool, token0, token1). `not_ready`: keys of pools
    /// copy 2 has not got ready.
    pub fn build(pools: &[(FollowedPool, Address, Address)], not_ready: HashSet<String>) -> PoolSet {
        let followed: Vec<FollowedPool> = pools.iter().map(|p| p.0.clone()).collect();
        let mut s = PoolSet { moved: MovedIndex::build(&followed), not_ready, ..Default::default() };
        let mut pms: HashSet<Address> = HashSet::new();
        for (p, t0, t1) in pools {
            match p.v4_id {
                Some(id) => {
                    let base = v4_base(id);
                    s.places.insert(p.key.clone(), Place::V4(p.address, base));
                    s.v4_slot0.insert((p.address, base), p.key.clone());
                    s.by_id.insert(id, p.key.clone());
                    s.route.ids.push(id);
                    pms.insert(p.address);
                }
                None => {
                    s.places.insert(p.key.clone(), Place::Contract(p.address));
                    s.by_contract.insert(p.address, p.key.clone());
                    s.route.accounts.insert(p.address);
                    s.route.names.push(p.address);
                }
            }
            if !t0.is_zero() && !t1.is_zero() {
                let k = if t0 < t1 { (*t0, *t1) } else { (*t1, *t0) };
                let v = s.by_pair.entry(k).or_default();
                if !v.contains(&p.key) {
                    v.push(p.key.clone());
                    if v.len() == 1 {
                        s.route.pairs.push(k);
                    }
                }
            }
        }
        // A V4 PoolManager as a target = may touch our V4 pools.
        s.route.names.extend(pms);
        s
    }

    pub fn len(&self) -> usize {
        self.places.len()
    }

    pub fn is_empty(&self) -> bool {
        self.places.is_empty()
    }

    /// Our pools a transaction NAMES (target or data), without running it.
    fn named(&self, to: Option<Address>, data: &[u8]) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let has = |needle: &[u8]| !needle.is_empty() && data.len() >= needle.len() && data.windows(needle.len()).any(|w| w == needle);
        if let Some(t) = to {
            if let Some(k) = self.by_contract.get(&t) {
                out.push(k.clone());
            }
        }
        for (a, k) in &self.by_contract {
            if has(a.as_slice()) && !out.contains(k) {
                out.push(k.clone());
            }
        }
        for (id, k) in &self.by_id {
            if has(id.as_slice()) && !out.contains(k) {
                out.push(k.clone());
            }
        }
        for ((x, y), ks) in &self.by_pair {
            if has(x.as_slice()) && has(y.as_slice()) {
                for k in ks {
                    if !out.contains(k) {
                        out.push(k.clone());
                    }
                }
            }
        }
        out
    }

    /// Cheap filter, first part: could this transaction touch our pools?
    fn may_touch(&self, to: Option<Address>, data: &[u8]) -> bool {
        self.route.named_by(to, data)
    }

    /// Our pools behind the accounts / values a run read.
    fn touched_by(&self, accounts: &HashSet<Address>, slots: &HashSet<(Address, U256)>) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for a in accounts {
            if let Some(k) = self.by_contract.get(a) {
                if !out.contains(k) {
                    out.push(k.clone());
                }
            }
        }
        for (a, s) in slots {
            let k = self.by_contract.get(a).or_else(|| self.v4_slot0.get(&(*a, *s)));
            if let Some(k) = k {
                if !out.contains(k) {
                    out.push(k.clone());
                }
            }
        }
        out
    }

    /// The pools a set of changed values moved (no hash inputs: a V4 pool
    /// is named by its base values, which every swap changes).
    fn moved_by_diff(&self, d: &StateDiff) -> Vec<String> {
        let changed: Vec<(Address, U256)> = d.accounts.iter().flat_map(|(a, ad)| ad.storage.keys().map(move |s| (*a, *s))).collect();
        let mut out: Vec<String> = self.moved.moved(&changed, &[]).into_iter().map(|m| m.key).collect();
        // A contract pool that was dropped / recreated wholesale counts too.
        for (a, ad) in &d.accounts {
            if ad.forget || ad.storage_cleared {
                if let Some(k) = self.by_contract.get(a) {
                    if !out.contains(k) {
                        out.push(k.clone());
                    }
                }
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

/// One confirmed copy-2 version (what the rebase starts from).
#[derive(Clone)]
pub struct Confirmed {
    /// Feed sequence number of its block.
    pub seq: u64,
    pub snap: Arc<Snapshot>,
    /// Its block details (None: the copy can't answer at it, e.g. a block
    /// repaired from the node's logs; the prediction waits).
    pub ctx: Option<BlockCtx>,
    /// What this block changed (Version.diff): which pools moved in it.
    pub diff: Arc<StateDiff>,
    /// Which copy values are exact at this block (copy 2: Copy2Prov).
    pub prov: Arc<dyn Provenance + Send + Sync>,
}

/// The predicted tip (see the file header).
#[derive(Clone)]
pub struct AheadTip {
    /// Feed sequence number / L2 block number of the newest message applied.
    pub seq: u64,
    pub block: u64,
    /// The confirmed version it was built on.
    pub base_seq: u64,
    /// The predicted state after this block.
    pub snap: Arc<Snapshot>,
    /// This block's details (what a check run "at" the tip uses).
    pub ctx: BlockCtx,
    /// Our pools changed by THIS message (keys as the bot names them).
    pub changed_pools: Vec<String>,
    /// Our pools we can't vouch for in this predicted view (marked unsure
    /// by any message since the confirmed version, plus copy 2's own not
    /// ready pools). Their values are forgotten here (reads are Missing).
    pub unsure_pools: Vec<String>,
    /// When this tip was built.
    pub built_at: Instant,
    /// Microseconds spent applying THIS message.
    pub apply_us: u64,
}

impl AheadTip {
    /// A strict read-only view of the predicted state (same rules as every
    /// check's view: missing is never zero, inexact balances answer Missing).
    pub fn view(&self) -> View {
        View::new(self.snap.clone())
    }
}

/// One predicted block.
struct Entry {
    seq: u64,
    snap: Arc<Snapshot>,
    ctx: BlockCtx,
    /// Pools changed by this message.
    changed: Vec<String>,
    /// Pools changed by any message from the base up to this one.
    changed_cum: HashSet<String>,
    /// Pools unsure in this view (since the base).
    unsure_cum: HashSet<String>,
    /// Transactions skipped by the filter: (hash, target).
    skipped: Vec<(B256, Option<Address>)>,
    built_at: Instant,
    apply_us: u64,
}

/// Why prediction stopped (no tip until a rebase passes it).
#[derive(Clone, Debug)]
struct Stop {
    seq: u64,
    why: &'static str,
}

/// Counters for one hour (and the totals since start).
#[derive(Clone, Default)]
pub struct AheadStats {
    pub msgs: u64,
    pub applied: u64,
    pub late_msgs: u64,
    pub txs_run: u64,
    pub txs_skipped: u64,
    pub txs_failed: u64,
    /// Failed transactions that touched / named our pools (pools marked unsure).
    pub txs_marked: u64,
    /// Skipped transactions the confirmed reports say moved our pools.
    pub filter_missed: u64,
    pub assumed: u64,
    pub rebases: u64,
    pub reapplied: u64,
    pub agree: u64,
    pub disagree: u64,
    pub missed: u64,
    pub phantom: u64,
    pub value_diff: u64,
    pub unsure: u64,
    /// Confirmed blocks we had no prediction for.
    pub unpredicted: u64,
    pub stopped: HashMap<&'static str, u64>,
    pub apply_us: Vec<u64>,
    pub samples: Vec<Value>,
}

/// Disagreement samples kept per hour.
const MAX_SAMPLES: usize = 20;
/// apply_us samples kept per hour.
const MAX_TIMES: usize = 20_000;

impl AheadStats {
    fn stop(&mut self, why: &'static str) {
        *self.stopped.entry(why).or_default() += 1;
    }

    pub fn json(&self) -> Value {
        let mut t = self.apply_us.clone();
        json!({
            "msgs": self.msgs, "applied": self.applied, "lateMsgs": self.late_msgs,
            "txsRun": self.txs_run, "txsSkipped": self.txs_skipped, "txsFailed": self.txs_failed,
            "txsMarkedUnsure": self.txs_marked, "filterMissed": self.filter_missed, "assumed": self.assumed,
            "rebases": self.rebases, "reapplied": self.reapplied,
            "agree": self.agree, "disagree": self.disagree, "missed": self.missed, "phantom": self.phantom,
            "valueDiff": self.value_diff, "unsure": self.unsure, "unpredicted": self.unpredicted,
            "stopped": self.stopped.iter().map(|(k, v)| (k.to_string(), json!(v))).collect::<serde_json::Map<String, Value>>(),
            "applyUs": crate::timing::pct_of(&mut t),
            "samples": self.samples,
        })
    }

    /// The hourly line (timing.rs / bot style: one line, the numbers that matter).
    pub fn line(&self) -> String {
        let mut t = self.apply_us.clone();
        let p = crate::timing::pct_of(&mut t);
        let g = |k: &str| p.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
        let mut stops: Vec<String> = self.stopped.iter().map(|(k, v)| format!("{k}:{v}")).collect();
        stops.sort();
        format!(
            "[arbsim] fastlane ahead (last hour): msgs {} applied {} late {} | txs run {} skipped {} failed {} (pools unsure {}) filterMissed {} | apply us p50 {} p90 {} p99 {} max {} | rebases {} reapplied {} | agree {} disagree {} (missed {} phantom {} value {}) unsure {} unpredicted {} | stopped [{}]",
            self.msgs, self.applied, self.late_msgs, self.txs_run, self.txs_skipped, self.txs_failed, self.txs_marked, self.filter_missed,
            g("p50"), g("p90"), g("p99"), g("max"), self.rebases, self.reapplied,
            self.agree, self.disagree, self.missed, self.phantom, self.value_diff, self.unsure, self.unpredicted, stops.join(" "),
        )
    }

    fn add_time(&mut self, us: u64) {
        if self.apply_us.len() < MAX_TIMES {
            self.apply_us.push(us);
        }
    }
}

// ---------------------------------------------------------------------------
// The predicted copy
// ---------------------------------------------------------------------------

/// The predicted copy (see the file header). Single-threaded: the runtime
/// below owns one on its own thread; tests drive one directly.
pub struct Ahead {
    cfg: AheadCfg,
    pools: Arc<PoolSet>,
    base: Option<Confirmed>,
    /// Predicted blocks after the base, in order (seq base+1, base+2, ...).
    entries: VecDeque<Entry>,
    /// Feed messages after the base, by sequence number (bounded).
    msgs: BTreeMap<u64, Arc<BinMsg>>,
    stop: Option<Stop>,
    /// Learned addresses whose transactions moved our pools (-> when).
    touchers: HashMap<Address, Instant>,
    tip: Option<Arc<AheadTip>>,
    pub hour: AheadStats,
    pub total: AheadStats,
}

impl Ahead {
    pub fn new(cfg: AheadCfg) -> Self {
        Ahead {
            cfg,
            pools: Arc::new(PoolSet::default()),
            base: None,
            entries: VecDeque::new(),
            msgs: BTreeMap::new(),
            stop: None,
            touchers: HashMap::new(),
            tip: None,
            hour: AheadStats::default(),
            total: AheadStats::default(),
        }
    }

    /// The pools we follow (rebuilt by the caller when copy 2's registry changes).
    pub fn set_pools(&mut self, p: Arc<PoolSet>) {
        self.pools = p;
    }

    pub fn pools(&self) -> &PoolSet {
        &self.pools
    }

    /// The predicted tip: state after the NEWEST feed message held, or None
    /// (nothing predicted yet, waiting for a missing message, stopped).
    pub fn tip(&self) -> Option<Arc<AheadTip>> {
        self.tip.clone()
    }

    /// Predicted blocks held (bounded by max_blocks).
    pub fn depth(&self) -> usize {
        self.entries.len()
    }

    /// Feed messages held (bounded by max_blocks + a little).
    pub fn held_msgs(&self) -> usize {
        self.msgs.len()
    }

    /// The confirmed version's sequence number.
    pub fn base_seq(&self) -> Option<u64> {
        self.base.as_ref().map(|b| b.seq)
    }

    /// Why prediction is stopped, if it is.
    pub fn stopped(&self) -> Option<(u64, &'static str)> {
        self.stop.as_ref().map(|s| (s.seq, s.why))
    }

    /// Learned toucher addresses (status / tests).
    pub fn is_toucher(&self, a: &Address) -> bool {
        self.touchers.contains_key(a)
    }

    fn count(&mut self, f: impl Fn(&mut AheadStats)) {
        f(&mut self.hour);
        f(&mut self.total);
    }

    fn learn_toucher(&mut self, a: Address) {
        if self.touchers.len() >= self.cfg.max_touchers && !self.touchers.contains_key(&a) {
            // Drop the oldest quarter (bounded memory, cheap).
            let mut v: Vec<(Address, Instant)> = self.touchers.iter().map(|(a, t)| (*a, *t)).collect();
            v.sort_by_key(|x| x.1);
            for (x, _) in v.iter().take(self.cfg.max_touchers / 4 + 1) {
                self.touchers.remove(x);
            }
        }
        self.touchers.insert(a, Instant::now());
    }

    /// A new feed message (one L2 block).
    pub fn on_feed_message(&mut self, m: Arc<BinMsg>) {
        self.count(|s| s.msgs += 1);
        if let Some(b) = &self.base {
            if m.seq <= b.seq {
                // Copy 2 already confirmed it (the feed was slower this time).
                self.count(|s| s.late_msgs += 1);
                return;
            }
        }
        self.msgs.entry(m.seq).or_insert(m);
        self.trim_msgs();
        self.extend();
    }

    /// Bounded: keep only the newest messages (2 x max_blocks).
    fn trim_msgs(&mut self) {
        let cap = self.cfg.max_blocks * 2;
        while self.msgs.len() > cap {
            let Some(k) = self.msgs.keys().next().copied() else { break };
            self.msgs.remove(&k);
        }
    }

    /// Copy 2 published a version (normally block N's reports applied).
    /// `moved_by_tx`: copy 2's RECENT MOVES (tx hash -> pools its reports
    /// moved), to learn which skipped transactions we should have run.
    pub fn on_confirmed(&mut self, c: Confirmed, moved_by_tx: &dyn Fn(&B256) -> Option<Vec<String>>) {
        if let Some(b) = &self.base {
            if c.seq < b.seq {
                return;
            }
            if c.seq == b.seq && Arc::ptr_eq(&c.snap, &b.snap) {
                return;
            }
        }
        // (The very first version has nothing to compare with.)
        let first_time = self.base.as_ref().is_some_and(|b| c.seq > b.seq);
        if first_time {
            self.agreement(&c, moved_by_tx);
        }
        self.count(|s| s.rebases += 1);
        let seq = c.seq;
        self.base = Some(c);
        self.entries.clear();
        self.tip = None;
        self.stop = None;
        self.msgs = self.msgs.split_off(&(seq + 1));
        let before = self.hour.applied;
        self.extend();
        let n = self.hour.applied - before;
        self.count(|s| s.reapplied += n);
    }

    /// AGREEMENT (see the file header): our prediction for block c.seq vs
    /// the confirmed version, per pool that changed in either.
    fn agreement(&mut self, c: &Confirmed, moved_by_tx: &dyn Fn(&B256) -> Option<Vec<String>>) {
        let Some(i) = self.entries.iter().position(|e| e.seq == c.seq) else {
            self.count(|s| s.unpredicted += 1);
            return;
        };
        let pools = self.pools.clone();
        let conf_moved: HashSet<String> = pools.moved_by_diff(&c.diff).into_iter().collect();
        // Skipped transactions copy 2's reports say moved our pools: the
        // filter missed them. Learn their target for next time.
        let skipped = std::mem::take(&mut self.entries[i].skipped);
        for (h, to) in skipped {
            if moved_by_tx(&h).is_some_and(|p| !p.is_empty()) {
                self.count(|s| s.filter_missed += 1);
                if let Some(t) = to {
                    self.learn_toucher(t);
                }
            }
        }
        let e = &self.entries[i];
        let mut all: Vec<&String> = conf_moved.iter().chain(e.changed_cum.iter()).collect();
        all.sort();
        all.dedup();
        let mut res: Vec<(String, &'static str)> = Vec::new();
        for k in all {
            if e.unsure_cum.contains(k) {
                res.push((k.clone(), "unsure"));
                continue;
            }
            let Some(place) = pools.places.get(k) else { continue };
            let same = same_state(*place, &e.snap, &c.snap);
            let kind = match (same, conf_moved.contains(k), e.changed_cum.contains(k)) {
                (true, _, _) => "agree",
                (false, true, false) => "missed",
                (false, false, true) => "phantom",
                (false, _, _) => "value",
            };
            res.push((k.clone(), kind));
        }
        let block = c.seq + self.cfg.l2_offset;
        for (k, kind) in res {
            match kind {
                "agree" => self.count(|s| s.agree += 1),
                "unsure" => self.count(|s| s.unsure += 1),
                _ => {
                    self.count(|s| {
                        s.disagree += 1;
                        match kind {
                            "missed" => s.missed += 1,
                            "phantom" => s.phantom += 1,
                            _ => s.value_diff += 1,
                        }
                    });
                    if self.hour.samples.len() < MAX_SAMPLES {
                        self.hour.samples.push(json!({ "pool": k, "block": block, "kind": kind }));
                    }
                }
            }
        }
    }

    /// Apply every held message that follows the predicted tip.
    fn extend(&mut self) {
        let Some(base) = self.base.clone() else { return };
        if self.stop.is_some() {
            return;
        }
        loop {
            let tip_seq = self.entries.back().map_or(base.seq, |e| e.seq);
            let next = tip_seq + 1;
            let Some(m) = self.msgs.get(&next).cloned() else { break };
            if self.entries.len() >= self.cfg.max_blocks {
                // The confirmed copy is too far behind: stop (no tip).
                self.halt(next, "behind");
                return;
            }
            match self.apply(&base, &m) {
                Ok(e) => {
                    self.count(|s| s.applied += 1);
                    let us = e.apply_us;
                    self.count(|s| s.add_time(us));
                    self.entries.push_back(e);
                }
                Err(why) => {
                    self.halt(next, why);
                    return;
                }
            }
        }
        // The tip only when it is the newest message held (no gap waiting).
        let newest = self.msgs.keys().next_back().copied();
        self.tip = match (self.entries.back(), newest) {
            (Some(e), Some(n)) if e.seq == n => Some(Arc::new(self.tip_of(e, &base))),
            _ => None,
        };
    }

    fn halt(&mut self, seq: u64, why: &'static str) {
        self.count(|s| s.stop(why));
        self.stop = Some(Stop { seq, why });
        self.tip = None;
    }

    fn tip_of(&self, e: &Entry, base: &Confirmed) -> AheadTip {
        let mut unsure: Vec<String> = e.unsure_cum.iter().chain(self.pools.not_ready.iter()).cloned().collect();
        unsure.sort();
        unsure.dedup();
        AheadTip {
            seq: e.seq,
            block: e.seq + self.cfg.l2_offset,
            base_seq: base.seq,
            snap: e.snap.clone(),
            ctx: e.ctx.clone(),
            changed_pools: e.changed.clone(),
            unsure_pools: unsure,
            built_at: e.built_at,
            apply_us: e.apply_us,
        }
    }

    /// Apply one message on top of the predicted tip (or the base).
    fn apply(&mut self, base: &Confirmed, m: &BinMsg) -> Result<Entry, &'static str> {
        let t0 = Instant::now();
        let (prev_snap, prev_ctx, mut changed_cum, mut unsure_cum) = match self.entries.back() {
            Some(e) => (e.snap.clone(), e.ctx.clone(), e.changed_cum.clone(), e.unsure_cum.clone()),
            None => (base.snap.clone(), base.ctx.clone().ok_or("no_block_details")?, HashSet::new(), HashSet::new()),
        };
        // Deposits / retryables / anything we can't unpack: we can't know
        // what it does to our pools. Never guessed: stop until confirmed.
        if !m.complete || m.bad.is_some() {
            return Err("unreplayable_msg");
        }
        if m.ts == 0 {
            return Err("no_block_time");
        }
        if m.txs.len() > self.cfg.max_txs {
            return Err("too_many_txs");
        }
        // This block's details (same rules as check/ordered.rs build_plan:
        // Nitro never lets time or the parent-chain block go backwards).
        let ctx = BlockCtx {
            l1_block_number: m.l1.max(prev_ctx.l1_block_number),
            l2_block_number: prev_ctx.l2_block_number.map(|_| m.seq + self.cfg.l2_offset),
            timestamp: m.ts.max(prev_ctx.timestamp),
            basefee: 0,
            coinbase: prev_ctx.coinbase,
            gas_limit: prev_ctx.gas_limit,
            prevrandao: prev_ctx.prevrandao,
        };
        // Decode everything first: a transaction we can't even read (a kind
        // we don't replay) could do anything: stop until confirmed.
        let mut txs: Vec<DecodedTx> = Vec::with_capacity(m.txs.len());
        for t in &m.txs {
            txs.push(t.decoded().map_err(|_| "undecodable_tx")?);
        }
        let mut ov = Overlay::new((*prev_snap).clone());
        let pools = self.pools.clone();
        let assume = Assume { sender_funds: true, recent_fill: true, skip: None, record_hashes: true };
        let mut changed: Vec<String> = Vec::new();
        let mut skipped: Vec<(B256, Option<Address>)> = Vec::new();
        for t in &txs {
            let pick = self.cfg.run_all || pools.may_touch(t.to, &t.data) || t.to.is_some_and(|a| self.touchers.contains_key(&a));
            if !pick {
                self.count(|s| s.txs_skipped += 1);
                skipped.push((t.hash, t.to));
                continue;
            }
            self.count(|s| s.txs_run += 1);
            let plan = OrderedPlan { msgs: vec![PlanMsg { seq: m.seq, ctx: ctx.clone(), txs: vec![t.clone()] }], trigger: t.hash, call_ctx: ctx.clone() };
            match run_ordered_keep(&ov, &plan, base.prov.as_ref(), &assume) {
                Ok((out, kept)) => {
                    if !out.assumed.labels().is_empty() {
                        self.count(|s| s.assumed += 1);
                    }
                    ov.commit(&kept.diff);
                    for (a, s) in &kept.forget {
                        ov.forget_slot(*a, *s);
                    }
                    let moved: Vec<String> = pools.moved.moved(&out.changed, &out.hashes).into_iter().map(|x| x.key).collect();
                    if !moved.is_empty() {
                        if let Some(a) = t.to {
                            self.learn_toucher(a);
                        }
                    }
                    for k in moved {
                        // Values forgotten earlier stay forgotten (a later
                        // exact write puts back only what it wrote).
                        if !changed.contains(&k) {
                            changed.push(k.clone());
                        }
                        changed_cum.insert(k);
                    }
                }
                Err(_) => {
                    self.count(|s| s.txs_failed += 1);
                    // Which of our pools might it touch? What it reads in a
                    // collect run + what it names. Those become unsure.
                    let mut hit = probe_touched(&ov, &ctx, t, &pools);
                    for k in pools.named(t.to, &t.data) {
                        if !hit.contains(&k) {
                            hit.push(k);
                        }
                    }
                    if !hit.is_empty() {
                        self.count(|s| s.txs_marked += 1);
                        if let Some(a) = t.to {
                            self.learn_toucher(a);
                        }
                    }
                    for k in hit {
                        if let Some(p) = pools.places.get(&k) {
                            forget_place(&mut ov, *p);
                        }
                        if !changed.contains(&k) {
                            changed.push(k.clone());
                        }
                        changed_cum.insert(k.clone());
                        unsure_cum.insert(k);
                    }
                }
            }
        }
        changed.sort();
        ov.set_position(StatePosition { base_block: base.seq + self.cfg.l2_offset, after_seq: Some(m.seq) });
        let (snap, _) = ov.into_parts();
        Ok(Entry {
            seq: m.seq,
            snap: Arc::new(snap),
            ctx,
            changed,
            changed_cum,
            unsure_cum,
            skipped,
            built_at: Instant::now(),
            apply_us: t0.elapsed().as_micros() as u64,
        })
    }
}

/// Forget one pool's own state in the predicted copy (strict: reads of it
/// are then Missing, never a stale or made-up value).
fn forget_place(ov: &mut Overlay, p: Place) {
    match p {
        Place::Contract(a) => ov.forget(a),
        Place::V4(pm, base) => {
            for k in 0..4u8 {
                ov.forget_slot(pm, base + U256::from(k));
            }
        }
    }
}

/// Same state of one pool in both copies? Compared on the values the
/// CONFIRMED copy holds (its own declared values / V4 base values). A value
/// we hold differently, or don't hold, is a difference.
fn same_state(p: Place, pred: &Snapshot, conf: &Snapshot) -> bool {
    match p {
        Place::Contract(a) => {
            let Some(acc) = conf.accounts.get(&a) else {
                // Confirmed copy forgot it (unsure there): ours must too.
                return pred.accounts.get(&a).is_none_or(|x| x.storage.is_empty());
            };
            acc.storage
                .iter()
                .filter(|(s, _)| **s < U256::from(DECLARED_MAX))
                .all(|(s, v)| pred.storage(a, *s) == Lookup::Known(*v))
        }
        Place::V4(pm, base) => (0..4u8).all(|k| {
            let s = base + U256::from(k);
            match conf.storage(pm, s) {
                Lookup::Known(v) => pred.storage(pm, s) == Lookup::Known(v),
                Lookup::Missing => true,
            }
        }),
    }
}

/// A transaction we couldn't run exactly: run it once more in COLLECT mode
/// (a missing value reads as zero just to keep going; NOTHING of this run
/// is kept) and write down every account / value it read. Our pools among
/// them are the ones it may touch. Never asks the node.
fn probe_touched(view: &dyn StateRead, ctx: &BlockCtx, t: &DecodedTx, pools: &PoolSet) -> Vec<String> {
    let ov = Overrides::none();
    let mut s = Session::new(view, ctx, &ov, CheckOptions::default());
    s.db().set_recording(true);
    if matches!(view.account(t.from), Lookup::Missing) {
        s.db().add_pretend(t.from, AccountInfo { balance: t.value, nonce: t.nonce, code_hash: KECCAK_EMPTY, ..Default::default() });
    }
    let _ = s.apply_decoded(t);
    let reads = std::mem::take(&mut s.db().reads);
    pools.touched_by(&reads.accounts, &reads.slots)
}

// ---------------------------------------------------------------------------
// Runtime: one light thread in the running sidecar (only when FASTLANE is on)
// ---------------------------------------------------------------------------

enum Ev {
    Feed(Arc<BinMsg>),
    Confirmed,
}

struct Runtime {
    tx: SyncSender<Ev>,
    tip: Mutex<Option<Arc<AheadTip>>>,
    status: Mutex<Value>,
    dropped: std::sync::atomic::AtomicU64,
}

static RT: OnceLock<Runtime> = OnceLock::new();

/// Start the predicted copy for this sidecar (copy 2 mode). Does nothing
/// and returns false when FASTLANE is off (the default).
pub fn start(c2: super::intake::Copy2Handle) -> bool {
    start_with(mode(), c2, AheadCfg::from_lookup(|k| std::env::var(k).ok(), 0))
}

/// `start` with the mode given (tests: Off must start nothing).
pub fn start_with(m: Mode, c2: super::intake::Copy2Handle, mut cfg: AheadCfg) -> bool {
    if m == Mode::Off || RT.get().is_some() {
        return false;
    }
    cfg.l2_offset = c2.sh.cfg.l2_offset;
    let (tx, rx) = std::sync::mpsc::sync_channel::<Ev>(4096);
    if RT.set(Runtime { tx, tip: Mutex::new(None), status: Mutex::new(json!({})), dropped: Default::default() }).is_err() {
        return false;
    }
    eprintln!(
        "[arbsim] fastlane ahead: predicted copy ON (FASTLANE={}); max {} blocks, filter {}, zero node reads",
        if m == Mode::Live { "live" } else { "practice" },
        cfg.max_blocks,
        if cfg.run_all { "all" } else { "smart" }
    );
    std::thread::Builder::new().name("arbsim-ahead".into()).spawn(move || run_loop(c2, cfg, rx)).is_ok()
}

/// check/feedstore.rs: new feed messages stored (no-op when off).
pub fn feed_hook(added: &[Arc<BinMsg>]) {
    let Some(rt) = RT.get() else { return };
    for m in added {
        if rt.tx.try_send(Ev::Feed(m.clone())).is_err() {
            rt.dropped.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
}

/// copy2/intake.rs: a version was published (no-op when off).
pub fn confirmed_hook() {
    if let Some(rt) = RT.get() {
        let _ = rt.tx.try_send(Ev::Confirmed);
    }
}

/// The running sidecar's predicted tip (None when off / not ready).
pub fn global_tip() -> Option<Arc<AheadTip>> {
    RT.get().and_then(|rt| rt.tip.lock().unwrap_or_else(|e| e.into_inner()).clone())
}

/// status "fastlaneAhead" (None when off).
pub fn status_json() -> Option<Value> {
    let rt = RT.get()?;
    let mut v = rt.status.lock().unwrap_or_else(|e| e.into_inner()).clone();
    v["dropped"] = json!(rt.dropped.load(std::sync::atomic::Ordering::Relaxed));
    Some(v)
}

/// The pools copy 2 follows, from its registry.
fn pool_set(c2: &super::intake::Copy2Handle) -> PoolSet {
    let reg = c2.c2.reg.read().unwrap_or_else(|e| e.into_inner());
    let mut list = Vec::with_capacity(reg.pools.len());
    let mut not_ready = HashSet::new();
    for (pk, e) in &reg.pools {
        let key = match pk.1 {
            Some(id) => format!("{id:#x}"),
            None => format!("{:#x}", e.pool.address),
        };
        if e.state != super::intake::PoolState::Ready {
            not_ready.insert(key.clone());
        }
        list.push((FollowedPool { key, address: e.pool.address, v4_id: pk.1 }, e.pool.token0, e.pool.token1));
    }
    drop(reg);
    PoolSet::build(&list, not_ready)
}

fn run_loop(c2: super::intake::Copy2Handle, cfg: AheadCfg, rx: Receiver<Ev>) {
    let mut a = Ahead::new(cfg);
    let mut reg_gen = u64::MAX;
    let mut head: Option<Arc<crate::state::mirror::Version>> = None;
    let mut hour_start = Instant::now();
    let mut last_status = Instant::now();
    loop {
        let ev = rx.recv_timeout(Duration::from_millis(25));
        if matches!(ev, Err(RecvTimeoutError::Disconnected)) {
            return;
        }
        // Pools: rebuilt only when copy 2's registry changed.
        let g = c2.c2.reg.gen();
        if g != reg_gen {
            reg_gen = g;
            a.set_pools(Arc::new(pool_set(&c2)));
        }
        // Confirmed first (a new version may already cover a feed message).
        if let Some(v) = c2.sh.head() {
            if head.as_ref().is_none_or(|h| !Arc::ptr_eq(h, &v)) {
                head = Some(v.clone());
                let core = c2.core_for(None);
                let prov = c2.provenance_with(&core, v.block, &[]);
                let prov: Arc<dyn Provenance + Send + Sync> = prov;
                let conf = Confirmed { seq: v.seq, snap: v.snap.clone(), ctx: v.ctx.clone(), diff: v.diff.clone(), prov };
                let rm = &c2.c2.recent_moves;
                a.on_confirmed(conf, &|h| rm.lock().ok().and_then(|r| r.pools_of(h)));
            }
        }
        if let Ok(Ev::Feed(m)) = ev {
            a.on_feed_message(m);
            // Everything queued, in order (a burst after a reconnect).
            while let Ok(e) = rx.try_recv() {
                if let Ev::Feed(m) = e {
                    a.on_feed_message(m);
                }
            }
        }
        if let Some(rt) = RT.get() {
            *rt.tip.lock().unwrap_or_else(|e| e.into_inner()) = a.tip();
            if last_status.elapsed() >= Duration::from_secs(1) {
                last_status = Instant::now();
                *rt.status.lock().unwrap_or_else(|e| e.into_inner()) = status_of(&a);
            }
        }
        if hour_start.elapsed() >= Duration::from_secs(3600) {
            hour_start = Instant::now();
            eprintln!("{}", a.hour.line());
            a.hour = AheadStats::default();
        }
    }
}

fn status_of(a: &Ahead) -> Value {
    let tip = a.tip();
    json!({
        "baseSeq": a.base_seq(), "depth": a.depth(), "heldMsgs": a.held_msgs(), "pools": a.pools().len(),
        "tip": tip.as_ref().map(|t| json!({"seq": t.seq, "block": t.block, "changed": t.changed_pools.len(), "unsure": t.unsure_pools.len(), "applyUs": t.apply_us, "ageMs": t.built_at.elapsed().as_millis() as u64})),
        "stopped": a.stopped().map(|(s, w)| json!({"seq": s, "why": w})),
        "touchers": a.touchers.len(),
        "hour": a.hour.json(), "total": a.total.json(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fastlane_words_match_workstream_d() {
        for (w, m) in [(None, Mode::Off), (Some(""), Mode::Off), (Some("off"), Mode::Off), (Some(" Practice "), Mode::Practice), (Some("shadow"), Mode::Practice), (Some("dry"), Mode::Practice), (Some("LIVE"), Mode::Live), (Some("yes"), Mode::Off)] {
            assert_eq!(parse_mode(w), m, "{w:?}");
        }
    }

    #[test]
    fn settings_from_env_words() {
        let m: HashMap<&str, &str> = [("FASTLANE_AHEAD_MAX_BLOCKS", "8"), ("FASTLANE_AHEAD_FILTER", "ALL")].into_iter().collect();
        let c = AheadCfg::from_lookup(|k| m.get(k).map(|s| s.to_string()), 5);
        assert_eq!((c.max_blocks, c.run_all, c.max_txs, c.l2_offset), (8, true, 256, 5));
        let c = AheadCfg::from_lookup(|_| Some("0".into()), 0);
        assert_eq!((c.max_blocks, c.run_all), (32, false), "nonsense falls back to the defaults");
    }
}
