import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'fs';
import { dirname } from 'path';

// ============================================================================
// FAST LANE BRIDGE (Node side): the two small files shared with the Rust
// fast lane (sim/src/fastlane/bridge.rs reads / writes the other ends).
//
// Plain English:
//   The Rust fast lane sends standing-gap trades the moment a block arrives.
//   It uses the SAME wallet as this bot (the trade contract allows one), so
//   only one of the two sends at a time (RUST_SENDER, see fastSender.ts).
//   Rust can't see this bot's memory, so:
//
//   1. STATE WRITER -> data/fastlane-state.json, every 2 s (FASTLANE_STATE_MS)
//      What Rust's safety checks need from us: money lost today (and gas held
//      for trades still waiting for a receipt), limits, allowed coins,
//      auto-vetted coins, blocked pool pairs with their expiry, pools cleared
//      for live trading, scoreboard pauses, loop loss so far, live readiness,
//      approved loan pools, own money held, kill switch. Written to a temp
//      file and renamed, so Rust never reads half a file. If we stop writing
//      for 10 s, Rust stops sending (fails closed).
//
//   2. SENDS FOLLOWER <- data/fastlane-sends.jsonl, looked at every 250 ms
//      Rust writes one line per send (live) or "would send" (practice).
//        live, with a hash  -> tracked EXACTLY like our own sends (receipt,
//                              gas, daily loss cap, pair blocks, Telegram,
//                              data/live-trades.jsonl with "src":"rust")
//        live, with error   -> "send failed" like our own refused sends
//        practice           -> only counted: an hourly line with the
//                              would-send count and timings p50 / p90
//      Where we got to is tracked by FILE IDENTITY (inode) + BYTE OFFSET of
//      the last complete line, never by time (many records can share one
//      millisecond, and times can go backwards). It is saved
//      (data/fastlane-follow.json), so a restart neither misses nor
//      double-counts a send. The file is rotated by Rust (renamed to .1):
//      the rest of the old file is read before the new one, also after a
//      restart (the saved inode is looked for in the .1 file). Backstop:
//      records already handled are remembered by seq and tx hash (bounded),
//      and when we can't tell where we were (both files replaced while we
//      were down) only records with seq above our ackSeq are taken.
//      ackSeq (the highest seq handled) goes back to Rust in the state file:
//      Rust holds each of its sends' gas against the loss caps until our
//      ackSeq covers it.
//
//   3. COUNTERS for the Rust sender (state file): dropsSeen (tracked Rust
//      sends found dropped / never mined; the gun re-reads its nonce when
//      it goes up) and maxGasUsed (most gas any Rust send used).
//
//   Both only run when FASTLANE is practice or live. Default off = nothing
//   new runs, nothing is written. Never throws into trading code.
// ============================================================================

export type FastlaneMode = 'off' | 'practice' | 'live';

// FASTLANE=off|practice|live (default off; unknown = off). Same rule as
// sim/src/fastlane/mode.rs parse_mode.
export function fastlaneModeFromEnv(env: Record<string, string | undefined> = process.env): FastlaneMode {
  const v = (env.FASTLANE ?? '').trim().toLowerCase();
  if (v === 'practice' || v === 'shadow' || v === 'dry') return 'practice';
  if (v === 'live') return 'live';
  return 'off';
}

// ---------------------------------------------------------------------------
// 1. State file
// ---------------------------------------------------------------------------

// [buyPool, sellPool, until (ms), why]
export type PairBlockRow = [string, string, number, string];

export interface FastlaneState {
  v: 1;
  writtenMs: number;
  lossDay: string;          // UTC day of lossUsd (the daily cap's day)
  lossUsd: number;          // lost today (receipts so far)
  pendingUsd: number;       // gas held for trades waiting for a receipt
  limits: {
    maxTradeUsd: number; dailyLossCapUsd: number; maxSendsPerMin: number; minNetUsd: number;
    autoVetMaxTradeUsd: number; loopMaxTradeUsd: number; loopLossCapUsd: number;
  };
  problems: string[];
  allowlist: string[];
  autoVetted: string[];
  liveBlocks: PairBlockRow[];
  failBlocks: PairBlockRow[];
  livePools: string[];
  paused: { gap: string | null; loop: string | null };
  loopLossUsd: number;
  loopPaused: boolean;
  liveReady: boolean;
  liveProblems: string[];
  approvedLenders: string[];
  ownMoney: { readMs: number; balances: Record<string, string> };
  killed: boolean;
  ackSeq: number;           // highest Rust send record seq we have handled
  rustSender: boolean;      // OUR RUST_SENDER: Rust broadcasts only if this is true too
  dropsSeen: number;        // tracked Rust sends found dropped / never mined (since start)
  maxGasUsed: number;       // most gas units any Rust send used (0 = none yet)
}

