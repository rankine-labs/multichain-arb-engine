// ============================================================================
// FAST LANE SHARED TYPES (workstream B): one profitable trade the scanner
// found, with everything the sender (C, gun) and the safety gates (D) need.
//
// Plain English:
//   The scanner (scan.rs) runs our contract on our copy of the chain for each
//   candidate route and keeps the ones that pay. Each one becomes an
//   `Opportunity`: which coin we start with, how much, the exact hops in the
//   contract's own format, how it is funded (own money / Aave / V3 pool flash
//   loan), the expected profit after gas, and when / at which block it was
//   found. The gun turns it into calldata + a signed transaction; the safety
//   gates decide if it may go out. convert.rs turns it into their input
//   structs (compiled at integration, see that file).
//
//   Where the facts come from (no guessing):
//     - hops, start coin, amount, lender: decoded from the check's own
//       calldata (execute / executeWithV3Flash, the same ABI the real send
//       uses), so the trade sent is exactly the trade checked;
//     - profit (start-coin units) and EVM gas: from the check run;
//     - USD price + decimals of the start coin, the bot's gas estimate in
//       USD (L1 part included), the loan fee, the label, pool keys: from the
//       bot's candidate table row ("f" facts, sent only when FASTLANE is on).
// ============================================================================
use std::time::Instant;

use revm::primitives::{Address, U256};

/// Contract hop kinds (must match ArbExecutor.sol KIND_* and executorCalldata.ts).
pub const KIND_V2: u8 = 0;
pub const KIND_SOLIDLY: u8 = 1;
pub const KIND_V3: u8 = 2;
pub const KIND_V4: u8 = 3;
pub const KIND_V4_HOOKED: u8 = 4;

/// Selector of execute(trade, flashPool) (same as gun/calldata.rs EXECUTE_SELECTOR).
pub const EXECUTE_SELECTOR: [u8; 4] = [0x8d, 0xa2, 0xb3, 0x2d];
/// Selector of executeWithV3Flash(trade, lendPool).
pub const EXECUTE_V3_FLASH_SELECTOR: [u8; 4] = [0xb0, 0xfa, 0x7d, 0x85];

/// One hop in the contract's format (ExecutorHop in executorCalldata.ts).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hop {
    pub kind: u8,
    /// KIND_V4: the PoolManager. KIND_V4_HOOKED: the hook contract. Else the pool.
    pub pool: Address,
    pub token_in: Address,
    pub token_out: Address,
    pub fee_bps: u16,
    pub v4_fee: u32,
    pub v4_tick_spacing: i32,
    pub v4_native: bool,
}

/// How the trade is funded (Funding in executorCalldata.ts / gun).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FlashLender {
    /// Contract's own balance: execute(trade, address(0)).
    Own,
    /// Aave flash loan: execute(trade, aavePool).
    Aave(Address),
    /// V3 pool flash loan: executeWithV3Flash(trade, lendPool).
    V3Flash(Address),
}

impl FlashLender {
    pub fn name(&self) -> &'static str {
        match self {
            FlashLender::Own => "own",
            FlashLender::Aave(_) => "aave",
            FlashLender::V3Flash(_) => "v3-flash",
        }
    }
    /// Lender address, None = own money.
    pub fn lender(&self) -> Option<Address> {
        match self {
            FlashLender::Own => None,
            FlashLender::Aave(a) | FlashLender::V3Flash(a) => Some(*a),
        }
    }
}

/// Which state the opportunity was found on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ViewKind {
    /// Copy 2's confirmed state (after the block's pool-event report).
    Confirmed,
    /// Predicted state (copy 2 moved forward by feed messages, workstream A).
    Predicted,
    /// Fire-first (fastlane/trigger.rs): copy 2's newest confirmed version
    /// + the feed up to and including ONE trigger transaction, replayed by
    /// the trigger-first rules (check/ordered.rs), then our trade.
    Trigger,
}

