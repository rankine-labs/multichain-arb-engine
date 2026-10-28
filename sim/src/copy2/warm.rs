// ============================================================================
// WARM HOT TARGETS (Oct 27, owner approved 21:48: "fetch each one's data
// once, then only refresh what actually changes").
//
// Plain English:
//   Some contracts' transactions often move our pools (a rival bot, a
//   router): "hot targets" (copy 2's own pool reports show it; the discover
//   fill book counts it, server.rs DiscoverFillBook). When the fire-first
//   path is asked about one of their transactions, it usually lacks a few
//   of their values (the bot's settings, another V4 pool's data in the
//   PoolManager, a coin's setting). Fetching those at decision time takes
//   ~3 node round trips: too slow for a race. So:
//
//   1. LEARN. Every fire-first "unknown: miss" names the transaction it got
//      stuck on (its target) and the values it lacked: those values are
//      that target's RECIPE (at most ARBSIM_WARM_PER_TARGET each).
//   2. FETCH ONCE. For the top ARBSIM_WARM_TARGETS [20] hot targets, every
//      recipe value is fetched once, in the background (copy 2's loader
//      threads: one eth_getProof per account, the node's daily allowance
//      and speed limit as for every other copy-2 read).
//   3. REFRESH ONLY WHAT CHANGES. A value is re-read
//        - after a feed transaction TO its contract ("touch"), unless it
//          has come back the same ARBSIM_WARM_STABLE_AFTER [3] times in a
//          row (then it is STABLE: timer only);
//        - every ARBSIM_WARM_TIMER_S [60] seconds (all values).
//      A touched value that isn't stable is NOT used until re-read.
//   4. NEVER STALE-TRUSTED. A value older than ARBSIM_WARM_MAX_AGE_S [90]
//      counts as missing. ARBSIM_WARM_PER_HOUR [25000] is a hard cap on
//      node calls an hour (counted like the loader counts them): when a
//      refresh doesn't fit, it is not sent and those values are dropped
//      (answers needing them become unknown), never kept on trust.
//   5. USE. Fire-first questions (trig_discover / trig calls, server.rs)
//      read copy 2's own values first; a value copy 2 doesn't hold is taken
//      from here, labelled like any value copy 2 doesn't follow ("recent
//      fill": never exact). A transaction before the trigger in the same
//      question that goes TO a value's contract makes that value (unless
//      stable) missing for that question. Nothing waits for the node.
//
//   Only when FASTLANE is not off (and ARBSIM_WARM_TARGETS > 0): with
//   FASTLANE=off nothing here is learned, fetched or used.
//   Not saved across restarts: after one, recipes are learned again (the
//   first misses of each hot target).
//   Values of things copy 2 follows itself (our pools, their coin balances,
//   our V4 pools' data, PoolManager coin balances) are never warmed: they
//   are filtered out by copy 2 before any fetch (intake.rs dispatch_warm).
//
// Time is plain seconds (`now`), so `arbsim trig-replay --warm-sim` runs this
// same code over a recording.
// ============================================================================
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use revm::primitives::{Address, U256};
use serde_json::{json, Value};

use crate::node::Fetched;
use crate::state::snap::{Fact, Snapshot};
use crate::state::{Lookup, MissItem, StateRead};

/// Settings (see the file header).
#[derive(Clone, Debug)]
pub struct WarmCfg {
    pub on: bool,
    pub targets: usize,
    pub per_hour: u64,
    pub timer_s: f64,
    pub max_age_s: f64,
    pub stable_after: u32,
    pub per_target: usize,
    pub max_items: usize,
    /// Values per fetch job.
    pub batch: usize,
}

impl Default for WarmCfg {
    fn default() -> Self {
        WarmCfg { on: true, targets: 20, per_hour: 25_000, timer_s: 60.0, max_age_s: 90.0, stable_after: 3, per_target: 400, max_items: 6_000, batch: 300 }
    }
}

