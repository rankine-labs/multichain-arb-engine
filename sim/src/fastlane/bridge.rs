// ============================================================================
// FAST LANE BRIDGE: the two small files Rust and the Node bot share.
//
// Plain English:
//   The Node bot knows things Rust can't work out by itself: how much money
//   was lost today (receipts are tracked in Node), which pool pairs are
//   blocked after a failed trade, which coins are on the allowed list, which
//   pools are cleared for live trading, whether the scoreboard paused a kind
//   of send, how much own money the trade contract holds, and so on.
//
//   1. data/fastlane-state.json  (Node writes, Rust reads)
//      Node rewrites it every ~2 s (temp file + rename, so Rust never reads
//      half a file). Rust re-reads it when it changed (looked at no more
//      than every 200 ms, and never in the middle of a send decision unless
//      due). If the file is MISSING, UNREADABLE or OLDER THAN 10 s
//      (FASTLANE_STATE_MAX_AGE_MS), every send is blocked: we fail closed,
//      because a stale loss figure could let us blow through the loss cap.
//
//   2. data/fastlane-sends.jsonl (Rust writes, Node reads)
//      One JSON line per send (live) or "would send" (practice): hash,
//      label, block, sizes, expected profit, mode, timings. Node follows the
//      file and tracks live hashes exactly like its own sends (receipts,
//      gas, loss cap, pair blocks, Telegram, data/live-trades.jsonl with
//      "src":"rust"). Each line is written with ONE append call, so Node
//      never sees half a line from us. When the file passes
//      FASTLANE_SENDS_MAX_BYTES (2 MB) it is renamed to .1 (replacing the
//      older one) and a fresh file starts, like data/live-trades.jsonl.
//      Every record carries "seq": a number that goes up by one per record
//      and keeps going across rotations AND arbsim restarts (on start we
//      continue after the highest seq found in the file, its .1, or the
//      ackSeq Node last reported). Node tracks where it got to by file
//      identity + byte offset (never by time: many records can share one
//      millisecond) and reports back "ackSeq" = the highest seq it has
//      handled. Rust keeps the gas of its own sends held against the loss
//      caps until Node's ackSeq covers them (safety.rs).
//      ONE WRITER AT A TIME (final review blocker 1): the fast lane thread
//      writes send records and the sender thread writes "reply" lines. A
//      lock covers handing out the seq, the rotation check and the write,
//      so lines always appear in seq order and two writers can never both
//      rotate (or write into a file that is being renamed).
//      Reply lines carry "mode":"reply" (blocker 4), so a Node follower
//      that predates the reply lines can never read one as a failed LIVE
//      send; the current follower ignores them for send tracking.
//
//   3. Kill switch: data/KILL (KILL_FILE) or KILL_SWITCH=on. The file is
//      looked at on EVERY check (one stat call, about a microsecond), so
//      creating it stops Rust sends at the very next check.
//
//   Never prints file contents or anything secret. A disk problem writing
//   the send log never stops a trade (it is reported in the return value).
// ============================================================================
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};

/// How often (at most) the state file is looked at for changes.
pub const STATE_POLL: Duration = Duration::from_millis(200);

/// Read a number setting: missing / empty / junk -> default.
pub(crate) fn env_num(get: &dyn Fn(&str) -> Option<String>, key: &str, dflt: f64) -> f64 {
    match get(key) {
        Some(s) if !s.trim().is_empty() => s.trim().parse::<f64>().unwrap_or(f64::NAN),
        _ => dflt,
    }
}

/// Wall clock in milliseconds since 1970 (what Node's Date.now() gives).
pub fn wall_ms() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

/// The kill switch: KILL_SWITCH=on (read at start) or the kill file exists
/// (looked at every time, no caching).
#[derive(Clone, Debug)]
pub struct KillSwitch {
    pub env_on: bool,
    pub file: PathBuf,
}

impl KillSwitch {
    pub fn from_lookup(get: &dyn Fn(&str) -> Option<String>) -> KillSwitch {
        KillSwitch {
            // Same rule as fastSender.ts killSwitchOn: on / true / 1 / yes.
            env_on: crate::fastlane::mode::parse_on(get("KILL_SWITCH").as_deref()),
            file: PathBuf::from(get("KILL_FILE").filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "data/KILL".into())),
        }
    }
    /// true = stop everything.
    pub fn on(&self) -> bool {
        self.env_on || self.file.exists()
    }
}

