import { EventEmitter } from 'events';
import { tmpdir } from 'os';
import { join } from 'path';
import { AbiCoder, keccak256 } from 'ethers';
import {
  copy2PoolOf, buildTrackList, transferFilterOf, coveredPools, FeedBlockTimes, Copy2Forwarder, Copy2Index,
  parseCopy2Status, Copy2Link, copy2Settings, TRANSFER_TOPIC, ZERO_ADDR, Copy2Pool,
} from '../execution/copy2';
import { WsBlockReader, SocketLike } from '../core/blockReaderWs';
import { SYNC_TOPIC, V4_SWAP_TOPIC, RpcLog } from '../core/blockReader';
import { NodeUsageCounter } from '../core/nodeUsage';
import { LocalSimHost, createLocalSimHost } from '../execution/localSimHost';
import { BlockAssembler, blockMessage, headFromNewHeads } from '../execution/copy2Blocks';
import type { PoolState } from '../core/types';

// COPY 2, bot side (execution/copy2.ts + the WebSocket tap + the host):
// which pools are followed and as what type, per-block pool reports passed on
// in order (with gaps never silent), block times from the feed, readiness
// from the status answer, and the routing rule "fast check only when every
// pool on the route is ready". Fake clock, fake sockets: no network.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// ---- fake clock + scheduler -------------------------------------------------
let clock = 1_000_000;
type Job = { at: number; fn: () => void; cancelled: boolean };
let jobs: Job[] = [];
const schedule = (fn: () => void, ms: number) => { const j = { at: clock + ms, fn, cancelled: false }; jobs.push(j); return () => { j.cancelled = true; }; };
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

// ---- addresses ---------------------------------------------------------------
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const WETH = '0x00000000000000000000000000000000000000e1';
const USDG = '0x00000000000000000000000000000000000000c2';
const MEME = '0x00000000000000000000000000000000000000b3';
const P1 = '0x00000000000000000000000000000000000000a1';
const P2 = '0x00000000000000000000000000000000000000a2';
const P3 = '0x00000000000000000000000000000000000000a3';
const STRANGER = '0x00000000000000000000000000000000000000f9';
const q = (n: number) => '0x' + n.toString(16);
const pad = (a: string) => '0x' + '0'.repeat(24) + a.slice(2);

const v4Id = (c0: string, c1: string, fee: number, ts: number, hooks = ZERO_ADDR) =>
  keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24', 'int24', 'address'], [c0, c1, fee, ts, hooks])).toLowerCase();

const pool = (o: Partial<PoolState>): PoolState => ({
  chain: 'robinhood', dex: 'uniswap-v2', poolAddress: P1, poolType: 'v2', tokenA: WETH, tokenB: USDG,
  feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: 1, ...o,
} as PoolState);

// =============================================================================
function mappingTests() {
  const k = (p: PoolState, skip?: Set<string>) => copy2PoolOf(p, PM, skip);
  // V2 / Solidly / V3 / Pancake / Algebra
  const v2 = k(pool({ tokenA: USDG, tokenB: WETH }));
  assert('kind' in v2 && v2.kind === 'V2' && v2.token0 === USDG && v2.token1 === WETH && v2.fee === 0 && v2.tickSpacing === 0, 'Uniswap V2 -> V2, token0 is the smaller address');
  assert('kind' in k(pool({ dex: 'pancakeswap-v2' })) && (k(pool({ dex: 'pancakeswap-v2' })) as Copy2Pool).kind === 'V2', 'PancakeSwap V2 -> V2');
  assert((k(pool({ dex: 'ramses-v2' })) as Copy2Pool).kind === 'Solidly', 'Ramses V2 -> Solidly');
  assert((k(pool({ dex: 'giga-classic' })) as Copy2Pool).kind === 'Solidly', 'GIGA Classic (venue model solidly) -> Solidly');
  assert((k(pool({ dex: 'uniswap-v3', poolType: 'v3' })) as Copy2Pool).kind === 'V3', 'Uniswap V3 -> V3');
  assert((k(pool({ dex: 'sushiswap-v3', poolType: 'v3' })) as Copy2Pool).kind === 'V3', 'SushiSwap V3 (venue model uniswap-v3) -> V3');
  assert((k(pool({ dex: 'pancakeswap-v3', poolType: 'v3' })) as Copy2Pool).kind === 'PancakeV3', 'PancakeSwap V3 -> PancakeV3');
  assert((k(pool({ dex: 'giga-cl', poolType: 'v3' })) as Copy2Pool).kind === 'PancakeV3', 'GIGA CL (venue model pancake-v3) -> PancakeV3');
  assert((k(pool({ dex: 'alandale', poolType: 'v3', variant: 'algebra' })) as Copy2Pool).kind === 'Algebra', 'Alandale (Algebra) -> Algebra');
  // Not followed
  assert('skip' in k(pool({ dex: 'ramses-v3', poolType: 'v3' })), 'Ramses V3: not followed');
  assert('skip' in k(pool({ dex: 'up-cl', poolType: 'v3' })), 'Slipstream copy: not followed');
  assert('skip' in k(pool({ dex: 'kuru', poolType: 'orderbook' })), 'order book: not followed');
  assert('skip' in k(pool({ dex: 'made-up-dex' })), 'unknown exchange: not followed');
  assert('skip' in k(pool({ dex: 'alandale', poolType: 'v3' })), 'Algebra exchange but pool not marked algebra: not followed');
  assert('skip' in k(pool({ dex: 'uniswap-v3', poolType: 'v2' })), 'shape mismatch: not followed');
  assert('skip' in k(pool({ chain: 'monad' as any })), 'other chain: not followed');
  assert('skip' in k(pool({ dex: 'uniswap-v2' }), new Set(['uniswap-v2'])), 'COPY2_SKIP_DEXES leaves an exchange out');
  // V4
  const id = v4Id(WETH, USDG, 3000, 60);
  const v4 = k(pool({ dex: 'uniswap-v4', poolType: 'v3', poolAddress: id, tokenA: WETH, tokenB: USDG, v4: { fee: 3000, tickSpacing: 60, native: false, poolManager: PM, stateView: STRANGER } }));
  assert('kind' in v4 && v4.kind === 'V4' && v4.address === PM && v4.v4Id === id && v4.fee === 3000 && v4.tickSpacing === 60 && v4.token0 === WETH, 'hook-free V4 -> V4 (PoolManager address, pool id, fee, tick spacing)');
  const nid = v4Id(ZERO_ADDR, USDG, 500, 10);
  const native = k(pool({ dex: 'uniswap-v4', poolType: 'v3', poolAddress: nid, tokenA: WETH, tokenB: USDG, v4: { fee: 500, tickSpacing: 10, native: true, poolManager: PM, stateView: STRANGER } }));
  assert('kind' in native && native.token0 === ZERO_ADDR && native.token1 === USDG, 'native-ETH V4 pool: token0 is the zero address (not WETH)');
  const hookId = v4Id(WETH, USDG, 3000, 60, STRANGER);
  assert('skip' in k(pool({ dex: 'uniswap-v4', poolType: 'v3', poolAddress: hookId, v4: { fee: 3000, tickSpacing: 60, native: false, poolManager: PM, stateView: STRANGER, hooks: STRANGER } })), 'V4 with a hook: not followed');
  assert('skip' in k(pool({ dex: 'uniswap-v4', poolType: 'v3', poolAddress: id, v4: { fee: 500, tickSpacing: 60, native: false, poolManager: PM, stateView: STRANGER } })), 'V4 whose key does not give its id: not followed');
  assert('skip' in k(pool({ dex: 'uniswap-v4', poolType: 'v3', poolAddress: id, v4: { fee: 3000, tickSpacing: 60, native: false, poolManager: STRANGER, stateView: STRANGER } })), 'V4 on another PoolManager: not followed');
  // The list
  const list = buildTrackList([pool({}), pool({}), pool({ poolAddress: P2, dex: 'ramses-v3', poolType: 'v3' }), undefined], PM);
  assert(list.pools.length === 1 && Object.values(list.skipped).reduce((a, b) => a + b, 0) === 1, 'track list: duplicates once, skipped counted with a reason');
  // Transfer filter and coverage
  const ps: Copy2Pool[] = [
    { address: P1, kind: 'V2', token0: USDG, token1: WETH, fee: 0, tickSpacing: 0 },
    { address: P2, kind: 'V3', token0: MEME, token1: WETH, fee: 0, tickSpacing: 0 },
    { address: PM, v4Id: nid, kind: 'V4', token0: ZERO_ADDR, token1: USDG, fee: 500, tickSpacing: 10 },
  ];
  const tf = transferFilterOf(ps);
  assert(JSON.stringify(tf.pools) === JSON.stringify([P1, P2]) && tf.coins.length === 3 && !tf.pools.includes(PM) && !tf.coins.includes(ZERO_ADDR), 'transfer filter: contract pools and their coins, never the PoolManager or native ETH');
  const cov = { pools: new Set([P1, P2]), ids: new Set<string>(), transferPools: new Set([P1]), coins: new Set([USDG, WETH]) };
  const covered = coveredPools(ps, cov);
  assert(covered.length === 1 && covered[0]!.address === P1, 'only pools whose events AND coin transfers are all subscribed are tracked');
}

