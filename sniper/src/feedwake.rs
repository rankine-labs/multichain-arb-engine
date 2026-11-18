// ============================================================================
// FEED WAKE-UP (speed step 3): learn about swaps from the sequencer feed,
// not from polling the node.
//
// Plain English:
//   Until now the paper trader found out about swaps by asking the node
//   "anything new?" every 0.4-1 s. Measured on run 11: a rush typically sat
//   ~630 ms before we even knew about it. The sequencer feed shows every
//   transaction the moment the sequencer orders it, and our own engine copy
//   (arbsim, speed step 2) already replays every one of them exactly.
//
//   Design (the engine cannot hand us event logs over its socket, so):
//     1. WATCH LIST: the pools the trader already follows (seen trading in
//        the last SNIPER_FEED_WAKE_ACTIVE_MIN minutes, tradable). For each:
//        its token address, its own address (V2/V3), and how to read its
//        price (V3 slot0, V2 getReserves, V4 PoolManager storage).
//     2. CANDIDATES: for every feed transaction we look for a watched token
//        or pool address anywhere in its call data (any byte position, so
//        packed V3 paths, Universal Router commands, V4 pool keys and most
//        aggregators are covered without decoding any router), or a direct
//        call to a watched pool.
//     3. CONFIRM ON EXACT STATE: for each candidate we ask the engine for
//        the pool's price right BEFORE and right AFTER that transaction
//        ({"afterTx": hash} on the engine's replayed copy). No change = no
//        swap (this is how a failed / reverted transaction is excluded: it
//        changes nothing). A change = a real swap: direction from the price
//        move, buyer = the wallet that signed the transaction.
//     4. SAME RULES: each confirmed swap is turned into the same kind of
//        swap record the node gives (pool, block, direction, price after,
//        buyer) and goes through the SAME rush detector, filters and buy
//        path as polled swaps. Node polling keeps running as a backup (more
//        slowly while the feed is healthy). A swap seen by both is counted
//        once (key: transaction hash + pool).
//     5. MEASURE: which source saw each rush first and by how many ms,
//        coverage (share of polled swaps the feed had already found), and
//        every switch to "feed stale, back to normal polling".
//
//   Coverage gaps (honest list):
//     - a swap whose call data names neither the token nor the pool (for
//       example a bot contract with stored routes) is missed by the feed;
//       polling still catches it, later;
//     - several swaps of one transaction in one pool are seen as ONE net
//       move (polling sees each);
//     - blocks the engine could not replay itself (repaired from a node
//       trace) and engine "miss"/timeout answers past the deadline are
//       missed by the feed (counted per reason);
//     - V2 liquidity adds/removes are ignored on purpose (both reserves move
//       the same way); a V2 swap is "one reserve up, the other down".
//
// Settings (all off unless SNIPER_FEED_WAKE=1, which also needs
// SNIPER_ENGINE=1; unset = the trader behaves exactly as before):
//   SNIPER_FEED_WAKE=1               turn it on
//   SNIPER_RHC_POLL_MS_WHEN_FEED     node poll pace while the feed is healthy
//                                    (default 2000 ms; backup only). 0 = keep
//                                    the normal pace (fair side-by-side test)
//   SNIPER_FEED_STALE_SECS           no feed frame (or engine failing) this
//                                    long = stale: normal polling (default 5)
//   SNIPER_FEED_WAKE_WAIT_MS         longest we wait for the engine to have
//                                    replayed a frame before giving up on it
//                                    (default 300)
//   SNIPER_FEED_WAKE_ACTIVE_MIN      pools traded in the last N minutes are
//                                    watched (default 30)
//
// Read-only: no keys, never sends a transaction.
// ============================================================================
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::engine::EngineClient;
use crate::feedtx::{self, FeedTx};
use crate::fourmeme::{hex, keccak};
use crate::rhc::{sig_v3_swap, sig_v4_swap, V4_POOL_MANAGER};

/// The run-folder file for feed wake-up events (leads, stale switches, stats).
pub const FILE: &str = "feedwake.jsonl";
/// Remember a swap key (tx + pool) this long for dedupe and lead times.
const KEEP_MS: u64 = 180_000;
/// A rush whose other source never shows up within this is closed as "never".
const RUSH_WAIT_MS: u64 = 60_000;
/// Engine failures in a row (frames given up) that make the feed "unhealthy".
const FAIL_STREAK: u64 = 20;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub struct WakeConfig {
    pub on: bool,
    /// Node poll pace while the feed is healthy. None (setting 0) = the
    /// normal pace, for a fair feed-vs-poll comparison.
    pub poll_when_feed: Option<Duration>,
    pub stale: Duration,
    pub wait: Duration,
    pub active: Duration,
}

impl WakeConfig {
    /// Read the settings. `engine_on` = SNIPER_ENGINE is on (required).
    /// Returns the config and a warning to print, if any.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>, engine_on: bool) -> (Self, Option<String>) {
        let num = |k: &str, d: u64| get(k).and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(d);
        let asked = matches!(get("SNIPER_FEED_WAKE").as_deref().map(str::trim), Some("1") | Some("on") | Some("true"));
        let cfg = WakeConfig {
            on: asked && engine_on,
            poll_when_feed: Some(num("SNIPER_RHC_POLL_MS_WHEN_FEED", 2000)).filter(|m| *m > 0).map(|m| Duration::from_millis(m.clamp(100, 60_000))),
            stale: Duration::from_secs(num("SNIPER_FEED_STALE_SECS", 5).clamp(1, 600)),
            wait: Duration::from_millis(num("SNIPER_FEED_WAKE_WAIT_MS", 300).clamp(10, 5_000)),
            active: Duration::from_secs(num("SNIPER_FEED_WAKE_ACTIVE_MIN", 30).clamp(1, 24 * 60) * 60),
        };
        let warn = (asked && !engine_on).then(|| "SNIPER_FEED_WAKE=1 needs SNIPER_ENGINE=1 (the engine confirms every feed swap); feed wake-up stays OFF".to_string());
        (cfg, warn)
    }

    pub fn from_env(engine_on: bool) -> (Self, Option<String>) {
        Self::from_lookup(|k| std::env::var(k).ok(), engine_on)
    }
}

// ---------------------------------------------------------------------------
// Watch list
// ---------------------------------------------------------------------------

/// Which exchange type a watched pool is (decides how its price is read).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    V3,
    V2,
    V4,
}

/// One pool the feed watches.
#[derive(Clone, Debug, PartialEq)]
pub struct WatchPool {
    /// The trader's key for it: pool address (V3/V2) or pool id (V4).
    pub key: String,
    pub kind: Kind,
    pub token: String,
    pub token_is0: bool,
}

