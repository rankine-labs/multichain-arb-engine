// ============================================================================
// FAST LANE A: THE HOT-CONTRACT KEEPER (Oct 31, owner-approved "real fix"
// for the predicted copy, part 2).
//
// Plain English:
//   The predicted copy (copy2/ahead.rs) re-runs the feed's transactions on
//   copy 2. Copy 2 only holds OUR pools exactly. Roughly 9 in 10 of the
//   other bots' transactions that touch our pools could not be re-run
//   exactly: they read values of contracts copy 2 doesn't follow (the rival
//   bot's own settings, a router, a coin's balances, other V4 pools in the
//   PoolManager): "a value of target" / "account of target" misses.
//
//   The keeper holds THOSE values exactly, for the few contracts that keep
//   coming up ("hot" contracts):
//     1. LEARN. Every run of the predicted copy that missed a value, or
//        read one copy 2 only holds approximately, names it (the contract
//        and the slot). Each contract gets a score; the top
//        FASTLANE_AHEAD_KEEP_CONTRACTS [50] are kept.
//     2. SEED. For a kept contract, the values it needed are read ONCE from
//        the paid node at the keeper's block (eth_getProof: one call for
//        many values of one contract; its code once with eth_getCode).
//     3. KEEP EXACT. After every block (copy 2's newest block tells us the
//        node has it), the node's own list of what the block changed is
//        fetched (debug_traceBlockByNumber, prestate tracer, diff mode,
//        without code: ~12-34 KB, ~31 ms) and applied to the values we
//        hold. One call per block: ~9 calls a second.
//     4. NEVER GUESS. A value a block's changes touch but that we never
//        held stays unknown (only held values are updated). A value we
//        hold is exact at the keeper's block or not served at all.
//     5. SERVE. The predicted copy asks for the keeper's version of its
//        base block (exactly that block, never another one) and lays the
//        held values over copy 2's (the keeper's exact value wins where the
//        two differ, ahead3), marking them exact (KeptProv).
//     6. ADOPT (ahead3, FASTLANE_AHEAD_KEEP_ADOPT [on]): a value a block
//        writes in a kept contract becomes kept too (exact from the diff,
//        no node call); a contract created at a kept address is seeded
//        again with its code (diffs come without code).
//
//   SAFETY (fail closed):
//     - Bounded memory: at most FASTLANE_AHEAD_KEEP_CONTRACTS contracts,
//       FASTLANE_AHEAD_KEEP_SLOTS values each, FASTLANE_AHEAD_KEEP_MAX_SLOTS
//       in all, 64 block versions (persistent maps: a version is a pointer
//       copy plus what changed). Cold contracts lose their place (scores
//       halve every hour, a newcomer must clearly beat the coldest kept one).
//     - A missing block, a node error streak, the copy falling more than
//       FASTLANE_AHEAD_KEEP_MAX_BEHIND blocks behind copy 2, copy 2 going
//       BACKWARDS (a reorg) or an AUDIT mismatch = everything held is
//       dropped (all unknown) and seeded again. The audit re-reads one kept
//       contract's values from the node every FASTLANE_AHEAD_KEEP_AUDIT_S
//       [60] seconds and compares them with ours.
//     - NO self-imposed node caps (owner rule, Oct 31: no daily allowance,
//       no own speed limit on Chainstack). The keeper's pace is set by the
//       work itself: one block diff per block, seeds only while it is
//       caught up. Its calls go through its own NodeClient (so copy 2's
//       pacing and counters stay copy 2's), which keeps only the shared
//       provider handling every node user has: when Chainstack answers
//       "too fast" (-32005 / 429) the rate is halved and recovers by itself
//       (node.rs), and the keeper waits and retries the same block (never
//       counted as a node error, never a reset by itself).
//     - Only runs with FASTLANE_AHEAD=on|observe AND FASTLANE_AHEAD_KEEPER
//       on (default: on in observe, off with on). Otherwise no thread, no
//       node call, no memory.
//
//   LIVE SPEED (Oct 31 night; live: 19 restarts in 23 minutes for falling
//   64+ blocks behind, its version matched only half of the bases): the
//   runtime is now pipelined (`drive_pipelined`): several block diffs out at
//   once (FASTLANE_AHEAD_KEEP_FETCH_PAR), seeds and audits on their own lane
//   (FASTLANE_AHEAD_KEEP_SEED_PAR), reading up to the feed's newest block
//   (FASTLANE_AHEAD_KEEP_LEAD) so its version is ready before copy 2's; a
//   block apply only touches the values we hold (no copy of every held key);
//   learned values are taken as one batch; a full candidate list keeps its
//   newcomers and candidates remember fewer values
//   (FASTLANE_AHEAD_KEEP_CAND_SLOTS). New way by default only with
//   FASTLANE_AHEAD=observe. The runtime talks to the world through
//   `KeeperIo`, so `ahead-replay --live-timing` runs the very same code
//   against a node model in real time.
//
//   The core (`KeeperCore`) does no I/O, so the offline replay
//   (`arbsim ahead-replay --keeper <truth file>`) runs the very same code
//   on recorded block diffs.
// ============================================================================
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use revm::primitives::{Address, B256, KECCAK_EMPTY, U256};
use revm::state::{AccountInfo, Bytecode};
use serde_json::{json, Value};

use crate::check::ordered::Provenance;
use crate::state::snap::{normalize, Acct, Basics, PMap, Snapshot};
use crate::state::{AccountDiff, MissItem, StateDiff};
#[allow(unused_imports)]
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// FASTLANE_AHEAD_KEEP* settings (see the file header).
#[derive(Clone, Debug)]
pub struct KeeperCfg {
    /// FASTLANE_AHEAD_KEEPER: keep hot contracts exact (on / off). Default:
    /// on with FASTLANE_AHEAD=observe, off with FASTLANE_AHEAD=on.
    pub on: bool,
    /// FASTLANE_AHEAD_KEEP_CONTRACTS [50]: most contracts kept.
    pub max_contracts: usize,
    /// FASTLANE_AHEAD_KEEP_SLOTS [2000]: most values kept per contract.
    pub max_slots_per: usize,
    /// FASTLANE_AHEAD_KEEP_MAX_SLOTS [200000]: most values kept in all.
    pub max_slots_total: usize,
    /// FASTLANE_AHEAD_KEEP_ADOPT [on]: a value a block WRITES in a contract
    /// we keep becomes kept too (its new value is in the block's changes,
    /// exact, at no node cost). So the busy contracts' (the V4 PoolManager:
    /// every tick a swap crosses) values fill in by themselves. Up to 10x
    /// FASTLANE_AHEAD_KEEP_SLOTS per contract, within the overall limit.
    pub adopt_writes: bool,
    /// Block versions kept for the predicted copy (and block changes kept
    /// for seeds that come back a few blocks late).
    pub versions: usize,
    /// Seed calls allowed an hour. 0 = no limit (live: always 0, no
    /// self-imposed cap). Only the offline replay sets it
    /// (`--keep-seeds-per-h`) to model a slower cold start.
    pub seeds_per_hour: u64,
    /// FASTLANE_AHEAD_KEEP_AUDIT_S [60]: seconds between audits (0 = none).
    pub audit_s: u64,
    /// FASTLANE_AHEAD_KEEP_MAX_BEHIND [64]: blocks behind copy 2 before the
    /// keeper starts again from copy 2's block.
    pub max_behind: u64,
    /// Most values one seed call asks for (one contract).
    pub seed_batch: usize,
    /// Most learned (not kept) candidate contracts remembered.
    pub max_candidates: usize,
    /// FASTLANE_AHEAD_KEEP_FETCH_PAR (live speed, Oct 31 night): block
    /// diffs asked for at the same time (a pipeline: answers are applied
    /// strictly in block order, never with a gap). 1 = the old one-at-a-time
    /// loop. Default: 4 with FASTLANE_AHEAD=observe, 1 otherwise. 1..=16.
    pub fetch_par: usize,
    /// FASTLANE_AHEAD_KEEP_SEED_PAR: seed (and audit) reads in flight at once,
    /// on their own lane, so they never hold up the block diffs. 0 = the old
    /// rule (one seed at a time, only while caught up, on the same thread).
    /// Default: 2 with FASTLANE_AHEAD=observe, 0 otherwise. 0..=8.
    pub seed_par: usize,
    /// FASTLANE_AHEAD_KEEP_LEAD: fetch block diffs up to the newest block the
    /// FEED has announced, not only up to copy 2's (copy 2 is ~0.5 s / ~5
    /// blocks behind the feed, the node is not). So the keeper's version of a
    /// block is usually ready BEFORE copy 2 publishes it, and the predicted
    /// copy merges it at once (no second rebuild). A block the node does not
    /// have yet is simply asked again. The "too far behind" restart still
    /// measures against copy 2. Default: on with FASTLANE_AHEAD=observe.
    pub lead_feed: bool,
    /// FASTLANE_AHEAD_KEEP_CAND_SLOTS: most values remembered per contract
    /// that is only a CANDIDATE (not kept). Kept contracts still use
    /// FASTLANE_AHEAD_KEEP_SLOTS. Bounds the memory of the 4,096 candidates
    /// (before: up to 2,000 values each). Default: 256 with
    /// FASTLANE_AHEAD=observe, else = FASTLANE_AHEAD_KEEP_SLOTS (old).
    pub cand_slots: usize,
    /// FASTLANE_AHEAD_KEEP_PRUNE_BLOCKS (memory fix, Nov 1): every this many
    /// blocks the keeper forgets the values of its kept contracts that
    /// (a) no predicted run ever asked for (not "learned") AND (b) no block
    /// wrote in the last two such windows. Those are values it ADOPTED
    /// because a block once wrote them (FASTLANE_AHEAD_KEEP_ADOPT): live
    /// they piled up ~10,000 an hour toward the 200,000 cap and never went
    /// away. Codes no kept account uses any more go too. 0 = off (old:
    /// keep everything until the cap). Safe: a dropped value is just "not
    /// held"; a run that needs it again misses it once, which makes it
    /// learned (kept for good) and seeded again from the node.
    ///
    /// Default 3,000 blocks (~5 min at the ~9.7 blocks/s measured live), so
    /// an adopted value nobody writes leaves after 10-15 min.
    /// WHY NOT 18,000 (the first default, PR #263): live Nov 1-2 its
    /// prune removed 0 values while the keeper grew 10,000 -> 95,000
    /// values in 57 min. By design the FIRST prune can never drop
    /// anything: every adopted value was adopted because a block wrote it,
    /// so it was "written in this window", and every seeded value is
    /// learned. The first drop can only come at the THIRD prune
    /// (3 x 18,000 blocks = ~93 min), and arbsim was restarted (deploys)
    /// every 45-62 min, so it never came. Replayed with the oracle
    /// (ahead-replay, Nov 2) even a prune every 100 blocks (30x more
    /// often than this default) dropped 28% of the held values with the
    /// same agreement (31 / 7 vs 30 / 7 with it off) and 0 wrong values.
    pub prune_blocks: u64,
}

/// FASTLANE_AHEAD_KEEP_PRUNE_BLOCKS default (memory fix 2, Nov 2): ~5 min
/// of blocks live. See `KeeperCfg::prune_blocks` for why not 18,000.
pub const PRUNE_BLOCKS_DEFAULT: u64 = 3_000;

impl Default for KeeperCfg {
    fn default() -> Self {
        KeeperCfg {
            on: false,
            max_contracts: 50,
            max_slots_per: 2000,
            max_slots_total: 200_000,
            adopt_writes: true,
            versions: 64,
            seeds_per_hour: 0,
            audit_s: 60,
            max_behind: 64,
            seed_batch: 100,
            max_candidates: 4096,
            fetch_par: 1,
            seed_par: 0,
            lead_feed: false,
            cand_slots: 2000,
            // Off for the core's own defaults (tests, replay) unless asked;
            // the live setting (from_lookup) defaults to on.
            prune_blocks: 0,
        }
    }
}

impl KeeperCfg {
    /// From any key -> value lookup (tests pass a map).
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> KeeperCfg {
        let d = KeeperCfg::default();
        let num = |k: &str, dv: u64, lo: u64, hi: u64| get(k).and_then(|v| v.trim().parse::<u64>().ok()).filter(|v| (lo..=hi).contains(v)).unwrap_or(dv);
        let am = super::ahead::AheadMode::parse(get("FASTLANE_AHEAD").as_deref());
        let observe = am == super::ahead::AheadMode::Observe;
        let on = am != super::ahead::AheadMode::Off && super::ahead::on_off(get("FASTLANE_AHEAD_KEEPER").as_deref()).unwrap_or(observe);
        let max_slots_per = num("FASTLANE_AHEAD_KEEP_SLOTS", d.max_slots_per as u64, 1, 100_000) as usize;
        // Live-speed settings (Oct 31 night): the new way is the default only
        // when the predicted copy just OBSERVES (it decides nothing); with
        // FASTLANE_AHEAD=on everything stays as before unless set.
        KeeperCfg {
            fetch_par: num("FASTLANE_AHEAD_KEEP_FETCH_PAR", if observe { 4 } else { 1 }, 1, 16) as usize,
            seed_par: num("FASTLANE_AHEAD_KEEP_SEED_PAR", if observe { 2 } else { 0 }, 0, 8) as usize,
            lead_feed: super::ahead::on_off(get("FASTLANE_AHEAD_KEEP_LEAD").as_deref()).unwrap_or(observe),
            cand_slots: num("FASTLANE_AHEAD_KEEP_CAND_SLOTS", if observe { 256 } else { max_slots_per as u64 }, 1, 100_000) as usize,
            // Memory fix (Nov 1): 0 = off; anything else at least 100 blocks.
            // Default 3,000 (memory fix 2, Nov 2; was 18,000: see above).
            prune_blocks: get("FASTLANE_AHEAD_KEEP_PRUNE_BLOCKS").and_then(|v| v.trim().parse::<u64>().ok()).map(|v| if v == 0 { 0 } else { v.clamp(100, 10_000_000) }).unwrap_or(PRUNE_BLOCKS_DEFAULT),
            on,
            max_contracts: num("FASTLANE_AHEAD_KEEP_CONTRACTS", d.max_contracts as u64, 1, 1000) as usize,
            max_slots_per,
            max_slots_total: num("FASTLANE_AHEAD_KEEP_MAX_SLOTS", d.max_slots_total as u64, 1, 2_000_000) as usize,
            adopt_writes: super::ahead::on_off(get("FASTLANE_AHEAD_KEEP_ADOPT").as_deref()).unwrap_or(d.adopt_writes),
            versions: d.versions,
            seeds_per_hour: d.seeds_per_hour,
            audit_s: num("FASTLANE_AHEAD_KEEP_AUDIT_S", d.audit_s, 0, 86_400),
            max_behind: num("FASTLANE_AHEAD_KEEP_MAX_BEHIND", d.max_behind, 2, 10_000),
            seed_batch: d.seed_batch,
            max_candidates: d.max_candidates,
        }
    }
}

// ---------------------------------------------------------------------------
// One version of the kept values (what the predicted copy reads)
// ---------------------------------------------------------------------------

/// The kept values, exact after block `block` (persistent maps: cheap to copy).
#[derive(Clone, Debug, Default)]
pub struct KeptVersion {
    pub block: u64,
    pub accounts: PMap<Address, Acct>,
    pub codes: PMap<B256, Bytecode>,
}

