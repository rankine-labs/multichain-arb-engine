import { poolDepthUsd, deepEnough, poolReserves } from '../core/poolPrice';
import { PoolState } from '../core/types';

// Checks pool depth: near-empty pools (which can show any price) are left
// out of comparisons; deep ones count. V2 uses real reserves, V3/V4 the
// virtual reserves at the current price.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const WETH = '0x0000000000000000000000000000000000000001';
const USDG = '0x0000000000000000000000000000000000000002';
const dec = (_c: string, t: string) => (t.toLowerCase() === WETH ? 18 : 6);
const usd = (t: string) => (t.toLowerCase() === USDG ? 1 : t.toLowerCase() === WETH ? 3000 : null);
const base = { chain: 'robinhood' as const, dex: 'x', poolAddress: '0xp', tokenA: WETH, tokenB: USDG, feeBps: 30, lastUpdatedBlock: 0, lastUpdatedMs: 0 };

// V2: 10 WETH / 30,000 USDG -> depth $60,000
const v2: PoolState = { ...base, poolType: 'v2', reserveA: 10n * 10n ** 18n, reserveB: 30_000n * 10n ** 6n };
assert(Math.round(poolDepthUsd(v2, dec, usd)!) === 60_000, 'V2 depth = 2 x smaller side in USD');
assert(deepEnough(v2, dec, usd), 'V2 with $60k counts');

// V3 at price 3000 USDG/WETH (raw 3000e6/1e18), deep: L chosen for ~10 WETH virtual.
const sqrtRaw = Math.sqrt(3000 * 1e6 / 1e18);
const sqrtX96 = BigInt(Math.floor(sqrtRaw * 2 ** 96));
const Ldeep = BigInt(Math.floor(10 * 1e18 * sqrtRaw)); // a = L/sqrt = 10 WETH
const deep: PoolState = { ...base, poolType: 'v3', sqrtPriceX96: sqrtX96, liquidity: Ldeep };
const r = poolReserves(deep, dec)!;
assert(Math.abs(r.a - 10) < 0.01 && Math.abs(r.b - 30_000) < 50, 'V3 virtual reserves at current price');
assert(deepEnough(deep, dec, usd), 'deep V3/V4 pool counts');

// Near-empty V3/V4 pool: about 0.001 WETH of liquidity -> ~$6 -> left out.
const dust: PoolState = { ...deep, liquidity: Ldeep / 10_000n };
assert(!deepEnough(dust, dec, usd), 'near-empty pool (a few dollars) is left out');

// Unknown USD price on both sides -> can't tell -> left out.
const unknown = { ...deep, tokenA: '0x0000000000000000000000000000000000000009', tokenB: '0x000000000000000000000000000000000000000a' };
assert(!deepEnough(unknown, () => 18, () => null), 'no USD price on either side -> left out');