fn addr20(a: &str) -> Option<[u8; 20]> {
    let h = a.trim_start_matches("0x");
    if h.len() != 40 {
        return None;
    }
    let mut out = [0u8; 20];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&h[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(out)
}

/// First 4 bytes of keccak(signature), as 0x-hex.
fn selector(sig: &str) -> String {
    format!("0x{}", hex(&keccak(sig.as_bytes())[..4]))
}

impl WatchPool {
    /// The engine call that reads this pool's price: (contract, call data).
    ///   V3: pool.slot0()                     word 0 = sqrtPriceX96
    ///   V2: pair.getReserves()               words 0,1 = reserve0, reserve1
    ///   V4: PoolManager.extsload(slot)       slot = keccak(poolId . 6) (the
    ///       pools mapping, Uniswap v4 StateLibrary); low 160 bits = sqrtPriceX96
    pub fn price_call(&self) -> (String, String) {
        match self.kind {
            Kind::V3 => (self.key.clone(), selector("slot0()")),
            Kind::V2 => (self.key.clone(), selector("getReserves()")),
            Kind::V4 => {
                let mut b = Vec::with_capacity(64);
                b.extend_from_slice(&decode_hex(&self.key));
                b.extend_from_slice(&[0u8; 31]);
                b.push(6);
                let slot = keccak(&b);
                (V4_POOL_MANAGER.to_string(), format!("{}{}", selector("extsload(bytes32)"), hex(&slot)))
            }
        }
    }
}

fn decode_hex(s: &str) -> Vec<u8> {
    let h = s.trim_start_matches("0x");
    (0..h.len() / 2).filter_map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).ok()).collect()
}

/// The pools being watched, indexed by every 20-byte address that marks a
/// transaction as "maybe trades this pool" (the token, and V2/V3 the pool).
#[derive(Default, Debug)]
pub struct WatchIndex {
    pools: HashMap<String, WatchPool>,
    by_addr: HashMap<[u8; 20], Vec<String>>,
    /// First 4 bytes of every indexed address: a cheap pre-filter for the scan.
    prefix: HashSet<[u8; 4]>,
}

impl WatchIndex {
    pub fn build(pools: impl IntoIterator<Item = WatchPool>) -> Self {
        let mut w = WatchIndex::default();
        for p in pools {
            let mut marks = vec![p.token.clone()];
            if p.kind != Kind::V4 {
                marks.push(p.key.clone());
            }
            for m in marks {
                if let Some(a) = addr20(&m) {
                    w.prefix.insert([a[0], a[1], a[2], a[3]]);
                    let e = w.by_addr.entry(a).or_default();
                    if !e.contains(&p.key) {
                        e.push(p.key.clone());
                    }
                }
            }
            w.pools.insert(p.key.clone(), p);
        }
        w
    }

    pub fn len(&self) -> usize {
        self.pools.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pools.is_empty()
    }

    pub fn contains(&self, key: &str) -> bool {
        self.pools.contains_key(key)
    }

    /// Watched pools this transaction might trade: it calls one directly,
    /// or a watched token / pool address appears anywhere in its call data.
    pub fn candidates(&self, tx: &FeedTx) -> Vec<WatchPool> {
        let mut keys: Vec<&String> = Vec::new();
        let mut add = |a: &[u8]| {
            if let Ok(a20) = <[u8; 20]>::try_from(a) {
                if let Some(ks) = self.by_addr.get(&a20) {
                    for k in ks {
                        if !keys.contains(&k) {
                            keys.push(k);
                        }
                    }
                }
            }
        };
        if let Some(to) = tx.to.as_deref().and_then(addr20) {
            add(&to);
        }
        let d = &tx.data;
        if d.len() >= 20 {
            for i in 0..=d.len() - 20 {
                if self.prefix.contains(&[d[i], d[i + 1], d[i + 2], d[i + 3]]) {
                    add(&d[i..i + 20]);
                }
            }
        }
        keys.into_iter().filter_map(|k| self.pools.get(k).cloned()).collect()
    }
}

// ---------------------------------------------------------------------------
// Reading prices out of engine answers
// ---------------------------------------------------------------------------

/// A pool's state as read: the raw words that decide its price.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Read {
    /// sqrtPriceX96 as one 64-hex-digit word (V3, V4).
    Sqrt(String),
    /// reserve0, reserve1 as 64-hex-digit words (V2).
    Reserves(String, String),
}

fn out_words(out: &str) -> Vec<&str> {
    crate::venue::words(out)
}

/// Turn the engine's answer to `price_call` into a Read.
pub fn parse_read(kind: Kind, output: &str) -> Option<Read> {
    let w = out_words(output);
    match kind {
        Kind::V3 => w.first().filter(|x| x.len() == 64).map(|x| Read::Sqrt(x.to_string())),
        // Packed Slot0: the lowest 160 bits (last 40 hex digits) are sqrtPriceX96.
        Kind::V4 => w.first().filter(|x| x.len() == 64).map(|x| Read::Sqrt(format!("{}{}", "0".repeat(24), &x[24..]))),
        Kind::V2 => match (w.first(), w.get(1)) {
            (Some(a), Some(b)) if a.len() == 64 && b.len() == 64 => Some(Read::Reserves(a.to_string(), b.to_string())),
            _ => None,
        },
    }
}

/// The token's price in base from a Read (same maths as the polled path).
pub fn read_price(r: &Read, token_is0: bool) -> Option<f64> {
    match r {
        Read::Sqrt(s) => crate::rhc_report::token_price(&crate::fourmeme::word_dec(s), token_is0),
        Read::Reserves(a, b) => crate::venue::v2_price(word_u256(a), word_u256(b), token_is0),
    }
}

fn word_u256(w: &str) -> ruint::aliases::U256 {
    ruint::aliases::U256::from_str_radix(w, 16).unwrap_or_default()
}

/// Did this before/after pair show a SWAP, and was it a sell of the token?
/// None = no swap (nothing changed, e.g. a failed transaction, or a V2
/// liquidity add/remove where both reserves move the same way).
pub fn swap_direction(before: &Read, after: &Read, token_is0: bool) -> Option<bool> {
    if before == after {
        return None;
    }
    if let (Read::Reserves(b0, b1), Read::Reserves(a0, a1)) = (before, after) {
        let (d0, d1) = (word_u256(a0).cmp(&word_u256(b0)), word_u256(a1).cmp(&word_u256(b1)));
        use std::cmp::Ordering::*;
        if !matches!((d0, d1), (Greater, Less) | (Less, Greater)) {
            return None;
        }
    }
    let (pb, pa) = (read_price(before, token_is0)?, read_price(after, token_is0)?);
    if pa == pb {
        return None;
    }
    Some(pa < pb)
}

// ---------------------------------------------------------------------------
// A confirmed feed swap, as a swap record
// ---------------------------------------------------------------------------

/// One swap the feed found and the engine confirmed.
#[derive(Clone, Debug)]
pub struct FeedSwap {
    pub tx: String,
    pub pool: WatchPool,
    pub block: u64,
    /// Position in the block, counted like a receipt's transactionIndex
    /// (Arbitrum's internal start-of-block transaction is index 0).
    pub txi: u64,
    pub signer: Option<String>,
    pub sold: bool,
    pub after: Read,
    /// ms (on the shared clock) the feed frame arrived.
    pub seen_ms: u64,
    /// ms the engine confirmed it.
    pub done_ms: u64,
}

const ONE: &str = "0000000000000000000000000000000000000000000000000000000000000001";
const MINUS_ONE: &str = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn word_of_addr(a: &str) -> String {
    format!("0x{}{}", "0".repeat(24), a.trim_start_matches("0x").to_ascii_lowercase())
}

