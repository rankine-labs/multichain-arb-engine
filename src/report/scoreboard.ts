import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'fs';
import { dirname } from 'path';

// ============================================================================
// SCOREBOARD: the live-money truth, and the bot adjusting itself from it.
//
// Plain English (owner, Oct 23: "we need sufficiently accurate predictions,
// fast execution, and measured results showing that wins outweigh
// failed-trade gas"):
//
//   Every REAL send is written down with:
//     - which path sent it: trig_first (trigger-first check), copy2 (fast
//       check on copy 2 after the trigger's pool reports), node (the paid
//       node's check after the receipt), guess (sent on the model, check
//       first off), gap (standing gap), loop (live loop)
//     - trigger-first only: how sure the answer was (high / medium / low)
//       and what it assumed (sender_funds, recent_fill, skipped_unrelated...)
//     - the profit it expected
//   and, once its receipt is in:
//     - won or failed on chain (a failed trade costs only gas: the contract
//       reverts anything under its minimum profit)
//     - profit won (the contract's own Executed event; if that couldn't be
//       priced, the expected profit, marked as such)
//     - gas paid, in ETH and USD
//
//   From that: sends, wins, win rate, profit won, gas lost, NET, and the
//   BREAK-EVEN win rate (the win rate at which wins exactly pay for all the
//   gas: average gas per send / average profit per win). Per path and per
//   confidence, for the hour and for the day (Toronto day). Hourly log line
//   "[scoreboard] hour: ..." and a block in the hourly Telegram message.
//   Every settled send is one line in data/scoreboard.jsonl (kept under
//   2 MB, the older half in .jsonl.1).
//
//   SELF-ADJUSTING (all thresholds are settings, see scoreSettings):
//     - BUCKETS: every send belongs to buckets (path, confidence, assumption
//       kind); a send with two assumptions is in two buckets; an exact one
//       is in (path, confidence, "exact"). When a bucket's latest sends
//       (at least SCORE_BUCKET_MIN_SENDS = 12, at most the last 50) together
//       LOST money, that bucket stops sending for SCORE_BUCKET_PAUSE_H = 6 h
//       (log + Telegram note). After the pause it starts counting from zero.
//     - OVERALL STEP BACK: if every real send of the last
//       SCORE_STEPBACK_WINDOW_H = 3 h together lost more than
//       SCORE_STEPBACK_NET_USD = $1.50, trigger-first goes back to practice
//       (shadow) for SCORE_STEPBACK_H = 6 h by itself (log + Telegram alert).
//     SCORE_SELF_ADJUST=0 = report only, never pause anything.
//
//   Safety: reporting never throws into the bot; a broken file is skipped.
// ============================================================================

export type SendPath = 'trig_first' | 'copy2' | 'node' | 'guess' | 'gap' | 'loop' | 'unknown';
export type Confidence = 'high' | 'medium' | 'low';

// What is known at the moment of sending.
export type ScoreSend = {
  hash: string;
  path: SendPath;
  confidence?: Confidence;        // trigger-first only
  assumptions?: string[];         // trigger-first only, e.g. ["sender_funds", "skipped_unrelated:1"]
  expectedUsd: number;            // expected profit after gas (what the check said)
  label?: string;
  pools?: string[];               // the pools traded (standing-gap fail block)
  sentMs?: number;
};

// One settled send (= one line of data/scoreboard.jsonl).
export type ScoreRecord = ScoreSend & {
  status: 'won' | 'failed' | 'dropped';
  wonUsd: number;                 // profit won (0 if failed)
  wonFrom: 'event' | 'expected' | null; // where wonUsd came from
  gasEth: number;
  gasUsd: number;
  netUsd: number;                 // wonUsd - gasUsd
  settledMs: number;
};

// The final result the live tracker hands over (execution/liveTracker.ts LiveResult).
export type ScoreResult = { hash: string; status: 'profit' | 'reverted' | 'dropped'; gasUsd: number; gasEth?: number; profitUsd?: number; expectedProfitUsd: number; label?: string };

