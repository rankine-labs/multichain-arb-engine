// ============================================================================
// MEMORY BOUNDS (Nov 1): the two parts of arbsim that kept growing, before
// and after the fix, measured with a counting allocator.
//
// Plain English:
//   1. KEEPER VALUES. The hot-contract keeper (copy2/keeper.rs) adopts every
//      value a block writes in a contract it keeps. Live (Nov 1, 300 kept
//      contracts) that added ~13,000 values an hour and nothing ever left,
//      up to the 200,000 cap. FASTLANE_AHEAD_KEEP_PRUNE_BLOCKS drops the
//      adopted values that no run asked for and no block wrote for two
//      windows. This bench runs the real KeeperCore through a block stream
//      shaped like live (a few hot values rewritten every block, one brand
//      new value per block) with the prune off and on, and prints the
//      values held and the bytes they hold (current values + the 64 kept
//      versions).
//   2. COPY 2 CODES. Contract code was never dropped, also after its
//      account was evicted. CodeAging (state/snap.rs) drops a code unused
//      for ARBSIM_COPY2_CODE_PRUNE_S. This bench evicts accounts and shows
//      the bytes their codes held, before and after a sweep.
//   Printed with --nocapture; the asserts check the fix keeps its promise:
//   `cargo test --release --test memory_bounds -- --nocapture`
// ============================================================================
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use arbsim::copy2::keeper::{KeeperCfg, KeeperCore, SeedAnswer};
use arbsim::state::snap::{CodeAging, Fact, Snapshot};
use arbsim::state::{AccountDiff, MissItem, StateDiff};
use revm::primitives::{Address, Bytes, B256, U256};
use revm::state::{AccountInfo, Bytecode};

// ---------------------------------------------------------------------------
// Counting allocator: bytes this test binary holds right now.
// ---------------------------------------------------------------------------
struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            LIVE.fetch_add(l.size(), Ordering::Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        System.dealloc(p, l);
        LIVE.fetch_sub(l.size(), Ordering::Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        let q = System.realloc(p, l, new);
        if !q.is_null() {
            if new >= l.size() {
                LIVE.fetch_add(new - l.size(), Ordering::Relaxed);
            } else {
                LIVE.fetch_sub(l.size() - new, Ordering::Relaxed);
            }
        }
        q
    }
}

#[global_allocator]
static A: Counting = Counting;

/// One counter for the whole binary: the tests take turns.
static TURN: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn turn() -> std::sync::MutexGuard<'static, ()> {
    TURN.lock().unwrap_or_else(|e| e.into_inner())
}
fn live() -> usize {
    LIVE.load(Ordering::Relaxed)
}
fn mb(b: usize) -> f64 {
    (b as f64 / 1_048_576.0 * 10.0).round() / 10.0
}

fn addr(n: u64) -> Address {
    let mut b = [0u8; 20];
    b[12..].copy_from_slice(&n.to_be_bytes());
    Address::from(b)
}
/// Slot numbers spread like real hashed slots.
fn key(acct: u64, i: u64) -> U256 {
    U256::from(i.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (acct << 40)) << 64 | U256::from(i)
}
/// A small deterministic random stream (xorshift).
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

const CONTRACTS: u64 = 300;
const LEARNED_PER: u64 = 100;

/// A keeper holding CONTRACTS contracts with LEARNED_PER learned values
/// each (seeded), the way the live one runs (FASTLANE_AHEAD_KEEP_CONTRACTS=300).
fn keeper(prune_blocks: u64) -> KeeperCore {
    let mut k = KeeperCore::new(KeeperCfg { on: true, max_contracts: CONTRACTS as usize, prune_blocks, ..KeeperCfg::default() });
    k.start_at(1_000);
    let mut items = Vec::new();
    for c in 0..CONTRACTS {
        for i in 0..LEARNED_PER {
            items.push(MissItem::Slot(addr(0x1000 + c), key(c, i)));
        }
    }
    k.learn(&items);
    while let Some(j) = k.take_job() {
        let slots = j.slots.iter().map(|s| (*s, *s & U256::from(0xffff_ffffu64))).collect();
        k.on_seed(&j, Some(SeedAnswer { addr: j.addr, at: 1_000, basics: None, code: None, slots }));
    }
    k
}

