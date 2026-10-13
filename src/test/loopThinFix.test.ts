// Tests for the Oct 13 loop fixes ("Loop trades: found 363, checked 85,
// would make money 0"):
//   1) each loop hop's output is capped at the pool's REAL coin balance
//      (a thin V3 pool no longer makes a loop look profitable);
//   2) loop sizes stay inside each V3 pool's current price band (no fake
//      profit at a big size; small sizes priced exactly as before);
//   3) the "check vs estimate" diagnosis adds up correctly and shows in the
//      hourly Loop trades block;
//   4) the V3 real-balance book is saved to disk and loaded at startup,
//      skipping balances older than 1 hour.
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  exactLoopOut, LoopFinder, LoopEnv, LoopHop, inBandMaxIn, tickSpacingOf, maxLoopInput, realisticHopOut, exactHopOut,
} from '../core/loopFinder';
import { LoopTrader, loopConfigFromEnv, summarizeLoopChecks, LoopCheckRecord } from '../core/loopTrader';
import { formatLoopHour } from '../core/loopReport';
import { setRealBalanceSource } from '../core/poolPrice';
import { V3BalanceBook } from '../core/v3BalanceBook';
import { clAmountOut } from '../core/venueMath';
import type { PoolState } from '../core/types';
import type { SimResult } from '../execution/simulator';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const W = A(1);
let clock = 5_000_000;
const Q96 = 2 ** 96;

// V2 pool, reserves in whole tokens (18 decimals), 0.30% fee.
function v2(addr: number, tA: string, tB: string, rA: number, rB: number): PoolState {
  return { chain: 'robinhood', dex: 'uniswap-v2', poolAddress: A(addr), poolType: 'v2', tokenA: tA, tokenB: tB,
    reserveA: BigInt(Math.round(rA * 1e6)) * 10n ** 12n, reserveB: BigInt(Math.round(rB * 1e6)) * 10n ** 12n,
    feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: clock };
}
// V3 pool: price = tokenB per tokenA, liquidity L (raw), fee in pips.
function v3(addr: number, tA: string, tB: string, price: number, L: bigint, feePips: number): PoolState {
  const sqrt = BigInt(Math.floor(Math.sqrt(price) * 2 ** 48)) * (1n << 48n);
  return { chain: 'robinhood', dex: 'uniswap-v3', poolAddress: A(addr), poolType: 'v3', tokenA: tA, tokenB: tB,
    sqrtPriceX96: sqrt, liquidity: L, feeBps: feePips / 100, feePips, lastUpdatedBlock: 1, lastUpdatedMs: clock };
}

const env: LoopEnv = {
  decimalsOf: () => 18,
  usdOf: (t) => (t.toLowerCase() === W ? 1 : null),
  depthUsd: () => 10_000_000,
  gasUsd: (hops) => 0.01 * hops,
  isTradable: () => true,
  now: () => clock,
};

// Loop W -> T -> U -> W. W->T and T->U are deep V2 pools at 1:1, so U is
// worth ~1 W there. The last pool (V3, U/W) says 1 U = 1.02 W: a 2% gap.
const T = A(200), U = A(201);
const hops: LoopHop[] = [
  { poolKey: A(10), tokenIn: W, tokenOut: T, inIsA: true },
  { poolKey: A(11), tokenIn: T, tokenOut: U, inIsA: true },
  { poolKey: A(12), tokenIn: U, tokenOut: W, inIsA: true },
];
const v2a = v2(10, W, T, 1_000_000, 1_000_000), v2b = v2(11, T, U, 1_000_000, 1_000_000);

