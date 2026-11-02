import { Session, console as inspectorConsole } from 'inspector';
import { mkdir, readdir, unlink, writeFile } from 'fs/promises';
import { basename, join } from 'path';

// ============================================================================
// FREEZE NAMER ("name every freeze, even the ones nobody labelled")
//
// Plain English:
//   The stall finder (core/stallFinder.ts) notices when the bot's one thread
//   froze for 50 ms or more, and blames the named job that was running.
//   Most freeze time had NO named job running, so it was listed as "other"
//   (211 freezes up to 898 ms on Nov 1). The old freeze profile
//   (core/freezeProfile.ts) recorded 5 s at random, and only 2-11% of each
//   recording was a freeze, so its top list showed normal work, not the
//   freezes.
//
//   This file keeps Node's built-in CPU profiler running in short pieces
//   (FREEZE_NAMER_CHUNK_S, default 10 s; the profiler itself is never
//   stopped in between, see start()). Every piece is cut out of the
//   profiler, and ONLY the samples that fall inside a freeze the stall
//   finder saw are kept. Everything outside a freeze is thrown away. So the
//   answer is "what was running during the freezes", not "what was running
//   on average".
//
//   For every freeze it notes:
//     - "step": the outermost and innermost piece of OUR code on the call
//       stack (e.g. "onFeedMessage (shadowMain.js:812) > buildTable
//       (trigEntry.js:340)"), or a library / Node internal when none of our
//       code is on the stack (e.g. "JSON.parse", "(garbage collector)").
//     - "function": the function that was actually running (self time).
//     - "not running": freeze time with no profile sample at all. If this
//       is big, the whole process was paused by the operating system (for
//       example the other programs on the server took both CPU cores), not
//       busy running our code.
//     - "idle": the thread was waiting, not busy (also points at the
//       operating system, or a timer that fired late for another reason).
//
//   Every 5 minutes it logs one line, ranked by total freeze ms:
//     [freeze-named] 5 min: 31 freezes, 3.1 s frozen, 95% sampled · by
//     step: A 820 ms (worst 300 ms, 12x); ... · by function: ...
//   and saves a small JSON file with the top 40 lists and the 15 worst
//   freezes (data/profiles/freeze-named-<time>.json, newest 48 kept).
//
// Cost: the profiler samples the stack ~1,000 times a second (a few % of
// one core); cutting a piece every 10 s takes about 1 ms (timed by the stall
// finder as "freeze namer cut", so if it ever causes a freeze, it is named
// too). It stops by itself after FREEZE_NAMER_MINUTES (default 120) so it
// never runs forever. Measurement only: it never changes a trade.
//
// Switch: FREEZE_NAMER=0 turns it off (the old 5 s freeze profile is used
// again in that case). On by default.
// ============================================================================

export type FreezeNamerSettings = {
  enabled: boolean;     // FREEZE_NAMER [1]
  chunkMs: number;      // FREEZE_NAMER_CHUNK_S [10] profiler is cut and restarted this often
  intervalUs: number;   // FREEZE_NAMER_INTERVAL_US [1000] how often the profiler looks (microseconds)
  minutes: number;      // FREEZE_NAMER_MINUTES [120] stop by itself after this long (0 = never)
  minFreezeMs: number;  // FREEZE_NAMER_MS [50] freezes shorter than this are ignored
  keep: number;         // FREEZE_NAMER_KEEP [48] newest JSON summaries kept (48 = 4 hours)
  dir: string;          // FREEZE_NAMER_DIR [data/profiles]
};

