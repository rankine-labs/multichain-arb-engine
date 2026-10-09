// ============================================================================
// TRADE-SIZE SEARCH: how much profit does the 10-size search leave behind?
//
// Plain English:
//   The bot picks a trade size by trying 10 sizes (1%, 2.5%, 5% ... 100% of
//   a safety ceiling) and keeping the best. The real best size is usually
//   BETWEEN two of those, so some profit is left on the table. This test:
//     1. checks the exact reference V3 maths (helpers/v3Exact.ts) against
//        known on-chain values,
//     2. checks the bot's default search is unchanged by this phase's edits,
//     3. runs a few hundred realistic pool pairs (V2 and V3 with real tick
//        crossings, Robinhood-sized pools) and measures, with EXACT swap maths:
//          - coarse (today's 10 sizes) vs a very fine search (the "true" best
//            size under the same ceiling)
//          - the optional refinement step (golden-section, off by default)
//          - how much the ceiling itself holds back (best size beyond it)
//          - how far the bot's single-band V3 shortcut is from exact V3 maths
//   It prints a summary table. Assertions only check things that must always
//   hold (refinement never worse, etc.), so it is not flaky.
// ============================================================================

import { computeAmountOut } from '../core/dexMath';
import { optimizeTradeSize, findOptimalTradeSize, calculateLiquidityCeiling, SIZE_CANDIDATE_FRACTIONS } from '../core/profitCalculator';
import { PoolCache } from '../core/poolCache';
import { PoolState } from '../core/types';
import { Q96, MIN_TICK, MAX_TICK, MIN_SQRT_RATIO, MAX_SQRT_RATIO, sqrtRatioAtTick, exactSwap, poolFromPositions, ExactV3Pool, tickForPrice } from './helpers/v3Exact';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// Deterministic random numbers (same scenarios every run).
let seed = 20261008;
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const logUniform = (lo: number, hi: number) => Math.exp(Math.log(lo) + rand() * (Math.log(hi) - Math.log(lo)));
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];

// ---------------------------------------------------------------------------
// 1. Reference maths sanity
// ---------------------------------------------------------------------------
assert(sqrtRatioAtTick(0) === Q96, 'tick 0 = price 1 (sqrt = 2^96)');
assert(sqrtRatioAtTick(MIN_TICK) === MIN_SQRT_RATIO, 'lowest tick matches Uniswap MIN_SQRT_RATIO');
assert(sqrtRatioAtTick(MAX_TICK) === MAX_SQRT_RATIO, 'highest tick matches Uniswap MAX_SQRT_RATIO');
let worstTickErr = 0;
for (let i = 0; i < 200; i++) {
  const t = Math.round((rand() - 0.5) * 2 * 400_000);
  const exact = Number(sqrtRatioAtTick(t)) / Number(Q96);
  const approx = Math.pow(1.0001, t / 2);
  worstTickErr = Math.max(worstTickErr, Math.abs(exact / approx - 1));
}
assert(worstTickErr < 1e-9, `tick -> price agrees with 1.0001^tick everywhere (worst ${worstTickErr.toExponential(2)})`);