// Everything the writer reads from the bot (closures set up in shadowMain).
export interface StateSources {
  now: () => number;
  lossTodayUsd: () => number;
  lossWithPendingUsd: () => number;
  limits: () => FastlaneState['limits'];
  problems: () => string[];
  allowlist: () => string[];
  autoVetted: () => string[];
  liveBlocks: () => PairBlockRow[];
  failBlocks: () => PairBlockRow[];
  livePools: () => string[];
  paused: () => FastlaneState['paused'];
  loopLossUsd: () => number;
  loopPaused: () => boolean;
  liveReady: () => boolean;
  liveProblems: () => string[];
  approvedLenders: () => string[];
  ownMoney: () => { readMs: number; balances: Record<string, bigint> };
  killed: () => boolean;
  ackSeq: () => number;
  rustSender: () => boolean;
  dropsSeen: () => number;
  maxGasUsed: () => number;
}

const lowerAll = (xs: string[]) => [...new Set(xs.map((x) => String(x).toLowerCase()))];
const finite = (n: number) => (Number.isFinite(n) ? n : 0);
// A source that throws must not stop the file: the SAFE value is used instead
// (e.g. an empty allowlist = Rust may trade nothing).
const safe = <T>(f: () => T, dflt: T): T => { try { return f(); } catch { return dflt; } };

// Pure: one snapshot of the state (exported for tests).
export function buildFastlaneState(s: StateSources): FastlaneState {
  const now = s.now();
  // Loss figures: a source error must BLOCK (a huge loss + a problem line),
  // never read as "nothing lost".
  const lossRaw = safe(s.lossTodayUsd, NaN);
  const pendRaw = safe(s.lossWithPendingUsd, NaN);
  const lossOk = Number.isFinite(lossRaw) && Number.isFinite(pendRaw);
  const loss = lossOk ? Math.max(0, lossRaw) : 1e9;
  const withPending = lossOk ? Math.max(loss, pendRaw) : 1e9;
  const own = safe(s.ownMoney, { readMs: 0, balances: {} as Record<string, bigint> });
  const problems = safe(s.problems, ['state source error']);
  // Loop loss: an error / junk must BLOCK loops (huge figure + paused), never
  // read as "no loop loss today" (fail closed).
  const loopRaw = safe(s.loopLossUsd, NaN);
  const loopOk = Number.isFinite(loopRaw);
  return {
    v: 1,
    writtenMs: now,
    lossDay: new Date(now).toISOString().slice(0, 10),
    lossUsd: loss,
    pendingUsd: withPending - loss,
    limits: safe(s.limits, { maxTradeUsd: 0, dailyLossCapUsd: 0, maxSendsPerMin: 0, minNetUsd: 0, autoVetMaxTradeUsd: 0, loopMaxTradeUsd: 0, loopLossCapUsd: 0 }),
    problems: [...problems, ...(lossOk ? [] : ['loss figure unreadable'])],
    allowlist: lowerAll(safe(s.allowlist, [])),
    autoVetted: lowerAll(safe(s.autoVetted, [])),
    liveBlocks: safe(s.liveBlocks, []),
    failBlocks: safe(s.failBlocks, []),
    livePools: lowerAll(safe(s.livePools, [])),
    paused: safe(s.paused, { gap: 'state source error', loop: 'state source error' }),
    loopLossUsd: loopOk ? Math.max(0, loopRaw) : 1e9,
    loopPaused: !loopOk || safe(s.loopPaused, true),
    liveReady: safe(s.liveReady, false),
    liveProblems: safe(s.liveProblems, []),
    approvedLenders: lowerAll(safe(s.approvedLenders, [])),
    ownMoney: { readMs: own.readMs, balances: Object.fromEntries(Object.entries(own.balances).map(([k, v]) => [k.toLowerCase(), v.toString()])) },
    killed: safe(s.killed, true),
    ackSeq: finite(safe(s.ackSeq, 0)),
    // Not sure = false: Rust then refuses to broadcast.
    rustSender: safe(s.rustSender, false) === true,
    dropsSeen: finite(safe(s.dropsSeen, 0)),
    maxGasUsed: finite(safe(s.maxGasUsed, 0)),
  };
}

