import { ethers } from 'ethers';
import { TransactionDecoder, RouterRegistry } from '../core/decoder';
import { seedKnownAddresses, ROBINHOOD_V4, ROBINHOOD_UR_COPIES, ROBINHOOD_TOKENS } from '../config/knownAddresses';
import { PoolState, RawChainEvent } from '../core/types';
import { v4PoolIdOf, takeUrV4Hour, urV4DecodeOn, inputForOutput, V4_DYNAMIC_FEE_FLAG } from '../core/decoderV4Router';
import { v4Id } from '../core/v4Lookup';
import { v4PoolId } from '../core/poolResolver';
import { computeAmountOut } from '../core/dexMath';
import { formatPlainHourly } from '../core/telegramFormatter';

// Router V4 formats: reading Uniswap V4 swaps (Universal Router command 0x10)
// from the feed, behind FEED_DECODE_UR_V4. Calldata is hand-built with ethers'
// ABI coder exactly as the Universal Router / V4 router expect it.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const coder = ethers.AbiCoder.defaultAbiCoder();
const ZERO = ethers.ZeroAddress;
const WETH = ROBINHOOD_TOKENS.WETH, USDG = ROBINHOOD_TOKENS.USDG;
const OTHER = '0x9999999999999999999999999999999999999999';
const FABLES_HOOK = '0x00000000000000000000000000000000000080cc';
const MYSTERY_HOOK = '0x000000000000000000000000000000000000beef';
const PM = ROBINHOOD_V4.POOL_MANAGER, SV = ROBINHOOD_V4.STATE_VIEW;

// --- Pools the bot "watches" (its pool list), all priced at 3,000 USDG per ETH.
const sqrtAt3000 = BigInt(Math.floor(Math.sqrt(3000e6 / 1e18) * 2 ** 96));
const liq = BigInt(Math.floor(1000e18 * Math.sqrt(3000e6 / 1e18))); // ~1,000 ETH deep near the price
const v4Pool = (id: string, dex: string, fee: number, tickSpacing: number, native: boolean, feePips: number, hooks?: string): PoolState => ({
  chain: 'robinhood', dex, poolAddress: id, poolType: 'v3',
  tokenA: WETH, tokenB: USDG, sqrtPriceX96: sqrtAt3000, liquidity: liq,
  feeBps: Math.round(feePips / 100), feePips, lastUpdatedBlock: 0, lastUpdatedMs: 0,
  v4: { fee, tickSpacing, native, poolManager: PM, stateView: SV, hooks },
});
const ID_ETH_500 = v4PoolIdOf(ZERO, USDG, 500, 10, ZERO);          // native ETH / USDG 0.05%
const ID_WETH_3000 = v4PoolIdOf(WETH, USDG, 3000, 60, ZERO);       // WETH / USDG 0.30%
const ID_FABLES = v4PoolIdOf(ZERO, USDG, V4_DYNAMIC_FEE_FLAG, 60, FABLES_HOOK);
const ID_MYSTERY = v4PoolIdOf(ZERO, USDG, V4_DYNAMIC_FEE_FLAG, 60, MYSTERY_HOOK);
const watched = new Map<string, PoolState>([
  [ID_ETH_500, v4Pool(ID_ETH_500, 'uniswap-v4', 500, 10, true, 500)],
  [ID_WETH_3000, v4Pool(ID_WETH_3000, 'uniswap-v4', 3000, 60, false, 3000)],
  [ID_FABLES, v4Pool(ID_FABLES, 'fables', V4_DYNAMIC_FEE_FLAG, 60, true, 2600, FABLES_HOOK)],
  [ID_MYSTERY, v4Pool(ID_MYSTERY, 'mystery-hooks', V4_DYNAMIC_FEE_FLAG, 60, true, 3000, MYSTERY_HOOK)],
]);

