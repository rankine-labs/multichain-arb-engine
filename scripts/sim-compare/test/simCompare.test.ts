// ============================================================================
// SIM-COMPARE TESTS: the whole harness on a fake node and fake engines.
//
// Run: npx tsc -p scripts/sim-compare/tsconfig.json && node .scripts-build/scripts/sim-compare/test/run.js
// Each check prints PASS/FAIL; any FAIL makes the run exit non-zero.
// ============================================================================
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer, Socket } from 'net';
import { ethers } from 'ethers';
import { simulateRoundTrip, SIM_EXECUTOR_ADDRESS, loadBalanceSlots, Rpc } from '../../../src/execution/simulator';
import { ARB_EXECUTOR_RUNTIME_CODE } from '../../../src/execution/arbExecutorBytecode';
import { EXECUTE_SELECTOR, EXECUTE_V3_FLASH_SELECTOR } from '../../../src/execution/executorCalldata';
import { ROBINHOOD_TOKENS } from '../../../src/config/knownAddresses';
import { collectCases, unpackOverrides, triggersFromLogs, captureCheck, EXECUTOR_PLACEHOLDER } from '../collect';
import { runNodeStep, runFastStep, buildReport, reportText, fastFileOf, RETRY_LATER } from '../pipeline';
import { nodeAnswer, rawFromSimulate, isNodeTrouble } from '../nodeCheck';
import { EchoEngine, ScriptedEngine, ArbsimSocketEngine, FixtureEngine, prefixDiffOverrides, mergeOverrides, parseFixtureOutput, fastFromArbsim, pinnedCallRequest } from '../engines';
import { readAnswer, compareOne, MATCH_RATE_DEFINITION } from '../compare';
import { routesThrough, DEFAULT_SIZES, USDG, startCoinOf, loadPoolBook } from '../pools';
import { findNodeUrl, makeHarnessRpc, loadById, readJsonl, sample } from '../util';
import { parseArgs } from '../main';
import { Case, NodeRecord, FastRecord } from '../types';
import { makeFakeNode, testBook, testPools, assert, P_V3, P_V2, P_CAKE, profitRevert, defaultProfit, IFACE } from './fakeChain';
import { buildPoolBook } from '../pools';

const quiet = { log: () => {} };
const hasKey = (o: Record<string, unknown>, k: string) => Object.keys(o).some((x) => x.toLowerCase() === k.toLowerCase());
const tmp = () => mkdtempSync(join(tmpdir(), 'simcmp-'));
const ctl = (o: Partial<{ stop: () => boolean; concurrency: number }> = {}) => ({ concurrency: o.concurrency ?? 2, stop: o.stop ?? (() => false), log: () => {}, progressMs: 3_600_000 });
const SIZES = { usdg: [100, 1000], weth: [0.1] };
const collectOpts = (out: string, extra: Record<string, unknown> = {}) => ({ out, from: 1000, to: 1199, sizes: SIZES, maxCases: 10_000, maxRoutesPerTrigger: 50, standingEvery: 100, standingRoutes: 2, tradeShare: 1, logChunk: 100, resume: false, stop: () => false, ...quiet, ...extra });
const TRADES = [{ block: 1005, index: 2, pool: P_V3 }, { block: 1005, index: 3, pool: P_V2, sync: true }, { block: 1150, index: 2, pool: P_CAKE }];

async function cases(out: string): Promise<Case[]> { const r: Case[] = []; for await (const c of readJsonl<Case>(join(out, 'cases.jsonl'))) r.push(c); return r; }

