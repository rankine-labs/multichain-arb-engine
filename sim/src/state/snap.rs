// ============================================================================
// SNAPSHOT: one frozen version of our copy of the chain.
//
// Plain English:
//   A Snapshot is "everything we know about the chain at one moment" (after
//   feed message N, or after one transaction inside it). It never changes
//   once made, so any number of checks can read it at the same time while
//   the mirror builds the next one.
//
//   Making the next version is cheap: the maps are "persistent" (imbl), so a
//   new version shares everything that didn't change with the old one and
//   only copies the few branches that did. Holding 64 recent versions costs
//   roughly one copy plus the changes, not 64 copies.
//
//   Per account we keep:
//     basics   balance / nonce / code hash, or Unknown (never loaded)
//     balance_exact   false after the account paid gas fees in our replay
//                     (we replay without fees, see feed/replay.rs), so its
//                     ETH balance is only approximately right
//     storage  the slots we know; anything not listed is MISSING, unless
//              `storage_complete` (the account was created in front of us or
//              doesn't exist, so every unlisted slot is really zero)
//
//   Some accounts change in every block in ways we can't replay (ArbOS's own
//   bookkeeping account, the block "coinbase"): those are VOLATILE and always
//   answer Missing, so nothing ever relies on a stale copy of them.
// ============================================================================
use std::sync::Arc;

use imbl::shared_ptr::DefaultSharedPtr;
use revm::primitives::{Address, B256, KECCAK_EMPTY, U256};
use revm::state::{AccountInfo, Bytecode};
use rustc_hash::{FxBuildHasher, FxHashSet};

use super::{AccountDiff, Lookup, StateDiff, StatePosition, StateRead};

/// Persistent hash map with a fast hasher.
pub type PMap<K, V> = imbl::GenericHashMap<K, V, FxBuildHasher, DefaultSharedPtr>;

/// What we know about one account's basics.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Basics {
    /// Never loaded: Missing.
    Unknown,
    /// Known: None = the account doesn't exist (empty). The info never
    /// carries code (code lives in the code map, by hash).
    Known(Option<AccountInfo>),
}

/// One account in a snapshot.
#[derive(Clone, Debug)]
pub struct Acct {
    pub basics: Basics,
    /// false = the ETH balance is only approximate (see file header).
    pub balance_exact: bool,
    /// Known slots.
    pub storage: PMap<U256, U256>,
    /// true = every slot not in `storage` is zero (created / nonexistent).
    pub storage_complete: bool,
}

impl Default for Acct {
    fn default() -> Self {
        Acct { basics: Basics::Unknown, balance_exact: true, storage: PMap::default(), storage_complete: false }
    }
}

impl Acct {
    /// Does this account hold anything at all?
    pub fn is_empty_knowledge(&self) -> bool {
        self.basics == Basics::Unknown && self.storage.is_empty() && !self.storage_complete
    }
}

/// One fact learned from the node (exact at a given block).
#[derive(Clone, Debug)]
pub enum Fact {
    /// Account basics (None = doesn't exist). `code` given when known.
    Basics { addr: Address, info: Option<AccountInfo>, code: Option<Bytecode> },
    /// One storage slot.
    Slot(Address, U256, U256),
    /// Contract code by hash.
    Code(B256, Bytecode),
    /// The node's (or our exact replay's) change to one account.
    Diff(Address, AccountDiff),
    /// Drop everything we know about this account (it may be stale).
    Forget(Address),
    /// Drop everything (resync from scratch). Code is kept (it never changes
    /// for a given hash).
    ForgetAll,
}

impl Fact {
    /// The account this fact is about (None = all accounts / code only).
    pub fn account(&self) -> Option<Address> {
        match self {
            Fact::Basics { addr, .. } | Fact::Slot(addr, _, _) | Fact::Diff(addr, _) | Fact::Forget(addr) => Some(*addr),
            Fact::Code(..) | Fact::ForgetAll => None,
        }
    }
}

/// Accounts that always answer Missing (see file header) - shared by all
/// snapshots of a mirror, and can grow while running (verification learns
/// fee receivers), hence the locks (uncontended reads cost ~20 ns).
#[derive(Debug, Default)]
pub struct Volatile {
    /// Basics AND storage are never trusted.
    whole: std::sync::RwLock<FxHashSet<Address>>,
    /// Only the ETH balance is never trusted (gas-fee receivers).
    balance: std::sync::RwLock<FxHashSet<Address>>,
}

