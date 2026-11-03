// ============================================================================
// TICK WINDOWS: the price ranges next to the current price, per V3/V4 pool
// (Nov 2, STOCK_TICK_MATH, default ON; STOCK_TICK_MATH=0 in .env = old maths)
//
// Plain English:
//   The quick guess (dexMath.computeAmountOut) used to treat a V3/V4 pool as
//   if the money at the current price went on forever. On Robinhood's stock
//   token pools that is badly wrong: many of them hold ONE narrow position,
//   and the price sits right at its edge (Nov 2 server check, same block):
//     USDG/SNDK V4 0x6d65849d: only range [200640, 204120], price at 204119,
//       so selling SNDK into it gets ~nothing. The guess said $1,074 back
//       for $1,100; the pool's own quoter refuses (not enough liquidity).
//     GOOGL/USDG V4 0xfa29c8b2: price exactly at the bottom of its only range.
//     USDG/BE V4 0xe20e96cb, USDG/HIMS V4 0x357c92ce: price 0.01% from the edge.
//     GOOGL/USDG V3 0x553e9a45: selling $1,100 of GOOGL really gives $112,
//       the guess said $1,071.
//   Those "phantom" gaps ($15 to $170) filled the pair-block list and wasted
//   practice checks.
//
//   This file reads, for each V3/V4 pool the bot prices, the range edges
//   (initialized ticks and their liquidity change) in a few bitmap "words"
//   around the price, in the background, bundled into Multicall3 requests.
//   The quick guess then walks the trade range by range (core/tickMath.ts),
//   exactly like the pool. It also reads the V4 PROTOCOL FEE (0.05-0.10% on
//   Robinhood V4 pools, which the bot never charged).
//
//   Until a pool's window is loaded, the old maths is used (nothing breaks).
//   A trade running past the loaded window counts the rest as getting
//   nothing back, so the new guess can only be too careful, never greedy.
//
// Settings (.env, optional):
//   STOCK_TICK_MATH=0          off: old single-range maths, no V4 protocol fee
//   TICK_WINDOW_WORDS=2        bitmap words read each side of the price (2 => 5 words)
//   TICK_WINDOW_REFRESH_MS     re-read a window older than this (default 120000)
//   TICK_WINDOW_MAX_AGE_MS     stop trusting a window older than this (default 900000)
// ============================================================================

import { ethers } from 'ethers';
import type { PoolState } from './types';
import { TickWindow, TickEdge, getTickAtSqrtRatio, getSqrtRatioAtTick, swapExactInTicks, ticksInWord, wordOf, wordsRange, v4SwapFeePips } from './tickMath';

export function stockTickMathOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.STOCK_TICK_MATH !== '0';
}

// LOOP FINDER switch (Nov 2, LOOP_TICK_MATH, default ON). The loop finder
// (core/loopFinder.ts) prices each V3/V4 hop with the same range-by-range
// walk and V4 protocol fee as the 2-pool guess. LOOP_TICK_MATH=0 = the loop
// finder's old maths (current price band only, LP fee only). STOCK_TICK_MATH=0
// also turns it off (one switch puts everything back).
export function loopTickMathOn(env: Record<string, string | undefined> = process.env): boolean {
  return stockTickMathOn(env) && env.LOOP_TICK_MATH !== '0';
}

type CallMany = (calls: { target: string; data: string }[]) => Promise<(string | null)[]>;

// V3 pool reads
const SEL_V3_SLOT0 = '0x3850c7bd';        // slot0()
const SEL_V3_TS = '0xd0c93a7c';           // tickSpacing()
const SEL_V3_BITMAP = '0x5339c296';       // tickBitmap(int16)
const SEL_V3_TICKS = '0xf30dba93';        // ticks(int24): liquidityGross, liquidityNet, ...
// V4 StateView reads
const SEL_V4_SLOT0 = ethers.id('getSlot0(bytes32)').slice(0, 10);
const SEL_V4_BITMAP = ethers.id('getTickBitmap(bytes32,int16)').slice(0, 10);
const SEL_V4_TICKLIQ = ethers.id('getTickLiquidity(bytes32,int24)').slice(0, 10);

