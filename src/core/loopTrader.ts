import { PoolState } from './types';
import { LoopFinder, LoopEnv, LoopResult, LoopCycle, LOOP_MIN_POOLS_LIMIT, LOOP_MAX_POOLS_LIMIT, UpdateOutcome, realisticHopOut } from './loopFinder';
import { drainSteps, Steps } from './chunked';
import type { LoopFixSwitches } from './loopPrices';
import { ExecutorHop, hopFor, kindForPool, v4KeyMatchesId, KIND_V4_HOOKED } from '../execution/executorCalldata';
import type { SimResult } from '../execution/simulator';
import { CoinTaxGate, CoinTaxStats, coinHolderOf } from './coinTax';

// ============================================================================
// LOOP TRADER v1 -- PRACTICE ONLY
//
// Plain English:
//   Runs the loop finder (core/loopFinder.ts) after every price update, the
//   same moments the 2-pool gap scanner runs. For each loop that would make
//   money after gas:
//     - counts it ONCE until it closes (same rule as the gap scanner: it
//       counts again only after it disappeared, or if it at least doubled);
//     - if the contract can run every pool on the loop, queues a PRACTICE
//       check: the same free eth_call "pretend" test used for 2-pool trades;
//     - otherwise notes "loop found (contract can't run it yet)".
//
//   Practice checks for loops: one at a time, at most LOOP_CHECKS_PER_MIN (6)
//   a minute, and only when canCheckNow says yes. Since Oct 15 they run on
//   their own node (LOOP_CHECK_NODE, core/loopNode.ts, default the free
//   public node), so they never crowd out 2-pool checks on the main node.
//   With LOOP_CHECK_NODE=main they come LAST, only when the normal check line
//   is idle (old behaviour).
//
//   THIS FILE CANNOT SEND A TRADE. It is never given a sender or a wallet,
//   only a "practice check" function. LOOP_LIVE_SEND_POSSIBLE is false and a
//   test checks it. Going live needs a separate, owner-approved change.
//
// Off unless LOOP_TRADER=1. Off means nothing here runs at all.
// ============================================================================

export const LOOP_LIVE_SEND_POSSIBLE = false as const;

export interface LoopTraderConfig {
  enabled: boolean;        // LOOP_TRADER=1
  maxPools: number;        // LOOP_MAX_POOLS (3-8, default 5)
  maxCycles: number;       // LOOP_MAX_CYCLES (default 5000)
  maxTradeUsd: number;     // LOOP_MAX_TRADE_USD (default $2,000)
  depthShare: number;      // LOOP_DEPTH_SHARE (default 0.3 of the shallowest pool)
  minNetUsd: number;       // LOOP_MIN_NET_USD, default = the check bar (SIM_MIN_GROSS_USD, else MIN_EXEC_NET_USD, else $0.10)
  checksPerMin: number;    // LOOP_CHECKS_PER_MIN (default 6, 0 = never check)
  maxPoolAgeMs: number;    // LOOP_MAX_POOL_AGE_MS: pools with older prices are left out (default 30 s)
  longSlack: number;       // LOOP_LONG_SLACK: 6-8 pool loops are listed only if within this share of paying (default 0.02)
  // ROUTE MEMORY (Oct 20): a loop whose practice check failed this many times
  // in a row is benched (not checked) for benchMs. 0 = off.
  benchAfter?: number;     // LOOP_BENCH_AFTER (default 5)
  benchMs?: number;        // LOOP_BENCH_MIN minutes (default 20)
}

const num = (raw: string | undefined, dflt: number, min: number, max: number): number => {
  if (raw === undefined || raw.trim() === '') return dflt;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;
};

// LOOP_MAX_POOLS: longest loop searched. 3 to 8, default 5. A value outside
// 3-8 is moved to the nearest end (9 -> 8, 2 -> 3); text that isn't a
// number means the default. Both print a warning so a typo is noticed.
export function loopMaxPoolsFromEnv(raw: string | undefined, warn: (msg: string) => void = console.warn): number {
  const dflt = 5;
  if (raw === undefined || raw.trim() === '') return dflt;
  const v = Number(raw);
  if (!Number.isFinite(v)) { warn(`[loop] LOOP_MAX_POOLS=${raw} is not a number, using ${dflt}`); return dflt; }
  const r = Math.round(v);
  const c = Math.min(LOOP_MAX_POOLS_LIMIT, Math.max(LOOP_MIN_POOLS_LIMIT, r));
  if (c !== v) warn(`[loop] LOOP_MAX_POOLS=${raw} is outside ${LOOP_MIN_POOLS_LIMIT}-${LOOP_MAX_POOLS_LIMIT} (whole numbers), using ${c}`);
  return c;
}