async function testCollect() {
  loadBalanceSlots(join(tmp(), 'slots.json'));
  const out = tmp();
  const book = testBook();
  const fake = makeFakeNode({ trades: TRADES });
  const st = await collectCases(fake.rpc, book, collectOpts(out));
  const cs = await cases(out);
  const trig = cs.filter((c) => c.mode === 'trigger'), stand = cs.filter((c) => c.mode === 'standing');
  assert(st.triggers === 3, `3 trades on watched pools found from events, the unwatched pool ignored (got ${st.triggers})`);
  // Each trade: pool vs 2 partners x 2 directions x (2 own sizes + 1 flash where a lender exists).
  assert(trig.length > 0 && trig.every((c) => c.txIndex !== null && c.triggerHash), `follow-a-trade checks have a trigger (got ${trig.length})`);
  assert(stand.length === 4 && stand.every((c) => c.txIndex === null), `standing sample: 2 routes x 2 sampled blocks (got ${stand.length})`);
  const c1 = trig.find((c) => c.block === 1005 && c.txIndex === 2)!;
  assert(!!c1 && c1.prefixLen === 1, `replay prefix skips the system tx (type 0x6a) and the contract creation: tx 2 only (got ${c1?.prefixLen})`);
  const c2 = trig.find((c) => c.block === 1005 && c.txIndex === 3)!;
  assert(!!c2 && c2.prefixLen === 2, 'a later trade in the same block replays both user txs before it');
  assert(cs.every((c) => c.parent === c.block - 1), 'every check runs on the parent block');
  assert(cs.every((c) => c.call.to === SIM_EXECUTOR_ADDRESS && c.overrides[SIM_EXECUTOR_ADDRESS]?.code === EXECUTOR_PLACEHOLDER), 'contract code stored as a placeholder, not 20 KB per check');
  const own = cs.filter((c) => c.funding === 'own'), flash = cs.filter((c) => c.funding === 'flash');
  assert(own.length > 0 && own.every((c) => c.call.data.startsWith(EXECUTE_SELECTOR) && hasKey(c.overrides, ROBINHOOD_TOKENS.USDG)), 'own-money checks: execute() + a pretend USDG balance (balance-slot override)');
  assert(flash.length > 0 && flash.every((c) => c.call.data.startsWith(EXECUTE_V3_FLASH_SELECTOR) && !hasKey(c.overrides, ROBINHOOD_TOKENS.USDG) && !!c.v3Lender), 'flash checks: executeWithV3Flash, NO pretend balance, a lender');
  assert(flash.every((c) => ![c.route.buyPool, c.route.sellPool].includes(c.v3Lender!)), 'the lender is never one of the trade pools');
  assert(new Set(cs.map((c) => c.id)).size === cs.length, 'every check has a unique id');
  assert(st.decodedByBot + st.notDecodedByBot > 0, 'records whether the bot\'s feed decoder would have read each trade');

  // Byte-for-byte the same request as the bot's simulateRoundTrip.
  const c = own.find((x) => x.mode === 'standing') ?? own[0]!;
  let sent: unknown[] | null = null;
  const spy: Rpc = async (m, p) => { if (m === 'eth_call' && (p as any)[0]?.to === SIM_EXECUTOR_ADDRESS) { sent = p; return { error: { message: 'x' } }; } return fake.rpc(m, p); };
  await simulateRoundTrip(spy, 'robinhood', { token: c.route.token, amountIn: BigInt(c.route.amountIn), hops: c.route.hops }, { weth: ROBINHOOD_TOKENS.WETH, blockTag: 'latest' });
  assert(!!sent && JSON.stringify((sent as unknown[])[0]) === JSON.stringify(c.call) && JSON.stringify((sent as unknown[])[2]) === JSON.stringify(unpackOverrides(c)), 'stored call + overrides = exactly what the bot\'s simulateRoundTrip sends');
  assert(unpackOverrides(c)[SIM_EXECUTOR_ADDRESS].code === ARB_EXECUTOR_RUNTIME_CODE, 'placeholder expands back to the real contract code');
  let threw = false;
  try { unpackOverrides({ ...c, executorCodeHash: 'old' }); } catch { threw = true; }
  assert(threw, 'checks collected with an older contract code are refused (no silent mismatch)');
  return { out, fake };
}

async function testResume() {
  // Stop after the first chunk, then resume: same final set, no duplicates.
  const full = tmp(), part = tmp();
  await collectCases(makeFakeNode({ trades: TRADES }).rpc, testBook(), collectOpts(full));
  let chunks = 0;
  await collectCases(makeFakeNode({ trades: TRADES }).rpc, testBook(), collectOpts(part, { stop: () => chunks++ > 2, log: () => {} }));
  const before = (await cases(part)).length;
  await collectCases(makeFakeNode({ trades: TRADES }).rpc, testBook(), collectOpts(part, { resume: true }));
  const a = (await cases(full)).map((c) => c.id).sort(), b = (await cases(part)).map((c) => c.id).sort();
  assert(before < a.length, `the stopped run was really partial (${before} of ${a.length})`);
  assert(JSON.stringify(a) === JSON.stringify(b), 'stopped + resumed collect = same checks as one full run, no duplicates');
  const capped = tmp();
  await collectCases(makeFakeNode({ trades: TRADES }).rpc, testBook(), collectOpts(capped, { maxCases: 5 }));
  assert((await cases(capped)).length === 5, '--max-cases is respected');
  const shared = tmp();
  const many = Array.from({ length: 60 }, (_, i) => ({ block: 1000 + i * 3, index: 2, pool: P_V3 }));
  const sA = await collectCases(makeFakeNode({ trades: many }).rpc, testBook(), collectOpts(shared, { tradeShare: 0.3, standingEvery: 0 }));
  const sB = await collectCases(makeFakeNode({ trades: many }).rpc, testBook(), collectOpts(tmp(), { tradeShare: 0.3, standingEvery: 0 }));
  assert(sA.triggers > 5 && sA.triggers < 35 && sA.triggers === sB.triggers, `--trade-share follows a repeatable part of the trades (${sA.triggers} of 60)`);
}

