// ============================================================================
// PROFIT BANDS -- how many checked trades would have made money, by size.
//
// Plain English:
//   "Would make $X" means little without knowing how often. This counts
//   every real-chain check that came back profitable (after our gas) into
//   the dollar bands from the Oct 8 spec:
//     1c-10c, 10c-50c, 50c-$1, $1-$5, $5-$10, $10-$20, $20+
//   Below 1 cent is counted separately as "dust". Kept per hour and per day.
// ============================================================================

// Lower edge of each band, in dollars (the last band has no top).
export const PROFIT_BAND_EDGES = [0.01, 0.10, 0.50, 1, 5, 10, 20];
export const PROFIT_BAND_LABELS = ['$0.01-$0.10', '$0.10-$0.50', '$0.50-$1', '$1-$5', '$5-$10', '$10-$20', '$20+'];

// Which band a net profit falls in (-1 = under 1 cent, i.e. dust or a loss).
export function bandOf(netUsd: number): number {
  let i = -1;
  for (let k = 0; k < PROFIT_BAND_EDGES.length; k++) if (netUsd >= PROFIT_BAND_EDGES[k]) i = k;
  return i;
}

export class ProfitBands {
  hour = PROFIT_BAND_EDGES.map(() => 0);
  day = PROFIT_BAND_EDGES.map(() => 0);
  hourUsd = 0;
  dayUsd = 0;
  hourDust = 0;
  private dayKey = '';

  // Add one profitable check (net of our gas). dayKey rolls the daily totals.
  add(netUsd: number, dayKey: string) {
    if (dayKey !== this.dayKey) { this.dayKey = dayKey; this.day = this.day.map(() => 0); this.dayUsd = 0; }
    const b = bandOf(netUsd);
    if (b < 0) { if (netUsd > 0) this.hourDust++; return; }
    this.hour[b]++; this.day[b]++;
    this.hourUsd += netUsd; this.dayUsd += netUsd;
  }

  // "1c-10c 4 · 10c-50c 2 · ..." (only non-empty bands), or null if none.
  static line(counts: number[]): string | null {
    const parts = counts.map((n, i) => (n ? `${PROFIT_BAND_LABELS[i]}: ${n}` : '')).filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  }

  resetHour() { this.hour = this.hour.map(() => 0); this.hourUsd = 0; this.hourDust = 0; }
}
