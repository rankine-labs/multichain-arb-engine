// ============================================================================
// COPY 2 CHECKER TESTS (offline): the pure parts of copy2-dryrun.
//
// Plain English: proves, without any network, that the live checker
//   - follows the right pools with the right kind and coin order
//   - subscribes to the right reports and recognises them
//   - groups each block's reports in order and sends blocks at the right time
//   - reads arbsim's status in its likely shapes
//   - asks the right pool-state questions per pool kind
//   - reads both sides' answers through the bot's OWN check code, and
//     counts "WRONG" (copy said profit, node said no) correctly
//   - writes a readable summary
//
// Run: npx tsc -p scripts/sim-compare/tsconfig.json && node .scripts-build/scripts/sim-compare/test/copy2.test.js
// ============================================================================
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ethers } from 'ethers';
import { PoolState } from '../../../src/core/types';
import { simulateRoundTrip, loadBalanceSlots, Rpc, SIM_EXECUTOR_ADDRESS } from '../../../src/execution/simulator';
import { ROBINHOOD_TOKENS } from '../../../src/config/knownAddresses';
import {
  copy2KindOf, followedPools, logFilters, classifyLog, BlockAssembler, blockMessage, headFromNewHeads, readCopy2Status,
  probeCalls, v4StateSlot, readFastAnswer, rawFromEthCall, compareProbe, rpcFromFast, rpcFromTrace, compareCheck,
  choosePools, pickSample, Score, summaryText, TRANSFER_TOPIC, RH_POOL_MANAGER, ZERO, padTopic, FastOutcome,
} from '../copy2Lib';
import { routesThrough, buildPoolBook, USDG, WETH } from '../pools';
import { testPools, makeFakeNode, assert, profitRevert, P_V3, P_V2, P_CAKE } from './fakeChain';

const V4_ID = '0x' + 'ab'.repeat(32);
const HOOKED_ID = '0x' + 'cd'.repeat(32);
const LONE = '0x4444444444444444444444444444444444444444';
const OTHER_COIN = '0x5555555555555555555555555555555555555555';
const hex = (n: number | bigint) => '0x' + BigInt(n).toString(16);

function pools(): PoolState[] {
  const v4base = { chain: 'robinhood' as const, dex: 'uniswap-v4', poolType: 'v3' as const, tokenA: WETH, tokenB: USDG, feeBps: 5, lastUpdatedBlock: 0, lastUpdatedMs: 0 };
  return [
    ...testPools(),
    { ...v4base, poolAddress: V4_ID, v4: { fee: 500, tickSpacing: 10, native: true, poolManager: RH_POOL_MANAGER, stateView: ZERO } },
    { ...v4base, poolAddress: HOOKED_ID, v4: { fee: 3000, tickSpacing: 60, native: false, poolManager: RH_POOL_MANAGER, stateView: ZERO, hooks: '0x' + '77'.repeat(20) } },
    // A pair on ONE exchange only: not a pool we trade.
    { chain: 'robinhood', dex: 'uniswap-v2', poolAddress: LONE, poolType: 'v2', tokenA: OTHER_COIN, tokenB: USDG, feeBps: 30, lastUpdatedBlock: 0, lastUpdatedMs: 0 },
  ];
}

