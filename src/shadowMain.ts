import 'dotenv/config';
// Scrub API keys / tokens from every log line (must stay the 2nd import).
import './core/logSanitizer.install';
const BOOT_MS = Date.now(); // for the "[startup] fully running after Ns" log

// One bad trade event must never take the whole bot down. Event handlers are
// async, so a bug in one shows up as an unhandled promise rejection, which
// Node 22 treats as fatal (crash, pm2 restart, all feeds reconnect). Log it
// and keep running instead; the next event is handled normally.
process.on('unhandledRejection', (reason) => {
      console.error('[error] unhandled rejection (bot keeps running):', reason);
});

// Report on demand: `pm2 sendSignal SIGUSR2 dex-arb-shadow` sends the hourly
// report right now. Registered first thing: without a handler, SIGUSR2 kills
// the process, and startup takes several minutes. Before the report is ready
// the request is remembered and sent as soon as startup finishes.
let reportNow: (() => Promise<void>) | null = null;
let reportRequested = false;
process.on('SIGUSR2', () => {
      if (reportNow) { console.log('[telegram] report requested (SIGUSR2), sending now'); void reportNow(); }
      else { console.log('[telegram] report requested during startup, will send when ready'); reportRequested = true; }
});
import { ethers } from 'ethers';
import { resolveAndFetchV2Pool, resolveAndFetchLBPool, resolveAndFetchV3Pool, resolveKuruMarket, refetchV2PoolPrice, refetchV3PoolPrice } from './core/poolResolver';
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
import { formatSkippedOpportunity, formatHourlyDigest, formatDailyReport, formatStartup, formatExecutionWarning, DigestSection, DigestSpread, formatPlainHourly, formatPlainDaily, formatRivalDaily, formatMarketOpenReport, formatLoopReport } from './core/telegramFormatter';
import { RobinhoodChainAdapter } from './chains/robinhoodChain';
import { MonadAdapter } from './chains/monad';
import { AvalancheAdapter } from './chains/avalanche';
import { RawChainEvent, PoolState } from './core/types';
import { priceOf, spreadPct, deepEnough } from './core/poolPrice';
import { PairWatcher, Venue, refreshPoolState, refreshPoolsBatch } from './core/pairWatcher';
import { scanUniverse, emptyScanState, ScanState, stateToPools, getLogsAdaptive, RawLog } from './core/universeScan';
import { CrossQuoteMonitor, LoopMonitor, shouldScheduleFirstLoopReport } from './core/crossQuoteMonitor';
import { NewPoolWatch } from './core/newPoolWatch';
import { buildTokenGroups, loadTokenGroups, groupsStatusLine, TokenGroupsResult } from './core/tokenGroups';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { ROBINHOOD_SCAN_FACTORIES } from './config/knownAddresses';
import { buildExecuteCall, executionRequested, executorConfig, pickV3Lender } from './execution/executorCalldata';
import { FailTally } from './core/failReasons';
import { LenderBalances } from './core/lenderBalances';
import { RouteScores, WinSizes, WIN_BARS } from './core/routeScore';
import { RivalWatch } from './core/rivalWatch';
import { V3BalanceBook } from './core/v3BalanceBook';
import { extraWatcherVenues, extraScanFactories, isExecutableVenue } from './config/robinhoodVenues';
// Read prices on the extra Robinhood venues (watch only; never traded).
// ON by default since Oct 8 (owner approved tracking); RH_EXTRA_VENUES=0 turns it off.
const RH_EXTRA_VENUES = process.env.RH_EXTRA_VENUES !== '0';
import { ProfitBands } from './core/profitBands';
import { SimBucketTally, classifySimOutcome } from './core/failReasons';
import { makeRpc, simulateRoundTrip, simRpcUrl, Rpc, makeFallbackRpc, loadBalanceSlots, wssToHttps, replayRpc, ReplayCall } from './execution/simulator';
import { FastSender, SafetyGate, safetyConfigFromEnv } from './execution/fastSender';
import { checkLiveReady } from './execution/liveReadiness';
import { LiveTradeTracker } from './execution/liveTracker';
import { findStandingGaps } from './core/gapScanner';
import { CompetitorTracker } from './core/competitorTracker';
import { pickRobinhoodReadRpc, robinhoodSendRpc, redact, ROBINHOOD_PUBLIC_RPC } from './config/robinhoodEndpoints';
import { loadStartPairs, saveStartPairs } from './core/seedPairs';
import { DryRunPnl } from './core/dryRunPnl';
import { FailoverJsonRpcProvider } from './core/failoverRpc';
import { makeCaller } from './core/universeScan';
import { loadNodeUsage, saveNodeUsage, nodeUsageToday, NodeBudget, budgetForUrl, callsInBody } from './core/nodeBudget';
import { endpointLabel } from './core/endpointLabel';
import { ROBINHOOD_SEED_PAIRS } from './config/robinhoodSeedPairs';
import { ResearchLane, researchConfigFromEnv, planShallowCandidate, findResearchGaps, gapCandidate, ResearchCandidate } from './core/researchLane';
import { poolDepthUsd } from './core/poolPrice';

