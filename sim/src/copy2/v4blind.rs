// ============================================================================
// V4 BLIND SPOT (Oct 25, 2026)
//
// Plain English:
//   Live Oct 25 (engine up ~1.7 h) copy 2 refused 38,950 PoolManager values
//   that checks needed, all with the same vague reason: "a PoolManager slot
//   that is not a base slot of one of our V4 pools". That covers three very
//   different things:
//     (a) data of a V4 pool we DON'T follow at all (someone traded in it);
//     (b) a tick / tick-map word of one of OUR V4 pools that lies beyond
//         the stretch of ticks our walk loaded (a big swap went far);
//     (c) other PoolManager data (positions, coin deltas, claims, ...).
//   We couldn't tell them apart because a V4 storage place is a hash. Now
//   each check that misses a value sends along the inputs of the hashes
//   that name it (check/moved.rs resolve_v4_slot), and this book remembers
//   WHOSE value each such slot is. That gives:
//     1. Status counters per class (a / b / c / "don't know") and a short
//        list of the unfollowed V4 pools checks keep running into.
//     2. Fix (b): a tick / tick-map word of one of OUR pools is fetched and
//        kept like the walked ones (intake.rs dispatch_fills / on_fill). It
//        stays exact because every event of that pool is applied to the
//        copy (a replay that needs a value it doesn't hold asks for it
//        first and takes the pool out of "ready" meanwhile), and it is
//        forgotten together with the pool's other values if the pool goes
//        unsure. Setting ARBSIM_V4_FAR_FILL (default ON).
//     3. Fix (a): AUTO-FOLLOW. A V4 pool we don't follow whose values
//        checks missed at least ARBSIM_V4_AUTOFOLLOW_MIN_MISSES times within
//        ARBSIM_V4_AUTOFOLLOW_WINDOW_S is put on a list in status
//        (copy2.v4Blind.autoFollow.ids). The BOT reads that list, looks up
//        the pool's key (its Initialize event), and if it is a plain pool
//        (no hook) follows it like any watched pool (events subscription +
//        track). At most ARBSIM_V4_AUTOFOLLOW_MAX pools; a listed pool drops
//        off after ARBSIM_V4_AUTOFOLLOW_KEEP_S with no use (no miss, no feed
//        transaction moving it). Setting ARBSIM_V4_AUTOFOLLOW (default OFF
//        until reviewed: it adds node and WebSocket load).
//
// Settings (.env, the sidecar's):
//   ARBSIM_V4_FAR_FILL=1                 fix (b) on (0 = refuse, as before)
//   ARBSIM_V4_FAR_MAX=2000               most kept PoolManager values per pool
//   ARBSIM_V4_AUTOFOLLOW=0               fix (a) off (1 = list pools for the bot)
//   ARBSIM_V4_AUTOFOLLOW_MIN_MISSES=20   checks that missed the pool ...
//   ARBSIM_V4_AUTOFOLLOW_WINDOW_S=600    ... within this many seconds
//   ARBSIM_V4_AUTOFOLLOW_MAX=200         most pools listed at once
//   ARBSIM_V4_AUTOFOLLOW_KEEP_S=1800     listed this long after last use
// ============================================================================
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use revm::primitives::{Address, B256, U256};
use serde_json::{json, Value};

use crate::check::moved::{resolve_v4_slot, PreMap, V4Part};
use crate::node::env_u64;

/// Settings (see the file header).
#[derive(Clone, Debug)]
pub struct BlindCfg {
    pub far_fill: bool,
    pub far_max_per_pool: usize,
    pub autofollow: bool,
    pub af_min_misses: usize,
    pub af_window: Duration,
    pub af_max: usize,
    pub af_keep: Duration,
}

impl BlindCfg {
    pub fn from_env() -> Self {
        BlindCfg {
            far_fill: env_u64("ARBSIM_V4_FAR_FILL", 1) != 0,
            far_max_per_pool: env_u64("ARBSIM_V4_FAR_MAX", 2000).clamp(1, 1_000_000) as usize,
            autofollow: env_u64("ARBSIM_V4_AUTOFOLLOW", 0) != 0,
            af_min_misses: env_u64("ARBSIM_V4_AUTOFOLLOW_MIN_MISSES", 20).clamp(1, 1_000_000) as usize,
            af_window: Duration::from_secs(env_u64("ARBSIM_V4_AUTOFOLLOW_WINDOW_S", 600).clamp(10, 86_400)),
            af_max: env_u64("ARBSIM_V4_AUTOFOLLOW_MAX", 200).min(5_000) as usize,
            af_keep: Duration::from_secs(env_u64("ARBSIM_V4_AUTOFOLLOW_KEEP_S", 1800).clamp(60, 7 * 86_400)),
        }
    }
    pub fn for_tests() -> Self {
        BlindCfg {
            far_fill: true,
            far_max_per_pool: 2000,
            autofollow: false,
            af_min_misses: 3,
            af_window: Duration::from_secs(600),
            af_max: 200,
            af_keep: Duration::from_secs(1800),
        }
    }
}

