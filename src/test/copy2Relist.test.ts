import { Copy2Link, copy2Settings, Copy2Settings } from '../execution/copy2';
import { WsBlockReader, SocketLike } from '../core/blockReaderWs';
import { SYNC_TOPIC, RpcLog } from '../core/blockReader';
import { NodeUsageCounter } from '../core/nodeUsage';
import { EventEmitter } from 'events';
import type { PoolState } from '../core/types';

// COPY 2 RE-LISTED POOLS (live Oct 24, fire-first: 59 % of triggers answered
// "copy2_pool_loading"). Pools left the bot's watch list (pair dropped as
// least recently traded, loop-extra pool not re-picked) and came back; copy
// 2 then had to reload them from the node while routes through them waited.
// These tests cover the bot side of the fix:
//   - DROP GRACE (COPY2_DROP_GRACE_S): a pool that leaves the watch list
//     stays on the follow list (and in the WebSocket subscription) for the
//     grace, so it is still READY when it comes back; bounded in count;
//   - a flap simulation: how often a pool drops off copy 2's list with and
//     without the grace, on a churning watch list;
//   - WANTED (COPY2_WANTED_S): route pools found loading are sent with the
//     status poll so the fast check loads them first.
// Fake clock, fake sockets, no network.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

let clock = 5_000_000;
const tick = () => new Promise((r) => setImmediate(r));
const schedule = (_fn: () => void, _ms: number) => () => {};

const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const WETH = '0x00000000000000000000000000000000000000e1';
const USDG = '0x00000000000000000000000000000000000000c2';
const addr = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const pool = (n: number): PoolState => ({
  chain: 'robinhood', dex: 'uniswap-v2', poolAddress: addr(n), poolType: 'v2', tokenA: WETH, tokenB: USDG,
  feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: 1,
} as PoolState);

function fakeClient() {
  const requests: any[] = [];
  return {
    requests,
    isConnected: () => true,
    sendOneWay: () => true,
    request: async (m: Record<string, unknown>) => { requests.push(JSON.parse(JSON.stringify(m))); return { id: m.id, ok: true }; },
  };
}

// A link following `watched()` with every pool covered by the subscription.
function makeLink(watched: () => PoolState[], env: Record<string, string> = {}, coverAll: number[] = []) {
  const client = fakeClient();
  const settings: Copy2Settings = copy2Settings(env);
  const link = new Copy2Link({ client: client as any, settings, pools: watched, poolManager: PM, now: () => clock, schedule, autoTimers: false, log: () => {} });
  link.applyStatus({ ok: true, source: 'pool-events', copy2: { pools: {} } });
  const all = new Set(coverAll.map(addr));
  link.tap.onLive({ pools: all, ids: new Set(), transferPools: all, coins: new Set([WETH, USDG]) });
  return { link, client };
}

const lastTrack = (client: { requests: any[] }): string[] | null => {
  const t = [...client.requests].reverse().find((r) => r.type === 'track');
  return t ? t.pools.map((p: any) => p.address) : null;
};

