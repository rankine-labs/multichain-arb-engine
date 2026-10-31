// ============================================================================
// FAST LANE COPY-2 RUNNER: the scanner's checks run the way the sidecar runs
// every copy-2 check (review H3 / integration item 4).
//
// Plain English:
//   The scanner (scan.rs) asks "does this route pay?" through a CheckRunner.
//   The plain runner just runs the size search on the state it is given.
//   That is exact for most pools, but copy 2 knows a few things the plain
//   run doesn't (copy2/checkview.rs, server.rs copy2_runs):
//     - a V4 PoolManager's coin balances are only known as a proven LOWER
//       BOUND, so a run that reads one is repeated with the balance far
//       higher; the answer stands only if both runs agree exactly,
//     - a V4 protocol-fee counter copy 2 never holds is run as 0 and not 0;
//       the answer stands only if the two differ in gas alone (the higher
//       gas is kept, so profit is never over-stated),
//     - far, empty tick-map words of V4 pools it walked are known zero,
//     - a pool that may still be missing reports of the block ("pending")
//       or that is not ready gives "unknown", never an answer,
//     - the check's CALLER (the bot's sim caller, a plain wallet copy 2
//       never follows) is treated as an empty account, exactly as the
//       sidecar does for every copy-2 check (server.rs caller_as_empty).
//   This runner does exactly that, by calling the SAME code the sidecar
//   uses (server::copy2_runs, the same C2View facts, the same pending /
//   unsure rules), with the size search as the run. So a fast-lane answer
//   on copy 2's state is the answer the bot's own sidecar check would give.
//
//   Works on copy 2's confirmed versions AND on the predicted view (copy2/
//   ahead.rs): the facts are taken for the view's block (pools ready since
//   then), and pending reports of earlier blocks still block an answer.
//
//   ONE CHECK CORE PER BLOCK (Oct 30): every check needs copy 2's "check
//   core" (copy2/checkcore.rs: pending / not-ready pools and the facts).
//   Each route's check used to ask for it (core_for), which REBUILDS it
//   whenever copy 2's pool registry changed since the last build: live
//   ~20 rebuilds a second at ~11 ms each (lane.steps.coreBuild), paid
//   inside route checks, so most routes "didn't fit" the scan budget. Now
//   the scanner says when a block's scan starts and ends (begin_block /
//   end_block): the first check of the block gets a current core, and the
//   block's other checks on the SAME state reuse it. Same rule as before:
//   a core read after the block's version was picked (here: at the first
//   check, so the block's checks all count as made at that moment, which
//   is what the sidecar accepts for any check: checkcore.rs header). Outside
//   a scan (practice re-checks) each check still asks for its own.
//
//   FAST LANE FILLS (Oct 30): a check that answers "miss" names the values
//   copy 2 doesn't hold. The bot's own sidecar checks always asked copy 2
//   to fetch those (server.rs after_pick_with -> fill); the fast lane never
//   did. So a value only fast-lane routes need stayed missing for good, and
//   the same route answered "unknown" every block. Live Oct 30 20:00-20:16:
//   USDG (0x5fc5..) 3,657 misses, the blocklist contract 0xe10b.. 367: e.g.
//   USDG keeps a per-address flag (mapping slot 6) it reads for BOTH sides
//   of every transfer; copy 2 follows balances, not flags, so flag[pool]
//   is held only once some check fetched it. Now the fast lane asks too,
//   paced by FastFillBook (each value at most once per
//   ARBSIM_FASTLANE_FILL_REPEAT_S [120] seconds, at most
//   ARBSIM_FASTLANE_FILL_PER_HOUR [12000; was 3600, used up within 22
//   minutes live Oct 31] values an hour, the first
//   ARBSIM_FASTLANE_FILL_MAX_ITEMS [8] items of one answer;
//   ARBSIM_FASTLANE_FILL=0 turns it off). A fill is copy 2's ordinary fill:
//   the node's value at a block, placed and refreshed by copy 2's own rules
//   (it refuses what it can't hold exactly). Nothing is guessed: until the
//   value is held, the check keeps answering "unknown".
//   Status fastlane.copy2Runs: fillOffered / fillSent / fillRepeat /
//   fillOverCap / fillNotQueued / fillAskedAgain; values fetched for the
//   fast lane are re-read by their own verify round (copy2/intake.rs
//   dispatch_fast_verify, ARBSIM_COPY2_FAST_VERIFY_S [60]); fastlane.copy2Unknown: WHICH value each "miss" stopped on
//   (account + slot) and WHICH pool each "unsure_pool" named (top 10).
//
//   V4 POOLMANAGER VALUES (Oct 31): a fast-lane check that misses a value
//   of the V4 PoolManager (one contract holding EVERY V4 pool) used to get
//   it refused for good: copy 2 only keeps such a value when it knows WHOSE
//   it is (a tick / tick-map word of one of OUR ready V4 pools beyond its
//   walk, copy2/v4blind.rs fix (b), kept exact by that pool's own events),
//   and it learns that from hash inputs only trigger-first checks record.
//   Now the fast lane names them itself (name_pm_misses): for each V4 pool
//   on the route it works out where its tick-map words and ticks live and
//   compares hashes. A name is only kept when the hash matches exactly, so
//   it is never a guess; what copy 2 then does with the value is unchanged.
//   Also (Oct 31): a PoolManager miss is no longer labelled "unsure_pool"
//   just because SOME other V4 pool is loading (one of ~1,270 usually is):
//   only when the missed value is named and belongs to a pool not ready
//   (intake.rs unsure_reason_with). Otherwise it is a plain miss and is
//   fetched like any other.
//
//   Counted on their own (final review, low): copy 2's PoolManager-bound and
//   protocol-fee counters (pm_bound_*, pm_high_*, protocol_fee_*) are about
//   the BOT's checks. Runs made from here are counted in this file instead
//   (status "fastlane" -> "copy2Runs"), so the fast lane can't blur them.
// ============================================================================
use std::cell::Cell;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use revm::primitives::U256;
use serde_json::{json, Value};

