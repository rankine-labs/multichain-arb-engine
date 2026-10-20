import { parentPort } from 'worker_threads';
import { getHeapStatistics } from 'v8';
import { LoopWorkerCore } from './loopWorkerCore';
import { LoopNodeGuard, LoopNodeThrottle, LoopNodeBusy, LoopCheckDeps, runLoopCheck, loopNodeText } from './loopNode';
import { loopLogLine } from './loopReport';
import { loopResultsDigest } from './loopWorkerFeed';
import type { ToWorker, FromWorker, LoopWorkerInit, LoopBatch } from './loopWorkerFeed';
import type { LoopTrade, LoopCheckResult } from './loopTrader';
import { CoinTaxBook, testCoinTax } from './coinTax';
import { makeRpc, simulateRoundTrip, replayRpc, loadBalanceSlots, Rpc, SimResult, ReplayCall } from '../execution/simulator';

// ============================================================================
// LOOP WORKER THREAD (Oct 15, owner approved). PRACTICE ONLY, NEVER SENDS.
//
// Plain English:
//   This file is started by the main thread as a separate thread (Node
//   "worker thread"). All the heavy loop work happens here, so the main
//   thread (trade feed, 2-pool trades) is no longer frozen by it:
//     - loop scans (finding 3-8 pool loops, rebuilding the loop list);
//     - loop prices from confirmed states plus pending feed trades;
//     - loop practice checks on the loop node (the free public node by
//       default), with the same "slow down" guard, daily limit and
//       LOOP_NODE_MAX_RPS limit as before.
//
//   The free node is shared with price reads for 2-pool trades, whose speed
//   allowance lives in the main thread. So before EVERY loop request this
//   thread asks the main thread "may I?" (a tiny message, a few a second at
//   most). The main thread says yes only when that allowance is quiet (same
//   rule as before: nobody waiting, under half used in the last second, almost
//   all slots free) and counts the request in it. If the main thread does not
//   answer within 1 s, the answer is "no" (counted as the node being busy).
//
//   Nothing here can send a trade: there is no wallet and no sender, only
//   the eth_call "pretend" test.
// ============================================================================

const port = parentPort;
if (!port) throw new Error('loopWorkerEntry must run as a worker thread');

const post = (m: FromWorker) => { try { port.postMessage(m); } catch { /* main thread gone */ } };

// Log lines go to the main thread (which scrubs keys from logs and prints
// them). Hard cap 200 a minute on top of the loop trader's own 60 a minute.
let logTimes: number[] = [];
const log = (line: string, level?: 'warn') => {
  const t = Date.now();
  logTimes = logTimes.filter((x) => t - x < 60_000);
  if (logTimes.length >= 200) return;
  logTimes.push(t);
  post({ t: 'log', line, ...(level ? { level } : {}) });
};

// A problem in one async job must not end the thread (same rule as the main thread).
process.on('unhandledRejection', (reason) => {
  log(`[loop] worker: unhandled problem (worker keeps running): ${(reason as Error)?.message ?? String(reason)}`, 'warn');
});

