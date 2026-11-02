import { buildTrackList, copy2PoolOf } from '../execution/copy2';
import { v4KeyMatchesId, v4KeyMatchesIdMemo } from '../execution/executorCalldata';
import type { PoolState } from '../core/types';
import { mixedPools, registryAnswer, REG_WETH } from './fix11Pools';
import { discoverPairPoolsMulticall, registryList, Venue } from '../core/pairWatcher';

// ============================================================================
// FIX 11 (Nov 2): the freeze namer showed the biggest unnamed freeze was copy
// 2's track list: every 5 s it checks every watched V4 pool's key with an
// ethers ABI encode + keccak (3.6 s of freezes in 10 min, up to 242 ms).
// The answer is now remembered per pool key. This file proves the ANSWERS
// are identical with the memo on and off (COPY2_V4_KEY_MEMO=0 = old way).
// Second fix: the hooked-V4 registry answer is decoded once per answer
// text (PAIR_REGISTRY_MEMO=0 = old way); pair lookups give identical pools.
// The speed comparison is in fix11Speed.test.ts (skipped on the server).
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';

function main() {
  const pools = mixedPools(400);
  // 1. Each pool: memo answer = direct answer, asked twice (miss then hit).
  let same = 0, trues = 0;
  for (const p of pools) {
    const d = v4KeyMatchesId(p), m1 = v4KeyMatchesIdMemo(p), m2 = v4KeyMatchesIdMemo(p);
    if (d === m1 && d === m2) same++;
    if (d) trues++;
  }
  assert(same === pools.length, `memo answer = direct answer for all ${pools.length} pools (miss and hit)`);
  assert(trues > 50 && trues < pools.length, `the mix has both matching (${trues}) and non-matching keys`);

  // 2. A pool changed in place (fee edited) gets a fresh answer, not the old one.
  const p = { ...pools[0], v4: { ...(pools[0] as any).v4 } } as PoolState;
  const before = v4KeyMatchesIdMemo(p);
  (p as any).v4.fee = (p as any).v4.fee + 7;
  assert(before === true && v4KeyMatchesIdMemo(p) === false && v4KeyMatchesId(p) === false, 'a changed key field is a new memo key (answer follows the change)');

  // 3. copy2PoolOf and the whole track list: identical with COPY2_V4_KEY_MEMO on and off.
  process.env.COPY2_V4_KEY_MEMO = '0';
  const offEach = JSON.stringify(pools.map((x) => copy2PoolOf(x, PM)));
  const offList = JSON.stringify(buildTrackList(pools, PM));
  delete process.env.COPY2_V4_KEY_MEMO;
  const onEach = JSON.stringify(pools.map((x) => copy2PoolOf(x, PM)));
  const onList = JSON.stringify(buildTrackList(pools, PM));
  const onList2 = JSON.stringify(buildTrackList(pools, PM));
  assert(offEach === onEach, 'copy2PoolOf: same answer (pool or skip reason) for every pool, memo on vs off');
  assert(offList === onList && onList === onList2, 'buildTrackList: same pools, same order, same skip counts (first and repeat build)');
  const skipped = JSON.parse(onList).skipped;
  assert((skipped['V4 key does not match the pool id'] ?? 0) > 0 && (skipped['V4 pool with a hook'] ?? 0) > 0, `skip reasons kept: ${JSON.stringify(skipped)}`);
}

// Pair lookup with a registry venue: fake node answers.
async function registryTests() {
  const REG = '0x00000000000000000000000000000000000000aa', SV = '0x00000000000000000000000000000000000000bb';
  const venue = { dex: 'fables', kind: 'v4-registry', factory: SV, poolManager: PM, weth: REG_WETH, registry: REG } as unknown as Venue;
  const word = (x: bigint) => x.toString(16).padStart(64, '0');
  let answer = registryAnswer(300);
  let asked = 0;
  const callMany = async (calls: { target: string; data: string }[]) => calls.map((c) => {
    asked++;
    if (c.target === REG) return answer;
    if (c.target === SV && c.data.startsWith('0xc815641c')) return '0x' + word(2n ** 96n) + word(5n) + word(0n) + word(0n); // getSlot0: price, tick, fees
    if (c.target === SV) return '0x' + word(10n ** 18n);                                                                      // getLiquidity
    return null;
  });
  const coin = '0x' + (0x700000 + 7).toString(16).padStart(40, '0');
  // Same fields except the time stamps (taken from the clock on each call).
  const view = (r: { pools: PoolState[] }) => JSON.stringify(r.pools.map((p) => ({ ...p, lastUpdatedMs: 0, feeReadMs: 0 })), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  process.env.PAIR_REGISTRY_MEMO = '0';
  const off = view(await discoverPairPoolsMulticall(callMany, 'robinhood' as any, [venue], REG_WETH, coin));
  delete process.env.PAIR_REGISTRY_MEMO;
  const on1 = view(await discoverPairPoolsMulticall(callMany, 'robinhood' as any, [venue], REG_WETH, coin));
  const on2 = view(await discoverPairPoolsMulticall(callMany, 'robinhood' as any, [venue], coin, REG_WETH));
  const n = JSON.parse(off).length;
  assert(n > 0 && n <= 8, `the lookup finds this pair's hooked pools (${n}, at most 8)`);
  assert(off === on1, 'pair lookup: identical pools with the registry memo on vs off (first lookup)');
  const offRev = (process.env.PAIR_REGISTRY_MEMO = '0', view(await discoverPairPoolsMulticall(callMany, 'robinhood' as any, [venue], coin, REG_WETH)));
  delete process.env.PAIR_REGISTRY_MEMO;
  assert(on2 === offRev, 'pair lookup: identical pools on the remembered answer (second lookup, coins swapped)');
  // A changed registry answer is decoded fresh (never an old list).
  const a1 = registryList(REG, answer);
  answer = registryAnswer(301);
  const a2 = registryList(REG, answer);
  assert(a1.length === 300 && a2.length === 301 && registryList(REG, answer) === a2, 'new answer text -> decoded again; same text -> same remembered list');
  const plain = registryList('0x00000000000000000000000000000000000000cc', answer);
  assert(JSON.stringify(plain) === JSON.stringify(a2), 'remembered list = freshly decoded list');
  assert(a2.some((e) => !e.active) && a2.some((e) => /[A-F]/.test(e.hooks)), 'inactive entries and the hook spelling kept as before');
  assert(asked > 0, 'fake node was asked');
}

main();
registryTests().catch((e) => { console.error('FAIL: crashed', e); process.exitCode = 1; });