impl Volatile {
    pub fn with_whole(addrs: &[Address]) -> Self {
        let v = Volatile::default();
        for a in addrs {
            v.add_whole(*a);
        }
        v
    }
    pub fn add_whole(&self, a: Address) {
        self.whole.write().unwrap().insert(a);
    }
    pub fn add_balance(&self, a: Address) -> bool {
        self.balance.write().unwrap().insert(a)
    }
    pub fn is_whole(&self, a: &Address) -> bool {
        self.whole.read().unwrap().contains(a)
    }
    pub fn is_balance(&self, a: &Address) -> bool {
        self.balance.read().unwrap().contains(a)
    }
    /// All volatile-balance accounts (for status).
    pub fn balance_list(&self) -> Vec<Address> {
        self.balance.read().unwrap().iter().copied().collect()
    }
}

/// A frozen version of our chain copy.
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub accounts: PMap<Address, Acct>,
    pub codes: PMap<B256, Bytecode>,
    pub pos: StatePosition,
    pub volatile: Arc<Volatile>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Snapshot { accounts: PMap::default(), codes: PMap::default(), pos: StatePosition::default(), volatile: Arc::new(Volatile::default()) }
    }
}

/// Is this "empty" in the EIP-161 sense (no balance, nonce or code)?
fn info_is_empty(i: &AccountInfo) -> bool {
    i.balance.is_zero() && i.nonce == 0 && (i.code_hash == KECCAK_EMPTY || i.code_hash == B256::ZERO)
}

/// Basics without the code body, empty -> None. Every write of basics into a
/// snapshot goes through this (apply_fact, apply_account_diff, fills).
pub fn normalize(info: Option<AccountInfo>) -> Option<AccountInfo> {
    info.and_then(|mut i| {
        if i.code_hash == B256::ZERO {
            i.code_hash = KECCAK_EMPTY;
        }
        i.code = None;
        i.account_id = None;
        if info_is_empty(&i) { None } else { Some(i) }
    })
}

impl Snapshot {
    pub fn new(volatile: Arc<Volatile>) -> Self {
        Snapshot { volatile, ..Default::default() }
    }

    /// Number of accounts / known slots / code entries (for status).
    pub fn counts(&self) -> (usize, usize, usize) {
        let slots = self.accounts.values().map(|a| a.storage.len()).sum();
        (self.accounts.len(), slots, self.codes.len())
    }

    /// Do we hold anything about this account (basics or any slot)?
    pub fn holds(&self, a: &Address) -> bool {
        self.accounts.get(a).is_some_and(|x| !x.is_empty_knowledge())
    }

    /// Do we hold any storage of this account (= we track it as a contract)?
    pub fn holds_storage(&self, a: &Address) -> bool {
        self.accounts.get(a).is_some_and(|x| !x.storage.is_empty())
    }

    /// Known slots of an account (for refetching).
    pub fn held_slots(&self, a: &Address) -> Vec<U256> {
        self.accounts.get(a).map(|x| x.storage.keys().copied().collect()).unwrap_or_default()
    }

    fn acct_mut(&mut self, a: Address) -> &mut Acct {
        self.accounts.entry(a).or_default()
    }

    /// Store code (pre-analysed) unless we already have it.
    pub fn put_code(&mut self, hash: B256, code: Bytecode) {
        if hash != KECCAK_EMPTY && !self.codes.contains_key(&hash) {
            self.codes.insert(hash, code);
        }
    }

    /// Apply one fact from the node (authoritative: overrides what we had).
    pub fn apply_fact(&mut self, f: &Fact) {
        match f {
            Fact::Basics { addr, info, code } => {
                let info = normalize(info.clone());
                if let (Some(i), Some(c)) = (&info, code) {
                    self.put_code(i.code_hash, c.clone());
                }
                let a = self.acct_mut(*addr);
                if info.is_none() {
                    // Doesn't exist -> no storage either.
                    a.storage = PMap::default();
                    a.storage_complete = true;
                }
                a.basics = Basics::Known(info);
                a.balance_exact = true;
            }
            Fact::Slot(addr, s, v) => {
                self.acct_mut(*addr).storage.insert(*s, *v);
            }
            Fact::Code(h, c) => self.put_code(*h, c.clone()),
            Fact::Diff(addr, ad) => self.apply_account_diff(*addr, ad),
            Fact::Forget(addr) => {
                self.accounts.remove(addr);
            }
            Fact::ForgetAll => {
                self.accounts = PMap::default();
            }
        }
    }

