import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';

// ============================================================================
// OTHER STABLECOINS COUNTER (Oct 15, owner approved, measurement only)
//
// Plain English:
//   Our own money is USDG and WETH. Other dollar coins trade on this chain
//   too: aUSD, UUSD and USDe. Before deciding whether to hold any of them,
//   the owner wants to know how much opportunity touches them. Per coin, per
//   Toronto day, this counts:
//     - gaps seen:  standing gaps (from the gap scanner's own maths, "model")
//                   on a pair that includes the coin. A gap counts once when
//                   it first appears; it counts again only after it closed.
//     - model $:    the scanner's estimated profit for those gaps, at first sight
//     - wins:       verified wins on a pair with the coin (same wins the
//                   normal practice total counts), and their dollars
//     - started here: how many of those wins were tested starting from that
//                   coin (rather than from the other coin of the pair)
//
//   Where the addresses come from: the repo has no Robinhood addresses for
//   these coins, so they are taken at runtime from the verified coin groups
//   ("Dollars" group, core/tokenGroups.ts: deep pool + price near $1, so a
//   fake coin with the same name can't sneak in). OTHER_STABLES in .env can
//   set them by hand, e.g. "aUSD:0xabc...,UUSD:0xdef...".
//
//   Cheap: only looks at results already in memory, no extra node requests.
//   Bounded: a fixed list of 3 coins, at most 2,000 open gaps remembered,
//   9 days kept in the saved file. Reporting only: never changes trading.
// ============================================================================

export const OTHER_STABLE_NAMES = ['aUSD', 'UUSD', 'USDe'] as const;
export type StableName = typeof OTHER_STABLE_NAMES[number];

// Which of the three coins a symbol is (ignores upper/lower case). null = none.
export function matchStableName(symbol: string | undefined | null): StableName | null {
  const u = String(symbol ?? '').trim().toUpperCase();
  return OTHER_STABLE_NAMES.find((n) => n.toUpperCase() === u) ?? null;
}

// Reads OTHER_STABLES ("aUSD:0x...,UUSD:0x..."). Bad entries are ignored.
export function parseStableEnv(raw: string | undefined): Map<string, StableName> {
  const out = new Map<string, StableName>();
  for (const part of (raw ?? '').split(',')) {
    const [name, addr] = part.split(':').map((x) => x.trim());
    const n = matchStableName(name);
    if (n && /^0x[0-9a-fA-F]{40}$/.test(addr ?? '')) out.set(addr.toLowerCase(), n);
  }
  return out;
}

export interface StableRow {
  gaps: number; modelUsd: number;     // gaps seen (model stage) and their estimated profit
  wins: number; winUsd: number;       // verified wins and their dollars
  startedHere: number;                // wins tested starting from this coin
}
type DayRows = Partial<Record<StableName, StableRow>>;
interface State { version: 1; days: Record<string, DayRows> }

const emptyRow = (): StableRow => ({ gaps: 0, modelUsd: 0, wins: 0, winUsd: 0, startedHere: 0 });
const num = (x: any) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const fixRow = (r: any): StableRow => ({ gaps: num(r?.gaps), modelUsd: num(r?.modelUsd), wins: num(r?.wins), winUsd: num(r?.winUsd), startedHere: num(r?.startedHere) });

// One gap from the scanner, as this counter needs it.
export interface GapSeen { key: string; tokens: [string, string]; modelUsd: number }

export class StableTally {
  static KEEP_DAYS = 9;
  // Same junk limit as the practice totals.
  static MAX_ONE_TRADE_USD = Number(process.env.PNL_MAX_ONE_TRADE_USD ?? 2_000);
  private readonly addrs = new Map<string, StableName>();   // lowercase address -> coin
  private readonly fromEnv = new Set<string>();             // addresses set by hand (never overwritten)
  private readonly open = new Set<string>();                // gaps currently open (already counted)
  private state: State = { version: 1, days: {} };
  private dirty = false;

  constructor(
    private readonly file: string | null,
    private readonly tz = 'America/Toronto',
    private readonly now: () => number = Date.now,
    private readonly maxOpen = 2_000,
  ) {
    if (file) {
      try {
        const s = JSON.parse(readFileSync(file, 'utf8'));
        if (s?.version === 1 && s.days && typeof s.days === 'object') {
          for (const [k, rows] of Object.entries(s.days as Record<string, any>)) {
            const d: DayRows = {};
            for (const n of OTHER_STABLE_NAMES) if (rows?.[n]) d[n] = fixRow(rows[n]);
            this.state.days[k] = d;
          }
        }
      } catch { /* no file yet: start at zero */ }
    }
  }