// =============================================================================
function feedTimesTests() {
  const t = new FeedBlockTimes(0);
  const frame = JSON.stringify({ version: 1, messages: [
    { sequenceNumber: 500, message: { message: { header: { kind: 3, sender: '0xa4b', blockNumber: 23_000_000, timestamp: 1_760_000_000, requestId: null, baseFeeL1: null }, l2Msg: 'BAAA' }, delayedMessagesRead: 1 }, signature: null },
    { sequenceNumber: 501, message: { message: { header: { kind: 3, sender: '0xa4b', blockNumber: 22_999_999, timestamp: 1_759_999_999, requestId: null, baseFeeL1: null }, l2Msg: 'BAAA' }, delayedMessagesRead: 1 }, signature: null },
  ] });
  t.noteFrame(frame);
  assert(t.get(500)?.timestamp === 1_760_000_000 && t.get(500)?.l1Block === 23_000_000, 'feed header: block time and L1 block read for each message');
  assert(t.get(501)?.timestamp === 1_760_000_000 && t.get(501)?.l1Block === 23_000_000, 'never backwards: a message stamped before its parent gets the parent\'s time / L1 block (Nitro rule)');
  const off = new FeedBlockTimes(10);
  off.noteFrame(frame);
  assert(off.get(510) !== undefined && off.get(500) === undefined, 'ARBSIM_L2_BLOCK_OFFSET is added to the sequence number');
  t.noteFrame('not json at all "sequenceNumber": 7');
  t.noteFrame(JSON.stringify({ version: 1, messages: [] }));
  assert(t.get(7) === undefined, 'odd frames are skipped, never throw');
}

// =============================================================================
type Log = RpcLog & { blockTimestamp?: string };
const L = (address: string, topics: string[], block: number, txi: number, li: number, tx = '0x' + 'aa'.repeat(31) + (txi + 16).toString(16).padStart(2, '0'), extra: Partial<Log> = {}): Log =>
  ({ address, topics, data: '0x', blockNumber: q(block), transactionIndex: q(txi), logIndex: q(li), transactionHash: tx, ...extra });

// A block header as newHeads pushes it (and eth_getBlockByNumber answers).
const BLOOM = '0x' + '0'.repeat(510) + '01';
const BLOOM2 = '0x' + '0'.repeat(510) + '02';
const H = (b: number, extra: Record<string, unknown> = {}) => ({ number: q(b), parentHash: '0x' + '11'.repeat(32), timestamp: q(1_760_000_000 + b), l1BlockNumber: q(23_000_000), logsBloom: BLOOM, ...extra });
// Let pending promises (node reads) run, with the fake clock moving.
async function settle(ms = 0, rounds = 6) { for (let i = 0; i < rounds; i++) { await tick(); advance(ms); } }

function makeForwarder(index: Copy2Index, rpc: ((m: string, p: unknown[]) => Promise<any>) | null = null, times?: FeedBlockTimes, headers = true) {
  const sent: any[] = [];
  let ok = true;
  const f = new Copy2Forwarder({
    send: (m) => { if (!ok) return false; sent.push(JSON.parse(JSON.stringify(m))); return true; },
    index: () => index, backfillRpc: () => rpc, now: () => clock, schedule, headers,
    ...(times ? { blockTime: (b: number) => times.get(b), feedNewest: () => times.newestNote() } : {}),
  });
  return { f, sent, setOk: (v: boolean) => { ok = v; } };
}

