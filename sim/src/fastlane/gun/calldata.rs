// ============================================================================
// GUN: ArbExecutor CALLDATA (exact Rust port of src/execution/executorCalldata.ts)
//
// Plain English:
//   The contract (contracts/src/ArbExecutor.sol) is told what to trade by the
//   bytes we send it: execute(trade, flashPool) or executeWithV3Flash(trade,
//   lendPool). The Node bot builds those bytes in executorCalldata.ts. The
//   Rust sender must build EXACTLY the same bytes, refuse in EXACTLY the same
//   cases (same reason text), and round token amounts EXACTLY the same way
//   (the USD -> token conversion goes through 64-bit floats, like JavaScript).
//
//   Proof: sim/tests/vectors/gen-calldata-vectors.ts runs the real TypeScript
//   on ~6,500 inputs (every pool kind, every refusal, funding choices,
//   decimals 0..36, odd floats) and sim/tests/gun_vectors.rs checks this file
//   gives identical bytes / identical refusals for every one.
//
//   Two kinds of "no":
//     Refused(reason) = the TS returns {ok:false, reason} (same text).
//     Invalid(what)   = the TS would THROW (a value out of range for the ABI,
//                       e.g. a fee over uint16). Never sent either way.
//
//   What is NOT ported (not part of building bytes): executionRequested()
//   and executorConfig() (env switches; the gun reads its own settings).
// ============================================================================
use revm::primitives::ruint::Uint;
use revm::primitives::{keccak256, Address, Bytes, B256, U256};

/// Selector of execute((...)[] ,address), from `forge inspect ArbExecutor methodIdentifiers`.
pub const EXECUTE_SELECTOR: [u8; 4] = [0x8d, 0xa2, 0xb3, 0x2d];
/// Selector of executeWithV3Flash((...)[], address).
pub const EXECUTE_V3_FLASH_SELECTOR: [u8; 4] = [0xb0, 0xfa, 0x7d, 0x85];
/// The ABI signatures the selectors come from (checked by a test).
pub const EXECUTE_SIG: &str =
    "execute((address,uint256,uint256,uint256,(uint8,address,address,address,uint16,uint24,int24,bool)[]),address)";
pub const EXECUTE_V3_FLASH_SIG: &str =
    "executeWithV3Flash((address,uint256,uint256,uint256,(uint8,address,address,address,uint16,uint24,int24,bool)[]),address)";

// Must match the KIND_* constants in ArbExecutor.sol (and executorCalldata.ts).
pub const KIND_V2: i64 = 0;
pub const KIND_SOLIDLY: i64 = 1;
pub const KIND_V3: i64 = 2;
pub const KIND_V4: i64 = 3;
/// Uniswap V4 pool WITH a hook (Fables): `pool` carries the HOOK address.
pub const KIND_V4_HOOKED: i64 = 4;

/// DEX names whose V2-style pairs are Solidly-style (price via the pair's own getAmountOut).
const SOLIDLY_DEXES: [&str; 3] = ["ramses", "ramses-v2", "pharaoh"];
/// DEXes the contract cannot trade, whatever the pool is labelled.
const UNSUPPORTED_DEXES: [&str; 5] = ["lfj-lb", "traderjoe-lb", "bean-exchange", "ramses-dlmm", "kuru"];
/// V3 exchanges whose pools the contract's flash callbacks accept as lenders.
const FLASH_LENDER_DEXES: [&str; 3] = ["uniswap-v3", "pancakeswap-v3", "ramses-v3"];

// ---------------------------------------------------------------------------
// Inputs (the parts of the bot's PoolState the calldata code reads)
// ---------------------------------------------------------------------------
/// PoolState.poolType.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PoolType {
    V2,
    V3,
    Orderbook,
    Stable,
}

impl PoolType {
    pub fn as_str(self) -> &'static str {
        match self {
            PoolType::V2 => "v2",
            PoolType::V3 => "v3",
            PoolType::Orderbook => "orderbook",
            PoolType::Stable => "stable",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "v2" => Some(PoolType::V2),
            "v3" => Some(PoolType::V3),
            "orderbook" => Some(PoolType::Orderbook),
            "stable" => Some(PoolType::Stable),
            _ => None,
        }
    }
}

