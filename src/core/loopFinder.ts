import { PoolState } from './types';
import { feePipsOf } from './dexMath';
import { clAmountOut, v2AmountOut } from './venueMath';
import { realBalanceOf } from './poolPrice';
import { stallFinder } from './stallFinder';
import { drainSteps } from './chunked';

// ============================================================================
// LOOP FINDER -- finds 3 to 8 pool loops that end with more than they start
//
// Plain English:
//   Today the bot only trades "the same coin pair on two pools" (buy where
//   it's cheap, sell where it's dear). Rival bots also win with LOOPS:
//   start with WETH, swap to DJT, DJT to PONS, PONS to USDG, USDG back to
//   WETH. If the prices along the way don't quite agree, you end with a bit
//   more WETH than you put in.
//
//   This file does the maths only. It never trades and never asks the node
//   anything: it reads the prices the bot already keeps in memory.
//
// How it stays fast (target: well under 20 ms per price update, even at 8 pools):
//   1. MAP: all pools become a map of coins (dots) joined by pools (lines).
//   2. LOOPS LIST: paths of 3 to LOOP_MAX_POOLS pools that start and end in
//      a base coin (WETH or USDG) are listed ONCE, up to LOOP_MAX_CYCLES
//      loops. That total is shared out between the loop lengths, so lots of
//      long loops can never push the short ones out. Pools rival bots used
//      in their loops go first, then pools that moved recently, then deep
//      pools. The list is rebuilt when the set of pools changes, when a pool
//      price moves a lot, and at least once a minute.
//   3. LONG LOOPS (6+ pools) would be millions of paths, so they are only
//      listed when they could come close to paying: before listing, the
//      finder works out "the best any route of N more pools back to the base
//      coin could possibly do" (prices with fees, no trade size). A path is
//      dropped as soon as even that best case can't get within
//      LOOP_LONG_SLACK (2%) of paying for its gas. This check can only ever
//      be too hopeful, never too strict, so a loop that pays is never
//      dropped by it.
//   4. NO FREEZE: building the list is done in small slices of a few ms,
//      handing control back to the rest of the bot in between, so a rebuild
//      never holds the bot up for more than about 10 ms at a time.
//   5. ON EACH UPDATE only the loops that go through a pool whose price just
//      changed are re-priced, inside a time budget (anything left over is
//      priced on the next update).
//   6. QUICK CHECK: a chain of x*y=k swaps is itself one simple curve,
//      out = A*x / (1 + C*x). That gives the best size in one line of maths
//      (no searching), so thousands of loops cost about a millisecond.
//   7. EXACT CHECK: the few loops that pass the quick check are re-priced
//      with the exact integer pool maths already used elsewhere in the bot
//      (V2 copies: v2AmountOut; V3 / V4 / Algebra in the current price band:
//      clAmountOut), and the best size is found by a golden-section search.
//      Only this exact number is ever reported.
//
// Pool types: V2 copies (incl. Solidly volatile pairs, priced as x*y=k like
// the gap scanner does), V3 and its copies, Algebra, Uniswap V4 (incl.
// hooked Fables pools at their known fee). Order books, stable curves and
// Liquidity Book bins have no exact maths here and are left out.
//
// SIZING REALISM (Oct 13, "found 363, would make money 0"): V3-style pools
// are priced inside their current price band only. Before this fix the
// best-size search could pick a size that pushes a concentrated pool far
// past its band, or asks a pool to pay out more coins than it really holds,
// so the "profit" was imaginary and every practice check lost. Now the
// exact check (and the quick check's size limit) only allows sizes where:
//   - no V3-style hop leaves its current price band (see inBandMaxIn), and
//   - no V3 hop pays out more than the pool's real coin balance (read every
//     ~10 min by core/v3BalanceBook.ts, see realBalanceOf).
// This makes loop estimates conservative: exact while inside the band, and
// never bigger than what a pool can really pay. It can miss a loop that
// would only pay by crossing into the next band; it will no longer report
// loops that only "pay" because of that.
// ============================================================================

const Q96 = 2 ** 96;
const lc = (s: string) => s.toLowerCase();

// Longest and shortest loop the finder will ever look for.
export const LOOP_MIN_POOLS_LIMIT = 3;
export const LOOP_MAX_POOLS_LIMIT = 8;

// Exchanges whose pools are bins / order books: no exact maths here.
const NO_EXACT_MATH_DEXES = new Set(['lfj-lb', 'traderjoe-lb', 'bean-exchange', 'ramses-dlmm', 'kuru']);

// True if we have exact swap maths for this pool.
export function hasExactMath(p: PoolState): boolean {
  if (NO_EXACT_MATH_DEXES.has(lc(p.dex))) return false;
  if (p.poolType === 'v2') return p.reserveA !== undefined && p.reserveB !== undefined && p.reserveA > 0n && p.reserveB > 0n;
  if (p.poolType === 'v3') return !!p.sqrtPriceX96 && !!p.liquidity && p.liquidity > 0n;
  return false; // 'orderbook', 'stable'
}

// One step of a loop: which pool, and which way through it.
export interface LoopHop {
  poolKey: string;     // lower-case pool address (or V4 pool id)
  tokenIn: string;     // lower-case
  tokenOut: string;    // lower-case
  inIsA: boolean;      // true = tokenIn is the pool's tokenA (token0)
}

// A loop: starts and ends in `base`.
export interface LoopCycle {
  id: number;
  sig: string;         // base + pools in order: same loop, same text (used to count it once)
  poolSet: string;     // pools sorted (ignores start coin and order): used to match rival trades
  base: string;
  hops: LoopHop[];
  tokens: string[];    // coins in order, starting with base (not repeated at the end)
}

// What the finder needs from the rest of the bot.
export interface LoopEnv {
  decimalsOf: (token: string) => number | undefined;   // exact decimals (never guessed)
  usdOf: (token: string) => number | null;             // USD price of a coin
  depthUsd: (pool: PoolState) => number | null;        // money in the pool near its price
  gasUsd: (hops: number) => number;                    // our gas for a loop of this many pools
  isTradable: (token: string) => boolean;              // coin on the vetted list
  now: () => number;
  // Pools (lower-case) that rival bots used in their loop trades lately.
  // Loops through them are listed first. Optional: none = no preference.
  rivalPools?: () => Set<string>;
}

