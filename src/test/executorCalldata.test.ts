import {
  buildExecuteCall, decodeExecuteCall, kindForPool, usdToTokenUnits,
  EXECUTE_SELECTOR, KIND_V2, KIND_SOLIDLY, KIND_V3, BuildInput,
} from '../execution/executorCalldata';
import { PoolState } from '../core/types';

// Proves the bot builds ArbExecutor.execute() calldata correctly from a plan,
// and refuses (instead of guessing) when it can't do it safely.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const WMON = '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A';
const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';

function pool(dex: string, poolType: PoolState['poolType'], addr: string, feeBps = 30): PoolState {
  return {
    chain: 'monad', dex, poolAddress: addr, poolType,
    tokenA: USDC, tokenB: WMON, feeBps, lastUpdatedBlock: 1, lastUpdatedMs: 0,
  };
}

// Reason text from a refused build ('' if it actually succeeded).
const reasonOf = (r: ReturnType<typeof buildExecuteCall>): string => ('reason' in r ? r.reason : '');

const V2 = pool('pancakeswap-v2', 'v2', '0x1111111111111111111111111111111111111111', 25);
const V3 = pool('uniswap-v3', 'v3', '0x2222222222222222222222222222222222222222', 30);

const base: BuildInput = {
  chain: 'monad',
  tokenIn: WMON,
  buyPool: V2,
  sellPool: V3,
  tradeSizeUsd: 1_000,       // $1,000 trade
  netProfitUsd: 25,          // $25 floor
  usdPerTokenIn: 0.5,        // 1 WMON = $0.50
  tokenInDecimals: 18,
  maxBlock: 12_345n,
};

// 1. Selector matches the compiled contract (forge inspect ArbExecutor methodIdentifiers).
assert(EXECUTE_SELECTOR === '0x8da2b32d', 'execute() selector matches compiled ArbExecutor');

// 2. Happy path: correct amounts, route, kinds, and it round-trips through the ABI.
const r = buildExecuteCall(base);
assert(r.ok, 'builds calldata for a V2 -> V3 plan');
if (r.ok) {
  assert(r.data.startsWith(EXECUTE_SELECTOR), 'calldata starts with execute() selector');
  assert(r.amountIn === 2_000n * 10n ** 18n, `amountIn = $1000 / $0.50 = 2000 WMON (got ${r.amountIn})`);
  assert(r.minProfit === 50n * 10n ** 18n, `minProfit = $25 / $0.50 = 50 WMON (got ${r.minProfit})`);
  const [t, flash] = decodeExecuteCall(r.data);
  assert(t.token.toLowerCase() === WMON.toLowerCase(), 'route starts and ends in WMON');
  assert(t.hops.length === 2, 'two hops');
  assert(Number(t.hops[0].kind) === KIND_V2 && t.hops[0].tokenOut.toLowerCase() === USDC.toLowerCase(), 'hop 1: V2 WMON -> USDC');
  assert(Number(t.hops[0].feeBps) === 25, 'hop 1 carries the V2 pool fee (25 bps)');
  assert(Number(t.hops[1].kind) === KIND_V3 && t.hops[1].tokenOut.toLowerCase() === WMON.toLowerCase(), 'hop 2: V3 USDC -> WMON');
  assert(t.maxBlock === 12_345n, 'maxBlock passed through');
  assert(flash === '0x0000000000000000000000000000000000000000', 'no flash pool = own capital');
}

// 3. Flash pool passes through when configured.
const aave = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';
const rf = buildExecuteCall({ ...base, flashPool: aave });
assert(rf.ok && rf.flashPool === aave, 'flash pool passes through');

// 4. Pool kind mapping.
assert(kindForPool(pool('ramses-v2', 'v2', '0x3')) === KIND_SOLIDLY, 'Ramses V2 -> Solidly kind');
assert(kindForPool(pool('pharaoh', 'v2', '0x3')) === KIND_SOLIDLY, 'Pharaoh -> Solidly kind');
assert(kindForPool(pool('traderjoe-v1', 'v2', '0x3')) === KIND_V2, 'TraderJoe v1 -> V2 kind');
assert(kindForPool(pool('pancakeswap-v3', 'v3', '0x3')) === KIND_V3, 'Pancake V3 -> V3 kind');
assert(kindForPool(pool('kuru', 'orderbook', '0x3')) === null, 'Kuru orderbook refused');
assert(kindForPool(pool('lfj-lb', 'v2', '0x3')) === null, 'LFJ LB refused even if labelled v2');
assert(kindForPool(pool('bean-exchange', 'v2', '0x3')) === null, 'Bean DLMM refused');

