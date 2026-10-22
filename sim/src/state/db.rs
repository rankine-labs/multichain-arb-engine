// ============================================================================
// ViewDb: lets revm (the EVM engine) read our copy of the chain.
//
// Plain English:
//   revm asks a "database" for accounts, storage slots and contract code.
//   ViewDb answers from a StateRead view (a snapshot of our copy). Two modes
//   for an item the view doesn't have (MISSING):
//     strict  (default) stop the run with `DbMiss::Miss(item)`, so the
//             caller knows exactly what to fetch. Never invents a zero.
//     collect note the item, answer zero / "no account", and keep going, so
//             ONE run discovers many missing items. A collect-mode run is a
//             GUESS: its results must never be stored (feed/replay.rs throws
//             them away and only uses the list of what was missing / which
//             accounts were touched). Capped at MAX_COLLECT items.
//
//   `pretend`: account basics to answer for accounts the view doesn't have
//   (feed replay: the sender of a transaction the sequencer accepted is
//   known to have the right nonce and enough ETH, even if we never loaded it).
//
//   It never writes: everything a run changes stays inside revm's scratch
//   journal; the caller decides what to keep (state/diff.rs).
//
//   Used by: feed replay (feed/replay.rs). The check engine (check/) has its
//   own richer adapter (check::db::CheckDb, with request overrides) on the
//   same StateRead contract.
// ============================================================================
use revm::database_interface::{DBErrorMarker, Database, DatabaseRef};
use revm::primitives::{Address, StorageKey, StorageValue, B256, KECCAK_EMPTY, U256};
use revm::state::{AccountInfo, Bytecode};

use super::{Lookup, MissItem, StateRead};

/// Collect mode stops after this many missing items.
pub const MAX_COLLECT: usize = 64;

/// Why a read failed (aborts the current transaction).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DbMiss {
    /// This item is not in our copy (strict mode).
    Miss(MissItem),
    /// Collect mode: too many missing items, gave up.
    TooMany,
    /// BLOCKHASH of the chain itself: we keep no block hashes.
    BlockHash(u64),
}

impl std::fmt::Display for DbMiss {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DbMiss::Miss(m) => write!(f, "missing {m:?}"),
            DbMiss::TooMany => write!(f, "too many missing items"),
            DbMiss::BlockHash(n) => write!(f, "block hash {n} not kept"),
        }
    }
}
impl std::error::Error for DbMiss {}
impl DBErrorMarker for DbMiss {}

/// revm database over a state view.
pub struct ViewDb<'a> {
    pub view: &'a dyn StateRead,
    /// false = strict (stop at the first miss), true = collect.
    pub collect: bool,
    /// Missing items seen (collect mode), first-seen order, no duplicates.
    pub missing: Vec<MissItem>,
    /// Basics to answer for accounts the view doesn't have.
    pub pretend: Vec<(Address, AccountInfo)>,
}

impl<'a> ViewDb<'a> {
    /// Strict mode.
    pub fn new(view: &'a dyn StateRead) -> Self {
        ViewDb { view, collect: false, missing: Vec::new(), pretend: Vec::new() }
    }
    /// Collect mode.
    pub fn collecting(view: &'a dyn StateRead) -> Self {
        ViewDb { collect: true, ..ViewDb::new(view) }
    }

    fn miss<T>(&mut self, m: MissItem, guess: T) -> Result<T, DbMiss> {
        if !self.collect {
            return Err(DbMiss::Miss(m));
        }
        if !self.missing.contains(&m) {
            self.missing.push(m);
        }
        if self.missing.len() >= MAX_COLLECT {
            return Err(DbMiss::TooMany);
        }
        Ok(guess)
    }
}

