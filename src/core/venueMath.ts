// ============================================================================
// VENUE MATH -- exact swap output for the pool types used by the new
// Robinhood venues, for pricing and for checking our maths against real
// historical swaps.
//
// Plain English:
//   Concentrated-liquidity pools (Uniswap V3 and its copies: PancakeSwap V3,
//   GIGA CL, SwapHood V3, Slipstream copies UP / Topaz / Raphael, Algebra
//   copies like Alandale, and Uniswap V4 pools such as Fables) all use the
//   same price formula while a trade stays inside the current price band.
//   Given the price (sqrtPriceX96), the liquidity at that price and the fee,
//   these functions give the exact amount out, using integer maths the same
//   way the pool contracts do (rounding in the pool's favour).
//
//   If a trade is big enough to leave the current band ("cross a tick"), the
//   result here is only an estimate; the checker reports how often that
//   happens so we know how far to trust it.
//
//   Classic x*y=k pools (V2 copies, Solidly "volatile" pairs) use
//   v2AmountOut().
// ============================================================================

const Q96 = 1n << 96n;

// Ceiling division for non-negative bigints.
const divUp = (a: bigint, b: bigint) => (a + b - 1n) / b;

// Fee in "pips" (millionths): 3000 = 0.30%, 500 = 0.05%, 100 = 0.01%.
export function amountInAfterFee(amountIn: bigint, feePips: number): bigint {
  return (amountIn * BigInt(1_000_000 - feePips)) / 1_000_000n;
}

// Exact-input swap inside one price band of a concentrated-liquidity pool.
// zeroForOne = selling token0 for token1. Returns the output and the new price.
export function clAmountOut(
  sqrtPriceX96: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean, feePips: number,
): { amountOut: bigint; sqrtPriceNextX96: bigint } {
  if (liquidity <= 0n || sqrtPriceX96 <= 0n || amountIn <= 0n) return { amountOut: 0n, sqrtPriceNextX96: sqrtPriceX96 };
  const inLessFee = amountInAfterFee(amountIn, feePips);
  if (zeroForOne) {
    // Price falls: sqrtNext = L*Q96*sqrtP / (L*Q96 + amountIn*sqrtP), rounded up (pool's favour).
    const num = liquidity * Q96;
    const next = divUp(num * sqrtPriceX96, num + inLessFee * sqrtPriceX96);
    // Out (token1) = L * (sqrtP - sqrtNext) / Q96, rounded down.
    const out = (liquidity * (sqrtPriceX96 - next)) / Q96;
    return { amountOut: out, sqrtPriceNextX96: next };
  }
  // Price rises: sqrtNext = sqrtP + amountIn*Q96/L, rounded down.
  const next = sqrtPriceX96 + (inLessFee * Q96) / liquidity;
  // Out (token0) = L*Q96*(sqrtNext - sqrtP) / (sqrtNext*sqrtP), rounded down.
  const out = ((liquidity * Q96 * (next - sqrtPriceX96)) / next) / sqrtPriceX96;
  return { amountOut: out, sqrtPriceNextX96: next };
}

// Classic constant-product output (Uniswap V2 copies, Solidly volatile pairs).
export function v2AmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feePips: number): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const inLessFee = amountIn * BigInt(1_000_000 - feePips);
  return (inLessFee * reserveOut) / (reserveIn * 1_000_000n + inLessFee);
}

// Relative difference in basis points between a predicted and an actual
// amount (0 = exact). Uses the actual as the base.
export function errorBps(predicted: bigint, actual: bigint): number {
  if (actual === 0n) return predicted === 0n ? 0 : Infinity;
  const diff = predicted > actual ? predicted - actual : actual - predicted;
  return Number((diff * 1_000_000n) / (actual < 0n ? -actual : actual)) / 100;
}