export type ScoreSettings = {
  file: string;            // SCOREBOARD_FILE [data/scoreboard.jsonl]
  maxBytes: number;        // SCOREBOARD_MAX_BYTES [2000000]
  selfAdjust: boolean;     // SCORE_SELF_ADJUST [1]; 0 = report only
  bucketMinSends: number;  // SCORE_BUCKET_MIN_SENDS [12]
  bucketWindow: number;    // SCORE_BUCKET_WINDOW [50] latest sends looked at
  bucketPauseH: number;    // SCORE_BUCKET_PAUSE_H [6]
  stepBackUsd: number;     // SCORE_STEPBACK_NET_USD [1.5] (a loss bigger than this)
  stepBackWindowH: number; // SCORE_STEPBACK_WINDOW_H [3]
  stepBackH: number;       // SCORE_STEPBACK_H [6]
  tz: string;              // REPORT_TZ [America/Toronto] whose "today"
};

export function scoreSettings(env: Record<string, string | undefined> = process.env): ScoreSettings {
  const num = (k: string, d: number, min = 0) => { const v = Number(env[k]); return env[k] !== undefined && env[k] !== '' && Number.isFinite(v) && v >= min ? v : d; };
  return {
    file: env.SCOREBOARD_FILE || 'data/scoreboard.jsonl',
    maxBytes: num('SCOREBOARD_MAX_BYTES', 2_000_000, 10_000),
    selfAdjust: (env.SCORE_SELF_ADJUST ?? '1').trim() !== '0',
    bucketMinSends: Math.round(num('SCORE_BUCKET_MIN_SENDS', 12, 1)),
    bucketWindow: Math.round(num('SCORE_BUCKET_WINDOW', 50, 1)),
    bucketPauseH: num('SCORE_BUCKET_PAUSE_H', 6, 0.01),
    stepBackUsd: num('SCORE_STEPBACK_NET_USD', 1.5, 0),
    stepBackWindowH: num('SCORE_STEPBACK_WINDOW_H', 3, 0.01),
    stepBackH: num('SCORE_STEPBACK_H', 6, 0.01),
    tz: env.REPORT_TZ || 'America/Toronto',
  };
}

// "skipped_unrelated:2" -> "skipped_unrelated"; none -> ["exact"].
export function assumptionKinds(a: string[] | undefined): string[] {
  const k = [...new Set((a ?? []).map((x) => String(x).split(':')[0]).filter(Boolean))].sort();
  return k.length ? k : ['exact'];
}

// The buckets one send belongs to: "path|confidence|kind" per assumption kind.
export function bucketsOf(s: { path: SendPath; confidence?: Confidence; assumptions?: string[] }): string[] {
  return assumptionKinds(s.assumptions).map((k) => `${s.path}|${s.confidence ?? '-'}|${k}`);
}

// Totals of a set of settled sends (dropped ones don't count: never mined, no gas).
export type ScoreTotals = { sends: number; wins: number; winRate: number | null; wonUsd: number; gasUsd: number; gasEth: number; netUsd: number; breakEvenWinRate: number | null; dropped: number; wonFromExpected: number };

export function totals(rs: ScoreRecord[]): ScoreTotals {
  const settled = rs.filter((r) => r.status !== 'dropped');
  const wins = settled.filter((r) => r.status === 'won');
  const wonUsd = wins.reduce((s, r) => s + r.wonUsd, 0);
  const gasUsd = settled.reduce((s, r) => s + r.gasUsd, 0);
  const gasEth = settled.reduce((s, r) => s + r.gasEth, 0);
  // Break-even win rate = average gas per send / average profit per win.
  // No win yet: the average expected profit (before gas) stands in for it.
  const avgGas = settled.length ? gasUsd / settled.length : 0;
  const avgWin = wins.length ? wonUsd / wins.length : settled.length ? settled.reduce((s, r) => s + r.expectedUsd + r.gasUsd, 0) / settled.length : 0;
  return {
    sends: settled.length, wins: wins.length, winRate: settled.length ? wins.length / settled.length : null,
    wonUsd, gasUsd, gasEth, netUsd: wonUsd - gasUsd,
    breakEvenWinRate: avgWin > 0 && settled.length ? Math.min(1, avgGas / avgWin) : null,
    dropped: rs.length - settled.length, wonFromExpected: wins.filter((r) => r.wonFrom === 'expected').length,
  };
}

// STANDING-GAP FAIL BLOCK (Oct 23): a standing gap whose LIVE trade failed
// on chain: block that pool pair for standing-gap live sends (the caller's
// block list holds it for GAP_LIVE_FAIL_BLOCK_MIN, default 30 min). Standing
// gaps otherwise ignore the 6 h live route block by design (each is sent
// right after its own fresh real check). Returns true when it blocked.
export function standingGapFailBlock(rec: ScoreRecord | null, block: (buyPool: string, sellPool: string, why: string) => void): boolean {
  if (!rec || rec.path !== 'gap' || rec.status !== 'failed' || !rec.pools || rec.pools.length < 2) return false;
  block(rec.pools[0], rec.pools[1], 'standing gap: live trade failed on chain');
  return true;
}

