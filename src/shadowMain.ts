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
import { sendTelegramMessage } from './core/telegramSender';
import { formatHourlySummary } from './core/telegramFormatter';
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

const discoveryConfigs: Record<string, DiscoveryConfig> = {
avalanche: {
chain: 'avalanche',
minLiquidityUsd: 50_000,
minRecent24hVolumeUsd: 20_000,
approvedDexes: new Set(['traderjoe', 'pharaoh', 'uniswap', 'sushiswap']),
},
monad: {
chain: 'monad',
minLiquidityUsd: 25_000,
minRecent24hVolumeUsd: 10_000,
approvedDexes: new Set(['uniswap', 'ambient', 'kuru']),
},
robinhood: {
chain: 'robinhood',
minLiquidityUsd: 25_000,
minRecent24hVolumeUsd: 10_000,
approvedDexes: new Set(['arcus', 'uniswap', 'pleiades']),
},
};

const discoveryEngines = Object.fromEntries(
Object.entries(discoveryConfigs).map(([chain, cfg]) => [chain, new PoolDiscoveryEngine(cfg, cache)]),
);

chainManager.register(new RobinhoodChainAdapter());
chainManager.register(new MonadAdapter());
chainManager.register(new AvalancheAdapter());

chainManager.onEvent(async (event: RawChainEvent) => {
const t0 = Date.now();

const swap = await decoder.decode(event);
if (!swap) return;

const filterResult = filter.evaluate(swap);
if (!filterResult.pass) return;

const pool = cache.get(swap.chain, swap.poolAddress);
const peers = cache.findPeerPools(swap.chain, swap.tokenIn, swap.tokenOut, swap.poolAddress);
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
return;
}
if (!shouldPreArm(score)) {
shadowLogger.record({ opportunity, outcome: 'SKIPPED_LOW_SCORE', ourHypotheticalReactionMs: reactionMs });
return;
}

shadowLogger.record({ opportunity, outcome: 'UNRESOLVED', ourHypotheticalReactionMs: reactionMs });

console.log(
`[opportunity] ${swap.chain} score=${score} net=$${profit.conservativeNetProfitUsd.toFixed(2)} ` +
`reaction=${reactionMs}ms`,
);
});

await chainManager.startAll();
setInterval(() => chainManager.runHealthChecks(), 15_000);

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

console.log('Shadow mode running. Pool cache size:', cache.size());
console.log('Chain status:', chainManager.getStatus());
}

main().catch((err) => {
console.error('Fatal error in shadow mode:', err);
process.exit(1);
});
