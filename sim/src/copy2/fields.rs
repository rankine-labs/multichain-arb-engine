// ============================================================================
// COPY 2 "FIELDS": keep Uniswap V2 and Solidly pools current by writing the
// numbers their own events state (no node reads, proven exact offline:
// bench/event-copy-test types/v2.js + types/solidly.js, 0 wrong in 3,942
// checks).
//
// Plain English:
//   A V2 pool's whole state is: its reserves (+ the time of the last update
//   and two running "price x seconds" totals), and its LP coin (who holds
//   how much, and the total). Every change to those comes with an event:
//     Sync(r0, r1)      new reserves. The running totals grow by
//                       old price x seconds since the last Sync: we know the
//                       old reserves and old time, so we do the same integer
//                       maths the pool does (exact).
//     Transfer (LP)     LP balances + total supply.
//   Solidly (Velodrome V2 design) adds a fee index per LP coin:
//     Fees(a0, a1)      index += amount x 1e18 / totalSupply (pool's maths)
//     Sync              running totals use old reserve x seconds, and a new
//                       price "observation" every > 30 minutes.
//
//   STRICT rules used here:
//     - A value the copy doesn't hold stays unknown (never treated as 0).
//       E.g. an LP Transfer to a wallet whose LP balance we never loaded:
//       we leave that balance unknown (nobody's check needs it); the total
//       supply, which we do hold, is updated.
//     - The values a pool's swap reads ("core" slots: reserves, totals,
//       fee index, supply) must be known for a READY pool; if one is
//       missing, or the maths would overflow, or the pool sends an event we
//       don't know, the answer is Unsure and the pool is reloaded.
//     - Things we can't follow exactly are made unknown instead of guessed:
//       LP allowances (V2's transferFrom lowers them without an event) are
//       never written; Solidly's per-holder fee bookkeeping (supplyIndex,
//       claimable) can change without an event (claimFees with nothing to
//       claim), so we forget those slots when they'd change. Swaps never
//       read either.
//
//   Storage layouts are checked against the pool's own getters when the
//   pool is first loaded (intake.rs, `verify_*`): a fork with a different
//   layout is never followed.
// ============================================================================
use std::sync::OnceLock;

use revm::primitives::{keccak256, Address, B256, U256};

use super::overlay::Overlay;
use super::{word, ApplyResult, PoolKind, PoolLog, TrackedPool};
use crate::state::Lookup;

// ---------------------------------------------------------------------------
// Event fingerprints (topic 0 = keccak of the event's signature)
// ---------------------------------------------------------------------------
/// The topic-0 values we recognise, computed once.
pub struct Topics {
    pub transfer: B256,
    pub approval: B256,
    pub v2_sync: B256,
    pub v2_mint: B256,
    pub v2_burn: B256,
    pub v2_swap: B256,
    pub sol_sync: B256,
    pub sol_fees: B256,
    pub sol_claim: B256,
    pub sol_burn: B256,
    pub sol_swap: B256,
    pub eip712_changed: B256,
}

/// keccak of an event signature.
pub fn topic(sig: &str) -> B256 {
    keccak256(sig.as_bytes())
}

pub fn topics() -> &'static Topics {
    static T: OnceLock<Topics> = OnceLock::new();
    T.get_or_init(|| Topics {
        transfer: topic("Transfer(address,address,uint256)"),
        approval: topic("Approval(address,address,uint256)"),
        v2_sync: topic("Sync(uint112,uint112)"),
        // Same signature in Uniswap V2 and Velodrome.
        v2_mint: topic("Mint(address,uint256,uint256)"),
        v2_burn: topic("Burn(address,uint256,uint256,address)"),
        v2_swap: topic("Swap(address,uint256,uint256,uint256,uint256,address)"),
        sol_sync: topic("Sync(uint256,uint256)"),
        sol_fees: topic("Fees(address,uint256,uint256)"),
        sol_claim: topic("Claim(address,address,uint256,uint256)"),
        sol_burn: topic("Burn(address,address,uint256,uint256)"),
        sol_swap: topic("Swap(address,address,uint256,uint256,uint256,uint256)"),
        eip712_changed: topic("EIP712DomainChanged()"),
    })
}