/// What a missed PoolManager slot is (see the file header).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PmClass {
    /// One of the 4 base fields of one of our pools (loaded with the pool).
    OwnBase(B256),
    /// (b) a tick / tick-map word of one of our pools (beyond the walk).
    OwnFar(B256),
    /// (a) any data of a V4 pool we don't follow.
    Unfollowed(B256),
    /// (c) other PoolManager data (a position, deltas, claims, settings).
    Other,
    /// No hash inputs known for it (e.g. a plain eth_call check, which
    /// doesn't record them, with no recent trigger-first check naming it).
    Unknown,
}

impl PmClass {
    /// Short label (status / blockedBy).
    pub fn label(&self) -> &'static str {
        match self {
            PmClass::OwnBase(_) => "a base field of our V4 pool (loaded with the pool)",
            PmClass::OwnFar(_) => "a tick / tick-map word of our V4 pool beyond the walk",
            PmClass::Unfollowed(_) => "data of a V4 pool we don't follow",
            PmClass::Other => "other PoolManager data (position / deltas / claims / settings)",
            PmClass::Unknown => "PoolManager value nobody named yet (no hash inputs recorded)",
        }
    }
}

/// Class of `owner` (resolve_v4_slot's answer) given which pools we follow.
pub fn classify(owner: Option<(B256, V4Part)>, followed: impl Fn(B256) -> bool) -> PmClass {
    match owner {
        None => PmClass::Unknown,
        // Positions are never needed by a swap and never followed.
        Some((_, V4Part::Position)) => PmClass::Other,
        Some((id, part)) if followed(id) => match part {
            V4Part::Base(_) => PmClass::OwnBase(id),
            _ => PmClass::OwnFar(id),
        },
        Some((id, _)) => PmClass::Unfollowed(id),
    }
}

/// One V4 pool we don't follow that checks ran into.
#[derive(Clone, Debug)]
struct Unf {
    pm: Address,
    /// Checks that missed one of its values (one per check), since start.
    total: u64,
    /// When, the most recent ones (at most af_min_misses * 2 kept).
    recent: VecDeque<Instant>,
    last: Instant,
}

/// Most slots remembered by name (then forgotten all at once: they are
/// named again by the next check that misses them).
const MAX_OWNERS: usize = 200_000;
/// Most unfollowed pools remembered.
const MAX_UNF: usize = 4096;

/// The book (behind one lock in C2Shared).
pub struct PmBook {
    pub cfg: BlindCfg,
    /// (PoolManager, slot) -> whose value it is.
    owners: HashMap<(Address, U256), (B256, V4Part)>,
    unf: HashMap<B256, Unf>,
    /// Pools on the auto-follow list -> listed until (extended by use).
    auto: HashMap<B256, Instant>,
    /// Pools ever put on the list / dropped from it (status).
    pub auto_added: u64,
    pub auto_expired: u64,
    /// Pools that met the threshold while the list was full.
    pub auto_full: u64,
}

impl PmBook {
    pub fn new(cfg: BlindCfg) -> Self {
        PmBook { cfg, owners: HashMap::new(), unf: HashMap::new(), auto: HashMap::new(), auto_added: 0, auto_expired: 0, auto_full: 0 }
    }

    /// Name (pm, slot) from the hash inputs `pre` (remembered), else from
    /// what an earlier check told us. true in the second value = newly named.
    pub fn learn(&mut self, pm: Address, slot: U256, pre: &PreMap) -> (Option<(B256, V4Part)>, bool) {
        if !pre.is_empty() {
            if let Some(o) = resolve_v4_slot(slot, pre) {
                if self.owners.len() >= MAX_OWNERS && !self.owners.contains_key(&(pm, slot)) {
                    self.owners.clear();
                }
                let new = self.owners.insert((pm, slot), o).is_none();
                return (Some(o), new);
            }
        }
        (self.owner(pm, slot), false)
    }

    /// Whose value (pm, slot) is, if a check named it.
    pub fn owner(&self, pm: Address, slot: U256) -> Option<(B256, V4Part)> {
        self.owners.get(&(pm, slot)).copied()
    }

    pub fn named(&self) -> usize {
        self.owners.len()
    }