/// One block shaped like live: 2 hot learned values rewritten, plus ONE
/// brand-new value in the PoolManager-like contract (adopted). Live Nov 1: ~13,000
/// new values an hour at ~34,800 blocks an hour = ~0.4 new per block; this
/// bench uses 1 per block (faster, worse than live).
fn block(rng: &mut Rng, b: u64) -> StateDiff {
    let mut d = StateDiff::default();
    for _ in 0..2 {
        let c = rng.next() % CONTRACTS;
        let i = rng.next() % LEARNED_PER;
        d.accounts.entry(addr(0x1000 + c)).or_insert_with(AccountDiff::default).storage.insert(key(c, i), U256::from(b));
    }
    // The brand-new value: a tick of someone else's V4 pool in the
    // PoolManager (contract 0 here), the contract that adopts the most.
    d.accounts.entry(addr(0x1000)).or_insert_with(AccountDiff::default).storage.insert(key(0, 1_000_000 + b), U256::from(b));
    d
}

/// Runs `blocks` blocks; returns (values held, bytes the keeper holds).
fn run(prune_blocks: u64, blocks: u64) -> (usize, usize, KeeperCore) {
    let before = live();
    let mut k = keeper(prune_blocks);
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    for b in 1_001..=1_000 + blocks {
        let d = block(&mut rng, b);
        k.apply_block(b, &[d]).unwrap();
    }
    let vals = k.held_counts().2;
    (vals, live().saturating_sub(before), k)
}

/// Copy 2 vouches for everything (the merge bench only measures memory).
struct All;
impl arbsim::check::ordered::Provenance for All {
    fn slot_exact(&self, _: Address, _: U256) -> bool {
        true
    }
    fn balance_exact(&self, _: Address) -> bool {
        true
    }
}

/// Copy 2's snapshot: its own 50,000 PoolManager values (our V4 pools).
fn copy2_with_pm() -> Snapshot {
    let mut s = Snapshot::default();
    let mut pm = arbsim::state::snap::Acct { basics: arbsim::state::snap::Basics::Known(Some(AccountInfo { nonce: 1, ..Default::default() })), ..Default::default() };
    for i in 0..50_000u64 {
        pm.storage.insert(key(0, 50_000_000 + i), U256::from(i + 1));
    }
    s.accounts.insert(addr(0x1000), pm);
    s
}

/// Bytes ONE merged base (copy 2 + the keeper's values, made for every
/// block the predicted copy starts from) holds on its own.
fn merge_bytes(k: &KeeperCore, c2: &Snapshot) -> usize {
    let kv = k.latest().unwrap();
    let before = live();
    let m = arbsim::copy2::keeper::merge_base(c2, &All, &kv).0;
    let b = live().saturating_sub(before);
    drop(m);
    b
}

