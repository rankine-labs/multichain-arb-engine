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
//   PRACTICE FIXES (Oct 27, after the first 30 live minutes: apply p90 17 ms,
//   70% of messages stopped over budget, agreement 0%, scanner 0 routes):
//     1. SPEED: the cheap filter looked for each of ~1,800 pools (and every
//        coin pair / V4 id) separately across a transaction's whole data:
//        millions of byte compares per transaction. Now ONE pass over the
//        data with an index (NameIndex), same answers (tested against the
//        old search). Test bench on real V3 + V4 pool code (tests/
//        fastlane_ahead_bench_anvil.rs): p90 ~38 ms -> under 1 ms.
//     2. A failed run's second "collect" run is skipped when the target has
//        no code in our copy (it could read nothing of ours).
//     3. UNSURE NARROWED (it hid every route from the scanner):
//          - a failed run: pools named only by their coin PAIR (every
//            exchange's pool of that pair) are marked unsure only for pairs
//            no pool it was found to use already stands for (before: one
//            failed swap naming WETH and USDG made every WETH / USDG pool
//            unsure: both sides of every such route),
//          - a failed transaction naming a V4 PoolManager and nothing
//            narrower marks only that PoolManager's pools sharing a named
//            coin (before: every pool of any kind sharing a coin),
//          - FASTLANE_AHEAD_TRUST_SENDER_FUNDS now defaults to ON in practice
//            mode (nothing is sent there; with it off nearly every swap's
//            pools were unsure). Live: off unless set.
//     4. FASTLANE_AHEAD_ROUTES_ONLY [on]: a transaction naming only pools no
//        scanner route uses is not run (those pools marked unsure).
//     5. AGREEMENT, honest: a confirmed change NO transaction of the message
//        made (copy 2 loading / re-reading a pool) is "notFromTx", not a
//        miss; misses are split "missedFilter" (skipped by the filter) /
//        "missedRan" (we ran it, our run did not move the pool), with the
//        transaction in the samples.
//
//   ACCURACY FIXES (Oct 27, second practice run: agree 16, disagree 933,
//   all 933 "missed", 906 of them labelled "missedRan"):
//     6. HONEST LABELS. "missedRan" also counted transactions we could NOT
//        run (Fate::Failed): their pool was simply not among the ones marked
//        unsure. Now split: missedRan (our run succeeded but did not move the
//        pool), missedReverted (our run reverted / halted), missedFailed (we
//        could not run it and did not mark that pool unsure: the dangerous
//        one, a "sure" pool that was wrong). Every transaction's note keeps
//        why it failed / reverted and the pools it moved / marked.
//     7. LATE REPORTS. Copy 2 publishes block N ~30 ms after its header and
//        writes reports that arrive later INTO the kept versions (it replaces
//        them: same block, new snapshot; intake.rs on_late_at). The predicted
//        copy only ever took versions of a NEWER block, so it kept building on
//        the version without those reports, and agreement compared against
//        the first, incomplete version. Now:
//          - a replaced version of the base block = rebase on it ("rewrite"),
//          - agreement for block N waits FASTLANE_AHEAD_COMPARE_DELAY_BLOCKS
//            (5) more blocks and compares against the SETTLED versions N-1
//            and N: "the confirmed block moved a pool" = its own values differ
//            between settled N-1 and settled N (no longer the first diff),
//          - a disagreement where the base we predicted on differs from the
//            settled N-1 for that pool is labelled "staleBase", and pools
//            whose base values were corrected later are counted ("baseLate").
//     8. FAILED TRANSACTIONS, safer: also marked unsure (besides the old
//        rules) are native-ETH pools of a named coin whatever the ETH value
//        (a V4 "sell for ETH" pays none), and the target's learned pools this
//        data could be trading (a named pair, e.g. a split route over sister
//        pools; with one coin named, its pools holding it; with none named,
//        an opaque bot contract, all of them). Routers are now learned from
//        EVERY transaction copy 2 says moved our pools (before: only from
//        ones the filter skipped), a router's list keeps its 64 MOST RECENT
//        pools (before: the first 64, forever), and a failed run's guessed
//        pools are no longer learned as if the router had moved them.
//        "missed" also counts a block where both sides moved the pool but one
//        of its movers was missed (e.g. a second swap the filter skipped):
//        "value" is left for "we ran every mover and still differ".
//     9. MEASURABLE: richer disagreement samples (base block, slots that
//        differ, predicted vs confirmed values, our transactions on that pool,
//        why the mover failed), the newest ones kept in status totals too, and
//        a capture file + offline replay (copy2/ahead_capture.rs,
//        `arbsim ahead-replay <file>`).
//
//   OBSERVE MODE (Oct 31, owner-approved "real fix", part 1):
//    10. FASTLANE_AHEAD=observe runs the predicted copy and measures it live
//        (the same agreement check: per pool and block, exact / wrong /
//        unsure once copy 2 has the real block; plus how many blocks ahead
//        of copy 2 each tip was), but its tips are NEVER handed out:
//        wait_tip / global_tip answer None, so the lane, scanner and trigger
//        decide exactly as with it off. Status "fastlaneAhead.accuracy".
//        FASTLANE_AHEAD=on keeps its old meaning.
//    11. FASTLANE_AHEAD_UNKNOWN_CONTINUE: a transaction we could not run and
//        that NOTHING ties to our pools used to stop the whole prediction
//        (76 stops on the Oct 27 capture). With it on (default in observe
//        only) the prediction goes on past it (Fate::Unknown, nothing
//        marked) and any pool it really moved is counted "missedUnknown",
//        so whether the rule is safe is measured, not assumed.
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
    /// FASTLANE_AHEAD_COMPARE_DELAY_BLOCKS [5 from env; 0 = compare at once]
    /// (accuracy fixes): agreement for block N runs this many blocks later,
    /// against the SETTLED copy-2 versions N-1 and N (late reports written
    /// in). 0 = compare the moment N is confirmed, with that version (tests).
    /// The runtime drives the delayed compare (`due` / `compare_settled`).
    pub compare_delay: u64,
    /// FASTLANE_AHEAD_REVERT_UNSURE [on] (Oct 31, measured on the Oct 27
    /// capture: 27 of the 32 "sure but wrong" pools came from a run of OURS
    /// that reverted while the real transaction succeeded). A picked
    /// transaction (it may move our pools) whose run REVERTS no longer
    /// counts as "moved nothing, sure": the pools it may touch are marked
    /// unsure with the same rules as a transaction we could not run. A
    /// revert usually means our copy already differs from the chain (an
    /// earlier transaction in the block, a value we hold wrong) or the real
    /// one reverted too; we can't tell which, so we never vouch for it.
    /// When nothing narrows down what it may touch, the pools stay as they
    /// are (prediction is NOT stopped, counted "revertsKept"). off = the
    /// old rule (a reverted run moves nothing and its pools stay sure).
    pub revert_unsure: bool,
    /// FASTLANE_AHEAD_UNKNOWN_CONTINUE (Oct 31, observe-mode build). A
    /// picked transaction we could not run AND that nothing ties to any of
    /// our pools (no pool it reads in a collect run, names, or moved before;
    /// no coin of ours it names; no V4 PoolManager) used to STOP the whole
    /// prediction until copy 2 confirmed that block ("failed_tx_unknown_
    /// effect", 76 stops on the Oct 27 capture). on = keep predicting: the
    /// transaction is noted "unknown" (Fate::Unknown) and the agreement
    /// check counts any pool it really moved as "missedUnknown", so the
    /// rule is MEASURED. Default: on with FASTLANE_AHEAD=observe (nothing
    /// is decided on it), off with FASTLANE_AHEAD=on (unchanged), unless set.
    pub unknown_continue: bool,
    /// FASTLANE_AHEAD_KEEPER (Oct 31, copy2/keeper.rs): use the hot-contract
    /// keeper. The predicted copy lays the keeper's exact values of its
    /// base block over copy 2's, and tells the keeper which outside values
    /// its runs lacked. Default: on with FASTLANE_AHEAD=observe, off with
    /// FASTLANE_AHEAD=on (unchanged), unless set.
    pub keeper: bool,
}

impl Default for AheadCfg {
    fn default() -> Self {
        AheadCfg { max_blocks: 32, run_all: false, max_txs: 256, max_touchers: 4096, l2_offset: 0, trust_sender_funds: false, msg_budget_us: 10_000, routes_only: true, compare_delay: 0, revert_unsure: true, unknown_continue: false, keeper: false }
    }
}

/// Default FASTLANE_AHEAD_COMPARE_DELAY_BLOCKS of the running sidecar.
pub const COMPARE_DELAY_DEFAULT: u64 = 5;

/// An on / off word: Some(true) for on / 1 / true / yes, Some(false) for
/// off / 0 / false / no, None for unset, empty or anything else (= default).
pub fn on_off(v: Option<&str>) -> Option<bool> {
    match v.map(|x| x.trim().to_ascii_lowercase()).as_deref() {
        Some("on" | "1" | "true" | "yes") => Some(true),
        Some("off" | "0" | "false" | "no") => Some(false),
        _ => None,
    }
}

/// FASTLANE_AHEAD: what the predicted copy is for.
///   off      (unset, the default) nothing runs
///   on       it runs AND the fast lane scans on its tips (Oct 26 meaning,
///            unchanged)
///   observe  (Oct 31) it runs and measures itself live (agreement with
///            copy 2 once the real block arrives, how many blocks ahead it
///            is), but NOTHING reads its tips: the lane, scanner and trigger
///            decide exactly as with off (they scan copy 2's confirmed
///            versions). The safe way to measure it live.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AheadMode {
    Off,
    On,
    Observe,
}

impl AheadMode {
    pub fn parse(v: Option<&str>) -> AheadMode {
        match v.map(|x| x.trim().to_ascii_lowercase()).as_deref() {
            Some("on" | "1" | "true" | "yes") => AheadMode::On,
            Some("observe" | "watch" | "measure") => AheadMode::Observe,
            _ => AheadMode::Off,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            AheadMode::Off => "off",
            AheadMode::On => "on",
            AheadMode::Observe => "observe",
        }
    }
}

