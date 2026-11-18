// ============================================================================
// ENGINE TRIAL: does the sniper's own engine copy really work on the live
// chain, inside its node budget? (run 12 morning step 1)
//
// Plain English:
//   The dex bot learned the hard way (sim/COPY2_PLAN.md) that this engine
//   mode, "replay every chain transaction" (ARBSIM_SOURCE=feed), needed
//   ~2.1M node reads a day on the live chain. The sniper's engine is given
//   3,000 paid reads a day (plus the free public node). Every earlier test
//   used a fake node, so nobody knows yet whether it answers our quotes or
//   says "unknown" most of the time. This trial measures exactly that.
//
//   Run by `bash deploy/sniper-engine.sh trial [minutes]`, which starts the
//   engine first. This program then:
//     1. forwards the sequencer feed relay (SNIPER_RHC_FEED) into the engine
//        (the same forwarder the paper bot uses; the paper bot itself is not
//        touched);
//     2. picks a sample of HOT Uniswap V3 pools: the pools with the most
//        rush lines near the end of the newest paper run's signals.jsonl;
//     3. every minute (TRIAL_TICK_SECS) asks the engine for:
//          - its status: ready or not, paid node reads used vs its cap,
//            public node reads, memory;
//          - one real quote per sample pool (the same QuoterV2 call the
//            paper bot makes), counted as "answered" or "unknown" (with the
//            engine's reason);
//        and reads the engine's CPU use from /proc. One line per minute;
//     4. at the end prints a plain-English verdict with the numbers:
//          WORKS / FALLS BACK TOO OFTEN / TOO MUCH MEMORY OR CPU.
//
//   It never talks to a node itself (it gets no node link at all). The
//   engine makes its own node reads, inside its own cap, as it would for
//   the paper bot. Read-only: no keys, never sends a transaction.
//
// Settings (environment, set by deploy/sniper-engine.sh):
//   SNIPER_ENGINE_SOCKET   engine socket (default /tmp/sniper-arbsim.sock)
//   SNIPER_RHC_FEED        feed relay to forward
//   TRIAL_MINUTES          how many ticks (default 30)
//   TRIAL_TICK_SECS        seconds per tick (default 60; tests use 1)
//   TRIAL_SIGNALS          signals.jsonl to pick hot pools from
//   TRIAL_SAMPLE           sample pools (default 10)
//   TRIAL_MIN_ANSWER_PCT   answered share needed after warm-up (default 80)
//   TRIAL_MAX_CPU_PCT      engine CPU limit, % of one core (default 60)
//   ENGINE_PID             engine process (for CPU and memory from /proc)
//   ENGINE_MEM_LIMIT_MB    memory limit (default 1500; over it = stop early)
//   ENGINE_DAILY_CAP       the engine's paid node cap (default 3000)
// Exit code: 0 works, 2 does not work well enough, 3 over the memory limit,
// 1 the trial itself could not run.
// ============================================================================
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ruint::aliases::U256;
use serde_json::{json, Value};

use crate::engine::{EngineClient, EngineConfig};
use crate::paper::{quote_via, USDG, WETH};
use crate::venue::Venue;

/// The engine quote timeout used by the paper bot (SNIPER_ENGINE_TIMEOUT_MS
/// default): an answer slower than this would be a fallback there.
pub const PAPER_TIMEOUT_MS: f64 = 50.0;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct TrialCfg {
    pub socket: String,
    pub feed: String,
    pub ticks: u64,
    pub tick: Duration,
    pub signals: String,
    pub sample: usize,
    pub min_answer_pct: f64,
    pub max_cpu_pct: f64,
    pub pid: Option<u32>,
    pub mem_limit_mb: f64,
    pub cap: u64,
}

