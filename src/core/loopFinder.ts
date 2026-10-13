import { PoolState } from './types';
import { feePipsOf } from './dexMath';
import { clAmountOut, v2AmountOut } from './venueMath';

// ============================================================================
// LOOP FINDER -- finds 3 to 5 pool loops that end with more than they start
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
// How it stays fast (target: well under 20 ms per price update):
//   1. MAP: all pools become a map of coins (dots) joined by pools (lines).
//   2. LOOPS LIST: every path of 3-5 pools that starts and ends in a base
//      coin (WETH or USDG) is listed ONCE, up to LOOP_MAX_CYCLES loops.
//      Loops through pools that moved recently are kept first. The list is
//      rebuilt only when the set of pools changes (or once a minute).
//   3. ON EACH UPDATE only the loops that go through a pool whose price just
//      changed are re-priced.
//   4. QUICK CHECK: a chain of x*y=k swaps is itself one simple curve,
//      out = A*x / (1 + C*x). That gives the best size in one line of maths
//      (no searching), so thousands of loops cost about a millisecond.
//   5. EXACT CHECK: the few loops that pass the quick check are re-priced
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
// Known limit (same as the 2-pool scanner): V3-style pools are priced inside
// their current price band. A big trade that crosses into the next band is
// only an estimate. The practice check (a real eth_call) catches that.
// ============================================================================

const Q96 = 2 ** 96;
const lc = (s: string) => s.toLowerCase();

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
}

export interface LoopFinderConfig {
  bases: string[];       // coins a loop may start/end in, most preferred first (WETH, USDG)
  minPools: number;      // 3 (2-pool trades are the gap scanner's job)
  maxPools: number;      // LOOP_MAX_POOLS, default 5
  maxCycles: number;     // LOOP_MAX_CYCLES, default 5000
  maxTradeUsd: number;   // LOOP_MAX_TRADE_USD, default $2,000
  depthShare: number;    // LOOP_DEPTH_SHARE: trade at most this share of the shallowest pool's depth (0.3)
  exactTopK: number;     // how many quick-check winners get the exact check per update (20)
  maxDfsSteps: number;   // safety cap on the loop listing work (300,000 steps)
  rebuildMs: number;     // rebuild the loop list at least this often (60 s)
  rebuildMinMs: number;  // ...but never more often than this (5 s), even if pools come and go
}

