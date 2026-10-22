import { EventEmitter } from 'events';
import { Copy2Link, Copy2Forwarder, Copy2Index, FeedBlockTimes, copy2Settings, TRANSFER_TOPIC } from '../execution/copy2';
import { WsBlockReader, SocketLike } from '../core/blockReaderWs';
import { SYNC_TOPIC } from '../core/blockReader';
import { NodeUsageCounter } from '../core/nodeUsage';
import type { PoolState } from '../core/types';

// ============================================================================
// COPY 2 LIVE-FEED SOAK (the Oct 22 07:36 UTC live failure, reproduced)
//
// Plain English:
//   On the live server the fast check's copy was told "a message was lost,
//   reload every pool" every 2-25 seconds, so it never became usable. The
//   dry runs never saw it: the checker has no WebSocket renewals and gets
//   block times from block headers.
//
//   This test drives the REAL bot pieces end to end, with a fake chain and a
//   fake clock (no network):
//     - core/blockReaderWs.ts (the WebSocket reader + its copy-2 tap), whose
//       subscription is RENEWED every 5-20 s (watch list changes), with a
//       short hole while the new subscription comes up;
//     - execution/copy2.ts (Copy2Link + Copy2Forwarder + FeedBlockTimes) and
//       execution/copy2Blocks.ts (the shared block assembler), headerless
//       (the bot's default, COPY2_HEADERS=off);
//     - a sequencer feed whose block times usually arrive before the pool
//       reports, sometimes AFTER them (up to 150 ms), and for a few blocks
//       never at all;
//     - a free HTTP node (BLOCK_READER_RPC) that lags the WebSocket node by
//       0-300 ms (eth_blockNumber a few blocks behind, getLogs only up to
//       what it has).
//   A fake arbsim applies exactly arbsim's lost-message rule
//   (sim/src/copy2/intake.rs process(): prevBlock >= first block received
//   and never received -> reload every pool) and checks that every report
//   of the followed pools arrived exactly once, with the block's TRUE time.
//
//   Pass = zero forced reloads after the first message (no report was ever
//   really lost: every hole is fillable from the node), and nothing missing.
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// ---- fake clock + scheduler -------------------------------------------------
let clock = 2_000_000;
type Job = { at: number; fn: () => void; cancelled: boolean };
let jobs: Job[] = [];
const schedule = (fn: () => void, ms: number) => { const j = { at: clock + Math.max(0, ms), fn, cancelled: false }; jobs.push(j); return () => { j.cancelled = true; }; };
function runDue() {
  for (;;) {
    let due: Job | null = null;
    for (const j of jobs) if (!j.cancelled && j.at <= clock && (!due || j.at < due.at)) due = j;
    if (!due) break;
    due.cancelled = true;
    due.fn();
  }
  jobs = jobs.filter((j) => !j.cancelled);
}
const flush = () => new Promise((r) => setImmediate(r));

// ---- seeded random (same run every time) -------------------------------------
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---- addresses ---------------------------------------------------------------
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const WETH = '0x00000000000000000000000000000000000000e1';
const USDG = '0x00000000000000000000000000000000000000c2';
const MEME = '0x00000000000000000000000000000000000000b3';
const P1 = '0x00000000000000000000000000000000000000a1';
const P2 = '0x00000000000000000000000000000000000000a2';
const OTHER = '0x00000000000000000000000000000000000000f9'; // a watched pool copy 2 doesn't follow (toggled to force renewals)
const STRANGER = '0x00000000000000000000000000000000000000f8';
const q = (n: number) => '0x' + n.toString(16);
const pad = (a: string) => '0x' + '0'.repeat(24) + a.slice(2);
const word = (n: number) => n.toString(16).padStart(64, '0');

const poolState = (o: Partial<PoolState>): PoolState => ({
  chain: 'robinhood', dex: 'uniswap-v2', poolAddress: P1, poolType: 'v2', tokenA: WETH, tokenB: USDG,
  feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: 1, ...o,
} as PoolState);

