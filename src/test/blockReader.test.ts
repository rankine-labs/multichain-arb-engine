import {
  parsePoolLogs, latestPerPool, BlockReader, RpcLog, PoolUpdate,
  SYNC_TOPIC, SOLIDLY_SYNC_TOPIC, V3_SWAP_TOPIC, PANCAKE_V3_SWAP_TOPIC, ALGEBRA_INTEGRAL_SWAP_TOPIC, V4_SWAP_TOPIC, HANDLED_TOPICS,
} from '../core/blockReader';
import { ethers } from 'ethers';

// Block reader: reads every block's pool events and turns them into exact pool states.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// ---- helpers to build fake logs ----
const PM = '0x00000000000000000000000000000000000000dd';
const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';
const ID = '0x' + 'cd'.repeat(32);
const ID2 = '0x' + 'ef'.repeat(32);
const q = (n: number) => '0x' + n.toString(16);
// Encode a number (possibly negative) as one 32-byte word, the way the chain does.
const word = (n: bigint) => BigInt.asUintN(256, n).toString(16).padStart(64, '0');
const data = (...ns: bigint[]) => '0x' + ns.map(word).join('');
const T = '0x' + '00'.repeat(12) + '11'.repeat(20);   // an indexed address topic (sender/recipient)
const log = (address: string, topics: string[], d: string, block: number, idx: number, extra: Partial<RpcLog> = {}): RpcLog =>
  ({ address, topics, data: d, blockNumber: q(block), logIndex: q(idx), ...extra });

const SQRT = 79228162514264337593543950336n;   // 2^96, price 1.0
const LIQ = 123456789012345678n;

