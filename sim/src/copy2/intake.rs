// ============================================================================
// COPY 2 INTAKE: the one thread that keeps our pools' copy current from the
// pools' own events (ARBSIM_SOURCE=pool-events). See sim/COPY2_PLAN.md.
//
// Plain English - what comes in (from the bot, over the socket):
//   track       the list of pools to follow (re-sent when it changes)
//   pool_logs   one message per block that has events on our pools: the
//               pools' own reports + coin Transfer reports to/from them
//   block_tick  "block N had nothing for you" (keeps the copy current)
//   + `warm` / items checks missed (fetched from the node, see "fills")
//
// Each pool is in one of three states:
//   loading  its values are being fetched in the background (first time,
//            or after it went unsure / needed more values)
//   ready    every event is applied: V2 / Solidly by writing the numbers
//            the event states (fields.rs), V3 / PancakeSwap V3 / Algebra /
//            V4 by re-running the action with the pool's own code
//            (replay.rs)
//   unsure   an event couldn't be applied exactly, or a reorg / gap hit it.
//            Its values are FORGOTTEN (checks touching it answer
//            "unknown: unsure_pool" and the bot asks the node), and it is
//            reloaded after a short wait (longer each time it happens).
//
// THE MOST IMPORTANT RULE: this thread NEVER waits for the node. Applying
// each block takes microseconds; a node answer takes 100+ ms. So:
//   1. Blocks first, always, in order: apply the block's events to the pools
//      that are ready, publish the result as the next Version (mirror.rs),
//      so `call` / `size_search` at {"after":"head"} / {"block":N} read it.
//      Every block's reports are also kept in a short history ("buffer",
//      ARBSIM_COPY2_KEEP_BLOCKS, default 2400 blocks = about 10 minutes).
//   2. Node questions go to the loader threads (loader.rs): paid node first,
//      many questions per request. A pool to load is fetched AT block k
//      (the newest block at that moment). When the answer comes back, the
//      chain has moved on to block B, so the pool's own reports for blocks
//      k+1..B are taken from the buffer and applied to the fetched values
//      ("carried forward"), in a private working copy. If the carry needs a
//      value we don't have yet (a replay touched a new tick, say), that
//      value is fetched at the block right before the report that needs it,
//      and the carry continues from there. Once the working copy reaches B,
//      its values are put into the newest version and the pool is READY.
//   3. A ready replay pool whose event needs a value we don't have doesn't
//      wait either: it becomes "loading" at that report, the value is
//      fetched in the background, and the carry continues as in 2.
//   4. Fills (values a check missed) are fetched in the background at block
//      k and only used if nothing we follow touched them after k.
//   5. The bot's websocket reports run a few blocks AHEAD of what the node
//      answers over HTTP: loads are fetched at the newest block the NODE has
//      (loader.rs) and carried forward from there. A node error is never
//      read as "not found": the pool / coin is simply asked about again.
//   6. Late reports, PER POOL: the bot hears reports on many separate
//      subscriptions, so a pool's coin Transfer often arrives after its
//      block was already applied. A message about an already-applied block
//      N adds the reports we didn't have yet. For each pool they touch: if
//      that pool has nothing applied AFTER that report, the report is
//      applied to it (exact: its state hasn't moved since) and written into
//      every kept version from N on. Otherwise that pool alone is unsure.
//      Same for coin Transfers (per coin + pool). Only `removed` reports are
//      a reorg.
//   7. Where a coin keeps a pool's balance: the coin's general layout (probe,
//      or the bot's `coin_slots`), else EXACTLY per pool: debug_traceCall of
//      balanceOf(pool) with the prestate tracer lists the coin storage slots
//      read; the one slot whose value equals the balance is it (works for
//      namespaced / proxy / odd layouts). No single match -> pool unsure.
//   8. READY means a check can run on the pool: its code and the slots its
//      swap reads are loaded with it (not only what its events change), plus
//      its coins' code and what their balanceOf reads.
//
// Strict, always: a value we don't hold is MISSING (never zero); a pool we
// can't follow exactly is unsure. Node reads use the daily allowance
// (node.rs classes) and are counted in status (copy2.nodeRequests).
// ============================================================================
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use revm::primitives::{keccak256, Address, Bytes, B256, U256};
use serde_json::{json, Value};

use super::coins::{balance_of_data, BalanceLayout};
use super::fields::{apply_fields, core_slots, map_slot, obs_slot, sol, topic_addr, topics, v2};
use super::loader::{out_word, Done, FetchOut, Job, LoaderStats, Loaders, NOT_YET};
use super::overlay::Overlay;
use super::replay::{apply_replay, finish_block};
use super::{ApplyResult, BlockCtx as ReplayCtx, PoolKind, PoolLog, TrackedPool};
use crate::arb::{self, BlockCtx};
use crate::check::hexutil::{parse_address, parse_bytes, parse_u256, parse_u64, to_hex};
use crate::node::{env_u64, Fetched, ItemErr};
use crate::state::fill::{account_info, reconcile, rewrite_from, FillQueue};
use crate::state::mirror::{Shared, Version};
use crate::state::snap::{Basics, Fact, Snapshot};
use crate::state::{Lookup, MissItem, StateDiff, StatePosition, StateRead};

// ---------------------------------------------------------------------------
// Wire shapes (what the bot sends), parsed in the socket thread
// ---------------------------------------------------------------------------
/// One block's worth of reports (or a tick: no logs).
#[derive(Clone, Debug)]
pub struct BlockMsg {
    pub block: u64,
    pub timestamp: u64,
    /// Parent-chain block number (NUMBER opcode). None = not given (the
    /// previous block's value is reused).
    pub l1_block: Option<u64>,
    pub base_fee: Option<u64>,
    /// The block of the bot's previous pool_logs / block_tick message, if the
    /// bot says it: lets us notice a lost message (-> everything reloaded).
    pub prev_block: Option<u64>,
    pub logs: Vec<PoolLog>,
    pub tick: bool,
}

/// Pool kind from the bot's name for it.
pub fn parse_kind(s: &str) -> Option<PoolKind> {
    Some(match s.to_ascii_lowercase().as_str() {
        "v2" | "uniswap-v2" | "univ2" => PoolKind::V2,
        "solidly" | "velodrome" | "velodrome-v2" => PoolKind::Solidly,
        "v3" | "uniswap-v3" | "univ3" => PoolKind::V3,
        "pancake-v3" | "pancakev3" | "pancake" => PoolKind::PancakeV3,
        "algebra" | "algebra-integral" => PoolKind::Algebra,
        "v4" | "uniswap-v4" | "univ4" => PoolKind::V4,
        _ => return None,
    })
}

pub fn kind_name(k: PoolKind) -> &'static str {
    match k {
        PoolKind::V2 => "v2",
        PoolKind::Solidly => "solidly",
        PoolKind::V3 => "v3",
        PoolKind::PancakeV3 => "pancake-v3",
        PoolKind::Algebra => "algebra",
        PoolKind::V4 => "v4",
    }
}

fn num(v: Option<&Value>) -> Option<u64> {
    match v? {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => parse_u64(s).ok(),
        _ => None,
    }
}

fn b256(s: &str) -> Result<B256, String> {
    Ok(B256::from(parse_u256(s)?.to_be_bytes::<32>()))
}

/// `track` request -> pools (+ coin balance places the bot already knows).
/// Pools with an unknown kind or bad fields are returned as errors (skipped).
pub fn parse_track(v: &Value) -> Result<(Vec<TrackedPool>, Vec<(Address, BalanceLayout)>, Vec<String>), String> {
    let arr = v.get("pools").and_then(|x| x.as_array()).ok_or("track: `pools` list expected")?;
    let mut out = Vec::new();
    let mut skipped = Vec::new();
    for p in arr {
        let one = (|| -> Result<TrackedPool, String> {
            let s = |k: &str| p.get(k).and_then(|x| x.as_str()).ok_or(format!("{k} missing"));
            let kind_s = s("kind")?;
            let kind = parse_kind(kind_s).ok_or(format!("kind '{kind_s}' not supported"))?;
            let v4_id = match p.get("v4Id").and_then(|x| x.as_str()) {
                Some(h) => Some(b256(h)?),
                None => None,
            };
            if (kind == PoolKind::V4) != v4_id.is_some() {
                return Err("v4Id must be given for (and only for) kind v4".into());
            }
            Ok(TrackedPool {
                address: parse_address(s("address")?)?,
                v4_id,
                kind,
                token0: parse_address(s("token0")?)?,
                token1: parse_address(s("token1")?)?,
                fee: num(p.get("fee")).unwrap_or(0) as u32,
                tick_spacing: p.get("tickSpacing").and_then(|x| x.as_i64()).unwrap_or(0) as i32,
            })
        })();
        match one {
            Ok(tp) => out.push(tp),
            Err(e) => skipped.push(format!("{}: {e}", p.get("address").and_then(|x| x.as_str()).unwrap_or("?"))),
        }
    }
    Ok((out, parse_coin_slots(v), skipped))
}

/// `coinSlots` of a `track` / `coin_slots` message: the bot's
/// data/balance-slots.json content, {"robinhood:0xtoken": {"layout":
/// "solidity"|"vyper", "slot": N}, ...} (the "chain:" prefix is optional).
pub fn parse_coin_slots(v: &Value) -> Vec<(Address, BalanceLayout)> {
    let mut layouts = Vec::new();
    if let Some(m) = v.get("coinSlots").and_then(|x| x.as_object()) {
        for (k, l) in m {
            let a = k.rsplit(':').next().unwrap_or(k);
            if let (Ok(addr), Some(l)) = (parse_address(a), BalanceLayout::from_json(l)) {
                layouts.push((addr, l));
            }
        }
    }
    layouts
}

/// One raw eth log (as JSON-RPC / websocket gives it).
pub fn parse_log(v: &Value, block: u64) -> Result<PoolLog, String> {
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).ok_or(format!("log.{k} missing"));
    let topics = v
        .get("topics")
        .and_then(|x| x.as_array())
        .ok_or("log.topics missing")?
        .iter()
        .map(|t| t.as_str().ok_or("topic not text".to_string()).and_then(b256))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(PoolLog {
        address: parse_address(s("address")?)?,
        topics,
        data: parse_bytes(v.get("data").and_then(|x| x.as_str()).unwrap_or("0x"))?,
        block: num(v.get("blockNumber")).unwrap_or(block),
        tx_index: num(v.get("transactionIndex")).ok_or("log.transactionIndex missing")? as u32,
        log_index: num(v.get("logIndex")).ok_or("log.logIndex missing")? as u32,
        tx_hash: v.get("transactionHash").and_then(|x| x.as_str()).map(b256).transpose()?.unwrap_or_default(),
        removed: v.get("removed").and_then(|x| x.as_bool()).unwrap_or(false),
    })
}

/// `pool_logs` / `block_tick` request -> BlockMsg.
pub fn parse_block_msg(v: &Value) -> Result<BlockMsg, String> {
    let tick = v.get("type").and_then(|t| t.as_str()) == Some("block_tick");
    let block = num(v.get("block")).ok_or("block missing")?;
    let timestamp = num(v.get("timestamp")).ok_or("timestamp missing")?;
    let mut logs = Vec::new();
    if !tick {
        for l in v.get("logs").and_then(|x| x.as_array()).ok_or("logs list missing")? {
            logs.push(parse_log(l, block)?);
        }
    }
    Ok(BlockMsg {
        block,
        timestamp,
        l1_block: num(v.get("l1Block")),
        base_fee: num(v.get("baseFee")),
        prev_block: num(v.get("prevBlock")),
        logs,
        tick,
    })
}


// ---------------------------------------------------------------------------
// Shared registry (read by the socket threads for status / answers)
// ---------------------------------------------------------------------------
/// A pool is identified by its address, plus its id for V4.
pub type PoolKey = (Address, Option<B256>);

pub fn key_of(p: &TrackedPool) -> PoolKey {
    (p.address, p.v4_id)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PoolState {
    Loading,
    Ready,
    Unsure,
}

#[derive(Clone, Debug)]
pub struct PoolEntry {
    pub pool: TrackedPool,
    pub state: PoolState,
    /// Why it's unsure / loading (or the last reason it was).
    pub reason: String,
    /// Events applied since tracking began.
    pub events: u64,
    /// Times it went unsure in a row (decides the wait before reloading).
    pub strikes: u32,
    /// Events applied since it was last loaded (resets strikes at 50).
    pub clean_events: u64,
    /// When it may be (re)loaded.
    pub retry_at: Instant,
    /// Other accounts its replays change (e.g. an Algebra plugin).
    pub owned: Vec<Address>,
    /// The storage values of this pool we hold and follow (pool contract,
    /// owned accounts, its V4 PoolManager slots). Forgotten together.
    pub items: HashSet<(Address, U256)>,
    /// Accounts whose basics / code it needs (fetched again on reload).
    pub accounts: HashSet<Address>,
    /// Storage layout checked against the pool's getters.
    pub verified: bool,
    /// Changes every time the pool stops being ready (old answers ignored).
    pub gen: u64,
    /// Block from which it has been ready.
    pub ready_since: u64,
    /// A background load is running for it.
    pub busy: bool,
    pub ever_ready: bool,
    /// Fetch rounds of the current load.
    pub rounds: u32,
    /// Failed load attempts in a row (node trouble): decides the wait.
    pub fails: u32,
}

/// Everything about the followed pools (behind one lock).
#[derive(Default)]
pub struct Registry {
    pub pools: HashMap<PoolKey, PoolEntry>,
    /// Address -> pools at it (several for a V4 PoolManager).
    pub by_addr: HashMap<Address, Vec<PoolKey>>,
    /// Coin -> where it keeps balances (None = looked, not found).
    pub layouts: HashMap<Address, Option<BalanceLayout>>,
    /// Coin -> addresses whose balance of it we follow (our pools).
    pub holders: HashMap<Address, HashSet<Address>>,
    /// Owned account -> its pool.
    pub owner_of: HashMap<Address, PoolKey>,
    /// When a coin's balance place was judged "not found" (asked again
    /// after ARBSIM_COPY2_LAYOUT_RETRY_S).
    pub not_found_at: HashMap<Address, Instant>,
    /// (coin, pool) -> the slot holding that pool's balance, found by a
    /// trace (coins without a general layout).
    pub pair_slots: HashMap<(Address, Address), U256>,
}

impl Registry {
    fn rebuild_index(&mut self) {
        self.by_addr.clear();
        self.holders.clear();
        self.owner_of.clear();
        for (k, e) in &self.pools {
            self.by_addr.entry(k.0).or_default().push(*k);
            for c in [e.pool.token0, e.pool.token1] {
                if c != Address::ZERO {
                    self.holders.entry(c).or_default().insert(e.pool.address);
                }
            }
            for o in &e.owned {
                self.owner_of.insert(*o, *k);
            }
        }
    }

    /// The storage slot holding `holder`'s balance of `coin`, if known.
    pub fn bal_slot(&self, coin: Address, holder: Address) -> Option<U256> {
        match self.layouts.get(&coin) {
            Some(Some(l)) => Some(l.key(holder)),
            _ => self.pair_slots.get(&(coin, holder)).copied(),
        }
    }

    /// Pools whose state an account's storage belongs to.
    fn pools_of(&self, a: &Address) -> Vec<PoolKey> {
        let mut v = self.by_addr.get(a).cloned().unwrap_or_default();
        if let Some(k) = self.owner_of.get(a) {
            v.push(*k);
        }
        v
    }

    /// May the node's value for this account be put into the copy now?
    /// No while a pool it belongs to isn't ready (its events aren't being
    /// applied). For a V4 PoolManager: while any of its pools isn't ready.
    pub fn blocked_account(&self, a: &Address) -> Option<String> {
        for k in self.pools_of(a) {
            let e = &self.pools[&k];
            if e.state != PoolState::Ready {
                return Some(format!("{} pool {} is {}: {}", kind_name(e.pool.kind), e.pool.address, state_name(e.state), e.reason));
            }
        }
        None
    }

    fn counts(&self) -> (usize, usize, usize) {
        let mut c = (0, 0, 0);
        for e in self.pools.values() {
            match e.state {
                PoolState::Loading => c.0 += 1,
                PoolState::Ready => c.1 += 1,
                PoolState::Unsure => c.2 += 1,
            }
        }
        c
    }
}

pub fn state_name(s: PoolState) -> &'static str {
    match s {
        PoolState::Loading => "loading",
        PoolState::Ready => "ready",
        PoolState::Unsure => "unsure",
    }
}