/// The same record shape the node's eth_getLogs gives, so the swap goes
/// through the trader's ordinary log handling unchanged. Only the fields
/// the trader reads are filled:
///   V3 Swap:  topics [id, sender, recipient = signer], data amount0,
///             amount1 (signs give the direction), sqrtPriceX96, 0, 0
///   V2:       a Sync (the reserves after) then a Swap (amounts: which coin
///             went in / came out), recipient = signer
///   V4 Swap:  topics [id, poolId, sender], data amount0, amount1 (the
///             swapper's side), sqrtPriceX96, 0, 0, 0
/// Amounts carry only the DIRECTION (1 / -1), never a size: nothing in the
/// trader reads swap sizes. "_src":"feed" marks the record.
pub fn synth_logs(s: &FeedSwap) -> Vec<Value> {
    let base_is1 = s.pool.token_is0;
    let block = format!("0x{:x}", s.block);
    let txi = format!("0x{:x}", s.txi);
    let recipient = s.signer.as_deref().map(word_of_addr);
    let mk = |address: &str, topics: Vec<String>, data: String, li: u64| {
        json!({"address": address, "topics": topics, "data": format!("0x{data}"), "blockNumber": block, "transactionIndex": txi,
               "logIndex": format!("0x{li:x}"), "transactionHash": s.tx, "removed": false, "_src": "feed", "_seen_ms": s.seen_ms})
    };
    // (token word, base word) by direction, from the POOL's side (V3/V2):
    // a buy pays base IN (+) and token OUT (-).
    let (tok, base) = if s.sold { (ONE, MINUS_ONE) } else { (MINUS_ONE, ONE) };
    match (&s.pool.kind, &s.after) {
        (Kind::V3, Read::Sqrt(sp)) => {
            let (a0, a1) = if base_is1 { (tok, base) } else { (base, tok) };
            let mut topics = vec![sig_v3_swap(), word_of_addr("0x0000000000000000000000000000000000000000")];
            if let Some(r) = recipient {
                topics.push(r);
            }
            vec![mk(&s.pool.key, topics, format!("{a0}{a1}{sp}{ZERO}{ZERO}"), 0)]
        }
        (Kind::V4, Read::Sqrt(sp)) => {
            // V4 amounts are from the SWAPPER's side: the opposite signs.
            let (a0, a1) = if base_is1 { (base, tok) } else { (tok, base) };
            let topics = vec![sig_v4_swap(), s.pool.key.clone(), word_of_addr("0x0000000000000000000000000000000000000000")];
            vec![mk(V4_POOL_MANAGER, topics, format!("{a0}{a1}{sp}{ZERO}{ZERO}{ZERO}"), 0)]
        }
        (Kind::V2, Read::Reserves(r0, r1)) => {
            // Swap data: amount0In, amount1In, amount0Out, amount1Out.
            let (tok_in, base_in) = if s.sold { (ONE, ZERO) } else { (ZERO, ONE) };
            let (tok_out, base_out) = if s.sold { (ZERO, ONE) } else { (ONE, ZERO) };
            let (i0, i1, o0, o1) = if base_is1 { (tok_in, base_in, tok_out, base_out) } else { (base_in, tok_in, base_out, tok_out) };
            let mut topics = vec![crate::venue::sig_v2_swap(), word_of_addr("0x0000000000000000000000000000000000000000")];
            if let Some(r) = recipient {
                topics.push(r);
            }
            vec![
                mk(&s.pool.key, vec![crate::venue::sig_v2_sync()], format!("{r0}{r1}"), 0),
                mk(&s.pool.key, topics, format!("{i0}{i1}{o0}{o1}"), 1),
            ]
        }
        _ => vec![],
    }
}

// ---------------------------------------------------------------------------
// Merging the two sources: dedupe, order, leads, coverage
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Src {
    Feed,
    Poll,
    /// Hot-pool WebSocket push (wshot.rs): real node logs, pushed.
    Ws,
}

impl Src {
    pub fn name(self) -> &'static str {
        match self {
            Src::Feed => "feed",
            Src::Poll => "poll",
            Src::Ws => "ws",
        }
    }
}

/// What to do with one swap record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admit {
    /// First sighting, in order: the normal detector path.
    Fresh,
    /// First sighting, but the pool already has a NEWER swap from the other
    /// source (the feed missed this one): count the buyer, keep the price.
    Late,
    /// Already counted via the other source: skip.
    Dup,
}

struct Sighting {
    src: Src,
    t: u64,
}

struct PendingRush {
    pool: String,
    block: u64,
    src: Src,
    t: u64,
}

/// Counters for the report.
#[derive(Default, Debug, Clone, PartialEq)]
pub struct MergeStats {
    /// Polled swaps (tx + pool) on pools the feed was watching.
    pub polled_watched: u64,
    /// ... of which the feed had already found.
    pub polled_feed_first: u64,
    /// ... of which the feed found only afterwards.
    pub feed_after_poll: u64,
    /// All polled swaps (watched or not).
    pub polled_all: u64,
    /// Swaps the feed found.
    pub feed_swaps: u64,
    /// Records handled as late (out of order) buyers.
    pub late: u64,
    /// Hot-pool WebSocket (wshot.rs): swaps it pushed (first sightings of
    /// their own), polled swaps on pools it was subscribed to, of which it
    /// had pushed first, and swaps it pushed only after polling had them.
    pub ws_swaps: u64,
    pub polled_ws_subscribed: u64,
    pub polled_ws_first: u64,
    pub ws_after_poll: u64,
}

/// Dedupe + timing between feed and poll (one per trader run).
#[derive(Default)]
pub struct Merge {
    seen: HashMap<(String, String), Sighting>,
    order: VecDeque<(u64, (String, String))>,
    /// Newest (block, txi) applied per pool.
    newest: HashMap<String, (u64, u64)>,
    rushes: HashMap<(String, String), PendingRush>,
    /// Swap-level leads (ms the feed was ahead of polling; negative = behind).
    leads: VecDeque<f64>,
    /// Same for the hot-pool WebSocket against polling.
    ws_leads: VecDeque<f64>,
    /// Pools (V3/V2 address or V4 id) the hot-pool WebSocket is subscribed
    /// to right now (set by the trader; empty when it is off).
    pub ws_subscribed: HashSet<String>,
    pub stats: MergeStats,
    /// Lines for feedwake.jsonl (rush leads), drained by the trader.
    pub events: Vec<Value>,
}

impl Merge {
    /// One swap record from `src` at time t (ms). `at` = (block, position in
    /// the block). `watched` = the pool is on the feed's watch list (only
    /// matters for polled records: coverage).
    pub fn admit(&mut self, src: Src, tx: &str, pool: &str, at: (u64, u64), t: u64, watched: bool) -> Admit {
        self.expire(t);
        let key = (tx.to_ascii_lowercase(), pool.to_ascii_lowercase());
        if self.seen.get(&key).is_some_and(|s| s.src == src) {
            // The same source again (one transaction with several swaps in
            // one pool): handled as usual, counted once.
            return Admit::Fresh;
        }
        let ws_sub = src == Src::Poll && self.ws_subscribed.contains(&key.1);
        match src {
            Src::Poll => {
                self.stats.polled_all += 1;
                if watched {
                    self.stats.polled_watched += 1;
                }
                if ws_sub {
                    self.stats.polled_ws_subscribed += 1;
                }
            }
            Src::Feed => self.stats.feed_swaps += 1,
            Src::Ws => {}
        }
        if let Some(s) = self.seen.get(&key) {
            let first = s.src;
            let lead = t as f64 - s.t as f64;
            match (first, src) {
                // Feed vs poll: exactly as before the WebSocket existed.
                (Src::Feed, Src::Poll) => {
                    if watched {
                        self.stats.polled_feed_first += 1;
                    }
                    self.push_lead(lead);
                }
                (Src::Poll, Src::Feed) => {
                    self.stats.feed_after_poll += 1;
                    self.push_lead(-lead);
                }
                // WebSocket vs poll: its own counters.
                (Src::Ws, Src::Poll) => {
                    if ws_sub {
                        self.stats.polled_ws_first += 1;
                    }
                    push_capped(&mut self.ws_leads, lead);
                }
                (Src::Poll, Src::Ws) => {
                    self.stats.ws_after_poll += 1;
                    push_capped(&mut self.ws_leads, -lead);
                }
                // Feed vs WebSocket: only deduped.
                _ => {}
            }
            if let Some(r) = self.rushes.remove(&key) {
                self.events.push(json!({"ev": "rush_lead", "pool": r.pool, "block": r.block, "first": first.name(), "other": src.name(), "lead_ms": lead.round(), "t": r.t}));
            }
            return Admit::Dup;
        }
        if src == Src::Ws {
            self.stats.ws_swaps += 1;
        }
        self.seen.insert(key.clone(), Sighting { src, t });
        self.order.push_back((t, key));
        let n = self.newest.entry(pool.to_ascii_lowercase()).or_insert(at);
        if at < *n {
            self.stats.late += 1;
            return Admit::Late;
        }
        *n = at;
        Admit::Fresh
    }