// ---------------------------------------------------------------------------
async function dropGraceTests() {
  // Five pools watched; pool 5 leaves the watch list, then comes back.
  let watched = [1, 2, 3, 4, 5].map(pool);
  const { link, client } = makeLink(() => watched, {}, [1, 2, 3, 4, 5]);
  await link.sendTrack(false); await tick();
  assert(lastTrack(client)?.length === 5, 'start: all five watched pools followed');
  assert(copy2Settings({}).dropGraceMs === 1_800_000 && copy2Settings({}).dropGraceMax === 300, 'defaults: 30 min drop grace, at most 300 held pools');
  clock += 6_000;
  watched = [1, 2, 3, 4].map(pool);
  await link.sendTrack(false); await tick();
  assert(lastTrack(client)?.includes(addr(5)) === true && link.heldCount() === 1, 'pool 5 left the watch list: still followed (held), copy 2 keeps it exact');
  assert(link.heldTargets().pools[0] === addr(5) && link.tap.extraTargets!().pools[0] === addr(5), 'held pool handed to the WebSocket as an extra subscription target');
  assert(link.tap.transferFilter()!.pools.includes(addr(5)), 'held pool keeps its coin-transfer subscription too');
  const tracks0 = client.requests.filter((r) => r.type === 'track').length;
  clock += 20 * 60_000;                                   // 20 min later it comes back
  watched = [1, 2, 3, 4, 5].map(pool);
  await link.sendTrack(false); await tick();
  assert(client.requests.filter((r) => r.type === 'track').length === tracks0 && link.heldCount() === 0, 'back within the grace: the list copy 2 follows never changed (no reload, READY at once)');
  assert(/came back while kept 1/.test(link.hourText() ?? ''), 'hourly line counts the pool that came back while kept');
  // Leaves again and stays away past the grace.
  clock += 6_000;
  watched = [1, 2, 3, 4].map(pool);
  await link.sendTrack(false); await tick();
  clock += 30 * 60_000 + 1;
  await link.sendTrack(false); await tick();
  assert(lastTrack(client)?.includes(addr(5)) === false && link.heldCount() === 0, 'away longer than the grace: dropped from the follow list (old behaviour from here)');

  // Count bound: at most COPY2_DROP_GRACE_MAX held, the most recently watched kept.
  watched = [1, 2, 3].map(pool);
  const b = makeLink(() => watched, { COPY2_DROP_GRACE_MAX: '1' }, [1, 2, 3]);
  await b.link.sendTrack(false);
  clock += 6_000; watched = [1, 2].map(pool); b.link.followList();   // 3 leaves first
  clock += 6_000; watched = [1].map(pool); await b.link.sendTrack(false); await tick();
  const tr = lastTrack(b.client)!;
  assert(b.link.heldCount() === 1 && tr.includes(addr(2)) && !tr.includes(addr(3)), 'COPY2_DROP_GRACE_MAX=1: only the most recently watched pool is held (memory bound)');

  // Off: drops at once.
  watched = [1, 2].map(pool);
  const c = makeLink(() => watched, { COPY2_DROP_GRACE_S: '0' }, [1, 2]);
  await c.link.sendTrack(false);
  clock += 6_000; watched = [1].map(pool); await c.link.sendTrack(false); await tick();
  assert(lastTrack(c.client)?.length === 1 && c.link.heldCount() === 0, 'COPY2_DROP_GRACE_S=0: a pool leaving the watch list is dropped at once (old behaviour)');
  assert(copy2Settings({ ARBSIM_COPY2_DROP_GRACE_S: '600' }).dropGraceMs === 600_000 && copy2Settings({ ARBSIM_COPY2_DROP_GRACE_S: '600', COPY2_DROP_GRACE_S: '60' }).dropGraceMs === 60_000, 'grace setting: the bot name wins, the fast check name is the fallback');
}

// ---------------------------------------------------------------------------
// FLAP SIMULATION. 600 steady pools + 60 "edge" pools on a watch list that
// is rebuilt every 10 min (loop-extra rebuild / LRU pair list): each edge
// pool is in or out at each rebuild (deterministic coin flips), track sent
// every 30 s as the live timer does. Counts how many times a pool that copy
// 2 was following disappears from its list (each = a park, and a reload if
// it comes back after the kept reports ran out).
async function flapSim(env: Record<string, string>): Promise<{ drops: number; relists: number }> {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const steady = Array.from({ length: 600 }, (_, i) => pool(0x1000 + i));
  const edges = Array.from({ length: 60 }, (_, i) => pool(0x9000 + i));
  let inEdge = new Set<number>(edges.map((_, i) => i));
  const watched = () => [...steady, ...edges.filter((_, i) => inEdge.has(i))];
  const cover = [...steady, ...edges].map((p) => parseInt(p.poolAddress.slice(2), 16));
  const { link, client } = makeLink(watched, env, cover);
  let prev = new Set<string>();
  let drops = 0, relists = 0;
  const everDropped = new Set<string>();
  for (let s = 0; s < 2 * 3600; s += 30) {       // 2 hours, every 30 s
    if (s % 600 === 0 && s > 0) inEdge = new Set(edges.map((_, i) => i).filter(() => rnd() < 0.5));
    clock += 30_000;
    await link.sendTrack(false); await tick();
    const now = new Set(lastTrack(client) ?? []);
    for (const k of prev) if (!now.has(k)) { drops++; everDropped.add(k); }
    for (const k of now) if (!prev.has(k) && everDropped.has(k)) relists++;
    prev = now;
  }
  return { drops, relists };
}

