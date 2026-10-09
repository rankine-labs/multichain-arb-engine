// ============================================================================
// FEES AND FUNDING
//
// Plain English:
//   1. Fee units. Pool fees come in "bps" (30 = 0.30%) or "pips" (3000 =
//      0.30%, Uniswap V3/V4). The swap maths now uses the exact pips value
//      when known, and gives the SAME answer as before for every pool that
//      only has whole bps. The price-guess code (poolCache) uses the same fee.
//   2. Funding. The planner can now be asked "what if this trade used our
//      own money instead of a flash loan?" (no loan fee). Off by default:
//      the bot's normal plan is unchanged.
// ============================================================================

import { computeAmountOut, feePipsOf, amountInAfterFee } from '../core/dexMath';
import { PoolCache } from '../core/poolCache';
import { planBackrun, compareFunding } from '../core/backrunPlanner';
import { calculateAllInProfit } from '../core/profitCalculator';
import { PoolState } from '../core/types';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const E18 = 10n ** 18n;
const base = { chain: 'robinhood' as const, lastUpdatedBlock: 0, lastUpdatedMs: 0 };

// ---- 1. fee units -----------------------------------------------------------
const v2: PoolState = { ...base, dex: 'uniswap-v2', poolAddress: '0x1', poolType: 'v2', tokenA: 'A', tokenB: 'B', reserveA: 1_000n * E18, reserveB: 4_000_000n * E18, feeBps: 30 };
assert(feePipsOf(v2) === 3000, '30 bps = 3000 pips');
assert(feePipsOf({ ...v2, feeBps: 25 }) === 2500, '25 bps (PancakeSwap V2) = 2500 pips');
assert(feePipsOf({ ...v2, feePips: 250 }) === 250, 'exact pips win over rounded bps (0.025% pool)');
assert(feePipsOf({ ...v2, feeBps: 2.5 }) === 250, 'a fractional bps value no longer crashes the maths (was BigInt(9997.5) -> throw)');
assert(feePipsOf({ ...v2, feeBps: 5, v4: { fee: 500, tickSpacing: 10, native: false, poolManager: '0x', stateView: '0x' } }) === 500, 'V4 pools use their own fee in pips');
assert(feePipsOf({ ...v2, feeBps: 0, v4: { fee: 0x800000, tickSpacing: 10, native: false, poolManager: '0x', stateView: '0x' } }) === 0, 'V4 dynamic-fee flag is not mistaken for a fee');

// Same answer as the old bps formula for every whole-bps pool.
let identical = true;
for (const f of [1, 5, 20, 25, 30, 100]) {
  for (const amt of [1n, 999n, 123_456_789n * E18 / 1000n, 5n * E18]) {
    const old = (amt * BigInt(10_000 - f)) / 10_000n;
    if (amountInAfterFee({ ...v2, feeBps: f }, amt) !== old) identical = false;
  }
}
assert(identical, 'whole-bps pools: fee maths gives exactly the old answer');

// A 250-pip V3 pool: old maths charged 3 bps (rounded), new charges 2.5 bps.
const v3: PoolState = { ...base, dex: 'ramses-v3', poolAddress: '0x3', poolType: 'v3', tokenA: 'A', tokenB: 'B',
  sqrtPriceX96: 1n << 96n, liquidity: 10n ** 24n, feeBps: 3, feePips: 250 };
const outExact = computeAmountOut(v3, true, E18)!;
const outRounded = computeAmountOut({ ...v3, feePips: undefined }, true, E18)!;
assert(outExact > outRounded, 'exact 0.025% fee gives slightly more out than the rounded 0.03%');

// Algebra pools (Alandale, KittenSwap): the fee is dynamic and read from
// globalState() word 2 into feePips. Sizing must use that exact value, not
// the rounded feeBps (a 0.0123% pool would round to 0.01%).
{
  const alg: PoolState = { ...v3, dex: 'alandale', variant: 'algebra', feeBps: 1, feePips: 123 };
  assert(feePipsOf(alg) === 123, 'Algebra pool: sizing uses the live fee from globalState (123 pips), not rounded bps');
  const outLive = computeAmountOut(alg, true, E18)!;
  const outBps = computeAmountOut({ ...alg, feePips: undefined }, true, E18)!;
  assert(outLive < outBps, 'Algebra pool: the live 0.0123% fee is charged (less out than the rounded 0.01%)');
}

