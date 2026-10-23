import { Session } from 'inspector';
import { mkdir, readdir, unlink } from 'fs/promises';
import { basename, join } from 'path';
import { writeJsonChunked } from './chunked';

// ============================================================================
// FREEZE PROFILE ("take a photo of what the bot is doing when it freezes")
//
// Plain English:
//   The stall finder (core/stallFinder.ts) says WHICH named job was running
//   when the bot froze. When the answer is "other" or a big catch-all name
//   ("feed frame"), we still don't know which piece of code inside it is
//   slow, and we can't log in to the server to look.
//
//   This file watches the freezes. When the bot freezes for longer than
//   FREEZE_PROFILE_MS (default 200 ms) at least FREEZE_PROFILE_COUNT times
//   (default 3) within FREEZE_PROFILE_WINDOW_S (default 60 s), it records a
//   short CPU profile with Node's own built-in profiler: for
//   FREEZE_PROFILE_SECONDS (default 5 s) it notes ~1,000 times a second
//   which function is running. Then it:
//     - writes one plain log line with the 10 functions that used the most
//       time themselves ("self time"), e.g.
//         [freeze-profile] 5.0 s profile after 3 freezes over 200 ms (worst
//         630 ms): top self time: keccak (sha3.js:120) 820 ms 16%, ...
//     - saves the full profile as data/profiles/cpu-<time>.cpuprofile
//       (opens in Chrome DevTools > Performance, or speedscope.app), and
//       keeps only the newest FREEZE_PROFILE_KEEP (default 5) files.
//
//   At most once every FREEZE_PROFILE_EVERY_MIN minutes (default 30).
//   Cost when nothing is wrong: nothing but a counter per freeze (no timer,
//   no profiler running). While a profile runs the bot is a few % slower
//   for those seconds. Measurement only: it never changes a trade.
//
// Switch: FREEZE_PROFILE=0 turns it off. On by default.
// ============================================================================

export type FreezeProfileSettings = {
  enabled: boolean;      // FREEZE_PROFILE [1]
  freezeMs: number;      // FREEZE_PROFILE_MS [200] a freeze at least this long counts
  count: number;         // FREEZE_PROFILE_COUNT [3] this many counted freezes ...
  windowMs: number;      // FREEZE_PROFILE_WINDOW_S [60] ... within this long start a profile
  seconds: number;       // FREEZE_PROFILE_SECONDS [5] how long one profile records
  everyMs: number;       // FREEZE_PROFILE_EVERY_MIN [30] at most one profile this often
  keep: number;          // FREEZE_PROFILE_KEEP [5] newest profile files kept
  dir: string;           // FREEZE_PROFILE_DIR [data/profiles]
  intervalUs: number;    // FREEZE_PROFILE_INTERVAL_US [1000] how often the profiler looks (microseconds)
};

export function freezeProfileSettings(env: Record<string, string | undefined> = process.env): FreezeProfileSettings {
  const num = (k: string, d: number, min: number, max: number) => {
    const raw = env[k];
    const v = Number(raw);
    return raw !== undefined && raw.trim() !== '' && Number.isFinite(v) && v >= min && v <= max ? v : d;
  };
  return {
    enabled: (env.FREEZE_PROFILE ?? '1').trim() !== '0' && (env.FREEZE_PROFILE ?? '').trim().toLowerCase() !== 'off',
    freezeMs: num('FREEZE_PROFILE_MS', 200, 50, 60_000),
    count: Math.round(num('FREEZE_PROFILE_COUNT', 3, 1, 1_000)),
    windowMs: num('FREEZE_PROFILE_WINDOW_S', 60, 1, 3_600) * 1_000,
    seconds: num('FREEZE_PROFILE_SECONDS', 5, 1, 30),
    everyMs: num('FREEZE_PROFILE_EVERY_MIN', 30, 1, 24 * 60) * 60_000,
    keep: Math.round(num('FREEZE_PROFILE_KEEP', 5, 1, 50)),
    dir: (env.FREEZE_PROFILE_DIR ?? '').trim() || 'data/profiles',
    intervalUs: Math.round(num('FREEZE_PROFILE_INTERVAL_US', 1_000, 100, 100_000)),
  };
}

