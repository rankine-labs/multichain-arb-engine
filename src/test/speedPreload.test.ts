import { PairWatcher } from '../core/pairWatcher';
import { PoolCache } from '../core/poolCache';
import { PoolState } from '../core/types';

// SPEED_PRELOAD: every pool on the watch list has a usable price in the
// cache right away (restored pools re-read in ONE bundled request, missing
// pools looked up again off the hot path), so a feed trade on a watched pool
// finds its pool in the cache and never needs the RPC "resolve" lookup.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20);
const P = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const w = (n: bigint) => n.toString(16).padStart(64, '0');

const pool = (addr: string, tokenA: string, tokenB: string, extra: Partial<PoolState>): PoolState => ({
  chain: 'robinhood', dex: 'uniswap-v3', poolAddress: addr, poolType: 'v3', tokenA, tokenB, feeBps: 5,
  sqrtPriceX96: 1n, liquidity: 1n, lastUpdatedBlock: 0, lastUpdatedMs: 0, ...extra,
} as PoolState);

// The same lookup the trade handler does for a router trade before it would
// fall back to the RPC resolve (shadowMain: findPeerPools, same DEX + fee).
const handlerFinds = (cache: PoolCache, tIn: string, tOut: string, dex: string, feeBps: number) =>
  cache.findPeerPools('robinhood', tIn, tOut, '').find((p) => p.dex === dex && p.feeBps === feeBps);

async function main() {
  const cache = new PoolCache();
  const watcher = new PairWatcher('robinhood', {} as any, [], cache, () => {}, { maxQueue: 5 });
  // Bundled reads: count requests and the pools in each.
  const requests: number[] = [];
  (watcher as any).callMany = async (calls: { target: string; data: string }[]) => {
    requests.push(calls.length);
    return calls.map((c) => (c.data === '0x3850c7bd' ? '0x' + w(777n) + w(5n) : c.data === '0x1a686502' ? '0x' + w(888n) : '0x' + w(11n) + w(22n) + w(3n)));
  };
  // Discovery stub (normally one bundled multicall per pair): writes the pair's pools.
  const discovered: string[] = [];
  (watcher as any).discover = async (a: string, b: string) => {
    discovered.push(`${a}/${b}`);
    cache.upsert(pool(P(3), a, b, { feeBps: 30, lastUpdatedMs: Date.now() }));
    cache.upsert(pool(P(4), a, b, { dex: 'uniswap-v2', poolType: 'v2', reserveA: 1n, reserveB: 1n, feeBps: 30, lastUpdatedMs: Date.now() } as any));
  };

  // Watch list restored from the last run: pair A/B with 2 pools, both in the
  // cache but never re-read (lastUpdatedMs 0); pair A/C whose pools are MISSING.
  const k = (a: string, b: string) => [a.toLowerCase(), b.toLowerCase()].sort().join('/');
  (watcher as any).pairs.set(k(A, B), { tokenA: A, tokenB: B, pools: [P(1), P(2)], discoveredAt: Date.now(), lastSeen: Date.now() });
  (watcher as any).pairs.set(k(A, C), { tokenA: A, tokenB: C, pools: [P(3), P(4)], discoveredAt: Date.now(), lastSeen: Date.now() });
  cache.upsert(pool(P(1), A, B, { feeBps: 5 }));
  cache.upsert(pool(P(2), A, B, { dex: 'uniswap-v2', poolType: 'v2', reserveA: 1n, reserveB: 1n, feeBps: 30 } as any));

  assert(!handlerFinds(cache, A, C, 'uniswap-v3', 30), 'before preload: a trade on A/C would need the RPC resolve (pool not in cache)');

  const r = await watcher.preload();
  await sleep(20); // discovery queue drains in the background
  assert(r.pools === 4, `all 4 watched pools checked (got ${r.pools})`);
  assert(r.refreshed === 2 && requests.length === 1 && requests[0] === 3, `the 2 never-read pools re-read in ONE bundled request (requests: ${JSON.stringify(requests)})`);
  assert(cache.get('robinhood', P(1))!.lastUpdatedMs > 0 && cache.get('robinhood', P(1))!.sqrtPriceX96 === 777n, 'restored V3 pool now has a live price');
  assert(cache.get('robinhood', P(2))!.reserveA === 11n, 'restored V2 pool now has live reserves');
  assert(r.missingPairs === 1 && discovered.length === 1, 'pair with missing pools queued for a normal (bundled) lookup');

  // Now every watched pool is found by the handler's own cache lookup:
  // no RPC resolve for any of them.
  const allFound = [[A, B, 'uniswap-v3', 5], [B, A, 'uniswap-v2', 30], [A, C, 'uniswap-v3', 30], [C, A, 'uniswap-v2', 30]]
    .every(([x, y, d, f]) => !!handlerFinds(cache, x as string, y as string, d as string, f as number));
  assert(allFound, 'after preload every watched pool is in the cache: feed trades on them never trigger the resolve RPC');
  assert(watcher.isWatched(B, A) && !watcher.isWatched(B, C), 'isWatched tells watched pairs from unknown ones (either token order)');

  // Second run: nothing stale, nothing missing -> no requests at all.
  const before = requests.length;
  const r2 = await watcher.preload();
  assert(r2.refreshed === 0 && r2.missingPairs === 0 && requests.length === before, 'nothing to do -> no node requests (the 1-minute check is free)');

  // A failing node never throws out of preload (the 5 s re-sync still runs).
  (watcher as any).callMany = async () => { throw new Error('429 rate limited'); };
  cache.upsert({ ...cache.get('robinhood', P(1))!, lastUpdatedMs: 1 });
  const r3 = await watcher.preload();
  assert(r3.refreshed === 0, 'node error: preload gives up quietly');

  // Unknown pair (not on the watch list): preload doesn't touch it, so
  // today's behaviour (RPC resolve on first sight) is unchanged.
  assert(!handlerFinds(cache, B, C, 'uniswap-v3', 5), 'truly unknown pools are left to the normal resolve path');
}
main().catch((e) => { console.error('FAIL: crashed', e); process.exitCode = 1; });
