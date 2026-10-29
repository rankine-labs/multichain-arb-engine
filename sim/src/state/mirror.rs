// ============================================================================
// MIRROR (shared part): the published versions of our chain copy, settings,
// counters, and "which version does this question mean?".
//
// Plain English:
//   One background thread (state/updater.rs) is the ONLY writer. Every time
//   it finishes a feed message (= one L2 block) it publishes a new Version:
//   the frozen state right after that block, plus the state after each
//   transaction in it. The last 64 versions are kept, so the bot can ask
//   "right after block N" or "right after transaction X".
//
//   Socket threads only READ: they grab the version they need (a cheap
//   pointer copy, under a lock held for microseconds) and run the check on
//   it while the writer keeps going.
//
//   resolve() turns the request's `at` into a version, or says why it
//   can't be sure:
//     not_ready  nothing usable yet (just started, node trouble, no feed)
//     dirty      the block asked for (or newer ones, for "head") has arrived
//                but isn't replayed yet (waiting for the node, see updater)
//     stale      the feed went quiet (> ARBSIM_MAX_STALE_MS), or the version
//                asked for is older than what we keep
// ============================================================================
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

use revm::primitives::B256;
use serde_json::{json, Value};

use super::snap::{Snapshot, Volatile};
use super::StateDiff;
use crate::arb::BlockCtx;
use crate::feed::replay::TxSnap;
use crate::node::{env_u64, NodeApi};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
/// All tunables (env var names in brackets; defaults in from_env).
#[derive(Clone, Debug)]
pub struct Config {
    /// L2 block number = feed sequenceNumber + this [ARBSIM_L2_BLOCK_OFFSET].
    /// Nitro: block = seq + genesisBlockNum; Orbit chains start at 0, so on
    /// Robinhood this is 0 (workstream B, arb::ROBINHOOD_GENESIS_BLOCK_NUM).
    /// The mirror cross-checks it against node headers at runtime and logs
    /// + counts `block_offset_mismatch` if it looks wrong.
    pub l2_offset: u64,
    /// Feed silent longer than this -> "stale" [ARBSIM_MAX_STALE_MS, 3000].
    pub max_stale_ms: u64,
    /// How long a check may wait for the block it asks about to be replayed
    /// before answering "dirty" [ARBSIM_WAIT_MS, 30].
    pub wait_ms: u64,
    /// Versions kept for afterSeq / afterTx / late fills [ARBSIM_HISTORY, 64].
    pub history: usize,
    /// Feed messages waiting to be replayed, at most [ARBSIM_MAX_PENDING, 2000].
    pub max_pending: usize,
    /// Compare our replay with the node's trace every N blocks; 0 = off
    /// [ARBSIM_VERIFY_EVERY_N_BLOCKS, 20] ...
    pub verify_every: u64,
    /// ... but never more often than this [ARBSIM_VERIFY_MIN_INTERVAL_S, 60]
    /// (at ~4 blocks/s, every 20th block would be 17,000 traces a day).
    pub verify_min_interval_s: u64,
    /// A gap of up to this many blocks is repaired with node traces (1 call
    /// per block); bigger gaps restart the copy [ARBSIM_GAP_TRACE_MAX, 8].
    pub gap_trace_max: u64,
    /// Wait this long for missing feed messages before treating it as a gap
    /// [ARBSIM_GAP_WAIT_MS, 1500].
    pub gap_wait_ms: u64,
    /// Node fetch rounds per feed message before giving up on it
    /// [ARBSIM_MAX_FILL_ROUNDS, 12].
    pub max_fill_rounds: usize,
    /// Memory caps [ARBSIM_MAX_ACCOUNTS 50000, ARBSIM_MAX_SLOTS 250000].
    pub max_accounts: usize,
    pub max_slots: usize,
    /// Accounts unused this long are dropped [ARBSIM_IDLE_EVICT_S, 21600 = 6 h].
    pub idle_evict_s: u64,
    /// Refresh the block header (base fee, offset cross-check) this often
    /// [ARBSIM_HEADER_EVERY_S, 300].
    pub header_every_s: u64,
    /// Pinned (historical) checks: total time [ARBSIM_PIN_TIMEOUT_MS 20000],
    /// fetch rounds [ARBSIM_PIN_ROUNDS 8], blocks cached [ARBSIM_PIN_CACHE 3].
    pub pin_timeout_ms: u64,
    pub pin_rounds: usize,
    pub pin_cache: usize,
    /// Most warm items remembered (re-loaded after a restart of the copy)
    /// [ARBSIM_MAX_WARM, 20000].
    pub max_warm: usize,
}