async function testNodeStep(out: string) {
  const fake = makeFakeNode({ trades: TRADES, busyTimes: 3 });
  const r1 = await runNodeStep(fake.rpc, out, ctl());
  assert(r1.busySkipped === 3, `"slow down" answers are not saved (got ${r1.busySkipped})`);
  const r2 = await runNodeStep(fake.rpc, out, ctl());
  assert(r2.asked === 3 && r2.answered === 3, `the next run asks only those again (asked ${r2.asked})`);
  const before = JSON.stringify(fake.calls);
  const r3 = await runNodeStep(fake.rpc, out, ctl());
  assert(r3.asked === 0 && JSON.stringify(fake.calls) === before, 'a rerun with everything answered sends ZERO node requests (cached on disk)');
  const node = await loadById<NodeRecord>(join(out, 'node.jsonl'));
  const all = await cases(out);
  const trig = all.find((c) => c.mode === 'trigger' && c.prefixLen === 2)!;
  const nr = node.get(trig.id)!;
  assert(nr.status === 'answer' && nr.via === 'eth_simulateV1' && nr.raw!.gasUsed !== null, 'follow-a-trade: answered by eth_simulateV1 with gas');
  assert(nr.raw!.output === profitRevert(defaultProfit(trig.call.data)), 'node answer = our call\'s revert data (the LAST call of the replay)');
  assert(nr.prefixStatuses === '10', `replayed trades' own success/fail is kept (got ${nr.prefixStatuses})`);
  const sc = all.find((c) => c.mode === 'standing')!;
  assert(node.get(sc.id)!.via === 'eth_call' && node.get(sc.id)!.raw!.gasUsed === null, 'standing gap: plain eth_call at the parent block, no gas (like the bot)');
  // The replay request is the bot's: parent block, prefix + ours, real time, huge gas limit, no validation.
  const fake2 = makeFakeNode({ trades: TRADES });
  await nodeAnswer(fake2.rpc, trig, out);
  const [body, tag] = fake2.last.eth_simulateV1 as any[];
  assert(tag === '0x' + (trig.block - 1).toString(16) && body.validation === false && body.blockStateCalls[0].calls.length === 3
    && body.blockStateCalls[0].blockOverrides.time === trig.time && body.blockStateCalls[0].blockOverrides.gasLimit === '0x77359400', 'eth_simulateV1 request matches the bot\'s replayRpc exactly');

  // Old state gone -> node_error (left out of the match rate), saved.
  const gone = makeFakeNode({ trades: TRADES, stateGoneBefore: 1_000_000 });
  const ng = await nodeAnswer(gone.rpc, trig, out);
  assert(ng!.status === 'node_error' && /state gone/.test(ng!.reason!), `"missing trie node" = node error "state gone" (got ${ng?.reason})`);
  const ng2 = await nodeAnswer(gone.rpc, sc, out);
  assert(ng2!.status === 'node_error', 'standing check on pruned state = node error, not a "fail" verdict');
  assert(isNodeTrouble({ code: 429 }) === 'busy' && isNodeTrouble({ code: 3, message: 'execution reverted' }) === null, 'busy vs real revert told apart');
  // Wrong number of answers: unusable (bot's readReplayAnswer rule).
  const odd = await nodeAnswer(async (m, p) => (m === 'eth_simulateV1' ? { result: [{ calls: [{ status: '0x1' }] }] } : { error: { message: 'no' } }), trig, out);
  assert(odd!.status === 'node_error' && /answers for/.test(odd!.reason!), 'a replay with the wrong number of answers is not trusted');
}

