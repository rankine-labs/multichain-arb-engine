// ============================================================================
// RUSH TAP (Nov 14, sniper project): the predicted copy's swaps, written out.
//
// Plain English:
//   "Seeing ahead" (copy2/ahead.rs) runs each sequencer-feed transaction on
//   its predicted copy with the pools' own code, whatever router or bot
//   contract it goes through. The sniper (a separate program) wants exactly
//   that, for the coins it watches: "this transaction, ~1 s before it is
//   confirmed, moves pool P up from price A to price B".
//
//   With ARBSIM_RUSH_TAP=on, every FIRST prediction of a feed block writes
//   one JSON line per (transaction, tapped pool) it touched:
//     kind "swap"    our run changed the pool's price (before / after given)
//     kind "moved"   our run changed the pool, not its price (liquidity)
//     kind "unsure"  a transaction that may touch the pool, but we could not
//                    run it exactly (no prices; `why` says why)
//   `sure` false = the prediction can't vouch for it (a value it read may be
//   wrong, the pool was already unsure, it assumed a sender's funds, ...).
//
//   Tapped pools (ARBSIM_RUSH_TAP_POOLS / ARBSIM_RUSH_TAP_POOLS_FILE): pool
//   addresses / V4 pool ids, or "all". Only pools copy 2 already FOLLOWS can
//   be predicted (it holds their state); a listed pool it does not follow is
//   shown in status (rushTap.notFollowed) and gets no lines. Supported:
//   Uniswap V3, PancakeSwap V3 (slot0 at slot 0) and Uniswap V4 (slot0 at
//   the pool's base slot in the PoolManager). Other kinds are skipped.
//
//   SAFETY (the live arb bot): OFF unless ARBSIM_RUSH_TAP=on. Off = nothing
//   here runs and the predicted copy behaves exactly as before. On, it only
//   changes one rule of the predicted copy: a transaction naming ONLY
//   tapped pools that no arb route uses is still RUN (FASTLANE_AHEAD_ROUTES_
//   ONLY would skip it), so the sniper's pools are predicted at all. Lines
//   are handed to a writer thread through a bounded queue: never waits
//   (a full queue drops the lines and counts them). Never asks the node.
//
//   Output (ARBSIM_RUSH_TAP_OUT): a file (JSON lines, appended, rotated to
//   <file>.1 past ARBSIM_RUSH_TAP_MAX_MB), or "udp:127.0.0.1:PORT" (one
//   datagram per line, local only; nobody listening costs nothing).
// ============================================================================
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use revm::primitives::{Address, B256, U256};
use serde_json::{json, Value};

use super::PoolKind;
use crate::check::moved::v4_base;

/// Default output file (relative to arbsim's working folder, the app folder).
pub const DEFAULT_OUT: &str = "data/arbsim-rush-tap.jsonl";
/// Default file size before it is rotated to <file>.1.
pub const DEFAULT_MAX_MB: u64 = 256;
/// Most batches waiting for the writer (one batch = one predicted block).
const QUEUE: usize = 1024;
/// Most "listed but not followed" pools shown in status.
const SHOW_MISSING: usize = 20;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// Which pools are tapped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Want {
    /// Every followed pool of a supported kind.
    All,
    /// These keys (pool address / V4 pool id, lowercase 0x hex).
    Keys(HashSet<String>),
}

/// Where the lines go.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Out {
    File(PathBuf),
    Udp(String),
}

/// ARBSIM_RUSH_TAP_* (read once at start).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TapCfg {
    /// ARBSIM_RUSH_TAP_POOLS: comma / space separated keys, or "all".
    pub pools: Want,
    /// ARBSIM_RUSH_TAP_POOLS_FILE: one key per line (# comments), re-read
    /// when it changes (the sniper adds new coins' pools while running).
    pub file: Option<PathBuf>,
    /// ARBSIM_RUSH_TAP_OUT [data/arbsim-rush-tap.jsonl | udp:127.0.0.1:PORT].
    pub out: Out,
    /// ARBSIM_RUSH_TAP_MAX_MB [256]: file rotated to <file>.1 past this.
    pub max_bytes: u64,
}