/// PoolState.v4 (Uniswap V4 pools only). Numbers are wide on purpose: a bad
/// stored value must be REFUSED like the TS does, not wrapped into range.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct V4Info {
    /// Pool key's fee field (pips; 0x800000 = dynamic fee set by the hook).
    pub fee: i64,
    pub tick_spacing: i64,
    /// The pool holds native ETH where we use WETH.
    pub native: bool,
    pub pool_manager: Address,
    /// Hooked pools (Fables): the hook contract. None / zero = no hook.
    pub hooks: Option<Address>,
}

/// The fields of the bot's PoolState that executorCalldata.ts reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolInfo {
    /// Exchange name exactly as the bot stores it (matched case-insensitively,
    /// printed as-is in refusal reasons).
    pub dex: String,
    /// The pool's address (20 bytes), or for V4 pools the 32-byte pool id.
    pub pool_address: Bytes,
    pub pool_type: PoolType,
    pub token_a: Address,
    pub token_b: Address,
    pub fee_bps: i64,
    /// PoolState.variant === 'algebra' (Algebra Integral copies).
    pub algebra: bool,
    /// V3 liquidity (lender choice only).
    pub liquidity: Option<U256>,
    pub v4: Option<V4Info>,
}

/// One hop in the contract's format (ExecutorHop in the TS).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutorHop {
    pub kind: i64,
    /// KIND_V4: the PoolManager. KIND_V4_HOOKED: the hook contract.
    pub pool: Address,
    pub token_in: Address,
    pub token_out: Address,
    pub fee_bps: i64,
    /// V4 kinds only (0 / false otherwise).
    pub v4_fee: i64,
    pub v4_tick_spacing: i64,
    pub v4_native: bool,
    /// KIND_V4_HOOKED only, NOT sent to the contract (simulator's use).
    pub v4_pool_manager: Option<Address>,
}

/// How a trade is funded (Funding in the TS).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Funding {
    /// Contract's own balance: execute(trade, address(0)).
    Own,
    /// Aave flash loan: execute(trade, aavePool).
    Aave(Address),
    /// V3 pool flash loan: executeWithV3Flash(trade, lendPool).
    V3Flash(Address),
}

impl Funding {
    pub fn name(&self) -> &'static str {
        match self {
            Funding::Own => "own",
            Funding::Aave(_) => "aave",
            Funding::V3Flash(_) => "v3-flash",
        }
    }
    /// The lender address (zero for own money), like BuildResult.flashPool.
    pub fn lender(&self) -> Address {
        match self {
            Funding::Own => Address::ZERO,
            Funding::Aave(a) | Funding::V3Flash(a) => *a,
        }
    }
}

/// The trade the contract runs (the `t` argument).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Trade {
    pub token: Address,
    pub amount_in: U256,
    pub min_profit: U256,
    pub max_block: U256,
    pub hops: Vec<ExecutorHop>,
}

/// Why no calldata was built.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallErr {
    /// The TS returns {ok:false, reason} with this exact text.
    Refused(String),
    /// The TS would throw (value out of ABI range, unusable address).
    Invalid(String),
}

