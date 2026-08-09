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