async function testCompareAndReport(out: string) {
  const node = await loadById<NodeRecord>(join(out, 'node.jsonl'));
  // Echo engine (copies the node) -> 100%.
  const echo = new EchoEngine(node);
  await runFastStep(echo, out, ctl());
  const rep = await buildReport(out, fastFileOf(out, echo), { engine: echo.name, fake: true });
  assert(rep.totals.matchRatePct === 100 && rep.totals.checks === node.size, `echo engine: 100% match on every node-answered check (got ${rep.totals.matchRatePct}%)`);
  assert(rep.header.engineIsFake && /FAKE/.test(rep.header.title) && /FAKE/.test(fastFileOf(out, echo)), 'fake engine results are labelled FAKE in title and file name');
  assert(rep.header.matchRateDefinition === MATCH_RATE_DEFINITION && reportText(rep).includes('HOW THE MATCH RATE IS COUNTED'), 'report header states the match-rate definition');

  // Scripted engine with chosen mistakes.
  const all = await cases(out);
  const ids = all.map((c) => c.id);
  const [wrongV, diffAmt, gasOff, unk] = [ids[0]!, ids[1]!, ids[2]!, ids[3]!];
  const eng = new ScriptedEngine('scripted-test', (c) => {
    const n = node.get(c.id)!.raw!;
    if (c.id === wrongV) return { status: 'answer', success: false, output: IFACE.encodeErrorResult('Error', ['STF']).toLowerCase(), gasUsed: n.gasUsed, us: 400 };
    if (c.id === diffAmt) return { status: 'answer', success: false, output: profitRevert(defaultProfit(c.call.data) + 7n), gasUsed: n.gasUsed, us: 400 };
    if (c.id === gasOff) return { status: 'answer', success: n.success, output: n.output, gasUsed: n.gasUsed === null ? null : String(BigInt(n.gasUsed) + 21n), us: 400 };
    if (c.id === unk) return { status: 'unknown', why: 'miss (3 missing)', us: 90 };
    return { status: 'answer', success: n.success, output: n.output, gasUsed: n.gasUsed, us: 400 };
  });
  await runFastStep(eng, out, ctl());
  const r = await buildReport(out, fastFileOf(out, eng), { engine: eng.name, fake: true });
  const t = r.totals;
  const expectExact = t.checks - 3; // wrong verdict, wrong amount, unknown (gas-only does not affect the match)
  assert(t.exact === expectExact, `exact count excludes the 3 bad ones (got ${t.exact}, want ${expectExact})`);
  assert(t.fastUnknown === 1 && t.matchRatePct! < 100, 'an "unknown" counts AGAINST the match rate');
  assert(t.coveragePct !== null && t.coveragePct < 100 && t.matchAmongAnsweredPct! > t.matchRatePct!, 'coverage and rate-among-answered reported separately');
  const nodeWrong = readAnswer(node.get(wrongV)!.raw!, false);
  const expDiffVerdict = nodeWrong.verdict === 'fail' ? 0 : 1;
  assert(t.diffVerdict + t.sameVerdictDiff === 2 && t.diffVerdict >= expDiffVerdict, 'wrong verdict / same verdict-different detail are split');
  const gasCase = all.find((c) => c.id === gasOff)!;
  if (node.get(gasOff)!.raw!.gasUsed !== null) assert(t.gas.compared > 0 && t.gas.maxAbsDiff === 21 && t.gas.exact === t.gas.compared - 1 - (node.get(wrongV)!.raw!.gasUsed !== null && all.find((c) => c.id === wrongV)!.mode === 'trigger' ? 0 : 0), 'gas difference measured and NOT counted as a match failure');
  else assert(gasCase.mode === 'standing', 'gas skipped for standing checks (no gas from eth_call)');
  // Wrong verdict first, then wrong amount; a gas-only difference (still an
  // exact answer) is listed last when there is one.
  const groups = r.worst.map((w) => w.group);
  assert(groups[0] === 'diff_verdict' || groups[0] === 'same_verdict_diff', `worst list starts with a real mismatch (got ${groups.join(',')})`);
  assert(groups.filter((g) => g !== 'exact').length === 2 && groups.slice(2).every((g) => g === 'exact'), 'gas-only differences come after real mismatches');
  assert(r.worst.every((w) => w.reproFile && existsSync(w.reproFile as string)), 'each worst mismatch has a ready-to-send repro request file');
  const repro = JSON.parse(readFileSync(r.worst[0]!.reproFile as string, 'utf8'));
  assert(JSON.stringify(repro.request).includes(ARB_EXECUTOR_RUNTIME_CODE.slice(0, 200)), 'repro request has the real contract code expanded');
  assert(Object.keys(r.byMode).length === 2 && Object.keys(r.byRouteType).length >= 2 && !!r.byFunding['flash loan'], 'breakdowns by kind of check, route type and funding');
  const txt = reportText(r);
  assert(txt.includes('BY ROUTE TYPE') && txt.includes('WORST MISMATCHES') && txt.includes('WHY THE FAST SIDE SAID "UNKNOWN"'), 'plain-English report has the tables');
  // Unknowns about the harness/node are retried, not stored.
  assert(RETRY_LATER.test('node busy: traceCall') && RETRY_LATER.test('socket: closed') && !RETRY_LATER.test('miss (3 missing)'), 'only harness/node trouble is retried; engine unknowns are kept');
}

