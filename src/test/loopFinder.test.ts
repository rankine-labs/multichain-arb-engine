// Tests for the loop trader v1 (core/loopFinder.ts, core/loopTrader.ts, core/loopReport.ts):
// loop listing (3/4/5 pools found, 6 not), best-size search, exact V2 maths
// against a hand calculation, counting a loop once until it closes, the
// practice-check cap, the off switch, and a speed benchmark.
import { enumerateCycles, goldenMax, bestInputClosedForm, composeCurves, hopCurve, exactLoopOut, LoopFinder, LoopEnv, LoopHop } from '../core/loopFinder';
import { LoopTrader, loopConfigFromEnv, buildLoopTrade, LOOP_LIVE_SEND_POSSIBLE, LoopTrade } from '../core/loopTrader';
import { formatLoopHour } from '../core/loopReport';
import type { PoolState } from '../core/types';
import type { SimResult } from '../execution/simulator';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const W = A(1), USDG = A(2);
let clock = 1_000_000;
const E18 = 10n ** 18n;

// A Uniswap-V2-style pool (0.30% fee) with reserves in whole tokens (18 decimals).
function v2(addr: number, tA: string, tB: string, rA: number, rB: number, feeBps = 30): PoolState {
  return { chain: 'robinhood', dex: 'uniswap-v2', poolAddress: A(addr), poolType: 'v2', tokenA: tA, tokenB: tB,
    reserveA: BigInt(Math.round(rA * 1e6)) * 10n ** 12n, reserveB: BigInt(Math.round(rB * 1e6)) * 10n ** 12n,
    feeBps, lastUpdatedBlock: 1, lastUpdatedMs: clock };
}
// Ring of n pools: W -> T1 -> ... -> T(n-1) -> W.
function ring(n: number, startAddr: number, tokStart: number): PoolState[] {
  const toks = [W, ...Array.from({ length: n - 1 }, (_, i) => A(tokStart + i))];
  return toks.map((t, i) => v2(startAddr + i, t, toks[(i + 1) % n], 1_000, 1_000));
}

const env: LoopEnv = {
  decimalsOf: () => 18,
  usdOf: (t) => (t.toLowerCase() === W || t.toLowerCase() === USDG ? 1 : null),
  depthUsd: () => 1_000_000,
  gasUsd: (hops) => 0.01 * hops,
  isTradable: () => true,
  now: () => clock,
};

// ---------------------------------------------------------------------------
// 1) Loop listing
// ---------------------------------------------------------------------------
{
  for (const n of [3, 4, 5]) {
    const { cycles } = enumerateCycles(ring(n, 100 * n, 1000 * n), [W], 3, 5);
    assert(cycles.length === 2 && cycles.every((c) => c.hops.length === n), `${n}-pool loop found (both directions)`);
  }
  const six = enumerateCycles(ring(6, 600, 6000), [W], 3, 5);
  assert(six.cycles.length === 0, '6-pool loop NOT found with LOOP_MAX_POOLS 5');
  const two = enumerateCycles([v2(1, W, A(50), 10, 10), v2(2, W, A(50), 10, 10)], [W], 3, 5);
  assert(two.cycles.length === 0, '2-pool round trip is left to the gap scanner (not a loop)');
  // Loop through both base coins: listed once per direction, from WETH (preferred).
  const both = enumerateCycles([v2(1, W, A(60), 1, 1), v2(2, A(60), USDG, 1, 1), v2(3, USDG, W, 1, 1)], [W, USDG], 3, 5);
  assert(both.cycles.length === 2 && both.cycles.every((c) => c.base === W), 'loop through WETH and USDG listed once per direction, starting in WETH');
  // Cap respected (shared out between lengths: 3 loops over 3 lengths = 1 each).
  const capped = enumerateCycles(ring(3, 900, 9000).concat(ring(4, 950, 9500)), [W], 3, 5, { maxCycles: 3 });
  assert(capped.cycles.length <= 3 && capped.capped && capped.byLen[3] === 1 && capped.byLen[4] === 1, 'LOOP_MAX_CYCLES cap respected, shared between lengths');
  // Same pool set, different start / order -> same poolSet key (used for the rival match).
  assert(both.cycles[0].poolSet === both.cycles[1].poolSet && both.cycles[0].sig !== both.cycles[1].sig, 'two directions: same pool set, different signature');
}