use super::scan::{CheckRunner, PreparedCheck, RunAt};
use crate::arb::BlockCtx;
use crate::check::hexutil::{parse_u256, parse_u64, quantity, quantity_u64};
use crate::check::run::CheckOptions;
use crate::check::search::{size_search_opts, SizeSearchAmounts, SizeSearchBest, SizeSearchResult, SizeTry};
use crate::check::{CheckUnknown, UnknownReason};
use crate::copy2::intake::Copy2Handle;
use crate::state::snap::View;
use crate::state::{MissItem, StateRead};

thread_local! {
    /// True while this thread runs a fast lane check through copy 2's code.
    static IN_FASTLANE: Cell<bool> = const { Cell::new(false) };
}

/// The fast lane's own copy-2 run counters (name -> count), process-wide.
static RUN_STATS: Mutex<BTreeMap<&'static str, u64>> = Mutex::new(BTreeMap::new());

/// copy2/intake.rs note_*: if this thread is running a fast lane check,
/// count `what` here and return true (copy 2's own counter is skipped).
pub fn note_if_fastlane(what: &'static str) -> bool {
    if !IN_FASTLANE.with(|f| f.get()) {
        return false;
    }
    *RUN_STATS.lock().unwrap_or_else(|e| e.into_inner()).entry(what).or_default() += 1;
    true
}

/// The fast lane's copy-2 run counters since start (status).
pub fn stats_json() -> Value {
    let m = RUN_STATS.lock().unwrap_or_else(|e| e.into_inner());
    Value::Object(m.iter().map(|(k, v)| (k.to_string(), json!(v))).collect())
}

/// Add `n` to one of the fast lane's copy-2 counters (status copy2Runs).
fn bump(what: &'static str, n: u64) {
    if n > 0 {
        *RUN_STATS.lock().unwrap_or_else(|e| e.into_inner()).entry(what).or_default() += n;
    }
}

/// (Oct 30) What the fast lane's "unknown" answers stopped on (status
/// fastlane.copy2Unknown): miss -> "account slot", unsure_pool -> the pool
/// copy 2 named. Bounded (coverage.rs Tally).
static UNKNOWN_DETAIL: Mutex<Option<(super::coverage::Tally, super::coverage::Tally)>> = Mutex::new(None);

fn note_unknown_detail(miss: Option<String>, unsure: Option<String>) {
    let mut g = UNKNOWN_DETAIL.lock().unwrap_or_else(|e| e.into_inner());
    let (m, u) = g.get_or_insert_with(Default::default);
    if let Some(k) = miss {
        m.add(k);
    }
    if let Some(k) = unsure {
        u.add(k);
    }
}

/// Status: the top 10 missed values and unsure pools since start.
pub fn unknown_detail_json() -> Value {
    let g = UNKNOWN_DETAIL.lock().unwrap_or_else(|e| e.into_inner());
    match g.as_ref() {
        Some((m, u)) => json!({ "missTop": m.json(10), "unsurePoolTop": u.json(10) }),
        None => json!({ "missTop": {}, "unsurePoolTop": {} }),
    }
}

/// The value a "miss" stopped on, as status text ("0xaccount 0xslot").
fn miss_key(m: &MissItem) -> String {
    match m {
        MissItem::Slot(a, s) => format!("{a:#x} {s:#x}"),
        MissItem::Account(a) => format!("{a:#x} basics"),
        MissItem::Code(h) => format!("code {h:#x}"),
    }
}

/// The pool named in an "unsure_pool" detail ("v3 pool 0x.. is unsure:
/// why" -> "v3 pool 0x.. is unsure: why", cut to 100 characters).
fn unsure_key(detail: &str) -> String {
    detail.chars().take(100).collect()
}

