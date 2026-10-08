import { PoolState, ArbOpportunity, MIN_NET_PROFIT_USD, ChainName, RawChainEvent } from './types';
import { PoolCache } from './poolCache';
import { computeAmountOut } from './dexMath';

// ============================================================================
// PROFIT CALCULATOR
// Subtracts every real cost before anything counts as an opportunity.
// Core rule: conservative expected net profit must be >= $20 (MIN_NET_PROFIT_USD)
// AFTER a safety-margin haircut, not before.
// ============================================================================

export interface CostEstimateInputs {
gasPriceUsd: number;        // estimated gas cost in USD for this chain right now
dexFeeBps: { buy: number; sell: number };
flashLoanFeeBps: number;    // 0 if using own capital
usingFlashLoan: boolean;
safetyMarginPct: number;    // e.g. 0.15 = shave 15% off predicted profit
}

export interface SizingResult {
optimalTradeSizeUsd: number;
grossProfitUsd: number;
}

// Liquidity ceiling: never test candidate sizes larger than what the
// THINNER of the two pools can reasonably absorb. Using the smaller pool
// as the constraint (not the average, not the bigger one) protects us from
// picking a size that blows out slippage on whichever side is shallower.
// Matches the tiered approach from the original Arbitrum bot.
//
// `tokenIn` / `tokenInDecimals`: the token being traded and its decimals.
// Depth is measured on THAT token's side of each pool and converted with
// its real decimals. (Previously it always used the first-listed token and
// assumed 18 decimals, so USDC-side depth was off by up to 10^12.)
// When omitted, falls back to the first-listed token at 18 decimals.
export interface TradeToken {
tokenIn?: string;
tokenInDecimals?: number;
}

// Which side of the pool `tokenIn` is on (defaults to the first-listed token).
function tokenInIsA(pool: PoolState, tokenIn?: string): boolean {
return !tokenIn || pool.tokenA.toLowerCase() === tokenIn.toLowerCase();
}

export function calculateLiquidityCeiling(
buyPool: PoolState,
sellPool: PoolState,
usdPerToken: number,
token: TradeToken = {},
): number {
const scale = 10 ** (token.tokenInDecimals ?? 18);
const poolUsdLiquidity = (pool: PoolState): number => {
const inIsA = tokenInIsA(pool, token.tokenIn);
if (pool.poolType === 'v2' && pool.reserveA !== undefined && pool.reserveB !== undefined) {
// The traded token's own reserve, priced at its own USD price.
const reserveIn = inIsA ? pool.reserveA : pool.reserveB;
return Number(reserveIn) / scale * usdPerToken;
}
if (pool.poolType === 'v3' && pool.liquidity !== undefined && pool.sqrtPriceX96 !== undefined) {
// Convert v3's active-tick liquidity into an equivalent "virtual
// reserve" in the same units as v2, using the same identity dexMath
// uses: virtualX = L * Q96 / sqrtP. This only reflects liquidity in
// the CURRENT tick range, not the pool's total TVL across all ticks —
// appropriately conservative for a safety ceiling, since liquidity
// outside the active range isn't available at the current price
// anyway.
const Q96 = 1n << 96n;
// virtualX is tokenA-side depth, virtualY is tokenB-side depth.
const virtual = inIsA
? (pool.liquidity * Q96) / pool.sqrtPriceX96
: (pool.liquidity * pool.sqrtPriceX96) / Q96;
return Number(virtual) / scale * usdPerToken;
}
return 0;
};

const buyLiquidityUsd = poolUsdLiquidity(buyPool);
const sellLiquidityUsd = poolUsdLiquidity(sellPool);
const thinnerPoolUsd = Math.min(buyLiquidityUsd, sellLiquidityUsd);

if (thinnerPoolUsd <= 0) return 0;

// Tiered cap: smaller pools get a smaller % ceiling, since even a modest
// trade against a thin pool creates outsized slippage. Larger pools can
// safely absorb a slightly bigger share.
let capPct: number;
if (thinnerPoolUsd < 50_000) capPct = 0.01;
else if (thinnerPoolUsd < 250_000) capPct = 0.02;
else if (thinnerPoolUsd < 1_000_000) capPct = 0.03;
else capPct = 0.05;

return thinnerPoolUsd * capPct;
}

