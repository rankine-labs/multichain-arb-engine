import { ethers } from 'ethers';
import { decodePoolCreatedLog, derivePrices, poolUsd, rankCandidates, ScannedPool, emptyScanState, addPoolsToState, stateToPools } from '../core/universeScan';
import { PairWatcher } from '../core/pairWatcher';
import { PoolCache } from '../core/poolCache';

// Checks the chain-wide scan's pure logic: reading PoolCreated events from
// any V3 factory flavour, rough USD pricing, and ranking of arbitrable pairs.
// (The live scan is covered by scripts/probe-universe.ts.)

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
// Realistic addresses (non-zero leading bytes, like real contracts).
const A = (n: number) => ethers.getAddress('0xabcdef0123' + n.toString(16).padStart(30, '0'));
const pad = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');

// ---- PoolCreated decoding ---------------------------------------------------
// Uniswap/Pancake: PoolCreated(token0 idx, token1 idx, fee idx, int24 tickSpacing, address pool)
const uni = decodePoolCreatedLog({
  topics: [ethers.id('PoolCreated(address,address,uint24,int24,address)'), pad(A(1)), pad(A(2)), pad('0x' + (500).toString(16))],
  data: '0x' + (10).toString(16).padStart(64, '0') + pad(A(99)).slice(2),
});
assert(uni?.token0 === A(1) && uni?.token1 === A(2) && uni?.pool === A(99), 'Uniswap-style PoolCreated decoded');

// Ramses-style: tickSpacing indexed, data = pool only
const ram = decodePoolCreatedLog({ topics: ['0x' + '11'.repeat(32), pad(A(3)), pad(A(4)), pad('0x01')], data: pad(A(77)) });
assert(emptyScanState().pools.length === 0, 'empty scan state');
assert(ram?.pool === A(77), 'Ramses-style PoolCreated (pool as only data word) decoded');

// Uniswap V2: PairCreated(token0 idx, token1 idx, address pair, uint n) -- the counter must not be taken as the pool.
const v2 = decodePoolCreatedLog({ topics: [ethers.id('PairCreated(address,address,address,uint256)'), pad(A(1)), pad(A(2))], data: pad(A(55)) + (12345).toString(16).padStart(64, '0') });
assert(v2?.pool === A(55), 'Uniswap V2 PairCreated decoded (pair, not the counter)');
// Solidly: PairCreated(token0 idx, token1 idx, bool stable, address pair, uint n)
const sol = decodePoolCreatedLog({ topics: ['0x' + '44'.repeat(32), pad(A(1)), pad(A(2))], data: '0x' + '1'.padStart(64, '0') + pad(A(66)).slice(2) + '7'.padStart(64, '0') });
assert(sol?.pool === A(66), 'Solidly PairCreated decoded (pair, not the bool or counter)');
// Negative tickSpacing (int24 -> ff..ff) is not an address.
const neg = decodePoolCreatedLog({ topics: ['0x' + '55'.repeat(32), pad(A(1)), pad(A(2))], data: '0x' + 'f'.repeat(64) });
assert(neg === null, 'negative number never read as a pool');

// Non-pool factory events (OwnerChanged, FeeAmountEnabled) carry no data -> skipped.
assert(decodePoolCreatedLog({ topics: ['0x' + '22'.repeat(32), pad(A(5)), pad(A(6))], data: '0x' }) === null, 'event without data skipped');
// Topic that isn't an address (e.g. a fee number with high bits) -> skipped.
assert(decodePoolCreatedLog({ topics: ['0x' + '33'.repeat(32), '0x' + 'ff'.repeat(32), pad(A(6))], data: pad(A(7)) }) === null, 'non-address topic skipped');