macro_rules! c2counters {
    ($($name:ident),* $(,)?) => {
        /// Copy-2 counters (all since start), shown in `status`.
        #[derive(Debug, Default)]
        pub struct C2Stats { $(pub $name: AtomicU64,)* }
        impl C2Stats {
            pub fn json(&self) -> serde_json::Map<String, Value> {
                let mut m = serde_json::Map::new();
                $( m.insert(stringify!($name).into(), Value::from(self.$name.load(Ordering::Relaxed))); )*
                m
            }
        }
    };
}

c2counters!(
    msgs, msgs_bad, ticks, blocks, logs, events_applied, events_skipped_not_ready, events_unsure, coin_transfers,
    coin_slot_mismatch, other_side_forgotten, logs_ignored, duplicate_blocks, reorgs, gaps, loads, load_ok,
    load_failed, unsure_marked, need_item_rounds, node_errors, fills, fill_items, fill_refused, fill_retry,
    probes, probe_not_found, probe_errors, track_msgs, dropped_msgs, carried_events, carry_too_old, merges, apply_us_max,
    late_reports_applied, late_reports_unsure, coin_slot_msgs, throttled, layouts_guessed, coin_traces, coin_trace_found, coin_trace_not_found,
);

fn inc(c: &AtomicU64) {
    c.fetch_add(1, Ordering::Relaxed);
}
fn add(c: &AtomicU64, n: u64) {
    c.fetch_add(n, Ordering::Relaxed);
}

/// The last finished load round (for status and the log).
#[derive(Clone, Debug, Default)]
pub struct LoadRound {
    pub pools: usize,
    pub seconds: f64,
    pub requests: u64,
    pub ready: usize,
    pub unsure: usize,
    pub done: bool,
    /// Outcomes during the round (events, not pools: a pool retried after a
    /// node error counts each time).
    pub out: Outcomes,
}

/// What happened to loads in a round.
#[derive(Clone, Copy, Debug, Default)]
pub struct Outcomes {
    pub ready: u64,
    pub coin_not_found: u64,
    pub node_error: u64,
    pub mismatch: u64,
    pub other_unsure: u64,
}

impl Outcomes {
    fn text(&self) -> String {
        format!(
            "{} ready, {} coin balance place not found, {} node errors (retried), {} layout/balance mismatch, {} other unsure",
            self.ready, self.coin_not_found, self.node_error, self.mismatch, self.other_unsure
        )
    }
}

/// What the socket threads share with the intake thread.
pub struct C2Shared {
    pub reg: RwLock<Registry>,
    pub stats: C2Stats,
    /// Newest block applied (0 = none yet).
    pub last_block: AtomicU64,
    /// Node requests made by copy 2 (each call in a batch counts as one).
    pub node_requests: Arc<AtomicU64>,
    pub load_round: Mutex<LoadRound>,
    /// Node's newest block as the loaders last saw it.
    pub node_tip: Arc<AtomicU64>,
    /// Newest block applied, shared with the loaders.
    pub head_block: Arc<AtomicU64>,
    /// Items checks found missing, by class (status).
    pub misses: Mutex<HashMap<String, u64>>,
    /// What the loader threads are doing (status).
    pub loader: Arc<LoaderStats>,
    /// Background work in flight (for status): (node jobs, pools carrying).
    pub in_flight: Mutex<(usize, usize)>,
}

// ---------------------------------------------------------------------------
// Handle (socket threads -> intake thread)
// ---------------------------------------------------------------------------
pub enum Input {
    Track(Vec<TrackedPool>, Vec<(Address, BalanceLayout)>),
    Block(BlockMsg),
    Fill(Vec<MissItem>),
    /// Coin balance places the bot already knows (`coin_slots` / `track`).
    Layouts(Vec<(Address, BalanceLayout)>),
    /// An answer from a loader thread.
    Done(Done),
    Stop,
}

#[derive(Clone)]
pub struct Copy2Handle {
    tx: SyncSender<Input>,
    pub sh: Arc<Shared>,
    pub c2: Arc<C2Shared>,
}

/// Group reasons: addresses / numbers replaced so the same kind counts once.
fn reason_key(r: &str) -> String {
    let mut out = String::new();
    let mut chars = r.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '0' && chars.peek() == Some(&'x') {
            chars.next();
            while chars.peek().is_some_and(|x| x.is_ascii_hexdigit()) {
                chars.next();
            }
            out.push_str("0x..");
        } else if c.is_ascii_digit() {
            while chars.peek().is_some_and(|x| x.is_ascii_digit()) {
                chars.next();
            }
            out.push('N');
        } else {
            out.push(c);
        }
    }
    out.chars().take(80).collect()
}

fn top_reasons<'a>(it: impl Iterator<Item = &'a str>) -> Vec<Value> {
    let mut m: HashMap<String, u64> = HashMap::new();
    for r in it {
        *m.entry(reason_key(r)).or_default() += 1;
    }
    let mut v: Vec<(String, u64)> = m.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    v.truncate(10);
    v.into_iter().map(|(k, n)| json!({ "why": k, "n": n })).collect()
}

impl Copy2Handle {
    /// A pool_logs / block_tick message (no answer; never blocks).
    pub fn block_json(&self, v: &Value) {
        inc(&self.c2.stats.msgs);
        match parse_block_msg(v) {
            Ok(m) => self.block(m),
            Err(e) => {
                inc(&self.c2.stats.msgs_bad);
                eprintln!("[arbsim] copy2: bad pool_logs/block_tick message: {e}");
            }
        }
    }

    pub fn block(&self, m: BlockMsg) {
        {
            // Freshness and "newer block received" for the mirror's resolve().
            let mut p = self.sh.published.write().unwrap();
            p.last_frame = Some(Instant::now());
            let seq = m.block.saturating_sub(self.sh.cfg.l2_offset);
            p.received_seq = Some(p.received_seq.map_or(seq, |r| r.max(seq)));
        }
        if self.tx.try_send(Input::Block(m)).is_err() {
            // Hopelessly behind: dropping a block breaks the copy; the next
            // message's prevBlock check reloads everything.
            inc(&self.c2.stats.dropped_msgs);
        }
    }

    /// `track` request -> answer.
    pub fn track_json(&self, id: &Value, v: &Value) -> Value {
        match parse_track(v) {
            Ok((pools, layouts, skipped)) => {
                let n = pools.len();
                // Track is rare and important: wait for room.
                let _ = self.tx.send(Input::Track(pools, layouts));
                json!({ "id": id, "ok": true, "tracked": n, "skipped": skipped })
            }
            Err(e) => crate::proto::bad_request(id, &e),
        }
    }

    pub fn fill(&self, items: Vec<MissItem>) {
        if !items.is_empty() {
            let _ = self.tx.try_send(Input::Fill(items));
        }
    }

    /// `coin_slots` request -> answer (layouts the bot already knows).
    pub fn coin_slots_json(&self, id: &Value, v: &Value) -> Value {
        let l = parse_coin_slots(v);
        let n = l.len();
        let _ = self.tx.send(Input::Layouts(l));
        json!({ "id": id, "ok": true, "accepted": n })
    }

    pub fn stop(&self) {
        let _ = self.tx.send(Input::Stop);
    }

    /// Count the items a check found missing, by class (status): pool /
    /// coin / other contract / account, slot or basics.
    pub fn note_misses(&self, missing: &[MissItem]) {
        let reg = self.c2.reg.read().unwrap();
        let mut m = self.c2.misses.lock().unwrap();
        for it in missing {
            let (a, what) = match it {
                MissItem::Account(a) => (*a, "basics"),
                MissItem::Slot(a, _) => (*a, "slot"),
                MissItem::Code(_) => {
                    *m.entry("code".into()).or_default() += 1;
                    continue;
                }
            };
            let who = if reg.by_addr.contains_key(&a) {
                let ready = reg.pools_of(&a).iter().all(|k| reg.pools.get(k).is_some_and(|e| e.state == PoolState::Ready));
                if ready { "ready pool" } else { "pool not ready" }
            } else if reg.holders.contains_key(&a) {
                "coin"
            } else if reg.owner_of.contains_key(&a) {
                "pool's own account"
            } else {
                "other account"
            };
            *m.entry(format!("{who} {what}")).or_default() += 1;
        }
    }

    /// If a check's missing items belong to a pool that isn't ready: why.
    pub fn unsure_reason(&self, missing: &[MissItem]) -> Option<String> {
        let reg = self.c2.reg.read().unwrap();
        missing.iter().find_map(|m| match m {
            MissItem::Account(a) | MissItem::Slot(a, _) => reg.blocked_account(a),
            MissItem::Code(_) => None,
        })
    }

