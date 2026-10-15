// Tests for the LOOP WORKER (Oct 15, owner approved, practice only):
//   1. LOOP_WORKER switch: on by default with LOOP_TRADER=1, LOOP_WORKER=0 = old behaviour
//   2. the worker thread finds exactly the same loops as the main-thread
//      version for the same sequence of pool changes and feed trades
//   3. main thread work per update stays small (only changed pools are sent)
//   4. the message queue is bounded (worker behind = nothing new sent, notes capped)
//   5. worker crash -> logged, restarted, main thread survives; restart limit per hour
//   6. loop node requests ask the main thread first (shared free-node allowance)
//   7. the worker's memory shows in the [mem] line
import { PoolCache } from '../core/poolCache';
import { PendingTrades, loopPoolState, loopFixFromEnv } from '../core/loopPrices';
import { LoopTrader, loopConfigFromEnv } from '../core/loopTrader';
import { deepEnough, poolDepthUsd } from '../core/poolPrice';
import { drainSteps } from '../core/chunked';
import { MainLoopFeeder, LoopSource, loopWorkerFromEnv, loopResultsDigest, DEFAULT_FEEDER_LIMITS, LoopWorkerInit } from '../core/loopWorkerFeed';
import { LoopWorkerHost } from '../core/loopWorkerHost';
import { loopNodeFromEnv } from '../core/loopNode';
import { MemReporter, registerMemNote, clearSizes } from '../core/memReport';
import type { PoolState } from '../core/types';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const W = A(1), USDG = A(2);
const E18 = 10n ** 18n;
let clock = 9_000_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(10); }
  return cond();
}

function v2(addr: number, tA: string, tB: string, rA: number, rB: number, block = 1): PoolState {
  return { chain: 'robinhood', dex: 'uniswap-v2', poolAddress: A(addr), poolType: 'v2', tokenA: tA, tokenB: tB,
    reserveA: BigInt(Math.round(rA * 1e6)) * 10n ** 12n, reserveB: BigInt(Math.round(rB * 1e6)) * 10n ** 12n,
    feeBps: 30, lastUpdatedBlock: block, lastUpdatedMs: clock };
}

// The settings a real LOOP_TRADER=1 bot uses (all loop fix switches on),
// smaller loop list so a full re-price fits in the finder's time budget
// (then the answer cannot depend on how fast the machine is).
const ENV = { LOOP_TRADER: '1', LOOP_MAX_POOLS: '4', LOOP_MAX_CYCLES: '1500', LOOP_CHECKS_PER_MIN: '0', LOOP_MIN_NET_USD: '0.01' };
const loopCfg = loopConfigFromEnv(ENV, () => {});
const fix = loopFixFromEnv(ENV);
const MIN_DEPTH = 500;

function initFor(over: Partial<LoopWorkerInit> = {}): LoopWorkerInit {
  return {
    t: 'init', loopCfg, fix, realPricesOn: true, triggersOn: true, extraOn: true, bases: [W, USDG], minDepthUsd: MIN_DEPTH,
    node: { cfg: loopNodeFromEnv({}, () => {}), maxRps: 2, freeUrl: 'https://example.invalid', weth: W, slotsFile: null, triggerPollMs: 300, triggerMaxPolls: 6, sharedBudget: false },
    statsMs: 200, peekMs: 15 * 60_000, logPerMin: 60, fixedClock: true, testHooks: true, testFinder: { updateBudgetMs: Infinity, sliceMs: Infinity }, ...over,
  };
}

