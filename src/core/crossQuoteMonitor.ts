import type { PoolState } from './types';
import type { ScannedPool } from './universeScan';
import { refreshPoolsBatch } from './pairWatcher';
import { priceOf } from './poolPrice';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';

// ============================================================================
// CROSS-QUOTE MONITOR -- do tokens priced in USDG and in ETH disagree, and
// is it worse around the US stock market open? (measurement only)
//
// Plain English:
//   Many tokens on Robinhood Chain (stock tokens like AMZN, AAPL, and others)
//   trade in a USDG pool AND an ETH pool. Each pool only moves when someone
//   trades in it, so when news hits (e.g. the 9:30 stock market open) one pool
//   can move while the other lags. That gap is an arbitrage:
//     USDG -> ETH -> token (cheap pool) -> USDG (dear pool)
//
//   Every 15 s (5 s around the open) we read each such token's price in both
//   pools and record the gap, before and after fees. The MARKET OPEN REPORT
//   compares 9:00-10:30 Toronto time with the rest of the day.
//
// Read-only. Never trades. One bundled read per tick on the free node.
// ============================================================================

type CallMany = (calls: { target: string; data: string }[]) => Promise<(string | null)[]>;

const SEL_BALANCE = '0x70a08231';
const SEL_DECIMALS = '0x313ce567';
const SEL_SYMBOL = '0x95d89b41';
const SEL_FEE = '0xddca3f43';
const pad = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const big = (r: string | null) => { try { return r && r !== '0x' ? BigInt(r.slice(0, 66)) : null; } catch { return null; } };
const decodeSymbol = (r: string | null): string => {
  if (!r || r === '0x') return '?';
  try {
    if (r.length >= 194) { // dynamic string: offset, length, data
      const len = Number(BigInt('0x' + r.slice(66, 130)));
      return Buffer.from(r.slice(130, 130 + len * 2), 'hex').toString('utf8').replace(/[^\x20-\x7e]/g, '') || '?';
    }
    return Buffer.from(r.slice(2, 66), 'hex').toString('utf8').replace(/[^\x20-\x7e]/g, '') || '?'; // bytes32 symbol
  } catch { return '?'; }
};

export interface TokenLeg { pool: PoolState; quote: 'usdg' | 'weth'; feePct: number; quoteUsd: number }
export interface GapStats { maxGapPct: number; maxNetPct: number; secondsProfitable: number; samples: number; lastPriceUsd: number | null }
export interface GapRow { symbol: string; token: string; open: GapStats; rest: GapStats }

const emptyStats = (): GapStats => ({ maxGapPct: 0, maxNetPct: -Infinity, secondsProfitable: 0, samples: 0, lastPriceUsd: null });

export class CrossQuoteMonitor {
  private legs = new Map<string, TokenLeg[]>();     // token -> its USDG and WETH pools
  private symbols = new Map<string, string>();
  private decimals = new Map<string, number>();
  private day = '';
  private stats = new Map<string, { open: GapStats; rest: GapStats }>();
  private lastTickMs = 0;

  constructor(
    private readonly callMany: CallMany,
    private readonly usdg: string,
    private readonly weth: string,
    private readonly wethUsd: () => number | null,
    private readonly now: () => number = Date.now,
  ) {}

  tokenCount() { return this.legs.size; }