async function forwarderTests() {
  const ID = '0x' + 'cd'.repeat(32), ID2 = '0x' + 'ee'.repeat(32);
  // P1 holds WETH/USDG, P2 holds MEME/WETH (each pool's own coins).
  const index: Copy2Index = { pools: new Set([P1, P2]), ids: new Set([ID]), poolManager: PM, coins: new Set([WETH, USDG, MEME]), poolCoins: new Map([[P1, [WETH, USDG]], [P2, [MEME, WETH]]]) };
  const headerAnswers = new Map<number, any>();
  const rpcCalls: string[] = [];
  const rpc = async (m: string, p: unknown[]) => { rpcCalls.push(m); return m === 'eth_getBlockByNumber' ? (headerAnswers.get(Number(BigInt((p as any[])[0]))) ?? null) : null; };
  const { f, sent, setOk } = makeForwarder(index, rpc);

  f.onLogs([L(P1, [SYNC_TOPIC], 10, 0, 0)]); f.onHead(H(10));
  advance(100);
  assert(sent.length === 0, 'not following yet (no track accepted): nothing passed on');

  f.onLive(); f.setActive(true);
  // Block 10: out of order, duplicates, and things that are not ours.
  f.onLogs([
    L(P1, [SYNC_TOPIC], 10, 1, 5),
    L(P2, ['0x' + '11'.repeat(32)], 10, 0, 1),                    // any event of a tracked pool
    L(P3, [SYNC_TOPIC], 10, 0, 2),                                  // untracked pool
    L(WETH, [TRANSFER_TOPIC, pad(STRANGER), pad(P1)], 10, 1, 4),    // P1's coin into P1
    L(USDG, [TRANSFER_TOPIC, pad(STRANGER), pad(P3)], 10, 0, 3),    // coin into an untracked pool
    L(USDG, [TRANSFER_TOPIC, pad(P2), pad(STRANGER)], 10, 1, 10),   // a listed coin, but not one of P2's coins
    L(STRANGER, [TRANSFER_TOPIC, pad(P1), pad(STRANGER)], 10, 1, 6),// a coin we don't list
    L(P1, [TRANSFER_TOPIC, pad(STRANGER), pad(P2)], 10, 1, 11),     // P1's own LP token moving (pool report)
    L(PM, [V4_SWAP_TOPIC, ID], 10, 2, 7),                           // our V4 pool
    L(PM, ['0x' + '22'.repeat(32), ID], 10, 2, 8),                  // our V4 pool, other event (e.g. ModifyLiquidity)
    L(PM, [V4_SWAP_TOPIC, ID2], 10, 2, 9),                          // someone else's V4 pool
  ]);
  f.onLogs([L(P1, [SYNC_TOPIC], 10, 1, 5)]);                        // same log again (second subscription)
  advance(200);
  assert(sent.length === 0, 'reports without their header wait (the header brings time + bloom)');
  f.onHead(H(10));
  advance(20);
  assert(sent.length === 0, 'header arrived: block waits the grace time (30 ms) for stragglers');
  advance(10);
  assert(sent.length === 1 && sent[0].type === 'pool_logs' && sent[0].block === 10, 'block passed on 30 ms after its header (the checker\'s rule)');
  const m0 = sent[0];
  assert(m0.logsBloom === BLOOM && m0.timestamp === 1_760_000_010 && m0.l1Block === 23_000_000, 'block message carries the header\'s logsBloom, time and parent-chain block');
  assert(m0.gap === true && m0.prevBlock === 10, 'first message: gap, prevBlock = its own block (an arbsim that already follows reloads; a fresh one has nothing to compare)');
  const idxs = m0.logs.map((l: any) => Number(l.logIndex));
  assert(JSON.stringify(idxs) === JSON.stringify([1, 4, 5, 11, 7, 8]), `only our pools' logs (transfers only of the pool's OWN coins), once each, in transaction then log order (got ${idxs})`);
  assert(f.counts.dupLogs === 1, 'the repeated report was counted and passed on once');

  // A block with nothing for our pools: block_tick with its bloom.
  f.onHead(H(11, { logsBloom: BLOOM2 }));
  advance(30);
  assert(sent.length === 2 && sent[1].type === 'block_tick' && sent[1].block === 11 && sent[1].logsBloom === BLOOM2 && sent[1].prevBlock === 10 && !sent[1].gap, 'quiet block: block_tick with bloom, chained by prevBlock = block - 1');

  // Two blocks later arrived: block 12 goes at once, without waiting the grace time.
  f.onLogs([L(P2, [SYNC_TOPIC], 12, 0, 0, '0x' + 'b1'.repeat(32))]); f.onHead(H(12));
  advance(10);
  f.onHead(H(13)); f.onHead(H(14));
  advance(10);
  assert(sent.length === 3 && sent[2].block === 12, 'a header 2 blocks later arrived: block 12 passed on before its grace time');
  advance(30);
  assert(sent.length === 5 && sent[3].block === 13 && sent[4].block === 14 && sent[4].prevBlock === 13, 'blocks 13, 14 follow in order');

  // Header never came over the WebSocket: read from the node (counted).
  headerAnswers.set(15, H(15, { logsBloom: BLOOM2 }));
  f.onLogs([L(P1, [SYNC_TOPIC], 15, 0, 0)]);
  advance(300);
  f.onHead(H(16));
  assert(sent.length === 5, 'headerless block waits (HEADERLESS_WAIT_MS)');
  await settle(10, 15);
  const m15 = sent.find((m) => m.block === 15);
  assert(!!m15 && m15.logsBloom === BLOOM2 && m15.timestamp === 1_760_000_015 && f.counts.headersFetched === 1 && rpcCalls.includes('eth_getBlockByNumber'), 'missing header (header 16 came after 14) read from the node: block sent with ITS bloom and time');
  assert(sent.findIndex((m) => m.block === 15) < sent.findIndex((m) => m.block === 16), 'still in block order');

  // Header unknown even to the node: block NOT sent, the copy reloads.
  f.onLogs([L(P1, [SYNC_TOPIC], 17, 0, 0)]);
  advance(1_600);
  await settle(200, 10);
  assert(!sent.some((m) => m.block === 17) && f.counts.noTimestamp === 1 && f.counts.headerFails === 1 && !f.live(), 'no header anywhere: block skipped (never a guessed time / missing bloom), counted, routing stops');
  f.onHead(H(18)); advance(40);
  const m18 = sent[sent.length - 1];
  assert(m18.block === 18 && m18.prevBlock === 18 && m18.gap === true && f.live(), 'next message: prevBlock = its own block (the copy reloads); flowing again');

  // A dropped message: the next one makes the copy reload.
  setOk(false);
  f.onHead(H(19)); advance(40);
  assert(f.counts.msgsDropped === 1 && !f.live(), 'socket busy: message dropped and counted, routing stops');
  setOk(true);
  f.onHead(H(20)); advance(40);
  const m20 = sent[sent.length - 1];
  assert(m20.block === 20 && m20.gap === true && m20.prevBlock === 20, 'after a drop the next message says prevBlock = itself (copy reloads)');

  // Late reports: their own message, the block's own time, no bloom.
  f.onLogs([L(P2, [SYNC_TOPIC], 12, 3, 9)]); advance(0);
  const late = sent[sent.length - 1];
  assert(late.late === true && late.block === 12 && late.timestamp === 1_760_000_012 && late.logsBloom === undefined && late.prevBlock === undefined, 'late report: sent at once for its block, with that block\'s time, no bloom (as the checker)');
  const n = sent.length;
  f.onLogs([L(P2, [SYNC_TOPIC], 12, 0, 0, '0x' + 'b1'.repeat(32))]); advance(0);
  assert(sent.length === n && f.counts.lateDup === 1, 'a report already passed on (second subscription, after its block went) is not sent again');
  // Taken back before its block went out: goes in that block, marked removed.
  f.onLogs([L(P2, [SYNC_TOPIC], 21, 0, 0)]);
  f.onLogs([L(P2, [SYNC_TOPIC], 21, 0, 0, undefined, { removed: true })]);
  f.onHead(H(21)); advance(40);
  const m21 = sent[sent.length - 1];
  assert(m21.block === 21 && m21.logs.length === 2 && m21.logs.some((l: any) => l.removed === true), 'report taken back: passed on with removed=true (arbsim makes the pool unsure)');

  // Headers skipped while the WebSocket stayed up: read from the node, sent in order.
  headerAnswers.set(22, H(22)); headerAnswers.set(23, H(23));
  f.onHead(H(24));
  await settle(10, 10);
  const tail = sent.slice(-3).map((m) => m.block);
  assert(JSON.stringify(tail) === JSON.stringify([22, 23, 24]) && sent.slice(-3).every((m) => m.logsBloom) && f.counts.headerGaps === 2, `skipped headers read from the node, blocks sent in order with blooms (got ${tail})`);

  // Waiting for a transaction's reports.
  assert(f.txBlockOf('0x' + 'b1'.repeat(32)) === 12, 'transaction -> block remembered');
  const seen = await f.waitForTx('0x' + 'b1'.repeat(32), 100);
  assert(seen === 12, 'waitForTx: already seen -> its block at once');
  const later = f.waitForTx('0x' + 'c3'.repeat(32), 100);
  f.onLogs([L(P2, [SYNC_TOPIC], 25, 0, 0, '0x' + 'c3'.repeat(32))]);
  assert((await later) === 25, 'waitForTx: resolves when the reports arrive');
  const never = f.waitForTx('0x' + 'd4'.repeat(32), 100);
  advance(101);
  assert((await never) === null, 'waitForTx: null after the time limit');
  f.setActive(false);
  advance(100);
}

// The feed's parent-chain block fills in a header without one.
async function feedL1Tests() {
  const index: Copy2Index = { pools: new Set([P1]), ids: new Set<string>(), poolManager: PM, coins: new Set([WETH]) };
  const times = new FeedBlockTimes(0, 1024, () => clock);
  times.set(30, 1_760_000_030, 7);
  const { f, sent } = makeForwarder(index, null, times);
  f.onLive(); f.setActive(true);
  f.onHead(H(30, { l1BlockNumber: undefined }));
  advance(40);
  assert(sent.length === 1 && sent[0].type === 'block_tick' && sent[0].l1Block === 7 && sent[0].timestamp === 1_760_000_030, 'header without parent-chain block: taken from the sequencer feed');
  f.setActive(false);
  advance(100);
}

