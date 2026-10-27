import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';

// ============================================================================
// ROUTE SCORES -- the bot learns which pool pairs actually pay out.
//
// Plain English:
//   The bot's paper math often says "worth $0.50+" and the real-chain test
//   says "about $0" or "loses". A big reason: pool money sits in price bands,
//   and the paper math assumes it's spread across all prices, so some pools
//   look deep but are nearly empty at today's price.
//
//   For each pair of pools (buy here, sell there) we keep score: how many real
//   tests, how many made money, the best real result. A pair tested at least
//   MIN_TESTS times that never made real money gets benched for BENCH_MS
//   (6 h). Its checks go to routes that do pay. A pair that makes money is
//   never benched. Scores are saved to disk so a restart keeps what was learned.
// ============================================================================

type Score = { tests: number; wins: number; bestUsd: number; benchedUntil: number; lastMs: number };

export class RouteScores {
  private scores = new Map<string, Score>();
  constructor(
    private readonly minTests = Number(process.env.ROUTE_MIN_TESTS ?? 3),
    private readonly benchMs = Number(process.env.ROUTE_BENCH_MS ?? 6 * 60 * 60_000),
    private readonly winUsd = Number(process.env.ROUTE_WIN_USD ?? 0.1), // a "real" win, not dust
    private readonly now: () => number = Date.now,
  ) {}

  static key(buyPool: string, sellPool: string) { return `${buyPool.toLowerCase()}>${sellPool.toLowerCase()}`; }

  // Record one real-test result. realUsd: profit after loan fee (0 or less = loss/fail).
  record(key: string, realUsd: number): void {
    const t = this.now();
    const s = this.scores.get(key) ?? { tests: 0, wins: 0, bestUsd: 0, benchedUntil: 0, lastMs: 0 };
    s.tests++;
    s.lastMs = t;
    if (realUsd >= this.winUsd) { s.wins++; s.benchedUntil = 0; }
    s.bestUsd = Math.max(s.bestUsd, realUsd);
    // Never paid out after enough tries: bench it, and start counting fresh
    // when it comes back (the market can change).
    if (s.wins === 0 && s.tests >= this.minTests) { s.benchedUntil = t + this.benchMs; s.tests = 0; }
    this.scores.set(key, s);
    if (this.scores.size > 5_000) this.prune();
  }

  isBenched(key: string): boolean { return (this.scores.get(key)?.benchedUntil ?? 0) > this.now(); }

  benchedCount(): number { let n = 0; const t = this.now(); for (const s of this.scores.values()) if (s.benchedUntil > t) n++; return n; }

  private prune() {
    const old = this.now() - 7 * 24 * 60 * 60_000;
    for (const [k, s] of this.scores) if (s.lastMs < old && s.benchedUntil < this.now()) this.scores.delete(k);
  }

  load(file: string): number {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Score>;
      for (const [k, s] of Object.entries(j)) this.scores.set(k, s);
      return this.scores.size;
    } catch { return 0; }
  }

  save(file: string): void {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file + '.tmp', JSON.stringify(Object.fromEntries(this.scores)));
      renameSync(file + '.tmp', file);
    } catch { /* best effort */ }
  }
}

// ----------------------------------------------------------------------------
// LIVE ROUTE BLOCK (Oct 19, owner approved after the first live trades)
//
// Plain English:
//   On the first live day, the same two pool pairs (GLXY and META, Uniswap
//   V3 -> V4) were sent 9 times and failed 9 times. The bot's own real-chain
//   check said "FAILS" / "LOSS" for those exact pairs, but trigger trades are
//   sent BEFORE that check finishes (speed), and the old bench needed 3 failed
//   checks and let anything over $1 skip it.
//
//   Now, for REAL sends only:
//     - one failed or losing real check on a pool pair, or one live trade on
//       it that fails on the chain, blocks that pair for LIVE_BLOCK_MS (6 h),
//       whatever the expected profit (no $1 bypass);
//     - a real check that makes money on the pair lifts the block at once.
//   Practice checks are NOT blocked, so the bot keeps testing the pair and
//   can learn that it pays again. Saved to disk so a restart keeps it.
// ----------------------------------------------------------------------------
type LiveBlock = { until: number; why: string };