// Single wide band: the bot's shortcut and exact V3 must agree (no tick crossed).
{
  const tick = tickForPrice(4000e-12, 10); // WETH (token0, 18 dp) priced in USDG (token1, 6 dp) at $4,000
  // ~$1.3M of WETH-side liquidity in one wide band, so 1 WETH barely moves the price.
  const pool = poolFromPositions(tick, 500, [{ tickLower: tick - 20_000, tickUpper: tick + 20_000, liquidity: 10n ** 18n }]);
  const ps: PoolState = { chain: 'robinhood', dex: 'uniswap-v3', poolAddress: '0x1', poolType: 'v3', tokenA: 'weth', tokenB: 'usdg',
    sqrtPriceX96: pool.sqrtPriceX96, liquidity: pool.liquidity, feeBps: 5, lastUpdatedBlock: 0, lastUpdatedMs: 0 };
  const inUsdg = 5_000n * 10n ** 6n;
  const exactOut = exactSwap(pool, false, inUsdg).amountOut;
  const approxOut = computeAmountOut(ps, false, inUsdg)!;
  const rel = Math.abs(Number(approxOut - exactOut)) / Number(exactOut);
  assert(rel < 1e-6, `inside one band the bot's V3 shortcut equals exact V3 (diff ${rel.toExponential(2)})`);
  const exactOut0 = exactSwap(pool, true, 10n ** 18n).amountOut;
  const approxOut0 = computeAmountOut(ps, true, 10n ** 18n)!;
  assert(Math.abs(Number(approxOut0 - exactOut0)) / Number(exactOut0) < 1e-6, 'same in the other direction (token0 in = tokenA in)');
  // Direction check: selling 1 WETH gives ~$4,000 less 0.05% fee.
  // (the pool's price sits up to 10 ticks = 0.1% under $4,000: tick spacing)
  const usd = Number(exactOut0) / 1e6;
  assert(usd > 3990 && usd < 4000, `1 WETH -> ~$3,998 USDG at $4,000 with a 0.05% fee (got $${usd.toFixed(2)})`);
}

// Crossing out of a narrow band: shortcut OVERstates output (it assumes the
// band's liquidity continues forever).
{
  const tick = tickForPrice(4000e-12, 10);
  const pool = poolFromPositions(tick, 500, [
    { tickLower: tick - 50, tickUpper: tick + 50, liquidity: 4n * 10n ** 15n },   // +-0.5% band, deep
    { tickLower: tick - 5_000, tickUpper: tick + 5_000, liquidity: 10n ** 14n }, // +-~65%, thin
  ]);
  const ps: PoolState = { chain: 'robinhood', dex: 'uniswap-v3', poolAddress: '0x1', poolType: 'v3', tokenA: 'weth', tokenB: 'usdg',
    sqrtPriceX96: pool.sqrtPriceX96, liquidity: pool.liquidity, feeBps: 5, lastUpdatedBlock: 0, lastUpdatedMs: 0 };
  const big = 200_000n * 10n ** 6n;
  const exactOut = exactSwap(pool, false, big).amountOut;
  const approxOut = computeAmountOut(ps, false, big)!;
  assert(approxOut > exactOut, `crossing out of a deep band: shortcut overstates output (${(Number(approxOut - exactOut) / Number(exactOut) * 100).toFixed(1)}% too high)`);
}

// ---------------------------------------------------------------------------
// 2. Default search unchanged (frozen copy of the pre-Phase-3 code)
// ---------------------------------------------------------------------------
function legacyFindOptimal(buyPool: PoolState, sellPool: PoolState, inIsA: boolean, max: number, usdPerToken: number, rate = 9, gas = 2, dec = 18) {
  const scale = 10 ** dec;
  let best = { optimalTradeSizeUsd: 0, grossProfitUsd: -Infinity }, bestNet = -Infinity;
  for (const usdSize of [0.01, 0.025, 0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 1.0].map((f) => max * f)) {
    const amountIn = BigInt(Math.floor((usdSize / usdPerToken) * scale));
    const tokenOut = computeAmountOut(buyPool, inIsA, amountIn);
    if (tokenOut === null || tokenOut <= 0n) continue;
    const buyOut = (inIsA ? buyPool.tokenB : buyPool.tokenA).toLowerCase();
    const usdOut = computeAmountOut(sellPool, sellPool.tokenA.toLowerCase() === buyOut, tokenOut);
    if (usdOut === null || usdOut <= 0n) continue;
    const gross = Number(usdOut) / scale * usdPerToken - usdSize;
    const net = gross - ((usdSize * rate) / 10_000 + gas);
    if (net > bestNet) { bestNet = net; best = { optimalTradeSizeUsd: usdSize, grossProfitUsd: gross }; }
  }
  return best;
}
{
  const cache = new PoolCache();
  let same = 0, total = 0;
  for (let i = 0; i < 60; i++) {
    const rA = BigInt(Math.floor(logUniform(1e3, 1e6))) * 10n ** 18n;
    const gap = 1 + (rand() - 0.5) * 0.06;
    const a: PoolState = { chain: 'robinhood', dex: 'uniswap-v2', poolAddress: '0xa', poolType: 'v2', tokenA: 'X', tokenB: 'Y', reserveA: rA, reserveB: rA * 3n, feeBps: 30, lastUpdatedBlock: 0, lastUpdatedMs: 0 };
    const b: PoolState = { ...a, poolAddress: '0xb', dex: 'pancakeswap-v2', tokenA: 'Y', tokenB: 'X', reserveA: BigInt(Math.floor(Number(rA) * 3 * gap)), reserveB: rA, feeBps: 25 };
    const max = Number(rA) / 1e18 * 0.02;
    const now = findOptimalTradeSize(a, b, cache, true, max, 1);
    const old = legacyFindOptimal(a, b, true, max, 1);
    total++;
    if (now.optimalTradeSizeUsd === old.optimalTradeSizeUsd && (now.grossProfitUsd === old.grossProfitUsd)) same++;
  }
  assert(same === total, `default search gives identical answers to the old code (${same}/${total})`);
  assert(SIZE_CANDIDATE_FRACTIONS.length === 10, 'still 10 coarse sizes');
}

