// ============================================================================
// LIVE ROUTES: how a real buy or sell is built for each venue (V3, V4, V2).
//
// Plain English:
//   The paper trader trades three kinds of Uniswap pool. This file turns
//   "swap X of coin A into coin B in this pool" into the exact transactions
//   the live wallet signs. It only BUILDS bytes; sending lives in live.rs and
//   the decisions live in livetrade.rs. Every swap carries a minimum output
//   and a deadline, and every allowance is for the exact amount of that one
//   swap (never "unlimited").
//
//   V3  (unchanged, proven by the eth_account test vector in live.rs)
//       approve(SwapRouter02, exact amount) + SwapRouter02 exactInputSingle.
//
//   V4  Uniswap's Universal Router: execute(commands, inputs, deadline) with
//       one V4_SWAP command (0x10) whose little "program" is
//         SWAP_EXACT_IN_SINGLE  swap in this exact pool, at least min out
//         SETTLE_ALL            pay what we owe (at most amount in)
//         TAKE_ALL              collect what we bought (at least min out)
//       Coins are paid through Permit2 (Uniswap's allowance contract):
//         1. coin.approve(Permit2, exact amount)
//         2. Permit2.approve(coin, router, exact amount, expires in 10 min)
//         3. router.execute(...)
//       Native ETH (V4 pools can hold real ETH) needs no approval: the ETH is
//       sent with the swap, exactly the amount swapped (nothing left behind
//       in the router).
//       Pools whose hook can change swap amounts are refused (same rule as
//       paper, venue::hook_changes_amounts).
//
//   V2  the same Universal Router, command V2_SWAP_EXACT_IN (0x08), paid
//       through Permit2 the same way. OFF by default (SNIPER_LIVE_VENUES):
//       nothing proves yet that this router's built-in V2 factory is the
//       one paper prices (the router computes the pair itself). A passing
//       `sniper live-dryrun <V2 pair>` is that proof; turn V2 on only after.
//
// ROUTER ADDRESS (the decision, and how it was checked):
//   Uniswap's own deployment list (developers.uniswap.org, "Uniswap v4
//   Deployments", Robinhood Chain 4663) lists:
//     Universal Router        0x8876789976decbfcbbbe364623c63652db8c0904
//     Universal Router 2.1.2  0x204faca1764b154221e35c0d20abb3c525710498
//     PoolManager             0x8366a39cc670b4001a1121b8f6a443a643e40951
//     Permit2                 0x000000000022D473030F116dDEE9F6B43aC78BA3
//     V4 Quoter               0x8dc178efb8111bb0973dd9d722ebeff267c98f94
//   The PoolManager and Quoter match the ones the sniper already uses, and
//   the dex bot's address book (src/config/knownAddresses.ts ROBINHOOD_V4)
//   has 0x8876... as its UNIVERSAL_ROUTER, so the default is 0x8876...
//   SNIPER_LIVE_UR overrides it.
//
//   Router versions differ in ONE field of the V4 swap step: from 2.1 the
//   single-pool swap carries an extra number (a per-hop price floor,
//   minHopPriceX36) right before hookData. The dex bot's feed reader sees
//   both shapes on Robinhood (src/core/decoderV4Router.ts). The unversioned
//   router (0x8876) is taken as the 2.0 shape; 2.1.2 (0x204f) as the 2.1
//   shape, with the floor set to 0 (no extra check; amountOutMinimum still
//   protects us). Any other address needs SNIPER_LIVE_UR_LAYOUT. A wrong
//   shape cannot lose money: the router cannot read the swap and reverts.
//   The live-dryrun on a V4 pool whose currency0 is a real coin (not native
//   ETH) is what proves the shape on the real chain; we could not reach the
//   chain from the build machine.
// ============================================================================
use ruint::aliases::U256;
use serde_json::{json, Value};

use crate::live::{self, addr_bytes};
use crate::venue::{self, Venue, VenueKind, V4Key, NATIVE_ETH};

/// Uniswap Universal Router on Robinhood Chain (Uniswap v4 deployments page).
pub const UNIVERSAL_ROUTER: &str = "0x8876789976decbfcbbbe364623c63652db8c0904";
/// Universal Router 2.1.2 on Robinhood Chain (same page).
pub const UNIVERSAL_ROUTER_2_1_2: &str = "0x204faca1764b154221e35c0d20abb3c525710498";
/// Permit2 (same address on every chain; Uniswap deployments page).
pub const PERMIT2: &str = "0x000000000022d473030f116ddee9f6b43ac78ba3";

/// Universal Router commands (universal-router Commands.sol, v2.x).
pub const CMD_V2_SWAP_EXACT_IN: u8 = 0x08;
pub const CMD_V4_SWAP: u8 = 0x10;
/// V4 router actions (v4-periphery Actions.sol).
pub const ACT_SWAP_EXACT_IN_SINGLE: u8 = 0x06;
pub const ACT_SETTLE_ALL: u8 = 0x0c;
pub const ACT_TAKE_ALL: u8 = 0x0f;