impl KeptVersion {
    /// Do we hold this value exactly?
    pub fn holds_slot(&self, a: &Address, s: &U256) -> bool {
        self.accounts.get(a).is_some_and(|x| x.storage_complete || x.storage.contains_key(s))
    }
    /// Do we hold this account's basics (balance, nonce, code hash) exactly?
    pub fn holds_basics(&self, a: &Address) -> bool {
        self.accounts.get(a).is_some_and(|x| matches!(x.basics, Basics::Known(_)))
    }
    /// Values held in all.
    pub fn slots(&self) -> usize {
        self.accounts.values().map(|a| a.storage.len()).sum()
    }
}

/// Copy 2's "which values are exact" plus the keeper's: a value the keeper
/// holds is exact at its block (the predicted copy only merges a keeper
/// version of EXACTLY its base block).
pub struct KeptProv {
    pub inner: Arc<dyn Provenance + Send + Sync>,
    pub kept: Arc<KeptVersion>,
}

impl Provenance for KeptProv {
    fn slot_exact(&self, a: Address, slot: U256) -> bool {
        self.inner.slot_exact(a, slot) || self.kept.holds_slot(&a, &slot)
    }
    fn balance_exact(&self, a: Address) -> bool {
        self.inner.balance_exact(a) || self.kept.holds_basics(&a)
    }
}

/// What a merge added (status / replay report).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MergeCounts {
    pub accounts: usize,
    pub slots: usize,
    pub basics: usize,
    pub codes: usize,
    /// Copy-2 accounts held as "every slot known" but with approximate
    /// basics, replaced whole by the keeper's exact account.
    pub replaced: usize,
    /// Values copy 2 called exact that the keeper's (exact) value replaced.
    pub overrode: usize,
}

/// Copy 2's snapshot of block N with the keeper's values of block N laid
/// over it. Where the keeper holds a value it is used (ahead3, Oct 31: the
/// keeper's values are the node's own of exactly block N, audited; copy 2's
/// "exact" values could lag a late report, and copy 2 counts outside
/// contracts' ETH balances as exact while it never replays their other
/// transactions). Everything else stays copy 2's.
/// Never-trusted ("volatile") accounts are left alone (always Missing).
pub fn merge_base(base: &Snapshot, prov: &dyn Provenance, kv: &KeptVersion) -> (Snapshot, MergeCounts) {
    let mut out = base.clone();
    let mut n = MergeCounts::default();
    for (a, k) in kv.accounts.iter() {
        if base.volatile.is_whole(a) {
            continue;
        }
        match base.accounts.get(a) {
            None => {
                n.accounts += 1;
                n.slots += k.storage.len();
                n.basics += usize::from(matches!(k.basics, Basics::Known(_)));
                out.accounts.insert(*a, k.clone());
            }
            // Copy 2 knows every slot of it (created in front of us / does
            // not exist): nothing to add, UNLESS copy 2's basics are only
            // approximate and the keeper's are exact (ahead3, Oct 31): copy 2
            // still held new launch tokens as "does not exist" (an old
            // look), while the keeper's exact values say they exist. Then
            // the keeper's account replaces copy 2's whole (a value the
            // keeper doesn't hold reads as missing, never as zero).
            Some(c) if c.storage_complete => {
                let kb = matches!(k.basics, Basics::Known(_));
                let c_exact = matches!(c.basics, Basics::Known(_)) && c.balance_exact && prov.balance_exact(*a) && c.basics == k.basics;
                if kb && !c_exact {
                    n.accounts += 1;
                    n.slots += k.storage.len();
                    n.basics += 1;
                    n.replaced += 1;
                    out.accounts.insert(*a, k.clone());
                }
            }
            Some(c) => {
                let mut m = c.clone();
                let mut added = 0;
                for (s, v) in k.storage.iter() {
                    // KEEPER WINS (ahead3, Oct 31): the keeper's value is the
                    // node's own, of exactly this block (audited: 0 wrong in
                    // millions of checks). Copy 2's "exact" can lag (a late
                    // report, a value it re-derives): when the two differ,
                    // the keeper's is used.
                    if c.storage.get(s) == Some(v) {
                        continue;
                    }
                    if c.storage.contains_key(s) && prov.slot_exact(*a, *s) {
                        n.overrode += 1;
                    }
                    m.storage.insert(*s, *v);
                    added += 1;
                }
                let kb = matches!(k.basics, Basics::Known(_));
                // Copy 2 counts a contract's ETH balance as exact, but it
                // never replays the transactions of pools it doesn't follow
                // (the V4 PoolManager's ETH moves with every native swap):
                // the keeper's basics win whenever it holds them.
                let c_exact = matches!(c.basics, Basics::Known(_)) && c.balance_exact && prov.balance_exact(*a) && c.basics == k.basics;
                if kb && !c_exact {
                    m.basics = k.basics.clone();
                    m.balance_exact = true;
                    n.basics += 1;
                }
                if added > 0 || (kb && !c_exact) {
                    n.accounts += 1;
                    n.slots += added;
                    out.accounts.insert(*a, m);
                }
            }
        }
    }
    for (h, c) in kv.codes.iter() {
        if !out.codes.contains_key(h) {
            out.put_code(*h, c.clone());
            n.codes += 1;
        }
    }
    (out, n)
}

// ---------------------------------------------------------------------------
// The core (no I/O)
// ---------------------------------------------------------------------------

/// A set of storage slots kept as a sorted list (memory fix, Nov 1): the
/// same answers as a HashSet, at about half the memory (a hash set of 256
/// values reserves room for 512; measured: 4,096 candidates x 256 values =
/// 66 MB as hash sets, see tests/ahead_memory.rs).
#[derive(Clone, Debug, Default)]
struct SlotSet(Vec<U256>);

impl SlotSet {
    fn len(&self) -> usize {
        self.0.len()
    }
    /// true = it was not there yet.
    fn insert(&mut self, s: U256) -> bool {
        match self.0.binary_search(&s) {
            Ok(_) => false,
            Err(i) => {
                self.0.insert(i, s);
                true
            }
        }
    }
    fn iter(&self) -> std::slice::Iter<'_, U256> {
        self.0.iter()
    }
    /// Is this value in the set? (sorted list: binary search)
    fn contains(&self, s: &U256) -> bool {
        self.0.binary_search(s).is_ok()
    }
}

/// A learned contract (kept or not yet).
#[derive(Clone, Debug, Default)]
struct Cand {
    score: f64,
    /// Values its runs needed (bounded by max_slots_per).
    slots: SlotSet,
    /// Its basics (balance / nonce / code) were needed.
    basics: bool,
}

/// One seed call to make: these values of one contract, at the keeper's block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeedJob {
    pub addr: Address,
    pub slots: Vec<U256>,
    /// Ask for its basics (and its code when we don't have it).
    pub basics: bool,
}

/// What a seed call brought back (exact at block `at`).
#[derive(Clone, Debug)]
pub struct SeedAnswer {
    pub addr: Address,
    pub at: u64,
    /// Some(None) = the account does not exist; None = basics not asked.
    pub basics: Option<Option<AccountInfo>>,
    /// Its code (only when asked and not held).
    pub code: Option<Bytecode>,
    pub slots: Vec<(U256, U256)>,
}

/// Counters (since start; the runtime also keeps an hour).
#[derive(Clone, Debug, Default)]
pub struct KeeperStats {
    pub blocks: u64,
    pub held_touched: u64,
    pub values_updated: u64,
    pub learned: u64,
    pub seeds_sent: u64,
    pub seed_values: u64,
    pub seeds_dropped: u64,
    pub evicted: u64,
    /// Held accounts a block CREATED (a contract deployed at an address we
    /// held as empty): dropped and seeded again, with their code.
    pub recreated: u64,
    /// Values adopted because a block wrote them (FASTLANE_AHEAD_KEEP_ADOPT).
    pub adopted: u64,
    pub refused_full: u64,
    /// Candidates forgotten because the list was full (weakest first).
    pub cands_dropped: u64,
    /// Memory guard: learned batches ignored / seeds held back while paused.
    pub mem_learn_skipped: u64,
    /// PRUNE (FASTLANE_AHEAD_KEEP_PRUNE_BLOCKS): rounds run, values and
    /// codes dropped in all, values dropped by the last round.
    pub prunes: u64,
    pub pruned_values: u64,
    pub pruned_codes: u64,
    pub prune_last_values: u64,
    pub audits: u64,
    pub audit_values: u64,
    pub audit_mismatch: u64,
    pub resets: HashMap<&'static str, u64>,
    pub apply_us: Vec<u64>,
    pub samples: Vec<Value>,
}

impl KeeperStats {
    /// A ring of the newest 20,000 apply times.
    fn add_time(&mut self, us: u64) {
        if self.apply_us.len() < 20_000 {
            self.apply_us.push(us);
        } else {
            let i = (self.blocks % 20_000) as usize;
            self.apply_us[i] = us;
        }
    }
    pub fn json(&self) -> Value {
        let mut t = self.apply_us.clone();
        json!({
            "blocks": self.blocks, "heldTouched": self.held_touched, "valuesUpdated": self.values_updated,
            "learned": self.learned, "seedsSent": self.seeds_sent, "seedValues": self.seed_values, "seedsDropped": self.seeds_dropped,
            "evicted": self.evicted, "recreated": self.recreated, "adopted": self.adopted, "refusedFull": self.refused_full, "candsDropped": self.cands_dropped,
            "memLearnSkipped": self.mem_learn_skipped,
            "prunes": self.prunes, "prunedValues": self.pruned_values, "prunedCodes": self.pruned_codes, "pruneLastValues": self.prune_last_values, "audits": self.audits, "auditValues": self.audit_values, "auditMismatch": self.audit_mismatch,
            "resets": self.resets.iter().map(|(k, v)| (k.to_string(), json!(v))).collect::<serde_json::Map<String, Value>>(),
            "applyUs": crate::timing::pct_of(&mut t),
            "samples": self.samples,
        })
    }
}

/// The keeper's state machine (see the file header). Single-threaded.
pub struct KeeperCore {
    pub cfg: KeeperCfg,
    /// Block whose post-state `cur` holds (None = not started).
    head: Option<u64>,
    cur: KeptVersion,
    versions: VecDeque<Arc<KeptVersion>>,
    /// Recent blocks' changes (all accounts), for seeds that come back
    /// after the keeper moved on.
    recent: VecDeque<(u64, Arc<StateDiff>)>,
    cands: HashMap<Address, Cand>,
    /// Contracts chosen to be kept (may still be waiting for their seed).
    held: HashSet<Address>,
    seeds: VecDeque<SeedJob>,
    /// Values asked for and not answered yet (never asked twice at once).
    pending: HashSet<(Address, Option<U256>)>,
    audit_next: usize,
    pub stats: KeeperStats,
    /// Memory guard (memguard.rs, ARBSIM_AHEAD_MEM_PAUSE_MB): while set the
    /// keeper does not grow: no seeds sent, nothing learned or adopted. It
    /// still applies every block to the values it holds (they stay exact,
    /// so nothing must be seeded again afterwards). Set by the runtime.
    pub mem_pause: bool,
    /// PRUNE (FASTLANE_AHEAD_KEEP_PRUNE_BLOCKS): values of kept contracts
    /// a block wrote in this window / the one before (only kept accounts'
    /// values, so bounded by what is held), and the block the window began.
    /// Kept as 8-byte fingerprints (`written_key`), not the 52-byte
    /// (contract, slot): a fingerprint shared by chance only keeps a value
    /// one more round (never drops one that was written).
    written_now: HashSet<u64>,
    written_prev: HashSet<u64>,
    prune_from: Option<u64>,
}


impl KeeperCore {
    pub fn new(cfg: KeeperCfg) -> Self {
        KeeperCore {
            cfg,
            head: None,
            cur: KeptVersion::default(),
            versions: VecDeque::new(),
            recent: VecDeque::new(),
            cands: HashMap::new(),
            held: HashSet::new(),
            seeds: VecDeque::new(),
            pending: HashSet::new(),
            audit_next: 0,
            stats: KeeperStats::default(),
            mem_pause: false,
            written_now: HashSet::new(),
            written_prev: HashSet::new(),
            prune_from: None,
        }
    }

    pub fn head(&self) -> Option<u64> {
        self.head
    }

    /// The newest version (None before the start).
    pub fn latest(&self) -> Option<Arc<KeptVersion>> {
        self.versions.back().cloned()
    }

    /// The version of exactly `block` (None = not held).
    pub fn version_at(&self, block: u64) -> Option<Arc<KeptVersion>> {
        self.versions.iter().rev().find(|v| v.block == block).cloned()
    }

    /// Contracts kept / values held right now.
    pub fn held_counts(&self) -> (usize, usize, usize) {
        (self.held.len(), self.cur.accounts.len(), self.cur.slots())
    }

    /// Seed calls waiting.
    pub fn seeds_waiting(&self) -> usize {
        self.seeds.len()
    }

    fn publish(&mut self, replace_same_block: bool) {
        let v = Arc::new(self.cur.clone());
        if replace_same_block && self.versions.back().is_some_and(|x| x.block == v.block) {
            self.versions.pop_back();
        }
        self.versions.push_back(v);
        while self.versions.len() > self.cfg.versions {
            self.versions.pop_front();
        }
    }

    /// Start (or start again) at `block`: nothing held yet; every kept
    /// contract's values are asked for again (at this block).
    pub fn start_at(&mut self, block: u64) {
        self.head = Some(block);
        self.cur = KeptVersion { block, accounts: PMap::default(), codes: std::mem::take(&mut self.cur.codes) };
        self.versions.clear();
        self.recent.clear();
        self.seeds.clear();
        self.pending.clear();
        let held: Vec<Address> = self.held.iter().copied().collect();
        for a in held {
            self.queue_all(a);
        }
        self.publish(false);
    }

    /// Drop everything held (fail closed) and start again at `block`.
    pub fn reset(&mut self, block: u64, why: &'static str) {
        *self.stats.resets.entry(why).or_default() += 1;
        self.start_at(block);
    }

    /// Queue a seed of every value a kept contract needs.
    fn queue_all(&mut self, a: Address) {
        let Some(c) = self.cands.get(&a) else { return };
        let mut slots: Vec<U256> = c.slots.iter().copied().collect();
        slots.sort();
        let basics = c.basics;
        self.queue(a, slots, basics);
    }

    /// Queue seeds for values not held and not already asked for.
    fn queue(&mut self, a: Address, slots: Vec<U256>, basics: bool) {
        let held = self.cur.accounts.get(&a);
        let need_basics = basics && !held.is_some_and(|x| matches!(x.basics, Basics::Known(_))) && !self.pending.contains(&(a, None));
        let mut need: Vec<U256> = slots
            .into_iter()
            .filter(|s| !held.is_some_and(|x| x.storage_complete || x.storage.contains_key(s)) && !self.pending.contains(&(a, Some(*s))))
            .collect();
        need.sort();
        need.dedup();
        // Bounded in all: what is held + what is asked for.
        let room = self.cfg.max_slots_total.saturating_sub(self.cur.slots() + self.pending.len());
        if need.len() > room {
            self.stats.refused_full += (need.len() - room) as u64;
            need.truncate(room);
        }
        if need.is_empty() && !need_basics {
            return;
        }
        if need_basics {
            self.pending.insert((a, None));
        }
        for s in &need {
            self.pending.insert((a, Some(*s)));
        }
        // One job per seed_batch values (the first one also asks for basics).
        let mut first = true;
        let mut chunks: Vec<Vec<U256>> = need.chunks(self.cfg.seed_batch.max(1)).map(|c| c.to_vec()).collect();
        if chunks.is_empty() {
            chunks.push(Vec::new());
        }
        for c in chunks {
            self.seeds.push_back(SeedJob { addr: a, slots: c, basics: first && need_basics });
            first = false;
        }
    }