/// (Oct 30) FAST LANE FILLS: which missed values the fast lane asked copy 2
/// to fetch (see the file header). One per copy (Copy2Handle).
///
/// Review (Oct 30): an item counts as asked only if copy 2 actually took the
/// request (its input can be full); and a value asked again and again (copy
/// 2 refuses it, e.g. some PoolManager slots, or it never stays held) waits
/// twice as long each time (up to an hour), so it can't use up the hourly
/// allowance.
#[derive(Debug)]
pub struct FastFillBook {
    pub on: bool,
    /// The same value is asked again at most once per this long (the first
    /// time; doubled for each further ask, at most BACKOFF_MAX).
    pub repeat: Duration,
    /// At most this many values an hour (all routes together).
    pub per_hour: u64,
    /// At most this many items of one answer.
    pub max_items: usize,
    /// Value -> (last asked, times asked).
    sent: HashMap<MissItem, (Instant, u32)>,
    order: VecDeque<(MissItem, Instant)>,
    hour_start: Option<Instant>,
    pub hour_used: u64,
}

impl FastFillBook {
    /// Values remembered for the repeat rule (oldest forgotten first).
    pub const REMEMBER: usize = 20_000;
    /// Longest wait between two asks for the same value.
    pub const BACKOFF_MAX: Duration = Duration::from_secs(3600);

    pub fn new(on: bool, repeat: Duration, per_hour: u64, max_items: usize) -> FastFillBook {
        FastFillBook { on, repeat, per_hour, max_items, sent: HashMap::new(), order: VecDeque::new(), hour_start: None, hour_used: 0 }
    }

    /// Settings from the environment (file header).
    pub fn from_env() -> FastFillBook {
        let num = |k: &str, d: u64| std::env::var(k).ok().and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(d);
        let on = std::env::var("ARBSIM_FASTLANE_FILL").map(|s| s.trim() != "0").unwrap_or(true);
        FastFillBook::new(on, Duration::from_secs(num("ARBSIM_FASTLANE_FILL_REPEAT_S", 120)), num("ARBSIM_FASTLANE_FILL_PER_HOUR", 12_000), num("ARBSIM_FASTLANE_FILL_MAX_ITEMS", 8) as usize)
    }

    /// How long after the `times`-th ask the value may be asked again.
    fn wait_after(&self, times: u32) -> Duration {
        let f = 1u32 << times.saturating_sub(1).min(16);
        self.repeat.saturating_mul(f).min(Self::BACKOFF_MAX.max(self.repeat))
    }

    /// A "miss" answer named these values: pick the ones to fetch now, hand
    /// them to `send` (true = copy 2 queued them), and only then count them
    /// as asked (status copy2Runs). Code items are left out (copy 2 fetches
    /// code with the account's basics). Returns what was queued.
    pub fn offer(&mut self, missing: &[MissItem], now: Instant, send: impl FnOnce(Vec<MissItem>) -> bool) -> Vec<MissItem> {
        if !self.on || missing.is_empty() {
            return Vec::new();
        }
        if self.hour_start.is_none_or(|t| now.saturating_duration_since(t) >= Duration::from_secs(3600)) {
            self.hour_start = Some(now);
            self.hour_used = 0;
        }
        let mut pick: Vec<MissItem> = Vec::new();
        let (mut offered, mut repeat, mut over) = (0u64, 0u64, 0u64);
        for m in missing.iter().filter(|m| !matches!(m, MissItem::Code(_))).take(self.max_items) {
            offered += 1;
            if pick.contains(m) {
                continue;
            }
            if let Some((t, n)) = self.sent.get(m) {
                if now.saturating_duration_since(*t) < self.wait_after(*n) {
                    repeat += 1;
                    continue;
                }
            }
            if self.hour_used + pick.len() as u64 >= self.per_hour {
                over += 1;
                continue;
            }
            pick.push(m.clone());
        }
        bump("fillOffered", offered);
        bump("fillRepeat", repeat);
        bump("fillOverCap", over);
        if pick.is_empty() {
            return pick;
        }
        if !send(pick.clone()) {
            // Copy 2's input was full: nothing asked, nothing recorded.
            bump("fillNotQueued", pick.len() as u64);
            return Vec::new();
        }
        for m in &pick {
            let n = self.sent.get(m).map_or(0, |x| x.1);
            if n >= 1 {
                bump("fillAskedAgain", 1);
            }
            self.sent.insert(m.clone(), (now, n.saturating_add(1)));
            self.order.push_back((m.clone(), now));
        }
        self.hour_used += pick.len() as u64;
        while self.order.len() > Self::REMEMBER {
            if let Some((m, t)) = self.order.pop_front() {
                if self.sent.get(&m).is_some_and(|x| x.0 == t) {
                    self.sent.remove(&m);
                }
            }
        }
        bump("fillSent", pick.len() as u64);
        pick
    }
}