// Our gas for a loop: a fixed part plus a part per pool, scaled from the
// bot's existing 2-pool gas estimate (so a 2-pool result stays the same).
//
// Measured (PR #116 fork tests, contract call only): live 3-hop 502k gas,
// 4-hop own money 646k, 4-hop V3 flash loan 760k, 5-hop 758k. On mocks a V2
// hop costs ~64k and a 2-hop trade ~160k, but real pools cost more per hop.
// Straight-line fit to the own-money real-pool runs (3/4/5 hops):
//   gas ~= 123k + 128k per pool  (3 -> 507k, 4 -> 635k, 5 -> 763k, 8 -> 1.15M)
// So a loop of N pools costs (123k + 128k*N) / (123k + 128k*2) times the
// 2-pool estimate: 3 pools = 1.34x, 5 pools = 2.01x, 8 pools = 3.03x.
// (Flash-loan loops cost ~100k more; loops are own money in practice checks.)
export const LOOP_GAS_BASE = 123_000;
export const LOOP_GAS_PER_POOL = 128_000;
export function loopGasUnits(pools: number): number { return LOOP_GAS_BASE + LOOP_GAS_PER_POOL * pools; }
export function loopGasUsd(twoPoolGasUsd: number, pools: number): number {
  return twoPoolGasUsd * (loopGasUnits(pools) / loopGasUnits(2));
}

export function loopConfigFromEnv(env: Record<string, string | undefined> = process.env, warn: (msg: string) => void = console.warn): LoopTraderConfig {
  const bar = num(env.SIM_MIN_GROSS_USD, num(env.MIN_EXEC_NET_USD, 0.10, 0.0001, 1e6), 0.0001, 1e6);
  return {
    enabled: env.LOOP_TRADER === '1' || env.LOOP_TRADER === 'true',
    maxPools: loopMaxPoolsFromEnv(env.LOOP_MAX_POOLS, warn),
    maxCycles: Math.round(num(env.LOOP_MAX_CYCLES, 5_000, 1, 50_000)),
    maxTradeUsd: num(env.LOOP_MAX_TRADE_USD, 2_000, 1, 1e6),
    depthShare: num(env.LOOP_DEPTH_SHARE, 0.3, 0.001, 1),
    minNetUsd: num(env.LOOP_MIN_NET_USD, bar, 0.0001, 1e6),
    checksPerMin: Math.round(num(env.LOOP_CHECKS_PER_MIN, 6, 0, 60)),
    maxPoolAgeMs: num(env.LOOP_MAX_POOL_AGE_MS, 30_000, 1_000, 3_600_000),
    longSlack: num(env.LOOP_LONG_SLACK, 0.02, 0, 0.2),
    benchAfter: Math.round(num(env.LOOP_BENCH_AFTER, 5, 0, 1_000)),
    benchMs: num(env.LOOP_BENCH_MIN, 20, 1, 24 * 60) * 60_000,
  };
}

// The practice-check trade (same shape the 2-pool check uses).
export interface LoopTrade { token: string; amountIn: bigint; hops: ExecutorHop[] }

export interface LoopTraderDeps {
  env: LoopEnv;
  bases: string[];
  symbolOf: (token: string) => string;
  decimalsOf: (token: string) => number | undefined;
  // Exchange allowed in practice checks (config/robinhoodVenues canPracticeTestVenue).
  canPracticeTest: (pool: PoolState) => boolean;
  // True when the normal check line is idle and the node has room.
  canCheckNow: () => boolean;
  // One practice check (eth_call with state override). Never sends anything.
  // ctx.triggerHash (LOOP_TRIGGER_REPLAY): the feed trade that opened the
  // loop, so the check can replay its block up to it and test right after
  // it. The answer may say which timing was used ("right after trigger",
  // "end of trigger block", "tested late", "latest").
  runCheck: (trade: LoopTrade, ctx?: LoopCheckContext) => Promise<LoopCheckResult>;
  log?: (msg: string) => void;
  // Loop fix phase 2 switches (core/loopPrices.ts). Missing = all off = old behaviour.
  fix?: Partial<LoopFixSwitches>;
  // LOOP_MODEL_VS_CHECK: a check reported the gas our loop really used
  // (replays do): teach the gas model (shadowMain: gasModel.notePractice).
  noteGas?: (pools: number, gasUsed: bigint) => void;
  // COIN TAX TEST (Oct 20, core/coinTax.ts): coins that take a cut when moved
  // are left out of loops; untested coins are tested once before a loop that
  // uses them is checked. Missing = off (old behaviour).
  coinTax?: CoinTaxGate;
}

// What a loop practice check is told, and what it answers.
export interface LoopCheckContext { triggerHash?: string }
export type LoopCheckResult = SimResult & { timing?: string };

// Optional extra input for one scan: the feed trades that triggered it.
export interface LoopScanContext {
  // Pool (lower-case address / V4 id) -> latest trigger trade hash on it.
  triggers?: Map<string, { hash: string; at: number }>;
}

