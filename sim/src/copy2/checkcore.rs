// ============================================================================
// CHECK CORE: what a trade check needs to know about copy 2's pools, kept
// ready so a check never walks every pool and never waits for the copy's
// thread (copy2-q).
//
// Plain English (live Oct 22 20:00 after the copy2-p speed fix): the check's
// "facts" step took ~14 ms (bench: 0.5 ms). It read copy 2's pool registry
// under its lock, went through ALL ~650 pools for every check, and waited
// whenever the copy's thread held that lock (484 holds over 1 ms in 29
// minutes, the longest 197 ms).
//
// Now:
//   - The registry's lock counts its changes (timing.rs GenLock). A summary
//     of everything checks need (this file's CheckCore) is rebuilt only when
//     the registry changed, by the copy's own thread right after it changes
//     things (end of each work round, after each block) or, if a check finds
//     it outdated, by that check.
//   - The facts for a block (checkview.rs FactSets: V4 PoolManager bound
//     pools, far zero words, protocol-fee counters) are prebuilt once per
//     core for the blocks where every pool's "since when exact" rule gives
//     the same answer: from the newest such block (`stable_from`) up to the
//     first block a report may be missing for (`pending_min`). That is
//     every check at the newest blocks. A check about an older block gets
//     its own sets built from the core (no lock, ~V4 pools).
//   - "Reports may be missing" (pending), "pool not ready" (unsure_pool)
//     and the warm-up coin layouts also come from the core.
//   A core is used while the registry has not changed since it was built
//   (same change count), or by a check whose version comes from the very
//   readers' copy that was current when the core was built (that check is
//   then exactly one that came at that moment: picked its version, then
//   read the registry). Otherwise the check rebuilds it (waiting for the
//   registry only in that case). Same answers as reading the registry.
// ============================================================================
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use revm::primitives::{Address, U256};

use super::checkview::{memo_slot, merge_lists, protocol_fee_slot, FactSets};
use super::coins::BalanceLayout;
use super::intake::{kind_name, state_name, PoolState, Registry};
use super::{PoolKind, TrackedPool};

/// One V4 pool as the facts need it.
#[derive(Clone)]
pub struct V4Info {
    pub pool: TrackedPool,
    pub ready: bool,
    pub ready_since: u64,
    pub pending_from: Option<u64>,
    /// (walk block, far zero words) when the pool has a full walk.
    pub far: Option<(u64, Arc<Vec<U256>>)>,
}

/// The summary (see the header).
#[derive(Default)]
pub struct CheckCore {
    /// The registry's change count it was built from.
    pub gen: u64,
    /// The readers' copy of the published versions that was current when
    /// it was built (taken BEFORE reading the registry). A check that
    /// picked its version from this very copy may use this core even if
    /// the registry changed since: it is then exactly a check that came at
    /// the moment the core was built (picked that version, then read the
    /// registry), which is what checks always did.
    pub view: Option<Arc<crate::state::mirror::PubView>>,
    pub pm_bound: bool,
    pub v4: Vec<V4Info>,
    pub pm_list: Vec<Address>,
    pub fees: HashSet<(Address, U256)>,
    pub inject: HashMap<(Address, U256), (Address, Address)>,
    /// Facts for blocks in [stable_from, pending_min).
    pub common: Arc<FactSets>,
    pub stable_from: u64,
    pub pending_min: u64,
    /// Account (pool address / pool-owned account) -> pools at it with
    /// reports maybe missing: (kind, pool address, from block).
    pub pending: HashMap<Address, Vec<(PoolKind, Address, u64)>>,
    /// Every such pool (a check that touched too many accounts to list).
    pub any_pending: Vec<(PoolKind, Address, u64)>,
    /// Account -> why a pool at it isn't ready (first such pool).
    pub not_ready: HashMap<Address, String>,
    /// Coins with a known balance layout (check warm-up).
    pub layouts: Vec<(Address, BalanceLayout)>,
}

/// Far-zero merge cache: account -> (the per-pool lists, merged).
pub type FarCache = Mutex<HashMap<Address, (Vec<Arc<Vec<U256>>>, Arc<Vec<U256>>)>>;

