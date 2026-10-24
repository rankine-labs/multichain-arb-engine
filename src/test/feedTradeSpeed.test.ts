import { ethers } from 'ethers';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { getHeapStatistics } from 'v8';
import { connect, Socket } from 'net';
import { PoolCache } from '../core/poolCache';
import { TransactionDecoder, DEFAULT_ROUTER_REGISTRY, fastParseCall, setFastParse, routerInterfaces } from '../core/decoder';
import { seedKnownAddresses, ROBINHOOD_V2, ROBINHOOD_V3, ROBINHOOD_V4, ROBINHOOD_TOKENS, ROBINHOOD_PANCAKE } from '../config/knownAddresses';
import { PriceOracle } from '../core/priceOracle';
import { FastFilter } from '../core/fastFilter';
import { deepEnough, priceOf, spreadPct } from '../core/poolPrice';
import { planBackrun } from '../core/backrunPlanner';
import { TurnQueue } from '../core/chunked';
import { liteDecode, setFastAbi, checksumAddress, encodeCallFast, abiEncodeFast } from '../core/abiLite';
import { discoverPairPoolsMulticall, Venue } from '../core/pairWatcher';
import { extraWatcherVenues } from '../config/robinhoodVenues';
import { ROBINHOOD_RAMSES } from '../config/knownAddresses';
import { v4PoolIdOf } from '../core/decoderV4Router';
import { LagProbe } from '../core/loopLag';
import { PoolState, RawChainEvent, DecodedSwap } from '../core/types';

// ============================================================================
// FEED TRADE SPEED (Oct 24): the per-transaction "feed trade" work.
//
// Live (fire-first, Oct 24 01:28-01:50 UTC): event-loop lag ~17 ms when the
// sidecar's answer for a trigger arrived; "feed trade" freezes up to 405 ms.
// The freeze report adds up every "feed trade" stretch inside one freeze, so
// 405 ms = MANY trades worked through back to back (a busy feed message, or
// several messages that piled up behind an earlier freeze), not one slow
// trade. This file:
//   1. proves the turn queue (core/chunked.ts TurnQueue) keeps order, never
//      drops anything, and lets network replies / timers in between turns;
//   2. proves the fast call reader (core/decoder.ts fastParseCall) gives
//      exactly ethers' answer (name + arguments), and the decoder's swaps
//      are identical with it on and off, on thousands of calls;
//   3. replays a feed through the same steps the bot runs (decode, lookup,
//      instant price tracking, filter, partner pools, prices, then the
//      decide part: planning against every partner) with the decide part
//      run at once (old) and in turns (FEED_TRADE_DEFER), and shows the
//      DECISIONS and the final pool cache are identical; also measures what
//      each step of one feed trade costs on a realistic world (~850 pools /
//      150 pairs in the cache, real router calldata, the real decoder,
//      filter, price oracle and back-run planner);
//   4. measures how long a sidecar answer waits to be read during that
//      replay, old vs new, with a real separate "sidecar" process on a socket.
// All timings here are TEST numbers (this machine; the server is a slower
// 2-vCPU machine with real traffic, roughly 2x).
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
let seed = 777;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (n: number) => Math.floor(rnd() * n);
const addr = (i: number, tag: number) => ethers.getAddress('0x' + tag.toString(16).padStart(4, '0') + i.toString(16).padStart(36, '0'));
const pct = (xs: number[], q: number) => { const a = xs.slice().sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : 0; };
const f1 = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
const big = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() + 'n' : v);

// ---- the world: ~850 pools in 150 pairs, real router addresses ---------------------------------
const registry = structuredClone(DEFAULT_ROUTER_REGISTRY);
seedKnownAddresses(registry);
const N_TOKENS = 70, N_PAIRS = 150;
const tokens = [ROBINHOOD_TOKENS.WETH, ROBINHOOD_TOKENS.USDG, ...Array.from({ length: N_TOKENS - 2 }, (_, i) => addr(i, 0x70c0))];
const dec: Record<string, number> = {};
tokens.forEach((t, i) => { dec[t.toLowerCase()] = i === 1 ? 6 : 18; });
const decimalsOf = (_c: string, t: string) => dec[t.toLowerCase()] ?? 18;

