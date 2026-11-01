// ============================================================================
// MEMORY GUARD + MEMORY BREAKDOWN (Nov 1).
//
// Plain English:
//   pm2 restarts arbsim when it uses more than 1,300 MB. With the seeing-
//   ahead copy on (FASTLANE_AHEAD=observe) and its keeper, arbsim went from
//   ~1,070 MB to 1,364 / 1,441 MB and was killed. Being killed is the worst
//   outcome: the copy has to come back from its saved file and trading is
//   blind for a while.
//
//   So the parts that are only MEASURING (the predicted copy and its
//   keeper) now step back before that line. Trading never does:
//     - at ARBSIM_AHEAD_MEM_PAUSE_MB [1200] the predicted copy drops what it
//       holds (predicted blocks, waiting agreements, its merged base) and
//       predicts nothing ("stopped: memory" in status), and the keeper stops
//       growing (no new seeds, no new learned or adopted values; it keeps
//       its held values exact block by block, so nothing has to be seeded
//       again afterwards);
//     - freed memory is handed back to the system (glibc malloc_trim; glibc
//       otherwise keeps freed memory for later and pm2 still counts it),
//       once when the pause starts, then at most once a minute while it
//       lasts (ARBSIM_AHEAD_MEM_TRIM, on). Measured offline (trim_bench):
//       a fragmented 592 MB heap went to 189 MB in 55 ms; glibc holds its
//       locks meanwhile, so other threads' allocations can wait that long.
//       This only happens when arbsim would otherwise be killed soon;
//     - below ARBSIM_AHEAD_MEM_RESUME_MB [1140] both carry on.
//   ARBSIM_AHEAD_MEM_PAUSE_MB=0 turns the guard off. The guard is only ever
//   asked by the predicted copy and the keeper: with FASTLANE_AHEAD unset
//   nothing calls it (and it costs nothing).
//
//   Cost: one read of /proc/self/statm (a few microseconds) at most every
//   250 ms, by whichever of the two threads asks first.
//
//   BREAKDOWN (status "memory"): process size now and its peak, and what
//   glibc's allocator says: in use by the program, held free inside the
//   allocator (freed but not handed back: fragmentation), and big blocks
//   mapped on their own. The allocator figures walk its free lists while
//   holding its locks, so they are taken at most once every 30 s (cached).
// ============================================================================
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde_json::{json, Value};

/// Guard settings (ARBSIM_AHEAD_MEM_*).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuardCfg {
    /// ARBSIM_AHEAD_MEM_PAUSE_MB [1200]: pause at or above (0 = guard off).
    pub pause_mb: u64,
    /// ARBSIM_AHEAD_MEM_RESUME_MB [1140]: carry on below (kept below pause).
    pub resume_mb: u64,
    /// ARBSIM_AHEAD_MEM_TRIM [on]: hand freed memory back while paused.
    pub trim: bool,
}

impl GuardCfg {
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> GuardCfg {
        let num = |k: &str, d: u64| get(k).and_then(|v| v.trim().parse::<u64>().ok()).filter(|v| *v <= 1_000_000).unwrap_or(d);
        let pause_mb = num("ARBSIM_AHEAD_MEM_PAUSE_MB", 1200);
        let resume_mb = num("ARBSIM_AHEAD_MEM_RESUME_MB", 1140);
        // A resume line at or above the pause line would flap: keep a gap.
        let resume_mb = if pause_mb > 0 && resume_mb >= pause_mb { pause_mb.saturating_sub(pause_mb / 20).max(1) } else { resume_mb };
        let trim = crate::copy2::ahead::on_off(get("ARBSIM_AHEAD_MEM_TRIM").as_deref()).unwrap_or(true);
        GuardCfg { pause_mb, resume_mb, trim }
    }
}

/// The guard's state machine (no clock or process reads: tests drive it).
#[derive(Debug, Default)]
pub struct Guard {
    pub paused: bool,
    pub pauses: u64,
    pub resumes: u64,
}

/// What one look decided.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Same,
    Paused,
    Resumed,
}