async function main() {
const cache = new PoolCache();
const shadowLogger = new ShadowLogger();
// Provider blocks (403/429) are saved here so a restart doesn't hit a
// blocked feed again and extend the block (core/chainManager.ts).
const chainManager = new ChainManager(Date.now, 'data/provider-blocks.json');
const routerRegistry = structuredClone(DEFAULT_ROUTER_REGISTRY);
seedKnownAddresses(routerRegistry);
const filter = new FastFilter(cache);
// USD prices use each token's REAL decimals (strict: unknown = skip that pool,
// never guess 18). TOKEN_DECIMALS is declared further down; the try/catch
// covers the (theoretical) case of a lookup before that line has run.
const priceOracle = new PriceOracle(cache, (chain, token) => {
      try { return TOKEN_DECIMALS[chain]?.[token.toLowerCase()]; } catch { return undefined; }
});

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
      // Robinhood reads are split by job (core/failoverRpc.ts):
      //   FAST  (prices, blocks, pool lookups): Robinhood's own node, ~8 ms
      //         from the server. Override with ROBINHOOD_FAST_RPC.
      //   HEAVY (simulations, chain-wide scan): the paid node (Alchemy via
      //         ROBINHOOD_RPC_HTTP) when it answers, ~24 ms but no throttling.
      //   If FAST says "slow down" or fails, reads move to HEAVY for 5 min.
      //   No paid node -> everything on the public node, like before.
      const rhRead = await pickRobinhoodReadRpc();
      if (!process.env.ROBINHOOD_RPC_HTTP && rhRead.url !== ROBINHOOD_PUBLIC_RPC) process.env.ROBINHOOD_RPC_HTTP = rhRead.url; // simulations use it too
      const rhFastUrl = process.env.ROBINHOOD_FAST_RPC || ROBINHOOD_PUBLIC_RPC;
      const rhHeavyUrl = rhRead.url !== rhFastUrl ? rhRead.url : null;
      console.log(`[robinhood] prices from ${endpointLabel(rhFastUrl)}, simulations + scan from ${rhHeavyUrl ? endpointLabel(rhHeavyUrl) + ' (' + redact(rhHeavyUrl) + ')' : 'the same node'}, sending to ${redact(robinhoodSendRpc())}`);
      // Extra free/keyed nodes to spread price reads across (comma-separated
      // URLs in ROBINHOOD_FAST_RPC_EXTRA, e.g. a QuickNode or Nodeflare key).
      const rhExtraFast = (process.env.ROBINHOOD_FAST_RPC_EXTRA ?? '').split(',').map((u) => u.trim()).filter(Boolean);
      // Backup node(s) used only when the main free node is slow/failing,
      // before Alchemy (ROBINHOOD_BACKUP_RPC, e.g. Nodeflare).
      const rhBackup = (process.env.ROBINHOOD_BACKUP_RPC ?? '').split(',').map((u) => u.trim()).filter(Boolean);
      // Price reads: the free Robinhood node, then the backup (Nodeflare). The
      // paid node (Alchemy) is deliberately NOT in this path any more: it's
      // kept for the chain-wide scan, and when its plan ran out every price
      // read was detouring through it and slowing the bot down.
      const robinhoodReadProvider = new FailoverJsonRpcProvider(rhFastUrl, null, 4663, { extraFastUrls: rhExtraFast, backupUrls: rhBackup });
      // Bursty work (pool discovery, the chain-wide scan) goes to HEAVY
      // (Alchemy) first, with the public node as ITS fallback: when Alchemy
      // refuses (rate limit / plan limit), discovery used to stall completely
      // (watch list stuck at 0). No slow retries on Alchemy: fail fast, switch.
      // The chain-wide scan runs on Alchemy ONLY (no fallback): when Alchemy
      // was out, the scan fell back to the free node and flooded it (thousands
      // of reads), which got price reads moved off it. While Alchemy is out
      // the scan just pauses; the saved pair list + live-trade discovery
      // cover it meanwhile.
      const robinhoodHeavyProvider = rhHeavyUrl
            ? new FailoverJsonRpcProvider(rhHeavyUrl, null, 4663, { logTag: 'rpc:heavy', fastTimeoutMs: 10_000, slowMs: 2_000 })
            : robinhoodReadProvider;
      // The chain-wide scan on the FREE node, done gently (Oct 7: Alchemy is
      // out of credit until Nov 1, so the scan had stopped). Its own slow lane:
      // at most ROBINHOOD_SCAN_RPS requests a second (default 2), on top of the
      // free node's shared allowance, so price reads always come first.
      // ROBINHOOD_SCAN_NODE=alchemy puts it back on the paid node.
      const SCAN_RPS = Number(process.env.ROBINHOOD_SCAN_RPS ?? 2);
      const scanLane = new NodeBudget('scan', SCAN_RPS, Infinity, Date.now, 10 * 60_000);
      const robinhoodScanProvider = (process.env.ROBINHOOD_SCAN_NODE ?? 'free') === 'alchemy' && rhHeavyUrl
            ? robinhoodHeavyProvider
            : (() => {
                  const req = new ethers.FetchRequest(rhFastUrl);
                  req.timeout = 30_000;
                  const shared = budgetForUrl(rhFastUrl);
                  req.preflightFunc = async (r) => { const n = callsInBody(r.body); await scanLane.take(n); await shared?.take(n); return r; };
                  return new ethers.JsonRpcProvider(req, 4663, { staticNetwork: true, batchMaxCount: 1 });
            })();

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
        approvedDexes: new Set(['arcus', 'uniswap-v2', 'uniswap-v3', 'pleiades', 'pancakeswap-v2', 'pancakeswap-v3', 'ramses-v2', 'ramses-v3']),
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
            // Resolvers return null when there's no pool (or it couldn't be read).
            if (!resolved) return false;
            // V3/V4 pools have no reserves, only liquidity. Checking reserves for
            // them rejected EVERY V3 pool found on the spot, so it was never
            // cached and was looked up again on every trade (heavy load on
            // the public RPC, which then throttled us).
            const hasNonZeroLiquidity = resolved.poolType === 'v3'
                  ? (resolved.liquidity ?? 0n) > 0n
                  : (resolved.reserveA ?? 0n) > 0n && (resolved.reserveB ?? 0n) > 0n;
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
// Paid endpoint if configured, else public (see simRpcUrl in simulator.ts).
const simRpc: Record<string, Rpc> = {};
// Robinhood's free public node, used to DOUBLE-CHECK a trade the checking node
// (QuickNode) says breaks with no reason. Oct 7: QuickNode reverted every
// Ramses V3 check while the free node and fork tests ran the same trade fine.
// Metered by its node budget (8/s), and only used for those few re-checks.
const rhFreeSimRpc: Rpc = makeRpc('https://rpc.mainnet.chain.robinhood.com');
// Per-node usage today (speed limits + daily allowances, core/nodeBudget.ts):
// restored so a restart doesn't reset the counts, saved every minute.
loadNodeUsage('data/node-usage.json');
setInterval(saveNodeUsage, 60_000);
// Token balance locations found by earlier runs (saves the lookup after a restart).
loadBalanceSlots('data/balance-slots.json');
// Alchemy (ROBINHOOD_RPC_HTTP): fallback node for checks when QuickNode is set.
const rhHeavyUrlForSims = process.env.ROBINHOOD_RPC_HTTP || null;
for (const chain of ['avalanche', 'monad', 'robinhood'] as const) {
      const { url, source } = simRpcUrl(chain);
      // Robinhood: if the paid node refuses (rate/plan limit), simulate on the
      // public node instead of stopping real-chain tests altogether.
      if (chain === 'robinhood') {
            // Checks (simulations) run on QuickNode when its key is set, with
            // the paid Alchemy node as ITS fallback. Never on the free public
            // node (it refuses them and would then throttle our price reads).
            // Each node is held to its own daily allowance (core/nodeBudget.ts).
            const qn = wssToHttps(process.env.QUICKNODE_RPC_ROBINHOOD) ?? (process.env.QUICKNODE_RPC_ROBINHOOD || null);
            const primary = qn ?? url;
            const fallback = rhHeavyUrlForSims && rhHeavyUrlForSims !== primary ? rhHeavyUrlForSims : null;
            simRpc[chain] = fallback
                  ? makeFallbackRpc(makeRpc(primary), makeRpc(fallback), (m) => console.warn(`[sim] robinhood ${m.replace('public node', 'backup node')}`))
                  : makeRpc(primary);
            console.log(`[sim] robinhood: checks on ${qn ? 'QuickNode' : source}${fallback ? ' (fallback: Alchemy)' : ''}`);
            continue;
      }
      simRpc[chain] = makeRpc(url);
      console.log(`[sim] ${chain}: simulating on ${source}`); // never log the URL itself (it holds your API key)
}
// When an endpoint says "slow down", pause that chain's simulations.
const SIM_RATE_LIMIT_PAUSE_MS = 60_000;
const simPausedUntil: Record<string, number> = {};
// How long to wait for the trade we're backrunning to land before simulating
// (roughly one to a few blocks on each chain).
const SIM_DELAY_MS: Record<string, number> = { avalanche: 3_000, monad: 1_500, robinhood: 1_000 };
// Robinhood trigger checks don't use the fixed delay: they wait for the
// trigger trade's own block (see findTriggerBlock) and test right after it.
// Blocks are ~30 ms, so the old 1 s wait tested ~30 blocks late, after rival
// bots (who land right behind the trigger) had already closed the gap: every
// check looked like "no money" whether the opportunity was real or not.
const RH_TRIGGER_POLL_MS = 150;     // how often to ask "has the trigger landed?"
const RH_TRIGGER_MAX_POLLS = 12;    // give up after ~1.8 s and test on the latest block
// Hourly: how Robinhood trigger checks were timed (reset with the digest).
const checkTiming = { rightAfter: 0, othersInBlock: 0, late: 0 };
// Hourly: re-checks on the free node, and how many changed the answer.
const recheckStats = { done: 0, changed: 0 };
const simBusy: Record<string, boolean> = {};          // one simulation in flight per chain
// Simulation switched off for a chain (e.g. the RPC lacks state overrides),
// with an expiry: retried after 30 min instead of staying off until restart.
// Token-specific problems ("no balance slot found") never switch off the
// whole chain; the simulator retries that token on its own after an hour.
const simDisabled: Record<string, { reason: string; until: number }> = {};
// Robinhood: which pool pairs actually pay out in real tests (core/routeScore.ts).
// Pairs tested 3+ times without a real win are benched for 6 h. Saved to disk.
const ROUTE_FILE = 'data/route-scores.json';
const routeScores = new RouteScores();
{ const n = routeScores.load(ROUTE_FILE); if (n) console.log(`[sim] robinhood: restored scores for ${n} pool pairs`); }
setInterval(() => routeScores.save(ROUTE_FILE), 10 * 60_000);
// Real wins by size ($1/$2/$5/$10/$20 bars), to set the firing bar from data.
const winSizes = new WinSizes();
// Pool pairs whose last trigger test lost or failed: not re-tested for 5 min.
const simLoserMuted = new Map<string, number>();
// On-the-spot pool lookups that found nothing usable (see the trade handler).
const jitFailedUntil = new Map<string, number>();
const SIM_LOSER_MUTE_MS = 5 * 60_000;
const muteLoser = (key: string) => {
      simLoserMuted.set(key, Date.now() + SIM_LOSER_MUTE_MS);
      if (simLoserMuted.size > 2_000) for (const [k, t] of simLoserMuted) if (t < Date.now()) simLoserMuted.delete(k);
};
const SIM_DISABLE_MS = 30 * 60_000;
const simOff = (chain: string): string | undefined => {
      const d = simDisabled[chain];
      if (!d) return undefined;
      if (Date.now() >= d.until) { delete simDisabled[chain]; return undefined; }
      return d.reason;
};
// Reported in the hourly digest, then reset.
const simStats = { checked: 0, profit: 0, loss: 0, fail: 0, rateLimited: 0 };
// Phase 8 (Oct 8): profitable checks by $ band (after our gas) and every
// check result by category, for the hourly report. Robinhood only.
const profitBands = new ProfitBands();
const simBuckets = new SimBucketTally();
const torontoDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
// Our executor's gas per trade, measured on a Robinhood fork (Phase 3):
// ~311k-359k own money, ~453k-501k with a flash loan. Midpoints used.
const OUR_GAS_OWN = 335_000n, OUR_GAS_FLASH = 477_000n;
// Robinhood "funnel" for the hourly report: how many trades made it through
// each step, and why price differences weren't checked. Reset every hour.
const funnel = {
      tradesRead: 0,        // trades decoded from the live feed
      noPool: 0,            // couldn't identify the trading spot
      tooSmall: 0,          // trade too small to move the price
      noPartner: 0,         // no other trading spot for the pair deep enough ($25k+)
      noUsdPrice: 0,        // couldn't price the token in USD
      smallerThanFees: 0,   // price difference didn't beat the fees
      found: 0,             // price differences worth a look
      belowCheckBar: 0,     // estimated gain under the check minimum
      notVetted: 0,         // token not on the vetted list (live trading won't touch it)
      sentToCheck: 0,       // handed to the checker
      skip: new Map<string, number>(), // checker skipped it: reason -> count
};
const funnelSkip = (why: string) => funnel.skip.set(why, (funnel.skip.get(why) ?? 0) + 1);
// Why Robinhood checks "wouldn't go through" this hour, sorted into plain
// groups (coin takes a cut, our bug, old price info...). Reset every hour.
const failTally = new FailTally();
// A real arb between two pools nets a few % of the trade at most. A
// simulated profit above this share of the amount put in (measured in
// TOKENS, so a bad USD price can't hide it) means the token or pool data is
// broken (fake balances, rebasing/honeypot token, dead pool): not real.
const MAX_PLAUSIBLE_PROFIT_SHARE = Number(process.env.MAX_PLAUSIBLE_PROFIT_SHARE ?? 0.25);
const plausibleProfit = (profit: bigint, amountIn: bigint): boolean =>
      amountIn > 0n && Number(profit) / Number(amountIn) <= MAX_PLAUSIBLE_PROFIT_SHARE;

// One on-chain round-trip check, awaited by the caller (used by the
// standing-gap scanner, where there's no race to lose by waiting ~1 s).
// Same build + simulation as queueSimulation, but returns the result
// instead of only logging it, and ignores the "one sim at a time" queue.
type RoundTripCheck =
      | { status: 'profit'; usd: number }
      | { status: 'loss' | 'fail' | 'skipped'; reason: string }
      | { status: 'rate_limited' };
const checkRoundTrip = async (
      chain: 'avalanche' | 'monad' | 'robinhood', tokenIn: string,
      buyPool: any, sellPool: any, tradeSizeUsd: number, usdPerToken: number,
): Promise<RoundTripCheck> => {
      const off = simOff(chain);
      if (off) return { status: 'skipped', reason: `simulation off: ${off}` };
      if (Date.now() < (simPausedUntil[chain] ?? 0)) return { status: 'rate_limited' };
      const decimals = TOKEN_DECIMALS[chain]?.[tokenIn.toLowerCase()];
      if (decimals === undefined) return { status: 'skipped', reason: 'unknown decimals' };
      // Same lender choice as a live trade (approved FLASH_LENDERS only), so a
      // "confirmed" profit is priced with the loan fee a real trade would pay.
      const lender = pickLender(chain, tokenIn, buyPool, sellPool, tradeSizeUsd, usdPerToken);
      const built = buildExecuteCall({
            chain, tokenIn, buyPool, sellPool, tradeSizeUsd, netProfitUsd: 1,
            usdPerTokenIn: usdPerToken, tokenInDecimals: decimals, maxBlock: 0n,
            v3Lender: lender?.poolAddress,
      });
      if ('reason' in built) return { status: 'skipped', reason: built.reason };
      const r = await simulateRoundTrip(simRpc[chain], chain, { token: tokenIn, amountIn: built.amountIn, hops: built.hops }, { v3Lender: lender?.poolAddress, weth: chain === 'robinhood' ? ROBINHOOD_TOKENS.WETH : undefined });
      if (r.status === 'rate_limited') { simPausedUntil[chain] = Date.now() + SIM_RATE_LIMIT_PAUSE_MS; return { status: 'rate_limited' }; }
      if (r.status === 'unsupported') return { status: 'skipped', reason: r.reason };
      if (r.status === 'profit') {
            if (!plausibleProfit(r.profit, built.amountIn)) return { status: 'fail', reason: 'implausible profit (bad token or pool data)' };
            return { status: 'profit', usd: (Number(r.profit) / 10 ** decimals) * usdPerToken };
      }
      if (r.status === 'loss') return { status: 'loss', reason: 'ends with less than it started' };
      return { status: 'fail', reason: r.reason };
};

// Finds where the trigger trade landed and the trades before it in that
// block (including the trigger itself), so the check can REPLAY them on the
// block before and then run our trade: the exact moment a backrun lands,
// before any rival. null = not found in time.
type TriggerSpot = { block: string; parent: string; prefix: ReplayCall[]; time?: string };
const USER_TX_TYPES = new Set(['0x0', '0x1', '0x2', '0x3', '0x4']); // skip Arbitrum system txs (0x64-0x6a)
const findTriggerSpot = async (rpc: (m: string, p: unknown[]) => Promise<{ result?: any; error?: any }>, hash: string): Promise<TriggerSpot | null> => {
      for (let i = 0; i < RH_TRIGGER_MAX_POLLS; i++) {
            const r = await rpc('eth_getTransactionReceipt', [hash]);
            if (r.error) return null;
            if (r.result?.blockNumber) {
                  const n = BigInt(r.result.blockNumber);
                  const idx = Number(r.result.transactionIndex);
                  const b = await rpc('eth_getBlockByNumber', [r.result.blockNumber, true]);
                  const txs: any[] = b.result?.transactions ?? [];
                  const prefix: ReplayCall[] = txs.slice(0, idx + 1)
                        .filter((t) => t.to && USER_TX_TYPES.has(String(t.type ?? '0x0').toLowerCase()))
                        .map((t) => ({ from: t.from, to: t.to, data: t.input ?? t.data ?? '0x', value: t.value, gas: t.gas }));
                  // The trigger must be in there, or the replay would be meaningless.
                  if (!prefix.length || !txs[idx] || txs[idx].hash?.toLowerCase() !== hash.toLowerCase()) return null;
                  return { block: r.result.blockNumber, parent: '0x' + (n - 1n).toString(16), prefix, time: b.result?.timestamp };
            }
            await new Promise((res) => setTimeout(res, RH_TRIGGER_POLL_MS));
      }
      return null;
};
// Node can't serve an older block's state ("missing trie node" etc.).
const STATE_GONE = /missing trie node|historical state|state.*(not available|unavailable)|header not found|unknown block|pruned/i;

const queueSimulation = (
      chain: 'avalanche' | 'monad' | 'robinhood', tokenIn: string,
      buyPool: any, sellPool: any, tradeSizeUsd: number, modelGrossUsd: number, usdPerToken: number,
      triggerHash?: string,   // Robinhood: the trade we're following, to test right after it
) => {
      if (simBusy[chain]) { if (chain === 'robinhood') funnelSkip('another check was running'); return; }
      if (simOff(chain) || Date.now() < (simPausedUntil[chain] ?? 0)) { if (chain === 'robinhood') funnelSkip('checking node paused (busy or out of allowance)'); return; }
      const muteKey = `${buyPool.poolAddress}>${sellPool.poolAddress}`.toLowerCase();
      if (Date.now() < (simLoserMuted.get(muteKey) ?? 0)) { if (chain === 'robinhood') funnelSkip('same trading spots lost in the last 5 min'); return; }
      const routeKey = RouteScores.key(buyPool.poolAddress, sellPool.poolAddress);
      if (chain === 'robinhood' && routeScores.isBenched(routeKey)) { funnelSkip("these two trading spots never pay out (benched 6 h)"); return; }
      const decimals = TOKEN_DECIMALS[chain]?.[tokenIn.toLowerCase()];
      if (decimals === undefined) { if (chain === 'robinhood') funnelSkip('token decimals unknown'); return; }
      // Flash loan: borrow from the cheapest V3 pool holding the token that
      // isn't one of the trade's pools. None cached -> simulate own capital.
      // Same lender choice as a live trade (approved FLASH_LENDERS only), so a
      // "confirmed" profit is priced with the loan fee a real trade would pay.
      const lender = pickLender(chain, tokenIn, buyPool, sellPool, tradeSizeUsd, usdPerToken);
      // Only need the route + amount here; minProfit is set by the simulator.
      const built = buildExecuteCall({
            chain, tokenIn, buyPool, sellPool, tradeSizeUsd, netProfitUsd: 1,
            usdPerTokenIn: usdPerToken, tokenInDecimals: decimals, maxBlock: 0n,
            v3Lender: lender?.poolAddress,
      });
      if ('reason' in built) { if (chain === 'robinhood') funnelSkip(`trade couldn't be built (${built.reason})`); return; }
      const funding = lender ? `flash loan from ${lender.dex} (${lender.feeBps / 100}% fee)` : 'own capital (no V3 lender cached)';

      simBusy[chain] = true;
      const followTrigger = chain === 'robinhood' && !!triggerHash && !triggerHash.includes('PLACEHOLDER');
      setTimeout(async () => {
            try {
                  // Robinhood: test on the trigger's own block (right after it).
                  // Robinhood: replay the trigger's block up to the trigger, then
                  // our trade (right after the trigger, before any rival).
                  // Fallbacks: end of the trigger's block, then latest.
                  const simOpts = { v3Lender: lender?.poolAddress, weth: chain === 'robinhood' ? ROBINHOOD_TOKENS.WETH : undefined };
                  const trade = { token: tokenIn, amountIn: built.amountIn, hops: built.hops };
                  let timing = '';
                  let r: Awaited<ReturnType<typeof simulateRoundTrip>>;
                  const spot = followTrigger ? await findTriggerSpot(simRpc[chain], triggerHash!) : null;
                  if (spot) {
                        r = await simulateRoundTrip(replayRpc(simRpc[chain], spot.parent, spot.prefix, spot.time), chain, trade, simOpts);
                        timing = 'right after trigger';
                        if ('reason' in r && (r.reason.startsWith('replay unavailable') || STATE_GONE.test(r.reason))) {
                              // Replay not possible: end of the trigger's block instead.
                              r = await simulateRoundTrip(simRpc[chain], chain, trade, { ...simOpts, blockTag: spot.block });
                              timing = 'end of trigger block';
                              if ('reason' in r && STATE_GONE.test(r.reason)) { r = await simulateRoundTrip(simRpc[chain], chain, trade, simOpts); timing = 'tested late'; }
                        }
                  } else {
                        r = await simulateRoundTrip(simRpc[chain], chain, trade, simOpts);
                        if (followTrigger) timing = 'tested late';
                  }
                  // "Breaks" with no real reason (no revert data, or a transfer
                  // failing). Oct 7: Ramses V3 pools always fail inside the replay
                  // (eth_simulateV1) on this chain, but run fine in a plain check.
                  // So: plain check at the end of the trigger's block, then, if
                  // that still says "breaks" with no reason, the free node.
                  const noReason = (x: typeof r) => x.status === 'fail' && /execution reverted\s*$|reverted without data|TransferFailed/.test(x.reason);
                  if (chain === 'robinhood' && noReason(r)) {
                        recheckStats.done++;
                        let r2 = spot ? await simulateRoundTrip(simRpc[chain], chain, trade, { ...simOpts, blockTag: spot.block }) : r;
                        let where = spot ? 'end of trigger block (replay failed)' : timing || 'latest';
                        if (r2.status === 'rate_limited' || noReason(r2) || ('reason' in r2 && STATE_GONE.test(r2.reason))) {
                              const r3 = await simulateRoundTrip(rhFreeSimRpc, chain, trade, simOpts);
                              if (r3.status !== 'rate_limited') { r2 = r3; where = 'tested late on free node (replay failed)'; }
                        }
                        if (r2.status !== 'rate_limited') {
                              if (!noReason(r2)) recheckStats.changed++;
                              r = r2;
                              timing = where;
                        }
                  }
                  if (timing.startsWith('right after trigger')) checkTiming.rightAfter++;
                  else if (timing.startsWith('end of trigger block')) checkTiming.othersInBlock++;
                  else if (timing.startsWith('tested late')) checkTiming.late++;
                  // Pair name in the log line, so the status page can show WHICH
                  // coins fail (e.g. "WETH/AAPL uniswap-v3->uniswap-v2").
                  const pair = `${symbolOf(chain, buyPool.tokenA)}/${symbolOf(chain, buyPool.tokenB)}`;
                  // Pool addresses (shortened) so a failing pool can be identified.
                  const route = `${buyPool.dex}@${String(buyPool.poolAddress).slice(0, 10)}->${sellPool.dex}@${String(sellPool.poolAddress).slice(0, 10)}`;
                  const model = `model gross $${modelGrossUsd.toFixed(2)} on $${tradeSizeUsd.toFixed(0)}${timing ? ` | ${timing}` : ''} | ${funding}`;
                  if (chain === 'robinhood') simBuckets.add((r as any).bucket ?? classifySimOutcome(r.status, 'reason' in r ? (r as any).reason : ''));
                  if (r.status === 'rate_limited') {
                        // Not a trade result: pause, don't count it.
                        simPausedUntil[chain] = Date.now() + SIM_RATE_LIMIT_PAUSE_MS;
                        simStats.rateLimited++;
                        console.warn(`[sim] ${chain} RPC rate limited, pausing simulations 60s`);
                        return;
                  }
                  if (r.status === 'unsupported') {
                        // Only an RPC-wide problem pauses the chain; a token we
                        // can't simulate just skips this one check.
                        if (/override|does not support/i.test(r.reason)) {
                              simDisabled[chain] = { reason: r.reason, until: Date.now() + SIM_DISABLE_MS };
                              console.warn(`[sim] ${chain} simulation paused 30 min: ${r.reason}`);
                        } else console.warn(`[sim] ${chain} skipped (${r.reason})`);
                        return;
                  }
                  simStats.checked++;
                  if (r.status !== 'profit' || !plausibleProfit(r.profit, built.amountIn)) muteLoser(muteKey);
                  if (r.status === 'profit' && !plausibleProfit(r.profit, built.amountIn)) {
                        simStats.fail++;
                        if (chain === 'robinhood') failTally.add('implausible profit');
                        console.log(`[sim] ${chain} ${pair} ${route} real: IMPLAUSIBLE profit (bad token or pool data), ignored | ${model}`);
                  } else if (r.status === 'profit') {
                        simStats.profit++;
                        const usd = (Number(r.profit) / 10 ** decimals) * usdPerToken;
                        console.log(`[sim] ${chain} ${pair} ${route} REAL PROFIT $${usd.toFixed(4)} after loan fee | ${model}`);
                        // A trigger trade the real-chain test confirms clears the
                        // firing bar after gas: counts as verified would-have-earned,
                        // but only on vetted tokens, same as a live trade would need.
                        const net = usd - (chain === 'robinhood' ? rhGasUsd(0.05) : 0.05);
                        const vetted = [buyPool.tokenA, buyPool.tokenB].every((t: string) => safetyGate.isAllowed(t));
                        if (chain === 'robinhood' && net >= MIN_COUNTED_USD && vetted) {
                              dryRunPnl.recordVerified(net, `${symbolOf(chain, tokenIn)} ${buyPool.dex}->${sellPool.dex}`);
                        }
                        if (chain === 'robinhood') { routeScores.record(routeKey, net); if (vetted) winSizes.add(net); profitBands.add(net, torontoDay()); }
                  } else if (r.status === 'loss') {
                        simStats.loss++;
                        if (chain === 'robinhood') routeScores.record(routeKey, 0);
                        console.log(`[sim] ${chain} ${pair} ${route} real: LOSS | ${model}`);
                  } else {
                        simStats.fail++;
                        if (chain === 'robinhood') { failTally.add(r.reason); routeScores.record(routeKey, 0); }
                        console.log(`[sim] ${chain} ${pair} ${route} real: FAILS (${r.reason}) | ${model}`);
                  }
            } catch (err) {
                  console.warn(`[sim] ${chain} error:`, (err as Error).message);
            } finally {
                  simBusy[chain] = false;
            }
      }, followTrigger ? RH_TRIGGER_POLL_MS : SIM_DELAY_MS[chain]);
};

// ==========================================================================
// ROBINHOOD PAIR WATCHER -- follows live traffic (see core/pairWatcher.ts)
// Every DEX + fee tier on Robinhood that the contract can trade.
// ==========================================================================
const ROBINHOOD_VENUES: Venue[] = [
      { dex: 'uniswap-v2', kind: 'v2', factory: ROBINHOOD_V2.FACTORY, feeBps: 30 },
      { dex: 'pancakeswap-v2', kind: 'v2', factory: ROBINHOOD_PANCAKE.V2_FACTORY, feeBps: 25 },
      { dex: 'uniswap-v3', kind: 'v3-fee', factory: ROBINHOOD_V3.FACTORY },
      { dex: 'pancakeswap-v3', kind: 'v3-fee', factory: ROBINHOOD_PANCAKE.V3_FACTORY },
      { dex: 'ramses-v2', kind: 'solidly', factory: ROBINHOOD_RAMSES.V2_FACTORY, feeBps: 20 },
      { dex: 'ramses-v3', kind: 'v3-spacing', factory: ROBINHOOD_RAMSES.V3_FACTORY },
      // Uniswap V4: hookless standard pools only, including native-ETH pools
      // (WETH stands in for ETH). Prices read through V4's StateView.
      { dex: 'uniswap-v4', kind: 'v4', factory: ROBINHOOD_V4.STATE_VIEW, poolManager: ROBINHOOD_V4.POOL_MANAGER, weth: ROBINHOOD_TOKENS.WETH },
      // EXTRA VENUES (config/robinhoodVenues.ts): Alandale, GIGA, SwapHood,
      // UP, Topaz, Raphael, Fables. PRICE READING ONLY (on by default;
      // RH_EXTRA_VENUES=0 turns it off). The trade
      // path refuses every one of them (isExecutableVenue), so they show up
      // as "partner on an exchange we can't trade yet" in the hourly report.
      ...(RH_EXTRA_VENUES ? extraWatcherVenues({ stateView: ROBINHOOD_V4.STATE_VIEW, poolManager: ROBINHOOD_V4.POOL_MANAGER, weth: ROBINHOOD_TOKENS.WETH }) : []),
];
// Short venue name for reports: exchange plus fee level for V3/V4 pools, so
// two pools on the same exchange are told apart ("uniswap-v4 0.05% ETH").
function venueLabel(p: PoolState): string {
      const fee = p.poolType === 'v3' ? ` ${p.feeBps / 100}%` : '';
      return `${p.dex}${fee}${p.v4?.native ? ' ETH' : ''}`;
}

// Asks the standing-gap scanner to run soon (set up with the scanner below;
// a no-op until then). Called whenever a pool price changes.
let requestGapScan: () => void = () => {};
const robinhoodWatcher = new PairWatcher('robinhood', robinhoodReadProvider, ROBINHOOD_VENUES, cache,
      // Real decimals/symbols for every discovered token, read from the token itself.
      (addr, meta) => {
            (TOKEN_DECIMALS.robinhood ??= {})[addr] = meta.decimals;
            (TOKEN_SYMBOLS.robinhood ??= {})[addr] = meta.symbol;
      },
      // 60 = up to ~20 pinned pairs from the chain-wide scan + traffic-driven ones.
      // refreshMs: background re-sync of every watched pool (one Multicall3
      // request), the safety net behind instant price tracking below.
      // discoveryProvider: pool lookups now take 2 bundled requests per pair
      // (multicall), so they run on the free node (with its backup) instead
      // of draining the paid node's monthly allowance.
      // rediscoverMs 60 min (was 10): a pair's pool list rarely changes, and
      // re-asking every 10 min for 60 pairs was a steady drain.
      // 150 pairs (was 60): price reads are bundled (400 per request), so
      // ~700 pools cost ~4 requests per refresh. ROBINHOOD_MAX_PAIRS overrides.
      { maxPairs: Number(process.env.ROBINHOOD_MAX_PAIRS ?? 150), rediscoverMs: 60 * 60_000, refreshMs: 5_000, discoveryProvider: robinhoodReadProvider,
        onRefreshed: () => requestGapScan() });
// Restore the last watch list (saved every 10 min and at shutdown) so a
// restart doesn't re-discover every pair in one burst.
const WATCH_FILE = 'data/watched-pools.json';
{
      const restored = robinhoodWatcher.load(WATCH_FILE);
      if (restored) console.log(`[pairs] robinhood: restored ${restored} watched pairs from the last run`);
}
setInterval(() => robinhoodWatcher.save(WATCH_FILE), 10 * 60_000);

// Re-read a pool's live price right before using it (skips pools we can't
// refresh this way: Uniswap V4, order books, bin pools). Never waits more
// than REFRESH_TIMEOUT_MS; falls back to the cached state.
const READ_PROVIDER: Record<string, ethers.JsonRpcProvider> = {
      avalanche: avalancheReadProvider, monad: monadReadProvider, robinhood: robinhoodReadProvider,
};
const REFRESH_TIMEOUT_MS = 1_500;
// Instant price tracking (Robinhood): decide from our own pool copies when
// they're recent instead of re-reading every pool from the RPC first (that
// re-read was the slowest step: tens of ms per decision). FAST_PRICES=off
// in .env restores the old behaviour.
const FAST_PRICES = process.env.FAST_PRICES !== 'off';
// 35 s: longer than the watcher's 30 s re-sync, so a watched pool is always
// "fresh" between re-syncs (feed swaps keep it current in between). At 20 s,
// a third of every cycle sent each trade's partner pools to the public RPC,
// which slowed that node down for us once WETH pools passed the depth filter.
const FRESH_MS = Number(process.env.FRESH_MS ?? 35_000);
// Cap on decision-time RPC re-reads (per second). Past it, the cached copy
// is used: a flood of trades must not hammer the public node.
const MAX_DECISION_RPC_PER_SEC = Number(process.env.MAX_DECISION_RPC_PER_SEC ?? 10);
let decisionRpcWindow = { at: 0, n: 0 };
const priceStats = { local: 0, rpc: 0 };
const gapStats = { found: 0, bestUsd: 0, fake: 0, fail: 0 }; // standing gaps (no trigger trade) this hour: confirmed, best real $, fakes muted

// FAST SENDER (Robinhood). Dry run unless the live switches are all set
// (see execution/fastSender.ts). ROBINHOOD_SEND_RPC = where to send trades
// (ideally straight to the sequencer); defaults to the read RPC.
const robinhoodSender = new FastSender(
      robinhoodReadProvider, 4663,
      // Trades go straight to the sequencer (first come, first served).
      new ethers.JsonRpcProvider(robinhoodSendRpc(), 4663, { staticNetwork: true }),
);
const safetyGate = new SafetyGate(safetyConfigFromEnv());
if (safetyGate.problems.length) {
      // Fail closed: every send is blocked until the setting is fixed.
      console.warn(`[safety] BAD SETTING(S): ${safetyGate.problems.join(', ')} -- all sends blocked until fixed in .env`);
}
// Live-readiness result (see execution/liveReadiness.ts). Dry run: not needed.
let liveChecks: { ok: boolean; problems: string[] } = { ok: !robinhoodSender.live, problems: [] };
// Gas cost of one Robinhood trade in USD, from the real gas price and ETH
// price (was a fixed $0.05 / $2). Falls back to the old fixed value if
// either price is unknown yet.
const rhGasUsd = (fallback: number): number =>
      robinhoodSender.gasCostUsd(priceOracle.getUsdPrice('robinhood', ROBINHOOD_TOKENS.WETH)) ?? fallback;
// Dry-run "would have earned" totals (core/dryRunPnl.ts), saved so restarts
// don't reset them. Verified = confirmed by a real-chain test; model-only =
// the bot's own maths. Both assume we win the race.
const dryRunPnl = new DryRunPnl('data/dryrun-pnl.json', process.env.REPORT_TZ || 'America/Toronto');
setInterval(() => dryRunPnl.save(), 60_000);
// Save on shutdown too: pm2 restart/stop (every deploy) sends SIGINT, and the
// last minute of would-have-earned figures used to be lost each time.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.once(sig, () => {
            try { dryRunPnl.save(); } catch { /* best effort */ }
            try { robinhoodWatcher.save(WATCH_FILE); } catch { /* best effort */ }
            try { routeScores.save(ROUTE_FILE); } catch { /* best effort */ }
            try { rivalWatch.save(RIVAL_BOTS_FILE, RIVAL_TRADES_FILE); } catch { /* best effort */ }
            try { saveNodeUsage(); } catch { /* best effort */ }
            try { if (research.enabled) research.save(RESEARCH_FILE); } catch { /* best effort */ }
            console.log(`[shutdown] ${sig}: state saved, exiting`);
            process.exit(0);
      });
}
const MIN_COUNTED_USD = Number(process.env.GAP_MIN_USD ?? 20); // same bar as firing
safetyGate.allowTokens([ROBINHOOD_TOKENS.WETH, ROBINHOOD_TOKENS.USDG]);
// "fire-ready" = from the moment we saw the trigger trade to a signed trade
// in hand. The number to compare against competitors.
const fireStats = { readyMs: [] as number[], blocked: new Map<string, number>(), sent: 0 };
// Telegram near-miss throttle: at most one per pair per 10 min and 6 per hour,
// so a busy pair can't flood your phone.
const nearMissLast = new Map<string, number>();
let nearMissTimes: number[] = [];
const nearMissAllowed = (pairKey: string): boolean => {
      const now = Date.now();
      nearMissTimes = nearMissTimes.filter((t) => now - t < 3_600_000);
      if (nearMissTimes.length >= 6) return false;
      if (now - (nearMissLast.get(pairKey) ?? 0) < 600_000) return false;
      nearMissLast.set(pairKey, now);
      nearMissTimes.push(now);
      return true;
};

