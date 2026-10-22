// ============================================================================
// COPY 2 CHECK VIEW: what a trade check reads from copy 2, plus two kinds of
// values the copy can vouch for WITHOUT holding them as ordinary values.
//
// Plain English (live Oct 22, shadow hour: the bot's own checks were
// answered only 7 times in 44):
//
//   1. Far tick-map words of a V4 pool (tick walk "full" mode, walk.rs).
//      The bot's checks on thin pools (stock token / USDG) run the price
//      all the way to its limit (our contract swaps with the min / max price
//      limit), reading every tick-map word on the way: 503 missed
//      PoolManager values in that hour. A full walk reads them all once; the
//      ones far from the price are almost all zero, and those are kept here
//      as a compact sorted list (32 bytes each) instead of as held values.
//      A check gets 0 for such a word only while its pool has been READY
//      without a break since the walk (every change the copy made since is
//      then a held value, which always wins). Replays never use this list.
//
//   2. The V4 PoolManager's own coin balances (and its ETH balance). Our
//      contract's V4 swap pays in with sync / transfer / settle and takes
//      out with take: the PoolManager reads its balance of the coin. Copy 2
//      CANNOT follow those balances: every V4 pool on the chain (hooked
//      pools, pools we don't follow) moves them, and following them would
//      mean a WebSocket push for every V4 transfer of every such coin. The
//      copy used to hold the value read when a V4 pool loaded and then
//      changed it only by the transfers that also involved one of our other
//      pools: a STALE number, and the source of the "coin slot" misses
//      (each reload saw a different value and forgot it).
//      What a check really needs from that balance (proved below): the
//      PoolManager's settle counts paid = balance after - balance before
//      (independent of the balance), and take needs balance >= amount. So
//      the check runs TWICE: once with a proven LOWER BOUND P of the real
//      balance R, once with P + 2^200 (above any real balance). If both runs
//      give exactly the same result (success, output, gas), the real run
//      gives it too and the copy answers; otherwise "unknown". The lower
//      bound: the PoolManager must be able to pay out anything a swap on a
//      pool it holds can pay (all V4 pools settle against its balance), so
//      R >= what a swap draining each of OUR ready V4 pools of that coin
//      (over the tick data the copy holds) would pay out, summed over those
//      pools, minus 1 per price step for rounding. Computed with the pools'
//      own price maths (TickMath / SqrtPriceMath, rounding down).
//      Why two runs prove it (coins whose transfer rule is "balance >=
//      amount" plus storing the new balance, which is every standard coin):
//      with R between P and P + 2^200, a balance check that passes at both
//      ends passes for R; a written balance is never 0 at either end (else
//      the gas differs and we answer unknown) so it isn't 0 for R either,
//      so storage gas is the same; settle only uses differences. A coin
//      with a rule that changes inside that range gives different results
//      at the two ends and answers unknown.
//
//   Nothing here asks the node or changes the copy.
// ============================================================================
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use revm::primitives::ruint::Uint;
use revm::primitives::{keccak256, Address, B256, U256};
use revm::state::{AccountInfo, Bytecode};

use super::TrackedPool;
use crate::state::snap::Volatile;
use crate::state::{Lookup, StatePosition, StateRead};

type U512 = Uint<512, 8>;

/// What the copy vouches for in one check (built from the registry per check).
#[derive(Default)]
pub struct C2Facts {
    /// The version's block.
    pub block: u64,
    /// Account -> sorted zero far words valid at `block` (one list per pool).
    pub far: HashMap<Address, Vec<Arc<Vec<U256>>>>,
    /// (coin, slot) = a V4 PoolManager's balance of that coin -> (PoolManager, coin).
    pub inject: HashMap<(Address, U256), (Address, Address)>,
    /// Every V4 PoolManager we follow pools in -> our V4 pools whose values
    /// are exact at `block` (ready since <= block, no report pending): the
    /// lower bound's pools (may be empty: bound 0).
    pub pms: HashMap<Address, Vec<TrackedPool>>,
    /// Lower bounds computed so far: (PoolManager, coin; ZERO = ETH) -> bound.
    pub(crate) cache: Mutex<HashMap<(Address, Address), U256>>,
}

impl C2Facts {
    pub fn is_empty(&self) -> bool {
        self.far.is_empty() && self.inject.is_empty() && self.pms.is_empty()
    }
}

