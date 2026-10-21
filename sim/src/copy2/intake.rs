// ============================================================================
// COPY 2 INTAKE: the one thread that keeps our pools' copy current from the
// pools' own events (ARBSIM_SOURCE=pool-events). See sim/COPY2_PLAN.md.
//
// Plain English - what comes in (from the bot, over the socket):
//   track       the list of pools to follow (re-sent when it changes)
//   pool_logs   one message per block that has events on our pools: the
//               pools' own reports + coin Transfer reports to/from them
//   block_tick  "block N had nothing for you" (keeps the copy current;
//               the bot should send one for every block without events)
//   + `warm` / items checks missed (fetched from the node, see "fills")
//
// What we keep per pool: its storage, and its two coins' balance slots for
// it. Each pool is in one of three states:
//   loading  just added: its values are fetched from the node (checked
//            against the pool's own getters so a fork with a different
//            storage layout is never followed), then READY
//   ready    every event is applied: V2 / Solidly by writing the numbers
//            the event states (fields.rs), V3 / PancakeSwap V3 / Algebra /
//            V4 by re-running the action with the pool's own code
//            (replay.rs, workstream B)
//   unsure   an event couldn't be applied exactly, or a reorg / gap hit it.
//            Everything we held about it is FORGOTTEN (so checks touching it
//            answer "unknown: unsure_pool" and the bot asks the node), and it
//            is reloaded after a short wait (longer each time it happens).
//
// The loop (one thread, the ONLY writer of the published versions):
//   1. Blocks in order. For each: start from the newest version, apply its
//      events in (transaction, log) order, publish the result as the next
//      Version (state/mirror.rs), so `call` / `size_search` at
//      {"after":"head"} or {"block":N} read it. A tick publishes the same
//      state with the new block's details (cheap: shared memory).
//   2. When no block is waiting: load / reload pools, then fills.
//
// Strict, always: a value we don't hold is MISSING (never zero); a pool we
// can't follow exactly is unsure. Node reads use the daily allowance
// (node.rs classes): in-block fetches "critical", loads and fills "fill".
//
// Fills are simpler than copy 1's: they are fetched AT the newest version's
// block, on this thread, so nothing can change in between (no carrying
// values forward). They are refused for pools that aren't ready.
// ============================================================================
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use revm::primitives::{keccak256, Address, Bytes, B256, U256};
use serde_json::{json, Value};

use super::coins::{balance_of_data, probe_layout, BalanceLayout};
use super::fields::{self, apply_fields, core_slots, obs_slot, sol, topic_addr, topics, v2};
use super::overlay::Overlay;
use super::replay::{apply_replay, finish_block};
use super::{ApplyResult, BlockCtx as ReplayCtx, PoolKind, PoolLog, TrackedPool};
use crate::arb::{self, BlockCtx};
use crate::check::hexutil::{parse_address, parse_bytes, parse_u256, parse_u64, to_hex};
use crate::node::{self, env_u64, tag, Class, NodeApi, NodeErr};
use crate::state::fill::{rewrite_from, FillQueue};
use crate::state::mirror::{Shared, Version};
use crate::state::snap::{Fact, Snapshot};
use crate::state::updater::fetch_facts;
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
    let mut layouts = Vec::new();
    if let Some(m) = v.get("coinSlots").and_then(|x| x.as_object()) {
        for (k, l) in m {
            // Keys may be "chain:0xtoken" (the bot's cache file) or "0xtoken".
            let a = k.rsplit(':').next().unwrap_or(k);
            if let (Ok(addr), Some(l)) = (parse_address(a), BalanceLayout::from_json(l)) {
                layouts.push((addr, l));
            }
        }
    }
    Ok((out, layouts, skipped))
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
    /// Why it's unsure (or the last reason it was).
    pub reason: String,
    /// Events applied since tracking began.
    pub events: u64,
    /// Times it went unsure in a row (decides the wait before reloading).
    pub strikes: u32,
    /// Events applied since it was last loaded (resets strikes at 50).
    pub clean_events: u64,
    /// When it may be reloaded.
    pub retry_at: Instant,
    /// Other accounts its replays change (e.g. an Algebra plugin).
    pub owned: Vec<Address>,
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
}

impl Registry {
    fn rebuild_index(&mut self) {
        self.by_addr.clear();
        self.holders.clear();
        for (k, e) in &self.pools {
            self.by_addr.entry(k.0).or_default().push(*k);
            for c in [e.pool.token0, e.pool.token1] {
                if c != Address::ZERO {
                    self.holders.entry(c).or_default().insert(e.pool.address);
                }
            }
        }
    }