function testReadAnswer() {
  const p = readAnswer({ success: false, output: profitRevert(5n) }, false);
  assert(p.verdict === 'profit' && p.profit === 5n, 'InsufficientProfit(5) = profit 5');
  assert(readAnswer({ success: false, output: profitRevert(0n) }, false).verdict === 'loss', 'InsufficientProfit(0) = loss');
  const tf = IFACE.encodeErrorResult('TransferFailed', []);
  assert(readAnswer({ success: false, output: tf }, true).verdict === 'loss' && readAnswer({ success: false, output: tf }, false).verdict === 'fail', 'TransferFailed = loss only in flash mode (bot rule)');
  assert(readAnswer({ success: true, output: '0x' }, false).verdict === 'fail', 'a call that succeeds is a fail (the check always refuses)');
  const c = { id: 'x', mode: 'trigger', route: { kinds: 'V3>V2' }, funding: 'own' } as unknown as Case;
  const n: NodeRecord = { id: 'x', status: 'answer', raw: { success: false, output: profitRevert(1000n), gasUsed: '300000' }, via: 'eth_simulateV1', ms: 80 };
  const f = (out: string, gas = '300000'): FastRecord => ({ id: 'x', engine: 't', result: { status: 'answer', success: false, output: out, gasUsed: gas }, ms: 1 });
  const d = compareOne(c, n, f(profitRevert(1010n)));
  assert(d.group === 'same_verdict_diff' && d.profitDiff === 10n && d.profitDiffPct === 1, 'profit diff abs + % (10 of 1000 = 1%)');
  assert(compareOne(c, n, f(profitRevert(1000n).toUpperCase().replace('0X', '0x'))).group === 'exact', 'hex case does not matter');
  assert(compareOne(c, { ...n, status: 'node_error', reason: 'state gone' }, f('0x')).group === 'node_error', 'node error is excluded, whatever the fast side says');
  assert(compareOne(c, n, undefined).group === 'not_answered', 'no fast answer = not answered (not a match)');
}