// FREEZE FIX (Nov 2, after deploy): ethers' general encoder took ~1 s per
// 5 min of the main thread here (freeze log: loadPending > enc24), because a
// refresh round encodes thousands of tick numbers. Hand encoding gives the
// exact same 32-byte two's-complement word (test: stockTickMath.test.ts).
const TWO256 = 1n << 256n;
export function encInt(v: number): string {
  if (v >= 0) return v.toString(16).padStart(64, '0');
  return (TWO256 + BigInt(v)).toString(16);
}
const enc16 = encInt;
const enc24 = encInt;
const word = (hex: string | null, i: number): bigint | null => (hex && hex.length >= 2 + 64 * (i + 1) ? BigInt('0x' + hex.slice(2 + 64 * i, 2 + 64 * (i + 1))) : null);
const int24 = (v: bigint) => Number(BigInt.asIntN(24, v));
const int128 = (v: bigint) => BigInt.asIntN(128, v);

// A V4 hook that can change swap amounts (beforeSwap/afterSwap "return
// delta" flags) makes normal pool maths meaningless: never tick-walk those.
function hookChangesAmounts(hook: string | undefined): boolean {
  if (!hook || /^0x0{40}$/i.test(hook)) return false;
  try { return (Number(BigInt(hook) & 0x3fffn) & ((1 << 3) | (1 << 2))) !== 0; } catch { return true; }
}

// Which pools this works for: Robinhood V3-style (Uniswap V3 and its copies,
// not Algebra, which keeps ticks differently) and V4 pools.
export function tickEligible(p: PoolState): boolean {
  if (p.chain !== 'robinhood' || p.poolType !== 'v3' || p.variant === 'algebra') return false;
  if (p.sqrtPriceX96 === undefined || p.liquidity === undefined || p.sqrtPriceX96 <= 0n) return false;
  if (p.v4) return Number.isInteger(p.v4.tickSpacing) && p.v4.tickSpacing > 0 && !!p.v4.stateView && !hookChangesAmounts(p.v4.hooks);
  return /^0x[0-9a-fA-F]{40}$/.test(p.poolAddress);
}

// One pool's loaded window, as kept in the book (and as sent to the loop
// worker thread, which has its own book: see loopWorkerFeed.ts).
export interface Entry {
  win: TickWindow | null;
  protocolFee: number;       // V4 only (packed, both directions)
  loadedMs: number;
  failUntil: number;         // reads failed: old maths for a while
}

export interface TickBookStats { loads: number; loadFails: number; pools: number; used: number; fellBack: number; leftWindow: number; requests: number }

export class TickWindowBook {
  private book = new Map<string, Entry>();
  private pending = new Map<string, PoolState>();
  private loading = false;
  private tickMemo = new Map<string, { sqrt: bigint; tick: number }>();
  // PASSIVE (the loop worker thread): this book never asks for reads (it has
  // no node); the main thread sends it the windows it loaded (putEntry).
  private passive = false;
  readonly stats: TickBookStats = { loads: 0, loadFails: 0, pools: 0, used: 0, fellBack: 0, leftWindow: 0, requests: 0 };
  constructor(
    private readonly o: { words?: number; refreshMs?: number; maxAgeMs?: number; now?: () => number; maxPools?: number } = {},
  ) {}
  private get words() { return this.o.words ?? Math.max(0, Math.min(8, Number(process.env.TICK_WINDOW_WORDS ?? 2))); }
  private get refreshMs() { return this.o.refreshMs ?? Number(process.env.TICK_WINDOW_REFRESH_MS ?? 120_000); }
  private get maxAgeMs() { return this.o.maxAgeMs ?? Number(process.env.TICK_WINDOW_MAX_AGE_MS ?? 900_000); }
  private now() { return (this.o.now ?? Date.now)(); }
  private key(p: PoolState) { return p.poolAddress.toLowerCase(); }

  // The pool's current tick, worked out from its price (memoized per price:
  // the same pool state is priced many times while sizing a trade).
  tickOf(p: PoolState): number {
    const k = this.key(p), m = this.tickMemo.get(k);
    if (m && m.sqrt === p.sqrtPriceX96) return m.tick;
    const tick = getTickAtSqrtRatio(p.sqrtPriceX96!);
    if (this.tickMemo.size > 20_000) this.tickMemo.clear();
    this.tickMemo.set(k, { sqrt: p.sqrtPriceX96!, tick });
    return tick;
  }

  // The window to use for this pool right now, or null (then: old maths).
  // Asks for a (re)load in the background when missing, old, or when the
  // price has moved out of it.
  windowFor(p: PoolState): TickWindow | null {
    if (!tickEligible(p)) return null;
    const k = this.key(p), e = this.book.get(k), t = this.now();
    if (!e) { this.want(p); return null; }
    if (e.failUntil > t) return null;
    const age = t - e.loadedMs;
    if (age > this.refreshMs) this.want(p);
    if (!e.win || age > this.maxAgeMs) return null;
    const tick = this.tickOf(p);
    if (tick < e.win.lo || tick > e.win.hi) { this.want(p); return null; }
    return e.win;
  }