class FakeSocket extends EventEmitter implements SocketLike {
  sent: any[] = [];
  closed = false;
  constructor(readonly gen: number) { super(); }
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.closed = true; }
  terminate() { this.closed = true; }
  ping() { /* */ }
  push(sub: string, result: unknown) { this.emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: sub, result } })); }
}

type ChainLog = { address: string; topics: string[]; data: string; blockNumber: string; transactionIndex: string; logIndex: string; transactionHash: string; blockTimestamp?: string };

type Scenario = {
  name: string;
  seed: number;
  seconds: number;
  wsTimestamps: boolean;        // the WebSocket's logs carry blockTimestamp (Chainstack does)
  feedLateEvery: number;        // 1 in N blocks: feed time arrives 60-150 ms AFTER the reports
  feedMissingEvery: number;     // 1 in N blocks: the feed never gives this block's time (0 = never)
  renewMinS: number; renewMaxS: number;
  httpLagMaxMs: number;         // the free node is up to this far behind the WebSocket node
};

async function soak(sc: Scenario): Promise<{ forced: number; reasons: Record<string, number>; missing: number; wrongTime: number; outOfOrder: number; delivered: number; renewals: number; timeReads: number; fwd: Record<string, unknown>; statusLine: string; hour: string }> {
  const rand = rng(sc.seed);
  const BLOCK_MS = 100;
  const N0 = 94_944_000;
  const start = clock;
  const produced = (n: number) => start + (n - N0) * BLOCK_MS;           // sequencer makes block n
  const tsOf = (n: number) => 1_761_100_000 + Math.floor((n - N0) / 4); // Robinhood: whole seconds
  const l1Of = (n: number) => 23_600_000 + Math.floor((n - N0) / 120);
  const lastBlock = N0 + Math.floor(sc.seconds * 1000 / BLOCK_MS);

  // ---- the chain: our pools' reports per block ----
  const chain = new Map<number, ChainLog[]>();
  const wsDelay = new Map<number, number>();
  const feedDelay = new Map<number, number | null>();
  const httpDelay = new Map<number, number>();
  for (let n = N0; n <= lastBlock; n++) {
    const logs: ChainLog[] = [];
    if (rand() < 0.35) {
      // A swap on P1 or P2 (+ the coin transfers it causes), sometimes a transfer between our pools.
      const k = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < k; i++) {
        const tx = '0x' + (n.toString(16) + i.toString(16).padStart(2, '0')).padStart(64, '0');
        const p = rand() < 0.5 ? P1 : P2;
        const ti = q(i);
        logs.push({ address: rand() < 0.5 ? WETH : (p === P1 ? USDG : MEME), topics: [TRANSFER_TOPIC, pad(STRANGER), pad(p)], data: '0x' + word(1000 + i), blockNumber: q(n), transactionIndex: ti, logIndex: q(i * 4), transactionHash: tx });
        if (rand() < 0.3) logs.push({ address: WETH, topics: [TRANSFER_TOPIC, pad(P1), pad(P2)], data: '0x' + word(7), blockNumber: q(n), transactionIndex: ti, logIndex: q(i * 4 + 1), transactionHash: tx });
        logs.push({ address: p, topics: [SYNC_TOPIC], data: '0x' + word(10 ** 6 + n % 1000) + word(2 * 10 ** 6 + i), blockNumber: q(n), transactionIndex: ti, logIndex: q(i * 4 + 2), transactionHash: tx });
      }
    }
    chain.set(n, logs);
    wsDelay.set(n, 25 + Math.floor(rand() * 40));                       // node pushes 25-65 ms after the block
    const late = sc.feedLateEvery > 0 && rand() < 1 / sc.feedLateEvery;
    const missing = sc.feedMissingEvery > 0 && rand() < 1 / sc.feedMissingEvery;
    feedDelay.set(n, missing ? null : late ? 60 + Math.floor(wsDelay.get(n)! + rand() * 90) : Math.floor(rand() * 15));
    httpDelay.set(n, wsDelay.get(n)! + Math.floor(rand() * sc.httpLagMaxMs));
  }
  const expectedLogs = (from: number, to: number) => { let k = 0; for (let n = from; n <= to; n++) k += chain.get(n)!.length; return k; };

  // ---- the free HTTP node (lags the WebSocket node) ----
  let timeReads = 0;
  const httpHead = () => { let h = -1; for (let n = N0; n <= lastBlock; n++) { if (produced(n) + httpDelay.get(n)! <= clock) h = n; else break; } return h; };
  const match = (l: ChainLog, f: any): boolean => {
    const addrs: string[] | null = f.address ? (Array.isArray(f.address) ? f.address : [f.address]).map((a: string) => a.toLowerCase()) : null;
    if (addrs && !addrs.includes(l.address)) return false;
    const ts: any[] = f.topics ?? [];
    for (let i = 0; i < ts.length; i++) {
      if (ts[i] === null || ts[i] === undefined) continue;
      const want = (Array.isArray(ts[i]) ? ts[i] : [ts[i]]).map((x: string) => x.toLowerCase());
      if (!l.topics[i] || !want.includes(l.topics[i]!.toLowerCase())) return false;
    }
    return true;
  };
  const rpc = (method: string, params: unknown[]): Promise<any> => new Promise((resolve) => {
    // Each answer takes 15-40 ms.
    schedule(() => {
      const head = httpHead();
      if (method === 'eth_blockNumber') return resolve(q(head));
      if (method === 'eth_getBlockByNumber') {
        timeReads++;
        const b = Number(BigInt((params as any[])[0]));
        return resolve(b <= head ? { number: q(b), timestamp: q(tsOf(b)), l1BlockNumber: q(l1Of(b)), logsBloom: '0x' + '0'.repeat(512) } : null);
      }
      if (method === 'eth_getLogs') {
        const f = (params as any[])[0];
        const from = Number(BigInt(f.fromBlock)), to = Math.min(Number(BigInt(f.toBlock)), head);
        const out: ChainLog[] = [];
        // The free node does not add blockTimestamp (only Chainstack does).
        for (let n = from; n <= to; n++) for (const l of chain.get(n) ?? []) if (match(l, f)) out.push({ ...l });
        return resolve(out);
      }
      resolve(null);
    }, 15 + Math.floor(rand() * 25));
  });

  // ---- the bot side: Copy2Link + the WebSocket reader with its tap ----
  const oneWay: any[] = [];
  const client = {
    isConnected: () => true,
    sendOneWay: (m: Record<string, unknown>) => { oneWay.push(JSON.parse(JSON.stringify(m))); return true; },
    request: async (m: Record<string, unknown>) => ({ id: 1, ok: true, ...(m.type === 'status' ? { source: 'pool-events' } : {}) }),
  };
  const pools = [poolState({ poolAddress: P1 }), poolState({ poolAddress: P2, tokenA: MEME, tokenB: WETH })];
  const logLines: string[] = [];
  const link = new Copy2Link({ client: client as any, settings: copy2Settings({}), pools: () => pools, poolManager: PM, now: () => clock, schedule, autoTimers: false, log: (m) => logLines.push(m) });
  link.setBackfillRpc(rpc);
  link.applyStatus({ ok: true, source: 'pool-events', copy2: { pools: {} } });
  let withOther = false;   // toggled to change the watch list (forces a renewal)
  const sockets: FakeSocket[] = [];
  let live: FakeSocket | null = null;   // the socket whose subscriptions are confirmed
  const reader = new WsBlockReader({
    url: 'wss://example.invalid/KEY', httpRpc: rpc, poolManager: PM,
    addresses: () => (withOther ? [P1, P2, OTHER] : [P1, P2]), v4Ids: () => new Set<string>(),
    onUpdates: () => {},
    connect: () => {
      const s = new FakeSocket(sockets.length);
      sockets.push(s);
      // Opens 30-60 ms later; the node confirms the subscriptions 20-60 ms after that.
      schedule(() => {
        if (s.closed) return;
        s.emit('open');
        schedule(() => {
          if (s.closed) return;
          for (const m of s.sent) s.emit('message', JSON.stringify({ jsonrpc: '2.0', id: m.id, result: `0x${s.gen}s${m.id}` }));
          live = s;
        }, 20 + Math.floor(rand() * 40));
      }, 30 + Math.floor(rand() * 30));
      return s;
    },
    schedule, now: () => clock, autoTick: false, resubscribeMs: 1_000, usage: new NodeUsageCounter(() => clock), log: (m) => logLines.push(m),
    rawLogTap: link.tap,
  });
  reader.start();

  // ---- the fake arbsim: its lost-message rule + what it received ----
  const received = new Set<number>();
  let firstReceived = -1;
  const got = new Map<number, Map<string, any>>();
  let forced = 0, outOfOrder = 0, wrongTime = 0, lastOnTime = -1, msgs = 0;
  const arbsim = (m: any) => {
    msgs++;
    if (m.timestamp !== tsOf(m.block)) wrongTime++;
    if (!m.late) {
      if (m.prevBlock !== undefined && firstReceived >= 0 && m.prevBlock >= firstReceived && !received.has(m.prevBlock)) forced++;
      if (m.block <= lastOnTime) outOfOrder++;
      lastOnTime = m.block;
      received.add(m.block);
      if (firstReceived < 0) firstReceived = m.block;
    }
    for (const l of m.logs ?? []) {
      const k = `${l.transactionHash}:${Number(BigInt(l.logIndex))}`;
      (got.get(m.block) ?? got.set(m.block, new Map()).get(m.block)!).set(k, l);
    }
  };

  // ---- run: 1 ms steps ----
  let nextRenew = clock + (sc.renewMinS + rand() * (sc.renewMaxS - sc.renewMinS)) * 1000;
  let renewals = 0;
  const pushQ: Array<{ at: number; n: number }> = [];
  const feedQ: Array<{ at: number; n: number }> = [];
  for (let n = N0; n <= lastBlock; n++) {
    pushQ.push({ at: produced(n) + wsDelay.get(n)!, n });
    const fd = feedDelay.get(n);
    if (fd !== null && fd !== undefined) feedQ.push({ at: produced(n) + fd, n });
  }
  pushQ.sort((a, b) => a.at - b.at); feedQ.sort((a, b) => a.at - b.at);
  let pi = 0, fi = 0, ai = 0;
  const end = produced(lastBlock) + 3_000;
  while (clock < end) {
    clock += 1;
    // Sequencer feed frame(s).
    while (fi < feedQ.length && feedQ[fi]!.at <= clock) {
      const n = feedQ[fi++]!.n;
      link.noteFeed(JSON.stringify({ version: 1, messages: [{ sequenceNumber: n, message: { message: { header: { kind: 3, sender: '0xa4b000000000000000000073657175656e636572', blockNumber: l1Of(n), timestamp: tsOf(n), requestId: null, baseFeeL1: null }, l2Msg: 'AA==' }, delayedMessagesRead: 1 }, signature: null }] }));
    }
    // The node pushes each block's reports once it has processed it, to the
    // subscriptions live at that moment (a hole while a renewal comes up).
    while (pi < pushQ.length && pushQ[pi]!.at <= clock) {
      const n = pushQ[pi++]!.n;
      const s = live as FakeSocket | null;
      if (!s || s.closed) continue;
      for (const l of chain.get(n)!) {
        const out = sc.wsTimestamps ? { ...l, blockTimestamp: q(tsOf(n)) } : { ...l };
        const isXfer = l.topics[0] === TRANSFER_TOPIC;
        if (!isXfer) s.push(`0x${s.gen}s1`, out);
        else {
          if ([P1, P2].includes('0x' + l.topics[1]!.slice(26))) s.push(`0x${s.gen}s4`, out);
          if ([P1, P2].includes('0x' + l.topics[2]!.slice(26))) s.push(`0x${s.gen}s5`, out);
        }
      }
    }
    // Renewal: the watch list changes, the reader renews its subscription.
    if (clock >= nextRenew) {
      withOther = !withOther;
      live = null;
      reader.tick();
      renewals++;
      nextRenew = clock + (sc.renewMinS + rand() * (sc.renewMaxS - sc.renewMinS)) * 1000;
    } else if (clock % 1000 === 0) reader.tick();
    runDue();
    await flush();
    runDue();
    while (ai < oneWay.length) arbsim(oneWay[ai++]);
  }
  // Every report of the followed pools from the first block passed on.
  let missing = 0, delivered = 0;
  for (let n = firstReceived; n <= lastBlock - 5; n++) {
    for (const l of chain.get(n)!) {
      const k = `${l.transactionHash}:${Number(BigInt(l.logIndex))}`;
      if (!got.get(n)?.has(k)) missing++; else delivered++;
    }
  }
  void expectedLogs; void msgs;
  const fwd = link.forwarder.counts as unknown as Record<string, unknown>;
  const reasons = ((link.forwarder as any).reloadReasons ?? {}) as Record<string, number>;
  const hour = link.hourText() ?? '';
  const statusLine = logLines.filter((x) => x.startsWith('[copy2]')).slice(-1)[0] ?? '';
  reader.stop(); link.stop();
  jobs = [];
  return { forced, reasons, missing, wrongTime, outOfOrder, delivered, renewals, timeReads, fwd, statusLine, hour };
}