impl ViewKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ViewKind::Confirmed => "confirmed",
            ViewKind::Predicted => "predicted",
            ViewKind::Trigger => "trigger",
        }
    }
}

/// One profitable trade, found by the scanner.
#[derive(Clone, Debug)]
pub struct Opportunity {
    /// L2 block whose end state the trade was checked on (the trade aims
    /// for the top of block + 1).
    pub block: u64,
    pub view: ViewKind,
    /// Human label from the bot, e.g. "WETH/USDG uniswap-v3>fables".
    pub route_label: String,
    /// Route id "buy>sell:start" (lowercase), the same id the bot uses.
    pub rid: String,
    /// Coin the route starts and ends in, its decimals and USD price (the
    /// price the bot's table carried when it was refreshed, ~1 s old).
    pub token_in: Address,
    pub token_in_decimals: u32,
    pub usd_per_token_in: f64,
    /// Trade size (raw units of token_in) and in USD.
    pub amount_in: U256,
    pub size_usd: f64,
    /// The route in the contract's format (2+ hops), decoded from the check.
    pub hops: Vec<Hop>,
    pub flash: FlashLender,
    /// Profit the check measured (raw units of token_in; after pool fees and
    /// the flash-loan fee, which the check's own run pays).
    pub profit_units: U256,
    /// Profit in USD after the bot's gas estimate (and loan fee: already in
    /// the check's profit).
    pub expected_net_usd: f64,
    /// The bot's gas estimate for one send (USD, parent-chain part included).
    pub gas_usd: f64,
    /// EVM gas the check used (execution only, no L1 part).
    pub gas_used: u64,
    /// Flash-loan fee in USD at this size (from the lender's fee pips the bot
    /// sent; 0 = own money; None = the bot did not say). For reporting: it is
    /// already paid inside the check, so it is NOT subtracted again.
    pub loan_fee_usd: Option<f64>,
    /// The trade's pools as the bot names them (address, or V4 pool id),
    /// lowercase, in route order. The lender is not included.
    pub pools: Vec<String>,
    /// Every key the route depends on (pools + lender), lowercase.
    pub keys: Vec<String>,
    /// Every coin the route touches (start coin first).
    pub tokens: Vec<Address>,
    /// When it was found (after the check), and how long the scan had run.
    pub found_at: Instant,
    pub scan_us: u64,
    /// "changed" (a pool on it changed this block) or "sweep" (rolling sweep).
    pub source: &'static str,
    /// The exact check it was found with (practice re-checks: scan.rs evaluate).
    pub check: std::sync::Arc<super::scan::PreparedCheck>,
}

impl Opportunity {
    /// Pools are 2 = pair, more = loop (same rule as D's SafetyInput::new).
    pub fn is_loop(&self) -> bool {
        self.pools.len() > 2
    }
}

/// The trade part of an execute / executeWithV3Flash call, decoded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodedTrade {
    pub token: Address,
    pub amount_in: U256,
    pub min_profit: U256,
    pub max_block: U256,
    pub hops: Vec<Hop>,
    pub flash: FlashLender,
}

fn word(data: &[u8], at: usize) -> Result<&[u8], String> {
    data.get(at..at + 32).ok_or_else(|| format!("call data too short (word at byte {at})"))
}
fn w_u256(data: &[u8], at: usize) -> Result<U256, String> {
    Ok(U256::from_be_slice(word(data, at)?))
}
fn w_usize(data: &[u8], at: usize) -> Result<usize, String> {
    let v = w_u256(data, at)?;
    usize::try_from(v).ok().filter(|x| *x < (1 << 24)).ok_or_else(|| format!("bad offset / length {v} at byte {at}"))
}
fn w_addr(data: &[u8], at: usize) -> Result<Address, String> {
    let w = word(data, at)?;
    if w[..12].iter().any(|b| *b != 0) {
        return Err(format!("not an address at byte {at}"));
    }
    Ok(Address::from_slice(&w[12..]))
}
/// A small unsigned number that must fit `bits` (ABI rule: high bytes zero).
fn w_small(data: &[u8], at: usize, bits: u32) -> Result<u64, String> {
    let v = w_u256(data, at)?;
    if v >= (U256::from(1u8) << bits) {
        return Err(format!("value {v} too big for uint{bits} at byte {at}"));
    }
    Ok(v.to::<u64>())
}

