// ============================================================================
// ENGINE QUOTES (speed step 2): price swaps from the dex bot's in-memory
// chain copy instead of asking the node every time.
//
// Plain English:
//   The dex bot already has a Rust program (`arbsim serve`, sim/ crate) that
//   keeps a full copy of Robinhood Chain in memory, updated from the
//   sequencer feed, and answers "what would this contract call return right
//   now?" over a local Unix socket in about a millisecond. A node round trip
//   takes tens to hundreds of milliseconds.
//
//   We run a SECOND, separate copy of that program just for the sniper (own
//   socket, own settings, no trading of any kind) and:
//     1. FEED FORWARDER: two background threads. One reads every frame from
//        the sequencer feed relay (SNIPER_RHC_FEED), the other hands it to
//        the engine socket as {"type":"feed","frame":...}. The queue between
//        them is bounded: if the engine is slow or down, frames are DROPPED
//        and counted (the engine repairs small gaps itself, big gaps make it
//        restart its copy). Nothing here ever waits on the trading loop or
//        makes it wait.
//     2. ENGINE QUOTER: the same quote calls the node gets (QuoterV2 for V3,
//        V4Quoter for V4, getReserves for V2; see paper.rs quote_via) sent
//        as a {"type":"call"} question. If the engine says "unknown" (not
//        ready yet, missing data it is still fetching, copy dirty or stale),
//        does not answer within SNIPER_ENGINE_TIMEOUT_MS, reverts, or is not
//        running at all, we ask the node instead, exactly as before. Every
//        engine answer and every fallback (with its reason) is counted.
//     3. CHECK MODE (SNIPER_ENGINE_CHECK=1): every quote is asked of BOTH,
//        side by side, and written to engine_check.jsonl (amounts, times,
//        which block the engine priced at). Trading then uses the NODE's
//        answer, so paper results stay comparable with earlier runs while we
//        learn whether the engine can be trusted. When the two differ, the
//        node is asked once more at the engine's exact block, to tell "the
//        engine was simply newer" apart from "the engine was wrong".
//
// Wire format (sim/src/proto.rs): every message is a 4-byte big-endian
// length then UTF-8 JSON. Questions carry an "id"; answers echo it.
//
// Settings (all off unless SNIPER_ENGINE=1; unset = sniper behaves exactly
// as before, no socket is ever opened):
//   SNIPER_ENGINE=1             use the engine for quotes
//   SNIPER_ENGINE_SOCKET        engine socket (default /tmp/sniper-arbsim.sock;
//                               the dex bot's /tmp/arbsim.sock is refused)
//   SNIPER_ENGINE_TIMEOUT_MS    longest wait for one engine answer (50)
//   SNIPER_ENGINE_AT            "head" (newest replayed block, may wait up to
//                               the engine's ARBSIM_WAIT_MS for one that just
//                               arrived; default) or "headNow" (never waits)
//   SNIPER_ENGINE_CHECK=1       side-by-side check mode (see 3.)
//   SNIPER_ENGINE_FORWARD=0     don't forward feed frames (someone else feeds
//                               the engine); default 1
//   SNIPER_ENGINE_QUEUE         feed frames held while the engine is slow (512)
//   SNIPER_RHC_FEED             feed relay to forward from (same as feed-watch)
//
// Read-only: no keys, never sends a transaction.
// ============================================================================
use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io::{BufWriter, Read, Write};
// The engine talks over a Unix socket (Linux server). The Windows desktop
// copy has no Unix sockets: there UnixStream is a stand-in whose connect
// always fails, so the engine simply counts as "down" and every quote goes
// to the node, exactly as with SNIPER_ENGINE unset.
#[cfg(unix)]
pub use std::os::unix::net::UnixStream;
#[cfg(not(unix))]
pub use nounix::UnixStream;

#[cfg(not(unix))]
mod nounix {
    use std::io;
    use std::time::Duration;
    /// Never exists (connect always fails), so no method below can run.
    pub struct UnixStream(std::convert::Infallible);
    impl UnixStream {
        pub fn connect<P: AsRef<std::path::Path>>(_p: P) -> io::Result<UnixStream> {
            Err(io::Error::new(io::ErrorKind::Unsupported, "no Unix sockets on this system"))
        }
        pub fn set_read_timeout(&self, _d: Option<Duration>) -> io::Result<()> {
            match self.0 {}
        }
        pub fn set_write_timeout(&self, _d: Option<Duration>) -> io::Result<()> {
            match self.0 {}
        }
    }
    impl io::Read for UnixStream {
        fn read(&mut self, _b: &mut [u8]) -> io::Result<usize> {
            match self.0 {}
        }
    }
    impl io::Write for UnixStream {
        fn write(&mut self, _b: &[u8]) -> io::Result<usize> {
            match self.0 {}
        }
        fn flush(&mut self) -> io::Result<()> {
            match self.0 {}
        }
    }
}
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ruint::aliases::U256;
use serde_json::{json, Value};

use crate::paper::{quote_via, ChainQuoter, Quoter};
use crate::venue::Venue;

/// The dex bot's own engine socket: never ours (its setup stays untouched).
pub const DEX_BOT_SOCKET: &str = "/tmp/arbsim.sock";
/// Our engine's socket unless SNIPER_ENGINE_SOCKET says otherwise.
pub const DEFAULT_SOCKET: &str = "/tmp/sniper-arbsim.sock";
/// The side-by-side check file (in the run folder).
pub const CHECK_FILE: &str = "engine_check.jsonl";
/// Biggest answer we accept (an engine call answer is a few hundred bytes).
const MAX_ANSWER: usize = 1024 * 1024;
/// Idle engine connections kept for reuse (one per parallel quote).
const POOL_MAX: usize = 8;
/// After the engine socket refuses a connection, skip it this long
/// (straight to the node, no syscall per quote while it is down).
const DOWN_PAUSE: Duration = Duration::from_secs(1);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct EngineConfig {
    pub on: bool,
    pub socket: String,
    pub timeout: Duration,
    /// "head" or "headNow" (sim/src/proto.rs `at.after`).
    pub at: &'static str,
    pub check: bool,
    pub forward: bool,
    pub queue: usize,
    pub feed: String,
}