async function main() {
  // ---- topics ----
  assert(SYNC_TOPIC === ethers.id('Sync(uint112,uint112)'), 'Sync topic is the V2 Sync fingerprint');
  {
    const sol = parsePoolLogs([log(A, [SOLIDLY_SYNC_TOPIC], data(5n, 6n), 10, 1)], PM);
    assert(sol.length === 1 && sol[0].kind === 'v2' && sol[0].reserve0 === 5n && sol[0].reserve1 === 6n, 'Solidly Sync(uint256,uint256) (Ramses V2) parsed as reserves');
    assert(HANDLED_TOPICS.includes(SOLIDLY_SYNC_TOPIC), 'Solidly Sync is requested from the node');
  }
  assert(HANDLED_TOPICS.length === 6 && new Set(HANDLED_TOPICS).size === 6, 'six distinct handled topics (incl. Solidly Sync)');

  // ---- parsing each event type ----
  const sync = parsePoolLogs([log(A.toUpperCase().replace('0X', '0x'), [SYNC_TOPIC], data(1000n, 2000n), 10, 3)], PM);
  assert(sync.length === 1 && sync[0]!.kind === 'v2' && sync[0]!.pool === A && sync[0]!.reserve0 === 1000n && sync[0]!.reserve1 === 2000n
    && sync[0]!.block === 10 && sync[0]!.logIndex === 3, 'V2 Sync -> reserves, lowercase pool, block and index');

  const v3 = parsePoolLogs([log(A, [V3_SWAP_TOPIC, T, T], data(-500n, 700n, SQRT, LIQ, -887220n), 11, 1)], PM);
  assert(v3.length === 1 && v3[0]!.kind === 'v3' && v3[0]!.sqrtPriceX96 === SQRT && v3[0]!.liquidity === LIQ && v3[0]!.tick === -887220,
    'V3 Swap -> price, liquidity and a negative tick decoded correctly');

  const v3pos = parsePoolLogs([log(A, [V3_SWAP_TOPIC, T, T], data(1n, -1n, SQRT, LIQ, 201234n), 11, 2)], PM);
  assert(v3pos[0]!.tick === 201234, 'V3 Swap positive tick');

  const cake = parsePoolLogs([log(B, [PANCAKE_V3_SWAP_TOPIC, T, T], data(-1n, 2n, SQRT * 2n, LIQ, -5n, 9n, 8n), 12, 0)], PM);
  assert(cake.length === 1 && cake[0]!.kind === 'v3' && cake[0]!.pool === B && cake[0]!.sqrtPriceX96 === SQRT * 2n && cake[0]!.tick === -5,
    'PancakeSwap V3 Swap (extra fee fields) -> same first fields');

  const alg = parsePoolLogs([log(B, [ALGEBRA_INTEGRAL_SWAP_TOPIC, T, T], data(3n, -4n, SQRT, 77n, -1n, 500n, 100n), 13, 4)], PM);
  assert(alg.length === 1 && alg[0]!.kind === 'v3' && alg[0]!.liquidity === 77n && alg[0]!.tick === -1,
    'Algebra Integral Swap (overrideFee, pluginFee) -> same first fields, tick -1');

  // ---- V4: only from the PoolManager ----
  const v4Log = log(PM, [V4_SWAP_TOPIC, ID.toUpperCase().replace('0X', '0x'), T], data(-10n, 20n, SQRT, LIQ, -276325n, 3000n), 14, 7);
  const v4 = parsePoolLogs([v4Log], PM.toUpperCase().replace('0X', '0x'));
  assert(v4.length === 1 && v4[0]!.kind === 'v4' && v4[0]!.pool === ID && v4[0]!.tick === -276325 && v4[0]!.sqrtPriceX96 === SQRT && v4[0]!.liquidity === LIQ,
    'V4 Swap from the PoolManager -> pool id from topic 1 (lowercased), negative tick, case-insensitive manager match');
  assert(parsePoolLogs([{ ...v4Log, address: A }], PM).length === 0, 'V4 Swap from a non-PoolManager address is ignored');
  assert(parsePoolLogs([v4Log], '').length === 0, 'V4 Swap ignored when no PoolManager is configured');

  // ---- removed, unknown, malformed ----
  assert(parsePoolLogs([log(A, [SYNC_TOPIC], data(1n, 2n), 10, 0, { removed: true })], PM).length === 0, 'removed logs ignored');
  const v2Swap = ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)');
  assert(parsePoolLogs([log(A, [v2Swap, T, T], data(1n, 2n, 3n, 4n), 10, 0), log(A, [ethers.id('Transfer(address,address,uint256)'), T, T], data(5n), 10, 1)], PM).length === 0,
    'unknown topics (V2 Swap, Transfer) ignored');
  assert(parsePoolLogs([log(A, [V3_SWAP_TOPIC, T, T], data(1n, 2n, 3n), 10, 0), log(A, [SYNC_TOPIC], '0x1234', 10, 1)], PM).length === 0,
    'short or malformed data ignored');
  assert(parsePoolLogs([{ address: A, topics: [SYNC_TOPIC], data: data(1n, 2n), blockNumber: null as any, logIndex: null as any }], PM).length === 0,
    'pending logs (no block yet) ignored');

  // ---- latestPerPool ----
  const u = (pool: string, block: number, logIndex: number, tag: bigint): PoolUpdate => ({ pool, kind: 'v2', block, logIndex, reserve0: tag, reserve1: tag });
  const lp = latestPerPool([u(A, 5, 9, 1n), u(A, 6, 0, 2n), u(A, 6, 3, 3n), u(A, 6, 1, 4n), u(B, 4, 2, 5n), u(B, 4, 1, 6n)]);
  assert(lp.size === 2 && lp.get(A)!.reserve0 === 3n && lp.get(B)!.reserve0 === 5n, 'latestPerPool picks highest block, then highest logIndex');
  assert(latestPerPool([]).size === 0, 'latestPerPool of nothing is empty');

  // ---- pollOnce with a fake node ----
  {
    let head = 1000;
    let clock = 0;
    let logsReply: RpcLog[] = [];
    const calls: { m: string; p: any[] }[] = [];
    const rpc = async (m: string, p: any[]) => {
      calls.push({ m, p });
      if (m === 'eth_blockNumber') return q(head);
      if (m === 'eth_getLogs') { clock += 25; return logsReply; }
      throw new Error('unexpected method ' + m);
    };
    const got: { latest: Map<string, PoolUpdate>; toBlock: number }[] = [];
    const r = new BlockReader({
      rpc, poolManager: PM, addresses: () => [A, B], v4Ids: () => new Set([ID]),
      onUpdates: (latest, toBlock) => got.push({ latest, toBlock }), now: () => clock, headEveryMs: 2000,
    });

    // First poll: reads the head, starts at the head block, nothing to report.
    await r.pollOnce();
    const gl1 = calls.filter((c) => c.m === 'eth_getLogs');
    assert(calls[0]!.m === 'eth_blockNumber' && gl1.length === 1, 'first poll asks for the head, then the logs');
    const f1 = gl1[0]!.p[0];
    assert(f1.fromBlock === q(1000) && f1.toBlock === 'latest', 'first poll reads from the head block to latest');
    assert(JSON.stringify(f1.address) === JSON.stringify([A, B, PM]), 'address filter = watched pools plus PoolManager');
    assert(Array.isArray(f1.topics) && f1.topics.length === 1 && JSON.stringify(f1.topics[0]) === JSON.stringify(HANDLED_TOPICS), 'topics = [[all handled topics]] (OR at position 0)');
    assert(got.length === 0, 'onUpdates not called when there is nothing new');
    assert(r.stats().lastBlock === 1000, 'bookmark advanced to the head after the first poll');

    // Second poll: logs from blocks 1001/1002, including V4 swaps for a watched and an unwatched id.
    logsReply = [
      log(A, [SYNC_TOPIC], data(1n, 1n), 1001, 0),
      log(A, [SYNC_TOPIC], data(9n, 9n), 1002, 4),
      log(B, [V3_SWAP_TOPIC, T, T], data(1n, -1n, SQRT, LIQ, -60n), 1001, 2),
      log(PM, [V4_SWAP_TOPIC, ID, T], data(1n, -1n, SQRT, LIQ, 120n, 500n), 1002, 1),
      log(PM, [V4_SWAP_TOPIC, ID2, T], data(1n, -1n, SQRT, LIQ, 240n, 500n), 1002, 2),
    ];
    clock += 100;   // head not refreshed (less than 2 s later)
    await r.pollOnce();
    const gl2 = calls.filter((c) => c.m === 'eth_getLogs');
    assert(gl2.length === 2 && gl2[1]!.p[0].fromBlock === q(1001), 'second poll reads from last + 1');
    assert(calls.filter((c) => c.m === 'eth_blockNumber').length === 1, 'head not re-fetched within headEveryMs');
    assert(got.length === 1 && got[0]!.toBlock === 1002, 'onUpdates called once, toBlock = newest block seen');
    const L = got[0]!.latest;
    assert(L.size === 3 && L.get(A)!.reserve0 === 9n && L.get(B)!.tick === -60 && L.get(ID)!.tick === 120, 'newest state per pool delivered (V2, V3, watched V4)');
    assert(!L.has(ID2), 'unwatched V4 pool id filtered out');
    assert(r.stats().lastBlock === 1002 && r.stats().updates === 3, 'bookmark moved to max block seen; updates counted');

    // Third poll: the head refreshes after 2 s and the bookmark follows it.
    logsReply = [];
    head = 1050;
    clock += 2500;
    await r.pollOnce();
    const gl3 = calls.filter((c) => c.m === 'eth_getLogs');
    assert(calls.filter((c) => c.m === 'eth_blockNumber').length === 2 && gl3[2]!.p[0].fromBlock === q(1003), 'head refreshed after headEveryMs; reads from last + 1');
    assert(r.stats().lastBlock === 1050 && got.length === 1, 'bookmark advanced to the head; no empty onUpdates call');

    // Fourth poll: far behind -> jump to head - maxRange and count a skipped range.
    head = 1500;
    clock += 2500;
    await r.pollOnce();
    const gl4 = calls.filter((c) => c.m === 'eth_getLogs');
    assert(gl4[3]!.p[0].fromBlock === q(1301) && r.stats().skippedRanges === 1, 'more than maxRange (200) behind -> jump to head - 200, skip counted');

    const s = r.stats();
    assert(s.polls === 4 && s.ok === 4 && s.errors === 0 && s.rateLimited === 0 && s.lastBlock === 1500 && s.lagBlocks === 0 && s.medianMs === 25,
      'stats: polls, ok, errors, rateLimited, lastBlock, lagBlocks, medianMs');
    assert(r.nextDelayMs() === 110, 'normal poll delay is 110 ms');
  }

  // ---- errors and backoff ----
  {
    let mode: 'ok' | '429' | 'boom' | 'ahead' = '429';
    const rpc = async (m: string) => {
      if (m === 'eth_blockNumber') return q(500);
      if (mode === '429') throw new Error('server response 429 Too Many Requests');
      if (mode === 'boom') throw new Error('connection reset');
      if (mode === 'ahead') throw new Error('invalid block range params');
      return [];
    };
    let calledBack = 0;
    const r = new BlockReader({ rpc, poolManager: PM, addresses: () => [A], v4Ids: () => new Set(), onUpdates: () => { calledBack++; } });
    await r.pollOnce();
    assert(r.stats().errors === 1 && r.stats().rateLimited === 1 && r.nextDelayMs() === 1000, '429 -> counted as rate limited, 1 s pause');
    mode = 'boom';
    await r.pollOnce();
    assert(r.stats().errors === 2 && r.stats().rateLimited === 1 && r.nextDelayMs() === 500, 'other error -> 0.5 s pause');
    for (let i = 0; i < 18; i++) await r.pollOnce();
    assert(r.stats().errors === 20 && r.nextDelayMs() === 30_000, '20 errors in a row -> 30 s pause');
    mode = 'ok';
    await r.pollOnce();
    assert(r.stats().ok === 1 && r.nextDelayMs() === 110 && calledBack === 0, 'recovery resets the pause; nothing delivered');
    mode = 'ahead';
    await r.pollOnce();
    assert(r.stats().ok === 2 && r.stats().errors === 20, '"no new block yet" answer is not counted as an error');
  }

  // ---- receiver bug does not break the reader ----
  {
    const rpc = async (m: string) => m === 'eth_blockNumber' ? q(10) : [log(A, [SYNC_TOPIC], data(1n, 2n), 10, 0)];
    const r = new BlockReader({ rpc, poolManager: PM, addresses: () => [A], v4Ids: () => new Set(), onUpdates: () => { throw new Error('receiver bug'); } });
    const origErr = console.error; console.error = () => {};
    await r.pollOnce();
    console.error = origErr;
    assert(r.stats().ok === 1 && r.stats().errors === 0 && r.stats().lastBlock === 10, 'onUpdates throwing does not count as a node error');
  }

  // ---- nothing to watch: never sends an address-less request ----
  {
    const methods: string[] = [];
    const rpc = async (m: string) => { methods.push(m); return m === 'eth_blockNumber' ? q(10) : []; };
    const r = new BlockReader({ rpc, poolManager: '', addresses: () => [], v4Ids: () => new Set(), onUpdates: () => {} });
    await r.pollOnce();
    assert(!methods.includes('eth_getLogs'), 'no pools and no PoolManager -> no eth_getLogs request');
  }

  // ---- start/stop loop runs without overlapping ----
  {
    let inFlight = 0, maxInFlight = 0, n = 0;
    const rpc = async (m: string) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); n++;
      await new Promise((res) => setTimeout(res, 5));
      inFlight--;
      return m === 'eth_blockNumber' ? q(100) : [];
    };
    const r = new BlockReader({ rpc, poolManager: PM, addresses: () => [A], v4Ids: () => new Set(), onUpdates: () => {}, pollMs: 1 });
    r.start();
    await new Promise((res) => setTimeout(res, 80));
    r.stop();
    const polls = r.stats().polls;
    await new Promise((res) => setTimeout(res, 30));
    assert(polls >= 2 && maxInFlight === 1 && r.stats().polls <= polls + 1, 'loop polls repeatedly, never overlapping, and stops');
  }
  // ---- review fixes (Oct 11) ----
  {
    // Batch: head and events from the same answer; local filtering; no address list sent.
    let sentFilter: any = null, singles = 0;
    let head = 200;
    const rpcBatch = async (calls: Array<{ method: string; params: unknown[] }>) => {
      sentFilter = calls[1].params[0];
      return [q(head), [log(A, [SYNC_TOPIC], data(7n, 8n), head, 0), log(B, [SYNC_TOPIC], data(1n, 1n), head, 1)]];
    };
    const rpc = async (m: string) => { singles++; return m === 'eth_blockNumber' ? q(head - 1) : []; };
    const got: Map<string, PoolUpdate>[] = [];
    const r = new BlockReader({ rpc, rpcBatch, localFilter: true, poolManager: PM, addresses: () => [A], v4Ids: () => new Set(), onUpdates: (m) => got.push(m) });
    await r.pollOnce();   // first poll learns the head
    head = 205;
    await r.pollOnce();
    assert(sentFilter && sentFilter.address === undefined, 'local filter: our address list is not sent');
    assert(got.length >= 1 && got[got.length - 1].has(A) && !got[got.length - 1].has(B), 'local filter: only our pools kept');
    assert(r.stats().lastBlock === 205, 'batch: bookmark moves to the same server’s newest block');
  }
  {
    // Ahead of the server's head: bookmark stays put.
    let calls = 0;
    const rpc = async (m: string) => {
      if (m === 'eth_blockNumber') return q(300);
      calls++;
      throw new Error('invalid block range');
    };
    const r = new BlockReader({ rpc, poolManager: PM, addresses: () => [A], v4Ids: () => new Set(), onUpdates: () => {}, headEveryMs: 0 });
    await r.pollOnce();
    const b = r.stats().lastBlock;
    await r.pollOnce();
    assert(calls >= 2 && r.stats().lastBlock === b, 'server behind: bookmark not moved past unread blocks');
  }
  {
    // Paused while the node rests: no requests.
    let n = 0;
    const r = new BlockReader({ rpc: async () => { n++; return q(1); }, poolManager: PM, addresses: () => [A], v4Ids: () => new Set(), onUpdates: () => {}, paused: () => true });
    await r.pollOnce();
    assert(n === 0 && r.stats().pausedPolls === 1 && r.nextDelayMs() === 1000, 'paused: no requests, waits 1 s');
  }
  {
    // 429s in a row: 1 s, 2 s, 4 s.
    const r = new BlockReader({ rpc: async () => { throw new Error('HTTP 429'); }, poolManager: PM, addresses: () => [A], v4Ids: () => new Set(), onUpdates: () => {} });
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) { await r.pollOnce(); waits.push(r.nextDelayMs()); }
    assert(waits.join(',') === '1000,2000,4000', `rate limited in a row: pause doubles (got ${waits.join(',')})`);
  }
}

main().catch((e) => { console.error('FAIL: unexpected error', e); process.exitCode = 1; });