impl std::fmt::Display for CallErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallErr::Refused(r) => write!(f, "{r}"),
            CallErr::Invalid(r) => write!(f, "invalid value: {r}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Pool kinds
// ---------------------------------------------------------------------------
/// True for a V4 pool with a real (non-zero) hook address.
pub fn is_hooked_v4(pool: &PoolInfo) -> bool {
    matches!(&pool.v4, Some(v) if matches!(v.hooks, Some(h) if h != Address::ZERO))
}

/// Which contract "kind" a pool maps to, or None if the contract can't trade it.
pub fn kind_for_pool(pool: &PoolInfo) -> Option<i64> {
    let dex = pool.dex.to_lowercase();
    if UNSUPPORTED_DEXES.contains(&dex.as_str()) {
        return None;
    }
    let hooked = is_hooked_v4(pool);
    if dex == "uniswap-v4" {
        return pool.v4.as_ref().map(|_| if hooked { KIND_V4_HOOKED } else { KIND_V4 });
    }
    // Algebra Integral copies trade as an ordinary V3 hop (same swap inputs).
    if pool.algebra {
        return if pool.v4.is_some() { None } else { Some(KIND_V3) };
    }
    // Other pools with V4 details: hooked (Fables) only.
    if pool.v4.is_some() {
        return if hooked { Some(KIND_V4_HOOKED) } else { None };
    }
    match pool.pool_type {
        PoolType::V3 => Some(KIND_V3),
        PoolType::V2 => Some(if SOLIDLY_DEXES.contains(&dex.as_str()) { KIND_SOLIDLY } else { KIND_V2 }),
        PoolType::Orderbook | PoolType::Stable => None,
    }
}

const UINT24_MAX: i64 = 0xff_ffff;
const INT24_MIN: i64 = -(1 << 23);
const INT24_MAX: i64 = (1 << 23) - 1;

/// Does the V4 key we would send hash to the pool's id? (v4KeyMatchesId)
/// currency0 = native ETH (zero) for native pools else tokenA; currency1 =
/// tokenB; the registered fee field; tick spacing; hook (zero if none).
pub fn v4_key_matches_id(pool: &PoolInfo) -> bool {
    let Some(v4) = &pool.v4 else { return false };
    // Out-of-range fee / tick spacing: the ABI encoder throws -> false.
    if !(0..=UINT24_MAX).contains(&v4.fee) || !(INT24_MIN..=INT24_MAX).contains(&v4.tick_spacing) {
        return false;
    }
    let c0 = if v4.native { Address::ZERO } else { pool.token_a };
    let hooks = if is_hooked_v4(pool) { v4.hooks.unwrap_or(Address::ZERO) } else { Address::ZERO };
    let mut buf = [0u8; 160];
    put_address(&mut buf[0..32], c0);
    put_address(&mut buf[32..64], pool.token_b);
    put_u64(&mut buf[64..96], v4.fee as u64);
    put_i64(&mut buf[96..128], v4.tick_spacing);
    put_address(&mut buf[128..160], hooks);
    let id = keccak256(buf);
    pool.pool_address.len() == 32 && pool.pool_address[..] == id[..]
}

/// The other token in a two-token pool.
fn other_token(pool: &PoolInfo, token: Address) -> Option<Address> {
    if pool.token_a == token {
        Some(pool.token_b)
    } else if pool.token_b == token {
        Some(pool.token_a)
    } else {
        None
    }
}

fn pool_as_address(pool: &PoolInfo) -> Result<Address, CallErr> {
    if pool.pool_address.len() != 20 {
        return Err(CallErr::Invalid("pool address is not 20 bytes".into()));
    }
    Ok(Address::from_slice(&pool.pool_address))
}

/// One hop of the route in the contract's format (hopFor).
pub fn hop_for(kind: i64, pool: &PoolInfo, token_in: Address, token_out: Address) -> Result<ExecutorHop, CallErr> {
    if kind == KIND_V4 || kind == KIND_V4_HOOKED {
        let v4 = pool.v4.as_ref().ok_or_else(|| CallErr::Invalid("V4 hop without V4 details".into()))?;
        let target = if kind == KIND_V4 {
            v4.pool_manager
        } else {
            v4.hooks.ok_or_else(|| CallErr::Invalid("hooked V4 hop without a hook".into()))?
        };
        return Ok(ExecutorHop {
            kind,
            pool: target,
            token_in,
            token_out,
            fee_bps: 0,
            v4_fee: v4.fee,
            v4_tick_spacing: v4.tick_spacing,
            v4_native: v4.native,
            v4_pool_manager: if kind == KIND_V4_HOOKED { Some(v4.pool_manager) } else { None },
        });
    }
    Ok(ExecutorHop {
        kind,
        pool: pool_as_address(pool)?,
        token_in,
        token_out,
        fee_bps: if kind == KIND_V2 { pool.fee_bps } else { 0 },
        v4_fee: 0,
        v4_tick_spacing: 0,
        v4_native: false,
        v4_pool_manager: None,
    })
}

// ---------------------------------------------------------------------------
// USD -> token units (usdToTokenUnits), bit-exact with JavaScript
// ---------------------------------------------------------------------------
/// Result of usd_to_token_units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Units {
    /// The amount (fits uint256).
    Exact(U256),
    /// Non-zero but bigger than uint256: the TS gets a bigint the ABI
    /// encoder later refuses (throws).
    TooBig,
    /// The TS itself throws (BigInt(Infinity): tokens * 1e9 overflowed).
    Throws,
}