    /// A check missed a value of the unfollowed pool `id` (count once per
    /// check). Puts it on the auto-follow list when it meets the threshold
    /// (and auto-follow is on and the list has room).
    pub fn note_unfollowed(&mut self, pm: Address, id: B256, now: Instant) {
        let keep = self.cfg.af_min_misses.saturating_mul(2).max(4);
        let window = self.cfg.af_window;
        let e = self.unf.entry(id).or_insert_with(|| Unf { pm, total: 0, recent: VecDeque::new(), last: now });
        e.total += 1;
        e.last = now;
        e.recent.push_back(now);
        while e.recent.len() > keep {
            e.recent.pop_front();
        }
        while e.recent.front().is_some_and(|t| now.saturating_duration_since(*t) > window) {
            e.recent.pop_front();
        }
        let hot = e.recent.len() >= self.cfg.af_min_misses;
        if self.cfg.autofollow && hot {
            if let Some(until) = self.auto.get_mut(&id) {
                *until = now + self.cfg.af_keep;
            } else {
                self.expire(now);
                if self.auto.len() < self.cfg.af_max {
                    self.auto.insert(id, now + self.cfg.af_keep);
                    self.auto_added += 1;
                } else {
                    self.auto_full += 1;
                }
            }
        }
        if self.unf.len() > MAX_UNF {
            self.trim_unf(now);
        }
    }

    /// A listed pool was used (a check missed its values while it loads, or
    /// a feed transaction moved it): keep it listed longer.
    pub fn note_used(&mut self, id: &B256, now: Instant) {
        if let Some(until) = self.auto.get_mut(id) {
            *until = (*until).max(now + self.cfg.af_keep);
        }
    }

    pub fn is_auto(&self, id: &B256) -> bool {
        self.auto.contains_key(id)
    }

    fn expire(&mut self, now: Instant) {
        let before = self.auto.len();
        self.auto.retain(|_, until| *until > now);
        self.auto_expired += (before - self.auto.len()) as u64;
    }

    /// The auto-follow list (pool ids, lowercase hex, most missed first).
    /// Empty while auto-follow is off.
    pub fn want(&mut self, now: Instant) -> Vec<String> {
        if !self.cfg.autofollow {
            return Vec::new();
        }
        self.expire(now);
        let mut v: Vec<(u64, B256)> = self.auto.keys().map(|id| (self.unf.get(id).map(|u| u.total).unwrap_or(0), *id)).collect();
        v.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        v.into_iter().map(|(_, id)| format!("{id:#x}")).collect()
    }

    /// Forget pools not seen for an hour; then the least recently seen.
    fn trim_unf(&mut self, now: Instant) {
        let auto = &self.auto;
        self.unf.retain(|id, u| auto.contains_key(id) || now.saturating_duration_since(u.last) < Duration::from_secs(3600));
        if self.unf.len() > MAX_UNF {
            let mut by_last: Vec<(Instant, B256)> = self.unf.iter().filter(|(id, _)| !auto.contains_key(*id)).map(|(id, u)| (u.last, *id)).collect();
            by_last.sort();
            let extra = self.unf.len() - MAX_UNF * 9 / 10;
            for (_, id) in by_last.into_iter().take(extra) {
                self.unf.remove(&id);
            }
        }
    }

