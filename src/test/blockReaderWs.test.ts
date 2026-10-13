import { EventEmitter } from 'events';
import { WsBlockReader, SocketLike, backfillRange, wsReason } from '../core/blockReaderWs';
import { SYNC_TOPIC, V4_SWAP_TOPIC, HANDLED_TOPICS, RpcLog, PoolUpdate } from '../core/blockReader';
import { NodeUsageCounter } from '../core/nodeUsage';

// Push block reader: WebSocket events -> same pool updates as the poll reader,
// with reconnect, stale detection, poll fallback and gap fill. All with a fake
// socket and a fake clock (no network).

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// ---- fake socket: records what we send, lets the test push events ----
class FakeSocket extends EventEmitter implements SocketLike {
  sent: any[] = [];
  closed = false;
  pings = 0;
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.closed = true; }
  terminate() { this.closed = true; }
  ping() { this.pings++; }
  // Helpers for the test
  open() { this.emit('open'); }
  reply(id: number, result: unknown) { this.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }))); }
  replyError(id: number, message: string) { this.emit('message', JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } })); }
  push(sub: string, result: unknown) { this.emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: sub, result } })); }
}

// ---- fake clock + scheduler: timers run only when the test says so ----
let clock = 1_000_000;
type Job = { at: number; fn: () => void; cancelled: boolean; ms: number };
let jobs: Job[] = [];
const schedule = (fn: () => void, ms: number) => { const j = { at: clock + ms, fn, cancelled: false, ms }; jobs.push(j); return () => { j.cancelled = true; }; };
// Advance the clock and run every timer that is due.
function advance(ms: number) {
  clock += ms;
  for (;;) {
    const due = jobs.filter((j) => !j.cancelled && j.at <= clock).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    due.cancelled = true;
    due.fn();
  }
  jobs = jobs.filter((j) => !j.cancelled);
}
const tick = () => new Promise((r) => setImmediate(r));

// ---- fake logs ----
const PM = '0x00000000000000000000000000000000000000dd';
const A = '0x00000000000000000000000000000000000000a1';
const OTHER = '0x00000000000000000000000000000000000000ff';
const ID = '0x' + 'cd'.repeat(32);
const ID_OTHER = '0x' + 'ee'.repeat(32);
const q = (n: number) => '0x' + n.toString(16);
const word = (n: bigint) => BigInt.asUintN(256, n).toString(16).padStart(64, '0');
const data = (...ns: bigint[]) => '0x' + ns.map(word).join('');
const syncLog = (address: string, block: number, idx: number, r0: bigint, r1: bigint, extra: Partial<RpcLog> = {}): RpcLog =>
  ({ address, topics: [SYNC_TOPIC], data: data(r0, r1), blockNumber: q(block), logIndex: q(idx), ...extra });
const v4Log = (id: string, block: number, idx: number): RpcLog =>
  ({ address: PM, topics: [V4_SWAP_TOPIC, id, '0x' + '00'.repeat(32)], data: data(1n, 2n, 3n, 4n, 5n, 6n), blockNumber: q(block), logIndex: q(idx) });