  // Pick tokens with at least one USDG pool AND one WETH pool, each holding at
  // least minQuoteUsd of the quote coin; keep the maxTokens deepest.
  async setup(scanned: ScannedPool[], maxTokens = 60, minQuoteUsd = 1_000): Promise<number> {
    const usdg = this.usdg.toLowerCase(), weth = this.weth.toLowerCase();
    const byToken = new Map<string, ScannedPool[]>();
    for (const p of scanned) {
      if (p.stable) continue;
      const t0 = p.token0.toLowerCase(), t1 = p.token1.toLowerCase();
      const quote = [usdg, weth].includes(t0) ? t0 : [usdg, weth].includes(t1) ? t1 : null;
      if (!quote) continue;
      const token = quote === t0 ? t1 : t0;
      if (token === usdg || token === weth) continue;
      (byToken.get(token) ?? byToken.set(token, []).get(token)!).push(p);
    }
    const cands = [...byToken.entries()].filter(([, ps]) => {
      const qs = new Set(ps.map((p) => ([p.token0, p.token1].map((x) => x.toLowerCase()).includes(usdg) ? 'usdg' : 'weth')));
      return qs.size === 2;
    });
    if (!cands.length) return 0;

    // Quote-side balance of every candidate pool (one bundled read).
    const pools = cands.flatMap(([token, ps]) => ps.map((p) => ({ token, p, quote: [p.token0, p.token1].map((x) => x.toLowerCase()).includes(usdg) ? usdg : weth })));
    const bal = await this.callMany(pools.map((x) => ({ target: x.quote, data: SEL_BALANCE + pad(x.p.pool) })));
    const ethUsd = this.wethUsd() ?? 0;
    const deep = pools.map((x, i) => {
      const raw = big(bal[i]) ?? 0n;
      const usd = x.quote === usdg ? Number(raw) / 1e6 : (Number(raw) / 1e18) * ethUsd;
      return { ...x, usd };
    }).filter((x) => x.usd >= minQuoteUsd);

    // Tokens still having both quotes after the depth filter, deepest first.
    const per = new Map<string, typeof deep>();
    for (const x of deep) (per.get(x.token) ?? per.set(x.token, []).get(x.token)!).push(x);
    const chosen = [...per.entries()]
      .filter(([, xs]) => new Set(xs.map((x) => x.quote)).size === 2)
      .sort((a, b) => b[1].reduce((s, x) => s + x.usd, 0) - a[1].reduce((s, x) => s + x.usd, 0))
      .slice(0, maxTokens);

    // Decimals + symbols of the chosen tokens, fees of their V3 pools.
    const toks = chosen.map(([t]) => t);
    const meta = await this.callMany(toks.flatMap((t) => [{ target: t, data: SEL_DECIMALS }, { target: t, data: SEL_SYMBOL }]));
    toks.forEach((t, i) => {
      const d = big(meta[i * 2]);
      if (d !== null && d <= 36n) this.decimals.set(t, Number(d));
      this.symbols.set(t, decodeSymbol(meta[i * 2 + 1]));
    });
    const v3 = chosen.flatMap(([, xs]) => xs).filter((x) => x.p.kind === 'v3');
    const fees = await this.callMany(v3.map((x) => ({ target: x.p.pool, data: SEL_FEE })));
    const feeOf = new Map<string, number>();
    v3.forEach((x, i) => { const f = big(fees[i]); if (f !== null) feeOf.set(x.p.pool.toLowerCase(), Number(f) / 10_000); }); // pips -> %

    this.legs.clear();
    for (const [token, xs] of chosen) {
      if (!this.decimals.has(token)) continue;
      this.legs.set(token, xs.map((x) => ({
        quote: x.quote === usdg ? 'usdg' as const : 'weth' as const,
        quoteUsd: x.usd,
        feePct: x.p.kind === 'v3' ? (feeOf.get(x.p.pool.toLowerCase()) ?? 0.3) : 0.3,
        pool: {
          chain: 'robinhood', dex: x.p.dex, poolAddress: x.p.pool, poolType: x.p.kind === 'v3' ? 'v3' : 'v2',
          tokenA: x.p.token0, tokenB: x.p.token1, feeBps: 30, lastUpdatedMs: 0,
        } as PoolState,
      })));
    }
    return this.legs.size;
  }

  private decimalsOf = (_c: string, t: string): number => {
    const l = t.toLowerCase();
    if (l === this.usdg.toLowerCase()) return 6;
    if (l === this.weth.toLowerCase()) return 18;
    return this.decimals.get(l) ?? 18;
  };