    /// May the node's value for this account be put into the copy now?
    /// No for a pool that isn't ready (its events aren't being applied),
    /// the accounts its replays change, and a V4 PoolManager while any of
    /// its pools isn't ready (we can't tell its pools' slots apart).
    pub fn blocked_account(&self, a: &Address) -> Option<String> {
        if let Some(keys) = self.by_addr.get(a) {
            for k in keys {
                let e = &self.pools[k];
                if e.state != PoolState::Ready {
                    return Some(format!("{} pool {a} is {}: {}", kind_name(e.pool.kind), state_name(e.state), e.reason));
                }
            }
        }
        for e in self.pools.values() {
            if e.state != PoolState::Ready && e.owned.contains(a) {
                return Some(format!("account {a} belongs to {} pool {} which is {}", kind_name(e.pool.kind), e.pool.address, state_name(e.state)));
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
    load_failed, unsure_marked, need_item_rounds, node_items, node_errors, fills, fill_items, fill_refused,
    probes, probe_not_found, track_msgs, dropped_msgs,
);

fn inc(c: &AtomicU64) {
    c.fetch_add(1, Ordering::Relaxed);
}
fn add(c: &AtomicU64, n: u64) {
    c.fetch_add(n, Ordering::Relaxed);
}

/// What the socket threads share with the intake thread.
pub struct C2Shared {
    pub reg: RwLock<Registry>,
    pub stats: C2Stats,
    /// Newest block applied (0 = none yet).
    pub last_block: AtomicU64,
}

// ---------------------------------------------------------------------------
// Handle (socket threads -> intake thread)
// ---------------------------------------------------------------------------
pub enum Input {
    Track(Vec<TrackedPool>, Vec<(Address, BalanceLayout)>),
    Block(BlockMsg),
    Fill(Vec<MissItem>),
    Stop,
}

#[derive(Clone)]
pub struct Copy2Handle {
    tx: SyncSender<Input>,
    pub sh: Arc<Shared>,
    pub c2: Arc<C2Shared>,
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
            // Hopelessly behind: dropping a block breaks the copy, so the
            // next message's gap check (or the counter) shows it.
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
        let mut reasons: HashMap<String, u64> = HashMap::new();
        for e in reg.pools.values().filter(|e| e.state == PoolState::Unsure) {
            let k: String = e.reason.chars().take(60).collect();
            *reasons.entry(k).or_default() += 1;
        }
        let mut reasons: Vec<(String, u64)> = reasons.into_iter().collect();
        reasons.sort_by(|a, b| b.1.cmp(&a.1));
        reasons.truncate(10);
        let mut out = json!({
            "source": "pool-events",
            "pools": reg.pools.len(),
            "loading": loading,
            "ready": ready,
            "unsure": unsure,
            "lastBlock": self.c2.last_block.load(Ordering::Relaxed),
            "coinsWithLayout": reg.layouts.values().filter(|l| l.is_some()).count(),
            "coinsWithoutLayout": reg.layouts.values().filter(|l| l.is_none()).count(),
            "unsureReasons": reasons.iter().map(|(k, n)| json!({ "why": k, "n": n })).collect::<Vec<_>>(),
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
    /// Pools loaded per node batch [ARBSIM_COPY2_LOAD_BATCH, 20].
    pub load_batch: usize,
}

impl C2Config {
    pub fn from_env() -> Self {
        C2Config {
            reload_ms: env_u64("ARBSIM_COPY2_RELOAD_MS", 2000),
            reload_max_ms: env_u64("ARBSIM_COPY2_RELOAD_MAX_MS", 600_000),
            layout_retry_s: env_u64("ARBSIM_COPY2_LAYOUT_RETRY_S", 3600),
            load_batch: env_u64("ARBSIM_COPY2_LOAD_BATCH", 20).clamp(1, 200) as usize,
        }
    }
    pub fn for_tests() -> Self {
        C2Config { reload_ms: 0, reload_max_ms: 0, layout_retry_s: 0, load_batch: 20 }
    }
}

// ---------------------------------------------------------------------------
// The intake thread
// ---------------------------------------------------------------------------
pub struct Intake {
    sh: Arc<Shared>,
    c2: Arc<C2Shared>,
    cfg: C2Config,
    rx: Receiver<Input>,
    fills: Arc<FillQueue>,
    /// Blocks received, not applied yet (by block number).
    pending: BTreeMap<u64, BlockMsg>,
    /// Newest block applied.
    last_block: Option<u64>,
    /// Block of the previous message received (for the bot's prevBlock).
    last_msg_block: Option<u64>,
    /// Recent blocks: the (tx, log index) list applied and pools touched
    /// (duplicates vs reorgs).
    recent: VecDeque<(u64, Vec<(B256, u32)>, Vec<PoolKey>)>,
    basefee: u64,
    last_header: Option<Instant>,
    last_evict: Instant,
}

/// Start the intake thread.
pub fn spawn(sh: Arc<Shared>, fills: Arc<FillQueue>, cfg: C2Config) -> Copy2Handle {
    let (intake, h) = manual(sh, fills, cfg);
    let mut intake = intake;
    std::thread::Builder::new().name("arbsim-copy2".into()).spawn(move || intake.run()).expect("copy2 thread");
    h
}

/// For tests: an intake driven by hand (`pump`), no thread.
pub fn manual(sh: Arc<Shared>, fills: Arc<FillQueue>, cfg: C2Config) -> (Intake, Copy2Handle) {
    let (tx, rx) = std::sync::mpsc::sync_channel(8192);
    let c2 = Arc::new(C2Shared { reg: RwLock::new(Registry::default()), stats: C2Stats::default(), last_block: AtomicU64::new(0) });
    let i = Intake {
        sh: sh.clone(),
        c2: c2.clone(),
        cfg,
        rx,
        fills,
        pending: BTreeMap::new(),
        last_block: None,
        last_msg_block: None,
        recent: VecDeque::new(),
        basefee: 0,
        last_header: None,
        last_evict: Instant::now(),
    };
    (i, Copy2Handle { tx, sh, c2 })
}

/// Result of one coin-transfer side.
enum Side {
    Pool,
    Other,
}

impl Intake {
    pub fn run(&mut self) {
        loop {
            match self.rx.recv_timeout(Duration::from_millis(50)) {
                Ok(Input::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                Ok(i) => self.input(i),
                Err(RecvTimeoutError::Timeout) => {}
            }
            while let Ok(i) = self.rx.try_recv() {
                if matches!(i, Input::Stop) {
                    return;
                }
                self.input(i);
            }
            self.work();
        }
    }

    /// Take everything waiting, then work (tests).
    pub fn pump(&mut self) {
        while let Ok(i) = self.rx.try_recv() {
            self.input(i);
        }
        self.work();
    }

    fn input(&mut self, i: Input) {
        match i {
            Input::Track(pools, layouts) => self.on_track(pools, layouts),
            Input::Block(m) => {
                // Keep the newest message per block (a re-sent block replaces).
                self.pending.insert(m.block, m);
            }
            Input::Fill(items) => {
                self.fills.push(items);
            }
            Input::Stop => {}
        }
    }

    pub fn work(&mut self) {
        self.upkeep_header();
        while let Some((&b, _)) = self.pending.iter().next() {
            let m = self.pending.remove(&b).unwrap();
            self.process(m);
        }
        // Idle: reloads, then fills (both fetch at the newest version's block).
        self.do_loads();
        if self.pending.is_empty() {
            self.do_fills();
        }
        if self.last_evict.elapsed() > Duration::from_secs(60) {
            self.last_evict = Instant::now();
            self.evict();
        }
    }

    // ---- track ----
    fn on_track(&mut self, pools: Vec<TrackedPool>, layouts: Vec<(Address, BalanceLayout)>) {
        inc(&self.c2.stats.track_msgs);
        let mut gone: Vec<PoolEntry> = Vec::new();
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
                reg.pools.entry(k).or_insert_with(|| PoolEntry {
                    pool: p,
                    state: PoolState::Loading,
                    reason: "loading".into(),
                    events: 0,
                    strikes: 0,
                    clean_events: 0,
                    retry_at: Instant::now(),
                    owned: Vec::new(),
                });
            }
            reg.rebuild_index();
        }
        // Forget what we held about pools we no longer follow (it would go
        // stale), including their coin balances (unless another pool at the
        // same address still follows that coin).
        if !gone.is_empty() {
            let reg = self.c2.reg.read().unwrap();
            let mut forget_accts: Vec<Address> = Vec::new();
            let mut forget_slots: Vec<(Address, U256)> = Vec::new();
            for e in &gone {
                if !reg.by_addr.contains_key(&e.pool.address) {
                    forget_accts.push(e.pool.address);
                }
                forget_accts.extend(e.owned.iter().copied());
                for c in [e.pool.token0, e.pool.token1] {
                    let still = reg.holders.get(&c).is_some_and(|h| h.contains(&e.pool.address));
                    if let (false, Some(Some(l))) = (still, reg.layouts.get(&c)) {
                        forget_slots.push((c, l.key(e.pool.address)));
                    }
                }
            }
            drop(reg);
            self.rewrite_all(|s| {
                for a in &forget_accts {
                    s.apply_fact(&Fact::Forget(*a));
                }
                for (a, k) in &forget_slots {
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

    /// Apply one block message (or tick), publish the result.
    pub fn process(&mut self, m: BlockMsg) {
        let c2 = self.c2.clone();
        let st = &c2.stats;
        // Lost message? (only if the bot tells us its previous block)
        if let (Some(prev), Some(last)) = (m.prev_block, self.last_msg_block) {
            if prev != last && m.block > last {
                inc(&st.gaps);
                eprintln!("[arbsim] copy2: message(s) lost between block {last} and {} (bot's previous: {prev}); reloading every pool", m.block);
                self.unsure_all(&format!("lost message before block {}", m.block), m.block);
            }
        }
        if m.block > self.last_msg_block.unwrap_or(0) {
            self.last_msg_block = Some(m.block);
        }
        // Reorged reports ("removed") make their pools unsure from that block on.
        let removed: Vec<&PoolLog> = m.logs.iter().filter(|l| l.removed).collect();
        if !removed.is_empty() {
            inc(&st.reorgs);
            let from = removed.iter().map(|l| l.block).min().unwrap_or(m.block);
            let keys = self.pools_touched(&removed.iter().map(|l| (*l).clone()).collect::<Vec<_>>());
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
        if m.tick {
            inc(&st.ticks);
            self.publish(m.block, head.snap.clone(), ctx, StateDiff::default());
            return;
        }
        inc(&st.blocks);
        let rctx = ReplayCtx { number: m.block, timestamp: m.timestamp, l1_number: ctx.l1_block_number };
        let mut ov = Overlay::from_arc(&head.snap);
        ov.set_position(StatePosition { base_block: m.block, after_seq: None });
        let mut logs: Vec<PoolLog> = m.logs.iter().filter(|l| !l.removed).cloned().collect();
        logs.sort_by_key(|l| (l.tx_index, l.log_index));
        add(&st.logs, logs.len() as u64);
        let mut touched: Vec<PoolKey> = Vec::new();
        for log in &logs {
            let mut used = false;
            for k in self.pool_keys_for(log) {
                used = true;
                touched.push(k);
                self.apply_pool_event(&mut ov, k, log, &rctx, m.block);
            }
            if self.apply_coin_transfer(&mut ov, log) {
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
            match self.with_fetch(&mut ov, m.block, |o| finish_block(o, &pool, &rctx)) {
                ApplyResult::Applied => {}
                ApplyResult::Unsure(why) => self.make_unsure(*k, &format!("end of block: {why}"), Some(&mut ov), m.block),
                ApplyResult::NeedItems(_) => self.make_unsure(*k, "end of block: still missing items", Some(&mut ov), m.block),
            }
        }
        self.recent.push_back((m.block, log_ids(&m.logs), touched));
        while self.recent.len() > self.sh.cfg.history {
            self.recent.pop_front();
        }
        let (snap, diff) = ov.into_parts();
        self.publish(m.block, Arc::new(snap), ctx, diff);
    }

    /// First message: an empty copy right before it (everything lazily loaded).
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
        keys.iter()
            .filter(|k| match k.1 {
                // V4: the PoolManager's event names the pool id in topic 1.
                Some(id) => log.topics.get(1) == Some(&id),
                None => true,
            })
            .copied()
            .collect()
    }

    fn pools_touched(&self, logs: &[PoolLog]) -> Vec<PoolKey> {
        let reg = self.c2.reg.read().unwrap();
        let mut out = Vec::new();
        for l in logs {
            if let Some(keys) = reg.by_addr.get(&l.address) {
                out.extend(keys.iter().copied());
            }
            // Coin transfers: the pools on either side.
            if l.topics.len() == 3 && l.topics[0] == topics().transfer {
                for side in [topic_addr(&l.topics[1]), topic_addr(&l.topics[2])] {
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

    /// Apply one event to one pool (if it's ready).
    fn apply_pool_event(&mut self, ov: &mut Overlay, k: PoolKey, log: &PoolLog, rctx: &ReplayCtx, block: u64) {
        let c2 = self.c2.clone();
        let st = &c2.stats;
        let (pool, state) = {
            let reg = self.c2.reg.read().unwrap();
            let e = &reg.pools[&k];
            (e.pool.clone(), e.state)
        };
        if state != PoolState::Ready {
            // Not loaded yet / unsure: its values are fetched later, at a
            // block that already includes this event.
            inc(&st.events_skipped_not_ready);
            return;
        }
        let before: HashSet<Address> = ov.changes().accounts.keys().copied().collect();
        let res = match pool.kind {
            PoolKind::V2 | PoolKind::Solidly => apply_fields(ov, &pool, log, rctx.timestamp),
            _ => self.with_fetch(ov, block, |o| apply_replay(o, &pool, log, rctx)),
        };
        match res {
            ApplyResult::Applied => {
                inc(&st.events_applied);
                // Accounts a replay changed besides the pool and coins
                // belong to it (forgotten with it if it goes unsure).
                let new_owned: Vec<Address> = {
                    let reg = self.c2.reg.read().unwrap();
                    ov.changes().accounts.keys().filter(|a| !before.contains(*a) && **a != pool.address && !reg.holders.contains_key(*a)).copied().collect()
                };
                let mut reg = self.c2.reg.write().unwrap();
                if let Some(e) = reg.pools.get_mut(&k) {
                    e.events += 1;
                    e.clean_events += 1;
                    if e.clean_events >= 50 {
                        e.strikes = 0;
                    }
                    for a in new_owned {
                        if !e.owned.contains(&a) {
                            e.owned.push(a);
                        }
                    }
                }
            }
            ApplyResult::Unsure(why) => {
                inc(&st.events_unsure);
                self.make_unsure(k, &why, Some(ov), block);
            }
            ApplyResult::NeedItems(items) => {
                inc(&st.events_unsure);
                self.make_unsure(k, &format!("still missing {} item(s) after fetching", items.len()), Some(ov), block);
            }
        }
    }

    /// Replay (workstream B), fetching what it needs at the block before
    /// (the pool's state then = our copy's, see file header), a few rounds.
    fn with_fetch(&mut self, ov: &mut Overlay, block: u64, mut run: impl FnMut(&mut Overlay) -> ApplyResult) -> ApplyResult {
        let rounds = self.sh.cfg.max_fill_rounds;
        for _ in 0..rounds {
            match run(ov) {
                ApplyResult::NeedItems(items) => {
                    inc(&self.c2.stats.need_item_rounds);
                    let Some(node) = self.sh.node.clone() else { return ApplyResult::Unsure("needs node data, no node configured".into()) };
                    // Code-by-hash can't be fetched: ask for that account instead
                    // (the replayer should name the account; we can't map a hash).
                    let fetchable: Vec<MissItem> = items.into_iter().filter(|i| !matches!(i, MissItem::Code(_))).collect();
                    if fetchable.is_empty() {
                        return ApplyResult::Unsure("needs contract code by hash only".into());
                    }
                    add(&self.c2.stats.node_items, fetchable.len() as u64);
                    match fetch_facts(&*node, Class::Critical, block.saturating_sub(1), &fetchable) {
                        Ok((facts, unavailable, failed)) => {
                            if unavailable + failed > 0 && facts.is_empty() {
                                inc(&self.c2.stats.node_errors);
                                return ApplyResult::Unsure("node could not give the items it needs".into());
                            }
                            for f in &facts {
                                ov.learn(f);
                            }
                        }
                        Err(e) => {
                            inc(&self.c2.stats.node_errors);
                            return ApplyResult::Unsure(format!("node: {e}"));
                        }
                    }
                }
                r => return r,
            }
        }
        ApplyResult::Unsure("too many fetch rounds".into())
    }

    /// A coin Transfer to / from one of our pools: move that pool's balance.
    /// Returns true if the log was such a transfer.
    fn apply_coin_transfer(&mut self, ov: &mut Overlay, log: &PoolLog) -> bool {
        let t = topics();
        if log.topics.len() != 3 || log.topics[0] != t.transfer || log.data.len() != 32 {
            return false;
        }
        let coin = log.address;
        let (followed, layout) = {
            let reg = self.c2.reg.read().unwrap();
            let Some(h) = reg.holders.get(&coin) else { return false };
            (h.clone(), reg.layouts.get(&coin).copied().flatten())
        };
        let (from, to) = (topic_addr(&log.topics[1]), topic_addr(&log.topics[2]));
        if !followed.contains(&from) && !followed.contains(&to) {
            return false;
        }
        inc(&self.c2.stats.coin_transfers);
        // No known layout: the pools' balance slot isn't held (loading
        // checks it), nothing to update.
        let Some(layout) = layout else { return true };
        let v = super::word(&log.data, 0);
        for (side, is_from) in [(from, true), (to, false)] {
            if side == Address::ZERO {
                continue; // mint / burn of the coin: no balance slot
            }
            let kind = if followed.contains(&side) { Side::Pool } else { Side::Other };
            let slot = layout.key(side);
            match kind {
                Side::Pool => {
                    if let Lookup::Known(cur) = ov.slot(coin, slot) {
                        let nv = if is_from { cur.checked_sub(v) } else { cur.checked_add(v) };
                        match nv {
                            Some(x) => ov.set_slot(coin, slot, x),
                            None => {
                                // Our copy of that balance was wrong: forget it
                                // (fetched again when needed). Never a guess.
                                inc(&self.c2.stats.coin_slot_mismatch);
                                ov.forget_slot(coin, slot);
                            }
                        }
                    }
                }
                Side::Other => {
                    // A wallet / the bot's contract: its other transfers never
                    // reach us, so we don't vouch for its balance.
                    if matches!(ov.slot(coin, slot), Lookup::Known(_)) {
                        inc(&self.c2.stats.other_side_forgotten);
                        ov.forget_slot(coin, slot);
                    }
                }
            }
        }
        // from == to: the pool's balance is unchanged (sub then add): fine.
        true
    }

    // ---- unsure ----
    fn backoff(&self, strikes: u32, reason: &str) -> Duration {
        if reason.starts_with("layout") {
            return Duration::from_secs(self.cfg.layout_retry_s);
        }
        let ms = self.cfg.reload_ms.saturating_mul(1u64 << strikes.saturating_sub(1).min(20));
        Duration::from_millis(ms.min(self.cfg.reload_max_ms.max(self.cfg.reload_ms)))
    }

    /// Mark a pool unsure and forget what we held about it: in the block
    /// being built (`ov`), and in every kept version from `from_block` on.
    fn make_unsure(&mut self, k: PoolKey, why: &str, ov: Option<&mut Overlay>, from_block: u64) {
        let forget = {
            let mut reg = self.c2.reg.write().unwrap();
            let Some(e) = reg.pools.get_mut(&k) else { return };
            e.strikes = e.strikes.saturating_add(1);
            e.clean_events = 0;
            e.state = PoolState::Unsure;
            e.reason = why.to_string();
            let wait = self.backoff(e.strikes, why);
            e.retry_at = Instant::now() + wait;
            let mut f = e.owned.clone();
            f.push(e.pool.address);
            f
        };
        inc(&self.c2.stats.unsure_marked);
        if let Some(ov) = ov {
            for a in &forget {
                ov.forget(*a);
            }
        }
        let fb = from_block;
        let f2 = forget.clone();
        let mut p = self.sh.published.write().unwrap();
        rewrite_from(&mut p.versions, fb, |s| {
            for a in &f2 {
                s.apply_fact(&Fact::Forget(*a));
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

    fn rewrite_all(&self, f: impl Fn(&mut Snapshot)) {
        let mut p = self.sh.published.write().unwrap();
        rewrite_from(&mut p.versions, 0, f);
    }

    // ---- loading ----
    /// Load (or reload) pools that are due, at the newest version's block.
    fn do_loads(&mut self) {
        let now = Instant::now();
        let due: Vec<PoolKey> = {
            let reg = self.c2.reg.read().unwrap();
            let mut d: Vec<(Instant, PoolKey)> = reg
                .pools
                .iter()
                .filter(|(_, e)| e.state != PoolState::Ready && e.retry_at <= now)
                .map(|(k, e)| (e.retry_at, *k))
                .collect();
            d.sort();
            d.into_iter().take(self.cfg.load_batch).map(|x| x.1).collect()
        };
        if due.is_empty() {
            return;
        }
        let Some(head) = self.sh.head() else { return };
        let Some(node) = self.sh.node.clone() else {
            let mut reg = self.c2.reg.write().unwrap();
            for k in &due {
                if let Some(e) = reg.pools.get_mut(k) {
                    e.state = PoolState::Unsure;
                    e.reason = "no node configured to load it from".into();
                    e.retry_at = now + Duration::from_secs(3600);
                }
            }
            return;
        };
        add(&self.c2.stats.loads, due.len() as u64);
        match self.load_pools(&*node, head.block, &due) {
            Ok(results) => {
                let mut facts_all: Vec<Fact> = Vec::new();
                let mut forget: Vec<Address> = Vec::new();
                let mut reg = self.c2.reg.write().unwrap();
                for (k, r) in results {
                    let wait_reason;
                    {
                        let Some(e) = reg.pools.get_mut(&k) else { continue };
                        forget.push(e.pool.address);
                        forget.extend(e.owned.drain(..));
                        match r {
                            Ok(f) => {
                                inc(&self.c2.stats.load_ok);
                                facts_all.extend(f);
                                e.state = PoolState::Ready;
                                e.reason = String::new();
                                continue;
                            }
                            Err(why) => {
                                inc(&self.c2.stats.load_failed);
                                e.strikes = e.strikes.saturating_add(1);
                                e.state = PoolState::Unsure;
                                e.reason = why.clone();
                                wait_reason = (e.strikes, why);
                            }
                        }
                    }
                    let wait = self.backoff(wait_reason.0, &wait_reason.1);
                    if let Some(e) = reg.pools.get_mut(&k) {
                        e.retry_at = now + wait;
                    }
                }
                drop(reg);
                // Fresh values replace whatever we held (fetched AT the head block).
                self.into_head(head.block, |s| {
                    for a in &forget {
                        s.apply_fact(&Fact::Forget(*a));
                    }
                    for f in &facts_all {
                        s.apply_fact(f);
                    }
                });
            }
            Err(e) => {
                inc(&self.c2.stats.node_errors);
                let mut reg = self.c2.reg.write().unwrap();
                for k in &due {
                    if let Some(p) = reg.pools.get_mut(k) {
                        p.retry_at = now + Duration::from_millis(self.cfg.reload_ms.max(1000));
                        if p.state == PoolState::Loading {
                            p.reason = format!("loading (node: {e})");
                        }
                    }
                }
            }
        }
    }

    /// Replace the head version's state (only if it is still at `block`).
    fn into_head(&self, block: u64, f: impl Fn(&mut Snapshot)) {
        let mut p = self.sh.published.write().unwrap();
        let n = p.versions.len();
        if n == 0 {
            return;
        }
        let h = p.versions[n - 1].clone();
        if h.block != block {
            return;
        }
        let mut s = (*h.snap).clone();
        f(&mut s);
        p.versions[n - 1] = Arc::new(Version { snap: Arc::new(s), ..(*h).clone() });
        drop(p);
        self.sh.notify();
    }

    /// Fetch + verify pools at `block`. Per pool: the facts to learn, or why not.
    #[allow(clippy::type_complexity)]
    fn load_pools(&mut self, node: &dyn NodeApi, block: u64, keys: &[PoolKey]) -> Result<Vec<(PoolKey, Result<Vec<Fact>, String>)>, NodeErr> {
        let pools: Vec<TrackedPool> = {
            let reg = self.c2.reg.read().unwrap();
            keys.iter().filter_map(|k| reg.pools.get(k).map(|e| e.pool.clone())).collect()
        };
        // 1. Coin balance places we don't know yet (2 requests per coin, once).
        let coins: Vec<Address> = {
            let reg = self.c2.reg.read().unwrap();
            let mut c: Vec<Address> = pools.iter().flat_map(|p| [p.token0, p.token1]).filter(|c| *c != Address::ZERO && !reg.layouts.contains_key(c)).collect();
            c.sort();
            c.dedup();
            c
        };
        for c in coins {
            inc(&self.c2.stats.probes);
            add(&self.c2.stats.node_items, 2);
            let l = probe_layout(node, c, block)?;
            if l.is_none() {
                inc(&self.c2.stats.probe_not_found);
            }
            self.c2.reg.write().unwrap().layouts.insert(c, l);
        }
        // 2. One batch: core slots + getters + coin balances (slot vs balanceOf).
        let reg = self.c2.reg.read().unwrap();
        let mut b = Batch::new(block);
        let mut plans: Vec<(PoolKey, Result<LoadPlan, String>)> = Vec::new();
        for p in &pools {
            let plan = (|| -> Result<LoadPlan, String> {
                let mut lp = LoadPlan { slots: Vec::new(), getters: Vec::new(), coins: Vec::new() };
                for c in [p.token0, p.token1] {
                    if c == Address::ZERO {
                        continue; // native ETH (V4): no coin contract
                    }
                    let l = reg.layouts.get(&c).copied().flatten().ok_or(format!("coin {c}: can't find where it keeps balances"))?;
                    let holder = p.address;
                    lp.coins.push((c, l.key(holder), b.slot(c, l.key(holder)), b.call(c, &balance_of_data(holder))));
                }
                for s in core_slots(p.kind) {
                    lp.slots.push((U256::from(*s), b.slot(p.address, U256::from(*s))));
                }
                match p.kind {
                    PoolKind::V2 => {
                        for s in [v2::TOKEN0, v2::TOKEN1] {
                            lp.slots.push((U256::from(s), b.slot(p.address, U256::from(s))));
                        }
                        for g in ["getReserves()", "totalSupply()", "price0CumulativeLast()", "price1CumulativeLast()"] {
                            lp.getters.push((g, b.call(p.address, &selector(g))));
                        }
                    }
                    PoolKind::Solidly => {
                        lp.slots.push((U256::from(sol::TOKEN1), b.slot(p.address, U256::from(sol::TOKEN1))));
                        for g in [
                            "getReserves()", "totalSupply()", "reserve0CumulativeLast()", "reserve1CumulativeLast()",
                            "index0()", "index1()", "observationLength()",
                        ] {
                            lp.getters.push((g, b.call(p.address, &selector(g))));
                        }
                    }
                    _ => {}
                }
                Ok(lp)
            })();
            plans.push((key_of(p), plan));
        }
        drop(reg);
        add(&self.c2.stats.node_items, b.calls.len() as u64);
        let res = b.send(node)?;
        // 3. Solidly: the last observation's time (needs the count first).
        let mut b2 = Batch::new(block);
        let mut obs_idx: HashMap<PoolKey, (U256, usize)> = HashMap::new();
        for (p, (k, plan)) in pools.iter().zip(plans.iter()) {
            if let (PoolKind::Solidly, Ok(lp)) = (p.kind, plan) {
                if let Some(Ok(len)) = lp.slots.iter().find(|s| s.0 == U256::from(sol::OBS_LEN)).map(|s| res.u256(s.1)) {
                    if !len.is_zero() {
                        let slot = obs_slot(len - U256::from(1), 0);
                        obs_idx.insert(*k, (slot, b2.slot(p.address, slot)));
                    }
                }
            }
        }
        let res2 = if b2.calls.is_empty() {
            BatchRes { r: vec![] }
        } else {
            add(&self.c2.stats.node_items, b2.calls.len() as u64);
            b2.send(node)?
        };
        // 4. Check and turn into facts.
        let mut out = Vec::new();
        for (p, (k, plan)) in pools.iter().zip(plans) {
            let r = plan.and_then(|lp| {
                let mut facts = Vec::new();
                let mut vals: HashMap<U256, U256> = HashMap::new();
                for (s, i) in &lp.slots {
                    let v = res.u256(*i)?;
                    vals.insert(*s, v);
                    facts.push(Fact::Slot(p.address, *s, v));
                }
                if let Some((slot, i)) = obs_idx.get(&k) {
                    let v = res2.u256(*i)?;
                    facts.push(Fact::Slot(p.address, *slot, v));
                }
                verify_layout(p, &vals, &lp.getters, &res)?;
                for (c, slot, si, ci) in &lp.coins {
                    let held = res.u256(*si)?;
                    let bal = res.word(*ci, 0).map_err(|e| format!("coin {c}: balanceOf failed ({e})"))?;
                    if held != bal {
                        return Err(format!("coin {c}: balance not readable from its storage (slot {held} vs balanceOf {bal})"));
                    }
                    facts.push(Fact::Slot(*c, *slot, held));
                }
                Ok(facts)
            });
            out.push((k, r));
        }
        Ok(out)
    }

    // ---- fills ----
    /// Fetch items checks missed, AT the head block, refusing pools that
    /// aren't ready.
    fn do_fills(&mut self) {
        let items = self.fills.take(100);
        if items.is_empty() {
            return;
        }
        let Some(node) = self.sh.node.clone() else { return };
        let Some(head) = self.sh.head() else { return };
        let (ok, refused): (Vec<MissItem>, Vec<MissItem>) = {
            let reg = self.c2.reg.read().unwrap();
            items
                .into_iter()
                .filter(|m| needs(&head.snap, m))
                .partition(|m| match m {
                    MissItem::Account(_) => true, // basics + code: never pool-specific state
                    MissItem::Slot(a, _) => reg.blocked_account(a).is_none(),
                    MissItem::Code(_) => false,
                })
        };
        add(&self.c2.stats.fill_refused, refused.len() as u64);
        if ok.is_empty() {
            return;
        }
        inc(&self.c2.stats.fills);
        add(&self.c2.stats.node_items, ok.len() as u64);
        match fetch_facts(&*node, Class::Fill, head.block, &ok) {
            Ok((facts, unavailable, _)) => {
                add(&self.c2.stats.fill_items, facts.len() as u64);
                if unavailable > 0 {
                    // The node isn't at our block yet: try again later.
                    self.fills.push(ok.iter().filter(|m| !facts.iter().any(|f| fact_item(f).as_ref() == Some(*m))).cloned());
                }
                // Re-check after the fetch: a pool may have gone unsure meanwhile.
                let reg = self.c2.reg.read().unwrap();
                let facts: Vec<Fact> = facts
                    .into_iter()
                    .filter(|f| match f {
                        Fact::Slot(a, _, _) => reg.blocked_account(a).is_none(),
                        _ => true,
                    })
                    .collect();
                drop(reg);
                self.into_head(head.block, |s| {
                    for f in &facts {
                        // Never overwrite something the copy already knows.
                        let known = match f {
                            Fact::Slot(a, sl, _) => !matches!(s.storage(*a, *sl), Lookup::Missing),
                            _ => false,
                        };
                        if !known {
                            s.apply_fact(f);
                        }
                    }
                });
            }
            Err(_) => {
                inc(&self.c2.stats.node_errors);
            }
        }
    }

    // ---- upkeep ----
    fn upkeep_header(&mut self) {
        let Some(node) = self.sh.node.clone() else { return };
        let every = Duration::from_secs(self.sh.cfg.header_every_s.max(1));
        if self.last_header.is_some_and(|t| t.elapsed() < every) {
            return;
        }
        self.last_header = Some(Instant::now());
        if let Ok(tip) = node::block_number(&*node, Class::Header) {
            self.sh.node_tip.store(tip, Ordering::Relaxed);
            if let Ok(Some(h)) = node::get_header(&*node, Class::Header, tip) {
                self.basefee = h.base_fee;
            }
        }
    }

    /// Memory cap: drop accounts that aren't our pools / coins / owned.
    fn evict(&mut self) {
        let keep: HashSet<Address> = {
            let reg = self.c2.reg.read().unwrap();
            let mut k: HashSet<Address> = reg.by_addr.keys().copied().collect();
            k.extend(reg.holders.keys().copied());
            for e in reg.pools.values() {
                k.extend(e.owned.iter().copied());
            }
            k
        };
        let (ma, ms) = (self.sh.cfg.max_accounts, self.sh.cfg.max_slots);
        let Some(h) = self.sh.head() else { return };
        let (a, s, _) = h.snap.counts();
        if a <= ma && s <= ms {
            return;
        }
        let block = h.block;
        self.into_head(block, |snap| {
            snap.evict(ma, ms, |_| 0, |x| keep.contains(x));
        });
    }
}

/// (tx hash, log index) of each non-removed log, sorted.
fn log_ids(logs: &[PoolLog]) -> Vec<(B256, u32)> {
    let mut v: Vec<(B256, u32)> = logs.iter().filter(|l| !l.removed).map(|l| (l.tx_hash, l.log_index)).collect();
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

fn fact_item(f: &Fact) -> Option<MissItem> {
    match f {
        Fact::Slot(a, s, _) => Some(MissItem::Slot(*a, *s)),
        Fact::Basics { addr, .. } => Some(MissItem::Account(*addr)),
        _ => None,
    }
}

/// 4-byte function selector as call data.
pub fn selector(sig: &str) -> String {
    to_hex(&keccak256(sig.as_bytes()).0[..4])
}

// ---------------------------------------------------------------------------
// Load batch + layout check
// ---------------------------------------------------------------------------
struct LoadPlan {
    /// (slot, index in batch)
    slots: Vec<(U256, usize)>,
    /// (getter signature, index in batch)
    getters: Vec<(&'static str, usize)>,
    /// (coin, balance slot of the pool, slot read index, balanceOf call index)
    coins: Vec<(Address, U256, usize, usize)>,
}

/// One node batch at a fixed block.
struct Batch {
    block: u64,
    calls: Vec<(&'static str, Value)>,
}

impl Batch {
    fn new(block: u64) -> Self {
        Batch { block, calls: Vec::new() }
    }
    fn slot(&mut self, a: Address, s: U256) -> usize {
        self.calls.push(("eth_getStorageAt", json!([to_hex(a.as_slice()), format!("{s:#066x}"), tag(self.block)])));
        self.calls.len() - 1
    }
    fn call(&mut self, to: Address, data: &str) -> usize {
        self.calls.push(("eth_call", json!([{ "to": to_hex(to.as_slice()), "data": data }, tag(self.block)])));
        self.calls.len() - 1
    }
    fn send(&self, node: &dyn NodeApi) -> Result<BatchRes, NodeErr> {
        let calls: Vec<(&str, Value)> = self.calls.iter().map(|(m, v)| (*m, v.clone())).collect();
        Ok(BatchRes { r: node.call_batch(Class::Fill, &calls)? })
    }
}

struct BatchRes {
    r: Vec<node::CallResult>,
}

impl BatchRes {
    fn text(&self, i: usize) -> Result<&str, String> {
        match self.r.get(i) {
            Some(Ok(Value::String(s))) => Ok(s),
            Some(Ok(_)) => Err("node has no answer for that block yet".into()),
            Some(Err(e)) => Err(format!("node error: {}", e.message)),
            None => Err("no answer".into()),
        }
    }
    fn u256(&self, i: usize) -> Result<U256, String> {
        parse_u256(self.text(i)?)
    }
    /// Word `w` of an eth_call answer.
    fn word(&self, i: usize, w: usize) -> Result<U256, String> {
        let b: Bytes = parse_bytes(self.text(i)?)?;
        if b.len() < (w + 1) * 32 {
            return Err(format!("answer too short ({} bytes)", b.len()));
        }
        Ok(super::word(&b, w))
    }
}

/// Do the slots we read say the same as the pool's own getters? (A fork
/// with another storage layout fails here and is never followed.)
fn verify_layout(p: &TrackedPool, vals: &HashMap<U256, U256>, getters: &[(&str, usize)], res: &BatchRes) -> Result<(), String> {
    let g = |name: &str, w: usize| -> Result<U256, String> {
        let i = getters.iter().find(|x| x.0 == name).map(|x| x.1).ok_or("getter missing")?;
        res.word(i, w).map_err(|e| format!("layout: {name} failed ({e})"))
    };
    let s = |n: u64| vals.get(&U256::from(n)).copied().unwrap_or_default();
    let bad = |what: &str| Err(format!("layout: {what} in storage doesn't match the pool's getter (not a standard {} pool)", kind_name(p.kind)));
    let addr_word = |a: Address| U256::from_be_slice(a.as_slice());
    let mask112 = (U256::from(1) << 112usize) - U256::from(1);
    match p.kind {
        PoolKind::V2 => {
            let r = s(v2::RESERVES);
            if g("getReserves()", 0)? != r & mask112 || g("getReserves()", 1)? != (r >> 112usize) & mask112 || g("getReserves()", 2)? != r >> 224usize {
                return bad("reserves");
            }
            if g("totalSupply()", 0)? != s(v2::TOTAL_SUPPLY) {
                return bad("totalSupply");
            }
            if g("price0CumulativeLast()", 0)? != s(v2::PRICE0_CUM) || g("price1CumulativeLast()", 0)? != s(v2::PRICE1_CUM) {
                return bad("price totals");
            }
            if s(v2::TOKEN0) != addr_word(p.token0) || s(v2::TOKEN1) != addr_word(p.token1) {
                return bad("token0/token1");
            }
        }
        PoolKind::Solidly => {
            if g("getReserves()", 0)? != s(sol::RESERVE0) || g("getReserves()", 1)? != s(sol::RESERVE1) || g("getReserves()", 2)? != s(sol::TS_LAST) {
                return bad("reserves");
            }
            if g("totalSupply()", 0)? != s(sol::TOTAL_SUPPLY) {
                return bad("totalSupply");
            }
            if g("reserve0CumulativeLast()", 0)? != s(sol::CUM0) || g("reserve1CumulativeLast()", 0)? != s(sol::CUM1) {
                return bad("reserve totals");
            }
            if g("index0()", 0)? != s(sol::INDEX0) || g("index1()", 0)? != s(sol::INDEX1) {
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
    let _ = fields::map_slot; // (layout constants live in fields.rs)
    Ok(())
}
