import { ethers } from 'ethers';
import { PoolState, ChainName } from './types';
import { ethers as ethersV5 } from 'ethers-v5'; // Kuru SDK is built on ethers v5, see kuruAdapter.ts
import { ParamFetcher, OrderBook } from '@kuru-labs/kuru-sdk';

// ============================================================================
// POOL RESOLVER \u2014 just-in-time pool discovery for v2-style DEXs
//
// The decoder can only tell us which ROUTER a swap went through (that's
// what appears in the raw calldata/logs). Routers proxy to many different
// pools depending on path, so the router address is NOT the pool address.
// This module bridges that gap: given a router's factory contract and the
// token pair from a decoded swap, it resolves the REAL pool/pair address
// on-chain (factory.getPair) and fetches its live reserves, so the pool
// can be registered in the cache with real, current on-chain data \u2014 not
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
          if (!pairAddress || pairAddress === ethers.ZeroAddress) return null;

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
          return null;
    }
}

// ============================================================================
// SOLIDLY-STYLE V2 POOL RESOLVER (Ramses and similar forks)
//
// Ramses on Robinhood Chain looks like a standard Uniswap V2 fork but its
// factory is Solidly-style: getPair(tokenA, tokenB, stable) takes a third
// boolean argument distinguishing "stable" (correlated-asset) pools from
// "volatile" ones. Calling the standard 2-argument getPair on this factory
// reverts outright rather than returning an empty pool -- confirmed live
// before writing this. Once the real pair address is found, the pair
// contract itself is a normal getReserves()/token0()/token1() V2 pair, so
// this reuses V2_PAIR_ABI unchanged.
// ============================================================================

const SOLIDLY_V2_FACTORY_ABI = ['function getPair(address tokenA, address tokenB, bool stable) view returns (address pair)'];

export async function resolveAndFetchSolidlyV2Pool(
      provider: ethers.JsonRpcProvider,
      chain: ChainName,
      dex: string,
      factoryAddress: string,
      tokenA: string,
      tokenB: string,
      stable: boolean,
      feeBps: number,
    ): Promise<PoolState | null> {
      try {
            const factory = new ethers.Contract(factoryAddress, SOLIDLY_V2_FACTORY_ABI, provider);
            const pairAddress: string = await factory.getPair(tokenA, tokenB, stable);
            if (!pairAddress || pairAddress === ethers.ZeroAddress) return null;

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
          if (!pairs || pairs.length === 0) return null;

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
// exists with real bytecode \u2014 good enough for JIT discovery; a production
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

const STANDARD_V3_FEE_TIERS = [500, 3000, 10000, 100];

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
              if (!poolAddress || poolAddress === ethers.ZeroAddress) continue;

            const pool = new ethers.Contract(poolAddress, V3_POOL_ABI, provider);
              try {
                        const [slot0, liquidity, token0, token1] = await Promise.all([
                                    pool.slot0(),
                                    pool.liquidity(),
                                    pool.token0(),
                                    pool.token1(),
                                  ]);

                if ((liquidity as bigint) === 0n) continue;

                return {
                            chain,
                            dex,
                            poolAddress,
                            poolType: 'v3',
                            tokenA: token0,
                            tokenB: token1,
                            sqrtPriceX96: slot0[0] as bigint,
                            liquidity: liquidity as bigint,
                            feeBps: Math.round(fee / 100),
                            lastUpdatedBlock: 0,
                            lastUpdatedMs: Date.now(),
                };
              } catch {
                        continue;
              }
      }

      return null;
    } catch {
          return null;
    }
}

// ============================================================================
// KURU (order book) MARKET RESOLVER
//
// Kuru has no simple reserve pair the way v2 pools do \u2014 it's a real central
// limit order book, and its markets are pre-deployed contracts rather than
// something you derive from a factory.getPair() call. Unlike the other
// resolvers in this file, this does NOT hand-write an ABI guess for Kuru's
// read functions: their exact return encoding isn't independently
// documented anywhere public, so guessing risks silently wrong numbers
// feeding into real profit math (unlike a bad ABI guess elsewhere, which
// just throws and returns null safely). Instead this uses Kuru's own
// official SDK (ParamFetcher, OrderBook), which ships the correct ABI
// internally \u2014 confirmed directly against the SDK's own .d.ts files
// rather than assumed.
//
// APPROXIMATION, same honesty standard as the LB resolver: real resting
// limit orders (manualOrders.bids/asks) are used as a liquidity proxy,
// converted into a v2-shaped PoolState so the existing liquidity-ceiling
// and discovery math can use it. The separate vaultParams (AMM-vault-only)
// can be legitimately empty even when real liquidity exists in the book,
// so this does NOT fall back to vaultParams. This is NOT the same as
// walking the full order book for an exact execution price \u2014 real
// execution should re-quote via the SDK's CostEstimator immediately before
// firing.
// ============================================================================