// 5. Refusals.
const kuru = buildExecuteCall({ ...base, sellPool: pool('kuru', 'orderbook', '0x4') });
assert(/sell pool not supported/.test(reasonOf(kuru)), 'unsupported sell pool refused with reason');

const noDec = buildExecuteCall({ ...base, tokenInDecimals: undefined });
assert(/unknown decimals/.test(reasonOf(noDec)), 'unknown decimals refused (no silent 18 default)');

const tiny = buildExecuteCall({ ...base, netProfitUsd: 1e-30 });
assert(/profit floor rounds to zero/.test(reasonOf(tiny)), 'zero profit floor refused');

const wrongPair = buildExecuteCall({ ...base, tokenIn: '0x9999999999999999999999999999999999999999' });
assert(!wrongPair.ok, 'tokenIn not in buy pool refused');

// 6. Unit conversion: 6-decimal token, rounding down.
assert(usdToTokenUnits(100, 1, 6) === 100_000_000n, '$100 of a $1 6-dec token = 100e6 units');
assert(usdToTokenUnits(1, 3, 6) === 333_333n, 'rounds DOWN (1/3 token -> 333333 units)');
assert(usdToTokenUnits(-5, 1, 18) === 0n && usdToTokenUnits(5, 0, 18) === 0n, 'bad inputs -> 0');

// ---- V3 pool flash loans -----------------------------------------------------
import { pickV3Lender, EXECUTE_V3_FLASH_SELECTOR, EXECUTE_ABI } from '../execution/executorCalldata';
import { Interface } from 'ethers';

const LENDER = '0x3333333333333333333333333333333333333333';
const rf3 = buildExecuteCall({ ...base, v3Lender: LENDER });
assert(rf3.ok && rf3.funding === 'v3-flash' && rf3.flashPool === LENDER, 'v3Lender -> v3-flash funding');
assert(rf3.ok && rf3.data.startsWith(EXECUTE_V3_FLASH_SELECTOR), 'calldata uses executeWithV3Flash (selector matches compiled contract)');
if (rf3.ok) {
  const [t, lend] = new Interface(EXECUTE_ABI).decodeFunctionData('executeWithV3Flash', rf3.data);
  assert(lend === LENDER && t.hops.length === 2 && t.amountIn === 2_000n * 10n ** 18n, 'flash calldata round-trips: lender, hops, amount');
}
const own = buildExecuteCall(base);
assert(own.ok && own.funding === 'own', 'no lender, no Aave -> own capital');
const lenderIsHop = buildExecuteCall({ ...base, v3Lender: V3.poolAddress });
assert(!lenderIsHop.ok, 'lender that is also a trade pool is refused');

// Lender picker: cheapest fee first, then deepest; must hold the token,
// must not be a trade pool, must be a supported V3 DEX with liquidity.
const lp = (addr: string, dex: string, fee: number, liq: bigint, tA = WMON, tB = USDC): PoolState => ({
  chain: 'monad', dex, poolAddress: addr, poolType: 'v3', tokenA: tA, tokenB: tB,
  feeBps: fee, liquidity: liq, sqrtPriceX96: 1n, lastUpdatedBlock: 1, lastUpdatedMs: 0,
});
const cands = [
  lp('0xa1', 'uniswap-v3', 30, 10n ** 24n),
  lp('0xa2', 'pancakeswap-v3', 5, 10n ** 20n),     // cheapest fee
  lp('0xa3', 'uniswap-v3', 5, 10n ** 22n),         // same fee, deeper -> wins
  lp('0xa4', 'uniswap-v3', 1, 0n),                 // no liquidity
  lp('0xa5', 'kuru', 1, 10n ** 30n),               // unsupported dex
  lp('0xa6', 'uniswap-v3', 1, 10n ** 30n, USDC, '0x9999999999999999999999999999999999999999'), // no WMON
];
assert(pickV3Lender(cands, WMON, [])?.poolAddress === '0xa3', 'picks lowest fee, then deepest liquidity');
assert(pickV3Lender(cands, WMON, ['0xA3'])?.poolAddress === '0xa2', 'never picks a trade pool (case-insensitive)');
assert(pickV3Lender([cands[3], cands[4], cands[5]], WMON, []) === null, 'none suitable -> null');

