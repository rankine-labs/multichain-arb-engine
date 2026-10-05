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
assert(EXECUTE_SELECTOR === '0x4e773929', 'execute() selector matches compiled ArbExecutor');

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
