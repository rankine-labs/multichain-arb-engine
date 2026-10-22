// ============================================================================
// COPY 2 WARM RESTART: the copy saved to a file, and read back at start.
//
// Plain English:
//   Before this, every restart of the sidecar (a deploy, pm2, a crash) threw
//   the copy away and loaded ~650 pools again from the node: ~13 minutes to
//   fully ready, thousands of node requests, and the reload burst itself
//   caused bugs. Now:
//     1. SAVE. Every ARBSIM_COPY2_SAVE_S (60) seconds, and once more when the
//        sidecar is told to stop (SIGTERM / SIGINT from pm2), the READY pools'
//        state is written to ARBSIM_COPY2_STATE_FILE (the runner sets
//        <bot folder>/data/arbsim-copy2-state.bin). Written to a temporary
//        file first and then renamed over the old one, so a crash mid-write
//        never leaves a half file (the old one stays).
//        The intake thread only takes a cheap copy (the snapshot's maps are
//        persistent: a pointer copy; the pool list is cloned); the writing
//        happens on a separate thread, so block application never waits.
//     2. WHAT is saved: the block the copy is exact at, every value the copy
//        holds at that block (pool slots, walked tick data, coin balances,
//        account basics, contract code), the "never trust" lists, every
//        ready pool's bookkeeping (what it holds, its walk, far-zero words,
//        where its values came from), coin balance layouts, and the reports
//        of the last ARBSIM_COPY2_RESUME_OVERLAP_BLOCKS blocks (to recognise
//        reports we already had). Pools that are NOT ready are left out
//        (with their values): they load normally.
//     3. READ at start (copy2/intake.rs restore + catch-up): the file is
//        refused if its format version differs, its checksum fails, or
//        anything in it doesn't parse: then the normal full load runs.
//        Otherwise the copy starts AT the saved block with every saved pool
//        ready, and before anything is answered it catches up from the
//        node's logs (see intake.rs "warm restart").
//
//   STRICT, as everywhere: the file only ever holds values that were exact
//   at its block. Anything we can't bring forward exactly is reloaded.
//
//   FORMAT VERSION: bump FORMAT whenever what the copy holds, or what a
//   field means, changes (a newer sidecar then refuses an older file and
//   loads normally, instead of trusting values it would hold differently).
// ============================================================================
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufWriter, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use revm::primitives::{keccak256, Address, Bytes, B256, U256, KECCAK_EMPTY};
use revm::state::{AccountInfo, Bytecode};

use super::coins::BalanceLayout;
use super::intake::{FarZero, PoolEntry, PoolState, WalkInfo};
use super::{BlockCtx as ReplayCtx, PoolKind, PoolLog, TrackedPool};
use crate::state::snap::{Acct, Basics, PMap, Snapshot};

/// File format version. Bump on ANY change of meaning (see header).
pub const FORMAT: u32 = 1;
const MAGIC: &[u8; 16] = b"ARBSIM-COPY2-ST\0";

/// Position of a report: (block, tx index, log index).
pub type Pos = (u64, u32, u32);

/// Everything saved (and read back). `snap` holds the copy's values at
/// `block`; on save, `strip` lists values left out (pools not saved).
pub struct State {
    pub block: u64,
    /// The saved block's details (time, parent-chain block, base fee), if
    /// known: the next block's fallback for those (never answers checks).
    pub ctx: Option<(u64, u64, u64)>,
    /// Wall clock of the save (ms since 1970), for the log line.
    pub saved_ms: u64,
    pub snap: Arc<Snapshot>,
    pub strip: HashSet<(Address, U256)>,
    pub volatile_whole: Vec<Address>,
    pub volatile_balance: Vec<Address>,
    /// Ready pools with the position of the last report applied to each.
    pub pools: Vec<(PoolEntry, Option<Pos>)>,
    pub layouts: Vec<(Address, BalanceLayout)>,
    pub pair_slots: Vec<((Address, Address), U256)>,
    pub per_pool_coins: Vec<Address>,
    pub coin_ok: Vec<Address>,
    /// Followed coin balances (coin, holder): last report applied, node read block.
    pub coins: Vec<((Address, Address), Option<Pos>, Option<u64>)>,
    /// The last blocks' reports (block, its details, reports).
    pub buf: Vec<(u64, ReplayCtx, Arc<Vec<PoolLog>>)>,
}

