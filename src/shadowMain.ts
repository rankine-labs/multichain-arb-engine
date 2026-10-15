import 'dotenv/config';
// Scrub API keys / tokens from every log line (must stay the 2nd import).
import './core/logSanitizer.install';
// Fill in CHECK_RPC_* from the saved Chainstack/QuickNode links and turn the
// practice loop trader on, unless .env already sets them (config/envDefaults.ts).
import './config/envDefaults';
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
import { urV4DecodeOn, takeUrV4Hour } from './core/decoderV4Router';
import { FastFilter } from './core/fastFilter';
import { PriceOracle } from './core/priceOracle';
import { findOptimalTradeSize, calculateAllInProfit, buildOpportunity, calculateLiquidityCeiling } from './core/profitCalculator';
import { scoreOpportunity, shouldPreArm } from './core/opportunityScorer';
import { planBackrun } from './core/backrunPlanner';
import { seedKnownAddresses } from './config/knownAddresses';
// ethers v5 (needed only by the Kuru SDK on Monad) is loaded further down, only when Monad is on.
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
import { RawChainEvent, PoolState, MIN_NET_PROFIT_USD } from './core/types';
import { priceOf, spreadPct, deepEnough, POOL_MIN_DEPTH_USD, realBalanceOf } from './core/poolPrice';
import { PairWatcher, Venue, refreshPoolState, refreshPoolsBatch } from './core/pairWatcher';
import { scanUniverse, emptyScanState, ScanState, stateToPools, stateToPoolsSteps, scanPoolRefs, getLogsAdaptive, RawLog } from './core/universeScan';
import { CrossQuoteMonitor, LoopMonitor, shouldScheduleFirstLoopReport } from './core/crossQuoteMonitor';
import { NewPoolWatch } from './core/newPoolWatch';
import { buildTokenGroups, loadTokenGroups, groupsStatusLine, TokenGroupsResult } from './core/tokenGroups';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { ROBINHOOD_SCAN_FACTORIES } from './config/knownAddresses';
// Uniswap V4 in the chain-wide scan, asked PER PAIR (core/v4Lookup.ts), not
// from V4's history (that ran out of memory twice on Oct 9). RH_V4_SCAN=0 off.
const RH_V4_SCAN = process.env.RH_V4_SCAN !== '0';
import { buildExecuteCall, executionRequested, executorConfig, pickV3Lender, kindForPool } from './execution/executorCalldata';
import { GasModel, GasCalibration, gasSettingsFromEnv, routeKeyFor, twoPoolKey, defaultUnitsFor, costsLine, loopKey } from './core/gasModel';
import { recordEventFee, eventFeeCounts, feeFromEventsOn, setHeadBlockSource, currentHeadBlock } from './core/eventFees';
import { OwnMoneyBook, useOwnMoney } from './core/ownMoney';
import { BlockReader, PoolUpdate } from './core/blockReader';
import { AutoVet, CheckOutcome } from './core/autoVet';
import { FailTally } from './core/failReasons';
import { LenderBalances } from './core/lenderBalances';
import { RouteScores, WinSizes, WIN_BARS } from './core/routeScore';
import { readOutlierConfig, isOutlier, confirmOutlier, withDeadline, OutlierVerdict } from './core/outlierGuard';
import type { ExecutorHop } from './execution/executorCalldata';
import { RivalWatch } from './core/rivalWatch';
import { V3BalanceBook, V3_BALANCES_FILE } from './core/v3BalanceBook';
import { extraWatcherVenues, extraScanFactories, isExecutableVenue, canPracticeTestVenue, reportedVenueIds, venueShortName } from './config/robinhoodVenues';
import { VenueTally } from './core/venueTally';
// Practice-test a pool: exchanges we trade, plus extra venues that passed the
// executor fork test (config/robinhoodVenues.ts canPracticeTestVenue). Fables
// stays watch-only until its practiceTested run is recorded there. Real
// trades still need isExecutableVenue (fireTrade refuses everything else).
const canPracticeTest = (dex: string) => canPracticeTestVenue(dex);
// Practice tests and wins per new exchange, for the hourly report and the
// status page (core/venueTally.ts). Fixed list of venue ids = bounded memory.
const venueTally = new VenueTally(reportedVenueIds(), venueShortName);
// OWN MONEY (Oct 8, owner): plan and test Robinhood trades as paid from our
// own balance, no flash loan (RH_FUNDING=flash brings loans back).
const RH_OWN_MONEY = process.env.RH_FUNDING !== 'flash';
const OWN_MONEY_MAX_USD = Number(process.env.OWN_MONEY_MAX_USD ?? 2_000);
// BIG GAPS ALWAYS GET LOOKED AT (Oct 11, owner approved). Pool pairs that keep
// losing small checks are benched (6 h) or muted (5 to 30 min) to save
// checks. But a big trade can open a real gap on exactly such a pair (Sunday's
// $535 NET gap was on a busy pair). Any gap the bot's maths puts at
// BENCH_BYPASS_USD ($1 default) or more ignores the bench and mutes.
const BENCH_BYPASS_USD = Number(process.env.BENCH_BYPASS_USD ?? 1);
// Biggest trade, in dollars (MAX_TRADE_USD). Was $5,000: on a huge gap the
// best size can be far bigger, so big wins were cut short. Trades above the
// own-money limit borrow, and only from a lender that really holds enough;
// the contract still cancels anything that wouldn't make money.
const MAX_TRADE_USD = Number(process.env.MAX_TRADE_USD ?? 20_000);
// Coins the own-money check couldn't fund (no findable balance storage):
// their next tests borrow instead, so they're tested rather than skipped.
const noBalanceSlot = new Set<string>();
const noteNoSlot = (token: string, reason: string) => { if (/balance storage/i.test(reason)) { noBalanceSlot.add(token.toLowerCase()); if (noBalanceSlot.size > 2_000) noBalanceSlot.clear(); } };
// Read prices on the extra Robinhood venues (watch only; never traded).
// ON by default since Oct 8 (owner approved tracking); RH_EXTRA_VENUES=0 turns it off.
const RH_EXTRA_VENUES = process.env.RH_EXTRA_VENUES !== '0';
import { ProfitBands } from './core/profitBands';
import { RaceChecker } from './core/raceCheck';
import { GapCredit } from './core/gapCredit';
import { FablesFeeBook, readFablesFees } from './core/fablesFee';
import { setHookedFeeSource } from './core/pairWatcher';
import { SimBucketTally, classifySimOutcome } from './core/failReasons';
import { makeRpc, simulateRoundTrip, simulateWithRecheck, simRpcUrl, Rpc, makeFallbackRpc, loadBalanceSlots, wssToHttps, replayRpc, ReplayCall } from './execution/simulator';
import { FastSender, SafetyGate, safetyConfigFromEnv } from './execution/fastSender';
import { DEFAULT_FILTER_CONFIG } from './core/fastFilter';
import { checkLiveReady } from './execution/liveReadiness';
import { LiveTradeTracker } from './execution/liveTracker';
import { LiveTradeLog } from './execution/liveTradeLog';
import { SafetyAlerts } from './execution/safetyAlerts';
import { AlertHooks } from './report/alertHooks';
import { getHeapStatistics } from 'v8';
import { findStandingGaps, findStandingGapsSteps, GapScanMemo } from './core/gapScanner';
import { CompetitorTracker } from './core/competitorTracker';
import { pickRobinhoodReadRpc, robinhoodSendRpc, redact, ROBINHOOD_PUBLIC_RPC } from './config/robinhoodEndpoints';
import { loadStartPairs, saveStartPairs } from './core/seedPairs';
import { DryRunPnl } from './core/dryRunPnl';
import { RealisticPnl, readStartCoins, WinFacts } from './core/realisticPnl';
import { StableTally, parseStableEnv } from './core/stableTally';
import { FailoverJsonRpcProvider } from './core/failoverRpc';
import { makeCaller } from './core/universeScan';
import { loadNodeUsage, saveNodeUsage, nodeUsageToday, NodeBudget, budgetForUrl, callsInBody } from './core/nodeBudget';
import { endpointLabel } from './core/endpointLabel';
// Any-provider node settings (off unless set in .env, see docs/NODE_PROVIDERS.md).
import { checkNodesFromEnv, buildCheckRpc } from './core/checkNodes';
import { WsBlockReader } from './core/blockReaderWs';
import { nodeUsage as nodeUsageCounter } from './core/nodeUsage';
import { ROBINHOOD_SEED_PAIRS } from './config/robinhoodSeedPairs';
import { ResearchLane, researchConfigFromEnv, planShallowCandidate, findResearchGaps, gapCandidate, ResearchCandidate } from './core/researchLane';
import { poolDepthUsd, setRealBalanceSource, thinPools, thinPoolsSteps } from './core/poolPrice';
// Loop trader v1 (3-5 pool loops, practice only, off unless LOOP_TRADER=1).
import { LoopTrader, loopConfigFromEnv, LoopCheckResult, LoopTrade } from './core/loopTrader';
// Which node loop practice checks run on (LOOP_CHECK_NODE, default the free public node).
import { loopNodeFromEnv, LoopNodeGuard, runLoopCheck, LoopCheckDeps, loopNodeText, LoopNodeThrottle, LoopNodeBusy, loopMaxRpsFromEnv } from './core/loopNode';
// Loop fix phase 2: real (block-confirmed) prices, trigger replay, cheap scans (core/loopPrices.ts).
import { loopFixFromEnv, PendingTrades, loopPoolState } from './core/loopPrices';
import { formatLoopHour, loopLogLine } from './core/loopReport';
import { startMemReport, registerSize, registerMemNote } from './core/memReport';
// Loop trader extra pools: keeps single-pool pairs fresh for the loop finder only (off unless LOOP_TRADER=1).
import { LoopExtraPools, loopExtraConfigFromEnv, readerAddresses, afterReaderWrite } from './core/loopExtraPools';
// Loop worker: the loop trader in its own thread (LOOP_WORKER, default on with LOOP_TRADER=1).
import { MainLoopFeeder, loopWorkerFromEnv } from './core/loopWorkerFeed';
import { LoopWorkerHost, loopWorkerHeapMbFromEnv } from './core/loopWorkerHost';
// Speed fixes (Oct 13): stage timers, preload, trust the WebSocket for prices.
import { StageTimers, StageTrace } from './core/stageTimer';
import { trustFreshConfigFromEnv, wsTrustProblem, WsFacts } from './core/trustFresh';
// Stall finder (Oct 14): which job froze the bot, plus chunked versions of the big jobs.
import { stallFinder, timed, timedAsync, formatStallLine, formatStallDetail, markStretch, labelled } from './core/stallFinder';
import { runSteps, drainSteps, writeJsonChunkedQueued } from './core/chunked';
// REPORT_CHUNKED (Oct 14, freeze phase 1): the thin pool check and the
// hourly report's price sample run in small bites (same results) instead
// of one long freeze. REPORT_CHUNKED=0 = one go (old behaviour).
const REPORT_CHUNKED = process.env.REPORT_CHUNKED !== '0';

// STALL FIXES (Oct 14). Big jobs done in ~5 ms bites so trades never wait
// behind them. Each has an off switch in .env (all on by default):
//   STALL_FINDER=0           turns off the freeze detector (measurement only)
//   STALL_FIX_EXTRA_PICK=0   loop extra-pool pick in one go again (core/loopExtraPools.ts)
//   STALL_FIX_SCAN_EXPAND=0  chain-wide pool list (~400k pools) expanded in one go again
//   STALL_FIX_SAVES=0        chain-wide scan file saved in one go again (writeFileSync)
//   STALL_FIX_LOOP_DEBOUNCE=0 the 5 s loop scan safety net runs directly again
//                            (instead of through the same 50 ms queue as every other loop scan)
const stallFixOn = (name: string) => process.env[name] !== '0' && process.env[name] !== 'off';
const STALL_FIX_SCAN_EXPAND = stallFixOn('STALL_FIX_SCAN_EXPAND');
const STALL_FIX_SAVES = stallFixOn('STALL_FIX_SAVES');
const STALL_FIX_LOOP_DEBOUNCE = stallFixOn('STALL_FIX_LOOP_DEBOUNCE');
// REBUILD_PACED (Oct 15, freeze fix): the 6-hourly / startup rebuilds take
// short breaks in their remaining long steps, so no single step holds the
// bot for seconds. Same results. Covers: the chain-wide pool scan (hand-
// written read requests, pricing, new-pool bookkeeping, V4 single-pool
// list), the coin names file (read/written in bites), and the cross-quote
// and loop monitor setups. The pool scan is also listed as "in progress"
// for the freeze report. REBUILD_PACED=0 = the old one-go way.
const REBUILD_PACED = stallFixOn('REBUILD_PACED');

async function main() {
stallFinder.start();
const cache = new PoolCache();
const shadowLogger = new ShadowLogger();
// Memory line every 5 min (core/memReport.ts; MEM_LOG=0 turns it off). Measurement only.
const memReport = startMemReport();
registerSize('opportunities', () => shadowLogger.size);
registerSize('pools', () => cache.size());
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
setInterval(() => timed('node usage save', saveNodeUsage), 60_000);
// Token balance locations found by earlier runs (saves the lookup after a restart).
loadBalanceSlots('data/balance-slots.json');
// Alchemy (ROBINHOOD_RPC_HTTP): fallback node for checks when QuickNode is set.
const rhHeavyUrlForSims = process.env.ROBINHOOD_RPC_HTTP || null;
// ANY-PROVIDER CHECK NODES (core/checkNodes.ts). Only when CHECK_RPC_MAIN is
// set in .env; otherwise null and the QuickNode/Alchemy code below runs as before.
const checkPlan = checkNodesFromEnv(process.env, (m) => console.warn(`[sim] ${m}`));
for (const chain of ['avalanche', 'monad', 'robinhood'] as const) {
      const { url, source } = simRpcUrl(chain);
      if (chain === 'robinhood' && checkPlan) {
            for (const w of checkPlan.warnings) console.warn(`[sim] ${w}`);
            const built = buildCheckRpc(checkPlan);
            simRpc[chain] = built.rpc;
            console.log(`[sim] robinhood: ${built.description}`); // provider names only, never URLs
            continue;
      }
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
// Practice checks in flight per chain. Normally one at a time (keeps the
// checking node's allowance safe). Oct 11: a big gap ($1+, BENCH_BYPASS_USD)
// may run alongside, up to SIM_MAX_PARALLEL at once, instead of being dropped
// because a small check happened to be running.
const simInFlight: Record<string, number> = {};
const SIM_MAX_PARALLEL = Number(process.env.SIM_MAX_PARALLEL ?? 3);
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
setInterval(() => timed('route scores save', () => routeScores.save(ROUTE_FILE)), 10 * 60_000);
// Real wins by size ($1/$2/$5/$10/$20 bars), to set the firing bar from data.
const winSizes = new WinSizes(Date.now, 'America/Toronto'); // same 'today' as the rest of the report
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
// Smallest model gain worth a real-chain test (see the trade handler).
// Oct 12 (owner approved): $0.10 (was $0.05), same as the send minimum. Checks
// went up 8x with Oct 11's changes and QuickNode's 14,000-a-day allowance would
// run out by midday; gaps under $0.10 can't be sent live anyway.
const SIM_CHECK_BAR_USD = Number(process.env.SIM_MIN_GROSS_USD ?? 0.10);
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
      noPartner: 0,         // no other trading spot for the pair deep enough (POOL_MIN_DEPTH_USD, $10k+)
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

// OUTLIER GUARD (core/outlierGuard.ts, Oct 15). A profit over $50, or over 2%
// of the trade (and over $20), is "too good to be true" (the $785 USDG/ORBIO
// gap). It is only trusted if paid in USDG/WETH AND a second check on the
// free node (a different node from the checking node) agrees at full and
// half size. Live: not sent otherwise. Practice: not counted otherwise.
const OUTLIER_CFG = readOutlierConfig();
const OUTLIER_ANCHORS = [ROBINHOOD_TOKENS.USDG, ROBINHOOD_TOKENS.WETH];
// The whole second check (2 simulations) must finish within OUTLIER_CHECK_MS
// (default 1.5 s). Too slow = "not confirmed": a live trade would otherwise
// go out after its deadline and revert. blockTag: practice trigger checks
// test at the trigger's block (where the gap was), not 'latest'.
const OUTLIER_CHECK_MS = Number(process.env.OUTLIER_CHECK_MS ?? 1500);
const confirmRhOutlier = (tokenIn: string, hops: ExecutorHop[], amountIn: bigint, firstProfit: bigint, v3Lender?: string, blockTag?: string): Promise<OutlierVerdict> =>
      withDeadline(confirmOutlier({
            tokenIn, anchors: OUTLIER_ANCHORS, amountIn, firstProfit,
            simulate: (amt) => simulateRoundTrip(rhFreeSimRpc, 'robinhood', { token: tokenIn, amountIn: amt, hops }, { v3Lender, weth: ROBINHOOD_TOKENS.WETH, ...(blockTag ? { blockTag } : {}) }),
      }), OUTLIER_CHECK_MS);
// Practice only: should this verified win count in "money we'd have made"?
// Normal wins: yes, no extra checks. Outliers: only if the second check agrees.
const outlierCountOk = async (label: string, netUsd: number, sizeUsd: number,
      trade: { tokenIn: string; hops: ExecutorHop[]; amountIn: bigint; profit: bigint; v3Lender?: string; blockTag?: string }): Promise<boolean> => {
      if (!isOutlier(netUsd, sizeUsd, OUTLIER_CFG)) return true;
      // Live: the send path runs its own second check for outliers (fireTrade);
      // running it here too would double the wait before sending. Live
      // outliers are simply not counted in the practice numbers.
      if (robinhoodSender.live) {
            console.log(`[outlier] ${label} $${netUsd.toFixed(2)} on $${Math.round(sizeUsd)}: outlier, not counted (live: the send path decides)`);
            return false;
      }
      const v = await confirmRhOutlier(trade.tokenIn, trade.hops, trade.amountIn, trade.profit, trade.v3Lender, trade.blockTag);
      if (v.ok) { console.log(`[outlier] ${label} $${netUsd.toFixed(2)} on $${Math.round(sizeUsd)}: ${v.detail}, counted`); return true; }
      funnelSkip('outlier profit, not counted (too good to be true, see [outlier] log)');
      console.log(`[outlier] ${label} $${netUsd.toFixed(2)} on $${Math.round(sizeUsd)}: OUTLIER, NOT COUNTED (${'reason' in v ? v.reason : 'refused'})`);
      return false;
};

// One on-chain round-trip check, awaited by the caller (used by the
// standing-gap scanner, where there's no race to lose by waiting ~1 s).
// Same build + simulation as queueSimulation, but returns the result
// instead of only logging it, and ignores the "one sim at a time" queue.
type RoundTripCheck =
      // loanPips: fee of the lender the check used (0 = own money).
      // trade: what was checked (for the outlier guard's second check).
      | { status: 'profit'; usd: number; loanPips: number; trade: { tokenIn: string; hops: ExecutorHop[]; amountIn: bigint; profit: bigint; v3Lender?: string } }
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
      // Robinhood: a "breaks, no reason" answer is asked again on the free node
      // (as the after-trigger checks already do), and every result is counted
      // in the "Check results by kind" line, which before saw trigger checks only.
      const r = await simulateWithRecheck(simRpc[chain], chain === 'robinhood' ? rhFreeSimRpc : null, chain, { token: tokenIn, amountIn: built.amountIn, hops: built.hops }, { v3Lender: lender?.poolAddress, weth: chain === 'robinhood' ? ROBINHOOD_TOKENS.WETH : undefined },
            (changed) => { recheckStats.done++; if (changed) recheckStats.changed++; });
      markStretch('practice check result'); // stall finder: handling the check's answer
      if (chain === 'robinhood') simBuckets.add(r.bucket ?? classifySimOutcome(r.status, 'reason' in r ? r.reason : ''));
      if (r.status === 'rate_limited') { simPausedUntil[chain] = Date.now() + SIM_RATE_LIMIT_PAUSE_MS; return { status: 'rate_limited' }; }
      if (r.status === 'unsupported') { if (chain === 'robinhood') noteNoSlot(tokenIn, r.reason); return { status: 'skipped', reason: r.reason }; }
      if (r.status === 'profit') {
            if (!plausibleProfit(r.profit, built.amountIn)) return { status: 'fail', reason: 'implausible profit (bad token or pool data)' };
            return { status: 'profit', usd: (Number(r.profit) / 10 ** decimals) * usdPerToken, loanPips: lender ? (lender.feePips ?? lender.feeBps * 100) : 0,
                  trade: { tokenIn, hops: built.hops, amountIn: built.amountIn, profit: r.profit, v3Lender: lender?.poolAddress } };
      }
      if (r.status === 'loss') return { status: 'loss', reason: 'ends with less than it started' };
      return { status: 'fail', reason: r.reason };
};

// Finds where the trigger trade landed and the trades before it in that
// block (including the trigger itself), so the check can REPLAY them on the
// block before and then run our trade: the exact moment a backrun lands,
// before any rival. null = not found in time.
type TriggerSpot = { block: string; parent: string; prefix: ReplayCall[]; time?: string; index?: number };
const USER_TX_TYPES = new Set(['0x0', '0x1', '0x2', '0x3', '0x4']); // skip Arbitrum system txs (0x64-0x6a)
// pollMs / maxPolls: loop checks poll less often (300 ms, 6 times) to save
// requests on the free node; 2-pool checks keep 150 ms x 12.
const findTriggerSpot = async (rpc: (m: string, p: unknown[]) => Promise<{ result?: any; error?: any }>, hash: string, pollMs = RH_TRIGGER_POLL_MS, maxPolls = RH_TRIGGER_MAX_POLLS): Promise<TriggerSpot | null> => {
      for (let i = 0; i < maxPolls; i++) {
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
                  return { block: r.result.blockNumber, parent: '0x' + (n - 1n).toString(16), prefix, time: b.result?.timestamp, index: idx };
            }
            await new Promise((res) => setTimeout(res, pollMs));
      }
      return null;
};
// Node can't serve an older block's state ("missing trie node" etc.).
const STATE_GONE = /missing trie node|historical state|state.*(not available|unavailable)|header not found|unknown block|pruned/i;