impl Config {
    pub fn from_env() -> Self {
        Config {
            l2_offset: env_u64("ARBSIM_L2_BLOCK_OFFSET", crate::arb::ROBINHOOD_GENESIS_BLOCK_NUM),
            max_stale_ms: env_u64("ARBSIM_MAX_STALE_MS", 3000),
            wait_ms: env_u64("ARBSIM_WAIT_MS", 30),
            history: env_u64("ARBSIM_HISTORY", 64).max(2) as usize,
            max_pending: env_u64("ARBSIM_MAX_PENDING", 2000).max(16) as usize,
            verify_every: env_u64("ARBSIM_VERIFY_EVERY_N_BLOCKS", 20),
            verify_min_interval_s: env_u64("ARBSIM_VERIFY_MIN_INTERVAL_S", 60),
            gap_trace_max: env_u64("ARBSIM_GAP_TRACE_MAX", 8),
            gap_wait_ms: env_u64("ARBSIM_GAP_WAIT_MS", 1500),
            max_fill_rounds: env_u64("ARBSIM_MAX_FILL_ROUNDS", 12).max(1) as usize,
            max_accounts: env_u64("ARBSIM_MAX_ACCOUNTS", 50_000) as usize,
            max_slots: env_u64("ARBSIM_MAX_SLOTS", 250_000) as usize,
            idle_evict_s: env_u64("ARBSIM_IDLE_EVICT_S", 21_600),
            header_every_s: env_u64("ARBSIM_HEADER_EVERY_S", 300),
            pin_timeout_ms: env_u64("ARBSIM_PIN_TIMEOUT_MS", 20_000),
            pin_rounds: env_u64("ARBSIM_PIN_ROUNDS", 8).max(1) as usize,
            pin_cache: env_u64("ARBSIM_PIN_CACHE", 3).clamp(1, 8) as usize,
            max_warm: env_u64("ARBSIM_MAX_WARM", 20_000) as usize,
        }
    }

