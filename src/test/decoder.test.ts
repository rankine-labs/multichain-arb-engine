import { ethers } from 'ethers';
import { TransactionDecoder, TOPIC_V2_SWAP, TOPIC_V3_SWAP, TOPIC_PANCAKE_V3_SWAP, RouterRegistry } from '../core/decoder';
import { PoolState, RawChainEvent } from '../core/types';

// Proves the decoder turns real chain data into swaps the engine can use:
//   - Monad Swap logs (V2, Uniswap V3, PancakeSwap V3) from tracked pools
//   - Avalanche pending txs using the to/data the adapter already fetched

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const abi = ethers.AbiCoder.defaultAbiCoder();
const WMON = '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A';   // lower address  -> token0
const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';   // higher address -> token1
const POOL = '0x1111111111111111111111111111111111111111';

// Tracked pool, deliberately listed USDC first to prove token0 is derived
// from address order, not from how we stored the pair.
const tracked: PoolState = {
  chain: 'monad', dex: 'uniswap-v3', poolAddress: POOL, poolType: 'v3',
  tokenA: USDC, tokenB: WMON, feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: 0,
};
const registry: RouterRegistry = { avalanche: {}, monad: {}, robinhood: {} };
const decoder = new TransactionDecoder(registry, undefined, (chain, addr) =>
  chain === 'monad' && addr.toLowerCase() === POOL.toLowerCase() ? tracked : undefined);

const logEvent = (topic: string, data: string, address = POOL): RawChainEvent => ({
  chain: 'monad', stateType: 'SPECULATIVE', blockOrSeq: 1, receivedAtMs: 123,
  raw: { address, topics: [topic, ethers.ZeroHash, ethers.ZeroHash], data },
});

