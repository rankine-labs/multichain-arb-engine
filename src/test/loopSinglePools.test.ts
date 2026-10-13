// Tests for the loop trader's extra single pools (core/loopExtraPools.ts):
//   - selection: only single pools with $10k+ that can sit on a 3-5 pool loop
//     through WETH/USDG; the cap; rival-route pools first, then the deepest
//   - which scan pools get a look (rival, on-map, bridge coins)
//   - off switch: with LOOP_TRADER unset nothing is created and the block
//     reader / gap scan wiring is exactly as before
//   - extra pools never reach the gap scanner (never in the pair watcher's
//     watch list; a pair with 2+ pools is never written by the lookup)
//   - the loop finder finds a loop that needs a single-pool step once that
//     pool is fresh, and the re-read never overwrites newer block data
import { readFileSync } from 'fs';
import { join } from 'path';
import { ethers } from 'ethers';
import {
  selectLoopPools, pickScanCandidates, loopExtraConfigFromEnv, readerAddresses, afterReaderWrite,
  coalesceCallMany, LoopExtraPools, LoopExtraDeps, CallMany,
} from '../core/loopExtraPools';
import { LoopTrader, loopConfigFromEnv } from '../core/loopTrader';
import { formatLoopHour } from '../core/loopReport';
import { PoolCache } from '../core/poolCache';
import { PairWatcher, Venue } from '../core/pairWatcher';
import type { PoolState } from '../core/types';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const A = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const W = A(1), USDG = A(2), DJT = A(3), PONS = A(4), DEAD = A(5), GME = A(6), TINY = A(7), TWO = A(8);
let clock = 10_000_000;

// A V2 pool (0.30% fee), reserves in whole tokens (18 decimals).
function v2(addr: number, tA: string, tB: string, rA: number, rB: number, updated = clock): PoolState {
  return { chain: 'robinhood', dex: 'uniswap-v2', poolAddress: A(addr), poolType: 'v2', tokenA: tA, tokenB: tB,
    reserveA: BigInt(Math.round(rA * 1e6)) * 10n ** 12n, reserveB: BigInt(Math.round(rB * 1e6)) * 10n ** 12n,
    feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: updated };
}

// Watched pairs (2 pools each): WETH/DJT and USDG/WETH.
const watched = [v2(100, W, DJT, 1_000, 2_000), v2(101, W, DJT, 1_000, 2_000), v2(102, USDG, W, 1_300, 1_000), v2(103, USDG, W, 1_300, 1_000)];
// Single pools (depth in $ by pool number).
const depthOf: Record<number, number> = { 100: 1e6, 101: 1e6, 102: 1e6, 103: 1e6, 200: 60_000, 201: 50_000, 202: 90_000, 203: 20_000, 204: 30_000, 205: 5_000, 206: 80_000, 207: 70_000, 208: 70_000, 209: 70_000 };
const s = {
  djtPons: v2(200, DJT, PONS, 2_000, 2_000),   // WETH -> DJT -> PONS -> USDG -> WETH (4 pools)
  ponsUsdg: v2(201, PONS, USDG, 2_000, 2_000),
  deadEnd: v2(202, DEAD, W, 1_000, 1_000),      // DEAD has no other pool: can't be on a loop
  gmeDjt: v2(203, GME, DJT, 1_000, 1_000),      // WETH -> DJT -> GME -> USDG -> WETH
  gmeUsdg: v2(204, GME, USDG, 1_000, 1_000),
  tinyDjt: v2(205, TINY, DJT, 10, 10),          // only $5k: too shallow
  tinyUsdg: v2(206, TINY, USDG, 1_000, 1_000),  // deep, but TINY is reachable only through the shallow pool
  twoA: v2(207, TWO, DJT, 1_000, 1_000),        // TWO/DJT sits on 2 pools: the pair watcher's job, not ours
  twoB: v2(208, TWO, DJT, 1_000, 1_000),
  twoUsdg: v2(209, TWO, USDG, 1_000, 1_000),
};
const others = Object.values(s);
const depthUsd = (p: PoolState) => depthOf[parseInt(p.poolAddress.slice(-6), 16)] ?? null;
const keyOf = (p: PoolState) => p.poolAddress.toLowerCase();
const picked = (out: { selected: PoolState[] }) => new Set(out.selected.map(keyOf));
const baseSel = { bases: [W, USDG], loopMaxPools: 5, cap: 300, minDepthUsd: 10_000, watched, others, depthUsd };

