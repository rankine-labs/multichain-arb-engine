// ============================================================================
// FILLS: fetch items our copy is missing, and fit them in correctly.
//
// Plain English:
//   1. QUEUE. Checks that said "unknown: miss" and `warm` requests put the
//      items they need here (no duplicates, capped size; extra items are
//      dropped and counted). The updater thread (state/updater.rs) takes
//      them in batches when it isn't busy replaying blocks. Warm items are
//      also REMEMBERED (capped), so they're fetched again after a restart of
//      the copy, and their accounts are never evicted.
//
//   2. LATE-FILL RECONCILIATION. The node is usually a block or two behind
//      the feed, so a value is fetched "as of block k" while our copy is
//      already at block B > k. We keep the last ~64 blocks of changes; the
//      fetched value is carried forward through blocks k+1..B (if a block
//      changed the item, the block's value wins) and then written into
//      every kept version from k on (and the per-transaction states inside
//      them). Nothing is ever overwritten that a version already knows
//      exactly (except approximate ETH balances, which a fresh exact value
//      replaces). If the changes since k are no longer kept, the value is
//      dropped (and the item simply asked for again later).
// ============================================================================
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use revm::primitives::{keccak256, Address, U256, KECCAK_EMPTY};
use revm::state::{AccountInfo, Bytecode};
use rustc_hash::FxHashSet;

use super::mirror::Version;
use super::snap::{normalize, Acct, Basics, Snapshot};
use super::{MissItem, StateDiff};
use crate::node::{Fetched, FetchedAccount};

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------
/// Items waiting to be fetched, plus the remembered warm set.
pub struct FillQueue {
    inner: Mutex<QueueInner>,
    cap: usize,
    max_warm: usize,
}

#[derive(Default)]
struct QueueInner {
    queue: VecDeque<MissItem>,
    queued: FxHashSet<MissItem>,
    warm: FxHashSet<MissItem>,
    warm_accounts: FxHashSet<Address>,
    dropped: u64,
}

impl FillQueue {
    pub fn new(cap: usize, max_warm: usize) -> Self {
        FillQueue { inner: Mutex::new(QueueInner::default()), cap: cap.max(16), max_warm }
    }

    /// Queue items (duplicates ignored). Returns how many were added.
    pub fn push(&self, items: impl IntoIterator<Item = MissItem>) -> usize {
        let mut g = self.inner.lock().unwrap();
        let mut n = 0;
        for it in items {
            if matches!(it, MissItem::Code(_)) || g.queued.contains(&it) {
                continue; // code can't be fetched by hash; already queued
            }
            if g.queue.len() >= self.cap {
                g.dropped += 1;
                continue;
            }
            g.queued.insert(it.clone());
            g.queue.push_back(it);
            n += 1;
        }
        n
    }

    /// Queue AND remember (warm requests). Returns how many were queued.
    pub fn warm(&self, items: Vec<MissItem>) -> usize {
        {
            let mut g = self.inner.lock().unwrap();
            for it in &items {
                if g.warm.len() >= self.max_warm {
                    break;
                }
                if let MissItem::Account(a) | MissItem::Slot(a, _) = it {
                    g.warm_accounts.insert(*a);
                }
                g.warm.insert(it.clone());
            }
        }
        self.push(items)
    }

    /// Re-queue every remembered warm item (after a restart of the copy).
    pub fn requeue_warm(&self) -> usize {
        let items: Vec<MissItem> = self.inner.lock().unwrap().warm.iter().cloned().collect();
        self.push(items)
    }

