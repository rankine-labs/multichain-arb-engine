// ============================================================================
// FAST LANE A: PREDICTION CAPTURE + OFFLINE REPLAY ("is the predicted copy
// right, and if not, why?").
//
// Plain English:
//   The build machine has no chain data, and live status only shows a few
//   numbers. So the server can now RECORD a short stretch of exactly what the
//   predicted copy (copy2/ahead.rs) was given, and replay it offline through
//   the very same code, as often as we like, with a full breakdown of every
//   disagreement.
//
//   CAPTURE (only when FASTLANE is practice / live, and only when
//   FASTLANE_CAPTURE_FILE is set; nothing changes otherwise):
//     FASTLANE_CAPTURE_FILE    where to write (written as <file>.part, renamed
//                              to <file> when complete)
//     FASTLANE_CAPTURE_BLOCKS  [300] confirmed blocks to record (~30 s), plus
//                              FASTLANE_AHEAD_COMPARE_DELAY_BLOCKS + 2 so the
//                              last ones are compared too
//     FASTLANE_CAPTURE_AFTER_S [60] start this long after arbsim starts
//                              (copy 2's warm restart has caught up)
//     FASTLANE_CAPTURE_MAX_MB  [512] the file never grows past this (the
//                              capture stops, marked incomplete)
//   Once per arbsim start. What is written, in the order the predicted copy
//   saw it (so a replay makes the same decisions):
//     - its settings, the pools copy 2 follows (and which are not ready),
//       the scanner's route pools, the routers it had learned,
//     - every feed message (raw signed transactions),
//     - every copy-2 version it was handed: the FIRST one in full (every
//       account, value and contract code copy 2 holds), then only what
//       changed from the version before (worked out on a separate thread
//       from copy 2's shared "persistent" maps: most accounts are the very
//       same object, one pointer compare), plus which values copy 2 vouches
//       for as exact (only when that changes),
//     - copy 2's "which transaction moved which pool" answers it used,
//     - per compared block, the SETTLED confirmed values of the pools that
//       changed in it or that our prediction moved, at blocks N-1 and N
//       (this is what agreement compares with; the "confirmed values of
//       route pools' touched slots"). With a capture running, EVERY
//       confirmed block gets this record, also blocks the live prediction
//       could not predict (stopped), so the replay can compare them.
//     - the live counters at the start and the end.
//   Never: node URLs, keys, anything secret (chain data only).
//   Bounded: a channel of 4,096 events to the writer thread; if it is ever
//   full (writer too slow) or the file reaches its limit, the capture stops
//   and says so (an incomplete file is refused by the replay unless asked).
//
//   REPLAY: `arbsim ahead-replay <capture file> [--json] [--samples N]
//   [--budget-ms N] [--partial] [--revert-sure] [--sender-funds trusted|strict] [--unknown-continue] [--keeper <truth file> [--keeper-warm [--keeper-warm-passes N]] [--keep-contracts N] [--keep-seeds-per-h N] [--keep-prune-blocks N] [--oracle]] [--filter-all] [--no-keep-pick]`
//     Builds a fresh predicted copy, feeds it the capture event by event and
//     prints: agreement % (agree / (agree + disagree), per pool compared),
//     the disagreement breakdown by cause (missedFilter / missedRan /
//     missedReverted / missedFailed / missedOffRoute / phantom / value /
//     staleBase), the commonest reasons our runs failed / reverted, the
//     commonest targets behind misses, unsure / not-from-a-tx / conf-gone
//     counts, the apply time (THIS machine's numbers), the live counters for
//     the same stretch, and N full disagreement samples.
//     Deterministic (no clock decides anything: the per-message time budget
//     is OFF unless --budget-ms is given) and quick (300 blocks: seconds).
// ============================================================================
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufWriter, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use revm::primitives::{keccak256, Address, Bytes, B256, KECCAK_EMPTY, U256};
use revm::state::{AccountInfo, Bytecode};
use serde_json::{json, Value};

use super::ahead::{Ahead, AheadCfg, Confirmed, PlaceVals, PoolSet, Settled};
use crate::arb::BlockCtx;
use crate::check::feedstore::BinMsg;
use crate::check::moved::FollowedPool;
use crate::check::ordered::{Provenance, WireFeedMsg};
use crate::state::snap::{Acct, Basics, PMap, Snapshot, Volatile};
use crate::state::{StateDiff, StatePosition};

/// File magic + format version (bump on any change of meaning).
const MAGIC: &[u8; 16] = b"ARBSIM-AHEAD-CAP";
pub const FORMAT: u32 = 1;

/// Events kept waiting for the writer thread at most.
const CHANNEL: usize = 4096;

// ---------------------------------------------------------------------------
// Which values copy 2 vouches for (copy2/intake.rs Copy2Prov), as data.
// ---------------------------------------------------------------------------

/// The exact-values sets of copy 2 (Copy2Prov), or "everything exact"
/// (tests). Same answers as the provenance it was copied from.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProvSets {
    pub all: bool,
    pub accts: HashSet<Address>,
    pub pms: HashSet<Address>,
    pub slots: HashSet<(Address, U256)>,
}

impl ProvSets {
    pub fn all_exact() -> ProvSets {
        ProvSets { all: true, ..Default::default() }
    }
    pub fn from_copy2(p: &super::intake::Copy2Prov) -> ProvSets {
        let (accts, pms, slots) = p.flat();
        ProvSets { all: false, accts, pms, slots }
    }
}

impl Provenance for ProvSets {
    fn slot_exact(&self, a: Address, slot: U256) -> bool {
        self.all || self.accts.contains(&a) || self.pms.contains(&a) || self.slots.contains(&(a, slot))
    }
    fn balance_exact(&self, a: Address) -> bool {
        self.all || self.pms.contains(&a)
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// FASTLANE_CAPTURE_* (see the file header). None = no capture.
#[derive(Clone, Debug)]
pub struct CapCfg {
    pub path: String,
    pub blocks: u64,
    pub after: Duration,
    pub max_bytes: u64,
}

impl CapCfg {
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Option<CapCfg> {
        let path = get("FASTLANE_CAPTURE_FILE").map(|p| p.trim().to_string()).filter(|p| !p.is_empty())?;
        let num = |k: &str, d: u64, lo: u64, hi: u64| get(k).and_then(|v| v.trim().parse::<u64>().ok()).filter(|v| (lo..=hi).contains(v)).unwrap_or(d);
        Some(CapCfg {
            path,
            blocks: num("FASTLANE_CAPTURE_BLOCKS", 300, 1, 100_000),
            after: Duration::from_secs(num("FASTLANE_CAPTURE_AFTER_S", 60, 0, 86_400)),
            max_bytes: num("FASTLANE_CAPTURE_MAX_MB", 512, 1, 16_384) * 1024 * 1024,
        })
    }
}

// ---------------------------------------------------------------------------
// Events (what the predicted copy saw)
// ---------------------------------------------------------------------------

/// One captured event (also what the reader gives back, with snapshots
/// rebuilt).
#[derive(Clone)]
pub enum CapEv {
    /// Settings, block-number offset, live counters at the start (JSON).
    Header { cfg: AheadCfg, l2_offset: u64, live: String },
    /// The pools copy 2 follows (key, contract, V4 id, coins) + not ready.
    Pools { list: Vec<(FollowedPool, Address, Address)>, not_ready: Vec<String> },
    /// The scanner's route pools (None = not known).
    Routes(Option<Vec<String>>),
    /// Routers learned before the capture started (address, pools).
    Touchers(Vec<(Address, Vec<String>)>),
    /// Which values copy 2 vouches for (from now on).
    Prov(Arc<ProvSets>),
    /// A feed message.
    Feed(Arc<BinMsg>),
    /// Copy 2's "which pools did this transaction move" answers used next.
    Moves(Vec<(B256, Option<Vec<String>>)>),
    /// A copy-2 version handed to the predicted copy.
    Confirmed { seq: u64, ctx: Option<BlockCtx>, snap: Arc<Snapshot> },
    /// The settled values agreement compared with.
    Settled(Settled),
    /// End: live counters at the end (JSON) and why it ended.
    End { live: String, why: String },
}

// ---------------------------------------------------------------------------
// Little binary writer / reader (lengths checked against what is left)
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Enc {
    b: Vec<u8>,
}

impl Enc {
    fn u8(&mut self, v: u8) {
        self.b.push(v);
    }
    fn u32(&mut self, v: u32) {
        self.b.extend_from_slice(&v.to_le_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.b.extend_from_slice(&v.to_le_bytes());
    }
    fn len(&mut self, n: usize) {
        self.u32(n as u32);
    }
    fn bool(&mut self, v: bool) {
        self.u8(v as u8);
    }
    fn addr(&mut self, a: &Address) {
        self.b.extend_from_slice(a.as_slice());
    }
    fn b256(&mut self, h: &B256) {
        self.b.extend_from_slice(h.as_slice());
    }
    fn u256(&mut self, v: &U256) {
        self.b.extend_from_slice(&v.to_be_bytes::<32>());
    }
    fn bytes(&mut self, x: &[u8]) {
        self.len(x.len());
        self.b.extend_from_slice(x);
    }
    fn str(&mut self, s: &str) {
        self.bytes(s.as_bytes());
    }
    fn opt_u64(&mut self, v: Option<u64>) {
        match v {
            Some(x) => {
                self.u8(1);
                self.u64(x);
            }
            None => self.u8(0),
        }
    }
    fn strs(&mut self, v: &[String]) {
        self.len(v.len());
        for s in v {
            self.str(s);
        }
    }
    fn ctx(&mut self, c: &BlockCtx) {
        self.u64(c.l1_block_number);
        self.opt_u64(c.l2_block_number);
        self.u64(c.timestamp);
        self.u64(c.basefee);
        self.addr(&c.coinbase);
        self.u64(c.gas_limit);
        self.b256(&c.prevrandao);
    }
    fn place_vals(&mut self, v: &PlaceVals) {
        match v {
            None => self.u8(0),
            Some(list) => {
                self.u8(1);
                self.len(list.len());
                for (s, x) in list {
                    self.u256(s);
                    self.u256(x);
                }
            }
        }
    }
    fn acct(&mut self, x: &Acct) {
        self.basics(x);
        self.len(x.storage.len());
        for (s, v) in x.storage.iter() {
            self.u256(s);
            self.u256(v);
        }
    }
    fn basics(&mut self, x: &Acct) {
        let (known, exists) = match &x.basics {
            Basics::Unknown => (false, false),
            Basics::Known(None) => (true, false),
            Basics::Known(Some(_)) => (true, true),
        };
        self.u8((known as u8) | (exists as u8) << 1 | (x.balance_exact as u8) << 2 | (x.storage_complete as u8) << 3);
        if let Basics::Known(Some(i)) = &x.basics {
            self.u256(&i.balance);
            self.u64(i.nonce);
            self.b256(&i.code_hash);
        }
    }
}

struct Dec<'a> {
    b: &'a [u8],
    i: usize,
}

type Res<T> = Result<T, String>;

impl<'a> Dec<'a> {
    fn take(&mut self, n: usize) -> Res<&'a [u8]> {
        if self.b.len() - self.i < n {
            return Err(format!("record ends early (at byte {})", self.i));
        }
        let s = &self.b[self.i..self.i + n];
        self.i += n;
        Ok(s)
    }
    fn u8(&mut self) -> Res<u8> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Res<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Res<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    /// A list length, checked against what is left (`min` bytes per entry).
    fn len(&mut self, min: usize) -> Res<usize> {
        let n = self.u32()? as usize;
        if n.saturating_mul(min.max(1)) > self.b.len() - self.i {
            return Err(format!("list of {n} entries can't fit (at byte {})", self.i));
        }
        Ok(n)
    }
    fn bool(&mut self) -> Res<bool> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            x => Err(format!("bad flag {x}")),
        }
    }
    fn addr(&mut self) -> Res<Address> {
        Ok(Address::from_slice(self.take(20)?))
    }
    fn b256(&mut self) -> Res<B256> {
        Ok(B256::from_slice(self.take(32)?))
    }
    fn u256(&mut self) -> Res<U256> {
        Ok(U256::from_be_slice(self.take(32)?))
    }
    fn bytes(&mut self) -> Res<&'a [u8]> {
        let n = self.len(1)?;
        self.take(n)
    }
    fn str(&mut self) -> Res<String> {
        String::from_utf8(self.bytes()?.to_vec()).map_err(|_| "bad text".to_string())
    }
    fn opt_u64(&mut self) -> Res<Option<u64>> {
        Ok(if self.bool()? { Some(self.u64()?) } else { None })
    }
    fn strs(&mut self) -> Res<Vec<String>> {
        let n = self.len(4)?;
        (0..n).map(|_| self.str()).collect()
    }
    fn ctx(&mut self) -> Res<BlockCtx> {
        Ok(BlockCtx {
            l1_block_number: self.u64()?,
            l2_block_number: self.opt_u64()?,
            timestamp: self.u64()?,
            basefee: self.u64()?,
            coinbase: self.addr()?,
            gas_limit: self.u64()?,
            prevrandao: self.b256()?,
        })
    }
    fn place_vals(&mut self) -> Res<PlaceVals> {
        if !self.bool()? {
            return Ok(None);
        }
        let n = self.len(64)?;
        let mut v = Vec::with_capacity(n);
        for _ in 0..n {
            v.push((self.u256()?, self.u256()?));
        }
        Ok(Some(v))
    }
    fn basics(&mut self) -> Res<(Basics, bool, bool)> {
        let flags = self.u8()?;
        if flags > 15 {
            return Err(format!("bad account flags {flags}"));
        }
        let basics = match (flags & 1 != 0, flags & 2 != 0) {
            (false, false) => Basics::Unknown,
            (true, false) => Basics::Known(None),
            (true, true) => {
                let balance = self.u256()?;
                let nonce = self.u64()?;
                let code_hash = self.b256()?;
                Basics::Known(Some(AccountInfo { balance, nonce, code_hash, code: None, ..Default::default() }))
            }
            (false, true) => return Err(format!("bad account flags {flags}")),
        };
        Ok((basics, flags & 4 != 0, flags & 8 != 0))
    }
    fn acct(&mut self) -> Res<Acct> {
        let (basics, balance_exact, storage_complete) = self.basics()?;
        let mut storage: PMap<U256, U256> = PMap::default();
        for _ in 0..self.len(64)? {
            let s = self.u256()?;
            storage.insert(s, self.u256()?);
        }
        Ok(Acct { basics, balance_exact, storage, storage_complete })
    }
}