// The shared assembler's headerless mode (COPY2_HEADERS=off / --no-headers).
async function headerlessAssemblerTests() {
  const times = new Map<number, { timestamp: number; l1Block: number }>();
  let newest: { block: number; at: number } | null = null;
  const asm = new BlockAssembler(30, 1500, { headers: false, timeWaitMs: 40, tickMs: 250, timeOf: (b) => times.get(b), newestKnown: () => newest });
  const t = 5_000;
  times.set(100, { timestamp: 1_000, l1Block: 7 }); times.set(101, { timestamp: 1_001, l1Block: 7 });
  asm.addLog(L(P1, [SYNC_TOPIC], 100, 0, 0), t);
  assert(asm.due(t + 10).length === 0, 'headerless: block waits while no later report and under the grace time');
  asm.addLog(L(P1, [SYNC_TOPIC], 101, 0, 0), t + 11);
  const o = asm.due(t + 11);
  assert(o.length === 1 && o[0]!.block === 100 && o[0]!.timestamp === 1_000 && o[0]!.l1Block === 7 && !o[0]!.logsBloom, 'headerless: a report of a LATER block -> block goes at once, time from the feed, no bloom');
  assert(asm.due(t + 40).length === 0 && asm.due(t + 41)[0]?.block === 101, 'headerless: newest block goes graceMs after its first report');
  // Time not known: waits timeWaitMs more, then comes out without a time (caller skips it).
  asm.addLog(L(P1, [SYNC_TOPIC], 102, 0, 0), t + 100);
  assert(asm.due(t + 140).length === 0, 'headerless: complete but time unknown -> waits for the feed');
  const nt = asm.due(t + 171);
  assert(nt.length === 1 && nt[0]!.block === 102 && nt[0]!.timestamp === null, 'headerless: still unknown after grace + timeWaitMs -> out with timestamp null (never guessed)');
  // The log's own blockTimestamp is used when the feed has none.
  asm.addLog(L(P1, [SYNC_TOPIC], 103, 0, 0, undefined, { blockTimestamp: q(1_003) }), t + 200);
  assert(asm.due(t + 230)[0]?.timestamp === 1_003, 'headerless: time from the log\'s blockTimestamp');
  // Ticks: newest known block, once tickMs old, only with nothing held.
  times.set(110, { timestamp: 1_010, l1Block: 8 }); newest = { block: 110, at: t + 300 };
  asm.addLog(L(P1, [SYNC_TOPIC], 109, 0, 0), t + 300);
  assert(asm.due(t + 560).filter((x) => !x.logs.length).length === 0 || asm.lastSent === 110, 'headerless: no tick jumps ahead of a held block');
  const tk = asm.due(t + 600);
  assert(asm.lastSent === 110 && (tk.length === 0 || tk[tk.length - 1]!.block === 110), 'headerless: block_tick for the newest feed block once old enough');
  // Late: the block's remembered time, no bloom.
  const late = asm.addLog(L(P1, [SYNC_TOPIC], 101, 2, 3), t + 700);
  assert(!!late && late.late === true && late.timestamp === 1_001 && !late.logsBloom && !(blockMessage(late) as any).logsBloom, 'headerless: late report -> its own message with the block\'s time, no bloom');
  // Checker style: times given with addHead (bloom ignored), ticks from them.
  const a2 = new BlockAssembler(30, 1500, { headers: false, tickMs: 250 });
  a2.addHead(headFromNewHeads(H(200), t)!);
  assert(a2.due(t + 100).length === 0, 'headerless: a header alone never makes a block due (only its time is kept)');
  const k = a2.due(t + 250);
  assert(k.length === 1 && k[0]!.block === 200 && k[0]!.logs.length === 0 && (blockMessage(k[0]!) as any).type === 'block_tick' && !(blockMessage(k[0]!) as any).logsBloom, 'headerless (checker): tick for the newest header after tickMs, without its bloom');
}

// The bot's forwarder in its default headerless mode.
async function headerlessForwarderTests() {
  const index: Copy2Index = { pools: new Set([P1, P2]), ids: new Set<string>(), poolManager: PM, coins: new Set([WETH, USDG, MEME]), poolCoins: new Map([[P1, [WETH, USDG]], [P2, [MEME, WETH]]]) };
  const times = new FeedBlockTimes(0, 1024, () => clock);
  const calls: string[] = [];
  const rpc = async (m: string) => { calls.push(m); if (m === 'eth_blockNumber') return q(70); if (m === 'eth_getLogs') return []; return null; };
  const { f, sent, setOk } = makeForwarder(index, rpc, times, false);
  assert(!f.usesHeaders(), 'forwarder default for the bot: headerless');
  f.onLive(); f.setActive(true);
  for (let b = 50; b <= 60; b++) times.set(b, 1_760_000_000 + b, 23_000_000);
  f.onLogs([L(P1, [SYNC_TOPIC], 50, 0, 0), L(WETH, [TRANSFER_TOPIC, pad(P1), pad(P2)], 50, 0, 1)]);
  f.onLogs([L(WETH, [TRANSFER_TOPIC, pad(P1), pad(P2)], 50, 0, 1)]);      // same transfer via the "to" subscription
  f.onHead(H(50));                                                         // ignored headerless
  advance(20);
  assert(sent.length === 0, 'headerless: block held while its reports may still come (no later block yet)');
  f.onLogs([L(P2, [SYNC_TOPIC], 52, 0, 0)]);
  advance(10);
  assert(sent.length === 1 && sent[0].block === 50 && sent[0].logs.length === 2 && sent[0].timestamp === 1_760_000_050 && sent[0].l1Block === 23_000_000 && sent[0].logsBloom === undefined, 'headerless: a later block reported -> block 50 at once, feed time, no bloom, transfer once');
  assert(sent[0].prevBlock === 50 && sent[0].gap === true, 'first message: prevBlock = itself (reload if the copy already followed)');
  advance(30);
  assert(sent.length === 2 && sent[1].block === 52 && sent[1].prevBlock === 50 && !sent[1].gap, 'headerless: newest block after COPY2_GRACE_MS; prevBlock = previous block passed on (51 had nothing)');
  // Tick for the feed's newest block (nothing held).
  advance(300);
  const tick = sent.find((m) => m.type === 'block_tick');
  assert(!!tick && tick.block === 60 && tick.prevBlock === 52 && tick.logsBloom === undefined, 'headerless: block_tick for the newest feed block (no bloom), chained');
  // Block time unknown: not sent, the copy reloads.
  f.onLogs([L(P1, [SYNC_TOPIC], 61, 0, 0)]);
  advance(200);
  assert(!sent.some((m) => m.block === 61) && f.counts.noTimestamp === 1 && !f.live() && !calls.includes('eth_getBlockByNumber'), 'headerless: time unknown -> block skipped (never guessed, no header read), routing stops');
  times.set(62, 1_760_000_062, 23_000_000);
  f.onLogs([L(P1, [SYNC_TOPIC], 62, 0, 0)]); advance(40);
  const m62 = sent[sent.length - 1];
  assert(m62.block === 62 && m62.prevBlock === 62 && m62.gap === true, 'next message: prevBlock = itself (the copy reloads)');
  // Dropped message: next one reloads.
  times.set(63, 1_760_000_063, 23_000_000); times.set(64, 1_760_000_064, 23_000_000);
  setOk(false); f.onLogs([L(P1, [SYNC_TOPIC], 63, 0, 0)]); advance(40); setOk(true);
  f.onLogs([L(P1, [SYNC_TOPIC], 64, 0, 0)]); advance(40);
  const m64 = sent[sent.length - 1];
  assert(m64.block === 64 && m64.prevBlock === 64, 'after a dropped message: prevBlock = itself (copy reloads)');
  // Late report.
  f.onLogs([L(P2, [SYNC_TOPIC], 52, 4, 9)]); advance(0);
  const late = sent[sent.length - 1];
  assert(late.late === true && late.block === 52 && late.timestamp === 1_760_000_052 && late.logsBloom === undefined, 'headerless: late report on its own, with its block\'s time');
  // Outage fill-in: reports only, no header reads.
  f.onDown(); f.onLive();
  await settle(10, 6);
  assert(calls.filter((c) => c === 'eth_getLogs').length === 3 && !calls.includes('eth_getBlockByNumber'), 'headerless outage fill-in: report reads only, never a header read');
  f.setActive(false);
  advance(200);
}