/// How long a Permit2 allowance stays valid (seconds). Short on purpose:
/// it is for this one swap only. (0 would mean "this block only" in Permit2.)
pub const PERMIT2_EXPIRY_SECS: u64 = 600;
/// Gas limits (generous; unused gas is not charged).
pub const GAS_PERMIT2_APPROVE: u64 = 100_000;
pub const GAS_UR_SWAP: u64 = 600_000;
/// Default live venues: V2 stays off until a V2 dry-run has passed.
pub const DEFAULT_LIVE_VENUES: &str = "v3,v4";

// ---------------------------------------------------------------------------
// Router setting
// ---------------------------------------------------------------------------

/// Which shape the router expects for a V4 single-pool swap.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UrLayout {
    /// Universal Router 2.0: (key, zeroForOne, amountIn, amountOutMin, hookData).
    Ur20,
    /// Universal Router 2.1+: one extra uint256 (minHopPriceX36) before hookData.
    Ur21,
}

impl UrLayout {
    pub fn name(self) -> &'static str {
        match self {
            UrLayout::Ur20 => "2.0",
            UrLayout::Ur21 => "2.1",
        }
    }
}

/// The router live V4/V2 trades go through, and its shape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouterCfg {
    pub address: String,
    pub layout: UrLayout,
}

/// The shape of a router we know from Uniswap's deployment list.
pub fn known_layout(addr: &str) -> Option<UrLayout> {
    if addr.eq_ignore_ascii_case(UNIVERSAL_ROUTER) {
        Some(UrLayout::Ur20)
    } else if addr.eq_ignore_ascii_case(UNIVERSAL_ROUTER_2_1_2) {
        Some(UrLayout::Ur21)
    } else {
        None
    }
}

impl Default for RouterCfg {
    fn default() -> Self {
        RouterCfg { address: UNIVERSAL_ROUTER.into(), layout: UrLayout::Ur20 }
    }
}

impl RouterCfg {
    /// SNIPER_LIVE_UR (address, default the official router) and
    /// SNIPER_LIVE_UR_LAYOUT ("2.0" / "2.1"). A known router's shape can't
    /// be overridden with the wrong one; an unknown router must say its shape.
    pub fn from_lookup(get: &dyn Fn(&str) -> Option<String>) -> Result<RouterCfg, String> {
        let address = get("SNIPER_LIVE_UR").map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()).unwrap_or_else(|| UNIVERSAL_ROUTER.into());
        addr_bytes(&address).map_err(|_| format!("SNIPER_LIVE_UR is not an address ({} characters)", address.len()))?;
        let asked = match get("SNIPER_LIVE_UR_LAYOUT").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).as_deref() {
            None => None,
            Some("2.0") => Some(UrLayout::Ur20),
            Some("2.1") => Some(UrLayout::Ur21),
            Some(x) => return Err(format!("SNIPER_LIVE_UR_LAYOUT '{x}' must be 2.0 or 2.1")),
        };
        let layout = match (known_layout(&address), asked) {
            (Some(k), Some(a)) if k != a => return Err(format!("SNIPER_LIVE_UR_LAYOUT {} does not match router {address} (it is {})", a.name(), k.name())),
            (Some(k), _) => k,
            (None, Some(a)) => a,
            (None, None) => return Err(format!("router {address} is not in Uniswap's Robinhood list: set SNIPER_LIVE_UR_LAYOUT (2.0 or 2.1) and dry-run it first")),
        };
        Ok(RouterCfg { address, layout })
    }
}

/// SNIPER_LIVE_VENUES (default v3,v4).
pub fn live_venues_from(get: &dyn Fn(&str) -> Option<String>) -> Result<Vec<VenueKind>, String> {
    venue::parse_venues(&get("SNIPER_LIVE_VENUES").unwrap_or_else(|| DEFAULT_LIVE_VENUES.into())).map_err(|e| e.replace("SNIPER_VENUES", "SNIPER_LIVE_VENUES"))
}

// ---------------------------------------------------------------------------
// One transaction to send
// ---------------------------------------------------------------------------

/// One transaction before signing: where, what, gas limit, ETH sent, and a
/// plain label for logs ("approve WETH to Permit2").
#[derive(Clone, Debug, PartialEq)]
pub struct LiveTx {
    pub label: String,
    pub to: String,
    pub data: Vec<u8>,
    pub gas: u64,
    pub value: U256,
}

impl LiveTx {
    fn new(label: &str, to: &str, data: Vec<u8>, gas: u64) -> LiveTx {
        LiveTx { label: label.into(), to: to.to_ascii_lowercase(), data, gas, value: U256::ZERO }
    }
}

// ---------------------------------------------------------------------------
// ABI encoding (just the shapes we need; checked against Python eth_abi)
// ---------------------------------------------------------------------------

/// One value of a tuple: a fixed 32-byte word, or a dynamic value already
/// encoded (its "tail"), which the tuple points to with an offset.
enum Part {
    W([u8; 32]),
    D(Vec<u8>),
}