  // One measurement: read all pools, compute each token's gap, add to stats.
  // inOpen: is it the market-open window right now. dayKey: Toronto date.
  async tick(inOpen: boolean, dayKey: string): Promise<number> {
    if (!this.legs.size) return 0;
    if (dayKey !== this.day) { this.day = dayKey; this.stats.clear(); }
    const all = [...this.legs.values()].flat();
    const fresh = await refreshPoolsBatch(this.callMany, all.map((l) => l.pool));
    const byAddr = new Map(fresh.map((p) => [p.poolAddress.toLowerCase(), p]));
    const ethUsd = this.wethUsd();
    if (!ethUsd) return 0;
    const t = this.now();
    const dt = this.lastTickMs ? Math.min(60, (t - this.lastTickMs) / 1000) : 0;
    this.lastTickMs = t;
    let measured = 0;
    for (const [token, legs] of this.legs) {
      // Deepest live pool per quote.
      const best = (q: 'usdg' | 'weth') => legs.filter((l) => l.quote === q && byAddr.has(l.pool.poolAddress.toLowerCase()))
        .sort((a, b) => b.quoteUsd - a.quoteUsd)[0];
      const u = best('usdg'), w = best('weth');
      if (!u || !w) continue;
      const pu = priceOf(byAddr.get(u.pool.poolAddress.toLowerCase())!, token, this.decimalsOf);        // token in USDG
      const pw = priceOf(byAddr.get(w.pool.poolAddress.toLowerCase())!, token, this.decimalsOf);        // token in WETH
      if (!pu || !pw || !isFinite(pu) || !isFinite(pw)) continue;
      const viaEth = pw * ethUsd;
      const gap = (Math.abs(pu - viaEth) / Math.min(pu, viaEth)) * 100;
      if (gap > 50) continue; // broken pool / wrong decimals: ignore
      const net = gap - (u.feePct + w.feePct + 0.05); // + the ETH/USDG leg (~0.05%)
      const s = this.stats.get(token) ?? { open: emptyStats(), rest: emptyStats() };
      const g = inOpen ? s.open : s.rest;
      g.samples++;
      g.maxGapPct = Math.max(g.maxGapPct, gap);
      g.maxNetPct = Math.max(g.maxNetPct, net);
      if (net > 0) g.secondsProfitable += dt;
      g.lastPriceUsd = pu;
      this.stats.set(token, s);
      measured++;
    }
    return measured;
  }

  // Rows for the report, biggest after-fee gap at the open first.
  rows(): GapRow[] {
    return [...this.stats.entries()].map(([token, s]) => ({ token, symbol: this.symbols.get(token) ?? token.slice(0, 8), open: s.open, rest: s.rest }))
      .sort((a, b) => b.open.maxNetPct - a.open.maxNetPct);
  }
}

// ============================================================================
// LOOP MONITOR -- loop measurement, Phase A (measurement only, never trades)
//
// Plain English:
//   The monitor above compares each token's USDG pool with its ETH pool. This
//   one does the same across ALL verified "quote" coins (see tokenGroups.ts:
//   dollar coins, WETH, Bitcoin versions, verified copies). For every token
//   that trades against 2+ of them it looks for the best 3-pool loop, e.g.
//     USDG -> HOOD (cheap pool) -> USDT (dear pool) -> USDG (USDT/USDG pool)
//   and measures the gap AFTER all three pools' real fees (V3 fees are read
//   from each pool; V2-style pools use their exchange's fixed fee). The
//   conversion back (USDT -> USDG above) uses that pool's REAL price, never
//   an assumed 1:1.
//
//   It also watches the groups themselves: how far a direct pool between
//   two "same value" coins sits from 1:1 (USDT/USDG, WBTC/cbBTC...), the gap
//   between two such pools after fees, and native ETH pools vs WETH pools
//   for the same token (Uniswap V4, from the bot's pool cache).
//
//   Junk: a gap above 10% almost all the time is a broken coin, not a chance
//   (ROBINCAT showed 38% all day), so those are left out of the verdict.
//   Numbers are "on a tiny trade": a real trade moves the price and gets less.
//
// Reads go through the gentle scan lane on the free node (bundled reads).
// ============================================================================

