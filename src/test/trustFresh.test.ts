import { EventEmitter } from 'events';
import { wsTrustProblem, trustFreshConfigFromEnv, WsFacts } from '../core/trustFresh';
import { WsBlockReader, SocketLike } from '../core/blockReaderWs';
import { PoolCache } from '../core/poolCache';
import { PoolState } from '../core/types';
import { NodeUsageCounter } from '../core/nodeUsage';
import { SYNC_TOPIC } from '../core/blockReader';

// SPEED_TRUST_WS: a cached price older than FRESH_MS is used without an RPC
// re-read ONLY when the WebSocket reader proves it is still current
// (healthy without a break since the pool's last update, pool subscribed,
// data flowing, exact state, V2-style pool). Otherwise today's rule applies.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const NOW = 10_000_000;
const ADDR = '0x00000000000000000000000000000000000000a1';
const v2 = (extra: Partial<PoolState> = {}): PoolState => ({
  chain: 'robinhood', dex: 'uniswap-v2', poolAddress: ADDR, poolType: 'v2', tokenA: '0xa', tokenB: '0xb',
  feeBps: 30, reserveA: 1n, reserveB: 1n, lastUpdatedBlock: 1, lastUpdatedMs: NOW - 60_000, ...extra,
} as PoolState);

// Fake WebSocket facts: healthy since 5 min ago, data 0.5 s ago, pool subscribed.
const ws = (o: Partial<{ healthy: boolean; since: number | null; covers: number | null; dataAt: number }> = {}): WsFacts => ({
  healthy: () => o.healthy ?? true,
  healthySinceMs: () => (o.since === undefined ? NOW - 300_000 : o.since),
  coveredSinceMs: () => (o.covers === undefined ? NOW - 300_000 : o.covers),
  lastDataAtMs: () => o.dataAt ?? NOW - 500,
});
const noWrites = { blockAppliedAt: () => 0, feedAppliedAt: () => 0 };
const cfg = trustFreshConfigFromEnv({});

// 1. Defaults.
assert(cfg.enabled && cfg.maxAgeMs === 120_000 && cfg.dataMs === 3_000 && cfg.lagMarginMs === 2_000 && !cfg.includeV3, 'defaults: on, 120 s max age, data within 3 s, 2 s lag margin, V2-style pools only');
assert(!trustFreshConfigFromEnv({ SPEED_TRUST_WS: '0' }).enabled, 'SPEED_TRUST_WS=0 switches it off');

// 2. The happy path: 60 s old V2 pool (older than FRESH_MS), WS healthy all along.
assert(wsTrustProblem(v2(), ws(), noWrites, cfg, NOW) === null, 'healthy WebSocket since before the last update -> cache used, no RPC');

// 3. Every failed condition falls back (non-null reason = today's FRESH_MS rule).
const reasons: [string, string | null][] = [
  ['switch off', wsTrustProblem(v2(), ws(), noWrites, { ...cfg, enabled: false }, NOW)],
  ['no WebSocket reader', wsTrustProblem(v2(), null, noWrites, cfg, NOW)],
  ['WebSocket down now', wsTrustProblem(v2(), ws({ healthy: false }), noWrites, cfg, NOW)],
  ['WebSocket had a break after the pool update', wsTrustProblem(v2(), ws({ since: NOW - 30_000 }), noWrites, cfg, NOW)],
  ['break just inside the lag margin', wsTrustProblem(v2(), ws({ since: NOW - 60_000 - 1_000 }), noWrites, cfg, NOW)],
  ['pool not in the current watch list / subscription', wsTrustProblem(v2(), ws({ covers: null }), noWrites, cfg, NOW)],
  ['pool (re)joined the watch list after its last update', wsTrustProblem(v2(), ws({ covers: NOW - 30_000 }), noWrites, cfg, NOW)],
  ['no WebSocket data for 4 s', wsTrustProblem(v2(), ws({ dataAt: NOW - 4_000 }), noWrites, cfg, NOW)],
  ['older than 120 s', wsTrustProblem(v2({ lastUpdatedMs: NOW - 130_000 }), ws({ since: NOW - 600_000 }), noWrites, cfg, NOW)],
  ['never refreshed (restored from disk)', wsTrustProblem(v2({ lastUpdatedMs: 0 }), ws(), noWrites, cfg, NOW)],
  ['V3 pool (liquidity changes not followed)', wsTrustProblem(v2({ poolType: 'v3', sqrtPriceX96: 1n, liquidity: 1n } as any), ws(), noWrites, cfg, NOW)],
  ['V4 pool', wsTrustProblem(v2({ poolType: 'v3', v4: { stateView: '0x', poolManager: '0x' } } as any), ws(), noWrites, cfg, NOW)],
  ['latest write is a trade-feed prediction', wsTrustProblem(v2(), ws(), { blockAppliedAt: () => 0, feedAppliedAt: () => NOW - 60_000 }, cfg, NOW)],
  ['RPC write 1 s after a block write (lagging node risk)', wsTrustProblem(v2(), ws(), { blockAppliedAt: () => NOW - 61_000, feedAppliedAt: () => 0 }, cfg, NOW)],
];
for (const [what, r] of reasons) assert(r !== null, `falls back to today's rule: ${what} (${r})`);
assert(wsTrustProblem(v2(), ws(), { blockAppliedAt: () => NOW - 60_000, feedAppliedAt: () => NOW - 90_000 }, cfg, NOW) === null, 'state written by the block reader (newer than a feed prediction) -> trusted');
assert(wsTrustProblem(v2({ poolType: 'v3', sqrtPriceX96: 1n, liquidity: 1n } as any), ws(), noWrites, { ...cfg, includeV3: true }, NOW) === null, 'SPEED_TRUST_WS_V3=1 would include V3 pools (off by default)');

