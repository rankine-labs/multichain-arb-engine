import { ethers } from 'ethers';
import {
  hookedFee, setHookedFeeSource, getHookedFeeSource, refreshPoolsBatch, discoverPairPoolsMulticall,
  HOOKED_V4_FEE_ESTIMATE_PIPS, MAX_HOOKED_POOLS_PER_PAIR, MAX_REGISTRY_POOLS, Venue,
} from '../core/pairWatcher';
import {
  ROBINHOOD_VENUES, RobinhoodVenue, isExecutableVenue, isExecutableIn, isPracticeTestableVenue, isPracticeTestableIn,
  canPracticeTestVenue, canPracticeTestIn, reportedVenueIds, venueShortName,
} from '../config/robinhoodVenues';
import { findStandingGaps, feeFraction } from '../core/gapScanner';
import { VenueTally } from '../core/venueTally';
import { formatPlainHourly } from '../core/telegramFormatter';
import { simulateRoundTrip, isV4Hop, SIM_EXECUTOR_ADDRESS } from '../execution/simulator';
import { KIND_V3, KIND_V4, ExecutorHop } from '../execution/executorCalldata';
import { V4_POOL_MANAGER_STORAGE_SLOT, WETH_STORAGE_SLOT } from '../execution/arbExecutorBytecode';
import { PoolState } from '../core/types';

// ============================================================================
// Fables wiring (bot side): the hooked V4 fee source, venue gating, the
// practice simulator's V4 hop handling, per-exchange reporting and memory
// bounds. The contract and the fee predictor themselves are tested elsewhere.
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const abi = ethers.AbiCoder.defaultAbiCoder();
const sel = (sig: string) => ethers.id(sig).slice(0, 10);
const enc = (types: string[], vals: unknown[]) => abi.encode(types, vals);
const ID = '0x' + 'AB'.repeat(32); // mixed case on purpose: the source must get lowercase
const SV = '0x' + '55'.repeat(20), PM = '0x' + '66'.repeat(20), HOOK = '0x' + '99'.repeat(20);

function fablesPool(over: Partial<PoolState> = {}): PoolState {
  return {
    chain: 'robinhood', dex: 'fables', poolAddress: ID, poolType: 'v3',
    tokenA: '0x' + '0a'.repeat(20), tokenB: '0x' + '0b'.repeat(20),
    sqrtPriceX96: 2n ** 96n, liquidity: 10n ** 18n, feeBps: 30, feePips: 3000,
    lastUpdatedBlock: 0, lastUpdatedMs: 0,
    v4: { fee: 0x800000, tickSpacing: 60, native: false, poolManager: PM, stateView: SV, hooks: HOOK },
    ...over,
  };
}