function testFollowed() {
  const f = followedPools(pools(), WETH);
  assert(f.pools.has(P_V3) && f.pools.has(P_V2) && f.pools.has(P_CAKE) && f.pools.has(V4_ID), 'follows the V2, V3, PancakeSwap V3 and hook-free V4 pools of a pair on 2+ exchanges');
  assert(!f.pools.has(LONE), 'a pair on only one exchange is not followed (same rule as liveReaction)');
  assert(!f.pools.has(HOOKED_ID) && Object.keys(f.notFollowed).some((k) => /hooked/.test(k)), 'hooked V4 pool not followed, and the reason is counted');
  assert(f.pools.get(P_V3)!.track.kind === 'v3' && f.pools.get(P_V2)!.track.kind === 'v2' && f.pools.get(P_CAKE)!.track.kind === 'pancakev3', 'kinds: v3 / v2 / pancakev3');
  const v4 = f.pools.get(V4_ID)!.track;
  assert(v4.kind === 'v4' && v4.address === RH_POOL_MANAGER && v4.v4Id === V4_ID && v4.fee === 500 && v4.tickSpacing === 10, 'V4 entry: PoolManager address + pool id + fee + tick spacing');
  assert(v4.token0 === ZERO && v4.token1 === USDG, 'native V4 pool: currency0 is native ETH (address 0)');
  const t = f.pools.get(P_V3)!.track;
  assert(t.token0 < t.token1 && t.fee === 0 && t.tickSpacing === 0 && t.v4Id === undefined, 'contract pool: coins sorted, fee/tickSpacing 0 (plan), no v4Id');
  const fork = { ...testPools()[0]!, dex: 'abyss-cl' };
  assert((copy2KindOf(fork) as any).kind === 'v3' && 'why' in copy2KindOf(fork, true), 'V3 fork followed as v3, unless --only-proven');
  const alg = { ...testPools()[0]!, dex: 'alandale', variant: 'algebra' as const };
  assert((copy2KindOf(alg) as any).kind === 'algebra', 'Algebra pool -> algebra');
  return f;
}

function testFiltersAndClassify(f: ReturnType<typeof followedPools>) {
  const fs = logFilters(f);
  const addrF = fs.find((x) => Array.isArray(x.address));
  assert(!!addrF && (addrF.address as string[]).length === 3, 'one address filter with the 3 contract pools');
  const v4F = fs.find((x) => x.address === RH_POOL_MANAGER);
  assert(!!v4F && (v4F.topics as any[])[1].includes(V4_ID) && !(v4F.topics as any[])[1].includes(HOOKED_ID), 'V4 filter: PoolManager + our pool ids only');
  const tIn = fs.find((x) => (x.topics as any[])?.[0] === TRANSFER_TOPIC && (x.topics as any[]).length === 3);
  const tOut = fs.find((x) => (x.topics as any[])?.[0] === TRANSFER_TOPIC && (x.topics as any[]).length === 2);
  assert(!!tIn && !!tOut && (tIn.topics as any[])[2].includes(padTopic(P_V2)), 'coin Transfer filters to AND from our pools');

  const usdgToPool = { address: USDG, topics: [TRANSFER_TOPIC, padTopic('0x' + '12'.repeat(20)), padTopic(P_V2)], data: '0x' + '0'.repeat(63) + '5', blockNumber: '0x10' };
  const otherToPool = { ...usdgToPool, address: OTHER_COIN };
  const lpTransfer = { ...usdgToPool, address: P_V2, topics: [TRANSFER_TOPIC, padTopic(ZERO), padTopic('0x' + '12'.repeat(20))] };
  const swap = { address: P_V3, topics: ['0x' + '01'.repeat(32)], data: '0x', blockNumber: '0x10' };
  const v4swap = { address: RH_POOL_MANAGER, topics: ['0x' + '02'.repeat(32), V4_ID], data: '0x', blockNumber: '0x10' };
  const hookedSwap = { ...v4swap, topics: ['0x' + '02'.repeat(32), HOOKED_ID] };
  assert(classifyLog(usdgToPool, f) === 'transfer', 'USDG sent to our V2 pool = coin transfer');
  assert(classifyLog(otherToPool, f) === null, 'a coin the pool does not hold, sent to it = ignored');
  assert(classifyLog(lpTransfer, f) === 'pool', 'the pool\'s own LP token Transfer = pool report');
  assert(classifyLog(swap, f) === 'pool' && classifyLog(v4swap, f) === 'pool', 'pool and V4 swap reports recognised');
  assert(classifyLog(hookedSwap, f) === null, 'report of a V4 pool we do not follow = ignored');
}

