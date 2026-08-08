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
export function calculateLiquidityCeiling(
buyPool: PoolState,
sellPool: PoolState,
usdPerToken: number,
): number {
const poolUsdLiquidity = (pool: PoolState): number => {
if (pool.poolType === 'v2' && pool.reserveA !== undefined) {
// reserveA side, converted to USD — assumes tokenA is the priced side
// (e.g. the stable or the token usdPerToken corresponds to). Real
// implementation should price whichever side is more reliable.
return Number(pool.reserveA) / 1e18 * usdPerToken;
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
const virtualX = (pool.liquidity * Q96) / pool.sqrtPriceX96;
return Number(virtualX) / 1e18 * usdPerToken;
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
export function findOptimalTradeSize(
buyPool: PoolState,
sellPool: PoolState,
cache: PoolCache,
tokenInIsAOnBuyPool: boolean,
maxCandidateUsd: number,
usdPerToken: number,
approxCostRateBps: number = (buyPool.feeBps + sellPool.feeBps + 9), // + flash loan fee default
approxFixedGasUsd: number = 2,
): SizingResult {
const candidates = [0.01, 0.025, 0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 1.0].map(f => maxCandidateUsd * f);

let best: SizingResult = { optimalTradeSizeUsd: 0, grossProfitUsd: -Infinity };
let bestApproxNet = -Infinity;

for (const usdSize of candidates) {
const amountIn = BigInt(Math.floor((usdSize / usdPerToken) * 1e18));

// Universal getAmountOut — works identically whether buyPool/sellPool
// are v2 or v3, the sizing logic never needs to know which.
const tokenOut = computeAmountOut(buyPool, tokenInIsAOnBuyPool, amountIn);
if (tokenOut === null || tokenOut <= 0n) continue;

const usdOut = computeAmountOut(sellPool, !tokenInIsAOnBuyPool, tokenOut);
if (usdOut === null || usdOut <= 0n) continue;

const usdOutValue = Number(usdOut) / 1e18 * usdPerToken;
const grossProfitUsd = usdOutValue - usdSize;

// Approximate net used ONLY to pick the best size — the real, exact
// cost breakdown still runs afterward in calculateAllInProfit().
const approxCosts = (usdSize * approxCostRateBps) / 10_000 + approxFixedGasUsd;
const approxNet = grossProfitUsd - approxCosts;

if (approxNet > bestApproxNet) {
bestApproxNet = approxNet;
best = { optimalTradeSizeUsd: usdSize, grossProfitUsd };
}
}

return best;
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

const predictedNet = sizing.grossProfitUsd - dexFees - gas - flashLoanFee;
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
