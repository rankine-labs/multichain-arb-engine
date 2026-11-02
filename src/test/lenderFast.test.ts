import { PoolCache } from '../core/poolCache';
import type { PoolState, ChainName } from '../core/types';
import { lenderCandidatesOld, lenderCandidatesFor, parseApprovedLenders, lenderFastOn } from '../core/lenderPick';
import { groupsStartupPlan } from '../core/groupsStartup';
import { pickV3Lender } from '../execution/executorCalldata';

// ============================================================================
// FREEZE FIX 9 (Nov 1): proves the two changes keep every RESULT the same,
// and times the lender pick (TEST numbers: the server is a different machine).
//   1. LENDER FAST: the lender pick from the small list (approved addresses
//      looked up, or pools holding the coin) is the SAME pool as the pick
//      from the old full copy, over thousands of random cache states,
//      including pools re-added, re-tokened and pruned (order changes).
//   2. Same thing with the pool index off (POOL_INDEX=0 path).
//   3. Switches: LENDER_FAST=0 and GROUPS_FRESH_SKIP=0 give the old way.
//   4. GROUPS FRESH SKIP: when a restart rebuilds the coin groups.
//   5. Timing: the new pick is much faster on a 30,000-pool cache.
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// Small deterministic random numbers (same run every time).
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pickOf = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const hex40 = (n: number) => '0x' + n.toString(16).padStart(40, '0');
// Mixed-case spelling of an address (the cache keys are lower-case; the pool keeps its own spelling).
const mixed = (a: string) => '0x' + [...a.slice(2)].map((c) => (rnd() < 0.5 ? c.toUpperCase() : c)).join('');

const CHAIN: ChainName = 'robinhood';
const DEXES = ['uniswap-v3', 'pancakeswap-v3', 'ramses-v3', 'uniswap-v2', 'aerodrome'];
const TOKENS = Array.from({ length: 12 }, (_, i) => hex40(0xa000 + i));

function randomPool(addr: string, chain: ChainName = CHAIN): PoolState {
  const v3 = rnd() < 0.7;
  return {
    chain, dex: pickOf(DEXES), poolAddress: rnd() < 0.3 ? mixed(addr) : addr,
    poolType: v3 ? 'v3' : 'v2',
    tokenA: rnd() < 0.3 ? mixed(pickOf(TOKENS)) : pickOf(TOKENS), tokenB: pickOf(TOKENS),
    // Few fee / liquidity values so ties (where order decides) really happen.
    feeBps: pickOf([1, 5, 30]), liquidity: pickOf([0n, 10n, 10n, 500n, 500n]),
    lastUpdatedBlock: 1, lastUpdatedMs: 1_000,
  } as PoolState;
}

// The lender the bot would pick, from a candidate list (as pickLender does).
const pickFrom = (cands: PoolState[], token: string, exclude: string[], canLend?: (p: string, t: string) => boolean) => {
  const p = pickV3Lender(cands, token, exclude, canLend);
  return p ? `${p.poolAddress}|${p.dex}|${p.feeBps}|${p.liquidity}` : 'none';
};
// The candidate list narrowed to what pickV3Lender can look at (token holders), in order.
const holders = (cands: PoolState[], token: string) =>
  cands.filter((p) => p.tokenA.toLowerCase() === token || p.tokenB.toLowerCase() === token).map((p) => p.poolAddress).join(',');

function sameResultsTest(indexed: boolean) {
  const label = indexed ? 'index on' : 'index off (POOL_INDEX=0)';
  let picks = 0, mismatches = 0, listMismatches = 0, withLender = 0, listCases = 0, fullMismatches = 0, ordered = 0;
  for (let round = 0; round < 60; round++) {
    const cache = new PoolCache({ index: indexed, confirmed: false });
    const addrs = Array.from({ length: 80 }, (_, i) => hex40(0x100000 + round * 1000 + i));
    // Build the cache with all kinds of writes, then shuffle its order:
    // token changes (re-indexed at the end), prunes, re-adds, other chains.
    for (let step = 0; step < 400; step++) {
      const a = pickOf(addrs);
      const r = rnd();
      if (r < 0.35) cache.upsert(randomPool(a));
      else if (r < 0.55) { const cur = cache.get(CHAIN, a); if (cur) cache.upsertFromFeed({ ...cur, liquidity: pickOf([0n, 10n, 500n]) }); else cache.upsertFromFeed(randomPool(a)); }
      else if (r < 0.7) { const cur = cache.get(CHAIN, a); cache.upsertFromBlock(cur ? { ...cur, tokenB: pickOf(TOKENS) } : randomPool(a)); }
      else if (r < 0.8) cache.upsert(randomPool(a, 'monad'));
      else if (r < 0.85) cache.prune(() => rnd() < 0.85, 1, Date.now() + 1e9); // drop ~15% of pools
      else cache.upsertIfNotNewer(randomPool(a), 0, 10_000_000);
    }
    for (let q = 0; q < 40; q++) {
      // Approved list: none, a few cached ones, some not cached, odd spellings.
      const mode = rnd();
      const listText = mode < 0.3 ? '' : Array.from({ length: 1 + Math.floor(rnd() * 40) }, () => (rnd() < 0.8 ? (rnd() < 0.3 ? ` ${mixed(pickOf(addrs))} ` : pickOf(addrs)) : hex40(0xdead00 + q))).join(',') + (rnd() < 0.2 ? ',,' : '');
      const approved = parseApprovedLenders({ FLASH_LENDERS_ROBINHOOD: listText }, CHAIN);
      const liveNoList = rnd() < 0.3;
      const token = pickOf(TOKENS);
      const exclude = [pickOf(addrs), rnd() < 0.5 ? mixed(pickOf(addrs)) : pickOf(addrs)];
      const canLend = rnd() < 0.5 ? undefined : (p: string) => p.toLowerCase().charCodeAt(p.length - 1) % 3 !== 0;
      const oldC = lenderCandidatesOld(cache, CHAIN, approved, liveNoList);
      const newC = lenderCandidatesFor(cache, CHAIN, token, approved, liveNoList);
      const a = pickFrom(oldC, token, exclude, canLend), b = pickFrom(newC, token, exclude, canLend);
      picks++;
      if (a !== 'none') withLender++;
      if (a !== b) { mismatches++; if (mismatches < 4) console.error(`  mismatch (${label}): old ${a} new ${b}`); }
      if (holders(oldC, token) !== holders(newC, token)) listMismatches++;
      // With a list, the new list is the old list itself (same pools, same order).
      if (approved.size) { listCases++; if (oldC.map((p) => p.poolAddress).join(',') !== newC.map((p) => p.poolAddress).join(',')) fullMismatches++; else if (newC.length > 1) ordered++; }
    }
  }
  assert(mismatches === 0, `LENDER FAST (${label}): same lender as the old code in all ${picks} picks (${withLender} with a lender, rest none)`);
  assert(listMismatches === 0, `LENDER FAST (${label}): same lender pools holding the coin, in the same order, in all ${picks} cases`);
  assert(fullMismatches === 0 && ordered > 100, `LENDER FAST (${label}): with an approved list, exactly the old list in the old order in all ${listCases} cases (${ordered} with 2+ pools)`);
}