// ---------------------------------------------------------------------------
// 3. Scenario study with exact maths
// ---------------------------------------------------------------------------
// Start token: USDG ($1, 6 decimals, token1). Middle token: WETH (18 dp, token0).
const ETH_USD = 4000;
const USDG_SCALE = 1e6;
const WETH_SCALE = 1e18;

type Venue =
  | { kind: 'v2'; rWeth: bigint; rUsdg: bigint; feeBps: number }
  | { kind: 'v3'; pool: ExactV3Pool };

// Exact output of one swap. usdgIn = true: USDG -> WETH.
function exactOut(v: Venue, usdgIn: boolean, amountIn: bigint): bigint {
  if (amountIn <= 0n) return 0n;
  if (v.kind === 'v2') {
    // Same formula as the contract's _swapV2 and UniswapV2Library.getAmountOut.
    const [rIn, rOut] = usdgIn ? [v.rUsdg, v.rWeth] : [v.rWeth, v.rUsdg];
    const inWithFee = amountIn * BigInt(10_000 - v.feeBps);
    return (inWithFee * rOut) / (rIn * 10_000n + inWithFee);
  }
  // USDG is token1, so USDG in = oneForZero (zeroForOne = false).
  return exactSwap(v.pool, !usdgIn, amountIn).amountOut;
}

// What the bot itself sees: PoolState with tokenA = WETH (token0).
function toPoolState(v: Venue, addr: string): PoolState {
  const base = { chain: 'robinhood' as const, poolAddress: addr, tokenA: 'weth', tokenB: 'usdg', lastUpdatedBlock: 0, lastUpdatedMs: 0 };
  if (v.kind === 'v2') return { ...base, dex: 'uniswap-v2', poolType: 'v2', reserveA: v.rWeth, reserveB: v.rUsdg, feeBps: v.feeBps };
  return { ...base, dex: 'uniswap-v3', poolType: 'v3', sqrtPriceX96: v.pool.sqrtPriceX96, liquidity: v.pool.liquidity,
    feeBps: Math.round(v.pool.feePips / 100), feePips: v.pool.feePips };
}

// Liquidity L that puts ~usd dollars into the band [pLo, pHi] around price p
// (raw prices: USDG units per WETH unit).
function liquidityForUsd(usd: number, p: number, pLo: number, pHi: number): bigint {
  const s = Math.sqrt(p), sa = Math.sqrt(pLo), sb = Math.sqrt(pHi);
  const usdPerL = (s - sa) / USDG_SCALE + ((1 / s - 1 / sb) / WETH_SCALE) * ETH_USD;
  return BigInt(Math.floor(usd / usdPerL));
}