    /// LEARN: values the predicted copy's runs lacked (or read only
    /// approximately). Each contract named scores one point per call.
    pub fn learn(&mut self, items: &[MissItem]) {
        let mut by: HashMap<Address, (Vec<U256>, bool)> = HashMap::new();
        for it in items {
            match it {
                MissItem::Slot(a, s) => by.entry(*a).or_default().0.push(*s),
                MissItem::Account(a) => by.entry(*a).or_default().1 = true,
                MissItem::Code(_) => {}
            }
        }
        if by.is_empty() {
            return;
        }
        if self.mem_pause {
            self.stats.mem_learn_skipped += 1;
            return;
        }
        self.stats.learned += items.len() as u64;
        let total_held: usize = self.cur.slots();
        let mut grew: Vec<Address> = Vec::new();
        for (a, (slots, basics)) in by {
            // A kept contract may hold FASTLANE_AHEAD_KEEP_SLOTS values; a
            // mere candidate remembers at most FASTLANE_AHEAD_KEEP_CAND_SLOTS
            // (bounded memory: 4,096 candidates x 2,000 values was possible).
            let per = if self.held.contains(&a) { self.cfg.max_slots_per } else { self.cfg.cand_slots.min(self.cfg.max_slots_per) };
            let c = self.cands.entry(a).or_default();
            c.score += 1.0;
            c.basics |= basics;
            for s in slots {
                if c.slots.len() >= per {
                    self.stats.refused_full += 1;
                    break;
                }
                c.slots.insert(s);
            }
            // Every kept contract named gets its missing values asked for
            // (a seed that failed or came back too late is asked again).
            grew.push(a);
        }
        // Bounded: forget the weakest candidates that are not kept. Live
        // fix (Oct 31 night): never the ones named in THIS batch. Before, a
        // full list (4,096) dropped every newcomer at once (score 1 = the
        // lowest), so a new hot contract could never build up a score
        // until the hourly halving.
        if self.cands.len() > self.cfg.max_candidates {
            let fresh: HashSet<Address> = grew.iter().copied().collect();
            let mut v: Vec<(f64, Address)> = self.cands.iter().filter(|(a, _)| !self.held.contains(*a) && !fresh.contains(*a)).map(|(a, c)| (c.score, *a)).collect();
            let extra = (self.cands.len() - self.cfg.max_candidates).min(v.len());
            if extra > 0 && extra < v.len() {
                // Only the `extra` weakest are needed: a partial sort.
                v.select_nth_unstable_by(extra - 1, |x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal).then(x.1.cmp(&y.1)));
            }
            for (_, a) in v.into_iter().take(extra) {
                self.cands.remove(&a);
                self.stats.cands_dropped += 1;
            }
        }
        self.choose();
        // Values of kept contracts not held yet: seed them (bounded in all).
        for a in grew {
            if self.held.contains(&a) {
                if total_held >= self.cfg.max_slots_total {
                    self.stats.refused_full += 1;
                    continue;
                }
                self.queue_all(a);
            }
        }
    }

    /// Pick the kept contracts: the top scores, with a 2x margin for a
    /// newcomer over the coldest kept one (no churn).
    fn choose(&mut self) {
        let mut order: Vec<(f64, Address)> = self.cands.iter().map(|(a, c)| (if self.held.contains(a) { c.score * 2.0 } else { c.score }, *a)).collect();
        order.sort_by(|x, y| y.0.partial_cmp(&x.0).unwrap_or(std::cmp::Ordering::Equal).then(x.1.cmp(&y.1)));
        let want: HashSet<Address> = order.iter().take(self.cfg.max_contracts).map(|x| x.1).collect();
        let drop: Vec<Address> = self.held.iter().filter(|a| !want.contains(*a)).copied().collect();
        for a in drop {
            self.evict(a);
        }
        let add: Vec<Address> = want.into_iter().filter(|a| !self.held.contains(a)).collect();
        for a in add {
            self.held.insert(a);
            if self.head.is_some() {
                self.queue_all(a);
            }
        }
    }

    fn evict(&mut self, a: Address) {
        self.held.remove(&a);
        // (PRUNE bookkeeping: its write fingerprints simply age out within
        // two rounds; nothing to do here.)
        if self.cur.accounts.remove(&a).is_some() {
            self.stats.evicted += 1;
        }
        self.pending.retain(|(x, _)| *x != a);
        self.seeds.retain(|j| j.addr != a);
    }

    /// Scores halve (once an hour): contracts that stopped coming up lose
    /// their place to new ones. Dead candidates are forgotten.
    pub fn decay(&mut self) {
        for c in self.cands.values_mut() {
            c.score *= 0.5;
        }
        let held = &self.held;
        self.cands.retain(|a, c| c.score >= 0.1 || held.contains(a));
        self.choose();
    }

    /// The next seed to send (the caller enforces the hourly limit).
    pub fn take_job(&mut self) -> Option<SeedJob> {
        if self.mem_pause {
            // Memory guard: the queue waits (nothing dropped).
            return None;
        }
        while let Some(j) = self.seeds.pop_front() {
            if self.held.contains(&j.addr) {
                self.stats.seeds_sent += 1;
                return Some(j);
            }
        }
        None
    }

    /// A seed came back (or failed: `ans` None): the values become held,
    /// carried forward through the blocks applied since `at`.
    pub fn on_seed(&mut self, job: &SeedJob, ans: Option<SeedAnswer>) {
        // Not pending any more, whatever happened (a failure may be asked again later).
        self.pending.remove(&(job.addr, None));
        for s in &job.slots {
            self.pending.remove(&(job.addr, Some(*s)));
        }
        let Some(ans) = ans else {
            self.stats.seeds_dropped += 1;
            return;
        };
        let Some(head) = self.head else { return };
        if !self.held.contains(&ans.addr) || ans.at > head {
            self.stats.seeds_dropped += 1;
            return;
        }
        // The blocks since `at` must all still be here to carry it forward.
        let need: Vec<&(u64, Arc<StateDiff>)> = self.recent.iter().filter(|(b, _)| *b > ans.at && *b <= head).collect();
        if need.len() as u64 != head - ans.at {
            self.stats.seeds_dropped += 1;
            return;
        }
        // The seeded values as an account at `at` (basics only if asked).
        let mut acct = Acct::default();
        if let Some(b) = &ans.basics {
            acct.basics = Basics::Known(normalize(b.clone()));
            if b.is_none() {
                acct.storage_complete = true;
            }
        }
        for (s, v) in &ans.slots {
            acct.storage.insert(*s, *v);
        }
        let keys: HashSet<U256> = ans.slots.iter().map(|x| x.0).collect();
        for (_, d) in need {
            if let Some(ad) = d.accounts.get(&ans.addr) {
                acct = apply_held(ans.addr, &acct, ad, &keys);
            }
        }
        if let (Some(Some(i)), Some(c)) = (&ans.basics, &ans.code) {
            if i.code_hash != KECCAK_EMPTY && !i.code_hash.is_zero() && !self.cur.codes.contains_key(&i.code_hash) {
                self.cur.codes.insert(i.code_hash, c.clone());
            }
        }
        // Into what we hold now (held values are already current; the seed
        // only adds what was missing).
        let mut held = self.cur.accounts.get(&ans.addr).cloned().unwrap_or_default();
        if ans.basics.is_some() && !matches!(held.basics, Basics::Known(_)) {
            held.basics = acct.basics.clone();
            held.balance_exact = true;
            held.storage_complete |= acct.storage_complete;
        }
        let mut added = 0u64;
        for (s, v) in acct.storage.iter() {
            if !held.storage.contains_key(s) {
                held.storage.insert(*s, *v);
                added += 1;
            }
        }
        self.stats.seed_values += added;
        self.cur.accounts.insert(ans.addr, held);
        self.publish(true);
    }

    /// Codes the keeper holds (a seed asks for a contract's code only when
    /// neither copy 2 nor the keeper has it).
    pub fn has_code(&self, h: &B256) -> bool {
        self.cur.codes.contains_key(h)
    }

    /// KEEP EXACT: block `block`'s changes (the node's per-transaction
    /// diffs, in order). Only values we hold are updated. Err = not the
    /// next block (the caller starts again: never a gap).
    pub fn apply_block(&mut self, block: u64, txs: &[StateDiff]) -> Result<(), &'static str> {
        let t0 = Instant::now();
        let Some(head) = self.head else { return Err("not_started") };
        if block <= head {
            return Ok(()); // already applied
        }
        if block != head + 1 {
            return Err("gap");
        }
        let mut merged = StateDiff::default();
        for d in txs {
            crate::state::diff::merge(&mut merged, d);
        }
        let mut touched = 0u64;
        let mut updated = 0u64;
        let mut recreate: Vec<Address> = Vec::new();
        // ADOPT (FASTLANE_AHEAD_KEEP_ADOPT): room left for written values.
        // (Memory guard: nothing adopted while paused.)
        let adopt = self.cfg.adopt_writes && !self.mem_pause;
        let mut total = if adopt { self.cur.slots() } else { 0 };
        let adopt_per = self.cfg.max_slots_per.saturating_mul(10);
        for (a, ad) in &merged.accounts {
            let Some(cur) = self.cur.accounts.get(a) else { continue };
            // A contract CREATED at an address we hold (ahead3 fix): the
            // block diffs come without code, so its new code is unknown
            // here. Never hold it code-less: drop it, seed it again (with
            // its code).
            if ad.storage_cleared && matches!(&ad.info, Some(Some(i)) if i.code_hash.is_zero() || i.code_hash != KECCAK_EMPTY && ad.code.is_none() && !self.cur.codes.contains_key(&i.code_hash)) {
                recreate.push(*a);
                continue;
            }
            // Live speed (Oct 31 night): only the written values we hold (or
            // adopt) are applied. Before, every block copied the keys of
            // EVERY value held for each touched contract (the V4 PoolManager:
            // up to 20,000) and then dropped the unheld writes again: keeper
            // apply p90 14 ms, max 316 ms live. Same result, see the test
            // `filtered_apply_matches_the_old_one`.
            let next = if ad.storage_cleared || cur.storage_complete || matches!(ad.info, Some(None)) || ad.forget {
                // Created / destroyed / removed / every value known: the old
                // path (rare; the account may become "every value known").
                let mut keys: HashSet<U256> = cur.storage.keys().copied().collect();
                if adopt && !cur.storage_complete {
                    for s in ad.storage.keys() {
                        if keys.len() >= adopt_per || total >= self.cfg.max_slots_total {
                            break;
                        }
                        if keys.insert(*s) {
                            total += 1;
                            self.stats.adopted += 1;
                        }
                    }
                }
                updated += ad.storage.keys().filter(|s| keys.contains(s)).count() as u64;
                apply_held(*a, cur, ad, &keys)
            } else {
                let mut held_n = cur.storage.len();
                let mut f = AccountDiff { info: ad.info.clone(), code: ad.code.clone(), storage: HashMap::new(), storage_cleared: false, balance_inexact: ad.balance_inexact, forget: ad.forget };
                for (s, v) in &ad.storage {
                    if cur.storage.contains_key(s) {
                        f.storage.insert(*s, *v);
                    } else if adopt && held_n < adopt_per && total < self.cfg.max_slots_total {
                        f.storage.insert(*s, *v);
                        held_n += 1;
                        total += 1;
                        self.stats.adopted += 1;
                    }
                }
                updated += f.storage.len() as u64;
                apply_filtered(*a, cur, &f)
            };
            touched += 1;
            // PRUNE: remember which held values this block wrote (they are
            // in use; only those survive a prune besides learned ones).
            if self.cfg.prune_blocks > 0 {
                for s in ad.storage.keys() {
                    if next.storage.contains_key(s) {
                        self.written_now.insert(written_key(a, s));
                    }
                }
            }
            self.cur.accounts.insert(*a, next);
        }
        for a in recreate {
            self.cur.accounts.remove(&a);
            self.pending.retain(|(x, _)| *x != a);
            self.seeds.retain(|j| j.addr != a);
            self.stats.recreated += 1;
            // Everything it needed, and always its basics + code.
            let slots: Vec<U256> = self.cands.get(&a).map(|c| c.slots.iter().copied().collect()).unwrap_or_default();
            self.queue(a, slots, true);
        }
        self.recent.push_back((block, Arc::new(merged)));
        while self.recent.len() > self.cfg.versions {
            self.recent.pop_front();
        }
        self.head = Some(block);
        self.cur.block = block;
        // PRUNE: once per window, before this block's version goes out.
        if self.cfg.prune_blocks > 0 {
            match self.prune_from {
                None => self.prune_from = Some(block),
                Some(f) if block.saturating_sub(f) >= self.cfg.prune_blocks => {
                    self.prune();
                    self.prune_from = Some(block);
                }
                Some(_) => {}
            }
        }
        self.publish(false);
        self.stats.blocks += 1;
        self.stats.held_touched += touched;
        self.stats.values_updated += updated;
        self.stats.add_time(t0.elapsed().as_micros() as u64);
        Ok(())
    }

    /// PRUNE (FASTLANE_AHEAD_KEEP_PRUNE_BLOCKS, memory fix Nov 1): drop the
    /// held values nobody needs any more. A value stays when
    ///   - a predicted run asked for it (it is in the contract's learned
    ///     list), or
    ///   - a block wrote it in this window or the one before.
    /// Accounts held as "every value known" (created / empty) are left
    /// whole: removing one of their values would make it read as ZERO, not
    /// as unknown. Codes no held account uses any more are dropped too.
    /// Only `cur` changes; versions already published keep what they had
    /// (they are exact for their block and age out on their own).
    /// Returns the number of values dropped.
    pub fn prune(&mut self) -> usize {
        let mut dropped = 0usize;
        let addrs: Vec<Address> = self.cur.accounts.keys().copied().collect();
        for a in addrs {
            let Some(acct) = self.cur.accounts.get(&a) else { continue };
            if acct.storage_complete || acct.storage.is_empty() {
                continue;
            }
            let need = self.cands.get(&a).map(|c| &c.slots);
            let gone: Vec<U256> = acct
                .storage
                .keys()
                .filter(|s| !need.is_some_and(|n| n.contains(s)) && !self.written_now.contains(&written_key(&a, s)) && !self.written_prev.contains(&written_key(&a, s)))
                .copied()
                .collect();
            if gone.is_empty() {
                continue;
            }
            let mut m = acct.clone();
            for s in &gone {
                m.storage.remove(s);
            }
            dropped += gone.len();
            self.cur.accounts.insert(a, m);
        }
        // Codes: keep the ones a held account's basics name.
        let used: HashSet<B256> = self
            .cur
            .accounts
            .values()
            .filter_map(|x| match &x.basics {
                Basics::Known(Some(i)) => Some(i.code_hash),
                _ => None,
            })
            .collect();
        let old_codes: Vec<B256> = self.cur.codes.keys().filter(|h| !used.contains(*h)).copied().collect();
        for h in &old_codes {
            self.cur.codes.remove(h);
        }
        // The window moves on: this window's writes become "the one before".
        self.written_prev = std::mem::take(&mut self.written_now);
        self.stats.prunes += 1;
        self.stats.pruned_values += dropped as u64;
        self.stats.pruned_codes += old_codes.len() as u64;
        self.stats.prune_last_values = dropped as u64;
        dropped
    }

    /// AUDIT, part 1: the next kept contract to re-read (round robin) and
    /// up to `max` of its values.
    pub fn audit_pick(&mut self, max: usize) -> Option<(Address, Vec<U256>)> {
        let mut addrs: Vec<Address> = self.cur.accounts.keys().copied().collect();
        if addrs.is_empty() {
            return None;
        }
        addrs.sort();
        let a = addrs[self.audit_next % addrs.len()];
        self.audit_next = self.audit_next.wrapping_add(1);
        let mut slots: Vec<U256> = self.cur.accounts.get(&a).map(|x| x.storage.keys().copied().collect()).unwrap_or_default();
        slots.sort();
        slots.truncate(max);
        Some((a, slots))
    }

    /// AUDIT, part 2: the node's values of `addr` at `at` (= our head)
    /// against ours. A mismatch drops everything (fail closed). Returns
    /// the number of values that differ.
    pub fn audit_check(&mut self, at: u64, addr: Address, basics: Option<Option<AccountInfo>>, slots: &[(U256, U256)]) -> usize {
        // The values we held at block `at`: the current ones, or (pipelined
        // keeper: it moved on while the audit read was out) that block's
        // kept version. Gone = not comparable.
        let held = if self.head == Some(at) {
            self.cur.accounts.get(&addr).cloned()
        } else {
            self.version_at(at).and_then(|v| v.accounts.get(&addr).cloned())
        };
        let Some(held) = held else { return 0 };
        self.stats.audits += 1;
        let mut bad: Vec<String> = Vec::new();
        for (s, v) in slots {
            if let Some(h) = held.storage.get(s) {
                self.stats.audit_values += 1;
                if h != v {
                    bad.push(format!("slot {s:#x}: ours {h:#x} node {v:#x}"));
                }
            }
        }
        if let (Some(nb), Basics::Known(hb)) = (basics, &held.basics) {
            self.stats.audit_values += 1;
            let nb = normalize(nb);
            let same = match (&nb, hb) {
                (None, None) => true,
                (Some(x), Some(y)) => x.balance == y.balance && x.nonce == y.nonce && (x.code_hash == y.code_hash || x.code_hash.is_zero() || y.code_hash.is_zero()),
                _ => false,
            };
            if !same {
                bad.push("basics differ".into());
            }
        }
        if !bad.is_empty() {
            self.stats.audit_mismatch += bad.len() as u64;
            if self.stats.samples.len() < 20 {
                self.stats.samples.push(json!({"block": at, "contract": format!("{addr:#x}"), "differ": bad.iter().take(4).collect::<Vec<_>>()}));
            }
            let h = self.head.unwrap_or(at).max(at);
            self.reset(h, "audit_mismatch");
        }
        bad.len()
    }

    /// The current version's account (tests / replay audit).
    pub fn account(&self, a: &Address) -> Option<&Acct> {
        self.cur.accounts.get(a)
    }

    /// Kept contract addresses (status).
    pub fn held_list(&self) -> Vec<Address> {
        let mut v: Vec<Address> = self.held.iter().copied().collect();
        v.sort();
        v
    }

    pub fn status_json(&self) -> Value {
        let (held, accts, slots) = self.held_counts();
        json!({
            "head": self.head, "contracts": held, "accounts": accts, "values": slots, "codes": self.cur.codes.len(),
            "candidates": self.cands.len(), "candidateValues": self.cands.values().map(|c| c.slots.len()).sum::<usize>(), "seedsWaiting": self.seeds.len(), "versions": self.versions.len(),
            "recentDiffs": self.recent.len(), "memPaused": self.mem_pause,
            "prune": {"everyBlocks": self.cfg.prune_blocks, "writtenTracked": self.written_now.len() + self.written_prev.len(), "nextAt": self.prune_from.map(|f| f + self.cfg.prune_blocks)},
            "stats": self.stats.json(),
        })
    }
}