// ---------------------------------------------------------------------------
// data/fastlane-state.json (written by src/execution/fastlaneBridge.ts)
// ---------------------------------------------------------------------------

/// One blocked pool pair: [buyPool, sellPool, until (ms), why].
pub type PairBlock = (String, String, u64, String);

/// Limits Node is really using (after .env). Rust uses the STRICTER of
/// these and its own settings, so a mismatch can only block more.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NodeLimits {
    pub max_trade_usd: Option<f64>,
    pub daily_loss_cap_usd: Option<f64>,
    pub max_sends_per_min: Option<f64>,
    pub min_net_usd: Option<f64>,
    pub auto_vet_max_trade_usd: Option<f64>,
    pub loop_max_trade_usd: Option<f64>,
    pub loop_loss_cap_usd: Option<f64>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OwnMoney {
    /// When Node last read the contract's balances (ms, 0 = never).
    pub read_ms: u64,
    /// token (lowercase) -> raw units, as a decimal string.
    pub balances: HashMap<String, String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Paused {
    /// Scoreboard pause for 2-pool standing gaps (path "gap"), or null.
    pub gap: Option<String>,
    /// Scoreboard pause for loops (path "loop"), or null.
    pub r#loop: Option<String>,
}

/// The state file as Node writes it. Every field has a default, and the
/// defaults are the safe ones (empty allowlist = nothing allowed, etc).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NodeState {
    pub v: u32,
    /// When Node wrote it (ms since 1970).
    pub written_ms: u64,
    /// UTC day the loss figures are for ("2026-10-26").
    pub loss_day: String,
    /// Money lost today (gas on failed sends + losses), receipts so far.
    pub loss_usd: f64,
    /// Worst-case gas held for sends still waiting for a receipt.
    pub pending_usd: f64,
    pub limits: NodeLimits,
    /// Bad safety settings Node found (any = block everything).
    pub problems: Vec<String>,
    /// Coins on the allowed list (lowercase).
    pub allowlist: Vec<String>,
    /// Coins that got onto the list by auto-vet (smaller size limit).
    pub auto_vetted: Vec<String>,
    /// The 6 h "pool pair blocked for live" list (failed real check / live trade).
    pub live_blocks: Vec<PairBlock>,
    /// The 30 min "live trade failed on this pair" list (standing gaps / entry).
    pub fail_blocks: Vec<PairBlock>,
    /// Pools cleared for live trading (exchange cleared, not practice-only,
    /// live coin rule). A pool NOT listed is not cleared.
    pub live_pools: Vec<String>,
    pub paused: Paused,
    /// Loop gas lost today (live loops + fire-first loops) and the loop pause.
    pub loop_loss_usd: f64,
    pub loop_paused: bool,
    /// Node's live readiness checks (chain id, executor role, lenders...).
    pub live_ready: bool,
    pub live_problems: Vec<String>,
    /// Flash-loan lenders approved on the contract (FLASH_LENDERS_ROBINHOOD).
    pub approved_lenders: Vec<String>,
    pub own_money: OwnMoney,
    /// Node saw the kill switch on.
    pub killed: bool,
    /// The highest fastlane-sends.jsonl "seq" Node has handled (and so now
    /// counts in pending_usd). Rust keeps holding its own sends with a higher
    /// seq against the loss caps, so nothing is counted 0 or 2 times.
    pub ack_seq: u64,
    /// Node's OWN RUST_SENDER setting. Rust broadcasts only when this is
    /// true too (missing = false = block): the one-sender rule must not rest
    /// on two .env files agreeing.
    pub rust_sender: bool,
    /// How many tracked Rust sends Node has found dropped / never mined
    /// (since Node started; it can go back to 0 on a Node restart). When it
    /// CHANGES, the gun should re-read its nonce from the node.
    pub drops_seen: u64,
    /// The most gas (units) any Rust send has used, as seen in receipts
    /// (0 = none yet). For the gun's gas limit.
    pub max_gas_used: u64,
}

