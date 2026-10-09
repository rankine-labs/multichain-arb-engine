// ============================================================================
// VENUE TALLY -- practice tests and wins per new exchange
//
// Plain English:
//   The owner wants to see WHICH of the new exchanges (Fables, Alandale,
//   GIGA CL, UP, SushiSwap and the other extra venues) actually earn in
//   practice. Every real-chain practice test whose route touches one of
//   those exchanges is counted here: one test, and a win when the test came
//   back profitable after our gas. A route through two new exchanges counts
//   for both. Kept for the current hour and for today (Toronto day; a restart
//   starts today's count again).
//
// Memory: only the exchange ids given to the constructor are ever counted
// (a fixed list from config/robinhoodVenues.ts), so the counters can never
// grow, however many pools or pairs those exchanges have.
// ============================================================================

export interface VenueCount { tests: number; wins: number; winUsd: number }

const zero = (): VenueCount => ({ tests: 0, wins: 0, winUsd: 0 });

export class VenueTally {
  private readonly ids: Set<string>;
  private hour = new Map<string, VenueCount>();
  private day = new Map<string, VenueCount>();
  private dayKey = '';

  // ids: the exchanges to count. nameOf: short display name for reports.
  constructor(ids: string[], private readonly nameOf: (id: string) => string = (id) => id) {
    this.ids = new Set(ids);
  }

  // One practice test of a route buy -> sell. winUsd: net profit after gas
  // when the test was a win (above 0), else leave it out. dayKey rolls the
  // daily counts (pass the Toronto date).
  add(buyDex: string, sellDex: string, dayKey: string, winUsd?: number): void {
    if (dayKey !== this.dayKey) { this.dayKey = dayKey; this.day.clear(); }
    const win = winUsd !== undefined && Number.isFinite(winUsd) && winUsd > 0;
    // A route on the same exchange both ways counts once for it.
    for (const id of new Set([buyDex, sellDex])) {
      if (!this.ids.has(id)) continue;
      for (const m of [this.hour, this.day]) {
        const c = m.get(id) ?? zero();
        c.tests++;
        if (win) { c.wins++; c.winUsd += winUsd!; }
        m.set(id, c);
      }
    }
  }

  // Counts for one exchange (tests).
  hourOf(id: string): VenueCount { return { ...(this.hour.get(id) ?? zero()) }; }
  dayOf(id: string): VenueCount { return { ...(this.day.get(id) ?? zero()) }; }
  size(): number { return Math.max(this.hour.size, this.day.size); }

  // Exchanges with any test this hour or today, best earners today first.
  private ranked(): string[] {
    return [...new Set([...this.hour.keys(), ...this.day.keys()])].sort((a, b) => {
      const x = this.day.get(a) ?? zero(), y = this.day.get(b) ?? zero();
      return y.winUsd - x.winUsd || y.wins - x.wins || y.tests - x.tests || a.localeCompare(b);
    });
  }

  // "Fables 4 tests, 1 win $0.42 (today 9, 2 wins $0.80)" per exchange.
  private parts(): string[] {
    return this.ranked().map((id) => {
      const h = this.hour.get(id) ?? zero(), d = this.day.get(id) ?? zero();
      const hw = h.wins ? `, ${h.wins} win${h.wins === 1 ? '' : 's'} $${h.winUsd.toFixed(2)}` : ', 0 wins';
      const dw = d.wins ? `, ${d.wins} win${d.wins === 1 ? '' : 's'} $${d.winUsd.toFixed(2)}` : '';
      return `${this.nameOf(id)} ${h.tests} test${h.tests === 1 ? '' : 's'}${hw} (today ${d.tests}${dw})`;
    });
  }

  // Telegram text for the hourly report (one short block), or null when
  // no new exchange was practice tested today.
  hourText(): string | null {
    const p = this.parts();
    if (!p.length) return null;
    return `<b>New exchanges, practice tests this hour</b>: ${p.join('; ')}`;
  }

  // One log line for the status page (deploy/status-report.js reads it).
  statusLine(): string {
    const p = this.parts();
    return `[venues] practice tests by exchange, last hour (today): ${p.length ? p.join('; ') : 'none on the new exchanges yet'}`;
  }

  resetHour(): void { this.hour.clear(); }
}