interface Pair { a: string; b: string; pools: PoolState[] }
function buildWorld(cache: PoolCache): Pair[] {
  seed = 777;
  const pairs: Pair[] = [];
  let nPool = 0;
  for (let p = 0; p < N_PAIRS; p++) {
    const a = tokens[p < 70 ? 0 : p < 110 ? 1 : 2 + ((p * 7) % (N_TOKENS - 2))];
    let b = tokens[2 + (p % (N_TOKENS - 2))];
    if (b === a) b = tokens[3];
    const [t0, t1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
    const pools: PoolState[] = [];
    const n = 3 + ri(7);
    for (let k = 0; k < n; k++) {
      const base: PoolState = { chain: 'robinhood', dex: '', poolAddress: addr(nPool++, 0x9001), poolType: 'v2', tokenA: t0, tokenB: t1, feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: Date.now() };
      // Prices of the same pair differ by up to ~1.5% between pools: some gaps are worth planning.
      const px = 1 + (rnd() - 0.5) * 0.03;
      const depth = 10n ** BigInt(20 + ri(4));
      const d0 = dec[t0.toLowerCase()], d1 = dec[t1.toLowerCase()];
      const scale = 10 ** (d1 - d0);
      const kind = k % 5;
      if (kind === 0) pools.push({ ...base, dex: 'uniswap-v2', reserveA: depth, reserveB: BigInt(Math.floor(Number(depth) * px * scale)) });
      else if (kind === 3) pools.push({ ...base, dex: 'pancakeswap-v2', feeBps: 25, reserveA: depth, reserveB: BigInt(Math.floor(Number(depth) * px * scale)) });
      else {
        const fee = [100, 500, 3000, 10000][k % 4];
        const sq = Math.sqrt(px * scale);
        const v3: PoolState = { ...base, dex: kind === 1 ? 'uniswap-v3' : 'pancakeswap-v3', poolType: 'v3', feeBps: fee / 100, feePips: fee, sqrtPriceX96: BigInt(Math.floor(sq * 2 ** 40)) * (1n << 56n), liquidity: depth / BigInt(Math.max(1, Math.floor(Math.sqrt(scale)))) };
        if (kind === 4) {
          // Uniswap V4 pool: its "address" is the pool id (hookless, standard tier).
          const ts = ({ 100: 1, 500: 10, 3000: 60, 10000: 200 } as Record<number, number>)[fee];
          pools.push({ ...v3, dex: 'uniswap-v4', poolAddress: v4PoolIdOf(t0, t1, fee, ts, ethers.ZeroAddress), v4: { fee, tickSpacing: ts, native: false, poolManager: ROBINHOOD_V4.POOL_MANAGER, stateView: ROBINHOOD_V4.STATE_VIEW } });
          nPool--; // (the id replaces the made-up address)
        } else pools.push(v3);
      }
    }
    for (const x of pools) cache.upsert(x);
    pairs.push({ a, b, pools });
  }
  return pairs;
}

// ---- realistic feed transactions on watched pools (real router calldata) -------------------------
const iUR = new ethers.Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline)']);
const iV2 = new ethers.Interface(['function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)']);
const iSR = new ethers.Interface([
  'function multicall(uint256 deadline, bytes[] data)', 'function multicall(bytes[] data)',
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96))',
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum))',
]);
const coder = ethers.AbiCoder.defaultAbiCoder();
const ME = addr(1, 0x1111);
function swapTx(pairs: Pair[], i: number): { to: string; data: string; value: bigint } {
  const pr = pairs[ri(pairs.length)];
  const p = pr.pools[ri(pr.pools.length)];
  const inA = rnd() < 0.5;
  const tin = inA ? p.tokenA : p.tokenB, tout = inA ? p.tokenB : p.tokenA;
  const amt = 10n ** BigInt(dec[tin.toLowerCase()]) * BigInt(5 + ri(400));
  const r = rnd();
  if (p.poolType === 'v2') {
    const router = p.dex === 'pancakeswap-v2' ? ROBINHOOD_PANCAKE.V2_ROUTER : ROBINHOOD_V2.ROUTER;
    return { to: router, data: iV2.encodeFunctionData('swapExactTokensForTokens', [amt, 0, [tin, tout], ME, 9_999_999_999n]), value: 0n };
  }
  if (p.v4) {
    // Universal Router V4_SWAP: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL (the usual wallet shape).
    const key = [p.tokenA, p.tokenB, p.v4.fee, p.v4.tickSpacing, ethers.ZeroAddress];
    const zeroForOne = tin === p.tokenA;
    const single = coder.encode([`tuple(tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`], [[key, zeroForOne, r < 0.3 ? 0n : amt, 0, '0x']]);
    const input = coder.encode(['bytes', 'bytes[]'], ['0x060c0f', [single, coder.encode(['address', 'uint256'], [tin, amt]), coder.encode(['address', 'uint256'], [tout, 0])]]);
    return { to: ROBINHOOD_V4.UNIVERSAL_ROUTER, data: iUR.encodeFunctionData('execute', ['0x10', [input], 9_999_999_999n]), value: 0n };
  }
  const path = ethers.solidityPacked(['address', 'uint24', 'address'], [tin, p.feePips, tout]);
  if (p.dex === 'uniswap-v3' && r < 0.5) {
    // Universal Router, V3_SWAP_EXACT_IN (+ a second command it leaves alone)
    return { to: ROBINHOOD_V4.UNIVERSAL_ROUTER, data: iUR.encodeFunctionData('execute', ['0x000c', [coder.encode(['address', 'uint256', 'uint256', 'bytes', 'bool'], [ME, amt, 0, path, true]), coder.encode(['address', 'uint256'], [ME, 0])], 9_999_999_999n]), value: 0n };
  }
  const router = p.dex === 'pancakeswap-v3' ? ROBINHOOD_PANCAKE.SMART_ROUTER : ROBINHOOD_V3.SWAP_ROUTER_02;
  const inner = i % 3 === 0
    ? iSR.encodeFunctionData('exactInput', [[path, ME, amt, 0]])
    : iSR.encodeFunctionData('exactInputSingle', [[tin, tout, p.feePips, ME, amt, 0, 0]]);
  return { to: router, data: i % 2 ? iSR.encodeFunctionData('multicall(uint256,bytes[])', [9_999_999_999n, [inner]]) : iSR.encodeFunctionData('multicall(bytes[])', [[inner]]), value: 0n };
}
function otherTx(i: number): { to: string; data: string; value: bigint } {
  const r = i % 4;
  if (r === 0) return { to: addr(i % 50, 0xe0e0), data: '0xa9059cbb' + '00'.repeat(64), value: 0n };      // coin transfer
  if (r === 1) return { to: addr(i % 50, 0xe1e1), data: '0x', value: 10n ** 15n };                         // ETH send
  if (r === 2) return { to: ROBINHOOD_V3.SWAP_ROUTER_02, data: '0x12345678' + 'ab'.repeat(68), value: 0n }; // router, unknown call
  return { to: addr(i % 50, 0xe2e2), data: '0x' + 'cd'.repeat(300), value: 0n };                          // some contract
}
// Frames: mostly 1-3 transactions, sometimes 5-15, now and then a busy 25-50.
// About 6 in 10 transactions are swaps on watched pools.
function makeFeed(pairs: Pair[], frames: number, s = 99): RawChainEvent[][] {
  seed = s;
  const out: RawChainEvent[][] = [];
  let n = 0;
  for (let f = 0; f < frames; f++) {
    const r = rnd();
    const size = r < 0.7 ? 1 + ri(3) : r < 0.9 ? 5 + ri(11) : 25 + ri(26);
    const evs: RawChainEvent[] = [];
    for (let k = 0; k < size; k++, n++) {
      const tx = rnd() < 0.6 ? swapTx(pairs, n) : otherTx(n);
      evs.push({ chain: 'robinhood', stateType: 'SEQUENCED', blockOrSeq: n, receivedAtMs: 0, raw: { ...tx, hash: ethers.id('tx' + n) } });
    }
    out.push(evs);
  }
  return out;
}