    /// Was this (tx, pool) already seen by the OTHER source? (V2 Sync logs
    /// of a swap the other source already counted are skipped too.)
    pub fn seen_by_other(&self, src: Src, tx: &str, pool: &str) -> bool {
        self.seen.get(&(tx.to_ascii_lowercase(), pool.to_ascii_lowercase())).is_some_and(|s| s.src != src)
    }

    /// A rush was completed by this swap: wait for the other source to see
    /// the same swap, to measure who was first and by how much.
    pub fn note_rush(&mut self, src: Src, tx: &str, pool: &str, block: u64, t: u64) {
        self.rushes.insert((tx.to_ascii_lowercase(), pool.to_ascii_lowercase()), PendingRush { pool: pool.to_string(), block, src, t });
    }

    fn push_lead(&mut self, ms: f64) {
        push_capped(&mut self.leads, ms);
    }

    /// Hot-pool WebSocket leads over polling (ms; negative = it was later).
    pub fn ws_leads(&self) -> Vec<f64> {
        self.ws_leads.iter().copied().collect()
    }

    fn expire(&mut self, t: u64) {
        while let Some((old, _)) = self.order.front() {
            if t.saturating_sub(*old) <= KEEP_MS {
                break;
            }
            let (_, k) = self.order.pop_front().unwrap();
            self.seen.remove(&k);
        }
        let due: Vec<(String, String)> = self.rushes.iter().filter(|(_, r)| t.saturating_sub(r.t) > RUSH_WAIT_MS).map(|(k, _)| k.clone()).collect();
        for k in due {
            if let Some(r) = self.rushes.remove(&k) {
                self.events.push(json!({"ev": "rush_lead", "pool": r.pool, "block": r.block, "first": r.src.name(), "lead_ms": null, "other": "never", "t": r.t}));
            }
        }
    }

    pub fn json(&self) -> Value {
        let l: Vec<f64> = self.leads.iter().copied().collect();
        let s = &self.stats;
        json!({"polled_watched": s.polled_watched, "polled_feed_first": s.polled_feed_first, "feed_after_poll": s.feed_after_poll,
               "polled_all": s.polled_all, "feed_swaps": s.feed_swaps, "late": s.late,
               "swap_lead_ms_p50": crate::paper::pct(&l, 50.0), "swap_lead_ms_p95": crate::paper::pct(&l, 95.0), "swap_leads": l.len(),
               "ws_swaps": s.ws_swaps, "polled_ws_subscribed": s.polled_ws_subscribed, "polled_ws_first": s.polled_ws_first, "ws_after_poll": s.ws_after_poll,
               "ws_lead_ms_p50": crate::paper::pct(&self.ws_leads(), 50.0), "ws_lead_ms_p95": crate::paper::pct(&self.ws_leads(), 95.0), "ws_leads": self.ws_leads.len()})
    }
}

/// Keep at most 20,000 lead samples (oldest dropped first).
fn push_capped(v: &mut VecDeque<f64>, ms: f64) {
    if v.len() >= 20_000 {
        v.pop_front();
    }
    v.push_back(ms);
}

// ---------------------------------------------------------------------------
// Health (shared with the worker thread)
// ---------------------------------------------------------------------------

/// What the worker tells the trader, plus counters for the status line.
pub struct Shared {
    /// The shared clock's start (every ms value here counts from it).
    pub born: Instant,
    /// ms the last feed frame arrived (0 = never).
    pub last_frame_ms: AtomicU64,
    /// Frames given up in a row because the engine could not answer.
    pub fail_streak: AtomicU64,
    pub frames: AtomicU64,
    pub txs: AtomicU64,
    pub candidate_txs: AtomicU64,
    pub engine_reads: AtomicU64,
    pub swaps: AtomicU64,
    pub no_change: AtomicU64,
    /// Candidate transactions given up, by reason (engine "miss", "down", ...).
    pub gave_up: Mutex<HashMap<String, u64>>,
    /// ms from frame arrival to confirmed swap (recent, for p50/p95).
    pub confirm_ms: Mutex<VecDeque<f64>>,
    pub watch: RwLock<Arc<WatchIndex>>,
    pub stop: Arc<AtomicBool>,
}

impl Shared {
    pub fn new(stop: Arc<AtomicBool>) -> Arc<Self> {
        Arc::new(Shared {
            born: Instant::now(),
            last_frame_ms: AtomicU64::new(0),
            fail_streak: AtomicU64::new(0),
            frames: AtomicU64::new(0),
            txs: AtomicU64::new(0),
            candidate_txs: AtomicU64::new(0),
            engine_reads: AtomicU64::new(0),
            swaps: AtomicU64::new(0),
            no_change: AtomicU64::new(0),
            gave_up: Mutex::new(HashMap::new()),
            confirm_ms: Mutex::new(VecDeque::new()),
            watch: RwLock::new(Arc::new(WatchIndex::default())),
            stop,
        })
    }

    /// ms on the shared clock.
    pub fn now_ms(&self) -> u64 {
        self.born.elapsed().as_millis() as u64
    }

    pub fn ms_of(&self, at: Instant) -> u64 {
        at.saturating_duration_since(self.born).as_millis() as u64
    }

    /// Replace the watch list (the worker picks it up on its next frame).
    pub fn set_watch(&self, w: WatchIndex) {
        if let Ok(mut g) = self.watch.write() {
            *g = Arc::new(w);
        }
    }

    /// Healthy = a frame arrived within `stale` and the engine is answering.
    pub fn healthy(&self, stale: Duration) -> bool {
        let last = self.last_frame_ms.load(Ordering::Relaxed);
        last > 0 && self.now_ms().saturating_sub(last) <= stale.as_millis() as u64 && self.fail_streak.load(Ordering::Relaxed) < FAIL_STREAK
    }

    fn give_up(&self, why: &str) {
        if let Ok(mut g) = self.gave_up.lock() {
            *g.entry(why.to_string()).or_default() += 1;
        }
    }