export interface LoopQuote { token: string; symbol: string; group: string; priceUsd: number }
export interface LoopLegInfo { pool: PoolState; quote: string; feePct: number; depthUsd: number; label: string }
export interface LoopStats {
  samples: number;
  hugeSamples: number;          // gap above 10% (or unreadable-huge): junk signal
  maxGapPct: number;            // before fees
  maxNetPct: number;            // after all three fees
  secondsProfitable: number;    // time with a gap left after fees
  longestRunS: number;          // longest unbroken stretch worth trading
  curRunS: number;
  best: { route: string; netPct: number; shallowUsd: number } | null; // the loop at its best moment
}
export interface LoopRow { token: string; symbol: string; stats: LoopStats; broken: boolean }
export interface PegStats {
  samples: number;
  maxDevPct: number;            // furthest from 1:1 (or from the other pool)
  maxNetPct: number;            // two-pool gap after fees (-Infinity if only one pool)
  secondsProfitable: number;
  longestRunS: number;
  curRunS: number;
}
export interface PegRow { label: string; group: string; stats: PegStats }

export const JUNK_GAP_PCT = 10;     // above this "all the time" = broken coin
const JUNK_SHARE = 0.8;              // ... in at least 80% of readings
const JUNK_MIN_SAMPLES = 20;
const UNREADABLE_GAP_PCT = 50;      // above this: wrong decimals / broken pool, never a max

const emptyLoop = (): LoopStats => ({ samples: 0, hugeSamples: 0, maxGapPct: 0, maxNetPct: -Infinity, secondsProfitable: 0, longestRunS: 0, curRunS: 0, best: null });
const emptyPeg = (): PegStats => ({ samples: 0, maxDevPct: 0, maxNetPct: -Infinity, secondsProfitable: 0, longestRunS: 0, curRunS: 0 });

// Is this token broken (gap above 10% nearly every time we looked)?
export function isBrokenLoop(s: LoopStats): boolean {
  return s.samples >= JUNK_MIN_SAMPLES && s.hugeSamples / s.samples >= JUNK_SHARE;
}

// The best loop for one token given live prices. Pure (unit-tested).
//   legs: the token's pools, each priced as "token in quote units"
//   conv: price of quote B in quote A units for a pair of quotes, with fee
// Returns the loop with the most left after fees, or null.
export interface PricedLeg { leg: LoopLegInfo; px: number }
export interface PricedConv { a: string; b: string; px: number; feePct: number; pool: string; depthUsd: number; label: string } // px = b in a units
export function bestLoop(
  legs: PricedLeg[], conv: (a: string, b: string) => PricedConv | null, sym: (t: string) => string, tokenSym: string,
): { gapPct: number; netPct: number; route: string; shallowUsd: number } | null {
  let best: { gapPct: number; netPct: number; route: string; shallowUsd: number } | null = null;
  for (const l1 of legs) for (const l2 of legs) {
    if (l1.leg.quote >= l2.leg.quote) continue; // each pair of quotes once
    const c = conv(l1.leg.quote, l2.leg.quote);
    if (!c || c.pool === l1.leg.pool.poolAddress.toLowerCase() || c.pool === l2.leg.pool.poolAddress.toLowerCase()) continue;
    // x > 1: start with A, buy the token on leg 1, sell it for B on leg 2,
    // turn B back into A. x < 1: the same loop the other way round.
    const x = (l2.px * c.px) / l1.px;
    if (!(x > 0) || !Number.isFinite(x)) continue;
    const gapPct = (Math.max(x, 1 / x) - 1) * 100;
    const netPct = gapPct - (l1.leg.feePct + l2.leg.feePct + c.feePct);
    if (best && netPct <= best.netPct) continue;
    const a = sym(l1.leg.quote), b = sym(l2.leg.quote);
    const route = x > 1
      ? `${a} → ${tokenSym} (${l1.leg.label}) → ${b} (${l2.leg.label}) → ${a} (${c.label})`
      : `${b} → ${tokenSym} (${l2.leg.label}) → ${a} (${l1.leg.label}) → ${b} (${c.label})`;
    best = { gapPct, netPct, route, shallowUsd: Math.min(l1.leg.depthUsd, l2.leg.depthUsd, c.depthUsd) };
  }
  return best;
}