// ---- pricing ----------------------------------------------------------------
const USDG = A(10), WETH = A(11), TOK = A(12), OTHER = A(13), JUNK = A(14);
const dec = new Map([[USDG, 6], [WETH, 18], [TOK, 18], [OTHER, 9], [A(15), 18], [A(16), 18]].map(([a, d]) => [String(a).toLowerCase(), d as number]));
const e18 = (n: number) => ethers.parseUnits(String(n), 18);
const e6 = (n: number) => ethers.parseUnits(String(n), 6);
const pools: ScannedPool[] = [
  // WETH/USDG: 100 WETH vs 300k USDG -> ETH $3,000 (deepest), and a shallower one at a worse price
  { dex: 'uniswap-v2', kind: 'v2', pool: A(100), token0: USDG, token1: WETH, bal0: e6(300_000), bal1: e18(100) },
  { dex: 'pancakeswap-v2', kind: 'v2', pool: A(101), token0: USDG, token1: WETH, bal0: e6(1_000), bal1: e18(1) },
  // TOK/WETH: 10 WETH vs 30,000 TOK -> TOK = $1
  { dex: 'uniswap-v2', kind: 'v2', pool: A(102), token0: TOK, token1: WETH, bal0: e18(30_000), bal1: e18(10) },
  { dex: 'ramses-v2', kind: 'solidly', pool: A(103), token0: TOK, token1: WETH, bal0: e18(3_000), bal1: e18(1) },
  // stable-curve pool: excluded from pricing and from candidates
  { dex: 'ramses-v2', kind: 'solidly', pool: A(104), token0: TOK, token1: WETH, bal0: e18(9e6), bal1: e18(1), stable: true },
  // V3 pool with skewed balances (1 TOK2 vs 10 WETH) must NOT price TOK2 at 10 ETH
  { dex: 'uniswap-v3', kind: 'v3', pool: A(107), token0: A(15), token1: WETH, bal0: e18(1), bal1: e18(10) },
  { dex: 'uniswap-v3', kind: 'v3', pool: A(108), token0: A(15), token1: WETH, bal0: e18(1e12), bal1: 0n },
  // tiny V2 pool ($300 of WETH) claiming TOK3 = 1 ETH: too small to trust
  { dex: 'uniswap-v2', kind: 'v2', pool: A(109), token0: A(16), token1: WETH, bal0: e18(0.1), bal1: e18(0.1) },
  // pair with no priced side
  { dex: 'uniswap-v2', kind: 'v2', pool: A(105), token0: OTHER, token1: JUNK, bal0: 10n ** 12n, bal1: 10n ** 12n },
  { dex: 'pancakeswap-v2', kind: 'v2', pool: A(106), token0: OTHER, token1: JUNK, bal0: 10n ** 12n, bal1: 10n ** 12n },
];
const px = derivePrices(pools, dec, USDG, WETH);
assert(Math.abs((px.get(WETH.toLowerCase()) ?? 0) - 3000) < 1e-6, 'ETH priced from its deepest USDG pool');
assert(Math.abs((px.get(TOK.toLowerCase()) ?? 0) - 1) < 1e-9, 'other token priced via WETH');
assert(!px.has(OTHER.toLowerCase()), 'token with no USDG/WETH pool stays unpriced');
for (const p of pools) p.usd = poolUsd(p, dec, px);
assert(Math.round(pools[0].usd!) === 600_000, 'pool value = 2 x smaller side when both priced');
assert(!px.has(A(16).toLowerCase()), 'tiny pool never used for pricing');
assert(pools[8].usd === 0, 'unpriceable pool valued at 0');
assert(!px.has(A(15).toLowerCase()), 'V3 balances never used to price a token');
assert(pools[5].usd === 60_000 && pools[6].usd === 0, 'V3 pool valued only by its priced (WETH) side');

// ---- ranking ----------------------------------------------------------------
const { multiPoolPairs, candidates } = rankCandidates(pools, 2_000);
assert(multiPoolPairs === 4, `pairs on 2+ pools counted before liquidity filter (${multiPoolPairs})`);
assert(candidates.length === 2, `only pairs with 2+ liquid, priceable pools kept (${candidates.length})`);
assert(candidates[0].tokenA.toLowerCase() === TOK.toLowerCase() || candidates[0].tokenB.toLowerCase() === TOK.toLowerCase(),
  'ranked by 2nd-deepest pool (TOK/WETH 2nd pool $6k beats WETH/USDG 2nd pool $2k)');
assert(!candidates[0].pools.some((p) => p.stable), 'stable-curve pool never counted');
assert(candidates[0].dexes.join(',') === 'uniswap-v2,ramses-v2', 'distinct DEXes listed deepest first');

// ---- saved state ------------------------------------------------------------
const stt = emptyScanState();
const fUni = { dex: 'uniswap-v2', kind: 'v2' as const, factory: A(900) };
addPoolsToState(stt, fUni, [pools[0], pools[2]]);
addPoolsToState(stt, fUni, [pools[0]]);                       // duplicate ignored
addPoolsToState(stt, { dex: 'ramses-v2', kind: 'solidly', factory: A(901) }, [pools[3]]);
const back = JSON.parse(JSON.stringify(stt));                // survives save/load
const restored = stateToPools(back);
assert(restored.length === 3 && stt.tokens.length === 3, 'state stores each pool once, each token once');
assert(restored[2].dex === 'ramses-v2' && restored[2].kind === 'solidly' && restored[2].pool === pools[3].pool, 'pool restored with its DEX and kind');

// ---- pinned pairs survive eviction ------------------------------------------
const w = new PairWatcher('robinhood', {} as any, [], new PoolCache(), () => {}, { maxPairs: 2 });
(w as any).discover = async (a: string, b: string) => {
  (w as any).pairs.set((w as any).key(a, b), { tokenA: a, tokenB: b, pools: ['x', 'y'], discoveredAt: Date.now(), lastSeen: Date.now() - (a === A(1) ? 1e6 : 0) });
  (w as any).evictIfNeeded();
};
(async () => {
  await w.watch(A(1), A(2), { pin: true });   // oldest, but pinned
  await w.watch(A(3), A(4));
  await w.watch(A(5), A(6));                   // over the cap: an UNPINNED pair must go
  const keys = [...(w as any).pairs.keys()];
  assert(keys.includes((w as any).key(A(1), A(2))), 'pinned pair kept when list is full');
  assert(w.stats().pairs === 2 && w.stats().pinned === 1, 'cap still enforced on unpinned pairs');
})();