// Record tags.
const T_HEADER: u8 = b'H';
const T_POOLS: u8 = b'P';
const T_ROUTES: u8 = b'R';
const T_TOUCHERS: u8 = b'T';
const T_PROV: u8 = b'V';
const T_FEED: u8 = b'F';
const T_MOVES: u8 = b'M';
const T_CONFIRMED: u8 = b'C';
const T_SETTLED: u8 = b'X';
const T_END: u8 = b'E';

fn enc_cfg(e: &mut Enc, c: &AheadCfg) {
    e.u64(c.max_blocks as u64);
    e.bool(c.run_all);
    e.u64(c.max_txs as u64);
    e.u64(c.max_touchers as u64);
    e.u64(c.l2_offset);
    e.bool(c.trust_sender_funds);
    e.u64(c.msg_budget_us);
    e.bool(c.routes_only);
    e.u64(c.compare_delay);
}

fn dec_cfg(d: &mut Dec) -> Res<AheadCfg> {
    Ok(AheadCfg {
        max_blocks: d.u64()? as usize,
        run_all: d.bool()?,
        max_txs: d.u64()? as usize,
        max_touchers: d.u64()? as usize,
        l2_offset: d.u64()?,
        trust_sender_funds: d.bool()?,
        msg_budget_us: d.u64()?,
        routes_only: d.bool()?,
        compare_delay: d.u64()?,
        // Not in the file (format 1): the replay's own setting
        // (`--revert-sure` = off, the old rule).
        revert_unsure: true,
        // Not in the file either: `--unknown-continue` (Oct 31).
        unknown_continue: false,
        // Not in the file: `--keeper <truth file>` (Oct 31).
        keeper: false,
        // Not in the file: `--no-keep-pick` turns it off (ahead3).
        keep_pick: true,
        // Not in the file: the live-speed settings (Oct 31 night). Off =
        // the old behaviour; `--live-timing --new` turns them on.
        budget_cpu: false,
        lazy_rebase: false,
        kept_rebuild_once: false,
        need_keeper: false,
        // Not in the file: memory fix (Nov 1); same answers either way.
        thin_pending: true,
    })
}

/// The changes from `prev` to `now` (or all of `now` when there is no
/// `prev`), skipping never-trusted ("volatile") accounts: every read of
/// those is Missing anyway. Cheap where nothing changed: an untouched
/// account is the same shared object in both.
fn enc_snapshot(e: &mut Enc, prev: Option<&Snapshot>, now: &Snapshot) {
    let vol = &now.volatile;
    // Position.
    e.u64(now.pos.base_block);
    e.opt_u64(now.pos.after_seq);
    // Never-trusted lists (whole, again each time: short lists).
    let mut whole = vol.whole_list();
    whole.sort();
    let mut bal = vol.balance_list();
    bal.sort();
    e.len(whole.len());
    for a in &whole {
        e.addr(a);
    }
    e.len(bal.len());
    for a in &bal {
        e.addr(a);
    }
    // New contract code (code never changes for a hash).
    let codes: Vec<(&B256, &Bytecode)> = now.codes.iter().filter(|(h, _)| **h != KECCAK_EMPTY && prev.is_none_or(|p| !p.codes.contains_key(*h))).collect();
    e.len(codes.len());
    for (h, c) in codes {
        e.b256(h);
        e.bytes(c.original_byte_slice());
    }
    // Accounts: 1 = whole account, 2 = changes, 3 = gone.
    let mut ops: Vec<(Address, u8)> = Vec::new();
    let mut body = Enc::default();
    for (a, x) in now.accounts.iter() {
        if vol.is_whole(a) {
            continue;
        }
        match prev.and_then(|p| p.accounts.get(a)) {
            None => {
                ops.push((*a, 1));
                body.addr(a);
                body.u8(1);
                body.acct(x);
            }
            Some(px) => {
                let same_storage = px.storage.ptr_eq(&x.storage);
                if same_storage && px.basics == x.basics && px.balance_exact == x.balance_exact && px.storage_complete == x.storage_complete {
                    continue;
                }
                ops.push((*a, 2));
                body.addr(a);
                body.u8(2);
                body.basics(x);
                if same_storage {
                    body.len(0);
                    body.len(0);
                } else {
                    let set: Vec<(&U256, &U256)> = x.storage.iter().filter(|(s, v)| px.storage.get(*s) != Some(*v)).collect();
                    body.len(set.len());
                    for (s, v) in set {
                        body.u256(s);
                        body.u256(v);
                    }
                    let del: Vec<&U256> = px.storage.keys().filter(|s| !x.storage.contains_key(*s)).collect();
                    body.len(del.len());
                    for s in del {
                        body.u256(s);
                    }
                }
            }
        }
    }
    if let Some(p) = prev {
        for a in p.accounts.keys() {
            if !now.accounts.contains_key(a) && !vol.is_whole(a) {
                ops.push((*a, 3));
                body.addr(a);
                body.u8(3);
            }
        }
    }
    e.len(ops.len());
    e.b.extend_from_slice(&body.b);
}

