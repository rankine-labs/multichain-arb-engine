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
//   [--budget-ms N] [--partial]`
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
        ProvSets { all: false, accts: p.accts.clone(), pms: p.pms.clone(), slots: p.slots.clone() }
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
}

/// Replay a capture through a fresh predicted copy. Returns the report
/// (JSON; see `print_report`).
pub fn replay(cap: &CapFile, opts: &ReplayOpts) -> Result<Value, String> {
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
    let mut a = Ahead::new(cfg);
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
    Ok(report(&a, &all, ReportInfo { n_feed, n_conf, n_settled, settled_used, filled, first_block, last_block, took_ms, complete: cap.complete, cut: cap.cut.clone(), live_start, live_end, l2_offset, budget_ms: opts.budget_ms }))
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
    let kinds = ["missedFilter", "missedRan", "missedReverted", "missedFailed", "missedOffRoute", "phantom", "value", "staleBase"];
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
            "txsOffRoute": t.txs_off_route, "failedUnknown": t.failed_unknown, "failedWidened": t.failed_widened, "probesSkipped": t.probes_skipped,
            "filterMissed": t.filter_missed, "rebases": t.rebases, "rebaseRewrites": t.rebase_rewrites,
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
        "prediction: messages {} applied {} | txs run {} skipped {} failed {} off-route {} (nothing found {}, widened {}) | routers missed by the filter {} | rebases {} (on late reports {}) | stopped {}\n",
        p["msgs"], p["applied"], p["txsRun"], p["txsSkipped"], p["txsFailed"], p["txsOffRoute"], p["failedUnknown"], p["failedWidened"], p["filterMissed"], p["rebases"], p["rebaseRewrites"], p["stopped"]
    );
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

/// `arbsim ahead-replay <capture file> [--json] [--samples N] [--budget-ms N] [--partial]`
pub fn replay_main(args: &[String]) {
    let Some(path) = args.get(2).filter(|a| !a.starts_with("--")) else {
        eprintln!("usage: arbsim ahead-replay <capture file> [--json] [--samples N] [--budget-ms N] [--partial]");
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
    let opts = ReplayOpts { budget_ms: arg("--budget-ms") };
    match replay(&cap, &opts) {
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