fn w_u(v: U256) -> [u8; 32] {
    v.to_be_bytes::<32>()
}

fn w_n(v: u64) -> [u8; 32] {
    w_u(U256::from(v))
}

fn w_addr(a: &str) -> Result<[u8; 32], String> {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(&addr_bytes(a)?);
    Ok(w)
}

/// A signed 24-bit number (int24) as a word, sign-extended.
fn w_i(v: i64) -> [u8; 32] {
    if v >= 0 {
        w_n(v as u64)
    } else {
        w_u(U256::MAX - U256::from(v.unsigned_abs()) + U256::from(1u64))
    }
}

/// abi.encode of a tuple: heads (words or offsets) then the tails.
fn tuple(parts: &[Part]) -> Vec<u8> {
    let head_len = 32 * parts.len();
    let (mut head, mut tail) = (Vec::new(), Vec::new());
    for p in parts {
        match p {
            Part::W(w) => head.extend_from_slice(w),
            Part::D(d) => {
                head.extend_from_slice(&w_n((head_len + tail.len()) as u64));
                tail.extend_from_slice(d);
            }
        }
    }
    head.extend(tail);
    head
}

/// `bytes`: length, then the bytes padded to 32.
fn bytes_part(b: &[u8]) -> Part {
    let mut d = w_n(b.len() as u64).to_vec();
    d.extend_from_slice(b);
    d.extend(std::iter::repeat_n(0u8, (32 - b.len() % 32) % 32));
    Part::D(d)
}

/// `bytes[]`: count, then a tuple of the items.
fn bytes_array_part(items: &[Vec<u8>]) -> Part {
    let mut d = w_n(items.len() as u64).to_vec();
    d.extend(tuple(&items.iter().map(|b| bytes_part(b)).collect::<Vec<_>>()));
    Part::D(d)
}

fn selector(sig: &str) -> Vec<u8> {
    crate::fourmeme::keccak(sig.as_bytes())[..4].to_vec()
}

/// Universal Router execute(bytes commands, bytes[] inputs, uint256 deadline).
pub fn data_execute(commands: &[u8], inputs: &[Vec<u8>], deadline: u64) -> Vec<u8> {
    let mut d = selector("execute(bytes,bytes[],uint256)");
    d.extend(tuple(&[bytes_part(commands), bytes_array_part(inputs), Part::W(w_n(deadline))]));
    d
}

fn check_u128(x: U256, what: &str) -> Result<(), String> {
    if x > U256::from(u128::MAX) {
        return Err(format!("{what} too large for uint128"));
    }
    Ok(())
}

/// The V4_SWAP command's input: abi.encode(bytes actions, bytes[] params)
/// for SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_ALL.
pub fn v4_swap_input(key: &V4Key, zero_for_one: bool, amount_in: U256, min_out: U256, layout: UrLayout) -> Result<Vec<u8>, String> {
    check_u128(amount_in, "amount in")?;
    check_u128(min_out, "minimum out")?;
    // ExactInputSingleParams { PoolKey poolKey; bool zeroForOne; uint128
    // amountIn; uint128 amountOutMinimum; [uint256 minHopPriceX36;] bytes
    // hookData } - a struct with a `bytes` in it, so it is encoded behind an
    // offset (word 0 = 0x20).
    let mut fields = vec![
        Part::W(w_addr(&key.currency0)?),
        Part::W(w_addr(&key.currency1)?),
        Part::W(w_n(key.fee as u64)),
        Part::W(w_i(key.tick_spacing as i64)),
        Part::W(w_addr(&key.hooks)?),
        Part::W(w_n(zero_for_one as u64)),
        Part::W(w_u(amount_in)),
        Part::W(w_u(min_out)),
    ];
    if layout == UrLayout::Ur21 {
        fields.push(Part::W(w_n(0))); // minHopPriceX36 = 0: no extra floor
    }
    fields.push(bytes_part(&[])); // hookData: none
    let swap = tuple(&[Part::D(tuple(&fields))]);
    let (cin, cout) = if zero_for_one { (&key.currency0, &key.currency1) } else { (&key.currency1, &key.currency0) };
    let settle = tuple(&[Part::W(w_addr(cin)?), Part::W(w_u(amount_in))]);
    let take = tuple(&[Part::W(w_addr(cout)?), Part::W(w_u(min_out))]);
    Ok(tuple(&[bytes_part(&[ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL]), bytes_array_part(&[swap, settle, take])]))
}

/// The V2_SWAP_EXACT_IN command's input (router 2.0 shape):
/// abi.encode(recipient, amountIn, amountOutMin, address[] path, payerIsUser).
pub fn v2_swap_input(recipient: &str, amount_in: U256, min_out: U256, token_in: &str, token_out: &str) -> Result<Vec<u8>, String> {
    let mut path = w_n(2).to_vec();
    path.extend(w_addr(token_in)?);
    path.extend(w_addr(token_out)?);
    Ok(tuple(&[Part::W(w_addr(recipient)?), Part::W(w_u(amount_in)), Part::W(w_u(min_out)), Part::D(path), Part::W(w_n(1))]))
}

