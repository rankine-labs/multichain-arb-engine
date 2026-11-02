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
//     - at ARBSIM_AHEAD_MEM_PAUSE_MB [1350] the predicted copy drops what it
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
//     - below ARBSIM_AHEAD_MEM_RESUME_MB [1290] both carry on.
//   Raised Nov 1 2026 (owner OK) from 1200 / 1140 to 1350 / 1290: arbsim's
//   normal size is ~1,000-1,250 MB, so the old 1200 line paused seeing-ahead
//   in normal running (959 s paused in 74 min). pm2's kill line moved from
//   1500 to 1800 MB at the same time (deploy/arbsim-pm2.sh), keeping ~450 MB
//   between this pause line and the kill line. Server: 7,775 MB RAM.
//   ARBSIM_AHEAD_MEM_PAUSE_MB=0 turns the guard off. The guard is only ever
//   asked by the predicted copy and the keeper: with FASTLANE_AHEAD unset
//   nothing calls it (and it costs nothing).
//
//   Cost: one read of /proc/self/statm (a few microseconds) at most every
//   250 ms, by whichever of the two threads asks first.
//
//   SOFT TRIM (Nov 2, memory fix 2, ARBSIM_MEM_SOFT_TRIM_MB [1150] /
//   ARBSIM_MEM_SOFT_TRIM_EVERY_S [300]): measured live Nov 1-2, arbsim's
//   process size climbed ~1,000 -> ~1,340 MB in 45 minutes after every
//   restart while the memory the program actually USED stayed ~900-970 MB:
//   the climb was glibc keeping freed memory ("freeHeldMb" 112 -> 551 MB),
//   not data. glibc only hands that back on malloc_trim, which until now ran
//   only once the pause line (1350) was crossed, i.e. after seeing-ahead had
//   already stopped. Now, when the process is at or above the soft line and
//   NOT paused, freed memory is handed back at most once every
//   ARBSIM_MEM_SOFT_TRIM_EVERY_S seconds (from the predicted copy's or the
//   keeper's thread, never trading's). So the process stays well below the
//   pause line and seeing-ahead keeps running. ARBSIM_MEM_SOFT_TRIM_MB=0 =
//   off (old behaviour). Like the guard, it is only asked by the predicted
//   copy and the keeper (and off when the guard is off).
//
//   FIX 13 (Nov 2): two more ways to hand freed memory back BEFORE the
//   pause line stops seeing-ahead. Measured live Nov 2 (soft trim every
//   300 s): the program really used ~1,035-1,060 MB, but the process sat at
//   1,350-1,410 MB, because glibc grew its kept free memory again by ~200 MB
//   between two soft trims (each trim handed back ~210 MB in ~30 ms). In one
//   hour the guard held back 13,681 blocks (80% of messages unpredicted).
//     - REGROW TRIM (ARBSIM_MEM_REGROW_TRIM_MB [80] /
//       ARBSIM_MEM_REGROW_TRIM_MIN_S [60]): above the soft line, also trim
//       as soon as the process has grown 80 MB since the last trim ended
//       (at most once every 60 s). Real data growth just moves the baseline
//       up (the next trim needs another 80 MB), so it never trims in a loop.
//       0 = off (only the every-300 s soft trim, as before).
//     - TRIM FIRST (ARBSIM_AHEAD_MEM_TRIM_FIRST [on]): when the process
//       reaches the pause line, hand freed memory back first and pause only
//       if it is STILL at or above the line afterwards. So the pause only
//       happens when the program really holds that much, not when glibc
//       merely keeps it. At most one such try every
//       ARBSIM_AHEAD_MEM_TRIM_FIRST_GAP_S [20] s (counted from any trim).
//   Cost: one malloc_trim (~30 ms, glibc locks held; measured live) at most
//   once a minute, always from the predicted copy's or the keeper's thread,
//   never trading's. All three trims share the same `trim_now`.
//
//   FIX 13c (Nov 2): GUARD ON MEMORY REALLY IN USE (ARBSIM_AHEAD_MEM_BASIS
//   = rss [default, as before] | inuse). Measured live after fix 13: trims
//   brought the process back to ~1,200-1,300 MB, but glibc keeps ~300 MB of
//   holes no trim can hand back, so short bursts of real work (copy 2's
//   catch-ups / load rounds: +200 to +500 MB for seconds) still crossed the
//   1350 line and paused seeing-ahead, while pm2's restart line is 1,800.
//   With `inuse` the guard pauses when what the program really holds
//   (counted by src/alloc.rs: cheap, live, no glibc locks) reaches
//   ARBSIM_AHEAD_MEM_INUSE_PAUSE_MB [1200] (carry on below
//   ARBSIM_AHEAD_MEM_INUSE_RESUME_MB [1140]), OR the process itself reaches
//   ARBSIM_AHEAD_MEM_RSS_HARD_MB [1600] (carry on below
//   ARBSIM_AHEAD_MEM_RSS_HARD_RESUME_MB [1500]): still 200 MB below pm2's
//   1,800 restart line, so being killed stays as unlikely as before.
//   Trim first then applies at the hard line. If the counter is not
//   available (0: a binary without `alloc::Chosen`), it falls back to rss.
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
    /// ARBSIM_AHEAD_MEM_PAUSE_MB [1350]: pause at or above (0 = guard off).
    pub pause_mb: u64,
    /// ARBSIM_AHEAD_MEM_RESUME_MB [1290]: carry on below (kept below pause).
    pub resume_mb: u64,
    /// ARBSIM_AHEAD_MEM_TRIM [on]: hand freed memory back while paused.
    pub trim: bool,
    /// ARBSIM_MEM_SOFT_TRIM_MB [1150] (memory fix 2, Nov 2): at or above
    /// this process size (and not paused) hand freed memory back early, so
    /// the pause line is not reached by memory glibc merely keeps. 0 = off.
    pub soft_trim_mb: u64,
    /// ARBSIM_MEM_SOFT_TRIM_EVERY_S [300]: at most one soft trim this often
    /// (30..=86400 s): each trim holds glibc's locks for ~50-100 ms.
    pub soft_trim_every_s: u64,
    /// ARBSIM_MEM_REGROW_TRIM_MB [80] (fix 13): above the soft line, trim
    /// again once the process grew this much since the last trim ended.
    /// 0 = off.
    pub regrow_trim_mb: u64,
    /// ARBSIM_MEM_REGROW_TRIM_MIN_S [60] (fix 13): never two regrow trims
    /// closer than this (30..=3600 s).
    pub regrow_trim_min_s: u64,
    /// ARBSIM_AHEAD_MEM_TRIM_FIRST [on] (fix 13): at the pause line, trim
    /// first and pause only if still over the line afterwards.
    pub trim_first: bool,
    /// ARBSIM_AHEAD_MEM_TRIM_FIRST_GAP_S [20] (fix 13): no trim-first try
    /// within this many seconds of any trim (5..=600 s).
    pub trim_first_gap_s: u64,
    /// ARBSIM_AHEAD_MEM_BASIS [rss] (fix 13c): `inuse` = pause on memory
    /// really in use (below) plus a hard process-size line.
    pub basis_inuse: bool,
    /// ARBSIM_AHEAD_MEM_INUSE_PAUSE_MB [1200] / _RESUME_MB [1140] (fix 13c).
    pub inuse_pause_mb: u64,
    pub inuse_resume_mb: u64,
    /// ARBSIM_AHEAD_MEM_RSS_HARD_MB [1600] / _RESUME_MB [1500] (fix 13c):
    /// with `inuse`, the process size that still pauses (pm2 restarts 1,800).
    pub rss_hard_mb: u64,
    pub rss_hard_resume_mb: u64,
}

