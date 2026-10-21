import { Worker } from 'worker_threads';
import { join } from 'path';
import { timed } from './stallFinder';
import type { MainLoopFeeder, LoopWorkerInit, FromWorker, ToWorker, WorkerStats, RivalNote } from './loopWorkerFeed';
import type { LoopHour } from './loopTrader';
import type { TriggerTrade } from './loopPrices';

// ============================================================================
// LOOP WORKER HOST: the main thread's side of the loop worker (Oct 15,
// owner approved). PRACTICE ONLY.
//
// Plain English:
//   Starts the loop worker thread (core/loopWorkerEntry.ts), sends it the
//   cheap updates (core/loopWorkerFeed.ts MainLoopFeeder) and handles what it
//   sends back:
//     - "may I use the free node?" questions (answered at once, see permit);
//     - log lines (printed here, so the key scrubber sees them);
//     - gas used by practice replays (teaches the gas model, as before);
//     - the hour's loop numbers (for the hourly report and status page);
//     - its size and memory (for the [mem] line).
//
//   If the worker crashes it is logged and started again after a pause
//   (5 s, then 30 s, then 2 min), at most 3 times an hour. After that, loops
//   stay off until the hour has passed. The main thread NEVER goes down with
//   it. On shutdown the worker is stopped.
// ============================================================================

// Anything that behaves like a Node Worker (tests pass a fake one).
export interface WorkerLike {
  postMessage(m: ToWorker): void;
  on(ev: 'message', f: (m: FromWorker) => void): unknown;
  on(ev: 'error', f: (e: Error) => void): unknown;
  on(ev: 'exit', f: (code: number) => void): unknown;
  terminate(): Promise<number> | void;
}

export interface LoopWorkerHostOptions {
  init: LoopWorkerInit;
  feeder: MainLoopFeeder;
  // Main thread: may the worker send one request to the free node now? (counts it if yes)
  permit: () => boolean;
  noteGas: (pools: number, gasUsed: bigint) => void;
  log: (line: string) => void;
  warn: (line: string) => void;
  entry?: string;                 // worker file (default: loopWorkerEntry.js next to this file)
  heapMb?: number;                // worker's own memory limit (LOOP_WORKER_HEAP_MB, default 256)
  restartDelaysMs?: number[];     // pause before restart 1, 2, 3 (5 s, 30 s, 2 min)
  maxRestartsPerHour?: number;    // 3
  flushMs?: number;               // at most one message per this many ms (50)
  now?: () => number;
  createWorker?: (file: string, heapMb: number) => WorkerLike;
  onAck?: (seq: number, digest: string | undefined) => void; // tests
  // The hour's numbers arrived after takeHour gave up waiting (the worker had
  // already started a new hour): handed here so they are still logged.
  onLateHour?: (r: { h: LoopHour; node: string }) => void;
  readyTimeoutMs?: number;        // a started worker must say "ready" within this (10 s)
  permitMaxAgeMs?: number;        // older "may I?" questions are answered no (900 ms; the worker gives up at 1 s)
  autoFlush?: boolean;            // tests: false = send only on flushNow (default true)
  // LIVE LOOPS: a loop the worker handed over (execution/loopLive.ts decides).
  onLiveCandidate?: (c: import('../execution/loopLive').LoopLiveCandidate) => void;
}

export function loopWorkerHeapMbFromEnv(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.LOOP_WORKER_HEAP_MB ?? 256);
  return Number.isFinite(v) && v >= 64 ? Math.min(1_024, Math.round(v)) : 256;
}

const defaultCreate = (file: string, heapMb: number): WorkerLike => new Worker(file, {
  resourceLimits: { maxOldGenerationSizeMb: heapMb },
  // The main thread's own memory flag must not apply to the worker (its
  // limit is resourceLimits above).
  execArgv: process.execArgv.filter((a) => !a.startsWith('--max-old-space-size')),
});

export class LoopWorkerHost {
  private worker: WorkerLike | null = null;
  private ready = false;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private wantScan = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private restartTimes: number[] = [];
  private hourId = 0;
  private hourWaiters = new Map<number, (r: { h: LoopHour; node: string } | null) => void>();
  private readyTimer: NodeJS.Timeout | null = null;
  permitsStale = 0;
  private readonly now: () => number;
  private readonly flushMs: number;
  stats: WorkerStats | null = null;
  crashes = 0;
  restarts = 0;
  permitsAsked = 0;
  permitsGiven = 0;
  postErrors = 0;