    /// The `copy2` part of `status` (with the per-pool list if asked).
    pub fn status_json(&self, with_pools: bool) -> Value {
        let reg = self.c2.reg.read().unwrap();
        let (loading, ready, unsure) = reg.counts();
        let last = self.c2.last_block.load(Ordering::Relaxed);
        let tip = self.sh.node_tip.load(Ordering::Relaxed).max(self.c2.node_tip.load(Ordering::Relaxed));
        let lr = self.c2.load_round.lock().unwrap().clone();
        let (jobs, carrying) = *self.c2.in_flight.lock().unwrap();
        let mut out = json!({
            "source": "pool-events",
            "pools": reg.pools.len(),
            "loading": loading,
            "ready": ready,
            "unsure": unsure,
            "lastBlock": last,
            "copyBlock": last,
            "nodeTip": tip,
            "behindBlocks": if tip > 0 && last > 0 { Some(tip.saturating_sub(last)) } else { None },
            "nodeRequests": self.c2.node_requests.load(Ordering::Relaxed),
            "nodeJobsInFlight": jobs,
            "poolsCarrying": carrying,
            "loadRound": { "pools": lr.pools, "done": lr.done, "seconds": (lr.seconds * 10.0).round() / 10.0,
                           "requests": lr.requests, "ready": lr.ready, "unsure": lr.unsure,
                           "outcomes": { "ready": lr.out.ready, "coinNotFound": lr.out.coin_not_found, "nodeError": lr.out.node_error,
                                         "mismatch": lr.out.mismatch, "otherUnsure": lr.out.other_unsure } },
            "coinsWithLayout": reg.layouts.values().filter(|l| l.is_some()).count(),
            "coinsWithoutLayout": reg.layouts.values().filter(|l| l.is_none()).count(),
            "unsureReasons": top_reasons(reg.pools.values().filter(|e| e.state == PoolState::Unsure).map(|e| e.reason.as_str())),
            "loadingReasons": top_reasons(reg.pools.values().filter(|e| e.state == PoolState::Loading).map(|e| e.reason.as_str())),
            "counters": Value::Object(self.c2.stats.json()),
            "loader": self.c2.loader.json(),
            "missesByClass": self.c2.misses.lock().unwrap().clone(),
        });
        if with_pools {
            let list: Vec<Value> = reg
                .pools
                .values()
                .map(|e| {
                    json!({
                        "address": to_hex(e.pool.address.as_slice()),
                        "v4Id": e.pool.v4_id.map(|i| format!("{i}")),
                        "kind": kind_name(e.pool.kind),
                        "state": state_name(e.state),
                        "reason": if e.state == PoolState::Ready { Value::Null } else { json!(e.reason) },
                        "events": e.events,
                        "values": e.items.len(),
                    })
                })
                .collect();
            out["list"] = json!(list);
        }
        out
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
#[derive(Clone, Debug)]
pub struct C2Config {
    /// First wait before reloading an unsure pool [ARBSIM_COPY2_RELOAD_MS, 2000];
    /// doubles each time in a row, at most [ARBSIM_COPY2_RELOAD_MAX_MS, 600000].
    pub reload_ms: u64,
    pub reload_max_ms: u64,
    /// Wait after a pool's storage layout didn't match its getters
    /// [ARBSIM_COPY2_LAYOUT_RETRY_S, 3600].
    pub layout_retry_s: u64,
    /// Pools per load job [ARBSIM_COPY2_LOAD_BATCH, 5] (small jobs: mostly one HTTP request each; split into
    /// node requests of ARBSIM_NODE_BATCH calls).
    pub load_batch: usize,
    /// Loader workers = node requests in flight at most
    /// [ARBSIM_COPY2_INFLIGHT, 16]; load jobs queued at most this many too.
    pub loaders: usize,
    /// Blocks of reports always kept for carrying loads forward
    /// [ARBSIM_COPY2_KEEP_BLOCKS, 2400 = ~10 min]; older ones are kept as
    /// long as a running load still needs them, up to
    /// [ARBSIM_COPY2_MAX_KEEP_BLOCKS, 40000 = ~3 h].
    pub keep_blocks: usize,
    pub max_keep_blocks: usize,
    /// Fetch rounds one load may take [ARBSIM_COPY2_MAX_ROUNDS, 40].
    pub max_rounds: u32,
    /// Node tip check for status [ARBSIM_COPY2_TIP_EVERY_S, 30].
    pub tip_every_s: u64,
}

impl C2Config {
    pub fn from_env() -> Self {
        C2Config {
            reload_ms: env_u64("ARBSIM_COPY2_RELOAD_MS", 2000),
            reload_max_ms: env_u64("ARBSIM_COPY2_RELOAD_MAX_MS", 600_000),
            layout_retry_s: env_u64("ARBSIM_COPY2_LAYOUT_RETRY_S", 3600),
            load_batch: env_u64("ARBSIM_COPY2_LOAD_BATCH", 5).clamp(1, 500) as usize,
            loaders: env_u64("ARBSIM_COPY2_INFLIGHT", 16).clamp(1, 128) as usize,
            keep_blocks: env_u64("ARBSIM_COPY2_KEEP_BLOCKS", 2400).clamp(16, 100_000) as usize,
            max_keep_blocks: env_u64("ARBSIM_COPY2_MAX_KEEP_BLOCKS", 40_000).clamp(16, 1_000_000) as usize,
            max_rounds: env_u64("ARBSIM_COPY2_MAX_ROUNDS", 40).clamp(1, 1000) as u32,
            tip_every_s: env_u64("ARBSIM_COPY2_TIP_EVERY_S", 30),
        }
    }
    pub fn for_tests() -> Self {
        C2Config { reload_ms: 0, reload_max_ms: 0, layout_retry_s: 3600, load_batch: 25, loaders: 2, keep_blocks: 400, max_keep_blocks: 4000, max_rounds: 40, tip_every_s: 0 }
    }
}

// ---------------------------------------------------------------------------
// The intake thread
// ---------------------------------------------------------------------------
/// Position of a report inside the chain: (block, tx index, log index).
/// (b, MAX, MAX) = "end of block b" (Algebra finish_block).
type Pos = (u64, u32, u32);
const END: u32 = u32::MAX;

/// One block's reports, kept for carrying loads forward.
struct BufBlock {
    block: u64,
    rctx: ReplayCtx,
    /// Sorted by (tx, log index); reorged ones left out.
    logs: Arc<Vec<PoolLog>>,
}

/// A pool being loaded: its private working copy and where it has got to.
struct Partial {
    ov: Overlay,
    /// Next report to apply (everything before it is in `ov`).
    cursor: Pos,
    gen: u64,
    /// Node errors in a row while fetching for it.
    errors: u32,
}

/// What a node job was for.
enum JobFor {
    /// `want` = the block asked for (the answer may be older).
    Load { pools: Vec<LoadReq>, want: u64 },
    Need { key: PoolKey, gen: u64, items: Vec<MissItem> },
    /// Where a coin keeps one pool's balance (debug_traceCall).
    Trace,
    Fill,
    Probe,
    Tip,
}

/// One pool's part of a load job.
struct LoadReq {
    key: PoolKey,
    gen: u64,
    /// Its items: range in the job's item list.
    items: (usize, usize),
    /// Layout check getters: (name, index in the job's call list).
    getters: Vec<(&'static str, usize)>,
    /// Coin checks: (coin, balance slot, item index, balanceOf call index).
    coin_checks: Vec<(Address, U256, usize, usize)>,
}

pub struct Intake {
    sh: Arc<Shared>,
    c2: Arc<C2Shared>,
    cfg: C2Config,
    rx: Receiver<Input>,
    fills: Arc<FillQueue>,
    loaders: Option<Loaders>,
    /// Blocks received, not applied yet (by block number).
    pending: BTreeMap<u64, BlockMsg>,
    /// Node answers waiting to be used.
    done: VecDeque<Done>,
    /// Newest block applied.
    last_block: Option<u64>,
    /// Block of the previous message received (for the bot's prevBlock).
    last_msg_block: Option<u64>,
    /// Recent blocks: their reports' positions and pools touched
    /// (duplicates, late reports, reorgs).
    recent: VecDeque<(u64, Vec<LogId>, Vec<PoolKey>)>,
    /// Need fetches to send again after a node error: (when, pool, gen, items).
    delayed: Vec<(Instant, PoolKey, u64, Vec<MissItem>)>,
    /// Coins whose probe failed with a node error: ask again after this.
    probe_retry: HashMap<Address, (Instant, u32)>,
    outcomes: Outcomes,
    last_progress: Instant,
    /// Position of the last report applied to each pool / to each followed
    /// coin balance (coin, holder). A load or a fill counts as "everything
    /// up to the end of its block".
    last_pos: HashMap<PoolKey, Pos>,
    coin_pos: HashMap<(Address, Address), Pos>,
    /// Blocks we got a message for (lost-message check).
    received: std::collections::BTreeSet<u64>,
    /// Balance traces running / to retry after a node error / judged
    /// "not found" (coin, holder).
    tracing: HashSet<(Address, Address)>,
    trace_retry: HashMap<(Address, Address), (Instant, u32)>,
    /// Coins with a balance trace running (one per coin until we know the
    /// coin needs one trace per pool, see on_trace).
    coins_tracing: HashMap<Address, u32>,
    /// Coins whose traced slot fits no standard layout: one trace per pool.
    per_pool_coins: HashSet<Address>,
    trace_failed: HashMap<(Address, Address), (Instant, String)>,
    unsure_logged: u64,
    last_watchdog: Option<Instant>,
    started: Instant,
    /// Load answers waiting to be digested, one pool at a time.
    load_q: VecDeque<(LoadReq, Arc<FetchOut>, u64)>,
    buf: VecDeque<BufBlock>,
    partials: HashMap<PoolKey, Partial>,
    jobs: HashMap<u64, JobFor>,
    next_id: u64,
    probing: HashSet<Address>,
    /// Coins whose storage balance was checked against balanceOf once.
    coin_ok: HashSet<Address>,
    /// Last block an event touched this pool address / coin holder.
    touched_addr: HashMap<Address, u64>,
    /// Last block a coin transfer changed this (coin, slot).
    touched_slot: HashMap<(Address, U256), u64>,
    basefee: u64,
    last_tip: Option<Instant>,
    last_evict: Instant,
    /// Current load round: (started, requests before, pools).
    round: Option<(Instant, u64, usize)>,
}

/// Start the intake thread (+ loader threads).
pub fn spawn(sh: Arc<Shared>, fills: Arc<FillQueue>, cfg: C2Config) -> Copy2Handle {
    let (mut intake, h) = manual(sh, fills, cfg);
    std::thread::Builder::new().name("arbsim-copy2".into()).spawn(move || intake.run()).expect("copy2 thread");
    h
}

/// For tests: an intake driven by hand (`pump`); loader threads still run.
pub fn manual(sh: Arc<Shared>, fills: Arc<FillQueue>, cfg: C2Config) -> (Intake, Copy2Handle) {
    let (tx, rx) = std::sync::mpsc::sync_channel(16_384);
    let c2 = Arc::new(C2Shared {
        reg: RwLock::new(Registry::default()),
        stats: C2Stats::default(),
        last_block: AtomicU64::new(0),
        node_requests: Arc::new(AtomicU64::new(0)),
        load_round: Mutex::new(LoadRound::default()),
        node_tip: Arc::new(AtomicU64::new(0)),
        head_block: Arc::new(AtomicU64::new(0)),
        misses: Mutex::new(HashMap::new()),
        loader: Arc::new(LoaderStats::default()),
        in_flight: Mutex::new((0, 0)),
    });
    let loaders = sh
        .node
        .clone()
        .map(|n| Loaders::spawn(cfg.loaders, n, tx.clone(), c2.node_requests.clone(), c2.node_tip.clone(), c2.loader.clone(), c2.head_block.clone()));
    let i = Intake {
        sh: sh.clone(),
        c2: c2.clone(),
        cfg,
        rx,
        fills,
        loaders,
        pending: BTreeMap::new(),
        done: VecDeque::new(),
        last_block: None,
        last_msg_block: None,
        recent: VecDeque::new(),
        delayed: Vec::new(),
        probe_retry: HashMap::new(),
        outcomes: Outcomes::default(),
        last_progress: Instant::now(),
        last_pos: HashMap::new(),
        coin_pos: HashMap::new(),
        received: std::collections::BTreeSet::new(),
        tracing: HashSet::new(),
        trace_retry: HashMap::new(),
        coins_tracing: HashMap::new(),
        per_pool_coins: HashSet::new(),
        trace_failed: HashMap::new(),
        unsure_logged: 0,
        load_q: VecDeque::new(),
        last_watchdog: None,
        started: Instant::now(),
        buf: VecDeque::new(),
        partials: HashMap::new(),
        jobs: HashMap::new(),
        next_id: 1,
        probing: HashSet::new(),
        coin_ok: HashSet::new(),
        touched_addr: HashMap::new(),
        touched_slot: HashMap::new(),
        basefee: 0,
        last_tip: None,
        last_evict: Instant::now(),
        round: None,
    };
    (i, Copy2Handle { tx, sh, c2 })
}

/// Apply one event of a pool (fields or replay) to `ov`.
fn apply_event(ov: &mut Overlay, pool: &TrackedPool, log: &PoolLog, rctx: &ReplayCtx) -> ApplyResult {
    match pool.kind {
        PoolKind::V2 | PoolKind::Solidly => apply_fields(ov, pool, log, rctx.timestamp),
        _ => apply_replay(ov, pool, log, rctx),
    }
}

/// Is this log an event of `pool`?
fn is_pool_event(pool: &TrackedPool, log: &PoolLog) -> bool {
    log.address == pool.address
        && match pool.v4_id {
            Some(id) => log.topics.get(1) == Some(&id),
            None => true,
        }
}

/// A coin Transfer log: (coin, from, to, amount).
fn coin_transfer(log: &PoolLog) -> Option<(Address, Address, Address, U256)> {
    if log.topics.len() != 3 || log.topics[0] != topics().transfer || log.data.len() != 32 {
        return None;
    }
    Some((log.address, topic_addr(&log.topics[1]), topic_addr(&log.topics[2]), super::word(&log.data, 0)))
}

/// Slots a pool needs before its events can be applied, given what `ov` holds.
fn missing_core(pool: &TrackedPool, ov: &Overlay) -> Vec<MissItem> {
    let p = pool.address;
    let mut m: Vec<MissItem> =
        core_slots(pool.kind).iter().map(|s| U256::from(*s)).filter(|s| matches!(ov.slot(p, *s), Lookup::Missing)).map(|s| MissItem::Slot(p, s)).collect();
    if pool.kind == PoolKind::Solidly {
        // A swap also asks the factory (paused? fee?) and runs the shared
        // implementation behind the pool's tiny proxy.
        if let Lookup::Known(f) = ov.slot(p, U256::from(sol::FACTORY)) {
            let factory = Address::from_slice(&f.to_be_bytes::<32>()[12..]);
            if factory != Address::ZERO {
                if matches!(ov.account(factory), Lookup::Missing) {
                    m.push(MissItem::Account(factory));
                }
                for s in [U256::from(0), U256::from(1), U256::from(2), map_slot(p, 8)] {
                    if matches!(ov.slot(factory, s), Lookup::Missing) {
                        m.push(MissItem::Slot(factory, s));
                    }
                }
            }
        }
        if let Some(imp) = proxy_target(ov, p) {
            if matches!(ov.account(imp), Lookup::Missing) {
                m.push(MissItem::Account(imp));
            }
        }
        if let Lookup::Known(len) = ov.slot(p, U256::from(sol::OBS_LEN)) {
            if !len.is_zero() {
                let s = obs_slot(len - U256::from(1), 0);
                if matches!(ov.slot(p, s), Lookup::Missing) {
                    m.push(MissItem::Slot(p, s));
                }
            }
        }
    }
    m
}

fn fact_of(f: &Fetched) -> Fact {
    match f {
        Fetched::Slot(a, s, v) => Fact::Slot(*a, *s, *v),
        Fetched::Account(a, acc) => {
            let (info, code) = account_info(acc.as_ref());
            Fact::Basics { addr: *a, info, code }
        }
    }
}

impl Intake {
    pub fn run(&mut self) {
        loop {
            match self.rx.recv_timeout(Duration::from_millis(50)) {
                Ok(Input::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                Ok(i) => self.input(i),
                Err(RecvTimeoutError::Timeout) => {}
            }
            if !self.drain() {
                return;
            }
            self.work();
        }
    }

    /// Take everything waiting in the input queue. false = Stop.
    fn drain(&mut self) -> bool {
        while let Ok(i) = self.rx.try_recv() {
            if matches!(i, Input::Stop) {
                return false;
            }
            self.input(i);
        }
        true
    }

    /// Take everything waiting, then work (tests).
    pub fn pump(&mut self) {
        self.drain();
        self.work();
    }

    /// Node jobs in flight + answers not used yet (tests wait for 0).
    pub fn outstanding(&self) -> usize {
        self.jobs.len() + self.done.len() + self.pending.len() + self.delayed.len() + self.load_q.len()
    }

    /// Coin balance places the bot knows: used instead of probing (and
    /// they replace a "not found"). Pools waiting on those coins retry now.
    fn on_layouts(&mut self, l: Vec<(Address, BalanceLayout)>) {
        if l.is_empty() {
            return;
        }
        inc(&self.c2.stats.coin_slot_msgs);
        let mut reg = self.c2.reg.write().unwrap();
        let coins: HashSet<Address> = l.iter().map(|x| x.0).collect();
        for (c, lay) in l {
            reg.layouts.insert(c, Some(lay));
            reg.not_found_at.remove(&c);
        }
        let now = Instant::now();
        for e in reg.pools.values_mut() {
            if e.state == PoolState::Unsure && e.reason.starts_with("coin ") && (coins.contains(&e.pool.token0) || coins.contains(&e.pool.token1)) {
                e.retry_at = now;
            }
        }
    }

    /// Send again Need fetches that hit a node error.
    fn dispatch_delayed(&mut self) {
        if self.delayed.is_empty() {
            return;
        }
        let now = Instant::now();
        let (due, wait): (Vec<_>, Vec<_>) = std::mem::take(&mut self.delayed).into_iter().partition(|d| d.0 <= now);
        self.delayed = wait;
        for (_, key, gen, items) in due {
            let Some(part) = self.partials.remove(&key) else { continue };
            if part.gen != gen {
                continue;
            }
            self.send_need_job(key, part, items);
        }
    }

    fn input(&mut self, i: Input) {
        match i {
            Input::Track(pools, layouts) => {
                self.on_track(pools, Vec::new());
                self.on_layouts(layouts);
            }
            // Keep the newest message per block (a re-sent block replaces).
            Input::Block(m) => match self.pending.get_mut(&m.block) {
                // Two messages for a block not applied yet: keep every report.
                Some(old) => {
                    let have: HashSet<LogId> = old.logs.iter().map(log_id).collect();
                    let extra: Vec<PoolLog> = m.logs.into_iter().filter(|l| l.removed || !have.contains(&log_id(l))).collect();
                    old.logs.extend(extra);
                    old.tick = old.tick && m.tick;
                    if old.prev_block.is_none() {
                        old.prev_block = m.prev_block;
                    }
                }
                None => {
                    self.pending.insert(m.block, m);
                }
            },
            Input::Fill(items) => {
                self.fills.push(items);
            }
            Input::Layouts(l) => self.on_layouts(l),
            Input::Done(d) => self.done.push_back(d),
            Input::Stop => {}
        }
    }

    /// Blocks first; node answers in between, one at a time, re-checking
    /// for new blocks after each; then send new node jobs.
    pub fn work(&mut self) {
        loop {
            while let Some((&b, _)) = self.pending.iter().next() {
                let m = self.pending.remove(&b).unwrap();
                self.process(m);
            }
            if let Some((r, out, block)) = self.load_q.pop_front() {
                self.on_load_one(r, out, block);
            } else {
                let Some(d) = self.done.pop_front() else { break };
                self.on_done(d);
            }
            if !self.drain() {
                break;
            }
        }
        self.dispatch_tip();
        self.dispatch_delayed();
        self.dispatch_loads();
        self.dispatch_fills();
        self.note_round();
        self.watchdog();
        *self.c2.in_flight.lock().unwrap() = (self.jobs.len(), self.partials.len());
        if self.last_evict.elapsed() > Duration::from_secs(60) {
            self.last_evict = Instant::now();
            self.evict();
            self.prune_touched();
        }
    }

    fn new_job(&mut self, f: JobFor) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        self.jobs.insert(id, f);
        id
    }

    // ---- track ----
    fn on_track(&mut self, pools: Vec<TrackedPool>, layouts: Vec<(Address, BalanceLayout)>) {
        inc(&self.c2.stats.track_msgs);
        let mut gone: Vec<PoolEntry> = Vec::new();
        let mut added = 0;
        {
            let mut reg = self.c2.reg.write().unwrap();
            for (c, l) in layouts {
                reg.layouts.insert(c, Some(l));
            }
            let new: HashMap<PoolKey, TrackedPool> = pools.into_iter().map(|p| (key_of(&p), p)).collect();
            // Dropped pools, or pools whose details changed (treated as new).
            let old_keys: Vec<PoolKey> = reg.pools.keys().copied().collect();
            for k in old_keys {
                let same = new.get(&k).is_some_and(|p| {
                    let o = &reg.pools[&k].pool;
                    o.kind == p.kind && o.token0 == p.token0 && o.token1 == p.token1 && o.fee == p.fee && o.tick_spacing == p.tick_spacing
                });
                if !same {
                    gone.push(reg.pools.remove(&k).unwrap());
                }
            }
            for (k, p) in new {
                if reg.pools.contains_key(&k) {
                    continue;
                }
                added += 1;
                reg.pools.insert(
                    k,
                    PoolEntry {
                        pool: p,
                        state: PoolState::Loading,
                        reason: "loading: waiting for its turn".into(),
                        events: 0,
                        strikes: 0,
                        clean_events: 0,
                        retry_at: Instant::now(),
                        owned: Vec::new(),
                        items: HashSet::new(),
                        accounts: HashSet::new(),
                        verified: false,
                        gen: 0,
                        ready_since: 0,
                        busy: false,
                        ever_ready: false,
                        rounds: 0,
                        fails: 0,
                    },
                );
            }
            reg.rebuild_index();
        }
        if added > 0 && self.round.is_none() {
            self.outcomes = Outcomes::default();
            self.last_progress = Instant::now();
            self.round = Some((Instant::now(), self.c2.node_requests.load(Ordering::Relaxed), added));
            *self.c2.load_round.lock().unwrap() = LoadRound { pools: added, ..Default::default() };
        }
        // Forget what we held about pools we no longer follow (it would go stale).
        if !gone.is_empty() {
            let reg = self.c2.reg.read().unwrap();
            let mut forget: Vec<(Address, U256)> = Vec::new();
            for e in &gone {
                self.partials.remove(&key_of(&e.pool));
                forget.extend(e.items.iter().copied());
                for c in [e.pool.token0, e.pool.token1] {
                    let still = reg.holders.get(&c).is_some_and(|h| h.contains(&e.pool.address));
                    if let (false, Some(sl)) = (still, reg.bal_slot(c, e.pool.address)) {
                        forget.push((c, sl));
                    }
                }
            }
            drop(reg);
            let mut p = self.sh.published.write().unwrap();
            rewrite_from(&mut p.versions, 0, |s| {
                for (a, k) in &forget {
                    forget_slot(s, *a, *k);
                }
            });
        }
    }

    // ---- blocks ----
    fn block_ctx(&self, m: &BlockMsg, prev: Option<&BlockCtx>) -> BlockCtx {
        BlockCtx {
            l1_block_number: m.l1_block.or(prev.map(|p| p.l1_block_number)).unwrap_or(0),
            l2_block_number: Some(m.block),
            timestamp: m.timestamp,
            basefee: m.base_fee.unwrap_or(self.basefee),
            coinbase: arb::arbos::BATCH_POSTER_ADDRESS,
            gas_limit: arb::NITRO_BLOCK_GAS_LIMIT,
            prevrandao: arb::NITRO_PREVRANDAO,
        }
    }

    /// Apply one block message (or tick), publish the result. Never waits
    /// for the node.
    pub fn process(&mut self, m: BlockMsg) {
        let t0 = Instant::now();
        let c2 = self.c2.clone();
        let st = &c2.stats;
        // Lost message? The bot's previous message (prevBlock) must be one we
        // got. (Late messages for older blocks are normal, see header.)
        if let (Some(prev), Some(&first)) = (m.prev_block, self.received.first()) {
            if prev >= first && !self.received.contains(&prev) {
                inc(&st.gaps);
                eprintln!("[arbsim] copy2: message(s) lost (bot's previous block {prev} never arrived; now at {}); reloading every pool", m.block);
                self.unsure_all(&format!("lost message before block {}", m.block), m.block);
                // The buffer has a hole: no load may carry across it.
                self.buf.clear();
            }
        }
        if m.block > self.last_msg_block.unwrap_or(0) {
            self.last_msg_block = Some(m.block);
        }
        self.received.insert(m.block);
        while self.received.len() > 4096 {
            self.received.pop_first();
        }
        // Reorged reports ("removed") make their pools unsure from that block on.
        let removed: Vec<PoolLog> = m.logs.iter().filter(|l| l.removed).cloned().collect();
        if !removed.is_empty() {
            inc(&st.reorgs);
            let from = removed.iter().map(|l| l.block).min().unwrap_or(m.block);
            let keys = self.pools_touched(&removed);
            self.unsure_from(&keys, "reorg (report taken back)", from);
        }
        // A block we applied already: its reports we didn't have yet are
        // late reports (per pool, see header).
        if let Some(last) = self.last_block {
            if m.block <= last {
                if !m.tick {
                    let logs: Vec<PoolLog> = m.logs.iter().filter(|l| !l.removed).cloned().collect();
                    self.on_late(m.block, logs);
                }
                return;
            }
        }
        // Base: the newest version (or an empty start right before this block).
        let head = match self.sh.head() {
            Some(h) => h,
            None => self.bootstrap(m.block),
        };
        let ctx = self.block_ctx(&m, head.ctx.as_ref());
        let rctx = ReplayCtx { number: m.block, timestamp: m.timestamp, l1_number: ctx.l1_block_number };
        let mut logs: Vec<PoolLog> = m.logs.iter().filter(|l| !l.removed).cloned().collect();
        logs.sort_by_key(|l| (l.tx_index, l.log_index));
        if m.tick {
            inc(&st.ticks);
            self.push_buf(m.block, rctx, Vec::new());
            self.publish(m.block, head.snap.clone(), ctx, StateDiff::default());
            return;
        }
        inc(&st.blocks);
        let mut ov = Overlay::from_arc(&head.snap);
        ov.set_position(StatePosition { base_block: m.block, after_seq: None });
        add(&st.logs, logs.len() as u64);
        let mut touched: Vec<PoolKey> = Vec::new();
        for log in &logs {
            let mut used = false;
            for k in self.pool_keys_for(log) {
                used = true;
                touched.push(k);
                self.touched_addr.insert(log.address, m.block);
                self.apply_ready_event(&mut ov, k, log, &rctx);
            }
            if self.apply_coin_transfer(&mut ov, log, (m.block, log.tx_index, log.log_index), false) {
                used = true;
            }
            if !used {
                inc(&st.logs_ignored);
            }
        }
        touched.sort();
        touched.dedup();
        // End of block for replayed pools (Algebra side events still waiting,
        // see replay.rs): must run before publishing.
        for k in &touched {
            let pool = {
                let reg = self.c2.reg.read().unwrap();
                match reg.pools.get(k) {
                    Some(e) if e.state == PoolState::Ready && e.pool.kind == PoolKind::Algebra => e.pool.clone(),
                    _ => continue,
                }
            };
            let mut f = ov.fork();
            match finish_block(&mut f, &pool, &rctx) {
                ApplyResult::Applied => self.keep_fork(&mut ov, &f, *k),
                ApplyResult::Unsure(why) => self.make_unsure(*k, &format!("end of block: {why}"), Some(&mut ov), m.block),
                ApplyResult::NeedItems(items) => self.start_partial_in_block(&mut ov, *k, (m.block, END, END), items),
            }
        }
        self.recent.push_back((m.block, log_ids(&m.logs), touched));
        while self.recent.len() > 256 {
            self.recent.pop_front();
        }
        self.push_buf(m.block, rctx, logs);
        let (snap, diff) = ov.into_parts();
        self.publish(m.block, Arc::new(snap), ctx, diff);
        let us = t0.elapsed().as_micros() as u64;
        st.apply_us_max.fetch_max(us, Ordering::Relaxed);
    }

    fn push_buf(&mut self, block: u64, rctx: ReplayCtx, logs: Vec<PoolLog>) {
        self.buf.push_back(BufBlock { block, rctx, logs: Arc::new(logs) });
        // Keep at least keep_blocks; older ones while a running load still
        // needs them (its working copy's cursor, or a load in flight that may
        // come back fetched a little before the block it asked for).
        let need_from = self
            .partials
            .values()
            .map(|p| p.cursor.0)
            .chain(self.jobs.values().filter_map(|j| match j {
                JobFor::Load { want, .. } => Some(want.saturating_sub(self.cfg.keep_blocks as u64 / 4)),
                _ => None,
            }))
            .min()
            .unwrap_or(u64::MAX);
        while self.buf.len() > self.cfg.max_keep_blocks || (self.buf.len() > self.cfg.keep_blocks && self.buf.front().is_some_and(|b| b.block < need_from)) {
            self.buf.pop_front();
        }
    }

    /// Reports for block `n` (already applied) that we may not have had.
    fn on_late(&mut self, n: u64, logs: Vec<PoolLog>) {
        let c2 = self.c2.clone();
        let st = &c2.stats;
        // What we had for block n.
        let known: Option<HashSet<LogId>> = match self.recent.iter().find(|r| r.0 == n) {
            Some(r) => Some(r.1.iter().copied().collect()),
            None => self.buf.iter().find(|b| b.block == n).map(|b| b.logs.iter().map(log_id).collect()),
        };
        let rctx = self.buf.iter().find(|b| b.block == n).map(|b| b.rctx);
        let (Some(known), Some(rctx)) = (known, rctx) else {
            // Too old to place: the pools these reports touch are unsure.
            let keys = self.pools_touched(&logs);
            if !keys.is_empty() {
                inc(&st.late_reports_unsure);
                self.unsure_from(&keys, "late report for a block no longer kept", n);
            }
            return;
        };
        let mut added: Vec<PoolLog> = logs.into_iter().filter(|l| !known.contains(&log_id(l))).collect();
        if added.is_empty() {
            inc(&st.duplicate_blocks);
            return;
        }
        added.sort_by_key(|l| (l.tx_index, l.log_index));
        added.dedup_by_key(|l| log_id(l));
        let Some(head) = self.sh.head() else { return };
        let mut ov = Overlay::from_arc(&head.snap);
        let mut touched: Vec<PoolKey> = Vec::new();
        for log in &added {
            let pos: Pos = (n, log.tx_index, log.log_index);
            for k in self.pool_keys_for(log) {
                touched.push(k);
                let t = self.touched_addr.entry(log.address).or_insert(0);
                *t = (*t).max(n);
                let (kind, ready, gen, pool) = {
                    let reg = self.c2.reg.read().unwrap();
                    let e = &reg.pools[&k];
                    (e.pool.kind, e.state == PoolState::Ready, e.gen, e.pool.clone())
                };
                if !ready {
                    // Not followed right now; a load that already carried
                    // past this report would miss it: start that load over.
                    if self.partials.get(&k).is_some_and(|p| p.cursor > pos) {
                        self.retry_later(k, gen, "late report while loading");
                    }
                    continue;
                }
                if self.last_pos.get(&k).is_some_and(|lp| *lp >= pos) || kind == PoolKind::Algebra {
                    inc(&st.late_reports_unsure);
                    self.make_unsure(k, "late report after a later one was applied", Some(&mut ov), n);
                    continue;
                }
                let mut f = ov.fork();
                match apply_event(&mut f, &pool, log, &rctx) {
                    ApplyResult::Applied => {
                        inc(&st.late_reports_applied);
                        inc(&st.events_applied);
                        self.keep_fork(&mut ov, &f, k);
                        self.last_pos.insert(k, pos);
                    }
                    ApplyResult::Unsure(why) => {
                        inc(&st.late_reports_unsure);
                        self.log_unsure(k, log, n, &format!("late report: {why}"));
                        self.make_unsure(k, &format!("late report: {why}"), Some(&mut ov), n);
                    }
                    ApplyResult::NeedItems(_) => {
                        inc(&st.late_reports_unsure);
                        self.make_unsure(k, "late report needs values we don't hold", Some(&mut ov), n);
                    }
                }
            }
            self.apply_coin_transfer(&mut ov, log, pos, true);
        }
        // Write the result into every kept version from block n on (the
        // pools / balances it changed did not move after n, see above).
        let changes = ov.changes().clone();
        let forgot = ov.forgotten().to_vec();
        {
            let mut p = self.sh.published.write().unwrap();
            rewrite_from(&mut p.versions, n, |snap| {
                for (a, d) in &changes.accounts {
                    if !d.storage.is_empty() {
                        snap.apply_account_diff(*a, &crate::state::AccountDiff { storage: d.storage.clone(), ..Default::default() });
                    }
                }
                for (a, sl) in &forgot {
                    forget_slot(snap, *a, *sl);
                }
            });
        }
        // The kept reports and the recent list learn the new ones.
        if let Some(bb) = self.buf.iter_mut().find(|b| b.block == n) {
            let mut v: Vec<PoolLog> = (*bb.logs).clone();
            v.extend(added.iter().cloned());
            v.sort_by_key(|l| (l.tx_index, l.log_index));
            bb.logs = Arc::new(v);
        }
        match self.recent.iter_mut().find(|r| r.0 == n) {
            Some(r) => {
                r.1.extend(added.iter().map(log_id));
                r.1.sort();
                r.2.extend(touched);
                r.2.sort();
                r.2.dedup();
            }
            None => {
                let mut ids: Vec<LogId> = known.into_iter().chain(added.iter().map(log_id)).collect();
                ids.sort();
                touched.sort();
                touched.dedup();
                self.recent.push_back((n, ids, touched));
            }
        }
        self.sh.notify();
    }

    /// First message: an empty copy right before it (everything loaded later).
    fn bootstrap(&mut self, block: u64) -> Arc<Version> {
        let b = block.saturating_sub(1);
        let snap = Snapshot { pos: StatePosition { base_block: b, after_seq: None }, ..Snapshot::new(self.sh.volatile.clone()) };
        let v = Arc::new(Version {
            seq: b.saturating_sub(self.sh.cfg.l2_offset),
            block: b,
            snap: Arc::new(snap),
            ctx: None,
            txs: vec![],
            diff: Arc::new(StateDiff::default()),
            restart: true,
            block_hash: None,
            applied: Instant::now(),
        });
        {
            let mut p = self.sh.published.write().unwrap();
            p.versions.clear();
            p.versions.push_back(v.clone());
            p.stalled = None;
        }
        v
    }

    fn publish(&mut self, block: u64, snap: Arc<Snapshot>, ctx: BlockCtx, diff: StateDiff) {
        let v = Version {
            seq: block.saturating_sub(self.sh.cfg.l2_offset),
            block,
            snap,
            ctx: Some(ctx),
            txs: vec![],
            diff: Arc::new(diff),
            restart: false,
            block_hash: None,
            applied: Instant::now(),
        };
        {
            let mut p = self.sh.published.write().unwrap();
            p.versions.push_back(Arc::new(v));
            while p.versions.len() > self.sh.cfg.history {
                p.versions.pop_front();
            }
        }
        self.last_block = Some(block);
        self.c2.last_block.store(block, Ordering::Relaxed);
        self.c2.head_block.store(block, Ordering::Relaxed);
        self.sh.notify();
    }

    /// Which followed pools a log is an event of.
    fn pool_keys_for(&self, log: &PoolLog) -> Vec<PoolKey> {
        let reg = self.c2.reg.read().unwrap();
        let Some(keys) = reg.by_addr.get(&log.address) else { return vec![] };
        keys.iter().filter(|k| is_pool_event(&reg.pools[*k].pool, log)).copied().collect()
    }

    fn pools_touched(&self, logs: &[PoolLog]) -> Vec<PoolKey> {
        let reg = self.c2.reg.read().unwrap();
        let mut out = Vec::new();
        for l in logs {
            if let Some(keys) = reg.by_addr.get(&l.address) {
                out.extend(keys.iter().copied());
            }
            // Coin transfers: the pools on either side.
            if let Some((_, from, to, _)) = coin_transfer(l) {
                for side in [from, to] {
                    if let Some(keys) = reg.by_addr.get(&side) {
                        out.extend(keys.iter().copied());
                    }
                }
            }
        }
        out.sort();
        out.dedup();
        out
    }

    /// Take a fork's changes into the block's copy and note the values the
    /// pool now holds (they are forgotten with it if it goes unsure).
    fn keep_fork(&mut self, ov: &mut Overlay, f: &Overlay, k: PoolKey) {
        ov.absorb(f);
        let mut reg = self.c2.reg.write().unwrap();
        let holders: HashSet<Address> = reg.holders.keys().copied().collect();
        let mut new_owned = Vec::new();
        if let Some(e) = reg.pools.get_mut(&k) {
            for (a, d) in &f.changes().accounts {
                if holders.contains(a) && *a != e.pool.address {
                    continue; // coin contract: balances are followed separately
                }
                for s in d.storage.keys() {
                    e.items.insert((*a, *s));
                }
                if *a != e.pool.address && !e.owned.contains(a) {
                    e.owned.push(*a);
                    new_owned.push(*a);
                }
            }
        }
        for a in new_owned {
            reg.owner_of.insert(a, k);
        }
    }

    /// Apply one event to one READY pool.
    fn apply_ready_event(&mut self, ov: &mut Overlay, k: PoolKey, log: &PoolLog, rctx: &ReplayCtx) {
        let c2 = self.c2.clone();
        let st = &c2.stats;
        let (pool, state) = {
            let reg = self.c2.reg.read().unwrap();
            let e = &reg.pools[&k];
            (e.pool.clone(), e.state)
        };
        if state != PoolState::Ready {
            // Loading / unsure: the buffer keeps this report for its load.
            inc(&st.events_skipped_not_ready);
            return;
        }
        let mut f = ov.fork();
        match apply_event(&mut f, &pool, log, rctx) {
            ApplyResult::Applied => {
                inc(&st.events_applied);
                self.keep_fork(ov, &f, k);
                self.last_pos.insert(k, (rctx.number, log.tx_index, log.log_index));
                let mut reg = self.c2.reg.write().unwrap();
                if let Some(e) = reg.pools.get_mut(&k) {
                    e.events += 1;
                    e.clean_events += 1;
                    if e.clean_events >= 50 {
                        e.strikes = 0;
                    }
                }
            }
            ApplyResult::Unsure(why) => {
                inc(&st.events_unsure);
                self.log_unsure(k, log, rctx.number, &why);
                self.make_unsure(k, &why, Some(ov), rctx.number);
            }
            ApplyResult::NeedItems(items) => {
                // Don't wait: carry on in the background from this report.
                self.start_partial_in_block(ov, k, (log.block.max(rctx.number), log.tx_index, log.log_index), items);
            }
        }
    }

    /// A coin Transfer to / from one of our pools: move that pool's balance.
    /// Returns true if the log was such a transfer. `late`: the report is
    /// for an already-applied block (see on_late): a balance that already
    /// took a LATER transfer is forgotten instead (never a guess).
    fn apply_coin_transfer(&mut self, ov: &mut Overlay, log: &PoolLog, pos: Pos, late: bool) -> bool {
        let Some((coin, from, to, v)) = coin_transfer(log) else { return false };
        let block = pos.0;
        let (followed, layout, slots) = {
            let reg = self.c2.reg.read().unwrap();
            let Some(h) = reg.holders.get(&coin) else { return false };
            if !h.contains(&from) && !h.contains(&to) {
                return false;
            }
            let slots: HashMap<Address, U256> = h.iter().filter_map(|x| reg.bal_slot(coin, *x).map(|s| (*x, s))).collect();
            (h.clone(), reg.layouts.get(&coin).copied().flatten(), slots)
        };
        inc(&self.c2.stats.coin_transfers);
        for side in [from, to] {
            if followed.contains(&side) {
                let t = self.touched_addr.entry(side).or_insert(0);
                *t = (*t).max(block);
            }
        }
        for (side, is_from) in [(from, true), (to, false)] {
            if side == Address::ZERO {
                continue; // mint / burn of the coin: no balance slot
            }
            if followed.contains(&side) {
                let Some(slot) = slots.get(&side).copied() else { continue };
                let t = self.touched_slot.entry((coin, slot)).or_insert(0);
                *t = (*t).max(block);
                if late && self.coin_pos.get(&(coin, side)).is_some_and(|p| *p >= pos) {
                    inc(&self.c2.stats.coin_slot_mismatch);
                    ov.forget_slot(coin, slot);
                    continue;
                }
                if let Lookup::Known(cur) = ov.slot(coin, slot) {
                    match if is_from { cur.checked_sub(v) } else { cur.checked_add(v) } {
                        Some(x) => {
                            ov.set_slot(coin, slot, x);
                            self.coin_pos.insert((coin, side), pos);
                        }
                        None => {
                            // Our copy of that balance was wrong: forget it
                            // (fetched again when needed). Never a guess.
                            inc(&self.c2.stats.coin_slot_mismatch);
                            ov.forget_slot(coin, slot);
                        }
                    }
                }
            } else {
                // A wallet / the bot's contract: its other transfers never
                // reach us, so we don't vouch for its balance.
                match layout {
                    Some(l) => {
                        let slot = l.key(side);
                        let t = self.touched_slot.entry((coin, slot)).or_insert(0);
                        *t = (*t).max(block);
                        if matches!(ov.slot(coin, slot), Lookup::Known(_)) {
                            inc(&self.c2.stats.other_side_forgotten);
                            ov.forget_slot(coin, slot);
                        }
                    }
                    None => {
                        // We can't name its slot: forget every value of this
                        // coin we hold except our pools' balances.
                        let ours: HashSet<U256> = slots.values().copied().collect();
                        let held: Vec<U256> =
                            ov.snapshot().accounts.get(&coin).map(|a| a.storage.keys().copied().filter(|s| !ours.contains(s)).collect()).unwrap_or_default();
                        for sl in held {
                            let t = self.touched_slot.entry((coin, sl)).or_insert(0);
                            *t = (*t).max(block);
                            inc(&self.c2.stats.other_side_forgotten);
                            ov.forget_slot(coin, sl);
                        }
                    }
                }
            }
        }
        // from == to: the pool's balance is unchanged (sub then add): fine.
        true
    }

    // ---- unsure ----
    fn backoff(&self, strikes: u32, reason: &str) -> Duration {
        if reason.starts_with("layout") || reason.starts_with("coin") {
            return Duration::from_secs(self.cfg.layout_retry_s);
        }
        let ms = self.cfg.reload_ms.saturating_mul(1u64 << strikes.saturating_sub(1).min(20));
        Duration::from_millis(ms.min(self.cfg.reload_max_ms.max(self.cfg.reload_ms)))
    }

    /// Mark a pool unsure and forget its values: in the block being built
    /// (`ov`), and in every kept version from `from_block` on.
    fn make_unsure(&mut self, k: PoolKey, why: &str, ov: Option<&mut Overlay>, from_block: u64) {
        self.partials.remove(&k);
        let forget: Vec<(Address, U256)> = {
            let mut reg = self.c2.reg.write().unwrap();
            let Some(e) = reg.pools.get_mut(&k) else { return };
            e.strikes = e.strikes.saturating_add(1);
            e.clean_events = 0;
            e.state = PoolState::Unsure;
            e.reason = why.to_string();
            e.gen += 1;
            e.busy = false;
            let wait = self.backoff(e.strikes, why);
            e.retry_at = Instant::now() + wait;
            e.items.iter().copied().collect()
        };
        inc(&self.c2.stats.unsure_marked);
        if let Some(ov) = ov {
            for (a, s) in &forget {
                ov.forget_slot(*a, *s);
            }
        }
        let mut p = self.sh.published.write().unwrap();
        rewrite_from(&mut p.versions, from_block, |s| {
            for (a, sl) in &forget {
                forget_slot(s, *a, *sl);
            }
        });
    }

    /// Reorg: these pools unsure from `from`, and their coin balances
    /// forgotten too (the reorged transfers changed them).
    fn unsure_from(&mut self, keys: &[PoolKey], why: &str, from: u64) {
        let mut slots: Vec<(Address, U256)> = Vec::new();
        {
            let reg = self.c2.reg.read().unwrap();
            for k in keys {
                if let Some(e) = reg.pools.get(k) {
                    for c in [e.pool.token0, e.pool.token1] {
                        if let Some(sl) = reg.bal_slot(c, e.pool.address) {
                            slots.push((c, sl));
                        }
                    }
                }
            }
        }
        for k in keys {
            self.make_unsure(*k, why, None, from);
        }
        let mut p = self.sh.published.write().unwrap();
        rewrite_from(&mut p.versions, from, |s| {
            for (a, sl) in &slots {
                forget_slot(s, *a, *sl);
            }
        });
    }

    fn unsure_all(&mut self, why: &str, from: u64) {
        let keys: Vec<PoolKey> = self.c2.reg.read().unwrap().pools.keys().copied().collect();
        self.unsure_from(&keys, why, from);
    }

    /// Replace the head version's state (only if it is still at `block`).
    fn into_head(&self, block: u64, f: impl Fn(&mut Snapshot)) -> bool {
        let mut p = self.sh.published.write().unwrap();
        let n = p.versions.len();
        if n == 0 {
            return false;
        }
        let h = p.versions[n - 1].clone();
        if h.block != block {
            return false;
        }
        let mut s = (*h.snap).clone();
        f(&mut s);
        p.versions[n - 1] = Arc::new(Version { snap: Arc::new(s), ..(*h).clone() });
        drop(p);
        self.sh.notify();
        true
    }

    // ---- loads: dispatch ----
    /// An empty working copy (contract code is shared: it never changes).
    fn empty_copy(&self) -> Overlay {
        let codes = self.sh.head().map(|h| h.snap.codes.clone()).unwrap_or_default();
        Overlay::new(Snapshot { codes, ..Snapshot::new(self.sh.volatile.clone()) })
    }

    fn load_jobs_in_flight(&self) -> usize {
        self.jobs.values().filter(|j| matches!(j, JobFor::Load { .. })).count()
    }

    /// Send load jobs for pools that are due (never waits).
    fn dispatch_loads(&mut self) {
        let Some(head) = self.sh.head() else { return };
        let now = Instant::now();
        if self.loaders.is_none() {
            let mut reg = self.c2.reg.write().unwrap();
            for e in reg.pools.values_mut().filter(|e| e.state != PoolState::Ready && e.retry_at <= now) {
                e.state = PoolState::Unsure;
                e.reason = "no node configured to load it from".into();
                e.retry_at = now + Duration::from_secs(3600);
            }
            return;
        }
        // Bulk work in flight at most ~2 s of copy 2's call budget (pools then
        // finish steadily instead of in late lumps), at least 2 jobs.
        // At most one queued/running load job per worker.
        let max_jobs = self.cfg.loaders;
        if self.load_jobs_in_flight() >= max_jobs {
            return;
        }
        // "Not found" is asked again after a while (it may have been a bad moment).
        {
            let mut reg = self.c2.reg.write().unwrap();
            let again: Vec<Address> =
                reg.not_found_at.iter().filter(|(_, t)| t.elapsed() >= Duration::from_secs(self.cfg.layout_retry_s)).map(|(c, _)| *c).collect();
            for c in again {
                reg.not_found_at.remove(&c);
                reg.layouts.remove(&c);
            }
        }
        // Coins whose balance place is unknown: find it first (probe).
        let probe: Vec<Address> = {
            let reg = self.c2.reg.read().unwrap();
            let mut v: Vec<Address> = reg
                .pools
                .values()
                .filter(|e| e.state != PoolState::Ready && !e.busy && e.retry_at <= now)
                .flat_map(|e| [e.pool.token0, e.pool.token1])
                .filter(|c| *c != Address::ZERO && !reg.layouts.contains_key(c) && !self.probing.contains(c))
                .filter(|c| self.probe_retry.get(c).is_none_or(|t| t.0 <= now))
                .collect();
            v.sort();
            v.dedup();
            v
        };
        for c in probe.into_iter().take(64usize.saturating_sub(self.probing.len())) {
            self.probing.insert(c);
            inc(&self.c2.stats.probes);
            let id = self.new_job(JobFor::Probe);
            self.loaders.as_ref().unwrap().send(Job::Probe { id, coin: c, block: head.block });
        }
        // Pools ready to load (both coins' balance places known); pools that
        // had events most recently first (they matter most), then by wait.
        let mut traces: Vec<(Address, Address)> = Vec::new();
        let mut due: Vec<(std::cmp::Reverse<u64>, Instant, PoolKey)> = {
            let mut reg = self.c2.reg.write().unwrap();
            let layouts = reg.layouts.clone();
            let pairs = reg.pair_slots.clone();
            let mut d = Vec::new();
            for (k, e) in reg.pools.iter_mut() {
                if e.state == PoolState::Ready || e.busy || e.retry_at > now {
                    continue;
                }
                let coins: Vec<Address> = [e.pool.token0, e.pool.token1].into_iter().filter(|c| *c != Address::ZERO).collect();
                if coins.iter().any(|c| !layouts.contains_key(c)) {
                    continue; // still probing
                }
                // No general layout: find this pool's slot by trace first.
                let mut waiting = false;
                for c in coins.iter().filter(|c| layouts[*c].is_none() && !pairs.contains_key(&(**c, e.pool.address))) {
                    let pair = (*c, e.pool.address);
                    if let Some((t, why)) = self.trace_failed.get(&pair) {
                        if t.elapsed() < Duration::from_secs(self.cfg.layout_retry_s) {
                            e.state = PoolState::Unsure;
                            e.reason = why.clone();
                            e.retry_at = *t + Duration::from_secs(self.cfg.layout_retry_s);
                            waiting = true;
                            break;
                        }
                    }
                    waiting = true;
                    e.reason = format!("loading: finding where coin {c} keeps its balance");
                    let coin_free = self.per_pool_coins.contains(c) || !self.coins_tracing.contains_key(c);
                    if coin_free && !self.tracing.contains(&pair) && self.trace_retry.get(&pair).is_none_or(|t| t.0 <= now) {
                        traces.push(pair);
                    }
                }
                if waiting {
                    continue;
                }
                let active = self.touched_addr.get(&e.pool.address).copied().unwrap_or(0);
                d.push((std::cmp::Reverse(active), e.retry_at, *k));
            }
            d
        };
        traces.sort();
        traces.dedup();
        for pair in traces {
            // One per coin unless the coin is known to need one per pool.
            if !self.per_pool_coins.contains(&pair.0) && self.coins_tracing.contains_key(&pair.0) {
                continue;
            }
            *self.coins_tracing.entry(pair.0).or_insert(0) += 1;
            self.tracing.insert(pair);
            self.trace_failed.remove(&pair);
            inc(&self.c2.stats.coin_traces);
            let id = self.new_job(JobFor::Trace);
            self.loaders.as_ref().unwrap().send(Job::Trace { id, block: head.block, coin: pair.0, holder: pair.1 });
        }
        due.sort();
        let mut due = due.into_iter().map(|x| x.2).peekable();
        // Small jobs (~2 s of copy 2's call budget, ~3 requests per pool) keep
        // the pacing smooth; never more than load_batch pools.
        let per_job = self.cfg.load_batch;
        while due.peek().is_some() && self.load_jobs_in_flight() < max_jobs {
            let keys: Vec<PoolKey> = due.by_ref().take(per_job).collect();
            self.send_load(&keys, head.block, &head.snap);
        }
    }

    /// One load job for these pools at `block`: per pool its code, the slots
    /// its swap reads (load_slots), what it held before, its coins' code and
    /// its balance of each coin (or a trace to find where that balance is).
    fn send_load(&mut self, keys: &[PoolKey], block: u64, head: &Snapshot) {
        let mut items: Vec<MissItem> = Vec::new();
        let mut calls: Vec<(Address, Bytes)> = Vec::new();
        let mut reqs = Vec::new();
        let head_has_code = |a: &Address| head.accounts.get(a).is_some_and(|x| matches!(&x.basics, Basics::Known(Some(i)) if head.codes.contains_key(&i.code_hash) || i.code_hash == revm::primitives::KECCAK_EMPTY));
        {
            let mut reg = self.c2.reg.write().unwrap();
            let bal: HashMap<(Address, Address), Option<U256>> = keys
                .iter()
                .filter_map(|k| reg.pools.get(k).map(|e| e.pool.clone()))
                .flat_map(|p| [(p.token0, p.address), (p.token1, p.address)])
                .map(|(c, h)| ((c, h), reg.bal_slot(c, h)))
                .collect();
            for k in keys {
                let Some(e) = reg.pools.get_mut(k) else { continue };
                let p = e.pool.clone();
                let start = items.len();
                let mut seen: HashSet<MissItem> = HashSet::new();
                let mut push = |items: &mut Vec<MissItem>, m: MissItem| {
                    if seen.insert(m.clone()) {
                        items.push(m);
                    }
                };
                push(&mut items, MissItem::Account(p.address));
                for (a, sl) in load_slots(&p) {
                    push(&mut items, MissItem::Slot(a, sl));
                }
                for (a, sl) in &e.items {
                    push(&mut items, MissItem::Slot(*a, *sl));
                }
                for a in &e.accounts {
                    push(&mut items, MissItem::Account(*a));
                }
                let mut coin_checks = Vec::new();
                for c in [p.token0, p.token1] {
                    if c == Address::ZERO {
                        continue;
                    }
                    let bal_call = parse_bytes(&balance_of_data(p.address)).unwrap_or_default();
                    match bal.get(&(c, p.address)).copied().flatten() {
                        Some(slot) => {
                            if !head_has_code(&c) {
                                push(&mut items, MissItem::Account(c));
                            }
                            let idx = items.len();
                            push(&mut items, MissItem::Slot(c, slot));
                            if !self.coin_ok.contains(&c) && items.len() > idx {
                                coin_checks.push((c, slot, idx, calls.len()));
                                calls.push((c, bal_call));
                            }
                        }
                        // Not known yet: dispatch_loads traces it before loading.
                        None => {}
                    }
                }
                let mut getters = Vec::new();
                if !e.verified {
                    let names: &[&'static str] = match p.kind {
                        PoolKind::V2 => &["getReserves()"],
                        PoolKind::Solidly => &["getReserves()", "index0()", "observationLength()"],
                        _ => &[],
                    };
                    for g in names {
                        getters.push((*g, calls.len()));
                        calls.push((p.address, Bytes::copy_from_slice(&keccak256(g.as_bytes())[..4])));
                    }
                }
                e.busy = true;
                e.state = PoolState::Loading;
                e.reason = "loading: fetching from the node".into();
                e.rounds = 1;
                reqs.push(LoadReq { key: *k, gen: e.gen, items: (start, items.len()), getters, coin_checks });
            }
        }
        if reqs.is_empty() {
            return;
        }
        add(&self.c2.stats.loads, reqs.len() as u64);
        let id = self.new_job(JobFor::Load { pools: reqs, want: block });
        // At most `block`: the loader uses an older block if the node isn't there yet.
        self.loaders.as_ref().unwrap().send(Job::Fetch { id, block, exact: false, bulk: true, items, calls });
    }

    // ---- node answers ----
    fn on_done(&mut self, d: Done) {
        let id = match &d {
            Done::Fetch { id, .. } | Done::Probe { id, .. } | Done::Tip { id, .. } | Done::Trace { id, .. } => *id,
        };
        let Some(job) = self.jobs.remove(&id) else { return };
        match (job, d) {
            (JobFor::Probe, Done::Probe { coin, res, .. }) => {
                self.probing.remove(&coin);
                let mut reg = self.c2.reg.write().unwrap();
                if matches!(reg.layouts.get(&coin), Some(Some(_))) {
                    return; // the bot told us meanwhile
                }
                match res {
                    Ok(l) => {
                        if l.is_none() {
                            inc(&self.c2.stats.probe_not_found);
                            reg.not_found_at.insert(coin, Instant::now());
                        }
                        reg.layouts.insert(coin, l);
                    }
                    Err(_) => {
                        // Node error: NOT "not found". Ask again later (backoff).
                        inc(&self.c2.stats.probe_errors);
                        self.outcomes.node_error += 1;
                        let n = self.probe_retry.get(&coin).map(|x| x.1 + 1).unwrap_or(1);
                        self.probe_retry.insert(coin, (Instant::now() + backoff(n), n));
                        let _ = soon;
                    }
                }
            }
            (JobFor::Tip, Done::Tip { res, .. }) => {
                if let Ok((tip, bf)) = res {
                    self.sh.node_tip.store(tip, Ordering::Relaxed);
                    if bf > 0 {
                        self.basefee = bf;
                    }
                }
            }
            (JobFor::Load { pools, .. }, Done::Fetch { block, res, .. }) => self.on_load(pools, block, res),
            (JobFor::Need { key, gen, items }, Done::Fetch { block, res, .. }) => self.on_need(key, gen, items, block, res),
            (JobFor::Fill, Done::Fetch { block, res, .. }) => self.on_fill(block, res),
            (JobFor::Trace, Done::Trace { coin, holder, res, .. }) => self.on_trace(coin, holder, res),
            _ => {}
        }
    }

    /// A balance trace came back: remember the slot (the load then fetches
    /// it at its own block), or mark the pool(s) unsure if no single slot
    /// holds exactly the balance. Node error: ask again in 3 s.
    fn on_trace(&mut self, coin: Address, holder: Address, res: Result<(U256, Value), crate::node::NodeErr>) {
        let pair = (coin, holder);
        self.tracing.remove(&pair);
        if let Some(n) = self.coins_tracing.get_mut(&coin) {
            *n -= 1;
            if *n == 0 {
                self.coins_tracing.remove(&coin);
            }
        }
        let (bal, tr) = match res {
            Ok(x) => x,
            Err(e) => {
                let why = e.to_string();
                self.note_node_error(&why);
                if why.contains(crate::node::SPEED_LIMIT) {
                    self.trace_retry.insert(pair, (Instant::now() + soon(), 0));
                } else {
                    let n = self.trace_retry.get(&pair).map(|x| x.1 + 1).unwrap_or(1);
                    self.trace_retry.insert(pair, (Instant::now() + backoff(n), n));
                }
                return;
            }
        };
        self.trace_retry.remove(&pair);
        let (found, facts) = read_trace(&tr, coin, bal);
        match found {
            Ok(slot) => {
                inc(&self.c2.stats.coin_trace_found);
                {
                    let mut reg = self.c2.reg.write().unwrap();
                    reg.pair_slots.insert(pair, slot);
                    // A standard layout (e.g. OpenZeppelin v5 namespaced,
                    // Solady)? Then every pool of this coin is known now.
                    match BalanceLayout::guess(holder, slot) {
                        Some(l) => {
                            inc(&self.c2.stats.layouts_guessed);
                            reg.layouts.insert(coin, Some(l));
                            reg.not_found_at.remove(&coin);
                        }
                        None => {
                            self.per_pool_coins.insert(coin);
                        }
                    }
                }
                // The coin's code and the settings balanceOf read: put in
                // where the copy doesn't know them (like a fill). The balance
                // itself comes with the pool's load, at its block.
                let facts: Vec<Fact> = facts.into_iter().filter(|f| !matches!(f, Fact::Slot(a, s, _) if *a == coin && *s == slot)).collect();
                if let Some(b) = self.last_block {
                    self.into_head(b, |s| {
                        for f in &facts {
                            let known = match f {
                                Fact::Slot(a, sl, _) => !matches!(s.storage(*a, *sl), Lookup::Missing),
                                Fact::Basics { addr, .. } => s.accounts.get(addr).is_some_and(|x| x.basics != Basics::Unknown),
                                _ => true,
                            };
                            if !known {
                                s.apply_fact(f);
                            }
                        }
                    });
                }
            }
            Err(n) => {
                inc(&self.c2.stats.coin_trace_not_found);
                self.outcomes.coin_not_found += 1;
                let why = format!("coin {coin}: can't find where it keeps this pool's balance ({n} storage values equal it)");
                self.trace_failed.insert(pair, (Instant::now(), why.clone()));
                let mut reg = self.c2.reg.write().unwrap();
                let until = Instant::now() + Duration::from_secs(self.cfg.layout_retry_s);
                for e in reg.pools.values_mut().filter(|e| e.pool.address == holder && (e.pool.token0 == coin || e.pool.token1 == coin)) {
                    if e.state != PoolState::Ready && !e.busy {
                        e.state = PoolState::Unsure;
                        e.reason = why.clone();
                        e.retry_at = until;
                    }
                }
            }
        }
    }

    /// One log line when a pool goes unsure because of a report (first 200,
    /// then every 100th): kind, pool, block, transaction, log index, why.
    fn log_unsure(&mut self, k: PoolKey, log: &PoolLog, block: u64, why: &str) {
        self.unsure_logged += 1;
        let n = self.unsure_logged;
        if n <= 200 || n % 100 == 0 {
            let kind = self.c2.reg.read().unwrap().pools.get(&k).map(|e| kind_name(e.pool.kind)).unwrap_or("?");
            let id = k.1.map(|i| format!(" id {i}")).unwrap_or_default();
            eprintln!(
                "[arbsim] copy2: {kind} pool {}{id} unsure at block {block} tx {} (index {}) log {}: {why} [#{n}]",
                k.0, log.tx_hash, log.tx_index, log.log_index
            );
        }
    }

    /// Put a pool back in the queue (node trouble, not the pool's fault).
    /// Count a failed node job: our own speed limit (nothing was sent) or a
    /// real node error.
    fn note_node_error(&mut self, why: &str) {
        if why.contains(crate::node::SPEED_LIMIT) {
            inc(&self.c2.stats.throttled);
        } else {
            inc(&self.c2.stats.node_errors);
            self.outcomes.node_error += 1;
        }
    }

    /// retry_later without counting (the job's error was counted once).
    fn retry_later_quiet(&mut self, k: PoolKey, gen: u64, why: &str) {
        self.partials.remove(&k);
        let mut reg = self.c2.reg.write().unwrap();
        if let Some(e) = reg.pools.get_mut(&k) {
            if e.gen == gen {
                e.busy = false;
                e.state = PoolState::Loading;
                e.reason = format!("loading: {why}");
                e.gen += 1;
                if why.contains(crate::node::SPEED_LIMIT) {
                    // Our own speed limit, nothing was sent: try again soon,
                    // not counted as a failure.
                    e.retry_at = Instant::now() + soon();
                } else {
                    e.fails = e.fails.saturating_add(1);
                    e.retry_at = Instant::now() + backoff(e.fails);
                }
            }
        }
    }

    fn retry_later(&mut self, k: PoolKey, gen: u64, why: &str) {
        if why.starts_with("node") || why.contains("node error") {
            self.note_node_error(why);
        }
        self.partials.remove(&k);
        let mut reg = self.c2.reg.write().unwrap();
        if let Some(e) = reg.pools.get_mut(&k) {
            if e.gen == gen {
                e.busy = false;
                e.state = PoolState::Loading;
                e.reason = format!("loading: {why}");
                e.gen += 1;
                if why.contains(crate::node::SPEED_LIMIT) {
                    e.retry_at = Instant::now() + soon();
                } else {
                    e.fails = e.fails.saturating_add(1);
                    // Wait longer each time in a row (1 s doubling to 30 s, +-25 %).
                    e.retry_at = Instant::now() + backoff(e.fails);
                }
            }
        }
    }

    fn on_load(&mut self, pools: Vec<LoadReq>, block: u64, res: Result<FetchOut, crate::node::NodeErr>) {
        let out = match res {
            Ok(o) => o,
            Err(e) => {
                let why = format!("node: {e}");
                self.note_node_error(&why);
                for r in pools {
                    self.retry_later_quiet(r.key, r.gen, &why);
                }
                return;
            }
        };
        // Each pool is digested on its own (work() lets new blocks in between).
        let out = Arc::new(out);
        for r in pools {
            self.load_q.push_back((r, out.clone(), block));
        }
    }

    /// Digest one pool's part of a load answer.
    fn on_load_one(&mut self, r: LoadReq, out: Arc<FetchOut>, block: u64) {
        let pool = {
            let reg = self.c2.reg.read().unwrap();
            match reg.pools.get(&r.key) {
                Some(e) if e.gen == r.gen && e.busy => e.pool.clone(),
                _ => return, // untracked / unsure meanwhile
            }
        };
        let mut facts = Vec::new();
        let mut vals: HashMap<(Address, U256), U256> = HashMap::new();
        let mut err: Option<(bool, String)> = None; // (node's fault, why)
        for (it, f) in &out.items[r.items.0..r.items.1] {
            match f {
                Ok(f) => {
                    if let Fetched::Slot(a, s, v) = f {
                        vals.insert((*a, *s), *v);
                    }
                    facts.push(fact_of(f));
                }
                Err(ItemErr::BlockUnavailable) => err = Some((true, "node not at that block yet".into())),
                Err(e) => err = Some((true, format!("node could not give {it:?}: {e:?}"))),
            }
        }
        // A getter / balanceOf that came back with an error object is the
        // node's trouble, not a mismatch: ask again later.
        if err.is_none() {
            for i in r.getters.iter().map(|g| g.1).chain(r.coin_checks.iter().map(|c| c.3)) {
                if let Err(e) = &out.calls[i] {
                    if e.to_ascii_lowercase().contains("revert") {
                        // The pool's own getter refuses: not a standard pool
                        // of this kind (unsure with the long layout wait, not
                        // retried every few seconds).
                        self.outcomes.mismatch += 1;
                        inc(&self.c2.stats.load_failed);
                        self.make_unsure(r.key, &format!("layout: a getter reverts ({e})"), None, block + 1);
                        return;
                    }
                    err = Some((true, format!("node error on a check call: {e}")));
                }
            }
        }
        if let Some((_, why)) = err {
            self.retry_later(r.key, r.gen, &why);
            return;
        }
        // Storage layout check (first load only).
        if !r.getters.is_empty() {
            let get = |name: &str, w: usize| -> Result<U256, String> {
                let i = r.getters.iter().find(|x| x.0 == name).map(|x| x.1).ok_or("getter missing")?;
                out_word(&out.calls[i], w).map_err(|e| format!("layout: {name} failed ({e})"))
            };
            if let Err(why) = verify_layout(&pool, &vals, get) {
                self.outcomes.mismatch += 1;
                inc(&self.c2.stats.load_failed);
                self.make_unsure(r.key, &why, None, block + 1);
                return;
            }
        }
        // Coin check: the balance really is that storage value (once per coin).
        let mut coin_bad = None;
        for (c, slot, _, ci) in &r.coin_checks {
            let held = vals.get(&(*c, *slot)).copied();
            match out_word(&out.calls[*ci], 0) {
                Ok(b) if Some(b) == held => {
                    self.coin_ok.insert(*c);
                }
                Ok(b) => coin_bad = Some((*c, format!("coin {c}: balance not readable from its storage (slot {held:?} vs balanceOf {b})"))),
                Err(e) => coin_bad = Some((*c, format!("coin {c}: balanceOf failed ({e})"))),
            }
        }
        if let Some((c, why)) = coin_bad {
            self.outcomes.mismatch += 1;
            inc(&self.c2.stats.load_failed);
            {
                let mut reg = self.c2.reg.write().unwrap();
                reg.layouts.insert(c, None);
                reg.not_found_at.insert(c, Instant::now());
            }
            self.make_unsure(r.key, &why, None, block + 1);
            return;
        }
        {
            let mut reg = self.c2.reg.write().unwrap();
            if let Some(e) = reg.pools.get_mut(&r.key) {
                e.verified = true;
            }
        }
        let mut ov = self.empty_copy();
        for f in &facts {
            ov.learn(f);
        }
        self.continue_partial(r.key, Partial { ov, cursor: (block + 1, 0, 0), gen: r.gen, errors: 0 });
    }

    fn on_need(&mut self, key: PoolKey, gen: u64, items: Vec<MissItem>, block: u64, res: Result<FetchOut, crate::node::NodeErr>) {
        let Some(mut part) = self.partials.remove(&key) else { return };
        if part.gen != gen {
            return;
        }
        // Node trouble: keep the working copy, ask again in a second (10x
        // in a row = start the load over).
        let why = match &res {
            Err(e) => Some(format!("node: {e}")),
            Ok(o) => o.items.iter().find_map(|(it, f)| f.as_ref().err().map(|e| format!("node could not give {it:?} at block {block}: {e:?}"))),
        };
        // The node simply isn't at that block yet (it trails the websocket by
        // a few blocks): ask again shortly, not counted as an error.
        let not_yet = matches!(&res, Err(crate::node::NodeErr::BadResponse(m)) if m.contains(NOT_YET))
            || matches!(&res, Ok(o) if o.items.iter().any(|(_, f)| matches!(f, Err(ItemErr::BlockUnavailable))));
        if not_yet {
            self.partials.insert(key, part);
            self.delayed.push((Instant::now() + Duration::from_millis(300), key, gen, items));
            return;
        }
        if let Some(why) = why {
            self.note_node_error(&why);
            if why.contains(crate::node::SPEED_LIMIT) {
                // Nothing was sent: try again soon, not an error.
                self.partials.insert(key, part);
                self.delayed.push((Instant::now() + soon(), key, gen, items));
                return;
            }
            part.errors += 1;
            let errs = part.errors;
            if part.errors >= 10 {
                self.partials.insert(key, part);
                self.retry_later(key, gen, &why);
            } else {
                self.partials.insert(key, part);
                self.delayed.push((Instant::now() + backoff(errs), key, gen, items));
            }
            return;
        }
        part.errors = 0;
        for (_, f) in &res.unwrap().items {
            if let Ok(f) = f {
                part.ov.learn(&fact_of(f));
            }
        }
        self.continue_partial(key, part);
    }

    /// Ask for items a working copy needs, at the block before its cursor.
    fn send_need(&mut self, key: PoolKey, part: Partial, items: Vec<MissItem>) {
        inc(&self.c2.stats.need_item_rounds);
        let over = {
            let mut reg = self.c2.reg.write().unwrap();
            match reg.pools.get_mut(&key) {
                Some(e) => {
                    e.rounds += 1;
                    e.reason = format!("loading: fetching {} more value(s) (round {})", items.len(), e.rounds);
                    e.rounds > self.cfg.max_rounds
                }
                None => return,
            }
        };
        if over {
            self.make_unsure(key, "too many fetch rounds while loading", None, u64::MAX);
            return;
        }
        // Code can't be fetched by hash; the replayer names accounts instead.
        let items: Vec<MissItem> = items.into_iter().filter(|m| !matches!(m, MissItem::Code(_))).collect();
        if items.is_empty() {
            self.make_unsure(key, "needs contract code it can't name", None, u64::MAX);
            return;
        }
        self.send_need_job(key, part, items);
    }

    /// Send the fetch for a working copy (exactly at the block before its cursor).
    fn send_need_job(&mut self, key: PoolKey, part: Partial, items: Vec<MissItem>) {
        let gen = part.gen;
        let at = part.cursor.0.saturating_sub(1);
        // An old block is a slow archive read on this node: start the load
        // over at the newest block instead (it then carries only a few blocks).
        if self.last_block.unwrap_or(0).saturating_sub(at) > 8 {
            self.partials.insert(key, part);
            self.retry_later_quiet(key, gen, "catch-up block too old, reloading at the newest block");
            if let Some(e) = self.c2.reg.write().unwrap().pools.get_mut(&key) {
                e.retry_at = Instant::now();
                e.fails = e.fails.saturating_sub(1);
            }
            return;
        }
        self.partials.insert(key, part);
        let id = self.new_job(JobFor::Need { key, gen, items: items.clone() });
        match &self.loaders {
            Some(l) => l.send(Job::Fetch { id, block: at, exact: true, bulk: false, items, calls: vec![] }),
            None => {
                self.jobs.remove(&id);
                self.make_unsure(key, "no node configured to load it from", None, u64::MAX);
            }
        }
    }

    /// A ready replay pool needs values it doesn't hold, in the middle of a
    /// block: from this report on it loads in the background (never waits).
    fn start_partial_in_block(&mut self, ov: &mut Overlay, k: PoolKey, cursor: Pos, items: Vec<MissItem>) {
        let (pool, owned_items, accounts, gen) = {
            let mut reg = self.c2.reg.write().unwrap();
            let Some(e) = reg.pools.get_mut(&k) else { return };
            e.gen += 1;
            e.state = PoolState::Loading;
            e.busy = true;
            e.rounds = 0;
            (e.pool.clone(), e.items.clone(), e.accounts.clone(), e.gen)
        };
        // Its working copy: what the block copy holds for it right now.
        let mut part = self.empty_copy();
        for (a, s) in &owned_items {
            if let Lookup::Known(v) = ov.slot(*a, *s) {
                part.learn(&Fact::Slot(*a, *s, v));
            }
        }
        for a in accounts.iter().chain(std::iter::once(&pool.address)) {
            if let Some(acct) = ov.snapshot().accounts.get(a) {
                if let Basics::Known(info) = &acct.basics {
                    part.learn(&Fact::Basics { addr: *a, info: info.clone(), code: None });
                }
            }
        }
        let bals: Vec<(Address, U256)> = {
            let reg = self.c2.reg.read().unwrap();
            [pool.token0, pool.token1].into_iter().filter_map(|c| reg.bal_slot(c, pool.address).map(|s| (c, s))).collect()
        };
        for (c, s) in bals {
            if let Lookup::Known(v) = ov.slot(c, s) {
                part.learn(&Fact::Slot(c, s, v));
            }
        }
        // The block copy no longer vouches for it.
        for (a, s) in &owned_items {
            ov.forget_slot(*a, *s);
        }
        self.send_need(k, Partial { ov: part, cursor, gen, errors: 0 }, items);
    }

    /// Carry a working copy forward through the buffered reports up to the
    /// newest block, then put it into the copy (pool READY). Pauses when it
    /// needs node values (send_need).
    fn continue_partial(&mut self, key: PoolKey, mut part: Partial) {
        let (pool, gen_now) = {
            let reg = self.c2.reg.read().unwrap();
            match reg.pools.get(&key) {
                Some(e) => (e.pool.clone(), e.gen),
                None => return,
            }
        };
        if gen_now != part.gen {
            return;
        }
        // Missing core values (e.g. Solidly's last observation): fetch first.
        let core = missing_core(&pool, &part.ov);
        if !core.is_empty() {
            self.send_need(key, part, core);
            return;
        }
        let last = self.last_block.unwrap_or(0);
        if part.cursor.0 <= last && self.buf.front().is_none_or(|b| b.block > part.cursor.0) {
            // The reports since the fetch are no longer kept (too slow): start over.
            inc(&self.c2.stats.carry_too_old);
            self.retry_later(key, part.gen, "load took longer than the reports kept (ARBSIM_COPY2_KEEP_BLOCKS)");
            return;
        }
        let coin_slots: Vec<(Address, U256)> = {
            let reg = self.c2.reg.read().unwrap();
            [pool.token0, pool.token1].into_iter().filter(|c| *c != Address::ZERO).filter_map(|c| reg.bal_slot(c, pool.address).map(|s| (c, s))).collect()
        };
        let start = self.buf.partition_point(|b| b.block < part.cursor.0);
        let blocks: Vec<(u64, ReplayCtx, Arc<Vec<PoolLog>>)> = self.buf.iter().skip(start).map(|b| (b.block, b.rctx, b.logs.clone())).collect();
        for (block, rctx, logs) in blocks {
            part.ov.set_position(StatePosition { base_block: block, after_seq: None });
            for log in logs.iter() {
                let pos = (block, log.tx_index, log.log_index);
                if pos < part.cursor {
                    continue;
                }
                if is_pool_event(&pool, log) {
                    inc(&self.c2.stats.carried_events);
                    let mut f = part.ov.fork();
                    match apply_event(&mut f, &pool, log, &rctx) {
                        ApplyResult::Applied => part.ov.absorb(&f),
                        ApplyResult::NeedItems(items) => {
                            part.cursor = pos;
                            self.send_need(key, part, items);
                            return;
                        }
                        ApplyResult::Unsure(why) => {
                            self.outcomes.other_unsure += 1;
                            self.log_unsure(key, log, block, &format!("while loading: {why}"));
                            self.make_unsure(key, &why, None, u64::MAX);
                            return;
                        }
                    }
                }
                // Its coin balances.
                if let Some((coin, from, to, v)) = coin_transfer(log) {
                    for (side, is_from) in [(from, true), (to, false)] {
                        if side != pool.address {
                            continue;
                        }
                        let Some((_, slot)) = coin_slots.iter().find(|(c, _)| *c == coin) else { continue };
                        if let Lookup::Known(cur) = part.ov.slot(coin, *slot) {
                            match if is_from { cur.checked_sub(v) } else { cur.checked_add(v) } {
                                Some(x) => part.ov.set_slot(coin, *slot, x),
                                None => {
                                    self.make_unsure(key, &format!("coin {coin}: balance went below zero while loading"), None, u64::MAX);
                                    return;
                                }
                            }
                        }
                    }
                }
            }
            if pool.kind == PoolKind::Algebra && part.cursor <= (block, END, END) {
                let mut f = part.ov.fork();
                match finish_block(&mut f, &pool, &rctx) {
                    ApplyResult::Applied => part.ov.absorb(&f),
                    ApplyResult::NeedItems(items) => {
                        part.cursor = (block, END, END);
                        self.send_need(key, part, items);
                        return;
                    }
                    ApplyResult::Unsure(why) => {
                        self.make_unsure(key, &format!("end of block: {why}"), None, u64::MAX);
                        return;
                    }
                }
            }
            part.cursor = (block + 1, 0, 0);
        }
        self.merge(key, part);
    }

    /// The working copy has reached the newest block: put its values into
    /// the head version and mark the pool READY.
    fn merge(&mut self, key: PoolKey, part: Partial) {
        let Some(head) = self.sh.head() else { return };
        let (pool, holders, old_owned, bal_slots) = {
            let reg = self.c2.reg.read().unwrap();
            let Some(e) = reg.pools.get(&key) else { return };
            let bs: Vec<(Address, U256)> =
                [e.pool.token0, e.pool.token1].into_iter().filter_map(|c| reg.bal_slot(c, e.pool.address).map(|s| (c, s))).collect();
            (e.pool.clone(), reg.holders.keys().copied().collect::<HashSet<Address>>(), e.owned.clone(), bs)
        };
        let snap = part.ov.snapshot();
        // Accounts the pool's own replays change (e.g. an Algebra plugin)
        // are its own; other accounts (coins, a factory, an implementation)
        // are shared: their values are put in, but not followed with it.
        let mut owned: Vec<Address> = old_owned;
        for a in part.ov.changes().accounts.keys() {
            if *a != pool.address && !holders.contains(a) && !owned.contains(a) {
                owned.push(*a);
            }
        }
        let mut facts: Vec<Fact> = Vec::new();
        let mut items: HashSet<(Address, U256)> = HashSet::new();
        let mut accounts: HashSet<Address> = HashSet::new();
        for (addr, acct) in snap.accounts.iter() {
            let own = *addr == pool.address || owned.contains(addr);
            if let Basics::Known(info) = &acct.basics {
                if own {
                    accounts.insert(*addr);
                }
                let code = info.as_ref().and_then(|i| snap.codes.get(&i.code_hash).cloned());
                facts.push(Fact::Basics { addr: *addr, info: info.clone(), code });
            }
            for (s, v) in acct.storage.iter() {
                if own {
                    items.insert((*addr, *s));
                }
                facts.push(Fact::Slot(*addr, *s, *v));
            }
        }
        // Write where the head doesn't know the value (values the head knows
        // are followed exactly already, e.g. a coin balance or a V4
        // PoolManager slot shared with a ready pool).
        let ok = self.into_head(head.block, |s| {
            for f in &facts {
                let known = match f {
                    Fact::Slot(a, sl, _) => !matches!(s.storage(*a, *sl), Lookup::Missing),
                    Fact::Basics { addr, .. } => s.accounts.get(addr).is_some_and(|x| x.basics != Basics::Unknown),
                    _ => true,
                };
                if !known {
                    s.apply_fact(f);
                }
            }
        });
        if !ok {
            self.retry_later(key, part.gen, "copy moved on while merging");
            return;
        }
        inc(&self.c2.stats.merges);
        inc(&self.c2.stats.load_ok);
        self.outcomes.ready += 1;
        // Everything up to the end of this block is in it now.
        self.last_pos.insert(key, (head.block, END, END));
        for (c, _) in &bal_slots {
            self.coin_pos.insert((*c, pool.address), (head.block, END, END));
        }
        let mut reg = self.c2.reg.write().unwrap();
        if let Some(e) = reg.pools.get_mut(&key) {
            e.state = PoolState::Ready;
            e.reason = String::new();
            e.busy = false;
            e.ever_ready = true;
            e.fails = 0;
            e.ready_since = head.block;
            e.items.extend(items);
            e.accounts.extend(accounts);
            for o in &owned {
                if !e.owned.contains(o) {
                    e.owned.push(*o);
                }
            }
        }
        for o in owned {
            reg.owner_of.insert(o, key);
        }
    }

    // ---- fills ----
    /// Which address's pools a slot belongs to (None = not followed).
    fn gate_of(reg: &Registry, a: Address, s: U256) -> Option<Address> {
        if reg.by_addr.contains_key(&a) || reg.owner_of.contains_key(&a) {
            return Some(a);
        }
        if let Some(h) = reg.holders.get(&a) {
            return h.iter().find(|h| reg.bal_slot(a, **h) == Some(s)).copied();
        }
        None
    }

    /// Send items checks missed to the loaders (fetched at the head block).
    fn dispatch_fills(&mut self) {
        // One fill job at a time (so fills use at most one worker), at most
        // 100 values grouped into one eth_getProof per account; values of
        // pools that aren't ready are refused (their load brings them).
        if self.loaders.is_none() || self.jobs.values().any(|j| matches!(j, JobFor::Fill)) {
            return;
        }
        let items = self.fills.take(100);
        if items.is_empty() {
            return;
        }
        let Some(head) = self.sh.head() else { return };
        let (ok, refused): (Vec<MissItem>, Vec<MissItem>) = {
            let reg = self.c2.reg.read().unwrap();
            items.into_iter().filter(|m| needs(&head.snap, m)).partition(|m| match m {
                MissItem::Account(_) => true, // basics + code
                MissItem::Slot(a, s) => match Self::gate_of(&reg, *a, *s) {
                    Some(g) => reg.blocked_account(&g).is_none(),
                    None => true,
                },
                MissItem::Code(_) => false,
            })
        };
        add(&self.c2.stats.fill_refused, refused.len() as u64);
        if ok.is_empty() {
            return;
        }
        inc(&self.c2.stats.fills);
        let accounts: HashSet<Address> = ok.iter().filter_map(|m| match m {
            MissItem::Account(a) | MissItem::Slot(a, _) => Some(*a),
            MissItem::Code(_) => None,
        }).collect();
        let _ = accounts;
        let id = self.new_job(JobFor::Fill);
        self.loaders.as_ref().unwrap().send(Job::Fetch { id, block: head.block, exact: false, bulk: false, items: ok, calls: vec![] });
    }

    /// Fill answers: used only if nothing we follow touched them after k.
    fn on_fill(&mut self, k: u64, res: Result<FetchOut, crate::node::NodeErr>) {
        let out = match res {
            Ok(o) => o,
            Err(e) => {
                // Dropped: a check that still needs them asks again.
                self.note_node_error(&e.to_string());
                return;
            }
        };
        let mut good: Vec<Fetched> = Vec::new();
        let mut again: Vec<MissItem> = Vec::new();
        {
            let mut reg = self.c2.reg.write().unwrap();
            for (it, f) in out.items {
                let f = match f {
                    Ok(f) => f,
                    Err(ItemErr::BlockUnavailable) => {
                        again.push(it);
                        continue;
                    }
                    Err(_) => continue,
                };
                if let Fetched::Slot(a, s, _) = &f {
                    if self.touched_slot.get(&(*a, *s)).is_some_and(|b| *b > k) {
                        again.push(it);
                        continue;
                    }
                    if let Some(g) = Self::gate_of(&reg, *a, *s) {
                        let keys = reg.pools_of(&g);
                        let all_ok = keys.iter().all(|pk| reg.pools.get(pk).is_some_and(|e| e.state == PoolState::Ready && e.ready_since <= k));
                        let quiet = self.touched_addr.get(&g).is_none_or(|b| *b <= k);
                        if !all_ok {
                            continue; // refused: the pool isn't followed right now
                        }
                        if !quiet {
                            again.push(it);
                            continue;
                        }
                        // A pool's own value: followed (and forgotten) with it.
                        if reg.by_addr.contains_key(a) || reg.owner_of.contains_key(a) {
                            for pk in keys {
                                if let Some(e) = reg.pools.get_mut(&pk) {
                                    e.items.insert((*a, *s));
                                }
                                let lp = self.last_pos.entry(pk).or_insert((0, 0, 0));
                                *lp = (*lp).max((k, END, END));
                            }
                        } else {
                            // A pool's coin balance.
                            let cp = self.coin_pos.entry((*a, g)).or_insert((0, 0, 0));
                            *cp = (*cp).max((k, END, END));
                        }
                    }
                }
                good.push(f);
            }
        }
        if !again.is_empty() {
            add(&self.c2.stats.fill_retry, again.len() as u64);
            self.fills.push(again);
        }
        if good.is_empty() {
            return;
        }
        add(&self.c2.stats.fill_items, good.len() as u64);
        {
            let mut p = self.sh.published.write().unwrap();
            reconcile(&mut p.versions, k, &good);
        }
        self.sh.notify();
    }

    // ---- upkeep ----
    fn dispatch_tip(&mut self) {
        if self.loaders.is_none() || self.cfg.tip_every_s == 0 {
            return;
        }
        if self.last_tip.is_some_and(|t| t.elapsed() < Duration::from_secs(self.cfg.tip_every_s)) {
            return;
        }
        self.last_tip = Some(Instant::now());
        let id = self.new_job(JobFor::Tip);
        self.loaders.as_ref().unwrap().send(Job::Tip { id });
    }

    /// Loud log line if node work is waiting but no answer came back for
    /// 30 s (at most once per 30 s): what each loader thread is doing, the
    /// queues, and the node client's speed-limit wait per lane.
    fn watchdog(&mut self) {
        if self.jobs.is_empty() || self.last_watchdog.is_some_and(|t| t.elapsed() < Duration::from_secs(30)) {
            return;
        }
        let ls = &self.c2.loader;
        let quiet = ls.since_last_done().unwrap_or_else(|| self.started.elapsed());
        if quiet < Duration::from_secs(30) {
            return;
        }
        self.last_watchdog = Some(Instant::now());
        let (u, b, t) = ls.queue_lengths();
        let node = self.sh.node.as_ref().map(|n| n.usage()).unwrap_or(Value::Null);
        eprintln!(
            "[arbsim] copy2 WATCHDOG: no node answer for {} s while {} job(s) wait or run (queued: {u} urgent, {b} bulk, {t} traces). Threads: {}. Node: {}",
            quiet.as_secs(),
            self.jobs.len(),
            ls.thread_states().join("; "),
            node
        );
    }

    /// Log (once) when every pool of the current load round has been tried.
    fn note_round(&mut self) {
        let Some((t0, req0, n)) = self.round else { return };
        let (waiting, ready, unsure) = {
            let reg = self.c2.reg.read().unwrap();
            let waiting = reg.pools.values().filter(|e| e.state == PoolState::Loading && !e.ever_ready).count();
            let (_, r, u) = reg.counts();
            (waiting, r, u)
        };
        let requests = self.c2.node_requests.load(Ordering::Relaxed) - req0;
        let secs = t0.elapsed().as_secs_f64();
        let out = self.outcomes;
        *self.c2.load_round.lock().unwrap() = LoadRound { pools: n, seconds: secs, requests, ready, unsure, done: waiting == 0, out };
        if waiting == 0 {
            eprintln!(
                "[arbsim] copy2: load round done: {n} new pool(s) in {secs:.1} s using {requests} node requests; now {ready} ready, {unsure} unsure; outcomes: {}",
                out.text()
            );
            self.round = None;
        } else if self.last_progress.elapsed() >= Duration::from_secs(60) {
            self.last_progress = Instant::now();
            eprintln!(
                "[arbsim] copy2: load round running {secs:.0} s: {waiting} of {n} still loading, {requests} node requests; outcomes so far: {}",
                out.text()
            );
        }
    }

    fn prune_touched(&mut self) {
        let oldest = self.buf.front().map(|b| b.block).unwrap_or(0);
        let keep_from = oldest.min(self.sh.published.read().unwrap().versions.front().map(|v| v.block).unwrap_or(0));
        self.touched_addr.retain(|_, b| *b >= keep_from);
        self.touched_slot.retain(|_, b| *b >= keep_from);
    }

    /// Memory cap: drop accounts that aren't our pools / coins / owned.
    fn evict(&mut self) {
        let keep: HashSet<Address> = {
            let reg = self.c2.reg.read().unwrap();
            let mut k: HashSet<Address> = reg.by_addr.keys().copied().collect();
            k.extend(reg.holders.keys().copied());
            k.extend(reg.owner_of.keys().copied());
            k
        };
        let (ma, ms) = (self.sh.cfg.max_accounts, self.sh.cfg.max_slots);
        let Some(h) = self.sh.head() else { return };
        let (a, s, _) = h.snap.counts();
        if a <= ma && s <= ms {
            return;
        }
        self.into_head(h.block, |snap| {
            snap.evict(ma, ms, |_| 0, |x| keep.contains(x));
        });
    }
}


/// Slots a pool's swap reads besides what its events change (loaded with it),
/// as (account, slot). Ticks / bitmap words / observations of replay pools
/// are fetched when their replays or checks need them.
fn load_slots(p: &TrackedPool) -> Vec<(Address, U256)> {
    let a = p.address;
    let n = |v: &[u64]| v.iter().map(|x| (a, U256::from(*x))).collect::<Vec<_>>();
    match p.kind {
        // totalSupply, token0/1, reserves, price totals, lock
        PoolKind::V2 => n(&[0, 6, 7, 8, 9, 10, 12]),
        // supply, stable|token0, token1, poolFees, factory, observations,
        // decimals, reserves, time, totals, fee index
        PoolKind::Solidly => n(&[2, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]),
        // slot0, fee growth x2, protocol fees, liquidity
        PoolKind::V3 => n(&[0, 1, 2, 3, 4]),
        // slot0 (two slots), fee growth x2, protocol fees, liquidity
        PoolKind::PancakeV3 => n(&[0, 1, 2, 3, 4, 5]),
        // V4: _pools[id] (PoolManager slot 6): slot0, fee growth x2, liquidity
        PoolKind::V4 => match p.v4_id {
            Some(id) => {
                let mut buf = [0u8; 64];
                buf[..32].copy_from_slice(id.as_slice());
                buf[63] = 6;
                let base = U256::from_be_bytes(keccak256(buf).0);
                (0..4u64).map(|i| (a, base + U256::from(i))).collect()
            }
            None => vec![],
        },
        PoolKind::Algebra => vec![],
    }
}

/// The implementation a minimal proxy (EIP-1167 clone) forwards to.
fn proxy_target(ov: &Overlay, a: Address) -> Option<Address> {
    let Lookup::Known(Some(info)) = ov.account(a) else { return None };
    let Lookup::Known(code) = ov.code_by_hash(info.code_hash) else { return None };
    let b = code.original_byte_slice();
    // 363d3d373d3d3d363d73 <20 bytes> 5af43d82803e903d91602b57fd5bf3
    if b.len() == 45 && b[..10] == [0x36, 0x3d, 0x3d, 0x37, 0x3d, 0x3d, 0x3d, 0x36, 0x3d, 0x73] {
        Some(Address::from_slice(&b[10..30]))
    } else {
        None
    }
}

/// A prestate trace of coin.balanceOf(pool): Ok(the one slot of `coin`
/// holding exactly `bal`) or Err(how many did), plus facts for every
/// account / value the call read (code, the coin's settings), exact at the
/// traced block.
fn read_trace(tr: &Value, coin: Address, bal: U256) -> (Result<U256, usize>, Vec<Fact>) {
    let mut facts = Vec::new();
    let mut cands = Vec::new();
    let Some(m) = tr.as_object() else { return (Err(0), facts) };
    for (k, acct) in m {
        let Ok(a) = parse_address(k) else { continue };
        let bal_of = acct.get("balance").and_then(|x| x.as_str()).and_then(|x| parse_u256(x).ok()).unwrap_or_default();
        let nonce = match acct.get("nonce") {
            Some(Value::Number(n)) => n.as_u64().unwrap_or(0),
            Some(Value::String(t)) => parse_u64(t).unwrap_or(0),
            _ => 0,
        };
        let code = acct.get("code").and_then(|x| x.as_str()).and_then(|x| parse_bytes(x).ok()).unwrap_or_default();
        let fa = crate::node::FetchedAccount { balance: bal_of, nonce, code };
        let empty = fa.balance.is_zero() && fa.nonce == 0 && fa.code.is_empty();
        let (info, code) = account_info(if empty { None } else { Some(&fa) });
        facts.push(Fact::Basics { addr: a, info, code });
        if let Some(st) = acct.get("storage").and_then(|x| x.as_object()) {
            for (sk, sv) in st {
                let (Ok(sk), Ok(sv)) = (parse_u256(sk), sv.as_str().map(parse_u256).unwrap_or(Err(String::new()))) else { continue };
                if a == coin && sv == bal {
                    cands.push(sk);
                }
                facts.push(Fact::Slot(a, sk, sv));
            }
        }
    }
    let found = if cands.len() == 1 { Ok(cands[0]) } else { Err(cands.len()) };
    // The candidate itself is added by the caller (as the pool's balance);
    // with no single candidate, no coin value is kept at all.
    if found.is_err() {
        facts.retain(|f| !matches!(f, Fact::Slot(x, _, _) if *x == coin));
    }
    (found, facts)
}

/// After a refusal by our own speed limit (nothing sent): ~0.3 s.
fn soon() -> Duration {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    Duration::from_millis(200 + (nanos % 200) as u64)
}

/// Wait before trying again after `n` failures in a row: 1 s doubling up to
/// 30 s, +-25 % so retries don't line up.
fn backoff(n: u32) -> Duration {
    let base = (1u64 << n.saturating_sub(1).min(5)).min(30) as f64;
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let jitter = 0.75 + 0.5 * (nanos % 1000) as f64 / 1000.0;
    Duration::from_secs_f64(base * jitter)
}

/// A report's identity: (tx index, log index, tx hash).
type LogId = (u32, u32, B256);

fn log_id(l: &PoolLog) -> LogId {
    (l.tx_index, l.log_index, l.tx_hash)
}

/// Ids of the non-removed logs, in chain order.
fn log_ids(logs: &[PoolLog]) -> Vec<LogId> {
    let mut v: Vec<LogId> = logs.iter().filter(|l| !l.removed).map(log_id).collect();
    v.sort();
    v
}

/// Forget one slot in a snapshot (whole account if it was "complete").
fn forget_slot(s: &mut Snapshot, a: Address, slot: U256) {
    let complete = s.accounts.get(&a).is_some_and(|x| x.storage_complete);
    if complete {
        s.apply_fact(&Fact::Forget(a));
    } else if let Some(acct) = s.accounts.get_mut(&a) {
        acct.storage.remove(&slot);
    }
}

fn needs(s: &Snapshot, m: &MissItem) -> bool {
    match m {
        MissItem::Account(a) => {
            let v = crate::state::snap::View::new(Arc::new(s.clone()));
            matches!(v.account(*a), Lookup::Missing)
        }
        MissItem::Slot(a, sl) => matches!(s.storage(*a, *sl), Lookup::Missing),
        MissItem::Code(_) => false,
    }
}

/// 4-byte function selector as call data.
pub fn selector(sig: &str) -> String {
    to_hex(&keccak256(sig.as_bytes()).0[..4])
}

/// Do the slots we read say the same as the pool's own getters? (A fork
/// with another storage layout fails here and is never followed.)
fn verify_layout(p: &TrackedPool, vals: &HashMap<(Address, U256), U256>, g: impl Fn(&str, usize) -> Result<U256, String>) -> Result<(), String> {
    let s = |n: u64| vals.get(&(p.address, U256::from(n))).copied().unwrap_or_default();
    let bad = |what: &str| Err(format!("layout: {what} in storage doesn't match the pool's getter (not a standard {} pool)", kind_name(p.kind)));
    let addr_word = |a: Address| U256::from_be_slice(a.as_slice());
    let mask112 = (U256::from(1) << 112usize) - U256::from(1);
    match p.kind {
        PoolKind::V2 => {
            let r = s(v2::RESERVES);
            if g("getReserves()", 0)? != r & mask112 || g("getReserves()", 1)? != (r >> 112usize) & mask112 || g("getReserves()", 2)? != r >> 224usize {
                return bad("reserves");
            }
            if s(v2::TOKEN0) != addr_word(p.token0) || s(v2::TOKEN1) != addr_word(p.token1) {
                return bad("token0/token1");
            }
        }
        PoolKind::Solidly => {
            if g("getReserves()", 0)? != s(sol::RESERVE0) || g("getReserves()", 1)? != s(sol::RESERVE1) || g("getReserves()", 2)? != s(sol::TS_LAST) {
                return bad("reserves");
            }
            if g("index0()", 0)? != s(sol::INDEX0) {
                return bad("fee index");
            }
            if g("observationLength()", 0)? != s(sol::OBS_LEN) || s(sol::OBS_LEN).is_zero() {
                return bad("observations");
            }
            if (s(sol::STABLE_TOKEN0) >> 8usize) & addr_word(Address::repeat_byte(0xff)) != addr_word(p.token0) || s(sol::TOKEN1) != addr_word(p.token1) {
                return bad("token0/token1");
            }
        }
        _ => {}
    }
    Ok(())
}
