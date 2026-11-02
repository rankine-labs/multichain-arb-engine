import { Session } from 'inspector';
import { mkdir, readFile, readdir, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { writeJsonChunked } from './chunked';

// ============================================================================
// HEAP SAMPLER ("which lines of code make the most throwaway memory?")
//
// Plain English:
//   The bot makes ~20 MB of short-lived data every second. Cleaning that up
//   (GC) is now most of the remaining freeze time. To cut it we need to know
//   WHICH code makes it. Node has a built-in, low-cost "allocation sampler":
//   roughly every 32 KB of new memory it notes which function asked for it.
//
//   This file runs that sampler ON REQUEST ONLY. Nothing runs until someone
//   creates the file  data/heap-sample.request  on the server (optionally
//   with a number of seconds inside, 10 to 300, default 90). Then it:
//     1. samples allocations for that many seconds (including memory that
//        was already cleaned up again, which is exactly the throwaway data),
//     2. logs one "[heap-sampled]" line with the top places by MB/s,
//     3. saves a summary (data/profiles/heap-<time>.json) and the full
//        profile (heap-<time>.heapprofile, opens in Chrome DevTools > Memory).
//   The request file is deleted when the sample starts (one sample per touch).
//
//   Two views are saved:
//     - "where": the function that asked for the memory (often a Node or
//        ethers helper like Buffer.from or JSON.parse)
//     - "bot":   the nearest function in OUR code (dist/...) above it, so a
//        Buffer.from called from the feed decoder is charged to the decoder.
//
//   Cost: one tiny file check every HEAP_SAMPLER_POLL_S (10 s). While a
//   sample runs the bot is a few % slower. Measurement only: never changes
//   a trade.
//
// Switch: HEAP_SAMPLER=0 turns it off (the file is then ignored).
// Settings: HEAP_SAMPLER_INTERVAL_KB [32] how often it notes (smaller =
// more detail, more cost), HEAP_SAMPLER_KEEP [6] newest samples kept.
// ============================================================================

export type HeapSamplerSettings = {
  enabled: boolean;     // HEAP_SAMPLER [1]
  pollMs: number;       // HEAP_SAMPLER_POLL_S [10] how often the request file is checked
  intervalBytes: number;// HEAP_SAMPLER_INTERVAL_KB [32] average bytes between samples
  defaultSeconds: number;// HEAP_SAMPLER_SECONDS [90] sample length when the file is empty
  keep: number;         // HEAP_SAMPLER_KEEP [6] newest samples kept (json + heapprofile pairs)
  dir: string;          // HEAP_SAMPLER_DIR [data/profiles]
  requestFile: string;  // HEAP_SAMPLER_FILE [data/heap-sample.request]
};

export function heapSamplerSettings(env: Record<string, string | undefined> = process.env): HeapSamplerSettings {
  const num = (k: string, d: number, min: number, max: number) => {
    const raw = env[k];
    const v = Number(raw);
    return raw !== undefined && raw.trim() !== '' && Number.isFinite(v) && v >= min && v <= max ? v : d;
  };
  const sw = (env.HEAP_SAMPLER ?? '1').trim().toLowerCase();
  return {
    enabled: sw !== '0' && sw !== 'off',
    pollMs: num('HEAP_SAMPLER_POLL_S', 10, 1, 600) * 1_000,
    intervalBytes: Math.round(num('HEAP_SAMPLER_INTERVAL_KB', 32, 1, 1_024) * 1_024),
    defaultSeconds: num('HEAP_SAMPLER_SECONDS', 90, 10, 300),
    keep: Math.round(num('HEAP_SAMPLER_KEEP', 6, 1, 100)),
    dir: (env.HEAP_SAMPLER_DIR ?? '').trim() || 'data/profiles',
    requestFile: (env.HEAP_SAMPLER_FILE ?? '').trim() || 'data/heap-sample.request',
  };
}

// The parts of a V8 sampling heap profile we read (HeapProfiler.stopSampling).
export type HeapNode = {
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  selfSize: number;
  id: number;
  children: HeapNode[];
};
export type HeapProfile = { head: HeapNode; samples?: { size: number; nodeId: number; ordinal: number }[] };

export type HeapRow = { name: string; bytes: number; mbPerSec: number; pct: number };
export type HeapSummary = { seconds: number; totalBytes: number; mbPerSec: number; where: HeapRow[]; bot: HeapRow[] };

// "fn (file.js:12)" with only the file's base name (no server paths).
function frameName(cf: HeapNode['callFrame']): string {
  const file = cf.url ? cf.url.split('/').pop() : '';
  const fn = cf.functionName || '(anonymous)';
  return file ? `${fn} (${file}:${cf.lineNumber + 1})` : fn;
}

// Our own code: the compiled bot under dist/ (or the test build).
const isBotFrame = (url: string) => /\/(dist|\.test-build)\//.test(url) && !url.includes('node_modules');

// Add up the profile tree two ways ("where" and "bot", see the header).
export function summarizeHeapProfile(p: HeapProfile, seconds: number, top = 25): HeapSummary {
  const where = new Map<string, number>();
  const bot = new Map<string, number>();
  let total = 0;
  // Walk with an explicit stack (the tree can be deep); carry the nearest
  // bot frame seen on the way down.
  const stack: { n: HeapNode; owner: string }[] = [{ n: p.head, owner: '(no bot frame)' }];
  while (stack.length) {
    const { n, owner } = stack.pop()!;
    const here = isBotFrame(n.callFrame.url) ? frameName(n.callFrame) : owner;
    if (n.selfSize > 0) {
      total += n.selfSize;
      const k = frameName(n.callFrame);
      where.set(k, (where.get(k) ?? 0) + n.selfSize);
      bot.set(here, (bot.get(here) ?? 0) + n.selfSize);
    }
    for (const c of n.children ?? []) stack.push({ n: c, owner: here });
  }
  const secs = Math.max(seconds, 0.001);
  const rows = (m: Map<string, number>): HeapRow[] => [...m.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, top)
    .map(([name, bytes]) => ({ name, bytes, mbPerSec: bytes / 1_048_576 / secs, pct: total ? (100 * bytes) / total : 0 }));
  return { seconds, totalBytes: total, mbPerSec: total / 1_048_576 / secs, where: rows(where), bot: rows(bot) };
}

export function formatHeapLine(s: HeapSummary, file: string | null, n = 10): string {
  const r = (rows: HeapRow[]) => rows.slice(0, n).map((x) => `${x.name} ${x.mbPerSec.toFixed(2)} MB/s ${x.pct.toFixed(0)}%`).join(', ');
  return `[heap-sampled] ${s.seconds} s: ${s.mbPerSec.toFixed(1)} MB/s sampled · by bot code: ${r(s.bot)} · by place: ${r(s.where)}${file ? ` | saved ${file}` : ''}`;
}

// Node's built-in allocation sampler, in this process, for `seconds`.
// The two include* flags keep samples of memory already cleaned up again
// (without them only still-alive memory would show, hiding throwaway data).
export function recordHeapSample(seconds: number, intervalBytes: number): Promise<HeapProfile> {
  return new Promise((resolve, reject) => {
    const session = new Session();
    const post = (method: string, params?: Record<string, unknown>) => new Promise<any>((res, rej) => {
      session.post(method, params ?? {}, (err, result) => (err ? rej(err) : res(result)));
    });
    const done = (fn: () => void) => { try { session.disconnect(); } catch { /* fine */ } fn(); };
    try { session.connect(); } catch (e) { reject(e); return; }
    (async () => {
      await post('HeapProfiler.enable');
      await post('HeapProfiler.startSampling', {
        samplingInterval: intervalBytes,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      await new Promise<void>((r) => setTimeout(r, seconds * 1_000));
      const { profile } = await post('HeapProfiler.stopSampling');
      await post('HeapProfiler.disable').catch(() => undefined);
      return profile as HeapProfile;
    })().then((p) => done(() => resolve(p)), (e) => done(() => reject(e)));
  });
}

export class HeapSampler {
  readonly s: HeapSamplerSettings;
  running = false;
  taken = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  // Tests replace the recorder.
  private readonly record: (seconds: number, intervalBytes: number) => Promise<HeapProfile>;

  constructor(opts: { settings?: HeapSamplerSettings; log?: (m: string) => void; now?: () => number; record?: (s: number, b: number) => Promise<HeapProfile> } = {}) {
    this.s = opts.settings ?? heapSamplerSettings();
    this.log = opts.log ?? ((m) => console.log(m));
    this.now = opts.now ?? Date.now;
    this.record = opts.record ?? recordHeapSample;
  }

  // Start watching for the request file. Returns false when switched off.
  start(): boolean {
    if (!this.s.enabled || this.timer) return false;
    this.timer = setInterval(() => { void this.check(); }, this.s.pollMs);
    this.timer.unref?.();
    return true;
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  // One check of the request file; starts a sample when it is there.
  async check(): Promise<string | null> {
    if (this.running) return null;
    let seconds = this.s.defaultSeconds;
    try {
      await stat(this.s.requestFile);
    } catch { return null; } // no request (the normal case)
    try {
      const v = Number((await readFile(this.s.requestFile, 'utf8')).trim());
      if (Number.isFinite(v) && v >= 10 && v <= 300) seconds = v;
    } catch { /* default length */ }
    await unlink(this.s.requestFile).catch(() => undefined);
    return this.take(seconds);
  }

  // Record one sample, log the top places, save it. Never throws.
  async take(seconds: number): Promise<string | null> {
    if (this.running) return null;
    this.running = true;
    this.log(`[heap-sampled] sampling allocations for ${seconds} s (every ~${Math.round(this.s.intervalBytes / 1024)} KB)`);
    try {
      const prof = await this.record(seconds, this.s.intervalBytes);
      this.taken++;
      const sum = summarizeHeapProfile(prof, seconds, 40);
      let file: string | null = null;
      try {
        await mkdir(this.s.dir, { recursive: true });
        const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
        file = join(this.s.dir, `heap-${stamp}.json`);
        await writeJsonChunked(file, sum, 'heap sample save');
        await writeJsonChunked(join(this.s.dir, `heap-${stamp}.heapprofile`), prof, 'heap sample save');
        await this.prune();
      } catch { file = null; }
      const line = formatHeapLine(sum, file);
      this.log(line);
      return line;
    } catch (e) {
      this.log(`[heap-sampled] could not sample (${(e as Error).message}); measurement only, the bot is unaffected`);
      return null;
    } finally {
      this.running = false;
    }
  }

  // Keep only the newest `keep` samples (names sort by time).
  private async prune(): Promise<void> {
    try {
      const all = await readdir(this.s.dir);
      for (const ext of ['.json', '.heapprofile']) {
        const files = all.filter((f) => f.startsWith('heap-') && f.endsWith(ext)).sort();
        for (const f of files.slice(0, Math.max(0, files.length - this.s.keep))) await unlink(join(this.s.dir, f)).catch(() => undefined);
      }
    } catch { /* best effort */ }
  }
}