// ---- Trigger spot: copied from shadowMain findTriggerSpot (same steps). ----
// The 2-pool copy in shadowMain is left untouched on purpose (go-live week).
type TriggerSpot = { block: string; parent: string; prefix: ReplayCall[]; time?: string; index?: number };
const USER_TX_TYPES = new Set(['0x0', '0x1', '0x2', '0x3', '0x4']); // skip Arbitrum system txs (0x64-0x6a)
export async function findTriggerSpot(rpc: Rpc, hash: string, pollMs: number, maxPolls: number): Promise<TriggerSpot | null> {
  for (let i = 0; i < maxPolls; i++) {
    const r = await rpc('eth_getTransactionReceipt', [hash]);
    if (r.error) return null;
    if (r.result?.blockNumber) {
      const n = BigInt(r.result.blockNumber);
      const idx = Number(r.result.transactionIndex);
      const b = await rpc('eth_getBlockByNumber', [r.result.blockNumber, true]);
      const txs: any[] = b.result?.transactions ?? [];
      const prefix: ReplayCall[] = txs.slice(0, idx + 1)
        .filter((t) => t.to && USER_TX_TYPES.has(String(t.type ?? '0x0').toLowerCase()))
        .map((t) => ({ from: t.from, to: t.to, data: t.input ?? t.data ?? '0x', value: t.value, gas: t.gas }));
      if (!prefix.length || !txs[idx] || txs[idx].hash?.toLowerCase() !== hash.toLowerCase()) return null;
      return { block: r.result.blockNumber, parent: '0x' + (n - 1n).toString(16), prefix, time: b.result?.timestamp, index: idx };
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }
  return null;
}
// Node can't serve an older block's state (same text as shadowMain STATE_GONE).
const STATE_GONE = /missing trie node|historical state|state.*(not available|unavailable)|header not found|unknown block|pruned/i;

// ---- Permission from the main thread for each loop node request ------------
let permitId = 0;
const permitWaiters = new Map<number, (ok: boolean) => void>();
const askPermit = (): Promise<boolean> => new Promise((resolve) => {
  const id = ++permitId;
  const timer = setTimeout(() => { if (permitWaiters.delete(id)) resolve(false); }, 1_000);
  permitWaiters.set(id, (ok) => { clearTimeout(timer); resolve(ok); });
  post({ t: 'permit', id, at: Date.now() });
});

// ---- State ------------------------------------------------------------------
let core: LoopWorkerCore | null = null;
let guard: LoopNodeGuard | null = null;
let throttle: LoopNodeThrottle | null = null;
let init: LoopWorkerInit | null = null;
let hourStart = Date.now();
let scanWanted = false;
let scanScheduled = false;
let syncWanted = false;
let lastDigest: string | undefined;
let toAck: number[] = [];

function start(cfg: LoopWorkerInit): void {
  init = cfg;
  const nodeCfg = cfg.node.cfg;
  guard = new LoopNodeGuard(nodeCfg, Date.now, (m) => log(m));
  // Free mode: loops' own LOOP_NODE_MAX_RPS here, the shared allowance on the main thread.
  throttle = new LoopNodeThrottle(cfg.node.maxRps, () => null);
  if (cfg.node.sharedBudget) throttle.permit = askPermit;
  if (cfg.node.slotsFile) loadBalanceSlots(cfg.node.slotsFile); // read only: loop checks never save slots
  // Test mode: a fake node that answers at once (still passes the throttle and permission).
  const fakeNode: Rpc = async () => ({ result: '0x' });
  const baseRpc: Rpc = cfg.testHooks && cfg.fakeCheck ? fakeNode : makeRpc(nodeCfg.customUrl ?? cfg.node.freeUrl);
  const rpc = guard.watch(throttle.wrap(baseRpc));
  const fake = cfg.testHooks ? cfg.fakeCheck : undefined;
  const deps: LoopCheckDeps = {
    rpc,
    secondOpinion: null,
    // Free node: token balance locations are only read (never saved), as before.
    simulate: fake
      ? async (r): Promise<SimResult> => { await r('eth_call', []); return fake === 'profit' ? { status: 'profit', profit: 1n } : fake === 'loss' ? { status: 'loss' } : { status: 'fail', reason: 'fake fail' }; }
      : (r, trade, opts) => simulateRoundTrip(r, 'robinhood', trade, { ...opts, slotReadOnly: true }),
    findSpot: (r, hash) => findTriggerSpot(r, hash, cfg.node.triggerPollMs, cfg.node.triggerMaxPolls),
    replay: replayRpc,
    stateGone: STATE_GONE,
    weth: cfg.node.weth,
    triggerReplay: cfg.fix.triggerReplay,
    tagLatest: cfg.fix.triggerReplay || cfg.fix.modelVsCheck,
    replayAllowed: () => guard!.replay !== 'no',
    lean: true,
  };
  // Same steps as shadowMain loopCheck (free node branch).
  const loopCheck = async (trade: LoopTrade, triggerHash?: string): Promise<LoopCheckResult> => {
    const g = guard!, th = throttle!;
    g.noteStart();
    th.beginCheck();
    try {
      if (cfg.fix.triggerReplay && triggerHash) await g.probeReplay(rpc);
      const r = await runLoopCheck(deps, trade, triggerHash);
      g.noteResult(r);
      return r;
    } catch (e) {
      if (!(e instanceof LoopNodeBusy)) throw e;
      th.busySkips++;
      return { status: 'unsupported', reason: e.message };
    } finally {
      if (th.sentThisCheck > 0) g.countCheck();
    }
  };
  // COIN TAX TEST (Oct 20): one free simulation per coin on the loop node,
  // through the same gate as loop checks (own limit + permission), run only
  // when no loop check is running (the loop trader makes sure of that).
  const taxBook = cfg.tax?.cfg.enabled ? new CoinTaxBook(cfg.tax.cfg, async (token, holder) => {
    const th = throttle!;
    guard!.noteStart(); // a fresh start for "slow down" bookkeeping, like a loop check
    th.beginCheck();
    try { return cfg.testHooks && cfg.fakeCheck ? { verdict: 'ok' as const } : await testCoinTax(rpc, token, holder); }
    catch (e) {
      if (e instanceof LoopNodeBusy) { th.busySkips++; return { verdict: null, why: e.message }; }
      return { verdict: null, why: (e as Error).message };
    }
  }, {
    file: cfg.tax.file,
    log: (m) => log(m),
    symbolOf: (t) => core?.symbolOf(t) ?? t,
    alwaysOk: cfg.bases,
  }) : null;
  if (taxBook) setInterval(() => taxBook.save(), 60_000).unref?.();
  core = new LoopWorkerCore(cfg, {
    ...(taxBook ? { coinTax: taxBook } : {}),
    runCheck: (trade, ctx) => loopCheck(trade, ctx?.triggerHash),
    canCheckNode: () => guard!.canCheck(),
    log: (m) => log(m),
    noteGas: (pools, gasUsed) => post({ t: 'noteGas', pools, gasUsed }),
  });
  hourStart = Date.now();
  // Every 15 min: the hour so far (read only), same line as before.
  setInterval(() => {
    try {
      const c = core!, g = guard!, th = throttle!;
      log(loopLogLine(c.trader.peekHour(), cfg.loopCfg.maxPools, `hour so far (${Math.round((Date.now() - hourStart) / 60_000)} min)`,
        loopNodeText({ ...g.peekHour(), busySkips: th.busySkips })));
    } catch (err) { log(`[loop] summary line failed (ignored): ${(err as Error).message}`, 'warn'); }
  }, cfg.peekMs).unref?.();
  // Size and memory for the main thread's [mem] line.
  const stats = () => {
    const h = getHeapStatistics();
    const c = core!;
    post({ t: 'stats', s: { heapUsed: h.used_heap_size, heapTotal: h.total_heap_size, cycles: c.trader.finder.cycleCount(), pools: c.poolCount(), pending: c.pendingCount(), scans: c.scans, lastScanMs: c.lastScanMs } });
  };
  setInterval(stats, cfg.statsMs).unref?.();
  stats();
  post({ t: 'ready' });
}

// Run one scan for everything that arrived (several messages = one scan).
async function runScan(): Promise<void> {
  scanScheduled = false;
  const c = core;
  if (!c) return;
  if (scanWanted) {
    scanWanted = false;
    try { lastDigest = init?.testHooks ? loopResultsDigest(c.scan()) : (c.scan(), undefined); }
    catch (err) { log(`[loop] scan failed (ignored): ${(err as Error).message}`, 'warn'); }
    // Tests: wait until a loop list rebuild started by this scan has finished.
    if (syncWanted) { syncWanted = false; await c.trader.finder.idle(); }
  }
  ackAll();
}

function ackAll(): void {
  if (!toAck.length) return;
  const seq = Math.max(...toAck);
  toAck = [];
  post({ t: 'ack', seq, ...(lastDigest !== undefined ? { digest: lastDigest } : {}) });
}

function onBatch(b: LoopBatch): void {
  const c = core;
  if (!c) return;
  c.apply(b);
  toAck.push(b.seq);
  if (b.scan && !b.partial) { scanWanted = true; if (b.sync) syncWanted = true; }
  if (!scanWanted && !scanScheduled) { ackAll(); return; }
  if (!scanScheduled) { scanScheduled = true; setImmediate(() => { void runScan(); }); }
}

port.on('message', (m: ToWorker) => {
  try {
    switch (m.t) {
      case 'init': start(m); break;
      case 'batch': onBatch(m); break;
      case 'permit': { const w = permitWaiters.get(m.id); if (w) { permitWaiters.delete(m.id); w(m.ok); } break; }
      case 'takeHour': {
        if (!core || !guard || !throttle || !init) break;
        const h = core.trader.takeHour();
        hourStart = Date.now();
        const node = loopNodeText({ ...guard.takeHour(), busySkips: throttle.takeBusy() });
        post({ t: 'hour', id: m.id, h, node });
        break;
      }
      case 'crash':
        // Tests only: make the thread fail, to check the main thread survives and restarts it.
        if (init?.testHooks) setImmediate(() => { throw new Error('test crash'); });
        break;
    }
  } catch (err) {
    post({ t: 'error', message: (err as Error).message });
  }
});