// Same reports and headers through the dry-run checker's assembly
// (copy2Blocks.ts, as copy2-dryrun.ts uses it) and through the bot's
// forwarder: the messages arbsim gets must be the same (the bot only adds
// prevBlock / gap, and sends a repeated report once; arbsim drops repeats).
async function parityTests(headers: boolean) {
  const index: Copy2Index = { pools: new Set([P1, P2]), ids: new Set<string>(), poolManager: PM, coins: new Set([WETH, USDG, MEME]), poolCoins: new Map([[P1, [WETH, USDG]], [P2, [MEME, WETH]]]) };
  // Headerless: the bot takes block times from its sequencer feed, the
  // checker from the headers it is given (same values).
  const times = new FeedBlockTimes(0, 1024, () => clock);
  const { f, sent } = makeForwarder(index, null, headers ? undefined : times, headers);
  const asm = new BlockAssembler(30, 1500, { headers });
  const ref: any[] = [];
  const xfer = L(WETH, [TRANSFER_TOPIC, pad(P1), pad(P2)], 50, 0, 1);   // between two followed pools
  const events: Array<{ t: number; log?: Log; head?: any }> = [
    { t: 0, log: L(P1, [SYNC_TOPIC], 50, 0, 0) },
    { t: 1, log: xfer },                       // via "transfers FROM our pools"
    { t: 2, log: xfer },                       // the same report via "transfers TO our pools"
    { t: 5, head: H(50) },
    { t: 40, head: H(51) },
    { t: 45, log: L(P2, [SYNC_TOPIC], 52, 0, 0) },
    { t: 50, head: H(52) },
    { t: 120, log: L(USDG, [TRANSFER_TOPIC, pad(STRANGER), pad(P1)], 50, 3, 7) },   // late
  ];
  f.onLive(); f.setActive(true);
  const t0 = clock;
  // 1 ms steps; the checker's pump looks every 10 ms (copy2-dryrun setInterval).
  for (let t = 0; t <= 300; t++) {
    advance(t0 + t - clock);
    for (const e of events.filter((x) => x.t === t)) {
      if (e.log) { f.onLogs([e.log]); const late = asm.addLog(e.log, clock); if (late) ref.push(blockMessage(late)); }
      if (e.head) { f.onHead(e.head); asm.addHead(headFromNewHeads(e.head, clock)!); times.set(Number(BigInt(e.head.number)), Number(BigInt(e.head.timestamp)), Number(BigInt(e.head.l1BlockNumber))); }
    }
    if (t % 10 === 0) for (const b of asm.due(clock)) ref.push(blockMessage(b));
  }
  const strip = (m: any) => { const { prevBlock, gap, late, ...rest } = m; void prevBlock; void gap; void late; return rest; };
  const refDedup = ref.map((m) => (m.logs ? { ...m, logs: m.logs.filter((l: any, i: number, a: any[]) => a.findIndex((x) => x.logIndex === l.logIndex && x.transactionHash === l.transactionHash) === i) } : m));
  const a = JSON.stringify(sent.map(strip)), b = JSON.stringify(refDedup.map((m) => JSON.parse(JSON.stringify(m))));
  const mode = headers ? 'headers on' : 'headerless';
  assert(a === b && sent.length >= 3, `${mode}: bot block messages = the checker's (same blocks, order, logs, time, bloom; late as its own message)${a === b ? '' : `\n bot ${a}\n ref ${b}`}`);
  assert(ref[0].logs.length === 3 && sent[0].logs.length === 2 && f.counts.dupLogs === 1, `${mode}: transfer between two followed pools (from- AND to- subscription): checker sends it twice (arbsim drops the repeat), bot once`);
  if (!headers) assert(sent.every((m) => m.logsBloom === undefined), 'headerless: no logsBloom on any message');
  f.setActive(false);
  advance(100);
}

// Reports whose header never comes and no later block either: after
// maxWaitMs the pump reads the header from the node, then sends.
async function headerlessTests() {
  const index: Copy2Index = { pools: new Set([P1]), ids: new Set<string>(), poolManager: PM, coins: new Set([WETH]) };
  const asked: number[] = [];
  const rpc = async (m: string, p: unknown[]) => { const b = Number(BigInt((p as any[])[0])); asked.push(b); return m === 'eth_getBlockByNumber' ? H(b, { logsBloom: BLOOM2 }) : null; };
  const { f, sent } = makeForwarder(index, rpc);
  f.onLive(); f.setActive(true);
  f.onLogs([L(P1, [SYNC_TOPIC], 40, 0, 0)]);
  advance(1_400);
  assert(sent.length === 0, 'headerless block, nothing later: waits up to maxWaitMs (1500)');
  advance(110);
  await settle(10, 6);
  assert(sent.length === 1 && sent[0].block === 40 && sent[0].logsBloom === BLOOM2 && JSON.stringify(asked) === '[40]' && f.counts.headersFetched === 1, 'then its header is read from the node (one request) and the block sent with that bloom');
  // A header without a bloom counts as missing: also read from the node.
  f.onHead(H(41, { logsBloom: '0x12' }));
  advance(40);
  await settle(10, 6);
  assert(sent.length === 2 && sent[1].block === 41 && sent[1].logsBloom === BLOOM2 && asked.includes(41), 'a header without a readable bloom: header read from the node (never sent bloom-less)');
  f.setActive(false);
  advance(100);
}

async function backfillTests() {
  const index: Copy2Index = { pools: new Set([P1]), ids: new Set<string>(), poolManager: PM, coins: new Set([WETH, USDG]) };
  const calls: any[] = [];
  let fail = false;
  const rpc = async (m: string, p: unknown[]) => {
    calls.push({ m, p });
    if (fail) throw new Error('fetch failed https://secret.example/key');
    if (m === 'eth_blockNumber') return q(23);
    if (m === 'eth_getBlockByNumber') return H(Number(BigInt((p as any[])[0])));
    const f = (p as any[])[0];
    if (!f.topics) return [L(P1, [SYNC_TOPIC], 21, 0, 0), L(P1, [SYNC_TOPIC], 22, 0, 0)];
    if (f.topics[1]) return [L(WETH, [TRANSFER_TOPIC, pad(P1), pad(STRANGER)], 21, 0, 1)];
    return [L(USDG, [TRANSFER_TOPIC, pad(STRANGER), pad(P1)], 23, 0, 0)];
  };
  const { f, sent } = makeForwarder(index, rpc);
  f.onLive(); f.setActive(true);
  f.onLogs([L(P1, [SYNC_TOPIC], 20, 0, 0)]); f.onHead(H(20)); advance(40);
  assert(sent.length === 1 && sent[0].block === 20, 'before the outage: block 20 passed on');
  // Outage: partial block 21 held, then the socket drops.
  f.onLogs([L(P1, [SYNC_TOPIC], 21, 0, 0)]);
  f.onDown();
  assert(!f.live(), 'WebSocket down: not ready');
  f.onLogs([L(P1, [SYNC_TOPIC], 22, 0, 0)]);
  advance(100);
  assert(sent.length === 1, 'nothing passed on while down (held partial block dropped)');
  // Back: fill in 21..23 (reports + headers) from the HTTP node, merged with live block 24.
  f.onLive();
  f.onLogs([L(P1, [SYNC_TOPIC], 24, 0, 0)]); f.onHead(H(24));
  await settle(10, 10);
  const blocks = sent.map((m) => m.block);
  assert(JSON.stringify(blocks) === JSON.stringify([20, 21, 22, 23, 24]), `outage filled in from the node, then live, in block order (got ${blocks})`);
  assert(sent.slice(1).every((m, i) => !m.gap && m.prevBlock === m.block - 1 && m.logsBloom === BLOOM), 'filled-in outage: no gap, chained, every block with its header bloom');
  assert(sent[1].logs.length === 2, 'filled block 21: pool event + coin transfer');
  const ask = calls.filter((c) => c.m === 'eth_getLogs');
  assert(ask.length === 3 && ask.every((c) => c.p[0].fromBlock === q(21) && c.p[0].toBlock === q(23)), 'fill-in asks exactly the missed blocks (pool events + transfers from / to)');
  assert(calls.filter((c) => c.m === 'eth_getBlockByNumber').length === 3, 'and the 3 missed headers (one read each)');
  // Second outage, node fails: the copy is told to reload.
  fail = true;
  f.onDown(); f.onLive();
  await settle(0, 4);
  f.onLogs([L(P1, [SYNC_TOPIC], 30, 0, 0)]); f.onHead(H(30)); advance(40);
  const last = sent[sent.length - 1];
  assert(last.block === 30 && last.gap === true && last.prevBlock === 30 && f.counts.backfillFails === 1, 'fill-in failed: next message has prevBlock = itself (copy reloads, never guesses)');
  f.setActive(false);
  advance(100);
}