impl AheadCfg {
    /// From any key -> value lookup (tests pass a map).
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>, l2_offset: u64) -> AheadCfg {
        let d = AheadCfg::default();
        let num = |k: &str| get(k).and_then(|v| v.trim().parse::<usize>().ok());
        let observe = AheadMode::parse(get("FASTLANE_AHEAD").as_deref()) == AheadMode::Observe;
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
            // (0 is allowed here: compare at once, the old behaviour.)
            compare_delay: get("FASTLANE_AHEAD_COMPARE_DELAY_BLOCKS").and_then(|v| v.trim().parse::<u64>().ok()).filter(|v| *v <= 30).unwrap_or(COMPARE_DELAY_DEFAULT),
            // Unset = on; only an explicit off / 0 / false / no turns it off.
            revert_unsure: get("FASTLANE_AHEAD_REVERT_UNSURE").is_none_or(|v| !matches!(v.trim().to_ascii_lowercase().as_str(), "off" | "0" | "false" | "no")),
            // Observe-mode build (Oct 31): unset = on only when the predicted
            // copy only OBSERVES (FASTLANE_AHEAD=observe: it feeds no
            // decision); FASTLANE_AHEAD=on keeps the old rule unless set.
            unknown_continue: on_off(get("FASTLANE_AHEAD_UNKNOWN_CONTINUE").as_deref()).unwrap_or(observe),
            keeper: on_off(get("FASTLANE_AHEAD_KEEPER").as_deref()).unwrap_or(observe),
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
    /// Key -> its two coins as listed (zero = native ETH), for the failed-
    /// transaction rules (accuracy fixes: a router's learned pools of a
    /// named pair).
    coins_of: HashMap<String, (Address, Address)>,
    /// Key -> its coin pair (sorted; only pools with two non-zero coins).
    pair_of: HashMap<String, (Address, Address)>,
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
            s.coins_of.insert(p.key.clone(), (*t0, *t1));
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
                s.pair_of.insert(p.key.clone(), k);
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
        let mut out = self.named_direct(to, n);
        for k in self.named_by_pair(n) {
            if !out.contains(&k) {
                out.push(k);
            }
        }
        out
    }

    /// Our pools a transaction names DIRECTLY: its target, a pool contract
    /// address or a V4 pool id inside its data.
    fn named_direct(&self, to: Option<Address>, n: &Named) -> Vec<String> {
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
        out
    }

    /// Our pools whose BOTH coins the data names (every exchange's pool of
    /// that pair: a router path names coins, not pools).
    fn named_by_pair(&self, n: &Named) -> Vec<String> {
        self.named_by_pair_except(n, &[])
    }

    /// `named_by_pair`, leaving out the pairs of the pools in `known` (a
    /// failed run already found the pool it trades for that pair).
    fn named_by_pair_except(&self, n: &Named, known: &[String]) -> Vec<String> {
        let skip: Vec<(Address, Address)> = known.iter().filter_map(|k| self.pair_of.get(k).copied()).collect();
        let mut out: Vec<String> = Vec::new();
        for p in self.idx.pairs_found(n) {
            if skip.contains(&p) {
                continue;
            }
            for k in self.by_pair.get(&p).into_iter().flatten() {
                if !out.contains(k) {
                    out.push(k.clone());
                }
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

    /// Accuracy fixes: native-ETH pools whose other coin the data names,
    /// WHATEVER the ETH value (a V4 "sell the coin for ETH" through a router
    /// pays no ETH, so `named_native` misses it). Only for failed runs.
    fn named_native_any(&self, n: &Named) -> Vec<String> {
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

    /// Accuracy fixes: of `learned` (a router's pools from its history), the
    /// ones this transaction's data could be trading: both coins named, or
    /// (native-ETH pool) its other coin named, or (only one coin named) the
    /// ones holding it. Data naming NO coin at all (an opaque bot
    /// contract): every learned pool.
    fn learned_for(&self, learned: &[String], n: &Named) -> Vec<String> {
        let named: Vec<&Address> = self.idx.coins(n).collect();
        if named.is_empty() {
            return learned.to_vec();
        }
        let has = |c: &Address| named.contains(&c);
        // One coin named (the other side is implied, e.g. ETH or the
        // router's own path): its pools holding that coin.
        let one = named.len() == 1;
        learned
            .iter()
            .filter(|k| match self.coins_of.get(*k) {
                Some((a, b)) if a.is_zero() => has(b),
                Some((a, b)) if b.is_zero() => has(a),
                Some((a, b)) if one => has(a) || has(b),
                Some((a, b)) => has(a) && has(b),
                None => false,
            })
            .cloned()
            .collect()
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
    /// Every transaction of the message and what we did with it (agreement
    /// tells a filter miss from a run that did not move the pool; the
    /// confirmed reports teach which targets move our pools).
    notes: Vec<TxNote>,
    built_at: Instant,
    apply_us: u64,
    /// When the feed message arrived (see AheadTip.feed_at).
    feed_at: Instant,
}

/// What the prediction did with one transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fate {
    /// Not picked by the cheap filter.
    Skipped,
    /// Picked, but names only pools no route uses: not run (pools unsure).
    OffRoute,
    /// Ran exactly (it may or may not have moved our pools; see TxNote.ok).
    Ran,
    /// Could not be run exactly (pools it may touch marked unsure).
    Failed,
    /// Could not be run exactly and NOTHING ties it to our pools: with
    /// FASTLANE_AHEAD_UNKNOWN_CONTINUE the prediction went on past it
    /// (nothing marked). A pool it really moved = "missedUnknown".
    Unknown,
}

impl Fate {
    pub fn as_str(self) -> &'static str {
        match self {
            Fate::Skipped => "skipped",
            Fate::OffRoute => "offRoute",
            Fate::Ran => "ran",
            Fate::Failed => "failed",
            Fate::Unknown => "unknown",
        }
    }
}

/// One transaction of a predicted block: what we did with it and why
/// (accuracy fixes: the samples and the offline replay explain each miss).
#[derive(Clone, Debug)]
pub struct TxNote {
    pub hash: B256,
    pub to: Option<Address>,
    pub fate: Fate,
    /// Ran: our run finished normally (false = it reverted / halted).
    pub ok: bool,
    /// Failed / reverted: why, in a few words (groupable: addresses are
    /// named by role, e.g. "miss: target code").
    pub why: Option<String>,
    /// Our pools it moved (ran), or marked unsure for it (failed / off-route).
    pub pools: Vec<String>,
}

/// A predicted block waiting for its agreement (FASTLANE_AHEAD_COMPARE_DELAY_BLOCKS).
struct Pending {
    seq: u64,
    /// The confirmed version the prediction was built on (block seq - 1,
    /// as it was then: late reports may have corrected it since).
    base_snap: Arc<Snapshot>,
    /// The predicted state after block `seq`.
    snap: Arc<Snapshot>,
    changed_cum: HashSet<String>,
    unsure_cum: HashSet<String>,
    notes: Vec<TxNote>,
    /// The pool set it was predicted with (places, copy 2's not-ready pools).
    pools: Arc<PoolSet>,
}

/// One pool's own values in a confirmed version: a contract pool's declared
/// variables (slots below 2^32) / a V4 pool's 4 base values, sorted by slot.
/// None = the confirmed copy holds nothing for it (not loaded / forgotten).
pub type PlaceVals = Option<Vec<(U256, U256)>>;

/// What agreement needs from copy 2 about block `seq`, taken from the
/// SETTLED versions seq - 1 and seq (late reports written in). Built by the
/// runtime from copy 2's published versions, or read from a capture file
/// (the offline replay): the same comparison either way.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Settled {
    pub seq: u64,
    /// Our pools whose own values differ between settled seq - 1 and seq
    /// ("the confirmed block moved it"), sorted.
    pub moved: Vec<String>,
    /// Values at seq (moved pools + the extra pools asked for).
    pub now: BTreeMap<String, PlaceVals>,
    /// Values at seq - 1 (same pools).
    pub prev: BTreeMap<String, PlaceVals>,
    /// Pools whose values in the version the prediction was built on differ
    /// from the settled seq - 1 (late reports corrected them after we used
    /// them), sorted. Empty when that version is not known.
    pub late: Vec<String>,
}

/// Most samples of disagreement slots kept per sample.
const MAX_SLOT_DIFFS: usize = 4;
/// Most predicted blocks waiting for their agreement (bounded memory).
const MAX_PENDING: usize = 256;

/// The base with the keeper's values laid over it (see Ahead.merged).
struct Merged {
    /// Base sequence number it was made for, and the very base snapshot.
    seq: u64,
    base_snap: Arc<Snapshot>,
    /// The keeper version used (pointer: a re-published version = re-merge).
    kept: Arc<super::keeper::KeptVersion>,
    snap: Arc<Snapshot>,
    prov: Arc<dyn Provenance + Send + Sync>,
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
    /// FASTLANE_AHEAD_REVERT_UNSURE (Oct 31): picked transactions whose run
    /// reverted; their possible pools were marked unsure.
    pub reverts_marked: u64,
    /// ...and reverted runs where nothing narrowed down what they may touch
    /// (pools left as they were, prediction not stopped).
    pub reverts_kept: u64,
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
    /// ... / it was not run because it named only off-route pools
    /// (FASTLANE_AHEAD_ROUTES_ONLY) yet moved this one.
    pub missed_off_route: u64,
    /// The confirmed block changed one of our pools but NO transaction of
    /// that feed message did (copy 2 loading / re-reading a pool, or a
    /// report filed under another block): not a prediction miss, so not
    /// counted in disagree; shown on its own.
    pub not_from_tx: u64,
    /// Accuracy fixes: "missed" by what OUR side did with the transaction
    /// copy 2 says moved the pool: missed_ran = our run succeeded but moved
    /// nothing of it; missed_reverted = our run reverted / halted;
    /// missed_failed = we could not run it and did not mark the pool unsure.
    pub missed_reverted: u64,
    pub missed_failed: u64,
    /// Disagreements where the base we predicted on was later corrected for
    /// that pool (late reports): the miss is the base's, not the run's.
    pub stale_base: u64,
    /// Pools whose base values were corrected after we predicted on them
    /// (late reports), counted per compared block (not in agreement %).
    pub base_late: u64,
    /// Pools the prediction moved whose confirmed values were not available
    /// for the comparison (offline replay of blocks live never compared).
    pub not_captured: u64,
    /// Pools the confirmed copy holds nothing for (copy 2 forgot / is
    /// loading them): not comparable, counted apart (not in agreement %).
    pub conf_gone: u64,
    /// Rebases on a replaced version of the same block (late reports).
    pub rebase_rewrites: u64,
    /// Predicted blocks whose agreement could not run (copy 2 no longer
    /// held the versions, or too many waiting).
    pub settle_lost: u64,
    /// Failed runs that marked more pools unsure under the accuracy-fix
    /// rules (native-ETH pools of a named coin, the target's learned pools).
    pub failed_widened: u64,
    /// FASTLANE_AHEAD_UNKNOWN_CONTINUE: transactions we could not run and
    /// that nothing tied to our pools, which we predicted PAST (no stop).
    pub unknown_continued: u64,
    /// ...and pools such a transaction really moved (a sure pool that was
    /// wrong because of the rule: the measure of whether it is safe).
    pub missed_unknown: u64,
    /// Observe-mode build: per feed message, how many blocks the predicted
    /// tip was ahead of copy 2's confirmed version (0 = no tip: stopped or
    /// waiting). The "blocks fresher" gain. Ring of the newest MAX_TIMES.
    pub ahead_blocks: Vec<u64>,
    pub ahead_n: u64,
    /// Feed messages that left a tip (the rest: no prediction to use).
    pub tips: u64,
    /// KEEPER (copy2/keeper.rs): bases laid over with the keeper's version
    /// of that block / bases with no keeper version of exactly that block /
    /// values the keeper added to them / predictions rebuilt because the
    /// keeper's version arrived after copy 2's / values handed to the
    /// keeper to learn.
    pub kept_bases: u64,
    pub kept_missing: u64,
    pub kept_values: u64,
    pub kept_rebases: u64,
    pub learned: u64,
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
        self.json_with(true)
    }

    /// `times` false = without the apply-time percentiles (no copy + sort of
    /// up to 20,000 samples; the once-a-second status uses it for the
    /// since-start totals, practice fixes).
    pub fn json_with(&self, times: bool) -> Value {
        let mut t = if times { self.apply_us.clone() } else { Vec::new() };
        let mut out = json!({
            "msgs": self.msgs, "applied": self.applied, "lateMsgs": self.late_msgs,
            "txsRun": self.txs_run, "txsSkipped": self.txs_skipped, "txsFailed": self.txs_failed,
            "txsMarkedUnsure": self.txs_marked, "filterMissed": self.filter_missed, "assumed": self.assumed,
            "rebases": self.rebases, "reapplied": self.reapplied,
            "agree": self.agree, "disagree": self.disagree, "missed": self.missed, "phantom": self.phantom,
            "valueDiff": self.value_diff, "unsure": self.unsure, "unpredicted": self.unpredicted,
            "compared": self.compared, "msgsStopped": self.msgs_stopped, "overBudget": self.over_budget,
            "failedUnknown": self.failed_unknown, "assumedUnsure": self.assumed_unsure, "nativePicks": self.native_picks,
            "txsOffRoute": self.txs_off_route, "probesSkipped": self.probes_skipped, "v4Fallback": self.v4_fallback,
            "revertsMarked": self.reverts_marked, "revertsKept": self.reverts_kept,
            "missedFilter": self.missed_filter, "missedRan": self.missed_ran, "missedOffRoute": self.missed_off_route, "notFromTx": self.not_from_tx,
            "agreementPct": self.agreement_pct(),
            "stopped": self.stopped.iter().map(|(k, v)| (k.to_string(), json!(v))).collect::<serde_json::Map<String, Value>>(),
            "applyUs": if times { crate::timing::pct_of(&mut t) } else { Value::Null },
            "samples": self.samples,
        });
        // Accuracy fixes (a second object: one json! macro is limited in size).
        let more = json!({
            "missedReverted": self.missed_reverted, "missedFailed": self.missed_failed, "staleBase": self.stale_base, "baseLate": self.base_late,
            "notCaptured": self.not_captured, "confGone": self.conf_gone, "rebaseRewrites": self.rebase_rewrites, "settleLost": self.settle_lost, "failedWidened": self.failed_widened,
            "unknownContinued": self.unknown_continued, "missedUnknown": self.missed_unknown, "tips": self.tips,
            "keptBases": self.kept_bases, "keptMissing": self.kept_missing, "keptValues": self.kept_values, "keptRebases": self.kept_rebases, "learned": self.learned,
            // How many blocks the tip was ahead of copy 2 (per feed message, 0 = no tip).
            "aheadBlocks": if times { let mut b = self.ahead_blocks.clone(); crate::timing::pct_of(&mut b) } else { Value::Null },
        });
        if let (Value::Object(o), Value::Object(m)) = (&mut out, more) {
            o.extend(m);
        }
        out
    }

    /// The hourly line (timing.rs / bot style: one line, the numbers that matter).
    pub fn line(&self) -> String {
        let mut t = self.apply_us.clone();
        let p = crate::timing::pct_of(&mut t);
        let g = |k: &str| p.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
        let mut b = self.ahead_blocks.clone();
        let pb = crate::timing::pct_of(&mut b);
        let ab = |k: &str| pb.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
        let mut stops: Vec<String> = self.stopped.iter().map(|(k, v)| format!("{k}:{v}")).collect();
        stops.sort();
        format!(
            "[arbsim] fastlane ahead (last hour): msgs {} applied {} late {} | txs run {} skipped {} off-route {} failed {} (pools unsure {}, nothing found {}, v4 only {}, probes skipped {}, widened {}) filterMissed {} assumedUnsure {} nativePicks {} | apply us p50 {} p90 {} p99 {} max {} | rebases {} (rewrites {}) reapplied {} | agree {} disagree {} (missed {} [filter {} ran {} reverted {} failed {} off-route {}] phantom {} value {}; stale base {}) unsure {} not from a tx {} conf gone {} unpredicted {} base late {} | msgs while stopped {} over budget {} | stopped [{}] | unknown continued {} (missed {}) | tips {} blocks ahead p50 {} p90 {}",
            self.msgs, self.applied, self.late_msgs, self.txs_run, self.txs_skipped, self.txs_off_route, self.txs_failed, self.txs_marked, self.failed_unknown, self.v4_fallback, self.probes_skipped, self.failed_widened, self.filter_missed, self.assumed_unsure, self.native_picks,
            g("p50"), g("p90"), g("p99"), g("max"), self.rebases, self.rebase_rewrites, self.reapplied,
            self.agree, self.disagree, self.missed, self.missed_filter, self.missed_ran, self.missed_reverted, self.missed_failed, self.missed_off_route, self.phantom, self.value_diff, self.stale_base, self.unsure, self.not_from_tx, self.conf_gone, self.unpredicted, self.base_late, self.msgs_stopped, self.over_budget, stops.join(" "),
            self.unknown_continued, self.missed_unknown, self.tips, ab("p50"), ab("p90"),
        )
    }

    /// Observe-mode build: one "blocks ahead of copy 2" sample (ring, like
    /// apply_us).
    fn add_ahead(&mut self, blocks: u64) {
        if self.ahead_blocks.len() < MAX_TIMES {
            self.ahead_blocks.push(blocks);
        } else {
            let i = (self.ahead_n % MAX_TIMES as u64) as usize;
            self.ahead_blocks[i] = blocks;
        }
        self.ahead_n += 1;
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
    /// Predicted blocks waiting for their (settled) agreement, oldest first.
    pending: VecDeque<Pending>,
    /// KEEPER: the keeper's recent versions (by L2 block, newest last).
    kept: VecDeque<Arc<super::keeper::KeptVersion>>,
    /// KEEPER: the base with the keeper's values of the same block laid
    /// over it (None = the plain base: no keeper version of that block).
    merged: Option<Merged>,
    /// KEEPER: values our runs lacked or read only approximately, for the
    /// keeper to learn (the runtime / replay hands them over and empties it).
    pub learned: Vec<crate::state::MissItem>,
    /// The collect run's reads of the last guess_touched (for learning).
    last_probe: Option<crate::check::db::ReadLog>,
    /// Offline replay only (copy2/ahead_capture.rs): EVERY disagreement
    /// sample (unbounded there; None live).
    pub collect_all: Option<Vec<Value>>,
    /// Offline replay only: why each run failed (reason -> count; with the
    /// keeper: whether it held the missing value's contract) and what made
    /// each compared pool unsure (cause -> count). None live.
    pub diag: Option<(BTreeMap<String, u64>, BTreeMap<String, u64>)>,
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
            pending: VecDeque::new(),
            kept: VecDeque::new(),
            merged: None,
            learned: Vec::new(),
            last_probe: None,
            collect_all: None,
            diag: None,
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

    /// Every learned toucher with its pools, sorted by address (capture start).
    pub fn touchers_list(&self) -> Vec<(Address, Vec<String>)> {
        let mut v: Vec<(Address, Vec<String>)> = self.touchers.iter().map(|(a, (_, p))| (*a, p.clone())).collect();
        v.sort_by_key(|x| x.0);
        v
    }

    /// Learn touchers in this order (capture replay start).
    pub fn learn_touchers(&mut self, list: &[(Address, Vec<String>)]) {
        for (a, p) in list {
            self.learn_toucher(*a, p);
        }
    }

    pub fn cfg(&self) -> &AheadCfg {
        &self.cfg
    }

    /// L2 block number of the confirmed base (None before the first one).
    pub fn base_block(&self) -> Option<u64> {
        self.base.as_ref().map(|b| b.seq + self.cfg.l2_offset)
    }

    /// The base the prediction runs on: copy 2's version, with the keeper's
    /// values of exactly that block laid over it when there is one.
    fn base_parts(&self, base: &Confirmed) -> (Arc<Snapshot>, Arc<dyn Provenance + Send + Sync>) {
        match &self.merged {
            Some(m) if m.seq == base.seq && Arc::ptr_eq(&m.base_snap, &base.snap) => (m.snap.clone(), m.prov.clone()),
            _ => (base.snap.clone(), base.prov.clone()),
        }
    }

    /// KEEPER: lay the keeper's version of the base block over the base
    /// (copy2/keeper.rs merge_base: copy 2's exact values always win).
    /// Returns whether the merged base changed.
    fn remerge(&mut self) -> bool {
        let Some(base) = &self.base else { return false };
        if !self.cfg.keeper {
            return false;
        }
        let block = base.seq + self.cfg.l2_offset;
        let Some(kv) = self.kept.iter().rev().find(|v| v.block == block).cloned() else {
            return self.merged.take().is_some();
        };
        if self.merged.as_ref().is_some_and(|m| m.seq == base.seq && Arc::ptr_eq(&m.base_snap, &base.snap) && Arc::ptr_eq(&m.kept, &kv)) {
            return false;
        }
        let (snap, n) = super::keeper::merge_base(&base.snap, base.prov.as_ref(), &kv);
        let prov: Arc<dyn Provenance + Send + Sync> = Arc::new(super::keeper::KeptProv { inner: base.prov.clone(), kept: kv.clone() });
        self.merged = Some(Merged { seq: base.seq, base_snap: base.snap.clone(), kept: kv, snap: Arc::new(snap), prov });
        self.count(|s| s.kept_values += n.slots as u64);
        true
    }

    /// KEEPER: a keeper version (live: its thread published one; replay:
    /// the replayed keeper moved on). Kept (bounded); when it is the version
    /// of our base block and the prediction ran without it, the prediction
    /// is rebuilt on the merged base (a "keeper rebase").
    pub fn on_kept(&mut self, v: Arc<super::keeper::KeptVersion>) {
        if !self.cfg.keeper {
            return;
        }
        if self.kept.back().is_some_and(|x| Arc::ptr_eq(x, &v)) {
            return;
        }
        // Same block re-published (a seed came back): replace it.
        self.kept.retain(|x| x.block != v.block);
        self.kept.push_back(v.clone());
        while self.kept.len() > 64 {
            self.kept.pop_front();
        }
        if self.base_block() == Some(v.block) && self.remerge() {
            self.count(|s| s.kept_rebases += 1);
            self.rebuild();
        }
    }

    /// Re-apply every held message on the (new) base, like a rebase without
    /// a new confirmed version.
    fn rebuild(&mut self) {
        let Some(seq) = self.base.as_ref().map(|b| b.seq) else { return };
        self.entries.clear();
        self.tip = None;
        self.stop = None;
        match self.over_budget_seq {
            Some(s) if s > seq => self.stop = Some(Stop { seq: s, why: "msg_budget" }),
            _ => self.over_budget_seq = None,
        }
        let before = self.hour.applied;
        self.extend();
        let n = self.hour.applied - before;
        self.count(|s| s.reapplied += n);
    }

    /// KEEPER learning: what one run lacked / read approximately. Only
    /// with the keeper on; bounded (the runtime empties it every wake-up).
    fn learn_from_run(&mut self, missing: &[crate::state::MissItem], view: &dyn StateRead, prov: &dyn Provenance, sender: Address) {
        if !self.cfg.keeper || self.learned.len() >= 4096 {
            return;
        }
        let probe = self.last_probe.take();
        let pools = self.pools.clone();
        let skip = |a: &Address| pools.by_contract.contains_key(a);
        let items = super::keeper::wanted_items(missing, probe.as_ref().map(|r| (&r.accounts, &r.slots)), view, prov, sender, &skip);
        self.count(|s| s.learned += items.len() as u64);
        self.learned.extend(items);
    }

    /// Held feed messages, oldest first (capture start).
    pub fn held(&self) -> Vec<Arc<BinMsg>> {
        self.msgs.values().cloned().collect()
    }

    /// Predicted blocks waiting for agreement whose turn has come: confirmed
    /// head `head_seq` is at least FASTLANE_AHEAD_COMPARE_DELAY_BLOCKS past them.
    pub fn due(&self, head_seq: u64) -> Vec<u64> {
        self.pending.iter().filter(|p| p.seq.saturating_add(self.cfg.compare_delay) <= head_seq).map(|p| p.seq).collect()
    }

    /// Is a predicted block waiting for agreement?
    pub fn is_pending(&self, seq: u64) -> bool {
        self.pending.iter().any(|p| p.seq == seq)
    }

    /// What `Settled::build` needs for a waiting block: the pool set it was
    /// predicted with, the pools it moved (their confirmed values are
    /// compared too) and the version it was built on.
    pub fn pending_parts(&self, seq: u64) -> Option<(Arc<PoolSet>, Vec<String>, Arc<Snapshot>)> {
        self.pending.iter().find(|p| p.seq == seq).map(|p| {
            let mut k: Vec<String> = p.changed_cum.iter().cloned().collect();
            k.sort();
            (p.pools.clone(), k, p.base_snap.clone())
        })
    }

    /// A waiting block whose versions copy 2 no longer holds: not compared.
    pub fn drop_pending(&mut self, seq: u64) {
        let before = self.pending.len();
        self.pending.retain(|p| p.seq != seq);
        if self.pending.len() < before {
            self.count(|s| s.settle_lost += 1);
        }
    }

    /// Run the agreement of a waiting block with copy 2's settled values.
    /// false = no such block waiting (nothing done).
    pub fn compare_settled(&mut self, st: &Settled, moved_by_tx: &dyn Fn(&B256) -> Option<Vec<String>>) -> bool {
        let Some(i) = self.pending.iter().position(|p| p.seq == st.seq) else { return false };
        let p = self.pending.remove(i).expect("index just found");
        self.agreement(&p, st, moved_by_tx);
        true
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
            // Bounded: a router remembers its 64 most recent pools of ours
            // (accuracy fixes: a full list used to never learn a new pool,
            // so a busy router's new pools were never marked).
            if let Some(i) = e.1.iter().position(|x| x == k) {
                let x = e.1.remove(i);
                e.1.push(x);
            } else {
                if e.1.len() >= 64 {
                    e.1.remove(0);
                }
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
        // Observe-mode build: the "blocks fresher" gain right now = how many
        // blocks the predicted tip is ahead of copy 2's confirmed version
        // (0 = no tip: nothing a scan could have used).
        let gain = match (&self.tip, &self.base) {
            (Some(t), Some(b)) => t.seq.saturating_sub(b.seq),
            _ => 0,
        };
        self.count(|s| {
            if gain > 0 {
                s.tips += 1;
            }
            s.add_ahead(gain);
        });
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
    /// moved), to learn which targets move our pools.
    /// A version of the SAME block as the base but a different snapshot
    /// (copy 2 wrote late reports into it) = rebase on it, no agreement.
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
        if self.base.as_ref().is_some_and(|b| c.seq == b.seq) {
            self.count(|s| s.rebase_rewrites += 1);
        }
        // Review M3/L1 + accuracy fixes: every predicted block this version
        // covers (several may confirm at once): each transaction copy 2 says
        // moved our pools teaches its target (skipped ones are also counted
        // "filterMissed").
        let covered: Vec<usize> = (0..self.entries.len()).filter(|i| self.entries[*i].seq <= c.seq).collect();
        for i in covered {
            let notes = std::mem::take(&mut self.entries[i].notes);
            self.learn_from(&notes, moved_by_tx);
            self.entries[i].notes = notes;
        }
        if first_time {
            self.queue_agreement(&c, moved_by_tx);
        }
        self.count(|s| s.rebases += 1);
        let seq = c.seq;
        // KEEPER: was the base we leave behind laid over with the keeper's
        // values (by now)? Counted once per base.
        if self.cfg.keeper {
            if let Some(old) = &self.base {
                let merged = self.merged.as_ref().is_some_and(|m| m.seq == old.seq && Arc::ptr_eq(&m.base_snap, &old.snap));
                self.count(|s| if merged { s.kept_bases += 1 } else { s.kept_missing += 1 });
            }
        }
        self.base = Some(c);
        // KEEPER: the keeper's values of this very block, if it has them.
        self.remerge();
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

    /// AGREEMENT, first half: block c.seq was predicted on the previous
    /// confirmed version: keep the prediction until its turn
    /// (FASTLANE_AHEAD_COMPARE_DELAY_BLOCKS; 0 = compare now, with this
    /// version and the previous one as they are).
    fn queue_agreement(&mut self, c: &Confirmed, moved_by_tx: &dyn Fn(&B256) -> Option<Vec<String>>) {
        let Some(i) = self.entries.iter().position(|e| e.seq == c.seq) else {
            self.count(|s| s.unpredicted += 1);
            return;
        };
        // L1 (review): only a version that is exactly ONE block after the
        // previous confirmed one is compared. A jump of several blocks
        // (copy 2 confirmed N-2..N at once and published only N) can't be
        // matched to one predicted block: counted "unpredicted".
        let Some(b) = self.base.as_ref().filter(|b| c.seq == b.seq + 1) else {
            self.count(|s| s.unpredicted += 1);
            return;
        };
        let e = &self.entries[i];
        let p = Pending {
            seq: e.seq,
            base_snap: b.snap.clone(),
            snap: e.snap.clone(),
            changed_cum: e.changed_cum.clone(),
            unsure_cum: e.unsure_cum.clone(),
            notes: e.notes.clone(),
            pools: self.pools.clone(),
        };
        if self.cfg.compare_delay == 0 {
            let mut keys: Vec<&String> = p.changed_cum.iter().collect();
            keys.sort();
            let st = Settled::build(&p.pools, p.seq, &p.base_snap, &c.snap, keys.into_iter(), None);
            self.agreement(&p, &st, moved_by_tx);
            return;
        }
        self.pending.retain(|x| x.seq != p.seq);
        self.pending.push_back(p);
        while self.pending.len() > MAX_PENDING {
            self.pending.pop_front();
            self.count(|s| s.settle_lost += 1);
        }
    }

    /// AGREEMENT (see the file header): our prediction for block p.seq vs
    /// copy 2's settled versions, per pool that changed in either.
    fn agreement(&mut self, p: &Pending, st: &Settled, moved_by_tx: &dyn Fn(&B256) -> Option<Vec<String>>) {
        self.count(|s| s.compared += 1);
        let pools = p.pools.clone();
        let conf_moved: HashSet<&String> = st.moved.iter().collect();
        let mut all: Vec<&String> = st.moved.iter().chain(p.changed_cum.iter()).collect();
        all.sort();
        all.dedup();
        let unsure_of = |k: &String| p.unsure_cum.contains(k) || pools.not_ready.contains(k);
        // Pools whose base values late reports corrected (still sure in our view).
        let late = st.late.iter().filter(|k| !unsure_of(k)).count() as u64;
        if late > 0 {
            self.count(|s| s.base_late += late);
        }
        let block = p.seq + self.cfg.l2_offset;
        for k in all {
            if unsure_of(k) {
                self.count(|s| s.unsure += 1);
                if let Some(d) = self.diag.as_mut() {
                    // Replay diagnostics: what made it unsure (the first of
                    // our transactions that marked it, else copy 2 / an
                    // assumed value).
                    let by = p.notes.iter().find(|n| n.pools.iter().any(|x| x == k) && !(n.fate == Fate::Ran && n.ok));
                    let cause = if pools.not_ready.contains(k) {
                        "copy 2: pool not ready".to_string()
                    } else {
                        match by {
                            Some(n) if n.fate == Fate::Ran => "our run reverted".to_string(),
                            Some(n) if n.fate == Fate::Failed => format!("could not run: {}", n.why.as_deref().unwrap_or("?")),
                            Some(n) => n.fate.as_str().to_string(),
                            None => "a run built on an assumed value (fill / sender funds)".to_string(),
                        }
                    };
                    *d.1.entry(cause).or_default() += 1;
                }
                continue;
            }
            let Some(place) = pools.places.get(k).copied() else { continue };
            let conf = match st.now.get(k) {
                None => {
                    self.count(|s| s.not_captured += 1);
                    continue;
                }
                Some(None) => {
                    // Copy 2 holds nothing for it (forgot / loading): not comparable.
                    self.count(|s| s.conf_gone += 1);
                    continue;
                }
                Some(Some(v)) => v,
            };
            let diffs = place_diffs(place, &p.snap, conf);
            if diffs.is_empty() {
                self.count(|s| s.agree += 1);
                continue;
            }
            // Why? Copy 2's reports say which transaction moved it; find it
            // in this message and what we did with it.
            // The mover we got wrong: the first transaction copy 2 says moved
            // it that our prediction did NOT run to a move of this pool
            // (skipped, not run, failed, reverted, or ran without moving it).
            let movers: Vec<&TxNote> = p.notes.iter().filter(|n| moved_by_tx(&n.hash).is_some_and(|x| x.iter().any(|y| y.eq_ignore_ascii_case(k)))).collect();
            let culprit = movers.iter().find(|n| !(n.fate == Fate::Ran && n.ok && n.pools.iter().any(|x| x == k))).copied();
            let by = culprit.or(movers.first().copied());
            let miss_kind = |n: &TxNote| match (n.fate, n.ok) {
                (Fate::Skipped, _) => "missedFilter",
                (Fate::OffRoute, _) => "missedOffRoute",
                (Fate::Ran, true) => "missedRan",
                (Fate::Ran, false) => "missedReverted",
                (Fate::Failed, _) => "missedFailed",
                (Fate::Unknown, _) => "missedUnknown",
            };
            let kind = match (conf_moved.contains(k), p.changed_cum.contains(k)) {
                (true, false) => by.map_or("notFromTx", miss_kind),
                (false, true) => "phantom",
                // Both moved it to different values: if one of its movers was
                // missed (e.g. a second swap the filter skipped), that is the
                // cause; "value" only when we ran every mover and still differ.
                _ => culprit.map_or("value", miss_kind),
            };
            if kind == "notFromTx" {
                // Not a prediction miss (no transaction of this message moved
                // it): counted on its own, never as a disagreement.
                self.count(|s| s.not_from_tx += 1);
                continue;
            }
            // The base we predicted on was corrected later for this pool:
            // the base's miss (late reports), not the run's.
            let stale = st.prev.get(k).is_some_and(|pv| place_vals(place, &p.base_snap) != *pv);
            self.count(|s| {
                s.disagree += 1;
                if stale {
                    s.stale_base += 1;
                    return;
                }
                match kind {
                    "missedFilter" => s.missed_filter += 1,
                    "missedRan" => s.missed_ran += 1,
                    "missedReverted" => s.missed_reverted += 1,
                    "missedFailed" => s.missed_failed += 1,
                    "missedOffRoute" => s.missed_off_route += 1,
                    "missedUnknown" => s.missed_unknown += 1,
                    "phantom" => s.phantom += 1,
                    _ => s.value_diff += 1,
                }
                if kind.starts_with("missed") {
                    s.missed += 1;
                }
            });
            let sm = self.sample(p, st, k, if stale { "staleBase" } else { kind }, kind, by, &diffs, block);
            self.add_sample(sm);
        }
    }

    /// One disagreement sample (bounded: a few slots, a few transactions).
    #[allow(clippy::too_many_arguments)]
    fn sample(&self, p: &Pending, st: &Settled, k: &str, kind: &str, cause: &str, by: Option<&TxNote>, diffs: &[(U256, Lookup<U256>, U256)], block: u64) -> Value {
        let hx = |v: &U256| format!("{v:#x}");
        let mut sm = json!({
            "pool": k, "block": block, "baseBlock": block.saturating_sub(1), "kind": kind,
            "slots": diffs.iter().take(MAX_SLOT_DIFFS).map(|(sl, pr, cf)| json!({"slot": hx(sl), "pred": match pr { Lookup::Known(v) => json!(hx(v)), Lookup::Missing => Value::Null }, "conf": hx(cf)})).collect::<Vec<_>>(),
            "slotsDiffering": diffs.len(),
            "confMoved": st.moved.iter().any(|x| x == k), "predMoved": p.changed_cum.contains(k),
        });
        if kind != cause {
            sm["cause"] = json!(cause);
        }
        if let Some(n) = by {
            sm["tx"] = json!(format!("{:#x}", n.hash));
            sm["txFate"] = json!(n.fate.as_str());
            if n.fate == Fate::Ran {
                sm["txOk"] = json!(n.ok);
            }
            if let Some(w) = &n.why {
                sm["txWhy"] = json!(w);
            }
            if let Some(t) = n.to {
                sm["txTo"] = json!(format!("{t:#x}"));
            }
            if !n.pools.is_empty() {
                sm["txPools"] = json!(n.pools.iter().take(4).collect::<Vec<_>>());
            }
        }
        // Our transactions of this block that ran on / marked this pool.
        let ours: Vec<String> = p.notes.iter().filter(|n| n.pools.iter().any(|x| x == k)).take(4).map(|n| format!("{:#x}:{}", n.hash, n.fate.as_str())).collect();
        if !ours.is_empty() {
            sm["ourTxs"] = json!(ours);
        }
        sm
    }

    /// Hour: the first MAX_SAMPLES; totals: the newest MAX_SAMPLES (status
    /// always shows some, even after the hour's first ones).
    fn add_sample(&mut self, sm: Value) {
        if let Some(all) = &mut self.collect_all {
            all.push(sm.clone());
        }
        if self.hour.samples.len() < MAX_SAMPLES {
            self.hour.samples.push(sm.clone());
        }
        self.total.samples.push(sm);
        if self.total.samples.len() > MAX_SAMPLES {
            self.total.samples.remove(0);
        }
    }

    /// Transactions copy 2's reports say moved our pools: learn their target
    /// (and the pools) for next time. Skipped ones = the filter missed them.
    fn learn_from(&mut self, notes: &[TxNote], moved_by_tx: &dyn Fn(&B256) -> Option<Vec<String>>) {
        for n in notes {
            if let Some(p) = moved_by_tx(&n.hash).filter(|p| !p.is_empty()) {
                if n.fate == Fate::Skipped {
                    self.count(|s| s.filter_missed += 1);
                }
                if let Some(t) = n.to {
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

    /// Which of our pools a transaction we can't vouch for may touch (one we
    /// could not run exactly, or, FASTLANE_AHEAD_REVERT_UNSURE, one whose run
    /// reverted). What a collect run reads + what it names + the fallbacks
    /// below. Empty = nothing tells us (the caller decides: a failed run
    /// stops the prediction, a reverted one leaves the pools as they were).
    /// `failed`: count it in the failed-run counters (probes skipped,
    /// widened, nothing found, V4 only); a reverted run has its own.
    fn guess_touched(&mut self, ov: &Overlay, ctx: &BlockCtx, t: &DecodedTx, pools: &PoolSet, named_now: &Named, native: &[String], failed: bool) -> Vec<String> {
        self.last_probe = None;
        let mut hit = if target_has_no_code(ov, t.to) {
            if failed {
                self.count(|s| s.probes_skipped += 1);
            }
            Vec::new()
        } else {
            let reads = probe_reads(ov, ctx, t).unwrap_or_default();
            let hit = pools.touched_by(&reads.accounts, &reads.slots);
            // KEEPER: what the collect run read (learning only).
            if self.cfg.keeper {
                self.last_probe = Some(reads);
            }
            hit
        };
        for k in pools.named_direct(t.to, named_now).into_iter().chain(native.iter().cloned()) {
            if !hit.contains(&k) {
                hit.push(k);
            }
        }
        // Practice fixes: pools named only by their coin PAIR
        // (every exchange's pool of that pair) are added only for
        // pairs no pool found above already stands for. Before,
        // they were always added: one failed swap naming WETH and
        // USDG made every WETH / USDG pool unsure, i.e. BOTH
        // sides of every WETH / USDG route, and each later swap
        // on those pools then failed too (their values forgotten)
        // until copy 2 confirmed the block. A multi-hop path's
        // OTHER pairs (B/C after A/B) are still all added.
        for k in pools.named_by_pair_except(named_now, &hit) {
            if !hit.contains(&k) {
                hit.push(k);
            }
        }
        // Accuracy fixes (second practice run: a sure pool was
        // wrong after a failed run that did not mark it):
        //   - native-ETH pools of a named coin, whatever the ETH
        //     value (a V4 "sell for ETH" through a router pays none),
        //   - the target's learned pools this data could be
        //     trading (a named pair, e.g. a split route over sister
        //     pools; all of them when it names no coin: an opaque
        //     bot contract).
        // Only when something narrower was already found (an
        // empty `hit` keeps the H4 fallback below, unchanged).
        if !hit.is_empty() {
            let before = hit.len();
            let learned = t.to.and_then(|a| self.touchers.get(&a)).map(|x| pools.learned_for(&x.1, named_now)).unwrap_or_default();
            for k in pools.named_native_any(named_now).into_iter().chain(learned) {
                if !hit.contains(&k) {
                    hit.push(k);
                }
            }
            if hit.len() > before {
                if failed {
                    self.count(|s| s.failed_widened += 1);
                }
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
            // that is known, empty (the caller decides).
            if failed {
                self.count(|s| s.failed_unknown += 1);
            }
            // Accuracy fixes: of its learned pools, the ones this
            // data could be trading (all of them when it names no
            // coin), plus native-ETH pools of a named coin.
            hit = t.to.and_then(|a| self.touchers.get(&a)).map(|x| pools.learned_for(&x.1, named_now)).unwrap_or_default();
            for k in pools.named_native_any(named_now) {
                if !hit.contains(&k) {
                    hit.push(k);
                }
            }
            if hit.is_empty() && pools.names_pm(t.to, named_now) {
                hit = pools.v4_sharing_named_coins(t.to, named_now);
                if !hit.is_empty() && failed {
                    self.count(|s| s.v4_fallback += 1);
                }
            }
            if hit.is_empty() {
                hit = pools.sharing_named_coins(named_now);
            }
        }
        hit
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
        // KEEPER: the base with the keeper's exact values of the same block
        // (and the provenance that says so); the plain base otherwise.
        let (base_snap, base_prov) = self.base_parts(base);
        let (prev_snap, prev_ctx, mut changed_cum, mut unsure_cum) = match self.entries.back() {
            Some(e) => (e.snap.clone(), e.ctx.clone(), e.changed_cum.clone(), e.unsure_cum.clone()),
            None => (base_snap, base.ctx.clone().ok_or("no_block_details")?, HashSet::new(), HashSet::new()),
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
        let assume = Assume { sender_funds: true, recent_fill: true, skip: None, record_hashes: true, proven_skip: false };
        let mut changed: Vec<String> = Vec::new();
        let mut notes: Vec<TxNote> = Vec::with_capacity(txs.len());
        let note = |t: &DecodedTx, fate: Fate, ok: bool, why: Option<String>, pools: Vec<String>| TxNote { hash: t.hash, to: t.to, fate, ok, why, pools };
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
                notes.push(note(t, Fate::Skipped, true, None, Vec::new()));
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
                            notes.push(note(t, Fate::OffRoute, true, None, named));
                            continue;
                        }
                    }
                }
            }
            self.count(|s| s.txs_run += 1);
            let plan = OrderedPlan { msgs: vec![PlanMsg { seq: m.seq, ctx: ctx.clone(), txs: vec![t.clone()] }], trigger: t.hash, call_ctx: ctx.clone(), unrunnable: Vec::new() };
            match run_ordered_keep(&ov, &plan, base_prov.as_ref(), &assume) {
                Ok((out, kept)) => {
                    // Did OUR run finish normally? (A reverted run moves
                    // nothing: agreement tells it apart, accuracy fixes.)
                    let (ok, why) = match out.replayed.first() {
                        Some(r) if !r.outcome.success => (false, Some(revert_why(&r.outcome))),
                        _ => (true, None),
                    };
                    if !out.assumed.labels().is_empty() {
                        self.count(|s| s.assumed += 1);
                    }
                    // Review M1: built on a value we only assumed (a fill
                    // re-read every minute, or a sender's funds): what it
                    // moved can't be vouched for. Its pools become unsure.
                    let a = &out.assumed;
                    let shaky = a.recent_fill || a.call_fill || (a.sender_funds && !self.cfg.trust_sender_funds);
                    // FASTLANE_AHEAD_REVERT_UNSURE (Oct 31): a picked
                    // transaction whose run reverted can't be vouched for
                    // (see AheadCfg). Worked out on the copy BEFORE its
                    // (gas / nonce only) changes are kept, like a failed run.
                    let revert_hit = if !ok && self.cfg.revert_unsure { Some(self.guess_touched(&ov, &ctx, t, &pools, &named_now, &native, false)) } else { None };
                    // KEEPER: a reverted run often read a value copy 2 only
                    // holds approximately (a bot's settings, a coin balance):
                    // the keeper learns what its collect run read.
                    if !ok {
                        if revert_hit.is_none() && self.cfg.keeper {
                            self.last_probe = probe_reads(&ov, &ctx, t);
                        }
                        self.learn_from_run(&[], &ov, base_prov.as_ref(), t.from);
                    }
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
                    for k in &moved {
                        // Values forgotten earlier stay forgotten (a later
                        // exact write puts back only what it wrote).
                        if !changed.contains(k) {
                            changed.push(k.clone());
                        }
                        changed_cum.insert(k.clone());
                    }
                    match revert_hit {
                        Some(hit) if !hit.is_empty() => {
                            self.count(|s| s.reverts_marked += 1);
                            mark_unsure(&mut ov, &mut changed, &mut changed_cum, &mut unsure_cum, &hit);
                            // The note lists the pools marked (a reverted run
                            // moves nothing of ours: `moved` is empty).
                            let mut pools_noted = moved;
                            for k in hit {
                                if !pools_noted.contains(&k) {
                                    pools_noted.push(k);
                                }
                            }
                            notes.push(note(t, Fate::Ran, ok, why, pools_noted));
                        }
                        Some(_) => {
                            self.count(|s| s.reverts_kept += 1);
                            notes.push(note(t, Fate::Ran, ok, why, moved));
                        }
                        None => notes.push(note(t, Fate::Ran, ok, why, moved)),
                    }
                }
                Err(u) => {
                    let why = failed_why(&u, t.to, &pools);
                    self.count(|s| s.txs_failed += 1);
                    if self.diag.is_some() {
                        // Replay diagnostics: the reason, and (keeper) whether
                        // the missing value's contract is kept.
                        let owner = u.missing.first().and_then(|m| match m {
                            crate::state::MissItem::Slot(a, _) | crate::state::MissItem::Account(a) => Some(*a),
                            crate::state::MissItem::Code(_) => None,
                        });
                        let kept = match (&self.merged, owner) {
                            (Some(m), Some(a)) if m.kept.accounts.contains_key(&a) => " [keeper holds that contract]",
                            (Some(_), Some(_)) => " [keeper does not hold it]",
                            _ => "",
                        };
                        let k = format!("{why}{kept}");
                        if let Some(d) = self.diag.as_mut() {
                            *d.0.entry(k).or_default() += 1;
                        }
                    }
                    // Which of our pools might it touch? What it reads in a
                    // collect run + what it names. Those become unsure.
                    // Practice fixes: the collect run is skipped when the
                    // target has no code in our copy (it could only read
                    // zero there and stop: nothing of ours, same answer).
                    let hit = self.guess_touched(&ov, &ctx, t, &pools, &named_now, &native, true);
                    // KEEPER: the values it lacked (and what its collect run
                    // read that we don't hold exactly) are learned.
                    self.learn_from_run(&u.missing, &ov, base_prov.as_ref(), t.from);
                    if hit.is_empty() {
                        if !self.cfg.unknown_continue {
                            return Err("failed_tx_unknown_effect");
                        }
                        // FASTLANE_AHEAD_UNKNOWN_CONTINUE: nothing ties it to
                        // our pools (no pool it reads, names or moved before,
                        // no coin of ours, no PoolManager): predict past it,
                        // marking nothing. It is noted "unknown" so a pool it
                        // DID move is counted "missedUnknown" (measured, not
                        // trusted blindly). Its target is remembered, like any
                        // failed run's, and taught real pools by copy 2.
                        self.count(|s| s.unknown_continued += 1);
                        if let Some(a) = t.to {
                            self.learn_toucher(a, &[]);
                        }
                        notes.push(note(t, Fate::Unknown, false, Some(why), Vec::new()));
                        continue;
                    }
                    self.count(|s| s.txs_marked += 1);
                    // Its target is remembered (its next calls are picked),
                    // but NOT these pools: they are our guesses, and a
                    // router's list must hold only pools it really moved
                    // (copy 2's reports, our exact runs), or the guesses
                    // crowd them out (accuracy fixes).
                    if let Some(a) = t.to {
                        self.learn_toucher(a, &[]);
                    }
                    mark_unsure(&mut ov, &mut changed, &mut changed_cum, &mut unsure_cum, &hit);
                    notes.push(note(t, Fate::Failed, false, Some(why), hit));
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
            notes,
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

/// One pool's own values in a snapshot (see PlaceVals): a contract pool's
/// declared variables it holds, a V4 pool's base values it holds.
fn place_vals(p: Place, snap: &Snapshot) -> PlaceVals {
    match p {
        Place::Contract(a) => {
            let acc = snap.accounts.get(&a)?;
            let mut v: Vec<(U256, U256)> = acc.storage.iter().filter(|(s, _)| **s < U256::from(DECLARED_MAX)).map(|(s, x)| (*s, *x)).collect();
            v.sort();
            Some(v)
        }
        Place::V4(pm, base) => {
            let v: Vec<(U256, U256)> = (0..4u8)
                .filter_map(|k| {
                    let s = base + U256::from(k);
                    match snap.storage(pm, s) {
                        Lookup::Known(x) => Some((s, x)),
                        Lookup::Missing => None,
                    }
                })
                .collect();
            (!v.is_empty()).then_some(v)
        }
    }
}

/// Did this pool's own values change between two snapshots? Cheap first
/// look: an untouched contract account keeps the very same storage map
/// (persistent maps share it), so most pools are answered by one pointer
/// compare.
fn place_changed(p: Place, prev: &Snapshot, now: &Snapshot) -> bool {
    if let Place::Contract(a) = p {
        match (prev.accounts.get(&a), now.accounts.get(&a)) {
            (None, None) => return false,
            (Some(x), Some(y)) if x.storage.ptr_eq(&y.storage) => return false,
            _ => {}
        }
    }
    place_vals(p, prev) != place_vals(p, now)
}

/// The confirmed values `conf` our predicted copy does not hold the same:
/// (slot, what we hold, confirmed value). Empty = agree. (Same rule as
/// before: every value the CONFIRMED copy holds must be held equal by us.)
fn place_diffs(p: Place, pred: &Snapshot, conf: &[(U256, U256)]) -> Vec<(U256, Lookup<U256>, U256)> {
    let (acct, _) = match p {
        Place::Contract(a) => (a, ()),
        Place::V4(pm, _) => (pm, ()),
    };
    conf.iter()
        .filter_map(|(s, v)| {
            let ours = pred.storage(acct, *s);
            (ours != Lookup::Known(*v)).then_some((*s, ours, *v))
        })
        .collect()
}

impl Settled {
    /// From copy 2's versions `prev` (block seq - 1) and `now` (block seq):
    /// every pool of ours whose own values differ between them, with the
    /// values of those and of `extra` (the pools the prediction moved).
    /// `base_used`: the version the prediction was built on, if known (its
    /// pools that differ from `prev` = corrected later: `late`).
    pub fn build<'a>(pools: &PoolSet, seq: u64, prev: &Snapshot, now: &Snapshot, extra: impl Iterator<Item = &'a String>, base_used: Option<&Snapshot>) -> Settled {
        let mut st = Settled { seq, ..Default::default() };
        let mut keys: Vec<&String> = pools.places.keys().collect();
        keys.sort();
        for k in keys {
            let p = pools.places[k];
            if place_changed(p, prev, now) {
                st.moved.push(k.clone());
            }
            if let Some(b) = base_used {
                if !std::ptr::eq(b, prev) && place_changed(p, b, prev) {
                    st.late.push(k.clone());
                }
            }
        }
        let mut want: Vec<String> = st.moved.clone();
        want.extend(extra.cloned());
        st.fill_from(pools, want.iter(), prev, now);
        st
    }

    /// Fill in values of `keys` not already here, from snapshots (the
    /// offline replay: pools only it predicted moved).
    pub fn fill_from<'a>(&mut self, pools: &PoolSet, keys: impl Iterator<Item = &'a String>, prev: &Snapshot, now: &Snapshot) {
        for k in keys {
            if self.now.contains_key(k) {
                continue;
            }
            if let Some(p) = pools.places.get(k) {
                self.now.insert(k.clone(), place_vals(*p, now));
                self.prev.insert(k.clone(), place_vals(*p, prev));
            }
        }
    }
}

/// Why our run of a feed transaction reverted / halted (short, groupable).
fn revert_why(o: &crate::check::CallOutcome) -> String {
    if let Some(h) = &o.halt {
        return format!("halt: {}", h.chars().take(60).collect::<String>());
    }
    if o.output.len() >= 4 {
        let sel = &o.output[..4];
        // Error(string): show the text (often "STF", "Too little received").
        if sel == [0x08, 0xc3, 0x79, 0xa0] && o.output.len() >= 68 {
            let n = U256::from_be_slice(&o.output[36..68]).saturating_to::<usize>().min(48);
            let txt: String = o.output.get(68..68 + n).map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
            return format!("revert: {txt}");
        }
        return format!("revert 0x{}", sel.iter().map(|b| format!("{b:02x}")).collect::<String>());
    }
    "revert (no data)".into()
}

/// Why a feed transaction could not be run exactly (short, groupable:
/// addresses named by role, never printed).
fn failed_why(u: &crate::check::CheckUnknown, to: Option<Address>, pools: &PoolSet) -> String {
    let role = |a: &Address| {
        if Some(*a) == to {
            "target"
        } else if pools.by_contract.contains_key(a) {
            "a pool"
        } else if pools.idx.pms.contains(a) {
            "the V4 PoolManager"
        } else if pools.idx.role(a) & ROLE_COIN != 0 {
            "a coin"
        } else {
            "another contract"
        }
    };
    let first = u.missing.first().map(|m| match m {
        crate::state::MissItem::Account(a) => format!("{} account", role(a)),
        crate::state::MissItem::Slot(a, _) => format!("a value of {}", role(a)),
        crate::state::MissItem::Code(_) => "contract code".to_string(),
    });
    match first {
        Some(f) => format!("{}: {f}", u.reason.as_str()),
        None => format!("{}: {}", u.reason.as_str(), u.detail.chars().take(60).collect::<String>()),
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
fn probe_reads(view: &dyn StateRead, ctx: &BlockCtx, t: &DecodedTx) -> Option<crate::check::db::ReadLog> {
    let ov = Overrides::none();
    let mut s = Session::new(view, ctx, &ov, CheckOptions::default());
    s.db().set_recording(true);
    if matches!(view.account(t.from), Lookup::Missing) {
        s.db().add_pretend(t.from, AccountInfo { balance: t.value, nonce: t.nonce, code_hash: KECCAK_EMPTY, ..Default::default() });
    }
    let _ = s.apply_decoded(t);
    Some(std::mem::take(&mut s.db().reads))
}

// ---------------------------------------------------------------------------
// Runtime: one light thread in the running sidecar (only when FASTLANE is on)
// ---------------------------------------------------------------------------

enum Ev {
    /// A feed message and when it reached arbsim.
    Feed(Arc<BinMsg>, Instant),
    Confirmed,
    /// The keeper (copy2/keeper.rs) published a version.
    Kept,
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
    /// FASTLANE_AHEAD=on: the fast lane scans the tips. observe: false, the
    /// tips are never handed out (wait_tip / global_tip answer None), so no
    /// lane, scanner or trigger decision can ever read them.
    feeds: bool,
}

static RT: OnceLock<Runtime> = OnceLock::new();

/// Start the predicted copy for this sidecar (copy 2 mode). Does nothing
/// and returns false when FASTLANE is off (the default).
pub fn start(c2: super::intake::Copy2Handle) -> bool {
    // Oct 27 (owner: "predicted copy: do NOT expand it ... default it off"):
    // 5.9% agreement on 300 real blocks, unsure on nearly every pool. It now
    // runs only when asked for: FASTLANE_AHEAD=on (with FASTLANE practice /
    // live). Off = no thread, no memory; the fast lane scans copy 2 instead.
    // Oct 31: FASTLANE_AHEAD=observe runs it WITHOUT feeding the lane.
    let am = AheadMode::parse(std::env::var("FASTLANE_AHEAD").ok().as_deref());
    if am == AheadMode::Off {
        return false;
    }
    start_as(mode(), am, c2, AheadCfg::from_lookup(|k| std::env::var(k).ok(), 0))
}

/// FASTLANE_AHEAD: "on" / "1" / "true" = run the predicted copy and scan on
/// it; "observe" = run it and measure only (Oct 31); anything else (unset
/// included) = off (the default since Oct 27).
pub fn ahead_wanted(v: Option<&str>) -> bool {
    AheadMode::parse(v) != AheadMode::Off
}

/// Is the predicted copy running AND meant to feed the fast lane
/// (FASTLANE_AHEAD=on)? false when off or observe: the lane then scans copy
/// 2's confirmed versions, exactly as with the predicted copy off.
pub fn feeds_lane() -> bool {
    RT.get().is_some_and(|rt| rt.feeds)
}

/// Is the predicted copy running in observe mode (measuring only)?
pub fn observing() -> bool {
    RT.get().is_some_and(|rt| !rt.feeds)
}

/// `start` with the mode given (tests: Off must start nothing), as "on".
pub fn start_with(m: Mode, c2: super::intake::Copy2Handle, cfg: AheadCfg) -> bool {
    start_as(m, AheadMode::On, c2, cfg)
}

/// `start` with both switches given. `am` Off starts nothing; Observe runs
/// the predicted copy but never hands its tips out (see AheadMode).
pub fn start_as(m: Mode, am: AheadMode, c2: super::intake::Copy2Handle, mut cfg: AheadCfg) -> bool {
    if m == Mode::Off || am == AheadMode::Off || RT.get().is_some() {
        return false;
    }
    let feeds = am == AheadMode::On;
    cfg.l2_offset = c2.sh.cfg.l2_offset;
    let (tx, rx) = std::sync::mpsc::sync_channel::<Ev>(4096);
    if RT.set(Runtime { tx, tip: Mutex::new((0, None)), tip_cv: std::sync::Condvar::new(), status: Mutex::new(json!({})), agreement: Mutex::new(PredictionCounts::default()), dropped: Default::default(), feeds }).is_err() {
        return false;
    }
    eprintln!(
        "[arbsim] fastlane ahead: predicted copy {} (FASTLANE={}); max {} blocks, filter {}, unknown-effect txs {}",
        if feeds { "ON (the fast lane scans its tips)" } else { "OBSERVE ONLY (measures itself; the fast lane never reads it)" },
        if m == Mode::Live { "live" } else { "practice" },
        cfg.max_blocks,
        if cfg.run_all { "all" } else { "smart" },
        if cfg.unknown_continue { "predicted past (FASTLANE_AHEAD_UNKNOWN_CONTINUE)" } else { "stop the prediction" },
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

/// copy2/keeper.rs: the keeper published a version (no-op when off).
pub fn kept_hook() {
    if let Some(rt) = RT.get() {
        let _ = rt.tx.try_send(Ev::Kept);
    }
}

/// The running sidecar's predicted tip (None when off / not ready).
pub fn global_tip() -> Option<Arc<AheadTip>> {
    // Observe mode: never handed out (nothing may decide on it).
    RT.get().filter(|rt| rt.feeds).and_then(|rt| rt.tip.lock().unwrap_or_else(|e| e.into_inner()).1.clone())
}

/// Wait (at most `timeout`) for a tip newer than number `after`. Returns
/// (its number, the tip). None = timed out / off. The fast lane's thread
/// sleeps here between blocks: no busy polling.
pub fn wait_tip(after: u64, timeout: Duration) -> Option<(u64, Arc<AheadTip>)> {
    // Observe mode: never handed out (nothing may decide on it).
    let rt = RT.get().filter(|rt| rt.feeds)?;
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
    v["mode"] = json!(if rt.feeds { "on" } else { "observe" });
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

/// The settled values of block `seq` from copy 2's published versions
/// (seq - 1 and seq, as they are NOW: late reports written in). `extra`:
/// pools whose values are wanted too; `base_used`: the version the
/// prediction was built on. None = copy 2 no longer holds both versions.
fn settled_from(pv: &crate::state::mirror::PubView, pools: &PoolSet, seq: u64, extra: &[String], base_used: Option<&Snapshot>) -> Option<Settled> {
    let find = |n: u64| pv.versions.iter().find(|v| v.seq == n);
    let (prev, now) = (find(seq.checked_sub(1)?)?, find(seq)?);
    Some(Settled::build(pools, seq, &prev.snap, &now.snap, extra.iter(), base_used))
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
    let mut routes_now: Option<Vec<String>> = None;
    // Accuracy fixes: the capture (FASTLANE_CAPTURE_FILE; None = off).
    let mut cap = super::ahead_capture::CapCfg::from_lookup(|k| std::env::var(k).ok()).map(super::ahead_capture::LiveCapture::new);
    loop {
        // Review M2: no idle polling. Woken by a feed message or a published
        // version (confirmed_hook); the 1 s timeout only drives the status
        // copy and the hourly line.
        let ev = rx.recv_timeout(Duration::from_secs(1));
        if matches!(ev, Err(RecvTimeoutError::Disconnected)) {
            if let Some(c) = &mut cap {
                c.stop(&a, "arbsim stopping");
            }
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
                if let Some(c) = cap.as_mut().filter(|c| c.on()) {
                    c.send(&a, super::ahead_capture::CapEv::Pools { list: list.0.clone(), not_ready: list.1.clone() });
                }
            }
        }
        let tg = crate::check::entry::table_gen();
        if tg != table_gen {
            table_gen = tg;
            let keys = crate::check::entry::route_keys().map(|(_, k)| k).filter(|k| !k.is_empty());
            routes_now = keys.as_ref().map(|k| {
                let mut v: Vec<String> = k.iter().cloned().collect();
                v.sort();
                v
            });
            a.set_route_pools(keys.map(Arc::new));
            if let Some(c) = cap.as_mut().filter(|c| c.on()) {
                c.send(&a, super::ahead_capture::CapEv::Routes(routes_now.clone()));
            }
        }
        // Confirmed first (a new version may already cover a feed message).
        // Every version published since the last one, in order (review L1:
        // agreement is per block; a jump would miscount). Accuracy fixes:
        // the SAME block's version replaced (copy 2 wrote late reports into
        // it) is handed too: the prediction rebases on the corrected copy.
        let pv = c2.sh.published.view();
        let newer: Vec<Arc<crate::state::mirror::Version>> = match &head {
            None => pv.head().cloned().into_iter().collect(),
            Some(h) if pv.head().is_some_and(|x| Arc::ptr_eq(x, h)) => Vec::new(),
            Some(h) => {
                let v: Vec<_> = pv.versions.iter().filter(|v| v.seq > h.seq).cloned().collect();
                if v.is_empty() {
                    pv.head().filter(|x| x.seq == h.seq).cloned().into_iter().collect()
                } else {
                    v
                }
            }
        };
        if !newer.is_empty() {
            // The registry summary for the readers' copy we just took (no
            // rebuild while it is current; review M2: never `core_for(None)`).
            let core = c2.core_for(Some(&pv));
            for v in newer {
                head = Some(v.clone());
                if cap.as_ref().is_some_and(|c| c.should_start()) {
                    let c = cap.as_mut().expect("checked");
                    c.begin(&a, &list.0, &list.1, routes_now.clone());
                }
                // Same cache key (head block, no extra holders) the head's
                // own checks use, so this never pushes theirs out.
                let prov = c2.provenance_with(&core, v.block, &[]);
                if let Some(c) = cap.as_mut().filter(|c| c.on()) {
                    c.prov(&a, &prov);
                }
                let prov: Arc<dyn Provenance + Send + Sync> = prov;
                // KEEPER: its version of this very block first (if it is
                // already there), so the rebase below merges it at once.
                if a.cfg().keeper {
                    if let Some(kv) = super::keeper::version_at(v.block) {
                        a.on_kept(kv);
                    }
                }
                let conf = Confirmed { seq: v.seq, snap: v.snap.clone(), ctx: v.ctx.clone(), diff: v.diff.clone(), prov };
                let rm = &c2.c2.recent_moves;
                // The "who moved what" answers used, for the capture.
                let asked: std::cell::RefCell<Vec<(B256, Option<Vec<String>>)>> = Default::default();
                let capturing = cap.as_ref().is_some_and(|c| c.on());
                a.on_confirmed(conf, &|h| {
                    let r = rm.lock().ok().and_then(|r| r.pools_of(h));
                    if capturing {
                        asked.borrow_mut().push((*h, r.clone()));
                    }
                    r
                });
                if let Some(c) = cap.as_mut().filter(|c| c.on()) {
                    c.confirmed(&a, asked.into_inner(), v.seq, v.ctx.clone(), v.snap.clone());
                }
            }
        }
        // AGREEMENT (accuracy fixes): blocks whose turn has come
        // (FASTLANE_AHEAD_COMPARE_DELAY_BLOCKS past them), against copy 2's
        // settled versions.
        if let Some(h) = &head {
            for seq in a.due(h.seq) {
                let Some((pools, keys, base)) = a.pending_parts(seq) else { continue };
                let Some(st) = settled_from(&pv, &pools, seq, &keys, Some(&base)) else {
                    a.drop_pending(seq);
                    continue;
                };
                let rm = &c2.c2.recent_moves;
                let asked: std::cell::RefCell<Vec<(B256, Option<Vec<String>>)>> = Default::default();
                let capturing = cap.as_ref().is_some_and(|c| c.on());
                a.compare_settled(&st, &|h| {
                    let r = rm.lock().ok().and_then(|r| r.pools_of(h));
                    if capturing {
                        asked.borrow_mut().push((*h, r.clone()));
                    }
                    r
                });
                if let Some(c) = cap.as_mut().filter(|c| c.on()) {
                    c.send(&a, super::ahead_capture::CapEv::Moves(asked.into_inner()));
                    c.send(&a, super::ahead_capture::CapEv::Settled(st));
                    c.written.insert(seq);
                }
            }
            // Capture: EVERY captured block gets its settled values (also
            // blocks the live prediction did not compare), for the replay.
            if let Some(c) = cap.as_mut().filter(|c| c.on()) {
                let delay = a.cfg().compare_delay;
                while c.to_settle.front().is_some_and(|s| s.saturating_add(delay) <= h.seq) {
                    let seq = c.to_settle.pop_front().expect("checked");
                    // Already written when the predicted copy compared it.
                    if c.written.remove(&seq) {
                        continue;
                    }
                    let pools = a.pools.clone();
                    if let Some(st) = settled_from(&pv, &pools, seq, &[], None) {
                        c.send(&a, super::ahead_capture::CapEv::Settled(st));
                    }
                }
            }
        }
        if let Ok(Ev::Feed(m, at)) = ev {
            a.on_feed_message_at(m.clone(), at);
            if let Some(c) = cap.as_mut().filter(|c| c.on()) {
                c.send(&a, super::ahead_capture::CapEv::Feed(m));
            }
            // Everything queued, in order (a burst after a reconnect).
            while let Ok(e) = rx.try_recv() {
                if let Ev::Feed(m, at) = e {
                    a.on_feed_message_at(m.clone(), at);
                    if let Some(c) = cap.as_mut().filter(|c| c.on()) {
                        c.send(&a, super::ahead_capture::CapEv::Feed(m));
                    }
                }
            }
        }
        // KEEPER: the keeper's version of our base block, if it came after
        // copy 2's (a keeper rebase); and what our runs asked it to learn.
        if a.cfg().keeper {
            if let Some(b) = a.base_block() {
                if let Some(kv) = super::keeper::version_at(b) {
                    a.on_kept(kv);
                }
            }
            if !a.learned.is_empty() {
                super::keeper::learn_hook(std::mem::take(&mut a.learned));
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
                let mut st = status_of(&a);
                if let Some(c) = &cap {
                    st["capture"] = json!({"file": c.cfg.path, "on": c.on(), "bytes": c.cap.as_ref().map(|x| x.bytes.load(std::sync::atomic::Ordering::Relaxed))});
                }
                *rt.status.lock().unwrap_or_else(|e| e.into_inner()) = st;
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
        // Observe-mode build (Oct 31): the live accuracy at a glance, per
        // (pool, block) compared once the real block arrived: exact = same
        // values, wrong = we were sure and differ, unsure = we had said so.
        // blocksAhead = per feed message, how many blocks the tip was ahead
        // of copy 2 (0 = no tip). Hour and since start.
        "accuracy": {"hour": accuracy_json(&a.hour, true), "total": accuracy_json(&a.total, false)},
        // KEEPER (copy2/keeper.rs): is the base laid over with the keeper's
        // values of the same block right now; its own section: fastlaneKeeper.
        "keeper": {"on": a.cfg.keeper, "baseMerged": a.merged.as_ref().is_some_and(|m| Some(m.seq) == a.base.as_ref().map(|b| b.seq)),
            "keptBases": a.hour.kept_bases, "keptMissing": a.hour.kept_missing, "keptRebases": a.hour.kept_rebases, "learned": a.hour.learned},
        "hour": a.hour.json(), "total": a.total.json_with(false),
    })
}

/// The accuracy summary (status "fastlaneAhead.accuracy"). `times` false =
/// no blocks-ahead percentiles (no copy + sort of the since-start ring).
fn accuracy_json(s: &AheadStats, times: bool) -> Value {
    let pct = |a: u64, b: u64| (b > 0).then(|| (1000.0 * a as f64 / b as f64).round() / 10.0);
    json!({
        "exact": s.agree, "wrong": s.disagree, "unsure": s.unsure,
        "exactPctOfSure": pct(s.agree, s.agree + s.disagree),
        "surePct": pct(s.agree + s.disagree, s.agree + s.disagree + s.unsure),
        "blocksCompared": s.compared, "blocksUnpredicted": s.unpredicted,
        "tipSharePct": pct(s.tips, s.msgs),
        "blocksAhead": if times { let mut b = s.ahead_blocks.clone(); crate::timing::pct_of(&mut b) } else { Value::Null },
        "unknownContinued": s.unknown_continued, "missedUnknown": s.missed_unknown,
        "keptBasesPct": pct(s.kept_bases, s.kept_bases + s.kept_missing),
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

    /// Practice fixes: a failed run that was found to trade pool P1 (pair
    /// A/B) no longer marks P1's sister pools of A/B (other exchanges), but
    /// a path's OTHER pairs named in the data (B/C) still count.
    #[test]
    fn pair_named_pools_skip_pairs_already_found() {
        let (ca, cb, cc) = (Address::from([0x0a; 20]), Address::from([0x0b; 20]), Address::from([0x0c; 20]));
        let fp = |b: u8| {
            let a = Address::from([b; 20]);
            FollowedPool { key: format!("{a:#x}"), address: a, v4_id: None }
        };
        let set = PoolSet::build(&[(fp(1), ca, cb), (fp(2), cb, ca), (fp(3), cb, cc)], HashSet::new());
        let mut data = Vec::new();
        for c in [ca, cb, cc] {
            data.extend_from_slice(&[0u8; 12]);
            data.extend_from_slice(c.as_slice());
        }
        let n = set.scan(&data);
        let k = |b: u8| format!("{:#x}", Address::from([b; 20]));
        assert_eq!(sorted(set.named_by_pair(&n)), sorted(vec![k(1), k(2), k(3)]), "old rule: every pool of every named pair");
        assert_eq!(set.named_by_pair_except(&n, &[k(1)]), vec![k(3)], "P1 found: its sister P2 is left out, B/C still counts");
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