function testAssembler() {
  const a = new BlockAssembler(30, 1500);
  const L = (b: number, tx: number, i: number) => ({ address: P_V3, topics: [], data: '0x', blockNumber: hex(b), transactionIndex: hex(tx), logIndex: hex(i) });
  a.addLog(L(100, 2, 5), 1000); a.addLog(L(100, 1, 3), 1001); a.addLog(L(100, 2, 4), 1002);
  assert(a.due(1003).length === 0, 'no header yet: block not sent');
  a.addHead({ block: 100, timestamp: 1_760_000_100, l1Block: 23_000_000, at: 1005 });
  assert(a.due(1010).length === 0, 'header arrived but grace time not over: wait');
  const out = a.due(1040);
  assert(out.length === 1 && out[0]!.block === 100, 'header + grace: block sent');
  assert(out[0]!.logs.map((l) => Number(l.logIndex)).join(',') === '3,4,5', 'reports sorted by transaction, then log position');
  const m = blockMessage(out[0]!) as any;
  assert(m.type === 'pool_logs' && m.block === 100 && m.timestamp === 1_760_000_100 && m.l1Block === 23_000_000 && m.logs.length === 3, 'pool_logs message shape (plan)');
  assert(out[0]!.firstLogAt === 1000, 'first report arrival kept (for the timing number)');
  // Empty block: header only -> block_tick.
  a.addHead({ block: 101, timestamp: 1_760_000_101, l1Block: 23_000_000, at: 2000 });
  const t = a.due(2100);
  assert(t.length === 1 && (blockMessage(t[0]!) as any).type === 'block_tick', 'block with nothing on our pools -> block_tick');
  // Later report for an already-sent block = late (sent on its own, counted).
  const late = a.addLog(L(100, 3, 9), 2200);
  assert(!!late && late.late === true && a.late === 1, 'report for a block already sent = late, counted');
  // Block without a header: sent once something 2 blocks later shows up (order kept).
  a.addLog(L(102, 0, 0), 3000); a.addLog(L(104, 0, 0), 3001);
  const o2 = a.due(3002);
  assert(o2.length === 1 && o2[0]!.block === 102 && o2[0]!.timestamp === null && a.noHeader === 1, 'no header but block+2 seen: sent, counted as no-header');
  // ... or after maxWait.
  assert(a.due(3002 + 1500).map((b) => b.block).join(',') === '104', 'no header, nothing later: sent after the longest wait');
  assert(JSON.stringify(a.gapBefore(110)) === JSON.stringify({ from: 105, to: 109 }) && a.gapBefore(105) === null, 'missed blocks after a reconnect are found');
  a.addHead({ block: 105, timestamp: 1, l1Block: 1, at: 5000 });
  assert(a.gapBefore(106) === null, 'next header while the previous block still waits for its grace = no gap (no false read-back)');
  const h = headFromNewHeads({ number: '0x64', timestamp: '0x10', l1BlockNumber: '0x20', parentHash: '0x' }, 5);
  assert(!!h && h.block === 100 && h.timestamp === 16 && h.l1Block === 32 && h.at === 5, 'newHeads header read (L2 number, time, L1 block)');
}

function testStatus() {
  const s1 = readCopy2Status({ copy2: { block: 123, pools: [{ address: P_V3, state: 'ready' }, { v4Id: V4_ID, address: RH_POOL_MANAGER, state: 'unsure' }, { address: P_V2, state: 'loading' }], eventsApplied: 9 }, node: { usedToday: 50, public: { usedToday: 7 } } });
  assert(s1.block === 123 && s1.ready!.has(P_V3) && s1.unsure!.has(V4_ID) && s1.loading!.has(P_V2), 'status: per-pool list (V4 by its id)');
  assert(s1.counts.ready === 1 && s1.counts.unsure === 1 && s1.eventsApplied === 9 && s1.nodeUsedToday === 50 && s1.publicUsedToday === 7, 'status: counts + node use');
  const s2 = readCopy2Status({ copy2: { head: { block: '0x10' }, pools: { [P_V3.toUpperCase()]: 'ready', [P_V2]: { state: 'unsure' } }, ready: 1, unsure: 1 } });
  assert(s2.block === 16 && s2.ready!.has(P_V3) && s2.unsure!.has(P_V2), 'status: per-pool map, any letter case');
  const s3 = readCopy2Status({ copy2: { readyPools: [P_CAKE], unsurePools: [] } });
  assert(s3.ready!.has(P_CAKE) && s3.unsure!.size === 0, 'status: ready/unsure lists');
  const s4 = readCopy2Status({ ok: true, head: { block: 5 } });
  assert(s4.ready === null && s4.block === 5, 'status without per-pool readiness = "not reported" (null), not "none ready"');
}