/// Permit2.approve(token, spender, uint160 amount, uint48 expiration).
pub fn data_permit2_approve(token: &str, spender: &str, amount: U256, expiration: u64) -> Result<Vec<u8>, String> {
    if amount >= (U256::from(1u64) << 160) {
        return Err("amount too large for a Permit2 allowance (uint160)".into());
    }
    if expiration >= (1u64 << 48) {
        return Err("Permit2 expiry too large (uint48)".into());
    }
    let mut d = selector("approve(address,address,uint160,uint48)");
    d.extend(w_addr(token)?);
    d.extend(w_addr(spender)?);
    d.extend(w_u(amount));
    d.extend(w_n(expiration));
    Ok(d)
}

// ---------------------------------------------------------------------------
// Approvals and the full transaction list for one swap
// ---------------------------------------------------------------------------

/// How a venue takes the coin we pay with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pay {
    /// ERC-20 approve straight to this contract (V3: SwapRouter02).
    Direct(String),
    /// ERC-20 approve to Permit2, then Permit2 approve to this router.
    Permit2(String),
    /// Native ETH sent with the swap: no approval.
    Native,
}

/// Approval transactions for paying `amount` of `token`, exact amounts only.
/// `now` = unix seconds (the Permit2 allowance expires PERMIT2_EXPIRY_SECS later).
pub fn approvals(pay: &Pay, token: &str, sym: &str, amount: U256, now: u64) -> Result<Vec<LiveTx>, String> {
    Ok(match pay {
        Pay::Native => vec![],
        Pay::Direct(spender) => vec![LiveTx::new(&format!("approve {sym} to router (exact)"), token, live::data_approve(spender, amount)?, live::GAS_APPROVE)],
        Pay::Permit2(router) => vec![
            LiveTx::new(&format!("approve {sym} to Permit2 (exact)"), token, live::data_approve(PERMIT2, amount)?, live::GAS_APPROVE),
            LiveTx::new(&format!("Permit2: allow router to take {sym} (exact, 10 min)"), PERMIT2, data_permit2_approve(token, router, amount, now + PERMIT2_EXPIRY_SECS)?, GAS_PERMIT2_APPROVE),
        ],
    })
}

/// Why live mode must not trade this venue (None = it may). Same safety
/// rules as paper plus the live switches.
pub fn venue_refusal(v: &Venue, base: &str, live_venues: &[VenueKind], router: &RouterCfg) -> Option<String> {
    let kind = v.kind();
    if !live_venues.contains(&kind) {
        let on: Vec<&str> = live_venues.iter().map(|k| k.name()).collect();
        return Some(format!("live trading of Uniswap {} is off (SNIPER_LIVE_VENUES={})", kind.name().to_ascii_uppercase(), on.join(",")));
    }
    match v {
        Venue::V4 { key } if venue::hook_changes_amounts(&key.hooks) => return Some("V4 pool's hook can change swap amounts (refused, same rule as paper)".into()),
        Venue::V2 { .. } if router.layout != UrLayout::Ur20 => return Some(format!("live V2 needs a 2.0-shape Universal Router (this one is {})", router.layout.name())),
        _ => {}
    }
    match (base, kind) {
        ("WETH", _) | ("USDG", _) | ("ETH", VenueKind::V4) => None,
        (b, k) => Some(format!("live does not trade {b}-based Uniswap {} pools", k.name().to_ascii_uppercase())),
    }
}

