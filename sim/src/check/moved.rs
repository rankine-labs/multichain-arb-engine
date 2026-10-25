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

// ============================================================================
// WHOSE POOLMANAGER VALUE IS THIS? (Oct 25, the "blind spot" fix)
//
// Plain English: live Oct 25 copy 2 refused ~39,000 PoolManager values that
// checks needed ("not a base slot of one of our V4 pools"), and nothing told
// us WHAT they were. A V4 storage place is a hash, so from the slot number
// alone we can't tell whose it is. But the check that missed it computed
// that hash a moment earlier, and the EVM run writes down the two input
// words of every 64-byte hash (check/ordered.rs record_hashes). Following
// those inputs backwards names the pool and the part:
//
//   slot = keccak(id . 6) + 0..3                  -> pool `id`, base field
//   slot = keccak(tick . P) + 0..2,  P = base+4   -> pool `id`, a tick
//   slot = keccak(word . P),         P = base+5   -> pool `id`, tick-map word
//   slot = keccak(key  . P) + 0..2,  P = base+6   -> pool `id`, a position
//   (base = keccak(id . 6), itself one of the recorded hashes)
//
// A hash value can only come from its own inputs, so this is never a guess:
// either the chain of inputs is there (then it is that pool), or we say
// "don't know".
// ============================================================================

/// Which part of a V4 pool's data a PoolManager slot is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum V4Part {
    /// base + 0..3: slot0 / fee growth 0 / fee growth 1 / liquidity.
    Base(u8),
    /// A tick's info (3 slots per tick).
    Tick,
    /// A tick-map (bitmap) word.
    Bitmap,
    /// A liquidity position (not needed for swaps).
    Position,
}

/// Hash -> its two input words (what the EVM run recorded).
pub type PreMap = HashMap<U256, (U256, U256)>;

/// Is `h` = keccak(id . 6), i.e. a V4 pool's base slot? Then the id.
fn base_id(h: U256, pre: &PreMap) -> Option<B256> {
    match pre.get(&h) {
        Some((id, six)) if *six == U256::from(V4_POOLS_SLOT) => Some(B256::from(id.to_be_bytes::<32>())),
        _ => None,
    }
}

/// Name the V4 pool (and which part of it) a PoolManager `slot` belongs to,
/// from the hash inputs a check recorded (see the section header). None =
/// the inputs aren't there (or it is not a pool's data: coin deltas,
/// ERC-6909 claims, settings, ...).
pub fn resolve_v4_slot(slot: U256, pre: &PreMap) -> Option<(B256, V4Part)> {
    // A mapping entry (tick / bitmap word / position) of some pool's base.
    for off in 0..ENTRY_FIELDS {
        let Some(h) = slot.checked_sub(U256::from(off)) else { break };
        let Some((_, parent)) = pre.get(&h) else { continue };
        for (k, part) in [(4u64, V4Part::Tick), (5, V4Part::Bitmap), (6, V4Part::Position)] {
            // A bitmap word is one slot (no struct fields after it).
            if part == V4Part::Bitmap && off != 0 {
                continue;
            }
            let Some(b) = parent.checked_sub(U256::from(k)) else { continue };
            if let Some(id) = base_id(b, pre) {
                return Some((id, part));
            }
        }
    }
    // One of the 4 base fields.
    for k in 0..4u8 {
        let Some(b) = slot.checked_sub(U256::from(k)) else { break };
        if let Some(id) = base_id(b, pre) {
            return Some((id, V4Part::Base(k)));
        }
    }
    None
}

