import { open, rename, mkdir, readFile } from 'fs/promises';
import * as bufferMod from 'buffer';
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

// SLICE CAP (trigger-entry speed, Oct 23): while time-critical work is in
// flight (a feed transaction being checked as a possible trigger), big jobs
// take SHORTER bites, so the answer waiting on the socket is read sooner.
// The cap function returns the longest bite allowed right now in ms (0 or
// less = no cap). Same results, only the timing changes. Set by the host
// (shadowMain.ts: TRIG_ENTRY_YIELD_SLICE_MS while trigger-entry work runs).
let sliceCap: (() => number) | null = null;
export function setSliceCap(fn: (() => number) | null): void { sliceCap = fn; }
export function effectiveSliceMs(ms: number): number {
  try {
    const c = sliceCap?.() ?? 0;
    return c > 0 ? Math.min(ms, c) : ms;
  } catch { return ms; }
}

// Let the rest of the bot run (feed messages, timers, node replies).
export const yieldToLoop = (): Promise<void> => new Promise((res) => setImmediate(res));

// Run the steps in bites of about `sliceMs` ms, with a break after each
// bite. Each bite is timed under `name` for the stall finder.
export async function runSteps<T>(job: Steps<T>, name: string, sliceMs = 5): Promise<T> {
  for (;;) {
    const end = stallFinder.begin(name);
    const t0 = performance.now();
    const bite = effectiveSliceMs(sliceMs);
    let r: IteratorResult<void, T>;
    try {
      do { r = job.next(); } while (!r.done && performance.now() - t0 < bite);
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
    return performance.now() - this.t0 >= effectiveSliceMs(this.sliceMs);
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

// ---------------------------------------------------------------------------
// JSON READ in pieces (freeze fix 2, Oct 24)
//
// Plain English: the saved pool scan (data/robinhood-universe.json, every
// pool on the chain, tens of MB) was read with ONE JSON.parse after a
// synchronous file read: live, "scan file load" froze the bot for ~880 ms
// at every start (and inside the first pool scan). This reads it in ~5 ms
// bites instead: the file is read without blocking, turned into text a
// megabyte at a time, and big lists are parsed a couple of thousand items
// at a time with JSON.parse itself (so text rules, numbers and escapes are
// exactly JSON's). The result is exactly what JSON.parse gives (tested).
//
// Only a top-level object or list, whose values may be big lists of small
// items, is read this way. Anything the reader is not sure about returns
// null, and the caller then uses JSON.parse in one go (the old way), so an
// unusual or broken file behaves exactly as before.
// ---------------------------------------------------------------------------
const WS_CODES = new Set([0x20, 0x09, 0x0a, 0x0d]); // JSON's only whitespace
function skipWs(t: string, i: number): number {
  while (i < t.length && WS_CODES.has(t.charCodeAt(i))) i++;
  return i;
}
// Index of the closing quote of the string that starts at i (t[i] = '"'), or -1.
function stringEnd(t: string, i: number): number {
  let j = i + 1;
  for (;;) {
    const q = t.indexOf('"', j);
    if (q < 0) return -1;
    let bs = 0;
    for (let k = q - 1; k > i && t.charCodeAt(k) === 0x5c; k--) bs++;
    if (bs % 2 === 0) return q;   // not escaped
    j = q + 1;
  }
}
// Index just after the JSON value that starts at i, or -1. Only finds the
// end; JSON.parse checks the value itself afterwards.
function valueEnd(t: string, i: number): number {
  const c = t.charCodeAt(i);
  if (c === 0x22) { const e = stringEnd(t, i); return e < 0 ? -1 : e + 1; }
  if (c === 0x5b || c === 0x7b) {
    let d = 0;
    for (let j = i; j < t.length; j++) {
      const x = t.charCodeAt(j);
      if (x === 0x22) { j = stringEnd(t, j); if (j < 0) return -1; }
      else if (x === 0x5b || x === 0x7b) d++;
      else if (x === 0x5d || x === 0x7d) { d--; if (d === 0) return j + 1; }
    }
    return -1;
  }
  // number / true / false / null: up to the next separator or whitespace
  let j = i;
  while (j < t.length) {
    const x = t.charCodeAt(j);
    if (x === 0x2c || x === 0x5d || x === 0x7d || WS_CODES.has(x)) break;
    j++;
  }
  return j > i ? j : -1;
}
// The list that starts at i (t[i] = '['), parsed a batch of items at a time.
// Returns [list, index after it] or null.
function* arraySteps(t: string, i: number): Generator<void, [unknown[], number] | null, void> {
  const out: unknown[] = [];
  let p = skipWs(t, i + 1);
  if (t.charCodeAt(p) === 0x5d) return [out, p + 1];
  const BATCH = 1_000;
  let from = p, count = 0, last = p;
  const flush = (): boolean => {
    if (!count) return true;
    let part: unknown;
    try { part = JSON.parse('[' + t.slice(from, last) + ']'); } catch { return false; }
    if (!Array.isArray(part) || part.length !== count) return false;
    for (const x of part) out.push(x);
    count = 0;
    return true;
  };
  for (;;) {
    const e = valueEnd(t, p);
    if (e < 0) return null;
    count++; last = e;
    const q = skipWs(t, e);
    const sep = t.charCodeAt(q);
    if (sep === 0x5d) { if (!flush()) return null; return [out, q + 1]; }
    if (sep !== 0x2c) return null;
    if (count >= BATCH) { if (!flush()) return null; from = skipWs(t, q + 1); }
    p = skipWs(t, q + 1);
    if ((count & 127) === 0) yield;
  }
}
// A value at i: a list in batches, anything else with one JSON.parse.
function* valueSteps(t: string, i: number): Generator<void, [unknown, number] | null, void> {
  if (t.charCodeAt(i) === 0x5b) return yield* arraySteps(t, i);
  const e = valueEnd(t, i);
  if (e < 0) return null;
  try { return [JSON.parse(t.slice(i, e)), e]; } catch { return null; }
}
export function* parseJsonSteps(t: string): Generator<void, { value: unknown } | null, void> {
  let i = skipWs(t, 0);
  let value: unknown;
  if (t.charCodeAt(i) === 0x5b) {
    const r = yield* arraySteps(t, i);
    if (!r) return null;
    [value, i] = r;
  } else if (t.charCodeAt(i) === 0x7b) {
    const obj: Record<string, unknown> = {};
    i = skipWs(t, i + 1);
    if (t.charCodeAt(i) === 0x7d) i++;
    else {
      for (;;) {
        if (t.charCodeAt(i) !== 0x22) return null;
        const ke = stringEnd(t, i);
        if (ke < 0) return null;
        let key: unknown;
        try { key = JSON.parse(t.slice(i, ke + 1)); } catch { return null; }
        if (typeof key !== 'string' || key === '__proto__') return null; // never guess on that one
        i = skipWs(t, ke + 1);
        if (t.charCodeAt(i) !== 0x3a) return null;
        const r = yield* valueSteps(t, skipWs(t, i + 1));
        if (!r) return null;
        obj[key] = r[0];  // same as JSON.parse: a repeated key keeps its first place, last value
        i = skipWs(t, r[1]);
        const sep = t.charCodeAt(i);
        if (sep === 0x7d) { i++; break; }
        if (sep !== 0x2c) return null;
        i = skipWs(t, i + 1);
        yield;
      }
    }
    value = obj;
  } else return null;
  if (skipWs(t, i) !== t.length) return null; // anything after the value: let JSON.parse decide
  return { value };
}

// Read a JSON file without freezing the bot (see above). Same answer as
// JSON.parse(readFileSync(file, 'utf8')), including its errors (thrown).
// The odd-file fallback (one JSON.parse) is timed as `name` too.
export async function readJsonChunked(file: string, name = 'json load', sliceMs = 5): Promise<unknown> {
  const buf = await readFile(file);
  // Bytes to text. Plain ASCII (the scan file): one byte = one character, a
  // single native copy (~25 ms for 40 MB on a test machine). Anything else:
  // UTF-8, exactly like readFileSync(file, 'utf8').
  const isAscii = (bufferMod as { isAscii?: (b: Uint8Array) => boolean }).isAscii;
  const text = stallFinder.run(name, () => (typeof isAscii === 'function' && isAscii(buf) ? buf.toString('latin1') : buf.toString('utf8')));
  const r = await runSteps(parseJsonSteps(text), name, sliceMs);
  if (r) return r.value;
  return stallFinder.run(name, () => JSON.parse(text));
}

// ---------------------------------------------------------------------------
// SLICED QUEUE (freeze fix 2, Oct 24): many small jobs, run in order, a few
// ms at a time.
//
// Plain English: some per-transaction side jobs (the rival watch's look at
// every feed transaction, which sometimes has to check a signature, 1-2 ms)
// were each queued with setImmediate. Node runs ALL jobs queued that way in
// one go, so a busy feed message queued 40 of them and they ran back to back:
// "rival watch" freezes up to ~150 ms live. This queue runs the same jobs in
// the same order, but stops after ~sliceMs and lets the rest of the bot run
// (feed messages, node replies) before the next bite. Nothing is dropped.
// ---------------------------------------------------------------------------
export class SlicedQueue {
  private q: Array<() => void> = [];
  private head = 0;
  private scheduled = false;
  constructor(private readonly sliceMs = 5) {}
  // Number of jobs still waiting (tests / reports).
  size(): number { return this.q.length - this.head; }
  push(job: () => void): void {
    this.q.push(job);
    if (!this.scheduled) { this.scheduled = true; setImmediate(() => this.run()); }
  }
  private run(): void {
    this.scheduled = false;
    const t0 = performance.now();
    const bite = effectiveSliceMs(this.sliceMs);
    while (this.head < this.q.length) {
      const job = this.q[this.head];
      this.q[this.head++] = undefined as unknown as () => void; // let it be cleaned up
      try { job(); } catch { /* a job's problem never stops the others */ }
      if (performance.now() - t0 >= bite) break;
    }
    if (this.head >= this.q.length) { this.q = []; this.head = 0; return; }
    // Drop the finished part of the list now and then (not on every job).
    if (this.head > 1_024) { this.q = this.q.slice(this.head); this.head = 0; }
    this.scheduled = true;
    setImmediate(() => this.run());
  }
}
