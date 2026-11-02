// ============================================================================
// TICK-AWARE SWAP MATHS for Uniswap V3 / V4 style pools (Nov 2, STOCK_TICK_MATH)
//
// Plain English:
//   A V3/V4 pool does not hold one big pile of money like a V2 pool. Its
//   money is split into price "ranges" (between ticks). Only the range the
//   price sits in right now is used, and when a trade pushes the price past
//   the edge of that range, the next range's money takes over.
//
//   The bot's quick guess (dexMath.computeAmountOut) pretends the money in
//   the CURRENT range stretches forever in both directions. That is fine for
//   small trades on pools whose money is spread wide. On the Robinhood stock
//   token pools (MRNA, BE, GOOGL, RIVN, SNDK ... vs USDG) the money sits in
//   narrow ranges, so a $1,000 trade runs off the edge of the current range
//   into much thinner (or empty) ranges. The quick guess then promises far
//   more coins than the pool will really give: a "gap" of $15 to $170 that
//   disappears in the practice check.
//
//   This file is a straight copy of Uniswap's own swap maths (TickMath,
//   SqrtPriceMath, SwapMath and the swap loop), in BigInt, with the same
//   rounding. Given the pool's price, current liquidity and the list of
//   nearby range edges ("initialized ticks" with their liquidity change),
//   it walks the trade range by range exactly like the pool does.
//
//   It only knows the range edges inside the window that was read from the
//   chain (core/tickWindow.ts). If a trade would run past the window, the
//   rest of the trade is counted as getting NOTHING back (we don't know
//   what's there), so the guess can only be too careful, never too greedy.
// ============================================================================

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
const Q96 = 1n << 96n;
const MAX_U256 = (1n << 256n) - 1n;
const MAX_U160 = (1n << 160n) - 1n;
const PIPS = 1_000_000n;

// --- FullMath (exact, BigInt never overflows) -------------------------------
function mulDiv(a: bigint, b: bigint, d: bigint): bigint { return (a * b) / d; }
function mulDivRoundingUp(a: bigint, b: bigint, d: bigint): bigint {
  const p = a * b;
  return p % d === 0n ? p / d : p / d + 1n;
}
function divRoundingUp(a: bigint, d: bigint): bigint { return a % d === 0n ? a / d : a / d + 1n; }