// ---------------------------------------------------------------------------
// (Oct 31) Naming the PoolManager values a fast-lane check missed.
// ---------------------------------------------------------------------------

/// Two's-complement 256-bit word of a signed number (how Solidity hashes an
/// int16 / int24 mapping key).
fn signed_word(v: i64) -> U256 {
    if v >= 0 {
        U256::from(v as u64)
    } else {
        U256::MAX - U256::from((-(v + 1)) as u64)
    }
}

/// keccak(a . b) of two words, as a word.
fn hash2(a: U256, b: U256) -> U256 {
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(&a.to_be_bytes::<32>());
    buf[32..].copy_from_slice(&b.to_be_bytes::<32>());
    U256::from_be_bytes(revm::primitives::keccak256(buf).0)
}

/// Uniswap V4 tick range.
const MAX_TICK: i64 = 887_272;

/// Per V4 pool (id): its base slot and every tick-map word's slot -> word
/// number. Fixed for a pool (only its id and tick spacing decide them), so
/// worked out once and kept (at most 512 pools; then started afresh).
type WordIndex = Arc<(U256, HashMap<U256, i64>)>;
static WORD_INDEX: Mutex<Option<HashMap<revm::primitives::B256, WordIndex>>> = Mutex::new(None);

fn word_index(id: revm::primitives::B256, spacing: i32) -> WordIndex {
    let mut g = WORD_INDEX.lock().unwrap_or_else(|e| e.into_inner());
    let m = g.get_or_insert_with(HashMap::new);
    if let Some(x) = m.get(&id) {
        return x.clone();
    }
    let sp = (spacing.max(1)) as i64;
    let base = hash2(U256::from_be_bytes(id.0), U256::from(crate::check::moved::V4_POOLS_SLOT));
    let bitmap_root = base + U256::from(5u8);
    // compressed tick = floor(tick / spacing); word = compressed >> 8.
    let lo = (-MAX_TICK).div_euclid(sp) >> 8;
    let hi = MAX_TICK.div_euclid(sp) >> 8;
    let mut words = HashMap::with_capacity((hi - lo + 1) as usize);
    for w in lo..=hi {
        words.insert(hash2(signed_word(w), bitmap_root), w);
    }
    let x = Arc::new((base, words));
    if m.len() >= 512 {
        m.clear();
    }
    m.insert(id, x.clone());
    x
}

/// The route's V4 pools copy 2 follows (by key fields; the hash check below
/// makes a wrong candidate harmless): (PoolManager, id, tick spacing).
fn route_v4_pools(core: &crate::copy2::checkcore::CheckCore, c: &PreparedCheck) -> Vec<(revm::primitives::Address, revm::primitives::B256, i32)> {
    use revm::primitives::Address;
    let mut out = Vec::new();
    for h in c.trade.hops.iter().filter(|h| h.kind == super::types::KIND_V4) {
        let side_ok = |t: Address| t == h.token_in || t == h.token_out || (h.v4_native && t == Address::ZERO);
        for i in &core.v4 {
            let p = &i.pool;
            if p.address == h.pool && p.fee == h.v4_fee && p.tick_spacing == h.v4_tick_spacing && side_ok(p.token0) && side_ok(p.token1) {
                if let Some(id) = p.v4_id {
                    if !out.iter().any(|x: &(Address, revm::primitives::B256, i32)| x.1 == id) {
                        out.push((p.address, id, p.tick_spacing));
                    }
                }
            }
        }
    }
    out
}