// Turns a loop into the contract's hop list, or says why the contract can't run it.
export function buildLoopTrade(r: Pick<LoopResult, 'cycle' | 'pools' | 'amountIn'>, canPracticeTest: (p: PoolState) => boolean):
  { ok: true; trade: LoopTrade } | { ok: false; reason: string } {
  const hops: ExecutorHop[] = [];
  for (let i = 0; i < r.cycle.hops.length; i++) {
    const h = r.cycle.hops[i], p = r.pools[i];
    const kind = kindForPool(p);
    if (kind === null) return { ok: false, reason: `${p.dex} pool type not supported by the contract` };
    if (kind === KIND_V4_HOOKED && !v4KeyMatchesId(p)) return { ok: false, reason: `${p.dex} hooked V4 key does not match its pool id` };
    if (!canPracticeTest(p)) return { ok: false, reason: `${p.dex} not approved for practice checks yet` };
    // Use the pool's own spelling of the token addresses (checksummed where stored).
    const tokIn = p.tokenA.toLowerCase() === h.tokenIn ? p.tokenA : p.tokenB;
    const tokOut = p.tokenA.toLowerCase() === h.tokenOut ? p.tokenA : p.tokenB;
    try { hops.push(hopFor(kind, p, tokIn, tokOut)); }
    catch (e) { return { ok: false, reason: `could not encode ${p.dex} hop (${(e as Error).message})` }; }
  }
  // Same rules the contract checks (_validateRoute): 2+ hops, chained, starts and ends in the base.
  for (let i = 1; i < hops.length; i++) if (hops[i - 1].tokenOut.toLowerCase() !== hops[i].tokenIn.toLowerCase()) return { ok: false, reason: 'route does not chain' };
  if (hops[0].tokenIn.toLowerCase() !== r.cycle.base || hops[hops.length - 1].tokenOut.toLowerCase() !== r.cycle.base) return { ok: false, reason: 'route does not start and end in the base coin' };
  if (r.amountIn <= 0n) return { ok: false, reason: 'trade rounds to zero' };
  return { ok: true, trade: { token: hops[0].tokenIn, amountIn: r.amountIn, hops } };
}

// A real loop nets a few % at most; more means broken token/pool data.
const MAX_PLAUSIBLE_PROFIT_SHARE = 0.25;

interface Waiting { r: LoopResult; trade: LoopTrade; at: number; triggerHash?: string }
interface RouteStat { label: string; n: number; bestUsd: number }

// ----------------------------------------------------------------------------
// CHECK VS ESTIMATE (Oct 13 diagnosis)
//
// Plain English: every loop the finder said would pay lost in its practice
// check. To see WHY, each practice check is written down with:
//   - the finder's estimate (profit after gas, USD),
//   - what the check said (profit after gas in USD, or "lost", or why it
//     wouldn't go through),
//   - how many seconds passed between "found" and the check starting,
//   - the route.
// A loss that happens within 1 s of being found means the estimate itself
// was wrong (prices were still the same). A loss after several seconds can
// also mean someone else took the gap first. The hourly report shows the
// medians and that quick / slow split.
//
// A losing check does not say HOW MUCH it lost (the contract only reports
// "not more than it started"), so a loss counts as minus our gas in the
// median result: the best a losing check could have been.
// ----------------------------------------------------------------------------
export interface LoopCheckRecord {
  route: string;
  estUsd: number;               // finder's estimate after gas
  outcome: 'profit' | 'loss' | 'fail';
  resultUsd: number | null;     // after gas; loss = minus gas (best case); fail = null
  reason?: string;              // why it wouldn't go through
  delayMs: number;              // found -> check started
  // LOOP_MODEL_VS_CHECK (loop fix phase 2): profit BEFORE gas, model vs check.
  // checkGrossUsd: exact for a profit; 0 for a loss (the contract only says
  // "not more than it started", so 0 is the best a loss could have been);
  // null when the check didn't go through.
  timing?: string;              // which state the check ran on (see runCheck)
  modelGrossUsd?: number;
  checkGrossUsd?: number | null;
}

// Model vs check, per check timing (for the hourly line).
export interface ModelVsCheckRow {
  timing: string;
  n: number;                    // checks that ran the whole route (profit or loss)
  modelUsd: number;             // sum of the model's profit before gas
  checkUsd: number;             // sum of the check's profit before gas (loss = 0, best case)
  losses: number;               // of n, how many lost (real loss size unknown)
}

