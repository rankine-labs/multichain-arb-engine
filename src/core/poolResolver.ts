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


// ============================================================================
// LB (Liquidity Book) POOL RESOLVER
//
// LFJ's Liquidity Book uses discrete price bins instead of a simple x*y=k
// curve, and a single token pair can have MULTIPLE pools across different
// bin steps (fee tiers). LBFactory.getAllLBPairs() returns every pool for
// a pair; we pick the one with the deepest aggregate reserves as the most
// likely venue for real volume.
//
// IMPORTANT APPROXIMATION, same honesty standard as the Kuru adapter:
// getReserves() returns the pool's TOTAL X/Y across every bin, which this
// treats as a v2-shaped PoolState for liquidity-ceiling and discovery
// purposes. That is NOT exact LB swap math (real execution needs to walk
// bins via the LB quoter), so this is good enough to discover and size a
// candidate opportunity, but real execution must re-verify with a proper
// LB-aware quote immediately before firing.
// ============================================================================

const LB_FACTORY_ABI = [
  'function getAllLBPairs(address tokenX, address tokenY) view returns (tuple(uint16 binStep, address LBPair, bool createdByOwner, bool ignoredForRouting)[] lbPairsAvailable)',
  ];
const LB_PAIR_ABI = [
  'function getReserves() view returns (uint128 reserveX, uint128 reserveY)',
  'function getTokenX() view returns (address)',
  'function getTokenY() view returns (address)',
  ];

export async function resolveAndFetchLBPool(
  provider: ethers.JsonRpcProvider,
  chain: ChainName,
  dex: string,
  factoryAddress: string,
  tokenA: string,
  tokenB: string,
  feeBps: number,
  ): Promise<PoolState | null> {
  try {
    const factory = new ethers.Contract(factoryAddress, LB_FACTORY_ABI, provider);
    const pairs = await factory.getAllLBPairs(tokenA, tokenB);
    if (!pairs || pairs.length === 0) return null; // no LB pool for this pair — normal, not an error

  // Fetch reserves for every candidate bin-step pool in parallel, then
  // keep whichever has the deepest combined reserves (the real venue).
  const candidates = await Promise.all(
    pairs.map(async (info: any) => {
      try {
        const pair = new ethers.Contract(info.LBPair, LB_PAIR_ABI, provider);
        const [reserves, tokenX, tokenY] = await Promise.all([
          pair.getReserves(),
          pair.getTokenX(),
          pair.getTokenY(),
          ]);
        return { pairAddress: info.LBPair as string, reserveX: reserves[0] as bigint, reserveY: reserves[1] as bigint, tokenX: tokenX as string, tokenY: tokenY as string };
      } catch {
        return null;
      }
    }),
    );

  const valid = candidates.filter((c): c is NonNullable<typeof c> => c !== null);
    if (valid.length === 0) return null;

  // "Deepest" ranked by reserveX alone — good enough as a liquidity proxy
  // since we only need to pick the most-traded bin step, not price it exactly.
  const best = valid.reduce((a, b) => (b.reserveX > a.reserveX ? b : a));

  return {
    chain,
    dex,
    poolAddress: best.pairAddress,
    poolType: 'v2',
    tokenA: best.tokenX,
    tokenB: best.tokenY,
    reserveA: best.reserveX,
    reserveB: best.reserveY,
    feeBps,
    lastUpdatedBlock: 0,
    lastUpdatedMs: Date.now(),
  };
  } catch {
    return null;
  }
}


// ============================================================================
// V3 (Uniswap V3-style) POOL RESOLVER
//
// V3 pools are keyed by (tokenA, tokenB, fee tier), not just the pair, so a
// pair can exist at multiple fee tiers simultaneously. This tries the
// standard fee tiers in order and returns the first pool that actually
// exists with real bytecode — good enough for JIT discovery; a production
// version would compare liquidity across tiers the same way the LB
// resolver picks the deepest bin step.
// ============================================================================

const V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
  ];
const V3_POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  ];

const STANDARD_V3_FEE_TIERS = [500, 3000, 10000, 100]; // 0.05%, 0.3%, 1%, 0.01% — checked in rough order of typical liquidity

export async function resolveAndFetchV3Pool(
  provider: ethers.JsonRpcProvider,
  chain: ChainName,
  dex: string,
  factoryAddress: string,
  tokenA: string,
  tokenB: string,
  ): Promise<PoolState | null> {
  try {
    const factory = new ethers.Contract(factoryAddress, V3_FACTORY_ABI, provider);

  for (const fee of STANDARD_V3_FEE_TIERS) {
    let poolAddress: string;
    try {
      poolAddress = await factory.getPool(tokenA, tokenB, fee);
    } catch {
      continue;
    }
    if (!poolAddress || poolAddress === ethers.ZeroAddress) continue; // no pool at this fee tier — try the next one

    const pool = new ethers.Contract(poolAddress, V3_POOL_ABI, provider);
    try {
      const [slot0, liquidity, token0, token1] = await Promise.all([
        pool.slot0(),
        pool.liquidity(),
        pool.token0(),
        pool.token1(),
        ]);

    if ((liquidity as bigint) === 0n) continue; // pool exists but is empty — not tradeable, try next tier

    return {
      chain,
      dex,
      poolAddress,
      poolType: 'v3',
      tokenA: token0,
      tokenB: token1,
      sqrtPriceX96: slot0[0] as bigint,
      liquidity: liquidity as bigint,
      feeBps: Math.round(fee / 100), // fee here is in hundredths of a bip (e.g. 3000 = 0.3%); convert to bps
      lastUpdatedBlock: 0,
      lastUpdatedMs: Date.now(),
    };
    } catch {
      continue; // this fee tier's pool read failed — try the next one rather than giving up entirely
    }
  }

  return null; // no live pool found at any standard fee tier
  } catch {
    return null;
  }
}