export class LiveRouteBlock {
  private blocks = new Map<string, LiveBlock>();
  constructor(
    private readonly blockMs = Number(process.env.LIVE_BLOCK_MS ?? 6 * 60 * 60_000),
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 5_000,
  ) {}

  // Block a pool pair (both directions: the same two pools are just as wrong either way).
  block(buyPool: string, sellPool: string, why: string): void {
    const until = this.now() + this.blockMs;
    for (const k of [RouteScores.key(buyPool, sellPool), RouteScores.key(sellPool, buyPool)]) this.blocks.set(k, { until, why: String(why).slice(0, 120) });
    if (this.blocks.size > this.maxEntries) this.prune();
  }

  // A real check made money on this pair: it is fine again.
  clear(buyPool: string, sellPool: string): void {
    this.blocks.delete(RouteScores.key(buyPool, sellPool));
    this.blocks.delete(RouteScores.key(sellPool, buyPool));
  }

  // Why the pair is blocked right now, or null.
  reason(buyPool: string, sellPool: string): string | null {
    const b = this.blocks.get(RouteScores.key(buyPool, sellPool));
    return b && b.until > this.now() ? b.why : null;
  }

  // Every block still running, keyed "buyPool>sellPool" (fast lane state file).
  entries(): [string, { until: number; why: string }][] { const t = this.now(); return [...this.blocks].filter(([, b]) => b.until > t); }

  count(): number { const t = this.now(); let n = 0; for (const b of this.blocks.values()) if (b.until > t) n++; return n; }

  private prune() { const t = this.now(); for (const [k, b] of this.blocks) if (b.until <= t) this.blocks.delete(k); }

  load(file: string): number {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, LiveBlock>;
      for (const [k, b] of Object.entries(j)) if (b && Number.isFinite(b.until) && b.until > this.now()) this.blocks.set(k, { until: b.until, why: String(b.why ?? '') });
      return this.count();
    } catch { return 0; }
  }

  save(file: string): void {
    try {
      this.prune();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file + '.tmp', JSON.stringify(Object.fromEntries(this.blocks)));
      renameSync(file + '.tmp', file);
    } catch { /* best effort: reporting only */ }
  }
}

// ----------------------------------------------------------------------------
// WIN SIZES -- how many real wins (after gas, vetted coins) cleared each bar,
// so the firing bar ($20 today) can be set from data. Per hour and per day
// (Toronto day, like the rest of the hourly report).
// ----------------------------------------------------------------------------
export const WIN_BARS = [1, 2, 5, 10, 20];

export class WinSizes {
  hour = WIN_BARS.map(() => 0);
  today = WIN_BARS.map(() => 0);
  todayUsd = WIN_BARS.map(() => 0); // money at each bar (sum of wins >= bar)
  private day: string;
  // tz: whose calendar "today" follows. Default UTC (as before); the bot passes
  // Toronto so this "today" matches the rest of the hourly report.
  constructor(private readonly now: () => number = Date.now, private readonly tz = 'UTC') { this.day = this.dayKey(); }
  private dayKey() { return new Date(this.now()).toLocaleDateString('en-CA', { timeZone: this.tz }); }

  add(netUsd: number) {
    if (this.dayKey() !== this.day) { this.day = this.dayKey(); this.today = WIN_BARS.map(() => 0); this.todayUsd = WIN_BARS.map(() => 0); }
    WIN_BARS.forEach((bar, i) => {
      if (netUsd >= bar) { this.hour[i]++; this.today[i]++; this.todayUsd[i] += netUsd; }
    });
  }
  resetHour() { this.hour = WIN_BARS.map(() => 0); }
}