/// Decode execute((token,amountIn,minProfit,maxBlock,hops[]),address) or
/// executeWithV3Flash(same, lendPool), as executorCalldata.ts encodes them
/// (ethers ABI). Strict: anything odd = Err (the route is then skipped,
/// never sent with a guessed shape).
pub fn decode_trade(data: &[u8]) -> Result<DecodedTrade, String> {
    if data.len() < 4 {
        return Err("call data shorter than a selector".into());
    }
    let v3 = match [data[0], data[1], data[2], data[3]] {
        EXECUTE_SELECTOR => false,
        EXECUTE_V3_FLASH_SELECTOR => true,
        s => return Err(format!("not an ArbExecutor execute call (selector {:02x}{:02x}{:02x}{:02x})", s[0], s[1], s[2], s[3])),
    };
    let a = &data[4..];
    let t = w_usize(a, 0)?;
    let second = w_addr(a, 32)?;
    let token = w_addr(a, t)?;
    let amount_in = w_u256(a, t + 32)?;
    let min_profit = w_u256(a, t + 64)?;
    let max_block = w_u256(a, t + 96)?;
    let h = t + w_usize(a, t + 128)?;
    let n = w_usize(a, h)?;
    if !(1..=16).contains(&n) {
        return Err(format!("{n} hops"));
    }
    let mut hops = Vec::with_capacity(n);
    for i in 0..n {
        // Each hop is a static tuple of 8 words, stored inline.
        let at = h + 32 + i * 256;
        let tick = w_u256(a, at + 192)?;
        // int24, sign-extended to 256 bits by the ABI.
        let tick_i = if tick.bit(255) {
            let neg = (!tick).wrapping_add(U256::from(1u8));
            if neg > U256::from(1u64 << 23) {
                return Err("tick spacing out of int24 range".into());
            }
            -(neg.to::<u64>() as i64)
        } else {
            if tick >= U256::from(1u64 << 23) {
                return Err("tick spacing out of int24 range".into());
            }
            tick.to::<u64>() as i64
        };
        let native = w_small(a, at + 224, 1)? == 1;
        hops.push(Hop {
            kind: w_small(a, at, 8)? as u8,
            pool: w_addr(a, at + 32)?,
            token_in: w_addr(a, at + 64)?,
            token_out: w_addr(a, at + 96)?,
            fee_bps: w_small(a, at + 128, 16)? as u16,
            v4_fee: w_small(a, at + 160, 24)? as u32,
            v4_tick_spacing: tick_i as i32,
            v4_native: native,
        });
    }
    let flash = match (v3, second) {
        (true, l) if l != Address::ZERO => FlashLender::V3Flash(l),
        (true, _) => return Err("executeWithV3Flash without a lender".into()),
        (false, l) if l == Address::ZERO => FlashLender::Own,
        (false, l) => FlashLender::Aave(l),
    };
    // The route must start and end in the trade's coin and chain up.
    if hops[0].token_in != token || hops[n - 1].token_out != token || hops.windows(2).any(|w| w[0].token_out != w[1].token_in) {
        return Err("hops don't form a round trip from the start coin".into());
    }
    Ok(DecodedTrade { token, amount_in, min_profit, max_block, hops, flash })
}