  constructor(private o: LoopWorkerHostOptions) {
    this.now = o.now ?? Date.now;
    this.flushMs = o.flushMs ?? 50;
  }

  get alive(): boolean { return !!this.worker && this.ready; }

  start(): void {
    if (this.worker || this.stopping) return;
    const file = this.o.entry ?? join(__dirname, 'loopWorkerEntry.js');
    let w: WorkerLike;
    try { w = (this.o.createWorker ?? defaultCreate)(file, this.o.heapMb ?? 256); }
    catch (err) { this.o.warn(`[loop] worker could not start: ${(err as Error).message}`); this.scheduleRestart(); return; }
    this.worker = w;
    this.ready = false;
    this.o.feeder.reset();
    w.on('message', (m: FromWorker) => this.onMessage(w, m));
    w.on('error', (err: Error) => { if (this.worker === w) this.o.warn(`[loop] worker crashed: ${err?.message ?? err} (main thread keeps running)`); });
    w.on('exit', (code: number) => this.onExit(w, code));
    this.post(w, this.o.init);
    // A worker that never says "ready" (e.g. its start-up failed) would leave
    // loops dead without a sound: after readyTimeoutMs stop it and restart it
    // (counts toward the restarts-per-hour limit).
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.worker !== w || this.ready || this.stopping) return;
      this.o.warn(`[loop] worker did not start within ${Math.round((this.o.readyTimeoutMs ?? 10_000) / 1_000)} s: stopping it (main thread keeps running)`);
      this.worker = null;
      try { void Promise.resolve(w.terminate()).catch(() => undefined); } catch { /* already gone */ }
      this.crashes++;
      this.scheduleRestart();
    }, this.o.readyTimeoutMs ?? 10_000);
    this.readyTimer.unref?.();
  }

  // Stop for good (shutdown). Never throws.
  stop(): void {
    this.stopping = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
    const w = this.worker;
    this.worker = null; this.ready = false;
    for (const f of this.hourWaiters.values()) f(null);
    this.hourWaiters.clear();
    if (w) { try { void Promise.resolve(w.terminate()).catch(() => undefined); } catch { /* already gone */ } }
  }

  // ---- What the rest of the main thread calls (all cheap) -----------------
  requestScan(): void { this.wantScan = true; this.schedule(); }
  noteFeedTx(hash: string | undefined): void { this.o.feeder.noteFeedTx(hash); }
  noteTrade(pool: string, t: TriggerTrade): void { this.o.feeder.noteTrade(pool, t); }
  noteRival(r: RivalNote): void { this.o.feeder.noteRival(r); this.schedule(); }

  // The hour's loop numbers (and start a new hour in the worker). null when
  // the worker is down or did not answer within timeoutMs.
  takeHour(timeoutMs = 3_000): Promise<{ h: LoopHour; node: string } | null> {
    const w = this.worker;
    if (!w || !this.ready) return Promise.resolve(null);
    const id = ++this.hourId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { if (this.hourWaiters.delete(id)) resolve(null); }, timeoutMs);
      this.hourWaiters.set(id, (r) => { clearTimeout(timer); resolve(r); });
      this.post(w, { t: 'takeHour', id });
    });
  }

  // Tests only: send one message right now (no 50 ms wait). Returns its number, or null.
  flushNow(scan: boolean, sync = false): number | null {
    const w = this.worker;
    if (!w || !this.ready) return null;
    const b = this.o.feeder.build(scan, sync);
    if (!b) return null;
    this.post(w, b);
    return b.seq;
  }

  // Tests only: make the worker fail on purpose.
  crashForTest(): void { if (this.worker) this.post(this.worker, { t: 'crash' }); }

  // ---- Inside ----------------------------------------------------------------
  private schedule(): void {
    if (this.o.autoFlush === false) return;
    if (this.timer || !this.worker || !this.ready) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushMs);
  }

  private flush(): void {
    const w = this.worker;
    if (!w || !this.ready) return;
    timed('loop feed', () => {
      const scan = this.wantScan;
      const b = this.o.feeder.build(scan);
      if (!b) return; // worker behind: try again when it answers (wantScan kept)
      this.wantScan = false;
      this.post(w, b);
    });
  }

  private post(w: WorkerLike, m: ToWorker): void {
    try { w.postMessage(m); }
    catch (err) {
      // E.g. a value that can't be copied. Count it, say it now and then, and
      // start the next message from scratch so nothing is left half sent.
      this.postErrors++;
      if (this.postErrors % 100 === 1) this.o.warn(`[loop] message to worker failed (${this.postErrors}x): ${(err as Error).message}`);
      if (m.t === 'batch') this.o.feeder.reset();
    }
  }

  private onMessage(w: WorkerLike, m: FromWorker): void {
    if (this.worker !== w) return; // an old worker still talking
    try {
      switch (m.t) {
        case 'ready':
          this.ready = true;
          if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
          this.wantScan = true;
          this.schedule();
          break;
        case 'ack':
          this.o.feeder.ack(m.seq);
          this.o.onAck?.(m.seq, m.digest);
          // Something waited for the worker to catch up: send it now.
          if (this.wantScan || this.o.feeder.needsMore() || this.o.feeder.hasRivals()) this.schedule();
          break;
        case 'permit': {
          this.permitsAsked++;
          let ok = false;
          // Asked too long ago (main thread was busy): the worker has given up
          // on it (1 s), so a yes would only waste a slot of the shared allowance.
          if (typeof m.at === 'number' && this.now() - m.at > (this.o.permitMaxAgeMs ?? 900)) { this.permitsStale++; this.post(w, { t: 'permit', id: m.id, ok: false }); break; }
          try { ok = this.o.permit(); } catch { ok = false; }
          if (ok) this.permitsGiven++;
          this.post(w, { t: 'permit', id: m.id, ok });
          break;
        }
        case 'log': (m.level === 'warn' ? this.o.warn : this.o.log)(m.line); break;
        case 'noteGas': this.o.noteGas(m.pools, m.gasUsed); break;
        case 'hour': {
          const f = this.hourWaiters.get(m.id);
          if (f) { this.hourWaiters.delete(m.id); f({ h: m.h, node: m.node }); }
          else this.o.onLateHour?.({ h: m.h, node: m.node }); // too late for the report: still logged
          break;
        }
        case 'stats': this.stats = m.s; break;
        case 'liveCandidate': this.o.onLiveCandidate?.(m.c); break;
        case 'error': this.o.warn(`[loop] worker problem (ignored): ${m.message}`); break;
      }
    } catch (err) {
      this.o.warn(`[loop] worker message handling failed (ignored): ${(err as Error).message}`);
    }
  }

  private onExit(w: WorkerLike, code: number): void {
    if (this.worker !== w) return;
    this.worker = null; this.ready = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (const f of this.hourWaiters.values()) f(null);
    this.hourWaiters.clear();
    if (this.stopping) return;
    this.crashes++;
    this.o.warn(`[loop] worker stopped (exit code ${code}); loop numbers since the last hourly report are lost (main thread keeps running)`);
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer) return;
    const now = this.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < 3_600_000);
    const max = this.o.maxRestartsPerHour ?? 3;
    const delays = this.o.restartDelaysMs ?? [5_000, 30_000, 120_000];
    let wait: number;
    if (this.restartTimes.length >= max) {
      // Too many this hour: wait until the oldest restart is an hour old.
      wait = Math.max(1_000, this.restartTimes[0] + 3_600_000 - now);
      this.o.warn(`[loop] worker restarted ${this.restartTimes.length} times in the last hour: loops paused for ${Math.ceil(wait / 60_000)} min (2-pool trading not affected)`);
    } else {
      wait = delays[Math.min(this.restartTimes.length, delays.length - 1)] ?? 5_000;
      this.o.warn(`[loop] restarting loop worker in ${Math.round(wait / 1_000)} s`);
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.restartTimes.push(this.now());
      this.restarts++;
      this.start();
    }, wait);
    this.restartTimer.unref?.();
  }
}