impl WarmCfg {
    /// From settings: on only when FASTLANE is not off and ARBSIM_WARM_TARGETS > 0.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> WarmCfg {
        let d = WarmCfg::default();
        let num = |k: &str, dv: u64| get(k).and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(dv);
        let targets = num("ARBSIM_WARM_TARGETS", d.targets as u64) as usize;
        let fastlane = crate::fastlane::mode::Mode::parse(get("FASTLANE").as_deref()) != crate::fastlane::mode::Mode::Off;
        WarmCfg {
            on: fastlane && targets > 0,
            targets,
            per_hour: num("ARBSIM_WARM_PER_HOUR", d.per_hour),
            timer_s: num("ARBSIM_WARM_TIMER_S", 60).max(1) as f64,
            max_age_s: num("ARBSIM_WARM_MAX_AGE_S", 90).max(1) as f64,
            stable_after: num("ARBSIM_WARM_STABLE_AFTER", 3).max(1) as u32,
            per_target: num("ARBSIM_WARM_PER_TARGET", d.per_target as u64).max(1) as usize,
            max_items: num("ARBSIM_WARM_MAX_ITEMS", d.max_items as u64).max(1) as usize,
            batch: d.batch,
        }
    }

    pub fn from_env() -> WarmCfg {
        Self::from_lookup(|k| std::env::var(k).ok())
    }
}

/// The contract a value belongs to.
pub fn owner(m: &MissItem) -> Option<Address> {
    match m {
        MissItem::Slot(a, _) | MissItem::Account(a) => Some(*a),
        MissItem::Code(_) => None,
    }
}

/// One warm value.
#[derive(Clone, Debug)]
pub struct WarmItem {
    pub value: Option<Fetched>,
    /// The node block it was read at, and when (seconds).
    pub block: u64,
    pub at: f64,
    /// Came back the same this many times in a row.
    pub same: u32,
    /// Ever came back different.
    pub changed: bool,
    /// A refresh is on its way.
    pub sent: bool,
}

impl WarmItem {
    fn new() -> Self {
        WarmItem { value: None, block: 0, at: f64::NEG_INFINITY, same: 0, changed: false, sent: false }
    }
}

/// What one question reads from here (see USE).
pub struct WarmLayer {
    /// The copy version with the warm values added (only where it held nothing).
    pub snap: Arc<Snapshot>,
    pub slots: HashSet<(Address, U256)>,
    pub accts: HashSet<Address>,
    /// Per value used: (item, node block, stable).
    pub items: Vec<(MissItem, u64, bool)>,
}

/// Counters (status "warm").
#[derive(Default, Clone, Debug)]
pub struct WarmStats {
    pub learned: u64,
    pub fetched_once: u64,
    pub refresh_touch: u64,
    pub refresh_timer: u64,
    pub values_stored: u64,
    pub values_changed: u64,
    pub fetch_failed: u64,
    pub cap_dropped: u64,
    pub expired: u64,
    pub refused: u64,
    pub calls: u64,
    pub requests: u64,
    pub jobs: u64,
    pub layers_built: u64,
    pub questions_used: u64,
    pub dirty_dropped: u64,
}

/// The warm values and what to do next (see the file header).
pub struct WarmState {
    pub cfg: WarmCfg,
    items: HashMap<MissItem, WarmItem>,
    recipes: HashMap<Address, Vec<MissItem>>,
    hot: Vec<Address>,
    /// Owner -> feed positions (sequence numbers) of transactions TO it (newest last).
    touches: HashMap<Address, VecDeque<u64>>,
    pub last_feed_seq: u64,
    hour_start: Option<f64>,
    pub hour_used: u64,
    /// (time, calls) of the last hour's fetches (calls an hour, rolling).
    recent: VecDeque<(f64, u64)>,
    gen: u64,
    cache: Option<(usize, u64, u64, Arc<WarmLayer>)>,
    pub stats: WarmStats,
}

impl WarmState {
    pub fn new(cfg: WarmCfg) -> Self {
        WarmState {
            cfg,
            items: HashMap::new(),
            recipes: HashMap::new(),
            hot: Vec::new(),
            touches: HashMap::new(),
            last_feed_seq: 0,
            hour_start: None,
            hour_used: 0,
            recent: VecDeque::new(),
            gen: 0,
            cache: None,
            stats: WarmStats::default(),
        }
    }

    pub fn on(&self) -> bool {
        self.cfg.on
    }

