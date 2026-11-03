import { exactHopOut, realisticHopOut, hopFeePips, hopWalks, LoopFinder, LoopEnv, maxLoopInput, inBandMaxIn } from '../core/loopFinder';
import { clAmountOut } from '../core/venueMath';
import { tickBook, loopTickMathOn } from '../core/tickWindow';
import { v4SwapFeePips, TickWindow } from '../core/tickMath';
import { MainLoopFeeder, LoopSource, LoopWorkerInit } from '../core/loopWorkerFeed';
import { LoopWorkerHost } from '../core/loopWorkerHost';
import { loopConfigFromEnv } from '../core/loopTrader';
import { loopFixFromEnv } from '../core/loopPrices';
import { loopNodeFromEnv } from '../core/loopNode';
import { PoolState } from '../core/types';
import { RECORDED, RecordedPool } from './stockTickMath.fixtures';

// ============================================================================
// LOOP FINDER, TICK-AWARE (Nov 2, LOOP_TICK_MATH, default on; =0 = old maths)
//
// The 2-pool guess was fixed in #278/#280 (walk the real price ranges, add
// the V4 protocol fee). The loop finder had its own maths: current price band
// only, LP fee only. This test checks, on the SAME recorded real chain state
// (block 104474563, stockTickMath.fixtures.ts):
//   1. each V3/V4 hop the loop finder prices = the chain's own quoter, to the
//      unit, and runs out of liquidity where the quoter refuses;
//   2. LOOP_TICK_MATH=0 gives exactly the old numbers;
//   3. a loop that only "pays" because the V4 protocol fee was ignored is no
//      longer reported (it was before);
//   4. the main thread's windows reach the loop worker thread;
//   5. speed of the exact loop check, before and after.
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// Run f with LOOP_TICK_MATH set to v (undefined = not set = on).
function withLoopFlag<T>(v: string | undefined, f: () => T): T {
  const old = process.env.LOOP_TICK_MATH;
  if (v === undefined) delete process.env.LOOP_TICK_MATH; else process.env.LOOP_TICK_MATH = v;
  try { return f(); } finally { if (old === undefined) delete process.env.LOOP_TICK_MATH; else process.env.LOOP_TICK_MATH = old; }
}
delete process.env.STOCK_TICK_MATH;

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const SNDK = '0x' + '22'.repeat(20);
const winOf = (r: RecordedPool): TickWindow => ({ lo: r.win.lo, hi: r.win.hi, tickSpacing: r.ts, ticks: r.win.ticks.map(([tick, n]) => ({ tick, liquidityNet: BigInt(n) })), block: 104474563, ms: 0 });
// Same pool states as stockTickMath.test.ts (but other ids, so the books don't mix).
const stateOf = (r: RecordedPool, id: string): PoolState => ({
  chain: 'robinhood', dex: r.dex, poolAddress: id, poolType: 'v3', tokenA: r.decA === 6 ? USDG : '0x' + '11'.repeat(20), tokenB: r.decB === 6 ? USDG : SNDK,
  sqrtPriceX96: BigInt(r.sqrtP), liquidity: BigInt(r.L), feeBps: r.lpFee / 100, lastUpdatedBlock: 104474563, lastUpdatedMs: Date.now(),
  ...(r.dex === 'uniswap-v4' ? { v4: { fee: r.lpFee, tickSpacing: r.ts, native: false, poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951', stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b' } } : {}),
});
const idFor = (r: RecordedPool) => (r.dex === 'uniswap-v4' ? r.k + '1f'.repeat(28) : r.k + '1f'.repeat(16));
for (const r of RECORDED) tickBook.put(idFor(r), winOf(r), r.protocolFee);
const R = (k: string) => RECORDED.find((x) => x.k === k)!;
// The loop finder's OLD hop maths (before this change): in-band, LP fee only.
const oldHop = (p: PoolState, z: boolean, amt: bigint) => clAmountOut(p.sqrtPriceX96!, p.liquidity!, amt, z, p.v4 ? p.v4.fee : Math.round(p.feeBps * 100)).amountOut;

assert(loopTickMathOn({}) && !loopTickMathOn({ LOOP_TICK_MATH: '0' }) && !loopTickMathOn({ STOCK_TICK_MATH: '0' }), 'switch: on by default; LOOP_TICK_MATH=0 or STOCK_TICK_MATH=0 turns it off');

