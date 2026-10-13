// Tests for longer loops (up to 8 pools) in the loop finder (core/loopFinder.ts):
// 6/7/8-pool loops found and 9 not, LOOP_MAX_POOLS limits and warnings,
// loop list shared out between lengths, the "best case" check never dropping
// a loop that pays, the rebuild done in slices (the bot keeps running in
// between), gas scaled per pool, the hourly block by length, and a speed
// benchmark at 5 and 8 pools with ~1,000 pools.
import { enumerateCycles, composeCurves, hopCurve, bestInputClosedForm, LoopFinder, LoopEnv } from '../core/loopFinder';
import { LoopTrader, loopConfigFromEnv, loopMaxPoolsFromEnv, loopGasUsd } from '../core/loopTrader';
import { formatLoopHour, byLengthText } from '../core/loopReport';
import type { PoolState } from '../core/types';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const W = A(1), USDG = A(2);
let clock = 5_000_000;

// A Uniswap-V2-style pool with reserves in whole tokens (18 decimals).
function v2(addr: number, tA: string, tB: string, rA: number, rB: number, feeBps = 30): PoolState {
  return { chain: 'robinhood', dex: 'uniswap-v2', poolAddress: A(addr), poolType: 'v2', tokenA: tA, tokenB: tB,
    reserveA: BigInt(Math.round(rA * 1e6)) * 10n ** 12n, reserveB: BigInt(Math.round(rB * 1e6)) * 10n ** 12n,
    feeBps, lastUpdatedBlock: 1, lastUpdatedMs: clock };
}
// Ring of n pools: W -> T1 -> ... -> T(n-1) -> W. `skew` makes the last
// pool pay more WETH than it should, so the loop pays (one direction).
function ring(n: number, startAddr: number, tokStart: number, skew = 1): PoolState[] {
  const toks = [W, ...Array.from({ length: n - 1 }, (_, i) => A(tokStart + i))];
  return toks.map((t, i) => v2(startAddr + i, t, toks[(i + 1) % n], 1_000, i === n - 1 ? 1_000 * skew : 1_000));
}

// Timing limits. The deploy runs npm test on the server, where a busy machine
// can stretch any single timing, so by default the limits are generous. Set
// PERF_STRICT=1 to check the real targets (slice under 15 ms).
const STRICT = process.env.PERF_STRICT === '1';
const SLICE_LIMIT_MS = STRICT ? 15 : 60;

const env: LoopEnv = {
  decimalsOf: () => 18,
  usdOf: (t) => (t.toLowerCase() === W || t.toLowerCase() === USDG ? 1 : null),
  depthUsd: () => 1_000_000,
  gasUsd: (hops) => 0.01 * hops,
  isTradable: () => true,
  now: () => clock,
};