// ---------------------------------------------------------------------------
// 1) Selection: reach, depth, cap, priority
// ---------------------------------------------------------------------------
{
  const out = selectLoopPools(baseSel);
  const k = picked(out);
  assert(k.has(keyOf(s.djtPons)) && k.has(keyOf(s.ponsUsdg)), 'DJT/PONS and PONS/USDG picked (4-pool loop through WETH/USDG, two single steps in a row)');
  assert(k.has(keyOf(s.gmeDjt)) && k.has(keyOf(s.gmeUsdg)), 'GME/DJT and GME/USDG picked');
  assert(!k.has(keyOf(s.deadEnd)), 'dead-end coin (DEAD/WETH, no way back) not picked, even though it is deep');
  assert(!k.has(keyOf(s.tinyDjt)), 'pool under POOL_MIN_DEPTH_USD ($5k) not picked');
  assert(!k.has(keyOf(s.tinyUsdg)), 'deep pool whose coin is only reachable through a shallow pool not picked');
  assert(!k.has(keyOf(s.twoA)) && !k.has(keyOf(s.twoB)), 'pair with 2 pools is left to the pair watcher');
  assert(!k.has(keyOf(s.twoUsdg)), 'pool reachable only through a 2-pool pair (not on our map) not picked');
  assert(watched.every((p) => !k.has(keyOf(p))), 'watched pools are never extra pools');
  assert(out.selected.length === 4 && out.reachable === 4, `exactly 4 picked (${out.selected.length})`);

  // Loop length: with LOOP_MAX_POOLS=3 the 4-pool loops don't fit.
  const three = selectLoopPools({ ...baseSel, loopMaxPools: 3 });
  assert(three.selected.length === 0, 'LOOP_MAX_POOLS=3: 4-pool-only pools not picked');
  // A direct DJT/USDG single pool fits a 3-pool loop (WETH -> DJT -> USDG -> WETH).
  const direct = v2(210, DJT, USDG, 1_000, 1_000);
  depthOf[210] = 40_000;
  const d3 = selectLoopPools({ ...baseSel, loopMaxPools: 3, others: [...others, direct] });
  const k3 = picked(d3);
  // DJT/USDG makes WETH -> DJT -> USDG -> WETH, and also gives DJT/PONS + PONS/USDG
  // (USDG -> DJT -> PONS -> USDG) and the GME pair a 3-pool loop through USDG.
  assert(k3.has(keyOf(direct)) && k3.has(keyOf(s.djtPons)) && k3.has(keyOf(s.gmeUsdg)) && !k3.has(keyOf(s.deadEnd)) && d3.selected.length === 5, `LOOP_MAX_POOLS=3: 3-pool-loop single pools picked (${d3.selected.length})`);

  // Cap: deepest first.
  const cap2 = selectLoopPools({ ...baseSel, cap: 2 });
  assert(cap2.selected.length === 2 && keyOf(cap2.selected[0]) === keyOf(s.djtPons) && keyOf(cap2.selected[1]) === keyOf(s.ponsUsdg), 'cap 2: the two deepest ($60k, $50k)');
  // Priority: a pool from a rival loop route first, then pools on rival coins, before deeper ones.
  const riv = selectLoopPools({ ...baseSel, cap: 2, rivalPools: new Set([keyOf(s.gmeUsdg)]) });
  assert(keyOf(riv.selected[0]) === keyOf(s.gmeUsdg) && keyOf(riv.selected[1]) === keyOf(s.gmeDjt) && riv.rivalPicked === 1,
    'cap 2 with a rival route pool: rival pool first, then the pool on the rival coin (GME), ahead of deeper DJT/PONS');
  // The chain-wide scan saw 2 pools for DJT/PONS: not a single pair.
  const scan2 = selectLoopPools({ ...baseSel, scanPairCount: (pk) => (pk === [DJT, PONS].map((x) => x.toLowerCase()).sort().join('/') ? 2 : 1) });
  assert(!picked(scan2).has(keyOf(s.djtPons)), 'pair the scan saw on 2 pools is not picked');
  // Pools without exact maths (order books) are never picked.
  const ob = selectLoopPools({ ...baseSel, others: others.map((p) => (p === s.gmeDjt ? { ...p, dex: 'kuru' } : p)) });
  assert(!picked(ob).has(keyOf(s.gmeDjt)), 'pool with no exact maths (order book) not picked');
}

