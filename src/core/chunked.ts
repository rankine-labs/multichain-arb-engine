import { open, rename, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { stallFinder } from './stallFinder';

// ============================================================================
// CHUNKED WORK ("do big jobs in small bites")
//
// Plain English:
//   A big job done in one go freezes the bot (it runs on one thread), and
//   any trade arriving meanwhile has to wait. These helpers split a big job
//   into bites of about 5 ms and let the rest of the bot (feed messages,
//   timers, node replies) run between bites. The RESULT is exactly the same
//   as doing it in one go; only the timing changes.
//
//   How a job is written: as a "step function" (a generator) that says
//   `yield` now and then at a safe point. Then:
//     drainSteps(job)       runs it all at once (the old behaviour)
//     runSteps(job, name)   runs it in ~5 ms bites with breaks in between
//   Both give the same answer, because they run the very same code.
//
//   writeJsonChunked() saves a big object as JSON in pieces (same bytes as
//   JSON.stringify), to a temp file that is then renamed over the real one,
//   so the file on disk is never half written.
// ============================================================================

// A job written as steps: `yield` marks a safe place to take a break.
export type Steps<T> = Generator<void, T, void>;

// Run all steps at once and return the result (no breaks).
export function drainSteps<T>(job: Steps<T>): T {
  for (;;) {
    const r = job.next();
    if (r.done) return r.value;
  }
}

// Let the rest of the bot run (feed messages, timers, node replies).
export const yieldToLoop = (): Promise<void> => new Promise((res) => setImmediate(res));

// Run the steps in bites of about `sliceMs` ms, with a break after each
// bite. Each bite is timed under `name` for the stall finder.
export async function runSteps<T>(job: Steps<T>, name: string, sliceMs = 5): Promise<T> {
  for (;;) {
    const end = stallFinder.begin(name);
    const t0 = performance.now();
    let r: IteratorResult<void, T>;
    try {
      do { r = job.next(); } while (!r.done && performance.now() - t0 < sliceMs);
    } finally { end(); }
    if (r.done) return r.value;
    await yieldToLoop();
  }
}

// For async jobs with long plain loops (not written as steps): call
// `if (pacer.due()) await pacer.rest();` inside the loop. due() is true once
// about `sliceMs` of work has run since the last break (it only looks at the
// clock every 256 calls, so it costs almost nothing). rest() lets the rest of
// the bot run, then names the next stretch `name` for the stall finder.
// enabled = false: never takes a break (the old behaviour). Same result
// either way; only the timing changes.
//
// Oct 15 fix (naming only): rest() used to name the next stretch with
// stallFinder.mark(), but that name ended BEFORE the caller's code after
// `await rest()` even started (a quirk of how async code takes turns), so
// the work between breaks, and any long step after the last break, was
// never named and showed up as "other (during ...)". Now the name covers
// the caller's code until its next break, or until it next waits on
// something (e.g. a node read) or finishes.
export class Pacer {
  private t0 = performance.now();
  private calls = 0;
  private endStretch: (() => void) | null = null;
  constructor(private readonly name: string, private readonly sliceMs = 5, private readonly enabled = true) {}
  due(): boolean {
    if (!this.enabled || (++this.calls & 255) !== 0) return false;
    return performance.now() - this.t0 >= this.sliceMs;
  }
  async rest(): Promise<void> {
    // The named stretch before this break ends here.
    if (this.endStretch) { this.endStretch(); this.endStretch = null; }
    await yieldToLoop();
    this.t0 = performance.now();
    const end = stallFinder.begin(this.name);
    this.endStretch = end;
    // End the name after the caller's next piece of code has run: the
    // caller's code after `await rest()` is queued right after this
    // function returns, so ending two turns later lets it run first.
    // (Ending twice is harmless: the next rest() may end it sooner.)
    queueMicrotask(() => queueMicrotask(end));
  }
}

// ---------------------------------------------------------------------------
// JSON in pieces
// ---------------------------------------------------------------------------
const BIG_ARRAY = 1_000;   // arrays longer than this are written a chunk at a time
const CHUNK_ITEMS = 2_000; // items per chunk

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as any).toJSON !== 'function'
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

// The JSON text of `value`, handed out piece by piece. Joined together the
// pieces are exactly JSON.stringify(value). Big arrays (at the top level or
// one level down inside a plain object) are cut into chunks; everything
// else is stringified whole. Each array's length is noted when its turn
// comes, so items added while writing are left for the next save.
export function* jsonPieces(value: unknown, depth = 0): Generator<string, void, void> {
  if (Array.isArray(value) && value.length > BIG_ARRAY) {
    const n = value.length;
    yield '[';
    for (let i = 0; i < n; i += CHUNK_ITEMS) {
      const parts: string[] = [];
      for (let j = i; j < Math.min(n, i + CHUNK_ITEMS); j++) parts.push(JSON.stringify(value[j]) ?? 'null');
      yield (i > 0 ? ',' : '') + parts.join(',');
    }
    yield ']';
    return;
  }
  if (depth < 2 && isPlainObject(value)) {
    yield '{';
    let first = true;
    for (const k of Object.keys(value)) {
      const v = value[k];
      // Same rules as JSON.stringify: these keys are left out of objects.
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue;
      const head = (first ? '' : ',') + JSON.stringify(k) + ':';
      first = false;
      if ((Array.isArray(v) && v.length > BIG_ARRAY) || isPlainObject(v)) { yield head; yield* jsonPieces(v, depth + 1); }
      else yield head + JSON.stringify(v);
    }
    yield '}';
    return;
  }
  yield JSON.stringify(value) ?? 'null';
}

// Write `value` as JSON to `file`, a piece at a time, without freezing the
// bot: text is built in ~5 ms bites and written with async file writes.
// Atomic: written to file.tmp, then renamed over the real file.
// Throws on a disk problem (the caller decides what to do).
export async function writeJsonChunked(file: string, value: unknown, name = 'json save', sliceMs = 5): Promise<void> {
  return writeTextChunked(file, jsonPieces(value), name, sliceMs);
}

// Write text handed out piece by piece (any generator of strings) to `file`
// the same careful way: built in ~5 ms bites, async writes, temp file then
// rename. The file holds exactly the pieces joined together.
export async function writeTextChunked(file: string, pieces: Iterator<string, unknown, void>, name = 'file save', sliceMs = 5): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const fh = await open(tmp, 'w');
  try {
    let done = false;
    while (!done) {
      // One bite: build up to ~1 MB of text or ~sliceMs of work.
      const end = stallFinder.begin(name);
      const t0 = performance.now();
      const buf: string[] = [];
      let size = 0;
      try {
        for (;;) {
          const r = pieces.next();
          if (r.done) { done = true; break; }
          const piece = r.value as string;
          buf.push(piece); size += piece.length;
          if (size > 1_000_000 || performance.now() - t0 > sliceMs) break;
        }
      } finally { end(); }
      if (buf.length) await fh.write(buf.join(''));
      else await yieldToLoop();
    }
  } finally { await fh.close(); }
  await rename(tmp, file);
}

// One save at a time per file: a second save asked for while one is
// running waits for it (so two saves never write the same temp file).
const saving = new Map<string, Promise<unknown>>();
export function writeJsonChunkedQueued(file: string, value: unknown, name = 'json save'): Promise<void> {
  const prev = saving.get(file) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => writeJsonChunked(file, value, name));
  saving.set(file, next);
  const clear = () => { if (saving.get(file) === next) saving.delete(file); };
  next.then(clear, clear);
  return next;
}