// --- Calldata builders.
const KEY = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const PATH = 'tuple(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)';
const single = (key: object, zeroForOne: boolean, amount: bigint, limit: bigint) =>
  coder.encode([`tuple(${KEY} poolKey,bool zeroForOne,uint128 amount,uint128 limit,bytes hookData)`], [{ poolKey: key, zeroForOne, amount, limit, hookData: '0x' }]);
const multi = (currency: string, path: object[], amount: bigint, limit: bigint) =>
  coder.encode([`tuple(address currency,${PATH}[] path,uint128 amount,uint128 limit)`], [{ currency, path, amount, limit }]);
const hop = (intermediateCurrency: string, fee: number, tickSpacing: number, hooks = ZERO) => ({ intermediateCurrency, fee, tickSpacing, hooks, hookData: '0x' });
const v4Input = (actions: string, params: string[]) => coder.encode(['bytes', 'bytes[]'], [actions, params]);
const ur = new ethers.Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline)', 'function execute(bytes commands, bytes[] inputs)']);
const exec = (cmd: string, input: string) => ur.encodeFunctionData('execute(bytes,bytes[],uint256)', [cmd, [input], 9_999_999_999n]);
const ev = (data: string, to = ROBINHOOD_V4.UNIVERSAL_ROUTER, value = 0n): RawChainEvent =>
  ({ chain: 'robinhood', stateType: 'SEQUENCED', blockOrSeq: 1, receivedAtMs: 7, raw: { to, data, value: value.toString() } });
const keyEth500 = { currency0: ZERO, currency1: USDG, fee: 500, tickSpacing: 10, hooks: ZERO };
const settleAll = (c: string, amt: bigint) => coder.encode(['address', 'uint256'], [c, amt]);
const takeAll = (c: string) => coder.encode(['address', 'uint256'], [c, 0n]);

const reg: RouterRegistry = { avalanche: {}, monad: {}, robinhood: {} };
seedKnownAddresses(reg);
const dec = new TransactionDecoder(reg, undefined, (chain, addr) => (chain === 'robinhood' ? watched.get(addr.toLowerCase()) : undefined));
const on = () => { process.env.FEED_DECODE_UR_V4 = '1'; };
const off = () => { delete process.env.FEED_DECODE_UR_V4; };