/// Is a switch value "on"? (on / 1 / true / yes; anything else is off.)
pub fn is_on(v: Option<&str>) -> bool {
    v.is_some_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "on" | "1" | "true" | "yes"))
}

/// One key as the bot names pools: lowercase 0x hex, 20-byte address or
/// 32-byte V4 pool id. None = not a key (ignored).
pub fn norm_key(s: &str) -> Option<String> {
    let s = s.trim().to_ascii_lowercase();
    let h = s.strip_prefix("0x")?;
    if (h.len() == 40 || h.len() == 64) && h.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(s)
    } else {
        None
    }
}

/// Keys out of a list ("0xa, 0xb" or one per line; # starts a comment).
pub fn parse_keys(text: &str) -> HashSet<String> {
    text.lines()
        .map(|l| l.split('#').next().unwrap_or(""))
        .flat_map(|l| l.split([',', ' ', '\t', ';']))
        .filter_map(norm_key)
        .collect()
}

impl TapCfg {
    /// From any key -> value lookup (tests pass a map). None = the tap is
    /// off (ARBSIM_RUSH_TAP not on): nothing of this file runs.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Option<TapCfg> {
        if !is_on(get("ARBSIM_RUSH_TAP").as_deref()) {
            return None;
        }
        let raw = get("ARBSIM_RUSH_TAP_POOLS").unwrap_or_default();
        let pools = if raw.trim().eq_ignore_ascii_case("all") { Want::All } else { Want::Keys(parse_keys(&raw)) };
        let file = get("ARBSIM_RUSH_TAP_POOLS_FILE").map(|f| f.trim().to_string()).filter(|f| !f.is_empty()).map(PathBuf::from);
        let out = match get("ARBSIM_RUSH_TAP_OUT").map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
            Some(v) if v.starts_with("udp:") => Out::Udp(v[4..].to_string()),
            Some(v) => Out::File(PathBuf::from(v)),
            None => Out::File(PathBuf::from(DEFAULT_OUT)),
        };
        let max_mb = get("ARBSIM_RUSH_TAP_MAX_MB").and_then(|v| v.trim().parse::<u64>().ok()).filter(|v| (1..=100_000).contains(v)).unwrap_or(DEFAULT_MAX_MB);
        Some(TapCfg { pools, file, out, max_bytes: max_mb * 1024 * 1024 })
    }
}

// ---------------------------------------------------------------------------
// The tapped pools
// ---------------------------------------------------------------------------

/// One pool copy 2 follows, as the tap needs it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Followed {
    pub key: String,
    pub kind: PoolKind,
    /// Pool contract (V4: the PoolManager).
    pub address: Address,
    pub v4_id: Option<B256>,
    pub token0: Address,
    pub token1: Address,
}

/// One tapped pool.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub key: String,
    pub kind: &'static str,
    /// Where its slot0 (sqrtPriceX96 + tick) is: (contract, slot).
    pub price_at: (Address, U256),
    pub token0: Address,
    pub token1: Address,
}

/// The tapped pools with their lookups (rebuilt when copy 2's pool list or
/// the tap list changes).
#[derive(Clone, Debug, Default)]
pub struct TapSet {
    pub targets: Vec<Target>,
    by_key: HashMap<String, usize>,
    by_slot: HashMap<(Address, U256), usize>,
    /// Listed keys copy 2 does not follow (sorted): no lines for them.
    pub not_followed: Vec<String>,
    /// Listed / followed pools of a kind the tap can't price (sorted).
    pub unsupported: Vec<String>,
}

/// The tap's name of a pool kind, and None for kinds it can't price.
fn kind_name(k: PoolKind) -> Option<&'static str> {
    match k {
        PoolKind::V3 => Some("v3"),
        PoolKind::PancakeV3 => Some("pancakeV3"),
        PoolKind::V4 => Some("v4"),
        _ => None,
    }
}