// Live competitor timing (see core/competitorTracker.ts).
const rivals = new CompetitorTracker(robinhoodReadProvider, Date.now, ROBINHOOD_V4.POOL_MANAGER);
// Rival watch (core/rivalWatch.ts): follows every trade of the rival bots the
// tracker has caught, to see what they win and where. Bots saved to disk.
const RIVAL_BOTS_FILE = 'data/rival-bots.json';
const RIVAL_TRADES_FILE = 'data/rival-trades.json';
const rivalWatch = new RivalWatch(
      (m, p) => robinhoodReadProvider.send(m, p as any[]),
      (token, raw) => {
            const px = priceOracle.getUsdPrice('robinhood', token);
            const dec = TOKEN_DECIMALS.robinhood?.[token.toLowerCase()];
            return px === null || dec === undefined ? null : (Number(raw) / 10 ** dec) * px;
      },
      (token) => symbolOf('robinhood', token),
      (pool) => !!cache.get('robinhood', pool),
      ROBINHOOD_TOKENS.WETH,
      Date.now, 3_000,
      {
            // Money in the pool each coin's price comes from: trades in coins
            // priced from a pool under $5k are left out of the rival money totals.
            priceDepthUsd: (token) => priceOracle.getUsdPriceInfo('robinhood', token)?.depthUsd ?? null,
            // V4 pools we know: does the pool hold plain ETH? (its ETH leg has
            // no log, so such trades are marked "uncertain"). Unknown -> null.
            v4IsNative: (id) => { const p = cache.get('robinhood', id); return p?.v4 ? p.v4.native : null; },
            v4PoolManager: ROBINHOOD_V4.POOL_MANAGER,
      },
);
{
      const n = rivalWatch.load(RIVAL_BOTS_FILE, RIVAL_TRADES_FILE);
      // Seed: arbitrage contracts found on chain by the funding probe (Oct 7).
      for (const b of ['0x8876789976decbfcbbbe364623c63652db8c0904', '0x1e7f0968bf0ad273d4edc75debc8bae037b0ad2c', '0x6e2a35a7ad683cf634d91492d73bb7ff774c6919',
            '0x5399d94d2cab7c252a6034042e1917a0e5e17a18', '0x203bffa697bee74d39d255c1c028e3efa689b5f7', '0x6c49cc864b3f8f6bef6559ef4f1662c408b84154',
            '0x6aa80dbbed9ae5ab45fbf61f9644fada3b29326e', '0x7ddbd3952d9fd58cc7d344ad0931d08db072114a']) rivalWatch.addBot(b, 'seed');
      // Seeds are UNPROVEN until each earns 3 confirmed closed-loop wins in
      // front of us; reports show verified vs unproven (rivalWatch.botStatus()).
      console.log(`[rivalwatch] following ${rivalWatch.botCount()} rival bots, ${n.recs} trades restored`);
}
// Sampler: one recent block every 15 s, to find rival bots we don't know yet.
setInterval(async () => {
      try {
            const latest = await robinhoodReadProvider.getBlockNumber();
            await rivalWatch.sampleBlock('0x' + (latest - 3).toString(16));
      } catch { /* node busy: next time */ }
}, Number(process.env.RIVAL_SAMPLE_MS ?? 15_000));
// New rival bots caught by the tracker join the watch list (checked every minute).
let rivalResultsSeen = 0;
setInterval(() => {
      for (; rivalResultsSeen < rivals.results.length; rivalResultsSeen++) {
            const r = rivals.results[rivalResultsSeen];
            if (r.found && r.bot) rivalWatch.addBot(r.bot, 'tracker');
      }
}, 60_000);
setInterval(() => rivalWatch.save(RIVAL_BOTS_FILE, RIVAL_TRADES_FILE), 10 * 60_000);
// New pool counter (set up with the chain-wide scan further down; read by the reports).
let newPoolWatchRef: NewPoolWatch | null = null;

// LIVE results (only used once live sending is switched on): receipt, profit
// from the contract's Executed event, gas cost; losses feed the daily cap.
const liveTracker = new LiveTradeTracker({
      provider: robinhoodReadProvider,
      ethUsd: () => priceOracle.getUsdPrice('robinhood', ROBINHOOD_TOKENS.WETH) ?? 0,
      tokenUsd: (token, raw) => {
            const px = priceOracle.getUsdPrice('robinhood', token);
            const dec = TOKEN_DECIMALS.robinhood?.[token.toLowerCase()];
            return px === null || dec === undefined ? null : (Number(raw) / 10 ** dec) * px;
      },
      recordLoss: (usd) => safetyGate.recordLoss(usd),
      noteGasUsed: (gas) => robinhoodSender.noteGasUsed(gas),
      notify: (html) => sendTelegramMessage(html),
      onSettled: (hash) => safetyGate.releasePending(hash),
      onDropped: () => { void robinhoodSender.resyncNonce(); },
});