const V2_FEE_PCT: Record<string, number> = { 'uniswap-v2': 0.3, 'pancakeswap-v2': 0.25, 'ramses-v2': 0.2 };

// Add one reading to running stats. dt = seconds since the last reading.
function addLoopSample(s: LoopStats, r: { gapPct: number; netPct: number; route: string; shallowUsd: number } | null, dt: number) {
  s.samples++;
  if (!r) { s.curRunS = 0; return; }
  if (r.gapPct > JUNK_GAP_PCT) s.hugeSamples++;
  if (r.gapPct > UNREADABLE_GAP_PCT) { s.curRunS = 0; return; }
  s.maxGapPct = Math.max(s.maxGapPct, r.gapPct);
  if (r.netPct > s.maxNetPct) { s.maxNetPct = r.netPct; s.best = { route: r.route, netPct: r.netPct, shallowUsd: r.shallowUsd }; }
  if (r.netPct > 0) { s.secondsProfitable += dt; s.curRunS += dt; s.longestRunS = Math.max(s.longestRunS, s.curRunS); } else s.curRunS = 0;
}
function addPegSample(s: PegStats, devPct: number, netPct: number | null, dt: number) {
  if (!Number.isFinite(devPct) || devPct > UNREADABLE_GAP_PCT) return;
  s.samples++;
  s.maxDevPct = Math.max(s.maxDevPct, devPct);
  if (netPct !== null) {
    s.maxNetPct = Math.max(s.maxNetPct, netPct);
    if (netPct > 0) { s.secondsProfitable += dt; s.curRunS += dt; s.longestRunS = Math.max(s.longestRunS, s.curRunS); } else s.curRunS = 0;
  }
}

export class LoopMonitor {
  private quotes = new Map<string, LoopQuote>();            // verified quote coins
  private legs = new Map<string, LoopLegInfo[]>();          // token -> its pools against quotes
  private convs = new Map<string, LoopLegInfo[]>();         // "a|b" (sorted) -> direct pools between two quotes, deepest first
  private symbols = new Map<string, string>();
  private decimals = new Map<string, number>();
  private loops = new Map<string, LoopStats>();
  private pegs = new Map<string, { group: string; s: PegStats }>();
  private lastTickMs = 0;
  periodStart: number;

  constructor(
    private readonly callMany: CallMany,
    private readonly now: () => number = Date.now,
    // Native-ETH pools vs WETH pools of the same token (bot's pool cache;
    // Uniswap V4 pools aren't in the factory scan). Optional.
    private readonly ethWethPairs?: () => { label: string; token: string; native: PoolState; wrapped: PoolState }[],
    private readonly cacheDecimals?: (token: string) => number | undefined,
  ) { this.periodStart = now(); }

  tokenCount() { return this.legs.size; }
  quoteCount() { return this.quotes.size; }
  quoteList(): LoopQuote[] { return [...this.quotes.values()]; }

  private label(p: ScannedPool, feePct: number) { return `${p.dex}${p.kind === 'v3' ? ` ${feePct}%` : ''}`; }