// --- TickMath.getSqrtRatioAtTick (Uniswap V3 core, same constants) ----------
// sqrt(1.0001^tick) * 2^96, rounded exactly like the contract.
// Memo: the swap walk asks for the same few edge prices over and over while
// the bot sizes a trade (dozens of guesses per pool), and each one costs ~20
// big-number multiplications. The answer for a tick never changes.
const sqrtMemo = new Map<number, bigint>();
export function getSqrtRatioAtTick(tick: number): bigint {
  const m = sqrtMemo.get(tick);
  if (m !== undefined) return m;
  const v = sqrtRatioAtTickRaw(tick);
  if (sqrtMemo.size >= 50_000) sqrtMemo.clear();
  sqrtMemo.set(tick, v);
  return v;
}
function sqrtRatioAtTickRaw(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error(`tick out of range: ${tick}`);
  const absTick = BigInt(Math.abs(tick));
  let ratio = (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const m = (bit: bigint, c: bigint) => { if ((absTick & bit) !== 0n) ratio = (ratio * c) >> 128n; };
  m(0x2n, 0xfff97272373d413259a46990580e213an);
  m(0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn);
  m(0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n);
  m(0x10n, 0xffcb9843d60f6159c9db58835c926644n);
  m(0x20n, 0xff973b41fa98c081472e6896dfb254c0n);
  m(0x40n, 0xff2ea16466c96a3843ec78b326b52861n);
  m(0x80n, 0xfe5dee046a99a2a811c461f1969c3053n);
  m(0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n);
  m(0x200n, 0xf987a7253ac413176f2b074cf7815e54n);
  m(0x400n, 0xf3392b0822b70005940c7a398e4b70f3n);
  m(0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n);
  m(0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n);
  m(0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n);
  m(0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n);
  m(0x8000n, 0x31be135f97d08fd981231505542fcfa6n);
  m(0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n);
  m(0x20000n, 0x5d6af8dedb81196699c329225ee604n);
  m(0x40000n, 0x2216e584f5fa1ea926041bedfe98n);
  m(0x80000n, 0x48a170391f7dc42444e8fa2n);
  if (tick > 0) ratio = MAX_U256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

// The tick a price sits in (largest tick whose sqrt ratio <= the price).
// Starts from a floating-point estimate, then corrects it exactly.
export function getTickAtSqrtRatio(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 < MIN_SQRT_RATIO) return MIN_TICK;
  if (sqrtPriceX96 >= MAX_SQRT_RATIO) return MAX_TICK - 1;
  const r = Number(sqrtPriceX96) / 2 ** 96;
  let t = Math.floor((2 * Math.log(r)) / Math.log(1.0001));
  t = Math.max(MIN_TICK, Math.min(MAX_TICK - 1, t));
  while (t < MAX_TICK - 1 && getSqrtRatioAtTick(t + 1) <= sqrtPriceX96) t++;
  while (t > MIN_TICK && getSqrtRatioAtTick(t) > sqrtPriceX96) t--;
  return t;
}

// --- SqrtPriceMath -----------------------------------------------------------
function nextSqrtFromAmount0RoundingUp(sqrtP: bigint, L: bigint, amount: bigint): bigint {
  if (amount === 0n) return sqrtP;
  const numerator1 = L << 96n;
  const product = amount * sqrtP;
  // Same two branches as the contract (the second one is used when the
  // first would overflow 256 bits there; results can differ by rounding).
  if (product <= MAX_U256 && numerator1 + product <= MAX_U256) {
    return mulDivRoundingUp(numerator1, sqrtP, numerator1 + product);
  }
  return divRoundingUp(numerator1, numerator1 / sqrtP + amount);
}
function nextSqrtFromAmount1RoundingDown(sqrtP: bigint, L: bigint, amount: bigint): bigint {
  const quotient = amount <= MAX_U160 ? (amount << 96n) / L : mulDiv(amount, Q96, L);
  return sqrtP + quotient;
}
function nextSqrtFromInput(sqrtP: bigint, L: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  return zeroForOne ? nextSqrtFromAmount0RoundingUp(sqrtP, L, amountIn) : nextSqrtFromAmount1RoundingDown(sqrtP, L, amountIn);
}
function amount0Delta(a: bigint, b: bigint, L: bigint, roundUp: boolean): bigint {
  if (a > b) [a, b] = [b, a];
  if (a === 0n) return 0n;
  const n1 = L << 96n, n2 = b - a;
  return roundUp ? divRoundingUp(mulDivRoundingUp(n1, n2, b), a) : mulDiv(n1, n2, b) / a;
}
function amount1Delta(a: bigint, b: bigint, L: bigint, roundUp: boolean): bigint {
  if (a > b) [a, b] = [b, a];
  return roundUp ? mulDivRoundingUp(L, b - a, Q96) : mulDiv(L, b - a, Q96);
}

// --- SwapMath.computeSwapStep (exact input only) -----------------------------
function swapStep(cur: bigint, target: bigint, L: bigint, remaining: bigint, feePips: bigint) {
  const zeroForOne = cur >= target;
  const lessFee = mulDiv(remaining, PIPS - feePips, PIPS);
  let amountIn = zeroForOne ? amount0Delta(target, cur, L, true) : amount1Delta(cur, target, L, true);
  let next: bigint;
  if (lessFee >= amountIn) next = target;
  else next = nextSqrtFromInput(cur, L, lessFee, zeroForOne);
  const max = next === target;
  if (!max) amountIn = zeroForOne ? amount0Delta(next, cur, L, true) : amount1Delta(cur, next, L, true);
  const amountOut = zeroForOne ? amount1Delta(next, cur, L, false) : amount0Delta(cur, next, L, false);
  const fee = !max ? remaining - amountIn : mulDivRoundingUp(amountIn, feePips, PIPS - feePips);
  return { next, amountIn, amountOut, fee };
}

// One range edge: the tick and how much liquidity starts (+) / stops (-)
// there when the price moves UP across it (Uniswap's liquidityNet).
export interface TickEdge { tick: number; liquidityNet: bigint }

// What the bot knows about a pool's ranges: every initialized tick between
// lo and hi (inclusive), read at `block`. Outside [lo, hi] is unknown.
// ticks: sorted from low to high. tickSpacing: the pool's tick spacing.
export interface TickWindow { lo: number; hi: number; tickSpacing: number; ticks: TickEdge[]; block: number; ms: number }

export interface TickSwapResult {
  amountOut: bigint;
  amountInUsed: bigint;   // input the pool really took (incl. fee)
  crossed: number;        // range edges crossed
  leftWindow: boolean;    // ran past the known window (rest counted as nothing back)
  sqrtPriceAfter: bigint;
  liquidityAfter: bigint;
}

// Uniswap's TickBitmap.nextInitializedTickWithinOneWord, on our tick list:
// the next initialized tick in the trade's direction, but never further than
// the end of the current 256-tick bitmap word (the pool also stops there,
// which changes rounding by a unit or two, so we copy it to be exact).
function nextTickWithinWord(ticks: TickEdge[], tick: number, ts: number, lte: boolean): { next: number; idx: number } {
  if (lte) {
    const compressed = Math.floor(tick / ts);
    const bitPos = compressed & 255;
    const wordStart = (compressed - bitPos) * ts;
    const maxTick = compressed * ts;
    for (let i = ticks.length - 1; i >= 0; i--) {
      const t = ticks[i].tick;
      if (t <= maxTick) return t >= wordStart ? { next: t, idx: i } : { next: wordStart, idx: -1 };
    }
    return { next: wordStart, idx: -1 };
  }
  const compressed = Math.floor(tick / ts) + 1;
  const bitPos = compressed & 255;
  const wordEnd = (compressed + 255 - bitPos) * ts;
  const minTick = compressed * ts;
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i].tick;
    if (t >= minTick) return t <= wordEnd ? { next: t, idx: i } : { next: wordEnd, idx: -1 };
  }
  return { next: wordEnd, idx: -1 };
}