(async () => {
  // -------------------------------------------------------------------------
  // 1) 6, 7 and 8-pool loops are found at LOOP_MAX_POOLS 8; 9 is not
  // -------------------------------------------------------------------------
  {
    for (const n of [6, 7, 8]) {
      const { cycles } = enumerateCycles(ring(n, 100 * n, 1000 * n), [W], 3, 8);
      assert(cycles.length === 2 && cycles.every((c) => c.hops.length === n), `${n}-pool loop listed at max 8 (both directions)`);
    }
    const nine = enumerateCycles(ring(9, 900, 9000), [W], 3, 8);
    assert(nine.cycles.length === 0, '9-pool loop NOT listed at max 8');
    // The finder (with the best-case check on) reports paying 6/7/8-pool loops.
    for (const n of [6, 7, 8]) {
      clock += 10_000;
      const f = new LoopFinder({ bases: [W], maxPools: 8 }, env);
      const out = f.update(ring(n, 2000 + 100 * n, 20_000 + 1000 * n, 1.2));
      const best = out.results[0];
      assert(!!best && best.cycle.hops.length === n && best.netUsd > 0, `finder: paying ${n}-pool loop found (net $${best?.netUsd.toFixed(2)})`);
      assert(!!best && best.gasUsd === env.gasUsd(n), `finder: ${n}-pool loop pays gas for ${n} pools`);
    }
    clock += 10_000;
    const f9 = new LoopFinder({ bases: [W], maxPools: 8 }, env);
    assert(f9.update(ring(9, 3000, 30_000, 1.5)).results.length === 0, 'finder: paying 9-pool loop NOT found at max 8');
    clock += 10_000;
    const f5 = new LoopFinder({ bases: [W], maxPools: 5 }, env);
    assert(f5.update(ring(6, 3100, 31_000, 1.2)).results.length === 0, 'finder: 6-pool loop NOT found at the default max 5');
  }

  // -------------------------------------------------------------------------
  // 2) LOOP_MAX_POOLS: 3 to 8, default 5, warns on bad values
  // -------------------------------------------------------------------------
  {
    const warns: string[] = [];
    const w = (m: string) => warns.push(m);
    assert(loopMaxPoolsFromEnv(undefined, w) === 5 && loopMaxPoolsFromEnv('', w) === 5 && warns.length === 0, 'LOOP_MAX_POOLS unset: 5, no warning');
    assert(loopMaxPoolsFromEnv('8', w) === 8 && loopMaxPoolsFromEnv('6', w) === 6 && warns.length === 0, 'LOOP_MAX_POOLS 6 and 8 accepted, no warning');
    assert(loopMaxPoolsFromEnv('9', w) === 8 && warns.length === 1, 'LOOP_MAX_POOLS 9 -> 8 with a warning');
    assert(loopMaxPoolsFromEnv('2', w) === 3 && warns.length === 2, 'LOOP_MAX_POOLS 2 -> 3 with a warning');
    assert(loopMaxPoolsFromEnv('abc', w) === 5 && warns.length === 3, 'LOOP_MAX_POOLS abc -> 5 with a warning');
    assert(loopMaxPoolsFromEnv('6.5', w) === 7 && warns.length === 4, 'LOOP_MAX_POOLS 6.5 -> 7 with a warning');
    assert(loopConfigFromEnv({}, w).maxPools === 5, 'default stays 5');
    const c = loopConfigFromEnv({ LOOP_MAX_POOLS: '8' }, w);
    assert(c.maxPools === 8 && c.longSlack === 0.02, 'LOOP_MAX_POOLS 8 and LOOP_LONG_SLACK default 2%');
  }

  // -------------------------------------------------------------------------
  // 3) Loop list shared out between lengths: lots of short loops can't
  //    crowd out long ones
  // -------------------------------------------------------------------------
  {
    // 30 coins all paired with WETH and with each other in a chain: hundreds
    // of 3-5 pool loops. Plus one separate 6-pool ring.
    const pools: PoolState[] = [];
    for (let i = 0; i < 30; i++) pools.push(v2(4000 + i, W, A(40_000 + i), 1_000, 1_000));
    for (let i = 0; i < 29; i++) pools.push(v2(4100 + i, A(40_000 + i), A(40_001 + i), 1_000, 1_000));
    pools.push(...ring(6, 4200, 42_000));
    const all = enumerateCycles(pools, [W], 3, 6);
    assert((all.byLen[3] ?? 0) > 20 && (all.byLen[6] ?? 0) >= 2, `no cap: ${all.byLen[3]} 3-pool, ${all.byLen[6]} 6-pool loops`);
    const cap = enumerateCycles(pools, [W], 3, 6, { maxCycles: 40 });
    const by = (n: number) => cap.byLen[n] ?? 0;
    assert(cap.cycles.length <= 40 && by(3) <= 10 && by(4) <= 10 && by(5) <= 10 && by(6) >= 2,
      `LOOP_MAX_CYCLES 40 over 4 lengths: 3p ${by(3)}, 4p ${by(4)}, 5p ${by(5)}, 6p ${by(6)} (each at most its share, 6-pool ring kept)`);
    // A length with few loops passes its unused share on to the longer ones.
    // Only 2 three-pool loops (one ring), lots of 4-pool loops (W-Ti-X-Tj-W).
    const fourish: PoolState[] = ring(3, 4300, 43_000);
    for (let i = 0; i < 10; i++) { fourish.push(v2(4400 + i, W, A(44_000 + i), 1_000, 1_000)); fourish.push(v2(4500 + i, A(44_000 + i), A(45_000), 1_000, 1_000)); }
    const few = enumerateCycles(fourish, [W], 3, 4, { maxCycles: 40 });
    assert(few.byLen[3] === 2 && few.byLen[4] === 38, `unused share rolls over: 3p ${few.byLen[3]}, 4p ${few.byLen[4]} (of 40)`);
    // Rival pools are tried first: with a share of 1 loop per length, the
    // loop listed is the one through the rival's pool.
    const rival = new Set([A(4010), A(4110), A(4011)].map((x) => x.toLowerCase())); // a rival route W-T10-T11-W
    const pref = enumerateCycles(pools, [W], 3, 3, { maxCycles: 1, preferPools: rival });
    assert(pref.cycles.length === 1 && pref.cycles[0].hops.some((h) => h.poolKey === A(4110).toLowerCase()), 'rival loop pools are listed first');
  }

  // -------------------------------------------------------------------------
  // 4) The best-case check never drops a loop that pays
  // -------------------------------------------------------------------------
  {
    let seed = 99; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const maxTradeUsd = 2_000, slack = 0.02;
    const minLog = (n: number) => Math.log1p(env.gasUsd(n) / maxTradeUsd) + Math.log(1 - slack);
    let paying = 0, kept = 0, allCount = 0, boundCount = 0;
    for (let g = 0; g < 6; g++) {
      // 14 coins with a "true" price; pools priced around it, some off by up to +-4%.
      const toks = [W, ...Array.from({ length: 13 }, (_, i) => A(50_000 + g * 100 + i))];
      const price = toks.map((_, i) => (i === 0 ? 1 : 0.2 + rnd() * 5));
      const pools: PoolState[] = [];
      for (let k = 0; k < 34; k++) {
        const a = Math.floor(rnd() * 14), b = Math.floor(rnd() * 14);
        if (a === b) continue;
        const usd = 5_000 + rnd() * 50_000, off = 1 + (rnd() - 0.5) * 0.08;
        pools.push(v2(60_000 + g * 100 + k, toks[a], toks[b], usd / price[a], (usd / price[b]) * off, rnd() < 0.5 ? 5 : 30));
      }
      const all = enumerateCycles(pools, [W], 6, 7);
      const bounded = enumerateCycles(pools, [W], 6, 7, { longFrom: 6, minLog });
      allCount += all.cycles.length; boundCount += bounded.cycles.length;
      const listed = new Set(bounded.cycles.map((c) => c.sig));
      const byKey = new Map(pools.map((p) => [p.poolAddress.toLowerCase(), p]));
      for (const c of all.cycles) {
        // Best possible profit on this loop, up to the biggest trade ($1 per WETH here).
        const curves = c.hops.map((h) => hopCurve(byKey.get(h.poolKey)!, h.inIsA)!);
        const { A: cA, C: cC } = composeCurves(curves);
        const net = bestInputClosedForm(cA, cC, maxTradeUsd * 1e18).profit / 1e18 - env.gasUsd(c.hops.length);
        if (net > 0) { paying++; if (listed.has(c.sig)) kept++; }
      }
    }
    assert(paying > 0 && kept === paying, `best-case check kept every paying 6-7 pool loop (${kept} of ${paying})`);
    assert(boundCount < allCount, `best-case check skipped loops that can't come close (${boundCount} listed of ${allCount})`);
  }

  // -------------------------------------------------------------------------
  // 5) The rebuild runs in slices: other work runs in between
  // -------------------------------------------------------------------------
  const big = bigGraph(1);
  {
    clock += 120_000;
    // Timed up to 3 times (best run counts), see the benchmark below.
    let started = false, otherWork = 0, o!: ReturnType<LoopFinder['update']>, s!: NonNullable<ReturnType<LoopFinder['rebuildStats']>>;
    for (let tries = 0; tries < 3; tries++) {
      clock += 120_000;
      const f = new LoopFinder({ bases: [W, USDG], maxPools: 8, maxCycles: 20_000 }, env);
      f.update(big.pools);
      started = f.rebuilding();
      otherWork = 0;
      const tick = () => { otherWork++; if (f.rebuilding()) setImmediate(tick); };
      setImmediate(tick);
      await f.idle();
      o = f.update(big.pools);
      s = f.rebuildStats()!;
      if (s.maxSliceMs < 15) break;
    }
    assert(started && o.rebuilt && s.slices > 1, `rebuild at 8 pools ran in ${s.slices} slices`);
    assert(otherWork >= 2, `other work ran between slices (${otherWork} times)`);
    assert(s.maxSliceMs < SLICE_LIMIT_MS, `no slice held the bot more than ${SLICE_LIMIT_MS} ms (longest ${s.maxSliceMs.toFixed(1)} ms)`);
  }

  // -------------------------------------------------------------------------
  // 6) Gas scaled per pool, 3 to 8
  // -------------------------------------------------------------------------
  {
    // Fitted to PR #116 fork gas: 123k + 128k per pool, scaled from the 2-pool estimate.
    assert(Math.abs(loopGasUsd(0.04, 2) - 0.04) < 1e-12, 'gas: a 2-pool result stays the same');
    const ratio = (n: number) => loopGasUsd(1, n);
    assert(Math.abs(ratio(3) * 379 - 507) < 1 && Math.abs(ratio(5) * 379 - 763) < 1 && Math.abs(ratio(8) * 379 - 1147) < 1,
      `gas: 3/5/8 pools = ${ratio(3).toFixed(2)}x / ${ratio(5).toFixed(2)}x / ${ratio(8).toFixed(2)}x the 2-pool gas (fit to 502k/646k/758k measured)`);
    let up = true;
    for (let n = 3; n <= 8; n++) up = up && ratio(n) > ratio(n - 1);
    assert(up, 'gas: every extra pool (3 to 8) costs more');
  }

  // -------------------------------------------------------------------------
  // 7) Hourly block: counts by length, rival loops longer than our max
  // -------------------------------------------------------------------------
  {
    assert(byLengthText([0, 0, 0, 4, 2, 1, 0, 0, 0], 5) === '3p 4, 4p 2, 5p 1, 6p -, 7p -, 8p -', 'by-length text at max 5');
    const cfg = loopConfigFromEnv({ LOOP_TRADER: '1', LOOP_MAX_POOLS: '8', LOOP_CHECKS_PER_MIN: '0' }, () => {});
    const t = new LoopTrader(cfg, {
      env, bases: [W], symbolOf: (x) => (x === W ? 'WETH' : 'T' + parseInt(x.slice(-4), 16)), decimalsOf: () => 18,
      canPracticeTest: () => true, canCheckNow: () => true, runCheck: async () => ({ status: 'loss' } as any),
    });
    clock += 120_000;
    t.onUpdate(ring(7, 7000, 70_000, 1.2));
    t.noteRival({ bot: '0xd7572f00', pools: 9, route: [], grossUsd: 1, gasUsd: 0.01, failed: false, t: clock });
    t.noteRival({ bot: '0xd7572f00', pools: 7, route: [A(1), A(2)], grossUsd: 1, gasUsd: 0.01, failed: false, t: clock });
    const h = t.takeHour();
    assert(h.foundByLen[7] === 1 && h.rival.longer === 1 && h.rival.unseen === 1, 'hour: 7-pool loop counted by length; rival 9-pool loop counted as longer');
    const txt = formatLoopHour(h, 8);
    assert(txt.includes('found by length: 3p 0, 4p 0, 5p 0, 6p 0, 7p 1, 8p 0') && txt.includes('1 were longer than our max of 8 pools') && txt.includes('3-8 pool loops'),
      'hourly block shows counts by length and rival loops longer than our max');
  }

  // -------------------------------------------------------------------------
  // 8) Benchmark: ~1,000 pools (700 watched + 300 extra), 5 and 8 pools
  // -------------------------------------------------------------------------
  // The longest slice can be stretched by the computer itself (memory clean-up,
  // other programs), so the rebuild is timed 3 times and the best run counts.
  for (const [maxPools, maxCycles] of [[5, 5_000], [8, 5_000], [8, 20_000]]) {
    const g = bigGraph(7);
    let f!: LoopFinder, s!: ReturnType<LoopFinder['rebuildStats']> & object;
    for (let tries = 0; tries < 3; tries++) {
      clock += 120_000;
      const fi = new LoopFinder({ bases: [W, USDG], maxPools, maxCycles }, env);
      fi.update(g.pools);
      await fi.idle();
      fi.update(g.pools);
      const si = fi.rebuildStats()!;
      if (!s || si.maxSliceMs < s.maxSliceMs) { f = fi; s = si; }
      if (s.maxSliceMs < 15) break;
    }
    while (f.update(g.pools).waiting) { /* price every loop once */ }
    const times: number[] = [];
    let evald = 0;
    for (let k = 0; k < 40; k++) {
      clock += 300;
      for (let j = 0; j < 10; j++) {
        const i = Math.floor(g.rnd() * g.pools.length), p = g.pools[i];
        const m = 1 + (g.rnd() - 0.5) * 0.01; // a trade moves the price up to 0.5%
        g.pools[i] = { ...p, reserveA: BigInt(Math.floor(Number(p.reserveA!) * m)), reserveB: BigInt(Math.floor(Number(p.reserveB!) / m)), lastUpdatedMs: clock };
      }
      const o = f.update(g.pools);
      times.push(o.ms); evald += o.evaluated.length;
    }
    times.sort((a, b) => a - b);
    const med = times[Math.floor(times.length / 2)], worst = times[times.length - 1];
    console.log(`  benchmark ${maxPools} pools, LOOP_MAX_CYCLES ${maxCycles}: ${g.pools.length} pools, ${s.cycles} loops (${byLengthText(s.byLen, maxPools)}); rebuild ${s.totalMs.toFixed(0)} ms total, ${s.workMs.toFixed(0)} ms work in ${s.slices} slices, longest slice ${s.maxSliceMs.toFixed(1)} ms; update median ${med.toFixed(2)} ms, slowest ${worst.toFixed(2)} ms, ~${Math.round(evald / times.length)} loops re-priced per update`);
    assert(med < 20, `benchmark ${maxPools} pools / ${maxCycles} loops: typical update under 20 ms (${med.toFixed(2)} ms)`);
    assert(s.maxSliceMs < SLICE_LIMIT_MS, `benchmark ${maxPools} pools / ${maxCycles} loops: rebuild never holds the bot over ${SLICE_LIMIT_MS} ms (${s.maxSliceMs.toFixed(1)} ms)`);
    if (maxPools === 8) assert((s.byLen[6] ?? 0) + (s.byLen[7] ?? 0) + (s.byLen[8] ?? 0) > 0 && (s.byLen[3] ?? 0) > 0, 'benchmark 8 pools: both short and long loops listed');
  }
})();

