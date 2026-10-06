import { ShadowLogger } from '../core/shadowLogger';
import { PoolCache } from '../core/poolCache';
import { PoolState } from '../core/types';

// Memory housekeeping: the opportunity log forgets old records and drops the
// raw transaction; the pool cache drops idle pools that nobody watches.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const log = new ShadowLogger();
const now = Date.now();
const opp = (t: number, id: string) => ({
  id, chain: 'robinhood', tokenPair: ['0xa', '0xb'], buyDex: 'x', buyPool: '0x1', sellDex: 'y', sellPool: '0x2',
  optimalTradeSizeUsd: 1, grossProfitUsd: 1, costsUsd: {}, conservativeNetProfitUsd: 1, scoredAtMs: t, score: 1,
  triggeringEvent: { chain: 'robinhood', stateType: 'SEQUENCED', blockOrSeq: 1, receivedAtMs: t, raw: { data: '0x' + 'ff'.repeat(5000) } },
}) as any;
for (let i = 0; i < 499; i++) log.record({ opportunity: opp(now - 30 * 3600_000, `old${i}`), outcome: 'UNRESOLVED' }, now);
log.record({ opportunity: opp(now, 'new'), outcome: 'UNRESOLVED' }, now); // 500th record triggers a prune
assert(log.size === 1, `records older than 26 h are dropped (left ${log.size})`);
assert((log as any).records[0].opportunity.triggeringEvent.raw === undefined, 'raw transaction is not kept');
assert(log.windowStats(now - 1000, now + 1).seen === 1, 'window stats still work');

const c = new PoolCache();
const base: PoolState = { chain: 'robinhood', dex: 'v2', poolAddress: '', poolType: 'v2', tokenA: '0xa', tokenB: '0xb', feeBps: 30, lastUpdatedBlock: 0, lastUpdatedMs: now };
c.upsert({ ...base, poolAddress: '0xwatched', lastUpdatedMs: now - 5 * 3600_000 });
c.upsert({ ...base, poolAddress: '0xidle', lastUpdatedMs: now - 5 * 3600_000 });
c.upsert({ ...base, poolAddress: '0xrecent', lastUpdatedMs: now - 60_000 });
const removed = c.prune((p) => p.poolAddress === '0xwatched', 2 * 3600_000, now);
assert(removed === 1 && !c.get('robinhood', '0xidle') && !!c.get('robinhood', '0xwatched') && !!c.get('robinhood', '0xrecent'),
  'idle unwatched pools are pruned; watched and recently used ones stay');