  // Pick tokens that trade against 2+ verified quote coins (with a pool
  // between those two quotes to close the loop), keep the deepest maxTokens.
  async setup(scanned: ScannedPool[], quotes: LoopQuote[], maxTokens = 80, minQuoteUsd = 2_000): Promise<number> {
    this.quotes = new Map(quotes.map((q) => [q.token.toLowerCase(), { ...q, token: q.token.toLowerCase() }]));
    const Q = this.quotes;
    // Pools touching a quote coin, grouped by the token on the other side.
    // A pool between two quotes counts for both sides.
    const byToken = new Map<string, { p: ScannedPool; quote: string }[]>();
    for (const p of scanned) {
      if (p.stable) continue;
      const t0 = p.token0.toLowerCase(), t1 = p.token1.toLowerCase();
      if (Q.has(t1)) (byToken.get(t0) ?? byToken.set(t0, []).get(t0)!).push({ p, quote: t1 });
      if (Q.has(t0)) (byToken.get(t1) ?? byToken.set(t1, []).get(t1)!).push({ p, quote: t0 });
    }
    // Only tokens with 2+ different quotes can loop (cheap filter before any
    // read). Quote coins themselves are always kept: their pools with each
    // other (USDT/USDG...) are what closes the loops.
    const cands = [...byToken.entries()].filter(([t, xs]) => Q.has(t) || new Set(xs.map((x) => x.quote)).size >= 2);
    if (!cands.length) { this.legs.clear(); this.convs.clear(); return 0; }

    // Quote-side balance of each candidate pool, V3 fees: one bundled read.
    const flat = cands.flatMap(([token, xs]) => xs.map((x) => ({ token, ...x })));
    const uniqPools = [...new Map(flat.map((x) => [x.p.pool.toLowerCase(), x.p])).values()];
    const res = await this.callMany([
      ...flat.map((x) => ({ target: x.quote, data: SEL_BALANCE + pad(x.p.pool) })),
      ...uniqPools.map((p) => ({ target: p.pool, data: SEL_FEE })),
    ]);
    const feeOf = new Map<string, number>();
    uniqPools.forEach((p, i) => {
      const f = big(res[flat.length + i]);
      feeOf.set(p.pool.toLowerCase(), p.kind === 'v3' && f !== null ? Number(f) / 10_000 : V2_FEE_PCT[p.dex] ?? 0.3);
    });
    // Decimals of quotes (needed to value balances) and of tokens.
    const toks = [...new Set([...Q.keys(), ...cands.map(([t]) => t)])];
    const meta = await this.callMany(toks.flatMap((t) => [{ target: t, data: SEL_DECIMALS }, { target: t, data: SEL_SYMBOL }]));
    toks.forEach((t, i) => {
      const d = big(meta[i * 2]);
      if (d !== null && d <= 36n) this.decimals.set(t, Number(d));
      this.symbols.set(t, Q.get(t)?.symbol ?? decodeSymbol(meta[i * 2 + 1]));
    });

    const legsByToken = new Map<string, LoopLegInfo[]>();
    flat.forEach((x, i) => {
      const dq = this.decimals.get(x.quote);
      const q = Q.get(x.quote)!;
      if (dq === undefined || !this.decimals.has(x.token)) return;
      const usd = (Number(big(res[i]) ?? 0n) / 10 ** dq) * q.priceUsd;
      if (!(usd >= minQuoteUsd)) return;
      const feePct = feeOf.get(x.p.pool.toLowerCase()) ?? 0.3;
      const leg: LoopLegInfo = {
        quote: x.quote, feePct, depthUsd: 2 * usd, label: this.label(x.p, feePct),
        pool: {
          chain: 'robinhood', dex: x.p.dex, poolAddress: x.p.pool, poolType: x.p.kind === 'v3' ? 'v3' : 'v2',
          tokenA: x.p.token0, tokenB: x.p.token1, feeBps: Math.round(feePct * 100), lastUpdatedMs: 0,
        } as PoolState,
      };
      (legsByToken.get(x.token) ?? legsByToken.set(x.token, []).get(x.token)!).push(leg);
    });

    // Direct pools between two quotes (they close the loops), deepest first.
    this.convs.clear();
    for (const [token, ls] of legsByToken) {
      if (!Q.has(token)) continue;
      for (const l of ls) {
        const k = [token, l.quote].sort().join('|');
        const list = this.convs.get(k) ?? this.convs.set(k, []).get(k)!;
        if (!list.some((x) => x.pool.poolAddress.toLowerCase() === l.pool.poolAddress.toLowerCase())) list.push(l);
      }
    }
    for (const list of this.convs.values()) list.sort((a, b) => b.depthUsd - a.depthUsd);

    // Per token: the 2 deepest pools per quote; keep tokens that can close a loop.
    const chosen: [string, LoopLegInfo[]][] = [];
    for (const [token, ls] of legsByToken) {
      const per = new Map<string, LoopLegInfo[]>();
      for (const l of ls.sort((a, b) => b.depthUsd - a.depthUsd)) {
        const xs = per.get(l.quote) ?? per.set(l.quote, []).get(l.quote)!;
        if (xs.length < 2) xs.push(l);
      }
      const qs = [...per.keys()];
      const closes = qs.some((a, i) => qs.slice(i + 1).some((b) => this.convs.has([a, b].sort().join('|'))));
      if (closes) chosen.push([token, [...per.values()].flat()]);
    }
    chosen.sort((a, b) => b[1].reduce((s, l) => s + l.depthUsd, 0) - a[1].reduce((s, l) => s + l.depthUsd, 0));
    this.legs = new Map(chosen.slice(0, maxTokens));
    return this.legs.size;
  }

