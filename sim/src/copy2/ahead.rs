// ============================================================================
// FAST LANE A: THE PREDICTED COPY ("ahead").
//
// Plain English:
//   Copy 2 moves forward only when a block is FINISHED and the bot has
//   handed us that block's pool reports. The sequencer feed tells us the
//   same block's transactions earlier: each feed message (= one L2 block)
//   arrives with every signed transaction in it. Rivals take standing gaps
//   at the top of the NEXT block, so waiting for the reports is too late.
//
//   This file keeps a PREDICTED copy:
//     predicted = the newest confirmed copy-2 version
//               + every feed message after it, applied in order.
//   For each new feed message (block N right after the predicted tip):
//     1. Pick the transactions that can move our pools (see "WHICH
//        TRANSACTIONS WE RUN" below). The rest are skipped.
//     2. Run each picked one on the predicted copy with the chain's own
//        rules (check/ordered.rs, the same engine and the same best-effort
//        rules trigger-first checks use) and keep what it changed.
//     3. A transaction that can't be run exactly (a value our copy doesn't
//        hold, a Nitro built-in we don't imitate, ...) is NEVER guessed: we
//        find out which of our pools it touches (one more run in "collect"
//        mode that only records what it reads) plus the pools its target /
//        data name, and mark ONLY those pools "unsure": their values are
//        forgotten in the predicted copy (a check through them answers
//        unknown, missing is never zero) and they are listed as unsure.
//   When copy 2 confirms block N (its normal intake publishes a version),
//   we "rebase": drop predicted blocks <= N and re-apply the feed messages
//   after N on top of the new confirmed version (normally 1-3 blocks).
//
//   AGREEMENT (practice mode proof): when block N is confirmed and we had
//   predicted it, every pool that changed in either one is compared value
//   by value (a contract pool's own declared values; a V4 pool's 4 base
//   values in the PoolManager):
//     agree      same values
//     disagree   different values; split into
//                  missed  the confirmed block moved it, our prediction didn't
//                  phantom we moved it, the confirmed block didn't
//                  value   both moved it, to different values
//     unsure     we had marked it unsure
//   Counted per hour, with a few disagreement samples (pool + block), on
//   the hourly line and in status ("fastlaneAhead").
//
//   WHICH TRANSACTIONS WE RUN (cheap filter + what we learn):
//     - its target is one of our pool contracts or a V4 PoolManager
//     - its data names one of our pool contracts, one of our V4 pool ids,
//       or BOTH coins of one of our pools (router / aggregator calls carry
//       the path: pools or coins)
//     - its target is a "toucher": an address whose transaction moved one
//       of our pools before. Learned from our own runs AND from copy 2's
//       confirmed reports (RECENT MOVES: tx hash -> pools it moved). A
//       transaction we skipped that the confirmed reports say DID move our
//       pools is counted ("filterMissed") and its target is learned, so the
//       next trade through that router is run.
//     - FASTLANE_AHEAD_FILTER=all: simply every transaction.
//
//   NEVER asks the node: zero new node reads. A missing value marks the
//   pools that need it unsure; it is never fetched from here.
//
//   Cheap: the copy uses persistent maps (a fork is a pointer copy). Only
//   runs when FASTLANE is practice / live (default off: nothing here runs,
//   no thread, no memory). Bounded: at most FASTLANE_AHEAD_MAX_BLOCKS
//   predicted blocks (32); a confirmed copy further behind than that stops
//   the prediction ("behind": no tip) until it catches up.
//   CPU (final review H-1): the thread runs at a lower OS priority
//   (FASTLANE_NICE, default 10), and one feed message may take at most
//   FASTLANE_AHEAD_MSG_BUDGET_MS (default 10) to apply: a message that runs
//   past it stops the prediction ("msg_budget", counted "over budget") until
//   copy 2 has confirmed that message, so a heavy block is never re-tried.
//   The hourly line also counts messages that arrived while stopped, so the
//   practice line can show unsure / unpredicted / stopped shares next to
//   the agreement %.
//
// API (scanner and integration):
//   Ahead::on_feed_message(Arc<BinMsg>)            a new feed message
//   Ahead::on_confirmed(Confirmed, moved_by_tx)     copy 2 published a version
//   Ahead::tip() -> Option<Arc<AheadTip>>           the predicted tip:
//       block / seq, `view()` (strict StateRead, like every check's view),
//       `changed_pools` (by THIS message), `unsure_pools`, built_at, apply_us
//   Process-wide (the running sidecar): start(), global_tip(), status_json(),
//   feed_hook() (check/feedstore.rs), confirmed_hook() (copy2/intake.rs).
// ============================================================================
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use rustc_hash::{FxHashMap, FxHashSet};

use revm::primitives::{Address, B256, KECCAK_EMPTY, U256};
use revm::state::AccountInfo;
use serde_json::{json, Value};

use super::overlay::Overlay;
use crate::arb::BlockCtx;
use crate::check::feedstore::BinMsg;
use crate::check::moved::{v4_base, FollowedPool, MovedIndex};
use crate::check::ordered::{run_ordered_keep, Assume, OrderedPlan, PlanMsg, Provenance, Route};
use crate::check::rawtx::DecodedTx;
use crate::check::run::{CheckOptions, Session};
use crate::check::Overrides;
use crate::state::snap::{Snapshot, View};
use crate::state::{Lookup, StateDiff, StatePosition, StateRead};

// ---------------------------------------------------------------------------
// The FASTLANE switch: the one shared parser (fastlane/mode.rs).
// ---------------------------------------------------------------------------

pub use crate::fastlane::mode::Mode;

/// Parse FASTLANE (fastlane/mode.rs rules: unset / empty / unknown = off).
pub fn parse_mode(raw: Option<&str>) -> Mode {
    Mode::parse(raw)
}

/// FASTLANE of this process (read once).
pub fn mode() -> Mode {
    static M: OnceLock<Mode> = OnceLock::new();
    *M.get_or_init(Mode::from_env)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// Knobs (env, read once at start).
#[derive(Clone, Debug)]
pub struct AheadCfg {
    /// FASTLANE_AHEAD_MAX_BLOCKS [32]: most predicted blocks kept; a
    /// confirmed copy further behind stops the prediction until it catches up.
    pub max_blocks: usize,
    /// FASTLANE_AHEAD_FILTER [smart]: "all" runs every feed transaction.
    pub run_all: bool,
    /// FASTLANE_AHEAD_MAX_TXS [256]: most transactions run per message
    /// (more = the message is "too big": prediction stops until confirmed).
    pub max_txs: usize,
    /// Most learned "toucher" addresses kept (oldest dropped).
    pub max_touchers: usize,
    /// Feed sequence number + this = L2 block number (mirror Config.l2_offset).
    pub l2_offset: u64,
    /// FASTLANE_AHEAD_TRUST_SENDER_FUNDS [off] (review M1): off = a run that
    /// ASSUMED a sender's coin balance / allowance was enough marks the
    /// pools it moved unsure (the real transaction may have failed). on =
    /// trust it (more pools stay usable; agreement stats show the cost).
    pub trust_sender_funds: bool,
    /// FASTLANE_AHEAD_MSG_BUDGET_MS [10] (final review H-1, CPU): most time
    /// one feed message may take to apply. A message that runs past it is
    /// not finished: prediction STOPS (reason "msg_budget", counted) and
    /// does not try again until copy 2 has confirmed that message (so one
    /// heavy block can never eat a CPU over and over). 1..=1000 ms.
    pub msg_budget_us: u64,
    /// FASTLANE_AHEAD_ROUTES_ONLY [on] (practice fixes, Oct 27): a
    /// transaction that names ONLY pools no scanner route uses is not run;
    /// those pools are marked unsure instead (the scanner never reads them).
    /// Transactions to learned routers ("touchers"), naming a V4
    /// PoolManager, or naming any route pool still run. Until the bot's
    /// candidate table is in, everything picked runs. off = always run.
    pub routes_only: bool,
}

impl Default for AheadCfg {
    fn default() -> Self {
        AheadCfg { max_blocks: 32, run_all: false, max_txs: 256, max_touchers: 4096, l2_offset: 0, trust_sender_funds: false, msg_budget_us: 10_000, routes_only: true }
    }
}

impl AheadCfg {
    /// From any key -> value lookup (tests pass a map).
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>, l2_offset: u64) -> AheadCfg {
        let d = AheadCfg::default();
        let num = |k: &str| get(k).and_then(|v| v.trim().parse::<usize>().ok());
        AheadCfg {
            max_blocks: num("FASTLANE_AHEAD_MAX_BLOCKS").filter(|v| (1..=1024).contains(v)).unwrap_or(d.max_blocks),
            run_all: get("FASTLANE_AHEAD_FILTER").is_some_and(|v| v.trim().eq_ignore_ascii_case("all")),
            max_txs: num("FASTLANE_AHEAD_MAX_TXS").filter(|v| (1..=100_000).contains(v)).unwrap_or(d.max_txs),
            max_touchers: d.max_touchers,
            l2_offset,
            // Practice fixes (Oct 27): unset = TRUSTED in practice mode (no
            // trade is ever sent there, and with it off nearly every swap's
            // pools were unsure: the scanner and the agreement count had
            // nothing to work with; the practice "real / gone" scores now
            // measure what trusting costs). Live: off unless set to on.
            trust_sender_funds: match get("FASTLANE_AHEAD_TRUST_SENDER_FUNDS").filter(|v| !v.trim().is_empty()) {
                Some(v) => crate::fastlane::mode::parse_on(Some(&v)),
                None => Mode::parse(get("FASTLANE").as_deref()) == Mode::Practice,
            },
            msg_budget_us: num("FASTLANE_AHEAD_MSG_BUDGET_MS").filter(|v| (1..=1000).contains(v)).map(|v| v as u64 * 1000).unwrap_or(d.msg_budget_us),
            routes_only: get("FASTLANE_AHEAD_ROUTES_ONLY").is_none_or(|v| !matches!(v.trim().to_ascii_lowercase().as_str(), "off" | "0" | "false" | "no")),
        }
    }
}

// ---------------------------------------------------------------------------
// Our pools, as the prediction needs them
// ---------------------------------------------------------------------------

/// Where one pool's own state lives (what is forgotten when it is unsure,
/// and what agreement compares).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Place {
    /// A pool contract: its declared values (slots below 2^32).
    Contract(Address),
    /// A V4 pool: its 4 base values (slot0, fee growth x2, liquidity) at
    /// base = keccak(id . 6) in the PoolManager.
    V4(Address, U256),
}