impl TapSet {
    pub fn build(followed: &[Followed], want: &Want) -> TapSet {
        let mut s = TapSet::default();
        let mut seen: HashSet<&str> = HashSet::new();
        for f in followed {
            let listed = match want {
                Want::All => true,
                Want::Keys(k) => k.contains(&f.key),
            };
            if !listed {
                continue;
            }
            seen.insert(f.key.as_str());
            let Some(kind) = kind_name(f.kind) else {
                if matches!(want, Want::Keys(_)) {
                    s.unsupported.push(f.key.clone());
                }
                continue;
            };
            let price_at = match (f.kind, f.v4_id) {
                (PoolKind::V4, Some(id)) => (f.address, v4_base(id)),
                (PoolKind::V4, None) => continue,
                // Uniswap V3 and PancakeSwap V3: slot0 is storage slot 0.
                _ => (f.address, U256::ZERO),
            };
            let i = s.targets.len();
            s.by_key.insert(f.key.clone(), i);
            s.by_slot.insert(price_at, i);
            s.targets.push(Target { key: f.key.clone(), kind, price_at, token0: f.token0, token1: f.token1 });
        }
        if let Want::Keys(k) = want {
            s.not_followed = k.iter().filter(|x| !seen.contains(x.as_str())).cloned().collect();
            s.not_followed.sort();
        }
        s.unsupported.sort();
        s
    }

    pub fn is_empty(&self) -> bool {
        self.targets.is_empty()
    }

    pub fn has(&self, key: &str) -> bool {
        self.by_key.contains_key(key)
    }

    pub fn target(&self, key: &str) -> Option<&Target> {
        self.by_key.get(key).map(|i| &self.targets[*i])
    }

    /// Tapped pools whose price slot is among these written slots.
    pub fn price_hits(&self, changed: &[(Address, U256)]) -> Vec<usize> {
        let mut v: Vec<usize> = changed.iter().filter_map(|k| self.by_slot.get(k).copied()).collect();
        v.sort_unstable();
        v.dedup();
        v
    }
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

/// What a line says about the pool.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowKind {
    Swap,
    Moved,
    Unsure,
}

impl RowKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RowKind::Swap => "swap",
            RowKind::Moved => "moved",
            RowKind::Unsure => "unsure",
        }
    }
}

/// One (transaction, tapped pool) of a predicted block.
#[derive(Clone, Debug, PartialEq)]
pub struct TapRow {
    pub seq: u64,
    pub block: u64,
    /// The confirmed copy-2 block the prediction was built on.
    pub base_seq: u64,
    /// Position of the transaction in its feed message.
    pub tx_index: u32,
    pub hash: B256,
    /// The transaction's sender (who is buying: the sniper counts buyers).
    pub from: Address,
    pub to: Option<Address>,
    pub row: RowKind,
    /// The prediction's fate word for the transaction (ran / reverted /
    /// failed / offRoute / unknown).
    pub fate: &'static str,
    pub sure: bool,
    pub target: Target,
    /// slot0 word before / after this transaction (None = not held).
    pub before: Option<U256>,
    pub after: Option<U256>,
    pub why: Option<String>,
    /// Microseconds from the feed message reaching arbsim to this line
    /// being handed to the writer.
    pub feed_age_us: u64,
}

/// slot0 word -> (sqrtPriceX96, tick): the low 160 bits and the next 24
/// bits (signed). Same packing for Uniswap V3, PancakeSwap V3 and V4.
pub fn slot0_parts(w: U256) -> (U256, i32) {
    let one = U256::from(1u8);
    let mask160: U256 = (one << 160usize) - one;
    let sqrt = w & mask160;
    let shifted: U256 = (w >> 160usize) & U256::from(0xff_ffffu32);
    let raw = shifted.as_limbs()[0] as u32;
    // Sign-extend 24 bits.
    let tick = ((raw << 8) as i32) >> 8;
    (sqrt, tick)
}

/// A U256 as f64 (enough for price ratios).
pub fn to_f64(v: U256) -> f64 {
    v.as_limbs().iter().enumerate().map(|(i, l)| (*l as f64) * 2f64.powi(64 * i as i32)).sum()
}

/// "buy0" = the price of token0 in token1 went up (token0 was bought),
/// "buy1" = it went down (token1 was bought), "none" = unchanged.
pub fn direction(before: U256, after: U256) -> &'static str {
    match after.cmp(&before) {
        std::cmp::Ordering::Greater => "buy0",
        std::cmp::Ordering::Less => "buy1",
        std::cmp::Ordering::Equal => "none",
    }
}