/// Keeper values: with the prune they level off, without it they keep
/// growing (1 new PoolManager value per block for 40,000 blocks, ~70 min
/// of live blocks at the bench's 1 per block). The PoolManager's values are
/// laid over copy 2's in every merged base, so they also make every merge
/// bigger: that is where most of the memory goes.
#[test]
fn keeper_values_level_off_with_the_prune() {
    let _t = turn();
    const BLOCKS: u64 = 40_000;
    const WINDOW: u64 = 2_000;
    let learned = (CONTRACTS * LEARNED_PER) as usize;
    let c2 = copy2_with_pm();

    let (v_off, b_off, k_off) = run(0, BLOCKS);
    let m_off = merge_bytes(&k_off, &c2);
    let pm_off = k_off.account(&addr(0x1000)).unwrap().storage.len();
    drop(k_off);
    let (v_on, b_on, k_on) = run(WINDOW, BLOCKS);
    let m_on = merge_bytes(&k_on, &c2);
    let pm_on = k_on.account(&addr(0x1000)).unwrap().storage.len();
    eprintln!("KEEPER VALUES after {BLOCKS} blocks (1 new PoolManager value per block; {CONTRACTS} contracts x {LEARNED_PER} learned):");
    eprintln!("  prune off: {v_off} values ({pm_off} in the PoolManager), keeper holds {:.1} MB, one merged base {:.1} MB", mb(b_off), mb(m_off));
    eprintln!(
        "  prune on ({WINDOW} blocks): {v_on} values ({pm_on} in the PoolManager), keeper holds {:.1} MB, one merged base {:.1} MB; {} rounds, {} values dropped",
        mb(b_on),
        mb(m_on),
        k_on.stats.prunes,
        k_on.stats.pruned_values
    );
    // Off: the PoolManager fills up to its adopt cap (10 x 2,000) and stays.
    assert_eq!(pm_off, 20_000);
    assert_eq!(v_off, learned - LEARNED_PER as usize + 20_000);
    // On: learned + at most the new values of the last two windows and of
    // the part of a window run since the last prune.
    assert!(v_on <= learned + 3 * WINDOW as usize, "{v_on}");
    assert!(pm_on <= LEARNED_PER as usize + 3 * WINDOW as usize, "{pm_on}");
    // The keeper's own bytes stay about the same here (its maps' branch
    // nodes are shared by many values, and the prune tracks recent writes);
    // never more than 10% above.
    assert!(b_on < b_off + b_off / 10, "the keeper itself does not grow: {b_on} vs {b_off}");
    assert!(m_on * 2 < m_off, "a merged base is well under half: {m_on} vs {m_off}");
    // Every learned value is still held.
    for c in 0..CONTRACTS {
        let a = k_on.account(&addr(0x1000 + c)).unwrap();
        for i in 0..LEARNED_PER {
            assert!(a.storage.contains_key(&key(c, i)));
        }
    }
}

/// Copy 2 codes: evicted accounts' codes stay behind without the sweep,
/// and are gone after it.
#[test]
fn copy2_codes_of_evicted_accounts_are_freed() {
    let _t = turn();
    const N: u32 = 2_000;
    const SIZE: usize = 6_000; // a mid-size contract (bytes of code)
    let before = live();
    let mut s = Snapshot::default();
    for i in 0..N {
        let mut raw = vec![0x5bu8; SIZE];
        raw[..4].copy_from_slice(&i.to_be_bytes());
        let c = Bytecode::new_raw(Bytes::from(raw));
        let h = c.hash_slow();
        let a = Address::from_word(B256::from(U256::from(i + 10)));
        s.apply_fact(&Fact::Basics { addr: a, info: Some(AccountInfo { code_hash: h, nonce: 1, ..Default::default() }), code: Some(c) });
    }
    let full = live() - before;
    // The memory cap evicts 90% of the accounts (keeps 200).
    let keep: std::collections::HashSet<Address> = (0..200u32).map(|i| Address::from_word(B256::from(U256::from(i + 10)))).collect();
    s.evict(1, 10_000_000, |_| 0, |x| keep.contains(x));
    let after_evict = live() - before;
    let mut ag = CodeAging::default();
    ag.sweep(&s, 0, 600);
    for h in ag.sweep(&s, 600, 600) {
        s.codes.remove(&h);
    }
    let after_sweep = live() - before;
    eprintln!("COPY 2 CODES ({N} contracts of {SIZE} bytes, 90% evicted):");
    eprintln!("  all held: {:.1} MB | after eviction, no sweep: {:.1} MB ({} codes) | after the sweep: {:.1} MB ({} codes)", mb(full), mb(after_evict), N, mb(after_sweep), s.codes.len());
    assert_eq!(s.codes.len(), 200);
    assert!(after_sweep < after_evict / 4, "{after_sweep} vs {after_evict}");
}