// Pair-block entries ("a>b" -> until/why) as rows (LiveRouteBlock.entries()).
export function pairRows(entries: Iterable<[string, { until: number; why: string }]>, now: number): PairBlockRow[] {
  const out: PairBlockRow[] = [];
  for (const [k, b] of entries) {
    if (!(b.until > now)) continue;
    const i = k.indexOf('>');
    if (i > 0) out.push([k.slice(0, i), k.slice(i + 1), b.until, String(b.why).slice(0, 80)]);
  }
  return out;
}

export class FastlaneStateWriter {
  private timer: NodeJS.Timeout | null = null;
  writes = 0;
  failures = 0;
  constructor(readonly file: string, private readonly src: StateSources, private readonly log: (m: string) => void = () => {}) {}

  // Write once now (temp file + rename). Never throws.
  writeNow(): boolean {
    try {
      const st = buildFastlaneState(this.src);
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file + '.tmp', JSON.stringify(st));
      renameSync(this.file + '.tmp', this.file);
      this.writes++;
      return true;
    } catch (e) {
      // Rust blocks every send after 10 s without a fresh file (fail closed).
      if (this.failures++ % 30 === 0) this.log(`[fastlane] could not write the state file: ${(e as Error).message}`);
      return false;
    }
  }

  start(everyMs = 2_000) {
    this.writeNow();
    this.timer = setInterval(() => this.writeNow(), Math.max(250, everyMs));
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

// ---------------------------------------------------------------------------
// 2. Sends follower
// ---------------------------------------------------------------------------

// One line of data/fastlane-sends.jsonl (sim/src/fastlane/bridge.rs SendRecord).
export interface RustSendRecord {
  seq?: number;             // +1 per record, never repeats (missing = older Rust)
  t: number;
  mode: 'live' | 'practice' | string;
  hash?: string;
  error?: string;
  label: string;
  block: number;
  tokenIn: string;
  amountIn: string;
  sizeUsd: number;
  expectedNetUsd: number;
  gasUsd: number;
  lender?: string;
  lenderFeePips?: number;
  pools: string[];
  kinds?: number[];
  nonce?: number;
  timingsUs?: Record<string, number>;
  totalUs: number;
}

export interface FollowerHooks {
  // A real Rust send with a hash: track it like our own.
  onLiveSent: (r: RustSendRecord) => void;
  // A real Rust send the node refused (nothing on chain).
  onLiveSendFailed: (r: RustSendRecord) => void;
  // Practice "would send" (counted only).
  onPractice?: (r: RustSendRecord) => void;
  log?: (m: string) => void;
}

const pctl = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
};

// Is this line a usable record? (Bad lines are skipped and counted.)
export function parseSendLine(line: string): RustSendRecord | null {
  try {
    const r = JSON.parse(line);
    if (!r || typeof r !== 'object' || !Number.isFinite(r.t) || typeof r.mode !== 'string' || typeof r.label !== 'string') return null;
    if (!Array.isArray(r.pools)) r.pools = [];
    return r as RustSendRecord;
  } catch { return null; }
}

// Where the follower got to (saved to data/fastlane-follow.json).
// tailSeq: the seq of the last line before `offset` (0 = unknown). Checked on
// restart, so a NEW file that happens to get the old inode number is not
// mistaken for the old one.
export interface FollowProgress { ino: number; offset: number; ackSeq: number; tailSeq: number }

// At most this many seqs / hashes are remembered for the duplicate backstop.
const SEEN_MAX = 5_000;
// Most bytes read per poll (a 2 MB file rotates long before this).
const READ_MAX = 8_000_000;