// Ramses V3 lends too (verified by the Ramses V3 lender fork test).
assert(pickV3Lender([...cands, lp('0xa7', 'ramses-v3', 1, 10n ** 22n)], WMON, [])?.poolAddress === '0xa7', 'Ramses V3 pool can be the lender');

// ---- Robinhood copy exchanges ------------------------------------------------
// The 6 V3 copies trade exactly like the originals: KIND_V3 with the pool's
// own address, both as the buy and the sell side, and the calldata decodes
// back to the same route (contracts/test/ForkCopyVenues.t.sol proves the
// contract side on a fork of the live chain).
import { COPY_V3_CALLBACK, KIND_V4, KIND_V4_HOOKED, v4KeyMatchesId, encodeExecuteRaw } from '../execution/executorCalldata';

const RH_WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const RH_USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const rhPool = (dex: string, addr: string, extra: Partial<PoolState> = {}): PoolState => ({
  chain: 'robinhood', dex, poolAddress: addr, poolType: 'v3', tokenA: RH_WETH, tokenB: RH_USDG,
  feeBps: 5, sqrtPriceX96: 1n, liquidity: 10n ** 18n, lastUpdatedBlock: 1, lastUpdatedMs: 0, ...extra,
});
const RH_UNI = rhPool('uniswap-v3', '0x3333333333333333333333333333333333333333');
const rhBase: BuildInput = {
  chain: 'robinhood', tokenIn: RH_WETH, buyPool: RH_UNI, sellPool: RH_UNI,
  tradeSizeUsd: 100, netProfitUsd: 1, usdPerTokenIn: 2_500, tokenInDecimals: 18, maxBlock: 1n,
};

assert(Object.keys(COPY_V3_CALLBACK).sort().join(',') === 'giga-cl,raphael-cl,sushiswap-v3,swaphood-v3,topaz-cl,up-cl', 'all 6 copy exchanges are mapped');
assert(['giga-cl', 'swaphood-v3'].every((d) => COPY_V3_CALLBACK[d] === 'pancakeV3SwapCallback'), 'PancakeSwap copies use the PancakeSwap callback');
assert(['sushiswap-v3', 'up-cl', 'topaz-cl', 'raphael-cl'].every((d) => COPY_V3_CALLBACK[d] === 'uniswapV3SwapCallback'), 'Uniswap and Slipstream copies use the Uniswap callback');

for (const dex of Object.keys(COPY_V3_CALLBACK)) {
  const copy = rhPool(dex, '0x4444444444444444444444444444444444444444');
  assert(kindForPool(copy) === KIND_V3, `${dex}: trades as KIND_V3`);
  // Copy on the sell side (Uniswap first, copy back) and on the buy side.
  for (const [buy, sell, label] of [[RH_UNI, copy, 'uni then copy'], [copy, RH_UNI, 'copy then uni']] as const) {
    const b = buildExecuteCall({ ...rhBase, buyPool: buy, sellPool: sell });
    assert(b.ok, `${dex} ${label}: calldata builds`);
    if (!b.ok) continue;
    const [t] = decodeExecuteCall(b.data);
    assert(t.hops.length === 2 && t.hops.every((h: { kind: bigint }) => Number(h.kind) === KIND_V3), `${dex} ${label}: both hops KIND_V3`);
    assert(t.hops[0].pool.toLowerCase() === buy.poolAddress && t.hops[1].pool.toLowerCase() === sell.poolAddress, `${dex} ${label}: hops point at the pools themselves`);
    assert(t.hops[0].tokenIn === RH_WETH && t.hops[0].tokenOut === RH_USDG && t.hops[1].tokenOut === RH_WETH, `${dex} ${label}: WETH -> USDG -> WETH`);
    assert(Number(t.hops[0].feeBps) === 0 && Number(t.hops[1].v4TickSpacing) === 0, `${dex} ${label}: no V2 fee or V4 fields on V3 hops`);
  }
}

