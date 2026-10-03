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
import { planBackrun } from './core/backrunPlanner';
import { seedKnownAddresses } from './config/knownAddresses';
import { ethers as ethersV5 } from 'ethers-v5';
import { MONAD_KURU, MONAD_ROUTERS, MONAD_TOKENS, MONAD_BEAN, MONAD_LFJ, MONAD_PANCAKE, ROBINHOOD_PANCAKE, ROBINHOOD_V2, ROBINHOOD_V3, ROBINHOOD_V4, ROBINHOOD_TOKENS } from './config/knownAddresses';
import { sendTelegramMessage } from './core/telegramSender';
import { resolveAndFetchSolidlyV2Pool } from './core/poolResolver';
import { ROBINHOOD_RAMSES } from './config/knownAddresses';

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
import { formatSkippedOpportunity, formatHourlyDigest, formatDailyReport, formatStartup, formatExecutionWarning, DigestSection, DigestSpread } from './core/telegramFormatter';
import { RobinhoodChainAdapter } from './chains/robinhoodChain';
import { MonadAdapter } from './chains/monad';
import { AvalancheAdapter } from './chains/avalanche';
import { RawChainEvent } from './core/types';
import { priceOf, spreadPct } from './core/poolPrice';
import { buildExecuteCall, executionRequested, executorConfig } from './execution/executorCalldata';
import { makeRpc, simulateRoundTrip, Rpc } from './execution/simulator';

async function main() {
const cache = new PoolCache();
const shadowLogger = new ShadowLogger();
const chainManager = new ChainManager();
const routerRegistry = structuredClone(DEFAULT_ROUTER_REGISTRY);
seedKnownAddresses(routerRegistry);
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

      // Decoder gets the pool cache so it can decode Monad Swap logs (a log
      // only names the pool; the cache knows its tokens).
      const decoder = new TransactionDecoder(routerRegistry, avalancheReadProvider, (chain, addr) => cache.get(chain, addr));

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

                        // Both pools priced as "1 tokenIn = X tokenOut", decimal-
                        // adjusted and oriented the same way (see core/poolPrice.ts).
                        // The round trip SELLS tokenIn on the buy pool and buys it
                        // back on the sell pool, so it wins when tokenIn is still
                        // priced higher on the buy pool. The old version compared
                        // raw, unoriented ratios, so WON/LOST depended on which
                        // order each pool happened to list the pair.
                        const tokenIn = opportunity.tokenPair[0];
                        const buyPrice = priceOf(freshBuy, tokenIn, decimalsOf);
                        const sellPrice = priceOf(freshSell, tokenIn, decimalsOf);
                        if (buyPrice === null || sellPrice === null || sellPrice <= 0) return;

                        const freshEdge = (buyPrice - sellPrice) / sellPrice;

                        if (freshEdge > 0.001) {
                              shadowLogger.resolve(opportunity.id, 'WOULD_HAVE_WON');
                        } else {
                              shadowLogger.resolve(opportunity.id, 'WOULD_HAVE_LOST');
                        }
                  } catch {
                        // never crash the process over an outcome check
                  }
            }, 8000);
      }

// Declared BEFORE the event handler below on purpose: the handler uses
// these, and chains start emitting events as soon as startAll() runs. When
// this table sat further down, an early opportunity could reach it before it
// existed (ReferenceError -> unhandled rejection -> process crash).
// Real, on-chain-verified decimals -- checked directly against each
      // token contract's decimals() tonight after spreads like 351514228%
      // turned out to be a raw-unadjusted-ratio bug, not real price gaps.
      // Keyed by lowercase token address (not symbol) so it works no matter
      // which pool orders tokenA/tokenB which way. Missing tokens default to
      // 18, the most common case, rather than throwing.
      const TOKEN_DECIMALS: Record<string, Record<string, number>> = {
            avalanche: {
                  '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7': 18, // WAVAX
                  '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': 6,  // USDC (native, Circle)
            },
            monad: {
                  '0x3bd359c1119da7da1d913d1c4d2b7c461115433a': 18, // WMON
                  '0x754704bc059f8c67012fed69bc8a327a5aafb603': 6,  // USDC
                  '0xee8c0e9f1bffb4eb878d8f15f368a02a35481242': 18, // WETH
                  '0x0555e30da8f98308edb960aa94c0db47230d2b9c': 8,  // WBTC
                  '0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b': 8,  // cbBTC
                  '0xe7cd86e13ac4309349f30b3435a9d337750fc82d': 6,  // USDT0
                  '0x1b68626dca36c7fe922fd2d55e4f631d962de19c': 18, // shMON
                  '0xa3227c5969757783154c60bf0bc1944180ed81b9': 18, // sMON
                  '0x8498312a6b3cbd158bf0c93abdcf29e6e4f55081': 18, // gMON
                  '0x00000000efe302beaa2b3e6e1b18d08d69a9012a': 6,  // AUSD
            },
            robinhood: {
                  '0x0bd7d308f8e1639fab988df18a8011f41eacad73': 18, // WETH
                  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 6,  // USDG
            },
      };
      const decimalsOf = (chain: string, addr: string): number =>
            TOKEN_DECIMALS[chain]?.[addr.toLowerCase()] ?? 18;