// --- 1. Each hop vs the chain quoter (recorded) ------------------------------
{
  let exact = 0, ranOut = 0;
  for (const r of RECORDED) {
    const p = stateOf(r, idFor(r));
    for (const c of r.cases) {
      const amt = BigInt(c.amountIn), dir = c.zeroForOne ? 'token0 in' : 'token1 in';
      if (c.quoter !== 'revert') {
        const e = exactHopOut(p, c.zeroForOne, amt), re = realisticHopOut(p, c.zeroForOne, amt);
        assert(e === BigInt(c.quoter) && re === e, `${r.label} ${r.k} ${dir}: loop finder hop = chain quoter EXACTLY (${c.quoter}; got ${e}, realistic ${re})`);
        exact++;
      } else {
        // The quoter refused (not enough liquidity): the walk must run out of
        // the loaded ranges and give back less than the old flat guess.
        const left0 = tickBook.stats.leftWindow;
        const re = realisticHopOut(p, c.zeroForOne, amt);
        const flat = oldHop(p, c.zeroForOne, amt);
        assert(tickBook.stats.leftWindow === left0 + 1 && re < flat, `${r.label} ${r.k} ${dir}: pool can't fill it, the loop hop runs out of liquidity (${re} vs flat ${flat})`);
        ranOut++;
      }
    }
  }
  assert(exact === 13 && ranOut === 7, `13 quoter-exact hops and 7 "runs out" hops checked (got ${exact}, ${ranOut})`);
}

// --- 2. Old behaviour back with LOOP_TICK_MATH=0 ------------------------------
{
  let same = true;
  for (const r of RECORDED) {
    const p = stateOf(r, idFor(r));
    for (const c of r.cases) {
      const amt = BigInt(c.amountIn);
      if (withLoopFlag('0', () => exactHopOut(p, c.zeroForOne, amt)) !== oldHop(p, c.zeroForOne, amt)) same = false;
    }
  }
  assert(same, 'LOOP_TICK_MATH=0: every hop is exactly the old in-band maths (LP fee only)');
  const deep = stateOf(R('0x2707cb88'), idFor(R('0x2707cb88')));
  assert(hopFeePips(deep, true) === v4SwapFeePips(10000, 4097000, true) && hopFeePips(deep, true) === 10990, 'V4 hop fee: 1% LP + 0.10% protocol = 10,990 pips');
  assert(withLoopFlag('0', () => hopFeePips(deep, true)) === 10000, 'LOOP_TICK_MATH=0: V4 hop fee = LP fee only (old)');
  assert(hopWalks(deep) && !withLoopFlag('0', () => hopWalks(deep)), 'walked hops: on with the switch, off without');
  // The deep pool, $1,100 USDG in: the old hop left out the V4 protocol fee
  // (0.099%), the new one matches the chain to the unit.
  const amt = 1_100_000_000n;
  const oldR = withLoopFlag('0', () => realisticHopOut(deep, true, amt)), newR = realisticHopOut(deep, true, amt);
  console.log(`  deep SNDK V4, $1,100 in: old loop hop ${oldR}, new ${newR}, chain quoter 991518088464827990`);
  assert(newR === 991518088464827990n, 'deep SNDK pool $1,100: new loop hop = quoter exactly (old one was 0.1% too high: no protocol fee)');
  const capOld = withLoopFlag('0', () => maxLoopInput([deep], [{ poolKey: deep.poolAddress, tokenIn: USDG, tokenOut: SNDK, inIsA: true }]));
  const capNew = maxLoopInput([deep], [{ poolKey: deep.poolAddress, tokenIn: USDG, tokenOut: SNDK, inIsA: true }], { walked: true });
  // A loaded window whose tick data disagrees with the pool (the walk refuses):
  // the hop must fall back to the old maths WITH its band limit, never unbounded.
  {
    const bad = { ...deep, poolAddress: '0x' + 'bd'.repeat(32) };
    const w = winOf(R('0x2707cb88'));
    tickBook.put(bad.poolAddress, { ...w, ticks: w.ticks.map((e) => (e.tick === 206200 ? { tick: 206200, liquidityNet: BigInt(R('0x2707cb88').L) * 2n } : e)) }, R('0x2707cb88').protocolFee);
    const big = 10_000_000_000n; // $10,000: past the band edge (about $4,934)
    const maxIn = BigInt(Math.floor(inBandMaxIn(bad, true)!));
    const want = clAmountOut(bad.sqrtPriceX96!, bad.liquidity!, big < maxIn ? big : maxIn, true, 10990).amountOut;
    const got = realisticHopOut(bad, true, big);
    assert(got === want, `walk refuses (bad tick data): hop falls back to the band-limited old maths + protocol fee (${got} = ${want})`);
  }
  assert(capNew === Infinity && Number.isFinite(capOld), `exact check size limit: band edge before ($${(capOld / 1e6).toFixed(0)}), none for a walked hop now (real balance / depth caps still apply)`);
}