    pub fn is_hot(&self, t: &Address) -> bool {
        self.hot.contains(t)
    }

    pub fn hot(&self) -> &[Address] {
        &self.hot
    }

    /// LEARN: a fire-first question about a transaction to `target` lacked `items`.
    pub fn learn(&mut self, target: Address, items: &[MissItem]) {
        if !self.cfg.on || items.is_empty() {
            return;
        }
        let per = self.cfg.per_target;
        let hot = self.is_hot(&target);
        let r = self.recipes.entry(target).or_default();
        let mut added = Vec::new();
        for m in items {
            if matches!(m, MissItem::Code(_)) || r.contains(m) || r.len() >= per {
                continue;
            }
            r.push(m.clone());
            added.push(m.clone());
        }
        self.stats.learned += added.len() as u64;
        if hot {
            for m in added {
                if self.items.len() < self.cfg.max_items {
                    self.items.entry(m).or_insert_with(WarmItem::new);
                }
            }
        }
        // Recipes of targets that never get hot: bounded.
        if self.recipes.len() > 4 * self.cfg.targets.max(1) + 200 {
            let hot = self.hot.clone();
            if let Some(k) = self.recipes.keys().find(|k| !hot.contains(k)).copied() {
                self.recipes.remove(&k);
            }
        }
    }

    /// The hot targets (best first; at most cfg.targets are kept warm).
    pub fn set_hot(&mut self, list: &[Address]) {
        if !self.cfg.on {
            return;
        }
        let new: Vec<Address> = list.iter().take(self.cfg.targets).copied().collect();
        if new == self.hot {
            return;
        }
        self.hot = new;
        let want: HashSet<MissItem> = self.hot.iter().filter_map(|t| self.recipes.get(t)).flatten().cloned().collect();
        let before = self.items.len();
        self.items.retain(|k, _| want.contains(k));
        let mut changed = self.items.len() != before;
        for m in want {
            if self.items.len() >= self.cfg.max_items {
                break;
            }
            if !self.items.contains_key(&m) {
                self.items.insert(m, WarmItem::new());
                changed = true;
            }
        }
        if changed {
            self.gen += 1;
        }
    }

    /// A feed transaction at `seq` went TO `to`.
    pub fn touch(&mut self, to: Address, seq: u64) {
        if !self.cfg.on {
            return;
        }
        let q = self.touches.entry(to).or_default();
        if q.back().is_none_or(|b| *b < seq) {
            q.push_back(seq);
        }
        while q.len() > 16 {
            q.pop_front();
        }
        self.last_feed_seq = self.last_feed_seq.max(seq);
        if self.touches.len() > 50_000 {
            let keep: HashSet<Address> = self.items.keys().filter_map(owner).collect();
            self.touches.retain(|a, _| keep.contains(a));
        }
    }

    fn stable(&self, w: &WarmItem) -> bool {
        !w.changed && w.same >= self.cfg.stable_after
    }

    /// Touched (a feed transaction to its contract) after the block it was
    /// read at and before feed position `upto` (the trigger's message: the
    /// trigger itself, and anything after it, never counts against it).
    fn touched_after(&self, m: &MissItem, w: &WarmItem, l2: u64, upto: u64) -> bool {
        let from = w.block.saturating_sub(l2);
        owner(m).and_then(|o| self.touches.get(&o)).is_some_and(|q| q.iter().any(|s| *s > from && *s < upto))
    }

    /// May this value be used for a trigger in feed message `upto`
    /// (ignoring the question's own transactions)?
    fn usable(&self, m: &MissItem, w: &WarmItem, now: f64, l2: u64, upto: u64) -> bool {
        w.value.is_some() && now - w.at <= self.cfg.max_age_s && (self.stable(w) || !self.touched_after(m, w, l2, upto))
    }

    /// Values past their window are dropped (never used stale).
    pub fn sweep(&mut self, now: f64) {
        let max = self.cfg.max_age_s;
        let mut n = 0;
        for w in self.items.values_mut() {
            if w.value.is_some() && now - w.at > max {
                w.value = None;
                n += 1;
            }
        }
        if n > 0 {
            self.stats.expired += n;
            self.gen += 1;
        }
    }