// ---------------------------------------------------------------------------
// 2) Which scan pools get a look
// ---------------------------------------------------------------------------
{
  const RIV = A(20), ZZZ = A(21);
  const scan = [
    { pool: A(300), token0: DJT, token1: PONS },   // PONS off the map, joins DJT and USDG: tier 2
    { pool: A(301), token0: PONS, token1: USDG },
    { pool: A(302), token0: DJT, token1: USDG },   // both on the map, fits: tier 1
    { pool: A(303), token0: DEAD, token1: W },     // DEAD off the map with one neighbour: no
    { pool: A(304), token0: W, token1: DJT },      // pair already known: no
    { pool: A(305), token0: RIV, token1: ZZZ },    // rival route pool: tier 0
    { pool: A(306), token0: GME, token1: USDG }, { pool: A(307), token0: GME, token1: USDG }, // 2 pools in the scan: no
  ];
  const known = new Set([[W, DJT].sort().join('/'), [USDG, W].sort().join('/')].map((k) => k.toLowerCase()));
  const c = pickScanCandidates({ bases: [W, USDG], loopMaxPools: 5, scanPools: scan, graphPools: watched, knownPairs: known, skip: () => false, rivalPools: new Set([A(305)]), max: 100 });
  const order = c.map((x) => x.pool);
  assert(order[0] === A(305) && c[0].tier === 0, 'scan pick: rival route pool first');
  assert(order[1] === A(302) && c[1].tier === 1, 'scan pick: pool with both coins on our map next');
  assert(order.includes(A(300)) && order.includes(A(301)) && c.filter((x) => x.tier === 2).length === 2, 'scan pick: both pools of a bridge coin (PONS between DJT and USDG)');
  assert(!order.includes(A(303)) && !order.includes(A(304)) && !order.includes(A(306)), 'scan pick: dead end, known pair and 2-pool pair skipped');
  const skipped = pickScanCandidates({ bases: [W, USDG], loopMaxPools: 5, scanPools: scan, graphPools: watched, knownPairs: known, skip: (p) => p === A(302).toLowerCase(), max: 100 });
  assert(!skipped.some((x) => x.pool === A(302)), 'scan pick: pools looked at recently are skipped');
}