// ---------------------------------------------------------------------------
// 2) Best-size search
// ---------------------------------------------------------------------------
{
  const g = goldenMax((x) => 5 - (x - 3) ** 2, 0, 10);
  assert(Math.abs(g.x - 3) < 1e-6 && Math.abs(g.fx - 5) < 1e-9, 'golden-section finds the top of a known curve (x=3, f=5)');
  const edge = goldenMax((x) => x, 0, 10);
  assert(Math.abs(edge.x - 10) < 1e-9, 'golden-section returns the end of a rising curve');
  // Closed form matches a brute-force search on the combined loop curve.
  const pools = [v2(1, W, A(70), 1_000, 2_000), v2(2, A(70), A(71), 2_000, 2_000), v2(3, A(71), W, 1_000, 1_300)];
  const curves = pools.map((p, i) => hopCurve(p, i === 0 ? true : true)!);
  const { A: cA, C: cC } = composeCurves(curves);
  const cf = bestInputClosedForm(cA, cC, 1e30);
  let bx = 0, bp = -Infinity;
  for (let x = 0; x <= 400e18; x += 0.05e18) { const out = (cA * x) / (1 + cC * x); if (out - x > bp) { bp = out - x; bx = x; } }
  assert(Math.abs(cf.x - bx) / bx < 0.002 && Math.abs(cf.profit - bp) / bp < 1e-4, `closed-form best size matches brute force (${(cf.x / 1e18).toFixed(2)} vs ${(bx / 1e18).toFixed(2)})`);
}

// ---------------------------------------------------------------------------
// 3) Exact V2 maths vs a hand calculation
// ---------------------------------------------------------------------------
{
  // Raw units, 0.30% fee: out = in*997*Rout / (Rin*1000 + in*997), rounded down.
  const raw = (addr: number, a: string, b: string, ra: bigint, rb: bigint): PoolState => ({ chain: 'robinhood', dex: 'uniswap-v2', poolAddress: A(addr), poolType: 'v2', tokenA: a, tokenB: b, reserveA: ra, reserveB: rb, feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: clock });
  const pools = [raw(1, W, A(80), 1000n, 2000n), raw(2, A(80), A(81), 2000n, 2000n), raw(3, A(81), W, 1000n, 1300n)];
  const hops: LoopHop[] = [
    { poolKey: A(1), tokenIn: W, tokenOut: A(80), inIsA: true },
    { poolKey: A(2), tokenIn: A(80), tokenOut: A(81), inIsA: true },
    { poolKey: A(3), tokenIn: A(81), tokenOut: W, inIsA: true },
  ];
  // Hand: 100 -> 199,400,000/1,099,700 = 181.3 -> 181; 181 -> 360,914,000/2,180,457 = 165.5 -> 165;
  //       165 -> 213,856,500/1,164,505 = 183.6 -> 183.
  assert(exactLoopOut(pools.slice(0, 1), hops.slice(0, 1), 100n) === 181n, 'hop 1: 100 in -> 181 out (hand calc)');
  assert(exactLoopOut(pools.slice(0, 2), hops.slice(0, 2), 100n) === 165n, 'hop 2: -> 165 (hand calc)');
  assert(exactLoopOut(pools, hops, 100n) === 183n, 'whole loop: 100 in -> 183 out (hand calc)');

  // Finder on the same shape in real units: net = (out - in) * $1 - gas (3 pools x 1c).
  clock += 1;
  const f = new LoopFinder({ bases: [W] }, env);
  const big = [v2(11, W, A(90), 1_000, 2_000), v2(12, A(90), A(91), 2_000, 2_000), v2(13, A(91), W, 1_000, 1_300)];
  const out = f.update(big);
  const best = out.results[0];
  assert(!!best && best.cycle.hops.length === 3, 'finder: profitable 3-pool V2 loop found');
  if (best) {
    const recomputed = exactLoopOut(best.pools, best.cycle.hops, best.amountIn);
    const hand = Number(recomputed - best.amountIn) / 1e18 - 0.03;
    assert(best.amountOut === recomputed && Math.abs(best.netUsd - hand) < 1e-9, `finder: net $${best.netUsd.toFixed(4)} = (out - in) - 3c gas`);
    // Capped at LOOP_MAX_TRADE_USD ($2,000 default) or 30% of depth, whichever is smaller.
    assert(best.sizeUsd <= 2_000 + 1e-6, 'finder: size within LOOP_MAX_TRADE_USD');
    // The unprofitable reverse direction is not reported.
    assert(out.results.every((r) => r.cycle.hops[0].tokenOut === A(90)), 'finder: losing direction not reported');
  }
}

