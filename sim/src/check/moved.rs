// ============================================================================
// WHICH POOLS DID A TRANSACTION MOVE? (trigger-first entry point, server.rs
// trig_discover)
//
// Plain English: we run the feed transaction alone and get back the storage
// values it changed (check/ordered.rs OrderedOut.changed) and the 64-byte
// inputs of every hash it computed (OrderedOut.hashes: how Solidity finds a
// mapping entry, keccak(key . slot)). From those we name the pools it really
// moved, counting ONLY a pool's own state:
//
//   Uniswap V4 pool (lives inside the shared PoolManager, id = pool id):
//     its data is `_pools[id]` at PoolManager slot 6, base = keccak(id . 6):
//       base + 0  slot0 (price, tick, fees)       -> "slot0"
//       base + 1/2 fee growth                      -> "fees"
//       base + 3  liquidity                        -> "liquidity"
//       keccak(tick . base+4) + 0..2  ticks       -> "ticks"
//       keccak(word . base+5)        tick bitmap  -> "bitmap"
//       keccak(key  . base+6) + 0..2  positions   -> "positions"
//     Anything else the PoolManager writes (coin deltas / balances it keeps
//     for everyone, protocol fees, ERC-6909 claims, its lock) is SHARED by
//     every V4 pool and never counts.
//   Any other pool (its own contract): a changed DECLARED variable of the
//     pool contract (slot number below 2^32: reserves, slot0, liquidity, ...)
//     -> "s<N>". Hashed slots (LP-token balances / allowances, V3 positions /
//     ticks) don't count on their own: a swap that moves the price always
//     changes a declared variable too.
//   Never counted: coin balances (a transfer into a pool doesn't move its
//   price until it trades), values only read, values filled in or pretended
//   for the run (only real changes by the transaction are in `changed`).
//
// Live Oct 23 (PR #175): the first version matched changed values against
// each pool's "followed values" list, which for V4 pools also holds shared
// PoolManager values (added for every pool keyed on the PoolManager). Every
// V4 swap then "moved" all 56 V4 pools. This file replaces that.
// ============================================================================
use std::collections::HashMap;

use revm::primitives::{keccak256, Address, B256, U256};

/// The V4 PoolManager's `_pools` mapping slot.
pub const V4_POOLS_SLOT: u8 = 6;
/// Struct fields counted after a mapping entry (TickInfo / Position.State: 3).
const ENTRY_FIELDS: u64 = 3;
/// Declared variables of a non-V4 pool: slots below this.
const DECLARED_MAX: u64 = 1 << 32;
/// Most slot kinds reported per pool (debug field).
pub const MAX_KINDS: usize = 4;

/// A pool copy 2 follows, as the bot names it.
#[derive(Clone, Debug)]
pub struct FollowedPool {
    /// The bot's key: V4 pool id, else the pool contract address (lowercase hex).
    pub key: String,
    /// The pool contract (V4: the PoolManager).
    pub address: Address,
    pub v4_id: Option<B256>,
}

/// One moved pool and which kinds of its values changed (debug, at most MAX_KINDS).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MovedPool {
    pub key: String,
    pub kinds: Vec<String>,
}

/// A V4 pool's base slot: keccak(id . 6).
pub fn v4_base(id: B256) -> U256 {
    let mut b = [0u8; 64];
    b[..32].copy_from_slice(id.as_slice());
    b[63] = V4_POOLS_SLOT;
    U256::from_be_bytes(keccak256(b).0)
}

/// The pools in `pools` that `changed` moved (see the file header), sorted
/// by key. `hashes`: (hash, first word, second word) of every 64-byte hash
/// the transaction computed.
pub fn moved_pools(changed: &[(Address, U256)], hashes: &[(U256, U256, U256)], pools: &[FollowedPool]) -> Vec<MovedPool> {
    if changed.is_empty() {
        return Vec::new();
    }
    MovedIndex::build(pools).moved(changed, hashes)
}

/// The lookup tables `moved_pools` needs, built ONCE per copy-2 registry
/// change (copy2/checkcore.rs, speed-3) instead of for every question
/// (~650 pools, one hash per V4 pool each time). Same answers as
/// `moved_pools` (it is now just "build, then look up").
#[derive(Default)]
pub struct MovedIndex {
    /// V4: (PoolManager, slot) -> (pool index, kind) for the fixed fields,
    direct: HashMap<(Address, U256), (usize, &'static str)>,
    /// and (PoolManager, mapping slot) -> (pool index, kind) for the mappings.
    parent: HashMap<(Address, U256), (usize, &'static str)>,
    /// Other pools: contract address -> pool index.
    by_addr: HashMap<Address, usize>,
    /// Pool index -> the bot's key.
    keys: Vec<String>,
}

impl MovedIndex {
    pub fn build(pools: &[FollowedPool]) -> MovedIndex {
        let mut x = MovedIndex { keys: pools.iter().map(|p| p.key.clone()).collect(), ..Default::default() };
        for (i, p) in pools.iter().enumerate() {
            match p.v4_id {
                Some(id) => {
                    let b = v4_base(id);
                    for (k, kind) in [(0u64, "slot0"), (1, "fees"), (2, "fees"), (3, "liquidity")] {
                        x.direct.insert((p.address, b + U256::from(k)), (i, kind));
                    }
                    for (k, kind) in [(4u64, "ticks"), (5, "bitmap"), (6, "positions")] {
                        x.parent.insert((p.address, b + U256::from(k)), (i, kind));
                    }
                }
                None => {
                    x.by_addr.insert(p.address, i);
                }
            }
        }
        x
    }

    /// See `moved_pools`.
    pub fn moved(&self, changed: &[(Address, U256)], hashes: &[(U256, U256, U256)]) -> Vec<MovedPool> {
        if changed.is_empty() {
            return Vec::new();
        }
        let (direct, parent, by_addr) = (&self.direct, &self.parent, &self.by_addr);
        // Hash -> its mapping slot (second word), for the hashes the run made.
        let pre: HashMap<U256, U256> = hashes.iter().map(|(h, _, slot)| (*h, *slot)).collect();
        let mut hits: HashMap<usize, Vec<String>> = HashMap::new();
        let mut note = |i: usize, kind: String| {
            let v = hits.entry(i).or_default();
            // (kept small: the pool counts anyway, the kinds are for the log)
            if !v.contains(&kind) && v.len() < MAX_KINDS {
                v.push(kind);
            }
        };
        for (a, s) in changed {
            if let Some((i, kind)) = direct.get(&(*a, *s)) {
                note(*i, (*kind).to_string());
                continue;
            }
            // A mapping entry (or one of its struct fields) of a V4 pool.
            let mut found = false;
            for off in 0..ENTRY_FIELDS {
                let Some(h) = s.checked_sub(U256::from(off)) else { break };
                if let Some(slot) = pre.get(&h) {
                    if let Some((i, kind)) = parent.get(&(*a, *slot)) {
                        note(*i, (*kind).to_string());
                        found = true;
                        break;
                    }
                }
            }
            if found {
                continue;
            }
            // Another pool's own declared variable.
            if let Some(i) = by_addr.get(a) {
                if *s < U256::from(DECLARED_MAX) {
                    note(*i, format!("s{}", s.to::<u64>()));
                }
            }
        }
        let mut out: Vec<MovedPool> = hits
            .into_iter()
            .map(|(i, mut kinds)| {
                kinds.sort();
                MovedPool { key: self.keys[i].clone(), kinds }
            })
            .collect();
        out.sort_by(|x, y| x.key.cmp(&y.key));
        out
    }
}