    pub fn json(&self) -> Value {
        let g = |a: &AtomicU64| a.load(Ordering::Relaxed);
        let c: Vec<f64> = self.confirm_ms.lock().map(|c| c.iter().copied().collect()).unwrap_or_default();
        json!({"frames": g(&self.frames), "txs": g(&self.txs), "candidate_txs": g(&self.candidate_txs), "engine_reads": g(&self.engine_reads),
               "swaps": g(&self.swaps), "no_change": g(&self.no_change), "gave_up": self.gave_up.lock().map(|m| m.clone()).unwrap_or_default(),
               "confirm_ms_p50": crate::paper::pct(&c, 50.0), "confirm_ms_p95": crate::paper::pct(&c, 95.0),
               "watched": self.watch.read().map(|w| w.len()).unwrap_or(0)})
    }

    pub fn summary(&self) -> String {
        let j = self.json();
        format!(
            "feed wake: {} frames, {} candidate txs, {} swaps confirmed, frame->confirmed p50 {} ms, {} pools watched",
            j["frames"],
            j["candidate_txs"],
            j["swaps"],
            j["confirm_ms_p50"].as_f64().map_or("-".into(), |x| format!("{x:.1}")),
            j["watched"]
        )
    }
}

// ---------------------------------------------------------------------------
// The worker thread
// ---------------------------------------------------------------------------

/// Should we ask the engine again (it has not replayed the block yet, or it
/// is fetching a value), or give up on this transaction?
fn retryable(reason: &str) -> bool {
    matches!(reason, "dirty" | "not_ready" | "miss" | "timeout" | "unknown")
}

/// Ask until the engine answers or the deadline passes. Ok = each call's
/// output and the block the engine's state was in.
fn read_until(eng: &EngineClient, at: &Value, calls: &[(String, String)], deadline: Instant) -> Result<(Vec<Option<String>>, Option<u64>), String> {
    loop {
        match eng.call_at(at, calls) {
            Ok(r) => return Ok(r),
            Err(r) if retryable(&r) && Instant::now() + Duration::from_millis(2) < deadline => std::thread::sleep(Duration::from_millis(2)),
            Err(r) => return Err(r),
        }
    }
}

/// Handle one feed frame: every candidate transaction confirmed (or not)
/// on the engine's exact before/after state. Confirmed swaps go to `out`.
pub fn handle_frame(sh: &Shared, eng: &EngineClient, arrived: Instant, text: &str, wait: Duration, out: &Sender<FeedSwap>) {
    let seen_ms = sh.ms_of(arrived);
    sh.frames.fetch_add(1, Ordering::Relaxed);
    sh.last_frame_ms.store(seen_ms.max(1), Ordering::Relaxed);
    let watch = sh.watch.read().map(|w| w.clone()).unwrap_or_default();
    let deadline = arrived + wait;
    let mut failed = false;
    for b in feedtx::parse_frame_signed(text) {
        sh.txs.fetch_add(b.txs.len() as u64, Ordering::Relaxed);
        if watch.is_empty() {
            continue;
        }
        for (i, (tx, signer)) in b.txs.iter().enumerate() {
            let cands = watch.candidates(tx);
            if cands.is_empty() {
                continue;
            }
            sh.candidate_txs.fetch_add(1, Ordering::Relaxed);
            let calls: Vec<(String, String)> = cands.iter().map(|p| p.price_call()).collect();
            // AFTER first: it is the one that may wait for the replay.
            let after_at = json!({"afterTx": tx.hash});
            let before_at = if i == 0 { json!({"afterSeq": b.seq.saturating_sub(1)}) } else { json!({"afterTx": b.txs[i - 1].0.hash}) };
            let after = read_until(eng, &after_at, &calls, deadline);
            let before = after.as_ref().ok().map(|_| read_until(eng, &before_at, &calls, deadline));
            let ((after, after_block), before) = match (after, before) {
                (Ok(a), Some(Ok((bf, _)))) => (a, bf),
                (Err(r), _) | (Ok(_), Some(Err(r))) => {
                    sh.give_up(&r);
                    failed = true;
                    continue;
                }
                (Ok(_), None) => continue,
            };
            sh.engine_reads.fetch_add(2, Ordering::Relaxed);
            let Some(bn) = after_block else {
                sh.give_up("no_block");
                continue;
            };
            for (k, p) in cands.iter().enumerate() {
                let rb = before.get(k).cloned().flatten().and_then(|o| parse_read(p.kind, &o));
                let ra = after.get(k).cloned().flatten().and_then(|o| parse_read(p.kind, &o));
                let (Some(rb), Some(ra)) = (rb, ra) else { continue };
                match swap_direction(&rb, &ra, p.token_is0) {
                    None => {
                        sh.no_change.fetch_add(1, Ordering::Relaxed);
                    }
                    Some(sold) => {
                        let done_ms = sh.now_ms();
                        sh.swaps.fetch_add(1, Ordering::Relaxed);
                        if let Ok(mut c) = sh.confirm_ms.lock() {
                            if c.len() >= 4096 {
                                c.pop_front();
                            }
                            c.push_back(done_ms.saturating_sub(seen_ms) as f64);
                        }
                        let _ = out.send(FeedSwap { tx: tx.hash.clone(), pool: p.clone(), block: bn, txi: i as u64 + 1, signer: signer.clone(), sold, after: ra, seen_ms, done_ms });
                    }
                }
            }
        }
    }
    if failed {
        sh.fail_streak.fetch_add(1, Ordering::Relaxed);
    } else {
        sh.fail_streak.store(0, Ordering::Relaxed);
    }
}