    /// The values to fetch now (one-time / touched and not stable / timer),
    /// at most cfg.batch; marked as sent.
    pub fn due(&mut self, now: f64, l2: u64) -> Vec<MissItem> {
        if !self.cfg.on {
            return Vec::new();
        }
        let mut once = Vec::new();
        let mut touched = Vec::new();
        let mut timer = Vec::new();
        for (m, w) in &self.items {
            if w.sent {
                continue;
            }
            if w.value.is_none() && w.at == f64::NEG_INFINITY {
                once.push(m.clone());
            } else if now - w.at >= self.cfg.timer_s {
                timer.push(m.clone());
            } else if !self.stable(w) && self.touched_after(m, w, l2, u64::MAX) {
                touched.push(m.clone());
            }
        }
        let mut out = Vec::new();
        for (list, which) in [(touched, 1u8), (once, 0), (timer, 2)] {
            for m in list {
                if out.len() >= self.cfg.batch {
                    break;
                }
                match which {
                    0 => self.stats.fetched_once += 1,
                    1 => self.stats.refresh_touch += 1,
                    _ => self.stats.refresh_timer += 1,
                }
                out.push(m);
            }
        }
        for m in &out {
            if let Some(w) = self.items.get_mut(m) {
                w.sent = true;
            }
        }
        out
    }

    /// Values copy 2 won't warm (it follows them itself): forgotten.
    pub fn refuse(&mut self, items: &[MissItem]) {
        for m in items {
            if self.items.remove(m).is_some() {
                self.stats.refused += 1;
            }
            for r in self.recipes.values_mut() {
                r.retain(|x| x != m);
            }
        }
        if !items.is_empty() {
            self.gen += 1;
        }
    }

    /// Hard hourly cap: may `calls` more be used now? (true = counted.)
    pub fn charge(&mut self, calls: u64, requests: u64, now: f64) -> bool {
        if self.hour_start.is_none_or(|h| now - h >= 3600.0) {
            self.hour_start = Some(now);
            self.hour_used = 0;
        }
        if self.hour_used + calls > self.cfg.per_hour {
            return false;
        }
        self.hour_used += calls;
        self.stats.calls += calls;
        self.stats.requests += requests;
        self.stats.jobs += 1;
        self.recent.push_back((now, calls));
        while self.recent.front().is_some_and(|x| now - x.0 > 3600.0) {
            self.recent.pop_front();
        }
        true
    }

    /// FAIL CLOSED: the cap left no room for these refreshes: dropped.
    pub fn cap_hit(&mut self, items: &[MissItem], now: f64) {
        for m in items {
            if let Some(w) = self.items.get_mut(m) {
                w.sent = false;
                w.value = None;
                self.stats.cap_dropped += 1;
                // Not asked again before the next timer round.
                w.at = now;
            }
        }
        self.gen += 1;
    }

    /// Answers of a fetch at node block `block` (None = could not be read: dropped).
    pub fn store(&mut self, block: u64, now: f64, res: &[(MissItem, Option<Fetched>)]) {
        for (m, f) in res {
            let Some(w) = self.items.get_mut(m) else { continue };
            w.sent = false;
            match f {
                Some(f) => {
                    match &w.value {
                        Some(old) if old == f => w.same += 1,
                        Some(_) => {
                            w.changed = true;
                            w.same = 0;
                            self.stats.values_changed += 1;
                        }
                        None => {}
                    }
                    w.value = Some(f.clone());
                    w.block = block;
                    w.at = now;
                    self.stats.values_stored += 1;
                }
                None => {
                    w.value = None;
                    w.at = now;
                    self.stats.fetch_failed += 1;
                }
            }
        }
        self.gen += 1;
    }

    /// A fetch job failed as a whole: those values are asked again later.
    pub fn unsend(&mut self, items: &[MissItem]) {
        for m in items {
            if let Some(w) = self.items.get_mut(m) {
                w.sent = false;
            }
        }
    }