export interface LoopCheckSummary {
  n: number;
  medianEstUsd: number | null;
  medianResultUsd: number | null;
  medianDelayMs: number | null;
  lossesQuick: number;          // losses checked under 1 s after being found
  lossesSlow: number;           // losses checked 1 s or more after being found
  topFail: [string, number] | null; // most common reason a check wouldn't go through
  modelVsCheck?: ModelVsCheckRow[];  // LOOP_MODEL_VS_CHECK: by timing, most checks first
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Adds up the hour's check records for the report line.
export function summarizeLoopChecks(recs: LoopCheckRecord[]): LoopCheckSummary {
  const fails = new Map<string, number>();
  let lossesQuick = 0, lossesSlow = 0;
  for (const r of recs) {
    if (r.outcome === 'loss') { if (r.delayMs < 1_000) lossesQuick++; else lossesSlow++; }
    if (r.outcome === 'fail') { const k = (r.reason ?? 'unknown').slice(0, 60); fails.set(k, (fails.get(k) ?? 0) + 1); }
  }
  const results = recs.map((r) => r.resultUsd).filter((x): x is number => x !== null);
  // Model vs check by timing (only records that carry both numbers).
  const rows = new Map<string, ModelVsCheckRow>();
  for (const r of recs) {
    if (r.modelGrossUsd === undefined || r.checkGrossUsd === undefined || r.checkGrossUsd === null) continue;
    const t = r.timing || 'latest';
    const row = rows.get(t) ?? { timing: t, n: 0, modelUsd: 0, checkUsd: 0, losses: 0 };
    row.n++; row.modelUsd += r.modelGrossUsd; row.checkUsd += r.checkGrossUsd;
    if (r.outcome === 'loss') row.losses++;
    rows.set(t, row);
  }
  return {
    n: recs.length,
    medianEstUsd: median(recs.map((r) => r.estUsd)),
    medianResultUsd: median(results),
    medianDelayMs: median(recs.map((r) => r.delayMs)),
    lossesQuick, lossesSlow,
    topFail: [...fails.entries()].sort((a, b) => b[1] - a[1])[0] ?? null,
    ...(rows.size ? { modelVsCheck: [...rows.values()].sort((a, b) => b.n - a.n) } : {}),
  };
}

// Most check records kept per hour (checks are capped at 6 a minute = 360 an hour).
const MAX_CHECK_RECORDS = 1_000;

export interface LoopHour {
  found: number; bestUsd: number; checked: number; wouldMake: number; wouldMakeUsd: number;
  lost: number; failed: number; cantRun: number; cantRunWhy: [string, number][];
  skippedCap: number;           // couldn't be checked: cap reached / line busy / too old
  foundByLen: number[];         // paying loops found, by number of pools (index = pools)
  topRoutes: RouteStat[];
  updates: number; medianMs: number | null; slowestMs: number | null; cycles: number; capped: boolean;
  skippedScans?: number;        // LOOP_CHEAP_SCAN: scans skipped because no pool changed
  cyclesByLen: number[];        // loops in the list, by number of pools
  rebuild: { totalMs: number; maxSliceMs: number } | null; // last loop list rebuild
  // longer: rival loop wins with more pools than our LOOP_MAX_POOLS;
  // unseen: within our max, but we didn't see every pool of their route.
  rival: { loops: number; comparable: number; weFound: number; leadMsMedian: number | null; longer: number; unseen: number; topBot: [string, number] | null };
  checkVsEstimate: LoopCheckSummary; // practice check results against the finder's estimates
  // COIN TAX TEST + ROUTE MEMORY (Oct 20). Missing when both are off.
  coins?: {
    tax: CoinTaxStats | null;   // coins tested so far (since start), null = tax test off
    taxPools: number;           // pools left out of the last scan (a coin on them takes a cut)
    waitTest: number;           // paying loops not checked this hour: a coin not tested yet
    benchedSkips: number;       // paying loops not checked this hour: route benched
    benchStarts: number;        // routes benched this hour
    benchedNow: number;         // routes benched right now
  };
}

export class LoopTrader {
  readonly finder: LoopFinder;
  private open = new Map<string, number>();     // loop sig -> net when it was counted (until it closes)
  private waiting: Waiting[] = [];
  private checkTimes: number[] = [];
  private checking = false;
  private pausedUntil = 0;
  // When each loop (by pool set) was first seen paying in its current run,
  // and the last time it was seen paying. For the rival race comparison.
  private seen = new Map<string, { first: number; last: number }>();
  private hour = this.emptyHour();
  // LOOP_CHEAP_SCAN: the pool states the last scan used (references only,
  // no copies). A scan with exactly the same states, and nothing waiting in
  // the finder, would change nothing, so it is skipped.
  private lastInput: PoolState[] = [];
  // ROUTE MEMORY: loop sig -> failed checks in a row, benched until.
  private bench = new Map<string, { fails: number; until: number }>();
  private taxPools = 0;

  constructor(readonly cfg: LoopTraderConfig, private deps: LoopTraderDeps) {
    this.finder = new LoopFinder({ bases: deps.bases, maxPools: cfg.maxPools, maxCycles: cfg.maxCycles, maxTradeUsd: cfg.maxTradeUsd, depthShare: cfg.depthShare, longSlack: cfg.longSlack ?? 0.02 }, deps.env);
  }

  private emptyHour() {
    return {
      found: 0, bestUsd: 0, checked: 0, wouldMake: 0, wouldMakeUsd: 0, lost: 0, failed: 0, cantRun: 0,
      cantRunWhy: new Map<string, number>(), skippedCap: 0, routes: new Map<string, RouteStat>(), ms: [] as number[],
      foundByLen: [] as number[],
      checks: [] as LoopCheckRecord[],
      skipped: 0,
      rival: { loops: 0, comparable: 0, weFound: 0, leads: [] as number[], longer: 0, unseen: 0, bots: new Map<string, number>() },
      waitTest: 0, benchedSkips: 0, benchStarts: 0,
    };
  }

  private label(c: LoopCycle): string { return [...c.tokens, c.base].map((t) => this.deps.symbolOf(t)).join('/'); }