export class FastlaneSendsFollower {
  // File we are reading (inode) and the byte just after its last complete line handled.
  private ino = -1;
  private offset = 0;
  private tailSeq = 0;
  // Saved progress could not be matched to a file (or first start ever): take
  // only records the "unknown place" rule allows, until we are back in step.
  private resumeUnknown = false;
  // With resumeUnknown after a restart: read the whole .1 file once first.
  private readOldFirst = false;
  // First start ever (no progress file): skip records older than 90 s.
  private firstStartCutoffMs = 0;
  // Highest seq handled (goes into the state file for Rust).
  ackSeq = 0;
  private seenSeq = new Set<number>();
  private seenHash = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  readonly hour = { practice: 0, live: 0, failed: 0, bad: 0, dup: 0, totalUs: [] as number[], signUs: [] as number[] };

  constructor(
    readonly file: string,
    private readonly hooks: FollowerHooks,
    readonly progressFile = file.replace(/fastlane-sends\.jsonl$/, 'fastlane-follow.json'),
    private readonly now: () => number = Date.now,
  ) {
    let saved: Partial<FollowProgress> | null = null;
    try { saved = JSON.parse(readFileSync(this.progressFile, 'utf8')); } catch { /* first start */ }
    const n = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
    if (saved && typeof saved === 'object') {
      this.ackSeq = n(saved.ackSeq);
      this.ino = Number.isFinite(Number(saved.ino)) ? Number(saved.ino) : -1;
      this.offset = n(saved.offset);
      this.tailSeq = n(saved.tailSeq);
      this.resumeAfterRestart();
    } else {
      // First start ever: nothing older than 90 s (a receipt is given up after
      // 90 s anyway; older live lines were already settled by someone).
      this.firstStartCutoffMs = this.now() - 90_000;
      this.ino = -1;
      this.offset = 0;
    }
  }

  // Match the saved place to a file on disk.
  private resumeAfterRestart() {
    const same = (path: string) => {
      const st = FastlaneSendsFollower.statOf(path);
      return !!st && st.ino === this.ino && st.size >= this.offset && FastlaneSendsFollower.seqBefore(path, this.offset, this.tailSeq);
    };
    if (same(this.file)) return; // same file: continue at offset
    if (same(this.file + '.1')) return; // rotated while we were down: poll() reads .1 first
    // Both files replaced (or truncated): we don't know where we were. Read
    // what is there from the start, taking only seq > ackSeq.
    this.ino = -1;
    this.offset = 0;
    this.resumeUnknown = true;
    this.readOldFirst = true;
  }

  progress(): FollowProgress { return { ino: this.ino, offset: this.offset, ackSeq: this.ackSeq, tailSeq: this.tailSeq }; }

  // Does the line ending just before byte `offset` of `path` carry seq
  // `expect`? (expect 0 or offset 0 = nothing to check.)
  private static seqBefore(path: string, offset: number, expect: number): boolean {
    if (!expect || offset <= 0) return true;
    let fd = -1;
    try {
      fd = openSync(path, 'r');
      const from = Math.max(0, offset - 65_536);
      const buf = Buffer.alloc(offset - from);
      const n = readSync(fd, buf, 0, buf.length, from);
      if (n !== buf.length || buf[n - 1] !== 0x0a) return false;
      const prev = buf.subarray(0, n - 1).lastIndexOf(0x0a);
      const r = parseSendLine(buf.subarray(prev + 1, n - 1).toString('utf8'));
      return !!r && r.seq === expect;
    } catch { return false; } finally { if (fd >= 0) try { closeSync(fd); } catch { /* fine */ } }
  }

