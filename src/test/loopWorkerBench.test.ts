// LOOP WORKER: main-thread time per update, loops in the main thread vs in
// the worker, on a realistic made-up load: 1,000 pools, 5,000 loops (3-5
// pools), 20 pool changes + 3 feed trades every 50 ms (a busy feed).
// Prints the numbers and checks the worker saves most of the main-thread time.
// LOOP_BENCH_SECONDS sets how long each run measures (default 4 s).
import { monitorEventLoopDelay, performance } from 'perf_hooks';
import { PoolCache } from '../core/poolCache';
import { PendingTrades, loopFixFromEnv } from '../core/loopPrices';
import { LoopTrader, loopConfigFromEnv } from '../core/loopTrader';
import { deepEnough, poolDepthUsd } from '../core/poolPrice';
import { MainLoopFeeder, LoopSource } from '../core/loopWorkerFeed';
import { LoopWorkerHost } from '../core/loopWorkerHost';
import { loopNodeFromEnv } from '../core/loopNode';
import type { PoolState } from '../core/types';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const W = A(1), USDG = A(2);
const E18 = 10n ** 18n;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SECONDS = Number(process.env.LOOP_BENCH_SECONDS ?? 4);

function v2(addr: number, tA: string, tB: string, rA: number, rB: number): PoolState {
  return { chain: 'robinhood', dex: 'uniswap-v2', poolAddress: A(addr), poolType: 'v2', tokenA: tA, tokenB: tB,
    reserveA: BigInt(Math.round(rA * 1e6)) * 10n ** 12n, reserveB: BigInt(Math.round(rB * 1e6)) * 10n ** 12n,
    feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: Date.now() };
}

const ENV = { LOOP_TRADER: '1', LOOP_MAX_POOLS: '5', LOOP_MAX_CYCLES: '5000', LOOP_CHECKS_PER_MIN: '0' };
const loopCfg = loopConfigFromEnv(ENV, () => {});
const fix = loopFixFromEnv(ENV);

// The same made-up market for both runs.
function market() {
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const toks = Array.from({ length: 150 }, (_, i) => (i === 0 ? W : i === 1 ? USDG : A(3000 + i)));
  const all: PoolState[] = [];
  for (let i = 2; i < 150; i++) { all.push(v2(10_000 + i * 2, W, toks[i], 50_000 * (1 + rnd()), 50_000 * (1 + rnd()))); all.push(v2(10_001 + i * 2, USDG, toks[i], 50_000 * (1 + rnd()), 50_000 * (1 + rnd()))); }
  while (all.length < 999) { const a = 2 + Math.floor(rnd() * 148), b = 2 + Math.floor(rnd() * 148); if (a !== b) all.push(v2(20_000 + all.length, toks[a], toks[b], 50_000 * (1 + rnd()), 50_000 * (1 + rnd()))); }
  all.push(v2(29_999, W, USDG, 50_000, 50_000));
  const cache = new PoolCache({ confirmed: true });
  for (const p of all) cache.upsert(p);
  const pairs: string[][] = [];
  for (let i = 0; i < all.length; i += 2) pairs.push([all[i].poolAddress, all[i + 1]?.poolAddress].filter(Boolean) as string[]);
  return { all, cache, pairs, rnd };
}

