// ============================================================================
// EXACT UNISWAP V3 SWAP MATHS (test helper, reference only)
//
// Plain English:
//   The bot's own V3 maths (core/dexMath.ts) is a fast shortcut: it pretends
//   the liquidity sitting at today's price goes on forever. Real V3 pools
//   hold liquidity in price bands ("ticks"); a big trade walks out of one
//   band into the next, where there may be more or less liquidity.
//
//   This file is a faithful copy of Uniswap V3's own swap maths (TickMath,
//   SqrtPriceMath, SwapMath and the swap loop in UniswapV3Pool.sol), in
//   bigint, including the exact rounding. Tests use it as the "truth" to
//   measure how good the bot's shortcut and its trade-size search are.
//
//   Exact-input swaps only (that is what the executor contract does).
//   Not used by the live bot.
// ============================================================================

export const Q96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

const mulDiv = (a: bigint, b: bigint, d: bigint) => (a * b) / d;
const mulDivUp = (a: bigint, b: bigint, d: bigint) => { const p = a * b; return p / d + (p % d > 0n ? 1n : 0n); };
const divUp = (a: bigint, d: bigint) => a / d + (a % d > 0n ? 1n : 0n);

// TickMath.getSqrtRatioAtTick: sqrt(1.0001^tick) * 2^96, exactly as on-chain.
export function sqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error(`tick out of range: ${tick}`);
  const abs = BigInt(Math.abs(tick));
  let ratio = (abs & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const steps: [bigint, bigint][] = [
    [0x2n, 0xfff97272373d413259a46990580e213an], [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n], [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n], [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n], [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n], [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n], [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, mul] of steps) if ((abs & bit) !== 0n) ratio = (ratio * mul) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

// SqrtPriceMath.getAmount0Delta / getAmount1Delta.
export function amount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const n1 = liquidity << 96n;
  const n2 = sqrtB - sqrtA;
  return roundUp ? divUp(mulDivUp(n1, n2, sqrtB), sqrtA) : mulDiv(n1, n2, sqrtB) / sqrtA;
}
export function amount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return roundUp ? mulDivUp(liquidity, sqrtB - sqrtA, Q96) : mulDiv(liquidity, sqrtB - sqrtA, Q96);
}

// SqrtPriceMath.getNextSqrtPriceFromInput (exact input moves the price).
function nextSqrtFromInput(sqrtP: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  if (amountIn === 0n) return sqrtP;
  if (zeroForOne) {
    // getNextSqrtPriceFromAmount0RoundingUp(add = true), including the
    // on-chain overflow branch so rounding matches exactly.
    const n1 = liquidity << 96n;
    const product = amountIn * sqrtP;
    if (product <= MAX_UINT256) {
      const denominator = n1 + product;
      if (denominator >= n1 && denominator <= MAX_UINT256) return mulDivUp(n1, sqrtP, denominator);
    }
    return divUp(n1, n1 / sqrtP + amountIn);
  }
  // getNextSqrtPriceFromAmount1RoundingDown(add = true)
  return sqrtP + (amountIn << 96n) / liquidity;
}

// SwapMath.computeSwapStep for exact input. feePips: 3000 = 0.30%.
function swapStep(sqrtCur: bigint, sqrtTarget: bigint, liquidity: bigint, remaining: bigint, feePips: number) {
  const zeroForOne = sqrtCur >= sqrtTarget;
  const fee = BigInt(feePips);
  const remainingLessFee = mulDiv(remaining, 1_000_000n - fee, 1_000_000n);
  let amountIn = zeroForOne ? amount0Delta(sqrtTarget, sqrtCur, liquidity, true) : amount1Delta(sqrtCur, sqrtTarget, liquidity, true);
  const sqrtNext = remainingLessFee >= amountIn ? sqrtTarget : nextSqrtFromInput(sqrtCur, liquidity, remainingLessFee, zeroForOne);
  const reachedTarget = sqrtNext === sqrtTarget;
  if (!reachedTarget) amountIn = zeroForOne ? amount0Delta(sqrtNext, sqrtCur, liquidity, true) : amount1Delta(sqrtCur, sqrtNext, liquidity, true);
  const amountOut = zeroForOne ? amount1Delta(sqrtNext, sqrtCur, liquidity, false) : amount0Delta(sqrtCur, sqrtNext, liquidity, false);
  const feeAmount = !reachedTarget ? remaining - amountIn : mulDivUp(amountIn, fee, 1_000_000n - fee);
  return { sqrtNext, amountIn, amountOut, feeAmount };
}

