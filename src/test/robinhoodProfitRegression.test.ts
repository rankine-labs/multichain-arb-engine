// ============================================================================
// INDEPENDENT ROBINHOOD PROFIT REGRESSION TESTS
// Research-only tests: no RPC, private keys, deployment, or live transactions.
// Keep this file independent from Claude's scanner, oracle, and replay edits.
//
// Purpose:
//   1) Ensure DEX fees already included in swap output are NOT double-counted.
//   2) Confirm flash-loan and own-capital net-profit differences.
//   3) Confirm gas, safety margin, and $20 live threshold are applied correctly.
//   4) Confirm fixed gas estimate does not change the selected optimal trade size.
// Run with: npm test (the existing runner discovers src/test/*.test.ts).
// ============================================================================

import { calculateAllInProfit, findOptimalTradeSize } from '../core/profitCalculator';
import { PoolCache } from '../core/poolCache';
import { PoolState } from '../core/types';

function check(condition: boolean, label: string): void {
  if (!condition) {
    console.error('FAIL: ' + label);
    process.exitCode = 1;
  } else {
    console.log('PASS: ' + label);
  }
}

function near(actual: number, expected: number, label: string, tolerance = 1e-9): void {
  check(Math.abs(actual - expected) <= tolerance,
    label + ' (actual=' + actual + ', expected=' + expected + ')');
}

// Swap outputs used by the optimizer already include DEX fees. Gross profit
// is therefore the amount left after the two swap fees, but before gas/funding.
const sizing = { optimalTradeSizeUsd: 100, grossProfitUsd: 0.30 };
const common = {
  gasPriceUsd: 0.02,
  dexFeeBps: { buy: 30, sell: 30 },
  flashLoanFeeBps: 9,
  safetyMarginPct: 0,
};
const capital = calculateAllInProfit(sizing, { ...common, usingFlashLoan: false });
const flash = calculateAllInProfit(sizing, { ...common, usingFlashLoan: true });
near(capital.conservativeNetProfitUsd, 0.28, 'own-capital net subtracts gas only');
near(flash.conservativeNetProfitUsd, 0.19, 'flash net subtracts gas and 9 bps loan fee');
near(capital.conservativeNetProfitUsd - flash.conservativeNetProfitUsd,
  0.09, 'funding cost difference is exactly 9 cents on $100');
near(flash.breakdown.dexFees, 0.60, 'DEX fee breakdown is informational, not deducted twice');
near(flash.breakdown.flashLoanFee, 0.09, 'loan fee is separately reported');
check(!capital.qualifies && !flash.qualifies, 'sub-$20 profits never pass live profit threshold');

// Negative profit should not receive a negative safety-margin discount.
const losing = calculateAllInProfit(
  { optimalTradeSizeUsd: 100, grossProfitUsd: 0.01 },
  { ...common, gasPriceUsd: 0.03, safetyMarginPct: 0.5, usingFlashLoan: false },
);
near(losing.conservativeNetProfitUsd, -0.02, 'loss is not artificially reduced by safety margin');
near(losing.breakdown.safetyMargin, 0, 'safety margin cannot become negative');

// Positive net gets a haircut only after gas and loan fees.
const profitable = calculateAllInProfit(
  { optimalTradeSizeUsd: 1000, grossProfitUsd: 30 },
  { ...common, gasPriceUsd: 1, safetyMarginPct: 0.10, usingFlashLoan: false },
);
near(profitable.conservativeNetProfitUsd, 26.1, '10% safety margin applies to $29 net');
check(profitable.qualifies, 'conservative net over $20 qualifies');

// This tests a subtle optimization property: a FIXED gas estimate is added
// equally to every candidate size, so it must not change the chosen size.
// Variable funding rates can change the chosen size and are tested separately.
const now = 0;
const a: PoolState = {
  chain: 'robinhood', dex: 'uniswap-v2', poolAddress: '0x0000000000000000000000000000000000000001',
  poolType: 'v2', tokenA: 'USDG', tokenB: 'WETH',
  reserveA: 1000000n * 10n ** 18n, reserveB: 400n * 10n ** 18n,
  feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: now,
};
const b: PoolState = {
  ...a, dex: 'ramses-v2', poolAddress: '0x0000000000000000000000000000000000000002',
  reserveA: 1000000n * 10n ** 18n, reserveB: 410n * 10n ** 18n,
};
const cache = new PoolCache();
cache.upsert(a);
cache.upsert(b);
const cheapGas = findOptimalTradeSize(a, b, cache, true, 1000, 1, 9, 0.01, 18);
const expensiveGas = findOptimalTradeSize(a, b, cache, true, 1000, 1, 9, 2, 18);
near(cheapGas.optimalTradeSizeUsd, expensiveGas.optimalTradeSizeUsd,
  'fixed gas estimate alone cannot change optimal trade size');
near(cheapGas.grossProfitUsd, expensiveGas.grossProfitUsd,
  'fixed gas estimate alone cannot change estimated gross output');

// A research result under $20 may still be worth simulating. The live threshold
// is NOT a substitute for the independent research-lane selection policy.
// V3 liquidity at the current tick is NOT total available pool liquidity.
// A local virtual-reserve quote can be used for candidate discovery, but
// it must not be treated as an exact tick-crossing quote or execution proof.
const v3a: PoolState = {
  ...a, poolType: 'v3', poolAddress: '0x0000000000000000000000000000000000000003',
  reserveA: undefined, reserveB: undefined,
  sqrtPriceX96: 1n << 96n, liquidity: 1000000n * 10n ** 18n,
  feeBps: 5,
};
const v3b: PoolState = {
  ...v3a, poolAddress: '0x0000000000000000000000000000000000000004',
  feeBps: 30,
};
const v3Cache = new PoolCache();
v3Cache.upsert(v3a);
v3Cache.upsert(v3b);
const v3Sizing = findOptimalTradeSize(v3a, v3b, v3Cache, true, 1000, 1, 9, 0.02, 18);
check(Number.isFinite(v3Sizing.grossProfitUsd), 'V3 same-tick approximation returns finite result');
check(v3Sizing.grossProfitUsd <= 0,
  'identical-price V3 pools with swap fees cannot create free profit');

console.log('Independent regression checks complete. No transactions submitted.');