function switchesTest() {
  assert(lenderFastOn({}) === true && lenderFastOn({ LENDER_FAST: '1' }) === true, 'LENDER_FAST: on by default');
  assert(lenderFastOn({ LENDER_FAST: '0' }) === false && lenderFastOn({ LENDER_FAST: ' 0 ' }) === false, 'LENDER_FAST=0: old way');
  const s = parseApprovedLenders({ FLASH_LENDERS_ROBINHOOD: ' 0xAbC ,, 0xdef,0xabc ' }, 'robinhood');
  assert(JSON.stringify([...s]) === JSON.stringify(['0xabc', '0xdef']), 'approved list read exactly as before (trim, lower-case, blanks dropped)');
  assert(parseApprovedLenders({}, 'monad').size === 0, 'no list set: empty');
}

function groupsTest() {
  const H = 3600_000, EVERY = 6 * H, now = 100 * H;
  const fresh = groupsStartupPlan(now - 20 * 60_000, now, EVERY, {});
  assert(!fresh.rebuildNow && fresh.laterMs === EVERY - 20 * 60_000, 'groups: 20-min-old saved list kept, rebuild when it turns 6 h old');
  const almost = groupsStartupPlan(now - EVERY + 60_000, now, EVERY, {});
  assert(!almost.rebuildNow && almost.laterMs === 3 * 60_000 + 30_000, 'groups: rebuild never booked before the first setup (3 min)');
  assert(groupsStartupPlan(now - EVERY, now, EVERY, {}).rebuildNow, 'groups: 6 h old list: rebuild right away (old way)');
  assert(groupsStartupPlan(now + H, now, EVERY, {}).rebuildNow, 'groups: future-dated list: rebuild right away');
  assert(groupsStartupPlan(undefined, now, EVERY, {}).rebuildNow && groupsStartupPlan(NaN, now, EVERY, {}).rebuildNow, 'groups: list with no time: rebuild right away');
  assert(groupsStartupPlan(now - 60_000, now, EVERY, { GROUPS_FRESH_SKIP: '0' }).rebuildNow, 'GROUPS_FRESH_SKIP=0: always rebuild after a restart (old way)');
}

function timingTest() {
  // A server-sized cache: 30,000 pools, 6 approved lenders (the live layout).
  const cache = new PoolCache({ index: true, confirmed: false });
  const lenders: string[] = [];
  for (let i = 0; i < 30_000; i++) {
    const a = hex40(0x500000 + i);
    cache.upsert({ chain: CHAIN, dex: i % 3 ? 'uniswap-v2' : 'uniswap-v3', poolAddress: a, poolType: i % 3 ? 'v2' : 'v3', tokenA: TOKENS[i % 2], tokenB: hex40(0x900000 + i), feeBps: 30, liquidity: 10n, lastUpdatedBlock: 1, lastUpdatedMs: 1 } as PoolState);
    if (i % 5000 === 0) lenders.push(a);
  }
  const approved = new Set(lenders);
  const token = TOKENS[0];
  const N = 400;
  const run = (f: () => PoolState[]) => { const t = performance.now(); let x = 0; for (let i = 0; i < N; i++) x += pickV3Lender(f(), token, []) ? 1 : 0; return { ms: performance.now() - t, x }; };
  run(() => lenderCandidatesOld(cache, CHAIN, approved, false)); // warm up
  const old = run(() => lenderCandidatesOld(cache, CHAIN, approved, false));
  const neu = run(() => lenderCandidatesFor(cache, CHAIN, token, approved, false));
  console.log(`  TEST numbers: ${N} lender picks on 30,000 pools: old ${old.ms.toFixed(1)} ms (${(old.ms / N).toFixed(3)} ms each), new ${neu.ms.toFixed(2)} ms (${(neu.ms / N * 1000).toFixed(1)} us each), ${(old.ms / Math.max(neu.ms, 0.001)).toFixed(0)}x`);
  assert(old.x === neu.x, 'timing run: same picks');
  assert(neu.ms * 20 < old.ms, 'LENDER FAST: lender pick at least 20x faster on a 30,000-pool cache');
}

sameResultsTest(true);
sameResultsTest(false);
switchesTest();
groupsTest();
timingTest();