    /// Take up to `n` items.
    pub fn take(&self, n: usize) -> Vec<MissItem> {
        let mut g = self.inner.lock().unwrap();
        let k = n.min(g.queue.len());
        let out: Vec<MissItem> = g.queue.drain(..k).collect();
        for it in &out {
            g.queued.remove(it);
        }
        out
    }

    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().queue.len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    pub fn dropped(&self) -> u64 {
        self.inner.lock().unwrap().dropped
    }
    /// Is this account on the bot's warm list (never evicted)?
    pub fn is_warm_account(&self, a: &Address) -> bool {
        self.inner.lock().unwrap().warm_accounts.contains(a)
    }
    pub fn warm_accounts(&self) -> FxHashSet<Address> {
        self.inner.lock().unwrap().warm_accounts.clone()
    }
    pub fn warm_len(&self) -> usize {
        self.inner.lock().unwrap().warm.len()
    }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------
/// One fetched value being carried forward block by block.
#[derive(Clone, Debug)]
enum Carry {
    /// No longer valid (a block made the account unknown).
    Void,
    Slot { a: Address, s: U256, v: U256 },
    /// Basics (None = empty account), code, and whether the balance is
    /// still exact after the blocks it was carried through.
    Basics { a: Address, info: Option<AccountInfo>, code: Option<Bytecode>, exact: bool },
}

impl Carry {
    fn from_fetched(f: &Fetched) -> Carry {
        match f {
            Fetched::Slot(a, s, v) => Carry::Slot { a: *a, s: *s, v: *v },
            Fetched::Account(a, acc) => {
                let (info, code) = account_info(acc.as_ref());
                Carry::Basics { a: *a, info, code, exact: true }
            }
        }
    }

    /// Move the value through one block's (or one tx's) changes.
    fn advance(&mut self, d: &StateDiff) {
        let acct = match self {
            Carry::Void => return,
            Carry::Slot { a, .. } | Carry::Basics { a, .. } => *a,
        };
        if d.accounts.get(&acct).is_some_and(|x| x.forget) {
            *self = Carry::Void;
            return;
        }
        match self {
            Carry::Void => {}
            Carry::Slot { a, s, v } => {
                if let Some(x) = d.accounts.get(a) {
                    if let Some(nv) = x.storage.get(s) {
                        *v = *nv;
                    } else if x.storage_cleared || matches!(x.info, Some(None)) {
                        *v = U256::ZERO;
                    }
                }
            }
            Carry::Basics { a, info, code, exact } => {
                if let Some(x) = d.accounts.get(a) {
                    if let Some(ni) = &x.info {
                        *info = ni.clone();
                        if x.code.is_some() {
                            *code = x.code.clone();
                        }
                        *exact = *exact && !x.balance_inexact;
                    } else if x.balance_inexact {
                        *exact = false;
                    }
                }
            }
        }
    }

    /// Write the value into a snapshot unless it already knows it exactly.
    fn learn(&self, snap: &mut Snapshot) -> bool {
        match self {
            Carry::Void => false,
            Carry::Slot { a, s, v } => {
                let known = snap.accounts.get(a).is_some_and(|x| x.storage.contains_key(s) || x.storage_complete);
                if known {
                    return false;
                }
                snap.accounts.entry(*a).or_insert_with(Acct::default).storage.insert(*s, *v);
                true
            }
            Carry::Basics { a, info, code, exact } => {
                let cur = snap.accounts.get(a);
                // Known exactly = basics known, balance exact, and the code
                // body present (basics without code are useless).
                let known_exact = cur.is_some_and(|x| match &x.basics {
                    Basics::Known(Some(i)) => {
                        x.balance_exact && (i.code_hash == KECCAK_EMPTY || i.code_hash.is_zero() || snap.codes.contains_key(&i.code_hash))
                    }
                    Basics::Known(None) => true,
                    Basics::Unknown => false,
                });
                if known_exact {
                    return false;
                }
                // Same shape as Snapshot::apply_fact: no code body inside
                // the basics (it lives in the code map, by hash). A body left
                // in (revm's AccountInfo::default() puts an EMPTY one there)
                // is used by the EVM as is: a contract would run as code-less.
                let info = normalize(info.clone());
                if let (Some(i), Some(c)) = (&info, code) {
                    snap.put_code(i.code_hash, c.clone());
                }
                let acct = snap.accounts.entry(*a).or_insert_with(Acct::default);
                acct.basics = Basics::Known(info.clone());
                acct.balance_exact = *exact;
                if info.is_none() {
                    // Doesn't exist: every slot is zero.
                    acct.storage = Default::default();
                    acct.storage_complete = true;
                }
                true
            }
        }
    }
}

/// Fetched account -> (basics without code body, analysed code).
pub fn account_info(acc: Option<&FetchedAccount>) -> (Option<AccountInfo>, Option<Bytecode>) {
    match acc {
        None => (None, None),
        Some(f) => {
            let (hash, code) = if f.code.is_empty() {
                (KECCAK_EMPTY, None)
            } else {
                (keccak256(&f.code), Some(Bytecode::new_raw(f.code.clone())))
            };
            // `code: None` explicitly: AccountInfo::default() carries an EMPTY
            // code body, which the EVM would run instead of the real code.
            (Some(AccountInfo { balance: f.balance, nonce: f.nonce, code_hash: hash, code: None, ..Default::default() }), code)
        }
    }
}

/// Result of fitting fetched values into the kept versions.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct FillResult {
    /// Values written into at least the newest version.
    pub applied: usize,
    /// Values the newest version already knew.
    pub already_known: usize,
    /// Values dropped: the changes since block k are no longer kept, or a
    /// later block made the account unknown.
    pub too_old: usize,
}