// ==========================================================================
// FREE PRE-TRADE SIMULATION (shadow mode) -- see execution/simulator.ts
// A moment after the big trade lands, run OUR exact round trip against the
// real chain (eth_call + state overrides: nothing deployed, nothing spent)
// and log the real profit next to what the maths model predicted.
// ==========================================================================
const SIM_RPC_URL: Record<string, string> = {
      avalanche: process.env.SIM_RPC_AVALANCHE || 'https://api.avax.network/ext/bc/C/rpc',
      monad: process.env.SIM_RPC_MONAD || 'https://rpc.monad.xyz',
      robinhood: process.env.SIM_RPC_ROBINHOOD || 'https://rpc.mainnet.chain.robinhood.com',
};
const simRpc: Record<string, Rpc> = Object.fromEntries(Object.entries(SIM_RPC_URL).map(([c, u]) => [c, makeRpc(u)]));
// How long to wait for the trade we're backrunning to land before simulating
// (roughly one to a few blocks on each chain).
const SIM_DELAY_MS: Record<string, number> = { avalanche: 3_000, monad: 1_500, robinhood: 1_000 };
const simBusy: Record<string, boolean> = {};          // one simulation in flight per chain
const simDisabled: Record<string, string> = {};       // chain -> reason (e.g. RPC lacks overrides)
// Reported in the hourly digest, then reset.
const simStats = { checked: 0, profit: 0, loss: 0, fail: 0 };

const queueSimulation = (
      chain: 'avalanche' | 'monad' | 'robinhood', tokenIn: string,
      buyPool: any, sellPool: any, tradeSizeUsd: number, modelGrossUsd: number, usdPerToken: number,
) => {
      if (simBusy[chain] || simDisabled[chain]) return;
      const decimals = TOKEN_DECIMALS[chain]?.[tokenIn.toLowerCase()];
      if (decimals === undefined) return;
      // Only need the route + amount here; minProfit is set by the simulator.
      const built = buildExecuteCall({
            chain, tokenIn, buyPool, sellPool, tradeSizeUsd, netProfitUsd: 1,
            usdPerTokenIn: usdPerToken, tokenInDecimals: decimals, maxBlock: 0n,
      });
      if ('reason' in built) return;

      simBusy[chain] = true;
      setTimeout(async () => {
            try {
                  const r = await simulateRoundTrip(simRpc[chain], chain, { token: tokenIn, amountIn: built.amountIn, hops: built.hops });
                  const route = `${buyPool.dex}->${sellPool.dex}`;
                  const model = `model gross $${modelGrossUsd.toFixed(2)} on $${tradeSizeUsd.toFixed(0)}`;
                  if (r.status === 'unsupported') {
                        simDisabled[chain] = r.reason;
                        console.warn(`[sim] ${chain} simulation disabled: ${r.reason}`);
                        return;
                  }
                  simStats.checked++;
                  if (r.status === 'profit') {
                        simStats.profit++;
                        const usd = (Number(r.profit) / 10 ** decimals) * usdPerToken;
                        console.log(`[sim] ${chain} ${route} REAL PROFIT $${usd.toFixed(2)} | ${model}`);
                  } else if (r.status === 'loss') {
                        simStats.loss++;
                        console.log(`[sim] ${chain} ${route} real: LOSS | ${model}`);
                  } else {
                        simStats.fail++;
                        console.log(`[sim] ${chain} ${route} real: FAILS (${r.reason}) | ${model}`);
                  }
            } catch (err) {
                  console.warn(`[sim] ${chain} error:`, (err as Error).message);
            } finally {
                  simBusy[chain] = false;
            }
      }, SIM_DELAY_MS[chain]);
};

chainManager.register(new RobinhoodChainAdapter());
chainManager.register(new MonadAdapter());
chainManager.register(new AvalancheAdapter());