/// PRUNE: the 8-byte fingerprint of one held value (contract, slot).
fn written_key(a: &Address, s: &U256) -> u64 {
    use std::hash::{BuildHasher, Hash, Hasher};
    let mut h = rustc_hash::FxBuildHasher.build_hasher();
    a.hash(&mut h);
    s.hash(&mut h);
    h.finish()
}

/// Apply one account's block change to a held account, keeping only the
/// values held before (`keys`): a value the change touches that we never
/// held stays unknown. Basics follow the node (the code hash is kept when
/// the trace leaves code out). An account the block created or destroyed
/// becomes "complete" (every other value zero), as the node says.
fn apply_held(a: Address, cur: &Acct, ad: &AccountDiff, keys: &HashSet<U256>) -> Acct {
    let mut tmp = Snapshot::default();
    tmp.accounts.insert(a, cur.clone());
    tmp.apply_account_diff(a, ad);
    let mut out = tmp.accounts.get(&a).cloned().unwrap_or_default();
    if !out.storage_complete {
        let drop: Vec<U256> = out.storage.keys().filter(|s| !keys.contains(s)).copied().collect();
        for s in drop {
            out.storage.remove(&s);
        }
    }
    out
}

/// `apply_held` for a change already narrowed to the values we hold (or
/// adopt), on an account that is not "every value known": nothing to drop.
fn apply_filtered(a: Address, cur: &Acct, ad: &AccountDiff) -> Acct {
    let mut tmp = Snapshot::default();
    tmp.accounts.insert(a, cur.clone());
    tmp.apply_account_diff(a, ad);
    tmp.accounts.get(&a).cloned().unwrap_or_default()
}

/// What the predicted copy should learn from one run: the values it lacked
/// (`missing`) and the ones it read that copy 2 only holds approximately
/// (`reads` against `exact`). Leaves out what copy 2 follows itself
/// (`skip`: our pools), the transaction's sender, never-trusted accounts and
/// Nitro's built-in addresses (below 0x1000, and ArbOS's own account).
pub fn wanted_items(
    missing: &[MissItem],
    reads: Option<(&HashSet<Address>, &HashSet<(Address, U256)>)>,
    view: &dyn crate::state::StateRead,
    prov: &dyn Provenance,
    sender: Address,
    skip: &dyn Fn(&Address) -> bool,
) -> Vec<MissItem> {
    let builtin = |a: &Address| {
        let w = U256::from_be_slice(a.as_slice());
        // Ethereum's (0x01..) and Nitro's (ArbSys 0x64 .. ArbDebug 0xff,
        // P256 0x100) built-ins all sit below 0x1000.
        w < U256::from(0x1000u64) || *a == arbos_state()
    };
    let ok = |a: &Address| *a != sender && !builtin(a) && !skip(a) && !view.volatile().is_some_and(|v| v.is_whole(a));
    let mut out: Vec<MissItem> = Vec::new();
    let mut seen: HashSet<MissItem> = HashSet::new();
    let mut push = |m: MissItem| {
        if seen.insert(m.clone()) {
            out.push(m);
        }
    };
    for m in missing {
        match m {
            MissItem::Slot(a, _) | MissItem::Account(a) if ok(a) => push(m.clone()),
            _ => {}
        }
    }
    if let Some((accts, slots)) = reads {
        for a in accts {
            // Missing, or held only approximately (ahead3, Oct 31): copy 2
            // doesn't follow the balance / nonce of outside accounts (a
            // launch factory's nonce decides the address its next token
            // gets; a token copy 2 last saw before it existed reads as
            // "none"). The keeper's exact basics fix both.
            let approx = !prov.balance_exact(*a);
            if ok(a) && (matches!(view.account(*a), crate::state::Lookup::Missing) || approx) {
                push(MissItem::Account(*a));
            }
        }
        for (a, s) in slots {
            if ok(a) && (matches!(view.storage(*a, *s), crate::state::Lookup::Missing) || !prov.slot_exact(*a, *s)) {
                push(MissItem::Slot(*a, *s));
            }
        }
    }
    out
}

/// ArbOS's own state account (0xA4B05FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF),
/// written by every transaction (gas pricing).
pub(crate) fn arbos_state() -> Address {
    let mut b = [0xffu8; 20];
    b[0] = 0xa4;
    b[1] = 0xb0;
    b[2] = 0x5f;
    Address::from(b)
}

// ---------------------------------------------------------------------------
// Node answers (live keeper)
// ---------------------------------------------------------------------------

/// Parse an eth_getProof answer into (basics, slots).
pub fn parse_proof(v: &Value) -> Result<(Option<AccountInfo>, Vec<(U256, U256)>), String> {
    use crate::check::hexutil::{parse_u256, parse_u64};
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).ok_or_else(|| format!("proof field {k} missing"));
    let balance = parse_u256(s("balance")?)?;
    let nonce = parse_u64(s("nonce")?)?;
    let ch = parse_u256(s("codeHash")?)?;
    let code_hash = if ch.is_zero() { KECCAK_EMPTY } else { B256::from(ch.to_be_bytes::<32>()) };
    let info = normalize(Some(AccountInfo { balance, nonce, code_hash, ..Default::default() }));
    let mut slots = Vec::new();
    for e in v.get("storageProof").and_then(|x| x.as_array()).ok_or("storageProof missing")? {
        let k = parse_u256(e.get("key").and_then(|x| x.as_str()).ok_or("key missing")?)?;
        let val = parse_u256(e.get("value").and_then(|x| x.as_str()).ok_or("value missing")?)?;
        slots.push((k, val));
    }
    Ok((info, slots))
}

/// One block's changes from the node (prestate tracer, diff mode, no code).
/// Ok(None) = the node doesn't have the block yet.
fn fetch_block(node: &dyn crate::node::NodeApi, block: u64) -> Result<Option<Vec<StateDiff>>, String> {
    let params = json!([crate::node::tag(block), { "tracer": "prestateTracer", "tracerConfig": { "diffMode": true, "disableCode": true } }]);
    let r = node.call_batch_paid(crate::node::Class::Critical, &[("debug_traceBlockByNumber", params)]).map_err(|e| format!("{e:?}").chars().take(120).collect::<String>())?;
    match r.into_iter().next() {
        Some(Ok(Value::Null)) | None => Ok(None),
        Some(Ok(v)) => crate::state::diff::parse_block_trace(&v).map(|t| Some(t.into_iter().map(|d| d.diff).collect())),
        Some(Err(e)) if e.is_block_unavailable() => Ok(None),
        Some(Err(e)) => Err(format!("trace: {}", e.message.chars().take(120).collect::<String>())),
    }
}

/// One seed (or audit) read: eth_getProof of `addr`'s `slots` at `block`,
/// plus its code when asked. Ok((basics, code, slots)).
pub type ProofAnswer = (Option<AccountInfo>, Option<Bytecode>, Vec<(U256, U256)>);
fn fetch_proof(node: &dyn crate::node::NodeApi, addr: Address, slots: &[U256], block: u64, with_code: bool) -> Result<ProofAnswer, String> {
    use crate::check::hexutil::to_hex;
    let keys: Vec<String> = slots.iter().map(|s| format!("{s:#066x}")).collect();
    let mut calls: Vec<(&str, Value)> = vec![("eth_getProof", json!([to_hex(addr.as_slice()), keys, crate::node::tag(block)]))];
    if with_code {
        calls.push(("eth_getCode", json!([to_hex(addr.as_slice()), crate::node::tag(block)])));
    }
    let r = node.call_batch_paid(crate::node::Class::Critical, &calls).map_err(|e| format!("{e:?}").chars().take(120).collect::<String>())?;
    let mut it = r.into_iter();
    let p = match it.next() {
        Some(Ok(v)) if !v.is_null() => v,
        Some(Err(e)) => return Err(format!("proof: {}", e.message.chars().take(100).collect::<String>())),
        _ => return Err("proof: no answer".into()),
    };
    let (info, vals) = parse_proof(&p)?;
    let code = match (with_code, it.next()) {
        (true, Some(Ok(Value::String(s)))) => {
            let b = crate::check::hexutil::parse_bytes(&s)?;
            (!b.is_empty()).then(|| Bytecode::new_raw(b))
        }
        (true, _) => return Err("code: no answer".into()),
        (false, _) => None,
    };
    // The code must be the one the proof names (never a mismatched pair).
    if let (Some(i), Some(c)) = (&info, &code) {
        if revm::primitives::keccak256(c.original_byte_slice()) != i.code_hash {
            return Err("code does not match the proof's code hash".into());
        }
    }
    Ok((info, code, vals))
}

// ---------------------------------------------------------------------------
// Runtime: one thread in the running sidecar
// ---------------------------------------------------------------------------

/// What the keeper's runtime needs from the outside world: the node's
/// answers and how far copy 2 / the feed are. Live: `LiveIo` (the paid
/// node, copy 2's published head, the feed tip). Offline: the
/// `ahead-replay --live-timing` node model over recorded block diffs
/// (copy2/keeper_replay.rs `TruthIo`), so the SAME driver code is measured.
pub trait KeeperIo: Send + Sync {
    /// One block's changes. Ok(None) = the node does not have it yet.
    fn block(&self, b: u64) -> Result<Option<Vec<StateDiff>>, String>;
    /// eth_getProof of `slots` of `addr` at block `at` (+ its code if asked).
    fn proof(&self, addr: Address, slots: &[U256], at: u64, code: bool) -> Result<ProofAnswer, String>;
    /// Copy 2's newest published block (None = not started).
    fn copy2_head(&self) -> Option<u64>;
    /// The newest block the feed has announced (None = unknown).
    fn feed_head(&self) -> Option<u64>;
    /// Node usage counters for status.
    fn usage(&self) -> Value {
        Value::Null
    }
}

/// The live keeper's node and heads.
struct LiveIo {
    node: crate::node::NodeClient,
    c2: super::intake::Copy2Handle,
    l2_offset: u64,
}

impl KeeperIo for LiveIo {
    fn block(&self, b: u64) -> Result<Option<Vec<StateDiff>>, String> {
        fetch_block(&self.node, b)
    }
    fn proof(&self, addr: Address, slots: &[U256], at: u64, code: bool) -> Result<ProofAnswer, String> {
        fetch_proof(&self.node, addr, slots, at, code)
    }
    fn copy2_head(&self) -> Option<u64> {
        self.c2.sh.published.view().head().map(|v| v.block)
    }
    fn feed_head(&self) -> Option<u64> {
        crate::check::feedstore::feed_tip().map(|(s, _)| s + self.l2_offset)
    }
    fn usage(&self) -> Value {
        crate::node::NodeApi::usage(&self.node)
    }
}

/// Where the keeper's runtime hands its results (live: the process-wide
/// RT; replay: its own).
#[derive(Clone)]
pub struct Sink {
    pub versions: Arc<Mutex<VecDeque<Arc<KeptVersion>>>>,
    pub status: Arc<Mutex<Value>>,
    /// Called after every new version (live: wakes the predicted copy).
    pub on_publish: Arc<dyn Fn() + Send + Sync>,
    /// Set = the runtime returns (replay end; never set live).
    pub stop: Arc<std::sync::atomic::AtomicBool>,
}

impl Sink {
    pub fn new(on_publish: Arc<dyn Fn() + Send + Sync>) -> Sink {
        Sink { versions: Default::default(), status: Arc::new(Mutex::new(json!({}))), on_publish, stop: Default::default() }
    }
    /// The version of exactly `block` (None = not held).
    pub fn version_at(&self, block: u64) -> Option<Arc<KeptVersion>> {
        let v = self.versions.lock().unwrap_or_else(|e| e.into_inner());
        v.iter().rev().find(|x| x.block == block).cloned()
    }
    fn publish(&self, k: &KeeperCore, keep: usize) {
        if let Some(v) = k.latest() {
            let mut g = self.versions.lock().unwrap_or_else(|e| e.into_inner());
            if g.back().is_some_and(|x| x.block == v.block) {
                g.pop_back();
            }
            // A restart can go back to an older block: never keep versions
            // of blocks after the new one (they belong to the old run).
            while g.back().is_some_and(|x| x.block > v.block) {
                g.pop_back();
            }
            g.push_back(v.clone());
            while g.len() > keep {
                g.pop_front();
            }
            drop(g);
            (self.on_publish)();
        }
    }
    fn stopped(&self) -> bool {
        self.stop.load(std::sync::atomic::Ordering::Relaxed)
    }
}