// V3 pools: the quick curve (virtual reserves) agrees with the exact integer V3 maths, both directions.
{
  const sqrt = BigInt(Math.floor(Math.sqrt(2) * 2 ** 48)) * (1n << 48n); // price 2 (token1 per token0)
  const p3: PoolState = { chain: 'robinhood', dex: 'uniswap-v3', poolAddress: A(120), poolType: 'v3', tokenA: W, tokenB: A(121), sqrtPriceX96: sqrt, liquidity: 10n ** 24n, feeBps: 5, feePips: 500, lastUpdatedBlock: 1, lastUpdatedMs: clock };
  for (const inIsA of [true, false]) {
    const c = hopCurve(p3, inIsA)!;
    const amt = 10n ** 20n;
    const quick = (c.g * c.rout * 1e20) / (c.rin + c.g * 1e20);
    const exact = Number(exactLoopOut([p3], [{ poolKey: A(120), tokenIn: inIsA ? W : A(121), tokenOut: inIsA ? A(121) : W, inIsA }], amt));
    assert(Math.abs(quick - exact) / exact < 1e-9, `V3 quick curve matches exact maths (${inIsA ? 'token0 in' : 'token1 in'})`);
  }
}

// ---------------------------------------------------------------------------
// 4) Loop trader: counted once until it closes, check cap, off switch
// ---------------------------------------------------------------------------
const tick = () => new Promise<void>((r) => setImmediate(r));
function trader(over: Record<string, string>, checks: LoopTrade[], canCheck = () => true, result: SimResult = { status: 'profit', profit: 5n * E18 / 10n }) {
  const cfg = loopConfigFromEnv({ LOOP_TRADER: '1', ...over });
  return new LoopTrader(cfg, {
    env, bases: [W], symbolOf: (t) => (t === W ? 'WETH' : 'T' + parseInt(t.slice(-4), 16)), decimalsOf: () => 18,
    canPracticeTest: (p) => p.dex !== 'not-approved', canCheckNow: canCheck,
    runCheck: async (t) => { checks.push(t); return result; },
  });
}
(async () => {
  {
    const checks: LoopTrade[] = [];
    const t = trader({}, checks);
    clock += 10_000;
    const pools = [v2(21, W, A(100), 1_000, 2_000), v2(22, A(100), A(101), 2_000, 2_000), v2(23, A(101), W, 1_000, 1_300)];
    t.onUpdate(pools);
    t.onUpdate(pools.map((p) => ({ ...p, lastUpdatedMs: clock }))); // same prices: nothing re-priced
    // Small unrelated change on pool 22 (loop still open, smaller): not counted again.
    t.onUpdate([pools[0], { ...pools[1], reserveA: pools[1].reserveA! + 10n ** 15n }, pools[2]]);
    await tick();
    let h = t.takeHour();
    assert(h.found === 1, `open loop counted once (found ${h.found})`);
    assert(h.checked === 1 && h.wouldMake === 1 && checks.length === 1 && checks[0].hops.length === 3, 'one practice check, 3 hops, profit counted');
    // Close it (pool 23 back in line), then reopen: counts again.
    clock += 1;
    t.onUpdate([pools[0], pools[1], v2(23, A(101), W, 1_000, 500)]);
    clock += 1;
    t.onUpdate(pools);
    await tick();
    h = t.takeHour();
    assert(h.found === 1, 'closed then reopened loop counts again');
    assert(h.topRoutes[0]?.label === 'WETH/T100/T101/WETH', `route shown by coin names (${h.topRoutes[0]?.label})`);
  }
  {
    // Check cap: 5 separate loops, LOOP_CHECKS_PER_MIN=2 -> only 2 checks this minute.
    const checks: LoopTrade[] = [];
    const t = trader({ LOOP_CHECKS_PER_MIN: '2' }, checks);
    clock += 120_000;
    for (let i = 0; i < 5; i++) {
      clock += 5_000; // new pools join the loop list at most every 5 s
      t.onUpdate(Array.from({ length: 5 }, (_, j) => j).flatMap((j) => j > i ? [] : [
        v2(300 + j * 3, W, A(400 + j * 2), 1_000, 2_000), v2(301 + j * 3, A(400 + j * 2), A(401 + j * 2), 2_000, 2_000), v2(302 + j * 3, A(401 + j * 2), W, 1_000, 1_300)]));
      await tick(); await tick();
    }
    assert(checks.length === 2, `LOOP_CHECKS_PER_MIN=2 respected (${checks.length} checks)`);
    // Normal check line busy -> loops wait (no check at all).
    const none: LoopTrade[] = [];
    const busy = trader({}, none, () => false);
    clock += 120_000;
    busy.onUpdate([v2(501, W, A(600), 1_000, 2_000), v2(502, A(600), A(601), 2_000, 2_000), v2(503, A(601), W, 1_000, 1_300)]);
    await tick();
    assert(none.length === 0 && busy.takeHour().found === 1, 'normal check line busy: loop found but not checked');
  }
  {
    // Contract can't run it (exchange not approved for practice checks): reported, not checked.
    const checks: LoopTrade[] = [];
    const t = trader({}, checks);
    clock += 120_000;
    const p = [v2(701, W, A(800), 1_000, 2_000), { ...v2(702, A(800), A(801), 2_000, 2_000), dex: 'not-approved' }, v2(703, A(801), W, 1_000, 1_300)];
    t.onUpdate(p);
    await tick();
    const h = t.takeHour();
    assert(h.cantRun === 1 && checks.length === 0, "loop on an unapproved exchange: 'contract can't run it yet', no check");
    const built = buildLoopTrade({ cycle: t.finder.cycleById(0)!, pools: p, amountIn: 1n }, () => true);
    assert('trade' in built && built.trade.hops.length === 3 && built.trade.hops.every((h) => h.kind === 0), 'buildLoopTrade encodes a 3-hop V2 loop for the contract');
  }
  {
    // Off switch: nothing runs.
    const checks: LoopTrade[] = [];
    const t = trader({ LOOP_TRADER: '0' }, checks);
    const r = t.onUpdate([v2(21, W, A(100), 1_000, 2_000), v2(22, A(100), A(101), 2_000, 2_000), v2(23, A(101), W, 1_000, 1_300)]);
    await tick();
    assert(r === undefined && t.finder.cycleCount() === 0 && checks.length === 0 && t.takeHour().updates === 0, 'LOOP_TRADER off: nothing runs');
    assert(!loopConfigFromEnv({}).enabled, 'LOOP_TRADER unset = off');
    assert(LOOP_LIVE_SEND_POSSIBLE === false, 'v1 cannot send loops live');
    const c = loopConfigFromEnv({ LOOP_MAX_POOLS: '9', MIN_EXEC_NET_USD: '0.25' }, () => {});
    assert(c.maxPools === 8 && c.minNetUsd === 0.25 && c.checksPerMin === 6 && c.maxTradeUsd === 2_000 && c.maxCycles === 5_000, 'settings: defaults and limits');
  }
  {
    // Rival race: their win on the same pools as a loop we found -> "we found it".
    const t = trader({ LOOP_CHECKS_PER_MIN: '0' }, []);
    clock += 120_000;
    const pools = [v2(31, W, A(110), 1_000, 2_000), v2(32, A(110), A(111), 2_000, 2_000), v2(33, A(111), W, 1_000, 1_300)];
    t.onUpdate(pools);
    clock += 1_500;
    t.noteRival({ bot: '0xd7572f00', pools: 3, route: [A(33), A(31), A(32)], grossUsd: 1, gasUsd: 0.016, failed: false, t: clock });
    t.noteRival({ bot: '0xd7572f00', pools: 7, route: [A(1), A(2), A(3), A(4), A(5), A(6)], grossUsd: 1, gasUsd: 0.016, failed: false, t: clock });
    t.noteRival({ bot: '0xother', pools: 3, route: [A(91), A(92), A(93)], grossUsd: 1, gasUsd: 0.016, failed: false, t: clock });
    const h = t.takeHour();
    assert(h.rival.loops === 3 && h.rival.longer === 1 && h.rival.unseen === 0 && h.rival.comparable === 2 && h.rival.weFound === 1 && h.rival.leadMsMedian === 1_500, 'rival race: matched our loop 1.5 s before we read their trade');
    const txt = formatLoopHour(h, 5);
    assert(txt.includes('Loop trades: found 1, best $') && txt.includes("contract can't run 0") && txt.includes('we found 1'), 'hourly block text');
  }
  {
    // Benchmark: ~60 coins, ~360 pools, up to 5,000 loops; then updates where 10 pools moved.
    const toks = Array.from({ length: 60 }, (_, i) => (i === 0 ? W : i === 1 ? USDG : A(2000 + i)));
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const pools: PoolState[] = [];
    for (let i = 2; i < 60; i++) { pools.push(v2(5000 + i * 2, W, toks[i], 1_000 * (1 + rnd()), 1_000 * (1 + rnd()))); pools.push(v2(5001 + i * 2, USDG, toks[i], 1_000 * (1 + rnd()), 1_000 * (1 + rnd()))); }
    for (let i = 0; i < 250; i++) { const a = 2 + Math.floor(rnd() * 58), b = 2 + Math.floor(rnd() * 58); if (a !== b) pools.push(v2(9000 + i, toks[a], toks[b], 1_000 * (1 + rnd()), 1_000 * (1 + rnd()))); }
    pools.push(v2(9999, W, USDG, 1_000, 1_000));
    clock += 120_000;
    const f = new LoopFinder({ bases: [W, USDG] }, env);
    f.update(pools);
    await f.idle();               // the list is built in slices in the background
    const first = f.update(pools); // puts the new list in place
    while (f.update(pools).waiting) { /* price every loop once */ }
    const times: number[] = [];
    let evald = 0;
    for (let k = 0; k < 30; k++) {
      clock += 300;
      for (let j = 0; j < 10; j++) { const i = Math.floor(rnd() * pools.length); pools[i] = { ...pools[i], reserveA: pools[i].reserveA! + 10n ** 16n * BigInt(1 + j), lastUpdatedMs: clock }; }
      const o = f.update(pools);
      times.push(o.ms); evald += o.evaluated.length;
    }
    times.sort((a, b) => a - b);
    const med = times[15], worst = times[29];
    console.log(`  benchmark: ${pools.length} pools, ${first.cycles} loops listed in ${f.rebuildStats()!.totalMs.toFixed(1)} ms (longest slice ${f.rebuildStats()!.maxSliceMs.toFixed(1)} ms); 10 pools moved per update: median ${med.toFixed(2)} ms, slowest ${worst.toFixed(2)} ms, ~${Math.round(evald / 30)} loops re-priced per update`);
    assert(first.cycles === 5_000, 'benchmark: loop list filled to the 5,000 cap');
    assert(med < 20, `benchmark: typical update under 20 ms (${med.toFixed(2)} ms)`);
  }
})();