// One run: every 50 ms change 20 pools (block writes) + 3 feed trades, ask for a loop scan.
async function run(mode: 'main thread' | 'worker') {
  const { all, cache, pairs, rnd } = market();
  const usdOf = (_t: string) => 1;
  const dec = () => 18;
  let loopMs = 0;            // main-thread time spent on loop work
  const perUpdate: number[] = [];
  let noteFeedTx: (h: string) => void, noteTrade: (pool: string, t: any) => void, requestScan: () => void;
  let stop = () => {};
  let extra = '';
  if (mode === 'main thread') {
    // Copy of shadowMain's in-thread loop scan (LOOP_WORKER=0), sliced (8 ms) like production.
    const loopTriggers = new PendingTrades(fix.pendingMaxMs);
    const trader = new LoopTrader(loopCfg, {
      bases: [W, USDG],
      env: { decimalsOf: () => 18, usdOf, depthUsd: (p) => poolDepthUsd(p, dec, usdOf), gasUsd: (n) => 0.01 * n, rivalPools: () => new Set(), isTradable: () => true, now: Date.now },
      symbolOf: (t) => t.slice(0, 8), decimalsOf: () => 18, canPracticeTest: () => true, canCheckNow: () => false, runCheck: async () => ({ status: 'loss' }), fix,
    });
    // Time the loop list rebuild slices too (they run on the main thread here).
    const f = trader.finder as any;
    const slice = f.slice;
    f.slice = () => { const t0 = performance.now(); slice(); loopMs += performance.now() - t0; };
    const predict = (p: PoolState, inIsA: boolean, amt: bigint) => cache.predictPostTradeState(p, inIsA, amt);
    function* loopScanSteps(): Generator<void, any, void> {
      const now = Date.now();
      const fresh = loopTriggers.takeFresh();
      loopTriggers.sweep(now);
      const stateOf = (a: string) => loopTriggers.stateFor(a, cache.get('robinhood', a), cache.getConfirmed('robinhood', a), cache.confirmedInfo('robinhood', a), predict, now);
      const pools: PoolState[] = [];
      let n = 0;
      for (const pair of pairs) for (const a of pair) { const p = stateOf(a); if (p && deepEnough(p, dec, usdOf)) pools.push(p); if ((++n & 63) === 0) yield; }
      return yield* trader.onUpdateSteps(pools, fix.triggerReplay && fresh.size ? { triggers: fresh } : {});
    }
    let queued: NodeJS.Timeout | null = null, scanning = false, again = false;
    const runScan = async () => {
      if (scanning) { again = true; return; }
      scanning = true;
      let thisScan = 0;
      const job = loopScanSteps();
      for (;;) {
        const t0 = performance.now();
        let r: IteratorResult<void, any>;
        do { r = job.next(); } while (!r.done && performance.now() - t0 < fix.sliceMs);
        const took = performance.now() - t0;
        loopMs += took; thisScan += took;
        if (r.done) break;
        await new Promise((res) => setImmediate(res));
      }
      perUpdate.push(thisScan);
      scanning = false;
      if (again) { again = false; requestScan(); }
    };
    noteFeedTx = (h) => loopTriggers.noteFeedTx(h);
    noteTrade = (pool, t) => loopTriggers.note(pool, t);
    requestScan = () => { if (queued) return; queued = setTimeout(() => { queued = null; void runScan(); }, 50); };
    stop = () => { extra = `loops listed ${trader.finder.cycleCount()}`; };
  } else {
    const src: LoopSource = {
      watchedPairs: () => pairs, extraKeys: () => null,
      main: (k) => cache.get('robinhood', k), confirmed: (k) => cache.getConfirmed('robinhood', k), info: (k) => cache.confirmedInfo('robinhood', k),
      // Same one-lookup form (with remembered cache keys) as shadowMain.
      view: (() => { const keys = new Map<string, string>(); return (k: string, out: any) => { let ck = keys.get(k); if (ck === undefined) { ck = cache.cacheKey('robinhood', k); keys.set(k, ck); } cache.readLoopViewKey(ck, out); }; })(),
      realPrices: true, usdOf, decimalsOf: () => 18, symbolOf: (t) => t.slice(0, 8), tradable: () => true, practiceDex: () => true,
      gasUsd: (n) => 0.01 * n, rivalPools: () => new Set(), balance: () => undefined, budgetOk: () => true, head: () => null, bases: [W, USDG], now: Date.now,
    };
    const feeder = new MainLoopFeeder(src);
    const host = new LoopWorkerHost({
      init: {
        t: 'init', loopCfg, fix, realPricesOn: true, triggersOn: true, extraOn: false, bases: [W, USDG], minDepthUsd: 10_000,
        node: { cfg: loopNodeFromEnv({}, () => {}), maxRps: 2, freeUrl: 'https://example.invalid', weth: W, slotsFile: null, triggerPollMs: 300, triggerMaxPolls: 6, sharedBudget: false },
        statsMs: 500, peekMs: 15 * 60_000, logPerMin: 60,
      },
      feeder, permit: () => true, noteGas: () => {}, log: () => {}, warn: (m) => console.warn(m),
    });
    // Time everything the main thread does for the worker: building + posting each message.
    const h = host as any;
    const flush = h.flush.bind(host);
    h.flush = () => { const t0 = performance.now(); flush(); const took = performance.now() - t0; loopMs += took; perUpdate.push(took); };
    const onMessage = h.onMessage.bind(host);
    h.onMessage = (w: unknown, m: unknown) => { const t0 = performance.now(); onMessage(w, m); loopMs += performance.now() - t0; };
    host.start();
    while (!host.alive) await sleep(10);
    noteFeedTx = (x) => host.noteFeedTx(x);
    noteTrade = (pool, t) => host.noteTrade(pool, t);
    requestScan = () => host.requestScan();
    stop = () => {
      const s = host.stats;
      extra = `loops listed ${s?.cycles}, worker heap ${s ? Math.round(s.heapUsed / 1_048_576) : '?'} MB, worker scan ${s?.lastScanMs.toFixed(1)} ms (off the main thread)`;
      host.stop();
    };
  }

  // The feed: every 50 ms, 20 block writes + 3 feed trades, then a scan request.
  let txn = 0, updates = 0;
  const tickFeed = () => {
    const now = Date.now();
    for (let j = 0; j < 20; j++) {
      const p = cache.get('robinhood', all[Math.floor(rnd() * all.length)].poolAddress)!;
      const hsh = '0x' + (++txn).toString(16).padStart(64, '0');
      noteFeedTx(hsh);
      cache.upsertFromBlock({ ...p, reserveA: p.reserveA! + 10n ** 17n * BigInt(1 + Math.floor(rnd() * 900)), lastUpdatedBlock: p.lastUpdatedBlock + 1 }, now, hsh);
    }
    for (let j = 0; j < 3; j++) {
      const p = cache.get('robinhood', all[Math.floor(rnd() * all.length)].poolAddress)!;
      const hsh = '0x' + (++txn).toString(16).padStart(64, '0');
      const inIsA = rnd() < 0.5, amt = E18 * BigInt(1 + Math.floor(rnd() * 50));
      const after = cache.predictPostTradeState(p, inIsA, amt);
      cache.upsertFromFeed(after, now);
      noteTrade(after.poolAddress, { hash: hsh, inIsA, amountIn: amt, at: now });
    }
    // Keep every pool fresh (RPC refresh), a slice per tick.
    for (let j = 0; j < 30; j++) { const p = cache.get('robinhood', all[(updates * 30 + j) % all.length].poolAddress)!; cache.upsert({ ...p, lastUpdatedMs: now }); }
    updates++;
    requestScan();
  };
  const feed = setInterval(tickFeed, 50);
  await sleep(2_500); // warm up (first loop list build)
  loopMs = 0; perUpdate.length = 0;
  const lag = monitorEventLoopDelay({ resolution: 5 });
  lag.enable();
  const elu0 = performance.eventLoopUtilization();
  const t0 = performance.now();
  await sleep(SECONDS * 1_000);
  const wall = performance.now() - t0;
  const elu = performance.eventLoopUtilization(elu0);
  lag.disable();
  clearInterval(feed);
  stop();
  await sleep(100);
  perUpdate.sort((a, b) => a - b);
  const pct = (q: number) => perUpdate.length ? perUpdate[Math.min(perUpdate.length - 1, Math.floor(q * perUpdate.length))] : 0;
  const mem = process.memoryUsage();
  const r = {
    mode, wall, loopMs, msPerSec: (loopMs / wall) * 1_000, n: perUpdate.length,
    mean: perUpdate.length ? loopMs / perUpdate.length : 0, p50: pct(0.5), p99: pct(0.99), max: perUpdate[perUpdate.length - 1] ?? 0,
    elu: elu.utilization, lagMaxMs: lag.max / 1e6, lagP99Ms: lag.percentile(99) / 1e6,
    rssMb: Math.round(mem.rss / 1_048_576), heapMb: Math.round(mem.heapUsed / 1_048_576), extra,
  };
  console.log(`[bench] ${mode}: loop work on main thread ${r.msPerSec.toFixed(1)} ms per second (${(r.msPerSec / 10).toFixed(1)}% of one core); per update mean ${r.mean.toFixed(3)} ms, p50 ${r.p50.toFixed(3)}, p99 ${r.p99.toFixed(3)}, max ${r.max.toFixed(2)} ms over ${r.n} updates; main thread busy ${(r.elu * 100).toFixed(1)}% (incl. the made-up feed); longest freeze ${r.lagMaxMs.toFixed(1)} ms, p99 delay ${r.lagP99Ms.toFixed(1)} ms; rss ${r.rssMb} MB, main heap ${r.heapMb} MB; ${r.extra}`);
  return r;
}

(async () => {
  const a = await run('main thread');
  const b = await run('worker');
  // Safe bounds only (auto-deploy runs the tests on a busy server; a flaky
  // timing check must never roll a deploy back). The real numbers are printed above.
  assert(b.msPerSec < a.msPerSec, `worker uses less main-thread time for loops: ${a.msPerSec.toFixed(1)} -> ${b.msPerSec.toFixed(1)} ms per second (${Math.round((1 - b.msPerSec / a.msPerSec) * 100)}% less)`);
  assert(b.max < 50, `longest single main-thread loop step with the worker under 50 ms (${a.max.toFixed(2)} ms -> ${b.max.toFixed(2)} ms)`);
})().catch((e) => { console.error('FAIL: bench crashed', e); process.exitCode = 1; });
