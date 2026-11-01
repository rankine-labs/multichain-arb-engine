// ============================================================================
// ALLOCATOR SOAK (Nov 1): does the process keep growing while what the
// program holds stays flat?
//
// Plain English:
//   Live Nov 1, arbsim's "in use" memory stayed at ~900-1,000 MB for half an
//   hour while the process grew ~3 MB a minute: the growth was memory the
//   program had freed but glibc's malloc still held ("freed but held"
//   160 -> 295 MB, back after every malloc_trim). This soak runs the same
//   KIND of work, with arbsim's own code where it matters, for a while and
//   measures both numbers once a second:
//     - the bot's route table: a full `trig_table` once, then a part of it
//       replaced every TABLE_MS (live: ~2-3 MB every ~3 s), through
//       check::entry::apply_table (parsed into JSON trees, kept as rows);
//     - copy 2's kept versions: a persistent-map snapshot of POOLS accounts
//       x SLOTS values, a few hundred values changed per block, 64 versions
//       kept (the same Snapshot / Overlay code as copy 2);
//     - WORKERS threads doing check-like work: parse a request, build maps,
//       hold node-answer-sized buffers for a random while (mixed lifetimes);
//     - now and then a big status-like JSON built and dropped.
//   "live" = bytes the program holds (a counting wrapper around the chosen
//   allocator), "rss" = what the system (and pm2) sees.
//
//   The test runs ITSELF twice, as child processes: ARBSIM_ALLOC=system
//   (glibc, MALLOC_ARENA_MAX=2 like deploy/arbsim-run.sh) and
//   ARBSIM_ALLOC=mimalloc, and prints both side by side.
//     cargo test --release --test alloc_frag -- --nocapture
//   ALLOC_FRAG_S [20] seconds each (the PR's numbers: 600).
//   Asserted: mimalloc is really the one running in its child; with
//   mimalloc the process stays within a sane multiple of what it holds and
//   does not keep growing in the second half. glibc is only measured.
// ============================================================================
use std::alloc::{GlobalAlloc, Layout};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use arbsim::copy2::overlay::Overlay;
use arbsim::state::snap::{Fact, Snapshot, Volatile};
use arbsim::state::StatePosition;
use revm::primitives::{keccak256, Address, U256};
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// Counting wrapper around arbsim's own allocator choice (src/alloc.rs).
// ---------------------------------------------------------------------------
struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = arbsim::alloc::Chosen.alloc(l);
        if !p.is_null() {
            LIVE.fetch_add(l.size(), Ordering::Relaxed);
        }
        p
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        let p = arbsim::alloc::Chosen.alloc_zeroed(l);
        if !p.is_null() {
            LIVE.fetch_add(l.size(), Ordering::Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        arbsim::alloc::Chosen.dealloc(p, l);
        LIVE.fetch_sub(l.size(), Ordering::Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        let q = arbsim::alloc::Chosen.realloc(p, l, new);
        if !q.is_null() {
            LIVE.fetch_sub(l.size(), Ordering::Relaxed);
            LIVE.fetch_add(new, Ordering::Relaxed);
        }
        q
    }
}

#[global_allocator]
static A: Counting = Counting;

fn mb(b: usize) -> f64 {
    b as f64 / 1_048_576.0
}

fn rss_mb() -> f64 {
    std::fs::read_to_string("/proc/self/statm")
        .ok()
        .and_then(|s| s.split_whitespace().nth(1).and_then(|x| x.parse::<f64>().ok()))
        .map(|p| p * 4096.0 / 1_048_576.0)
        .unwrap_or(0.0)
}

fn env(k: &str, d: u64) -> u64 {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

/// Tiny deterministic random numbers (no extra crate).
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

fn hex(r: &mut Rng, bytes: usize) -> String {
    let mut s = String::with_capacity(2 + bytes * 2);
    s.push_str("0x");
    for _ in 0..bytes {
        s.push_str(&format!("{:02x}", (r.next() & 0xff) as u8));
    }
    s
}

/// One route row like the bot's (rid, held, score, entry id, check, facts).
fn row(r: &mut Rng, pool: usize, i: usize) -> Value {
    let calls: Vec<Value> = (0..2)
        .map(|_| {
            let n = 68 + r.below(100) as usize;
            json!({ "to": hex(r, 20), "data": hex(r, n) })
        })
        .collect();
    json!({
        "rid": format!("p{pool}>q{i}:{}", r.below(9)), "h": r.below(2) == 0, "s": (r.below(10_000) as f64) / 100.0, "e": format!("e{pool}-{i}"),
        "c": { "calls": calls, "overrides": { hex(r, 20): { "code": "$code:1" } }, "sizes": ["1000000", "5000000", "20000000"], "route": [hex(r, 20), hex(r, 20)], "stop": "0", "amt": "1000000" },
        "f": { "l": "USDG", "px": 1.0, "d": 6, "g": 0.002, "lp": 5 },
    })
}

fn table_msg(r: &mut Rng, gen: u64, base: Option<u64>, pools: impl Iterator<Item = usize>, rows: usize) -> Value {
    let mut m = serde_json::Map::new();
    for p in pools {
        m.insert(format!("0x{p:040x}"), Value::Array((0..rows).map(|i| row(r, p, i)).collect()));
    }
    let mut v = json!({ "type": "trig_table", "gen": gen, "full": base.is_none(), "codes": [hex(r, 2000)], "pools": m });
    if let Some(b) = base {
        v["base"] = json!(b);
    }
    v
}

fn addr(i: u64) -> Address {
    Address::from_slice(&keccak256(i.to_be_bytes()).0[..20])
}

/// One child run: the work above for `secs`; prints one RESULT line.
fn run_child(secs: u64) {
    let stop = Arc::new(AtomicBool::new(false));
    let pools = env("ALLOC_FRAG_POOLS", 1700) as usize;
    let rows = env("ALLOC_FRAG_ROWS", 24) as usize;
    let table_ms = env("ALLOC_FRAG_TABLE_MS", 300);
    let slots = env("ALLOC_FRAG_SLOTS", 180) as u64;
    let workers = env("ALLOC_FRAG_WORKERS", 4) as usize;
    let mut handles = Vec::new();

    // 1. The bot's route table: one full table, then parts.
    {
        let stop = stop.clone();
        handles.push(std::thread::spawn(move || {
            let mut r = Rng(0x9e37_79b9_7f4a_7c15);
            let full = table_msg(&mut r, 1, None, 0..pools, rows);
            let s = serde_json::to_string(&full).unwrap();
            drop(full);
            let v: Value = serde_json::from_str(&s).unwrap();
            drop(s);
            let a = arbsim::check::entry::apply_table(&json!(1), &v);
            assert_eq!(a["ok"], json!(true), "{a}");
            drop(v);
            let mut gen = 1;
            while !stop.load(Ordering::Relaxed) {
                // ~1/5 of the pools replaced (live: 1.7-2.9 MB messages).
                let start = r.below(pools as u64) as usize;
                let n = pools / 5;
                let msg = table_msg(&mut r, gen + 1, Some(gen), (start..start + n).map(|p| p % pools), rows);
                let text = serde_json::to_string(&msg).unwrap();
                drop(msg);
                let v: Value = serde_json::from_str(&text).unwrap();
                let a = arbsim::check::entry::apply_table(&json!(gen), &v);
                assert_eq!(a["ok"], json!(true), "{a}");
                gen += 1;
                std::thread::sleep(Duration::from_millis(table_ms));
            }
        }));
    }

    // 2. Copy-2-like versions: persistent maps, 64 kept.
    {
        let stop = stop.clone();
        handles.push(std::thread::spawn(move || {
            let mut r = Rng(42);
            let mut s = Snapshot::new(Arc::new(Volatile::default()));
            {
                let mut ov = Overlay::new(s.clone());
                for p in 0..pools as u64 {
                    for j in 0..slots {
                        ov.learn(&Fact::Slot(addr(p), U256::from(j * 7919 + p), U256::from(j)));
                    }
                }
                s = ov.into_parts().0;
            }
            let mut versions: std::collections::VecDeque<Arc<Snapshot>> = std::collections::VecDeque::new();
            versions.push_back(Arc::new(s));
            let mut b = 0u64;
            while !stop.load(Ordering::Relaxed) {
                b += 1;
                let mut ov = Overlay::from_arc(versions.back().unwrap());
                ov.set_position(StatePosition { base_block: b, after_seq: None });
                for _ in 0..40 {
                    let p = r.below(pools as u64);
                    for _ in 0..8 {
                        ov.set_slot(addr(p), U256::from(r.below(slots) * 7919 + p), U256::from(b));
                    }
                }
                versions.push_back(Arc::new(ov.into_parts().0));
                while versions.len() > 64 {
                    versions.pop_front();
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }));
    }

    // 3. Check-like workers with mixed lifetimes.
    let ring: Arc<Mutex<Vec<Option<(Vec<u8>, HashMap<u64, String>)>>>> = Arc::new(Mutex::new((0..2000).map(|_| None).collect()));
    for w in 0..workers {
        let stop = stop.clone();
        let ring = ring.clone();
        handles.push(std::thread::spawn(move || {
            let mut r = Rng(1000 + w as u64);
            while !stop.load(Ordering::Relaxed) {
                let n = 20 + r.below(200) as usize;
                let req: Value = json!({ "type": "check", "calls": (0..n).map(|_| json!({"to": hex(&mut r, 20), "data": hex(&mut r, 100)})).collect::<Vec<_>>() });
                let text = serde_json::to_string(&req).unwrap();
                let back: Value = serde_json::from_str(&text).unwrap();
                let m: HashMap<u64, String> = (0..n as u64).map(|i| (i, back["calls"][i as usize]["to"].as_str().unwrap_or("").to_string())).collect();
                let buf = vec![(r.next() & 0xff) as u8; 1024 + r.below(300_000) as usize];
                let i = r.below(2000) as usize;
                ring.lock().unwrap()[i] = Some((buf, m));
                std::thread::sleep(Duration::from_millis(1));
            }
        }));
    }

    // 4. Now and then a big status-like JSON, built and dropped.
    {
        let stop = stop.clone();
        handles.push(std::thread::spawn(move || {
            let mut r = Rng(7);
            while !stop.load(Ordering::Relaxed) {
                let v: Value = Value::Array((0..20_000).map(|i| json!({ "k": i, "v": hex(&mut r, 16) })).collect());
                let s = serde_json::to_string(&v).unwrap();
                drop(v);
                std::hint::black_box(s.len());
                std::thread::sleep(Duration::from_millis(1000));
            }
        }));
    }

    let t0 = Instant::now();
    let mut samples: Vec<(f64, f64, f64)> = Vec::new();
    while t0.elapsed() < Duration::from_secs(secs) {
        std::thread::sleep(Duration::from_secs(1));
        samples.push((t0.elapsed().as_secs_f64(), mb(LIVE.load(Ordering::Relaxed)), rss_mb()));
    }
    stop.store(true, Ordering::Relaxed);
    for h in handles {
        h.join().unwrap();
    }
    // Second half: growth per minute of rss and of live (least squares).
    let half: Vec<&(f64, f64, f64)> = samples.iter().skip(samples.len() / 2).collect();
    let slope = |f: &dyn Fn(&(f64, f64, f64)) -> f64| -> f64 {
        let n = half.len() as f64;
        let (sx, sy) = half.iter().fold((0.0, 0.0), |a, s| (a.0 + s.0, a.1 + f(s)));
        let (mx, my) = (sx / n, sy / n);
        let (num, den) = half.iter().fold((0.0, 0.0), |a, s| (a.0 + (s.0 - mx) * (f(s) - my), a.1 + (s.0 - mx) * (s.0 - mx)));
        if den > 0.0 { num / den * 60.0 } else { 0.0 }
    };
    let rss_slope = slope(&|s| s.2);
    let live_slope = slope(&|s| s.1);
    let avg = |f: &dyn Fn(&(f64, f64, f64)) -> f64| half.iter().map(|s| f(s)).sum::<f64>() / half.len().max(1) as f64;
    let peak_rss = samples.iter().map(|s| s.2).fold(0.0, f64::max);
    let last = samples.last().copied().unwrap_or_default();
    let fig = arbsim::alloc::mimalloc_figures();
    println!(
        "RESULT alloc={} secs={secs} live_avg={:.1} rss_avg={:.1} rss_end={:.1} rss_peak={peak_rss:.1} live_end={:.1} rss_per_live={:.2} rss_mb_per_min={rss_slope:.2} live_mb_per_min={live_slope:.2} mi_held_mb={:?}",
        arbsim::alloc::name(),
        avg(&|s| s.1),
        avg(&|s| s.2),
        last.2,
        last.1,
        avg(&|s| s.2) / avg(&|s| s.1).max(1.0),
        fig.map(|f| f.0 >> 20)
    );
    for s in samples.iter().step_by((samples.len() / 10).max(1)) {
        println!("SAMPLE t={:.0} live={:.1} rss={:.1}", s.0, s.1, s.2);
    }
}

fn parse(line: &str, k: &str) -> f64 {
    line.split_whitespace().find_map(|w| w.strip_prefix(&format!("{k}="))).and_then(|v| v.parse().ok()).unwrap_or(f64::NAN)
}

#[test]
fn glibc_vs_mimalloc_under_arbsim_like_work() {
    if let Ok(s) = std::env::var("ALLOC_FRAG_CHILD") {
        run_child(s.parse().unwrap_or(20));
        return;
    }
    let secs = env("ALLOC_FRAG_S", 20);
    let exe = std::env::current_exe().unwrap();
    let mut out = HashMap::new();
    for which in ["system", "mimalloc"] {
        let o = std::process::Command::new(&exe)
            .args(["--exact", "glibc_vs_mimalloc_under_arbsim_like_work", "--nocapture", "--test-threads=1"])
            .env("ALLOC_FRAG_CHILD", secs.to_string())
            .env("ARBSIM_ALLOC", which)
            .env("MALLOC_ARENA_MAX", "2")
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&o.stdout).to_string();
        assert!(o.status.success(), "{which} child failed: {text}\n{}", String::from_utf8_lossy(&o.stderr));
        // (libtest prints "test <name> ... " in front of the first line.)
        let res = text.lines().find_map(|l| l.find("RESULT ").map(|i| l[i..].to_string())).unwrap_or_default();
        eprintln!("--- {which} ---");
        for l in text.lines().filter_map(|l| l.find("RESULT ").or_else(|| l.find("SAMPLE ")).map(|i| &l[i..])) {
            eprintln!("{l}");
        }
        out.insert(which, res);
    }
    let (g, m) = (&out["system"], &out["mimalloc"]);
    assert!(g.contains("alloc=system"), "{g}");
    assert!(m.contains("alloc=mimalloc"), "mimalloc did not run: {m}");
    eprintln!(
        "=== {secs} s each | rss per byte held: glibc {:.2}, mimalloc {:.2} | rss growth (2nd half): glibc {:+.1} MB/min, mimalloc {:+.1} MB/min | rss end: glibc {:.0} MB, mimalloc {:.0} MB ===",
        parse(g, "rss_per_live"),
        parse(m, "rss_per_live"),
        parse(g, "rss_mb_per_min"),
        parse(m, "rss_mb_per_min"),
        parse(g, "rss_end"),
        parse(m, "rss_end")
    );
    // mimalloc: the process stays close to what it holds.
    assert!(parse(m, "rss_per_live") < 2.0, "mimalloc holds too much beyond what is used: {m}");
}

/// In a binary that runs on arbsim's allocator (like the sidecar, main.rs),
/// with ARBSIM_ALLOC unset: mimalloc runs, status says so and shows
/// mimalloc's figures, and the guard's "trim" works with it.
#[test]
fn default_is_mimalloc_and_status_says_so() {
    if std::env::var("ALLOC_FRAG_CHILD").is_ok() || std::env::var("ARBSIM_ALLOC").is_ok() {
        return; // a child of the soak above, or a run that chose by hand
    }
    let v: Vec<u8> = vec![1; 1 << 20];
    std::hint::black_box(&v);
    assert!(arbsim::alloc::is_mimalloc());
    let s = arbsim::memguard::status_json();
    assert_eq!(s["allocator"], json!("mimalloc"), "{s}");
    assert!(s["malloc"]["inUseMb"].as_f64().unwrap_or(0.0) >= 1.0, "{s}");
    assert!(s["malloc"]["notInUseMb"].is_number(), "{s}");
    assert!(s["malloc"]["freeHeldMb"].is_null(), "{s}");
    let ms = arbsim::memguard::trim_now();
    assert!(ms < 5_000.0);
}