    /// USE: the layer for one question on copy version `base` about a
    /// trigger in feed message `trig_seq` (see the file header). `before`:
    /// the question's transactions BEFORE the trigger, (sequence number,
    /// target): a value (not stable) whose contract one of them goes to is
    /// left out. None = nothing to add.
    pub fn layer(&mut self, base: &Arc<Snapshot>, now: f64, l2: u64, trig_seq: u64, before: &[(u64, Option<Address>)]) -> Option<Arc<WarmLayer>> {
        if !self.cfg.on || self.items.is_empty() {
            return None;
        }
        // Values the question's own earlier transactions may have changed.
        let mut skip: HashSet<MissItem> = HashSet::new();
        if !before.is_empty() {
            for (m, w) in &self.items {
                if w.value.is_none() || self.stable(w) {
                    continue;
                }
                let (from, o) = (w.block.saturating_sub(l2), owner(m));
                if before.iter().any(|(s, to)| *s > from && to.is_some() && *to == o) {
                    skip.insert(m.clone());
                }
            }
        }
        let key = (Arc::as_ptr(base) as usize, self.gen, trig_seq);
        if skip.is_empty() {
            if let Some((p, g, q, l)) = &self.cache {
                if (*p, *g, *q) == key && l.items.iter().all(|(m, _, _)| self.items.get(m).is_some_and(|w| self.usable(m, w, now, l2, trig_seq))) {
                    return (!l.items.is_empty()).then(|| l.clone());
                }
            }
        } else {
            self.stats.dirty_dropped += skip.len() as u64;
        }
        let mut s = (**base).clone();
        let (mut slots, mut accts, mut used) = (HashSet::new(), HashSet::new(), Vec::new());
        for (m, w) in &self.items {
            if skip.contains(m) || !self.usable(m, w, now, l2, trig_seq) {
                continue;
            }
            let Some(f) = &w.value else { continue };
            match f {
                Fetched::Slot(a, k, v) => {
                    if matches!(base.storage(*a, *k), Lookup::Missing) {
                        s.apply_fact(&Fact::Slot(*a, *k, *v));
                        slots.insert((*a, *k));
                        used.push((m.clone(), w.block, self.stable(w)));
                    }
                }
                Fetched::Account(a, acc) => {
                    if matches!(base.account(*a), Lookup::Missing) {
                        let (info, code) = crate::state::fill::account_info(acc.as_ref());
                        // Basics only: an empty account must not wipe slots the copy holds.
                        if info.is_some() || !base.holds_storage(a) {
                            s.apply_fact(&Fact::Basics { addr: *a, info, code });
                            accts.insert(*a);
                            used.push((m.clone(), w.block, self.stable(w)));
                        }
                    }
                }
            }
        }
        self.stats.layers_built += 1;
        let l = Arc::new(WarmLayer { snap: Arc::new(s), slots, accts, items: used });
        if skip.is_empty() {
            self.cache = Some((key.0, key.1, key.2, l.clone()));
        }
        (!l.items.is_empty()).then_some(l)
    }

    /// Calls in the last hour (rolling).
    pub fn calls_last_hour(&self) -> u64 {
        self.recent.iter().map(|x| x.1).sum()
    }

    pub fn json(&self, now: f64, l2: u64) -> Value {
        let held = self.items.values().filter(|w| w.value.is_some()).count();
        let usable = self.items.iter().filter(|(m, w)| self.usable(m, w, now, l2, u64::MAX)).count();
        let stable = self.items.values().filter(|w| self.stable(w)).count();
        let changing = self.items.values().filter(|w| w.changed).count();
        let s = &self.stats;
        json!({
            "on": self.cfg.on, "targets": self.cfg.targets, "perHour": self.cfg.per_hour, "timerS": self.cfg.timer_s, "maxAgeS": self.cfg.max_age_s, "stableAfter": self.cfg.stable_after,
            "hot": self.hot.iter().map(|a| json!([format!("{a:#x}"), self.recipes.get(a).map_or(0, |r| r.len())])).collect::<Vec<_>>(),
            "recipes": self.recipes.len(), "values": self.items.len(), "held": held, "usableNow": usable, "stable": stable, "changing": changing,
            "callsThisHour": self.hour_used, "callsLastHour": self.calls_last_hour(), "calls": s.calls, "nodeRequests": s.requests, "jobs": s.jobs,
            "learned": s.learned, "fetchedOnce": s.fetched_once, "refreshTouch": s.refresh_touch, "refreshTimer": s.refresh_timer,
            "stored": s.values_stored, "cameBackDifferent": s.values_changed, "fetchFailed": s.fetch_failed, "capDropped": s.cap_dropped,
            "expired": s.expired, "refusedFollowedByCopy2": s.refused, "layersBuilt": s.layers_built, "questionsUsedWarm": s.questions_used, "leftOutTouchedInQuestion": s.dirty_dropped,
        })
    }
}

