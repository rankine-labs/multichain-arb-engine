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
//      Where we got to is saved (data/fastlane-follow.json), so a restart
//      neither misses nor double-counts a send. The file is rotated by Rust
//      (renamed to .1); the rest of the old file is read before the new one.
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
  followedMs: number;       // newest Rust send record we have picked up
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
  followedMs: () => number;
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
    loopLossUsd: finite(safe(s.loopLossUsd, 0)),
    loopPaused: safe(s.loopPaused, true),
    liveReady: safe(s.liveReady, false),
    liveProblems: safe(s.liveProblems, []),
    approvedLenders: lowerAll(safe(s.approvedLenders, [])),
    ownMoney: { readMs: own.readMs, balances: Object.fromEntries(Object.entries(own.balances).map(([k, v]) => [k.toLowerCase(), v.toString()])) },
    killed: safe(s.killed, true),
    followedMs: safe(s.followedMs, 0),
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

export class FastlaneSendsFollower {
  private offset = 0;
  private ino = -1;
  private rest = '';
  private timer: NodeJS.Timeout | null = null;
  // Newest record time picked up (saved, so a restart continues after it).
  followedMs = 0;
  readonly hour = { practice: 0, live: 0, failed: 0, bad: 0, totalUs: [] as number[], signUs: [] as number[] };

  constructor(
    readonly file: string,
    private readonly hooks: FollowerHooks,
    readonly progressFile = file.replace(/fastlane-sends\.jsonl$/, 'fastlane-follow.json'),
    private readonly now: () => number = Date.now,
  ) {
    // Continue where we stopped; first start ever: nothing older than 90 s
    // (a receipt is given up after 90 s anyway).
    let saved = 0;
    try { saved = Number(JSON.parse(readFileSync(this.progressFile, 'utf8')).followedMs) || 0; } catch { /* first start */ }
    this.followedMs = saved > 0 ? saved : this.now() - 90_000;
  }

  private saveProgress() {
    try {
      mkdirSync(dirname(this.progressFile), { recursive: true });
      writeFileSync(this.progressFile + '.tmp', JSON.stringify({ followedMs: this.followedMs }));
      renameSync(this.progressFile + '.tmp', this.progressFile);
    } catch { /* best effort */ }
  }

  // Read the bytes of `path` from `from` to its end.
  private static readFrom(path: string, from: number): { text: string; size: number; ino: number } | null {
    let fd = -1;
    try {
      fd = openSync(path, 'r');
      const st = fstatSync(fd);
      const len = Math.max(0, st.size - from);
      const buf = Buffer.alloc(Math.min(len, 8_000_000)); // bounded per poll
      const n = len ? readSync(fd, buf, 0, buf.length, from) : 0;
      return { text: buf.subarray(0, n).toString('utf8'), size: from + n, ino: st.ino };
    } catch { return null; } finally { if (fd >= 0) try { closeSync(fd); } catch { /* fine */ } }
  }

  // Look for new lines once. Returns how many records were handled.
  poll(): number {
    let text = '';
    let st: { size: number; ino: number } | null = null;
    try { const s = statSync(this.file); st = { size: s.size, ino: s.ino }; } catch { st = null; }
    if (!st) return 0;
    if (this.ino !== -1 && (st.ino !== this.ino || st.size < this.offset)) {
      // Rotated: finish the old file (now .1) first, if it is the one we read.
      try {
        const old = statSync(this.file + '.1');
        if (old.ino === this.ino) { const r = FastlaneSendsFollower.readFrom(this.file + '.1', this.offset); if (r) text += r.text; }
      } catch { /* gone: nothing more to read */ }
      if (!text.endsWith('\n')) text += '\n';
      this.offset = 0;
    }
    const r = FastlaneSendsFollower.readFrom(this.file, this.offset);
    if (!r) return 0;
    this.offset = r.size;
    this.ino = r.ino;
    text = this.rest + text + r.text;
    const lines = text.split('\n');
    this.rest = lines.pop() ?? '';
    if (this.rest.length > 1_000_000) this.rest = ''; // never a line this long: drop junk
    let n = 0;
    let advanced = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      const rec = parseSendLine(line);
      if (!rec) { this.hour.bad++; continue; }
      if (rec.t <= this.followedMs) continue; // already picked up (restart)
      n++;
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
      // Live records count in the state file's pendingUsd from now on.
      if (rec.t > this.followedMs) { this.followedMs = rec.t; advanced = true; }
    }
    if (advanced) this.saveProgress();
    return n;
  }

  // One line for the hourly report (then the hour starts over).
  hourLine(reset = true): string {
    const h = this.hour;
    const ms = (us: number) => (us / 1000).toFixed(1);
    const line = `[fastlane] hour: practice would send ${h.practice}` +
      (h.totalUs.length ? ` (feed -> send p50 ${ms(pctl(h.totalUs, 0.5))} ms, p90 ${ms(pctl(h.totalUs, 0.9))} ms` + (h.signUs.length ? `; sign p50 ${ms(pctl(h.signUs, 0.5))} ms` : '') + ')' : '') +
      `, live sent ${h.live}${h.failed ? `, node refused ${h.failed}` : ''}${h.bad ? `, unreadable lines ${h.bad}` : ''}`;
    if (reset) Object.assign(this.hour, { practice: 0, live: 0, failed: 0, bad: 0, totalUs: [], signUs: [] });
    return line;
  }

  start(everyMs = 250) {
    this.poll();
    this.timer = setInterval(() => { try { this.poll(); } catch { /* never throws */ } }, Math.max(50, everyMs));
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
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