    /// Settings for tests: no waiting, small caps, no verification.
    pub fn for_tests() -> Self {
        Config {
            l2_offset: 0,
            max_stale_ms: 3_600_000,
            wait_ms: 0,
            history: 8,
            max_pending: 64,
            verify_every: 0,
            verify_min_interval_s: 0,
            gap_trace_max: 4,
            gap_wait_ms: 0,
            max_fill_rounds: 6,
            max_accounts: 10_000,
            max_slots: 100_000,
            idle_evict_s: 21_600,
            header_every_s: 0,
            pin_timeout_ms: 5_000,
            pin_rounds: 8,
            pin_cache: 2,
            max_warm: 1000,
        }
    }
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------
/// Our copy right after one feed message (= one L2 block).
#[derive(Clone, Debug)]
pub struct Version {
    pub seq: u64,
    pub block: u64,
    /// State after the whole block.
    pub snap: Arc<Snapshot>,
    /// Block details (None = unknown: the block was repaired from a node
    /// trace without its feed header; checks "at" it answer not_ready).
    pub ctx: Option<BlockCtx>,
    /// State after each transaction (for afterTx).
    pub txs: Vec<TxSnap>,
    /// Everything this block changed (for late-fill reconciliation).
    pub diff: Arc<StateDiff>,
    /// Accounts whose state this version's diff does not fully describe
    /// (a restart of the copy happened here: everything).
    pub restart: bool,
    /// Block hash from the feed message, when the feed gives it.
    pub block_hash: Option<B256>,
    pub applied: Instant,
}

/// What the readers see.
#[derive(Debug, Default)]
pub struct Published {
    pub versions: VecDeque<Arc<Version>>,
    /// Highest sequence number received from the feed.
    pub received_seq: Option<u64>,
    /// When the last feed frame arrived.
    pub last_frame: Option<Instant>,
    /// Why the copy can't be used right now (None = fine).
    pub stalled: Option<String>,
}

impl Published {
    pub fn head(&self) -> Option<&Arc<Version>> {
        self.versions.back()
    }
}

/// What checks read: a copy of Published taken when its last write lock
/// was released (copy2-q, live Oct 22 20:00: the copy-keeping thread held
/// the lock up to ~200 ms while folding node values into every kept
/// version, and checks waited). Checks never take the lock: they get the
/// state as it was just before that write began, exactly what a check that
/// came a moment earlier would have seen.
#[derive(Debug, Default)]
pub struct PubView {
    pub versions: VecDeque<Arc<Version>>,
    pub received_seq: Option<u64>,
    pub last_frame: Option<Instant>,
    pub stalled: Option<String>,
}

impl PubView {
    pub fn head(&self) -> Option<&Arc<Version>> {
        self.versions.back()
    }
}

/// The lock around Published, plus the readers' copy (PubView) and the
/// "newest block received" note that the socket threads update without
/// the lock (a block message must never wait for the copy's thread: the
/// bot's checks on the same connection are read after it).
#[derive(Default)]
pub struct PubLock {
    inner: RwLock<Published>,
    view: Mutex<Arc<PubView>>,
    /// (last message time, newest block received) noted by socket threads.
    recv: Mutex<(Option<Instant>, Option<u64>)>,
}

/// Write guard: on release, the readers' copy is refreshed (a copy of 64
/// pointers, ~1 us) while the lock is still held.
pub struct PubWriteGuard<'a> {
    g: std::sync::RwLockWriteGuard<'a, Published>,
    lock: &'a PubLock,
}

impl PubLock {
    pub fn read(&self) -> std::sync::LockResult<std::sync::RwLockReadGuard<'_, Published>> {
        self.inner.read()
    }
    pub fn write(&self) -> std::sync::LockResult<PubWriteGuard<'_>> {
        let g = self.inner.write().unwrap_or_else(|e| e.into_inner());
        Ok(PubWriteGuard { g, lock: self })
    }
    /// The readers' copy (never waits for a writer).
    pub fn view(&self) -> Arc<PubView> {
        self.view.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    /// A block message arrived (socket threads; never waits for the copy).
    pub fn note_received(&self, seq: u64) {
        let mut r = self.recv.lock().unwrap_or_else(|e| e.into_inner());
        r.0 = Some(Instant::now());
        r.1 = Some(r.1.map_or(seq, |x| x.max(seq)));
    }
    /// (last message time, newest received) from both notes.
    pub fn received(&self, v: &PubView) -> (Option<Instant>, Option<u64>) {
        let r = *self.recv.lock().unwrap_or_else(|e| e.into_inner());
        let lf = match (v.last_frame, r.0) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };
        let rs = match (v.received_seq, r.1) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };
        (lf, rs)
    }
}

impl std::ops::Deref for PubWriteGuard<'_> {
    type Target = Published;
    fn deref(&self) -> &Published {
        &self.g
    }
}

impl std::ops::DerefMut for PubWriteGuard<'_> {
    fn deref_mut(&mut self) -> &mut Published {
        &mut self.g
    }
}

impl Drop for PubWriteGuard<'_> {
    fn drop(&mut self) {
        let p = &*self.g;
        let v = Arc::new(PubView { versions: p.versions.clone(), received_seq: p.received_seq, last_frame: p.last_frame, stalled: p.stalled.clone() });
        *self.lock.view.lock().unwrap_or_else(|e| e.into_inner()) = v;
    }
}