/// Start the worker: frames from `rx` (the forwarder's tap), swaps to the
/// returned receiver. Ends when `sh.stop` is set or the tap closes.
pub fn spawn_worker(sh: Arc<Shared>, socket: &str, timeout: Duration, wait: Duration, rx: Receiver<(Instant, Arc<str>)>) -> Receiver<FeedSwap> {
    let (tx, out) = std::sync::mpsc::channel::<FeedSwap>();
    let eng = EngineClient::new(socket, timeout, "head");
    std::thread::Builder::new()
        .name("feedwake".into())
        .spawn(move || {
            let mut warmed: HashSet<String> = HashSet::new();
            loop {
                if sh.stop.load(Ordering::Relaxed) {
                    return;
                }
                match rx.recv_timeout(Duration::from_millis(200)) {
                    Ok((at, text)) => {
                        handle_frame(&sh, &eng, at, &text, wait, &tx);
                        warm_new(&sh, &eng, &mut warmed);
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
        })
        .expect("feed wake thread");
    out
}

/// Newly watched pools: read each price once on the engine's newest state,
/// so the engine fetches the pool's values now (one node read per pool, in
/// the engine's own budget) instead of answering "miss" on its first swap.
/// Answers are ignored; a pool that fails is tried again next frame.
fn warm_new(sh: &Shared, eng: &EngineClient, warmed: &mut HashSet<String>) {
    let watch = sh.watch.read().map(|w| w.clone()).unwrap_or_default();
    let fresh: Vec<&WatchPool> = watch.pools.values().filter(|p| !warmed.contains(&p.key)).take(20).collect();
    for p in fresh {
        if eng.call_at(&json!({"after": "headNow"}), &[p.price_call()]).is_ok() {
            warmed.insert(p.key.clone());
        }
    }
    if warmed.len() > 50_000 {
        warmed.clear();
    }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/// Report section: rushes first seen by feed vs poll, leads, coverage,
/// stale fallbacks, and rush -> buy ready split by source. Empty if feed
/// wake-up never ran in this folder.
pub fn report_section(dir: &Path, sig: &[Value]) -> String {
    let lines: Vec<Value> = std::fs::read_to_string(dir.join(FILE)).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    if lines.is_empty() {
        return String::new();
    }
    let p = |v: &[f64], q: f64| crate::paper::pct(v, q).map_or("-".to_string(), |x| format!("{x:.0}"));
    let mut t = String::from("feed wake-up (speed step 3):\n");
    // Only feed-vs-poll rush leads here (the hot-pool WebSocket has its own
    // section; lines from before it existed have no "other").
    let fp = |v: &Value| v.as_str().is_none_or(|x| x == "feed" || x == "poll" || x == "never");
    let leads: Vec<&Value> = lines.iter().filter(|l| l["ev"] == "rush_lead" && fp(&l["first"]) && fp(&l["other"])).collect();
    let by = |src: &str| leads.iter().filter(|l| l["first"] == src).count();
    let (feed_first, poll_first) = (by("feed"), by("poll"));
    let feed_leads: Vec<f64> = leads.iter().filter(|l| l["first"] == "feed").filter_map(|l| l["lead_ms"].as_f64()).collect();
    let poll_leads: Vec<f64> = leads.iter().filter(|l| l["first"] == "poll").filter_map(|l| l["lead_ms"].as_f64()).collect();
    let never = |src: &str| leads.iter().filter(|l| l["first"] == src && l["lead_ms"].is_null()).count();
    t += &format!(
        "  rushes first seen by feed {feed_first} (poll later on {}: by p50 {} ms, p95 {} ms; poll never {}) | by poll {poll_first} (feed later by p50 {} ms; feed never {})\n",
        feed_leads.len(),
        p(&feed_leads, 50.0),
        p(&feed_leads, 95.0),
        never("feed"),
        p(&poll_leads, 50.0),
        never("poll"),
    );
    if let Some(s) = lines.iter().rev().find(|l| l["ev"] == "stats") {
        let m = &s["merge"];
        let g = |k: &str| m[k].as_u64().unwrap_or(0);
        let cov = |a: u64, b: u64| if b > 0 { format!("{:.1}%", 100.0 * a as f64 / b as f64) } else { "-".into() };
        t += &format!(
            "  coverage: of {} polled swaps on watched pools the feed found {} first ({}) and {} later ({} in all) | all polled swaps {} | feed swaps {}\n",
            g("polled_watched"),
            g("polled_feed_first"),
            cov(g("polled_feed_first"), g("polled_watched")),
            g("feed_after_poll"),
            cov(g("polled_feed_first") + g("feed_after_poll"), g("polled_watched")),
            g("polled_all"),
            g("feed_swaps"),
        );
        t += &format!(
            "  swap-level lead (feed ahead of poll, ms): p50 {} p95 {} over {} swaps | out-of-order buyers {}\n",
            m["swap_lead_ms_p50"].as_f64().map_or("-".into(), |x| format!("{x:.0}")),
            m["swap_lead_ms_p95"].as_f64().map_or("-".into(), |x| format!("{x:.0}")),
            m["swap_leads"],
            g("late"),
        );
        let w = &s["worker"];
        let gave: Vec<String> = w["gave_up"].as_object().map(|o| o.iter().map(|(k, v)| format!("{k} {v}")).collect()).unwrap_or_default();
        t += &format!(
            "  engine confirms: {} candidate txs, {} swaps, {} no change (failed or not a swap), frame->confirmed p50 {} ms p95 {} ms | gave up: {}\n",
            w["candidate_txs"],
            w["swaps"],
            w["no_change"],
            w["confirm_ms_p50"].as_f64().map_or("-".into(), |x| format!("{x:.1}")),
            w["confirm_ms_p95"].as_f64().map_or("-".into(), |x| format!("{x:.1}")),
            if gave.is_empty() { "none".into() } else { gave.join(", ") },
        );
    }
    let stale = lines.iter().filter(|l| l["ev"] == "stale").count();
    let back = lines.iter().filter(|l| l["ev"] == "healthy").count();
    t += &format!("  feed went stale {stale} time(s) (fell back to normal polling) | healthy {back} time(s), the first at start\n");
    // Rush -> buy ready, by source (taken rushes with a delay record).
    for src in ["feed", "poll"] {
        let v: Vec<f64> = sig.iter().filter(|l| l["delay"]["src"] == src).filter_map(|l| l["delay"]["total_ms"].as_f64()).collect();
        if !v.is_empty() {
            t += &format!("  rush -> buy ready via {src}: {} buys, p50 {} ms, p95 {} ms\n", v.len(), p(&v, 50.0), p(&v, 95.0));
        }
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0x00000000000000000000000000000000000c0123";
    const POOL: &str = "0x0000000000000000000000000000000000001001";

    fn wp(kind: Kind) -> WatchPool {
        let key = if kind == Kind::V4 { format!("0x{}", "ab".repeat(32)) } else { POOL.into() };
        WatchPool { key, kind, token: TOKEN.into(), token_is0: true }
    }

    fn tx(to: &str, data: Vec<u8>) -> FeedTx {
        FeedTx { hash: "0x01".into(), to: Some(to.into()), data, value: 0 }
    }

    #[test]
    fn settings_off_by_default_and_need_the_engine() {
        let (c, w) = WakeConfig::from_lookup(|_| None, true);
        assert!(!c.on && w.is_none());
        let on = |k: &str| (k == "SNIPER_FEED_WAKE").then(|| "1".to_string());
        let (c, w) = WakeConfig::from_lookup(on, false);
        assert!(!c.on && w.is_some(), "no engine: stays off, with a warning");
        let (c, _) = WakeConfig::from_lookup(on, true);
        assert!(c.on);
        assert_eq!(c.poll_when_feed, Some(Duration::from_millis(2000)));
        let same = |k: &str| match k {
            "SNIPER_FEED_WAKE" => Some("1".to_string()),
            "SNIPER_RHC_POLL_MS_WHEN_FEED" => Some("0".to_string()),
            _ => None,
        };
        assert_eq!(WakeConfig::from_lookup(same, true).0.poll_when_feed, None, "0 = keep the normal pace");
        assert_eq!(c.stale, Duration::from_secs(5));
    }

    #[test]
    fn candidates_found_at_any_byte_position() {
        let w = WatchIndex::build([wp(Kind::V3)]);
        let t = addr20(TOKEN).unwrap();
        // ABI word (12 zero bytes then the address)
        let mut d = vec![0x04, 0xe4, 0x5a, 0xaf];
        d.extend([0u8; 12]);
        d.extend(t);
        assert_eq!(w.candidates(&tx("0x2222222222222222222222222222222222222222", d)).len(), 1);
        // packed V3 path: WETH(20) fee(3) TOKEN(20), at an odd offset
        let mut d = vec![0xb8, 0x58, 0x18, 0x3f, 0x77];
        d.extend(addr20(crate::paper::WETH).unwrap());
        d.extend([0x00, 0x0b, 0xb8]);
        d.extend(t);
        assert_eq!(w.candidates(&tx("0x2222222222222222222222222222222222222222", d)).len(), 1);
        // direct call to the pool, no token in the data
        assert_eq!(w.candidates(&tx(POOL, vec![0x12, 0x34, 0x56, 0x78])).len(), 1);
        // unrelated
        assert!(w.candidates(&tx("0x2222222222222222222222222222222222222222", vec![0u8; 100])).is_empty());
    }

    #[test]
    fn v4_pools_are_matched_by_token_not_by_id() {
        let w = WatchIndex::build([wp(Kind::V4)]);
        assert!(w.candidates(&tx(POOL, vec![1, 2, 3, 4])).is_empty());
        let mut d = vec![0u8; 12];
        d.extend(addr20(TOKEN).unwrap());
        assert_eq!(w.candidates(&tx(crate::rhc::V4_POOL_MANAGER, d))[0].kind, Kind::V4);
    }

    #[test]
    fn price_calls_have_the_right_selectors() {
        assert_eq!(wp(Kind::V3).price_call().1, "0x3850c7bd");
        assert_eq!(wp(Kind::V2).price_call().1, "0x0902f1ac");
        let (to, data) = wp(Kind::V4).price_call();
        assert_eq!(to, crate::rhc::V4_POOL_MANAGER);
        assert!(data.starts_with("0x1e2eaeaf") && data.len() == 10 + 64);
    }

    fn w(n: u128) -> String {
        format!("{n:064x}")
    }

    #[test]
    fn reads_and_directions() {
        // V4 packed slot: high bits (tick, fees) are ignored.
        let packed = format!("0x{}{}", "ff".repeat(12), &w(1u128 << 96)[24..]);
        assert_eq!(parse_read(Kind::V4, &packed), Some(Read::Sqrt(w(1u128 << 96))));
        let a = Read::Sqrt(w(1u128 << 96));
        let b = Read::Sqrt(w(2u128 << 96));
        // token is token0: price = (sqrt/2^96)^2 goes up = a buy
        assert_eq!(swap_direction(&a, &b, true), Some(false));
        assert_eq!(swap_direction(&b, &a, true), Some(true));
        // token is token1: the other way round
        assert_eq!(swap_direction(&a, &b, false), Some(true));
        // nothing changed (a failed transaction): no swap
        assert_eq!(swap_direction(&a, &a, true), None);
        // V2: token0 reserve down, base reserve up = buy of token0
        let r = |x: u128, y: u128| Read::Reserves(w(x), w(y));
        assert_eq!(swap_direction(&r(1000, 1000), &r(900, 1112), true), Some(false));
        assert_eq!(swap_direction(&r(1000, 1000), &r(1112, 900), true), Some(true));
        // liquidity add / remove (both the same way): not a swap
        assert_eq!(swap_direction(&r(1000, 1000), &r(2000, 2000), true), None);
        assert_eq!(swap_direction(&r(1000, 1000), &r(1000, 1100), true), None, "donation + sync: not a swap");
    }

    fn fs(kind: Kind, sold: bool, after: Read) -> FeedSwap {
        FeedSwap { tx: "0xaa".into(), pool: wp(kind), block: 77, txi: 3, signer: Some("0x00000000000000000000000000000000000000b1".into()), sold, after, seen_ms: 5, done_ms: 6 }
    }

    #[test]
    fn swap_records_read_back_like_node_logs() {
        use crate::paper::{is_sell_swap, swap_buyer};
        let sp = Read::Sqrt(w(1u128 << 96));
        for sold in [false, true] {
            // V3: same sell test and buyer the polled path uses
            let l = &synth_logs(&fs(Kind::V3, sold, sp.clone()))[0];
            let ws = crate::venue::words(l["data"].as_str().unwrap());
            assert_eq!(is_sell_swap(&ws, true), sold);
            assert_eq!(swap_buyer(l), "0x00000000000000000000000000000000000000b1");
            assert_eq!(ws[2], w(1u128 << 96));
            assert_eq!(crate::fourmeme::hex_u64(l.get("blockNumber")), 77);
            // V4
            let l = &synth_logs(&fs(Kind::V4, sold, sp.clone()))[0];
            let ws = crate::venue::words(l["data"].as_str().unwrap());
            assert_eq!(crate::venue::is_sell_v4(&ws, true), sold);
            assert_eq!(l["topics"][1], wp(Kind::V4).key);
            assert_eq!(crate::venue::swap_buyer_v4(l), "0xaa");
            // V2: Sync first (reserves), then Swap
            let ls = synth_logs(&fs(Kind::V2, sold, Read::Reserves(w(9), w(10))));
            assert_eq!(ls.len(), 2);
            assert_eq!(crate::venue::v2_reserves(ls[0]["data"].as_str().unwrap()), Some((ruint::aliases::U256::from(9u64), ruint::aliases::U256::from(10u64))));
            let ws = crate::venue::words(ls[1]["data"].as_str().unwrap());
            assert_eq!(crate::venue::is_sell_v2(&ws, true), sold);
        }
    }

    #[test]
    fn dedupe_counts_a_swap_once_and_measures_the_lead() {
        let mut m = Merge::default();
        assert_eq!(m.admit(Src::Feed, "0xA", POOL, (10, 2), 1000, true), Admit::Fresh);
        m.note_rush(Src::Feed, "0xA", POOL, 10, 1000);
        // the node shows the same swap 650 ms later: skipped, lead recorded
        assert_eq!(m.admit(Src::Poll, "0xa", POOL, (10, 2), 1650, true), Admit::Dup);
        // the same source showing a second swap of one transaction: normal
        assert_eq!(m.admit(Src::Feed, "0xA", POOL, (10, 2), 1660, true), Admit::Fresh);
        assert_eq!(m.events.len(), 1);
        assert_eq!(m.events[0]["first"], "feed");
        assert_eq!(m.events[0]["lead_ms"], 650.0);
        // a swap the feed missed, older than what the feed applied: late
        assert_eq!(m.admit(Src::Poll, "0xB", POOL, (10, 1), 1700, true), Admit::Late);
        // a newer polled swap: normal
        assert_eq!(m.admit(Src::Poll, "0xC", POOL, (11, 1), 1800, true), Admit::Fresh);
        // the feed finds 0xC afterwards: skipped, counted as "feed later"
        assert_eq!(m.admit(Src::Feed, "0xC", POOL, (11, 1), 1850, true), Admit::Dup);
        let s = &m.stats;
        assert_eq!((s.polled_watched, s.polled_feed_first, s.feed_after_poll, s.late), (3, 1, 1, 1));
        let j = m.json();
        assert_eq!(j["swap_leads"], 2);
        // V2 Sync of a swap the other source counted is recognised
        assert!(m.seen_by_other(Src::Poll, "0xa", POOL));
        assert!(!m.seen_by_other(Src::Feed, "0xa", POOL));
    }

    #[test]
    fn a_rush_the_other_source_never_sees_is_closed() {
        let mut m = Merge::default();
        m.admit(Src::Poll, "0xA", POOL, (10, 1), 0, true);
        m.note_rush(Src::Poll, "0xA", POOL, 10, 0);
        m.admit(Src::Poll, "0xB", POOL, (11, 1), RUSH_WAIT_MS + 1, true);
        assert_eq!(m.events.len(), 1);
        assert_eq!(m.events[0]["other"], "never");
        assert!(m.events[0]["lead_ms"].is_null());
    }

    #[test]
    fn health_goes_stale_without_frames_and_with_engine_failures() {
        let sh = Shared::new(Arc::new(AtomicBool::new(false)));
        assert!(!sh.healthy(Duration::from_secs(5)), "no frame yet");
        sh.last_frame_ms.store(sh.now_ms().max(1), Ordering::Relaxed);
        assert!(sh.healthy(Duration::from_secs(5)));
        sh.fail_streak.store(FAIL_STREAK, Ordering::Relaxed);
        assert!(!sh.healthy(Duration::from_secs(5)), "engine failing");
        sh.fail_streak.store(0, Ordering::Relaxed);
        sh.last_frame_ms.store(1, Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(30));
        assert!(!sh.healthy(Duration::from_millis(10)), "old frame");
    }

    /// Real-shaped feed frame: batch of signed txs (live sender's signer).
    fn signed_frame(seq: u64, txs: &[Vec<u8>]) -> String {
        let mut l2 = vec![3u8];
        for body in txs {
            let mut inner = vec![4u8];
            inner.extend(body);
            l2.extend((inner.len() as u64).to_be_bytes());
            l2.extend(inner);
        }
        const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut b64 = String::new();
        for c in l2.chunks(3) {
            let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
            for i in 0..=c.len() {
                b64.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            }
        }
        json!({"version": 1, "messages": [{"sequenceNumber": seq, "message": {"message": {"header": {"kind": 3, "timestamp": 1_700_000_000u64}, "l2Msg": b64}}}]}).to_string()
    }

    /// A signed router call whose data names TOKEN (like exactInputSingle).
    fn signed_swap(s: &crate::live::Signer, nonce: u64) -> crate::live::SignedTx {
        let data = crate::live::data_swap(crate::paper::WETH, TOKEN, 3000, s.address(), ruint::aliases::U256::from(10u64), ruint::aliases::U256::ZERO, 99).unwrap();
        s.sign(&crate::live::TxFields { nonce, max_priority_fee: 0, max_fee: 1, gas_limit: 300_000, to: crate::live::SWAP_ROUTER_02.into(), value: ruint::aliases::U256::ZERO, data }).unwrap()
    }

    #[test]
    fn frame_to_confirmed_swaps_and_failed_tx_excluded() {
        use std::os::unix::net::UnixListener;
        let a = crate::live::Signer::random().unwrap();
        let b = crate::live::Signer::random().unwrap();
        let (t1, t2) = (signed_swap(&a, 0), signed_swap(&b, 0));
        let frame = signed_frame(41, &[t1.raw.clone(), t2.raw.clone()]);
        // Fake engine: before tx1 price word 1, after tx1 = 2, after tx2 = 2
        // (tx2 reverted: no change). The first 3 questions get "not_ready"
        // (the engine has not replayed the frame yet).
        let path = std::env::temp_dir().join(format!("sniper-fw-{}.sock", std::process::id())).to_string_lossy().to_string();
        let _ = std::fs::remove_file(&path);
        let l = UnixListener::bind(&path).unwrap();
        let (h1, h2) = (t1.hash.clone(), t2.hash.clone());
        std::thread::spawn(move || {
            let asked = Arc::new(AtomicU64::new(0));
            for c in l.incoming() {
                let Ok(mut c) = c else { continue };
                let (h1, h2, asked) = (h1.clone(), h2.clone(), asked.clone());
                std::thread::spawn(move || {
                    while let Ok(Some(m)) = crate::engine::read_msg(&mut c) {
                        let v: Value = serde_json::from_slice(&m).unwrap();
                        let at = &v["at"];
                        let price = if at["afterSeq"] == json!(40) {
                            Some(1u128)
                        } else if at["afterTx"] == json!(h1) || at["afterTx"] == json!(h2) {
                            Some(2)
                        } else {
                            None
                        };
                        let ans = if asked.fetch_add(1, Ordering::Relaxed) < 3 {
                            json!({"id": v["id"], "ok": false, "unknown": "not_ready"})
                        } else {
                            match price {
                                Some(p) => json!({"id": v["id"], "ok": true, "at": {"block": "0x1f4"}, "results": [{"success": true, "output": format!("0x{:064x}{:064x}", p << 96, 0)}]}),
                                None => json!({"id": v["id"], "ok": false, "unknown": "stale"}),
                            }
                        };
                        let _ = crate::engine::write_msg(&mut c, &serde_json::to_vec(&ans).unwrap());
                    }
                });
            }
        });
        let sh = Shared::new(Arc::new(AtomicBool::new(false)));
        sh.set_watch(WatchIndex::build([wp(Kind::V3)]));
        let eng = EngineClient::new(&path, Duration::from_millis(200), "head");
        let (tx, rx) = std::sync::mpsc::channel();
        handle_frame(&sh, &eng, Instant::now(), &frame, Duration::from_millis(500), &tx);
        let got: Vec<FeedSwap> = rx.try_iter().collect();
        assert_eq!(got.len(), 1, "only tx1 moved the price: {got:?}");
        let g = &got[0];
        assert_eq!(g.tx, t1.hash);
        assert_eq!(g.block, 500);
        assert_eq!(g.txi, 1);
        assert_eq!(g.signer.as_deref(), Some(a.address()));
        assert!(!g.sold, "price of token0 went up: a buy");
        assert_eq!(sh.no_change.load(Ordering::Relaxed), 1, "the failed tx2 made no swap");
        assert_eq!(sh.candidate_txs.load(Ordering::Relaxed), 2);
        assert!(sh.healthy(Duration::from_secs(5)));
        // The same frame with an engine that never answers: given up, counted.
        let dead = EngineClient::new("/nonexistent/sniper-fw.sock", Duration::from_millis(20), "head");
        handle_frame(&sh, &dead, Instant::now(), &frame, Duration::from_millis(50), &tx);
        assert!(rx.try_iter().next().is_none());
        assert!(sh.json()["gave_up"]["down"].as_u64().unwrap() >= 1);
        assert_eq!(sh.fail_streak.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn report_section_counts_sources() {
        let dir = std::env::temp_dir().join(format!("sniper-fw-report-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let lines = [
            json!({"ev": "rush_lead", "first": "feed", "lead_ms": 600.0}),
            json!({"ev": "rush_lead", "first": "feed", "lead_ms": 700.0}),
            json!({"ev": "rush_lead", "first": "poll", "lead_ms": 20.0}),
            json!({"ev": "stale"}),
            json!({"ev": "healthy"}),
            json!({"ev": "stats", "merge": {"polled_watched": 100, "polled_feed_first": 95, "feed_after_poll": 2, "polled_all": 300, "feed_swaps": 120, "late": 1, "swap_lead_ms_p50": 610.0, "swap_lead_ms_p95": 900.0, "swap_leads": 97},
                   "worker": {"candidate_txs": 150, "swaps": 120, "no_change": 30, "confirm_ms_p50": 3.2, "confirm_ms_p95": 9.0, "gave_up": {"miss": 2}}}),
        ];
        std::fs::write(dir.join(FILE), lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n")).unwrap();
        let sig = vec![json!({"taken": true, "delay": {"src": "feed", "total_ms": 150.0}}), json!({"taken": true, "delay": {"src": "poll", "total_ms": 800.0}})];
        let t = report_section(&dir, &sig);
        assert!(t.contains("rushes first seen by feed 2"), "{t}");
        assert!(t.contains("by poll 1"), "{t}");
        assert!(t.contains("found 95 first (95.0%)"), "{t}");
        assert!(t.contains("97.0% in all"), "{t}");
        assert!(t.contains("stale 1 time"), "{t}");
        assert!(t.contains("via feed: 1 buys, p50 150 ms"), "{t}");
        assert!(t.contains("gave up: miss 2"), "{t}");
        assert!(report_section(&dir.join("nothing"), &[]).is_empty());
    }
}