/// What a save wrote (status / log).
#[derive(Clone, Debug, Default)]
pub struct SaveReport {
    pub block: u64,
    pub bytes: u64,
    pub pools: usize,
    pub accounts: usize,
    pub slots: usize,
    pub codes: usize,
    /// Time spent serializing + writing (the saver thread).
    pub write_ms: f64,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Stop signal (SIGTERM / SIGINT): only sets a flag; serve.rs watches it,
// asks copy 2 for a final save, then exits.
// ---------------------------------------------------------------------------
pub static STOP: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_sig: libc::c_int) {
    // Only an atomic store: safe inside a signal handler.
    STOP.store(true, Ordering::SeqCst);
}

/// Catch SIGTERM and SIGINT (pm2 stop / restart / reload) instead of dying
/// at once, so the copy can be saved first.
pub fn install_stop_handlers() {
    // SAFETY: the handler only performs an atomic store (async-signal-safe).
    unsafe {
        libc::signal(libc::SIGTERM, on_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, on_signal as *const () as libc::sighandler_t);
    }
}

// ---------------------------------------------------------------------------
// Writer with a running checksum (64-bit FNV-1a over every byte written)
// ---------------------------------------------------------------------------
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn fnv(mut h: u64, b: &[u8]) -> u64 {
    for x in b {
        h ^= *x as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

struct W<T: Write> {
    w: T,
    h: u64,
    n: u64,
}

impl<T: Write> W<T> {
    fn raw(&mut self, b: &[u8]) -> std::io::Result<()> {
        self.h = fnv(self.h, b);
        self.n += b.len() as u64;
        self.w.write_all(b)
    }
    fn u8(&mut self, v: u8) -> std::io::Result<()> {
        self.raw(&[v])
    }
    fn u32(&mut self, v: u32) -> std::io::Result<()> {
        self.raw(&v.to_le_bytes())
    }
    fn u64(&mut self, v: u64) -> std::io::Result<()> {
        self.raw(&v.to_le_bytes())
    }
    fn i64(&mut self, v: i64) -> std::io::Result<()> {
        self.raw(&v.to_le_bytes())
    }
    fn len(&mut self, n: usize) -> std::io::Result<()> {
        self.u32(u32::try_from(n).map_err(|_| std::io::Error::other("list too long"))?)
    }
    fn addr(&mut self, a: &Address) -> std::io::Result<()> {
        self.raw(a.as_slice())
    }
    fn b256(&mut self, b: &B256) -> std::io::Result<()> {
        self.raw(b.as_slice())
    }
    fn u256(&mut self, v: &U256) -> std::io::Result<()> {
        self.raw(&v.to_be_bytes::<32>())
    }
    fn bytes(&mut self, b: &[u8]) -> std::io::Result<()> {
        self.len(b.len())?;
        self.raw(b)
    }
    fn opt_pos(&mut self, p: Option<Pos>) -> std::io::Result<()> {
        match p {
            Some((b, t, l)) => {
                self.u8(1)?;
                self.u64(b)?;
                self.u32(t)?;
                self.u32(l)
            }
            None => self.u8(0),
        }
    }
}

// ---------------------------------------------------------------------------
// Reader (whole file in memory; every read checks the length)
// ---------------------------------------------------------------------------
struct R<'a> {
    b: &'a [u8],
    i: usize,
}

type Res<T> = Result<T, String>;

impl<'a> R<'a> {
    fn take(&mut self, n: usize) -> Res<&'a [u8]> {
        if self.b.len() - self.i < n {
            return Err(format!("file ends early (at byte {})", self.i));
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
    fn i64(&mut self) -> Res<i64> {
        Ok(i64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    /// A list length, sanity-checked against what is left of the file
    /// (each entry is at least `min` bytes): a corrupt length can't make us
    /// allocate gigabytes.
    fn len(&mut self, min: usize) -> Res<usize> {
        let n = self.u32()? as usize;
        if n.saturating_mul(min.max(1)) > self.b.len() - self.i {
            return Err(format!("list of {n} entries can't fit in the file (at byte {})", self.i));
        }
        Ok(n)
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
    fn bool(&mut self) -> Res<bool> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            x => Err(format!("bad flag {x} (at byte {})", self.i - 1)),
        }
    }
    fn opt_pos(&mut self) -> Res<Option<Pos>> {
        Ok(if self.bool()? { Some((self.u64()?, self.u32()?, self.u32()?)) } else { None })
    }
}

fn kind_code(k: PoolKind) -> u8 {
    match k {
        PoolKind::V2 => 0,
        PoolKind::Solidly => 1,
        PoolKind::V3 => 2,
        PoolKind::PancakeV3 => 3,
        PoolKind::Algebra => 4,
        PoolKind::V4 => 5,
    }
}

fn kind_of(c: u8) -> Res<PoolKind> {
    Ok(match c {
        0 => PoolKind::V2,
        1 => PoolKind::Solidly,
        2 => PoolKind::V3,
        3 => PoolKind::PancakeV3,
        4 => PoolKind::Algebra,
        5 => PoolKind::V4,
        x => return Err(format!("unknown pool kind {x}")),
    })
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------
/// Serialize `st` into `out` (the checksum trailer included). Returns the
/// counts for the report.
fn encode<T: Write>(st: &State, out: T) -> std::io::Result<(T, SaveReport)> {
    let mut w = W { w: out, h: FNV_OFFSET, n: 0 };
    let mut rep = SaveReport { block: st.block, pools: st.pools.len(), ..Default::default() };
    w.raw(MAGIC)?;
    w.u32(FORMAT)?;
    w.u64(st.block)?;
    w.u64(st.saved_ms)?;
    match st.ctx {
        Some((ts, l1, bf)) => {
            w.u8(1)?;
            w.u64(ts)?;
            w.u64(l1)?;
            w.u64(bf)?;
        }
        None => w.u8(0)?,
    }
    // Contract code (by hash).
    let codes: Vec<(&B256, &Bytecode)> = st.snap.codes.iter().filter(|(h, _)| **h != KECCAK_EMPTY).collect();
    w.len(codes.len())?;
    for (h, c) in &codes {
        w.b256(h)?;
        w.bytes(c.original_byte_slice())?;
    }
    rep.codes = codes.len();
    // Accounts: never-trusted ("volatile") accounts are left out (checks
    // never read them anyway, and they can only grow stale).
    let whole: HashSet<Address> = st.volatile_whole.iter().copied().collect();
    let accts: Vec<(&Address, &Acct)> = st.snap.accounts.iter().filter(|(a, _)| !whole.contains(*a)).collect();
    w.len(accts.len())?;
    for (a, x) in accts {
        w.addr(a)?;
        let (known, exists) = match &x.basics {
            Basics::Unknown => (false, false),
            Basics::Known(None) => (true, false),
            Basics::Known(Some(_)) => (true, true),
        };
        let flags = (known as u8) | (exists as u8) << 1 | (x.balance_exact as u8) << 2 | (x.storage_complete as u8) << 3;
        w.u8(flags)?;
        if let Basics::Known(Some(i)) = &x.basics {
            w.u256(&i.balance)?;
            w.u64(i.nonce)?;
            w.b256(&i.code_hash)?;
        }
        let slots: Vec<(&U256, &U256)> = x.storage.iter().filter(|(s, _)| !st.strip.contains(&(*a, **s))).collect();
        w.len(slots.len())?;
        for (s, v) in slots {
            w.u256(s)?;
            w.u256(v)?;
            rep.slots += 1;
        }
        rep.accounts += 1;
    }
    w.len(st.volatile_whole.len())?;
    for a in &st.volatile_whole {
        w.addr(a)?;
    }
    w.len(st.volatile_balance.len())?;
    for a in &st.volatile_balance {
        w.addr(a)?;
    }
    // Coin balance layouts.
    w.len(st.layouts.len())?;
    for (c, l) in &st.layouts {
        w.addr(c)?;
        w.u8((l.vyper as u8) | (l.solady as u8) << 1)?;
        w.u256(&l.slot)?;
    }
    w.len(st.pair_slots.len())?;
    for ((c, h), s) in &st.pair_slots {
        w.addr(c)?;
        w.addr(h)?;
        w.u256(s)?;
    }
    for list in [&st.per_pool_coins, &st.coin_ok] {
        w.len(list.len())?;
        for a in list {
            w.addr(a)?;
        }
    }
    // Ready pools.
    w.len(st.pools.len())?;
    for (e, lp) in &st.pools {
        let p = &e.pool;
        w.addr(&p.address)?;
        match p.v4_id {
            Some(id) => {
                w.u8(1)?;
                w.b256(&id)?;
            }
            None => w.u8(0)?,
        }
        w.u8(kind_code(p.kind))?;
        w.addr(&p.token0)?;
        w.addr(&p.token1)?;
        w.u32(p.fee)?;
        w.i64(p.tick_spacing as i64)?;
        w.len(e.owned.len())?;
        for a in &e.owned {
            w.addr(a)?;
        }
        let mut items: Vec<&(Address, U256)> = e.items.iter().collect();
        items.sort();
        w.len(items.len())?;
        for (a, s) in items {
            w.addr(a)?;
            w.u256(s)?;
        }
        let mut accounts: Vec<&Address> = e.accounts.iter().collect();
        accounts.sort();
        w.len(accounts.len())?;
        for a in accounts {
            w.addr(a)?;
        }
        w.u8(e.verified as u8)?;
        w.u64(e.ready_since)?;
        w.u64(e.base_block)?;
        w.u64(e.events)?;
        match &e.walk {
            Some(x) => {
                w.u8(1)?;
                w.u64(x.block)?;
                w.u8(x.done as u8)?;
                w.i64(x.center)?;
                w.i64(x.word_lo)?;
                w.i64(x.word_hi)?;
                w.u64(x.ticks)?;
                w.u64(x.slots as u64)?;
            }
            None => w.u8(0)?,
        }
        w.len(e.walked.len())?;
        for (a, s) in &e.walked {
            w.addr(a)?;
            w.u256(s)?;
        }
        match &e.far_zero {
            Some(f) => {
                w.u8(1)?;
                w.u64(f.block)?;
                w.len(f.slots.len())?;
                for s in f.slots.iter() {
                    w.u256(s)?;
                }
            }
            None => w.u8(0)?,
        }
        w.opt_pos(*lp)?;
    }
    // Followed coin balances.
    w.len(st.coins.len())?;
    for ((c, h), pos, base) in &st.coins {
        w.addr(c)?;
        w.addr(h)?;
        w.opt_pos(*pos)?;
        match base {
            Some(b) => {
                w.u8(1)?;
                w.u64(*b)?;
            }
            None => w.u8(0)?,
        }
    }
    // The last blocks' reports.
    w.len(st.buf.len())?;
    for (b, rctx, logs) in &st.buf {
        w.u64(*b)?;
        w.u64(rctx.timestamp)?;
        w.u64(rctx.l1_number)?;
        w.len(logs.len())?;
        for l in logs.iter() {
            w.addr(&l.address)?;
            w.len(l.topics.len())?;
            for t in &l.topics {
                w.b256(t)?;
            }
            w.bytes(&l.data)?;
            w.u64(l.block)?;
            w.u32(l.tx_index)?;
            w.u32(l.log_index)?;
            w.b256(&l.tx_hash)?;
        }
    }
    // Trailer: the checksum of everything before it.
    let h = w.h;
    w.w.write_all(&h.to_le_bytes())?;
    rep.bytes = w.n + 8;
    Ok((w.w, rep))
}

/// Write `st` to `path` atomically: a temporary file next to it, flushed to
/// disk, then renamed over the old file (a crash mid-way leaves the old one).
pub fn save(st: &State, path: &str) -> Result<SaveReport, String> {
    let t0 = Instant::now();
    let p = Path::new(path);
    if let Some(dir) = p.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| format!("can't create folder {}: {e}", dir.display()))?;
    }
    let tmp = format!("{path}.tmp-{}", std::process::id());
    let res = (|| -> Result<SaveReport, String> {
        let f = std::fs::File::create(&tmp).map_err(|e| format!("can't create {tmp}: {e}"))?;
        let (bw, rep) = encode(st, BufWriter::with_capacity(1 << 20, f)).map_err(|e| format!("writing {tmp}: {e}"))?;
        let f = bw.into_inner().map_err(|e| format!("writing {tmp}: {e}"))?;
        f.sync_all().map_err(|e| format!("flushing {tmp}: {e}"))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("renaming {tmp} -> {path}: {e}"))?;
        Ok(rep)
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    let mut rep = res?;
    rep.write_ms = t0.elapsed().as_secs_f64() * 1000.0;
    Ok(rep)
}

/// Serialize into memory (tests / measurements).
pub fn encode_to_vec(st: &State) -> Vec<u8> {
    encode(st, Vec::new()).map(|(v, _)| v).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
/// Read a saved file. Err(why) = not usable (missing, other format version,
/// checksum, anything that doesn't parse): the caller loads normally.
pub fn load(path: &str, volatile: Arc<crate::state::snap::Volatile>) -> Result<State, String> {
    let mut f = std::fs::File::open(path).map_err(|e| format!("can't open {path}: {e}"))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| format!("can't read {path}: {e}"))?;
    decode(&buf, volatile)
}

pub fn decode(buf: &[u8], volatile: Arc<crate::state::snap::Volatile>) -> Result<State, String> {
    if buf.len() < MAGIC.len() + 4 + 8 {
        return Err("file too short".into());
    }
    if &buf[..MAGIC.len()] != MAGIC {
        return Err("not a copy-2 state file".into());
    }
    let fmt = u32::from_le_bytes(buf[16..20].try_into().unwrap());
    if fmt != FORMAT {
        return Err(format!("format version {fmt}, this sidecar reads only {FORMAT}"));
    }
    let (body, trailer) = buf.split_at(buf.len() - 8);
    if fnv(FNV_OFFSET, body) != u64::from_le_bytes(trailer.try_into().unwrap()) {
        return Err("checksum does not match (file damaged)".into());
    }
    let mut r = R { b: body, i: 20 };
    let block = r.u64()?;
    let saved_ms = r.u64()?;
    let ctx = if r.bool()? { Some((r.u64()?, r.u64()?, r.u64()?)) } else { None };
    let mut codes: PMap<B256, Bytecode> = PMap::default();
    for _ in 0..r.len(33)? {
        let h = r.b256()?;
        let raw = r.bytes()?;
        // Code is identified by its hash: a body that doesn't hash to it
        // would run the wrong program.
        if keccak256(raw) != h {
            return Err(format!("code {h} does not match its hash"));
        }
        codes.insert(h, Bytecode::new_raw(Bytes::copy_from_slice(raw)));
    }
    let mut accounts: PMap<Address, Acct> = PMap::default();
    for _ in 0..r.len(25)? {
        let a = r.addr()?;
        let flags = r.u8()?;
        if flags > 15 {
            return Err(format!("account {a}: bad flags {flags}"));
        }
        let (known, exists) = (flags & 1 != 0, flags & 2 != 0);
        let basics = match (known, exists) {
            (false, false) => Basics::Unknown,
            (true, false) => Basics::Known(None),
            (true, true) => {
                let balance = r.u256()?;
                let nonce = r.u64()?;
                let code_hash = r.b256()?;
                Basics::Known(Some(AccountInfo { balance, nonce, code_hash, code: None, ..Default::default() }))
            }
            (false, true) => return Err(format!("account {a}: bad flags {flags}")),
        };
        let mut storage: PMap<U256, U256> = PMap::default();
        for _ in 0..r.len(64)? {
            let s = r.u256()?;
            let v = r.u256()?;
            storage.insert(s, v);
        }
        accounts.insert(a, Acct { basics, balance_exact: flags & 4 != 0, storage, storage_complete: flags & 8 != 0 });
    }
    let mut volatile_whole = Vec::new();
    for _ in 0..r.len(20)? {
        volatile_whole.push(r.addr()?);
    }
    let mut volatile_balance = Vec::new();
    for _ in 0..r.len(20)? {
        volatile_balance.push(r.addr()?);
    }
    let mut layouts = Vec::new();
    for _ in 0..r.len(53)? {
        let c = r.addr()?;
        let f = r.u8()?;
        if f > 3 {
            return Err(format!("coin {c}: bad layout flags {f}"));
        }
        let slot = r.u256()?;
        layouts.push((c, BalanceLayout { vyper: f & 1 != 0, solady: f & 2 != 0, slot }));
    }
    let mut pair_slots = Vec::new();
    for _ in 0..r.len(72)? {
        let c = r.addr()?;
        let h = r.addr()?;
        pair_slots.push(((c, h), r.u256()?));
    }
    let mut per_pool_coins = Vec::new();
    for _ in 0..r.len(20)? {
        per_pool_coins.push(r.addr()?);
    }
    let mut coin_ok = Vec::new();
    for _ in 0..r.len(20)? {
        coin_ok.push(r.addr()?);
    }
    let mut pools = Vec::new();
    let mut seen: HashSet<(Address, Option<B256>)> = HashSet::new();
    for _ in 0..r.len(80)? {
        let address = r.addr()?;
        let v4_id = if r.bool()? { Some(r.b256()?) } else { None };
        let kind = kind_of(r.u8()?)?;
        if (kind == PoolKind::V4) != v4_id.is_some() {
            return Err(format!("pool {address}: V4 id given for (and only for) V4 pools"));
        }
        if !seen.insert((address, v4_id)) {
            return Err(format!("pool {address} listed twice"));
        }
        let token0 = r.addr()?;
        let token1 = r.addr()?;
        let fee = r.u32()?;
        let tick_spacing = i32::try_from(r.i64()?).map_err(|_| format!("pool {address}: bad tick spacing"))?;
        let mut owned = Vec::new();
        for _ in 0..r.len(20)? {
            owned.push(r.addr()?);
        }
        let mut items = HashSet::new();
        for _ in 0..r.len(52)? {
            let a = r.addr()?;
            items.insert((a, r.u256()?));
        }
        let mut accts = HashSet::new();
        for _ in 0..r.len(20)? {
            accts.insert(r.addr()?);
        }
        let verified = r.bool()?;
        let ready_since = r.u64()?;
        let base_block = r.u64()?;
        let events = r.u64()?;
        let walk = if r.bool()? {
            Some(WalkInfo {
                block: r.u64()?,
                done: r.bool()?,
                center: r.i64()?,
                word_lo: r.i64()?,
                word_hi: r.i64()?,
                ticks: r.u64()?,
                slots: r.u64()? as usize,
            })
        } else {
            None
        };
        let mut walked = Vec::with_capacity(0);
        let n = r.len(52)?;
        walked.reserve_exact(n);
        for _ in 0..n {
            let a = r.addr()?;
            walked.push((a, r.u256()?));
        }
        let far_zero = if r.bool()? {
            let b = r.u64()?;
            let n = r.len(32)?;
            let mut v = Vec::with_capacity(n);
            for _ in 0..n {
                v.push(r.u256()?);
            }
            Some(FarZero { block: b, slots: Arc::new(v) })
        } else {
            None
        };
        let lp = r.opt_pos()?;
        let now = Instant::now();
        let e = PoolEntry {
            pool: TrackedPool { address, v4_id, kind, token0, token1, fee, tick_spacing },
            state: PoolState::Ready,
            reason: String::new(),
            events,
            strikes: 0,
            clean_events: 0,
            retry_at: now,
            owned,
            items,
            accounts: accts,
            verified,
            gen: 0,
            ready_since,
            busy: false,
            ever_ready: true,
            rounds: 0,
            fails: 0,
            walk,
            walk_busy: false,
            walk_retry_at: now,
            walk_fails: 0,
            walked,
            far_zero,
            pending_from: None,
            base_block,
            need_base: 0,
        };
        pools.push((e, lp));
    }
    let mut coins = Vec::new();
    for _ in 0..r.len(42)? {
        let c = r.addr()?;
        let h = r.addr()?;
        let pos = r.opt_pos()?;
        let base = if r.bool()? { Some(r.u64()?) } else { None };
        coins.push(((c, h), pos, base));
    }
    let mut buf_out = Vec::new();
    for _ in 0..r.len(28)? {
        let b = r.u64()?;
        let ts = r.u64()?;
        let l1 = r.u64()?;
        let mut logs = Vec::new();
        for _ in 0..r.len(100)? {
            let address = r.addr()?;
            let mut topics = Vec::new();
            for _ in 0..r.len(32)? {
                topics.push(r.b256()?);
            }
            let data = Bytes::copy_from_slice(r.bytes()?);
            let block = r.u64()?;
            let tx_index = r.u32()?;
            let log_index = r.u32()?;
            let tx_hash = r.b256()?;
            logs.push(PoolLog { address, topics, data, block, tx_index, log_index, tx_hash, removed: false });
        }
        buf_out.push((b, ReplayCtx { number: b, timestamp: ts, l1_number: l1 }, Arc::new(logs)));
    }
    if r.i != body.len() {
        return Err(format!("{} unexpected bytes at the end", body.len() - r.i));
    }
    let snap = Snapshot { accounts, codes, pos: crate::state::StatePosition { base_block: block, after_seq: None }, volatile };
    Ok(State {
        block,
        ctx,
        saved_ms,
        snap: Arc::new(snap),
        strip: HashSet::new(),
        volatile_whole,
        volatile_balance,
        pools,
        layouts,
        pair_slots,
        per_pool_coins,
        coin_ok,
        coins,
        buf: buf_out,
    })
}

// ---------------------------------------------------------------------------
// The saver thread: takes a State, writes it, reports back (never blocks
// the intake: a save still running when the next is due skips that round).
// ---------------------------------------------------------------------------
pub struct Saver {
    tx: std::sync::mpsc::SyncSender<(State, Option<std::sync::mpsc::SyncSender<Result<SaveReport, String>>>)>,
    pub busy: Arc<AtomicBool>,
    pub last: Arc<std::sync::Mutex<Option<Result<SaveReport, String>>>>,
}

impl Saver {
    pub fn spawn(path: String) -> Saver {
        let (tx, rx) = std::sync::mpsc::sync_channel::<(State, Option<std::sync::mpsc::SyncSender<Result<SaveReport, String>>>)>(1);
        let busy = Arc::new(AtomicBool::new(false));
        let last: Arc<std::sync::Mutex<Option<Result<SaveReport, String>>>> = Arc::new(std::sync::Mutex::new(None));
        let (b2, l2) = (busy.clone(), last.clone());
        std::thread::Builder::new()
            .name("arbsim-copy2-save".into())
            .spawn(move || {
                let mut errors = 0u64;
                while let Ok((st, reply)) = rx.recv() {
                    let r = save(&st, &path);
                    drop(st);
                    if let Err(e) = &r {
                        errors += 1;
                        if errors <= 5 || errors % 100 == 0 {
                            eprintln!("[arbsim] copy2: saving the copy failed ({e}) [#{errors}]");
                        }
                    }
                    *l2.lock().unwrap() = Some(r.clone());
                    b2.store(false, Ordering::SeqCst);
                    if let Some(rp) = reply {
                        let _ = rp.send(r);
                    }
                }
            })
            .expect("saver thread");
        Saver { tx, busy, last }
    }

    /// Hand a state over (false = a save is still running: skipped).
    pub fn offer(&self, st: State) -> bool {
        if self.busy.swap(true, Ordering::SeqCst) {
            return false;
        }
        if self.tx.try_send((st, None)).is_err() {
            self.busy.store(false, Ordering::SeqCst);
            return false;
        }
        true
    }

    /// Final save: wait for a running save to finish, then write this one
    /// and wait for it (at most `timeout`).
    pub fn save_and_wait(&self, st: State, timeout: std::time::Duration) -> Result<SaveReport, String> {
        let t0 = Instant::now();
        while self.busy.swap(true, Ordering::SeqCst) {
            if t0.elapsed() > timeout {
                return Err("a save was still running".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let (rtx, rrx) = std::sync::mpsc::sync_channel(1);
        if self.tx.send((st, Some(rtx))).is_err() {
            self.busy.store(false, Ordering::SeqCst);
            return Err("saver thread gone".into());
        }
        rrx.recv_timeout(timeout.saturating_sub(t0.elapsed())).map_err(|_| "timed out".to_string())?
    }
}

/// Group a log list by block, dropping repeats (the same report matched by
/// two filters), sorted by position (catch-up helper).
pub fn by_block(logs: Vec<PoolLog>) -> BTreeMap<u64, Vec<PoolLog>> {
    let mut m: BTreeMap<u64, Vec<PoolLog>> = BTreeMap::new();
    let mut seen: HashMap<u64, HashSet<(u32, u32, B256)>> = HashMap::new();
    for l in logs {
        if seen.entry(l.block).or_default().insert((l.tx_index, l.log_index, l.tx_hash)) {
            m.entry(l.block).or_default().push(l);
        }
    }
    for v in m.values_mut() {
        v.sort_by_key(|l| (l.tx_index, l.log_index));
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(n: u8) -> Address {
        Address::with_last_byte(n)
    }

    fn sample() -> State {
        let mut s = Snapshot::default();
        let code = Bytecode::new_raw(Bytes::from_static(&[0x60, 0x01, 0x60, 0x00, 0x55]));
        let h = keccak256(code.original_byte_slice());
        s.put_code(h, code);
        s.apply_fact(&crate::state::snap::Fact::Basics { addr: a(1), info: Some(AccountInfo { balance: U256::from(5), nonce: 1, code_hash: h, ..Default::default() }), code: None });
        for i in 0..10u64 {
            s.apply_fact(&crate::state::snap::Fact::Slot(a(1), U256::from(i), U256::from(i * 7 + 1)));
        }
        s.apply_fact(&crate::state::snap::Fact::Basics { addr: a(2), info: None, code: None });
        s.apply_fact(&crate::state::snap::Fact::Slot(a(3), U256::from(9), U256::from(99)));
        let now = Instant::now();
        let e = PoolEntry {
            pool: TrackedPool { address: a(1), v4_id: None, kind: PoolKind::V3, token0: a(10), token1: a(11), fee: 3000, tick_spacing: 60 },
            state: PoolState::Ready,
            reason: String::new(),
            events: 12,
            strikes: 0,
            clean_events: 0,
            retry_at: now,
            owned: vec![a(4)],
            items: [(a(1), U256::from(0)), (a(1), U256::from(1))].into_iter().collect(),
            accounts: [a(1)].into_iter().collect(),
            verified: true,
            gen: 3,
            ready_since: 90,
            busy: false,
            ever_ready: true,
            rounds: 0,
            fails: 0,
            walk: Some(WalkInfo { block: 95, done: true, center: -120, word_lo: -3, word_hi: 3, ticks: 4, slots: 3 }),
            walk_busy: false,
            walk_retry_at: now,
            walk_fails: 0,
            walked: vec![(a(1), U256::from(5)), (a(1), U256::from(6))],
            far_zero: Some(FarZero { block: 95, slots: Arc::new(vec![U256::from(77), U256::from(78)]) }),
            pending_from: None,
            base_block: 89,
            need_base: 0,
        };
        let log = PoolLog { address: a(1), topics: vec![B256::with_last_byte(1)], data: Bytes::from_static(&[1, 2, 3]), block: 100, tx_index: 2, log_index: 5, tx_hash: B256::with_last_byte(9), removed: false };
        State {
            block: 100,
            ctx: Some((1_700_000_000, 20_000_000, 10_000_000)),
            saved_ms: 123,
            snap: Arc::new(s),
            strip: [(a(1), U256::from(9))].into_iter().collect(),
            volatile_whole: vec![a(3)],
            volatile_balance: vec![a(5)],
            pools: vec![(e, Some((100, 2, 5)))],
            layouts: vec![(a(10), BalanceLayout::solidity(1)), (a(11), BalanceLayout::vyper(3))],
            pair_slots: vec![((a(12), a(1)), U256::from(4242))],
            per_pool_coins: vec![a(12)],
            coin_ok: vec![a(10)],
            coins: vec![((a(10), a(1)), Some((99, 1, 1)), Some(89))],
            buf: vec![(100, ReplayCtx { number: 100, timestamp: 1_700_000_000, l1_number: 20_000_000 }, Arc::new(vec![log]))],
        }
    }

    #[test]
    fn save_and_load_give_back_the_same_state() {
        let st = sample();
        let bytes = encode_to_vec(&st);
        let back = decode(&bytes, Arc::new(Default::default())).expect("reads back");
        assert_eq!(back.block, 100);
        assert_eq!(back.ctx, st.ctx);
        // Volatile account a(3) is left out; a(2) (doesn't exist) kept.
        assert!(back.snap.accounts.get(&a(3)).is_none());
        assert_eq!(back.snap.accounts.get(&a(2)).unwrap().basics, Basics::Known(None));
        let x = back.snap.accounts.get(&a(1)).unwrap();
        assert_eq!(x.storage.len(), 10);
        assert_eq!(x.storage.get(&U256::from(3)), Some(&U256::from(22)));
        assert_eq!(back.snap.codes.len(), 1);
        let (e, lp) = &back.pools[0];
        assert_eq!(*lp, Some((100, 2, 5)));
        assert_eq!(e.items, st.pools[0].0.items);
        assert_eq!(e.walked, st.pools[0].0.walked);
        assert_eq!(e.far_zero.as_ref().unwrap().slots, st.pools[0].0.far_zero.as_ref().unwrap().slots);
        assert_eq!(e.walk.as_ref().unwrap().center, -120);
        assert_eq!(e.state, PoolState::Ready);
        assert_eq!(back.layouts, st.layouts);
        assert_eq!(back.pair_slots, st.pair_slots);
        assert_eq!(back.coins, st.coins);
        assert_eq!(back.buf[0].2[0].data, st.buf[0].2[0].data);
        assert_eq!(back.volatile_whole, vec![a(3)]);
    }

    #[test]
    fn stripped_values_are_not_saved() {
        let mut st = sample();
        let mut s = (*st.snap).clone();
        s.apply_fact(&crate::state::snap::Fact::Slot(a(1), U256::from(9), U256::from(1)));
        st.snap = Arc::new(s);
        let back = decode(&encode_to_vec(&st), Arc::new(Default::default())).unwrap();
        assert!(back.snap.accounts.get(&a(1)).unwrap().storage.get(&U256::from(9)).is_none());
    }

    #[test]
    fn damaged_or_other_version_files_are_refused() {
        let bytes = encode_to_vec(&sample());
        let vol = || Arc::new(crate::state::snap::Volatile::default());
        // One flipped bit anywhere: checksum.
        for at in [20usize, 100, bytes.len() / 2, bytes.len() - 9] {
            let mut b = bytes.clone();
            b[at] ^= 1;
            assert!(decode(&b, vol()).is_err(), "flip at {at} accepted");
        }
        // Cut short.
        assert!(decode(&bytes[..bytes.len() - 20], vol()).is_err());
        assert!(decode(&[], vol()).is_err());
        // Another format version.
        let mut b = bytes.clone();
        b[16] = b[16].wrapping_add(1);
        let e = decode(&b, vol()).err().unwrap();
        assert!(e.contains("format version"), "{e}");
    }

    #[test]
    fn save_is_atomic_and_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("arbsim-persist-{}", std::process::id()));
        let path = dir.join("state.bin");
        let p = path.to_str().unwrap().to_string();
        let r = save(&sample(), &p).expect("saved");
        assert!(r.bytes > 0);
        let back = load(&p, Arc::new(Default::default())).expect("loads");
        assert_eq!(back.block, 100);
        let names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names, vec!["state.bin".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