/// Fit values fetched at block `k` into `versions` (oldest first), see the
/// file header. Rebuilds the affected versions in place.
pub fn reconcile(versions: &mut VecDeque<Arc<Version>>, k: u64, fetched: &[Fetched]) -> FillResult {
    let mut res = FillResult::default();
    if fetched.is_empty() {
        return res;
    }
    // Versions from block k on. We need block k itself (or an older one) to
    // be kept, otherwise the changes between k and the oldest kept are unknown.
    let Some(start) = versions.iter().position(|v| v.block >= k) else {
        // Everything kept is older than k: the node is AHEAD of our copy.
        // A value from the future can't be used.
        res.too_old = fetched.len();
        return res;
    };
    if versions[start].block > k {
        res.too_old = fetched.len();
        return res;
    }
    let mut carry: Vec<Carry> = fetched.iter().map(Carry::from_fetched).collect();
    let n = versions.len();
    let mut newest_learned = vec![false; carry.len()];
    for i in start..n {
        let v = versions[i].clone();
        if v.block > k && v.restart {
            // A restart point: nothing older than it can be carried across.
            break;
        }
        let mut txs = v.txs.clone();
        if v.block > k {
            if txs.is_empty() {
                for c in carry.iter_mut() {
                    c.advance(&v.diff);
                }
            } else {
                for t in txs.iter_mut() {
                    let mut s = (*t.snap).clone();
                    let mut any = false;
                    for c in carry.iter_mut() {
                        c.advance(&t.diff);
                        any |= c.learn(&mut s);
                    }
                    if any {
                        t.snap = Arc::new(s);
                    }
                }
            }
        }
        let mut s = (*v.snap).clone();
        let mut any = false;
        for (j, c) in carry.iter().enumerate() {
            let l = c.learn(&mut s);
            any |= l;
            if i == n - 1 {
                newest_learned[j] = l;
            }
        }
        if any || txs.iter().zip(v.txs.iter()).any(|(a, b)| !Arc::ptr_eq(&a.snap, &b.snap)) {
            versions[i] = Arc::new(Version { snap: Arc::new(s), txs, ..(*v).clone() });
        }
    }
    for (l, c) in newest_learned.into_iter().zip(carry.iter()) {
        if matches!(c, Carry::Void) {
            res.too_old += 1;
        } else if l {
            res.applied += 1;
        } else {
            res.already_known += 1;
        }
    }
    res
}

