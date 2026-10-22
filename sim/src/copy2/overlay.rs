// ============================================================================
// COPY 2 OVERLAY: the "working copy" one block's pool events are applied to.
//
// Plain English:
//   While the intake (copy2/intake.rs) works through one block's events it
//   needs a copy of our pools' state it can CHANGE: write the new reserves
//   from a Sync event, or let the replayer (copy2/replay.rs) re-run a swap
//   with the pool's own code and keep what that changed.
//
//   `Overlay` is that working copy. It starts as a cheap copy of the last
//   published snapshot (the maps are "persistent": copying is a pointer
//   copy, only changed branches are duplicated), takes changes, and when the
//   block is done the intake freezes it into the next published Version.
//
//   Reading follows the SAME strict rule as everywhere else: a slot we never
//   loaded is MISSING (Lookup::Missing), never zero. The overlay implements
//   `StateRead`, so the replayer can run revm on it with the existing
//   `state::db::ViewDb` (strict mode): a miss stops the run with
//   `DbMiss::Miss(item)` and the replayer answers
//   `ApplyResult::NeedItems(vec![item])`; the intake fetches the item from
//   the node and tries the event again.
//
//   Every change is also written into `changes` (one StateDiff per block),
//   which is what late fills use to carry an old node value forward
//   (state/fill.rs), exactly like copy 1's per-block diffs.
//
//   Try-and-throw-away: `fork()` gives an independent copy (cheap). The
//   replayer can run on a fork, check the result against the event's own
//   numbers, and only then `commit()` the diff onto the real overlay.
//
// INTERFACE FOR WORKSTREAM B (keep stable; extend, don't change):
//   Overlay: StateRead                 strict reads (Missing is never zero)
//   Overlay::commit(&mut self, &StateDiff)      keep a set of changes
//   Overlay::set_slot(&mut self, Address, U256, U256)   one slot
//   Overlay::put_account(&mut self, Address, Option<AccountInfo>, Option<Bytecode>)
//                                      scratch-only helper accounts (on a fork)
//   Overlay::fork(&self) -> Overlay    independent scratch copy
//   Overlay::slot(&self, Address, U256) -> Lookup<U256>   convenience read
// ============================================================================
use std::sync::Arc;

use revm::primitives::{Address, B256, U256};
use revm::state::{AccountInfo, Bytecode};

use crate::state::diff::merge;
use crate::state::snap::{Fact, Snapshot};
use crate::state::{AccountDiff, Lookup, StateDiff, StatePosition, StateRead};

/// A changeable copy of our pools' state for one block (see file header).
#[derive(Clone, Debug)]
pub struct Overlay {
    /// The state as it stands now (base + every change so far).
    snap: Snapshot,
    /// Everything changed since `new` (for late-fill carry-forward).
    changes: StateDiff,
    /// Slots made unknown since `new` (forget_slot), so `absorb` can repeat it.
    forgot: Vec<(Address, U256)>,
}

impl Overlay {
    /// Start from a frozen snapshot (usually the head version's).
    pub fn new(base: Snapshot) -> Self {
        Overlay { snap: base, changes: StateDiff::default(), forgot: Vec::new() }
    }

    /// Start from a shared frozen snapshot (cheap: persistent maps).
    pub fn from_arc(base: &Arc<Snapshot>) -> Self {
        Overlay::new((**base).clone())
    }

    /// An independent scratch copy (changes to it don't affect `self`).
    pub fn fork(&self) -> Overlay {
        Overlay { snap: self.snap.clone(), changes: StateDiff::default(), forgot: Vec::new() }
    }

    /// Take over everything a fork of this overlay did (changes AND
    /// forgotten slots).
    pub fn absorb(&mut self, fork: &Overlay) {
        self.commit(&fork.changes);
        for (a, s) in &fork.forgot {
            self.forget_slot(*a, *s);
        }
    }

    /// Slots made unknown since `new`.
    pub fn forgotten(&self) -> &[(Address, U256)] {
        &self.forgot
    }

    /// Keep a set of changes (e.g. what a replayed swap changed).
    pub fn commit(&mut self, diff: &StateDiff) {
        self.snap.apply_diff(diff);
        merge(&mut self.changes, diff);
    }

    /// Write one storage slot.
    pub fn set_slot(&mut self, addr: Address, slot: U256, value: U256) {
        let mut d = StateDiff::default();
        d.accounts.insert(addr, AccountDiff { storage: [(slot, value)].into_iter().collect(), ..Default::default() });
        self.commit(&d);
    }

