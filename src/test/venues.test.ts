import { ethers } from 'ethers';
import { clAmountOut, v2AmountOut, errorBps } from '../core/venueMath';
import { poolFromPositions, exactSwap } from './helpers/v3Exact';
import { ROBINHOOD_VENUES, isExecutableVenue, isPracticeTestableVenue, venueByFactory, extraWatcherVenues, extraScanFactories, priceableVenues } from '../config/robinhoodVenues';
import { ROBINHOOD_SCAN_FACTORIES } from '../config/knownAddresses';
import { discoverPairPoolsMulticall, refreshPoolsBatch, Venue } from '../core/pairWatcher';

// ============================================================================
// Extra Robinhood venues (Oct 8): registry safety, exact maths, and the pair
// watcher adapters for Algebra (Alandale), hooked V4 (Fables) and Solidly
// pairs with their own fee (GIGA Classic).
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

async function main() {
  // --- registry safety ------------------------------------------------------
  assert(ROBINHOOD_VENUES.every((v) => v.executionEnabled === false), 'no extra venue is enabled for trading');
  assert(ROBINHOOD_VENUES.every((v) => !isExecutableVenue(v.id)), 'the trade gate refuses every extra venue');
  assert(['uniswap-v2', 'uniswap-v3', 'uniswap-v4', 'pancakeswap-v3', 'ramses-v2', 'ramses-v3'].every(isExecutableVenue), 'existing exchanges still pass the trade gate');
  // PRACTICE testing gate: exactly the 6 copy exchanges whose fork test passed
  // (contracts/test/ForkCopyVenues.t.sol), each with the CI run noted.
  const COPIES = ['giga-cl', 'swaphood-v3', 'sushiswap-v3', 'up-cl', 'topaz-cl', 'raphael-cl'];
  // Plus the 2 Algebra exchanges whose fork test passed (ForkAlgebraVenues.t.sol).
  const ALGEBRA = ['alandale', 'kittenswap-algebra'];
  const PRACTICE = [...COPIES, ...ALGEBRA];
  assert(COPIES.every(isPracticeTestableVenue), 'all 6 fork-tested copy exchanges are practice-testable');
  assert(ALGEBRA.every(isPracticeTestableVenue), 'both fork-tested Algebra exchanges (Alandale, KittenSwap) are practice-testable');
  assert(ROBINHOOD_VENUES.filter((v) => isPracticeTestableVenue(v.id)).map((v) => v.id).sort().join(',') === [...PRACTICE].sort().join(','), 'no other venue is practice-testable (Fables, oracle venues etc. stay out)');
  assert(ROBINHOOD_VENUES.filter((v) => v.practiceTested).every((v) => /actions\/runs\/\d+$/.test(v.practiceTested!.run) && /^\d{4}-\d{2}-\d{2}$/.test(v.practiceTested!.date)), 'every practice-tested venue names its CI run and date');
  assert(!isPracticeTestableVenue('uniswap-v3') && !isPracticeTestableVenue('fables') && !isPracticeTestableVenue(''), 'practice gate is only for listed, fork-tested venues');
  assert(PRACTICE.every((d) => !isExecutableVenue(d)), 'practice-testable venues (Algebra too) are still refused by the real trade gate');
  const all = ROBINHOOD_VENUES.flatMap((v) => v.contracts.map((c) => c.address));
  assert(all.every((a) => { try { ethers.getAddress(a.toLowerCase()); return /^0x[0-9a-fA-F]{40}$/.test(a); } catch { return false; } }), 'every address is a full 20-byte address (no shortened guesses)');
  assert(new Set(all.map((a) => a.toLowerCase())).size === all.length, 'no address listed twice');
  const known = new Set(ROBINHOOD_SCAN_FACTORIES.map((f) => f.factory.toLowerCase()));
  assert(all.every((a) => !known.has(a.toLowerCase())), 'no overlap with the exchanges we already trade');
  assert(venueByFactory('0x16494a80e08bcb9285d87b67149d7b01774d82f8')?.id === 'alandale' && venueByFactory('0xece6ecd61177336ea6fb9b17937ac439d85ee20b')?.id === 'giga-cl', 'the two biggest unknown factories map to Alandale and GIGA CL');
  for (const id of ['fables', 'metric', 'giga-cl', 'tessera', 'ekubo']) assert(ROBINHOOD_VENUES.some((v) => v.id === id && v.priority === 'P0'), `${id} is listed as priority`);
  assert(!priceableVenues().some((v) => ['oracle-amm', 'prop-amm', 'singleton'].includes(v.model)), 'oracle / prop / singleton venues are never priced from pool state');
  const wv = extraWatcherVenues({ stateView: '0x' + '11'.repeat(20), poolManager: '0x' + '22'.repeat(20), weth: '0x' + '33'.repeat(20) });
  assert(wv.some((v) => v.dex === 'alandale' && v.kind === 'algebra') && wv.some((v) => v.dex === 'fables' && v.kind === 'v4-registry' && !!v.registry)
    && wv.some((v) => v.dex === 'giga-classic' && v.kind === 'solidly' && v.pairFee) && wv.some((v) => v.dex === 'up-cl' && v.kind === 'v3-spacing'), 'watcher venues: Algebra, hooked V4, per-pair fee Solidly, tick-spacing CL');
  assert(extraScanFactories().every((f) => f.kind !== 'v2') && !extraScanFactories().some((f) => f.dex === 'fables' || f.dex === 'metric'), 'universe scan gets CL/Solidly factories only');

  // --- exact concentrated-liquidity maths vs the full Uniswap swap loop -----
  const pool = poolFromPositions(0, 500, [{ tickLower: -6000, tickUpper: 6000, liquidity: 10n ** 21n }]);
  for (const [zf, amt] of [[true, 10n ** 17n], [false, 10n ** 17n], [true, 12345678901234n], [false, 3n * 10n ** 18n]] as const) {
    const ref = exactSwap(pool, zf, amt).amountOut;
    const ours = clAmountOut(pool.sqrtPriceX96, pool.liquidity, amt, zf, 500).amountOut;
    assert(ours === ref, `in-band ${zf ? 'token0->1' : 'token1->0'} ${amt}: exact match with the Uniswap swap loop (${ours})`);
  }
  // Price after the swap matches too.
  const big = exactSwap(pool, true, 10n ** 18n);
  assert(clAmountOut(pool.sqrtPriceX96, pool.liquidity, 10n ** 18n, true, 500).sqrtPriceNextX96 === big.after.sqrtPriceX96, 'post-swap price matches exactly');
  assert(clAmountOut(pool.sqrtPriceX96, 0n, 1000n, true, 500).amountOut === 0n, 'no liquidity -> nothing out');
  // V2: 1 in a 100/200 pool at 0.3% = 1.974...
  assert(v2AmountOut(10n ** 18n, 100n * 10n ** 18n, 200n * 10n ** 18n, 3000) === 1974316068794122597n, 'V2 output matches the Uniswap V2 formula');
  assert(errorBps(10_001n, 10_000n) === 1 && errorBps(0n, 0n) === 0, 'error in basis points');

  // --- pair watcher adapters (fake chain) -----------------------------------
  const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20), W = '0x' + 'cc'.repeat(20);
  const POOL = '0x' + 'de'.repeat(20), PAIR = '0x' + 'df'.repeat(20);
  const ALG = '0x' + '01'.repeat(20), SOL = '0x' + '02'.repeat(20), REG = '0x' + '03'.repeat(20), SV = '0x' + '04'.repeat(20), PM = '0x' + '05'.repeat(20);
  const enc = (types: string[], vals: unknown[]) => ethers.AbiCoder.defaultAbiCoder().encode(types, vals);
  const sel = (sig: string) => ethers.id(sig).slice(0, 10);
  const SQRT = 79228162514264337593543950336n; // price 1
  const id = ethers.keccak256(enc(['address', 'address', 'uint24', 'int24', 'address'], [ethers.ZeroAddress, B, 0x800000, 60, '0x' + '99'.repeat(20)]));
  const fake = async (calls: { target: string; data: string }[]) => calls.map((c) => {
    const t = c.target.toLowerCase(), s4 = c.data.slice(0, 10);
    if (t === ALG && s4 === sel('poolByPair(address,address)')) return enc(['address'], [POOL]);
    if (t === POOL && s4 === sel('globalState()')) return enc(['uint160', 'int24', 'uint16', 'uint8', 'uint16', 'bool'], [SQRT, 0, 1234, 0, 0, true]);
    if (t === POOL && s4 === sel('liquidity()')) return enc(['uint128'], [10n ** 20n]);
    if (t === POOL && s4 === sel('token0()')) return enc(['address'], [A]);
    if (t === POOL && s4 === sel('token1()')) return enc(['address'], [B]);
    if (t === SOL && s4 === sel('getPair(address,address,bool)')) return enc(['address'], [PAIR]);
    if (t === PAIR && s4 === sel('getReserves()')) return enc(['uint112', 'uint112', 'uint32'], [10n ** 20n, 2n * 10n ** 20n, 0]);
    if (t === PAIR && s4 === sel('token0()')) return enc(['address'], [A]);
    if (t === PAIR && s4 === sel('token1()')) return enc(['address'], [B]);
    if (t === PAIR && s4 === sel('fee()')) return enc(['uint256'], [1800]);
    if (t === REG) return enc(['tuple(tuple(address,address,uint24,int24,address),bytes32,bool)[]'], [[[[ethers.ZeroAddress, B, 0x800000, 60, '0x' + '99'.repeat(20)], id, true]]]);
    if (t === SV && s4 === sel('getSlot0(bytes32)')) return enc(['uint160', 'int24', 'uint24', 'uint24'], [SQRT, 0, 0, 0]);
    if (t === SV && s4 === sel('getLiquidity(bytes32)')) return enc(['uint128'], [10n ** 19n]);
    return null;
  });
  const venues: Venue[] = [
    { dex: 'alandale', kind: 'algebra', factory: ALG },
    { dex: 'giga-classic', kind: 'solidly', factory: SOL, pairFee: true },
    { dex: 'fables', kind: 'v4-registry', factory: SV, registry: REG, poolManager: PM, weth: W },
  ];
  const { pools } = await discoverPairPoolsMulticall(fake, 'robinhood', venues, A, B);
  const alg = pools.find((p) => p.dex === 'alandale');
  assert(!!alg && alg.variant === 'algebra' && alg.feePips === 1234 && alg.sqrtPriceX96 === SQRT, 'Algebra pool found via poolByPair, price + dynamic fee from globalState');
  const sol = pools.find((p) => p.dex === 'giga-classic');
  assert(!!sol && sol.feePips === 1800 && sol.feeBps === 18 && sol.reserveB === 2n * 10n ** 20n, 'GIGA Classic pair uses its own fee (0.18%)');
  const { pools: wPools } = await discoverPairPoolsMulticall(fake, 'robinhood', venues, W, B);
  const fab = wPools.find((p) => p.dex === 'fables');
  assert(!!fab && fab.v4?.hooks === '0x' + '99'.repeat(20) && fab.v4.native && fab.feePips === 3000 && fab.poolAddress === id, 'Fables pool found in the registry (native ETH as WETH); listed fee 0 -> conservative 0.30% estimate');
  assert(!pools.some((p) => p.dex === 'fables'), 'Fables pool not matched to the wrong pair');
  // Refresh keeps dynamic fees current.
  const fake2 = async (calls: { target: string; data: string }[]) => calls.map((c) => {
    const s4 = c.data.slice(0, 10);
    if (s4 === sel('globalState()')) return enc(['uint160', 'int24', 'uint16', 'uint8', 'uint16', 'bool'], [SQRT + 1n, 0, 2500, 0, 0, true]);
    if (s4 === sel('getSlot0(bytes32)')) return enc(['uint160', 'int24', 'uint24', 'uint24'], [SQRT + 2n, 0, 0, 900]);
    return enc(['uint128'], [5n]);
  });
  const fresh = await refreshPoolsBatch(fake2, [alg!, fab!]);
  assert(fresh[0].feePips === 2500 && fresh[0].sqrtPriceX96 === SQRT + 1n, 'Algebra refresh reads globalState (price + new fee)');
  assert(fresh[1].feePips === 900 && fresh[1].sqrtPriceX96 === SQRT + 2n, 'hooked V4 refresh uses a listed fee when the pool has one');
}
main();