impl Units {
    /// True when the TS value is 0n.
    pub fn is_zero(&self) -> bool {
        matches!(self, Units::Exact(v) if v.is_zero())
    }
}

/// Wide enough for floor(f64::MAX) * 10^78 (1024 + 260 bits).
type Wide = Uint<1600, 25>;

/// An integer-valued, finite, non-negative f64 as a wide integer (exact).
fn f64_int_to_wide(x: f64) -> Wide {
    let b = x.to_bits();
    let exp = ((b >> 52) & 0x7ff) as i64;
    if exp == 0 {
        return Wide::ZERO; // zero or subnormal (< 1, already floored to 0)
    }
    let mant = (b & ((1u64 << 52) - 1)) | (1u64 << 52);
    let e = exp - 1075;
    let m = Wide::from(mant);
    if e >= 0 {
        m << (e as usize)
    } else {
        m >> ((-e) as usize)
    }
}

/// Converts a USD amount into token base units, rounding DOWN, exactly like
/// the TS: tokens = usd / usdPerToken (f64), scaled = floor(tokens * 1e9)
/// (f64), then scaled * 10^(decimals-9) or scaled / 10^(9-decimals) (bigint).
pub fn usd_to_token_units(usd: f64, usd_per_token: f64, decimals: u32) -> Units {
    // `!(usd > 0)` also catches NaN, like the TS.
    if !(usd > 0.0) || !(usd_per_token > 0.0) || !(usd / usd_per_token).is_finite() {
        return Units::Exact(U256::ZERO);
    }
    let tokens = usd / usd_per_token;
    let scaled_f = (tokens * 1e9).floor();
    if !scaled_f.is_finite() {
        return Units::Throws;
    }
    let scaled = f64_int_to_wide(scaled_f);
    const PRECISION: u32 = 9;
    let wide = if decimals >= PRECISION {
        let p = decimals - PRECISION;
        if scaled.is_zero() {
            Wide::ZERO
        } else if p > 78 {
            return Units::TooBig; // >= 10^79 > uint256 max
        } else {
            match Wide::from(10u64).checked_pow(Wide::from(p)).and_then(|m| scaled.checked_mul(m)) {
                Some(v) => v,
                None => return Units::TooBig,
            }
        }
    } else {
        scaled / Wide::from(10u64).pow(Wide::from(PRECISION - decimals))
    };
    if wide.bit_len() > 256 {
        return Units::TooBig;
    }
    Units::Exact(U256::from_limbs_slice(&wide.as_limbs()[..4]))
}

// ---------------------------------------------------------------------------
// ABI encoding
// ---------------------------------------------------------------------------
#[inline]
fn put_address(w: &mut [u8], a: Address) {
    w[..12].fill(0);
    w[12..32].copy_from_slice(a.as_slice());
}
#[inline]
fn put_u64(w: &mut [u8], v: u64) {
    w[..24].fill(0);
    w[24..32].copy_from_slice(&v.to_be_bytes());
}
#[inline]
fn put_i64(w: &mut [u8], v: i64) {
    let fill = if v < 0 { 0xff } else { 0 };
    w[..24].fill(fill);
    w[24..32].copy_from_slice(&v.to_be_bytes());
}
#[inline]
fn put_u256(w: &mut [u8], v: U256) {
    w.copy_from_slice(&v.to_be_bytes::<32>());
}