impl TapRow {
    /// The JSON line (one object, no newline).
    pub fn json(&self, now_ms: u64) -> Value {
        let mut v = json!({
            "t": now_ms,
            "seq": self.seq,
            "block": self.block,
            "baseSeq": self.base_seq,
            "ahead": self.seq.saturating_sub(self.base_seq),
            "txIndex": self.tx_index,
            "tx": format!("{:#x}", self.hash),
            "from": format!("{:#x}", self.from),
            "to": self.to.map(|a| format!("{a:#x}")),
            "row": self.row.as_str(),
            "fate": self.fate,
            "sure": self.sure,
            "pool": self.target.key,
            "poolKind": self.target.kind,
            "token0": format!("{:#x}", self.target.token0),
            "token1": format!("{:#x}", self.target.token1),
            "feedAgeUs": self.feed_age_us,
        });
        if let Some(w) = &self.why {
            v["why"] = json!(w);
        }
        let parts = |w: Option<U256>| w.map(slot0_parts);
        let (b, a) = (parts(self.before), parts(self.after));
        if let Some((s, t)) = b {
            v["sqrtPriceBefore"] = json!(s.to_string());
            v["tickBefore"] = json!(t);
        }
        if let Some((s, t)) = a {
            v["sqrtPriceAfter"] = json!(s.to_string());
            v["tickAfter"] = json!(t);
        }
        if let (Some((sb, _)), Some((sa, _))) = (b, a) {
            v["dir"] = json!(direction(sb, sa));
            // Price = token1 per token0 (raw units) = sqrt^2: the change in %.
            let fb = to_f64(sb);
            if fb > 0.0 {
                let r = to_f64(sa) / fb;
                v["priceChangePct"] = json!(((r * r - 1.0) * 100.0 * 1e6).round() / 1e6);
            }
        }
        v
    }
}

// ---------------------------------------------------------------------------
// In the predicted copy (one per Ahead; None = off)
// ---------------------------------------------------------------------------

/// Counters (status rushTap).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TapCounts {
    pub blocks: u64,
    pub rows: u64,
    pub swaps: u64,
    pub moved: u64,
    pub unsure: u64,
    pub not_sure: u64,
    /// Blocks predicted again on a newer base (not written again).
    pub rebuilt: u64,
    /// Transactions run only because they name a tapped pool (they would
    /// have been "offRoute" without the tap).
    pub off_route_run: u64,
}

/// The tap inside the predicted copy.
#[derive(Default)]
pub struct TapState {
    pub set: Arc<TapSet>,
    /// Lines of predicted blocks, waiting to be taken by the runtime.
    pub out: Vec<TapRow>,
    /// Newest block whose lines were handed out (each block once: its
    /// FIRST successful prediction).
    pub done_to: u64,
    pub counts: TapCounts,
}

impl TapState {
    pub fn new(set: Arc<TapSet>) -> TapState {
        TapState { set, ..TapState::default() }
    }

    /// A block was predicted: keep its lines if it is new.
    pub fn accept(&mut self, seq: u64, rows: Vec<TapRow>, feed_age_us: u64) {
        if seq <= self.done_to {
            if !rows.is_empty() {
                self.counts.rebuilt += 1;
            }
            return;
        }
        self.done_to = seq;
        if rows.is_empty() {
            return;
        }
        self.counts.blocks += 1;
        for mut r in rows {
            self.counts.rows += 1;
            match r.row {
                RowKind::Swap => self.counts.swaps += 1,
                RowKind::Moved => self.counts.moved += 1,
                RowKind::Unsure => self.counts.unsure += 1,
            }
            if !r.sure {
                self.counts.not_sure += 1;
            }
            r.feed_age_us = feed_age_us;
            self.out.push(r);
        }
    }

    pub fn take(&mut self) -> Vec<TapRow> {
        std::mem::take(&mut self.out)
    }