// Build a reader wired to a fake socket factory.
function setup(httpAnswers: { head?: number; logs?: RpcLog[]; fail?: boolean } = {}, extra: { addressFilter?: boolean; dailyMessageCap?: number; resubscribeMs?: number; addresses?: () => string[] } = {}) {
  const sockets: FakeSocket[] = [];
  const applied: Array<{ latest: Map<string, PoolUpdate>; toBlock: number }> = [];
  const health: Array<{ healthy: boolean; last: number }> = [];
  const httpCalls: Array<{ method: string; params: any[] }> = [];
  const usage = new NodeUsageCounter(() => clock);
  const logs: string[] = [];
  const r = new WsBlockReader({
    url: 'wss://nd-111-222-333.p2pify.com/SECRETKEY123',
    httpRpc: async (method, params) => {
      httpCalls.push({ method, params: params as any[] });
      if (httpAnswers.fail) throw new Error('fetch failed');
      if (method === 'eth_blockNumber') return q(httpAnswers.head ?? 0);
      return httpAnswers.logs ?? [];
    },
    httpLabel: 'test HTTP',
    poolManager: PM,
    addresses: extra.addresses ?? (() => [A]),
    v4Ids: () => new Set([ID]),
    addressFilter: extra.addressFilter,
    dailyMessageCap: extra.dailyMessageCap,
    resubscribeMs: extra.resubscribeMs,
    onUpdates: (latest, toBlock) => applied.push({ latest, toBlock }),
    onHealthChange: (healthy, last) => health.push({ healthy, last }),
    connect: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    schedule, now: () => clock, autoTick: false, usage,
    log: (l) => logs.push(l),
  });
  return { r, sockets, applied, health, httpCalls, usage, logs };
}

async function filterAndCapTests() {
  // ---- address filter off: every pool on the chain (old behaviour) ----
  {
    const { r, sockets } = setup({}, { addressFilter: false });
    r.start(); sockets[0]!.open();
    assert(!sockets[0]!.sent[0].params[1].address, 'BLOCK_READER_WSS_FILTER=0: no address filter');
    r.stop();
  }
  // ---- watch list changes: subscription renewed, but not more often than resubscribeMs ----
  {
    let list = [A];
    const { r, sockets, logs } = setup({ head: 0 }, { resubscribeMs: 60_000, addresses: () => list });
    r.start(); sockets[0]!.open(); sockets[0]!.reply(1, '0xs1');
    list = [A, OTHER];
    advance(1_000); r.tick();
    assert(sockets.length === 1, 'list changed but renewal waits for resubscribeMs');
    advance(60_000); sockets[0]!.emit('pong'); r.tick();
    assert(sockets.length === 2, 'after resubscribeMs: new socket with the new list');
    sockets[1]!.open();
    assert(JSON.stringify(sockets[1]!.sent[0].params[1].address) === JSON.stringify([A, OTHER].sort()), 'renewed subscription includes the new pool');
    assert(r.stats().resubscribes === 1 && logs.some((l) => l.includes('renewing the subscription')), 'renewal counted and logged');
    sockets[1]!.reply(1, '0xs2');
    advance(61_000); sockets[1]!.emit('pong'); r.tick();
    assert(sockets.length === 2, 'same list: no renewal');
    r.stop();
  }
  // ---- daily cap: feed stops, polling takes over, back on the next UTC day ----
  {
    clock = Date.UTC(2026, 9, 13, 23, 0, 0);
    const { r, sockets, logs } = setup({}, { dailyMessageCap: 3 });
    r.start(); sockets[0]!.open(); sockets[0]!.reply(1, '0xc1');       // message 1 (subscribe reply)
    sockets[0]!.push('0xc1', syncLog(A, 10, 0, 1n, 1n));                 // message 2
    assert(r.healthy(), 'under the cap: healthy');
    sockets[0]!.push('0xc1', syncLog(A, 11, 0, 1n, 1n));                 // message 3: cap
    assert(!r.healthy() && r.stats().capped && sockets[0]!.closed, 'cap reached: socket closed, poll reader takes over');
    assert(logs.some((l) => l.includes('daily cap')), 'cap logged');
    advance(40_000); r.tick();
    assert(sockets.length === 1, 'no reconnect while capped');
    clock = Date.UTC(2026, 9, 14, 0, 0, 5); r.tick();
    assert(sockets.length === 2 && !r.stats().capped, 'next UTC day: push feed back on');
    r.stop();
  }
}