export function freezeNamerSettings(env: Record<string, string | undefined> = process.env): FreezeNamerSettings {
  // Read a number setting; anything missing or out of range = the default.
  const num = (k: string, d: number, min: number, max: number) => {
    const raw = env[k];
    const v = Number(raw);
    return raw !== undefined && raw.trim() !== '' && Number.isFinite(v) && v >= min && v <= max ? v : d;
  };
  const sw = (env.FREEZE_NAMER ?? '1').trim().toLowerCase();
  return {
    enabled: sw !== '0' && sw !== 'off' && sw !== 'false',
    chunkMs: num('FREEZE_NAMER_CHUNK_S', 10, 2, 120) * 1_000,
    intervalUs: Math.round(num('FREEZE_NAMER_INTERVAL_US', 1_000, 100, 20_000)),
    minutes: num('FREEZE_NAMER_MINUTES', 120, 0, 7 * 24 * 60),
    minFreezeMs: num('FREEZE_NAMER_MS', 50, 1, 60_000),
    keep: Math.round(num('FREEZE_NAMER_KEEP', 48, 1, 500)),
    dir: (env.FREEZE_NAMER_DIR ?? '').trim() || 'data/profiles',
  };
}

// The parts of a V8 CPU profile we read (inspector Profiler.stop result).
export type NamerProfile = {
  nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }>;
  startTime: number;   // microseconds, same clock as process.hrtime (checked in the tests)
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
};

// One freeze waiting to be named. Times are in profiler microseconds.
type PendingFreeze = {
  startUs: number; endUs: number; ms: number;
  cause: string;                 // what the stall finder blamed ("other" = nothing named)
  coveredUs: number;             // freeze time already matched to profile samples (or idle)
  steps: Map<string, number>;    // step label -> microseconds inside this freeze
  fns: Map<string, number>;      // running function -> microseconds
  idleUs: number;
  seenEnd: boolean;              // a profile piece reaching past the freeze end has been read
  at: number;                    // wall clock when seen (for the JSON file)
};

// Totals for one label over a 5-minute window.
type Tot = { totalMs: number; worstMs: number; n: number };
export type NamedRow = { name: string; totalMs: number; worstMs: number; n: number };
export type NamedSummary = {
  freezes: number;        // freezes named in this window
  frozenMs: number;       // their total length
  sampledMs: number;      // freeze time that had a profile sample (busy or idle)
  idleMs: number;         // of which the thread was idle
  notRunningMs: number;   // freeze time with no sample at all (process paused / not on a CPU)
  steps: NamedRow[];      // ranked by total ms
  fns: NamedRow[];
  byCause: { cause: string; n: number; ms: number; topSteps: NamedRow[] }[];
  worst: { at: string; ms: number; cause: string; steps: NamedRow[]; fns: NamedRow[]; idleMs: number; notRunningMs: number }[];
  pieces: number;         // profile pieces read
  cutMsMax: number;       // slowest cut + restart of the profiler (its own cost)
  dropped: number;        // freezes that could not be matched to a profile piece
};

// Not our code: Node internals, node_modules, built-ins with no file.
const isOurs = (url: string) => !!url && !url.startsWith('node:') && !url.includes('node_modules') && !url.includes('/internal/');
// Wrapper files that sit on every stack and say nothing about the cause.
const WRAPPER_FILES = new Set(['stallFinder.js', 'freezeNamer.js', 'chunked.js']);