// ---------------------------------------------------------------------------
// 1) Real balance cap on loop hops
// ---------------------------------------------------------------------------
{
  // The V3 pool looks huge (virtual ~1M U) and has a wide 1% fee band
  // (200 ticks = ~2%), but REALLY holds only 5 W.
  const thin = v3(12, U, W, 1.02, 10n ** 24n, 10_000);
  const pools = [v2a, v2b, thin];
  const bal = new Map<string, bigint>([[`${A(12)}:${W}`, 5n * 10n ** 18n], [`${A(12)}:${U}`, 10n ** 24n]]);

  setRealBalanceSource(null);
  const f0 = new LoopFinder({ bases: [W] }, env);
  const before = f0.update(pools).results[0];
  assert(!!before && before.netUsd > 1, `without real balances: loop looks like it pays $${before?.netUsd.toFixed(2)}`);

  setRealBalanceSource((p, t) => bal.get(`${p.toLowerCase()}:${t.toLowerCase()}`));
  const big = 500n * 10n ** 18n;
  const capped = exactLoopOut(pools, hops, big, { realistic: true });
  assert(capped <= 5n * 10n ** 18n, `loop output capped at the pool's real 5 W (got ${(Number(capped) / 1e18).toFixed(3)} W for 500 W in)`);
  assert(exactLoopOut(pools, hops, big) > 400n * 10n ** 18n, 'plain exact maths (old) would pay out ~500 W: the cap is what changed');
  const lim = maxLoopInput(pools, hops);
  assert(lim > 4e18 && lim < 5.2e18, `size limit worked back from the 5 W balance: ${(lim / 1e18).toFixed(3)} W`);

  clock += 1;
  const f1 = new LoopFinder({ bases: [W] }, env);
  const after = f1.update(pools.map((p) => ({ ...p, lastUpdatedMs: clock }))).results[0];
  assert(!after || (after.sizeUsd <= 5.2 && after.netUsd < 0.2), `with real balances: loop sized to what the pool holds (${after ? `$${after.sizeUsd.toFixed(2)} for $${after.netUsd.toFixed(3)}` : 'not reported'})`);
  setRealBalanceSource(null);
}

// ---------------------------------------------------------------------------
// 2) Price band limit (concentrated V3 pool)
// ---------------------------------------------------------------------------
{
  // Same loop, but the V3 pool is 0.05% fee (tick spacing 10 = ~0.1% band).
  const cl = v3(12, U, W, 1.02, 10n ** 24n, 500);
  const pools = [v2a, v2b, cl];
  assert(tickSpacingOf(cl) === 10 && tickSpacingOf({ ...cl, feePips: 3000 }) === 60 && tickSpacingOf({ ...cl, feePips: 100 }) === 1, 'tick spacing from fee tier (0.05% -> 10, 0.30% -> 60, 0.01% -> 1)');
  assert(tickSpacingOf({ ...cl, feePips: 1234 }) === 24, 'unknown fee: fee / 50 ticks (narrower = safer)');
  assert(tickSpacingOf({ ...cl, v4: { fee: 500, tickSpacing: 7, native: false, poolManager: A(9), stateView: A(9) } }) === 7, 'V4 pool: its own tick spacing');
  assert(inBandMaxIn(v2a, true) === null, 'V2 pool: no band limit');

  // Swapping exactly the band limit lands the price on the band edge, not past it.
  const maxIn = inBandMaxIn(cl, true)!;
  const s = Number(cl.sqrtPriceX96!) / Q96;
  const tick = Math.floor((2 * Math.log(s)) / Math.log(1.0001));
  const lowerSqrt = Math.pow(1.0001, (Math.floor(tick / 10) * 10) / 2) * Q96;
  const next = clAmountOut(cl.sqrtPriceX96!, cl.liquidity!, BigInt(Math.floor(maxIn)), true, 500).sqrtPriceNextX96;
  assert(maxIn > 0 && Number(next) >= lowerSqrt * (1 - 1e-9), `band limit ${(maxIn / 1e18).toFixed(1)} U keeps the price inside the band`);
  const past = clAmountOut(cl.sqrtPriceX96!, cl.liquidity!, BigInt(Math.floor(maxIn * 3)), true, 500).sqrtPriceNextX96;
  assert(Number(past) < lowerSqrt, '3x the limit would cross the band edge (what the old sizing allowed)');

  // Small size: exactly the same output as before.
  const small = 10n ** 18n;
  assert(exactLoopOut(pools, hops, small, { realistic: true }) === exactLoopOut(pools, hops, small), 'small size (1 W): realistic output = old exact output');
  assert(realisticHopOut(cl, true, small) === exactHopOut(cl, true, small), 'small size: V3 hop unchanged');

  // Old sizing: golden search up to $2,000 with no band limit. New: never past the band.
  setRealBalanceSource(null);
  clock += 1;
  const f = new LoopFinder({ bases: [W] }, env);
  const r = f.update(pools.map((p) => ({ ...p, lastUpdatedMs: clock }))).results.find((x) => x.cycle.hops[0].tokenOut === T);
  const oldOut = exactLoopOut(pools, hops, 2_000n * 10n ** 18n);
  const oldProfit = Number(oldOut - 2_000n * 10n ** 18n) / 1e18;
  const bound = maxLoopInput(pools, hops);
  assert(!!r && Number(r.amountIn) <= bound * 1.000001, `new best size $${r ? r.sizeUsd.toFixed(0) : '?'} stays within the band limit ($${(bound / 1e18).toFixed(0)})`);
  if (r) {
    // Walk the loop at the chosen size and check the V3 hop stays in its band.
    const in3 = exactHopOut(v2b, true, exactHopOut(v2a, true, r.amountIn));
    const nxt = clAmountOut(cl.sqrtPriceX96!, cl.liquidity!, in3, true, 500).sqrtPriceNextX96;
    assert(Number(nxt) >= lowerSqrt * (1 - 1e-9), 'at the chosen size the V3 hop never leaves its price band');
    assert(r.grossUsd < oldProfit, `estimate is conservative: $${r.grossUsd.toFixed(2)} in band vs $${oldProfit.toFixed(2)} the old sizing would claim at $2,000`);
  }
}