fn check_range(name: &str, v: i64, lo: i64, hi: i64) -> Result<(), CallErr> {
    if v < lo || v > hi {
        return Err(CallErr::Invalid(format!("{name}={v} out of range")));
    }
    Ok(())
}

/// encode(selector, t, addr): the shared layout of execute / executeWithV3Flash.
fn encode_call(selector: [u8; 4], trade: &Trade, second: Address) -> Result<Vec<u8>, CallErr> {
    // Validate first (the TS encoder throws on any out-of-range field).
    for h in &trade.hops {
        check_range("kind", h.kind, 0, 255)?;
        check_range("feeBps", h.fee_bps, 0, 0xffff)?;
        check_range("v4Fee", h.v4_fee, 0, UINT24_MAX)?;
        check_range("v4TickSpacing", h.v4_tick_spacing, INT24_MIN, INT24_MAX)?;
    }
    let n = trade.hops.len();
    // selector + 2 head words + 5 tuple words + length + 8 words per hop
    let mut out = vec![0u8; 4 + 32 * (2 + 5 + 1 + 8 * n)];
    out[..4].copy_from_slice(&selector);
    let w = &mut out[4..];
    put_u64(&mut w[0..32], 0x40); // offset of t (dynamic tuple)
    put_address(&mut w[32..64], second);
    let t = &mut w[64..];
    put_address(&mut t[0..32], trade.token);
    put_u256(&mut t[32..64], trade.amount_in);
    put_u256(&mut t[64..96], trade.min_profit);
    put_u256(&mut t[96..128], trade.max_block);
    put_u64(&mut t[128..160], 0xa0); // offset of hops inside t
    put_u64(&mut t[160..192], n as u64);
    for (i, h) in trade.hops.iter().enumerate() {
        let o = 192 + i * 256;
        let hw = &mut t[o..o + 256];
        put_u64(&mut hw[0..32], h.kind as u64);
        put_address(&mut hw[32..64], h.pool);
        put_address(&mut hw[64..96], h.token_in);
        put_address(&mut hw[96..128], h.token_out);
        put_u64(&mut hw[128..160], h.fee_bps as u64);
        put_u64(&mut hw[160..192], h.v4_fee as u64);
        put_i64(&mut hw[192..224], h.v4_tick_spacing);
        put_u64(&mut hw[224..256], h.v4_native as u64);
    }
    Ok(out)
}

/// execute(trade, flashPool) from explicit values (encodeExecuteRaw).
/// flashPool zero = own money.
pub fn encode_execute_raw(trade: &Trade, flash_pool: Address) -> Result<Vec<u8>, CallErr> {
    encode_call(EXECUTE_SELECTOR, trade, flash_pool)
}

/// executeWithV3Flash(trade, lendPool) (encodeExecuteV3FlashRaw).
pub fn encode_execute_v3_flash_raw(trade: &Trade, lend_pool: Address) -> Result<Vec<u8>, CallErr> {
    encode_call(EXECUTE_V3_FLASH_SELECTOR, trade, lend_pool)
}

/// The right entry point for a funding choice.
pub fn encode_for_funding(trade: &Trade, funding: Funding) -> Result<Vec<u8>, CallErr> {
    match funding {
        Funding::V3Flash(l) => encode_execute_v3_flash_raw(trade, l),
        Funding::Aave(p) => encode_execute_raw(trade, p),
        Funding::Own => encode_execute_raw(trade, Address::ZERO),
    }
}

// ---------------------------------------------------------------------------
// buildExecuteCall (2-pool plan: buy on one pool, sell on the other)
// ---------------------------------------------------------------------------
/// BuildInput in the TS (chain is not needed to build bytes).
#[derive(Clone, Debug)]
pub struct BuildInput {
    pub token_in: Address,
    pub buy_pool: PoolInfo,
    pub sell_pool: PoolInfo,
    pub trade_size_usd: f64,
    /// Used as the on-chain profit floor.
    pub net_profit_usd: f64,
    pub usd_per_token_in: f64,
    /// Must be known; None = refuse.
    pub token_in_decimals: Option<u32>,
    pub max_block: U256,
    pub executor_address: Option<Address>,
    /// Aave V3 Pool, if borrowing from Aave.
    pub flash_pool: Option<Address>,
    /// V3 pool to borrow from (preferred when set).
    pub v3_lender: Option<Address>,
}

