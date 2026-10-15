import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';
import type { LoopHour } from '../core/loopTrader';

// ============================================================================
// FOUR-HOUR STATS (reporting only)
//
// Plain English:
//   The 4-hour Telegram report needs everything the old hourly report showed,
//   added up over 4 hours. Many of the hourly numbers are counters that the
//   hourly code reads and then sets back to zero ("take the hour"). Reading
//   them twice would lose numbers, so the hourly code hands us ONE copy of
//   each hour's numbers (an HourSample) right when it takes them, and we
//   keep them here until the 4-hour report is sent.
//
//   MONEY comes from the same ledgers as the hourly report (Oct 15 merge):
//   each HourSample carries `money` (src/report/ledgers.ts hourMoneyOf of
//   that collection's takePeriod()), so Checked wins, Could earn live, Real
//   money made and best win in the 4-hour report are exactly the sums of the
//   hourly collections (trades tested / won and races come from the same
//   hour samples too). In shadowMain that is the only money input. noteWin
//   below still works for callers without the hourly ledger (tests); do not
//   use both for the same wins.
//
//   Other inputs arrive as they happen:
//     noteWin             a checked practice win (see the note above)
//     noteOutlierBlocked  a "too good to be true" win the outlier guard refused
//     noteTest            every practice test, by pool kind (V2/V3/V4), for
//                         the parts check
//
//   Everything is saved to data/report-4h.json (small, bounded: at most
//   MAX_HOURS hour samples, a few short lists) so a restart does not wipe the
//   numbers collected so far. The file also remembers which 4-hour report
//   was sent last, so a restart never sends the same report twice.
//
//   Nothing in here touches trading, checks or sending. All methods are
//   cheap, never throw on bad input, and never wait on anything.
// ============================================================================

// How a checked win counts for "could earn live" (same words as core/realisticPnl.ts).
export type LiveVerdict = 'ok' | 'otherCoin' | 'overSize' | 'loan';

export interface Bucket { n: number; usd: number }

// One stage of "where the time goes" for one hour (ms).
export interface StageSample { n: number; median: number | null; p95: number | null }

// Loop numbers for one hour (from the loop trader's hour, see core/loopTrader.ts LoopHour).
export interface LoopSample {
  found: number; bestUsd: number; checked: number; wouldMake: number; wouldMakeUsd: number;
  lost: number; failed: number; cantRun: number; skippedCap: number;
  foundByLen: number[];               // index = number of pools
  mvcN: number; modelUsd: number; checkUsd: number; // model vs real test (profit before gas)
  rivalLoops: number; rivalLonger: number;
  nodeRateLimited: number | null; nodePaused: number | null; nodeBusySkips: number | null;
  nodeText: string;                   // the loop node line as the hourly report shows it
  topRoutes: { label: string; n: number; bestUsd: number }[];
}

// One collection's money, from the hourly money ledgers (report/ledgers.ts).
export interface HourMoney {
  checkedUsd: number; checkedCount: number;      // Checked wins
  couldEarnUsd: number; couldEarnCount: number;  // Could earn live
  leftOut: Record<'otherCoin' | 'overSize' | 'loan', Bucket>; // left out of Could earn live
  best: { usd: number; label: string } | null;   // biggest checked win
  realUsd: number;                               // Real money made: true account change (won profit minus all gas)
  realWon: number;                               // real trades that landed and paid
  gasUsd: number;                                // real gas paid (won and failed)
  failed: number;                                // real trades that reverted
  failedCostUsd: number;                         // gas burnt on them
}

// One hour of the old hourly report's numbers. Every field is a plain count
// or measurement for that hour only (never a running total).
export interface HourSample {
  fromMs: number; toMs: number;
  funnel: {
    tradesRead: number; noPool: number; tooSmall: number; noPartner: number; noUsdPrice: number;
    smallerThanFees: number; found: number; belowCheckBar: number; notVetted: number; sentToCheck: number;
  };
  checkBarUsd: number;
  checks: { done: number; makeMoney: number; loseMoney: number; wouldFail: number; tooLate: number; nodeBusy: number };
  timing: { rightAfter: number; othersInBlock: number; late: number };
  benchedRoutes: number;              // a level, not a count: the last hour's value is shown
  checksAvailable: boolean;
  race: { won: number; lost: number; unclear: number; wonUsd: number; lostUsd: number } | null;
  reaction: { n: number; medianMs: number | null; p95Ms: number | null };
  stages: Record<string, StageSample>;
  stalls: { enabled: boolean; thresholdMs: number; freezes: number; worstMs: number; causes: [string, number, number][]; gcN: number; gcMs: number } | null;
  rivalsSpeed: { timed: number; theirMs: number | null; oursMs: number | null; weBeat: number } | null;
  loops: LoopSample | null;
  venues: [string, number, number, number][]; // [exchange name, tests, wins, win $]
  live: { sent: number; won: number; profitUsd: number; gasUsd: number };
  feedDrops: number;
  money?: HourMoney;                  // from the hourly money ledgers (missing in older files)
}

