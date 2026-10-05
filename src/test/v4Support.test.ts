import { ethers } from 'ethers';
import { buildExecuteCall, decodeExecuteCall, kindForPool, KIND_V3, KIND_V4, BuildInput } from '../execution/executorCalldata';
import { refreshPoolsBatch } from '../core/pairWatcher';
import { v4PoolId } from '../core/poolResolver';
import { findStandingGaps } from '../core/gapScanner';
import { PoolState } from '../core/types';

// Checks the bot side of Uniswap V4 support:
//   - V4 pools with their details map to the contract's V4 hop (to the
//     PoolManager, with fee / tick spacing / native flag); without details
//     they're refused rather than guessed
//   - V4 prices refresh through StateView with the pool id
//   - pool ids match V4's formula (hooks = 0)
//   - a native-ETH V4 pool (WETH as currency0 even when WETH's address is
//     higher) is priced the right way round by the gap scanner

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const PM = '0x8366A39CC670b4001A1121B8f6a443A643E40951';
const SV = '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b';
const Q96 = 2n ** 96n;

// sqrtPriceX96 for "1 token0 = price token1" in raw units.
const sqrtP = (price: number) => BigInt(Math.floor(Math.sqrt(price) * 2 ** 48)) * 2n ** 48n;

const v4Pool = (native: boolean, priceToken1PerToken0Raw: number, fee = 3000): PoolState => ({
  chain: 'robinhood', dex: 'uniswap-v4', poolAddress: v4PoolId(native ? ethers.ZeroAddress : WETH, USDG, fee, 60),
  poolType: 'v3', tokenA: WETH, tokenB: USDG, // WETH (or native ETH) is currency0 here
  sqrtPriceX96: sqrtP(priceToken1PerToken0Raw), liquidity: 10n ** 22n, feeBps: fee / 100,
  lastUpdatedBlock: 0, lastUpdatedMs: Date.now(),
  v4: { fee, tickSpacing: 60, native, poolManager: PM, stateView: SV },
});
const v3Pool: PoolState = {
  chain: 'robinhood', dex: 'uniswap-v3', poolAddress: '0x2222222222222222222222222222222222222222', poolType: 'v3',
  tokenA: WETH, tokenB: USDG, sqrtPriceX96: sqrtP(3000 * 1e6 / 1e18), liquidity: 10n ** 22n, feeBps: 5,
  lastUpdatedBlock: 0, lastUpdatedMs: Date.now(),
};

async function main() {
  // --- hop building ---------------------------------------------------------
  const native = v4Pool(true, 3300 * 1e6 / 1e18);
  assert(kindForPool(native) === KIND_V4, 'V4 pool with details -> V4 hop');
  const { v4, ...noDetails } = native; void v4;
  assert(kindForPool(noDetails as PoolState) === null, 'V4 pool without details -> refused, not guessed');
  assert(kindForPool(v3Pool) === KIND_V3, 'V3 pool unchanged');

  const input: BuildInput = {
    chain: 'robinhood', tokenIn: USDG, buyPool: v3Pool, sellPool: native,
    tradeSizeUsd: 1_000, netProfitUsd: 10, usdPerTokenIn: 1, tokenInDecimals: 6, maxBlock: 100n,
  };
  const r = buildExecuteCall(input);
  assert(r.ok, `build V3 -> V4 route (${'reason' in r ? r.reason : 'ok'})`);
  if (r.ok) {
    const sell = r.hops[1];
    assert(sell.kind === KIND_V4 && sell.pool.toLowerCase() === PM.toLowerCase(), 'V4 hop goes to the PoolManager');
    assert(sell.v4Fee === 3000 && sell.v4TickSpacing === 60 && sell.v4Native === true, 'V4 hop carries fee, spacing, native flag');
    assert(sell.tokenIn.toLowerCase() === WETH.toLowerCase() && sell.tokenOut.toLowerCase() === USDG.toLowerCase(), 'V4 hop sells WETH for USDG');
    const decoded = decodeExecuteCall(r.data);
    const hop0 = decoded[0].hops[0];
    assert(Number(hop0.v4Fee) === 0 && hop0.v4Native === false, 'V3 hop encoded with empty V4 fields');
    assert(Number(decoded[0].hops[1].kind) === KIND_V4, 'calldata round-trips the V4 hop');
  }

  // --- pool id ----------------------------------------------------------------
  const expected = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint24', 'int24', 'address'], [ethers.ZeroAddress, USDG, 3000, 60, ethers.ZeroAddress]));
  assert(native.poolAddress === expected, 'pool id = keccak(currency0, currency1, fee, spacing, hooks=0)');

  // --- batch refresh through StateView ---------------------------------------
  const w = (n: bigint) => n.toString(16).padStart(64, '0');
  let seen: { target: string; data: string }[] = [];
  const fresh = await refreshPoolsBatch(async (calls) => {
    seen = calls;
    return calls.map((c) => c.data.startsWith(ethers.id('getSlot0(bytes32)').slice(0, 10)) ? '0x' + w(Q96) + w(0n) + w(0n) + w(0n) : '0x' + w(12345n));
  }, [native]);
  assert(seen.length === 2 && seen.every((c) => c.target === SV), 'V4 refresh asks StateView (2 reads)');
  assert(seen[0].data.endsWith(native.poolAddress.slice(2)), 'V4 refresh passes the pool id');
  assert(fresh[0]?.sqrtPriceX96 === Q96 && fresh[0]?.liquidity === 12345n, 'V4 state updated from batch');

  // --- gap scanner orientation -------------------------------------------------
  // USDG has the HIGHER address than WETH? Either way, tokenA is the pool's
  // currency0 side, so a 3,300 V4 price vs 3,000 on V3 must show WETH cheap
  // on V3 and dear on V4 -> buy on V3, sell on V4.
  const dec = (t: string) => (t === WETH.toLowerCase() ? 18 : t === USDG.toLowerCase() ? 6 : undefined);
  const usd = (t: string) => (t === USDG.toLowerCase() ? 1 : t === WETH.toLowerCase() ? 3000 : null);
  const gaps = findStandingGaps([[v3Pool, native]], dec, usd, { minProfitUsd: 1, flashFee: 0.0005, gasUsd: 0.05, maxTradeUsd: 5_000 });
  assert(gaps.length === 1 && gaps[0].buyPool === v3Pool && gaps[0].sellPool === native, 'gap found: buy WETH on V3 (3,000), sell on V4 (3,300)');
}

