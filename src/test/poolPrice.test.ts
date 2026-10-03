import { priceAinB, priceOf, spreadPct } from '../core/poolPrice';
import { PoolState } from '../core/types';

// Proves the shared price helper fixes the two bugs it was written for:
//   1. decimals: WMON (18) vs USDC (6) must give a real price, not 10^12 off
//   2. orientation: the same pair stored in opposite order on two pools must
//      price identically, so their "spread" is real, not price vs 1/price

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const near = (a: number | null, b: number, tol = 1e-9) => a !== null && Math.abs(a - b) / b < tol;

const WMON = '0xWMON';
const USDC = '0xUSDC';
const DEC: Record<string, number> = { [WMON.toLowerCase()]: 18, [USDC.toLowerCase()]: 6 };
const decimalsOf = (_chain: string, t: string) => DEC[t.toLowerCase()] ?? 18;

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;

// V2 pool listed WMON/USDC: 1,000,000 WMON and 30,000 USDC -> 1 WMON = $0.03
const v2: PoolState = {
  chain: 'monad', dex: 'uniswap-v2', poolAddress: '0x1', poolType: 'v2',
  tokenA: WMON, tokenB: USDC, reserveA: 1_000_000n * E18, reserveB: 30_000n * E6,
  feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: 0,
};
// Same market, opposite order (USDC/WMON).
const v2Flipped: PoolState = { ...v2, poolAddress: '0x2', tokenA: USDC, tokenB: WMON, reserveA: 30_000n * E6, reserveB: 1_000_000n * E18 };

// 1. Decimals.
assert(near(priceAinB(v2, decimalsOf), 0.03), `WMON/USDC decimal-adjusted price is $0.03 (got ${priceAinB(v2, decimalsOf)})`);
const rawRatio = Number(v2.reserveB) / Number(v2.reserveA);
assert(rawRatio < 1e-12, `old raw ratio was ~10^12 off (${rawRatio}) -- the bug this replaces`);

// 2. Orientation.
assert(near(priceOf(v2, WMON, decimalsOf), 0.03), 'priceOf(pool, WMON) = 0.03 on WMON/USDC pool');
assert(near(priceOf(v2Flipped, WMON, decimalsOf), 0.03), 'priceOf(pool, WMON) = 0.03 on USDC/WMON pool too');
assert(near(priceOf(v2, USDC, decimalsOf), 1 / 0.03), 'priceOf(pool, USDC) inverts correctly');
const s = spreadPct(priceOf(v2, WMON, decimalsOf)!, priceOf(v2Flipped, WMON, decimalsOf)!);
assert(s < 1e-6, `identical markets in opposite order show ~0% spread (got ${s}%)`);
const oldStyle = spreadPct(priceAinB(v2, decimalsOf)!, priceAinB(v2Flipped, decimalsOf)!);
assert(oldStyle > 1000, `unoriented comparison of the same market showed a fake ${oldStyle.toFixed(0)}% spread -- the bug this replaces`);

// 3. V3: sqrtPriceX96 for 1 WMON = 0.03 USDC (raw = 0.03 * 10^(6-18)).
const rawPrice = 0.03 * 10 ** (6 - 18);
const sqrtPriceX96 = BigInt(Math.round(Math.sqrt(rawPrice) * 2 ** 96));
const v3: PoolState = { ...v2, poolAddress: '0x3', poolType: 'v3', reserveA: undefined, reserveB: undefined, sqrtPriceX96, liquidity: 1n };
assert(near(priceOf(v3, WMON, decimalsOf), 0.03, 1e-6), `V3 sqrtPrice decodes to $0.03 (got ${priceOf(v3, WMON, decimalsOf)})`);
assert(spreadPct(priceOf(v3, WMON, decimalsOf)!, priceOf(v2Flipped, WMON, decimalsOf)!) < 1e-3, 'V3 vs flipped V2 of same market: ~0% spread');

// 4. Refuses to make up a price.
assert(priceOf({ ...v2, dex: 'lfj-lb' }, WMON, decimalsOf) === null, 'LFJ LB pool -> null');
assert(priceOf({ ...v2, reserveB: 1n }, WMON, decimalsOf) === null, 'dust pool (1 wei USDC) -> null');
assert(priceOf(v2, '0xOTHER', decimalsOf) === null, 'token not in pool -> null');
assert(spreadPct(1, 1.05) > 4.99 && spreadPct(1.05, 1) > 4.99, 'spread is symmetric and positive');