    pub fn status(&self) -> Value {
        let c = &self.counts;
        json!({
            "tapped": self.set.targets.len(),
            "notFollowed": self.set.not_followed.len(),
            "notFollowedSample": self.set.not_followed.iter().take(SHOW_MISSING).collect::<Vec<_>>(),
            "unsupported": self.set.unsupported.len(),
            "blocks": c.blocks, "rows": c.rows, "swaps": c.swaps, "moved": c.moved, "unsure": c.unsure,
            "notSure": c.not_sure, "rebuilt": c.rebuilt, "offRouteRun": c.off_route_run,
        })
    }
}

// ---------------------------------------------------------------------------
// The writer (its own thread; the predicted copy never waits for it)
// ---------------------------------------------------------------------------

/// Writer counters.
#[derive(Default)]
pub struct WriterStats {
    pub written: AtomicU64,
    pub dropped: AtomicU64,
    pub errors: AtomicU64,
    pub bytes: AtomicU64,
}

/// The runtime side: the list file, the queue to the writer.
pub struct TapRuntime {
    pub cfg: TapCfg,
    tx: SyncSender<Vec<TapRow>>,
    pub stats: Arc<WriterStats>,
    /// The list file's last change time and its keys.
    file_seen: Option<SystemTime>,
    file_keys: HashSet<String>,
    file_checked: Option<Instant>,
}

/// Wall clock in ms (the line's "t").
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Where the writer puts lines.
enum Sink {
    File { path: PathBuf, f: std::io::BufWriter<std::fs::File>, size: u64, max: u64 },
    Udp(std::net::UdpSocket, String),
    None,
}

fn open_file(path: &PathBuf) -> std::io::Result<(std::fs::File, u64)> {
    if let Some(d) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(d)?;
    }
    let f = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    Ok((f, size))
}

impl Sink {
    fn open(cfg: &TapCfg) -> Sink {
        match &cfg.out {
            Out::File(p) => match open_file(p) {
                Ok((f, size)) => Sink::File { path: p.clone(), f: std::io::BufWriter::new(f), size, max: cfg.max_bytes },
                Err(e) => {
                    eprintln!("[arbsim] rush tap: can't open {}: {e}; lines are dropped", p.display());
                    Sink::None
                }
            },
            Out::Udp(a) => {
                // Local only: a line must never leave the machine.
                let local = a.starts_with("127.") || a.starts_with("localhost:") || a.starts_with("[::1]");
                if !local {
                    eprintln!("[arbsim] rush tap: udp target {a} is not local (127.x / localhost / [::1]); lines are dropped");
                    return Sink::None;
                }
                match std::net::UdpSocket::bind("127.0.0.1:0") {
                    Ok(s) => {
                        let _ = s.set_nonblocking(true);
                        Sink::Udp(s, a.clone())
                    }
                    Err(e) => {
                        eprintln!("[arbsim] rush tap: udp socket: {e}; lines are dropped");
                        Sink::None
                    }
                }
            }
        }
    }

    /// Write one batch. Returns (lines written, bytes, error?).
    fn write(&mut self, rows: &[TapRow]) -> (u64, u64, bool) {
        let t = now_ms();
        let mut n = 0u64;
        let mut bytes = 0u64;
        let mut err = false;
        match self {
            Sink::File { path, f, size, max } => {
                for r in rows {
                    let mut line = r.json(t).to_string();
                    line.push('\n');
                    if f.write_all(line.as_bytes()).is_err() {
                        err = true;
                        break;
                    }
                    n += 1;
                    bytes += line.len() as u64;
                    *size += line.len() as u64;
                }
                if f.flush().is_err() {
                    err = true;
                }
                // Rotate: <file> -> <file>.1 (the older .1 is replaced).
                if *size >= *max {
                    let mut old = path.clone().into_os_string();
                    old.push(".1");
                    let _ = std::fs::rename(&*path, &old);
                    match open_file(path) {
                        Ok((nf, s)) => {
                            *f = std::io::BufWriter::new(nf);
                            *size = s;
                        }
                        Err(_) => err = true,
                    }
                }
            }
            Sink::Udp(s, to) => {
                for r in rows {
                    let line = r.json(t).to_string();
                    match s.send_to(line.as_bytes(), to.as_str()) {
                        Ok(_) => {
                            n += 1;
                            bytes += line.len() as u64;
                        }
                        // Nobody listening / buffer full: dropped, never waited for.
                        Err(_) => err = true,
                    }
                }
            }
            Sink::None => err = !rows.is_empty(),
        }
        (n, bytes, err)
    }
}