// The 4-hour totals the report is built from.
export interface PeriodTotals {
  fromMs: number;          // when counting started for this period
  toMs: number;
  coveredMs: number;       // time covered by hour samples (less than toMs - fromMs after a restart)
  restarts: number;        // bot restarts seen during this period
  hours: number;           // hour samples added
  wins: { n: number; usd: number; best: { usd: number; label: string } | null; liveOk: Bucket; leftOut: Record<'otherCoin' | 'overSize' | 'loan', Bucket> };
  outliers: { n: number; biggestUsd: number };
  testsByKind: Record<string, { tests: number; wins: number }>;
  funnel: HourSample['funnel'];
  checkBarUsd: number;
  checks: HourSample['checks'];
  timing: HourSample['timing'];
  benchedRoutes: number | null;
  checksAvailable: boolean | null;   // false if any hour had no checking node at all
  race: { won: number; lost: number; unclear: number; wonUsd: number; lostUsd: number; hours: number };
  reaction: { usualMs: number | null; slowestMs: number | null };
  stages: Record<string, { n: number; usualMs: number | null; slowestMs: number | null }>;
  stalls: { measured: boolean; enabled: boolean; thresholdMs: number; freezes: number; worstMs: number; causes: [string, number, number][]; gcMs: number; gcN: number; gcPct: number | null };
  rivalsSpeed: { timed: number; theirMs: number | null; oursMs: number | null; weBeat: number };
  loops: (Omit<LoopSample, 'nodeText' | 'topRoutes' | 'bestUsd'> & { bestUsd: number; nodeText: string; topRoutes: LoopSample['topRoutes']; hours: number }) | null;
  venues: [string, number, number, number][];
  live: HourSample['live'];
  // Real money from the hourly ledgers (same numbers as the hourly reports).
  money: { realUsd: number; realWon: number; gasUsd: number; failed: number; failedCostUsd: number };
  feedDrops: number;
}

export const MAX_HOURS = 12;          // hour samples kept per period (4 normally, more if hourly runs extra)
const MAX_CAUSES = 12, MAX_ROUTES = 6, MAX_VENUES = 20, MAX_COUNTERS = 40;

interface PeriodState {
  fromMs: number;
  restarts: number;
  wins: { n: number; usd: number; best: { usd: number; label: string } | null; liveOk: Bucket; leftOut: Record<'otherCoin' | 'overSize' | 'loan', Bucket> };
  outliers: { n: number; biggestUsd: number };
  testsByKind: Record<string, { tests: number; wins: number }>;
  hours: HourSample[];
}
interface FileState {
  version: 1;
  current: PeriodState;
  prev: { usd: number; n: number } | null; // last sent period's checked wins (for the ▲/▼ line)
  lastSentKey: string;                      // e.g. "2026-10-15T16" (Toronto), never sent twice
  counters: Record<string, number>;         // last running totals seen by delta()
}

const zb = (): Bucket => ({ n: 0, usd: 0 });
const emptyPeriod = (fromMs: number): PeriodState => ({
  fromMs, restarts: 0,
  wins: { n: 0, usd: 0, best: null, liveOk: zb(), leftOut: { otherCoin: zb(), overSize: zb(), loan: zb() } },
  outliers: { n: 0, biggestUsd: 0 },
  testsByKind: {},
  hours: [],
});
const fin = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

