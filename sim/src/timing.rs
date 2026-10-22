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
//   checks need ("lockHold").
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
}

static RINGS: Mutex<Rings> = Mutex::new(Rings { checks: VecDeque::new(), applies: VecDeque::new(), holds: VecDeque::new() });

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
        "lockHold": pct(&mut holds),
    })
}

/// Forget everything (tests / benches).
pub fn reset() {
    if let Ok(mut r) = RINGS.lock() {
        r.checks.clear();
        r.applies.clear();
        r.holds.clear();
    }
}

/// A write lock guard that records how long it was held (lockHold).
pub struct TimedWrite<'a, T> {
    g: std::sync::RwLockWriteGuard<'a, T>,
    t: Instant,
}

impl<'a, T> TimedWrite<'a, T> {
    pub fn new(l: &'a std::sync::RwLock<T>) -> Self {
        let g = l.write().unwrap_or_else(|e| e.into_inner());
        TimedWrite { g, t: Instant::now() }
    }
}

impl<T> std::ops::Deref for TimedWrite<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.g
    }
}

impl<T> std::ops::DerefMut for TimedWrite<'_, T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.g
    }
}

impl<T> Drop for TimedWrite<'_, T> {
    fn drop(&mut self) {
        record_hold(self.t.elapsed().as_micros() as u64);
    }
}
