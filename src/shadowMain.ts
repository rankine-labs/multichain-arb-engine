import 'dotenv/config';
import { ethers } from 'ethers';
import { resolveAndFetchV2Pool, resolveAndFetchLBPool, resolveAndFetchV3Pool, resolveAndFetchV4Pool, resolveKuruMarket, refetchV2PoolPrice, refetchV3PoolPrice } from './core/poolResolver';
import { ChainManager } from './core/chainManager';
import { PoolCache } from './core/poolCache';
import { PoolDiscoveryEngine, DiscoveryConfig } from './core/poolDiscovery';
import { ShadowLogger } from './core/shadowLogger';
import { TransactionDecoder, DEFAULT_ROUTER_REGISTRY } from './core/decoder';
import { FastFilter } from './core/fastFilter';
import { PriceOracle } from './core/priceOracle';
import { findOptimalTradeSize, calculateAllInProfit, buildOpportunity, calculateLiquidityCeiling } from './core/profitCalculator';
import { scoreOpportunity, shouldPreArm } from './core/opportunityScorer';
import { seedKnownAddresses } from './config/knownAddresses';
import { ethers as ethersV5 } from 'ethers-v5';
import { MONAD_KURU, MONAD_BEAN, ROBINHOOD_V2, ROBINHOOD_V3, ROBINHOOD_V4, ROBINHOOD_TOKENS } from './config/knownAddresses';
import { sendTelegramMessage } from './core/telegramSender';
import { formatHourlySummary, formatSkippedOpportunity , formatDailySummary} from './core/telegramFormatter';
import { RobinhoodChainAdapter } from './chains/robinhoodChain';
import { MonadAdapter } from './chains/monad';
import { AvalancheAdapter } from './chains/avalanche';
import { RawChainEvent } from './core/types';

