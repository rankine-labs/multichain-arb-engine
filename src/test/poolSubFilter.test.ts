import { EventEmitter } from 'events';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PoolSubFilter, poolSubSettingsFromEnv, type PoolSubDeps, type PoolSubSettings } from '../core/poolSubFilter';
import { WsBlockReader, type SocketLike } from '../core/blockReaderWs';
import { NodeUsageCounter } from '../core/nodeUsage';
import { SYNC_TOPIC, V4_SWAP_TOPIC } from '../core/blockReader';

// POOL_SUB_FILTER (core/poolSubFilter.ts): which watched pools are left out
// of the push feed, how they come back, the saved state, the busy sweep and
// the event counting. Fake clock, fake node, temp folder (no network).

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const HOUR = 3_600_000;
const a = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const id = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const PM = '0x' + 'ee'.repeat(20);
const dir = mkdtempSync(join(tmpdir(), 'subfilter-'));
let fileN = 0;

// Pools: 1 = copy 2 follows, 2 = used, 3 = rich, 4 = unknown money,
// 5 = tiny & idle (dropped), 6 = tiny & idle V4 id (dropped).
const P1 = a(1), P2 = a(2), P3 = a(3), P4 = a(4), P5 = a(5), V6 = id(6);
const money: Record<string, number | null> = { [P1]: 100, [P2]: 100, [P3]: 50_000, [P4]: null, [P5]: 100, [V6]: 50 };

function make(over: Partial<PoolSubSettings> = {}, depsOver: Partial<PoolSubDeps> = {}, file?: string) {
  let clock = 1_000_000_000;
  const logs: string[] = [];
  const c2 = new Set<string>([P1]);
  const watch = [P1, P2, P3, P4, P5, V6];
  const s: PoolSubSettings = { ...poolSubSettingsFromEnv({}), file: file ?? join(dir, `f${fileN++}.json`), ...over };
  const d: PoolSubDeps = {
    watchKeys: () => watch,
    copy2Keys: () => c2,
    depthUsd: (k) => money[k] ?? null,
    poolManager: PM,
    now: () => clock,
    log: (l) => logs.push(l),
    ...depsOver,
  };
  const f = new PoolSubFilter(s, d);
  return { f, logs, c2, watch, adv: (ms: number) => { clock += ms; }, now: () => clock };
}

// ---- settings ----
{
  const s = poolSubSettingsFromEnv({});
  assert(!s.on && s.useDays === 5 && s.minUsd === 2_000 && s.newGraceH === 24 && s.recheckH === 24 && s.sweepMin === 10, 'defaults: off, 5 days, $2,000, 24 h grace, daily re-check, 10 min sweep');
  assert(poolSubSettingsFromEnv({ POOL_SUB_FILTER: '1' }).on && poolSubSettingsFromEnv({ POOL_SUB_FILTER: 'on' }).on, 'POOL_SUB_FILTER=1 / on switches it on');
  assert(!poolSubSettingsFromEnv({ POOL_SUB_FILTER: '0' }).on, 'POOL_SUB_FILTER=0 = off');
  assert(poolSubSettingsFromEnv({ POOL_SUB_USE_DAYS: 'x' }).useDays === 5, 'bad number falls back to the default');
}

// ---- warm-up: nothing dropped in the first 24 h; then only tiny idle pools ----
{
  const t = make({ on: true });
  t.f.noteUsed([P2]);
  t.f.tick();                                   // first check: every pool is new
  assert(t.f.stats().dropped === 0, 'first day: nothing dropped (new-pool grace)');
  assert(t.logs.some((l) => l.includes('after the new-pool grace +2 pools')), 'line says 2 pools would go after the grace');
  t.adv(25 * HOUR);
  t.f.noteUsed([P2]);
  t.f.tick();                                   // daily re-check
  const dropped = new Set(t.f.droppedKeys());
  assert(dropped.size === 2 && dropped.has(P5) && dropped.has(V6), 'after a day: only the tiny idle pool and the tiny idle V4 id are dropped');
  assert(!dropped.has(P1), 'copy 2 pool kept even though tiny and idle');
  assert(!dropped.has(P2), 'used pool kept');
  assert(!dropped.has(P3), 'rich pool kept');
  assert(!dropped.has(P4), 'pool with unknown money kept');
  const out = t.f.apply(t.watch.filter((k) => k.length === 42), new Set([V6]));
  assert(out.pools.join() === [P1, P2, P3, P4].join() && out.ids.length === 0, 'apply leaves the dropped pools out of the subscription');

  // Re-adds.
  t.f.noteUsed([P5.toUpperCase().replace('0X', '0x')]);
  assert(!t.f.isDropped(P5) && t.f.stats().byWhy.used === 1, 'a dropped pool used in an idea comes back at once');
  t.c2.add(V6);
  const out2 = t.f.apply([P1], new Set([V6]));
  assert(out2.ids.includes(V6) && t.f.stats().byWhy.copy2 === 1, 'copy 2 starting to follow a dropped pool brings it back at once');
}