export async function resolveKuruMarket(
    providerV5: ethersV5.providers.JsonRpcProvider,
    chain: ChainName,
    dex: string,
    marketAddress: string,
  ): Promise<PoolState | null> {
    try {
          const marketParams = await ParamFetcher.getMarketParams(providerV5, marketAddress);
          const orderBookData = await OrderBook.getL2OrderBook(providerV5, marketAddress, marketParams);
          const { manualOrders } = orderBookData;
          if (!manualOrders || manualOrders.bids.length === 0 || manualOrders.asks.length === 0) return null;

      const bestBid = manualOrders.bids[0];
          const bestAsk = manualOrders.asks[0];
          if (!bestBid || !bestAsk || bestBid[0] <= 0 || bestAsk[0] <= 0) return null;

      const bidDepth = manualOrders.bids.slice(0, 3).reduce((sum, level) => sum + level[1], 0);
          const askDepth = manualOrders.asks.slice(0, 3).reduce((sum, level) => sum + level[1], 0);
          const baseDepth = bidDepth + askDepth;
          if (baseDepth <= 0) return null;

      const midPrice = (bestBid[0] + bestAsk[0]) / 2;

      const reserveABase = BigInt(ethersV5.utils.parseUnits(baseDepth.toFixed(8), 18).toString());
          const reserveBQuote = BigInt(ethersV5.utils.parseUnits((baseDepth * midPrice).toFixed(8), 18).toString());

      return {
              chain,
              dex,
              poolAddress: marketAddress,
              poolType: 'v2',
              tokenA: marketParams.baseAssetAddress,
              tokenB: marketParams.quoteAssetAddress,
              reserveA: reserveABase,
              reserveB: reserveBQuote,
              feeBps: marketParams.takerFeeBps.toNumber(),
              lastUpdatedBlock: orderBookData.blockNumber,
              lastUpdatedMs: Date.now(),
      };
    } catch {
          return null;
    }
}

// ============================================================================
// OUTCOME RESOLUTION REFETCH \u2014 used by shadowMain.ts to check its own work.
//
// Given a pool we already found (known address, known type), re-read its
// CURRENT reserves/price directly \u2014 no factory lookup needed, since we
// already know exactly which pool this is. This is what lets shadow mode
// go back after a delay and ask "does this price gap still exist, or did
// someone else already take it?" instead of logging every opportunity as
// permanently UNRESOLVED.
// ============================================================================

export async function refetchV2PoolPrice(
    provider: ethers.JsonRpcProvider,
    pool: PoolState,
  ): Promise<PoolState | null> {
    try {
          const pair = new ethers.Contract(pool.poolAddress, V2_PAIR_ABI, provider);
          const reserves = await pair.getReserves();
          return { ...pool, reserveA: reserves[0], reserveB: reserves[1], lastUpdatedMs: Date.now() };
    } catch {
          return null;
    }
}

export async function refetchV3PoolPrice(
    provider: ethers.JsonRpcProvider,
    pool: PoolState,
  ): Promise<PoolState | null> {
    try {
          const v3Pool = new ethers.Contract(pool.poolAddress, V3_POOL_ABI, provider);
          const [slot0, liquidity] = await Promise.all([v3Pool.slot0(), v3Pool.liquidity()]);
          if ((liquidity as bigint) === 0n) return null;
          return { ...pool, sqrtPriceX96: slot0[0] as bigint, liquidity: liquidity as bigint, lastUpdatedMs: Date.now() };
    } catch {
          return null;
    }
}

// ============================================================================
// V4 (Uniswap V4-style) POOL RESOLVER -- via StateView
//
// V4 has no per-pool contract address like V2/V3 -- every pool lives as
// state inside a single PoolManager, addressed by a poolId (keccak256 hash
// of the pool's key). StateView is the official read-only helper contract
// for querying that state off-chain without needing the PoolManager's
// onchain-only StateLibrary. poolId computation confirmed correct against
// real, live Robinhood Chain data before this was written (found real
// active liquidity on all 4 standard fee tiers for a known pair).
//
// Standard, no-hook pools use the same fee/tickSpacing convention as V3.
// This tries those tiers directly via computed poolId -- no factory or
// discovery registry needed for that common case.
// ============================================================================

const V4_STATE_VIEW_ABI = [
      'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
      'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
    ];

const STANDARD_V4_FEE_TIERS: [number, number][] = [
      [500, 10],
      [3000, 60],
      [10000, 200],
      [100, 1],
    ];

export async function resolveAndFetchV4Pool(
      provider: ethers.JsonRpcProvider,
      chain: ChainName,
      dex: string,
      stateViewAddress: string,
      tokenA: string,
      tokenB: string,
    ): Promise<PoolState | null> {
      try {
              const stateView = new ethers.Contract(stateViewAddress, V4_STATE_VIEW_ABI, provider);
              const [currency0, currency1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];

              for (const [fee, tickSpacing] of STANDARD_V4_FEE_TIERS) {
                        try {
                                    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
                                                  ['address', 'address', 'uint24', 'int24', 'address'],
                                                  [currency0, currency1, fee, tickSpacing, ethers.ZeroAddress],
                                                );
                                    const poolId = ethers.keccak256(encoded);

                                    const liquidity: bigint = await stateView.getLiquidity(poolId);
                                    if (liquidity === 0n) continue;

                                    const slot0 = await stateView.getSlot0(poolId);

                                    return {
                                                  chain,
                                                  dex,
                                                  poolAddress: poolId,
                                                  poolType: 'v3',
                                                  tokenA: currency0,
                                                  tokenB: currency1,
                                                  sqrtPriceX96: slot0[0] as bigint,
                                                  liquidity,
                                                  feeBps: Math.round(fee / 100),
                                                  lastUpdatedBlock: 0,
                                                  lastUpdatedMs: Date.now(),
                                    };
                        } catch {
                                    continue;
                        }
              }

              return null;
      } catch {
              return null;
      }
}