async function main() {
  // --- 1. fee source order -----------------------------------------------------
  setHookedFeeSource(null);
  assert(hookedFee(0n).feePips === HOOKED_V4_FEE_ESTIMATE_PIPS && HOOKED_V4_FEE_ESTIMATE_PIPS === 3000, 'no source, listed fee 0: conservative 3000-pip estimate (unchanged default)');
  assert(hookedFee(900n, ID).feePips === 900, 'no source: the listed LP fee is used when set');
  let seen = '';
  const src = (id: string) => { seen = id; return 350; };
  const f = hookedFee(0n, ID, src);
  assert(f.feePips === 350 && f.feeBps === 4, 'source answer wins (350 pips, feeBps rounded)');
  assert(seen === ID.toLowerCase(), 'source is asked with the lowercase pool id');
  assert(hookedFee(900n, ID, src).feePips === 350, 'source wins over a listed fee too');
  for (const [bad, label] of [[null, 'null'], [0, '0'], [-5, 'negative'], [1_000_000, '100%'], [12.5, 'fraction'], [NaN, 'NaN']] as [number | null, string][]) {
    assert(hookedFee(0n, ID, () => bad).feePips === 3000, `source answer ${label} ignored -> estimate`);
  }
  assert(hookedFee(0n, ID, () => { throw new Error('boom'); }).feePips === 3000, 'a throwing source is ignored');
  assert(hookedFee(0n, undefined, src).feePips === 3000, 'no pool id: source not asked');
  setHookedFeeSource(() => 1200);
  assert(getHookedFeeSource() !== null && hookedFee(0n, ID).feePips === 1200, 'process-wide source used when none is passed');
  assert(hookedFee(0n, ID, () => 700).feePips === 700, 'an explicit source beats the process-wide one');
  setHookedFeeSource(null);
  assert(hookedFee(0n, ID).feePips === 3000, 'clearing the process-wide source restores the estimate');

  // --- 2. refresh path uses the source -----------------------------------------
  const slot0Liq = async (calls: { target: string; data: string }[]) => calls.map((c) =>
    c.data.startsWith(sel('getSlot0(bytes32)')) ? enc(['uint160', 'int24', 'uint24', 'uint24'], [2n ** 96n + 7n, 0, 0, 0]) : enc(['uint128'], [5n]));
  const [r1] = await refreshPoolsBatch(slot0Liq, [fablesPool()], { hookedFeeOf: (id) => (id === ID.toLowerCase() ? 450 : null) });
  assert(r1.feePips === 450 && r1.feeBps === 5 && r1.sqrtPriceX96 === 2n ** 96n + 7n, 'refreshPoolsBatch puts the source fee on the hooked pool (feePips 450)');
  assert(r1.v4?.hooks === HOOK && r1.v4.tickSpacing === 60, 'refresh keeps the pool hooks address and tick spacing');
  const [r2] = await refreshPoolsBatch(slot0Liq, [fablesPool({ feePips: 450, feeBps: 5 })]);
  assert(r2.feePips === 3000, 'refresh with no source falls back to the conservative estimate');
  setHookedFeeSource(() => 2600);
  const [r3] = await refreshPoolsBatch(slot0Liq, [fablesPool()]);
  assert(r3.feePips === 2600, 'refresh picks up the process-wide source (decision-time re-read, cross-quote monitor)');
  setHookedFeeSource(null);

  // --- 3. discovery: source + registry memory bounds ---------------------------
  const A = '0x' + '0a'.repeat(20), B = '0x' + '0b'.repeat(20), C = '0x' + '0c'.repeat(20), W = '0x' + '77'.repeat(20), REG = '0x' + '88'.repeat(20);
  const keyT = 'tuple(tuple(address,address,uint24,int24,address),bytes32,bool)[]';
  const entry = (c0: string, c1: string, i: number) => [[c0, c1, 0x800000, 60, HOOK], ethers.zeroPadValue(ethers.toBeHex(i + 1), 32), true];
  const fakeReg = (entries: unknown[]) => async (calls: { target: string; data: string }[]) => calls.map((c) => {
    if (c.target === REG) return enc([keyT], [entries]);
    if (c.data.startsWith(sel('getSlot0(bytes32)'))) return enc(['uint160', 'int24', 'uint24', 'uint24'], [2n ** 96n, 0, 0, 0]);
    if (c.data.startsWith(sel('getLiquidity(bytes32)'))) return enc(['uint128'], [10n ** 18n]);
    return null;
  });
  const venues: Venue[] = [{ dex: 'fables', kind: 'v4-registry', factory: SV, registry: REG, poolManager: PM, weth: W }];
  // ~65 pools like today, 20 of them on A/B: only MAX_HOOKED_POOLS_PER_PAIR kept.
  const many = Array.from({ length: 65 }, (_, i) => (i < 20 ? entry(A, B, i) : entry(A, C, i)));
  const { pools: d1 } = await discoverPairPoolsMulticall(fakeReg(many), 'robinhood', venues, A, B, [], { hookedFeeOf: () => 800 });
  assert(d1.length === MAX_HOOKED_POOLS_PER_PAIR && MAX_HOOKED_POOLS_PER_PAIR === 8, `at most ${MAX_HOOKED_POOLS_PER_PAIR} hooked pools kept per pair (got ${d1.length} of 20)`);
  assert(d1.every((p) => p.feePips === 800 && p.v4?.hooks?.toLowerCase() === HOOK), 'discovered Fables pools carry the source fee and the hooks address');
  // A registry far bigger than expected: entries past MAX_REGISTRY_POOLS are not looked at.
  const huge = Array.from({ length: MAX_REGISTRY_POOLS + 50 }, (_, i) => (i === MAX_REGISTRY_POOLS + 10 ? entry(A, B, i) : entry(A, C, i)));
  const { pools: d2 } = await discoverPairPoolsMulticall(fakeReg(huge), 'robinhood', venues, A, B);
  assert(d2.length === 0, `registry entries past ${MAX_REGISTRY_POOLS} are ignored (bounded work per lookup)`);

  // --- 4. gap maths uses the exact fee ----------------------------------------
  const v2 = (addr: string, rA: bigint, rB: bigint, feePips?: number): PoolState => ({
    chain: 'robinhood', dex: addr === '0x1' ? 'uniswap-v2' : 'fables', poolAddress: addr, poolType: 'v2', tokenA: A, tokenB: B,
    reserveA: rA, reserveB: rB, feeBps: feePips !== undefined ? Math.round(feePips / 100) : 30, ...(feePips !== undefined ? { feePips } : {}),
    lastUpdatedBlock: 0, lastUpdatedMs: 0,
  });
  const gapOpts = { minProfitUsd: 0, flashFee: 0, gasUsd: 0, maxTradeUsd: 1e6 };
  const dec = () => 18, usd = (t: string) => (t.toLowerCase() === B ? 1 : null);
  const cheap = findStandingGaps([[v2('0x1', 10n ** 24n, 10n ** 24n), v2('0x2', 10n ** 24n, 102n * 10n ** 22n, 350)]], dec, usd, gapOpts);
  const dear = findStandingGaps([[v2('0x1', 10n ** 24n, 10n ** 24n), v2('0x2', 10n ** 24n, 102n * 10n ** 22n, 3000)]], dec, usd, gapOpts);
  assert(cheap.length === 1 && dear.length === 1 && cheap[0].profitUsd > dear[0].profitUsd, `gap profit follows the pool feePips (350 pips $${cheap[0]?.profitUsd.toFixed(0)} > 3000 pips $${dear[0]?.profitUsd.toFixed(0)})`);
  assert(feeFraction(v2('0x1', 1n, 1n)) === 0.003 && feeFraction(fablesPool({ feePips: 350 })) === 0.00035, 'feeFraction: feeBps for plain pools, exact pips when known');

  // --- 5. venue gating ----------------------------------------------------------
  const fables = ROBINHOOD_VENUES.find((v) => v.id === 'fables')!;
  const fExec: false = fables.executionEnabled; // compile-time: the literal type false
  assert(fExec === false && !isExecutableVenue('fables'), 'Fables: real trading refused (executionEnabled is the literal false)');
  assert(!fables.practiceTested && !isPracticeTestableVenue('fables') && !canPracticeTestVenue('fables'), 'Fables stays watch-only until a practiceTested fork run is recorded');
  const withFork: RobinhoodVenue[] = ROBINHOOD_VENUES.map((v) => (v.id === 'fables' ? { ...v, practiceTested: { run: 'https://example.invalid/run', date: '2026-10-10' } } : v));
  assert(isPracticeTestableIn(withFork, 'fables') && canPracticeTestIn(withFork, 'fables'), 'Fables becomes practice-testable once practiceTested is set');
  assert(!isExecutableIn(withFork, 'fables') && withFork.every((v) => v.executionEnabled === false), 'and real trading is still refused after that');
  assert(!canPracticeTestIn(withFork, 'metric') && canPracticeTestIn(withFork, 'uniswap-v3') && canPracticeTestIn(withFork, 'alandale'), 'other venues unchanged by the Fables flag');
  assert(ROBINHOOD_VENUES.every((v) => canPracticeTestVenue(v.id) === (isExecutableVenue(v.id) || isPracticeTestableVenue(v.id))), 'canPracticeTestVenue = executable or practice-tested (same rule shadowMain used)');
  assert(['uniswap-v2', 'uniswap-v3', 'uniswap-v4', 'ramses-v3'].every(canPracticeTestVenue), 'exchanges we already trade stay practice-testable');

  // --- 6. simulator: hooked V4 hop gets V4 switched on ------------------------
  const hookedHop: ExecutorHop = { kind: 4, pool: PM, tokenIn: A, tokenOut: B, feeBps: 0, v4Fee: 0x800000, v4TickSpacing: 60, v4Native: false };
  const v3Hop: ExecutorHop = { kind: KIND_V3, pool: '0x' + '12'.repeat(20), tokenIn: B, tokenOut: A, feeBps: 0, v4Fee: 0, v4TickSpacing: 0, v4Native: false };
  assert(isV4Hop({ ...hookedHop, kind: KIND_V4 }) && isV4Hop(hookedHop) && !isV4Hop(v3Hop), 'isV4Hop: plain V4 kind, or any hop carrying a V4 tick spacing (hooked kind number agnostic)');
  let overrides: any = null;
  const fakeRpc = async (_m: string, p: unknown[]) => {
    overrides = p[2];
    const data = new ethers.Interface(['error InsufficientProfit(uint256 got, uint256 wanted)']).encodeErrorResult('InsufficientProfit', [123n, 2n ** 255n]);
    return { error: { code: 3, message: 'execution reverted', data } };
  };
  const lender = '0x' + '34'.repeat(20);
  const sim = await simulateRoundTrip(fakeRpc, 'robinhood', { token: A, amountIn: 10n ** 18n, hops: [hookedHop, v3Hop] }, { v3Lender: lender, weth: W });
  const diff = overrides?.[SIM_EXECUTOR_ADDRESS]?.stateDiff ?? {};
  const slot = (n: bigint | number) => ethers.zeroPadValue(ethers.toBeHex(n), 32);
  assert(sim.status === 'profit', 'simulated hooked route reports the contract profit');
  assert(diff[slot(V4_POOL_MANAGER_STORAGE_SLOT)]?.toLowerCase() === ethers.zeroPadValue(PM, 32).toLowerCase() && diff[slot(WETH_STORAGE_SLOT)]?.toLowerCase() === ethers.zeroPadValue(W, 32).toLowerCase(),
    'simulated contract gets the PoolManager and WETH for a hooked V4 hop');

  // --- 7. per-exchange report ---------------------------------------------------
  const ids = reportedVenueIds();
  assert(['fables', 'alandale', 'giga-cl', 'up-cl', 'sushiswap-v3'].every((x) => ids.includes(x)), 'report counts Fables, Alandale, GIGA CL, UP and SushiSwap');
  assert(venueShortName('alandale') === 'Alandale' && venueShortName('uniswap-v3') === 'uniswap-v3', 'short names for reports');
  const tally = new VenueTally(ids, venueShortName);
  tally.add('fables', 'uniswap-v3', '2026-10-09', 0.42);
  tally.add('uniswap-v3', 'fables', '2026-10-09');
  tally.add('alandale', 'giga-cl', '2026-10-09', 0.1);
  tally.add('sushiswap-v3', 'sushiswap-v3', '2026-10-09', -1); // same venue both ways: one test, no win
  tally.add('uniswap-v2', 'uniswap-v3', '2026-10-09', 5);      // old exchanges only: not counted
  const fh = tally.hourOf('fables');
  assert(fh.tests === 2 && fh.wins === 1 && Math.abs(fh.winUsd - 0.42) < 1e-9, 'Fables: 2 tests, 1 win $0.42');
  assert(tally.hourOf('alandale').wins === 1 && tally.hourOf('giga-cl').wins === 1, 'a route through two new exchanges counts for both');
  assert(tally.hourOf('sushiswap-v3').tests === 1 && tally.hourOf('sushiswap-v3').wins === 0, 'same exchange both ways counts once; a loss is not a win');
  assert(tally.hourOf('uniswap-v3').tests === 0 && tally.size() === 4, 'exchanges outside the list are never counted (bounded)');
  const txt = tally.hourText() ?? '';
  assert(txt.startsWith('<b>New exchanges') && txt.indexOf('Fables') < txt.indexOf('Alandale') && /Fables 2 tests, 1 win \$0\.42/.test(txt), `hour text, best earner first: ${txt}`);
  assert(tally.statusLine().startsWith('[venues] practice tests by exchange, last hour (today): '), 'status line has the prefix the status page reads');
  tally.resetHour();
  assert(tally.hourOf('fables').tests === 0 && tally.dayOf('fables').tests === 2, 'hour resets, today keeps counting');
  tally.add('up-cl', 'uniswap-v3', '2026-10-10');
  assert(tally.dayOf('fables').tests === 0 && tally.dayOf('up-cl').tests === 1, 'a new day starts today\'s counts again');
  for (let i = 0; i < 10_000; i++) tally.add(`junk-${i}`, ids[i % ids.length], '2026-10-10');
  assert(tally.size() <= ids.length, 'counters stay bounded by the venue list');
  assert(new VenueTally(ids).hourText() === null && /none on the new exchanges yet/.test(new VenueTally(ids).statusLine()), 'nothing tested: no Telegram block, plain status line');
  const base = {
    windowLabel: '05:44 to 06:44', live: false, feedOk: true, feedReconnects: 0, pairs: 60, spots: 276,
    pricesFrom: 'free' as const, freeNodeBusy: 0, differencesFound: 10, checksAvailable: true,
    checks: { done: 0, makeMoney: 0, loseMoney: 0, wouldFail: 0, nodeBusy: 0 },
    earned: { todayChecked: 0, todayCheckedCount: 0, todayUnchecked: 0, todayUncheckedCount: 0, weekChecked: 0 },
    reactionMs: { typical: 5, slowest5pct: 10 }, topDifferences: [],
  };
  assert(formatPlainHourly({ ...base, venueTests: 'VENUE-BLOCK' }).includes('VENUE-BLOCK') && !formatPlainHourly(base).includes('New exchanges'), 'hourly Telegram shows the block only when given');
}
main();