async function main() {
  await filterAndCapTests();
  // ---- backfill range maths ----
  {
    const r = backfillRange(100, 150, 200);
    assert(!!r && r.from === 100 && r.to === 150 && !r.skipped, 'gap 100..150: re-read from the last seen block (inclusive) to the head');
    const big = backfillRange(100, 1000, 200);
    assert(!!big && big.from === 801 && big.to === 1000 && big.skipped, 'gap bigger than 200 blocks: only the newest 200 (801..1000), marked skipped');
    const exact = backfillRange(801, 1000, 200);
    assert(!!exact && exact.from === 801 && !exact.skipped, 'exactly 200 blocks: not skipped');
    assert(backfillRange(-1, 100) === null, 'never saw a block yet: no gap fill');
    assert(backfillRange(200, 150) === null, 'head behind our last block: nothing to read');
    const same = backfillRange(150, 150);
    assert(!!same && same.from === 150 && same.to === 150, 'head equals last block: re-read that one block');
  }

  // ---- safe error text never carries the URL ----
  assert(wsReason(new Error('Unexpected server response: 401')) === 'HTTP 401', 'HTTP status kept from a refused handshake');
  assert(!wsReason(new Error('getaddrinfo ENOTFOUND nd-111.p2pify.com/SECRETKEY')).includes('SECRET'), 'error text never includes the URL/key');

  // ---- subscribe + messages -> updates applied ----
  {
    const { r, sockets, applied, health, usage, logs } = setup();
    r.start();
    assert(sockets.length === 1, 'start opens one socket');
    assert(!r.healthy() && r.fallbackActive(), 'before subscribing: not healthy, poll reader should run');
    const s = sockets[0]!;
    s.open();
    const sub = s.sent[0];
    assert(sub?.method === 'eth_subscribe' && sub.params[0] === 'logs', 'on open: subscribes to logs');
    assert(JSON.stringify(sub.params[1].topics) === JSON.stringify([HANDLED_TOPICS.filter((t) => t !== V4_SWAP_TOPIC)]), 'pool subscription: the poll reader topics minus V4 swaps');
    assert(JSON.stringify(sub.params[1].address) === JSON.stringify([A]), 'address filter on by default: only our pool contracts');
    const v4sub = s.sent[1];
    assert(v4sub?.id === 3 && v4sub.params[1].address === PM && JSON.stringify(v4sub.params[1].topics) === JSON.stringify([[V4_SWAP_TOPIC], [ID]]), 'second subscription: V4 swaps from the PoolManager for our V4 pool ids only');
    s.reply(3, '0xsubv4');
    assert(!s.sent.some((x) => x.params?.[0] === 'newHeads'), 'newHeads NOT subscribed by default (saves billed messages)');
    s.reply(1, '0xsub1');
    assert(r.healthy() && !r.fallbackActive(), 'subscription confirmed: healthy, poll reader pauses');
    assert(health.length === 1 && health[0]!.healthy, 'health change reported (up)');

    s.push('0xsub1', syncLog(A, 500, 1, 10n, 20n));
    s.push('0xsub1', syncLog(A, 500, 3, 11n, 21n));         // newer in same block wins
    s.push('0xsub1', syncLog(OTHER, 501, 0, 1n, 1n));      // not our pool: ignored but advances the block
    s.push('0xsubv4', v4Log(ID, 500, 2));                  // our V4 pool (arrives on the V4 subscription)
    s.push('0xsub1', v4Log(ID_OTHER, 500, 4));             // V4 pool we don't watch
    s.push('0xwrongsub', syncLog(A, 600, 0, 9n, 9n));      // unknown subscription id: ignored
    assert(applied.length === 0, 'events are gathered briefly, not applied one by one');
    advance(5);
    assert(applied.length === 1, 'one batch handed to the bot after the short gather window');
    const b = applied[0]!;
    const a = b.latest.get(A);
    assert(!!a && a.reserve0 === 11n && a.reserve1 === 21n && a.block === 500, 'newest Sync for our pool applied (same update shape as the poll reader)');
    assert(b.latest.has(ID) && !b.latest.has(ID_OTHER) && !b.latest.has(OTHER), 'only our pools / V4 ids kept (same filter as poll reader)');
    assert(b.toBlock === 501 && r.stats().lastBlock === 501, 'last block tracks the newest event seen on chain');
    assert(r.stats().messages === 8 && usage.summary().find((x) => x.label === r.label)!.wsMessages === 8, 'every pushed message counted (stats + usage counter)');
    assert(r.label === 'Chainstack WebSocket', 'node labelled by provider name from the host');
    assert(!logs.join('\n').includes('SECRETKEY'), 'logs never contain the URL / key');

    // Removed (reorg) log: never applied.
    s.push('0xsub1', syncLog(A, 502, 0, 99n, 99n, { removed: true }));
    advance(5);
    await tick(); await tick();
    assert(![...applied.slice(1)].some((x) => x.latest.get(A)?.reserve0 === 99n), 'reorg ("removed": true) event is never applied');
    assert(r.stats().reorgs === 1, 'reorg event counted');
    r.stop();
  }

  // ---- reorg -> re-read over HTTP from that block ----
  {
    const { r, sockets, httpCalls, applied } = setup({ head: 505, logs: [syncLog(A, 503, 0, 7n, 8n)] });
    r.start();
    const s = sockets[0]!;
    s.open(); s.reply(1, '0xs');
    s.push('0xs', syncLog(A, 503, 0, 1n, 1n, { removed: true }));
    advance(5);
    await tick(); await tick(); await tick();
    const gl = httpCalls.find((c) => c.method === 'eth_getLogs');
    assert(!!gl && gl.params[0].fromBlock === q(503) && gl.params[0].toBlock === q(505), 'reorg: blocks 503..head re-read over HTTP');
    assert(applied.some((x) => x.latest.get(A)?.reserve0 === 7n), 'reorg re-read result applied');
    r.stop();
  }

  // ---- stale -> reconnect with backoff; disconnect -> poll fallback ----
  {
    const { r, sockets, health } = setup({ head: 700 });
    r.start();
    const s = sockets[0]!;
    s.open(); s.reply(1, '0xa');
    s.push('0xa', syncLog(A, 650, 0, 1n, 2n));
    advance(5);
    // Quiet for 6 s: a keep-alive ping (free control frame), still healthy.
    advance(6_000); r.tick();
    assert(s.pings === 1 && r.healthy(), 'quiet 6 s: keep-alive ping sent, still healthy');
    s.emit('pong'); // node answered the ping
    advance(9_000); r.tick();
    assert(r.healthy(), 'pong counts as alive');
    // Nothing at all for over 10 s -> stale.
    advance(10_500);
    assert(!r.healthy() && r.fallbackActive(), 'no message for 10 s: not healthy, poll fallback on');
    r.tick();
    assert(s.closed, 'stale connection closed');
    assert(r.stats().staleReconnects === 1, 'stale reconnect counted');
    const down = health[health.length - 1]!;
    assert(!down.healthy && down.last === 650, 'fallback reported with the last block (poll reader resumes there)');
    assert(sockets.length === 1, 'reconnect waits (backoff), not immediate');
    advance(1_000);
    assert(sockets.length === 2, 'reconnects after 1 s');
    // Second socket fails to open -> next wait 2 s, then 4 s ...
    sockets[1]!.emit('error', new Error('connect ECONNREFUSED'));
    assert(r.nextBackoffMs() === 4_000, 'backoff doubles (1 s -> 2 s -> next 4 s)');
    advance(1_999); assert(sockets.length === 2, 'not before 2 s');
    advance(1);     assert(sockets.length === 3, 'retry after 2 s');
    for (let i = 0; i < 8; i++) { sockets[sockets.length - 1]!.emit('close'); advance(30_000); }
    assert(r.nextBackoffMs() === 30_000, 'backoff capped at 30 s');
    assert(r.stats().fallbackSeconds > 0, 'fallback seconds counted while down');

    // Healthy again (the gap fill itself is checked in the next block).
    const last = sockets[sockets.length - 1]!;
    last.open(); last.reply(1, '0xb');
    assert(r.healthy(), 'reconnected and subscribed: healthy again');
    assert(health[health.length - 1]!.healthy, 'health change reported (back up)');
    last.push('0xb', syncLog(A, 701, 0, 3n, 4n));
    assert(r.nextBackoffMs() === 1_000, 'backoff resets to 1 s once events flow again');
    r.stop();
  }

  // ---- gap fill on reconnect: range + single eth_getLogs ----
  {
    const { r, sockets, httpCalls, applied, usage } = setup({ head: 900, logs: [syncLog(A, 880, 0, 5n, 6n)] });
    r.start();
    sockets[0]!.open(); sockets[0]!.reply(1, '0x1');
    sockets[0]!.push('0x1', syncLog(A, 850, 0, 1n, 1n));
    advance(5);
    assert(httpCalls.length === 0, 'first connect: no gap fill (poll reader was running)');
    sockets[0]!.emit('close');
    assert(r.fallbackActive(), 'disconnect: poll fallback on immediately');
    advance(1_000);
    sockets[1]!.open(); sockets[1]!.reply(1, '0x2');
    await tick(); await tick(); await tick();
    const getLogs = httpCalls.filter((c) => c.method === 'eth_getLogs');
    assert(getLogs.length === 1, 'reconnect: exactly ONE eth_getLogs gap fill');
    assert(getLogs[0]!.params[0].fromBlock === q(850) && getLogs[0]!.params[0].toBlock === q(900), 'gap fill covers last seen block (850) to head (900)');
    assert(JSON.stringify(getLogs[0]!.params[0].topics) === JSON.stringify([HANDLED_TOPICS]) && !getLogs[0]!.params[0].address, 'gap fill uses the same topics, no address list');
    assert(applied.some((x) => x.latest.get(A)?.reserve0 === 5n && x.toBlock === 900), 'gap-fill events applied through the same path');
    assert(r.stats().backfills === 1 && r.stats().lastBlock === 900, 'gap fill counted, last block moved to head');
    assert(usage.summary().find((x) => x.label === 'test HTTP')!.requests === 2, 'gap fill HTTP requests counted in usage');
    r.stop();
  }

  // ---- errors never crash: bad JSON, refused subscription, failing gap fill, throwing receiver ----
  {
    const { r, sockets } = setup({ fail: true });
    r.start();
    const s = sockets[0]!;
    s.open();
    s.emit('message', 'not json{');
    s.replyError(1, 'logs subscription without address not allowed at https://x.example/KEY');
    assert(!r.healthy() && r.stats().subscribeErrors === 1 && s.closed, 'refused subscription: stays on poll fallback, reconnects later');
    advance(1_000);
    const s2 = sockets[1]!;
    s2.open(); s2.reply(1, '0xz');
    s2.push('0xz', syncLog(A, 10, 0, 1n, 1n));
    advance(5);
    s2.emit('close'); advance(2_000);
    sockets[2]!.open(); sockets[2]!.reply(1, '0xy');
    await tick(); await tick();
    assert(r.healthy(), 'failing gap fill (HTTP down) does not stop the push feed');
    r.stop();
    assert(!r.healthy(), 'stopped: not healthy');

    let threw = false;
    const throwing = new WsBlockReader({
      url: 'wss://example.org/ws', httpRpc: async () => '0x0', poolManager: PM, addresses: () => [A], v4Ids: () => new Set(),
      onUpdates: () => { throw new Error('receiver bug'); },
      connect: () => { throw new Error('Invalid URL'); }, schedule, now: () => clock, autoTick: false, usage: new NodeUsageCounter(() => clock), log: () => {},
    });
    try { throwing.start(); advance(1_000); throwing.stop(); } catch { threw = true; }
    assert(!threw, 'a socket that cannot even be created never throws out of the reader');
  }
}

main().catch((e) => { console.error('FAIL: unexpected error', e); process.exitCode = 1; });