export interface LoopFinderConfig {
  bases: string[];       // coins a loop may start/end in, most preferred first (WETH, USDG)
  minPools: number;      // 3 (2-pool trades are the gap scanner's job)
  maxPools: number;      // LOOP_MAX_POOLS, default 5, at most 8
  maxCycles: number;     // LOOP_MAX_CYCLES, default 5000, shared out between loop lengths
  maxTradeUsd: number;   // LOOP_MAX_TRADE_USD, default $2,000
  depthShare: number;    // LOOP_DEPTH_SHARE: trade at most this share of the shallowest pool's depth (0.3)
  exactTopK: number;     // how many quick-check winners get the exact check per update (20)
  maxStepsPerLength: number; // safety cap on the loop listing work, per loop length (100,000 steps)
  rebuildMs: number;     // rebuild the loop list at least this often (60 s)
  rebuildMinMs: number;  // ...but never more often than this (5 s), even if pools come and go
  longFromPools: number; // loops this long or longer are only listed if they could come close to paying (6)
  longSlack: number;     // LOOP_LONG_SLACK: "close" = within this share of paying (0.02 = 2%)
  sliceMs: number;       // a rebuild works about this long before letting the bot run (5 ms)
  updateBudgetMs: number; // time budget for re-pricing loops in one update (12 ms)
}

export const DEFAULT_FINDER_CONFIG: Omit<LoopFinderConfig, 'bases'> = {
  minPools: 3, maxPools: 5, maxCycles: 5_000, maxTradeUsd: 2_000, depthShare: 0.3,
  exactTopK: 20, maxStepsPerLength: 100_000, rebuildMs: 60_000, rebuildMinMs: 5_000,
  longFromPools: 6, longSlack: 0.02, sliceMs: 5, updateBudgetMs: 12,
};

// A priced loop.
export interface LoopResult {
  cycle: LoopCycle;
  amountIn: bigint;      // best input, base-coin units (exact maths)
  amountOut: bigint;     // what comes back, base-coin units
  sizeUsd: number;
  grossUsd: number;      // profit before gas
  gasUsd: number;
  netUsd: number;        // after gas
  tradable: boolean;     // every coin on the loop is vetted
  pools: PoolState[];    // pool states used (for building the trade)
}

export interface UpdateOutcome {
  results: LoopResult[];      // loops making money after gas (exact maths), best first
  evaluated: number[];        // ids of loops with a verdict this update (paying or not)
  changedPools: number;
  rebuilt: boolean;           // a new loop list was put in place this update (loop ids changed)
  cycles: number;             // loops in the list
  ms: number;                 // time this update took
  waiting: number;            // loops still waiting to be priced (time budget ran out)
}


// ----------------------------------------------------------------------------
// Pure maths
// ----------------------------------------------------------------------------

// A pool seen as x*y=k in one direction, in raw token units:
// out(x) = g*rout*x / (rin + g*x), with g = 1 - fee.
export interface HopCurve { rin: number; rout: number; g: number }

export function hopCurve(p: PoolState, inIsA: boolean): HopCurve | null {
  const g = 1 - feePipsOf(p) / 1_000_000;
  let a: number, b: number;
  if (p.poolType === 'v2') {
    if (p.reserveA === undefined || p.reserveB === undefined) return null;
    a = Number(p.reserveA); b = Number(p.reserveB);
  } else if (p.poolType === 'v3') {
    if (!p.sqrtPriceX96 || !p.liquidity) return null;
    // "Virtual" reserves in the current band: same curve as the V3 formula.
    const s = Number(p.sqrtPriceX96) / Q96, L = Number(p.liquidity);
    a = L / s; b = L * s;
  } else return null;
  if (!(a > 0) || !(b > 0) || !Number.isFinite(a) || !Number.isFinite(b) || !(g > 0)) return null;
  return inIsA ? { rin: a, rout: b, g } : { rin: b, rout: a, g };
}

// Chains several x*y=k swaps into one curve out(x) = A*x / (1 + C*x).
// Each swap y -> a*y/(b + c*y) folds in as A' = aA, B' = bB, C' = bC + cA,
// then everything is divided by B' so B stays 1 (keeps numbers in range).
export function composeCurves(curves: HopCurve[]): { A: number; C: number } {
  let A = 1, C = 0;
  for (const h of curves) {
    const a = h.g * h.rout, b = h.rin, c = h.g;
    const nA = (a * A) / b;
    const nC = (b * C + c * A) / b;
    A = nA; C = nC;
  }
  return { A, C };
}

// Best input for out = A*x/(1+C*x): profit = out - x is largest where
// A/(1+Cx)^2 = 1, i.e. x = (sqrt(A) - 1) / C. No profit possible if A <= 1.
export function bestInputClosedForm(A: number, C: number, cap: number): { x: number; profit: number } {
  if (!(A > 1) || !(C > 0) || !(cap > 0)) return { x: 0, profit: 0 };
  const x = Math.min((Math.sqrt(A) - 1) / C, cap);
  return { x, profit: (A * x) / (1 + C * x) - x };
}

// Golden-section search: the x in [lo, hi] where f is largest, for a curve
// that rises then falls (or only rises / only falls). ~40 steps narrow the
// range to a billionth of its width.
export function goldenMax(f: (x: number) => number, lo: number, hi: number, iters = 40): { x: number; fx: number } {
  const R = (Math.sqrt(5) - 1) / 2;
  let a = lo, b = hi;
  let c = b - R * (b - a), d = a + R * (b - a);
  let fc = f(c), fd = f(d);
  for (let i = 0; i < iters; i++) {
    if (fc >= fd) { b = d; d = c; fd = fc; c = b - R * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + R * (b - a); fd = f(d); }
  }
  // The ends can win for curves that only rise or only fall.
  let best = fc >= fd ? { x: c, fx: fc } : { x: d, fx: fd };
  const fhi = f(hi);
  if (fhi > best.fx) best = { x: hi, fx: fhi };
  return best;
}

// Exact output of one swap, with the same integer maths the pools use.
export function exactHopOut(p: PoolState, inIsA: boolean, amountIn: bigint): bigint {
  if (amountIn <= 0n) return 0n;
  const fee = feePipsOf(p);
  if (p.poolType === 'v2') {
    if (p.reserveA === undefined || p.reserveB === undefined) return 0n;
    return inIsA ? v2AmountOut(amountIn, p.reserveA, p.reserveB, fee) : v2AmountOut(amountIn, p.reserveB, p.reserveA, fee);
  }
  if (p.poolType === 'v3') {
    if (!p.sqrtPriceX96 || !p.liquidity) return 0n;
    return clAmountOut(p.sqrtPriceX96, p.liquidity, amountIn, inIsA, fee).amountOut; // inIsA = zeroForOne
  }
  return 0n;
}