    /// Apply the changes one transaction made (our replay or the node's
    /// trace). Only changed fields are listed in a diff.
    pub fn apply_diff(&mut self, d: &StateDiff) {
        for (addr, ad) in &d.accounts {
            self.apply_account_diff(*addr, ad);
        }
    }

    pub fn apply_account_diff(&mut self, addr: Address, ad: &AccountDiff) {
        if ad.forget {
            self.accounts.remove(&addr);
            return;
        }
        if let (Some(Some(i)), Some(c)) = (&ad.info, &ad.code) {
            self.put_code(i.code_hash, c.clone());
        }
        let a = self.acct_mut(addr);
        if ad.storage_cleared {
            a.storage = PMap::default();
            a.storage_complete = true;
        }
        if let Some(info) = &ad.info {
            // Code hash "not given" (zero): keep the one we have.
            let mut info = info.clone();
            if let (Some(i), Basics::Known(Some(cur))) = (info.as_mut(), &a.basics) {
                if i.code_hash.is_zero() {
                    i.code_hash = cur.code_hash;
                }
            }
            // Still "not given" and we don't know the account's code: we
            // can't know its basics; leave them unknown (storage still applies).
            let code_unknown = info.as_ref().is_some_and(|i| i.code_hash.is_zero()) && !ad.storage_cleared;
            if code_unknown {
                a.basics = Basics::Unknown;
                for (s, v) in &ad.storage {
                    a.storage.insert(*s, *v);
                }
                return;
            }
            let info = normalize(info);
            if info.is_none() && !ad.storage_cleared {
                // Account removed (EIP-161 empty / self-destruct): its storage goes too.
                a.storage = PMap::default();
                a.storage_complete = true;
            }
            a.basics = Basics::Known(info);
            // Once approximate, a balance stays approximate until the node
            // gives us a fresh exact value (apply_fact).
            a.balance_exact = a.balance_exact && !ad.balance_inexact;
        } else if ad.balance_inexact {
            a.balance_exact = false;
        }
        for (s, v) in &ad.storage {
            a.storage.insert(*s, *v);
        }
    }

    /// Drop accounts until at most `max_slots` slots / `max_accounts`
    /// accounts remain, oldest-first by `age` (seconds since last use;
    /// bigger = older). `keep` accounts are never dropped. Returns how many
    /// accounts were dropped.
    pub fn evict(&mut self, max_accounts: usize, max_slots: usize, age: impl Fn(&Address) -> u64, keep: impl Fn(&Address) -> bool) -> usize {
        let (n_acc, n_slots, _) = self.counts();
        if n_acc <= max_accounts && n_slots <= max_slots {
            return 0;
        }
        let mut order: Vec<(u64, Address, usize)> =
            self.accounts.iter().filter(|(a, _)| !keep(a)).map(|(a, x)| (age(a), *a, x.storage.len())).collect();
        order.sort_by(|x, y| y.0.cmp(&x.0)); // oldest first
        let (mut acc, mut slots, mut dropped) = (n_acc, n_slots, 0);
        // Go down to 90% so we don't evict again right away.
        let (ta, ts) = (max_accounts * 9 / 10, max_slots * 9 / 10);
        for (_, a, n) in order {
            if acc <= ta && slots <= ts {
                break;
            }
            self.accounts.remove(&a);
            acc -= 1;
            slots -= n;
            dropped += 1;
        }
        dropped
    }

    // ---- lookups shared by both read modes ----
    fn lookup_account(&self, addr: Address, strict_balance: bool) -> Lookup<Option<AccountInfo>> {
        if self.volatile.is_whole(&addr) {
            return Lookup::Missing;
        }
        match self.accounts.get(&addr) {
            Some(Acct { basics: Basics::Known(i), balance_exact, .. }) => {
                if strict_balance && (!balance_exact || self.volatile.is_balance(&addr)) && i.is_some() {
                    return Lookup::Missing;
                }
                // Basics without their code body are useless to the EVM:
                // report the whole account missing so a fill fetches the code.
                if let Some(info) = i {
                    if info.code_hash != KECCAK_EMPTY && !info.code_hash.is_zero() && !self.codes.contains_key(&info.code_hash) {
                        return Lookup::Missing;
                    }
                }
                // Never hand out a code body inside the basics: the EVM
                // would run it as is (an empty one = a code-less contract)
                // instead of loading the code by hash.
                Lookup::Known(i.clone().map(|mut i| {
                    i.code = None;
                    i
                }))
            }
            _ => Lookup::Missing,
        }
    }

