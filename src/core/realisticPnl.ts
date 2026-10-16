import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';

// ============================================================================
// LIVE-REALISTIC "WOULD HAVE MADE" TOTAL (Oct 15, owner approved, measurement only)
//
// Plain English:
//   The normal practice total ("Today, checked", core/dryRunPnl.ts) is too
//   generous for our real-money start, for three reasons:
//     1. Many wins start and end in a coin we don't hold (e.g. ORBIO). The
//        practice checker pretends we have that coin. Live, our own money is
//        only USDG and WETH, so a trade can only start in one of those.
//     2. Practice sizes go up to $20,000. Our own money is capped (the
//        OWN_MONEY_MAX_USD setting, $2,000 by default).
//     3. Bigger practice trades borrow (a flash loan). Live is own money only.
//
//   This keeps a SECOND total that only adds a verified win when:
//     - it starts in a coin we hold (REALISTIC_START_COINS, default USDG and WETH)
//     - its size is at or under the own-money cap
//     - the check used no loan
//   Wins that fail are added to an "excluded" list by the FIRST rule they
//   break (start coin, then size, then loan), so each win lands in exactly
//   one place. It is called only where the normal total already counts a win,
//   so the outlier guard and the "count a gap once" rule are already applied.
//
//   Reporting only: it never decides which trades are checked or sent.
//   Saved to a small file like the normal total; days roll over at midnight
//   Toronto time; only the last 30 days are kept (small file, bounded memory).
// ============================================================================

// Why a win was left out of the live-realistic total.
// 'venue' (Oct 16): a pool on an exchange or pool type live trading refuses
// (practice-only venues, non-standard V4 settings), so live could not take it.
export type ExcludeReason = 'otherCoin' | 'venue' | 'overSize' | 'loan';

// What we know about one verified win.
export interface WinFacts {
  startToken: string;       // the coin the trade starts and ends in (profit coin)
  sizeUsd: number;          // trade size in dollars
  lender?: string;          // loan pool address, or undefined for own money
  // Set when a pool in the trade is one live trading refuses (the reason,
  // e.g. "exchange not cleared for trading"). Unset = both pools tradable.
  notLive?: string;
}

export interface RealisticConfig {
  startCoins: Set<string>;  // lowercase addresses we can really start from
  ownMaxUsd: number;        // own-money cap per trade, in dollars
  startLabel?: string;      // how the start coins are named in the report (default "USDG/WETH")
}

// The rule check on its own (no saving), so it is easy to test.
// Returns 'ok' or the first rule the win breaks.
export function realisticVerdict(w: WinFacts, cfg: RealisticConfig): 'ok' | ExcludeReason {
  if (!cfg.startCoins.has(String(w.startToken).toLowerCase())) return 'otherCoin';
  if (w.notLive) return 'venue';
  // A missing or broken size is treated as "too big" (never counts as realistic).
  if (!(w.sizeUsd > 0) || !Number.isFinite(w.sizeUsd) || w.sizeUsd > cfg.ownMaxUsd) return 'overSize';
  if (w.lender) return 'loan';
  return 'ok';
}

// Reads REALISTIC_START_COINS (comma-separated addresses). Empty or unset:
// the default coins passed in (USDG and WETH). Bad entries are ignored.
export function readStartCoins(raw: string | undefined, defaults: string[]): Set<string> {
  const list = (raw ?? '').split(',').map((t) => t.trim()).filter((t) => /^0x[0-9a-fA-F]{40}$/.test(t));
  return new Set((list.length ? list : defaults).map((t) => t.toLowerCase()));
}

interface Bucket { usd: number; n: number }
export interface RealisticDay {
  usd: number;              // counted (live-realistic) dollars
  count: number;            // counted wins
  excluded: Record<ExcludeReason, Bucket>;
}
interface State { version: 1; days: Record<string, RealisticDay> }