// ----------------------------------------------------------------------------
// Sizing realism: price band limit and real balance cap (Oct 13)
// ----------------------------------------------------------------------------

// Uniswap V3 style pools hold their liquidity in price bands. The band edges
// sit every `tickSpacing` ticks (1 tick = a 0.01% price step). Inside one
// band the liquidity number we read is exact; past the edge it may change
// (often it drops sharply in concentrated pools).
//
// Where the spacing comes from:
//   - V4 pools: their own tickSpacing (part of the pool key).
//   - V3 copies: the standard Uniswap spacing for the fee tier
//     (0.01% -> 1, 0.05% -> 10, 0.25% -> 50, 0.30% -> 60, 1% -> 200).
//   - Any other fee (Algebra dynamic fees, odd tiers): fee / 50 ticks, at
//     least 1. That is never wider than the usual spacing for that fee, and
//     a narrower band only makes the limit stricter (safer), never looser.
const STANDARD_TICK_SPACING: Record<number, number> = { 100: 1, 500: 10, 2500: 50, 3000: 60, 10000: 200 };
export function tickSpacingOf(p: PoolState): number {
  if (p.v4 && Number.isInteger(p.v4.tickSpacing) && p.v4.tickSpacing > 0) return p.v4.tickSpacing;
  const fee = feePipsOf(p);
  return STANDARD_TICK_SPACING[fee] ?? Math.max(1, Math.floor(fee / 50));
}

const MIN_TICK = -887272, MAX_TICK = 887272;
const LOG_TICK = Math.log(1.0001);
// sqrt(price) at a tick (real number, not X96).
const sqrtAtTick = (t: number) => Math.pow(1.0001, t / 2);

// The most of `tokenIn` (raw units, INCLUDING the pool fee) that can go into
// a V3-style pool before its price reaches the edge of its current band.
// null = no band limit (V2 pools). 0 = the price already sits on the edge.
//
// How: the current tick comes from the price (tick = log base 1.0001 of the
// price, rounded down). The band is [lower, lower + spacing), lower being the
// tick rounded down to a multiple of the spacing. Selling token0 pushes the
// price DOWN toward `lower`; selling token1 pushes it UP toward `upper`.
// With s = sqrt(price) and L = liquidity, the standard V3 formulas give the
// input needed to move the price from s to the edge sEdge:
//   token0 in: L * (1/sEdge - 1/s)       token1 in: L * (sEdge - s)
// Then the fee is added back on (the pool only prices the part after fee).
export function inBandMaxIn(p: PoolState, inIsA: boolean): number | null {
  if (p.poolType !== 'v3') return null;
  if (!p.sqrtPriceX96 || !p.liquidity) return 0;
  const s = Number(p.sqrtPriceX96) / Q96, L = Number(p.liquidity);
  if (!(s > 0) || !(L > 0) || !Number.isFinite(s) || !Number.isFinite(L)) return 0;
  const ts = tickSpacingOf(p);
  const tick = Math.floor((2 * Math.log(s)) / LOG_TICK);
  let lower = Math.floor(tick / ts) * ts;
  // Float rounding right next to an edge: make sure lower <= price < upper.
  if (sqrtAtTick(lower) > s) lower -= ts;
  if (sqrtAtTick(lower + ts) <= s) lower += ts;
  const upper = lower + ts;
  let net: number;
  if (inIsA) net = L * (1 / sqrtAtTick(Math.max(MIN_TICK, lower)) - 1 / s); // price falls to `lower`
  else net = L * (sqrtAtTick(Math.min(MAX_TICK, upper)) - s);              // price rises to `upper`
  if (!(net > 0) || !Number.isFinite(net)) return 0;
  const g = 1 - feePipsOf(p) / 1_000_000;
  return g > 0 ? net / g : 0;
}

// The pool's real balance of the coin it pays out on this hop (raw units),
// or undefined when not known (V2 pools, V4 pools, balance not read yet).
export function realOutCap(p: PoolState, inIsA: boolean): bigint | undefined {
  return realBalanceOf(p, inIsA ? p.tokenB : p.tokenA);
}

// Exact output of one swap, made realistic:
//   - input past the band edge is treated as wasted (only the part that fits
//     inside the band is priced), so a bigger trade never looks better;
//   - the output is capped at the pool's real balance of that coin.
// For a size inside both limits this is exactly exactHopOut.
export function realisticHopOut(p: PoolState, inIsA: boolean, amountIn: bigint): bigint {
  let a = amountIn;
  const maxIn = inBandMaxIn(p, inIsA);
  if (maxIn !== null) {
    const m = BigInt(Math.max(0, Math.floor(maxIn)));
    if (a > m) a = m;
  }
  let out = exactHopOut(p, inIsA, a);
  const real = realOutCap(p, inIsA);
  if (real !== undefined && out > real) out = real;
  return out;
}

// Exact output of a whole loop. opts.realistic: use realisticHopOut for each
// hop (band limit + real balance cap). The finder always uses realistic.
export function exactLoopOut(pools: PoolState[], hops: LoopHop[], amountIn: bigint, opts: { realistic?: boolean } = {}): bigint {
  let amt = amountIn;
  for (let i = 0; i < hops.length; i++) {
    amt = opts.realistic ? realisticHopOut(pools[i], hops[i].inIsA, amt) : exactHopOut(pools[i], hops[i].inIsA, amt);
    if (amt <= 0n) return 0n;
  }
  return amt;
}

// Biggest starting amount (raw base-coin units) for which EVERY hop stays
// inside its price band and pays out no more than its real balance.
// Infinity = no limit (all V2, balances unknown). Float maths, a size limit
// only: works backwards from the last hop, turning each hop's limit on its
// output into a limit on its input with the inverse of the x*y=k curve
// (exact for V3 inside its band), then applying that hop's own band limit.
export function maxLoopInput(pools: PoolState[], hops: LoopHop[]): number {
  let lim = Infinity; // most the NEXT hop may receive (= most this hop may pay out)
  for (let i = hops.length - 1; i >= 0; i--) {
    const p = pools[i], inIsA = hops[i].inIsA;
    const real = realOutCap(p, inIsA);
    let outLim = lim;
    if (real !== undefined) outLim = Math.min(outLim, Number(real));
    let inLim = Infinity;
    if (outLim !== Infinity) {
      const h = hopCurve(p, inIsA);
      if (!h || !(outLim > 0)) return 0;
      // Inverse of out = g*rout*x / (rin + g*x): x = rin*out / (g*(rout - out)).
      inLim = outLim >= h.rout ? Infinity : (h.rin * outLim) / (h.g * (h.rout - outLim));
    }
    const band = inBandMaxIn(p, inIsA);
    if (band !== null) inLim = Math.min(inLim, band);
    if (!(inLim > 0)) return 0;
    lim = inLim;
  }
  return lim;
}