fn writer_loop(cfg: TapCfg, rx: Receiver<Vec<TapRow>>, st: Arc<WriterStats>) {
    let mut sink = Sink::open(&cfg);
    while let Ok(rows) = rx.recv() {
        let (n, b, err) = sink.write(&rows);
        st.written.fetch_add(n, Ordering::Relaxed);
        st.bytes.fetch_add(b, Ordering::Relaxed);
        st.dropped.fetch_add(rows.len() as u64 - n.min(rows.len() as u64), Ordering::Relaxed);
        if err {
            st.errors.fetch_add(1, Ordering::Relaxed);
        }
    }
}

impl TapRuntime {
    /// From the environment. None = off (ARBSIM_RUSH_TAP not on).
    pub fn from_env() -> Option<TapRuntime> {
        TapCfg::from_lookup(|k| std::env::var(k).ok()).and_then(TapRuntime::start)
    }

    /// Start the writer thread. None if it can't start (the tap is then off).
    pub fn start(cfg: TapCfg) -> Option<TapRuntime> {
        let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<TapRow>>(QUEUE);
        let stats = Arc::new(WriterStats::default());
        let (c, s) = (cfg.clone(), stats.clone());
        let ok = std::thread::Builder::new()
            .name("arbsim-rushtap".into())
            .spawn(move || {
                crate::fastlane::mode::lower_this_thread_from_env("arbsim-rushtap");
                writer_loop(c, rx, s)
            })
            .is_ok();
        if !ok {
            eprintln!("[arbsim] rush tap: writer thread did not start; tap off");
            return None;
        }
        let out = match &cfg.out {
            Out::File(p) => p.display().to_string(),
            Out::Udp(a) => format!("udp {a}"),
        };
        let what = match &cfg.pools {
            Want::All => "every followed V3 / V4 pool".to_string(),
            Want::Keys(k) => format!("{} listed pools", k.len()),
        };
        eprintln!(
            "[arbsim] rush tap ON (ARBSIM_RUSH_TAP): predicted swaps of {what}{} -> {out}",
            cfg.file.as_ref().map(|f| format!(" + list file {}", f.display())).unwrap_or_default()
        );
        Some(TapRuntime { cfg, tx, stats, file_seen: None, file_keys: HashSet::new(), file_checked: None })
    }

    /// The wanted pools now (env list + the list file).
    pub fn want(&self) -> Want {
        match &self.cfg.pools {
            Want::All => Want::All,
            Want::Keys(k) => Want::Keys(k.union(&self.file_keys).cloned().collect()),
        }
    }

    /// Re-read the list file if it changed (at most once a second). True =
    /// the list changed (rebuild the tap set).
    pub fn poll_file(&mut self) -> bool {
        let Some(path) = self.cfg.file.clone() else { return false };
        if self.file_checked.is_some_and(|t| t.elapsed().as_millis() < 1000) {
            return false;
        }
        self.file_checked = Some(Instant::now());
        let m = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        if m == self.file_seen {
            return false;
        }
        self.file_seen = m;
        let keys = std::fs::read_to_string(&path).map(|t| parse_keys(&t)).unwrap_or_default();
        if keys == self.file_keys {
            return false;
        }
        self.file_keys = keys;
        true
    }