  // Call after each price update with the pools the bot keeps fresh.
  // Returns undefined when switched off (nothing runs).
  onUpdate(pools: PoolState[], ctx: LoopScanContext = {}): LoopResult[] | undefined {
    if (!this.cfg.enabled) return undefined;
    return drainSteps(this.onUpdateSteps(pools, ctx));
  }

  // The same scan written as steps (LOOP_CHEAP_SCAN), so shadowMain can run
  // it in small slices (core/chunked.ts runSteps). Same answer as onUpdate.
  *onUpdateSteps(pools: PoolState[], ctx: LoopScanContext = {}): Steps<LoopResult[] | undefined> {
    if (!this.cfg.enabled) return undefined;
    const now = this.deps.env.now();
    const usable: PoolState[] = [];
    for (let i = 0; i < pools.length; i++) {
      const p = pools[i];
      if (now - p.lastUpdatedMs <= this.cfg.maxPoolAgeMs) usable.push(p);
      if ((i & 511) === 511) yield;
    }
    // COIN TAX TEST: pools with a coin known to take a cut (or that can't be
    // moved freely) are left out, so the finder never builds loops on them.
    const tax = this.deps.coinTax;
    if (tax) {
      let w = 0, dropped = 0;
      for (let i = 0; i < usable.length; i++) {
        const p = usable[i];
        const va = tax.verdict(p.tokenA), vb = tax.verdict(p.tokenB);
        if (va === 'taxed' || va === 'blocked' || vb === 'taxed' || vb === 'blocked') { dropped++; continue; }
        usable[w++] = p;
      }
      usable.length = w;
      this.taxPools = dropped;
    }
    // CHEAP SCAN: nothing changed since the last scan (same pool states, same
    // order, none aged out) and the finder has nothing waiting: skip it. The
    // result would be "no loop changed", exactly what skipping gives.
    if (this.deps.fix?.cheapScan) {
      let same = usable.length === this.lastInput.length && !this.finder.needsWork(now);
      for (let i = 0; same && i < usable.length; i++) if (usable[i] !== this.lastInput[i]) same = false;
      if (same) { this.hour.skipped++; this.drain(); return []; }
      // Forget the last input until this scan finishes: if it throws part
      // way, the next scan with the same pools must run, not be skipped.
      this.lastInput = [];
    }
    const out: UpdateOutcome = yield* this.finder.updateSteps(usable);
    if (this.deps.fix?.cheapScan) this.lastInput = usable;
    this.hour.ms.push(out.ms);
    if (this.hour.ms.length > 20_000) this.hour.ms.splice(0, 10_000);

    const paying = new Map<number, LoopResult>();
    for (const r of out.results) if (r.netUsd >= this.cfg.minNetUsd) paying.set(r.cycle.id, r);
    // Loops priced this update that no longer pay: closed, may count again later.
    for (const id of out.evaluated) {
      if (paying.has(id)) continue;
      const c = this.finder.cycleById(id);
      if (c) this.open.delete(c.sig);
    }
    // After a rebuild ids change, so also forget loops that are no longer listed.
    if (out.rebuilt) {
      const live = new Set<string>();
      for (let id = 0; id < this.finder.cycleCount(); id++) live.add(this.finder.cycleById(id)!.sig);
      for (const k of this.open.keys()) if (!live.has(k)) this.open.delete(k);
    }

    for (const r of paying.values()) {
      const s = this.seen.get(r.cycle.poolSet);
      if (!s || now - s.last > 60_000) this.seen.set(r.cycle.poolSet, { first: now, last: now }); else s.last = now;
      const was = this.open.get(r.cycle.sig);
      if (was !== undefined && r.netUsd < 2 * was) continue; // same open loop, already counted
      this.open.set(r.cycle.sig, r.netUsd);
      this.count(r, now, this.triggerOf(r, ctx));
    }
    if (this.seen.size > 5_000) for (const [k, v] of this.seen) if (now - v.last > 10 * 60_000) this.seen.delete(k);
    if (this.open.size > 5_000) this.open.clear();
    this.drain();
    return out.results;
  }

  // LOOP_TRIGGER_REPLAY: the trigger trade this loop follows, if one of its
  // pools was traded on by a feed trade that started this scan (the latest
  // one if several). None = a loop found by the 5 s safety net or a block
  // update: checked on "latest" as before.
  private triggerOf(r: LoopResult, ctx: LoopScanContext): string | undefined {
    if (!this.deps.fix?.triggerReplay || !ctx.triggers?.size) return undefined;
    let best: { hash: string; at: number } | undefined;
    for (const h of r.cycle.hops) {
      const t = ctx.triggers.get(h.poolKey);
      if (t && (!best || t.at > best.at)) best = t;
    }
    return best?.hash;
  }