  protocolFee(p: PoolState): number { return this.book.get(this.key(p))?.protocolFee ?? 0; }

  // The 30 s sweep over all watched pools: only pools with NO window yet are
  // queued (old windows are refreshed when a guess actually uses them, in
  // windowFor), so pools nobody prices don't cost reads or main-thread time.
  wantIfMissing(p: PoolState) {
    if (!this.book.has(this.key(p))) this.want(p);
  }

  want(p: PoolState) {
    if (this.passive || !tickEligible(p)) return;
    const k = this.key(p);
    if (!this.pending.has(k) && this.pending.size < 5_000) this.pending.set(k, p);
  }

  pendingCount(): number { return this.pending.size; }
  size(): number { return this.book.size; }

  setPassive(on: boolean) { this.passive = on; if (on) this.pending.clear(); }

  // The raw entry for a pool key (lower-case address / V4 id), or undefined.
  // A new object every load, so callers can tell "changed" by reference.
  entry(key: string): Entry | undefined { return this.book.get(key.toLowerCase()); }
  // Put an entry read elsewhere (the main thread's book, sent to the loop worker).
  putEntry(key: string, e: Entry) { this.book.set(key.toLowerCase(), e); if (this.book.size > 20_000) this.prune(); }
  drop(key: string) { this.book.delete(key.toLowerCase()); }

  // Test hook / recorded state: put a window in directly.
  put(poolAddress: string, win: TickWindow, protocolFee = 0) {
    this.book.set(poolAddress.toLowerCase(), { win, protocolFee, loadedMs: this.now(), failUntil: 0 });
  }

  // Background loader: reads up to maxPools waiting pools in 3 bundled
  // rounds (price+spacing, bitmap words, tick liquidity). Read-only.
  async loadPending(callMany: CallMany): Promise<number> {
    if (this.loading || !this.pending.size) return 0;
    this.loading = true;
    const max = this.o.maxPools ?? 60;
    const batch = [...this.pending.values()].slice(0, max);
    for (const p of batch) this.pending.delete(this.key(p));
    try {
      // Round 1: current tick (+ V4 protocol fee), and V3 tick spacing.
      const r1calls: { target: string; data: string }[] = [];
      for (const p of batch) {
        if (p.v4) r1calls.push({ target: p.v4.stateView, data: SEL_V4_SLOT0 + p.poolAddress.slice(2) });
        else { r1calls.push({ target: p.poolAddress, data: SEL_V3_SLOT0 }); r1calls.push({ target: p.poolAddress, data: SEL_V3_TS }); }
      }
      this.stats.requests++;
      const r1 = await callMany(r1calls);
      const info: { p: PoolState; tick: number; ts: number; pf: number; words: number[] }[] = [];
      let i = 0;
      for (const p of batch) {
        let tick: number | null = null, ts: number | null = null, pf = 0;
        if (p.v4) {
          const r = r1[i++]; const t = word(r, 1), f = word(r, 2);
          if (t !== null) tick = int24(t);
          if (f !== null) pf = Number(f & 0xffffffn);
          ts = p.v4.tickSpacing;
        } else {
          const r = r1[i++], rts = r1[i++]; const t = word(r, 1), s = word(rts, 0);
          if (t !== null) tick = int24(t);
          if (s !== null) ts = int24(s);
        }
        if (tick === null || !ts || ts < 1) { this.fail(p); continue; }
        const w0 = wordOf(tick, ts), K = this.words, words: number[] = [];
        for (let w = w0 - K; w <= w0 + K; w++) if (w >= -32768 && w <= 32767) words.push(w);
        info.push({ p, tick, ts, pf, words });
      }
      // Round 2: bitmap words around the price.
      const r2calls: { target: string; data: string }[] = [];
      for (const x of info) for (const w of x.words) r2calls.push(x.p.v4
        ? { target: x.p.v4.stateView, data: SEL_V4_BITMAP + x.p.poolAddress.slice(2) + enc16(w) }
        : { target: x.p.poolAddress, data: SEL_V3_BITMAP + enc16(w) });
      this.stats.requests++;
      const r2 = r2calls.length ? await callMany(r2calls) : [];
      i = 0;
      const withTicks: { x: typeof info[number]; ticks: number[]; ok: boolean }[] = [];
      for (const x of info) {
        const ticks: number[] = []; let ok = true;
        for (const w of x.words) { const b = word(r2[i++], 0); if (b === null) ok = false; else ticks.push(...ticksInWord(w, b, x.ts)); }
        withTicks.push({ x, ticks, ok });
      }
      // Round 3: liquidity change at each range edge.
      const r3calls: { target: string; data: string }[] = [];
      for (const y of withTicks) if (y.ok) for (const t of y.ticks) r3calls.push(y.x.p.v4
        ? { target: y.x.p.v4.stateView, data: SEL_V4_TICKLIQ + y.x.p.poolAddress.slice(2) + enc24(t) }
        : { target: y.x.p.poolAddress, data: SEL_V3_TICKS + enc24(t) });
      this.stats.requests++;
      const r3 = r3calls.length ? await callMany(r3calls) : [];
      i = 0;
      let loaded = 0;
      for (const y of withTicks) {
        if (!y.ok) { this.fail(y.x.p); continue; }
        const edges: TickEdge[] = []; let ok = true;
        for (const t of y.ticks) { const n = word(r3[i++], 1); if (n === null) ok = false; else edges.push({ tick: t, liquidityNet: int128(n) }); }
        if (!ok) { this.fail(y.x.p); continue; }
        edges.sort((a, b) => a.tick - b.tick);
        const rg = wordsRange(y.x.words[0], y.x.words[y.x.words.length - 1], y.x.ts);
        this.book.set(this.key(y.x.p), { win: { lo: rg.lo, hi: rg.hi, tickSpacing: y.x.ts, ticks: edges, block: 0, ms: this.now() }, protocolFee: y.x.p.v4 ? y.x.pf : 0, loadedMs: this.now(), failUntil: 0 });
        loaded++;
      }
      this.stats.loads += loaded;
      this.stats.pools = this.book.size;
      if (this.book.size > 20_000) this.prune();
      return loaded;
    } catch {
      // Node trouble: put them back, try again next round.
      for (const p of batch) this.want(p);
      this.stats.loadFails++;
      return 0;
    } finally {
      this.loading = false;
    }
  }