impl<'a> crate::timing::WriteLock<'a> for PubLock {
    type Guard = PubWriteGuard<'a>;
    fn lock_write(&'a self) -> Self::Guard {
        self.write().unwrap_or_else(|e| e.into_inner())
    }
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------
macro_rules! counters {
    ($($name:ident),* $(,)?) => {
        /// Running counters (all since start), shown by `status`.
        #[derive(Debug, Default)]
        pub struct Stats { $(pub $name: AtomicU64,)* }
        impl Stats {
            pub fn json(&self) -> serde_json::Map<String, Value> {
                let mut m = serde_json::Map::new();
                $( m.insert(stringify!($name).into(), Value::from(self.$name.load(Ordering::Relaxed))); )*
                m
            }
        }
    };
}

counters!(
    frames, frames_dropped, frames_bad, msgs_received, msgs_duplicate, msgs_replayed, msgs_traced,
    txs_replayed, txs_reverted, need_item_rounds, items_fetched, need_trace, gaps, gap_blocks,
    restarts, dirty_events, dirty_ms_total, replay_match, replay_mismatch, verify_items,
    verify_item_mismatches, verify_skipped, block_offset_mismatch, misses, miss_items_queued,
    fills, fill_items, fill_dropped_conflict, fill_failed, warm_items, evicted_accounts,
    checks, checks_ok, checks_unknown, pinned_checks, pinned_fetch_rounds,
);

impl Stats {
    pub fn inc(c: &AtomicU64) {
        c.fetch_add(1, Ordering::Relaxed);
    }
    pub fn add(c: &AtomicU64, n: u64) {
        c.fetch_add(n, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------------------
// Shared object
// ---------------------------------------------------------------------------
/// Everything readers and the background threads share.
pub struct Shared {
    pub cfg: Config,
    pub published: PubLock,
    /// Signalled every time a version is published (checks waiting for it).
    pub changed: (Mutex<u64>, Condvar),
    pub stats: Stats,
    pub volatile: Arc<Volatile>,
    pub node: Option<Arc<dyn NodeApi>>,
    /// Latest block the node is known to have (0 = unknown).
    pub node_tip: AtomicU64,
    /// When the copy became "dirty" (ms since `started`; 0 = not dirty).
    pub dirty_since_ms: AtomicU64,
    /// Restart counter of the copy (a fill fetched before a restart is void).
    pub epoch: AtomicU64,
    /// Why checks needed the node most recently (reason -> count), for status.
    pub trace_reasons: Mutex<Vec<(String, u64)>>,
    pub started: Instant,
}

/// Why a check can't get a sure view.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NotSure {
    pub reason: &'static str,
    pub detail: String,
}

impl NotSure {
    fn new(reason: &'static str, detail: impl Into<String>) -> Self {
        NotSure { reason, detail: detail.into() }
    }
}

/// Which state a request is about (parsed `at`, see proto.rs).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum At {
    Head,
    /// SPEED FIX 3 (Oct 29): the newest replayed block NOW, without waiting
    /// for a block that has arrived but isn't replayed yet ("dirty"). Only
    /// for callers that replay the feed messages after the version
    /// themselves (fast-lane fire-first: its plan runs every message after
    /// the picked version, so a version a block older is just one more
    /// message to replay). Live: "head" waited up to ARBSIM_WAIT_MS (30 ms)
    /// on most fast-lane questions.
    HeadNow,
    AfterSeq(u64),
    AfterTx(B256),
    Block(u64),
    /// Historical view of confirmed block N, filled from the node.
    Pinned { block: u64, next: bool },
}

/// A view picked for a check.
pub struct Picked {
    pub snap: Arc<Snapshot>,
    pub ctx: BlockCtx,
    pub seq: u64,
    /// The readers' copy it was picked from (copy 2: a registry summary
    /// built while this very copy was current may be used, checkcore.rs).
    pub from: Option<Arc<PubView>>,
}

impl Shared {
    pub fn new(cfg: Config, node: Option<Arc<dyn NodeApi>>, volatile: Arc<Volatile>) -> Arc<Self> {
        Arc::new(Shared {
            cfg,
            published: PubLock::default(),
            changed: (Mutex::new(0), Condvar::new()),
            stats: Stats::default(),
            volatile,
            node,
            node_tip: AtomicU64::new(0),
            dirty_since_ms: AtomicU64::new(0),
            epoch: AtomicU64::new(0),
            trace_reasons: Mutex::new(Vec::new()),
            started: Instant::now(),
        })
    }