/// The second run's offset (above any real balance: 2^200 base units is
/// ~1.6e42 whole coins of an 18-decimals coin).
pub fn high_offset() -> U256 {
    U256::from(1u8) << 200usize
}

/// A check's view of copy 2 (see the header).
pub struct C2View<'a> {
    inner: &'a dyn StateRead,
    f: &'a C2Facts,
    offset: U256,
    used: AtomicBool,
}

impl<'a> C2View<'a> {
    pub fn new(inner: &'a dyn StateRead, f: &'a C2Facts, offset: U256) -> Self {
        C2View { inner, f, offset, used: AtomicBool::new(false) }
    }

    /// Did the run read a PoolManager balance (so a second run must confirm)?
    pub fn used_bound(&self) -> bool {
        self.used.load(Ordering::Relaxed)
    }

    /// A storage value as the copy knows it: held, or a far zero word.
    fn read(&self, a: Address, s: U256) -> Lookup<U256> {
        match self.inner.storage(a, s) {
            Lookup::Known(v) => Lookup::Known(v),
            Lookup::Missing => {
                if self.f.far.get(&a).is_some_and(|lists| lists.iter().any(|l| l.binary_search(&s).is_ok())) {
                    Lookup::Known(U256::ZERO)
                } else {
                    Lookup::Missing
                }
            }
        }
    }

    /// Proven lower bound of the PoolManager's balance of `coin` (ZERO = ETH).
    pub fn lower_bound(&self, pm: Address, coin: Address) -> U256 {
        if let Some(v) = self.f.cache.lock().unwrap().get(&(pm, coin)) {
            return *v;
        }
        let mut sum = U256::ZERO;
        for p in self.f.pms.get(&pm).map(|v| v.as_slice()).unwrap_or(&[]) {
            let out0 = if p.token0 == coin {
                true
            } else if p.token1 == coin && coin != Address::ZERO {
                false
            } else {
                continue;
            };
            sum = sum.saturating_add(payout_bound(&|s| self.read(pm, s), p, out0));
        }
        self.f.cache.lock().unwrap().insert((pm, coin), sum);
        sum
    }
}

impl StateRead for C2View<'_> {
    fn account(&self, addr: Address) -> Lookup<Option<AccountInfo>> {
        let r = self.inner.account(addr);
        if self.f.pms.contains_key(&addr) {
            if let Lookup::Known(Some(mut info)) = r {
                // The ETH balance the copy holds for the PoolManager is a
                // stale number (native V4 pools move it without a report).
                self.used.store(true, Ordering::Relaxed);
                info.balance = self.lower_bound(addr, Address::ZERO).saturating_add(self.offset);
                return Lookup::Known(Some(info));
            }
        }
        r
    }
    fn storage(&self, addr: Address, slot: U256) -> Lookup<U256> {
        if let Some((pm, coin)) = self.f.inject.get(&(addr, slot)) {
            self.used.store(true, Ordering::Relaxed);
            return Lookup::Known(self.lower_bound(*pm, *coin).saturating_add(self.offset));
        }
        self.read(addr, slot)
    }
    fn code_by_hash(&self, hash: B256) -> Lookup<Bytecode> {
        self.inner.code_by_hash(hash)
    }
    fn position(&self) -> StatePosition {
        self.inner.position()
    }
    fn balance_exact(&self, addr: Address) -> bool {
        self.inner.balance_exact(addr)
    }
    fn volatile(&self) -> Option<&Volatile> {
        self.inner.volatile()
    }
}

// ---------------------------------------------------------------------------
// The lower bound: what a swap draining this pool of one coin would pay out.
// ---------------------------------------------------------------------------
const MIN_TICK: i64 = -887_272;
const MAX_TICK: i64 = 887_272;

fn min_sqrt() -> U256 {
    U256::from(4_295_128_739u64)
}
fn max_sqrt() -> U256 {
    U256::from_str_radix("1461446703485210103287273052203988822378723970342", 10).unwrap()
}
fn q96() -> U256 {
    U256::from(1u8) << 96usize
}

fn map_slot(key: U256, base: U256) -> U256 {
    let mut b = [0u8; 64];
    b[..32].copy_from_slice(&key.to_be_bytes::<32>());
    b[32..].copy_from_slice(&base.to_be_bytes::<32>());
    U256::from_be_bytes(keccak256(b).0)
}