// Weighted typical value from per-hour medians (weight = samples that hour).
// Not a true 4-hour median (the raw samples are gone), but close and honest.
function weightedUsual(xs: { n: number; v: number | null }[]): number | null {
  let w = 0, s = 0;
  for (const x of xs) if (x.v !== null && Number.isFinite(x.v) && x.n > 0) { w += x.n; s += x.n * x.v; }
  return w > 0 ? s / w : null;
}
// Slowest = the worst hourly slow-5% figure.
function worst(xs: (number | null)[]): number | null {
  const ok = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return ok.length ? Math.max(...ok) : null;
}

// Reads "rate limited 3", "paused 1", "skipped node busy 2" out of the loop
// node line (core/loopNode.ts loopNodeText). null = not in the line.
export function parseLoopNode(text: string): { rateLimited: number | null; paused: number | null; busySkips: number | null } {
  const num = (re: RegExp) => { const m = re.exec(text); return m ? Number(m[1]) : null; };
  const busy = num(/skipped node busy (\d+)/);
  const hasNumbers = /rate limited \d+/.test(text);
  return { rateLimited: num(/rate limited (\d+)/), paused: num(/paused (\d+)/), busySkips: busy ?? (hasNumbers ? 0 : null) };
}

// Turns the loop trader's hour (and its node line) into a LoopSample.
export function loopSampleFrom(h: LoopHour, nodeText: string): LoopSample {
  const rows = h.checkVsEstimate?.modelVsCheck ?? [];
  const node = parseLoopNode(nodeText ?? '');
  return {
    found: fin(h.found), bestUsd: fin(h.bestUsd), checked: fin(h.checked), wouldMake: fin(h.wouldMake), wouldMakeUsd: fin(h.wouldMakeUsd),
    lost: fin(h.lost), failed: fin(h.failed), cantRun: fin(h.cantRun), skippedCap: fin(h.skippedCap),
    foundByLen: (h.foundByLen ?? []).map(fin),
    mvcN: rows.reduce((s, r) => s + fin(r.n), 0), modelUsd: rows.reduce((s, r) => s + fin(r.modelUsd), 0), checkUsd: rows.reduce((s, r) => s + fin(r.checkUsd), 0),
    rivalLoops: fin(h.rival?.loops), rivalLonger: fin(h.rival?.longer),
    nodeRateLimited: node.rateLimited, nodePaused: node.paused, nodeBusySkips: node.busySkips,
    nodeText: (nodeText ?? '').slice(0, 200),
    topRoutes: (h.topRoutes ?? []).slice(0, 3).map((r) => ({ label: String(r.label).slice(0, 80), n: fin(r.n), bestUsd: fin(r.bestUsd) })),
  };
}

export class FourHourStats {
  private s: FileState;
  private dirty = false;

