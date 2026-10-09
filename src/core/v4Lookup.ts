import { ethers } from 'ethers';
import type { ScannedPool } from './universeScan';

// ============================================================================
// UNISWAP V4 BY PAIR -- for the chain-wide scan's pair picker (read-only).
//
// Plain English:
//   Uniswap V4 keeps all its pools inside one PoolManager. Twice (Oct 8-9) we
//   tried reading V4's whole history into the scan's map: ~650,000 tradeable
//   pools (+ ~336,000 with hooks). Even filtered and capped, the bot ran out
//   of memory. So we DON'T read V4's history. Instead, each scan:
//     1. takes the pairs the scan already found worth a look (pairs with real
//        money on one exchange, plus the pairs it already picked), and
//     2. ASKS V4 whether that pair has a pool, the same way the pair watcher
//        already does for the pairs it watches: a V4 pool's id is just a
//        hash of (coin0, coin1, fee, tick spacing, hooks), so we compute the
//        ids of the 4 standard fee tiers (+ the native-ETH versions when one
//        coin is WETH) and ask StateView for their liquidity.
//   A few thousand small reads per scan; nothing about V4 is stored.
//   Hooked pools are never asked about (hooks = 0): the bot can't trade them.
// ============================================================================

// Same tiers as the pair watcher (core/poolResolver.ts STANDARD_V4_FEE_TIERS),
// copied here so the scan doesn't load the pair watcher's heavy libraries.
export const V4_TIERS: [number, number][] = [[500, 10], [3000, 60], [10000, 200], [100, 1]];

export const SEL_V4_SLOT0 = ethers.id('getSlot0(bytes32)').slice(0, 10);
export const SEL_V4_LIQ = ethers.id('getLiquidity(bytes32)').slice(0, 10);
const ZERO = ethers.ZeroAddress.toLowerCase();
const Q96 = 2n ** 96n;
const coder = ethers.AbiCoder.defaultAbiCoder();

// Pool id = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks=0)).
export function v4Id(c0: string, c1: string, fee: number, tickSpacing: number): string {
  return ethers.keccak256(coder.encode(['address', 'address', 'uint24', 'int24', 'address'], [c0, c1, fee, tickSpacing, ZERO])).toLowerCase();
}

export interface V4Ask {
  quote: string;        // the pair's USDG/WETH side (lowercase)
  other: string;        // the other coin (lowercase)
  id: string;
  c0: string; c1: string; // the pool key's coins (c0 = 0x0 for native ETH)
  fee: number; tickSpacing: number; native: boolean;
}

// Every pool id worth asking about for these (quote, other) pairs.
export function v4Asks(pairs: { quote: string; other: string }[], weth: string): V4Ask[] {
  const w = weth.toLowerCase();
  const out: V4Ask[] = [];
  for (const { quote, other } of pairs) {
    const q = quote.toLowerCase(), o = other.toLowerCase();
    const variants: { c0: string; c1: string; native: boolean }[] = [q < o ? { c0: q, c1: o, native: false } : { c0: o, c1: q, native: false }];
    if (q === w) variants.push({ c0: ZERO, c1: o, native: true }); // most V4 ETH pools hold native ETH
    for (const v of variants) for (const [fee, ts] of V4_TIERS) out.push({ quote: q, other: o, id: v4Id(v.c0, v.c1, fee, ts), c0: v.c0, c1: v.c1, fee, tickSpacing: ts, native: v.native });
  }
  return out;
}

const word0 = (r: string | null): bigint | null => { try { return r && r.length >= 66 ? BigInt(r.slice(0, 66)) : null; } catch { return null; } };

// Virtual amounts at the current price (raw units): amount0 = L/sqrtP,
// amount1 = L*sqrtP. The V2-equivalent depth near today's price.
export function v4Virtual(sqrtPriceX96: bigint, liquidity: bigint): { a0: bigint; a1: bigint } {
  if (sqrtPriceX96 <= 0n || liquidity <= 0n) return { a0: 0n, a1: 0n };
  return { a0: (liquidity * Q96) / sqrtPriceX96, a1: (liquidity * sqrtPriceX96) / Q96 };
}

type CallMany = (calls: { target: string; data: string }[]) => Promise<(string | null)[]>;

// Ask V4 about every id: liquidity first (1 read each), then price for the
// ones that have liquidity. Returns pools with at least `minUsd` in them, as
// scan pools (kind 'v4'), valued like the scan values everything else:
// 2 x the quote side (USDG/WETH), priced with `quoteUsd`.
export async function findV4Pools(
  callMany: CallMany, asks: V4Ask[],
  o: { stateView: string; poolManager: string; weth: string; quoteUsd: (q: string) => number; quoteDecimals: (q: string) => number | undefined; minUsd: number },
): Promise<ScannedPool[]> {
  if (!asks.length) return [];
  const liq = await callMany(asks.map((a) => ({ target: o.stateView, data: SEL_V4_LIQ + a.id.slice(2) })));
  const live = asks.map((a, i) => ({ a, L: word0(liq[i]) })).filter((x) => x.L !== null && x.L > 0n);
  if (!live.length) return [];
  const s0 = await callMany(live.map((x) => ({ target: o.stateView, data: SEL_V4_SLOT0 + x.a.id.slice(2) })));
  const w = o.weth.toLowerCase();
  const out: ScannedPool[] = [];
  live.forEach((x, i) => {
    const sq = word0(s0[i]);
    if (!sq || sq <= 0n) return;
    const { a0, a1 } = v4Virtual(sq, x.L!);
    const a = x.a;
    // Quote side: currency0 if the quote is c0 (or native ETH standing for WETH).
    const quoteIs0 = a.native ? a.quote === w : a.c0 === a.quote;
    const dq = o.quoteDecimals(a.quote), px = o.quoteUsd(a.quote);
    if (dq === undefined || !(px > 0)) return;
    const usd = 2 * (Number(quoteIs0 ? a0 : a1) / 10 ** dq) * px;
    if (!(usd >= o.minUsd)) return;
    out.push({
      dex: 'uniswap-v4', kind: 'v4', pool: a.id,
      token0: a.native ? w : a.c0, token1: a.c1, usd,
      v4: { fee: a.fee, tickSpacing: a.tickSpacing, native: a.native, poolManager: o.poolManager.toLowerCase(), stateView: o.stateView.toLowerCase() },
    });
  });
  return out;
}