impl CheckCore {
    /// Build from the registry (caller holds its read lock; `gen` read
    /// under that lock).
    pub fn build(reg: &Registry, gen: u64, view: Option<Arc<crate::state::mirror::PubView>>, far_cache: &FarCache) -> CheckCore {
        let mut c = CheckCore { gen, view, pm_bound: reg.pm_bound, ..Default::default() };
        let mut pms: HashSet<Address> = HashSet::new();
        for e in reg.pools.values() {
            // Pending / not ready, per account a check may touch.
            let mut accts = vec![e.pool.address];
            accts.extend(e.owned.iter().copied());
            if let Some(b) = e.pending_from {
                c.any_pending.push((e.pool.kind, e.pool.address, b));
                for a in &accts {
                    c.pending.entry(*a).or_default().push((e.pool.kind, e.pool.address, b));
                }
            }
            if e.state != PoolState::Ready {
                let why = format!("{} pool {} is {}: {}", kind_name(e.pool.kind), e.pool.address, state_name(e.state), e.reason);
                for a in &accts {
                    c.not_ready.entry(*a).or_insert_with(|| why.clone());
                }
            }
            if e.pool.kind != PoolKind::V4 {
                continue;
            }
            pms.insert(e.pool.address);
            for t in [e.pool.token0, e.pool.token1] {
                c.fees.insert((e.pool.address, protocol_fee_slot(t)));
                if t == Address::ZERO || !reg.pm_bound {
                    continue;
                }
                let memo = match reg.layouts.get(&t) {
                    Some(Some(l)) => l.preimage(e.pool.address).map(memo_slot),
                    _ => None,
                };
                if let Some(sl) = memo.or_else(|| reg.bal_slot(t, e.pool.address)) {
                    c.inject.insert((t, sl), (e.pool.address, t));
                }
            }
            let far = match (&e.far_zero, &e.walk) {
                (Some(fz), Some(_)) => Some((fz.block, fz.slots.clone())),
                _ => None,
            };
            c.v4.push(V4Info { pool: e.pool.clone(), ready: e.state == PoolState::Ready, ready_since: e.ready_since, pending_from: e.pending_from, far });
        }
        c.pm_list = pms.into_iter().collect();
        c.layouts = reg.layouts.iter().filter_map(|(a, l)| l.map(|l| (*a, l))).collect();
        // The range where every pool's rule answers like "all ready pools
        // count, nothing pending".
        c.stable_from = c
            .v4
            .iter()
            .filter(|i| i.ready)
            .map(|i| i.far.as_ref().map_or(i.ready_since, |(b, _)| (*b).max(i.ready_since)).max(i.ready_since))
            .max()
            .unwrap_or(0);
        c.pending_min = c.v4.iter().filter(|i| i.ready).filter_map(|i| i.pending_from).min().unwrap_or(u64::MAX);
        c.common = Arc::new(c.sets_at(None, far_cache));
        c
    }