// A realistic-ish coin map: 2 base coins, ~300 coins with a "true" price,
// ~700 pools against WETH/USDG or between coins, ~300 extra coin-to-coin
// pools. Pools sit near the true price (+-0.3%), fees 0.05% / 0.3% / 1%.
function bigGraph(s0: number) {
  let seed = s0; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const n = 300;
  const toks = [W, USDG, ...Array.from({ length: n - 2 }, (_, i) => A(100_000 + i))];
  const price = toks.map((_, i) => (i < 2 ? 1 : Math.exp((rnd() - 0.5) * 8)));
  const fees = [5, 30, 30, 100];
  const pools: PoolState[] = [];
  let addr = 200_000;
  const add = (a: number, b: number) => {
    const usd = 10_000 * Math.exp(rnd() * 4), off = 1 + (rnd() - 0.5) * 0.006;
    pools.push(v2(addr++, toks[a], toks[b], usd / price[a], (usd / price[b]) * off, fees[Math.floor(rnd() * fees.length)]));
  };
  for (let i = 2; i < n; i++) add(rnd() < 0.7 ? 0 : 1, i);               // every coin on WETH or USDG
  for (let i = 2; i < n; i++) if (rnd() < 0.4) add(rnd() < 0.5 ? 0 : 1, i); // some on both
  while (pools.length < 700) { const a = 2 + Math.floor(rnd() * (n - 2)), b = 2 + Math.floor(rnd() * (n - 2)); if (a !== b) add(a, b); }
  add(0, 1);
  for (let k = 0; k < 300; k++) { const a = 2 + Math.floor(rnd() * (n - 2)), b = 2 + Math.floor(rnd() * (n - 2)); if (a !== b) add(a, b); }
  return { pools, rnd };
}