// ---------------------------------------------------------------------------
// Storage slot helpers
// ---------------------------------------------------------------------------
/// Solidity mapping slot: keccak(key padded to 32 bytes . slot number).
pub fn map_slot(key: Address, slot: u64) -> U256 {
    let mut buf = [0u8; 64];
    buf[12..32].copy_from_slice(key.as_slice());
    buf[32..64].copy_from_slice(&U256::from(slot).to_be_bytes::<32>());
    U256::from_be_bytes(keccak256(buf).0)
}

/// Address in an indexed topic (last 20 bytes).
pub fn topic_addr(t: &B256) -> Address {
    Address::from_slice(&t.0[12..32])
}

/// Uniswap V2 pair storage (npm v2-core 1.0.1; same in SushiSwap etc.).
pub mod v2 {
    pub const TOTAL_SUPPLY: u64 = 0;
    pub const BALANCES: u64 = 1;
    pub const TOKEN0: u64 = 6;
    pub const TOKEN1: u64 = 7;
    /// reserve0 (112 bits) | reserve1 (112 bits) | blockTimestampLast (32 bits)
    pub const RESERVES: u64 = 8;
    pub const PRICE0_CUM: u64 = 9;
    pub const PRICE1_CUM: u64 = 10;
    /// Slots a READY V2 pool must hold (what Sync / LP Transfer need).
    pub const CORE: [u64; 4] = [TOTAL_SUPPLY, RESERVES, PRICE0_CUM, PRICE1_CUM];
}

/// Velodrome V2 Pool storage (from the compiler's storage layout).
pub mod sol {
    pub const BALANCES: u64 = 0;
    pub const TOTAL_SUPPLY: u64 = 2;
    /// stable (bool, byte 0) | token0 (address, bytes 1..21)
    pub const STABLE_TOKEN0: u64 = 10;
    pub const TOKEN1: u64 = 11;
    pub const POOL_FEES: u64 = 12;
    pub const FACTORY: u64 = 13;
    /// observations[] length; entries at keccak(14) + 3*i: time, r0Cum, r1Cum.
    pub const OBS_LEN: u64 = 14;
    pub const RESERVE0: u64 = 17;
    pub const RESERVE1: u64 = 18;
    pub const TS_LAST: u64 = 19;
    pub const CUM0: u64 = 20;
    pub const CUM1: u64 = 21;
    pub const INDEX0: u64 = 22;
    pub const INDEX1: u64 = 23;
    pub const SUPPLY_INDEX0: u64 = 24;
    pub const SUPPLY_INDEX1: u64 = 25;
    pub const CLAIMABLE0: u64 = 26;
    pub const CLAIMABLE1: u64 = 27;
    /// New observation when more than this many seconds passed.
    pub const PERIOD_SIZE: u64 = 1800;
    /// Fixed slots a READY Solidly pool must hold (+ the last observation's
    /// time, see `obs_slot`).
    pub const CORE: [u64; 10] = [TOTAL_SUPPLY, OBS_LEN, RESERVE0, RESERVE1, TS_LAST, CUM0, CUM1, INDEX0, INDEX1, STABLE_TOKEN0];
}

/// Slot of observation `i`, field `f` (0 time, 1 r0Cum, 2 r1Cum).
pub fn obs_slot(i: U256, f: u64) -> U256 {
    let base = U256::from_be_bytes(keccak256(U256::from(sol::OBS_LEN).to_be_bytes::<32>()).0);
    base.wrapping_add(i.wrapping_mul(U256::from(3))).wrapping_add(U256::from(f))
}

const MASK112: U256 = U256::from_limbs([u64::MAX, (1u64 << 48) - 1, 0, 0]);
const MASK32: U256 = U256::from_limbs([u32::MAX as u64, 0, 0, 0]);

/// Slots a READY pool of this kind must hold (fixed ones; Solidly also needs
/// its last observation's time, which depends on the observation count).
pub fn core_slots(kind: PoolKind) -> &'static [u64] {
    match kind {
        PoolKind::V2 => &v2::CORE,
        PoolKind::Solidly => &sol::CORE,
        _ => &[],
    }
}

// ---------------------------------------------------------------------------
// Small strict helpers
// ---------------------------------------------------------------------------
/// A core value: must be known, else the pool is unsure.
fn need(ov: &Overlay, a: Address, s: U256, what: &str) -> Result<U256, ApplyResult> {
    match ov.slot(a, s) {
        Lookup::Known(v) => Ok(v),
        Lookup::Missing => Err(ApplyResult::Unsure(format!("{what} not held"))),
    }
}

