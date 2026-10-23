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
//   3. The V4 PoolManager's protocolFeesAccrued[coin] (slot keccak(coin . 1)).
//      A V4 swap through a pool with a protocol fee on in that direction
//      does `protocolFeesAccrued[coin] += fee` (unchecked). The copy can't
//      follow the counter (other pools' swaps add to it; collections empty
//      it and leave no PoolManager event), and fills of it are refused. But
//      its exact value never changes the swap: it is only ADDED to. The only
//      thing it changes is the gas of that store: 0 -> non-zero costs
//      ~20,000 gas, non-zero -> non-zero ~2,900 (+2,100 cold read either
//      way). So the check runs with the counter = 0 and again with it = 1
//      (a placeholder for "not zero": for any real non-zero value R, R +
//      fee and 1 + fee are both non-zero, every SSTORE gas class is the
//      same, nothing else reads it). If success / output / every other
//      field are identical, the answer stands, with the HIGHER gas of the
//      two runs per gas field (the bot then never overestimates its profit;
//      it may underestimate it by up to ~17,100 gas, a fraction of a cent on
//      Robinhood chain). Different (e.g. a check that reads the counter
//      itself, or runs out of gas only with the costlier store): unknown
//      "protocol_fee". A value the copy holds (a replay of our own pool's
//      swap fetched it and adds to it) is NOT used by checks: other pools'
//      swaps and collections change it unseen.
//
//   copy2-r (live Oct 22 21:22, RIVN/USDG: copy "reverts", the node at the
//   SAME block "loss"): "P + 2^200 is above any real balance" holds only if
//   the COIN reads the whole storage word as the balance. Live USDG counts
//   only the low 128 bits (probed on the chain: raw 2^128 + 5 reads 5, raw
//   2^200 + 999 can't pay 1000), so the high run was the bound run again,
//   and a check whose take needed slightly more than the route's bound
//   reverted in both runs "the same": reported as a proven revert. Now the
//   high value is chosen per coin (server.rs coin_highs): the coin must read
//   back P and P + H exactly (balanceOf(PoolManager)); H = 2^200, else the
//   largest of 2^160 / 2^126 / 2^112 / 2^96 it reads back AND that is above
//   its totalSupply x 2^16; none: unknown. (2^126: a 128-bit field keeps
//   room for coins paid in.)
//
//   Speed (live Oct 22 16:19, checks ~120 ms instead of ~5): the lower
//   bound used to be the sum over EVERY ready V4 pool holding the coin
//   (~320 stock / USDG pools), walking each pool's whole tick map, and every
//   tick-map word not held was looked up in every pool's far-zero list.
//   Now:
//     - any proven lower bound will do (the two runs decide), and a smaller
//       one only risks "different" (then unknown), never a wrong answer. So
//       the bound first sums only the pools THIS check has traded on so far
//       (it read their slot0: the PoolManager swaps before it settles /
//       takes), which pays out at least what the check takes in the normal
//       case. Only if the two runs then differ is the check run again with
//       the full bound (every ready V4 pool), exactly as before.
//     - far-zero lookups: one merged sorted list per account (cached across
//       checks while the same lists apply), and the bound's own reads use
//       only that pool's list.
//   Same answers as before; "unknown" can only come where it came before.
//
//   Nothing here asks the node or changes the copy.
// ============================================================================
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use revm::primitives::ruint::Uint;
use revm::primitives::{keccak256, Address, B256, U256};
use revm::state::{AccountInfo, Bytecode};

use super::TrackedPool;
use crate::state::snap::Volatile;
use crate::state::{Lookup, StatePosition, StateRead};

type U512 = Uint<512, 8>;