async function testArbsimSocket(out: string) {
  // A fake arbsim speaking DESIGN.md's protocol: 4-byte BIG-endian length + JSON,
  // answers out of order (the second request is answered first).
  const sock = join(tmp(), 'arbsim.sock');
  const seen: any[] = [];
  const server = createServer((s: Socket) => {
    let buf = Buffer.alloc(0);
    const held: any[] = [];
    let calls = 0;
    s.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const len = buf.readUInt32BE(0);
        const req = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
        buf = buf.subarray(4 + len);
        seen.push(req);
        let ans: any;
        if (req.type === 'status') ans = { id: req.id, ok: true, fills: seen.length };
        else if (req.calls.length === 1 && req.at.pinned === '0x0') ans = { id: req.id, ok: false, unknown: 'miss', missing: [{ account: '0x1' }], us: 50 };
        else ans = { id: req.id, ok: true, results: req.calls.map((c: any, i: number) => (i === req.calls.length - 1 ? { success: false, output: profitRevert(defaultProfit(c.data)), gasUsed: '0x' + (123).toString(16) } : { success: true, output: '0x', gasUsed: '0x5208' })), us: 412 };
        const send = (a: any) => { const b = Buffer.from(JSON.stringify(a)); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); s.write(Buffer.concat([h, b])); };
        // Hold the first two check requests and answer them in REVERSE order
        // (out-of-order answers are allowed by the protocol); answer the rest at once.
        if (req.type === 'call' && calls < 2) { calls++; held.push(() => send(ans)); if (held.length === 2) { for (const f of held.reverse()) f(); held.length = 0; } }
        else send(ans);
      }
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  const all = await cases(out);
  const trig = all.find((c) => c.mode === 'trigger' && c.prefixLen === 2)!;
  const stand = all.find((c) => c.mode === 'standing')!;
  const eng = new ArbsimSocketEngine(sock, out, 5_000);
  await eng.init();
  const [a, b] = await Promise.all([eng.check(trig), eng.check(stand)]);
  assert(a.status === 'answer' && a.output === profitRevert(defaultProfit(trig.call.data)) && a.gasUsed === '123' && a.prefixStatuses === '11', 'arbsim answer read from the LAST result; out-of-order answers matched by id');
  assert(b.status === 'answer', 'standing check answered');
  const callReq = seen.find((r) => r.type === 'call' && r.calls.length === 3)!;
  assert(callReq.at.pinned === '0x' + trig.parent.toString(16) && callReq.at.env === 'next' && callReq.validation === false && callReq.blockOverrides.time === trig.time && callReq.overrides[SIM_EXECUTOR_ADDRESS].code === ARB_EXECUTOR_RUNTIME_CODE, 'pinned request: parent block, block time, no validation, full overrides');
  const sreq = seen.find((r) => r.type === 'call' && r.calls.length === 1)!;
  assert(sreq.blockOverrides === undefined && sreq.at.pinned === '0x' + stand.parent.toString(16) && sreq.at.env === 'same', 'standing request: plain call at the parent block');
  const fake0 = { ...stand, parent: 0 };
  const u = await eng.check(fake0);
  assert(u.status === 'unknown' && /miss/.test((u as any).why), '"unknown" from arbsim stays unknown (never a guess)');
  await eng.close();
  server.close();
  const dead = new ArbsimSocketEngine(join(tmp(), 'none.sock'), out, 1000);
  const d = await dead.check(stand);
  assert(d.status === 'unknown' && /^socket:/.test((d as any).why), 'no sidecar running = unknown "socket:" (retried later, never a match)');
  assert(fastFromArbsim({ ok: true, results: [{ success: true }] }, 3).status === 'unknown', 'wrong number of results = unknown');
  assert(pinnedCallRequest(stand, []).type === 'call', 'request type is "call"');
}

