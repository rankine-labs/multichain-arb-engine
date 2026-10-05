import { findStandingGaps, poolReserves } from '../core/gapScanner';
import { PoolState } from '../core/types';

// Checks the standing-gap scanner: finds a real gap between two pools of a
// pair, ignores gaps smaller than fees, never guesses decimals, prices in USD.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const TOK = '0x1111111111111111111111111111111111111111', USDG = '0x2222222222222222222222222222222222222222';
const v2 = (addr: string, rTok: number, rUsd: number, feeBps = 30): PoolState => ({
  chain: 'robinhood', dex: 'uniswap-v2', poolAddress: addr, poolType: 'v2', tokenA: TOK, tokenB: USDG,
  reserveA: BigInt(Math.round(rTok * 1e18)), reserveB: BigInt(Math.round(rUsd * 1e6)), feeBps, lastUpdatedBlock: 0, lastUpdatedMs: 0,
});
const dec = (t: string) => (t === TOK.toLowerCase() ? 18 : t === USDG.toLowerCase() ? 6 : undefined);
const usd = (t: string) => (t === USDG.toLowerCase() ? 1 : null);
const opts = { minProfitUsd: 20, flashFee: 0.0005, gasUsd: 0.05, maxTradeUsd: 50_000 };

// Pool A: 1 TOK = $100; pool B: 1 TOK = $103 (3% gap), both deep.
const A = v2('0xa', 10_000, 1_000_000), B = v2('0xb', 10_000, 1_030_000);
const gaps = findStandingGaps([[A, B]], dec, usd, opts);
assert(gaps.length === 1, 'gap found between two pools of the pair');
assert(gaps[0].buyPool.poolAddress === '0xa' && gaps[0].sellPool.poolAddress === '0xb', 'buys on the cheap pool, sells on the dear one');
assert(gaps[0].profitUsd > 20 && gaps[0].sizeUsd > 0 && gaps[0].sizeUsd <= 50_000, `profit $${gaps[0].profitUsd.toFixed(0)} on $${gaps[0].sizeUsd.toFixed(0)}`);

assert(findStandingGaps([[A, v2('0xc', 10_000, 1_004_000)]], dec, usd, opts).length === 0, '0.4% gap with 0.3% fees each side -> nothing');
assert(findStandingGaps([[A, B]], () => undefined, usd, opts).length === 0, 'unknown decimals -> skipped (never guessed)');
assert(findStandingGaps([[A, B]], dec, () => null, opts).length === 0, 'no USD price -> skipped');
assert(findStandingGaps([[A]], dec, usd, opts).length === 0, 'single pool -> nothing');

const r = poolReserves(A, TOK, 18, 6)!;
assert(Math.abs(r.quote / r.base - 100) < 1e-9, 'V2 reserves oriented base/quote with decimals');
