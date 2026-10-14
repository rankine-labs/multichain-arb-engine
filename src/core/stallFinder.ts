import { PerformanceObserver, constants as perfConstants } from 'perf_hooks';

// ============================================================================
// STALL FINDER ("what froze the bot?")
//
// Plain English:
//   The bot does everything on ONE thread. While it is busy with a big job
//   (rebuilding a list, saving a large file, cleaning up memory) it cannot
//   look at a new trade from the feed, so that trade waits. The hourly
//   report showed the bot freezing for 200-400 ms about 1% of the time, and
//   trades that arrived during a freeze were late (we lost a $54 race by
//   0.11 s).
//
//   This file finds out WHICH job causes each freeze:
//     1. Named jobs are wrapped with a stopwatch (run / runAsync / begin).
//        It records how long each job held the thread without a break.
//     2. A tiny timer ticks every 20 ms. If a tick arrives more than 50 ms
//        late, the bot was frozen; we note that freeze and which jobs were
//        running during it.
//     3. Node's own memory clean-up ("GC", garbage collection) is watched
//        too. A big clean-up also freezes the bot and is listed as "GC".
//     4. Freeze time that no named job explains is listed as "other"
//        (plus which slow background jobs were in progress at the time).
//
//   Reported as one log line every 5 minutes and two lines in the hourly
//   Telegram report, e.g.
//     Freezes over 50 ms: 14 (worst 400 ms) · top causes: extra-pool pick 1x
//     (max 400 ms), loop scan 3x (max 60 ms), GC 9x (max 80 ms)
//
//   Measurement only: nothing here changes what the bot trades.
//   Cost: one timer every 20 ms and two clock reads per wrapped job.
//   Memory is bounded (fixed-size lists, see the MAX_ numbers below).
//
// Switch: STALL_FINDER=0 turns the detector and GC watcher off (the job
// wrappers then just run the job). On by default.
// ============================================================================

const MAX_STALLS = 2_000;   // freezes remembered (enough for an hour of a bad case)
const MAX_SLICES = 512;     // recent job slices kept to explain the next freeze
const MAX_GC = 1_000;       // recent memory clean-ups kept to explain freezes
const MIN_SLICE_MS = 1;     // job slices shorter than this can't explain a 50 ms freeze

// One stretch of a named job holding the thread (performance.now() times).
interface Slice { name: string; start: number; end: number; selfMs: number }
// One memory clean-up.
interface GcPause { start: number; end: number; kind: string }
// One freeze.
interface Stall {
  start: number;              // last on-time tick (performance.now())
  end: number;                // the late tick
  ms: number;                 // how late the tick was (the freeze length)
  jobs: Map<string, number>;  // job name -> ms of the freeze it explains
  during: string[];           // slow background jobs in progress at the time
}

// Per-window totals for every named job (for the "longest steps" list).
interface JobTotals { n: number; totalMs: number; maxMs: number }
interface GcTotals { n: number; totalMs: number; maxMs: number; maxKind: string; major: number }

export interface CauseSummary { name: string; n: number; maxMs: number }
export interface StallSummary {
  freezes: number;            // freezes over the threshold in this window
  worstMs: number;            // longest freeze
  thresholdMs: number;
  causes: CauseSummary[];     // biggest causes first
  gc: GcTotals;               // every memory clean-up in this window
  longest: { name: string; maxMs: number; n: number }[]; // named jobs with the longest single stretch
  enabled: boolean;
}

// Name Node gives each kind of memory clean-up, in plain words.
function gcKindName(kind: number | undefined): string {
  const c = perfConstants as unknown as Record<string, number>;
  if (kind === c.NODE_PERFORMANCE_GC_MAJOR) return 'major';
  if (kind === c.NODE_PERFORMANCE_GC_MINOR) return 'minor';
  if (kind === c.NODE_PERFORMANCE_GC_INCREMENTAL) return 'incremental';
  if (kind === c.NODE_PERFORMANCE_GC_WEAKCB) return 'weak-callback';
  return 'other';
}