// The parts of a V8 CPU profile we read (inspector Profiler.stop result).
export type CpuProfile = {
  nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number }>;
  startTime: number;   // microseconds
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
};

export type SelfTime = { name: string; ms: number; pct: number };

// Self time per function (ms), biggest first. Pure, so it can be tested.
// Each sample's time is the gap to the NEXT sample (V8's timeDeltas); the
// last sample gets the average gap. Functions are grouped by name + file +
// line, so the same function reached by different callers adds up.
// "(idle)" (the bot was waiting, not busy) is left out of the list but
// still counts in the total, so the % are of the whole recording.
export function topSelfTime(p: CpuProfile, n = 10): { list: SelfTime[]; totalMs: number } {
  const byId = new Map<number, CpuProfile['nodes'][number]>();
  for (const node of p.nodes ?? []) byId.set(node.id, node);
  const selfUs = new Map<number, number>();
  const samples = p.samples ?? [];
  const deltas = p.timeDeltas ?? [];
  const totalUs = Math.max(0, (p.endTime ?? 0) - (p.startTime ?? 0));
  if (samples.length && deltas.length === samples.length) {
    const avg = samples.length ? totalUs / samples.length : 0;
    for (let i = 0; i < samples.length; i++) {
      const d = i + 1 < deltas.length ? deltas[i + 1] : avg;
      selfUs.set(samples[i], (selfUs.get(samples[i]) ?? 0) + Math.max(0, d));
    }
  } else {
    // No per-sample times: use hit counts x the average gap.
    let hits = 0;
    for (const node of byId.values()) hits += node.hitCount ?? 0;
    const per = hits ? totalUs / hits : 0;
    for (const node of byId.values()) if (node.hitCount) selfUs.set(node.id, node.hitCount * per);
  }
  const grouped = new Map<string, number>();
  for (const [id, us] of selfUs) {
    const node = byId.get(id);
    if (!node) continue;
    const name = labelOf(node.callFrame);
    if (name === '(idle)') continue;
    grouped.set(name, (grouped.get(name) ?? 0) + us);
  }
  const totalMs = totalUs / 1_000;
  const list = [...grouped.entries()]
    .map(([name, us]) => ({ name, ms: us / 1_000, pct: totalUs > 0 ? (100 * us) / totalUs : 0 }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, n);
  return { list, totalMs };
}

// "functionName (file.js:123)"; V8 lines start at 0, people count from 1.
function labelOf(cf: { functionName: string; url: string; lineNumber: number }): string {
  const fn = cf.functionName || '(anonymous)';
  if (fn.startsWith('(') && !cf.url) return fn; // (garbage collector), (program), (idle), (root)
  const file = cf.url ? basename(cf.url.replace(/^file:\/\//, '')) : '';
  return file ? `${fn} (${file}:${(cf.lineNumber ?? 0) + 1})` : fn;
}

// One plain line for the log.
export function formatProfileLine(top: { list: SelfTime[]; totalMs: number }, why: string, file: string | null): string {
  const r = (x: number) => (x >= 10 ? Math.round(x).toString() : (Math.round(x * 10) / 10).toString());
  const fns = top.list.map((f) => `${f.name} ${r(f.ms)} ms ${Math.round(f.pct)}%`).join(', ');
  return `[freeze-profile] ${(top.totalMs / 1_000).toFixed(1)} s profile ${why}: top self time: ${fns || 'nothing recorded'}${file ? ` | saved ${file}` : ' | not saved'}`;
}

export class FreezeProfiler {
  readonly s: FreezeProfileSettings;
  private recent: number[] = [];      // times of recent counted freezes (bounded by `count`)
  private worst = 0;                  // worst counted freeze since the last profile
  private lastAt = -Infinity;         // when the last profile started
  private running = false;
  taken = 0;                          // profiles taken since start (status / tests)
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  // Tests replace the recorder (the real one uses Node's inspector).
  private readonly record: (seconds: number, intervalUs: number) => Promise<CpuProfile>;

  constructor(opts: { settings?: FreezeProfileSettings; now?: () => number; log?: (m: string) => void; record?: (seconds: number, intervalUs: number) => Promise<CpuProfile> } = {}) {
    this.s = opts.settings ?? freezeProfileSettings();
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(m));
    this.record = opts.record ?? recordCpuProfile;
  }

  // Called for every freeze the stall finder sees (ms = how long). Cheap.
  // Returns true when this freeze started a profile.
  noteFreeze(ms: number): boolean {
    if (!this.s.enabled || !(ms >= this.s.freezeMs)) return false;
    const t = this.now();
    this.recent.push(t);
    if (this.recent.length > this.s.count) this.recent.splice(0, this.recent.length - this.s.count);
    if (ms > this.worst) this.worst = ms;
    if (this.running || t - this.lastAt < this.s.everyMs) return false;
    if (this.recent.length < this.s.count || t - this.recent[0] > this.s.windowMs) return false;
    const why = `after ${this.recent.length} freezes over ${this.s.freezeMs} ms within ${Math.round((t - this.recent[0]) / 1_000)} s (worst ${Math.round(this.worst)} ms)`;
    this.lastAt = t;
    this.recent = [];
    this.worst = 0;
    void this.take(why);
    return true;
  }

  // Record one profile now, log its top functions, save it. Never throws.
  async take(why: string): Promise<string | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const prof = await this.record(this.s.seconds, this.s.intervalUs);
      this.taken++;
      const top = topSelfTime(prof, 10);
      let file: string | null = null;
      try {
        await mkdir(this.s.dir, { recursive: true });
        const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
        file = join(this.s.dir, `cpu-${stamp}.cpuprofile`);
        // Written in small pieces (a profile can be a few MB of text).
        await writeJsonChunked(file, prof, 'freeze profile save');
        await this.prune();
      } catch { file = null; }
      const line = formatProfileLine(top, why, file);
      this.log(line);
      return line;
    } catch (e) {
      this.log(`[freeze-profile] could not record a profile (${(e as Error).message}); measurement only, the bot is unaffected`);
      return null;
    } finally {
      this.running = false;
    }
  }

  // Keep only the newest `keep` profile files (names sort by time).
  private async prune(): Promise<void> {
    try {
      const files = (await readdir(this.s.dir)).filter((f) => f.startsWith('cpu-') && f.endsWith('.cpuprofile')).sort();
      for (const f of files.slice(0, Math.max(0, files.length - this.s.keep))) await unlink(join(this.s.dir, f)).catch(() => undefined);
    } catch { /* best effort */ }
  }
}

// Node's built-in profiler, in this process, for `seconds`. The inspector
// session is opened only for the recording and closed after.
export function recordCpuProfile(seconds: number, intervalUs: number): Promise<CpuProfile> {
  return new Promise((resolve, reject) => {
    const session = new Session();
    const post = (method: string, params?: Record<string, unknown>) => new Promise<any>((res, rej) => {
      session.post(method, params ?? {}, (err, result) => (err ? rej(err) : res(result)));
    });
    const done = (fn: () => void) => { try { session.disconnect(); } catch { /* fine */ } fn(); };
    try {
      session.connect();
    } catch (e) { reject(e); return; }
    (async () => {
      await post('Profiler.enable');
      await post('Profiler.setSamplingInterval', { interval: intervalUs });
      await post('Profiler.start');
      await new Promise<void>((r) => setTimeout(r, seconds * 1_000));
      const { profile } = await post('Profiler.stop');
      await post('Profiler.disable').catch(() => undefined);
      return profile as CpuProfile;
    })().then((p) => done(() => resolve(p)), (e) => done(() => reject(e)));
  });
}