fn int_word(v: i64) -> U256 {
    if v >= 0 {
        U256::from(v as u64)
    } else {
        U256::ZERO.wrapping_sub(U256::from(v.unsigned_abs()))
    }
}

/// floor(a * b / d) (d > 0); None if it doesn't fit 256 bits.
fn mul_div(a: U256, b: U256, d: U256) -> Option<U256> {
    if d.is_zero() {
        return None;
    }
    let p: U512 = a.widening_mul(b);
    let q = p / U512::from(d);
    let limbs = q.as_limbs();
    if limbs[4..].iter().any(|x| *x != 0) {
        return None;
    }
    Some(U256::from_limbs([limbs[0], limbs[1], limbs[2], limbs[3]]))
}

/// Uniswap TickMath.getSqrtRatioAtTick (V3 / V4, same constants; copied from
/// @uniswap/v3-core TickMath.sol).
pub fn sqrt_at_tick(tick: i64) -> Option<U256> {
    if !(MIN_TICK..=MAX_TICK).contains(&tick) {
        return None;
    }
    let h = |s: &str| U256::from_str_radix(s, 16).unwrap();
    let abs = tick.unsigned_abs();
    let mut ratio = if abs & 1 != 0 { h("fffcb933bd6fad37aa2d162d1a594001") } else { U256::from(1u8) << 128usize };
    const M: [(u64, &str); 19] = [
        (0x2, "fff97272373d413259a46990580e213a"),
        (0x4, "fff2e50f5f656932ef12357cf3c7fdcc"),
        (0x8, "ffe5caca7e10e4e61c3624eaa0941cd0"),
        (0x10, "ffcb9843d60f6159c9db58835c926644"),
        (0x20, "ff973b41fa98c081472e6896dfb254c0"),
        (0x40, "ff2ea16466c96a3843ec78b326b52861"),
        (0x80, "fe5dee046a99a2a811c461f1969c3053"),
        (0x100, "fcbe86c7900a88aedcffc83b479aa3a4"),
        (0x200, "f987a7253ac413176f2b074cf7815e54"),
        (0x400, "f3392b0822b70005940c7a398e4b70f3"),
        (0x800, "e7159475a2c29b7443b29c7fa6e889d9"),
        (0x1000, "d097f3bdfd2022b8845ad8f792aa5825"),
        (0x2000, "a9f746462d870fdf8a65dc1f90e061e5"),
        (0x4000, "70d869a156d2a1b890bb3df62baf32f7"),
        (0x8000, "31be135f97d08fd981231505542fcfa6"),
        (0x10000, "9aa508b5b7a84e1c677de54f3e99bc9"),
        (0x20000, "5d6af8dedb81196699c329225ee604"),
        (0x40000, "2216e584f5fa1ea926041bedfe98"),
        (0x80000, "48a170391f7dc42444e8fa2"),
    ];
    for (bit, m) in M {
        if abs & bit != 0 {
            ratio = (ratio * h(m)) >> 128usize;
        }
    }
    if tick > 0 {
        ratio = U256::MAX / ratio;
    }
    let rem = ratio & U256::from(0xffff_ffffu64);
    Some((ratio >> 32usize) + if rem.is_zero() { U256::ZERO } else { U256::from(1u8) })
}

/// SqrtPriceMath.getAmount1Delta(lo, hi, liquidity, roundUp = false).
fn amount1_down(lo: U256, hi: U256, liq: U256) -> Option<U256> {
    mul_div(liq, hi - lo, q96())
}

/// SqrtPriceMath.getAmount0Delta(lo, hi, liquidity, roundUp = false).
fn amount0_down(lo: U256, hi: U256, liq: U256) -> Option<U256> {
    if lo.is_zero() {
        return None;
    }
    let n1 = liq << 96usize;
    if (n1 >> 96usize) != liq {
        return None;
    }
    Some(mul_div(n1, hi - lo, hi)? / lo)
}

fn signed24(x: U256) -> i64 {
    let v = (x & U256::from(0xff_ffffu32)).to::<i64>();
    if v >= 1 << 23 {
        v - (1 << 24)
    } else {
        v
    }
}

/// Signed high 128 bits (int128 liquidityNet packed above liquidityGross).
fn net_of(w: U256) -> i128 {
    let hi = (w >> 128usize).to::<u128>();
    hi as i128
}