// --- 3. A loop that only "paid" because the V4 protocol fee was ignored -------
// USDG -> SNDK on the deep V4 pool (real recorded state), SNDK -> WETH and
// WETH -> USDG on two deep V2 pools priced so that, at LP fees only, a small
// trade comes back 0.08% ahead. The real 0.099% V4 protocol fee eats it.
const W = '0x' + '33'.repeat(20);
const deepR = R('0x2707cb88');
const deepLoop = stateOf(deepR, '0x' + '2a'.repeat(32));
tickBook.put(deepLoop.poolAddress, winOf(deepR), deepR.protocolFee);
const p0 = (Number(BigInt(deepR.sqrtP)) / 2 ** 96) ** 2;            // SNDK raw per USDG raw
const q2 = 1.0008 / (p0 * (1 - 0.01) * 0.997 * 0.997);               // USDG raw per WETH raw
const E30 = 10n ** 30n;
const v2 = (addr: string, a: string, b: string, ra: bigint, rb: bigint): PoolState => ({ chain: 'robinhood', dex: 'uniswap-v2', poolAddress: addr, poolType: 'v2', tokenA: a, tokenB: b, reserveA: ra, reserveB: rb, feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: 1 });
const sw = v2('0x' + '44'.repeat(20), SNDK, W, E30, E30);
const wu = v2('0x' + '55'.repeat(20), W, USDG, E30, BigInt(Math.round(q2 * 1e12)) * 10n ** 18n);
let clock = 1_000_000;
const env: LoopEnv = {
  decimalsOf: (t) => (t.toLowerCase() === USDG ? 6 : 18),
  usdOf: (t) => (t.toLowerCase() === USDG ? 1 : null),
  depthUsd: () => 1_000_000,
  gasUsd: () => 0.01,
  isTradable: () => true,
  now: () => clock,
};
const findLoop = () => {
  clock += 1;
  const f = new LoopFinder({ bases: [USDG], updateBudgetMs: Infinity, sliceMs: Infinity }, env);
  return f.update([deepLoop, sw, wu].map((p) => ({ ...p, lastUpdatedMs: clock }))).results.find((x) => x.cycle.hops[0].poolKey === deepLoop.poolAddress.toLowerCase());
};
{
  const oldL = withLoopFlag('0', findLoop), newL = findLoop();
  console.log(`  protocol-fee loop: old finder ${oldL ? `pays $${oldL.netUsd.toFixed(2)} at $${oldL.sizeUsd.toFixed(0)}` : 'nothing'}, new finder ${newL ? `pays $${newL.netUsd.toFixed(2)}` : 'nothing'}`);
  assert(!!oldL && oldL.netUsd > 0, 'old finder (LOOP_TICK_MATH=0): reports the loop as paying (phantom: the chain charges the V4 protocol fee)');
  assert(!newL, 'new finder: the loop is not reported (V4 protocol fee charged)');
  // Same loop with no protocol fee on that pool: still found (nothing else changed).
  tickBook.put(deepLoop.poolAddress, winOf(deepR), 0);
  const noFee = findLoop();
  assert(!!noFee && noFee.netUsd > 0, 'same loop without a protocol fee: still found by the new finder (only the fee changed the answer)');
  if (noFee) {
    // Its reported number is the exact walk of each hop at the chosen size.
    const h1 = exactHopOut(deepLoop, true, noFee.amountIn);
    assert(noFee.amountOut === exactHopOut(wu, true, exactHopOut(sw, true, h1)), 'reported loop output = hop-by-hop exact maths at the chosen size');
  }
  tickBook.put(deepLoop.poolAddress, winOf(deepR), deepR.protocolFee);
}

