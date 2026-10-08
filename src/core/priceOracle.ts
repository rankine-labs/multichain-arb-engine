import { ChainName, PoolState } from './types';
import { PoolCache } from './poolCache';
import { priceOf, poolReserves } from './poolPrice';
import type { V3BalanceBook } from './v3BalanceBook';

// ============================================================================
// PRICE ORACLE
//
// Every profit calculation, the gas-cost estimate, the trade-size limit and
// the pool depth filter need a real USD price per token. Rather than calling
// an external price API (one more network call near the hot path), we derive
// price from the pool cache we already keep in memory.
//
// Method:
//   1. Stablecoins are $1.00 by definition.
//   2. Direct: the DEEPEST pool pairing the token with a stablecoin.
//   3. One hop: the deepest pool pairing the token with a token that has a
//      direct stable price (e.g. TOKEN/WETH, then WETH/USDG).
//
// Fixes (Oct 2026 audit):
//   - Uses each token's REAL decimals. The old version assumed 18 for all,
//     so with USDG (6 decimals) WETH came out at $0.000000003, which made the
//     $25k depth filter throw away every WETH pool, gas look free, and the
//     max-trade-size check meaningless.
//   - Reads V3/V4 pools too (not just V2), via the shared poolPrice helpers.
//   - Picks the deepest pool instead of the first one found, and ignores
//     pools too shallow to trust (a dust pool can show any price).
//   - Unknown decimals: that pool is skipped rather than guessed.
//   - Results are memoised briefly: the depth filter asks for prices many
//     times per swap, and the one-hop search is O(pools^2).
// ============================================================================

// Known stablecoins per chain, treated as $1.00 by definition.
// Populated via registerStablecoin() (see config/knownAddresses.ts).
const STABLECOINS: Record<ChainName, Set<string>> = {
  avalanche: new Set(),
  monad: new Set(),
  robinhood: new Set(),
};

export function registerStablecoin(chain: ChainName, tokenAddress: string) {
  STABLECOINS[chain].add(tokenAddress.toLowerCase());
}

// Decimals for a token, or undefined if not known yet.
export type StrictDecimals = (chain: string, token: string) => number | undefined;

// A pool must hold at least this much USD on its anchor side to be used for
// pricing. Below it, the pool's ratio is noise.
// $2,500 (was $500): thin junk pools were a likely source of absurd prices.
const MIN_ANCHOR_USD = Number(process.env.ORACLE_MIN_ANCHOR_USD ?? 2_500);

// A USD price plus where it came from. depthUsd is the rough total money in
// the pool the price was read from (2 x its anchor side, the usual
// "both sides are worth the same" estimate); Infinity for a stablecoin.
// Used by reports to ignore prices that come from shallow pools.
//
// depthSource (Phase 1 fix, Oct 8) says how the depth was measured:
//   'reserves'      V2-style pool: real reserves, honest
//   'real-balance'  V3 pool: capped at the coins the pool really holds
//                   (see core/v3BalanceBook.ts), honest
//   'virtual'       V3/V4 pool with no real balance known: "virtual reserves"
//                   can be many times the real money in a narrow-band pool,
//                   so treat as LOW confidence
//   'stable'        a stablecoin, $1 by definition
export type DepthSource = 'reserves' | 'real-balance' | 'virtual' | 'stable';
export interface PriceInfo { px: number; depthUsd: number; pool: string | null; depthSource?: DepthSource }

// Pick the pricing pool by its capped (real) depth instead of virtual depth.
// OFF by default so live detection is unchanged until approved; the depth
// REPORTED in PriceInfo is always the capped one.
const SELECT_BY_REAL_DEPTH = process.env.ORACLE_REAL_DEPTH_SELECT === '1';

type Quote = { px: number; depthUsd: number; pool: string; realUsd: number; source: DepthSource };

export class PriceOracle {
  private memo = new Map<string, { info: PriceInfo | null; at: number }>();

  constructor(
    private cache: PoolCache,
    // Default 18 keeps old callers/tests working; the bot passes a strict lookup.
    private decimals: StrictDecimals = () => 18,
    private memoMs = 1_000,
    private now: () => number = Date.now,
    // Real V3 pool balances (optional). Without it, V3 depth stays virtual.
    private balances?: V3BalanceBook,
  ) {}

  // Attach the balance book after construction (the bot builds it later).
  useBalances(book: V3BalanceBook) { this.balances = book; this.memo.clear(); }

  isStable(chain: ChainName, tokenAddress: string): boolean {
    return STABLECOINS[chain].has(tokenAddress.toLowerCase());
  }

  getUsdPrice(chain: ChainName, tokenAddress: string): number | null {
    return this.getUsdPriceInfo(chain, tokenAddress)?.px ?? null;
  }

