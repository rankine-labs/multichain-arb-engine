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
  // Coins we actually hold (USDG, WETH). When a pair contains one of them, the
  // gap is always traded STARTING from that coin: buy the other coin where it
  // is cheap, sell it where it is dear, end with more of our own coin.
  // (Oct 16, owner approved. Before, the scanner started from token1 when it
  // had a price; on a pair like USDG/ORBIO that meant starting from ORBIO,
  // which we don't hold, so live could never send it.) Empty/unset = old rule.
  startCoins?: string[];
}

// Which coin a gap starts and ends with (the "quote"), and its USD price.
// 1. If one coin is a coin we hold (opts.startCoins) and has a price: that one.
//    (If both are, e.g. WETH/USDG, the old rule below decides.)
// 2. Otherwise the old rule: token1 if it has a USD price, else token0.
export function pickQuote(
  t0: string, t1: string, usdOf: (token: string) => number | null, startCoins?: string[],
): { quote: string; base: string; quoteUsd: number } | null {
  const u0 = usdOf(t0), u1 = usdOf(t1);
  if (startCoins && startCoins.length) {
    const held = new Set(startCoins.map((c) => c.toLowerCase()));
    const h0 = held.has(t0) && !!u0 && u0 > 0, h1 = held.has(t1) && !!u1 && u1 > 0;
    if (h0 && !h1) return { quote: t0, base: t1, quoteUsd: u0! };
    if (h1 && !h0) return { quote: t1, base: t0, quoteUsd: u1! };
  }
  if (u1 && u1 > 0) return { quote: t1, base: t0, quoteUsd: u1 };
  if (u0 && u0 > 0) return { quote: t0, base: t1, quoteUsd: u0 };
  return null;
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
    // Start coin: one we hold if the pair has it, else the old rule (pickQuote).
    const pq = pickQuote(t0, t1, usdOf, opts.startCoins);
    if (!pq) continue;
    const { quote, base, quoteUsd } = pq;

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

// ============================================================================
// FAST GAP SCAN (Oct 14, freeze phase 1)
//
// Plain English:
//   The scan above runs after every price change (every block, several times
//   a second) and redoes the maths for EVERY watched coin pair, even though
//   a block usually moves only a few pools. The hourly report showed it
//   freezing the bot for up to 600-700 ms (most of that was the price
//   oracle, fixed separately; see poolCache.ts and priceOracle.ts).
//
//   This version gives EXACTLY the same list of gaps for the same input
//   (a test checks this on thousands of random cases), but:
//     1. It remembers each pair's answer together with everything the
//        answer depends on (each pool's reserves / price / liquidity, fee,
//        real coin balances, the coin's USD price, decimals, settings).
//        A pair where none of that changed reuses its answer; only pairs
//        touched by the update are worked out again.
//        What is remembered is every pool combination with its profit
//        BEFORE gas. Gas (which changes nearly every scan) and the minimum
//        profit are applied fresh each scan, exactly as the old scan does
//        (profit - gas > 0 and >= minimum, best first, top perPair), so a
//        gas change doesn't throw the memory away.
//     2. It is written as steps (core/chunked.ts): it can pause after any
//        pair, so the bot never freezes for long; the caller runs it in
//        small bites with breaks in between for feed messages.
//
//   Switch: GAP_SCAN_FAST=0 in shadowMain uses the old one-go scan.
// ============================================================================

// Everything one pool contributes to a pair's answer.
interface PoolPrint {
  addr: string; type: string; tokenA: string;
  ra: unknown; rb: unknown; sq: unknown; liq: unknown;  // reserves / price / liquidity as stored
  fee: number;                                          // fee fraction used
  balBase: bigint | undefined; balQuote: bigint | undefined; // real balances (V3 cap)
}
// One remembered pair: its inputs and its answer (pool positions, not objects,
// so a new object with the same numbers still gives the current objects back).
interface PairMemo {
  t0: string; t1: string; quote: string; base: string; quoteUsd: number; d0: number; d1: number;
  prints: PoolPrint[];
  // Every combination worked out, in the old scan's order, with profit before gas.
  cands: { bi: number; si: number; sizeQuote: number; grossUsd: number }[];
  scan: number;   // last scan that saw this pair (pairs not seen are forgotten)
}

// Memory for one caller of the fast scan (use one per call site: the
// settings are part of what is remembered).
export class GapScanMemo {
  private pairs = new Map<string, PairMemo>();
  private optsKey = '';
  private scan = 0;
  reused = 0;      // pairs answered from memory (lifetime, for the log / tests)
  worked = 0;      // pairs worked out again
  size(): number { return this.pairs.size; }

  // Start a new scan; settings that change the remembered maths (loan fee,
  // trade size cap) changed = forget everything. Gas, the minimum profit and
  // perPair are applied fresh every scan, so they are not part of this.
  begin(opts: GapOptions): number {
    const k = `${opts.flashFee}|${opts.maxTradeUsd}|${(opts.startCoins ?? []).join(',')}`;
    if (k !== this.optsKey) { this.pairs.clear(); this.optsKey = k; }
    return ++this.scan;
  }
  get(key: string): PairMemo | undefined { return this.pairs.get(key); }
  set(key: string, m: PairMemo): void { this.pairs.set(key, m); }
  // Forget pairs the last scan didn't see (pair dropped from the watch list).
  endScan(scan: number): void { for (const [k, m] of this.pairs) if (m.scan !== scan) this.pairs.delete(k); }
}

function printOf(p: PoolState, base: string, quote: string): PoolPrint {
  return {
    addr: p.poolAddress, type: p.poolType, tokenA: p.tokenA,
    ra: p.reserveA, rb: p.reserveB, sq: p.sqrtPriceX96, liq: p.liquidity,
    fee: feeFraction(p),
    balBase: realBalanceOf(p, base), balQuote: realBalanceOf(p, quote),
  };
}
const samePrint = (a: PoolPrint, b: PoolPrint): boolean =>
  a.addr === b.addr && a.type === b.type && a.tokenA === b.tokenA && a.ra === b.ra && a.rb === b.rb && a.sq === b.sq && a.liq === b.liq
  && a.fee === b.fee && a.balBase === b.balBase && a.balQuote === b.balQuote;

// One pair, worked out in full: the same maths, in the same order, as the
// inner loop of findStandingGaps above, but keeping EVERY combination with
// its profit before gas. Returns positions in `usable`.
// (Feed speed, Oct 24: written as steps too, a pause allowed after each buy
// pool, so one coin pair with many pools (n pools = n x (n-1) combinations)
// can't make one long bite. Same combinations, same order, same numbers.)
function* workOutPair(
  usable: PoolState[], t0: string, d0: number, d1: number, base: string, quote: string, quoteUsd: number, opts: GapOptions,
): Generator<void, PairMemo['cands'], void> {
  const cands: PairMemo['cands'] = [];
  for (let bi = 0; bi < usable.length; bi++) {
    if (bi > 0 && (bi & 3) === 0) yield; // every 4 buy pools
    const buy = usable[bi];
    const dB0 = buy.tokenA.toLowerCase() === t0 ? d0 : d1, dB1 = buy.tokenA.toLowerCase() === t0 ? d1 : d0;
    const rb = capToRealBalance(poolReserves(buy, base, dB0, dB1), buy, base, 'base', base.toLowerCase() === buy.tokenA.toLowerCase() ? dB0 : dB1);
    if (!rb) continue;
    for (let si = 0; si < usable.length; si++) {
      const sell = usable[si];
      if (sell === buy) continue;
      const dS0 = sell.tokenA.toLowerCase() === t0 ? d0 : d1, dS1 = sell.tokenA.toLowerCase() === t0 ? d1 : d0;
      const rs = capToRealBalance(poolReserves(sell, base, dS0, dS1), sell, quote, 'quote', quote === sell.tokenA.toLowerCase() ? dS0 : dS1);
      if (!rs) continue;
      const r = bestArb(rb, feeFraction(buy), rs, feeFraction(sell), opts.flashFee, opts.maxTradeUsd / quoteUsd);
      cands.push({ bi, si, sizeQuote: r.dx, grossUsd: r.profit * quoteUsd });
    }
  }
  return cands;
}

// This scan's answer for one pair from its combinations: exactly the old
// scan's rule (profit after gas > 0 and >= minimum, stable sort best first,
// top perPair). Same arithmetic: (profit x quoteUsd) - gas.
function pickGaps(cands: PairMemo['cands'], opts: GapOptions): { bi: number; si: number; sizeQuote: number; profitUsd: number }[] {
  const found: { bi: number; si: number; sizeQuote: number; profitUsd: number }[] = [];
  for (const c of cands) {
    const profitUsd = c.grossUsd - opts.gasUsd;
    if (profitUsd > 0 && profitUsd >= opts.minProfitUsd) found.push({ bi: c.bi, si: c.si, sizeQuote: c.sizeQuote, profitUsd });
  }
  return found.sort((a, b) => b.profitUsd - a.profitUsd).slice(0, Math.max(1, opts.perPair ?? 1));
}

// The fast scan as steps: `yield` after each pair (a safe place to pause).
// Run with drainSteps() (all at once) or runSteps() (in small bites).
// Same result as findStandingGaps(pairs, decimalsOf, usdOf, opts).
export function* findStandingGapsSteps(
  pairs: PoolState[][],
  decimalsOf: (token: string) => number | undefined,
  usdOf: (token: string) => number | null,
  opts: GapOptions,
  memo: GapScanMemo = new GapScanMemo(),
): Generator<void, StandingGap[], void> {
  const scan = memo.begin(opts);
  const seenThisScan = new Set<string>();
  const out: StandingGap[] = [];
  for (const pools of pairs) {
    const usable = pools.filter((p) => p.poolType === 'v2' || p.poolType === 'v3');
    if (usable.length < 2) continue;
    const t0 = usable[0].tokenA.toLowerCase(), t1 = usable[0].tokenB.toLowerCase();
    const d0 = decimalsOf(t0), d1 = decimalsOf(t1);
    if (d0 === undefined || d1 === undefined) continue; // never guess decimals
    // Start coin: one we hold if the pair has it, else the old rule (pickQuote).
    const pq = pickQuote(t0, t1, usdOf, opts.startCoins);
    if (!pq) continue;
    const { quote, base, quoteUsd } = pq;

    // What this pair's answer depends on, right now.
    const prints = usable.map((p) => printOf(p, base, quote));
    const key = `${t0}/${t1}`;
    // The same coin pair twice in one scan (not normal): work it out without memory.
    const dup = seenThisScan.has(key);
    seenThisScan.add(key);
    const m = dup ? undefined : memo.get(key);
    let cands: PairMemo['cands'];
    if (m && m.t0 === t0 && m.t1 === t1 && m.quote === quote && m.base === base && m.quoteUsd === quoteUsd && m.d0 === d0 && m.d1 === d1
      && m.prints.length === prints.length && m.prints.every((x, i) => samePrint(x, prints[i]))) {
      cands = m.cands;
      m.scan = scan;
      memo.reused++;
    } else {
      cands = yield* workOutPair(usable, t0, d0, d1, base, quote, quoteUsd, opts);
      if (!dup) memo.set(key, { t0, t1, quote, base, quoteUsd, d0, d1, prints, cands, scan });
      memo.worked++;
    }
    const pairKey = [t0, t1].sort().join('/');
    for (const f of pickGaps(cands, opts)) {
      out.push({ pairKey, base, quote, buyPool: usable[f.bi], sellPool: usable[f.si],
        sizeQuote: f.sizeQuote, sizeUsd: f.sizeQuote * quoteUsd, profitUsd: f.profitUsd, quoteUsd });
    }
    yield;
  }
  memo.endScan(scan);
  return out.sort((a, b) => b.profitUsd - a.profitUsd);
}