/// Declared variables of a pool contract: slots below this (check/moved.rs).
const DECLARED_MAX: u64 = 1 << 32;

/// The pools copy 2 follows, with the lookup tables the prediction uses.
#[derive(Default)]
pub struct PoolSet {
    /// Key (the bot's name) -> where its state is.
    places: HashMap<String, Place>,
    /// "Which pools did it move" (check/moved.rs, the same rules as
    /// trig_discover: only a pool's OWN state counts).
    moved: MovedIndex,
    /// Names our pools for the cheap filter (to / data).
    route: Route,
    /// Pool contract -> key.
    by_contract: HashMap<Address, String>,
    /// (PoolManager, a V4 pool's slot0 slot) -> key: a run that read it
    /// went through that pool.
    v4_slot0: HashMap<(Address, U256), String>,
    /// V4 pool id -> key.
    by_id: HashMap<B256, String>,
    /// Coin pair -> keys of our pools with those two coins.
    by_pair: HashMap<(Address, Address), Vec<String>>,
    /// Coin -> keys of our pools holding it (H4: "pools sharing a named coin").
    by_coin: HashMap<Address, Vec<String>>,
    /// Review M3: native-ETH pools (one coin is address zero, which can't be
    /// looked for in call data): the OTHER coin -> keys. A transaction that
    /// pays ETH (value > 0) and names that coin may trade such a pool.
    native_by_coin: HashMap<Address, Vec<String>>,
    /// Pools copy 2 itself can't vouch for right now (loading / unsure):
    /// always listed unsure in the predicted tip.
    pub not_ready: HashSet<String>,
    /// FAST NAME INDEX (practice fixes, Oct 27): every address / V4 pool id
    /// the cheap filter looks for, so ONE pass over a transaction's data
    /// finds them all. Before, each of ~1,800 pools (+ coins + V4 ids) was
    /// looked for separately across the whole data: millions of byte
    /// compares per transaction, most of the 10 ms budget per feed message.
    idx: NameIndex,
}

/// Roles of an indexed address (bit flags).
const ROLE_POOL: u8 = 1;
const ROLE_PM: u8 = 2;
const ROLE_COIN: u8 = 4;

/// The fast name index (see PoolSet.idx). Lookups are by the first 4 bytes
/// first (a tiny hash set), then the full address / id.
#[derive(Default)]
struct NameIndex {
    pre20: FxHashSet<u32>,
    addrs: FxHashMap<Address, u8>,
    pre32: FxHashSet<u32>,
    ids: FxHashSet<B256>,
    /// Non-zero coin -> the non-zero coins it forms one of our pairs with.
    partners: FxHashMap<Address, Vec<Address>>,
    /// Our V4 PoolManagers.
    pms: FxHashSet<Address>,
}

/// What one transaction's data names (indexed items only), found in one pass.
#[derive(Default, Debug)]
pub struct Named {
    addrs: FxHashSet<Address>,
    ids: Vec<B256>,
}

impl NameIndex {
    fn add_addr(&mut self, a: Address, role: u8) {
        if a.is_zero() {
            return;
        }
        self.pre20.insert(u32::from_be_bytes([a[0], a[1], a[2], a[3]]));
        *self.addrs.entry(a).or_default() |= role;
    }
    fn add_id(&mut self, id: B256) {
        self.pre32.insert(u32::from_be_bytes([id[0], id[1], id[2], id[3]]));
        self.ids.insert(id);
    }
    /// Every indexed address and V4 id inside `data` (each byte offset).
    fn scan(&self, data: &[u8]) -> Named {
        let mut out = Named::default();
        if data.len() >= 20 && !self.pre20.is_empty() {
            for i in 0..=data.len() - 20 {
                if self.pre20.contains(&u32::from_be_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]])) {
                    let a = Address::from_slice(&data[i..i + 20]);
                    if self.addrs.contains_key(&a) {
                        out.addrs.insert(a);
                    }
                }
            }
        }
        if data.len() >= 32 && !self.pre32.is_empty() {
            for i in 0..=data.len() - 32 {
                if self.pre32.contains(&u32::from_be_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]])) {
                    let id = B256::from_slice(&data[i..i + 32]);
                    if self.ids.contains(&id) && !out.ids.contains(&id) {
                        out.ids.push(id);
                    }
                }
            }
        }
        out
    }
    fn role(&self, a: &Address) -> u8 {
        self.addrs.get(a).copied().unwrap_or(0)
    }
    /// Coins found in `n` (non-zero).
    fn coins<'a>(&'a self, n: &'a Named) -> impl Iterator<Item = &'a Address> + 'a {
        n.addrs.iter().filter(move |a| self.role(a) & ROLE_COIN != 0)
    }
    /// Pairs (x <= y) whose BOTH coins are in `n`.
    fn pairs_found(&self, n: &Named) -> Vec<(Address, Address)> {
        let mut out = Vec::new();
        for x in self.coins(n) {
            if let Some(ps) = self.partners.get(x) {
                for y in ps {
                    // (x == y: a degenerate "pair" of one coin, matched like the old search.)
                    if x <= y && n.addrs.contains(y) && !out.contains(&(*x, *y)) {
                        out.push((*x, *y));
                    }
                }
            }
        }
        out
    }
}

impl PoolSet {
    /// `pools`: (followed pool, token0, token1). `not_ready`: keys of pools
    /// copy 2 has not got ready.
    pub fn build(pools: &[(FollowedPool, Address, Address)], not_ready: HashSet<String>) -> PoolSet {
        let followed: Vec<FollowedPool> = pools.iter().map(|p| p.0.clone()).collect();
        let mut s = PoolSet { moved: MovedIndex::build(&followed), not_ready, ..Default::default() };
        let mut pms: HashSet<Address> = HashSet::new();
        for (p, t0, t1) in pools {
            match p.v4_id {
                Some(id) => {
                    let base = v4_base(id);
                    s.places.insert(p.key.clone(), Place::V4(p.address, base));
                    s.v4_slot0.insert((p.address, base), p.key.clone());
                    s.by_id.insert(id, p.key.clone());
                    s.route.ids.push(id);
                    pms.insert(p.address);
                }
                None => {
                    s.places.insert(p.key.clone(), Place::Contract(p.address));
                    s.by_contract.insert(p.address, p.key.clone());
                    s.route.accounts.insert(p.address);
                    s.route.names.push(p.address);
                }
            }
            for c in [*t0, *t1] {
                if !c.is_zero() {
                    let v = s.by_coin.entry(c).or_default();
                    if !v.contains(&p.key) {
                        v.push(p.key.clone());
                    }
                }
            }
            if t0.is_zero() != t1.is_zero() {
                let other = if t0.is_zero() { *t1 } else { *t0 };
                let v = s.native_by_coin.entry(other).or_default();
                if !v.contains(&p.key) {
                    v.push(p.key.clone());
                }
            }
            if !t0.is_zero() && !t1.is_zero() {
                let k = if t0 < t1 { (*t0, *t1) } else { (*t1, *t0) };
                let v = s.by_pair.entry(k).or_default();
                if !v.contains(&p.key) {
                    v.push(p.key.clone());
                    if v.len() == 1 {
                        s.route.pairs.push(k);
                    }
                }
            }
        }
        // A V4 PoolManager as a target = may touch our V4 pools.
        s.route.names.extend(pms.iter().copied());
        // The fast name index: the same things the filter looks for.
        for a in s.by_contract.keys() {
            s.idx.add_addr(*a, ROLE_POOL);
        }
        for pm in &pms {
            s.idx.add_addr(*pm, ROLE_PM);
            s.idx.pms.insert(*pm);
        }
        for id in s.by_id.keys() {
            s.idx.add_id(*id);
        }
        for c in s.by_coin.keys().chain(s.native_by_coin.keys()) {
            s.idx.add_addr(*c, ROLE_COIN);
        }
        for (x, y) in s.by_pair.keys() {
            s.idx.partners.entry(*x).or_default().push(*y);
            s.idx.partners.entry(*y).or_default().push(*x);
        }
        s
    }

    /// One pass over a transaction's data: what of ours it names.
    pub fn scan(&self, data: &[u8]) -> Named {
        self.idx.scan(data)
    }

    /// Does it name a V4 PoolManager of ours (target or data)?
    fn names_pm(&self, to: Option<Address>, n: &Named) -> bool {
        to.is_some_and(|t| self.idx.pms.contains(&t)) || n.addrs.iter().any(|a| self.idx.role(a) & ROLE_PM != 0)
    }

    /// Practice fixes: a failed transaction that names a V4 PoolManager and
    /// nothing narrower: our V4 pools IN that PoolManager holding a coin it
    /// names (before: every pool of ANY kind holding such a coin, i.e. all
    /// WETH / USDG pools, so every route was skipped as unsure).
    fn v4_sharing_named_coins(&self, to: Option<Address>, n: &Named) -> Vec<String> {
        let pms: Vec<Address> = to.into_iter().chain(n.addrs.iter().copied()).filter(|a| self.idx.pms.contains(a)).collect();
        let mut out: Vec<String> = Vec::new();
        for c in self.idx.coins(n) {
            for k in self.by_coin.get(c).into_iter().chain(self.native_by_coin.get(c)).flatten() {
                if matches!(self.places.get(k), Some(Place::V4(pm, _)) if pms.contains(pm)) && !out.contains(k) {
                    out.push(k.clone());
                }
            }
        }
        out
    }

    pub fn len(&self) -> usize {
        self.places.len()
    }

    pub fn is_empty(&self) -> bool {
        self.places.is_empty()
    }