  // Note the seq of the last line read (for the restart check).
  private noteTail(lines: string[]) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      const r = parseSendLine(lines[i]);
      this.tailSeq = r && Number.isFinite(r.seq) ? (r.seq as number) : 0;
      return;
    }
  }

  private saveProgress() {
    try {
      mkdirSync(dirname(this.progressFile), { recursive: true });
      writeFileSync(this.progressFile + '.tmp', JSON.stringify(this.progress()));
      renameSync(this.progressFile + '.tmp', this.progressFile);
    } catch { /* best effort */ }
  }

  private static statOf(path: string): { size: number; ino: number } | null {
    try { const s = statSync(path); return { size: s.size, ino: s.ino }; } catch { return null; }
  }

  // Complete lines of `path` from byte `from` (only up to the last newline).
  // `next` is the byte just after the last complete line.
  private static readLines(path: string, from: number): { lines: string[]; next: number; ino: number } | null {
    let fd = -1;
    try {
      fd = openSync(path, 'r');
      const st = fstatSync(fd);
      const len = Math.max(0, st.size - from);
      const buf = Buffer.alloc(Math.min(len, READ_MAX));
      const n = len ? readSync(fd, buf, 0, buf.length, from) : 0;
      const got = buf.subarray(0, n);
      const lastNl = got.lastIndexOf(0x0a);
      if (lastNl < 0) {
        // No complete line yet. A "line" over 1 MB is never ours: skip the junk.
        if (n > 1_000_000) return { lines: [], next: from + n, ino: st.ino };
        return { lines: [], next: from, ino: st.ino };
      }
      return { lines: got.subarray(0, lastNl).toString('utf8').split('\n'), next: from + lastNl + 1, ino: st.ino };
    } catch { return null; } finally { if (fd >= 0) try { closeSync(fd); } catch { /* fine */ } }
  }

  // Handle one line. Returns true if it was a new record that was handled.
  private handle(line: string): boolean {
    if (!line.trim()) return false;
    const rec = parseSendLine(line);
    if (!rec) { this.hour.bad++; return false; }
    const seq = Number.isFinite(rec.seq) && (rec.seq as number) > 0 ? (rec.seq as number) : 0;
    // Duplicate backstop: same seq or same tx hash already handled.
    const hashKey = rec.hash ? rec.hash.toLowerCase() : '';
    if ((seq && this.seenSeq.has(seq)) || (hashKey && this.seenHash.has(hashKey))) { this.hour.dup++; return false; }
    // Place unknown (both files replaced while we were down): only newer seqs.
    if (this.resumeUnknown && seq && seq <= this.ackSeq) return false;
    // First start ever: skip old lines (and lines without seq from older Rust).
    if (this.firstStartCutoffMs && rec.t < this.firstStartCutoffMs) return false;
    if (seq) { this.seenSeq.add(seq); if (this.seenSeq.size > SEEN_MAX) this.seenSeq.delete(this.seenSeq.values().next().value as number); }
    if (hashKey) { this.seenHash.add(hashKey); if (this.seenHash.size > SEEN_MAX) this.seenHash.delete(this.seenHash.values().next().value as string); }
    try {
      if (rec.mode === 'live') {
        if (rec.hash) { this.hour.live++; this.hooks.onLiveSent(rec); } else { this.hour.failed++; this.hooks.onLiveSendFailed(rec); }
      } else {
        this.hour.practice++;
        if (Number.isFinite(rec.totalUs)) { this.hour.totalUs.push(rec.totalUs); if (this.hour.totalUs.length > 5_000) this.hour.totalUs.shift(); }
        const sign = rec.timingsUs?.sign;
        if (Number.isFinite(sign)) { this.hour.signUs.push(sign as number); if (this.hour.signUs.length > 5_000) this.hour.signUs.shift(); }
        this.hooks.onPractice?.(rec);
      }
    } catch (e) { this.hooks.log?.(`[fastlane] send record not handled: ${(e as Error).message}`); }
    // From now on this record counts in our pendingUsd (live): tell Rust.
    if (seq > this.ackSeq) this.ackSeq = seq;
    return true;
  }

  // Look for new lines once. Returns how many records were handled.
  poll(): number {
    let n = 0;
    let moved = false;
    const cur = FastlaneSendsFollower.statOf(this.file);
    // Rotated (or restarted after a rotation): finish the old file first,
    // if the .1 file is the one we were reading.
    if (this.ino !== -1 && (!cur || cur.ino !== this.ino || cur.size < this.offset)) {
      const old = FastlaneSendsFollower.statOf(this.file + '.1');
      if (old && old.ino === this.ino && FastlaneSendsFollower.seqBefore(this.file + '.1', this.offset, this.tailSeq)) {
        const r = FastlaneSendsFollower.readLines(this.file + '.1', this.offset);
        if (r) for (const l of r.lines) if (this.handle(l)) n++;
        // A half line at the very end of a rotated file never completes: done with it.
      } else if (!cur || cur.ino !== this.ino) {
        // Our file is gone from both names (rotated twice while we were busy /
        // down): read the .1 we find from the start, newer seqs only.
        this.resumeUnknown = true;
        if (old) { const r = FastlaneSendsFollower.readLines(this.file + '.1', 0); if (r) for (const l of r.lines) if (this.handle(l)) n++; }
      }
      // Same inode but shorter (truncated in place): start over, newer seqs only.
      if (cur && cur.ino === this.ino) this.resumeUnknown = true;
      this.ino = -1;
      this.offset = 0;
      this.tailSeq = 0;
      moved = true;
    }
    if (this.readOldFirst) {
      // Place unknown after a restart: the .1 file may hold sends we never
      // saw (newer seqs only are taken; the rest are skipped).
      this.readOldFirst = false;
      const r = FastlaneSendsFollower.readLines(this.file + '.1', 0);
      if (r) for (const l of r.lines) if (this.handle(l)) n++;
      moved = true;
    }
    if (cur) {
      const r = FastlaneSendsFollower.readLines(this.file, this.offset);
      if (r) {
        for (const l of r.lines) if (this.handle(l)) n++;
        if (r.lines.length) this.noteTail(r.lines);
        if (r.next !== this.offset || r.ino !== this.ino) moved = true;
        this.offset = r.next;
        this.ino = r.ino;
        // Back in step with a known file: the unknown-place rule is no longer needed.
        if (this.resumeUnknown && r.lines.length) this.resumeUnknown = false;
        // First start ever: the 90 s cutoff is only for what was already there.
        this.firstStartCutoffMs = 0;
      }
    }
    if (moved || n) this.saveProgress();
    return n;
  }

  // One line for the hourly report (then the hour starts over).
  hourLine(reset = true): string {
    const h = this.hour;
    const ms = (us: number) => (us / 1000).toFixed(1);
    const line = `[fastlane] hour: practice would send ${h.practice}` +
      (h.totalUs.length ? ` (feed -> send p50 ${ms(pctl(h.totalUs, 0.5))} ms, p90 ${ms(pctl(h.totalUs, 0.9))} ms` + (h.signUs.length ? `; sign p50 ${ms(pctl(h.signUs, 0.5))} ms` : '') + ')' : '') +
      `, live sent ${h.live}${h.failed ? `, node refused ${h.failed}` : ''}${h.bad ? `, unreadable lines ${h.bad}` : ''}${h.dup ? `, duplicates skipped ${h.dup}` : ''}`;
    if (reset) Object.assign(this.hour, { practice: 0, live: 0, failed: 0, bad: 0, dup: 0, totalUs: [], signUs: [] });
    return line;
  }

  start(everyMs = 250) {
    this.poll();
    this.timer = setInterval(() => { try { this.poll(); } catch { /* never throws */ } }, Math.max(50, everyMs));
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

// Counters about Rust's own sends, for the state file (H4 prep: the gun
// re-reads its nonce when dropsSeen goes up, and can size its gas limit
// from maxGasUsed). Bounded: a set of the hashes we are waiting on.
export class RustSendStats {
  dropsSeen = 0;
  maxGasUsed = 0;
  // A tracked Rust send's final result was "dropped" (never mined).
  noteResult(status: string) { if (status === 'dropped') this.dropsSeen++; }
  // Gas units a Rust send used (from its receipt).
  noteGas(gas: bigint | number) {
    const g = Number(gas);
    if (Number.isFinite(g) && g > this.maxGasUsed) this.maxGasUsed = g;
  }
}

// Neighbouring pool pairs of a route (2 pools = one pair; a loop also
// last -> first), the same pairs Rust checks against the fail-block list.
export function routePairs(pools: string[]): [string, string][] {
  const p = pools.map((x) => x.toLowerCase());
  if (p.length < 2) return [];
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < p.length; i++) out.push([p[i], p[i + 1]]);
  if (p.length > 2) out.push([p[p.length - 1], p[0]]);
  return out;
}
