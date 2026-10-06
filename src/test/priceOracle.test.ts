import { PoolCache } from '../core/poolCache';
import { PriceOracle, registerStablecoin } from '../core/priceOracle';
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
const oracle = new PriceOracle(cache);

const USDC = '0xusdc';
const WETH = '0xweth';
const ARB_TOKEN = '0xarb';

registerStablecoin('avalanche', USDC);

const wethUsdcPool: PoolState = {
chain: 'avalanche', dex: 'traderjoe', poolAddress: '0xPool1',
poolType: 'v2', tokenA: USDC, tokenB: WETH,
reserveA: 1_000_000n * 10n ** 18n,
reserveB: 340n * 10n ** 18n,
feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: Date.now(),
};
cache.upsert(wethUsdcPool);

assert(oracle.getUsdPrice('avalanche', USDC) === 1.0, 'stablecoin always prices at exactly $1.00');

const wethPrice = oracle.getUsdPrice('avalanche', WETH);
assert(wethPrice !== null && Math.abs(wethPrice - 2941.18) < 1, `direct-pool WETH price is correct (got $${wethPrice?.toFixed(2)})`);

const arbWethPool: PoolState = {
chain: 'avalanche', dex: 'sushiswap', poolAddress: '0xPool2',
poolType: 'v2', tokenA: ARB_TOKEN, tokenB: WETH,
reserveA: 500_000n * 10n ** 18n,
reserveB: 100n * 10n ** 18n,
feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: Date.now(),
};
cache.upsert(arbWethPool);

const arbPrice = oracle.getUsdPrice('avalanche', ARB_TOKEN);
assert(arbPrice !== null && Math.abs(arbPrice - 0.588) < 0.01, `one-hop ARB_TOKEN price via WETH is correct (got $${arbPrice?.toFixed(4)})`);

const UNKNOWN_TOKEN = '0xghost';
assert(oracle.getUsdPrice('avalanche', UNKNOWN_TOKEN) === null, 'unpriceable token returns null instead of guessing');

assert(oracle.getUsdPrice('monad', WETH) === null, 'no cross-chain price leakage for an unregistered chain/token pair');

// ---- Oct 2026 audit: real decimals, V3 pools, deepest pool wins ----------
{
  const { PoolCache: PC } = require('../core/poolCache');
  const { PriceOracle: PO, registerStablecoin: reg } = require('../core/priceOracle');
  const USDG = '0xusdg6', W = '0xweth18', STOCK = '0xstock18';
  reg('robinhood', USDG);
  const dec = (_c: string, t: string) => ({ [USDG]: 6, [W]: 18, [STOCK]: 18 } as Record<string, number>)[t.toLowerCase()];
  const c2 = new PC();
  const o2 = new PO(c2, dec, 0);
  const base = { chain: 'robinhood', feeBps: 30, lastUpdatedBlock: 0, lastUpdatedMs: Date.now() };
  // Small V2 pool at a WRONG price ($2,000) and a deep one at $3,000.
  c2.upsert({ ...base, dex: 'ramses-v2', poolAddress: '0xa1', poolType: 'v2', tokenA: W, tokenB: USDG,
    reserveA: 1n * 10n ** 18n, reserveB: 2_000n * 10n ** 6n });
  c2.upsert({ ...base, dex: 'ramses-v2', poolAddress: '0xa2', poolType: 'v2', tokenA: W, tokenB: USDG,
    reserveA: 100n * 10n ** 18n, reserveB: 300_000n * 10n ** 6n });
  const px = o2.getUsdPrice('robinhood', W);
  assert(px !== null && Math.abs(px - 3000) < 1, `WETH priced with USDG's 6 decimals and from the deepest pool (got ${px})`);

  // V3 pool for STOCK/WETH at 0.1 WETH per STOCK => $300. sqrtPriceX96 for
  // price tokenB/tokenA = 10 (WETH per STOCK when STOCK is tokenA? use A=STOCK, B=WETH, price 0.1).
  const sqrt = BigInt(Math.floor(Math.sqrt(0.1) * 2 ** 96));
  c2.upsert({ ...base, dex: 'uniswap-v3', poolAddress: '0xb1', poolType: 'v3', tokenA: STOCK, tokenB: W,
    sqrtPriceX96: sqrt, liquidity: 10n ** 21n });
  const sp = o2.getUsdPrice('robinhood', STOCK);
  assert(sp !== null && Math.abs(sp - 300) < 1, `one-hop price through a V3 pool works (got ${sp})`);

  // Unknown decimals: skipped, not guessed.
  c2.upsert({ ...base, dex: 'x', poolAddress: '0xc1', poolType: 'v2', tokenA: '0xmystery', tokenB: USDG,
    reserveA: 10n ** 24n, reserveB: 10n ** 12n });
  assert(o2.getUsdPrice('robinhood', '0xmystery') === null, 'unknown decimals => no price instead of a guess');
}