/// The state file, turned into quick lookups.
#[derive(Clone, Debug, Default)]
pub struct SharedState {
    pub raw: NodeState,
    pub allow: HashSet<String>,
    pub auto_vetted: HashSet<String>,
    pub live_pools: HashSet<String>,
    pub lenders: HashSet<String>,
    /// "a>b" (lowercase) -> (until ms, why), both directions.
    pub live_blocks: HashMap<String, (u64, String)>,
    pub fail_blocks: HashMap<String, (u64, String)>,
    pub own: HashMap<String, u128>,
}

pub fn pair_key(a: &str, b: &str) -> String {
    format!("{}>{}", a.to_ascii_lowercase(), b.to_ascii_lowercase())
}

fn blocks_of(v: &[PairBlock]) -> HashMap<String, (u64, String)> {
    let mut m = HashMap::with_capacity(v.len() * 2);
    for (a, b, until, why) in v {
        m.insert(pair_key(a, b), (*until, why.clone()));
        m.insert(pair_key(b, a), (*until, why.clone()));
    }
    m
}

fn lower_set(v: &[String]) -> HashSet<String> {
    v.iter().map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()).collect()
}

impl SharedState {
    pub fn from_raw(raw: NodeState) -> SharedState {
        SharedState {
            allow: lower_set(&raw.allowlist),
            auto_vetted: lower_set(&raw.auto_vetted),
            live_pools: lower_set(&raw.live_pools),
            lenders: lower_set(&raw.approved_lenders),
            live_blocks: blocks_of(&raw.live_blocks),
            fail_blocks: blocks_of(&raw.fail_blocks),
            own: raw.own_money.balances.iter().filter_map(|(k, v)| v.trim().parse::<u128>().ok().map(|n| (k.to_ascii_lowercase(), n))).collect(),
            raw,
        }
    }

    /// Why a pair is blocked right now (either list given), or None.
    pub fn blocked(map: &HashMap<String, (u64, String)>, a: &str, b: &str, now_ms: u64) -> Option<String> {
        map.get(&pair_key(a, b)).filter(|(until, _)| *until > now_ms).map(|(_, w)| w.clone())
    }
}

/// Why the state can't be used right now.
#[derive(Clone, Debug, PartialEq)]
pub enum StateProblem {
    Missing,
    Unreadable(String),
    Stale { age_ms: u64 },
}

impl std::fmt::Display for StateProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StateProblem::Missing => write!(f, "fastlane state file missing (Node not writing it?)"),
            StateProblem::Unreadable(e) => write!(f, "fastlane state file unreadable: {e}"),
            StateProblem::Stale { age_ms } => write!(f, "fastlane state file stale ({} ms old)", age_ms),
        }
    }
}

/// A file's identity (inode on Unix, 0 elsewhere).
fn file_id(m: &fs::Metadata) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        m.ino()
    }
    #[cfg(not(unix))]
    {
        let _ = m;
        0
    }
}

/// Reads data/fastlane-state.json when it changes.
pub struct StateReader {
    pub path: PathBuf,
    pub max_age_ms: u64,
    last_look: Option<Instant>,
    last_mtime: Option<SystemTime>,
    last_len: u64,
    /// File identity (inode on Unix): Node renames a new file into place,
    /// so a new write is seen even with the same size and mtime tick.
    last_id: u64,
    state: Option<SharedState>,
    problem: Option<StateProblem>,
}

impl StateReader {
    pub fn new(path: impl Into<PathBuf>, max_age_ms: u64) -> StateReader {
        StateReader { path: path.into(), max_age_ms, last_look: None, last_mtime: None, last_len: 0, last_id: 0, state: None, problem: Some(StateProblem::Missing) }
    }