chainManager.onEvent(async (event: RawChainEvent) => {
const t0 = Date.now();

const swap = await decoder.decode(event);
if (!swap) return;

// NOTE: the fast filter runs AFTER pool lookup (below), not here. For
// router-based chains swap.poolAddress is the ROUTER, which is never in the
// cache, so filtering first rejected every single swap as "pool not
// tracked" before the real pool could be looked up.
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

    if (!pool) return;

    // Cheap "is this trade big enough to matter" check, now against the
    // REAL pool address.
    const filterResult = filter.evaluate({ ...swap, poolAddress: pool.poolAddress });
    if (!filterResult.pass) return;

    const peers = cache.findPeerPools(swap.chain, swap.tokenIn, swap.tokenOut, pool.poolAddress);
    if (peers.length === 0) return;
    const sellPool = peers[0];

      // Record this real, genuine match for the hourly proof-of-activity
      // report -- happens for every real peer match found, independent
      // of whether it's profitable enough to alert on.
      // Both pools priced as "1 tokenIn = X tokenOut": decimal-adjusted, LB
      // and dust pools excluded, and oriented the same way even if the two
      // pools list the pair in opposite order (see core/poolPrice.ts).
      const matchBuyPrice = priceOf(pool, swap.tokenIn, decimalsOf);
      const matchSellPrice = priceOf(sellPool, swap.tokenIn, decimalsOf);
      if (matchBuyPrice !== null && matchSellPrice !== null) {
            const matchSpreadPct = spreadPct(matchBuyPrice, matchSellPrice);
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

const usdPerToken = priceOracle.getUsdPrice(swap.chain, swap.tokenIn);
if (usdPerToken === null) return;

// Predict the price AFTER this pending swap lands, then size the arb
// against that future price (not today's). See core/backrunPlanner.ts.
const plan = planBackrun(cache, pool, sellPool, swap, usdPerToken, {
gasPriceUsd: 2,
dexFeeBps: { buy: pool.feeBps, sell: sellPool.feeBps }, // overwritten per direction inside planBackrun
flashLoanFeeBps: 9,
usingFlashLoan: true,
safetyMarginPct: 0.15,
}, decimalsOf(swap.chain, swap.tokenIn));
if (!plan) return;
const { sizing, profit } = plan;
const buyPoolUsed = plan.buyPool;
const sellPoolUsed = plan.sellPool;

const score = scoreOpportunity({
conservativeNetProfitUsd: profit.conservativeNetProfitUsd,
stateType: swap.stateType,
chain: swap.chain,
});

const opportunity = buildOpportunity(
swap.chain, [swap.tokenIn, swap.tokenOut],
buyPoolUsed.dex, buyPoolUsed.poolAddress, sellPoolUsed.dex, sellPoolUsed.poolAddress,
sizing, profit, event, score,
);

const reactionMs = Date.now() - t0;

// Simulate anything the model thinks is worth a look (gross > 0), whether
// or not it clears the minimum -- that's how we learn where the model is
// wrong in BOTH directions.
if (sizing.grossProfitUsd > 0) {
      queueSimulation(swap.chain, swap.tokenIn, buyPoolUsed, sellPoolUsed, sizing.optimalTradeSizeUsd, sizing.grossProfitUsd, usdPerToken);
}

if (!profit.qualifies) {
shadowLogger.record({ opportunity, outcome: 'SKIPPED_BELOW_MIN_PROFIT', ourHypotheticalReactionMs: reactionMs });
      // Only significant near-misses go to Telegram (per architecture doc:
      // "no play-by-play noise") — gross opportunity had to clear a real bar
      // even though it netted below the $20 minimum after costs.
      if (sizing.grossProfitUsd >= 30) {
              // Real per-DEX prices, not just USD amounts, so the person watching
              // Telegram can directly verify the bot is comparing genuine market
              // prices rather than just trusting an opaque dollar figure.
              // "1 tokenIn = X tokenOut" on each pool, decimal-adjusted and
              // oriented the same way, so the prices shown are real market
              // prices (previously raw ratios: off by 10^12 on WMON/USDC).
              // Buy price is the PREDICTED post-trade price if the guess was used.
              const buyPrice = priceOf(buyPoolUsed, swap.tokenIn, decimalsOf);
              const sellPrice = priceOf(sellPoolUsed, swap.tokenIn, decimalsOf);
              if (buyPrice !== null && sellPrice !== null) {
                      const gapPct = spreadPct(buyPrice, sellPrice);
                      await sendTelegramMessage(formatSkippedOpportunity({
                              chain: swap.chain,
        pair: `${symbolOf(swap.chain, swap.tokenIn)}/${symbolOf(swap.chain, swap.tokenOut)}`,
                              buyDex: buyPoolUsed.dex,
                              sellDex: sellPoolUsed.dex,
                              buyPrice,
                              sellPrice,
                              spreadPct: gapPct,
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
      scheduleOutcomeCheck(
            opportunity,
            buyPoolUsed.poolAddress === pool.poolAddress ? pool : sellPool,
            sellPoolUsed.poolAddress === pool.poolAddress ? pool : sellPool,
      );

console.log(
`[opportunity] ${swap.chain} predicted=${plan.usedPrediction} score=${score} net=$${profit.conservativeNetProfitUsd.toFixed(2)} ` +
`reaction=${reactionMs}ms`,
);

      // EXECUTION DRY RUN -- builds the exact ArbExecutor.execute() calldata
      // for this opportunity but NEVER signs or sends it. Answers "could the
      // on-chain contract have executed this one, and if not, why?" so we can
      // see real coverage before going live. See src/execution/executorCalldata.ts.
      // Wrapped in try/catch: a dry-run problem must never affect the bot.
      try {
            const dry = buildExecuteCall({
                  chain: swap.chain,
                  tokenIn: swap.tokenIn,
                  buyPool: buyPoolUsed,
                  sellPool: sellPoolUsed,
                  tradeSizeUsd: sizing.optimalTradeSizeUsd,
                  netProfitUsd: profit.conservativeNetProfitUsd,
                  usdPerTokenIn: usdPerToken,
                  // Strict lookup: no default-to-18 for real trade amounts.
                  tokenInDecimals: TOKEN_DECIMALS[swap.chain]?.[swap.tokenIn.toLowerCase()],
                  maxBlock: 0n, // dry run only; live firing would use current block + 1
                  ...executorConfig(swap.chain),
            });
            if ('reason' in dry) {
                  console.log(`[exec-dryrun] ${swap.chain} NOT executable: ${dry.reason}`);
            } else {
                  const funding = /^0x0+$/.test(dry.flashPool) ? 'own-capital' : 'flash';
                  console.log(
                        `[exec-dryrun] ${swap.chain} executable: ${dry.hops.map((h) => `kind${h.kind}`).join('->')} ` +
                        `amountIn=${dry.amountIn} minProfit=${dry.minProfit} ${funding}`,
                  );
            }
      } catch (err) {
            console.warn('[exec-dryrun] skipped:', (err as Error).message);
      }
});

// Live trading is not implemented yet (adapters' fireTransaction() are
// placeholders). Make sure flipping the switch early can't be mistaken for
// the bot actually trading.
if (executionRequested()) {
      console.warn('[execution] EXECUTION_ENABLED=true but live firing is NOT implemented -- staying in shadow mode');
      await sendTelegramMessage(formatExecutionWarning());
}

await chainManager.startAll();

      const startStatus = chainManager.getStatus() as Record<string, { online: boolean }>;
      await sendTelegramMessage(formatStartup(startStatus));

      // Kuru is an order book, not something you find via factory.getPair(),
      // so its market is seeded directly from the known address rather than
      // discovered from swap traffic. This is what gives the Uniswap V3 pool
      // a real second venue to compare against for cross-DEX opportunities.
      const monadKuruProvider = new ethersV5.providers.JsonRpcProvider('https://rpc.monad.xyz', 143);
      const seedKuruMarket = async () => {
            const resolved = await resolveKuruMarket(monadKuruProvider, 'monad', 'kuru', MONAD_KURU.MARKETS.MON_USDC);
                    // Kuru's base asset is native MON, a different address from
              // the wrapped MON every other exchange uses -- normalize to
              // WMON before caching so this pool is recognized as the same
              // pair everywhere else, not treated as unrelated.
              if (resolved) cache.upsert({ ...resolved, tokenA: MONAD_TOKENS.WMON });
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

      // Ramses is a Solidly-style fork -- confirmed live tonight that its
      // factory needs the extra "stable" flag standard Uniswap-style
      // factories don't have. WETH/USDG resolved and read real reserves
      // successfully before this was wired in here.
      const seedRobinhoodRamsesPeer = async () => {
            const resolved = await resolveAndFetchSolidlyV2Pool(
                  robinhoodReadProvider, 'robinhood', 'ramses-v2', ROBINHOOD_RAMSES.V2_FACTORY,
                  ROBINHOOD_TOKENS.WETH, ROBINHOOD_TOKENS.USDG, false, 20,
                  );
            if (resolved) cache.upsert(resolved);
      };
      await seedRobinhoodRamsesPeer();
      setInterval(seedRobinhoodRamsesPeer, 30_000);

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
            // Both priced as "1 tokenA = X tokenB" from the watch-list entry,
            // whichever order each pool stores the pair in (core/poolPrice.ts
            // also excludes LB and dust pools, as the old local helper did).
            const priceA = priceOf(resolved[i], tokenA, decimalsOf);
            const priceB = priceOf(resolved[j], tokenA, decimalsOf);
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

      }
}
            }
      };
      await checkMonadWatchList();
      setInterval(checkMonadWatchList, 30_000);

      // ======================================================================
      // TELEGRAM REPORTING
      // One hourly digest + one daily report. The digest replaced four
      // separate senders (hourly summary, chain health, matches report and
      // one "proof of life" message per pair), which produced 3-6 pings an
      // hour. Formatting lives in core/telegramFormatter.ts.
      // ======================================================================

      // Times in reports are shown in this zone (server clock is UTC).
      const REPORT_TZ = process.env.REPORT_TZ || 'America/Toronto';
      const hhmm = (ms: number) =>
            new Date(ms).toLocaleTimeString('en-GB', { timeZone: REPORT_TZ, hour: '2-digit', minute: '2-digit' });
      const dayLabel = (ms: number) =>
            new Date(ms).toLocaleDateString('en-US', { timeZone: REPORT_TZ, weekday: 'short', month: 'short', day: 'numeric' });

      // Price sample across every cached pair with two or more venues, so the
      // digest shows real prices even in an hour with no swap traffic. Feeds
      // hourlyMatches (same store the live event path uses) instead of
      // sending its own message per pair like it used to.
      const samplePricesIntoMatches = () => {
            for (const chain of ['avalanche', 'monad', 'robinhood'] as const) {
                  const seenPairs = new Set<string>();
                  for (const pool of cache.allForChain(chain)) {
                        const pairKey = [pool.tokenA.toLowerCase(), pool.tokenB.toLowerCase()].sort().join('-');
                        if (seenPairs.has(pairKey)) continue;
                        seenPairs.add(pairKey);
                        const peers = cache.findPeerPools(chain, pool.tokenA, pool.tokenB, pool.poolAddress);
                        if (peers.length === 0) continue;
                        // Same base token for both pools so they compare like for like.
                        const priceA = priceOf(pool, pool.tokenA, decimalsOf);
                        const priceB = priceOf(peers[0], pool.tokenA, decimalsOf);
                        if (priceA === null || priceB === null) continue;
                        const pair = `${symbolOf(chain, pool.tokenA)}/${symbolOf(chain, pool.tokenB)}`;
                        const key = `${chain}:${pair}`;
                        const gap = spreadPct(priceA, priceB);
                        const existing = hourlyMatches.get(key);
                        if (!existing || gap > existing.spreadPct) {
                              // "buy" = cheaper venue, "sell" = dearer one
                              const [buy, sell] = priceA <= priceB ? [pool, peers[0]] : [peers[0], pool];
                              hourlyMatches.set(key, {
                                    chain, pair, buyDex: buy.dex, sellDex: sell.dex,
                                    buyPrice: Math.min(priceA, priceB), sellPrice: Math.max(priceA, priceB), spreadPct: gap,
                              });
                        }
                  }
            }
      };

      // Health bookkeeping (runs every 15s alongside the health checks):
      //  - flap count per chain, reported in the next digest then reset
      //  - healthy/total ticks per chain, for the daily uptime figure
      const lastHealthStatus: Record<string, boolean> = { avalanche: true, monad: true, robinhood: true };
      // Chains flap in and out of health regularly (Monad's speculative
      // feed reconnecting is normal, not an emergency). Counted silently
      // here, reported once per hour instead of alerting live every time.
      const chainHealthFlapCount: Record<string, number> = { avalanche: 0, monad: 0, robinhood: 0 };
      const healthTicks: Record<string, { healthy: number; total: number }> = {
            avalanche: { healthy: 0, total: 0 }, monad: { healthy: 0, total: 0 }, robinhood: { healthy: 0, total: 0 },
      };
      setInterval(async () => {
            await chainManager.runHealthChecks();
            const status = chainManager.getStatus() as Record<string, { online: boolean; reason?: string }>;
            for (const [chain, info] of Object.entries(status)) {
                  const wasHealthy = lastHealthStatus[chain] ?? true;
                  if (wasHealthy && !info.online) {
                        chainHealthFlapCount[chain] = (chainHealthFlapCount[chain] ?? 0) + 1;
                  }
                  lastHealthStatus[chain] = info.online;
                  const ticks = (healthTicks[chain] ??= { healthy: 0, total: 0 });
                  ticks.total++;
                  if (info.online) ticks.healthy++;
            }
      }, 15_000);

      // Builds the "best spread per pair" sections from hourlyMatches.
      // The same pair can be stored under either token order (live event
      // path vs price sample), so pairs are de-duplicated by their sorted
      // symbols, keeping the widest spread.
      const buildDigestSections = (): DigestSection[] => {
            const byChain = new Map<string, Map<string, DigestSpread>>();
            for (const m of hourlyMatches.values()) {
                  const norm = m.pair.split('/').sort().join('/');
                  const chainMap = byChain.get(m.chain) ?? new Map<string, DigestSpread>();
                  byChain.set(m.chain, chainMap);
                  const prev = chainMap.get(norm);
                  if (!prev || m.spreadPct > prev.spreadPct) {
                        chainMap.set(norm, { pair: m.pair, spreadPct: m.spreadPct, buyDex: m.buyDex, sellDex: m.sellDex });
                  }
            }
            return (['monad', 'robinhood', 'avalanche'] as const).map((chain) => {
                  const spreads = [...(byChain.get(chain)?.values() ?? [])];
                  let noMatchCount = 0;
                  if (chain === 'monad') {
                        const matched = new Set(spreads.map((sp) => sp.pair.split('/').sort().join('/')));
                        noMatchCount = monadWatchedPairs.filter(({ tokenA, tokenB }) =>
                              !matched.has([symbolOf('monad', tokenA), symbolOf('monad', tokenB)].sort().join('/')),
                        ).length;
                  }
                  return { chain, spreads, noMatchCount };
            });
      };

      let lastDigestAt = Date.now();
      const sendHourlyDigest = async () => {
            const now = Date.now();
            try {
                  samplePricesIntoMatches();
                  const stats = shadowLogger.windowStats(lastDigestAt, now);
                  const status = chainManager.getStatus() as Record<string, { online: boolean }>;
                  await sendTelegramMessage(formatHourlyDigest({
                        windowLabel: `${hhmm(lastDigestAt)} to ${hhmm(now)}`,
                        chains: (['avalanche', 'monad', 'robinhood'] as const).map((chain) => ({
                              chain,
                              healthy: status[chain]?.online ?? false,
                              reconnects: chainHealthFlapCount[chain] ?? 0,
                        })),
                        stats,
                        sim: { ...simStats },
                        sections: buildDigestSections(),
                  }));
            } catch (err) {
                  console.error('[telegram] hourly digest failed:', err);
            } finally {
                  // Reset for the next hour even if sending failed.
                  hourlyMatches.clear();
                  for (const chainName of Object.keys(chainHealthFlapCount)) chainHealthFlapCount[chainName] = 0;
                  simStats.checked = simStats.profit = simStats.loss = simStats.fail = 0;
                  lastDigestAt = now;
            }
      };
      setInterval(sendHourlyDigest, 60 * 60 * 1000);

      let lastDailyAt = Date.now();
      setInterval(async () => {
            const now = Date.now();
            try {
                  const stats = shadowLogger.windowStats(lastDailyAt, now);
                  const uptimePct: Record<string, number | null> = {};
                  for (const [chain, t] of Object.entries(healthTicks)) {
                        uptimePct[chain] = t.total > 0 ? (t.healthy / t.total) * 100 : null;
                  }
                  await sendTelegramMessage(formatDailyReport({
                        dateLabel: dayLabel(lastDailyAt),
                        stats,
                        bestTradeUsd: stats.bestWonUsd,
                        largestMissUsd: stats.largestLostUsd,
                        uptimePct,
                  }));
            } catch (err) {
                  console.error('[telegram] daily report failed:', err);
            } finally {
                  for (const t of Object.values(healthTicks)) { t.healthy = 0; t.total = 0; }
                  lastDailyAt = now;
            }
      }, 24 * 60 * 60 * 1000);

console.log('Shadow mode running. Pool cache size:', cache.size());
console.log('Chain status:', chainManager.getStatus());
}

main().catch((err) => {
console.error('Fatal error in shadow mode:', err);
process.exit(1);
});