    /// Hand a batch to the writer (never waits; a full queue drops it).
    pub fn send(&self, rows: Vec<TapRow>) {
        if rows.is_empty() {
            return;
        }
        let n = rows.len() as u64;
        match self.tx.try_send(rows) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                self.stats.dropped.fetch_add(n, Ordering::Relaxed);
            }
        }
    }

    pub fn status(&self) -> Value {
        json!({
            "out": match &self.cfg.out { Out::File(p) => p.display().to_string(), Out::Udp(a) => format!("udp:{a}") },
            "written": self.stats.written.load(Ordering::Relaxed),
            "dropped": self.stats.dropped.load(Ordering::Relaxed),
            "writeErrors": self.stats.errors.load(Ordering::Relaxed),
            "bytes": self.stats.bytes.load(Ordering::Relaxed),
            "listFileKeys": self.file_keys.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(n: u8) -> Address {
        Address::with_last_byte(n)
    }

    #[test]
    fn off_unless_switched_on() {
        assert_eq!(TapCfg::from_lookup(|_| None), None);
        assert_eq!(TapCfg::from_lookup(|k| (k == "ARBSIM_RUSH_TAP").then(|| "off".into())), None);
        let c = TapCfg::from_lookup(|k| (k == "ARBSIM_RUSH_TAP").then(|| "on".into())).unwrap();
        assert_eq!(c.out, Out::File(PathBuf::from(DEFAULT_OUT)));
        assert_eq!(c.pools, Want::Keys(HashSet::new()));
        assert_eq!(c.max_bytes, DEFAULT_MAX_MB * 1024 * 1024);
    }

    #[test]
    fn settings_parse() {
        let get = |k: &str| match k {
            "ARBSIM_RUSH_TAP" => Some("1".to_string()),
            "ARBSIM_RUSH_TAP_POOLS" => Some(format!("0x{:0>40}, junk 0x{:0>64}", "AB", "1")),
            "ARBSIM_RUSH_TAP_OUT" => Some("udp:127.0.0.1:9650".to_string()),
            "ARBSIM_RUSH_TAP_MAX_MB" => Some("8".to_string()),
            _ => None,
        };
        let c = TapCfg::from_lookup(get).unwrap();
        assert_eq!(c.out, Out::Udp("127.0.0.1:9650".into()));
        assert_eq!(c.max_bytes, 8 << 20);
        let Want::Keys(k) = c.pools else { panic!("keys") };
        assert_eq!(k.len(), 2);
        assert!(k.contains(&format!("0x{:0>40}", "ab")), "lower-cased");
        let all = TapCfg::from_lookup(|k| match k {
            "ARBSIM_RUSH_TAP" => Some("on".into()),
            "ARBSIM_RUSH_TAP_POOLS" => Some(" ALL ".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(all.pools, Want::All);
    }

    #[test]
    fn list_file_text() {
        let k = parse_keys(&format!("# sniper pools\n0x{:0>40} # coin A\n\n0x{:0>40},0xnothex\n", "1", "2"));
        assert_eq!(k.len(), 2);
    }

    #[test]
    fn slot0_decoding_and_direction() {
        // sqrtPriceX96 = 2^96 (price 1), tick -1 (0xffffff), observation bits above.
        let w = (U256::from(7u8) << 184) | (U256::from(0xff_ffffu32) << 160) | (U256::from(1u8) << 96);
        let (s, t) = slot0_parts(w);
        assert_eq!((s, t), (U256::from(1u8) << 96, -1));
        let (_, t2) = slot0_parts(U256::from(887_272u32) << 160);
        assert_eq!(t2, 887_272);
        assert_eq!(direction(U256::from(1u8), U256::from(2u8)), "buy0");
        assert_eq!(direction(U256::from(2u8), U256::from(1u8)), "buy1");
        assert_eq!(direction(U256::from(2u8), U256::from(2u8)), "none");
        assert!((to_f64(U256::from(1u8) << 96) - 2f64.powi(96)).abs() < 1.0);
    }

    fn followed() -> Vec<Followed> {
        let id = B256::with_last_byte(9);
        vec![
            Followed { key: format!("{:#x}", a(1)), kind: PoolKind::V3, address: a(1), v4_id: None, token0: a(10), token1: a(11) },
            Followed { key: format!("{id:#x}"), kind: PoolKind::V4, address: a(2), v4_id: Some(id), token0: Address::ZERO, token1: a(11) },
            Followed { key: format!("{:#x}", a(3)), kind: PoolKind::V2, address: a(3), v4_id: None, token0: a(10), token1: a(11) },
        ]
    }

    #[test]
    fn tap_set_keeps_listed_supported_pools() {
        let f = followed();
        let all = TapSet::build(&f, &Want::All);
        assert_eq!(all.targets.len(), 2, "V2 can't be priced: skipped");
        assert_eq!(all.target(&f[1].key).unwrap().price_at, (a(2), v4_base(B256::with_last_byte(9))));
        assert_eq!(all.price_hits(&[(a(1), U256::ZERO), (a(1), U256::from(1u8)), (a(1), U256::ZERO)]), vec![0]);
        let missing = format!("{:#x}", a(4));
        let some = TapSet::build(&f, &Want::Keys([f[0].key.clone(), f[2].key.clone(), missing.clone()].into_iter().collect()));
        assert_eq!(some.targets.len(), 1);
        assert!(some.has(&f[0].key) && !some.has(&f[1].key));
        assert_eq!(some.not_followed, vec![missing]);
        assert_eq!(some.unsupported, vec![f[2].key.clone()]);
    }

    fn row(seq: u64, kind: RowKind) -> TapRow {
        let t = TapSet::build(&followed(), &Want::All).targets[0].clone();
        TapRow { seq, block: seq, base_seq: seq - 1, tx_index: 0, hash: B256::ZERO, from: Address::ZERO, to: None, row: kind, fate: "ran", sure: true, target: t, before: Some(U256::from(100u8)), after: Some(U256::from(110u8)), why: None, feed_age_us: 0 }
    }

    #[test]
    fn each_block_is_handed_out_once() {
        let mut s = TapState::new(Arc::new(TapSet::default()));
        s.accept(11, vec![row(11, RowKind::Swap)], 500);
        s.accept(11, vec![row(11, RowKind::Swap)], 900);
        s.accept(12, vec![row(12, RowKind::Unsure)], 700);
        let out = s.take();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].feed_age_us, 500);
        assert_eq!((s.counts.rebuilt, s.counts.swaps, s.counts.unsure, s.counts.blocks), (1, 1, 1, 2));
        assert!(s.take().is_empty());
    }

    #[test]
    fn line_shape() {
        let v = row(11, RowKind::Swap).json(1);
        assert_eq!(v["row"], "swap");
        assert_eq!(v["dir"], "buy0");
        assert_eq!(v["sqrtPriceBefore"], "100");
        assert_eq!(v["ahead"], 1);
        // (110/100)^2 - 1 = 21%
        assert!((v["priceChangePct"].as_f64().unwrap() - 21.0).abs() < 1e-6);
        let mut u = row(12, RowKind::Unsure);
        u.before = None;
        u.after = None;
        let v = u.json(1);
        assert!(v.get("dir").is_none() && v.get("sqrtPriceAfter").is_none());
    }

    #[test]
    fn file_writer_writes_and_rotates() {
        let dir = std::env::temp_dir().join(format!("rushtap-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("tap.jsonl");
        let cfg = TapCfg { pools: Want::All, file: None, out: Out::File(path.clone()), max_bytes: 1 };
        let mut sink = Sink::open(&cfg);
        let (n, b, err) = sink.write(&[row(11, RowKind::Swap), row(12, RowKind::Moved)]);
        assert_eq!((n, err), (2, false));
        assert!(b > 0);
        // max 1 byte: rotated after the batch, a fresh empty file is open.
        let rotated = std::fs::read_to_string(dir.join("tap.jsonl.1")).unwrap();
        assert_eq!(rotated.lines().count(), 2);
        let first: Value = serde_json::from_str(rotated.lines().next().unwrap()).unwrap();
        assert_eq!(first["seq"], 11);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn udp_only_to_this_machine() {
        let cfg = TapCfg { pools: Want::All, file: None, out: Out::Udp("10.0.0.1:9650".into()), max_bytes: 1 };
        assert!(matches!(Sink::open(&cfg), Sink::None));
        let rx = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        rx.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
        let cfg = TapCfg { pools: Want::All, file: None, out: Out::Udp(rx.local_addr().unwrap().to_string()), max_bytes: 1 };
        let mut sink = Sink::open(&cfg);
        assert_eq!(sink.write(&[row(11, RowKind::Swap)]).0, 1);
        let mut buf = [0u8; 4096];
        let n = rx.recv(&mut buf).unwrap();
        let v: Value = serde_json::from_slice(&buf[..n]).unwrap();
        assert_eq!(v["seq"], 11);
    }
}