  constructor(private readonly file: string | null, private readonly now: () => number = Date.now) {
    this.s = { version: 1, current: emptyPeriod(now()), prev: null, lastSentKey: '', counters: {} };
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (raw?.version === 1 && raw.current && Array.isArray(raw.current.hours)) {
        const c = raw.current as PeriodState;
        this.s = {
          version: 1,
          current: {
            ...emptyPeriod(fin(c.fromMs) || now()),
            ...c,
            hours: c.hours.slice(-MAX_HOURS),
            // Loaded from the file = the bot was restarted during this period.
            restarts: fin(c.restarts) + 1,
          },
          prev: raw.prev && Number.isFinite(raw.prev.usd) ? { usd: raw.prev.usd, n: fin(raw.prev.n) } : null,
          lastSentKey: typeof raw.lastSentKey === 'string' ? raw.lastSentKey : '',
          counters: raw.counters && typeof raw.counters === 'object' ? raw.counters : {},
        };
        this.dirty = true;
      }
    } catch { /* no file yet, or unreadable: start fresh */ }
  }

  // ---- inputs ----

  // A checked practice win (net of gas), as the normal total counted it.
  // verdict: what the live-realistic total did with it (null = junk, ignored there).
  noteWin(usd: number, label: string, verdict: LiveVerdict | null): void {
    if (!(usd > 0) || !Number.isFinite(usd)) return;
    const w = this.s.current.wins;
    w.n++; w.usd += usd;
    if (!w.best || usd > w.best.usd) w.best = { usd, label: String(label).slice(0, 60) };
    if (verdict === 'ok') { w.liveOk.n++; w.liveOk.usd += usd; }
    else if (verdict) { w.leftOut[verdict].n++; w.leftOut[verdict].usd += usd; }
    this.dirty = true;
  }

  // A win the outlier guard refused to count ("too good to be true").
  noteOutlierBlocked(usd: number): void {
    const o = this.s.current.outliers;
    o.n++;
    if (Number.isFinite(usd) && usd > o.biggestUsd) o.biggestUsd = usd;
    this.dirty = true;
  }

  // One practice test. kinds: the pool kinds in the route ('v2', 'v3', 'v4',
  // anything else counts as 'other'). winUsd above 0 = it made money after gas.
  noteTest(kinds: string[], winUsd?: number): void {
    const win = winUsd !== undefined && Number.isFinite(winUsd) && winUsd > 0;
    for (const k0 of new Set(kinds)) {
      const k = k0 === 'v2' || k0 === 'v3' || k0 === 'v4' ? k0 : 'other';
      const t = (this.s.current.testsByKind[k] ??= { tests: 0, wins: 0 });
      t.tests++;
      if (win) t.wins++;
    }
    this.dirty = true;
  }

  // One hour of the hourly report's numbers (taken once by the hourly code).
  addHour(h: HourSample): void {
    const hs = this.s.current.hours;
    hs.push(h);
    if (hs.length > MAX_HOURS) hs.splice(0, hs.length - MAX_HOURS);
    this.dirty = true;
    this.save();
  }

  // How much a running total grew since the last call with the same key.
  // A smaller value than last time means the bot restarted and the total
  // started again from zero: then the whole value is new.
  delta(key: string, total: number): number {
    if (!Number.isFinite(total)) return 0;
    const last = this.s.counters[key];
    if (last === undefined && Object.keys(this.s.counters).length >= MAX_COUNTERS) return 0;
    this.s.counters[key] = total;
    this.dirty = true;
    if (last === undefined || total < last) return total;
    return total - last;
  }

  // ---- outputs ----

  // The totals so far (nothing reset).
  peek(toMs = this.now()): PeriodTotals { return totalsOf(this.s.current, toMs); }
  prevWins(): { usd: number; n: number } | null { return this.s.prev ? { ...this.s.prev } : null; }
  get lastSentKey(): string { return this.s.lastSentKey; }

  // Ends the period: returns its totals and the previous period's wins, then
  // starts a fresh period at `toMs`. sentKey is remembered so the same
  // report is never sent twice (also across restarts).
  close(sentKey: string, toMs = this.now()): { totals: PeriodTotals; prev: { usd: number; n: number } | null } {
    const totals = totalsOf(this.s.current, toMs);
    const prev = this.s.prev;
    this.s.prev = { usd: totals.wins.usd, n: totals.wins.n };
    this.s.current = emptyPeriod(toMs);
    this.s.lastSentKey = sentKey;
    this.dirty = true;
    this.save();
    return { totals, prev };
  }

  // Write to disk only when something changed (temp file + rename, so a
  // crash mid-write never leaves a broken file). Best effort.
  save(): void {
    if (!this.file || !this.dirty) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file + '.tmp', JSON.stringify(this.s));
      renameSync(this.file + '.tmp', this.file);
      this.dirty = false;
    } catch { /* keep counting in memory */ }
  }
}

