import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';

// ============================================================================
// DRY-RUN "WOULD HAVE EARNED" TRACKER
//
// Plain English:
//   While the bot runs without real money, this adds up what it WOULD have
//   made, in two separate buckets so the real number is never inflated:
//     verified   - profit confirmed by a free real-chain test of that exact
//                  trade (simulation on live pool code), minus gas. Trust this.
//     modelOnly  - trades the bot would have fired from its own maths alone,
//                  not (yet) confirmed by a test. Shown separately.
//   Both assume we WIN the race; the rival tracker says how often we would.
//   Saved to a small file so restarts and deploys don't reset it; days roll
//   over at midnight Toronto time.
// ============================================================================

export interface DayTotals {
  verifiedUsd: number;
  verifiedCount: number;
  modelUsd: number;
  modelCount: number;
  best?: { usd: number; label: string };
}

interface State { version: 1; days: Record<string, DayTotals> }

const emptyDay = (): DayTotals => ({ verifiedUsd: 0, verifiedCount: 0, modelUsd: 0, modelCount: 0 });

export class DryRunPnl {
  private state: State = { version: 1, days: {} };
  private dirty = false;

  constructor(
    private readonly file: string | null,
    private readonly tz = 'America/Toronto',
    private readonly now: () => number = Date.now,
  ) {
    if (file) {
      try {
        const s = JSON.parse(readFileSync(file, 'utf8'));
        if (s?.version === 1 && s.days && typeof s.days === 'object') this.state = s;
      } catch { /* no file yet: start at zero */ }
    }
  }

  // Calendar day in Toronto, e.g. 2026-10-05.
  dayKey(ms = this.now()): string {
    return new Date(ms).toLocaleDateString('en-CA', { timeZone: this.tz });
  }

  private today(): DayTotals {
    const k = this.dayKey();
    return (this.state.days[k] ??= emptyDay());
  }

  // Profit confirmed by a real-chain test (already net of gas). Ignores junk values.
  recordVerified(usd: number, label: string) {
    if (!(usd > 0) || !Number.isFinite(usd)) return;
    const d = this.today();
    d.verifiedUsd += usd;
    d.verifiedCount++;
    if (!d.best || usd > d.best.usd) d.best = { usd, label: label.slice(0, 60) };
    this.dirty = true;
  }

  // Would have fired from the model alone (not confirmed by a test).
  recordModelOnly(usd: number) {
    if (!(usd > 0) || !Number.isFinite(usd)) return;
    const d = this.today();
    d.modelUsd += usd;
    d.modelCount++;
    this.dirty = true;
  }

  // Totals for today, the last 7 days (including today), and since tracking began.
  summary() {
    const todayKey = this.dayKey();
    const weekAgo = this.dayKey(this.now() - 6 * 86_400_000);
    const sum = (filter: (k: string) => boolean) => {
      const t = emptyDay();
      let days = 0;
      for (const [k, d] of Object.entries(this.state.days)) {
        if (!filter(k)) continue;
        days++;
        t.verifiedUsd += d.verifiedUsd; t.verifiedCount += d.verifiedCount;
        t.modelUsd += d.modelUsd; t.modelCount += d.modelCount;
      }
      return { ...t, days };
    };
    return {
      today: { ...emptyDay(), ...(this.state.days[todayKey] ?? {}) },
      last7: sum((k) => k >= weekAgo && k <= todayKey),
      allTime: sum(() => true),
    };
  }

  // One line for logs and the hourly Telegram note.
  line(): string {
    const s = this.summary();
    const $ = (n: number) => `$${n.toFixed(2)}`;
    const best = s.today.best ? `, best ${$(s.today.best.usd)} ${s.today.best.label}` : '';
    return `would-have-earned today ${$(s.today.verifiedUsd)} verified (${s.today.verifiedCount} trades${best})` +
      `, ${$(s.today.modelUsd)} model-only (${s.today.modelCount}); 7 days ${$(s.last7.verifiedUsd)} verified`;
  }

  // Write to disk only when something changed (atomic: temp file + rename).
  save() {
    if (!this.file || !this.dirty) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file + '.tmp', JSON.stringify(this.state));
      renameSync(this.file + '.tmp', this.file);
      this.dirty = false;
    } catch { /* best effort: keep counting in memory */ }
  }
}