/// What the copy vouches for at one block: the sets a check reads. Built
/// from copy 2's pool registry (intake.rs CheckCore), shared by every check
/// whose block they are valid for (copy2-q: was rebuilt per check, ~14 ms
/// live with ~290 V4 pools on a busy 2-vCPU server).
#[derive(Clone, Default)]
pub struct FactSets {
    /// Account -> sorted zero far words valid at the block (one list per pool).
    pub far: HashMap<Address, Vec<Arc<Vec<U256>>>>,
    /// The same, all of an account's lists merged into one sorted list
    /// (lookups: one binary search instead of one per pool).
    pub far_merged: HashMap<Address, Arc<Vec<U256>>>,
    /// V4 pool id -> its own far zero list (the bound reads only its own).
    pub far_of: HashMap<B256, Arc<Vec<U256>>>,
    /// (PoolManager, a pool's slot0 slot) -> pool id: a run that read it
    /// traded on (or looked at) that pool.
    pub bases: HashMap<(Address, U256), B256>,
    /// (coin, slot) = a V4 PoolManager's balance of that coin -> (PoolManager, coin).
    pub inject: HashMap<(Address, U256), (Address, Address)>,
    /// Every V4 PoolManager we follow pools in -> our V4 pools whose values
    /// are exact at the block (ready since <= block, no report pending):
    /// the lower bound's pools (may be empty: bound 0).
    pub pms: HashMap<Address, Vec<TrackedPool>>,
    /// (PoolManager, slot) = protocolFeesAccrued[coin] for a coin of one of
    /// our V4 pools there: a check reads it as 0 or 1 (C2View.fee), never
    /// as a held value (see the header, 3.).
    pub fees: HashSet<(Address, U256)>,
}

impl FactSets {
    pub fn is_empty(&self) -> bool {
        self.far.is_empty() && self.inject.is_empty() && self.pms.is_empty() && self.fees.is_empty()
    }

    /// Fill `far_merged` / `far_of` / `bases` from `far` and `pms` (no cache).
    pub fn index(&mut self) {
        for (a, lists) in &self.far {
            self.far_merged.insert(*a, merge_lists(lists));
        }
        self.index_pools();
    }

    /// `bases` from `pms`.
    pub fn index_pools(&mut self) {
        for (pm, pools) in &self.pms {
            for p in pools {
                if let Some(id) = p.v4_id {
                    self.bases.insert((*pm, pool_base_slot(id)), id);
                }
            }
        }
    }
}

/// One check's facts: the (shared) sets plus this check's own bounds.
#[derive(Default)]
pub struct C2Facts {
    /// The version's block.
    pub block: u64,
    pub sets: Arc<FactSets>,
    /// true: bounds over every pool in `pms` (else only the pools the run
    /// touched before it first read the balance).
    pub full: AtomicBool,
    /// A bound was computed from fewer pools than `full` would use.
    pub partial_used: AtomicBool,
    /// Lower bounds computed so far: (PoolManager, coin; ZERO = ETH) -> bound.
    pub cache: Mutex<HashMap<(Address, Address), U256>>,
}

impl std::ops::Deref for C2Facts {
    type Target = FactSets;
    fn deref(&self) -> &FactSets {
        &self.sets
    }
}

impl C2Facts {
    pub fn new(block: u64, sets: Arc<FactSets>) -> Self {
        C2Facts { block, sets, ..Default::default() }
    }

    /// From now on, bounds over every pool (the cheaper bound wasn't
    /// enough): forget the bounds computed so far.
    pub fn go_full(&self) {
        self.full.store(true, Ordering::Relaxed);
        self.cache.lock().unwrap().clear();
    }
}

/// ARBSIM_COPY2_BOUND_FULL=1 (read once): every check's PoolManager
/// balance bound over every ready V4 pool (the old, slower way).
pub fn bound_full_env() -> bool {
    static F: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *F.get_or_init(|| std::env::var("ARBSIM_COPY2_BOUND_FULL").is_ok_and(|v| v.trim() == "1"))
}

/// Several sorted lists -> one sorted list without repeats.
pub fn merge_lists(lists: &[Arc<Vec<U256>>]) -> Arc<Vec<U256>> {
    if lists.len() == 1 {
        return lists[0].clone();
    }
    let mut v: Vec<U256> = Vec::with_capacity(lists.iter().map(|l| l.len()).sum());
    for l in lists {
        v.extend_from_slice(l);
    }
    v.sort_unstable();
    v.dedup();
    Arc::new(v)
}