    /// The facts sets for `block` (None = the common range, see header).
    /// Same rules as the old per-check build (intake.rs check_facts).
    pub fn sets_at(&self, block: Option<u64>, far_cache: &FarCache) -> FactSets {
        let mut f = FactSets { fees: self.fees.clone(), ..Default::default() };
        if !self.pm_bound {
            return f;
        }
        f.inject = self.inject.clone();
        for pm in &self.pm_list {
            f.pms.insert(*pm, Vec::new());
        }
        for i in &self.v4 {
            // Exact at this version: ready since then, nothing pending.
            let ok = match block {
                Some(b) => i.ready && i.ready_since <= b && !i.pending_from.is_some_and(|p| p <= b),
                None => i.ready,
            };
            if !ok {
                continue;
            }
            if let Some((fb, slots)) = &i.far {
                if block.is_none_or(|b| (*fb).max(i.ready_since) <= b) {
                    f.far.entry(i.pool.address).or_default().push(slots.clone());
                    if let Some(id) = i.pool.v4_id {
                        f.far_of.insert(id, slots.clone());
                    }
                }
            }
            f.pms.entry(i.pool.address).or_default().push(i.pool.clone());
        }
        // One merged far-zero list per account, reused while the same lists
        // apply (the cache holds the lists themselves, so "same" = the very
        // same lists, never a look-alike).
        {
            let mut cache = far_cache.lock().unwrap_or_else(|e| e.into_inner());
            for (a, lists) in &f.far {
                let hit = cache.get(a).filter(|(l, _)| l.len() == lists.len() && l.iter().zip(lists).all(|(x, y)| Arc::ptr_eq(x, y))).map(|(_, m)| m.clone());
                let merged = match hit {
                    Some(m) => m,
                    None => {
                        let m = merge_lists(lists);
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

    /// The sets for a check at `block`: the shared ones when they apply.
    pub fn sets_for(&self, block: u64, far_cache: &FarCache) -> Arc<FactSets> {
        if block >= self.stable_from && block < self.pending_min {
            self.common.clone()
        } else {
            Arc::new(self.sets_at(Some(block), far_cache))
        }
    }

    /// A pool at one of these accounts may still be missing reports of
    /// `block`: why (as intake.rs pending_reason).
    pub fn pending_reason(&self, touched: &[Address], block: u64, all: bool) -> Option<(PoolKind, Address, u64)> {
        if all {
            return self.any_pending.iter().find(|x| x.2 <= block).copied();
        }
        touched.iter().find_map(|a| self.pending.get(a).and_then(|v| v.iter().find(|x| x.2 <= block).copied()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::copy2::intake::{FarZero, PoolEntry, WalkInfo};
    use revm::primitives::B256;
    use std::time::Instant;

    fn entry(pool: TrackedPool) -> PoolEntry {
        PoolEntry {
            pool,
            state: PoolState::Loading,
            reason: String::new(),
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
        }
    }

    fn v4(n: u8) -> TrackedPool {
        let mut p = TrackedPool { address: Address::with_last_byte(9), v4_id: None, kind: PoolKind::V4, token0: Address::with_last_byte(1), token1: Address::with_last_byte(n), fee: 3000, tick_spacing: 60 };
        p.v4_id = Some(B256::with_last_byte(n));
        p
    }

    /// The shared sets equal a per-block build for every block in their
    /// range, and blocks outside it get their own (older ready_since /
    /// walk / pending rules).
    #[test]
    fn common_sets_equal_the_per_block_rules_in_their_range() {
        let mut reg = Registry { pm_bound: true, ..Default::default() };
        for (n, ready_since, walk_block, pending) in [(2u8, 100u64, 110u64, None), (3, 120, 105, Some(150u64)), (4, 90, 95, None)] {
            let p = v4(n);
            let mut e = entry(p.clone());
            e.state = PoolState::Ready;
            e.ready_since = ready_since;
            e.pending_from = pending;
            e.far_zero = Some(FarZero { block: walk_block, slots: Arc::new(vec![U256::from(n)]) });
            e.walk = Some(WalkInfo { block: walk_block, done: true, center: 0, word_lo: 0, word_hi: 0, ticks: 0, slots: 0 });
            reg.pools.insert((p.address, p.v4_id), e);
        }
        reg.layouts.insert(Address::with_last_byte(1), Some(BalanceLayout { slot: U256::ZERO, vyper: false, solady: false }));
        let fc: FarCache = Mutex::new(HashMap::new());
        let c = CheckCore::build(&reg, 7, None, &fc);
        assert_eq!((c.stable_from, c.pending_min), (120, 150));
        let key = |f: &FactSets| {
            let mut v: Vec<String> = f.pms.values().flatten().map(|p| format!("{:?}", p.v4_id)).collect();
            v.sort();
            let mut w: Vec<String> = f.far_merged.values().map(|l| format!("{l:?}")).collect();
            w.sort();
            (v, w, f.far_of.len(), f.bases.len(), f.inject.len(), f.fees.len())
        };
        for b in [120u64, 130, 149] {
            assert_eq!(key(&c.sets_for(b, &fc)), key(&c.sets_at(Some(b), &fc)), "block {b}");
            assert!(Arc::ptr_eq(&c.sets_for(b, &fc), &c.common));
        }
        // Outside: pool 3 not yet ready at 110; pending from 150.
        assert_eq!(c.sets_for(110, &fc).pms.values().flatten().count(), 2);
        assert_eq!(c.sets_for(150, &fc).pms.values().flatten().count(), 2);
        assert_eq!(c.sets_for(140, &fc).pms.values().flatten().count(), 3);
        assert!(c.pending_reason(&[Address::with_last_byte(9)], 149, false).is_none());
        assert!(c.pending_reason(&[Address::with_last_byte(9)], 150, false).is_some());
        assert!(c.pending_reason(&[], 150, true).is_some());
        assert_eq!(c.layouts.len(), 1);
    }
}