// ---- focused proofs (one cause each) -----------------------------------------
const L = (address: string, block: number, li: number, extra: Record<string, unknown> = {}) =>
  ({ address, topics: [SYNC_TOPIC], data: '0x', blockNumber: q(block), transactionIndex: q(0), logIndex: q(li), transactionHash: '0x' + block.toString(16).padStart(64, '0'), ...extra });
async function settle(ms: number, rounds: number) { for (let i = 0; i < rounds; i++) { await flush(); clock += ms; runDue(); } }

async function unitTests() {
  const index: Copy2Index = { pools: new Set([P1, P2]), ids: new Set<string>(), poolManager: PM, coins: new Set([WETH, USDG, MEME]), poolCoins: new Map([[P1, [WETH, USDG]], [P2, [MEME, WETH]]]) };
  const make = (rpc: ((m: string, p: unknown[]) => Promise<any>) | null, times: FeedBlockTimes, extra: Record<string, unknown> = {}) => {
    const sent: any[] = [];
    const f = new Copy2Forwarder({ send: (m) => { sent.push(JSON.parse(JSON.stringify(m))); return true; }, index: () => index, backfillRpc: () => rpc,
      blockTime: (b) => times.get(b), feedNewest: () => times.newestNote(), now: () => clock, schedule, headers: false, ...extra });
    return { f, sent };
  };
  // (a) Root cause 1: the report's own blockTimestamp was thrown away, so a
  //     block whose feed message came >70 ms after its reports was skipped
  //     and the copy reloaded.
  {
    const times = new FeedBlockTimes(0, 1024, () => clock);
    const calls: string[] = [];
    const { f, sent } = make(async (m) => { calls.push(m); return null; }, times);
    f.onLive(); f.setActive(true);
    times.set(99, 1_761_000_000, 1);
    f.onLogs([L(P1, 99, 0)]); clock += 40; runDue();
    f.onLogs([L(P1, 100, 0, { blockTimestamp: q(1_761_000_001) })]);   // the feed has not told us block 100 yet
    clock += 200; runDue(); await settle(10, 3);
    const m = sent.find((x) => x.block === 100);
    assert(!!m && m.timestamp === 1_761_000_001 && !m.gap && m.prevBlock === 99 && f.forcedReloads() === 0 && !calls.includes('eth_getBlockByNumber'),
      'proof/blockTimestamp: feed time late -> block sent with the report\'s own blockTimestamp, no reload, no node read');
    f.setActive(false);
  }
  // (b) Root cause 2: a renewal's hole read back from a free node that lags.
  //     Old code: node head < first missed block -> "nothing missed" (reports
  //     silently lost), or node head < first block heard live -> reload.
  {
    const times = new FeedBlockTimes(0, 1024, () => clock);
    let nodeHead = 199;          // the free node, 3 blocks behind
    const chainLogs = new Map<number, any[]>([[201, [L(P2, 201, 0)]], [202, [L(P1, 202, 0)]]]);
    const rpc = (m: string, p: unknown[]) => new Promise<any>((res) => schedule(() => {
      if (m === 'eth_blockNumber') return res(q(nodeHead));
      if (m === 'eth_getLogs') { const f0 = (p as any[])[0]; const out: any[] = []; for (let b = Number(BigInt(f0.fromBlock)); b <= Math.min(nodeHead, Number(BigInt(f0.toBlock))); b++) for (const l of chainLogs.get(b) ?? []) if (!f0.topics && f0.address.includes(l.address)) out.push(l); return res(out); }
      res(null);
    }, 20));
    const { f, sent } = make(rpc, times);
    f.onLive(); f.setActive(true);
    for (let b = 195; b <= 205; b++) times.set(b, 1_761_000_000 + b, 1);
    f.onLogs([L(P1, 200, 0)]); clock += 40; runDue();
    assert(sent.length === 1 && sent[0].block === 200, 'proof/fill-in: block 200 passed on before the renewal');
    f.onDown();                                  // renewal: blocks 201, 202 happen in the hole
    clock += 120; runDue();
    f.onLive();                                  // feed newest = 205 at this moment
    times.set(206, 1_761_000_206, 1);
    f.onLogs([L(P1, 206, 0)]);                   // first live report after the renewal
    await settle(20, 5);
    assert(sent.length === 1 && f.counts.fillWaits === 1, 'proof/fill-in: free node behind the missed blocks -> waits (does not treat it as "nothing missed")');
    nodeHead = 206; await settle(50, 12); clock += 50; runDue();
    const blocks = sent.map((x) => x.block);
    assert(JSON.stringify(blocks) === JSON.stringify([200, 201, 202, 206]) && sent.slice(1).every((x) => !x.gap) && sent[1].prevBlock === 200 && sent[3].prevBlock === 202 && f.forcedReloads() === 0,
      `proof/fill-in: once the node has them, the missed blocks go out in order, chained, no reload (got ${blocks})`);
    // Node never catches up within COPY2_FILL_WAIT_MS: reload, with its reason.
    f.onDown(); clock += 100; runDue();
    for (let b = 206; b <= 241; b++) times.set(b, 1_761_000_000 + b, 1);
    f.onLive();                                  // feed is at 241, the free node stays at 206
    await settle(20, 3);
    f.onDown(); f.onLive();                      // renewal again while filling: same start block (no reload for that)
    await settle(100, 40);
    f.onLogs([L(P1, 241, 0)]); clock += 40; runDue(); await settle(10, 3);
    const lastMsg = sent.find((x) => x.block > 206 && x.gap) ?? {};
    assert(lastMsg.block === 241 && sent.filter((x) => x.gap).length === 2 && lastMsg.gapReason === 'outage not filled in (HTTP node behind)' && f.reloadReasons['outage not filled in (HTTP node behind)'] === 1,
      'proof/fill-in: node still behind after 3 s -> the copy reloads (an unrecoverable hole), reason counted');
    f.setActive(false);
  }
  // (c) Block time from nowhere (feed message lost, no blockTimestamp): one
  //     eth_getBlockByNumber on the free node, never a guess; budgeted.
  {
    const times = new FeedBlockTimes(0, 1024, () => clock);
    let reads = 0;
    const rpc = (m: string, p: unknown[]) => new Promise<any>((res) => schedule(() => {
      if (m === 'eth_getBlockByNumber') { reads++; const b = Number(BigInt((p as any[])[0])); return res({ number: q(b), timestamp: q(1_761_000_000 + b), l1BlockNumber: q(77) }); }
      res(null);
    }, 20));
    const { f, sent } = make(rpc, times, { timeReadsPerMin: 2 });
    f.onLive(); f.setActive(true);
    times.set(300, 1_761_000_300, 77);
    f.onLogs([L(P1, 300, 0)]); clock += 40; runDue();
    for (const b of [301, 302, 303]) { f.onLogs([L(P1, b, 0)]); clock += 100; runDue(); await settle(10, 6); }
    const got = sent.map((x) => `${x.block}:${x.timestamp === 1_761_000_000 + x.block ? 'true' : x.timestamp}`);
    assert(sent.some((x) => x.block === 301 && x.timestamp === 1_761_000_301 && x.l1Block === 77 && !x.gap) && sent.some((x) => x.block === 302 && !x.gap) && reads === 2,
      `proof/time-read: unknown block times read from the node (true time, its L1 block), no reload (${got})`);
    assert(!sent.some((x) => x.block === 303) && f.reloadReasons['block time unknown'] === undefined && f.counts.noTimestamp === 1,
      'proof/time-read: past the per-minute budget -> block not sent (never guessed); the next message reloads');
    f.setActive(false);
  }
}