/// Apply one encoded snapshot record onto `cur` (the replay's copy).
fn dec_snapshot(d: &mut Dec, cur: &mut Snapshot, vol: &Arc<Volatile>) -> Res<()> {
    cur.pos = StatePosition { base_block: d.u64()?, after_seq: d.opt_u64()? };
    for _ in 0..d.len(20)? {
        vol.add_whole(d.addr()?);
    }
    for _ in 0..d.len(20)? {
        vol.add_balance(d.addr()?);
    }
    for _ in 0..d.len(36)? {
        let h = d.b256()?;
        let raw = d.bytes()?;
        if keccak256(raw) != h {
            return Err(format!("code {h} does not match its hash"));
        }
        cur.codes.insert(h, Bytecode::new_raw(Bytes::copy_from_slice(raw)));
    }
    for _ in 0..d.len(21)? {
        let a = d.addr()?;
        match d.u8()? {
            1 => {
                let x = d.acct()?;
                cur.accounts.insert(a, x);
            }
            2 => {
                let (basics, balance_exact, storage_complete) = d.basics()?;
                let mut x = cur.accounts.get(&a).cloned().ok_or_else(|| format!("changes for account {a} the copy does not hold"))?;
                x.basics = basics;
                x.balance_exact = balance_exact;
                x.storage_complete = storage_complete;
                for _ in 0..d.len(64)? {
                    let s = d.u256()?;
                    x.storage.insert(s, d.u256()?);
                }
                for _ in 0..d.len(32)? {
                    x.storage.remove(&d.u256()?);
                }
                cur.accounts.insert(a, x);
            }
            3 => {
                cur.accounts.remove(&a);
            }
            op => return Err(format!("bad account op {op}")),
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Writer (its own thread: the predicted copy's thread only hands over Arcs)
// ---------------------------------------------------------------------------

/// What a finished capture wrote.
#[derive(Clone, Debug, Default)]
pub struct CapSummary {
    pub path: String,
    pub bytes: u64,
    pub records: u64,
    pub blocks: u64,
    pub complete: bool,
    pub why: String,
}

/// A running capture (see the file header).
pub struct Capture {
    tx: Option<SyncSender<CapEv>>,
    handle: Option<std::thread::JoinHandle<CapSummary>>,
    /// Set by the writer when it stopped early (file limit, disk error).
    dead: Arc<AtomicBool>,
    /// An event could not be handed over (channel full): incomplete.
    lost: bool,
    pub bytes: Arc<AtomicU64>,
}

impl Capture {
    /// Start writing `path` (as `<path>.part`). `max_bytes`: the limit.
    pub fn start(path: &str, max_bytes: u64) -> std::io::Result<Capture> {
        let part = format!("{path}.part");
        let f = std::fs::File::create(&part)?;
        let (tx, rx) = std::sync::mpsc::sync_channel::<CapEv>(CHANNEL);
        let dead = Arc::new(AtomicBool::new(false));
        let bytes = Arc::new(AtomicU64::new(0));
        let (d2, b2, p2) = (dead.clone(), bytes.clone(), path.to_string());
        let handle = std::thread::Builder::new()
            .name("arbsim-ahead-cap".into())
            .spawn(move || {
                crate::fastlane::mode::lower_this_thread_from_env("arbsim-ahead-cap");
                writer_loop(rx, BufWriter::with_capacity(1 << 20, f), part, p2, max_bytes, d2, b2)
            })?;
        Ok(Capture { tx: Some(tx), handle: Some(handle), dead, lost: false, bytes })
    }

    /// Hand one event over (never waits). false = the capture is broken
    /// (writer stopped, or the channel was full): stop using it.
    pub fn send(&mut self, ev: CapEv) -> bool {
        if self.lost || self.dead.load(Ordering::Relaxed) {
            return false;
        }
        match self.tx.as_ref().map(|t| t.try_send(ev)) {
            Some(Ok(())) => true,
            Some(Err(TrySendError::Full(_))) | Some(Err(TrySendError::Disconnected(_))) | None => {
                self.lost = true;
                false
            }
        }
    }

    pub fn alive(&self) -> bool {
        !self.lost && !self.dead.load(Ordering::Relaxed)
    }

    /// Finish: the End record (when nothing was lost), close, rename.
    pub fn finish(mut self, live: String, why: &str) -> CapSummary {
        let why = if self.lost { "an event could not be handed to the writer (too slow): incomplete".to_string() } else { why.to_string() };
        if !self.lost {
            if let Some(t) = &self.tx {
                // Blocking send is fine here: the writer is draining.
                let _ = t.send(CapEv::End { live, why: why.clone() });
            }
        }
        self.tx = None;
        let mut s = self.handle.take().and_then(|h| h.join().ok()).unwrap_or_default();
        if self.lost {
            s.complete = false;
            s.why = why;
        }
        s
    }
}

fn writer_loop(rx: Receiver<CapEv>, mut w: BufWriter<std::fs::File>, part: String, path: String, max_bytes: u64, dead: Arc<AtomicBool>, bytes: Arc<AtomicU64>) -> CapSummary {
    let mut sum = CapSummary { path: path.clone(), ..Default::default() };
    let mut prev: Option<Arc<Snapshot>> = None;
    let mut last_block: Option<u64> = None;
    let mut ended = false;
    let fail = |why: String, sum: &mut CapSummary| {
        dead.store(true, Ordering::Relaxed);
        sum.why = why;
    };
    if let Err(e) = w.write_all(MAGIC).and_then(|_| w.write_all(&FORMAT.to_le_bytes())) {
        fail(format!("write error: {e}"), &mut sum);
    }
    sum.bytes = 20;
    for ev in rx.iter() {
        if dead.load(Ordering::Relaxed) {
            continue; // drain, write nothing more
        }
        let mut e = Enc::default();
        let tag = match &ev {
            CapEv::Header { cfg, l2_offset, live } => {
                enc_cfg(&mut e, cfg);
                e.u64(*l2_offset);
                e.str(live);
                T_HEADER
            }
            CapEv::Pools { list, not_ready } => {
                e.len(list.len());
                for (p, t0, t1) in list {
                    e.str(&p.key);
                    e.addr(&p.address);
                    match p.v4_id {
                        Some(id) => {
                            e.u8(1);
                            e.b256(&id);
                        }
                        None => e.u8(0),
                    }
                    e.addr(t0);
                    e.addr(t1);
                }
                e.strs(not_ready);
                T_POOLS
            }
            CapEv::Routes(r) => {
                match r {
                    Some(v) => {
                        e.u8(1);
                        e.strs(v);
                    }
                    None => e.u8(0),
                }
                T_ROUTES
            }
            CapEv::Touchers(v) => {
                e.len(v.len());
                for (a, p) in v {
                    e.addr(a);
                    e.strs(p);
                }
                T_TOUCHERS
            }
            CapEv::Prov(p) => {
                e.bool(p.all);
                let mut accts: Vec<&Address> = p.accts.iter().collect();
                accts.sort();
                e.len(accts.len());
                for a in accts {
                    e.addr(a);
                }
                let mut pms: Vec<&Address> = p.pms.iter().collect();
                pms.sort();
                e.len(pms.len());
                for a in pms {
                    e.addr(a);
                }
                let mut slots: Vec<&(Address, U256)> = p.slots.iter().collect();
                slots.sort();
                e.len(slots.len());
                for (a, s) in slots {
                    e.addr(a);
                    e.u256(s);
                }
                T_PROV
            }
            CapEv::Feed(m) => {
                e.u64(m.seq);
                e.u64(m.ts);
                e.u64(m.l1);
                // A message the feed store could not fully read counts as
                // not complete (the predicted copy stops on it either way).
                e.bool(m.complete && m.bad.is_none());
                e.str(m.why.as_deref().unwrap_or(""));
                e.len(m.txs.len());
                for t in &m.txs {
                    e.bytes(&t.raw);
                }
                T_FEED
            }
            CapEv::Moves(v) => {
                e.len(v.len());
                for (h, p) in v {
                    e.b256(h);
                    match p {
                        Some(list) => {
                            e.u8(1);
                            e.strs(list);
                        }
                        None => e.u8(0),
                    }
                }
                T_MOVES
            }
            CapEv::Confirmed { seq, ctx, snap } => {
                e.u64(*seq);
                match ctx {
                    Some(c) => {
                        e.u8(1);
                        e.ctx(c);
                    }
                    None => e.u8(0),
                }
                e.bool(prev.is_none());
                enc_snapshot(&mut e, prev.as_deref(), snap);
                prev = Some(snap.clone());
                if last_block.is_none_or(|b| *seq > b) {
                    last_block = Some(*seq);
                    sum.blocks += 1;
                }
                T_CONFIRMED
            }
            CapEv::Settled(st) => {
                e.u64(st.seq);
                e.strs(&st.moved);
                e.len(st.now.len());
                for (k, v) in &st.now {
                    e.str(k);
                    e.place_vals(v);
                    e.place_vals(st.prev.get(k).unwrap_or(&None));
                }
                e.strs(&st.late);
                T_SETTLED
            }
            CapEv::End { live, why } => {
                e.str(live);
                e.str(why);
                ended = true;
                sum.why = why.clone();
                T_END
            }
        };
        let n = e.b.len() as u64 + 5;
        if sum.bytes + n > max_bytes && tag != T_END {
            fail(format!("the file reached FASTLANE_CAPTURE_MAX_MB ({} MB): incomplete", max_bytes / (1024 * 1024)), &mut sum);
            continue;
        }
        let r = w.write_all(&[tag]).and_then(|_| w.write_all(&(e.b.len() as u32).to_le_bytes())).and_then(|_| w.write_all(&e.b));
        if let Err(err) = r {
            fail(format!("write error: {err}"), &mut sum);
            continue;
        }
        sum.bytes += n;
        sum.records += 1;
        bytes.store(sum.bytes, Ordering::Relaxed);
    }
    let flushed = w.flush().is_ok();
    drop(w);
    sum.complete = ended && flushed && !dead.load(Ordering::Relaxed);
    if sum.complete && std::fs::rename(&part, &path).is_err() {
        sum.complete = false;
        sum.why = "could not rename the finished file".into();
    }
    if !sum.complete {
        // Keep what was written under its .part name (the replay can read
        // it with --partial), and say so.
        sum.path = part;
    }
    sum
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/// A whole capture read back: its events in order (snapshots rebuilt),
/// and whether it ended properly.
pub struct CapFile {
    pub events: Vec<CapEv>,
    pub complete: bool,
    /// Why reading stopped early (a cut-off file), if it did.
    pub cut: Option<String>,
}

pub fn read_capture(path: &str) -> Result<CapFile, String> {
    let buf = std::fs::read(path).map_err(|e| format!("can't read {path}: {e}"))?;
    decode_capture(&buf)
}

pub fn decode_capture(buf: &[u8]) -> Result<CapFile, String> {
    if buf.len() < 20 || &buf[..16] != MAGIC {
        return Err("not a fast lane capture file".into());
    }
    let fmt = u32::from_le_bytes(buf[16..20].try_into().unwrap());
    if fmt != FORMAT {
        return Err(format!("capture format {fmt}, this arbsim reads only {FORMAT}"));
    }
    let vol = Arc::new(Volatile::default());
    let mut cur = Snapshot { volatile: vol.clone(), ..Default::default() };
    let mut out = CapFile { events: Vec::new(), complete: false, cut: None };
    let mut i = 20usize;
    while i < buf.len() {
        if buf.len() - i < 5 {
            out.cut = Some(format!("file cut off at byte {i}"));
            break;
        }
        let tag = buf[i];
        let n = u32::from_le_bytes(buf[i + 1..i + 5].try_into().unwrap()) as usize;
        if buf.len() - i - 5 < n {
            out.cut = Some(format!("file cut off inside a record at byte {i}"));
            break;
        }
        let body = &buf[i + 5..i + 5 + n];
        i += 5 + n;
        let mut d = Dec { b: body, i: 0 };
        let ev = match tag {
            T_HEADER => {
                let cfg = dec_cfg(&mut d)?;
                let l2_offset = d.u64()?;
                CapEv::Header { cfg, l2_offset, live: d.str()? }
            }
            T_POOLS => {
                let mut list = Vec::new();
                for _ in 0..d.len(45)? {
                    let key = d.str()?;
                    let address = d.addr()?;
                    let v4_id = if d.bool()? { Some(d.b256()?) } else { None };
                    let t0 = d.addr()?;
                    let t1 = d.addr()?;
                    list.push((FollowedPool { key, address, v4_id }, t0, t1));
                }
                CapEv::Pools { list, not_ready: d.strs()? }
            }
            T_ROUTES => CapEv::Routes(if d.bool()? { Some(d.strs()?) } else { None }),
            T_TOUCHERS => {
                let mut v = Vec::new();
                for _ in 0..d.len(24)? {
                    let a = d.addr()?;
                    v.push((a, d.strs()?));
                }
                CapEv::Touchers(v)
            }
            T_PROV => {
                let mut p = ProvSets { all: d.bool()?, ..Default::default() };
                for _ in 0..d.len(20)? {
                    p.accts.insert(d.addr()?);
                }
                for _ in 0..d.len(20)? {
                    p.pms.insert(d.addr()?);
                }
                for _ in 0..d.len(52)? {
                    let a = d.addr()?;
                    p.slots.insert((a, d.u256()?));
                }
                CapEv::Prov(Arc::new(p))
            }
            T_FEED => {
                let seq = d.u64()?;
                let ts = d.u64()?;
                let l1 = d.u64()?;
                let complete = d.bool()?;
                let why = d.str()?;
                let mut txs = Vec::new();
                for _ in 0..d.len(4)? {
                    let raw = d.bytes()?;
                    txs.push(format!("0x{}", raw.iter().map(|b| format!("{b:02x}")).collect::<String>()));
                }
                let wm = WireFeedMsg { seq, ts, l1, txs, complete, why: (!why.is_empty()).then_some(why) };
                CapEv::Feed(Arc::new(BinMsg::from_wire(&wm, true)))
            }
            T_MOVES => {
                let mut v = Vec::new();
                for _ in 0..d.len(33)? {
                    let h = d.b256()?;
                    v.push((h, if d.bool()? { Some(d.strs()?) } else { None }));
                }
                CapEv::Moves(v)
            }
            T_CONFIRMED => {
                let seq = d.u64()?;
                let ctx = if d.bool()? { Some(d.ctx()?) } else { None };
                let full = d.bool()?;
                if full {
                    cur = Snapshot { volatile: vol.clone(), ..Default::default() };
                }
                dec_snapshot(&mut d, &mut cur, &vol)?;
                CapEv::Confirmed { seq, ctx, snap: Arc::new(cur.clone()) }
            }
            T_SETTLED => {
                let mut st = Settled { seq: d.u64()?, moved: d.strs()?, ..Default::default() };
                for _ in 0..d.len(6)? {
                    let k = d.str()?;
                    let now = d.place_vals()?;
                    let prev = d.place_vals()?;
                    st.now.insert(k.clone(), now);
                    st.prev.insert(k, prev);
                }
                st.late = d.strs()?;
                CapEv::Settled(st)
            }
            T_END => {
                let live = d.str()?;
                out.complete = true;
                CapEv::End { live, why: d.str()? }
            }
            t => return Err(format!("unknown record {t} at byte {}", i - n - 5)),
        };
        if d.i != body.len() {
            return Err(format!("record {} has {} bytes left over", tag as char, body.len() - d.i));
        }
        out.events.push(ev);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/// Replay options.
#[derive(Clone, Debug, Default)]
pub struct ReplayOpts {
    /// Per-message time budget in ms (None = off: deterministic).
    pub budget_ms: Option<u64>,
    /// Override FASTLANE_AHEAD_REVERT_UNSURE (None = on, the default):
    /// `--revert-sure` = Some(false), the old rule, for before / after.
    pub revert_unsure: Option<bool>,
    /// Override FASTLANE_AHEAD_TRUST_SENDER_FUNDS as captured:
    /// `--sender-funds trusted|strict` (live runs strict unless set).
    pub trust_sender_funds: Option<bool>,
    /// FASTLANE_AHEAD_UNKNOWN_CONTINUE for this replay (`--unknown-continue`;
    /// off = stop the prediction, the rule the capture ran with).
    pub unknown_continue: bool,
    /// `--oracle` (needs `--keeper <truth>`): explain every reverted run
    /// against the chain's exact starting state (keeper_replay.rs Oracle).
    pub oracle: bool,
    /// `--filter-all`: run EVERY feed transaction (FASTLANE_AHEAD_FILTER=all),
    /// not only the ones the cheap filter picks.
    pub filter_all: bool,
    /// `--no-keep-pick`: FASTLANE_AHEAD_KEEP_PICK=off for this replay.
    pub no_keep_pick: bool,
}

/// Replay a capture through a fresh predicted copy. Returns the report
/// (JSON; see `print_report`).
pub fn replay(cap: &CapFile, opts: &ReplayOpts) -> Result<Value, String> {
    replay_with(cap, opts, None).map(|x| x.0)
}

/// The keeper side of a replay (`--keeper <truth file>`, copy2/keeper_replay.rs).
pub struct KeeperOpts {
    pub truth: Arc<super::keeper_replay::Truth>,
    pub cfg: super::keeper::KeeperCfg,
    /// Learned batches to have seeded at the start (the warm start), if any.
    pub warm: Option<Vec<Vec<crate::state::MissItem>>>,
}

/// Replay with the hot-contract keeper next to the predicted copy (see
/// copy2/keeper_replay.rs). `warm`: run the capture once to learn the hot
/// contracts, then measure a run that starts with them seeded.
pub fn replay_keeper(cap: &CapFile, opts: &ReplayOpts, truth: Arc<super::keeper_replay::Truth>, cfg: super::keeper::KeeperCfg, warm_passes: usize) -> Result<Value, String> {
    let warm = warm_passes > 0;
    let mut first_pass: Option<Vec<Vec<crate::state::MissItem>>> = None;
    // Each learning pass starts with what the passes before it learned (a
    // run that gets further needs values the earlier one never reached).
    for _ in 0..warm_passes {
        let (_, rk) = replay_with(cap, opts, Some(KeeperOpts { truth: truth.clone(), cfg: cfg.clone(), warm: first_pass.clone() }))?;
        let mut acc = first_pass.take().unwrap_or_default();
        acc.extend(rk.map(|k| k.learned_all).unwrap_or_default());
        first_pass = Some(acc);
    }
    let n_warm = first_pass.as_ref().map(|v| v.iter().map(|b| b.len()).sum::<usize>());
    let (mut r, _) = replay_with(cap, opts, Some(KeeperOpts { truth, cfg, warm: first_pass }))?;
    r["keeper"]["warmStart"] = json!(warm);
    r["keeper"]["warmValues"] = json!(n_warm);
    Ok(r)
}

/// What `passes` predicted-copy passes with the keeper learn over the
/// capture (each pass starting with the earlier ones' learning): the warm
/// start for `trig-replay --keeper` (fastlane/trig_replay.rs).
pub fn keeper_learned(cap: &CapFile, truth: Arc<super::keeper_replay::Truth>, cfg: super::keeper::KeeperCfg, passes: usize) -> Result<Vec<Vec<crate::state::MissItem>>, String> {
    let opts = ReplayOpts { unknown_continue: true, ..Default::default() };
    let mut acc: Vec<Vec<crate::state::MissItem>> = Vec::new();
    for _ in 0..passes {
        let warm = if acc.is_empty() { None } else { Some(acc.clone()) };
        let (_, rk) = replay_with(cap, &opts, Some(KeeperOpts { truth: truth.clone(), cfg: cfg.clone(), warm }))?;
        acc.extend(rk.map(|k| k.learned_all).unwrap_or_default());
    }
    Ok(acc)
}

fn replay_with(cap: &CapFile, opts: &ReplayOpts, keeper: Option<KeeperOpts>) -> Result<(Value, Option<super::keeper_replay::ReplayKeeper>), String> {
    let t0 = Instant::now();
    let Some(CapEv::Header { cfg, l2_offset, live: live_start }) = cap.events.first().cloned() else {
        return Err("the capture does not start with its settings".into());
    };
    let mut cfg = cfg;
    cfg.l2_offset = l2_offset;
    // Agreement runs when the capture says copy 2 had settled (the X
    // records), never by itself.
    cfg.compare_delay = u64::MAX / 4;
    cfg.msg_budget_us = opts.budget_ms.map(|m| m.clamp(1, 1000) * 1000).unwrap_or(u64::MAX / 4);
    cfg.revert_unsure = opts.revert_unsure.unwrap_or(true);
    if let Some(v) = opts.trust_sender_funds {
        cfg.trust_sender_funds = v;
    }
    cfg.unknown_continue = opts.unknown_continue;
    if opts.filter_all {
        cfg.run_all = true;
    }
    if opts.no_keep_pick {
        cfg.keep_pick = false;
    }
    cfg.keeper = keeper.is_some();
    let l2 = cfg.l2_offset;
    let mut a = Ahead::new(cfg);
    a.diag = Some(Default::default());
    if opts.oracle {
        if let Some(k) = &keeper {
            a.oracle = Some(super::keeper_replay::Oracle::new(k.truth.clone()));
        }
    }
    // KEEPER (--keeper): the real keeper core on the recorded block diffs.
    let mut rk = keeper.map(|k| {
        let mut r = super::keeper_replay::ReplayKeeper::new(k.truth, k.cfg);
        // Blocks a second, from the feed's own timestamps (seeds per hour).
        let ts: Vec<(u64, u64)> = cap.events.iter().filter_map(|e| if let CapEv::Feed(m) = e { Some((m.seq, m.ts)) } else { None }).collect();
        if let (Some(f), Some(l)) = (ts.first(), ts.last()) {
            if l.1 > f.1 && l.0 > f.0 {
                r.blocks_per_s = (l.0 - f.0) as f64 / (l.1 - f.1) as f64;
            }
        }
        if let Some(w) = k.warm {
            for b in &w {
                r.core.learn(b);
            }
        }
        let w = k_warm_flag(&r);
        (r, w)
    });
    let mut warm_pending = rk.as_ref().is_some_and(|x| x.1);
    a.collect_all = Some(Vec::new());
    let mut prov: Arc<dyn Provenance + Send + Sync> = Arc::new(ProvSets::all_exact());
    let mut moves: HashMap<B256, Option<Vec<String>>> = HashMap::new();
    // Copy-2 versions by block (the newest one handed for each), bounded.
    let mut snaps: BTreeMap<u64, Arc<Snapshot>> = BTreeMap::new();
    let mut live_end: Option<String> = None;
    let (mut n_feed, mut n_conf, mut n_settled, mut settled_used, mut filled) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let mut first_block: Option<u64> = None;
    let mut last_block = 0u64;
    for ev in &cap.events[1..] {
        match ev {
            CapEv::Header { .. } => return Err("two settings records".into()),
            CapEv::Pools { list, not_ready } => a.set_pools(Arc::new(PoolSet::build(list, not_ready.iter().cloned().collect()))),
            CapEv::Routes(r) => a.set_route_pools(r.as_ref().map(|v| Arc::new(v.iter().cloned().collect()))),
            CapEv::Touchers(v) => a.learn_touchers(v),
            CapEv::Prov(p) => prov = p.clone(),
            CapEv::Feed(m) => {
                n_feed += 1;
                // Decoded before it is applied, like the feed store's
                // background thread does live.
                for t in &m.txs {
                    let _ = t.decoded();
                }
                a.on_feed_message(m.clone());
            }
            CapEv::Moves(v) => {
                for (h, p) in v {
                    moves.insert(*h, p.clone());
                }
            }
            CapEv::Confirmed { seq, ctx, snap } => {
                n_conf += 1;
                first_block.get_or_insert(*seq);
                last_block = last_block.max(*seq);
                snaps.insert(*seq, snap.clone());
                while snaps.len() > 128 {
                    let k = *snaps.keys().next().unwrap();
                    snaps.remove(&k);
                }
                if let Some((k, _)) = rk.as_mut() {
                    // The keeper first (its version of this block), then
                    // copy 2's version: the rebase merges both at once.
                    k.advance(*seq + l2, &mut a, warm_pending);
                    warm_pending = false;
                }
                let c = Confirmed { seq: *seq, snap: snap.clone(), ctx: ctx.clone(), diff: Arc::new(StateDiff::default()), prov: prov.clone() };
                a.on_confirmed(c, &|h| moves.get(h).cloned().flatten());
            }
            CapEv::Settled(st) => {
                n_settled += 1;
                let Some((pools, keys, _)) = a.pending_parts(st.seq) else { continue };
                let mut st = st.clone();
                // Pools only this replay predicted moved (live did not
                // predict this block): their values from the versions held.
                let before = st.now.len();
                if let (Some(prev), Some(now)) = (snaps.get(&(st.seq.wrapping_sub(1))), snaps.get(&st.seq)) {
                    st.fill_from(&pools, keys.iter(), prev, now);
                }
                filled += (st.now.len() - before) as u64;
                if a.compare_settled(&st, &|h| moves.get(h).cloned().flatten()) {
                    settled_used += 1;
                }
            }
            CapEv::End { live, .. } => live_end = Some(live.clone()),
        }
    }
    let took_ms = t0.elapsed().as_millis() as u64;
    let all = a.collect_all.take().unwrap_or_default();
    let mut r = report(&a, &all, ReportInfo { n_feed, n_conf, n_settled, settled_used, filled, first_block, last_block, took_ms, complete: cap.complete, cut: cap.cut.clone(), live_start, live_end, l2_offset, budget_ms: opts.budget_ms });
    if let Some((fails, unsure)) = &a.diag {
        let top = |m: &BTreeMap<String, u64>| {
            let mut v: Vec<(&String, &u64)> = m.iter().collect();
            v.sort_by(|x, y| y.1.cmp(x.1));
            v.into_iter().take(12).map(|(k, n)| json!({"what": k, "n": n})).collect::<Vec<_>>()
        };
        r["diag"] = json!({"failedRuns": top(fails), "unsurePools": top(unsure)});
    }
    if let Some(o) = &a.oracle {
        r["oracle"] = o.report();
    }
    let rk = rk.map(|x| x.0);
    if let Some(k) = &rk {
        let t = &a.total;
        let mut kr = k.report();
        kr["bases"] = json!({"merged": t.kept_bases, "notMerged": t.kept_missing, "valuesAdded": t.kept_values, "keeperRebases": t.kept_rebases, "learned": t.learned});
        r["keeper"] = kr;
    }
    Ok((r, rk))
}

// ---------------------------------------------------------------------------
// LIVE-TIMING REPLAY (`--live-timing`, Oct 31 night)
// ---------------------------------------------------------------------------

/// How `ahead-replay --live-timing` paces a capture (see `replay_live`).
#[derive(Clone, Debug)]
pub struct LiveTiming {
    /// Feed pace: one message every this many ms (default: the capture's
    /// own block rate from the feed timestamps).
    pub block_ms: Option<f64>,
    /// Node answer time: median and 90th percentile (ms).
    pub node_p50_ms: u64,
    pub node_p90_ms: u64,
    /// The node has a block this long after the feed announced it (ms).
    pub node_lag_ms: u64,
    /// Settings as `KEY=VALUE` (FASTLANE_AHEAD=observe = the new defaults;
    /// FASTLANE_AHEAD=on + FASTLANE_AHEAD_KEEPER=on = the old ones), plus
    /// any FASTLANE_AHEAD_* override, read like the live process reads env.
    pub env: HashMap<String, String>,
    /// Seconds the keeper may spend seeding before the feed starts (both
    /// runtimes start warm: the learned contracts' values are read first).
    pub preroll_s: u64,
    /// Learning passes for the warm start (offline, before the timed run).
    pub warm_passes: usize,
    /// Copy 2 publishes block N only once the feed is at least this many
    /// blocks past it (live Oct 31: p50 5, p90 6 blocks behind the feed; the
    /// Oct 27 capture had p50 0). None = the capture's own order.
    pub copy2_delay_blocks: Option<u64>,
}

/// Peak and current resident memory of this process (kB), from /proc.
fn rss_kb() -> (u64, u64) {
    let txt = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let f = |k: &str| txt.lines().find(|l| l.starts_with(k)).and_then(|l| l.split_whitespace().nth(1)).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    (f("VmHWM:"), f("VmRSS:"))
}

/// CPU seconds this whole process has used (all threads).
fn process_cpu_s() -> f64 {
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    // SAFETY: getrusage only writes the struct we pass.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) } != 0 {
        return 0.0;
    }
    let t = |v: libc::timeval| v.tv_sec as f64 + v.tv_usec as f64 / 1e6;
    t(ru.ru_utime) + t(ru.ru_stime)
}

/// LIVE-TIMING REPLAY: the capture in REAL time, like live, instead of as
/// fast as possible with every wait taken away.
///   - Feed messages arrive at the live block pace (one per `block_ms`);
///     copy 2's versions and settled records come where the capture had
///     them between the feed messages (the order live saw them).
///   - The predicted copy runs on this thread with the live settings:
///     the 10 ms per-message budget is ON (`--budget-ms`, default 10).
///   - The keeper is the REAL runtime (`keeper::drive`: the old serial loop
///     or the pipelined one, by the settings), on its own threads, against
///     a node model over the recorded block diffs with real answer times
///     (copy2/keeper_replay.rs TruthIo).
///   - It starts warm (contracts learned in offline passes, seeded during
///     a pre-roll), so the measured stretch is the steady state.
/// Run it on the server at low priority next to the live bot: the CPU it
/// gets is then like (or worse than) the live predicted copy's.
pub fn replay_live(cap: &CapFile, opts: &ReplayOpts, truth: Arc<super::keeper_replay::Truth>, lt: &LiveTiming) -> Result<Value, String> {
    use super::keeper::KeeperIo;
    use std::sync::atomic::Ordering::Relaxed;
    let Some(CapEv::Header { cfg, l2_offset, .. }) = cap.events.first().cloned() else {
        return Err("the capture does not start with its settings".into());
    };
    let get = |k: &str| lt.env.get(k).cloned();
    let fresh = AheadCfg::from_lookup(get, l2_offset);
    let mut kcfg = super::keeper::KeeperCfg::from_lookup(get);
    kcfg.on = true;
    let mut cfg = cfg;
    cfg.l2_offset = l2_offset;
    cfg.compare_delay = u64::MAX / 4;
    cfg.msg_budget_us = opts.budget_ms.unwrap_or(10).clamp(1, 1000) * 1000;
    cfg.revert_unsure = opts.revert_unsure.unwrap_or(true);
    if let Some(v) = opts.trust_sender_funds {
        cfg.trust_sender_funds = v;
    }
    cfg.unknown_continue = true;
    cfg.keeper = true;
    cfg.keep_pick = !opts.no_keep_pick;
    cfg.budget_cpu = fresh.budget_cpu;
    cfg.lazy_rebase = fresh.lazy_rebase;
    cfg.kept_rebuild_once = fresh.kept_rebuild_once;
    cfg.need_keeper = fresh.need_keeper;
    let settings = json!({
        "budgetMs": cfg.msg_budget_us / 1000, "budgetClock": if cfg.budget_cpu { "cpu" } else { "wall" }, "lazyRebase": cfg.lazy_rebase,
        "keptRebuild": if cfg.kept_rebuild_once { "once" } else { "every" }, "needKeeper": cfg.need_keeper,
        "keepContracts": kcfg.max_contracts, "fetchPar": kcfg.fetch_par, "seedPar": kcfg.seed_par, "leadFeed": kcfg.lead_feed, "candSlots": kcfg.cand_slots,
    });
    // Warm start: what offline passes learn (contracts and values).
    let warm = if lt.warm_passes > 0 { keeper_learned(cap, truth.clone(), kcfg.clone(), lt.warm_passes)? } else { Vec::new() };
    let (rss0, _) = rss_kb();
    let cpu0 = process_cpu_s();
    let ts: Vec<(u64, u64)> = cap.events.iter().filter_map(|e| if let CapEv::Feed(m) = e { Some((m.seq, m.ts)) } else { None }).collect();
    let block_ms = lt.block_ms.unwrap_or_else(|| match (ts.first(), ts.last()) {
        (Some(f), Some(l)) if l.1 > f.1 && l.0 > f.0 => 1000.0 * (l.1 - f.1) as f64 / (l.0 - f.0) as f64,
        _ => 107.0,
    });
    // The keeper's world: node model + the real runtime on its own threads.
    let io = Arc::new(super::keeper_replay::TruthIo::new(truth.clone(), Duration::from_millis(lt.node_p50_ms), Duration::from_millis(lt.node_p90_ms), Duration::from_millis(lt.node_lag_ms)));
    let published = Arc::new(AtomicU64::new(0));
    let pubc = published.clone();
    let sink = super::keeper::Sink::new(Arc::new(move || {
        pubc.fetch_add(1, Relaxed);
    }));
    let (ltx, lrx) = std::sync::mpsc::sync_channel::<Vec<crate::state::MissItem>>(1024);
    let first_conf = cap.events.iter().find_map(|e| if let CapEv::Confirmed { seq, .. } = e { Some(*seq) } else { None }).ok_or("no copy-2 version in the capture")?;
    io.announce(first_conf + l2_offset);
    io.set_copy2(first_conf + l2_offset);
    let warm_all: Vec<crate::state::MissItem> = warm.into_iter().flatten().collect();
    let n_warm = warm_all.len();
    if !warm_all.is_empty() {
        let _ = ltx.try_send(warm_all);
    }
    let kio: Arc<dyn super::keeper::KeeperIo> = io.clone();
    let ksink = sink.clone();
    let kc = kcfg.clone();
    let kt = std::thread::Builder::new().name("replay-keeper".into()).spawn(move || super::keeper::drive(kio, kc, lrx, ksink)).map_err(|e| e.to_string())?;
    // Pre-roll: the keeper seeds what it learned (copy 2 stays at the first block).
    let pre0 = Instant::now();
    let mut seeded_after_s = None;
    while pre0.elapsed() < Duration::from_secs(lt.preroll_s) {
        std::thread::sleep(Duration::from_millis(200));
        let st = sink.status.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let waiting = st["seedsWaiting"].as_u64().unwrap_or(1) + st["pipeline"]["seedsOut"].as_u64().unwrap_or(0);
        if st["head"].as_u64().is_some() && waiting == 0 && pre0.elapsed() > Duration::from_secs(2) {
            seeded_after_s = Some(pre0.elapsed().as_secs_f64());
            break;
        }
    }
    let status_pre = sink.status.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let resets_pre = status_pre["stats"]["resets"].clone();
    let calls_pre = io.calls.load(Relaxed);
    // The predicted copy, on this thread (like live's arbsim-ahead thread).
    let mut a = Ahead::new(cfg);
    a.diag = Some(Default::default());
    a.collect_all = Some(Vec::new());
    let mut prov: Arc<dyn Provenance + Send + Sync> = Arc::new(ProvSets::all_exact());
    let mut moves: HashMap<B256, Option<Vec<String>>> = HashMap::new();
    let mut snaps: BTreeMap<u64, Arc<Snapshot>> = BTreeMap::new();
    let (mut n_feed, mut n_conf, mut n_settled, mut settled_used, mut filled) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let (mut first_block, mut last_block) = (None, 0u64);
    let mut last_feed_seq = 0u64;
    let mut late_feed_ms: Vec<u64> = Vec::new();
    let mut c2_lag: Vec<u64> = Vec::new();
    let mut keeper_vs_c2: Vec<i64> = Vec::new();
    let mut seen_pub = published.load(Relaxed);
    let t0 = Instant::now();
    let cpu_run0 = process_cpu_s();
    // Memory during the timed run (resident, sampled every 10 feed messages).
    let rss_run0 = rss_kb().1;
    let mut rss_run_max = rss_run0;
    // Like live's run loop after each wake-up: the keeper's version of the
    // base block (a keeper rebase if it came late), and what to learn.
    let keeper_turn = |a: &mut Ahead, seen: &mut u64| {
        let p = published.load(Relaxed);
        if p != *seen {
            *seen = p;
            if let Some(b) = a.base_block() {
                if let Some(kv) = sink.version_at(b) {
                    a.on_kept(kv);
                }
            }
        }
        if !a.learned.is_empty() {
            let _ = ltx.try_send(std::mem::take(&mut a.learned));
        }
    };
    for ev in live_order(&cap.events[1..], lt.copy2_delay_blocks) {
        match ev {
            CapEv::Header { .. } => return Err("two settings records".into()),
            CapEv::Pools { list, not_ready } => a.set_pools(Arc::new(PoolSet::build(list, not_ready.iter().cloned().collect()))),
            CapEv::Routes(r) => a.set_route_pools(r.as_ref().map(|v| Arc::new(v.iter().cloned().collect()))),
            CapEv::Touchers(v) => a.learn_touchers(v),
            CapEv::Prov(p) => prov = p.clone(),
            CapEv::Feed(m) => {
                // Wait for its live arrival time; meanwhile react to the
                // keeper like the live thread does (it wakes on kept_hook).
                let due = t0 + Duration::from_secs_f64(n_feed as f64 * block_ms / 1000.0);
                loop {
                    let now = Instant::now();
                    if now >= due {
                        break;
                    }
                    std::thread::sleep((due - now).min(Duration::from_millis(2)));
                    keeper_turn(&mut a, &mut seen_pub);
                }
                late_feed_ms.push(Instant::now().saturating_duration_since(due).as_millis() as u64);
                if n_feed % 10 == 0 {
                    rss_run_max = rss_run_max.max(rss_kb().1);
                }
                n_feed += 1;
                last_feed_seq = m.seq;
                io.announce(m.seq + l2_offset);
                for t in &m.txs {
                    let _ = t.decoded();
                }
                a.on_feed_message_at(m.clone(), due);
                if let (Some(v), Some(b)) = (sink.versions.lock().unwrap_or_else(|e| e.into_inner()).back().map(|v| v.block), io.copy2_head()) {
                    keeper_vs_c2.push(v as i64 - b as i64);
                }
            }
            CapEv::Moves(v) => {
                for (h, p) in v {
                    moves.insert(*h, p.clone());
                }
            }
            CapEv::Confirmed { seq, ctx, snap } => {
                n_conf += 1;
                first_block.get_or_insert(*seq);
                last_block = last_block.max(*seq);
                c2_lag.push(last_feed_seq.saturating_sub(*seq));
                snaps.insert(*seq, snap.clone());
                while snaps.len() > 128 {
                    let k = *snaps.keys().next().unwrap();
                    snaps.remove(&k);
                }
                io.set_copy2(*seq + l2_offset);
                // Live order: the keeper's version of this block first (if
                // it is already there), then copy 2's version.
                if let Some(kv) = sink.version_at(*seq + l2_offset) {
                    a.on_kept(kv);
                }
                let c = Confirmed { seq: *seq, snap: snap.clone(), ctx: ctx.clone(), diff: Arc::new(StateDiff::default()), prov: prov.clone() };
                a.on_confirmed(c, &|h| moves.get(h).cloned().flatten());
            }
            CapEv::Settled(st) => {
                n_settled += 1;
                let Some((pools, keys, _)) = a.pending_parts(st.seq) else { continue };
                let mut st = st.clone();
                let before = st.now.len();
                if let (Some(prev), Some(now)) = (snaps.get(&(st.seq.wrapping_sub(1))), snaps.get(&st.seq)) {
                    st.fill_from(&pools, keys.iter(), prev, now);
                }
                filled += (st.now.len() - before) as u64;
                if a.compare_settled(&st, &|h| moves.get(h).cloned().flatten()) {
                    settled_used += 1;
                }
            }
            CapEv::End { .. } => {}
        }
        keeper_turn(&mut a, &mut seen_pub);
    }
    let took_ms = t0.elapsed().as_millis() as u64;
    let run_s = t0.elapsed().as_secs_f64().max(0.001);
    let cpu_run = process_cpu_s() - cpu_run0;
    let kst = sink.status.lock().unwrap_or_else(|e| e.into_inner()).clone();
    sink.stop.store(true, Relaxed);
    let _ = kt.join();
    let (rss_peak, rss_now) = rss_kb();
    let all = a.collect_all.take().unwrap_or_default();
    let mut r = report(&a, &all, ReportInfo { n_feed, n_conf, n_settled, settled_used, filled, first_block, last_block, took_ms, complete: cap.complete, cut: cap.cut.clone(), live_start: "null".into(), live_end: None, l2_offset, budget_ms: Some(cfg_budget_ms(&a)) });
    if let Some((fails, unsure)) = &a.diag {
        let top = |m: &BTreeMap<String, u64>| {
            let mut v: Vec<(&String, &u64)> = m.iter().collect();
            v.sort_by(|x, y| y.1.cmp(x.1));
            v.into_iter().take(12).map(|(k, n)| json!({"what": k, "n": n})).collect::<Vec<_>>()
        };
        r["diag"] = json!({"failedRuns": top(fails), "unsurePools": top(unsure)});
    }
    let t = &a.total;
    let mut cpu = t.cpu_us.clone();
    let mut wall = t.apply_us.clone();
    let mut lf = late_feed_ms.clone();
    let mut lag = c2_lag.clone();
    let mut kv: Vec<u64> = keeper_vs_c2.iter().map(|x| (*x + 1000).max(0) as u64).collect();
    let kv_p = crate::timing::pct_of(&mut kv);
    let shift = |v: &Value| v.as_i64().map(|x| x - 1000);
    let calls_run = io.calls.load(Relaxed) - calls_pre;
    r["liveTiming"] = json!({
        "settings": settings,
        "blockMs": (block_ms * 10.0).round() / 10.0, "nodeMs": {"p50": lt.node_p50_ms, "p90": lt.node_p90_ms}, "nodeLagMs": lt.node_lag_ms,
        "warmValuesLearned": n_warm, "prerollSeededAfterS": seeded_after_s,
        "runSeconds": (run_s * 10.0).round() / 10.0,
        // The predicted copy kept up with the feed? (how late each feed
        // message was handled vs its live arrival time)
        "feedHandledLateMs": crate::timing::pct_of(&mut lf),
        "copy2BehindFeedBlocks": crate::timing::pct_of(&mut lag),
        "applyWallUs": crate::timing::pct_of(&mut wall), "applyCpuUs": crate::timing::pct_of(&mut cpu),
        "msgs": t.msgs, "applied": t.applied, "appliedPerMsg": if t.msgs > 0 { (100.0 * t.applied as f64 / t.msgs as f64).round() / 100.0 } else { 0.0 },
        "msgsStopped": t.msgs_stopped, "overBudget": t.over_budget, "tips": t.tips, "tipSharePct": if t.msgs > 0 { (1000.0 * t.tips as f64 / t.msgs as f64).round() / 10.0 } else { 0.0 },
        "keptBases": t.kept_bases, "keptMissing": t.kept_missing, "keptBasesPct": if t.kept_bases + t.kept_missing > 0 { (1000.0 * t.kept_bases as f64 / (t.kept_bases + t.kept_missing) as f64).round() / 10.0 } else { 0.0 },
        "keptRebases": t.kept_rebases, "keptSkipped": t.kept_skipped,
        "sure": {"right": t.agree, "wrong": t.disagree, "unsure": t.unsure, "rightKeptBase": t.right_kept, "wrongKeptBase": t.wrong_kept, "rightPlainBase": t.right_plain, "wrongPlainBase": t.wrong_plain},
        "blocksCompared": t.compared, "blocksUnpredicted": t.unpredicted,
        "keeper": {
            "resetsBeforeRun": resets_pre, "resetsEnd": kst["stats"]["resets"].clone(),
            "callsPerS": (calls_run as f64 / run_s * 10.0).round() / 10.0, "notYetTotal": io.not_yet.load(Relaxed),
            "aheadOfCopy2Blocks": {"p10": shift(&kv_p["p10"]), "p50": shift(&kv_p["p50"]), "p90": shift(&kv_p["p90"]), "min": shift(&kv_p["min"]), "n": kv_p["n"].clone()},
            "contracts": kst["contracts"].clone(), "accounts": kst["accounts"].clone(), "values": kst["values"].clone(), "candidates": kst["candidates"].clone(), "candidateValues": kst["candidateValues"].clone(),
            "seedsWaiting": kst["seedsWaiting"].clone(), "applyUs": kst["stats"]["applyUs"].clone(), "seedsSent": kst["stats"]["seedsSent"].clone(), "seedsDropped": kst["stats"]["seedsDropped"].clone(),
        },
        "cpuSecondsPerSecond": (cpu_run / run_s * 100.0).round() / 100.0,
        "memoryKb": {"beforeRun": rss0, "peak": rss_peak, "end": rss_now, "growthPeak": rss_peak.saturating_sub(rss0)},
        "cpuSecondsWarmAndPreroll": ((cpu_run0 - cpu0) * 10.0).round() / 10.0,
    });
    r["liveTiming"]["copy2DelayBlocks"] = json!(lt.copy2_delay_blocks);
    r["liveTiming"]["memoryRunKb"] = json!({"atStart": rss_run0, "maxDuringRun": rss_run_max, "growth": rss_run_max.saturating_sub(rss_run0)});
    Ok(r)
}

/// The capture's events in the order a live run with copy 2 `delay`
/// blocks behind the feed would see them: feed messages keep their order
/// and pace; everything else keeps its order too, but a copy-2 version of
/// block N (and whatever came after it) waits until the feed has reached
/// N + delay. None = the capture's own order.
pub fn live_order(evs: &[CapEv], delay: Option<u64>) -> Vec<&CapEv> {
    let Some(delay) = delay else { return evs.iter().collect() };
    let mut feeds: Vec<&CapEv> = Vec::new();
    // Other events with the feed sequence number they must wait for.
    let mut others: Vec<(u64, &CapEv)> = Vec::new();
    let mut need = 0u64;
    let mut last_feed = 0u64;
    for e in evs {
        match e {
            CapEv::Feed(m) => {
                last_feed = m.seq;
                feeds.push(e);
            }
            _ => {
                // Never earlier than in the capture; a version waits for
                // the feed to be `delay` past it; later ones wait behind it.
                need = need.max(last_feed);
                if let CapEv::Confirmed { seq, .. } = e {
                    need = need.max(seq + delay);
                }
                others.push((need, e));
            }
        }
    }
    let mut out: Vec<&CapEv> = Vec::with_capacity(evs.len());
    let (mut fi, mut oi) = (0usize, 0usize);
    let mut fed = 0u64;
    while fi < feeds.len() || oi < others.len() {
        if oi < others.len() && (others[oi].0 <= fed || fi >= feeds.len()) {
            out.push(others[oi].1);
            oi += 1;
        } else {
            if let CapEv::Feed(m) = feeds[fi] {
                fed = m.seq;
            }
            out.push(feeds[fi]);
            fi += 1;
        }
    }
    out
}

fn cfg_budget_ms(a: &Ahead) -> u64 {
    a.cfg().msg_budget_us / 1000
}

/// Whether the replay keeper starts warm (it was given values to learn first).
fn k_warm_flag(r: &super::keeper_replay::ReplayKeeper) -> bool {
    r.core.seeds_waiting() > 0 || r.core.held_counts().0 > 0
}

struct ReportInfo {
    n_feed: u64,
    n_conf: u64,
    n_settled: u64,
    settled_used: u64,
    filled: u64,
    first_block: Option<u64>,
    last_block: u64,
    took_ms: u64,
    complete: bool,
    cut: Option<String>,
    live_start: String,
    live_end: Option<String>,
    l2_offset: u64,
    budget_ms: Option<u64>,
}

/// Count a list of strings (most common first, at most `n`).
fn top(it: impl Iterator<Item = String>, n: usize) -> Vec<Value> {
    let mut m: HashMap<String, u64> = HashMap::new();
    for s in it {
        *m.entry(s).or_default() += 1;
    }
    let mut v: Vec<(String, u64)> = m.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    v.truncate(n);
    v.into_iter().map(|(k, c)| json!({"what": k, "n": c})).collect()
}

fn report(a: &Ahead, all: &[Value], i: ReportInfo) -> Value {
    let t = &a.total;
    let kinds = ["missedFilter", "missedRan", "missedReverted", "missedFailed", "missedUnknown", "missedOffRoute", "phantom", "value", "staleBase"];
    let by_kind: serde_json::Map<String, Value> = kinds.iter().map(|k| (k.to_string(), json!(all.iter().filter(|s| s["kind"] == *k).count()))).collect();
    let pct = |x: u64, n: u64| if n > 0 { json!((1000.0 * x as f64 / n as f64).round() / 10.0) } else { Value::Null };
    let why_of = |kind: &str| top(all.iter().filter(|s| s["kind"] == kind).map(|s| s["txWhy"].as_str().unwrap_or("(no reason recorded)").to_string()), 10);
    // Live counters over the captured stretch (end - start), where known.
    let live = match (serde_json::from_str::<Value>(&i.live_start), i.live_end.as_deref().and_then(|e| serde_json::from_str::<Value>(e).ok())) {
        (Ok(s), Some(e)) => {
            let keys = ["msgs", "applied", "txsRun", "txsFailed", "agree", "disagree", "missed", "missedRan", "missedFailed", "missedReverted", "missedFilter", "unsure", "compared", "unpredicted", "msgsStopped", "overBudget", "staleBase", "baseLate", "rebaseRewrites"];
            let m: serde_json::Map<String, Value> = keys.iter().map(|k| (k.to_string(), json!(e[*k].as_u64().unwrap_or(0).saturating_sub(s[*k].as_u64().unwrap_or(0))))).collect();
            Value::Object(m)
        }
        _ => Value::Null,
    };
    let mut times = t.apply_us.clone();
    let ahead_blocks = {
        let mut b = t.ahead_blocks.clone();
        let mean = if b.is_empty() { 0.0 } else { b.iter().sum::<u64>() as f64 / b.len() as f64 };
        let mut v = crate::timing::pct_of(&mut b);
        v["mean"] = json!((mean * 100.0).round() / 100.0);
        v
    };
    json!({
        "capture": {
            "complete": i.complete, "cut": i.cut, "feedMessages": i.n_feed, "versions": i.n_conf, "settledRecords": i.n_settled,
            "blocks": i.first_block.map(|f| json!({"from": f + i.l2_offset, "to": i.last_block + i.l2_offset})),
        },
        "replay": {
            "tookMs": i.took_ms, "budgetMs": i.budget_ms, "comparedBlocks": i.settled_used,
            "valuesFromVersions": i.filled,
            "applyUsThisMachine": crate::timing::pct_of(&mut times),
        },
        "agreement": {
            "pct": t.agreement_pct().map(|p| (p * 10.0).round() / 10.0), "agree": t.agree, "disagree": t.disagree,
            "unsure": t.unsure, "notFromTx": t.not_from_tx, "confGone": t.conf_gone, "notCaptured": t.not_captured,
            "compared": t.compared, "unpredicted": t.unpredicted, "baseLate": t.base_late,
        },
        "disagreements": {
            "byKind": by_kind,
            "byKindPct": kinds.iter().map(|k| (k.to_string(), pct(all.iter().filter(|s| s["kind"] == *k).count() as u64, t.disagree))).collect::<serde_json::Map<String, Value>>(),
            "missedFailedWhy": why_of("missedFailed"),
            "missedRevertedWhy": why_of("missedReverted"),
            "topTargets": top(all.iter().filter_map(|s| s["txTo"].as_str().map(|x| format!("{x} ({})", s["kind"].as_str().unwrap_or("")))), 10),
            "topPools": top(all.iter().filter_map(|s| s["pool"].as_str().map(|x| x.to_string())), 10),
        },
        "prediction": {
            "msgs": t.msgs, "applied": t.applied, "txsRun": t.txs_run, "txsSkipped": t.txs_skipped, "txsFailed": t.txs_failed,
            "txsOffRoute": t.txs_off_route, "failedUnknown": t.failed_unknown, "failedWidened": t.failed_widened, "probesSkipped": t.probes_skipped, "revertsMarked": t.reverts_marked, "revertsKept": t.reverts_kept, "revertUnsure": a.cfg().revert_unsure, "trustSenderFunds": a.cfg().trust_sender_funds,
            "filterMissed": t.filter_missed, "rebases": t.rebases, "rebaseRewrites": t.rebase_rewrites,
            "unknownContinue": a.cfg().unknown_continue, "unknownContinued": t.unknown_continued, "missedUnknown": t.missed_unknown,
            // How many blocks the tip was ahead of copy 2, per feed message
            // (0 = no tip), and the messages that left a tip.
            "tips": t.tips, "aheadBlocks": ahead_blocks,
            "stopped": t.stopped.iter().map(|(k, v)| (k.to_string(), json!(v))).collect::<serde_json::Map<String, Value>>(),
        },
        "liveSameStretch": live,
        "samples": all,
    })
}

/// The plain-English printout of a replay report (`samples`: how many).
pub fn print_report(r: &Value, samples: usize) -> String {
    let mut o = String::new();
    let c = &r["capture"];
    let g = &r["agreement"];
    let d = &r["disagreements"];
    let p = &r["prediction"];
    let n = |v: &Value| v.as_u64().unwrap_or(0);
    o += &format!(
        "capture: blocks {} .. {} ({} versions, {} feed messages){}{}\n",
        c["blocks"]["from"], c["blocks"]["to"], c["versions"], c["feedMessages"],
        if c["complete"].as_bool() == Some(true) { "" } else { " [INCOMPLETE]" },
        c["cut"].as_str().map(|x| format!(" ({x})")).unwrap_or_default()
    );
    o += &format!(
        "replay: {} ms, {} blocks compared, per-message budget {}; apply us on THIS machine p50 {} p90 {} p99 {} max {}\n",
        r["replay"]["tookMs"], r["replay"]["comparedBlocks"],
        r["replay"]["budgetMs"].as_u64().map(|b| format!("{b} ms")).unwrap_or_else(|| "off".into()),
        r["replay"]["applyUsThisMachine"]["p50"], r["replay"]["applyUsThisMachine"]["p90"], r["replay"]["applyUsThisMachine"]["p99"], r["replay"]["applyUsThisMachine"]["max"]
    );
    o += &format!(
        "AGREEMENT (pools we were sure of): {}%  agree {}  disagree {}   | unsure {}  not from a tx {}  copy 2 holds nothing {}  not captured {}  blocks unpredicted {}  base corrected later {}\n",
        g["pct"].as_f64().map(|x| format!("{x:.1}")).unwrap_or_else(|| "n/a".into()),
        g["agree"], g["disagree"], g["unsure"], g["notFromTx"], g["confGone"], g["notCaptured"], g["unpredicted"], g["baseLate"]
    );
    o += "disagreements by cause:\n";
    let expl = [
        ("missedFilter", "the cheap filter skipped the transaction that moved it"),
        ("missedRan", "we ran it, our run succeeded but did not move this pool"),
        ("missedReverted", "we ran it, our run REVERTED (it succeeded on chain)"),
        ("missedFailed", "we could not run it and did not mark this pool unsure"),
        ("missedUnknown", "we could not run it, nothing tied it to our pools, we predicted past it: it moved this one"),
        ("missedOffRoute", "not run (named only off-route pools) yet it moved this one"),
        ("phantom", "we moved it, the chain did not"),
        ("value", "both moved it, to different values"),
        ("staleBase", "the block we predicted on was corrected later (late reports)"),
    ];
    for (k, what) in expl {
        let c = n(&d["byKind"][k]);
        if c > 0 {
            o += &format!("  {k:<15} {c:>6}  ({}%)  {what}\n", d["byKindPct"][k]);
        }
    }
    for (k, title) in [("missedFailedWhy", "why those runs failed"), ("missedRevertedWhy", "why those runs reverted")] {
        if let Some(v) = d[k].as_array().filter(|v| !v.is_empty()) {
            o += &format!("{title}:\n");
            for x in v {
                o += &format!("  {:>6}  {}\n", x["n"], x["what"].as_str().unwrap_or(""));
            }
        }
    }
    if let Some(v) = d["topTargets"].as_array().filter(|v| !v.is_empty()) {
        o += "commonest targets behind disagreements:\n";
        for x in v {
            o += &format!("  {:>6}  {}\n", x["n"], x["what"].as_str().unwrap_or(""));
        }
    }
    o += &format!(
        "prediction (revert unsure {}, sender funds {}): messages {} applied {} | txs run {} skipped {} failed {} off-route {} (nothing found {}, widened {}) | reverted runs marked unsure {} kept {} | routers missed by the filter {} | rebases {} (on late reports {}) | stopped {}\n",
        if p["revertUnsure"].as_bool() == Some(false) { "off" } else { "on" },
        if p["trustSenderFunds"].as_bool() == Some(true) { "trusted" } else { "strict" },
        p["msgs"], p["applied"], p["txsRun"], p["txsSkipped"], p["txsFailed"], p["txsOffRoute"], p["failedUnknown"], p["failedWidened"], p["revertsMarked"], p["revertsKept"], p["filterMissed"], p["rebases"], p["rebaseRewrites"], p["stopped"]
    );
    o += &format!(
        "unknown-effect txs (could not run, nothing ties them to our pools): {} ({} predicted past, {} pools they moved = missedUnknown) | tips {} of {} messages; blocks ahead of copy 2 per message p50 {} p90 {} mean {}\n",
        if p["unknownContinue"].as_bool() == Some(true) { "predicted past" } else { "stop the prediction" },
        p["unknownContinued"], p["missedUnknown"], p["tips"], p["msgs"],
        p["aheadBlocks"]["p50"], p["aheadBlocks"]["p90"], p["aheadBlocks"]["mean"]
    );
    if r["keeper"].is_object() {
        let k = &r["keeper"];
        o += &format!(
            "KEEPER ({}): blocks followed {} (missing {}) | node calls: diffs {} seeds {} = {}/s (diffs {}/s) | held now: {} contracts, {} values | audit of every held value vs the chain: ok {} WRONG {} unknown {} | bases merged {} not merged {} (values added {}) keeper rebases {} learned {} | seed values unknown {} | apply us p50 {} p90 {} max {} (this machine)\n",
            if k["warmStart"].as_bool() == Some(true) { format!("warm start: {} learned values from a first pass seeded at the start", k["warmValues"]) } else { "cold start".to_string() },
            k["blocksFollowed"], k["missingBlocks"], k["calls"]["diffs"], k["calls"]["seeds"], k["calls"]["perS"], k["calls"]["diffsPerS"],
            k["held"]["contracts"], k["held"]["values"], k["audit"]["ok"], k["audit"]["bad"], k["audit"]["unknown"],
            k["bases"]["merged"], k["bases"]["notMerged"], k["bases"]["valuesAdded"], k["bases"]["keeperRebases"], k["bases"]["learned"],
            k["seedValuesUnknown"], k["applyUsThisMachine"]["p50"], k["applyUsThisMachine"]["p90"], k["applyUsThisMachine"]["max"]
        );
        if let Some(v) = k["audit"]["samples"].as_array().filter(|v| !v.is_empty()) {
            for x in v.iter().take(5) {
                o += &format!("  audit WRONG: {x}\n");
            }
        }
    }
    for (k, title) in [("failedRuns", "why runs failed (all of them)"), ("unsurePools", "what made compared pools unsure")] {
        if let Some(v) = r["diag"][k].as_array().filter(|v| !v.is_empty()) {
            o += &format!("{title}:\n");
            for x in v {
                o += &format!("  {:>6}  {}\n", x["n"], x["what"].as_str().unwrap_or(""));
            }
        }
    }
    if let Some(v) = r["oracle"]["revertCauses"].as_array().filter(|v| !v.is_empty()) {
        o += "ORACLE: our runs vs the chain's exact starting state (distinct txs / runs / pools):\n";
        for x in v {
            o += &format!("  {:>4} {:>5} {:>6}  {}\n", x["txs"], x["runs"], x["pools"], x["what"].as_str().unwrap_or(""));
        }
        if let Some(v) = r["oracle"]["revertSplit"].as_array() {
            o += "ORACLE: reverted runs by what we knew (distinct txs):\n";
            for x in v.iter().take(30) {
                o += &format!("  {:>4}  {}\n", x["txs"], x["what"].as_str().unwrap_or(""));
            }
        }
    }
    if r["liveSameStretch"].is_object() {
        let l = &r["liveSameStretch"];
        o += &format!(
            "live, same stretch: agree {} disagree {} (missed {}: ran {} reverted {} failed {} filter {}) unsure {} compared {} unpredicted {} msgs {} stopped {} over budget {}\n",
            l["agree"], l["disagree"], l["missed"], l["missedRan"], l["missedReverted"], l["missedFailed"], l["missedFilter"], l["unsure"], l["compared"], l["unpredicted"], l["msgs"], l["msgsStopped"], l["overBudget"]
        );
    }
    if samples > 0 {
        if let Some(v) = r["samples"].as_array().filter(|v| !v.is_empty()) {
            o += &format!("first {} of {} disagreement samples:\n", samples.min(v.len()), v.len());
            for s in v.iter().take(samples) {
                o += &format!("  {s}\n");
            }
        }
    }
    o
}

/// `arbsim ahead-replay <capture file> [--json] [--samples N] [--budget-ms N] [--partial] [--revert-sure] [--sender-funds trusted|strict] [--unknown-continue] [--keeper <truth file> [--keeper-warm [--keeper-warm-passes N]] [--keep-contracts N] [--keep-seeds-per-h N] [--keep-prune-blocks N] [--oracle]] [--filter-all] [--no-keep-pick]`
pub fn replay_main(args: &[String]) {
    let Some(path) = args.get(2).filter(|a| !a.starts_with("--")) else {
        eprintln!("usage: arbsim ahead-replay <capture file> [--json] [--samples N] [--budget-ms N] [--partial] [--revert-sure] [--sender-funds trusted|strict] [--unknown-continue] [--keeper <truth file> [--keeper-warm [--keeper-warm-passes N]] [--keep-contracts N] [--keep-seeds-per-h N] [--keep-prune-blocks N] [--oracle]] [--filter-all] [--no-keep-pick]");
        std::process::exit(2);
    };
    let arg = |f: &str| args.iter().position(|a| a == f).and_then(|i| args.get(i + 1)).and_then(|v| v.parse::<u64>().ok());
    let cap = match read_capture(path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("arbsim ahead-replay: {e}");
            std::process::exit(2);
        }
    };
    if !cap.complete && !args.iter().any(|a| a == "--partial") {
        eprintln!("arbsim ahead-replay: the capture is incomplete ({}); add --partial to replay what is there", cap.cut.as_deref().unwrap_or("no end record"));
        std::process::exit(2);
    }
    let sender_funds = args.iter().position(|a| a == "--sender-funds").and_then(|i| args.get(i + 1)).map(|v| v.as_str());
    let trust_sender_funds = match sender_funds {
        None => None,
        Some("trusted") => Some(true),
        Some("strict") => Some(false),
        Some(v) => {
            eprintln!("arbsim ahead-replay: --sender-funds takes trusted or strict, not {v}");
            std::process::exit(2);
        }
    };
    let opts = ReplayOpts {
        budget_ms: arg("--budget-ms"),
        revert_unsure: args.iter().any(|a| a == "--revert-sure").then_some(false),
        trust_sender_funds,
        unknown_continue: args.iter().any(|a| a == "--unknown-continue"),
        oracle: args.iter().any(|a| a == "--oracle"),
        filter_all: args.iter().any(|a| a == "--filter-all"),
        no_keep_pick: args.iter().any(|a| a == "--no-keep-pick"),
    };
    // KEEPER (Oct 31): --keeper <truth file> [--keeper-warm [--keeper-warm-passes N]] [--keep-contracts N]
    // [--keep-seeds-per-h N]: the hot-contract keeper on recorded block diffs.
    let keeper_file = args.iter().position(|a| a == "--keeper").and_then(|i| args.get(i + 1)).cloned();
    // LIVE TIMING (Oct 31 night): --live-timing [--new] [--env K=V ...]
    // [--block-ms N] [--node-ms P50,P90] [--node-lag-ms N] [--preroll-s N]
    // [--keeper-warm-passes N] [--keep-contracts N] (needs --keeper).
    if args.iter().any(|a| a == "--live-timing") {
        let Some(f) = keeper_file.clone() else {
            eprintln!("arbsim ahead-replay: --live-timing needs --keeper <truth file>");
            std::process::exit(2);
        };
        let truth = match super::keeper_replay::Truth::load(&f) {
            Ok(t) => Arc::new(t),
            Err(e) => {
                eprintln!("arbsim ahead-replay: --keeper {e}");
                std::process::exit(2);
            }
        };
        let mut env: HashMap<String, String> = HashMap::new();
        if args.iter().any(|a| a == "--new") {
            env.insert("FASTLANE_AHEAD".into(), "observe".into());
        } else {
            // The old runtime: every live-speed setting at its old value.
            for (k, v) in [("FASTLANE_AHEAD", "observe"), ("FASTLANE_AHEAD_KEEP_FETCH_PAR", "1"), ("FASTLANE_AHEAD_KEEP_SEED_PAR", "0"), ("FASTLANE_AHEAD_KEEP_LEAD", "off"), ("FASTLANE_AHEAD_KEEP_CAND_SLOTS", "2000"), ("FASTLANE_AHEAD_BUDGET_CLOCK", "wall"), ("FASTLANE_AHEAD_LAZY_REBASE", "off"), ("FASTLANE_AHEAD_KEPT_REBUILD", "every"), ("FASTLANE_AHEAD_NEED_KEEPER", "off")] {
                env.insert(k.into(), v.into());
            }
        }
        env.insert("FASTLANE_AHEAD_KEEP_CONTRACTS".into(), arg("--keep-contracts").unwrap_or(300).to_string());
        for (i, a) in args.iter().enumerate() {
            if a == "--env" {
                if let Some((k, v)) = args.get(i + 1).and_then(|x| x.split_once('=')) {
                    env.insert(k.to_string(), v.to_string());
                }
            }
        }
        let node = args.iter().position(|a| a == "--node-ms").and_then(|i| args.get(i + 1)).and_then(|v| v.split_once(',')).and_then(|(a, b)| Some((a.parse::<u64>().ok()?, b.parse::<u64>().ok()?))).unwrap_or((31, 60));
        let lt = LiveTiming {
            block_ms: args.iter().position(|a| a == "--block-ms").and_then(|i| args.get(i + 1)).and_then(|v| v.parse::<f64>().ok()),
            node_p50_ms: node.0,
            node_p90_ms: node.1,
            node_lag_ms: arg("--node-lag-ms").unwrap_or(100),
            env,
            preroll_s: arg("--preroll-s").unwrap_or(60),
            warm_passes: arg("--keeper-warm-passes").unwrap_or(2).clamp(0, 10) as usize,
            copy2_delay_blocks: arg("--copy2-delay-blocks"),
        };
        match replay_live(&cap, &opts, truth, &lt) {
            Ok(r) => {
                if args.iter().any(|a| a == "--json") {
                    println!("{r}");
                } else {
                    println!("{}", serde_json::to_string_pretty(&r["liveTiming"]).unwrap_or_default());
                    print!("{}", print_report(&r, arg("--samples").unwrap_or(5) as usize));
                }
            }
            Err(e) => {
                eprintln!("arbsim ahead-replay: {e}");
                std::process::exit(2);
            }
        }
        return;
    }
    let result = match keeper_file {
        None => replay(&cap, &opts),
        Some(f) => {
            let truth = match super::keeper_replay::Truth::load(&f) {
                Ok(t) => Arc::new(t),
                Err(e) => {
                    eprintln!("arbsim ahead-replay: --keeper {e}");
                    std::process::exit(2);
                }
            };
            let mut kc = super::keeper::KeeperCfg { on: true, ..Default::default() };
            if let Some(n) = arg("--keep-contracts") {
                kc.max_contracts = n.clamp(1, 1000) as usize;
            }
            if let Some(n) = arg("--keep-seeds-per-h") {
                kc.seeds_per_hour = n;
            }
            // Memory fix (Nov 1): replay with the keeper's pruning on
            // (FASTLANE_AHEAD_KEEP_PRUNE_BLOCKS; off unless given), to show
            // what it does to accuracy.
            if let Some(n) = arg("--keep-prune-blocks") {
                kc.prune_blocks = n;
            }
            let passes = if args.iter().any(|a| a == "--keeper-warm") { arg("--keeper-warm-passes").unwrap_or(1).clamp(1, 10) as usize } else { 0 };
            replay_keeper(&cap, &opts, truth, kc, passes)
        }
    };
    match result {
        Ok(r) => {
            if args.iter().any(|a| a == "--json") {
                println!("{r}");
            } else {
                print!("{}", print_report(&r, arg("--samples").unwrap_or(10) as usize));
            }
        }
        Err(e) => {
            eprintln!("arbsim ahead-replay: {e}");
            std::process::exit(2);
        }
    }
}

// ---------------------------------------------------------------------------
// Live side: the predicted copy's thread drives a capture through this
// ---------------------------------------------------------------------------

/// The capture as the predicted copy's thread runs it (copy2/ahead.rs
/// run_loop): when to start, what was written last, when to stop.
pub struct LiveCapture {
    pub cfg: CapCfg,
    started: Instant,
    pub cap: Option<Capture>,
    done: bool,
    blocks: u64,
    last_seq: Option<u64>,
    last_prov: Option<Arc<ProvSets>>,
    /// Every captured block waiting for its settled-values record.
    pub to_settle: std::collections::VecDeque<u64>,
    /// Blocks whose settled values were already written (compared by the
    /// predicted copy itself).
    pub written: HashSet<u64>,
}

impl LiveCapture {
    pub fn new(cfg: CapCfg) -> LiveCapture {
        LiveCapture { cfg, started: Instant::now(), cap: None, done: false, blocks: 0, last_seq: None, last_prov: None, to_settle: Default::default(), written: HashSet::new() }
    }

    /// Is it time to start (once per arbsim start)?
    pub fn should_start(&self) -> bool {
        self.cap.is_none() && !self.done && self.started.elapsed() >= self.cfg.after
    }

    /// Start: settings, pools, routes, learned routers, held feed messages.
    pub fn begin(&mut self, a: &Ahead, list: &[(FollowedPool, Address, Address)], not_ready: &[String], routes: Option<Vec<String>>) {
        self.done = true; // once, whatever happens
        match Capture::start(&self.cfg.path, self.cfg.max_bytes) {
            Ok(mut c) => {
                eprintln!("[arbsim] fastlane capture: started ({} blocks, at most {} MB)", self.cfg.blocks, self.cfg.max_bytes / (1024 * 1024));
                let ok = c.send(CapEv::Header { cfg: a.cfg().clone(), l2_offset: a.cfg().l2_offset, live: a.total.json_with(false).to_string() })
                    && c.send(CapEv::Pools { list: list.to_vec(), not_ready: not_ready.to_vec() })
                    && c.send(CapEv::Routes(routes))
                    && c.send(CapEv::Touchers(a.touchers_list()))
                    && a.held().into_iter().all(|m| c.send(CapEv::Feed(m)));
                self.cap = Some(c);
                if !ok {
                    self.stop(a, "could not hand the start over to the writer");
                }
                // Fire-first replay (fastlane/trig_replay.rs): the bot's
                // candidate table as it is now, next to the capture
                // (<file>.table.json), so `arbsim trig-replay` can pick and
                // check candidates offline. No table = no file (the replay
                // then measures discovery only).
                if let Some(t) = crate::check::entry::table_message() {
                    let p = format!("{}.table.json", self.cfg.path);
                    match std::fs::write(&p, t.to_string()) {
                        Ok(()) => eprintln!("[arbsim] fastlane capture: candidate table written to {p}"),
                        Err(e) => eprintln!("[arbsim] fastlane capture: could not write the candidate table ({e})"),
                    }
                }
            }
            Err(e) => eprintln!("[arbsim] fastlane capture: could not create the file ({e}); no capture"),
        }
    }

    pub fn on(&self) -> bool {
        self.cap.is_some()
    }

    /// Hand one event over; a broken capture is stopped.
    pub fn send(&mut self, a: &Ahead, ev: CapEv) {
        if let Some(c) = &mut self.cap {
            if !c.send(ev) {
                self.stop(a, "writer stopped");
            }
        }
    }

    /// Copy 2's exact-values sets for the next version (written when they change).
    pub fn prov(&mut self, a: &Ahead, p: &super::intake::Copy2Prov) {
        if self.cap.is_none() {
            return;
        }
        let sets = ProvSets::from_copy2(p);
        if self.last_prov.as_deref() != Some(&sets) {
            let s = Arc::new(sets);
            self.last_prov = Some(s.clone());
            self.send(a, CapEv::Prov(s));
        }
    }

    /// A version handed to the predicted copy (after it was handed).
    pub fn confirmed(&mut self, a: &Ahead, moves: Vec<(B256, Option<Vec<String>>)>, seq: u64, ctx: Option<BlockCtx>, snap: Arc<Snapshot>) {
        if self.cap.is_none() {
            return;
        }
        if !moves.is_empty() {
            self.send(a, CapEv::Moves(moves));
        }
        self.send(a, CapEv::Confirmed { seq, ctx, snap });
        if self.last_seq.is_none_or(|l| seq > l) {
            // Only blocks right after the previous one can be compared.
            if self.last_seq == Some(seq.wrapping_sub(1)) {
                self.to_settle.push_back(seq);
            }
            self.last_seq = Some(seq);
            self.blocks += 1;
        }
        // Enough blocks, plus the compare delay so the last ones are compared.
        if self.blocks >= self.cfg.blocks + a.cfg().compare_delay + 2 {
            self.stop(a, "done");
        }
    }

    /// Stop (and close) the capture, with a log line.
    pub fn stop(&mut self, a: &Ahead, why: &str) {
        if let Some(c) = self.cap.take() {
            let s = c.finish(a.total.json_with(false).to_string(), why);
            if s.complete {
                eprintln!("[arbsim] fastlane capture: done, {} blocks, {} records, {} MB in {} (replay: arbsim ahead-replay {})", s.blocks, s.records, s.bytes / (1024 * 1024), s.path, s.path);
            } else {
                eprintln!("[arbsim] fastlane capture: STOPPED EARLY ({}), {} blocks, {} MB kept in {} (replay with --partial)", s.why, s.blocks, s.bytes / (1024 * 1024), s.path);
            }
        }
        self.to_settle.clear();
        self.written.clear();
    }
}