async function main() {
  // 1. Uniswap V3: someone pays 5,000 USDC (token1) in, gets 160,000 WMON (token0) out.
  const v3Data = abi.encode(['int256', 'int256', 'uint160', 'uint128', 'int24'],
    [-(160_000n * 10n ** 18n), 5_000n * 10n ** 6n, 1n << 96n, 10n ** 18n, 0]);
  const v3 = await decoder.decode(logEvent(TOPIC_V3_SWAP, v3Data));
  assert(v3?.tokenIn === USDC && v3?.tokenOut === WMON, 'V3: positive amount1 -> token1 (USDC) went in');
  assert(v3?.amountIn === 5_000n * 10n ** 6n && v3?.amountOutObserved === 160_000n * 10n ** 18n, 'V3: amounts decoded');
  assert(v3?.dex === 'uniswap-v3' && v3?.stateType === 'SPECULATIVE' && v3?.detectedAtMs === 123, 'V3: dex, state and timing carried over');

  // 2. PancakeSwap V3 (two extra fields): WMON in, USDC out.
  const cakeData = abi.encode(['int256', 'int256', 'uint160', 'uint128', 'int24', 'uint128', 'uint128'],
    [100_000n * 10n ** 18n, -(3_000n * 10n ** 6n), 1n << 96n, 10n ** 18n, 0, 0n, 0n]);
  const cake = await decoder.decode(logEvent(TOPIC_PANCAKE_V3_SWAP, cakeData));
  assert(cake?.tokenIn === WMON && cake?.amountIn === 100_000n * 10n ** 18n, 'Pancake V3: positive amount0 -> token0 (WMON) went in');

  // 3. V2 style: 50,000 WMON (token0) in, 1,500 USDC (token1) out.
  const v2Data = abi.encode(['uint256', 'uint256', 'uint256', 'uint256'], [50_000n * 10n ** 18n, 0n, 0n, 1_500n * 10n ** 6n]);
  const v2 = await decoder.decode(logEvent(TOPIC_V2_SWAP, v2Data));
  assert(v2?.tokenIn === WMON && v2?.amountIn === 50_000n * 10n ** 18n && v2?.amountOutObserved === 1_500n * 10n ** 6n, 'V2: amount0In -> WMON in, USDC out');

  // 4. Ignored correctly.
  assert(await decoder.decode(logEvent(TOPIC_V3_SWAP, v3Data, '0x2222222222222222222222222222222222222222')) === null, 'untracked pool ignored');
  assert(await decoder.decode(logEvent('0x' + 'ab'.repeat(32), v3Data)) === null, 'non-Swap event ignored');
  assert(await decoder.decode(logEvent(TOPIC_V3_SWAP, '0x1234')) === null, 'malformed log ignored, no crash');

  // 5. Avalanche: uses the to/data the adapter already fetched (no provider needed).
  const ROUTER = '0x60aE616a2155Ee3d9A68541Ba4544862310933d4';
  const avaxRegistry: RouterRegistry = { avalanche: { [ROUTER.toLowerCase()]: { dex: 'traderjoe-v1', style: 'v2' } }, monad: {}, robinhood: {} };
  const avax = new TransactionDecoder(avaxRegistry); // no provider on purpose
  const iface = new ethers.Interface(['function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)']);
  const WAVAX = '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7';
  const AUSDC = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
  const data = iface.encodeFunctionData('swapExactTokensForTokens', [10n ** 20n, 0n, [WAVAX, AUSDC], ROUTER, 9_999_999_999n]);
  const swap = await avax.decode({ chain: 'avalanche', stateType: 'PENDING', blockOrSeq: 'pending', receivedAtMs: 1, raw: { to: ROUTER, data, hash: '0xabc' } });
  assert(swap?.tokenIn === WAVAX && swap?.amountIn === 10n ** 20n && swap?.dex === 'traderjoe-v1', 'Avalanche pending tx decoded without a provider (was always null)');

  // 6. Router patterns seen in the live Robinhood probe.
  const SR02 = '0xCaf681a66D020601342297493863E78C959E5cb2';   // SwapRouter02
  const UR = '0x8876789976decbfcbbbe364623c63652db8c0904';     // Universal Router
  const V2R = '0x89e5db8b5aa49aa85ac63f691524311aeb649eba';    // V2 router
  const RH_WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
  const RH_USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
  const OTHER = '0x9999999999999999999999999999999999999999';
  const rhRegistry: RouterRegistry = { avalanche: {}, monad: {}, robinhood: {
    [SR02.toLowerCase()]: { dex: 'uniswap-v3', style: 'v3', v2Via: V2R },
    [UR.toLowerCase()]: { dex: 'uniswap-universal', style: 'ur', v3Via: SR02, v2Via: V2R },
    [V2R.toLowerCase()]: { dex: 'uniswap-v2', style: 'v2' },
  } };
  const rh = new TransactionDecoder(rhRegistry);
  const rhEvent = (to: string, data: string, value = '0'): RawChainEvent =>
    ({ chain: 'robinhood', stateType: 'SEQUENCED', blockOrSeq: 1, receivedAtMs: 1, raw: { to, data, value } });

  const sr02 = new ethers.Interface([
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96))',
    'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum))',
    'function multicall(uint256 deadline, bytes[] data)',
  ]);
  const single = sr02.encodeFunctionData('exactInputSingle', [{ tokenIn: RH_WETH, tokenOut: RH_USDG, fee: 500, recipient: OTHER, amountIn: 7n * 10n ** 17n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }]);
  const wrapped = sr02.encodeFunctionData('multicall', [9_999_999_999n, [single]]);
  const s1 = await rh.decode(rhEvent(SR02, wrapped));
  assert(s1?.tokenIn === RH_WETH && s1?.tokenOut === RH_USDG && s1?.amountIn === 7n * 10n ** 17n && s1?.poolAddress === SR02,
    'SwapRouter02 exactInputSingle inside multicall(deadline, ...) decoded');

  // Multi-hop exactInput: WETH -(500)-> USDG -(3000)-> OTHER. First hop only.
  const path = ethers.solidityPacked(['address', 'uint24', 'address', 'uint24', 'address'], [RH_WETH, 500, RH_USDG, 3000, OTHER]);
  const multi = sr02.encodeFunctionData('exactInput', [{ path, recipient: OTHER, amountIn: 10n ** 18n, amountOutMinimum: 0n }]);
  const s2 = await rh.decode(rhEvent(SR02, multi));
  assert(s2?.tokenIn === RH_WETH && s2?.tokenOut === RH_USDG, 'exactInput multi-hop: first hop WETH -> USDG (used to return no tokens)');

  // Universal Router: WRAP_ETH (0x0b, skipped) then V3_SWAP_EXACT_IN (0x00).
  const urIface = new ethers.Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline)']);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const wrapIn = coder.encode(['address', 'uint256'], [UR, 10n ** 18n]);
  const v3In = coder.encode(['address', 'uint256', 'uint256', 'bytes', 'bool'], [OTHER, 3n * 10n ** 18n, 0n, ethers.solidityPacked(['address', 'uint24', 'address'], [RH_WETH, 500, RH_USDG]), false]);
  const urCall = urIface.encodeFunctionData('execute', ['0x0b00', [wrapIn, v3In], 9_999_999_999n]);
  const s3 = await rh.decode(rhEvent(UR, urCall));
  assert(s3?.tokenIn === RH_WETH && s3?.amountIn === 3n * 10n ** 18n && s3?.poolAddress === SR02 && s3?.dex === 'uniswap-v3',
    'Universal Router V3 swap decoded and routed to the V3 router for pool lookup');

  // Universal Router V2 swap (0x08), with the "allow revert" flag bit set (0x88).
  const v2In = coder.encode(['address', 'uint256', 'uint256', 'address[]', 'bool'], [OTHER, 5n * 10n ** 6n, 0n, [RH_USDG, RH_WETH], true]);
  const s4 = await rh.decode(rhEvent(UR, urIface.encodeFunctionData('execute', ['0x88', [v2In], 9_999_999_999n])));
  assert(s4?.tokenIn === RH_USDG && s4?.poolAddress === V2R && s4?.dex === 'uniswap-v2', 'Universal Router V2 swap decoded (flag bits ignored)');

  // "Use whole balance" placeholder amount can't be sized -> skipped.
  const balIn = coder.encode(['address', 'uint256', 'uint256', 'bytes', 'bool'], [OTHER, 1n << 255n, 0n, ethers.solidityPacked(['address', 'uint24', 'address'], [RH_WETH, 500, RH_USDG]), false]);
  assert(await rh.decode(rhEvent(UR, urIface.encodeFunctionData('execute', ['0x00', [balIn], 1n]))) === null, 'contract-balance placeholder amount skipped');

  // V2 router multi-hop + native-coin swap uses tx value.
  const v2Iface = new ethers.Interface(['function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline)']);
  const eth = v2Iface.encodeFunctionData('swapExactETHForTokens', [0n, [RH_WETH, RH_USDG, OTHER], OTHER, 9_999_999_999n]);
  const s5 = await rh.decode(rhEvent(V2R, eth, (2n * 10n ** 18n).toString()));
  assert(s5?.amountIn === 2n * 10n ** 18n && s5?.tokenOut === RH_USDG, 'native-coin swap: amount from tx value, first hop only');
}

main().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; });