// ---- Algebra Integral pools (Alandale, KittenSwap) ---------------------------
// Same swap() as Uniswap V3; the contract answers their algebraSwapCallback
// like the V3 callbacks, so they trade as KIND_V3 with the pool's own address
// (contracts/test/Algebra.t.sol + ForkAlgebraVenues.t.sol prove the contract side).
for (const dex of ['alandale', 'kittenswap-algebra']) {
  const alg = rhPool(dex, '0x5555555555555555555555555555555555555555', { variant: 'algebra', feeBps: 1, feePips: 123 });
  assert(kindForPool(alg) === KIND_V3, `${dex}: Algebra pool trades as KIND_V3`);
  for (const [buy, sell, label] of [[RH_UNI, alg, 'uni then algebra'], [alg, RH_UNI, 'algebra then uni']] as const) {
    const b = buildExecuteCall({ ...rhBase, buyPool: buy, sellPool: sell });
    assert(b.ok, `${dex} ${label}: calldata builds`);
    if (!b.ok) continue;
    const [t] = decodeExecuteCall(b.data);
    assert(t.hops.every((h: { kind: bigint }) => Number(h.kind) === KIND_V3), `${dex} ${label}: both hops KIND_V3`);
    assert(t.hops[0].pool.toLowerCase() === buy.poolAddress && t.hops[1].pool.toLowerCase() === sell.poolAddress, `${dex} ${label}: hops point at the pools themselves`);
    assert(Number(t.hops[0].feeBps) === 0 && Number(t.hops[1].feeBps) === 0, `${dex} ${label}: no fixed fee sent (the pool charges its own dynamic fee)`);
  }
}
// An Algebra-labelled entry carrying V4 details is not a pool address: refused.
assert(kindForPool(rhPool('alandale', '0x' + 'ab'.repeat(32), { variant: 'algebra', v4: { fee: 0, tickSpacing: 60, native: false, poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951', stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b' } })) === null, 'Algebra-labelled pool with V4 details refused');

// Hooked V4 pools (Fables) now trade as KIND_V4_HOOKED, never as V3.
const hookedV4 = { fee: 0, tickSpacing: 60, native: true, poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951', stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b', hooks: '0x' + '99'.repeat(20) };
assert(kindForPool(rhPool('fables', '0x' + 'ab'.repeat(32), { v4: hookedV4 })) === KIND_V4_HOOKED, 'hooked V4 pool (Fables) -> KIND_V4_HOOKED, not traded as V3');
assert(kindForPool(rhPool('uniswap-v4', '0x' + 'ab'.repeat(32), { v4: hookedV4 })) === KIND_V4_HOOKED, 'hooked Uniswap V4 pool -> KIND_V4_HOOKED');
assert(kindForPool(rhPool('fables', '0x' + 'ab'.repeat(32), { v4: { ...hookedV4, hooks: undefined } })) === null, 'hookless V4 details under another exchange name still refused');
assert(kindForPool(rhPool('uniswap-v4', '0x' + 'ab'.repeat(32), { v4: { ...hookedV4, hooks: undefined } })) === KIND_V4, 'hookless Uniswap V4 pool still KIND_V4');
assert(kindForPool(rhPool('uniswap-v4', '0x' + 'ab'.repeat(32), { v4: { ...hookedV4, hooks: '0x0000000000000000000000000000000000000000' } })) === KIND_V4, 'V4 pool with hooks = zero address still KIND_V4');