  dayKey(ms = this.now()): string {
    return new Date(ms).toLocaleDateString('en-CA', { timeZone: this.tz });
  }

  // Addresses set by hand (OTHER_STABLES). These win over the coin groups.
  setFromEnv(map: Map<string, StableName>) {
    for (const [a, n] of map) { this.addrs.set(a.toLowerCase(), n); this.fromEnv.add(a.toLowerCase()); }
  }

  // Addresses from the verified coin groups (only members of the "Dollars" group).
  addFromGroups(members: { token: string; symbol: string; group: string }[] | undefined | null) {
    for (const m of members ?? []) {
      if (m?.group !== 'Dollars') continue;
      const n = matchStableName(m.symbol);
      const a = String(m.token ?? '').toLowerCase();
      if (n && /^0x[0-9a-f]{40}$/.test(a) && !this.fromEnv.has(a)) this.addrs.set(a, n);
    }
  }

  // Which of the three coins is in this pair (first one found), or null.
  stableIn(tokens: string[]): StableName | null {
    for (const t of tokens) { const n = this.addrs.get(String(t).toLowerCase()); if (n) return n; }
    return null;
  }

  // Coins whose address we know (for the report).
  knownNames(): Set<StableName> { return new Set(this.addrs.values()); }

  private row(n: StableName): StableRow {
    const k = this.dayKey();
    if (!this.state.days[k]) {
      this.state.days[k] = {};
      const oldest = this.dayKey(this.now() - StableTally.KEEP_DAYS * 86_400_000);
      for (const key of Object.keys(this.state.days)) if (key < oldest) delete this.state.days[key];
    }
    return (this.state.days[k][n] ??= emptyRow());
  }

  // One gap scan's results. Counts gaps on our three coins the first time
  // they appear, and forgets gaps that are gone (so a reopened gap counts again).
  noteGaps(gaps: GapSeen[]) {
    if (!this.addrs.size) return;
    const now = new Set<string>();
    for (const g of gaps) {
      const n = this.stableIn(g.tokens);
      if (!n) continue;
      now.add(g.key);
      if (this.open.has(g.key)) continue;
      if (this.open.size >= this.maxOpen) this.open.clear(); // memory guard
      this.open.add(g.key);
      const r = this.row(n);
      r.gaps++;
      if (g.modelUsd > 0 && Number.isFinite(g.modelUsd) && g.modelUsd <= StableTally.MAX_ONE_TRADE_USD) r.modelUsd += g.modelUsd;
      this.dirty = true;
    }
    for (const k of [...this.open]) if (!now.has(k)) this.open.delete(k);
  }

  // A verified win the practice total just counted (usd = what it added).
  noteWin(tokens: [string, string], startToken: string, usd: number) {
    if (!(usd > 0) || !Number.isFinite(usd) || usd > StableTally.MAX_ONE_TRADE_USD) return;
    const n = this.stableIn(tokens);
    if (!n) return;
    const r = this.row(n);
    r.wins++; r.winUsd += usd;
    if (this.addrs.get(String(startToken).toLowerCase()) === n) r.startedHere++;
    this.dirty = true;
  }

  today(): Record<StableName, StableRow> {
    const d = this.state.days[this.dayKey()] ?? {};
    return { aUSD: fixRow(d.aUSD), UUSD: fixRow(d.UUSD), USDe: fixRow(d.USDe) };
  }

  // "Other stables (today): aUSD gaps 3 ($4.10 model), wins 1 ($2.00, 0 started in aUSD) · ..."
  line(): string {
    const t = this.today();
    const known = this.knownNames();
    const $ = (n: number) => `$${n.toFixed(2)}`;
    const parts = OTHER_STABLE_NAMES.map((n) => {
      if (!known.has(n)) return `${n} address not known yet`;
      const r = t[n];
      return `${n} gaps ${r.gaps} (${$(r.modelUsd)} model), wins ${r.wins} (${$(r.winUsd)}, ${r.startedHere} started in ${n})`;
    });
    return `Other stables (today): ${parts.join(' · ')}`;
  }

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
