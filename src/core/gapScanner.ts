import { PoolState } from './types';
import { bestArb } from './backtest';
import { feePipsOf } from './dexMath';
import { realBalanceOf } from './poolPrice';

// A pool's swap fee as a fraction (0.003 = 0.30%), from the exact fee in pips
// when known (hooked V4 / Fables fee source, Algebra dynamic fee, 250-pip V3
// tiers), else whole bps. Same value as feeBps / 10,000 for every other pool.
export const feeFraction = (p: PoolState): number => feePipsOf(p) / 1_000_000;

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
  // How many pool combinations to return per coin pair, best first (default 1).
  // The scanner asks for 3 so a muted best combination doesn't hide the others.
  perPair?: number;
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

// REAL BALANCE CAP (Oct 13, see core/poolPrice.ts). A V3 pool's reserves
// above are "virtual" and can be thousands of times what the pool really
// holds (the USDG/NVDA Uniswap 0.01% pool: ~$400k virtual, $83 real). The
// coin a pool PAYS OUT can never exceed its real balance, so both sides are
// shrunk by the same factor (the price stays the same, only the depth
// drops) until the paid-out side fits what is really there. Unknown
// balance (V2, V4, not read yet) = unchanged. Nothing at all = no pool.
export function capToRealBalance(
  r: { base: number; quote: number } | null, p: PoolState, outToken: string, outSide: 'base' | 'quote', outDecimals: number,
): { base: number; quote: number } | null {
  if (!r) return null;
  const raw = realBalanceOf(p, outToken);
  if (raw === undefined) return r;
  const real = Number(raw) / 10 ** outDecimals;
  if (!(real > 0)) return null;
  const k = Math.min(1, real / r[outSide]);
  return k < 1 ? { base: r.base * k, quote: r.quote * k } : r;
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

    const found: StandingGap[] = [];
    for (const buy of usable) {
      const dB0 = buy.tokenA.toLowerCase() === t0 ? d0 : d1, dB1 = buy.tokenA.toLowerCase() === t0 ? d1 : d0;
      // Buy pool pays out the base coin: only as much as it really holds.
      const rb = capToRealBalance(poolReserves(buy, base, dB0, dB1), buy, base, 'base', base.toLowerCase() === buy.tokenA.toLowerCase() ? dB0 : dB1);
      if (!rb) continue;
      for (const sell of usable) {
        if (sell === buy) continue;
        const dS0 = sell.tokenA.toLowerCase() === t0 ? d0 : d1, dS1 = sell.tokenA.toLowerCase() === t0 ? d1 : d0;
        // Sell pool pays out the quote coin: only as much as it really holds.
        const rs = capToRealBalance(poolReserves(sell, base, dS0, dS1), sell, quote, 'quote', quote === sell.tokenA.toLowerCase() ? dS0 : dS1);
        if (!rs) continue;
        const r = bestArb(rb, feeFraction(buy), rs, feeFraction(sell), opts.flashFee, opts.maxTradeUsd / quoteUsd);
        const profitUsd = r.profit * quoteUsd - opts.gasUsd;
        if (profitUsd > 0 && profitUsd >= opts.minProfitUsd) {
          found.push({ pairKey: [t0, t1].sort().join('/'), base, quote, buyPool: buy, sellPool: sell,
            sizeQuote: r.dx, sizeUsd: r.dx * quoteUsd, profitUsd, quoteUsd });
        }
      }
    }
    out.push(...found.sort((a, b) => b.profitUsd - a.profitUsd).slice(0, Math.max(1, opts.perPair ?? 1)));
  }
  return out.sort((a, b) => b.profitUsd - a.profitUsd);
}
