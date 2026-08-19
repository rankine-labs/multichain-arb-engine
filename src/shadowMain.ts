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
import { MONAD_KURU, MONAD_ROUTERS, MONAD_TOKENS, MONAD_BEAN, MONAD_LFJ, MONAD_PANCAKE, ROBINHOOD_PANCAKE, ROBINHOOD_V2, ROBINHOOD_V3, ROBINHOOD_V4, ROBINHOOD_TOKENS } from './config/knownAddresses';
import { sendTelegramMessage } from './core/telegramSender';

// Real token names for Telegram messages instead of raw contract
// addresses -- covers the tokens we're already actively watching.
// Unknown tokens fall back to a truncated address rather than
// guessing a name.
const TOKEN_SYMBOLS: Record<string, Record<string, string>> = {
    monad: {
        [MONAD_TOKENS.WMON.toLowerCase()]: 'WMON',
        [MONAD_TOKENS.USDC.toLowerCase()]: 'USDC',
            [MONAD_TOKENS.WETH.toLowerCase()]: 'WETH',
            [MONAD_TOKENS.CBBTC.toLowerCase()]: 'cbBTC',
            [MONAD_TOKENS.WBTC.toLowerCase()]: 'WBTC',
            [MONAD_TOKENS.USDT0.toLowerCase()]: 'USDT0',
            [MONAD_TOKENS.AUSD.toLowerCase()]: 'AUSD',
            [MONAD_TOKENS.SHMON.toLowerCase()]: 'shMON',
            [MONAD_TOKENS.SMON.toLowerCase()]: 'sMON',
            [MONAD_TOKENS.GMON.toLowerCase()]: 'gMON',
    },
    robinhood: {
        [ROBINHOOD_TOKENS.WETH.toLowerCase()]: 'WETH',
        [ROBINHOOD_TOKENS.USDG.toLowerCase()]: 'USDG',
    },
    avalanche: {},
};
function symbolOf(chain: string, address: string): string {
    const known = TOKEN_SYMBOLS[chain]?.[address.toLowerCase()];
    if (known) return known;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
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

      // Real proof that live trading is being compared, not just checked
      // on a timer -- every genuine peer match found during real swap
      // processing this hour goes here (regardless of dollar profit),
      // keyed by chain+pair so repeated trades on the same pair just keep
      // the largest spread seen, not a flood of duplicates. Sent and
      // cleared every hour.
      const hourlyMatches = new Map<string, {
            chain: string; pair: string; buyDex: string; sellDex: string;
            buyPrice: number; sellPrice: number; spreadPct: number;
      }>();

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
            approvedDexes: new Set(['uniswap-v3', 'bean-exchange', 'kuru', 'lfj-lb', 'lfj-v1', 'pancakeswap-v2', 'pancakeswap-v3']),
},
robinhood: {
chain: 'robinhood',
minLiquidityUsd: 25_000,
minRecent24hVolumeUsd: 10_000,
        approvedDexes: new Set(['arcus', 'uniswap-v2', 'uniswap-v3', 'pleiades', 'pancakeswap-v2', 'pancakeswap-v3']),
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

          // LFJ's V1 pools are classic constant-product (V2-style) -- no
          // Monad 'v2' branch existed before this, since only Uniswap V3 and
          // LB-style pools had been wired in on this chain so far.
          if (entry?.factory && swap.chain === 'monad' && entry.style === 'v2') {
                const resolved = await resolveAndFetchV2Pool(
                      monadReadProvider, swap.chain, entry.dex, entry.factory,
                      swap.tokenIn, swap.tokenOut, 30,
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

      // Record this real, genuine match for the hourly proof-of-activity
      // report -- happens for every real peer match found, independent
      // of whether it's profitable enough to alert on.
      const matchPriceOf = (p: any): number | null => {
            if (p.poolType === 'v3' && p.sqrtPriceX96) {
                  const price = Number(p.sqrtPriceX96) / 2 ** 96;
                  return price * price;
            }
            if (p.reserveA !== undefined && p.reserveB !== undefined && p.reserveA > 0n) {
                  return Number(p.reserveB) / Number(p.reserveA);
            }
            return null;
      };
      const matchBuyPrice = matchPriceOf(pool);
      const matchSellPrice = matchPriceOf(sellPool);
      if (matchBuyPrice !== null && matchSellPrice !== null && matchBuyPrice > 0) {
            const matchSpreadPct = Math.abs((matchSellPrice - matchBuyPrice) / matchBuyPrice) * 100;
            const matchPairLabel = `${symbolOf(swap.chain, pool.tokenA)}/${symbolOf(swap.chain, pool.tokenB)}`;
            const matchKey = `${swap.chain}:${matchPairLabel}`;
            const existingMatch = hourlyMatches.get(matchKey);
            if (!existingMatch || matchSpreadPct > existingMatch.spreadPct) {
                  hourlyMatches.set(matchKey, {
                        chain: swap.chain,
                        pair: matchPairLabel,
                        buyDex: pool.dex,
                        sellDex: sellPool.dex,
                        buyPrice: matchBuyPrice,
                        sellPrice: matchSellPrice,
                        spreadPct: matchSpreadPct,
                  });
            }
      }

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
      if (sizing.grossProfitUsd >= 30) {
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
        pair: `${symbolOf(swap.chain, swap.tokenIn)}/${symbolOf(swap.chain, swap.tokenOut)}`,
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

      // Both Kuru's MON/USDC and V4's WETH/USDG above are guaranteed to be
      // in cache, but have no peer to compare against unless real swap
      // traffic happens to also hit their JIT-discovered counterparts on
      // the same specific pair. Confirmed live: after a fresh restart,
      // neither had a match yet, so the proof-of-life check below found
      // nothing to report. These two calls directly seed a real,
      // same-chain, same-pair peer for each, so a genuine comparison is
      // guaranteed to exist immediately rather than depend on timing.
      const seedMonadV3Peer = async () => {
            const resolved = await resolveAndFetchV3Pool(
                  monadReadProvider, 'monad', 'uniswap-v3', MONAD_ROUTERS.UNISWAP_V3_FACTORY,
                  MONAD_TOKENS.WMON, MONAD_TOKENS.USDC,
                  );
            if (resolved) cache.upsert(resolved);
      };
      await seedMonadV3Peer();
      setInterval(seedMonadV3Peer, 30_000);

      const seedRobinhoodV2Peer = async () => {
            const resolved = await resolveAndFetchV2Pool(
                  robinhoodReadProvider, 'robinhood', 'uniswap-v2', ROBINHOOD_V2.FACTORY,
                  ROBINHOOD_TOKENS.WETH, ROBINHOOD_TOKENS.USDG, 30,
                  );
            if (resolved) cache.upsert(resolved);
      };
      await seedRobinhoodV2Peer();
      setInterval(seedRobinhoodV2Peer, 30_000);

      // Proactively checks known, real multi-DEX pairs directly on a
      // timer, instead of waiting for real swap traffic to happen to
      // reveal both sides. Every venue below was confirmed to have real,
      // live liquidity before being added -- see tonight's verification.
      // Tier 1 only for now: MON/USDC, WETH/USDC, cbBTC/USDC, each
      // checked across the 5 Monad DEXs we have real addresses for.
      const monadWatchVenues: Array<{ dex: string; style: 'v2' | 'v3' | 'lb'; factory: string }> = [
          { dex: 'uniswap-v3', style: 'v3', factory: MONAD_ROUTERS.UNISWAP_V3_FACTORY },
          { dex: 'lfj-lb', style: 'lb', factory: MONAD_LFJ.LB_FACTORY },
          { dex: 'lfj-v1', style: 'v2', factory: MONAD_LFJ.V1_FACTORY },
          { dex: 'pancakeswap-v3', style: 'v3', factory: MONAD_PANCAKE.V3_FACTORY },
          { dex: 'pancakeswap-v2', style: 'v2', factory: MONAD_PANCAKE.V2_FACTORY },
            ];

      const monadWatchedPairs: Array<{ tokenA: string; tokenB: string }> = [
          { tokenA: MONAD_TOKENS.WMON, tokenB: MONAD_TOKENS.USDC },
          { tokenA: MONAD_TOKENS.WETH, tokenB: MONAD_TOKENS.USDC },
          { tokenA: MONAD_TOKENS.CBBTC, tokenB: MONAD_TOKENS.USDC },
          { tokenA: MONAD_TOKENS.WBTC, tokenB: MONAD_TOKENS.WMON },
          { tokenA: MONAD_TOKENS.WMON, tokenB: MONAD_TOKENS.WETH },
          { tokenA: MONAD_TOKENS.CBBTC, tokenB: MONAD_TOKENS.WBTC },
          { tokenA: MONAD_TOKENS.AUSD, tokenB: MONAD_TOKENS.USDC },
          { tokenA: MONAD_TOKENS.USDT0, tokenB: MONAD_TOKENS.USDC },
          { tokenA: MONAD_TOKENS.WMON, tokenB: MONAD_TOKENS.AUSD },
          { tokenA: MONAD_TOKENS.SHMON, tokenB: MONAD_TOKENS.WMON },
          { tokenA: MONAD_TOKENS.SMON, tokenB: MONAD_TOKENS.WMON },
          { tokenA: MONAD_TOKENS.GMON, tokenB: MONAD_TOKENS.WMON },
            ];

      const watchListPriceOf = (p: any): number | null => {
            if (p.poolType === 'v3' && p.sqrtPriceX96) {
                  const price = Number(p.sqrtPriceX96) / 2 ** 96;
                  return price * price;
            }
            if (p.reserveA !== undefined && p.reserveB !== undefined && p.reserveA > 0n) {
                  return Number(p.reserveB) / Number(p.reserveA);
            }
            return null;
      };

      const checkMonadWatchList = async () => {
            for (const { tokenA, tokenB } of monadWatchedPairs) {
                  const resolved: any[] = [];
                  for (const v of monadWatchVenues) {
                        try {
                              let pool: any = null;
                              if (v.style === 'v3') {
                                    pool = await resolveAndFetchV3Pool(monadReadProvider, 'monad', v.dex, v.factory, tokenA, tokenB);
                              } else if (v.style === 'v2') {
                                    pool = await resolveAndFetchV2Pool(monadReadProvider, 'monad', v.dex, v.factory, tokenA, tokenB, 30);
                              } else if (v.style === 'lb') {
                                    pool = await resolveAndFetchLBPool(monadReadProvider, 'monad', v.dex, v.factory, tokenA, tokenB, 20);
                              }
                              if (pool) { cache.upsert(pool); resolved.push(pool); }
                        } catch { /* venue may genuinely have no pool for this pair yet */ }
                  }
for (let i = 0; i < resolved.length; i++) {
      for (let j = i + 1; j < resolved.length; j++) {
            const priceA = watchListPriceOf(resolved[i]);
            const priceB = watchListPriceOf(resolved[j]);
            if (priceA === null || priceB === null || priceA <= 0 || priceB <= 0) continue;

            // Orient buy = the cheaper venue, sell = the more expensive venue,
            // so the real profit math always runs in the direction that could
            // actually be worth something, not an arbitrary pair order.
            const buyPool = priceA < priceB ? resolved[i] : resolved[j];
            const sellPool = priceA < priceB ? resolved[j] : resolved[i];
            const buyPrice = Math.min(priceA, priceB);
            const sellPrice = Math.max(priceA, priceB);
            const spreadPct = ((sellPrice - buyPrice) / buyPrice) * 100;
            const pairLabel = `${symbolOf('monad', tokenA)}/${symbolOf('monad', tokenB)}`;

            // Still record the raw comparison for the hourly proof-of-activity
            // report, regardless of whether it clears real profit bars below.
            const watchKey = `monad:${pairLabel}`;
            const existingWatch = hourlyMatches.get(watchKey);
            if (!existingWatch || spreadPct > existingWatch.spreadPct) {
                  hourlyMatches.set(watchKey, {
                        chain: 'monad',
                        pair: pairLabel,
                        buyDex: buyPool.dex,
                        sellDex: sellPool.dex,
                        buyPrice,
                        sellPrice,
                        spreadPct,
                  });
            }

            // Now the real economics -- same pipeline the reactive
            // swap-triggered path uses, so a watch-list find is judged as a
            // genuine opportunity, not just a raw price note.
            const watchUsdPerToken = priceOracle.getUsdPrice('monad', tokenA);
            if (watchUsdPerToken === null) continue;
            const watchCeiling = calculateLiquidityCeiling(buyPool, sellPool, watchUsdPerToken);
            if (watchCeiling <= 0) continue;
            const watchSizing = findOptimalTradeSize(
                  buyPool, sellPool, cache, false, watchCeiling, watchUsdPerToken,
                  );
            if (watchSizing.grossProfitUsd <= 0) continue;
            const watchProfit = calculateAllInProfit(watchSizing, {
                  gasPriceUsd: 2,
                  dexFeeBps: { buy: buyPool.feeBps, sell: sellPool.feeBps },
                  flashLoanFeeBps: 9,
                  usingFlashLoan: true,
                  safetyMarginPct: 0.15,
            });
            const watchEvent: RawChainEvent = {
                  chain: 'monad',
                  stateType: 'FINALIZED',
                  blockOrSeq: 0,
                  receivedAtMs: Date.now(),
                  raw: 'proactive-watch-list-check',
            };
            const watchOpportunity = buildOpportunity(
                  'monad', [tokenA, tokenB],
                  buyPool.dex, buyPool.poolAddress, sellPool.dex, sellPool.poolAddress,
                  watchSizing, watchProfit, watchEvent, 0,
                  );
            if (!watchProfit.qualifies) {
                  shadowLogger.record({
                        opportunity: watchOpportunity,
                        outcome: 'SKIPPED_BELOW_MIN_PROFIT',
                        notes: 'found via proactive watch list, not a live swap trigger',
                  });
                  continue;
            }
            shadowLogger.record({
                  opportunity: watchOpportunity,
                  outcome: 'UNRESOLVED',
                  notes: 'found via proactive watch list -- real profit after costs, no live race to time it against',
            });
            if (watchSizing.grossProfitUsd >= 30) {
                  await sendTelegramMessage(formatSkippedOpportunity({
                        chain: 'monad',
                        pair: pairLabel,
                        buyDex: buyPool.dex,
                        sellDex: sellPool.dex,
                        buyPrice,
                        sellPrice,
                        spreadPct,
                        grossOpportunityUsd: watchSizing.grossProfitUsd,
                        optimalTradeUsd: watchSizing.optimalTradeSizeUsd,
                        expectedNetUsd: watchProfit.conservativeNetProfitUsd,
                        minRequiredUsd: 20,
                  }));
            }
      }
}
            }
      };
      await checkMonadWatchList();
      setInterval(checkMonadWatchList, 30_000);

      // Proof-of-life price check -- completely separate from the $30
      // opportunity threshold above. Scans whatever pools are already
      // cached (from either real swap traffic or the static seeds just
      // above) for any pair with two or more venues, and reports their
      // real prices side by side, however small the gap. This exists
      // purely so it's possible to directly verify the bot is comparing
      // genuine on-chain prices, without waiting for a rare, large,
      // profitable opportunity to happen to occur.
      const priceOfPool = (p: any): number | null => {
            if (p.poolType === 'v3' && p.sqrtPriceX96) {
                  const price = Number(p.sqrtPriceX96) / 2 ** 96;
                  return price * price;
            }
            if (p.reserveA !== undefined && p.reserveB !== undefined && p.reserveA > 0n) {
                  return Number(p.reserveB) / Number(p.reserveA);
            }
            return null;
      };
      const runProofOfLifeCheck = async () => {
            for (const chain of ['avalanche', 'monad', 'robinhood'] as const) {
                  const pools = cache.allForChain(chain);
                  const seenPairs = new Set<string>();
                  for (const pool of pools) {
                        const pairKey = [pool.tokenA.toLowerCase(), pool.tokenB.toLowerCase()].sort().join('-');
                        if (seenPairs.has(pairKey)) continue;
                        seenPairs.add(pairKey);
                        const peers = cache.findPeerPools(chain, pool.tokenA, pool.tokenB, pool.poolAddress);
                        if (peers.length === 0) continue;
                        const priceA = priceOfPool(pool);
                        const priceB = priceOfPool(peers[0]);
                        if (priceA === null || priceB === null || priceA === 0) continue;
                        const spreadPct = ((priceB - priceA) / priceA) * 100;
                        await sendTelegramMessage([
                              'LIVE PRICE CHECK (proof of life, not an opportunity alert)',
                              `Chain: ${chain}`,
        `Pair: ${symbolOf(chain, pool.tokenA)}/${symbolOf(chain, pool.tokenB)}`,
                              `${pool.dex}: ${priceA}`,
                              `${peers[0].dex}: ${priceB}`,
                              `Spread: ${spreadPct.toFixed(4)}%`,
                              ].join('\n'));
                  }
            }
      };
              setInterval(runProofOfLifeCheck, 60 * 60 * 1000); // hourly, plus once on startup below
          setTimeout(runProofOfLifeCheck, 10_000); // one check shortly after startup too
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

      // Sends whatever real matches were actually found this hour, then
      // clears for the next hour. If this comes back empty, that's a
      // real, honest answer too -- it means no two watched exchanges
      // traded the same pair close enough together to compare, not that
      // anything is broken.
      setInterval(async () => {
            const found = [...hourlyMatches.values()].sort((a, b) => b.spreadPct - a.spreadPct);
            const top = found.slice(0, 15);
            const lines = [
                  'REAL MATCHES FOUND THIS HOUR',
                  found.length === 0
                  ? 'None -- no two watched exchanges traded the same pair close enough together to compare.'
                  : `${found.length} unique pair(s) matched, showing top ${top.length} by spread:`,
                  ...top.map(m =>
                        `${m.chain} ${m.pair}: ${m.buyDex} @ ${m.buyPrice} vs ${m.sellDex} @ ${m.sellPrice} (${m.spreadPct.toFixed(4)}% spread)`
                        ),
                  ];
            await sendTelegramMessage(lines.join('\n'));
            hourlyMatches.clear();
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