  private count(r: LoopResult, now: number, triggerHash?: string) {
    const h = this.hour;
    h.found++;
    const len = r.cycle.hops.length;
    h.foundByLen[len] = (h.foundByLen[len] ?? 0) + 1;
    h.bestUsd = Math.max(h.bestUsd, r.netUsd);
    const label = this.label(r.cycle);
    const rs = h.routes.get(label) ?? { label, n: 0, bestUsd: 0 };
    rs.n++; rs.bestUsd = Math.max(rs.bestUsd, r.netUsd); h.routes.set(label, rs);
    if (h.routes.size > 500) h.routes.clear();
    const built = buildLoopTrade(r, this.deps.canPracticeTest);
    const base = `[loop] ${label} model $${r.netUsd.toFixed(2)} after gas on $${r.sizeUsd.toFixed(0)} (${r.cycle.hops.length} pools${r.tradable ? '' : ', coin not vetted'})`;
    if ('reason' in built) {
      h.cantRun++;
      h.cantRunWhy.set(built.reason, (h.cantRunWhy.get(built.reason) ?? 0) + 1);
      this.deps.log?.(`${base}: loop found (contract can't run it yet: ${built.reason})`);
      return;
    }
    if (this.cfg.checksPerMin <= 0) return;
    // ROUTE MEMORY: this exact loop failed its last checks: not checked again yet.
    const b = this.bench.get(r.cycle.sig);
    if (b && b.until > now) { h.benchedSkips++; return; }
    // COIN TAX TEST: every coin the loop passes through must have passed the
    // tax test. Untested coins are queued for a test (the pool the coin comes
    // out of holds it); the loop is checked the next time it shows up.
    const tax = this.deps.coinTax;
    if (tax) {
      let untested = false;
      for (let i = 0; i < r.cycle.hops.length; i++) {
        const tok = r.cycle.hops[i].tokenOut;
        if (tok === r.cycle.base) continue;
        const v = tax.verdict(tok);
        if (v === 'ok') continue;
        if (v === 'taxed' || v === 'blocked') return; // left out (the next scan drops its pools)
        const holder = coinHolderOf(r.pools[i]);
        if (holder) tax.request(tok, holder);
        untested = true;
      }
      if (untested) { h.waitTest++; return; }
    }
    this.deps.log?.(`${base}: queued for a practice check`);
    this.waiting.push({ r, trade: built.trade, at: now, ...(triggerHash ? { triggerHash } : {}) });
    // Vetted coins first, then bigger profit. Short line: 10 max.
    this.waiting.sort((a, b) => (a.r.tradable === b.r.tradable ? b.r.netUsd - a.r.netUsd : a.r.tradable ? -1 : 1));
    if (this.waiting.length > 10) { this.waiting.length = 10; h.skippedCap++; }
  }

  // Starts at most one loop check at a time, within the per-minute cap, and
  // only when the normal check line is idle.
  drain(): void {
    if (this.checking) return;
    // COIN TAX TEST: a waiting coin test goes first (it unlocks loops), on the
    // same loop node, one request job at a time, within its own per-minute limit.
    const tax = this.deps.coinTax;
    if (tax && tax.hasWork() && this.deps.env.now() >= this.pausedUntil && this.deps.canCheckNow()) {
      this.checking = true;
      void tax.runNext().catch(() => false).finally(() => { this.checking = false; this.drain(); });
      return;
    }
    if (!this.waiting.length) return;
    const now = this.deps.env.now();
    // A loop waiting more than 2 s is usually gone (same as the normal line).
    const before = this.waiting.length;
    this.waiting = this.waiting.filter((w) => now - w.at <= 2_000);
    this.hour.skippedCap += before - this.waiting.length;
    if (!this.waiting.length || now < this.pausedUntil) return;
    while (this.checkTimes.length && now - this.checkTimes[0] > 60_000) this.checkTimes.shift();
    if (this.checkTimes.length >= this.cfg.checksPerMin) return;
    if (!this.deps.canCheckNow()) return;
    const w = this.waiting.shift()!;
    this.checkTimes.push(now);
    this.checking = true;
    void this.check(w).finally(() => { this.checking = false; });
  }