function testProbes(f: ReturnType<typeof followedPools>) {
  const v2 = probeCalls(f.pools.get(P_V2)!.track);
  assert(v2.map((c) => c.label).join('|') === 'getReserves|coin0 balance|coin1 balance' && v2[0]!.data === '0x0902f1ac', 'V2 probe: reserves + both coin balances');
  const v3 = probeCalls(f.pools.get(P_V3)!.track);
  assert(v3[0]!.data === '0x3850c7bd' && v3[1]!.data === '0x1a686502', 'V3 probe: slot0 + liquidity');
  const iface = new ethers.Interface(['function balanceOf(address)']);
  assert(v3[2]!.to === f.pools.get(P_V3)!.track.token0 && v3[2]!.data === iface.encodeFunctionData('balanceOf', [P_V3]).toLowerCase(), 'balance probe asks the coin for the pool\'s balance');
  const v4 = probeCalls(f.pools.get(V4_ID)!.track);
  const base = BigInt(ethers.solidityPackedKeccak256(['bytes32', 'uint256'], [V4_ID, 6]));
  assert(BigInt(v4StateSlot(V4_ID)) === base, 'V4 pool slot = keccak(id, 6) (StateLibrary POOLS_SLOT)');
  const ext = new ethers.Interface(['function extsload(bytes32)']);
  assert(v4.length === 2 && v4[0]!.to === RH_POOL_MANAGER && v4[1]!.data === ext.encodeFunctionData('extsload', [ethers.toBeHex(base + 3n, 32)]), 'V4 probe: PoolManager slot0 + liquidity (+3), no balances');
}

function testAnswers() {
  const fa = readFastAnswer({ ok: true, at: { block: '0x10' }, results: [{ success: true, output: '0xAB', gasUsed: '0x10' }] }, 1);
  assert(fa.kind === 'answer' && fa.results[0]!.output === '0xab' && fa.results[0]!.gasUsed === '16' && fa.atBlock === 16, 'arbsim answer read (lower-case output, gas as number)');
  assert(readFastAnswer({ ok: false, unknown: 'unsure-pool' }, 1).kind === 'unknown', 'arbsim "unknown" read');
  assert((readFastAnswer({ ok: true, results: [] }, 1) as any).why.includes('0 answers'), 'wrong number of answers = unknown');
  assert(rawFromEthCall({ result: '0x01' })!.success && rawFromEthCall({ error: { message: 'execution reverted', data: '0xdead' } })!.output === '0xdead', 'node answers: ok and revert');
  assert(rawFromEthCall({ error: { message: 'rate limited (HTTP 429)' } }) === null, 'node trouble is not an answer');
  const ans = (o: string): FastOutcome => ({ kind: 'answer', atBlock: 1, results: [{ success: true, output: o, gasUsed: null }] });
  assert(compareProbe(ans('0x01'), [{ success: true, output: '0x01', gasUsed: null }]).verdict === 'same', 'probe: identical = same');
  assert(compareProbe(ans('0x02'), [{ success: true, output: '0x01', gasUsed: null }]).verdict === 'different', 'probe: one byte off = different');
  assert(compareProbe({ kind: 'unknown', why: 'unsure-pool' }, [{ success: true, output: '0x01', gasUsed: null }]).verdict === 'fast-unsure', 'probe: copy unsure counted separately');
  assert(compareProbe({ kind: 'unknown', why: 'miss' }, [{ success: true, output: '0x01', gasUsed: null }]).verdict === 'fast-missing', 'probe: copy could not answer');
  assert(compareProbe(ans('0x01'), [null]).verdict === 'node-trouble', 'probe: node error left out');
}