// "functionName (file.js:123)"; V8 lines start at 0, people count from 1.
export function frameLabel(cf: { functionName: string; url: string; lineNumber: number }): string {
  const fn = cf.functionName || '(anonymous)';
  if (!cf.url) return fn; // (garbage collector), (program), (idle), (root), built-ins like JSON.parse
  const file = basename(cf.url.replace(/^file:\/\//, ''));
  return `${fn} (${file}:${(cf.lineNumber ?? 0) + 1})`;
}

// Per-profile lookup tables: parent of each node, and cached labels.
class ProfileIndex {
  private byId = new Map<number, NamerProfile['nodes'][number]>();
  private parent = new Map<number, number>();
  private stepCache = new Map<number, string>();
  private fnCache = new Map<number, string>();
  constructor(p: NamerProfile) {
    for (const n of p.nodes ?? []) this.byId.set(n.id, n);
    for (const n of p.nodes ?? []) for (const c of n.children ?? []) this.parent.set(c, n.id);
  }
  // The function that was running (leaf of the stack).
  fn(id: number): string {
    let s = this.fnCache.get(id);
    if (s === undefined) {
      const n = this.byId.get(id);
      s = n ? frameLabel(n.callFrame) : '(unknown)';
      this.fnCache.set(id, s);
    }
    return s;
  }
  // "outermost of our code > innermost of our code" on the stack. When none
  // of our code is on the stack: the outermost named frame (a library or
  // Node internal: says which kind of callback it was) > the running function.
  step(id: number): string {
    let s = this.stepCache.get(id);
    if (s !== undefined) return s;
    let inner: string | null = null, outer: string | null = null;
    let outerAny: string | null = null;
    for (let cur: number | undefined = id; cur !== undefined; cur = this.parent.get(cur)) {
      const n = this.byId.get(cur);
      if (!n) break;
      const cf = n.callFrame;
      if (cf.functionName === '(root)') break;
      if (isOurs(cf.url) && !WRAPPER_FILES.has(basename(cf.url))) {
        const l = frameLabel(cf);
        if (inner === null) inner = l;
        outer = l;
      }
      if (cf.url || cf.functionName) outerAny = frameLabel(cf);
    }
    const leaf = this.fn(id);
    if (inner && outer) s = inner === outer ? outer : `${outer} > ${inner}`;
    else if (outerAny && outerAny !== leaf) s = `${outerAny} > ${leaf}`;
    else s = leaf;
    this.stepCache.set(id, s);
    return s;
  }
}

const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
const toRows = (m: Map<string, Tot>, n: number): NamedRow[] =>
  [...m.entries()].map(([name, t]) => ({ name, totalMs: t.totalMs, worstMs: t.worstMs, n: t.n }))
    .sort((a, b) => b.totalMs - a.totalMs || b.worstMs - a.worstMs).slice(0, n);
const topOf = (m: Map<string, number>, n: number): NamedRow[] =>
  [...m.entries()].map(([name, us]) => ({ name, totalMs: us / 1_000, worstMs: us / 1_000, n: 1 }))
    .sort((a, b) => b.totalMs - a.totalMs).slice(0, n);

export class FreezeNamer {
  readonly s: FreezeNamerSettings;
  private session: Session | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopAt = Infinity;
  private pending: PendingFreeze[] = [];
  // The last piece cut out of the profiler, read at the NEXT cut: a freeze
  // that ends right at a cut is only reported by the stall finder a moment
  // later, so reading one piece late makes sure every freeze is waiting.
  private held: NamerProfile | null = null;
  // Window totals (reset by take()).
  private w = this.freshWindow();
  // perf.now() ms -> profiler microseconds (set when the profiler starts).
  private perfToUs = 0;
  running = false;
  pieces = 0;                         // pieces read since start (tests / status)
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  // Optional stopwatch from the stall finder (so the namer's own cost is named).
  private readonly time: (name: string) => () => void;

  constructor(opts: { settings?: FreezeNamerSettings; now?: () => number; log?: (m: string) => void; time?: (name: string) => () => void } = {}) {
    this.s = opts.settings ?? freezeNamerSettings();
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(m));
    this.time = opts.time ?? (() => () => undefined);
  }

  private freshWindow() {
    return {
      freezes: 0, frozenMs: 0, sampledMs: 0, idleMs: 0, notRunningMs: 0,
      steps: new Map<string, Tot>(), fns: new Map<string, Tot>(),
      causes: new Map<string, { n: number; ms: number; steps: Map<string, Tot> }>(),
      worst: [] as NamedSummary['worst'], pieces: 0, cutMsMax: 0, dropped: 0,
    };
  }

  // ---- Start / stop the profiler ---------------------------------------------
  // How the pieces are cut (cheap): starting V8's profiler from nothing makes
  // it list every piece of compiled code first (30+ ms on a test machine,
  // more on the bot). So the profiler is NEVER fully stopped while the namer
  // runs: each piece is a named recording ("freeze-namer-7"); the next one is
  // started BEFORE the previous one is ended, so the profiler keeps running
  // and a cut costs about 1 ms (measured in the tests).
  start(): boolean {
    if (!this.s.enabled || this.running) return false;
    try {
      const session = new Session();
      session.connect();
      this.session = session;
      // A finished piece arrives here (straight away in practice). The piece
      // before it is read now; this one is held until the next cut.
      session.on('Profiler.consoleProfileFinished', (m: any) => {
        const prof = (m?.params?.profile ?? null) as NamerProfile | null;
        try { if (this.held) this.readPiece(this.held); } catch { /* measurement only */ }
        this.held = prof;
      });
      this.post('Profiler.enable');
      this.post('Profiler.setSamplingInterval', { interval: this.s.intervalUs });
      inspectorConsole.profile(this.title(this.piece));
    } catch (e) {
      this.log(`[freeze-named] could not start the profiler (${(e as Error).message}); measurement only, the bot is unaffected`);
      this.shutdown();
      return false;
    }
    // Profiler times are process.hrtime microseconds; stall finder times are
    // performance.now() ms. Work out the difference once.
    this.perfToUs = Number(process.hrtime.bigint() / 1_000n) - performance.now() * 1_000;
    this.running = true;
    if (this.s.minutes > 0) this.stopAt = this.now() + this.s.minutes * 60_000;
    this.timer = setInterval(() => this.cut(), this.s.chunkMs);
    this.timer.unref?.();   // never keeps the process alive on its own
    return true;
  }

  // Each piece has its own name so two can overlap for a moment.
  private piece = 0;
  private title(n: number): string { return `freeze-namer-${n}`; }

  stop(why = 'stopped'): void {
    if (!this.running) return;
    try { this.cut(false); } catch { /* fine */ }
    try { this.flush(); } catch { /* fine */ }
    this.shutdown();
    this.log(`[freeze-named] profiler off (${why})`);
  }

  private shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // A piece still recording is ended (its result is ignored).
    if (this.running && this.session && this.piece >= 0) { try { this.held = null; inspectorConsole.profileEnd(this.title(this.piece)); } catch { /* fine */ } }
    this.held = null;
    if (this.session) { try { this.post('Profiler.disable'); } catch { /* fine */ } }
    try { this.session?.disconnect(); } catch { /* fine */ }
    this.session = null;
    this.running = false;
  }

  // In-process inspector calls answer straight away (checked in the tests).
  private post(method: string, params?: Record<string, unknown>): any {
    let out: any, err: Error | null = null;
    this.session!.post(method, params ?? {}, (e, r) => { err = e; out = r; });
    if (err) throw err;
    return out;
  }

  // Start the next piece, end the current one (its samples arrive in the
  // listener above), and read the piece before it. Never throws.
  // restart = false: end without starting a new piece (stopping).
  cut(restart = true): void {
    if (!this.running || !this.session) return;
    const end = this.time('freeze namer cut');
    const t0 = performance.now();
    const more = restart && this.now() < this.stopAt;
    try {
      if (more) inspectorConsole.profile(this.title(this.piece + 1));
      inspectorConsole.profileEnd(this.title(this.piece));
      this.piece++;
      if (!more) this.piece = -1;   // nothing recording any more
    } catch (e) {
      end();
      this.log(`[freeze-named] profiler problem (${(e as Error).message}); turned off, the bot is unaffected`);
      this.shutdown();
      return;
    }
    const ms = performance.now() - t0;
    if (ms > this.w.cutMsMax) this.w.cutMsMax = ms;
    end();
    if (restart && !more) {
      try { this.flush(); } catch { /* fine */ }
      this.running = false;
      this.shutdown();
      this.log(`[freeze-named] profiler off after ${this.s.minutes} min (FREEZE_NAMER_MINUTES); restart the bot to run it again`);
    }
  }

  // Read the piece still held (when stopping).
  flush(): void {
    const h = this.held;
    this.held = null;
    if (h) this.readPiece(h);
  }

  // ---- Freezes from the stall finder ---------------------------------------------
  // start / end: performance.now() ms of the last on-time tick and the late
  // tick. cause: the job the stall finder blamed (null = "other"). Cheap.
  noteFreeze(startPerfMs: number, endPerfMs: number, ms: number, cause: string | null): void {
    if (!this.running || !(ms >= this.s.minFreezeMs)) return;
    this.pending.push({
      startUs: startPerfMs * 1_000 + this.perfToUs, endUs: endPerfMs * 1_000 + this.perfToUs, ms,
      cause: cause ?? 'other', coveredUs: 0, steps: new Map(), fns: new Map(), idleUs: 0, seenEnd: false, at: this.now(),
    });
    // Bounded: a flood of freezes can never grow this list without end.
    if (this.pending.length > 2_000) { this.w.dropped += this.pending.length - 2_000; this.pending.splice(0, this.pending.length - 2_000); }
  }

  // Exposed for tests: match one profile piece against the waiting freezes.
  readPiece(p: NamerProfile): void {
    this.pieces++; this.w.pieces++;
    const samples = p.samples ?? [], deltas = p.timeDeltas ?? [];
    const idx = new ProfileIndex(p);
    // A sample stands for the time until the next one, but never more than
    // 3 sampling intervals: a longer gap means the profiler itself was not
    // running (process paused), counted as "not running" instead.
    const capUs = 3 * this.s.intervalUs;
    // Sample times (profiler clock).
    const times = new Float64Array(samples.length);
    let t = p.startTime;
    for (let i = 0; i < samples.length; i++) { t += deltas[i] ?? 0; times[i] = t; }
    for (const f of this.pending) {
      if (f.endUs <= p.startTime || f.startUs >= p.endTime) { if (p.endTime >= f.endUs) f.seenEnd = true; continue; }
      // First sample at or after the freeze start (binary search).
      let lo = 0, hi = samples.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < f.startUs) lo = mid + 1; else hi = mid; }
      for (let i = lo; i < samples.length && times[i] < f.endUs; i++) {
        const next = i + 1 < samples.length ? times[i + 1] : p.endTime;
        const w = Math.max(0, Math.min(next - times[i], capUs, f.endUs - times[i]));
        if (w <= 0) continue;
        f.coveredUs += w;
        const fn = idx.fn(samples[i]);
        if (fn === '(idle)') { f.idleUs += w; continue; }
        add(f.fns, fn, w);
        add(f.steps, idx.step(samples[i]), w);
      }
      if (p.endTime >= f.endUs) f.seenEnd = true;
    }
    // Freezes fully covered are added to the window; the rest wait for the next piece.
    const keep: PendingFreeze[] = [];
    for (const f of this.pending) {
      if (f.seenEnd) this.finish(f);
      else if (f.endUs < p.endTime - 3 * this.s.chunkMs * 1_000) this.w.dropped++;   // too old: never matched
      else keep.push(f);
    }
    this.pending = keep;
  }

  // Add one fully read freeze to the window totals.
  private finish(f: PendingFreeze): void {
    const w = this.w;
    const sampledMs = Math.min(f.ms, f.coveredUs / 1_000);
    w.freezes++; w.frozenMs += f.ms; w.sampledMs += sampledMs; w.idleMs += f.idleUs / 1_000;
    const notRunning = Math.max(0, f.ms - sampledMs);
    w.notRunningMs += notRunning;
    const bump = (m: Map<string, Tot>, k: string, ms: number) => {
      const r = m.get(k) ?? { totalMs: 0, worstMs: 0, n: 0 };
      r.totalMs += ms; r.n++; if (ms > r.worstMs) r.worstMs = ms;
      m.set(k, r);
    };
    // Each freeze adds its steps; "not running" and "idle" are listed as steps
    // too, so the ranking covers the whole freeze time.
    const steps = new Map(f.steps);
    if (f.idleUs > 0) steps.set('(idle: thread waiting, not busy)', f.idleUs);
    if (notRunning >= 1) steps.set('(no sample: process not running, e.g. CPU taken by other programs)', notRunning * 1_000);
    for (const [k, us] of steps) bump(w.steps, k, us / 1_000);
    for (const [k, us] of f.fns) bump(w.fns, k, us / 1_000);
    const c = w.causes.get(f.cause) ?? { n: 0, ms: 0, steps: new Map<string, Tot>() };
    c.n++; c.ms += f.ms;
    for (const [k, us] of steps) bump(c.steps, k, us / 1_000);
    w.causes.set(f.cause, c);
    // The 15 worst freezes, with their own breakdown.
    w.worst.push({ at: new Date(f.at).toISOString(), ms: Math.round(f.ms), cause: f.cause, steps: topOf(f.steps, 5), fns: topOf(f.fns, 5), idleMs: Math.round(f.idleUs / 1_000), notRunningMs: Math.round(notRunning) });
    w.worst.sort((a, b) => b.ms - a.ms);
    if (w.worst.length > 15) w.worst.length = 15;
  }

  // ---- Reports ---------------------------------------------------------------------
  // Summary of the window, then a fresh window starts.
  take(): NamedSummary {
    const w = this.w;
    const out: NamedSummary = {
      freezes: w.freezes, frozenMs: w.frozenMs, sampledMs: w.sampledMs, idleMs: w.idleMs, notRunningMs: w.notRunningMs,
      steps: toRows(w.steps, 40), fns: toRows(w.fns, 40),
      byCause: [...w.causes.entries()].map(([cause, c]) => ({ cause, n: c.n, ms: c.ms, topSteps: toRows(c.steps, 8) })).sort((a, b) => b.ms - a.ms),
      worst: w.worst, pieces: w.pieces, cutMsMax: w.cutMsMax, dropped: w.dropped,
    };
    this.w = this.freshWindow();
    return out;
  }

  // Log line + JSON file for one window. Never throws.
  async report(label = '5 min'): Promise<string | null> {
    if (!this.s.enabled) return null;
    const sum = this.take();
    if (!this.running && !sum.freezes && !sum.pieces) return null;
    const line = formatNamedLine(sum, label);
    this.log(line);
    try {
      await mkdir(this.s.dir, { recursive: true });
      const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
      await writeFile(join(this.s.dir, `freeze-named-${stamp}.json`), JSON.stringify(sum));
      const files = (await readdir(this.s.dir)).filter((f) => f.startsWith('freeze-named-') && f.endsWith('.json')).sort();
      for (const f of files.slice(0, Math.max(0, files.length - this.s.keep))) await unlink(join(this.s.dir, f)).catch(() => undefined);
    } catch { /* best effort */ }
    return line;
  }
}