async function main() {
  // ---- Pool id formula matches the bot's other two copies.
  assert(v4PoolIdOf(ZERO, USDG, 500, 10, ZERO) === v4Id(ZERO, USDG, 500, 10), 'pool id (no hook) matches core/v4Lookup v4Id');
  assert(v4PoolIdOf(ZERO, USDG, V4_DYNAMIC_FEE_FLAG, 60, FABLES_HOOK) === v4PoolId(ZERO, USDG, V4_DYNAMIC_FEE_FLAG, 60, FABLES_HOOK).toLowerCase(), 'pool id (with hook) matches core/poolResolver v4PoolId');

  // ---- The switch.
  off();
  assert(!urV4DecodeOn(), 'switch: unset -> off');
  process.env.FEED_DECODE_UR_V4 = '0'; assert(!urV4DecodeOn(), 'switch: 0 -> off');
  on(); assert(urV4DecodeOn(), 'switch: 1 -> on');

  const exactInSingle = exec('0x10', v4Input('0x060c0f', [single(keyEth500, true, 2n * 10n ** 18n, 0n), settleAll(ZERO, 2n * 10n ** 18n), takeAll(USDG)]));
  const exactOutSingle = exec('0x10', v4Input('0x080c0f', [single(keyEth500, true, 1_000n * 10n ** 6n, 10n ** 18n), settleAll(ZERO, 10n ** 18n), takeAll(USDG)]));

  // ---- Switch OFF = exactly today's behaviour.
  off();
  const offIn = await dec.decode(ev(exactInSingle));
  assert(offIn?.dex === 'uniswap-v4' && offIn.poolAddress === v4PoolId(ZERO, USDG, 500, 10) && offIn.amountIn === 2n * 10n ** 18n, 'switch off: "sell exactly" still read by the older reader, unchanged');
  assert(await dec.decode(ev(exactOutSingle)) === null, 'switch off: "buy exactly" not decoded (as today)');
  assert(await dec.decode(ev(exec('0x10', v4Input('0x060c0f', [single({ ...keyEth500, fee: V4_DYNAMIC_FEE_FLAG, tickSpacing: 60, hooks: FABLES_HOOK }, true, 10n ** 18n, 0n), settleAll(ZERO, 10n ** 18n), takeAll(USDG)])))) === null, 'switch off: Fables (hooked) pool not decoded (as today)');
  const offHour = takeUrV4Hour();
  assert(offHour.read === 0 && offHour.notReadable === 0, 'switch off: nothing counted');

  on();
  // ---- 1. Single "sell exactly": ETH -> USDG on the watched 0.05% pool.
  const s1 = await dec.decode(ev(exactInSingle));
  assert(s1?.poolAddress === ID_ETH_500 && s1.dex === 'uniswap-v4', 'single sell-exact: exact watched pool');
  assert(s1?.tokenIn === WETH && s1?.tokenOut === USDG && s1?.amountIn === 2n * 10n ** 18n && !s1.exactOut, 'single sell-exact: ETH reported as WETH, amount read');
  assert(s1?.feeTier === 500 && s1?.detectedAtMs === 7 && s1?.stateType === 'SEQUENCED', 'single sell-exact: fee, timing, state carried');

  // ---- 2. Single "buy exactly": buy 1,000 USDG with ETH (max 1 ETH).
  const s2 = await dec.decode(ev(exactOutSingle));
  const pool = watched.get(ID_ETH_500)!;
  assert(s2?.exactOut === true && s2.amountOutWanted === 1_000n * 10n ** 6n && s2.poolAddress === ID_ETH_500, 'single buy-exact: decoded as buy-exact on the right pool');
  const got = s2 ? computeAmountOut(pool, true, s2.amountIn) : null, gotLess = s2 ? computeAmountOut(pool, true, s2.amountIn - 1n) : null;
  assert(got !== null && got >= 1_000n * 10n ** 6n && gotLess !== null && gotLess < 1_000n * 10n ** 6n, 'single buy-exact: amount in = smallest that buys 1,000 USDG by our maths');
  assert(!!s2 && s2.amountIn > 33n * 10n ** 16n && s2.amountIn < 34n * 10n ** 16n, `single buy-exact: ~0.334 ETH at $3,000 (${s2?.amountIn})`);
  assert(inputForOutput(pool, true, 1_000n * 10n ** 6n, 10n ** 15n) === null, 'buy-exact: max too small for our price -> cannot size (skipped, not guessed)');

  // ---- 3. Multi-hop "sell exactly": USDG -> WETH (0.3%, watched) -> OTHER: first hop.
  const m = multi(USDG, [hop(WETH, 3000, 60), hop(OTHER, 3000, 60)], 5_000n * 10n ** 6n, 0n);
  const s3 = await dec.decode(ev(exec('0x10', v4Input('0x070c0f', [m, settleAll(USDG, 5_000n * 10n ** 6n), takeAll(OTHER)]))));
  assert(s3?.poolAddress === ID_WETH_3000 && s3.tokenIn === USDG && s3.tokenOut === WETH && s3.amountIn === 5_000n * 10n ** 6n, 'multi-hop sell-exact: first hop pool and amount');

  // ---- 4. Multi-hop "buy exactly": OTHER -> USDG -> ETH (buy 0.5 ETH): last hop (USDG -> ETH 0.05%).
  const mo = multi(ZERO, [hop(OTHER, 3000, 60), hop(USDG, 500, 10)], 5n * 10n ** 17n, 10n ** 30n);
  const s4 = await dec.decode(ev(exec('0x10', v4Input('0x090c0f', [mo, settleAll(OTHER, 10n ** 30n), takeAll(ZERO)]))));
  assert(s4?.poolAddress === ID_ETH_500 && s4.tokenIn === USDG && s4.tokenOut === WETH && s4.exactOut === true && s4.amountOutWanted === 5n * 10n ** 17n, 'multi-hop buy-exact: last hop (the one paying out) read');
  assert(!!s4 && s4.amountIn > 1_490n * 10n ** 6n && s4.amountIn < 1_520n * 10n ** 6n, `multi-hop buy-exact: ~1,500 USDG for 0.5 ETH (${s4?.amountIn})`);

  // ---- 5. Newer V4 router format (extra per-hop list after the path).
  const mNew = coder.encode([`tuple(address currency,${PATH}[] path,uint256[] hopLimits,uint128 amount,uint128 limit)`],
    [{ currency: USDG, path: [hop(WETH, 3000, 60)], hopLimits: [0n], amount: 777n * 10n ** 6n, limit: 0n }]);
  const s5 = await dec.decode(ev(exec('0x10', v4Input('0x07', [mNew]))));
  assert(s5?.poolAddress === ID_WETH_3000 && s5.amountIn === 777n * 10n ** 6n, 'newer multi-hop format (extra list) read with the right amount');

  // ---- 6. Allow-revert flag (0x90 = 0x80 | 0x10) and execute() without deadline.
  const s6 = await dec.decode(ev(ur.encodeFunctionData('execute(bytes,bytes[],uint256)', ['0x90', [v4Input('0x080c0f', [single(keyEth500, true, 1_000n * 10n ** 6n, 10n ** 18n), settleAll(ZERO, 10n ** 18n), takeAll(USDG)])], 1n])));
  assert(s6?.exactOut === true && s6.poolAddress === ID_ETH_500, 'allow-revert flag (0x90): still read as V4_SWAP');
  const s6b = await dec.decode(ev(ur.encodeFunctionData('execute(bytes,bytes[])', ['0x10', [v4Input('0x08', [single(keyEth500, true, 1_000n * 10n ** 6n, 10n ** 18n)])]])));
  assert(s6b?.exactOut === true, 'execute(bytes,bytes[]) without deadline: read');
  // A Universal Router copy (wallet front-end) reads the same way.
  const s6c = await dec.decode(ev(exactOutSingle, ROBINHOOD_UR_COPIES[0]));
  assert(s6c?.exactOut === true && s6c.poolAddress === ID_ETH_500, 'Universal Router copy: V4 buy-exact read');

  // ---- 7. Unknown pool -> skipped (counted "not readable").
  takeUrV4Hour();
  const keyUnknown = { ...keyEth500, fee: 10000, tickSpacing: 200 };
  assert(await dec.decode(ev(exec('0x10', v4Input('0x08', [single(keyUnknown, true, 10n ** 6n, 10n ** 18n)])))) === null, 'unknown pool (buy-exact) -> skipped');
  // Hookless "sell exactly" on an unknown pool: the older reader still reads it (never fewer than today).
  const s7 = await dec.decode(ev(exec('0x10', v4Input('0x06', [single(keyUnknown, true, 10n ** 18n, 0n)]))));
  assert(s7?.poolAddress === v4PoolId(ZERO, USDG, 10000, 200) && s7.dex === 'uniswap-v4', 'unknown pool (sell-exact, no hook): older reader still reads it');
  let h = takeUrV4Hour();
  assert(h.notReadable === 1 && h.reasons[0]?.[0] === 'pool not watched' && h.read === 1 && h.olderReader === 1, 'counters: 1 not readable (pool not watched), 1 read by the older reader');

  // ---- 8. Changing-fee hooks: Fables (has a fee source) read; others skipped.
  const keyFables = { currency0: ZERO, currency1: USDG, fee: V4_DYNAMIC_FEE_FLAG, tickSpacing: 60, hooks: FABLES_HOOK };
  const s8 = await dec.decode(ev(exec('0x10', v4Input('0x06', [single(keyFables, true, 10n ** 18n, 0n)]))));
  assert(s8?.dex === 'fables' && s8.poolAddress === ID_FABLES && s8.feeTier === 2600 && s8.amountIn === 10n ** 18n, 'Fables changing-fee pool: read, fee from the pool list (fee source)');
  const keyMystery = { ...keyFables, hooks: MYSTERY_HOOK };
  assert(await dec.decode(ev(exec('0x10', v4Input('0x06', [single(keyMystery, true, 10n ** 18n, 0n)])))) === null, 'changing-fee hook with no fee source -> skipped');
  const keyHookUnknown = { ...keyFables, hooks: '0x0000000000000000000000000000000000001234' };
  assert(await dec.decode(ev(exec('0x10', v4Input('0x06', [single(keyHookUnknown, true, 10n ** 18n, 0n)])))) === null, 'hooked pool not on our list -> skipped');
  h = takeUrV4Hour();
  assert(h.read === 1 && h.hooked === 1 && h.notReadable === 2 && h.reasons.some(([r]) => r === 'changing-fee pool with no fee source') && h.reasons.some(([r]) => r === 'hooked pool not watched'), 'counters: hooked read + 2 skipped with reasons');

  // ---- 9. Broken or unknown data -> skipped, no crash.
  assert(await dec.decode(ev(exec('0x10', '0x1234'))) === null, 'malformed V4 input -> skipped, no crash');
  assert(await dec.decode(ev(exec('0x10', v4Input('0x08', ['0xdeadbeef'])))) === null, 'malformed swap params -> skipped, no crash');
  const oddSingle = coder.encode([`tuple(${KEY} poolKey,bool zeroForOne,uint128 amount,uint128 limit,uint256 extra,bytes hookData)`],
    [{ poolKey: keyEth500, zeroForOne: true, amount: 10n ** 6n, limit: 10n ** 18n, extra: 5n, hookData: '0x' }]);
  assert(await dec.decode(ev(exec('0x10', v4Input('0x08', [oddSingle])))) === null, 'unknown single-swap layout -> skipped, not guessed');
  assert(await dec.decode(ev(exec('0x10', v4Input('0x08', [single(keyEth500, true, 0n, 10n ** 18n)])))) === null, 'buy-exact with open amount (0) -> skipped');
  h = takeUrV4Hour();
  assert(h.notReadable === 4 && h.read === 0, `counters: 4 not readable (${JSON.stringify(h.reasons)})`);
  assert(takeUrV4Hour().notReadable === 0, 'counters reset after each hour');

  // ---- 10. Hourly report line (only when the switch is on and numbers are passed).
  const base = {
    windowLabel: '13:00 to 14:00', live: false, feedOk: true, feedReconnects: 0, pairs: 1, spots: 1,
    pricesFrom: 'free' as const, freeNodeBusy: 0, differencesFound: 0,
    checks: { done: 0, makeMoney: 0, loseMoney: 0, wouldFail: 0, nodeBusy: 0 }, checksAvailable: true,
    earned: { todayChecked: 0, todayCheckedCount: 0, todayUnchecked: 0, todayUncheckedCount: 0, weekChecked: 0 },
    reactionMs: { typical: null, slowest5pct: null }, topDifferences: [],
  };
  const funnel = { tradesRead: 10, noPool: 0, noPartner: 0, noUsdPrice: 0, smallerThanFees: 0, found: 0, belowCheckBar: 0, checkBarUsd: 0.1, notVetted: 0, sentToCheck: 0, skipped: [] as [string, number][] };
  const withV4 = formatPlainHourly({ ...base, funnel: { ...funnel, routerV4: { read: 42, notReadable: 3, topReason: 'pool not watched' } } });
  assert(withV4.includes('Router V4 swaps read: 42') && withV4.includes('3 Router V4 swaps not readable (mostly: pool not watched)'), 'report: "Router V4 swaps read: N" line');
  assert(!formatPlainHourly({ ...base, funnel }).includes('Router V4'), 'report: no Router V4 line when the switch is off');
  off();
}

main().catch((err) => { console.error('FAIL: Router V4 formats test crashed', err); process.exitCode = 1; });
