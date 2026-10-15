import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';

// ============================================================================
// MONEY LEDGERS FOR THE HOURLY REPORT (Oct 15, owner approved, reporting only)
//
// Plain English:
//   The hourly Telegram report shows three money lines, each for the last
//   hour, today (Toronto calendar day) and the last 7 days:
//
//     Checked wins     practice wins confirmed by a free real-chain test,
//                      after gas. Today / 7 days come straight from the
//                      existing practice total (core/dryRunPnl.ts), so the
//                      report always matches the status page.
//     Could earn live  the part of those wins our own money could really
//                      take (starts in USDG/WETH, fits our own money, no
//                      loan). Today / 7 days come from core/realisticPnl.ts.
//     Real money made  confirmed REAL trades only (live mode), after the gas
//                      each one really paid. Gas burnt on failed (reverted)
//                      trades is kept apart and shown on its own line.
//
//   "Last hour" for all three is counted here: every win is added to a
//   running "this report period" counter, and the hourly report takes it
//   (reads and resets) once per report. That gives the exact numbers for the
//   report's own window, not a clock-hour guess. The period counter lives in
//   memory only: after a restart the report says the period is partial, so
//   a fresh counter is the honest number.
//
//   Real money has no other store that survives restarts (the live trade
//   log rotates), so it is kept here in hour buckets (one per UTC hour,
//   which always falls inside one Toronto day because Toronto is a whole
//   number of hours from UTC), saved to data/live-money.json after every
//   real result, at most 8 days kept (bounded file and memory).
//
//   Practice and live never mix: practice wins only ever go to the two
//   practice ledgers, and real results only to the real ledger (and only
//   when the caller says the result came from a real, live send).
//
// Never throws on disk problems: reporting must never affect trading.
// ============================================================================

// What a ledger reports for one line of the money table.
export interface LedgerRow { lastHour: number; today: number; week: number }

// One period's real-trade numbers (what the live-only line shows).
export interface RealPeriod {
  madeUsd: number;          // won trades: profit minus their own gas
  won: number;              // trades that landed and paid
  gasUsd: number;           // gas paid on every real trade (won and failed)
  failed: number;           // trades that reverted on chain (we paid gas, got nothing)
  failedCostUsd: number;    // gas burnt on those failed trades
}

// Biggest practice win in the period, for "Best win".
export interface BestWin { usd: number; label: string }

// The running counter for the current report period (memory only).
interface PeriodCounter {
  startMs: number;
  checkedUsd: number; checkedCount: number;
  couldEarnUsd: number; couldEarnCount: number;
  best: BestWin | null;
  real: RealPeriod;
}

// A real result as the live tracker reports it (execution/liveTracker.ts LiveResult).
export interface RealResultIn {
  status: 'profit' | 'reverted' | 'dropped';
  gasUsd: number;
  profitUsd?: number;       // undefined when the profit coin had no price
}

// One saved UTC-hour bucket of real money.
interface RealHour { madeUsd: number; won: number; gasUsd: number; failed: number; failedCostUsd: number }
interface RealState { version: 1; hours: Record<string, RealHour> }

const emptyReal = (): RealPeriod => ({ madeUsd: 0, won: 0, gasUsd: 0, failed: 0, failedCostUsd: 0 });
const num = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);
// Older or hand-edited files may miss fields: fill them so reading never breaks.
const fixHour = (h: any): RealHour => ({
  madeUsd: num(h?.madeUsd), won: num(h?.won), gasUsd: num(h?.gasUsd), failed: num(h?.failed), failedCostUsd: num(h?.failedCostUsd),
});

// ----------------------------------------------------------------------------
// REAL MONEY LEDGER: saved hour buckets of confirmed live trades.
// ----------------------------------------------------------------------------
export class RealMoneyLedger {
  static KEEP_HOURS = 8 * 24;   // 8 days of hour buckets (7-day total + spare)
  private state: RealState = { version: 1, hours: {} };

  constructor(
    private readonly file: string | null,
    private readonly tz = 'America/Toronto',
    private readonly now: () => number = Date.now,
  ) {
    if (file) {
      try {
        const s = JSON.parse(readFileSync(file, 'utf8'));
        if (s?.version === 1 && s.hours && typeof s.hours === 'object') {
          for (const [k, h] of Object.entries(s.hours)) if (/^\d+$/.test(k)) this.state.hours[k] = fixHour(h);
        }
      } catch { /* no file yet: start at zero */ }
    }
  }

  // Key of the UTC hour a time falls in (hours since 1970, as text).
  static hourKey(ms: number): string { return String(Math.floor(ms / 3_600_000)); }

  // Toronto calendar day of a time, e.g. 2026-10-15.
  dayKey(ms = this.now()): string { return new Date(ms).toLocaleDateString('en-CA', { timeZone: this.tz }); }

  // Adds one real result to its hour bucket. Returns what it added (for the
  // period counter), or null for junk numbers. Dropped trades cost nothing.
  add(r: RealResultIn): RealPeriod | null {
    const gas = num(r.gasUsd);
    if (gas < 0) return null;
    const d = emptyReal();
    if (r.status === 'profit') {
      d.won = 1; d.gasUsd = gas;
      // No price for the profit coin: we only know what we paid in gas.
      d.madeUsd = num(r.profitUsd) - gas;
    } else if (r.status === 'reverted') {
      d.failed = 1; d.gasUsd = gas; d.failedCostUsd = gas;
    } else return d; // dropped: never mined, no gas, nothing to add
    const k = RealMoneyLedger.hourKey(this.now());
    const h = (this.state.hours[k] ??= fixHour(null));
    h.madeUsd += d.madeUsd; h.won += d.won; h.gasUsd += d.gasUsd; h.failed += d.failed; h.failedCostUsd += d.failedCostUsd;
    this.trim();
    this.save();
    return d;
  }