/// Lower bound of what a swap draining V4 pool `p` of token0 (`out0`) or
/// token1 would pay out, over the tick data `read` knows (stops at the
/// first unknown value: a smaller bound, still a bound). 0 when unsure.
pub fn payout_bound(read: &dyn Fn(U256) -> Lookup<U256>, p: &TrackedPool, out0: bool) -> U256 {
    payout_inner(read, p, out0).unwrap_or(U256::ZERO)
}

fn payout_inner(read: &dyn Fn(U256) -> Lookup<U256>, p: &TrackedPool, out0: bool) -> Option<U256> {
    let id = p.v4_id?;
    let sp = p.tick_spacing as i64;
    if sp <= 0 {
        return None;
    }
    let known = |s: U256| match read(s) {
        Lookup::Known(v) => Some(v),
        Lookup::Missing => None,
    };
    let base = map_slot(U256::from_be_bytes(id.0), U256::from(6u8));
    let s0 = known(base)?;
    let mut cur = s0 & ((U256::from(1u8) << 160usize) - U256::from(1u8));
    if cur.is_zero() {
        return None; // not initialized
    }
    let tick = signed24(s0 >> 160usize);
    let mut liq = known(base + U256::from(3u8))? & U256::from(u128::MAX);
    let comp = tick.div_euclid(sp);
    let (w_min, w_max) = (MIN_TICK.div_euclid(sp) >> 8, MAX_TICK.div_euclid(sp) >> 8);
    let mut amount = U256::ZERO;
    // Rounding margin: the real swap rounds down at every step (each
    // initialized tick and each word boundary); we may cut fewer steps.
    let mut steps: u64 = 2;
    let tick_net = |t: i64| -> Option<i128> { known(map_slot(int_word(t), base + U256::from(4u8))).map(net_of) };
    let word = |w: i64| known(map_slot(int_word(w), base + U256::from(5u8)));
    let add = |a: Option<U256>, amount: &mut U256| -> Option<()> {
        *amount = amount.checked_add(a?)?;
        Some(())
    };
    if !out0 {
        // Price goes DOWN (pays token1): initialized ticks <= tick, descending.
        let mut w = comp >> 8;
        let mut complete = true;
        while w >= w_min {
            let Some(bits) = word(w) else {
                complete = false;
                break;
            };
            steps += 1;
            let top = if w == comp >> 8 { (comp & 0xff) as usize } else { 255 };
            for b in (0..=top).rev() {
                if !bits.bit(b) {
                    continue;
                }
                let t = ((w << 8) + b as i64) * sp;
                let st = sqrt_at_tick(t.max(MIN_TICK))?;
                if st < cur {
                    add(amount1_down(st, cur, liq), &mut amount)?;
                    cur = st;
                }
                steps += 1;
                let net = tick_net(t)?;
                // Crossing down: liquidity - net.
                let l = i128::try_from(liq.to::<u128>()).ok()?.checked_sub(net)?;
                if l < 0 {
                    return None;
                }
                liq = U256::from(l as u128);
            }
            w -= 1;
        }
        if complete {
            let lim = min_sqrt() + U256::from(1u8);
            if cur > lim {
                add(amount1_down(lim, cur, liq), &mut amount)?;
            }
        }
    } else {
        // Price goes UP (pays token0): initialized ticks > tick, ascending.
        let mut w = comp >> 8;
        let mut complete = true;
        while w <= w_max {
            let Some(bits) = word(w) else {
                complete = false;
                break;
            };
            steps += 1;
            let start = if w == comp >> 8 { (comp & 0xff) as usize + 1 } else { 0 };
            for b in start..256 {
                if !bits.bit(b) {
                    continue;
                }
                let t = ((w << 8) + b as i64) * sp;
                let st = sqrt_at_tick(t.min(MAX_TICK))?;
                if st > cur {
                    add(amount0_down(cur, st, liq), &mut amount)?;
                    cur = st;
                }
                steps += 1;
                let net = tick_net(t)?;
                // Crossing up: liquidity + net.
                let l = i128::try_from(liq.to::<u128>()).ok()?.checked_add(net)?;
                if l < 0 {
                    return None;
                }
                liq = U256::from(l as u128);
            }
            w += 1;
        }
        if complete {
            let lim = max_sqrt() - U256::from(1u8);
            if lim > cur {
                add(amount0_down(cur, lim, liq), &mut amount)?;
            }
        }
    }
    Some(amount.saturating_sub(U256::from(steps)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tick_math_matches_known_values() {
        assert_eq!(sqrt_at_tick(MIN_TICK).unwrap(), min_sqrt());
        assert_eq!(sqrt_at_tick(MAX_TICK).unwrap(), max_sqrt());
        assert_eq!(sqrt_at_tick(0).unwrap(), q96());
        // Monotone.
        let mut last = U256::ZERO;
        for t in (MIN_TICK..=MAX_TICK).step_by(997) {
            let v = sqrt_at_tick(t).unwrap();
            assert!(v > last);
            last = v;
        }
        assert!(sqrt_at_tick(MAX_TICK + 1).is_none());
    }

    #[test]
    fn amounts_round_down() {
        let lo = sqrt_at_tick(-60).unwrap();
        let hi = sqrt_at_tick(60).unwrap();
        let l = U256::from(10u64).pow(U256::from(18u8));
        let a1 = amount1_down(lo, hi, l).unwrap();
        let a0 = amount0_down(lo, hi, l).unwrap();
        // ~0.6 % of L each side.
        assert!(a1 > l / U256::from(200u8) && a1 < l / U256::from(150u8), "{a1}");
        assert!(a0 > l / U256::from(200u8) && a0 < l / U256::from(150u8), "{a0}");
    }

    fn pool(sp: i32) -> TrackedPool {
        TrackedPool { address: Address::with_last_byte(4), v4_id: Some(B256::with_last_byte(7)), kind: super::super::PoolKind::V4, token0: Address::with_last_byte(1), token1: Address::with_last_byte(2), fee: 3000, tick_spacing: sp }
    }

    /// One position [-600, 600) around price 1 (tick 0): the bound equals
    /// the position's amounts (minus a few units), and an unknown word
    /// stops the walk (smaller bound, never larger).
    #[test]
    fn bound_over_one_position() {
        let p = pool(60);
        let base = map_slot(U256::from_be_bytes(p.v4_id.unwrap().0), U256::from(6u8));
        let l: u128 = 1_000_000_000_000_000_000;
        let mut m: HashMap<U256, U256> = HashMap::new();
        m.insert(base, q96()); // tick 0, sqrt price 1
        m.insert(base + U256::from(3u8), U256::from(l));
        let (wl, wh) = (MIN_TICK.div_euclid(60) >> 8, MAX_TICK.div_euclid(60) >> 8);
        for w in wl..=wh {
            m.insert(map_slot(int_word(w), base + U256::from(5u8)), U256::ZERO);
        }
        // ticks -600 (compressed -10: word -1 bit 246) and 600 (word 0 bit 10)
        m.insert(map_slot(int_word(-1), base + U256::from(5u8)), U256::from(1u8) << 246usize);
        m.insert(map_slot(int_word(0), base + U256::from(5u8)), U256::from(1u8) << 10usize);
        let pos = |net: i128| (U256::from(net as u128) << 128usize) | U256::from(l);
        m.insert(map_slot(int_word(-600), base + U256::from(4u8)), pos(l as i128));
        m.insert(map_slot(int_word(600), base + U256::from(4u8)), pos(-(l as i128)));
        let read = |s: U256| m.get(&s).copied().map(Lookup::Known).unwrap_or(Lookup::Missing);
        let want1 = amount1_down(sqrt_at_tick(-600).unwrap(), q96(), U256::from(l)).unwrap();
        let want0 = amount0_down(q96(), sqrt_at_tick(600).unwrap(), U256::from(l)).unwrap();
        let b1 = payout_bound(&read, &p, false);
        let b0 = payout_bound(&read, &p, true);
        assert!(b1 <= want1 && b1 + U256::from(5000u32) > want1, "{b1} vs {want1}");
        assert!(b0 <= want0 && b0 + U256::from(5000u32) > want0, "{b0} vs {want0}");
        // Unknown word right below the price: nothing below is counted.
        m.remove(&map_slot(int_word(-1), base + U256::from(5u8)));
        let read = |s: U256| m.get(&s).copied().map(Lookup::Known).unwrap_or(Lookup::Missing);
        assert!(payout_bound(&read, &p, false) < want1);
    }
}