/// The second fee run's placeholder for "the counter is not zero".
pub fn fee_nonzero() -> U256 {
    U256::from(1u8)
}

/// protocolFeesAccrued[coin] slot of a V4 PoolManager (mapping at slot 1).
pub fn protocol_fee_slot(coin: Address) -> U256 {
    let mut b = [0u8; 64];
    b[12..32].copy_from_slice(coin.as_slice());
    b[63] = 1;
    memo_slot(b)
}

/// keccak256 of 64 bytes as a slot number, remembered (every check builds
/// its facts from the same few thousand slot numbers: ~0.3 us of keccak
/// each, ~1 ms per check with ~300 V4 pools). Always the same answer as
/// computing it (a pure function); the memory is bounded.
pub fn memo_slot(b: [u8; 64]) -> U256 {
    type Memo = Mutex<HashMap<[u8; 64], U256>>;
    static MEMO: std::sync::OnceLock<Memo> = std::sync::OnceLock::new();
    let m = MEMO.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(v) = m.lock().unwrap().get(&b) {
        return *v;
    }
    let v = U256::from_be_bytes(keccak256(b).0);
    let mut g = m.lock().unwrap();
    if g.len() >= 200_000 {
        g.clear();
    }
    g.insert(b, v);
    v
}

/// A V4 pool's slot0 slot at its PoolManager (pools[id], mapping at 6).
pub fn pool_base_slot(id: B256) -> U256 {
    let mut b = [0u8; 64];
    b[..32].copy_from_slice(id.as_slice());
    b[63] = 6;
    memo_slot(b)
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
    /// Value given for an unheld protocolFeesAccrued counter (0 or 1).
    fee: U256,
    used_fee: AtomicBool,
    /// V4 pools this run has read slot0 of (so far).
    touched: Mutex<Vec<B256>>,
    /// Far zero words this run read (reported in the answer's "t").
    far_hits: std::sync::atomic::AtomicU64,
    /// High run only: the value added to the bound per COIN (copy2-r: not
    /// every coin counts the whole storage word as the balance; live USDG
    /// counts only its low 128 bits, so "+ 2^200" read as "+ 0"). A coin
    /// missing here gets `offset`.
    coin_offsets: HashMap<Address, U256>,
    /// (PoolManager, coin) balances this run read (coin ZERO = ETH).
    read_coins: Mutex<Vec<(Address, Address)>>,
}

impl<'a> C2View<'a> {
    pub fn new(inner: &'a dyn StateRead, f: &'a C2Facts, offset: U256) -> Self {
        Self::with_fee(inner, f, offset, U256::ZERO)
    }

    /// `fee`: what an unheld protocolFeesAccrued counter reads as.
    pub fn with_fee(inner: &'a dyn StateRead, f: &'a C2Facts, offset: U256, fee: U256) -> Self {
        Self::with_offsets(inner, f, offset, fee, HashMap::new())
    }

    /// `coin_offsets`: per coin, what the high run adds to its bound
    /// (others: `offset`).
    pub fn with_offsets(inner: &'a dyn StateRead, f: &'a C2Facts, offset: U256, fee: U256, coin_offsets: HashMap<Address, U256>) -> Self {
        C2View {
            inner,
            f,
            offset,
            used: AtomicBool::new(false),
            fee,
            used_fee: AtomicBool::new(false),
            touched: Mutex::new(Vec::new()),
            far_hits: Default::default(),
            coin_offsets,
            read_coins: Mutex::new(Vec::new()),
        }
    }

    /// The PoolManager balances (PoolManager, coin; ZERO = ETH) this run read.
    pub fn read_coins(&self) -> Vec<(Address, Address)> {
        self.read_coins.lock().unwrap().clone()
    }