// ---------------------------------------------------------------------------
// 3) Check vs estimate diagnosis
// ---------------------------------------------------------------------------
async function checksAndBook() {
{
  const recs: LoopCheckRecord[] = [
    { route: 'a', estUsd: 0.5, outcome: 'loss', resultUsd: -0.03, delayMs: 300 },
    { route: 'a', estUsd: 1.5, outcome: 'loss', resultUsd: -0.03, delayMs: 2_500 },
    { route: 'b', estUsd: 0.2, outcome: 'profit', resultUsd: 0.1, delayMs: 800 },
    { route: 'c', estUsd: 0.9, outcome: 'fail', resultUsd: null, reason: 'STF', delayMs: 4_000 },
  ];
  const s = summarizeLoopChecks(recs);
  assert(s.n === 4 && s.lossesQuick === 1 && s.lossesSlow === 1, 'losses split quick (<1 s) 1, slow 1');
  assert(Math.abs(s.medianEstUsd! - 0.7) < 1e-9, 'median estimate of 0.2/0.5/0.9/1.5 = 0.7');
  assert(Math.abs(s.medianResultUsd! - -0.03) < 1e-9, 'median result over checks with a number (fails left out) = -0.03');
  assert(s.medianDelayMs === 1_650, 'median delay of 300/800/2500/4000 ms = 1,650 ms');
  assert(!!s.topFail && s.topFail[0] === 'STF' && s.topFail[1] === 1, 'top reason a check would not go through');
  const empty = summarizeLoopChecks([]);
  assert(empty.n === 0 && empty.medianEstUsd === null && empty.medianDelayMs === null, 'no checks: empty summary');

  // Through the trader: one quick loss, one slow loss.
  const pools = [v2(30, W, A(300), 1_000, 2_000), v2(31, A(300), A(301), 2_000, 2_000), v2(32, A(301), W, 1_000, 1_300)];
  let canCheck = false;
  const logs: string[] = [];
  const t = new LoopTrader(loopConfigFromEnv({ LOOP_TRADER: '1', LOOP_CHECKS_PER_MIN: '60' }, () => {}), {
    env, bases: [W], symbolOf: (x) => (x === W ? 'WETH' : 'T' + parseInt(x.slice(-4), 16)), decimalsOf: () => 18,
    canPracticeTest: () => true, canCheckNow: () => canCheck,
    runCheck: async () => ({ status: 'loss', detail: 'x' } as SimResult), log: (m) => logs.push(m),
  });
  clock += 120_000;
  t.onUpdate(pools.map((p) => ({ ...p, lastUpdatedMs: clock })));       // found, line busy
  clock += 1_500; canCheck = true; t.drain();                           // checked 1.5 s later: slow
  await new Promise<void>((r) => setImmediate(r));
  const h = t.takeHour();
  assert(h.checked === 1 && h.checkVsEstimate.n === 1 && h.checkVsEstimate.lossesSlow === 1 && h.checkVsEstimate.medianDelayMs === 1_500, 'trader records the check: slow loss, 1.5 s after found');
  assert(h.checkVsEstimate.medianResultUsd! < 0 && h.checkVsEstimate.medianEstUsd! > 0, 'estimate positive, result counted as minus gas');
  assert(logs.some((l) => l.includes('practice: LOSS (estimate $') && l.includes('found 1.5 s before the check')), 'per-check log line shows estimate, delay and route');
  const txt = formatLoopHour(h, 5);
  assert(/check vs estimate: median estimate \$\d+\.\d\d, median result -\$0\.03, median delay 1\.5 s; losses quick \(<1s\) 0, slow 1/.test(txt), 'hourly block shows the check vs estimate line');
  assert(!txt.includes('—'), 'no em dashes in the report');
  const quiet = formatLoopHour(t.takeHour(), 5);
  assert(!quiet.includes('check vs estimate'), 'no checks this hour: line left out');
}

// ---------------------------------------------------------------------------
// 4) Balance book saved and loaded
// ---------------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), 'v3bal-'));
  const file = join(dir, 'data', 'v3-balances.json');
  let now = 10_000_000;
  const book = new V3BalanceBook(() => now);
  const pool = v3(40, U, W, 1, 10n ** 20n, 500);
  const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
  const n = await book.refresh(async (calls) => calls.map((_, i) => word(BigInt(i + 1) * 10n ** 18n)), [pool]);
  assert(n === 2 && book.get(A(40), W) === 2n * 10n ** 18n, 'refresh read both coins');
  assert(await book.save(file), 'saved');
  assert(existsSync(file) && !existsSync(file + '.tmp'), 'atomic write: real file there, no temp file left');

  now += 30 * 60_000; // restart 30 min later
  const fresh = new V3BalanceBook(() => now);
  assert(fresh.load(file) === 2 && fresh.get(A(40), U) === 1n * 10n ** 18n && fresh.get(A(40), W) === 2n * 10n ** 18n, 'restart 30 min later: balances loaded, thin-pool filter works at once');
  assert(fresh.ageMs() === 30 * 60_000, 'loaded book knows how old its balances are');

  const late = new V3BalanceBook(() => now + 31 * 60_000); // 61 min after the read
  assert(late.load(file) === 0 && late.get(A(40), W) === undefined, 'balances older than 1 hour ignored');

  // Mixed file: one fresh entry, one stale, one broken.
  writeFileSync(file, JSON.stringify({ savedAt: now, entries: [
    [`${A(41)}:${W}`, '7', now - 10 * 60_000],
    [`${A(42)}:${W}`, '8', now - 2 * 60 * 60_000],
    [`${A(43)}:${W}`, 'not-a-number', now],
  ] }));
  const mixed = new V3BalanceBook(() => now);
  assert(mixed.load(file) === 1 && mixed.get(A(41), W) === 7n && mixed.get(A(42), W) === undefined, 'mixed file: fresh kept, stale and broken skipped');
  assert(new V3BalanceBook(() => now).load(join(dir, 'missing.json')) === 0, 'no file yet: loads nothing, no crash');
  writeFileSync(file, '{broken');
  assert(new V3BalanceBook(() => now).load(file) === 0, 'broken file: loads nothing, no crash');
  rmSync(dir, { recursive: true, force: true });
}
}

void checksAndBook().catch((e) => { console.error(`FAIL: ${(e as Error).message}`); process.exitCode = 1; });