// ----------------------------------------------------------------------------
// The loop list
// ----------------------------------------------------------------------------

// How the price of one pool, one way, looks to the "best case" check:
// log of (price after fee). Adding these up along a loop gives the log of
// "what comes back per coin put in" for a tiny trade, which is the most a
// loop can ever return (bigger trades only get worse prices).
export function hopLogRate(p: PoolState, inIsA: boolean): number | null {
  const h = hopCurve(p, inIsA);
  if (!h) return null;
  const r = Math.log((h.g * h.rout) / h.rin);
  return Number.isFinite(r) ? r : null;
}

export interface CycleSearchOptions {
  maxCycles?: number;        // most loops in total; shared out between lengths
  maxSteps?: number;         // most search steps in total; shared out between lengths
  order?: (poolKey: string) => number;   // higher = tried first (short loops)
  preferPools?: Set<string>; // pools tried before all others (rival loop pools)
  longFrom?: number;         // loops this long or longer use the best-case check (default: never)
  // Smallest log return a loop of this length must be able to reach to be
  // listed (only for long loops). E.g. log(1 + gas/size) + log(1 - slack).
  minLog?: (len: number) => number;
}

// One way through one pool, with coins as numbers (faster than text).
interface SEdge { pool: number; to: number; inIsA: boolean; w: number; score: number; pref: boolean }
// A coin's ordered list of ways out, for one (base, loop length, hops left)
// combination. `tier2` = where the non-preferred pools start.
interface ChildList { ids: Int32Array; tier2: number }

// Lists loops, one length at a time (3 pools, then 4, ...), and can stop
// part way and carry on later (run() with a deadline), so a big rebuild can
// be done in small slices without freezing the bot.
//
// Rules (same as before): a loop is listed once per direction; a loop that
// passes through two base coins is listed only from the more preferred one
// (WETH before USDG); no pool and no in-between coin is used twice.
//
// Sharing out: each length gets an equal share of what is left of
// LOOP_MAX_CYCLES (and of the step budget) when its turn comes. A length
// that doesn't use its share passes the rest on to the longer lengths.
export class CycleSearch {
  readonly cycles: LoopCycle[] = [];
  readonly byLen: number[] = [];              // loops listed per length (index = pools)
  readonly cappedLens = new Set<number>();    // lengths that hit their share
  readonly rates = new Map<string, number>(); // pool -> log price A->B when the list was built
  steps = 0;
  done = false;

  // The coin map, coins and pools as numbers.
  private tokNames: string[] = [];
  private poolKeys: string[] = [];
  private edges: SEdge[] = [];
  private out: number[][] = [];          // coin -> edge ids leaving it
  private rankOf!: Int32Array;           // coin -> base rank (-1 = not a base)
  private baseToks: number[] = [];       // base coins in preference order (present on the map only)
  // best[b][k][t]: the best log return of any route of exactly k pools from
  // coin t back to base number b (routes may repeat coins here, which can
  // only make the number bigger: so it is always a safe "best case").
  private best: Float64Array[][] = [];
  private childCache = new Map<number, ChildList>();
  private setupDone = false;
  private sortWork = 0;
  private setupIdx = 0;                  // pools read into the map so far
  private tokId = new Map<string, number>();                  // edges sorted since the last clock check

  // Where the search is.
  private len: number;
  private bi = 0;
  private depth = 0;
  private lists: ChildList[] = [];
  private pos: number[] = [];
  private tokAt: number[] = [];
  private edgeAt: number[] = [];
  private prefix: number[] = [];
  private usedPool!: Uint8Array;
  private usedTok!: Uint8Array;
  private passCount = 0;
  private passSteps = 0;
  private quota = Infinity;
  private stepBudget = Infinity;
  private passStarted = false;
  private cyclesLeft: number;
  private stepsLeft: number;

  constructor(
    private pools: PoolState[], private bases: string[],
    private minPools: number, private maxPools: number,
    private opts: CycleSearchOptions = {},
  ) {
    this.len = minPools;
    this.cyclesLeft = opts.maxCycles ?? Infinity;
    this.stepsLeft = opts.maxSteps ?? Infinity;
  }

  get capped(): boolean { return this.cappedLens.size > 0; }

  // Build the coin map and the best-case table. A few ms for ~1,000 pools.
  // Can stop part way (deadline) and carry on in the next slice: true = done.
  private setup(deadline: number): boolean {
    const tokId = this.tokId;
    const tid = (t: string) => { let i = tokId.get(t); if (i === undefined) { i = this.tokNames.length; tokId.set(t, i); this.tokNames.push(t); this.out.push([]); } return i; };
    const order = this.opts.order, pref = this.opts.preferPools;
    while (this.setupIdx < this.pools.length) {
      if ((this.setupIdx & 31) === 31 && performance.now() > deadline) return false;
      const p = this.pools[this.setupIdx++];
      const k = lc(p.poolAddress), a = lc(p.tokenA), b = lc(p.tokenB);
      if (a === b) continue;
      // Pools we can't price are left out (the quick check would skip them anyway).
      const wAB = hopLogRate(p, true), wBA = hopLogRate(p, false);
      if (wAB === null || wBA === null) continue;
      const pi = this.poolKeys.length; this.poolKeys.push(k);
      this.rates.set(k, wAB);
      const ia = tid(a), ib = tid(b);
      const score = order ? order(k) : 0, isPref = !!pref && pref.has(k);
      this.out[ia].push(this.edges.length); this.edges.push({ pool: pi, to: ib, inIsA: true, w: wAB, score, pref: isPref });
      this.out[ib].push(this.edges.length); this.edges.push({ pool: pi, to: ia, inIsA: false, w: wBA, score, pref: isPref });
    }
    const n = this.tokNames.length;
    this.rankOf = new Int32Array(n).fill(-1);
    const seen = new Set<string>();
    for (const b of this.bases.map(lc)) {
      if (seen.has(b)) continue; seen.add(b);
      const i = tokId.get(b);
      if (i === undefined) continue;
      this.rankOf[i] = this.baseToks.length;
      this.baseToks.push(i);
    }
    // Best-case table: k = 0 means "already at the base".
    for (const bt of this.baseToks) {
      const rows: Float64Array[] = [];
      const r0 = new Float64Array(n).fill(-Infinity); r0[bt] = 0; rows.push(r0);
      for (let k = 1; k < this.maxPools; k++) {
        const prev = rows[k - 1], row = new Float64Array(n).fill(-Infinity);
        for (let t = 0; t < n; t++) {
          let m = -Infinity;
          for (const eid of this.out[t]) { const e = this.edges[eid]; const v = e.w + prev[e.to]; if (v > m) m = v; }
          row[t] = m;
        }
        rows.push(row);
      }
      this.best.push(rows);
    }
    this.usedPool = new Uint8Array(this.poolKeys.length);
    this.usedTok = new Uint8Array(n);
    this.setupDone = true;
    return true;
  }