const emptyGc = (): GcTotals => ({ n: 0, totalMs: 0, maxMs: 0, maxKind: '', major: 0 });

// One reporting window (5-minute log line, or the hourly report).
class Window {
  started = performance.now();
  jobs = new Map<string, JobTotals>();
  gc = emptyGc();
  reset(now: number) { this.started = now; this.jobs.clear(); this.gc = emptyGc(); }
}

export interface StallFinderOptions {
  thresholdMs?: number;   // freezes longer than this are counted (default 50)
  tickMs?: number;        // detector tick (default 20)
  enabled?: boolean;      // default: STALL_FINDER is not 0
}

export class StallFinder {
  readonly thresholdMs: number;
  readonly tickMs: number;
  readonly enabled: boolean;
  private timer: NodeJS.Timeout | null = null;
  private gcObs: PerformanceObserver | null = null;
  private lastTick = 0;
  private stalls: Stall[] = [];
  private slices: Slice[] = [];
  private gcs: GcPause[] = [];
  // Jobs running right now (a stack: a job may call another named job).
  private stack: { name: string; start: number; childMs: number }[] = [];
  // Slow background jobs started but not finished (name -> how many).
  private inFlight = new Map<string, number>();
  private win = { fiveMin: new Window(), hour: new Window() };

  constructor(opts: StallFinderOptions = {}) {
    this.thresholdMs = opts.thresholdMs ?? 50;
    this.tickMs = opts.tickMs ?? 20;
    this.enabled = opts.enabled ?? (process.env.STALL_FINDER !== '0' && process.env.STALL_FINDER !== 'off');
  }