impl EngineConfig {
    /// Read the settings. Returns the config and a warning to print, if any.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> (Self, Option<String>) {
        let flag = |k: &str, d: bool| match get(k).as_deref().map(str::trim) {
            Some("1") | Some("on") | Some("true") => true,
            Some("0") | Some("off") | Some("false") => false,
            _ => d,
        };
        let num = |k: &str, d: u64| get(k).and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(d);
        let socket = get("SNIPER_ENGINE_SOCKET").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| DEFAULT_SOCKET.into());
        let mut cfg = EngineConfig {
            on: flag("SNIPER_ENGINE", false),
            socket,
            timeout: Duration::from_millis(num("SNIPER_ENGINE_TIMEOUT_MS", 50).clamp(1, 5_000)),
            at: if get("SNIPER_ENGINE_AT").as_deref().map(str::trim) == Some("headNow") { "headNow" } else { "head" },
            check: flag("SNIPER_ENGINE_CHECK", false),
            forward: flag("SNIPER_ENGINE_FORWARD", true),
            queue: num("SNIPER_ENGINE_QUEUE", 512).clamp(8, 100_000) as usize,
            feed: get("SNIPER_RHC_FEED").unwrap_or_else(|| crate::rhc::DEFAULT_FEED.into()),
        };
        let mut warn = None;
        // Safety: never talk to (or feed) the dex bot's own engine.
        if cfg.on && Path::new(&cfg.socket) == Path::new(DEX_BOT_SOCKET) {
            cfg.on = false;
            warn = Some(format!("SNIPER_ENGINE_SOCKET={DEX_BOT_SOCKET} is the dex bot's engine; engine quotes turned OFF (use {DEFAULT_SOCKET})"));
        }
        (cfg, warn)
    }

    pub fn from_env() -> (Self, Option<String>) {
        Self::from_lookup(|k| std::env::var(k).ok())
    }
}

// ---------------------------------------------------------------------------
// Wire format (sim/src/proto.rs)
// ---------------------------------------------------------------------------

/// Write one message: 4-byte big-endian length, then the bytes.
pub fn write_msg(w: &mut impl Write, body: &[u8]) -> std::io::Result<()> {
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(body);
    w.write_all(&out)?;
    w.flush()
}

/// Read one message. Ok(None) = the other side closed.
pub fn read_msg(r: &mut impl Read) -> std::io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = u32::from_be_bytes(len) as usize;
    if n > MAX_ANSWER {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, format!("answer too large ({n} bytes)")));
    }
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf)?;
    Ok(Some(buf))
}

/// A raw feed frame for the engine's updater (no answer comes back).
pub fn feed_msg(frame: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({"id": 0, "type": "feed", "frame": frame})).unwrap_or_default()
}

/// One eth_call question against the engine's live copy.
pub fn call_msg(id: u64, to: &str, data: &str, at: &str) -> Value {
    json!({"id": id, "type": "call", "at": {"after": at}, "calls": [{"to": to, "data": data}]})
}

/// A sure engine answer: the call's output and where the copy was.
#[derive(Clone, Debug, PartialEq)]
pub struct EngineOk {
    pub output: String,
    /// The block the engine's state was after (same numbering as the node).
    pub block: Option<u64>,
    /// Time the engine itself spent (microseconds), as it reports.
    pub us: Option<u64>,
}

/// Read an engine answer. Err = the short reason we fall back to the node
/// ("not_ready", "miss", "dirty", "stale", "reverted", "bad_answer", ...).
pub fn parse_answer(v: &Value) -> Result<EngineOk, String> {
    if v["ok"] != json!(true) {
        let r = v["unknown"].as_str().unwrap_or("unknown");
        return Err(r.to_string());
    }
    let first = &v["results"][0];
    if first["success"] != json!(true) {
        return Err("reverted".into());
    }
    let output = first["output"].as_str().ok_or("bad_answer")?.to_string();
    let block = v["at"]["block"].as_str().and_then(|b| u64::from_str_radix(b.trim_start_matches("0x"), 16).ok());
    Ok(EngineOk { output, block, us: v["us"].as_u64() })
}

// ---------------------------------------------------------------------------
// Engine client (Sync: the parallel size study asks from several threads)
// ---------------------------------------------------------------------------

pub struct EngineClient {
    path: String,
    timeout: Duration,
    at: &'static str,
    /// Idle connections. Each question takes one (or opens one), so one
    /// connection never has two questions in flight: answers can't mix.
    idle: Mutex<Vec<UnixStream>>,
    next_id: AtomicU64,
    /// Skip the engine until this time (ms since `born`) after a refused connect.
    down_until_ms: AtomicU64,
    born: Instant,
}

impl EngineClient {
    pub fn new(path: &str, timeout: Duration, at: &'static str) -> Self {
        EngineClient { path: path.into(), timeout, at, idle: Mutex::new(Vec::new()), next_id: AtomicU64::new(1), down_until_ms: AtomicU64::new(0), born: Instant::now() }
    }

    fn now_ms(&self) -> u64 {
        self.born.elapsed().as_millis() as u64
    }

    /// One eth_call on the engine. Never waits longer than the timeout.
    pub fn eth_call(&self, to: &str, data: &str) -> Result<EngineOk, String> {
        let at = self.at;
        let v = self.ask(&|id| call_msg(id, to, data, at))?;
        parse_answer(&v)
    }

    /// Several eth_calls on ONE exact state `at` (sim/src/proto.rs `at`,
    /// e.g. {"afterTx":"0x.."} or {"afterSeq":N}). Feed wake-up uses it to
    /// read pool prices right before and right after one feed transaction.
    /// Ok = each call's output (None = that call reverted) and the block.
    pub fn call_at(&self, at: &Value, calls: &[(String, String)]) -> Result<(Vec<Option<String>>, Option<u64>), String> {
        let list: Vec<Value> = calls.iter().map(|(to, data)| json!({"to": to, "data": data})).collect();
        let v = self.ask(&|id| json!({"id": id, "type": "call", "at": at, "calls": list}))?;
        parse_many(&v, calls.len())
    }

    /// Send one question built by `build(id)` and wait (bounded) for its answer.
    fn ask(&self, build: &dyn Fn(u64) -> Value) -> Result<Value, String> {
        if self.now_ms() < self.down_until_ms.load(Ordering::Relaxed) {
            return Err("down".into());
        }
        let deadline = Instant::now() + self.timeout;
        let reused = self.idle.lock().map(|mut p| p.pop()).unwrap_or(None);
        let mut s = match reused {
            Some(s) => s,
            None => match UnixStream::connect(&self.path) {
                Ok(s) => s,
                Err(_) => {
                    self.down_until_ms.store(self.now_ms() + DOWN_PAUSE.as_millis() as u64, Ordering::Relaxed);
                    return Err("down".into());
                }
            },
        };
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let body = serde_json::to_vec(&build(id)).map_err(|_| "bad_request".to_string())?;
        let _ = s.set_write_timeout(Some(self.timeout));
        if write_msg(&mut s, &body).is_err() {
            // A reused connection the engine closed (restart): drop it.
            return Err("send_error".into());
        }
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                // Connection dropped: its late answer must never be read as
                // the answer to a later question.
                return Err("timeout".into());
            }
            let _ = s.set_read_timeout(Some(left));
            let msg = match read_msg(&mut s) {
                Ok(Some(m)) => m,
                Ok(None) => return Err("closed".into()),
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => return Err("timeout".into()),
                Err(_) => return Err("read_error".into()),
            };
            let Ok(v) = serde_json::from_slice::<Value>(&msg) else { return Err("bad_answer".into()) };
            if v["id"].as_u64() != Some(id) {
                continue; // not ours (should not happen: one question per connection)
            }
            if let Ok(mut p) = self.idle.lock() {
                if p.len() < POOL_MAX {
                    p.push(s);
                }
            }
            return Ok(v);
        }
    }
}