  private isLong(len: number): boolean { return len >= (this.opts.longFrom ?? Infinity) && !!this.opts.minLog; }

  // Ways out of coin t that can still get back to the base in exactly
  // `left` more pools, best first. Built the first time it's needed.
  //   short loops: rival pools first, then by `order` (recently moved, deep);
  //   long loops: rival pools first, then by best case (most hopeful first).
  private children(long: boolean, bi: number, left: number, t: number): ChildList {
    const key = (((long ? 1 : 0) * this.baseToks.length + bi) * this.maxPools + left) * this.tokNames.length + t;
    let c = this.childCache.get(key);
    if (c) return c;
    this.sortWork += this.out[t].length; // sorting takes time: run() checks the clock sooner
    const row = this.best[bi][left];
    const tier1: number[] = [], tier2: number[] = [];
    for (const eid of this.out[t]) {
      const e = this.edges[eid];
      if (row[e.to] === -Infinity) continue; // can't get back in time
      (e.pref ? tier1 : tier2).push(eid);
    }
    const key2 = long ? (eid: number) => this.edges[eid].w + row[this.edges[eid].to] : (eid: number) => this.edges[eid].score;
    tier1.sort((x, y) => key2(y) - key2(x));
    tier2.sort((x, y) => key2(y) - key2(x));
    c = { ids: Int32Array.from([...tier1, ...tier2]), tier2: tier1.length };
    this.childCache.set(key, c);
    return c;
  }

  // Clear the path in progress (used pools / coins).
  private resetPath() {
    for (let d = 0; d < this.depth; d++) { this.usedPool[this.edges[this.edgeAt[d]].pool] = 0; }
    for (let d = 1; d <= this.depth; d++) this.usedTok[this.tokAt[d]] = 0;
    if (this.tokAt.length) this.usedTok[this.tokAt[0]] = 0;
    this.depth = 0;
  }

  // Start the search from base number bi for the current length.
  private startBase() {
    const bt = this.baseToks[this.bi];
    this.depth = 0;
    this.tokAt[0] = bt; this.prefix[0] = 0; this.pos[0] = 0;
    this.lists[0] = this.children(this.isLong(this.len), this.bi, this.len - 1, bt);
    this.usedTok[bt] = 1;
  }

  // Finish the current length and move to the next one.
  private endPass() {
    this.resetPath();
    this.cyclesLeft -= this.passCount;
    this.stepsLeft -= this.passSteps;
    this.len++;
    this.bi = 0;
    this.passStarted = false;
  }

  // Work until `deadline` (performance.now() time). Returns true when finished.
  run(deadline: number): boolean {
    if (this.done) return true;
    if (!this.setupDone && (!this.setup(deadline) || performance.now() > deadline)) return false;
    let tick = 0;
    for (;;) {
      if (!this.passStarted) {
        if (this.len > this.maxPools || !this.baseToks.length) { this.done = true; return true; }
        // This length's share of what's left.
        const lensLeft = this.maxPools - this.len + 1;
        this.quota = Math.ceil(this.cyclesLeft / lensLeft);
        this.stepBudget = Math.ceil(this.stepsLeft / lensLeft);
        this.passCount = 0; this.passSteps = 0; this.bi = 0; this.passStarted = true;
        if (this.quota <= 0) { this.cappedLens.add(this.len); this.endPass(); continue; }
        this.startBase();
      }
      // Check the clock every 64 steps, or sooner after sorting big lists.
      if (((++tick & 63) === 0 || this.sortWork > 2_000) && (this.sortWork = 0, performance.now() > deadline)) return false;

      const d = this.depth, list = this.lists[d];
      if (this.pos[d] >= list.ids.length) {
        if (d === 0) {
          // This base is finished: next base, or next length.
          this.usedTok[this.tokAt[0]] = 0;
          this.bi++;
          if (this.bi >= this.baseToks.length) this.endPass(); else this.startBase();
          continue;
        }
        // Step back one pool.
        this.depth--;
        this.usedPool[this.edges[this.edgeAt[this.depth]].pool] = 0;
        this.usedTok[this.tokAt[d]] = 0;
        continue;
      }
      const i = this.pos[d]++;
      const eid = list.ids[i], e = this.edges[eid];
      this.steps++;
      if (++this.passSteps > this.stepBudget) { this.cappedLens.add(this.len); this.endPass(); continue; }
      if (this.usedPool[e.pool]) continue;
      const left = this.len - d - 1; // pools still to go after this one
      if (this.isLong(this.len)) {
        // Best case for any loop that starts with this path: still not
        // enough? Then nothing further down this list is either (it is
        // sorted best first), so skip the rest of this group.
        const ub = this.prefix[d] + e.w + this.best[this.bi][left][e.to];
        if (ub < this.opts.minLog!(this.len)) { this.pos[d] = i < list.tier2 ? list.tier2 : list.ids.length; continue; }
      }
      const start = this.tokAt[0];
      if (left === 0) {
        // The list only holds ways back to the base here: a full loop.
        this.emit(d, eid);
        if (this.passCount >= this.quota) { this.cappedLens.add(this.len); this.endPass(); }
        continue;
      }
      if (e.to === start || this.usedTok[e.to]) continue;
      const r = this.rankOf[e.to];
      if (r >= 0 && r < this.bi) continue; // listed from the more preferred base instead
      // Go one pool deeper.
      this.usedPool[e.pool] = 1; this.usedTok[e.to] = 1;
      this.edgeAt[d] = eid;
      this.depth = d + 1;
      this.tokAt[d + 1] = e.to;
      this.prefix[d + 1] = this.prefix[d] + e.w;
      this.pos[d + 1] = 0;
      this.lists[d + 1] = this.children(this.isLong(this.len), this.bi, left - 1, e.to);
    }
  }