const emptyDay = (): RealisticDay => ({
  usd: 0, count: 0,
  excluded: { otherCoin: { usd: 0, n: 0 }, venue: { usd: 0, n: 0 }, overSize: { usd: 0, n: 0 }, loan: { usd: 0, n: 0 } },
});
// Older or hand-edited files may miss fields: fill them in so reading never breaks.
const fixDay = (d: any): RealisticDay => {
  const e = emptyDay();
  if (!d || typeof d !== 'object') return e;
  const num = (x: any) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  e.usd = num(d.usd); e.count = num(d.count);
  for (const k of ['otherCoin', 'venue', 'overSize', 'loan'] as ExcludeReason[]) {
    e.excluded[k] = { usd: num(d.excluded?.[k]?.usd), n: num(d.excluded?.[k]?.n) };
  }
  return e;
};

export class RealisticPnl {
  // Same junk limit as the normal total (PNL_MAX_ONE_TRADE_USD, $2,000).
  static MAX_ONE_TRADE_USD = Number(process.env.PNL_MAX_ONE_TRADE_USD ?? 2_000);
  static KEEP_DAYS = 30;
  private state: State = { version: 1, days: {} };
  private dirty = false;

  constructor(
    private readonly file: string | null,
    readonly cfg: RealisticConfig,
    private readonly tz = 'America/Toronto',
    private readonly now: () => number = Date.now,
  ) {
    if (file) {
      try {
        const s = JSON.parse(readFileSync(file, 'utf8'));
        if (s?.version === 1 && s.days && typeof s.days === 'object') {
          for (const [k, d] of Object.entries(s.days)) this.state.days[k] = fixDay(d);
        }
      } catch { /* no file yet: start at zero */ }
    }
  }

  // Calendar day in Toronto, e.g. 2026-10-15.
  dayKey(ms = this.now()): string {
    return new Date(ms).toLocaleDateString('en-CA', { timeZone: this.tz });
  }

  private today(): RealisticDay {
    const k = this.dayKey();
    if (!this.state.days[k]) {
      this.state.days[k] = emptyDay();
      // New day: forget days older than KEEP_DAYS (bounded file and memory).
      const oldest = this.dayKey(this.now() - RealisticPnl.KEEP_DAYS * 86_400_000);
      for (const key of Object.keys(this.state.days)) if (key < oldest) delete this.state.days[key];
    }
    return this.state.days[k];
  }

  // A verified win that the normal total just counted. usd is the amount the
  // normal total added (already net of gas, already only the "new" part of a
  // re-checked gap). Returns where it went, or null if it was junk.
  record(usd: number, win: WinFacts): 'ok' | ExcludeReason | null {
    if (!(usd > 0) || !Number.isFinite(usd) || usd > RealisticPnl.MAX_ONE_TRADE_USD) return null;
    const v = realisticVerdict(win, this.cfg);
    const d = this.today();
    if (v === 'ok') { d.usd += usd; d.count++; }
    else { d.excluded[v].usd += usd; d.excluded[v].n++; }
    this.dirty = true;
    return v;
  }

  // Today, and the last 7 days including today.
  summary() {
    const todayKey = this.dayKey();
    const weekAgo = this.dayKey(this.now() - 6 * 86_400_000);
    let weekUsd = 0, weekCount = 0;
    for (const [k, d] of Object.entries(this.state.days)) {
      if (k < weekAgo || k > todayKey) continue;
      weekUsd += d.usd; weekCount += d.count;
    }
    return { today: fixDay(this.state.days[todayKey]), weekUsd, weekCount };
  }

  // Report lines (Telegram hourly and the [pnl-real] log line for the status page).
  // Line 1: the live-realistic total. Line 2: what was left out today and why.
  lines(): [string, string] {
    const s = this.summary();
    const $ = (n: number) => `$${n.toFixed(2)}`;
    const cap = `$${Math.round(this.cfg.ownMaxUsd).toLocaleString('en-US')}`;
    const e = s.today.excluded;
    return [
      `live-realistic (${this.cfg.startLabel ?? 'USDG/WETH'} start, own money <= ${cap}, no loan): today ${$(s.today.usd)} from ${s.today.count}, 7 days ${$(s.weekUsd)}`,
      `left out today: started in another coin ${$(e.otherCoin.usd)} (${e.otherCoin.n}), exchange not live yet ${$(e.venue.usd)} (${e.venue.n}), over own-money size ${$(e.overSize.usd)} (${e.overSize.n}), needed a loan ${$(e.loan.usd)} (${e.loan.n})`,
    ];
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