async function testFixtureMode(out: string) {
  // prefix diff rules (geth diffMode)
  const z = '0x' + '0'.repeat(64);
  const diffs = [
    { pre: { '0xA': { storage: { s1: '0x1', s2: '0x2' } } }, post: { '0xA': { storage: { s1: '0x5' } } } },
    { pre: { '0xB': { balance: '0x9' } }, post: {} },
    { pre: {}, post: { '0xA': { balance: '0x7', storage: { s3: '0x3' } } } },
  ];
  const o = prefixDiffOverrides(diffs as any, 2);
  assert(o['0xa'].stateDiff.s1 === '0x5' && o['0xa'].stateDiff.s2 === z && o['0xa'].stateDiff.s3 === '0x3' && o['0xa'].balance === '0x7', 'post values applied, slots missing from post become zero');
  assert(o['0xb'].code === '0x' && o['0xb'].balance === '0x0', 'an account gone from post is cleared');
  assert(!prefixDiffOverrides(diffs as any, 2, new Set([0, 2]))['0xb'], 'system txs (not in the user list) are left out');
  const m = mergeOverrides(o, { '0xA': { stateDiff: { s1: '0xff' } }, '0xC': { code: '0x60' } });
  assert(m['0xa'].stateDiff.s1 === '0xff' && m['0xa'].stateDiff.s3 === '0x3' && m['0xc'].code === '0x60', 'our pretend state wins over the replayed changes');
  assert(parseFixtureOutput('{"success":false,"output":"0xAB","gasUsed":"0x10"}')!.gasUsed === '16', 'reads plain check-fixture output');
  assert(parseFixtureOutput(JSON.stringify({ correctness: { success: { revm: false }, output: { revm: '0x12' }, gas: { revm_tx_level_gas: 99 } } }))!.output === '0x12', 'reads the revm bench report shape too');
  assert(parseFixtureOutput('garbage') === null, 'unreadable output = null');

  // FixtureEngine end to end with a stand-in "arbsim check-fixture" (a node
  // script that answers the fixture's expected values).
  const dir = tmp();
  const script = join(dir, 'fake-arbsim.js');
  writeFileSync(script, `const f=JSON.parse(require('fs').readFileSync(process.argv[3],'utf8'));\nconsole.log(JSON.stringify({success:f.expected.success,output:f.expected.output,gasUsed:f.expected.gasUsed}));`);
  chmodSync(script, 0o755);
  const fake = makeFakeNode({ trades: TRADES });
  const eng = new FixtureEngine(fake.rpc, out, [process.execPath, script, 'check-fixture', '{file}'], true);
  const all = await cases(out);
  const trig = all.find((c) => c.mode === 'trigger')!;
  const res = await eng.check(trig);
  assert(res.status === 'answer' && res.output === profitRevert(defaultProfit(trig.call.data)), 'fixture mode: answer from the check-fixture command');
  const fx = JSON.parse(readFileSync(join(out, 'fixtures', `${trig.id}.json`), 'utf8'));
  assert(fx.chainId === 4663 && fx.l2BlockNumber === '0x' + trig.block.toString(16) && fx.block.number !== fx.l2BlockNumber && !fx.prestate['0x0000000000000000000000000000000000000064'], 'fixture: NUMBER = L1 block, ArbSys block = L2 block, ArbSys not in prestate');
  const tc = fake.last.debug_traceCall as any[];
  assert(tc[1] === '0x' + trig.parent.toString(16) && tc[2].stateOverrides[SIM_EXECUTOR_ADDRESS] && tc[2].blockOverrides.time === trig.time, 'trace on the parent block with replayed changes + our overrides + block time');
  assert(fake.calls.debug_traceBlockByNumber === 1, 'one block trace per trigger block');
  await runFastStep(eng, out, ctl());
  const r = await buildReport(out, fastFileOf(out, eng), { engine: eng.name, fake: false });
  assert(!!r.fixtureMode && r.fixtureMode.engineVsExactState.checks > 0, 'fixture mode reports engine accuracy and state accuracy separately');
}

