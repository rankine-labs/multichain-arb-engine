import { PoolCache } from '../core/poolCache';
import { PoolState } from '../core/types';

// Checks that an RPC refresh never puts an OLDER price over a swap the trade
// feed already applied (the source of fake gaps), and that a busy pool still
// gets corrected eventually.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const base: PoolState = {
  chain: 'robinhood', dex: 'uniswap-v3', poolAddress: '0xp1', poolType: 'v3',
  tokenA: '0xa', tokenB: '0xb', sqrtPriceX96: 100n, liquidity: 1n, feeBps: 5, lastUpdatedBlock: 0, lastUpdatedMs: 1_000,
};
const c = new PoolCache();
c.upsert(base);

// Feed applies a swap at t=10_000.
c.upsertFromFeed({ ...base, sqrtPriceX96: 120n }, 10_000);
// RPC read started at t=10_100 (after the feed) but returns the pre-swap price.
let wrote = c.upsertIfNotNewer({ ...base, sqrtPriceX96: 100n, lastUpdatedMs: 10_150 }, 10_100, 10_150);
assert(!wrote && c.get('robinhood', '0xp1')!.sqrtPriceX96 === 120n, 'RPC read inside the feed grace window does not undo the feed swap');

// Read that started BEFORE the feed write is also refused.
wrote = c.upsertIfNotNewer({ ...base, sqrtPriceX96: 90n, lastUpdatedMs: 20_000 }, 9_000, 20_000);
assert(!wrote, 'RPC read started before a newer write is refused');

// Third refusal in a row: written anyway so a busy pool is still corrected.
wrote = c.upsertIfNotNewer({ ...base, sqrtPriceX96: 121n, lastUpdatedMs: 20_000 }, 9_500, 20_000);
assert(wrote && c.get('robinhood', '0xp1')!.sqrtPriceX96 === 121n, 'third skip in a row writes anyway');

// Normal case: nothing newer, grace over -> written.
c.upsert({ ...base, lastUpdatedMs: 30_000 });
wrote = c.upsertIfNotNewer({ ...base, sqrtPriceX96: 130n, lastUpdatedMs: 40_000 }, 39_000, 40_000);
assert(wrote, 'ordinary refresh is written');