    pub fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64 + 1
    }

    /// Wake checks waiting for a new version.
    pub fn notify(&self) {
        let mut g = self.changed.0.lock().unwrap();
        *g = g.wrapping_add(1);
        self.changed.1.notify_all();
    }

    /// Count one "had to ask the node for the whole block" reason (status).
    pub fn note_trace_reason(&self, why: &str) {
        // Keep the reason short and generic (drop tx hashes / numbers).
        let key: String = why.split(|c: char| c == '(' || c == ':').last().unwrap_or(why).trim().chars().take(60).collect();
        let mut g = self.trace_reasons.lock().unwrap();
        if let Some(e) = g.iter_mut().find(|(k, _)| *k == key) {
            e.1 += 1;
        } else if g.len() < 32 {
            g.push((key, 1));
        }
    }

    /// The head version, if any.
    pub fn head(&self) -> Option<Arc<Version>> {
        self.published.view().head().cloned()
    }

    /// Find the version for a live `at` (not Pinned). Waits up to
    /// cfg.wait_ms for a block that has arrived but isn't replayed yet.
    pub fn resolve(&self, at: &At) -> Result<Picked, NotSure> {
        let deadline = Instant::now() + Duration::from_millis(self.cfg.wait_ms);
        loop {
            let seen = *self.changed.0.lock().unwrap();
            match self.try_resolve(at) {
                Err(e) if e.reason == "dirty" && Instant::now() < deadline => {
                    // Wait for the next publish (or the deadline).
                    let t_wait = Instant::now();
                    let g = self.changed.0.lock().unwrap();
                    let left = deadline.saturating_duration_since(Instant::now());
                    let _ = self.changed.1.wait_timeout_while(g, left, |v| *v == seen).unwrap();
                    // Trigger-first phase timing (speed-3): time spent waiting
                    // for a block that had arrived but wasn't applied yet.
                    crate::timing::ph_add("dirtyWait", t_wait.elapsed().as_micros() as u64);
                    crate::timing::ph_count("dirtyWaits", 1);
                }
                r => return r,
            }
        }
    }

    fn try_resolve(&self, at: &At) -> Result<Picked, NotSure> {
        // The readers' copy: never waits for the copy-keeping thread.
        let p = self.published.view();
        if let Some(why) = &p.stalled {
            return Err(NotSure::new("not_ready", why.clone()));
        }
        let Some(head) = p.head() else { return Err(NotSure::new("not_ready", "no feed messages replayed yet")) };
        let (last_frame, received_seq) = self.published.received(&p);
        let fresh = last_frame.is_some_and(|t| t.elapsed() <= Duration::from_millis(self.cfg.max_stale_ms));
        let received = received_seq.unwrap_or(head.seq);
        let pick = |v: &Arc<Version>, snap: Arc<Snapshot>| -> Result<Picked, NotSure> {
            match &v.ctx {
                Some(c) => Ok(Picked { snap, ctx: c.clone(), seq: v.seq, from: Some(p.clone()) }),
                None => Err(NotSure::new("not_ready", format!("block {} has no block details (repaired from a node trace)", v.block))),
            }
        };
        let by_seq = |n: u64| -> Result<Picked, NotSure> {
            if n > head.seq {
                return if n <= received {
                    Err(NotSure::new("dirty", format!("block for seq {n} received, not replayed yet (at {})", head.seq)))
                } else {
                    Err(NotSure::new("not_ready", format!("seq {n} not received yet (latest {received})")))
                };
            }
            match p.versions.iter().rev().find(|v| v.seq == n) {
                Some(v) => pick(v, v.snap.clone()),
                None => Err(NotSure::new("stale", format!("seq {n} is older than the {} blocks kept", p.versions.len()))),
            }
        };
        match at {
            At::Head => {
                if !fresh {
                    return Err(NotSure::new("stale", "no feed frame recently"));
                }
                if received > head.seq {
                    return Err(NotSure::new("dirty", format!("{} newer block(s) not replayed yet", received - head.seq)));
                }
                pick(head, head.snap.clone())
            }
            At::HeadNow => {
                if !fresh {
                    return Err(NotSure::new("stale", "no feed frame recently"));
                }
                pick(head, head.snap.clone())
            }
            At::AfterSeq(n) => by_seq(*n),
            At::Block(b) => match b.checked_sub(self.cfg.l2_offset) {
                Some(n) => by_seq(n),
                None => Err(NotSure::new("stale", "block before the chain's first feed message")),
            },
            At::AfterTx(h) => {
                for v in p.versions.iter().rev() {
                    if let Some(t) = v.txs.iter().find(|t| t.hash == *h) {
                        return pick(v, t.snap.clone());
                    }
                }
                if received > head.seq {
                    Err(NotSure::new("dirty", "transaction not found in the replayed blocks; newer blocks pending"))
                } else {
                    Err(NotSure::new("not_ready", format!("transaction not seen in the last {} blocks", p.versions.len())))
                }
            }
            At::Pinned { .. } => Err(NotSure::new("not_ready", "pinned views are resolved by state::pinned")),
        }
    }