    /// Status `copy2.v4Blind` (without the counters, which are in
    /// `copy2.counters`): settings, the top 20 unfollowed pools by misses,
    /// and the auto-follow list the bot reads.
    pub fn status(&mut self, now: Instant) -> Value {
        let window = self.cfg.af_window;
        let mut top: Vec<(&B256, &Unf)> = self.unf.iter().collect();
        top.sort_by(|a, b| b.1.total.cmp(&a.1.total).then(a.0.cmp(b.0)));
        let top: Vec<Value> = top
            .into_iter()
            .take(20)
            .map(|(id, u)| {
                let recent = u.recent.iter().filter(|t| now.saturating_duration_since(**t) <= window).count();
                json!({ "id": format!("{id:#x}"), "pm": format!("{:#x}", u.pm), "misses": u.total, "recent": recent,
                        "lastAgoS": now.saturating_duration_since(u.last).as_secs(), "autoFollow": self.auto.contains_key(id) })
            })
            .collect();
        let ids = self.want(now);
        json!({
            "farFill": self.cfg.far_fill,
            "farMaxPerPool": self.cfg.far_max_per_pool,
            "namedSlots": self.owners.len(),
            "unfollowedPools": self.unf.len(),
            "topUnfollowed": top,
            "autoFollow": {
                "on": self.cfg.autofollow,
                "minMisses": self.cfg.af_min_misses,
                "windowS": self.cfg.af_window.as_secs(),
                "max": self.cfg.af_max,
                "keepS": self.cfg.af_keep.as_secs(),
                "added": self.auto_added,
                "expired": self.auto_expired,
                "listFull": self.auto_full,
                "ids": ids,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use revm::primitives::keccak256;

    fn h2(a: U256, b: U256) -> U256 {
        let mut x = [0u8; 64];
        x[..32].copy_from_slice(&a.to_be_bytes::<32>());
        x[32..].copy_from_slice(&b.to_be_bytes::<32>());
        U256::from_be_bytes(keccak256(x).0)
    }

    fn tick_of(id: B256, tick: u64) -> (PreMap, U256) {
        let idw = U256::from_be_bytes(id.0);
        let base = h2(idw, U256::from(6u8));
        let t = h2(U256::from(tick), base + U256::from(4u8));
        let mut pre = PreMap::new();
        pre.insert(base, (idw, U256::from(6u8)));
        pre.insert(t, (U256::from(tick), base + U256::from(4u8)));
        (pre, t)
    }

    const PM: Address = Address::repeat_byte(0x83);

    #[test]
    fn classes() {
        let ours = B256::repeat_byte(1);
        let theirs = B256::repeat_byte(2);
        let f = |id: B256| id == ours;
        assert_eq!(classify(Some((ours, V4Part::Tick)), f), PmClass::OwnFar(ours));
        assert_eq!(classify(Some((ours, V4Part::Bitmap)), f), PmClass::OwnFar(ours));
        assert_eq!(classify(Some((ours, V4Part::Base(0))), f), PmClass::OwnBase(ours));
        assert_eq!(classify(Some((theirs, V4Part::Base(0))), f), PmClass::Unfollowed(theirs));
        assert_eq!(classify(Some((theirs, V4Part::Tick)), f), PmClass::Unfollowed(theirs));
        assert_eq!(classify(Some((ours, V4Part::Position)), f), PmClass::Other);
        assert_eq!(classify(None, f), PmClass::Unknown);
    }

    #[test]
    fn remembers_who_owns_a_slot() {
        let mut b = PmBook::new(BlindCfg::for_tests());
        let id = B256::repeat_byte(9);
        let (pre, slot) = tick_of(id, 77);
        assert_eq!(b.learn(PM, slot, &pre), (Some((id, V4Part::Tick)), true));
        // A later fill / warm of the same slot has no hash inputs: still named.
        assert_eq!(b.learn(PM, slot, &PreMap::new()), (Some((id, V4Part::Tick)), false));
        assert_eq!(b.owner(PM, slot), Some((id, V4Part::Tick)));
        assert_eq!(b.owner(Address::ZERO, slot), None, "per PoolManager");
    }

    #[test]
    fn autofollow_off_lists_nothing_but_counts() {
        let mut b = PmBook::new(BlindCfg::for_tests());
        let id = B256::repeat_byte(5);
        let now = Instant::now();
        for _ in 0..10 {
            b.note_unfollowed(PM, id, now);
        }
        assert!(b.want(now).is_empty());
        let st = b.status(now);
        assert_eq!(st["topUnfollowed"][0]["misses"], json!(10));
        assert_eq!(st["autoFollow"]["on"], json!(false));
    }

    #[test]
    fn autofollow_threshold_window_cap_and_expiry() {
        let mut cfg = BlindCfg::for_tests();
        cfg.autofollow = true;
        cfg.af_min_misses = 3;
        cfg.af_window = Duration::from_secs(60);
        cfg.af_max = 2;
        cfg.af_keep = Duration::from_secs(300);
        let mut b = PmBook::new(cfg);
        let t0 = Instant::now();
        let (a, c, d) = (B256::repeat_byte(0xa), B256::repeat_byte(0xc), B256::repeat_byte(0xd));
        // 3 misses spread over more than the window: not enough.
        b.note_unfollowed(PM, a, t0);
        b.note_unfollowed(PM, a, t0 + Duration::from_secs(50));
        b.note_unfollowed(PM, a, t0 + Duration::from_secs(120));
        assert!(b.want(t0 + Duration::from_secs(120)).is_empty());
        // 3 within the window: listed.
        b.note_unfollowed(PM, a, t0 + Duration::from_secs(130));
        b.note_unfollowed(PM, a, t0 + Duration::from_secs(140));
        let t = t0 + Duration::from_secs(140);
        assert_eq!(b.want(t), vec![format!("{a:#x}")]);
        // The cap: c fits, d doesn't.
        for _ in 0..3 {
            b.note_unfollowed(PM, c, t);
            b.note_unfollowed(PM, d, t);
        }
        let w = b.want(t);
        assert_eq!(w.len(), 2);
        assert!(!w.contains(&format!("{d:#x}")));
        assert_eq!(b.auto_full, 1);
        // Use keeps `a` listed; `c` expires after af_keep with no use.
        b.note_used(&a, t + Duration::from_secs(250));
        let later = t + Duration::from_secs(301);
        assert_eq!(b.want(later), vec![format!("{a:#x}")]);
        assert_eq!(b.auto_expired, 1);
        // Room again: d is listed at its next hot miss.
        for _ in 0..3 {
            b.note_unfollowed(PM, d, later);
        }
        assert_eq!(b.want(later).len(), 2);
    }
}