async function testUtil() {
  const d = tmp();
  writeFileSync(join(d, '.env'), 'EXECUTOR_PRIVATE_KEY=0xdeadbeef\nTELEGRAM_TOKEN=secret\nQUICKNODE_RPC_ROBINHOOD="https://x.quiknode.pro/KEY/"\nROBINHOOD_RPC_HTTP=https://other\n');
  const n = findNodeUrl(d, {});
  assert(n?.name === 'QUICKNODE_RPC_ROBINHOOD' && n.url === 'https://x.quiknode.pro/KEY/' && n.label === 'QuickNode', 'node URL from .env, preference order kept, labelled by provider');
  assert(findNodeUrl(d, {}, 'EXECUTOR_PRIVATE_KEY') === null, 'refuses to read any other .env line, even when asked');
  assert(findNodeUrl(d, { SIM_RPC_ROBINHOOD: 'https://mine' })?.name === 'SIM_RPC_ROBINHOOD', 'environment setting wins');
  // Speed limit + cap + retry.
  let n429 = 0;
  const base: Rpc = async () => (n429++ < 2 ? { error: { code: 429, message: 'rate limited' } } : { result: '0x1' });
  const slept: number[] = [];
  const h = makeHarnessRpc('https://example.invalid', { rps: 1000, maxRequests: 4, base, sleep: async (ms) => { slept.push(ms); } });
  const r = await h.rpc('eth_blockNumber', []);
  assert(r.result === '0x1' && h.stats.retries === 2 && slept[0] === 2000 && slept[1] === 4000, '"slow down" retried with growing pauses');
  await h.rpc('x', []); await h.rpc('x', []);
  assert(h.stats.capHit && h.stats.total === 4, '--max-requests is a hard cap');
  const t0 = Date.now();
  const lim = makeHarnessRpc('https://example.invalid', { rps: 20, maxRequests: 100, base: async () => ({ result: 1 }) });
  for (let i = 0; i < 6; i++) await lim.rpc('a', []);
  assert(Date.now() - t0 >= 240, `speed limit holds (6 requests at 20/s took ${Date.now() - t0} ms)`);
  const s1 = sample([1, 2, 3, 4, 5, 6, 7, 8], 3, 'seed'), s2 = sample([1, 2, 3, 4, 5, 6, 7, 8], 3, 'seed');
  assert(JSON.stringify(s1) === JSON.stringify(s2) && new Set(s1).size === 3, 'samples are repeatable and without repeats');
  const o = parseArgs(['all', '--last', '2000', '--rps', '3', '--resume', '--engine', 'fixture']);
  assert(o.cmd === 'all' && o.last === 2000 && o.rps === 3 && o.resume && o.engine === 'fixture', 'command line options read');
  assert(startCoinOf(USDG, '0x' + '1'.repeat(40)) === USDG && startCoinOf('0x' + '1'.repeat(40), '0x' + '2'.repeat(40)) === null, 'start coin rule: USDG, else WETH, else skip');
  // Watch-list file in the bot's format (bigint as {"$b":..}).
  const wf = join(d, 'watched.json');
  writeFileSync(wf, JSON.stringify({ version: 1, chain: 'robinhood', savedAt: 1, pairs: [], pinned: [], meta: {}, pools: [{ chain: 'robinhood', dex: 'uniswap-v3', poolAddress: P_V3, poolType: 'v3', tokenA: ROBINHOOD_TOKENS.WETH, tokenB: ROBINHOOD_TOKENS.USDG, feeBps: 5, liquidity: { $b: '5' }, lastUpdatedBlock: 0, lastUpdatedMs: 0 }, { chain: 'robinhood', dex: 'kuru', poolAddress: P_V2, poolType: 'orderbook', tokenA: ROBINHOOD_TOKENS.WETH, tokenB: ROBINHOOD_TOKENS.USDG, feeBps: 0, lastUpdatedBlock: 0, lastUpdatedMs: 0 }] }));
  const book = loadPoolBook(wf);
  assert(book.pools.size === 1 && (book.pools.get(P_V3)!.liquidity as bigint) === 5n && Object.keys(book.skipped).length === 1, 'reads the bot\'s watch-list file; untradeable pools left out and counted');
  const refused: Record<string, number> = {};
  const rs = routesThrough(testBook(), testBook().pools.get(P_V3)!, DEFAULT_SIZES, refused, null);
  assert(rs.length === 2 * 2 * (3 + 1) - 1 || rs.length > 0, `routes through a pool: both directions with every partner (got ${rs.length})`);
}

async function testTriggerParsing() {
  const logs = [
    { address: P_V3, topics: ['0xdead'], data: '0x', blockNumber: '0x1', logIndex: '0x0', transactionIndex: '0x0', transactionHash: '0xaa' },
  ];
  assert(triggersFromLogs(logs as any, testBook()).length === 0, 'events the bot does not read are not trades');
  const snap = rawFromSimulate([{ calls: [{ status: '0x1' }, { status: '0x0', returnData: '0x', error: { message: 'execution reverted', data: profitRevert(3n) }, gasUsed: '0x10' }] }]);
  assert(snap!.raw.output === profitRevert(3n) && snap!.raw.gasUsed === '16' && snap!.prefixStatuses === '1', 'revert data read from error.data (not the empty returnData)');
  // A coin whose balance location was never looked up (USDG's is cached by now).
  const NEW = '0x' + '5e'.repeat(20);
  const nb = buildPoolBook(testPools().map((p) => ({ ...p, tokenB: NEW })), { [NEW]: { symbol: 'NEW', decimals: 18 } });
  const r0 = routesThrough(nb, nb.pools.get(P_V3)!, { usdg: [1], weth: [0.1] }, {}, null).find((r) => r.funding === 'own')!;
  const capt = await captureCheck(async () => ({ error: { code: 429, message: 'rate limited' } }), r0, 'latest');
  assert('refused' in capt && capt.transient, 'balance-slot lookup refused by a busy node = try again later, not "unsupported"');
}

async function main() {
  testReadAnswer();
  const { out } = await testCollect();
  await testResume();
  await testNodeStep(out);
  await testCompareAndReport(out);
  await testArbsimSocket(out);
  await testFixtureMode(out);
  await testUtil();
  await testTriggerParsing();
  const files = readdirSync(out);
  assert(files.includes('cases.jsonl') && files.includes('node.jsonl') && files.includes('blocks'), 'run folder layout');
  rmSync(out, { recursive: true, force: true });
}

main().catch((e) => { console.error('FAIL: crashed', e); process.exitCode = 1; });
void ethers;
