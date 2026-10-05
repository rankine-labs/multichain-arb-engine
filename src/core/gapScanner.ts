import { PoolState } from './types';
import { bestArb } from './backtest';

// ============================================================================
// STANDING-GAP SCANNER -- finds arbs that exist WITHOUT a trigger trade
//
// Plain English:
//   The main engine reacts to trades it sees in the feed. But a price gap can
//   also appear from a trade the bot couldn't read (another router, another
//   bot's contract, Uniswap V4...) or just sit there. Every time all pool
//   prices are re-synced (every 5 s), this checks every watched pair: "is one
//   pool cheaper than another by more than the costs?" Same maths as the
//   backtest (core/backtest.ts): constant product, V3 within its current range,
//   trade size capped.
// ============================================================================

export interface StandingGap {
  pairKey: string;
  base: string;            // token bought on buyPool and sold on sellPool
  quote: string;           // token we start and end with (has a USD price)
  buyPool: PoolState;      // quote -> base
  sellPool: PoolState;     // base -> quote
  sizeQuote: number;       // input amount, human units of quote
  sizeUsd: number;
  profitUsd: number;       // after both pool fees, flash fee and gas
  quoteUsd: number;
}

export interface GapOptions {
  minProfitUsd: number;
  flashFee: number;        // fraction
  gasUsd: number;
  maxTradeUsd: number;
}

const Q96 = 2 ** 96;

// Human-unit reserves in (base, quote) orientation. tokenA is token0.
export function poolReserves(p: PoolState, base: string, dec0: number, dec1: number): { base: number; quote: number } | null {
  let x: number, y: number;
  if (p.poolType === 'v2') {
    if (p.reserveA === undefined || p.reserveB === undefined) return null;
    x = Number(p.reserveA) / 10 ** dec0;
    y = Number(p.reserveB) / 10 ** dec1;
  } else if (p.poolType === 'v3') {
    if (!p.sqrtPriceX96 || !p.liquidity) return null;
    const sqrtP = Number(p.sqrtPriceX96) / Q96;
    const L = Number(p.liquidity);
    x = L / sqrtP / 10 ** dec0;
    y = (L * sqrtP) / 10 ** dec1;
  } else {
    return null; // order books / stable curves: not modelled here
  }
  if (!(x > 0) || !(y > 0) || !isFinite(x) || !isFinite(y)) return null;
  return base.toLowerCase() === p.tokenA.toLowerCase() ? { base: x, quote: y } : { base: y, quote: x };
}

export function findStandingGaps(
  pairs: PoolState[][],
  decimalsOf: (token: string) => number | undefined,
  usdOf: (token: string) => number | null,
  opts: GapOptions,
): StandingGap[] {
  const out: StandingGap[] = [];
  for (const pools of pairs) {
    const usable = pools.filter((p) => p.poolType === 'v2' || p.poolType === 'v3');
    if (usable.length < 2) continue;
    const t0 = usable[0].tokenA.toLowerCase(), t1 = usable[0].tokenB.toLowerCase();
    const d0 = decimalsOf(t0), d1 = decimalsOf(t1);
    if (d0 === undefined || d1 === undefined) continue; // never guess decimals
    // Quote = the side with a USD price (prefer token1, usually the stable / WETH).
    const u1 = usdOf(t1), u0 = usdOf(t0);
    const [quote, base, quoteUsd] = u1 ? [t1, t0, u1] : u0 ? [t0, t1, u0] : [null, null, 0];
    if (!quote || !base || !(quoteUsd > 0)) continue;

    let best: StandingGap | null = null;
    for (const buy of usable) {
      const dB0 = buy.tokenA.toLowerCase() === t0 ? d0 : d1, dB1 = buy.tokenA.toLowerCase() === t0 ? d1 : d0;
      const rb = poolReserves(buy, base, dB0, dB1);
      if (!rb) continue;
      for (const sell of usable) {
        if (sell === buy) continue;
        const dS0 = sell.tokenA.toLowerCase() === t0 ? d0 : d1, dS1 = sell.tokenA.toLowerCase() === t0 ? d1 : d0;
        const rs = poolReserves(sell, base, dS0, dS1);
        if (!rs) continue;
        const r = bestArb(rb, buy.feeBps / 10_000, rs, sell.feeBps / 10_000, opts.flashFee, opts.maxTradeUsd / quoteUsd);
        const profitUsd = r.profit * quoteUsd - opts.gasUsd;
        if (profitUsd > (best?.profitUsd ?? 0)) {
          best = { pairKey: [t0, t1].sort().join('/'), base, quote, buyPool: buy, sellPool: sell,
            sizeQuote: r.dx, sizeUsd: r.dx * quoteUsd, profitUsd, quoteUsd };
        }
      }
    }
    if (best && best.profitUsd >= opts.minProfitUsd) out.push(best);
  }
  return out.sort((a, b) => b.profitUsd - a.profitUsd);
}