    fn note_coin(&self, pm: Address, coin: Address) {
        let mut r = self.read_coins.lock().unwrap();
        if !r.contains(&(pm, coin)) {
            r.push((pm, coin));
        }
    }

    fn offset_of(&self, coin: Address) -> U256 {
        if self.offset.is_zero() {
            return U256::ZERO;
        }
        self.coin_offsets.get(&coin).copied().unwrap_or(self.offset)
    }

    /// Far zero words this run read.
    pub fn far_hits(&self) -> u64 {
        self.far_hits.load(Ordering::Relaxed)
    }

    /// Did the run read a PoolManager balance (so a second run must confirm)?
    pub fn used_bound(&self) -> bool {
        self.used.load(Ordering::Relaxed)
    }

    /// Did the run read an unheld protocolFeesAccrued counter (so a run with
    /// the other value must confirm)?
    pub fn used_fee(&self) -> bool {
        self.used_fee.load(Ordering::Relaxed)
    }

    /// A storage value as the copy knows it: held, or a far zero word.
    fn read(&self, a: Address, s: U256) -> Lookup<U256> {
        match self.inner.storage(a, s) {
            Lookup::Known(v) => Lookup::Known(v),
            Lookup::Missing => {
                if self.f.far_merged.get(&a).is_some_and(|l| l.binary_search(&s).is_ok()) {
                    self.far_hits.fetch_add(1, Ordering::Relaxed);
                    Lookup::Known(U256::ZERO)
                } else {
                    Lookup::Missing
                }
            }
        }
    }