// Walk an exact-input trade through the ranges, like the pool's swap().
// zeroForOne = token0 in, token1 out. tick: the pool's current tick if
// known (slot0), else worked out from the price. feePips: the full fee the
// pool charges for this direction (V4: LP fee + protocol fee, v4SwapFeePips).
export function swapExactInTicks(p: {
  sqrtPriceX96: bigint; liquidity: bigint; tick?: number; feePips: number;
  window: TickWindow; zeroForOne: boolean; amountIn: bigint;
}): TickSwapResult | null {
  if (p.amountIn <= 0n) return { amountOut: 0n, amountInUsed: 0n, crossed: 0, leftWindow: false, sqrtPriceAfter: p.sqrtPriceX96, liquidityAfter: p.liquidity };
  if (p.sqrtPriceX96 <= MIN_SQRT_RATIO || p.sqrtPriceX96 >= MAX_SQRT_RATIO) return null;
  if (!Number.isInteger(p.feePips) || p.feePips < 0 || p.feePips >= 1_000_000) return null;
  const w = p.window, ts = w.tickSpacing;
  if (!Number.isInteger(ts) || ts < 1) return null;
  const fee = BigInt(p.feePips);
  let tick = p.tick ?? getTickAtSqrtRatio(p.sqrtPriceX96);
  // The current price must be inside what we read, else we know nothing.
  if (tick < w.lo || tick > w.hi) return null;
  let sqrtP = p.sqrtPriceX96, L = p.liquidity, remaining = p.amountIn, out = 0n, crossed = 0, leftWindow = false;
  const limit = p.zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;
  for (let guard = 0; remaining > 0n && sqrtP !== limit && guard < 10_000; guard++) {
    const start = sqrtP;
    let { next, idx } = nextTickWithinWord(w.ticks, tick, ts, p.zeroForOne);
    // Past the edge of what we read: stop at the edge, the rest is unknown.
    let edge = false;
    if (p.zeroForOne && next < w.lo) { next = w.lo; idx = -1; edge = true; }
    if (!p.zeroForOne && next > w.hi) { next = w.hi; idx = -1; edge = true; }
    next = Math.max(MIN_TICK, Math.min(MAX_TICK, next));
    let target = getSqrtRatioAtTick(next);
    if (p.zeroForOne ? target < limit : target > limit) target = limit;
    const s = swapStep(sqrtP, target, L, remaining, fee);
    sqrtP = s.next;
    remaining -= s.amountIn + s.fee;
    out += s.amountOut;
    if (sqrtP === target) {
      if (edge) { leftWindow = remaining > 0n; break; }
      if (idx >= 0) {
        const net = w.ticks[idx].liquidityNet;
        L = p.zeroForOne ? L - net : L + net;
        if (L < 0n) return null; // our tick data disagrees with the pool's liquidity: don't guess
        crossed++;
      }
      tick = p.zeroForOne ? next - 1 : next;
    } else if (sqrtP !== start && remaining > 0n) {
      // (Only needed for another step; skipped when the trade is done: it's
      // the slowest part of the walk.)
      tick = getTickAtSqrtRatio(sqrtP);
    }
  }
  return { amountOut: out, amountInUsed: p.amountIn - remaining, crossed, leftWindow, sqrtPriceAfter: sqrtP, liquidityAfter: L };
}