// Readable ms: 0.4 -> "0.4", 12.6 -> "13".
const fmt = (ms: number) => (ms < 10 ? (Math.round(ms * 10) / 10).toString() : Math.round(ms).toString());

// One plain log line, causes ranked by total freeze ms.
export function formatNamedLine(s: NamedSummary, label = '5 min', top = 6): string {
  if (!s.freezes) return `[freeze-named] ${label}: no freezes named (${s.pieces} profile pieces read, cut max ${fmt(s.cutMsMax)} ms)`;
  const pct = s.frozenMs > 0 ? Math.round((100 * s.sampledMs) / s.frozenMs) : 0;
  const rows = (r: NamedRow[]) => r.slice(0, top).map((x) => `${x.name} ${fmt(x.totalMs)} ms (worst ${fmt(x.worstMs)}, ${x.n}x)`).join('; ');
  const other = s.byCause.find((c) => c.cause === 'other');
  const otherText = other ? ` · in "other" (${other.n}x, ${fmt(other.ms)} ms): ${rows(other.topSteps.slice(0, 4))}` : '';
  return `[freeze-named] ${label}: ${s.freezes} freezes, ${fmt(s.frozenMs)} ms frozen, ${pct}% sampled (idle ${fmt(s.idleMs)} ms, not running ${fmt(s.notRunningMs)} ms) · by step: ${rows(s.steps)} · by function: ${rows(s.fns)}${otherText} · cut max ${fmt(s.cutMsMax)} ms${s.dropped ? ` · ${s.dropped} unmatched` : ''}`;
}
