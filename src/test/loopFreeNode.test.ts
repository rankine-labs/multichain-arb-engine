// Tests for "loop checks on the free node" (core/loopNode.ts, Oct 15, owner approved):
//   A) switches: LOOP_CHECK_NODE free (default) / main, LOOP_CHECK_RPC, LOOP_CHECK_DAILY
//   B) LOOP_CHECK_NODE=free: a loop check never calls the main node, and
//      never changes the 2-pool check counter (simInFlight)
//   C) "slow down" from the loop node: pause 60 s, doubling to 10 min, reset by a clean check
//   D) replay not supported on the loop node: checked once, then end-of-block checks
//   E) LOOP_CHECK_NODE=main: exactly the old steps (main node, free node second opinion)
//   F) the hourly line shows the loop node
//   G) throttle: shared node busy = 0 loop requests; never over LOOP_NODE_MAX_RPS
import { loopNodeFromEnv, LoopNodeGuard, runLoopCheck, LoopCheckDeps, LoopSpot, loopNodeText, isMethodMissing, LoopNodeThrottle, LoopNodeBusy, loopMaxRpsFromEnv } from '../core/loopNode';
import { NodeBudget } from '../core/nodeBudget';
import type { Rpc, SimResult } from '../execution/simulator';
import { findBalanceSlot } from '../execution/simulator';
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
    await node('eth_call', []); // second request in the same check: not sent at all
    assert(!g.canCheck(), 'paused after "slow down"');
    assert(g.peekHour().pauses === 1 && g.peekHour().rateLimited === 1 && busy.calls.length === 1, 'one "slow down", one pause, second request never sent');
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
    g4.noteStart();
    assert(g4.peekHour().today === 0, 'a check that sent nothing is not counted toward the daily cap');
    g4.countCheck(); g4.countCheck();
    assert(!g4.canCheck(), 'daily cap reached: no more loop checks');
    day = 'd2'; assert(g4.canCheck() && g4.peekHour().today === 0, 'new day: count starts again');
    // takeHour resets the hour counts, keeps today's
    const g5 = new LoopNodeGuard(loopNodeFromEnv({}), () => t, quiet);
    g5.noteStart(); g5.countCheck(); g5.noteRateLimit();
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
    assert(await gi.probeReplay(fakeNode('i', () => ({ error: { code: -32602, message: 'invalid params' } })).rpc) === 'unknown', 'probe: unclear error (invalid params) -> still unknown, not "supported"');
    const gr = new LoopNodeGuard(loopNodeFromEnv({}), () => 0, quiet);
    assert(await gr.probeReplay(fakeNode('r', () => ({ error: { code: 3, message: 'execution reverted', data: '0x' } })).rpc) === 'yes', 'probe: revert-shaped answer -> supported');
    for (const err of [{ code: 403, message: 'Forbidden' }, { message: 'method eth_simulateV1 is disabled' }, { message: 'this method is not allowed' }]) {
      const gf = new LoopNodeGuard(loopNodeFromEnv({}), () => 0, quiet);
      assert(await gf.probeReplay(fakeNode('f', () => ({ error: err })).rpc) === 'no', `probe: "${err.message}" -> not supported`);
    }
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

  // ---------------- G) throttle: loops never delay price reads ----------------
  {
    // Fake clock + sleep (no real waiting).
    let t = 10_000_000;
    const sleep = async (ms: number) => { t += ms; };
    // Shared allowance busy (someone queued): a loop check sends 0 requests.
    const node = fakeNode('free');
    const busyShared = () => ({ pending: 1, usedLastSec: 1, tokens: 5, rps: 8 });
    const th = new LoopNodeThrottle(2, busyShared, () => t, sleep);
    const { d } = deps(th.wrap(node.rpc), null, () => ({ status: 'loss' }));
    th.beginCheck();
    const start = t;
    let busy = false;
    try { await runLoopCheck(d, trade, '0xhash'); } catch (e) { busy = e instanceof LoopNodeBusy; }
    assert(busy && node.calls.length === 0, `shared queue busy: loop check gives up, 0 requests sent (${node.calls.length})`);
    assert(t - start <= 2_000, `waited at most 2 s (${t - start} ms)`);
    // Over half the shared speed limit used, or no free slot: also shut.
    const th2 = new LoopNodeThrottle(2, () => ({ pending: 0, usedLastSec: 4, tokens: 4, rps: 8 }), () => t, sleep);
    const th3 = new LoopNodeThrottle(2, () => ({ pending: 0, usedLastSec: 0, tokens: 0.5, rps: 8 }), () => t, sleep);
    const th4 = new LoopNodeThrottle(2, () => ({ pending: 0, usedLastSec: 3, tokens: 6, rps: 8 }), () => t, sleep);
    const th4b = new LoopNodeThrottle(2, () => ({ pending: 0, usedLastSec: 1, tokens: 5.9, rps: 8 }), () => t, sleep);
    assert(!th2.sharedHasRoom() && !th3.sharedHasRoom() && th4.sharedHasRoom(), 'room only with an empty queue, under half the limit and slots free');
    assert(!th4b.sharedHasRoom(), 'shared allowance must be nearly full (8/s: at least 6 free) before a loop request goes');
    // Waiting only on loops' own limit never counts as "node busy".
    const th7 = new LoopNodeThrottle(2, () => ({ pending: 0, usedLastSec: 0, tokens: 8, rps: 8 }), () => t, sleep);
    const w7 = th7.wrap(async () => ({ result: '0x' }));
    th7.beginCheck();
    let skipped7 = false;
    try { for (let i = 0; i < 12; i++) await w7('eth_call', []); } catch { skipped7 = true; }
    assert(!skipped7 && th7.sentThisCheck === 12, '12 requests on an idle node (about 6 s at 2/s): not skipped as busy');
    // But a whole check may take at most 15 s.
    const th8 = new LoopNodeThrottle(2, () => ({ pending: 0, usedLastSec: 0, tokens: 8, rps: 8 }), () => t, sleep);
    const w8 = th8.wrap(async () => ({ result: '0x' }));
    th8.beginCheck();
    let why8 = '';
    try { for (let i = 0; i < 100; i++) await w8('eth_call', []); } catch (e) { why8 = (e as Error).message; }
    assert(why8 === 'skipped: check too long' && th8.sentThisCheck <= 32, `check capped at 15 s (${why8}, ${th8.sentThisCheck} sent)`);
    // Once rate limited in a check, nothing more is sent in that check.
    const gw = new LoopNodeGuard(loopNodeFromEnv({}), () => t, quiet);
    let sentW = 0;
    const ww = gw.watch(async () => { sentW++; return { error: { code: 429, message: 'too many requests' } }; });
    gw.noteStart();
    await ww('eth_call', []); const later = await ww('eth_call', []); await ww('eth_call', []);
    assert(sentW === 1 && later.error?.code === 429 && gw.peekHour().rateLimited === 1, 'after "slow down" mid-check: no more requests sent, counted once');
    gw.noteResult({ status: 'rate_limited', reason: 'x' });
    assert(gw.peekHour().rateLimited === 1, 'rate_limited result of that check not counted twice');
    gw.noteStart(); t += 60_001;
    await ww('eth_call', []);
    assert(sentW === 2, 'next check sends again');
    // Quiet shared node: loop requests never exceed LOOP_NODE_MAX_RPS in any second.
    const sentAt: number[] = [];
    const quietNode: Rpc = async () => { sentAt.push(t); return { result: '0x' }; };
    const th5 = new LoopNodeThrottle(2, () => ({ pending: 0, usedLastSec: 0, tokens: 8, rps: 8 }), () => t, sleep, 60_000);
    const w5 = th5.wrap(quietNode);
    th5.beginCheck();
    for (let i = 0; i < 20; i++) { await w5('eth_call', []); t += 10; }
    let worst = 0;
    for (const a of sentAt) worst = Math.max(worst, sentAt.filter((b) => b >= a && b - a < 1_000).length);
    assert(sentAt.length === 20 && worst <= 2, `20 loop requests, never more than 2 in any second (worst ${worst})`);
    assert(loopMaxRpsFromEnv({}) === 2 && loopMaxRpsFromEnv({ LOOP_NODE_MAX_RPS: '5' }) === 5 && loopMaxRpsFromEnv({ LOOP_NODE_MAX_RPS: 'x' }) === 2, 'LOOP_NODE_MAX_RPS: default 2, number used, junk = 2');
    // Busy skip is not a "slow down" pause.
    const g = new LoopNodeGuard(loopNodeFromEnv({}), () => t, quiet);
    const th6 = new LoopNodeThrottle(2, busyShared, () => t, sleep);
    const watched = g.watch(th6.wrap(node.rpc));
    th6.beginCheck();
    try { await watched('eth_call', []); } catch { /* busy */ }
    assert(g.canCheck() && g.peekHour().pauses === 0 && g.peekHour().rateLimited === 0, 'node busy skip: no pause, not counted as a rate limit');
    th6.busySkips = 3;
    assert(loopNodeText({ ...g.peekHour(), busySkips: th6.takeBusy() }).includes('skipped node busy 3') && th6.busySkips === 0, 'hour text shows "skipped node busy", then resets');
    // Shared NodeBudget headroom: read only, sees the queue and recent use.
    let bt = 0;
    const b = new NodeBudget('test', 8, Infinity, () => bt);
    const h0 = b.headroom();
    assert(h0.pending === 0 && h0.usedLastSec === 0 && h0.tokens === 8 && h0.rps === 8, 'headroom: quiet at start');
    for (let i = 0; i < 5; i++) await b.take(1);
    const h1 = b.headroom();
    assert(h1.usedLastSec === 5 && h1.tokens === 3 && b.headroom().tokens === 3, 'headroom: counts recent calls, never takes allowance');
    bt += 1_000;
    assert(b.headroom().usedLastSec === 0, 'headroom: forgets calls older than 1 s');
    // Fill the bucket so the next take waits: pending shows while it waits.
    for (let i = 0; i < 8; i++) await b.take(1);
    const waiting = b.take(1);
    await new Promise((r) => setImmediate(r));
    const hp = b.headroom().pending;
    bt += 1_000;
    await waiting;
    assert(hp === 1 && b.headroom().pending === 0, `headroom: queued request seen as pending (${hp})`);
  }

  // ---------------- H) slot cache: loops read it, never add to it ----------------
  {
    let n1 = 0, n2 = 0, n3 = 0;
    const refuses = (count: () => void): Rpc => async () => { count(); return { error: { code: -32602, message: 'invalid params' } }; };
    const key = 'robinhood:0xloopslottest';
    await findBalanceSlot(refuses(() => n1++), key, '0x00000000000000000000000000000000000000aa', true);
    await findBalanceSlot(refuses(() => n2++), key, '0x00000000000000000000000000000000000000aa', true);
    assert(n1 === 1 && n2 === 0, 'read-only lookup remembered for loops (side cache)');
    await findBalanceSlot(refuses(() => n3++), key, '0x00000000000000000000000000000000000000aa');
    assert(n3 === 1, 'the 2-pool lookup does not see the loop answer (main cache untouched)');
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