function makeV2(depthUsd: number, priceUsd: number, feeBps: number): Venue {
  const half = depthUsd / 2;
  return { kind: 'v2', feeBps, rUsdg: BigInt(Math.floor(half * USDG_SCALE)), rWeth: BigInt(Math.floor((half / priceUsd) * WETH_SCALE)) };
}

// A V3 pool shaped like real ones: some liquidity concentrated near the
// price (narrow), some medium, a little full-range. Shapes vary per scenario.
function makeV3(depthUsd: number, priceUsd: number, feePips: number): Venue {
  const spacing = feePips === 100 ? 1 : feePips === 500 ? 10 : 60;
  const raw = priceUsd * USDG_SCALE / WETH_SCALE;
  const tick = tickForPrice(raw, 1);
  const narrowPct = pick([0.002, 0.005, 0.01]);
  const narrowShare = pick([0.2, 0.5, 0.8]);
  const band = (pct: number) => {
    const lo = Math.floor(tickForPrice(raw * (1 - pct), 1) / spacing) * spacing;
    const hi = Math.ceil(tickForPrice(raw * (1 + pct), 1) / spacing) * spacing;
    return { lo: Math.min(lo, tick - spacing), hi: Math.max(hi, tick + spacing) };
  };
  const n = band(narrowPct), m = band(0.05), w = band(0.9);
  const pos = (b: { lo: number; hi: number }, usd: number) => ({
    tickLower: b.lo, tickUpper: b.hi,
    liquidity: liquidityForUsd(usd, raw, Math.pow(1.0001, b.lo), Math.pow(1.0001, b.hi)),
  });
  const pool = poolFromPositions(tick, feePips, [
    pos(n, depthUsd * narrowShare),
    pos(m, depthUsd * (1 - narrowShare) * 0.7),
    pos(w, depthUsd * (1 - narrowShare) * 0.3),
  ]);
  return { kind: 'v3', pool };
}

const FLASH_BPS = 9;   // the bot's sizing default
const GAS_USD = 0.05;  // fixed gas does not change the chosen size; only shifts "net"

type Row = {
  kind: string; ceiling: number; realDepthUsd: number;
  coarse: number; refined: number; fine: number; beyond: number; coarseSize: number; fineSize: number;
  modelErrPct: number;   // bot's gross at its chosen size vs exact, %
  botExactNet: number;   // what the bot's chosen size REALLY nets (exact maths)
};
const rows: Row[] = [];