// A V3 pool as the swap loop needs it.
export interface ExactV3Pool {
  sqrtPriceX96: bigint;
  tick: number;              // current tick (floor of the price's tick)
  liquidity: bigint;         // active liquidity at the current tick
  feePips: number;           // 500 = 0.05%
  ticks: { tick: number; liquidityNet: bigint }[]; // initialized ticks, any order
}

// Builds a pool from liquidity positions (like LP deposits): each position
// adds `liquidity` between tickLower and tickUpper. `tick` is the current tick.
export function poolFromPositions(
  tick: number, feePips: number, positions: { tickLower: number; tickUpper: number; liquidity: bigint }[],
): ExactV3Pool {
  const net = new Map<number, bigint>();
  let active = 0n;
  for (const p of positions) {
    if (!(p.tickLower < p.tickUpper)) throw new Error('bad position');
    net.set(p.tickLower, (net.get(p.tickLower) ?? 0n) + p.liquidity);
    net.set(p.tickUpper, (net.get(p.tickUpper) ?? 0n) - p.liquidity);
    if (p.tickLower <= tick && tick < p.tickUpper) active += p.liquidity;
  }
  // Price somewhere inside the current tick (like a real pool after trading).
  const lo = sqrtRatioAtTick(tick), hi = sqrtRatioAtTick(tick + 1);
  return {
    sqrtPriceX96: lo + (hi - lo) / 3n,
    tick, liquidity: active, feePips,
    ticks: [...net.entries()].map(([t, l]) => ({ tick: t, liquidityNet: l })).sort((a, b) => a.tick - b.tick),
  };
}

// UniswapV3Pool.swap for exact input with no price limit. Returns the amount
// out and the pool state after the swap (for chaining trades).
export function exactSwap(pool: ExactV3Pool, zeroForOne: boolean, amountIn: bigint): { amountOut: bigint; after: ExactV3Pool } {
  let sqrtP = pool.sqrtPriceX96, tick = pool.tick, liquidity = pool.liquidity;
  let remaining = amountIn, out = 0n;
  const limit = zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;
  const ticks = pool.ticks;
  while (remaining > 0n && sqrtP !== limit) {
    // Next initialized tick in the swap direction (lte for zeroForOne).
    let next: { tick: number; liquidityNet: bigint } | undefined;
    if (zeroForOne) { for (let i = ticks.length - 1; i >= 0; i--) if (ticks[i].tick <= tick) { next = ticks[i]; break; } }
    else next = ticks.find((t) => t.tick > tick);
    const nextTick = next ? next.tick : zeroForOne ? MIN_TICK : MAX_TICK;
    const sqrtNextTick = sqrtRatioAtTick(Math.max(MIN_TICK, Math.min(MAX_TICK, nextTick)));
    const target = zeroForOne ? (sqrtNextTick < limit ? limit : sqrtNextTick) : (sqrtNextTick > limit ? limit : sqrtNextTick);
    const step = swapStep(sqrtP, target, liquidity, remaining, pool.feePips);
    sqrtP = step.sqrtNext;
    remaining -= step.amountIn + step.feeAmount;
    out += step.amountOut;
    if (sqrtP === sqrtNextTick) {
      if (next) liquidity = zeroForOne ? liquidity - next.liquidityNet : liquidity + next.liquidityNet;
      tick = zeroForOne ? nextTick - 1 : nextTick;
      if (!next) break; // ran off the end of all liquidity
    }
  }
  return { amountOut: out, after: { ...pool, sqrtPriceX96: sqrtP, tick, liquidity } };
}

// Tick for a human price ("token1 per token0", raw units already adjusted
// for decimals by the caller), rounded down to a multiple of `spacing`.
export function tickForPrice(rawPrice: number, spacing = 1): number {
  const t = Math.floor(Math.log(rawPrice) / Math.log(1.0001));
  return Math.floor(t / spacing) * spacing;
}