// ---- between re-checks: money brings a pool back, nothing new is dropped ----
{
  const t = make({ on: true });
  t.f.tick(); t.adv(25 * HOUR); t.f.tick();
  assert(t.f.isDropped(P5), 'P5 dropped');
  money[P5] = 9_000;
  t.adv(10 * 60_000); t.f.tick();
  assert(!t.f.isDropped(P5) && t.f.stats().byWhy.money === 1, 'pool whose money went over the floor comes back at the next 10 min check');
  money[P5] = 100;
  t.adv(10 * 60_000); t.f.tick();
  assert(!t.f.isDropped(P5), 'not dropped again until the next daily re-check');
  t.adv(24 * HOUR); t.f.tick();
  assert(t.f.isDropped(P5), 'dropped again at the next daily re-check (still tiny and idle)');
}

// ---- off = old behaviour ----
{
  const t = make({ on: false });
  t.f.tick(); t.adv(25 * HOUR); t.f.tick();
  const out = t.f.apply([P1, P5], new Set([V6]));
  assert(out.pools.length === 2 && out.ids.length === 1, 'filter off: subscription unchanged');
  assert(!t.f.isDropped(P5), 'filter off: nothing reported as dropped');
  assert(t.logs.some((l) => l.includes('OFF (dry run') && l.includes('would drop 3 of 6')), 'filter off: line says what WOULD be dropped (tiny idle pool, tiny idle V4 id, and the unused small pool)');
}

// ---- safety: never an empty contract list ----
{
  const t = make({ on: true });
  t.f.tick(); t.adv(25 * HOUR); t.f.tick();
  const out = t.f.apply([P5], new Set());
  assert(out.pools.length === 1 && out.pools[0] === P5, 'all contract pools dropped -> full list kept (never subscribe to nothing)');
}

// ---- saved state survives a restart ----
{
  const file = join(dir, 'persist.json');
  const t = make({ on: true }, {}, file);
  t.f.noteUsed([P2]);
  t.f.tick(); t.adv(25 * HOUR); t.f.noteUsed([P2]); t.f.tick();
  assert(existsSync(file), 'state file written');
  const t2 = make({ on: true }, { now: () => t.now() }, file);
  assert(new Set(t2.f.droppedKeys()).has(P5) && t2.f.droppedKeys().length === 2, 'restart: drop list loaded, not re-learned');
  t2.f.tick();
  assert(t2.f.droppedKeys().length === 2, 'restart: no early re-check (list made less than a day ago)');
}

