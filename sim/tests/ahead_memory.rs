// ============================================================================
// SEEING-AHEAD MEMORY BENCH (Nov 1): where observe mode's extra memory goes.
//
// Plain English:
//   With FASTLANE_AHEAD=observe live, arbsim grew 50-100 MB and sometimes
//   jumped 150-200 MB in ~30 s (pm2 kills at 1,300 MB). This bench measures,
//   offline and with a counting allocator (every byte the program holds),
//   the pieces observe mode adds:
//     1. merge: the predicted copy's base = copy 2's snapshot with the
//        keeper's values laid over it (keeper::merge_base). The V4
//        PoolManager is held by BOTH (copy 2: our V4 pools' ticks; the
//        keeper: everyone else's values it learned / adopted), so every
//        merge writes thousands of values into copy 2's big map, which
//        copies most of its branches. How much does ONE merge hold, and how
//        much do the merges still alive at once hold?
//     2. a node answer (eth_getProof of one seed batch) read whole and
//        turned into a JSON tree, versus the lean parse (values only).
//     3. the fix: a predicted block waiting for its agreement keeps only
//        what agreement reads (FASTLANE_AHEAD_THIN_PENDING), so it no longer
//        pins its own merged PoolManager.
//   Printed with --nocapture; asserts check the fix keeps its promise.
//
//   Sizes (env; the live sizes are not known yet, see the PR):
//     AHEAD_MEM_C2_PM     copy 2's values in the PoolManager   [50000]
//     AHEAD_MEM_KEEP_PM   keeper values in the PoolManager     [20000]
//                         (the keeper's cap per contract with
//                         FASTLANE_AHEAD_KEEP_ADOPT: 10 x 2,000)
// ============================================================================
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use arbsim::check::ordered::Provenance;
use arbsim::check::moved::{v4_base, FollowedPool};
use arbsim::copy2::ahead::{thin_for_agreement, thin_for_agreement_from, PoolSet};
use arbsim::copy2::keeper::{merge_base, KeptVersion};
use revm::primitives::B256;
use arbsim::state::snap::{Acct, Basics, PMap, Snapshot};
use revm::primitives::{Address, U256};
use revm::state::AccountInfo;

// ---------------------------------------------------------------------------
// Counting allocator: live bytes and peak, for this test binary only.
// ---------------------------------------------------------------------------
struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            let n = LIVE.fetch_add(l.size(), Ordering::Relaxed) + l.size();
            PEAK.fetch_max(n, Ordering::Relaxed);
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
                let n = LIVE.fetch_add(new - l.size(), Ordering::Relaxed) + (new - l.size());
                PEAK.fetch_max(n, Ordering::Relaxed);
            } else {
                LIVE.fetch_sub(l.size() - new, Ordering::Relaxed);
            }
        }
        q
    }
}

#[global_allocator]
static A: Counting = Counting;