// The bot's own check code, fed by the copy's answer and the node's trace.
async function testChecks() {
  loadBalanceSlots(join(mkdtempSync(join(tmpdir(), 'copy2-')), 'slots.json'));
  const fake = makeFakeNode();
  const book = buildPoolBook(testPools(), {});
  const route = routesThrough(book, book.pools.get(P_V3)!, { usdg: [100], weth: [0.1] }, {}, null).find((r) => r.funding === 'own')!;
  const trade = { token: route.token, amountIn: route.amountIn, hops: route.hops };
  const opts = { weth: ROBINHOOD_TOKENS.WETH, blockTag: '0x10', slotReadOnly: true };
  // Node side: the fake node's debug_traceCall (callTracer) answer, as copy2-dryrun reads it.
  let nodeRaw: any = null;
  const nodeRpc: Rpc = async (m, p) => {
    const a = p as any[];
    if (m !== 'eth_call' || a[0].to.toLowerCase() !== SIM_EXECUTOR_ADDRESS) return fake.rpc(m, p);
    const r = await fake.rpc('debug_traceCall', [a[0], a[1], { tracer: 'callTracer', stateOverrides: a[2] }]);
    const t = rpcFromTrace(r.result); nodeRaw = t.raw; return t.rpc;
  };
  const node = await simulateRoundTrip(nodeRpc, 'robinhood', trade, opts);
  assert(node.status === 'profit' || node.status === 'loss', `node trace read by the bot's own code (${node.status})`);
  assert(nodeRaw && nodeRaw.gasUsed !== null && nodeRaw.success === false, 'node gas comes from the trace');
  // Fast side answers with a chosen output.
  const fastWith = (o: FastOutcome) => { const cap = { raw: null as any }; const rpc: Rpc = async (m, p) => { const a = p as any[]; if (m !== 'eth_call' || a[0].to.toLowerCase() !== SIM_EXECUTOR_ADDRESS) return fake.rpc(m, p); cap.raw = o.kind === 'answer' ? o.results[0] : null; return rpcFromFast(o); }; return { rpc, cap }; };
  const same = fastWith({ kind: 'answer', atBlock: 16, results: [{ ...nodeRaw }] });
  const fsame = await simulateRoundTrip(same.rpc, 'robinhood', trade, opts);
  const c1 = compareCheck(fsame, node, same.cap.raw, nodeRaw, null);
  assert(c1.verdict === 'exact' && !c1.wrong && c1.gasDiff === 0, 'identical answers = exact, gas difference 0');
  // Copy says profit, node says loss -> WRONG.
  const loss = { status: 'loss' as const };
  const big = fastWith({ kind: 'answer', atBlock: 16, results: [{ success: false, output: profitRevert(10n ** 30n), gasUsed: '300000' }] });
  const fbig = await simulateRoundTrip(big.rpc, 'robinhood', trade, opts);
  assert(fbig.status === 'profit', 'copy answer with a big profit reads as profit');
  const c2 = compareCheck(fbig, loss, big.cap.raw, { success: false, output: '0x', gasUsed: '300100' }, null);
  assert(c2.wrong && c2.verdict === 'different' && c2.gasDiff === -100, 'copy profit + node loss = WRONG, gas difference counted');
  const c3 = compareCheck({ status: 'loss' }, { status: 'profit', profit: 5n }, null, null, null);
  assert(c3.missed && !c3.wrong, 'node profit + copy no = missed (not wrong)');
  const unsure = fastWith({ kind: 'unknown', why: 'unsure-pool' });
  const fu = await simulateRoundTrip(unsure.rpc, 'robinhood', trade, opts);
  const c4 = compareCheck(fu, node, null, nodeRaw, 'unsure-pool');
  assert(c4.verdict === 'fast-unsure' && !c4.wrong, 'copy unsure = counted as unsure, never as wrong');
  const c5 = compareCheck(fsame, { status: 'rate_limited', reason: 'x' }, null, null, null);
  assert(c5.verdict === 'node-trouble', 'node busy = left out');
  const c6 = compareCheck({ status: 'profit', profit: 7n }, { status: 'profit', profit: 5n }, { success: false, output: '0x01', gasUsed: null }, { success: false, output: '0x02', gasUsed: null }, null);
  assert(c6.verdict === 'different' && c6.profitDiff === '2' && !c6.wrong, 'both profit, different amount = different (profit difference kept)');
  return [c1, c2, c3, c4, c5, c6];
}