  // Save the loop made of the current path plus edge `lastEid`.
  private emit(d: number, lastEid: number) {
    const hops: LoopHop[] = [];
    const tokens: string[] = [];
    for (let j = 0; j <= d; j++) {
      const e = this.edges[j < d ? this.edgeAt[j] : lastEid];
      tokens.push(this.tokNames[this.tokAt[j]]);
      hops.push({ poolKey: this.poolKeys[e.pool], tokenIn: this.tokNames[this.tokAt[j]], tokenOut: this.tokNames[e.to], inIsA: e.inIsA });
    }
    const base = tokens[0];
    const keys = hops.map((h) => h.poolKey);
    this.cycles.push({ id: this.cycles.length, sig: `${base}:${keys.join('>')}`, poolSet: [...keys].sort().join(','), base, hops, tokens });
    this.byLen[hops.length] = (this.byLen[hops.length] ?? 0) + 1;
    this.passCount++;
  }
}

// Lists all loops in one go (no slicing). Used by tests and small maps.
export function enumerateCycles(
  pools: PoolState[], bases: string[], minPools: number, maxPools: number,
  opts: CycleSearchOptions = {},
): { cycles: LoopCycle[]; steps: number; capped: boolean; byLen: number[] } {
  const s = new CycleSearch(pools, bases, minPools, maxPools, opts);
  s.run(Infinity);
  return { cycles: s.cycles, steps: s.steps, capped: s.capped, byLen: s.byLen };
}

// ----------------------------------------------------------------------------
// The finder (keeps the loop list between updates)
// ----------------------------------------------------------------------------

const poolSig = (p: PoolState) => `${p.sqrtPriceX96 ?? ''}:${p.liquidity ?? ''}:${p.reserveA ?? ''}:${p.reserveB ?? ''}:${p.feePips ?? p.feeBps}`;

// How the last loop list rebuild went (for the hourly report and tests).
export interface RebuildStats {
  cycles: number;
  byLen: number[];        // loops listed per length
  steps: number;
  capped: boolean;
  totalMs: number;        // start to finish, including the time the bot ran in between slices
  workMs: number;         // time actually spent listing
  maxSliceMs: number;     // longest single slice (how long the bot was held up at most)
  slices: number;
}

interface RebuildJob {
  search: CycleSearch;
  byPool: Map<string, number[]>; // pool -> loops through it, filled in slices after the search
  indexed: number;               // loops added to byPool so far
  started: number;        // performance.now()
  workMs: number;
  maxSliceMs: number;
  slices: number;
}

export class LoopFinder {
  readonly cfg: LoopFinderConfig;
  private cycles: LoopCycle[] = [];
  private byPool = new Map<string, number[]>();      // pool -> loops through it
  private pools = new Map<string, PoolState>();      // latest state of every usable pool
  private sigs = new Map<string, string>();          // pool -> price state last seen
  private moved = new Map<string, number>();         // pool -> when its price last changed
  private curves = new Map<string, { ab: HopCurve | null; ba: HopCurve | null }>(); // pool -> quick-check curves
  private depths = new Map<string, { v: number | null; at: number }>();            // pool -> depth (cached 5 s)
  private poolSetKey = '';                           // which pools the loop list was built from
  private lastRebuild = -Infinity;
  private job: RebuildJob | null = null;             // rebuild in progress (in slices)
  private ready: { search: CycleSearch; byPool: Map<string, number[]>; stats: RebuildStats } | null = null; // finished rebuild, put in place on the next update
  private idleWaiters: (() => void)[] = [];
  private pending = new Set<number>();               // loops still to be priced (time budget ran out)
  private builtRates = new Map<string, number>();    // pool -> price when the list was built
  private bigMove = false;                           // a pool moved enough that the long-loop list may be stale
  private setDirty = false;                          // a pool joined or left since the last rebuild
  lastCapped = false;                                // loop list hit LOOP_MAX_CYCLES (some length) or the step cap
  lastStats: RebuildStats | null = null;          // how the last rebuild went
  rebuilds = 0;

  constructor(cfg: Partial<LoopFinderConfig> & { bases: string[] }, private env: LoopEnv) {
    this.cfg = { ...DEFAULT_FINDER_CONFIG, ...cfg, bases: cfg.bases.map(lc) };
  }

  cycleCount(): number { return this.cycles.length; }
  cycleById(id: number): LoopCycle | undefined { return this.cycles[id]; }
  // Loops in the list per length (index = pools).
  cyclesByLen(): number[] { return this.lastStats ? [...this.lastStats.byLen] : []; }
  rebuildStats(): RebuildStats | null { return this.lastStats; }
  rebuilding(): boolean { return this.job !== null; }
  // Resolves when no rebuild is running (the result goes in on the next update).
  idle(): Promise<void> { return this.job ? new Promise((r) => this.idleWaiters.push(r)) : Promise.resolve(); }

  // Smallest log return a long loop must be able to reach to be listed:
  // pay its gas on the biggest allowed trade, minus the slack.
  private minLog = (len: number): number =>
    Math.log1p(Math.max(0, this.env.gasUsd(len)) / this.cfg.maxTradeUsd) + Math.log(1 - Math.min(0.5, Math.max(0, this.cfg.longSlack)));

  // True when an update would do something even if no pool changed: a
  // finished rebuild to put in place, loops still waiting to be priced, or
  // the loop list is due for its regular rebuild. Used by the cheap loop
  // scan (LOOP_CHEAP_SCAN) to skip updates where nothing changed.
  needsWork(now = this.env.now()): boolean {
    if (this.ready || this.pending.size) return true;
    return !this.job && now - this.lastRebuild >= this.cfg.rebuildMs;
  }

  // Call after every price update with the pools that may be used.
  // Runs all at once (same code as updateSteps, no breaks).
  update(poolsIn: PoolState[]): UpdateOutcome {
    return drainSteps(this.updateSteps(poolsIn));
  }