  private dec = (_c: string, t: string): number => this.decimals.get(t.toLowerCase()) ?? this.cacheDecimals?.(t) ?? 18;
  private sym = (t: string): string => this.symbols.get(t.toLowerCase()) ?? t.slice(0, 8);

  // One measurement round: read every pool once, find each token's best loop.
  async tick(): Promise<number> {
    if (!this.legs.size && !this.ethWethPairs) return 0;
    const all = new Map<string, PoolState>();
    for (const ls of this.legs.values()) for (const l of ls) all.set(l.pool.poolAddress.toLowerCase(), l.pool);
    for (const ls of this.convs.values()) for (const l of ls.slice(0, 2)) all.set(l.pool.poolAddress.toLowerCase(), l.pool);
    const fresh = all.size ? await refreshPoolsBatch(this.callMany, [...all.values()]) : [];
    const live = new Map(fresh.map((p) => [p.poolAddress.toLowerCase(), p]));
    const t = this.now();
    const dt = this.lastTickMs ? Math.min(120, (t - this.lastTickMs) / 1000) : 0;
    this.lastTickMs = t;

    // Price of B in A units through the deepest live direct pool.
    const convCache = new Map<string, PricedConv | null>();
    const conv = (a: string, b: string): PricedConv | null => {
      const k = `${a}|${b}`;
      if (convCache.has(k)) return convCache.get(k)!;
      const list = this.convs.get([a, b].sort().join('|')) ?? [];
      let out: PricedConv | null = null;
      for (const l of list) {
        const p = live.get(l.pool.poolAddress.toLowerCase());
        const px = p ? priceOf(p, b, this.dec) : null; // B in A units
        if (px && Number.isFinite(px)) { out = { a, b, px, feePct: l.feePct, pool: l.pool.poolAddress.toLowerCase(), depthUsd: l.depthUsd, label: l.label }; break; }
      }
      convCache.set(k, out);
      return out;
    };

    let measured = 0;
    for (const [token, legs] of this.legs) {
      const priced: PricedLeg[] = [];
      for (const leg of legs) {
        const p = live.get(leg.pool.poolAddress.toLowerCase());
        const px = p ? priceOf(p, token, this.dec) : null;
        if (px && Number.isFinite(px) && px > 0) priced.push({ leg, px });
      }
      const r = bestLoop(priced, conv, this.sym, this.sym(token));
      const s = this.loops.get(token) ?? emptyLoop();
      addLoopSample(s, r, dt);
      this.loops.set(token, s);
      if (r) measured++;
    }

    // Groups: direct pools between two coins of the same group.
    for (const [k, list] of this.convs) {
      const [a, b] = k.split('|');
      const qa = this.quotes.get(a), qb = this.quotes.get(b);
      if (!qa || !qb || qa.group !== qb.group) continue;
      const pxs = list.slice(0, 2).map((l) => {
        const p = live.get(l.pool.poolAddress.toLowerCase());
        return p ? { px: priceOf(p, a, this.dec), fee: l.feePct } : null;
      }).filter((x): x is { px: number; fee: number } => !!x && !!x.px && Number.isFinite(x.px));
      if (!pxs.length) continue;
      // Copies (bridged coins, same stock from two issuers) aren't promised
      // to be 1:1, so their "fair" ratio is today's USD prices from setup.
      const fair = qa.group === 'Dollars' || qa.group === 'Bitcoin' || qa.group === 'ETH' ? 1 : qa.priceUsd / qb.priceUsd;
      const dev = Math.max(...pxs.map((x) => Math.abs(x.px / fair - 1) * 100));
      const net = pxs.length === 2 ? (Math.max(pxs[0].px, pxs[1].px) / Math.min(pxs[0].px, pxs[1].px) - 1) * 100 - pxs[0].fee - pxs[1].fee : null;
      const label = `${this.sym(a)} vs ${this.sym(b)}`;
      const e = this.pegs.get(label) ?? { group: qa.group, s: emptyPeg() };
      addPegSample(e.s, dev, net, dt);
      this.pegs.set(label, e);
    }

    // ETH vs WETH: the same token's native-ETH pool against its WETH pool.
    for (const pr of this.ethWethPairs?.() ?? []) {
      // Both pools price `token` against ETH (native) or WETH: compare directly.
      const a = priceOf(pr.native, pr.token, this.dec), b = priceOf(pr.wrapped, pr.token, this.dec);
      if (!a || !b || !Number.isFinite(a) || !Number.isFinite(b)) continue;
      const gap = (Math.max(a, b) / Math.min(a, b) - 1) * 100;
      const net = gap - pr.native.feeBps / 100 - pr.wrapped.feeBps / 100; // wrapping ETH is free
      const e = this.pegs.get(pr.label) ?? { group: 'ETH vs WETH', s: emptyPeg() };
      addPegSample(e.s, gap, net, dt);
      this.pegs.set(pr.label, e);
    }
    return measured;
  }