    fn lookup_storage(&self, addr: Address, slot: U256) -> Lookup<U256> {
        if self.volatile.is_whole(&addr) {
            return Lookup::Missing;
        }
        match self.accounts.get(&addr) {
            Some(a) => match a.storage.get(&slot) {
                Some(v) => Lookup::Known(*v),
                None if a.storage_complete => Lookup::Known(U256::ZERO),
                None => Lookup::Missing,
            },
            None => Lookup::Missing,
        }
    }

    fn lookup_code(&self, hash: B256) -> Lookup<Bytecode> {
        if hash == KECCAK_EMPTY || hash == B256::ZERO {
            return Lookup::Known(Bytecode::default());
        }
        match self.codes.get(&hash) {
            Some(c) => Lookup::Known(c.clone()),
            None => Lookup::Missing,
        }
    }

    fn exact_balance(&self, addr: Address) -> bool {
        if self.volatile.is_whole(&addr) || self.volatile.is_balance(&addr) {
            return false;
        }
        self.accounts.get(&addr).map_or(true, |a| a.balance_exact)
    }
}

/// Replay mode: approximate balances are served (fees aren't replayed, so a
/// sender's balance is a little high; the replay watches opcodes that READ a
/// balance and refuses those txs instead, see feed/replay.rs).
impl StateRead for Snapshot {
    fn account(&self, addr: Address) -> Lookup<Option<AccountInfo>> {
        self.lookup_account(addr, false)
    }
    fn storage(&self, addr: Address, slot: U256) -> Lookup<U256> {
        self.lookup_storage(addr, slot)
    }
    fn code_by_hash(&self, hash: B256) -> Lookup<Bytecode> {
        self.lookup_code(hash)
    }
    fn position(&self) -> StatePosition {
        self.pos
    }
    fn balance_exact(&self, addr: Address) -> bool {
        self.exact_balance(addr)
    }
}

/// Check mode: what the server hands to check::handle_call. An account
/// whose ETH balance is only approximate answers MISSING (so the check
/// says "unknown" and a fill fetches the exact value), never a guess.
/// It also notes which accounts a check used (keeps them from being evicted).
pub struct View {
    pub snap: Arc<Snapshot>,
    touched: std::sync::Mutex<Vec<Address>>,
}

impl View {
    pub fn new(snap: Arc<Snapshot>) -> Self {
        View { snap, touched: std::sync::Mutex::new(Vec::new()) }
    }
    /// Accounts the check looked at (deduplicated).
    pub fn take_touched(&self) -> Vec<Address> {
        let mut v = std::mem::take(&mut *self.touched.lock().unwrap());
        v.sort_unstable();
        v.dedup();
        v
    }
}