  // Same price as getUsdPrice, plus how deep the pool behind it is.
  getUsdPriceInfo(chain: ChainName, tokenAddress: string): PriceInfo | null {
    if (this.isStable(chain, tokenAddress)) return { px: 1.0, depthUsd: Infinity, pool: null, depthSource: 'stable' };
    const key = `${chain}:${tokenAddress.toLowerCase()}`;
    const hit = this.memo.get(key);
    const t = this.now();
    if (hit && t - hit.at < this.memoMs) return hit.info;

    const best = this.directStablePrice(chain, tokenAddress) ?? this.oneHopStablePrice(chain, tokenAddress);
    // Total pool money ~ 2 x the anchor side (the side we can value), using
    // the capped (real) depth so thin narrow-band V3 pools don't look deep.
    const info: PriceInfo | null = best ? { px: best.px, depthUsd: 2 * best.realUsd, pool: best.pool, depthSource: best.source } : null;
    this.memo.set(key, { info, at: t });
    if (this.memo.size > 5_000) this.memo.clear(); // bound memory
    return info;
  }

  // Price of `token` in `anchor` units on pool p, plus how much USD sits on
  // the anchor side (used to pick the deepest pool). null if unusable.
  // realUsd = depthUsd capped at the anchor coins the pool really holds (V3
  // with a known balance); depthUsd stays the old virtual figure, used for
  // choosing the pool unless ORACLE_REAL_DEPTH_SELECT=1.
  private quote(p: PoolState, token: string, anchorUsd: number): Quote | null {
    const decT = this.decimals(p.chain, token);
    const other = p.tokenA.toLowerCase() === token.toLowerCase() ? p.tokenB : p.tokenA;
    const decO = this.decimals(p.chain, other);
    if (decT === undefined || decO === undefined) return null; // never guess decimals
    const dec = (_c: string, t: string) => (t.toLowerCase() === token.toLowerCase() ? decT : decO);
    const px = priceOf(p, token, dec);
    const r = poolReserves(p, dec);
    if (px === null || !r || !(px > 0) || !Number.isFinite(px)) return null;
    const anchorAmt = p.tokenA.toLowerCase() === other.toLowerCase() ? r.a : r.b;
    const virtualUsd = anchorAmt * anchorUsd;
    let realUsd = virtualUsd;
    let source: DepthSource = p.poolType === 'v3' ? 'virtual' : 'reserves';
    if (p.poolType === 'v3' && !p.v4 && this.balances) {
      const raw = this.balances.get(p.poolAddress, other);
      if (raw !== undefined) {
        realUsd = Math.min(virtualUsd, (Number(raw) / 10 ** decO) * anchorUsd);
        source = 'real-balance';
      }
    }
    const depthUsd = SELECT_BY_REAL_DEPTH ? realUsd : virtualUsd;
    if (!(depthUsd >= MIN_ANCHOR_USD)) return null;
    return { px: px * anchorUsd, depthUsd, pool: p.poolAddress.toLowerCase(), realUsd, source };
  }

  // Pools on this chain that contain `token`, with the other token.
  private poolsWith(chain: ChainName, token: string): { p: PoolState; other: string }[] {
    const t = token.toLowerCase();
    const out: { p: PoolState; other: string }[] = [];
    for (const p of this.cache.allForChain(chain)) {
      const a = p.tokenA.toLowerCase(), b = p.tokenB.toLowerCase();
      if (a === t) out.push({ p, other: b });
      else if (b === t) out.push({ p, other: a });
    }
    return out;
  }

  // Deepest pool pairing the token directly with a stablecoin.
  private directStablePrice(chain: ChainName, token: string): Quote | null {
    let best: Quote | null = null;
    for (const { p, other } of this.poolsWith(chain, token)) {
      if (!this.isStable(chain, other)) continue;
      const q = this.quote(p, token, 1);
      if (q && (!best || q.depthUsd > best.depthUsd)) best = q;
    }
    return best;
  }

  // Deepest pool pairing the token with an intermediate that has a direct
  // stable price (TOKEN/WETH -> WETH/USDG).
  private oneHopStablePrice(chain: ChainName, token: string): Quote | null {
    let best: Quote | null = null;
    const midPx = new Map<string, number | null>();
    for (const { p, other } of this.poolsWith(chain, token)) {
      if (this.isStable(chain, other)) continue; // direct case, already tried
      if (!midPx.has(other)) midPx.set(other, this.directStablePrice(chain, other)?.px ?? null);
      const mid = midPx.get(other);
      if (!mid) continue;
      const q = this.quote(p, token, mid);
      if (q && (!best || q.depthUsd > best.depthUsd)) best = q;
    }
    return best;
  }
}