/// Everything to send for one swap of `amount_in` of `token_in` into
/// `token_out`: exact approvals (if any) then the swap, with `min_out` and
/// `deadline` (unix seconds). `sym_in` names the coin paid, for logs.
#[allow(clippy::too_many_arguments)]
pub fn trade_txs(v: &Venue, router: &RouterCfg, wallet: &str, token_in: &str, sym_in: &str, token_out: &str, amount_in: U256, min_out: U256, deadline: u64, now: u64) -> Result<Vec<LiveTx>, String> {
    if amount_in.is_zero() {
        return Err("nothing to swap".into());
    }
    let native_in = token_in.eq_ignore_ascii_case(NATIVE_ETH);
    match v {
        Venue::V3 { fee } => {
            if native_in || token_out.eq_ignore_ascii_case(NATIVE_ETH) {
                return Err("V3 swaps need WETH, not native ETH".into());
            }
            let mut txs = approvals(&Pay::Direct(live::SWAP_ROUTER_02.into()), token_in, sym_in, amount_in, now)?;
            txs.push(LiveTx::new("swap (Uniswap V3, SwapRouter02)", live::SWAP_ROUTER_02, live::data_swap(token_in, token_out, *fee, wallet, amount_in, min_out, deadline)?, live::GAS_SWAP));
            Ok(txs)
        }
        Venue::V4 { key } => {
            if venue::hook_changes_amounts(&key.hooks) {
                return Err("V4 pool's hook can change swap amounts".into());
            }
            let zfo = venue::v4_zero_for_one(key, token_in).ok_or("V4: coin paid is not in this pool")?;
            let other = if zfo { &key.currency1 } else { &key.currency0 };
            if !other.eq_ignore_ascii_case(token_out) {
                return Err("V4: coin bought is not the pool's other coin".into());
            }
            let input = v4_swap_input(key, zfo, amount_in, min_out, router.layout)?;
            let pay = if native_in { Pay::Native } else { Pay::Permit2(router.address.clone()) };
            let mut txs = approvals(&pay, token_in, sym_in, amount_in, now)?;
            let mut swap = LiveTx::new("swap (Uniswap V4, Universal Router)", &router.address, data_execute(&[CMD_V4_SWAP], &[input], deadline), GAS_UR_SWAP);
            if native_in {
                swap.value = amount_in; // exactly what is swapped: nothing left in the router
            }
            txs.push(swap);
            Ok(txs)
        }
        Venue::V2 { token0, .. } => {
            if router.layout != UrLayout::Ur20 {
                return Err("live V2 needs a 2.0-shape Universal Router".into());
            }
            if native_in || token_out.eq_ignore_ascii_case(NATIVE_ETH) {
                return Err("V2 pairs hold WETH, not native ETH".into());
            }
            if !(token_in.eq_ignore_ascii_case(token0) || token_out.eq_ignore_ascii_case(token0)) {
                return Err("V2: coins are not this pair's".into());
            }
            let mut txs = approvals(&Pay::Permit2(router.address.clone()), token_in, sym_in, amount_in, now)?;
            let input = v2_swap_input(wallet, amount_in, min_out, token_in, token_out)?;
            txs.push(LiveTx::new("swap (Uniswap V2, Universal Router)", &router.address, data_execute(&[CMD_V2_SWAP_EXACT_IN], &[input], deadline), GAS_UR_SWAP));
            Ok(txs)
        }
    }
}

// ---------------------------------------------------------------------------
// Saving a venue in the open-position file (so a restart can still sell)
// ---------------------------------------------------------------------------

pub fn venue_to_json(v: &Venue) -> Value {
    match v {
        Venue::V3 { fee } => json!({"kind": "v3", "fee": fee}),
        Venue::V4 { key } => json!({"kind": "v4", "c0": key.currency0, "c1": key.currency1, "fee": key.fee, "ts": key.tick_spacing, "hooks": key.hooks}),
        Venue::V2 { pair, token0 } => json!({"kind": "v2", "pair": pair, "token0": token0}),
    }
}