  // The same update written as steps (LOOP_CHEAP_SCAN): it says `yield` at
  // safe points, so the caller can run it in small slices (core/chunked.ts
  // runSteps) and let feed messages through in between. Same answer as
  // update(): the time budget below counts WORK time only (breaks between
  // slices are not counted), and the pools list is the one handed in.
  *updateSteps(poolsIn: PoolState[]): Generator<void, UpdateOutcome, void> {
    const t0 = performance.now();
    let paused = 0; // time spent in breaks between slices (not work)
    const work = () => performance.now() - t0 - paused;
    // Take a break: remember how long it lasted so the budget ignores it.
    const brk = function* (): Generator<void, void, void> { const b = performance.now(); yield; paused += performance.now() - b; };
    const now = this.env.now();
    let rebuilt = false;
    // A rebuild that finished in the background goes in now (loop ids change here only).
    if (this.ready) { this.install(); rebuilt = true; }

    const fresh = new Map<string, PoolState>();
    let i = 0;
    for (const p of poolsIn) {
      if (hasExactMath(p)) fresh.set(lc(p.poolAddress), p);
      if ((++i & 255) === 0) yield* brk();
    }

    // Which pools changed price since last time?
    const changed: string[] = [];
    const longOn = this.cfg.maxPools >= this.cfg.longFromPools;
    const bigMoveAt = Math.min(0.5, Math.max(0, this.cfg.longSlack)) / 2;
    i = 0;
    for (const [k, p] of fresh) {
      if ((++i & 127) === 0) yield* brk();
      const s = poolSig(p);
      if (this.sigs.get(k) === s) continue;
      if (!this.sigs.has(k)) this.setDirty = true; // a pool joined the set
      changed.push(k); this.sigs.set(k, s); this.moved.set(k, now);
      const ab = hopCurve(p, true), ba = hopCurve(p, false);
      this.curves.set(k, { ab, ba });
      this.depths.delete(k);
      // A price move bigger than half the slack since the list was built:
      // long loops through this pool may now be close to paying but not listed.
      if (longOn && ab) {
        const was = this.builtRates.get(k);
        if (was !== undefined && Math.abs(Math.log((ab.g * ab.rout) / ab.rin) - was) > bigMoveAt) this.bigMove = true;
      }
    }
    // Pools that left the set (collected first, then removed: a Map must not
    // be changed while it is being walked across a break).
    const gone: string[] = [];
    i = 0;
    for (const k of this.sigs.keys()) {
      if (!fresh.has(k)) gone.push(k);
      if ((++i & 255) === 0) yield* brk();
    }
    for (const k of gone) { this.sigs.delete(k); this.moved.delete(k); this.curves.delete(k); this.depths.delete(k); }
    if (gone.length) this.setDirty = true;
    this.pools = fresh;

    // Rebuild the loop list when the pool set changed or a price moved a lot
    // (rate-limited), or when it's old. Only one rebuild at a time.
    if (!this.job) {
      const due = now - this.lastRebuild >= this.cfg.rebuildMs;
      // The sorted list of pool keys is only built when a pool joined or
      // left since the last rebuild (before: on every update, a big sort
      // and join each time). If none did, the set is the same as at the
      // last rebuild, so the answer is the same.
      let setChanged = false;
      let setKey = this.poolSetKey;
      if (this.setDirty && (due || now - this.lastRebuild >= this.cfg.rebuildMinMs || this.bigMove)) {
        setKey = [...fresh.keys()].sort().join(',');
        setChanged = setKey !== this.poolSetKey;
      }
      const early = (setChanged || this.bigMove) && now - this.lastRebuild >= this.cfg.rebuildMinMs;
      if (due || early) {
        this.poolSetKey = setKey; this.lastRebuild = now; this.bigMove = false; this.setDirty = false;
        this.startRebuild(now);
        // Small maps finish in the first slice: put the new list in right away.
        if (this.ready) { this.install(); rebuilt = true; }
      }
    }
    yield* brk();

    // Loops to re-price: those through a changed pool, then any left over
    // from earlier updates (after a rebuild that's every loop).
    const todo = new Set<number>();
    for (const k of changed) for (const id of this.byPool.get(k) ?? []) todo.add(id);
    for (const id of this.pending) todo.add(id);
    this.pending.clear();

    // Quick check (closed form) for each loop, keep the best few for the exact check.
    // Time budget: the quick checks may use up to 60% of it, the exact checks the rest.
    const budget = this.cfg.updateBudgetMs;
    const quick: { id: number; net: number }[] = [];
    const done: number[] = [];
    let n = 0;
    for (const id of todo) {
      if ((n & 63) === 63) yield* brk();
      if ((++n & 63) === 0 && work() > budget * 0.6) { this.pending.add(id); continue; }
      if (this.pending.size) { this.pending.add(id); continue; }
      done.push(id);
      const q = this.quickNet(this.cycles[id], now);
      if (q !== null && q > 0) quick.push({ id, net: q });
    }
    quick.sort((a, b) => b.net - a.net);
    const results: LoopResult[] = [];
    const noVerdict = new Set<number>();
    for (let j = 0; j < quick.length; j++) {
      const q = quick[j];
      if (j >= this.cfg.exactTopK) { noVerdict.add(q.id); continue; }
      if (j > 0 && work() > budget) { noVerdict.add(q.id); this.pending.add(q.id); continue; }
      if (j > 0) yield* brk(); // one exact check per step (each is a few hundred maths steps)
      const r = this.exact(this.cycles[q.id]);
      if (r && r.netUsd > 0) results.push(r);
    }
    results.sort((a, b) => b.netUsd - a.netUsd);
    // Loops that passed the quick check but missed the exact check this time
    // have no verdict: left out of `evaluated`. Loops not reached in time
    // are priced on the next update.
    const evaluated = noVerdict.size ? done.filter((id) => !noVerdict.has(id)) : done;
    return { results, evaluated, changedPools: changed.length, rebuilt, cycles: this.cycles.length, ms: work(), waiting: this.pending.size };
  }

  // Start a rebuild. Order: pools rival loops used first, then pools that
  // moved in the last 10 minutes, then deeper pools, so when a length's
  // share is full the most useful loops are already in the list.
  private startRebuild(now: number) {
    const score = new Map<string, number>();
    for (const [k, p] of this.pools) {
      const recent = now - (this.moved.get(k) ?? -Infinity) < 10 * 60_000 ? 1e12 : 0;
      score.set(k, recent + (this.depthOf(k, p, now) ?? 0));
    }
    let prefer: Set<string> | undefined;
    try { prefer = this.env.rivalPools?.(); } catch { prefer = undefined; }
    const lens = Math.max(1, this.cfg.maxPools - this.cfg.minPools + 1);
    const search = new CycleSearch([...this.pools.values()], this.cfg.bases, this.cfg.minPools, this.cfg.maxPools, {
      maxCycles: this.cfg.maxCycles, maxSteps: this.cfg.maxStepsPerLength * lens,
      order: (k) => score.get(k) ?? 0, preferPools: prefer,
      longFrom: this.cfg.longFromPools, minLog: this.minLog,
    });
    this.job = { search, byPool: new Map(), indexed: 0, started: performance.now(), workMs: 0, maxSliceMs: 0, slices: 0 };
    this.slice();
  }