// Runs one practice check now. Returns false if it decided not to (muted,
// benched, unbuildable...), so the check line can move on to the next gap.
// Called only through queueSimulation (the check line) below.
const runSimulation = (
      chain: 'avalanche' | 'monad' | 'robinhood', tokenIn: string,
      buyPool: any, sellPool: any, tradeSizeUsd: number, modelGrossUsd: number, usdPerToken: number,
      triggerHash?: string,   // Robinhood: the trade we're following, to test right after it
): boolean => {
      if (simOff(chain) || Date.now() < (simPausedUntil[chain] ?? 0)) { if (chain === 'robinhood') funnelSkip('checking node paused (busy or out of allowance)'); return false; }
      const muteKey = `${buyPool.poolAddress}>${sellPool.poolAddress}`.toLowerCase();
      const bigGap = modelGrossUsd >= BENCH_BYPASS_USD; // big gaps skip the mute and the bench
      if (!bigGap && Date.now() < (simLoserMuted.get(muteKey) ?? 0)) { if (chain === 'robinhood') funnelSkip('same trading spots lost in the last 5 min'); return false; }
      const routeKey = RouteScores.key(buyPool.poolAddress, sellPool.poolAddress);
      if (chain === 'robinhood' && !bigGap && routeScores.isBenched(routeKey)) { funnelSkip("these two trading spots never pay out (benched 6 h)"); return false; }
      const decimals = TOKEN_DECIMALS[chain]?.[tokenIn.toLowerCase()];
      if (decimals === undefined) { if (chain === 'robinhood') funnelSkip('token decimals unknown'); return false; }
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
      if ('reason' in built) { if (chain === 'robinhood') funnelSkip(`trade couldn't be built (${built.reason})`); return false; }
      const funding = lender ? `flash loan from ${lender.dex} (${lender.feeBps / 100}% fee)` : RH_OWN_MONEY && chain === 'robinhood' ? 'own money' : 'own capital (no V3 lender cached)';

      simInFlight[chain] = (simInFlight[chain] ?? 0) + 1;
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
                        // Replays report the gas our trade used: calibrate the gas model.
                        if (chain === 'robinhood' && (r.status === 'profit' || r.status === 'loss') && r.gasUsed) gasModel.notePractice(twoPoolKey(built.hops.map((h) => h.kind), !!lender), r.gasUsed);
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
                  markStretch('practice check result'); // stall finder: handling the check's answer
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
                        } else {
                              console.warn(`[sim] ${chain} skipped (${r.reason})`);
                              if (chain === 'robinhood') noteNoSlot(tokenIn, r.reason); // next test of this coin uses a loan
                        }
                        return;
                  }
                  simStats.checked++;
                  // Per-exchange practice count (new exchanges only): a win is a
                  // plausible profit that is still above 0 after our gas.
                  if (chain === 'robinhood') {
                        const winNet = r.status === 'profit' && plausibleProfit(r.profit, built.amountIn)
                              ? (Number(r.profit) / 10 ** decimals) * usdPerToken - rhGasUsd(0.05) : undefined;
                        venueTally.add(buyPool.dex, sellPool.dex, torontoDay(), winNet);
                  }
                  if (r.status !== 'profit' || !plausibleProfit(r.profit, built.amountIn)) muteLoser(muteKey);
                  const pairTokens = [buyPool.tokenA, buyPool.tokenB];
                  if (chain === 'robinhood') {
                        if (r.status === 'profit') noteCheck(pairTokens, plausibleProfit(r.profit, built.amountIn) ? 'profit' : 'fail', plausibleProfit(r.profit, built.amountIn) ? '' : 'implausible profit');
                        else if (r.status === 'loss') noteCheck(pairTokens, 'loss');
                        else if (r.status === 'fail') noteCheck(pairTokens, 'fail', r.reason);
                  }
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
                        // Auto-vetted coins count only within their smaller trade limit.
                        const vetted = [buyPool.tokenA, buyPool.tokenB].every((t: string) => safetyGate.isAllowed(t))
                              && !(involvesAutoVetted([buyPool.tokenA, buyPool.tokenB]) && tradeSizeUsd > AUTO_VET_MAX_TRADE_USD);
                        // Outliers (too good to be true) count only after a second check agrees.
                        if (chain === 'robinhood' && net >= MIN_COUNTED_USD && vetted
                              && await outlierCountOk(`${pair} after trigger`, net, tradeSizeUsd, { tokenIn, hops: built.hops, amountIn: built.amountIn, profit: r.profit, v3Lender: lender?.poolAddress, ...(spot ? { blockTag: spot.block } : {}) })) {
                              countVerifiedWin(net, `${symbolOf(chain, tokenIn)} ${buyPool.dex}->${sellPool.dex}`,
                                    { startToken: tokenIn, sizeUsd: tradeSizeUsd, lender: lender?.poolAddress }, [buyPool.tokenA, buyPool.tokenB]);
                        }
                        if (chain === 'robinhood') { routeScores.record(routeKey, net); if (vetted) winSizes.add(net); profitBands.add(net, torontoDay()); }
                        // Race check for trigger wins: we'd send ~0.1 s after seeing the trigger,
                        // so "ready" is the block after the trigger's block.
                        if (chain === 'robinhood' && spot && net > 0) void raceChecker.record({ label: `${pair} after trigger`, pools: [buyPool.poolAddress, sellPool.poolAddress], netUsd: net, source: 'trigger', spottedBlock: Number(spot.block), readyDelayMs: 100, ignoreTx: triggerHash, ...(spot.index !== undefined ? { afterTxIndex: spot.index } : {}) });
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
                  simInFlight[chain] = Math.max(0, (simInFlight[chain] ?? 1) - 1);
                  // A slot just freed up: start the best gap waiting in line.
                  setImmediate(() => drainSimQueue(chain));
            }
      }, followTrigger ? RH_TRIGGER_POLL_MS : SIM_DELAY_MS[chain]);
      return true;
};

// ==========================================================================
// THE CHECK LINE (Oct 12, owner approved).
//
// Plain English: practice checks used to be first come, first served, and a
// gap that arrived while a check was running was simply dropped, however big.
// Now gaps wait in a short line, best first:
//   - up to SIM_BASE_PARALLEL (2) checks run at once; a big gap ($1+,
//     BENCH_BYPASS_USD) may use one more slot (SIM_MAX_PARALLEL, 3)
//   - when a slot frees up, the MOST PROFITABLE gap waiting goes next
//   - coins we can't trade (not on the vetted list) go to the back: they run
//     only when nothing tradable is waiting, and never take the last free slot
//   - a gap that has waited more than SIM_QUEUE_MAX_AGE_MS (2 s) is dropped:
//     by then the chance is usually gone
// Live trades never wait for this line: they are sent the moment a gap is seen.
// ==========================================================================
const SIM_BASE_PARALLEL = Number(process.env.SIM_BASE_PARALLEL ?? 2);
const SIM_QUEUE_MAX_AGE_MS = Number(process.env.SIM_QUEUE_MAX_AGE_MS ?? 2_000);
const SIM_QUEUE_MAX = 30;
type SimArgs = Parameters<typeof runSimulation>;
type SimWaiting = { args: SimArgs; value: number; vetted: boolean; at: number };
const simWaiting: Record<string, SimWaiting[]> = {};
// Better first: tradable before untradable, then bigger expected profit.
const simBetter = (a: SimWaiting, b: SimWaiting) => (a.vetted === b.vetted ? b.value - a.value : a.vetted ? -1 : 1);
// Can this gap start now? Big gaps get one extra slot; untradable coins never take the last one.
const simHasRoom = (chain: string, w: SimWaiting): boolean => {
      const n = simInFlight[chain] ?? 0;
      const limit = w.value >= BENCH_BYPASS_USD ? SIM_MAX_PARALLEL : SIM_BASE_PARALLEL;
      return n < (w.vetted ? limit : Math.min(limit, SIM_BASE_PARALLEL) - 1);
};
const drainSimQueue = (chain: 'avalanche' | 'monad' | 'robinhood') => {
      const line = simWaiting[chain];
      if (!line?.length) return;
      const now = Date.now();
      // Too old: drop.
      for (let i = line.length - 1; i >= 0; i--) {
            if (now - line[i].at > SIM_QUEUE_MAX_AGE_MS) { line.splice(i, 1); if (chain === 'robinhood') funnelSkip('waited too long in the check line (2 s)'); }
      }
      line.sort(simBetter);
      // Start the best ones that fit; skip ones that decide not to run.
      for (let i = 0; i < line.length;) {
            if (!simHasRoom(chain, line[i])) { i++; continue; }
            const [w] = line.splice(i, 1);
            runSimulation(...w.args);
      }
};
const queueSimulation = (
      chain: 'avalanche' | 'monad' | 'robinhood', tokenIn: string,
      buyPool: any, sellPool: any, tradeSizeUsd: number, modelGrossUsd: number, usdPerToken: number,
      triggerHash?: string,
      vetted = true,          // false = coin not on the vetted list (checked last)
) => {
      const w: SimWaiting = { args: [chain, tokenIn, buyPool, sellPool, tradeSizeUsd, modelGrossUsd, usdPerToken, triggerHash], value: modelGrossUsd, vetted, at: Date.now() };
      const line = (simWaiting[chain] ??= []);
      // Room now and nothing better waiting: start straight away.
      if (simHasRoom(chain, w) && !line.some((x) => simBetter(x, w) < 0)) { runSimulation(...w.args); return; }
      line.push(w);
      line.sort(simBetter);
      // Line full: the worst one leaves.
      if (line.length > SIM_QUEUE_MAX) { line.pop(); if (chain === 'robinhood') funnelSkip('check line full (lowest value dropped)'); }
      drainSimQueue(chain);
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
// Gaps skipped because a pool's price changed while the scan ran in bites
// (fast gap scan). Shown on the 5-min [stalls] line, then reset.
let gapStaleSkips = 0;
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
setInterval(() => timed('watch list save', () => robinhoodWatcher.save(WATCH_FILE)), 10 * 60_000);

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
// SPEED FIXES (Oct 13, owner approved). Each has an off switch in .env:
//   stage timers (always on, measurement only): where fire-ready time goes,
//     every 5 min as a [speed] log line and in the hourly report
//   SPEED_PRELOAD=0   turns off loading every watched pool's price at start
//                     (and the 1-minute "any watched pool missing?" check)
//   SPEED_TRUST_WS=0  turns off using cached prices the WebSocket vouches for
//                     (core/trustFresh.ts has the exact rules)
//   SPEED_PARALLEL_SEND=1 turns ON parallel sends (off by default; see
//                     execution/fastSender.ts)
const stageTimers = new StageTimers();
const SPEED_PRELOAD = process.env.SPEED_PRELOAD !== '0' && process.env.SPEED_PRELOAD !== 'off';
const trustCfg = trustFreshConfigFromEnv();
let wsFacts: WsFacts | null = null; // set once the WebSocket block reader exists (BLOCK_READER_WSS)
const gapStats = { found: 0, bestUsd: 0, fake: 0, fail: 0 }; // standing gaps (no trigger trade) this hour: confirmed, best real $, fakes muted

// FAST SENDER (Robinhood). Dry run unless the live switches are all set
// (see execution/fastSender.ts). ROBINHOOD_SEND_RPC = where to send trades
// (ideally straight to the sequencer); defaults to the read RPC.
const robinhoodSender = new FastSender(
      robinhoodReadProvider, 4663,
      // Trades go straight to the sequencer (first come, first served).
      new ethers.JsonRpcProvider(robinhoodSendRpc(), 4663, { staticNetwork: true }),
);
// Deploy lock: live trades in flight are counted in data/inflight.json so
// auto-deploy never restarts the bot mid-trade (live only; deploy/auto-deploy.sh).
robinhoodSender.trackInflight(process.env.INFLIGHT_FILE || 'data/inflight.json');
const safetyGate = new SafetyGate(safetyConfigFromEnv());
// AUTO-VET (core/autoVet.ts, Oct 12, owner approved): coins earn a place on the
// vetted list by passing practice checks (3 completed, 1+ profitable, never a
// trap-coin failure). Saved to disk; reloaded into the safety gate at start.
const autoVet = new AutoVet((t) => safetyGate.isAllowed(t));
const AUTO_VET_FILE = 'data/auto-vetted.json';
safetyGate.allowTokens(autoVet.load(AUTO_VET_FILE));
setInterval(() => timed('auto-vet save', () => autoVet.save(AUTO_VET_FILE)), 10 * 60_000);
// Auto-vetted coins get a smaller live trade limit: their owner could still
// change the coin's rules later. Trigger trades are planned within it; bigger
// trades on these coins are neither sent nor counted.
const AUTO_VET_MAX_TRADE_USD = Number(process.env.AUTO_VET_MAX_TRADE_USD ?? 300);
const involvesAutoVetted = (tokens: string[]) => tokens.some((t) => autoVet.isAutoVetted(t));
// Feed one finished practice check into auto-vet and update the safety gate.
const noteCheck = (tokens: string[], outcome: CheckOutcome, reason = '') => {
      const { added, removed } = autoVet.record(tokens, outcome, reason);
      if (added.length) { safetyGate.allowTokens(added); console.log(`[autovet] vetted after clean practice checks: ${added.map((t) => symbolOf('robinhood', t)).join(', ')}`); }
      if (removed.length) { safetyGate.disallowTokens(removed); console.log(`[autovet] REMOVED (failed like a trap coin: ${reason.slice(0, 60)}): ${removed.map((t) => symbolOf('robinhood', t)).join(', ')}`); }
};
// LIMITS LINE (status page): the limits the bot is REALLY using, after any
// override in the server's settings file. Logged at start and every 10 min
// so the status page always has a recent copy.
const logLimits = () => {
      const sendCap = safetyConfigFromEnv().maxTradeUsd;
      console.log(`[limits] send minimum $${MIN_NET_PROFIT_USD} · biggest trade $${MAX_TRADE_USD.toLocaleString('en-US')}` +
            (sendCap !== MAX_TRADE_USD ? ` (send check $${sendCap.toLocaleString('en-US')})` : '') +
            ` · own money up to $${OWN_MONEY_MAX_USD.toLocaleString('en-US')} · partner pools $${Math.round(POOL_MIN_DEPTH_USD / 1000)}k+` +
            ` · check bar $${SIM_CHECK_BAR_USD} · big gaps ($${BENCH_BYPASS_USD}+) skip the bench · size filter ${(DEFAULT_FILTER_CONFIG.minTradeToPoolLiquidityRatio * 100).toFixed(1)}% of pool` +
            ` · auto-vetted coins ${autoVet.stats().vetted} (blocked ${autoVet.stats().blocked}, watching ${autoVet.stats().watching}, limit $${AUTO_VET_MAX_TRADE_USD})`);
};
logLimits();
setInterval(labelled('limits log', logLimits), 10 * 60_000);
if (safetyGate.problems.length) {
      // Fail closed: every send is blocked until the setting is fixed.
      console.warn(`[safety] BAD SETTING(S): ${safetyGate.problems.join(', ')} -- all sends blocked until fixed in .env`);
}
// Live-readiness result (see execution/liveReadiness.ts). Dry run: not needed.
let liveChecks: { ok: boolean; problems: string[] } = { ok: !robinhoodSender.live, problems: [] };
// Gas cost of one Robinhood trade in USD, from the real gas price and ETH
// price (was a fixed $0.05 / $2). Falls back to the old fixed value if
// either price is unknown yet.
// Oct 13 (GAS_FROM_LIVE, core/gasModel.ts): per kind of trade (own money vs
// loan, exchange mix), measured gas units x live gas price, x GAS_MARGIN;
// $0.05 (the fallback) when the gas reading is missing or over 30 s old.
// GAS_FROM_LIVE=0 = the line below `oldGasUsd` only (the previous behaviour).
const oldGasUsd = (fallback: number): number =>
      robinhoodSender.gasCostUsd(priceOracle.getUsdPrice('robinhood', ROBINHOOD_TOKENS.WETH)) ?? fallback;
const gasModel = new GasModel(gasSettingsFromEnv(), new GasCalibration('data/gas-calibration.json'),
      () => robinhoodSender, () => priceOracle.getUsdPrice('robinhood', ROBINHOOD_TOKENS.WETH), oldGasUsd);
// loan: funded by a flash loan (default: the bot's funding setting).
// kinds: the two pools' executor kinds when known (finer calibration).
const rhGasUsd = (fallback: number, loan: boolean = !RH_OWN_MONEY, kinds?: (number | null)[]): number =>
      gasModel.twoPoolUsd(loan, kinds && kinds.every((k) => k !== null) ? kinds as number[] : undefined, fallback);
// Event fees are "newer" than a fee read by BLOCK (core/eventFees.ts): the
// current block, estimated from the sender's 2 s block reads.
setHeadBlockSource(() => { const d = robinhoodSender.deadlineBlock(1); return d === null ? null : Number(d) - 1; });
// One receipt of our own live trade -> gas calibration. Asks the node for
// the raw receipt once to read Arbitrum's gasUsedForL1 (the parent-chain
// part). Calibration learns the trade's OWN gas (gasUsed - gasUsedForL1),
// the same thing practice replays measure; the estimate then adds the
// parent-chain part at today's price (fastSender's realistic-calldata read).
// The first 20 live receipts log estimated vs actual parent-chain gas.
let l1Compared = 0;
const noteReceiptGas = async (key: string, hash: string, gas: bigint, success: boolean) => {
      let l1: bigint | null = null;
      try {
            const raw = await robinhoodReadProvider.send('eth_getTransactionReceipt', [hash]);
            if (raw?.gasUsedForL1 !== undefined && raw?.gasUsedForL1 !== null) l1 = BigInt(raw.gasUsedForL1);
      } catch { /* no L1 split: the whole gasUsed counts (errs on the high side) */ }
      if (l1Compared < 20) {
            l1Compared++;
            const est = robinhoodSender.l1GasNow;
            console.log(`[gas] live receipt ${hash.slice(0, 10)}: parent-chain gas estimated ${est} vs actual ${l1 ?? '?'}` +
                  (l1 !== null && l1 > est ? ' (UNDER-estimated: raise FIRE_L1_CALLDATA_BYTES)' : '') + ` | total gas ${gas}`);
      }
      gasModel.noteReceipt(key, gas, l1, success, defaultUnitsFor(key));
};
// Dry-run "would have earned" totals (core/dryRunPnl.ts), saved so restarts
// don't reset them. Verified = confirmed by a real-chain test; model-only =
// the bot's own maths. Both assume we win the race.
const dryRunPnl = new DryRunPnl('data/dryrun-pnl.json', process.env.REPORT_TZ || 'America/Toronto');
setInterval(() => timed('dry-run P&L save', () => dryRunPnl.save()), 60_000);
// LIVE-REALISTIC TOTAL (core/realisticPnl.ts, Oct 15, measurement only).
// A second "would have made" total that only counts wins our real money could
// really take: starts in USDG or WETH (REALISTIC_START_COINS), size at or under
// the own-money cap (OWN_MONEY_MAX_USD), and no loan in the check.
const realisticPnl = new RealisticPnl('data/realistic-pnl.json', {
      startCoins: readStartCoins(process.env.REALISTIC_START_COINS, [ROBINHOOD_TOKENS.USDG, ROBINHOOD_TOKENS.WETH]),
      ownMaxUsd: OWN_MONEY_MAX_USD,
      startLabel: process.env.REALISTIC_START_COINS ? 'chosen coins' : 'USDG/WETH',
}, process.env.REPORT_TZ || 'America/Toronto');
// OTHER STABLECOINS (core/stableTally.ts, Oct 15, measurement only): gaps and
// wins on pairs with aUSD, UUSD or USDe. Addresses come from the verified coin
// groups (set further down) or OTHER_STABLES in .env.
const stableTally = new StableTally('data/other-stables.json', process.env.REPORT_TZ || 'America/Toronto');
stableTally.setFromEnv(parseStableEnv(process.env.OTHER_STABLES));
setInterval(() => timed('realistic totals save', () => { realisticPnl.save(); stableTally.save(); }), 60_000);
// Every verified practice win goes through here: the normal total, then the
// live-realistic total and the other-stablecoin counter (both reporting only).
// `usd` is what the normal total adds (net of gas, only the new part of a
// re-checked gap), so nothing is counted twice.
const countVerifiedWin = (usd: number, label: string, win: WinFacts, pairTokens: [string, string]) => {
      dryRunPnl.recordVerified(usd, label);
      realisticPnl.record(usd, win);
      stableTally.noteWin(pairTokens, win.startToken, usd);
};
// Save on shutdown too: pm2 restart/stop (every deploy) sends SIGINT, and the
// last minute of would-have-earned figures used to be lost each time.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.once(sig, () => {
            try { dryRunPnl.save(); } catch { /* best effort */ }
            try { realisticPnl.save(); stableTally.save(); } catch { /* best effort */ }
            try { gasModel.calibration.maybeSave(true); } catch { /* best effort */ }
            try { robinhoodWatcher.save(WATCH_FILE); } catch { /* best effort */ }
            try { routeScores.save(ROUTE_FILE); } catch { /* best effort */ }
            try { autoVet.save(AUTO_VET_FILE); } catch { /* best effort */ }
            try { rivalWatch.save(RIVAL_BOTS_FILE, RIVAL_TRADES_FILE); } catch { /* best effort */ }
            try { saveNodeUsage(); } catch { /* best effort */ }
            try { if (research.enabled) research.save(RESEARCH_FILE); } catch { /* best effort */ }
            console.log(`[shutdown] ${sig}: state saved, exiting`);
            process.exit(0);
      });
}
// Smallest CONFIRMED profit (after gas, vetted coins) counted as "would have
// earned". Was the $20 firing bar, which hid every real small win; since
// Oct 9 (owner approved) any confirmed win of 5 cents or more counts.
// The live firing bar / safety gate is unchanged.
const MIN_COUNTED_USD = Number(process.env.COUNT_MIN_USD ?? 0.05);
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
const RIVAL_PM_LOWER = ROBINHOOD_V4.POOL_MANAGER.toLowerCase();
// RIVAL_LAZY_SENDER=0: hand rival watch the sender up front for every feed
// transaction (the old behaviour: a signature check per transaction).
const RIVAL_LAZY_SENDER = process.env.RIVAL_LAZY_SENDER !== '0';
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
            // Addresses that can never be a NEW rival bot: DEX routers, the V4
            // PoolManager, pools we watch, coins we know. Feed transactions to
            // these skip the sender look-up (a ~1-2 ms signature check), see
            // RivalWatch.noteTx. All quick lookups. Given lowercase addresses.
            neverNewBot: (a) => a === RIVAL_PM_LOWER || !!routerRegistry.robinhood?.[a]
                  || !!cache.get('robinhood', a) || TOKEN_DECIMALS.robinhood?.[a] !== undefined,
            // At most this many sender look-ups per second (the rest are skipped and counted).
            senderMaxPerSec: Number(process.env.RIVAL_SENDER_MAX_PER_SEC ?? 40),
      },
);
registerSize('rival trades', () => rivalWatch.recordCount());
registerSize('competitor results', () => rivals.results.length);
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
setInterval(labelled('rival watch sample', async () => {
      try {
            const latest = await robinhoodReadProvider.getBlockNumber();
            await timedAsync('rival watch sample', () => rivalWatch.sampleBlock('0x' + (latest - 3).toString(16)));
      } catch { /* node busy: next time */ }
}), Number(process.env.RIVAL_SAMPLE_MS ?? 15_000));
// New rival bots caught by the tracker join the watch list (checked every minute).
// Uses the tracker's ticket counter, so the hourly reset and the 2,000 cap
// can't make it skip new bots (before Oct 13 the hourly reset did).
let rivalResultsSeen = 0;
setInterval(labelled('rival bots update', () => {
      const { items, next } = rivals.resultsSince(rivalResultsSeen);
      rivalResultsSeen = next;
      for (const r of items) if (r.found && r.bot) rivalWatch.addBot(r.bot, 'tracker');
}), 60_000);
setInterval(() => timed('rival watch save', () => rivalWatch.save(RIVAL_BOTS_FILE, RIVAL_TRADES_FILE)), 10 * 60_000);
// RACE CHECK (core/raceCheck.ts): for every confirmed practice win, watch the
// two pools for ~30 s and see whether another bot took it before we'd have
// been ready. Answers "would we really have won?". Watch only.
const raceChecker = new RaceChecker((m, p) => robinhoodReadProvider.send(m, p as any[]), ROBINHOOD_V4.POOL_MANAGER);
setInterval(labelled('race check', () => { void raceChecker.tick(); }), 5_000);
// New pool counter (set up with the chain-wide scan further down; read by the reports).
let newPoolWatchRef: NewPoolWatch | null = null;