// =============================================================================
function statusTests() {
  assert(!parseCopy2Status({ ok: true, source: 'feed' }).active, 'status: feed mode = copy 2 not running');
  assert(!parseCopy2Status(null).active && !parseCopy2Status('x').active, 'status: unreadable = not running');
  const a = parseCopy2Status({ ok: true, source: 'pool-events', copy2: { pools: { [P1.toUpperCase().replace('0X', '0x')]: 'ready', [P2]: 'loading', [P3]: 'weird' } } });
  assert(a.active && a.states?.get(P1) === 'ready' && a.states?.get(P2) === 'loading' && a.states?.get(P3) === 'unsure', 'status map: ready / loading / anything else = unsure (strict)');
  assert(a.counts?.ready === 1 && a.counts?.loading === 1 && a.counts?.unsure === 1 && a.counts?.tracked === 3, 'status map: counts');
  const b = parseCopy2Status({ ok: true, copy2: { pools: [{ address: PM, v4Id: '0x' + 'cd'.repeat(32), state: 'ready' }, { address: P1, state: 'unsure' }] } });
  assert(b.active && b.states?.get('0x' + 'cd'.repeat(32)) === 'ready' && b.states?.get(P1) === 'unsure', 'status list: V4 keyed by pool id');
  const c = parseCopy2Status({ ok: true, source: 'pool-events', ready: [P1], unsure: [P2] });
  assert(c.states?.get(P1) === 'ready' && c.states?.get(P2) === 'unsure', 'status lists: ready / unsure arrays');
  // The exact shape arbsim sends (sim/src/copy2/intake.rs status_json, asked with pools:true).
  const idA = '0x' + 'ab'.repeat(32);
  const e = parseCopy2Status({ ok: true, ready: true, copy2: { source: 'pool-events', pools: 3, loading: 1, ready: 1, unsure: 1, lastBlock: 99, list: [
    { address: P1, v4Id: null, kind: 'v2', state: 'ready', reason: null, events: 4 },
    { address: PM, v4Id: idA, kind: 'v4', state: 'loading', reason: 'new', events: 0 },
    { address: P2, v4Id: null, kind: 'v3', state: 'unsure', reason: 'replay mismatch', events: 9 },
  ] } });
  assert(e.active && e.states?.get(P1) === 'ready' && e.states?.get(idA) === 'loading' && e.states?.get(P2) === 'unsure' && e.counts?.tracked === 3, 'arbsim status shape: copy2.list read, V4 by id');
  const e2 = parseCopy2Status({ ok: true, copy2: { source: 'pool-events', pools: 7, loading: 2, ready: 4, unsure: 1 } });
  assert(e2.active && e2.states === null && e2.counts?.tracked === 7 && e2.counts?.ready === 4, 'arbsim status without the list: counts only');
  const d = parseCopy2Status({ ok: true, source: 'pool-events', copy2: { ready: 5, unsure: 1, loading: 2 } });
  assert(d.states === null && d.counts?.tracked === 8, 'status numbers only: counts, but no per-pool readiness (routing stays on the node)');
}

// =============================================================================
function fakeClient() {
  const requests: any[] = [];
  const oneWay: any[] = [];
  let answer: (m: any) => any = (m) => ({ id: m.id, ok: true });
  return {
    requests, oneWay,
    setAnswer: (fn: (m: any) => any) => { answer = fn; },
    isConnected: () => true,
    sendOneWay: (m: Record<string, unknown>) => { oneWay.push(JSON.parse(JSON.stringify(m))); return true; },
    request: async (m: Record<string, unknown>) => { requests.push(m); return answer(m); },
  };
}

async function linkTests() {
  clock += 10_000;
  const id = v4Id(WETH, USDG, 3000, 60);
  const pools: PoolState[] = [
    pool({ poolAddress: P1, dex: 'uniswap-v2' }),
    pool({ poolAddress: P2, dex: 'uniswap-v3', poolType: 'v3', tokenA: MEME, tokenB: WETH }),
    pool({ poolAddress: id, dex: 'uniswap-v4', poolType: 'v3', v4: { fee: 3000, tickSpacing: 60, native: false, poolManager: PM, stateView: STRANGER } }),
    pool({ poolAddress: P3, dex: 'ramses-v3', poolType: 'v3' }),
  ];
  const client = fakeClient();
  const logs: string[] = [];
  const link = new Copy2Link({ client: client as any, settings: copy2Settings({}), pools: () => pools, poolManager: PM, now: () => clock, schedule, autoTimers: false, log: (m) => logs.push(m) });
  assert(!link.tap.wanted() && link.route([P1]) === null && link.notReadyWhy([P1]) === 'copy 2 not running', 'before the fast check says pool-events: no extra subscriptions, node decides');
  link.applyStatus({ ok: true, source: 'pool-events', copy2: { pools: {} } });
  assert(link.tap.wanted(), 'pool-events mode: the WebSocket is asked for the extra events');
  const tf = link.tap.transferFilter()!;
  assert(JSON.stringify(tf.pools) === JSON.stringify([P1, P2]), 'transfer filter from the followable watched pools (not Ramses V3, not V4)');
  // The subscription goes live, covering everything.
  link.tap.onLive({ pools: new Set([P1, P2, P3]), ids: new Set([id]), transferPools: new Set([P1, P2]), coins: new Set([WETH, USDG, MEME]) });
  await tick(); await tick();
  const tr = client.requests.find((r) => r.type === 'track');
  assert(!!tr && tr.pools.length === 3, 'track sent with the covered pools (V2, V3, V4)');
  const v4 = tr.pools.find((p: any) => p.kind === 'V4');
  assert(v4 && v4.address === PM && v4.v4Id === id && v4.fee === 3000 && v4.tickSpacing === 60 && v4.token0 === WETH, 'track: V4 entry carries PoolManager, id, fee, tick spacing, coins');
  assert(link.notReadyWhy([P1]) === 'pool reports not flowing', 'track accepted but nothing passed on yet (gap pending): node decides');
  // First block passes (with gap), then a fresh status says ready.
  link.times.set(40, 1_760_000_040, 1);
  link.tap.onLogs([L(P1, [SYNC_TOPIC], 40, 0, 0), L(PM, [V4_SWAP_TOPIC, id], 40, 1, 1)]);
  advance(50);
  assert(client.oneWay.length === 1 && client.oneWay[0].block === 40 && client.oneWay[0].gap === true && client.oneWay[0].timestamp === 1_760_000_040 && client.oneWay[0].logsBloom === undefined, 'pool_logs passed to the fast check (first with gap), time from the feed, no bloom (headers off by default)');
  assert(link.tap.dailyShare!() === 0.8 && copy2Settings({ COPY2_WSS_MAX_PCT: '50' }).wssMaxPct === 50 && copy2Settings({}).graceMs === 30, 'settings: copy-2 share of the daily WebSocket cap (80 %), grace 30 ms');
  assert(!copy2Settings({}).headers && link.tap.headers!() === false && copy2Settings({ COPY2_HEADERS: 'on' }).headers, 'COPY2_HEADERS: off by default (no newHeads, no header reads), on when set');
  assert(link.notReadyWhy([P1]) === 'reloading after a gap', 'status taken before the gap is not trusted');
  advance(1);
  link.applyStatus({ ok: true, source: 'pool-events', copy2: { pools: { [P1]: 'ready', [P2]: 'unsure', [id]: 'ready' } } });
  const r = link.route([P1, id]);
  assert(!!r && r.block === 40 && r.at.block === '0x28', 'every pool ready: fast check asked about the newest passed-on block');
  assert(link.route([P1, id], 45)?.block === 45, 'minBlock (the followed trade\'s block) raises the block asked about');
  assert(link.route([P1, P2]) === null && link.notReadyWhy([P1, P2]) === 'pool unsure', 'one pool unsure: node decides');
  assert(link.notReadyWhy([P1, P3]) === 'pool not followed', 'a pool copy 2 does not follow (e.g. loan pool on Ramses V3): node decides');
  assert(link.notReadyWhy([undefined, null]) === 'no pools given', 'no pools: node decides');
  advance(10_001);
  assert(link.notReadyWhy([P1]) === 'readiness too old', 'readiness older than 10 s: node decides');
  link.applyStatus({ ok: true, source: 'pool-events', copy2: { pools: { [P1]: 'ready', [P2]: 'ready', [id]: 'ready' } } });
  assert(link.route([P1]) !== null, 'fresh status again: fast check');
  link.tap.onDown();
  assert(link.notReadyWhy([P1]) === 'pool reports not flowing', 'WebSocket down: node decides at once');
  const hour = link.hourText()!;
  assert(/copy 2: 3 ready, 0 unsure, 0 loading of 3 pools/.test(hour) && /routed to fast check \d+, to node \d+/.test(hour), `hourly text: pools ready / unsure and fast vs node (${hour})`);
  // Sidecar back in feed mode: copy 2 off.
  link.applyStatus({ ok: true, source: 'feed' });
  assert(!link.running() && !link.tap.wanted() && !link.forwarder.isActive(), 'fast check left pool-events mode: copy 2 off, extra subscriptions dropped at the next renewal');
  // Track refused: nothing is passed on.
  const c2 = fakeClient();
  c2.setAnswer((m) => (m.type === 'track' ? { ok: false, unknown: 'bad_request' } : { ok: true }));
  const link2 = new Copy2Link({ client: c2 as any, settings: copy2Settings({}), pools: () => pools, poolManager: PM, now: () => clock, schedule, autoTimers: false, log: () => {} });
  link2.applyStatus({ ok: true, source: 'pool-events' });
  link2.tap.onLive({ pools: new Set([P1]), ids: new Set(), transferPools: new Set([P1]), coins: new Set([WETH, USDG]) });
  await tick(); await tick();
  link2.tap.onLogs([L(P1, [SYNC_TOPIC], 50, 0, 0)]); advance(50);
  assert(c2.oneWay.length === 0 && link2.notReadyWhy([P1]) === 'track list not accepted yet', 'track refused: nothing passed on, node decides');
  // LOCAL_SIM_COPY2=off
  assert(copy2Settings({ LOCAL_SIM_COPY2: 'off' }).mode === 'off' && copy2Settings({}).mode === 'auto', 'LOCAL_SIM_COPY2=off switch');
  const link3 = new Copy2Link({ client: fakeClient() as any, settings: copy2Settings({ LOCAL_SIM_COPY2: 'off' }), pools: () => pools, poolManager: PM, now: () => clock, schedule, autoTimers: false, log: () => {} });
  link3.applyStatus({ ok: true, source: 'pool-events' });
  assert(!link3.tap.wanted() && link3.route([P1]) === null && link3.hourText() === null, 'LOCAL_SIM_COPY2=off: never used');
}