  // Forget buckets older than KEEP_HOURS.
  private trim() {
    const oldest = Math.floor(this.now() / 3_600_000) - RealMoneyLedger.KEEP_HOURS;
    for (const k of Object.keys(this.state.hours)) if (Number(k) < oldest) delete this.state.hours[k];
  }

  // Sums of real money made (won trades, after their gas) for today
  // (Toronto) and the last 7 Toronto days including today.
  totals(): { today: number; week: number; todayPeriod: RealPeriod; weekPeriod: RealPeriod } {
    const todayKey = this.dayKey();
    const weekAgo = this.dayKey(this.now() - 6 * 86_400_000);
    const t = emptyReal(), w = emptyReal();
    for (const [k, h] of Object.entries(this.state.hours)) {
      // A UTC hour is inside one Toronto day; use its middle to be safe.
      const day = this.dayKey(Number(k) * 3_600_000 + 1_800_000);
      if (day < weekAgo || day > todayKey) continue;
      for (const into of day === todayKey ? [t, w] : [w]) {
        into.madeUsd += h.madeUsd; into.won += h.won; into.gasUsd += h.gasUsd; into.failed += h.failed; into.failedCostUsd += h.failedCostUsd;
      }
    }
    return { today: t.madeUsd, week: w.madeUsd, todayPeriod: t, weekPeriod: w };
  }

  hourCount(): number { return Object.keys(this.state.hours).length; }

  // Atomic write (temp file + rename). Tiny file, written only on a real result.
  save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file + '.tmp', JSON.stringify(this.state));
      renameSync(this.file + '.tmp', this.file);
    } catch { /* best effort: keep counting in memory */ }
  }
}

// ----------------------------------------------------------------------------
// THE THREE LEDGERS TOGETHER (what the hourly report reads).
// ----------------------------------------------------------------------------

// Read-only views of the existing practice day stores (so tests can pass fakes).
export interface PracticeDaySources {
  checked: () => { today: number; week: number };     // core/dryRunPnl.ts summary()
  couldEarn: () => { today: number; week: number };   // core/realisticPnl.ts summary()
}

// What the report gets from takePeriod().
export interface LedgerSnapshot {
  periodStartMs: number;
  periodEndMs: number;
  checked: LedgerRow;
  couldEarn: LedgerRow;
  real: LedgerRow;
  realPeriod: RealPeriod;   // this period's real-trade details (gas, failed trades)
  checkedCount: number;     // checked wins this period
  couldEarnCount: number;
  best: BestWin | null;     // biggest checked win this period
}

export class MoneyLedgers {
  // Same junk limit as the practice total (PNL_MAX_ONE_TRADE_USD, $2,000).
  static MAX_ONE_TRADE_USD = Number(process.env.PNL_MAX_ONE_TRADE_USD ?? 2_000);
  private period: PeriodCounter;

  constructor(
    private readonly practice: PracticeDaySources,
    readonly real: RealMoneyLedger,
    private readonly now: () => number = Date.now,
  ) {
    this.period = MoneyLedgers.freshPeriod(now());
  }

  private static freshPeriod(startMs: number): PeriodCounter {
    return { startMs, checkedUsd: 0, checkedCount: 0, couldEarnUsd: 0, couldEarnCount: 0, best: null, real: emptyReal() };
  }

  // A checked practice win, called right where the practice total counts it.
  // couldEarnLive: true when the live-realistic total counted it too.
  // Same guard as core/dryRunPnl.ts, so the two never disagree.
  notePracticeWin(usd: number, label: string, couldEarnLive: boolean) {
    if (!(usd > 0) || !Number.isFinite(usd) || usd > MoneyLedgers.MAX_ONE_TRADE_USD) return;
    const p = this.period;
    p.checkedUsd += usd; p.checkedCount++;
    if (couldEarnLive) { p.couldEarnUsd += usd; p.couldEarnCount++; }
    if (!p.best || usd > p.best.usd) p.best = { usd, label: String(label).slice(0, 60) };
  }

  // A confirmed real trade result. live must be true (the trade was really
  // sent with real money); anything else is ignored, so practice can never
  // add to "Real money made".
  noteRealResult(r: RealResultIn, live: boolean) {
    if (!live) return;
    const d = this.real.add(r);
    if (!d) return;
    const p = this.period.real;
    p.madeUsd += d.madeUsd; p.won += d.won; p.gasUsd += d.gasUsd; p.failed += d.failed; p.failedCostUsd += d.failedCostUsd;
  }

  // Read the current period without resetting it.
  peekPeriod(): LedgerSnapshot { return this.snapshot(this.now()); }

  // Read the current period and start a new one. Call ONCE per hourly report.
  takePeriod(): LedgerSnapshot {
    const end = this.now();
    const s = this.snapshot(end);
    this.period = MoneyLedgers.freshPeriod(end);
    return s;
  }

  private snapshot(end: number): LedgerSnapshot {
    const p = this.period;
    const c = this.practice.checked(), r = this.practice.couldEarn();
    const real = this.real.totals();
    return {
      periodStartMs: p.startMs, periodEndMs: end,
      checked: { lastHour: p.checkedUsd, today: c.today, week: c.week },
      couldEarn: { lastHour: p.couldEarnUsd, today: r.today, week: r.week },
      real: { lastHour: p.real.madeUsd, today: real.today, week: real.week },
      realPeriod: { ...p.real },
      checkedCount: p.checkedCount, couldEarnCount: p.couldEarnCount,
      best: p.best ? { ...p.best } : null,
    };
  }
}