/// Read a multi-call answer: every call's output (None = reverted) and the
/// block. Err = the engine was not sure (same reasons as `parse_answer`).
pub fn parse_many(v: &Value, n: usize) -> Result<(Vec<Option<String>>, Option<u64>), String> {
    if v["ok"] != json!(true) {
        return Err(v["unknown"].as_str().unwrap_or("unknown").to_string());
    }
    let res = v["results"].as_array().ok_or("bad_answer")?;
    if res.len() != n {
        return Err("bad_answer".into());
    }
    let outs = res.iter().map(|r| if r["success"] == json!(true) { r["output"].as_str().map(str::to_string) } else { None }).collect();
    let block = v["at"]["block"].as_str().and_then(|b| u64::from_str_radix(b.trim_start_matches("0x"), 16).ok());
    Ok((outs, block))
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

/// Engine answers vs node fallbacks, and how long engine answers took.
#[derive(Default)]
pub struct EngineStats {
    pub hits: AtomicU64,
    /// Fallback reason -> count.
    fallbacks: Mutex<BTreeMap<String, u64>>,
    /// Recent engine round-trip times in ms (last 4096, for p50/p95).
    times: Mutex<std::collections::VecDeque<f64>>,
}

impl EngineStats {
    pub fn hit(&self, ms: f64) {
        self.hits.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut t) = self.times.lock() {
            if t.len() >= 4096 {
                t.pop_front();
            }
            t.push_back(ms);
        }
    }
    pub fn fallback(&self, reason: &str) {
        if let Ok(mut f) = self.fallbacks.lock() {
            *f.entry(reason.to_string()).or_default() += 1;
        }
    }
    pub fn fallback_total(&self) -> u64 {
        self.fallbacks.lock().map(|f| f.values().sum()).unwrap_or(0)
    }
    pub fn json(&self) -> Value {
        let t: Vec<f64> = self.times.lock().map(|t| t.iter().copied().collect()).unwrap_or_default();
        let fb = self.fallbacks.lock().map(|f| f.clone()).unwrap_or_default();
        json!({"hits": self.hits.load(Ordering::Relaxed), "fallbacks": fb, "engine_ms_p50": crate::paper::pct(&t, 50.0), "engine_ms_p95": crate::paper::pct(&t, 95.0)})
    }
    /// One status-line piece: "engine 120 hits / 8 node (miss 5, down 3), p50 0.9 ms".
    pub fn summary(&self) -> String {
        let j = self.json();
        let hits = j["hits"].as_u64().unwrap_or(0);
        let fb = self.fallback_total();
        let why: Vec<String> = j["fallbacks"].as_object().map(|m| m.iter().map(|(k, v)| format!("{k} {v}")).collect()).unwrap_or_default();
        let p50 = j["engine_ms_p50"].as_f64().map_or("-".into(), |x| format!("{x:.1}"));
        format!("engine {hits} answered / {fb} to node{} | engine p50 {p50} ms", if why.is_empty() { String::new() } else { format!(" ({})", why.join(", ")) })
    }
}

// ---------------------------------------------------------------------------
// The quoter
// ---------------------------------------------------------------------------

type CheckLog = Arc<Mutex<BufWriter<std::fs::File>>>;

/// A quote the check mode wants re-asked of the node at the engine's block.
struct Recheck {
    id: u64,
    venue: Venue,
    token_in: String,
    token_out: String,
    amount_in: U256,
    block: u64,
    engine_out: U256,
    asked: Instant,
}

/// Prices swaps from the engine, falling back to the node (see the top).
/// With the engine off it IS the old ChainQuoter: every call goes straight
/// to it, nothing else happens.
pub struct EngineQuoter {
    pub chain: ChainQuoter,
    engine: Option<EngineClient>,
    pub stats: EngineStats,
    check: Option<(CheckLog, SyncSender<Recheck>)>,
    check_id: AtomicU64,
}

fn wall_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn write_line(log: &CheckLog, v: &Value) {
    if let Ok(mut f) = log.lock() {
        let _ = serde_json::to_writer(&mut *f, v);
        let _ = f.write_all(b"\n");
        let _ = f.flush();
    }
}

/// Difference in basis points (engine vs node), when both are known.
pub fn diff_bps(engine: U256, node: U256) -> Option<f64> {
    let n = f64::from(node);
    (n > 0.0).then(|| (f64::from(engine) / n - 1.0) * 10_000.0)
}

impl EngineQuoter {
    /// Engine off: exactly the old ChainQuoter.
    pub fn off(chain: ChainQuoter) -> Self {
        EngineQuoter { chain, engine: None, stats: EngineStats::default(), check: None, check_id: AtomicU64::new(1) }
    }

    /// From the settings. `http` = the node (for check-mode re-asks),
    /// `out` = the run folder (engine_check.jsonl goes there).
    pub fn new(chain: ChainQuoter, http: &str, cfg: &EngineConfig, out: &Path) -> Result<Self, String> {
        if !cfg.on {
            return Ok(Self::off(chain));
        }
        let mut q = Self::off(chain);
        q.engine = Some(EngineClient::new(&cfg.socket, cfg.timeout, cfg.at));
        if cfg.check {
            let f = OpenOptions::new().create(true).append(true).open(out.join(CHECK_FILE)).map_err(|e| format!("{CHECK_FILE}: {e}"))?;
            let log: CheckLog = Arc::new(Mutex::new(BufWriter::new(f)));
            let tx = spawn_rechecker(ChainQuoter { rpc: crate::sellcheck::Rpc::new(http) }, log.clone());
            q.check = Some((log, tx));
        }
        Ok(q)
    }

    pub fn engine_on(&self) -> bool {
        self.engine.is_some()
    }

    /// One quote from the engine only (no fallback): result, round trip ms,
    /// and the engine's block.
    pub fn engine_quote(&self, venue: &Venue, token_in: &str, token_out: &str, amount_in: U256) -> (Result<(U256, u64), String>, f64, Option<u64>) {
        let Some(eng) = &self.engine else { return (Err("off".into()), 0.0, None) };
        let block = std::cell::Cell::new(None);
        let t0 = Instant::now();
        let r = quote_via(
            &|to, data| {
                let ok = eng.eth_call(to, data).map_err(|reason| format!("engine:{reason}"))?;
                block.set(ok.block);
                Ok(Some(ok.output))
            },
            venue,
            token_in,
            token_out,
            amount_in,
        );
        (r, t0.elapsed().as_secs_f64() * 1000.0, block.get())
    }