// =============================================================================
class FakeSocket extends EventEmitter implements SocketLike {
  sent: any[] = [];
  closed = false;
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.closed = true; }
  terminate() { this.closed = true; }
  ping() { /* */ }
  open() { this.emit('open'); }
  reply(id: number, result: unknown) { this.emit('message', JSON.stringify({ jsonrpc: '2.0', id, result })); }
  replyError(id: number, message: string) { this.emit('message', JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } })); }
  push(sub: string, result: unknown) { this.emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: sub, result } })); }
}

function wsTapTests() {
  const ID = '0x' + 'cd'.repeat(32);
  const make = (tap?: any) => {
    const sockets: FakeSocket[] = [];
    const applied: any[] = [];
    const r = new WsBlockReader({
      url: 'wss://example.invalid/KEY', httpRpc: async () => [], poolManager: PM,
      addresses: () => [P1, P2], v4Ids: () => new Set([ID]),
      onUpdates: (latest) => applied.push(latest),
      connect: () => { const s = new FakeSocket(); sockets.push(s); return s; },
      schedule, now: () => clock, autoTick: false, usage: new NodeUsageCounter(() => clock), log: () => {},
      ...(tap ? { rawLogTap: tap } : {}),
    });
    return { r, sockets, applied };
  };
  // Without a tap: exactly the old subscriptions.
  {
    const { r, sockets } = make();
    r.start(); sockets[0]!.open();
    const s = sockets[0]!.sent;
    assert(s.length === 2 && s[0].params[1].topics && s[1].params[1].topics[0][0] === V4_SWAP_TOPIC, 'no tap: same two subscriptions as before (Sync/Swap, V4 Swap)');
    r.stop();
  }
  // Tap present but not wanted (fast check not in pool-events mode): as before.
  {
    const tap = { wanted: () => false, transferFilter: () => ({ coins: [WETH], pools: [P1] }), onLogs: () => {}, onLive: () => {}, onDown: () => {} };
    const { r, sockets } = make(tap);
    r.start(); sockets[0]!.open();
    assert(sockets[0]!.sent.length === 2 && !!sockets[0]!.sent[0].params[1].topics, 'tap not wanted: same two subscriptions as before');
    r.stop();
  }
  // Tap wanted.
  {
    const got: RpcLog[][] = [];
    let live: any = null, downs = 0;
    const heads: any[] = [];
    const tap = { wanted: () => true, headers: () => true, transferFilter: () => ({ coins: [USDG, WETH], pools: [P1, P2] }), onLogs: (l: RpcLog[]) => got.push(l), onHead: (h: any) => heads.push(h), onLive: (c: any) => { live = c; }, onDown: () => { downs++; } };
    const { r, sockets, applied } = make(tap);
    r.start(); sockets[0]!.open();
    const s = sockets[0]!.sent;
    assert(s.length === 5, 'tap wanted: five subscriptions');
    assert(s[4].params[0] === 'newHeads' && s[4].id === 2, 'tap wanted with COPY2_HEADERS=on: block headers too (newHeads: time + logsBloom for each block message)');
    assert(!s[0].params[1].topics && JSON.stringify(s[0].params[1].address) === JSON.stringify([P1, P2]), 'our pools: ALL their events (no topic filter), still only our addresses');
    assert(s[1].params[1].topics[0] === null && s[1].params[1].topics[1][0] === ID, 'V4: every PoolManager event for our pool ids');
    assert(s[2].params[1].topics[0] === TRANSFER_TOPIC && s[2].params[1].topics[1][0] === pad(P1) && JSON.stringify(s[2].params[1].address) === JSON.stringify([USDG, WETH]), 'coin transfers FROM our pools (our coins only)');
    assert(s[3].params[1].topics[1] === null && s[3].params[1].topics[2][1] === pad(P2), 'coin transfers TO our pools');
    sockets[0]!.reply(1, '0xs1'); sockets[0]!.reply(3, '0xs3'); sockets[0]!.reply(4, '0xs4');
    assert(live === null, 'not live until every subscription is confirmed');
    sockets[0]!.reply(5, '0xs5');
    assert(live === null, 'not live until the header subscription is confirmed too');
    sockets[0]!.reply(2, '0xs2');
    assert(live && live.pools.has(P1) && live.ids.has(ID) && live.transferPools.has(P2) && live.coins.has(WETH), 'all confirmed: tap live with what is covered');
    sockets[0]!.push('0xs4', L(WETH, [TRANSFER_TOPIC, pad(P1), pad(STRANGER)], 60, 0, 0));
    advance(10);
    assert(got.length === 1 && applied.length === 0, 'transfer logs go only to the tap, never to the price path');
    sockets[0]!.push('0xs1', { ...L(P1, [SYNC_TOPIC], 61, 0, 1), data: '0x' + '0'.repeat(63) + '1' + '0'.repeat(63) + '2' });
    advance(10);
    assert(got.length === 2 && applied.length === 1, 'pool logs go to both the tap and the price path');
    sockets[0]!.push('0xs1', L(P1, ['0x' + '33'.repeat(32)], 62, 0, 0));
    advance(10);
    assert(got.length === 3 && applied.length === 1, 'an event the price path does not know is ignored there (tap still gets it)');
    sockets[0]!.push('0xs2', H(62));
    assert(heads.length === 1 && heads[0].logsBloom === BLOOM && applied.length === 1 && r.tapStatus().heads === 1, 'block header handed to the tap as received (never to the price path)');
    sockets[0]!.emit('close');
    assert(downs === 1, 'connection closed: tap told (copy marks a possible gap)');
    r.stop();
  }
  // Provider refuses the transfer filter: copy 2 off on this reader, normal events go on.
  {
    let downs = 0;
    const tap = { wanted: () => true, transferFilter: () => ({ coins: [WETH], pools: [P1] }), onLogs: () => {}, onLive: () => {}, onDown: () => { downs++; } };
    const { r, sockets } = make(tap);
    r.start(); sockets[0]!.open();
    sockets[0]!.reply(1, '0xs1'); sockets[0]!.replyError(4, 'too many topics');
    assert(sockets[0]!.closed && downs === 1 && r.tapStatus().refused, 'transfer filter refused: tap down, reconnects without it');
    advance(2_000);
    sockets[1]!.open();
    assert(sockets[1]!.sent.length === 2 && !!sockets[1]!.sent[0].params[1].topics, 'reconnected with the normal subscriptions only');
    r.stop();
  }
  // COPY2_HEADERS off (default): the tap's subscriptions without newHeads.
  {
    let live: any = null;
    const tap = { wanted: () => true, headers: () => false, transferFilter: () => ({ coins: [WETH], pools: [P1] }), onLogs: () => {}, onHead: () => {}, onLive: (c: any) => { live = c; }, onDown: () => {} };
    const { r, sockets } = make(tap);
    r.start(); sockets[0]!.open();
    const sub = sockets[0]!.sent;
    assert(sub.length === 4 && !sub.some((x) => x.params?.[0] === 'newHeads'), 'headers off: four tap subscriptions, NO newHeads (no billed message per block)');
    for (const id of [1, 3, 4, 5]) sockets[0]!.reply(id, '0xs' + id);
    assert(!!live, 'headers off: tap live without a header subscription');
    r.stop();
  }
  // Provider refuses the header subscription: copy 2 off on this reader, normal events go on.
  {
    let downs = 0;
    const tap = { wanted: () => true, headers: () => true, transferFilter: () => ({ coins: [WETH], pools: [P1] }), onLogs: () => {}, onHead: () => {}, onLive: () => {}, onDown: () => { downs++; } };
    const { r, sockets } = make(tap);
    r.start(); sockets[0]!.open();
    sockets[0]!.reply(1, '0xs1'); sockets[0]!.replyError(2, 'newHeads not allowed');
    assert(sockets[0]!.closed && downs === 1 && r.tapStatus().refused, 'header subscription refused: tap down, reconnects without it');
    advance(2_000);
    sockets[1]!.open();
    assert(sockets[1]!.sent.length === 2 && !sockets[1]!.sent.some((x) => x.params?.[0] === 'newHeads'), 'reconnected with the normal subscriptions only (no headers)');
    r.stop();
  }
  // Copy-2 budget: past its share of the daily cap, copy 2's subscriptions stop for the day.
  {
    let downs = 0;
    const tap = { wanted: () => true, headers: () => true, dailyShare: () => 0.5, transferFilter: () => ({ coins: [WETH], pools: [P1] }), onLogs: () => {}, onHead: () => {}, onLive: () => {}, onDown: () => { downs++; } };
    const sockets: FakeSocket[] = [];
    const r = new WsBlockReader({
      url: 'wss://example.invalid/KEY', httpRpc: async () => [], poolManager: PM, addresses: () => [P1], v4Ids: () => new Set<string>(),
      onUpdates: () => {}, connect: () => { const x = new FakeSocket(); sockets.push(x); return x; },
      schedule, now: () => clock, autoTick: false, usage: new NodeUsageCounter(() => clock), log: () => {}, dailyMessageCap: 20, rawLogTap: tap,
    });
    r.start(); sockets[0]!.open();
    for (const id of [1, 2, 4, 5]) sockets[0]!.reply(id, '0xs' + id);
    for (let i = 0; i < 6; i++) sockets[0]!.push('0xs2', H(70 + i));   // 4 replies + 6 headers = 10 = half the cap
    r.tick();
    assert(sockets[0]!.closed && downs === 1, 'copy 2 at its share of the daily cap: subscriptions renewed at once without it');
    sockets[1]!.open();
    assert(sockets[1]!.sent.length === 1 && !!sockets[1]!.sent[0].params[1].topics && !sockets[1]!.sent.some((x) => x.params?.[0] === 'newHeads'), 'price feed keeps going (normal subscription only, no headers)');
    assert(r.stats().capped === false, 'the daily cap itself is not hit');
    r.stop();
  }
  // Empty transfer lists: never an address-less subscription.
  {
    const tap = { wanted: () => true, transferFilter: () => ({ coins: [], pools: [] }), onLogs: () => {}, onLive: () => {}, onDown: () => {} };
    const { r, sockets } = make(tap);
    r.start(); sockets[0]!.open();
    assert(sockets[0]!.sent.length === 2 && !!sockets[0]!.sent[0].params[1].topics, 'nothing to follow: normal subscriptions only (never an empty filter)');
    r.stop();
  }
}