// Live only: every real send and result goes to data/live-trades.jsonl (read
// by the status page), and Telegram alerts fire when live sending pauses
// (daily loss cap, kill switch, bad setting) or 75% of the cap is used.
const liveTradeLog = new LiveTradeLog();
// Instant plain-English alerts (report/alertHooks.ts). REPORT_V2=0 = old messages.
const alertHooks = new AlertHooks({ send: (html) => sendTelegramMessage(html) });
alertHooks.installExitRecorder();
const safetyAlerts = new SafetyAlerts((html, critical) => alertHooks.safetyNotify(html, critical), safetyConfigFromEnv().dailyLossCapUsd, 'robinhood', Date.now, alertHooks.v2);

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
      recordLoss: (usd) => { safetyGate.recordLoss(usd); safetyAlerts.onLoss(safetyGate.lossTodayUsd()); },
      onResult: (r) => { liveTradeLog.result(r); alertHooks.onLiveResult(r); },
      noteGasUsed: (gas, info) => { robinhoodSender.noteGasUsed(gas); if (info?.routeKey) void noteReceiptGas(info.routeKey, info.hash, gas, info.success); },
      notify: (html) => alertHooks.liveTrackerNotify(html),
      onSettled: (hash) => { safetyGate.releasePending(hash); robinhoodSender.settled(hash); },
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
// Own money the trade contract really holds (core/ownMoney.ts). Live only:
// read every 15 s and after each real trade. Practice keeps the old
// "up to OWN_MONEY_MAX_USD" assumption, so practice numbers don't change.
const ownMoney = new OwnMoneyBook(() => robinhoodSender.live);
// Coins the contract may hold for own-money trades (OWN_MONEY_TOKENS adds more, comma-separated).
const OWN_MONEY_TOKENS = [ROBINHOOD_TOKENS.USDG, ROBINHOOD_TOKENS.WETH,
      ...(process.env.OWN_MONEY_TOKENS ?? '').split(',').map((t) => t.trim()).filter((t) => /^0x[0-9a-fA-F]{40}$/.test(t))];
// Read the contract's balances (live only; practice has nothing to read).
// A failed read keeps the last numbers; before the first read every trade borrows.
const refreshOwnMoney = async () => {
      const holder = executorConfig('robinhood').executorAddress;
      if (!robinhoodSender.live || !holder) return;
      try {
            rhDecisionCallMany ??= (await makeCaller(robinhoodReadProvider)).callMany;
            await ownMoney.refresh(rhDecisionCallMany, holder, OWN_MONEY_TOKENS);
      } catch (err) {
            console.warn('[own-money] balance read failed (keeping last numbers):', (err as Error).message);
      }
};
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
      // Own money for trades up to OWN_MONEY_MAX_USD ($2,000); bigger trades
      // borrow from the cheapest lender (0.01% pool) so the big wins aren't
      // limited by our own pot (~$1,000 USDG + $300 WETH planned).
      // Exception: coins whose balance storage the checker can't find can't be
      // given a pretend own-money balance, so they're tested with a loan instead.
      // Oct 11: live, "own money" also means the contract really holds enough
      // of this coin (ownMoney.availableUsd); otherwise the trade borrows. The
      // size itself is never changed here, only how it's paid for.
      const dec = TOKEN_DECIMALS[chain]?.[tokenIn.toLowerCase()];
      if (useOwnMoney({
            ownMoneyOn: RH_OWN_MONEY, tradeSizeUsd, ownMaxUsd: OWN_MONEY_MAX_USD,
            ownAvailableUsd: dec === undefined ? 0 : ownMoney.availableUsd(tokenIn, usdPerToken, dec),
            // The practice checker's balance trick, irrelevant to a real balance.
            noBalanceSlot: !robinhoodSender.live && noBalanceSlot.has(tokenIn.toLowerCase()),
      })) return null;
      const amount = dec === undefined ? null : loanUnits(tradeSizeUsd, usdPerToken, dec);
      // Unknown amount or no balances read yet: no lender (own-capital check instead).
      if (amount === null || !lenderBalances.lastRefreshMs) return null;
      return pickV3Lender(lenderCandidates(chain), tokenIn, exclude, (pool, token) => lenderBalances.canLend(pool, token, amount, LENDER_HEADROOM));
};