struct Rt {
    learn: std::sync::mpsc::SyncSender<Vec<MissItem>>,
    sink: Sink,
    dropped: std::sync::atomic::AtomicU64,
}

static RT: OnceLock<Rt> = OnceLock::new();

/// Start the keeper (only with FASTLANE_AHEAD=on|observe and the keeper on;
/// see KeeperCfg). Returns whether it started.
pub fn start(c2: super::intake::Copy2Handle) -> bool {
    let cfg = KeeperCfg::from_lookup(|k| std::env::var(k).ok());
    if !cfg.on || super::ahead::mode() == super::ahead::Mode::Off || RT.get().is_some() {
        return false;
    }
    // No daily allowance and no own speed limit (owner rule): only the
    // shared provider handling (node.rs halves the rate on "too fast").
    let Some(node) = crate::node::NodeClient::from_env_with_paid_budget(crate::node::Budget::no_caps()) else {
        eprintln!("[arbsim] fastlane keeper: no node configured: OFF");
        return false;
    };
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<MissItem>>(1024);
    let sink = Sink::new(Arc::new(super::ahead::kept_hook));
    if RT.set(Rt { learn: tx, sink: sink.clone(), dropped: Default::default() }).is_err() {
        return false;
    }
    eprintln!(
        "[arbsim] fastlane keeper ON: keeps up to {} hot contracts exact (block diffs {} at a time{}, seeds {}; no daily allowance or own speed limit)",
        cfg.max_contracts,
        cfg.fetch_par,
        if cfg.lead_feed { ", up to the feed's newest block" } else { "" },
        if cfg.seed_par == 0 { "only while caught up".to_string() } else { format!("{} at a time on their own lane", cfg.seed_par) },
    );
    let l2_offset = c2.sh.cfg.l2_offset;
    let io: Arc<dyn KeeperIo> = Arc::new(LiveIo { node, c2, l2_offset });
    std::thread::Builder::new()
        .name("arbsim-keeper".into())
        .spawn(move || {
            crate::fastlane::mode::lower_this_thread_from_env("arbsim-keeper");
            drive(io, cfg, rx, sink)
        })
        .is_ok()
}

