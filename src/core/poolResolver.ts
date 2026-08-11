import { ethers } from 'ethers';
import { PoolState, ChainName } from './types';

// ============================================================================
// POOL RESOLVER — just-in-time pool discovery for v2-style DEXs
//
// The decoder can only tell us which ROUTER a swap went through (that's
// what appears in the raw calldata/logs). Routers proxy to many different
// pools depending on path, so the router address is NOT the pool address.
// This module bridges that gap: given a router's factory contract and the
// token pair from a decoded swap, it resolves the REAL pool/pair address
// on-chain (factory.getPair) and fetches its live reserves, so the pool
// can be registered in the cache with real, current on-chain data — not
// guessed or hardcoded.
// ============================================================================

const V2_FACTORY_ABI = ['function getPair(address tokenA, address tokenB) view returns (address pair)'];
const V2_PAIR_ABI = [
'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
'function token0() view returns (address)',
'function token1() view returns (address)',
];

export async function resolveAndFetchV2Pool(
provider: ethers.JsonRpcProvider,
chain: ChainName,
dex: string,
factoryAddress: string,
tokenA: string,
tokenB: string,
feeBps: number,
): Promise<PoolState | null> {
try {
const factory = new ethers.Contract(factoryAddress, V2_FACTORY_ABI, provider);
const pairAddress: string = await factory.getPair(tokenA, tokenB);
if (!pairAddress || pairAddress === ethers.ZeroAddress) return null; // no pool for this pair on this DEX — normal, not an error

const pair = new ethers.Contract(pairAddress, V2_PAIR_ABI, provider);
const [reserves, token0, token1] = await Promise.all([
pair.getReserves(),
pair.token0(),
pair.token1(),
]);

return {
chain,
dex,
poolAddress: pairAddress,
poolType: 'v2',
tokenA: token0,
tokenB: token1,
reserveA: reserves[0],
reserveB: reserves[1],
feeBps,
lastUpdatedBlock: 0,
lastUpdatedMs: Date.now(),
};
} catch {
// Factory call reverted, RPC hiccup, or malformed response — treat as
// "couldn't resolve right now", never crash the hot path over a lookup.
return null;
}
}