// ---------------------------------------------------------------------------
// 3) Off switch: LOOP_TRADER unset = nothing changes
// ---------------------------------------------------------------------------
{
  const cfgOf = (env: Record<string, string>) => loopExtraConfigFromEnv(env, loopConfigFromEnv(env), 10_000);
  assert(!cfgOf({}).enabled, 'LOOP_TRADER unset: extra pools off');
  assert(!cfgOf({ LOOP_EXTRA_POOLS: '1' }).enabled, 'LOOP_TRADER unset + LOOP_EXTRA_POOLS=1: still off');
  assert(cfgOf({ LOOP_TRADER: '1' }).enabled, 'LOOP_TRADER=1: extra pools on by default');
  assert(!cfgOf({ LOOP_TRADER: '1', LOOP_EXTRA_POOLS: '0' }).enabled, 'LOOP_EXTRA_POOLS=0 forces off');
  const c = cfgOf({ LOOP_TRADER: '1' });
  assert(c.maxSelected === 300 && c.refreshMs === 20_000 && c.rebuildMs === 600_000 && c.minDepthUsd === 10_000 && c.loopMaxPools === 5, 'defaults: 300 pools, 20 s re-read, 10 min rebuild, $10k, 5 pools');
  assert(cfgOf({ LOOP_TRADER: '1', LOOP_EXTRA_POOLS_MAX: '99999' }).maxSelected === 2_000, 'LOOP_EXTRA_POOLS_MAX capped at 2,000');
  // Wiring with extra pools off (null): block reader list and post-write action exactly as before.
  const list = ['0xaa', '0xbb'];
  assert(readerAddresses(list, null) === list, 'off: block reader pool list is the watched list itself');
  assert(afterReaderWrite(['0xaa'], null, () => new Set()) === 'gap' && afterReaderWrite([], null, () => new Set()) === 'none', 'off: any price write runs the gap scan, as before');
  const h = new LoopTrader(loopConfigFromEnv({ LOOP_TRADER: '1' }), { env: { decimalsOf: () => 18, usdOf: () => 1, depthUsd: () => 1e6, gasUsd: () => 0, isTradable: () => true, now: () => clock }, bases: [W], symbolOf: () => 'X', decimalsOf: () => 18, canPracticeTest: () => true, canCheckNow: () => false, runCheck: async () => ({ status: 'loss' } as any) }).takeHour();
  assert(!formatLoopHour(h, 5).includes('extra single pools'), 'off: hourly block unchanged (no extra pools line)');
  assert(formatLoopHour(h, 5, { fresh: 7, selected: 9 }).includes('extra single pools watched: 9'), 'on: hourly block shows "extra single pools watched: N"');
  // shadowMain only ever creates the keeper inside the enabled check.
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'shadowMain.ts'), 'utf8');
  const at = src.indexOf('new LoopExtraPools(');
  assert(src.split('new LoopExtraPools(').length === 2 && src.lastIndexOf('if (loopExtraCfg.enabled) {', at) > src.lastIndexOf('\n      }', at), 'shadowMain: extra pools created only inside "if (loopExtraCfg.enabled)"');
}