(async () => {
  // -------------------------------------------------------------------------
  // 1. Switch
  // -------------------------------------------------------------------------
  {
    assert(loopWorkerFromEnv({ LOOP_TRADER: '1' }), 'LOOP_WORKER: on by default when LOOP_TRADER=1');
    assert(!loopWorkerFromEnv({ LOOP_TRADER: '1', LOOP_WORKER: '0' }), 'LOOP_WORKER=0: loops in the main thread (old behaviour)');
    assert(!loopWorkerFromEnv({ LOOP_TRADER: '0' }) && !loopWorkerFromEnv({}), 'loop trader off: no worker either');
  }

  // -------------------------------------------------------------------------
  // 2. Same loops in the worker as in the main thread.
  // The "main thread" side below is a copy of shadowMain's loopScanSteps.
  // -------------------------------------------------------------------------
  {
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const toks = Array.from({ length: 24 }, (_, i) => (i === 0 ? W : i === 1 ? USDG : A(3000 + i)));
    const all: PoolState[] = [];
    for (let i = 2; i < 24; i++) { all.push(v2(6000 + i * 2, W, toks[i], 1_000 * (1 + rnd()), 1_000 * (1 + rnd()))); all.push(v2(6001 + i * 2, USDG, toks[i], 1_000 * (1 + rnd()), 1_000 * (1 + rnd()))); }
    for (let i = 0; i < 40; i++) { const a = 2 + Math.floor(rnd() * 22), b = 2 + Math.floor(rnd() * 22); if (a !== b) all.push(v2(8000 + i, toks[a], toks[b], 1_000 * (1 + rnd()), 1_000 * (1 + rnd()))); }
    all.push(v2(8999, W, USDG, 1_000, 1_000));
    // Watched pairs (in pairs of two pools), the last 10 pools are "extra" loop pools.
    const watchedPools = all.slice(0, all.length - 10).map((p) => p.poolAddress);
    let pairs: string[][] = [];
    for (let i = 0; i < watchedPools.length; i += 2) pairs.push(watchedPools.slice(i, i + 2));
    const extra = all.slice(all.length - 10).map((p) => p.poolAddress);
    const cache = new PoolCache({ confirmed: true });
    for (const p of all) cache.upsert(p);
    const usd = new Map<string, number>(toks.map((t) => [t.toLowerCase(), 1]));
    const usdOf = (t: string) => usd.get(t.toLowerCase()) ?? null;
    const dec = (_c: string, _t: string) => 18;
    const gas = (hops: number) => 0.01 * hops;

    // Main-thread reference (shadowMain loopScanSteps, copied).
    const loopTriggers = new PendingTrades(fix.pendingMaxMs);
    const ref = new LoopTrader(loopCfg, {
      bases: [W, USDG],
      env: { decimalsOf: () => 18, usdOf, depthUsd: (p) => poolDepthUsd(p, dec, usdOf), gasUsd: gas, rivalPools: () => new Set(), isTradable: () => true, now: () => clock },
      symbolOf: (t) => t.slice(0, 8), decimalsOf: () => 18, canPracticeTest: () => true, canCheckNow: () => false,
      runCheck: async () => ({ status: 'loss' }), fix,
    });
    // No time budget (same as the worker's test setting): the answer can't depend on machine speed.
    Object.assign(ref.finder.cfg, { updateBudgetMs: Infinity, sliceMs: Infinity });
    const predict = (p: PoolState, inIsA: boolean, amt: bigint) => cache.predictPostTradeState(p, inIsA, amt);
    function* loopScanSteps(): Generator<void, any, void> {
      const now = clock;
      const fresh = loopTriggers.takeFresh();
      loopTriggers.sweep(now);
      const stateOf = (a: string): PoolState | undefined => loopTriggers.stateFor(a, cache.get('robinhood', a), cache.getConfirmed('robinhood', a), cache.confirmedInfo('robinhood', a), predict, now);
      const pools: PoolState[] = [];
      for (const pair of pairs) for (const a of pair) { const p = stateOf(a); if (p && deepEnough(p, dec, usdOf, MIN_DEPTH)) pools.push(p); }
      const have = new Set(pools.map((p) => p.poolAddress.toLowerCase()));
      const ex = extra.map(stateOf).filter((p): p is PoolState => !!p && now - p.lastUpdatedMs <= loopCfg.maxPoolAgeMs);
      for (const p of ex) if (!have.has(p.poolAddress.toLowerCase()) && deepEnough(p, dec, usdOf, MIN_DEPTH)) pools.push(p);
      const ctx = fix.triggerReplay && fresh.size ? { triggers: fresh } : {};
      return yield* ref.onUpdateSteps(pools, ctx);
    }

    // Worker side: the real feeder and a real worker thread.
    const src: LoopSource = {
      watchedPairs: () => pairs, extraKeys: () => extra,
      main: (k) => cache.get('robinhood', k), confirmed: (k) => cache.getConfirmed('robinhood', k), info: (k) => cache.confirmedInfo('robinhood', k),
      // One-lookup form, as shadowMain uses it.
      view: (k, out) => cache.readLoopViewKey(cache.cacheKey('robinhood', k), out),
      realPrices: true, usdOf, decimalsOf: () => 18, symbolOf: (t) => t.slice(0, 8), tradable: () => true, practiceDex: () => true,
      gasUsd: gas, rivalPools: () => new Set(), balance: () => undefined, budgetOk: () => true, head: () => null, bases: [W, USDG], now: () => clock,
    };
    const feeder = new MainLoopFeeder(src);
    const digests = new Map<number, string | undefined>();
    const logs: string[] = [];
    const host = new LoopWorkerHost({
      init: initFor(), feeder, permit: () => true, noteGas: () => {}, log: (m) => logs.push(m), warn: (m) => logs.push(m),
      autoFlush: false, onAck: (seq, d) => digests.set(seq, d),
    });
    host.start();
    assert(await waitFor(() => host.alive), 'worker thread started (entry file found in the build folder)');

    let same = 0, differ = 0, paying = 0, firstDiff = '';
    let txn = 0;
    for (let step = 0; step < 30; step++) {
      clock += 2_500;
      // A few block writes (with their feed transactions seen first, in order).
      for (let j = 0; j < 4; j++) {
        const p = cache.get('robinhood', all[Math.floor(rnd() * all.length)].poolAddress)!;
        const h = '0x' + (++txn).toString(16).padStart(64, '0');
        loopTriggers.noteFeedTx(h); host.noteFeedTx(h);
        cache.upsertFromBlock({ ...p, reserveA: p.reserveA! + 10n ** 16n * BigInt(1 + Math.floor(rnd() * 900)), lastUpdatedBlock: p.lastUpdatedBlock + 1 }, clock, h);
      }
      // Feed trades not yet in a block (predicted states + pending book).
      for (let j = 0; j < 3; j++) {
        const p = cache.get('robinhood', all[Math.floor(rnd() * all.length)].poolAddress)!;
        const h = '0x' + (++txn).toString(16).padStart(64, '0');
        const inIsA = rnd() < 0.5, amt = E18 * BigInt(1 + Math.floor(rnd() * 20));
        const after = cache.predictPostTradeState(p, inIsA, amt);
        cache.upsertFromFeed(after, clock);
        const t = { hash: h, inIsA, amountIn: amt, at: clock };
        loopTriggers.note(after.poolAddress, t); host.noteTrade(after.poolAddress, t);
      }
      // RPC refreshes keep a third of the pools fresh (confirmed too).
      for (const p0 of all) if (rnd() < 0.35) { const p = cache.get('robinhood', p0.poolAddress)!; cache.upsert({ ...p, lastUpdatedMs: clock }); }
      // Now and then: a coin price changes, a pair leaves / comes back.
      if (step % 7 === 3) usd.set(toks[5].toLowerCase(), 0.2 + rnd());
      if (step === 10) pairs = pairs.slice(2);
      if (step === 18) { pairs = []; for (let i = 0; i < watchedPools.length; i += 2) pairs.push(watchedPools.slice(i, i + 2)); }
      // Main-thread version.
      const want = loopResultsDigest(drainSteps(loopScanSteps()));
      await ref.finder.idle();
      // Worker version.
      const seq = host.flushNow(true, true);
      const got = seq !== null && await waitFor(() => digests.has(seq)) ? digests.get(seq) : 'no answer';
      if (got === want) same++; else { differ++; if (!firstDiff) firstDiff = `step ${step}: main ${want.slice(0, 120)} / worker ${String(got).slice(0, 120)}`; }
      if (want && want !== 'off') paying += want.split('|').length;
    }
    assert(differ === 0 && same === 30, `worker finds exactly the same loops as the main thread (${same}/30 scans equal${firstDiff ? '; ' + firstDiff : ''})`);
    assert(paying > 0, `the test sequence really has paying loops (${paying} loop results over 30 scans)`);
    // The worker's loop list may still be rebuilding in the background right
    // after the last scan (its size report lags by a moment): give it time to
    // settle, nudging it with a scan, instead of reading it the same instant.
    await waitFor(() => { if (host.stats?.cycles !== ref.finder.cycleCount()) host.flushNow(true, true); return host.stats !== null && host.stats.cycles === ref.finder.cycleCount(); }, 5_000);
    assert(host.stats !== null && host.stats.cycles === ref.finder.cycleCount(), `worker reports its loop list size (${host.stats?.cycles} loops, main-thread version ${ref.finder.cycleCount()})`);
    // Hour numbers come back by message, same shape as before.
    const hr = await host.takeHour();
    const refHour = ref.takeHour();
    assert(!!hr && hr.h.found === refHour.found && hr.h.cycles === refHour.cycles && hr.node.startsWith('loop node free public node'), `hour numbers from the worker match (found ${hr?.h.found} vs ${refHour.found}); node line "${hr?.node.slice(0, 40)}..."`);
    host.stop();
    await sleep(50);
    assert(!host.alive, 'stop(): worker terminated');
  }

  // -------------------------------------------------------------------------
  // 3 + 4. Main thread work per update and the bounded queue (no thread needed).
  // -------------------------------------------------------------------------
  {
    const N = 1_000;
    const states = new Map<string, PoolState>();
    const keys: string[] = [];
    for (let i = 0; i < N; i++) { const p = v2(20_000 + i, i % 2 ? W : USDG, A(40_000 + (i % 300)), 1_000, 1_000); states.set(p.poolAddress, p); keys.push(p.poolAddress); }
    const pairs: string[][] = [];
    for (let i = 0; i < N; i += 2) pairs.push(keys.slice(i, i + 2));
    const src: LoopSource = {
      watchedPairs: () => pairs, extraKeys: () => null,
      main: (k) => states.get(k), confirmed: (k) => states.get(k), info: () => ({ block: 1, at: 1, fromBlock: true }),
      realPrices: true, usdOf: () => 1, decimalsOf: () => 18, symbolOf: (t) => t.slice(0, 6), tradable: () => true, practiceDex: () => true,
      gasUsd: (n) => n * 0.01, rivalPools: () => new Set(), balance: () => undefined, budgetOk: () => true, head: () => 5, bases: [W, USDG], now: () => clock,
    };
    const f = new MainLoopFeeder(src);
    // Start-up send is split into pieces of at most 250 pools.
    const first = f.build(true)!;
    assert(first.pools.length === 250 && first.partial && !first.scan, `first send split: 250 pools, partial, scan waits (${first.pools.length})`);
    f.ack(first.seq);
    let rest = 0, last = first;
    while (f.needsMore()) { last = f.build(true)!; rest += last.pools.length; f.ack(last.seq); }
    assert(rest === N - 250 && last.scan && !last.partial, `rest follows in pieces, the last one asks for the scan (${rest} more pools)`);
    // Steady state: 20 changed pools per update.
    const times: number[] = [];
    let sizes = 0;
    for (let u = 0; u < 200; u++) {
      clock += 50;
      for (let j = 0; j < 20; j++) { const k = keys[(u * 37 + j * 101) % N]; const p = states.get(k)!; states.set(k, { ...p, reserveA: p.reserveA! + 1n }); }
      const t0 = performance.now();
      const b = f.build(true)!;
      times.push(performance.now() - t0);
      sizes += b.pools.length;
      f.ack(b.seq);
    }
    times.sort((a, b) => a - b);
    const med = times[100], p99 = times[198];
    assert(sizes === 200 * 20, `only changed pools are sent (${sizes / 200} per update, of ${N})`);
    assert(med < 20, `main thread work per update is small: median ${med.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms for ${N} pools`);
    // Bounded: worker behind (3 messages unanswered) -> nothing new is sent.
    const b1 = f.build(true)!, b2 = f.build(true)!, b3 = f.build(true)!;
    const held = f.build(true);
    assert(held === null && f.skippedBusy === 1 && f.inFlightCount() === 3, 'worker 3 messages behind: the 4th is held back (nothing piles up)');
    // Pool changes while held back are not lost: they go in the next message.
    const k0 = keys[3];
    states.set(k0, { ...states.get(k0)!, reserveB: 7n });
    for (let i = 0; i < DEFAULT_FEEDER_LIMITS.maxNotes + 1_000; i++) f.noteFeedTx('0x' + i.toString(16));
    void b1; void b2; f.ack(b3.seq);
    assert(f.inFlightCount() === 0, 'an answer for message N also clears the ones before it');
    const nb = f.build(true)!;
    f.ack(nb.seq);
    assert(nb.pools.some(([k]) => k === k0), 'a pool changed while the worker was behind is sent once it catches up');
    assert(nb.notes.length <= DEFAULT_FEEDER_LIMITS.maxNotes && nb.droppedNotes > 0 && f.droppedTotal === nb.droppedNotes,
      `feed notes capped at ${DEFAULT_FEEDER_LIMITS.maxNotes} (kept ${nb.notes.length}, dropped oldest ${nb.droppedNotes}, counted)`);
    // Removed pools are forgotten in the worker.
    pairs.splice(0, 1);
    const rb = f.build(false)!;
    assert(rb.pools.filter(([, r]) => r === null).length === 2 && !!rb.keys, 'pools leaving the list: worker told to forget them, new list sent');
    f.ack(rb.seq);
  }

  // -------------------------------------------------------------------------
  // 5. Worker crash -> logged, restarted with a pause, main thread survives.
  // -------------------------------------------------------------------------
  {
    const src: LoopSource = {
      watchedPairs: () => [], extraKeys: () => null, main: () => undefined, confirmed: () => undefined, info: () => undefined,
      realPrices: true, usdOf: () => 1, decimalsOf: () => 18, symbolOf: (t) => t, tradable: () => true, practiceDex: () => true,
      gasUsd: () => 0.01, rivalPools: () => new Set(), balance: () => undefined, budgetOk: () => true, head: () => null, bases: [W, USDG], now: () => clock,
    };
    const warns: string[] = [];
    const host = new LoopWorkerHost({
      init: initFor(), feeder: new MainLoopFeeder(src), permit: () => true, noteGas: () => {}, log: () => {}, warn: (m) => warns.push(m),
      restartDelaysMs: [30, 30, 30], maxRestartsPerHour: 2, autoFlush: false,
    });
    host.start();
    assert(await waitFor(() => host.alive), 'crash test: worker up');
    host.crashForTest();
    assert(await waitFor(() => host.crashes === 1), 'crash noticed by the main thread');
    assert(await waitFor(() => host.alive && host.restarts === 1), 'worker restarted after a short pause');
    assert(warns.some((w) => w.includes('worker stopped')) && warns.some((w) => w.includes('restarting loop worker')), 'crash and restart are logged');
    host.crashForTest();
    assert(await waitFor(() => host.alive && host.restarts === 2), 'second crash: restarted again');
    host.crashForTest();
    assert(await waitFor(() => host.crashes === 3), 'third crash noticed');
    await sleep(300);
    assert(!host.alive && host.restarts === 2 && warns.some((w) => w.includes('loops paused')), 'restart limit per hour reached: loops paused, no restart storm');
    const hr = await host.takeHour(200);
    assert(hr === null, 'hour numbers while the worker is down: null (report says so), no hang');
    host.stop();
    assert(true, 'main thread survived three worker crashes');
  }

  // -------------------------------------------------------------------------
  // 5b. Review fixes with a fake worker: no "ready" -> restart; stale "may I?"
  // questions answered no; a late hour reply is still handed over.
  // -------------------------------------------------------------------------
  {
    type L = (m: any) => void;
    const made: { posted: any[]; on: Record<string, L>; terminated: boolean }[] = [];
    const fake = () => {
      const f = { posted: [] as any[], on: {} as Record<string, L>, terminated: false };
      made.push(f);
      return { postMessage: (m: any) => { f.posted.push(m); }, on: (ev: string, fn: L) => { f.on[ev] = fn; }, terminate: () => { f.terminated = true; if (f.on.exit) f.on.exit(1); return Promise.resolve(1); } } as any;
    };
    const src: LoopSource = {
      watchedPairs: () => [], extraKeys: () => null, main: () => undefined, confirmed: () => undefined, info: () => undefined,
      realPrices: true, usdOf: () => 1, decimalsOf: () => 18, symbolOf: (t) => t, tradable: () => true, practiceDex: () => true,
      gasUsd: () => 0.01, rivalPools: () => new Set(), balance: () => undefined, budgetOk: () => true, head: () => null, bases: [W, USDG], now: () => clock,
    };
    const warns: string[] = [];
    let given = 0;
    const late: any[] = [];
    const host = new LoopWorkerHost({
      init: initFor(), feeder: new MainLoopFeeder(src), permit: () => { given++; return true; }, noteGas: () => {}, log: () => {}, warn: (m) => warns.push(m),
      createWorker: fake, readyTimeoutMs: 60, restartDelaysMs: [20, 20, 20], maxRestartsPerHour: 3, autoFlush: false, onLateHour: (r) => late.push(r),
    });
    host.start();
    await sleep(200);
    assert(made.length >= 2 && made[0].terminated && host.crashes >= 1 && warns.some((w) => w.includes('did not start')), `worker that never says ready: stopped and restarted (${made.length} started, ${host.crashes} counted as crashes)`);
    // Let the newest fake worker say ready.
    const cur = made[made.length - 1];
    cur.on.message({ t: 'ready' });
    assert(host.alive, 'restarted worker that says ready is used');
    const before = given;
    cur.on.message({ t: 'permit', id: 1, at: Date.now() - 2_000 });
    cur.on.message({ t: 'permit', id: 2, at: Date.now() });
    const answers = cur.posted.filter((m) => m.t === 'permit');
    assert(answers.length === 2 && !answers[0].ok && answers[1].ok && given === before + 1 && host.permitsStale === 1,
      'a "may I?" older than 900 ms is answered no without using the shared allowance; a fresh one gets yes');
    const p = host.takeHour(30);
    const asked = cur.posted.find((m) => m.t === 'takeHour');
    const r = await p;
    cur.on.message({ t: 'hour', id: asked.id, h: { found: 7 }, node: 'n' });
    assert(r === null && late.length === 1 && late[0].h.found === 7, 'hour numbers arriving after the 3 s wait are still handed over (logged), not lost');
    host.stop();
  }

  // -------------------------------------------------------------------------
  // 6. Loop node requests ask the main thread first.
  // A paying 3-pool loop, practice checks on (fake node answers "loss").
  // -------------------------------------------------------------------------
  for (const allow of [true, false]) {
    const cache = new PoolCache({ confirmed: true });
    const pools = [v2(500, W, A(600), 1_000, 2_000), v2(501, A(600), A(601), 2_000, 2_000), v2(502, A(601), W, 1_000, 1_300)];
    for (const p of pools) cache.upsert({ ...p, lastUpdatedMs: clock });
    const src: LoopSource = {
      watchedPairs: () => [pools.map((p) => p.poolAddress)], extraKeys: () => null,
      main: (k) => cache.get('robinhood', k), confirmed: (k) => cache.getConfirmed('robinhood', k), info: (k) => cache.confirmedInfo('robinhood', k),
      realPrices: true, usdOf: () => 1, decimalsOf: () => 18, symbolOf: (t) => t.slice(0, 8), tradable: () => true, practiceDex: () => true,
      gasUsd: (n) => n * 0.01, rivalPools: () => new Set(), balance: () => undefined, budgetOk: () => true, head: () => null, bases: [W, USDG], now: () => clock,
    };
    const cfg = loopConfigFromEnv({ ...ENV, LOOP_CHECKS_PER_MIN: '6' }, () => {});
    const digests = new Map<number, string | undefined>();
    let asked = 0;
    const host = new LoopWorkerHost({
      init: initFor({ loopCfg: cfg, fixedClock: false, fakeCheck: 'loss', node: { ...initFor().node, sharedBudget: true } }),
      feeder: new MainLoopFeeder(src), permit: () => { asked++; return allow; }, noteGas: () => {}, log: () => {}, warn: () => {},
      autoFlush: false, onAck: (s, d) => digests.set(s, d),
    });
    host.start();
    await waitFor(() => host.alive);
    clock = Date.now();
    for (const p of pools) cache.upsert({ ...cache.get('robinhood', p.poolAddress)!, lastUpdatedMs: clock });
    const seq = host.flushNow(true)!;
    await waitFor(() => digests.has(seq));
    const found = (digests.get(seq) ?? '').length > 0;
    // Allowed: the check runs at once. Refused: it waits up to 2 s, then gives up ("node busy").
    await sleep(allow ? 300 : 2_600);
    const hr = await host.takeHour();
    if (allow) assert(found && asked >= 1 && hr!.h.checked === 1 && hr!.h.lost === 1, `main thread said yes: loop check ran on the loop node (asked ${asked}x, checked ${hr?.h.checked}, lost ${hr?.h.lost})`);
    else assert(found && asked > 5 && hr!.h.checked === 0 && /skipped node busy 1/.test(hr!.node), `main thread said no (free node busy with price reads): check gave up after 2 s, counted as node busy (asked ${asked}x; "${hr?.node}")`);
    host.stop();
  }

  // -------------------------------------------------------------------------
  // 7. Worker memory in the [mem] line.
  // -------------------------------------------------------------------------
  {
    clearSizes();
    registerMemNote('loop worker', () => 'loop worker heap 42 MB');
    const r = new MemReporter(() => ({ rss: 900 * 1_048_576, heapUsed: 300 * 1_048_576, heapTotal: 400 * 1_048_576, external: 0, arrayBuffers: 0 }), () => 977 * 1_048_576);
    assert(r.line().includes('· loop worker heap 42 MB') && r.hourLine().includes('loop worker heap 42 MB'), '[mem] line and hourly memory line show "loop worker heap X MB"');
    // The status page shows it too (deploy/status-report.js).
    const status = require(require('path').join(__dirname, '..', '..', 'deploy', 'status-report.js'));
    const shown = status.memSummary([r.line().replace(/^.*?\[mem\]/, '[mem]')]);
    assert(typeof shown === 'string' && shown.includes('loop worker heap 42 MB'), `status page memory line shows the worker heap ("${shown}")`);
    registerMemNote('loop worker', () => null);
    assert(!r.line().includes('loop worker'), 'worker off: nothing added to the memory line');
    clearSizes();
  }
})().catch((e) => { console.error('FAIL: test crashed', e); process.exitCode = 1; });