// Flash-loan lenders the bot may use. FLASH_LENDERS_<CHAIN> in .env = the
// pools approved on the contract (same list given to the deploy script).
// Set: only those. Not set: any pool (fine for dry runs; live trades are
// refused above unless they use an approved lender).
const approvedLenders = (chain: string) => new Set(
      (process.env[`FLASH_LENDERS_${chain.toUpperCase()}`] ?? '').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean),
);
const lenderCandidates = (chain: 'avalanche' | 'monad' | 'robinhood') => {
      const ok = approvedLenders(chain);
      const all = cache.allForChain(chain);
      if (ok.size) return all.filter((p) => ok.has(p.poolAddress.toLowerCase()));
      return robinhoodSender.live && chain === 'robinhood' ? [] : all;
};

// Robinhood: real coin balances of every possible lender pool, refreshed
// every LENDER_REFRESH_MS in one bundled read (see core/lenderBalances.ts).
const lenderBalances = new LenderBalances();
const LENDER_REFRESH_MS = Number(process.env.LENDER_REFRESH_MS ?? 5 * 60_000);
// Lender must hold this many times the loan (room for price moves / fees).
const LENDER_HEADROOM = BigInt(Math.max(1, Math.floor(Number(process.env.LENDER_HEADROOM ?? 3))));

// Coins of tokenIn the trade will borrow: tradeSizeUsd / price, in raw units.
const loanUnits = (tradeSizeUsd: number, usdPerToken: number, decimals: number): bigint | null => {
      if (!(tradeSizeUsd > 0) || !(usdPerToken > 0)) return null;
      const micro = BigInt(Math.floor((tradeSizeUsd / usdPerToken) * 1e6)); // 6-decimal precision, no float overflow
      return (micro * 10n ** BigInt(decimals)) / 1_000_000n;
};

// The ONE lender choice used by checks and (later) live trades: cheapest pool
// that really holds enough. Robinhood only checks balances; other chains
// (paused) keep the old rule.
const pickLender = (
      chain: 'avalanche' | 'monad' | 'robinhood', tokenIn: string, buyPool: any, sellPool: any,
      tradeSizeUsd: number, usdPerToken: number,
) => {
      const exclude = [buyPool.poolAddress, sellPool.poolAddress];
      if (chain !== 'robinhood') return pickV3Lender(lenderCandidates(chain), tokenIn, exclude);
      const dec = TOKEN_DECIMALS[chain]?.[tokenIn.toLowerCase()];
      const amount = dec === undefined ? null : loanUnits(tradeSizeUsd, usdPerToken, dec);
      // Unknown amount or no balances read yet: no lender (own-capital check instead).
      if (amount === null || !lenderBalances.lastRefreshMs) return null;
      return pickV3Lender(lenderCandidates(chain), tokenIn, exclude, (pool, token) => lenderBalances.canLend(pool, token, amount, LENDER_HEADROOM));
};

// RESEARCH LANE (core/researchLane.ts). Off unless RESEARCH_LANE=1.
// Tests a small random sample of what the scanner below THROWS AWAY (under
// the $0.50 check bar, partner pool under $25k, coin not vetted, standing gap
// under $20) on the same checking node, within its own small allowance
// (RESEARCH_RPC_PER_MIN, default 6 a minute). Test only: never trades, never
// vets a coin, never changes any bar. It waits while the main checker is
// busy or paused, and stops when the checking node's daily allowance is
// mostly used. Results: [research] log lines, an hourly Telegram note and
// data/research-lane.json.
const RESEARCH_FILE = 'data/research-lane.json';
const researchNode = budgetForUrl(wssToHttps(process.env.QUICKNODE_RPC_ROBINHOOD) || process.env.QUICKNODE_RPC_ROBINHOOD || simRpcUrl('robinhood').url);
const research = new ResearchLane(researchConfigFromEnv(), {
      rpc: simRpc.robinhood,
      decimalsOf: (t) => TOKEN_DECIMALS.robinhood?.[t.toLowerCase()],
      symbolOf: (t) => symbolOf('robinhood', t),
      pickLender: (t, buy, sell, size, usd) => pickLender('robinhood', t, buy, sell, size, usd),
      gasUsd: () => rhGasUsd(0.05),
      weth: ROBINHOOD_TOKENS.WETH,
      canRun: () => !simBusy.robinhood && !simOff('robinhood') && Date.now() >= (simPausedUntil.robinhood ?? 0)
            && (!researchNode || researchNode.share() < research.config.maxNodeShare),
});
const usdRhResearch = (t: string) => priceOracle.getUsdPrice('robinhood', t);
const isDeepRh = (p: PoolState) => deepEnough(p, decimalsOf, usdRhResearch);
// Trigger trade with no $25k+ partner: plan it against the thinner partners (later, off the hot path).
const researchShallow = (victim: PoolState, swap: { tokenIn: string; tokenOut: string; amountIn: bigint; stateType: any }, hash?: string) =>
      planShallowCandidate({
            cache, victim, swap, usdPerToken: usdRhResearch(swap.tokenIn), tokenInDecimals: TOKEN_DECIMALS.robinhood?.[swap.tokenIn.toLowerCase()],
            isDeep: isDeepRh, depthUsd: (p) => poolDepthUsd(p, decimalsOf, usdRhResearch), minDepthUsd: research.config.minDepthUsd,
            gasUsd: rhGasUsd(2), vetted: safetyGate.isAllowed(swap.tokenIn) && safetyGate.isAllowed(swap.tokenOut), triggerHash: hash,
      });
if (research.enabled) {
      const restored = research.load(RESEARCH_FILE);
      const c = research.config;
      console.log(`[research] lane ON (test only, never trades): sampling ${c.samplePct}% of rejects, ${c.rpcPerMin} node requests/min${restored ? `, ${restored} past samples restored` : ''}`);
      setInterval(() => { void research.tick(); }, 2_000);
      setInterval(() => research.save(RESEARCH_FILE), 10 * 60_000);
      // Standing gaps the main scanner ignores: prices already in memory only, no node requests.
      setInterval(() => {
            try {
                  const pairs = robinhoodWatcher.watchedPairPools().map((addrs) => addrs.map((a) => cache.get('robinhood', a)).filter((p): p is PoolState => !!p && isExecutableVenue(p.dex)));
                  const gaps = findResearchGaps(pairs, isDeepRh, (p) => poolDepthUsd(p, decimalsOf, usdRhResearch), (t) => TOKEN_DECIMALS.robinhood?.[t.toLowerCase()], usdRhResearch,
                        { mainMinUsd: Number(process.env.GAP_MIN_USD ?? 20), researchMinUsd: c.gapMinUsd, minDepthUsd: c.minDepthUsd, gasUsd: rhGasUsd(0.05), maxTradeUsd: Number(process.env.MAX_TRADE_USD ?? 5_000) });
                  for (const { reason, gap } of gaps) {
                        const vetted = safetyGate.isAllowed(gap.base) && safetyGate.isAllowed(gap.quote);
                        // A standing gap sits there for minutes: one test per 30 min is enough.
                        research.offer(reason, `${gap.buyPool.poolAddress}>${gap.sellPool.poolAddress}`, () => gapCandidate(reason, gap, vetted), 30 * 60_000);
                  }
            } catch (err) { console.warn('[research] gap look failed (ignored):', (err as Error).message); }
      }, 60_000);
      // Hourly: the lane's summary goes into the main hourly report (Phase 8);
      // see researchHourText() used by the hourly digest.
}

// Research lane hour summary for the hourly report (also one log line).
// undefined when the lane is off or RESEARCH_TELEGRAM=0.
function researchHourText(): string | undefined {
      if (!research.enabled) return undefined;
      const text = research.takeHour();
      console.log(`[research] hour: ${text.replace(/<[^>]+>/g, '').replace(/\n/g, ' | ')}`);
      return process.env.RESEARCH_TELEGRAM === '0' ? undefined : text;
}

// ONE path from "this is worth doing" to a signed trade, used by both the
// trade-triggered engine and the standing-gap scanner:
//   build the exact contract call -> safety gate -> sign (send only if live).
// Never throws: a problem here must never affect the bot.
const fireTrade = async (o: {
      chain: 'avalanche' | 'monad' | 'robinhood'; tokenIn: string; tokenOut: string;
      buyPool: any; sellPool: any; tradeSizeUsd: number; netProfitUsd: number; usdPerTokenIn: number;
      seenAtMs: number; source: 'trade' | 'gap';
}) => {
      try {
            // Hard stop: never build a trade on an exchange that isn't cleared
            // for trading (config/robinhoodVenues.ts executionEnabled: false).
            if (!isExecutableVenue(o.buyPool?.dex ?? '') || !isExecutableVenue(o.sellPool?.dex ?? '')) {
                  console.log(`[exec-dryrun] ${o.chain} NOT executable: exchange not cleared for trading (${o.buyPool?.dex} / ${o.sellPool?.dex})`);
                  return;
            }
            const dry = buildExecuteCall({
                  chain: o.chain, tokenIn: o.tokenIn, buyPool: o.buyPool, sellPool: o.sellPool,
                  tradeSizeUsd: o.tradeSizeUsd, netProfitUsd: o.netProfitUsd, usdPerTokenIn: o.usdPerTokenIn,
                  // Strict lookup: no default-to-18 for real trade amounts.
                  tokenInDecimals: TOKEN_DECIMALS[o.chain]?.[o.tokenIn.toLowerCase()],
                  // Deadline: the contract reverts if mined after this block. Live
                  // trades get the ESTIMATED current block + a margin (default 3 s
                  // worth of blocks; MAX_BLOCK_MARGIN_MS). The old "last read + 3"
                  // was up to 2 s stale, so most real trades would revert Expired.
                  // 0 is only used in dry runs.
                  maxBlock: o.chain === 'robinhood' && robinhoodSender.live ? (robinhoodSender.deadlineBlock() ?? 0n) : 0n,
                  ...executorConfig(o.chain),
                  v3Lender: pickLender(o.chain, o.tokenIn, o.buyPool, o.sellPool, o.tradeSizeUsd, o.usdPerTokenIn)?.poolAddress,
            });
            if ('reason' in dry) { console.log(`[exec-dryrun] ${o.chain} NOT executable: ${dry.reason}`); return; }
            const block = (r: string) => { fireStats.blocked.set(r, (fireStats.blocked.get(r) ?? 0) + 1); };
            if (o.chain === 'robinhood' && robinhoodSender.live) {
                  // No fresh block number = no safe deadline: don't send.
                  if (robinhoodSender.deadlineBlock() === null) { block('block info stale'); return; }
                  // Readiness checks (chain id, executor role, lenders, ArbSys) must pass first.
                  if (!liveChecks.ok) { block('live checks not passed'); return; }
            }
            // Live trades must borrow from a pool the contract owner approved
            // (setFlashPool); anything else reverts on-chain.
            if (o.chain === 'robinhood' && robinhoodSender.live && dry.funding !== 'v3-flash') {
                  fireStats.blocked.set('no approved flash lender for this token', (fireStats.blocked.get('no approved flash lender for this token') ?? 0) + 1);
                  return;
            }
            if (o.chain !== 'robinhood') {
                  console.log(`[exec-dryrun] ${o.chain} executable: ${dry.hops.map((h) => `kind${h.kind}`).join('->')} amountIn=${dry.amountIn} ${dry.funding}`);
                  return;
            }
            const gate = safetyGate.check({ tradeSizeUsd: o.tradeSizeUsd, tokens: [o.tokenIn, o.tokenOut] });
            if (!gate.ok) {
                  const r = 'reason' in gate ? gate.reason.replace(/\$\d+/g, '$N').replace(/0x[0-9a-f]+/gi, '0x…') : 'blocked';
                  fireStats.blocked.set(r, (fireStats.blocked.get(r) ?? 0) + 1);
                  return;
            }
            if (robinhoodSender.live && !dry.to) {
                  fireStats.blocked.set('no executor deployed', (fireStats.blocked.get('no executor deployed') ?? 0) + 1);
                  return;
            }
            const fired = await robinhoodSender.fire(dry.to ?? '0x0000000000000000000000000000000000000000', dry.data);
            // Dry run: this trade passed every check and would have been sent.
            // Standing gaps carry a simulation-confirmed profit; trigger trades
            // carry the model's estimate (their simulation is counted separately).
            if (!fired.live) {
                  if (o.source === 'gap') dryRunPnl.recordVerified(o.netProfitUsd, `${symbolOf(o.chain, o.tokenIn)}/${symbolOf(o.chain, o.tokenOut)} gap`);
                  else dryRunPnl.recordModelOnly(o.netProfitUsd);
            }
            const readyMs = Date.now() - o.seenAtMs;
            if (o.source === 'trade') fireStats.readyMs.push(readyMs);
            if (fired.txHash) {
                  fireStats.sent++;
                  // Worst-case gas (2x today's cost) held against the daily loss cap until the receipt.
                  safetyGate.reservePending(fired.txHash, 2 * rhGasUsd(0.05));
                  liveTracker.track(fired.txHash, { expectedProfitUsd: o.netProfitUsd, label: `${symbolOf(o.chain, o.tokenIn)}/${symbolOf(o.chain, o.tokenOut)} ${o.buyPool.dex}>${o.sellPool.dex}` });
            }
            console.log(`[fire] robinhood ${fired.live ? 'LIVE' : 'DRY RUN'} (${o.source}) ready ${readyMs}ms after ${o.source === 'trade' ? 'the trigger' : 'the price update'} (sign ${fired.signMs.toFixed(1)}ms)` +
                  `${fired.txHash ? ` tx ${fired.txHash}` : ''}${fired.error ? ` error: ${fired.error}` : ''}`);
      } catch (err) {
            console.warn('[exec-dryrun] skipped:', (err as Error).message);
      }
};
// preTrade: the caller wants the pool's state BEFORE the trade the feed just
// applied (the backrun planner predicts that trade's effect itself), so an
// RPC read refused by the cache is still returned for planning.
const refreshNow = async (p: any, preTrade = false): Promise<any> => {
      if ((p.dex === 'uniswap-v4' && !p.v4) || p.poolType === 'orderbook' || p.dex.includes('lb') || p.dex === 'bean-exchange') return p;
      const readStartedMs = Date.now();
      const fresh = await Promise.race([
            refreshPoolState(READ_PROVIDER[p.chain], p),
            new Promise<null>((r) => setTimeout(() => r(null), REFRESH_TIMEOUT_MS)),
      ]);
      if (fresh) {
            if (cache.upsertIfNotNewer(fresh, readStartedMs)) return fresh;
            // Not written: the trade feed has a newer copy in the cache. Peers
            // use that newer copy; the traded pool keeps the pre-trade read.
            return preTrade ? fresh : (cache.get(p.chain, p.poolAddress) ?? fresh);
      }
      return p;
};
// Robinhood: the traded pool and ALL its partner pools that need a fresh
// price are re-read in ONE bundled request (multicall) instead of 2 requests
// per pool. Same freshness rules as priceAtDecision; counts as one re-read
// against the per-second cap. Falls back to the cached copies if the bundle
// fails or is slower than REFRESH_TIMEOUT_MS.
let rhDecisionCallMany: ((calls: { target: string; data: string }[]) => Promise<(string | null)[]>) | null = null;
const pricesAtDecisionRobinhood = async (traded: PoolState, peers: PoolState[]): Promise<[PoolState, PoolState[]]> => {
      const all = [traded, ...peers];
      const stale = all.filter((p) => !(FAST_PRICES && Date.now() - p.lastUpdatedMs <= FRESH_MS)
            && !(p.dex === 'uniswap-v4' && !p.v4) && (p.poolType === 'v2' || p.poolType === 'v3'));
      priceStats.local += all.length - stale.length;
      if (!stale.length) return [traded, peers];
      const now = Date.now();
      if (now - decisionRpcWindow.at >= 1_000) decisionRpcWindow = { at: now, n: 0 };
      if (++decisionRpcWindow.n > MAX_DECISION_RPC_PER_SEC) { priceStats.local += stale.length; return [traded, peers]; }
      priceStats.rpc += stale.length;
      const readStartedMs = Date.now();
      let fresh: PoolState[] = [];
      try {
            rhDecisionCallMany ??= (await makeCaller(robinhoodReadProvider)).callMany;
            fresh = await Promise.race([
                  refreshPoolsBatch(rhDecisionCallMany, stale),
                  new Promise<PoolState[]>((r) => setTimeout(() => r([]), REFRESH_TIMEOUT_MS)),
            ]);
      } catch { fresh = []; }
      const byAddr = new Map(fresh.map((f) => [f.poolAddress.toLowerCase(), f]));
      const pick = (p: PoolState, preTrade: boolean): PoolState => {
            const f = byAddr.get(p.poolAddress.toLowerCase());
            if (!f) return p;
            if (cache.upsertIfNotNewer(f, readStartedMs)) return f;
            // Feed has a newer copy: peers use it; the traded pool keeps the pre-trade read.
            return preTrade ? f : (cache.get(p.chain, p.poolAddress) ?? f);
      };
      return [pick(traded, true), peers.map((p) => pick(p, false))];
};