impl Database for ViewDb<'_> {
    type Error = DbMiss;

    fn basic(&mut self, address: Address) -> Result<Option<AccountInfo>, DbMiss> {
        match self.view.account(address) {
            Lookup::Known(Some(mut info)) => {
                // Attach the code (saves revm a second lookup).
                if info.code.is_none() && info.code_hash != KECCAK_EMPTY {
                    match self.view.code_by_hash(info.code_hash) {
                        Lookup::Known(c) => info.code = Some(c),
                        Lookup::Missing => return self.miss(MissItem::Account(address), None),
                    }
                }
                Ok(Some(info))
            }
            Lookup::Known(None) => Ok(None),
            Lookup::Missing => {
                if let Some((_, i)) = self.pretend.iter().find(|(a, _)| *a == address) {
                    return Ok(Some(i.clone()));
                }
                self.miss(MissItem::Account(address), None)
            }
        }
    }

    fn code_by_hash(&mut self, code_hash: B256) -> Result<Bytecode, DbMiss> {
        if code_hash == KECCAK_EMPTY || code_hash == B256::ZERO {
            return Ok(Bytecode::default());
        }
        match self.view.code_by_hash(code_hash) {
            Lookup::Known(c) => Ok(c),
            Lookup::Missing => self.miss(MissItem::Code(code_hash), Bytecode::default()),
        }
    }

    fn storage(&mut self, address: Address, index: StorageKey) -> Result<StorageValue, DbMiss> {
        match self.view.storage(address, index) {
            Lookup::Known(v) => Ok(v),
            Lookup::Missing => self.miss(MissItem::Slot(address, index), U256::ZERO),
        }
    }

    fn block_hash(&mut self, number: u64) -> Result<B256, DbMiss> {
        Err(DbMiss::BlockHash(number))
    }
}

/// Read-only use (e.g. revm's WrapDatabaseRef): strict mode only.
impl DatabaseRef for ViewDb<'_> {
    type Error = DbMiss;
    fn basic_ref(&self, address: Address) -> Result<Option<AccountInfo>, DbMiss> {
        let mut s = ViewDb { view: self.view, collect: false, missing: Vec::new(), pretend: self.pretend.clone() };
        s.basic(address)
    }
    fn code_by_hash_ref(&self, code_hash: B256) -> Result<Bytecode, DbMiss> {
        ViewDb::new(self.view).code_by_hash(code_hash)
    }
    fn storage_ref(&self, address: Address, index: StorageKey) -> Result<StorageValue, DbMiss> {
        ViewDb::new(self.view).storage(address, index)
    }
    fn block_hash_ref(&self, number: u64) -> Result<B256, DbMiss> {
        Err(DbMiss::BlockHash(number))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::mem::MemState;

    #[test]
    fn strict_stops_collect_continues() {
        let mut s = MemState::default();
        let a = Address::with_last_byte(1);
        s.accounts.insert(a, AccountInfo::default());
        s.storage.entry(a).or_default().insert(U256::from(1), U256::from(5));
        let mut db = ViewDb::new(&s);
        assert_eq!(db.storage(a, U256::from(1)).unwrap(), U256::from(5));
        assert_eq!(db.storage(a, U256::from(2)), Err(DbMiss::Miss(MissItem::Slot(a, U256::from(2)))));
        let b = Address::with_last_byte(2);
        assert_eq!(db.basic(b), Err(DbMiss::Miss(MissItem::Account(b))));
        // Collect mode: guesses and remembers.
        let mut c = ViewDb::collecting(&s);
        assert_eq!(c.storage(a, U256::from(2)).unwrap(), U256::ZERO);
        assert_eq!(c.basic(b).unwrap(), None);
        assert_eq!(c.missing, vec![MissItem::Slot(a, U256::from(2)), MissItem::Account(b)]);
        // Pretend basics for a missing account.
        let mut p = ViewDb::new(&s);
        p.pretend.push((b, AccountInfo { nonce: 3, ..Default::default() }));
        assert_eq!(p.basic(b).unwrap().unwrap().nonce, 3);
    }
}
