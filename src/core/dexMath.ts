import { PoolState } from './types';

// ============================================================================
// DEX MATH — universal getAmountOut()
//
// The core arbitrage engine should not care which DEX/pool type it's
// working with. It asks one question: "if I trade X amount through this
// pool, exactly how much will I receive?" This module answers that for
// both v2 (constant product) and v3 (concentrated liquidity, current-tick
// approximation) pools, so sizing/profit logic stays pool-type-agnostic.
// ============================================================================

const Q96 = 1n << 96n;

export function computeAmountOut(pool: PoolState, tokenInIsA: boolean, amountIn: bigint): bigint | null {
  if (amountIn <= 0n) return 0n;

  if (pool.poolType === 'v2') {
    if (pool.reserveA === undefined || pool.reserveB === undefined) return null;
    const feeMultiplier = BigInt(10_000 - pool.feeBps);
    const amountInWithFee = (amountIn * feeMultiplier) / 10_000n;

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
    // liquidity — see predictPostTradeState in poolCache.ts for the same
    // approximation and its known limitation (doesn't model tick-crossing).
    const virtualX = (pool.liquidity * Q96) / pool.sqrtPriceX96;
    const virtualY = (pool.liquidity * pool.sqrtPriceX96) / Q96;

    const feeMultiplier = BigInt(10_000 - pool.feeBps);
    const amountInWithFee = (amountIn * feeMultiplier) / 10_000n;

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

  // orderbook / stable pool math — not implemented yet (Kuru on Monad needs
  // its own adapter since order-book pricing has no reserves at all).
  return null;
}
