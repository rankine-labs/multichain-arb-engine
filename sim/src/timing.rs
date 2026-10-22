// ============================================================================
// CHECK TIMING: where the time of one fast check goes (live Oct 22: the bot
// measured p50 63 ms / p90 122 ms for checks that should take ~10 ms).
//
// Plain English:
//   Every `call` / `size_search` answer carries "t" = microseconds spent in
//   each step inside arbsim:
//     queue    waiting for a free worker thread (time since the socket read)
//     prep     reading the request (JSON, caller / warm-up bookkeeping)
//     resolve  picking the copy's version for `at` (incl. a short wait when
//              the block has arrived but isn't applied yet: "dirty")
//     facts    collecting what copy 2 vouches for (V4 bound / fee / far
//              zero words) - reads the pool registry
//     runs     each EVM run (a check can need up to 4: PoolManager balance
//              bound low / high x protocol fee 0 / not 0), one number each
//     post     after the runs (pending-report check, miss bookkeeping)
//   The worker also times writing the answer back ("send"). The last 1000
//   checks are kept here and `status` shows their p50 / p90 / p99 / max
//   ("checkTiming"), plus how long copy 2's block applies took
//   ("applyTiming") and how long the copy-keeping thread held the locks
//   checks need ("lockHold", with the 10 source lines holding longest).
//   Also here (copy2-q): the lock wrappers that time those holds
//   (TimedWrite) and GenLock (a lock with a change counter, so checks can
//   reuse a summary of copy 2's pool registry without taking its lock).
//   Nothing here changes an answer.
// ============================================================================
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Instant;

use serde_json::{json, Value};

/// Timing of one check (microseconds).
#[derive(Clone, Debug, Default)]
pub struct Tm {
    pub queue_us: u64,
    pub prep_us: u64,
    pub resolve_us: u64,
    pub facts_us: u64,
    pub runs_us: Vec<u64>,
    pub post_us: u64,
}

impl Tm {
    pub fn json(&self) -> Value {
        json!({
            "queue": self.queue_us, "prep": self.prep_us, "resolve": self.resolve_us,
            "facts": self.facts_us, "runs": self.runs_us, "post": self.post_us,
        })
    }
}

/// One finished check (kept for status).
#[derive(Clone, Copy, Debug, Default)]
struct Sample {
    total: u64,
    queue: u64,
    prep: u64,
    resolve: u64,
    facts: u64,
    run_sum: u64,
    run_max: u64,
    nruns: u64,
    post: u64,
    send: u64,
}

const KEEP: usize = 1000;

struct Rings {
    checks: VecDeque<Sample>,
    applies: VecDeque<u64>,
    holds: VecDeque<u64>,
    /// Lock holds over 1 ms per source line: (count, total us, max us).
    sites: std::collections::BTreeMap<String, (u64, u64, u64)>,
}

static RINGS: Mutex<Rings> = Mutex::new(Rings { checks: VecDeque::new(), applies: VecDeque::new(), holds: VecDeque::new(), sites: std::collections::BTreeMap::new() });

fn push<T>(q: &mut VecDeque<T>, v: T) {
    if q.len() >= KEEP {
        q.pop_front();
    }
    q.push_back(v);
}

/// A finished check: its steps, the total inside arbsim (queue included)
/// and the time to write the answer back.
pub fn record_check(tm: &Tm, total_us: u64, send_us: u64) {
    let s = Sample {
        total: total_us,
        queue: tm.queue_us,
        prep: tm.prep_us,
        resolve: tm.resolve_us,
        facts: tm.facts_us,
        run_sum: tm.runs_us.iter().sum(),
        run_max: tm.runs_us.iter().copied().max().unwrap_or(0),
        nruns: tm.runs_us.len() as u64,
        post: tm.post_us,
        send: send_us,
    };
    if let Ok(mut r) = RINGS.lock() {
        push(&mut r.checks, s);
    }
}

/// One copy-2 block applied (microseconds).
pub fn record_apply(us: u64) {
    if let Ok(mut r) = RINGS.lock() {
        push(&mut r.applies, us);
    }
}

/// The copy-keeping thread held a lock checks need for this long (only
/// holds over 1 ms are kept).
pub fn record_hold(us: u64) {
    if us < 1000 {
        return;
    }
    if let Ok(mut r) = RINGS.lock() {
        push(&mut r.holds, us);
    }
}

/// Same, with the source line that took the lock (status lockHold.bySite:
/// count over 1 ms, total and longest per line).
pub fn record_hold_at(us: u64, site: &'static std::panic::Location<'static>) {
    if us < 1000 {
        return;
    }
    if let Ok(mut r) = RINGS.lock() {
        push(&mut r.holds, us);
        let key = format!("{}:{}", site.file().rsplit('/').next().unwrap_or(""), site.line());
        if r.sites.len() < 500 || r.sites.contains_key(&key) {
            let e = r.sites.entry(key).or_insert((0, 0, 0));
            e.0 += 1;
            e.1 += us;
            e.2 = e.2.max(us);
        }
    }
}

fn pct(v: &mut [u64]) -> Value {
    if v.is_empty() {
        return json!({ "n": 0 });
    }
    v.sort_unstable();
    let at = |p: f64| v[(((v.len() - 1) as f64) * p).round() as usize];
    json!({ "n": v.len(), "p50": at(0.5), "p90": at(0.9), "p99": at(0.99), "max": v[v.len() - 1] })
}