async function flapTests() {
  const off = await flapSim({ COPY2_DROP_GRACE_S: '0' });
  const on = await flapSim({});
  console.log(`  flap simulation (2 h, 60 edge pools, list rebuilt every 10 min): grace off ${off.drops} drops / ${off.relists} re-listings; grace 30 min ${on.drops} drops / ${on.relists} re-listings`);
  assert(off.drops > 100 && off.relists > 100, `without the grace edge pools flap at every rebuild (${off.drops} drops, ${off.relists} come back = reloads)`);
  assert(on.drops * 4 < off.drops && on.relists * 4 < off.relists, `with the 30 min grace far fewer drops (${on.drops} vs ${off.drops}) and re-listings (${on.relists} vs ${off.relists})`);
}

// ---------------------------------------------------------------------------
async function wantedTests() {
  const watched = [1, 2, 3].map(pool);
  const { link, client } = makeLink(() => watched, {}, [1, 2, 3]);
  await link.sendTrack(false); await tick();
  // Pretend the reports flow and readiness is fresh.
  (link.forwarder as any).live = () => true;
  (link.forwarder as any).lastGapAt = () => -1;
  link.applyStatus({ ok: true, source: 'pool-events', copy2: { pools: { [addr(1)]: 'unsure', [addr(2)]: 'loading', [addr(3)]: 'loading' } } });
  assert(link.notReadyWhy([addr(1), addr(2), addr(3)]) === 'pool unsure', 'the first pool that is not ready still decides the answer');
  assert(JSON.stringify(link.wantedKeys().sort()) === JSON.stringify([addr(2), addr(3)]), 'every loading pool on the route is noted as wanted (not only the first)');
  await link.pollStatus();
  const st = client.requests.filter((r) => r.type === 'status').pop();
  assert(Array.isArray(st?.wanted) && st.wanted.length === 2 && st.wanted.includes(addr(2)), 'wanted pools ride on the status poll');
  clock += 61_000;
  await link.pollStatus();
  const st2 = client.requests.filter((r) => r.type === 'status').pop();
  assert(st2 && st2.wanted === undefined, 'after COPY2_WANTED_S (60 s) the hint is no longer sent');
  const off = makeLink(() => watched, { COPY2_WANTED_S: '0' }, [1, 2, 3]);
  (off.link.forwarder as any).live = () => true;
  await off.link.sendTrack(false); await tick();
  off.link.applyStatus({ ok: true, source: 'pool-events', copy2: { pools: { [addr(2)]: 'loading' } } });
  off.link.notReadyWhy([addr(2)]);
  assert(off.link.wantedKeys().length === 0, 'COPY2_WANTED_S=0: nothing noted');
  // Bounded: at most 64 per poll.
  for (let i = 0; i < 300; i++) (link as any).noteWanted(addr(0x5000 + i));
  assert(link.wantedKeys().length === 64 && (link as any).wanted.size <= 256, 'wanted hints bounded (256 kept, 64 per poll)');
}

// ---------------------------------------------------------------------------
class FakeSocket extends EventEmitter implements SocketLike {
  sent: any[] = [];
  closed = false;
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.closed = true; }
  terminate() { this.closed = true; }
  ping() { /* */ }
  open() { this.emit('open'); }
  push(sub: string, result: unknown) { this.emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: sub, result } })); }
  reply(id: number, result: unknown) { this.emit('message', JSON.stringify({ jsonrpc: '2.0', id, result })); }
}