/// Add (or subtract) to a slot IF we hold it; unknown stays unknown.
/// Overflow / underflow (impossible on chain, the token would revert) =
/// our copy is wrong -> unsure.
fn adjust_if_known(ov: &mut Overlay, a: Address, s: U256, add: U256, sub: U256, what: &str) -> Result<(), ApplyResult> {
    if let Lookup::Known(v) = ov.slot(a, s) {
        let nv = v
            .checked_add(add)
            .and_then(|x| x.checked_sub(sub))
            .ok_or_else(|| ApplyResult::Unsure(format!("{what} would go out of range")))?;
        ov.set_slot(a, s, nv);
    }
    Ok(())
}

/// Same, but the value is core (must be known).
fn adjust_core(ov: &mut Overlay, a: Address, s: U256, add: U256, sub: U256, what: &str) -> Result<(), ApplyResult> {
    need(ov, a, s, what)?;
    adjust_if_known(ov, a, s, add, sub, what)
}

fn check_words(log: &PoolLog, n_topics: usize, n_words: usize) -> Result<(), ApplyResult> {
    if log.topics.len() != n_topics || log.data.len() != n_words * 32 {
        return Err(ApplyResult::Unsure(format!("event shape not as expected ({} topics, {} data bytes)", log.topics.len(), log.data.len())));
    }
    Ok(())
}

fn done(r: Result<(), ApplyResult>) -> ApplyResult {
    match r {
        Ok(()) => ApplyResult::Applied,
        Err(e) => e,
    }
}

// ---------------------------------------------------------------------------
// Uniswap V2
// ---------------------------------------------------------------------------
/// Apply one event of a V2 pair. `ts` = the block's timestamp.
pub fn apply_v2(ov: &mut Overlay, pool: &TrackedPool, log: &PoolLog, ts: u64) -> ApplyResult {
    let t = topics();
    let p = pool.address;
    let Some(t0) = log.topics.first() else { return ApplyResult::Unsure("event without topics".into()) };
    if *t0 == t.v2_sync {
        return done((|| {
            check_words(log, 1, 2)?;
            let (r0, r1) = (word(&log.data, 0), word(&log.data, 1));
            if r0 > MASK112 || r1 > MASK112 {
                return Err(ApplyResult::Unsure("Sync reserves exceed 112 bits".into()));
            }
            let old = need(ov, p, U256::from(v2::RESERVES), "reserves")?;
            let o0 = old & MASK112;
            let o1 = (old >> 112usize) & MASK112;
            let o_ts: U256 = old >> 224usize;
            let now = U256::from(ts) & MASK32;
            // uint32 subtraction, overflow wanted (as in the pair).
            let elapsed = now.wrapping_sub(o_ts) & MASK32;
            if !elapsed.is_zero() && !o0.is_zero() && !o1.is_zero() {
                let p0 = need(ov, p, U256::from(v2::PRICE0_CUM), "price0CumulativeLast")?;
                let p1 = need(ov, p, U256::from(v2::PRICE1_CUM), "price1CumulativeLast")?;
                // UQ112x112.encode(y).uqdiv(x) = (y << 112) / x, then x elapsed,
                // wrapping (Solidity 0.5.16, no overflow check, as intended).
                ov.set_slot(p, U256::from(v2::PRICE0_CUM), p0.wrapping_add(((o1 << 112usize) / o0).wrapping_mul(elapsed)));
                ov.set_slot(p, U256::from(v2::PRICE1_CUM), p1.wrapping_add(((o0 << 112usize) / o1).wrapping_mul(elapsed)));
            }
            ov.set_slot(p, U256::from(v2::RESERVES), r0 | (r1 << 112usize) | (now << 224usize));
            Ok(())
        })());
    }
    if *t0 == t.transfer {
        return done((|| {
            check_words(log, 3, 1)?;
            let (from, to, v) = (topic_addr(&log.topics[1]), topic_addr(&log.topics[2]), word(&log.data, 0));
            let ts_slot = U256::from(v2::TOTAL_SUPPLY);
            if from == Address::ZERO {
                // _mint(to, v): supply up, balance[to] up (to may be 0x0: the
                // first mint locks MINIMUM_LIQUIDITY there).
                adjust_core(ov, p, ts_slot, v, U256::ZERO, "LP totalSupply")?;
                adjust_if_known(ov, p, map_slot(to, v2::BALANCES), v, U256::ZERO, "LP balance")?;
            } else if to == Address::ZERO && from == p {
                // _burn(pair, v): only the pair burns, and only its own coins.
                adjust_if_known(ov, p, map_slot(p, v2::BALANCES), U256::ZERO, v, "LP balance")?;
                adjust_core(ov, p, ts_slot, U256::ZERO, v, "LP totalSupply")?;
            } else {
                // Plain transfer (V2 allows sending to 0x0: that is NOT a burn).
                adjust_if_known(ov, p, map_slot(from, v2::BALANCES), U256::ZERO, v, "LP balance")?;
                adjust_if_known(ov, p, map_slot(to, v2::BALANCES), v, U256::ZERO, "LP balance")?;
            }
            Ok(())
        })());
    }
    // Events that change nothing we follow (their changes come with Sync /
    // Transfer); Approval: allowances are deliberately not followed.
    if [t.approval, t.v2_mint, t.v2_burn, t.v2_swap].contains(t0) {
        return ApplyResult::Applied;
    }
    ApplyResult::Unsure(format!("unknown V2 pool event {t0}"))
}

