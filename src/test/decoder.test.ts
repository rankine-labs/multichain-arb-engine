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
}

main().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; });
