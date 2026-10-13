import * as v8 from 'v8';
import { mkdirSync } from 'fs';
import { join } from 'path';

// ============================================================================
// MEMORY REPORT (measurement only - changes nothing about trading)
//
// The bot runs at about 1 GB of memory. To find out WHAT is using it, this
// prints one line every few minutes:
//
//   [mem] rss 987 MB · heap used 240 / total 610 / limit 4144 MB · external 35 MB
//         · buffers 12 MB · peak rss 1010 MB, peak heap used 260 MB
//         · sizes: opportunities 1200, rival trades 800, pools 4000, ...
//
// What the numbers mean, in plain words:
//   rss        = all memory the operating system gives the process (what pm2 shows)
//   heap used  = memory taken by our actual data (lists, maps, records)
//   heap total = memory Node has reserved for data (used + free space it keeps)
//   heap limit = the most data memory Node will allow before it crashes
//   external / buffers = memory outside the heap (network buffers etc.)
//   sizes      = how many items the big lists in the bot hold right now
//
// Settings (.env):
//   MEM_LOG=0        turns this off completely (on by default; it's only a log line)
//   MEM_LOG_MIN=5    minutes between lines (default 5)
//   MEM_SNAPSHOT=1   on `pm2 sendSignal SIGUSR2 dex-arb-shadow`, also save a full
//                    heap snapshot into data/ (off by default; it pauses the bot
//                    for a few seconds and the file can be hundreds of MB).
//                    Note: SIGUSR2 also still sends the hourly report.
// ============================================================================

const MB = 1024 * 1024; // "MB" here = MiB, same unit pm2 uses

// ---- Size registry: other parts of the bot tell us how to count their lists ----

// name -> function returning how many items that list holds right now
const sizeGetters = new Map<string, () => number>();

// Register a list to be counted in the [mem] line. Example:
//   registerSize('pools', () => cache.size());
// Registering the same name again replaces the old one.
export function registerSize(name: string, getter: () => number): void {
  sizeGetters.set(name, getter);
}

// Forget all registered lists (used by the tests).
export function clearSizes(): void {
  sizeGetters.clear();
}

// Read every registered size. A getter that throws (or returns junk) shows
// as "?" instead of breaking the whole line.
export function readSizes(): string {
  const parts: string[] = [];
  for (const [name, getter] of sizeGetters) {
    let text = '?';
    try {
      const n = getter();
      if (typeof n === 'number' && Number.isFinite(n)) text = String(Math.round(n));
    } catch { /* leave as "?" */ }
    parts.push(`${name} ${text}`);
  }
  return parts.join(', ');
}

// ---- The reporter: takes readings, remembers peaks, builds the text lines ----

// The raw readings we need (a subset of process.memoryUsage()).
export interface MemReading {
  rss: number; heapUsed: number; heapTotal: number; external: number; arrayBuffers: number;
}

export class MemReporter {
  peakRss = 0;      // highest rss seen since start (bytes)
  peakHeapUsed = 0; // highest heap used seen since start (bytes)

  constructor(
    // Where readings come from. Defaults are the real Node numbers; the
    // tests pass fake ones.
    private readonly read: () => MemReading = () => process.memoryUsage(),
    private readonly heapLimit: () => number = () => v8.getHeapStatistics().heap_size_limit,
  ) {}

  // Take one reading and update the peaks. Called every minute (so peaks
  // between log lines are not missed) and whenever a line is built.
  sample(): MemReading {
    const m = this.read();
    if (m.rss > this.peakRss) this.peakRss = m.rss;
    if (m.heapUsed > this.peakHeapUsed) this.peakHeapUsed = m.heapUsed;
    return m;
  }

  // The full [mem] log line.
  line(): string {
    const m = this.sample();
    const sizes = readSizes();
    return `[mem] rss ${mb(m.rss)} MB · heap used ${mb(m.heapUsed)} / total ${mb(m.heapTotal)} / limit ${mb(this.heapLimit())} MB`
      + ` · external ${mb(m.external)} MB · buffers ${mb(m.arrayBuffers)} MB`
      + ` · peak rss ${mb(this.peakRss)} MB, peak heap used ${mb(this.peakHeapUsed)} MB`
      + (sizes ? ` · sizes: ${sizes}` : '');
  }

  // One short line for the hourly Telegram report.
  hourLine(): string {
    const m = this.sample();
    return `Memory: rss ${mb(m.rss)} MB (peak ${mb(this.peakRss)}), real data (heap used) ${mb(m.heapUsed)} MB, heap limit ${mb(this.heapLimit())} MB`;
  }
}

// Bytes -> whole MB.
function mb(bytes: number): number {
  return Math.round(bytes / MB);
}

// ---- Settings ----

// Minutes between [mem] lines, or 0 when MEM_LOG=0 (off).
export function memLogMinutes(env: NodeJS.ProcessEnv = process.env): number {
  if (env.MEM_LOG === '0') return 0;
  const n = Number(env.MEM_LOG_MIN);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

// ---- Start it up (called once from shadowMain) ----

// Starts the timers and returns the reporter, or null when MEM_LOG=0.
// Timers are "unref'd" so they never keep the process alive on their own.
export function startMemReport(env: NodeJS.ProcessEnv = process.env, log: (s: string) => void = console.log): MemReporter | null {
  const minutes = memLogMinutes(env);
  if (minutes === 0) return null;
  const rep = new MemReporter();
  const safeLog = () => { try { log(rep.line()); } catch (err) { console.warn('[mem] report failed (ignored):', (err as Error).message); } };
  setInterval(() => { try { rep.sample(); } catch { /* ignore */ } }, 60_000).unref();
  setInterval(safeLog, minutes * 60_000).unref();
  // Heap snapshot on demand (only if MEM_SNAPSHOT=1). This is an EXTRA
  // listener: the existing SIGUSR2 "send report now" handler keeps working.
  if (env.MEM_SNAPSHOT === '1') {
    process.on('SIGUSR2', () => { writeSnapshot(log); });
  }
  log(`[mem] memory line on: every ${minutes} min${env.MEM_SNAPSHOT === '1' ? ', heap snapshot on SIGUSR2' : ''}`);
  return rep;
}

// Save a heap snapshot into data/ and log where it went. Returns the path,
// or null if it failed (a failure never stops the bot).
export function writeSnapshot(log: (s: string) => void = console.log, dir = 'data'): string | null {
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = v8.writeHeapSnapshot(join(dir, `heap-${stamp}.heapsnapshot`));
    log(`[mem] heap snapshot saved: ${path}`);
    return path;
  } catch (err) {
    log(`[mem] heap snapshot failed (ignored): ${(err as Error).message}`);
    return null;
  }
}