// ---------------------------------------------------------------------------
// Solidly / Velodrome V2
// ---------------------------------------------------------------------------
const E18: U256 = U256::from_limbs([1_000_000_000_000_000_000, 0, 0, 0]);

/// The pool's per-holder fee bookkeeping may have changed without us being
/// able to compute it: make it unknown (swaps never read it).
fn forget_holder_fees(ov: &mut Overlay, p: Address, h: Address) {
    for s in [sol::SUPPLY_INDEX0, sol::SUPPLY_INDEX1, sol::CLAIMABLE0, sol::CLAIMABLE1] {
        ov.forget_slot(p, map_slot(h, s));
    }
}

/// Apply one event of a Solidly (Velodrome V2) pool. `ts` = block timestamp.
pub fn apply_solidly(ov: &mut Overlay, pool: &TrackedPool, log: &PoolLog, ts: u64) -> ApplyResult {
    let t = topics();
    let p = pool.address;
    let Some(t0) = log.topics.first() else { return ApplyResult::Unsure("event without topics".into()) };
    let s = |n: u64| U256::from(n);
    if *t0 == t.sol_sync {
        return done((|| {
            check_words(log, 1, 2)?;
            let (r0, r1) = (word(&log.data, 0), word(&log.data, 1));
            let now = U256::from(ts);
            let o0 = need(ov, p, s(sol::RESERVE0), "reserve0")?;
            let o1 = need(ov, p, s(sol::RESERVE1), "reserve1")?;
            let last = need(ov, p, s(sol::TS_LAST), "blockTimestampLast")?;
            let elapsed = now.checked_sub(last).ok_or_else(|| ApplyResult::Unsure("block time before the pool's last update".into()))?;
            let mut c0 = need(ov, p, s(sol::CUM0), "reserve0CumulativeLast")?;
            let mut c1 = need(ov, p, s(sol::CUM1), "reserve1CumulativeLast")?;
            if !elapsed.is_zero() && !o0.is_zero() && !o1.is_zero() {
                // Solidity 0.8: checked maths (an overflow would have reverted).
                c0 = o0.checked_mul(elapsed).and_then(|x| x.checked_add(c0)).ok_or_else(|| ApplyResult::Unsure("cumulative overflow".into()))?;
                c1 = o1.checked_mul(elapsed).and_then(|x| x.checked_add(c1)).ok_or_else(|| ApplyResult::Unsure("cumulative overflow".into()))?;
                ov.set_slot(p, s(sol::CUM0), c0);
                ov.set_slot(p, s(sol::CUM1), c1);
            }
            // New price observation every > 30 min (pool's own rule).
            let len = need(ov, p, s(sol::OBS_LEN), "observations length")?;
            if len.is_zero() || len > U256::from(u64::MAX / 4) {
                return Err(ApplyResult::Unsure("observations length out of range".into()));
            }
            let last_obs = need(ov, p, obs_slot(len - U256::from(1), 0), "last observation time")?;
            let since = now.checked_sub(last_obs).ok_or_else(|| ApplyResult::Unsure("block time before the last observation".into()))?;
            if since > U256::from(sol::PERIOD_SIZE) {
                ov.set_slot(p, obs_slot(len, 0), now);
                ov.set_slot(p, obs_slot(len, 1), c0);
                ov.set_slot(p, obs_slot(len, 2), c1);
                ov.set_slot(p, s(sol::OBS_LEN), len + U256::from(1));
            }
            ov.set_slot(p, s(sol::RESERVE0), r0);
            ov.set_slot(p, s(sol::RESERVE1), r1);
            ov.set_slot(p, s(sol::TS_LAST), now);
            Ok(())
        })());
    }
    if *t0 == t.sol_fees {
        return done((|| {
            check_words(log, 2, 2)?;
            let supply = need(ov, p, s(sol::TOTAL_SUPPLY), "LP totalSupply")?;
            if supply.is_zero() {
                return Err(ApplyResult::Unsure("Fees with zero LP supply".into()));
            }
            for (i, idx) in [(0usize, sol::INDEX0), (1, sol::INDEX1)] {
                let amount = word(&log.data, i);
                if amount.is_zero() {
                    continue;
                }
                let ratio = amount.checked_mul(E18).ok_or_else(|| ApplyResult::Unsure("fee ratio overflow".into()))? / supply;
                if !ratio.is_zero() {
                    adjust_core(ov, p, s(idx), ratio, U256::ZERO, "fee index")?;
                }
            }
            Ok(())
        })());
    }
    if *t0 == t.transfer {
        return done((|| {
            check_words(log, 3, 1)?;
            let (from, to, v) = (topic_addr(&log.topics[1]), topic_addr(&log.topics[2]), word(&log.data, 0));
            // The pool settles both holders' fees first (_updateFor):
            // we don't follow that bookkeeping, see file header.
            forget_holder_fees(ov, p, from);
            forget_holder_fees(ov, p, to);
            // OpenZeppelin _update: from 0 = mint, to 0 = burn.
            if from == Address::ZERO {
                adjust_core(ov, p, s(sol::TOTAL_SUPPLY), v, U256::ZERO, "LP totalSupply")?;
            } else {
                adjust_if_known(ov, p, map_slot(from, sol::BALANCES), U256::ZERO, v, "LP balance")?;
            }
            if to == Address::ZERO {
                adjust_core(ov, p, s(sol::TOTAL_SUPPLY), U256::ZERO, v, "LP totalSupply")?;
            } else {
                adjust_if_known(ov, p, map_slot(to, sol::BALANCES), v, U256::ZERO, "LP balance")?;
            }
            Ok(())
        })());
    }
    if *t0 == t.sol_claim {
        if log.topics.len() < 2 {
            return ApplyResult::Unsure("Claim without sender".into());
        }
        forget_holder_fees(ov, p, topic_addr(&log.topics[1]));
        return ApplyResult::Applied;
    }
    // No state of their own (changes come with Sync / Fees / Transfer).
    // Both Burn/Swap spellings are accepted (older Solidly forks use V2's).
    if [t.approval, t.v2_mint, t.sol_burn, t.sol_swap, t.v2_burn, t.v2_swap, t.eip712_changed].contains(t0) {
        return ApplyResult::Applied;
    }
    ApplyResult::Unsure(format!("unknown Solidly pool event {t0}"))
}