pub fn venue_from_json(v: &Value) -> Option<Venue> {
    let s = |k: &str| v[k].as_str().map(str::to_ascii_lowercase);
    match v["kind"].as_str()? {
        "v3" => Some(Venue::V3 { fee: v["fee"].as_u64()? as u32 }),
        "v4" => Some(Venue::V4 { key: V4Key { currency0: s("c0")?, currency1: s("c1")?, fee: v["fee"].as_u64()? as u32, tick_spacing: v["ts"].as_i64()? as i32, hooks: s("hooks")? } }),
        "v2" => Some(Venue::V2 { pair: s("pair")?, token0: s("token0")? }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fourmeme::hex;

    const WETH: &str = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
    const USDG: &str = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
    const TOKEN: &str = "0x1111111111111111111111111111111111111111";
    const ME: &str = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";

    fn key(c0: &str, c1: &str, hooks: &str) -> V4Key {
        V4Key { currency0: c0.into(), currency1: c1.into(), fee: 3000, tick_spacing: 60, hooks: hooks.into() }
    }

    #[test]
    fn selectors_are_the_published_ones() {
        assert_eq!(hex(&selector("execute(bytes,bytes[],uint256)")), "3593564c");
        assert_eq!(hex(&selector("approve(address,address,uint160,uint48)")), "87517c45");
    }

    // Expected bytes below were produced by an independent encoder (Python
    // eth_abi 5, `encode([...], [...])`) for the same values; see the
    // comment above each constant for the exact call.

    /// eth_abi: encode(['bytes','bytes[]'], [b'\x06\x0c\x0f', [
    ///   encode(['((address,address,uint24,int24,address),bool,uint128,uint128,bytes)'],
    ///          [((TOKEN, WETH, 3000, 60, 0x0), False, 10**18, 123456789, b'')]),
    ///   encode(['address','uint256'], [WETH, 10**18]),   # SETTLE_ALL (pay WETH)
    ///   encode(['address','uint256'], [TOKEN, 123456789])]])  # TAKE_ALL
    /// (TOKEN is currency0 here and we pay WETH = currency1: zeroForOne false.)
    const V4_INPUT_20: &str = include_str!("../tests/fixtures/v4_input_ur20.hex");
    /// Same with the 2.1 shape (an extra uint256 0 before hookData).
    const V4_INPUT_21: &str = include_str!("../tests/fixtures/v4_input_ur21.hex");
    /// eth_abi: selector 3593564c + encode(['bytes','bytes[]','uint256'], [b'\x10', [V4_INPUT_20], 1800000000])
    const EXECUTE_V4: &str = include_str!("../tests/fixtures/execute_v4_ur20.hex");
    /// eth_abi: encode(['address','uint256','uint256','address[]','bool'], [ME, 5*10**6, 77, [USDG, TOKEN], True])
    const V2_INPUT: &str = include_str!("../tests/fixtures/v2_input.hex");

    #[test]
    fn v4_swap_input_matches_independent_encoder() {
        let k = key(TOKEN, WETH, NATIVE_ETH);
        let e18 = U256::from(10u64).pow(U256::from(18u64));
        let got = v4_swap_input(&k, false, e18, U256::from(123_456_789u64), UrLayout::Ur20).unwrap();
        assert_eq!(hex(&got), V4_INPUT_20.trim());
        let got21 = v4_swap_input(&k, false, e18, U256::from(123_456_789u64), UrLayout::Ur21).unwrap();
        assert_eq!(hex(&got21), V4_INPUT_21.trim());
        // The full router call.
        assert_eq!(hex(&data_execute(&[CMD_V4_SWAP], &[got], 1_800_000_000)), EXECUTE_V4.trim());
    }

    #[test]
    fn v4_params_layout_is_what_the_dex_bot_reader_expects() {
        // decoderV4Router.ts layoutOf(): params[0] word 0 = 0x20, and the
        // hookData pointer inside the struct is 9 words (2.0) or 10 (2.1).
        let k = key(TOKEN, WETH, NATIVE_ETH);
        for (layout, ptr, words) in [(UrLayout::Ur20, 0x120u64, 11usize), (UrLayout::Ur21, 0x140, 12)] {
            let input = v4_swap_input(&k, true, U256::from(5u64), U256::from(4u64), layout).unwrap();
            // input = tuple(bytes actions, bytes[] params): find params[0].
            let word = |b: &[u8], i: usize| U256::from_be_slice(&b[i * 32..i * 32 + 32]).to::<usize>();
            let arr = word(&input, 1); // offset of params array
            let n = word(&input[arr..], 0);
            assert_eq!(n, 3);
            let first = arr + 32 + word(&input[arr + 32..], 0);
            let len = word(&input[first..], 0);
            let p0 = &input[first + 32..first + 32 + len];
            assert_eq!(p0.len(), words * 32);
            assert_eq!(word(p0, 0), 0x20, "struct behind an offset");
            // The struct starts at word 1; its hookData pointer is its last head word.
            let head_words = ptr as usize / 32;
            assert_eq!(word(p0, head_words) as u64, ptr, "hookData pointer");
            assert_eq!(word(p0, head_words + 1), 0, "hookData is empty");
        }
    }

    #[test]
    fn v2_input_matches_independent_encoder() {
        let got = v2_swap_input(ME, U256::from(5_000_000u64), U256::from(77u64), USDG, TOKEN).unwrap();
        assert_eq!(hex(&got), V2_INPUT.trim());
    }

    #[test]
    fn too_big_amounts_are_refused() {
        let k = key(TOKEN, WETH, NATIVE_ETH);
        let big = U256::from(u128::MAX) + U256::from(1u64);
        assert!(v4_swap_input(&k, true, big, U256::ZERO, UrLayout::Ur20).is_err());
        assert!(data_permit2_approve(TOKEN, UNIVERSAL_ROUTER, U256::from(1u64) << 160, 100).is_err());
        assert!(data_permit2_approve(TOKEN, UNIVERSAL_ROUTER, U256::from(5u64), 1u64 << 48).is_err());
    }

    #[test]
    fn permit2_flow_exact_amounts_and_short_expiry() {
        let amt = U256::from(12_345u64);
        let txs = approvals(&Pay::Permit2(UNIVERSAL_ROUTER.into()), WETH, "WETH", amt, 1_000).unwrap();
        assert_eq!(txs.len(), 2);
        // 1. WETH.approve(Permit2, exact amount)
        assert_eq!(txs[0].to, WETH);
        assert_eq!(&txs[0].data[..4], &[0x09, 0x5e, 0xa7, 0xb3]);
        assert_eq!(&txs[0].data[16..36], &addr_bytes(PERMIT2).unwrap());
        assert_eq!(U256::from_be_slice(&txs[0].data[36..68]), amt);
        // 2. Permit2.approve(WETH, router, exact amount, now + 10 min)
        assert_eq!(txs[1].to, PERMIT2);
        assert_eq!(hex(&txs[1].data[..4]), "87517c45");
        assert_eq!(&txs[1].data[16..36], &addr_bytes(WETH).unwrap());
        assert_eq!(&txs[1].data[48..68], &addr_bytes(UNIVERSAL_ROUTER).unwrap());
        assert_eq!(U256::from_be_slice(&txs[1].data[68..100]), amt);
        assert_eq!(U256::from_be_slice(&txs[1].data[100..132]), U256::from(1_600u64));
        assert!(txs.iter().all(|t| t.value.is_zero()));
        // Native ETH: no approvals at all. V3: one exact approve to SwapRouter02.
        assert!(approvals(&Pay::Native, NATIVE_ETH, "ETH", amt, 1_000).unwrap().is_empty());
        let d = approvals(&Pay::Direct(live::SWAP_ROUTER_02.into()), WETH, "WETH", amt, 1_000).unwrap();
        assert_eq!(d.len(), 1);
        assert_eq!(&d[0].data[16..36], &addr_bytes(live::SWAP_ROUTER_02).unwrap());
    }

    #[test]
    fn trade_txs_per_venue() {
        let r = RouterCfg::default();
        let amt = U256::from(1000u64);
        let min = U256::from(900u64);
        // V3: unchanged pair of approve + SwapRouter02 swap.
        let v3 = trade_txs(&Venue::V3 { fee: 3000 }, &r, ME, WETH, "WETH", TOKEN, amt, min, 99, 1).unwrap();
        let old = live::swap_pair(ME, WETH, TOKEN, 3000, amt, min, 99).unwrap();
        assert_eq!(v3.iter().map(|t| (t.to.clone(), t.data.clone(), t.gas)).collect::<Vec<_>>(), old);
        // V4 with WETH: approve, Permit2 approve, router execute, no ETH sent.
        let k = key(TOKEN, WETH, NATIVE_ETH);
        let v4 = trade_txs(&Venue::V4 { key: k.clone() }, &r, ME, WETH, "WETH", TOKEN, amt, min, 99, 1).unwrap();
        assert_eq!(v4.len(), 3);
        assert_eq!(v4[2].to, UNIVERSAL_ROUTER);
        assert_eq!(v4[2].data, data_execute(&[CMD_V4_SWAP], &[v4_swap_input(&k, false, amt, min, UrLayout::Ur20).unwrap()], 99));
        assert!(v4[2].value.is_zero());
        // Selling the token back: token approvals, zeroForOne true.
        let back = trade_txs(&Venue::V4 { key: k.clone() }, &r, ME, TOKEN, "token", WETH, amt, min, 99, 1).unwrap();
        assert_eq!(back[0].to, TOKEN);
        assert_eq!(back[2].data, data_execute(&[CMD_V4_SWAP], &[v4_swap_input(&k, true, amt, min, UrLayout::Ur20).unwrap()], 99));
        // V4 with native ETH: just the swap, sending exactly the amount.
        let ke = key(NATIVE_ETH, TOKEN, NATIVE_ETH);
        let eth = trade_txs(&Venue::V4 { key: ke.clone() }, &r, ME, NATIVE_ETH, "ETH", TOKEN, amt, min, 99, 1).unwrap();
        assert_eq!(eth.len(), 1);
        assert_eq!(eth[0].value, amt);
        // ...and selling into native ETH sends no ETH.
        let sell = trade_txs(&Venue::V4 { key: ke }, &r, ME, TOKEN, "token", NATIVE_ETH, amt, min, 99, 1).unwrap();
        assert_eq!(sell.len(), 3);
        assert!(sell[2].value.is_zero());
        // Wrong coins, unsafe hooks, native on V3: refused.
        assert!(trade_txs(&Venue::V4 { key: k.clone() }, &r, ME, USDG, "USDG", TOKEN, amt, min, 99, 1).is_err());
        assert!(trade_txs(&Venue::V4 { key: k.clone() }, &r, ME, WETH, "WETH", USDG, amt, min, 99, 1).is_err());
        let hooked = key(TOKEN, WETH, "0x0000000000000000000000000000000000000088");
        assert!(trade_txs(&Venue::V4 { key: hooked }, &r, ME, WETH, "WETH", TOKEN, amt, min, 99, 1).unwrap_err().contains("hook"));
        assert!(trade_txs(&Venue::V3 { fee: 500 }, &r, ME, NATIVE_ETH, "ETH", TOKEN, amt, min, 99, 1).is_err());
        assert!(trade_txs(&Venue::V3 { fee: 500 }, &r, ME, WETH, "WETH", TOKEN, U256::ZERO, min, 99, 1).is_err());
        // V2: Permit2 approvals then the router's V2 command.
        let v2v = Venue::V2 { pair: "0x2222222222222222222222222222222222222222".into(), token0: USDG.into() };
        let v2 = trade_txs(&v2v, &r, ME, USDG, "USDG", TOKEN, amt, min, 99, 1).unwrap();
        assert_eq!(v2.len(), 3);
        assert_eq!(v2[2].data, data_execute(&[CMD_V2_SWAP_EXACT_IN], &[v2_swap_input(ME, amt, min, USDG, TOKEN).unwrap()], 99));
        let r21 = RouterCfg { address: UNIVERSAL_ROUTER_2_1_2.into(), layout: UrLayout::Ur21 };
        assert!(trade_txs(&v2v, &r21, ME, USDG, "USDG", TOKEN, amt, min, 99, 1).is_err());
    }

    #[test]
    fn router_setting() {
        let none = |_: &str| None;
        assert_eq!(RouterCfg::from_lookup(&none).unwrap(), RouterCfg::default());
        let v21 = |k: &str| (k == "SNIPER_LIVE_UR").then(|| UNIVERSAL_ROUTER_2_1_2.to_ascii_uppercase().replace("0X", "0x"));
        assert_eq!(RouterCfg::from_lookup(&v21).unwrap().layout, UrLayout::Ur21);
        // Known router with the wrong shape: refused.
        let wrong = |k: &str| match k {
            "SNIPER_LIVE_UR_LAYOUT" => Some("2.1".into()),
            _ => None,
        };
        assert!(RouterCfg::from_lookup(&wrong).unwrap_err().contains("does not match"));
        // Unknown router: must say its shape.
        let unk = |k: &str| (k == "SNIPER_LIVE_UR").then(|| "0x3333333333333333333333333333333333333333".to_string());
        assert!(RouterCfg::from_lookup(&unk).unwrap_err().contains("SNIPER_LIVE_UR_LAYOUT"));
        let unk_ok = |k: &str| match k {
            "SNIPER_LIVE_UR" => Some("0x3333333333333333333333333333333333333333".into()),
            "SNIPER_LIVE_UR_LAYOUT" => Some("2.0".into()),
            _ => None,
        };
        assert_eq!(RouterCfg::from_lookup(&unk_ok).unwrap().layout, UrLayout::Ur20);
        let bad = |k: &str| (k == "SNIPER_LIVE_UR").then(|| "0x12".to_string());
        assert!(RouterCfg::from_lookup(&bad).is_err());
        let badl = |k: &str| (k == "SNIPER_LIVE_UR_LAYOUT").then(|| "3".to_string());
        assert!(RouterCfg::from_lookup(&badl).is_err());
    }

    #[test]
    fn refusals_per_venue_base_and_hook() {
        let r = RouterCfg::default();
        let on = live_venues_from(&|_| None).unwrap();
        assert_eq!(on, vec![VenueKind::V3, VenueKind::V4]);
        let all = live_venues_from(&|_| Some("v3,v4,v2".into())).unwrap();
        assert!(live_venues_from(&|_| Some("v9".into())).unwrap_err().contains("SNIPER_LIVE_VENUES"));
        let v3 = Venue::V3 { fee: 500 };
        let v4 = Venue::V4 { key: key(NATIVE_ETH, TOKEN, NATIVE_ETH) };
        let v2 = Venue::V2 { pair: "0x2".into(), token0: TOKEN.into() };
        assert_eq!(venue_refusal(&v3, "WETH", &on, &r), None);
        assert_eq!(venue_refusal(&v3, "USDG", &on, &r), None);
        assert!(venue_refusal(&v3, "ETH", &on, &r).unwrap().contains("ETH-based"));
        assert_eq!(venue_refusal(&v4, "ETH", &on, &r), None);
        assert_eq!(venue_refusal(&v4, "USDG", &on, &r), None);
        let hooked = Venue::V4 { key: key(NATIVE_ETH, TOKEN, "0x0000000000000000000000000000000000000044") };
        assert!(venue_refusal(&hooked, "ETH", &on, &r).unwrap().contains("hook"));
        // A hook that only reads (no "return delta" flag) is allowed, like paper.
        let fee_hook = Venue::V4 { key: key(NATIVE_ETH, TOKEN, "0x00000000000000000000000000000000000000c0") };
        assert_eq!(venue_refusal(&fee_hook, "ETH", &on, &r), None);
        assert!(venue_refusal(&v2, "WETH", &on, &r).unwrap().contains("SNIPER_LIVE_VENUES=v3,v4"));
        assert_eq!(venue_refusal(&v2, "WETH", &all, &r), None);
        let r21 = RouterCfg { address: UNIVERSAL_ROUTER_2_1_2.into(), layout: UrLayout::Ur21 };
        assert!(venue_refusal(&v2, "WETH", &all, &r21).unwrap().contains("2.0-shape"));
        assert!(venue_refusal(&v3, "WETH", &[VenueKind::V4], &r).unwrap().contains("V3 is off"));
    }

    #[test]
    fn venue_survives_the_position_file() {
        for v in [
            Venue::V3 { fee: 10000 },
            Venue::V4 { key: V4Key { currency0: NATIVE_ETH.into(), currency1: TOKEN.into(), fee: 0x80_0000, tick_spacing: -60, hooks: "0x00000000000000000000000000000000000000c0".into() } },
            Venue::V2 { pair: "0x2222222222222222222222222222222222222222".into(), token0: USDG.into() },
        ] {
            assert_eq!(venue_from_json(&venue_to_json(&v)), Some(v));
        }
        assert_eq!(venue_from_json(&json!({"kind": "v5"})), None);
    }
}