/// The predicted copy's runs: values to learn (no-op when the keeper is off).
pub fn learn_hook(items: Vec<MissItem>) {
    let Some(rt) = RT.get() else { return };
    if items.is_empty() {
        return;
    }
    if rt.learn.try_send(items).is_err() {
        rt.dropped.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Is the keeper running?
pub fn running() -> bool {
    RT.get().is_some()
}

/// The keeper's version of exactly `block` (None = off / not held).
pub fn version_at(block: u64) -> Option<Arc<KeptVersion>> {
    RT.get()?.sink.version_at(block)
}

/// The keeper's newest version (None = off / not started).
pub fn latest() -> Option<Arc<KeptVersion>> {
    let rt = RT.get()?;
    let v = rt.sink.versions.lock().unwrap_or_else(|e| e.into_inner());
    v.back().cloned()
}

/// status "fastlaneKeeper" (None when off).
pub fn status_json() -> Option<Value> {
    let rt = RT.get()?;
    let mut v = rt.sink.status.lock().unwrap_or_else(|e| e.into_inner()).clone();
    v["learnDropped"] = json!(rt.dropped.load(std::sync::atomic::Ordering::Relaxed));
    Some(v)
}

/// Everything learned since the last look, as ONE batch (live speed, Oct 31
/// night: `learn` picks the kept contracts again each call, a sort of up to
/// 4,096 candidates; it used to run once per batch the predicted copy sent).
fn learn_all(k: &mut KeeperCore, rx: &std::sync::mpsc::Receiver<Vec<MissItem>>) {
    let mut all: Vec<MissItem> = Vec::new();
    while let Ok(items) = rx.try_recv() {
        all.extend(items);
    }
    if !all.is_empty() {
        k.learn(&all);
    }
}

/// The keeper's runtime: the old one-at-a-time loop, or (any of the live
/// speed settings on) the pipelined one. Returns when `sink.stop` is set.
pub fn drive(io: Arc<dyn KeeperIo>, cfg: KeeperCfg, rx: std::sync::mpsc::Receiver<Vec<MissItem>>, sink: Sink) {
    if cfg.fetch_par <= 1 && cfg.seed_par == 0 && !cfg.lead_feed {
        drive_serial(io, cfg, rx, sink)
    } else {
        drive_pipelined(io, cfg, rx, sink)
    }
}

/// Status of the runtime (once a second): the core's, plus calls and node.
struct Meter {
    calls: u64,
    not_yet: u64,
    since: Instant,
    rate_refusals: u64,
}

impl Meter {
    fn new() -> Meter {
        Meter { calls: 0, not_yet: 0, since: Instant::now(), rate_refusals: 0 }
    }
    fn status(&mut self, k: &KeeperCore, io: &dyn KeeperIo, rate_wait: Duration, extra: Value) -> Value {
        let mut st = k.status_json();
        let el = self.since.elapsed().as_secs_f64().max(1.0);
        st["callsPerS"] = json!((self.calls as f64 / el * 100.0).round() / 100.0);
        st["calls"] = json!(self.calls);
        st["notYet"] = json!(self.not_yet);
        st["node"] = io.usage();
        st["rateRefusals"] = json!(self.rate_refusals);
        st["rateWaitMs"] = json!(rate_wait.as_millis() as u64);
        st["copy2Head"] = json!(io.copy2_head());
        st["feedHead"] = json!(io.feed_head());
        // Blocks the keeper is behind copy 2 (negative = ahead of it).
        st["behindCopy2"] = json!(match (io.copy2_head(), k.head()) {
            (Some(c), Some(h)) => c as i64 - h as i64,
            _ => 0,
        });
        st["pipeline"] = extra;
        if self.since.elapsed() >= Duration::from_secs(3600) {
            self.since = Instant::now();
            self.calls = 0;
            self.not_yet = 0;
        }
        st
    }
}

/// The original runtime (Oct 31): one block diff at a time; seeds and audits
/// only while caught up, on the same thread. Kept as is (FASTLANE_AHEAD_KEEP_
/// FETCH_PAR=1, _SEED_PAR=0, _LEAD=off) for before / after.
fn drive_serial(io: Arc<dyn KeeperIo>, cfg: KeeperCfg, rx: std::sync::mpsc::Receiver<Vec<MissItem>>, sink: Sink) {
    let mut k = KeeperCore::new(cfg.clone());
    let mut errors = 0u32;
    let mut last_seen: Option<u64> = None;
    let mut hour = Instant::now();
    let mut seeds_hour = 0u64;
    let mut audit_at = Instant::now();
    let mut status_at = Instant::now();
    let mut m = Meter::new();
    // Provider said "too fast": wait this long before the next call
    // (doubles while it keeps refusing, 100 ms .. 5 s; back to 0 on success).
    let mut rate_wait = Duration::ZERO;
    while !sink.stopped() {
        // Memory guard (memguard.rs): stop growing near pm2's limit.
        k.mem_pause = crate::memguard::pressure();
        // Learned values from the predicted copy (all queued; the old loop
        // handed them over one batch at a time).
        while let Ok(items) = rx.try_recv() {
            k.learn(&items);
        }
        if hour.elapsed() >= Duration::from_secs(3600) {
            hour = Instant::now();
            seeds_hour = 0;
            k.decay();
            eprintln!("[arbsim] fastlane keeper (last hour): {}", k.status_json());
        }
        if status_at.elapsed() >= Duration::from_secs(1) {
            status_at = Instant::now();
            *sink.status.lock().unwrap_or_else(|e| e.into_inner()) = m.status(&k, io.as_ref(), rate_wait, json!({"mode": "serial"}));
        }
        let Some(target) = io.copy2_head() else {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        };
        // Copy 2 went backwards (a reorg / restart): start again there.
        if last_seen.is_some_and(|l| target < l) {
            k.reset(target, "copy2_backwards");
            sink.publish(&k, cfg.versions);
        }
        last_seen = Some(target);
        let head = match k.head() {
            None => {
                k.start_at(target);
                sink.publish(&k, cfg.versions);
                target
            }
            Some(h) if target > h + cfg.max_behind => {
                k.reset(target, "behind");
                sink.publish(&k, cfg.versions);
                target
            }
            Some(h) => h,
        };
        if head < target {
            // KEEP EXACT: the next block's changes.
            m.calls += 1;
            match io.block(head + 1) {
                Ok(Some(txs)) => {
                    errors = 0;
                    rate_wait = Duration::ZERO;
                    if k.apply_block(head + 1, &txs).is_err() {
                        k.reset(target, "gap");
                    }
                    sink.publish(&k, cfg.versions);
                }
                Ok(None) => {
                    m.not_yet += 1;
                    std::thread::sleep(Duration::from_millis(20))
                }
                Err(e) => {
                    if crate::node::is_rate_refusal(0, &e) {
                        // The provider said "too fast" (shared handling:
                        // node.rs already halved the rate). Not an error:
                        // wait a little longer each time, retry the same
                        // block. Falling too far behind still restarts it.
                        m.rate_refusals += 1;
                        rate_wait = (rate_wait * 2).clamp(Duration::from_millis(100), Duration::from_secs(5));
                        std::thread::sleep(rate_wait);
                        continue;
                    }
                    errors += 1;
                    if errors >= 20 {
                        k.reset(target, "node_errors");
                        sink.publish(&k, cfg.versions);
                        errors = 0;
                        std::thread::sleep(Duration::from_millis(500));
                    } else {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                }
            }
            continue;
        }
        // Caught up: one seed (within the hourly limit), then maybe an audit.
        // (seeds_per_hour is 0 = no limit live; see KeeperCfg.)
        if cfg.seeds_per_hour == 0 || seeds_hour < cfg.seeds_per_hour {
            if let Some(job) = k.take_job() {
                seeds_hour += 1;
                m.calls += 1;
                let need_code = job.basics;
                let ans = match io.proof(job.addr, &job.slots, head, need_code) {
                    Ok((info, code, slots)) => {
                        let code = code.filter(|_| need_code);
                        Some(SeedAnswer { addr: job.addr, at: head, basics: job.basics.then_some(info), code, slots })
                    }
                    Err(_) => None,
                };
                k.on_seed(&job, ans);
                sink.publish(&k, cfg.versions);
                continue;
            }
        }
        if cfg.audit_s > 0 && audit_at.elapsed() >= Duration::from_secs(cfg.audit_s) {
            audit_at = Instant::now();
            if let Some((a, slots)) = k.audit_pick(50) {
                m.calls += 1;
                if let Ok((info, _, vals)) = io.proof(a, &slots, head, false) {
                    if k.audit_check(head, a, Some(info), &vals) > 0 {
                        sink.publish(&k, cfg.versions);
                    }
                }
            }
            continue;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Work for the pipelined runtime's helper threads.
enum Job {
    Block(u64, u64),
    Seed(u64, SeedJob, u64),
    Audit(u64, Address, Vec<U256>, u64),
}

/// ... and what comes back (with the run number `gen`: answers of a run
/// that was restarted meanwhile are thrown away).
enum Done {
    Block(u64, u64, Result<Option<Vec<StateDiff>>, String>),
    Seed(u64, SeedJob, u64, Result<ProofAnswer, String>),
    Audit(u64, Address, u64, Result<ProofAnswer, String>),
}

/// Helper threads: each takes the next job of its lane and answers it.
fn spawn_lane(n: usize, name: &str, io: &Arc<dyn KeeperIo>, done: &std::sync::mpsc::Sender<Done>) -> Option<std::sync::mpsc::Sender<Job>> {
    if n == 0 {
        return None;
    }
    let (tx, rx) = std::sync::mpsc::channel::<Job>();
    let rx = Arc::new(Mutex::new(rx));
    for i in 0..n {
        let (rx, io, done) = (rx.clone(), io.clone(), done.clone());
        let _ = std::thread::Builder::new().name(format!("{name}-{i}")).spawn(move || {
            crate::fastlane::mode::lower_this_thread_from_env("arbsim-keeper");
            loop {
                let job = {
                    let g = rx.lock().unwrap_or_else(|e| e.into_inner());
                    g.recv()
                };
                let Ok(job) = job else { return };
                let out = match job {
                    Job::Block(g, b) => Done::Block(g, b, io.block(b)),
                    Job::Seed(g, j, at) => {
                        let r = io.proof(j.addr, &j.slots, at, j.basics);
                        Done::Seed(g, j, at, r)
                    }
                    Job::Audit(g, a, slots, at) => Done::Audit(g, a, at, io.proof(a, &slots, at, false)),
                };
                if done.send(out).is_err() {
                    return;
                }
            }
        });
    }
    Some(tx)
}

/// THE PIPELINED RUNTIME (live speed, Oct 31 night). Live, the old loop made
/// ~13.5 calls a second one after the other while blocks come ~10 a second:
/// every slow answer, slow apply or seed (it waited for each one) put it
/// further behind, and past 64 blocks it dropped everything and started
/// again (19 restarts in 23 minutes; its version matched only half of the
/// predicted copy's bases). Now:
///   - up to FASTLANE_AHEAD_KEEP_FETCH_PAR block diffs are out at once; the
///     answers are applied strictly in block order (never a gap: a block
///     that is not there yet is asked again);
///   - seeds and audits have their own lane (FASTLANE_AHEAD_KEEP_SEED_PAR),
///     read at the keeper's block when sent and carried forward through the
///     blocks applied meanwhile (`on_seed`, as before);
///   - with FASTLANE_AHEAD_KEEP_LEAD it reads up to the feed's newest block,
///     so its version is ready before copy 2 publishes the same block;
///   - learned values are taken as one batch per round.
/// Same safety: a restart (behind / gap / node errors / copy 2 backwards /
/// audit) drops everything, and answers of the old run are thrown away.
fn drive_pipelined(io: Arc<dyn KeeperIo>, cfg: KeeperCfg, rx: std::sync::mpsc::Receiver<Vec<MissItem>>, sink: Sink) {
    let mut k = KeeperCore::new(cfg.clone());
    let (done_tx, done_rx) = std::sync::mpsc::channel::<Done>();
    let blocks = spawn_lane(cfg.fetch_par.max(1), "arbsim-keeper-blk", &io, &done_tx);
    let seeds = spawn_lane(cfg.seed_par, "arbsim-keeper-seed", &io, &done_tx);
    drop(done_tx);
    let Some(blocks) = blocks else { return };
    let mut gen = 0u64;
    let mut inflight: HashSet<u64> = HashSet::new();
    let mut ready: std::collections::BTreeMap<u64, Vec<StateDiff>> = Default::default();
    let mut retry: HashMap<u64, Instant> = HashMap::new();
    let mut seeds_out = 0usize;
    let mut errors = 0u32;
    let mut last_seen: Option<u64> = None;
    let mut hour = Instant::now();
    let mut audit_at = Instant::now();
    let mut status_at = Instant::now();
    let mut m = Meter::new();
    let mut rate_wait = Duration::ZERO;
    let mut rate_until: Option<Instant> = None;
    let mut ahead_max = 0i64;
    // Restart: everything held dropped (KeeperCore::reset) and every answer
    // still out belongs to the old run.
    macro_rules! restart {
        ($at:expr, $why:expr) => {{
            k.reset($at, $why);
            gen += 1;
            inflight.clear();
            ready.clear();
            retry.clear();
            sink.publish(&k, cfg.versions);
        }};
    }
    while !sink.stopped() {
        // Memory guard (memguard.rs): stop growing near pm2's limit.
        k.mem_pause = crate::memguard::pressure();
        learn_all(&mut k, &rx);
        if hour.elapsed() >= Duration::from_secs(3600) {
            hour = Instant::now();
            k.decay();
            eprintln!("[arbsim] fastlane keeper (last hour): {}", k.status_json());
        }
        if status_at.elapsed() >= Duration::from_secs(1) {
            status_at = Instant::now();
            let extra = json!({"mode": "pipelined", "fetchPar": cfg.fetch_par, "seedPar": cfg.seed_par, "lead": cfg.lead_feed, "inFlight": inflight.len(), "ready": ready.len(), "seedsOut": seeds_out, "aheadOfCopy2Max": ahead_max});
            *sink.status.lock().unwrap_or_else(|e| e.into_inner()) = m.status(&k, io.as_ref(), rate_wait, extra);
        }
        let Some(c2) = io.copy2_head() else {
            std::thread::sleep(Duration::from_millis(20));
            continue;
        };
        if last_seen.is_some_and(|l| c2 < l) {
            restart!(c2, "copy2_backwards");
        }
        last_seen = Some(c2);
        let head = match k.head() {
            None => {
                k.start_at(c2);
                sink.publish(&k, cfg.versions);
                c2
            }
            Some(h) if c2 > h + cfg.max_behind => {
                restart!(c2, "behind");
                c2
            }
            Some(h) => h,
        };
        let target = if cfg.lead_feed { c2.max(io.feed_head().unwrap_or(0)) } else { c2 };
        let now = Instant::now();
        let paused = rate_until.is_some_and(|t| now < t);
        // Ask for the next blocks (at most fetch_par out at once).
        if !paused {
            let mut b = head + 1;
            while b <= target && inflight.len() < cfg.fetch_par.max(1) && b <= head + 4 * cfg.fetch_par.max(1) as u64 {
                if !inflight.contains(&b) && !ready.contains_key(&b) && retry.get(&b).is_none_or(|t| *t <= now) {
                    if blocks.send(Job::Block(gen, b)).is_err() {
                        return;
                    }
                    m.calls += 1;
                    inflight.insert(b);
                }
                b += 1;
            }
        }
        // Seeds / audits on their own lane (read at the keeper's block now).
        if let Some(sl) = &seeds {
            while !paused && seeds_out < cfg.seed_par {
                let Some(job) = k.take_job() else { break };
                m.calls += 1;
                seeds_out += 1;
                if sl.send(Job::Seed(gen, job, head)).is_err() {
                    return;
                }
            }
            if !paused && seeds_out < cfg.seed_par && cfg.audit_s > 0 && audit_at.elapsed() >= Duration::from_secs(cfg.audit_s) {
                audit_at = Instant::now();
                if let Some((a, slots)) = k.audit_pick(50) {
                    m.calls += 1;
                    seeds_out += 1;
                    if sl.send(Job::Audit(gen, a, slots, head)).is_err() {
                        return;
                    }
                }
            }
        } else if head >= c2 && inflight.is_empty() && ready.is_empty() && !paused {
            // FASTLANE_AHEAD_KEEP_SEED_PAR=0: the old rule (one seed at a
            // time, only while caught up, on this thread).
            if let Some(job) = k.take_job() {
                m.calls += 1;
                let ans = io.proof(job.addr, &job.slots, head, job.basics).ok().map(|(info, code, slots)| SeedAnswer { addr: job.addr, at: head, basics: job.basics.then_some(info), code: code.filter(|_| job.basics), slots });
                k.on_seed(&job, ans);
                sink.publish(&k, cfg.versions);
            }
        }
        // Answers (wait a little for the first one: no busy loop).
        let mut got: Vec<Done> = Vec::new();
        match done_rx.recv_timeout(Duration::from_millis(5)) {
            Ok(d) => got.push(d),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            Err(_) => {}
        }
        while let Ok(d) = done_rx.try_recv() {
            got.push(d);
        }
        let now = Instant::now();
        let mut changed = false;
        for d in got {
            match d {
                Done::Block(g, b, r) => {
                    if g != gen {
                        continue;
                    }
                    inflight.remove(&b);
                    match r {
                        Ok(Some(t)) => {
                            errors = 0;
                            rate_wait = Duration::ZERO;
                            retry.remove(&b);
                            ready.insert(b, t);
                        }
                        Ok(None) => {
                            // The node does not have it yet (we lead copy 2).
                            m.not_yet += 1;
                            retry.insert(b, now + Duration::from_millis(50));
                        }
                        Err(e) if crate::node::is_rate_refusal(0, &e) => {
                            m.rate_refusals += 1;
                            rate_wait = (rate_wait * 2).clamp(Duration::from_millis(100), Duration::from_secs(5));
                            rate_until = Some(now + rate_wait);
                            retry.insert(b, now + rate_wait);
                        }
                        Err(_) => {
                            errors += 1;
                            if errors >= 20 {
                                errors = 0;
                                restart!(c2, "node_errors");
                            } else {
                                retry.insert(b, now + Duration::from_millis(50));
                            }
                        }
                    }
                }
                Done::Seed(g, job, at, r) => {
                    seeds_out = seeds_out.saturating_sub(1);
                    if g != gen {
                        continue;
                    }
                    let ans = r.ok().map(|(info, code, slots)| SeedAnswer { addr: job.addr, at, basics: job.basics.then_some(info), code: code.filter(|_| job.basics), slots });
                    k.on_seed(&job, ans);
                    changed = true;
                }
                Done::Audit(g, a, at, r) => {
                    seeds_out = seeds_out.saturating_sub(1);
                    if g != gen {
                        continue;
                    }
                    if let Ok((info, _, vals)) = r {
                        if k.audit_check(at, a, Some(info), &vals) > 0 {
                            // Everything was dropped: answers out are stale.
                            gen += 1;
                            inflight.clear();
                            ready.clear();
                            retry.clear();
                            changed = true;
                        }
                    }
                }
            }
        }
        // Apply in block order, never past a gap.
        while let Some(h) = k.head() {
            let Some(t) = ready.remove(&(h + 1)) else { break };
            if k.apply_block(h + 1, &t).is_err() {
                restart!(c2, "gap");
                break;
            }
            changed = true;
        }
        if let Some(h) = k.head() {
            ahead_max = ahead_max.max(h as i64 - c2 as i64);
        }
        if changed {
            sink.publish(&k, cfg.versions);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(n: u64) -> Address {
        Address::from_word(B256::from(U256::from(n).to_be_bytes::<32>()))
    }
    fn u(n: u64) -> U256 {
        U256::from(n)
    }
    fn slot_diff(addr: Address, writes: &[(u64, u64)]) -> StateDiff {
        let mut d = StateDiff::default();
        d.accounts.insert(addr, AccountDiff { storage: writes.iter().map(|(s, v)| (u(*s), u(*v))).collect(), ..Default::default() });
        d
    }
    fn core(n: usize) -> KeeperCore {
        KeeperCore::new(KeeperCfg { on: true, max_contracts: n, ..KeeperCfg::default() })
    }
    fn seed(k: &mut KeeperCore, at: u64) {
        while let Some(j) = k.take_job() {
            let slots = j.slots.iter().map(|s| (*s, *s * u(10))).collect();
            let basics = j.basics.then(|| Some(AccountInfo { balance: u(5), nonce: 1, code_hash: KECCAK_EMPTY, ..Default::default() }));
            let ans = SeedAnswer { addr: j.addr, at, basics, code: None, slots };
            k.on_seed(&j, Some(ans));
        }
    }

    /// Learn -> seed -> every later block keeps the held values exact; a
    /// value the block touched but we never held stays unknown.
    #[test]
    fn held_values_follow_the_blocks_and_unheld_ones_stay_unknown() {
        // (FASTLANE_AHEAD_KEEP_ADOPT off: with it on, a written value of a
        // kept contract is adopted; see written_values_of_kept_contracts_are_adopted.)
        let mut k = KeeperCore::new(KeeperCfg { on: true, max_contracts: 10, adopt_writes: false, ..KeeperCfg::default() });
        k.start_at(100);
        k.learn(&[MissItem::Slot(a(1), u(1)), MissItem::Slot(a(1), u(2))]);
        seed(&mut k, 100);
        assert_eq!(k.account(&a(1)).unwrap().storage.get(&u(1)), Some(&u(10)));
        k.apply_block(101, &[slot_diff(a(1), &[(1, 77), (3, 99)])]).unwrap();
        let acct = k.account(&a(1)).unwrap();
        assert_eq!(acct.storage.get(&u(1)), Some(&u(77)), "held value updated");
        assert_eq!(acct.storage.get(&u(2)), Some(&u(20)), "untouched held value kept");
        assert_eq!(acct.storage.get(&u(3)), None, "touched but never held: unknown");
        let v = k.version_at(101).unwrap();
        assert!(v.holds_slot(&a(1), &u(1)) && !v.holds_slot(&a(1), &u(3)));
        assert_eq!(k.version_at(100).unwrap().accounts.get(&a(1)).unwrap().storage.get(&u(1)), Some(&u(10)), "older version unchanged");
    }

    /// A seed answered at an older block is carried forward through the
    /// blocks applied since; one older than the kept changes is dropped.
    #[test]
    fn a_late_seed_is_carried_forward_or_dropped() {
        let mut k = core(10);
        k.start_at(100);
        k.learn(&[MissItem::Slot(a(1), u(1))]);
        let j = k.take_job().unwrap();
        k.apply_block(101, &[slot_diff(a(1), &[(1, 5)])]).unwrap();
        k.apply_block(102, &[slot_diff(a(2), &[(1, 6)])]).unwrap();
        k.on_seed(&j, Some(SeedAnswer { addr: a(1), at: 100, basics: None, code: None, slots: vec![(u(1), u(1))] }));
        assert_eq!(k.account(&a(1)).unwrap().storage.get(&u(1)), Some(&u(5)), "the value at 100 + block 101's change");
        assert_eq!(k.version_at(102).unwrap().accounts.get(&a(1)).unwrap().storage.get(&u(1)), Some(&u(5)), "republished at the head");
        // A seed older than the kept changes can't be carried: dropped.
        let mut k = KeeperCore::new(KeeperCfg { on: true, versions: 2, ..KeeperCfg::default() });
        k.start_at(100);
        k.learn(&[MissItem::Slot(a(1), u(1))]);
        let j = k.take_job().unwrap();
        for b in 101..=104 {
            k.apply_block(b, &[]).unwrap();
        }
        k.on_seed(&j, Some(SeedAnswer { addr: a(1), at: 100, basics: None, code: None, slots: vec![(u(1), u(1))] }));
        assert!(k.account(&a(1)).is_none());
        assert_eq!(k.stats.seeds_dropped, 1);
        // ...and it can be asked again.
        k.learn(&[MissItem::Slot(a(1), u(1))]);
        assert!(k.take_job().is_some());
    }

    /// Never a gap: a block that is not the next one is refused.
    #[test]
    fn blocks_must_come_in_order() {
        let mut k = core(10);
        k.start_at(100);
        assert_eq!(k.apply_block(102, &[]), Err("gap"));
        assert_eq!(k.apply_block(100, &[]), Ok(()), "old block: ignored");
        assert_eq!(k.head(), Some(100));
        k.apply_block(101, &[]).unwrap();
        assert_eq!(k.head(), Some(101));
    }

    /// Bounded: only the top contracts are kept; a newcomer must clearly
    /// beat the coldest kept one; cold ones are evicted after decay.
    #[test]
    fn only_the_hottest_contracts_are_kept() {
        let mut k = core(2);
        k.start_at(1);
        for _ in 0..3 {
            k.learn(&[MissItem::Slot(a(1), u(1))]);
            k.learn(&[MissItem::Slot(a(2), u(1))]);
        }
        k.learn(&[MissItem::Slot(a(3), u(1))]);
        seed(&mut k, 1);
        assert_eq!(k.held_list(), vec![a(1), a(2)]);
        assert!(k.account(&a(3)).is_none());
        // a(3) becomes much hotter; a(1) / a(2) go cold.
        for _ in 0..40 {
            k.learn(&[MissItem::Slot(a(3), u(1))]);
        }
        for _ in 0..4 {
            k.decay();
        }
        k.learn(&[MissItem::Slot(a(3), u(1))]);
        assert!(k.held_list().contains(&a(3)), "{:?}", k.held_list());
        assert_eq!(k.held_list().len(), 2);
        assert!(k.stats.evicted >= 1);
    }

    /// Per-contract value cap.
    #[test]
    fn values_per_contract_are_capped() {
        let mut k = KeeperCore::new(KeeperCfg { on: true, max_slots_per: 3, ..KeeperCfg::default() });
        k.start_at(1);
        let items: Vec<MissItem> = (0..10).map(|s| MissItem::Slot(a(1), u(s))).collect();
        k.learn(&items);
        seed(&mut k, 1);
        assert_eq!(k.account(&a(1)).unwrap().storage.len(), 3);
        assert!(k.stats.refused_full > 0);
    }

    /// An audit mismatch drops everything (fail closed) and asks again.
    #[test]
    fn an_audit_mismatch_drops_everything() {
        let mut k = core(10);
        k.start_at(5);
        k.learn(&[MissItem::Slot(a(1), u(1))]);
        seed(&mut k, 5);
        let (addr, slots) = k.audit_pick(10).unwrap();
        assert_eq!((addr, slots.clone()), (a(1), vec![u(1)]));
        assert_eq!(k.audit_check(5, addr, None, &[(u(1), u(10))]), 0, "same value");
        assert_eq!(k.audit_check(5, addr, None, &[(u(1), u(11))]), 1);
        assert!(k.account(&a(1)).is_none(), "dropped");
        assert_eq!(k.stats.resets.get("audit_mismatch"), Some(&1));
        assert!(k.take_job().is_some(), "asked again");
    }

    /// Merge: the keeper's values win (also over copy 2's lagging "exact"
    /// ones and a stale "does not exist"); KeptProv marks them exact.
    #[test]
    fn merge_prefers_the_keepers_exact_values() {
        struct P;
        impl Provenance for P {
            fn slot_exact(&self, _a: Address, s: U256) -> bool {
                s == U256::from(1u64)
            }
            fn balance_exact(&self, _a: Address) -> bool {
                false
            }
        }
        let mut base = Snapshot::default();
        base.apply_fact(&crate::state::snap::Fact::Slot(a(1), u(1), u(111)));
        base.apply_fact(&crate::state::snap::Fact::Slot(a(1), u(2), u(222)));
        let mut kv = KeptVersion { block: 9, ..Default::default() };
        let mut acct = Acct::default();
        acct.storage.insert(u(1), u(1));
        acct.storage.insert(u(2), u(2));
        acct.storage.insert(u(3), u(3));
        acct.basics = Basics::Known(Some(AccountInfo { balance: u(7), nonce: 1, code_hash: KECCAK_EMPTY, ..Default::default() }));
        kv.accounts.insert(a(1), acct.clone());
        kv.accounts.insert(a(2), acct.clone());
        // ahead3: copy 2 holds a(3) as "does not exist, every slot known",
        // but only approximately (an old look); the keeper says it exists.
        base.accounts.insert(a(3), Acct { basics: Basics::Known(None), balance_exact: false, storage: PMap::default(), storage_complete: true });
        kv.accounts.insert(a(3), acct);
        let (m, n) = merge_base(&base, &P, &kv);
        use crate::state::StateRead;
        assert_eq!(m.storage(a(1), u(1)), crate::state::Lookup::Known(u(1)), "the keeper's exact value wins over copy 2's lagging 'exact' one");
        assert_eq!(n.overrode, 1);
        assert_eq!(m.storage(a(1), u(2)), crate::state::Lookup::Known(u(2)), "copy 2's approximate value replaced");
        assert_eq!(m.storage(a(1), u(3)), crate::state::Lookup::Known(u(3)));
        assert_eq!(m.storage(a(2), u(3)), crate::state::Lookup::Known(u(3)));
        assert!(matches!(m.account(a(3)), crate::state::Lookup::Known(Some(i)) if i.nonce == 1), "a stale 'does not exist' is replaced");
        assert_eq!(m.storage(a(3), u(9)), crate::state::Lookup::Missing, "and a value the keeper doesn't hold reads missing, not zero");
        assert_eq!((n.accounts, n.replaced), (3, 1));
        let kp = KeptProv { inner: Arc::new(P), kept: Arc::new(kv) };
        assert!(kp.slot_exact(a(1), u(2)) && kp.slot_exact(a(2), u(3)) && !kp.slot_exact(a(2), u(9)));
        assert!(kp.balance_exact(a(1)));
    }

    /// ahead3: a block that CREATES a contract at an address we hold (its
    /// code is not in the block diffs) drops it and seeds it again, code
    /// and all; it is never held code-less.
    #[test]
    fn a_contract_created_at_a_held_address_is_seeded_again() {
        let mut k = core(10);
        k.start_at(100);
        k.learn(&[MissItem::Account(a(7)), MissItem::Slot(a(7), u(1))]);
        // Seeded while it did not exist yet.
        while let Some(j) = k.take_job() {
            let ans = SeedAnswer { addr: j.addr, at: 100, basics: j.basics.then_some(None), code: None, slots: j.slots.iter().map(|s| (*s, U256::ZERO)).collect() };
            k.on_seed(&j, Some(ans));
        }
        assert!(matches!(k.account(&a(7)).unwrap().basics, Basics::Known(None)));
        // Block 101 deploys it (diff mode, no code: code hash not given).
        let mut d = StateDiff::default();
        d.accounts.insert(a(7), AccountDiff { info: Some(Some(AccountInfo { balance: U256::ZERO, nonce: 1, code_hash: B256::ZERO, ..Default::default() })), storage: [(u(1), u(5))].into_iter().collect(), storage_cleared: true, ..Default::default() });
        k.apply_block(101, &[d]).unwrap();
        assert!(k.account(&a(7)).is_none(), "dropped, not held code-less");
        assert_eq!(k.stats.recreated, 1);
        let j = k.take_job().expect("seeded again");
        assert!(j.basics && j.slots.contains(&u(1)), "basics (and so its code) asked again");
    }

    /// ahead3 (FASTLANE_AHEAD_KEEP_ADOPT): a value a block writes in a kept
    /// contract becomes kept with its exact new value; off = old behaviour.
    #[test]
    fn written_values_of_kept_contracts_are_adopted() {
        for adopt in [true, false] {
            let mut k = KeeperCore::new(KeeperCfg { on: true, adopt_writes: adopt, ..KeeperCfg::default() });
            k.start_at(100);
            k.learn(&[MissItem::Slot(a(1), u(1))]);
            seed(&mut k, 100);
            k.apply_block(101, &[slot_diff(a(1), &[(1, 77), (3, 99)]), slot_diff(a(2), &[(4, 4)])]).unwrap();
            let acct = k.account(&a(1)).unwrap();
            assert_eq!(acct.storage.get(&u(1)), Some(&u(77)));
            assert_eq!(acct.storage.get(&u(3)).copied(), adopt.then(|| u(99)), "adopt = {adopt}");
            assert!(k.account(&a(2)).is_none(), "never a contract we don't keep");
            // Adopted values follow the next blocks like any other.
            k.apply_block(102, &[slot_diff(a(1), &[(3, 100)])]).unwrap();
            assert_eq!(k.account(&a(1)).unwrap().storage.get(&u(3)).copied(), adopt.then(|| u(100)));
        }
    }

    /// Settings: on by default only in observe; numbers are bounded; no
    /// node caps (the old cap settings are ignored).
    #[test]
    fn settings() {
        let cfg = |ahead: Option<&str>, keeper: Option<&str>| {
            KeeperCfg::from_lookup(|k| match k {
                "FASTLANE_AHEAD" => ahead.map(String::from),
                "FASTLANE_AHEAD_KEEPER" => keeper.map(String::from),
                "FASTLANE_AHEAD_KEEP_CONTRACTS" => Some("7".into()),
                // Old cap names (removed, owner rule): ignored.
                "FASTLANE_AHEAD_KEEP_RPS" | "FASTLANE_AHEAD_KEEP_DAILY_CAP" | "FASTLANE_AHEAD_KEEP_SEEDS_PER_H" => Some("1".into()),
                _ => None,
            })
        };
        assert!(!cfg(None, None).on, "FASTLANE_AHEAD off: never");
        assert!(!cfg(None, Some("on")).on, "FASTLANE_AHEAD off: never, even if asked");
        assert!(cfg(Some("observe"), None).on);
        assert!(!cfg(Some("on"), None).on, "on keeps the old behaviour");
        assert!(cfg(Some("on"), Some("on")).on);
        assert!(!cfg(Some("observe"), Some("off")).on);
        assert_eq!(cfg(Some("observe"), None).max_contracts, 7);
        assert_eq!(cfg(Some("observe"), None).seeds_per_hour, 0, "no self-imposed seed limit live");
        assert!(cfg(Some("observe"), None).adopt_writes, "adopting written values: on by default");
        assert!(!KeeperCfg::from_lookup(|k| (k == "FASTLANE_AHEAD_KEEP_ADOPT").then(|| "off".to_string())).adopt_writes);
    }

    // -----------------------------------------------------------------
    // Live speed (Oct 31 night)
    // -----------------------------------------------------------------

    /// The new block apply (only held / adopted writes) gives exactly what
    /// the old one did (apply everything, then drop what we don't hold).
    #[test]
    fn filtered_apply_matches_the_old_one() {
        let x = a(7);
        let mut cur = Acct { basics: Basics::Known(Some(AccountInfo { balance: u(5), nonce: 1, code_hash: KECCAK_EMPTY, ..Default::default() })), balance_exact: true, ..Default::default() };
        for s in 0..50u64 {
            cur.storage.insert(u(s * 3), u(s));
        }
        // Writes to held slots (multiples of 3), to unheld ones, and new basics.
        let mut ad = AccountDiff { info: Some(Some(AccountInfo { balance: u(9), nonce: 2, code_hash: KECCAK_EMPTY, ..Default::default() })), ..Default::default() };
        for s in 0..120u64 {
            ad.storage.insert(u(s), u(1000 + s));
        }
        let keys: HashSet<U256> = cur.storage.keys().copied().collect();
        let old = apply_held(x, &cur, &ad, &keys);
        let mut f = AccountDiff { info: ad.info.clone(), ..Default::default() };
        for (s, v) in &ad.storage {
            if cur.storage.contains_key(s) {
                f.storage.insert(*s, *v);
            }
        }
        let new = apply_filtered(x, &cur, &f);
        assert_eq!(old.basics, new.basics);
        let pairs = |a: &Acct| {
            let mut v: Vec<(U256, U256)> = a.storage.iter().map(|(k, v)| (*k, *v)).collect();
            v.sort();
            v
        };
        assert_eq!(pairs(&old), pairs(&new));
        assert_eq!(new.storage.len(), 50, "no unheld value appears");
        // And through apply_block (adopt off: the same values held).
        let mut k = KeeperCore::new(KeeperCfg { on: true, adopt_writes: false, ..KeeperCfg::default() });
        k.start_at(10);
        k.cur.accounts.insert(x, cur.clone());
        let mut d = StateDiff::default();
        d.accounts.insert(x, ad);
        k.apply_block(11, &[d]).unwrap();
        assert_eq!(pairs(k.account(&x).unwrap()), pairs(&old));
    }

    /// A full candidate list (4,096 live) no longer drops every newcomer at
    /// once: the ones named in this batch stay, the weakest others go.
    #[test]
    fn a_full_candidate_list_keeps_newcomers() {
        let mut k = KeeperCore::new(KeeperCfg { on: true, max_contracts: 1, max_candidates: 4, ..KeeperCfg::default() });
        for n in 1..=4u64 {
            for _ in 0..n * 3 {
                k.learn(&[MissItem::Slot(a(n), u(1))]);
            }
        }
        assert_eq!(k.cands.len(), 4);
        k.learn(&[MissItem::Slot(a(99), u(1))]);
        assert!(k.cands.contains_key(&a(99)), "the newcomer stays");
        assert_eq!(k.cands.len(), 4);
        assert!(!k.cands.contains_key(&a(1)), "the weakest other one went");
        assert_eq!(k.stats.cands_dropped, 1);
    }

    /// A mere candidate remembers at most FASTLANE_AHEAD_KEEP_CAND_SLOTS
    /// values; a kept contract up to FASTLANE_AHEAD_KEEP_SLOTS.
    #[test]
    fn candidate_values_are_bounded() {
        let mut k = KeeperCore::new(KeeperCfg { on: true, max_contracts: 1, cand_slots: 3, max_slots_per: 10, ..KeeperCfg::default() });
        // a(1) becomes the kept one (first, highest score).
        for _ in 0..5 {
            k.learn(&[MissItem::Slot(a(1), u(0))]);
        }
        let many: Vec<MissItem> = (0..20).map(|s| MissItem::Slot(a(2), u(s))).collect();
        k.learn(&many);
        assert_eq!(k.cands[&a(2)].slots.len(), 3, "candidate: 3");
        let many1: Vec<MissItem> = (0..20).map(|s| MissItem::Slot(a(1), u(s))).collect();
        k.learn(&many1);
        assert_eq!(k.cands[&a(1)].slots.len(), 10, "kept: 10");
    }

    /// Pipelined keeper: an audit read at a block it has already moved past
    /// is compared with that block's version (before: never compared).
    #[test]
    fn an_audit_is_compared_with_its_own_blocks_version() {
        let mut k = core(1);
        k.learn(&[MissItem::Slot(a(1), u(1))]);
        k.start_at(10);
        seed(&mut k, 10);
        k.apply_block(11, &[slot_diff(a(1), &[(1, 77)])]).unwrap();
        k.apply_block(12, &[]).unwrap();
        // Audit read at 11 (value 77): right.
        assert_eq!(k.audit_check(11, a(1), None, &[(u(1), u(77))]), 0);
        assert_eq!(k.stats.audits, 1);
        // A wrong value at 11: everything dropped, restarted at the head.
        assert_eq!(k.audit_check(11, a(1), None, &[(u(1), u(78))]), 1);
        assert_eq!(k.head(), Some(12));
        assert!(k.account(&a(1)).is_none());
    }

    /// A node model: blocks 1.. appear every `pace`, answers take `lat`.
    struct FakeIo {
        start: Instant,
        pace: Duration,
        lat: Duration,
        calls: std::sync::atomic::AtomicU64,
    }
    impl FakeIo {
        fn tip(&self) -> u64 {
            100 + (self.start.elapsed().as_micros() / self.pace.as_micros().max(1)) as u64
        }
    }
    impl KeeperIo for FakeIo {
        fn block(&self, b: u64) -> Result<Option<Vec<StateDiff>>, String> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            std::thread::sleep(self.lat);
            Ok((b <= self.tip()).then(|| vec![slot_diff(a(1), &[(1, b)])]))
        }
        fn proof(&self, _addr: Address, slots: &[U256], _at: u64, _code: bool) -> Result<ProofAnswer, String> {
            std::thread::sleep(self.lat);
            Ok((None, None, slots.iter().map(|s| (*s, U256::ZERO)).collect()))
        }
        fn copy2_head(&self) -> Option<u64> {
            Some(self.tip())
        }
        fn feed_head(&self) -> Option<u64> {
            Some(self.tip())
        }
    }

    /// Run the real runtime for `run` against FakeIo; (resets, blocks behind at the end).
    fn drive_for(cfg: KeeperCfg, pace: Duration, lat: Duration, run: Duration) -> (u64, i64) {
        let io = Arc::new(FakeIo { start: Instant::now(), pace, lat, calls: Default::default() });
        let sink = Sink::new(Arc::new(|| {}));
        let (_tx, rx) = std::sync::mpsc::sync_channel::<Vec<MissItem>>(16);
        let (s2, io2) = (sink.clone(), io.clone());
        let t = std::thread::spawn(move || drive(io2, cfg, rx, s2));
        std::thread::sleep(run);
        let head = sink.versions.lock().unwrap().back().map(|v| v.block).unwrap_or(0);
        let behind = io.tip() as i64 - head as i64;
        std::thread::sleep(Duration::from_millis(1100));
        let st = sink.status.lock().unwrap().clone();
        sink.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        t.join().unwrap();
        let resets = st["stats"]["resets"].as_object().map(|m| m.values().filter_map(|v| v.as_u64()).sum()).unwrap_or(0);
        (resets, behind)
    }

    /// Blocks faster than one answer time: the old one-at-a-time loop falls
    /// behind and restarts; the pipelined one keeps up (same node, same pace).
    #[test]
    fn the_pipelined_keeper_keeps_up_where_the_serial_one_falls_behind() {
        let pace = Duration::from_millis(5);
        let lat = Duration::from_millis(25);
        let base = KeeperCfg { on: true, max_behind: 40, ..KeeperCfg::default() };
        let (serial_resets, _) = drive_for(KeeperCfg { fetch_par: 1, seed_par: 0, lead_feed: false, ..base.clone() }, pace, lat, Duration::from_millis(1500));
        assert!(serial_resets >= 1, "serial: 40 blocks/s against 200/s must fall behind ({serial_resets})");
        let (resets, behind) = drive_for(KeeperCfg { fetch_par: 16, seed_par: 1, lead_feed: true, ..base }, pace, lat, Duration::from_millis(1500));
        assert_eq!(resets, 0, "pipelined: no restart");
        assert!(behind < 40, "pipelined: at the tip ({behind} behind)");
    }

    #[test]
    fn live_speed_settings() {
        let cfg = |ahead: &str, extra: Option<(&str, &str)>| {
            KeeperCfg::from_lookup(|k| match k {
                "FASTLANE_AHEAD" => Some(ahead.to_string()),
                "FASTLANE_AHEAD_KEEPER" => Some("on".into()),
                _ => extra.filter(|e| e.0 == k).map(|e| e.1.to_string()),
            })
        };
        let o = cfg("observe", None);
        assert_eq!((o.fetch_par, o.seed_par, o.lead_feed, o.cand_slots), (4, 2, true, 256), "observe: the new way");
        let n = cfg("on", None);
        assert_eq!((n.fetch_par, n.seed_par, n.lead_feed, n.cand_slots), (1, 0, false, 2000), "on: unchanged");
        assert_eq!(cfg("observe", Some(("FASTLANE_AHEAD_KEEP_FETCH_PAR", "1"))).fetch_par, 1);
        assert_eq!(cfg("observe", Some(("FASTLANE_AHEAD_KEEP_FETCH_PAR", "99"))).fetch_par, 4, "out of range: default");
        assert!(!cfg("observe", Some(("FASTLANE_AHEAD_KEEP_LEAD", "off"))).lead_feed);
        assert_eq!(cfg("observe", Some(("FASTLANE_AHEAD_KEEP_SEED_PAR", "0"))).seed_par, 0);
    }

    #[test]
    fn proof_answers_parse() {
        let v = json!({"balance": "0x5", "nonce": "0x1", "codeHash": format!("{KECCAK_EMPTY:#x}"),
            "storageProof": [{"key": "0x1", "value": "0x2a", "proof": []}]});
        let (info, slots) = parse_proof(&v).unwrap();
        assert_eq!(info.unwrap().balance, u(5));
        assert_eq!(slots, vec![(u(1), u(42))]);
        let empty = json!({"balance": "0x0", "nonce": "0x0", "codeHash": "0x0", "storageProof": []});
        assert!(parse_proof(&empty).unwrap().0.is_none(), "an empty account does not exist");
    }

    /// Learning leaves out the sender, Nitro's built-ins and what copy 2
    /// holds exactly; it keeps what was missing or only approximate.
    #[test]
    fn wanted_items_filter() {
        struct P;
        impl Provenance for P {
            fn slot_exact(&self, _a: Address, s: U256) -> bool {
                s == U256::from(1u64)
            }
            fn balance_exact(&self, _a: Address) -> bool {
                true
            }
        }
        let mut snap = Snapshot::default();
        snap.apply_fact(&crate::state::snap::Fact::Slot(a(0x20000), u(1), u(1)));
        snap.apply_fact(&crate::state::snap::Fact::Slot(a(0x20000), u(2), u(2)));
        let accts: HashSet<Address> = [a(0x20000), a(0x30000), a(5)].into_iter().collect();
        let slots: HashSet<(Address, U256)> = [(a(0x20000), u(1)), (a(0x20000), u(2)), (a(0x20000), u(3)), (a(0x40000), u(1))].into_iter().collect();
        let missing = [MissItem::Slot(a(0x50000), u(9)), MissItem::Account(a(0x60000))];
        let out = wanted_items(&missing, Some((&accts, &slots)), &snap, &P, a(0x60000), &|x| *x == a(0x40000));
        let has = |m: MissItem| out.contains(&m);
        assert!(has(MissItem::Slot(a(0x50000), u(9))));
        assert!(!has(MissItem::Account(a(0x60000))), "the sender");
        assert!(has(MissItem::Account(a(0x20000))) && has(MissItem::Account(a(0x30000))), "accounts copy 2 lacks");
        assert!(!has(MissItem::Account(a(5))), "built-in");
        assert!(!has(MissItem::Slot(a(0x20000), u(1))), "exact in copy 2");
        assert!(has(MissItem::Slot(a(0x20000), u(2))), "only approximate in copy 2");
        assert!(has(MissItem::Slot(a(0x20000), u(3))), "missing");
        assert!(!has(MissItem::Slot(a(0x40000), u(1))), "copy 2 follows it (our pool)");
        // ahead3: an account copy 2 holds with only approximate basics (a
        // launch factory's nonce, a token copy 2 saw before it existed).
        struct Approx;
        impl Provenance for Approx {
            fn slot_exact(&self, _a: Address, _s: U256) -> bool {
                true
            }
            fn balance_exact(&self, a: Address) -> bool {
                a != Address::from_word(B256::from(U256::from(0x70000u64).to_be_bytes::<32>()))
            }
        }
        snap.apply_fact(&crate::state::snap::Fact::Basics { addr: a(0x70000), info: None, code: None });
        snap.apply_fact(&crate::state::snap::Fact::Basics { addr: a(0x80000), info: None, code: None });
        let accts: HashSet<Address> = [a(0x70000), a(0x80000)].into_iter().collect();
        let out = wanted_items(&[], Some((&accts, &HashSet::new())), &snap, &Approx, a(0x60000), &|_| false);
        assert!(out.contains(&MissItem::Account(a(0x70000))), "approximate basics are learned");
        assert!(!out.contains(&MissItem::Account(a(0x80000))), "exact ones are not");
    }

    // -----------------------------------------------------------------
    // PRUNE (FASTLANE_AHEAD_KEEP_PRUNE_BLOCKS, memory fix Nov 1)
    // -----------------------------------------------------------------

    fn prune_core(every: u64) -> KeeperCore {
        KeeperCore::new(KeeperCfg { on: true, max_contracts: 10, prune_blocks: every, ..KeeperCfg::default() })
    }

    /// Adopted values nobody asked for and no block wrote for two windows
    /// are dropped; learned ones and recently written ones stay, exact.
    #[test]
    fn prune_drops_only_stale_adopted_values() {
        let mut k = prune_core(10);
        k.start_at(100);
        // Learned (a run needed it): slot 1. Seeded.
        k.learn(&[MissItem::Slot(a(1), u(1))]);
        seed(&mut k, 100);
        // Block 101 writes slots 2..=5: adopted (nobody asked for them).
        k.apply_block(101, &[slot_diff(a(1), &[(2, 2), (3, 3), (4, 4), (5, 5)])]).unwrap();
        assert_eq!(k.account(&a(1)).unwrap().storage.len(), 5);
        // Window 1 (101..111): slot 5 is written again near its end.
        for b in 102..=111 {
            let d = if b == 110 { vec![slot_diff(a(1), &[(5, 55)])] } else { vec![] };
            k.apply_block(b, &d).unwrap();
        }
        // First prune ran at 111: everything written in window 1 (2..=5)
        // survives (written in "this window").
        assert_eq!(k.stats.prunes, 1);
        assert_eq!(k.account(&a(1)).unwrap().storage.len(), 5, "first round: all written recently");
        // Window 2 (112..121): only slot 4 is written.
        for b in 112..=121 {
            let d = if b == 115 { vec![slot_diff(a(1), &[(4, 44)])] } else { vec![] };
            k.apply_block(b, &d).unwrap();
        }
        // Second prune at 121: 2, 3, 5 were last written in window 1 (now
        // "the one before"): kept one more round. Nothing dropped yet.
        assert_eq!(k.stats.prunes, 2);
        assert_eq!(k.account(&a(1)).unwrap().storage.len(), 5);
        // Window 3: nothing written. Third prune: 2, 3, 5 have not been
        // written for two windows -> dropped. 1 (learned) and 4 (written in
        // window 2) stay, with their exact values.
        for b in 122..=131 {
            k.apply_block(b, &[]).unwrap();
        }
        assert_eq!(k.stats.prunes, 3);
        let acct = k.account(&a(1)).unwrap();
        assert_eq!(acct.storage.get(&u(1)), Some(&u(10)), "learned value kept");
        assert_eq!(acct.storage.get(&u(4)), Some(&u(44)), "recently written value kept");
        assert!(acct.storage.get(&u(2)).is_none() && acct.storage.get(&u(3)).is_none() && acct.storage.get(&u(5)).is_none(), "stale adopted values dropped");
        assert_eq!(k.stats.pruned_values, 3);
        assert_eq!(k.stats.prune_last_values, 3);
        // A dropped value is UNKNOWN (never a stale guess): not held.
        assert!(!k.latest().unwrap().holds_slot(&a(1), &u(2)));
        // An older published version still holds it (exact for its block).
        assert!(k.version_at(125).unwrap().holds_slot(&a(1), &u(2)));
    }

    /// Off (0, the core's default): nothing is ever dropped, no writes tracked.
    #[test]
    fn prune_off_keeps_everything() {
        let mut k = prune_core(0);
        k.start_at(100);
        k.learn(&[MissItem::Slot(a(1), u(1))]);
        seed(&mut k, 100);
        k.apply_block(101, &[slot_diff(a(1), &[(2, 2), (3, 3)])]).unwrap();
        for b in 102..=200 {
            k.apply_block(b, &[]).unwrap();
        }
        assert_eq!(k.account(&a(1)).unwrap().storage.len(), 3);
        assert_eq!(k.stats.prunes, 0);
        assert!(k.written_now.is_empty() && k.written_prev.is_empty());
    }

    /// THE LIVE PATTERN (Nov 1-2) at block scale: arbsim lives ~26,000
    /// blocks (~45 min) between restarts; every block rewrites a few hot
    /// values and the keeper adopts ~1.5 brand-new values nobody asked for
    /// (live: 50,000 adopted an hour at 9.7 blocks/s). With the old
    /// 18,000-block window the one prune in that life drops NOTHING (all
    /// adopted values were written in its window) and the values only
    /// grow, as seen live. With the new 3,000-block default they level off
    /// at what was written in the last 2-3 windows, and the learned and
    /// hot values are never dropped.
    #[test]
    fn live_pattern_old_window_drops_nothing_new_window_levels_off() {
        let run = |every: u64| -> (KeeperCore, Vec<usize>) {
            let mut k = KeeperCore::new(KeeperCfg { on: true, max_contracts: 10, prune_blocks: every, max_slots_per: 100_000, max_slots_total: 2_000_000, ..KeeperCfg::default() });
            k.start_at(100);
            k.learn(&[MissItem::Slot(a(1), u(1))]);
            seed(&mut k, 100);
            let mut sizes = Vec::new();
            let mut fresh = 1_000u64;
            for b in 101..=26_100u64 {
                // 3 hot values every block + 1 or 2 new ones (1.5 a block).
                let mut w: Vec<(u64, u64)> = vec![(2, b), (3, b), (4, b)];
                for _ in 0..(1 + b % 2) {
                    fresh += 1;
                    w.push((fresh, b));
                }
                k.apply_block(b, &[slot_diff(a(1), &w)]).unwrap();
                if b % 2_600 == 0 {
                    sizes.push(k.account(&a(1)).unwrap().storage.len());
                }
            }
            (k, sizes)
        };
        // Old default: one prune in the whole life, 0 values dropped, and
        // the held values grow the whole time (live: 10,021 -> 94,735).
        let (old, old_sizes) = run(18_000);
        assert_eq!(old.stats.prunes, 1);
        assert_eq!(old.stats.pruned_values, 0, "the live symptom: the first prune can never drop anything");
        assert!(old_sizes.windows(2).all(|w| w[1] > w[0]), "grows all the time: {old_sizes:?}");
        assert!(old_sizes.last().copied().unwrap() > 38_000, "{old_sizes:?}");
        // New default: drops start at the third prune and the size levels off.
        let (new, new_sizes) = run(PRUNE_BLOCKS_DEFAULT);
        assert_eq!(new.stats.prunes, 8);
        assert!(new.stats.pruned_values > 25_000, "dropped {}", new.stats.pruned_values);
        let last = *new_sizes.last().unwrap();
        assert!(last <= 3 * 3_000 * 3 / 2 + 10, "bounded by ~3 windows of new values: {last} ({new_sizes:?})");
        let tail = &new_sizes[new_sizes.len() - 5..];
        let (lo, hi) = (*tail.iter().min().unwrap(), *tail.iter().max().unwrap());
        assert!(hi - lo <= 4_600, "level, not climbing: {tail:?}");
        // Learned and hot values always stay, exact.
        let acct = new.account(&a(1)).unwrap();
        assert_eq!(acct.storage.get(&u(1)), Some(&u(10)), "learned value kept");
        assert_eq!(acct.storage.get(&u(2)), Some(&u(26_100)), "hot value kept, exact");
    }

    /// A dropped value that a run needs again is learned, seeded again and
    /// from then on kept for good (self-healing; that is why the prune is
    /// safe for accuracy).
    #[test]
    fn a_pruned_value_needed_again_comes_back_and_stays() {
        let mut k = prune_core(10);
        k.start_at(100);
        k.learn(&[MissItem::Slot(a(1), u(1))]);
        seed(&mut k, 100);
        k.apply_block(101, &[slot_diff(a(1), &[(7, 70)])]).unwrap();
        for b in 102..=131 {
            k.apply_block(b, &[]).unwrap();
        }
        assert!(k.account(&a(1)).unwrap().storage.get(&u(7)).is_none(), "dropped after two quiet windows");
        // A run misses it: learned + seeded at the head (exact again).
        k.learn(&[MissItem::Slot(a(1), u(7))]);
        seed(&mut k, 131);
        assert_eq!(k.account(&a(1)).unwrap().storage.get(&u(7)), Some(&u(70)));
        for b in 132..=200 {
            k.apply_block(b, &[]).unwrap();
        }
        assert_eq!(k.account(&a(1)).unwrap().storage.get(&u(7)), Some(&u(70)), "learned now: never dropped");
    }

    /// "Every value known" accounts (created / empty) are never pruned:
    /// dropping a listed value there would read as ZERO, not unknown.
    #[test]
    fn prune_leaves_every_value_known_accounts_alone() {
        let mut k = prune_core(10);
        k.start_at(100);
        k.learn(&[MissItem::Account(a(1))]);
        // The seed says the account does not exist: every value known (zero).
        while let Some(j) = k.take_job() {
            k.on_seed(&j, Some(SeedAnswer { addr: j.addr, at: 100, basics: Some(None), code: None, slots: vec![] }));
        }
        assert!(k.account(&a(1)).unwrap().storage_complete);
        // A block creates it and writes a value (storage_cleared path).
        let mut d = StateDiff::default();
        d.accounts.insert(a(1), AccountDiff { info: Some(Some(AccountInfo { balance: u(1), nonce: 1, code_hash: KECCAK_EMPTY, ..Default::default() })), storage: [(u(3), u(33))].into_iter().collect(), storage_cleared: true, ..Default::default() });
        k.apply_block(101, &[d]).unwrap();
        let before = k.account(&a(1)).unwrap().clone();
        for b in 102..=140 {
            k.apply_block(b, &[]).unwrap();
        }
        let after = k.account(&a(1)).unwrap();
        assert_eq!(after.storage_complete, before.storage_complete);
        assert_eq!(after.storage.len(), before.storage.len(), "nothing dropped from an every-value-known account");
    }

    /// Codes no held account uses any more are dropped at the prune.
    #[test]
    fn prune_drops_unused_codes() {
        let mut k = prune_core(10);
        k.start_at(100);
        k.learn(&[MissItem::Account(a(1))]);
        let code = Bytecode::new_raw(revm::primitives::Bytes::from_static(&[0x60, 0x00]));
        let h = code.hash_slow();
        while let Some(j) = k.take_job() {
            let info = AccountInfo { balance: u(1), nonce: 1, code_hash: h, ..Default::default() };
            k.on_seed(&j, Some(SeedAnswer { addr: j.addr, at: 100, basics: Some(Some(info)), code: Some(code.clone()), slots: vec![] }));
        }
        // A code nobody uses (as left behind by an evicted contract).
        let stale = Bytecode::new_raw(revm::primitives::Bytes::from_static(&[0x60, 0x01]));
        k.cur.codes.insert(stale.hash_slow(), stale);
        assert_eq!(k.cur.codes.len(), 2);
        for b in 101..=111 {
            k.apply_block(b, &[]).unwrap();
        }
        assert_eq!(k.stats.prunes, 1);
        assert_eq!(k.cur.codes.len(), 1, "the unused code is gone");
        assert!(k.has_code(&h), "the code a held contract uses stays");
        assert_eq!(k.stats.pruned_codes, 1);
    }

    /// The live setting: on by default (18,000 blocks), 0 = off, small
    /// values raised to 100.
    #[test]
    fn prune_setting() {
        let get = |v: Option<&'static str>| KeeperCfg::from_lookup(move |k| match k {
            "FASTLANE_AHEAD" => Some("observe".into()),
            "FASTLANE_AHEAD_KEEP_PRUNE_BLOCKS" => v.map(|x| x.to_string()),
            _ => None,
        });
        assert_eq!(get(None).prune_blocks, 3_000, "memory fix 2 (Nov 2): was 18,000");
        assert_eq!(get(Some("0")).prune_blocks, 0);
        assert_eq!(get(Some("5")).prune_blocks, 100);
        assert_eq!(get(Some("36000")).prune_blocks, 36_000);
        assert_eq!(get(Some("junk")).prune_blocks, 3_000);
        assert_eq!(get(Some("18000")).prune_blocks, 18_000, "the old window is still one setting away");
        assert_eq!(KeeperCfg::default().prune_blocks, 0, "the core's own default (tests, replay): off");
    }
}
