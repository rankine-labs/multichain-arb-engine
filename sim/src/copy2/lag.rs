// ============================================================================
// COPY 2 LAG CLOCK: why copy 2 trails the sequencer feed (Oct 27).
//
// Plain English:
//   On 300 real blocks copy 2's newest version was p50 2, p90 7 blocks
//   behind each feed message when it arrived (arbsim trig-replay). Every
//   block of lag is more feed transactions a fire-first check must replay
//   before the trigger, and each one we can't run makes the answer unknown.
//   Three different things can make that lag; this clock tells them apart,
//   per block, with the times arbsim itself sees (nothing else changes):
//
//     feed -> report    the block's feed message reached arbsim (feed_put)
//                       -> its pool report reached arbsim (pool_logs /
//                       block_tick on the socket). This is the node (its
//                       WebSocket pushes a block's logs only after it has
//                       executed it) + the bot's forwarder (a block goes out
//                       when a later block's report arrives or COPY2_GRACE_MS
//                       after its first report; a block with nothing for us
//                       only as COPY2_TICK_MS "block_tick" for the NEWEST
//                       feed block, or folded into the next report) + the
//                       socket. Not arbsim's doing.
//     report -> start   the report waited in the copy-2 thread's queue
//                       (it was busy with other blocks / node answers / loads).
//     start -> publish  copy 2 applying the block and publishing the
//                       version (replays, locks: status applyTiming /
//                       lockHold break this down further).
//   Plus, at each publish, how many feed messages arbsim already held past
//   the published block ("behind at publish": the lag a trigger arriving
//   right then would see) and blocks that never got a report of their own
//   (covered by a later block's message; they confirm only with it).
//
//   Status "copy2Lag". Bounded: the last 4,096 blocks' stamps and the last
//   4,096 samples per measure. Cheap: one short lock per event (~1 us).
// ============================================================================
use std::collections::{BTreeMap, VecDeque};
use std::sync::Mutex;
use std::time::Instant;

use serde_json::{json, Value};

const KEEP: usize = 4096;

#[derive(Clone, Copy, Default)]
struct Stamps {
    feed: Option<Instant>,
    report: Option<Instant>,
    start: Option<Instant>,
}

#[derive(Default)]
struct Clock {
    stamps: BTreeMap<u64, Stamps>,
    newest_feed: u64,
    last_published: u64,
    feed_to_report: VecDeque<u64>,
    report_to_start: VecDeque<u64>,
    start_to_publish: VecDeque<u64>,
    feed_to_publish: VecDeque<u64>,
    behind_at_publish: VecDeque<u64>,
    /// Report arrived BEFORE the feed message (the feed was the slow one).
    report_first: u64,
    /// Published blocks with no feed stamp (feed message never seen / too old).
    no_feed: u64,
    /// Blocks skipped over by a publish (no message of their own).
    folded: u64,
    published: u64,
}

fn push(q: &mut VecDeque<u64>, v: u64) {
    if q.len() >= KEEP {
        q.pop_front();
    }
    q.push_back(v);
}

fn clock() -> &'static Mutex<Clock> {
    static C: std::sync::OnceLock<Mutex<Clock>> = std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(Clock::default()))
}

fn with(f: impl FnOnce(&mut Clock)) {
    let mut g = clock().lock().unwrap_or_else(|e| e.into_inner());
    f(&mut g);
    while g.stamps.len() > KEEP {
        g.stamps.pop_first();
    }
}

fn us(a: Instant, b: Instant) -> u64 {
    b.saturating_duration_since(a).as_micros() as u64
}

/// check/feedstore.rs: a NEW feed message (sequence number) was stored.
pub fn feed_arrived(seq: u64) {
    let now = Instant::now();
    with(|c| {
        c.newest_feed = c.newest_feed.max(seq);
        c.stamps.entry(seq).or_default().feed.get_or_insert(now);
    });
}

/// copy2/intake.rs Copy2Handle::block: a block's report reached arbsim
/// (sequence number = block - offset). The first one counts.
pub fn report_arrived(seq: u64) {
    let now = Instant::now();
    with(|c| {
        let s = c.stamps.entry(seq).or_default();
        if s.report.is_none() {
            s.report = Some(now);
            match s.feed {
                Some(f) => push(&mut c.feed_to_report, us(f, now)),
                None => c.report_first += 1,
            }
        }
    });
}

/// copy2/intake.rs: the copy-2 thread starts applying this block's message.
pub fn intake_started(seq: u64) {
    let now = Instant::now();
    with(|c| {
        let s = c.stamps.entry(seq).or_default();
        if s.start.is_none() {
            s.start = Some(now);
            if let Some(r) = s.report {
                push(&mut c.report_to_start, us(r, now));
            }
        }
    });
}

/// copy2/intake.rs publish: version `seq` is now copy 2's newest.
pub fn published(seq: u64) {
    let now = Instant::now();
    with(|c| {
        c.published += 1;
        if c.last_published > 0 && seq > c.last_published + 1 {
            c.folded += seq - c.last_published - 1;
        }
        c.last_published = c.last_published.max(seq);
        let s = c.stamps.get(&seq).copied().unwrap_or_default();
        if let Some(st) = s.start {
            push(&mut c.start_to_publish, us(st, now));
        }
        match s.feed {
            Some(f) => push(&mut c.feed_to_publish, us(f, now)),
            None => c.no_feed += 1,
        }
        let behind = c.newest_feed.saturating_sub(seq);
        push(&mut c.behind_at_publish, behind);
    });
}

/// status "copy2Lag" (microseconds; blocks for behindAtPublish).
pub fn status_json() -> Value {
    let g = clock().lock().unwrap_or_else(|e| e.into_inner());
    let p = |q: &VecDeque<u64>| {
        let mut v: Vec<u64> = q.iter().copied().collect();
        crate::timing::pct_of(&mut v)
    };
    json!({
        "feedToReportUs": p(&g.feed_to_report),
        "reportToStartUs": p(&g.report_to_start),
        "startToPublishUs": p(&g.start_to_publish),
        "feedToPublishUs": p(&g.feed_to_publish),
        "behindAtPublishBlocks": p(&g.behind_at_publish),
        "published": g.published, "foldedBlocks": g.folded, "reportBeforeFeed": g.report_first, "publishedWithoutFeed": g.no_feed,
        "note": "feed->report = node + bot forwarder + socket (not arbsim); report->start = copy-2 thread queue; start->publish = apply + publish (see applyTiming / lockHold)",
    })
}

/// Forget everything (tests).
pub fn reset() {
    *clock().lock().unwrap_or_else(|e| e.into_inner()) = Clock::default();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_the_lag_into_its_three_parts() {
        reset();
        feed_arrived(100);
        feed_arrived(101);
        std::thread::sleep(std::time::Duration::from_millis(3));
        report_arrived(100);
        intake_started(100);
        published(100);
        feed_arrived(102);
        // Block 101 never gets its own message; 102's report comes first.
        report_arrived(102);
        intake_started(102);
        published(102);
        let s = status_json();
        assert_eq!(s["published"], json!(2));
        assert_eq!(s["foldedBlocks"], json!(1), "{s}");
        assert!(s["feedToReportUs"]["p50"].as_u64().unwrap() >= 3_000, "{s}");
        assert_eq!(s["behindAtPublishBlocks"]["max"], json!(1), "101 was the newest feed block when 100 was published: {s}");
        report_arrived(103);
        assert_eq!(status_json()["reportBeforeFeed"], json!(1));
        reset();
    }
}