async function main() {
const cache = new PoolCache();
const shadowLogger = new ShadowLogger();
const chainManager = new ChainManager();
const routerRegistry = structuredClone(DEFAULT_ROUTER_REGISTRY);
seedKnownAddresses(routerRegistry);
const decoder = new TransactionDecoder(routerRegistry);
const filter = new FastFilter(cache);
const priceOracle = new PriceOracle(cache);

    // Read-only provider for JIT pool resolution (factory.getPair + reserve
    // reads) — separate from the WebSocket providers used for event feeds,
    // and explicit chainId since the public AVAX endpoint doesn't support
    // eth_chainId auto-detection (see avalanche.ts for the same fix).
    const avalancheReadProvider = new ethers.JsonRpcProvider('https://api.avax.network/ext/bc/C/rpc', 43114);
      const monadReadProvider = new ethers.JsonRpcProvider('https://rpc.monad.xyz', 143);
      const robinhoodReadProvider = new ethers.JsonRpcProvider('https://rpc.mainnet.chain.robinhood.com', 4663);

const discoveryConfigs: Record<string, DiscoveryConfig> = {
avalanche: {
chain: 'avalanche',
minLiquidityUsd: 50_000,
minRecent24hVolumeUsd: 20_000,
    approvedDexes: new Set(['traderjoe-v1', 'traderjoe-lb', 'pharaoh', 'sushiswap']),
},
monad: {
chain: 'monad',
minLiquidityUsd: 25_000,
minRecent24hVolumeUsd: 10_000,
    approvedDexes: new Set(['uniswap-v3', 'bean-exchange', 'kuru']),
},
robinhood: {
chain: 'robinhood',
minLiquidityUsd: 25_000,
minRecent24hVolumeUsd: 10_000,
    approvedDexes: new Set(['arcus', 'uniswap-v2', 'uniswap-v3', 'pleiades']),
},
};

const discoveryEngines = Object.fromEntries(
Object.entries(discoveryConfigs).map(([chain, cfg]) => [chain, new PoolDiscoveryEngine(cfg, cache)]),
);

      // Gate every JIT-resolved pool through discovery approval before it's
      // trusted: DEX must be on the approved list for that chain, and it must
      // actually have liquidity on both sides. See poolDiscovery.ts's
      // evaluateLiveDiscovery for what this does and does NOT check yet (no
      // volume gate — that needs historical event-log scanning, not built).
      function registerIfApproved(chain: 'avalanche' | 'monad' | 'robinhood', dex: string, resolved: any): boolean {
            const hasNonZeroLiquidity = (resolved.reserveA ?? 0n) > 0n && (resolved.reserveB ?? 0n) > 0n;
            const gate = discoveryEngines[chain].evaluateLiveDiscovery({ chain: resolved.chain, dex, hasNonZeroLiquidity });
            if (!gate.approved) {
                  console.log(`[discovery] rejected ${dex} pool on ${chain}: ${gate.rejections.join(', ')}`);
                  return false;
            }
            cache.upsert(resolved);
            return true;
      }

      // Checks its own homework: after a delay, re-read both pools' CURRENT
      // price directly from chain and see whether the spread that made this
      // look profitable still exists. If it closed, something almost
      // certainly traded through it \u2014 the honest read is WOULD_HAVE_LOST,
      // since shadow mode never actually submitted anything to win the race.
      // If it's still open, nothing visibly beat us to it \u2014 WOULD_HAVE_WON.
      //
      // NOTE ON SCOPE: this is a lighter-weight spread check, not a full
      // re-run of the profit calculator (fees, sizing, slippage). It answers
      // "did the underlying price gap close" \u2014 the dominant signal for
      // whether someone else captured it \u2014 not "would our exact sized trade
      // still clear $20 net." That fuller re-run is a reasonable next step.
      function scheduleOutcomeCheck(opportunity: any, buyPool: any, sellPool: any) {
            const providerByChain: Record<string, ethers.JsonRpcProvider> = {
                  avalanche: avalancheReadProvider,
                  monad: monadReadProvider,
                  robinhood: robinhoodReadProvider,
            };
            const provider = providerByChain[opportunity.chain];
            if (!provider) return;

            setTimeout(async () => {
                  try {
                        const refetch = (pool: any) =>
                              pool.poolType === 'v3' ? refetchV3PoolPrice(provider, pool) : refetchV2PoolPrice(provider, pool);
                        const [freshBuy, freshSell] = await Promise.all([refetch(buyPool), refetch(sellPool)]);
                        if (!freshBuy || !freshSell) return;

                        const priceOf = (pool: any): number | null => {
                              if (pool.poolType === 'v3' && pool.sqrtPriceX96) {
                                    const p = Number(pool.sqrtPriceX96) / 2 ** 96;
                                    return p * p;
                              }
                              if (pool.reserveA && pool.reserveB && pool.reserveA > 0n) {
                                    return Number(pool.reserveB) / Number(pool.reserveA);
                              }
                              return null;
                        };

                        const buyPrice = priceOf(freshBuy);
                        const sellPrice = priceOf(freshSell);
                        if (buyPrice === null || sellPrice === null || buyPrice <= 0) return;

                        const freshSpreadPct = (sellPrice - buyPrice) / buyPrice;

                        if (freshSpreadPct > 0.001) {
                              shadowLogger.resolve(opportunity.id, 'WOULD_HAVE_WON');
                        } else {
                              shadowLogger.resolve(opportunity.id, 'WOULD_HAVE_LOST');
                        }
                  } catch {
                        // never crash the process over an outcome check
                  }
            }, 8000);
      }

chainManager.register(new RobinhoodChainAdapter());
chainManager.register(new MonadAdapter());
chainManager.register(new AvalancheAdapter());

chainManager.onEvent(async (event: RawChainEvent) => {
const t0 = Date.now();

const swap = await decoder.decode(event);
if (!swap) return;

const filterResult = filter.evaluate(swap);
if (!filterResult.pass) return;

let pool = cache.get(swap.chain, swap.poolAddress);

    // Just-in-time pool discovery: swap.poolAddress is the ROUTER address
    // (routers proxy to many pools, see decoder.ts). If we haven't cached
    // this pool yet and know the router's factory, resolve the REAL pool
    // address on-chain and pull its live reserves — no external API, just
    // the same chain data we're already watching.
    if (!pool) {
        const entry = routerRegistry[swap.chain]?.[swap.poolAddress.toLowerCase()];
        if (entry?.factory && swap.chain === 'avalanche' && entry.style === 'v2') {
            const resolved = await resolveAndFetchV2Pool(
                avalancheReadProvider, swap.chain, entry.dex, entry.factory,
                swap.tokenIn, swap.tokenOut, 30,
                );
if (registerIfApproved('avalanche', entry.dex, resolved)) pool = resolved;
        }

          if (entry?.factory && swap.chain === 'avalanche' && entry.style === 'lb') {
                const resolved = await resolveAndFetchLBPool(
                      avalancheReadProvider, swap.chain, entry.dex, entry.factory,
                      swap.tokenIn, swap.tokenOut, 20,
                      );
                if (registerIfApproved('avalanche', entry.dex, resolved)) pool = resolved;
          }

          if (entry?.factory && swap.chain === 'monad' && entry.style === 'v3') {
                const resolved = await resolveAndFetchV3Pool(
                      monadReadProvider, swap.chain, entry.dex, entry.factory,
                      swap.tokenIn, swap.tokenOut,
                      );
                if (registerIfApproved('monad', entry.dex, resolved)) pool = resolved;
          }

          if (entry?.factory && swap.chain === 'monad' && entry.style === 'lb') {
                const resolved = await resolveAndFetchLBPool(
                      monadReadProvider, swap.chain, entry.dex, entry.factory,
                      swap.tokenIn, swap.tokenOut, 20,
                      );
                if (registerIfApproved('monad', entry.dex, resolved)) pool = resolved;
          }

          if (entry?.factory && swap.chain === 'robinhood' && entry.style === 'v2') {
                const resolved = await resolveAndFetchV2Pool(
                      robinhoodReadProvider, swap.chain, entry.dex, entry.factory,
                      swap.tokenIn, swap.tokenOut, 30,
                      );
                if (registerIfApproved('robinhood', entry.dex, resolved)) pool = resolved;
          }

          if (entry?.factory && swap.chain === 'robinhood' && entry.style === 'v3') {
                const resolved = await resolveAndFetchV3Pool(
                      robinhoodReadProvider, swap.chain, entry.dex, entry.factory,
                      swap.tokenIn, swap.tokenOut,
                      );
                if (registerIfApproved('robinhood', entry.dex, resolved)) pool = resolved;
          }
    }

    const peers = pool ? cache.findPeerPools(swap.chain, swap.tokenIn, swap.tokenOut, pool.poolAddress) : [];
    if (!pool || peers.length === 0) return;
    const sellPool = peers[0];

const tokenInIsA = swap.tokenIn.toLowerCase() === pool.tokenA.toLowerCase();

const usdPerToken = priceOracle.getUsdPrice(swap.chain, swap.tokenIn);
if (usdPerToken === null) return;

const liquidityCeiling = calculateLiquidityCeiling(pool, sellPool, usdPerToken);
if (liquidityCeiling <= 0) return;

const sizing = findOptimalTradeSize(
pool, sellPool, cache, tokenInIsA,
liquidityCeiling,
usdPerToken,
);

if (sizing.grossProfitUsd <= 0) return;

const profit = calculateAllInProfit(sizing, {
gasPriceUsd: 2,
dexFeeBps: { buy: pool.feeBps, sell: sellPool.feeBps },
flashLoanFeeBps: 9,
usingFlashLoan: true,
safetyMarginPct: 0.15,
});

const score = scoreOpportunity({
conservativeNetProfitUsd: profit.conservativeNetProfitUsd,
stateType: swap.stateType,
chain: swap.chain,
});

const opportunity = buildOpportunity(
swap.chain, [swap.tokenIn, swap.tokenOut],
pool.dex, pool.poolAddress, sellPool.dex, sellPool.poolAddress,
sizing, profit, event, score,
);

const reactionMs = Date.now() - t0;

if (!profit.qualifies) {
shadowLogger.record({ opportunity, outcome: 'SKIPPED_BELOW_MIN_PROFIT', ourHypotheticalReactionMs: reactionMs });
      // Only significant near-misses go to Telegram (per architecture doc:
      // "no play-by-play noise") — gross opportunity had to clear a real bar
      // even though it netted below the $20 minimum after costs.
      if (sizing.grossProfitUsd >= 50) {
              // Real per-DEX prices, not just USD amounts, so the person watching
              // Telegram can directly verify the bot is comparing genuine market
              // prices rather than just trusting an opaque dollar figure.
              const priceOf = (p: any): number | null => {
                      if (p.poolType === 'v3' && p.sqrtPriceX96) {
                              const price = Number(p.sqrtPriceX96) / 2 ** 96;
                              return price * price;
                      }
                      if (p.reserveA !== undefined && p.reserveB !== undefined && p.reserveA > 0n) {
                              return Number(p.reserveB) / Number(p.reserveA);
                      }
                      return null;
              };
              const buyPrice = priceOf(pool);
              const sellPrice = priceOf(sellPool);
              if (buyPrice !== null && sellPrice !== null && buyPrice > 0) {
                      const spreadPct = ((sellPrice - buyPrice) / buyPrice) * 100;
                      await sendTelegramMessage(formatSkippedOpportunity({
                              chain: swap.chain,
                              pair: `${swap.tokenIn.slice(0, 8)}.../${swap.tokenOut.slice(0, 8)}...`,
                              buyDex: pool.dex,
                              sellDex: sellPool.dex,
                              buyPrice,
                              sellPrice,
                              spreadPct,
                              grossOpportunityUsd: sizing.grossProfitUsd,
                              optimalTradeUsd: sizing.optimalTradeSizeUsd,
                              expectedNetUsd: profit.conservativeNetProfitUsd,
                              minRequiredUsd: 20,
                      }));
              }
      }
return;
}
if (!shouldPreArm(score)) {
shadowLogger.record({ opportunity, outcome: 'SKIPPED_LOW_SCORE', ourHypotheticalReactionMs: reactionMs });
return;
}

shadowLogger.record({ opportunity, outcome: 'UNRESOLVED', ourHypotheticalReactionMs: reactionMs });
      scheduleOutcomeCheck(opportunity, pool, sellPool);

console.log(
`[opportunity] ${swap.chain} score=${score} net=$${profit.conservativeNetProfitUsd.toFixed(2)} ` +
`reaction=${reactionMs}ms`,
);
});

await chainManager.startAll();

      const startStatus = chainManager.getStatus() as Record<string, { online: boolean }>;
      const startChainParts: string[] = [];
      for (const chainName of Object.keys(startStatus)) {
            const isOnline = startStatus[chainName].online;
            startChainParts.push(chainName + ' ' + (isOnline ? 'OK' : 'DOWN'));
      }
      await sendTelegramMessage('Shadow bot started. Chains: ' + startChainParts.join(', '));

      // Kuru is an order book, not something you find via factory.getPair(),
      // so its market is seeded directly from the known address rather than
      // discovered from swap traffic. This is what gives the Uniswap V3 pool
      // a real second venue to compare against for cross-DEX opportunities.
      const monadKuruProvider = new ethersV5.providers.JsonRpcProvider('https://rpc.monad.xyz');
      const seedKuruMarket = async () => {
            const resolved = await resolveKuruMarket(monadKuruProvider, 'monad', 'kuru', MONAD_KURU.MARKETS.MON_USDC);
            if (resolved) cache.upsert(resolved);
      };
      await seedKuruMarket();
      setInterval(seedKuruMarket, 30_000); // vault liquidity shifts as orders fill — keep it fresh

      // V4 has no per-swap router we can decode yet (its Universal Router uses
      // encoded commands, a separate problem from reading pool state), so this
      // uses the same safe pattern as Kuru: seed a known, verified pair
      // directly from real chain state rather than wait for swap traffic.
      const seedRobinhoodV4Market = async () => {
            const resolved = await resolveAndFetchV4Pool(
                  robinhoodReadProvider, 'robinhood', 'uniswap-v4', ROBINHOOD_V4.STATE_VIEW,
                  ROBINHOOD_TOKENS.WETH, ROBINHOOD_TOKENS.USDG,
                  );
            if (resolved) cache.upsert(resolved);
      };
      await seedRobinhoodV4Market();
      setInterval(seedRobinhoodV4Market, 30_000);
  const lastHealthStatus: Record<string, boolean> = { avalanche: true, monad: true, robinhood: true };
      setInterval(async () => {
            await chainManager.runHealthChecks();
            const status = chainManager.getStatus() as Record<string, { online: boolean; reason?: string }>;
            for (const [chain, info] of Object.entries(status)) {
                  const wasHealthy = lastHealthStatus[chain] ?? true;
                  if (wasHealthy && !info.online) {
                        await sendTelegramMessage(`\u26a0\ufe0f ${chain} went UNHEALTHY: ${info.reason ?? 'unknown reason'}`);
                  } else if (!wasHealthy && info.online) {
                        await sendTelegramMessage(`\u2705 ${chain} recovered and is healthy again`);
                  }
                  lastHealthStatus[chain] = info.online;
            }
      }, 15_000);

setInterval(async () => {
const summary = shadowLogger.summary();
const status = chainManager.getStatus();

const message = formatHourlySummary({
activeChains: {
avalanche: chainManager.isHealthy('avalanche'),
monad: chainManager.isHealthy('monad'),
robinhood: chainManager.isHealthy('robinhood'),
},
seen: summary.opportunitiesSeen,
filtered: 0,
simulated: summary.opportunitiesSeen,
profitable: summary.wouldHaveWon + summary.wouldHaveLost,
attempted: summary.wouldHaveWon + summary.wouldHaveLost,
won: summary.wouldHaveWon,
missed: summary.wouldHaveLost,
reverted: 0,
grossProfitUsd: 0,
allCostsUsd: 0,
netProfitUsd: Number(summary.hypotheticalNetProfitUsd),
bestChain: { chain: 'avalanche', profitUsd: 0 },
bestTrade: { pair: 'n/a', netProfitUsd: 0 },
avgReactionMs: summary.avgReactionMs ?? 0,
p95ReactionMs: summary.p95ReactionMs ?? 0,
});

await sendTelegramMessage(message);
}, 60 * 60 * 1000);

      setInterval(async () => {
            const summary = shadowLogger.summary();
            const message = formatDailySummary({
                  netProfitUsd: Number(summary.hypotheticalNetProfitUsd),
                    byChain: { avalanche: 0, monad: 0, robinhood: 0 },
                  won: summary.wouldHaveWon,
                  missed: summary.wouldHaveLost,
                  reverted: 0,
                  fundingOwnCapitalPct: 0,
                  fundingFlashLoanPct: 100,
                  bestTradeUsd: 0,
                  largestMissedUsd: 0,
                  uptimePct: 100,
            });
            await sendTelegramMessage(message);
      }, 24 * 60 * 60 * 1000);

console.log('Shadow mode running. Pool cache size:', cache.size());
console.log('Chain status:', chainManager.getStatus());
}

main().catch((err) => {
console.error('Fatal error in shadow mode:', err);
process.exit(1);
});