    /// Process memory in MB (Linux), for status.
    pub fn rss_mb() -> f64 {
        std::fs::read_to_string("/proc/self/statm")
            .ok()
            .and_then(|s| s.split_whitespace().nth(1).and_then(|x| x.parse::<f64>().ok()))
            .map(|pages| (pages * 4096.0 / 1_048_576.0 * 10.0).round() / 10.0)
            .unwrap_or(0.0)
    }

    /// The `status` answer body.
    pub fn status_json(&self) -> Value {
        let p = self.published.view();
        let (last_frame, received_seq) = self.published.received(&p);
        let head = p.head();
        let (accounts, slots, codes) = head.map(|h| h.snap.counts()).unwrap_or((0, 0, 0));
        let mut m = self.stats.json();
        // Dirty time includes the current dirty period, if any.
        let ds = self.dirty_since_ms.load(Ordering::Relaxed);
        let cur_dirty = if ds > 0 { self.now_ms().saturating_sub(ds) } else { 0 };
        m.insert("dirty_ms_total".into(), json!(self.stats.dirty_ms_total.load(Ordering::Relaxed) + cur_dirty));
        let received = received_seq;
        let dirty_from = match (head, received) {
            (Some(h), Some(r)) if r > h.seq => Some(h.seq + 1),
            _ => None,
        };
        let mut out = json!({
            "ok": true,
            "ready": head.is_some() && p.stalled.is_none(),
            "stalled": p.stalled,
            "head": head.map(|h| json!({ "seq": h.seq, "block": h.block, "ageMs": h.applied.elapsed().as_millis() as u64 })),
            "baseBlock": p.versions.front().map(|v| v.block),
            "receivedSeq": received,
            "overlayDepth": p.versions.len(),
            "dirtyFrom": dirty_from,
            "lastFrameAgoMs": last_frame.map(|t| t.elapsed().as_millis() as u64),
            "accounts": accounts,
            "slots": slots,
            "codes": codes,
            "rssMb": Self::rss_mb(),
            "uptimeS": self.started.elapsed().as_secs(),
            "nodeTip": self.node_tip.load(Ordering::Relaxed),
            "l2BlockOffset": self.cfg.l2_offset,
            "volatileBalances": self.volatile.balance_list().len(),
            "traceReasons": self.trace_reasons.lock().unwrap().iter().map(|(k, v)| json!({ "why": k, "n": v })).collect::<Vec<_>>(),
            "node": self.node.as_ref().map(|n| n.usage()).unwrap_or(Value::Null),
        });
        if let Value::Object(o) = &mut out {
            o.extend(m);
        }
        out
    }
}