function wsExtraTargetTests() {
  const P1 = addr(0xa1), P2 = addr(0xa2), HELD = addr(0xa9);
  const make = (wanted: boolean) => {
    const sockets: FakeSocket[] = [];
    const applied: any[] = [];
    const got: RpcLog[][] = [];
    let live: any = null;
    const tap = { wanted: () => wanted, transferFilter: () => ({ coins: [WETH], pools: [P1, P2, HELD] }), extraTargets: () => ({ pools: [HELD], ids: [] }), onLogs: (l: RpcLog[]) => got.push(l), onLive: (c: any) => { live = c; }, onDown: () => {} };
    let t = 1_000;
    const r = new WsBlockReader({
      url: 'wss://example.invalid/KEY', httpRpc: async () => [], poolManager: PM,
      addresses: () => [P1, P2], v4Ids: () => new Set<string>(),
      onUpdates: (latest) => applied.push(latest),
      connect: () => { const s = new FakeSocket(); sockets.push(s); return s; },
      schedule: (fn, ms) => { const h = setTimeout(fn, 0); void ms; return () => clearTimeout(h); }, now: () => t, autoTick: false, usage: new NodeUsageCounter(() => t), log: () => {},
      rawLogTap: tap,
    });
    return { r, sockets, applied, got, liveOf: () => live };
  };
  {
    const { r, sockets, liveOf } = make(true);
    r.start(); sockets[0]!.open();
    const addrs: string[] = sockets[0]!.sent[0].params[1].address;
    assert(addrs.includes(HELD) && addrs.includes(P1), 'tap wanted: the held pool joins the pool-event subscription');
    sockets[0]!.reply(1, '0xs1'); sockets[0]!.reply(4, '0xs4'); sockets[0]!.reply(5, '0xs5');
    assert(liveOf()?.pools.has(HELD) === true, 'the held pool counts as covered for copy 2 (stays on its track list)');
    assert(r.coversPool(HELD) === false, 'but never as covered for the price path (not on the watch list)');
    r.stop();
  }
  {
    const { r, sockets } = make(false);
    r.start(); sockets[0]!.open();
    const addrs: string[] = sockets[0]!.sent[0].params[1].address;
    assert(!addrs.includes(HELD), 'tap not wanted: subscription exactly the watch list (held pools never on their own)');
    r.stop();
  }
}

// A held pool's event goes to the tap only, never into the price path.
async function wsHeldEventTest() {
  const P1 = addr(0xa1), HELD = addr(0xa9);
  const sockets: FakeSocket[] = [];
  const applied: any[] = [];
  const got: RpcLog[][] = [];
  const tap = { wanted: () => true, transferFilter: () => ({ coins: [WETH], pools: [P1, HELD] }), extraTargets: () => ({ pools: [HELD], ids: [] }), onLogs: (l: RpcLog[]) => got.push(l), onLive: () => {}, onDown: () => {} };
  const r = new WsBlockReader({
    url: 'wss://example.invalid/KEY', httpRpc: async () => [], poolManager: PM,
    addresses: () => [P1], v4Ids: () => new Set<string>(),
    onUpdates: (latest) => applied.push(latest),
    connect: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    schedule: (fn) => { const h = setTimeout(fn, 0); return () => clearTimeout(h); }, now: () => 1_000, autoTick: false, usage: new NodeUsageCounter(() => 1_000), log: () => {},
    rawLogTap: tap,
  });
  r.start(); sockets[0]!.open();
  sockets[0]!.reply(1, '0xs1'); sockets[0]!.reply(4, '0xs4'); sockets[0]!.reply(5, '0xs5');
  const sync = (a: string, b: number) => ({ address: a, topics: [SYNC_TOPIC], data: '0x' + '0'.repeat(63) + '1' + '0'.repeat(63) + '2', blockNumber: '0x' + b.toString(16), transactionIndex: '0x0', logIndex: '0x0', transactionHash: '0x' + 'ab'.repeat(32) });
  sockets[0]!.push('0xs1', sync(HELD, 70));
  await new Promise((res) => setTimeout(res, 20));
  assert(got.length === 1 && applied.length === 0, 'held pool event: handed to copy 2, ignored by the price path');
  sockets[0]!.push('0xs1', sync(P1, 71));
  await new Promise((res) => setTimeout(res, 20));
  assert(applied.length === 1, 'watched pool event still reaches the price path');
  r.stop();
}

async function main() {
  await dropGraceTests();
  await flapTests();
  await wantedTests();
  wsExtraTargetTests();
  await wsHeldEventTest();
}
main().catch((e) => { console.error('FAIL: crashed', e); process.exitCode = 1; });
