import { PoolCache } from '../core/poolCache';
import { planBackrun } from '../core/backrunPlanner';
import { calculateLiquidityCeiling, calculateAllInProfit } from '../core/profitCalculator';
import { PoolState } from '../core/types';

// Proves trade sizing works when the starting token is NOT 18 decimals
// (USDC = 6), measures depth on the traded token's side, and no longer
// double-counts DEX fees.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const USDC = '0xUSDC';
const WETH = '0xWETH';

// Both pools: 1,000 WETH vs $3.4M USDC ($3,400/WETH). USDC has 6 decimals.
const victim: PoolState = {
  chain: 'monad', dex: 'dexA', poolAddress: '0xA', poolType: 'v2',
  tokenA: WETH, tokenB: USDC, reserveA: 1_000n * E18, reserveB: 3_400_000n * E6,
  feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: Date.now(),
};
const peer: PoolState = { ...victim, dex: 'dexB', poolAddress: '0xB' };

const cache = new PoolCache();
cache.upsert(victim);
cache.upsert(peer);

// 1. Depth on the USDC side, with USDC's real 6 decimals: $3.4M.
const ceilingUsdc = calculateLiquidityCeiling(victim, peer, 1, { tokenIn: USDC, tokenInDecimals: 6 });
assert(Math.abs(ceilingUsdc - 3_400_000 * 0.05) < 1, `USDC-side ceiling uses real depth: 5% tier of $3.4M = $170k (got $${ceilingUsdc.toFixed(0)})`);
// The old behaviour (first token, 18 decimals, priced as USDC) was wildly off.
const oldStyle = calculateLiquidityCeiling(victim, peer, 1);
assert(Math.abs(oldStyle - ceilingUsdc) > 50_000, `old default measured the wrong side ($${oldStyle.toFixed(0)} vs $${ceilingUsdc.toFixed(0)})`);

// 2. Pending swaps that push the victim pool's price, so a backrun exists.
// First a WETH-start route (18 decimals), then a USDC-start route (6
// decimals) -- the case the old 18-decimal maths got wrong.
const costs = { gasPriceUsd: 2, dexFeeBps: { buy: 30, sell: 30 }, flashLoanFeeBps: 9, usingFlashLoan: true, safetyMarginPct: 0.15 };
const plan = planBackrun(cache, victim, peer, { tokenIn: WETH, amountIn: 60n * E18, stateType: 'PENDING' }, 3400, costs, 18);
assert(plan !== null && plan.profit.conservativeNetProfitUsd > 20, `WETH-start backrun found (net $${plan?.profit.conservativeNetProfitUsd.toFixed(2)})`);

// Same opportunity, but the swap is a USDC buy, so we start in USDC (6 dec).
const usdcSwap = { tokenIn: USDC, amountIn: 200_000n * E6, stateType: 'PENDING' as const };
const usdcPlan = planBackrun(cache, victim, peer, usdcSwap, 1, costs, 6);
assert(usdcPlan !== null, 'USDC-start backrun found (was invisible with 18-decimal maths)');
const size = usdcPlan?.sizing.optimalTradeSizeUsd ?? 0;
const net = usdcPlan?.profit.conservativeNetProfitUsd ?? 0;
assert(size > 0 && size <= ceilingUsdc && net > 20 && net < size, `USDC sizing is sane: trade $${size.toFixed(0)}, net $${net.toFixed(2)}`);

// 3. Fees not double counted: identical pools, no pending trade -> the only
// costs left after the swap maths are gas + flash fee, so the net loss
// is small, not "fees subtracted twice".
const sizing = { optimalTradeSizeUsd: 10_000, grossProfitUsd: 100 };
const p = calculateAllInProfit(sizing, costs);
// 100 gross - 2 gas - 9 flash fee = 89, minus 15% margin = 75.65
assert(Math.abs(p.conservativeNetProfitUsd - 75.65) < 0.01, `net = gross - gas - flash fee - margin = $75.65 (got $${p.conservativeNetProfitUsd.toFixed(2)})`);
assert(p.breakdown.dexFees === 60, 'DEX fees still reported in the breakdown ($60) for visibility');