// ---- one feed trade, the same steps the bot runs (shadowMain.ts onFeedEvent) ---------------------
type Mode = 'old' | 'decide' | 'all' | 'inline';
interface Decision { hash: string; buy: string; sell: string; sizeUsd: number; netUsd: number; grossUsd: number; predicted: boolean }
interface Ctx {
  cache: PoolCache; decoder: TransactionDecoder; filter: FastFilter; oracle: PriceOracle; turns: TurnQueue;
  decisions: Decision[]; steps: Record<string, number>; mode: Mode;
  usdOf: (token: string) => number | null;   // the bot's priceOracle.getUsdPrice
}
// frozenUsd: dollar prices held fixed for the whole replay (taken from the
// oracle at the start), to show the turns change nothing else.
function makeCtx(mode: Mode, clock: () => number, frozenUsd = false): { ctx: Ctx; pairs: Pair[] } {
  const cache = new PoolCache();
  const pairs = buildWorld(cache);
  const oracle = new PriceOracle(cache, (_c, t) => dec[t.toLowerCase()], 1_000, clock);
  const fixed = new Map<string, number | null>();
  if (frozenUsd) for (const t of tokens) fixed.set(t.toLowerCase(), oracle.getUsdPrice('robinhood', t));
  const ctx: Ctx = {
    cache, mode, decisions: [], steps: {}, turns: new TurnQueue(), oracle,
    decoder: new TransactionDecoder(registry, undefined, (c, a) => cache.get(c, a)),
    filter: new FastFilter(cache),
    usdOf: frozenUsd ? (t) => fixed.get(t.toLowerCase()) ?? null : (t) => oracle.getUsdPrice('robinhood', t),
  };
  return { ctx, pairs };
}
const lap = (ctx: Ctx, k: string, t0: number) => { const t = performance.now(); ctx.steps[k] = (ctx.steps[k] ?? 0) + t - t0; return t; };
// Fresh prices at decision time (the bot's pricesAtDecisionRobinhood when the
// cache is fresh: an async function that returns the same pools).
const pricesNow = async (traded: PoolState, peers: PoolState[]): Promise<[PoolState, PoolState[]]> => [traded, peers];
async function feedTrade(ctx: Ctx, event: RawChainEvent): Promise<void> {
  if (ctx.mode === 'all') await ctx.turns.turn();
  let t = performance.now();
  const decoding = ctx.decoder.decode(event); // all its work happens inside this call
  t = lap(ctx, 'decode', t);
  const swap = await decoding;
  t = performance.now();
  if (!swap) return;
  const cache = ctx.cache;
  let pool = cache.get('robinhood', swap.poolAddress);
  if (!pool) {
    const via = registry.robinhood[swap.poolAddress.toLowerCase()];
    const wantFeeBps = swap.feeTier !== undefined ? Math.round(swap.feeTier / 100) : undefined;
    pool = cache.findPeerPools('robinhood', swap.tokenIn, swap.tokenOut, '').find((p) => p.dex === (via?.dex ?? swap.dex) && (wantFeeBps === undefined || p.feeBps === wantFeeBps));
  }
  t = lap(ctx, 'pool lookup', t);
  if (!pool) return;
  if (swap.amountIn > 0n) {
    const inIsA = pool.tokenA.toLowerCase() === swap.tokenIn.toLowerCase();
    const after = cache.predictPostTradeState(pool, inIsA, swap.amountIn);
    if (after !== pool) cache.upsertFromFeed(after, 0);
  }
  t = lap(ctx, 'instant price tracking', t);
  const fr = ctx.filter.evaluate({ ...swap, poolAddress: pool.poolAddress });
  t = lap(ctx, 'size filter', t);
  if (!fr.pass) return;
  const usdOf = ctx.usdOf;
  const peers0 = cache.findPeerPools('robinhood', swap.tokenIn, swap.tokenOut, pool.poolAddress).filter((p) => deepEnough(p, decimalsOf, usdOf));
  t = lap(ctx, 'partner pools + depth', t);
  if (!peers0.length) return;
  // 'inline': the decide part right after this, no wait at all (reference).
  const [freshPool, ...peers] = ctx.mode === 'inline' ? [pool, ...peers0] : await pricesNow(pool, peers0).then(([x, ps]) => [x, ...ps]);
  // Start coin: the held one (USDG / WETH) when the pair has it (shadowMain TRIGGER_START_HELD).
  const held = new Set([ROBINHOOD_TOKENS.USDG.toLowerCase(), ROBINHOOD_TOKENS.WETH.toLowerCase()]);
  const flip = !held.has(swap.tokenIn.toLowerCase()) && held.has(swap.tokenOut.toLowerCase());
  const planIn = flip ? swap.tokenOut : swap.tokenIn;
  // FEED_TRADE_DEFER: the start coin's price is read before the turn.
  let usdAtTurn: number | null | undefined;
  if (ctx.mode === 'decide' || ctx.mode === 'all') { usdAtTurn = ctx.usdOf(planIn); await ctx.turns.turn(); }
  else if (ctx.mode === 'inline') usdAtTurn = ctx.usdOf(planIn);
  t = performance.now();
  // ---- the decide part ----
  pool = freshPool;
  const mb = priceOf(pool, swap.tokenIn, decimalsOf);
  let best = -Infinity;
  for (const pe of peers) { const pp = priceOf(pe, swap.tokenIn, decimalsOf); if (pp !== null && mb !== null) best = Math.max(best, spreadPct(mb, pp)); }
  t = lap(ctx, 'decide: match prices', t);
  const usd = usdAtTurn !== undefined ? usdAtTurn : ctx.usdOf(planIn);
  if (usd === null) return;
  let plan: ReturnType<typeof planBackrun> = null;
  for (const pe of peers) {
    const c = planBackrun(cache, pool, pe, swap as DecodedSwap, usd, { gasPriceUsd: 0.05, dexFeeBps: { buy: pool.feeBps, sell: pe.feeBps }, flashLoanFeeBps: 1, usingFlashLoan: true, safetyMarginPct: 0.15 },
      decimalsOf('robinhood', planIn), { refineSize: true, maxTradeUsd: 2_000, ...(flip ? { startToken: planIn } : {}) });
    if (c && (!plan || c.profit.conservativeNetProfitUsd > plan.profit.conservativeNetProfitUsd)) plan = c;
  }
  t = lap(ctx, 'decide: plan vs every partner', t);
  if (!plan) return;
  ctx.decisions.push({
    hash: (event.raw as { hash: string }).hash, buy: plan.buyPool.poolAddress, sell: plan.sellPool.poolAddress,
    sizeUsd: plan.sizing.optimalTradeSizeUsd, netUsd: plan.profit.conservativeNetProfitUsd, grossUsd: plan.sizing.grossProfitUsd, predicted: plan.usedPrediction,
  });
  lap(ctx, 'decide: record', t);
}
// One feed message: every transaction handed on in order, like the
// adapter's handler loop (the bot never waits on a trade's promise).
function onFrame(ctx: Ctx, evs: RawChainEvent[], pending: Promise<void>[]): void {
  for (const ev of evs) pending.push(feedTrade(ctx, ev).catch((e) => { console.error(e); }));
}
const cacheSnapshot = (c: PoolCache) => JSON.stringify(c.allForChain('robinhood').map((p) => [p.poolAddress, p.reserveA, p.reserveB, p.sqrtPriceX96, p.liquidity]), big);