// 4. The real WebSocket reader + pool cache: a down period resets trust.
class FakeSocket extends EventEmitter implements SocketLike {
  send() { /* ignore */ }
  close() { /* ignore */ }
  terminate() { /* ignore */ }
  ping() { /* ignore */ }
  reply(id: number, result: unknown) { this.emit('message', JSON.stringify({ jsonrpc: '2.0', id, result })); }
  push(sub: string, result: unknown) { this.emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: sub, result } })); }
}
{
  let clock = 1_000_000;
  const sockets: FakeSocket[] = [];
  const cache = new PoolCache();
  const reader = new WsBlockReader({
    url: 'wss://example.invalid/x', httpRpc: async () => '0x0', poolManager: '0x00000000000000000000000000000000000000dd',
    addresses: () => [ADDR], v4Ids: () => new Set<string>(), onUpdates: () => {},
    connect: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    schedule: () => () => {}, now: () => clock, autoTick: false, usage: new NodeUsageCounter(() => clock), log: () => {},
  });
  const live = (s: FakeSocket) => { s.emit('open'); s.reply(1, '0xsub' + sockets.length); };
  const data = (s: FakeSocket) => s.push('0xsub' + sockets.length, { address: ADDR, topics: [SYNC_TOPIC], data: '0x' + '0'.repeat(127) + '1' + '0'.repeat(63) + '2', blockNumber: '0x10', logIndex: '0x0' });
  reader.start();
  assert(reader.healthySinceMs() === null && !reader.coversPool(ADDR), 'not subscribed yet -> not healthy, nothing covered');
  live(sockets[0]);
  const since0 = reader.healthySinceMs();
  assert(since0 === clock, 'subscription live -> healthy stretch starts now');
  assert(reader.coversPool(ADDR) && !reader.coversPool('0x00000000000000000000000000000000000000ff'), 'only subscribed pools are covered');
  clock += 5_000;
  // Pool updated 5 s after the stretch began, data keeps flowing.
  const p = v2({ poolAddress: ADDR, lastUpdatedMs: clock });
  cache.upsert(p);
  clock += 60_000;
  data(sockets[0]);
  assert(reader.lastDataAtMs('pools') === clock, 'event data time tracked (pongs would not count)');
  assert(wsTrustProblem(cache.get('robinhood', ADDR)!, reader, cache, cfg, clock) === null, 'real reader: 60 s old pool, WebSocket healthy throughout -> trusted');

  // Connection drops and comes back: the pool was updated BEFORE the break.
  sockets[0].emit('close');
  assert(reader.healthySinceMs() === null, 'connection closed -> not healthy');
  assert(wsTrustProblem(cache.get('robinhood', ADDR)!, reader, cache, cfg, clock) !== null, 'while down -> RPC re-read (today\'s rule)');
  clock += 1_000;
  (reader as any).connect(); // reconnect (normally after the backoff timer)
  live(sockets[1]);
  data(sockets[1]);
  assert(reader.healthy(), 'reconnected and healthy again');
  assert(wsTrustProblem(cache.get('robinhood', ADDR)!, reader, cache, cfg, clock) !== null, 'after a down period the old pool is NOT trusted (we may have missed its events)');
  // Once the pool is refreshed after the break (plus the lag margin), trust returns.
  clock += 3_000;
  cache.upsertIfNotNewer({ ...p, lastUpdatedMs: clock }, clock);
  clock += 40_000;
  data(sockets[1]);
  assert(wsTrustProblem(cache.get('robinhood', ADDR)!, reader, cache, cfg, clock) === null, 'refreshed after the break -> trusted again');
  // Silence: healthy by keep-alive pings, but no event data for 4 s -> not trusted.
  clock += 4_000;
  sockets[1].emit('pong');
  assert(reader.healthy() && wsTrustProblem(cache.get('robinhood', ADDR)!, reader, cache, cfg, clock) !== null, 'pings alone (no event data for 4 s) -> not trusted');
  reader.stop();
}