for (let i = 0; i < 300; i++) {
  const kind = pick(['v2-v2', 'v2-v3', 'v3-v2', 'v3-v3']);
  const depthA = logUniform(20_000, 2_000_000);
  const depthB = depthA * logUniform(0.2, 5);
  const gap = logUniform(0.003, 0.04);            // WETH dearer on the sell pool by 0.3% .. 4%
  const buyPrice = ETH_USD, sellPrice = ETH_USD * (1 + gap);
  const v2Fee = () => pick([30, 25, 20]);
  const v3Fee = () => pick([100, 500, 500, 3000]);
  const buy = kind.startsWith('v2') ? makeV2(depthA, buyPrice, v2Fee()) : makeV3(depthA, buyPrice, v3Fee());
  const sell = kind.endsWith('v2') ? makeV2(depthB, sellPrice, v2Fee()) : makeV3(depthB, sellPrice, v3Fee());

  // Exact round trip: USDG -> WETH on buy, WETH -> USDG on sell. Gross $ profit.
  const exactQuote = (usd: number): number | null => {
    const inRaw = BigInt(Math.floor(usd * USDG_SCALE));
    const weth = exactOut(buy, true, inRaw);
    if (weth <= 0n) return null;
    const back = exactOut(sell, false, weth);
    if (back <= 0n) return null;
    return Number(back) / USDG_SCALE - usd;
  };
  const net = (usd: number) => { const g = exactQuote(usd); return g === null ? -Infinity : g - usd * FLASH_BPS / 10_000 - GAS_USD; };

  // The bot's own ceiling for this pair (USDG side, 6 decimals).
  const psBuy = toPoolState(buy, '0xb0'), psSell = toPoolState(sell, '0x5e');
  const ceiling = calculateLiquidityCeiling(psBuy, psSell, 1, { tokenIn: 'usdg', tokenInDecimals: 6 });
  if (!(ceiling > 0)) continue;

  const coarse = optimizeTradeSize(exactQuote, ceiling, FLASH_BPS, GAS_USD);
  const refined = optimizeTradeSize(exactQuote, ceiling, FLASH_BPS, GAS_USD, { refine: true });
  // "Truth" under the same ceiling: 400-point grid, then refine around its best.
  let fineSize = 0, fineNet = -Infinity;
  for (let k = 1; k <= 400; k++) { const x = ceiling * k / 400; const n = net(x); if (n > fineNet) { fineNet = n; fineSize = x; } }
  for (let k = -20; k <= 20; k++) { const x = fineSize + (ceiling / 400) * k / 20; if (x > 0 && x <= ceiling) { const n = net(x); if (n > fineNet) { fineNet = n; fineSize = x; } } }
  // Without the ceiling (up to 40x it): how much the safety cap holds back.
  let beyondNet = fineNet;
  for (let k = 1; k <= 400; k++) { const n = net(ceiling * 40 * k / 400); if (n > beyondNet) beyondNet = n; }
  if (!(fineNet > 0)) continue; // only opportunities that are actually profitable

  // Bot's model at its own chosen size vs exact.
  const botSizing = findOptimalTradeSize(psBuy, psSell, new PoolCache(), false, ceiling, 1, FLASH_BPS, GAS_USD, 6);
  const exactAtBotSize = exactQuote(botSizing.optimalTradeSizeUsd);
  const modelErrPct = exactAtBotSize && botSizing.grossProfitUsd > 0 ? (botSizing.grossProfitUsd - exactAtBotSize) / Math.abs(exactAtBotSize) * 100 : NaN;
  const botExactNet = exactAtBotSize === null ? -Infinity : exactAtBotSize - botSizing.optimalTradeSizeUsd * FLASH_BPS / 10_000 - GAS_USD;

  rows.push({
    kind, ceiling, fine: fineNet, fineSize, botExactNet, realDepthUsd: Math.min(depthA, depthB),
    coarse: coarse.grossProfitUsd - coarse.optimalTradeSizeUsd * FLASH_BPS / 10_000 - GAS_USD,
    refined: refined.grossProfitUsd - refined.optimalTradeSizeUsd * FLASH_BPS / 10_000 - GAS_USD,
    beyond: beyondNet, coarseSize: coarse.optimalTradeSizeUsd, modelErrPct,
  });
}

const pct = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN; };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const f2 = (x: number) => x.toFixed(2);