  // ---- Start / stop the detector ------------------------------------------
  start(): this {
    if (!this.enabled || this.timer) return this;
    this.lastTick = performance.now();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();   // never keeps the process alive on its own
    try {
      this.gcObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const kind = gcKindName((e as any).detail?.kind ?? (e as any).kind);
          this.noteGc(e.startTime, e.duration, kind);
        }
      });
      this.gcObs.observe({ entryTypes: ['gc'] });
    } catch { this.gcObs = null; /* GC watching not available: freezes are still found */ }
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.gcObs?.disconnect(); } catch { /* fine */ }
    this.gcObs = null;
  }

  // The 20 ms tick: a late tick means the bot was frozen in between.
  private tick(now = performance.now()): void {
    const gap = now - this.lastTick;
    this.lastTick = now;
    const late = gap - this.tickMs;
    if (late > this.thresholdMs) this.recordStall(now - gap, now, late);
  }

  // Exposed for tests: record a freeze between two times.
  recordStall(start: number, end: number, ms: number): void {
    const jobs = new Map<string, number>();
    // Every job stretch that overlapped the freeze explains part of it.
    // A job that called another job only counts its own time.
    // (Slices are stored in the order they ended, so walking back we can
    // stop at the first one that ended before the freeze began.)
    for (let i = this.slices.length - 1; i >= 0; i--) {
      const s = this.slices[i];
      if (s.end <= start) break;
      if (s.start >= end) continue;
      const dur = s.end - s.start;
      const overlap = Math.min(s.end, end) - Math.max(s.start, start);
      if (overlap <= 0 || dur <= 0) continue;
      const own = overlap * Math.min(1, Math.max(0, s.selfMs / dur));
      if (own > 0) jobs.set(s.name, (jobs.get(s.name) ?? 0) + own);
    }
    const during = [...this.inFlight.keys()].sort();
    this.stalls.push({ start, end, ms, jobs, during });
    if (this.stalls.length > MAX_STALLS) this.stalls.splice(0, this.stalls.length - MAX_STALLS);
  }

  // A memory clean-up finished (Node tells us shortly after it happened).
  noteGc(start: number, durationMs: number, kind: string): void {
    for (const w of [this.win.fiveMin, this.win.hour]) {
      const g = w.gc;
      g.n++; g.totalMs += durationMs;
      if (kind === 'major') g.major++;
      if (durationMs > g.maxMs) { g.maxMs = durationMs; g.maxKind = kind; }
    }
    if (durationMs >= MIN_SLICE_MS) {
      this.gcs.push({ start, end: start + durationMs, kind });
      if (this.gcs.length > MAX_GC) this.gcs.splice(0, this.gcs.length - MAX_GC);
    }
  }

  // ---- Wrapping jobs ---------------------------------------------------------
  // Record that job `name` held the thread from `start` to `end`.
  noteSlice(name: string, start: number, end: number, selfMs = end - start): void {
    const ms = end - start;
    for (const w of [this.win.fiveMin, this.win.hour]) {
      const j = w.jobs.get(name) ?? { n: 0, totalMs: 0, maxMs: 0 };
      j.n++; j.totalMs += ms; if (ms > j.maxMs) j.maxMs = ms;
      w.jobs.set(name, j);
    }
    if (ms >= MIN_SLICE_MS) {
      this.slices.push({ name, start, end, selfMs });
      if (this.slices.length > MAX_SLICES) this.slices.splice(0, this.slices.length - MAX_SLICES);
    }
  }

  // Start timing a synchronous stretch by hand; call the returned function
  // when the stretch ends. Use for code that can't be put in a callback.
  begin(name: string): () => void {
    const frame = { name, start: performance.now(), childMs: 0 };
    this.stack.push(frame);
    // Safety: a job that threw before ending its timer must not pile up here.
    if (this.stack.length > 50) this.stack.splice(0, this.stack.length - 50);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const end = performance.now();
      const i = this.stack.lastIndexOf(frame);
      if (i >= 0) this.stack.splice(i, 1);
      const ms = end - frame.start;
      // The job that called this one doesn't get blamed for this time.
      const parent = this.stack[this.stack.length - 1];
      if (parent) parent.childMs += ms;
      this.noteSlice(name, frame.start, end, Math.max(0, ms - frame.childMs));
    };
  }

  // Time a synchronous job. Returns what the job returns.
  run<T>(name: string, fn: () => T): T {
    const end = this.begin(name);
    try { return fn(); } finally { end(); }
  }

  // Time an async job. The part before its first "await" is timed as one
  // stretch (that is where async jobs usually do their heavy work); the job
  // also counts as "in progress" until it finishes, so a freeze that no
  // named job explains says which slow jobs were running at the time.
  // track = false: don't list it as "in progress" (for jobs that are almost
  // always running, like feed trades waiting on a check).
  runAsync<T>(name: string, fn: () => Promise<T>, track = true): Promise<T> {
    if (track) this.inFlight.set(name, (this.inFlight.get(name) ?? 0) + 1);
    const done = () => {
      if (!track) return;
      const n = (this.inFlight.get(name) ?? 1) - 1;
      if (n <= 0) this.inFlight.delete(name); else this.inFlight.set(name, n);
    };
    const end = this.begin(name);
    let p: Promise<T>;
    try { p = fn(); } catch (err) { end(); done(); return Promise.reject(err); }
    end();
    return p.finally(done);
  }

  // ---- Reports ----------------------------------------------------------------
  // Summary for one window, then a fresh window starts.
  take(which: 'fiveMin' | 'hour', now = performance.now()): StallSummary {
    const w = this.win[which];
    const from = w.started;
    const causes = new Map<string, { n: number; maxMs: number }>();
    const add = (name: string, ms: number) => {
      const c = causes.get(name) ?? { n: 0, maxMs: 0 };
      c.n++; if (ms > c.maxMs) c.maxMs = ms;
      causes.set(name, c);
    };
    let freezes = 0, worstMs = 0;
    for (const s of this.stalls) {
      if (s.end < from || s.end > now) continue;
      freezes++;
      if (s.ms > worstMs) worstMs = s.ms;
      let explained = 0;
      for (const [name, ms] of s.jobs) { add(name, ms); explained += ms; }
      // Memory clean-ups that overlapped the freeze (GC entries can arrive
      // a moment after the freeze was noticed, so they're matched here).
      let gcMs = 0;
      for (const g of this.gcs) {
        const o = Math.min(g.end, s.end) - Math.max(g.start, s.start);
        if (o > 0) gcMs += o;
      }
      if (gcMs > 0) { add('GC', gcMs); explained += gcMs; }
      // Whatever isn't explained by a named job or GC: "other".
      const rest = s.ms - explained;
      if (rest > Math.max(20, s.ms * 0.3)) add(s.during.length ? `other (during ${s.during.slice(0, 2).join(', ')})` : 'other', rest);
    }
    const list = [...causes.entries()].map(([name, c]) => ({ name, n: c.n, maxMs: c.maxMs }))
      .sort((a, b) => b.n * b.maxMs - a.n * a.maxMs || b.maxMs - a.maxMs);
    const longest = [...w.jobs.entries()].map(([name, j]) => ({ name, maxMs: j.maxMs, n: j.n }))
      .sort((a, b) => b.maxMs - a.maxMs);
    const out: StallSummary = { freezes, worstMs, thresholdMs: this.thresholdMs, causes: list, gc: { ...w.gc }, longest, enabled: this.enabled };
    w.reset(now);
    return out;
  }
}