impl TrialCfg {
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Self {
        let num = |k: &str, d: f64| get(k).and_then(|v| v.trim().parse::<f64>().ok()).filter(|x| x.is_finite() && *x >= 0.0).unwrap_or(d);
        TrialCfg {
            socket: get("SNIPER_ENGINE_SOCKET").filter(|s| !s.trim().is_empty()).unwrap_or_else(|| crate::engine::DEFAULT_SOCKET.into()),
            feed: get("SNIPER_RHC_FEED").unwrap_or_default(),
            ticks: num("TRIAL_MINUTES", 30.0).clamp(1.0, 24.0 * 60.0) as u64,
            tick: Duration::from_secs_f64(num("TRIAL_TICK_SECS", 60.0).clamp(0.2, 3600.0)),
            signals: get("TRIAL_SIGNALS").unwrap_or_default(),
            sample: num("TRIAL_SAMPLE", 10.0).clamp(1.0, 100.0) as usize,
            min_answer_pct: num("TRIAL_MIN_ANSWER_PCT", 80.0),
            max_cpu_pct: num("TRIAL_MAX_CPU_PCT", 60.0),
            pid: get("ENGINE_PID").and_then(|p| p.trim().parse().ok()),
            mem_limit_mb: num("ENGINE_MEM_LIMIT_MB", 1500.0),
            cap: num("ENGINE_DAILY_CAP", 3000.0) as u64,
        }
    }
}

// ---------------------------------------------------------------------------
// Hot pool sample
// ---------------------------------------------------------------------------

/// The hot V3 pools: among the last `window` lines of signals.jsonl (rush
/// lines, taken or skipped, main or young), the `n` pools with the most
/// rushes; ties go to the pool seen most recently. Lines without a pool or
/// on another venue are ignored.
pub fn pick_hot_v3(lines: &[Value], n: usize, window: usize) -> Vec<String> {
    let start = lines.len().saturating_sub(window);
    // pool -> (rushes, last line index)
    let mut count: HashMap<String, (usize, usize)> = HashMap::new();
    for (i, l) in lines.iter().enumerate().skip(start) {
        if l["venue"] != "v3" || l.get("live_skip").is_some() {
            continue;
        }
        let Some(p) = l["pool"].as_str() else { continue };
        let e = count.entry(p.to_ascii_lowercase()).or_insert((0, 0));
        e.0 += 1;
        e.1 = i;
    }
    let mut v: Vec<(String, (usize, usize))> = count.into_iter().collect();
    v.sort_by(|a, b| b.1 .0.cmp(&a.1 .0).then(b.1 .1.cmp(&a.1 .1)));
    v.into_iter().take(n).map(|(p, _)| p).collect()
}

/// A sample pool once the engine told us its coins and fee.
#[derive(Clone, Debug, PartialEq)]
pub struct SamplePool {
    pub pool: String,
    pub token: String,
    pub base: String,
    pub base_name: &'static str,
    pub fee: u32,
}

/// From the pool's token0() / token1() / fee() answers: which side is the
/// base (WETH or USDG). None = not a pool the paper bot trades.
pub fn sample_from(pool: &str, t0: &str, t1: &str, fee: &str) -> Option<SamplePool> {
    let addr = |w: &str| {
        let h = w.trim_start_matches("0x");
        (h.len() >= 40).then(|| format!("0x{}", &h[h.len() - 40..]).to_ascii_lowercase())
    };
    let (a0, a1) = (addr(t0)?, addr(t1)?);
    let fee = u32::from_str_radix(fee.trim_start_matches("0x").trim_start_matches('0'), 16).unwrap_or(0);
    let pick = |base: &str, name: &'static str| {
        if a0 == base {
            Some(SamplePool { pool: pool.into(), token: a1.clone(), base: a0.clone(), base_name: name, fee })
        } else if a1 == base {
            Some(SamplePool { pool: pool.into(), token: a0.clone(), base: a1.clone(), base_name: name, fee })
        } else {
            None
        }
    };
    pick(WETH, "WETH").or_else(|| pick(USDG, "USDG"))
}

