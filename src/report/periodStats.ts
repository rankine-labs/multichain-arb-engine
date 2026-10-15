import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';

// ============================================================================
// 4-HOUR TOTALS FROM THE HOURLY REPORT (Oct 15, owner approved, reporting only)
//
// Plain English:
//   The hourly report (src/report/hourlyReport.ts) works out one hour's
//   numbers. Each hour it also hands them to this accumulator, which adds
//   them into a running "since the last 4-hour report" bucket. The 4-hour
//   report (built separately) reads that bucket and starts a new one. The
//   bucket is saved to data/period-stats.json after every add, so a restart
//   or deploy does not lose the hours already added.
//
// API for the 4-hour report (stable, please keep it this way):
//
//   import { PeriodStats } from '../report/periodStats';
//   const stats = new PeriodStats('data/period-stats.json');   // one shared instance
//
//   stats.add(hour: HourNumbers)   called by the hourly report, once per hour.
//                                  Do NOT call it from the 4-hour report.
//   stats.peek(): PeriodTotals     the bucket so far, nothing reset.
//   stats.take(): PeriodTotals     the bucket so far, then a fresh empty
//                                  bucket starts (call ONCE per 4-hour report).
//
//   PeriodTotals has: fromMs / toMs (first hour's start, last hour's end,
//   null when empty), hours (how many hourly reports were added), and the
//   summed numbers below. "n/a" rule: a count is null when NO hour in the
//   bucket measured it (for example the loop trader was off all along);
//   if at least one hour measured it, it is the sum of the measured hours
//   and measuredHours says how many.
//
//   In shadowMain.ts the shared instance is called `periodStats`; the
//   hourly report adds to it whether or not REPORT_V2 is on.
//
// Every number is a plain sum of the hourly numbers, so the 4-hour report
// always agrees with the four hourly reports it covers.
// ============================================================================

// A "wins out of tested" pair. null = not measured that hour.
export interface WinsTested { won: number; tested: number }

// One hour's numbers (exactly what that hour's report showed).
export interface HourNumbers {
  fromMs: number;                 // start of the hour's report window
  toMs: number;                   // end of the hour's report window
  money: {
    checkedUsd: number;           // Checked wins, this hour
    couldEarnUsd: number;         // Could earn live, this hour
    realUsd: number;              // Real money made, this hour (0 in practice)
    gasUsd: number;               // real gas paid (live only, else 0)
    failedTrades: number;         // real trades that reverted (live only)
    failedCostUsd: number;        // gas burnt on them
  };
  normal: WinsTested | null;      // 2-pool trades checked / won
  loop: WinsTested | null;        // loop trades checked / won (null when the loop trader is off)
  races: { won: number; lost: number } | null;
  best: { usd: number; label: string } | null;  // biggest checked win this hour
}

// What the 4-hour report reads.
export interface PeriodTotals {
  fromMs: number | null;
  toMs: number | null;
  hours: number;
  money: HourNumbers['money'];
  normal: (WinsTested & { measuredHours: number }) | null;
  loop: (WinsTested & { measuredHours: number }) | null;
  races: { won: number; lost: number; measuredHours: number } | null;
  best: { usd: number; label: string } | null;
}

interface State { version: 1; totals: PeriodTotals }

const emptyTotals = (): PeriodTotals => ({
  fromMs: null, toMs: null, hours: 0,
  money: { checkedUsd: 0, couldEarnUsd: 0, realUsd: 0, gasUsd: 0, failedTrades: 0, failedCostUsd: 0 },
  normal: null, loop: null, races: null, best: null,
});

const n = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);

// Older or hand-edited files may miss fields: rebuild safely.
function fixTotals(t: any): PeriodTotals {
  const e = emptyTotals();
  if (!t || typeof t !== 'object') return e;
  e.fromMs = Number.isFinite(t.fromMs) ? t.fromMs : null;
  e.toMs = Number.isFinite(t.toMs) ? t.toMs : null;
  e.hours = n(t.hours);
  for (const k of Object.keys(e.money) as (keyof PeriodTotals['money'])[]) e.money[k] = n(t.money?.[k]);
  const wt = (x: any) => (x && typeof x === 'object' ? { won: n(x.won), tested: n(x.tested), measuredHours: n(x.measuredHours) } : null);
  e.normal = wt(t.normal); e.loop = wt(t.loop);
  e.races = t.races && typeof t.races === 'object' ? { won: n(t.races.won), lost: n(t.races.lost), measuredHours: n(t.races.measuredHours) } : null;
  e.best = t.best && Number.isFinite(t.best.usd) ? { usd: t.best.usd, label: String(t.best.label ?? '').slice(0, 60) } : null;
  return e;
}

export class PeriodStats {
  private state: State = { version: 1, totals: emptyTotals() };

  constructor(private readonly file: string | null) {
    if (file) {
      try {
        const s = JSON.parse(readFileSync(file, 'utf8'));
        if (s?.version === 1) this.state.totals = fixTotals(s.totals);
      } catch { /* no file yet: start empty */ }
    }
  }

  // Add one hour (called by the hourly report only). Saved right away.
  add(h: HourNumbers) {
    const t = this.state.totals;
    t.fromMs = t.fromMs === null ? h.fromMs : Math.min(t.fromMs, h.fromMs);
    t.toMs = t.toMs === null ? h.toMs : Math.max(t.toMs, h.toMs);
    t.hours++;
    for (const k of Object.keys(t.money) as (keyof PeriodTotals['money'])[]) t.money[k] += n(h.money[k]);
    const addWT = (into: PeriodTotals['normal'], x: WinsTested | null) => {
      if (!x) return into;
      const base = into ?? { won: 0, tested: 0, measuredHours: 0 };
      return { won: base.won + n(x.won), tested: base.tested + n(x.tested), measuredHours: base.measuredHours + 1 };
    };
    t.normal = addWT(t.normal, h.normal);
    t.loop = addWT(t.loop, h.loop);
    if (h.races) {
      const b = t.races ?? { won: 0, lost: 0, measuredHours: 0 };
      t.races = { won: b.won + n(h.races.won), lost: b.lost + n(h.races.lost), measuredHours: b.measuredHours + 1 };
    }
    if (h.best && (!t.best || h.best.usd > t.best.usd)) t.best = { usd: h.best.usd, label: String(h.best.label).slice(0, 60) };
    this.save();
  }

  // The bucket so far (a copy; nothing reset).
  peek(): PeriodTotals { return fixTotals(JSON.parse(JSON.stringify(this.state.totals))); }

  // The bucket so far, then start a fresh one (once per 4-hour report).
  take(): PeriodTotals {
    const out = this.peek();
    this.state.totals = emptyTotals();
    this.save();
    return out;
  }

  // Atomic write (temp file + rename). Tiny file, written once an hour.
  save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file + '.tmp', JSON.stringify(this.state));
      renameSync(this.file + '.tmp', this.file);
    } catch { /* best effort */ }
  }
}
