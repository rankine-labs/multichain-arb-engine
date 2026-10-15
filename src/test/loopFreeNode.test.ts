// Tests for "loop checks on the free node" (core/loopNode.ts, Oct 15, owner approved):
//   A) switches: LOOP_CHECK_NODE free (default) / main, LOOP_CHECK_RPC, LOOP_CHECK_DAILY
//   B) LOOP_CHECK_NODE=free: a loop check never calls the main node, and
//      never changes the 2-pool check counter (simInFlight)
//   C) "slow down" from the loop node: pause 60 s, doubling to 10 min, reset by a clean check
//   D) replay not supported on the loop node: checked once, then end-of-block checks
//   E) LOOP_CHECK_NODE=main: exactly the old steps (main node, free node second opinion)
//   F) the hourly line shows the loop node
import { loopNodeFromEnv, LoopNodeGuard, runLoopCheck, LoopCheckDeps, LoopSpot, loopNodeText, isMethodMissing } from '../core/loopNode';
import type { Rpc, SimResult } from '../execution/simulator';
import type { LoopTrade } from '../core/loopTrader';
import { loopLogLine } from '../core/loopReport';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const STATE_GONE = /missing trie node|historical state|state.*(not available|unavailable)|header not found|unknown block|pruned/i;
const trade: LoopTrade = { token: '0xw', amountIn: 10n ** 18n, hops: [] };
const spot: LoopSpot = { block: '0x10', parent: '0xf', prefix: [{ from: '0x1', to: '0x2', data: '0x' }], time: '0x1' };
const quiet = () => {};

// A fake node that remembers every request it got.
function fakeNode(name: string, answer: (method: string) => { result?: any; error?: any } = () => ({ result: '0x' })) {
  const calls: string[] = [];
  const rpc: Rpc = async (method) => { calls.push(method); return answer(method); };
  return { name, calls, rpc };
}

// Builds deps where "simulate" asks the given node once (so we can see which
// node each step used) and answers from a script.
function deps(loop: Rpc, second: Rpc | null, script: (step: number, blockTag?: string, viaReplay?: boolean) => SimResult, over: Partial<LoopCheckDeps> = {}) {
  let step = 0;
  const used: string[] = [];
  const REPLAY = Symbol('replay');
  const d: LoopCheckDeps = {
    rpc: loop,
    secondOpinion: second,
    simulate: async (rpc, _t, opts) => {
      const viaReplay = (rpc as any)[REPLAY] === true;
      await rpc(viaReplay ? 'eth_simulateV1' : 'eth_call', []);
      used.push(viaReplay ? 'replay' : opts.blockTag ? `block ${opts.blockTag}` : 'latest');
      return script(step++, opts.blockTag, viaReplay);
    },
    findSpot: async (rpc) => { await rpc('eth_getTransactionReceipt', []); await rpc('eth_getBlockByNumber', []); return spot; },
    replay: (rpc) => { const r: Rpc = (m, p) => rpc(m, p); (r as any)[REPLAY] = true; return r; },
    stateGone: STATE_GONE,
    weth: '0xw',
    triggerReplay: true,
    tagLatest: true,
    replayAllowed: () => true,
    lean: true,
    ...over,
  };
  return { d, used };
}