    /// Engine with node fallback (normal mode).
    fn quote_fast(&self, venue: &Venue, token_in: &str, token_out: &str, amount_in: U256) -> Result<(U256, u64), String> {
        match self.engine_quote(venue, token_in, token_out, amount_in) {
            (Ok(v), ms, _) => {
                self.stats.hit(ms);
                Ok(v)
            }
            (Err(e), _, _) => {
                self.stats.fallback(fallback_reason(&e));
                self.chain.quote(venue, token_in, token_out, amount_in)
            }
        }
    }

    /// Check mode: engine and node side by side (in parallel), both logged;
    /// the NODE's answer is used.
    fn quote_checked(&self, venue: &Venue, token_in: &str, token_out: &str, amount_in: U256) -> Result<(U256, u64), String> {
        let ((eng, eng_ms, block), (node, node_ms)) = std::thread::scope(|sc| {
            let e = sc.spawn(|| self.engine_quote(venue, token_in, token_out, amount_in));
            let t0 = Instant::now();
            let n = self.chain.quote(venue, token_in, token_out, amount_in);
            let node_ms = t0.elapsed().as_secs_f64() * 1000.0;
            (e.join().unwrap_or((Err("engine thread".into()), 0.0, None)), (n, node_ms))
        });
        match &eng {
            Ok(_) => self.stats.hit(eng_ms),
            Err(e) => self.stats.fallback(fallback_reason(e)),
        }
        if let Some((log, tx)) = &self.check {
            let id = self.check_id.fetch_add(1, Ordering::Relaxed);
            let e_out = eng.as_ref().ok().map(|v| v.0);
            let n_out = node.as_ref().ok().map(|v| v.0);
            let same = match (e_out, n_out) {
                (Some(a), Some(b)) => Some(a == b),
                _ => None,
            };
            write_line(
                log,
                &json!({
                    "id": id, "wall_ms": wall_ms(), "venue": venue.kind().name(), "in": token_in, "out": token_out, "amount_in": amount_in.to_string(),
                    "engine": e_out.map(|v| v.to_string()), "engine_err": eng.as_ref().err(), "engine_ms": (eng_ms * 1000.0).round() / 1000.0, "engine_block": block,
                    "node": n_out.map(|v| v.to_string()), "node_err": node.as_ref().err(), "node_ms": (node_ms * 1000.0).round() / 1000.0,
                    "match": same, "diff_bps": e_out.zip(n_out).and_then(|(a, b)| diff_bps(a, b)),
                }),
            );
            // Different answers: was the engine just newer, or wrong? Ask the
            // node again at the engine's exact block (background, bounded).
            if let (Some(false), Some(b), Some(eo)) = (same, block, e_out) {
                let _ = tx.try_send(Recheck { id, venue: venue.clone(), token_in: token_in.into(), token_out: token_out.into(), amount_in, block: b, engine_out: eo, asked: Instant::now() });
            }
        }
        node
    }
}

/// "engine:miss" -> "miss"; anything else (a quote-maths error on an
/// engine answer, e.g. "quote: short answer") -> "bad_answer".
pub fn fallback_reason(e: &str) -> &str {
    e.strip_prefix("engine:").unwrap_or("bad_answer")
}

impl Quoter for EngineQuoter {
    fn quote(&self, venue: &Venue, token_in: &str, token_out: &str, amount_in: U256) -> Result<(U256, u64), String> {
        if self.engine.is_none() {
            return self.chain.quote(venue, token_in, token_out, amount_in);
        }
        if self.check.is_some() {
            self.quote_checked(venue, token_in, token_out, amount_in)
        } else {
            self.quote_fast(venue, token_in, token_out, amount_in)
        }
    }
    fn gas_price(&self) -> Result<U256, String> {
        self.chain.gas_price()
    }
}

/// Check mode helper thread: re-asks the node at the engine's exact block,
/// ~1 s later (so the node has that block), and writes "exact_for" lines.
/// The queue holds 64; more mismatches than that are simply not re-asked.
fn spawn_rechecker(node: ChainQuoter, log: CheckLog) -> SyncSender<Recheck> {
    let (tx, rx) = std::sync::mpsc::sync_channel::<Recheck>(64);
    std::thread::Builder::new()
        .name("engine-recheck".into())
        .spawn(move || {
            for r in rx {
                let wait = Duration::from_millis(1000).saturating_sub(r.asked.elapsed());
                std::thread::sleep(wait);
                let at = format!("0x{:x}", r.block);
                let v = match node.quote_at(&r.venue, &r.token_in, &r.token_out, r.amount_in, &at) {
                    Ok((out, _)) => json!({"exact_for": r.id, "block": r.block, "node_at_block": out.to_string(), "match": out == r.engine_out}),
                    Err(e) => json!({"exact_for": r.id, "block": r.block, "error": e}),
                };
                write_line(&log, &v);
            }
        })
        .expect("engine recheck thread");
    tx
}

// ---------------------------------------------------------------------------
// Feed forwarder
// ---------------------------------------------------------------------------

/// Feed forwarder counters (status line and meta.jsonl).
#[derive(Default)]
pub struct FwdStats {
    pub received: AtomicU64,
    pub sent: AtomicU64,
    pub dropped: AtomicU64,
    pub engine_connects: AtomicU64,
    pub engine_up: AtomicBool,
    pub feed_up: AtomicBool,
    /// Frame copies the feed wake-up tap could not take (its queue was full).
    pub tap_dropped: AtomicU64,
}

impl FwdStats {
    pub fn json(&self) -> Value {
        let g = |a: &AtomicU64| a.load(Ordering::Relaxed);
        json!({"received": g(&self.received), "sent": g(&self.sent), "dropped": g(&self.dropped), "engine_connects": g(&self.engine_connects), "tap_dropped": g(&self.tap_dropped),
               "engine_up": self.engine_up.load(Ordering::Relaxed), "feed_up": self.feed_up.load(Ordering::Relaxed)})
    }
    pub fn summary(&self) -> String {
        let g = |a: &AtomicU64| a.load(Ordering::Relaxed);
        format!(
            "feed->engine {} sent, {} dropped (feed {}, engine {})",
            g(&self.sent),
            g(&self.dropped),
            if self.feed_up.load(Ordering::Relaxed) { "up" } else { "DOWN" },
            if self.engine_up.load(Ordering::Relaxed) { "up" } else { "DOWN" }
        )
    }
}