// ---- busy sweep ----
(async () => {
  const calls: Array<{ method: string; params: any[] }> = [];
  let counted = 0;
  const t = make({ on: true, busyEvents: 3, sweepRange: 1_000 }, {
    rpc: async (method, params) => {
      calls.push({ method, params: params as any[] });
      if (method === 'eth_blockNumber') return '0x' + (5_000).toString(16);
      const f = (params as any[])[0];
      if (f.address === PM) return [1, 2, 3].map(() => ({ address: PM, topics: [V4_SWAP_TOPIC, V6] }));
      return [{ address: P5, topics: [SYNC_TOPIC] }];   // only 1 event: stays dropped
    },
    countRequest: () => { counted++; },
  });
  t.f.tick(); t.adv(25 * HOUR); t.f.tick();
  await t.f.sweep();
  const gl = calls.filter((c) => c.method === 'eth_getLogs');
  assert(gl.length === 2 && counted === 3, 'first sweep: one range, 1 contract + 1 V4 request (+ block number), all counted');
  assert(Number(BigInt(gl[0].params[0].toBlock)) - Number(BigInt(gl[0].params[0].fromBlock)) + 1 <= 1_000, 'sweep range capped at POOL_SUB_SWEEP_RANGE blocks');
  assert(!t.f.isDropped(V6) && t.f.stats().byWhy.busy === 1, 'V4 pool with 3+ events in the sweep comes back (busy)');
  assert(t.f.isDropped(P5), 'pool with 1 event stays dropped');
  calls.length = 0;
  await t.f.sweep();
  const gl2 = calls.filter((c) => c.method === 'eth_getLogs');
  assert(gl2.length === 0 || Number(BigInt(gl2[0].params[0].fromBlock)) === 5_001, 'next sweep starts after the last swept block (nothing new = no logs request)');
  // A sweep with nothing dropped does nothing.
  const t3 = make({ on: true }, { rpc: async () => { throw new Error('should not be called'); } });
  await t3.f.sweep();
  assert(t3.f.stats().dropped === 0, 'no dropped pools: no sweep requests');

  // ---- counting + line ----
  const c = make({ on: false });
  c.f.tick();                                   // learns the watch list
  c.f.countPushed('pools', [{ address: P5, topics: [SYNC_TOPIC] } as any, { address: P1, topics: [SYNC_TOPIC] } as any], PM);
  c.f.countPushed('v4', [{ address: PM, topics: [V4_SWAP_TOPIC, V6] } as any], PM);
  c.f.countPushed('tf', [{ address: a(99), topics: ['0xddf2', '0x' + '0'.repeat(24) + a(77).slice(2), '0x' + '0'.repeat(24) + P5.slice(2)] } as any], PM);
  c.f.countPushed('pools', [{ address: a(88), topics: [] } as any], PM);  // an outside contract (not a watched pool)
  c.f.countPushed('heads', null, PM);
  assert(c.f.stats().windowEvents === 6, 'every pushed event counted (5 logs + 1 header)');
  c.adv(10 * 60_000);
  c.f.tick();
  const line = c.logs[c.logs.length - 1];
  assert(/events\/min 0\.6 \(pools 0\.2, v4 0\.1, transfers 0\.1, other 0\.1, headers 0\.1\)/.test(line), 'line splits events per minute by kind');
  assert(c.f.lastWindowEvents(P5) === 2, 'a transfer into a pool is counted for that pool');

  // ---- WsBlockReader: filter applied, copy 2 extras untouched, events counted ----
  class FakeSocket extends EventEmitter implements SocketLike {
    sent: any[] = [];
    send(x: string) { this.sent.push(JSON.parse(x)); }
    close() { /* */ }
    terminate() { /* */ }
    ping() { /* */ }
  }
  const sockets: FakeSocket[] = [];
  const pushed: string[] = [];
  const HELD = a(500);
  const r = new WsBlockReader({
    url: 'wss://example.invalid/KEY', httpRpc: async () => '0x1', poolManager: PM,
    addresses: () => [P1, P5], v4Ids: () => new Set([V6]),
    onUpdates: () => undefined,
    connect: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    schedule: () => () => undefined, now: () => 0, autoTick: false, usage: new NodeUsageCounter(), log: () => undefined,
    subFilter: { apply: (pools, ids) => ({ pools: pools.filter((p) => p !== P5), ids: [...ids].filter((i) => i !== V6) }) },
    onPushed: (kind, logs) => pushed.push(`${kind}:${logs?.length ?? 0}`),
    rawLogTap: {
      wanted: () => true, transferFilter: () => ({ coins: [a(900)], pools: [P1] }), onLogs: () => undefined,
      extraTargets: () => ({ pools: [HELD], ids: [] }), onLive: () => undefined, onDown: () => undefined,
    },
  });
  r.start();
  sockets[0].emit('open');
  const sub1 = sockets[0].sent.find((m) => m.id === 1);
  const addrs: string[] = sub1.params[1].address;
  assert(addrs.includes(P1) && !addrs.includes(P5), 'push reader: dropped pool left out of the subscription');
  assert(addrs.includes(HELD), "push reader: copy 2's held pool still added after the filter");
  assert(!sockets[0].sent.some((m) => m.id === 3), 'push reader: no V4 subscription when every V4 id is dropped');
  sockets[0].emit('message', JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xsub1' }));
  sockets[0].emit('message', JSON.stringify({ jsonrpc: '2.0', id: 4, result: '0xtf4' }));
  sockets[0].emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: '0xsub1', result: { address: P1, topics: [SYNC_TOPIC], blockNumber: '0x5', data: '0x' } } }));
  sockets[0].emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: '0xtf4', result: { address: a(900), topics: [], blockNumber: '0x5', data: '0x' } } }));
  assert(pushed.join() === 'pools:1,tf:1', 'push reader: each pushed event reported to the counter with its kind');
  r.stop();
  // No filter = exactly the old list.
  const sockets2: FakeSocket[] = [];
  const r2 = new WsBlockReader({
    url: 'wss://example.invalid/KEY', httpRpc: async () => '0x1', poolManager: PM,
    addresses: () => [P1, P5], v4Ids: () => new Set([V6]), onUpdates: () => undefined,
    connect: () => { const s = new FakeSocket(); sockets2.push(s); return s; },
    schedule: () => () => undefined, now: () => 0, autoTick: false, usage: new NodeUsageCounter(), log: () => undefined,
  });
  r2.start();
  sockets2[0].emit('open');
  const s2 = sockets2[0].sent.find((m) => m.id === 1);
  assert(s2.params[1].address.includes(P5) && sockets2[0].sent.some((m) => m.id === 3), 'no filter: every pool and V4 id subscribed, as before');
  r2.stop();
  rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error(`FAIL: test crashed: ${e?.stack ?? e}`); process.exitCode = 1; });