console.log(`\nScenarios profitable under exact maths: ${rows.length} of 300`);
console.log('kind    n   coarse miss %: mean / median / p90 / max   | $ missed: mean / max | refined miss % max | ceiling holds back %: median');
for (const kind of ['v2-v2', 'v2-v3', 'v3-v2', 'v3-v3', 'all']) {
  const rs = rows.filter((r) => kind === 'all' || r.kind === kind);
  if (!rs.length) continue;
  const miss = rs.map((r) => (r.fine - r.coarse) / r.fine * 100);
  const missUsd = rs.map((r) => r.fine - r.coarse);
  const rmiss = rs.map((r) => (r.fine - r.refined) / r.fine * 100);
  const cap = rs.map((r) => (r.beyond - r.fine) / r.beyond * 100);
  console.log(`${kind.padEnd(6)} ${String(rs.length).padStart(3)}   ${f2(mean(miss))} / ${f2(pct(miss, 0.5))} / ${f2(pct(miss, 0.9))} / ${f2(Math.max(...miss))}`
    + `   | $${f2(mean(missUsd))} / $${f2(Math.max(...missUsd))}   | ${f2(Math.max(...rmiss))}   | ${f2(pct(cap, 0.5))}`);
}
const modelErrs = rows.filter((r) => r.kind !== 'v2-v2' && Number.isFinite(r.modelErrPct)).map((r) => r.modelErrPct);
console.log(`V3 shortcut vs exact at the bot's chosen size (gross profit, + = bot too optimistic): median ${f2(pct(modelErrs, 0.5))}%, p90 ${f2(pct(modelErrs, 0.9))}%, max ${f2(Math.max(...modelErrs))}%`);
// End to end: the bot's real pipeline (V3 shortcut + 10 sizes) vs the best possible.
for (const kind of ['v2-v2', 'any-v3']) {
  const rs = rows.filter((r) => (kind === 'v2-v2') === (r.kind === 'v2-v2'));
  const losers = rs.filter((r) => r.botExactNet <= 0).length;
  const capture = rs.map((r) => Math.max(0, r.botExactNet) / r.fine * 100);
  console.log(`${kind}: bot's chosen size really captures median ${f2(pct(capture, 0.5))}% / p10 ${f2(pct(capture, 0.1))}% of the best net; its size is a real LOSS in ${losers}/${rs.length}`);
}
const ceilVsReal = rows.filter((r) => r.kind !== 'v2-v2').map((r) => r.ceiling / r.realDepthUsd);
console.log(`V3 pairs: the bot's "liquidity ceiling" is median ${f2(pct(ceilVsReal, 0.5))}x / max ${f2(Math.max(...ceilVsReal))}x the thinner pool's REAL money (V2 pairs: 0.01-0.05x by design)`);
const tiny = rows.filter((r) => r.fineSize < r.ceiling * 0.01).length;
console.log(`Best size is below the smallest coarse size (1% of ceiling) in ${tiny}/${rows.length} scenarios`);
const atCeiling = rows.filter((r) => r.fineSize >= r.ceiling * 0.999).length;
console.log(`Best size is AT the ceiling in ${atCeiling}/${rows.length} scenarios (there the grid's 100% point is already optimal)\n`);

assert(rows.length >= 100, `enough profitable scenarios to measure (${rows.length})`);
assert(rows.every((r) => r.refined >= r.coarse - 1e-9), 'refinement is never worse than the coarse search');
assert(rows.every((r) => r.fine >= r.coarse - 1e-6), 'the fine search is never worse than the coarse search (sanity)');
const refinedMissMax = Math.max(...rows.map((r) => (r.fine - r.refined) / r.fine * 100));
assert(refinedMissMax < 1, `refinement lands within 1% of the true best in every scenario (worst ${f2(refinedMissMax)}%)`);

// Refinement is wired through findOptimalTradeSize, opt-in only.
{
  const cache = new PoolCache();
  const a = toPoolState(makeV2(200_000, 4000, 30), '0xa');
  const b = toPoolState(makeV2(150_000, 4000 * 1.02, 25), '0xb');
  const ceil = calculateLiquidityCeiling(a, b, 1, { tokenIn: 'usdg', tokenInDecimals: 6 });
  const off = findOptimalTradeSize(a, b, cache, false, ceil, 1, 9, 2, 6);
  const on = findOptimalTradeSize(a, b, cache, false, ceil, 1, 9, 2, 6, { refine: true });
  const netOf = (s: { optimalTradeSizeUsd: number; grossProfitUsd: number }) => s.grossProfitUsd - s.optimalTradeSizeUsd * 9 / 10_000;
  assert(SIZE_CANDIDATE_FRACTIONS.some((f) => Math.abs(off.optimalTradeSizeUsd - ceil * f) < 1e-9), 'refine off: size is one of the 10 coarse sizes');
  assert(netOf(on) >= netOf(off), `refine on: net >= coarse ($${f2(netOf(on))} vs $${f2(netOf(off))})`);
}