/// The hash inputs (as a check would have recorded them: hash, word 1,
/// word 2) that name each missed PoolManager value of the route's V4
/// pools: a tick-map word (any of the pool's words), or a tick (one of the
/// ticks the tick-map words copy 2 holds mark as used, 3 slots each). Only
/// values whose hash matches exactly are named. Empty = nothing named.
pub fn name_pm_misses(core: &crate::copy2::checkcore::CheckCore, snap: &crate::state::snap::Snapshot, c: &PreparedCheck, missing: &[MissItem]) -> Vec<(U256, U256, U256)> {
    let pm_slots: Vec<(revm::primitives::Address, U256)> = missing
        .iter()
        .filter_map(|m| match m {
            MissItem::Slot(a, s) if core.pm_list.contains(a) => Some((*a, *s)),
            _ => None,
        })
        .collect();
    if pm_slots.is_empty() {
        return Vec::new();
    }
    let mut pre: Vec<(U256, U256, U256)> = Vec::new();
    let add = |pre: &mut Vec<(U256, U256, U256)>, x: (U256, U256, U256)| {
        if !pre.iter().any(|y| y.0 == x.0) {
            pre.push(x);
        }
    };
    for (pm, id, spacing) in route_v4_pools(core, c) {
        let wanted: Vec<U256> = pm_slots.iter().filter(|x| x.0 == pm).map(|x| x.1).collect();
        if wanted.is_empty() {
            continue;
        }
        let idx = word_index(id, spacing);
        let (base, words) = (&idx.0, &idx.1);
        let base_entry = (*base, U256::from_be_bytes(id.0), U256::from(crate::check::moved::V4_POOLS_SLOT));
        let mut named = false;
        // Tick-map words: one slot each.
        for s in &wanted {
            if let Some(w) = words.get(s) {
                add(&mut pre, (*s, signed_word(*w), *base + U256::from(5u8)));
                named = true;
            }
        }
        // Ticks: the used ticks in the tick-map words copy 2 holds.
        let still: Vec<U256> = wanted.iter().filter(|s| !words.contains_key(s)).copied().collect();
        if !still.is_empty() {
            let tick_root = *base + U256::from(4u8);
            'words: for (slot, w) in words.iter() {
                let crate::state::Lookup::Known(bits) = snap.storage(pm, *slot) else { continue };
                if bits.is_zero() {
                    continue;
                }
                for bit in 0..256usize {
                    if !bits.bit(bit) {
                        continue;
                    }
                    let tick = ((*w << 8) + bit as i64) * (spacing.max(1) as i64);
                    let h = hash2(signed_word(tick), tick_root);
                    for off in 0..3u8 {
                        if still.contains(&(h + U256::from(off))) {
                            add(&mut pre, (h, signed_word(tick), tick_root));
                            named = true;
                            if still.iter().all(|s| pre.iter().any(|p| *s >= p.0 && *s < p.0 + U256::from(3u8))) {
                                break 'words;
                            }
                        }
                    }
                }
            }
        }
        if named {
            add(&mut pre, base_entry);
        }
    }
    if !pre.is_empty() {
        bump("pmNamed", 1);
    }
    pre
}

/// Marks this thread as running a fast lane check until dropped.
struct FastlaneRun(bool);
impl FastlaneRun {
    fn enter() -> FastlaneRun {
        FastlaneRun(IN_FASTLANE.with(|f| f.replace(true)))
    }
}
impl Drop for FastlaneRun {
    fn drop(&mut self) {
        let prev = self.0;
        IN_FASTLANE.with(|f| f.set(prev));
    }
}

/// The scanner's runner on copy 2 (see the file header).
pub struct Copy2Runner {
    pub c2: Copy2Handle,
    /// (Oct 30) Inside one block's scan: Some(the core shared by that
    /// block's checks, once the first check got it, with the snapshot and
    /// block it is for). None = not inside a scan (each check gets its own).
    block_core: Mutex<Option<Option<BlockCore>>>,
    /// Times a check asked copy 2 for a core (tests / counting).
    core_asks: std::sync::atomic::AtomicU64,
}

/// One block's shared check core (Copy2Runner::block_core).
/// (Held only until the block's scan ends.)
struct BlockCore {
    snap: Arc<crate::state::snap::Snapshot>,
    block: u64,
    core: Arc<crate::copy2::checkcore::CheckCore>,
}

impl Copy2Runner {
    pub fn new(c2: Copy2Handle) -> Copy2Runner {
        Copy2Runner { c2, block_core: Mutex::new(None), core_asks: std::sync::atomic::AtomicU64::new(0) }
    }