// Tick-bitmap helpers (shared by the V3 and V4 readers): which bitmap word
// and bit a tick lives in, for a pool's tick spacing.
export function compressTick(tick: number, tickSpacing: number): number { return Math.floor(tick / tickSpacing); }
export function wordOf(tick: number, tickSpacing: number): number { return compressTick(tick, tickSpacing) >> 8; }
// Every initialized tick in one bitmap word.
export function ticksInWord(word: number, bitmap: bigint, tickSpacing: number): number[] {
  const out: number[] = [];
  if (bitmap === 0n) return out;
  for (let bit = 0; bit < 256; bit++) if ((bitmap >> BigInt(bit)) & 1n) out.push((word * 256 + bit) * tickSpacing);
  return out;
}
// The tick range a block of words covers.
export function wordsRange(firstWord: number, lastWord: number, tickSpacing: number): { lo: number; hi: number } {
  return {
    lo: Math.max(MIN_TICK, firstWord * 256 * tickSpacing),
    hi: Math.min(MAX_TICK, ((lastWord + 1) * 256 - 1) * tickSpacing),
  };
}

// V4 PROTOCOL FEE (Nov 2 finding). Plain English: Uniswap V4 can charge a
// small extra "protocol" fee on top of the pool's own (LP) fee. On Robinhood
// Chain it is switched on for the V4 pools we checked: 0.05% to 0.10% per
// trade (StateView getSlot0 shows it as protocolFee). The bot only charged
// the LP fee, so every V4 guess was 0.05-0.10% too high per pool hop.
// protocolFee packs both directions in 12 bits each: the low 12 bits for
// token0-in trades, the high 12 bits for token1-in trades. The total fee is
// Uniswap's ProtocolFeeLibrary.calculateSwapFee:
//   protocol + lp - protocol * lp / 1,000,000 (rounded down).
export function v4SwapFeePips(lpFee: number, protocolFee: number, zeroForOne: boolean): number {
  const pf = zeroForOne ? protocolFee & 0xfff : (protocolFee >> 12) & 0xfff;
  if (pf === 0) return lpFee;
  return pf + lpFee - Math.floor((pf * lpFee) / 1_000_000);
}