function testSampling() {
  const st = readCopy2Status({ copy2: { pools: [{ address: 'a', state: 'ready' }, { address: 'b', state: 'ready' }, { address: 'c', state: 'unsure' }, { address: 'd', state: 'ready' }] } });
  const r1 = choosePools(['a', 'b', 'c', 'd'], st, ['c', 'd'], 2, 'seed');
  assert(!r1.pools.includes('c') && r1.pools.includes('d') && r1.pools.length === 2, 'only READY pools probed; a just-changed ready pool comes first');
  const r2 = choosePools(['a', 'b', 'c', 'd'], st, ['c', 'd'], 2, 'seed');
  assert(JSON.stringify(r1) === JSON.stringify(r2), 'same round = same sample (repeatable)');
  const r3 = choosePools(['a', 'b'], readCopy2Status({}), [], 5, 's');
  assert(r3.pools.length === 2 && r3.readiness === 'not reported', 'readiness not reported: any followed pool, said so');
  assert(pickSample([1, 2, 3, 4, 5], 3, 'x').length === 3 && new Set(pickSample([1, 2, 3, 4, 5], 3, 'x')).size === 3, 'sample without repeats');
}

function testSummary(cs: ReturnType<typeof compareCheck>[]) {
  const s = new Score();
  s.started = 0; s.tracked = 4; s.notFollowed = { 'hooked V4 pool': 1 };
  s.addProbe('same'); s.addProbe('same'); s.addProbe('different'); s.addProbe('fast-unsure', 'unsure-pool'); s.addProbe('node-trouble');
  for (const c of cs) s.addCheck(c);
  s.updateMs.push(3, 5, 9); s.applyMs.push(1, 2, 4); s.ackMode = 'answer'; s.nodeReads = 42;
  s.arbsimStatus(readCopy2Status({ copy2: { block: 9, ready: 3, unsure: 1, loading: 0 }, node: { usedToday: 10 } }));
  s.arbsimStatus(readCopy2Status({ copy2: { block: 10, ready: 3, unsure: 1, loading: 0 }, node: { usedToday: 25 } }));
  const j: any = s.json(600_000);
  assert(j.slots.probes === 4 && j.slots.same === 2 && j.slots.matchPct === 50 && j.slots.matchPctWhenAnswered === 66.67, 'pool-state match %: unsure counts against, node errors left out');
  assert(j.checks.WRONG_fastSaidProfitNodeSaidNo === 1 && j.checks.missed_nodeSaidProfitFastSaidNo === 1 && j.checks.nodeTrouble === 1, 'WRONG / missed / node trouble counted');
  assert(j.nodeReads.arbsimPaid === 15 && j.nodeReads.checker === 42, 'node reads: checker + test arbsim (difference since start)');
  assert(j.timing.logToCopyMs_median === 5 && j.timing.sendToCopyMs_median === 2 && j.pools.ready === 3 && j.pools.copyBlock === 10, 'timing median and pool readiness in the summary');
  const txt = summaryText(j, true);
  assert(/FINAL/.test(txt) && /WRONG \(copy said profit, node said no\): 1/.test(txt) && /3 ready, 1 unsure/.test(txt) && /NOT READY/.test(txt), 'plain-English summary has the key lines and the bottom line');
  const empty = summaryText(new Score().json(), false);
  assert(/NO DATA YET/.test(empty), 'empty run says "no data yet"');
}

async function main() {
  const f = testFollowed();
  testFiltersAndClassify(f);
  testAssembler();
  testStatus();
  testProbes(f);
  testAnswers();
  const cs = await testChecks();
  testSampling();
  testSummary(cs);
}
main().catch((e) => { console.error('FAIL: crashed', e); process.exitCode = 1; });