/// status: "checkTiming" (per step, microseconds), "applyTiming", "lockHold".
pub fn status() -> Value {
    let r = match RINGS.lock() {
        Ok(r) => r,
        Err(_) => return json!({}),
    };
    let col = |f: fn(&Sample) -> u64| -> Value {
        let mut v: Vec<u64> = r.checks.iter().map(f).collect();
        pct(&mut v)
    };
    let mut applies: Vec<u64> = r.applies.iter().copied().collect();
    let mut holds: Vec<u64> = r.holds.iter().copied().collect();
    json!({
        "checkTiming": {
            "total": col(|s| s.total), "queue": col(|s| s.queue), "prep": col(|s| s.prep),
            "resolve": col(|s| s.resolve), "facts": col(|s| s.facts), "runSum": col(|s| s.run_sum),
            "runMax": col(|s| s.run_max), "runs": col(|s| s.nruns), "post": col(|s| s.post), "send": col(|s| s.send),
        },
        "applyTiming": pct(&mut applies),
        "lockHold": with_sites(pct(&mut holds), &r.sites),
    })
}

fn with_sites(mut v: Value, sites: &std::collections::BTreeMap<String, (u64, u64, u64)>) -> Value {
    let mut top: Vec<(&String, &(u64, u64, u64))> = sites.iter().collect();
    top.sort_by(|a, b| b.1 .1.cmp(&a.1 .1));
    top.truncate(10);
    v["bySite"] = json!(top.into_iter().map(|(k, (n, tot, mx))| json!({"site": k, "n": n, "totalUs": tot, "maxUs": mx})).collect::<Vec<_>>());
    v
}

/// Forget everything (tests / benches).
pub fn reset() {
    if let Ok(mut r) = RINGS.lock() {
        r.checks.clear();
        r.applies.clear();
        r.holds.clear();
        r.sites.clear();
    }
}

/// Something whose write lock TimedWrite can time (a plain RwLock, the
/// mirror's PubLock, the registry's GenLock).
pub trait WriteLock<'a> {
    type Guard: std::ops::DerefMut;
    fn lock_write(&'a self) -> Self::Guard;
}

impl<'a, T: 'a> WriteLock<'a> for std::sync::RwLock<T> {
    type Guard = std::sync::RwLockWriteGuard<'a, T>;
    fn lock_write(&'a self) -> Self::Guard {
        self.write().unwrap_or_else(|e| e.into_inner())
    }
}

/// A write lock guard that records how long it was held and WHERE it was
/// taken (lockHold, per source line: live Oct 22 20:00 showed 484 holds
/// over 1 ms, the longest 197 ms, without saying which).
pub struct TimedWrite<G: std::ops::DerefMut> {
    g: G,
    t: Instant,
    site: &'static std::panic::Location<'static>,
}

impl<G: std::ops::DerefMut> TimedWrite<G> {
    #[track_caller]
    pub fn new<'a, L: WriteLock<'a, Guard = G> + ?Sized>(l: &'a L) -> Self {
        let site = std::panic::Location::caller();
        let g = l.lock_write();
        TimedWrite { g, t: Instant::now(), site }
    }
}

impl<G: std::ops::DerefMut> std::ops::Deref for TimedWrite<G> {
    type Target = G::Target;
    fn deref(&self) -> &G::Target {
        &self.g
    }
}

impl<G: std::ops::DerefMut> std::ops::DerefMut for TimedWrite<G> {
    fn deref_mut(&mut self) -> &mut G::Target {
        &mut self.g
    }
}

impl<G: std::ops::DerefMut> Drop for TimedWrite<G> {
    fn drop(&mut self) {
        record_hold_at(self.t.elapsed().as_micros() as u64, self.site);
    }
}

/// An RwLock with a change counter: every write lock bumps it (while still
/// held), so a reader can tell "nothing changed since I last looked"
/// without taking the lock (copy 2's pool registry: checks keep a summary
/// of it and rebuild it only when it changed, intake.rs CheckCore).
pub struct GenLock<T> {
    inner: std::sync::RwLock<T>,
    gen: std::sync::atomic::AtomicU64,
}

pub struct GenWriteGuard<'a, T> {
    g: std::sync::RwLockWriteGuard<'a, T>,
    gen: &'a std::sync::atomic::AtomicU64,
}

impl<T> GenLock<T> {
    pub fn new(v: T) -> Self {
        GenLock { inner: std::sync::RwLock::new(v), gen: std::sync::atomic::AtomicU64::new(1) }
    }
    pub fn read(&self) -> std::sync::LockResult<std::sync::RwLockReadGuard<'_, T>> {
        self.inner.read()
    }
    pub fn try_read(&self) -> std::sync::TryLockResult<std::sync::RwLockReadGuard<'_, T>> {
        self.inner.try_read()
    }
    pub fn write(&self) -> std::sync::LockResult<GenWriteGuard<'_, T>> {
        let g = self.inner.write().unwrap_or_else(|e| e.into_inner());
        Ok(GenWriteGuard { g, gen: &self.gen })
    }
    /// Changes so far (read it while holding a read lock to pair it with
    /// what you read).
    pub fn gen(&self) -> u64 {
        self.gen.load(std::sync::atomic::Ordering::Acquire)
    }
}

impl<'a, T: 'a> WriteLock<'a> for GenLock<T> {
    type Guard = GenWriteGuard<'a, T>;
    fn lock_write(&'a self) -> Self::Guard {
        self.write().unwrap_or_else(|e| e.into_inner())
    }
}

impl<T> std::ops::Deref for GenWriteGuard<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.g
    }
}

impl<T> std::ops::DerefMut for GenWriteGuard<'_, T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.g
    }
}

impl<T> Drop for GenWriteGuard<'_, T> {
    fn drop(&mut self) {
        // Still holding the lock here (the guard field drops after this).
        self.gen.fetch_add(1, std::sync::atomic::Ordering::Release);
    }
}