// Readable ms: 0.4 -> "0.4", 12.6 -> "13".
const fmt = (ms: number) => (ms < 10 ? (Math.round(ms * 10) / 10).toString() : Math.round(ms).toString());

// "Freezes over 50 ms: 14 (worst 400 ms) · top causes: extra-pool pick 1x (max 400 ms), GC 9x (max 80 ms)"
export function formatStallLine(s: StallSummary, maxCauses = 4): string {
  if (!s.enabled) return 'Freezes: stall finder off (STALL_FINDER=0)';
  if (!s.freezes) return `Freezes over ${s.thresholdMs} ms: none`;
  const causes = s.causes.slice(0, maxCauses).map((c) => `${c.name} ${c.n}x (max ${fmt(c.maxMs)} ms)`).join(', ');
  return `Freezes over ${s.thresholdMs} ms: ${s.freezes} (worst ${fmt(s.worstMs)} ms)${causes ? ` · top causes: ${causes}` : ''}`;
}

// "Memory clean-up (GC): 812x, 1.9 s in total, worst 85 ms (major), 6 major · longest single steps: loop scan 14 ms, ..."
export function formatStallDetail(s: StallSummary, maxJobs = 4): string {
  if (!s.enabled) return '';
  const g = s.gc;
  const total = g.totalMs >= 1000 ? `${(g.totalMs / 1000).toFixed(1)} s` : `${fmt(g.totalMs)} ms`;
  const gcText = g.n ? `Memory clean-up (GC): ${g.n}x, ${total} in total, worst ${fmt(g.maxMs)} ms (${g.maxKind || '?'}), ${g.major} major` : 'Memory clean-up (GC): none seen';
  const jobs = s.longest.filter((j) => j.maxMs >= 5).slice(0, maxJobs).map((j) => `${j.name} ${fmt(j.maxMs)} ms`).join(', ');
  return `${gcText}${jobs ? ` · longest single steps: ${jobs}` : ''}`;
}

// The bot's one stall finder (started in shadowMain). Other files use the
// helpers below; before start() they only time jobs (no detector yet).
export const stallFinder = new StallFinder();
export const timed = <T>(name: string, fn: () => T): T => stallFinder.run(name, fn);
export const timedAsync = <T>(name: string, fn: () => Promise<T>, track = true): Promise<T> => stallFinder.runAsync(name, fn, track);