/// The few recorded hash inputs needed to name `slots` (resolve_v4_slot):
/// those for slot - 0..3 and their parents' bases. Sent with a check's miss
/// answer (`missingPre`) so copy 2 can tell whose value it was, without
/// sending every hash the run made.
pub fn pre_for_slots(slots: impl IntoIterator<Item = U256>, pre: &PreMap) -> Vec<(U256, U256, U256)> {
    let mut out: Vec<(U256, U256, U256)> = Vec::new();
    let take = |h: U256, out: &mut Vec<(U256, U256, U256)>| -> Option<U256> {
        let (a, b) = pre.get(&h)?;
        if !out.iter().any(|x| x.0 == h) {
            out.push((h, *a, *b));
        }
        Some(*b)
    };
    for s in slots {
        for off in 0..4u64 {
            let Some(h) = s.checked_sub(U256::from(off)) else { break };
            if let Some(parent) = take(h, &mut out) {
                for k in 4..=6u64 {
                    if let Some(b) = parent.checked_sub(U256::from(k)) {
                        take(b, &mut out);
                    }
                }
            }
        }
        // Keep the answer small whatever happens.
        if out.len() >= 256 {
            break;
        }
    }
    out.sort();
    out
}

#[cfg(test)]
mod v4_slot_tests {
    use super::*;

    fn h2(a: U256, b: U256) -> U256 {
        let mut x = [0u8; 64];
        x[..32].copy_from_slice(&a.to_be_bytes::<32>());
        x[32..].copy_from_slice(&b.to_be_bytes::<32>());
        U256::from_be_bytes(keccak256(x).0)
    }

    /// What a V4 swap's EVM run would record for pool `id`: its base hash,
    /// one tick and one bitmap word.
    fn recorded(id: B256, tick: U256, word: U256) -> (PreMap, U256, U256, U256) {
        let idw = U256::from_be_bytes(id.0);
        let base = h2(idw, U256::from(6u8));
        assert_eq!(base, v4_base(id));
        let tick_slot = h2(tick, base + U256::from(4u8));
        let word_slot = h2(word, base + U256::from(5u8));
        let mut pre = PreMap::new();
        pre.insert(base, (idw, U256::from(6u8)));
        pre.insert(tick_slot, (tick, base + U256::from(4u8)));
        pre.insert(word_slot, (word, base + U256::from(5u8)));
        (pre, base, tick_slot, word_slot)
    }

    #[test]
    fn names_ticks_bitmap_words_and_base_fields() {
        let id = B256::repeat_byte(0x42);
        let (pre, base, tick_slot, word_slot) = recorded(id, U256::from(887_000u64), U256::from(3000u64));
        assert_eq!(resolve_v4_slot(tick_slot, &pre), Some((id, V4Part::Tick)));
        // The 2nd and 3rd field of the tick's struct are the same tick.
        assert_eq!(resolve_v4_slot(tick_slot + U256::from(2u8), &pre), Some((id, V4Part::Tick)));
        assert_eq!(resolve_v4_slot(word_slot, &pre), Some((id, V4Part::Bitmap)));
        assert_eq!(resolve_v4_slot(base + U256::from(3u8), &pre), Some((id, V4Part::Base(3))));
        // A slot whose inputs weren't recorded: "don't know", never a guess.
        assert_eq!(resolve_v4_slot(U256::from(12345u64), &pre), None);
        assert_eq!(resolve_v4_slot(word_slot + U256::from(1u8), &pre), None);
    }

    #[test]
    fn pre_for_slots_keeps_only_what_names_them() {
        let id = B256::repeat_byte(0x07);
        let (mut pre, _base, tick_slot, word_slot) = recorded(id, U256::from(5u8), U256::from(1u8));
        // Unrelated hashes the run also made (an ERC-20 balance, say).
        for i in 0..50u64 {
            pre.insert(h2(U256::from(i), U256::from(3u8)), (U256::from(i), U256::from(3u8)));
        }
        let small = pre_for_slots([tick_slot + U256::from(1u8)], &pre);
        assert_eq!(small.len(), 2, "the tick's hash and its pool's base");
        let m: PreMap = small.iter().map(|(h, a, b)| (*h, (*a, *b))).collect();
        assert_eq!(resolve_v4_slot(tick_slot + U256::from(1u8), &m), Some((id, V4Part::Tick)));
        assert_eq!(resolve_v4_slot(word_slot, &m), None, "not asked for");
    }
}