// Loan fee (bps) the Robinhood check would pay for tokenIn: the cheapest
// approved V3 lender holding it, other than the two trade pools. Uses the
// exact fee (pips) so a 0.01% pool counts as 1 bp. null = no lender, the
// check uses own money, so plan with no loan fee.
const rhLoanFeeBps = (tokenIn: string, buyPool: PoolState, sellPool: PoolState): number | null => {
      if (RH_OWN_MONEY) return null; // own money: no loan fee
      const l = pickV3Lender(lenderCandidates('robinhood'), tokenIn, [buyPool.poolAddress, sellPool.poolAddress]);
      if (!l) return null;
      return (l.feePips ?? l.feeBps * 100) / 100;
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
const researchNode = checkPlan ? budgetForUrl(checkPlan.main.url) : budgetForUrl(wssToHttps(process.env.QUICKNODE_RPC_ROBINHOOD) || process.env.QUICKNODE_RPC_ROBINHOOD || simRpcUrl('robinhood').url);
const research = new ResearchLane(researchConfigFromEnv(), {
      rpc: simRpc.robinhood,
      decimalsOf: (t) => TOKEN_DECIMALS.robinhood?.[t.toLowerCase()],
      symbolOf: (t) => symbolOf('robinhood', t),
      pickLender: (t, buy, sell, size, usd) => pickLender('robinhood', t, buy, sell, size, usd),
      gasUsd: () => rhGasUsd(0.05),
      weth: ROBINHOOD_TOKENS.WETH,
      canRun: () => !(simInFlight.robinhood ?? 0) && !simOff('robinhood') && Date.now() >= (simPausedUntil.robinhood ?? 0)
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
      setInterval(() => { void timedAsync('research lane', () => research.tick()); }, 2_000);
      setInterval(() => timed('research save', () => research.save(RESEARCH_FILE)), 10 * 60_000);
      // Standing gaps the main scanner ignores: prices already in memory only, no node requests.
      setInterval(() => timed('research gap look', () => {
            try {
                  const pairs = robinhoodWatcher.watchedPairPools().map((addrs) => addrs.map((a) => cache.get('robinhood', a)).filter((p): p is PoolState => !!p && canPracticeTest(p.dex)));
                  const gaps = findResearchGaps(pairs, isDeepRh, (p) => poolDepthUsd(p, decimalsOf, usdRhResearch), (t) => TOKEN_DECIMALS.robinhood?.[t.toLowerCase()], usdRhResearch,
                        { mainMinUsd: Number(process.env.GAP_MIN_USD ?? 0.10), researchMinUsd: c.gapMinUsd, minDepthUsd: c.minDepthUsd, gasUsd: rhGasUsd(0.05), maxTradeUsd: MAX_TRADE_USD });
                  for (const { reason, gap } of gaps) {
                        const vetted = safetyGate.isAllowed(gap.base) && safetyGate.isAllowed(gap.quote);
                        // A standing gap sits there for minutes: one test per 30 min is enough.
                        research.offer(reason, `${gap.buyPool.poolAddress}>${gap.sellPool.poolAddress}`, () => gapCandidate(reason, gap, vetted), 30 * 60_000);
                  }
            } catch (err) { console.warn('[research] gap look failed (ignored):', (err as Error).message); }
      }), 60_000);
      // Hourly: the lane's summary goes into the main hourly report (Phase 8);
      // see researchHourText() used by the hourly digest.
}

// ==========================================================================
// LOOP TRADER v1 (core/loopTrader.ts, docs/LOOP_TRADER.md). Off unless
// LOOP_TRADER=1; off = nothing below runs. Finds 3-8 pool loops (LOOP_MAX_POOLS, default 5) (WETH/USDG
// in and out) after every price update, the same moments as the gap scan,
// and PRACTICE-checks the paying ones when the normal check line is idle
// (LOOP_CHECKS_PER_MIN, default 6). It is never given the sender: loops
// cannot be sent live in v1, even with EXECUTION_ENABLED.
// ==========================================================================
const loopCfg = loopConfigFromEnv();
// LOOP FIX PHASE 2 switches (core/loopPrices.ts, docs/LOOP_TRADER.md). Each is
// ON when LOOP_TRADER=1 and can be turned off on its own with =0:
//   LOOP_REAL_PRICES=0         loops priced on the main cache again (feed predictions included)
//   LOOP_KEEP_BLOCK_UPDATES=0  block states skipped by the main cache are thrown away again
//   LOOP_TRIGGER_REPLAY=0      loop checks on "latest" again (no replay right after the trigger)
//   LOOP_MODEL_VS_CHECK=0      no model-vs-check line, loop gas not learned from checks
//   LOOP_CHEAP_SCAN=0          every loop scan runs in one go again
//   LOOP_SCAN_SLICE_MS         longest single slice of a loop scan (default 8 ms)
// LOOP_TRADER off (the default) = all off, nothing below runs.
const loopFix = loopFixFromEnv();
// Which node loop practice checks run on (LOOP_CHECK_NODE, core/loopNode.ts).
// LOOP_CHECK_RPC pointing at a configured checking node (main or its
// backup, QuickNode, Alchemy, SIM_RPC_ROBINHOOD) would undo the whole
// point (keep the paid nodes for 2-pool checks): refuse it, use the free node.
// (Read here, before both loop set-ups below; same rules as before.)
const loopNodeCfgShared = (() => {
      if (!loopCfg.enabled) return null;
      const cfg = loopNodeFromEnv(process.env);
      const mainCheckUrls = [checkPlan?.main.url, checkPlan?.fallback?.url,
            wssToHttps(process.env.QUICKNODE_RPC_ROBINHOOD) || process.env.QUICKNODE_RPC_ROBINHOOD,
            process.env.ROBINHOOD_RPC_HTTP, process.env.SIM_RPC_ROBINHOOD]
            .filter((u): u is string => !!u).map((u) => u.trim().replace(/\/+$/, '').toLowerCase());
      if (cfg.customUrl && mainCheckUrls.includes(cfg.customUrl.trim().replace(/\/+$/, '').toLowerCase())) {
            console.warn('[loop] LOOP_CHECK_RPC is one of the checking nodes: using the free public node for loops instead');
            cfg.customUrl = null;
            cfg.label = 'free public node';
      }
      return cfg;
})();
// LOOP WORKER (core/loopWorkerHost.ts, Oct 15, owner approved): the loop
// trader runs in its own thread so loop scans never freeze the main thread
// (trade feed, 2-pool trades). On by default with LOOP_TRADER=1;
// LOOP_WORKER=0 = loops in the main thread exactly as before. The worker
// only supports loop checks on their own node (LOOP_CHECK_NODE=free, the
// default); with LOOP_CHECK_NODE=main loops stay in the main thread.
const loopWorkerOn = loopCfg.enabled && loopWorkerFromEnv(process.env) && loopNodeCfgShared?.mode !== 'main';
if (loopCfg.enabled && loopWorkerFromEnv(process.env) && !loopWorkerOn) console.log('[loop] LOOP_CHECK_NODE=main: loop worker not used, loops run in the main thread (old behaviour)');
let loopWorker: LoopWorkerHost | null = null;
// Feed trades no block has confirmed yet (pool, direction, size, hash, feed
// order), plus the order of every feed transaction. Only filled when real
// prices or trigger replay are on (see onFeedEvent). Loops price a pool as
// its confirmed state plus its still-pending trades (core/loopPrices.ts).
const loopTriggers = new PendingTrades(loopFix.pendingMaxMs);
// Main-thread book (LOOP_WORKER=0) or notes forwarded to the loop worker.
const loopTriggersOn = loopCfg.enabled && !loopWorkerOn && (loopFix.realPrices || loopFix.triggerReplay);
const loopWorkerTriggersOn = loopWorkerOn && (loopFix.realPrices || loopFix.triggerReplay);
let requestLoopScan: () => void = () => {};
// The hourly report waits for this (the loop worker answers by message).
let loopHourText: () => Promise<string | undefined> | string | undefined = () => undefined;
// EXTRA SINGLE POOLS for the loop finder (core/loopExtraPools.ts). Created
// further down, next to the chain-wide scan, only when LOOP_TRADER=1 (and
// LOOP_EXTRA_POOLS is not 0). null = off: the block reader, gap scanner and
// everything else behave exactly as before.
const loopExtraCfg = loopExtraConfigFromEnv(process.env, loopCfg, POOL_MIN_DEPTH_USD);
let loopExtra: LoopExtraPools | null = null;
if (loopCfg.enabled && !loopWorkerOn) {
      const usdRhLoop = (t: string) => priceOracle.getUsdPrice('robinhood', t);
      let loopLogTimes: number[] = [];
      // LOOP_TRIGGER_REPLAY: one loop practice check, tested RIGHT AFTER the
      // trade that opened the loop, the same way the 2-pool checks do it
      // (runSimulation): find the trigger's block, replay that block up to
      // and including the trigger, then run our loop (eth_simulateV1).
      // Fallbacks, same as 2-pool: the end of the trigger's block, then
      // latest ("tested late"). No trigger (5 s safety net, block updates)
      // = latest, as before. Never sends anything. The steps themselves are
      // in core/loopNode.ts runLoopCheck.
      //
      // WHICH NODE (LOOP_CHECK_NODE, core/loopNode.ts, Oct 15 owner approved):
      //   free (default): loop checks run on the free public node (or
      //     LOOP_CHECK_RPC). They do NOT take a slot in the 2-pool check line
      //     (simInFlight) and never touch the main checking node (Chainstack),
      //     so 2-pool checks no longer wait behind them. Their own guard
      //     pauses them when the free node says "slow down" and holds them to
      //     LOOP_CHECK_DAILY a day. The "no reason" second opinion is skipped
      //     (the only other node would be Chainstack).
      //   main: old behaviour. The loop check counts as a running check on
      //     the checking node (simInFlight.robinhood), only starts when the
      //     2-pool line is idle, and frees its slot (and starts any waiting
      //     2-pool check) when done.
      // Read above (loopNodeCfgShared), same rules as before.
      const loopNodeCfg = loopNodeCfgShared!;
      const loopOnMain = loopNodeCfg.mode === 'main';
      const loopGuard = new LoopNodeGuard(loopNodeCfg);
      const loopNodeBudget = loopOnMain ? null : budgetForUrl(loopNodeCfg.customUrl ?? 'https://rpc.mainnet.chain.robinhood.com');
      // Free mode: every loop request passes the throttle first (loops' own
      // LOOP_NODE_MAX_RPS, and only when the shared allowance used by price
      // reads has room), so loops never delay price reads (core/loopNode.ts).
      const loopThrottle = new LoopNodeThrottle(loopMaxRpsFromEnv(), () => loopNodeBudget?.headroom() ?? null);
      const loopNodeRpc: Rpc = loopOnMain ? simRpc.robinhood
            : loopGuard.watch(loopThrottle.wrap(loopNodeCfg.customUrl ? makeRpc(loopNodeCfg.customUrl) : rhFreeSimRpc));
      // Loop checks poll for the trigger less often in free mode (300 ms, up to 6 times).
      const LOOP_TRIGGER_POLL_MS = 300, LOOP_TRIGGER_MAX_POLLS = 6;
      const loopCheckDeps: LoopCheckDeps = {
            rpc: loopNodeRpc,
            // Main mode: the free node double-checks "no reason" fails, as before.
            secondOpinion: loopOnMain ? rhFreeSimRpc : null,
            // Free mode: token balance locations are read from the shared
            // cache but never added to it (an odd free-node answer must not
            // change what 2-pool checks use). Main mode: as before.
            simulate: (rpc, trade, opts) => simulateRoundTrip(rpc, 'robinhood', trade, loopOnMain ? opts : { ...opts, slotReadOnly: true }),
            findSpot: (rpc, hash) => loopOnMain ? findTriggerSpot(rpc, hash) : findTriggerSpot(rpc, hash, LOOP_TRIGGER_POLL_MS, LOOP_TRIGGER_MAX_POLLS),
            replay: replayRpc,
            stateGone: STATE_GONE,
            weth: ROBINHOOD_TOKENS.WETH,
            triggerReplay: loopFix.triggerReplay,
            tagLatest: loopFix.triggerReplay || loopFix.modelVsCheck,
            replayAllowed: () => loopOnMain || loopGuard.replay !== 'no',
            lean: !loopOnMain,
      };
      const loopCheck = async (trade: LoopTrade, triggerHash?: string): Promise<LoopCheckResult> => {
            if (loopOnMain) {
                  simInFlight.robinhood = (simInFlight.robinhood ?? 0) + 1;
                  try { return await runLoopCheck(loopCheckDeps, trade, triggerHash); }
                  finally {
                        simInFlight.robinhood = Math.max(0, (simInFlight.robinhood ?? 1) - 1);
                        setImmediate(() => drainSimQueue('robinhood'));
                  }
            }
            // Free node: no 2-pool slot taken, nothing to hand back.
            loopGuard.noteStart();
            loopThrottle.beginCheck();
            try {
                  // First replay ever: ask the node once whether it can replay.
                  if (loopFix.triggerReplay && triggerHash) await loopGuard.probeReplay(loopNodeRpc);
                  const r = await runLoopCheck(loopCheckDeps, trade, triggerHash);
                  loopGuard.noteResult(r);
                  return r;
            } catch (e) {
                  if (!(e instanceof LoopNodeBusy)) throw e;
                  // Shared node too busy for 2 s (or the check ran 15 s): give
                  // up quietly. Not a "slow down" pause, not counted as a
                  // check, not logged one by one (core/loopTrader.ts), only
                  // counted in the hour line.
                  loopThrottle.busySkips++;
                  return { status: 'unsupported', reason: e.message };
            } finally {
                  // Today's LOOP_CHECK_DAILY counts only checks that sent something.
                  if (loopThrottle.sentThisCheck > 0) loopGuard.countCheck();
            }
      };
      const loopTrader = new LoopTrader(loopCfg, {
            bases: [ROBINHOOD_TOKENS.WETH, ROBINHOOD_TOKENS.USDG],
            env: {
                  decimalsOf: (t) => TOKEN_DECIMALS.robinhood?.[t.toLowerCase()],
                  usdOf: usdRhLoop,
                  depthUsd: (p) => poolDepthUsd(p, decimalsOf, usdRhLoop),
                  // Our gas for a loop of N pools (core/gasModel.ts loopUsd: calibrated per pool count, else the 2-pool estimate scaled per pool).
                  gasUsd: (hops) => gasModel.loopUsd(hops, 0.05),
                  // Pools rival loops used (last 24 h): their loops are listed first.
                  rivalPools: () => rivalWatch.loopRoutePools(Date.now() - 24 * 3600_000),
                  isTradable: (t) => safetyGate.isAllowed(t),
                  now: Date.now,
            },
            symbolOf: (t) => symbolOf('robinhood', t),
            decimalsOf: (t) => TOKEN_DECIMALS.robinhood?.[t.toLowerCase()],
            canPracticeTest: (p) => canPracticeTest(p.dex),
            // Main mode (old): lowest priority, only when no normal check is
            // running or waiting on the checking node.
            // Free mode: the 2-pool line is on another node, so it is not
            // waited for. Only the loop node's own guard (not paused after a
            // "slow down", daily limit not reached) and its daily allowance
            // (if it has one) decide. One loop check at a time and
            // LOOP_CHECKS_PER_MIN still apply (core/loopTrader.ts drain).
            canCheckNow: loopOnMain
                  ? () => !(simInFlight.robinhood ?? 0) && !(simWaiting.robinhood?.length) && !simOff('robinhood')
                        && Date.now() >= (simPausedUntil.robinhood ?? 0) && (!researchNode || researchNode.share() < 0.8)
                  : () => loopGuard.canCheck() && (!loopNodeBudget || loopNodeBudget.share() < 0.8),
            // Own-money practice check (rivals use their own money), same checker as 2-pool trades.
            // With LOOP_TRIGGER_REPLAY: right after the loop's trigger trade (loopCheck above).
            runCheck: (trade, ctx) => loopCheck(trade, ctx?.triggerHash),
            fix: loopFix,
            // LOOP_MODEL_VS_CHECK: real loop gas from replays teaches the gas
            // model's loop estimate (loop kinds only; 2-pool estimates untouched).
            noteGas: (pools, gasUsed) => { gasModel.notePractice(loopKey(pools), gasUsed); },
            log: (m) => {
                  const now = Date.now();
                  loopLogTimes = loopLogTimes.filter((t) => now - t < 60_000);
                  if (loopLogTimes.length < 60) { loopLogTimes.push(now); console.log(m); }
            },
      });
      // One loop scan, written as steps (core/chunked.ts) so it can run in
      // small slices. The pools: the watched pairs' pools (and the extra
      // single pools when on) with real money near their price.
      // LOOP_REAL_PRICES: each pool's state is its block-confirmed one, plus
      // the predicted effect of every feed trade on it that no block has
      // confirmed yet, in feed order (PendingTrades.stateFor). A trade already
      // in the confirmed state is never added again.
      const predict = (p: PoolState, inIsA: boolean, amt: bigint) => cache.predictPostTradeState(p, inIsA, amt);
      // Only if the cache is really keeping the confirmed view (it reads the
      // same switches at start); otherwise loops would see no pools at all.
      const realPricesOn = loopFix.realPrices && cache.confirmedOn;
      function* loopScanSteps(): Generator<void, void, void> {
            const now = Date.now();
            // Trigger trades since the last scan (hashes for the replay check).
            const fresh = loopTriggersOn ? loopTriggers.takeFresh() : new Map<string, { hash: string; at: number }>();
            if (loopTriggersOn) loopTriggers.sweep(now);
            const stateOf = (a: string): PoolState | undefined => realPricesOn
                  ? loopTriggers.stateFor(a, cache.get('robinhood', a), cache.getConfirmed('robinhood', a), cache.confirmedInfo('robinhood', a), predict, now)
                  : loopPoolState(cache.get('robinhood', a), undefined, undefined, false, predict, now);
            const pools: PoolState[] = [];
            let n = 0;
            for (const pair of robinhoodWatcher.watchedPairPools()) {
                  for (const a of pair) {
                        const p = stateOf(a);
                        if (p && deepEnough(p, decimalsOf, usdRhLoop)) pools.push(p);
                        if ((++n & 63) === 0) yield;
                  }
            }
            // Plus the extra single pools (when on) whose price is fresh.
            // They go to the loop finder only, never to the gap scanner.
            if (loopExtra) {
                  const have = new Set(pools.map((p) => p.poolAddress.toLowerCase()));
                  const extra = realPricesOn
                        ? loopExtra.keys().map(stateOf).filter((p): p is PoolState => !!p && now - p.lastUpdatedMs <= loopCfg.maxPoolAgeMs)
                        : loopExtra.freshPools(loopCfg.maxPoolAgeMs);
                  for (const p of extra) {
                        if (!have.has(p.poolAddress.toLowerCase()) && deepEnough(p, decimalsOf, usdRhLoop)) pools.push(p);
                        if ((++n & 63) === 0) yield;
                  }
            }
            // LOOP_TRIGGER_REPLAY: which trigger trade each traded pool follows.
            const ctx = loopFix.triggerReplay && fresh.size ? { triggers: fresh } : {};
            yield* loopTrader.onUpdateSteps(pools, ctx);
      }
      let loopQueued: NodeJS.Timeout | null = null;
      let loopScanning = false; // a sliced scan is running
      let loopAgain = false;    // a scan was asked for while one was running
      const runLoopScan = () => {
            if (!loopFix.cheapScan) {
                  // One go (old behaviour).
                  timed('loop scan', () => {
                        try { drainSteps(loopScanSteps()); } catch (err) { console.warn('[loop] scan failed (ignored):', (err as Error).message); }
                  });
                  return;
            }
            // LOOP_CHEAP_SCAN: in slices of at most LOOP_SCAN_SLICE_MS (8 ms)
            // with breaks for feed messages, each slice timed as 'loop scan'.
            // One scan at a time; one asked for meanwhile runs right after.
            if (loopScanning) { loopAgain = true; return; }
            loopScanning = true;
            runSteps(loopScanSteps(), 'loop scan', loopFix.sliceMs)
                  .catch((err) => console.warn('[loop] scan failed (ignored):', (err as Error).message))
                  .finally(() => { loopScanning = false; if (loopAgain) { loopAgain = false; requestLoopScan(); } });
      };
      requestLoopScan = () => {
            if (loopQueued) return;
            loopQueued = setTimeout(() => { loopQueued = null; runLoopScan(); }, 50);
      };
      // 5 s safety net. Goes through the same 50 ms queue as every other loop
      // scan, so it can never run right after (in the same moment as) a
      // queued scan: at most one loop scan per 50 ms (STALL_FIX_LOOP_DEBOUNCE).
      setInterval(STALL_FIX_LOOP_DEBOUNCE ? () => requestLoopScan() : runLoopScan, 5_000);
      // Race comparison: every rival trade the rival watch saves.
      rivalWatch.onRecord = (rec) => loopTrader.noteRival(rec);
      registerSize('loop cycles', () => loopTrader.finder.cycleCount());
      registerSize('loop confirmed states', () => cache.confirmedCount());
      // Hourly: take the hour's numbers ONCE (takeHour resets them), log one
      // plain "[loop] hour:" line for the status page, then build the same
      // Telegram block as before from the same numbers.
      let loopHourStart = Date.now();
      loopHourText = () => {
            const h = loopTrader.takeHour();
            loopHourStart = Date.now();
            const node = loopNodeText({ ...loopGuard.takeHour(), busySkips: loopThrottle.takeBusy() });
            console.log(loopLogLine(h, loopCfg.maxPools, 'hour', node));
            return formatLoopHour(h, loopCfg.maxPools, loopExtra?.status(loopCfg.maxPoolAgeMs) ?? null) + `\n  ${node}`;
      };
      // Every 15 min: the hour's numbers so far (read only, nothing reset), so
      // the status page (also every 15 min) always has fresh loop numbers.
      setInterval(() => {
            try { console.log(loopLogLine(loopTrader.peekHour(), loopCfg.maxPools, `hour so far (${Math.round((Date.now() - loopHourStart) / 60_000)} min)`, loopNodeText({ ...loopGuard.peekHour(), busySkips: loopThrottle.busySkips }))); }
            catch (err) { console.warn('[loop] summary line failed (ignored):', (err as Error).message); }
      }, 15 * 60_000);
      console.log(`[loop] fix phase 2: real prices ${realPricesOn ? 'on' : 'off'}, keep block updates ${loopFix.keepBlockUpdates ? 'on' : 'off'}, trigger replay ${loopFix.triggerReplay ? 'on' : 'off'}, model vs check ${loopFix.modelVsCheck ? 'on' : 'off'}, cheap scan ${loopFix.cheapScan ? `on (${loopFix.sliceMs} ms slices)` : 'off'}`);
      console.log(loopOnMain
            ? '[loop] loop checks on the main checking node (LOOP_CHECK_NODE=main, shares the 2-pool check line)'
            : `[loop] loop checks on the ${loopNodeCfg.label} (main checking node kept for 2-pool checks only), up to ${Number.isFinite(loopNodeCfg.dailyCap) ? loopNodeCfg.dailyCap : 'unlimited'} a day`);
      console.log(`[loop] loop trader ON (practice only, never sends): 3-${loopCfg.maxPools} pools, up to ${loopCfg.maxCycles} loops, max $${loopCfg.maxTradeUsd}, bar $${loopCfg.minNetUsd}, ${loopCfg.checksPerMin} checks/min`);
}

// ==========================================================================
// LOOP TRADER IN ITS OWN THREAD (LOOP_WORKER, default on with LOOP_TRADER=1;
// core/loopWorkerHost.ts, core/loopWorkerEntry.ts). Same loop trader, same
// switches, same practice checks on the loop node, same report lines. The
// main thread only sends the loop pools that changed (at most one message
// every 50 ms) and answers the worker's "may I use the free node?" questions.
// PRACTICE ONLY: the worker has no wallet and no sender.
// ==========================================================================
if (loopWorkerOn) {
      const usdRhLoop = (t: string) => priceOracle.getUsdPrice('robinhood', t);
      const loopNodeCfg = loopNodeCfgShared!;
      // The free node's shared allowance (price reads for 2-pool trades use it too).
      const loopNodeBudget = budgetForUrl(loopNodeCfg.customUrl ?? 'https://rpc.mainnet.chain.robinhood.com');
      // Only if the cache is really keeping the confirmed view (same rule as before).
      const realPricesOn = loopFix.realPrices && cache.confirmedOn;
      // Pool address -> the cache's own key, worked out once (bounded).
      const loopCacheKeys = new Map<string, string>();
      const feeder = new MainLoopFeeder({
            watchedPairs: () => robinhoodWatcher.watchedPairPools(),
            extraKeys: () => loopExtra ? loopExtra.keys() : null,
            main: (k) => cache.get('robinhood', k),
            confirmed: (k) => cache.getConfirmed('robinhood', k),
            info: (k) => cache.confirmedInfo('robinhood', k),
            // The same three in one lookup (what the feeder really uses).
            view: (k, out) => {
                  let ck = loopCacheKeys.get(k);
                  if (ck === undefined) { ck = cache.cacheKey('robinhood', k); if (loopCacheKeys.size > 50_000) loopCacheKeys.clear(); loopCacheKeys.set(k, ck); }
                  cache.readLoopViewKey(ck, out);
            },
            realPrices: realPricesOn,
            usdOf: usdRhLoop,
            decimalsOf: (t) => TOKEN_DECIMALS.robinhood?.[t.toLowerCase()],
            symbolOf: (t) => symbolOf('robinhood', t),
            tradable: (t) => safetyGate.isAllowed(t),
            practiceDex: (dex) => canPracticeTest(dex),
            gasUsd: (hops) => gasModel.loopUsd(hops, 0.05),
            rivalPools: () => rivalWatch.loopRoutePools(Date.now() - 24 * 3600_000),
            balance: (p, token) => realBalanceOf(p, token),
            // Daily allowance of the loop node under 80% (same rule as before).
            budgetOk: () => !loopNodeBudget || loopNodeBudget.share() < 0.8,
            head: () => currentHeadBlock(),
            bases: [ROBINHOOD_TOKENS.WETH, ROBINHOOD_TOKENS.USDG],
            now: Date.now,
      });
      const host = new LoopWorkerHost({
            init: {
                  t: 'init', loopCfg, fix: loopFix, realPricesOn,
                  triggersOn: loopFix.realPrices || loopFix.triggerReplay,
                  extraOn: loopExtraCfg.enabled,
                  bases: [ROBINHOOD_TOKENS.WETH, ROBINHOOD_TOKENS.USDG],
                  minDepthUsd: POOL_MIN_DEPTH_USD,
                  node: {
                        cfg: loopNodeCfg, maxRps: loopMaxRpsFromEnv(), freeUrl: 'https://rpc.mainnet.chain.robinhood.com',
                        weth: ROBINHOOD_TOKENS.WETH, slotsFile: 'data/balance-slots.json',
                        // Loop checks poll for the trigger less often (300 ms, up to 6 times), as before.
                        triggerPollMs: 300, triggerMaxPolls: 6,
                        sharedBudget: !!loopNodeBudget,
                  },
                  statsMs: 30_000, peekMs: 15 * 60_000, logPerMin: 60,
            },
            feeder,
            // Same rule as LoopNodeThrottle.sharedHasRoom (core/loopNode.ts):
            // nobody waiting, under half the speed limit used in the last
            // second, almost all slots free. A yes is counted in the shared
            // allowance (as the loop request used to be), so price reads keep
            // their room. Never waits (a slot is free when it says yes).
            permit: () => {
                  if (!loopNodeBudget) return true;
                  const h = loopNodeBudget.headroom();
                  const ok = h.pending === 0 && h.usedLastSec < 0.5 * h.rps && h.tokens >= Math.max(1, h.rps - 2);
                  if (ok) void loopNodeBudget.take(1).catch(() => undefined);
                  return ok;
            },
            // LOOP_MODEL_VS_CHECK: real loop gas from replays teaches the gas model (loop kinds only).
            noteGas: (pools, gasUsed) => { gasModel.notePractice(loopKey(pools), gasUsed); },
            log: (m) => console.log(m),
            warn: (m) => { console.warn(m); alertHooks.onLoopWarn(m); },
            heapMb: loopWorkerHeapMbFromEnv(),
            // The worker answered after the hourly report gave up (3 s): the
            // report said "no numbers", the plain line for the status page is still written.
            onLateHour: (r) => console.log(loopLogLine(r.h, loopCfg.maxPools, 'hour', r.node) + ' (arrived late)'),
      });
      loopWorker = host;
      host.start();
      process.once('exit', () => host.stop());
      requestLoopScan = () => host.requestScan();
      // 5 s safety net, through the same 50 ms queue as every other loop scan.
      setInterval(() => requestLoopScan(), 5_000);
      // Race comparison: every rival trade the rival watch saves.
      rivalWatch.onRecord = (rec) => host.noteRival({ bot: rec.bot, pools: rec.pools, route: rec.route, grossUsd: rec.grossUsd, gasUsd: rec.gasUsd, failed: rec.failed, t: rec.t });
      registerSize('loop cycles', () => host.stats?.cycles ?? 0);
      registerSize('loop confirmed states', () => cache.confirmedCount());
      registerSize('loop worker pools', () => host.stats?.pools ?? 0);
      registerMemNote('loop worker', () => host.stats ? `loop worker heap ${Math.round(host.stats.heapUsed / 1_048_576)} MB${host.alive ? '' : ' (restarting)'}` : null);
      // Hourly: the worker takes the hour's numbers ONCE (and starts a new
      // hour); the same "[loop] hour:" line and Telegram block as before.
      loopHourText = async () => {
            const r = await host.takeHour();
            if (!r) {
                  console.log('[loop] hour: no numbers (loop worker not answering or restarting)');
                  return 'Loop trades: no numbers this hour (loop worker restarting)';
            }
            console.log(loopLogLine(r.h, loopCfg.maxPools, 'hour', r.node));
            return formatLoopHour(r.h, loopCfg.maxPools, loopExtra?.status(loopCfg.maxPoolAgeMs) ?? null) + `\n  ${r.node}`;
      };
      console.log(`[loop] fix phase 2: real prices ${realPricesOn ? 'on' : 'off'}, keep block updates ${loopFix.keepBlockUpdates ? 'on' : 'off'}, trigger replay ${loopFix.triggerReplay ? 'on' : 'off'}, model vs check ${loopFix.modelVsCheck ? 'on' : 'off'}, cheap scan ${loopFix.cheapScan ? 'on' : 'off'}`);
      console.log(`[loop] loop checks on the ${loopNodeCfg.label} (main checking node kept for 2-pool checks only), up to ${Number.isFinite(loopNodeCfg.dailyCap) ? loopNodeCfg.dailyCap : 'unlimited'} a day`);
      console.log(`[loop] loop trader ON in its own thread (LOOP_WORKER, practice only, never sends): 3-${loopCfg.maxPools} pools, up to ${loopCfg.maxCycles} loops, max $${loopCfg.maxTradeUsd}, bar $${loopCfg.minNetUsd}, ${loopCfg.checksPerMin} checks/min, worker memory limit ${loopWorkerHeapMbFromEnv()} MB`);
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
      trace?: StageTrace | null; // stage timers (trigger trades only)
      // Loan fee (pips, 100 = 0.01%) already taken off netProfitUsd when it
      // was worked out: 0 if it was planned as own money. If the lender
      // chosen now charges more (balances moved, or planning priced a lender
      // that turned out too small), the difference comes off here before it
      // becomes the contract's profit floor.
      plannedLoanPips: number;
      // What the practice check said (sitting gaps). The outlier guard looks at
      // the bigger of this and netProfitUsd, so a $785 check result can't slip
      // past it just because the model said $15.
      checkedProfitUsd?: number;
}) => {
      try {
            // Hard stop: never build a trade on an exchange that isn't cleared
            // for trading (config/robinhoodVenues.ts executionEnabled: false).
            if (!isExecutableVenue(o.buyPool?.dex ?? '') || !isExecutableVenue(o.sellPool?.dex ?? '')) {
                  console.log(`[exec-dryrun] ${o.chain} NOT executable: exchange not cleared for trading (${o.buyPool?.dex} / ${o.sellPool?.dex})`);
                  return;
            }
            const block = (r: string) => { fireStats.blocked.set(r, (fireStats.blocked.get(r) ?? 0) + 1); };
            // Pool pairs whose practice checks keep losing (benched 6 h) aren't
            // sent either: a trade the checks say never pays would only burn gas.
            // Big gaps ($1+ expected, BENCH_BYPASS_USD) are sent even on a benched pair.
            if (o.chain === 'robinhood' && o.source === 'trade' && o.netProfitUsd < BENCH_BYPASS_USD && routeScores.isBenched(RouteScores.key(o.buyPool.poolAddress, o.sellPool.poolAddress))) {
                  block('pool pair benched (practice checks keep losing)');
                  return;
            }
            // Auto-vetted coins: smaller trade limit (their rules could still change).
            if (o.chain === 'robinhood' && involvesAutoVetted([o.tokenIn, o.tokenOut]) && o.tradeSizeUsd > AUTO_VET_MAX_TRADE_USD) {
                  block(`auto-vetted coin: over the $${AUTO_VET_MAX_TRADE_USD} limit`);
                  return;
            }
            // Own money or loan (same choice as the practice check, see pickLender).
            const lender = pickLender(o.chain, o.tokenIn, o.buyPool, o.sellPool, o.tradeSizeUsd, o.usdPerTokenIn);
            let netProfitUsd = o.netProfitUsd;
            if (o.chain === 'robinhood') {
                  const actualPips = lender ? (lender.feePips ?? lender.feeBps * 100) : 0;
                  netProfitUsd -= o.tradeSizeUsd * Math.max(0, actualPips - o.plannedLoanPips) / 1_000_000;
            }
            // The one send minimum, for every kind of trade (trigger and
            // sitting gap): MIN_NET_PROFIT_USD ($0.10 default) after all costs.
            if (!(netProfitUsd >= MIN_NET_PROFIT_USD)) { block('expected profit under the send minimum'); return; }
            const dry = buildExecuteCall({
                  chain: o.chain, tokenIn: o.tokenIn, buyPool: o.buyPool, sellPool: o.sellPool,
                  tradeSizeUsd: o.tradeSizeUsd, netProfitUsd, usdPerTokenIn: o.usdPerTokenIn,
                  // Strict lookup: no default-to-18 for real trade amounts.
                  tokenInDecimals: TOKEN_DECIMALS[o.chain]?.[o.tokenIn.toLowerCase()],
                  // Deadline: the contract reverts if mined after this block. Live
                  // trades get the ESTIMATED current block + a margin (default 3 s
                  // worth of blocks; MAX_BLOCK_MARGIN_MS). The old "last read + 3"
                  // was up to 2 s stale, so most real trades would revert Expired.
                  // 0 is only used in dry runs.
                  maxBlock: o.chain === 'robinhood' && robinhoodSender.live ? (robinhoodSender.deadlineBlock() ?? 0n) : 0n,
                  ...executorConfig(o.chain),
                  v3Lender: lender?.poolAddress,
            });
            if ('reason' in dry) { console.log(`[exec-dryrun] ${o.chain} NOT executable: ${dry.reason}`); return; }
            if (o.chain === 'robinhood' && robinhoodSender.live) {
                  // No fresh block number = no safe deadline: don't send.
                  if (robinhoodSender.deadlineBlock() === null) { block('block info stale'); return; }
                  // Readiness checks (chain id, executor role, lenders, ArbSys) must pass first.
                  if (!liveChecks.ok) { block('live checks not passed'); return; }
            }
            // Live funding. Oct 11: own-money trades are now allowed (they were
            // all refused before, even though the plan is own money first):
            //   - own money: only if the contract really holds the exact amount
            //     this trade spends (re-read every 15 s and after each trade)
            //   - loan: only from a pool the owner approved (setFlashPool);
            //     anything else reverts on-chain
            if (o.chain === 'robinhood' && robinhoodSender.live) {
                  if (dry.funding === 'own') {
                        if (!ownMoney.covers(o.tokenIn, dry.amountIn)) { block('own money too low and no approved lender'); return; }
                  } else if (dry.funding !== 'v3-flash') {
                        block('no approved flash lender for this token');
                        return;
                  }
                  // OUTLIER GUARD (core/outlierGuard.ts, Oct 15). A profit that is too
                  // good to be true (over $50, or over 2% of the trade and over $20) is
                  // sent only if it is paid in USDG/WETH and a second check on another
                  // node agrees at full and half size. Normal wins skip this entirely.
                  // LIVE trigger trades: the second check runs on the latest block, where
                  // the trade we follow hasn't landed yet, so it will almost never
                  // confirm. That makes this a deliberate cap by policy: trigger
                  // trades above the outlier line are not sent live.
                  const guardUsd = Math.max(netProfitUsd, o.checkedProfitUsd ?? 0);
                  if (isOutlier(guardUsd, o.tradeSizeUsd, OUTLIER_CFG)) {
                        const builtAt = Date.now();
                        const v = await confirmRhOutlier(o.tokenIn, dry.hops, dry.amountIn, dry.minProfit, lender?.poolAddress);
                        markStretch('outlier second check');
                        // The deadline (maxBlock) was set when the trade was built. If the
                        // second check took over 1 s, the deadline may be too close: don't send.
                        const tookMs = Date.now() - builtAt;
                        if (v.ok && tookMs > Number(process.env.OUTLIER_MAX_DELAY_MS ?? 1000)) {
                              console.log(`[outlier] LIVE NOT SENT: ${symbolOf(o.chain, o.tokenIn)}/${symbolOf(o.chain, o.tokenOut)} confirmed but the check took ${tookMs} ms (deadline too close)`);
                              block('outlier profit, second check too slow (deadline)');
                              liveTradeLog.noteBlocked('outlier profit, second check too slow (deadline)');
                              return;
                        }
                        if (!v.ok) {
                              console.log(`[outlier] LIVE NOT SENT${o.source === 'trade' ? ' (trigger outlier: capped by policy)' : ''}: ${symbolOf(o.chain, o.tokenIn)}/${symbolOf(o.chain, o.tokenOut)} $${guardUsd.toFixed(2)} on $${Math.round(o.tradeSizeUsd)} (${'reason' in v ? v.reason : 'refused'})`);
                              block('outlier profit (too good to be true), second check failed');
                              liveTradeLog.noteBlocked('outlier profit (too good to be true), second check failed');
                              return;
                        }
                        console.log(`[outlier] live send allowed: $${netProfitUsd.toFixed(2)} on $${Math.round(o.tradeSizeUsd)}, ${v.detail}`);
                  }
            }
            if (o.chain !== 'robinhood') {
                  console.log(`[exec-dryrun] ${o.chain} executable: ${dry.hops.map((h) => `kind${h.kind}`).join('->')} amountIn=${dry.amountIn} ${dry.funding}`);
                  return;
            }
            const gate = safetyGate.check({ tradeSizeUsd: o.tradeSizeUsd, tokens: [o.tokenIn, o.tokenOut] });
            if (!gate.ok) {
                  const r = 'reason' in gate ? gate.reason.replace(/\$\d+/g, '$N').replace(/0x[0-9a-f]+/gi, '0x…') : 'blocked';
                  fireStats.blocked.set(r, (fireStats.blocked.get(r) ?? 0) + 1);
                  if (robinhoodSender.live) { liveTradeLog.noteBlocked(r); safetyAlerts.onBlocked('reason' in gate ? gate.reason : '', safetyGate.lossTodayUsd(true)); }
                  return;
            }
            if (robinhoodSender.live && !dry.to) {
                  fireStats.blocked.set('no executor deployed', (fireStats.blocked.get('no executor deployed') ?? 0) + 1);
                  return;
            }
            o.trace?.mark('checks');
            const fired = await robinhoodSender.fire(dry.to ?? '0x0000000000000000000000000000000000000000', dry.data);
            markStretch('fire result'); // stall finder: handling the sender's answer
            o.trace?.addFire(fired);
            // Dry run: this trade passed every check and would have been sent.
            // Standing gaps carry a simulation-confirmed profit; trigger trades
            // carry the model's estimate (their simulation is counted separately).
            if (!fired.live) {
                  // Gap wins are counted where they're confirmed (gap scanner), not here.
                  if (o.source !== 'gap') dryRunPnl.recordModelOnly(netProfitUsd);
            }
            // Trade seen -> trade SIGNED (the send itself isn't part of "ready").
            const readyMs = (fired.signedAtMs ?? Date.now()) - o.seenAtMs;
            if (o.source === 'trade') fireStats.readyMs.push(readyMs);
            const tradeLabel = `${symbolOf(o.chain, o.tokenIn)}/${symbolOf(o.chain, o.tokenOut)} ${o.buyPool.dex}>${o.sellPool.dex}`;
            if (fired.live && !fired.txHash && fired.error) { liveTradeLog.sendFailed(tradeLabel, o.tradeSizeUsd, fired.error); alertHooks.liveSendFailed(tradeLabel, fired.error); }
            if (fired.txHash) {
                  fireStats.sent++;
                  liveTradeLog.sent(fired.txHash, tradeLabel, o.tradeSizeUsd, netProfitUsd);
                  // Our balances change when it lands: re-read them a few seconds later.
                  setTimeout(() => { void refreshOwnMoney(); }, 3_000);
                  // Worst-case gas (2x today's cost) held against the daily loss cap until the receipt.
                  safetyGate.reservePending(fired.txHash, 2 * rhGasUsd(0.05));
                  liveTracker.track(fired.txHash, { expectedProfitUsd: netProfitUsd, label: tradeLabel, routeKey: routeKeyFor(dry.hops.map((h) => h.kind), dry.funding === 'v3-flash') });
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

// FABLES FEES (core/fablesFee.ts): each Fables pool's hook says what fee the
// next swap pays (currentFee(poolId, direction)). One bundled read for all
// Fables pools every 5 s; the price maths then uses that fee (the higher of
// the two directions, to stay on the safe side) instead of a 0.30% guess.
const fablesFees = new FablesFeeBook();
setHookedFeeSource((id) => {
      const now = Date.now();
      const a = fablesFees.predict(id, true, now), b = fablesFees.predict(id, false, now);
      if (a.source === 'fallback' && b.source === 'fallback') return null; // not read yet: keep the default
      return Math.max(a.feePips, b.feePips);
});
setInterval(labelled('fables fee read', async () => {
      try {
            // (Oct 14: walks the pools without copying the whole list first; same pools.)
            const pools: { id: string; hooks: string }[] = [];
            for (const p of cache.forChain('robinhood')) if (p.dex === 'fables' && p.v4?.hooks) pools.push({ id: p.poolAddress, hooks: p.v4.hooks });
            if (!pools.length) return;
            rhDecisionCallMany ??= (await makeCaller(robinhoodReadProvider)).callMany;
            const read = await readFablesFees(rhDecisionCallMany, pools);
            markStretch('fables fee read');
            fablesFees.applyRead(read, Date.now());
      } catch { /* node busy: keep the last fees, try again in 5 s */ }
}), 5_000);
const pricesAtDecisionRobinhood = async (traded: PoolState, peers: PoolState[]): Promise<[PoolState, PoolState[]]> => {
      const all = [traded, ...peers];
      let wsTrusted = 0;
      const stale = all.filter((p) => !(FAST_PRICES && Date.now() - p.lastUpdatedMs <= FRESH_MS)
            && !(p.dex === 'uniswap-v4' && !p.v4) && (p.poolType === 'v2' || p.poolType === 'v3')
            // SPEED_TRUST_WS: older than FRESH_MS, but the WebSocket proves it's still current.
            && !(FAST_PRICES && wsTrustProblem(p, wsFacts, cache, trustCfg) === null && ++wsTrusted > 0));
      if (wsTrusted) stageTimers.noteTrustedWs(wsTrusted);
      priceStats.local += all.length - stale.length;
      if (!stale.length) return [traded, peers];
      const now = Date.now();
      if (now - decisionRpcWindow.at >= 1_000) decisionRpcWindow = { at: now, n: 0 };
      if (++decisionRpcWindow.n > MAX_DECISION_RPC_PER_SEC) { priceStats.local += stale.length; return [traded, peers]; }
      priceStats.rpc += stale.length;
      const readStartedMs = Date.now();
      let fresh: PoolState[] = [];
      const refreshT0 = performance.now();
      try {
            rhDecisionCallMany ??= (await makeCaller(robinhoodReadProvider)).callMany;
            fresh = await Promise.race([
                  refreshPoolsBatch(rhDecisionCallMany, stale),
                  new Promise<PoolState[]>((r) => setTimeout(() => r([]), REFRESH_TIMEOUT_MS)),
            ]);
      } catch { fresh = []; }
      stageTimers.notePriceRefresh(performance.now() - refreshT0); // RPC on the hot path: how long it held the trade
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

const onFeedEvent = async (event: RawChainEvent) => {
const t0 = Date.now();
// Stage timers (measurement only): lap times from "feed received" onwards.
const trace = event.chain === 'robinhood' ? stageTimers.begin(event.receivedAtMs) : null;
// Timestamp every Robinhood feed tx: lets the competitor tracker time rivals.
if (event.chain === 'robinhood') {
      rivals.noteFeedTx((event.raw as any)?.hash, event.receivedAtMs);
      // Loop trader (only when on): the feed's order of transactions, to know
      // which pending trades a block read already includes.
      if (loopTriggersOn) loopTriggers.noteFeedTx((event.raw as any)?.hash);
      else if (loopWorkerTriggersOn) loopWorker?.noteFeedTx((event.raw as any)?.hash); // loop worker: one array push
      // The rival tracker needs the SENDER, which costs a signature check
      // (~1-2 ms). Done on the next turn, after this frame's trades have been
      // decided, so it never delays our own decision (FEED_LAZY_SENDER=0: old order).
      // Since Oct 14 the sender is passed as a function (RIVAL_LAZY_SENDER):
      // rival watch only works it out for the few transactions where it can
      // matter, instead of for every feed transaction (RIVAL_LAZY_SENDER=0: old).
      const raw = event.raw as any;
      const sender = RIVAL_LAZY_SENDER ? () => raw?.from : undefined;
      // First 4 bytes of the call (cheap slice): coin transfers / approvals and
      // ETH sends with no call skip the sender check (only used in lazy mode).
      const sel = RIVAL_LAZY_SENDER && typeof raw?.data === 'string' ? raw.data.slice(0, 10) : undefined;
      if (process.env.FEED_LAZY_SENDER !== '0') setImmediate(() => { try { timed('rival watch', () => rivalWatch.noteTx(raw?.to, raw?.hash, sender ?? raw?.from, raw?.value, sel)); } catch { /* never affects trading */ } });
      else rivalWatch.noteTx(raw?.to, raw?.hash, sender ?? raw?.from, raw?.value, sel);
}

const swap = await decoder.decode(event);
// Stall finder: everything after the decode (pool lookup, peers, filters)
// used to run unnamed ("other"); named now (measurement only).
markStretch('feed trade');
if (!swap) return;
trace?.mark('decode');
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

          // Stage timers: an RPC pool lookup on the hot path (and was the pair already watched?).
          if (entry?.factory && swap.chain === 'robinhood' && (entry.style === 'v2' || entry.style === 'v3')) stageTimers.noteLookupRpc(robinhoodWatcher.isWatched(swap.tokenIn, swap.tokenOut));
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
          if (after !== pool) {
                cache.upsertFromFeed(after);
                // Loop trader (only when on): remember this trade for the next
                // loop scan (its predicted effect + its hash for the replay check).
                if (loopTriggersOn) loopTriggers.note(after.poolAddress, { hash: (event.raw as any)?.hash, inIsA, amountIn: swap.amountIn, at: Date.now() });
                else if (loopWorkerTriggersOn) loopWorker?.noteTrade(after.poolAddress, { hash: (event.raw as any)?.hash, inIsA, amountIn: swap.amountIn, at: Date.now() });
                requestGapScan();
          }
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
    const cachedPeers = deepPeers.filter((p) => canPracticeTest(p.dex));
    if (swap.chain === 'robinhood' && deepPeers.length > cachedPeers.length) funnelSkip(`partner on an exchange we can't trade yet (${[...new Set(deepPeers.filter((p) => !canPracticeTest(p.dex)).map((p) => p.dex))].join(', ')})`);
    if (cachedPeers.length === 0) {
          if (swap.chain === 'robinhood') {
                funnel.noPartner++;
                // Research lane (off unless RESEARCH_LANE=1): maybe sample it; planned later, off this path.
                const victim = pool, hash = (event.raw as any)?.hash;
                if (research.enabled) research.offer('shallow_pool', victim.poolAddress, () => researchShallow(victim, swap, hash));
          }
          return;
    }
    trace?.mark('lookup');
    // Fast path: use our own up-to-date copy when it's recent (kept current by
    // instant price tracking + the 5s re-sync); only ask the RPC when stale.
    const [freshPool, ...peers] = swap.chain === 'robinhood'
          ? await pricesAtDecisionRobinhood(pool, cachedPeers).then(([t, ps]) => [t, ...ps])
          : await Promise.all([priceAtDecision(pool, true), ...cachedPeers.map((p) => priceAtDecision(p))]);
    // Stall finder: sizing / profit maths after the prices came back.
    markStretch('feed trade decide');
    pool = freshPool;
    trace?.mark('prices');

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
      // ACCURATE COSTS (Oct 8, owner approved), Robinhood:
      //  - gas: live gas price x our contract's measured gas (fork-measured
      //    ~2 cents); the fallback before the first gas reading is 5 cents, not $2
      //  - loan fee: the fee of the lender the real-chain check will use (the
      //    0.01% Uniswap pool = 1 bp), not a flat 9 bps; no lender = own money, 0
      //  - finer size search (pure maths, no node requests)
      // Other chains keep the old figures.
      const rh = swap.chain === 'robinhood';
      const loanBps = rh ? rhLoanFeeBps(swap.tokenIn, pool, peer) : 9;
      const candidate = planBackrun(cache, pool, peer, swap, usdPerToken, {
            gasPriceUsd: rh ? rhGasUsd(0.05, loanBps !== null, [kindForPool(pool), kindForPool(peer)]) : 2,
            dexFeeBps: { buy: pool.feeBps, sell: peer.feeBps }, // overwritten per direction inside planBackrun
            flashLoanFeeBps: loanBps ?? 0,
            usingFlashLoan: !rh || loanBps !== null,
            safetyMarginPct: 0.15,
      }, decimalsOf(swap.chain, swap.tokenIn), rh ? { refineSize: true, maxTradeUsd: involvesAutoVetted([swap.tokenIn, swap.tokenOut]) ? Math.min(MAX_TRADE_USD, AUTO_VET_MAX_TRADE_USD) : MAX_TRADE_USD, ...(loanBps === null ? { funding: 'own-capital' as const } : {}) } : {});
      if (candidate && (!plan || candidate.profit.conservativeNetProfitUsd > plan.profit.conservativeNetProfitUsd)) plan = candidate;
}
trace?.mark('math');
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
// Oct 8 (owner approved): bar lowered to $0.05 (about twice our real gas):
// every verified rival win was under $0.50, so the old bar hid all of them.
// Coins not on the vetted list are now TESTED too (a test spends nothing);
// they still can never be traded or counted as verified money.
const SIM_MIN_GROSS_USD = SIM_CHECK_BAR_USD;
const simVetted = swap.chain !== 'robinhood' || (safetyGate.isAllowed(swap.tokenIn) && safetyGate.isAllowed(swap.tokenOut));
const simAllowed = swap.chain !== 'robinhood' ? simVetted : true;
if (swap.chain === 'robinhood') {
      if (sizing.grossProfitUsd < SIM_MIN_GROSS_USD) funnel.belowCheckBar++;
      else { funnel.sentToCheck++; if (!simVetted) funnel.notVetted++; }
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
if (sizing.grossProfitUsd >= SIM_MIN_GROSS_USD && simAllowed) {
      queueSimulation(swap.chain, swap.tokenIn, buyPoolUsed, sellPoolUsed, sizing.optimalTradeSizeUsd, sizing.grossProfitUsd, usdPerToken, (event.raw as any)?.hash, simVetted);
}

if (!profit.qualifies) {
shadowLogger.record({ opportunity, outcome: 'SKIPPED_BELOW_MIN_PROFIT', ourHypotheticalReactionMs: reactionMs });
      // Only significant near-misses go to Telegram (per architecture doc:
      // "no play-by-play noise") — gross opportunity had to clear a real bar
      // even though it netted below the send minimum (MIN_NET_PROFIT_USD) after costs.
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
                              minRequiredUsd: MIN_NET_PROFIT_USD,
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
            usdPerTokenIn: usdPerToken, seenAtMs: event.receivedAtMs, source: 'trade', trace,
            // Planned with a loan fee only when own money is switched off.
            plannedLoanPips: swap.chain === 'robinhood' && !RH_OWN_MONEY ? (rhLoanFeeBps(swap.tokenIn, buyPoolUsed, sellPoolUsed) ?? 0) * 100 : 0,
      });
};
// Stall finder: each feed trade is timed as "feed trade" up to its first wait
// (measurement only; not counted as a slow background job). The parts after
// its waits are named inside onFeedEvent (markStretch).
chainManager.onEvent((event: RawChainEvent) => { void timedAsync('feed trade', () => onFeedEvent(event), false); });

// Live trading half set up (EXECUTION_ENABLED without the other live
// settings): say so, so it can't be mistaken for the bot actually trading.
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
                              if (liveChecks.ok) { console.log('[fire] live checks passed: chain, executor role, lenders, ArbSys deadline'); alertHooks.liveChecksPassed(); }
                              else {
                                    console.warn(`[fire] LIVE CHECKS FAILED, sends blocked: ${liveChecks.problems.join('; ')}`);
                                    alertHooks.liveChecksFailed(liveChecks.problems);
                                    setTimeout(() => { void runChecks(); }, 5 * 60_000);
                              }
                        };
                        await runChecks();
                        const b = await robinhoodSender.balanceCheck();
                        if (!b.ok) {
                              const msg = `bot wallet ${robinhoodSender.address} has ${ethers.formatEther(b.balance)} ETH, needs ${ethers.formatEther(b.needed)} per trade at the gas cap`;
                              console.warn(`[fire] LOW GAS: ${msg}`);
                              alertHooks.lowGas(msg);
                        }
                  }
            })
            .catch((err) => console.warn('[fire] robinhood sender failed to start:', (err as Error).message));
}