  private async check(w: Waiting) {
    const label = this.label(w.r.cycle);
    // Seconds between "found" (queued) and the check starting.
    const delayMs = Math.max(0, this.deps.env.now() - w.at);
    const after = `found ${(delayMs / 1_000).toFixed(1)} s before the check`;
    let r: LoopCheckResult;
    try { r = await (w.triggerHash ? this.deps.runCheck(w.trade, { triggerHash: w.triggerHash }) : this.deps.runCheck(w.trade)); }
    catch (e) { this.deps.log?.(`[loop] ${label} practice check error: ${(e as Error).message}`); return; }
    const h = this.hour;
    if (r.status === 'rate_limited') { this.pausedUntil = this.deps.env.now() + 60_000; return; }
    // "skipped: node busy" / "skipped: check too long" (loop node throttle,
    // core/loopNode.ts): counted in the hour line there, not logged one by one.
    if (r.status === 'unsupported' && r.reason.startsWith('skipped: ')) return;
    if (r.status === 'unsupported') { this.deps.log?.(`[loop] ${label} practice check skipped (${r.reason})`); return; }
    h.checked++;
    const est = w.r.netUsd;
    const mvc = !!this.deps.fix?.modelVsCheck;
    const hops = w.r.cycle.hops.length;
    // Gas: the check ran the whole route and said how much gas it used
    // (replays report it): teach the gas model, then use its estimate as of
    // NOW (calibrated loop gas once there are enough samples) instead of the
    // number from when the loop was found.
    if (mvc && (r.status === 'profit' || r.status === 'loss') && r.gasUsed) this.deps.noteGas?.(hops, r.gasUsed);
    const gasUsd = mvc ? this.deps.env.gasUsd(hops) : w.r.gasUsd;
    const timing = r.timing ?? (mvc ? 'latest' : undefined);
    const note = (rec: Omit<LoopCheckRecord, 'route' | 'estUsd' | 'delayMs'>) => {
      if (h.checks.length >= MAX_CHECK_RECORDS) return;
      const extra = mvc ? { timing, modelGrossUsd: w.r.grossUsd } : {};
      h.checks.push({ route: label, estUsd: est, delayMs, ...extra, ...rec });
    };
    if (mvc) this.logModelVsCheck(w, r, label, timing);
    // ROUTE MEMORY: a real profit clears the count; anything else adds one.
    const benchAfter = this.cfg.benchAfter ?? 0;
    if (benchAfter > 0) {
      const sig = w.r.cycle.sig;
      const madeMoney = r.status === 'profit' && w.trade.amountIn > 0n
        && Number(r.profit) / Number(w.trade.amountIn) <= MAX_PLAUSIBLE_PROFIT_SHARE
        && (() => { const d = this.deps.decimalsOf(w.r.cycle.base), u = this.deps.env.usdOf(w.r.cycle.base); return d !== undefined && !!u && (Number(r.profit) / 10 ** d) * u - gasUsd > 0; })();
      if (madeMoney) this.bench.delete(sig);
      else {
        const e = this.bench.get(sig) ?? { fails: 0, until: 0 };
        e.fails++;
        if (e.fails >= benchAfter) {
          e.fails = 0;
          e.until = this.deps.env.now() + (this.cfg.benchMs ?? 20 * 60_000);
          h.benchStarts++;
          this.deps.log?.(`[loop] ${label} benched for ${Math.round((this.cfg.benchMs ?? 20 * 60_000) / 60_000)} min after ${benchAfter} failed checks in a row`);
        }
        this.bench.set(sig, e);
        if (this.bench.size > 5_000) { const t = this.deps.env.now(); for (const [k, v] of this.bench) if (v.until <= t) this.bench.delete(k); }
      }
    }
    if (r.status === 'profit') {
      const dec = this.deps.decimalsOf(w.r.cycle.base), usd = this.deps.env.usdOf(w.r.cycle.base);
      const plausible = w.trade.amountIn > 0n && Number(r.profit) / Number(w.trade.amountIn) <= MAX_PLAUSIBLE_PROFIT_SHARE;
      if (dec === undefined || !usd || !plausible) {
        h.failed++; note({ outcome: 'fail', resultUsd: null, reason: 'implausible or unpriced profit' });
        this.deps.log?.(`[loop] ${label} practice: implausible or unpriced profit, ignored (estimate $${est.toFixed(2)}, ${after})`);
        return;
      }
      const gross = (Number(r.profit) / 10 ** dec) * usd;
      const net = gross - gasUsd;
      const g = mvc ? { checkGrossUsd: gross } : {};
      if (net > 0) { h.wouldMake++; h.wouldMakeUsd += net; note({ outcome: 'profit', resultUsd: net, ...g }); }
      else { h.lost++; note({ outcome: 'loss', resultUsd: net, ...g }); }
      this.deps.log?.(`[loop] ${label} practice: REAL PROFIT $${net.toFixed(4)} after gas (estimate $${est.toFixed(2)}, ${after}${timing ? `, ${timing}` : ''}) | practice only, never sent`);
    } else if (r.status === 'loss') {
      h.lost++; note({ outcome: 'loss', resultUsd: -gasUsd, ...(mvc ? { checkGrossUsd: 0 } : {}) });
      this.deps.log?.(`[loop] ${label} practice: LOSS (estimate $${est.toFixed(2)}, ${after}${timing ? `, ${timing}` : ''})`);
    } else {
      h.failed++; note({ outcome: 'fail', resultUsd: null, reason: r.reason, ...(mvc ? { checkGrossUsd: null } : {}) });
      this.deps.log?.(`[loop] ${label} practice: FAILS (${r.reason}; estimate $${est.toFixed(2)}, ${after}${timing ? `, ${timing}` : ''})`);
    }
    this.drain();
  }