impl Guard {
    /// One look at the process size `rss_mb`.
    pub fn look(&mut self, cfg: &GuardCfg, rss_mb: f64) -> Step {
        if cfg.pause_mb == 0 {
            if self.paused {
                self.paused = false;
                self.resumes += 1;
                return Step::Resumed;
            }
            return Step::Same;
        }
        if !self.paused && rss_mb >= cfg.pause_mb as f64 {
            self.paused = true;
            self.pauses += 1;
            Step::Paused
        } else if self.paused && rss_mb < cfg.resume_mb as f64 {
            self.paused = false;
            self.resumes += 1;
            Step::Resumed
        } else {
            Step::Same
        }
    }
}

struct Rt {
    cfg: GuardCfg,
    started: Instant,
    /// ms since start of the last look (u64::MAX = never).
    last_look_ms: AtomicU64,
    paused: AtomicBool,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    guard: Guard,
    paused_since: Option<Instant>,
    paused_ms_total: u64,
    last_rss_mb: f64,
    max_rss_seen_mb: f64,
    last_trim: Option<Instant>,
    trims: u64,
    trim_last_ms: f64,
    trim_last_freed_mb: f64,
    trim_freed_total_mb: f64,
}

fn rt() -> &'static Rt {
    static RT: OnceLock<Rt> = OnceLock::new();
    RT.get_or_init(|| Rt {
        cfg: GuardCfg::from_lookup(|k| std::env::var(k).ok()),
        started: Instant::now(),
        last_look_ms: AtomicU64::new(u64::MAX),
        paused: AtomicBool::new(false),
        inner: Mutex::new(Inner::default()),
    })
}

/// Process size now, MB (Linux /proc/self/statm; 0 if unknown).
pub fn rss_mb() -> f64 {
    crate::state::mirror::Shared::rss_mb()
}

/// Peak process size since start, MB (VmHWM; 0 if unknown).
pub fn peak_rss_mb() -> f64 {
    let s = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    s.lines()
        .find(|l| l.starts_with("VmHWM:"))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|x| x.parse::<f64>().ok())
        .map(|kb| (kb / 1024.0 * 10.0).round() / 10.0)
        .unwrap_or(0.0)
}

/// Hand freed memory back to the system (glibc malloc_trim). Returns the
/// time it took (ms). No-op elsewhere.
pub fn trim_now() -> f64 {
    let t = Instant::now();
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: malloc_trim only walks glibc's own free lists.
    unsafe {
        libc::malloc_trim(0);
    }
    t.elapsed().as_secs_f64() * 1000.0
}

/// Should the predicted copy and the keeper step back right now? Asked by
/// those two only (never by trading). Looks at the process size at most
/// every 250 ms; the first caller after that does the look.
pub fn pressure() -> bool {
    let r = rt();
    if r.cfg.pause_mb == 0 {
        return false;
    }
    let now_ms = r.started.elapsed().as_millis() as u64;
    let last = r.last_look_ms.load(Ordering::Relaxed);
    if last != u64::MAX && now_ms.saturating_sub(last) < 250 {
        return r.paused.load(Ordering::Relaxed);
    }
    // One looker at a time (the others use the last answer).
    if r.last_look_ms.compare_exchange(last, now_ms, Ordering::AcqRel, Ordering::Relaxed).is_err() {
        return r.paused.load(Ordering::Relaxed);
    }
    let rss = rss_mb();
    let mut g = r.inner.lock().unwrap_or_else(|e| e.into_inner());
    g.last_rss_mb = rss;
    g.max_rss_seen_mb = g.max_rss_seen_mb.max(rss);
    let cfg = r.cfg.clone();
    match g.guard.look(&cfg, rss) {
        Step::Paused => {
            g.paused_since = Some(Instant::now());
            eprintln!(
                "[arbsim] memory {rss:.0} MB >= ARBSIM_AHEAD_MEM_PAUSE_MB {}: the predicted copy and its keeper pause (trading unchanged) until below {} MB",
                cfg.pause_mb, cfg.resume_mb
            );
        }
        Step::Resumed => {
            if let Some(t) = g.paused_since.take() {
                g.paused_ms_total += t.elapsed().as_millis() as u64;
            }
            eprintln!("[arbsim] memory {rss:.0} MB < ARBSIM_AHEAD_MEM_RESUME_MB {}: the predicted copy and its keeper carry on", cfg.resume_mb);
        }
        Step::Same => {}
    }
    let paused = g.guard.paused;
    r.paused.store(paused, Ordering::Relaxed);
    // While paused: hand freed memory back (the paused parts just freed
    // theirs). The first trim waits one look
    // (250 ms) so the predicted copy has dropped what it held; then at
    // most once a minute (each trim holds glibc's locks for a moment).
    let trim_due = paused && cfg.trim && g.paused_since.is_some_and(|t| t.elapsed().as_millis() >= 250) && g.last_trim.is_none_or(|t| t.elapsed().as_secs() >= 60);
    if trim_due {
        g.last_trim = Some(Instant::now());
        drop(g);
        let ms = trim_now();
        let after = rss_mb();
        let mut g = r.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.trims += 1;
        g.trim_last_ms = (ms * 10.0).round() / 10.0;
        g.trim_last_freed_mb = ((rss - after).max(0.0) * 10.0).round() / 10.0;
        g.trim_freed_total_mb += g.trim_last_freed_mb;
        g.last_rss_mb = after;
    }
    paused
}