// The price guess (poolCache) charges the same fee as the sizing maths.
{
  const cache = new PoolCache();
  const amt = 10n * E18;
  const after = cache.predictPostTradeState({ ...v2, feePips: 2500 }, true, amt);
  const expectOut = computeAmountOut({ ...v2, feePips: 2500 }, true, amt)!;
  assert(v2.reserveB! - after.reserveB! === expectOut, 'price guess and sizing maths agree on the fee');
}

// ---- 2. funding: flash loan vs own capital ---------------------------------
// Two identical WETH/USDC pools; someone is about to dump 50 WETH into one.
const victim: PoolState = { ...base, chain: 'avalanche', dex: 'dexA', poolAddress: '0xA', poolType: 'v2', tokenA: 'WETH', tokenB: 'USDC', reserveA: 1_000n * E18, reserveB: 3_400_000n * E18, feeBps: 30 };
const peer: PoolState = { ...base, chain: 'avalanche', dex: 'dexB', poolAddress: '0xB', poolType: 'v2', tokenA: 'USDC', tokenB: 'WETH', reserveA: 3_400_000n * E18, reserveB: 1_000n * E18, feeBps: 30 };
const cache = new PoolCache();
cache.upsert(victim); cache.upsert(peer);
const swap = { tokenIn: 'WETH', amountIn: 50n * E18, stateType: 'PENDING' as const };
const costs = { gasPriceUsd: 0.05, dexFeeBps: { buy: 30, sell: 30 }, flashLoanFeeBps: 9, usingFlashLoan: true, safetyMarginPct: 0.15 };

const dflt = planBackrun(cache, victim, peer, swap, 3400, costs)!;
const flash = planBackrun(cache, victim, peer, swap, 3400, costs, 18, { funding: 'flash' })!;
const own = planBackrun(cache, victim, peer, swap, 3400, costs, 18, { funding: 'own-capital' })!;
const j = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
assert(j(dflt) === j(flash), 'no option = flash-loan plan, exactly as before');
assert(own.profit.breakdown.flashLoanFee === 0, 'own capital: no loan fee');
assert(flash.profit.breakdown.flashLoanFee > 0, 'flash: loan fee charged');
assert(own.sizing.optimalTradeSizeUsd >= flash.sizing.optimalTradeSizeUsd, 'own capital never picks a SMALLER size (no per-dollar fee holding it back)');
assert(own.profit.conservativeNetProfitUsd >= flash.profit.conservativeNetProfitUsd, 'own capital nets at least as much');

const cmp = compareFunding(cache, victim, peer, swap, 3400, costs);
assert(Math.abs(cmp.extraNetUsd - (own.profit.conservativeNetProfitUsd - flash.profit.conservativeNetProfitUsd)) < 1e-9, 'compareFunding reports the difference');
console.log(`Example (50 WETH dump, $3.4M pools): flash nets $${flash.profit.conservativeNetProfitUsd.toFixed(2)} on $${flash.sizing.optimalTradeSizeUsd.toFixed(0)} `
  + `(loan fee $${flash.profit.breakdown.flashLoanFee.toFixed(2)}); own capital nets $${own.profit.conservativeNetProfitUsd.toFixed(2)} on $${own.sizing.optimalTradeSizeUsd.toFixed(0)}`);

// Same-size check: at an equal size the only difference is the fee itself
// (after the 15% safety haircut).
{
  const s = { optimalTradeSizeUsd: 10_000, grossProfitUsd: 50 };
  const a = calculateAllInProfit(s, costs);
  const b = calculateAllInProfit(s, { ...costs, usingFlashLoan: false });
  assert(Math.abs((b.conservativeNetProfitUsd - a.conservativeNetProfitUsd) - 10_000 * 0.0009 * 0.85) < 1e-9, '$10k trade: flash costs exactly $9 more (x0.85 after safety margin)');
}

// Refinement flag passes through the planner and never makes the plan worse.
{
  const r = planBackrun(cache, victim, peer, swap, 3400, costs, 18, { refineSize: true })!;
  assert(r.profit.conservativeNetProfitUsd >= dflt.profit.conservativeNetProfitUsd - 1e-9, `refineSize: net >= coarse ($${r.profit.conservativeNetProfitUsd.toFixed(2)} vs $${dflt.profit.conservativeNetProfitUsd.toFixed(2)})`);
}