const priceAtDecision = async (p: PoolState, preTrade = false): Promise<PoolState> => {
      if (FAST_PRICES && p.chain === 'robinhood' && Date.now() - p.lastUpdatedMs <= FRESH_MS) { priceStats.local++; return p; }
      const now = Date.now();
      if (now - decisionRpcWindow.at >= 1_000) decisionRpcWindow = { at: now, n: 0 };
      if (p.chain === 'robinhood' && ++decisionRpcWindow.n > MAX_DECISION_RPC_PER_SEC) { priceStats.local++; return p; }
      priceStats.rpc++;
      return refreshNow(p, preTrade);
};

// Which chains run. Robinhood only for now: it's the test chain, and Monad
// (public RPC rate limits) and Avalanche (providers stream no pending txs)
// are paused until they're sorted. Turn them back on with, in .env:
//   CHAINS=robinhood,monad,avalanche
const ENABLED_CHAINS = new Set(
      (process.env.CHAINS ?? 'robinhood').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean),
);
const chainOn = (c: string) => ENABLED_CHAINS.has(c);
console.log(`[chains] enabled: ${[...ENABLED_CHAINS].join(', ')}`);
if (chainOn('robinhood')) chainManager.register(new RobinhoodChainAdapter());
if (chainOn('monad')) chainManager.register(new MonadAdapter());
if (chainOn('avalanche')) chainManager.register(new AvalancheAdapter());

chainManager.onEvent(async (event: RawChainEvent) => {
const t0 = Date.now();
// Timestamp every Robinhood feed tx: lets the competitor tracker time rivals.
if (event.chain === 'robinhood') { rivals.noteFeedTx((event.raw as any)?.hash, event.receivedAtMs); rivalWatch.noteTx((event.raw as any)?.to, (event.raw as any)?.hash, (event.raw as any)?.from, (event.raw as any)?.value); }

const swap = await decoder.decode(event);
if (!swap) return;
if (swap.chain === 'robinhood') funnel.tradesRead++;

// Follow the traffic: make sure every pool for this pair is being watched.
if (swap.chain === 'robinhood') robinhoodWatcher.touch(swap.tokenIn, swap.tokenOut);

// NOTE: the fast filter runs AFTER pool lookup (below), not here. For
// router-based chains swap.poolAddress is the ROUTER, which is never in the
// cache, so filtering first rejected every single swap as "pool not
// tracked" before the real pool could be looked up.
let pool = cache.get(swap.chain, swap.poolAddress);

    // Router-based swaps: first look for the EXACT pool the trade used
    // (same DEX, and same fee tier when the calldata tells us), among pools
    // we already watch -- instead of any tier of the pair.
    if (!pool) {
          const viaEntry = routerRegistry[swap.chain]?.[swap.poolAddress.toLowerCase()];
          const wantFeeBps = swap.feeTier !== undefined ? Math.round(swap.feeTier / 100) : undefined;
          pool = cache.findPeerPools(swap.chain, swap.tokenIn, swap.tokenOut, '').find((p) =>
                p.dex === (viaEntry?.dex ?? swap.dex) && (wantFeeBps === undefined || p.feeBps === wantFeeBps));
    }

    // Just-in-time pool discovery: swap.poolAddress is the ROUTER address
    // (routers proxy to many pools, see decoder.ts). If we haven't cached
    // this pool yet and know the router's factory, resolve the REAL pool
    // address on-chain and pull its live reserves — no external API, just
    // the same chain data we're already watching.
    // Lookups that found nothing usable are remembered for 30 min, so a busy
    // pair with no approved pool doesn't cost 10-25 RPC requests per trade.
    const jitKey = `${swap.chain}:${swap.poolAddress}:${swap.tokenIn}:${swap.tokenOut}:${swap.feeTier ?? ''}`.toLowerCase();
    const jitSkip = !pool && Date.now() < (jitFailedUntil.get(jitKey) ?? 0);
    if (!pool && !jitSkip) {
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
                      swap.tokenIn, swap.tokenOut, swap.feeTier, // exact tier the trade used
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
                      swap.tokenIn, swap.tokenOut, swap.feeTier, // exact tier the trade used
                      );
                if (registerIfApproved('robinhood', entry.dex, resolved)) pool = resolved;
          }
          if (!pool && entry?.factory) {
                jitFailedUntil.set(jitKey, Date.now() + 30 * 60_000);
                if (jitFailedUntil.size > 5_000) for (const [k, t] of jitFailedUntil) if (t < Date.now()) jitFailedUntil.delete(k);
          }
    }

    if (!pool) { if (swap.chain === 'robinhood') funnel.noPool++; return; }

    // INSTANT PRICE TRACKING (Robinhood): the trade we just saw is already
    // sequenced, so it WILL land. Apply its effect to our copy of the pool
    // now, so the next trade on this pool is priced from up-to-date state
    // without asking the RPC. `pool` keeps the pre-trade state for planning
    // this backrun (the planner predicts this trade's effect itself).
    if (FAST_PRICES && swap.chain === 'robinhood' && swap.amountIn > 0n) {
          const inIsA = pool.tokenA.toLowerCase() === swap.tokenIn.toLowerCase();
          const after = cache.predictPostTradeState(pool, inIsA, swap.amountIn);
          if (after !== pool) { cache.upsertFromFeed(after); requestGapScan(); }
    }

    // Cheap "is this trade big enough to matter" check, now against the
    // REAL pool address.
    const filterResult = filter.evaluate({ ...swap, poolAddress: pool.poolAddress });
    if (!filterResult.pass) { if (swap.chain === 'robinhood') funnel.tooSmall++; return; }

    // Fresh prices at decision time: re-read the traded pool and EVERY
    // partner pool now, in parallel (cached prices can be up to 30s old).
    // Partner pools must hold real money near their price ($1,000+); a
    // near-empty pool can show any price and would only waste a simulation.
    const deepPeers = cache.findPeerPools(swap.chain, swap.tokenIn, swap.tokenOut, pool.poolAddress)
          .filter((p) => deepEnough(p, decimalsOf, (t) => priceOracle.getUsdPrice(swap.chain, t)));
    // Partners on exchanges our contract can't trade yet (extra venues) are
    // only counted, never planned or tested: "missed: unsupported exchange".
    const cachedPeers = deepPeers.filter((p) => isExecutableVenue(p.dex));
    if (swap.chain === 'robinhood' && deepPeers.length > cachedPeers.length) funnelSkip(`partner on an exchange we can't trade yet (${[...new Set(deepPeers.filter((p) => !isExecutableVenue(p.dex)).map((p) => p.dex))].join(', ')})`);
    if (cachedPeers.length === 0) {
          if (swap.chain === 'robinhood') {
                funnel.noPartner++;
                // Research lane (off unless RESEARCH_LANE=1): maybe sample it; planned later, off this path.
                const victim = pool, hash = (event.raw as any)?.hash;
                if (research.enabled) research.offer('shallow_pool', victim.poolAddress, () => researchShallow(victim, swap, hash));
          }
          return;
    }
    // Fast path: use our own up-to-date copy when it's recent (kept current by
    // instant price tracking + the 5s re-sync); only ask the RPC when stale.
    const [freshPool, ...peers] = swap.chain === 'robinhood'
          ? await pricesAtDecisionRobinhood(pool, cachedPeers).then(([t, ps]) => [t, ...ps])
          : await Promise.all([priceAtDecision(pool, true), ...cachedPeers.map((p) => priceAtDecision(p))]);
    pool = freshPool;

      // Record this real, genuine match for the hourly proof-of-activity
      // report -- happens for every real peer match found, independent
      // of whether it's profitable enough to alert on.
      // Both pools priced as "1 tokenIn = X tokenOut": decimal-adjusted, LB
      // and dust pools excluded, and oriented the same way even if the two
      // pools list the pair in opposite order (see core/poolPrice.ts).
      const matchBuyPrice = priceOf(pool, swap.tokenIn, decimalsOf);
      // Partner with the widest gap to the traded pool.
      let sellPool = peers[0];
      let matchSellPrice: number | null = null;
      for (const peer of peers) {
            const pp = priceOf(peer, swap.tokenIn, decimalsOf);
            if (pp === null || matchBuyPrice === null) continue;
            if (matchSellPrice === null || spreadPct(matchBuyPrice, pp) > spreadPct(matchBuyPrice, matchSellPrice)) {
                  matchSellPrice = pp;
                  sellPool = peer;
            }
      }
      if (matchBuyPrice !== null && matchSellPrice !== null) {
            const matchSpreadPct = spreadPct(matchBuyPrice, matchSellPrice);
            const matchPairLabel = `${symbolOf(swap.chain, pool.tokenA)}/${symbolOf(swap.chain, pool.tokenB)}`;
            const matchKey = `${swap.chain}:${matchPairLabel}`;
            const existingMatch = hourlyMatches.get(matchKey);
            if (!existingMatch || matchSpreadPct > existingMatch.spreadPct) {
                  hourlyMatches.set(matchKey, {
                        chain: swap.chain,
                        pair: matchPairLabel,
                        buyDex: venueLabel(pool),
                        sellDex: venueLabel(sellPool),
                        buyPrice: matchBuyPrice,
                        sellPrice: matchSellPrice,
                        spreadPct: matchSpreadPct,
                  });
            }
      }

const usdPerToken = priceOracle.getUsdPrice(swap.chain, swap.tokenIn);
if (usdPerToken === null) { if (swap.chain === 'robinhood') funnel.noUsdPrice++; return; }

// Predict the price AFTER this pending swap lands, then size the arb
// against that future price (not today's). See core/backrunPlanner.ts.
// Plan against EVERY partner pool and keep the best (used to try only the first).
let plan: ReturnType<typeof planBackrun> = null;
for (const peer of peers) {
      const candidate = planBackrun(cache, pool, peer, swap, usdPerToken, {
            gasPriceUsd: swap.chain === 'robinhood' ? rhGasUsd(2) : 2,
            dexFeeBps: { buy: pool.feeBps, sell: peer.feeBps }, // overwritten per direction inside planBackrun
            flashLoanFeeBps: 9,
            usingFlashLoan: true,
            safetyMarginPct: 0.15,
      }, decimalsOf(swap.chain, swap.tokenIn));
      if (candidate && (!plan || candidate.profit.conservativeNetProfitUsd > plan.profit.conservativeNetProfitUsd)) plan = candidate;
}
if (!plan) { if (swap.chain === 'robinhood') funnel.smallerThanFees++; return; }
if (swap.chain === 'robinhood') funnel.found++;
const { sizing, profit } = plan;

// Any real gap on Robinhood: find out a few seconds from now which bot took
// it and how fast, versus how fast we were ready (decision + ~2ms to sign).
if (swap.chain === 'robinhood' && sizing.grossProfitUsd >= 5) {
      rivals.watch({
            triggerHash: (event.raw as any)?.hash,
            triggerSeenMs: event.receivedAtMs,
            pools: [pool.poolAddress, ...peers.map((p) => p.poolAddress)],
            ourReadyMs: Date.now() - event.receivedAtMs + 2,
            profitUsd: sizing.grossProfitUsd,
      });
}
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

// Simulate what the model thinks is worth a look (gross >= SIM_MIN_GROSS_USD,
// default $0.50), even below the firing minimum, so we still learn where the
// model is wrong in both directions. Skipped: tokens live trading could never
// use (not vetted) and pool pairs that just tested as losers (5 min). Was
// "gross > 0 on any token": ~100 losing tests per 15 min, wasting Alchemy quota.
// $0.50 (was $2): on a quiet market almost nothing reached $2, so nothing
// got checked and no real data came in. QuickNode's daily allowance caps the cost.
const SIM_MIN_GROSS_USD = Number(process.env.SIM_MIN_GROSS_USD ?? 0.5);
const simVetted = swap.chain !== 'robinhood' || (safetyGate.isAllowed(swap.tokenIn) && safetyGate.isAllowed(swap.tokenOut));
if (swap.chain === 'robinhood') {
      if (sizing.grossProfitUsd < SIM_MIN_GROSS_USD) funnel.belowCheckBar++;
      else if (!simVetted) funnel.notVetted++;
      else funnel.sentToCheck++;
      // Research lane (off unless RESEARCH_LANE=1): maybe sample what the check bar or the vetted list threw away.
      if (research.enabled && (sizing.grossProfitUsd < SIM_MIN_GROSS_USD || !simVetted)) {
            const rc: ResearchCandidate = {
                  reason: sizing.grossProfitUsd < SIM_MIN_GROSS_USD ? 'below_sim_bar' : 'unvetted_token', source: 'trigger',
                  tokenIn: swap.tokenIn, buyPool: buyPoolUsed, sellPool: sellPoolUsed, sizeUsd: sizing.optimalTradeSizeUsd,
                  modelGrossUsd: sizing.grossProfitUsd, usdPerToken, vetted: simVetted, triggerHash: (event.raw as any)?.hash,
            };
            research.offer(rc.reason, `${buyPoolUsed.poolAddress}>${sellPoolUsed.poolAddress}`, () => rc);
      }
}
if (sizing.grossProfitUsd >= SIM_MIN_GROSS_USD && simVetted) {
      queueSimulation(swap.chain, swap.tokenIn, buyPoolUsed, sellPoolUsed, sizing.optimalTradeSizeUsd, sizing.grossProfitUsd, usdPerToken, (event.raw as any)?.hash);
}

if (!profit.qualifies) {
shadowLogger.record({ opportunity, outcome: 'SKIPPED_BELOW_MIN_PROFIT', ourHypotheticalReactionMs: reactionMs });
      // Only significant near-misses go to Telegram (per architecture doc:
      // "no play-by-play noise") — gross opportunity had to clear a real bar
      // even though it netted below the $20 minimum after costs.
      if (sizing.grossProfitUsd >= 30 && nearMissAllowed(`${swap.chain}:${[swap.tokenIn, swap.tokenOut].map((t) => t.toLowerCase()).sort().join('/')}`)) {
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
            cache.get(swap.chain, buyPoolUsed.poolAddress) ?? buyPoolUsed,
            cache.get(swap.chain, sellPoolUsed.poolAddress) ?? sellPoolUsed,
      );

console.log(
`[opportunity] ${swap.chain} predicted=${plan.usedPrediction} score=${score} net=$${profit.conservativeNetProfitUsd.toFixed(2)} ` +
`reaction=${reactionMs}ms`,
);

      // Build -> safety gate -> sign (send only if live). Shared with the
      // standing-gap scanner; see fireTrade() above.
      await fireTrade({
            chain: swap.chain, tokenIn: swap.tokenIn, tokenOut: swap.tokenOut,
            buyPool: buyPoolUsed, sellPool: sellPoolUsed,
            tradeSizeUsd: sizing.optimalTradeSizeUsd, netProfitUsd: profit.conservativeNetProfitUsd,
            usdPerTokenIn: usdPerToken, seenAtMs: event.receivedAtMs, source: 'trade',
      });
});