// Adds up one period's state into report totals. Pure.
export function totalsOf(p: PeriodState, toMs: number): PeriodTotals {
  const H = p.hours;
  const sum = <T extends Record<string, number>>(pick: (h: HourSample) => T | null | undefined, keys: (keyof T)[]): T => {
    const out = {} as T;
    for (const k of keys) (out as Record<string, number>)[k as string] = 0;
    for (const h of H) { const v = pick(h); if (v) for (const k of keys) (out as Record<string, number>)[k as string] += fin(v[k]); }
    return out;
  };
  const funnel = sum((h) => h.funnel, ['tradesRead', 'noPool', 'tooSmall', 'noPartner', 'noUsdPrice', 'smallerThanFees', 'found', 'belowCheckBar', 'notVetted', 'sentToCheck']);
  const checks = sum((h) => h.checks, ['done', 'makeMoney', 'loseMoney', 'wouldFail', 'tooLate', 'nodeBusy']);
  const timing = sum((h) => h.timing, ['rightAfter', 'othersInBlock', 'late']);
  const live = sum((h) => h.live, ['sent', 'won', 'profitUsd', 'gasUsd']);
  const raceHours = H.filter((h) => h.race);
  const race = { ...sum((h) => h.race, ['won', 'lost', 'unclear', 'wonUsd', 'lostUsd']), hours: raceHours.length };

  // Stages: usual = weighted hourly medians, slowest = worst hourly slow-5%.
  const stageNames = [...new Set(H.flatMap((h) => Object.keys(h.stages ?? {})))];
  const stages: PeriodTotals['stages'] = {};
  for (const st of stageNames) {
    const xs = H.map((h) => h.stages?.[st]).filter((x): x is StageSample => !!x);
    stages[st] = { n: xs.reduce((s, x) => s + fin(x.n), 0), usualMs: weightedUsual(xs.map((x) => ({ n: x.n, v: x.median }))), slowestMs: worst(xs.map((x) => x.p95)) };
  }

  // Freezes: counts add up, longest is the worst, causes merged by name.
  const stallHours = H.filter((h) => h.stalls);
  const causes = new Map<string, [number, number]>();
  for (const h of stallHours) for (const [name, n, maxMs] of h.stalls!.causes) {
    const c = causes.get(name) ?? [0, 0];
    causes.set(name, [c[0] + fin(n), Math.max(c[1], fin(maxMs))]);
  }
  const coveredMs = H.reduce((s, h) => s + Math.max(0, fin(h.toMs) - fin(h.fromMs)), 0);
  const gcMs = stallHours.reduce((s, h) => s + fin(h.stalls!.gcMs), 0);
  const stalls: PeriodTotals['stalls'] = {
    measured: stallHours.length > 0,
    enabled: stallHours.some((h) => h.stalls!.enabled),
    thresholdMs: stallHours[0]?.stalls?.thresholdMs ?? 50,
    freezes: stallHours.reduce((s, h) => s + fin(h.stalls!.freezes), 0),
    worstMs: stallHours.reduce((m, h) => Math.max(m, fin(h.stalls!.worstMs)), 0),
    causes: [...causes.entries()].map(([name, [n, maxMs]]) => [name, n, maxMs] as [string, number, number]).sort((a, b) => b[1] - a[1]).slice(0, MAX_CAUSES),
    gcMs, gcN: stallHours.reduce((s, h) => s + fin(h.stalls!.gcN), 0),
    gcPct: stallHours.length && coveredMs > 0 ? (100 * gcMs) / coveredMs : null,
  };

  // Rival speed check: timed and "first" add up; times are weighted by trades timed.
  const rs = H.map((h) => h.rivalsSpeed).filter((x): x is NonNullable<HourSample['rivalsSpeed']> => !!x);
  const rivalsSpeed = {
    timed: rs.reduce((s, x) => s + fin(x.timed), 0), weBeat: rs.reduce((s, x) => s + fin(x.weBeat), 0),
    theirMs: weightedUsual(rs.map((x) => ({ n: x.timed, v: x.theirMs }))), oursMs: weightedUsual(rs.map((x) => ({ n: x.timed, v: x.oursMs }))),
  };

  // Loops: counts add up, best is the best, routes merged by name.
  const lh = H.map((h) => h.loops).filter((x): x is LoopSample => !!x);
  let loops: PeriodTotals['loops'] = null;
  if (lh.length) {
    const add = (k: keyof LoopSample) => lh.reduce((s, x) => s + fin(x[k] as number), 0);
    const addNull = (k: 'nodeRateLimited' | 'nodePaused' | 'nodeBusySkips') => (lh.some((x) => x[k] !== null) ? lh.reduce((s, x) => s + fin(x[k]), 0) : null);
    const byLen: number[] = [];
    for (const x of lh) x.foundByLen.forEach((v, i) => { byLen[i] = (byLen[i] ?? 0) + fin(v); });
    const routes = new Map<string, { label: string; n: number; bestUsd: number }>();
    for (const x of lh) for (const r of x.topRoutes) {
      const c = routes.get(r.label) ?? { label: r.label, n: 0, bestUsd: 0 };
      c.n += fin(r.n); c.bestUsd = Math.max(c.bestUsd, fin(r.bestUsd));
      routes.set(r.label, c);
    }
    loops = {
      found: add('found'), bestUsd: lh.reduce((m, x) => Math.max(m, fin(x.bestUsd)), 0), checked: add('checked'),
      wouldMake: add('wouldMake'), wouldMakeUsd: add('wouldMakeUsd'), lost: add('lost'), failed: add('failed'),
      cantRun: add('cantRun'), skippedCap: add('skippedCap'), foundByLen: byLen.map(fin),
      mvcN: add('mvcN'), modelUsd: add('modelUsd'), checkUsd: add('checkUsd'),
      rivalLoops: add('rivalLoops'), rivalLonger: add('rivalLonger'),
      nodeRateLimited: addNull('nodeRateLimited'), nodePaused: addNull('nodePaused'), nodeBusySkips: addNull('nodeBusySkips'),
      nodeText: lh[lh.length - 1].nodeText,
      topRoutes: [...routes.values()].sort((a, b) => b.bestUsd - a.bestUsd).slice(0, MAX_ROUTES),
      hours: lh.length,
    };
  }

  // New exchanges: merged by name, best earners first.
  const vm = new Map<string, [number, number, number]>();
  for (const h of H) for (const [name, t, w, usd] of h.venues ?? []) {
    const c = vm.get(name) ?? [0, 0, 0];
    vm.set(name, [c[0] + fin(t), c[1] + fin(w), c[2] + fin(usd)]);
  }
  const venues = [...vm.entries()].map(([n, [t, w, u]]) => [n, t, w, u] as [string, number, number, number])
    .sort((a, b) => b[3] - a[3] || b[2] - a[2] || b[1] - a[1]).slice(0, MAX_VENUES);

  // Wins: the hourly ledger money in each hour sample, plus any wins noted
  // directly (noteWin). shadowMain only uses the ledger path.
  const wins: PeriodTotals['wins'] = JSON.parse(JSON.stringify(p.wins));
  for (const h of H) {
    const m = h.money;
    if (!m) continue;
    wins.n += fin(m.checkedCount); wins.usd += fin(m.checkedUsd);
    wins.liveOk.n += fin(m.couldEarnCount); wins.liveOk.usd += fin(m.couldEarnUsd);
    for (const k of ['otherCoin', 'overSize', 'loan'] as const) { wins.leftOut[k].n += fin(m.leftOut?.[k]?.n); wins.leftOut[k].usd += fin(m.leftOut?.[k]?.usd); }
    if (m.best && Number.isFinite(m.best.usd) && (!wins.best || m.best.usd > wins.best.usd)) wins.best = { usd: m.best.usd, label: String(m.best.label).slice(0, 60) };
  }
  const realMoney: PeriodTotals['money'] = { realUsd: 0, realWon: 0, gasUsd: 0, failed: 0, failedCostUsd: 0 };
  for (const h of H) if (h.money) for (const k of Object.keys(realMoney) as (keyof PeriodTotals['money'])[]) realMoney[k] += fin(h.money[k]);

  return {
    fromMs: p.fromMs, toMs, coveredMs, restarts: p.restarts, hours: H.length,
    wins,
    outliers: { ...p.outliers },
    testsByKind: JSON.parse(JSON.stringify(p.testsByKind)),
    funnel, checkBarUsd: H.length ? fin(H[H.length - 1].checkBarUsd) : 0.10,
    checks, timing,
    benchedRoutes: H.length ? fin(H[H.length - 1].benchedRoutes) : null,
    checksAvailable: H.length ? H.every((h) => h.checksAvailable !== false) : null,
    race,
    reaction: {
      usualMs: weightedUsual(H.map((h) => ({ n: h.reaction?.n ?? 0, v: h.reaction?.medianMs ?? null }))),
      slowestMs: worst(H.map((h) => h.reaction?.p95Ms ?? null)),
    },
    stages, stalls, rivalsSpeed, loops, venues, live, money: realMoney, feedDrops: H.reduce((s, h) => s + fin(h.feedDrops), 0),
  };
}

// ---- schedule helpers (pure) ----

// The Toronto (or tz) calendar parts of a moment.
export function zonedParts(ms: number, tz: string): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
}

// If `ms` is within the first `graceMin` minutes of a 4-hour mark
// (00:00, 04:00, 08:00, 12:00, 16:00, 20:00 in tz), the key of that mark,
// e.g. "2026-10-15T16". Otherwise null.
export function fourHourMark(ms: number, tz: string, graceMin = 30): string | null {
  const z = zonedParts(ms, tz);
  if (z.hour % 4 !== 0 || z.minute >= graceMin) return null;
  return `${z.date}T${String(z.hour).padStart(2, '0')}`;
}