// ---- Fables: real pool key -> calldata ---------------------------------------
// The most liquid Fables ETH/USDG pool as read from the registry on a fork
// (contracts/test/ForkFablesVenues.t.sol): native ETH / USDG, fee field
// 0x800000 (dynamic fee, set by the hook per swap), tick spacing 10.
const FABLES_ID = '0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551';
const FABLES_HOOK = '0x06a889870C8f83640D6816319f72e2aA579b6080';
const RH_PM = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const fables = rhPool('fables', FABLES_ID, {
  feeBps: 30, feePips: 3000,
  v4: { fee: 0x800000, tickSpacing: 10, native: true, poolManager: RH_PM, stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b', hooks: FABLES_HOOK.toLowerCase() },
});
assert(kindForPool(fables) === KIND_V4_HOOKED, 'Fables ETH/USDG -> KIND_V4_HOOKED');
assert(v4KeyMatchesId(fables), 'Fables key (ETH, USDG, 0x800000, 10, hook) hashes to the real pool id');
assert(!v4KeyMatchesId({ ...fables, v4: { ...fables.v4!, fee: 700 } }), 'a measured fee in place of the fee field does NOT match the id');

for (const [buy, sell, label] of [[RH_UNI, fables, 'uni then fables'], [fables, RH_UNI, 'fables then uni']] as const) {
  const b = buildExecuteCall({ ...rhBase, buyPool: buy, sellPool: sell });
  assert(b.ok, `fables ${label}: calldata builds`);
  if (!b.ok) continue;
  assert(b.data.startsWith(EXECUTE_SELECTOR), `fables ${label}: same execute() selector as before (calldata layout unchanged)`);
  const [t] = decodeExecuteCall(b.data);
  const fh = buy === fables ? t.hops[0] : t.hops[1];
  const other = buy === fables ? t.hops[1] : t.hops[0];
  assert(Number(fh.kind) === KIND_V4_HOOKED, `fables ${label}: Fables hop is kind 4`);
  assert(fh.pool === FABLES_HOOK, `fables ${label}: Fables hop's pool field is the hook (checksummed)`);
  assert(Number(fh.v4Fee) === 0x800000 && Number(fh.v4TickSpacing) === 10 && fh.v4Native === true, `fables ${label}: fee field 0x800000, tick spacing 10, native ETH`);
  assert(Number(fh.feeBps) === 0, `fables ${label}: no fixed V2 fee on the Fables hop`);
  assert(Number(other.kind) === KIND_V3, `fables ${label}: other hop still KIND_V3`);
  const bh = buy === fables ? b.hops[0] : b.hops[1];
  assert(bh.v4PoolManager === RH_PM, `fables ${label}: PoolManager kept for the simulator (not encoded)`);
}

// Wrong key refused with a reason instead of sending a swap to a pool that doesn't exist.
{
  const wrongFee = { ...fables, v4: { ...fables.v4!, fee: 700 } };
  const b = buildExecuteCall({ ...rhBase, buyPool: RH_UNI, sellPool: wrongFee });
  assert(!b.ok && reasonOf(b).includes('does not match its pool id'), 'Fables pool with a wrong fee field refused (key/id mismatch)');
  const wrongHook = { ...fables, v4: { ...fables.v4!, hooks: '0x' + '99'.repeat(20) } };
  const c = buildExecuteCall({ ...rhBase, buyPool: wrongHook, sellPool: RH_UNI });
  assert(!c.ok && reasonOf(c).includes('buy pool'), 'Fables pool with a wrong hook refused');
}

// The encoder never sends the bot-only v4PoolManager field, and plain hops encode exactly as before.
{
  const hops = [
    { kind: KIND_V3, pool: RH_UNI.poolAddress, tokenIn: RH_WETH, tokenOut: RH_USDG, feeBps: 0 },
    { kind: KIND_V4_HOOKED, pool: FABLES_HOOK, tokenIn: RH_USDG, tokenOut: RH_WETH, feeBps: 0, v4Fee: 0x800000, v4TickSpacing: 10, v4Native: true, v4PoolManager: RH_PM },
  ];
  const withExtra = encodeExecuteRaw({ token: RH_WETH, amountIn: 1n, minProfit: 1n, maxBlock: 1n, hops });
  const withoutExtra = encodeExecuteRaw({ token: RH_WETH, amountIn: 1n, minProfit: 1n, maxBlock: 1n, hops: hops.map(({ v4PoolManager: _pm, ...h }) => h) });
  assert(withExtra === withoutExtra, 'v4PoolManager is not part of the calldata');
}