    /// Our pools a transaction NAMES (target or data), without running it.
    /// `n` = PoolSet::scan of its data (one pass, see NameIndex).
    fn named(&self, to: Option<Address>, n: &Named) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let mut push = |k: &String| {
            if !out.contains(k) {
                out.push(k.clone());
            }
        };
        if let Some(k) = to.and_then(|t| self.by_contract.get(&t)) {
            push(k);
        }
        for a in &n.addrs {
            if let Some(k) = self.by_contract.get(a) {
                push(k);
            }
        }
        for id in &n.ids {
            if let Some(k) = self.by_id.get(id) {
                push(k);
            }
        }
        for p in self.idx.pairs_found(n) {
            for k in self.by_pair.get(&p).into_iter().flatten() {
                push(k);
            }
        }
        out
    }

    /// Review M3: native-ETH pools a transaction may trade (it pays ETH and
    /// names the pool's other coin).
    fn named_native(&self, value: U256, n: &Named) -> Vec<String> {
        if value.is_zero() || self.native_by_coin.is_empty() {
            return Vec::new();
        }
        let mut out: Vec<String> = Vec::new();
        for c in self.idx.coins(n) {
            for k in self.native_by_coin.get(c).into_iter().flatten() {
                if !out.contains(k) {
                    out.push(k.clone());
                }
            }
        }
        out
    }

    /// Review H4: our pools holding ANY coin the data names (wider than
    /// `named`: one coin is enough). Used only when a transaction we ran
    /// failed and nothing narrower is known.
    fn sharing_named_coins(&self, n: &Named) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for c in self.idx.coins(n) {
            for k in self.by_coin.get(c).into_iter().flatten() {
                if !out.contains(k) {
                    out.push(k.clone());
                }
            }
        }
        out
    }

    /// Cheap filter, first part: could this transaction touch our pools?
    /// Same answer as check/ordered.rs Route::named_by on `self.route`
    /// (tested), from the one-pass scan.
    fn may_touch(&self, to: Option<Address>, n: &Named) -> bool {
        if to.is_some_and(|t| self.by_contract.contains_key(&t) || self.idx.pms.contains(&t)) {
            return true;
        }
        n.addrs.iter().any(|a| self.idx.role(a) & (ROLE_POOL | ROLE_PM) != 0) || !n.ids.is_empty() || !self.idx.pairs_found(n).is_empty()
    }

    /// Our pools a transaction NAMES (target or data), without running it.
    #[cfg(test)]
    fn named_slow(&self, to: Option<Address>, data: &[u8]) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let has = |needle: &[u8]| !needle.is_empty() && data.len() >= needle.len() && data.windows(needle.len()).any(|w| w == needle);
        if let Some(t) = to {
            if let Some(k) = self.by_contract.get(&t) {
                out.push(k.clone());
            }
        }
        for (a, k) in &self.by_contract {
            if has(a.as_slice()) && !out.contains(k) {
                out.push(k.clone());
            }
        }
        for (id, k) in &self.by_id {
            if has(id.as_slice()) && !out.contains(k) {
                out.push(k.clone());
            }
        }
        for ((x, y), ks) in &self.by_pair {
            if has(x.as_slice()) && has(y.as_slice()) {
                for k in ks {
                    if !out.contains(k) {
                        out.push(k.clone());
                    }
                }
            }
        }
        out
    }

    /// Review M3: native-ETH pools a transaction may trade (it pays ETH and
    /// names the pool's other coin).
    #[cfg(test)]
    fn named_native_slow(&self, value: U256, data: &[u8]) -> Vec<String> {
        if value.is_zero() || self.native_by_coin.is_empty() {
            return Vec::new();
        }
        let has = |needle: &[u8]| data.len() >= needle.len() && data.windows(needle.len()).any(|w| w == needle);
        let mut out: Vec<String> = Vec::new();
        for (c, ks) in &self.native_by_coin {
            if has(c.as_slice()) {
                for k in ks {
                    if !out.contains(k) {
                        out.push(k.clone());
                    }
                }
            }
        }
        out
    }

    /// Review H4: our pools holding ANY coin the data names (wider than
    /// `named`: one coin is enough). Used only when a transaction we ran
    /// failed and nothing narrower is known.
    #[cfg(test)]
    fn sharing_named_coins_slow(&self, data: &[u8]) -> Vec<String> {
        let has = |needle: &[u8]| data.len() >= needle.len() && data.windows(needle.len()).any(|w| w == needle);
        let mut out: Vec<String> = Vec::new();
        for (c, ks) in &self.by_coin {
            if has(c.as_slice()) {
                for k in ks {
                    if !out.contains(k) {
                        out.push(k.clone());
                    }
                }
            }
        }
        out
    }

    /// Cheap filter, first part: could this transaction touch our pools?
    #[cfg(test)]
    fn may_touch_slow(&self, to: Option<Address>, data: &[u8]) -> bool {
        self.route.named_by(to, data)
    }

    /// Our pools behind the accounts / values a run read.
    fn touched_by(&self, accounts: &HashSet<Address>, slots: &HashSet<(Address, U256)>) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for a in accounts {
            if let Some(k) = self.by_contract.get(a) {
                if !out.contains(k) {
                    out.push(k.clone());
                }
            }
        }
        for (a, s) in slots {
            let k = self.by_contract.get(a).or_else(|| self.v4_slot0.get(&(*a, *s)));
            if let Some(k) = k {
                if !out.contains(k) {
                    out.push(k.clone());
                }
            }
        }
        out
    }

    /// The pools a set of changed values moved (no hash inputs: a V4 pool
    /// is named by its base values, which every swap changes).
    fn moved_by_diff(&self, d: &StateDiff) -> Vec<String> {
        let changed: Vec<(Address, U256)> = d.accounts.iter().flat_map(|(a, ad)| ad.storage.keys().map(move |s| (*a, *s))).collect();
        let mut out: Vec<String> = self.moved.moved(&changed, &[]).into_iter().map(|m| m.key).collect();
        // A contract pool that was dropped / recreated wholesale counts too.
        for (a, ad) in &d.accounts {
            if ad.forget || ad.storage_cleared {
                if let Some(k) = self.by_contract.get(a) {
                    if !out.contains(k) {
                        out.push(k.clone());
                    }
                }
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

/// One confirmed copy-2 version (what the rebase starts from).
#[derive(Clone)]
pub struct Confirmed {
    /// Feed sequence number of its block.
    pub seq: u64,
    pub snap: Arc<Snapshot>,
    /// Its block details (None: the copy can't answer at it, e.g. a block
    /// repaired from the node's logs; the prediction waits).
    pub ctx: Option<BlockCtx>,
    /// What this block changed (Version.diff): which pools moved in it.
    pub diff: Arc<StateDiff>,
    /// Which copy values are exact at this block (copy 2: Copy2Prov).
    pub prov: Arc<dyn Provenance + Send + Sync>,
}

/// The predicted tip (see the file header).
#[derive(Clone)]
pub struct AheadTip {
    /// Feed sequence number / L2 block number of the newest message applied.
    pub seq: u64,
    pub block: u64,
    /// The confirmed version it was built on.
    pub base_seq: u64,
    /// The predicted state after this block.
    pub snap: Arc<Snapshot>,
    /// This block's details (what a check run "at" the tip uses).
    pub ctx: BlockCtx,
    /// Our pools changed by THIS message (keys as the bot names them).
    pub changed_pools: Vec<String>,
    /// Our pools we can't vouch for in this predicted view (marked unsure
    /// by any message since the confirmed version, plus copy 2's own not
    /// ready pools). Their values are forgotten here (reads are Missing).
    pub unsure_pools: Vec<String>,
    /// The same as a set, built once per tip (the fast lane looks every
    /// route up in it; it used to rebuild it on every tip).
    pub unsure_set: Arc<HashSet<String>>,
    /// When this tip was built.
    pub built_at: Instant,
    /// Microseconds spent applying THIS message.
    pub apply_us: u64,
    /// When THIS feed message reached arbsim (the fast lane's latency
    /// clock starts here: "feed message -> would hand to socket").
    pub feed_at: Instant,
}

impl AheadTip {
    /// A strict read-only view of the predicted state (same rules as every
    /// check's view: missing is never zero, inexact balances answer Missing).
    pub fn view(&self) -> View {
        View::new(self.snap.clone())
    }
}

/// One predicted block.
struct Entry {
    seq: u64,
    snap: Arc<Snapshot>,
    ctx: BlockCtx,
    /// Pools changed by this message.
    changed: Vec<String>,
    /// Pools changed by any message from the base up to this one.
    changed_cum: HashSet<String>,
    /// Pools unsure in this view (since the base).
    unsure_cum: HashSet<String>,
    /// Transactions skipped by the filter: (hash, target).
    skipped: Vec<(B256, Option<Address>)>,
    /// Every transaction of the message and what we did with it (agreement
    /// tells a filter miss from a run that did not move the pool).
    fates: Vec<(B256, Fate)>,
    built_at: Instant,
    apply_us: u64,
    /// When the feed message arrived (see AheadTip.feed_at).
    feed_at: Instant,
}

/// What the prediction did with one transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fate {
    /// Not picked by the cheap filter.
    Skipped,
    /// Picked, but names only pools no route uses: not run (pools unsure).
    OffRoute,
    /// Ran exactly (it may or may not have moved our pools).
    Ran,
    /// Could not be run exactly (pools it may touch marked unsure).
    Failed,
}

/// Why prediction stopped (no tip until a rebase passes it).
#[derive(Clone, Debug)]
struct Stop {
    seq: u64,
    why: &'static str,
}

/// Counters for one hour (and the totals since start).
#[derive(Clone, Default)]
pub struct AheadStats {
    pub msgs: u64,
    pub applied: u64,
    pub late_msgs: u64,
    pub txs_run: u64,
    pub txs_skipped: u64,
    pub txs_failed: u64,
    /// Failed transactions that touched / named our pools (pools marked unsure).
    pub txs_marked: u64,
    /// Skipped transactions the confirmed reports say moved our pools.
    pub filter_missed: u64,
    pub assumed: u64,
    pub rebases: u64,
    pub reapplied: u64,
    pub agree: u64,
    pub disagree: u64,
    pub missed: u64,
    pub phantom: u64,
    pub value_diff: u64,
    pub unsure: u64,
    /// Confirmed blocks we had no prediction for.
    pub unpredicted: u64,
    /// Confirmed blocks compared with our prediction (agreement ran).
    pub compared: u64,
    /// Feed messages that arrived while prediction was stopped (no tip).
    pub msgs_stopped: u64,
    /// H-1: messages that ran past FASTLANE_AHEAD_MSG_BUDGET_MS (prediction
    /// stopped until copy 2 confirmed them).
    pub over_budget: u64,
    /// Review H4: a transaction we ran failed and its probe found none of
    /// our pools: the pools its target moved before (or that share a coin
    /// it names) were marked unsure instead.
    pub failed_unknown: u64,
    /// Review M1: runs that used an assumed value: pools they moved marked unsure.
    pub assumed_unsure: u64,
    /// Review M3: transactions picked because they pay ETH and name a
    /// native-ETH pool's other coin.
    pub native_picks: u64,
    /// Practice fixes (Oct 27): transactions not run because they name only
    /// pools no scanner route uses (those pools marked unsure instead).
    pub txs_off_route: u64,
    /// Failed runs whose second "collect" run was skipped: its target has no
    /// code in our copy, so that run could not read anything of ours.
    pub probes_skipped: u64,
    /// A failed transaction naming a V4 PoolManager and nothing narrower:
    /// only V4 pools of that PoolManager sharing a named coin marked unsure.
    pub v4_fallback: u64,
    /// "missed" split by cause (from copy 2's reports: which transaction of
    /// the block moved the pool): the filter skipped it / we ran it and our
    /// run did not move the pool.
    pub missed_filter: u64,
    pub missed_ran: u64,
    /// The confirmed block changed one of our pools but NO transaction of
    /// that feed message did (copy 2 loading / re-reading a pool, or a
    /// report filed under another block): not a prediction miss, so not
    /// counted in disagree; shown on its own.
    pub not_from_tx: u64,
    /// L2: apply_us samples seen (the ring below keeps the newest MAX_TIMES).
    pub time_n: u64,
    pub stopped: HashMap<&'static str, u64>,
    pub apply_us: Vec<u64>,
    pub samples: Vec<Value>,
}

/// Disagreement samples kept per hour.
const MAX_SAMPLES: usize = 20;
/// apply_us samples kept per hour.
const MAX_TIMES: usize = 20_000;

impl AheadStats {
    fn stop(&mut self, why: &'static str) {
        *self.stopped.entry(why).or_default() += 1;
    }

    pub fn json(&self) -> Value {
        let mut t = self.apply_us.clone();
        json!({
            "msgs": self.msgs, "applied": self.applied, "lateMsgs": self.late_msgs,
            "txsRun": self.txs_run, "txsSkipped": self.txs_skipped, "txsFailed": self.txs_failed,
            "txsMarkedUnsure": self.txs_marked, "filterMissed": self.filter_missed, "assumed": self.assumed,
            "rebases": self.rebases, "reapplied": self.reapplied,
            "agree": self.agree, "disagree": self.disagree, "missed": self.missed, "phantom": self.phantom,
            "valueDiff": self.value_diff, "unsure": self.unsure, "unpredicted": self.unpredicted,
            "compared": self.compared, "msgsStopped": self.msgs_stopped, "overBudget": self.over_budget,
            "failedUnknown": self.failed_unknown, "assumedUnsure": self.assumed_unsure, "nativePicks": self.native_picks,
            "txsOffRoute": self.txs_off_route, "probesSkipped": self.probes_skipped, "v4Fallback": self.v4_fallback,
            "missedFilter": self.missed_filter, "missedRan": self.missed_ran, "notFromTx": self.not_from_tx,
            "agreementPct": self.agreement_pct(),
            "stopped": self.stopped.iter().map(|(k, v)| (k.to_string(), json!(v))).collect::<serde_json::Map<String, Value>>(),
            "applyUs": crate::timing::pct_of(&mut t),
            "samples": self.samples,
        })
    }

    /// The hourly line (timing.rs / bot style: one line, the numbers that matter).
    pub fn line(&self) -> String {
        let mut t = self.apply_us.clone();
        let p = crate::timing::pct_of(&mut t);
        let g = |k: &str| p.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
        let mut stops: Vec<String> = self.stopped.iter().map(|(k, v)| format!("{k}:{v}")).collect();
        stops.sort();
        format!(
            "[arbsim] fastlane ahead (last hour): msgs {} applied {} late {} | txs run {} skipped {} off-route {} failed {} (pools unsure {}, nothing found {}, v4 only {}, probes skipped {}) filterMissed {} assumedUnsure {} nativePicks {} | apply us p50 {} p90 {} p99 {} max {} | rebases {} reapplied {} | agree {} disagree {} (missed {} [filter {} ran {}] phantom {} value {}) unsure {} not from a tx {} unpredicted {} | msgs while stopped {} over budget {} | stopped [{}]",
            self.msgs, self.applied, self.late_msgs, self.txs_run, self.txs_skipped, self.txs_off_route, self.txs_failed, self.txs_marked, self.failed_unknown, self.v4_fallback, self.probes_skipped, self.filter_missed, self.assumed_unsure, self.native_picks,
            g("p50"), g("p90"), g("p99"), g("max"), self.rebases, self.reapplied,
            self.agree, self.disagree, self.missed, self.missed_filter, self.missed_ran, self.phantom, self.value_diff, self.unsure, self.not_from_tx, self.unpredicted, self.msgs_stopped, self.over_budget, stops.join(" "),
        )
    }

    /// L2 (review): a ring of the newest MAX_TIMES samples, so the
    /// percentiles keep moving after 20,000 messages in an hour.
    fn add_time(&mut self, us: u64) {
        if self.apply_us.len() < MAX_TIMES {
            self.apply_us.push(us);
        } else {
            let i = (self.time_n % MAX_TIMES as u64) as usize;
            self.apply_us[i] = us;
        }
        self.time_n += 1;
    }

    /// Prediction agreement % (agree / (agree + disagree)), None = no data.
    pub fn agreement_pct(&self) -> Option<f64> {
        let n = self.agree + self.disagree;
        (n > 0).then(|| 100.0 * self.agree as f64 / n as f64)
    }

    /// The numbers the practice line shows next to agreement % (final
    /// review: agreement alone hides what was never compared).
    pub fn shares(&self) -> PredictionCounts {
        PredictionCounts {
            agree: self.agree,
            disagree: self.disagree,
            unsure: self.unsure,
            compared: self.compared,
            unpredicted: self.unpredicted,
            msgs: self.msgs,
            msgs_stopped: self.msgs_stopped,
            over_budget: self.over_budget,
        }
    }
}

/// Prediction counts for one hour (practice line, fastlane/practice.rs).
///   agreement %   agree / (agree + disagree), per pool compared
///   unsure %      pools we had marked unsure / all pools looked at
///   unpredicted % confirmed blocks with no prediction to compare / all
///                 confirmed blocks
///   stopped %     feed messages that arrived while prediction was stopped
///                 (no tip at all: nothing scanned) / all feed messages
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PredictionCounts {
    pub agree: u64,
    pub disagree: u64,
    pub unsure: u64,
    pub compared: u64,
    pub unpredicted: u64,
    pub msgs: u64,
    pub msgs_stopped: u64,
    pub over_budget: u64,
}

impl PredictionCounts {
    fn pct(a: u64, b: u64) -> Option<f64> {
        (b > 0).then(|| 100.0 * a as f64 / b as f64)
    }
    pub fn agreement_pct(&self) -> Option<f64> {
        Self::pct(self.agree, self.agree + self.disagree)
    }
    pub fn unsure_pct(&self) -> Option<f64> {
        Self::pct(self.unsure, self.agree + self.disagree + self.unsure)
    }
    pub fn unpredicted_pct(&self) -> Option<f64> {
        Self::pct(self.unpredicted, self.compared + self.unpredicted)
    }
    pub fn stopped_pct(&self) -> Option<f64> {
        Self::pct(self.msgs_stopped, self.msgs)
    }
}

// ---------------------------------------------------------------------------
// The predicted copy
// ---------------------------------------------------------------------------

/// The predicted copy (see the file header). Single-threaded: the runtime
/// below owns one on its own thread; tests drive one directly.
pub struct Ahead {
    cfg: AheadCfg,
    pools: Arc<PoolSet>,
    base: Option<Confirmed>,
    /// Predicted blocks after the base, in order (seq base+1, base+2, ...).
    entries: VecDeque<Entry>,
    /// Feed messages after the base, by sequence number (bounded).
    msgs: BTreeMap<u64, Arc<BinMsg>>,
    stop: Option<Stop>,
    /// Learned addresses whose transactions moved our pools (-> when).
    /// -> (when, our pools it moved; H4 uses them when a run fails blind).
    touchers: HashMap<Address, (Instant, Vec<String>)>,
    tip: Option<Arc<AheadTip>>,
    /// Feed arrival time per held message (bounded with `msgs`).
    arrived: BTreeMap<u64, Instant>,
    /// H-1: the message that ran past the per-message budget. Prediction
    /// stays stopped until copy 2 has confirmed it (never re-tried).
    over_budget_seq: Option<u64>,
    /// Practice fixes (FASTLANE_AHEAD_ROUTES_ONLY): every pool key some
    /// scanner route uses (pools + lender), from the bot's candidate table.
    /// None = not known yet: every picked transaction runs.
    route_pools: Option<Arc<HashSet<String>>>,
    pub hour: AheadStats,
    pub total: AheadStats,
}

impl Ahead {
    pub fn new(cfg: AheadCfg) -> Self {
        Ahead {
            cfg,
            pools: Arc::new(PoolSet::default()),
            base: None,
            entries: VecDeque::new(),
            msgs: BTreeMap::new(),
            stop: None,
            touchers: HashMap::new(),
            tip: None,
            arrived: BTreeMap::new(),
            over_budget_seq: None,
            route_pools: None,
            hour: AheadStats::default(),
            total: AheadStats::default(),
        }
    }

    /// The pools we follow (rebuilt by the caller when copy 2's registry changes).
    pub fn set_pools(&mut self, p: Arc<PoolSet>) {
        self.pools = p;
    }

    pub fn pools(&self) -> &PoolSet {
        &self.pools
    }

    /// The pools the scanner's routes use (FASTLANE_AHEAD_ROUTES_ONLY);
    /// None = unknown (everything picked runs).
    pub fn set_route_pools(&mut self, p: Option<Arc<HashSet<String>>>) {
        self.route_pools = p;
    }

    /// The predicted tip: state after the NEWEST feed message held, or None
    /// (nothing predicted yet, waiting for a missing message, stopped).
    pub fn tip(&self) -> Option<Arc<AheadTip>> {
        self.tip.clone()
    }

    /// Predicted blocks held (bounded by max_blocks).
    pub fn depth(&self) -> usize {
        self.entries.len()
    }

    /// Feed messages held (bounded by max_blocks + a little).
    pub fn held_msgs(&self) -> usize {
        self.msgs.len()
    }

    /// The confirmed version's sequence number.
    pub fn base_seq(&self) -> Option<u64> {
        self.base.as_ref().map(|b| b.seq)
    }

    /// Why prediction is stopped, if it is.
    pub fn stopped(&self) -> Option<(u64, &'static str)> {
        self.stop.as_ref().map(|s| (s.seq, s.why))
    }

    /// Learned toucher addresses (status / tests).
    pub fn is_toucher(&self, a: &Address) -> bool {
        self.touchers.contains_key(a)
    }

    fn count(&mut self, f: impl Fn(&mut AheadStats)) {
        f(&mut self.hour);
        f(&mut self.total);
    }

    fn learn_toucher(&mut self, a: Address, pools: &[String]) {
        if self.touchers.len() >= self.cfg.max_touchers && !self.touchers.contains_key(&a) {
            // Drop the oldest quarter (bounded memory, cheap).
            let mut v: Vec<(Address, Instant)> = self.touchers.iter().map(|(a, t)| (*a, t.0)).collect();
            v.sort_by_key(|x| x.1);
            for (x, _) in v.iter().take(self.cfg.max_touchers / 4 + 1) {
                self.touchers.remove(x);
            }
        }
        let e = self.touchers.entry(a).or_insert_with(|| (Instant::now(), Vec::new()));
        e.0 = Instant::now();
        for k in pools {
            // Bounded: a router remembers at most 64 of our pools.
            if !e.1.contains(k) && e.1.len() < 64 {
                e.1.push(k.clone());
            }
        }
    }

    /// A new feed message (one L2 block).
    pub fn on_feed_message(&mut self, m: Arc<BinMsg>) {
        self.on_feed_message_at(m, Instant::now());
    }

    /// `on_feed_message` with the time the message reached arbsim.
    pub fn on_feed_message_at(&mut self, m: Arc<BinMsg>, at: Instant) {
        self.count(|s| s.msgs += 1);
        if self.arrived.len() > self.cfg.max_blocks * 4 {
            let cut = self.arrived.keys().nth(self.arrived.len() - self.cfg.max_blocks * 2).copied().unwrap_or(0);
            self.arrived = self.arrived.split_off(&cut);
        }
        self.arrived.entry(m.seq).or_insert(at);
        if let Some(b) = &self.base {
            if m.seq <= b.seq {
                // Copy 2 already confirmed it (the feed was slower this time).
                self.count(|s| s.late_msgs += 1);
                return;
            }
        }
        self.msgs.entry(m.seq).or_insert(m);
        self.trim_msgs();
        self.extend();
        if self.stop.is_some() {
            // No tip for this message: counted for the "stopped %" share.
            self.count(|s| s.msgs_stopped += 1);
        }
    }

    /// Bounded: keep only the newest messages (2 x max_blocks).
    fn trim_msgs(&mut self) {
        let cap = self.cfg.max_blocks * 2;
        while self.msgs.len() > cap {
            let Some(k) = self.msgs.keys().next().copied() else { break };
            self.msgs.remove(&k);
        }
    }

    /// Copy 2 published a version (normally block N's reports applied).
    /// `moved_by_tx`: copy 2's RECENT MOVES (tx hash -> pools its reports
    /// moved), to learn which skipped transactions we should have run.
    pub fn on_confirmed(&mut self, c: Confirmed, moved_by_tx: &dyn Fn(&B256) -> Option<Vec<String>>) {
        if let Some(b) = &self.base {
            if c.seq < b.seq {
                return;
            }
            if c.seq == b.seq && Arc::ptr_eq(&c.snap, &b.snap) {
                return;
            }
        }
        // (The very first version has nothing to compare with.)
        let first_time = self.base.as_ref().is_some_and(|b| c.seq > b.seq);
        // Review M3/L1: every predicted block this version covers (several
        // may confirm at once): its skipped transactions are checked against
        // copy 2's reports, not only the last one's.
        let covered: Vec<usize> = (0..self.entries.len()).filter(|i| self.entries[*i].seq <= c.seq).collect();
        for i in covered {
            let skipped = std::mem::take(&mut self.entries[i].skipped);
            self.learn_skipped(skipped, moved_by_tx);
        }
        if first_time {
            self.agreement(&c, moved_by_tx);
        }
        self.count(|s| s.rebases += 1);
        let seq = c.seq;
        self.base = Some(c);
        self.entries.clear();
        self.tip = None;
        self.stop = None;
        // H-1: a message that ran past the budget is not tried again until
        // this copy has confirmed it (the stop stays, not counted again).
        match self.over_budget_seq {
            Some(s) if s > seq => self.stop = Some(Stop { seq: s, why: "msg_budget" }),
            _ => self.over_budget_seq = None,
        }
        self.msgs = self.msgs.split_off(&(seq + 1));
        let before = self.hour.applied;
        self.extend();
        let n = self.hour.applied - before;
        self.count(|s| s.reapplied += n);
    }

    /// AGREEMENT (see the file header): our prediction for block c.seq vs
    /// the confirmed version, per pool that changed in either.
    fn agreement(&mut self, c: &Confirmed, moved_by_tx: &dyn Fn(&B256) -> Option<Vec<String>>) {
        let Some(i) = self.entries.iter().position(|e| e.seq == c.seq) else {
            self.count(|s| s.unpredicted += 1);
            return;
        };
        // L1 (review): only a version that is exactly ONE block after the
        // previous confirmed one is compared. A jump of several blocks
        // (copy 2 confirmed N-2..N at once and published only N) has a diff
        // for block N alone, while our prediction moved pools across all of
        // them: comparing would miscount. Those are counted "unpredicted".
        // (The runtime hands every published version in order, so jumps are rare.)
        if self.base.as_ref().is_some_and(|b| c.seq != b.seq + 1) {
            self.count(|s| s.unpredicted += 1);
            return;
        }
        self.count(|s| s.compared += 1);
        let pools = self.pools.clone();
        let conf_moved: HashSet<String> = pools.moved_by_diff(&c.diff).into_iter().collect();
        let e = &self.entries[i];
        let mut all: Vec<&String> = conf_moved.iter().chain(e.changed_cum.iter()).collect();
        all.sort();
        all.dedup();
        let mut res: Vec<(String, &'static str)> = Vec::new();
        for k in all {
            if e.unsure_cum.contains(k) {
                res.push((k.clone(), "unsure"));
                continue;
            }
            let Some(place) = pools.places.get(k) else { continue };
            let same = same_state(*place, &e.snap, &c.snap);
            let kind = match (same, conf_moved.contains(k), e.changed_cum.contains(k)) {
                (true, _, _) => "agree",
                (false, true, false) => {
                    // Practice fixes: WHY did we miss it? Copy 2's reports
                    // say which transaction moved it; find it in this message.
                    let by = e.fates.iter().find(|(h, _)| moved_by_tx(h).is_some_and(|p| p.iter().any(|x| x.eq_ignore_ascii_case(k))));
                    match by {
                        None => "notFromTx",
                        Some((_, Fate::Skipped)) => "missedFilter",
                        Some(_) => "missedRan",
                    }
                }
                (false, false, true) => "phantom",
                (false, _, _) => "value",
            };
            res.push((k.clone(), kind));
        }
        let block = c.seq + self.cfg.l2_offset;
        for (k, kind) in res {
            match kind {
                "agree" => self.count(|s| s.agree += 1),
                "unsure" => self.count(|s| s.unsure += 1),
                // Not a prediction miss (no transaction of this message moved
                // it): counted on its own, never as a disagreement.
                "notFromTx" => self.count(|s| s.not_from_tx += 1),
                _ => {
                    self.count(|s| {
                        s.disagree += 1;
                        match kind {
                            "missedFilter" => {
                                s.missed += 1;
                                s.missed_filter += 1;
                            }
                            "missedRan" => {
                                s.missed += 1;
                                s.missed_ran += 1;
                            }
                            "phantom" => s.phantom += 1,
                            _ => s.value_diff += 1,
                        }
                    });
                    if self.hour.samples.len() < MAX_SAMPLES {
                        self.hour.samples.push(json!({ "pool": k, "block": block, "kind": kind }));
                    }
                }
            }
        }
    }

    /// Skipped transactions copy 2's reports say moved our pools: the
    /// filter missed them. Learn their target (and the pools) for next time.
    fn learn_skipped(&mut self, skipped: Vec<(B256, Option<Address>)>, moved_by_tx: &dyn Fn(&B256) -> Option<Vec<String>>) {
        for (h, to) in skipped {
            if let Some(p) = moved_by_tx(&h).filter(|p| !p.is_empty()) {
                self.count(|s| s.filter_missed += 1);
                if let Some(t) = to {
                    self.learn_toucher(t, &p);
                }
            }
        }
    }

    /// Apply every held message that follows the predicted tip.
    fn extend(&mut self) {
        let Some(base) = self.base.clone() else { return };
        if self.stop.is_some() {
            return;
        }
        loop {
            let tip_seq = self.entries.back().map_or(base.seq, |e| e.seq);
            let next = tip_seq + 1;
            let Some(m) = self.msgs.get(&next).cloned() else { break };
            if self.entries.len() >= self.cfg.max_blocks {
                // The confirmed copy is too far behind: stop (no tip).
                self.halt(next, "behind");
                return;
            }
            match self.apply(&base, &m) {
                Ok(e) => {
                    self.count(|s| s.applied += 1);
                    let us = e.apply_us;
                    self.count(|s| s.add_time(us));
                    self.entries.push_back(e);
                }
                Err(why) => {
                    if why == "msg_budget" {
                        self.count(|s| s.over_budget += 1);
                        self.over_budget_seq = Some(next);
                    }
                    self.halt(next, why);
                    return;
                }
            }
        }
        // The tip only when it is the newest message held (no gap waiting).
        let newest = self.msgs.keys().next_back().copied();
        self.tip = match (self.entries.back(), newest) {
            (Some(e), Some(n)) if e.seq == n => Some(Arc::new(self.tip_of(e, &base))),
            _ => None,
        };
    }

    fn halt(&mut self, seq: u64, why: &'static str) {
        self.count(|s| s.stop(why));
        self.stop = Some(Stop { seq, why });
        self.tip = None;
    }

    fn tip_of(&self, e: &Entry, base: &Confirmed) -> AheadTip {
        let mut unsure: Vec<String> = e.unsure_cum.iter().chain(self.pools.not_ready.iter()).cloned().collect();
        unsure.sort();
        unsure.dedup();
        let unsure_set = Arc::new(unsure.iter().cloned().collect());
        AheadTip {
            seq: e.seq,
            block: e.seq + self.cfg.l2_offset,
            base_seq: base.seq,
            snap: e.snap.clone(),
            ctx: e.ctx.clone(),
            changed_pools: e.changed.clone(),
            unsure_pools: unsure,
            unsure_set,
            built_at: e.built_at,
            apply_us: e.apply_us,
            feed_at: e.feed_at,
        }
    }

    /// Apply one message on top of the predicted tip (or the base).
    fn apply(&mut self, base: &Confirmed, m: &BinMsg) -> Result<Entry, &'static str> {
        let t0 = Instant::now();
        let (prev_snap, prev_ctx, mut changed_cum, mut unsure_cum) = match self.entries.back() {
            Some(e) => (e.snap.clone(), e.ctx.clone(), e.changed_cum.clone(), e.unsure_cum.clone()),
            None => (base.snap.clone(), base.ctx.clone().ok_or("no_block_details")?, HashSet::new(), HashSet::new()),
        };
        // Deposits / retryables / anything we can't unpack: we can't know
        // what it does to our pools. Never guessed: stop until confirmed.
        if !m.complete || m.bad.is_some() {
            return Err("unreplayable_msg");
        }
        if m.ts == 0 {
            return Err("no_block_time");
        }
        if m.txs.len() > self.cfg.max_txs {
            return Err("too_many_txs");
        }
        // This block's details (same rules as check/ordered.rs build_plan:
        // Nitro never lets time or the parent-chain block go backwards).
        let ctx = BlockCtx {
            l1_block_number: m.l1.max(prev_ctx.l1_block_number),
            l2_block_number: prev_ctx.l2_block_number.map(|_| m.seq + self.cfg.l2_offset),
            timestamp: m.ts.max(prev_ctx.timestamp),
            basefee: 0,
            coinbase: prev_ctx.coinbase,
            gas_limit: prev_ctx.gas_limit,
            prevrandao: prev_ctx.prevrandao,
        };
        // Decode everything first: a transaction we can't even read (a kind
        // we don't replay) could do anything: stop until confirmed.
        let mut txs: Vec<DecodedTx> = Vec::with_capacity(m.txs.len());
        for t in &m.txs {
            txs.push(t.decoded().map_err(|_| "undecodable_tx")?);
        }
        let mut ov = Overlay::new((*prev_snap).clone());
        let pools = self.pools.clone();
        let assume = Assume { sender_funds: true, recent_fill: true, skip: None, record_hashes: true };
        let mut changed: Vec<String> = Vec::new();
        let mut skipped: Vec<(B256, Option<Address>)> = Vec::new();
        let mut fates: Vec<(B256, Fate)> = Vec::with_capacity(txs.len());
        // Marks pools unsure in this view: their values forgotten (reads
        // Missing), listed changed (the scanner looks again) and unsure.
        let mark_unsure = |ov: &mut Overlay, changed: &mut Vec<String>, changed_cum: &mut HashSet<String>, unsure_cum: &mut HashSet<String>, keys: &[String]| {
            for k in keys {
                if let Some(p) = pools.places.get(k) {
                    forget_place(ov, *p);
                }
                if !changed.contains(k) {
                    changed.push(k.clone());
                }
                changed_cum.insert(k.clone());
                unsure_cum.insert(k.clone());
            }
        };
        for (i, t) in txs.iter().enumerate() {
            // H-1: per-message time budget, looked at before every
            // transaction after the first (one run is never cut in half).
            if i > 0 && t0.elapsed().as_micros() as u64 > self.cfg.msg_budget_us {
                return Err("msg_budget");
            }
            // One pass over the data finds everything of ours it names.
            let named_now = if self.cfg.run_all { Named::default() } else { pools.scan(&t.data) };
            let native = if self.cfg.run_all { Vec::new() } else { pools.named_native(t.value, &named_now) };
            let toucher = t.to.is_some_and(|a| self.touchers.contains_key(&a));
            let plain = self.cfg.run_all || pools.may_touch(t.to, &named_now) || toucher;
            if !plain && !native.is_empty() {
                self.count(|s| s.native_picks += 1);
            }
            let pick = plain || !native.is_empty();
            if !pick {
                self.count(|s| s.txs_skipped += 1);
                skipped.push((t.hash, t.to));
                fates.push((t.hash, Fate::Skipped));
                continue;
            }
            // FASTLANE_AHEAD_ROUTES_ONLY: picked only for naming pools no
            // route uses (not a learned router, no V4 PoolManager): not run,
            // those pools marked unsure (the scanner never reads them).
            if self.cfg.routes_only && !self.cfg.run_all && !toucher {
                if let Some(rp) = &self.route_pools {
                    if !pools.names_pm(t.to, &named_now) {
                        let mut named = pools.named(t.to, &named_now);
                        for k in &native {
                            if !named.contains(k) {
                                named.push(k.clone());
                            }
                        }
                        if !named.is_empty() && named.iter().all(|k| !rp.contains(k)) {
                            self.count(|s| s.txs_off_route += 1);
                            mark_unsure(&mut ov, &mut changed, &mut changed_cum, &mut unsure_cum, &named);
                            fates.push((t.hash, Fate::OffRoute));
                            continue;
                        }
                    }
                }
            }
            self.count(|s| s.txs_run += 1);
            let plan = OrderedPlan { msgs: vec![PlanMsg { seq: m.seq, ctx: ctx.clone(), txs: vec![t.clone()] }], trigger: t.hash, call_ctx: ctx.clone() };
            match run_ordered_keep(&ov, &plan, base.prov.as_ref(), &assume) {
                Ok((out, kept)) => {
                    fates.push((t.hash, Fate::Ran));
                    if !out.assumed.labels().is_empty() {
                        self.count(|s| s.assumed += 1);
                    }
                    // Review M1: built on a value we only assumed (a fill
                    // re-read every minute, or a sender's funds): what it
                    // moved can't be vouched for. Its pools become unsure.
                    let a = &out.assumed;
                    let shaky = a.recent_fill || a.call_fill || (a.sender_funds && !self.cfg.trust_sender_funds);
                    ov.commit(&kept.diff);
                    for (a, s) in &kept.forget {
                        ov.forget_slot(*a, *s);
                    }
                    let moved: Vec<String> = pools.moved.moved(&out.changed, &out.hashes).into_iter().map(|x| x.key).collect();
                    if !moved.is_empty() {
                        if let Some(a) = t.to {
                            self.learn_toucher(a, &moved);
                        }
                    }
                    if shaky && !moved.is_empty() {
                        self.count(|s| s.assumed_unsure += 1);
                        for k in &moved {
                            if let Some(p) = pools.places.get(k) {
                                forget_place(&mut ov, *p);
                            }
                            unsure_cum.insert(k.clone());
                        }
                    }
                    for k in moved {
                        // Values forgotten earlier stay forgotten (a later
                        // exact write puts back only what it wrote).
                        if !changed.contains(&k) {
                            changed.push(k.clone());
                        }
                        changed_cum.insert(k);
                    }
                }
                Err(_) => {
                    fates.push((t.hash, Fate::Failed));
                    self.count(|s| s.txs_failed += 1);
                    // Which of our pools might it touch? What it reads in a
                    // collect run + what it names. Those become unsure.
                    // Practice fixes: the collect run is skipped when the
                    // target has no code in our copy (it could only read
                    // zero there and stop: nothing of ours, same answer).
                    let mut hit = if target_has_no_code(&ov, t.to) {
                        self.count(|s| s.probes_skipped += 1);
                        Vec::new()
                    } else {
                        probe_touched(&ov, &ctx, t, &pools)
                    };
                    for k in pools.named(t.to, &named_now).into_iter().chain(native.iter().cloned()) {
                        if !hit.contains(&k) {
                            hit.push(k);
                        }
                    }
                    if hit.is_empty() {
                        // Review H4: it failed and nothing tells us what it
                        // would touch (router code or state missing). Never
                        // assume "nothing": the pools its target moved
                        // before; else (practice fixes) when it names a V4
                        // PoolManager, that PoolManager's pools of ours
                        // sharing a coin it names (before: every pool of any
                        // kind sharing a coin, i.e. all WETH / USDG pools);
                        // else our pools sharing a coin it names; if none of
                        // that is known, stop until confirmed.
                        self.count(|s| s.failed_unknown += 1);
                        hit = t.to.and_then(|a| self.touchers.get(&a)).map(|x| x.1.clone()).unwrap_or_default();
                        if hit.is_empty() && pools.names_pm(t.to, &named_now) {
                            hit = pools.v4_sharing_named_coins(t.to, &named_now);
                            if !hit.is_empty() {
                                self.count(|s| s.v4_fallback += 1);
                            }
                        }
                        if hit.is_empty() {
                            hit = pools.sharing_named_coins(&named_now);
                        }
                        if hit.is_empty() {
                            return Err("failed_tx_unknown_effect");
                        }
                    }
                    self.count(|s| s.txs_marked += 1);
                    if let Some(a) = t.to {
                        self.learn_toucher(a, &hit);
                    }
                    mark_unsure(&mut ov, &mut changed, &mut changed_cum, &mut unsure_cum, &hit);
                }
            }
        }
        changed.sort();
        ov.set_position(StatePosition { base_block: base.seq + self.cfg.l2_offset, after_seq: Some(m.seq) });
        let (snap, _) = ov.into_parts();
        Ok(Entry {
            seq: m.seq,
            snap: Arc::new(snap),
            ctx,
            changed,
            changed_cum,
            unsure_cum,
            skipped,
            fates,
            built_at: Instant::now(),
            apply_us: t0.elapsed().as_micros() as u64,
            feed_at: self.arrived.get(&m.seq).copied().unwrap_or(t0),
        })
    }
}

/// Forget one pool's own state in the predicted copy (strict: reads of it
/// are then Missing, never a stale or made-up value).
fn forget_place(ov: &mut Overlay, p: Place) {
    match p {
        Place::Contract(a) => ov.forget(a),
        Place::V4(pm, base) => {
            for k in 0..4u8 {
                ov.forget_slot(pm, base + U256::from(k));
            }
        }
    }
}

/// Same state of one pool in both copies? Compared on the values the
/// CONFIRMED copy holds (its own declared values / V4 base values). A value
/// we hold differently, or don't hold, is a difference.
fn same_state(p: Place, pred: &Snapshot, conf: &Snapshot) -> bool {
    match p {
        Place::Contract(a) => {
            let Some(acc) = conf.accounts.get(&a) else {
                // Confirmed copy forgot it (unsure there): ours must too.
                return pred.accounts.get(&a).is_none_or(|x| x.storage.is_empty());
            };
            acc.storage
                .iter()
                .filter(|(s, _)| **s < U256::from(DECLARED_MAX))
                .all(|(s, v)| pred.storage(a, *s) == Lookup::Known(*v))
        }
        Place::V4(pm, base) => (0..4u8).all(|k| {
            let s = base + U256::from(k);
            match conf.storage(pm, s) {
                Lookup::Known(v) => pred.storage(pm, s) == Lookup::Known(v),
                Lookup::Missing => true,
            }
        }),
    }
}

/// No code at the target in our copy (missing, empty or a plain account):
/// a collect run would read zero there and stop, touching nothing of ours.
/// A contract creation (no target) runs its own code: never skipped.
fn target_has_no_code(view: &dyn StateRead, to: Option<Address>) -> bool {
    let Some(a) = to else { return false };
    match view.account(a) {
        Lookup::Missing | Lookup::Known(None) => true,
        Lookup::Known(Some(info)) => info.code_hash == KECCAK_EMPTY || info.code_hash == B256::ZERO,
    }
}

/// A transaction we couldn't run exactly: run it once more in COLLECT mode
/// (a missing value reads as zero just to keep going; NOTHING of this run
/// is kept) and write down every account / value it read. Our pools among
/// them are the ones it may touch. Never asks the node.
fn probe_touched(view: &dyn StateRead, ctx: &BlockCtx, t: &DecodedTx, pools: &PoolSet) -> Vec<String> {
    let ov = Overrides::none();
    let mut s = Session::new(view, ctx, &ov, CheckOptions::default());
    s.db().set_recording(true);
    if matches!(view.account(t.from), Lookup::Missing) {
        s.db().add_pretend(t.from, AccountInfo { balance: t.value, nonce: t.nonce, code_hash: KECCAK_EMPTY, ..Default::default() });
    }
    let _ = s.apply_decoded(t);
    let reads = std::mem::take(&mut s.db().reads);
    pools.touched_by(&reads.accounts, &reads.slots)
}

// ---------------------------------------------------------------------------
// Runtime: one light thread in the running sidecar (only when FASTLANE is on)
// ---------------------------------------------------------------------------

enum Ev {
    /// A feed message and when it reached arbsim.
    Feed(Arc<BinMsg>, Instant),
    Confirmed,
}

struct Runtime {
    tx: SyncSender<Ev>,
    /// (tip number, tip): the number goes up by one per NEW tip, so a
    /// waiter (the fast lane, fastlane/lane.rs) sees each tip once.
    tip: Mutex<(u64, Option<Arc<AheadTip>>)>,
    /// Woken on every new tip (no busy polling).
    tip_cv: std::sync::Condvar,
    status: Mutex<Value>,
    /// Prediction counts this hour (agreement and the shares around it),
    /// for the practice line.
    agreement: Mutex<PredictionCounts>,
    dropped: std::sync::atomic::AtomicU64,
}

static RT: OnceLock<Runtime> = OnceLock::new();

/// Start the predicted copy for this sidecar (copy 2 mode). Does nothing
/// and returns false when FASTLANE is off (the default).
pub fn start(c2: super::intake::Copy2Handle) -> bool {
    start_with(mode(), c2, AheadCfg::from_lookup(|k| std::env::var(k).ok(), 0))
}

/// `start` with the mode given (tests: Off must start nothing).
pub fn start_with(m: Mode, c2: super::intake::Copy2Handle, mut cfg: AheadCfg) -> bool {
    if m == Mode::Off || RT.get().is_some() {
        return false;
    }
    cfg.l2_offset = c2.sh.cfg.l2_offset;
    let (tx, rx) = std::sync::mpsc::sync_channel::<Ev>(4096);
    if RT.set(Runtime { tx, tip: Mutex::new((0, None)), tip_cv: std::sync::Condvar::new(), status: Mutex::new(json!({})), agreement: Mutex::new(PredictionCounts::default()), dropped: Default::default() }).is_err() {
        return false;
    }
    eprintln!(
        "[arbsim] fastlane ahead: predicted copy ON (FASTLANE={}); max {} blocks, filter {}, zero node reads",
        if m == Mode::Live { "live" } else { "practice" },
        cfg.max_blocks,
        if cfg.run_all { "all" } else { "smart" }
    );
    std::thread::Builder::new()
        .name("arbsim-ahead".into())
        .spawn(move || {
            // H-1: lower CPU priority (FASTLANE_NICE, default 10): copy 2
            // and the bot's own checks always come first on the 2 CPUs.
            crate::fastlane::mode::lower_this_thread_from_env("arbsim-ahead");
            run_loop(c2, cfg, rx)
        })
        .is_ok()
}

/// check/feedstore.rs: new feed messages stored (no-op when off).
pub fn feed_hook(added: &[Arc<BinMsg>]) {
    let Some(rt) = RT.get() else { return };
    let at = Instant::now();
    for m in added {
        if rt.tx.try_send(Ev::Feed(m.clone(), at)).is_err() {
            rt.dropped.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
}

/// copy2/intake.rs: a version was published (no-op when off).
pub fn confirmed_hook() {
    if let Some(rt) = RT.get() {
        let _ = rt.tx.try_send(Ev::Confirmed);
    }
}

/// The running sidecar's predicted tip (None when off / not ready).
pub fn global_tip() -> Option<Arc<AheadTip>> {
    RT.get().and_then(|rt| rt.tip.lock().unwrap_or_else(|e| e.into_inner()).1.clone())
}

/// Wait (at most `timeout`) for a tip newer than number `after`. Returns
/// (its number, the tip). None = timed out / off. The fast lane's thread
/// sleeps here between blocks: no busy polling.
pub fn wait_tip(after: u64, timeout: Duration) -> Option<(u64, Arc<AheadTip>)> {
    let rt = RT.get()?;
    let g = rt.tip.lock().unwrap_or_else(|e| e.into_inner());
    let (g, _) = rt.tip_cv.wait_timeout_while(g, timeout, |t| t.0 <= after || t.1.is_none()).unwrap_or_else(|e| e.into_inner());
    if g.0 > after {
        g.1.clone().map(|t| (g.0, t))
    } else {
        None
    }
}

/// (agree, disagree) of the prediction so far this hour (practice line).
/// None = off.
pub fn agreement_counts() -> Option<(u64, u64)> {
    prediction_counts().map(|c| (c.agree, c.disagree))
}

/// The prediction counts so far this hour (practice line). None = off.
pub fn prediction_counts() -> Option<PredictionCounts> {
    RT.get().map(|rt| *rt.agreement.lock().unwrap_or_else(|e| e.into_inner()))
}

/// status "fastlaneAhead" (None when off).
pub fn status_json() -> Option<Value> {
    let rt = RT.get()?;
    let mut v = rt.status.lock().unwrap_or_else(|e| e.into_inner()).clone();
    v["dropped"] = json!(rt.dropped.load(std::sync::atomic::Ordering::Relaxed));
    Some(v)
}

/// The pools copy 2 follows, from its registry: (pool, token0, token1)
/// sorted by key, plus the keys not ready. Only COPIED under the registry's
/// read lock (review M2); the lookup tables are built outside it, and only
/// when this list changed.
type PoolList = (Vec<(FollowedPool, Address, Address)>, Vec<String>);
fn pool_list(c2: &super::intake::Copy2Handle) -> PoolList {
    let reg = c2.c2.reg.read().unwrap_or_else(|e| e.into_inner());
    let mut list = Vec::with_capacity(reg.pools.len());
    let mut not_ready = Vec::new();
    for (pk, e) in &reg.pools {
        let key = match pk.1 {
            Some(id) => format!("{id:#x}"),
            None => format!("{:#x}", e.pool.address),
        };
        if e.state != super::intake::PoolState::Ready {
            not_ready.push(key.clone());
        }
        list.push((FollowedPool { key, address: e.pool.address, v4_id: pk.1 }, e.pool.token0, e.pool.token1));
    }
    drop(reg);
    list.sort_by(|a, b| a.0.key.cmp(&b.0.key));
    not_ready.sort();
    (list, not_ready)
}

fn same_list(a: &PoolList, b: &PoolList) -> bool {
    a.1 == b.1 && a.0.len() == b.0.len() && a.0.iter().zip(&b.0).all(|(x, y)| x.0.key == y.0.key && x.0.address == y.0.address && x.0.v4_id == y.0.v4_id && x.1 == y.1 && x.2 == y.2)
}

fn run_loop(c2: super::intake::Copy2Handle, cfg: AheadCfg, rx: Receiver<Ev>) {
    let mut a = Ahead::new(cfg);
    let mut reg_gen = u64::MAX;
    let mut list: PoolList = (Vec::new(), Vec::new());
    let mut head: Option<Arc<crate::state::mirror::Version>> = None;
    let mut hour_start = Instant::now();
    let mut last_status = Instant::now();
    // Practice fixes: copy 2's registry changes on EVERY applied pool report
    // (its counters live there), so the pool list was copied (~1,800 keys)
    // on every wake-up. Now at most once a second. (Safe: a pool copy 2
    // marks unsure in between still gets "unknown" from every check run
    // with copy 2's rules, fastlane/c2runner.rs.)
    let mut pools_at: Option<Instant> = None;
    // The route pools (FASTLANE_AHEAD_ROUTES_ONLY), rebuilt when the bot's
    // candidate table changes (about once a second at most).
    let mut table_gen: Option<u64> = None;
    loop {
        // Review M2: no idle polling. Woken by a feed message or a published
        // version (confirmed_hook); the 1 s timeout only drives the status
        // copy and the hourly line.
        let ev = rx.recv_timeout(Duration::from_secs(1));
        if matches!(ev, Err(RecvTimeoutError::Disconnected)) {
            return;
        }
        // Pools: looked at only when copy 2's registry changed, and the
        // lookup tables rebuilt only when the pool list / readiness changed.
        let g = c2.c2.reg.gen();
        if g != reg_gen && pools_at.is_none_or(|t| t.elapsed() >= Duration::from_secs(1)) {
            reg_gen = g;
            pools_at = Some(Instant::now());
            let now = pool_list(&c2);
            if !same_list(&now, &list) || a.pools().is_empty() {
                list = now;
                a.set_pools(Arc::new(PoolSet::build(&list.0, list.1.iter().cloned().collect())));
            }
        }
        let tg = crate::check::entry::table_gen();
        if tg != table_gen {
            table_gen = tg;
            a.set_route_pools(crate::check::entry::route_keys().map(|(_, k)| Arc::new(k)).filter(|k| !k.is_empty()));
        }
        // Confirmed first (a new version may already cover a feed message).
        // Every version published since the last one, in order (review L1:
        // agreement is per block; a jump would miscount).
        let pv = c2.sh.published.view();
        let newer: Vec<Arc<crate::state::mirror::Version>> = match &head {
            None => pv.head().cloned().into_iter().collect(),
            Some(h) if pv.head().is_some_and(|x| Arc::ptr_eq(x, h)) => Vec::new(),
            Some(h) => pv.versions.iter().filter(|v| v.seq > h.seq).cloned().collect(),
        };
        if !newer.is_empty() {
            // The registry summary for the readers' copy we just took (no
            // rebuild while it is current; review M2: never `core_for(None)`).
            let core = c2.core_for(Some(&pv));
            for v in newer {
                head = Some(v.clone());
                // Same cache key (head block, no extra holders) the head's
                // own checks use, so this never pushes theirs out.
                let prov = c2.provenance_with(&core, v.block, &[]);
                let prov: Arc<dyn Provenance + Send + Sync> = prov;
                let conf = Confirmed { seq: v.seq, snap: v.snap.clone(), ctx: v.ctx.clone(), diff: v.diff.clone(), prov };
                let rm = &c2.c2.recent_moves;
                a.on_confirmed(conf, &|h| rm.lock().ok().and_then(|r| r.pools_of(h)));
            }
        }
        if let Ok(Ev::Feed(m, at)) = ev {
            a.on_feed_message_at(m, at);
            // Everything queued, in order (a burst after a reconnect).
            while let Ok(e) = rx.try_recv() {
                if let Ev::Feed(m, at) = e {
                    a.on_feed_message_at(m, at);
                }
            }
        }
        if let Some(rt) = RT.get() {
            {
                let mut t = rt.tip.lock().unwrap_or_else(|e| e.into_inner());
                let now = a.tip();
                let new = match (&t.1, &now) {
                    (Some(x), Some(y)) => !Arc::ptr_eq(x, y),
                    (None, Some(_)) => true,
                    _ => false,
                };
                if new {
                    t.0 += 1;
                }
                t.1 = now;
                if new {
                    rt.tip_cv.notify_all();
                }
            }
            *rt.agreement.lock().unwrap_or_else(|e| e.into_inner()) = a.hour.shares();
            if last_status.elapsed() >= Duration::from_secs(1) {
                last_status = Instant::now();
                *rt.status.lock().unwrap_or_else(|e| e.into_inner()) = status_of(&a);
            }
        }
        if hour_start.elapsed() >= Duration::from_secs(3600) {
            hour_start = Instant::now();
            eprintln!("{}", a.hour.line());
            a.hour = AheadStats::default();
        }
    }
}

fn status_of(a: &Ahead) -> Value {
    let tip = a.tip();
    json!({
        "baseSeq": a.base_seq(), "depth": a.depth(), "heldMsgs": a.held_msgs(), "pools": a.pools().len(),
        "tip": tip.as_ref().map(|t| json!({"seq": t.seq, "block": t.block, "changed": t.changed_pools.len(), "unsure": t.unsure_pools.len(), "applyUs": t.apply_us, "ageMs": t.built_at.elapsed().as_millis() as u64})),
        "stopped": a.stopped().map(|(s, w)| json!({"seq": s, "why": w})),
        "touchers": a.touchers.len(),
        "hour": a.hour.json(), "total": a.total.json(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fastlane_words_match_workstream_d() {
        for (w, m) in [(None, Mode::Off), (Some(""), Mode::Off), (Some("off"), Mode::Off), (Some(" Practice "), Mode::Practice), (Some("shadow"), Mode::Practice), (Some("dry"), Mode::Practice), (Some("LIVE"), Mode::Live), (Some("yes"), Mode::Off)] {
            assert_eq!(parse_mode(w), m, "{w:?}");
        }
    }

    /// Tiny deterministic random numbers (no extra crate).
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 11
        }
        fn addr(&mut self) -> Address {
            let mut b = [0u8; 20];
            for x in b.iter_mut() {
                *x = self.next() as u8;
            }
            Address::from(b)
        }
    }

    fn sorted(mut v: Vec<String>) -> Vec<String> {
        v.sort();
        v
    }

    /// Practice fixes: the one-pass name index gives EXACTLY the answers of
    /// the old per-pool search (route.named_by and the three "named"
    /// helpers), on random data with our addresses / ids / coins planted at
    /// random byte offsets (aligned or not), plus addresses sharing the
    /// index's 4-byte prefixes.
    #[test]
    fn name_index_matches_the_old_search_exactly() {
        let mut r = Lcg(42);
        let coins: Vec<Address> = (0..40).map(|_| r.addr()).collect();
        let pm = r.addr();
        let mut list = Vec::new();
        for i in 0..400u64 {
            let t0 = if i % 17 == 0 { Address::ZERO } else { coins[(r.next() % 40) as usize] };
            let t1 = coins[(r.next() % 40) as usize];
            if i % 5 == 0 {
                let mut id = [0u8; 32];
                for x in id.iter_mut() {
                    *x = r.next() as u8;
                }
                let id = B256::from(id);
                list.push((FollowedPool { key: format!("{id:#x}"), address: pm, v4_id: Some(id) }, t0, t1));
            } else {
                let a = r.addr();
                list.push((FollowedPool { key: format!("{a:#x}"), address: a, v4_id: None }, t0, t1));
            }
        }
        let set = PoolSet::build(&list, HashSet::new());
        let needles: Vec<Vec<u8>> = list
            .iter()
            .flat_map(|(p, a, b)| {
                let mut v = vec![p.address.to_vec(), a.to_vec(), b.to_vec()];
                if let Some(id) = p.v4_id {
                    v.push(id.to_vec());
                }
                v
            })
            .collect();
        let mut hits = 0;
        for case in 0..3000 {
            let len = (r.next() % 700) as usize;
            let mut data: Vec<u8> = (0..len).map(|_| r.next() as u8).collect();
            for _ in 0..(r.next() % 4) {
                let n = &needles[(r.next() as usize) % needles.len()];
                if data.len() >= n.len() {
                    let at = (r.next() as usize) % (data.len() - n.len() + 1);
                    // Every 3rd: only the first 4 bytes (a prefix false alarm).
                    let k = if case % 3 == 0 { 4 } else { n.len() };
                    data[at..at + k].copy_from_slice(&n[..k]);
                }
            }
            let to = match r.next() % 4 {
                0 => Some(list[(r.next() as usize) % list.len()].0.address),
                1 => None,
                _ => Some(r.addr()),
            };
            let value = if r.next() % 2 == 0 { U256::ZERO } else { U256::from(1u8) };
            let n = set.scan(&data);
            assert_eq!(set.may_touch(to, &n), set.may_touch_slow(to, &data), "case {case}: to {to:?} found {n:?} named {:?}", set.named_slow(to, &data));
            assert_eq!(sorted(set.named(to, &n)), sorted(set.named_slow(to, &data)), "case {case}");
            assert_eq!(sorted(set.named_native(value, &n)), sorted(set.named_native_slow(value, &data)), "case {case}");
            assert_eq!(sorted(set.sharing_named_coins(&n)), sorted(set.sharing_named_coins_slow(&data)), "case {case}");
            if set.may_touch(to, &n) {
                hits += 1;
            }
        }
        assert!(hits > 500, "the random cases really hit our pools ({hits})");
    }

    /// Practice fixes: a failed transaction naming a V4 PoolManager and a
    /// coin marks only that PoolManager's pools holding the coin, never the
    /// V2 / V3 pools of the same coin.
    #[test]
    fn v4_fallback_names_only_v4_pools_of_that_manager() {
        let usdg = Address::from([0x11; 20]);
        let meme = Address::from([0x33; 20]);
        let pm = Address::from([0x44; 20]);
        let other_pm = Address::from([0x55; 20]);
        let v2 = Address::from([0x66; 20]);
        let id = |b: u8| B256::from([b; 32]);
        let fp = |a: Address, id: Option<B256>| FollowedPool { key: id.map(|i| format!("{i:#x}")).unwrap_or_else(|| format!("{a:#x}")), address: a, v4_id: id };
        let set = PoolSet::build(
            &[(fp(v2, None), usdg, meme), (fp(pm, Some(id(1))), Address::ZERO, usdg), (fp(pm, Some(id(2))), meme, Address::from([0x77; 20])), (fp(other_pm, Some(id(3))), Address::ZERO, usdg)],
            HashSet::new(),
        );
        let mut data = vec![0u8; 12];
        data.extend_from_slice(pm.as_slice());
        data.extend_from_slice(&[0u8; 12]);
        data.extend_from_slice(usdg.as_slice());
        let n = set.scan(&data);
        assert!(set.names_pm(None, &n));
        assert_eq!(set.v4_sharing_named_coins(None, &n), vec![format!("{:#x}", id(1))], "only the USDG pool in THAT PoolManager");
        let mut wide = set.sharing_named_coins(&n);
        wide.sort();
        assert_eq!(wide.len(), 3, "the old fallback: every USDG pool of any kind ({wide:?})");
    }

    #[test]
    fn settings_from_env_words() {
        let m: HashMap<&str, &str> = [("FASTLANE_AHEAD_MAX_BLOCKS", "8"), ("FASTLANE_AHEAD_FILTER", "ALL")].into_iter().collect();
        let c = AheadCfg::from_lookup(|k| m.get(k).map(|s| s.to_string()), 5);
        assert_eq!((c.max_blocks, c.run_all, c.max_txs, c.l2_offset), (8, true, 256, 5));
        let c = AheadCfg::from_lookup(|_| Some("0".into()), 0);
        assert_eq!((c.max_blocks, c.run_all), (32, false), "nonsense falls back to the defaults");
        // Practice fixes: sender funds trusted by default in practice only;
        // routes-only on by default.
        let get = |m: Vec<(&'static str, &'static str)>| {
            let m: HashMap<&str, &str> = m.into_iter().collect();
            AheadCfg::from_lookup(move |k| m.get(k).map(|s| s.to_string()), 0)
        };
        assert!(get(vec![("FASTLANE", "practice")]).trust_sender_funds);
        assert!(!get(vec![("FASTLANE", "live")]).trust_sender_funds, "live: not trusted unless set");
        assert!(!get(vec![("FASTLANE", "practice"), ("FASTLANE_AHEAD_TRUST_SENDER_FUNDS", "off")]).trust_sender_funds, "an explicit off wins");
        assert!(get(vec![("FASTLANE", "live"), ("FASTLANE_AHEAD_TRUST_SENDER_FUNDS", "on")]).trust_sender_funds);
        assert!(get(vec![]).routes_only && !get(vec![("FASTLANE_AHEAD_ROUTES_ONLY", "off")]).routes_only);
    }
}