/// The tests here measure ONE counter for the whole binary: they take
/// turns (cargo runs tests on parallel threads).
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
fn env(k: &str, d: usize) -> usize {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

/// Copy 2 vouches for everything (the bench only measures memory).
struct All;
impl Provenance for All {
    fn slot_exact(&self, _: Address, _: U256) -> bool {
        true
    }
    fn balance_exact(&self, _: Address) -> bool {
        true
    }
}

fn addr(n: u64) -> Address {
    let mut b = [0u8; 20];
    b[12..].copy_from_slice(&n.to_be_bytes());
    Address::from(b)
}
fn key(acct: u64, i: u64) -> U256 {
    // Spread like real hashed slots (the map's branches fill evenly).
    U256::from(i.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (acct << 40)) << 64 | U256::from(i)
}
fn known(bal: u64) -> Basics {
    Basics::Known(Some(AccountInfo { balance: U256::from(bal), nonce: 1, ..Default::default() }))
}

const PM: u64 = 0x4444;

/// Copy 2's snapshot: the PoolManager with `c2_pm` values + 1,800 small pools.
fn copy2_snapshot(c2_pm: usize) -> Snapshot {
    let mut s = Snapshot::default();
    let mut pm = Acct { basics: known(1), ..Default::default() };
    for i in 0..c2_pm as u64 {
        pm.storage.insert(key(PM, i), U256::from(i + 1));
    }
    s.accounts.insert(addr(PM), pm);
    for p in 0..1800u64 {
        let mut a = Acct { basics: known(1), ..Default::default() };
        for i in 0..40u64 {
            a.storage.insert(key(p, i), U256::from(i));
        }
        s.accounts.insert(addr(0x10_0000 + p), a);
    }
    s
}

/// The keeper: `keep_pm` PoolManager values copy 2 does not hold (other
/// pools' ticks), + 299 other contracts of 300 values.
fn kept_version(block: u64, keep_pm: usize) -> KeptVersion {
    let mut kv = KeptVersion { block, accounts: PMap::default(), codes: PMap::default() };
    let mut pm = Acct { basics: known(2), ..Default::default() };
    for i in 0..keep_pm as u64 {
        pm.storage.insert(key(PM, 10_000_000 + i), U256::from(7));
    }
    kv.accounts.insert(addr(PM), pm);
    for c in 0..299u64 {
        let mut a = Acct { basics: known(3), ..Default::default() };
        for i in 0..300u64 {
            a.storage.insert(key(0x20_0000 + c, i), U256::from(i));
        }
        kv.accounts.insert(addr(0x20_0000 + c), a);
    }
    kv
}

/// One block later: copy 2 changed 50 of its PoolManager values (our V4
/// swaps), the keeper 100 of its own (other pools' swaps).
fn next_block(s: &Snapshot, kv: &KeptVersion, n: u64) -> (Snapshot, KeptVersion) {
    let mut s2 = s.clone();
    let mut pm = s2.accounts.get(&addr(PM)).cloned().unwrap();
    for i in 0..50u64 {
        pm.storage.insert(key(PM, (n * 97 + i * 13) % 1000), U256::from(n * 1000 + i));
    }
    s2.accounts.insert(addr(PM), pm);
    let mut k2 = kv.clone();
    k2.block += 1;
    let mut kpm = k2.accounts.get(&addr(PM)).cloned().unwrap();
    for i in 0..100u64 {
        kpm.storage.insert(key(PM, 10_000_000 + (n * 31 + i * 7) % 5000), U256::from(n * 1000 + i));
    }
    k2.accounts.insert(addr(PM), kpm);
    (s2, k2)
}

/// Our V4 pools in the PoolManager (their ids).
fn v4_id(i: u64) -> B256 {
    B256::from(U256::from(0xabcd_0000u64 + i))
}

/// Our pools: 1,800 contract pools + 100 V4 pools in the PoolManager.
fn pool_set() -> PoolSet {
    let mut list = Vec::new();
    for p in 0..1800u64 {
        let a = addr(0x10_0000 + p);
        list.push((FollowedPool { key: format!("{a:#x}"), address: a, v4_id: None }, addr(1), addr(2)));
    }
    for i in 0..100u64 {
        let id = v4_id(i);
        list.push((FollowedPool { key: format!("{id:#x}"), address: addr(PM), v4_id: Some(id) }, addr(1), addr(2)));
    }
    PoolSet::build(&list, Default::default())
}

/// Our V4 pools' base values in copy 2's PoolManager.
fn add_v4_bases(s: &mut Snapshot) {
    let mut pm = s.accounts.get(&addr(PM)).cloned().unwrap();
    for i in 0..100u64 {
        let b = v4_base(v4_id(i));
        for k in 0..4u64 {
            pm.storage.insert(b + U256::from(k), U256::from(i * 10 + k + 1));
        }
    }
    s.accounts.insert(addr(PM), pm);
}

/// A predicted block on a merged base: a few of our V4 pools swapped (their
/// base values and some ticks in the PoolManager written).
fn predict(merged: &Snapshot, n: u64) -> Snapshot {
    let mut p = merged.clone();
    let mut pm = p.accounts.get(&addr(PM)).cloned().unwrap();
    for i in 0..20u64 {
        let b = v4_base(v4_id((n + i) % 100));
        pm.storage.insert(b, U256::from(n * 100 + i));
        pm.storage.insert(key(PM, 500_000 + n * 20 + i), U256::from(1));
    }
    p.accounts.insert(addr(PM), pm);
    p
}

/// MERGE COST: what ONE merged base holds on its own (beyond copy 2's and
/// the keeper's own maps) and what it costs to make.
#[test]
fn merge_cost_per_base() {
    let _turn = turn();
    for (c2_pm, keep_pm) in [(20_000, 2_000), (50_000, 5_000), (50_000, 20_000), (200_000, 20_000)] {
        let mut s = copy2_snapshot(c2_pm);
        let mut kv = kept_version(1, keep_pm);
        let blocks = 20u64;
        let (mut bytes, mut us) = (0usize, 0u128);
        let mut keep: Option<Snapshot> = None;
        for n in 0..blocks {
            let (s2, k2) = next_block(&s, &kv, n);
            s = s2;
            kv = k2;
            let before = live();
            let t = Instant::now();
            let m = merge_base(&s, &All, &kv).0;
            us += t.elapsed().as_micros();
            bytes += live().saturating_sub(before);
            keep = Some(m); // the previous one is freed here
        }
        drop(keep);
        println!("MERGE copy2 PM {c2_pm:>7} values, keeper PM {keep_pm:>6}: {:>5} MB per merged base, {:>6} us to make", mb(bytes / blocks as usize), us / blocks as u128);
    }
}

/// THE FIX: the predicted blocks waiting for their agreement (compare delay
/// 5 -> 6 waiting) with their whole predicted copy (old) vs the thin one.
#[test]
fn waiting_agreements_thin_vs_whole() {
    let _turn = turn();
    let c2_pm = env("AHEAD_MEM_C2_PM", 50_000);
    let keep_pm = env("AHEAD_MEM_KEEP_PM", 20_000);
    let pools = pool_set();
    let mut res = Vec::new();
    for thin in [false, true] {
        let mut s = copy2_snapshot(c2_pm);
        add_v4_bases(&mut s);
        let mut kv = kept_version(1, keep_pm);
        // Copy 2 and the keeper keep 64 versions each anyway.
        let mut hist: std::collections::VecDeque<(Snapshot, KeptVersion)> = Default::default();
        let mut pending: std::collections::VecDeque<Arc<Snapshot>> = Default::default();
        let mut merged: Option<Arc<Snapshot>> = None;
        let mut tip: Option<Arc<Snapshot>> = None;
        let mut thin_prev: Option<Arc<Snapshot>> = None;
        for n in 0..60u64 {
            let (s2, k2) = next_block(&s, &kv, n);
            s = s2;
            kv = k2;
            hist.push_back((s.clone(), kv.clone()));
            while hist.len() > 64 {
                hist.pop_front();
            }
            // Copy 2 confirmed block n: the old tip waits for its agreement.
            if let Some(t) = tip.take() {
                pending.push_back(if thin {
                    let v = Arc::new(thin_for_agreement_from(&t, &pools, thin_prev.as_deref()));
                    thin_prev = Some(v.clone());
                    v
                } else {
                    t
                });
            }
            while pending.len() > 6 {
                pending.pop_front(); // compared, 5 blocks later
            }
            // New base: merged again, predicted on.
            let m = Arc::new(merge_base(&s, &All, &kv).0);
            tip = Some(Arc::new(predict(&m, n)));
            merged = Some(m);
        }
        let with = live();
        pending.clear();
        thin_prev = None;
        let without = live();
        drop((merged, tip, hist, thin_prev));
        res.push(mb(with - without));
        println!(
            "WAITING AGREEMENTS ({}): 6 waiting blocks hold {} MB beyond everything else (copy2 PM {c2_pm}, keeper PM {keep_pm})",
            if thin { "thin, the fix" } else { "whole copy, old" },
            mb(with - without)
        );
    }
    assert!(res[1] * 10.0 < res[0].max(1.0), "thin {} MB vs whole {} MB", res[1], res[0]);
}

/// The thin view answers every lookup agreement makes exactly as the
/// whole predicted copy does.
#[test]
fn thin_view_answers_like_the_whole_copy() {
    let _turn = turn();
    use arbsim::state::StateRead;
    let pools = pool_set();
    let mut s = copy2_snapshot(5_000);
    add_v4_bases(&mut s);
    // One V4 pool forgotten (unsure), one contract pool missing entirely.
    let mut pm = s.accounts.get(&addr(PM)).cloned().unwrap();
    for k in 0..4u64 {
        pm.storage.remove(&(v4_base(v4_id(7)) + U256::from(k)));
    }
    s.accounts.insert(addr(PM), pm);
    s.accounts.remove(&addr(0x10_0000 + 9));
    let m = merge_base(&s, &All, &kept_version(1, 2_000)).0;
    let pred = predict(&m, 3);
    // Built fresh, and built on an older thin view (shared entries).
    let older = thin_for_agreement(&predict(&merge_base(&copy2_snapshot(5_000), &All, &kept_version(1, 2_000)).0, 1), &pools);
    let inc = thin_for_agreement_from(&pred, &pools, Some(&older));
    for thin in [thin_for_agreement(&pred, &pools), inc] {
    for i in 0..100u64 {
        let b = v4_base(v4_id(i));
        for k in 0..4u64 {
            assert_eq!(pred.storage(addr(PM), b + U256::from(k)), thin.storage(addr(PM), b + U256::from(k)), "V4 pool {i} value {k}");
        }
    }
    for p in 0..1800u64 {
        let a = addr(0x10_0000 + p);
        for i in 0..45u64 {
            assert_eq!(pred.storage(a, key(p, i)), thin.storage(a, key(p, i)), "pool {p} value {i}");
        }
    }
    assert!(thin.accounts.get(&addr(PM)).unwrap().storage.len() <= 400, "PoolManager: only our pools' base values");
    assert!(thin.accounts.get(&addr(0x10_0000 + 9)).is_none(), "a pool the copy doesn't hold stays missing");
    }
}

/// For the report: a seed answer (eth_getProof of 100 values with ~9 trie
/// nodes each, as the node sends it) and a block diff, read whole into a
/// JSON tree (what node.rs does with every answer).
#[test]
fn node_answer_sizes() {
    let _turn = turn();
    let node_hex = "ab".repeat(532);
    let sp: Vec<serde_json::Value> = (0..100)
        .map(|i| serde_json::json!({"key": format!("{:#066x}", i), "value": format!("{:#x}", i + 1), "proof": (0..9).map(|_| format!("0x{node_hex}")).collect::<Vec<_>>()}))
        .collect();
    let body = serde_json::json!([{"jsonrpc": "2.0", "id": 0, "result": {"balance": "0x1", "nonce": "0x1", "codeHash": format!("{:#066x}", 5), "accountProof": (0..9).map(|_| format!("0x{node_hex}")).collect::<Vec<_>>(), "storageProof": sp}}]).to_string();
    let base = live();
    PEAK.store(base, Ordering::Relaxed);
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    let tree = PEAK.load(Ordering::Relaxed) - base;
    drop(v);
    println!("NODE ANSWER: seed proof of 100 values: text {} MB, JSON tree {} MB (2 seeds in flight: x2)", mb(body.len()), mb(tree));
    assert!(tree < 8 * 1_048_576, "a seed answer stays small: {tree}");
}

/// For the report: what the keeper's own history costs (64 versions of a
/// 20,000-value PoolManager with 100 values written per block), and what
/// a full candidate list costs (4,096 candidates x 256 values each).
#[test]
fn keeper_history_and_candidates() {
    let _turn = turn();
    let mut kv = kept_version(1, 20_000);
    let s = copy2_snapshot(1);
    let base = live();
    let mut hist: std::collections::VecDeque<Arc<KeptVersion>> = Default::default();
    for n in 0..64u64 {
        let (_, k2) = next_block(&s, &kv, n);
        kv = k2;
        hist.push_back(Arc::new(kv.clone()));
    }
    let with = live();
    let one = Arc::new(kv.clone());
    hist.clear();
    let only_one = live();
    drop(one);
    println!("KEEPER HISTORY: 64 versions hold {} MB more than 1 (PoolManager 20,000 values, 100 written per block)", mb(with.saturating_sub(only_one)));
    let _ = base;
    let before = live();
    let cands: Vec<std::collections::HashSet<U256>> = (0..4096u64).map(|c| (0..256u64).map(|i| key(c, i)).collect()).collect();
    let as_hash = live() - before;
    drop(cands);
    // The keeper's SlotSet (copy2/keeper.rs): a sorted list, values added
    // one at a time as runs learn them.
    let before = live();
    let lists: Vec<Vec<U256>> = (0..4096u64)
        .map(|c| {
            let mut v: Vec<U256> = Vec::new();
            for i in 0..256u64 {
                let k = key(c, i);
                if let Err(p) = v.binary_search(&k) {
                    v.insert(p, k);
                }
            }
            v
        })
        .collect();
    let as_list = live() - before;
    drop(lists);
    println!("KEEPER CANDIDATES: 4,096 x 256 values = {} MB as hash sets (old), {} MB as sorted lists (now)", mb(as_hash), mb(as_list));
    assert!(as_list * 3 < as_hash * 2, "lists {as_list} vs sets {as_hash}");
}
