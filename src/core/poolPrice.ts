import { PoolState } from './types';

// ============================================================================
// POOL PRICE -- one shared, correct way to read a pool's price.
//
// Plain English:
//   "What is 1 <token> worth in the other token, on this pool?"
//
// Why this exists: shadowMain had several copies of a price function. Some
// skipped decimal adjustment (WMON 18 decimals vs USDC 6 = prices off by
// 10^12), and none checked token ORDER. Two pools can list the same pair as
// WMON/USDC and USDC/WMON; comparing their raw prices compares a price to its
// inverse, so the "spread" was garbage. This file fixes both:
//   - always adjusts for each token's decimals
//   - always prices the token YOU ask for, inverting when the pool lists it
//     second, so two pools are compared like for like
//
// Returns null (never a fake number) when the pool can't give an honest price:
//   - LFJ Liquidity Book: reserve totals across bins are not a spot price
//   - near-empty pools (dust reserves), which produced fake 100%+ spreads
//   - missing state, or a token that isn't in the pool
// ============================================================================

export type DecimalsLookup = (chain: string, token: string) => number;

// Below this many whole tokens on either side, a V2-style pool's ratio is noise.
const MIN_RESERVE_UNITS = 0.01;

// Price of tokenA denominated in tokenB, decimal-adjusted. null if unreliable.
export function priceAinB(p: PoolState, decimalsOf: DecimalsLookup): number | null {
  if (p.dex === 'lfj-lb' || p.dex === 'traderjoe-lb') return null;
  const decA = decimalsOf(p.chain, p.tokenA);
  const decB = decimalsOf(p.chain, p.tokenB);

  if (p.poolType === 'v3' && p.sqrtPriceX96) {
    const raw = Number(p.sqrtPriceX96) / 2 ** 96;
    const price = raw * raw * 10 ** (decA - decB);
    return Number.isFinite(price) && price > 0 ? price : null;
  }

  if (p.reserveA !== undefined && p.reserveB !== undefined && p.reserveA > 0n) {
    const adjA = Number(p.reserveA) / 10 ** decA;
    const adjB = Number(p.reserveB) / 10 ** decB;
    if (adjA < MIN_RESERVE_UNITS || adjB < MIN_RESERVE_UNITS) return null;
    return adjB / adjA;
  }

  return null;
}

// Price of `base` in the pool's OTHER token. Use this whenever two pools are
// being compared: pass the same `base` for both.
export function priceOf(p: PoolState, base: string, decimalsOf: DecimalsLookup): number | null {
  const a = priceAinB(p, decimalsOf);
  if (a === null) return null;
  const b = base.toLowerCase();
  if (p.tokenA.toLowerCase() === b) return a;
  if (p.tokenB.toLowerCase() === b) return 1 / a;
  return null; // base isn't in this pool
}

// Gap between two prices as a % of the lower one (always >= 0).
export function spreadPct(x: number, y: number): number {
  const lo = Math.min(x, y);
  return lo > 0 ? (Math.abs(x - y) / lo) * 100 : 0;
}

// ----------------------------------------------------------------------------
// POOL DEPTH -- how much money actually sits in a pool near its price.
//
// Why: a near-empty pool (a few dollars in it) can show ANY price, because
// nobody bothers to trade it back in line. Comparing against it produced
// "gaps" of 397,612% in the hourly report. Pools below a minimum depth are
// left out of price comparisons, the gap scanner and trade checks.
//
// V2: real reserves. V3/V4: "virtual" reserves at the current price
// (liquidity / sqrtPrice and liquidity * sqrtPrice), i.e. the money that
// trades near today's price, which is what matters for an arb.
// ----------------------------------------------------------------------------

// Reserves in whole tokens (tokenA, tokenB), or null if unknown.
export function poolReserves(p: PoolState, decimalsOf: DecimalsLookup): { a: number; b: number } | null {
  const decA = decimalsOf(p.chain, p.tokenA);
  const decB = decimalsOf(p.chain, p.tokenB);
  if (p.poolType === 'v3') {
    if (!p.sqrtPriceX96 || !p.liquidity) return null;
    const sqrtP = Number(p.sqrtPriceX96) / 2 ** 96;
    const L = Number(p.liquidity);
    const a = L / sqrtP / 10 ** decA;
    const b = (L * sqrtP) / 10 ** decB;
    return Number.isFinite(a) && Number.isFinite(b) ? { a, b } : null;
  }
  if (p.reserveA !== undefined && p.reserveB !== undefined) {
    return { a: Number(p.reserveA) / 10 ** decA, b: Number(p.reserveB) / 10 ** decB };
  }
  return null;
}

// USD depth: 2 x the smaller side when both tokens have a USD price, else
// 2 x the side we can price. null = can't tell (treated as too shallow).
export function poolDepthUsd(
  p: PoolState, decimalsOf: DecimalsLookup, usdOf: (token: string) => number | null,
): number | null {
  const r = poolReserves(p, decimalsOf);
  if (!r) return null;
  const ua = usdOf(p.tokenA), ub = usdOf(p.tokenB);
  const aUsd = ua ? r.a * ua : null, bUsd = ub ? r.b * ub : null;
  if (aUsd !== null && bUsd !== null) return 2 * Math.min(aUsd, bUsd);
  if (aUsd !== null) return 2 * aUsd;
  if (bUsd !== null) return 2 * bUsd;
  return null;
}

// Minimum depth for a pool to count in comparisons (POOL_MIN_DEPTH_USD, default $10,000).
// Why $10k: profit ~ pool depth x gap squared, so to make the $20 minimum a
// $10k pool already needs an ~18% gap (a $1k pool would need ~55%). Smaller
// pools almost never pay and only waste simulations.
export const POOL_MIN_DEPTH_USD = Number(process.env.POOL_MIN_DEPTH_USD ?? 10_000);

export function deepEnough(p: PoolState, decimalsOf: DecimalsLookup, usdOf: (token: string) => number | null, minUsd = POOL_MIN_DEPTH_USD): boolean {
  const d = poolDepthUsd(p, decimalsOf, usdOf);
  return d !== null && d >= minUsd;
}
