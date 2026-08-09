import { computeAmountOut } from '../core/dexMath';
import { findOptimalTradeSize, calculateLiquidityCeiling } from '../core/profitCalculator';
import { PoolCache } from '../core/poolCache';
import { PoolState } from '../core/types';

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${msg}`);
  }
    }

    const Q96 = 1n << 96n;

  const sqrtPrice = BigInt(Math.floor(Math.sqrt(1 / 3000) * Number(Q96)));

  const v3Pool: PoolState = {
    chain: 'avalanche', dex: 'uniswap', poolAddress: '0xV3Pool',
    poolType: 'v3',
    tokenA: '0xusdc', tokenB: '0xweth',
    sqrtPriceX96: sqrtPrice,
    liquidity: 5_000_000n * 10n ** 18n,
    feeBps: 5,
    lastUpdatedBlock: 1, lastUpdatedMs: Date.now(),
  };

  const amountIn = 1_000n * 10n ** 18n;
  const amountOut = computeAmountOut(v3Pool, true, amountIn);

  assert(amountOut !== null, 'v3 computeAmountOut returns a result instead of null');
  if (amountOut !== null) {
    const outAsFloat = Number(amountOut) / 1e18;
    assert(outAsFloat > 0.3 && outAsFloat < 0.34, `v3 small-trade output is in the expected ~0.333 WETH range (got ${outAsFloat.toFixed(5)})`);
  }

    const smallOut = computeAmountOut(v3Pool, true, 100n * 10n ** 18n)!;
  const largeOut = computeAmountOut(v3Pool, true, 500_000n * 10n ** 18n)!;
  const smallRate = Number(smallOut) / 100;
  const largeRate = Number(largeOut) / 500_000;
  assert(largeRate < smallRate, `larger v3 trades get a worse effective rate (small=${smallRate.toFixed(6)}, large=${largeRate.toFixed(6)})`);

  const cache = new PoolCache();

  const v2BuyPool: PoolState = {
    chain: 'avalanche', dex: 'traderjoe', poolAddress: '0xV2Buy',
    poolType: 'v2', tokenA: '0xusdc', tokenB: '0xweth',
    reserveA: 1_000_000n * 10n ** 18n,
    reserveB: 345n * 10n ** 18n,
    feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: Date.now(),
  };
  cache.upsert(v2BuyPool);
  cache.upsert(v3Pool);

  const ceiling = calculateLiquidityCeiling(v2BuyPool, v3Pool, 1.0);
  assert(ceiling > 0, `cross-type liquidity ceiling computes a positive value (got $${ceiling.toFixed(2)})`);

  const crossTypeSizing = findOptimalTradeSize(v2BuyPool, v3Pool, cache, true, ceiling, 1.0);
  assert(crossTypeSizing.grossProfitUsd > 0, `v2-vs-v3 cross-type arb finds positive gross profit (got $${crossTypeSizing.grossProfitUsd.toFixed(2)})`);