    pub fn from_lookup(get: &dyn Fn(&str) -> Option<String>) -> StateReader {
        let path = get("FASTLANE_STATE_FILE").filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "data/fastlane-state.json".into());
        let age = env_num(get, "FASTLANE_STATE_MAX_AGE_MS", 10_000.0);
        // Junk or not above 0 -> the default 10 s (never "no limit").
        let age = if age.is_finite() && age > 0.0 { age as u64 } else { 10_000 };
        StateReader::new(path, age)
    }

    /// Look at the file if STATE_POLL passed since the last look (or `force`),
    /// and re-read it if it changed. Cheap when nothing changed (one stat).
    pub fn refresh(&mut self, now: Instant, force: bool) {
        if !force {
            if let Some(t) = self.last_look {
                if now.saturating_duration_since(t) < STATE_POLL {
                    return;
                }
            }
        }
        self.last_look = Some(now);
        let meta = match fs::metadata(&self.path) {
            Ok(m) => m,
            Err(_) => {
                self.state = None;
                self.last_mtime = None;
                self.problem = Some(StateProblem::Missing);
                return;
            }
        };
        let mtime = meta.modified().ok();
        let id = file_id(&meta);
        if self.state.is_some() && mtime.is_some() && mtime == self.last_mtime && meta.len() == self.last_len && id == self.last_id {
            return; // unchanged
        }
        match fs::read(&self.path).map_err(|e| e.to_string()).and_then(|b| serde_json::from_slice::<NodeState>(&b).map_err(|e| e.to_string())) {
            Ok(raw) => {
                self.state = Some(SharedState::from_raw(raw));
                self.last_mtime = mtime;
                self.last_len = meta.len();
                self.last_id = id;
                self.problem = None;
            }
            Err(e) => {
                // Half-written files can't happen (Node renames into place),
                // so this is a real problem: block until a good file appears.
                self.state = None;
                self.last_mtime = None;
                self.problem = Some(StateProblem::Unreadable(e.chars().take(120).collect()));
            }
        }
    }

    /// The state if it is usable at wall time `now_ms`, else why not.
    pub fn usable(&self, now_ms: u64) -> Result<&SharedState, StateProblem> {
        if let Some(p) = &self.problem {
            return Err(p.clone());
        }
        let s = self.state.as_ref().ok_or(StateProblem::Missing)?;
        let age = now_ms.saturating_sub(s.raw.written_ms);
        // A file "from the future" (clock jump) is treated as fresh only up
        // to the same margin; written_ms 0 (never set) is always stale.
        if s.raw.written_ms == 0 || age > self.max_age_ms || s.raw.written_ms > now_ms + self.max_age_ms {
            return Err(StateProblem::Stale { age_ms: age });
        }
        Ok(s)
    }
}

// ---------------------------------------------------------------------------
// data/fastlane-sends.jsonl (read by src/execution/fastlaneBridge.ts)
// ---------------------------------------------------------------------------

/// One send (live) or "would send" (practice) record.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SendRecord {
    /// Sequence number: +1 per record, never repeats (kept across rotations
    /// and restarts). Set by `SendsLog` (0 here = "give it the next one").
    #[serde(default)]
    pub seq: u64,
    /// When written (ms since 1970). For people and reports only: Node
    /// never uses it to decide what it has already read.
    pub t: u64,
    /// "live", "practice", or "reply" (the sequencer's answer to an
    /// earlier live send; never a send itself).
    pub mode: String,
    /// Transaction hash (live and accepted by the node). Practice: the hash
    /// of the throwaway-key transaction, if the gun gives one (never sent).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
    /// The node refused the send (live only): its message, shortened.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub label: String,
    /// Block the opportunity was found in (the feed message's block).
    pub block: u64,
    pub token_in: String,
    /// Raw amount in, decimal string (too big for a JSON number).
    pub amount_in: String,
    pub size_usd: f64,
    pub expected_net_usd: f64,
    pub gas_usd: f64,
    /// Flash-loan lender, None = own money.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lender: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lender_fee_pips: Option<u32>,
    /// Pools in route order (lowercase).
    pub pools: Vec<String>,
    /// Executor hop kinds in route order (gas model key on the Node side).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub kinds: Vec<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonce: Option<u64>,
    /// Per-step timings in microseconds (e.g. feed_to_view, scan, sign, send).
    #[serde(default)]
    pub timings_us: std::collections::BTreeMap<String, u64>,
    /// Feed message seen -> send call returned (microseconds), the headline number.
    #[serde(default)]
    pub total_us: u64,
    /// (integration) None = a send / would-send record. "reply" = the
    /// sequencer's answer to an earlier live send (`reply_to` = its seq,
    /// `reply_hash` its hash, `status` accepted / refused / unknown /
    /// stale_in_queue / not_written, `error` the node's message).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_hash: Option<String>,
    /// Send status when the record was written (live: "unknown" = handed to
    /// the socket, answer still to come; the reply line follows).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

