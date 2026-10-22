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
//      a reorg. A late coin Transfer is also added to a load that is
//      waiting for node values PAST its place (it would never see it).
//      The same report twice in one message is applied once.
//   6b. Coin balances, belt and braces (dry run #16): when a pool is
//      reloaded while the copy already follows its coin balance, the two
//      values must agree; if not, the balance becomes MISSING.
//   6c. The node refusing us for going too fast ("exceeded the RPS limit"):
//      no new first loads / fills for 1-4 s, waiting loads only wait and
//      ask again (never restart: a restart asks for everything again), and
//      the node client slows down by itself (node.rs, adaptive limit).
//   7. Where a coin keeps a pool's balance: the coin's general layout (probe,
//      or the bot's `coin_slots`), else EXACTLY per pool: debug_traceCall of
//      balanceOf(pool) with the prestate tracer lists the coin storage slots
//      read; the one slot whose value equals the balance is it (works for
//      namespaced / proxy / odd layouts). No single match -> pool unsure.
//   8. READY means a check can run on the pool: its code and the slots its
//      swap reads are loaded with it (not only what its events change), plus
//      its coins' code and what their balanceOf reads.
//   9. Tick walks (dry run #17, copy2/walk.rs): once a V3 / PancakeSwap V3 /
//      Algebra / V4 pool is ready, ONE debug_traceCall per pool brings every
//      tick-map word in a wide window, every initialized tick in it and the
//      price history (exact at block k, taken in like fills while the pool
//      has been ready since <= k). Big checks no longer miss. Walked again
//      when the price moves half the window away. Status poolCoverage.
//  10. Pending reports (dry run #17: probes saw a price / coin balances
//      without reports that hadn't arrived yet). A pool whose reports for a
//      block may be incomplete (header logsBloom says it appears but no
//      such report came; a swap / mint / collect without its coin
//      Transfers; coin Transfers of a V3-style pool without its event) is
//      PENDING: answers touching it at that block or later are withheld
//      ("unknown: pending_reports"). After ARBSIM_COPY2_PENDING_MS the
//      block's reports for those pools are read from the node (one
//      eth_getLogs batch), any we never got are applied as late reports,
//      and the mark is cleared.
//  11. Outside contracts a V3 / Pancake pool calls (a PancakeSwap farm):
//      stand-ins in replays, VOLATILE for checks (see replay.rs).
//
// Strict, always: a value we don't hold is MISSING (never zero); a pool we
// can't follow exactly is unsure. Node reads use the daily allowance
// (node.rs classes) and are counted in status (copy2.nodeRequests).
// ============================================================================
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, RwLock};
use std::path::Path;
use std::time::{Duration, Instant};

use revm::primitives::{keccak256, Address, Bytes, B256, U256};
use serde_json::{json, Value};

use super::coins::{balance_of_data, BalanceLayout};
use super::fields::{self, apply_fields, core_slots, map_slot, obs_slot, sol, topic_addr, topics, v2};
use super::loader::{out_word, CatchUpOut, Done, FetchOut, Job, LoaderStats, Loaders, NOT_YET};
use super::persist;
use super::overlay::Overlay;
use super::replay::{apply_replay, finish_block};
use super::walk::{read_walk, walks, WalkCfg};
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
    /// Why the bot says "reload every pool" (its `gapReason`, sent with
    /// gap:true / prevBlock = this block): counted per reason in status
    /// (`gapReasons`), so a live run shows what keeps forcing reloads.
    pub gap_reason: Option<String>,
    /// The block header's logsBloom (256 bytes), if the bot sends it. With
    /// it the copy notices pools whose reports for this block may not have
    /// arrived yet (see "pending" in the header), instead of answering
    /// checks from a version that lacks them.
    pub bloom: Option<Vec<u8>>,
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
        gap_reason: v.get("gapReason").and_then(|x| x.as_str()).map(|x| x.chars().take(80).collect()),
        bloom: v.get("logsBloom").and_then(|b| b.as_str()).and_then(|b| parse_bytes(b).ok()).map(|b| b.to_vec()).filter(|b| b.len() == 256),
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
    /// Tick walk (copy2/walk.rs): the last one taken in, while ready.
    pub walk: Option<WalkInfo>,
    pub walk_busy: bool,
    pub walk_retry_at: Instant,
    pub walk_fails: u32,
    /// Values the walk put in (sorted; kept apart from `items` to save
    /// memory, forgotten together with them; a reload doesn't ask for them:
    /// the next walk brings them in one request).
    pub walked: Vec<(Address, U256)>,
    /// V4 full walks: tick-map words outside the walked window that were
    /// zero at the walk's block (copy2/walk.rs far_zero). Checks (only)
    /// answer them 0 while the pool stays ready (copy2/checkview.rs);
    /// dropped together with `walk`.
    pub far_zero: Option<FarZero>,
    /// Reports of this pool for this block (or later) may not have arrived
    /// yet (header bloom / missing coin transfers, see "pending"): checks
    /// touching it at that block or later answer unknown until settled.
    pub pending_from: Option<u64>,
    /// The block its current values were read at (the load's node block):
    /// every report up to the end of it is inside them, so a late report
    /// for such a block changes nothing (on_late). 0 = none yet.
    pub base_block: u64,
    /// A late report for this block could not be placed (no longer kept)
    /// while the pool was not ready: its next load must read at or after
    /// it (an older read would lack that report), else it starts over.
    pub need_base: u64,
}

/// Zero tick-map words far from the price (one V4 full walk).
#[derive(Clone, Debug)]
pub struct FarZero {
    /// The walk's block: true from here on (with every change the copy made since).
    pub block: u64,
    /// Sorted PoolManager slots.
    pub slots: Arc<Vec<U256>>,
}

/// One tick walk taken in.
#[derive(Clone, Debug)]
pub struct WalkInfo {
    pub block: u64,
    /// The lens reached its end (else part of the window may be missing).
    pub done: bool,
    pub center: i64,
    pub word_lo: i64,
    pub word_hi: i64,
    pub ticks: u64,
    pub slots: usize,
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
    /// V4 PoolManagers' coin balances are NOT followed (C2Config.pm_bound;
    /// false = the old behaviour: loaded with each V4 pool and changed only
    /// by transfers that also involve another followed pool = stale).
    pub pm_bound: bool,
}