  private fail(p: PoolState) {
    this.stats.loadFails++;
    // A pool whose ticks can't be read (an odd V3 copy): old maths for an hour.
    this.book.set(this.key(p), { win: null, protocolFee: 0, loadedMs: this.now(), failUntil: this.now() + 3_600_000 });
  }

  private prune() {
    const cutoff = this.now() - this.maxAgeMs;
    for (const [k, e] of this.book) if (e.loadedMs < cutoff) this.book.delete(k);
  }
}

// The one book the bot uses (dexMath reads it, shadowMain loads it).
export const tickBook = new TickWindowBook();

// THE NEW GUESS. Returns the pool's output for this exact-input trade
// walking real ranges, or undefined when the old maths should be used
// (switched off, not a V3/V4 pool, or its window isn't loaded yet).
// lpFeePips: the fee the old maths would charge (dexMath.feePipsOf), so
// dynamic / event fees keep working; the V4 protocol fee is added here.
export function tickAwareAmountOut(pool: PoolState, zeroForOne: boolean, amountIn: bigint, lpFeePips: number, book: TickWindowBook = tickBook): bigint | null | undefined {
  if (!stockTickMathOn()) return undefined;
  const win = book.windowFor(pool);
  if (!win) return undefined;
  const fee = pool.v4 ? v4SwapFeePips(lpFeePips, book.protocolFee(pool), zeroForOne) : lpFeePips;
  const tick = book.tickOf(pool);
  const run = (t: number) => swapExactInTicks({ sqrtPriceX96: pool.sqrtPriceX96!, liquidity: pool.liquidity!, tick: t, feePips: fee, window: win, zeroForOne, amountIn });
  let r = run(tick);
  // Price exactly ON a range edge: the pool may already be "below" it
  // (tick - 1, after a downward crossing). Both readings are possible from
  // the price alone, so take the more careful one.
  if (getSqrtRatioAtTick(tick) === pool.sqrtPriceX96 && win.ticks.some((e) => e.tick === tick)) {
    const r2 = run(tick - 1);
    if (r2 && (!r || r2.amountOut < r.amountOut)) r = r2;
  }
  if (!r) { book.stats.fellBack++; return undefined; }
  book.stats.used++;
  if (r.leftWindow) book.stats.leftWindow++;
  return r.amountOut;
}