impl GuardCfg {
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> GuardCfg {
        let num = |k: &str, d: u64| get(k).and_then(|v| v.trim().parse::<u64>().ok()).filter(|v| *v <= 1_000_000).unwrap_or(d);
        let pause_mb = num("ARBSIM_AHEAD_MEM_PAUSE_MB", 1350);
        let resume_mb = num("ARBSIM_AHEAD_MEM_RESUME_MB", 1290);
        // A resume line at or above the pause line would flap: keep a gap.
        let resume_mb = if pause_mb > 0 && resume_mb >= pause_mb { pause_mb.saturating_sub(pause_mb / 20).max(1) } else { resume_mb };
        let trim = crate::copy2::ahead::on_off(get("ARBSIM_AHEAD_MEM_TRIM").as_deref()).unwrap_or(true);
        // Soft trim (Nov 2): 0 = off; the gap to the pause line is what it buys.
        let soft_trim_mb = num("ARBSIM_MEM_SOFT_TRIM_MB", 1150);
        let soft_trim_every_s = num("ARBSIM_MEM_SOFT_TRIM_EVERY_S", 300).clamp(30, 86_400);
        // Fix 13 (Nov 2): regrow trim and trim-first (see the header).
        let regrow_trim_mb = num("ARBSIM_MEM_REGROW_TRIM_MB", 80);
        let regrow_trim_min_s = num("ARBSIM_MEM_REGROW_TRIM_MIN_S", 60).clamp(30, 3_600);
        let trim_first = crate::copy2::ahead::on_off(get("ARBSIM_AHEAD_MEM_TRIM_FIRST").as_deref()).unwrap_or(true);
        let trim_first_gap_s = num("ARBSIM_AHEAD_MEM_TRIM_FIRST_GAP_S", 20).clamp(5, 600);
        // Fix 13c (Nov 2): guard on memory really in use (see the header).
        let basis_inuse = get("ARBSIM_AHEAD_MEM_BASIS").is_some_and(|v| v.trim().eq_ignore_ascii_case("inuse"));
        let gap = |pause: u64, resume: u64| if resume >= pause { pause.saturating_sub(pause / 20).max(1) } else { resume };
        let inuse_pause_mb = num("ARBSIM_AHEAD_MEM_INUSE_PAUSE_MB", 1200).max(1);
        let inuse_resume_mb = gap(inuse_pause_mb, num("ARBSIM_AHEAD_MEM_INUSE_RESUME_MB", 1140));
        let rss_hard_mb = num("ARBSIM_AHEAD_MEM_RSS_HARD_MB", 1600).max(1);
        let rss_hard_resume_mb = gap(rss_hard_mb, num("ARBSIM_AHEAD_MEM_RSS_HARD_RESUME_MB", 1500));
        GuardCfg {
            pause_mb,
            resume_mb,
            trim,
            soft_trim_mb,
            soft_trim_every_s,
            regrow_trim_mb,
            regrow_trim_min_s,
            trim_first,
            trim_first_gap_s,
            basis_inuse,
            inuse_pause_mb,
            inuse_resume_mb,
            rss_hard_mb,
            rss_hard_resume_mb,
        }
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

impl Guard {
    /// Fix 13c: one look with both figures. `inuse_mb` None (or the `rss`
    /// basis) = exactly `look(rss)`. With `inuse`: pause when in use reaches
    /// its pause line OR the process reaches the hard line; carry on only
    /// when both are below their resume lines.
    pub fn look_mem(&mut self, cfg: &GuardCfg, rss_mb: f64, inuse_mb: Option<f64>) -> Step {
        let Some(inuse) = inuse_mb.filter(|_| cfg.basis_inuse && cfg.pause_mb > 0) else {
            return self.look(cfg, rss_mb);
        };
        let over = inuse >= cfg.inuse_pause_mb as f64 || rss_mb >= cfg.rss_hard_mb as f64;
        let under = inuse < cfg.inuse_resume_mb as f64 && rss_mb < cfg.rss_hard_resume_mb as f64;
        if !self.paused && over {
            self.paused = true;
            self.pauses += 1;
            Step::Paused
        } else if self.paused && under {
            self.paused = false;
            self.resumes += 1;
            Step::Resumed
        } else {
            Step::Same
        }
    }
}

/// Fix 13c: the process-size line that pauses (and so where trim-first
/// acts): the hard line with the `inuse` basis, else the pause line.
pub fn rss_pause_line(cfg: &GuardCfg, inuse_known: bool) -> u64 {
    if cfg.basis_inuse && inuse_known { cfg.rss_hard_mb } else { cfg.pause_mb }
}

/// SOFT TRIM (Nov 2): is an early hand-back due? Not while paused (the
/// pause has its own trims), only at or above the soft line, and at most
/// once every `soft_trim_every_s` (`since_last_s` None = never trimmed).
pub fn soft_trim_due(cfg: &GuardCfg, paused: bool, rss_mb: f64, since_last_s: Option<u64>) -> bool {
    cfg.soft_trim_mb > 0 && !paused && rss_mb >= cfg.soft_trim_mb as f64 && since_last_s.is_none_or(|s| s >= cfg.soft_trim_every_s)
}

/// REGROW TRIM (fix 13): above the soft line and not paused, has the
/// process grown `regrow_trim_mb` since the last trim ended (`after_last_mb`)
/// and is the last soft/regrow trim at least `regrow_trim_min_s` ago?
/// Before any trim (`after_last_mb` None) the plain soft trim decides.
pub fn regrow_trim_due(cfg: &GuardCfg, paused: bool, rss_mb: f64, since_last_s: Option<u64>, after_last_mb: Option<f64>) -> bool {
    cfg.soft_trim_mb > 0
        && cfg.regrow_trim_mb > 0
        && !paused
        && rss_mb >= cfg.soft_trim_mb as f64
        && since_last_s.is_some_and(|s| s >= cfg.regrow_trim_min_s)
        && after_last_mb.is_some_and(|a| rss_mb >= a + cfg.regrow_trim_mb as f64)
}

/// TRIM FIRST (fix 13): about to pause (not paused, at or over the pause
/// line)? Then hand back freed memory first, unless any trim ran within
/// `trim_first_gap_s` (`since_any_trim_s` None = never trimmed).
pub fn trim_first_due(cfg: &GuardCfg, paused: bool, rss_mb: f64, since_any_trim_s: Option<u64>) -> bool {
    trim_first_due_at(cfg, cfg.pause_mb, paused, rss_mb, since_any_trim_s)
}

/// Same, at a given process-size line (fix 13c: the hard line with `inuse`).
pub fn trim_first_due_at(cfg: &GuardCfg, line_mb: u64, paused: bool, rss_mb: f64, since_any_trim_s: Option<u64>) -> bool {
    cfg.pause_mb > 0 && cfg.trim_first && !paused && rss_mb >= line_mb as f64 && since_any_trim_s.is_none_or(|s| s >= cfg.trim_first_gap_s)
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
    /// Soft trims (Nov 2): last one, count, last time / freed, total freed.
    last_soft_trim: Option<Instant>,
    soft_trims: u64,
    soft_trim_last_ms: f64,
    soft_trim_last_freed_mb: f64,
    soft_trim_freed_total_mb: f64,
    /// Fix 13: process size right after the last trim of any kind (the
    /// regrow trim's baseline), when the last trim of any kind ran, how many
    /// soft trims were regrow-triggered, trim-first tries / pauses avoided.
    after_last_trim_mb: Option<f64>,
    last_any_trim: Option<Instant>,
    regrow_trims: u64,
    trim_first_tries: u64,
    trim_first_saved: u64,
    trim_first_freed_total_mb: f64,
    trim_first_last_ms: f64,
    /// Fix 13c: memory in use at the last look (counted), MB.
    last_inuse_mb: Option<f64>,
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

/// Hand freed memory back to the system: glibc malloc_trim, or with
/// mimalloc (src/alloc.rs, the default) mi_collect. Returns the time it
/// took (ms). No-op elsewhere.
pub fn trim_now() -> f64 {
    let t = Instant::now();
    if crate::alloc::is_mimalloc() {
        crate::alloc::mimalloc_collect();
        return t.elapsed().as_secs_f64() * 1000.0;
    }
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
    let mut rss = rss_mb();
    let mut g = r.inner.lock().unwrap_or_else(|e| e.into_inner());
    g.last_rss_mb = rss;
    g.max_rss_seen_mb = g.max_rss_seen_mb.max(rss);
    let cfg = r.cfg.clone();
    // Fix 13c: what the program really holds (0 = counter not available).
    let held = crate::alloc::held_bytes();
    let inuse = (held > 0).then(|| held as f64 / 1_048_576.0);
    g.last_inuse_mb = inuse.map(|v| (v * 10.0).round() / 10.0);
    let line = rss_pause_line(&cfg, inuse.is_some());
    // TRIM FIRST (fix 13): at the pause line, hand back what glibc merely
    // keeps, then decide on the size after the trim.
    if trim_first_due_at(&cfg, line, g.guard.paused, rss, g.last_any_trim.map(|t| t.elapsed().as_secs())) {
        g.last_any_trim = Some(Instant::now());
        drop(g);
        let ms = trim_now();
        let after = rss_mb();
        g = r.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.trim_first_tries += 1;
        g.trim_first_last_ms = (ms * 10.0).round() / 10.0;
        g.trim_first_freed_total_mb += ((rss - after).max(0.0) * 10.0).round() / 10.0;
        g.after_last_trim_mb = Some(after);
        if after < line as f64 {
            g.trim_first_saved += 1;
        }
        if g.trim_first_tries <= 3 || g.trim_first_tries % 20 == 0 {
            eprintln!(
                "[arbsim] memory trim-first #{}: {rss:.0} -> {after:.0} MB in {ms:.0} ms ({})",
                g.trim_first_tries,
                if after < line as f64 { "no pause needed" } else { "still over the pause line" }
            );
        }
        rss = after;
        g.last_rss_mb = rss;
    }
    match g.guard.look_mem(&cfg, rss, inuse) {
        Step::Paused => {
            g.paused_since = Some(Instant::now());
            if cfg.basis_inuse && inuse.is_some() {
                eprintln!(
                    "[arbsim] memory in use {:.0} MB (line {}) / process {rss:.0} MB (line {}): the predicted copy and its keeper pause (trading unchanged)",
                    inuse.unwrap_or(0.0),
                    cfg.inuse_pause_mb,
                    cfg.rss_hard_mb
                );
            } else {
                eprintln!(
                    "[arbsim] memory {rss:.0} MB >= ARBSIM_AHEAD_MEM_PAUSE_MB {}: the predicted copy and its keeper pause (trading unchanged) until below {} MB",
                    cfg.pause_mb, cfg.resume_mb
                );
            }
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
        g.after_last_trim_mb = Some(after);
        g.last_any_trim = Some(Instant::now());
        return paused;
    }
    // SOFT TRIM (Nov 2): not paused but above the soft line: hand back
    // what glibc keeps before it pushes the process to the pause line.
    let since_soft = g.last_soft_trim.map(|t| t.elapsed().as_secs());
    let soft_due = soft_trim_due(&cfg, paused, rss, since_soft);
    // REGROW TRIM (fix 13): sooner than the soft interval once the process
    // grew `regrow_trim_mb` since the last trim ended.
    let regrow_due = !soft_due && regrow_trim_due(&cfg, paused, rss, since_soft, g.after_last_trim_mb);
    if soft_due || regrow_due {
        if regrow_due {
            g.regrow_trims += 1;
        }
        g.last_soft_trim = Some(Instant::now());
        drop(g);
        let ms = trim_now();
        let after = rss_mb();
        let mut g = r.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.soft_trims += 1;
        g.soft_trim_last_ms = (ms * 10.0).round() / 10.0;
        g.soft_trim_last_freed_mb = ((rss - after).max(0.0) * 10.0).round() / 10.0;
        g.soft_trim_freed_total_mb += g.soft_trim_last_freed_mb;
        g.last_rss_mb = after;
        g.after_last_trim_mb = Some(after);
        g.last_any_trim = Some(Instant::now());
        if g.soft_trims <= 3 || g.soft_trims % 60 == 0 {
            eprintln!(
                "[arbsim] memory soft trim #{} ({}): {rss:.0} -> {after:.0} MB in {ms:.0} ms (ARBSIM_MEM_SOFT_TRIM_MB {})",
                g.soft_trims,
                if regrow_due { "regrow" } else { "interval" },
                cfg.soft_trim_mb
            );
        }
    }
    paused
}

/// Is the guard holding the two back right now (last answer, no look)?
pub fn paused_now() -> bool {
    rt().paused.load(Ordering::Relaxed)
}

/// glibc's own figures (bytes): (in use, free inside the allocator, mapped
/// on their own). None elsewhere, and None when mimalloc runs (glibc then
/// holds almost nothing; see mimalloc_json).
pub fn malloc_figures() -> Option<(u64, u64, u64)> {
    if crate::alloc::is_mimalloc() {
        return None;
    }
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
                let mbf = |b: u64| (b as f64 / 1_048_576.0 * 10.0).round() / 10.0;
                let v = match (malloc_figures(), crate::alloc::mimalloc_figures()) {
                    (Some((u, f, m)), _) => {
                        json!({"inUseMb": mbf(u), "freeHeldMb": mbf(f), "bigBlocksMb": mbf(m), "tookMs": (t0.elapsed().as_secs_f64() * 1000.0 * 100.0).round() / 100.0, "ageS": 0})
                    }
                    // mimalloc: bytes the program holds (counted by
                    // src/alloc.rs) and the rest of the process size. It
                    // hands empty pages back by itself, so there is no
                    // separate "freed but held" pile to report.
                    // The rest of the process size is the allocator's own
                    // (pages not handed back yet) plus code and stacks.
                    (None, Some((held, rss))) => json!({"inUseMb": mbf(held), "notInUseMb": mbf(rss.saturating_sub(held)), "tookMs": (t0.elapsed().as_secs_f64() * 1000.0 * 100.0).round() / 100.0, "ageS": 0}),
                    (None, None) => Value::Null,
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
        "allocator": crate::alloc::name(),
        "malloc": alloc,
        "mallocArenaMax": std::env::var("MALLOC_ARENA_MAX").ok(),
        "aheadGuard": {
            "pauseMb": r.cfg.pause_mb, "resumeMb": r.cfg.resume_mb, "trim": r.cfg.trim,
            // Fix 13c: which figure pauses, its lines, and in use at the last look.
            "basis": if r.cfg.basis_inuse { "inuse" } else { "rss" }, "inusePauseMb": r.cfg.inuse_pause_mb, "inuseResumeMb": r.cfg.inuse_resume_mb,
            "rssHardMb": r.cfg.rss_hard_mb, "rssHardResumeMb": r.cfg.rss_hard_resume_mb, "lastLookInUseMb": g.last_inuse_mb,
            "paused": g.guard.paused, "pauses": g.guard.pauses, "resumes": g.guard.resumes, "pausedS": paused_ms / 1000,
            "lastLookMb": g.last_rss_mb, "maxSeenMb": g.max_rss_seen_mb,
            "trims": g.trims, "trimLastMs": g.trim_last_ms, "trimLastFreedMb": g.trim_last_freed_mb, "trimFreedTotalMb": (g.trim_freed_total_mb * 10.0).round() / 10.0,
        },
        // Soft trim (Nov 2): early hand-backs below the pause line.
        "softTrim": {
            "mb": r.cfg.soft_trim_mb, "everyS": r.cfg.soft_trim_every_s, "trims": g.soft_trims, "lastMs": g.soft_trim_last_ms,
            "lastFreedMb": g.soft_trim_last_freed_mb, "freedTotalMb": (g.soft_trim_freed_total_mb * 10.0).round() / 10.0,
            "lastAgoS": g.last_soft_trim.map(|t| t.elapsed().as_secs()),
            // Fix 13: how many of `trims` were regrow-triggered.
            "regrowMb": r.cfg.regrow_trim_mb, "regrowMinS": r.cfg.regrow_trim_min_s, "regrowTrims": g.regrow_trims,
            "afterLastTrimMb": g.after_last_trim_mb,
        },
        // Fix 13: trims at the pause line before pausing (saved = no pause needed).
        "trimFirst": {
            "on": r.cfg.trim_first, "gapS": r.cfg.trim_first_gap_s, "tries": g.trim_first_tries, "saved": g.trim_first_saved,
            "freedTotalMb": (g.trim_first_freed_total_mb * 10.0).round() / 10.0, "lastMs": g.trim_first_last_ms,
        },
        // Fix 13: bytes the program holds, counted by src/alloc.rs (cheap,
        // live, no glibc locks; 0 when `alloc::Chosen` is not the allocator).
        "countedInUseMb": (crate::alloc::held_bytes() as f64 / 1_048_576.0 * 10.0).round() / 10.0,
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
        assert_eq!(
            cfg(&[]),
            GuardCfg {
                pause_mb: 1350,
                resume_mb: 1290,
                trim: true,
                soft_trim_mb: 1150,
                soft_trim_every_s: 300,
                regrow_trim_mb: 80,
                regrow_trim_min_s: 60,
                trim_first: true,
                trim_first_gap_s: 20,
                basis_inuse: false,
                inuse_pause_mb: 1200,
                inuse_resume_mb: 1140,
                rss_hard_mb: 1600,
                rss_hard_resume_mb: 1500
            }
        );
        // Fix 13c switches.
        assert!(cfg(&[("ARBSIM_AHEAD_MEM_BASIS", "inuse")]).basis_inuse);
        assert!(cfg(&[("ARBSIM_AHEAD_MEM_BASIS", " InUse ")]).basis_inuse);
        assert!(!cfg(&[("ARBSIM_AHEAD_MEM_BASIS", "rss")]).basis_inuse);
        assert!(!cfg(&[("ARBSIM_AHEAD_MEM_BASIS", "junk")]).basis_inuse, "anything else = rss, as before");
        let flap = cfg(&[("ARBSIM_AHEAD_MEM_RSS_HARD_MB", "1600"), ("ARBSIM_AHEAD_MEM_RSS_HARD_RESUME_MB", "1700")]);
        assert_eq!(flap.rss_hard_resume_mb, 1520, "resume at/above the line is pulled 5% below it");
        // Fix 13 switches and their limits.
        assert_eq!(cfg(&[("ARBSIM_MEM_REGROW_TRIM_MB", "0")]).regrow_trim_mb, 0);
        assert_eq!(cfg(&[("ARBSIM_MEM_REGROW_TRIM_MIN_S", "5")]).regrow_trim_min_s, 30, "never more often than every 30 s");
        assert_eq!(cfg(&[("ARBSIM_AHEAD_MEM_TRIM_FIRST", "off")]).trim_first, false);
        assert_eq!(cfg(&[("ARBSIM_AHEAD_MEM_TRIM_FIRST_GAP_S", "0")]).trim_first_gap_s, 5);
        assert_eq!(cfg(&[("ARBSIM_MEM_SOFT_TRIM_MB", "0")]).soft_trim_mb, 0);
        assert_eq!(cfg(&[("ARBSIM_MEM_SOFT_TRIM_EVERY_S", "1")]).soft_trim_every_s, 30, "never more often than every 30 s");
        assert_eq!(cfg(&[("ARBSIM_AHEAD_MEM_PAUSE_MB", "0")]).pause_mb, 0);
        assert_eq!(cfg(&[("ARBSIM_AHEAD_MEM_TRIM", "off")]).trim, false);
        // A resume line at / above the pause line is pulled 5% below it.
        assert_eq!(cfg(&[("ARBSIM_AHEAD_MEM_PAUSE_MB", "1000"), ("ARBSIM_AHEAD_MEM_RESUME_MB", "1000")]).resume_mb, 950);
        assert_eq!(cfg(&[("ARBSIM_AHEAD_MEM_PAUSE_MB", "junk")]).pause_mb, 1350);
    }

    #[test]
    fn pauses_at_the_line_and_resumes_below_the_lower_one() {
        let c = cfg(&[]);
        let mut g = Guard::default();
        // Default lines: pause at 1350 MB, carry on below 1290 MB. The old
        // 1200 MB line is now normal running and must not pause.
        assert_eq!(g.look(&c, 1200.0), Step::Same);
        assert_eq!(g.look(&c, 1349.9), Step::Same);
        assert_eq!(g.look(&c, 1350.0), Step::Paused);
        // In between the two lines: stays paused (no flapping).
        assert_eq!(g.look(&c, 1320.0), Step::Same);
        assert!(g.paused);
        assert_eq!(g.look(&c, 1289.0), Step::Resumed);
        assert!(!g.paused);
        assert_eq!(g.look(&c, 1320.0), Step::Same, "not paused again until the pause line");
        assert_eq!((g.pauses, g.resumes), (1, 1));
        // Off: never pauses.
        let off = cfg(&[("ARBSIM_AHEAD_MEM_PAUSE_MB", "0")]);
        let mut g = Guard::default();
        assert_eq!(g.look(&off, 5000.0), Step::Same);
    }

    /// SOFT TRIM (Nov 2): the live pattern. In use flat ~950 MB, glibc's kept
    /// free memory pushes the process from 1,000 to 1,340 MB in 45 min. The
    /// soft trim fires at the soft line, not again within the interval, not
    /// while paused (the pause has its own trims), and never when off.
    #[test]
    fn soft_trim_fires_above_the_soft_line_at_most_every_interval() {
        let c = cfg(&[]);
        assert!(!soft_trim_due(&c, false, 1100.0, None), "below the soft line: nothing");
        assert!(soft_trim_due(&c, false, 1150.0, None), "at the soft line: first trim");
        assert!(!soft_trim_due(&c, false, 1250.0, Some(299)), "not again within 300 s");
        assert!(soft_trim_due(&c, false, 1250.0, Some(300)), "again after 300 s");
        assert!(!soft_trim_due(&c, true, 1400.0, None), "paused: the pause's own trims");
        let off = cfg(&[("ARBSIM_MEM_SOFT_TRIM_MB", "0")]);
        assert!(!soft_trim_due(&off, false, 1700.0, None), "off: never");
        // Simulated 60 min at the live slope (+7.5 MB/min of kept free
        // memory) with a trim handing back what glibc kept: the process
        // never reaches the 1350 pause line.
        let (mut rss, mut last, mut max, mut trims) = (1000.0f64, None::<u64>, 0.0f64, 0);
        for min in 0..60u64 {
            rss += 7.5;
            let since = last.map(|l| (min - l) * 60);
            if soft_trim_due(&c, false, rss, since) {
                rss = 960.0; // back to what is in use
                last = Some(min);
                trims += 1;
            }
            max = f64::max(max, rss);
        }
        assert!(max < c.pause_mb as f64, "max {max}");
        assert!((2..=12).contains(&trims), "trims {trims}");
    }

    /// REGROW TRIM (fix 13): fires above the soft line once the process grew
    /// 80 MB since the last trim ended, not within 60 s of the last soft trim,
    /// not while paused, not before a first trim, and never when off.
    #[test]
    fn regrow_trim_fires_on_growth_since_the_last_trim() {
        let c = cfg(&[]);
        assert!(!regrow_trim_due(&c, false, 1300.0, Some(120), None), "no trim yet: the plain soft trim decides");
        assert!(!regrow_trim_due(&c, false, 1200.0, Some(120), Some(1150.0)), "+50 MB: not yet");
        assert!(regrow_trim_due(&c, false, 1230.0, Some(120), Some(1150.0)), "+80 MB: trim");
        assert!(!regrow_trim_due(&c, false, 1230.0, Some(59), Some(1150.0)), "within 60 s: not yet");
        assert!(!regrow_trim_due(&c, true, 1400.0, Some(120), Some(1150.0)), "paused: the pause's own trims");
        assert!(!regrow_trim_due(&c, false, 1100.0, Some(120), Some(1000.0)), "below the soft line: nothing");
        let off = cfg(&[("ARBSIM_MEM_REGROW_TRIM_MB", "0")]);
        assert!(!regrow_trim_due(&off, false, 1400.0, Some(999), Some(1000.0)), "off: never");
        let soft_off = cfg(&[("ARBSIM_MEM_SOFT_TRIM_MB", "0")]);
        assert!(!regrow_trim_due(&soft_off, false, 1400.0, Some(999), Some(1000.0)), "soft trim off: regrow off too");
    }

    /// TRIM FIRST (fix 13): only when about to pause, and not right after a trim.
    #[test]
    fn trim_first_only_at_the_pause_line() {
        let c = cfg(&[]);
        assert!(!trim_first_due(&c, false, 1349.0, None), "below the pause line: nothing");
        assert!(trim_first_due(&c, false, 1350.0, None), "at the line, never trimmed: trim first");
        assert!(trim_first_due(&c, false, 1400.0, Some(20)), "last trim 20 s ago: trim first");
        assert!(!trim_first_due(&c, false, 1400.0, Some(19)), "trimmed 19 s ago: pause as before");
        assert!(!trim_first_due(&c, true, 1400.0, None), "already paused: the pause's own trims");
        assert!(!trim_first_due(&cfg(&[("ARBSIM_AHEAD_MEM_TRIM_FIRST", "off")]), false, 1400.0, None), "off");
        assert!(!trim_first_due(&cfg(&[("ARBSIM_AHEAD_MEM_PAUSE_MB", "0")]), false, 9000.0, None), "guard off");
    }

    /// The live Nov 2 pattern, minute by minute for 2 hours: in use flat
    /// ~1,050 MB, glibc's kept free memory regrows ~40 MB a minute (~200 MB
    /// between two 300 s soft trims, as measured), a trim brings the process
    /// back to in use + 110 MB (live: ~1,150-1,200 MB after a trim). Old rules (soft trim every 300 s only): the
    /// process crosses the 1350 pause line. Fix 13 (regrow + trim first): it
    /// never pauses, and trims at most once a minute.
    #[test]
    fn live_pattern_no_pause_with_fix13() {
        fn run(c: &GuardCfg) -> (u64, f64, u64) {
            let (in_use, regrow_per_min, after_trim) = (1050.0f64, 40.0f64, 1160.0f64);
            let mut rss = 1150.0f64;
            let (mut g, mut last_soft, mut after_last, mut last_any) = (Guard::default(), None::<u64>, None::<f64>, None::<u64>);
            let (mut max, mut trims) = (0.0f64, 0u64);
            for min in 0..120u64 {
                rss += regrow_per_min;
                let s = |t: Option<u64>| t.map(|l| (min - l) * 60);
                if trim_first_due(c, g.paused, rss, s(last_any)) {
                    rss = after_trim;
                    after_last = Some(rss);
                    last_any = Some(min);
                    trims += 1;
                }
                g.look(c, rss);
                if soft_trim_due(c, g.paused, rss, s(last_soft)) || regrow_trim_due(c, g.paused, rss, s(last_soft), after_last) {
                    rss = after_trim;
                    after_last = Some(rss);
                    last_soft = Some(min);
                    last_any = Some(min);
                    trims += 1;
                }
                max = max.max(rss);
                assert!(rss >= in_use);
            }
            (g.pauses, max, trims)
        }
        let old = cfg(&[("ARBSIM_MEM_REGROW_TRIM_MB", "0"), ("ARBSIM_AHEAD_MEM_TRIM_FIRST", "off")]);
        let (old_pauses, old_max, _) = run(&old);
        assert!(old_pauses > 0 && old_max >= 1350.0, "old rules pause: {old_pauses} pauses, max {old_max}");
        let (pauses, max, trims) = run(&cfg(&[]));
        assert_eq!(pauses, 0, "fix 13: no pause (max {max})");
        assert!(max < 1300.0, "fix 13 max {max}");
        assert!(trims <= 120, "at most one trim a minute: {trims}");
    }

    /// Fix 13c: the `inuse` basis. The live pattern after fix 13: in use
    /// ~850-1,000 MB, process ~1,250-1,380 MB (glibc holes) with bursts:
    /// no pause; real growth of what is held, or the process at the hard
    /// line: pause; carry on only when both are below their resume lines.
    #[test]
    fn inuse_basis_pauses_on_real_memory_or_the_hard_line() {
        let c = cfg(&[("ARBSIM_AHEAD_MEM_BASIS", "inuse")]);
        let mut g = Guard::default();
        assert_eq!(g.look_mem(&c, 1380.0, Some(950.0)), Step::Same, "rss over 1350 but in use normal: no pause");
        assert_eq!(g.look_mem(&c, 1599.0, Some(1100.0)), Step::Same, "burst below the hard line: no pause");
        assert_eq!(g.look_mem(&c, 1600.0, Some(1000.0)), Step::Paused, "hard line: pause");
        assert_eq!(g.look_mem(&c, 1450.0, Some(1150.0)), Step::Same, "in use still above its resume line: stay paused");
        assert_eq!(g.look_mem(&c, 1450.0, Some(1100.0)), Step::Resumed, "both below their resume lines: carry on");
        assert_eq!(g.look_mem(&c, 1300.0, Some(1200.0)), Step::Paused, "in use at its line: pause");
        assert_eq!(g.look_mem(&c, 1510.0, Some(900.0)), Step::Same, "process above its resume line: stay paused");
        assert_eq!(g.look_mem(&c, 1490.0, Some(900.0)), Step::Resumed);
        // No counter (None) or the rss basis: exactly the old guard.
        let mut g = Guard::default();
        assert_eq!(g.look_mem(&c, 1350.0, None), Step::Paused, "no counter: rss rules");
        let rss = cfg(&[]);
        let mut g = Guard::default();
        assert_eq!(g.look_mem(&rss, 1350.0, Some(500.0)), Step::Paused, "rss basis ignores in use");
        // Trim first acts at the hard line with `inuse`, the pause line otherwise.
        assert_eq!(rss_pause_line(&c, true), 1600);
        assert_eq!(rss_pause_line(&c, false), 1350);
        assert_eq!(rss_pause_line(&rss, true), 1350);
        assert!(!trim_first_due_at(&c, rss_pause_line(&c, true), false, 1400.0, None));
        assert!(trim_first_due_at(&c, rss_pause_line(&c, true), false, 1600.0, None));
        // Off switch still wins.
        let off = cfg(&[("ARBSIM_AHEAD_MEM_BASIS", "inuse"), ("ARBSIM_AHEAD_MEM_PAUSE_MB", "0")]);
        let mut g = Guard::default();
        assert_eq!(g.look_mem(&off, 5000.0, Some(5000.0)), Step::Same, "guard off");
    }

    #[test]
    fn breakdown_has_the_fields() {
        let s = status_json();
        assert!(s["rssMb"].as_f64().unwrap() > 0.0);
        assert!(s["peakRssMb"].as_f64().unwrap() >= s["rssMb"].as_f64().unwrap() - 1.0);
        // The library's tests run on glibc (no `alloc::Chosen` here).
        assert_eq!(s["allocator"], json!("system"));
        assert!(s["malloc"]["inUseMb"].is_number());
        assert_eq!(s["aheadGuard"]["pauseMb"], json!(1350));
        assert_eq!(s["softTrim"]["mb"], json!(1150));
        assert_eq!(s["softTrim"]["regrowMb"], json!(80));
        assert_eq!(s["trimFirst"]["on"], json!(true));
        assert_eq!(s["aheadGuard"]["basis"], json!("rss"));
        assert_eq!(s["aheadGuard"]["rssHardMb"], json!(1600));
        assert!(s["countedInUseMb"].is_number());
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
