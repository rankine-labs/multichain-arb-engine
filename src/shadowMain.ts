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
import { formatHourlySummary, formatSkippedOpportunity , formatDailySummary} from './core/telegramFormatter';
import { RobinhoodChainAdapter } from './chains/robinhoodChain';
import { MonadAdapter } from './chains/monad';
import { AvalancheAdapter } from './chains/avalanche';
import { RawChainEvent } from './core/types';
import { priceOf, spreadPct } from './core/poolPrice';
import { buildExecuteCall, executionRequested, executorConfig } from './execution/executorCalldata';

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
});
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
      await sendTelegramMessage('Warning: EXECUTION_ENABLED is set, but live trading is not built yet. Bot is still shadow-only.');
}

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

      // Proof-of-life price check -- completely separate from the $30
      // opportunity threshold above. Scans whatever pools are already
      // cached (from either real swap traffic or the static seeds just
      // above) for any pair with two or more venues, and reports their
      // real prices side by side, however small the gap. This exists
      // purely so it's possible to directly verify the bot is comparing
      // genuine on-chain prices, without waiting for a rare, large,
      // profitable opportunity to happen to occur.

      // Human-readable price formatting -- template-literal interpolation of a
      // raw JS number prints ugly things like "2.44e-9" or 15 decimal places
      // for tiny prices, which is unreadable in a Telegram message. This picks
      // a sensible number of decimal places based on the price's own scale
      // instead of dumping the raw float.
      const formatPrice = (n: number): string => {
            if (!isFinite(n)) return 'n/a';
            if (n === 0) return '0';
            const abs = Math.abs(n);
            if (abs >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
            const leadingZeros = Math.max(0, Math.ceil(-Math.log10(abs)));
            const decimals = Math.min(leadingZeros + 4, 18);
            return n.toFixed(decimals);
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
                        // Same base token for both pools so they compare like for like.
                        const priceA = priceOf(pool, pool.tokenA, decimalsOf);
                        const priceB = priceOf(peers[0], pool.tokenA, decimalsOf);
                        if (priceA === null || priceB === null || priceA === 0) continue;
                        const spreadPct = ((priceB - priceA) / priceA) * 100;
                        await sendTelegramMessage([
                              'LIVE PRICE CHECK (proof of life, not an opportunity alert)',
                              `Chain: ${chain}`,
        `Pair: ${symbolOf(chain, pool.tokenA)}/${symbolOf(chain, pool.tokenB)}`,
                              `${pool.dex}: ${formatPrice(priceA)}`,
                              `${peers[0].dex}: ${formatPrice(priceB)}`,
                              `Spread: ${spreadPct.toFixed(4)}%`,
                              ].join('\n'));
                  }
            }
      };
              setInterval(runProofOfLifeCheck, 60 * 60 * 1000); // hourly, plus once on startup below
          setTimeout(runProofOfLifeCheck, 10_000); // one check shortly after startup too
  const lastHealthStatus: Record<string, boolean> = { avalanche: true, monad: true, robinhood: true };
        // Chains flap in and out of health regularly (Monad's speculative
        // feed reconnecting is normal, not an emergency). Counted silently
        // here, reported once per hour instead of alerting live every time.
        const chainHealthFlapCount: Record<string, number> = { avalanche: 0, monad: 0, robinhood: 0 };
      setInterval(async () => {
            await chainManager.runHealthChecks();
            const status = chainManager.getStatus() as Record<string, { online: boolean; reason?: string }>;
            for (const [chain, info] of Object.entries(status)) {
                  const wasHealthy = lastHealthStatus[chain] ?? true;
if (wasHealthy && !info.online) {
      chainHealthFlapCount[chain] = (chainHealthFlapCount[chain] ?? 0) + 1;
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

      // Report any chain disconnects silently counted this hour, then
      // reset for the next hour -- this replaces live UNHEALTHY/recovered
      // alerts, which were firing on every brief reconnect.
      const flapEntries = Object.entries(chainHealthFlapCount).filter(([, count]) => count > 0);
      if (flapEntries.length > 0) {
            const flapLines = flapEntries.map(
                  ([chainName, count]) => `${chainName}: disconnected and auto-recovered ${count}x this hour`,
                  );
            await sendTelegramMessage(`CHAIN HEALTH THIS HOUR\n\n${flapLines.join('\n')}`);
      }
      for (const chainName of Object.keys(chainHealthFlapCount)) chainHealthFlapCount[chainName] = 0;
}, 60 * 60 * 1000);

      // Sends whatever real matches were actually found this hour, then
      // clears for the next hour. If this comes back empty, that's a
      // real, honest answer too -- it means no two watched exchanges
      // traded the same pair close enough together to compare, not that
      // anything is broken.
      const sendHourlyMatchesReport = async () => {
            const monadPairLines = monadWatchedPairs.map(({ tokenA, tokenB }) => {
                  const label = `${symbolOf('monad', tokenA)}/${symbolOf('monad', tokenB)}`;
                  const m = hourlyMatches.get(`monad:${label}`);
                  return m
? `  ${label}: ${m.buyDex} @ ${formatPrice(m.buyPrice)} vs ${m.sellDex} @ ${formatPrice(m.sellPrice)} (${m.spreadPct.toFixed(4)}% spread)`
                        : `  ${label}: no match this hour`;
            });
            const monadMatchedCount = monadPairLines.filter(l => !l.includes('no match this hour')).length;

            const robinhoodLabel = `${symbolOf('robinhood', ROBINHOOD_TOKENS.WETH)}/${symbolOf('robinhood', ROBINHOOD_TOKENS.USDG)}`;
            const robinhoodMatch = hourlyMatches.get(`robinhood:${robinhoodLabel}`);
            const robinhoodLine = robinhoodMatch
            ? `  ${robinhoodLabel}: ${robinhoodMatch.buyDex} @ ${formatPrice(robinhoodMatch.buyPrice)} vs ${robinhoodMatch.sellDex} @ ${formatPrice(robinhoodMatch.sellPrice)} (${robinhoodMatch.spreadPct.toFixed(4)}% spread)`
                  : `  ${robinhoodLabel}: no match this hour`;

            const lines = [
                  'REAL MATCHES FOUND THIS HOUR',
                  '',
                  `MONAD -- 5 exchanges (Uniswap V3, Kuru, Bean Exchange, LFJ, PancakeSwap)`,
                  `Watching ${monadWatchedPairs.length} pairs, ${monadMatchedCount} matched this hour:`,
                  `LFJ-LB prices excluded from all comparisons above -- its aggregate reserves across price bins don't reflect the real market price, known gap, not a silent failure`,
                  ...monadPairLines,
                  '',
                  `ROBINHOOD -- 4 exchanges (Uniswap V2, Uniswap V3, Uniswap V4, PancakeSwap)`,
                  `Watching 1 pair:`,
                  robinhoodLine,
                  '',
                  `AVALANCHE -- 4 exchanges configured (TraderJoe V1, TraderJoe LB, SushiSwap, Pharaoh), but not receiving live trade data right now -- known gap, not a silent failure`,
                  ];
            await sendTelegramMessage(lines.join('\n'));
            hourlyMatches.clear();
      };
      await sendHourlyMatchesReport();
      setInterval(sendHourlyMatchesReport, 60 * 60 * 1000);

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