async function main() {
  // ---------------- A) switches ----------------
  {
    const warns: string[] = [];
    const w = (m: string) => warns.push(m);
    const dflt = loopNodeFromEnv({}, w);
    assert(dflt.mode === 'free' && dflt.customUrl === null && dflt.label === 'free public node' && dflt.dailyCap === 3_000, 'default: free public node, 3000 a day');
    assert(loopNodeFromEnv({ LOOP_CHECK_NODE: 'main' }, w).mode === 'main', 'LOOP_CHECK_NODE=main: main mode');
    const typo = loopNodeFromEnv({ LOOP_CHECK_NODE: 'chainstack' }, w);
    assert(typo.mode === 'free' && warns.some((m) => m.includes('using free')), 'typo: free (safe) with a warning');
    const own = loopNodeFromEnv({ LOOP_CHECK_RPC: 'https://example.com/secret-key' }, w);
    assert(own.customUrl === 'https://example.com/secret-key' && !own.label.includes('example') && own.label.includes('LOOP_CHECK_RPC'), 'LOOP_CHECK_RPC: used, never in the label');
    assert(loopNodeFromEnv({ LOOP_CHECK_NODE: 'main', LOOP_CHECK_RPC: 'https://x.io' }, w).customUrl === null, 'LOOP_CHECK_RPC ignored in main mode');
    assert(loopNodeFromEnv({ LOOP_CHECK_DAILY: '0' }, w).dailyCap === Infinity && loopNodeFromEnv({ LOOP_CHECK_DAILY: '50' }, w).dailyCap === 50, 'LOOP_CHECK_DAILY: 0 = no limit, 50 = 50');
    assert(warns.every((m) => !m.includes('secret-key')), 'URL never printed in warnings');
  }

  // ---------------- B) free mode never touches the main node ----------------
  {
    const main = fakeNode('main', () => { throw new Error('main node called'); });
    const free = fakeNode('free');
    const simInFlight: Record<string, number> = { robinhood: 1 }; // a 2-pool check is running
    const before = JSON.stringify(simInFlight);
    // Replay says "no reason" fail -> end of block also "no reason" -> second opinion would be next.
    const noReason: SimResult = { status: 'fail', reason: 'execution reverted' };
    const { d, used } = deps(free.rpc, null, () => noReason);
    let threw = false;
    let r: any;
    try { r = await runLoopCheck(d, trade, '0xhash'); } catch { threw = true; }
    assert(!threw && main.calls.length === 0, 'free mode, trigger + replay + no-reason recheck: main node never called');
    assert(free.calls.includes('eth_getTransactionReceipt') && free.calls.includes('eth_simulateV1'), 'receipt polling and replay went to the free node');
    assert(used.join(',') === 'replay,block 0x10', `second opinion skipped in free mode (steps: ${used.join(',')})`);
    assert(r.timing === 'end of trigger block (replay failed)', `label honest (${r.timing})`);
    // No trigger: one latest check, free node only.
    const { d: d2 } = deps(free.rpc, null, () => ({ status: 'loss' }));
    const r2 = await runLoopCheck(d2, trade);
    assert(r2.timing === 'latest' && main.calls.length === 0, 'free mode, no trigger: latest on the free node');
    assert(JSON.stringify(simInFlight) === before, 'simInFlight not changed by loop checks');
    // The guard's watched node passes answers through untouched.
    const g = new LoopNodeGuard(loopNodeFromEnv({}), () => 0, quiet);
    const watched = g.watch(free.rpc);
    const ans = await watched('eth_call', []);
    assert(ans.result === '0x', 'watched node: answers pass through');
  }

  // ---------------- C) rate-limit backoff ----------------
  {
    let t = 1_000_000;
    const logs: string[] = [];
    const g = new LoopNodeGuard(loopNodeFromEnv({}), () => t, (m) => logs.push(m));
    assert(g.canCheck(), 'not paused at start');
    const busy = fakeNode('free', () => ({ error: { code: 429, message: 'rate limited (HTTP 429)' } }));
    const node = g.watch(busy.rpc);
    g.noteStart();
    await node('eth_getTransactionReceipt', []);
    await node('eth_call', []); // second answer in the same check: same pause
    assert(!g.canCheck(), 'paused after "slow down"');
    assert(g.peekHour().pauses === 1 && g.peekHour().rateLimited === 2, 'two answers, one pause');
    t += 59_000; assert(!g.canCheck(), 'still paused at 59 s');
    t += 2_000; assert(g.canCheck(), 'resumes after 60 s');
    g.noteStart(); g.noteRateLimit(); t += 119_000; assert(!g.canCheck(), 'second pause: 2 min');
    t += 2_000; assert(g.canCheck(), 'second pause over after 2 min');
    for (let i = 0; i < 6; i++) { g.noteStart(); g.noteRateLimit(); t += 10 * 60_000 + 1; }
    g.noteStart(); g.noteRateLimit(); t += 10 * 60_000 - 1_000; assert(!g.canCheck(), 'pause capped at 10 min (still paused just before)');
    t += 2_000; assert(g.canCheck(), 'pause never longer than 10 min');
    g.noteStart(); g.noteResult({ status: 'loss' }); // clean check
    g.noteStart(); g.noteRateLimit(); t += 61_000; assert(g.canCheck(), 'a clean check resets the pause to 60 s');
    g.noteStart(); g.noteResult({ status: 'rate_limited', reason: 'too many requests' });
    assert(!g.canCheck(), 'a rate_limited check result also pauses');
    assert(logs.some((m) => m.includes('paused 60 s') && m.includes('2-pool checks not affected')), 'pause logged in plain words');
    // network trouble counts too
    t += 10 * 60_000 + 1;
    const g2 = new LoopNodeGuard(loopNodeFromEnv({}), () => t, quiet);
    await g2.watch(fakeNode('x', () => ({ error: { message: 'network: timeout' } })).rpc)('eth_call', []);
    assert(!g2.canCheck(), 'unreachable node: paused too');
    // override unsupported: 30 min
    const g3 = new LoopNodeGuard(loopNodeFromEnv({}), () => t, quiet);
    g3.noteStart(); g3.noteResult({ status: 'unsupported', reason: 'state override not supported' });
    t += 29 * 60_000; const still = !g3.canCheck(); t += 2 * 60_000;
    assert(still && g3.canCheck(), 'node without state overrides: loop checks paused 30 min');
    // daily cap
    let day = 'd1';
    const g4 = new LoopNodeGuard(loopNodeFromEnv({ LOOP_CHECK_DAILY: '2' }), () => t, quiet, () => day);
    g4.noteStart(); g4.noteStart();
    assert(!g4.canCheck(), 'daily cap reached: no more loop checks');
    day = 'd2'; assert(g4.canCheck() && g4.peekHour().today === 0, 'new day: count starts again');
    // takeHour resets the hour counts, keeps today's
    const g5 = new LoopNodeGuard(loopNodeFromEnv({}), () => t, quiet);
    g5.noteStart(); g5.noteRateLimit();
    const h = g5.takeHour();
    assert(h.pauses === 1 && h.rateLimited === 1 && g5.peekHour().pauses === 0 && g5.peekHour().today === 1, 'takeHour resets the hour, keeps today');
  }

  // ---------------- D) replay not supported ----------------
  {
    const t = 5_000_000;
    const logs: string[] = [];
    const g = new LoopNodeGuard(loopNodeFromEnv({}), () => t, (m) => logs.push(m));
    const node = fakeNode('free', (m) => m === 'eth_simulateV1' ? { error: { code: -32601, message: 'the method eth_simulateV1 does not exist/is not available' } } : { result: '0x' });
    const watched = g.watch(node.rpc);
    assert(await g.probeReplay(watched) === 'no', 'probe: method missing -> not supported');
    const probes = node.calls.filter((c) => c === 'eth_simulateV1').length;
    await g.probeReplay(watched); await g.probeReplay(watched);
    assert(node.calls.filter((c) => c === 'eth_simulateV1').length === probes && probes === 1, 'asked only once');
    assert(logs.filter((m) => m.includes('replay not supported on loop node')).length === 1, 'logged once: "replay not supported on loop node"');
    const { d, used } = deps(watched, null, () => ({ status: 'loss' }), { replayAllowed: () => g.replay !== 'no' });
    const r = await runLoopCheck(d, trade, '0xhash');
    assert(used.join(',') === 'block 0x10' && r.timing === 'end of trigger block', `no replay tried, end of trigger block used (${used.join(',')}, ${r.timing})`);
    assert(node.calls.filter((c) => c === 'eth_simulateV1').length === 1, 'no further eth_simulateV1 requests');
    // State gone at the end of the block: latest.
    const { d: d2, used: u2 } = deps(watched, null, (s) => s === 0 ? { status: 'fail', reason: 'missing trie node' } : { status: 'loss' }, { replayAllowed: () => false });
    const r2 = await runLoopCheck(d2, trade, '0xhash');
    assert(u2.join(',') === 'block 0x10,latest' && r2.timing === 'tested late', 'block state gone: latest ("tested late")');
    // No-reason fail at end of block, lean: not repeated.
    const { d: d3, used: u3 } = deps(watched, null, () => ({ status: 'fail', reason: 'execution reverted' }), { replayAllowed: () => false });
    const r3 = await runLoopCheck(d3, trade, '0xhash');
    assert(u3.join(',') === 'block 0x10' && r3.timing === 'end of trigger block', 'free mode: same end-of-block check not repeated');
    assert(loopNodeText(g.peekHour()).includes('replay not supported on loop node'), 'hour text says replay not supported');
    // Busy node during the probe: unknown, not asked again for 10 min.
    let tt = 0;
    const gb = new LoopNodeGuard(loopNodeFromEnv({}), () => tt, quiet);
    const busy = fakeNode('b', () => ({ error: { code: 429, message: 'too many requests' } }));
    assert(await gb.probeReplay(busy.rpc) === 'unknown', 'busy node: answer unclear');
    await gb.probeReplay(busy.rpc); tt += 9 * 60_000; await gb.probeReplay(busy.rpc);
    assert(busy.calls.length === 1, 'unclear answer: not asked again within 10 min');
    tt += 2 * 60_000; await gb.probeReplay(busy.rpc);
    assert(busy.calls.length === 2, 'asked again after 10 min');
    // Supported: yes, and a real replay works.
    const gy = new LoopNodeGuard(loopNodeFromEnv({}), () => 0, quiet);
    assert(await gy.probeReplay(fakeNode('y', () => ({ result: [{ calls: [] }] })).rpc) === 'yes', 'probe: method present -> supported');
    const gi = new LoopNodeGuard(loopNodeFromEnv({}), () => 0, quiet);
    assert(await gi.probeReplay(fakeNode('i', () => ({ error: { code: -32602, message: 'invalid params' } })).rpc) === 'yes', 'probe: method present but empty test refused -> supported');
    // Learned from a real replay answer too (no probe).
    const gl = new LoopNodeGuard(loopNodeFromEnv({}), () => 0, quiet);
    await gl.watch(node.rpc)('eth_simulateV1', []);
    assert(gl.replay === 'no', 'method missing seen during a real replay: marked not supported');
    assert(isMethodMissing({ code: -32601 }) && !isMethodMissing({ message: 'missing trie node' }) && !isMethodMissing({ message: 'state not available' }), 'method-missing test does not confuse state-gone errors');
  }

  // ---------------- E) main mode: old steps ----------------
  {
    const main = fakeNode('main');
    const free = fakeNode('free');
    // replay no-reason -> block no-reason -> free node answers loss
    const { d, used } = deps(main.rpc, free.rpc, (s) => s < 2 ? { status: 'fail', reason: 'execution reverted' } : { status: 'loss' }, { lean: false });
    const r = await runLoopCheck(d, trade, '0xhash');
    assert(main.calls.includes('eth_getTransactionReceipt') && main.calls.includes('eth_simulateV1'), 'main mode: trigger and replay on the main node');
    assert(used.join(',') === 'replay,block 0x10,latest' && free.calls.length === 1 && r.timing === 'tested late on free node (replay failed)', `main mode: free node second opinion as before (${used.join(',')}, ${r.timing})`);
    // replay unavailable -> end of block -> no reason -> repeated at block (old behaviour) -> free node
    const main2 = fakeNode('main'); const free2 = fakeNode('free');
    const { d: d2, used: u2 } = deps(main2.rpc, free2.rpc, (s) => s === 0 ? { status: 'fail', reason: 'replay unavailable' } : s < 3 ? { status: 'fail', reason: 'execution reverted' } : { status: 'loss' }, { lean: false });
    await runLoopCheck(d2, trade, '0xhash');
    assert(u2.join(',') === 'replay,block 0x10,block 0x10,latest', `main mode: old step order kept (${u2.join(',')})`);
    // No trigger, switches off: the plain answer, no timing.
    const { d: d3 } = deps(main.rpc, free.rpc, () => ({ status: 'loss' }), { lean: false, triggerReplay: false, tagLatest: false });
    const r3 = await runLoopCheck(d3, trade, '0xhash');
    assert(r3.status === 'loss' && (r3 as any).timing === undefined, 'switches off: exactly the old answer');
    assert(loopNodeText({ label: 'main checking node', mode: 'main', replay: 'unknown', rateLimited: 0, pauses: 0, pausedForMs: 0, today: 0, dailyCap: 3000 }) === 'loop node main checking node', 'main mode hour text');
  }

  // ---------------- F) hourly line ----------------
  {
    const h: any = { found: 1, bestUsd: 1, checked: 1, wouldMake: 0, wouldMakeUsd: 0, lost: 1, failed: 0, cantRun: 0, cantRunWhy: [], skippedCap: 0,
      foundByLen: [0, 0, 0, 1], topRoutes: [], updates: 0, medianMs: null, slowestMs: null, cycles: 0, capped: false, cyclesByLen: [], rebuild: null,
      rival: { loops: 0, comparable: 0, weFound: 0, leadMsMedian: null, longer: 0, unseen: 0, topBot: null }, checkVsEstimate: { n: 0, medianEstUsd: null, medianResultUsd: null, medianDelayMs: null, lossesQuick: 0, lossesSlow: 0, topFail: null } };
    const node = loopNodeText({ label: 'free public node', mode: 'free', replay: 'yes', rateLimited: 3, pauses: 2, pausedForMs: 30_000, today: 140, dailyCap: 3000 });
    const line = loopLogLine(h, 3, 'hour', node);
    assert(line.startsWith('[loop] hour: found 1') && line.includes('by length 3p 1, loop node free public node (replay ok), rate limited 3, paused 2, paused now 30 s, today 140/3000'), `hour line shows the loop node (${line})`);
    assert(loopLogLine(h, 3, 'hour') === loopLogLine(h, 3, 'hour', undefined) && !loopLogLine(h, 3, 'hour').includes('loop node'), 'no node text: line as before');
  }
}

main().catch((e) => { console.error('FAIL: test crashed', e); process.exitCode = 1; });