// ---------------------------------------------------------------------------
// One minute's numbers
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Sample {
    pub minute: u64,
    pub status_ok: bool,
    pub ready: bool,
    pub head: Option<u64>,
    pub paid_used: Option<u64>,
    pub paid_refused: u64,
    pub public_used: Option<u64>,
    pub rss_mb: Option<f64>,
    pub cpu_pct: Option<f64>,
    pub answered: u64,
    pub unknown: u64,
    /// Answers within the paper bot's 50 ms engine timeout.
    pub fast: u64,
    pub reasons: BTreeMap<String, u64>,
    pub answer_ms: Vec<f64>,
    pub frames_sent: u64,
}

impl Sample {
    pub fn line(&self, cap: u64) -> String {
        let reasons: Vec<String> = self.reasons.iter().map(|(k, v)| format!("{k} {v}")).collect();
        format!(
            "minute {:>3} | {} | head {} | paid node {}/{cap}{} | public node {} | quotes answered {} unknown {}{} | memory {} MB | CPU {}% | feed frames sent {}",
            self.minute,
            if !self.status_ok { "NOT ANSWERING" } else if self.ready { "ready" } else { "not ready" },
            self.head.map_or("-".into(), |h| h.to_string()),
            self.paid_used.map_or("?".into(), |u| u.to_string()),
            if self.paid_refused > 0 { format!(" (REFUSED {})", self.paid_refused) } else { String::new() },
            self.public_used.map_or("?".into(), |u| u.to_string()),
            self.answered,
            self.unknown,
            if reasons.is_empty() { String::new() } else { format!(" ({})", reasons.join(", ")) },
            self.rss_mb.map_or("?".into(), |m| format!("{m:.0}")),
            self.cpu_pct.map_or("?".into(), |c| format!("{c:.0}")),
            self.frames_sent
        )
    }
}