// 5. A pair dropped from the watch list AFTER the subscription: still in the
//    subscription and in the cache, but its events are now thrown away, so it
//    must not be trusted. Coming back only counts from its return.
{
  let clock = 2_000_000;
  let list = [ADDR];
  const sockets: FakeSocket[] = [];
  const cache = new PoolCache();
  const mk = (addressFilter: boolean) => new WsBlockReader({
    url: 'wss://example.invalid/x', httpRpc: async () => '0x0', poolManager: '0x00000000000000000000000000000000000000dd',
    addresses: () => list, v4Ids: () => new Set<string>(), onUpdates: () => {}, addressFilter,
    connect: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    schedule: () => () => {}, now: () => clock, autoTick: false, usage: new NodeUsageCounter(() => clock), log: () => {},
  });
  const reader = mk(true);
  reader.start();
  sockets[0].emit('open'); sockets[0].reply(1, '0xsubA');
  const push = () => sockets[sockets.length - 1].push(sockets.length === 1 ? '0xsubA' : '0xsubB', { address: ADDR, topics: [SYNC_TOPIC], data: '0x' + '0'.repeat(127) + '1' + '0'.repeat(63) + '2', blockNumber: '0x10', logIndex: '0x0' });
  assert(reader.coveredSinceMs(ADDR) === clock, 'subscribed + on the current list -> covered from now');
  clock += 5_000;
  cache.upsert(v2({ lastUpdatedMs: clock }));
  clock += 50_000; push();
  assert(wsTrustProblem(cache.get('robinhood', ADDR)!, reader, cache, cfg, clock) === null, 'on the list the whole time -> trusted');
  list = [];                                  // pair dropped (over ROBINHOOD_MAX_PAIRS); subscription not renewed yet
  clock += 2_000; push();
  assert(reader.coveredSinceMs(ADDR) === null, 'dropped from the current list -> not covered, even though still subscribed');
  assert(wsTrustProblem(cache.get('robinhood', ADDR)!, reader, cache, cfg, clock) !== null, 'dropped pair -> NOT trusted (falls back to the RPC re-read)');
  list = [ADDR];                              // back on the list
  clock += 2_000; push();
  const back = reader.coveredSinceMs(ADDR);
  assert(back === clock, 'back on the list -> covered only from its return');
  assert(wsTrustProblem(cache.get('robinhood', ADDR)!, reader, cache, cfg, clock) !== null, 'state from before the gap -> still NOT trusted');
  reader.stop();

  // Address filter OFF (BLOCK_READER_WSS_FILTER=0): same current-list check.
  sockets.length = 0;
  list = [];
  const open = mk(false);
  open.start();
  sockets[0].emit('open'); sockets[0].reply(1, '0xsubA');
  assert(open.coveredSinceMs(ADDR) === null, 'filter off: a pool not on the current list is NOT covered');
  list = [ADDR];
  clock += 2_000;
  assert(open.coveredSinceMs(ADDR) === clock, 'filter off: pool on the current list is covered (from when it joined)');
  assert(!open.coversPool('0x00000000000000000000000000000000000000ff'), 'filter off: other pools on the chain are not covered');
  open.stop();
}