/// Apply one event of a "fields" pool (V2 / Solidly).
pub fn apply_fields(ov: &mut Overlay, pool: &TrackedPool, log: &PoolLog, ts: u64) -> ApplyResult {
    match pool.kind {
        PoolKind::V2 => apply_v2(ov, pool, log, ts),
        PoolKind::Solidly => apply_solidly(ov, pool, log, ts),
        _ => ApplyResult::Unsure("not a fields pool".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::snap::Snapshot;
    use revm::primitives::Bytes;

    fn pool(kind: PoolKind) -> TrackedPool {
        TrackedPool {
            address: Address::with_last_byte(0xaa),
            v4_id: None,
            kind,
            token0: Address::with_last_byte(1),
            token1: Address::with_last_byte(2),
            fee: 0,
            tick_spacing: 0,
        }
    }
    fn words(ws: &[U256]) -> Bytes {
        let mut v = Vec::new();
        for w in ws {
            v.extend_from_slice(&w.to_be_bytes::<32>());
        }
        Bytes::from(v)
    }
    fn addr_topic(a: Address) -> B256 {
        let mut b = [0u8; 32];
        b[12..].copy_from_slice(a.as_slice());
        B256::from(b)
    }
    fn log(p: &TrackedPool, topics: Vec<B256>, data: Bytes) -> PoolLog {
        PoolLog { address: p.address, topics, data, block: 10, tx_index: 0, log_index: 0, tx_hash: B256::ZERO, removed: false }
    }
    fn u(n: u128) -> U256 {
        U256::from(n)
    }

    #[test]
    fn topic_hashes_are_the_well_known_ones() {
        let t = topics();
        assert_eq!(format!("{}", t.transfer), "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
        assert_eq!(format!("{}", t.v2_sync), "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1");
        assert_eq!(format!("{}", t.sol_sync), "0xcf2aa50876cdfbb541206f89af0ee78d44a2abf8d328e37fa4917f982149848a");
    }

    #[test]
    fn v2_sync_exact_hand_computed() {
        let p = pool(PoolKind::V2);
        let mut ov = Overlay::new(Snapshot::default());
        // Old: r0 = 1000, r1 = 4000, last time 100 (mod 2^32).
        ov.set_slot(p.address, u(8), u(1000) | (u(4000) << 112) | (u(100) << 224));
        ov.set_slot(p.address, u(9), u(7));
        ov.set_slot(p.address, u(10), u(9));
        let l = log(&p, vec![topics().v2_sync], words(&[u(1100), u(3700)]));
        assert_eq!(apply_v2(&mut ov, &p, &l, 112), ApplyResult::Applied);
        // elapsed 12 s. price0 += (4000 << 112) / 1000 * 12; price1 += (1000 << 112) / 4000 * 12.
        let q = U256::from(1) << 112;
        assert_eq!(ov.slot(p.address, u(9)), Lookup::Known(u(7) + q * u(4) * u(12)));
        assert_eq!(ov.slot(p.address, u(10)), Lookup::Known(u(9) + (q / u(4)) * u(12)));
        assert_eq!(ov.slot(p.address, u(8)), Lookup::Known(u(1100) | (u(3700) << 112) | (u(112) << 224)));
        // Same block again: no time passed, totals unchanged.
        let l2 = log(&p, vec![topics().v2_sync], words(&[u(1200), u(3500)]));
        assert_eq!(apply_v2(&mut ov, &p, &l2, 112), ApplyResult::Applied);
        assert_eq!(ov.slot(p.address, u(9)), Lookup::Known(u(7) + q * u(4) * u(12)));
    }

    #[test]
    fn v2_sync_time_wraps_at_2_pow_32_and_prices_wrap() {
        let p = pool(PoolKind::V2);
        let mut ov = Overlay::new(Snapshot::default());
        let last = (1u128 << 32) - 2; // 2 s before the uint32 wrap
        ov.set_slot(p.address, u(8), u(3) | (u(5) << 112) | (u(last) << 224));
        ov.set_slot(p.address, u(9), U256::MAX); // wraps
        ov.set_slot(p.address, u(10), u(0));
        let ts = (1u64 << 32) + 3; // 5 s later, after the wrap
        let l = log(&p, vec![topics().v2_sync], words(&[u(4), u(6)]));
        assert_eq!(apply_v2(&mut ov, &p, &l, ts), ApplyResult::Applied);
        let q = U256::from(1) << 112;
        let add0 = ((u(5) * q) / u(3)) * u(5);
        assert_eq!(ov.slot(p.address, u(9)), Lookup::Known(U256::MAX.wrapping_add(add0)));
        assert_eq!(ov.slot(p.address, u(10)), Lookup::Known(((u(3) * q) / u(5)) * u(5)));
        assert_eq!(ov.slot(p.address, u(8)), Lookup::Known(u(4) | (u(6) << 112) | (u(3) << 224)));
    }

    #[test]
    fn v2_sync_needs_core_and_rejects_big_reserves() {
        let p = pool(PoolKind::V2);
        let mut ov = Overlay::new(Snapshot::default());
        let l = log(&p, vec![topics().v2_sync], words(&[u(1), u(1)]));
        assert!(matches!(apply_v2(&mut ov, &p, &l, 1), ApplyResult::Unsure(_)));
        ov.set_slot(p.address, u(8), u(0));
        let big = log(&p, vec![topics().v2_sync], words(&[U256::from(1) << 112, u(1)]));
        assert!(matches!(apply_v2(&mut ov, &p, &big, 1), ApplyResult::Unsure(_)));
        // Reserves were 0: no price totals needed.
        assert_eq!(apply_v2(&mut ov, &p, &l, 1), ApplyResult::Applied);
    }

    #[test]
    fn v2_lp_transfers_mint_burn_and_unknown_balances_stay_unknown() {
        let p = pool(PoolKind::V2);
        let (alice, bob) = (Address::with_last_byte(0x11), Address::with_last_byte(0x22));
        let mut ov = Overlay::new(Snapshot::default());
        ov.set_slot(p.address, u(0), u(1000));
        ov.set_slot(p.address, map_slot(alice, 1), u(300));
        ov.set_slot(p.address, map_slot(p.address, 1), u(0));
        let tr = |f: Address, t: Address, v: u128| log(&p, vec![topics().transfer, addr_topic(f), addr_topic(t)], words(&[u(v)]));
        // Mint 50 to alice.
        assert_eq!(apply_v2(&mut ov, &p, &tr(Address::ZERO, alice, 50), 0), ApplyResult::Applied);
        assert_eq!(ov.slot(p.address, u(0)), Lookup::Known(u(1050)));
        assert_eq!(ov.slot(p.address, map_slot(alice, 1)), Lookup::Known(u(350)));
        // Alice -> pair 100, pair burns 100.
        assert_eq!(apply_v2(&mut ov, &p, &tr(alice, p.address, 100), 0), ApplyResult::Applied);
        assert_eq!(apply_v2(&mut ov, &p, &tr(p.address, Address::ZERO, 100), 0), ApplyResult::Applied);
        assert_eq!(ov.slot(p.address, u(0)), Lookup::Known(u(950)));
        assert_eq!(ov.slot(p.address, map_slot(alice, 1)), Lookup::Known(u(250)));
        assert_eq!(ov.slot(p.address, map_slot(p.address, 1)), Lookup::Known(u(0)));
        // Alice -> bob (bob's balance never loaded: stays unknown, not 20).
        assert_eq!(apply_v2(&mut ov, &p, &tr(alice, bob, 20), 0), ApplyResult::Applied);
        assert_eq!(ov.slot(p.address, map_slot(bob, 1)), Lookup::Missing);
        assert_eq!(ov.slot(p.address, map_slot(alice, 1)), Lookup::Known(u(230)));
        // Alice sends to 0x0 by hand: a transfer, NOT a burn (supply unchanged).
        assert_eq!(apply_v2(&mut ov, &p, &tr(alice, Address::ZERO, 30), 0), ApplyResult::Applied);
        assert_eq!(ov.slot(p.address, u(0)), Lookup::Known(u(950)));
        assert_eq!(ov.slot(p.address, map_slot(alice, 1)), Lookup::Known(u(200)));
        // Underflow = our copy is wrong -> unsure.
        assert!(matches!(apply_v2(&mut ov, &p, &tr(alice, bob, 999), 0), ApplyResult::Unsure(_)));
        // Unknown event -> unsure; Swap -> nothing to do.
        assert!(matches!(apply_v2(&mut ov, &p, &log(&p, vec![topic("Weird()")], words(&[])), 0), ApplyResult::Unsure(_)));
        assert_eq!(apply_v2(&mut ov, &p, &log(&p, vec![topics().v2_swap, B256::ZERO, B256::ZERO], words(&[u(1), u(0), u(0), u(1)])), 0), ApplyResult::Applied);
    }

    fn solidly_base(p: &TrackedPool) -> Overlay {
        let mut ov = Overlay::new(Snapshot::default());
        let a = p.address;
        ov.set_slot(a, u(2), u(2_000_000_000_000_000_000)); // 2 LP coins
        ov.set_slot(a, u(14), u(2)); // two observations
        ov.set_slot(a, obs_slot(u(1), 0), u(1_000));
        ov.set_slot(a, u(17), u(500));
        ov.set_slot(a, u(18), u(800));
        ov.set_slot(a, u(19), u(2_000));
        ov.set_slot(a, u(20), u(11));
        ov.set_slot(a, u(21), u(13));
        ov.set_slot(a, u(22), u(0));
        ov.set_slot(a, u(23), u(5));
        ov
    }

    #[test]
    fn solidly_sync_cumulatives_and_observation_rule() {
        let p = pool(PoolKind::Solidly);
        let mut ov = solidly_base(&p);
        let sync = |r0: u128, r1: u128| log(&p, vec![topics().sol_sync], words(&[u(r0), u(r1)]));
        // t = 2,600: 600 s since last update; 1,600 s since last observation (<= 1800: none).
        assert_eq!(apply_solidly(&mut ov, &p, &sync(510, 790), 2_600), ApplyResult::Applied);
        assert_eq!(ov.slot(p.address, u(20)), Lookup::Known(u(11 + 500 * 600)));
        assert_eq!(ov.slot(p.address, u(21)), Lookup::Known(u(13 + 800 * 600)));
        assert_eq!(ov.slot(p.address, u(14)), Lookup::Known(u(2)));
        assert_eq!(ov.slot(p.address, u(17)), Lookup::Known(u(510)));
        assert_eq!(ov.slot(p.address, u(19)), Lookup::Known(u(2_600)));
        // t = 2,801: 1,801 s since the last observation -> new observation #2.
        assert_eq!(apply_solidly(&mut ov, &p, &sync(520, 780), 2_801), ApplyResult::Applied);
        let c0 = 11 + 500 * 600 + 510 * 201;
        let c1 = 13 + 800 * 600 + 790 * 201;
        assert_eq!(ov.slot(p.address, u(14)), Lookup::Known(u(3)));
        assert_eq!(ov.slot(p.address, obs_slot(u(2), 0)), Lookup::Known(u(2_801)));
        assert_eq!(ov.slot(p.address, obs_slot(u(2), 1)), Lookup::Known(u(c0)));
        assert_eq!(ov.slot(p.address, obs_slot(u(2), 2)), Lookup::Known(u(c1)));
        assert_eq!(ov.slot(p.address, u(20)), Lookup::Known(u(c0)));
    }

    #[test]
    fn solidly_fees_index_and_transfer_bookkeeping() {
        let p = pool(PoolKind::Solidly);
        let mut ov = solidly_base(&p);
        let sender = addr_topic(Address::with_last_byte(9));
        // Fees(3e15, 7): index0 += 3e15 * 1e18 / 2e18 = 1.5e15; index1 += 7e18/2e18 = 3 -> 8.
        let fees = log(&p, vec![topics().sol_fees, sender], words(&[u(3_000_000_000_000_000), u(7)]));
        assert_eq!(apply_solidly(&mut ov, &p, &fees, 0), ApplyResult::Applied);
        assert_eq!(ov.slot(p.address, u(22)), Lookup::Known(u(1_500_000_000_000_000)));
        assert_eq!(ov.slot(p.address, u(23)), Lookup::Known(u(8)));
        // Fees(1, 0): ratio 1e18/2e18 = 0 -> unchanged.
        let tiny = log(&p, vec![topics().sol_fees, sender], words(&[u(1), u(0)]));
        assert_eq!(apply_solidly(&mut ov, &p, &tiny, 0), ApplyResult::Applied);
        assert_eq!(ov.slot(p.address, u(22)), Lookup::Known(u(1_500_000_000_000_000)));
        // Transfer: holder fee bookkeeping forgotten, balances / supply exact.
        let alice = Address::with_last_byte(0x11);
        ov.set_slot(p.address, map_slot(alice, 0), u(100));
        ov.set_slot(p.address, map_slot(alice, 26), u(4));
        let mint = log(&p, vec![topics().transfer, addr_topic(Address::ZERO), addr_topic(alice)], words(&[u(10)]));
        assert_eq!(apply_solidly(&mut ov, &p, &mint, 0), ApplyResult::Applied);
        assert_eq!(ov.slot(p.address, map_slot(alice, 0)), Lookup::Known(u(110)));
        assert_eq!(ov.slot(p.address, map_slot(alice, 26)), Lookup::Missing);
        assert_eq!(ov.slot(p.address, u(2)), Lookup::Known(u(2_000_000_000_000_000_010)));
        let burn = log(&p, vec![topics().transfer, addr_topic(p.address), addr_topic(Address::ZERO)], words(&[u(10)]));
        assert_eq!(apply_solidly(&mut ov, &p, &burn, 0), ApplyResult::Applied);
        assert_eq!(ov.slot(p.address, u(2)), Lookup::Known(u(2_000_000_000_000_000_000)));
        // Missing core value -> unsure.
        let mut empty = Overlay::new(Snapshot::default());
        assert!(matches!(apply_solidly(&mut empty, &p, &fees, 0), ApplyResult::Unsure(_)));
    }
}
