import type { PoolState } from './types';
import type { ScannedPool } from './universeScan';
import { refreshPoolsBatch } from './pairWatcher';
import { priceOf } from './poolPrice';

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