await chainManager.startAll();

      const startStatus = chainManager.getStatus() as Record<string, { online: boolean }>;
      // Not awaited: a slow Telegram must never hold up startup.
      alertHooks.startup(() => formatStartup(startStatus), startStatus, robinhoodSender.live);
      // Problem alerts (report/alertWatch.ts): read-only checks every 5 s. REPORT_V2 only.
      alertHooks.startWatch({
            feedHealthy: () => (chainOn('robinhood') ? chainManager.isHealthy('robinhood') : null),
            wsStatus: () => { const w = wsFacts as unknown as { stats?: () => { healthy: boolean; capped: boolean } } | null; return w?.stats ? w.stats() : null; },
            checkNodePaused: () => (!chainOn('robinhood') ? null : simOff('robinhood') ? 'off' : Date.now() < (simPausedUntil.robinhood ?? 0) ? 'busy' : null),
            queueTimeoutsTotal: () => funnel.skip.get('waited too long in the check line (2 s)') ?? 0,
            memory: () => { const m = process.memoryUsage(); return { heapUsed: m.heapUsed, heapLimit: getHeapStatistics().heap_size_limit, rss: m.rss }; },
            loopWorker: () => (loopWorker ? { crashes: loopWorker.crashes, restarts: loopWorker.restarts } : null),
      });
      stallFinder.onStall((ms, job) => alertHooks.onFreeze(ms, job));

      // Kuru is an order book, not something you find via factory.getPair(),
      // so its market is seeded directly from the known address rather than
      // discovered from swap traffic. This is what gives the Uniswap V3 pool
      // a real second venue to compare against for cross-DEX opportunities.
      if (chainOn('monad')) {
      // Loaded only when Monad is on (saves ~22 MB otherwise).
      const { ethers: ethersV5 } = await import('ethers-v5');
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
            setInterval(labelled('kuru seed', seedKuruMarket), 30_000); // vault liquidity shifts as orders fill — keep it fresh
      }

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
            setInterval(labelled('monad peer seed', seedMonadV3Peer), 30_000);
      }

      // Robinhood partner pools: every DEX + fee tier for WETH/USDG from the
      // start (replaces the old single Uniswap V2 + Ramses V2 seeds); other
      // pairs are added automatically as they trade (core/pairWatcher.ts).
      // Background: finding every WETH/USDG pool takes minutes on the free
      // RPC (one DEX and fee tier at a time). The bot is live meanwhile;
      // pools join the watch list as they're found.
      robinhoodWatcher.start();
      // PRELOAD (SPEED_PRELOAD, default on): every watched pool's price in the
      // cache right away (pools restored from the last run are re-read now in
      // one bundled request instead of on the first trade), then once a minute
      // re-look-up any watched pair whose pool went missing from the cache.
      // Off the hot path; a feed trade on a watched pool never waits for it.
      if (SPEED_PRELOAD) {
            const runPreload = async (why: string) => {
                  const r = await robinhoodWatcher.preload();
                  if (why === 'start' || r.refreshed || r.missingPairs) console.log(`[speed] preload (${why}): ${r.pools} watched pools, ${r.refreshed} re-read now, ${r.missingPairs} pair${r.missingPairs === 1 ? '' : 's'} looked up again`);
            };
            void runPreload('start');
            setInterval(labelled('pool preload', () => { void runPreload('check'); }), 60_000);
      }

      // STANDING-GAP SCANNER (core/gapScanner.ts): every 5 s, right after the
      // price re-sync, look for gaps that exist without a trigger trade.
      // Anti-spam: the same gap (pair + pools) fires at most once per 30 s,
      // at most 2 fires per scan, and every fire still passes the safety gate.
      // VERIFY FIRST: the scanner's maths assumes V3 pools are deep around the
      // current price, which isn't true for thin, narrow positions. So every
      // new gap is simulated on-chain (real pool code, ~1 s) before it counts:
      //   confirmed -> fired (dry run: logged) with the SIMULATED profit
      //   not real  -> muted for 30 min so it stops repeating
      // Oct 9 (owner approved): sitting gaps are TESTED from a 5-cent model
      // profit (was $20) and count when the real-chain test confirms 2 cents+
      // after gas. Most rival wins are sitting gaps under $1.
      // At most GAP_TESTS_PER_MIN tests a minute (default 6) so the checking
      // node's allowance isn't burned; failing pairs are muted 30 min.
      // Oct 12: $0.10 (was $0.05) and 3 small-gap checks a minute (was 6) to keep
      // QuickNode's daily allowance through market hours. Big gaps ($1+) keep their own 20.
      const GAP_MIN_USD = Number(process.env.GAP_MIN_USD ?? 0.10);
      const GAP_CONFIRM_MIN_USD = Number(process.env.GAP_CONFIRM_MIN_USD ?? 0.02);
      const GAP_TESTS_PER_MIN = Number(process.env.GAP_TESTS_PER_MIN ?? 3);
      const gapTestTimes: number[] = [];
      // Separate, bigger budget for big gaps ($1+) so they never wait behind small ones.
      const GAP_BIG_TESTS_PER_MIN = Number(process.env.GAP_BIG_TESTS_PER_MIN ?? 20);
      const gapBigTimes: number[] = [];
      const gapLastSig = new Map<string, string>(); // pool prices when each pair was last checked
      // ONE GAP = ONE WIN: a gap nobody takes can sit there for minutes, and
      // re-confirming it every 30 s counted the same chance again and again.
      // We remember both pools' price state at each confirmed win and skip the
      // pair until either pool's price actually changes (a new chance).
      const gapConfirmedState = new Map<string, string>();
      // Oct 11 review: with prices now updated every block, a tiny unrelated
      // trade changes a pool's state and used to make the same open gap count
      // again. Now a confirmed gap counts again only after it CLOSED (left the
      // scan's list) or at least doubled in size. Value = model profit when confirmed.
      const gapConfirmedOpen = new Map<string, number>();
      // Oct 15: when an open gap is re-checked because it doubled, only the
      // growth counts toward "would have made" (one gap, one trade). Reporting only.
      const gapCredit = new GapCredit();
      const poolSig = (p: PoolState) => `${p.sqrtPriceX96 ?? ''}:${p.liquidity ?? ''}:${p.reserveA ?? ''}:${p.reserveB ?? ''}`;
      const GAP_FAKE_MUTE_MS = 30 * 60_000;
      const gapLastFired = new Map<string, number>();
      const gapMutedUntil = new Map<string, number>();
      // Pool state when a pair was muted: a big gap on a muted pair is
      // re-checked only if the pools actually changed since (a broken pool
      // showing the same fake gap forever doesn't eat the check budget).
      const gapMutedSig = new Map<string, string>();
      let gapRunning = false; // a slow simulation must not let scans pile up
      // WHEN it runs: the moment any price changes (a trade we read from the
      // feed, or a price re-sync finishing), debounced 50 ms so a burst of
      // trades is one scan; plus every 5 s as a safety net. The scan only
      // reads prices already in memory, so running it often costs no RPC.
      let gapScanQueued: NodeJS.Timeout | null = null;
      // FAST GAP SCAN (Oct 14, freeze phase 1; core/gapScanner.ts
      // findStandingGapsSteps). Same gaps as before, but:
      //   - pairs whose pools didn't change reuse their last answer
      //   - the scan runs in small bites (GAP_SCAN_SLICE_MS, default 8 ms)
      //     with breaks for feed messages, instead of one long freeze
      //   - a price change that arrives while a scan (or its practice check)
      //     is running is no longer dropped: one more scan runs right after
      // GAP_SCAN_FAST=0 = the old one-go scan.
      const GAP_SCAN_FAST = process.env.GAP_SCAN_FAST !== '0';
      const GAP_SCAN_SLICE_MS = Number(process.env.GAP_SCAN_SLICE_MS ?? 8);
      const gapMemoMain = new GapScanMemo(), gapMemoExtra = new GapScanMemo();
      let gapAgain = false; // a scan was asked for while one was running
      const queueGapScan = () => {
            if (gapScanQueued) return;
            gapScanQueued = setTimeout(() => { gapScanQueued = null; void timedAsync('gap scan', runGapScan); }, 50);
      };
      requestGapScan = () => {
            requestLoopScan(); // loop trader (off unless LOOP_TRADER=1): same triggers
            queueGapScan();
      };
      // Watched pairs' pools with real money near their price, built in steps
      // (pauses every 32 pairs). Same list as the old one-go build below.
      const usdRhGap = (t: string) => priceOracle.getUsdPrice('robinhood', t);
      function* gapPairsSteps(): Generator<void, PoolState[][], void> {
            const list = robinhoodWatcher.watchedPairPools();
            const out: PoolState[][] = [];
            for (let i = 0; i < list.length; i++) {
                  const ps: PoolState[] = [];
                  for (const a of list[i]) { const p = cache.get('robinhood', a); if (p && deepEnough(p, decimalsOf, usdRhGap)) ps.push(p); }
                  out.push(ps);
                  if ((i & 31) === 31) yield;
            }
            return out;
      }
      const runGapScan = async () => {
            if (gapRunning) { if (GAP_SCAN_FAST) gapAgain = true; return; }
            gapRunning = true;
            try {
                  // Only pools with real money near their price ($1,000+ by default).
                  const usdRh = (t: string) => priceOracle.getUsdPrice('robinhood', t);
                  const pairs = GAP_SCAN_FAST ? await runSteps(gapPairsSteps(), 'gap scan', GAP_SCAN_SLICE_MS)
                        : robinhoodWatcher.watchedPairPools()
                              .map((addrs) => addrs.map((a) => cache.get('robinhood', a))
                                    .filter((p): p is PoolState => !!p && deepEnough(p, decimalsOf, usdRh)));
                  const gapDecimals = (t: string) => TOKEN_DECIMALS.robinhood?.[t.toLowerCase()];
                  // Gaps that need an extra venue (can't trade yet): counted for
                  // the report only, then those pools are left out.
                  if (RH_EXTRA_VENUES) {
                        const extraOpts = { minProfitUsd: 0.25, flashFee: 0, gasUsd: rhGasUsd(0.05), maxTradeUsd: MAX_TRADE_USD };
                        const unsupported = (GAP_SCAN_FAST
                              ? await runSteps(findStandingGapsSteps(pairs, gapDecimals, usdRh, extraOpts, gapMemoExtra), 'gap scan', GAP_SCAN_SLICE_MS)
                              : findStandingGaps(pairs, gapDecimals, usdRh, extraOpts))
                              .filter((g) => !canPracticeTest(g.buyPool.dex) || !canPracticeTest(g.sellPool.dex));
                        for (const g of unsupported.slice(0, 20)) {
                              const ex = [g.buyPool.dex, g.sellPool.dex].filter((d) => !canPracticeTest(d)).join('+');
                              funnelSkip(`standing gap needs ${ex} (can't trade yet), model $0.25+`);
                        }
                  }
                  for (let i = 0; i < pairs.length; i++) pairs[i] = pairs[i].filter((p) => canPracticeTest(p.dex));
                  // Own money (no loan fee) for planning; the check itself borrows at 0.01% above $2,000.
                  const mainOpts = { minProfitUsd: GAP_MIN_USD, flashFee: RH_OWN_MONEY ? 0 : 0.0005, gasUsd: rhGasUsd(0.05), maxTradeUsd: MAX_TRADE_USD,
                        // Top 3 pool combinations per coin pair (was only the best): a muted
                        // combination no longer hides the other pools of the same pair.
                        perPair: 3 };
                  const gaps = GAP_SCAN_FAST
                        ? await runSteps(findStandingGapsSteps(pairs, gapDecimals, usdRh, mainOpts, gapMemoMain), 'gap scan', GAP_SCAN_SLICE_MS)
                        : findStandingGaps(pairs, gapDecimals, usdRh, mainOpts);
                  // The rest of this run (cooldown checks, logging) is named too.
                  markStretch('gap scan');
                  // Gaps that closed since they were confirmed may count again.
                  const openNow = new Set(gaps.map((g) => `${g.buyPool.poolAddress}>${g.sellPool.poolAddress}`));
                  for (const k of gapConfirmedOpen.keys()) if (!openNow.has(k)) gapConfirmedOpen.delete(k);
                  for (const k of [...gapCredit.keys()]) if (!openNow.has(k)) gapCredit.closed(k);
                  // Other-stablecoin counter (reporting only): gaps on aUSD/UUSD/USDe pairs,
                  // from this scan's results already in memory (no node requests).
                  stableTally.noteGaps(gaps.map((g) => ({ key: `${g.buyPool.poolAddress}>${g.sellPool.poolAddress}`, tokens: [g.base, g.quote] as [string, string], modelUsd: g.profitUsd })));
                  let fired = 0;
                  for (const g of gaps) {
                        if (fired >= 2) break;
                        // Fast scan runs in bites: a pool may have got a new price
                        // during a break. Such a gap is skipped (no check budget used,
                        // pair not muted) and one more scan runs with fresh prices.
                        if (GAP_SCAN_FAST && (cache.get('robinhood', g.buyPool.poolAddress) !== g.buyPool || cache.get('robinhood', g.sellPool.poolAddress) !== g.sellPool)) {
                              gapStaleSkips++;
                              gapAgain = true;
                              continue;
                        }
                        const key = `${g.buyPool.poolAddress}>${g.sellPool.poolAddress}`;
                        const sig = `${poolSig(g.buyPool)}|${poolSig(g.sellPool)}`;
                        const bigChanged = g.profitUsd >= BENCH_BYPASS_USD && gapMutedSig.get(key) !== sig;
                        if (!bigChanged && Date.now() < (gapMutedUntil.get(key) ?? 0)) continue;
                        // Big gap ($1+) whose prices moved since this pair was last checked:
                        // skips the 30 s cooldown and the 6-a-minute budget (own cap below),
                        // so small gaps can't use up the checks a big one needs.
                        const bigFresh = g.profitUsd >= BENCH_BYPASS_USD && gapLastSig.get(key) !== sig;
                        if (!bigFresh && Date.now() - (gapLastFired.get(key) ?? 0) < 30_000) continue;
                        if (gapConfirmedState.get(key) === sig) continue; // same gap we already counted
                        const wasConfirmed = gapConfirmedOpen.get(key);
                        if (wasConfirmed !== undefined && g.profitUsd < 2 * wasConfirmed) continue; // still the same open gap
                        // Rate limits: drop timestamps older than a minute; skip when full.
                        while (gapTestTimes.length && Date.now() - gapTestTimes[0] > 60_000) gapTestTimes.shift();
                        while (gapBigTimes.length && Date.now() - gapBigTimes[0] > 60_000) gapBigTimes.shift();
                        if (bigFresh) { if (gapBigTimes.length >= GAP_BIG_TESTS_PER_MIN) continue; gapBigTimes.push(Date.now()); }
                        else { if (gapTestTimes.length >= GAP_TESTS_PER_MIN) continue; gapTestTimes.push(Date.now()); }
                        gapLastFired.set(key, Date.now());
                        gapLastSig.set(key, sig);
                        if (gapLastSig.size > 2_000) gapLastSig.clear();
                        fired++;
                        const label = `${symbolOf('robinhood', g.base)}/${symbolOf('robinhood', g.quote)}`;
                        const route = `buy ${g.buyPool.dex} ${g.buyPool.feeBps / 100}% -> sell ${g.sellPool.dex} ${g.sellPool.feeBps / 100}%`;
                        const spottedAt = Date.now(); // for the race check: spotted -> ready time
                        const check = await checkRoundTrip('robinhood', g.quote, g.buyPool, g.sellPool, g.sizeUsd, g.quoteUsd);
                        // Stall finder: handling the practice check's answer.
                        markStretch('gap check result');
                        if (check.status === 'rate_limited') {
                              // Can't verify right now: skip, don't mute, try again next time.
                              console.log(`[gap] ${label}: model ~$${g.profitUsd.toFixed(2)}, not verified (RPC busy), skipped`);
                              continue;
                        }
                        const simNet = check.status === 'profit' ? check.usd - rhGasUsd(0.05) /* gas */ : 0;
                        if (check.status === 'profit') noteCheck([g.base, g.quote], simNet > 0 ? 'profit' : 'loss');
                        else if (check.status === 'loss') noteCheck([g.base, g.quote], 'loss');
                        else if (check.status === 'fail') noteCheck([g.base, g.quote], 'fail', check.reason);
                        // Per-exchange practice count (skipped checks were not tests).
                        if (check.status !== 'skipped') venueTally.add(g.buyPool.dex, g.sellPool.dex, torontoDay(), check.status === 'profit' ? simNet : undefined);
                        if (check.status !== 'profit' || simNet < GAP_CONFIRM_MIN_USD) {
                              gapMutedUntil.set(key, Date.now() + GAP_FAKE_MUTE_MS);
                              gapMutedSig.set(key, sig);
                              if (gapMutedSig.size > 2_000) gapMutedSig.clear();
                              // A revert is "wouldn't go through" (with its reason);
                              // a loss or too-small profit is "would lose money".
                              if (check.status === 'fail') { gapStats.fail++; failTally.add(check.reason); }
                              // A skipped check (coin can't be tested, checking off...) was
                              // never run: not "would lose money" (it was counted as that).
                              else if (check.status !== 'skipped') gapStats.fake++;
                              const why = check.status === 'profit' ? `real profit only $${check.usd.toFixed(2)}` : check.reason;
                              console.log(`[gap] ${label}: model said ~$${g.profitUsd.toFixed(2)} but NOT REAL (${why}); muted 30 min | ${route}`);
                              gapCredit.closed(key); // not real: forget what it was credited (practice numbers only)
                              continue;
                        }
                        gapStats.found++;
                        gapStats.bestUsd = Math.max(gapStats.bestUsd, simNet);
                        gapConfirmedState.set(key, sig);
                        gapConfirmedOpen.set(key, g.profitUsd);
                        // Emptied together with gapCredit, so a gap that is "new" to the
                        // re-check rule is also credited in full (practice numbers only).
                        if (gapConfirmedOpen.size > 2_000) { gapConfirmedOpen.clear(); for (const k of [...gapCredit.keys()]) gapCredit.closed(k); }
                        if (gapConfirmedState.size > 2_000) gapConfirmedState.clear();
                        // Practice results: confirmed sitting-gap wins on vetted coins count as
                        // "would have earned" here (the firing safety gate below may still
                        // refuse small trades; that's about sending, not about the result).
                        const gapVetted = safetyGate.isAllowed(g.base) && safetyGate.isAllowed(g.quote)
                              && !(involvesAutoVetted([g.base, g.quote]) && g.sizeUsd > AUTO_VET_MAX_TRADE_USD);
                        // Same open gap re-checked after it doubled: only the growth is new
                        // money (one trade takes the gap once). First time: all of it.
                        const gapNew = gapCredit.credit(key, simNet);
                        // Outliers (too good to be true, e.g. the $785 USDG/ORBIO gap) count
                        // only after a second check agrees (core/outlierGuard.ts).
                        if (gapVetted && gapNew >= MIN_COUNTED_USD && await outlierCountOk(`${label} gap`, simNet, g.sizeUsd, check.trade)) {
                              countVerifiedWin(gapNew, `${label} gap`, { startToken: g.quote, sizeUsd: g.sizeUsd, lender: check.trade.v3Lender }, [g.base, g.quote]);
                        }
                        if (gapNew > 0) profitBands.add(gapNew, torontoDay());
                        if (gapNew < simNet) console.log(`[gap] ${label}: same open gap grew, counted only the extra $${gapNew.toFixed(2)} of $${simNet.toFixed(2)}`);
                        // Would we really have won it? (ready = after our check + ~2 ms to sign)
                        void raceChecker.record({ label: `${label} gap`, pools: [g.buyPool.poolAddress, g.sellPool.poolAddress], netUsd: simNet, source: 'gap', readyDelayMs: Date.now() - spottedAt + 2 });
                        console.log(`[gap] standing gap ${label} CONFIRMED: real ~$${simNet.toFixed(2)} (model $${g.profitUsd.toFixed(2)}) on $${Math.round(g.sizeUsd)} | ${route}`);
                        await fireTrade({
                              chain: 'robinhood', tokenIn: g.quote, tokenOut: g.base, buyPool: g.buyPool, sellPool: g.sellPool,
                              // Never trust the model over the simulation.
                              tradeSizeUsd: g.sizeUsd, netProfitUsd: Math.min(g.profitUsd, simNet), usdPerTokenIn: g.quoteUsd,
                              seenAtMs: robinhoodWatcher.lastRefreshMs || Date.now(), source: 'gap',
                              // Fee of the lender the practice check used (already in simNet).
                              plannedLoanPips: check.loanPips,
                              checkedProfitUsd: simNet,
                        });
                        markStretch('gap check result');
                  }
                  if (gapLastFired.size > 500) gapLastFired.clear();
                  for (const [k, t] of gapMutedUntil) if (t < Date.now()) gapMutedUntil.delete(k);
            } catch (err) {
                  console.warn('[gap] scan failed:', (err as Error).message);
            } finally {
                  gapRunning = false;
                  // Prices changed while this run was busy: scan once more (coalesced).
                  if (gapAgain) { gapAgain = false; queueGapScan(); }
            }
      };
      setInterval(() => { void timedAsync('gap scan', runGapScan); }, 5_000);

      // EVERY-BLOCK READER (core/blockReader.ts, Oct 11, owner approved).
      // About half of all trades come through apps the feed decoder can't read,
      // so their price effect used to show up only at the 5 s refresh. The
      // reader asks the free node for each new block's pool events (~every
      // 0.15 s) and writes the exact new prices into the cache, then runs the
      // gap scan. BLOCK_READER=0 turns it off; BLOCK_READER_POLL_MS sets the pace.
      if (process.env.BLOCK_READER !== '0') {
            const READER_URL = process.env.BLOCK_READER_RPC || 'https://rpc.mainnet.chain.robinhood.com';
            // Plain request, outside the price-read failover: a refused poll is
            // simply retried by the reader (it never moves to the paid/backup node).
            const readerRpc = async (method: string, params: unknown[]) => {
                  const res = await fetch(READER_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(3_000) });
                  if (!res.ok) throw new Error(`HTTP ${res.status}`);
                  // Read as text, then parse under a stall-finder name (same result as res.json()).
                  const txt = await res.text();
                  const j: any = timed('block reader json', () => JSON.parse(txt));
                  if (j.error) throw new Error(`${j.error.code ?? ''} ${j.error.message ?? 'rpc error'}`);
                  return j.result;
            };
            // Same, but several calls in one request (answered by one server).
            // A call that failed comes back as an Error in its slot.
            const readerBatch = async (calls: Array<{ method: string; params: unknown[] }>) => {
                  const res = await fetch(READER_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params }))), signal: AbortSignal.timeout(3_000) });
                  if (!res.ok) throw new Error(`HTTP ${res.status}`);
                  const txt = await res.text();
                  const arr: any[] = timed('block reader json', () => JSON.parse(txt));
                  if (!Array.isArray(arr)) throw new Error('batch answer was not a list');
                  return calls.map((_, i) => {
                        const r = arr.find((x) => x && x.id === i);
                        if (!r) return new Error('missing batch answer');
                        return r.error ? new Error(`${r.error.code ?? ''} ${r.error.message ?? 'rpc error'}`) : r.result;
                  });
            };
            const watchedOnly = () => robinhoodWatcher.watchedPairPools().flat().map((a) => a.toLowerCase());
            // Pools whose events the readers apply: watched pools, plus the loop
            // trader's extra single pools when that is on (exactly watchedOnly() when off).
            // Costs no extra node requests: the readers already fetch every
            // block's events by type and keep ours here.
            const watched = () => readerAddresses(watchedOnly(), loopExtra);
            // READER TARGETS KEPT READY (Oct 14, freeze phase 1). Both readers
            // asked for the pool list twice per poll / pushed message (4+ times
            // a second), and each ask rebuilt it from the whole watch list
            // (thousands of new strings each time). Now the list is rebuilt at
            // most once every READER_TARGETS_MS (default 1,000 ms) and handed
            // over frozen, so the readers can reuse their address sets too
            // (core/blockReader.ts AddressSetCache). A pool added to the watch
            // list is picked up within that time. READER_TARGETS_MS=0 = rebuild
            // on every ask (old behaviour).
            const READER_TARGETS_MS = Number(process.env.READER_TARGETS_MS ?? 1_000);
            let readerTargets: { at: number; addrs: readonly string[]; ids: Set<string> } | null = null;
            const targets = () => {
                  const t = Date.now();
                  if (!readerTargets || READER_TARGETS_MS <= 0 || t - readerTargets.at >= READER_TARGETS_MS) {
                        const w = timed('reader targets', watched);
                        readerTargets = { at: t, addrs: Object.freeze(w.filter((a) => a.length === 42)), ids: new Set(w.filter((a) => a.length === 66)) };
                  }
                  return readerTargets;
            };
            // Leave a pool alone if the feed just applied a predicted trade to it.
            const FEED_FRESH_MS = Number(process.env.BLOCK_READER_FEED_GRACE_MS ?? 400);
            let readerApplied = 0;
            // LOOP_KEEP_BLOCK_UPDATES: put a block state the main write skipped
            // into the confirmed view (PoolCache.keepBlockState, which never
            // touches the main cache and ignores an older block). Built from
            // the confirmed copy when there is one (else the main copy), with
            // the block's prices: the same fields the main write would set.
            const keepBlockOn = loopCfg.enabled && loopFix.realPrices && loopFix.keepBlockUpdates && cache.confirmedOn;
            const keepBlockState = (cur: PoolState, u: PoolUpdate): void => {
                  if (cache.confirmedBlock('robinhood', cur.poolAddress) > u.block) return;
                  const base = cache.getConfirmed('robinhood', cur.poolAddress) ?? cur;
                  if (u.kind === 'v2') {
                        if (u.reserve0 === undefined || u.reserve1 === undefined || base.reserveA === undefined) return;
                        if (base.reserveA === u.reserve0 && base.reserveB === u.reserve1 && base.lastUpdatedBlock >= u.block) return;
                        cache.keepBlockState({ ...base, reserveA: u.reserve0, reserveB: u.reserve1 }, u.block, Date.now(), u.txHash);
                  } else {
                        if (u.sqrtPriceX96 === undefined || base.poolType !== 'v3') return;
                        if (base.sqrtPriceX96 === u.sqrtPriceX96 && (u.liquidity === undefined || base.liquidity === u.liquidity) && base.lastUpdatedBlock >= u.block) return;
                        cache.keepBlockState({ ...base, sqrtPriceX96: u.sqrtPriceX96, ...(u.liquidity !== undefined ? { liquidity: u.liquidity } : {}) }, u.block, Date.now(), u.txHash);
                  }
            };
            const applyUpdate = (u: PoolUpdate): boolean => {
                  const cur = cache.get('robinhood', u.pool);
                  if (!cur) return false;
                  // Fee the swap paid (V4 / Algebra Integral events), kept on the
                  // pool even if its price write is skipped below (core/eventFees.ts).
                  // Fables pools: also fed to the Fables fee predictor.
                  if (feeFromEventsOn() && recordEventFee(cur, u) && cur.v4?.hooks && u.v4Fee !== undefined && u.zeroForOne !== undefined) {
                        fablesFees.observeSwap(cur.poolAddress, u.zeroForOne, u.v4Fee, Date.now());
                  }
                  if (cur.lastUpdatedBlock > u.block) return false;
                  if (cache.fedWithin('robinhood', cur.poolAddress, FEED_FRESH_MS)) {
                        // LOOP_KEEP_BLOCK_UPDATES (loop trader only): the main
                        // cache still leaves this pool alone (2-pool trades
                        // unchanged), but the exact block state is kept for
                        // the loop finder's confirmed view instead of lost.
                        if (keepBlockOn) keepBlockState(cur, u);
                        return false;
                  }
                  if (u.kind === 'v2') {
                        if (u.reserve0 === undefined || u.reserve1 === undefined || cur.reserveA === undefined) return false;
                        if (cur.reserveA === u.reserve0 && cur.reserveB === u.reserve1) { if (keepBlockOn) keepBlockState(cur, u); return false; }
                        cache.upsertFromBlock({ ...cur, reserveA: u.reserve0, reserveB: u.reserve1, lastUpdatedBlock: u.block }, Date.now(), u.txHash);
                  } else {
                        if (u.sqrtPriceX96 === undefined || cur.poolType !== 'v3') return false;
                        if (cur.sqrtPriceX96 === u.sqrtPriceX96 && cur.liquidity === u.liquidity) { if (keepBlockOn) keepBlockState(cur, u); return false; }
                        cache.upsertFromBlock({ ...cur, sqrtPriceX96: u.sqrtPriceX96, ...(u.liquidity !== undefined ? { liquidity: u.liquidity } : {}), lastUpdatedBlock: u.block }, Date.now(), u.txHash);
                  }
                  return true;
            };
            // Both readers hand their batch here. Writes the new prices, then:
            // a watched pool moved -> gap scan (which also runs the loop scan),
            // only extra loop pools moved -> loop scan alone (the gap scan has
            // nothing new to look at). With extra pools off: gap scan, as before.
            const onReaderUpdates = (latest: Map<string, PoolUpdate>) => timed('block reader apply', () => {
                  const applied: string[] = [];
                  for (const u of latest.values()) if (applyUpdate(u)) applied.push(u.pool);
                  readerApplied += applied.length;
                  const next = afterReaderWrite(applied, loopExtra, () => new Set(watchedOnly()));
                  if (next === 'gap') requestGapScan();
                  else if (next === 'loop') requestLoopScan();
            });
            // PUSH READER (core/blockReaderWs.ts). Only when BLOCK_READER_WSS is set:
            // the node pushes each block's events over a WebSocket into the same
            // applyUpdate path. The poll reader below stays quiet while the push
            // feed is healthy and takes over whenever it isn't.
            let wsReader: WsBlockReader | null = null;
            if (process.env.BLOCK_READER_WSS) {
                  wsReader = new WsBlockReader({
                        url: process.env.BLOCK_READER_WSS,
                        httpRpc: readerRpc,
                        httpLabel: `${endpointLabel(READER_URL)} (block reader gap fills)`,
                        heads: process.env.BLOCK_READER_WSS_HEADS === '1',
                        // Only our pools' events (BLOCK_READER_WSS_FILTER=0 = every pool on the chain),
                        // and at most BLOCK_READER_WSS_DAILY pushed messages a UTC day (0 = no cap).
                        addressFilter: process.env.BLOCK_READER_WSS_FILTER !== '0',
                        dailyMessageCap: Number(process.env.BLOCK_READER_WSS_DAILY ?? 400_000),
                        poolManager: ROBINHOOD_V4.POOL_MANAGER,
                        // (Oct 14: same lists, kept ready; see targets() above.)
                        addresses: () => targets().addrs as string[],
                        v4Ids: () => targets().ids,
                        onUpdates: (latest) => onReaderUpdates(latest),
                        // Push feed down: polling resumes from the last block it delivered.
                        onHealthChange: (healthy, last) => { if (!healthy && last > 0) blockReader.setBookmark(last - 1); },
                  });
                  wsFacts = wsReader; // SPEED_TRUST_WS reads its health facts (core/trustFresh.ts)
            }
            const blockReader = new BlockReader({
                  rpc: readerRpc,
                  rpcBatch: readerBatch,
                  // Ask for events by type only (tiny request) and keep ours here.
                  localFilter: true,
                  // Stay quiet while the price-read node is resting after a refusal,
                  // or while the push reader (if set) is delivering events.
                  paused: () => (wsReader?.healthy() ?? false) || robinhoodReadProvider.mainResting(),
                  poolManager: ROBINHOOD_V4.POOL_MANAGER,
                  addresses: () => targets().addrs as string[],
                  v4Ids: () => targets().ids,
                  // ~4 polls a second (each is one request carrying 2 calls).
                  pollMs: Number(process.env.BLOCK_READER_POLL_MS ?? 250),
                  onUpdates: (latest) => onReaderUpdates(latest),
            });
            blockReader.start();
            wsReader?.start();
            const logReader = () => {
                  const st = blockReader.stats();
                  const errs = blockReader.errorSummary(3);
                  console.log(`[blockreader] polls ${st.polls} (ok ${st.ok}, errors ${st.errors}, rate-limited ${st.rateLimited}, paused ${st.pausedPolls}, restarts ${st.restarts}) · prices updated ${readerApplied} · median ${st.medianMs} ms · skipped ranges ${st.skippedRanges}${errs ? ' · errors: ' + errs : ''}${wsReader ? ' · ' + wsReader.statusText() : ''}${loopExtra ? ' · ' + loopExtra.statusText(loopCfg.maxPoolAgeMs) : ''}`);
            };
            setTimeout(logReader, 60_000);
            setInterval(labelled('block reader log', logReader), 5 * 60_000);
      }
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
      setInterval(labelled('lender balances', () => { void refreshLenders(); }), LENDER_REFRESH_MS);
      // Own money in the trade contract: every 15 s while live (does nothing in practice).
      setTimeout(() => { void refreshOwnMoney(); }, 5_000);
      setInterval(labelled('own money read', () => { void refreshOwnMoney(); }), 15_000);
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
      const loadScanState = (): ScanState => timed('scan file load', () => {
            try {
                  const st = JSON.parse(readFileSync(SCAN_STATE_FILE, 'utf8'));
                  if (st?.version === 1 && Array.isArray(st.pools)) return st;
            } catch { /* missing or unreadable: start fresh */ }
            return emptyScanState();
      });
      // The file holds every pool on the chain (~400k, tens of MB of text).
      // STALL_FIX_SAVES: written in ~5 ms bites with async writes (same bytes,
      // still temp file + rename). Off: the old one-go write.
      const saveScanState = async (st: ScanState) => {
            try {
                  if (STALL_FIX_SAVES) { await writeJsonChunkedQueued(SCAN_STATE_FILE, st, 'scan file save'); return; }
                  timed('scan file save', () => {
                        mkdirSync('data', { recursive: true });
                        writeFileSync(SCAN_STATE_FILE + '.tmp', JSON.stringify(st));
                        renameSync(SCAN_STATE_FILE + '.tmp', SCAN_STATE_FILE); // atomic: never a half-written file
                  });
            } catch (err) { console.warn('[scan] could not save state:', (err as Error).message); }
      };
      let scanState: ScanState | null = null;
      let scanRunning = false;
      // Called after each good chain-wide scan (the loop trader's extra pools
      // rebuild their pick then; a no-op unless that is on).
      let onScanDone: () => void = () => {};
      // Freeze report: the whole scan counts as "pool scan" in progress, so a
      // freeze during it says "(during ..., pool scan)" (REBUILD_PACED).
      const runRobinhoodScan = (): Promise<void> => (REBUILD_PACED && !scanRunning && SCAN_TOP > 0 ? timedAsync('pool scan', runRobinhoodScanInner) : runRobinhoodScanInner());
      const runRobinhoodScanInner = async () => {
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
                        maxLogRange: Number(process.env.ROBINHOOD_SCAN_LOG_RANGE ?? 500_000), log: (m: string) => console.log(m),
                        v4: RH_V4_SCAN ? { stateView: ROBINHOOD_V4.STATE_VIEW, poolManager: ROBINHOOD_V4.POOL_MANAGER } : undefined,
                        chunked: STALL_FIX_SCAN_EXPAND, paced: REBUILD_PACED };
                  // Gentle lane on the free node (see robinhoodScanProvider).
                  const res = await scanUniverse(robinhoodScanProvider, RH_EXTRA_VENUES ? [...ROBINHOOD_SCAN_FACTORIES, ...extraScanFactories()] : ROBINHOOD_SCAN_FACTORIES, scanOpts, scanState);
                  // Progress per factory is saved even if some failed.
                  if (res.errors.length && !res.candidates.length) { await saveScanState(scanState); throw new Error(`scan failed: ${res.errors.join('; ').slice(0, 150)}`); }
                  await saveScanState(scanState);
                  const top = res.candidates.slice(0, SCAN_TOP);
                  // Status page: how many picked pairs V4 helped (a V4 pool among their deep pools).
                  if (res.v4) console.log(`[scan] v4: ${top.filter((c) => c.pools.some((p) => p.kind === 'v4')).length} of ${top.length} picked pairs have a deep V4 pool (asked V4 about ${res.v4.pairsAsked} pairs, found ${res.v4.found} pools)`);
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
                  try { onScanDone(); } catch { /* a listener problem must not fail the scan */ }
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
                  const pools = STALL_FIX_SCAN_EXPAND ? await runSteps(stateToPoolsSteps(st), 'scan pool list') : timed('scan pool list', () => stateToPools(st));
                  const n = await timedAsync('cross-quote setup', () => crossQuote.setup(pools, Number(process.env.CROSS_QUOTE_TOKENS ?? 60), undefined, { paced: REBUILD_PACED }));
                  console.log(`[openwatch] watching ${n} tokens that trade against both USDG and ETH`);
            } catch (err) { console.warn('[openwatch] setup failed:', (err as Error).message); }
      };
      setTimeout(() => { void setupCrossQuote(); }, 90_000);
      setInterval(labelled('cross-quote setup', () => { void setupCrossQuote(); }), 6 * 60 * 60_000);
      let lastCrossTick = 0;
      let crossBusy = false;
      // Oct 14 (freeze phase 1): this watch only MEASURES (it never trades).
      // Outside the market-open window it now samples every CROSS_QUOTE_REST_MS
      // (default 60 s, was 15 s); the open window keeps every 5 s. Its maths
      // runs in small bites (CROSS_QUOTE_CHUNKED=0: one go, old behaviour).
      const CROSS_QUOTE_REST_MS = Number(process.env.CROSS_QUOTE_REST_MS ?? 60_000);
      const CROSS_QUOTE_CHUNKED = process.env.CROSS_QUOTE_CHUNKED !== '0';
      setInterval(labelled('cross-quote monitor', async () => {
            const t = toronto();
            const inOpen = t.weekday && t.mins >= OPEN_FROM && t.mins < OPEN_TO;
            if (crossBusy || Date.now() - lastCrossTick < (inOpen ? 5_000 : CROSS_QUOTE_REST_MS)) return;
            crossBusy = true; lastCrossTick = Date.now();
            try { await timedAsync('cross-quote monitor', () => (CROSS_QUOTE_CHUNKED ? crossQuote.tickChunked(inOpen, t.date) : crossQuote.tick(inOpen, t.date))); } catch { /* node busy: next tick */ } finally { crossBusy = false; }
      }), 1_000);
      // One line an hour for the status page: biggest after-fee gap today.
      setInterval(labelled('market-open watch log', () => {
            const top = crossQuote.rows()[0];
            if (top) console.log(`[openwatch] ${crossQuote.tokenCount()} tokens; biggest gap today ${top.symbol}: open ${top.open.maxGapPct.toFixed(2)}% (after fees ${top.open.samples ? top.open.maxNetPct.toFixed(2) : 'n/a'}%), rest of day ${top.rest.maxGapPct.toFixed(2)}%`);
      }), 60 * 60_000);
      const OPEN_REPORT_FILE = 'data/open-report.json';
      setInterval(labelled('market-open report', async () => {
            const t = toronto();
            if (!t.weekday || t.mins < OPEN_REPORT || t.mins > OPEN_REPORT + 30) return;
            let last = '';
            try { last = JSON.parse(readFileSync(OPEN_REPORT_FILE, 'utf8')).date ?? ''; } catch { /* first time */ }
            if (last === t.date) return;
            try {
                  writeFileSync(OPEN_REPORT_FILE, JSON.stringify({ date: t.date }));
                  await sendTelegramMessage(formatMarketOpenReport({ dateLabel: t.date, tokens: crossQuote.tokenCount(), rows: crossQuote.rows() }));
            } catch (err) { console.error('[telegram] market open report failed:', err); }
      }), 60_000);
      setInterval(labelled('pool scan', () => { void runRobinhoodScan(); }), 6 * 60 * 60_000);

      // ---- Measurement only (Oct 8): new pools, coin groups, loops --------
      // All three read through the gentle scan lane on the free node (see
      // robinhoodScanProvider), never the price-read path, and never trade.
      let rhScanCallMany: ((calls: { target: string; data: string }[]) => Promise<(string | null)[]>) | null = null;
      const scanCallMany = async (calls: { target: string; data: string }[]) => {
            rhScanCallMany ??= (await makeCaller(robinhoodScanProvider)).callMany;
            return rhScanCallMany(calls);
      };

      // LOOP TRADER EXTRA SINGLE POOLS (core/loopExtraPools.ts, docs/LOOP_TRADER.md).
      // Only when LOOP_TRADER=1 (LOOP_EXTRA_POOLS=0 forces it off). Picks up to
      // LOOP_EXTRA_POOLS_MAX (300) single-pool pairs with $10k+ that can sit on
      // a 3-5 pool loop through WETH/USDG, and keeps their prices fresh for the
      // LOOP FINDER ONLY: the block reader applies their events (no extra
      // requests) and one bundled re-read every 20 s on this gentle scan lane.
      // They never join the pair watcher's list, so the 2-pool gap scanner
      // and back-run planner never see them.
      if (loopExtraCfg.enabled) {
            const usdRhExtra = (t: string) => priceOracle.getUsdPrice('robinhood', t);
            loopExtra = new LoopExtraPools(loopExtraCfg, {
                  bases: [ROBINHOOD_TOKENS.WETH, ROBINHOOD_TOKENS.USDG],
                  getPool: (k) => cache.get('robinhood', k),
                  cachePools: () => cache.allForChain('robinhood'),
                  watchedPools: () => robinhoodWatcher.watchedPairPools(),
                  // The scan's saved pool list (tokens + pool address only, no prices),
                  // read straight from the scan state while the picker loops over it.
                  // Memory: no second copy of the 100k+ pool list is kept any more.
                  scanPools: () => scanPoolRefs(scanState ?? loadScanState()),
                  // The scan state itself, for the compact index (STALL_FIX_EXTRA_PICK).
                  // Loaded once and kept (the chain-wide scan keeps it too).
                  scanState: () => (scanState ??= loadScanState()),
                  depthUsd: (p) => poolDepthUsd(p, decimalsOf, usdRhExtra),
                  usdOf: usdRhExtra,
                  decimalsOf: (t) => TOKEN_DECIMALS.robinhood?.[t.toLowerCase()],
                  // Pools used by rival loop wins in the last 24 h (memory only).
                  rivalPools: () => rivalWatch.loopRoutePools(Date.now() - 24 * 3600_000),
                  callMany: scanCallMany,
                  lookupPair: (a, b, cm) => robinhoodWatcher.lookupPair(a, b, cm),
                  readStates: (pools, cm) => refreshPoolsBatch(cm, pools),
                  writeState: (fresh, startedMs) => cache.upsertIfNotNewer(fresh, startedMs),
                  now: Date.now,
                  log: (m) => console.log(m),
            });
            loopExtra.start();
            onScanDone = () => loopExtra?.noteScanUpdated();
            console.log(`[loop] extra single pools ON (loop finder only): up to ${loopExtraCfg.maxSelected}, re-read every ${Math.round(loopExtraCfg.refreshMs / 1000)} s, first pick in 3 min`);
      }

      // REAL V3 BALANCES (core/v3BalanceBook.ts, Phase 1 fix): every 10 min,
      // one bundled read of the coins each cached V3 pool really holds, so the
      // price oracle stops treating narrow-band pools as deep. Scan lane only,
      // never the trading path. First read 2 min after start.
      const v3Balances = new V3BalanceBook();
      // Oct 13: start with the balances saved before the restart (up to 1 h
      // old), so the thin-pool filter works right away, not after 2 min.
      console.log(`[oracle] real V3 balances loaded from disk: ${v3Balances.load(V3_BALANCES_FILE)}`);
      priceOracle.useBalances(v3Balances);
      // Oct 13 (USDG/NVDA): the depth filter and the standing-gap scanner use
      // the same real balances, so a pool counts only as deep as the coins
      // really in it (core/poolPrice.ts "REAL BALANCE CAP").
      setRealBalanceSource((pool, token) => v3Balances.get(pool, token));
      const refreshV3Balances = async () => {
            try {
                  const n = await timedAsync('v3 balance refresh', () => v3Balances.refresh(scanCallMany, cache.allForChain('robinhood')));
                  console.log(`[oracle] real V3 balances read: ${n}`);
                  void timedAsync('v3 balance save', () => v3Balances.save(V3_BALANCES_FILE)); // for a fast restart (atomic write)
                  // Status page: pools whose price maths says "deep" but whose
                  // real coins don't (left out of gaps and checks). Top 3 shown.
                  const usdThin = (t: string) => priceOracle.getUsdPrice('robinhood', t);
                  const thin = REPORT_CHUNKED
                        ? await runSteps(thinPoolsSteps(cache.allForChain('robinhood'), decimalsOf, usdThin), 'thin pool check')
                        : timed('thin pool check', () => thinPools(cache.allForChain('robinhood'), decimalsOf, usdThin));
                  markStretch('thin pool check');
                  const k = (x: number) => (x >= 1000 ? `$${Math.round(x / 1000)}k` : `$${Math.round(x)}`);
                  console.log(`[thinpools] ${thin.length} pool(s) left out (looked deep, real coins under $${Math.round(POOL_MIN_DEPTH_USD / 1000)}k)` +
                        (thin.length ? `: ${thin.slice(0, 3).map((t) => `${symbolOf('robinhood', t.pool.tokenA)}/${symbolOf('robinhood', t.pool.tokenB)} ${t.pool.dex} ${(t.pool.feePips ?? t.pool.feeBps * 100) / 10_000}% ${k(t.realUsd)} real vs ${k(t.virtualUsd)} assumed`).join(' · ')}` : ''));
            } catch (err) { console.warn('[oracle] V3 balance read failed (kept old values):', (err as Error).message); }
      };
      setTimeout(() => { void refreshV3Balances(); }, 2 * 60_000);
      setInterval(labelled('v3 balance refresh', () => { void refreshV3Balances(); }), 10 * 60_000);

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
      setInterval(() => { void timedAsync('new pool watch', () => newPoolWatch.poll()); }, Number(process.env.NEW_POOL_POLL_MS ?? 60_000));
      setInterval(() => timed('new pool watch save', () => newPoolWatch.save(NEW_POOLS_FILE)), 10 * 60_000);
      newPoolWatchRef = newPoolWatch;

      // COIN GROUPS (core/tokenGroups.ts): dollar coins, ETH, Bitcoin
      // versions, verified copies. Names only make a candidate; verified =
      // $10k+ pool against USDG/WETH and price within 2% of the group.
      // Saved to data/token-groups.json, printed on the status page.
      const GROUPS_FILE = 'data/token-groups.json';
      const SYMBOLS_FILE = 'data/token-symbols.json';
      let tokenGroups: TokenGroupsResult | null = loadTokenGroups(GROUPS_FILE);
      if (tokenGroups) console.log(`[groups] ${groupsStatusLine(tokenGroups)} (saved list)`);
      // Other-stablecoin counter: learn aUSD/UUSD/USDe addresses from the verified "Dollars" group.
      stableTally.addFromGroups(tokenGroups?.members);

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
                  const pools = STALL_FIX_SCAN_EXPAND ? await runSteps(stateToPoolsSteps(st), 'scan pool list') : timed('scan pool list', () => stateToPools(st));
                  if (!pools.length) { console.log('[groups] no pool scan yet; will try again later'); return; }
                  if (rebuildGroups || !tokenGroups) {
                        tokenGroups = await timedAsync('coin groups build', () => buildTokenGroups({
                              callMany: scanCallMany, state: st, pools,
                              usdg: ROBINHOOD_TOKENS.USDG, weth: ROBINHOOD_TOKENS.WETH,
                              symbolCacheFile: SYMBOLS_FILE, outFile: GROUPS_FILE, log: (m) => console.log(m),
                              // Short breaks in the long walks over every pool/coin (same switch as the scan's pool list).
                              paced: STALL_FIX_SCAN_EXPAND,
                              // Coin names file read / written in bites (REBUILD_PACED=0: one go).
                              rebuildPaced: REBUILD_PACED,
                        }));
                        stableTally.addFromGroups(tokenGroups?.members); // new list: refresh the coin addresses
                  }
                  const quotes = tokenGroups!.members.map((m) => ({ token: m.token, symbol: m.symbol, group: m.group, priceUsd: m.priceUsd }));
                  const n = await timedAsync('loop monitor setup', () => loopMonitor.setup(pools, quotes, Number(process.env.LOOP_TOKENS ?? 80), undefined, { paced: REBUILD_PACED }));
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
      setInterval(labelled('loop monitor setup', () => { void setupLoops(true); }), 6 * 60 * 60_000);
      let loopBusy = false;
      let loopErrors = 0;
      setInterval(async () => {
            if (loopBusy) return;
            loopBusy = true;
            try { await timedAsync('loop monitor', () => loopMonitor.tick()); } catch (err) {
                  if (++loopErrors % 20 === 1) console.warn('[loops] reading pools failed (will retry):', (err as Error).message);
            } finally { loopBusy = false; }
      }, Number(process.env.LOOP_TICK_MS ?? 30_000));
      setInterval(() => {
            timed('loop monitor save', () => loopMonitor.save(LOOP_STATS_FILE));
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
            setInterval(labelled('monad watch list', checkMonadWatchList), 30_000);
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
      // (Oct 14: written as steps, pausing every 100 pools, so it can run in
      // small bites; samplePricesIntoMatches() runs it in one go as before.)
      function* samplePricesSteps(): Generator<void, void, void> {
            for (const chain of ['avalanche', 'monad', 'robinhood'] as const) {
                  const seenPairs = new Set<string>();
                  let n = 0;
                  for (const pool of cache.allForChain(chain)) {
                        if ((++n % 100) === 0) yield;
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
      }
      const samplePricesIntoMatches = () => drainSteps(samplePricesSteps());

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
      setInterval(labelled('health check', async () => {
            await chainManager.runHealthChecks();
            markStretch('health check');
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
      }), 15_000);

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
                        // Status page reads these two (deploy/status-report.js realisticLines).
                        for (const l of realisticPnl.lines()) console.log(`[pnl-real] ${l}`);
                        console.log(`[stables] ${stableTally.line()}`);
                        note = `watching ${st.pairs} pair${st.pairs === 1 ? '' : 's'}, ${st.pools} pools${tot ? `, ${localPct}% instant prices` : ''}${fireNote}${rivalNote}${gapNote}${liveNote}${rpcNote}${pnlNote}`;
                  }
                  return { chain, spreads, noMatchCount, note };
            });
      };

      let lastDigestAt = Date.now();
      const sendHourlyDigestInner = async () => {
            const now = Date.now();
            try {
                  if (REPORT_CHUNKED) {
                        await runSteps(samplePricesSteps(), 'hourly report');
                        markStretch('hourly report'); // the rest of the build is named too
                  } else samplePricesIntoMatches();
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
                        // Loop numbers: from the loop worker by message when it runs (waits up to 3 s).
                        const loopsHour = await loopHourText();
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
                                    todayBigUsd: pnl.today.bigUsd ?? 0, todayBigCount: pnl.today.bigCount ?? 0, best: pnl.today.best,
                              },
                              // Live-realistic total + what it left out, and the other-stablecoin line (reporting only).
                              realistic: realisticPnl.lines(),
                              otherStables: stableTally.line(),
                              reactionMs: { typical: stats.medianReactionMs, slowest5pct: stats.p95ReactionMs },
                              otherBots: { timed: rv.found, theirMs: rv.theirMedianMs, oursMs: rv.ourMedianMs, weBeat: rv.beatCount },
                              rivalWins: { ...rivalWatch.takeHour(), botsKnown: rivalWatch.botCount(), botsVerified: rivalWatch.botStatus().verified },
                              newPools: hourNewPools ?? undefined,
                              // + any-provider nodes (push reader messages etc.), only when configured.
                              nodeUsage: [...nodeUsageToday(), ...nodeUsageCounter.reportLines()],
                              ourGas: (() => {
                                    const eth = priceOracle.getUsdPrice('robinhood', ROBINHOOD_TOKENS.WETH);
                                    return { ownUsd: robinhoodSender.gasCostUsdFor(OUR_GAS_OWN, eth), flashUsd: robinhoodSender.gasCostUsdFor(OUR_GAS_FLASH, eth) };
                              })(),
                              costsUsed: (() => {
                                    const f = eventFeeCounts(cache.allForChain('robinhood'));
                                    return costsLine(gasModel.twoPool(!RH_OWN_MONEY), gasModel.settings, f.fromEvents, f.waiting, gasModel.staleReason);
                              })(),
                              profitBands: { hour: [...profitBands.hour], day: [...profitBands.day], hourUsd: profitBands.hourUsd, dayUsd: profitBands.dayUsd },
                              simOutcomes: simBuckets.plain(),
                              research: researchHourText(),
                              venueTests: venueTally.hourText() ?? undefined,
                              loops: loopsHour,
                              memory: memReport?.hourLine(),
                              speed: (({ median, p95 }) => ({ median, p95 }))(stageTimers.take('hour')),
                              // Stall finder: freezes this hour and what caused them (core/stallFinder.ts).
                              stalls: (() => { const s = stallFinder.take('hour'); return [formatStallLine(s), formatStallDetail(s)].filter(Boolean); })(),
                              race: raceChecker.takeHour(),
                              funnel: {
                                    tradesRead: funnel.tradesRead, noPool: funnel.noPool, tooSmall: funnel.tooSmall, noPartner: funnel.noPartner,
                                    noUsdPrice: funnel.noUsdPrice, smallerThanFees: funnel.smallerThanFees, found: funnel.found,
                                    belowCheckBar: funnel.belowCheckBar, checkBarUsd: SIM_CHECK_BAR_USD,
                                    notVetted: funnel.notVetted, sentToCheck: funnel.sentToCheck,
                                    skipped: [...funnel.skip.entries()].sort((a, b) => b[1] - a[1]),
                                    // Router V4 formats: shown only when FEED_DECODE_UR_V4 is on (takes + resets the hour).
                                    routerV4: urV4DecodeOn() ? (({ read, notReadable, reasons }) => ({ read, notReadable, topReason: reasons[0]?.[0] }))(takeUrV4Hour()) : undefined,
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
                  // Status page line (deploy/status-report.js), then a fresh hour.
                  console.log(venueTally.statusLine());
                  venueTally.resetHour();
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
      // Building the report is timed by the stall finder too.
      const sendHourlyDigest = () => timedAsync('hourly report', sendHourlyDigestInner);
      setInterval(sendHourlyDigest, 60 * 60 * 1000);
      // Stage timers: where the fire-ready time goes, every 5 min (median, then slowest 5%).
      setInterval(labelled('stall report', () => {
            const sp = stageTimers.take('fiveMin');
            console.log(`[speed] ${sp.median}`);
            console.log(`[speed] ${sp.p95}`);
            // Stall finder: freezes in the last 5 min and what caused them.
            const sf = stallFinder.take('fiveMin');
            // Plus how many gaps the fast scan skipped because prices moved during it.
            console.log(`[stalls] ${formatStallLine(sf)}${gapStaleSkips ? ` · gaps skipped (prices moved during the scan, rescanned): ${gapStaleSkips}` : ''}`);
            gapStaleSkips = 0;
            const sd = formatStallDetail(sf);
            if (sd) console.log(`[stalls] ${sd}`);
            // Rival watch sender look-ups (signature checks) done vs skipped, last 5 min.
            const rs = rivalWatch.takeSenderStats();
            console.log(`[rivalwatch] sender checks (5 min): ${rs.looked} done · skipped: ${rs.knownBot} known bot, ${rs.noOwners} no bot wallets known, ${rs.neverBot} router/pool/coin, ${rs.coinMove} coin transfer/approval, ${rs.dupOrFull} already queued, ${rs.overCap} over the ${process.env.RIVAL_SENDER_MAX_PER_SEC ?? 40}/s limit`);
      }), 5 * 60_000);
      // Watch list size every 15 min (shown on the GitHub status page).
      setInterval(labelled('watch list log', () => {
            const ws = robinhoodWatcher.stats();
            console.log(`[pairs] robinhood watch list: ${ws.pairs} pairs, ${ws.pools} pools (${ws.pinnedWatched}/${ws.pinned} pinned found, ${ws.queued} queued)`);
      }), 15 * 60_000);
      // Hourly memory housekeeping: drop cached pools that aren't in a watched
      // pair, aren't an approved flash lender and haven't been touched for
      // 2 h. They're re-discovered on demand if trades show up again.
      setInterval(labelled('pool prune', () => {
            try {
                  const keep = new Set<string>(robinhoodWatcher.watchedPairPools().flat().map((a) => a.toLowerCase()));
                  for (const c of ['robinhood', 'monad', 'avalanche']) for (const l of approvedLenders(c)) keep.add(l);
                  // The loop trader's extra single pools (when on) stay in the cache too.
                  if (loopExtra) for (const k of loopExtra.keys()) keep.add(k);
                  const removed = cache.prune((p) => keep.has(p.poolAddress.toLowerCase()), 2 * 3600_000);
                  console.log(`[mem] pruned ${removed} idle pools (cache ${cache.size()}, opportunity log ${shadowLogger.size}, heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB)`);
            } catch (err) { console.warn('[mem] prune failed:', (err as Error).message); }
      }), 60 * 60 * 1000);
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
      setInterval(labelled('rival daily report', async () => {
            const t = torontoNow();
            if (t.hour !== RIVAL_DAILY_HOUR) return;
            let last = '';
            try { last = JSON.parse(readFileSync(RIVAL_DAILY_FILE, 'utf8')).date ?? ''; } catch { /* first time */ }
            if (last === t.date) return;
            try {
                  writeFileSync(RIVAL_DAILY_FILE, JSON.stringify({ date: t.date }));
                  await sendRivalDaily();
            } catch (err) { console.error('[telegram] rival daily report failed:', err); }
      }), 60_000);
      // First taste: a rival report 2 hours after start, so you don't wait
      // until tomorrow morning to see the format.
      setTimeout(() => { void sendRivalDaily().catch(() => {}); }, Number(process.env.RIVAL_FIRST_REPORT_MS ?? 2 * 3600_000));

      let lastDailyAt = Date.now();
      setInterval(labelled('daily report', async () => {
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
      }), 24 * 60 * 60 * 1000);

console.log('Shadow mode running. Pool cache size:', cache.size());
console.log('Chain status:', chainManager.getStatus());
}

main().catch((err) => {
console.error('Fatal error in shadow mode:', err);
process.exit(1);
});