/// Fill a sample's status part from the engine's status answer.
pub fn read_status(s: &mut Sample, v: &Value) {
    s.status_ok = v["ok"] == json!(true) || v.get("ready").is_some();
    s.ready = v["ready"] == json!(true);
    s.head = v["head"]["block"].as_u64();
    s.paid_used = v["node"]["usedToday"].as_u64();
    s.paid_refused = v["node"]["refusedToday"].as_u64().unwrap_or(0);
    s.public_used = v["node"]["public"]["usedToday"].as_u64();
    if s.rss_mb.is_none() {
        s.rss_mb = v["rssMb"].as_f64();
    }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct Verdict {
    /// "WORKS", or the problems joined ("FALLS BACK TOO OFTEN", "TOO MUCH
    /// MEMORY OR CPU").
    pub headline: String,
    pub works: bool,
    pub over_memory: bool,
    pub text: String,
}

/// Paid node reads per day, projected from the samples' first and last
/// readings (a UTC-midnight reset in between counts from 0 again).
pub fn project_per_day(first: Option<u64>, last: Option<u64>, minutes: f64) -> Option<f64> {
    let (a, b) = (first?, last?);
    if minutes <= 0.0 {
        return None;
    }
    let used = if b >= a { b - a } else { b };
    Some(used as f64 / minutes * 1440.0)
}

/// The plain-English verdict. The first third of the samples (at least 1,
/// at most 5) is warm-up: the engine is still loading, so the answer rate
/// and the node-read projection use only the minutes after it. Memory and
/// CPU use every minute.
pub fn verdict(samples: &[Sample], cfg: &TrialCfg, minute_s: f64) -> Verdict {
    let n = samples.len();
    let warm = if n >= 2 { (n / 3).clamp(1, 5) } else { 0 };
    let after = &samples[warm.min(n)..];
    let sum = |f: &dyn Fn(&Sample) -> u64, v: &[Sample]| v.iter().map(f).sum::<u64>();
    let (ans, unk, fast) = (sum(&|s| s.answered, after), sum(&|s| s.unknown, after), sum(&|s| s.fast, after));
    let asked = ans + unk;
    let answer_pct = if asked > 0 { 100.0 * ans as f64 / asked as f64 } else { 0.0 };
    let fast_pct = if asked > 0 { 100.0 * fast as f64 / asked as f64 } else { 0.0 };
    let ready_pct = if after.is_empty() { 0.0 } else { 100.0 * after.iter().filter(|s| s.ready).count() as f64 / after.len() as f64 };
    let mut reasons: BTreeMap<String, u64> = BTreeMap::new();
    for s in after {
        for (k, v) in &s.reasons {
            *reasons.entry(k.clone()).or_default() += v;
        }
    }
    let mins = |v: &[Sample]| v.len().saturating_sub(1) as f64 * minute_s / 60.0;
    let proj_all = project_per_day(samples.first().and_then(|s| s.paid_used), samples.last().and_then(|s| s.paid_used), mins(samples));
    let proj_steady = project_per_day(after.first().and_then(|s| s.paid_used), after.last().and_then(|s| s.paid_used), mins(after));
    let pub_steady = project_per_day(after.first().and_then(|s| s.public_used), after.last().and_then(|s| s.public_used), mins(after));
    let refused = samples.iter().map(|s| s.paid_refused).max().unwrap_or(0);
    let last_used = samples.iter().rev().find_map(|s| s.paid_used).unwrap_or(0);
    let max_rss = samples.iter().filter_map(|s| s.rss_mb).fold(None, |m: Option<f64>, x| Some(m.map_or(x, |m| m.max(x))));
    let cpus: Vec<f64> = samples.iter().filter_map(|s| s.cpu_pct).collect();
    let avg_cpu = (!cpus.is_empty()).then(|| cpus.iter().sum::<f64>() / cpus.len() as f64);
    let frames = samples.last().map_or(0, |s| s.frames_sent);

    let mut problems: Vec<&str> = Vec::new();
    let mut why: Vec<String> = Vec::new();
    // Falls back: too few answers, the paid cap used up / refusing, or on
    // course to run out within a day.
    let mut falls = false;
    if asked == 0 {
        falls = true;
        why.push("no quote could be asked after warm-up (no sample pools, or the engine never told us their coins)".into());
    } else if answer_pct < cfg.min_answer_pct {
        falls = true;
        why.push(format!("only {answer_pct:.0}% of quotes answered after warm-up (need {:.0}%); the paper bot would ask the node for the rest", cfg.min_answer_pct));
    }
    if refused > 0 || (cfg.cap > 0 && last_used >= cfg.cap) {
        falls = true;
        why.push(format!("the paid node cap is used up or refusing ({last_used}/{} used, {refused} refused today): every value it still has to fetch becomes \"unknown\"", cfg.cap));
    } else if let Some(p) = proj_steady.filter(|p| cfg.cap > 0 && *p > cfg.cap as f64) {
        falls = true;
        why.push(format!("paid node reads are on course for ~{p:.0} a day, over the {} cap: it would start answering \"unknown\" later in the day", cfg.cap));
    }
    if after.is_empty() || ready_pct < 50.0 {
        falls = true;
        why.push(format!("ready only {ready_pct:.0}% of the minutes after warm-up"));
    }
    if frames == 0 {
        falls = true;
        why.push("no feed frame reached the engine (is SNIPER_RHC_FEED the relay, and is it up?)".into());
    }
    if falls {
        problems.push("FALLS BACK TOO OFTEN");
    }
    let over_memory = max_rss.is_some_and(|m| m > cfg.mem_limit_mb);
    let heavy_cpu = avg_cpu.is_some_and(|c| c > cfg.max_cpu_pct);
    if over_memory {
        why.push(format!("memory reached {:.0} MB, over the {:.0} MB limit", max_rss.unwrap_or(0.0), cfg.mem_limit_mb));
    }
    if heavy_cpu {
        why.push(format!("CPU averaged {:.0}% of one core, over the {:.0}% limit (the server has 2 cores and also runs the paper bot)", avg_cpu.unwrap_or(0.0), cfg.max_cpu_pct));
    }
    if over_memory || heavy_cpu {
        problems.push("TOO MUCH MEMORY OR CPU");
    }
    let works = problems.is_empty();
    let headline = if works { "WORKS".to_string() } else { problems.join(" + ") };
    let fmt_opt = |x: Option<f64>| x.map_or("?".to_string(), |v| format!("{v:.0}"));
    let mut text = format!("ENGINE TRIAL VERDICT: {headline}\n");
    text += &format!(
        "  {} minute(s) measured ({} warm-up minute(s) left out of the answer rate), {} sample pool quote(s) after warm-up\n",
        n, warm, asked
    );
    text += &format!(
        "  quotes answered {ans} of {asked} ({answer_pct:.0}%), {fast} within the paper bot's 50 ms ({fast_pct:.0}%) | unknown {unk}{}\n",
        if reasons.is_empty() { String::new() } else { format!(" ({})", reasons.iter().map(|(k, v)| format!("{k} {v}")).collect::<Vec<_>>().join(", ")) }
    );
    text += &format!(
        "  paid node reads: {last_used} used today of the {} cap, {refused} refused | on course for ~{} a day after warm-up (~{} a day counting warm-up)\n",
        cfg.cap,
        fmt_opt(proj_steady),
        fmt_opt(proj_all)
    );
    text += &format!("  public node reads: on course for ~{} a day (free, but limited to ~6 a second)\n", fmt_opt(pub_steady));
    text += &format!(
        "  ready {ready_pct:.0}% of the minutes | memory peak {} MB (limit {:.0}) | CPU average {}% of one core (limit {:.0}%) | feed frames sent {frames}\n",
        fmt_opt(max_rss),
        cfg.mem_limit_mb,
        fmt_opt(avg_cpu),
        cfg.max_cpu_pct
    );
    if works {
        text += "  Meaning: the engine can be used for run 12 (SNIPER_ENGINE=1 + feed wake-up), still side by side first (SNIPER_ENGINE_CHECK=1).\n";
    } else {
        for w in &why {
            text += &format!("  - {w}\n");
        }
        text += "  Meaning: do NOT turn the engine on for run 12. Use the free WebSocket estimate (SNIPER_WS_HOT_ESTIMATE) and, if it fits the node budget, SNIPER_WS_HOT=1 instead.\n";
    }
    Verdict { headline, works, over_memory, text }
}

// ---------------------------------------------------------------------------
// CPU from /proc (Linux)
// ---------------------------------------------------------------------------

/// utime + stime of a process, in clock ticks (100 a second on Linux).
pub fn cpu_ticks(pid: u32) -> Option<u64> {
    let s = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    parse_cpu_ticks(&s)
}

/// From the text of /proc/<pid>/stat: fields 14 and 15 (after the command
/// name in brackets, which may itself contain spaces).
pub fn parse_cpu_ticks(stat: &str) -> Option<u64> {
    let rest = &stat[stat.rfind(')')? + 1..];
    let f: Vec<&str> = rest.split_whitespace().collect();
    // rest starts at field 3 (state), so utime (14) is index 11, stime 12.
    Some(f.get(11)?.parse::<u64>().ok()? + f.get(12)?.parse::<u64>().ok()?)
}

/// Resident memory of a process in MB, from /proc/<pid>/status (VmRSS).
pub fn rss_mb(pid: u32) -> Option<f64> {
    let s = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let line = s.lines().find(|l| l.starts_with("VmRSS:"))?;
    let kb: f64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb / 1024.0)
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

fn ask_status(sock: &str) -> Option<Value> {
    use std::os::unix::net::UnixStream;
    let mut s = UnixStream::connect(sock).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(3)));
    crate::engine::write_msg(&mut s, json!({"id": 1, "type": "status"}).to_string().as_bytes()).ok()?;
    let b = crate::engine::read_msg(&mut s).ok()??;
    serde_json::from_slice(&b).ok()
}