// --- 4/5. Windows reach the worker thread; speed -----------------------------
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(10); }
  return cond();
}
(async () => {
  {
    const edgeR = R('0x6d65849d');
    const a = stateOf(deepR, '0x' + '3a'.repeat(32)), b = stateOf(edgeR, '0x' + '3b'.repeat(32));
    tickBook.put(a.poolAddress, winOf(deepR), deepR.protocolFee);
    tickBook.put(b.poolAddress, winOf(edgeR), edgeR.protocolFee);
    const states = new Map([[a.poolAddress, a], [b.poolAddress, b]]);
    let t = 5_000_000;
    let asked = 0;
    const src: LoopSource = {
      watchedPairs: () => [[a.poolAddress, b.poolAddress]], extraKeys: () => null,
      main: (k) => states.get(k), confirmed: (k) => states.get(k), info: () => ({ block: 1, at: 1, fromBlock: true }),
      realPrices: true, usdOf: () => 1, decimalsOf: () => 18, symbolOf: (x) => x.slice(0, 6), tradable: () => true, practiceDex: () => true,
      gasUsd: () => 0.01, rivalPools: () => new Set(), balance: () => undefined, budgetOk: () => true, head: () => 1, bases: [USDG], now: () => t,
      tickEntry: (p) => { asked++; return tickBook.entry(p.poolAddress); },
    };
    // Feeder alone: windows sent once, again only when they change.
    const f = new MainLoopFeeder(src);
    const b1 = f.build(false)!; f.ack(b1.seq);
    assert(!!b1.win && b1.win.length === 2 && b1.win.every(([, e]) => !!e && !!e.win), 'feeder: both V3/V4 pools\' windows sent to the worker');
    t += 1_000; const b2 = f.build(false)!; f.ack(b2.seq);
    assert(!b2.win, 'feeder: nothing re-sent within 5 s');
    tickBook.put(a.poolAddress, winOf(deepR), deepR.protocolFee); // a reload = a new entry
    t += 5_000; const b3 = f.build(false)!; f.ack(b3.seq);
    assert(!!b3.win && b3.win.length === 1 && b3.win[0][0] === a.poolAddress, 'feeder: a reloaded window is sent again (only that one)');
    const noTick = new MainLoopFeeder({ ...src, tickEntry: undefined });
    const b4 = noTick.build(false)!;
    assert(!b4.win, 'feeder with LOOP_TICK_MATH=0 (no tickEntry): no windows sent');

    // A real worker thread: its own (empty, passive) book fills from the main thread.
    const ENV = { LOOP_TRADER: '1', LOOP_MAX_POOLS: '4', LOOP_MAX_CYCLES: '100', LOOP_CHECKS_PER_MIN: '0' };
    const init: LoopWorkerInit = {
      t: 'init', loopCfg: loopConfigFromEnv(ENV, () => {}), fix: loopFixFromEnv(ENV), realPricesOn: true, triggersOn: false, extraOn: false, bases: [USDG], minDepthUsd: 0,
      node: { cfg: loopNodeFromEnv({}, () => {}), maxRps: 2, freeUrl: 'https://example.invalid', weth: W, slotsFile: null, triggerPollMs: 300, triggerMaxPolls: 6, sharedBudget: false },
      statsMs: 100, peekMs: 15 * 60_000, logPerMin: 60, fixedClock: true, testHooks: true, testFinder: { updateBudgetMs: Infinity, sliceMs: Infinity },
    };
    const host = new LoopWorkerHost({ init, feeder: new MainLoopFeeder(src), permit: () => true, noteGas: () => {}, log: () => {}, warn: () => {}, autoFlush: false });
    host.start();
    assert(await waitFor(() => host.alive), 'worker thread started');
    host.flushNow(true, true);
    const got = await waitFor(() => (host.stats?.tick?.wins ?? 0) >= 2, 5_000);
    assert(got, `worker thread holds the windows the main thread sent (${host.stats?.tick?.wins ?? 0})`);
    host.stop();
  }

  // Speed: the exact loop check (golden-section search, ~40 sizes x 3 hops).
  {
    tickBook.put(deepLoop.poolAddress, winOf(deepR), 0);
    const f = new LoopFinder({ bases: [USDG], updateBudgetMs: Infinity, sliceMs: Infinity }, env);
    clock += 1;
    f.update([deepLoop, sw, wu].map((p) => ({ ...p, lastUpdatedMs: clock })));
    const cyc = (f as any).cycles?.find?.((c: any) => c.hops[0].poolKey === deepLoop.poolAddress.toLowerCase()) ?? null;
    const N = 300;
    const time = (g: () => void) => { const t0 = process.hrtime.bigint(); for (let i = 0; i < N; i++) g(); return Number(process.hrtime.bigint() - t0) / 1e3 / N; };
    if (cyc) {
      const usOld = withLoopFlag('0', () => time(() => f.exact(cyc)));
      const usNew = time(() => f.exact(cyc));
      console.log(`  speed: exact loop check old ${usOld.toFixed(0)} us, new ${usNew.toFixed(0)} us (3 pools, one walked)`);
      assert(usNew < 5_000, 'exact loop check stays under 5 ms (it runs for the top ~20 loops per update)');
    } else {
      // Fall back to the hop maths alone if the finder keeps its list elsewhere.
      const amts = Array.from({ length: 64 }, (_, i) => BigInt(50 + i * 31) * 1_000_000n);
      const M = 20_000;
      const t0 = process.hrtime.bigint(); withLoopFlag('0', () => { for (let i = 0; i < M; i++) realisticHopOut(deepLoop, true, amts[i & 63]); });
      const t1 = process.hrtime.bigint(); for (let i = 0; i < M; i++) realisticHopOut(deepLoop, true, amts[i & 63]);
      const t2 = process.hrtime.bigint();
      const o = Number(t1 - t0) / 1e3 / M, n = Number(t2 - t1) / 1e3 / M;
      console.log(`  speed: loop hop old ${o.toFixed(2)} us, new ${n.toFixed(2)} us`);
      assert(n < 150, 'walked loop hop stays well under 150 microseconds');
    }
  }
})();