  // LOOP_MODEL_VS_CHECK: one log line per check with what the model expected
  // out of EACH pool and what the check gave back at the end. The contract
  // only reports the final result (and for a loss not even how much), so the
  // per-pool numbers are the model's; comparing them with the end result
  // shows how far off the model was overall.
  private logModelVsCheck(w: Waiting, r: LoopCheckResult, label: string, timing: string | undefined): void {
    if (!this.deps.log) return;
    const c = w.r.cycle;
    const fmt = (raw: bigint, tok: string) => {
      const d = this.deps.decimalsOf(tok);
      const v = d === undefined ? Number(raw) : Number(raw) / 10 ** d;
      return `${v.toPrecision(5)} ${this.deps.symbolOf(tok)}`;
    };
    const parts = [fmt(w.r.amountIn, c.base)];
    let amt = w.r.amountIn;
    for (let i = 0; i < c.hops.length; i++) {
      amt = realisticHopOut(w.r.pools[i], c.hops[i].inIsA, amt);
      parts.push(fmt(amt, c.hops[i].tokenOut));
    }
    const end = r.status === 'profit' ? fmt(w.trade.amountIn + r.profit, c.base)
      : r.status === 'loss' ? `no more than ${fmt(w.trade.amountIn, c.base)} (loss size unknown)`
        : `did not run (${'reason' in r ? r.reason : 'unknown'})`;
    this.deps.log(`[loop] ${label} model vs check${timing ? ` (${timing})` : ''}: model per pool ${parts.join(' -> ')}; check end ${end}`);
  }

  // Rival race: a rival's confirmed loop win. Did our finder have the same loop
  // (same pools), and how long before we read their trade?
  noteRival(rec: { bot: string; pools: number; route?: string[]; grossUsd: number | null; gasUsd: number | null; failed: boolean; t: number }): void {
    if (!this.cfg.enabled) return;
    if (rec.failed || rec.pools < 3 || rec.grossUsd === null) return;
    if (rec.grossUsd - (rec.gasUsd ?? 0) <= 0) return;
    const rv = this.hour.rival;
    rv.loops++;
    rv.bots.set(rec.bot, (rv.bots.get(rec.bot) ?? 0) + 1);
    if (rv.bots.size > 200) rv.bots.clear();
    const route = rec.route ?? [];
    if (rec.pools > this.cfg.maxPools) { rv.longer++; return; }      // longer than we search
    if (route.length !== rec.pools) { rv.unseen++; return; }         // we didn't see their whole route
    rv.comparable++;
    const s = this.seen.get(route.map((p) => p.toLowerCase()).sort().join(','));
    // Found within the 2 minutes before we read their trade.
    if (s && s.first <= rec.t && rec.t - s.last <= 120_000) { rv.weFound++; rv.leads.push(rec.t - s.first); }
  }

  // The hour's numbers (and start a new hour).
  takeHour(): LoopHour {
    const h = this.hour;
    this.hour = this.emptyHour();
    return this.summarize(h);
  }

  // The hour's numbers SO FAR, without starting a new hour (nothing is
  // reset). Used for the 15 minute "[loop] hour so far" log line that the
  // status page reads. Only reads and sorts the hour's bounded lists.
  peekHour(): LoopHour {
    return this.summarize(this.hour);
  }

  // Turns the raw hour counters into the report numbers. Never changes them.
  private summarize(h: ReturnType<LoopTrader['emptyHour']>): LoopHour {
    const ms = [...h.ms].sort((a, b) => a - b);
    const leads = [...h.rival.leads].sort((a, b) => a - b);
    const top = [...h.rival.bots.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
    return {
      found: h.found, bestUsd: h.bestUsd, checked: h.checked, wouldMake: h.wouldMake, wouldMakeUsd: h.wouldMakeUsd,
      lost: h.lost, failed: h.failed, cantRun: h.cantRun, cantRunWhy: [...h.cantRunWhy.entries()].sort((a, b) => b[1] - a[1]),
      skippedCap: h.skippedCap,
      foundByLen: Array.from({ length: LOOP_MAX_POOLS_LIMIT + 1 }, (_, i) => h.foundByLen[i] ?? 0),
      topRoutes: [...h.routes.values()].sort((a, b) => b.bestUsd - a.bestUsd || b.n - a.n).slice(0, 3),
      updates: ms.length, medianMs: ms.length ? ms[Math.floor(ms.length / 2)] : null, slowestMs: ms.length ? ms[ms.length - 1] : null,
      cycles: this.finder.cycleCount(), capped: this.finder.lastCapped,
      ...(h.skipped ? { skippedScans: h.skipped } : {}),
      cyclesByLen: Array.from({ length: LOOP_MAX_POOLS_LIMIT + 1 }, (_, i) => this.finder.cyclesByLen()[i] ?? 0),
      rebuild: (() => { const s = this.finder.rebuildStats(); return s ? { totalMs: s.totalMs, maxSliceMs: s.maxSliceMs } : null; })(),
      rival: { loops: h.rival.loops, comparable: h.rival.comparable, weFound: h.rival.weFound,
        leadMsMedian: leads.length ? leads[Math.floor(leads.length / 2)] : null, longer: h.rival.longer, unseen: h.rival.unseen, topBot: top },
      checkVsEstimate: summarizeLoopChecks(h.checks),
      ...(this.deps.coinTax || (this.cfg.benchAfter ?? 0) > 0 ? { coins: {
        tax: this.deps.coinTax ? this.deps.coinTax.stats() : null,
        taxPools: this.taxPools,
        waitTest: h.waitTest, benchedSkips: h.benchedSkips, benchStarts: h.benchStarts,
        benchedNow: (() => { const t = this.deps.env.now(); let n = 0; for (const v of this.bench.values()) if (v.until > t) n++; return n; })(),
      } } : {}),
    };
  }
}
