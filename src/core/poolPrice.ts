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

  if (p.poolType === 'v3' && p.liquidity === 0n) return null; // empty pool: no real price
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

// ----------------------------------------------------------------------------
// REAL BALANCE CAP (Oct 13, the USDG/NVDA problem)
//
// Plain English:
//   A V3 pool's "virtual" depth assumes its liquidity stretches on forever.
//   When all of it sits in one tiny price band, the pool can look like a
//   $400,000 pool while holding $83. Overnight on Oct 13 the Uniswap V3 0.01%
//   USDG/NVDA pool did exactly that: liquidity squeezed into ONE tick, price
//   stuck at $207 while every other NVDA pool said $225, and only $83 of
//   USDG plus 0.003 NVDA really inside. The bot saw a "$300 gap" against it,
//   checked it ~140 times an hour, and every check broke (the pool simply
//   can't pay out). The coin itself was fine (NVDA moves normally, not paused).
//
//   The bot already reads every V3 pool's real coin balances every ~10 min
//   (core/v3BalanceBook.ts) but only the price oracle used them. Now the
//   depth filter (poolDepthUsd / deepEnough) and the standing-gap scanner use
//   them too: a pool counts only as deep as the coins really in it.
//   V4 pools are not capped (their coins all sit together in one contract).
//   Before the first balance read (2 min after start), or for a pool found
//   since the last read, nothing changes (virtual depth, as before).
// ----------------------------------------------------------------------------
export type RealBalanceSource = (pool: string, token: string) => bigint | undefined;
let realBalanceSource: RealBalanceSource | null = null;
// Called once at startup with the balance book (null switches it off, e.g. in tests).
export function setRealBalanceSource(fn: RealBalanceSource | null): void { realBalanceSource = fn; }

// Raw balance of `token` held by V3 pool `p`, or undefined when not known
// (not a V3 pool, a V4 pool, no balance source, or not read yet).
export function realBalanceOf(p: PoolState, token: string): bigint | undefined {
  if (p.poolType !== 'v3' || p.v4 || !realBalanceSource) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(p.poolAddress)) return undefined;
  return realBalanceSource(p.poolAddress, token);
}

// USD depth: 2 x the smaller side when both tokens have a USD price, else
// 2 x the side we can price. null = can't tell (treated as too shallow).
// V3 pools: each side is capped at the coins really in the pool, when known.
// opts.virtualOnly: skip the cap (used to spot the pools the cap removed).
export function poolDepthUsd(
  p: PoolState, decimalsOf: DecimalsLookup, usdOf: (token: string) => number | null,
  opts: { virtualOnly?: boolean } = {},
): number | null {
  const r0 = poolReserves(p, decimalsOf);
  if (!r0) return null;
  const r = { ...r0 };
  if (!opts.virtualOnly) {
    const ra = realBalanceOf(p, p.tokenA), rb = realBalanceOf(p, p.tokenB);
    if (ra !== undefined) r.a = Math.min(r.a, Number(ra) / 10 ** decimalsOf(p.chain, p.tokenA));
    if (rb !== undefined) r.b = Math.min(r.b, Number(rb) / 10 ** decimalsOf(p.chain, p.tokenB));
  }
  const ua = usdOf(p.tokenA), ub = usdOf(p.tokenB);
  const aUsd = ua ? r.a * ua : null, bUsd = ub ? r.b * ub : null;
  if (aUsd !== null && bUsd !== null) return 2 * Math.min(aUsd, bUsd);
  if (aUsd !== null) return 2 * aUsd;
  if (bUsd !== null) return 2 * bUsd;
  return null;
}

// Minimum depth for a pool to count in comparisons (POOL_MIN_DEPTH_USD, default $10,000).
// Was $25k, sized for the old $20 send minimum (a $25k pool needed a ~12% gap
// to make $20). Oct 11 (owner): the send minimum is now $0.10, so $10k-$25k
// pools can pay small but real profits; about 985 gaps an hour were being
// skipped by this filter. Every gap is still fully checked before it counts,
// and pool pairs that keep losing are benched automatically. Below ~$10k a
// pool rarely takes a trade big enough to clear fees, gas and the minimum.
export const POOL_MIN_DEPTH_USD = Number(process.env.POOL_MIN_DEPTH_USD ?? 10_000);

export function deepEnough(p: PoolState, decimalsOf: DecimalsLookup, usdOf: (token: string) => number | null, minUsd = POOL_MIN_DEPTH_USD): boolean {
  const d = poolDepthUsd(p, decimalsOf, usdOf);
  return d !== null && d >= minUsd;
}

// Pools that LOOK deep from their price maths (virtual depth at or above the
// minimum) but whose real coins are below it: left out by deepEnough since
// Oct 13. Listed on the status page so a stuck pool is visible. Biggest
// difference first.
export function thinPools(
  pools: PoolState[], decimalsOf: DecimalsLookup, usdOf: (token: string) => number | null, minUsd = POOL_MIN_DEPTH_USD,
): { pool: PoolState; virtualUsd: number; realUsd: number }[] {
  const out: { pool: PoolState; virtualUsd: number; realUsd: number }[] = [];
  for (const p of pools) {
    if (p.poolType !== 'v3' || p.v4) continue;
    const virtualUsd = poolDepthUsd(p, decimalsOf, usdOf, { virtualOnly: true });
    if (virtualUsd === null || virtualUsd < minUsd) continue;
    const realUsd = poolDepthUsd(p, decimalsOf, usdOf);
    if (realUsd !== null && realUsd < minUsd) out.push({ pool: p, virtualUsd, realUsd });
  }
  return out.sort((x, y) => (y.virtualUsd - y.realUsd) - (x.virtualUsd - x.realUsd));
}