async function main() {
  await unitTests();
  // 1) The live shape: renewals every 5-20 s filled in from a lagging free
  //    node, feed times sometimes after the reports, Chainstack's
  //    blockTimestamp on the pushed reports.
  {
    const r = await soak({ name: 'live', seed: 22, seconds: 120, wsTimestamps: true, feedLateEvery: 15, feedMissingEvery: 0, renewMinS: 5, renewMaxS: 20, httpLagMaxMs: 300 });
    console.log(`  counts ${JSON.stringify(r.fwd)}`);
    console.log(`  live shape: renewals ${r.renewals}, forced reloads ${r.forced} ${JSON.stringify(r.reasons)}, reports delivered ${r.delivered}, missing ${r.missing}, wrong time ${r.wrongTime}, out of order ${r.outOfOrder}, time reads ${r.timeReads}`);
    assert(r.renewals >= 6, `soak ran with subscription renewals every 5-20 s (${r.renewals})`);
    assert(r.forced === 0, `soak/live: zero forced reloads when no report was really lost (got ${r.forced} ${JSON.stringify(r.reasons)})`);
    assert(r.missing === 0 && r.delivered > 500, `soak/live: every report of the followed pools passed on (missing ${r.missing} of ${r.delivered + r.missing})`);
    assert(r.wrongTime === 0, `soak/live: every message carries the block's true time (never guessed; wrong ${r.wrongTime})`);
    assert(r.outOfOrder === 0, 'soak/live: blocks passed on in increasing order');
  }
  // 2) Harder: no blockTimestamp on the pushed reports, some feed times never
  //    arrive (those blocks' times are read from the free node, at most
  //    occasionally), same renewals.
  {
    const r = await soak({ name: 'no-ts', seed: 7, seconds: 120, wsTimestamps: false, feedLateEvery: 10, feedMissingEvery: 60, renewMinS: 5, renewMaxS: 20, httpLagMaxMs: 300 });
    console.log(`  counts ${JSON.stringify(r.fwd)}`);
    console.log(`  no blockTimestamp: renewals ${r.renewals}, forced reloads ${r.forced} ${JSON.stringify(r.reasons)}, reports delivered ${r.delivered}, missing ${r.missing}, wrong time ${r.wrongTime}, time reads ${r.timeReads}`);
    assert(r.forced === 0, `soak/no-blockTimestamp: zero forced reloads (block times read from the node when the feed has none; got ${r.forced} ${JSON.stringify(r.reasons)})`);
    assert(r.missing === 0 && r.wrongTime === 0 && r.outOfOrder === 0, `soak/no-blockTimestamp: nothing missing, true times, in order (missing ${r.missing}, wrong ${r.wrongTime})`);
    assert(r.timeReads > 0 && r.timeReads < 120, `soak/no-blockTimestamp: block-time reads from the node only occasionally (${r.timeReads} in 120 s)`);
  }
}
main().catch((e) => { console.error('FAIL: crashed', e); process.exitCode = 1; });