export const DEFAULT_FINDER_CONFIG: Omit<LoopFinderConfig, 'bases'> = {
  minPools: 3, maxPools: 5, maxCycles: 5_000, maxTradeUsd: 2_000, depthShare: 0.3,
  exactTopK: 20, maxDfsSteps: 300_000, rebuildMs: 60_000, rebuildMinMs: 5_000,
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
  rebuilt: boolean;
  cycles: number;             // loops in the list
  ms: number;                 // time this update took
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

// Exact output of a whole loop.
export function exactLoopOut(pools: PoolState[], hops: LoopHop[], amountIn: bigint): bigint {
  let amt = amountIn;
  for (let i = 0; i < hops.length; i++) {
    amt = exactHopOut(pools[i], hops[i].inIsA, amt);
    if (amt <= 0n) return 0n;
  }
  return amt;
}

// ----------------------------------------------------------------------------
// The loop list
// ----------------------------------------------------------------------------

interface Edge { poolKey: string; other: string; inIsA: boolean }

// Lists loops of minPools..maxPools pools that start and end in a base coin.
// Each loop is listed once per direction: a loop that passes through two
// base coins is listed only from the more preferred one (WETH before USDG).
// No pool and no in-between coin is used twice in one loop.
// `order(poolKey)`: higher = explored first (recently moved, deep pools), so
// when a cap is hit the most useful loops are already in the list.
export function enumerateCycles(
  pools: PoolState[], bases: string[], minPools: number, maxPools: number,
  opts: { maxCycles?: number; maxSteps?: number; order?: (poolKey: string) => number } = {},
): { cycles: LoopCycle[]; steps: number; capped: boolean } {
  const maxCycles = opts.maxCycles ?? Infinity, maxSteps = opts.maxSteps ?? Infinity;
  const baseRank = new Map(bases.map((b, i) => [lc(b), i] as [string, number]));
  const adj = new Map<string, Edge[]>();
  for (const p of pools) {
    const k = lc(p.poolAddress), a = lc(p.tokenA), b = lc(p.tokenB);
    if (a === b) continue;
    (adj.get(a) ?? adj.set(a, []).get(a)!).push({ poolKey: k, other: b, inIsA: true });
    (adj.get(b) ?? adj.set(b, []).get(b)!).push({ poolKey: k, other: a, inIsA: false });
  }
  if (opts.order) for (const list of adj.values()) list.sort((x, y) => opts.order!(y.poolKey) - opts.order!(x.poolKey));

  const cycles: LoopCycle[] = [];
  let steps = 0, capped = false;
  const pathHops: LoopHop[] = [], pathTokens: string[] = [];
  const usedPools = new Set<string>(), usedTokens = new Set<string>();

  const dfs = (start: string, rank: number, cur: string): void => {
    for (const e of adj.get(cur) ?? []) {
      if (capped) return;
      if (++steps > maxSteps) { capped = true; return; }
      if (usedPools.has(e.poolKey)) continue;
      const depth = pathHops.length + 1;
      if (e.other === start) {
        if (depth >= minPools) {
          const hops = [...pathHops, { poolKey: e.poolKey, tokenIn: cur, tokenOut: start, inIsA: e.inIsA }];
          const keys = hops.map((h) => h.poolKey);
          cycles.push({ id: cycles.length, sig: `${start}:${keys.join('>')}`, poolSet: [...keys].sort().join(','), base: start, hops, tokens: [...pathTokens] });
          if (cycles.length >= maxCycles) { capped = true; return; }
        }
        continue;
      }
      if (depth >= maxPools || usedTokens.has(e.other)) continue;
      // A loop through a more preferred base coin is listed from that coin.
      const r = baseRank.get(e.other);
      if (r !== undefined && r < rank) continue;
      usedPools.add(e.poolKey); usedTokens.add(e.other);
      pathHops.push({ poolKey: e.poolKey, tokenIn: cur, tokenOut: e.other, inIsA: e.inIsA });
      pathTokens.push(e.other);
      dfs(start, rank, e.other);
      pathHops.pop(); pathTokens.pop();
      usedPools.delete(e.poolKey); usedTokens.delete(e.other);
    }
  };

  for (const [b, rank] of baseRank) {
    if (capped) break;
    if (!adj.has(b)) continue;
    pathTokens.length = 0; pathTokens.push(b); usedTokens.clear(); usedTokens.add(b);
    dfs(b, rank, b);
  }
  return { cycles, steps, capped };
}

// ----------------------------------------------------------------------------
// The finder (keeps the loop list between updates)
// ----------------------------------------------------------------------------

const poolSig = (p: PoolState) => `${p.sqrtPriceX96 ?? ''}:${p.liquidity ?? ''}:${p.reserveA ?? ''}:${p.reserveB ?? ''}:${p.feePips ?? p.feeBps}`;

export class LoopFinder {
  readonly cfg: LoopFinderConfig;
  private cycles: LoopCycle[] = [];
  private byPool = new Map<string, number[]>();      // pool -> loops through it
  private pools = new Map<string, PoolState>();      // latest state of every usable pool
  private sigs = new Map<string, string>();          // pool -> price state last seen
  private moved = new Map<string, number>();         // pool -> when its price last changed
  private poolSetKey = '';                           // which pools the loop list was built from
  private lastRebuild = -Infinity;
  lastCapped = false;                                // loop list hit LOOP_MAX_CYCLES or the step cap

  constructor(cfg: Partial<LoopFinderConfig> & { bases: string[] }, private env: LoopEnv) {
    this.cfg = { ...DEFAULT_FINDER_CONFIG, ...cfg, bases: cfg.bases.map(lc) };
  }

  cycleCount(): number { return this.cycles.length; }
  cycleById(id: number): LoopCycle | undefined { return this.cycles[id]; }

  // Call after every price update with the pools that may be used.
  update(poolsIn: PoolState[]): UpdateOutcome {
    const t0 = performance.now();
    const now = this.env.now();
    const fresh = new Map<string, PoolState>();
    for (const p of poolsIn) if (hasExactMath(p)) fresh.set(lc(p.poolAddress), p);

    // Which pools changed price since last time?
    const changed: string[] = [];
    for (const [k, p] of fresh) {
      const s = poolSig(p);
      if (this.sigs.get(k) !== s) { changed.push(k); this.sigs.set(k, s); this.moved.set(k, now); }
    }
    for (const k of this.sigs.keys()) if (!fresh.has(k)) { this.sigs.delete(k); this.moved.delete(k); }
    this.pools = fresh;

    // Rebuild the loop list when the pool set changed (rate-limited) or it's old.
    const setKey = [...fresh.keys()].sort().join(',');
    const due = now - this.lastRebuild >= this.cfg.rebuildMs;
    const setChanged = setKey !== this.poolSetKey && now - this.lastRebuild >= this.cfg.rebuildMinMs;
    let rebuilt = false;
    if (due || setChanged) { this.rebuild(now); this.poolSetKey = setKey; this.lastRebuild = now; rebuilt = true; }

    // Loops to re-price: all after a rebuild, else only those through a changed pool.
    let ids: number[];
    if (rebuilt) ids = this.cycles.map((c) => c.id);
    else {
      const set = new Set<number>();
      for (const k of changed) for (const id of this.byPool.get(k) ?? []) set.add(id);
      ids = [...set];
    }

    // Quick check (closed form) for each loop, keep the best few for the exact check.
    const quick: { id: number; net: number; xUsd: number }[] = [];
    for (const id of ids) {
      const q = this.quickNet(this.cycles[id]);
      if (q && q.net > 0) quick.push({ id, net: q.net, xUsd: q.xUsd });
    }
    quick.sort((a, b) => b.net - a.net);
    const results: LoopResult[] = [];
    for (const q of quick.slice(0, this.cfg.exactTopK)) {
      const r = this.exact(this.cycles[q.id]);
      if (r && r.netUsd > 0) results.push(r);
    }
    results.sort((a, b) => b.netUsd - a.netUsd);
    // Loops that passed the quick check but missed the exact check this time
    // (not in the top few) have no verdict: left out of `evaluated`.
    const noVerdict = new Set(quick.slice(this.cfg.exactTopK).map((q) => q.id));
    const evaluated = noVerdict.size ? ids.filter((id) => !noVerdict.has(id)) : ids;
    return { results, evaluated, changedPools: changed.length, rebuilt, cycles: this.cycles.length, ms: performance.now() - t0 };
  }

  // Rebuild the loop list. Pools that moved in the last 10 minutes go first,
  // then deeper pools, so the cap keeps the loops most likely to pay.
  private rebuild(now: number) {
    const score = new Map<string, number>();
    for (const [k, p] of this.pools) {
      const recent = now - (this.moved.get(k) ?? -Infinity) < 10 * 60_000 ? 1e12 : 0;
      score.set(k, recent + (this.env.depthUsd(p) ?? 0));
    }
    const { cycles, capped } = enumerateCycles([...this.pools.values()], this.cfg.bases, this.cfg.minPools, this.cfg.maxPools,
      { maxCycles: this.cfg.maxCycles, maxSteps: this.cfg.maxDfsSteps, order: (k) => score.get(k) ?? 0 });
    this.cycles = cycles;
    this.lastCapped = capped;
    this.byPool.clear();
    for (const c of cycles) for (const h of c.hops) (this.byPool.get(h.poolKey) ?? this.byPool.set(h.poolKey, []).get(h.poolKey)!).push(c.id);
  }

  // Biggest input for a loop, in base-coin raw units: LOOP_MAX_TRADE_USD and
  // a share of the shallowest pool's depth, whichever is smaller.
  private capRaw(c: LoopCycle, pools: PoolState[]): { cap: number; usd: number; dec: number } | null {
    const dec = this.env.decimalsOf(c.base), usd = this.env.usdOf(c.base);
    if (dec === undefined || !usd || !(usd > 0)) return null;
    let minDepth = Infinity;
    for (const p of pools) { const d = this.env.depthUsd(p); minDepth = Math.min(minDepth, d === null ? 0 : d); }
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
  private quickNet(c: LoopCycle): { net: number; xUsd: number } | null {
    const pools = this.poolsOf(c);
    if (!pools) return null;
    const curves: HopCurve[] = [];
    for (let i = 0; i < pools.length; i++) { const h = hopCurve(pools[i], c.hops[i].inIsA); if (!h) return null; curves.push(h); }
    const { A, C } = composeCurves(curves);
    if (!(A > 1)) return null; // the loop loses money even on a tiny trade
    const cap = this.capRaw(c, pools);
    if (!cap) return null;
    const { x, profit } = bestInputClosedForm(A, C, cap.cap);
    const scale = cap.usd / 10 ** cap.dec;
    return { net: profit * scale - this.env.gasUsd(c.hops.length), xUsd: x * scale };
  }

  // Exact check: integer pool maths, best size by golden-section search.
  exact(c: LoopCycle): LoopResult | null {
    const pools = this.poolsOf(c);
    if (!pools) return null;
    const cap = this.capRaw(c, pools);
    if (!cap || cap.cap < 1) return null;
    const toBig = (x: number) => BigInt(Math.max(0, Math.floor(x)));
    const f = (x: number) => { const a = toBig(x); return Number(exactLoopOut(pools, c.hops, a) - a); };
    const best = goldenMax(f, 0, cap.cap);
    const amountIn = toBig(best.x);
    if (amountIn <= 0n) return null;
    const amountOut = exactLoopOut(pools, c.hops, amountIn);
    const scale = cap.usd / 10 ** cap.dec;
    const grossUsd = Number(amountOut - amountIn) * scale;
    const gasUsd = this.env.gasUsd(c.hops.length);
    const tradable = c.tokens.every((t) => this.env.isTradable(t));
    return { cycle: c, amountIn, amountOut, sizeUsd: Number(amountIn) * scale, grossUsd, gasUsd, netUsd: grossUsd - gasUsd, tradable, pools };
  }
}