// Replay a feed: frames back to back (each one after the previous had its
// turn on the event loop), logical clock for the price oracle so only the
// scheduling differs between modes.
// pace: 'next' = next message after one event-loop pass (turns still
// waiting: later messages are handled in between), 'all' = every message at
// once (the most mixing possible), 'idle' = each message only after the
// previous one's trades are completely done (no mixing at all).
async function replay(mode: Mode, frames: number, opts: { frozenUsd?: boolean; pace?: 'next' | 'all' | 'idle' } = {}): Promise<Ctx> {
  let now = 1_000_000;
  const { ctx, pairs } = makeCtx(mode, () => now, opts.frozenUsd);
  const feed = makeFeed(pairs, frames);
  const pending: Promise<void>[] = [];
  for (const evs of feed) {
    onFrame(ctx, evs, pending);
    now += 25;
    if (opts.pace === 'idle') await Promise.all(pending);
    else if (opts.pace !== 'all') await new Promise<void>((r) => setImmediate(r));
  }
  await Promise.all(pending);
  return ctx;
}

// Memory made per swap read (KB), measured in a child process with a big
// young generation and --expose-gc so no clean-up runs mid-measurement.
function allocChild(): void {
  const gc = (globalThis as unknown as { gc: () => void }).gc;
  const cache = new PoolCache();
  const pairs = buildWorld(cache);
  const decoder = new TransactionDecoder(registry, undefined, (c, a) => cache.get(c, a));
  const evs = makeFeed(pairs, 300, 11).flat();
  const res: Record<string, number> = {};
  for (const on of [false, true, false, true]) {
    setFastParse(on); setFastAbi(on);
    for (const e of evs) void decoder.decode(e); // warm up
    gc(); gc();
    const a = getHeapStatistics().used_heap_size;
    let n = 0;
    for (const e of evs) { void decoder.decode(e); n++; }
    const b = getHeapStatistics().used_heap_size;
    res[on ? 'fast' : 'old'] = (b - a) / n / 1024;
  }
  console.log('ALLOC ' + JSON.stringify(res));
}