// ---------------------------------------------------------------------------
// 4) Extra pools never reach the gap scanner
// ---------------------------------------------------------------------------
const iF = new ethers.Interface(['function getPair(address,address) view returns (address)']);
const iP = new ethers.Interface(['function getReserves() view returns (uint112,uint112,uint32)', 'function token0() view returns (address)', 'function token1() view returns (address)']);
const iM = new ethers.Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
const coder = ethers.AbiCoder.defaultAbiCoder();
// A fake node: factories answer getPair with a pool; pools answer reserves/tokens; tokens answer meta.
function fakeNode(pairs: Record<string, string>, tokens: [string, string]): CallMany & { requests: number } {
  const fn = (async (calls: { target: string; data: string }[]) => {
    fn.requests++;
    return calls.map((c) => {
      const sel = c.data.slice(0, 10);
      if (sel === iF.getFunction('getPair')!.selector) return pairs[c.target.toLowerCase()] ? coder.encode(['address'], [pairs[c.target.toLowerCase()]]) : coder.encode(['address'], [ethers.ZeroAddress]);
      if (sel === iP.getFunction('getReserves')!.selector) return coder.encode(['uint112', 'uint112', 'uint32'], [10n ** 21n, 2n * 10n ** 21n, 0]);
      if (sel === iP.getFunction('token0')!.selector) return coder.encode(['address'], [tokens[0]]);
      if (sel === iP.getFunction('token1')!.selector) return coder.encode(['address'], [tokens[1]]);
      if (sel === iM.getFunction('symbol')!.selector) return iM.encodeFunctionResult('symbol', ['TKN']);
      if (sel === iM.getFunction('decimals')!.selector) return iM.encodeFunctionResult('decimals', [18]);
      return null;
    });
  }) as CallMany & { requests: number };
  fn.requests = 0;
  return fn;
}
(async () => {
  {
    const F1 = A(900), F2 = A(901), P1 = ethers.getAddress(A(910)), P2 = ethers.getAddress(A(911));
    const venues: Venue[] = [{ dex: 'uniswap-v2', kind: 'v2', factory: F1, feeBps: 30 }, { dex: 'pancake-v2', kind: 'v2', factory: F2, feeBps: 25 }];
    const cache = new PoolCache();
    const pw = new PairWatcher('robinhood', null as any, venues, cache, () => {});
    const one = await pw.lookupPair(DJT, PONS, fakeNode({ [F1.toLowerCase()]: P1 }, [DJT, PONS]));
    assert(one.length === 1 && !!cache.get('robinhood', P1), 'lookupPair: a true single pool is written to the cache');
    assert(pw.watchedPairPools().length === 0 && pw.stats().pairs === 0, 'lookupPair: the pair is NOT added to the watch list (gap scanner never sees it)');
    const two = await pw.lookupPair(GME, USDG, fakeNode({ [F1.toLowerCase()]: P1, [F2.toLowerCase()]: P2 }, [GME, USDG]));
    assert(two.length === 0 && !cache.get('robinhood', P2), 'lookupPair: a pair found on 2 pools is not written at all (left to the pair watcher)');
    // Bundling: lookups started together share requests.
    let n = 0;
    const counting: CallMany = async (calls) => { n++; return calls.map(() => null); };
    const b = coalesceCallMany(counting);
    const res = await Promise.all([b([{ target: A(1), data: '0x01' }]), b([{ target: A(2), data: '0x02' }, { target: A(3), data: '0x03' }])]);
    assert(n === 1 && res[0].length === 1 && res[1].length === 2, 'bundling: two lookups in the same moment = one node request');
  }

  // ---------------------------------------------------------------------------
  // 5) End to end: keeper + loop trader
  // ---------------------------------------------------------------------------
  {
    const cache = new PoolCache();
    for (const p of watched) cache.upsert({ ...p, lastUpdatedMs: clock });
    // Single pools in the cache but never refreshed (10 minutes old): today's situation.
    const stale = clock - 10 * 60_000;
    cache.upsert({ ...s.djtPons, lastUpdatedMs: stale });
    cache.upsert({ ...s.ponsUsdg, lastUpdatedMs: stale });
    const watchedLists = [[A(100), A(101)], [A(102), A(103)]];
    let reads = 0;
    const deps: LoopExtraDeps = {
      bases: [W, USDG],
      getPool: (k) => cache.get('robinhood', k),
      cachePools: () => cache.allForChain('robinhood'),
      watchedPools: () => watchedLists,
      scanPools: () => [],
      depthUsd: () => 1e6,
      usdOf: () => 1,
      decimalsOf: () => 18,
      rivalPools: () => new Set(),
      callMany: async (calls) => calls.map(() => null),
      lookupPair: async () => [],
      // The bundled read: returns the same prices, read "now".
      readStates: async (pools) => { reads++; return pools.map((p) => ({ ...p, lastUpdatedMs: clock })); },
      writeState: (fresh, started) => cache.upsertIfNotNewer(fresh, started, clock),
      now: () => clock,
    };
    const cfg = loopExtraConfigFromEnv({ LOOP_TRADER: '1' }, loopConfigFromEnv({ LOOP_TRADER: '1' }), 10_000);
    const extra = new LoopExtraPools(cfg, deps);
    const trader = new LoopTrader(loopConfigFromEnv({ LOOP_TRADER: '1', LOOP_CHECKS_PER_MIN: '0' }), {
      env: { decimalsOf: () => 18, usdOf: (t) => (t === W || t === USDG ? 1 : null), depthUsd: () => 1e6, gasUsd: (h) => 0.01 * h, isTradable: () => true, now: () => clock },
      bases: [W, USDG], symbolOf: (t) => ({ [W]: 'WETH', [USDG]: 'USDG', [DJT]: 'DJT', [PONS]: 'PONS' } as Record<string, string>)[t] ?? '?', decimalsOf: () => 18,
      canPracticeTest: () => true, canCheckNow: () => false, runCheck: async () => ({ status: 'loss' } as any),
    });
    const loopPools = () => [...watchedLists.flat().map((k) => cache.get('robinhood', k)!), ...extra.freshPools(trader.cfg.maxPoolAgeMs)];
    const usesPons = (rs: { cycle: { tokens: string[] } }[] | undefined) => (rs ?? []).some((r) => r.cycle.tokens.includes(PONS));
    const before = trader.onUpdate(loopPools());
    assert(!usesPons(before), 'before: no loop through PONS (single pools not fresh)');
    // Even if the stale single pools were handed over, the age rule leaves them out.
    clock += 5_001;
    const staleTry = trader.onUpdate([...loopPools(), cache.get('robinhood', s.djtPons.poolAddress)!, cache.get('robinhood', s.ponsUsdg.poolAddress)!]);
    assert(!usesPons(staleTry), 'stale single pools are left out by LOOP_MAX_POOL_AGE_MS');

    const ok = await extra.rebuild('test', true);
    assert(ok && extra.has(s.djtPons.poolAddress) && extra.has(s.ponsUsdg.poolAddress) && extra.size() === 2, 'keeper picks DJT/PONS and PONS/USDG');
    assert(reads === 1 && extra.status(30_000).fresh === 2, 'first pick: one bundled initial read, both now fresh');
    assert(extra.addresses().length === 2 && extra.statusText(30_000) === 'loop extra pools: 2 fresh / 2 selected', 'block reader list + status line');
    assert(JSON.stringify(watchedLists) === JSON.stringify([[A(100), A(101)], [A(102), A(103)]]), 'watch list (the gap scanner\'s pools) unchanged');
    // Block reader: an update on an extra pool runs the loop scan only; a watched one runs the gap scan.
    const wset = () => new Set(watchedLists.flat().map((k) => k.toLowerCase()));
    assert(afterReaderWrite([s.djtPons.poolAddress.toLowerCase()], extra, wset) === 'loop', 'reader write on an extra pool: loop scan only, gap scan not triggered');
    assert(afterReaderWrite([s.djtPons.poolAddress.toLowerCase(), A(100)], extra, wset) === 'gap', 'reader write on a watched pool: gap scan as before');
    assert(readerAddresses([A(100)], extra).length === 3, 'block reader list = watched + extra');

    clock += 5_001; // the loop list is rebuilt at most every 5 s when pools join
    const after = trader.onUpdate(loopPools());
    const hit = (after ?? []).find((r) => r.cycle.tokens.includes(PONS));
    assert(!!hit && hit.cycle.hops.length === 4 && hit.netUsd > 0, `after: loop through the single-pool step found (${hit ? trader.finder.cycleById(hit.cycle.id)?.tokens.length + ' coins' : 'none'})`);

    // The re-read never overwrites newer block-reader data.
    const newer = { ...cache.get('robinhood', s.djtPons.poolAddress)!, reserveA: 123n, reserveB: 456n, lastUpdatedBlock: 9 };
    cache.upsertFromBlock(newer, clock + 1);
    await extra.refresh();
    assert(cache.get('robinhood', s.djtPons.poolAddress)!.reserveA === 123n, 're-read started before a block-reader write does not overwrite it');
    // Quiet pools stay fresh through the re-read.
    clock += 25_000;
    await extra.refresh();
    assert(extra.status(30_000).fresh === 2, 'quiet pools stay fresh through the 20 s re-read');
    // Rebuild rate limit: not twice within a minute unless forced (e.g. after a scan).
    assert(!(await extra.rebuild('scan')), 'rebuild not repeated within a minute');
    // A pool that becomes part of a watched pair later drops out of the extras on the next pick.
    watchedLists.push([A(200), A(299)]);
    clock += 61_000;
    await extra.rebuild('timer');
    assert(!extra.has(s.djtPons.poolAddress), 'pool of a now-watched pair is dropped from the extras');
  }
})();