/// Short reason for an engine "unknown" (same buckets the paper bot counts).
fn reason_of(e: &str) -> String {
    crate::engine::fallback_reason(e).to_string()
}

pub fn run(cfg: TrialCfg) -> i32 {
    if cfg.feed.trim().is_empty() {
        eprintln!("engine-trial: SNIPER_RHC_FEED is not set (the feed relay to forward)");
        return 1;
    }
    let lines: Vec<Value> = std::fs::read_to_string(&cfg.signals).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let hot = pick_hot_v3(&lines, cfg.sample, 20_000);
    println!(
        "engine trial: {} tick(s) of {:.0} s | {} hot V3 sample pool(s) from {} | memory limit {:.0} MB | paid cap {}",
        cfg.ticks,
        cfg.tick.as_secs_f64(),
        hot.len(),
        if cfg.signals.is_empty() { "<no signals file>" } else { Path::new(&cfg.signals).parent().and_then(|p| p.file_name()).and_then(|f| f.to_str()).unwrap_or("?") },
        cfg.mem_limit_mb,
        cfg.cap
    );
    let stop = Arc::new(AtomicBool::new(false));
    let ecfg = EngineConfig { on: true, socket: cfg.socket.clone(), timeout: Duration::from_millis(50), at: "head", check: false, forward: true, queue: 512, feed: cfg.feed.clone() };
    let fwd = crate::engine::spawn_forwarder(&ecfg, stop.clone());
    // Generous timeout: we want to know if it CAN answer; speed is counted
    // separately (answers within the paper bot's 50 ms).
    let eng = EngineClient::new(&cfg.socket, Duration::from_millis(1000), "head");
    let mut pools: HashMap<String, SamplePool> = HashMap::new();
    let mut samples: Vec<Sample> = Vec::new();
    let mut cpu_prev: Option<(u64, Instant)> = cfg.pid.and_then(cpu_ticks).map(|t| (t, Instant::now()));
    let started = Instant::now();
    for minute in 1..=cfg.ticks {
        let due = started + cfg.tick * minute as u32;
        std::thread::sleep(due.saturating_duration_since(Instant::now()));
        let mut s = Sample { minute, ..Default::default() };
        if let Some(pid) = cfg.pid {
            s.rss_mb = rss_mb(pid);
            if let (Some(now), Some((before, at))) = (cpu_ticks(pid), cpu_prev) {
                let secs = at.elapsed().as_secs_f64();
                if secs > 0.0 {
                    s.cpu_pct = Some(now.saturating_sub(before) as f64 / 100.0 / secs * 100.0);
                }
                cpu_prev = Some((now, Instant::now()));
            }
        }
        if let Some(v) = ask_status(&cfg.socket) {
            read_status(&mut s, &v);
        }
        for p in &hot {
            // Learn the pool's coins once (from the engine, not a node).
            if !pools.contains_key(p) {
                let calls = [(p.clone(), "0x0dfe1681".to_string()), (p.clone(), "0xd21220a7".to_string()), (p.clone(), "0xddca3f43".to_string())];
                match eng.call_at(&json!({"after": "head"}), &calls) {
                    Ok((outs, _)) => {
                        if let (Some(Some(a)), Some(Some(b)), Some(Some(f))) = (outs.first(), outs.get(1), outs.get(2)) {
                            if let Some(sp) = sample_from(p, a, b, f) {
                                pools.insert(p.clone(), sp);
                            }
                        }
                    }
                    Err(e) => {
                        s.unknown += 1;
                        *s.reasons.entry(e).or_default() += 1;
                        continue;
                    }
                }
            }
            let Some(sp) = pools.get(p) else { continue };
            // A small buy: 0.01 of the base coin's unit (0.01 WETH / 0.01 USDG ...
            // the size does not matter for "answered or not").
            let amount = U256::from(10u64).pow(U256::from(crate::rhc::base_decimals(sp.base_name).max(2) as u64 - 2));
            let t = Instant::now();
            // Engine reasons carry an "engine:" mark (as in the paper bot's quoter),
            // so a quote-maths problem on a real answer counts as "bad_answer".
            let r = quote_via(&|to, data| eng.eth_call(to, data).map(|ok| Some(ok.output)).map_err(|e| format!("engine:{e}")), &Venue::V3 { fee: sp.fee }, &sp.base, &sp.token, amount);
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            match r {
                Ok(_) => {
                    s.answered += 1;
                    s.answer_ms.push(ms);
                    if ms <= PAPER_TIMEOUT_MS {
                        s.fast += 1;
                    }
                }
                Err(e) => {
                    s.unknown += 1;
                    *s.reasons.entry(reason_of(&e)).or_default() += 1;
                }
            }
        }
        s.frames_sent = fwd.sent.load(Ordering::Relaxed);
        println!("{}", s.line(cfg.cap));
        let over = s.rss_mb.is_some_and(|m| m > cfg.mem_limit_mb);
        samples.push(s);
        if over {
            println!("engine trial: memory over the {:.0} MB limit, stopping early", cfg.mem_limit_mb);
            break;
        }
    }
    stop.store(true, Ordering::Relaxed);
    let v = verdict(&samples, &cfg, cfg.tick.as_secs_f64());
    print!("{}", v.text);
    if v.over_memory {
        3
    } else if v.works {
        0
    } else {
        2
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> TrialCfg {
        TrialCfg::from_lookup(|_| None)
    }

    fn good(minute: u64, used: u64) -> Sample {
        Sample { minute, status_ok: true, ready: true, paid_used: Some(used), public_used: Some(minute * 100), rss_mb: Some(400.0), cpu_pct: Some(20.0), answered: 10, fast: 10, frames_sent: minute * 500, ..Default::default() }
    }

    #[test]
    fn settings_defaults() {
        let c = cfg();
        assert_eq!((c.ticks, c.tick, c.sample, c.cap), (30, Duration::from_secs(60), 10, 3000));
        assert_eq!((c.min_answer_pct, c.max_cpu_pct, c.mem_limit_mb), (80.0, 60.0, 1500.0));
        assert_eq!(c.socket, crate::engine::DEFAULT_SOCKET);
    }

    #[test]
    fn hot_pools_most_rushes_then_most_recent() {
        let l = |p: &str, v: &str| json!({"pool": p, "venue": v, "block": 1});
        let lines = vec![l("0xA", "v3"), l("0xB", "v3"), l("0xA", "v3"), l("0xC", "v4"), l("0xC", "v4"), l("0xD", "v3"), json!({"pool": "0xE", "live_skip": "x"})];
        assert_eq!(pick_hot_v3(&lines, 2, 100), vec!["0xa", "0xd"], "A has 2, then D (newer than B)");
        assert_eq!(pick_hot_v3(&lines, 10, 2), vec!["0xd"], "only the last 2 lines count");
        assert!(pick_hot_v3(&[], 5, 100).is_empty());
    }

    #[test]
    fn sample_pool_finds_the_base_side() {
        let w = |a: &str| format!("0x{:0>64}", a.trim_start_matches("0x"));
        let tok = "0x00000000000000000000000000000000000c0123";
        let s = sample_from("0xpool", &w(tok), &w(WETH), &format!("0x{:064x}", 3000)).unwrap();
        assert_eq!((s.token.as_str(), s.base.as_str(), s.base_name, s.fee), (tok, WETH, "WETH", 3000));
        let s = sample_from("0xpool", &w(USDG), &w(tok), &format!("0x{:064x}", 500)).unwrap();
        assert_eq!((s.token.as_str(), s.base_name, s.fee), (tok, "USDG", 500));
        assert!(sample_from("0xpool", &w(tok), &w(tok), "0x0").is_none(), "no WETH/USDG side");
    }

    #[test]
    fn verdict_works_when_answers_budget_memory_cpu_are_fine() {
        // 10 minutes, ~1 paid read a minute = ~1,440 a day < 3,000.
        let s: Vec<Sample> = (1..=10).map(|m| good(m, 100 + m)).collect();
        let v = verdict(&s, &cfg(), 60.0);
        assert!(v.works, "{}", v.text);
        assert_eq!(v.headline, "WORKS");
        assert!(v.text.contains("answered 70 of 70 (100%)"), "warm-up (3 minutes) left out: {}", v.text);
    }

    #[test]
    fn verdict_falls_back_on_unknowns_cap_and_projection() {
        // Mostly unknown answers.
        let mut s: Vec<Sample> = (1..=10).map(|m| good(m, 100 + m)).collect();
        for x in s.iter_mut() {
            x.answered = 2;
            x.fast = 2;
            x.unknown = 8;
            x.reasons.insert("miss".into(), 8);
        }
        let v = verdict(&s, &cfg(), 60.0);
        assert!(!v.works && v.headline == "FALLS BACK TOO OFTEN", "{}", v.text);
        assert!(v.text.contains("only 20% of quotes answered"), "{}", v.text);
        // All answered, but burning ~10 paid reads a minute (~14,400 a day).
        let s: Vec<Sample> = (1..=10).map(|m| good(m, 100 + 10 * m)).collect();
        let v = verdict(&s, &cfg(), 60.0);
        assert!(!v.works && v.text.contains("on course for ~14400 a day"), "{}", v.text);
        // Cap hit / refusals.
        let mut s: Vec<Sample> = (1..=10).map(|m| good(m, 3000)).collect();
        s[9].paid_refused = 5;
        let v = verdict(&s, &cfg(), 60.0);
        assert!(!v.works && v.text.contains("used up or refusing"), "{}", v.text);
        // No feed frames at all.
        let mut s: Vec<Sample> = (1..=10).map(|m| good(m, 100)).collect();
        for x in s.iter_mut() {
            x.frames_sent = 0;
        }
        assert!(verdict(&s, &cfg(), 60.0).text.contains("no feed frame"));
    }

    #[test]
    fn verdict_memory_and_cpu() {
        let mut s: Vec<Sample> = (1..=10).map(|m| good(m, 100)).collect();
        s[4].rss_mb = Some(1600.0);
        let v = verdict(&s, &cfg(), 60.0);
        assert!(v.over_memory && v.headline == "TOO MUCH MEMORY OR CPU", "{}", v.text);
        let mut s: Vec<Sample> = (1..=10).map(|m| good(m, 100)).collect();
        for x in s.iter_mut() {
            x.cpu_pct = Some(90.0);
        }
        let v = verdict(&s, &cfg(), 60.0);
        assert!(!v.works && !v.over_memory && v.text.contains("CPU averaged 90%"), "{}", v.text);
        // Both problems at once.
        s[0].answered = 0;
        for x in s.iter_mut() {
            x.answered = 0;
            x.unknown = 10;
        }
        assert_eq!(verdict(&s, &cfg(), 60.0).headline, "FALLS BACK TOO OFTEN + TOO MUCH MEMORY OR CPU");
    }

    #[test]
    fn projection_handles_midnight_reset() {
        assert_eq!(project_per_day(Some(100), Some(160), 60.0), Some(1440.0));
        assert_eq!(project_per_day(Some(2900), Some(30), 60.0), Some(720.0), "counter reset at UTC midnight");
        assert_eq!(project_per_day(None, Some(5), 10.0), None);
        assert_eq!(project_per_day(Some(1), Some(5), 0.0), None);
    }

    #[test]
    fn status_and_proc_parsing() {
        let mut s = Sample::default();
        read_status(&mut s, &json!({"ok": true, "ready": true, "head": {"block": 77}, "rssMb": 512.5, "node": {"usedToday": 12, "refusedToday": 0, "public": {"usedToday": 345}}}));
        assert!(s.status_ok && s.ready);
        assert_eq!((s.head, s.paid_used, s.public_used, s.rss_mb), (Some(77), Some(12), Some(345), Some(512.5)));
        let stat = "1234 (arb sim) S 1 2 3 4 5 6 7 8 9 10 250 50 0 0 20 0";
        assert_eq!(parse_cpu_ticks(stat), Some(300));
        // This process itself: readable on Linux.
        if Path::new("/proc/self/stat").exists() {
            assert!(cpu_ticks(std::process::id()).is_some());
            assert!(rss_mb(std::process::id()).unwrap_or(0.0) > 0.0);
        }
    }
}