    /// A storage value of pool `id` (at its PoolManager `pm`) as the copy
    /// knows it: held, or one of THAT pool's far zero words (the same
    /// answer as `read`: another pool's words are other slots).
    fn read_pool(&self, pm: Address, id: Option<B256>, s: U256) -> Lookup<U256> {
        match self.inner.storage(pm, s) {
            Lookup::Known(v) => Lookup::Known(v),
            Lookup::Missing => {
                if id.and_then(|i| self.f.far_of.get(&i)).is_some_and(|l| l.binary_search(&s).is_ok()) {
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
        let full = self.f.full.load(Ordering::Relaxed);
        let touched: HashSet<B256> = if full { HashSet::new() } else { self.touched.lock().unwrap().iter().copied().collect() };
        let mut sum = U256::ZERO;
        let mut skipped = false;
        let pools: Vec<(&TrackedPool, bool)> = self
            .f
            .pms
            .get(&pm)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
            .iter()
            .filter_map(|p| {
                if p.token0 == coin {
                    Some((p, true))
                } else if p.token1 == coin && coin != Address::ZERO {
                    Some((p, false))
                } else {
                    None
                }
            })
            .collect();
        let on_route = |p: &TrackedPool| full || p.v4_id.is_some_and(|i| touched.contains(&i));
        for (p, out0) in pools.iter().filter(|(p, _)| on_route(p)) {
            sum = sum.saturating_add(payout_bound(&|s| self.read_pool(pm, p.v4_id, s), p, *out0));
        }
        // The route's pools hold none of this coin (e.g. the coin the check
        // PAYS IN on a one-sided pool): a bound of 0 makes the two runs
        // differ (a 0 -> non-zero store costs more gas), so add other pools
        // until it isn't 0 (any subset is a proven bound).
        for (p, out0) in pools.iter().filter(|(p, _)| !on_route(p)) {
            if !sum.is_zero() {
                skipped = true;
                break;
            }
            sum = sum.saturating_add(payout_bound(&|s| self.read_pool(pm, p.v4_id, s), p, *out0));
        }
        if skipped {
            self.f.partial_used.store(true, Ordering::Relaxed);
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
                self.note_coin(addr, Address::ZERO);
                info.balance = self.lower_bound(addr, Address::ZERO).saturating_add(self.offset);
                return Lookup::Known(Some(info));
            }
        }
        r
    }
    fn storage(&self, addr: Address, slot: U256) -> Lookup<U256> {
        if let Some(id) = self.f.bases.get(&(addr, slot)) {
            let mut t = self.touched.lock().unwrap();
            if !t.contains(id) {
                t.push(*id);
            }
        }
        if let Some((pm, coin)) = self.f.inject.get(&(addr, slot)) {
            self.used.store(true, Ordering::Relaxed);
            self.note_coin(*pm, *coin);
            return Lookup::Known(self.lower_bound(*pm, *coin).saturating_add(self.offset_of(*coin)));
        }
        // A protocol fee counter: always the run's value, even when the copy
        // holds one (a replay of our pool's swap fetched and moves it, but
        // other pools' swaps and collections change it unseen: a held
        // non-zero may really be 0, which would make the gas look 17,100
        // lower than real).
        if self.f.fees.contains(&(addr, slot)) {
            self.used_fee.store(true, Ordering::Relaxed);
            return Lookup::Known(self.fee);
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

/// Every tick-map word slot (word w_min..=w_max) of V4 pool `id`, cached:
/// the same numbers forever (keccak of the word index and the pool's
/// mapping slot), so computing them once per pool is exact.
fn word_slots(id: B256, base: U256, sp: i64, w_min: i64, w_max: i64) -> Arc<Vec<U256>> {
    type Cache = Mutex<HashMap<(B256, i64), Arc<Vec<U256>>>>;
    static CACHE: std::sync::OnceLock<Cache> = std::sync::OnceLock::new();
    let c = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(v) = c.lock().unwrap().get(&(id, sp)) {
        return v.clone();
    }
    let wb = base + U256::from(5u8);
    let v: Arc<Vec<U256>> = Arc::new((w_min..=w_max).map(|w| map_slot(int_word(w), wb)).collect());
    let mut g = c.lock().unwrap();
    // Bounded (each entry is a few KB; ~1 per V4 pool ever followed).
    if g.len() > 20_000 {
        g.clear();
    }
    g.insert((id, sp), v.clone());
    v
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
    // Tick-map word slots of this pool, computed once per pool (a keccak
    // each; the walk below may visit thousands of words per check).
    let slots = word_slots(id, base, sp, w_min, w_max);
    if !(MIN_TICK..=MAX_TICK).contains(&tick) {
        return None;
    }
    let word = |w: i64| slots.get(usize::try_from(w - w_min).ok()?).copied().and_then(known);
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

    /// copy2-p speed-ups give exactly the same numbers as before.
    #[test]
    fn remembered_slots_and_merged_lists_are_exact() {
        let coin = Address::with_last_byte(0x2d);
        assert_eq!(protocol_fee_slot(coin), super::super::fields::map_slot(coin, 1));
        assert_eq!(protocol_fee_slot(coin), protocol_fee_slot(coin), "remembered value");
        let id = B256::with_last_byte(9);
        assert_eq!(pool_base_slot(id), map_slot(U256::from_be_bytes(id.0), U256::from(6u8)));
        for (vyper, slot) in [(false, 0u64), (false, 51), (true, 3)] {
            let l = super::super::coins::BalanceLayout { slot: U256::from(slot), vyper, solady: false };
            let h = Address::with_last_byte(0x77);
            assert_eq!(memo_slot(l.preimage(h).unwrap()), l.key(h));
        }
        let sol = super::super::coins::BalanceLayout { slot: U256::from(1u8), vyper: false, solady: true };
        assert!(sol.preimage(Address::ZERO).is_none(), "Solady's 32-byte layout is never remembered as 64 bytes");
        let a = Arc::new(vec![U256::from(1u8), U256::from(5u8), U256::from(9u8)]);
        let b = Arc::new(vec![U256::from(2u8), U256::from(5u8)]);
        let m = merge_lists(&[a.clone(), b]);
        assert_eq!(*m, vec![U256::from(1u8), U256::from(2u8), U256::from(5u8), U256::from(9u8)]);
        assert!(Arc::ptr_eq(&merge_lists(std::slice::from_ref(&a)), &a), "one list: itself");
        // Word slots of a pool: the same as computing each.
        let base = pool_base_slot(id);
        let (wl, wh) = (MIN_TICK.div_euclid(60) >> 8, MAX_TICK.div_euclid(60) >> 8);
        let ws = word_slots(id, base, 60, wl, wh);
        for w in [wl, -1, 0, 7, wh] {
            assert_eq!(ws[(w - wl) as usize], map_slot(int_word(w), base + U256::from(5u8)));
        }
    }

    /// A route-only bound counts only the pools the run read slot0 of (plus
    /// other pools only while it is still 0); go_full counts every pool.
    #[test]
    fn route_bound_counts_the_touched_pools_then_everything() {
        let l: u128 = 1_000_000_000_000_000_000;
        let mk = |n: u8| TrackedPool { address: Address::with_last_byte(4), v4_id: Some(B256::with_last_byte(n)), kind: super::super::PoolKind::V4, token0: Address::with_last_byte(1), token1: Address::with_last_byte(2), fee: 3000, tick_spacing: 60 };
        let (p1, p2) = (mk(7), mk(8));
        let pm = p1.address;
        let mut m: HashMap<U256, U256> = HashMap::new();
        for p in [&p1, &p2] {
            let base = pool_base_slot(p.v4_id.unwrap());
            m.insert(base, q96());
            m.insert(base + U256::from(3u8), U256::from(l));
            let (wl, wh) = (MIN_TICK.div_euclid(60) >> 8, MAX_TICK.div_euclid(60) >> 8);
            for w in wl..=wh {
                m.insert(map_slot(int_word(w), base + U256::from(5u8)), U256::ZERO);
            }
            m.insert(map_slot(int_word(-1), base + U256::from(5u8)), U256::from(1u8) << 246usize);
            m.insert(map_slot(int_word(0), base + U256::from(5u8)), U256::from(1u8) << 10usize);
            let pos = |net: i128| (U256::from(net as u128) << 128usize) | U256::from(l);
            m.insert(map_slot(int_word(-600), base + U256::from(4u8)), pos(l as i128));
            m.insert(map_slot(int_word(600), base + U256::from(4u8)), pos(-(l as i128)));
        }
        struct Fake(HashMap<U256, U256>, Address);
        impl StateRead for Fake {
            fn account(&self, _a: Address) -> Lookup<Option<AccountInfo>> {
                Lookup::Missing
            }
            fn storage(&self, a: Address, s: U256) -> Lookup<U256> {
                if a != self.1 {
                    return Lookup::Missing;
                }
                self.0.get(&s).copied().map(Lookup::Known).unwrap_or(Lookup::Missing)
            }
            fn code_by_hash(&self, _h: B256) -> Lookup<Bytecode> {
                Lookup::Missing
            }
            fn position(&self) -> StatePosition {
                StatePosition::default()
            }
        }
        let st = Fake(m, pm);
        let mut sets = FactSets::default();
        sets.pms.insert(pm, vec![p1.clone(), p2.clone()]);
        sets.index_pools();
        let f = C2Facts::new(0, Arc::new(sets));
        let one = {
            let v = C2View::new(&st, &f, U256::ZERO);
            let _ = v.storage(pm, pool_base_slot(p1.v4_id.unwrap()));
            v.lower_bound(pm, p1.token0)
        };
        assert!(!one.is_zero() && f.partial_used.load(Ordering::Relaxed), "route-only: one pool");
        f.go_full();
        let both = C2View::new(&st, &f, U256::ZERO).lower_bound(pm, p1.token0);
        assert_eq!(both, one + one, "full: both pools (same shape)");
        // Nothing touched: the first pool with a non-zero bound (never 0).
        let mut sets2 = FactSets::default();
        sets2.pms.insert(pm, vec![p1, p2]);
        sets2.index_pools();
        let f2 = C2Facts::new(0, Arc::new(sets2));
        assert_eq!(C2View::new(&st, &f2, U256::ZERO).lower_bound(pm, Address::with_last_byte(1)), one);
    }

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
