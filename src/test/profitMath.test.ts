import { PoolCache } from '../core/poolCache';
import { findOptimalTradeSize, calculateAllInProfit, calculateLiquidityCeiling } from '../core/profitCalculator';
import { PoolState } from '../core/types';

function assert(cond: boolean, msg: string) {
if (!cond) {
console.error(`FAIL: ${msg}`);
process.exitCode = 1;
} else {
console.log(`PASS: ${msg}`);
}
}

const cache = new PoolCache();

const poolA: PoolState = {
chain: 'avalanche', dex: 'traderjoe', poolAddress: '0xA',
poolType: 'v2', tokenA: 'USDC', tokenB: 'WETH',
reserveA: 1_000_000n * 10n ** 18n,
reserveB: 340n * 10n ** 18n,
feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: Date.now(),
};

const poolB: PoolState = {
chain: 'avalanche', dex: 'pharaoh', poolAddress: '0xB',
poolType: 'v2', tokenA: 'USDC', tokenB: 'WETH',
reserveA: 1_000_000n * 10n ** 18n,
reserveB: 330n * 10n ** 18n,
feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: Date.now(),
};

cache.upsert(poolA);
cache.upsert(poolB);

const peers = cache.findPeerPools('avalanche', 'USDC', 'WETH', '0xA');
assert(peers.length === 1 && peers[0].poolAddress === '0xB', 'peer pool discovery finds the other venue');

const sizing = findOptimalTradeSize(poolA, poolB, cache, true, 200_000, 1.0);
assert(sizing.grossProfitUsd > 0, `optimal sizing finds a positive gross profit (got $${sizing.grossProfitUsd.toFixed(2)})`);
assert(sizing.optimalTradeSizeUsd > 0 && sizing.optimalTradeSizeUsd <= 200_000, 'optimal size is within bounds');

const profit = calculateAllInProfit(sizing, {
gasPriceUsd: 2,
dexFeeBps: { buy: 30, sell: 30 },
flashLoanFeeBps: 9,
usingFlashLoan: true,
safetyMarginPct: 0.15,
});
assert(
profit.conservativeNetProfitUsd < sizing.grossProfitUsd,
'conservative net profit is always less than gross (costs were actually subtracted)',
);
console.log(`Gross: $${sizing.grossProfitUsd.toFixed(2)} @ size $${sizing.optimalTradeSizeUsd.toFixed(0)} -> Conservative net: $${profit.conservativeNetProfitUsd.toFixed(2)} -> qualifies: ${profit.qualifies}`);

const poolC: PoolState = { ...poolA, poolAddress: '0xC', dex: 'sushiswap' };
cache.upsert(poolC);
const noSpreadSizing = findOptimalTradeSize(poolA, poolC, cache, true, 200_000, 1.0);
assert(noSpreadSizing.grossProfitUsd <= 0.01, `identical pools produce ~no profit (got $${noSpreadSizing.grossProfitUsd.toFixed(4)})`);

const thinPool: PoolState = {
chain: 'avalanche', dex: 'sushiswap', poolAddress: '0xThin',
poolType: 'v2', tokenA: 'USDC', tokenB: 'WETH',
reserveA: 20_000n * 10n ** 18n,
reserveB: 6n * 10n ** 18n,
feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: Date.now(),
};
const deepPool: PoolState = {
chain: 'avalanche', dex: 'pharaoh', poolAddress: '0xDeep',
poolType: 'v2', tokenA: 'USDC', tokenB: 'WETH',
reserveA: 1_000_000n * 10n ** 18n,
reserveB: 300n * 10n ** 18n,
feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: Date.now(),
};
const ceiling = calculateLiquidityCeiling(thinPool, deepPool, 1.0);
assert(ceiling > 0 && ceiling <= 20_000 * 0.02, `ceiling is capped by the thin $20k pool, not the deep $1M pool (got $${ceiling.toFixed(2)})`);
assert(ceiling < 5_000, `a $20k pool never produces a ceiling anywhere near the old flat $200k default (got $${ceiling.toFixed(2)})`);