  // Report rows, best after-fee gap first.
  rows(): LoopRow[] {
    return [...this.loops.entries()].map(([token, stats]) => ({ token, symbol: this.sym(token), stats, broken: isBrokenLoop(stats) }))
      .sort((a, b) => b.stats.maxNetPct - a.stats.maxNetPct);
  }
  pegRows(): PegRow[] {
    return [...this.pegs.entries()].map(([label, e]) => ({ label, group: e.group, stats: e.s }))
      .sort((a, b) => b.stats.maxNetPct - a.stats.maxNetPct || b.stats.maxDevPct - a.stats.maxDevPct);
  }

  // Start a new report period (after a report is sent).
  resetPeriod() { this.loops.clear(); this.pegs.clear(); this.periodStart = this.now(); }

  // One status-page line.
  statusLine(): string {
    const rows = this.rows();
    const ok = rows.filter((r) => !r.broken && r.stats.maxNetPct > 0);
    const top = rows.find((r) => !r.broken);
    const broken = rows.filter((r) => r.broken).length;
    return `[loops] ${this.legs.size} tokens across ${this.quotes.size} quote coins; ${ok.length} with a gap after fees since ${new Date(this.periodStart).toISOString().slice(11, 16)} UTC`
      + (top && top.stats.samples ? `; best ${top.symbol} ${top.stats.maxNetPct.toFixed(2)}% after fees (${Math.round(top.stats.secondsProfitable)} s)` : '')
      + `; ${broken} broken coin(s) ignored; ${this.pegs.size} group pool(s) watched`;
  }

  // Saved so a restart (every deploy) doesn't lose the period's numbers.
  save(file: string) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file + '.tmp', JSON.stringify({ periodStart: this.periodStart, loops: [...this.loops.entries()], symbols: [...this.symbols.entries()].filter(([k]) => this.loops.has(k)), pegs: [...this.pegs.entries()] }));
      renameSync(file + '.tmp', file);
    } catch { /* best effort */ }
  }
  load(file: string) {
    try {
      const d = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof d.periodStart === 'number') this.periodStart = d.periodStart;
      // -Infinity doesn't survive JSON (it becomes null): put it back.
      const fix = (o: any) => { if (o.maxNetPct === null) o.maxNetPct = -Infinity; o.curRunS = 0; return o; };
      this.loops = new Map((d.loops ?? []).map(([k, v]: [string, LoopStats]) => [k, fix(v)]));
      this.pegs = new Map((d.pegs ?? []).map(([k, v]: [string, { group: string; s: PegStats }]) => [k, { group: v.group, s: fix(v.s) }]));
      for (const [k, v] of d.symbols ?? []) if (!this.symbols.has(k)) this.symbols.set(k, v);
    } catch { /* first run */ }
  }
}