/// Copy 2's provenance with every warm value marked NOT exact (labelled
/// "recent fill" by the checks, never exact).
pub struct WarmProv {
    pub inner: Arc<dyn crate::check::ordered::Provenance + Send + Sync>,
    pub layer: Arc<WarmLayer>,
}

impl crate::check::ordered::Provenance for WarmProv {
    fn slot_exact(&self, a: Address, s: U256) -> bool {
        !self.layer.slots.contains(&(a, s)) && self.inner.slot_exact(a, s)
    }
    fn balance_exact(&self, a: Address) -> bool {
        !self.layer.accts.contains(&a) && self.inner.balance_exact(a)
    }
}

/// Node calls of a fetch job, the way the loader counts them (one
/// eth_getProof per account), plus the plain count (1 per slot, 3 per account).
pub fn job_cost(items: &[MissItem]) -> (u64, u64) {
    let accounts: HashSet<Address> = items.iter().filter_map(owner).collect();
    let plain: u64 = items.iter().map(|m| match m {
        MissItem::Slot(..) => 1,
        MissItem::Account(_) => 3,
        MissItem::Code(_) => 0,
    }).sum();
    (accounts.len() as u64, plain)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::FetchedAccount;

    fn cfg() -> WarmCfg {
        WarmCfg { per_hour: 1000, ..WarmCfg::default() }
    }

    #[test]
    fn learn_fetch_once_refresh_only_what_changes() {
        let (t, c) = (Address::repeat_byte(0x11), Address::repeat_byte(0x22));
        let s1 = MissItem::Slot(c, U256::from(1u8));
        let s2 = MissItem::Slot(c, U256::from(2u8));
        let mut w = WarmState::new(cfg());
        // Learned before the target is hot: remembered, not fetched.
        w.learn(t, &[s1.clone(), s2.clone()]);
        assert!(w.due(0.0, 0).is_empty());
        w.set_hot(&[t]);
        let d = w.due(0.0, 0);
        assert_eq!(d.len(), 2, "fetched once");
        assert!(w.due(0.0, 0).is_empty(), "not twice while on its way");
        w.store(100, 0.0, &[(s1.clone(), Some(Fetched::Slot(c, U256::from(1u8), U256::from(5u8)))), (s2.clone(), Some(Fetched::Slot(c, U256::from(2u8), U256::from(7u8))))]);
        let base = Arc::new(Snapshot::default());
        let l = w.layer(&base, 1.0, 0, 1_000, &[]).expect("layer");
        assert_eq!(l.items.len(), 2);
        assert!(matches!(l.snap.storage(c, U256::from(1u8)), Lookup::Known(v) if v == U256::from(5u8)));
        // A feed transaction to c after block 100: both not stable yet -> re-read, not used meanwhile.
        w.touch(c, 101);
        assert!(w.layer(&base, 1.5, 0, 101, &[]).is_some(), "the trigger itself (message 101) never counts against its own values");
        assert!(w.layer(&base, 1.5, 0, 1_000, &[]).is_none(), "touched values are never used before the re-read");
        assert_eq!(w.due(2.0, 0).len(), 2);
        // s1 comes back the same, s2 different.
        w.store(101, 2.0, &[(s1.clone(), Some(Fetched::Slot(c, U256::from(1u8), U256::from(5u8)))), (s2.clone(), Some(Fetched::Slot(c, U256::from(2u8), U256::from(8u8))))]);
        // Make s1 stable (same 3 times); s2 keeps changing.
        for (i, b) in [(3.0, 102u64), (4.0, 103)] {
            w.touch(c, b);
            let d = w.due(i, 0);
            assert_eq!(d.len(), 2);
            w.store(b, i, &[(s1.clone(), Some(Fetched::Slot(c, U256::from(1u8), U256::from(5u8)))), (s2.clone(), Some(Fetched::Slot(c, U256::from(2u8), U256::from(9u8 + b as u8))))]);
        }
        w.touch(c, 104);
        let d = w.due(5.0, 0);
        assert_eq!(d, vec![s2.clone()], "the stable value moves to the timer only");
        // Timer: everything after 60 s.
        w.store(104, 5.0, &[(s2.clone(), Some(Fetched::Slot(c, U256::from(2u8), U256::from(1u8))))]);
        assert_eq!(w.due(65.0, 0).len(), 2);
        let j = w.json(65.0, 0);
        assert_eq!((j["stable"].clone(), j["changing"].clone()), (json!(1), json!(1)), "{j}");
    }

    #[test]
    fn stale_values_are_missing_and_the_cap_fails_closed() {
        let (t, c) = (Address::repeat_byte(0x11), Address::repeat_byte(0x22));
        let s1 = MissItem::Slot(c, U256::from(1u8));
        let acc = MissItem::Account(c);
        let mut w = WarmState::new(WarmCfg { per_hour: 4, ..cfg() });
        w.set_hot(&[t]);
        w.learn(t, &[s1.clone(), acc.clone()]);
        let d = w.due(0.0, 0);
        let (req, calls) = job_cost(&d);
        assert_eq!((req, calls), (1, 4), "one proof for the account");
        assert!(w.charge(calls, req, 0.0));
        w.store(10, 0.0, &[(s1.clone(), Some(Fetched::Slot(c, U256::from(1u8), U256::from(3u8)))), (acc.clone(), Some(Fetched::Account(c, Some(FetchedAccount { balance: U256::ZERO, nonce: 1, code: vec![0x00].into() }))))]);
        let base = Arc::new(Snapshot::default());
        assert!(w.layer(&base, 10.0, 0, 1_000, &[]).is_some());
        // Past ARBSIM_WARM_MAX_AGE_S (90): missing, even before a sweep.
        assert!(w.layer(&base, 91.0, 0, 1_000, &[]).is_none(), "never used stale");
        w.sweep(91.0);
        assert_eq!(w.stats.expired, 2);
        // The cap: 4 used of 4 this hour; the timer refresh doesn't fit -> dropped.
        let d = w.due(91.0, 0);
        assert_eq!(d.len(), 2);
        let (r, c2) = job_cost(&d);
        assert!(!w.charge(c2, r, 91.0));
        w.cap_hit(&d, 91.0);
        assert!(w.due(92.0, 0).is_empty(), "not asked again before the timer");
        assert!(w.layer(&base, 92.0, 0, 1_000, &[]).is_none());
        // A question whose earlier transaction goes to c leaves c's (not
        // stable) values out; the copy's own values always win.
        let mut w = WarmState::new(cfg());
        w.set_hot(&[t]);
        w.learn(t, &[s1.clone()]);
        w.due(0.0, 0);
        w.store(10, 0.0, &[(s1.clone(), Some(Fetched::Slot(c, U256::from(1u8), U256::from(3u8))))]);
        assert!(w.layer(&base, 1.0, 0, 1_000, &[(11, Some(c))]).is_none(), "left out for this question");
        assert!(w.layer(&base, 1.0, 0, 1_000, &[(10, Some(c))]).is_some(), "a transaction at or before its block is in the value");
        let mut held = Snapshot::default();
        held.apply_fact(&Fact::Slot(c, U256::from(1u8), U256::from(99u8)));
        let held = Arc::new(held);
        assert!(w.layer(&held, 1.0, 0, 1_000, &[]).is_none(), "copy 2's own value wins");
        // FASTLANE off: nothing at all.
        let off = WarmCfg::from_lookup(|k| (k == "FASTLANE").then(|| "off".to_string()));
        assert!(!off.on);
        let mut w = WarmState::new(off);
        w.set_hot(&[t]);
        w.learn(t, &[s1.clone()]);
        assert!(w.due(0.0, 0).is_empty() && w.layer(&base, 0.0, 0, 1_000, &[]).is_none());
        assert!(WarmCfg::from_lookup(|k| (k == "FASTLANE").then(|| "practice".to_string())).on);
    }
}