/// Apply an authoritative per-account change to every version from block
/// `from` on (e.g. "forget this account": verification found it wrong).
pub fn rewrite_from(versions: &mut VecDeque<Arc<Version>>, from: u64, f: impl Fn(&mut Snapshot)) {
    for i in 0..versions.len() {
        if versions[i].block < from {
            continue;
        }
        let v = versions[i].clone();
        let mut s = (*v.snap).clone();
        f(&mut s);
        let txs = v
            .txs
            .iter()
            .map(|t| {
                let mut ts = (*t.snap).clone();
                f(&mut ts);
                crate::feed::replay::TxSnap { hash: t.hash, snap: Arc::new(ts), diff: t.diff.clone() }
            })
            .collect();
        versions[i] = Arc::new(Version { snap: Arc::new(s), txs, ..(*v).clone() });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{AccountDiff, Lookup, StatePosition, StateRead};
    use std::collections::HashMap;
    use std::time::Instant;

    fn a(n: u8) -> Address {
        Address::with_last_byte(n)
    }

    fn version(block: u64, snap: Snapshot, diff: StateDiff) -> Arc<Version> {
        Arc::new(Version {
            seq: block,
            block,
            snap: Arc::new(Snapshot { pos: StatePosition { base_block: block, after_seq: Some(block) }, ..snap }),
            ctx: None,
            txs: vec![],
            diff: Arc::new(diff),
            restart: false,
            block_hash: None,
            applied: Instant::now(),
        })
    }

    fn slot_diff(acct: Address, s: u64, v: u64) -> StateDiff {
        let mut d = StateDiff::default();
        d.accounts.insert(acct, AccountDiff { storage: HashMap::from([(U256::from(s), U256::from(v))]), ..Default::default() });
        d
    }

    #[test]
    fn late_fill_is_carried_through_later_blocks() {
        // Blocks 10, 11, 12 kept. Block 11 changed slot 1 of a(1) to 50
        // (our copy didn't know the slot then, e.g. a node trace repaired it).
        let mut vs = VecDeque::new();
        vs.push_back(version(10, Snapshot::default(), StateDiff::default()));
        vs.push_back(version(11, Snapshot::default(), slot_diff(a(1), 1, 50)));
        vs.push_back(version(12, Snapshot::default(), StateDiff::default()));
        // Node answered at block 10: slot 1 = 7, slot 2 = 8.
        let fetched = vec![Fetched::Slot(a(1), U256::from(1), U256::from(7)), Fetched::Slot(a(1), U256::from(2), U256::from(8))];
        let r = reconcile(&mut vs, 10, &fetched);
        assert_eq!(r, FillResult { applied: 2, already_known: 0, too_old: 0 });
        assert_eq!(vs[0].snap.storage(a(1), U256::from(1)), Lookup::Known(U256::from(7)));
        assert_eq!(vs[1].snap.storage(a(1), U256::from(1)), Lookup::Known(U256::from(50)));
        assert_eq!(vs[2].snap.storage(a(1), U256::from(1)), Lookup::Known(U256::from(50)));
        assert_eq!(vs[2].snap.storage(a(1), U256::from(2)), Lookup::Known(U256::from(8)));
    }

    #[test]
    fn too_old_or_future_fills_are_dropped() {
        let mut vs = VecDeque::new();
        vs.push_back(version(20, Snapshot::default(), StateDiff::default()));
        let f = vec![Fetched::Slot(a(1), U256::from(1), U256::from(7))];
        assert_eq!(reconcile(&mut vs, 19, &f).too_old, 1); // older than kept
        assert_eq!(reconcile(&mut vs, 21, &f).too_old, 1); // node ahead of us
        assert_eq!(vs[0].snap.storage(a(1), U256::from(1)), Lookup::Missing);
    }

    #[test]
    fn known_values_are_not_overwritten_but_inexact_balances_are() {
        let mut s = Snapshot::default();
        s.apply_fact(&crate::state::snap::Fact::Slot(a(1), U256::from(1), U256::from(3)));
        s.apply_fact(&crate::state::snap::Fact::Basics {
            addr: a(2),
            info: Some(AccountInfo { balance: U256::from(100), nonce: 1, code_hash: KECCAK_EMPTY, ..Default::default() }),
            code: None,
        });
        s.accounts.get_mut(&a(2)).unwrap().balance_exact = false;
        let mut vs = VecDeque::from([version(5, s, StateDiff::default())]);
        let f = vec![
            Fetched::Slot(a(1), U256::from(1), U256::from(999)),
            Fetched::Account(a(2), Some(FetchedAccount { balance: U256::from(90), nonce: 1, code: Default::default() })),
        ];
        let r = reconcile(&mut vs, 5, &f);
        assert_eq!((r.applied, r.already_known), (1, 1));
        assert_eq!(vs[0].snap.storage(a(1), U256::from(1)), Lookup::Known(U256::from(3)));
        assert!(vs[0].snap.balance_exact(a(2)));
        assert_eq!(vs[0].snap.account(a(2)), Lookup::Known(Some(AccountInfo { balance: U256::from(90), nonce: 1, code_hash: KECCAK_EMPTY, ..Default::default() })));
    }

    /// Dry run (7a8a2e5 + d5a54b1): balanceOf on EIP-1967 proxy coins came
    /// back "success, empty output". The proxy's implementation only ever
    /// arrives through a fill, and a filled contract account was stored with
    /// `info.code = Some(empty)` (revm's AccountInfo::default() fills the
    /// code field with EMPTY bytecode, and AccountInfo's `==` ignores code,
    /// so nothing noticed). The EVM uses a code body it is handed and never
    /// looks the hash up: the implementation ran as an account WITHOUT code.
    #[test]
    fn filled_contract_account_keeps_its_code() {
        use revm::primitives::Bytes;
        let code = Bytes::from(vec![0x60, 0x2a, 0x60, 0x00, 0x52, 0x60, 0x20, 0x60, 0x00, 0xf3]); // return 42
        let mut vs = VecDeque::from([version(5, Snapshot::default(), StateDiff::default())]);
        let f = vec![Fetched::Account(a(9), Some(FetchedAccount { balance: U256::ZERO, nonce: 1, code: code.clone() }))];
        assert_eq!(reconcile(&mut vs, 5, &f).applied, 1);
        let snap = vs[0].snap.clone();
        let view = crate::state::snap::View::new(snap.clone());
        let Lookup::Known(Some(info)) = view.account(a(9)) else { panic!("filled account not known: {:?}", view.account(a(9))) };
        assert_eq!(info.code_hash, keccak256(&code));
        // Basics never carry a code body (it is looked up by hash): a body
        // here, even an empty one, would replace the real code in the EVM.
        assert!(info.code.is_none(), "basics carry a code body: {:?}", info.code);
        assert_eq!(view.code_by_hash(info.code_hash), Lookup::Known(Bytecode::new_raw(code.clone())));
        // And the EVM really runs it.
        let mut db = crate::state::db::ViewDb::new(&view);
        use revm::database_interface::Database;
        let got = db.basic(a(9)).unwrap().unwrap();
        assert_eq!(got.code.map(|c| c.original_bytes()), Some(code));
    }

    #[test]
    fn queue_dedupes_caps_and_remembers_warm() {
        let q = FillQueue::new(16, 100);
        assert_eq!(q.push(vec![MissItem::Account(a(1)), MissItem::Account(a(1))]), 1);
        assert_eq!(q.warm(vec![MissItem::Slot(a(2), U256::from(1))]), 1);
        assert!(q.is_warm_account(&a(2)));
        assert_eq!(q.take(10).len(), 2);
        assert_eq!(q.requeue_warm(), 1);
        for i in 0..40u8 {
            q.push(vec![MissItem::Account(Address::with_last_byte(100 + i))]);
        }
        assert_eq!(q.len(), 16);
        assert!(q.dropped() > 0);
    }
}