main().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; });

// ---------------------------------------------------------------------------
// Reading V4 trades from the feed: a Universal Router V4_SWAP command is
// decoded straight to the exact V4 pool (id), with native ETH reported as WETH.
// ---------------------------------------------------------------------------
import { TransactionDecoder, RouterRegistry } from '../core/decoder';
import { seedKnownAddresses, ROBINHOOD_V4 } from '../config/knownAddresses';

async function decoderV4() {
  const reg: RouterRegistry = { avalanche: {}, monad: {}, robinhood: {} };
  seedKnownAddresses(reg);
  const dec = new TransactionDecoder(reg);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const ur = new ethers.Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline)']);
  const ev = (data: string) => ({ chain: 'robinhood' as const, stateType: 'SEQUENCED' as const, blockOrSeq: 1, receivedAtMs: 1, raw: { to: ROBINHOOD_V4.UNIVERSAL_ROUTER, data, value: '0' } });
  const KEY = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
  const ZERO = ethers.ZeroAddress;

  // Native ETH -> USDG, single pool 0.05% / spacing 10. Actions: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL.
  const single = coder.encode([`tuple(${KEY} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`],
    [{ poolKey: { currency0: ZERO, currency1: USDG, fee: 500, tickSpacing: 10, hooks: ZERO }, zeroForOne: true, amountIn: 2n * 10n ** 18n, amountOutMinimum: 0n, hookData: '0x' }]);
  const settle = coder.encode(['address', 'uint256'], [ZERO, 2n * 10n ** 18n]);
  const take = coder.encode(['address', 'uint256'], [USDG, 0n]);
  const v4Input = coder.encode(['bytes', 'bytes[]'], ['0x060c0f', [single, settle, take]]);
  const s1 = await dec.decode(ev(ur.encodeFunctionData('execute', ['0x10', [v4Input], 1n])));
  assert(s1?.dex === 'uniswap-v4' && s1.poolAddress === v4PoolId(ZERO, USDG, 500, 10), 'V4 single swap -> exact V4 pool id');
  assert(s1?.tokenIn.toLowerCase() === WETH.toLowerCase() && s1?.tokenOut.toLowerCase() === USDG.toLowerCase() && s1?.amountIn === 2n * 10n ** 18n, 'native ETH reported as WETH, amount read');

  // Multi-hop exact-in: USDG -> WETH (0.3%) -> ...: first hop is decoded.
  const multi = coder.encode(['tuple(address currencyIn,tuple(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,uint128 amountIn,uint128 amountOutMinimum)'],
    [{ currencyIn: USDG, path: [{ intermediateCurrency: WETH, fee: 3000, tickSpacing: 60, hooks: ZERO, hookData: '0x' }], amountIn: 5_000n * 10n ** 6n, amountOutMinimum: 0n }]);
  const v4Multi = coder.encode(['bytes', 'bytes[]'], ['0x07', [multi]]);
  const s2 = await dec.decode(ev(ur.encodeFunctionData('execute', ['0x10', [v4Multi], 1n])));
  const [c0, c1] = WETH.toLowerCase() < USDG.toLowerCase() ? [WETH, USDG] : [USDG, WETH];
  assert(s2?.poolAddress === v4PoolId(c0, c1, 3000, 60) && s2?.tokenIn.toLowerCase() === USDG.toLowerCase(), 'V4 multi-hop: first hop decoded to its pool');

  // Hooked pool and "use whole balance" (0) are skipped.
  const hooked = coder.encode([`tuple(${KEY} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`],
    [{ poolKey: { currency0: ZERO, currency1: USDG, fee: 500, tickSpacing: 10, hooks: '0x000000000000000000000000000000000000BEEF' }, zeroForOne: true, amountIn: 10n ** 18n, amountOutMinimum: 0n, hookData: '0x' }]);
  assert(await dec.decode(ev(ur.encodeFunctionData('execute', ['0x10', [coder.encode(['bytes', 'bytes[]'], ['0x06', [hooked]])], 1n]))) === null, 'hooked V4 pool skipped');
  const openDelta = coder.encode([`tuple(${KEY} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`],
    [{ poolKey: { currency0: ZERO, currency1: USDG, fee: 500, tickSpacing: 10, hooks: ZERO }, zeroForOne: true, amountIn: 0n, amountOutMinimum: 0n, hookData: '0x' }]);
  assert(await dec.decode(ev(ur.encodeFunctionData('execute', ['0x10', [coder.encode(['bytes', 'bytes[]'], ['0x06', [openDelta]])], 1n]))) === null, 'amount 0 (use open balance) skipped');
}
decoderV4().catch((err) => { console.error('FAIL: decoder V4 test crashed', err); process.exitCode = 1; });
