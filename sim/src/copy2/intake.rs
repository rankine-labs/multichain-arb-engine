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
//   6. Late reports: when a block is re-sent with the same reports plus new
//      ones AFTER them, only the new ones are applied (exact). Anything else
//      about an already-applied block is treated as a reorg (pools unsure).
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
use super::fields::{apply_fields, core_slots, obs_slot, sol, topic_addr, topics, v2};
use super::loader::{out_word, Done, FetchOut, Job, Loaders};
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
    late_reports_applied, coin_slot_msgs,
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
    /// Pools per load job [ARBSIM_COPY2_LOAD_BATCH, 25] (a job is split into
    /// node requests of ARBSIM_NODE_BATCH calls).
    pub load_batch: usize,
    /// Loader threads [ARBSIM_COPY2_LOADERS, 4]; load jobs in flight at most
    /// 2 per thread.
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
            load_batch: env_u64("ARBSIM_COPY2_LOAD_BATCH", 25).clamp(1, 500) as usize,
            loaders: env_u64("ARBSIM_COPY2_LOADERS", 4).clamp(1, 32) as usize,
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
    probe_retry: HashMap<Address, Instant>,
    outcomes: Outcomes,
    last_progress: Instant,
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
        in_flight: Mutex::new((0, 0)),
    });
    let loaders = sh.node.clone().map(|n| Loaders::spawn(cfg.loaders, n, tx.clone(), c2.node_requests.clone(), c2.node_tip.clone()));
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
        self.jobs.len() + self.done.len() + self.pending.len() + self.delayed.len()
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
            Input::Block(m) => {
                self.pending.insert(m.block, m);
            }
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
            let Some(d) = self.done.pop_front() else { break };
            self.on_done(d);
            if !self.drain() {
                break;
            }
        }
        self.dispatch_tip();
        self.dispatch_delayed();
        self.dispatch_loads();
        self.dispatch_fills();
        self.note_round();
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
                    if let (false, Some(Some(l))) = (still, reg.layouts.get(&c)) {
                        forget.push((c, l.key(e.pool.address)));
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
        // Lost message? (only if the bot tells us its previous block)
        if let (Some(prev), Some(last)) = (m.prev_block, self.last_msg_block) {
            if prev != last && m.block > last {
                inc(&st.gaps);
                eprintln!("[arbsim] copy2: message(s) lost between block {last} and {} (bot's previous: {prev}); reloading every pool", m.block);
                self.unsure_all(&format!("lost message before block {}", m.block), m.block);
                // The buffer has a hole: no load may carry across it.
                self.buf.clear();
            }
        }
        if m.block > self.last_msg_block.unwrap_or(0) {
            self.last_msg_block = Some(m.block);
        }
        // Reorged reports ("removed") make their pools unsure from that block on.
        let removed: Vec<PoolLog> = m.logs.iter().filter(|l| l.removed).cloned().collect();
        if !removed.is_empty() {
            inc(&st.reorgs);
            let from = removed.iter().map(|l| l.block).min().unwrap_or(m.block);
            let keys = self.pools_touched(&removed);
            self.unsure_from(&keys, "reorg (report taken back)", from);
        }
        // An old block again: identical = duplicate; different = reorg.
        if let Some(last) = self.last_block {
            if m.block <= last {
                if m.tick {
                    return;
                }
                let ids = log_ids(&m.logs);
                let known = self.recent.iter().find(|r| r.0 == m.block).cloned();
                if known.as_ref().is_some_and(|k| k.1 == ids) {
                    inc(&st.duplicate_blocks);
                    return;
                }
                // Same reports as before plus new ones strictly AFTER them?
                if let Some(k) = &known {
                    let old: HashSet<LogId> = k.1.iter().copied().collect();
                    let last_old = k.1.iter().map(|x| (x.0, x.1)).max();
                    let all_old_there = k.1.iter().all(|x| ids.contains(x));
                    let added: Vec<PoolLog> = m.logs.iter().filter(|l| !l.removed && !old.contains(&log_id(l))).cloned().collect();
                    let after = added.iter().all(|l| last_old.is_none_or(|lo| (l.tx_index, l.log_index) > lo));
                    if all_old_there && after && !added.is_empty() {
                        if m.block == last {
                            self.apply_late(m.block, added, ids);
                        } else {
                            // Later blocks are applied already: only the
                            // pools these new reports touch become unsure.
                            inc(&st.reorgs);
                            let keys = self.pools_touched(&added);
                            self.unsure_from(&keys, "late report for an older block", m.block);
                            if let Some(r) = self.recent.iter_mut().find(|r| r.0 == m.block) {
                                r.1 = ids;
                            }
                        }
                        return;
                    }
                }
                inc(&st.reorgs);
                let mut keys = self.pools_touched(&m.logs);
                if let Some(k) = known {
                    keys.extend(k.2);
                }
                self.unsure_from(&keys, "reorg (block re-sent with other reports)", m.block);
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
            if self.apply_coin_transfer(&mut ov, log, m.block) {
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

    /// Late reports for the newest block (same as before + new ones after
    /// them): apply only the new ones, in order, and replace the newest
    /// version with the result. Exact: nothing after them has been applied.
    fn apply_late(&mut self, block: u64, added: Vec<PoolLog>, ids: Vec<LogId>) {
        let Some(head) = self.sh.head() else { return };
        let Some(bb) = self.buf.back() else { return };
        if head.block != block || bb.block != block {
            return;
        }
        let rctx = bb.rctx;
        let mut added = added;
        added.sort_by_key(|l| (l.tx_index, l.log_index));
        let mut ov = Overlay::from_arc(&head.snap);
        ov.set_position(StatePosition { base_block: block, after_seq: None });
        let mut touched: Vec<PoolKey> = Vec::new();
        for log in &added {
            for k in self.pool_keys_for(log) {
                touched.push(k);
                self.touched_addr.insert(log.address, block);
                let (kind, ready) = {
                    let reg = self.c2.reg.read().unwrap();
                    let e = &reg.pools[&k];
                    (e.pool.kind, e.state == PoolState::Ready)
                };
                if kind == PoolKind::Algebra && ready {
                    // Its end-of-block step already ran: can't be exact.
                    self.make_unsure(k, "late report after its end of block", Some(&mut ov), block);
                } else if !ready {
                    // A load already carried past this block would miss it.
                    if self.partials.get(&k).is_some_and(|p| p.cursor.0 > block) {
                        let gen = self.partials[&k].gen;
                        self.retry_later(k, gen, "late report while loading");
                    }
                } else {
                    self.apply_ready_event(&mut ov, k, log, &rctx);
                }
            }
            self.apply_coin_transfer(&mut ov, log, block);
        }
        inc(&self.c2.stats.late_reports_applied);
        // The kept reports and the recent list learn the new ones.
        if let Some(bb) = self.buf.back_mut() {
            let mut v: Vec<PoolLog> = (*bb.logs).clone();
            v.extend(added);
            v.sort_by_key(|l| (l.tx_index, l.log_index));
            bb.logs = Arc::new(v);
        }
        if let Some(r) = self.recent.iter_mut().find(|r| r.0 == block) {
            r.1 = ids;
            r.2.extend(touched);
            r.2.sort();
            r.2.dedup();
        }
        let (snap, diff) = ov.into_parts();
        let mut p = self.sh.published.write().unwrap();
        let n = p.versions.len();
        let h = p.versions[n - 1].clone();
        let mut d = (*h.diff).clone();
        crate::state::diff::merge(&mut d, &diff);
        p.versions[n - 1] = Arc::new(Version { snap: Arc::new(snap), diff: Arc::new(d), applied: Instant::now(), ..(*h).clone() });
        drop(p);
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
                self.make_unsure(k, &why, Some(ov), rctx.number);
            }
            ApplyResult::NeedItems(items) => {
                // Don't wait: carry on in the background from this report.
                self.start_partial_in_block(ov, k, (log.block.max(rctx.number), log.tx_index, log.log_index), items);
            }
        }
    }

    /// A coin Transfer to / from one of our pools: move that pool's balance.
    /// Returns true if the log was such a transfer.
    fn apply_coin_transfer(&mut self, ov: &mut Overlay, log: &PoolLog, block: u64) -> bool {
        let Some((coin, from, to, v)) = coin_transfer(log) else { return false };
        let (followed, layout) = {
            let reg = self.c2.reg.read().unwrap();
            let Some(h) = reg.holders.get(&coin) else { return false };
            if !h.contains(&from) && !h.contains(&to) {
                return false;
            }
            (h.clone(), reg.layouts.get(&coin).copied().flatten())
        };
        inc(&self.c2.stats.coin_transfers);
        for side in [from, to] {
            if followed.contains(&side) {
                self.touched_addr.insert(side, block);
            }
        }
        // No known layout: the pools' balance slot isn't held, nothing to update.
        let Some(layout) = layout else { return true };
        for (side, is_from) in [(from, true), (to, false)] {
            if side == Address::ZERO {
                continue; // mint / burn of the coin: no balance slot
            }
            let slot = layout.key(side);
            self.touched_slot.insert((coin, slot), block);
            if followed.contains(&side) {
                if let Lookup::Known(cur) = ov.slot(coin, slot) {
                    match if is_from { cur.checked_sub(v) } else { cur.checked_add(v) } {
                        Some(x) => ov.set_slot(coin, slot, x),
                        None => {
                            // Our copy of that balance was wrong: forget it
                            // (fetched again when needed). Never a guess.
                            inc(&self.c2.stats.coin_slot_mismatch);
                            ov.forget_slot(coin, slot);
                        }
                    }
                }
            } else if matches!(ov.slot(coin, slot), Lookup::Known(_)) {
                // A wallet / the bot's contract: its other transfers never
                // reach us, so we don't vouch for its balance.
                inc(&self.c2.stats.other_side_forgotten);
                ov.forget_slot(coin, slot);
            }
        }
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
                        if let Some(Some(l)) = reg.layouts.get(&c) {
                            slots.push((c, l.key(e.pool.address)));
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
        let max_jobs = self.cfg.loaders * 2;
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
                .filter(|c| self.probe_retry.get(c).is_none_or(|t| *t <= now))
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
        // Pools ready to load (both coins' places known).
        let mut due: Vec<(Instant, PoolKey)> = {
            let mut reg = self.c2.reg.write().unwrap();
            let layouts = reg.layouts.clone();
            let mut d = Vec::new();
            for (k, e) in reg.pools.iter_mut() {
                if e.state == PoolState::Ready || e.busy || e.retry_at > now {
                    continue;
                }
                let coins: Vec<Address> = [e.pool.token0, e.pool.token1].into_iter().filter(|c| *c != Address::ZERO).collect();
                if coins.iter().any(|c| !layouts.contains_key(c)) {
                    continue; // still probing
                }
                if let Some(c) = coins.iter().find(|c| layouts[*c].is_none()) {
                    self.outcomes.coin_not_found += 1;
                    e.state = PoolState::Unsure;
                    e.reason = format!("coin {c}: can't find where it keeps balances");
                    e.retry_at = now + Duration::from_secs(self.cfg.layout_retry_s);
                    continue;
                }
                d.push((e.retry_at, *k));
            }
            d
        };
        due.sort();
        let mut due = due.into_iter().map(|x| x.1).peekable();
        while due.peek().is_some() && self.load_jobs_in_flight() < max_jobs {
            let keys: Vec<PoolKey> = due.by_ref().take(self.cfg.load_batch).collect();
            self.send_load(&keys, head.block);
        }
    }

    /// One load job for these pools at `block`.
    fn send_load(&mut self, keys: &[PoolKey], block: u64) {
        let mut items: Vec<MissItem> = Vec::new();
        let mut calls: Vec<(Address, Bytes)> = Vec::new();
        let mut reqs = Vec::new();
        {
            let mut reg = self.c2.reg.write().unwrap();
            let layouts = reg.layouts.clone();
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
                for s in core_slots(p.kind) {
                    push(&mut items, MissItem::Slot(p.address, U256::from(*s)));
                }
                if !e.verified {
                    let tok: &[u64] = match p.kind {
                        PoolKind::V2 => &[v2::TOKEN0, v2::TOKEN1],
                        PoolKind::Solidly => &[sol::TOKEN1],
                        _ => &[],
                    };
                    for s in tok {
                        push(&mut items, MissItem::Slot(p.address, U256::from(*s)));
                    }
                }
                for (a, s) in &e.items {
                    push(&mut items, MissItem::Slot(*a, *s));
                }
                for a in &e.accounts {
                    push(&mut items, MissItem::Account(*a));
                }
                let mut coin_checks = Vec::new();
                for c in [p.token0, p.token1] {
                    if c == Address::ZERO {
                        continue;
                    }
                    let Some(Some(l)) = layouts.get(&c) else { continue };
                    let slot = l.key(p.address);
                    let idx = items.len();
                    push(&mut items, MissItem::Slot(c, slot));
                    if !self.coin_ok.contains(&c) && items.len() > idx {
                        coin_checks.push((c, slot, idx, calls.len()));
                        calls.push((c, parse_bytes(&balance_of_data(p.address)).unwrap_or_default()));
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
        self.loaders.as_ref().unwrap().send(Job::Fetch { id, block, exact: false, items, calls });
    }

    // ---- node answers ----
    fn on_done(&mut self, d: Done) {
        let id = match &d {
            Done::Fetch { id, .. } | Done::Probe { id, .. } | Done::Tip { id, .. } => *id,
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
                        // Node error: NOT "not found". Ask again in a few seconds.
                        inc(&self.c2.stats.probe_errors);
                        self.outcomes.node_error += 1;
                        self.probe_retry.insert(coin, Instant::now() + Duration::from_secs(3));
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
            _ => {}
        }
    }

    /// Put a pool back in the queue (node trouble, not the pool's fault).
    fn retry_later(&mut self, k: PoolKey, gen: u64, why: &str) {
        self.partials.remove(&k);
        let mut reg = self.c2.reg.write().unwrap();
        if let Some(e) = reg.pools.get_mut(&k) {
            if e.gen == gen {
                self.outcomes.node_error += 1;
                e.busy = false;
                e.state = PoolState::Loading;
                e.reason = format!("loading: {why}");
                e.gen += 1;
                e.retry_at = Instant::now() + Duration::from_millis(self.cfg.reload_ms.max(500));
            }
        }
    }

    fn on_load(&mut self, pools: Vec<LoadReq>, block: u64, res: Result<FetchOut, crate::node::NodeErr>) {
        let out = match res {
            Ok(o) => o,
            Err(e) => {
                inc(&self.c2.stats.node_errors);
                for r in pools {
                    self.retry_later(r.key, r.gen, &format!("node: {e}"));
                }
                return;
            }
        };
        for r in pools {
            let pool = {
                let reg = self.c2.reg.read().unwrap();
                match reg.pools.get(&r.key) {
                    Some(e) if e.gen == r.gen && e.busy => e.pool.clone(),
                    _ => continue, // untracked / unsure meanwhile
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
                        err = Some((true, format!("node error on a check call: {e}")));
                    }
                }
            }
            if let Some((_, why)) = err {
                self.retry_later(r.key, r.gen, &why);
                continue;
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
                    continue;
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
                continue;
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
        if let Some(why) = why {
            inc(&self.c2.stats.node_errors);
            part.errors += 1;
            if part.errors >= 10 {
                self.partials.insert(key, part);
                self.retry_later(key, gen, &why);
            } else {
                self.partials.insert(key, part);
                self.delayed.push((Instant::now() + Duration::from_secs(1), key, gen, items));
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
        self.partials.insert(key, part);
        let id = self.new_job(JobFor::Need { key, gen, items: items.clone() });
        match &self.loaders {
            Some(l) => l.send(Job::Fetch { id, block: at, exact: true, items, calls: vec![] }),
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
        let layouts = self.c2.reg.read().unwrap().layouts.clone();
        for c in [pool.token0, pool.token1] {
            if let Some(Some(l)) = layouts.get(&c) {
                let s = l.key(pool.address);
                if let Lookup::Known(v) = ov.slot(c, s) {
                    part.learn(&Fact::Slot(c, s, v));
                }
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
        let layout = |c: Address| self.c2.reg.read().unwrap().layouts.get(&c).copied().flatten();
        let coin_slots: Vec<(Address, U256)> =
            [pool.token0, pool.token1].into_iter().filter(|c| *c != Address::ZERO).filter_map(|c| layout(c).map(|l| (c, l.key(pool.address)))).collect();
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
        let (pool, holders, layouts) = {
            let reg = self.c2.reg.read().unwrap();
            let Some(e) = reg.pools.get(&key) else { return };
            (e.pool.clone(), reg.holders.keys().copied().collect::<HashSet<Address>>(), reg.layouts.clone())
        };
        let snap = part.ov.snapshot();
        let mut facts: Vec<Fact> = Vec::new();
        let mut items: HashSet<(Address, U256)> = HashSet::new();
        let mut accounts: HashSet<Address> = HashSet::new();
        let mut owned: Vec<Address> = Vec::new();
        for (addr, acct) in snap.accounts.iter() {
            if holders.contains(addr) && *addr != pool.address {
                // A coin: only this pool's balance.
                if let Some(Some(l)) = layouts.get(addr) {
                    let s = l.key(pool.address);
                    if let Some(v) = acct.storage.get(&s) {
                        facts.push(Fact::Slot(*addr, s, *v));
                    }
                }
                continue;
            }
            if let Basics::Known(info) = &acct.basics {
                accounts.insert(*addr);
                let code = info.as_ref().and_then(|i| snap.codes.get(&i.code_hash).cloned());
                facts.push(Fact::Basics { addr: *addr, info: info.clone(), code });
            }
            for (s, v) in acct.storage.iter() {
                items.insert((*addr, *s));
                facts.push(Fact::Slot(*addr, *s, *v));
            }
            if *addr != pool.address {
                owned.push(*addr);
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
        let mut reg = self.c2.reg.write().unwrap();
        if let Some(e) = reg.pools.get_mut(&key) {
            e.state = PoolState::Ready;
            e.reason = String::new();
            e.busy = false;
            e.ever_ready = true;
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
        if let (Some(h), Some(Some(l))) = (reg.holders.get(&a), reg.layouts.get(&a)) {
            return h.iter().find(|h| l.key(**h) == s).copied();
        }
        None
    }

    /// Send items checks missed to the loaders (fetched at the head block).
    fn dispatch_fills(&mut self) {
        if self.loaders.is_none() || self.jobs.values().filter(|j| matches!(j, JobFor::Fill)).count() >= 2 {
            return;
        }
        let items = self.fills.take(200);
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
        let id = self.new_job(JobFor::Fill);
        self.loaders.as_ref().unwrap().send(Job::Fetch { id, block: head.block, exact: false, items: ok, calls: vec![] });
    }

    /// Fill answers: used only if nothing we follow touched them after k.
    fn on_fill(&mut self, k: u64, res: Result<FetchOut, crate::node::NodeErr>) {
        let Ok(out) = res else {
            inc(&self.c2.stats.node_errors);
            return;
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
                            }
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