// Live trading is not implemented yet (adapters' fireTransaction() are
// placeholders). Make sure flipping the switch early can't be mistaken for
// the bot actually trading.
if (executionRequested() && !robinhoodSender.live) {
      console.warn('[execution] EXECUTION_ENABLED=true but LIVE_SEND_CONFIRM / BOT_PRIVATE_KEY not set -- dry run only');
      await sendTelegramMessage(formatExecutionWarning());
}
if (chainOn('robinhood')) {
      robinhoodSender.start()
            .then(async () => {
                  console.log(`[fire] robinhood sender ready (${robinhoodSender.live ? 'LIVE from ' + robinhoodSender.address : 'dry run'})`);
                  if (robinhoodSender.live) {
                        // Readiness checks before the first real send; retried every
                        // 5 min until they pass (e.g. lender approved later).
                        const runChecks = async () => {
                              liveChecks = await checkLiveReady(robinhoodReadProvider, {
                                    chain: 'robinhood', executor: executorConfig('robinhood').executorAddress, sender: robinhoodSender.address,
                                    tokens: [{ address: ROBINHOOD_TOKENS.WETH, label: 'WETH' }, { address: ROBINHOOD_TOKENS.USDG, label: 'USDG' }],
                                    lenders: [...approvedLenders('robinhood')],
                              }).catch((err) => ({ ok: false, problems: [`check error: ${(err as Error).message?.slice(0, 80)}`] }));
                              if (liveChecks.ok) console.log('[fire] live checks passed: chain, executor role, lenders, ArbSys deadline');
                              else {
                                    console.warn(`[fire] LIVE CHECKS FAILED, sends blocked: ${liveChecks.problems.join('; ')}`);
                                    await sendTelegramMessage(`🛑 <b>LIVE CHECKS FAILED</b> · sends blocked\n${liveChecks.problems.map((p) => '• ' + p.replace(/[<>&]/g, '')).join('\n')}`);
                                    setTimeout(() => { void runChecks(); }, 5 * 60_000);
                              }
                        };
                        await runChecks();
                        const b = await robinhoodSender.balanceCheck();
                        if (!b.ok) {
                              const msg = `bot wallet ${robinhoodSender.address} has ${ethers.formatEther(b.balance)} ETH, needs ${ethers.formatEther(b.needed)} per trade at the gas cap`;
                              console.warn(`[fire] LOW GAS: ${msg}`);
                              await sendTelegramMessage(`⚠️ <b>LOW GAS</b> · ${msg}`);
                        }
                  }
            })
            .catch((err) => console.warn('[fire] robinhood sender failed to start:', (err as Error).message));
}