impl StateRead for View {
    fn account(&self, addr: Address) -> Lookup<Option<AccountInfo>> {
        if let Ok(mut t) = self.touched.lock() {
            if t.len() < 512 {
                t.push(addr);
            }
        }
        self.snap.lookup_account(addr, true)
    }
    fn storage(&self, addr: Address, slot: U256) -> Lookup<U256> {
        self.snap.lookup_storage(addr, slot)
    }
    fn code_by_hash(&self, hash: B256) -> Lookup<Bytecode> {
        self.snap.lookup_code(hash)
    }
    fn position(&self) -> StatePosition {
        self.snap.pos
    }
    fn balance_exact(&self, addr: Address) -> bool {
        self.snap.exact_balance(addr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn a(n: u8) -> Address {
        Address::with_last_byte(n)
    }
    fn info(bal: u64, nonce: u64) -> AccountInfo {
        AccountInfo { balance: U256::from(bal), nonce, code_hash: KECCAK_EMPTY, ..Default::default() }
    }

    #[test]
    fn unknown_is_missing_not_zero() {
        let mut s = Snapshot::default();
        assert_eq!(s.account(a(1)), Lookup::Missing);
        s.apply_fact(&Fact::Slot(a(1), U256::from(5), U256::from(7)));
        assert_eq!(s.storage(a(1), U256::from(5)), Lookup::Known(U256::from(7)));
        assert_eq!(s.storage(a(1), U256::from(6)), Lookup::Missing);
        // A nonexistent account: every slot is really zero.
        s.apply_fact(&Fact::Basics { addr: a(2), info: None, code: None });
        assert_eq!(s.account(a(2)), Lookup::Known(None));
        assert_eq!(s.storage(a(2), U256::from(9)), Lookup::Known(U256::ZERO));
    }

    #[test]
    fn versions_are_isolated() {
        let mut v1 = Snapshot::default();
        v1.apply_fact(&Fact::Slot(a(1), U256::from(1), U256::from(10)));
        let frozen = Arc::new(v1.clone());
        // Build the next version from the old one.
        let mut v2 = (*frozen).clone();
        let mut d = StateDiff::default();
        d.accounts.insert(a(1), AccountDiff { storage: HashMap::from([(U256::from(1), U256::from(11))]), ..Default::default() });
        v2.apply_diff(&d);
        assert_eq!(frozen.storage(a(1), U256::from(1)), Lookup::Known(U256::from(10)));
        assert_eq!(v2.storage(a(1), U256::from(1)), Lookup::Known(U256::from(11)));
    }

    #[test]
    fn cleared_storage_and_deleted_accounts() {
        let mut s = Snapshot::default();
        s.apply_fact(&Fact::Basics { addr: a(1), info: Some(info(5, 1)), code: None });
        s.apply_fact(&Fact::Slot(a(1), U256::from(1), U256::from(3)));
        // Diff: account removed.
        let mut d = StateDiff::default();
        d.accounts.insert(a(1), AccountDiff { info: Some(None), ..Default::default() });
        s.apply_diff(&d);
        assert_eq!(s.account(a(1)), Lookup::Known(None));
        assert_eq!(s.storage(a(1), U256::from(1)), Lookup::Known(U256::ZERO));
    }

    #[test]
    fn inexact_balance_is_missing_for_checks_only() {
        let mut s = Snapshot::default();
        s.apply_fact(&Fact::Basics { addr: a(1), info: Some(info(5, 1)), code: None });
        let mut d = StateDiff::default();
        d.accounts.insert(a(1), AccountDiff { info: Some(Some(info(4, 2))), balance_inexact: true, ..Default::default() });
        s.apply_diff(&d);
        let snap = Arc::new(s);
        assert!(matches!(snap.account(a(1)), Lookup::Known(Some(_)))); // replay mode
        let v = View::new(snap.clone());
        assert_eq!(v.account(a(1)), Lookup::Missing); // check mode
        assert_eq!(v.take_touched(), vec![a(1)]);
        // A fresh exact value from the node makes it usable again.
        let mut s2 = (*snap).clone();
        s2.apply_fact(&Fact::Basics { addr: a(1), info: Some(info(3, 2)), code: None });
        assert!(matches!(View::new(Arc::new(s2)).account(a(1)), Lookup::Known(Some(_))));
    }

    #[test]
    fn basics_never_hand_out_a_code_body() {
        // Even if some writer left a body inside the basics (revm's
        // AccountInfo::default() carries an EMPTY one), readers get none, so
        // the EVM loads the code by hash (or misses).
        let mut s = Snapshot::default();
        let h = revm::primitives::keccak256([0x60u8, 0x01]);
        let bad = AccountInfo { nonce: 1, code_hash: h, ..Default::default() };
        assert!(bad.code.is_some());
        s.accounts.insert(a(3), Acct { basics: Basics::Known(Some(bad)), ..Default::default() });
        assert_eq!(s.account(a(3)), Lookup::Missing); // code not held: missing
        s.put_code(h, Bytecode::new_raw(vec![0x60u8, 0x01].into()));
        match s.account(a(3)) {
            Lookup::Known(Some(i)) => assert!(i.code.is_none()),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn volatile_accounts_are_always_missing() {
        let mut s = Snapshot::new(Arc::new(Volatile::with_whole(&[a(9)])));
        s.apply_fact(&Fact::Slot(a(9), U256::from(1), U256::from(1)));
        assert_eq!(s.storage(a(9), U256::from(1)), Lookup::Missing);
    }

    #[test]
    fn eviction_keeps_warm_and_newest() {
        let mut s = Snapshot::default();
        for i in 1..=10u8 {
            s.apply_fact(&Fact::Slot(a(i), U256::from(1), U256::from(1)));
        }
        let dropped = s.evict(5, 1000, |x| x.0[19] as u64 * 0 + (20 - x.0[19] as u64), |x| *x == a(1));
        assert!(dropped >= 5);
        assert!(s.holds(&a(1))); // kept (warm) although oldest
        assert!(s.holds(&a(10))); // newest
    }
}