/// Appends send records, one line per call, rotating at max_bytes, and
/// numbers them (seq) so Node can follow them exactly.
pub struct SendsLog {
    pub path: PathBuf,
    pub max_bytes: u64,
    /// The last seq handed out (the next record gets one more).
    last_seq: AtomicU64,
    /// Blocker 1: held for seq + rotation + write (one writer at a time).
    write_lock: Mutex<()>,
}

/// How much of the end of a sends file is read on start to find the last seq.
const TAIL_BYTES: u64 = 256 * 1024;

impl SendsLog {
    /// Opens the log and continues numbering after the highest seq found in
    /// the file or its rotated .1 (so a restart never reuses a number).
    pub fn new(path: impl Into<PathBuf>, max_bytes: u64) -> SendsLog {
        let path = path.into();
        let last = last_seq_in(&path).max(last_seq_in(&Self::rotated(&path)));
        SendsLog { path, max_bytes, last_seq: AtomicU64::new(last), write_lock: Mutex::new(()) }
    }

    pub fn from_lookup(get: &dyn Fn(&str) -> Option<String>) -> SendsLog {
        let path = get("FASTLANE_SENDS_FILE").filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "data/fastlane-sends.jsonl".into());
        let max = env_num(get, "FASTLANE_SENDS_MAX_BYTES", 2_000_000.0);
        let max = if max.is_finite() && max >= 10_000.0 { max as u64 } else { 2_000_000 };
        let log = SendsLog::new(path, max);
        // If both files are gone, Node may still remember a higher ackSeq:
        // never number below it (else Node's ack would wrongly cover new sends).
        let state = get("FASTLANE_STATE_FILE").filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "data/fastlane-state.json".into());
        if let Ok(b) = fs::read(&state) {
            if let Ok(st) = serde_json::from_slice::<NodeState>(&b) {
                log.seed_at_least(st.ack_seq);
            }
        }
        log
    }

    fn rotated(p: &Path) -> PathBuf {
        let mut s = p.as_os_str().to_owned();
        s.push(".1");
        PathBuf::from(s)
    }

    /// Make sure the next seq handed out is above `n`.
    pub fn seed_at_least(&self, n: u64) {
        self.last_seq.fetch_max(n, Ordering::SeqCst);
    }

    /// The last seq handed out (0 = none yet).
    pub fn last_seq(&self) -> u64 {
        self.last_seq.load(Ordering::SeqCst)
    }

    /// Hand out the next seq (use it for the record AND for
    /// `Safety::record_send`, before or after the send itself).
    pub fn next_seq(&self) -> u64 {
        self.last_seq.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Write one record. A record with seq 0 gets the next seq; the seq used
    /// is returned. Err = the line was not written (trading goes on; the
    /// seq stays used, so Safety simply keeps holding that send's gas).
    /// Prefer `append_new` (seq handed out under the lock, so the file is
    /// always in seq order).
    pub fn append(&self, rec: &SendRecord) -> Result<u64, String> {
        let (seq, r) = self.append_new(rec);
        r.map(|_| seq)
    }

    /// Write one record and return (its seq, written ok?). The seq is
    /// handed out (seq 0) INSIDE the write lock, so lines can't land out of
    /// seq order; it is returned even when the write failed (the seq stays
    /// used: Safety keeps holding that send's gas until Node's ack passes it).
    pub fn append_new(&self, rec: &SendRecord) -> (u64, Result<(), String>) {
        let _g = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let seq = if rec.seq == 0 { self.next_seq() } else { rec.seq };
        if rec.seq != 0 {
            self.seed_at_least(rec.seq);
        }
        (seq, self.write_locked(rec, seq))
    }

    fn write_locked(&self, rec: &SendRecord, seq: u64) -> Result<(), String> {
        let mut line = if rec.seq == seq {
            serde_json::to_vec(rec)
        } else {
            serde_json::to_vec(&SendRecord { seq, ..rec.clone() })
        }
        .map_err(|e| e.to_string())?;
        line.push(b'\n');
        if let Some(dir) = self.path.parent() {
            if !dir.as_os_str().is_empty() {
                fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
        }
        if let Ok(m) = fs::metadata(&self.path) {
            if m.len() > self.max_bytes {
                fs::rename(&self.path, Self::rotated(&self.path)).map_err(|e| e.to_string())?;
            }
        }
        let mut f = OpenOptions::new().create(true).append(true).open(&self.path).map_err(|e| e.to_string())?;
        // One write call for the whole line (O_APPEND): a reader never sees
        // two of our lines mixed, and a partial last line only if the disk
        // is full (the Node reader skips lines that don't parse).
        f.write_all(&line).map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// The highest "seq" in the last TAIL_BYTES of a sends file (0 = none / no file).
fn last_seq_in(p: &Path) -> u64 {
    let Ok(mut f) = fs::File::open(p) else { return 0 };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let from = len.saturating_sub(TAIL_BYTES);
    if f.seek(SeekFrom::Start(from)).is_err() {
        return 0;
    }
    let mut buf = Vec::new();
    if f.take(TAIL_BYTES).read_to_end(&mut buf).is_err() {
        return 0;
    }
    #[derive(Deserialize)]
    struct SeqOnly {
        #[serde(default)]
        seq: u64,
    }
    // Every complete line (the first may be cut by the tail read: it just
    // doesn't parse). The max, not the last, in case of a hand-edited file.
    buf.split(|b| *b == b'\n').filter_map(|l| serde_json::from_slice::<SeqOnly>(l).ok()).map(|r| r.seq).max().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fastlane-bridge-{}-{}-{}", tag, std::process::id(), wall_ms()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_state(p: &Path, st: &NodeState) {
        let tmp = p.with_extension("tmp");
        fs::write(&tmp, serde_json::to_vec(st).unwrap()).unwrap();
        fs::rename(tmp, p).unwrap();
    }

    #[test]
    fn missing_state_fails_closed() {
        let d = tmpdir("missing");
        let mut r = StateReader::new(d.join("state.json"), 10_000);
        r.refresh(Instant::now(), true);
        assert_eq!(r.usable(wall_ms()).unwrap_err(), StateProblem::Missing);
    }

    #[test]
    fn stale_state_fails_closed_and_fresh_passes() {
        let d = tmpdir("stale");
        let p = d.join("state.json");
        let now = wall_ms();
        write_state(&p, &NodeState { v: 1, written_ms: now - 11_000, ..Default::default() });
        let mut r = StateReader::new(&p, 10_000);
        r.refresh(Instant::now(), true);
        assert!(matches!(r.usable(now), Err(StateProblem::Stale { .. })));
        write_state(&p, &NodeState { v: 1, written_ms: now, allowlist: vec!["0xAA".into()], ..Default::default() });
        r.refresh(Instant::now(), true);
        let s = r.usable(now).expect("fresh");
        assert!(s.allow.contains("0xaa"), "lowercased");
        // The same file, 10.5 s later, is stale again.
        assert!(matches!(r.usable(now + 10_500), Err(StateProblem::Stale { .. })));
    }

    #[test]
    fn unreadable_and_deleted_state_fail_closed() {
        let d = tmpdir("junk");
        let p = d.join("state.json");
        fs::write(&p, b"{not json").unwrap();
        let mut r = StateReader::new(&p, 10_000);
        r.refresh(Instant::now(), true);
        assert!(matches!(r.usable(wall_ms()), Err(StateProblem::Unreadable(_))));
        write_state(&p, &NodeState { v: 1, written_ms: wall_ms(), ..Default::default() });
        r.refresh(Instant::now(), true);
        assert!(r.usable(wall_ms()).is_ok());
        fs::remove_file(&p).unwrap();
        r.refresh(Instant::now(), true);
        assert_eq!(r.usable(wall_ms()).unwrap_err(), StateProblem::Missing);
    }

    #[test]
    fn refresh_is_rate_limited() {
        let d = tmpdir("poll");
        let p = d.join("state.json");
        let mut r = StateReader::new(&p, 10_000);
        let t0 = Instant::now();
        r.refresh(t0, false);
        write_state(&p, &NodeState { v: 1, written_ms: wall_ms(), ..Default::default() });
        r.refresh(t0 + Duration::from_millis(50), false);
        assert!(r.usable(wall_ms()).is_err(), "not looked at again within 200 ms");
        r.refresh(t0 + Duration::from_millis(250), false);
        assert!(r.usable(wall_ms()).is_ok());
    }

    #[test]
    fn pair_blocks_both_directions_and_expire() {
        let st = SharedState::from_raw(NodeState { fail_blocks: vec![("0xA".into(), "0xB".into(), 1_000, "failed".into())], ..Default::default() });
        assert!(SharedState::blocked(&st.fail_blocks, "0xa", "0xb", 500).is_some());
        assert!(SharedState::blocked(&st.fail_blocks, "0xB", "0xA", 500).is_some());
        assert!(SharedState::blocked(&st.fail_blocks, "0xa", "0xb", 1_000).is_none(), "expired");
    }

    #[test]
    fn sends_log_appends_and_rotates() {
        let d = tmpdir("sends");
        let log = SendsLog::new(d.join("sends.jsonl"), 10_000);
        let rec = SendRecord { t: 1, mode: "practice".into(), label: "WETH/USDG".into(), amount_in: "1000".into(), pools: vec!["0xa".into(), "0xb".into()], total_us: 12_000, ..Default::default() };
        for _ in 0..3 {
            log.append(&rec).unwrap();
        }
        let body = fs::read_to_string(d.join("sends.jsonl")).unwrap();
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 3);
        let back: SendRecord = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(back, SendRecord { seq: 1, ..rec.clone() }, "first record gets seq 1");
        assert!(lines[0].contains("\"amountIn\":\"1000\"") && lines[0].contains("\"totalUs\":12000"), "camelCase for Node");
        // Grow past the cap: the next append rotates.
        let big = SendRecord { label: "x".repeat(11_000), ..rec.clone() };
        log.append(&big).unwrap();
        log.append(&rec).unwrap();
        assert!(d.join("sends.jsonl.1").exists());
        assert_eq!(fs::read_to_string(d.join("sends.jsonl")).unwrap().lines().count(), 1);
    }

    fn seqs(p: &Path) -> Vec<u64> {
        fs::read_to_string(p).unwrap_or_default().lines().map(|l| serde_json::from_str::<SendRecord>(l).unwrap().seq).collect()
    }

    #[test]
    fn seq_goes_up_by_one_even_in_the_same_ms_and_across_rotation() {
        let d = tmpdir("seq");
        let log = SendsLog::new(d.join("sends.jsonl"), 10_000);
        // Six records with the SAME t (one millisecond): six different seqs.
        let rec = SendRecord { t: 5, mode: "live".into(), label: "x".into(), amount_in: "1".into(), ..Default::default() };
        for i in 1..=6u64 {
            assert_eq!(log.append(&rec).unwrap(), i);
        }
        assert_eq!(seqs(&d.join("sends.jsonl")), vec![1, 2, 3, 4, 5, 6]);
        // Rotation keeps counting.
        log.append(&SendRecord { label: "y".repeat(11_000), ..rec.clone() }).unwrap();
        assert_eq!(log.append(&rec).unwrap(), 8);
        assert_eq!(seqs(&d.join("sends.jsonl")), vec![8]);
        // A seq taken first (to reserve gas before the send) is the one written.
        let n = log.next_seq();
        assert_eq!(n, 9);
        assert_eq!(log.append(&SendRecord { seq: n, ..rec.clone() }).unwrap(), 9);
        assert_eq!(log.append(&rec).unwrap(), 10);
    }

    #[test]
    fn seq_continues_after_a_restart() {
        let d = tmpdir("seqrestart");
        let p = d.join("sends.jsonl");
        let rec = SendRecord { t: 5, mode: "live".into(), label: "x".into(), amount_in: "1".into(), ..Default::default() };
        {
            let log = SendsLog::new(&p, 10_000);
            for _ in 0..3 {
                log.append(&rec).unwrap();
            }
        }
        // Restart: continue after 3.
        assert_eq!(SendsLog::new(&p, 10_000).append(&rec).unwrap(), 4);
        // Restart right after a rotation (new file empty / missing): the .1 file counts.
        fs::rename(&p, d.join("sends.jsonl.1")).unwrap();
        assert_eq!(SendsLog::new(&p, 10_000).append(&rec).unwrap(), 5);
        // Both files gone but Node remembers ackSeq 40: start above it.
        fs::remove_file(&p).unwrap();
        fs::remove_file(d.join("sends.jsonl.1")).unwrap();
        let st = d.join("state.json");
        fs::write(&st, serde_json::to_vec(&NodeState { ack_seq: 40, ..Default::default() }).unwrap()).unwrap();
        let m: HashMap<String, String> = [("FASTLANE_SENDS_FILE", p.to_string_lossy().to_string()), ("FASTLANE_STATE_FILE", st.to_string_lossy().to_string())].into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        let get = |k: &str| m.get(k).cloned();
        assert_eq!(SendsLog::from_lookup(&get).append(&rec).unwrap(), 41);
    }

    /// Blocker 1: two threads writing at once (sends + replies), with
    /// rotation on: every line whole, seqs strictly in file order, each seq
    /// once, nothing lost across the rotation.
    #[test]
    fn concurrent_writers_keep_seq_order_across_rotation() {
        let d = tmpdir("conc");
        let log = std::sync::Arc::new(SendsLog::new(d.join("sends.jsonl"), 20_000));
        let mut hs = Vec::new();
        for w in 0..4u8 {
            let log = log.clone();
            hs.push(std::thread::spawn(move || {
                for i in 0..150u32 {
                    let mode = if w % 2 == 0 { "live" } else { "reply" };
                    let rec = SendRecord { t: 1, mode: mode.into(), label: format!("w{w}-{i}-{}", "x".repeat(60)), amount_in: "1".into(), ..Default::default() };
                    let (_, r) = log.append_new(&rec);
                    r.unwrap();
                }
            }));
        }
        for h in hs {
            h.join().unwrap();
        }
        let mut all = seqs(&d.join("sends.jsonl.1"));
        let cur = seqs(&d.join("sends.jsonl"));
        // Within each file: strictly increasing (file order = seq order).
        assert!(all.windows(2).all(|w| w[0] < w[1]), "rotated file in order");
        assert!(cur.windows(2).all(|w| w[0] < w[1]), "current file in order");
        assert!(all.last().copied().unwrap_or(0) < cur[0], "rotation never reorders");
        all.extend(cur);
        // The newest 600 seqs: the last one is 600 and none repeats.
        assert_eq!(*all.last().unwrap(), 600);
        let mut u = all.clone();
        u.dedup();
        assert_eq!(u.len(), all.len(), "no seq twice");
    }

    #[test]
    fn state_new_fields_parse_and_default_safe() {
        let raw: NodeState = serde_json::from_str(r#"{"v":1,"writtenMs":5,"ackSeq":7,"rustSender":true,"dropsSeen":2,"maxGasUsed":900000}"#).unwrap();
        assert_eq!((raw.ack_seq, raw.rust_sender, raw.drops_seen, raw.max_gas_used), (7, true, 2, 900_000));
        let old: NodeState = serde_json::from_str(r#"{"v":1,"writtenMs":5}"#).unwrap();
        assert!(!old.rust_sender, "missing rustSender = false (blocks broadcasting)");
    }

    #[test]
    fn kill_switch_file_is_seen_immediately() {
        let d = tmpdir("kill");
        let k = KillSwitch { env_on: false, file: d.join("KILL") };
        assert!(!k.on());
        fs::write(d.join("KILL"), b"").unwrap();
        assert!(k.on(), "no caching");
        fs::remove_file(d.join("KILL")).unwrap();
        assert!(!k.on());
        assert!(KillSwitch { env_on: true, file: d.join("nope") }.on());
    }
}