  // One slice of rebuild work; schedules the next slice if not finished.
  // setImmediate lets price updates, timers and node replies run in between.
  private slice = () => {
    const job = this.job;
    if (!job) return;
    // Stall finder: times this slice as "loop rebuild" (measurement only).
    const endTimer = stallFinder.begin('loop rebuild');
    const s0 = performance.now(), deadline = s0 + this.cfg.sliceMs;
    let finished = job.search.run(deadline);
    // Then the "which loops go through which pool" index, also in slices.
    if (finished) {
      const cs = job.search.cycles;
      while (job.indexed < cs.length) {
        if ((job.indexed & 255) === 255 && performance.now() > deadline) { finished = false; break; }
        const c = cs[job.indexed++];
        for (const h of c.hops) (job.byPool.get(h.poolKey) ?? job.byPool.set(h.poolKey, []).get(h.poolKey)!).push(c.id);
      }
    }
    const took = performance.now() - s0;
    endTimer();
    job.workMs += took; job.slices++; job.maxSliceMs = Math.max(job.maxSliceMs, took);
    if (!finished) { setImmediate(this.slice); return; }
    const s = job.search;
    this.ready = { search: s, byPool: job.byPool, stats: {
      cycles: s.cycles.length, byLen: [...s.byLen].map((x) => x ?? 0), steps: s.steps, capped: s.capped,
      totalMs: performance.now() - job.started, workMs: job.workMs, maxSliceMs: job.maxSliceMs, slices: job.slices,
    } };
    this.job = null;
    const w = this.idleWaiters; this.idleWaiters = [];
    for (const f of w) f();
  };

  // Put a finished loop list in place. Every loop gets priced (within the
  // time budget, the rest on the next updates).
  private install() {
    const { search, byPool, stats } = this.ready!;
    this.ready = null;
    const t = performance.now();
    this.cycles = search.cycles;
    this.lastCapped = search.capped;
    this.builtRates = search.rates;
    this.byPool = byPool;
    this.pending = new Set(this.cycles.map((c) => c.id));
    const took = performance.now() - t;
    this.lastStats = { ...stats, workMs: stats.workMs + took, maxSliceMs: Math.max(stats.maxSliceMs, took) };
    this.rebuilds++;
  }

  // Money in a pool near its price (cached for 5 s, or until the pool changes).
  private depthOf(k: string, p: PoolState, now: number): number | null {
    const c = this.depths.get(k);
    if (c && now - c.at < 5_000) return c.v;
    const v = this.env.depthUsd(p);
    this.depths.set(k, { v, at: now });
    return v;
  }

  // Biggest input for a loop, in base-coin raw units: LOOP_MAX_TRADE_USD and
  // a share of the shallowest pool's depth, whichever is smaller.
  private capRaw(c: LoopCycle, pools: PoolState[], now = this.env.now()): { cap: number; usd: number; dec: number } | null {
    const dec = this.env.decimalsOf(c.base), usd = this.env.usdOf(c.base);
    if (dec === undefined || !usd || !(usd > 0)) return null;
    let minDepth = Infinity;
    for (let i = 0; i < pools.length; i++) { const d = this.depthOf(c.hops[i].poolKey, pools[i], now); minDepth = Math.min(minDepth, d === null ? 0 : d); }
    const capUsd = Math.min(this.cfg.maxTradeUsd, minDepth * this.cfg.depthShare);
    if (!(capUsd > 0)) return null;
    return { cap: (capUsd / usd) * 10 ** dec, usd, dec };
  }

  private poolsOf(c: LoopCycle): PoolState[] | null {
    const out: PoolState[] = [];
    for (const h of c.hops) { const p = this.pools.get(h.poolKey); if (!p) return null; out.push(p); }
    return out;
  }

  // Quick check: closed-form best size on the combined curve. Float maths.
  // Returns the model profit after gas in USD, or null if it can't pay.
  private quickNet(c: LoopCycle | undefined, now: number): number | null {
    if (!c) return null;
    // Combine the pools' curves (same maths as composeCurves, without making arrays).
    let A = 1, C = 0;
    for (const h of c.hops) {
      const cv = this.curves.get(h.poolKey);
      const k = cv ? (h.inIsA ? cv.ab : cv.ba) : null;
      if (!k) return null;
      const a = k.g * k.rout, b = k.rin;
      C = (b * C + k.g * A) / b;
      A = (a * A) / b;
    }
    if (!(A > 1)) return null; // the loop loses money even on a tiny trade
    const pools = this.poolsOf(c);
    if (!pools) return null;
    const cap = this.capRaw(c, pools, now);
    if (!cap) return null;
    // Never size past a price band edge or a pool's real balance (Oct 13).
    const { profit } = bestInputClosedForm(A, C, Math.min(cap.cap, maxLoopInput(pools, c.hops)));
    const scale = cap.usd / 10 ** cap.dec;
    return profit * scale - this.env.gasUsd(c.hops.length);
  }

  // Exact check: integer pool maths, best size by golden-section search.
  // Sizes are limited so no hop leaves its price band or pays out more than
  // it really holds (maxLoopInput), and each hop is priced with
  // realisticHopOut as a second safety net. So the number reported is exact
  // within the band and never relies on coins a pool doesn't have.
  exact(c: LoopCycle): LoopResult | null {
    const pools = this.poolsOf(c);
    if (!pools) return null;
    const cap = this.capRaw(c, pools);
    if (!cap) return null;
    const hi = Math.min(cap.cap, maxLoopInput(pools, c.hops));
    if (!(hi >= 1)) return null;
    const toBig = (x: number) => BigInt(Math.max(0, Math.floor(x)));
    const out = (a: bigint) => exactLoopOut(pools, c.hops, a, { realistic: true });
    const f = (x: number) => { const a = toBig(x); return Number(out(a) - a); };
    const best = goldenMax(f, 0, hi);
    const amountIn = toBig(best.x);
    if (amountIn <= 0n) return null;
    const amountOut = out(amountIn);
    const scale = cap.usd / 10 ** cap.dec;
    const grossUsd = Number(amountOut - amountIn) * scale;
    const gasUsd = this.env.gasUsd(c.hops.length);
    const tradable = c.tokens.every((t) => this.env.isTradable(t));
    return { cycle: c, amountIn, amountOut, sizeUsd: Number(amountIn) * scale, grossUsd, gasUsd, netUsd: grossUsd - gasUsd, tradable, pools };
  }
}