impl Registry {
    fn rebuild_index(&mut self) {
        self.by_addr.clear();
        self.holders.clear();
        self.owner_of.clear();
        for (k, e) in &self.pools {
            self.by_addr.entry(k.0).or_default().push(*k);
            // A V4 PoolManager's coin balances are moved by every V4 pool on
            // the chain: never followed (see C2Config.pm_bound).
            let follows_coins = !(self.pm_bound && e.pool.kind == PoolKind::V4);
            for c in [e.pool.token0, e.pool.token1] {
                if c != Address::ZERO && follows_coins {
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

    /// Is `a` a V4 PoolManager we follow pools in?
    pub fn is_pm(&self, a: &Address) -> bool {
        self.by_addr.get(a).is_some_and(|v| v.iter().any(|k| k.1.is_some()))
    }

    /// The V4 PoolManagers we follow pools in.
    pub fn pms(&self) -> Vec<Address> {
        self.by_addr.iter().filter(|(_, v)| v.iter().any(|k| k.1.is_some())).map(|(a, _)| *a).collect()
    }

    /// Is (coin, slot) a V4 PoolManager's balance of that coin?
    pub fn is_pm_balance(&self, coin: Address, slot: U256) -> bool {
        self.pms().into_iter().any(|pm| self.bal_slot(coin, pm) == Some(slot))
    }

    /// Is `slot` one of the 4 base slots (slot0, fee growth x2, liquidity)
    /// of one of our V4 pools at this PoolManager?
    pub fn is_pm_base_slot(&self, pm: Address, slot: U256) -> bool {
        self.by_addr.get(&pm).is_some_and(|v| {
            v.iter().filter_map(|k| k.1).any(|id| {
                let base = map_slot_id(id);
                slot >= base && slot < base + U256::from(4u8)
            })
        })
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
    coin_balance_disagree, duplicate_logs, late_transfers_to_loading, node_refusals, need_refusal_retries,
    walks, walks_done, walks_partial, walk_errors, walks_refused, walk_slots, pending_marked, pending_settles,
    pending_found, pending_checks, pending_errors, blooms,
    // ---- bot's checks (live Oct 22) ----
    // Zero tick-map words far from the price kept compactly (V4 full walks).
    walk_far_zero,
    // Fill refused: a V4 PoolManager's own coin balance (not followed:
    // checks use the proven lower bound instead, copy2/checkview.rs).
    fill_refused_pm_balance,
    // Fill refused: a PoolManager slot that is not a base slot of one of
    // our V4 pools (another pool's / beyond our walk: never followed).
    fill_refused_pm_slot,
    // Checks that read a PoolManager balance and ran twice; answered (same
    // result at the bound and far above it) / unknown (different).
    pm_bound_checks, pm_bound_same, pm_bound_differ,
    // ---- copy2-l (live Oct 22, 10:36 shadow) ----
    // Late coin Transfers of a followed pool balance applied exactly to
    // every kept version from their block on (was: balance forgotten when a
    // later transfer had been applied already).
    late_coin_deltas,
    // Late coin Transfers already inside the balance's node value (their
    // block <= the block the value was read at): nothing to add; versions
    // older than that read forget it.
    late_coin_included,
    // Fills of a busy pool's coin balance carried forward exactly through
    // the kept reports since the node's block (was: asked again until the
    // pool was quiet for a whole node round trip).
    fill_balance_carried,
    // Values the copy holds that NOTHING follows (coin settings such as a
    // stock coin's namespaced config or WETH's totalSupply, other accounts'
    // storage such as a coin's compliance contract, wallets' coin
    // balances), read once by a fill and kept: re-read every
    // ARBSIM_COPY2_VERIFY_S; a value the chain changed is forgotten in
    // every version (read again when a check needs it) and counted.
    verify_rounds, verify_items, unfollowed_changed,
    // How many such values the copy held at the last round (a level).
    unfollowed_held,
    // ---- copy2-m (live Oct 22, 13:34 restart) ----
    // Checks that read a V4 protocolFeesAccrued counter (never held) and ran
    // with it 0 and not 0: answered (same apart from gas; the higher gas is
    // reported) / unknown "protocol_fee" (different).
    protocol_fee_checks, protocol_fee_same, protocol_fee_differ,
    // Late reports for a block the copy has no message for (a quiet block
    // whose every report came late): placed with the late message's own
    // block time like any late report (was: the pool unsure).
    late_hole_blocks,
    // Late reports for a block no longer kept (before the copy's first
    // block, or older than the kept reports) that every touched pool's
    // node values already include (read at or after that block): ignored.
    late_old_covered,
    // ... that a pool still loading (or waiting to load) can't have: its
    // load starts over / its next load must read at or after that block.
    late_old_reload,
    // Loading pools with no node job / working copy for 30 s: rescheduled
    // (copy2 STALL log line names each reason).
    stall_rescheduled,
    // ---- copy2-p (live Oct 22 16:19: checks ~120 ms, the bound was
    // summed over EVERY V4 pool's whole tick map in every check) ----
    // PoolManager balance bounds computed from only the pools the check
    // itself traded on (cheap); and checks where that smaller bound wasn't
    // enough and the full bound (every ready V4 pool) was used instead.
    pm_bound_route_only, pm_bound_full_retry,
    // ---- copy2-n (warm restart, copy2/persist.rs) ----
    // Saves of the copy to ARBSIM_COPY2_STATE_FILE: written / skipped
    // (the previous one still writing) / failed; the longest time the intake
    // thread spent preparing one (microseconds; the writing is elsewhere).
    saves, saves_skipped, save_errors, save_prep_us_max,
    // Pools taken over from the saved file at start; a file that was there
    // but not usable (format, checksum, ...).
    resume_pools, resume_refused,
    // Catch-ups from the node's logs (start from a saved file, or a gap
    // while running): started / done / failed (then: normal load / reload),
    // blocks applied from them, reports read, late reports they found for
    // blocks the copy already had.
    catchups, catchups_done, catchups_failed, catchup_blocks, catchup_logs, catchup_late_found,
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
    /// Missed items per (class, account) (status "missesTop": names the
    /// accounts behind each class, for the next dry run).
    pub miss_accounts: Mutex<HashMap<(String, Address), u64>>,
    /// Missed items per (class, account, slot) (status "missesTopSlots":
    /// WHICH values, named where we can: live Oct 22 needed this to see
    /// that the 503 PoolManager misses were far tick-map words).
    pub miss_slots: Mutex<HashMap<(String, Address, U256), u64>>,
    /// Check contracts (accounts a check gives code by override, e.g. the
    /// bot's simulated ArbExecutor) -> how many coin layouts we knew when we
    /// last warmed their coin balances (see warm_check_accounts).
    pub check_accounts: Mutex<HashMap<Address, usize>>,
    /// Why new tick walks are not sent right now (None = they are): the
    /// slot cap or the memory guard (status poolCoverage.walkPaused).
    pub walk_paused: Mutex<Option<String>>,
    /// Lost-message reloads by the bot's reason (status `gapReasons`).
    pub gap_reasons: Mutex<HashMap<String, u64>>,
    /// Unanswered checks by their reason (status `checks.unknownBy`: miss,
    /// pending_reports, unsure_pool, pool_manager_balance, not_ready, ...).
    pub unknown_by: Mutex<HashMap<String, u64>>,
    /// Unanswered checks by WHAT they missed (status `checks.blockedBy`):
    /// label -> (checks that missed at least one such value, checks that
    /// missed ONLY such values = what following it alone would answer).
    pub blocked_by: Mutex<HashMap<String, (u64, u64)>>,
    /// Values nothing follows that the chain had changed (verify rounds):
    /// (account, slot) -> times (status `unfollowedChanged`).
    pub unfollowed_changes: Mutex<HashMap<(Address, U256), u64>>,
    /// Checks' merged far-zero list per account, with the per-pool lists it
    /// was made from (checkview.rs; reused while the same lists apply).
    #[allow(clippy::type_complexity)]
    pub far_cache: Mutex<HashMap<Address, (Vec<Arc<Vec<U256>>>, Arc<Vec<U256>>)>>,
    /// Warm restart (status `resume`): the saved file, the last save, the
    /// current / last catch-up.
    pub resume: Mutex<serde_json::Map<String, Value>>,
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
    /// Save the copy (warm restart), answer, then stop (SIGTERM / SIGINT).
    Shutdown(SyncSender<Result<persist::SaveReport, String>>),
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
            let mut p = crate::timing::TimedWrite::new(&self.sh.published);
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

    /// Accounts a check gave contract code by override (the bot's simulated
    /// ArbExecutor at a made-up address): the trade moves coins through
    /// them, so each check through a new coin used to miss that coin's
    /// balance slot of the executor once (dry run #17 "coin slot" misses).
    /// Fetch those balance slots for every coin with a known layout ahead of
    /// time (once per account, again when more layouts are known). Such a
    /// value is a fill like any other: kept until a reported Transfer
    /// involves that account (then forgotten, see apply_coin_transfer).
    pub fn warm_check_accounts(&self, accts: &[Address]) {
        if accts.is_empty() {
            return;
        }
        let reg = self.c2.reg.read().unwrap();
        let layouts: Vec<(Address, BalanceLayout)> = reg.layouts.iter().filter_map(|(c, l)| l.map(|l| (*c, l))).collect();
        drop(reg);
        let mut seen = self.c2.check_accounts.lock().unwrap();
        let mut items = Vec::new();
        for a in accts {
            if seen.get(a).is_some_and(|n| *n >= layouts.len()) {
                continue;
            }
            seen.insert(*a, layouts.len());
            items.extend(layouts.iter().map(|(c, l)| MissItem::Slot(*c, l.key(*a))));
        }
        drop(seen);
        self.fill(items);
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

    /// Stop signal: the intake saves the copy (warm restart) and stops.
    /// Waits at most `timeout` (pm2 kills the process after its
    /// kill_timeout anyway, deploy/arbsim-pm2.sh).
    pub fn shutdown(&self, timeout: Duration) -> Result<persist::SaveReport, String> {
        let t0 = Instant::now();
        let (rtx, rrx) = std::sync::mpsc::sync_channel(1);
        let mut msg = Input::Shutdown(rtx);
        loop {
            match self.tx.try_send(msg) {
                Ok(()) => break,
                Err(std::sync::mpsc::TrySendError::Full(m)) if t0.elapsed() < timeout => {
                    msg = m;
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return Err("the copy's thread is not taking messages".into()),
            }
        }
        rrx.recv_timeout(timeout.saturating_sub(t0.elapsed())).map_err(|_| "timed out".to_string())?
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
            let who = if self.sh.volatile.is_whole(&a) {
                "outside contract (never kept)"
            } else if reg.by_addr.contains_key(&a) {
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
            let mut ma = self.c2.miss_accounts.lock().unwrap();
            if ma.len() < 5000 || ma.contains_key(&(format!("{who} {what}"), a)) {
                *ma.entry((format!("{who} {what}"), a)).or_default() += 1;
            }
            drop(ma);
            if let MissItem::Slot(_, sl) = it {
                let key = (format!("{who} {what}"), a, *sl);
                let mut ms = self.c2.miss_slots.lock().unwrap();
                if ms.len() < 5000 || ms.contains_key(&key) {
                    *ms.entry(key).or_default() += 1;
                }
            }
        }
    }

    /// An unanswered check (server.rs): count its reason, and for a miss
    /// what it missed (one count per label per check; `only` when every
    /// missed value has the same label). Live Oct 22 the copy answered 4 of
    /// 62 checks while the misses named only a few dozen values: this says
    /// whether every unknown check is explained by a missing value, and
    /// which value alone blocks how many checks.
    pub fn note_unknown(&self, why: &str, missing: &[MissItem]) {
        {
            let mut u = self.c2.unknown_by.lock().unwrap();
            if u.len() < 100 || u.contains_key(why) {
                *u.entry(why.to_string()).or_default() += 1;
            }
        }
        if missing.is_empty() {
            return;
        }
        let labels: std::collections::BTreeSet<String> = {
            let reg = self.c2.reg.read().unwrap();
            let checkers: Vec<Address> = self.c2.check_accounts.lock().unwrap().keys().copied().collect();
            missing.iter().map(|m| miss_label(&reg, &checkers, &self.sh.volatile, m)).collect()
        };
        let mut b = self.c2.blocked_by.lock().unwrap();
        let only = labels.len() == 1;
        for l in labels {
            if b.len() >= 300 && !b.contains_key(&l) {
                continue;
            }
            let e = b.entry(l).or_default();
            e.0 += 1;
            if only {
                e.1 += 1;
            }
        }
    }

    /// Copy 2: a check that ran on the version of `block` and touched these
    /// accounts: is one of them a pool whose reports for that block may not
    /// have all arrived yet? Then the answer must be "unknown" (why).
    /// `all`: the touched list overflowed (then any pending pool counts).
    pub fn pending_reason(&self, touched: &[Address], block: u64, all: bool) -> Option<String> {
        let reg = self.c2.reg.read().unwrap();
        let every: Vec<Address> = if all { reg.by_addr.keys().copied().collect() } else { Vec::new() };
        for a in touched.iter().chain(every.iter()) {
            for k in reg.pools_of(a) {
                if let Some(e) = reg.pools.get(&k) {
                    if e.pending_from.is_some_and(|b| b <= block) {
                        inc(&self.c2.stats.pending_checks);
                        return Some(format!(
                            "{} pool {} may still be missing reports from block {} (header bloom says so); settling",
                            kind_name(e.pool.kind),
                            e.pool.address,
                            e.pending_from.unwrap()
                        ));
                    }
                }
            }
        }
        None
    }

    /// If a check's missing items belong to a pool that isn't ready: why.
    pub fn unsure_reason(&self, missing: &[MissItem]) -> Option<String> {
        let reg = self.c2.reg.read().unwrap();
        missing.iter().find_map(|m| match m {
            MissItem::Account(a) | MissItem::Slot(a, _) => reg.blocked_account(a),
            MissItem::Code(_) => None,
        })
    }

    /// What the copy vouches for in a check at the version of `block`
    /// beyond its held values (copy2/checkview.rs): far zero tick-map words
    /// of V4 pools ready without a break since their walk, and the V4
    /// PoolManagers' balances (by a proven lower bound).
    pub fn check_facts(&self, block: u64) -> super::checkview::C2Facts {
        let reg = self.c2.reg.read().unwrap();
        let mut f = super::checkview::C2Facts { block, ..Default::default() };
        // ARBSIM_COPY2_BOUND_FULL=1: always the full PoolManager balance
        // bound (every ready V4 pool), the pre-copy2-p behaviour (slower).
        if super::checkview::bound_full_env() {
            f.full.store(true, Ordering::Relaxed);
        }
        // protocolFeesAccrued of every coin of our V4 pools (never held:
        // answered by two runs, counter 0 and not 0; checkview.rs 3.).
        for e in reg.pools.values().filter(|e| e.pool.kind == PoolKind::V4) {
            for c in [e.pool.token0, e.pool.token1] {
                f.fees.insert((e.pool.address, super::checkview::protocol_fee_slot(c)));
            }
        }
        if !reg.pm_bound {
            return f;
        }
        for pm in reg.pms() {
            f.pms.insert(pm, Vec::new());
        }
        for e in reg.pools.values() {
            if e.pool.kind != PoolKind::V4 {
                continue;
            }
            // Every V4 coin's PoolManager balance goes through the bound
            // (a value the copy may still hold for it is never used).
            for c in [e.pool.token0, e.pool.token1] {
                if c == Address::ZERO {
                    continue;
                }
                let memo = match reg.layouts.get(&c) {
                    Some(Some(l)) => l.preimage(e.pool.address).map(super::checkview::memo_slot),
                    _ => None,
                };
                if let Some(sl) = memo.or_else(|| reg.bal_slot(c, e.pool.address)) {
                    f.inject.insert((c, sl), (e.pool.address, c));
                }
            }
            // Exact at this version: ready since then, nothing pending.
            if e.state != PoolState::Ready || e.ready_since > block || e.pending_from.is_some_and(|b| b <= block) {
                continue;
            }
            if let (Some(fz), Some(_)) = (&e.far_zero, &e.walk) {
                if fz.block.max(e.ready_since) <= block {
                    f.far.entry(e.pool.address).or_default().push(fz.slots.clone());
                    if let Some(id) = e.pool.v4_id {
                        f.far_of.insert(id, fz.slots.clone());
                    }
                }
            }
            f.pms.entry(e.pool.address).or_default().push(e.pool.clone());
        }
        drop(reg);
        // One merged far-zero list per account, reused while the same lists
        // apply (the cache holds the lists themselves, so "same" = the very
        // same lists, never a look-alike).
        {
            let mut cache = self.c2.far_cache.lock().unwrap();
            for (a, lists) in &f.far {
                let hit = cache.get(a).filter(|(l, _)| l.len() == lists.len() && l.iter().zip(lists).all(|(x, y)| Arc::ptr_eq(x, y))).map(|(_, m)| m.clone());
                let merged = match hit {
                    Some(m) => m,
                    None => {
                        let m = super::checkview::merge_lists(lists);
                        cache.insert(*a, (lists.clone(), m.clone()));
                        m
                    }
                };
                f.far_merged.insert(*a, merged);
            }
        }
        f.index_pools();
        f
    }

    /// A check's PoolManager balance bound: from the route's pools only
    /// (`full_retry` false) / that wasn't enough, run again with the full one.
    pub fn note_pm_bound_kind(&self, full_retry: bool) {
        inc(if full_retry { &self.c2.stats.pm_bound_full_retry } else { &self.c2.stats.pm_bound_route_only });
    }

    /// A check read a PoolManager balance and ran twice: same / different.
    pub fn note_pm_bound(&self, same: bool) {
        inc(&self.c2.stats.pm_bound_checks);
        inc(if same { &self.c2.stats.pm_bound_same } else { &self.c2.stats.pm_bound_differ });
    }

    /// A check read an unheld protocolFeesAccrued counter and ran with it 0
    /// and not 0: same apart from gas (answered, higher gas) / different.
    pub fn note_protocol_fee(&self, same: bool) {
        inc(&self.c2.stats.protocol_fee_checks);
        inc(if same { &self.c2.stats.protocol_fee_same } else { &self.c2.stats.protocol_fee_differ });
    }

    /// The `copy2` part of `status` (with the per-pool list if asked).
    pub fn status_json(&self, with_pools: bool) -> Value {
        let reg = self.c2.reg.read().unwrap();
        let (loading, ready, unsure) = reg.counts();
        let last = self.c2.last_block.load(Ordering::Relaxed);
        let tip = self.sh.node_tip.load(Ordering::Relaxed).max(self.c2.node_tip.load(Ordering::Relaxed));
        let lr = self.c2.load_round.lock().unwrap().clone();
        let (jobs, carrying) = *self.c2.in_flight.lock().unwrap();
        let checks_v = {
            let t = self.sh.stats.checks.load(Ordering::Relaxed);
            let ok = self.sh.stats.checks_ok.load(Ordering::Relaxed);
            // Unanswered checks by reason, and what the "miss" ones missed:
            // [label, checks missing it, checks missing ONLY it] (top 15).
            let unknown_by: serde_json::Map<String, Value> = self.c2.unknown_by.lock().unwrap().iter().map(|(k, v)| (k.clone(), json!(v))).collect();
            let mut bb: Vec<(String, (u64, u64))> = self.c2.blocked_by.lock().unwrap().iter().map(|(k, v)| (k.clone(), *v)).collect();
            bb.sort_by(|x, y| y.1 .0.cmp(&x.1 .0).then(y.1 .1.cmp(&x.1 .1)).then(x.0.cmp(&y.0)));
            let blocked: Vec<Value> = bb.into_iter().take(15).map(|(k, (n, only))| json!([k, n, only])).collect();
            // Share of checks (calls / size searches, all callers) the copy
            // answered itself (the rest: unknown, the bot asks the node).
            // Counted since arbsim started (the bot's hourly line counts its
            // own checks per hour: one bot check can be several of these).
            json!({ "total": t, "answered": ok, "answeredPct": if t > 0 { Some(((ok as f64) * 1000.0 / t as f64).round() / 10.0) } else { None },
                    "unknownBy": unknown_by, "blockedBy": blocked })
        };
        // Tick data of V3-style pools (copy2/walk.rs): pools whose ready copy
        // holds every tick a realistic check can touch.
        let coverage_v = {
            let mut c = (0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
            for e in reg.pools.values() {
                if e.state != PoolState::Ready {
                    continue;
                }
                if !walks(e.pool.kind) {
                    c.5 += 1;
                    continue;
                }
                c.0 += 1;
                match &e.walk {
                    Some(w) if w.done => c.1 += 1,
                    Some(_) => c.2 += 1,
                    None if e.walk_busy => c.3 += 1,
                    None => c.4 += 1,
                }
            }
            let pct = if c.0 + c.5 > 0 { Some((((c.1 + c.5) as f64) * 1000.0 / (c.0 + c.5) as f64).round() / 10.0) } else { None };
            let slots: u64 = reg.pools.values().map(|e| e.walked.len() as u64).sum();
            let far: u64 = reg.pools.values().filter_map(|e| e.far_zero.as_ref()).map(|f| f.slots.len() as u64).sum();
            json!({ "readyTickPools": c.0, "fullTickData": c.1, "partialTickData": c.2, "walking": c.3, "waiting": c.4,
                    "readyV2Like": c.5, "fullPct": pct, "walkSlots": slots, "farZeroWords": far,
                    "walkPaused": *self.c2.walk_paused.lock().unwrap() })
        };
        let misses_top: Vec<Value> = {
            let ma = self.c2.miss_accounts.lock().unwrap();
            let mut v: Vec<(&(String, Address), &u64)> = ma.iter().collect();
            v.sort_by(|a, b| b.1.cmp(a.1));
            v.into_iter().take(20).map(|((c, a), n)| json!([c, to_hex(a.as_slice()), n])).collect()
        };
        // The 20 missed VALUES with the most misses: [class, account, slot,
        // count, what it is (where we can tell)].
        let misses_top_slots: Vec<Value> = {
            let ms = self.c2.miss_slots.lock().unwrap();
            let mut v: Vec<(&(String, Address, U256), &u64)> = ms.iter().collect();
            v.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
            let checkers: Vec<Address> = self.c2.check_accounts.lock().unwrap().keys().copied().collect();
            v.into_iter()
                .take(20)
                .map(|((c, a, sl), n)| json!([c, to_hex(a.as_slice()), format!("{sl:#x}"), n, describe_slot(&reg, &checkers, *a, *sl)]))
                .collect()
        };
        let unfollowed_changed: Vec<Value> = {
            let mut v: Vec<((Address, U256), u64)> = self.c2.unfollowed_changes.lock().unwrap().iter().map(|(k, n)| (*k, *n)).collect();
            v.sort_by(|x, y| y.1.cmp(&x.1).then(x.0.cmp(&y.0)));
            v.into_iter().take(20).map(|((a, sl), n)| json!([to_hex(a.as_slice()), format!("{sl:#x}"), n])).collect()
        };
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
            // Reloads the bot asked for (or messages lost), by reason.
            "gapReasons": self.c2.gap_reasons.lock().unwrap().clone(),
            "unsureReasons": top_reasons(reg.pools.values().filter(|e| e.state == PoolState::Unsure).map(|e| e.reason.as_str())),
            "loadingReasons": top_reasons(reg.pools.values().filter(|e| e.state == PoolState::Loading).map(|e| e.reason.as_str())),
            "counters": Value::Object(self.c2.stats.json()),
            "loader": self.c2.loader.json(),
            "missesByClass": self.c2.misses.lock().unwrap().clone(),
            "checks": checks_v,
            "poolCoverage": coverage_v,
            "pendingPools": reg.pools.values().filter(|e| e.pending_from.is_some()).count(),
            // The 20 accounts with the most missed items (class, account, count).
            "missesTop": misses_top,
            "missesTopSlots": misses_top_slots,
            // Values held that nothing follows, re-read every
            // ARBSIM_COPY2_VERIFY_S: [account, slot, times the chain had
            // changed one] (should stay empty; anything here: tell Claude).
            "unfollowedChanged": unfollowed_changed,
            "outsideContracts": self.sh.volatile.whole_len(),
            // Warm restart (copy2/persist.rs): saved file, last save, catch-up.
            "resume": Value::Object(self.c2.resume.lock().unwrap().clone()),
            // The node client's adaptive speed limit (dry run #16): the rate
            // allowed now, the plan rate, refusals by the provider.
            "nodeRate": self.sh.node.as_ref().map(|n| {
                let u = n.usage();
                json!({ "rpsNow": u["rpsNow"], "rpsMax": u["rps"], "providerRefusals": u["providerRefusals"],
                        "rateCuts": u["rateCuts"], "secondsSinceRefusal": u["secondsSinceRefusal"] })
            }),
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
                        "tickData": e.walk.as_ref().map(|w| json!({ "done": w.done, "block": w.block, "ticks": w.ticks, "slots": w.slots, "words": [w.word_lo, w.word_hi], "center": w.center })),
                        "pendingFrom": e.pending_from,
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
    /// A catch-up fetch (values a waiting load needs, read AT the block
    /// before its report) older than this many blocks restarts the pool's
    /// load at the newest block instead [ARBSIM_COPY2_CATCHUP_MAX_BLOCKS, 64]
    /// (old blocks are slower reads). Never while the node is refusing us for
    /// going too fast: a restart asks for EVERYTHING the pool held again,
    /// which turned a short refusal into a request storm (dry run #16).
    pub catchup_max_blocks: u64,
    /// Tick walks (copy2/walk.rs) and how many may run at once
    /// [ARBSIM_COPY2_WALKS, 2; 0 = off].
    pub walk: WalkCfg,
    pub walks_inflight: usize,
    /// Safety cap: walked values held in total at most
    /// [ARBSIM_COPY2_WALK_MAX_SLOTS, 600000]. Full coverage of ~800 pools is
    /// ~250-300k values; measured ~280 bytes of copy-2 memory per walked
    /// value with everything else included (tests/copy2_memory.rs), so the
    /// cap is ~2x full coverage, ~170 MB. Pools beyond it are not walked
    /// (busiest first).
    pub walk_max_slots: usize,
    /// Memory guard: no new walks while the process uses more than this
    /// [ARBSIM_COPY2_WALK_MAX_RSS_MB, 550; 0 = no guard] (pm2 restarts the
    /// sidecar at 400 MB, deploy/arbsim-pm2.sh). Status
    /// poolCoverage.walkPaused says why walks wait.
    pub walk_max_rss_mb: u64,
    /// Reports kept for carrying loads forward, in reports (not blocks): past
    /// keep_blocks, old blocks are dropped once more than this many reports
    /// are kept [ARBSIM_COPY2_MAX_KEEP_LOGS, 150000; ~190 bytes each = ~30
    /// MB] even if a slow load still needs them (it then starts over), so
    /// a busy chain plus a stuck load can't grow the buffer for hours.
    pub max_keep_logs: usize,
    /// A pool whose reports for a block may be missing is settled from the
    /// node's logs after this long [ARBSIM_COPY2_PENDING_MS, 1500] (late
    /// reports usually arrive within a second; settling earlier just costs
    /// requests).
    pub pending_ms: u64,
    /// Never hold a V4 PoolManager's coin / ETH balances; checks that read
    /// them run at a proven lower bound and far above it and answer only
    /// when both agree (copy2/checkview.rs) [ARBSIM_COPY2_PM_BOUND, 1;
    /// 0 = the old behaviour, only for tests: a stale held balance].
    pub pm_bound: bool,
    /// Re-read the values the copy holds but nothing follows every N
    /// seconds [ARBSIM_COPY2_VERIFY_S, 60; 0 = off], at most
    /// [ARBSIM_COPY2_VERIFY_MAX, 400] values a round.
    pub verify_every_s: u64,
    pub verify_max: usize,
    /// A pool "loading" with no node job, no working copy and no answer
    /// waiting for this long is rescheduled (logged with its reason)
    /// [ARBSIM_COPY2_STALL_S, 30].
    pub stall_s: u64,
    /// Warm restart (copy2/persist.rs): where the copy is saved
    /// [ARBSIM_COPY2_STATE_FILE; unset = never saved / read; the runner
    /// deploy/arbsim-run.sh sets <bot folder>/data/arbsim-copy2-state.bin],
    /// how often [ARBSIM_COPY2_SAVE_S, 60] (and always at a stop signal).
    pub state_file: Option<String>,
    pub save_every_s: u64,
    /// Catch-up from the node's logs: at most this many blocks between the
    /// copy and the bot's first new block [ARBSIM_COPY2_RESUME_MAX_BLOCKS,
    /// 18000 = ~30 min at ~10 blocks/s; 0 = never: the old reload]; beyond
    /// it the pools load normally. Measured (tests/copy2_resume_anvil.rs
    /// catch_up_cost): a 30 min gap costs ~40 requests / a few seconds,
    /// a full load ~2,000+ requests and ~13 min with the tick walks.
    pub resume_max_blocks: u64,
    /// Blocks before the copy's block whose reports are read again (late
    /// reports the copy may never have got) [ARBSIM_COPY2_RESUME_OVERLAP_BLOCKS, 64].
    pub resume_overlap: u64,
    /// Blocks per eth_getLogs range [ARBSIM_COPY2_RESUME_RANGE, 500]
    /// (halved automatically when the node calls a range too big).
    pub resume_range: u64,
    /// A catch-up not done after this long gives up (normal load / reload)
    /// [ARBSIM_COPY2_RESUME_TIMEOUT_S, 120].
    pub resume_timeout_s: u64,
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
            catchup_max_blocks: env_u64("ARBSIM_COPY2_CATCHUP_MAX_BLOCKS", 64).max(2),
            walk: WalkCfg::from_env(),
            walks_inflight: env_u64("ARBSIM_COPY2_WALKS", 2).min(16) as usize,
            walk_max_slots: env_u64("ARBSIM_COPY2_WALK_MAX_SLOTS", 600_000) as usize,
            walk_max_rss_mb: env_u64("ARBSIM_COPY2_WALK_MAX_RSS_MB", 550),
            max_keep_logs: env_u64("ARBSIM_COPY2_MAX_KEEP_LOGS", 150_000).max(1000) as usize,
            pending_ms: env_u64("ARBSIM_COPY2_PENDING_MS", 1500),
            pm_bound: env_u64("ARBSIM_COPY2_PM_BOUND", 1) != 0,
            verify_every_s: env_u64("ARBSIM_COPY2_VERIFY_S", 60),
            verify_max: env_u64("ARBSIM_COPY2_VERIFY_MAX", 400).clamp(1, 10_000) as usize,
            stall_s: env_u64("ARBSIM_COPY2_STALL_S", 30),
            state_file: std::env::var("ARBSIM_COPY2_STATE_FILE").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            save_every_s: env_u64("ARBSIM_COPY2_SAVE_S", 60).max(1),
            resume_max_blocks: env_u64("ARBSIM_COPY2_RESUME_MAX_BLOCKS", 18_000),
            resume_overlap: env_u64("ARBSIM_COPY2_RESUME_OVERLAP_BLOCKS", 64).max(1),
            resume_range: env_u64("ARBSIM_COPY2_RESUME_RANGE", 500).max(1),
            resume_timeout_s: env_u64("ARBSIM_COPY2_RESUME_TIMEOUT_S", 120).max(1),
        }
    }
    pub fn for_tests() -> Self {
        C2Config { reload_ms: 0, reload_max_ms: 0, layout_retry_s: 3600, load_batch: 25, loaders: 2, keep_blocks: 400, max_keep_blocks: 4000, max_rounds: 40, tip_every_s: 0, catchup_max_blocks: 64, walk: WalkCfg::default(), walks_inflight: 2, walk_max_slots: 1_000_000, walk_max_rss_mb: 0, max_keep_logs: 1_000_000, pending_ms: 300, pm_bound: true, verify_every_s: 0, verify_max: 400, stall_s: 30, state_file: None, save_every_s: 3600, resume_max_blocks: 18_000, resume_overlap: 64, resume_range: 500, resume_timeout_s: 60 }
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
    /// Node errors in a row while fetching for it (decides the wait).
    errors: u32,
    /// Of those, real errors (not "too fast" refusals): 10 in a row restart
    /// the load. Refusals alone never do (they only wait, see on_need).
    hard_errors: u32,
    /// Fetches refused for the RPS limit in a row (while > 0 the catch-up
    /// block may be old: see C2Config::catchup_max_blocks).
    refusals: u32,
    /// Its coin balances are node values as of the end of this position
    /// (a load fetched at block b: (b, END, END)). A late coin Transfer
    /// after `base` and before `cursor` is not in them and must be added
    /// (on_late). (0,0,0) = it holds no coin balance of its own.
    base: Pos,
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
    /// A ready pool's tick walk.
    Walk { key: PoolKey, gen: u64 },
    /// Settling pools whose reports for blocks from..=to may be missing.
    Logs { from: u64, to: u64 },
    /// Re-reading values nothing follows (dispatch_verify).
    Verify,
    /// Warm restart / gap: the reports of a block range (copy2/loader.rs catch_up).
    CatchUp,
    /// Warm restart, stage 2: re-reading every value nothing follows.
    ResumeVerify,
}

/// A catch-up from the node's logs in progress (see "warm restart" below).
struct CatchUp {
    /// Started from the saved file (else: a gap while running).
    restored: bool,
    /// Newest block the copy had applied.
    applied: u64,
    /// First block whose reports are read (the overlap before `applied`).
    from: u64,
    /// Last block to read; None = the block before the bot's first new one
    /// (warm restart: not known until the bot sends it).
    target: Option<u64>,
    /// When the first read was sent (the time limit counts from here).
    since: Option<Instant>,
    job: Option<u64>,
    /// Last block of the read in flight.
    to: u64,
    tries: u32,
    retry_at: Instant,
    /// Reports applied; stage 2 (restored only) still to do.
    caught: bool,
    verify_job: Option<u64>,
    /// Why it started (log / status).
    why: String,
    started: Instant,
    /// Node requests before it started (cost, for the log).
    req0: u64,
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
    /// Followed coin balance (coin, holder) -> the block of the NODE value
    /// it descends from (a load's fetch block, a fill's block): everything
    /// up to the end of that block is in it; transfers after it were added
    /// one by one. Decides what a late Transfer means (apply_coin_transfer).
    coin_base: HashMap<(Address, Address), u64>,
    /// Late coin Transfers to apply to every kept version from their block
    /// on, collected by apply_coin_transfer(late) and applied by on_late:
    /// (coin, balance slot, block, is_from, amount).
    late_deltas: Vec<(Address, U256, u64, bool, U256)>,
    /// Late coin Transfers already inside the node value: versions from
    /// their block up to (not incl.) the node value's block forget the
    /// balance: (coin, slot, from block, base block).
    late_included: Vec<(Address, U256, u64, u64)>,
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
    /// The node refused us for going too fast ("exceeded the RPS limit"):
    /// no new first loads / fills before this (1 s, doubling to 4 s while
    /// refusals go on; answers of jobs that were in flight together count
    /// once per second; catch-ups of waiting loads go on with their own
    /// waits). (until, step, when the step last grew)
    refusing: Option<(Instant, u32, Instant)>,
    /// Fill items to ask again a little later (not in a tight loop).
    fill_later: Vec<(Instant, MissItem)>,
    /// Blocks with pools whose reports may be missing: block -> (when
    /// noticed, pools). Settled from the node's logs (dispatch_settle).
    suspects: BTreeMap<u64, (Instant, HashSet<PoolKey>)>,
    /// Settling failed: try again after this.
    settle_retry: Option<(Instant, u32)>,
    /// The node can't do the walk's debug_traceCall: walks off.
    walk_off: bool,
    /// Loading pools seen with nothing working for them: since when.
    orphan_since: HashMap<PoolKey, Instant>,
    last_stall_check: Instant,
    last_stall_log: Option<Instant>,
    /// Last round of re-reading the values nothing follows.
    last_verify: Instant,
    /// Process memory (MB) and when it was read (the walk guard reads it at
    /// most once a second).
    rss: std::cell::Cell<(f64, Option<Instant>)>,
    // ---- warm restart (copy2/persist.rs) ----
    /// Catch-up from the node's logs in progress: blocks are held meanwhile.
    catchup: Option<CatchUp>,
    /// The details of the newest block applied (fallback for the next
    /// block's parent-chain block / base fee when a version has none).
    last_ctx: Option<BlockCtx>,
    /// Applying blocks read from the node's logs: their versions get no
    /// block details (checks AT them answer not_ready, like copy 1's
    /// repaired blocks), and their reports are complete (no "pending").
    repairing: bool,
    /// A gap the catch-up filled up to this block: the bot's next message
    /// naming a block we never got is not a new gap.
    gap_filled_until: Option<u64>,
    /// The thread that writes saves; when the last save was prepared.
    saver: Option<persist::Saver>,
    last_save: Instant,
    /// A stop signal asked for a final save (answered by run()).
    shutdown: Option<SyncSender<Result<persist::SaveReport, String>>>,
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
        reg: RwLock::new(Registry { pm_bound: cfg.pm_bound, ..Registry::default() }),
        stats: C2Stats::default(),
        last_block: AtomicU64::new(0),
        node_requests: Arc::new(AtomicU64::new(0)),
        load_round: Mutex::new(LoadRound::default()),
        node_tip: Arc::new(AtomicU64::new(0)),
        head_block: Arc::new(AtomicU64::new(0)),
        misses: Mutex::new(HashMap::new()),
        loader: Arc::new(LoaderStats::default()),
        in_flight: Mutex::new((0, 0)),
        miss_accounts: Mutex::new(HashMap::new()),
        miss_slots: Mutex::new(HashMap::new()),
        check_accounts: Mutex::new(HashMap::new()),
        walk_paused: Mutex::new(None),
        gap_reasons: Mutex::new(HashMap::new()),
        unknown_by: Mutex::new(HashMap::new()),
        blocked_by: Mutex::new(HashMap::new()),
        unfollowed_changes: Mutex::new(HashMap::new()),
        far_cache: Mutex::new(HashMap::new()),
        resume: Mutex::new(serde_json::Map::new()),
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
        coin_base: HashMap::new(),
        late_deltas: Vec::new(),
        late_included: Vec::new(),
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
        refusing: None,
        fill_later: Vec::new(),
        suspects: BTreeMap::new(),
        settle_retry: None,
        walk_off: false,
        orphan_since: HashMap::new(),
        last_stall_check: Instant::now(),
        last_stall_log: None,
        last_verify: Instant::now(),
        rss: std::cell::Cell::new((0.0, None)),
        catchup: None,
        last_ctx: None,
        repairing: false,
        gap_filled_until: None,
        saver: None,
        last_save: Instant::now(),
        shutdown: None,
    };
    let mut i = i;
    if let Some(path) = i.cfg.state_file.clone() {
        i.saver = Some(persist::Saver::spawn(path.clone()));
        i.c2.resume.lock().unwrap().insert("file".into(), json!(path));
        i.try_restore(&path);
    } else {
        i.c2.resume.lock().unwrap().insert("state".into(), json!("off (ARBSIM_COPY2_STATE_FILE not set)"));
    }
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
            if let Some(reply) = self.shutdown.take() {
                // Stop signal: apply what already came in, save, answer, stop.
                self.work();
                let _ = reply.send(self.save_now());
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
        self.jobs.len() + self.done.len() + self.pending.len() + self.delayed.len() + self.load_q.len() + self.suspects.len()
    }

    /// Reports kept for carrying loads forward: (blocks, reports) (tests).
    pub fn buffered(&self) -> (usize, usize) {
        (self.buf.len(), self.buf.iter().map(|b| b.logs.len()).sum())
    }

    /// Coin balance places the bot knows: used instead of probing (and
    /// they replace a "not found"). Pools waiting on those coins retry now.
    fn on_layouts(&mut self, l: Vec<(Address, BalanceLayout)>) {
        if l.is_empty() {
            return;
        }
        inc(&self.c2.stats.coin_slot_msgs);
        let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
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
            // Only this load's own working copy: a retry left over from an
            // earlier load of the pool (it went unsure / restarted since)
            // must not take the NEWER load's working copy away (live Oct 22
            // 13:34: that left ~260 pools "loading" with no job, for good).
            if self.partials.get(&key).is_none_or(|p| p.gen != gen) {
                continue;
            }
            let part = self.partials.remove(&key).unwrap();
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
            Input::Shutdown(reply) => self.shutdown = Some(reply),
        }
    }

    /// Blocks first; node answers in between, one at a time, re-checking
    /// for new blocks after each; then send new node jobs.
    pub fn work(&mut self) {
        loop {
            // While catching up from the node's logs, blocks wait (they are
            // applied after the blocks before them).
            while let Some((&b, _)) = self.pending.iter().next().filter(|_| self.catchup.is_none()) {
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
        self.dispatch_catchup();
        // New loads / fills / walks / settles / re-reads wait for a catch-up
        // (they would read at the copy's old block); work already running
        // goes on.
        if self.catchup.is_none() {
            self.dispatch_loads();
            self.dispatch_fills();
            self.dispatch_walks();
            self.dispatch_settle();
            self.dispatch_verify();
            self.maybe_save();
        }
        self.note_round();
        self.watchdog();
        self.stall_watch();
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
            let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
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
                        walk: None,
                        walk_busy: false,
                        walk_retry_at: Instant::now(),
                        walk_fails: 0,
                        walked: Vec::new(),
                        far_zero: None,
                        pending_from: None,
                        base_block: 0,
                        need_base: 0,
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
                forget.extend(e.walked.iter().copied());
                for c in [e.pool.token0, e.pool.token1] {
                    let still = reg.holders.get(&c).is_some_and(|h| h.contains(&e.pool.address));
                    if let (false, Some(sl)) = (still, reg.bal_slot(c, e.pool.address)) {
                        forget.push((c, sl));
                    }
                }
            }
            drop(reg);
            let mut p = crate::timing::TimedWrite::new(&self.sh.published);
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
    pub fn process(&mut self, mut m: BlockMsg) {
        let t0 = Instant::now();
        let c2 = self.c2.clone();
        let st = &c2.stats;
        // The same report twice in one message (the bot hears a transfer
        // between two of our pools on BOTH its "from our pools" and "to our
        // pools" subscriptions): keep it once. Applying it twice moved both
        // pools' balances twice, for good (dry run #16).
        add(&st.duplicate_logs, dedup_logs(&mut m.logs) as u64);
        // Lost message? The bot's previous message (prevBlock) must be one we
        // got. (Late messages for older blocks are normal, see header.)
        if let (Some(prev), Some(&first)) = (m.prev_block, self.received.first()) {
            // Blocks a catch-up just filled from the node's logs: the bot's
            // "gap" (its start, an outage, ...) is already closed.
            let filled = self.gap_filled_until.is_some_and(|t| m.block <= t + 1);
            if prev >= first && !self.received.contains(&prev) && !filled {
                inc(&st.gaps);
                // prevBlock == this block is the bot saying "I missed something"
                // (with its reason); anything else is a message lost between us.
                let why = match (&m.gap_reason, prev == m.block) {
                    (Some(r), _) => r.clone(),
                    (None, true) => "bot gave no reason".to_string(),
                    (None, false) => "message lost on the way".to_string(),
                };
                *self.c2.gap_reasons.lock().unwrap().entry(why.clone()).or_default() += 1;
                // Warm restart / gap: fill the missing blocks from the node's
                // logs (this message waits until they are applied), instead
                // of reloading every pool. Only when that is not possible
                // (too big, no node) or fails: the old reload.
                if self.start_gap_catchup(m.block, &why) {
                    eprintln!(
                        "[arbsim] copy2: message(s) lost (bot's previous block {prev} never arrived; now at {}; why: {why}); filling the missing blocks from the node's logs",
                        m.block
                    );
                    m.prev_block = None;
                    self.pending.insert(m.block, m);
                    return;
                }
                eprintln!("[arbsim] copy2: message(s) lost (bot's previous block {prev} never arrived; now at {}; why: {why}); reloading every pool", m.block);
                self.reload_all_after_gap(&format!("lost message before block {}", m.block), m.block);
                // The buffer has a hole: no load may carry across it.
                self.buf.clear();
            }
        }
        if self.gap_filled_until.is_some_and(|t| m.block > t + 1) {
            self.gap_filled_until = None;
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
                    // The late message's own block time (the bot sends the
                    // block's real time; 0 = unknown): places reports for a
                    // block the copy has no message for.
                    let time = (m.timestamp > 0).then_some((m.timestamp, m.l1_block));
                    self.on_late_at(m.block, logs, time);
                }
                return;
            }
        }
        // Base: the newest version (or an empty start right before this block).
        let head = match self.sh.head() {
            Some(h) => h,
            None => self.bootstrap(m.block),
        };
        let prev_ctx = head.ctx.clone().or_else(|| self.last_ctx.clone());
        let ctx = self.block_ctx(&m, prev_ctx.as_ref());
        let rctx = ReplayCtx { number: m.block, timestamp: m.timestamp, l1_number: ctx.l1_block_number };
        let mut logs: Vec<PoolLog> = m.logs.iter().filter(|l| !l.removed).cloned().collect();
        logs.sort_by_key(|l| (l.tx_index, l.log_index));
        if m.tick {
            inc(&st.ticks);
            if !self.repairing {
                self.note_suspects(&m);
            }
            self.push_buf(m.block, rctx, Vec::new());
            self.publish(m.block, head.snap.clone(), ctx, StateDiff::default());
            return;
        }
        // Blocks read from the node's logs are complete: nothing pending.
        if !self.repairing {
            self.note_suspects(&m);
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
        crate::timing::record_apply(us);
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
        // Memory bound in reports (see C2Config::max_keep_logs): only blocks
        // beyond the always-kept keep_blocks are dropped.
        if self.buf.len() > self.cfg.keep_blocks {
            let mut total: usize = self.buf.iter().map(|b| b.logs.len()).sum();
            while total > self.cfg.max_keep_logs && self.buf.len() > self.cfg.keep_blocks {
                if let Some(b) = self.buf.pop_front() {
                    total -= b.logs.len();
                }
            }
        }
    }

    /// Reports for block `n` (already applied) that we may not have had.
    /// Returns how many of the reports were new.
    fn on_late(&mut self, n: u64, logs: Vec<PoolLog>) -> usize {
        self.on_late_at(n, logs, None)
    }

    /// Do pool `k`'s node values (held, or in its working copy) already
    /// include every report of block `n`? (read at or after n)
    fn covers(&self, reg: &Registry, k: &PoolKey, n: u64) -> bool {
        let Some(e) = reg.pools.get(k) else { return true };
        match self.partials.get(k) {
            Some(p) if p.base.0 > 0 => p.base.0 >= n,
            // In-block working copy: descends from the ready pool's values.
            Some(_) => e.base_block >= n,
            None => e.state == PoolState::Ready && e.base_block >= n,
        }
    }

    /// `time`: the late message's (block time, parent-chain block), used to
    /// place reports for a block the copy got no message for.
    fn on_late_at(&mut self, n: u64, logs: Vec<PoolLog>, time: Option<(u64, Option<u64>)>) -> usize {
        let c2 = self.c2.clone();
        let st = &c2.stats;
        // What we had for block n.
        let mut known: Option<HashSet<LogId>> = match self.recent.iter().find(|r| r.0 == n) {
            Some(r) => Some(r.1.iter().copied().collect()),
            None => self.buf.iter().find(|b| b.block == n).map(|b| b.logs.iter().map(log_id).collect()),
        };
        let mut rctx = self.buf.iter().find(|b| b.block == n).map(|b| b.rctx);
        // A quiet block (the bot sends a message only for blocks with
        // reports, and a tick for the newest quiet one) whose every report
        // came late: inside the kept range, no message for it ever came, so
        // the copy has nothing for it. Placed like any late report, with
        // the message's own block time (was: every pool it touched unsure).
        if known.is_none() && rctx.is_none() {
            if let (Some((ts, l1)), Some(front)) = (time, self.buf.front().map(|b| b.block)) {
                if front < n && self.last_block.is_some_and(|l| n <= l) {
                    let at = self.buf.partition_point(|b| b.block < n);
                    let l1 = l1.unwrap_or_else(|| self.buf[at - 1].rctx.l1_number);
                    let r = ReplayCtx { number: n, timestamp: ts, l1_number: l1 };
                    self.buf.insert(at, BufBlock { block: n, rctx: r, logs: Arc::new(Vec::new()) });
                    inc(&st.late_hole_blocks);
                    known = Some(HashSet::new());
                    rctx = Some(r);
                }
            }
        }
        let (Some(known), Some(rctx)) = (known, rctx) else {
            self.late_not_kept(n, &logs);
            return logs.len();
        };
        let mut added: Vec<PoolLog> = logs.into_iter().filter(|l| !known.contains(&log_id(l))).collect();
        if added.is_empty() {
            inc(&st.duplicate_blocks);
            return 0;
        }
        added.sort_by_key(|l| (l.tx_index, l.log_index));
        added.dedup_by_key(|l| log_id(l));
        let Some(head) = self.sh.head() else { return 0 };
        let mut ov = Overlay::from_arc(&head.snap);
        let mut touched: Vec<PoolKey> = Vec::new();
        for log in &added {
            let pos: Pos = (n, log.tx_index, log.log_index);
            for k in self.pool_keys_for(log) {
                touched.push(k);
                let t = self.touched_addr.entry(log.address).or_insert(0);
                *t = (*t).max(n);
                let (kind, ready, gen, pool, covered) = {
                    let reg = self.c2.reg.read().unwrap();
                    let e = &reg.pools[&k];
                    (e.pool.kind, e.state == PoolState::Ready, e.gen, e.pool.clone(), self.covers(&reg, &k, n))
                };
                if covered {
                    // Its values were read at or after block n: already in.
                    inc(&st.late_old_covered);
                    continue;
                }
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
            self.late_transfer_to_partials(log, pos);
        }
        // Write the result into every kept version from block n on (the
        // pools / balances it changed did not move after n, see above).
        let changes = ov.changes().clone();
        let forgot = ov.forgotten().to_vec();
        {
            let mut p = crate::timing::TimedWrite::new(&self.sh.published);
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
            let deltas = std::mem::take(&mut self.late_deltas);
            let included = std::mem::take(&mut self.late_included);
            apply_late_coin_changes(&mut p.versions, &deltas, &included);
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
        added.len()
    }

    /// Late reports for block `n` that can't be placed: older than the kept
    /// reports, or before the copy's first block (the bot's first seconds
    /// after a restart deliver such reports). Live Oct 22 13:34: every such
    /// report made the pools it touched unsure WITH a strike (doubling the
    /// wait, cancelling a load in flight), and a V4 PoolManager report made
    /// ALL V4 pools unsure; a trickle of them kept ~290 pools unsure for
    /// 15+ min. Now, per pool:
    ///   - values read at or after block n (any load that started after the
    ///     copy did): the report is already in them, nothing to do;
    ///   - ready from an older read: unsure (no strike: not its fault);
    ///   - loading / waiting: a working copy from an older read starts over;
    ///     the next load must read at or after n (need_base), else it reads
    ///     again (on_load_one);
    ///   - a followed coin balance read before n (coin_base): forgotten from
    ///     n on (read again when a check needs it); working copies get the
    ///     transfer added (late_transfer_to_partials).
    fn late_not_kept(&mut self, n: u64, logs: &[PoolLog]) {
        let c2 = self.c2.clone();
        let st = &c2.stats;
        let mut unsure: Vec<PoolKey> = Vec::new();
        let mut restart: Vec<(PoolKey, u64)> = Vec::new();
        let mut forget_bal: Vec<(Address, Address, U256)> = Vec::new();
        let mut any = false;
        {
            let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
            for log in logs {
                let event_keys: Vec<PoolKey> = reg.by_addr.get(&log.address).map(|ks| ks.iter().filter(|k| is_pool_event(&reg.pools[*k].pool, log)).copied().collect()).unwrap_or_default();
                let mut keys: Vec<(PoolKey, Option<(Address, U256)>)> = event_keys.into_iter().map(|k| (k, None)).collect();
                if let Some((coin, from, to, _)) = coin_transfer(log) {
                    for side in [from, to] {
                        if !reg.holders.get(&coin).is_some_and(|h| h.contains(&side)) {
                            continue;
                        }
                        let Some(slot) = reg.bal_slot(coin, side) else { continue };
                        for k in reg.by_addr.get(&side).cloned().unwrap_or_default() {
                            if reg.pools.get(&k).is_some_and(|e| e.pool.token0 == coin || e.pool.token1 == coin) {
                                keys.push((k, Some((coin, slot))));
                            }
                        }
                    }
                }
                for (k, bal) in keys {
                    any = true;
                    let covered = match bal {
                        // A coin balance: its node read's block.
                        // (A working copy's own balance is handled by
                        // late_transfer_to_partials below.)
                        Some((coin, _)) => self.coin_base.get(&(coin, k.0)).is_some_and(|b| *b >= n),
                        None => self.covers(&reg, &k, n),
                    };
                    if covered {
                        inc(&st.late_old_covered);
                        continue;
                    }
                    let Some(e) = reg.pools.get_mut(&k) else { continue };
                    if let Some((coin, slot)) = bal {
                        // The balance in the copy lacks it: forgotten from n.
                        forget_bal.push((coin, k.0, slot));
                        if e.state != PoolState::Ready {
                            e.need_base = e.need_base.max(n);
                        }
                        continue;
                    }
                    if e.state == PoolState::Ready {
                        unsure.push(k);
                    } else {
                        inc(&st.late_old_reload);
                        e.need_base = e.need_base.max(n);
                        if self.partials.contains_key(&k) {
                            restart.push((k, e.gen));
                        }
                    }
                }
            }
        }
        if any {
            inc(&st.late_reports_unsure);
        }
        for log in logs {
            self.late_transfer_to_partials(log, (n, log.tx_index, log.log_index));
        }
        for (k, gen) in restart {
            self.retry_later_quiet(k, gen, "a late report came for a block before its read (no longer kept): starting over");
            if let Some(e) = crate::timing::TimedWrite::new(&self.c2.reg).pools.get_mut(&k) {
                e.fails = e.fails.saturating_sub(1);
                e.retry_at = Instant::now();
            }
        }
        unsure.sort();
        unsure.dedup();
        for k in unsure {
            self.make_unsure_with(k, "late report for a block no longer kept", None, n, false);
        }
        if !forget_bal.is_empty() {
            for (coin, holder, _) in &forget_bal {
                self.coin_base.remove(&(*coin, *holder));
                self.coin_pos.remove(&(*coin, *holder));
            }
            let mut p = crate::timing::TimedWrite::new(&self.sh.published);
            rewrite_from(&mut p.versions, n, |s| {
                for (c, _, sl) in &forget_bal {
                    forget_slot(s, *c, *sl);
                }
            });
            drop(p);
            self.sh.notify();
        }
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
            let mut p = crate::timing::TimedWrite::new(&self.sh.published);
            p.versions.clear();
            p.versions.push_back(v.clone());
            p.stalled = None;
        }
        v
    }

    fn publish(&mut self, block: u64, snap: Arc<Snapshot>, ctx: BlockCtx, diff: StateDiff) {
        self.last_ctx = Some(ctx.clone());
        let v = Version {
            seq: block.saturating_sub(self.sh.cfg.l2_offset),
            block,
            snap,
            // A block filled in from the node's logs has no details a check
            // could rely on (only what replays need): checks AT it answer
            // not_ready ("repaired"), like copy 1's trace-repaired blocks.
            ctx: if self.repairing { None } else { Some(ctx) },
            txs: vec![],
            diff: Arc::new(diff),
            restart: false,
            block_hash: None,
            applied: Instant::now(),
        };
        {
            let mut p = crate::timing::TimedWrite::new(&self.sh.published);
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

    /// The pools a report is about: the pool whose event it is (for a V4
    /// PoolManager report only THAT pool id, not every pool there: live Oct
    /// 22 13:34 one late PoolManager report made all ~290 V4 pools unsure),
    /// and for a coin Transfer the pools on either side whose balance of
    /// that coin we follow (a V4 PoolManager's balance is not followed).
    fn pools_touched(&self, logs: &[PoolLog]) -> Vec<PoolKey> {
        let reg = self.c2.reg.read().unwrap();
        let mut out = Vec::new();
        for l in logs {
            if let Some(keys) = reg.by_addr.get(&l.address) {
                out.extend(keys.iter().filter(|k| is_pool_event(&reg.pools[*k].pool, l)).copied());
            }
            // Coin transfers: the pools on either side.
            if let Some((coin, from, to, _)) = coin_transfer(l) {
                let followed = reg.holders.get(&coin);
                for side in [from, to] {
                    if !followed.is_some_and(|h| h.contains(&side)) {
                        continue;
                    }
                    if let Some(keys) = reg.by_addr.get(&side) {
                        out.extend(keys.iter().filter(|k| reg.pools.get(*k).is_some_and(|e| e.pool.token0 == coin || e.pool.token1 == coin)).copied());
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
        let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
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
                let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
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
                if late {
                    // A late Transfer (live Oct 22: the busiest pool,
                    // WETH/USDG 0x52e65b17, lost its balances this way over
                    // and over: its reports come on separate subscriptions
                    // and settles add missed ones ~1.5 s later, by when the
                    // pool has traded again; the old rule "a later transfer
                    // was applied already -> forget" then made the balance
                    // MISSING, and a fill of a pool that trades every few
                    // blocks was asked again forever).
                    // Adding is exact in any order: the held value of every
                    // version from block n on lacks exactly this transfer IF
                    // it descends from a node value read before block n
                    // (coin_base). A node value read at or after block n has
                    // it already: nothing to add there; versions in between
                    // (older chain values) forget it.
                    match self.coin_base.get(&(coin, side)).copied() {
                        Some(base) if block > base => {
                            inc(&self.c2.stats.late_coin_deltas);
                            self.late_deltas.push((coin, slot, block, is_from, v));
                        }
                        Some(base) => {
                            inc(&self.c2.stats.late_coin_included);
                            self.late_included.push((coin, slot, block, base));
                        }
                        None => {
                            // Where its value came from is unknown: never guess.
                            inc(&self.c2.stats.coin_slot_mismatch);
                            ov.forget_slot(coin, slot);
                        }
                    }
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

    /// A late coin Transfer and the loads that are WAITING (for node
    /// values) past its place: the buffer gets the report, but such a load
    /// has already carried its working copy beyond it and would never see
    /// it. Its coin balance is a node value from its load block (`base`)
    /// plus the transfers since, so a transfer after `base` and before its
    /// cursor is added to it now (adding is exact in any order; a balance
    /// that would go below zero is forgotten instead). Before this fix the
    /// transfer was simply lost and the pool became ready with a balance
    /// off by exactly that amount, for good (dry run #16, 0x52e65b17).
    fn late_transfer_to_partials(&mut self, log: &PoolLog, pos: Pos) {
        let Some((coin, from, to, v)) = coin_transfer(log) else { return };
        let keys: Vec<PoolKey> = self.partials.iter().filter(|(k, p)| (k.0 == from || k.0 == to) && p.base < pos && pos < p.cursor).map(|(k, _)| *k).collect();
        for k in keys {
            let slot = {
                let reg = self.c2.reg.read().unwrap();
                match reg.pools.get(&k) {
                    Some(e) if e.pool.token0 == coin || e.pool.token1 == coin => reg.bal_slot(coin, k.0),
                    _ => None,
                }
            };
            let (Some(slot), Some(part)) = (slot, self.partials.get_mut(&k)) else { continue };
            inc(&self.c2.stats.late_transfers_to_loading);
            for (side, is_from) in [(from, true), (to, false)] {
                if side != k.0 {
                    continue;
                }
                if let Lookup::Known(cur) = part.ov.slot(coin, slot) {
                    match if is_from { cur.checked_sub(v) } else { cur.checked_add(v) } {
                        Some(x) => part.ov.set_slot(coin, slot, x),
                        None => part.ov.forget_slot(coin, slot),
                    }
                }
            }
        }
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
        self.make_unsure_with(k, why, ov, from_block, true)
    }

    /// `strike`: counts against the pool (its wait before reloading doubles
    /// each time in a row). A reload every pool gets because the bot missed
    /// something is NOT the pool's fault: no strike (Oct 22 live failure: a
    /// burst of such signals doubled every pool's wait up to 10 min, so the
    /// copy sat at 0 loading / all unsure).
    fn make_unsure_with(&mut self, k: PoolKey, why: &str, ov: Option<&mut Overlay>, from_block: u64, strike: bool) {
        self.partials.remove(&k);
        let forget: Vec<(Address, U256)> = {
            let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
            let Some(e) = reg.pools.get_mut(&k) else { return };
            let was_ready = e.state == PoolState::Ready;
            let old_retry = e.retry_at;
            if strike {
                e.strikes = e.strikes.saturating_add(1);
            }
            e.clean_events = 0;
            e.state = PoolState::Unsure;
            e.reason = why.to_string();
            e.gen += 1;
            e.busy = false;
            e.walk = None;
            e.far_zero = None;
            let walked = std::mem::take(&mut e.walked);
            if strike {
                let wait = self.backoff(e.strikes, why);
                e.retry_at = Instant::now() + wait;
            } else {
                // Reload soon (the normal first wait), but never sooner than
                // a wait the pool already had for its own trouble.
                let soon = Instant::now() + Duration::from_millis(self.cfg.reload_ms);
                e.retry_at = if was_ready { soon } else { soon.max(old_retry) };
            }
            e.items.iter().copied().chain(walked).collect()
        };
        inc(&self.c2.stats.unsure_marked);
        if let Some(ov) = ov {
            for (a, s) in &forget {
                ov.forget_slot(*a, *s);
            }
        }
        let mut p = crate::timing::TimedWrite::new(&self.sh.published);
        rewrite_from(&mut p.versions, from_block, |s| {
            for (a, sl) in &forget {
                forget_slot(s, *a, *sl);
            }
        });
    }

    /// Reorg: these pools unsure from `from`, and their coin balances
    /// forgotten too (the reorged transfers changed them).
    fn unsure_from(&mut self, keys: &[PoolKey], why: &str, from: u64) {
        self.unsure_from_with(keys, why, from, true)
    }

    fn unsure_from_with(&mut self, keys: &[PoolKey], why: &str, from: u64, strike: bool) {
        let mut slots: Vec<(Address, U256)> = Vec::new();
        {
            let reg = self.c2.reg.read().unwrap();
            for k in keys {
                if let Some(e) = reg.pools.get(k) {
                    for c in [e.pool.token0, e.pool.token1] {
                        let memo = match reg.layouts.get(&c) {
                    Some(Some(l)) => l.preimage(e.pool.address).map(super::checkview::memo_slot),
                    _ => None,
                };
                if let Some(sl) = memo.or_else(|| reg.bal_slot(c, e.pool.address)) {
                            slots.push((c, sl));
                        }
                    }
                }
            }
        }
        for k in keys {
            self.make_unsure_with(*k, why, None, from, strike);
        }
        let mut p = crate::timing::TimedWrite::new(&self.sh.published);
        rewrite_from(&mut p.versions, from, |s| {
            for (a, sl) in &slots {
                forget_slot(s, *a, *sl);
            }
        });
    }

    #[allow(dead_code)]
    fn unsure_all(&mut self, why: &str, from: u64) {
        let keys: Vec<PoolKey> = self.c2.reg.read().unwrap().pools.keys().copied().collect();
        self.unsure_from(&keys, why, from);
    }

    /// The bot missed something (or a message was lost): every pool whose
    /// copy may now lack reports is reloaded, ONCE. Pools already unsure
    /// from an earlier such signal and not loading yet need nothing new
    /// (their values are forgotten already, their reload is already due):
    /// a burst of signals therefore can't keep pushing their reload back.
    /// Pools ready or loading (a load fetched before this block can't carry
    /// across the hole) are made unsure without a strike.
    fn reload_all_after_gap(&mut self, why: &str, from: u64) {
        let keys: Vec<PoolKey> = {
            let reg = self.c2.reg.read().unwrap();
            reg.pools
                .iter()
                .filter(|(_, e)| !(e.state == PoolState::Unsure && !e.busy && e.reason.starts_with("lost message")))
                .map(|(k, _)| *k)
                .collect()
        };
        self.unsure_from_with(&keys, why, from, false);
    }

    /// Replace the head version's state (only if it is still at `block`).
    fn into_head(&self, block: u64, f: impl Fn(&mut Snapshot)) -> bool {
        let mut p = crate::timing::TimedWrite::new(&self.sh.published);
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
            let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
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
        if self.load_jobs_in_flight() >= max_jobs || self.refusing_now() {
            return;
        }
        // "Not found" is asked again after a while (it may have been a bad moment).
        {
            let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
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
            let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
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
            let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
            let bal: HashMap<(Address, Address), Option<U256>> = keys
                .iter()
                .filter_map(|k| reg.pools.get(k).map(|e| e.pool.clone()))
                .flat_map(|p| [(p.token0, p.address), (p.token1, p.address)])
                .map(|(c, h)| ((c, h), reg.bal_slot(c, h)))
                .collect();
            let pm_bound = reg.pm_bound;
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
                // Tick-walk values are not asked here: the next walk brings
                // them (one request) instead of hundreds of single values.
                e.walked.clear();
                e.walk = None;
                e.far_zero = None;
                for a in &e.accounts {
                    push(&mut items, MissItem::Account(*a));
                }
                let mut coin_checks = Vec::new();
                for c in [p.token0, p.token1] {
                    if c == Address::ZERO || (pm_bound && p.kind == PoolKind::V4) {
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
        self.note_refusals(&d);
        let id = match &d {
            Done::Fetch { id, .. } | Done::Probe { id, .. } | Done::Tip { id, .. } | Done::Trace { id, .. } | Done::Walk { id, .. } | Done::Logs { id, .. } | Done::CatchUp { id, .. } => *id,
        };
        let Some(job) = self.jobs.remove(&id) else { return };
        match (job, d) {
            (JobFor::Probe, Done::Probe { coin, res, .. }) => {
                self.probing.remove(&coin);
                let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
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
            (JobFor::Trace, Done::Trace { coin, holder, block, res, .. }) => self.on_trace(coin, holder, block, res),
            (JobFor::Walk { key, gen }, Done::Walk { block, res, .. }) => self.on_walk(key, gen, block, res),
            (JobFor::Logs { from, to }, Done::Logs { res, .. }) => self.on_settle(from, to, res),
            (JobFor::Verify, Done::Fetch { block, res, .. }) => self.on_verify(block, res),
            (JobFor::CatchUp, Done::CatchUp { id, res }) => self.on_catchup(id, res),
            (JobFor::ResumeVerify, Done::Fetch { id, block, res }) => self.on_resume_verify(id, block, res),
            _ => {}
        }
    }

    /// A balance trace came back: remember the slot (the load then fetches
    /// it at its own block), or mark the pool(s) unsure if no single slot
    /// holds exactly the balance. Node error: ask again in 3 s.
    fn on_trace(&mut self, coin: Address, holder: Address, block: u64, res: Result<(U256, Value), crate::node::NodeErr>) {
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
                    let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
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
                // The coin's code, a proxy's implementation and the coin
                // settings balanceOf read: fitted in exactly like a fill, at
                // the TRACED block (only where the copy doesn't know them;
                // too old / ahead of the copy = dropped, a check then misses
                // and a fill reads them). The balance itself comes with the
                // pool's load, at its block.
                let facts: Vec<Fetched> = facts.into_iter().filter(|f| !matches!(f, Fetched::Slot(a, s, _) if *a == coin && *s == slot)).collect();
                if !facts.is_empty() {
                    {
                        let mut p = crate::timing::TimedWrite::new(&self.sh.published);
                        reconcile(&mut p.versions, block, &facts);
                    }
                    self.sh.notify();
                }
            }
            Err(n) => {
                inc(&self.c2.stats.coin_trace_not_found);
                self.outcomes.coin_not_found += 1;
                let why = format!("coin {coin}: can't find where it keeps this pool's balance ({n} storage values equal it)");
                self.trace_failed.insert(pair, (Instant::now(), why.clone()));
                let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
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

    /// Did a node answer contain a "too fast" refusal (RPS limit)? Then no
    /// new first loads / fills for a while (1 s doubling to 4 s while it
    /// goes on); an answer without one ends that.
    fn note_refusals(&mut self, d: &Done) {
        let refused = match d {
            Done::Fetch { res: Ok(o), .. } => {
                o.items.iter().any(|(_, r)| matches!(r, Err(ItemErr::Other(m)) if is_refusal(m))) || o.calls.iter().any(|c| matches!(c, Err(m) if is_refusal(m)))
            }
            Done::Fetch { res: Err(e), .. }
            | Done::Probe { res: Err(e), .. }
            | Done::Tip { res: Err(e), .. }
            | Done::Trace { res: Err(e), .. }
            | Done::Walk { res: Err(e), .. }
            | Done::Logs { res: Err(e), .. }
            | Done::CatchUp { res: Err(e), .. } => is_refusal(&e.to_string()),
            _ => false,
        };
        if refused {
            inc(&self.c2.stats.node_refusals);
            let now = Instant::now();
            let (n, grew) = match self.refusing {
                // 16 jobs in flight refused at once = one step, not 16.
                Some((_, n, g)) if now.duration_since(g) < Duration::from_secs(1) => (n, g),
                Some((_, n, _)) => (n + 1, now),
                None => (1, now),
            };
            let wait = Duration::from_millis(1000u64 << (n - 1).min(2));
            self.refusing = Some((now + wait, n, grew));
        } else if matches!(d, Done::Fetch { res: Ok(_), .. }) && self.refusing.is_some_and(|r| r.0 <= Instant::now()) {
            self.refusing = None;
        }
    }

    /// Is the node refusing us right now (no new bulk work)?
    fn refusing_now(&self) -> bool {
        self.refusing.is_some_and(|r| r.0 > Instant::now())
    }

    /// retry_later without counting (the job's error was counted once).
    fn retry_later_quiet(&mut self, k: PoolKey, gen: u64, why: &str) {
        self.partials.remove(&k);
        let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
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
        let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
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
        // A late report that could not be placed came for a block after
        // this read: the load would lack it. Read again (the node is a block
        // or two behind; not the pool's fault).
        let need = self.c2.reg.read().unwrap().pools.get(&r.key).map(|e| e.need_base).unwrap_or(0);
        if block < need {
            self.retry_later_quiet(r.key, r.gen, &format!("read at block {block}, but a late report came for block {need}: reading again"));
            if let Some(e) = crate::timing::TimedWrite::new(&self.c2.reg).pools.get_mut(&r.key) {
                e.fails = e.fails.saturating_sub(1);
                e.retry_at = Instant::now() + soon();
            }
            return;
        }
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
                let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
                reg.layouts.insert(c, None);
                reg.not_found_at.insert(c, Instant::now());
            }
            self.make_unsure(r.key, &why, None, block + 1);
            return;
        }
        {
            let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
            if let Some(e) = reg.pools.get_mut(&r.key) {
                e.verified = true;
            }
        }
        let mut ov = self.empty_copy();
        for f in &facts {
            ov.learn(f);
        }
        self.continue_partial(r.key, Partial { ov, cursor: (block + 1, 0, 0), gen: r.gen, errors: 0, hard_errors: 0, refusals: 0, base: (block, END, END) });
    }

    fn on_need(&mut self, key: PoolKey, gen: u64, items: Vec<MissItem>, block: u64, res: Result<FetchOut, crate::node::NodeErr>) {
        // An answer for an earlier load of this pool: ignored, and the
        // current load's working copy (if any) stays (see dispatch_delayed).
        if self.partials.get(&key).is_none_or(|p| p.gen != gen) {
            return;
        }
        let mut part = self.partials.remove(&key).unwrap();
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
            // "Too fast" (RPS limit): only wait and ask again (1, 2, 4 s; the
            // node client has slowed down meanwhile). It never restarts the
            // load: that would ask for everything the pool held again (the
            // storm of dry run #16). Real errors: 10 in a row restart it.
            if is_refusal(&why) {
                part.refusals += 1;
                inc(&self.c2.stats.need_refusal_retries);
                let wait = backoff(part.refusals.min(3));
                self.partials.insert(key, part);
                self.delayed.push((Instant::now() + wait, key, gen, items));
                return;
            }
            part.hard_errors += 1;
            let errs = part.errors;
            if part.hard_errors >= 10 {
                self.partials.insert(key, part);
                self.retry_later(key, gen, &why);
            } else {
                self.partials.insert(key, part);
                self.delayed.push((Instant::now() + backoff(errs), key, gen, items));
            }
            return;
        }
        part.errors = 0;
        part.hard_errors = 0;
        part.refusals = 0;
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
            let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
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
        // An old block is a slower read on this node: start the load over at
        // the newest block instead (it then carries only a few blocks). Not
        // while the node refuses us for going too fast (a restart asks for
        // everything again), unless it got really old (half the kept reports).
        let age = self.last_block.unwrap_or(0).saturating_sub(at);
        let limit = if part.refusals > 0 { (self.cfg.keep_blocks as u64 / 2).max(self.cfg.catchup_max_blocks) } else { self.cfg.catchup_max_blocks };
        if age > limit {
            self.partials.insert(key, part);
            self.retry_later_quiet(key, gen, "catch-up block too old, reloading at the newest block");
            if let Some(e) = crate::timing::TimedWrite::new(&self.c2.reg).pools.get_mut(&key) {
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
            let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
            let Some(e) = reg.pools.get_mut(&k) else { return };
            e.gen += 1;
            e.state = PoolState::Loading;
            e.busy = true;
            e.rounds = 0;
            // Its walked tick data is carried in the working copy too (put
            // back by the merge; no new walk needed).
            let mut own = e.items.clone();
            own.extend(e.walked.iter().copied());
            (e.pool.clone(), own, e.accounts.clone(), e.gen)
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
        // Its coin balances are NOT copied: the block copy keeps following
        // them from Transfers (it holds them), and the merge keeps the block
        // copy's value. (A copy here would be a second, unchecked version of
        // the same number; see late_transfer_to_partials / merge.)
        // The block copy no longer vouches for its own values.
        for (a, s) in &owned_items {
            ov.forget_slot(*a, *s);
        }
        self.send_need(k, Partial { ov: part, cursor, gen, errors: 0, hard_errors: 0, refusals: 0, base: (0, 0, 0) }, items);
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
            if reg.pm_bound && pool.kind == PoolKind::V4 {
                Vec::new()
            } else {
                [pool.token0, pool.token1].into_iter().filter(|c| *c != Address::ZERO).filter_map(|c| reg.bal_slot(c, pool.address).map(|s| (c, s))).collect()
            }
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
        let Some(head) = self.sh.head() else {
            self.retry_later_quiet(key, part.gen, "no copy to merge into yet");
            return;
        };
        let (pool, holders, old_owned, bal_slots) = {
            let reg = self.c2.reg.read().unwrap();
            let Some(e) = reg.pools.get(&key) else { return };
            let bs: Vec<(Address, U256)> = if reg.pm_bound && e.pool.kind == PoolKind::V4 {
                Vec::new()
            } else {
                [e.pool.token0, e.pool.token1].into_iter().filter_map(|c| reg.bal_slot(c, e.pool.address).map(|s| (c, s))).collect()
            };
            (e.pool.clone(), reg.holders.keys().copied().collect::<HashSet<Address>>(), e.owned.clone(), bs)
        };
        let snap = part.ov.snapshot();
        // Safety net (dry run #16): a coin balance the copy already follows
        // must agree with this load's own value (node value carried to the
        // same block through the same reports). If they differ, one of them
        // is wrong and we can't tell which: the balance becomes MISSING in
        // every kept version (a check then misses it and a fill reads it).
        let mut disagree: Vec<(Address, U256)> = Vec::new();
        for (c, sl) in &bal_slots {
            if let (Lookup::Known(mine), Lookup::Known(theirs)) = (snap.storage(*c, *sl), head.snap.storage(*c, *sl)) {
                if mine != theirs {
                    inc(&self.c2.stats.coin_balance_disagree);
                    let delta = if mine >= theirs { format!("+{}", mine - theirs) } else { format!("-{}", theirs - mine) };
                    eprintln!(
                        "[arbsim] copy2: coin {c} balance of {} pool {}: the copy followed {theirs} but its reload says {mine} at block {} (load minus copy {delta}); forgetting it (MISSING until read again)",
                        kind_name(pool.kind), pool.address, head.block
                    );
                    disagree.push((*c, *sl));
                }
            }
        }
        if !disagree.is_empty() {
            let mut p = crate::timing::TimedWrite::new(&self.sh.published);
            rewrite_from(&mut p.versions, 0, |s| {
                for (a, sl) in &disagree {
                    forget_slot(s, *a, *sl);
                }
            });
            drop(p);
            for (c, _) in &disagree {
                self.coin_pos.remove(&(*c, pool.address));
                self.coin_base.remove(&(*c, pool.address));
            }
        }
        let head = match self.sh.head() {
            Some(h) => h,
            None => {
                self.retry_later_quiet(key, part.gen, "no copy to merge into yet");
                return;
            }
        };
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
        // Walked tick data stays in `walked` (not duplicated into `items`).
        let walked: HashSet<(Address, U256)> = self.c2.reg.read().unwrap().pools.get(&key).map(|e| e.walked.iter().copied().collect()).unwrap_or_default();
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
                if own && !walked.contains(&(*addr, *s)) {
                    items.insert((*addr, *s));
                }
                if disagree.contains(&(*addr, *s)) {
                    continue;
                }
                facts.push(Fact::Slot(*addr, *s, *v));
            }
        }
        let head_missing: HashSet<(Address, U256)> = bal_slots.iter().filter(|(c, sl)| matches!(head.snap.storage(*c, *sl), Lookup::Missing)).copied().collect();
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
        for (c, sl) in &bal_slots {
            if !disagree.contains(&(*c, *sl)) {
                self.coin_pos.insert((*c, pool.address), (head.block, END, END));
                // The head now holds this load's node value (read at
                // part.base) if it didn't hold the balance before: from now
                // on every held value of it descends from that read
                // (coin_base), so older versions (older reads) forget it.
                // If the head held it already (and it agreed), the followed
                // chain and its coin_base stay.
                if part.base.0 > 0 && head_missing.contains(&(*c, *sl)) && matches!(part.ov.snapshot().storage(*c, *sl), Lookup::Known(_)) {
                    self.coin_base.insert((*c, pool.address), part.base.0);
                    let mut p = crate::timing::TimedWrite::new(&self.sh.published);
                    forget_before(&mut p.versions, head.block, *c, *sl);
                }
            }
        }
        let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
        if let Some(e) = reg.pools.get_mut(&key) {
            e.state = PoolState::Ready;
            e.reason = String::new();
            e.busy = false;
            e.ever_ready = true;
            e.fails = 0;
            e.ready_since = head.block;
            // A load's node block (an in-block working copy keeps the old
            // one: its values descend from it).
            if part.base.0 > 0 {
                e.base_block = part.base.0;
            }
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


    /// Process memory in MB, read at most once a second.
    fn rss_mb_cached(&self) -> f64 {
        let (mb, at) = self.rss.get();
        if at.is_some_and(|t| t.elapsed() < Duration::from_secs(1)) {
            return mb;
        }
        let mb = Shared::rss_mb();
        self.rss.set((mb, Some(Instant::now())));
        mb
    }

    // ---- tick walks (copy2/walk.rs) ----
    /// Send tick walks for ready V3-style pools that have none yet (or whose
    /// price has moved more than half the window away from the walk).
    fn dispatch_walks(&mut self) {
        if self.walk_off || self.cfg.walks_inflight == 0 || self.loaders.is_none() || self.refusing_now() {
            return;
        }
        let running = self.jobs.values().filter(|j| matches!(j, JobFor::Walk { .. })).count();
        if running >= self.cfg.walks_inflight {
            return;
        }
        let Some(head) = self.sh.head() else { return };
        let now = Instant::now();
        let half = (self.cfg.walk.window_ticks / 2) as i64;
        let held: usize = self.c2.reg.read().unwrap().pools.values().map(|e| e.walked.len()).sum();
        let paused = if held >= self.cfg.walk_max_slots {
            Some(format!("walked values {held} >= ARBSIM_COPY2_WALK_MAX_SLOTS {}", self.cfg.walk_max_slots))
        } else if self.cfg.walk_max_rss_mb > 0 && self.rss_mb_cached() >= self.cfg.walk_max_rss_mb as f64 {
            Some(format!("memory {:.0} MB >= ARBSIM_COPY2_WALK_MAX_RSS_MB {}", self.rss_mb_cached(), self.cfg.walk_max_rss_mb))
        } else {
            None
        };
        {
            let mut p = self.c2.walk_paused.lock().unwrap();
            if paused.is_some() && p.is_none() {
                eprintln!("[arbsim] copy2: new tick walks paused: {}", paused.as_deref().unwrap_or(""));
            }
            *p = paused.clone();
        }
        if paused.is_some() {
            return;
        }
        let mut due: Vec<(bool, std::cmp::Reverse<u64>, PoolKey)> = {
            let reg = self.c2.reg.read().unwrap();
            reg.pools
                .iter()
                .filter(|(_, e)| e.state == PoolState::Ready && walks(e.pool.kind) && !e.walk_busy && e.walk_retry_at <= now)
                .filter(|(_, e)| match &e.walk {
                    None => true,
                    Some(w) if !w.done => true,
                    // Algebra walks every initialized tick: no window to leave.
                    Some(_) if e.pool.kind == PoolKind::Algebra => false,
                    Some(w) => current_tick(&e.pool, &head.snap).is_some_and(|t| (t - w.center).abs() > half),
                })
                .map(|(k, e)| (e.walk.is_some(), std::cmp::Reverse(self.touched_addr.get(&e.pool.address).copied().unwrap_or(0)), *k))
                .collect()
        };
        due.sort();
        for (_, _, k) in due.into_iter().take(self.cfg.walks_inflight - running) {
            let (pool, gen) = {
                let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
                let Some(e) = reg.pools.get_mut(&k) else { continue };
                e.walk_busy = true;
                (e.pool.clone(), e.gen)
            };
            inc(&self.c2.stats.walks);
            let id = self.new_job(JobFor::Walk { key: k, gen });
            self.loaders.as_ref().unwrap().send(Job::Walk { id, block: head.block, pool, cfg: self.cfg.walk.clone() });
        }
    }

    /// A walk came back (exact at block k): take the pool's own values in
    /// where the copy doesn't hold them, carried from k to now through the
    /// copy's own changes (like fills). Only while the pool has been ready
    /// since <= k without a reload: then every change its events made after
    /// k is in those changes (a replay can't write a slot it doesn't hold
    /// without asking first, which takes the pool out of ready).
    fn on_walk(&mut self, key: PoolKey, gen: u64, k: u64, res: Result<Value, crate::node::NodeErr>) {
        let tr = match res {
            Ok(t) => t,
            Err(e) => {
                let m = e.to_string();
                inc(&self.c2.stats.walk_errors);
                self.note_node_error(&format!("walk: {m}"));
                let l = m.to_ascii_lowercase();
                if l.contains("method not found") || l.contains("not supported") || l.contains("does not exist") || l.contains("unknown method") {
                    eprintln!("[arbsim] copy2: the node can't run the tick walk ({m}); tick walks off");
                    self.walk_off = true;
                }
                let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
                if let Some(e) = reg.pools.get_mut(&key) {
                    e.walk_busy = false;
                    e.walk_fails = e.walk_fails.saturating_add(1);
                    e.walk_retry_at = Instant::now() + walk_backoff(e.walk_fails, m.contains(crate::node::SPEED_LIMIT));
                }
                return;
            }
        };
        let (pool, owned, ok) = {
            let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
            let Some(e) = reg.pools.get_mut(&key) else { return };
            e.walk_busy = false;
            let ok = e.gen == gen && e.state == PoolState::Ready && e.ready_since <= k;
            if !ok {
                // Reloaded / not ready since then: walk again later.
                e.walk_retry_at = Instant::now() + Duration::from_millis(500);
            }
            (e.pool.clone(), e.owned.clone(), ok)
        };
        if !ok {
            inc(&self.c2.stats.walks_refused);
            return;
        }
        let out = read_walk(&tr, &pool, &owned);
        let Some(head) = self.sh.head() else { return };
        let facts: Vec<Fetched> = out
            .slots
            .iter()
            .filter(|(a, s, _)| matches!(head.snap.storage(*a, *s), Lookup::Missing))
            .map(|(a, s, v)| Fetched::Slot(*a, *s, *v))
            .collect();
        let res = {
            let mut p = crate::timing::TimedWrite::new(&self.sh.published);
            reconcile(&mut p.versions, k, &facts)
        };
        if res.too_old > 0 && res.applied == 0 && !facts.is_empty() {
            // The kept versions don't reach back to k: walk again.
            inc(&self.c2.stats.walks_refused);
            let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
            if let Some(e) = reg.pools.get_mut(&key) {
                e.walk_retry_at = Instant::now() + Duration::from_secs(1);
            }
            return;
        }
        add(&self.c2.stats.walk_slots, res.applied as u64);
        if out.done {
            inc(&self.c2.stats.walks_done);
        } else {
            inc(&self.c2.stats.walks_partial);
        }
        {
            let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
            if let Some(e) = reg.pools.get_mut(&key) {
                e.walked.extend(out.slots.iter().map(|(a, s, _)| (*a, *s)));
                e.walked.sort_unstable();
                e.walked.dedup();
                // Kept for the pool's life: no spare capacity (memory, #18).
                e.walked.shrink_to_fit();
                e.walk = Some(WalkInfo { block: k, done: out.done, center: out.center, word_lo: out.word_lo, word_hi: out.word_hi, ticks: out.ticks, slots: out.slots.len() });
                // A newer walk's far words replace the older ones (an older
                // set stays true too, but one set per pool keeps it simple:
                // a word only the old walk knew is then just missing).
                if !out.far_zero.is_empty() {
                    let mut fz = out.far_zero.clone();
                    fz.shrink_to_fit();
                    add(&self.c2.stats.walk_far_zero, fz.len() as u64);
                    e.far_zero = Some(FarZero { block: k, slots: Arc::new(fz) });
                }
                if out.done {
                    e.walk_fails = 0;
                } else {
                    // Cut short (gas?): what it read is exact; try again later.
                    e.walk_fails = e.walk_fails.saturating_add(1);
                    e.walk_retry_at = Instant::now() + walk_backoff(e.walk_fails, false);
                }
            }
        }
        // A late report up to k is already in these values: from now on it
        // makes the pool unsure instead of being applied twice.
        let lp = self.last_pos.entry(key).or_insert((0, 0, 0));
        *lp = (*lp).max((k, END, END));
        self.sh.notify();
    }

    // ---- pending reports (late reports race, dry run #17) ----
    /// Pools whose reports for this block may not all be in the message:
    ///   - the header's logsBloom (if the bot sent it) says the pool's
    ///     address appears in the block (as a log's address, or as a Transfer
    ///     topic) but no report of that sort came for it;
    ///   - a pool event that moved coins (swap, mint, collect, flash) came,
    ///     but no Transfer of that coin to / from the pool in the same
    ///     transaction (the transfers come on other subscriptions).
    fn note_suspects(&mut self, m: &BlockMsg) {
        // The copy's first block: every pool is loaded at it or later, so its
        // reports are in the loaded values anyway.
        if self.last_block.is_none() {
            return;
        }
        let mut sus: HashSet<PoolKey> = HashSet::new();
        {
            let reg = self.c2.reg.read().unwrap();
            let mut own: HashSet<PoolKey> = HashSet::new();
            let mut xfer: HashSet<Address> = HashSet::new();
            // (tx, pool address, coin) transfers seen
            let mut seen: HashSet<(B256, Address, Address)> = HashSet::new();
            for l in &m.logs {
                if l.removed {
                    continue;
                }
                if let Some((coin, from, to, _)) = coin_transfer(l) {
                    for side in [from, to] {
                        if reg.holders.get(&coin).is_some_and(|h| h.contains(&side)) {
                            xfer.insert(side);
                            seen.insert((l.tx_hash, side, coin));
                        }
                    }
                }
                for k in self.pool_keys_for(l) {
                    own.insert(k);
                }
            }
            if let Some(bloom) = &m.bloom {
                for (k, e) in &reg.pools {
                    let hit_own = match e.pool.v4_id {
                        Some(id) => in_bloom(bloom, id.as_slice()),
                        None => in_bloom(bloom, e.pool.address.as_slice()),
                    };
                    if hit_own && !own.contains(k) {
                        sus.insert(*k);
                    }
                    if e.pool.v4_id.is_none() {
                        let mut t = [0u8; 32];
                        t[12..].copy_from_slice(e.pool.address.as_slice());
                        if in_bloom(bloom, &t) && !xfer.contains(&e.pool.address) {
                            sus.insert(*k);
                        }
                    }
                }
            }
            // (tx, pool address) with a pool event in this message
            let mut evt: HashSet<(B256, Address)> = HashSet::new();
            for l in &m.logs {
                if l.removed {
                    continue;
                }
                for k in self.pool_keys_for(l) {
                    let Some(e) = reg.pools.get(&k) else { continue };
                    evt.insert((l.tx_hash, e.pool.address));
                    for coin in coins_moved(&e.pool, l) {
                        if !seen.contains(&(l.tx_hash, e.pool.address, coin)) {
                            sus.insert(k);
                        }
                    }
                }
            }
            // A coin moved to / from a V3-style pool in a transaction where
            // that pool reported nothing: its event may still be on the way
            // (or it was a plain transfer to the pool: settling costs one
            // request and finds nothing).
            for (tx, holder, _) in &seen {
                if evt.contains(&(*tx, *holder)) {
                    continue;
                }
                for k in reg.by_addr.get(holder).cloned().unwrap_or_default() {
                    if reg.pools.get(&k).is_some_and(|e| matches!(e.pool.kind, PoolKind::V3 | PoolKind::PancakeV3 | PoolKind::Algebra)) {
                        sus.insert(k);
                    }
                }
            }
        }
        if m.bloom.is_some() {
            inc(&self.c2.stats.blooms);
        }
        if sus.is_empty() {
            return;
        }
        add(&self.c2.stats.pending_marked, sus.len() as u64);
        {
            let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
            for k in &sus {
                if let Some(e) = reg.pools.get_mut(k) {
                    e.pending_from = Some(e.pending_from.map_or(m.block, |b| b.min(m.block)));
                }
            }
        }
        let ent = self.suspects.entry(m.block).or_insert((Instant::now(), HashSet::new()));
        ent.1.extend(sus);
    }

    /// Settle suspect blocks older than pending_ms: ask the node for those
    /// pools' reports in those blocks (one request, a few filters), apply
    /// any we never got as late reports, and clear the pending marks.
    fn dispatch_settle(&mut self) {
        if self.suspects.is_empty() || self.jobs.values().any(|j| matches!(j, JobFor::Logs { .. })) {
            return;
        }
        let now = Instant::now();
        if self.settle_retry.is_some_and(|r| r.0 > now) {
            return;
        }
        let age = Duration::from_millis(self.cfg.pending_ms);
        let ready: Vec<u64> = self.suspects.iter().filter(|(_, (t, _))| now.duration_since(*t) >= age).map(|(b, _)| *b).collect();
        let (Some(&from), Some(&to)) = (ready.first(), ready.last()) else { return };
        let Some(loaders) = &self.loaders else {
            // No node: they can never be settled; such pools are unsure.
            let keys: Vec<PoolKey> = ready.iter().flat_map(|b| self.suspects.remove(b).map(|x| x.1).unwrap_or_default()).collect();
            for k in keys {
                self.make_unsure(k, "reports may be missing and no node to check", None, from);
            }
            self.recompute_pending();
            return;
        };
        let keys: HashSet<PoolKey> = self.suspects.range(from..=to).flat_map(|(_, (_, ks))| ks.iter().copied()).collect();
        let filters = {
            let reg = self.c2.reg.read().unwrap();
            settle_filters(&reg, &keys)
        };
        let _ = loaders;
        inc(&self.c2.stats.pending_settles);
        let id = self.new_job(JobFor::Logs { from, to });
        self.loaders.as_ref().unwrap().send(Job::Logs { id, from, to, filters });
    }

    fn on_settle(&mut self, from: u64, to: u64, res: Result<Vec<Value>, crate::node::NodeErr>) {
        let logs = match res {
            Ok(l) => l,
            Err(e) => {
                let m = e.to_string();
                inc(&self.c2.stats.pending_errors);
                let n = self.settle_retry.map(|r| r.1 + 1).unwrap_or(1);
                let not_yet = m.contains(NOT_YET) || m.contains(crate::node::SPEED_LIMIT);
                self.settle_retry = Some((Instant::now() + if not_yet { Duration::from_millis(300) } else { backoff(n) }, n));
                if !not_yet {
                    self.note_node_error(&format!("settle: {m}"));
                }
                // Unsettled for over a minute: those pools are reloaded.
                let old: Vec<u64> = self.suspects.iter().filter(|(_, (t, _))| t.elapsed() > Duration::from_secs(60)).map(|(b, _)| *b).collect();
                for b in old {
                    if let Some((_, ks)) = self.suspects.remove(&b) {
                        for k in ks {
                            self.make_unsure(k, "reports may be missing and the node's logs could not be read", None, b);
                        }
                    }
                }
                self.recompute_pending();
                return;
            }
        };
        self.settle_retry = None;
        let mut by_block: BTreeMap<u64, Vec<PoolLog>> = BTreeMap::new();
        for v in &logs {
            let Some(b) = num(v.get("blockNumber")) else { continue };
            if b < from || b > to {
                continue;
            }
            if let Ok(l) = parse_log(v, b) {
                if !l.removed {
                    by_block.entry(b).or_default().push(l);
                }
            }
        }
        // Keep only reports about our pools (the filters can match more).
        for (b, mut ls) in by_block {
            ls.retain(|l| !self.pool_keys_for(l).is_empty() || coin_transfer(l).is_some_and(|(c, f, t, _)| {
                let reg = self.c2.reg.read().unwrap();
                reg.holders.get(&c).is_some_and(|h| h.contains(&f) || h.contains(&t))
            }));
            if ls.is_empty() {
                continue;
            }
            let n = self.on_late(b, ls);
            add(&self.c2.stats.pending_found, n as u64);
        }
        let done: Vec<u64> = self.suspects.range(from..=to).map(|(b, _)| *b).collect();
        for b in done {
            self.suspects.remove(&b);
        }
        self.recompute_pending();
    }

    /// pending_from of every pool = its oldest unsettled suspect block.
    fn recompute_pending(&mut self) {
        let mut first: HashMap<PoolKey, u64> = HashMap::new();
        for (b, (_, ks)) in &self.suspects {
            for k in ks {
                first.entry(*k).or_insert(*b);
            }
        }
        let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
        for (k, e) in reg.pools.iter_mut() {
            e.pending_from = first.get(k).copied();
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
        if !self.fill_later.is_empty() {
            let now = Instant::now();
            let (due, wait): (Vec<_>, Vec<_>) = std::mem::take(&mut self.fill_later).into_iter().partition(|x| x.0 <= now);
            self.fill_later = wait;
            self.fills.push(due.into_iter().map(|x| x.1));
        }
        if self.loaders.is_none() || self.refusing_now() || self.jobs.values().any(|j| matches!(j, JobFor::Fill)) {
            return;
        }
        let items = self.fills.take(100);
        if items.is_empty() {
            return;
        }
        let Some(head) = self.sh.head() else { return };
        let (ok, refused): (Vec<MissItem>, Vec<MissItem>) = {
            let reg = self.c2.reg.read().unwrap();
            let vol = &self.sh.volatile;
            let st = &self.c2.stats;
            items.into_iter().filter(|m| needs(&head.snap, m)).partition(|m| match m {
                MissItem::Account(a) | MissItem::Slot(a, _) if vol.is_whole(a) => false, // outside contract: never kept
                MissItem::Account(_) => true, // basics + code
                // A V4 PoolManager's coin balance: never held (checks use
                // the proven bound, copy2/checkview.rs).
                MissItem::Slot(a, s) if reg.pm_bound && reg.is_pm_balance(*a, *s) => {
                    inc(&st.fill_refused_pm_balance);
                    false
                }
                // A PoolManager slot that isn't a base slot of one of our V4
                // pools: another pool's data (or beyond our walk). The fill
                // used to put it into the copy as if followed by ALL our V4
                // pools: a stale value as soon as that pool traded.
                MissItem::Slot(a, s) if reg.pm_bound && reg.is_pm(a) && !reg.is_pm_base_slot(*a, *s) => {
                    inc(&st.fill_refused_pm_slot);
                    false
                }
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
        // (coin, slot, pool, node value at k): busy pools' coin balances.
        let mut carried: Vec<(Address, U256, Address, U256)> = Vec::new();
        {
            let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
            for (it, f) in out.items {
                let f = match f {
                    Ok(f) => f,
                    Err(ItemErr::BlockUnavailable) => {
                        again.push(it);
                        continue;
                    }
                    Err(_) => continue,
                };
                if let Fetched::Slot(a, s, v) = &f {
                    // A followed pool's coin balance (live Oct 22: WETH/USDG
                    // 0x52e65b17 trades every few blocks, so "nothing touched
                    // it since k" almost never held and its balance stayed
                    // missing): the node value at k plus the kept Transfers
                    // since k, exactly (fill_balance_carried).
                    let bal_of = if reg.by_addr.contains_key(a) || reg.owner_of.contains_key(a) { None } else { Self::gate_of(&reg, *a, *s) };
                    if let Some(g) = bal_of {
                        let keys = reg.pools_of(&g);
                        if !keys.iter().all(|pk| reg.pools.get(pk).is_some_and(|e| e.state == PoolState::Ready && e.ready_since <= k)) {
                            continue; // refused: the pool isn't followed right now
                        }
                        carried.push((*a, *s, g, *v));
                        continue;
                    }
                    if self.touched_slot.get(&(*a, *s)).is_some_and(|b| *b > k) {
                        again.push(it);
                        continue;
                    }
                    if let Some(g) = Self::gate_of(&reg, *a, *s) {
                        let keys = reg.pools_of(&g);
                        let all_ok = keys.iter().all(|pk| reg.pools.get(pk).is_some_and(|e| e.state == PoolState::Ready && e.ready_since <= k));
                        // A slot of ONE ordinary pool (or its own account)
                        // that has been ready since k: every change its
                        // events made after k is in the versions' changes
                        // (a replay can't write a slot it doesn't hold
                        // without asking for it first, which takes the pool
                        // out of ready), so the value is carried forward
                        // exactly; no need to ask again because the pool
                        // traded. Coin balances and the shared V4
                        // PoolManager keep the strict rule.
                        let own_slot = (reg.by_addr.get(a).is_some_and(|v| v.len() == 1 && v[0].1.is_none()) || reg.owner_of.contains_key(a)) && keys.len() == 1;
                        let quiet = own_slot || self.touched_addr.get(&g).is_none_or(|b| *b <= k);
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
                        }
                    }
                }
                good.push(f);
            }
        }
        for (c, sl, g, v) in carried {
            if self.fill_balance_carried(c, sl, g, k, v) {
                inc(&self.c2.stats.fill_balance_carried);
            } else {
                again.push(MissItem::Slot(c, sl));
            }
        }
        if !again.is_empty() {
            // Asked again in ~1 s (the node trails the copy by a few blocks;
            // asking at once just repeats the same answer).
            add(&self.c2.stats.fill_retry, again.len() as u64);
            let at = Instant::now() + Duration::from_millis(1000);
            self.fill_later.extend(again.into_iter().map(|m| (at, m)));
        }
        if good.is_empty() {
            return;
        }
        add(&self.c2.stats.fill_items, good.len() as u64);
        {
            let mut p = crate::timing::TimedWrite::new(&self.sh.published);
            reconcile(&mut p.versions, k, &good);
        }
        self.sh.notify();
    }

    /// A busy pool's coin balance read from the node at block `k` (value
    /// `v`): in a kept version j (block >= k) it is v plus / minus the
    /// Transfers of that coin to / from the pool in the kept reports of
    /// blocks k+1..=j (a followed balance changes ONLY by its Transfers;
    /// replays never write coin storage). Written into each version that
    /// doesn't hold the balance. Needs the copy at or past k and every
    /// report since k (the buffer reaches back past k with no hole). A
    /// Transfer for a block after k that is still on the way (late report,
    /// settle) is added when it comes: coin_base = k.
    /// false = not possible now (asked again later).
    fn fill_balance_carried(&mut self, coin: Address, slot: U256, holder: Address, k: u64, v: U256) -> bool {
        let Some(head) = self.sh.head() else { return false };
        if head.block < k {
            return false; // the node is ahead of the copy: a value from the future
        }
        let first_after = {
            let p = self.sh.published.read().unwrap();
            if p.versions.iter().any(|x| x.block > k && x.restart) {
                return false;
            }
            if p.versions.front().is_none_or(|x| x.block > k) {
                return false; // the versions since k are no longer all kept
            }
            p.versions.iter().find(|x| x.block > k).map(|x| x.block)
        };
        if let Some(fa) = first_after {
            if self.buf.front().is_none_or(|b| b.block > fa) {
                return false; // reports since k no longer all kept (or a hole)
            }
        }
        let mut deltas: Vec<(u64, bool, U256)> = Vec::new();
        for b in self.buf.iter().filter(|b| b.block > k) {
            for l in b.logs.iter() {
                let Some((c, from, to, amt)) = coin_transfer(l) else { continue };
                if c != coin || from == to {
                    continue;
                }
                if from == holder {
                    deltas.push((b.block, true, amt));
                }
                if to == holder {
                    deltas.push((b.block, false, amt));
                }
            }
        }
        let mut p = crate::timing::TimedWrite::new(&self.sh.published);
        let mut vals: Vec<(usize, U256)> = Vec::new();
        for (i, ver) in p.versions.iter().enumerate() {
            if ver.block < k {
                continue;
            }
            let (mut add, mut sub) = (U256::ZERO, U256::ZERO);
            for (b, is_from, amt) in &deltas {
                if *b > ver.block {
                    continue;
                }
                let t = if *is_from { &mut sub } else { &mut add };
                let Some(x) = t.checked_add(*amt) else { return false };
                *t = x;
            }
            // Below zero: the node value and the reports don't fit
            // together (never a guess: asked again).
            let Some(x) = v.checked_add(add).and_then(|y| y.checked_sub(sub)) else { return false };
            vals.push((i, x));
        }
        // Every version from k on gets exactly this value; older versions
        // (values from an older node read) forget it. Then every value of
        // this balance the copy holds descends from the read at k, which is
        // what coin_base says (a late Transfer is judged against it).
        let mut differ = 0u64;
        for i in 0..p.versions.len() {
            let ver = p.versions[i].clone();
            let want = vals.iter().find(|x| x.0 == i).map(|x| x.1);
            let have = ver.snap.storage(coin, slot);
            let mut s = (*ver.snap).clone();
            match (want, have) {
                (Some(x), Lookup::Known(h)) if h == x => continue,
                (Some(x), h) => {
                    if matches!(h, Lookup::Known(_)) {
                        differ += 1;
                    }
                    s.apply_fact(&Fact::Slot(coin, slot, x));
                }
                (None, Lookup::Known(_)) => forget_slot(&mut s, coin, slot),
                (None, Lookup::Missing) => continue,
            }
            let txs = ver.txs.iter().map(|t| {
                let mut ts = (*t.snap).clone();
                forget_slot(&mut ts, coin, slot);
                crate::feed::replay::TxSnap { hash: t.hash, snap: Arc::new(ts), diff: t.diff.clone() }
            }).collect();
            p.versions[i] = Arc::new(Version { snap: Arc::new(s), txs, ..(*ver).clone() });
        }
        drop(p);
        if differ > 0 {
            // A version held another value (it went missing in a newer one):
            // the node read wins (it is exact by construction).
            add(&self.c2.stats.coin_balance_disagree, differ);
        }
        let cp = self.coin_pos.entry((coin, holder)).or_insert((0, 0, 0));
        *cp = (*cp).max((k, END, END));
        self.coin_base.insert((coin, holder), k);
        add(&self.c2.stats.fill_items, 1);
        self.sh.notify();
        true
    }

    /// Values the head holds that nothing follows: storage of accounts
    /// that are not a pool, a pool's own account, a V4 PoolManager or an
    /// outside contract; for coins, every slot except our pools' balances.
    fn unfollowed_items(&self, head: &Snapshot) -> Vec<MissItem> {
        let reg = self.c2.reg.read().unwrap();
        let mut out = Vec::new();
        // Our own made-up accounts (Algebra replay notes): not on the chain.
        let notes: HashSet<Address> = reg.pools.values().map(|e| super::replay::notes_address(e.pool.address)).collect();
        for (a, acct) in head.accounts.iter() {
            if reg.by_addr.contains_key(a) || reg.owner_of.contains_key(a) || reg.is_pm(a) || self.sh.volatile.is_whole(a) || notes.contains(a) {
                continue;
            }
            let ours: HashSet<U256> = reg.holders.get(a).map(|h| h.iter().filter_map(|x| reg.bal_slot(*a, *x)).collect()).unwrap_or_default();
            for (sl, _) in acct.storage.iter() {
                if !ours.contains(sl) {
                    out.push(MissItem::Slot(*a, *sl));
                }
            }
        }
        out.sort_by(|x, y| format!("{x:?}").cmp(&format!("{y:?}")));
        out
    }

    /// Every ARBSIM_COPY2_VERIFY_S: re-read (one fetch job, at the node's
    /// block) the values nothing follows. They are kept because they almost
    /// never change (coin settings, a compliance contract's lists), but
    /// nothing tells the copy when they do; this bounds how long a changed
    /// one can be used and shows whether it happens at all.
    fn dispatch_verify(&mut self) {
        if self.cfg.verify_every_s == 0 || self.last_verify.elapsed() < Duration::from_secs(self.cfg.verify_every_s) {
            return;
        }
        if self.loaders.is_none() || self.refusing_now() || self.jobs.values().any(|j| matches!(j, JobFor::Verify)) {
            return;
        }
        self.last_verify = Instant::now();
        let Some(head) = self.sh.head() else { return };
        let mut items = self.unfollowed_items(&head.snap);
        self.c2.stats.unfollowed_held.store(items.len() as u64, Ordering::Relaxed);
        if items.is_empty() {
            return;
        }
        // A round covers at most verify_max values, rotating through them.
        let n = items.len();
        let start = (self.c2.stats.verify_rounds.load(Ordering::Relaxed) as usize * self.cfg.verify_max) % n;
        items.rotate_left(start);
        items.truncate(self.cfg.verify_max);
        inc(&self.c2.stats.verify_rounds);
        add(&self.c2.stats.verify_items, items.len() as u64);
        let id = self.new_job(JobFor::Verify);
        self.loaders.as_ref().unwrap().send(Job::Fetch { id, block: head.block, exact: false, bulk: true, items, calls: vec![] });
    }

    /// Verify answers (values at block k): a held value that differs from
    /// the chain's is forgotten in every kept version (we can't tell since
    /// when it was wrong), then the chain's value at k is put in from k on
    /// (exactly what a fill does: the same as forgetting it and the next
    /// check reading it again, without that check being unknown), counted
    /// and reported (status unfollowedChanged; log for the first 3 changes
    /// of each value). E.g. WETH's totalSupply (slot 0x35) moves with every
    /// wrap / unwrap on the chain and is refreshed each round; a stock
    /// coin's settings should never show up here.
    fn on_verify(&mut self, k: u64, res: Result<FetchOut, crate::node::NodeErr>) {
        let Ok(out) = res else { return };
        let mut changed: Vec<(Address, U256, U256, U256)> = Vec::new();
        {
            let p = self.sh.published.read().unwrap();
            let Some(v) = p.versions.iter().rev().find(|v| v.block <= k) else { return };
            for (_, f) in out.items {
                let Ok(Fetched::Slot(a, sl, val)) = f else { continue };
                if let Lookup::Known(h) = v.snap.storage(a, sl) {
                    if h != val {
                        changed.push((a, sl, h, val));
                    }
                }
            }
        }
        if changed.is_empty() {
            return;
        }
        add(&self.c2.stats.unfollowed_changed, changed.len() as u64);
        for (a, sl, old, new) in &changed {
            let n = {
                let mut m = self.c2.unfollowed_changes.lock().unwrap();
                if m.len() < 1000 || m.contains_key(&(*a, *sl)) {
                    let e = m.entry((*a, *sl)).or_default();
                    *e += 1;
                    *e
                } else {
                    u64::MAX
                }
            };
            if n <= 3 {
                eprintln!(
                    "[arbsim] copy2: a value nothing follows CHANGED on the chain: account {a} slot {sl:#x} held {old:#x}, chain {new:#x} at block {k}; refreshed (status unfollowedChanged counts further changes)"
                );
            }
        }
        let fresh: Vec<Fetched> = changed.iter().map(|(a, sl, _, v)| Fetched::Slot(*a, *sl, *v)).collect();
        let mut p = crate::timing::TimedWrite::new(&self.sh.published);
        rewrite_from(&mut p.versions, 0, |s| {
            for (a, sl, _, _) in &changed {
                forget_slot(s, *a, *sl);
            }
        });
        reconcile(&mut p.versions, k, &fresh);
        drop(p);
        self.sh.notify();
    }

    // ---- warm restart (copy2/persist.rs) ----
    //
    // Plain English:
    //   SAVE: every ARBSIM_COPY2_SAVE_S and at a stop signal, the ready
    //   pools' state is handed to the saver thread (persist.rs). Here only a
    //   cheap copy is made (the head snapshot is shared, the pool list
    //   cloned): measured ~ms for 650 pools (tests/copy2_resume_anvil.rs).
    //   START: the saved copy becomes the copy at its block S, its pools
    //   READY, but nothing is answered yet: blocks wait until the copy has
    //   caught up. CATCH-UP: when the bot's first new block B arrives, every
    //   report of our pools in blocks S-63..B-1 is read from the node's logs
    //   (copy2/loader.rs catch_up: free node first, paid fallback, ranges of
    //   ARBSIM_COPY2_RESUME_RANGE, each range's completeness proven by its
    //   last block's header in the same request), with each block's time and
    //   parent-chain block. Reports for blocks <= S the copy didn't have are
    //   late reports (on_late, exact as always); blocks S+1..B-1 are applied
    //   one by one through the normal block path (process), so every pool
    //   moves exactly as if the bot had sent them. A pool whose report can't
    //   be applied exactly goes unsure and reloads, as always. Then (only
    //   after a restart) every held value nothing follows (coin settings,
    //   ...) is read again at the new block: changed ones are replaced.
    //   Only then do the waiting blocks go on and checks get answers.
    //   GAPS WHILE RUNNING (the bot restarted, an outage it could not fill, a
    //   lost message): the same catch-up from the copy's newest block instead
    //   of reloading every pool.
    //   Too big a gap (ARBSIM_COPY2_RESUME_MAX_BLOCKS), no node, or no
    //   complete answer within ARBSIM_COPY2_RESUME_TIMEOUT_S: the old way
    //   (normal load after a restart, reload of every pool after a gap).

    fn set_resume(&self, k: &str, v: Value) {
        self.c2.resume.lock().unwrap().insert(k.into(), v);
    }

    /// Read the saved copy at start (see above). A missing / unusable file
    /// just means the normal load.
    fn try_restore(&mut self, path: &str) {
        let t0 = Instant::now();
        if !Path::new(path).exists() {
            eprintln!("[arbsim] copy2: no saved copy at {path}: loading every pool from the node");
            self.set_resume("state", json!("no saved copy: normal load"));
            return;
        }
        match persist::load(path, self.sh.volatile.clone()) {
            Ok(st) => self.restore(st, t0),
            Err(e) => {
                inc(&self.c2.stats.resume_refused);
                eprintln!("[arbsim] copy2: saved copy {path} not used ({e}): loading every pool from the node");
                self.set_resume("state", json!(format!("saved copy not used ({e}): normal load")));
            }
        }
    }

    /// Take a saved copy over: the copy at its block, its pools ready,
    /// waiting for the catch-up.
    pub fn restore(&mut self, st: persist::State, t0: Instant) {
        let block = st.block;
        for a in &st.volatile_whole {
            self.sh.volatile.add_whole(*a);
        }
        for a in &st.volatile_balance {
            self.sh.volatile.add_balance(*a);
        }
        let snap = Snapshot { volatile: self.sh.volatile.clone(), pos: StatePosition { base_block: block, after_seq: None }, ..(*st.snap).clone() };
        let (n_acc, n_slots, _) = snap.counts();
        {
            let mut p = crate::timing::TimedWrite::new(&self.sh.published);
            p.versions.clear();
            p.versions.push_back(Arc::new(Version {
                seq: block.saturating_sub(self.sh.cfg.l2_offset),
                block,
                snap: Arc::new(snap),
                // No details: nothing is answered AT the saved block (it may
                // still lack late reports; the catch-up reads them again).
                ctx: None,
                txs: vec![],
                diff: Arc::new(StateDiff::default()),
                restart: true,
                block_hash: None,
                applied: Instant::now(),
            }));
            p.stalled = None;
        }
        self.last_block = Some(block);
        self.last_msg_block = Some(block);
        self.c2.last_block.store(block, Ordering::Relaxed);
        self.c2.head_block.store(block, Ordering::Relaxed);
        if let Some((ts, l1, bf)) = st.ctx {
            self.last_ctx = Some(BlockCtx {
                l1_block_number: l1,
                l2_block_number: Some(block),
                timestamp: ts,
                basefee: bf,
                coinbase: arb::arbos::BATCH_POSTER_ADDRESS,
                gas_limit: arb::NITRO_BLOCK_GAS_LIMIT,
                prevrandao: arb::NITRO_PREVRANDAO,
            });
            if bf > 0 {
                self.basefee = bf;
            }
        }
        let n_pools = st.pools.len();
        {
            let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
            for (c, l) in &st.layouts {
                reg.layouts.insert(*c, Some(*l));
            }
            for (k, s) in &st.pair_slots {
                reg.pair_slots.insert(*k, *s);
            }
            for (e, lp) in st.pools {
                let k = key_of(&e.pool);
                if let Some(lp) = lp {
                    self.last_pos.insert(k, lp);
                }
                reg.pools.insert(k, e);
            }
            reg.rebuild_index();
        }
        self.per_pool_coins.extend(st.per_pool_coins);
        self.coin_ok.extend(st.coin_ok);
        for (k, pos, base) in st.coins {
            if let Some(p) = pos {
                self.coin_pos.insert(k, p);
            }
            if let Some(b) = base {
                self.coin_base.insert(k, b);
            }
        }
        for (b, rctx, logs) in st.buf {
            if !logs.is_empty() {
                let touched = self.pools_touched(&logs);
                self.recent.push_back((b, log_ids(&logs), touched));
            }
            self.received.insert(b);
            self.buf.push_back(BufBlock { block: b, rctx, logs });
        }
        self.received.insert(block);
        let from = self.overlap_from(block);
        add(&self.c2.stats.resume_pools, n_pools as u64);
        let age_s = persist::now_ms().saturating_sub(st.saved_ms) as f64 / 1000.0;
        eprintln!(
            "[arbsim] copy2: WARM RESTART from the saved copy: {n_pools} ready pool(s) at block {block} (saved {age_s:.0} s ago; {n_acc} accounts, {n_slots} values; read in {} ms). Catching up from the node's logs when the bot's first block arrives.",
            t0.elapsed().as_millis()
        );
        self.set_resume("savedBlock", json!(block));
        self.set_resume("savedPools", json!(n_pools));
        self.set_resume("savedAgeS", json!(age_s.round()));
        self.set_resume("state", json!(format!("restored {n_pools} pools at block {block}: waiting for the bot's first block to catch up")));
        self.catchup = Some(CatchUp {
            restored: true,
            applied: block,
            from,
            target: None,
            since: None,
            job: None,
            to: block,
            tries: 0,
            retry_at: Instant::now(),
            caught: false,
            verify_job: None,
            why: "restart".into(),
            started: Instant::now(),
            req0: self.c2.node_requests.load(Ordering::Relaxed),
        });
    }

    /// First block whose reports a catch-up from `applied` reads again: the
    /// overlap, but not before the kept reports (they tell which reports
    /// the copy already had).
    fn overlap_from(&self, applied: u64) -> u64 {
        let want = applied.saturating_sub(self.cfg.resume_overlap.saturating_sub(1));
        match self.buf.front() {
            Some(b) => want.max(b.block).min(applied + 1),
            None => applied + 1,
        }
    }

    /// The saved copy can't be brought forward: forget it, every pool loads
    /// normally (as if there had been no file).
    fn abandon_restore(&mut self) {
        {
            let mut p = crate::timing::TimedWrite::new(&self.sh.published);
            p.versions.clear();
        }
        self.last_block = None;
        self.last_msg_block = None;
        self.c2.last_block.store(0, Ordering::Relaxed);
        self.c2.head_block.store(0, Ordering::Relaxed);
        self.buf.clear();
        self.recent.clear();
        self.received.clear();
        self.last_pos.clear();
        self.coin_pos.clear();
        self.coin_base.clear();
        self.partials.clear();
        self.gap_filled_until = None;
        let n = {
            let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
            let now = Instant::now();
            for e in reg.pools.values_mut() {
                e.state = PoolState::Loading;
                e.reason = "loading: waiting for its turn".into();
                e.retry_at = now;
                e.busy = false;
                e.gen += 1;
                e.ready_since = 0;
                e.base_block = 0;
                e.ever_ready = false;
                e.walk = None;
                e.walked = Vec::new();
                e.far_zero = None;
                e.pending_from = None;
            }
            reg.pools.len()
        };
        if n > 0 {
            self.outcomes = Outcomes::default();
            self.last_progress = Instant::now();
            self.round = Some((Instant::now(), self.c2.node_requests.load(Ordering::Relaxed), n));
            *self.c2.load_round.lock().unwrap() = LoadRound { pools: n, ..Default::default() };
        }
    }

    /// The copy's state for a save (cheap: the head snapshot is shared, the
    /// ready pools' bookkeeping cloned). None = nothing to save now (a
    /// catch-up is running: the file from before stays, or no pool ready).
    pub fn save_state(&self) -> Option<persist::State> {
        if self.catchup.is_some() {
            return None;
        }
        let head = self.sh.head()?;
        let block = head.block;
        let overlap_from = block.saturating_sub(self.cfg.resume_overlap.saturating_sub(1));
        let reg = self.c2.reg.read().unwrap();
        let mut pools = Vec::new();
        let mut strip: HashSet<(Address, U256)> = HashSet::new();
        let mut saved_at: HashSet<Address> = HashSet::new();
        let mut left_out: Vec<&PoolEntry> = Vec::new();
        for (k, e) in reg.pools.iter() {
            // Ready, nothing working on it, and any report it may still lack
            // is inside the overlap the catch-up reads again.
            let ok = e.state == PoolState::Ready
                && !e.busy
                && !self.partials.contains_key(k)
                && e.ready_since <= block
                && e.pending_from.is_none_or(|b| b >= overlap_from);
            if ok {
                pools.push((e.clone(), self.last_pos.get(k).copied()));
                saved_at.insert(e.pool.address);
            } else {
                left_out.push(e);
            }
        }
        if pools.is_empty() {
            return None;
        }
        // Values of pools left out are not saved (they load normally).
        for e in left_out {
            strip.extend(e.items.iter().copied());
            strip.extend(e.walked.iter().copied());
            if !saved_at.contains(&e.pool.address) {
                for c in [e.pool.token0, e.pool.token1] {
                    if let Some(sl) = reg.bal_slot(c, e.pool.address) {
                        strip.insert((c, sl));
                    }
                }
            }
        }
        let layouts: Vec<(Address, BalanceLayout)> = reg.layouts.iter().filter_map(|(c, l)| l.map(|l| (*c, l))).collect();
        let pair_slots: Vec<((Address, Address), U256)> = reg.pair_slots.iter().map(|(k, v)| (*k, *v)).collect();
        drop(reg);
        let mut coin_keys: HashSet<(Address, Address)> = self.coin_pos.keys().copied().collect();
        coin_keys.extend(self.coin_base.keys().copied());
        let coins = coin_keys
            .into_iter()
            .filter(|(_, h)| saved_at.contains(h))
            .map(|k| (k, self.coin_pos.get(&k).copied(), self.coin_base.get(&k).copied()))
            .collect();
        let ctx = head.ctx.as_ref().or(self.last_ctx.as_ref()).map(|c| (c.timestamp, c.l1_block_number, c.basefee));
        Some(persist::State {
            block,
            ctx,
            saved_ms: persist::now_ms(),
            snap: head.snap.clone(),
            strip,
            volatile_whole: self.sh.volatile.whole_list(),
            volatile_balance: self.sh.volatile.balance_list(),
            pools,
            layouts,
            pair_slots,
            per_pool_coins: self.per_pool_coins.iter().copied().collect(),
            coin_ok: self.coin_ok.iter().copied().collect(),
            coins,
            buf: self.buf.iter().filter(|b| b.block >= overlap_from).map(|b| (b.block, b.rctx, b.logs.clone())).collect(),
        })
    }

    /// Every ARBSIM_COPY2_SAVE_S: hand the state to the saver thread.
    fn maybe_save(&mut self) {
        let Some(saver) = &self.saver else { return };
        if self.last_save.elapsed() < Duration::from_secs(self.cfg.save_every_s) {
            return;
        }
        self.last_save = Instant::now();
        if let Some(Err(e)) = saver.last.lock().unwrap().take() {
            inc(&self.c2.stats.save_errors);
            self.set_resume("lastSaveError", json!(e));
        }
        let t0 = Instant::now();
        let Some(st) = self.save_state() else { return };
        let block = st.block;
        let us = t0.elapsed().as_micros() as u64;
        self.c2.stats.save_prep_us_max.fetch_max(us, Ordering::Relaxed);
        if saver.offer(st) {
            inc(&self.c2.stats.saves);
            self.set_resume("lastSave", json!({ "block": block, "prepMs": us as f64 / 1000.0, "atMs": persist::now_ms() }));
        } else {
            inc(&self.c2.stats.saves_skipped);
        }
    }

    /// Save now and wait for the file (stop signal; tests).
    pub fn save_now(&mut self) -> Result<persist::SaveReport, String> {
        let Some(saver) = &self.saver else { return Err("no state file (ARBSIM_COPY2_STATE_FILE)".into()) };
        let t0 = Instant::now();
        let Some(st) = self.save_state() else {
            let why = if self.catchup.is_some() { "catching up: the saved copy from before stays" } else { "no ready pool" };
            eprintln!("[arbsim] copy2: not saved ({why})");
            return Err(why.into());
        };
        let prep = t0.elapsed();
        let r = saver.save_and_wait(st, Duration::from_secs(20));
        match &r {
            Ok(rep) => {
                inc(&self.c2.stats.saves);
                eprintln!(
                    "[arbsim] copy2: saved the copy for a warm restart: {} pools, {} values, {:.1} MB at block {} (prepared in {} ms, written in {:.0} ms)",
                    rep.pools,
                    rep.slots,
                    rep.bytes as f64 / 1e6,
                    rep.block,
                    prep.as_millis(),
                    rep.write_ms
                );
            }
            Err(e) => {
                inc(&self.c2.stats.save_errors);
                eprintln!("[arbsim] copy2: saving the copy failed: {e}");
            }
        }
        r
    }

    /// A gap before block `next` while running: catch it up from the
    /// node's logs instead of reloading every pool (false = not possible:
    /// the caller reloads as before).
    fn start_gap_catchup(&mut self, next: u64, why: &str) -> bool {
        if self.cfg.resume_max_blocks == 0 || self.loaders.is_none() || self.catchup.is_some() {
            return false;
        }
        let Some(last) = self.last_block else { return false };
        let to = next.saturating_sub(1).max(last);
        if to - last > self.cfg.resume_max_blocks {
            eprintln!(
                "[arbsim] copy2: gap of {} blocks is more than ARBSIM_COPY2_RESUME_MAX_BLOCKS {}: reloading instead of catching up",
                to - last,
                self.cfg.resume_max_blocks
            );
            return false;
        }
        inc(&self.c2.stats.catchups);
        self.catchup = Some(CatchUp {
            restored: false,
            applied: last,
            from: self.overlap_from(last),
            target: Some(to),
            since: None,
            job: None,
            to,
            tries: 0,
            retry_at: Instant::now(),
            caught: false,
            verify_job: None,
            why: why.to_string(),
            started: Instant::now(),
            req0: self.c2.node_requests.load(Ordering::Relaxed),
        });
        self.set_resume("state", json!(format!("catching up blocks {}..{to} ({why})", last + 1)));
        true
    }

    /// Send the catch-up read (or stage 2) when due; give up when too late.
    fn dispatch_catchup(&mut self) {
        let Some(cu) = &self.catchup else { return };
        if cu.job.is_some() || cu.verify_job.is_some() {
            return;
        }
        if cu.since.is_some_and(|t| t.elapsed() > Duration::from_secs(self.cfg.resume_timeout_s)) {
            let why = format!("no complete answer from the node within {} s (ARBSIM_COPY2_RESUME_TIMEOUT_S)", self.cfg.resume_timeout_s);
            self.catchup_failed(&why);
            return;
        }
        if cu.retry_at > Instant::now() {
            return;
        }
        if cu.caught {
            self.dispatch_resume_verify();
            return;
        }
        let applied = cu.applied;
        // Up to the block before the bot's first new one.
        let to = match cu.target {
            Some(t) => t,
            None => match self.pending.range(applied + 1..).next() {
                Some((b, _)) => b - 1,
                None => return, // waiting for the bot
            },
        };
        if to - applied > self.cfg.resume_max_blocks {
            let why = format!("{} blocks to catch up, more than ARBSIM_COPY2_RESUME_MAX_BLOCKS {}", to - applied, self.cfg.resume_max_blocks);
            self.catchup_failed(&why);
            return;
        }
        if self.loaders.is_none() {
            self.catchup_failed("no node configured");
            return;
        }
        let filters = {
            let reg = self.c2.reg.read().unwrap();
            let keys: HashSet<PoolKey> = reg.pools.keys().copied().collect();
            settle_filters(&reg, &keys)
        };
        let from = cu.from;
        let id = self.new_job(JobFor::CatchUp);
        let cu = self.catchup.as_mut().unwrap();
        cu.job = Some(id);
        cu.to = to;
        cu.since.get_or_insert_with(Instant::now);
        let state = format!("reading the reports of blocks {from}..{to} from the node ({})", cu.why);
        self.set_resume("state", json!(state));
        if filters.is_empty() {
            // No pool to read reports for: nothing to catch up.
            self.jobs.remove(&id);
            self.on_catchup(id, Ok(CatchUpOut::default()));
            return;
        }
        self.loaders.as_ref().unwrap().send(Job::CatchUp { id, from, to, filters, range: self.cfg.resume_range });
    }

    /// The reports of the catch-up range came back: apply them (see above).
    fn on_catchup(&mut self, id: u64, res: Result<CatchUpOut, crate::node::NodeErr>) {
        let Some(cu) = self.catchup.as_mut().filter(|c| c.job == Some(id)) else { return };
        cu.job = None;
        let out = match res {
            Ok(o) => o,
            Err(e) => {
                let m = e.to_string();
                cu.tries += 1;
                let not_yet = m.contains(NOT_YET) || m.contains(crate::node::SPEED_LIMIT);
                cu.retry_at = Instant::now() + if not_yet { Duration::from_millis(300) } else { backoff(cu.tries) };
                let tries = cu.tries;
                if !not_yet {
                    self.note_node_error(&format!("catch-up: {m}"));
                    if tries <= 3 {
                        eprintln!("[arbsim] copy2: catch-up read failed ({m}); trying again");
                    }
                }
                return;
            }
        };
        let (from, to, applied, restored) = (cu.from, cu.to, cu.applied, cu.restored);
        let t0 = Instant::now();
        // Our pools' reports only (the filters can match more), by block.
        let mut logs: Vec<PoolLog> = Vec::new();
        for v in &out.logs {
            let Some(b) = num(v.get("blockNumber")) else { continue };
            if b < from || b > to {
                continue;
            }
            if let Ok(l) = parse_log(v, b) {
                if !l.removed {
                    logs.push(l);
                }
            }
        }
        logs.retain(|l| {
            !self.pool_keys_for(l).is_empty()
                || coin_transfer(l).is_some_and(|(c, f, t, _)| {
                    let reg = self.c2.reg.read().unwrap();
                    reg.holders.get(&c).is_some_and(|h| h.contains(&f) || h.contains(&t))
                })
        });
        let n_logs = logs.len();
        let groups = persist::by_block(logs);
        // 1. Blocks the copy has: reports it never got are late reports.
        let mut late = 0usize;
        for (b, ls) in groups.range(..=applied) {
            let time = out.blocks.get(b).map(|(ts, l1)| (*ts, Some(*l1)));
            late += self.on_late_at(*b, ls.clone(), time);
        }
        // 2. Blocks after it: applied one by one, like the bot's messages.
        let mut blocks = 0u64;
        self.repairing = true;
        for (b, ls) in groups.range(applied + 1..) {
            let Some(&(ts, l1)) = out.blocks.get(b) else {
                // Never without its time (catch_up gives every block's).
                self.repairing = false;
                self.catchup_failed(&format!("no time for block {b}"));
                return;
            };
            blocks += 1;
            self.process(BlockMsg { block: *b, timestamp: ts, l1_block: Some(l1), base_fee: None, prev_block: None, logs: ls.clone(), tick: false, gap_reason: None, bloom: None });
        }
        self.repairing = false;
        // Every block up to `to` is in the copy now (quiet ones had nothing).
        for b in (applied + 1).max(to.saturating_sub(4095))..=to {
            self.received.insert(b);
        }
        while self.received.len() > 4096 {
            self.received.pop_first();
        }
        if to > self.last_msg_block.unwrap_or(0) {
            self.last_msg_block = Some(to);
        }
        self.gap_filled_until = Some(to);
        add(&self.c2.stats.catchup_blocks, blocks);
        add(&self.c2.stats.catchup_logs, n_logs as u64);
        add(&self.c2.stats.catchup_late_found, late as u64);
        let (ready, unsure, loading) = {
            let reg = self.c2.reg.read().unwrap();
            let (l, r, u) = reg.counts();
            (r, u, l)
        };
        let cu = self.catchup.as_mut().unwrap();
        cu.caught = true;
        let secs = cu.started.elapsed().as_secs_f64();
        let why = cu.why.clone();
        let reqs = self.c2.node_requests.load(Ordering::Relaxed) - cu.req0;
        eprintln!(
            "[arbsim] copy2: caught up blocks {}..{to} from the node's logs ({}): {n_logs} reports in {blocks} blocks applied in {} ms, {late} late report(s) for older blocks; {} requests ({} public, {} paid, {} headers{}); now {ready} ready, {loading} loading, {unsure} unsure; {secs:.1} s since start",
            applied + 1,
            why,
            t0.elapsed().as_millis(),
            reqs,
            out.public_requests,
            out.paid_requests,
            out.headers,
            if out.splits > 0 { format!(", {} ranges split", out.splits) } else { String::new() },
        );
        self.set_resume(
            "lastCatchUp",
            json!({ "why": why, "fromBlock": applied + 1, "toBlock": to, "blocks": blocks, "reports": n_logs, "lateReports": late,
                    "requests": reqs, "publicRequests": out.public_requests, "paidRequests": out.paid_requests, "headers": out.headers,
                    "seconds": (secs * 10.0).round() / 10.0, "ready": ready, "unsure": unsure, "loading": loading }),
        );
        if restored {
            self.dispatch_resume_verify();
        } else {
            self.finish_catchup();
        }
    }

    /// Stage 2 after a restart: re-read (exactly at the copy's block) every
    /// held value nothing follows; changed ones are replaced, unreadable
    /// ones forgotten.
    fn dispatch_resume_verify(&mut self) {
        let Some(head) = self.sh.head() else {
            self.finish_catchup();
            return;
        };
        let items = self.unfollowed_items(&head.snap);
        if items.is_empty() || self.loaders.is_none() {
            self.finish_catchup();
            return;
        }
        let n = items.len();
        let id = self.new_job(JobFor::ResumeVerify);
        if let Some(cu) = self.catchup.as_mut() {
            cu.verify_job = Some(id);
        }
        self.set_resume("state", json!(format!("re-reading {n} held value(s) nothing follows at block {}", head.block)));
        self.loaders.as_ref().unwrap().send(Job::Fetch { id, block: head.block, exact: true, bulk: false, items, calls: vec![] });
    }

    fn on_resume_verify(&mut self, id: u64, k: u64, res: Result<FetchOut, crate::node::NodeErr>) {
        let Some(cu) = self.catchup.as_mut().filter(|c| c.verify_job == Some(id)) else { return };
        cu.verify_job = None;
        let out = match res {
            Ok(o) if !o.items.iter().any(|(_, r)| matches!(r, Err(ItemErr::BlockUnavailable))) => o,
            other => {
                cu.tries += 1;
                let not_yet = match &other {
                    Ok(_) => true,
                    Err(e) => e.to_string().contains(NOT_YET) || e.to_string().contains(crate::node::SPEED_LIMIT),
                };
                cu.retry_at = Instant::now() + if not_yet { Duration::from_millis(300) } else { backoff(cu.tries) };
                return;
            }
        };
        // Values the node could not give: forgotten (read again when needed).
        let unreadable: Vec<(Address, U256)> = out
            .items
            .iter()
            .filter_map(|(it, r)| match (it, r) {
                (MissItem::Slot(a, s), Err(_)) => Some((*a, *s)),
                _ => None,
            })
            .collect();
        let n = out.items.len();
        let before = self.c2.stats.unfollowed_changed.load(Ordering::Relaxed);
        self.on_verify(k, Ok(out));
        let changed = self.c2.stats.unfollowed_changed.load(Ordering::Relaxed) - before;
        if !unreadable.is_empty() {
            let mut p = crate::timing::TimedWrite::new(&self.sh.published);
            rewrite_from(&mut p.versions, 0, |s| {
                for (a, sl) in &unreadable {
                    forget_slot(s, *a, *sl);
                }
            });
        }
        eprintln!(
            "[arbsim] copy2: re-read {n} held value(s) nothing follows at block {k}: {changed} changed while the sidecar was down (replaced), {} unreadable (forgotten)",
            unreadable.len()
        );
        self.finish_catchup();
    }

    /// Catch-up done: the waiting blocks go on, checks get answers again.
    fn finish_catchup(&mut self) {
        let Some(cu) = self.catchup.take() else { return };
        inc(&self.c2.stats.catchups_done);
        self.last_save = Instant::now() - Duration::from_secs(self.cfg.save_every_s.saturating_sub(5));
        let state = format!(
            "{} at {}: caught up from block {} in {:.1} s",
            if cu.restored { "warm restart done" } else { "gap filled" },
            self.last_block.unwrap_or(0),
            cu.applied,
            cu.started.elapsed().as_secs_f64()
        );
        if cu.restored {
            eprintln!("[arbsim] copy2: {state}; answering checks again");
        }
        self.set_resume("state", json!(state));
        self.sh.notify();
    }

    /// Catch-up not possible: after a restart every pool loads normally;
    /// after a gap every pool is reloaded (the old way).
    fn catchup_failed(&mut self, why: &str) {
        let Some(cu) = self.catchup.take() else { return };
        inc(&self.c2.stats.catchups_failed);
        if cu.restored {
            eprintln!("[arbsim] copy2: warm restart not possible ({why}): loading every pool from the node");
            self.set_resume("state", json!(format!("warm restart not possible ({why}): normal load")));
            self.abandon_restore();
        } else {
            eprintln!("[arbsim] copy2: catching up the gap after block {} failed ({why}): reloading every pool", cu.applied);
            self.set_resume("state", json!(format!("gap after block {} not filled ({why}): every pool reloaded", cu.applied)));
            self.reload_all_after_gap(&format!("lost message after block {} (catch-up failed)", cu.applied), cu.applied + 1);
            // The buffer has a hole: no load may carry across it.
            self.buf.clear();
            self.gap_filled_until = None;
        }
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

    /// Load stall guard (live Oct 22 13:34: ~260 pools "loading" for tens of
    /// minutes with 0 node jobs). A pool loading with `busy` set must have
    /// something working for it: a node job, a working copy (waiting for a
    /// retry or carrying), or a load answer queued. One with none of these
    /// for ARBSIM_COPY2_STALL_S is rescheduled at once (busy off, older
    /// answers ignored) and logged with its reason. Pools loading WITHOUT
    /// busy whose wait ended that long ago but were not sent are logged too
    /// (with why loads are held back), once a minute.
    fn stall_watch(&mut self) {
        let every = Duration::from_secs(self.cfg.stall_s.clamp(1, 5));
        if self.cfg.stall_s > 0 && self.last_stall_check.elapsed() < every {
            return;
        }
        self.last_stall_check = Instant::now();
        let limit = Duration::from_secs(self.cfg.stall_s);
        let mut working: HashSet<PoolKey> = self.partials.keys().copied().collect();
        for j in self.jobs.values() {
            match j {
                JobFor::Load { pools, .. } => working.extend(pools.iter().map(|r| r.key)),
                JobFor::Need { key, .. } => {
                    working.insert(*key);
                }
                _ => {}
            }
        }
        working.extend(self.load_q.iter().map(|(r, _, _)| r.key));
        working.extend(self.delayed.iter().map(|d| d.1));
        let now = Instant::now();
        let mut stuck: Vec<(PoolKey, String)> = Vec::new();
        let mut overdue: Vec<String> = Vec::new();
        {
            let reg = self.c2.reg.read().unwrap();
            let mut seen: HashSet<PoolKey> = HashSet::new();
            for (k, e) in &reg.pools {
                if e.state != PoolState::Loading {
                    continue;
                }
                if !e.busy {
                    if now.saturating_duration_since(e.retry_at) >= limit.max(Duration::from_secs(1)) {
                        overdue.push(e.reason.clone());
                    }
                    continue;
                }
                if working.contains(k) {
                    continue;
                }
                seen.insert(*k);
                let since = *self.orphan_since.entry(*k).or_insert(now);
                if now.duration_since(since) >= limit {
                    stuck.push((*k, e.reason.clone()));
                }
            }
            self.orphan_since.retain(|k, _| seen.contains(k));
        }
        for (k, why) in &stuck {
            self.orphan_since.remove(k);
            inc(&self.c2.stats.stall_rescheduled);
            let mut reg = crate::timing::TimedWrite::new(&self.c2.reg);
            if let Some(e) = reg.pools.get_mut(k) {
                e.busy = false;
                e.gen += 1;
                e.retry_at = now;
                e.reason = format!("loading: rescheduled (nothing worked on it for {} s; was: {why})", self.cfg.stall_s);
            }
        }
        let log_due = self.last_stall_log.is_none_or(|t| t.elapsed() >= Duration::from_secs(60));
        if !stuck.is_empty() || (!overdue.is_empty() && log_due) {
            self.last_stall_log = Some(now);
            let reasons = |v: &mut dyn Iterator<Item = &str>| top_reasons(v).iter().map(|x| format!("{} x{}", x["why"].as_str().unwrap_or(""), x["n"])).collect::<Vec<_>>().join("; ");
            if !stuck.is_empty() {
                eprintln!(
                    "[arbsim] copy2 STALL: {} loading pool(s) had no node job, working copy or answer for {} s: rescheduled now (were: {})",
                    stuck.len(),
                    self.cfg.stall_s,
                    reasons(&mut stuck.iter().map(|x| x.1.as_str()))
                );
            }
            if !overdue.is_empty() {
                eprintln!(
                    "[arbsim] copy2 STALL: {} loading pool(s) due for {}+ s but not sent (load jobs {} of {}, node refusing: {}, probes {}, traces {}): {}",
                    overdue.len(),
                    self.cfg.stall_s,
                    self.load_jobs_in_flight(),
                    self.cfg.loaders,
                    self.refusing_now(),
                    self.probing.len(),
                    self.tracing.len(),
                    reasons(&mut overdue.iter().map(|x| x.as_str()))
                );
            }
        }
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
        let Some(h) = self.sh.head() else { return };
        // The caps (ARBSIM_MAX_ACCOUNTS / _SLOTS) count only what may be
        // dropped: our pools / coins / owned accounts are always kept, and
        // with full tick walks they alone hold ~300k slots (more than
        // ARBSIM_MAX_SLOTS 250k), which made every 60 s eviction throw away
        // ALL other accounts (dry run #18 sizing).
        let (mut kept_a, mut kept_s) = (0usize, 0usize);
        for (addr, x) in h.snap.accounts.iter() {
            if keep.contains(addr) {
                kept_a += 1;
                kept_s += x.storage.len();
            }
        }
        let (ma, ms) = (self.sh.cfg.max_accounts + kept_a, self.sh.cfg.max_slots + kept_s);
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


/// Is `item` (an address or a topic) possibly in this logsBloom?
/// (Ethereum's bloom: 3 bits from the item's keccak.)
pub fn in_bloom(bloom: &[u8], item: &[u8]) -> bool {
    if bloom.len() != 256 {
        return true; // can't tell: assume yes
    }
    let h = keccak256(item);
    (0..3).all(|i| {
        let bit = (((h[2 * i] as usize) << 8) | h[2 * i + 1] as usize) & 2047;
        bloom[255 - bit / 8] & (1 << (bit % 8)) != 0
    })
}

/// Coins a pool event says moved to / from the pool in its transaction
/// (their Transfer reports must come in the same message).
fn coins_moved(p: &TrackedPool, l: &PoolLog) -> Vec<Address> {
    let t0 = match l.topics.first() {
        Some(t) => *t,
        None => return vec![],
    };
    let sig = |s: &str| keccak256(s.as_bytes());
    let nz = |i: usize| !super::word(&l.data, i).is_zero();
    let mut v = Vec::new();
    let mut push = |c: Address, moved: bool| {
        if moved && c != Address::ZERO && !v.contains(&c) {
            v.push(c);
        }
    };
    match p.kind {
        PoolKind::V3 | PoolKind::PancakeV3 | PoolKind::Algebra => {
            if t0 == sig("Swap(address,address,int256,int256,uint160,uint128,int24)") || t0 == sig("Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)") {
                push(p.token0, nz(0));
                push(p.token1, nz(1));
            } else if t0 == sig("Mint(address,address,int24,int24,uint128,uint256,uint256)") {
                push(p.token0, nz(2));
                push(p.token1, nz(3));
            } else if t0 == sig("Collect(address,address,int24,int24,uint128,uint128)") {
                push(p.token0, nz(1));
                push(p.token1, nz(2));
            }
        }
        PoolKind::V2 | PoolKind::Solidly => {
            if t0 == sig("Swap(address,uint256,uint256,uint256,uint256,address)") {
                push(p.token0, nz(0) || nz(2));
                push(p.token1, nz(1) || nz(3));
            }
        }
        PoolKind::V4 => {}
    }
    v
}

/// eth_getLogs filters for these pools' reports (their own events, their
/// coins' Transfers to / from them, V4 events of their ids).
fn settle_filters(reg: &Registry, keys: &HashSet<PoolKey>) -> Vec<Value> {
    let mut addrs: Vec<String> = Vec::new();
    let mut pads: Vec<String> = Vec::new();
    let mut coins: Vec<String> = Vec::new();
    let mut v4: BTreeMap<Address, Vec<String>> = BTreeMap::new();
    for k in keys {
        let Some(e) = reg.pools.get(k) else { continue };
        match e.pool.v4_id {
            Some(id) => v4.entry(e.pool.address).or_default().push(format!("{id}")),
            None => {
                addrs.push(format!("{:#x}", e.pool.address));
                pads.push(format!("0x{}{}", "0".repeat(24), &to_hex(e.pool.address.as_slice())[2..]));
                for c in [e.pool.token0, e.pool.token1] {
                    if c != Address::ZERO {
                        coins.push(format!("{c:#x}"));
                    }
                }
            }
        }
    }
    addrs.sort();
    addrs.dedup();
    pads.sort();
    pads.dedup();
    coins.sort();
    coins.dedup();
    let transfer = format!("{}", keccak256("Transfer(address,address,uint256)".as_bytes()));
    let mut f = Vec::new();
    if !addrs.is_empty() {
        f.push(json!({ "address": addrs }));
        f.push(json!({ "address": coins, "topics": [transfer, pads] }));
        f.push(json!({ "address": coins, "topics": [transfer, Value::Null, pads] }));
    }
    for (pm, ids) in v4 {
        f.push(json!({ "address": format!("{pm:#x}"), "topics": [Value::Null, ids] }));
    }
    f
}

/// The pool's current tick in this snapshot (V3 / Pancake: slot0 at 0; V4:
/// its slot0 in the PoolManager), if held.
fn current_tick(p: &TrackedPool, s: &Snapshot) -> Option<i64> {
    let w = match (p.kind, p.v4_id) {
        (PoolKind::V3 | PoolKind::PancakeV3, _) => s.storage(p.address, U256::ZERO),
        (PoolKind::V4, Some(id)) => s.storage(p.address, map_slot_id(id)),
        _ => return None,
    };
    let Lookup::Known(w) = w else { return None };
    let t = ((w >> 160usize) & U256::from(0xff_ffffu32)).to::<i64>();
    Some(if t >= 1 << 23 { t - (1 << 24) } else { t })
}

/// Short label of a missed item for `checks.blockedBy`: the class (as
/// missesByClass) and, for a slot, what it is (describe_slot), with long
/// hex numbers cut to their first 10 characters (bounded, still telling).
fn miss_label(reg: &Registry, checkers: &[Address], vol: &crate::state::snap::Volatile, m: &MissItem) -> String {
    let (a, what) = match m {
        MissItem::Account(a) => (*a, "basics"),
        MissItem::Slot(a, _) => (*a, "slot"),
        MissItem::Code(_) => return "code".into(),
    };
    let who = if vol.is_whole(&a) {
        "outside contract"
    } else if reg.by_addr.contains_key(&a) {
        "pool"
    } else if reg.holders.contains_key(&a) {
        "coin"
    } else if reg.owner_of.contains_key(&a) {
        "pool's own account"
    } else {
        "other account"
    };
    let detail = match m {
        MissItem::Slot(_, sl) => describe_slot(reg, checkers, a, *sl),
        _ => String::new(),
    };
    let mut out = format!("{who} {what} {}", short_hex(&format!("{a:#x}")));
    if !detail.is_empty() {
        out.push_str(": ");
        out.push_str(&short_hex(&detail));
    }
    out
}

/// Every hex number longer than 10 characters cut to its first 10.
fn short_hex(t: &str) -> String {
    let b = t.as_bytes();
    let mut out = String::with_capacity(t.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'0' && i + 1 < b.len() && (b[i + 1] == b'x' || b[i + 1] == b'X') {
            let mut j = i + 2;
            while j < b.len() && b[j].is_ascii_hexdigit() {
                j += 1;
            }
            let end = j.min(i + 10);
            out.push_str(&t[i..end]);
            i = j;
            continue;
        }
        out.push(b[i] as char);
        i += 1;
    }
    out
}

/// What a missed value is, where we can tell (status missesTopSlots).
fn describe_slot(reg: &Registry, checkers: &[Address], a: Address, sl: U256) -> String {
    // A coin: whose balance?
    if reg.layouts.contains_key(&a) || reg.holders.contains_key(&a) {
        for pm in reg.pms() {
            if reg.bal_slot(a, pm) == Some(sl) {
                return "balance of the V4 PoolManager (not followed: checks use the bound)".into();
            }
        }
        if let Some(h) = reg.holders.get(&a) {
            for x in h {
                if reg.bal_slot(a, *x) == Some(sl) {
                    return format!("balance of our pool {x}");
                }
            }
        }
        if let Some(Some(l)) = reg.layouts.get(&a) {
            for c in checkers {
                if l.key(*c) == sl {
                    return format!("balance of the check's contract {c}");
                }
            }
            // OpenZeppelin ERC20 keeps balances, allowances, totalSupply in
            // that order (WETH here: balances 0x33, totalSupply 0x35).
            if !l.vyper && !l.solady && l.slot < U256::from(1u64 << 32) && sl == l.slot + U256::from(2u8) {
                return "probably totalSupply (OpenZeppelin order: balances, allowances, totalSupply): moves with every mint / burn on the chain (WETH: wrap / unwrap); held from a fill, refreshed every ARBSIM_COPY2_VERIFY_S".into();
            }
            if (sl & U256::from(0xffu8)) < U256::from(16u8) && sl > (U256::from(1u8) << 64usize) {
                return "not a balance; looks like a namespaced (ERC-7201) setting of the coin (base ..00 + field): held from a fill, refreshed every ARBSIM_COPY2_VERIFY_S".into();
            }
            return "not a balance of a pool / PoolManager / check contract we know".into();
        }
        return "coin without a known balance layout".into();
    }
    // A V4 PoolManager: which pool's value?
    if reg.is_pm(&a) {
        for k in reg.by_addr.get(&a).cloned().unwrap_or_default() {
            let Some(id) = k.1 else { continue };
            let base = map_slot_id(id);
            if sl >= base && sl < base + U256::from(4u8) {
                let n = ["slot0", "feeGrowthGlobal0", "feeGrowthGlobal1", "liquidity"][(sl - base).to::<usize>()];
                return format!("pool {id} {n}");
            }
            if let Some(e) = reg.pools.get(&k) {
                if e.walked.binary_search(&(a, sl)).is_ok() {
                    return format!("pool {id}: a walked value (held)");
                }
                if e.far_zero.as_ref().is_some_and(|f| f.slots.binary_search(&sl).is_ok()) {
                    return format!("pool {id}: far zero tick-map word (checks answer it)");
                }
            }
        }
        if sl < U256::from(8u8) {
            return format!("PoolManager setting slot {sl} (owner / protocol fee controller / ...)");
        }
        for c in reg.pools.values().filter(|e| e.pool.address == a && e.pool.v4_id.is_some()).flat_map(|e| [e.pool.token0, e.pool.token1]) {
            if fields::map_slot(c, 1) == sl {
                return format!("protocolFeesAccrued[{c}] (V4 protocol fee counter: swaps of every protocol-fee pool in that coin and fee collections, which leave no event, move it; not followed, fills refused; checks run with it 0 and not 0 and answer when only the gas differs, with the higher gas)");
            }
        }
        return "not a base slot / walked value of our V4 pools (another pool, a tick beyond our walk, claims ...)".into();
    }
    if reg.by_addr.contains_key(&a) {
        return "our pool's own storage".into();
    }
    if sl < U256::from(64u8) {
        return format!("slot {sl}");
    }
    String::new()
}

fn map_slot_id(id: B256) -> U256 {
    let mut b = [0u8; 64];
    b[..32].copy_from_slice(id.as_slice());
    b[63] = 6;
    U256::from_be_bytes(keccak256(b).0)
}

/// Wait before another walk after `n` failures in a row (5 s doubling to
/// 10 min); our own speed limit (nothing sent): 1 s.
fn walk_backoff(n: u32, speed_limit: bool) -> Duration {
    if speed_limit {
        return Duration::from_secs(1);
    }
    Duration::from_secs((5u64 << n.saturating_sub(1).min(7)).min(600))
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

/// ArbOS / chain-system addresses and precompiles: 0x0 - 0xffff (Ethereum
/// and Nitro precompiles, 0x0, NodeInterface) and 0xa4b0... (ArbOS state,
/// the batch poster / coinbase, fee accounts). ArbOS changes these in every
/// block in ways copy 2 never follows, so nothing about them is ever learned
/// from a trace (a check that needs them misses, and a fill reads them).
fn is_system_address(a: &Address) -> bool {
    let b = a.as_slice();
    b[..18].iter().all(|x| *x == 0) || (b[0] == 0xa4 && b[1] == 0xb0)
}

/// One account entry of a prestate trace -> its basics, ONLY when the entry
/// proves them: a non-empty code body that parses (and matches `codeHash`
/// when the node gives one), a balance that parses, a nonce that parses
/// (absent = 0: the tracer leaves zero nonces out). Anything else = None
/// (the account stays MISSING; never "an account without code").
fn trace_basics(acct: &Value) -> Option<crate::node::FetchedAccount> {
    let code = parse_bytes(acct.get("code")?.as_str()?).ok()?;
    if code.is_empty() {
        return None;
    }
    if let Some(h) = acct.get("codeHash") {
        let h = parse_u256(h.as_str()?).ok()?;
        if B256::from(h.to_be_bytes::<32>()) != keccak256(&code) {
            return None;
        }
    }
    let balance = parse_u256(acct.get("balance")?.as_str()?).ok()?;
    let nonce = match acct.get("nonce") {
        None => 0,
        Some(Value::Number(n)) => n.as_u64()?,
        Some(Value::String(t)) => parse_u64(t).ok()?,
        Some(_) => return None,
    };
    Some(crate::node::FetchedAccount { balance, nonce, code })
}

/// A prestate trace of coin.balanceOf(pool): Ok(the one slot of `coin`
/// holding exactly `bal`) or Err(how many did), plus the values it proves,
/// exact at the traced block:
///   - basics of contracts the call ran (the coin, a proxy's implementation),
///     only with their real code (see trace_basics)
///   - the coin's own storage it read (its settings, a proxy's
///     implementation slot); never other accounts' storage
///   - nothing at all about ArbOS / system addresses or precompiles
fn read_trace(tr: &Value, coin: Address, bal: U256) -> (Result<U256, usize>, Vec<Fetched>) {
    let mut facts = Vec::new();
    let mut cands = Vec::new();
    let Some(m) = tr.as_object() else { return (Err(0), facts) };
    for (k, acct) in m {
        let Ok(a) = parse_address(k) else { continue };
        if is_system_address(&a) {
            continue;
        }
        if let Some(fa) = trace_basics(acct) {
            facts.push(Fetched::Account(a, Some(fa)));
        }
        if a != coin {
            continue;
        }
        if let Some(st) = acct.get("storage").and_then(|x| x.as_object()) {
            for (sk, sv) in st {
                let (Ok(sk), Ok(sv)) = (parse_u256(sk), sv.as_str().map(parse_u256).unwrap_or(Err(String::new()))) else { continue };
                if sv == bal {
                    cands.push(sk);
                }
                facts.push(Fetched::Slot(a, sk, sv));
            }
        }
    }
    let found = if cands.len() == 1 { Ok(cands[0]) } else { Err(cands.len()) };
    // The candidate itself is added by the caller (as the pool's balance);
    // with no single candidate, no coin value is kept at all.
    if found.is_err() {
        facts.retain(|f| !matches!(f, Fetched::Slot(x, _, _) if *x == coin));
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

/// A "too fast" refusal from the provider (RPS limit), as error text.
fn is_refusal(m: &str) -> bool {
    crate::node::is_rate_refusal(0, m)
}

/// Drop repeated reports (same transaction, log index and `removed` flag),
/// keeping the first. Returns how many were dropped.
fn dedup_logs(logs: &mut Vec<PoolLog>) -> usize {
    let before = logs.len();
    let mut seen: HashSet<(LogId, bool)> = HashSet::with_capacity(before);
    logs.retain(|l| seen.insert((log_id(l), l.removed)));
    before - logs.len()
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

/// A followed coin balance changes ONLY by its Transfers (replays never
/// write coin storage), so a late Transfer at block n changes every kept
/// version from n on by exactly its amount, whatever else happened in
/// between (adding is order-free). `deltas` (coin, slot, n, is_from,
/// amount): applied to each version from n on that HOLDS the balance (a
/// missing one stays missing); per version all of a slot's deltas are
/// summed first, so their order doesn't matter. A version where the sum
/// would go below zero held a wrong value: the balance is forgotten there
/// and in every newer version (never a guess). `included` (coin, slot, n,
/// base): a Transfer the node value read at `base` already contains:
/// versions in [n, base) (older values that lack it) forget the balance.
pub fn apply_late_coin_changes(versions: &mut VecDeque<Arc<Version>>, deltas: &[(Address, U256, u64, bool, U256)], included: &[(Address, U256, u64, u64)]) {
    if deltas.is_empty() && included.is_empty() {
        return;
    }
    let mut slots: Vec<(Address, U256)> = deltas.iter().map(|d| (d.0, d.1)).chain(included.iter().map(|x| (x.0, x.1))).collect();
    slots.sort();
    slots.dedup();
    let mut broken: HashMap<(Address, U256), u64> = HashMap::new();
    for i in 0..versions.len() {
        let v = versions[i].clone();
        let mut s = (*v.snap).clone();
        let mut changed = false;
        let mut forget: Vec<(Address, U256)> = Vec::new();
        for &(c, sl) in &slots {
            if broken.get(&(c, sl)).is_some_and(|b| v.block >= *b) {
                forget.push((c, sl));
                continue;
            }
            if included.iter().any(|x| x.0 == c && x.1 == sl && v.block >= x.2 && v.block < x.3) {
                forget.push((c, sl));
                continue;
            }
            let (mut add, mut sub) = (U256::ZERO, U256::ZERO);
            let mut any = false;
            for d in deltas.iter().filter(|d| d.0 == c && d.1 == sl && v.block >= d.2) {
                any = true;
                let t = if d.3 { &mut sub } else { &mut add };
                match t.checked_add(d.4) {
                    Some(x) => *t = x,
                    None => {
                        broken.insert((c, sl), v.block);
                        break;
                    }
                }
            }
            if broken.contains_key(&(c, sl)) {
                forget.push((c, sl));
                continue;
            }
            if !any {
                continue;
            }
            if let Lookup::Known(x) = s.storage(c, sl) {
                match x.checked_add(add).and_then(|y| y.checked_sub(sub)) {
                    Some(y) => {
                        if y != x {
                            s.apply_fact(&Fact::Slot(c, sl, y));
                            changed = true;
                        }
                    }
                    None => {
                        broken.insert((c, sl), v.block);
                        forget.push((c, sl));
                    }
                }
            }
        }
        for (c, sl) in &forget {
            if matches!(s.storage(*c, *sl), Lookup::Known(_)) {
                forget_slot(&mut s, *c, *sl);
                changed = true;
            }
        }
        if !changed && v.txs.is_empty() {
            continue;
        }
        // Per-transaction states (copy 2 keeps none): never left holding an
        // old value next to a changed block state.
        let txs = v
            .txs
            .iter()
            .map(|t| {
                let mut ts = (*t.snap).clone();
                for &(c, sl) in &slots {
                    forget_slot(&mut ts, c, sl);
                }
                crate::feed::replay::TxSnap { hash: t.hash, snap: Arc::new(ts), diff: t.diff.clone() }
            })
            .collect();
        versions[i] = Arc::new(Version { snap: Arc::new(s), txs, ..(*v).clone() });
    }
}

/// Forget one slot in every kept version older than `block`.
fn forget_before(versions: &mut VecDeque<Arc<Version>>, block: u64, a: Address, slot: U256) {
    for i in 0..versions.len() {
        let v = versions[i].clone();
        if v.block >= block || (matches!(v.snap.storage(a, slot), Lookup::Missing) && v.txs.is_empty()) {
            continue;
        }
        let mut s = (*v.snap).clone();
        forget_slot(&mut s, a, slot);
        let txs = v
            .txs
            .iter()
            .map(|t| {
                let mut ts = (*t.snap).clone();
                forget_slot(&mut ts, a, slot);
                crate::feed::replay::TxSnap { hash: t.hash, snap: Arc::new(ts), diff: t.diff.clone() }
            })
            .collect();
        versions[i] = Arc::new(Version { snap: Arc::new(s), txs, ..(*v).clone() });
    }
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

#[cfg(test)]
mod trace_tests {
    use super::*;
    use crate::node::FetchedAccount;

    fn ad(s: &str) -> Address {
        parse_address(s).unwrap()
    }
    fn hexs(b: &[u8]) -> String {
        format!("0x{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())
    }

    /// The shape this Nitro node's prestateTracer gives for
    /// USDG.balanceOf(pool) (dry run, 2026-10-21), plus doubtful entries.
    #[test]
    fn trace_learns_only_proven_basics_and_only_the_coins_storage() {
        let coin = ad("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
        let imp = ad("0x68184c449e1a8f34fa18d289737129fd27b66f8f");
        let pool = ad("0x00000000000000000000000000000000000a11ce");
        let bal_slot = map_slot(pool, 0);
        let impl_slot = parse_u256("0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc").unwrap();
        let proxy_code = vec![0x60u8, 0x80, 0x60, 0x40, 0x52];
        let impl_code = vec![0x60u8, 0x01, 0x60, 0x02];
        let bal = U256::from(123_456u64);
        let no_code = ad("0x1111111111111111111111111111111111111111");
        let bad_hash = ad("0x2222222222222222222222222222222222222222");
        let other = ad("0x3333333333333333333333333333333333333333");
        let tr = json!({
            format!("{coin:#x}"): {"balance": "0x0", "nonce": 1, "code": hexs(&proxy_code),
                "storage": { format!("{impl_slot:#066x}"): format!("{:#066x}", U256::from_be_slice(imp.as_slice())), format!("{bal_slot:#066x}"): format!("{bal:#066x}") }},
            format!("{imp:#x}"): {"balance": "0x0", "nonce": 1, "code": hexs(&impl_code), "codeHash": format!("{}", keccak256(&impl_code))},
            "0x0000000000000000000000000000000000000000": {"balance": "0x0"},
            "0x0000000000000000000000000000000000000071": {"balance": "0x0", "code": "0xfe"},
            "0x0000000000000000000000000000000000000072": {"balance": "0x0", "code": "0xfe"},
            "0xa4b00000000000000000000000000000000000f6": {"balance": "0x1"},
            "0xa4b000000000000000000073657175656e636572": {"balance": "0x5"},
            "0xa4b05fffffffffffffffffffffffffffffffffff": {"balance": "0x0", "nonce": 1, "storage": {"0x0000000000000000000000000000000000000000000000000000000000000001": "0x0000000000000000000000000000000000000000000000000000000000000002"}},
            format!("{no_code:#x}"): {"balance": "0x0", "nonce": 1},
            format!("{bad_hash:#x}"): {"balance": "0x0", "nonce": 1, "code": "0x6001", "codeHash": format!("{}", keccak256([0x60u8, 0x02]))},
            format!("{other:#x}"): {"balance": "0x0", "nonce": 1, "code": "0x6001", "storage": {"0x0000000000000000000000000000000000000000000000000000000000000009": "0x0000000000000000000000000000000000000000000000000000000000000001"}},
        });
        let (found, facts) = read_trace(&tr, coin, bal);
        assert_eq!(found, Ok(bal_slot));
        let accounts: Vec<Address> = facts.iter().filter_map(|f| match f { Fetched::Account(a, _) => Some(*a), _ => None }).collect();
        // Real code only; never system addresses, never code-less basics.
        let mut want = vec![coin, imp, other];
        want.sort();
        let mut got = accounts.clone();
        got.sort();
        assert_eq!(got, want, "{facts:?}");
        for f in &facts {
            match f {
                Fetched::Account(_, Some(FetchedAccount { code, .. })) => assert!(!code.is_empty()),
                Fetched::Account(a, None) => panic!("learned {a} as an empty account"),
                Fetched::Slot(a, _, _) => assert_eq!(*a, coin, "storage of another account learned"),
            }
        }
        assert!(facts.iter().any(|f| matches!(f, Fetched::Account(a, Some(x)) if *a == imp && x.code.as_ref() == impl_code.as_slice() && x.nonce == 1)));
        assert!(facts.iter().any(|f| matches!(f, Fetched::Slot(a, s, _) if *a == coin && *s == impl_slot)));
    }

    #[test]
    fn unreadable_trace_fields_are_never_defaults() {
        let coin = ad("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
        for entry in [
            json!({"balance": "0x0", "nonce": 1, "code": "0xzz"}),
            json!({"balance": "bad", "nonce": 1, "code": "0x6001"}),
            json!({"nonce": 1, "code": "0x6001"}),
            json!({"balance": "0x0", "nonce": "x", "code": "0x6001"}),
            json!({"balance": "0x0", "nonce": 1, "code": "0x"}),
            json!({"balance": "0x0", "nonce": 1, "code": null}),
        ] {
            let tr = json!({ format!("{coin:#x}"): entry });
            let (_, facts) = read_trace(&tr, coin, U256::from(1u64));
            assert!(!facts.iter().any(|f| matches!(f, Fetched::Account(..))), "{entry}: {facts:?}");
        }
    }
}