/// A successful build (BuildResult ok:true).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Built {
    pub to: Option<Address>,
    pub data: Vec<u8>,
    pub amount_in: U256,
    pub min_profit: U256,
    pub funding: Funding,
    pub hops: Vec<ExecutorHop>,
}

fn units_or_invalid(u: Units, what: &str) -> Result<U256, CallErr> {
    match u {
        Units::Exact(v) => Ok(v),
        Units::TooBig => Err(CallErr::Invalid(format!("{what} over uint256"))),
        Units::Throws => Err(CallErr::Invalid(format!("{what}: amount not finite"))),
    }
}

/// Port of buildExecuteCall: same checks, same order, same reasons.
pub fn build_execute_call(input: &BuildInput) -> Result<Built, CallErr> {
    let (buy, sell) = (&input.buy_pool, &input.sell_pool);
    let refuse = |s: String| Err(CallErr::Refused(s));

    // 1. Both pools must be tradeable by the contract.
    let Some(buy_kind) = kind_for_pool(buy) else {
        return refuse(format!("buy pool not supported by contract ({}/{})", buy.dex, buy.pool_type.as_str()));
    };
    let Some(sell_kind) = kind_for_pool(sell) else {
        return refuse(format!("sell pool not supported by contract ({}/{})", sell.dex, sell.pool_type.as_str()));
    };
    for (k, p, side) in [(buy_kind, buy, "buy"), (sell_kind, sell, "sell")] {
        if k == KIND_V4_HOOKED && !v4_key_matches_id(p) {
            let (fee, ts) = p.v4.as_ref().map(|v| (v.fee, v.tick_spacing)).unwrap_or_default();
            return refuse(format!(
                "{side} pool: hooked V4 key (tokens, fee {fee}, tick spacing {ts}, hook) does not match its pool id"
            ));
        }
    }

    // 2. Route must chain: tokenIn -> mid on buy, mid -> tokenIn on sell.
    let Some(mid) = other_token(buy, input.token_in) else {
        return refuse("tokenIn is not in the buy pool".into());
    };
    if other_token(sell, mid) != Some(input.token_in) {
        return refuse("sell pool does not trade the same pair back to tokenIn".into());
    }

    // 3. Amounts, only with explicitly known decimals.
    let Some(dec) = input.token_in_decimals else {
        return refuse(format!("unknown decimals for {:#x}", input.token_in));
    };
    let amount_u = usd_to_token_units(input.trade_size_usd, input.usd_per_token_in, dec);
    if amount_u == Units::Throws {
        return Err(CallErr::Invalid("trade size: amount not finite".into()));
    }
    if amount_u.is_zero() {
        return refuse("trade size rounds to zero tokens".into());
    }
    let profit_u = usd_to_token_units(input.net_profit_usd, input.usd_per_token_in, dec);
    if profit_u == Units::Throws {
        return Err(CallErr::Invalid("profit floor: amount not finite".into()));
    }
    if profit_u.is_zero() {
        return refuse("profit floor rounds to zero tokens".into());
    }

    let hops = vec![hop_for(buy_kind, buy, input.token_in, mid)?, hop_for(sell_kind, sell, mid, input.token_in)?];

    // Prefer a V3 pool flash loan, then Aave, then own capital.
    let funding = if let Some(l) = input.v3_lender {
        if hops.iter().any(|h| h.pool == l) {
            return refuse("lender pool is also a trade pool".into());
        }
        Funding::V3Flash(l)
    } else {
        match input.flash_pool {
            Some(p) if p != Address::ZERO => Funding::Aave(p),
            _ => Funding::Own,
        }
    };
    // Out-of-range amounts throw in the TS encoder (after the checks above).
    let amount_in = units_or_invalid(amount_u, "amountIn")?;
    let min_profit = units_or_invalid(profit_u, "minProfit")?;
    let trade = Trade { token: input.token_in, amount_in, min_profit, max_block: input.max_block, hops };
    let data = encode_for_funding(&trade, funding)?;
    Ok(Built { to: input.executor_address, data, amount_in, min_profit, funding, hops: trade.hops })
}