    /// Put an account's basics (+ code). Meant for SCRATCH forks (the
    /// replayer's helper caller); on the real overlay it is recorded as a
    /// change like any other.
    pub fn put_account(&mut self, addr: Address, info: Option<AccountInfo>, code: Option<Bytecode>) {
        let mut d = StateDiff::default();
        d.accounts.insert(addr, AccountDiff { info: Some(info), code, ..Default::default() });
        self.commit(&d);
    }

    /// Learn a value fetched from the node (NOT a change made by the block:
    /// it is not recorded in `changes`).
    pub fn learn(&mut self, f: &Fact) {
        self.snap.apply_fact(f);
    }

    /// Drop everything known about one account (pool became unsure).
    pub fn forget(&mut self, addr: Address) {
        self.snap.apply_fact(&Fact::Forget(addr));
        self.changes.accounts.insert(addr, AccountDiff { forget: true, ..Default::default() });
    }

    /// Make ONE slot unknown again (we can't vouch for its value any more).
    /// If the account was "complete" (every unlisted slot is zero) we can't
    /// express "this one slot is unknown", so the whole account is dropped.
    /// (Not recorded in `changes`: copy 2 doesn't carry late fills through
    /// block changes, see intake.rs "fills".)
    pub fn forget_slot(&mut self, addr: Address, slot: U256) {
        self.forgot.push((addr, slot));
        if let Some(d) = self.changes.accounts.get_mut(&addr) {
            d.storage.remove(&slot);
        }
        let complete = self.snap.accounts.get(&addr).is_some_and(|a| a.storage_complete);
        if complete {
            self.forget(addr);
        } else if let Some(a) = self.snap.accounts.get_mut(&addr) {
            a.storage.remove(&slot);
        }
    }

    /// Read one slot (strict).
    pub fn slot(&self, addr: Address, slot: U256) -> Lookup<U256> {
        self.snap.storage(addr, slot)
    }

    /// Where this copy sits (block number of the events applied).
    pub fn set_position(&mut self, pos: StatePosition) {
        self.snap.pos = pos;
    }

    /// The state as it stands now.
    pub fn snapshot(&self) -> &Snapshot {
        &self.snap
    }

    /// Changes recorded since `new`.
    pub fn changes(&self) -> &StateDiff {
        &self.changes
    }

    /// Finish: (state, changes).
    pub fn into_parts(self) -> (Snapshot, StateDiff) {
        (self.snap, self.changes)
    }
}

impl StateRead for Overlay {
    fn account(&self, addr: Address) -> Lookup<Option<AccountInfo>> {
        self.snap.account(addr)
    }
    fn storage(&self, addr: Address, slot: U256) -> Lookup<U256> {
        self.snap.storage(addr, slot)
    }
    fn code_by_hash(&self, hash: B256) -> Lookup<Bytecode> {
        self.snap.code_by_hash(hash)
    }
    fn position(&self) -> StatePosition {
        self.snap.pos
    }
    fn balance_exact(&self, addr: Address) -> bool {
        self.snap.balance_exact(addr)
    }
    fn volatile(&self) -> Option<&crate::state::snap::Volatile> {
        Some(&self.snap.volatile)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_stays_missing_and_fork_is_isolated() {
        let a = Address::with_last_byte(1);
        let mut o = Overlay::new(Snapshot::default());
        assert_eq!(o.slot(a, U256::from(8)), Lookup::Missing);
        o.set_slot(a, U256::from(8), U256::from(5));
        assert_eq!(o.slot(a, U256::from(8)), Lookup::Known(U256::from(5)));
        // Neighbouring slot still missing (never zero).
        assert_eq!(o.slot(a, U256::from(9)), Lookup::Missing);
        let mut f = o.fork();
        f.set_slot(a, U256::from(8), U256::from(6));
        assert_eq!(o.slot(a, U256::from(8)), Lookup::Known(U256::from(5)));
        assert_eq!(f.slot(a, U256::from(8)), Lookup::Known(U256::from(6)));
        // Commit the fork's changes onto the real overlay.
        o.commit(f.changes());
        assert_eq!(o.slot(a, U256::from(8)), Lookup::Known(U256::from(6)));
        assert_eq!(o.changes().accounts[&a].storage[&U256::from(8)], U256::from(6));
    }
}