/// Encode a trade back (tests, and to prove decode_trade reads the same
/// layout executorCalldata.ts writes; the gun has its own byte-exact encoder).
pub fn encode_trade(t: &DecodedTrade) -> Vec<u8> {
    let n = t.hops.len();
    let mut out = Vec::with_capacity(4 + 32 * (2 + 5 + 1 + 8 * n));
    let (sel, second) = match t.flash {
        FlashLender::Own => (EXECUTE_SELECTOR, Address::ZERO),
        FlashLender::Aave(a) => (EXECUTE_SELECTOR, a),
        FlashLender::V3Flash(a) => (EXECUTE_V3_FLASH_SELECTOR, a),
    };
    out.extend_from_slice(&sel);
    let u = |v: U256| v.to_be_bytes::<32>();
    let ad = |a: Address| {
        let mut w = [0u8; 32];
        w[12..].copy_from_slice(a.as_slice());
        w
    };
    out.extend(u(U256::from(0x40)));
    out.extend(ad(second));
    out.extend(ad(t.token));
    out.extend(u(t.amount_in));
    out.extend(u(t.min_profit));
    out.extend(u(t.max_block));
    out.extend(u(U256::from(0xa0)));
    out.extend(u(U256::from(n)));
    for h in &t.hops {
        out.extend(u(U256::from(h.kind)));
        out.extend(ad(h.pool));
        out.extend(ad(h.token_in));
        out.extend(ad(h.token_out));
        out.extend(u(U256::from(h.fee_bps)));
        out.extend(u(U256::from(h.v4_fee)));
        let ts = if h.v4_tick_spacing < 0 { (!U256::from((-(h.v4_tick_spacing as i64)) as u64)).wrapping_add(U256::from(1u8)) } else { U256::from(h.v4_tick_spacing as u64) };
        out.extend(u(ts));
        out.extend(u(U256::from(h.v4_native as u8)));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(n: u8) -> Address {
        Address::with_last_byte(n)
    }

    #[test]
    fn decode_reads_the_fixture_layout() {
        // From sim/tests/fixtures/offline-v3-v3-small.json (bytes made by
        // executorCalldata.ts through the simulator: own money, 2 hops).
        let fx: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/offline-v3-v3-small.json")).unwrap()).unwrap();
        let data = crate::check::hexutil::parse_bytes(fx["tx"]["data"].as_str().unwrap()).unwrap();
        let t = decode_trade(&data).unwrap();
        assert_eq!(t.flash, FlashLender::Own);
        assert_eq!(t.amount_in, U256::from(500_000_000u64));
        assert_eq!(t.hops.len(), 2);
        assert_eq!(t.min_profit, U256::MAX);
        assert_eq!(encode_trade(&t), data.to_vec(), "re-encodes byte for byte");
    }

    #[test]
    fn round_trip_and_refusals() {
        let hop = |k, p, i, o, ts| Hop { kind: k, pool: a(p), token_in: a(i), token_out: a(o), fee_bps: 30, v4_fee: 3000, v4_tick_spacing: ts, v4_native: true };
        let t = DecodedTrade { token: a(1), amount_in: U256::from(7u8), min_profit: U256::MAX, max_block: U256::MAX, hops: vec![hop(KIND_V4, 9, 1, 2, -60), hop(KIND_V2, 8, 2, 1, 0)], flash: FlashLender::V3Flash(a(5)) };
        assert_eq!(decode_trade(&encode_trade(&t)).unwrap(), t);
        let mut aave = t.clone();
        aave.flash = FlashLender::Aave(a(6));
        assert_eq!(decode_trade(&encode_trade(&aave)).unwrap().flash, FlashLender::Aave(a(6)));
        // Not a round trip.
        let mut bad = t.clone();
        bad.hops[1].token_out = a(3);
        assert!(decode_trade(&encode_trade(&bad)).is_err());
        // Other selector / truncated.
        let mut d = encode_trade(&t);
        d[0] = 0;
        assert!(decode_trade(&d).is_err());
        assert!(decode_trade(&encode_trade(&t)[..100]).is_err());
    }
}
