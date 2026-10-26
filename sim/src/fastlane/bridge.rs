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
use std::io::Write;
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
    /// The newest fastlane-sends.jsonl record time ("t") Node has picked up
    /// and now counts in pending_usd. Rust keeps holding its own sends newer
    /// than this against the loss caps, so nothing is counted 0 or 2 times.
    pub followed_ms: u64,
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

/// Reads data/fastlane-state.json when it changes.
pub struct StateReader {
    pub path: PathBuf,
    pub max_age_ms: u64,
    last_look: Option<Instant>,
    last_mtime: Option<SystemTime>,
    last_len: u64,
    state: Option<SharedState>,
    problem: Option<StateProblem>,
}

impl StateReader {
    pub fn new(path: impl Into<PathBuf>, max_age_ms: u64) -> StateReader {
        StateReader { path: path.into(), max_age_ms, last_look: None, last_mtime: None, last_len: 0, state: None, problem: Some(StateProblem::Missing) }
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
        if self.state.is_some() && mtime.is_some() && mtime == self.last_mtime && meta.len() == self.last_len {
            return; // unchanged
        }
        match fs::read(&self.path).map_err(|e| e.to_string()).and_then(|b| serde_json::from_slice::<NodeState>(&b).map_err(|e| e.to_string())) {
            Ok(raw) => {
                self.state = Some(SharedState::from_raw(raw));
                self.last_mtime = mtime;
                self.last_len = meta.len();
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
    /// When written (ms since 1970).
    pub t: u64,
    /// "live" or "practice".
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
    pub total_us: u64,
}

/// Appends send records, one line per call, rotating at max_bytes.
pub struct SendsLog {
    pub path: PathBuf,
    pub max_bytes: u64,
}

impl SendsLog {
    pub fn new(path: impl Into<PathBuf>, max_bytes: u64) -> SendsLog {
        SendsLog { path: path.into(), max_bytes }
    }

    pub fn from_lookup(get: &dyn Fn(&str) -> Option<String>) -> SendsLog {
        let path = get("FASTLANE_SENDS_FILE").filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "data/fastlane-sends.jsonl".into());
        let max = env_num(get, "FASTLANE_SENDS_MAX_BYTES", 2_000_000.0);
        let max = if max.is_finite() && max >= 10_000.0 { max as u64 } else { 2_000_000 };
        SendsLog::new(path, max)
    }

    fn rotated(p: &Path) -> PathBuf {
        let mut s = p.as_os_str().to_owned();
        s.push(".1");
        PathBuf::from(s)
    }

    /// Write one record. Err = the line was not written (trading goes on).
    pub fn append(&self, rec: &SendRecord) -> Result<(), String> {
        let mut line = serde_json::to_vec(rec).map_err(|e| e.to_string())?;
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
        f.write_all(&line).map_err(|e| e.to_string())
    }
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
        assert_eq!(back, rec);
        assert!(lines[0].contains("\"amountIn\":\"1000\"") && lines[0].contains("\"totalUs\":12000"), "camelCase for Node");
        // Grow past the cap: the next append rotates.
        let big = SendRecord { label: "x".repeat(11_000), ..rec.clone() };
        log.append(&big).unwrap();
        log.append(&rec).unwrap();
        assert!(d.join("sends.jsonl.1").exists());
        assert_eq!(fs::read_to_string(d.join("sends.jsonl")).unwrap().lines().count(), 1);
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