    /// How many times this runner asked copy 2 for a check core.
    pub fn core_asks(&self) -> u64 {
        self.core_asks.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// The check core for a check on `snap` (block `block`): inside a
    /// block's scan the one its first check got (same snapshot and block),
    /// else a current one (file header: ONE CHECK CORE PER BLOCK).
    fn core_for_check(&self, snap: &Arc<crate::state::snap::Snapshot>, block: u64) -> Arc<crate::copy2::checkcore::CheckCore> {
        let mut g = self.block_core.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(Some(bc)) = g.as_ref() {
            if Arc::ptr_eq(&bc.snap, snap) && bc.block == block {
                return bc.core.clone();
            }
        }
        self.core_asks.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let pv = self.c2.sh.published.view();
        let core = self.c2.core_for(Some(&pv));
        if let Some(slot) = g.as_mut() {
            *slot = Some(BlockCore { snap: snap.clone(), block, core: core.clone() });
        }
        core
    }
}

/// A size-search result as the sidecar's JSON answer (handle_size_search's
/// shape, so copy2_runs can compare two runs exactly / merge gas).
pub fn result_json(r: &Result<SizeSearchResult, CheckUnknown>) -> Value {
    match r {
        Ok(r) => json!({
            "ok": true,
            "best": r.best.as_ref().map(|b| json!({ "amount": quantity(b.amount), "profit": quantity(b.profit), "gasUsed": quantity_u64(b.gas_used) })),
            "tried": r.tried.iter().map(|t| json!({
                "amount": quantity(t.amount), "status": t.status, "profit": quantity(t.profit),
                "gasUsed": quantity_u64(t.gas_used), "reason": t.reason,
            })).collect::<Vec<_>>(),
        }),
        Err(u) => {
            let mut v = crate::check::proto_types::unknown_json(&Value::Null, u, 0);
            if let Some(o) = v.as_object_mut() {
                o.remove("us");
            }
            v
        }
    }
}

/// Back from the JSON answer (statuses are the size search's own words).
pub fn result_from_json(v: &Value) -> Result<SizeSearchResult, CheckUnknown> {
    if v.get("ok") != Some(&Value::Bool(true)) {
        let why = v.get("unknown").and_then(|x| x.as_str()).unwrap_or("error");
        let detail = v.get("detail").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let reason = match why {
            "miss" => UnknownReason::Miss,
            "unsupported_precompile" => UnknownReason::UnsupportedPrecompile,
            "bad_request" => UnknownReason::BadRequest,
            "engine_error" => UnknownReason::Engine,
            _ => UnknownReason::Copy2Unsure,
        };
        let mut u = CheckUnknown::new(reason, if reason == UnknownReason::Copy2Unsure { format!("{why}: {detail}") } else { detail });
        if reason == UnknownReason::Miss {
            u.missing = crate::proto::parse_missing(v);
        }
        return Err(u);
    }
    let u256 = |x: &Value| x.as_str().and_then(|s| parse_u256(s).ok()).unwrap_or(U256::ZERO);
    let u64v = |x: &Value| x.as_str().and_then(|s| parse_u64(s).ok()).unwrap_or(0);
    let status = |s: &str| -> &'static str {
        match s {
            "profit" => "profit",
            "loss" => "loss",
            _ => "fail",
        }
    };
    let tried = v
        .get("tried")
        .and_then(|t| t.as_array())
        .map(|a| {
            a.iter()
                .map(|t| SizeTry {
                    amount: u256(&t["amount"]),
                    status: status(t["status"].as_str().unwrap_or("")),
                    profit: u256(&t["profit"]),
                    gas_used: u64v(&t["gasUsed"]),
                    reason: t["reason"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    let best = v.get("best").filter(|b| !b.is_null()).map(|b| SizeSearchBest { amount: u256(&b["amount"]), profit: u256(&b["profit"]), gas_used: u64v(&b["gasUsed"]) });
    Ok(SizeSearchResult { best, tried })
}

impl CheckRunner for Copy2Runner {
    /// Without a snapshot there is nothing for copy 2 to add: the plain run.
    fn run(&self, view: &dyn StateRead, ctx: &BlockCtx, c: &PreparedCheck, amounts: &SizeSearchAmounts) -> Result<SizeSearchResult, CheckUnknown> {
        size_search_opts(view, ctx, &c.overrides, &[], &c.template(), amounts, CheckOptions::default())
    }

    fn run_at(&self, at: &RunAt, c: &PreparedCheck, amounts: &SizeSearchAmounts) -> Result<SizeSearchResult, CheckUnknown> {
        let Some(snap) = at.snap else { return self.run(at.view, at.ctx, c, amounts) };
        let core = self.core_for_check(snap, at.block);
        run_on_copy2_with(&self.c2, &core, snap, at.block, at.ctx, c, amounts)
    }

    fn begin_block(&self) {
        *self.block_core.lock().unwrap_or_else(|e| e.into_inner()) = Some(None);
    }

    fn end_block(&self) {
        *self.block_core.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// One size search on copy 2's snapshot, with copy 2's rules (file header).
pub fn run_on_copy2(c2: &Copy2Handle, snap: &Arc<crate::state::snap::Snapshot>, block: u64, ctx: &BlockCtx, c: &PreparedCheck, amounts: &SizeSearchAmounts) -> Result<SizeSearchResult, CheckUnknown> {
    let pv = c2.sh.published.view();
    let core = c2.core_for(Some(&pv));
    run_on_copy2_with(c2, &core, snap, block, ctx, c, amounts)
}

/// `run_on_copy2` with a check core the caller already has (one per block
/// in a scan: file header). The core must have been read AFTER the version
/// `snap` belongs to was published (core_for at or after that moment).
pub fn run_on_copy2_with(
    c2: &Copy2Handle, core: &crate::copy2::checkcore::CheckCore, snap: &Arc<crate::state::snap::Snapshot>, block: u64, ctx: &BlockCtx, c: &PreparedCheck, amounts: &SizeSearchAmounts,
) -> Result<SizeSearchResult, CheckUnknown> {
    let facts = c2.check_facts_with(core, block);
    let view = View::new(snap.clone());
    let template = c.template();
    // server.rs caller_as_empty: an unknown caller without an override of
    // its own = {balance 0, nonce 0, no code} (the same answer the node
    // gives for the call with that override).
    let from = c.call.from;
    let caller_empty = !c.overrides.accounts.contains_key(&from) && matches!(view.account(from), crate::state::Lookup::Missing);
    let ov_owned;
    let overrides = if caller_empty {
        let mut o = c.overrides.clone();
        o.accounts.insert(
            from,
            crate::check::overrides::AccountOverride { balance: Some(U256::ZERO), nonce: Some(0), code: Some(crate::check::overrides::analysed_code(&[])), ..Default::default() },
        );
        ov_owned = o;
        &ov_owned
    } else {
        &c.overrides
    };
    let run = |v: &dyn StateRead, b: &BlockCtx| result_json(&size_search_opts(v, b, overrides, &[], &template, amounts, CheckOptions::default()));
    let runs = std::cell::RefCell::new(crate::server::RunLog::default());
    let mut answer = {
        let _mark = FastlaneRun::enter();
        crate::server::copy2_runs(c2, &view, &facts, ctx, &runs, &run)
    };
    if answer.get("ok") == Some(&Value::Bool(true)) {
        // A pool on the route may still be missing reports of this block
        // (same rule as server.rs after_pick_with): never answer from it.
        let touched = view.take_touched();
        if let Some(why) = c2.pending_reason_with(core, &touched, block, view.touched_overflow()) {
            answer = json!({ "ok": false, "unknown": "pending_reports", "detail": why });
        }
    } else {
        let missing = crate::proto::parse_missing(&answer);
        // (Oct 31) Name the PoolManager values it missed (see the file
        // header), so copy 2 can keep the ones of our ready V4 pools.
        let pre = name_pm_misses(core, snap, c, &missing);
        if !pre.is_empty() {
            c2.note_pm_pre_keys(core, &missing, &pre, &[]);
        }
        if let Some(why) = c2.unsure_reason_with(core, &missing) {
            note_unknown_detail(None, Some(unsure_key(&why)));
            answer = json!({ "ok": false, "unknown": "unsure_pool", "detail": why });
        } else if answer.get("unknown").and_then(|u| u.as_str()) == Some("miss") {
            // (Oct 30) FAST LANE FILLS (file header): ask copy 2 to fetch
            // what this check missed, paced. The answer stays "unknown".
            note_unknown_detail(missing.first().map(miss_key), None);
            // Only what copy 2 actually queued is counted as asked (review).
            let _ = c2.c2.fastlane_fill.lock().map(|mut b| b.offer(&missing, Instant::now(), |items| c2.fast_fill(items)));
        }
    }
    result_from_json(&answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fastlane_runs_are_counted_apart() {
        assert!(!note_if_fastlane("pmBoundSame"), "outside a fast lane run: copy 2's own counter");
        {
            let _m = FastlaneRun::enter();
            assert!(note_if_fastlane("pmBoundSame"));
            {
                let _inner = FastlaneRun::enter();
            }
            assert!(note_if_fastlane("pmBoundSame"), "nested marks restore the outer one");
        }
        assert!(!note_if_fastlane("pmBoundSame"), "the mark ends with the run");
        assert!(stats_json()["pmBoundSame"].as_u64().unwrap() >= 2);
    }

    /// (Oct 30) The fast lane's fill pacing: each value once per window,
    /// at most `max_items` of one answer, a hard hourly cap, code skipped,
    /// off = nothing asked.
    #[test]
    fn fast_fill_book_paces_what_the_fast_lane_asks_for() {
        use revm::primitives::{Address, B256};
        let a = Address::with_last_byte(5);
        let item = |n: u8| MissItem::Slot(a, U256::from(n));
        let ok = |_: Vec<MissItem>| true;
        let t0 = Instant::now();
        let s = |x: u64| t0 + Duration::from_secs(x);
        let mut b = FastFillBook::new(true, Duration::from_secs(120), 5, 2);
        assert_eq!(b.offer(&[MissItem::Code(B256::ZERO), item(1), item(2), item(3)], t0, ok), vec![item(1), item(2)], "code skipped, 2 items per answer");
        assert!(b.offer(&[item(1), item(2)], s(5), ok).is_empty(), "same values within the window: not again");
        // Copy 2's input full: nothing recorded, the next answer asks again.
        assert!(b.offer(&[item(3)], s(6), |_| false).is_empty());
        assert_eq!(b.hour_used, 2, "a refused send uses none of the allowance");
        assert_eq!(b.offer(&[item(3)], s(7), ok), vec![item(3)]);
        // Asked again after the window; then the wait doubles (240 s).
        assert_eq!(b.offer(&[item(1)], s(121), ok), vec![item(1)]);
        assert!(b.offer(&[item(1)], s(121 + 239), ok).is_empty(), "second ask: waits 240 s");
        assert_eq!(b.offer(&[item(1)], s(121 + 240), ok), vec![item(1)]);
        assert!(b.offer(&[item(4)], s(400), ok).is_empty(), "hourly cap (5) reached");
        assert_eq!(b.offer(&[item(4)], s(3700), ok), vec![item(4)], "a new hour");
        let mut off = FastFillBook::new(false, Duration::from_secs(120), 4, 2);
        assert!(off.offer(&[item(1)], t0, ok).is_empty());
    }

    /// (Oct 31) The fast lane names the PoolManager values its route's V4
    /// pool missed: a far tick-map word, and a tick marked used in a word
    /// copy 2 holds (any of its 3 slots). The names resolve exactly as a
    /// recorded check's would (check/moved.rs resolve_v4_slot); a value of
    /// another pool, or a tick not marked used, stays unnamed.
    #[test]
    fn pm_misses_of_the_route_pools_are_named_exactly() {
        use crate::check::moved::{resolve_v4_slot, PreMap, V4Part};
        use crate::copy2::checkcore::{CheckCore, V4Info};
        use crate::copy2::{PoolKind, TrackedPool};
        use crate::fastlane::types::{DecodedTrade, FlashLender, Hop, KIND_V4};
        use revm::primitives::{Address, B256};
        let pm = Address::with_last_byte(0x83);
        let (t0, t1) = (Address::with_last_byte(1), Address::with_last_byte(2));
        let id = B256::with_last_byte(0x77);
        let pool = TrackedPool { address: pm, v4_id: Some(id), kind: PoolKind::V4, token0: t0, token1: t1, fee: 500, tick_spacing: 10 };
        let core = CheckCore { pm_list: vec![pm], v4: vec![V4Info { pool, ready: true, ready_since: 1, pending_from: None, far: None }], ..Default::default() };
        let check = |fee: u32| PreparedCheck {
            call: Default::default(), overrides: Default::default(), amount_offset: 96, amount_slots: vec![], main_amount: U256::from(5u8), sizes: vec![U256::from(5u8)],
            trade: DecodedTrade {
                token: t1, amount_in: U256::from(5u8), min_profit: U256::MAX, max_block: U256::MAX, flash: FlashLender::Own,
                hops: vec![Hop { kind: KIND_V4, pool: pm, token_in: t1, token_out: t0, fee_bps: 0, v4_fee: fee, v4_tick_spacing: 10, v4_native: false }],
            },
        };
        let c = check(500);
        let base = hash2(U256::from_be_bytes(id.0), U256::from(6u8));
        let word_slot = |w: i64| hash2(signed_word(w), base + U256::from(5u8));
        let tick_slot = |t: i64| hash2(signed_word(t), base + U256::from(4u8));
        // Copy 2 holds word -3: bit 7 set -> tick ((-3 * 256) + 7) * 10 = -7610.
        let mut snap = crate::state::snap::Snapshot::default();
        snap.apply_fact(&crate::state::snap::Fact::Slot(pm, word_slot(-3), U256::from(1u8) << 7usize));
        let far_word = word_slot(-40);
        let tick2 = tick_slot(-7610) + U256::from(2u8);
        let unused_tick = tick_slot(-7600);
        let other = hash2(U256::from(9u8), U256::from(9u8));
        let missing = vec![MissItem::Slot(pm, far_word), MissItem::Slot(pm, tick2), MissItem::Slot(pm, unused_tick), MissItem::Slot(pm, other)];
        let pre = name_pm_misses(&core, &snap, &c, &missing);
        let map: PreMap = pre.iter().map(|(h, a, b)| (*h, (*a, *b))).collect();
        assert_eq!(resolve_v4_slot(far_word, &map), Some((id, V4Part::Bitmap)));
        assert_eq!(resolve_v4_slot(tick2, &map), Some((id, V4Part::Tick)));
        assert_eq!(resolve_v4_slot(unused_tick, &map), None, "a tick not marked used is not named");
        assert_eq!(resolve_v4_slot(other, &map), None);
        // A route without that pool names nothing.
        assert!(name_pm_misses(&core, &snap, &check(3000), &missing).is_empty());
        assert_eq!(signed_word(-1), U256::MAX);
        assert_eq!(signed_word(5), U256::from(5u8));
    }

    #[test]
    fn json_round_trip_keeps_every_field() {
        let r = SizeSearchResult {
            best: Some(SizeSearchBest { amount: U256::from(5u8), profit: U256::from(2u8), gas_used: 300_000 }),
            tried: vec![
                SizeTry { amount: U256::from(5u8), status: "profit", profit: U256::from(2u8), gas_used: 300_000, reason: String::new() },
                SizeTry { amount: U256::from(9u8), status: "fail", profit: U256::ZERO, gas_used: 20_000, reason: "0x90b8ec18".into() },
            ],
        };
        assert_eq!(result_from_json(&result_json(&Ok(r.clone()))).unwrap(), r);
        let u = CheckUnknown::new(UnknownReason::Miss, "x");
        assert_eq!(result_from_json(&result_json(&Err(u))).unwrap_err().reason, UnknownReason::Miss);
        let pm = json!({"ok": false, "unknown": "pool_manager_balance", "detail": "differ"});
        let e = result_from_json(&pm).unwrap_err();
        assert_eq!(e.reason, UnknownReason::Copy2Unsure);
        assert!(e.detail.starts_with("pool_manager_balance"));
    }
}