async function main() {
  if (process.env.FT_CHILD === 'alloc') { allocChild(); return; }
  // Live default (config/envDefaults.ts): the fuller Router V4 trade reader is on.
  process.env.FEED_DECODE_UR_V4 = process.env.FEED_DECODE_UR_V4 ?? '1';
  // ==== 1. TURN QUEUE =======================================================
  {
    const q = new TurnQueue();
    const order: number[] = [];
    const jobs = Array.from({ length: 200 }, (_, i) => (async () => { await q.turn(); order.push(i); })());
    // A timer that falls due while turns are queued runs between turns (one
    // turn per event-loop pass), not after all of them.
    let timerAt = -1;
    setTimeout(() => { timerAt = order.length; }, 0);
    await Promise.all(jobs);
    assert(order.every((v, i) => v === i), 'turn queue: turns are given in the order they were asked for (200 callers)');
    assert(order.length === 200 && q.size() === 0, 'turn queue: nothing dropped, nothing left waiting');
    assert(timerAt >= 0 && timerAt < 200, `turn queue: a timer due meanwhile ran between turns (after turn ${timerAt} of 200), not after all of them`);
    const st = q.take();
    assert(st.n === 200 && st.maxDepth === 200 && st.max >= st.p90 && st.p90 >= st.p50, `turn queue numbers: ${st.n} turns, longest line ${st.maxDepth}, wait p50 ${st.p50} / p90 ${st.p90} / max ${st.max} ms`);
    assert(q.take().n === 0, 'turn queue numbers reset after take()');
    // A trade's own code after its turn (incl. quick follow-up steps) runs before the next trade's turn.
    const q2 = new TurnQueue();
    const log: string[] = [];
    await Promise.all([0, 1, 2].map(async (i) => { await q2.turn(); log.push(`start ${i}`); await Promise.resolve(); await Promise.resolve(); log.push(`end ${i}`); }));
    assert(log.join(',') === 'start 0,end 0,start 1,end 1,start 2,end 2', 'turn queue: each trade\'s decide part runs whole before the next one starts');
    // A network reply that arrives while turns are queued is read between turns.
    const s = (await import('net')).createServer((c) => c.on('data', (d) => c.write(d)));
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const c = connect((s.address() as { port: number }).port, '127.0.0.1');
    await new Promise<void>((r) => c.once('connect', () => r()));
    const q3 = new TurnQueue();
    let done = 0, readAt = -1;
    c.once('data', () => { readAt = done; });
    c.write('x');
    const spin = (ms: number) => { const t = performance.now(); while (performance.now() - t < ms) { /* busy */ } };
    await Promise.all(Array.from({ length: 300 }, () => (async () => { await q3.turn(); spin(0.2); done++; })()));
    await new Promise((r) => setTimeout(r, 20));
    c.destroy(); s.close();
    assert(readAt >= 0 && readAt < 300, `turn queue: a socket reply was read between turns (after ${readAt} of 300 turns of 0.2 ms), not after all of them`);
  }

  // ==== 2. FAST CALL READER = ethers ============================================
  {
    const ifaces = routerInterfaces();
    let compared = 0, same = 0, bothNull = 0, bothThrow = 0;
    // A value ethers could not read is kept as an error inside the result and
    // only throws when used: compared as its error text.
    const safe = (f: () => unknown): unknown => { try { return norm(f()); } catch (e) { return `ERR ${(e as Error).message?.slice(0, 120)}`; } };
    const norm = (x: unknown): unknown => (x instanceof ethers.Result ? Array.from({ length: x.length }, (_, i) => safe(() => x[i])) : typeof x === 'bigint' ? `${x}n` : x);
    const named = (args: ethers.Result, fn: ethers.FunctionFragment) => fn.inputs.map((p) => (p.name ? safe(() => args.getValue(p.name)) : null));
    const check = (iface: ethers.Interface, data: string) => {
      compared++;
      let a: { name: string; args: ethers.Result } | null | 'throw', b: ethers.TransactionDescription | null | 'throw';
      try { a = fastParseCall(iface, data); } catch { a = 'throw'; }
      try { b = iface.parseTransaction({ data }); } catch { b = 'throw'; }
      if (a === 'throw' || b === 'throw') { if (a === b) { bothThrow++; same++; } else console.error('mismatch (throw)', data.slice(0, 80), a === 'throw', b === 'throw'); return; }
      if (a === null || b === null) { if (a === b) { bothNull++; same++; } else console.error('mismatch (null)', data.slice(0, 80)); return; }
      const ok = a.name === b.name && JSON.stringify(norm(a.args)) === JSON.stringify(norm(b.args)) && JSON.stringify(named(a.args, b.fragment)) === JSON.stringify(named(b.args, b.fragment));
      if (ok) same++; else console.error('mismatch (value)', b.name, data.slice(0, 80));
    };
    seed = 4242;
    const randVal = (t: ethers.ParamType): unknown => {
      if (t.baseType === 'array') return Array.from({ length: ri(4) }, () => randVal(t.arrayChildren!));
      if (t.baseType === 'tuple') return t.components!.map(randVal);
      if (t.type === 'address') return addr(ri(1e6), 0x4444);
      if (t.type === 'bool') return rnd() < 0.5;
      if (t.type === 'bytes') return '0x' + 'ab'.repeat(ri(90));
      if (t.type.startsWith('bytes')) return '0x' + 'cd'.repeat(Number(t.type.slice(5)));
      if (t.type.startsWith('uint')) { const bits = Number(t.type.slice(4) || 256); return BigInt(ri(2 ** 30)) % (1n << BigInt(bits)); }
      if (t.type.startsWith('int')) return BigInt(ri(2 ** 20)) - 500_000n;
      return 0;
    };
    for (const [, iface] of Object.entries(ifaces)) {
      for (const f of iface.fragments) {
        if (f.type !== 'function') continue;
        const fn = f as ethers.FunctionFragment;
        for (let k = 0; k < 120; k++) {
          const data = iface.encodeFunctionData(fn, fn.inputs.map(randVal));
          check(iface, data);
          // Broken versions: cut short, one byte changed in the arguments, junk after.
          check(iface, data.slice(0, 10 + 2 * ri(Math.max(1, (data.length - 10) / 2))));
          const pos = 10 + 2 * ri(Math.max(1, (data.length - 10) / 2));
          check(iface, data.slice(0, pos) + (data.slice(pos, pos + 2) === 'ff' ? '00' : 'ff') + data.slice(pos + 2));
          check(iface, data + 'deadbeef');
          check(iface, data.toUpperCase().replace('0X', '0x'));
        }
      }
      for (const junk of ['0x', '0x12', '0x123456', '0x12345678', 'zz', '0xzz12345678', '0x1234567', '0xa9059cbb' + '00'.repeat(64), '0x' + 'cd'.repeat(300)]) check(iface, junk);
    }
    assert(same === compared, `fast call reader = ethers parseTransaction on ${compared} calls (${bothNull} unknown, ${bothThrow} unreadable, the rest same function + same arguments, by position and by name)`);

    // The fast ABI reader = ethers' AbiCoder.decode, on random layouts
    // (nested tuples, lists, bytes, every number size), random values, and
    // broken / changed / random data: it either gives ethers' exact answer
    // (values, names, errors stored inside) or says "not sure".
    {
      seed = 9090;
      const elem = () => ['address', 'bool', 'bytes', 'bytes32', 'bytes4', 'uint8', 'uint24', 'uint128', 'uint160', 'uint256', 'int24', 'int256', 'int128'][ri(13)];
      const typeOf = (d: number): string => {
        const r = rnd();
        if (d < 3 && r < 0.2) return `tuple(${Array.from({ length: 1 + ri(4) }, (_, i) => `${typeOf(d + 1)} f${i}`).join(',')})`;
        if (d < 3 && r < 0.3) return `${typeOf(d + 1)}[]`;
        if (d < 3 && r < 0.35) return `${typeOf(d + 1)}[${1 + ri(3)}]`;
        return elem();
      };
      const valOf = (t: ethers.ParamType): unknown => {
        if (t.baseType === 'tuple') return t.components!.map(valOf);
        if (t.baseType === 'array') return Array.from({ length: t.arrayLength >= 0 ? t.arrayLength : ri(4) }, () => valOf(t.arrayChildren!));
        if (t.type === 'address') return addr(ri(1e6), 0x5555);
        if (t.type === 'bool') return rnd() < 0.5;
        if (t.type === 'bytes') return '0x' + Array.from({ length: ri(70) }, () => ri(256).toString(16).padStart(2, '0')).join('');
        if (t.type.startsWith('bytes')) return '0x' + 'ef'.repeat(Number(t.type.slice(5)));
        const bits = Number(t.type.replace(/^u?int/, '') || 256);
        if (t.type.startsWith('uint')) return (BigInt(ri(2 ** 30)) * BigInt(ri(2 ** 30)) + BigInt(ri(1000))) % (1n << BigInt(bits));
        const lim = 1n << BigInt(bits - 1);
        return ((BigInt(ri(2 ** 30)) * BigInt(ri(2 ** 20))) % lim) * (rnd() < 0.5 ? -1n : 1n);
      };
      const deep = (x: unknown): unknown => {
        if (x instanceof ethers.Result) {
          const items = Array.from({ length: x.length }, (_, i) => { try { return deep(x[i]); } catch (e) { return `ERR ${(e as Error).message?.slice(0, 80)}`; } });
          let named: unknown = null;
          try { named = x.toObject(false); named = Object.keys(named as object); } catch { named = 'unnamed'; }
          return { items, named };
        }
        return typeof x === 'bigint' ? `${x}n` : x;
      };
      let n = 0, lite = 0, unsure = 0, bad = 0;
      const cmp = (types: string[], data: string) => {
        n++;
        const l = liteDecode(types, data);
        if (!l) { unsure++; return; }
        lite++;
        let e: ethers.Result | null = null;
        try { e = coder.decode(types, data); } catch { e = null; }
        if (!e || JSON.stringify(deep(l)) !== JSON.stringify(deep(e))) { bad++; if (bad < 4) console.error('lite mismatch', types.join(','), data.slice(0, 120)); }
      };
      for (let k = 0; k < 1500; k++) {
        const types = Array.from({ length: 1 + ri(4) }, () => typeOf(0));
        const pts = types.map((t) => ethers.ParamType.from(t));
        const data = coder.encode(types, pts.map(valOf));
        cmp(types, data);
        // changed / broken versions
        const body = data.slice(2);
        const at = 2 * ri(Math.max(1, body.length / 2));
        cmp(types, '0x' + body.slice(0, at) + ri(256).toString(16).padStart(2, '0') + body.slice(at + 2));
        cmp(types, '0x' + body.slice(0, 64 * ri(Math.max(1, body.length / 64))));
        cmp(types, data + '00'.repeat(32));
        const w = 64 * ri(Math.max(1, body.length / 64));
        cmp(types, '0x' + body.slice(0, w) + (rnd() < 0.5 ? 'f'.repeat(64) : ri(1e6).toString(16).padStart(64, '0')) + body.slice(w + 64));
      }
      // Hostile: pointers that point back (data read twice) must not be read by the fast reader.
      cmp(['bytes', 'bytes'], '0x' + (64).toString(16).padStart(64, '0') + (64).toString(16).padStart(64, '0') + (2).toString(16).padStart(64, '0') + 'abcd'.padEnd(64, '0'));
      assert(bad === 0, `fast ABI reader = ethers AbiCoder.decode whenever it answers (${n} inputs: ${lite} read fast and identical, ${unsure} left to ethers)`);
      assert(lite > 1500 && unsure > 1000, 'fast ABI reader: reads every normal layout, leaves broken / odd data to ethers');
      const a = addr(77, 0x6666).toLowerCase();
      assert(checksumAddress(a) === ethers.getAddress(a) && checksumAddress(a) === checksumAddress(a), 'remembered address checksum = ethers.getAddress');
    }

    // The fast encoder = ethers' encodeFunctionData / encode, on good and bad values.
    {
      seed = 5151;
      const ifs = [
        new ethers.Interface(['function getPair(address,address) view returns (address)']),
        new ethers.Interface(['function getPair(address,address,bool) view returns (address)']),
        new ethers.Interface(['function getPool(address,address,uint24) view returns (address)']),
        new ethers.Interface(['function getPool(address,address,int24) view returns (address)']),
        new ethers.Interface(['function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)', 'function getLiquidity(bytes32) view returns (uint128)', 'function symbol() view returns (string)']),
        new ethers.Interface(['function f(uint8 a, int8 b, uint256 c, int256 d, bytes4 e, bool g)']),
        new ethers.Interface(['function over(address)', 'function over(uint256)', 'function str(string)']),
      ];
      const good = addr(ri(1e6), 0x7777);
      const anyVal = (t: ethers.ParamType): unknown => {
        const r = rnd();
        if (t.type === 'address') return r < 0.5 ? good : r < 0.6 ? good.toLowerCase() : r < 0.7 ? good.toUpperCase().replace('0X', '0x') : r < 0.8 ? good.slice(0, 2) + good.slice(2, 4).toLowerCase() + good.slice(4, 6).toUpperCase() + good.slice(6) : r < 0.9 ? 'x' + good : 12345;
        if (t.type === 'bool') return r < 0.8 ? r < 0.4 : 1;
        if (t.type === 'string') return 'hello';
        if (t.type.startsWith('bytes')) { const n = Number(t.type.slice(5)); return r < 0.7 ? '0x' + 'aB'.repeat(n) : r < 0.85 ? '0x' + 'ab'.repeat(n + 1) : 'zz'; }
        const signed = t.type.startsWith('int');
        const bits = Number(t.type.replace(/^u?int/, '') || 256);
        const lim = 1n << BigInt(signed ? bits - 1 : bits);
        if (r < 0.3) return Number(BigInt(ri(1e9)) % lim) * (signed && rnd() < 0.5 ? -1 : 1);
        if (r < 0.6) return (BigInt(ri(2 ** 30)) * BigInt(ri(2 ** 30))) % lim * (signed && rnd() < 0.5 ? -1n : 1n);
        if (r < 0.7) return signed ? -lim - 1n : -1n;   // out of range
        if (r < 0.8) return lim;                         // out of range
        if (r < 0.9) return 1.5;                         // not whole
        return '77';                                     // text number (ethers converts)
      };
      let n = 0, same = 0;
      const both = (fast: () => string, slow: () => string) => {
        n++;
        let a: string, b: string;
        try { a = fast(); } catch (e) { a = `throws ${(e as Error).message?.slice(0, 50)}`; }
        try { b = slow(); } catch (e) { b = `throws ${(e as Error).message?.slice(0, 50)}`; }
        if (a === b) same++; else if (n - same < 4) console.error('encode mismatch', a.slice(0, 90), b.slice(0, 90));
      };
      for (let k = 0; k < 3000; k++) {
        const iface = ifs[ri(ifs.length)];
        const fns = iface.fragments.filter((f) => f.type === 'function') as ethers.FunctionFragment[];
        const fn = fns[ri(fns.length)];
        const name = rnd() < 0.85 ? fn.name : 'nope';
        const vals = fn.inputs.map(anyVal);
        if (rnd() < 0.05) vals.push(1);
        both(() => encodeCallFast(iface, name, vals), () => iface.encodeFunctionData(name, vals));
        const types = fn.inputs.map((p) => p.type);
        both(() => abiEncodeFast(types, vals), () => coder.encode(types, vals));
      }
      assert(same === n, `fast encoder = ethers encodeFunctionData / encode on ${n} calls (good values, bad checksums, out-of-range and odd values, unknown names)`);

      // A whole pair lookup (every exchange x every fee level): same ~200 questions both ways.
      const venues: Venue[] = [
        { dex: 'uniswap-v2', kind: 'v2', factory: ROBINHOOD_V2.FACTORY, feeBps: 30 },
        { dex: 'pancakeswap-v2', kind: 'v2', factory: ROBINHOOD_PANCAKE.V2_FACTORY, feeBps: 25 },
        { dex: 'uniswap-v3', kind: 'v3-fee', factory: ROBINHOOD_V3.FACTORY },
        { dex: 'pancakeswap-v3', kind: 'v3-fee', factory: ROBINHOOD_PANCAKE.V3_FACTORY },
        { dex: 'ramses-v2', kind: 'solidly', factory: ROBINHOOD_RAMSES.V2_FACTORY, feeBps: 20 },
        { dex: 'ramses-v3', kind: 'v3-spacing', factory: ROBINHOOD_RAMSES.V3_FACTORY },
        { dex: 'uniswap-v4', kind: 'v4', factory: ROBINHOOD_V4.STATE_VIEW, poolManager: ROBINHOOD_V4.POOL_MANAGER, weth: ROBINHOOD_TOKENS.WETH },
        ...(extraWatcherVenues({ stateView: ROBINHOOD_V4.STATE_VIEW, poolManager: ROBINHOOD_V4.POOL_MANAGER, weth: ROBINHOOD_TOKENS.WETH }) as Venue[]),
      ];
      const ask = async (on: boolean, tok: string) => {
        setFastAbi(on);
        let calls: { target: string; data: string }[] = [];
        const t0 = performance.now();
        const p = discoverPairPoolsMulticall(async (c) => { calls = c; throw new Error('stop here'); }, 'robinhood', venues, ROBINHOOD_TOKENS.WETH, tok, [tok]);
        const ms = performance.now() - t0;   // the part that runs at once
        await p.catch(() => undefined);
        return { j: JSON.stringify(calls), n: calls.length, ms };
      };
      let ok = true, msOld = 0, msNew = 0, nCalls = 0;
      for (let k = 0; k < 20; k++) {
        const tok = addr(900 + k, 0x8888);
        // Fast first (a new pair: nothing remembered yet), then the old way
        // (its pool ids are then remembered: its time is, if anything, too low).
        const f = await ask(true, tok), o = await ask(false, tok);
        if (o.j !== f.j) ok = false;
        if (k >= 5) { msOld += o.ms; msNew += f.ms; }
        nCalls = f.n;
      }
      setFastAbi(true);
      assert(ok && nCalls > 150, `pair lookup: the same ${nCalls} questions with the fast encoder on and off (20 new pairs)`);
      console.log(`[bench] building one new pair's lookup, TEST numbers: ethers ${f1(msOld / 15)}+ ms -> fast ${f1(msNew / 15)} ms (was inside the feed trade that noticed the pair; now on the next loop pass, named "pair discovery")`);
    }

    // The decoder's swaps, fast reader on vs off, on a realistic feed.
    const cache = new PoolCache();
    const pairs = buildWorld(cache);
    const decoder = new TransactionDecoder(registry, undefined, (ch, a) => cache.get(ch, a));
    const evs = makeFeed(pairs, 600, 5).flat();
    const run = async (on: boolean) => { setFastParse(on); setFastAbi(on); const out: string[] = []; const t0 = performance.now(); for (const e of evs) out.push(JSON.stringify(await decoder.decode(e), big)); return { out, ms: performance.now() - t0 }; };
    await run(true); await run(false); // warm up
    const slow = await run(false), fast = await run(true);
    const swaps = fast.out.filter((x) => x !== 'null').length;
    const v4n = fast.out.filter((x) => x.includes('"uniswap-v4"')).length;
    assert(fast.out.every((x, i) => x === slow.out[i]) && swaps > evs.length / 2 && v4n > 100, `decoder: identical swaps with the fast readers on and off (${evs.length} feed transactions, ${swaps} swaps, ${v4n} of them Uniswap V4)`);
    console.log(`[bench] decode, TEST numbers: ethers (old) ${f1(1000 * slow.ms / swaps)} us per swap -> fast readers ${f1(1000 * fast.ms / swaps)} us per swap (${f1(slow.ms / fast.ms)}x)`);
    // Broken / changed versions of the same feed: same answer (or same "not a swap") both ways.
    seed = 1234;
    const broken = evs.slice(0, 1500).map((e) => { const r = e.raw as { to: string; data: string; value: bigint; hash: string }; const d = r.data.slice(2); const at = 2 * ri(Math.max(1, d.length / 2)); const data = rnd() < 0.5 ? '0x' + d.slice(0, at) : '0x' + d.slice(0, at) + 'ff' + d.slice(at + 2); return { ...e, raw: { ...r, data } }; });
    const runB = async (on: boolean) => { setFastParse(on); setFastAbi(on); const out: string[] = []; for (const e of broken) { try { out.push(JSON.stringify(await decoder.decode(e), big)); } catch (x) { out.push(`throws ${(x as Error).message?.slice(0, 60)}`); } } return out; };
    const bOld = await runB(false), bNew = await runB(true);
    assert(bOld.every((x, i) => x === bNew[i]), `decoder on broken / changed calldata: identical answers both ways (${broken.length} transactions, ${bNew.filter((x) => x !== 'null' && !x.startsWith('throws')).length} still read as swaps)`);
    setFastParse(true); setFastAbi(true);
    // Memory made per feed transaction read (less memory = fewer / shorter clean-ups, "GC").
    const r = spawnSync(process.execPath, ['--expose-gc', '--min-semi-space-size=256', '--max-semi-space-size=256', __filename], { env: { ...process.env, FT_CHILD: 'alloc' }, encoding: 'utf8', timeout: 120_000 });
    const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('ALLOC '));
    if (!line) console.log('[memory] child measurement not available on this machine (skipped)', r.stderr?.slice(0, 200));
    else {
      const m = JSON.parse(line.slice(6)) as Record<string, number>;
      console.log(`[memory, TEST numbers] per feed transaction read by the decoder: ethers ${f1(m.old)} KB -> fast readers ${f1(m.fast)} KB`);
      assert(m.fast < m.old / 3, 'reading feed transactions makes far less throw-away memory');
    }
  }

  // ==== 3. DECISIONS: identical with the decide part at once or in turns ===========
  {
    const FR = 300;
    const j = (c: Ctx) => JSON.stringify(c.decisions);
    const txs = makeFeed(makeCtx('old', () => 0).pairs, FR).flat().length;
    // (a) Coin dollar prices held fixed: the turns change NOTHING (plans, order, cache).
    const oldF = await replay('old', FR, { frozenUsd: true });
    const decF = await replay('decide', FR, { frozenUsd: true });
    const allF = await replay('all', FR, { frozenUsd: true });
    const decFall = await replay('decide', FR, { frozenUsd: true, pace: 'all' });
    assert(oldF.decisions.length > 50, `replay: ${txs} feed transactions, ${oldF.decisions.length} back-run plans found (enough to compare)`);
    assert(j(decF) === j(oldF) && j(decFall) === j(oldF), 'FEED_TRADE_DEFER: same plans (pools, size, profit, prediction used), same order, as deciding at once (also with every message handled before any turn)');
    assert(cacheSnapshot(decF.cache) === cacheSnapshot(oldF.cache) && cacheSnapshot(decFall.cache) === cacheSnapshot(oldF.cache), 'FEED_TRADE_DEFER: same pool cache at the end (instant price tracking unchanged)');
    assert(j(allF) === j(oldF) && cacheSnapshot(allF.cache) === cacheSnapshot(oldF.cache), 'whole trade in turns (studied, not used): also the same plans and cache');
    // (b) Live coin prices (they move with the cache): what the decide part
    // plans with is fixed before its turn, so it decides exactly what it
    // would decide with no wait at all, however much else happens meanwhile.
    const inl = await replay('inline', FR);
    const decN = await replay('decide', FR);
    const decA = await replay('decide', FR, { pace: 'all' });
    const decI = await replay('decide', FR, { pace: 'idle' });
    // (With every message handed over at once, the test's clock reads the
    // same for all of them: compared with the no-wait run paced the same way.)
    const inlA = await replay('inline', FR, { pace: 'all' });
    assert(j(decN) === j(inl) && j(decI) === j(inl) && j(decA) === j(inlA) && decA.decisions.length === inl.decisions.length, 'FEED_TRADE_DEFER with live coin prices: the same plans as deciding with no wait at all, however the messages are mixed (next / all at once / one by one)');
    // (c) For the record: the old order read the start coin's price a moment
    // later (after the rest of the message's trades updated the cache).
    const oldN = await replay('old', FR);
    const byHash = new Map(oldN.decisions.map((d) => [d.hash, d]));
    let diff = 0, maxRel = 0;
    for (const d of decN.decisions) { const o = byHash.get(d.hash); if (!o || o.buy !== d.buy || o.sell !== d.sell || o.sizeUsd !== d.sizeUsd || o.netUsd !== d.netUsd) { diff++; if (o) maxRel = Math.max(maxRel, Math.abs(o.netUsd - d.netUsd) / Math.max(1e-9, Math.abs(o.netUsd))); } }
    console.log(`[bench] live coin prices: ${diff} of ${decN.decisions.length} plans differ from the old order (start coin's price read before the turn instead of after the message's other trades; biggest profit difference ${f1(100 * maxRel)}%), same pools in ${decN.decisions.filter((d) => { const o = byHash.get(d.hash); return o && o.buy === d.buy && o.sell === d.sell; }).length}`);
    // Per-step cost of one feed trade.
    const s = oldN.steps;
    const plans = oldN.decisions.length;
    console.log(`[bench] per-step cost of a feed trade, TEST numbers (${txs} feed txs; total / per feed tx / per planned swap):`);
    for (const [k, v] of Object.entries(s)) console.log(`[bench]   ${k.padEnd(30)} ${f1(v).padStart(7)} ms  ${f1(1000 * v / txs).padStart(6)} us/tx  ${f1(1000 * v / plans).padStart(7)} us/plan`);
  }

  // ==== 4. LAG a sidecar answer sees, old vs turns =================================
  // A separate process answers every question at once; the bot side asks one
  // question per feed message (like a fire-first trigger) and notes how long
  // the answer waited to be read, plus the lag probe (hops.lag / lagA).
  const sidecar: ChildProcess = spawn(process.execPath, ['-e', `
    const s = require('net').createServer((c) => { c.setNoDelay(true); c.on('data', (d) => c.write(d)); });
    s.listen(0, '127.0.0.1', () => process.stdout.write(String(s.address().port) + '\\n'));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((res) => sidecar.stdout!.once('data', (d) => res(Number(String(d).trim()))));
  const sock: Socket = await new Promise((res) => { const c = connect(port, '127.0.0.1', () => res(c)); c.setNoDelay(true); });
  type Cfg = { key: string; label: string; mode: Mode; fast: boolean };
  const cfgs: Cfg[] = [
    { key: 'before', label: 'BEFORE (ethers decode, decide part at once)', mode: 'old', fast: false },
    { key: 'fastOnly', label: 'fast decode only (decide part at once)', mode: 'old', fast: true },
    { key: 'after', label: 'AFTER (fast decode + decide part in turns)', mode: 'decide', fast: true },
  ];
  const results: Record<string, { ans: number[]; lagA: number[]; probe: { p50: number; p90: number; max: number } }> = {};
  for (const cfg of cfgs) {
    setFastParse(cfg.fast); setFastAbi(cfg.fast);
    const { ctx, pairs } = makeCtx(cfg.mode, Date.now);
    const feed = makeFeed(pairs, 500, 31);
    // warm up (JIT) on another feed
    { const p: Promise<void>[] = []; for (const evs of makeFeed(pairs, 150, 7)) onFrame(ctx, evs, p); await Promise.all(p); }
    const probe = new LagProbe(5, 200); probe.start();
    const ans: number[] = [], lagA: number[] = [];
    const sent = new Map<number, number>();
    let buf = '';
    sock.removeAllListeners('data');
    sock.on('data', (d) => { buf += d.toString(); let k: number; while ((k = buf.indexOf('\n')) >= 0) { const id = Number(buf.slice(0, k)); buf = buf.slice(k + 1); const t = sent.get(id); if (t !== undefined) { ans.push(performance.now() - t); lagA.push(probe.now()); } } });
    const pending: Promise<void>[] = [];
    let id = 0;
    let f = 0;
    while (f < feed.length) {
      // Now and then several messages arrive in one go (a backlog after a pause).
      const burst = f % 60 === 0 ? 4 : 1;
      for (let b = 0; b < burst && f < feed.length; b++, f++) {
        sent.set(++id, performance.now());
        sock.write(`${id}\n`);          // the trigger's question goes out first...
        onFrame(ctx, feed[f], pending);  // ...then the message's trades are handled
      }
      await new Promise((r) => setTimeout(r, 12)); // next message ~12 ms later
    }
    await Promise.all(pending);
    await new Promise((r) => setTimeout(r, 50));
    results[cfg.key] = { ans, lagA, probe: probe.takeHour() ?? { p50: 0, p90: 0, max: 0 } };
    probe.stop();
  }
  setFastParse(true); setFastAbi(true);
  sock.destroy(); sidecar.kill();
  const line = (r: typeof results.before) => `answer read after p50 ${f1(pct(r.ans, 0.5))} / p90 ${f1(pct(r.ans, 0.9))} / max ${f1(Math.max(...r.ans))} ms; lag at answer (lagA) p50 ${f1(pct(r.lagA, 0.5))} / p90 ${f1(pct(r.lagA, 0.9))} ms; lag probe p90 ${f1(r.probe.p90)} / max ${f1(r.probe.max)} ms`;
  for (const cfg of cfgs) console.log(`[bench] sidecar answer, TEST numbers, ${cfg.label}: ${line(results[cfg.key])}`);
  const b = results.before, a = results.after;
  assert(cfgs.every((c) => results[c.key].ans.length === b.ans.length) && b.ans.length > 450, `every question answered in every run (${a.ans.length})`);
  assert(pct(a.ans, 0.9) < pct(b.ans, 0.9) && Math.max(...a.ans) < Math.max(...b.ans) && pct(a.lagA, 0.9) < pct(b.lagA, 0.9), 'after: the sidecar answer is read sooner (p90 and worst case) and the lag at answer is lower');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