/// Hand one frame to the sender thread, never waiting: a full queue means
/// the frame is dropped and counted.
pub fn offer(tx: &SyncSender<String>, frame: String, st: &FwdStats) {
    st.received.fetch_add(1, Ordering::Relaxed);
    match tx.try_send(frame) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
            st.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// Sender thread body: frames from `rx` to the engine socket, reconnecting
/// (every 1 s) whenever the engine is not there. A write that takes over
/// 1 s (engine stuck) drops the connection; the queue then fills and new
/// frames are dropped instead of piling up. Returns when `stop` is set or
/// the reader side is gone.
pub fn send_frames(rx: Receiver<String>, socket: &str, st: &FwdStats, stop: &AtomicBool) {
    let mut conn: Option<UnixStream> = None;
    let mut last_try: Option<Instant> = None;
    while !stop.load(Ordering::Relaxed) {
        let frame = match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(f) => f,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        if conn.is_none() && last_try.is_none_or(|t| t.elapsed() >= Duration::from_secs(1)) {
            last_try = Some(Instant::now());
            if let Ok(s) = UnixStream::connect(socket) {
                let _ = s.set_write_timeout(Some(Duration::from_secs(1)));
                st.engine_connects.fetch_add(1, Ordering::Relaxed);
                st.engine_up.store(true, Ordering::Relaxed);
                conn = Some(s);
            }
        }
        let Some(s) = conn.as_mut() else {
            // Engine not reachable: this frame is lost (counted).
            st.dropped.fetch_add(1, Ordering::Relaxed);
            continue;
        };
        if write_msg(s, &feed_msg(&frame)).is_ok() {
            st.sent.fetch_add(1, Ordering::Relaxed);
        } else {
            st.dropped.fetch_add(1, Ordering::Relaxed);
            st.engine_up.store(false, Ordering::Relaxed);
            conn = None;
        }
    }
}

/// Reader thread body: every text frame from the feed relay, untouched, to
/// `offer`. Same reconnect / back-off rules as feed-watch (feedwatch.rs):
/// any HTTP refusal waits 10 minutes (65 if 403) so we never hammer it.
fn read_feed(url: &str, tx: Option<&SyncSender<String>>, tap: Option<&Tap>, st: &FwdStats, stop: &AtomicBool) {
    let mut backoff = Duration::from_secs(1);
    while !stop.load(Ordering::Relaxed) {
        match tungstenite::connect(url) {
            Ok((mut ws, _)) => {
                st.feed_up.store(true, Ordering::Relaxed);
                eprintln!("engine: feed UP");
                backoff = Duration::from_secs(1);
                loop {
                    if stop.load(Ordering::Relaxed) {
                        return;
                    }
                    match ws.read() {
                        Ok(tungstenite::Message::Text(s)) => {
                            let at = Instant::now();
                            // Engine first (it must replay the frame before
                            // feed wake-up can ask about it), then the tap.
                            if let Some(tx) = tx {
                                offer(tx, s.to_string(), st);
                            }
                            if let Some(t) = tap {
                                if t.try_send((at, Arc::from(s.as_str()))).is_err() {
                                    st.tap_dropped.fetch_add(1, Ordering::Relaxed);
                                }
                            }
                        }
                        Ok(tungstenite::Message::Close(_)) => break,
                        Ok(_) => {}
                        Err(e) => {
                            eprintln!("engine: feed DOWN ({e})");
                            break;
                        }
                    }
                }
                st.feed_up.store(false, Ordering::Relaxed);
            }
            Err(e) => {
                let m = e.to_string();
                eprintln!("engine: feed DOWN (connect: {m})");
                if m.contains("HTTP error") || m.contains("429") || m.to_ascii_lowercase().contains("blocked") {
                    let until = Instant::now() + Duration::from_secs(if m.contains("403") { 65 * 60 } else { 600 });
                    while Instant::now() < until && !stop.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_secs(1));
                    }
                    continue;
                }
            }
        }
        std::thread::sleep(backoff);
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

/// Start the forwarder (two background threads). Returns its counters.
pub fn spawn_forwarder(cfg: &EngineConfig, stop: Arc<AtomicBool>) -> Arc<FwdStats> {
    spawn_forwarder_tap(cfg, stop, None)
}

/// A copy of every feed frame for someone else (feed wake-up): when it
/// arrived and the frame text. Never waits: if the tap's queue is full the
/// copy is dropped and counted in `FwdStats::tap_dropped`.
pub type Tap = SyncSender<(Instant, Arc<str>)>;

/// `spawn_forwarder` plus an optional tap. The ONE feed connection serves
/// both the engine and the tap (no second connection to the relay).
pub fn spawn_forwarder_tap(cfg: &EngineConfig, stop: Arc<AtomicBool>, tap: Option<Tap>) -> Arc<FwdStats> {
    let st = Arc::new(FwdStats::default());
    let (tx, rx) = std::sync::mpsc::sync_channel::<String>(cfg.queue);
    {
        let (st, stop, url) = (st.clone(), stop.clone(), cfg.feed.clone());
        std::thread::Builder::new().name("engine-feed-in".into()).spawn(move || read_feed(&url, Some(&tx), tap.as_ref(), &st, &stop)).expect("engine feed reader");
    }
    {
        let (st, socket) = (st.clone(), cfg.socket.clone());
        std::thread::Builder::new().name("engine-feed-out".into()).spawn(move || send_frames(rx, &socket, &st, &stop)).expect("engine feed sender");
    }
    st
}

/// Feed reader for the tap ONLY (SNIPER_ENGINE_FORWARD=0: someone else
/// feeds the engine, but feed wake-up still needs the frames).
pub fn spawn_tap_reader(url: &str, stop: Arc<AtomicBool>, tap: Tap) -> Arc<FwdStats> {
    let st = Arc::new(FwdStats::default());
    let (st2, url) = (st.clone(), url.to_string());
    std::thread::Builder::new().name("feedwake-in".into()).spawn(move || read_feed(&url, None, Some(&tap), &st2, &stop)).expect("feed wake reader");
    st
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/// Report section from engine_check.jsonl (check mode) and the newest
/// "engine" line in meta.jsonl (counts in any mode). Empty if the engine
/// was never on in this run folder.
pub fn report_section(dir: &Path, meta: &[Value]) -> String {
    let lines: Vec<Value> = std::fs::read_to_string(dir.join(CHECK_FILE)).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let last = meta.iter().rev().find(|m| m["event"] == "engine");
    if lines.is_empty() && last.is_none() {
        return String::new();
    }
    let mut t = String::from("engine quotes (speed step 2):\n");
    if let Some(m) = last {
        let s = &m["quotes"];
        let hits = s["hits"].as_u64().unwrap_or(0);
        let fb: u64 = s["fallbacks"].as_object().map(|o| o.values().filter_map(|v| v.as_u64()).sum()).unwrap_or(0);
        let why: Vec<String> = s["fallbacks"].as_object().map(|o| o.iter().map(|(k, v)| format!("{k} {v}")).collect()).unwrap_or_default();
        let total = hits + fb;
        t += &format!(
            "  answered by engine {hits} of {total} ({:.0}%), sent to node {fb}{}\n",
            if total > 0 { 100.0 * hits as f64 / total as f64 } else { 0.0 },
            if why.is_empty() { String::new() } else { format!(" ({})", why.join(", ")) }
        );
        if let Some(f) = m.get("feed").filter(|f| f.is_object()) {
            t += &format!("  feed frames to engine: {} sent, {} dropped\n", f["sent"], f["dropped"]);
        }
    }
    let rows: Vec<&Value> = lines.iter().filter(|l| l.get("amount_in").is_some()).collect();
    if !rows.is_empty() {
        let both: Vec<&&Value> = rows.iter().filter(|r| r["match"].is_boolean()).collect();
        let same = both.iter().filter(|r| r["match"] == json!(true)).count();
        let fb = rows.iter().filter(|r| r["engine"].is_null()).count();
        let ms = |k: &str, ok: &str| -> Vec<f64> { rows.iter().filter(|r| !r[ok].is_null()).filter_map(|r| r[k].as_f64()).collect() };
        let (e_ms, n_ms) = (ms("engine_ms", "engine"), ms("node_ms", "node"));
        let p = |v: &[f64], q: f64| crate::paper::pct(v, q).map_or("-".to_string(), |x| format!("{x:.1}"));
        t += &format!(
            "  side-by-side: {} quotes | both answered {} | same amount {} ({:.1}%) | engine fell back {} ({:.1}%)\n",
            rows.len(),
            both.len(),
            same,
            if both.is_empty() { 0.0 } else { 100.0 * same as f64 / both.len() as f64 },
            fb,
            100.0 * fb as f64 / rows.len() as f64
        );
        t += &format!("  time per quote ms: engine p50 {} p95 {} | node p50 {} p95 {}\n", p(&e_ms, 50.0), p(&e_ms, 95.0), p(&n_ms, 50.0), p(&n_ms, 95.0));
        let bps: Vec<f64> = both.iter().filter(|r| r["match"] == json!(false)).filter_map(|r| r["diff_bps"].as_f64()).map(f64::abs).collect();
        if !bps.is_empty() {
            t += &format!("  when different: median gap {} bps, worst {} bps\n", p(&bps, 50.0), p(&bps, 100.0));
        }
        let ex: Vec<&Value> = lines.iter().filter(|l| l.get("exact_for").is_some()).collect();
        if !ex.is_empty() {
            let ok = ex.iter().filter(|l| l["match"] == json!(true)).count();
            let bad = ex.iter().filter(|l| l["match"] == json!(false)).count();
            t += &format!(
                "  differences re-asked at the engine's block: {} | engine was right (just newer) {} | engine wrong {} | node could not say {}\n",
                ex.len(),
                ok,
                bad,
                ex.len() - ok - bad
            );
        }
    }
    t
}

// Tests use Unix sockets: Linux only.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::sync::atomic::AtomicUsize;

    fn sock(name: &str) -> String {
        std::env::temp_dir().join(format!("sniper-engine-test-{name}-{}.sock", std::process::id())).to_string_lossy().to_string()
    }

    /// A fake engine: answers each call with `answer(request)` after `delay`;
    /// feed messages are counted and not answered (like the real one).
    fn fake_engine(path: &str, delay: Duration, answer: impl Fn(&Value) -> Value + Send + Sync + 'static) -> Arc<AtomicUsize> {
        let _ = std::fs::remove_file(path);
        let l = UnixListener::bind(path).unwrap();
        let feeds = Arc::new(AtomicUsize::new(0));
        let answer = Arc::new(answer);
        let f2 = feeds.clone();
        std::thread::spawn(move || {
            for c in l.incoming() {
                let Ok(mut c) = c else { continue };
                let (answer, feeds) = (answer.clone(), f2.clone());
                std::thread::spawn(move || {
                    while let Ok(Some(m)) = read_msg(&mut c) {
                        let v: Value = serde_json::from_slice(&m).unwrap();
                        if v["type"] == "feed" {
                            feeds.fetch_add(1, Ordering::Relaxed);
                            continue;
                        }
                        std::thread::sleep(delay);
                        let mut a = answer(&v);
                        a["id"] = v["id"].clone();
                        if write_msg(&mut c, &serde_json::to_vec(&a).unwrap()).is_err() {
                            return;
                        }
                    }
                });
            }
        });
        feeds
    }

    /// A V3 QuoterV2 answer: amountOut, sqrtPrice, ticks, gas.
    fn v3_output(out: u64, gas: u64) -> String {
        format!("0x{out:064x}{:064x}{:064x}{gas:064x}", 1, 0)
    }

    fn ok_answer(output: &str, block: u64) -> Value {
        json!({"ok": true, "at": {"after": "head", "block": format!("0x{block:x}"), "seq": block}, "results": [{"success": true, "output": output, "gasUsed": "0x1"}], "us": 40})
    }

    /// A node that must never be asked (closed port): fallback = an error.
    fn dead_node() -> ChainQuoter {
        ChainQuoter { rpc: crate::sellcheck::Rpc::new("http://127.0.0.1:9") }
    }

    fn cfg(path: &str) -> EngineConfig {
        EngineConfig { on: true, socket: path.into(), timeout: Duration::from_millis(50), at: "head", check: false, forward: false, queue: 8, feed: String::new() }
    }

    #[test]
    fn settings_off_by_default_and_refuse_the_dex_bots_socket() {
        let (c, w) = EngineConfig::from_lookup(|_| None);
        assert!(!c.on && w.is_none());
        assert_eq!(c.socket, DEFAULT_SOCKET);
        assert_eq!(c.timeout, Duration::from_millis(50));
        assert_eq!(c.at, "head");
        assert!(c.forward && !c.check);
        let env = |k: &str| match k {
            "SNIPER_ENGINE" => Some("1".to_string()),
            "SNIPER_ENGINE_SOCKET" => Some(DEX_BOT_SOCKET.to_string()),
            _ => None,
        };
        let (c, w) = EngineConfig::from_lookup(env);
        assert!(!c.on, "never the dex bot's engine");
        assert!(w.unwrap().contains("OFF"));
        let env = |k: &str| match k {
            "SNIPER_ENGINE" => Some("1".to_string()),
            "SNIPER_ENGINE_TIMEOUT_MS" => Some("20".to_string()),
            "SNIPER_ENGINE_AT" => Some("headNow".to_string()),
            "SNIPER_ENGINE_CHECK" => Some("1".to_string()),
            _ => None,
        };
        let (c, _) = EngineConfig::from_lookup(env);
        assert!(c.on && c.check);
        assert_eq!((c.timeout, c.at), (Duration::from_millis(20), "headNow"));
    }

    #[test]
    fn message_formats_match_the_engine_protocol() {
        // Length prefix: 4 bytes big-endian, then JSON (sim/src/proto.rs).
        let mut buf = Vec::new();
        write_msg(&mut buf, b"{\"a\":1}").unwrap();
        assert_eq!(&buf[..4], &[0, 0, 0, 7]);
        assert_eq!(read_msg(&mut &buf[..]).unwrap().unwrap(), b"{\"a\":1}");
        assert!(read_msg(&mut &b""[..]).unwrap().is_none());
        // Feed frame goes as text, untouched.
        let f: Value = serde_json::from_slice(&feed_msg("{\"version\":1,\"messages\":[]}")).unwrap();
        assert_eq!(f, json!({"id": 0, "type": "feed", "frame": "{\"version\":1,\"messages\":[]}"}));
        // Call: one call, `at` = after head.
        let c = call_msg(7, "0xq", "0xdata", "head");
        assert_eq!(c, json!({"id": 7, "type": "call", "at": {"after": "head"}, "calls": [{"to": "0xq", "data": "0xdata"}]}));
    }

    #[test]
    fn answers_are_read_strictly() {
        let a = parse_answer(&ok_answer("0xabcd", 0x10)).unwrap();
        assert_eq!((a.output.as_str(), a.block, a.us), ("0xabcd", Some(16), Some(40)));
        assert_eq!(parse_answer(&json!({"ok": false, "unknown": "not_ready"})).unwrap_err(), "not_ready");
        assert_eq!(parse_answer(&json!({"ok": false, "unknown": "miss", "missing": [{"account": "0x1"}]})).unwrap_err(), "miss");
        assert_eq!(parse_answer(&json!({"ok": true, "results": [{"success": false, "output": "0x"}]})).unwrap_err(), "reverted");
        assert_eq!(parse_answer(&json!({"ok": true, "results": []})).unwrap_err(), "reverted");
        assert_eq!(parse_answer(&json!({})).unwrap_err(), "unknown");
    }

    #[test]
    fn engine_answer_is_used_and_counted() {
        let p = sock("hit");
        fake_engine(&p, Duration::ZERO, |_| ok_answer(&v3_output(12345, 90_000), 100));
        let q = EngineQuoter::new(dead_node(), "http://127.0.0.1:9", &cfg(&p), Path::new("/tmp")).unwrap();
        let r = q.quote(&Venue::V3 { fee: 3000 }, "0xa", "0xb", U256::from(10u64)).unwrap();
        assert_eq!(r, (U256::from(12345u64), 90_000));
        // V2 goes through getReserves on the engine too.
        let p2 = sock("v2");
        fake_engine(&p2, Duration::ZERO, |req| {
            assert_eq!(req["calls"][0]["data"], "0x0902f1ac");
            ok_answer(&format!("0x{:064x}{:064x}{:064x}", 1_000_000u64, 2_000_000u64, 0), 5)
        });
        let q2 = EngineQuoter::new(dead_node(), "", &cfg(&p2), Path::new("/tmp")).unwrap();
        let (out, _) = q2.quote(&Venue::V2 { pair: "0xpair".into(), token0: "0xa".into() }, "0xa", "0xb", U256::from(1000u64)).unwrap();
        assert_eq!(out, crate::venue::v2_amount_out(U256::from(1000u64), U256::from(1_000_000u64), U256::from(2_000_000u64)));
        // Several threads at once (the size study): all answered.
        let rungs = crate::paper::price_ladder(&q, &Venue::V3 { fee: 3000 }, "0xa", "0xb", &[(25.0, U256::from(1u64)), (50.0, U256::from(2u64)), (100.0, U256::from(3u64))]);
        assert_eq!(rungs.len(), 3);
        assert_eq!(q.stats.hits.load(Ordering::Relaxed), 1 + 6);
        assert_eq!(q.stats.fallback_total(), 0);
    }

    #[test]
    fn unknown_slow_or_missing_engine_falls_back_to_the_node() {
        // Engine says "miss": node asked (here a dead node, so its error shows).
        let p = sock("miss");
        fake_engine(&p, Duration::ZERO, |_| json!({"ok": false, "unknown": "miss", "missing": []}));
        let q = EngineQuoter::new(dead_node(), "", &cfg(&p), Path::new("/tmp")).unwrap();
        let e = q.quote(&Venue::V3 { fee: 3000 }, "0xa", "0xb", U256::from(1u64)).unwrap_err();
        assert!(e.starts_with("eth_call"), "node error expected, got {e}");
        assert_eq!(q.stats.json()["fallbacks"]["miss"], 1);
        // Engine too slow: timeout, then the node; the late answer is never
        // read as the next question's answer (connection dropped).
        let p = sock("slow");
        fake_engine(&p, Duration::from_millis(150), |_| ok_answer(&v3_output(1, 1), 1));
        let q = EngineQuoter::new(dead_node(), "", &cfg(&p), Path::new("/tmp")).unwrap();
        let t0 = Instant::now();
        assert!(q.quote(&Venue::V3 { fee: 3000 }, "0xa", "0xb", U256::from(1u64)).is_err());
        assert!(t0.elapsed() < Duration::from_millis(140), "waited for the slow engine");
        assert_eq!(q.stats.json()["fallbacks"]["timeout"], 1);
        // No engine at all: "down", and for the next second it is skipped.
        let q = EngineQuoter::new(dead_node(), "", &cfg(&sock("nobody")), Path::new("/tmp")).unwrap();
        assert!(q.quote(&Venue::V3 { fee: 3000 }, "0xa", "0xb", U256::from(1u64)).is_err());
        assert!(q.quote(&Venue::V3 { fee: 3000 }, "0xa", "0xb", U256::from(1u64)).is_err());
        assert_eq!(q.stats.json()["fallbacks"]["down"], 2);
        // A reverted call or a garbled answer: node too.
        let p = sock("rev");
        fake_engine(&p, Duration::ZERO, |_| json!({"ok": true, "results": [{"success": false, "output": "0x"}]}));
        let q = EngineQuoter::new(dead_node(), "", &cfg(&p), Path::new("/tmp")).unwrap();
        assert!(q.quote(&Venue::V3 { fee: 3000 }, "0xa", "0xb", U256::from(1u64)).is_err());
        assert_eq!(q.stats.json()["fallbacks"]["reverted"], 1);
        let p = sock("short");
        fake_engine(&p, Duration::ZERO, |_| ok_answer("0x01", 1));
        let q = EngineQuoter::new(dead_node(), "", &cfg(&p), Path::new("/tmp")).unwrap();
        assert!(q.quote(&Venue::V3 { fee: 3000 }, "0xa", "0xb", U256::from(1u64)).is_err());
        assert_eq!(q.stats.json()["fallbacks"]["bad_answer"], 1);
    }

    #[test]
    fn engine_off_never_opens_a_socket() {
        let p = sock("off");
        let feeds = fake_engine(&p, Duration::ZERO, |_| panic!("asked while off"));
        let mut c = cfg(&p);
        c.on = false;
        let q = EngineQuoter::new(dead_node(), "", &c, Path::new("/tmp")).unwrap();
        assert!(!q.engine_on());
        assert!(q.quote(&Venue::V3 { fee: 3000 }, "0xa", "0xb", U256::from(1u64)).is_err()); // dead node
        assert_eq!(q.stats.hits.load(Ordering::Relaxed) + q.stats.fallback_total(), 0);
        assert_eq!(feeds.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn forwarder_drops_when_full_and_reconnects() {
        let st = FwdStats::default();
        // Full queue: dropped and counted, never waits.
        let (tx, rx) = std::sync::mpsc::sync_channel::<String>(2);
        for i in 0..5 {
            offer(&tx, format!("f{i}"), &st);
        }
        assert_eq!((st.received.load(Ordering::Relaxed), st.dropped.load(Ordering::Relaxed)), (5, 3));
        drop(rx);
        // Sender: no engine yet -> dropped; engine comes up -> sent.
        let p = sock("fwd");
        let _ = std::fs::remove_file(&p);
        let st = Arc::new(FwdStats::default());
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = std::sync::mpsc::sync_channel::<String>(64);
        let h = {
            let (st, stop, p) = (st.clone(), stop.clone(), p.clone());
            std::thread::spawn(move || send_frames(rx, &p, &st, &stop))
        };
        offer(&tx, "early".into(), &st);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(st.dropped.load(Ordering::Relaxed), 1);
        let feeds = fake_engine(&p, Duration::ZERO, |_| json!({}));
        std::thread::sleep(Duration::from_millis(1100)); // reconnect pause
        for i in 0..10 {
            offer(&tx, format!("{{\"n\":{i}}}"), &st);
        }
        let t0 = Instant::now();
        while feeds.load(Ordering::Relaxed) < 10 && t0.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(feeds.load(Ordering::Relaxed), 10);
        assert_eq!(st.sent.load(Ordering::Relaxed), 10);
        assert!(st.engine_up.load(Ordering::Relaxed));
        stop.store(true, Ordering::Relaxed);
        h.join().unwrap();
    }

    #[test]
    fn check_mode_logs_both_and_uses_the_node() {
        // A fake HTTP node answering every eth_call with amountOut 1000.
        let node = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", node.local_addr().unwrap());
        std::thread::spawn(move || {
            for c in node.incoming() {
                let Ok(mut c) = c else { continue };
                let mut buf = [0u8; 8192];
                let _ = c.read(&mut buf);
                let body = json!({"jsonrpc": "2.0", "id": 1, "result": v3_output(1000, 1)}).to_string();
                let _ = write!(c, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            }
        });
        let p = sock("check");
        fake_engine(&p, Duration::ZERO, |_| ok_answer(&v3_output(1001, 1), 0x20));
        let dir = std::env::temp_dir().join(format!("sniper-engine-check-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut c = cfg(&p);
        c.check = true;
        let q = EngineQuoter::new(ChainQuoter { rpc: crate::sellcheck::Rpc::new(&url) }, &url, &c, &dir).unwrap();
        let (out, _) = q.quote(&Venue::V3 { fee: 3000 }, "0xa", "0xb", U256::from(5u64)).unwrap();
        assert_eq!(out, U256::from(1000u64), "check mode trades on the node's answer");
        // The re-ask at the engine's block (node says 1000 again: engine wrong).
        let t0 = Instant::now();
        let text = loop {
            let t = std::fs::read_to_string(dir.join(CHECK_FILE)).unwrap_or_default();
            if t.contains("exact_for") || t0.elapsed() > Duration::from_secs(5) {
                break t;
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let lines: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines[0]["engine"], "1001");
        assert_eq!(lines[0]["node"], "1000");
        assert_eq!(lines[0]["match"], false);
        assert_eq!(lines[0]["engine_block"], 32);
        assert_eq!(lines[1]["exact_for"], lines[0]["id"]);
        assert_eq!(lines[1]["match"], false);
        let r = report_section(&dir, &[]);
        assert!(r.contains("side-by-side: 1 quotes | both answered 1 | same amount 0 (0.0%)"), "{r}");
        assert!(r.contains("engine wrong 1"), "{r}");
    }

    #[test]
    fn report_numbers() {
        let dir = std::env::temp_dir().join(format!("sniper-engine-report-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(report_section(&dir, &[]), "", "engine never on: no section");
        let row = |id: u64, e: Option<&str>, n: &str, ems: f64, nms: f64| {
            let m = e.map(|e| json!(e == n));
            json!({"id": id, "amount_in": "1", "engine": e, "node": n, "engine_ms": ems, "node_ms": nms, "match": m,
                   "diff_bps": e.map(|e| (e.parse::<f64>().unwrap() / n.parse::<f64>().unwrap() - 1.0) * 1e4)})
        };
        let lines = [
            row(1, Some("100"), "100", 1.0, 80.0),
            row(2, Some("100"), "100", 2.0, 90.0),
            row(3, Some("101"), "100", 3.0, 100.0),
            row(4, None, "100", 50.0, 120.0),
            json!({"exact_for": 3, "match": true}),
        ];
        let text: String = lines.iter().map(|l| l.to_string() + "\n").collect();
        std::fs::write(dir.join(CHECK_FILE), text).unwrap();
        let meta = [json!({"event": "engine", "quotes": {"hits": 3, "fallbacks": {"miss": 1}}, "feed": {"sent": 50, "dropped": 2}})];
        let r = report_section(&dir, &meta);
        assert!(r.contains("answered by engine 3 of 4 (75%), sent to node 1 (miss 1)"), "{r}");
        assert!(r.contains("feed frames to engine: 50 sent, 2 dropped"), "{r}");
        assert!(r.contains("4 quotes | both answered 3 | same amount 2 (66.7%) | engine fell back 1 (25.0%)"), "{r}");
        assert!(r.contains("engine p50 2.0 p95 3.0 | node p50 100.0 p95 120.0"), "{r}");
        assert!(r.contains("median gap 100.0 bps"), "{r}");
        assert!(r.contains("engine was right (just newer) 1 | engine wrong 0"), "{r}");
    }
}
