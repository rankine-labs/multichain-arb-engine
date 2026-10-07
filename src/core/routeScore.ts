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
// WIN SIZES -- how many real wins (after gas, vetted coins) cleared each bar,
// so the firing bar ($20 today) can be set from data. Per hour and per day
// (UTC day, like the rest of the bot's daily counts).
// ----------------------------------------------------------------------------
export const WIN_BARS = [1, 2, 5, 10, 20];

export class WinSizes {
  hour = WIN_BARS.map(() => 0);
  today = WIN_BARS.map(() => 0);
  todayUsd = WIN_BARS.map(() => 0); // money at each bar (sum of wins >= bar)
  private day: string;
  constructor(private readonly now: () => number = Date.now) { this.day = this.dayKey(); }
  private dayKey() { return new Date(this.now()).toISOString().slice(0, 10); }

  add(netUsd: number) {
    if (this.dayKey() !== this.day) { this.day = this.dayKey(); this.today = WIN_BARS.map(() => 0); this.todayUsd = WIN_BARS.map(() => 0); }
    WIN_BARS.forEach((bar, i) => {
      if (netUsd >= bar) { this.hour[i]++; this.today[i]++; this.todayUsd[i] += netUsd; }
    });
  }
  resetHour() { this.hour = WIN_BARS.map(() => 0); }
}