// ---------------------------------------------------------------------------
// pickV3Lender
// ---------------------------------------------------------------------------
/// Chooses which V3 pool to borrow `token` from (pickV3Lender): a V3 pool of
/// an exchange whose flash callback the contract supports, holding the token,
/// not excluded, with liquidity > 0 and (if `can_lend` is given) enough of
/// the token. Lowest fee first, then most liquidity; ties keep input order.
pub fn pick_v3_lender<'a>(
    candidates: &'a [PoolInfo],
    token: Address,
    exclude: &[Bytes],
    can_lend: Option<&dyn Fn(&PoolInfo, Address) -> bool>,
) -> Option<&'a PoolInfo> {
    let mut ok: Vec<&PoolInfo> = candidates
        .iter()
        .filter(|p| {
            p.pool_type == PoolType::V3
                && FLASH_LENDER_DEXES.contains(&p.dex.to_lowercase().as_str())
                && !exclude.iter().any(|e| e[..] == p.pool_address[..])
                && (p.token_a == token || p.token_b == token)
                && p.liquidity.unwrap_or(U256::ZERO) > U256::ZERO
                && can_lend.map_or(true, |f| f(p, token))
        })
        .collect();
    // Stable sort (like V8's Array.prototype.sort).
    ok.sort_by(|a, b| a.fee_bps.cmp(&b.fee_bps).then_with(|| b.liquidity.cmp(&a.liquidity)));
    ok.first().copied()
}

/// keccak of a signature's first 4 bytes (used by tests and the L1 gas call).
pub fn selector_of(sig: &str) -> [u8; 4] {
    let h: B256 = keccak256(sig.as_bytes());
    [h[0], h[1], h[2], h[3]]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selectors_match_the_contract() {
        assert_eq!(selector_of(EXECUTE_SIG), EXECUTE_SELECTOR);
        assert_eq!(selector_of(EXECUTE_V3_FLASH_SIG), EXECUTE_V3_FLASH_SELECTOR);
    }

    #[test]
    fn units_basic() {
        // $1000 at $0.50 with 18 decimals = 2000e18.
        let v = usd_to_token_units(1000.0, 0.5, 18);
        assert_eq!(v, Units::Exact(U256::from(2000u64) * U256::from(10u64).pow(U256::from(18u64))));
        assert!(usd_to_token_units(0.0, 1.0, 18).is_zero());
        assert!(usd_to_token_units(f64::NAN, 1.0, 18).is_zero());
        assert!(usd_to_token_units(1.0, 0.0, 18).is_zero());
        // 6 decimals rounds down below 1e-6.
        assert!(usd_to_token_units(1e-7, 1.0, 6).is_zero());
        assert_eq!(usd_to_token_units(1e300, 1e-8, 0), Units::Throws);
    }

    #[test]
    fn negative_tick_is_sign_extended() {
        let hop = ExecutorHop {
            kind: KIND_V4,
            pool: Address::ZERO,
            token_in: Address::ZERO,
            token_out: Address::ZERO,
            fee_bps: 0,
            v4_fee: 500,
            v4_tick_spacing: -10,
            v4_native: true,
            v4_pool_manager: None,
        };
        let t = Trade { token: Address::ZERO, amount_in: U256::from(1u64), min_profit: U256::from(1u64), max_block: U256::ZERO, hops: vec![hop] };
        let d = encode_execute_raw(&t, Address::ZERO).unwrap();
        let tick_word = &d[4 + 64 + 192 + 192..4 + 64 + 192 + 224];
        assert!(tick_word[..31].iter().all(|b| *b == 0xff));
        assert_eq!(tick_word[31], 0xf6);
    }
}