/// Is the guard holding the two back right now (last answer, no look)?
pub fn paused_now() -> bool {
    rt().paused.load(Ordering::Relaxed)
}

/// glibc's own figures (bytes): (in use, free inside the allocator, mapped
/// on their own). None elsewhere.
pub fn malloc_figures() -> Option<(u64, u64, u64)> {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        // SAFETY: mallinfo2 only reads glibc's own bookkeeping.
        let m = unsafe { libc::mallinfo2() };
        let in_use = (m.uordblks + m.hblkhd) as u64;
        let free = m.fordblks as u64;
        Some((in_use, free, m.hblkhd as u64))
    }
    #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
    {
        None
    }
}

/// status "memory": process size, peak, allocator figures (cached 30 s),
/// and the guard.
pub fn status_json() -> Value {
    static CACHE: Mutex<Option<(Instant, Value)>> = Mutex::new(None);
    let alloc = {
        let mut c = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        match &*c {
            Some((t, v)) if t.elapsed().as_secs() < 30 => v.clone(),
            _ => {
                let t0 = Instant::now();
                let v = match malloc_figures() {
                    Some((u, f, m)) => {
                        let mbf = |b: u64| (b as f64 / 1_048_576.0 * 10.0).round() / 10.0;
                        json!({"inUseMb": mbf(u), "freeHeldMb": mbf(f), "bigBlocksMb": mbf(m), "tookMs": (t0.elapsed().as_secs_f64() * 1000.0 * 100.0).round() / 100.0, "ageS": 0})
                    }
                    None => Value::Null,
                };
                *c = Some((Instant::now(), v.clone()));
                v
            }
        }
    };
    let mut alloc = alloc;
    if let (Value::Object(o), Some((t, _))) = (&mut alloc, CACHE.lock().unwrap_or_else(|e| e.into_inner()).as_ref()) {
        o.insert("ageS".into(), json!(t.elapsed().as_secs()));
    }
    let r = rt();
    let g = r.inner.lock().unwrap_or_else(|e| e.into_inner());
    let paused_ms = g.paused_ms_total + g.paused_since.map_or(0, |t| t.elapsed().as_millis() as u64);
    json!({
        "rssMb": rss_mb(),
        "peakRssMb": peak_rss_mb(),
        "malloc": alloc,
        "mallocArenaMax": std::env::var("MALLOC_ARENA_MAX").ok(),
        "aheadGuard": {
            "pauseMb": r.cfg.pause_mb, "resumeMb": r.cfg.resume_mb, "trim": r.cfg.trim,
            "paused": g.guard.paused, "pauses": g.guard.pauses, "resumes": g.guard.resumes, "pausedS": paused_ms / 1000,
            "lastLookMb": g.last_rss_mb, "maxSeenMb": g.max_rss_seen_mb,
            "trims": g.trims, "trimLastMs": g.trim_last_ms, "trimLastFreedMb": g.trim_last_freed_mb, "trimFreedTotalMb": (g.trim_freed_total_mb * 10.0).round() / 10.0,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn cfg(kv: &[(&str, &str)]) -> GuardCfg {
        let m: HashMap<String, String> = kv.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        GuardCfg::from_lookup(|k| m.get(k).cloned())
    }

    #[test]
    fn settings_and_defaults() {
        assert_eq!(cfg(&[]), GuardCfg { pause_mb: 1200, resume_mb: 1140, trim: true });
        assert_eq!(cfg(&[("ARBSIM_AHEAD_MEM_PAUSE_MB", "0")]).pause_mb, 0);
        assert_eq!(cfg(&[("ARBSIM_AHEAD_MEM_TRIM", "off")]).trim, false);
        // A resume line at / above the pause line is pulled 5% below it.
        assert_eq!(cfg(&[("ARBSIM_AHEAD_MEM_PAUSE_MB", "1000"), ("ARBSIM_AHEAD_MEM_RESUME_MB", "1000")]).resume_mb, 950);
        assert_eq!(cfg(&[("ARBSIM_AHEAD_MEM_PAUSE_MB", "junk")]).pause_mb, 1200);
    }

    #[test]
    fn pauses_at_the_line_and_resumes_below_the_lower_one() {
        let c = cfg(&[]);
        let mut g = Guard::default();
        assert_eq!(g.look(&c, 1100.0), Step::Same);
        assert_eq!(g.look(&c, 1199.9), Step::Same);
        assert_eq!(g.look(&c, 1200.0), Step::Paused);
        // In between the two lines: stays paused (no flapping).
        assert_eq!(g.look(&c, 1170.0), Step::Same);
        assert!(g.paused);
        assert_eq!(g.look(&c, 1139.0), Step::Resumed);
        assert!(!g.paused);
        assert_eq!(g.look(&c, 1170.0), Step::Same, "not paused again until the pause line");
        assert_eq!((g.pauses, g.resumes), (1, 1));
        // Off: never pauses.
        let off = cfg(&[("ARBSIM_AHEAD_MEM_PAUSE_MB", "0")]);
        let mut g = Guard::default();
        assert_eq!(g.look(&off, 5000.0), Step::Same);
    }

    #[test]
    fn breakdown_has_the_fields() {
        let s = status_json();
        assert!(s["rssMb"].as_f64().unwrap() > 0.0);
        assert!(s["peakRssMb"].as_f64().unwrap() >= s["rssMb"].as_f64().unwrap() - 1.0);
        assert!(s["malloc"]["inUseMb"].is_number());
        assert_eq!(s["aheadGuard"]["pauseMb"], json!(1200));
    }

    /// Offline measurement (run by hand): what malloc_trim and mallinfo2
    /// cost on a fragmented heap of ~ARBSIM_TRIM_BENCH_MB, and what the
    /// trim hands back. `cargo test --release --lib memguard -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn trim_bench() {
        let mb: usize = std::env::var("ARBSIM_TRIM_BENCH_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(600);
        // Many small blocks (like persistent-map nodes and JSON trees),
        // freed in runs between blocks still in use: the shape a freed
        // merged copy leaves behind among long-lived copy-2 versions.
        let n = mb * 1_048_576 / 2400;
        let mut v: Vec<Vec<u8>> = (0..n).map(|i| vec![(i % 251) as u8; 2300]).collect();
        let rss_full = rss_mb();
        for (i, x) in v.iter_mut().enumerate() {
            if (i / 8) % 4 != 0 {
                *x = Vec::new();
            }
        }
        let rss_frag = rss_mb();
        let t = Instant::now();
        let f = malloc_figures();
        let info_ms = t.elapsed().as_secs_f64() * 1000.0;
        let ms = trim_now();
        let rss_trim = rss_mb();
        println!(
            "TRIM BENCH: heap {rss_full:.0} MB, half freed {rss_frag:.0} MB (malloc says {:?}); mallinfo2 {info_ms:.2} ms; malloc_trim {ms:.1} ms -> {rss_trim:.0} MB",
            f.map(|(u, fr, m)| (u >> 20, fr >> 20, m >> 20))
        );
        drop(v);
    }
}