const usd = (v: number) => `${v < 0 ? '-' : '+'}$${Math.abs(v).toFixed(2)}`;
const pctOf = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);

export type ScoreboardOptions = {
  settings?: ScoreSettings;
  env?: Record<string, string | undefined>;
  now?: () => number;
  log?: (m: string) => void;
  notify?: (text: string) => void;              // Telegram (plain text; the host escapes it)
  // Trigger-first back to practice until untilMs (overall step back).
  onStepBack?: (untilMs: number, why: string) => void;
  load?: boolean;                               // read the file at start [true]
};

export class Scoreboard {
  readonly s: ScoreSettings;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly o: ScoreboardOptions;
  private pending = new Map<string, ScoreSend>();        // sent, receipt not in yet
  private recs: ScoreRecord[] = [];                      // settled, last 8 days
  private pauses = new Map<string, { until: number; why: string }>();
  private countFrom = new Map<string, number>();         // bucket -> count only sends settled after this
  private stepBackUntil = 0;
  private stepBackFrom = 0;                              // overall window counts only after this
  private fileSize = -1;

  constructor(opts: ScoreboardOptions = {}) {
    this.o = opts;
    this.s = opts.settings ?? scoreSettings(opts.env ?? process.env);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(m));
    if (opts.load !== false) this.load();
  }

  // ---- input -----------------------------------------------------------------
  // A real send went out.
  noteSend(s: ScoreSend): void {
    try {
      if (!s?.hash) return;
      this.pending.set(s.hash.toLowerCase(), { ...s, sentMs: s.sentMs ?? this.now(), assumptions: s.assumptions?.slice(0, 8) });
      if (this.pending.size > 2_000) this.pending.delete(this.pending.keys().next().value as string);
    } catch { /* reporting only */ }
  }

  // Its final result (receipt, or never mined). Returns the settled record.
  noteResult(r: ScoreResult): ScoreRecord | null {
    try {
      const key = (r.hash ?? '').toLowerCase();
      const s = this.pending.get(key) ?? { hash: r.hash, path: 'unknown' as SendPath, expectedUsd: r.expectedProfitUsd, label: r.label };
      this.pending.delete(key);
      const won = r.status === 'profit';
      // Won: the contract's Executed event profit if it could be priced, else
      // the expected profit (marked "expected").
      const wonUsd = won ? (Number.isFinite(r.profitUsd) ? (r.profitUsd as number) : s.expectedUsd) : 0;
      const gasUsd = Number.isFinite(r.gasUsd) ? r.gasUsd : 0;
      const rec: ScoreRecord = {
        ...s,
        status: won ? 'won' : r.status === 'dropped' ? 'dropped' : 'failed',
        wonUsd, wonFrom: won ? (Number.isFinite(r.profitUsd) ? 'event' : 'expected') : null,
        gasEth: Number.isFinite(r.gasEth) ? (r.gasEth as number) : 0, gasUsd,
        netUsd: wonUsd - gasUsd, settledMs: this.now(),
      };
      this.recs.push(rec);
      this.prune();
      this.append({ k: 'send', ...rec });
      if (rec.status !== 'dropped') this.adjust(rec);
      return rec;
    } catch { return null; }
  }

  // ---- self-adjusting ----------------------------------------------------------------
  private adjust(rec: ScoreRecord): void {
    if (!this.s.selfAdjust) return;
    const t = this.now();
    // 1. Buckets of this send.
    for (const b of bucketsOf(rec)) {
      if (this.pausedBucket(b)) continue;
      const from = this.countFrom.get(b) ?? 0;
      const inB = this.recs.filter((r) => r.status !== 'dropped' && r.settledMs > from && bucketsOf(r).includes(b)).slice(-this.s.bucketWindow);
      if (inB.length < this.s.bucketMinSends) continue;
      const tt = totals(inB);
      if (tt.netUsd >= 0) continue;
      const until = t + this.s.bucketPauseH * 3_600_000;
      const why = `${inB.length} sends lost ${usd(tt.netUsd)} (won ${tt.wins}, gas $${tt.gasUsd.toFixed(2)})`;
      this.pauses.set(b, { until, why });
      this.countFrom.set(b, until);
      this.append({ k: 'pause', bucket: b, until, why, t });
      const msg = `Scoreboard: stopped sending from "${b.replace(/\|/g, ' / ')}" for ${this.s.bucketPauseH} h: its last ${why}`;
      this.log(`[scoreboard] ${msg}`);
      try { this.o.notify?.(`⏸ ${msg}`); } catch { /* reporting only */ }
    }
    // 2. Overall: the last few hours of every real send.
    if (t < this.stepBackUntil) return;
    const since = Math.max(t - this.s.stepBackWindowH * 3_600_000, this.stepBackFrom);
    const win = this.recs.filter((r) => r.status !== 'dropped' && r.settledMs > since);
    const tt = totals(win);
    if (win.length && tt.netUsd < -this.s.stepBackUsd) {
      this.stepBackUntil = t + this.s.stepBackH * 3_600_000;
      this.stepBackFrom = this.stepBackUntil;
      const why = `real sends of the last ${this.s.stepBackWindowH} h lost ${usd(tt.netUsd)} (${tt.sends} sends, ${tt.wins} won, gas $${tt.gasUsd.toFixed(2)}; limit -$${this.s.stepBackUsd.toFixed(2)})`;
      this.append({ k: 'stepback', until: this.stepBackUntil, why, t });
      this.log(`[scoreboard] OVERALL STEP BACK: trigger-first back to practice for ${this.s.stepBackH} h: ${why}`);
      try { this.o.onStepBack?.(this.stepBackUntil, why); } catch { /* never throws */ }
      try { this.o.notify?.(`⚠️ TRIGGER-FIRST stepped back to practice for ${this.s.stepBackH} h: ${why}`); } catch { /* reporting only */ }
    }
  }

  private pausedBucket(b: string): { until: number; why: string } | null {
    const p = this.pauses.get(b);
    if (!p) return null;
    if (p.until > this.now()) return p;
    this.pauses.delete(b);
    return null;
  }

  // Why a send from this path / confidence / assumptions must not go out
  // now (one of its buckets is paused), or null = fine.
  pausedWhy(path: SendPath, confidence?: Confidence, assumptions?: string[]): string | null {
    try {
      if (!this.s.selfAdjust) return null;
      for (const b of bucketsOf({ path, confidence, assumptions })) {
        const p = this.pausedBucket(b);
        if (p) return `bucket ${b.replace(/\|/g, ' / ')} paused (${p.why})`;
      }
      return null;
    } catch { return null; }
  }

  // Trigger-first stepped back by the overall rule until this time (0 = no).
  stepBackActiveUntil(): number { return this.stepBackUntil > this.now() ? this.stepBackUntil : 0; }

  // ---- reports -----------------------------------------------------------------------
  private dayKey(ms: number): string { return new Date(ms).toLocaleDateString('en-CA', { timeZone: this.s.tz }); }

  // Sends settled after fromMs, up to and including toMs.
  window(fromMs: number, toMs: number): ScoreRecord[] { return this.recs.filter((r) => r.settledMs > fromMs && r.settledMs <= toMs); }
  today(): ScoreRecord[] { const d = this.dayKey(this.now()); return this.recs.filter((r) => this.dayKey(r.settledMs) === d); }

  private line(rs: ScoreRecord[]): string {
    const t = totals(rs);
    if (!t.sends) return `0 sent${t.dropped ? ` (${t.dropped} never mined)` : ''}`;
    return `${t.sends} sent, ${t.wins} won (${pctOf(t.winRate)}), won $${t.wonUsd.toFixed(2)}${t.wonFromExpected ? ` (${t.wonFromExpected} at expected)` : ''}, gas $${t.gasUsd.toFixed(2)} (${t.gasEth.toFixed(6)} ETH), NET ${usd(t.netUsd)}, break-even win rate ${pctOf(t.breakEvenWinRate)}${t.dropped ? `, ${t.dropped} never mined` : ''}`;
  }
  private split(rs: ScoreRecord[], key: (r: ScoreRecord) => string): string {
    const groups = new Map<string, ScoreRecord[]>();
    for (const r of rs) if (r.status !== 'dropped') { const k = key(r); (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, g]) => {
      const t = totals(g);
      return `${k} ${t.sends} (won ${t.wins}, net ${usd(t.netUsd)})`;
    }).join(', ');
  }

  // The hourly block (null = nothing real happened and nothing is paused).
  // Also logged as "[scoreboard] hour: ...".
  hourText(fromMs: number, toMs: number = this.now()): string | null {
    try {
      const hour = this.window(fromMs, toMs);
      const day = this.today();
      const paused = [...this.pauses.entries()].filter(([, p]) => p.until > this.now());
      const step = this.stepBackActiveUntil();
      if (!hour.length && !day.length && !paused.length && !step && !this.pending.size) return null;
      const parts = [`this hour ${this.line(hour)}`];
      const byPath = this.split(hour, (r) => r.path);
      if (byPath) parts.push(`by path: ${byPath}`);
      const byConf = this.split(hour.filter((r) => r.path === 'trig_first'), (r) => r.confidence ?? 'n/a');
      if (byConf) parts.push(`trigger-first by confidence: ${byConf}`);
      parts.push(`today ${this.line(day)}`);
      const dayPath = this.split(day, (r) => r.path);
      if (dayPath) parts.push(`today by path: ${dayPath}`);
      if (this.pending.size) parts.push(`${this.pending.size} waiting for a receipt`);
      const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: this.s.tz, hour: '2-digit', minute: '2-digit' });
      if (paused.length) parts.push(`PAUSED: ${paused.map(([b, p]) => `${b.replace(/\|/g, '/')} until ${hhmm(p.until)}`).join(', ')}`);
      if (step) parts.push(`TRIGGER-FIRST STEPPED BACK to practice until ${hhmm(step)}`);
      const text = `Scoreboard (real money): ${parts.join('; ')}`;
      this.log(`[scoreboard] hour: ${text}`);
      return text;
    } catch { return null; }
  }

  // ---- file ----------------------------------------------------------------------------
  private prune(): void {
    const cut = this.now() - 8 * 86_400_000;
    if (this.recs.length > 20_000 || (this.recs[0] && this.recs[0].settledMs < cut)) this.recs = this.recs.filter((r) => r.settledMs >= cut).slice(-20_000);
  }

  private append(rec: Record<string, unknown>): void {
    try {
      const text = JSON.stringify(rec) + '\n';
      if (this.fileSize < 0) {
        const dir = dirname(this.s.file);
        if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
        this.fileSize = existsSync(this.s.file) ? statSync(this.s.file).size : 0;
      }
      if (this.fileSize > 0 && this.fileSize + text.length > this.s.maxBytes) {
        try { renameSync(this.s.file, this.s.file + '.1'); } catch { /* best effort */ }
        this.fileSize = 0;
        // Keep the state lines that still matter in the new file.
        for (const [b, p] of this.pauses) if (p.until > this.now()) { const l = JSON.stringify({ k: 'pause', bucket: b, until: p.until, why: p.why, t: this.now() }) + '\n'; appendFileSync(this.s.file, l); this.fileSize += l.length; }
        if (this.stepBackUntil > this.now()) { const l = JSON.stringify({ k: 'stepback', until: this.stepBackUntil, why: 'carried over', t: this.now() }) + '\n'; appendFileSync(this.s.file, l); this.fileSize += l.length; }
      }
      appendFileSync(this.s.file, text);
      this.fileSize += text.length;
    } catch { /* reporting only */ }
  }

  // Restart: the last days' sends, pauses and step back from the file(s).
  load(): number {
    let n = 0;
    for (const f of [this.s.file + '.1', this.s.file]) {
      try {
        if (!existsSync(f)) continue;
        for (const line of readFileSync(f, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const j = JSON.parse(line);
            if (j.k === 'send' && typeof j.settledMs === 'number') { delete j.k; this.recs.push(j as ScoreRecord); n++; }
            else if (j.k === 'pause' && typeof j.bucket === 'string' && Number.isFinite(j.until)) { this.pauses.set(j.bucket, { until: j.until, why: String(j.why ?? '') }); this.countFrom.set(j.bucket, j.until); }
            else if (j.k === 'stepback' && Number.isFinite(j.until)) { this.stepBackUntil = Math.max(this.stepBackUntil, j.until); this.stepBackFrom = this.stepBackUntil; }
          } catch { /* a broken line is skipped */ }
        }
      } catch { /* unreadable file: start empty */ }
    }
    this.recs.sort((a, b) => a.settledMs - b.settledMs);
    this.prune();
    return n;
  }
}