// Trade size optimizer: bigger isn't always better, because our own trade
// moves the price against us — AND because flat-rate costs (DEX fees,
// flash loan fee) scale with size while gas is roughly fixed. We optimize
// for approximate NET profit, not gross, or the optimizer will happily
// pick a size where fees eat the entire spread (caught by profitMath.test.ts).
//
// What the two "approx" cost settings actually do (checked Oct 2026):
//   - approxCostRateBps (default 9 = a 0.09% flash-loan fee) DOES change the
//     chosen size: a per-dollar cost makes bigger trades less attractive.
//   - approxFixedGasUsd (default $2) does NOT change the chosen size: it is
//     the same amount subtracted from every candidate, so the winner is the
//     same. It only matters inside this function's own comparison; the real
//     gas cost is applied afterwards in calculateAllInProfit().

// The sizes tried, as fractions of the liquidity ceiling (the "coarse grid").
export const SIZE_CANDIDATE_FRACTIONS = [0.01, 0.025, 0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 1.0];

export interface SizingOptions {
  // OFF by default (current behaviour). When true, after the 10-size coarse
  // search we zoom in between the best size's two neighbours with a
  // "golden-section search" (repeatedly narrowing the range, keeping the
  // better side), so the chosen size can land BETWEEN the coarse sizes.
  // The result is never worse than the coarse answer: the coarse winner is
  // kept unless a refined size beats it. Costs ~24 extra price calculations
  // (pure maths, no network calls).
  refine?: boolean;
  refineIterations?: number; // how many narrowing steps (default 24: range shrinks ~100,000x)
}

// One round trip quote: "if I put in `usdSize` dollars, what is my gross
// profit in dollars?" null = the pools can't quote this size.
export type RoundTripQuote = (usdSize: number) => number | null;

// The search itself, independent of how a size is priced. findOptimalTradeSize
// below feeds it the bot's pool maths; tests feed it exact reference maths.
export function optimizeTradeSize(
  quote: RoundTripQuote,
  maxCandidateUsd: number,
  approxCostRateBps: number = 9,
  approxFixedGasUsd: number = 2,
  opts: SizingOptions = {},
): SizingResult {
  const candidates = SIZE_CANDIDATE_FRACTIONS.map(f => maxCandidateUsd * f);
  // Approximate net used ONLY to pick the best size; the real, exact cost
  // breakdown still runs afterward in calculateAllInProfit().
  const approxNet = (usdSize: number, gross: number) =>
    gross - ((usdSize * approxCostRateBps) / 10_000 + approxFixedGasUsd);

  let best: SizingResult = { optimalTradeSizeUsd: 0, grossProfitUsd: -Infinity };
  let bestApproxNet = -Infinity;
  let bestIndex = -1;

  candidates.forEach((usdSize, i) => {
    const gross = quote(usdSize);
    if (gross === null) return;
    const net = approxNet(usdSize, gross);
    if (net > bestApproxNet) {
      bestApproxNet = net;
      best = { optimalTradeSizeUsd: usdSize, grossProfitUsd: gross };
      bestIndex = i;
    }
  });

  if (!opts.refine || bestIndex < 0) return best;

  // Golden-section search between the winner's neighbours. Round-trip
  // profit vs size rises then falls (one peak), which is exactly the shape
  // this method is built for.
  let lo = bestIndex > 0 ? candidates[bestIndex - 1] : 0;
  let hi = bestIndex < candidates.length - 1 ? candidates[bestIndex + 1] : candidates[bestIndex];
  if (!(hi > lo)) return best;
  const evalNet = (usdSize: number): number => {
    const gross = quote(usdSize);
    if (gross === null) return -Infinity;
    const net = approxNet(usdSize, gross);
    if (net > bestApproxNet) {
      bestApproxNet = net;
      best = { optimalTradeSizeUsd: usdSize, grossProfitUsd: gross };
    }
    return net;
  };
  const INV_PHI = (Math.sqrt(5) - 1) / 2; // ~0.618
  let x1 = hi - INV_PHI * (hi - lo);
  let x2 = lo + INV_PHI * (hi - lo);
  let f1 = evalNet(x1);
  let f2 = evalNet(x2);
  const steps = opts.refineIterations ?? 24;
  for (let k = 0; k < steps; k++) {
    if (f1 < f2) { lo = x1; x1 = x2; f1 = f2; x2 = lo + INV_PHI * (hi - lo); f2 = evalNet(x2); }
    else { hi = x2; x2 = x1; f2 = f1; x1 = hi - INV_PHI * (hi - lo); f1 = evalNet(x1); }
  }
  return best;
}

