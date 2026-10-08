import { PoolState } from './types';

// ============================================================================
// DEX MATH: universal getAmountOut()
//
// The core arbitrage engine should not care which DEX/pool type it's
// working with. It asks one question: "if I trade X amount through this
// pool, exactly how much will I receive?" This module answers that for
// both v2 (constant product) and v3 (concentrated liquidity, current-tick
// approximation) pools, so sizing/profit logic stays pool-type-agnostic.
// ============================================================================

const Q96 = 1n << 96n;

// ----------------------------------------------------------------------------
// Pool fees, in one place.
//
// Plain English:
//   Fees come in two units in DeFi:
//     - basis points ("bps"): 1 bps = 0.01%, so 30 bps = 0.30%
//     - "pips" (Uniswap V3/V4): 1 pip = 0.0001%, so 3000 pips = 0.30%
//   PoolState.feeBps is a whole number of bps, which can't hold fees like
//   0.025% (250 pips) exactly: they used to be rounded to 3 bps. When the
//   exact fee in pips is known (PoolState.feePips, or a V4 pool's own fee),
//   it is used instead, so the bot's maths charges exactly what the pool does.
//   For every pool without that extra detail the result is identical to
//   before (bps x 100 = pips, same rounding).
// ----------------------------------------------------------------------------
const PIPS = 1_000_000n; // 100% in pips

export function feePipsOf(pool: PoolState): number {
  if (pool.feePips !== undefined && Number.isInteger(pool.feePips) && pool.feePips >= 0 && pool.feePips < 1_000_000) return pool.feePips;
  // V4 pools carry their real fee in pips (dynamic-fee flag values are >= 1e6: ignored).
  if (pool.v4 && Number.isInteger(pool.v4.fee) && pool.v4.fee >= 0 && pool.v4.fee < 1_000_000) return pool.v4.fee;
  // Fallback: whole bps. Rounded so a fractional value can never crash BigInt().
  return Math.max(0, Math.min(999_999, Math.round(pool.feeBps * 100)));
}

// The part of amountIn the pool actually prices after taking its fee.
// Same rounding as before: rounded down.
export function amountInAfterFee(pool: PoolState, amountIn: bigint): bigint {
  return (amountIn * (PIPS - BigInt(feePipsOf(pool)))) / PIPS;
}

export function computeAmountOut(pool: PoolState, tokenInIsA: boolean, amountIn: bigint): bigint | null {
  if (amountIn <= 0n) return 0n;

  if (pool.poolType === 'v2') {
    if (pool.reserveA === undefined || pool.reserveB === undefined) return null;
    const amountInWithFee = amountInAfterFee(pool, amountIn);

    if (tokenInIsA) {
      if (pool.reserveA + amountInWithFee === 0n) return null;
      const newReserveB = (pool.reserveA * pool.reserveB) / (pool.reserveA + amountInWithFee);
      return pool.reserveB - newReserveB;
    } else {
      if (pool.reserveB + amountInWithFee === 0n) return null;
      const newReserveA = (pool.reserveA * pool.reserveB) / (pool.reserveB + amountInWithFee);
      return pool.reserveA - newReserveA;
    }
  }

  if (pool.poolType === 'v3') {
    if (pool.sqrtPriceX96 === undefined || pool.liquidity === undefined) return null;

    // Virtual reserves at the current price within the active tick's
    // liquidity: see predictPostTradeState in poolCache.ts for the same
    // approximation and its known limitation (doesn't model tick-crossing).
    const virtualX = (pool.liquidity * Q96) / pool.sqrtPriceX96;
    const virtualY = (pool.liquidity * pool.sqrtPriceX96) / Q96;

    // Direction: tokenA is the pool's token0, so tokenInIsA = "zeroForOne"
    // (token0 in, token1 out). virtualX is token0's side, virtualY token1's.
    const amountInWithFee = amountInAfterFee(pool, amountIn);

    if (tokenInIsA) {
      const newVirtualX = virtualX + amountInWithFee;
      if (newVirtualX === 0n) return null;
      const newVirtualY = (virtualX * virtualY) / newVirtualX;
      return virtualY - newVirtualY;
    } else {
      const newVirtualY = virtualY + amountInWithFee;
      if (newVirtualY === 0n) return null;
      const newVirtualX = (virtualX * virtualY) / newVirtualY;
      return virtualX - newVirtualX;
    }
  }

  // orderbook / stable pool math: not implemented yet (Kuru on Monad needs
  // its own adapter since order-book pricing has no reserves at all).
  return null;
}