await chainManager.startAll();

      const startStatus = chainManager.getStatus() as Record<string, { online: boolean }>;
      // Not awaited: a slow Telegram must never hold up startup.
      void sendTelegramMessage(formatStartup(startStatus)).catch(() => { /* logged by sender */ });

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
      if (chainOn('monad')) {
            await seedKuruMarket();
            setInterval(seedKuruMarket, 30_000);
      } // vault liquidity shifts as orders fill — keep it fresh

      // Uniswap V4 pools are found by the pair watcher (V4 venue in
      // ROBINHOOD_VENUES) with their full V4 details, so the old one-pair
      // V4 seed that used to sit here is gone.

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
      if (chainOn('monad')) {
            await seedMonadV3Peer();
            setInterval(seedMonadV3Peer, 30_000);
      }

      // Robinhood partner pools: every DEX + fee tier for WETH/USDG from the
      // start (replaces the old single Uniswap V2 + Ramses V2 seeds); other
      // pairs are added automatically as they trade (core/pairWatcher.ts).
      // Background: finding every WETH/USDG pool takes minutes on the free
      // RPC (one DEX and fee tier at a time). The bot is live meanwhile;
      // pools join the watch list as they're found.
      robinhoodWatcher.start();

      // STANDING-GAP SCANNER (core/gapScanner.ts): every 5 s, right after the
      // price re-sync, look for gaps that exist without a trigger trade.
      // Anti-spam: the same gap (pair + pools) fires at most once per 30 s,
      // at most 2 fires per scan, and every fire still passes the safety gate.
      // VERIFY FIRST: the scanner's maths assumes V3 pools are deep around the
      // current price, which isn't true for thin, narrow positions. So every
      // new gap is simulated on-chain (real pool code, ~1 s) before it counts:
      //   confirmed -> fired (dry run: logged) with the SIMULATED profit
      //   not real  -> muted for 30 min so it stops repeating
      const GAP_MIN_USD = Number(process.env.GAP_MIN_USD ?? 20);
      const GAP_FAKE_MUTE_MS = 30 * 60_000;
      const gapLastFired = new Map<string, number>();
      const gapMutedUntil = new Map<string, number>();
      let gapRunning = false; // a slow simulation must not let scans pile up
      // WHEN it runs: the moment any price changes (a trade we read from the
      // feed, or a price re-sync finishing), debounced 50 ms so a burst of
      // trades is one scan; plus every 5 s as a safety net. The scan only
      // reads prices already in memory, so running it often costs no RPC.
      let gapScanQueued: NodeJS.Timeout | null = null;
      requestGapScan = () => {
            if (gapScanQueued) return;
            gapScanQueued = setTimeout(() => { gapScanQueued = null; void runGapScan(); }, 50);
      };
      const runGapScan = async () => {
            if (gapRunning) return;
            gapRunning = true;
            try {
                  // Only pools with real money near their price ($1,000+ by default).
                  const usdRh = (t: string) => priceOracle.getUsdPrice('robinhood', t);
                  const pairs = robinhoodWatcher.watchedPairPools()
                        .map((addrs) => addrs.map((a) => cache.get('robinhood', a))
                              .filter((p): p is PoolState => !!p && deepEnough(p, decimalsOf, usdRh)));
                  // Gaps that need an extra venue (can't trade yet): counted for
                  // the report only, then those pools are left out.
                  if (RH_EXTRA_VENUES) {
                        const unsupported = findStandingGaps(pairs,
                              (t) => TOKEN_DECIMALS.robinhood?.[t.toLowerCase()],
                              (t) => priceOracle.getUsdPrice('robinhood', t),
                              { minProfitUsd: 0.25, flashFee: 0, gasUsd: rhGasUsd(0.05), maxTradeUsd: Number(process.env.MAX_TRADE_USD ?? 5_000) })
                              .filter((g) => !isExecutableVenue(g.buyPool.dex) || !isExecutableVenue(g.sellPool.dex));
                        for (const g of unsupported.slice(0, 20)) {
                              const ex = [g.buyPool.dex, g.sellPool.dex].filter((d) => !isExecutableVenue(d)).join('+');
                              funnelSkip(`standing gap needs ${ex} (can't trade yet), model $0.25+`);
                        }
                  }
                  for (let i = 0; i < pairs.length; i++) pairs[i] = pairs[i].filter((p) => isExecutableVenue(p.dex));
                  const gaps = findStandingGaps(pairs,
                        (t) => TOKEN_DECIMALS.robinhood?.[t.toLowerCase()],
                        (t) => priceOracle.getUsdPrice('robinhood', t),
                        { minProfitUsd: GAP_MIN_USD, flashFee: 0.0005, gasUsd: rhGasUsd(0.05), maxTradeUsd: Number(process.env.MAX_TRADE_USD ?? 5_000) });
                  let fired = 0;
                  for (const g of gaps) {
                        if (fired >= 2) break;
                        const key = `${g.buyPool.poolAddress}>${g.sellPool.poolAddress}`;
                        if (Date.now() < (gapMutedUntil.get(key) ?? 0)) continue;
                        if (Date.now() - (gapLastFired.get(key) ?? 0) < 30_000) continue;
                        gapLastFired.set(key, Date.now());
                        fired++;
                        const label = `${symbolOf('robinhood', g.base)}/${symbolOf('robinhood', g.quote)}`;
                        const route = `buy ${g.buyPool.dex} ${g.buyPool.feeBps / 100}% -> sell ${g.sellPool.dex} ${g.sellPool.feeBps / 100}%`;
                        const check = await checkRoundTrip('robinhood', g.quote, g.buyPool, g.sellPool, g.sizeUsd, g.quoteUsd);
                        if (check.status === 'rate_limited') {
                              // Can't verify right now: skip, don't mute, try again next time.
                              console.log(`[gap] ${label}: model ~$${g.profitUsd.toFixed(2)}, not verified (RPC busy), skipped`);
                              continue;
                        }
                        const simNet = check.status === 'profit' ? check.usd - rhGasUsd(0.05) /* gas */ : 0;
                        if (check.status !== 'profit' || simNet < Math.max(5, GAP_MIN_USD / 2)) {
                              gapMutedUntil.set(key, Date.now() + GAP_FAKE_MUTE_MS);
                              // A revert is "wouldn't go through" (with its reason);
                              // a loss or too-small profit is "would lose money".
                              if (check.status === 'fail') { gapStats.fail++; failTally.add(check.reason); }
                              else gapStats.fake++;
                              const why = check.status === 'profit' ? `real profit only $${check.usd.toFixed(2)}` : check.reason;
                              console.log(`[gap] ${label}: model said ~$${g.profitUsd.toFixed(2)} but NOT REAL (${why}); muted 30 min | ${route}`);
                              continue;
                        }
                        gapStats.found++;
                        gapStats.bestUsd = Math.max(gapStats.bestUsd, simNet);
                        console.log(`[gap] standing gap ${label} CONFIRMED: real ~$${simNet.toFixed(2)} (model $${g.profitUsd.toFixed(2)}) on $${Math.round(g.sizeUsd)} | ${route}`);
                        await fireTrade({
                              chain: 'robinhood', tokenIn: g.quote, tokenOut: g.base, buyPool: g.buyPool, sellPool: g.sellPool,
                              // Never trust the model over the simulation.
                              tradeSizeUsd: g.sizeUsd, netProfitUsd: Math.min(g.profitUsd, simNet), usdPerTokenIn: g.quoteUsd,
                              seenAtMs: robinhoodWatcher.lastRefreshMs || Date.now(), source: 'gap',
                        });
                  }
                  if (gapLastFired.size > 500) gapLastFired.clear();
                  for (const [k, t] of gapMutedUntil) if (t < Date.now()) gapMutedUntil.delete(k);
            } catch (err) {
                  console.warn('[gap] scan failed:', (err as Error).message);
            } finally {
                  gapRunning = false;
            }
      };
      setInterval(() => { void runGapScan(); }, 5_000);
      // Lender balances: one bundled read of every candidate lender pool's
      // coins + liquidity, first ~20 s after start (watch list loaded), then
      // every LENDER_REFRESH_MS. A failed read keeps the last good list.
      const refreshLenders = async () => {
            try {
                  rhDecisionCallMany ??= (await makeCaller(robinhoodReadProvider)).callMany;
                  const n = await lenderBalances.refresh(rhDecisionCallMany, lenderCandidates('robinhood'));
                  console.log(`[lenders] robinhood: balances read for ${n} possible lender pools`);
            } catch (err) {
                  console.warn('[lenders] robinhood balance read failed (keeping last list):', (err as Error).message);
            }
      };
      setTimeout(() => { void refreshLenders(); }, 20_000);
      setInterval(() => { void refreshLenders(); }, LENDER_REFRESH_MS);
      void robinhoodWatcher.watch(ROBINHOOD_TOKENS.WETH, ROBINHOOD_TOKENS.USDG, { pin: true })
            .then((n) => console.log(`[pairs] robinhood WETH/USDG: ${n} pools found`))
            .catch((err) => console.warn('[pairs] WETH/USDG discovery failed:', (err as Error).message));

      // Chain-wide scan: every pool on every Robinhood DEX factory, keeping
      // pairs that sit on 2+ pools with real money in each (core/universeScan.ts).
      // Catches pairs that trade too rarely for the traffic-driven watcher to
      // notice. Runs in the background (never delays startup), then every 6h.
      //   ROBINHOOD_SCAN_TOP      how many pairs to pin (default 20, 0 = off)
      //   ROBINHOOD_SCAN_MIN_USD  minimum money per pool (default 2000)
      // 80 pinned (was 20): every pair on 2+ pools with real money, up to 80,
      // is always watched; the rest of the 150 follow live traffic.
      const SCAN_TOP = Number(process.env.ROBINHOOD_SCAN_TOP ?? 80);
      const SCAN_MIN_USD = Number(process.env.ROBINHOOD_SCAN_MIN_USD ?? 2_000);
      // Pools found so far are saved here, so a restart (every auto-deploy)
      // only reads pools created since the last scan. Safe to delete: the
      // next scan just starts from scratch.
      const SCAN_STATE_FILE = 'data/robinhood-universe.json';
      // Top pairs from the last good scan (core/seedPairs.ts). Watched at
      // startup so the bot never runs on WETH/USDG alone while a scan is
      // slow or blocked. Falls back to the backup list in the repo.
      const TOP_PAIRS_FILE = 'data/robinhood-top-pairs.json';
      if (SCAN_TOP > 0) {
            const start = loadStartPairs(TOP_PAIRS_FILE, ROBINHOOD_SEED_PAIRS);
            const pairs = start.pairs.slice(0, SCAN_TOP);
            safetyGate.allowTokens(pairs.flatMap((p) => [p.a, p.b]));
            void (async () => {
                  // One at a time, in the background: startup is never delayed.
                  for (const p of pairs) {
                        try { await robinhoodWatcher.watch(p.a, p.b, { pin: true }); }
                        catch (err) { console.warn('[pairs] start pair watch failed:', (err as Error).message); }
                  }
                  const st = robinhoodWatcher.stats();
                  console.log(`[pairs] robinhood start list (${start.source}): ${pairs.length} pairs, now watching ${st.pairs} pairs, ${st.pools} pools`);
            })();
      }
      const loadScanState = (): ScanState => {
            try {
                  const st = JSON.parse(readFileSync(SCAN_STATE_FILE, 'utf8'));
                  if (st?.version === 1 && Array.isArray(st.pools)) return st;
            } catch { /* missing or unreadable: start fresh */ }
            return emptyScanState();
      };
      const saveScanState = (st: ScanState) => {
            try {
                  mkdirSync('data', { recursive: true });
                  writeFileSync(SCAN_STATE_FILE + '.tmp', JSON.stringify(st));
                  renameSync(SCAN_STATE_FILE + '.tmp', SCAN_STATE_FILE); // atomic: never a half-written file
            } catch (err) { console.warn('[scan] could not save state:', (err as Error).message); }
      };
      let scanState: ScanState | null = null;
      let scanRunning = false;
      const runRobinhoodScan = async () => {
            if (scanRunning || SCAN_TOP <= 0) return;
            scanRunning = true;
            try {
                  const t0 = Date.now();
                  scanState ??= loadScanState();
                  // Scan on HEAVY (bursty: thousands of reads). If the paid
                  // node refuses (e.g. its plan limits log queries), try once
                  // on the fast node before waiting 15 min. Progress is saved
                  // per factory, so a second attempt repeats nothing.
                  const scanOpts = { usdToken: ROBINHOOD_TOKENS.USDG, wrappedNative: ROBINHOOD_TOKENS.WETH, minPoolUsd: SCAN_MIN_USD,
                        maxLogRange: Number(process.env.ROBINHOOD_SCAN_LOG_RANGE ?? 500_000), log: (m: string) => console.log(m) };
                  // Gentle lane on the free node (see robinhoodScanProvider).
                  const res = await scanUniverse(robinhoodScanProvider, RH_EXTRA_VENUES ? [...ROBINHOOD_SCAN_FACTORIES, ...extraScanFactories()] : ROBINHOOD_SCAN_FACTORIES, scanOpts, scanState);
                  // Progress per factory is saved even if some failed.
                  if (res.errors.length) saveScanState(scanState);
                  if (res.errors.length && !res.candidates.length) throw new Error(`scan failed: ${res.errors.join('; ').slice(0, 150)}`);
                  saveScanState(scanState);
                  const top = res.candidates.slice(0, SCAN_TOP);
                  // Only replace the saved start list with a real result.
                  if (top.length) saveStartPairs(TOP_PAIRS_FILE, top.map((c) => ({ a: c.tokenA, b: c.tokenB })));
                  // Only vetted pairs' tokens may ever be traded (safety gate allowlist).
                  safetyGate.allowTokens(top.flatMap((c) => [c.tokenA, c.tokenB]));
                  console.log(`[scan] robinhood: ${res.totalPools} pools, ${res.multiPoolPairs} pairs on 2+ pools, ${res.candidates.length} with $${SCAN_MIN_USD}+ in 2+ pools (${Math.round((Date.now() - t0) / 1000)}s)${res.errors.length ? ' errors: ' + res.errors.join('; ') : ''}`);
                  // One pair at a time: the watcher does its own exact pool discovery.
                  for (const c of top) {
                        try { await robinhoodWatcher.watch(c.tokenA, c.tokenB, { pin: true }); }
                        catch (err) { console.warn('[scan] watch failed:', (err as Error).message); }
                  }
                  const st = robinhoodWatcher.stats();
                  console.log(`[scan] robinhood now watching ${st.pairs} pairs (${st.pinned} pinned), ${st.pools} pools`);
            } catch (err) {
                  // Usually the free public RPC rate-limiting us. Don't wait the
                  // full 6 hours: try again in 15 minutes.
                  // Paid node out of allowance / rate limited: wait 6 h, not 15 min
                  // (each retry would just fail again). Other errors: 15 min.
                  const msg = String((err as Error).message);
                  const outOfCredit = /429|allowance|rate limit|exceeded|too many/i.test(msg);
                  // Free node "slow down": try again in 30 min (progress is saved).
                  const retryMin = outOfCredit ? 30 : 15;
                  console.warn(`[scan] robinhood scan failed, retrying in ${retryMin} min:`, msg.slice(0, 200));
                  setTimeout(() => { void runRobinhoodScan(); }, retryMin * 60_000);
            } finally {
                  scanRunning = false;
            }
      };
      void runRobinhoodScan();

      // ---- Market-open measurement (stock tokens etc.) -------------------
      // Tokens with both a USDG pool and an ETH pool: how far apart are the
      // two prices, after fees, and is it worse around the 9:30 stock market
      // open? Measurement only (core/crossQuoteMonitor.ts). Report to
      // Telegram at 10:35 Toronto time on weekdays.
      const crossQuote = new CrossQuoteMonitor(
            async (calls) => { rhDecisionCallMany ??= (await makeCaller(robinhoodReadProvider)).callMany; return rhDecisionCallMany(calls); },
            ROBINHOOD_TOKENS.USDG, ROBINHOOD_TOKENS.WETH,
            () => priceOracle.getUsdPrice('robinhood', ROBINHOOD_TOKENS.WETH),
      );
      const OPEN_FROM = 9 * 60, OPEN_TO = 10 * 60 + 30, OPEN_REPORT = 10 * 60 + 35; // minutes after midnight, Toronto
      const toronto = () => {
            const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(new Date());
            const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
            const mins = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
            return { date: `${get('year')}-${get('month')}-${get('day')}`, mins, weekday: !['Sat', 'Sun'].includes(get('weekday')) };
      };
      const setupCrossQuote = async () => {
            try {
                  const st = scanState ?? loadScanState();
                  const n = await crossQuote.setup(stateToPools(st), Number(process.env.CROSS_QUOTE_TOKENS ?? 60));
                  console.log(`[openwatch] watching ${n} tokens that trade against both USDG and ETH`);
            } catch (err) { console.warn('[openwatch] setup failed:', (err as Error).message); }
      };
      setTimeout(() => { void setupCrossQuote(); }, 90_000);
      setInterval(() => { void setupCrossQuote(); }, 6 * 60 * 60_000);
      let lastCrossTick = 0;
      let crossBusy = false;
      setInterval(async () => {
            const t = toronto();
            const inOpen = t.weekday && t.mins >= OPEN_FROM && t.mins < OPEN_TO;
            if (crossBusy || Date.now() - lastCrossTick < (inOpen ? 5_000 : 15_000)) return;
            crossBusy = true; lastCrossTick = Date.now();
            try { await crossQuote.tick(inOpen, t.date); } catch { /* node busy: next tick */ } finally { crossBusy = false; }
      }, 1_000);
      // One line an hour for the status page: biggest after-fee gap today.
      setInterval(() => {
            const top = crossQuote.rows()[0];
            if (top) console.log(`[openwatch] ${crossQuote.tokenCount()} tokens; biggest gap today ${top.symbol}: open ${top.open.maxGapPct.toFixed(2)}% (after fees ${top.open.samples ? top.open.maxNetPct.toFixed(2) : 'n/a'}%), rest of day ${top.rest.maxGapPct.toFixed(2)}%`);
      }, 60 * 60_000);
      const OPEN_REPORT_FILE = 'data/open-report.json';
      setInterval(async () => {
            const t = toronto();
            if (!t.weekday || t.mins < OPEN_REPORT || t.mins > OPEN_REPORT + 30) return;
            let last = '';
            try { last = JSON.parse(readFileSync(OPEN_REPORT_FILE, 'utf8')).date ?? ''; } catch { /* first time */ }
            if (last === t.date) return;
            try {
                  writeFileSync(OPEN_REPORT_FILE, JSON.stringify({ date: t.date }));
                  await sendTelegramMessage(formatMarketOpenReport({ dateLabel: t.date, tokens: crossQuote.tokenCount(), rows: crossQuote.rows() }));
            } catch (err) { console.error('[telegram] market open report failed:', err); }
      }, 60_000);
      setInterval(() => { void runRobinhoodScan(); }, 6 * 60 * 60_000);

      // ---- Measurement only (Oct 8): new pools, coin groups, loops --------
      // All three read through the gentle scan lane on the free node (see
      // robinhoodScanProvider), never the price-read path, and never trade.
      let rhScanCallMany: ((calls: { target: string; data: string }[]) => Promise<(string | null)[]>) | null = null;
      const scanCallMany = async (calls: { target: string; data: string }[]) => {
            rhScanCallMany ??= (await makeCaller(robinhoodScanProvider)).callMany;
            return rhScanCallMany(calls);
      };

      // REAL V3 BALANCES (core/v3BalanceBook.ts, Phase 1 fix): every 10 min,
      // one bundled read of the coins each cached V3 pool really holds, so the
      // price oracle stops treating narrow-band pools as deep. Scan lane only,
      // never the trading path. First read 2 min after start.
      const v3Balances = new V3BalanceBook();
      priceOracle.useBalances(v3Balances);
      const refreshV3Balances = async () => {
            try {
                  const n = await v3Balances.refresh(scanCallMany, cache.allForChain('robinhood'));
                  console.log(`[oracle] real V3 balances read: ${n}`);
            } catch (err) { console.warn('[oracle] V3 balance read failed (kept old values):', (err as Error).message); }
      };
      setTimeout(() => { void refreshV3Balances(); }, 2 * 60_000);
      setInterval(() => { void refreshV3Balances(); }, 10 * 60_000);

      // NEW POOL COUNTER (core/newPoolWatch.ts): new pools for coins that
      // already trade deep, and how far off their starting price was.
      // One log request a minute (two when a new pool for deep coins appears).
      const NEW_POOLS_FILE = 'data/new-pools.json';
      const newPoolWatch = new NewPoolWatch({
            factories: ROBINHOOD_SCAN_FACTORIES,
            getLogs: async (addrs, from, to) => {
                  const out: RawLog[] = [];
                  await getLogsAdaptive(robinhoodScanProvider as ethers.JsonRpcProvider, addrs, from, to, (logs) => { out.push(...logs); }, 30_000, 200_000);
                  return out;
            },
            latestBlock: () => robinhoodScanProvider.getBlockNumber(),
            refPrice: (token) => priceOracle.getUsdPriceInfo('robinhood', token),
            decimals: (token) => TOKEN_DECIMALS.robinhood?.[token.toLowerCase()],
            symbol: (token) => symbolOf('robinhood', token),
      });
      newPoolWatch.load(NEW_POOLS_FILE);
      setInterval(() => { void newPoolWatch.poll(); }, Number(process.env.NEW_POOL_POLL_MS ?? 60_000));
      setInterval(() => newPoolWatch.save(NEW_POOLS_FILE), 10 * 60_000);
      newPoolWatchRef = newPoolWatch;

      // COIN GROUPS (core/tokenGroups.ts): dollar coins, ETH, Bitcoin
      // versions, verified copies. Names only make a candidate; verified =
      // $10k+ pool against USDG/WETH and price within 2% of the group.
      // Saved to data/token-groups.json, printed on the status page.
      const GROUPS_FILE = 'data/token-groups.json';
      const SYMBOLS_FILE = 'data/token-symbols.json';
      let tokenGroups: TokenGroupsResult | null = loadTokenGroups(GROUPS_FILE);
      if (tokenGroups) console.log(`[groups] ${groupsStatusLine(tokenGroups)} (saved list)`);

      // LOOP MONITOR (LoopMonitor in core/crossQuoteMonitor.ts): best 3-pool
      // loop per token across all verified coins, after all three real fees.
      const LOOP_STATS_FILE = 'data/loop-stats.json';
      const loopMonitor = new LoopMonitor(
            scanCallMany, Date.now,
            // Native-ETH pools vs WETH pools for the same token, from the pool
            // cache (Uniswap V4 pools aren't in the factory scan).
            () => {
                  const weth = ROBINHOOD_TOKENS.WETH.toLowerCase();
                  const byTok = new Map<string, { native?: PoolState; wrapped?: PoolState }>();
                  for (const p of cache.allForChain('robinhood')) {
                        const a = p.tokenA.toLowerCase(), b = p.tokenB.toLowerCase();
                        if (a !== weth && b !== weth) continue;
                        const tok = a === weth ? b : a;
                        const e = byTok.get(tok) ?? {};
                        if (p.v4?.native) { if (!e.native || p.feeBps < e.native.feeBps) e.native = p; }
                        else if (!e.wrapped || p.feeBps < e.wrapped.feeBps) e.wrapped = p;
                        byTok.set(tok, e);
                  }
                  return [...byTok.entries()].filter(([, e]) => e.native && e.wrapped)
                        .map(([tok, e]) => ({ label: `${symbolOf('robinhood', tok)}: ETH pool vs WETH pool`, token: tok, native: e.native!, wrapped: e.wrapped! }));
            },
            (token) => TOKEN_DECIMALS.robinhood?.[token.toLowerCase()],
      );
      loopMonitor.load(LOOP_STATS_FILE);
      // Set up further down, next to the LOOP REPORT (no-op until then).
      let scheduleFirstLoopReport: (tokensWatched: number) => void = () => {};
      let groupsBusy = false;
      const setupLoops = async (rebuildGroups: boolean) => {
            if (groupsBusy) return;
            groupsBusy = true;
            try {
                  const st = scanState ?? loadScanState();
                  const pools = stateToPools(st);
                  if (!pools.length) { console.log('[groups] no pool scan yet; will try again later'); return; }
                  if (rebuildGroups || !tokenGroups) {
                        tokenGroups = await buildTokenGroups({
                              callMany: scanCallMany, state: st, pools,
                              usdg: ROBINHOOD_TOKENS.USDG, weth: ROBINHOOD_TOKENS.WETH,
                              symbolCacheFile: SYMBOLS_FILE, outFile: GROUPS_FILE, log: (m) => console.log(m),
                        });
                  }
                  const quotes = tokenGroups.members.map((m) => ({ token: m.token, symbol: m.symbol, group: m.group, priceUsd: m.priceUsd }));
                  const n = await loopMonitor.setup(pools, quotes, Number(process.env.LOOP_TOKENS ?? 80));
                  console.log(`[loops] watching ${n} tokens that trade against 2+ of ${quotes.length} verified coins`);
                  scheduleFirstLoopReport(n);
            } catch (err) {
                  console.warn('[groups] build/setup failed, retrying later:', (err as Error).message);
            } finally {
                  groupsBusy = false;
            }
      };
      // After start: the saved list is used right away (if any) and rebuilt
      // in the background; then refreshed every 6 h like the pool scan.
      // (Only rebuild straight away when we started from a saved list; a
      // fresh build just ran, so a second one would only repeat it.)
      const groupsFromDisk = !!tokenGroups;
      setTimeout(() => { void setupLoops(false).then(() => (groupsFromDisk ? setupLoops(true) : undefined)); }, 3 * 60_000);
      setInterval(() => { void setupLoops(true); }, 6 * 60 * 60_000);
      let loopBusy = false;
      let loopErrors = 0;
      setInterval(async () => {
            if (loopBusy) return;
            loopBusy = true;
            try { await loopMonitor.tick(); } catch (err) {
                  if (++loopErrors % 20 === 1) console.warn('[loops] reading pools failed (will retry):', (err as Error).message);
            } finally { loopBusy = false; }
      }, Number(process.env.LOOP_TICK_MS ?? 30_000));
      setInterval(() => {
            loopMonitor.save(LOOP_STATS_FILE);
            console.log(loopMonitor.statusLine());
            console.log(newPoolWatch.statusLine(newPoolWatch.summary(Date.now() - 3600_000)));
            if (tokenGroups) console.log(`[groups] ${groupsStatusLine(tokenGroups)}`);
      }, 15 * 60_000);

      // LOOP REPORT to Telegram: the first one about 2 h after this update
      // goes live (only once ever), then daily at 9:10 Toronto time. Each
      // report covers the time since the previous one.
      const LOOP_REPORT_FILE = 'data/loop-report.json';
      const LOOP_REPORT_AT = 9 * 60 + 10; // minutes after midnight, Toronto
      const loopReportState = (): { date?: string; firstSent?: boolean } => {
            try { return JSON.parse(readFileSync(LOOP_REPORT_FILE, 'utf8')); } catch { return {}; }
      };
      const sendLoopReport = async (date: string) => {
            const hours = Math.max(0.1, (Date.now() - loopMonitor.periodStart) / 3600_000);
            writeFileSync(LOOP_REPORT_FILE, JSON.stringify({ ...loopReportState(), date, firstSent: true }));
            await sendTelegramMessage(formatLoopReport({
                  dateLabel: date, hours, tokens: loopMonitor.tokenCount(), quotes: loopMonitor.quoteList(),
                  rows: loopMonitor.rows(), pegs: loopMonitor.pegRows(),
            }));
            loopMonitor.resetPeriod();
            loopMonitor.save(LOOP_STATS_FILE);
      };
      // The first report's 2 h clock starts once the loop watch has tokens
      // (see setupLoops), not at bot start: the coin list can take a while.
      let firstLoopReportScheduled = false;
      scheduleFirstLoopReport = (tokensWatched: number) => {
            if (!shouldScheduleFirstLoopReport(!!loopReportState().firstSent, firstLoopReportScheduled, tokensWatched)) return;
            firstLoopReportScheduled = true;
            const ms = Number(process.env.LOOP_FIRST_REPORT_MS ?? 2 * 3600_000);
            console.log(`[loops] first LOOP REPORT in ${Math.round(ms / 60_000)} min`);
            setTimeout(() => { void sendLoopReport(toronto().date).catch((err) => console.error('[telegram] loop report failed:', err)); }, ms);
      };
      scheduleFirstLoopReport(loopMonitor.tokenCount()); // e.g. saved list loaded already
      setInterval(async () => {
            const t = toronto();
            if (t.mins < LOOP_REPORT_AT || t.mins > LOOP_REPORT_AT + 30) return;
            if (loopReportState().date === t.date) return;
            try { await sendLoopReport(t.date); } catch (err) { console.error('[telegram] loop report failed:', err); }
      }, 60_000);

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
      if (chainOn('monad')) {
            await checkMonadWatchList();
            setInterval(checkMonadWatchList, 30_000);
      }

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
                        // Compare EVERY pool of the pair (all exchanges and fee
                        // levels), not just the first two found, priced in the same
                        // base token. Report the cheapest vs the dearest.
                        // (Before: only the first two pools, which were nearly
                        // always Uniswap V2/V3, so other exchanges never showed.)
                        let cheap: { p: PoolState; price: number } | null = null, dear: typeof cheap = null;
                        for (const p of [pool, ...peers]) {
                              if (!deepEnough(p, decimalsOf, (t) => priceOracle.getUsdPrice(chain, t))) continue; // near-empty pool: its price means nothing
                              const price = priceOf(p, pool.tokenA, decimalsOf);
                              if (price === null) continue;
                              if (!cheap || price < cheap.price) cheap = { p, price };
                              if (!dear || price > dear.price) dear = { p, price };
                        }
                        if (!cheap || !dear || cheap.p === dear.p) continue;
                        const pair = `${symbolOf(chain, pool.tokenA)}/${symbolOf(chain, pool.tokenB)}`;
                        const key = `${chain}:${pair}`;
                        const gap = spreadPct(cheap.price, dear.price);
                        const existing = hourlyMatches.get(key);
                        if (!existing || gap > existing.spreadPct) {
                              // "buy" = cheaper venue, "sell" = dearer one
                              hourlyMatches.set(key, {
                                    chain, pair, buyDex: venueLabel(cheap.p), sellDex: venueLabel(dear.p),
                                    buyPrice: cheap.price, sellPrice: dear.price, spreadPct: gap,
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
            return (['monad', 'robinhood', 'avalanche'] as const).filter(chainOn).map((chain) => {
                  const spreads = [...(byChain.get(chain)?.values() ?? [])];
                  let noMatchCount = 0;
                  if (chain === 'monad') {
                        const matched = new Set(spreads.map((sp) => sp.pair.split('/').sort().join('/')));
                        noMatchCount = monadWatchedPairs.filter(({ tokenA, tokenB }) =>
                              !matched.has([symbolOf('monad', tokenA), symbolOf('monad', tokenB)].sort().join('/')),
                        ).length;
                  }
                  let note: string | undefined;
                  if (chain === 'robinhood') {
                        const st = robinhoodWatcher.stats();
                        const tot = priceStats.local + priceStats.rpc;
                        const localPct = tot ? Math.round((100 * priceStats.local) / tot) : 0;
                        const fr = [...fireStats.readyMs].sort((a, b) => a - b);
                        const fireNote = fr.length ? `, fire-ready ${fr[Math.floor(fr.length / 2)]}ms median (${fr.length})` : '';
                        const rv = rivals.summary();
                        const rivalNote = rv.found ? `, rivals ${rv.theirMedianMs ?? '?'}ms vs ours ${rv.ourMedianMs ?? '?'}ms (we'd beat ${rv.beatCount}/${rv.comparable})` : '';
                        const gapNote = (gapStats.found ? `, standing gaps ${gapStats.found} confirmed (best real $${gapStats.bestUsd.toFixed(0)})` : '') + (gapStats.fake ? `, ${gapStats.fake} fake gaps muted` : '');
                        const lv = liveTracker.summary();
                        const liveNote = lv.sent ? `, LIVE ${lv.won}/${lv.sent} won, profit $${lv.profitUsd.toFixed(2)}, gas $${lv.gasUsd.toFixed(2)}` : '';
                        // Which node prices come from right now, and how often the fast one had to rest.
                        const rpc = robinhoodReadProvider.router.getStats();
                        const rpcNote = `, prices on ${rpc.onFast ? 'fast node' : 'paid node (fast node resting)'}${rpc.switches ? ` (${rpc.switches} switch${rpc.switches === 1 ? '' : 'es'} to paid node since start)` : ''}`;
                        const pnlNote = `, ${dryRunPnl.line()}`;
                        console.log(`[pnl] ${dryRunPnl.line()}`);
                        note = `watching ${st.pairs} pair${st.pairs === 1 ? '' : 's'}, ${st.pools} pools${tot ? `, ${localPct}% instant prices` : ''}${fireNote}${rivalNote}${gapNote}${liveNote}${rpcNote}${pnlNote}`;
                  }
                  return { chain, spreads, noMatchCount, note };
            });
      };

      let lastDigestAt = Date.now();
      const sendHourlyDigest = async () => {
            const now = Date.now();
            try {
                  samplePricesIntoMatches();
                  const stats = shadowLogger.windowStats(lastDigestAt, now);
                  const status = chainManager.getStatus() as Record<string, { online: boolean }>;
                  // Robinhood only (the normal setup): the plain-English report.
                  // Other chains switched on: the older detailed digest.
                  if (chainOn('robinhood') && !chainOn('monad') && !chainOn('avalanche')) {
                        const sections = buildDigestSections();
                        const rh = sections.find((s) => s.chain === 'robinhood');
                        const st = robinhoodWatcher.stats();
                        const rpc = robinhoodReadProvider.router.getStats();
                        const pnl = dryRunPnl.summary();
                        const rv = rivals.summary();
                        // New pools this hour (core/newPoolWatch.ts), also one line for the status page.
                        const hourNewPools = newPoolWatchRef?.takeHour() ?? null;
                        if (hourNewPools && newPoolWatchRef) console.log(newPoolWatchRef.statusLine(hourNewPools));
                        await sendTelegramMessage(formatPlainHourly({
                              windowLabel: `${hhmm(lastDigestAt)} to ${hhmm(now)}`,
                              live: robinhoodSender.live,
                              feedOk: status.robinhood?.online ?? false,
                              feedReconnects: chainHealthFlapCount.robinhood ?? 0,
                              pairs: st.pairs, spots: st.pools,
                              pricesFrom: rpc.onFast ? 'free' : 'backup',
                              freeNodeBusy: rpc.switches,
                              differencesFound: stats.seen,
                              // Trigger-trade checks + standing-difference checks together.
                              checks: {
                                    done: simStats.checked + gapStats.found + gapStats.fake + gapStats.fail,
                                    makeMoney: simStats.profit + gapStats.found,
                                    loseMoney: simStats.loss + gapStats.fake,
                                    wouldFail: simStats.fail + gapStats.fail,
                                    failReasons: failTally.plain(),
                                    timing: { ...checkTiming },
                                    winSizes: { bars: WIN_BARS, hour: [...winSizes.hour], today: [...winSizes.today], todayUsd: [...winSizes.todayUsd] },
                                    benchedRoutes: routeScores.benchedCount(),
                                    nodeBusy: simStats.rateLimited,
                              },
                              checksAvailable: !(simStats.checked === 0 && (simStats.rateLimited > 0 || !!simOff('robinhood'))),
                              earned: {
                                    todayChecked: pnl.today.verifiedUsd, todayCheckedCount: pnl.today.verifiedCount,
                                    todayUnchecked: pnl.today.modelUsd, todayUncheckedCount: pnl.today.modelCount,
                                    weekChecked: pnl.last7.verifiedUsd,
                              },
                              reactionMs: { typical: stats.medianReactionMs, slowest5pct: stats.p95ReactionMs },
                              otherBots: { timed: rv.found, theirMs: rv.theirMedianMs, oursMs: rv.ourMedianMs, weBeat: rv.beatCount },
                              rivalWins: { ...rivalWatch.takeHour(), botsKnown: rivalWatch.botCount(), botsVerified: rivalWatch.botStatus().verified },
                              newPools: hourNewPools ?? undefined,
                              nodeUsage: nodeUsageToday(),
                              ourGas: (() => {
                                    const eth = priceOracle.getUsdPrice('robinhood', ROBINHOOD_TOKENS.WETH);
                                    return { ownUsd: robinhoodSender.gasCostUsdFor(OUR_GAS_OWN, eth), flashUsd: robinhoodSender.gasCostUsdFor(OUR_GAS_FLASH, eth) };
                              })(),
                              profitBands: { hour: [...profitBands.hour], day: [...profitBands.day], hourUsd: profitBands.hourUsd, dayUsd: profitBands.dayUsd },
                              simOutcomes: simBuckets.plain(),
                              research: researchHourText(),
                              funnel: {
                                    tradesRead: funnel.tradesRead, noPool: funnel.noPool, tooSmall: funnel.tooSmall, noPartner: funnel.noPartner,
                                    noUsdPrice: funnel.noUsdPrice, smallerThanFees: funnel.smallerThanFees, found: funnel.found,
                                    belowCheckBar: funnel.belowCheckBar, checkBarUsd: Number(process.env.SIM_MIN_GROSS_USD ?? 0.5),
                                    notVetted: funnel.notVetted, sentToCheck: funnel.sentToCheck,
                                    skipped: [...funnel.skip.entries()].sort((a, b) => b[1] - a[1]),
                              },
                              topDifferences: [...(rh?.spreads ?? [])].sort((a, b) => b.spreadPct - a.spreadPct)
                                    .map((d) => ({ pair: d.pair, pct: d.spreadPct, buyAt: d.buyDex, sellAt: d.sellDex })),
                        }));
                  } else await sendTelegramMessage(formatHourlyDigest({
                        windowLabel: `${hhmm(lastDigestAt)} to ${hhmm(now)}`,
                        chains: (['avalanche', 'monad', 'robinhood'] as const).filter(chainOn).map((chain) => ({
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
                  simStats.checked = simStats.profit = simStats.loss = simStats.fail = simStats.rateLimited = 0;
                  profitBands.resetHour(); simBuckets.clear();
                  funnel.tradesRead = funnel.noPool = funnel.tooSmall = funnel.noPartner = funnel.noUsdPrice = funnel.smallerThanFees = 0;
                  funnel.found = funnel.belowCheckBar = funnel.notVetted = funnel.sentToCheck = 0;
                  funnel.skip.clear();
                  failTally.clear();
                  checkTiming.rightAfter = checkTiming.othersInBlock = checkTiming.late = 0;
                  if (recheckStats.done) console.log(`[sim] robinhood free-node re-checks this hour: ${recheckStats.done}, answer changed ${recheckStats.changed}`);
                  recheckStats.done = recheckStats.changed = 0;
                  winSizes.resetHour();
                  priceStats.local = priceStats.rpc = 0;
                  fireStats.readyMs = []; fireStats.blocked.clear(); fireStats.sent = 0;
                  rivals.reset();
                  gapStats.found = 0; gapStats.bestUsd = 0; gapStats.fake = 0; gapStats.fail = 0;
                  liveTracker.reset();
                  lastDigestAt = now;
            }
      };
      setInterval(sendHourlyDigest, 60 * 60 * 1000);
      // Watch list size every 15 min (shown on the GitHub status page).
      setInterval(() => {
            const ws = robinhoodWatcher.stats();
            console.log(`[pairs] robinhood watch list: ${ws.pairs} pairs, ${ws.pools} pools (${ws.pinnedWatched}/${ws.pinned} pinned found, ${ws.queued} queued)`);
      }, 15 * 60_000);
      // Hourly memory housekeeping: drop cached pools that aren't in a watched
      // pair, aren't an approved flash lender and haven't been touched for
      // 2 h. They're re-discovered on demand if trades show up again.
      setInterval(() => {
            try {
                  const keep = new Set<string>(robinhoodWatcher.watchedPairPools().flat().map((a) => a.toLowerCase()));
                  for (const c of ['robinhood', 'monad', 'avalanche']) for (const l of approvedLenders(c)) keep.add(l);
                  const removed = cache.prune((p) => keep.has(p.poolAddress.toLowerCase()), 2 * 3600_000);
                  console.log(`[mem] pruned ${removed} idle pools (cache ${cache.size()}, opportunity log ${shadowLogger.size}, heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB)`);
            } catch (err) { console.warn('[mem] prune failed:', (err as Error).message); }
      }, 60 * 60 * 1000);
      console.log(`[startup] fully running ${Math.round((Date.now() - BOOT_MS) / 1000)}s after start`);

      // Report on demand (see the SIGUSR2 handler at the top of this file).
      reportNow = sendHourlyDigest;
      if (reportRequested) { reportRequested = false; void sendHourlyDigest(); }
      // First report 10 minutes after start, so a fresh deploy shows up in
      // Telegram quickly instead of an hour later.
      setTimeout(() => { void sendHourlyDigest(); }, 10 * 60 * 1000);

      // Daily RIVAL BOT REPORT at 9:00 Toronto time (Stage 0: learn from the
      // other bots). Sent once per day; the date is saved so a restart
      // doesn't send it twice. Covers the last 24 h of saved rival trades.
      const RIVAL_DAILY_FILE = 'data/rival-daily.json';
      const RIVAL_DAILY_HOUR = Number(process.env.RIVAL_DAILY_HOUR ?? 9);
      const torontoNow = () => {
            const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date());
            const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
            return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
      };
      const sendRivalDaily = async () => {
            const now = Date.now();
            const sum = rivalWatch.summary(now - 24 * 3600_000, now);
            const hours = Math.min(24, Math.max(0.1, (now - rivalWatch.firstRecordMs(now - 24 * 3600_000)) / 3600_000));
            await sendTelegramMessage(formatRivalDaily({ dateLabel: torontoNow().date, hours, summary: sum, botsKnown: rivalWatch.botCount(), botsVerified: rivalWatch.botStatus().verified,
                  newPools: newPoolWatchRef?.summary(now - 24 * 3600_000, now) }));
      };
      setInterval(async () => {
            const t = torontoNow();
            if (t.hour !== RIVAL_DAILY_HOUR) return;
            let last = '';
            try { last = JSON.parse(readFileSync(RIVAL_DAILY_FILE, 'utf8')).date ?? ''; } catch { /* first time */ }
            if (last === t.date) return;
            try {
                  writeFileSync(RIVAL_DAILY_FILE, JSON.stringify({ date: t.date }));
                  await sendRivalDaily();
            } catch (err) { console.error('[telegram] rival daily report failed:', err); }
      }, 60_000);
      // First taste: a rival report 2 hours after start, so you don't wait
      // until tomorrow morning to see the format.
      setTimeout(() => { void sendRivalDaily().catch(() => {}); }, Number(process.env.RIVAL_FIRST_REPORT_MS ?? 2 * 3600_000));

      let lastDailyAt = Date.now();
      setInterval(async () => {
            const now = Date.now();
            try {
                  const stats = shadowLogger.windowStats(lastDailyAt, now);
                  const uptimePct: Record<string, number | null> = {};
                  for (const [chain, t] of Object.entries(healthTicks)) {
                        uptimePct[chain] = t.total > 0 ? (t.healthy / t.total) * 100 : null;
                  }
                  if (chainOn('robinhood') && !chainOn('monad') && !chainOn('avalanche')) {
                        const pnl = dryRunPnl.summary();
                        await sendTelegramMessage(formatPlainDaily({
                              dateLabel: dayLabel(lastDailyAt),
                              differencesFound: stats.seen,
                              earnedChecked: pnl.today.verifiedUsd, earnedCheckedCount: pnl.today.verifiedCount,
                              weekChecked: pnl.last7.verifiedUsd,
                              feedUptimePct: uptimePct.robinhood ?? null,
                        }));
                  } else await sendTelegramMessage(formatDailyReport({
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