// =============================================================================
async function hostTests() {
  // LOCAL_SIM=off: no host at all (no connection, no copy 2).
  assert(createLocalSimHost(true, { env: { LOCAL_SIM: 'off' }, copy2Pools: () => [] }) === null, 'LOCAL_SIM=off: nothing created');
  // The fast check is asked about the copy-2 block when a route gives one.
  const sent: any[] = [];
  const client: any = {
    isConnected: () => true, sendFeed: () => {}, close: () => {},
    sendOneWay: () => true,
    stats: { fallbacks: 0 },
    request: async (m: any) => { sent.push(m); return { id: 1, ok: false, unknown: 'unsure_pool' }; },
  };
  const link = new Copy2Link({ client, settings: copy2Settings({}), pools: () => [], poolManager: PM, now: () => clock, schedule, autoTimers: false, log: () => {} });
  const host = new LocalSimHost({ env: { LOCAL_SIM: 'on', LOCAL_SIM_CONFIRM: 'yes-fast-check', LOCAL_SIM_LOG: join(tmpdir(), `copy2-test-${process.pid}.jsonl`) }, client, copy2Link: link, log: () => {}, statusEveryMs: 3_600_000, warmEveryMs: 3_600_000, logFlushMs: 0 });
  assert(!host.copy2Running() && host.copy2Route([P1]) === null, 'host: copy 2 not running -> no route');
  const lc = host.begin({ kind: 'gap', at: { block: '0x28' }, trade: { token: WETH, amountIn: 10n ** 18n, hops: [{ kind: 0, pool: P1, tokenIn: WETH, tokenOut: USDG, feeBps: 30 } as any, { kind: 0, pool: P2, tokenIn: USDG, tokenOut: WETH, feeBps: 30 } as any] }, simOpts: { weth: WETH } });
  const lo = await lc.result;
  const call = sent.find((m) => m.type === 'call');
  assert(!!call && JSON.stringify(call.at) === JSON.stringify({ block: '0x28' }), 'fast check asked about the copy-2 block (at: {block})');
  assert(!lo.sure && lo.verdict === 'unknown', 'copy says "unsure pool": not sure -> the node decides');
  lc.noNode();
  host.forwardFeed(JSON.stringify({ version: 1, messages: [{ sequenceNumber: 9, message: { message: { header: { kind: 3, blockNumber: 5, timestamp: 1_760_000_000 }, l2Msg: '' } } }] }));
  assert(link.times.get(9) === undefined, 'feed block times only collected while copy 2 runs');
  link.applyStatus({ ok: true, source: 'pool-events' });
  host.forwardFeed(JSON.stringify({ version: 1, messages: [{ sequenceNumber: 9, message: { message: { header: { kind: 3, blockNumber: 5, timestamp: 1_760_000_000 }, l2Msg: '' } } }] }));
  assert(link.times.get(9)?.timestamp === 1_760_000_000 && host.copy2Running(), 'copy 2 running: block times read from the feed the bot already forwards');
  const line = host.takeHourLine() ?? '';
  assert(line.includes('copy 2:'), `hourly Telegram line carries the copy 2 part (${line})`);
  await host.stop();
}

async function main() {
  mappingTests();
  feedTimesTests();
  await forwarderTests();
  await feedL1Tests();
  await headerlessTests();
  await parityTests(true);
  await parityTests(false);
  await headerlessAssemblerTests();
  await headerlessForwarderTests();
  await backfillTests();
  statusTests();
  await linkTests();
  wsTapTests();
  await hostTests();
}
main().catch((e) => { console.error('FAIL: crashed', e); process.exitCode = 1; });