export function findOptimalTradeSize(
buyPool: PoolState,
sellPool: PoolState,
cache: PoolCache,
tokenInIsAOnBuyPool: boolean,
maxCandidateUsd: number,
usdPerToken: number,
// DEX fees are NOT included here: computeAmountOut() already deducts each
// pool's fee from the swap output, so adding them again double-counted them
// and made every opportunity look ~0.5% worse than it really is.
approxCostRateBps: number = 9, // flash loan fee (pass 0 to size for own capital)
approxFixedGasUsd: number = 2, // does not change the chosen size (see above)
tokenInDecimals: number = 18,  // real decimals of the token we start with
opts: SizingOptions = {},      // refine: off by default
): SizingResult {
const scale = 10 ** tokenInDecimals;

// The sell pool may list the pair in the opposite order (tokenA/tokenB
// swapped vs the buy pool), so work out its direction from the actual
// token addresses instead of assuming both pools share the same order.
const buyOutToken = (tokenInIsAOnBuyPool ? buyPool.tokenB : buyPool.tokenA).toLowerCase();
const sellInIsA = sellPool.tokenA.toLowerCase() === buyOutToken;

const quote: RoundTripQuote = (usdSize) => {
const amountIn = BigInt(Math.floor((usdSize / usdPerToken) * scale));

// Universal getAmountOut — works identically whether buyPool/sellPool
// are v2 or v3, the sizing logic never needs to know which.
const tokenOut = computeAmountOut(buyPool, tokenInIsAOnBuyPool, amountIn);
if (tokenOut === null || tokenOut <= 0n) return null;

const usdOut = computeAmountOut(sellPool, sellInIsA, tokenOut);
if (usdOut === null || usdOut <= 0n) return null;

const usdOutValue = Number(usdOut) / scale * usdPerToken;
return usdOutValue - usdSize;
};

return optimizeTradeSize(quote, maxCandidateUsd, approxCostRateBps, approxFixedGasUsd, opts);
}

export function calculateAllInProfit(
sizing: SizingResult,
costs: CostEstimateInputs,
): { conservativeNetProfitUsd: number; breakdown: ArbOpportunity['costsUsd']; qualifies: boolean } {
const dexFees = sizing.optimalTradeSizeUsd * ((costs.dexFeeBps.buy + costs.dexFeeBps.sell) / 10_000);
const flashLoanFee = costs.usingFlashLoan
? sizing.optimalTradeSizeUsd * (costs.flashLoanFeeBps / 10_000)
: 0;
const gas = costs.gasPriceUsd;

// grossProfitUsd comes from computeAmountOut(), which already takes each
// pool's fee out of the swap output. dexFees is still reported in the
// breakdown (useful to see) but NOT subtracted again -- that was a double
// count that hid real opportunities.
const predictedNet = sizing.grossProfitUsd - gas - flashLoanFee;
const safetyMargin = Math.max(0, predictedNet * costs.safetyMarginPct);
const conservativeNetProfitUsd = predictedNet - safetyMargin;

return {
conservativeNetProfitUsd,
breakdown: {
dexFees,
gas,
flashLoanFee,
slippageBuffer: 0, // folded into sizing simulation itself
safetyMargin,
},
qualifies: conservativeNetProfitUsd >= MIN_NET_PROFIT_USD,
};
}

export function buildOpportunity(
chain: ChainName,
tokenPair: [string, string],
buyDex: string,
buyPool: string,
sellDex: string,
sellPool: string,
sizing: SizingResult,
profit: ReturnType<typeof calculateAllInProfit>,
triggeringEvent: RawChainEvent,
score: number,
): ArbOpportunity {
return {
id: `${chain}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
chain,
tokenPair,
buyDex,
buyPool,
sellDex,
sellPool,
optimalTradeSizeUsd: sizing.optimalTradeSizeUsd,
grossProfitUsd: sizing.grossProfitUsd,
costsUsd: profit.breakdown,
conservativeNetProfitUsd: profit.conservativeNetProfitUsd,
triggeringEvent,
scoredAtMs: Date.now(),
score,
};
}
