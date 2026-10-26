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
import { findOptimalTradeSize, calculateAllInProfit, buildOpportunity, calculateLiquidityCeiling, roundTripQuote } from './core/profitCalculator';
import { scoreOpportunity, shouldPreArm } from './core/opportunityScorer';
import { planBackrun } from './core/backrunPlanner';
import { seedKnownAddresses } from './config/knownAddresses';
// ethers v5 (needed only by the Kuru SDK on Monad) is loaded further down, only when Monad is on.
import { MONAD_KURU, MONAD_ROUTERS, MONAD_TOKENS, MONAD_BEAN, MONAD_LFJ, MONAD_PANCAKE, ROBINHOOD_PANCAKE, ROBINHOOD_V2, ROBINHOOD_V3, ROBINHOOD_V4, ROBINHOOD_TOKENS, ROBINHOOD_UR_COPIES } from './config/knownAddresses';
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
import { formatSkippedOpportunity, formatHourlyDigest, formatDailyReport, formatStartup, formatExecutionWarning, DigestSection, DigestSpread, PlainHourlyInput, formatPlainDaily, formatRivalDaily, formatMarketOpenReport, formatLoopReport } from './core/telegramFormatter';
import { RobinhoodChainAdapter } from './chains/robinhoodChain';
// FAST CHECK (arbsim sidecar, LOCAL_SIM=off|shadow|on, default off): see docs/FAST_CHECK.md.
import { createLocalSimHost, LocalSimHost, LocalCheck, LocalKind, LocalOutcome } from './execution/localSimHost';
import { TriggerFirst, trigFirstSettings, TrigOutcome } from './execution/triggerFirst';
import { Scoreboard, SendPath, Confidence as ScoreConfidence, standingGapFailBlock, entryFailBlock } from './report/scoreboard';
import { TrigEntry, EntryCandidate, EntryPick, TablePool, entrySettings, enumerateRoutes, rankRoutes } from './execution/trigEntry';
import { EntryLoopIndex, EntryLoop, EntryLoopHost, EntryLoopSender, CoinTaxFileView, LoopScoreMemo, loopIndexSettings, loopQuoteUsd, pickLoops, loopSkipText, askLoopTaxTests } from './execution/trigEntryLoops';
import { hasExactMath } from './core/loopFinder';
import { runCheckFirst } from './execution/checkFirstFlow';
import { MonadAdapter } from './chains/monad';
import { AvalancheAdapter } from './chains/avalanche';
import { RawChainEvent, PoolState, MIN_NET_PROFIT_USD } from './core/types';
import { priceOf, spreadPct, deepEnough, POOL_MIN_DEPTH_USD, realBalanceOf } from './core/poolPrice';
import { PairWatcher, Venue, refreshPoolState, refreshPoolsBatch } from './core/pairWatcher';
import { scanUniverse, emptyScanState, loadScanStateFile, ScanState, stateToPools, stateToPoolsSteps, scanPoolRefs, getLogsAdaptive, RawLog } from './core/universeScan';
import { CrossQuoteMonitor, LoopMonitor, shouldScheduleFirstLoopReport } from './core/crossQuoteMonitor';
import { NewPoolWatch } from './core/newPoolWatch';
import { V4EventDiscovery, V4PoolIndex, setV4EventIndex, makeV4InitGetLogs, countWatchedV4BySource, v4DiscoverConfig } from './core/v4EventDiscovery';
import { buildTokenGroups, loadTokenGroups, groupsStatusLine, TokenGroupsResult } from './core/tokenGroups';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'fs';
import { ROBINHOOD_SCAN_FACTORIES } from './config/knownAddresses';
// Uniswap V4 in the chain-wide scan, asked PER PAIR (core/v4Lookup.ts), not
// from V4's history (that ran out of memory twice on Oct 9). RH_V4_SCAN=0 off.
const RH_V4_SCAN = process.env.RH_V4_SCAN !== '0';
import { buildExecuteCall, executionRequested, executorConfig, pickV3Lender, kindForPool, v4KeyMatchesId, KIND_V4_HOOKED } from './execution/executorCalldata';
import { GasModel, GasCalibration, gasSettingsFromEnv, routeKeyFor, twoPoolKey, defaultUnitsFor, costsLine, loopKey } from './core/gasModel';
import { recordEventFee, eventFeeCounts, feeFromEventsOn, setHeadBlockSource, currentHeadBlock } from './core/eventFees';
import { OwnMoneyBook, useOwnMoney, fitTradeToWallet } from './core/ownMoney';
import { readIncludesTrade } from './core/tradeInclusion';
import { checkFirstOn, waitForTrade, decideCheckFirst, checkLoanPips, extraLoanFeeUsd } from './core/checkFirst';
import { WhyNotSent, formatWhyNotSent } from './report/whyNotSent';
import { BlockReader, PoolUpdate } from './core/blockReader';
import { AutoVet, CheckOutcome } from './core/autoVet';
import { FailTally } from './core/failReasons';
import { LenderBalances } from './core/lenderBalances';
import { RouteScores, WinSizes, WIN_BARS, LiveRouteBlock } from './core/routeScore';
import { readOutlierConfig, isOutlier, confirmOutlier, withDeadline, OutlierVerdict } from './core/outlierGuard';
import type { ExecutorHop } from './execution/executorCalldata';
import { RivalWatch } from './core/rivalWatch';
import { V3BalanceBook, V3_BALANCES_FILE } from './core/v3BalanceBook';
import { extraWatcherVenues, extraScanFactories, isExecutableVenue, canPracticeTestVenue, reportedVenueIds, venueShortName, setTestedVenuesLive } from './config/robinhoodVenues';
import { practiceOnlyReason, V4_LOOKUP_TIERS } from './config/v4Tiers';
import { LiveCoinRule } from './core/liveCoins';
import { checkDeployedContract } from './execution/contractMatch';
import { VenueTally } from './core/venueTally';
// Practice-test a pool: exchanges we trade, plus extra venues that passed the
// executor fork test (config/robinhoodVenues.ts canPracticeTestVenue). Fables
// stays watch-only until its practiceTested run is recorded there. Real
// trades still need isExecutableVenue (fireTrade refuses everything else).
const canPracticeTest = (dex: string) => canPracticeTestVenue(dex);
// Why live trading would refuse a trade through these two pools, or null if
// it could take it: an exchange not cleared for trading, or a pool that is
// practice only (Uniswap V4 at a non-standard setting, config/v4Tiers.ts).
// Used by the live send (fireTrade) and by "could earn live" so the two agree.
// Oct 17: plus the live coin rule (core/liveCoins.ts, no meme coins) for
// Robinhood trades.
let liveCoins: LiveCoinRule | null = null; // set once the Robinhood read node exists
const liveBlocker = (buy: { dex?: string; v4?: any; chain?: string; tokenA?: string; tokenB?: string } | undefined,
      sell: { dex?: string; v4?: any; chain?: string; tokenA?: string; tokenB?: string } | undefined): string | null => {
      if (!isExecutableVenue(buy?.dex ?? '') || !isExecutableVenue(sell?.dex ?? '')) return `exchange not cleared for trading (${buy?.dex} / ${sell?.dex})`;
      const po = practiceOnlyReason(buy ?? {}) ?? practiceOnlyReason(sell ?? {});
      if (po) return po;
      if (liveCoins && (buy?.chain === 'robinhood' || sell?.chain === 'robinhood')) {
            const coins = [buy?.tokenA, buy?.tokenB, sell?.tokenA, sell?.tokenB].filter((t): t is string => !!t);
            return liveCoins.blocker([...new Set(coins.map((t) => t.toLowerCase()))]);
      }
      return null;
};
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
import { makeRpc, simulateRoundTrip, simulateWithRecheck, simRpcUrl, Rpc, makeFallbackRpc, loadBalanceSlots, wssToHttps, replayRpc, ReplayCall, SimResult } from './execution/simulator';
import { FastSender, SafetyGate, safetyConfigFromEnv } from './execution/fastSender';
import { DEFAULT_FILTER_CONFIG } from './core/fastFilter';
import { checkLiveReady } from './execution/liveReadiness';
import { LiveTradeTracker, Funding } from './execution/liveTracker';
import { LiveTradeLog } from './execution/liveTradeLog';
import { SafetyAlerts } from './execution/safetyAlerts';
import { AlertHooks } from './report/alertHooks';
import { getHeapStatistics } from 'v8';
import { findStandingGaps, findStandingGapsSteps, GapScanMemo, gapScanEnabled } from './core/gapScanner';
import { CompetitorTracker } from './core/competitorTracker';
import { pickRobinhoodReadRpc, robinhoodSendRpc, redact, ROBINHOOD_PUBLIC_RPC } from './config/robinhoodEndpoints';
import { loadStartPairs, saveStartPairs } from './core/seedPairs';
import { DryRunPnl } from './core/dryRunPnl';
import { RealisticPnl, readStartCoins, WinFacts } from './core/realisticPnl';
import { StableTally, parseStableEnv } from './core/stableTally';
// Hourly report version 2 (Oct 15, reporting only): money ledgers, the new
// plain hourly message and the 4-hour accumulator (src/report/).
import { MoneyLedgers, RealMoneyLedger, hourMoneyOf } from './report/ledgers';
import { hourlyMessage, reportV2On, HourlyReportInput, FULL_HOUR_MIN_MS, overallVerdict, esc as escHtml } from './report/hourlyReport';
import { liveLayoutOn, LiveTradeBook, WalletWatch, formatLiveTrade, formatLiveHourly, formatLive4h, gasLowSpec, walletChangedSpec } from './report/liveTelegram';
import { FailoverJsonRpcProvider } from './core/failoverRpc';
import { LeanJsonRpcProvider } from './core/leanRpc';
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
import { LoopTrader, loopConfigFromEnv, LoopCheckResult, LoopTrade, buildLoopTrade } from './core/loopTrader';
// Which node loop practice checks run on (LOOP_CHECK_NODE, default the free public node).
import { CoinTaxBook, coinTaxConfigFromEnv, testCoinTax, coinHolderOf } from './core/coinTax';
import { LoopLiveSender, loopLiveConfigFromEnv, LoopLiveCandidate } from './execution/loopLive';
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
import { FreezeProfiler } from './core/freezeProfile';
import { runSteps, drainSteps, writeJsonChunkedQueued, setSliceCap, SlicedQueue, TurnQueue } from './core/chunked';
// 4-HOUR REPORT (reporting only): 4-hour totals of the hourly numbers, and the 3-message formatter.
import { FourHourStats, HourSample, LoopSample, loopSampleFrom, fourHourMark, zonedParts } from './report/fourHourStats';
import { formatFourHourReport, FourHourSnapshot } from './report/fourHourReport';
import { FAIL_GROUP_LABEL } from './core/failReasons';
import { readMemNotes } from './core/memReport';
import type { StageSummary } from './core/stageTimer';
import type { StallSummary } from './core/stallFinder';
import { killSwitchOn } from './execution/fastSender';
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
// FREEZE PROFILE (core/freezeProfile.ts, Oct 23): after repeated long
// freezes, a 5 s CPU profile is recorded (at most every 30 min) and its top
// 10 functions logged as one "[freeze-profile]" line. FREEZE_PROFILE=0 = off.
{
      const fp = new FreezeProfiler();
      if (fp.s.enabled && stallFinder.enabled) {
            stallFinder.onStall((ms) => { try { fp.noteFreeze(ms); } catch { /* measurement only */ } });
            console.log(`[freeze-profile] on: a ${fp.s.seconds} s CPU profile after ${fp.s.count} freezes over ${fp.s.freezeMs} ms within ${fp.s.windowMs / 1000} s (at most every ${fp.s.everyMs / 60_000} min, newest ${fp.s.keep} kept in ${fp.s.dir})`);
      }
}
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
                  // Lean request / answer handling (core/leanRpc.ts): same bytes, less throw-away memory.
                  return new LeanJsonRpcProvider(req, 4663, { staticNetwork: true, batchMaxCount: 1 });
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
// Practice-test node names (never URLs), for the 4-hour report's connections section.
let checkNodeLabel: string | null = null;
// Robinhood's free public node, used to DOUBLE-CHECK a trade the checking node
// (QuickNode) says breaks with no reason. Oct 7: QuickNode reverted every
// Ramses V3 check while the free node and fork tests ran the same trade fine.
// Metered by its node budget (8/s), and only used for those few re-checks.
const rhFreeSimRpc: Rpc = makeRpc('https://rpc.mainnet.chain.robinhood.com');
// FAST CHECK host (execution/localSimHost.ts). null = LOCAL_SIM off (the
// default): then none of the fast-check code below does anything at all.
// Created where the Robinhood feed is set up (search "FAST CHECK: start").
let localSim: LocalSimHost | null = null;
// TRIGGER-FIRST (execution/triggerFirst.ts): our trade checked right after the
// trigger the moment the feed shows it. null = LOCAL_SIM_TRIGGER_FIRST off (the
// default) or no fast check: nothing at all happens.
let trigFirst: TriggerFirst | null = null;
// TRIGGER-FIRST ENTRY POINT (execution/trigEntry.ts): every feed transaction
// checked as a possible trigger, ahead of the old model guess and the 6 h
// lists. Created with trigFirst (TRIG_FIRST_ENTRY=1, the default).
let trigEntry: TrigEntry | null = null;
// COPY 2: the pool keys (addresses / V4 ids) the block readers follow. The
// block reader setup replaces this with its own list; until then: watched pairs.
let copy2PoolKeys: () => string[] = () => robinhoodWatcher.watchedPairPools().flat();
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
            checkNodeLabel = built.description;
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
            checkNodeLabel = `${qn ? 'QuickNode' : source}${fallback ? ' (backup: Alchemy)' : ' (no backup)'}`;
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
// WHY NOT SENT (report/whyNotSent.ts, Oct 20): every 10 min, one line in the log
// and (live layout) Telegram: chances that reached the send step, how many were
// sent, and why the rest stopped. Quiet when nothing happened. Reporting only.
const whyNotSent = new WhyNotSent();
const WHY_NOT_SENT_MIN = 10;
setInterval(() => {
      try {
            const line = formatWhyNotSent(whyNotSent.take(), WHY_NOT_SENT_MIN);
            if (!line) return;
            console.log(`[why-not-sent] ${line}`);
            if (robinhoodSender.live && LIVE_LAYOUT && process.env.WHY_NOT_SENT_TELEGRAM !== '0') void sendTelegramMessage(`🟢 LIVE · ${escHtml(line)}`).catch(() => undefined);
      } catch { /* reporting only */ }
}, WHY_NOT_SENT_MIN * 60_000);
// Check first, then send (core/checkFirst.ts): what happened to live "follow a
// trade" sends in the last 10 min (passed = sent after a winning real check).
const checkFirstStats = { passed: 0, refused: 0, noLanding: 0, ms: [] as number[], waitMs: [] as number[], checkMs: [] as number[] };
// How often check-first asks "has the followed trade landed?" (ms). Was 150.
const CHECK_FIRST_POLL_MS = Math.max(20, Number(process.env.CHECK_FIRST_POLL_MS ?? 50));
setInterval(() => {
      const s = checkFirstStats;
      if (s.passed || s.refused || s.noLanding) {
            const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
            console.log(`[check-first] last 10 min: sent ${s.passed}, refused by the real check ${s.refused}, followed trade not landed in time ${s.noLanding} (median wait+check ${median(s.ms)} ms = wait ${median(s.waitMs)} + check ${median(s.checkMs)})`);
      }
      s.passed = s.refused = s.noLanding = 0; s.ms = []; s.waitMs = []; s.checkMs = [];
}, 10 * 60_000);
// Double-count guard counters (logged every 10 min): fresh reads that already
// had the followed trade in them vs reads still from before it.
const tradeInclusionStats = { included: 0, notYet: 0 };
setInterval(() => { if (tradeInclusionStats.included || tradeInclusionStats.notYet) console.log(`[double-count] last 10 min: fresh read already had the trade ${tradeInclusionStats.included}x (not applied again), still before it ${tradeInclusionStats.notYet}x`); tradeInclusionStats.included = tradeInclusionStats.notYet = 0; }, 10 * 60_000);
// LIVE ROUTE BLOCK (core/routeScore.ts, Oct 19): one failed/losing real check
// or one failed live trade on a pool pair stops REAL sends on it for 6 h.
const liveBlocks = new LiveRouteBlock();
const LIVE_BLOCK_FILE = 'data/live-blocks.json';
{ const n = liveBlocks.load(LIVE_BLOCK_FILE); if (n) console.log(`[live-block] restored ${n} blocked pool pairs`); }
setInterval(() => timed('live blocks save', () => liveBlocks.save(LIVE_BLOCK_FILE)), 5 * 60_000);
// Live trade hash -> its two pools, so a failed live trade can block its pair.
const livePools = new Map<string, [string, string]>();
// STANDING-GAP FAIL BLOCK (Oct 23): standing gaps ignore liveBlocks by design
// (each one is sent right after its own fresh real check, see fireTrade).
// But a standing gap whose LIVE trade failed on chain is usually still
// "there" on the next scan (a price we can't really trade), so it would be
// sent again and again, paying gas each time. After a live on-chain fail,
// that pool pair is not sent live as a standing gap for
// GAP_LIVE_FAIL_BLOCK_MIN minutes (default 30; 0 = off). Not saved to disk.
// FIRE_FIRST_ONLY=1: only the trigger-first entry point sends real trades (see the send step).
const FIRE_FIRST_ONLY = ['1', 'true', 'on', 'yes'].includes((process.env.FIRE_FIRST_ONLY ?? '').trim().toLowerCase());
// GAP_LIVE_WITH_FIRE_FIRST=1: with FIRE_FIRST_ONLY, standing gaps may send too (see the send step).
const GAP_LIVE_WITH_FIRE_FIRST = ['1', 'true', 'on', 'yes'].includes((process.env.GAP_LIVE_WITH_FIRE_FIRST ?? '').trim().toLowerCase());
if (FIRE_FIRST_ONLY && GAP_LIVE_WITH_FIRE_FIRST) console.log('[live] standing gaps may send too (GAP_LIVE_WITH_FIRE_FIRST=1)');
if (FIRE_FIRST_ONLY) console.log('[live] FIRE-FIRST ONLY (FIRE_FIRST_ONLY=1): older paths check but never send real trades');
// MAIN-BOT DIET (Oct 26, core/gapScanner.ts gapScanEnabled): the gap scan
// is ~29% of the main bot's work; it is skipped when gaps can't send.
const GAP_SCAN_ON = gapScanEnabled();
if (!GAP_SCAN_ON) console.log('[live] standing-gap scan OFF (gaps cannot send: FIRE_FIRST_ONLY=1, GAP_LIVE_WITH_FIRE_FIRST=0; GAP_SCAN=1 forces it on)');
const GAP_LIVE_FAIL_BLOCK_MIN = Math.max(0, Number(process.env.GAP_LIVE_FAIL_BLOCK_MIN ?? 30) || 0);
const gapFailBlocks = new LiveRouteBlock(GAP_LIVE_FAIL_BLOCK_MIN * 60_000);
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
// 4-HOUR REPORT (reporting only, REPORT_V2=1 by default; 0 = no 4-hour report).
// Keeps 4-hour totals of the hourly numbers plus each win as it is counted,
// saved to data/report-4h.json so a restart keeps them. Never touches trading.
const REPORT_4H_ON = reportV2On(process.env);
const fourHour: FourHourStats | null = REPORT_4H_ON ? new FourHourStats('data/report-4h.json', Date.now, process.env.REPORT_4H_TZ || 'America/Toronto') : null;
if (fourHour) setInterval(() => timed('4h report save', () => fourHour.save()), 60_000);
// Read-only facts the 4-hour report shows, filled in further down where they exist.
let lastLoopSample: LoopSample | null = null;        // the loop trader's last hour (set when the hourly code takes it)
let lastThinPoolCount: number | null = null;         // pools left out as thin at the last check
let wsReaderRef: WsBlockReader | null = null;        // the push block reader, when set up
let blockReaderStats: (() => { errors: number; rateLimited: number }) | null = null;
// Pool kind for the parts check: 'v4', 'v3', 'v2', or the pool type.
const poolKind = (p: PoolState): string => (p.v4 ? 'v4' : p.poolType);
// Reporting must never break the money path: any error in it is ignored.
const report4h = (fn: () => void) => { try { fn(); } catch { /* reporting only */ } };
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
            report4h(() => fourHour?.noteOutlierBlocked(netUsd));
            return false;
      }
      const v = await confirmRhOutlier(trade.tokenIn, trade.hops, trade.amountIn, trade.profit, trade.v3Lender, trade.blockTag);
      if (v.ok) { console.log(`[outlier] ${label} $${netUsd.toFixed(2)} on $${Math.round(sizeUsd)}: ${v.detail}, counted`); return true; }
      funnelSkip('outlier profit, not counted (too good to be true, see [outlier] log)');
      report4h(() => fourHour?.noteOutlierBlocked(netUsd));
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
      // sizeUsd (fast check size search only): a smaller trade size that makes
      // more; the trade should be sent at this size. Never bigger than asked.
      | { status: 'profit'; usd: number; loanPips: number; trade: { tokenIn: string; hops: ExecutorHop[]; amountIn: bigint; profit: bigint; v3Lender?: string }; sizeUsd?: number }
      | { status: 'loss' | 'fail' | 'skipped'; reason: string }
      | { status: 'rate_limited' };
// The exact trade a check runs (same build for the node and the fast check).
type BuiltCheck = {
      decimals: number; lender: ReturnType<typeof pickLender>;
      trade: { token: string; amountIn: bigint; hops: ExecutorHop[] };
      simOpts: { v3Lender?: string; weth?: string };
};
const buildCheck = (
      chain: 'avalanche' | 'monad' | 'robinhood', tokenIn: string,
      buyPool: any, sellPool: any, tradeSizeUsd: number, usdPerToken: number,
): BuiltCheck | { skip: string } => {
      const decimals = TOKEN_DECIMALS[chain]?.[tokenIn.toLowerCase()];
      if (decimals === undefined) return { skip: 'unknown decimals' };
      // Same lender choice as a live trade (approved FLASH_LENDERS only), so a
      // "confirmed" profit is priced with the loan fee a real trade would pay.
      const lender = pickLender(chain, tokenIn, buyPool, sellPool, tradeSizeUsd, usdPerToken);
      const built = buildExecuteCall({
            chain, tokenIn, buyPool, sellPool, tradeSizeUsd, netProfitUsd: 1,
            usdPerTokenIn: usdPerToken, tokenInDecimals: decimals, maxBlock: 0n,
            v3Lender: lender?.poolAddress,
      });
      if ('reason' in built) return { skip: built.reason };
      return {
            decimals, lender, trade: { token: tokenIn, amountIn: built.amountIn, hops: built.hops },
            simOpts: { v3Lender: lender?.poolAddress, weth: chain === 'robinhood' ? ROBINHOOD_TOKENS.WETH : undefined },
      };
};

// ==========================================================================
// FAST CHECK hooks (execution/localSimHost.ts; LOCAL_SIM=off|shadow|on).
//   off:    localSim is null, every helper here does nothing.
//   shadow: the fast check runs alongside the node check, is compared and
//           logged; the node's answer is the one used (unchanged).
//   on:     a SURE fast answer is used; "unknown" -> the node, as today.
//           1 in 10 fast decisions is re-checked with the node afterwards
//           (background), which can switch the fast check back to practice.
// ==========================================================================
// at: which state to ask about (copy 2: right after block N); left out = as before.
type FastAsk = { kind: LocalKind; triggerHash?: string; seenMs?: number; label?: string; existing?: LocalCheck | null; at?: Record<string, unknown> };
// Starts a fast check for this trade (Robinhood only). null = off / not possible.
const startFastCheck = (ask: FastAsk, b: BuiltCheck): LocalCheck | null => {
      if (!localSim) return null;
      try {
            return localSim.begin({ kind: ask.kind, trade: b.trade, simOpts: b.simOpts, at: ask.at, triggerHash: ask.triggerHash, seenMs: ask.seenMs ?? localSim.seenMsOf(ask.triggerHash), label: ask.label });
      } catch { return null; }
};
// COPY 2 (execution/copy2.ts): the pools a check touches, for the "is every
// pool ready" rule: both trading pools (V4: their pool ids) and the loan pool.
const routeKeys = (buyPool: any, sellPool: any, lender?: { poolAddress?: string } | null): string[] =>
      [buyPool?.poolAddress, sellPool?.poolAddress, lender?.poolAddress].filter((k): k is string => typeof k === 'string' && k.length > 0);
// The block a copy-2 fast check was asked about ({block:"0x.."}), if any:
// its node re-check then runs on that same block, so both answer the same question.
const fastBlockTag = (lc: LocalCheck): string | undefined => {
      const b = (lc.q.at as { block?: unknown } | undefined)?.block;
      return typeof b === 'string' && /^0x[0-9a-f]+$/i.test(b) ? b : undefined;
};
// A SURE fast answer -> the same result the node path gives (on mode).
const fastToCheck = async (lc: LocalCheck, lo: LocalOutcome, b: BuiltCheck, tokenIn: string, tradeSizeUsd: number, usdPerToken: number): Promise<RoundTripCheck> => {
      const r = lo.sim;
      simBuckets.add(r.bucket ?? classifySimOutcome(r.status, 'reason' in r ? r.reason : ''));
      const loanPips = b.lender ? (b.lender.feePips ?? b.lender.feeBps * 100) : 0;
      if (r.status === 'profit') {
            if (!plausibleProfit(r.profit, b.trade.amountIn)) return { status: 'fail', reason: 'implausible profit (bad token or pool data)' };
            // Size search: the best size at or below the one asked (caps / wallet fit already applied).
            const better = localSim ? await localSim.sizeSearch(lc) : null;
            if (better && plausibleProfit(better.profit, better.amountIn)) {
                  const sizeUsd = tradeSizeUsd * Number(better.amountIn) / Number(b.trade.amountIn);
                  return { status: 'profit', usd: (Number(better.profit) / 10 ** b.decimals) * usdPerToken, loanPips, sizeUsd,
                        trade: { tokenIn, hops: b.trade.hops, amountIn: better.amountIn, profit: better.profit, v3Lender: b.lender?.poolAddress } };
            }
            return { status: 'profit', usd: (Number(r.profit) / 10 ** b.decimals) * usdPerToken, loanPips,
                  trade: { tokenIn, hops: b.trade.hops, amountIn: b.trade.amountIn, profit: r.profit, v3Lender: b.lender?.poolAddress } };
      }
      if (r.status === 'loss') return { status: 'loss', reason: 'ends with less than it started' };
      return { status: 'fail', reason: 'reason' in r ? r.reason : 'fast check: fails' };
};
// TRIGGER-FIRST: a SURE answer -> the same result the node path gives (null =
// unknown: the existing path decides). Same rules as fastToCheck, but NO size
// search: a size search would run without the feed replay (another state).
const trigToCheck = (out: TrigOutcome, b: BuiltCheck, tokenIn: string, usdPerToken: number): RoundTripCheck | null => {
      if (!out.sure) return null;
      const r = out.sim;
      simBuckets.add(r.bucket ?? classifySimOutcome(r.status, 'reason' in r ? r.reason : ''));
      const loanPips = b.lender ? (b.lender.feePips ?? b.lender.feeBps * 100) : 0;
      if (r.status === 'profit') {
            if (!plausibleProfit(r.profit, b.trade.amountIn)) return { status: 'fail', reason: 'implausible profit (bad token or pool data)' };
            return { status: 'profit', usd: (Number(r.profit) / 10 ** b.decimals) * usdPerToken, loanPips,
                  trade: { tokenIn, hops: b.trade.hops, amountIn: b.trade.amountIn, profit: r.profit, v3Lender: b.lender?.poolAddress } };
      }
      if (r.status === 'loss') return { status: 'loss', reason: 'ends with less than it started' };
      return { status: 'fail', reason: 'reason' in r ? r.reason : 'trigger-first check: fails' };
};
// On mode: re-check 1 in N fast decisions with the node, in the background
// (never waited for; its answer only feeds the agreement counter). Follow-a-
// trade checks are re-checked at the same moment (replay right after the
// trigger), sitting gaps on the latest block. Node errors = not compared.
const sampleWithNode = (lc: LocalCheck, b: BuiltCheck): void => {
      lc.sampled = true;
      const startMs = Date.now();
      void (async () => {
            try {
                  const hash = lc.q.triggerHash;
                  if (hash && !fastBlockTag(lc)) {
                        const spot = await findTriggerSpot(simRpc.robinhood, hash);
                        if (!spot) { lc.nodeDone(null, startMs, 'trigger not found'); return; }
                        const r = await simulateRoundTrip(replayRpc(simRpc.robinhood, spot.parent, spot.prefix, spot.time), 'robinhood', b.trade, b.simOpts);
                        lc.nodeDone(r, startMs, 'right after trigger (re-check)');
                  } else if (fastBlockTag(lc)) {
                        // Copy 2: the node answers for the very block the fast check used.
                        const r = await simulateRoundTrip(simRpc.robinhood, 'robinhood', b.trade, { ...b.simOpts, blockTag: fastBlockTag(lc) });
                        lc.nodeDone(r, startMs, 'same block (re-check)');
                  } else {
                        const r = await simulateRoundTrip(simRpc.robinhood, 'robinhood', b.trade, b.simOpts);
                        lc.nodeDone(r, startMs, 'latest (re-check)');
                  }
            } catch { lc.nodeDone(null, startMs, 'error'); }
      })();
};
// On mode: wait for the fast answer; SURE -> use it (and maybe re-check),
// unknown -> null (caller runs the node path, whose answer is recorded too).
const fastDecide = async (lc: LocalCheck | null, b: BuiltCheck, tokenIn: string, tradeSizeUsd: number, usdPerToken: number): Promise<RoundTripCheck | null> => {
      if (!lc || !localSim?.isOn()) return null;
      try {
            const lo = await lc.result;
            if (!lo.sure) return null;
            const out = await fastToCheck(lc, lo, b, tokenIn, tradeSizeUsd, usdPerToken);
            lc.decidedByLocal = true;
            if (localSim.shouldSample()) sampleWithNode(lc, b); else lc.noNode();
            return out;
      } catch { return null; }
};

const checkRoundTrip = async (
      chain: 'avalanche' | 'monad' | 'robinhood', tokenIn: string,
      buyPool: any, sellPool: any, tradeSizeUsd: number, usdPerToken: number,
      // Fast check (Robinhood): ask it the same question. existing = a fast
      // check already started for this trade (the live follow-a-trade path):
      // only the node's answer is added to it here.
      fast?: FastAsk,
): Promise<RoundTripCheck> => {
      const off = simOff(chain);
      if (off) { fast?.existing?.noNode(); return { status: 'skipped', reason: `simulation off: ${off}` }; }
      if (Date.now() < (simPausedUntil[chain] ?? 0)) { fast?.existing?.noNode(); return { status: 'rate_limited' }; }
      const b = buildCheck(chain, tokenIn, buyPool, sellPool, tradeSizeUsd, usdPerToken);
      if ('skip' in b) { fast?.existing?.noNode(); return { status: 'skipped', reason: b.skip }; }
      const { decimals, lender } = b;
      const built = { amountIn: b.trade.amountIn, hops: b.trade.hops };
      // COPY 2 (execution/copy2.ts): while the fast check follows our pools from
      // their events, it is asked ONLY when every pool on the route (and the
      // loan pool) is ready, about the newest block whose reports it got.
      // Otherwise no fast check at all: the node decides, as today.
      if (fast && !fast.existing && chain === 'robinhood' && localSim?.copy2Running()) {
            const route = localSim.copy2Route(routeKeys(buyPool, sellPool, lender));
            fast = route ? { ...fast, at: route.at } : undefined;
      }
      // FAST CHECK, on mode: fast answer first; a sure one is used as is.
      let lc: LocalCheck | null = fast?.existing ?? null;
      if (fast && !lc && chain === 'robinhood' && localSim?.isOn()) {
            lc = startFastCheck(fast, b);
            const quick = await fastDecide(lc, b, tokenIn, tradeSizeUsd, usdPerToken);
            if (quick) return quick;
      }
      // Robinhood: a "breaks, no reason" answer is asked again on the free node
      // (as the after-trigger checks already do), and every result is counted
      // in the "Check results by kind" line, which before saw trigger checks only.
      const nodeStartMs = Date.now();
      const nodeP = simulateWithRecheck(simRpc[chain], chain === 'robinhood' ? rhFreeSimRpc : null, chain, { token: tokenIn, amountIn: built.amountIn, hops: built.hops }, { v3Lender: lender?.poolAddress, weth: chain === 'robinhood' ? ROBINHOOD_TOKENS.WETH : undefined },
            (changed) => { recheckStats.done++; if (changed) recheckStats.changed++; });
      // FAST CHECK, practice (shadow): started AFTER the node request, so the node is never delayed.
      if (fast && !lc && chain === 'robinhood') lc = startFastCheck(fast, b);
      const r = await nodeP;
      lc?.nodeDone(r, nodeStartMs, fast?.existing ? 'latest after trade landed' : 'latest');
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
      // FAST CHECK (practice, shadow and on alike: these practice checks are always
      // decided by the node): ask the same question "right after the trigger" as
      // soon as possible. setImmediate: never adds work to the feed handler itself.
      let fastLc: LocalCheck | null = null;
      // (Copy 2 running: "right after this transaction" can't be answered per
      // block, so these practice comparisons are skipped; gaps are compared instead.)
      if (followTrigger && localSim && !localSim.copy2Running()) {
            setImmediate(() => {
                  try {
                        const trade = { token: tokenIn, amountIn: built.amountIn, hops: built.hops };
                        fastLc = localSim?.begin({ kind: 'trig', trade, simOpts: { v3Lender: lender?.poolAddress, weth: ROBINHOOD_TOKENS.WETH }, triggerHash, label: `${symbolOf(chain, buyPool.tokenA)}/${symbolOf(chain, buyPool.tokenB)} ${buyPool.dex}>${sellPool.dex}` }) ?? null;
                  } catch { /* fast check problems never touch the practice check */ }
            });
      }
      setTimeout(async () => {
            const nodeStartMs = Date.now();
            let fastNodeTold = false;
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
                  // FAST CHECK: the node's final answer for this practice check (comparison only).
                  if (fastLc) { fastNodeTold = true; (fastLc as LocalCheck).nodeDone(r, nodeStartMs, timing || 'latest'); }
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
                        report4h(() => fourHour?.noteTest([poolKind(buyPool), poolKind(sellPool)], winNet));
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
                                    { startToken: tokenIn, sizeUsd: tradeSizeUsd, lender: lender?.poolAddress, notLive: liveBlocker(buyPool, sellPool) ?? undefined }, [buyPool.tokenA, buyPool.tokenB]);
                        }
                        if (chain === 'robinhood') { routeScores.record(routeKey, net); if (vetted) winSizes.add(net); profitBands.add(net, torontoDay()); }
                        // Real check: makes money -> live block lifted; doesn't -> blocked for live.
                        if (chain === 'robinhood') { if (net >= 0.1) liveBlocks.clear(buyPool.poolAddress, sellPool.poolAddress); else liveBlocks.block(buyPool.poolAddress, sellPool.poolAddress, `real check made only $${net.toFixed(2)}`); }
                        // Race check for trigger wins: we'd send ~0.1 s after seeing the trigger,
                        // so "ready" is the block after the trigger's block.
                        if (chain === 'robinhood' && spot && net > 0) void raceChecker.record({ label: `${pair} after trigger`, pools: [buyPool.poolAddress, sellPool.poolAddress], netUsd: net, source: 'trigger', spottedBlock: Number(spot.block), readyDelayMs: 100, ignoreTx: triggerHash, ...(spot.index !== undefined ? { afterTxIndex: spot.index } : {}) });
                  } else if (r.status === 'loss') {
                        simStats.loss++;
                        if (chain === 'robinhood') { routeScores.record(routeKey, 0); liveBlocks.block(buyPool.poolAddress, sellPool.poolAddress, 'real check: loss'); }
                        console.log(`[sim] ${chain} ${pair} ${route} real: LOSS | ${model}`);
                  } else {
                        simStats.fail++;
                        if (chain === 'robinhood') { failTally.add(r.reason); routeScores.record(routeKey, 0); liveBlocks.block(buyPool.poolAddress, sellPool.poolAddress, `real check failed: ${r.reason}`); }
                        console.log(`[sim] ${chain} ${pair} ${route} real: FAILS (${r.reason}) | ${model}`);
                  }
            } catch (err) {
                  console.warn(`[sim] ${chain} error:`, (err as Error).message);
            } finally {
                  if (fastLc && !fastNodeTold) (fastLc as LocalCheck).noNode();
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
let gapSamePoolSkips = 0; // ONE SEND PER GAP: routes skipped, a send just went out on one of their pools
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
// LIVE COIN RULE (core/liveCoins.ts, Oct 17): which coins a REAL trade may
// touch (USDG, WETH, official Robinhood stock tokens, LIVE_EXTRA_COINS).
liveCoins = new LiveCoinRule(robinhoodReadProvider, [ROBINHOOD_TOKENS.USDG, ROBINHOOD_TOKENS.WETH]);
console.log(`[live-coins] rule ${liveCoins.on ? 'ON (no meme coins in real trades)' : 'OFF (meme coins allowed in real trades; LIVE_COIN_RULE=on to block them)'}`);
setInterval(() => { const st = liveCoins?.stats(); if (st) console.log(`[live-coins] ${st.allowed} of ${st.checked} checked coins allowed for real trades`); }, 60 * 60_000);
// TESTED VENUES LIVE (config/robinhoodVenues.ts, Oct 17): is the deployed
// contract exactly the tested code? Read-only, checked every start. With a
// match, the fork-tested exchanges (UP, Sushi, GIGA, SwapHood, Topaz,
// Raphael, Alandale, KittenSwap, Fables, and Abyss since Oct 18) become
// tradable for real.
// Since Oct 18 (owner decision) this is ON by default: no server setting
// needed. The contract match is still required (a different contract keeps
// them off automatically). RH_TESTED_VENUES_LIVE=0 turns them off.
// The result is also sent to Telegram once per start (live mode only), so
// the owner can see it without reading the server log.
void (async () => {
      const r = await checkDeployedContract(robinhoodReadProvider, executorConfig('robinhood').executorAddress);
      const wanted = process.env.RH_TESTED_VENUES_LIVE !== '0';
      const on = wanted && r.match;
      setTestedVenuesLive(on);
      const why = on ? 'ON' : wanted ? 'OFF (contract does not match)' : 'OFF (RH_TESTED_VENUES_LIVE=0)';
      console.log(`[contract] ${r.reason}. Tested exchanges for real trades: ${why}`);
      // Also saved for the GitHub status page (deploy/status-report.js), so the
      // owner can see the result without reading the server log.
      try { mkdirSync('data', { recursive: true }); writeFileSync('data/contract-check.txt', `${r.reason}. Tested exchanges for real trades: ${why}`); } catch { /* reporting only */ }
      // Same live test as FastSender (the sender itself is created further down).
      if (process.env.EXECUTION_ENABLED === 'true' && process.env.LIVE_SEND_CONFIRM === 'yes-real-money') {
            const msg = on
                  ? '🟢 LIVE · Extra exchanges ON\nYour contract matches the tested version, so UP, Sushi, GIGA, SwapHood, Topaz, Raphael, Alandale, KittenSwap, Fables and Abyss can be traded.'
                  : wanted
                        ? `🟢 LIVE · Extra exchanges OFF\nYour contract is not the tested version (${r.reason.replace(/[<>&]/g, '')}). Trades use the main exchanges only. Nothing else to do unless you want them.`
                        : '🟢 LIVE · Extra exchanges OFF (turned off with RH_TESTED_VENUES_LIVE=0)';
            void sendTelegramMessage(msg).catch(() => undefined);
      }
})();
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
      // batchMaxCount 1 (Oct 25): ethers holds every request ~10 ms
      // (batchStallTime) to bundle it with others; a trade must leave at once.
      new ethers.JsonRpcProvider(robinhoodSendRpc(), 4663, { staticNetwork: true, batchMaxCount: 1, batchStallTime: 0 }),
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
// MONEY LEDGERS for the hourly report (src/report/ledgers.ts, reporting only).
// Checked wins and Could earn live: today / 7 days read from the two practice
// totals above; the last hour is counted as wins come in. Real money made:
// confirmed live trades only, saved in data/live-money.json (survives restarts).
const realMoney = new RealMoneyLedger('data/live-money.json', process.env.REPORT_TZ || 'America/Toronto');
const moneyLedgers = new MoneyLedgers({
      checked: () => { const s = dryRunPnl.summary(); return { today: s.today.verifiedUsd, week: s.last7.verifiedUsd }; },
      couldEarn: () => { const s = realisticPnl.summary(); return { today: s.today.usd, week: s.weekUsd }; },
}, realMoney);
// Every verified practice win goes through here: the normal total, then the
// live-realistic total and the other-stablecoin counter (both reporting only).
// `usd` is what the normal total adds (net of gas, only the new part of a
// re-checked gap), so nothing is counted twice.
const countVerifiedWin = (usd: number, label: string, win: WinFacts, pairTokens: [string, string]) => {
      dryRunPnl.recordVerified(usd, label);
      const verdict = realisticPnl.record(usd, win);
      // Same win into the hourly money ledgers. The hourly report AND the
      // 4-hour report read them, so their money numbers always agree.
      try { moneyLedgers.notePracticeWin(usd, label, verdict); } catch { /* reporting only */ }
      stableTally.noteWin(pairTokens, win.startToken, usd);
};
// Save on shutdown too: pm2 restart/stop (every deploy) sends SIGINT, and the
// last minute of would-have-earned figures used to be lost each time.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.once(sig, () => {
            try { dryRunPnl.save(); } catch { /* best effort */ }
            try { realisticPnl.save(); stableTally.save(); } catch { /* best effort */ }
            try { realMoney.save(); } catch { /* best effort */ }
            try { fourHour?.save(); } catch { /* best effort */ }
            try { gasModel.calibration.maybeSave(true); } catch { /* best effort */ }
            try { robinhoodWatcher.save(WATCH_FILE); } catch { /* best effort */ }
            try { routeScores.save(ROUTE_FILE); } catch { /* best effort */ }
            try { autoVet.save(AUTO_VET_FILE); } catch { /* best effort */ }
            try { rivalWatch.save(RIVAL_BOTS_FILE, RIVAL_TRADES_FILE); } catch { /* best effort */ }
            try { saveNodeUsage(); } catch { /* best effort */ }
            try { if (research.enabled) research.save(RESEARCH_FILE); } catch { /* best effort */ }
            try { void localSim?.stop(); } catch { /* best effort */ }
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
// V4 pools from Initialize events (core/v4EventDiscovery.ts); null when off.
const v4DiscoverCfg = v4DiscoverConfig();
let v4DiscoveryRef: V4EventDiscovery | null = null;
// One status line: what the event reader knows, and how the watched V4 pools were found.
const v4DiscoveryStatus = (): string | null => {
      if (!v4DiscoveryRef) return null;
      const pools = robinhoodWatcher.watchedPairPools().flat().map((k) => cache.get('robinhood', k)).filter((p): p is PoolState => !!p);
      return v4DiscoveryRef.statusLine(countWatchedV4BySource(pools, V4_LOOKUP_TIERS));
};

// Live only: every real send and result goes to data/live-trades.jsonl (read
// by the status page), and Telegram alerts fire when live sending pauses
// (daily loss cap, kill switch, bad setting) or 75% of the cap is used.
const liveTradeLog = new LiveTradeLog();
// Instant plain-English alerts (report/alertHooks.ts). REPORT_V2=0 = old messages.
const alertHooks = new AlertHooks({ send: (html) => sendTelegramMessage(html) });
alertHooks.installExitRecorder();
const safetyAlerts = new SafetyAlerts((html, critical) => alertHooks.safetyNotify(html, critical), safetyConfigFromEnv().dailyLossCapUsd, 'robinhood', Date.now, alertHooks.v2);
// LIVE TELEGRAM LAYOUT (report/liveTelegram.ts, Oct 18): once real money is
// on, Telegram shows real money only: one message per real trade, a short
// hourly and 4-hourly, and alerts. Practice mode is unchanged.
// TELEGRAM_LIVE_LAYOUT=0 keeps the old messages in live mode too.
const LIVE_LAYOUT = robinhoodSender.live && liveLayoutOn();
const liveBook = new LiveTradeBook(LIVE_LAYOUT ? (process.env.LIVE_TELEGRAM_FILE ?? 'data/live-telegram.json') : null, process.env.REPORT_TZ || 'America/Toronto');
alertHooks.liveTradeMessages = LIVE_LAYOUT;
// Coins of the trade contract shown in the wallet table (name, address, digits shown).
const LIVE_WALLET_COINS = [
      { coin: 'USDG', address: ROBINHOOD_TOKENS.USDG, digits: 2 },
      { coin: 'WETH', address: ROBINHOOD_TOKENS.WETH, digits: 4 },
];
// A coin dropping with no trade to explain it: alert (never pauses trading).
const walletWatch = new WalletWatch(liveBook, (coin, dropped) => {
      const digits = LIVE_WALLET_COINS.find((c) => c.coin === coin)?.digits ?? 4;
      try { alertHooks.center.event(`wallet-drop:${coin}:${Date.now()}`, walletChangedSpec(coin, dropped, digits)); } catch { /* reporting only */ }
});
// Gas wallet: last read balance and the "trades left" it buys (updated every 5 min when live).
const liveGas: { eth: number | null; tradesLeft: number | null } = { eth: null, tradesLeft: null };
const LIVE_GAS_LOW_TRADES = Number(process.env.LIVE_GAS_LOW_TRADES ?? 20);
// One real trade's final result: book it and send the ✅ / ❌ message.
const sendLiveTradeMessage = (r: { status: 'profit' | 'reverted' | 'dropped'; label: string; gasUsd: number; profitUsd?: number; sizeUsd?: number; funding?: Funding }) => {
      if (!LIVE_LAYOUT) return;
      try {
            liveBook.add(r);
            void sendTelegramMessage(formatLiveTrade({ ...r, today: liveBook.today() })).catch(() => undefined);
      } catch (err) { console.warn('[live-telegram] trade message failed:', (err as Error).message); }
};

// SCOREBOARD (report/scoreboard.ts, Oct 23): every real send by path,
// confidence and assumptions; wins, gas, NET, break-even win rate (hourly
// log + Telegram, data/scoreboard.jsonl). Self-adjusting: a losing bucket
// stops sending for 6 h; a losing last 3 h puts trigger-first back to practice.
const scoreboard = new Scoreboard({
      notify: (text) => { void sendTelegramMessage(escHtml(text)).catch(() => undefined); },
      onStepBack: (untilMs, why) => { trigFirst?.stepBack(untilMs, why); },
});
// LIVE results (only used once live sending is switched on): receipt, profit
// from the contract's Executed event, gas cost; losses feed the daily cap.
// Set once live loops are created (further down); the tracker reports loop results to it.
let loopLiveRef: LoopLiveSender | null = null;
// Fire-first 3-pool loop sends (execution/trigEntryLoops.ts): their results (loop loss cap).
let entryLoopSenderRef: EntryLoopSender | null = null;
const liveTracker = new LiveTradeTracker({
      provider: robinhoodReadProvider,
      ethUsd: () => priceOracle.getUsdPrice('robinhood', ROBINHOOD_TOKENS.WETH) ?? 0,
      tokenUsd: (token, raw) => {
            const px = priceOracle.getUsdPrice('robinhood', token);
            const dec = TOKEN_DECIMALS.robinhood?.[token.toLowerCase()];
            return px === null || dec === undefined ? null : (Number(raw) / 10 ** dec) * px;
      },
      recordLoss: (usd) => { safetyGate.recordLoss(usd); safetyAlerts.onLoss(safetyGate.lossTodayUsd()); },
      // Every final result: the status page's file, the instant alerts, and the
      // hourly report's "Real money made" ledger (only counted when really live).
      onResult: (r) => {
            liveTradeLog.result(r); alertHooks.onLiveResult(r); moneyLedgers.noteRealResult(r, robinhoodSender.live); sendLiveTradeMessage(r);
            // LIVE LOOPS: wins, and gas lost toward the loop loss cap.
            loopLiveRef?.noteResult(r);
            // FIRE-FIRST LOOPS: gas lost toward the same loop loss cap.
            entryLoopSenderRef?.noteResult(r);
            // Scoreboard: the send's path / confidence and its real result.
            const scored = scoreboard.noteResult(r);
            // A trigger-first ENTRY send that failed on chain: its pair waits 30 min (entry sends skip the 6 h list).
            if (GAP_LIVE_FAIL_BLOCK_MIN > 0 && entryFailBlock(scored, (a, b, why) => gapFailBlocks.block(a, b, why))) {
                  console.log(`[live-block] ${r.label}: trigger-first entry live trade failed, pool pair not sent by the entry point for ${GAP_LIVE_FAIL_BLOCK_MIN} min`);
            }
            // A standing gap whose live trade failed on chain: not sent again for 30 min.
            if (GAP_LIVE_FAIL_BLOCK_MIN > 0 && standingGapFailBlock(scored, (a, b, why) => gapFailBlocks.block(a, b, why))) {
                  console.log(`[live-block] ${r.label}: standing gap's live trade failed, pool pair not sent as a standing gap for ${GAP_LIVE_FAIL_BLOCK_MIN} min`);
            }
            // A live trade that failed on the chain blocks its pool pair for 6 h.
            const pools = livePools.get(r.hash);
            if (pools && r.status === 'reverted') { liveBlocks.block(pools[0], pools[1], 'live trade failed on chain'); console.log(`[live-block] ${r.label}: live trade failed, pool pair blocked 6 h`); }
            livePools.delete(r.hash);
      },
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
            if (LIVE_LAYOUT) for (const c of LIVE_WALLET_COINS) {
                  const dec = TOKEN_DECIMALS.robinhood?.[c.address.toLowerCase()];
                  if (dec !== undefined) walletWatch.observe(c.coin, Number(ownMoney.raw(c.address)) / 10 ** dec);
            }
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
      // More of the route's own pools a lender may not be (loops: every pool after the first two).
      extraExclude: string[] = [],
) => {
      const exclude = [buyPool.poolAddress, sellPool.poolAddress, ...extraExclude];
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
// LIVE LOOPS (execution/loopLive.ts, Oct 20, owner approved). LOOP_LIVE=1:
// loops that pass every filter in the loop trader are checked on the paid
// checking node and, if the real check says they pay, sent for real through
// the same sender, safety gate and live tracker as 2-pool trades.
// Wallet first: the contract's own money if it holds the whole amount,
// otherwise a flash loan from an approved lender that is not on the loop.
// LOOP_LIVE unset / 0 = loops stay practice only (nothing here runs).
const loopLiveCfg = loopLiveConfigFromEnv(process.env);
// The real check of a live loop. FAST CHECK (copy 2, on mode): when every pool
// on the loop (and the loan pool) is ready in the copy, the fast check answers
// about the newest block it has (at least the block of the trade that opened
// the loop); a SURE answer decides, 1 in 10 is re-checked on the node for the
// same block (that agreement count can step the fast check back to practice).
// Anything else (off, practice, not ready, unsure): the node, as before.
const loopLiveCheck = async (c: LoopLiveCandidate, lender: string | undefined): Promise<SimResult> => {
      const trade = { token: c.hops[0].tokenIn, amountIn: c.amountIn, hops: c.hops };
      const simOpts = { weth: ROBINHOOD_TOKENS.WETH, ...(lender ? { v3Lender: lender } : {}) };
      const onNode = (blockTag?: string) => simulateRoundTrip(simRpc.robinhood, 'robinhood', trade, blockTag ? { ...simOpts, blockTag } : simOpts);
      const host = localSim;
      const route = host?.isOn() && host.copy2Running()
            ? host.copy2Route([...c.poolKeys, lender], host.copy2?.forwarder.txBlockOf(c.triggerHash) ?? -1)
            : null;
      if (!host || !route) return onNode();
      const lc = host.begin({ kind: 'loop_live', trade, simOpts, at: route.at, triggerHash: c.triggerHash, label: `loop ${c.label}` });
      const lo = await lc.result;
      const startMs = Date.now();
      if (lo.sure) {
            lc.decidedByLocal = true;
            if (host.shouldSample()) {
                  lc.sampled = true;
                  void onNode(route.at.block).then((r) => lc.nodeDone(r, startMs, 'same block (re-check)'), () => lc.nodeDone(null, startMs, 'error'));
            } else lc.noNode();
            return lo.sim;
      }
      const r = await onNode();
      lc.nodeDone(r, startMs, 'latest');
      return r;
};
const loopLive: LoopLiveSender | null = loopCfg.enabled && loopLiveCfg.enabled ? new LoopLiveSender(loopLiveCfg, {
      now: Date.now,
      live: () => robinhoodSender.live,
      liveBlocker: (c) => {
            for (const k of c.poolKeys) {
                  const p = cache.get('robinhood', k);
                  if (!p) return 'pool not in the cache';
                  const why = liveBlocker(p, p);
                  if (why) return why;
            }
            for (const t of c.coins) if (!safetyGate.isAllowed(t)) return 'coin not on the allowed list';
            if (involvesAutoVetted(c.coins) && c.sizeUsd > AUTO_VET_MAX_TRADE_USD) return `auto-vetted coin: over the $${AUTO_VET_MAX_TRADE_USD} limit`;
            return null;
      },
      funding: (c) => {
            const dec = TOKEN_DECIMALS.robinhood?.[c.base.toLowerCase()];
            if (dec === undefined) return null;
            // Wallet first: the contract really holds the whole amount (live), or
            // practice: the same "own money" assumption as practice checks.
            // Same rule as 2-pool trades: own money on (RH_FUNDING), up to OWN_MONEY_MAX_USD,
            // and live the contract must really hold the whole amount.
            if (RH_OWN_MONEY && c.sizeUsd <= OWN_MONEY_MAX_USD && (!robinhoodSender.live || ownMoney.covers(c.base, c.amountIn))) return { kind: 'own' };
            // Otherwise a flash loan: approved lender, not one of the loop's pools, holds enough.
            if (!lenderBalances.lastRefreshMs) return null;
            const exclude = c.poolKeys.map((k) => cache.get('robinhood', k)?.poolAddress ?? k);
            const l = pickV3Lender(lenderCandidates('robinhood'), c.base, exclude, (pool, token) => lenderBalances.canLend(pool, token, c.amountIn, LENDER_HEADROOM));
            return l ? { kind: 'flash', lender: l.poolAddress, feePips: l.feePips ?? l.feeBps * 100 } : null;
      },
      // Same node and polling as 2-pool check-first. COPY 2 on: the trade's
      // pool reports arriving means it is in a block (no node polling needed);
      // not seen in time = the node is asked as before.
      waitForTrade: async (hash) => {
            if (localSim?.isOn() && localSim.copy2Running() && (await localSim.copy2WaitForTx(hash, 1_800)) !== null) return true;
            return waitForTrade(simRpc.robinhood, hash, CHECK_FIRST_POLL_MS, Math.ceil(1_800 / CHECK_FIRST_POLL_MS));
      },
      check: (c, lender) => loopLiveCheck(c, lender),
      gasUsd: (pools, flash) => gasModel.loopUsd(pools, 0.05) + (flash ? Math.max(0, rhGasUsd(0.05, true) - rhGasUsd(0.05, false)) : 0),
      minNetUsd: () => MIN_NET_PROFIT_USD,
      usdOf: (t) => priceOracle.getUsdPrice('robinhood', t),
      decimalsOf: (t) => TOKEN_DECIMALS.robinhood?.[t.toLowerCase()],
      isOutlier: (net, size) => isOutlier(net, size, OUTLIER_CFG),
      safety: (sizeUsd, coins) => {
            const g = safetyGate.check({ tradeSizeUsd: sizeUsd, tokens: coins });
            if (!g.ok) return 'reason' in g ? g.reason : 'blocked';
            // Scoreboard: live loops stop for a while if their recent real sends lost money.
            return robinhoodSender.live ? scoreboard.pausedWhy('loop') : null;
      },
      deadline: () => robinhoodSender.deadlineBlock(),
      ready: () => (liveChecks.ok ? null : 'live checks not passed'),
      // L2 part of the sender's limit (the L1 part is added on top by the sender).
      gasLimitOk: (units) => robinhoodSender.currentGasLimit - (robinhoodSender.l1GasNow * 3n) / 2n >= BigInt(Math.ceil(units * 1.2)),
      executor: () => executorConfig('robinhood').executorAddress,
      fire: (to, data) => robinhoodSender.fire(to, data),
      afterSent: (hash, info) => {
            const funding: Funding = info.funding.kind === 'flash'
                  ? { kind: 'flash', feePct: info.funding.feePips / 10_000, feeUsd: info.sizeUsd * info.funding.feePips / 1_000_000 }
                  : { kind: 'own' };
            fireStats.sent++;
            whyNotSent.sent();
            liveTradeLog.sent(hash, info.label, info.sizeUsd, info.netUsd, funding);
            setTimeout(() => { void refreshOwnMoney(); }, 3_000);
            safetyGate.reservePending(hash, 2 * info.gasUsd);
            liveTracker.track(hash, { expectedProfitUsd: info.netUsd, label: info.label, sizeUsd: info.sizeUsd, funding, routeKey: routeKeyFor(info.kinds, info.funding.kind === 'flash') });
            if (robinhoodSender.live) scoreboard.noteSend({ hash, path: 'loop', expectedUsd: info.netUsd, label: info.label });
      },
      log: (m) => console.log(m),
      alert: (html) => { void sendTelegramMessage(html).catch(() => undefined); },
}) : null;
loopLiveRef = loopLive;
if (loopLive) console.log(`[loop-live] LIVE LOOPS ON (LOOP_LIVE=1): up to ${loopLiveCfg.maxPools} pools, wallet first then flash loan, max $${loopLiveCfg.maxTradeUsd.toLocaleString('en-US')} a loop, ${loopLiveCfg.maxPerHour} sends and ${loopLiveCfg.checksPerHour} real checks an hour, loop loss cap $${loopLiveCfg.lossCapUsd}/day${robinhoodSender.live ? '' : ' (bot not live: dry run only)'}`);
// Hourly line for the status page (one line, plain text).
if (loopLive) setInterval(() => { try { console.log(loopLive.hourLine(true)); } catch { /* reporting only */ } }, 3600_000).unref?.();
const offerLoopLive = (c: LoopLiveCandidate): boolean => { if (!loopLive) return false; void loopLive.offer(c); return true; };
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
      // COIN TAX TEST (Oct 20, core/coinTax.ts): coins that take a cut when
      // moved are left out of loops. One free simulation per coin on the loop
      // node, only while no loop check runs. LOOP_TAX_TEST=0 = off.
      const loopTaxCfg = coinTaxConfigFromEnv(process.env);
      const loopTaxBook = loopTaxCfg.enabled ? new CoinTaxBook(loopTaxCfg, async (token, holder) => {
            if (!loopOnMain) { loopGuard.noteStart(); loopThrottle.beginCheck(); }
            try { return await testCoinTax(loopNodeRpc, token, holder); }
            catch (e) {
                  if (e instanceof LoopNodeBusy) { loopThrottle.busySkips++; return { verdict: null, why: e.message }; }
                  return { verdict: null, why: (e as Error).message };
            }
      }, {
            file: 'data/coin-tax.json',
            log: (m) => console.log(m),
            symbolOf: (t) => symbolOf('robinhood', t),
            alwaysOk: [ROBINHOOD_TOKENS.WETH, ROBINHOOD_TOKENS.USDG],
      }) : null;
      if (loopTaxBook) setInterval(() => loopTaxBook.save(), 60_000).unref?.();
      const loopTrader = new LoopTrader(loopCfg, {
            ...(loopTaxBook ? { coinTax: loopTaxBook } : {}),
            ...(loopLive ? { liveOffer: offerLoopLive } : {}),
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
            report4h(() => { lastLoopSample = loopSampleFrom(h, node); });
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
                  // COIN TAX TEST (Oct 20, core/coinTax.ts): LOOP_TAX_TEST=0 = off.
                  tax: { cfg: coinTaxConfigFromEnv(process.env), file: 'data/coin-tax.json' },
                  // LIVE LOOPS: the worker hands qualifying loops over (offerLoopLive).
                  live: !!loopLive,
            },
            onLiveCandidate: (c) => { offerLoopLive(c); },
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
            report4h(() => { lastLoopSample = loopSampleFrom(r.h, r.node); });
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
      // The trade we follow (trigger trades): check-first waits for it to land.
      triggerHash?: string;
      // TRIGGER-FIRST ENTRY POINT send (execution/trigEntry.ts): our exact
      // trade was already checked on the replayed feed (out). Such a send
      // skips the old model guess's check-first step and the 6 h liveBlocks /
      // bench lists (those stay for the old paths), and keeps every other
      // safeguard below. onSigned / onBlocked report back to the entry point.
      entry?: { out: TrigOutcome; onSigned?: (ms: number) => void; onBlocked?: (why: string) => void };
}) => {
      try {
            // WHY NOT SENT (report/whyNotSent.ts): every live chance that gets here is
            // counted, and so is its outcome (sent, or the reason it stopped).
            const liveRh = o.chain === 'robinhood' && robinhoodSender.live;
            if (liveRh) whyNotSent.chance();
            // Which check let a live follow-a-trade send through (fast check log timing).
            let checkFirstDecidedBy: 'trig_first' | 'local' | 'node' | null = null;
            // Trigger-first decided: its confidence and assumptions (scoreboard).
            let trigUsed: TrigOutcome | null = null;
            // Hard stop: never build a trade on an exchange that isn't cleared
            // for trading (config/robinhoodVenues.ts executionEnabled: false).
            const notLive = liveBlocker(o.buyPool, o.sellPool);
            if (notLive) {
                  console.log(`[exec-dryrun] ${o.chain} NOT executable: ${notLive}`);
                  if (liveRh) whyNotSent.blocked(`exchange not live yet: ${notLive}`);
                  return;
            }
            const block = (r: string) => {
                  fireStats.blocked.set(r, (fireStats.blocked.get(r) ?? 0) + 1);
                  // Live: also into the 10-min "why not sent" line and the status page's file.
                  if (liveRh) { whyNotSent.blocked(r); liveTradeLog.noteBlocked(r); }
                  try { o.entry?.onBlocked?.(r); } catch { /* reporting only */ }
            };
            // LIVE ROUTE BLOCK: a pair whose real check failed / lost, or whose live
            // trade failed, in the last 6 h is not sent for real (no $1 bypass).
            // Trigger trades only: sitting gaps are sent right after a fresh real
            // check that passed (and a pass lifts the block anyway).
            // NOT for trigger-first ENTRY sends (o.entry): deliberately, it stopped
            // 15 of 16 entry-worthy chances; a failed entry send blocks its pair
            // for 30 min instead (just below).
            if (o.chain === 'robinhood' && robinhoodSender.live && o.source === 'trade' && !o.entry) {
                  const why = liveBlocks.reason(o.buyPool.poolAddress, o.sellPool.poolAddress);
                  if (why) { block('pool pair blocked for live (failed real check or live trade, 6 h)'); return; }
            }
            // STANDING GAPS keep ignoring the 6 h block above (design: each is sent
            // right after its own fresh real check), but a pair whose standing-gap
            // live trade failed on chain waits GAP_LIVE_FAIL_BLOCK_MIN (30 min).
            // Trigger-first ENTRY sends use the same 30-min block (their own failures, entryFailBlock).
            if (o.chain === 'robinhood' && robinhoodSender.live && (o.source === 'gap' || o.entry) && gapFailBlocks.reason(o.buyPool.poolAddress, o.sellPool.poolAddress)) {
                  block(`${o.entry ? 'trigger-first entry' : 'standing gap'}: live trade failed on this pair (${GAP_LIVE_FAIL_BLOCK_MIN} min)`);
                  return;
            }
            // Pool pairs whose practice checks keep losing (benched 6 h) aren't
            // sent either: a trade the checks say never pays would only burn gas.
            // Big gaps ($1+ expected, BENCH_BYPASS_USD) are sent even on a benched pair.
            // (Not for trigger-first ENTRY sends: their exact trade was checked on the replayed feed.)
            if (o.chain === 'robinhood' && o.source === 'trade' && !o.entry && o.netProfitUsd < BENCH_BYPASS_USD && routeScores.isBenched(RouteScores.key(o.buyPool.poolAddress, o.sellPool.poolAddress))) {
                  block('pool pair benched (practice checks keep losing)');
                  return;
            }
            // FIT TO WALLET (core/ownMoney.ts fitTradeToWallet, Oct 18, owner approved).
            // Live, own money, no loan pools approved: a best size bigger than the
            // wallet is shrunk to what the wallet holds (2% cushion) and re-priced
            // with the same pool maths. The send minimum below still decides.
            // LIVE_FIT_TO_WALLET=0 = old behaviour (too-big trades are skipped).
            if (o.chain === 'robinhood' && robinhoodSender.live && RH_OWN_MONEY && !approvedLenders('robinhood').size && process.env.LIVE_FIT_TO_WALLET !== '0') {
                  const dec = TOKEN_DECIMALS.robinhood?.[o.tokenIn.toLowerCase()];
                  if (dec !== undefined) {
                        const cap = Math.min(OWN_MONEY_MAX_USD, MAX_TRADE_USD, ownMoney.availableUsd(o.tokenIn, o.usdPerTokenIn, dec));
                        const fit = fitTradeToWallet({ sizeUsd: o.tradeSizeUsd, netUsd: o.netProfitUsd, capUsd: cap, quote: roundTripQuote(o.buyPool, o.sellPool, o.tokenIn, o.usdPerTokenIn, dec), gasUsd: rhGasUsd(0.05) });
                        if (fit) {
                              console.log(`[fit-wallet] ${symbolOf(o.chain, o.tokenIn)}/${symbolOf(o.chain, o.tokenOut)}: best size $${Math.round(o.tradeSizeUsd)} > wallet $${Math.round(cap)}, trading $${Math.round(fit.sizeUsd)} for ~$${fit.netUsd.toFixed(2)} (was ~$${o.netProfitUsd.toFixed(2)})`);
                              // The practice check's number (outlier guard) drops by the same amount.
                              const drop = o.netProfitUsd - fit.netUsd;
                              o = { ...o, tradeSizeUsd: fit.sizeUsd, netProfitUsd: fit.netUsd, checkedProfitUsd: o.checkedProfitUsd === undefined ? undefined : o.checkedProfitUsd - drop };
                        }
                  }
            }
            // Auto-vetted coins: smaller trade limit (their rules could still change).
            if (o.chain === 'robinhood' && involvesAutoVetted([o.tokenIn, o.tokenOut]) && o.tradeSizeUsd > AUTO_VET_MAX_TRADE_USD) {
                  block(`auto-vetted coin: over the $${AUTO_VET_MAX_TRADE_USD} limit`);
                  return;
            }
            // TRIGGER-FIRST (execution/triggerFirst.ts, LOCAL_SIM_TRIGGER_FIRST=shadow|on):
            // our EXACT trade (after fit-to-wallet above) checked right after the
            // trigger, asked NOW: the fast check replays the feed's transactions on
            // copy 2 itself, no waiting for pool reports or receipts. Started for
            // every Robinhood trigger trade (also dry runs: practice numbers);
            // it decides only in the live check-first step below, in "on" mode.
            const label0 = `${symbolOf(o.chain, o.tokenIn)}/${symbolOf(o.chain, o.tokenOut)} ${o.buyPool.dex}>${o.sellPool.dex}`;
            let trigP: Promise<TrigOutcome> | null = null;
            let trigBuilt: BuiltCheck | null = null;
            if (trigFirst && o.chain === 'robinhood' && o.source === 'trade' && o.triggerHash && !o.entry) {
                  const tb = buildCheck('robinhood', o.tokenIn, o.buyPool, o.sellPool, o.tradeSizeUsd, o.usdPerTokenIn);
                  if (!('skip' in tb)) {
                        trigBuilt = tb;
                        trigP = trigFirst.check({ trade: tb.trade, simOpts: tb.simOpts, triggerHash: o.triggerHash, seenMs: o.seenAtMs, keys: routeKeys(o.buyPool, o.sellPool, tb.lender), label: label0 });
                  }
            }
            // CHECK FIRST, THEN SEND (core/checkFirst.ts, Oct 19, owner approved).
            // Live "follow a trade" sends: run the real check of our exact trade,
            // send only if it makes money. Order (execution/checkFirstFlow.ts):
            //   0. trigger-first, "on" mode + fast check ON: a SURE answer decides
            //      (no report wait, no receipt polling, no node); unknown -> 1.
            //   1. FAST CHECK: the same check, "right after the followed trade"
            //      (copy 2: after waiting for the trade's pool reports, on mode
            //      and every pool ready); on + sure answer -> it decides; shadow:
            //      the node's answer is recorded next to the fast one.
            //   2. the node: wait for the trade to land, then the node's check.
            // (Before: sent on the guess first; only about 1 in 5 guesses is a real win.)
            // Trigger-first ENTRY send: already checked (its exact trade on the
            // replayed feed, entry point); no guess, no waiting, no node.
            if (o.entry) { checkFirstDecidedBy = 'trig_first'; trigUsed = o.entry.out; }
            if (o.chain === 'robinhood' && robinhoodSender.live && o.source === 'trade' && checkFirstOn() && !o.entry) {
                  const startedMs = Date.now();
                  const fb = localSim && o.triggerHash ? buildCheck('robinhood', o.tokenIn, o.buyPool, o.sellPool, o.tradeSizeUsd, o.usdPerTokenIn) : null;
                  const built = fb && !('skip' in fb) ? fb : null;
                  const keys = built ? routeKeys(o.buyPool, o.sellPool, built.lender) : [];
                  const tf = trigFirst;
                  const tp = trigP;
                  const tbuilt = trigBuilt;
                  const run = await runCheckFirst<LocalCheck, RoundTripCheck>({
                        now: () => Date.now(),
                        mark: (stage) => markStretch(stage),
                        // 0. Trigger-first decides only in "on" mode while the fast check is ON.
                        trigFirst: tf && tp && tbuilt && tf.decides() ? async () => {
                              const out = await tp;
                              // Best effort: only answers at TRIG_FIRST_MIN_CONFIDENCE or better
                              // decide, and only while the scoreboard hasn't paused their bucket;
                              // otherwise the existing path decides, unchanged.
                              const held = out.sure ? (tf.sendGate(out) ?? scoreboard.pausedWhy('trig_first', out.confidence as ScoreConfidence | undefined, out.assumptions)) : null;
                              if (held) { console.log(`[trigger-first] ${label0}: sure answer (${out.verdict}, ${out.confidence}${out.assumptions?.length ? `: ${out.assumptions.join(', ')}` : ''}) not used: ${held}; the existing path decides`); return null; }
                              const tc = trigToCheck(out, tbuilt, o.tokenIn, o.usdPerTokenIn);
                              if (tc) { tf.noteDecided(o.triggerHash); trigUsed = out; }
                              return tc;
                        } : null,
                        hasBuilt: !!built,
                        copy2Running: () => !!localSim?.copy2Running(),
                        copy2Deciding: () => !!localSim?.isOn() && localSim.copy2?.notReadyWhy(keys) === null,
                        copy2WaitForTx: (ms) => localSim ? localSim.copy2WaitForTx(o.triggerHash, ms) : Promise.resolve(null),
                        copy2Route: (blk) => localSim?.copy2Route(keys, blk) ?? null,
                        startFast: (at) => built ? startFastCheck({ kind: 'trig_live', at, triggerHash: o.triggerHash, seenMs: o.seenAtMs, label: label0 }, built) : null,
                        fastDecide: (lc) => built ? fastDecide(lc, built, o.tokenIn, o.tradeSizeUsd, o.usdPerTokenIn) : Promise.resolve(null),
                        // Ask the SAME node that runs the check (simRpc): if another node saw the
                        // block first, the check could still run on the state before the trade.
                        // Polled every CHECK_FIRST_POLL_MS (50 ms; was 150 ms), for up to ~1.8 s.
                        waitForTrade: () => waitForTrade(simRpc.robinhood, o.triggerHash ?? '', CHECK_FIRST_POLL_MS, Math.ceil(1_800 / CHECK_FIRST_POLL_MS)),
                        // Live check-first: one simulation on the checking node, no second "free node"
                        // re-check unless the first answer is a reasonless failure (it only ever turns
                        // those into a clearer answer; a win or a loss is never re-asked).
                        nodeCheck: (lc) => checkRoundTrip('robinhood', o.tokenIn, o.buyPool, o.sellPool, o.tradeSizeUsd, o.usdPerTokenIn, lc ? { kind: 'trig_live', existing: lc } : undefined),
                        noNode: (lc) => lc?.noNode(),
                  });
                  const decidedBy = run.decidedBy;
                  const waitMs = run.waitMs;
                  if (!run.c) {
                        checkFirstStats.noLanding++;
                        trigFirst?.noteExisting(o.triggerHash, Date.now(), 'not sent: trigger not in a block in time');
                        block('check first: followed trade not in a block in time');
                        return;
                  }
                  const c: RoundTripCheck = run.c;
                  const checkMs = Date.now() - startedMs - waitMs;
                  markStretch('check-first result');
                  const v = decideCheckFirst(c, rhGasUsd(0.05), MIN_NET_PROFIT_USD, o.netProfitUsd);
                  const label = `${symbolOf(o.chain, o.tokenIn)}/${symbolOf(o.chain, o.tokenOut)} ${o.buyPool.dex}>${o.sellPool.dex}`;
                  const tookMs = Date.now() - startedMs;
                  checkFirstStats.ms.push(tookMs); checkFirstStats.waitMs.push(waitMs); checkFirstStats.checkMs.push(checkMs);
                  if (checkFirstStats.ms.length > 200) { checkFirstStats.ms.shift(); checkFirstStats.waitMs.shift(); checkFirstStats.checkMs.shift(); }
                  // Shadow: what the existing path decided, and when (trigger-first log).
                  if (decidedBy !== 'trig_first') trigFirst?.noteExisting(o.triggerHash, Date.now(), v.send ? `send (${c.status})` : `refuse (${c.status})`);
                  if (!v.send) {
                        checkFirstStats.refused++;
                        console.log(`[check-first] NOT SENT ${label}: guess $${o.netProfitUsd.toFixed(2)}, ${v.why} (${tookMs} ms: wait ${waitMs} + check ${checkMs})`);
                        if (v.blockPair) liveBlocks.block(o.buyPool.poolAddress, o.sellPool.poolAddress, v.why);
                        block(`check first: ${v.why.replace(/\$[\d.]+/g, '$N')}`);
                        return;
                  }
                  checkFirstStats.passed++;
                  console.log(`[check-first] PASSED ${label}: guess $${o.netProfitUsd.toFixed(2)}, real check $${v.netUsd.toFixed(2)} after gas (${tookMs} ms: wait ${waitMs} + check ${checkMs}${decidedBy === 'local' ? ', fast check' : decidedBy === 'trig_first' ? ', trigger-first' : ''}), sending`);
                  // Fast check's size search found a smaller, better size (never bigger:
                  // every size cap and the wallet fit above still hold).
                  if (c.status === 'profit' && c.sizeUsd !== undefined && c.sizeUsd < o.tradeSizeUsd) {
                        console.log(`[check-first] fast check size search: trading $${Math.round(c.sizeUsd)} instead of $${Math.round(o.tradeSizeUsd)}`);
                        o = { ...o, tradeSizeUsd: c.sizeUsd };
                  }
                  checkFirstDecidedBy = decidedBy;
                  // Never send on more than the check found; the outlier guard sees the check's number.
                  // The check already ran WITH the loan (same pickLender choice), so its profit is
                  // after the loan fee: record the fee it used, so the fee line below doesn't take
                  // it off a second time (Oct 20 fix: it was counted twice on flash-loan trades).
                  o = { ...o, netProfitUsd: v.netUsd, checkedProfitUsd: v.netUsd, plannedLoanPips: checkLoanPips(c) };
            }
            // Own money or loan (same choice as the practice check, see pickLender).
            const lender = pickLender(o.chain, o.tokenIn, o.buyPool, o.sellPool, o.tradeSizeUsd, o.usdPerTokenIn);
            let netProfitUsd = o.netProfitUsd;
            if (o.chain === 'robinhood') {
                  const actualPips = lender ? (lender.feePips ?? lender.feeBps * 100) : 0;
                  netProfitUsd -= extraLoanFeeUsd(o.tradeSizeUsd, actualPips, o.plannedLoanPips);
            }
            // The one send minimum, for every kind of trade (trigger and
            // sitting gap): MIN_NET_PROFIT_USD ($0.25 default since Oct 16) after all costs.
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
            if ('reason' in dry) { console.log(`[exec-dryrun] ${o.chain} NOT executable: ${dry.reason}`); if (liveRh) whyNotSent.blocked(`trade couldn't be built: ${dry.reason}`); return; }
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
                  if (robinhoodSender.live) { liveTradeLog.noteBlocked(r); whyNotSent.blocked(r); safetyAlerts.onBlocked('reason' in gate ? gate.reason : '', safetyGate.lossTodayUsd(true)); }
                  return;
            }
            if (robinhoodSender.live && !dry.to) {
                  fireStats.blocked.set('no executor deployed', (fireStats.blocked.get('no executor deployed') ?? 0) + 1);
                  return;
            }
            // SCOREBOARD: which path is sending, and is its bucket paused (its
            // recent real sends lost money)? Live only.
            const sendPath: SendPath = o.source === 'gap' ? 'gap'
                  : checkFirstDecidedBy === 'trig_first' ? 'trig_first'
                  : checkFirstDecidedBy === 'local' ? 'copy2'
                  : checkFirstDecidedBy === 'node' ? 'node' : 'guess';
            const trigConf = sendPath === 'trig_first' ? (trigUsed as TrigOutcome | null)?.confidence as ScoreConfidence | undefined : undefined;
            const trigAssumed = sendPath === 'trig_first' ? (trigUsed as TrigOutcome | null)?.assumptions : undefined;
            if (robinhoodSender.live) {
                  const paused = scoreboard.pausedWhy(sendPath, trigConf, trigAssumed);
                  if (paused) { block(`scoreboard: ${sendPath} paused (its recent real sends lost money)`); console.log(`[scoreboard] not sent (${sendPath}): ${paused}`); return; }
            }
            // FIRE-FIRST ONLY (Oct 24, owner): FIRE_FIRST_ONLY=1 = only the
            // trigger-first entry point (o.entry) may send real trades; the
            // older paths (standing gaps, follow-a-trade, model guesses) keep
            // running and checking but never send (today: 42 sent, 0 won, they
            // react after the block that rivals already filled). Old loops are
            // switched separately (LOOP_LIVE=0); fire-first loops are not
            // affected (they send through the entry point's own loop sender).
            // FAST STANDING GAPS (Oct 25, owner): GAP_LIVE_WITH_FIRE_FIRST=1 lets
            // standing gaps (source 'gap', each sent right after its own fresh
            // check that passed) send too; follow-a-trade guesses stay off.
            if (robinhoodSender.live && FIRE_FIRST_ONLY && !o.entry && !(o.source === 'gap' && GAP_LIVE_WITH_FIRE_FIRST)) {
                  block('fire-first only: older paths do not send (FIRE_FIRST_ONLY=1)');
                  return;
            }
            // ONE SEND PER TRIGGER (trigEntry.claim, shared lock): the entry point
            // and the old path never both send for the same followed trade.
            if (o.source === 'trade' && o.triggerHash && trigEntry && !trigEntry.claim(o.triggerHash, o.entry ? 'entry' : 'old')) {
                  block('another path already sent for this trigger');
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
            // FAST CHECK timing proof: trigger seen in the feed -> trade signed.
            if (localSim && checkFirstDecidedBy && fired.signedAtMs) localSim.noteSigned(o.triggerHash, o.seenAtMs, fired.signedAtMs, checkFirstDecidedBy);
            // Trigger-first decided: feed -> signed, and later vs its block's reports.
            if (trigFirst && checkFirstDecidedBy === 'trig_first' && !o.entry && fired.signedAtMs) trigFirst.noteSubmitted(o.triggerHash, fired.signedAtMs);
            if (o.entry && fired.signedAtMs) { try { o.entry.onSigned?.(fired.signedAtMs); } catch { /* reporting only */ } }
            const tradeLabel = `${symbolOf(o.chain, o.tokenIn)}/${symbolOf(o.chain, o.tokenOut)} ${o.buyPool.dex}>${o.sellPool.dex}`;
            if (fired.live && !fired.txHash && fired.error) { liveTradeLog.sendFailed(tradeLabel, o.tradeSizeUsd, fired.error); alertHooks.liveSendFailed(tradeLabel, fired.error); whyNotSent.blocked('node refused the send'); }
            // How this trade is paid for (Oct 20): own money, or a flash loan and its fee.
            const lenderPips = lender ? (lender.feePips ?? lender.feeBps * 100) : 0;
            const funding: Funding = dry.funding === 'v3-flash'
                  ? { kind: 'flash', feePct: lenderPips / 10_000, feeUsd: o.tradeSizeUsd * lenderPips / 1_000_000 }
                  : { kind: 'own' };
            if (fired.txHash) {
                  fireStats.sent++;
                  if (fired.live) whyNotSent.sent();
                  liveTradeLog.sent(fired.txHash, tradeLabel, o.tradeSizeUsd, netProfitUsd, funding);
                  // Our balances change when it lands: re-read them a few seconds later.
                  setTimeout(() => { void refreshOwnMoney(); }, 3_000);
                  // Worst-case gas (2x today's cost) held against the daily loss cap until the receipt.
                  safetyGate.reservePending(fired.txHash, 2 * rhGasUsd(0.05));
                  livePools.set(fired.txHash, [o.buyPool.poolAddress, o.sellPool.poolAddress]);
                  if (livePools.size > 500) livePools.delete(livePools.keys().next().value as string);
                  liveTracker.track(fired.txHash, { expectedProfitUsd: netProfitUsd, label: tradeLabel, sizeUsd: o.tradeSizeUsd, funding, routeKey: routeKeyFor(dry.hops.map((h) => h.kind), dry.funding === 'v3-flash') });
                  if (fired.live) scoreboard.noteSend({ hash: fired.txHash, path: sendPath, confidence: trigConf, assumptions: trigAssumed, expectedUsd: netProfitUsd, label: tradeLabel, pools: [o.buyPool.poolAddress, o.sellPool.poolAddress], ...(o.entry ? { src: 'entry' as const } : {}) });
            }
            console.log(`[fire] robinhood ${fired.live ? 'LIVE' : 'DRY RUN'} (${o.source}) ready ${readyMs}ms after ${o.source === 'trade' ? 'the trigger' : 'the price update'} (sign ${fired.signMs.toFixed(1)}ms${fired.sendMs !== undefined ? `, send ${fired.sendMs.toFixed(1)}ms` : ''})` +
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
// ==========================================================================
// FAST CHECK: start (execution/localSimHost.ts, docs/FAST_CHECK.md).
// LOCAL_SIM=off (default): nothing is created, no socket is opened.
// shadow / on: connect to the arbsim sidecar (run by pm2, never by the bot).
// Feed: the bot has ONE Robinhood sequencer feed (RobinhoodChainAdapter,
// wss://feed.mainnet.chain.robinhood.com); every raw message it receives is
// handed to the sidecar, unchanged, before it is parsed (one quick hand-off).
// Warm list (on connect and every 10 min): our contract, every watched pool,
// their coins, the V4 PoolManager, approved loan pools, known routers.
// ==========================================================================
localSim = createLocalSimHost(chainOn('robinhood'), {
      alert: (t) => { void sendTelegramMessage(escHtml(t)).catch(() => undefined); },
      // COPY 2 (execution/copy2.ts): the pools the block readers follow (watched
      // pairs + loop extra pools; set by the block reader setup below), with
      // their full details from the price cache. Used only while the fast check
      // runs in pool-events mode.
      copy2Pools: () => copy2PoolKeys().map((k) => cache.get('robinhood', k)),
      poolManager: ROBINHOOD_V4.POOL_MANAGER,
      // Copy 2 vs node disagreements: the node again, pinned at the copy's
      // block (tells "market moved" from "copy wrong"; a few an hour at most).
      nodeAtBlock: (q, blockTag) => simulateRoundTrip(simRpc.robinhood, 'robinhood', q.trade, { ...q.simOpts, blockTag }),
      warmSource: () => {
            const out: string[] = [];
            const exec = executorConfig('robinhood').executorAddress;
            if (exec) out.push(exec);
            out.push(ROBINHOOD_V4.POOL_MANAGER, ROBINHOOD_V4.UNIVERSAL_ROUTER, ROBINHOOD_TOKENS.WETH, ROBINHOOD_TOKENS.USDG);
            out.push(...ROBINHOOD_UR_COPIES);
            out.push(...Object.keys(routerRegistry.robinhood ?? {}));
            out.push(...approvedLenders('robinhood'));
            for (const pools of robinhoodWatcher.watchedPairPools()) {
                  for (const addr of pools) {
                        const p = cache.get('robinhood', addr);
                        // V4 pools have no address of their own (32-byte id): their
                        // state lives in the PoolManager, already on the list.
                        if (/^0x[0-9a-fA-F]{40}$/.test(addr)) out.push(addr);
                        if (p) out.push(p.tokenA, p.tokenB);
                        if (p?.v4?.hooks) out.push(p.v4.hooks);
                  }
            }
            return out;
      },
});
// TRIGGER-FIRST ENTRY POINT candidates (execution/trigEntry.ts): for the pools
// a feed transaction moved, every route the bot already knows how to trade:
// the same pair on another exchange (cache.findPeerPools), buy on one pool and
// sell on the other, both directions, starting from a coin we hold (USDG /
// WETH). Same rules as every trade: exchange cleared for trading
// (liveBlocker), both coins on the allowed list, size caps (MAX_TRADE_USD,
// own-money wallet, auto-vetted coin limit), the lender buildCheck picks.
type EntryHost = { buy: any; sell: any; tokenIn: string; tokenOut: string; usdPer: number };
type EntryRouteT = { buy: any; sell: any; tokenIn: string; tokenOut: string; id: string };
// 1. List the routes (cheap tuples, nothing built yet).
const entryRoutesOf = (keys: string[]): EntryRouteT[] => {
      const lc = (x: string) => (x ?? '').toLowerCase();
      return enumerateRoutes<any>(keys, {
            // (Freeze fix, Oct 23: the old fall-back walked a fresh copy of
            // every pool for each key the cache didn't hold, and could never
            // find one: the cache files every pool under its lower-case address.)
            pool: (k) => cache.get('robinhood', k),
            peers: (p) => cache.findPeerPools('robinhood', p.tokenA, p.tokenB, p.poolAddress),
            addr: (p) => p.poolAddress, tokens: (p) => [p.tokenA, p.tokenB],
            startCoins: [ROBINHOOD_TOKENS.USDG, ROBINHOOD_TOKENS.WETH],
            coinAllowed: (t) => safetyGate.isAllowed(t),
            venueBlocked: (buy, sell) => liveBlocker(buy, sell),
      });
};
// 2. Ranking facts: a start coin we hold first (own money, live: the wallet
//    has at least the smallest ladder size), then the model's quick price
//    check at that size (no node).
const entryUsdOf = (t: string) => priceOracle.getUsdPrice('robinhood', t) ?? 0;
const entryDecOf = (t: string) => TOKEN_DECIMALS.robinhood?.[(t ?? '').toLowerCase()];
const entryOwnOnly = () => RH_OWN_MONEY && !approvedLenders('robinhood').size;
const entryHeld = (r: { tokenIn: string }): boolean => {
      const smallest = trigEntry?.settings.sizesUsd[0] ?? 50;
      if (!entryOwnOnly() || !robinhoodSender.live) return true;
      const d = entryDecOf(r.tokenIn), px = entryUsdOf(r.tokenIn);
      return d !== undefined && px > 0 && ownMoney.availableUsd(r.tokenIn, px, d) >= smallest;
};
const entryScore = (r: { buy: any; sell: any; tokenIn: string }): number | null => {
      try {
            const smallest = trigEntry?.settings.sizesUsd[0] ?? 50;
            const d = entryDecOf(r.tokenIn), px = entryUsdOf(r.tokenIn);
            if (d === undefined || !(px > 0)) return null;
            return roundTripQuote(r.buy, r.sell, r.tokenIn, px, d)(smallest);
      } catch { return null; }
};
// 3. Build one candidate (null = can't: no price / decimals, no size room).
const entryBuild = ({ buy, sell, tokenIn, tokenOut }: EntryRouteT): EntryCandidate | null => {
      const usdPer = entryUsdOf(tokenIn);
      const dec = entryDecOf(tokenIn);
      if (!usdPer || dec === undefined) return null;
      const ownOnly = entryOwnOnly();
      // Size caps: MAX_TRADE_USD, own money (the wallet, live), auto-vetted coin limit.
      let maxSizeUsd = MAX_TRADE_USD;
      if (ownOnly) maxSizeUsd = Math.min(maxSizeUsd, OWN_MONEY_MAX_USD, robinhoodSender.live ? 0.98 * ownMoney.availableUsd(tokenIn, usdPer, dec) : OWN_MONEY_MAX_USD);
      if (involvesAutoVetted([tokenIn, tokenOut])) maxSizeUsd = Math.min(maxSizeUsd, AUTO_VET_MAX_TRADE_USD);
      if (!(maxSizeUsd > 0)) return null;
      const lender = pickLender('robinhood', tokenIn, buy, sell, maxSizeUsd, usdPer);
      const host: EntryHost = { buy, sell, tokenIn, tokenOut, usdPer };
      return {
            label: `${symbolOf('robinhood', tokenIn)}/${symbolOf('robinhood', tokenOut)} ${buy.dex}>${sell.dex}`,
            buyPool: buy.poolAddress, sellPool: sell.poolAddress, tokenIn, tokens: [tokenIn, tokenOut],
            keys: routeKeys(buy, sell, lender), maxSizeUsd, gasUsd: rhGasUsd(0.05),
            build: (usd) => { const b = buildCheck('robinhood', tokenIn, buy, sell, usd, usdPer); return 'skip' in b ? null : { trade: b.trade, simOpts: b.simOpts }; },
            usdOf: (units) => (Number(units) / 10 ** dec) * usdPer,
            host,
      };
};
// Two steps: routes for the moved pools, ranked and capped BEFORE building.
const entryCandidatesFor = (keys: string[], limit: number): { cands: EntryCandidate[]; found: number } => {
      const routes = entryRoutesOf(keys);
      const top = rankRoutes<EntryRouteT>(routes, entryHeld, entryScore, limit);
      const out: EntryCandidate[] = [];
      // Each carries its ranking facts, so 3-pool loops can be merged in by the same rule.
      for (const r of top) { const c = entryBuild(r); if (c) { c.rank = { held: entryHeld(r), score: entryScore(r) }; out.push(c); } }
      return { cands: out, found: routes.length };
};
// ONE TRIP table (execution/trigEntry.ts refreshTable): every pool copy 2
// follows, with ITS routes (same rules), ranking facts and build, so the
// sidecar can pick and check exactly what entryCandidatesFor would.
// Freeze fix (Oct 23): each pool's routes are listed only when the table
// builder reaches it (in small bites), and each route says what its
// question is made of (`inputs`: both pool states, their seen-fee records,
// the start coin's price and decimals), so an unchanged route is not built
// again (TRIG_ENTRY_TABLE_REUSE_MS). Same routes, same order as before.
const entryTableRoutes = (): TablePool[] => copy2PoolKeys().map((k) => ({
      pool: k,
      routes: () => entryRoutesOf([k]).map((r) => ({
            rid: r.id, held: entryHeld(r), score: entryScore(r), build: () => entryBuild(r),
            inputs: [r.buy, r.buy?.observedFee, r.sell, r.sell?.observedFee, entryUsdOf(r.tokenIn), entryDecOf(r.tokenIn)],
      })),
}));
// FIRE-FIRST 3-POOL LOOPS (execution/trigEntryLoops.ts, TRIG_ENTRY_LOOPS=1,
// the default). For each moved pool, loops start coin (USDG / WETH) -> A ->
// B -> start through it, from a LOOP INDEX worked out ahead of time (every
// TRIG_ENTRY_LOOP_INDEX_MS: rebuilt in ~2 ms bites when the pools copy 2
// follows change, and at least once a minute), never per trigger. Rules,
// the same as live loops (execution/loopLive.ts): exchange cleared for live
// trading and not practice-only, live coin rule (liveBlocker), the contract
// can run the pool, exact maths, deep enough (the loop finder's filter),
// every coin on the allowed list, middle coins passed the coin tax test
// (data/coin-tax.json), lender never one of the loop's pools, loop size
// limit and loop loss cap (LOOP_LIVE_MAX_TRADE_USD / LOOP_LIVE_LOSS_CAP_USD).
const entryLoopSettings = entrySettings(process.env, MIN_NET_PROFIT_USD);
const entryLoopTax = new CoinTaxFileView('data/coin-tax.json');
const entryLoopTaxOn = coinTaxConfigFromEnv(process.env).enabled;
const entryLoopUsd = (t: string) => priceOracle.getUsdPrice('robinhood', t);
// Oct 26: the same rules, but saying WHICH one turned the pool away (null =
// usable), so the hourly line can count reasons. Labels are short and carry
// no addresses (the live blocker's own text is cut at its first detail).
const entryLoopPoolWhy = (p: PoolState): string | null => {
      if (!p || p.chain !== 'robinhood') return 'not robinhood';
      const lb = liveBlocker(p, p);                             // venue / practice-only / live coin rule
      if (lb) return 'live rule: ' + lb.split(/[(:]/)[0].replace(/0x[0-9a-fA-F]+/g, '').trim().slice(0, 50);
      const kind = kindForPool(p);
      if (kind === null) return 'contract cannot run pool type'; // the contract can't run this pool type
      if (kind === KIND_V4_HOOKED && !v4KeyMatchesId(p)) return 'v4 key does not match';
      if (!hasExactMath(p)) return 'no exact price maths';      // no quick price check possible
      if (!deepEnough(p, decimalsOf, entryLoopUsd)) return 'too shallow'; // same depth filter as the loop finder
      return null;
};
const entryLoopPoolOk = (p: PoolState): boolean => entryLoopPoolWhy(p) === null;
const entryLoopIndex: EntryLoopIndex<PoolState> | null = entryLoopSettings.enabled && entryLoopSettings.loops && chainOn('robinhood')
      ? new EntryLoopIndex<PoolState>(loopIndexSettings(process.env), {
            pools: () => copy2PoolKeys().map((k) => cache.get('robinhood', k)).filter((p): p is PoolState => !!p),
            startCoins: [ROBINHOOD_TOKENS.USDG, ROBINHOOD_TOKENS.WETH],
            rules: () => {
                  entryLoopTax.refresh(); // at most once a minute
                  return {
                        key: (p: PoolState) => p.poolAddress, tokens: (p: PoolState) => [p.tokenA, p.tokenB] as [string, string],
                        poolOk: entryLoopPoolOk,
                        coinOk: (t: string, isStart: boolean) => safetyGate.isAllowed(t) && (isStart || !entryLoopTaxOn || entryLoopTax.verdict(t) === 'ok'),
                        // Same tests as poolOk / coinOk, with the reason (Oct 26, for counting only).
                        poolWhy: entryLoopPoolWhy,
                        coinWhy: (t: string, isStart: boolean) => !safetyGate.isAllowed(t) ? 'coin not on allowlist'
                              : (!isStart && entryLoopTaxOn && entryLoopTax.verdict(t) !== 'ok') ? `coin tax test ${entryLoopTax.verdict(t) ?? 'not run'}` : null,
                        depth: (p: PoolState) => poolDepthUsd(p, decimalsOf, entryLoopUsd) ?? 0,
                  };
            },
            log: (m) => console.log(m),
      })
      : null;
// LOOP LIST COIN TAX TESTS (Oct 26, owner approved). The tax tester belonged
// to the old loop finder (LOOP_TRADER), which is off, so the loop list's coin
// passes all expired (a pass counts for 6 h) and the list fell to 0 loops.
// When the old loop finder is off, the loop list runs its own tester: same
// test (core/coinTax.ts, a free simulation, NEVER sends), same file
// (data/coin-tax.json, so passes are shared), on the FREE public node (no
// paid-node use), LOOP_TAX_TESTS_PER_MIN (default 10) coins a minute. Only
// coins already on the allowed list are tested (safety gate unchanged).
// LOOP_TAX_TEST=0 turns it off.
const entryLoopTaxBook: CoinTaxBook | null = entryLoopIndex && entryLoopTaxOn && !loopCfg.enabled
      ? (() => {
            const freeRpc = makeRpc('https://rpc.mainnet.chain.robinhood.com');
            return new CoinTaxBook(coinTaxConfigFromEnv(process.env), (token, holder) => testCoinTax(freeRpc, token, holder), {
                  file: 'data/coin-tax.json',
                  log: (m) => console.log(m.replace('[loop]', '[trig-entry] loop')),
                  symbolOf: (t) => symbolOf('robinhood', t),
                  alwaysOk: [ROBINHOOD_TOKENS.WETH, ROBINHOOD_TOKENS.USDG],
            });
      })()
      : null;
if (entryLoopTaxBook) {
      const book = entryLoopTaxBook;
      const ask = () => {
            try {
                  const pools = copy2PoolKeys().map((k) => cache.get('robinhood', k)).filter((p): p is PoolState => !!p);
                  askLoopTaxTests(pools, {
                        tokens: (p: PoolState) => [p.tokenA, p.tokenB] as [string, string],
                        holder: (p: PoolState) => coinHolderOf(p as any),
                        allowed: (t: string) => safetyGate.isAllowed(t),
                  }, [ROBINHOOD_TOKENS.USDG, ROBINHOOD_TOKENS.WETH], book);
            } catch { /* next minute */ }
      };
      // Ask once a minute (first after 20 s, once the copy's pools are loaded);
      // run one test at a time, the book keeps the per-minute limit.
      setTimeout(ask, 20_000).unref?.();
      setInterval(ask, 60_000).unref?.();
      let testing = false;
      setInterval(() => {
            if (testing || !book.hasWork()) return;
            testing = true;
            void book.runNext().catch(() => false).finally(() => { testing = false; });
      }, 1_000).unref?.();
      setInterval(() => book.save(), 60_000).unref?.();
      console.log(`[trig-entry] loop list coin tax tests ON (old loop finder off): free node, ${coinTaxConfigFromEnv(process.env).perMin} a minute, allowed coins only`);
}
const entryLoopTaxText = (): string => {
      if (!entryLoopTaxBook) return '';
      const s = entryLoopTaxBook.stats();
      return `; coin tax tests: ${s.ok} ok, ${s.taxed} taxed, ${s.blocked} blocked, ${s.waiting} waiting, ${s.unclear} unclear`;
};
// Our gas for a loop of `pools` pools (calibrated loop estimate; a flash loan
// costs a bit more). Oct 25: 4-pool loops (TRIG_ENTRY_LOOP_POOLS_MAX=4) pass 4
// here, so their higher gas (~635k vs ~507k units) is what they are judged on.
const entryLoopGasUsd = (flash: boolean, pools = 3) => gasModel.loopUsd(pools, 0.05) + (flash ? Math.max(0, rhGasUsd(0.05, true) - rhGasUsd(0.05, false)) : 0);
const entryLoopStates = (l: EntryLoop): PoolState[] | null => {
      const st = l.keys.map((k) => cache.get('robinhood', k));
      return st.every((p) => !!p) ? (st as PoolState[]) : null;
};
// Ranking facts, same rule as 2-pool routes: a start coin we hold first, then
// the quick price check at the smallest ladder size ($, before gas), minus
// the loop's EXTRA gas over a 2-pool trade, so the two kinds compare fairly.
// Remembered while the loop's pool states and the coin price are the same.
const entryLoopMemo = new LoopScoreMemo();
const entryLoopHeld = (l: EntryLoop) => entryHeld({ tokenIn: l.start });
const entryLoopScore = (l: EntryLoop): number | null => {
      const st = entryLoopStates(l);
      if (!st) return null;
      const px = entryUsdOf(l.start), d = entryDecOf(l.start);
      if (d === undefined || !(px > 0)) return null;
      const smallest = trigEntry?.settings.sizesUsd[0] ?? 50;
      const q = entryLoopMemo.get(l.id, st, px, () => loopQuoteUsd(st, l.inIsA, smallest, px, d));
      return q === null ? null : q - Math.max(0, entryLoopGasUsd(false, l.keys.length) - rhGasUsd(0.05));
};
// Build one loop candidate (null = can't). Our exact contract call is built
// by the loop trader's own code (buildLoopTrade, the same hops live loops
// send); the lender (if the size needs one) is never one of the loop's pools
// (3 or 4 of them: every pool after the first two is passed as "also not").
const entryLoopBuild = (l: EntryLoop): EntryCandidate | null => {
      const st = entryLoopStates(l);
      if (!st) return null;
      const base = st[0].tokenA.toLowerCase() === l.start ? st[0].tokenA : st[0].tokenB; // the pool's own spelling
      const usdPer = entryUsdOf(base), dec = entryDecOf(base);
      if (!usdPer || dec === undefined) return null;
      const coins = [...new Set(l.tokens)];
      // Size caps: the loop limit ($10,000), own money (the wallet, live), auto-vetted coin limit.
      let maxSizeUsd = loopLiveCfg.maxTradeUsd;
      if (entryOwnOnly()) maxSizeUsd = Math.min(maxSizeUsd, OWN_MONEY_MAX_USD, robinhoodSender.live ? 0.98 * ownMoney.availableUsd(base, usdPer, dec) : OWN_MONEY_MAX_USD);
      if (involvesAutoVetted(coins)) maxSizeUsd = Math.min(maxSizeUsd, AUTO_VET_MAX_TRADE_USD);
      if (!(maxSizeUsd > 0)) return null;
      const cycle = {
            id: 0, sig: l.id, poolSet: [...l.keys].sort().join(','), base: l.start, tokens: [...l.tokens],
            hops: l.keys.map((k, i) => ({ poolKey: k, tokenIn: l.tokens[i], tokenOut: l.tokens[(i + 1) % l.keys.length], inIsA: l.inIsA[i] })),
      };
      // (The index already applied the live rules, so no rule lookups here: no node.)
      const tradeOf = (amountIn: bigint) => { const b = buildLoopTrade({ cycle, pools: st, amountIn }, () => true); return 'reason' in b ? null : b.trade; };
      if (!tradeOf(1n)) return null;
      const lenderAt = (usd: number) => pickLender('robinhood', base, st[0], st[1], usd, usdPer, st.slice(2).map((p) => p.poolAddress));
      const sizes = trigEntry?.settings.sizesUsd ?? [50];
      const mainLender = lenderAt(Math.min(sizes[sizes.length - 1], maxSizeUsd));
      const host: EntryLoopHost = { kind: 'loop', loop: l, base, usdPer, dec, coins };
      return {
            kind: 'loop',
            label: `loop ${[...l.tokens, l.start].map((t) => symbolOf('robinhood', t)).join('/')}`,
            buyPool: st[0].poolAddress, sellPool: st[st.length - 1].poolAddress, tokenIn: base, tokens: coins,
            keys: [...st.map((p) => p.poolAddress), ...(mainLender ? [mainLender.poolAddress] : [])],
            maxSizeUsd, gasUsd: entryLoopGasUsd(!!mainLender, l.keys.length),
            // Its own 30-min fail block: this exact loop (first pool + loop id).
            failKey: [l.keys[0], l.id],
            rank: { held: entryLoopHeld(l), score: entryLoopScore(l) },
            build: (usd) => {
                  const amountIn = loanUnits(usd, usdPer, dec);
                  if (amountIn === null || amountIn <= 0n) return null;
                  const t = tradeOf(amountIn);
                  if (!t) return null;
                  const lender = lenderAt(usd);
                  return { trade: t, simOpts: { weth: ROBINHOOD_TOKENS.WETH, ...(lender ? { v3Lender: lender.poolAddress } : {}) } };
            },
            usdOf: (units) => (Number(units) / 10 ** dec) * usdPer,
            host,
      };
};
// Per trigger: the moved pools' loops (index lookup), ranked, capped, then built.
const entryLoopCandidatesFor = (keys: string[], limit: number): { cands: EntryCandidate[]; found: number } => {
      if (!entryLoopIndex) return { cands: [], found: 0 };
      const idx = entryLoopIndex;
      const r = pickLoops(keys, (k) => idx.loopsFor(k), entryLoopHeld, entryLoopScore, limit, rankRoutes);
      const cands: EntryCandidate[] = [];
      for (const l of r.loops) { const c = entryLoopBuild(l); if (c) cands.push(c); }
      return { cands, found: r.found };
};
// The guarded loop send (same steps as a live loop after its check) and its loss cap.
const entryLoopSender: EntryLoopSender | null = entryLoopIndex ? new EntryLoopSender(
      { lossCapUsd: loopLiveCfg.lossCapUsd, maxTradeUsd: loopLiveCfg.maxTradeUsd, blockMs: Math.max(1, GAP_LIVE_FAIL_BLOCK_MIN) * 60_000 },
      {
            now: Date.now,
            live: () => robinhoodSender.live,
            // One shared loop loss cap with the live loop sender (LOOP_LIVE=1).
            otherLossTodayUsd: () => loopLive?.lossTodayUsd() ?? 0,
            otherPaused: () => loopLive?.pausedToday() ?? false,
            gasUsd: (flash, pools) => entryLoopGasUsd(flash, pools ?? 3),
            isOutlier: (net, size) => isOutlier(net, size, OUTLIER_CFG),
            safety: (sizeUsd, coins) => { const g = safetyGate.check({ tradeSizeUsd: sizeUsd, tokens: coins }); return g.ok ? null : ('reason' in g ? g.reason : 'blocked'); },
            ready: () => (liveChecks.ok ? null : 'live checks not passed'),
            deadline: () => robinhoodSender.deadlineBlock(),
            executor: () => executorConfig('robinhood').executorAddress,
            gasLimitOk: (units) => robinhoodSender.currentGasLimit - (robinhoodSender.l1GasNow * 3n) / 2n >= BigInt(Math.ceil(units * 1.2)),
            ownCovers: (t, a) => ownMoney.covers(t, a),
            lenderOk: (l, t, a) => !!lenderBalances.lastRefreshMs && lenderBalances.canLend(l, t, a, LENDER_HEADROOM),
            lenderFeePips: (l) => { const p = cache.get('robinhood', l); return p ? (p.feePips ?? p.feeBps * 100) : 0; },
            fire: (to, data) => robinhoodSender.fire(to, data),
            afterSent: (hash, info) => {
                  const funding: Funding = info.flash
                        ? { kind: 'flash', feePct: info.flash.feePips / 10_000, feeUsd: info.sizeUsd * info.flash.feePips / 1_000_000 }
                        : { kind: 'own' };
                  fireStats.sent++;
                  whyNotSent.sent();
                  liveTradeLog.sent(hash, info.label, info.sizeUsd, info.netUsd, funding);
                  setTimeout(() => { void refreshOwnMoney(); }, 3_000);
                  safetyGate.reservePending(hash, 2 * info.gasUsd);
                  liveTracker.track(hash, { expectedProfitUsd: info.netUsd, label: info.label, sizeUsd: info.sizeUsd, funding, routeKey: routeKeyFor(info.kinds, !!info.flash) });
                  // Scoreboard: path "trig_first", src "entry-loop"; pools = its 30-min fail-block keys.
                  if (robinhoodSender.live) scoreboard.noteSend({ hash, path: 'trig_first', confidence: info.pick.out.confidence as ScoreConfidence | undefined, assumptions: info.pick.out.assumptions, expectedUsd: info.netUsd, label: info.label, pools: info.failKey, src: 'entry-loop' });
            },
            log: (m) => console.log(m),
            alert: (html) => { void sendTelegramMessage(html).catch(() => undefined); },
      },
) : null;
entryLoopSenderRef = entryLoopSender;
// TRIGGER-FIRST: needs the fast check's connection and copy 2 (LOCAL_SIM
// shadow / on and LOCAL_SIM_TRIGGER_FIRST shadow / on).
try {
      const tfs = trigFirstSettings();
      if (localSim && tfs.mode !== 'off') {
            const host = localSim;
            trigFirst = new TriggerFirst({ client: host.client, settings: tfs, copy2: () => host.copy2, shadowLog: host.shadowLog, hostOn: () => host.isOn() });
            // A scoreboard step back still running from before a restart.
            const sb = scoreboard.stepBackActiveUntil();
            if (sb) trigFirst.stepBack(sb, 'scoreboard step back from before the restart');
            console.log(`[trigger-first] best effort: ${tfs.strict ? 'STRICT (no assumptions)' : `assumptions allowed: ${tfs.assume.join(', ') || 'none'}`}; lowest confidence that may send (on): ${tfs.minConfidence}`);
            // ENTRY POINT (TRIG_FIRST_ENTRY=1, default): every feed transaction.
            const es = entrySettings(process.env, MIN_NET_PROFIT_USD);
            if (es.enabled) {
                  const tf = trigFirst;
                  trigEntry = new TrigEntry({
                        tf, client: host.client, shadowLog: host.shadowLog, settings: es,
                        candidatesFor: (keys, limit) => entryCandidatesFor(keys, limit),
                        tableRoutes: entryTableRoutes,
                        // 3-POOL LOOPS (TRIG_ENTRY_LOOPS=1): candidates from the loop index,
                        // the loop safeguards (loop loss cap, size limit, in flight; live:
                        // the scoreboard's loop bucket too), and the hourly loop text.
                        ...(entryLoopIndex && entryLoopSender ? {
                              loopCandidatesFor: (keys: string[], limit: number) => entryLoopCandidatesFor(keys, limit),
                              loopGate: (p: EntryPick) => entryLoopSender.gate(p) ?? (robinhoodSender.live ? scoreboard.pausedWhy('loop') : null),
                              loopHourText: () => { const i = entryLoopIndex.info(); return `loop index ${i.loops} loops${i.loops4 || i.loops5 ? ` (${i.loops4} of them 4-pool, ${i.loops5} 5-pool)` : ''} over ${i.pools} pools${i.capped ? ' (capped)' : ''}, rebuilt in ${i.lastMs} ms (${loopSkipText(i.seen, i.skipped)}${entryLoopTaxText()}); ${entryLoopSender.hourLine()}`; },
                        } : {}),
                        // Our own sends (seen again in the feed) and our contract: never triggers.
                        isOurTx: (h) => livePools.has(h) || livePools.has(h.toLowerCase()),
                        ourAddresses: [executorConfig('robinhood').executorAddress, robinhoodSender.live ? robinhoodSender.address : undefined].filter((a): a is string => typeof a === 'string'),
                        killed: () => killSwitchOn(process.env.KILL_SWITCH) || existsSync(process.env.KILL_FILE ?? 'data/KILL'),
                        safety: (sizeUsd, tokens) => { const g = safetyGate.check({ tradeSizeUsd: sizeUsd, tokens }); return g.ok ? null : ('reason' in g ? g.reason : 'blocked'); },
                        failBlocked: (a, b) => (GAP_LIVE_FAIL_BLOCK_MIN > 0 ? gapFailBlocks.reason(a, b) ?? null : null),
                        pausedWhy: (conf, as) => scoreboard.pausedWhy('trig_first', conf as ScoreConfidence | undefined, as),
                        send: async (pick, trig) => {
                              // 3-pool loop: its own guarded send (no 2-pool fireTrade).
                              if (pick.cand.kind === 'loop') return entryLoopSender ? entryLoopSender.send(pick, trig) : { why: 'no loop sender' };
                              const h = pick.cand.host as EntryHost;
                              let signedMs: number | undefined; let why: string | undefined;
                              // The check already traded WITH the lender buildCheck picked: its fee is in the profit.
                              const lender = pickLender('robinhood', h.tokenIn, h.buy, h.sell, pick.sizeUsd, h.usdPer);
                              await fireTrade({
                                    chain: 'robinhood', tokenIn: h.tokenIn, tokenOut: h.tokenOut, buyPool: h.buy, sellPool: h.sell,
                                    tradeSizeUsd: pick.sizeUsd, netProfitUsd: pick.netUsd, checkedProfitUsd: pick.netUsd, usdPerTokenIn: h.usdPer,
                                    seenAtMs: trig.seenMs, source: 'trade', triggerHash: trig.hash,
                                    plannedLoanPips: lender ? (lender.feePips ?? lender.feeBps * 100) : 0,
                                    entry: { out: pick.out, onSigned: (ms) => { signedMs = ms; }, onBlocked: (r) => { why = r; } },
                              });
                              return { signedMs, why };
                        },
                  });
                  // The loop index starts building only when the entry point really works.
                  if (trigEntry.active() && entryLoopIndex) { entryLoopIndex.start(); console.log(`[trig-entry] 3-pool loops ON (TRIG_ENTRY_LOOPS=1): up to ${es.maxLoops} loops per trigger, loop index rebuilt every ${entryLoopIndex.s.checkMs / 1000} s if the pools changed (at least every ${entryLoopIndex.s.rebuildMs / 1000} s), ${entryLoopIndex.s.perPool} loops per pool${entryLoopIndex.s.poolsMax >= 4 ? `; 4-pool loops ON (TRIG_ENTRY_LOOP_POOLS_MAX>=4): ${entryLoopIndex.s.perPool4} more per pool` : ''}${entryLoopIndex.s.poolsMax >= 5 ? `; 5-pool loops ON (TRIG_ENTRY_LOOP_POOLS_MAX=5): ${entryLoopIndex.s.perPool5} more per pool` : ''}`); }
            }
      }
} catch (e) { console.log(`[trigger-first] could not start (${(e as Error).message}); the existing paths decide`); trigFirst = null; trigEntry = null; }
if (chainOn('robinhood')) {
      const rhAdapter = new RobinhoodChainAdapter();
      if (localSim) { const host = localSim; rhAdapter.setRawFrameTap((text) => host.forwardFeed(text)); }
      // Trigger-first: every feed message, complete, into its order buffer.
      // Then the ENTRY POINT (every transaction a possible trigger; never blocks the feed).
      if (trigFirst) { const tf = trigFirst; const te = trigEntry; rhAdapter.setFeedMsgTap((msgs, at, hr) => { tf.onFeedMsgs(msgs, at); te?.onFeedMsgs(msgs, at, hr); }); }
      // While a trigger is being worked on, big background jobs (gap scan,
      // loop scan, reports...) take shorter bites (TRIG_ENTRY_YIELD_SLICE_MS),
      // so the sidecar's answer is read sooner (core/chunked.ts).
      if (trigEntry) { const te = trigEntry; setSliceCap(() => te.sliceCapMs()); }
      chainManager.register(rhAdapter);
}
if (chainOn('monad')) chainManager.register(new MonadAdapter());
if (chainOn('avalanche')) chainManager.register(new AvalancheAdapter());

// Rival watch's per-transaction look, run in ~5 ms bites (see core/chunked.ts SlicedQueue).
const RIVAL_SLICED = process.env.RIVAL_SLICED !== '0';
const rivalQueue = new SlicedQueue(5);
// FEED TRADE TURNS (feed speed, Oct 24; core/chunked.ts TurnQueue): the heavy
// "decide" part of each Robinhood feed trade (plan the back-run against every
// partner pool, logs, checks, send) waits for its turn: same order as before,
// one trade per pass of the event loop, so the sidecar's answer for a
// fire-first trigger (and the next feed message) is read in between instead
// of after the whole message's trades. Everything before it (decode, pool
// lookup, instant price tracking, partner pools, prices) still runs at once,
// in feed order, exactly as before, and the decide part works on the pools
// it picked up then. FEED_TRADE_DEFER=0 = old behaviour (no wait at all).
const FEED_TRADE_DEFER = process.env.FEED_TRADE_DEFER !== '0';
const feedTurns = new TurnQueue();
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
      // Freeze fix 2 (Oct 24): queued in a SlicedQueue (same jobs, same order,
      // ~5 ms bites) instead of one setImmediate each, which Node ran all back
      // to back ("rival watch" freezes up to ~150 ms). RIVAL_SLICED=0 = old way.
      if (process.env.FEED_LAZY_SENDER !== '0') {
            const job = () => { try { timed('rival watch', () => rivalWatch.noteTx(raw?.to, raw?.hash, sender ?? raw?.from, raw?.value, sel)); } catch { /* never affects trading */ } };
            if (RIVAL_SLICED) rivalQueue.push(job); else setImmediate(job);
      }
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
    // DOUBLE-COUNT GUARD (core/tradeInclusion.ts, Oct 19): did the fresh read
    // already include the trade we follow? Then the planner must not apply it
    // again. TRADE_INCLUDED_CHECK=0 = old behaviour (always predict).
    const preReadPool = pool;
    pool = freshPool;
    const inclusion = swap.chain === 'robinhood' && process.env.TRADE_INCLUDED_CHECK !== '0' && swap.amountIn > 0n
          ? readIncludesTrade(preReadPool, pool, (p) => cache.predictPostTradeState(p, p.tokenA.toLowerCase() === swap.tokenIn.toLowerCase(), swap.amountIn))
          : { includes: false, share: null };
    if (inclusion.includes) tradeInclusionStats.included++; else if (inclusion.share !== null) tradeInclusionStats.notYet++;
    trace?.mark('prices');

    // OUR start coin (Oct 16, owner approved). Robinhood: if the other trader
    // sold a coin we don't hold (e.g. ORBIO) and the pair has USDG/WETH, our trade
    // starts and ends in USDG/WETH: buy the coin they just made cheap, sell it
    // where it's dear. Before, we started from THEIR coin (ORBIO), which live
    // can never send (we hold no ORBIO). TRIGGER_START_HELD=0 = old behaviour.
    // (Worked out from the trade alone; only moved up here so the start
    // coin's price can be read before the turn below.)
    const heldStart = swap.chain === 'robinhood' && process.env.TRIGGER_START_HELD !== '0'
          ? new Set([ROBINHOOD_TOKENS.USDG.toLowerCase(), ROBINHOOD_TOKENS.WETH.toLowerCase()]) : null;
    const flipStart = !!heldStart && !heldStart.has(swap.tokenIn.toLowerCase()) && heldStart.has(swap.tokenOut.toLowerCase());
    const planIn = flipStart ? swap.tokenOut : swap.tokenIn;   // we start and end with this
    const planOut = flipStart ? swap.tokenIn : swap.tokenOut;  // passes through in the middle

    // Wait for this trade's turn (see FEED_TRADE_DEFER above). The time
    // waited counts in the stage timers' "math" lap. Everything the decide
    // part plans with is fixed BEFORE the wait: the pool and partner states
    // picked up above, and the start coin's dollar price (read here, same
    // moment as the pools; USDG is always $1). So trades queued behind this
    // one, or a later feed message handled during the wait, can't change
    // what this trade decides.
    let usdAtTurn: number | null | undefined;
    if (FEED_TRADE_DEFER && swap.chain === 'robinhood') {
          usdAtTurn = priceOracle.getUsdPrice(swap.chain, planIn);
          await feedTurns.turn();
          markStretch('feed trade decide');
    }

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

// (Start coin chosen above, before the turn: see FEED_TRADE_DEFER.)
const usdPerToken = usdAtTurn !== undefined ? usdAtTurn : priceOracle.getUsdPrice(swap.chain, planIn);
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
      const loanBps = rh ? rhLoanFeeBps(planIn, pool, peer) : 9;
      const candidate = planBackrun(cache, pool, peer, swap, usdPerToken, {
            gasPriceUsd: rh ? rhGasUsd(0.05, loanBps !== null, [kindForPool(pool), kindForPool(peer)]) : 2,
            dexFeeBps: { buy: pool.feeBps, sell: peer.feeBps }, // overwritten per direction inside planBackrun
            flashLoanFeeBps: loanBps ?? 0,
            usingFlashLoan: !rh || loanBps !== null,
            safetyMarginPct: 0.15,
      }, decimalsOf(swap.chain, planIn), rh ? { refineSize: true, maxTradeUsd: involvesAutoVetted([swap.tokenIn, swap.tokenOut]) ? Math.min(MAX_TRADE_USD, AUTO_VET_MAX_TRADE_USD) : MAX_TRADE_USD, ...(loanBps === null ? { funding: 'own-capital' as const } : {}), ...(flipStart ? { startToken: planIn } : {}), ...(inclusion.includes ? { stateIncludesTrade: true } : {}) } : {});
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
swap.chain, [planIn, planOut],   // [0] = our start coin (outcome check reads it)
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
                  tokenIn: planIn, buyPool: buyPoolUsed, sellPool: sellPoolUsed, sizeUsd: sizing.optimalTradeSizeUsd,
                  modelGrossUsd: sizing.grossProfitUsd, usdPerToken, vetted: simVetted, triggerHash: (event.raw as any)?.hash,
            };
            research.offer(rc.reason, `${buyPoolUsed.poolAddress}>${sellPoolUsed.poolAddress}`, () => rc);
      }
}
if (sizing.grossProfitUsd >= SIM_MIN_GROSS_USD && simAllowed) {
      // Fast check timing: when this trigger was seen in the feed (one map entry, only for checked trades).
      if (localSim && swap.chain === 'robinhood') localSim.noteTrigger((event.raw as any)?.hash, event.receivedAtMs);
      queueSimulation(swap.chain, planIn, buyPoolUsed, sellPoolUsed, sizing.optimalTradeSizeUsd, sizing.grossProfitUsd, usdPerToken, (event.raw as any)?.hash, simVetted);
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
              const buyPrice = priceOf(buyPoolUsed, planIn, decimalsOf);
              const sellPrice = priceOf(sellPoolUsed, planIn, decimalsOf);
              if (buyPrice !== null && sellPrice !== null) {
                      const gapPct = spreadPct(buyPrice, sellPrice);
                      await sendTelegramMessage(formatSkippedOpportunity({
                              chain: swap.chain,
        pair: `${symbolOf(swap.chain, planIn)}/${symbolOf(swap.chain, planOut)}`,
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
            chain: swap.chain, tokenIn: planIn, tokenOut: planOut,
            buyPool: buyPoolUsed, sellPool: sellPoolUsed,
            tradeSizeUsd: sizing.optimalTradeSizeUsd, netProfitUsd: profit.conservativeNetProfitUsd,
            usdPerTokenIn: usdPerToken, seenAtMs: event.receivedAtMs, source: 'trade', trace,
            triggerHash: (event.raw as any)?.hash,
            // Planned with a loan fee only when own money is switched off.
            plannedLoanPips: swap.chain === 'robinhood' && !RH_OWN_MONEY ? (rhLoanFeeBps(planIn, buyPoolUsed, sellPoolUsed) ?? 0) * 100 : 0,
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
                        // Live layout: read the gas wallet every 5 min for the hourly
                        // "≈ N trades left" and the "gas low" alert (read only).
                        if (LIVE_LAYOUT) {
                              const checkGas = async () => {
                                    try {
                                          const g = await robinhoodSender.balanceCheck();
                                          const eth = Number(ethers.formatEther(g.balance));
                                          const ethUsd = priceOracle.getUsdPrice('robinhood', ROBINHOOD_TOKENS.WETH) ?? 0;
                                          const perTrade = gasModel.twoPool(!RH_OWN_MONEY).usd;
                                          liveGas.eth = eth;
                                          liveGas.tradesLeft = ethUsd > 0 && Number.isFinite(perTrade) && perTrade > 0 ? Math.floor((eth * ethUsd) / perTrade) : null;
                                          if (liveGas.tradesLeft !== null && liveGas.tradesLeft < LIVE_GAS_LOW_TRADES) alertHooks.center.raise('live-gas-low', gasLowSpec(liveGas.tradesLeft, eth));
                                          else if (liveGas.tradesLeft !== null) alertHooks.center.clear('live-gas-low', `Gas topped up: about ${liveGas.tradesLeft} trades left`);
                                    } catch (err) { console.warn('[live-telegram] gas read failed:', (err as Error).message); }
                              };
                              void checkGas();
                              setInterval(() => { void checkGas(); }, 5 * 60_000);
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
      // FAST STANDING GAPS (Oct 25, owner): the limits below were set when every
      // check cost node credits; the fast check on our own copy is free. All
      // are settings now (defaults = before):
      //   GAP_FAKE_MUTE_MS      a gap whose check said "not real" waits this long [30 min]
      //   GAP_PAIR_COOLDOWN_MS  the same pair is checked again after this [30 s]
      //   GAP_MAX_PER_SCAN      checks started per scan [2]
      //   GAP_SCAN_DEBOUNCE_MS  wait after a price change before scanning [50 ms]
      const GAP_FAKE_MUTE_MS = Number(process.env.GAP_FAKE_MUTE_MS ?? 30 * 60_000);
      const GAP_PAIR_COOLDOWN_MS = Number(process.env.GAP_PAIR_COOLDOWN_MS ?? 30_000);
      const GAP_MAX_PER_SCAN = Math.max(1, Number(process.env.GAP_MAX_PER_SCAN ?? 2));
      const GAP_SCAN_DEBOUNCE_MS = Math.max(0, Number(process.env.GAP_SCAN_DEBOUNCE_MS ?? 50));
      // ONE SEND PER GAP (Oct 25): pools a standing-gap send just went out on,
      // held GAP_SENT_POOL_HOLD_MS (default 3 s) so another route over the same
      // pool isn't sent too. Only after a CONFIRMED check (live or practice alike).
      const GAP_SENT_POOL_HOLD_MS = Math.max(0, Number(process.env.GAP_SENT_POOL_HOLD_MS ?? 3_000));
      const gapSentPools = new Map<string, number>();
      function gapPoolHold(pool: string, now = Date.now()): void {
            gapSentPools.set(pool.toLowerCase(), now + GAP_SENT_POOL_HOLD_MS);
            if (gapSentPools.size > 500) for (const [k, v] of gapSentPools) if (v <= now) gapSentPools.delete(k);
      }
      function gapPoolBusy(pool: string, now = Date.now()): boolean {
            return (gapSentPools.get(pool.toLowerCase()) ?? 0) > now;
      }
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
            gapScanQueued = setTimeout(() => { gapScanQueued = null; void timedAsync('gap scan', runGapScan); }, GAP_SCAN_DEBOUNCE_MS);
      };
      requestGapScan = () => {
            requestLoopScan(); // loop trader (off unless LOOP_TRADER=1): same triggers
            queueGapScan();
      };
      // Watched pairs' pools with real money near their price, built in steps
      // (pauses every 8 pairs). Same list as the old one-go build below.
      const usdRhGap = (t: string) => priceOracle.getUsdPrice('robinhood', t);
      function* gapPairsSteps(): Generator<void, PoolState[][], void> {
            const list = robinhoodWatcher.watchedPairPools();
            const out: PoolState[][] = [];
            for (let i = 0; i < list.length; i++) {
                  const ps: PoolState[] = [];
                  for (const a of list[i]) { const p = cache.get('robinhood', a); if (p && deepEnough(p, decimalsOf, usdRhGap)) ps.push(p); }
                  out.push(ps);
                  if ((i & 7) === 7) yield; // a pause every 8 pairs (was 32; same list)
            }
            return out;
      }
      const runGapScan = async () => {
            // Diet: no scan while gaps can't send (GAP_SCAN_ON, see top).
            if (!GAP_SCAN_ON) return;
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
                        perPair: 3,
                        // Oct 16 (owner approved): start every gap from a coin we hold
                        // (USDG/WETH) when the pair has one. GAP_START_HELD=0 = old rule.
                        ...(process.env.GAP_START_HELD !== '0' ? { startCoins: [ROBINHOOD_TOKENS.USDG, ROBINHOOD_TOKENS.WETH] } : {}) };
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
                        if (fired >= GAP_MAX_PER_SCAN) break;
                        // Fast scan runs in bites: a pool may have got a new price
                        // during a break. Such a gap is skipped (no check budget used,
                        // pair not muted) and one more scan runs with fresh prices.
                        if (GAP_SCAN_FAST && (cache.get('robinhood', g.buyPool.poolAddress) !== g.buyPool || cache.get('robinhood', g.sellPool.poolAddress) !== g.sellPool)) {
                              gapStaleSkips++;
                              gapAgain = true;
                              continue;
                        }
                        // ONE SEND PER GAP (Oct 25, live): one WETH/USDG gap was found
                        // as 3 routes sharing a pool, all 3 confirmed and all 3 sent in
                        // the same second; only one can win, the others only pay gas
                        // (and queued the sends behind each other: 0.8-2.6 s). Gaps
                        // come best first, so once a send went out on a pool, other
                        // routes using that pool wait GAP_SENT_POOL_HOLD_MS (until the
                        // first one has landed or failed). No check budget used.
                        if (gapPoolBusy(g.buyPool.poolAddress) || gapPoolBusy(g.sellPool.poolAddress)) { gapSamePoolSkips++; continue; }
                        const key = `${g.buyPool.poolAddress}>${g.sellPool.poolAddress}`;
                        const sig = `${poolSig(g.buyPool)}|${poolSig(g.sellPool)}`;
                        const bigChanged = g.profitUsd >= BENCH_BYPASS_USD && gapMutedSig.get(key) !== sig;
                        if (!bigChanged && Date.now() < (gapMutedUntil.get(key) ?? 0)) continue;
                        // Big gap ($1+) whose prices moved since this pair was last checked:
                        // skips the 30 s cooldown and the 6-a-minute budget (own cap below),
                        // so small gaps can't use up the checks a big one needs.
                        const bigFresh = g.profitUsd >= BENCH_BYPASS_USD && gapLastSig.get(key) !== sig;
                        if (!bigFresh && Date.now() - (gapLastFired.get(key) ?? 0) < GAP_PAIR_COOLDOWN_MS) continue;
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
                        // Fast check (LOCAL_SIM): same question on the newest state; shadow = compared
                        // only, on = a sure fast answer is used (unknown -> the node, as before).
                        const checkStarted = Date.now(); // timing (Oct 25): how long the check itself takes
                        const check = await checkRoundTrip('robinhood', g.quote, g.buyPool, g.sellPool, g.sizeUsd, g.quoteUsd, localSim ? { kind: 'gap', label: `${label} gap` } : undefined);
                        const checkMs = Date.now() - checkStarted;
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
                        if (check.status !== 'skipped') report4h(() => fourHour?.noteTest([poolKind(g.buyPool), poolKind(g.sellPool)], check.status === 'profit' ? simNet : undefined));
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
                              countVerifiedWin(gapNew, `${label} gap`, { startToken: g.quote, sizeUsd: g.sizeUsd, lender: check.trade.v3Lender, notLive: liveBlocker(g.buyPool, g.sellPool) ?? undefined }, [g.base, g.quote]);
                        }
                        if (gapNew > 0) profitBands.add(gapNew, torontoDay());
                        if (gapNew < simNet) console.log(`[gap] ${label}: same open gap grew, counted only the extra $${gapNew.toFixed(2)} of $${simNet.toFixed(2)}`);
                        // Would we really have won it? (ready = after our check + ~2 ms to sign)
                        void raceChecker.record({ label: `${label} gap`, pools: [g.buyPool.poolAddress, g.sellPool.poolAddress], netUsd: simNet, source: 'gap', readyDelayMs: Date.now() - spottedAt + 2 });
                        console.log(`[gap] standing gap ${label} CONFIRMED: real ~$${simNet.toFixed(2)} (model $${g.profitUsd.toFixed(2)}) on $${Math.round(g.sizeUsd)} | ${route} | check ${checkMs}ms, ${Date.now() - spottedAt}ms since spotted`);
                        // Hold both pools before the send starts (another scan may run meanwhile).
                        gapPoolHold(g.buyPool.poolAddress); gapPoolHold(g.sellPool.poolAddress);
                        await fireTrade({
                              chain: 'robinhood', tokenIn: g.quote, tokenOut: g.base, buyPool: g.buyPool, sellPool: g.sellPool,
                              // Never trust the model over the simulation.
                              // Fast check size search (on mode only) may pick a SMALLER size.
                              tradeSizeUsd: check.sizeUsd !== undefined && check.sizeUsd < g.sizeUsd ? check.sizeUsd : g.sizeUsd,
                              netProfitUsd: Math.min(g.profitUsd, simNet), usdPerTokenIn: g.quoteUsd,
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
            // COPY 2 (execution/copy2.ts; fast check on and in pool-events mode):
            // follows the same pools as the readers, gets every pushed pool event
            // through the WebSocket's tap, and fills in outages on the same HTTP node.
            copy2PoolKeys = () => { const t = targets(); return [...t.addrs, ...t.ids]; };
            const copy2Link = localSim?.copy2 ?? null;
            // Each copy-2 node read (block headers the WebSocket didn't give,
            // outage fill-ins) is counted under its own name in the node usage lines.
            const copy2RpcLabel = `${endpointLabel(READER_URL)} (copy 2 headers / fill-ins)`;
            if (copy2Link) nodeUsageCounter.track(copy2RpcLabel);
            copy2Link?.setBackfillRpc(async (method, params) => { nodeUsageCounter.countRequest(copy2RpcLabel); return readerRpc(method, params); });
            if (copy2Link && !process.env.BLOCK_READER_WSS) console.log('[copy2] needs the WebSocket block reader (BLOCK_READER_WSS): without it the node decides every check');
            if (process.env.BLOCK_READER_WSS) {
                  wsReader = new WsBlockReader({
                        url: process.env.BLOCK_READER_WSS,
                        httpRpc: readerRpc,
                        httpLabel: `${endpointLabel(READER_URL)} (block reader gap fills)`,
                        heads: process.env.BLOCK_READER_WSS_HEADS === '1',
                        // SPLIT (Oct 25): long topic lists go in pieces (Chainstack: "exceed max topics").
                        topicChunk: Number(process.env.BLOCK_READER_WSS_TOPIC_CHUNK) || 400,
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
                        // Copy 2 only (LOCAL_SIM shadow/on): unset = exactly as before.
                        ...(copy2Link ? { rawLogTap: copy2Link.tap } : {}),
                  });
                  wsReaderRef = wsReader; // read by the 4-hour report (connections)
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
            blockReaderStats = () => blockReader.stats(); // read by the 4-hour report (node errors)
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
            // Look up the start list's coins for the live coin rule now, in the background.
            void (async () => { for (const p of pairs) { await liveCoins?.lookup(p.a.toLowerCase()); await liveCoins?.lookup(p.b.toLowerCase()); } })();
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
      // Freeze fix 2 (Oct 24): the same file read in ~5 ms bites (the one-go
      // read above froze the bot ~880 ms live). SCAN_LOAD_CHUNKED=0 = the old
      // one-go read. Same state either way (core/universeScan.ts loadScanStateFile).
      const SCAN_LOAD_CHUNKED = process.env.SCAN_LOAD_CHUNKED !== '0';
      const loadScanStateAsync = async (): Promise<ScanState> => (SCAN_LOAD_CHUNKED ? loadScanStateFile(SCAN_STATE_FILE) : loadScanState());
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
                  // (Read in bites; another job may have loaded it meanwhile: keep that one.)
                  if (!scanState) { const st = await loadScanStateAsync(); scanState ??= st; }
                  // Scan on HEAVY (bursty: thousands of reads). If the paid
                  // node refuses (e.g. its plan limits log queries), try once
                  // on the fast node before waiting 15 min. Progress is saved
                  // per factory, so a second attempt repeats nothing.
                  const scanOpts = { usdToken: ROBINHOOD_TOKENS.USDG, wrappedNative: ROBINHOOD_TOKENS.WETH, minPoolUsd: SCAN_MIN_USD,
                        maxLogRange: Number(process.env.ROBINHOOD_SCAN_LOG_RANGE ?? 500_000), log: (m: string) => console.log(m),
                        v4: RH_V4_SCAN ? { stateView: ROBINHOOD_V4.STATE_VIEW, poolManager: ROBINHOOD_V4.POOL_MANAGER, extraTierPairs: Number(process.env.V4_EXTRA_TIER_PAIRS ?? 1_000) } : undefined,
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
                  const st = scanState ?? await loadScanStateAsync();
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
                  lastThinPoolCount = thin.length; // shown in the 4-hour report
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

      // UNISWAP V4 POOLS FROM EVENTS (core/v4EventDiscovery.ts, V4_DISCOVER_EVENTS,
      // default on): every V4 pool's key from the PoolManager's Initialize
      // events, so the pair watcher and the scan also find pools at fee
      // settings the fee list doesn't have. History read once (saved, resumed
      // after a restart), then one log request a minute. Free node, gentle
      // scan lane only (never the price-read path or the paid node).
      if (v4DiscoverCfg.enabled) {
            const index = new V4PoolIndex(v4DiscoverCfg.maxPools);
            const v4Discovery = new V4EventDiscovery({
                  poolManager: ROBINHOOD_V4.POOL_MANAGER, index, file: 'data/v4-pools.json',
                  fromBlock: v4DiscoverCfg.fromBlock, maxRange: v4DiscoverCfg.maxRange,
                  getLogs: makeV4InitGetLogs((m, p) => robinhoodScanProvider.send(m, p as any[]), ROBINHOOD_V4.POOL_MANAGER),
                  latestBlock: () => robinhoodScanProvider.getBlockNumber(),
            });
            setV4EventIndex(index, v4DiscoverCfg.maxPerPair);
            v4DiscoveryRef = v4Discovery;
            // First round (the history read) 90 s after start, then every minute.
            setTimeout(() => { void timedAsync('v4 event discovery', () => v4Discovery.poll()); }, 90_000);
            setInterval(() => { void timedAsync('v4 event discovery', () => v4Discovery.poll()); }, v4DiscoverCfg.pollMs);
            setInterval(() => { void timedAsync('v4 event discovery save', () => v4Discovery.save()); }, 10 * 60_000);
      }

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
                  const st = scanState ?? await loadScanStateAsync();
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
            const v4Line = v4DiscoveryStatus();
            if (v4Line) console.log(v4Line);
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

      // One hour of the hourly report's numbers as a plain HourSample for the
      // 4-hour totals (report/fourHourStats.ts). Reads only; called while the
      // hour's counters are still set (before the reset below).
      const hourSampleFrom = (r: PlainHourlyInput, fromMs: number, toMs: number, reactionN: number, stage: StageSummary, stall: StallSummary): HourSample => {
            const f = r.funnel;
            const lv = liveTracker.summary();
            const stages: HourSample['stages'] = {};
            for (const [k, v] of Object.entries(stage.stages)) stages[k] = { n: v.n, median: v.median, p95: v.p95 };
            return {
                  fromMs, toMs,
                  funnel: {
                        tradesRead: f?.tradesRead ?? 0, noPool: f?.noPool ?? 0, tooSmall: f?.tooSmall ?? 0, noPartner: f?.noPartner ?? 0,
                        noUsdPrice: f?.noUsdPrice ?? 0, smallerThanFees: f?.smallerThanFees ?? 0, found: f?.found ?? 0,
                        belowCheckBar: f?.belowCheckBar ?? 0, notVetted: f?.notVetted ?? 0, sentToCheck: f?.sentToCheck ?? 0,
                  },
                  checkBarUsd: f?.checkBarUsd ?? SIM_CHECK_BAR_USD,
                  checks: {
                        done: r.checks.done, makeMoney: r.checks.makeMoney, loseMoney: r.checks.loseMoney, wouldFail: r.checks.wouldFail,
                        // "Too late to test": failed because the price info was old (the price had moved).
                        tooLate: (r.checks.failReasons ?? []).find(([label]) => label === FAIL_GROUP_LABEL.stale)?.[1] ?? 0,
                        nodeBusy: r.checks.nodeBusy,
                  },
                  timing: r.checks.timing ? { ...r.checks.timing } : { rightAfter: 0, othersInBlock: 0, late: 0 },
                  benchedRoutes: r.checks.benchedRoutes ?? 0,
                  checksAvailable: r.checksAvailable,
                  race: r.race ? { won: r.race.won, lost: r.race.lost, unclear: r.race.unclear, wonUsd: r.race.wonUsd, lostUsd: r.race.lostUsd } : null,
                  reaction: { n: reactionN, medianMs: r.reactionMs.typical, p95Ms: r.reactionMs.slowest5pct },
                  stages,
                  stalls: { enabled: stall.enabled, thresholdMs: stall.thresholdMs, freezes: stall.freezes, worstMs: stall.worstMs,
                        causes: stall.causes.slice(0, 8).map((c) => [c.name, c.n, c.maxMs] as [string, number, number]), gcN: stall.gc.n, gcMs: stall.gc.totalMs },
                  rivalsSpeed: r.otherBots ? { ...r.otherBots } : null,
                  loops: lastLoopSample,
                  venues: venueTally.hourCounts(),
                  live: { sent: lv.sent, won: lv.won, profitUsd: lv.profitUsd, gasUsd: lv.gasUsd },
                  feedDrops: r.feedReconnects,
            };
      };

      let lastDigestAt = Date.now();
      // REPORT_V2 (Oct 15, owner approved, default on): the short plain hourly
      // message (src/report/hourlyReport.ts), sent at the top of each clock
      // hour, plus the 4-hour report. REPORT_V2=0: the old long hourly
      // message on the old timer, exactly as before, and no 4-hour report.
      // ONE COLLECTION: every hourly counter (loop hour, funnel, stage timers,
      // stall finder, race check, venue tally, rival hour, new pools, money
      // ledgers...) is taken exactly once per run of sendHourlyDigestInner.
      // That one set of numbers feeds the hourly message (new or old), the
      // 4-hour totals, and (sendHourly=false) the part-hour collection at a
      // 4-hour mark. Runs never overlap (see sendHourlyDigest below).
      const REPORT_V2 = reportV2On(process.env);
      // First report since the bot started: its window is partial.
      let firstHourlyReport = true;
      // Free node rests since start, at the last collection (to count this hour's).
      let lastFreeNodeSwitches = robinhoodReadProvider.router.getStats().switches;
      const sendHourlyDigestInner = async (sendHourly = true) => {
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
                        // V4 pools found by events vs by the fee list (core/v4EventDiscovery.ts).
                        const v4HourLine = v4DiscoveryStatus();
                        if (v4HourLine) console.log(v4HourLine);
                        // Loop numbers: from the loop worker by message when it runs (waits up to 3 s).
                        lastLoopSample = null; // filled by loopHourText when loop numbers arrive
                        const loopsHour = await loopHourText();
                        // Taken ONCE here (each take starts a fresh hour), shared by the
                        // hourly message (both versions) and the 4-hour totals.
                        const stageHour = stageTimers.take('hour');
                        const stallHour = stallFinder.take('hour');
                        const raceHour = raceChecker.takeHour();
                        const hourInput: PlainHourlyInput = {
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
                              speed: { median: stageHour.median, p95: stageHour.p95 },
                              // Stall finder: freezes this hour and what caused them (core/stallFinder.ts).
                              stalls: [formatStallLine(stallHour), formatStallDetail(stallHour)].filter(Boolean),
                              race: raceHour,
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
                        };
                        // ---- Hourly report v2 numbers (all already measured above) ----
                        const moneySnap = moneyLedgers.takePeriod();
                        // Window: since the last collection; the first one after a
                        // restart starts when the money counters started (bot start).
                        const fromMs = firstHourlyReport ? Math.min(moneySnap.periodStartMs, lastDigestAt) : lastDigestAt;
                        const ck = hourInput.checks;
                        // "waited too long in the check line" (queue time-outs) this hour.
                        let tooLate = 0;
                        for (const [why, c] of funnel.skip) if (why.startsWith('waited too long in the check line')) tooLate += c;
                        const v2Input: HourlyReportInput = {
                              live: robinhoodSender.live,
                              tz: REPORT_TZ,
                              tzLabel: REPORT_TZ === 'America/Toronto' ? 'Toronto' : REPORT_TZ,
                              restarted: firstHourlyReport && now - fromMs < FULL_HOUR_MIN_MS,
                              money: { ...moneySnap, periodStartMs: fromMs, periodEndMs: now },
                              startLabel: realisticPnl.cfg.startLabel,
                              normal: hourInput.checksAvailable || ck.done > 0 ? { won: ck.makeMoney, tested: ck.done } : null,
                              loop: lastLoopSample ? { won: lastLoopSample.wouldMake, tested: lastLoopSample.checked } : null,
                              races: { won: raceHour.won, lost: raceHour.lost, unclear: raceHour.unclear, pending: raceHour.pending },
                              feedOk: status.robinhood ? status.robinhood.online : null,
                              reactionMs: stats.medianReactionMs,
                              tooLate,
                              longestFreezeMs: stallHour.enabled ? stallHour.worstMs : null,
                              // Checking node "slow down" answers + free node rests, this hour.
                              nodeErrors: simStats.rateLimited + Math.max(0, rpc.switches - lastFreeNodeSwitches),
                        };
                        lastFreeNodeSwitches = rpc.switches;
                        // FAST CHECK hour line (also logged as "[local-sim] hour: ..."); taken
                        // every collection so each hour's numbers stand alone.
                        let fastLine: string | null = null;
                        try { fastLine = localSim?.takeHourLine() ?? null; } catch { /* reporting only */ }
                        // Trigger-first hour line (also logged as "[trigger-first] hour: ...").
                        try { const tl = trigFirst?.takeHourLine() ?? null; if (tl) fastLine = fastLine ? `${fastLine}\n${tl}` : tl; } catch { /* reporting only */ }
                        // Trigger-first ENTRY POINT hour line ("[trig-entry] hour: ...").
                        try { const el = trigEntry?.takeHourLine() ?? null; if (el) fastLine = fastLine ? `${fastLine}\n${el}` : el; } catch { /* reporting only */ }
                        // SCOREBOARD (real money by path / confidence, today, paused buckets).
                        let scoreLine: string | null = null;
                        try { scoreLine = scoreboard.hourText(fromMs, now); } catch { /* reporting only */ }
                        // Added only if the message stays under Telegram's 4,096-character
                        // limit (the scoreboard first, then the fast-check lines).
                        const withFast = (text: string) => {
                              const sc = scoreLine ? `${text}\n📊 ${escHtml(scoreLine)}` : text;
                              const t = fastLine ? `${sc}\n⚡ ${escHtml(fastLine)}` : sc;
                              return t.length <= 4096 ? t : sc.length <= 4096 ? sc : text;
                        };
                        // 4-hour totals: this collection's numbers, copied once, with the
                        // same money the hourly shows (reporting only, never throws).
                        if (fourHour) report4h(() => fourHour.addHour({ ...hourSampleFrom(hourInput, fromMs, now, stats.seen, stageHour.summary, stallHour), money: hourMoneyOf(moneySnap) }));
                        if (REPORT_V2) console.log(`[report] hourly v2${sendHourly ? '' : ' (collected for the 4-hour report, not sent)'}: checked ${moneySnap.checked.lastHour.toFixed(2)}, could earn live ${moneySnap.couldEarn.lastHour.toFixed(2)}, real ${moneySnap.real.lastHour.toFixed(2)}`);
                        if (sendHourly && LIVE_LAYOUT) {
                              const verdict = overallVerdict(v2Input);
                              await sendTelegramMessage(withFast(formatLiveHourly({
                                    tz: REPORT_TZ, fromMs, toMs: now,
                                    partial: v2Input.restarted ? 'bot restarted' : now - fromMs < FULL_HOUR_MIN_MS ? 'short hour' : null,
                                    hour: liveBook.window(fromMs, now),
                                    todayUsd: liveBook.today().usd,
                                    sinceStartUsd: liveBook.sinceStart(),
                                    wallet: LIVE_WALLET_COINS.map((c) => ({ coin: c.coin, now: walletWatch.now(c.coin), start: liveBook.startOf(c.coin), digits: c.digits })),
                                    gas: { ...liveGas },
                                    loss: { usedUsd: safetyGate.lossTodayUsd(), capUsd: safetyConfigFromEnv().dailyLossCapUsd },
                                    // What the wallet can really trade per coin (same cap as fit-to-wallet).
                                    biggestTrade: LIVE_WALLET_COINS.map((c) => {
                                          const dec = TOKEN_DECIMALS.robinhood?.[c.address.toLowerCase()];
                                          const px = priceOracle.getUsdPrice('robinhood', c.address);
                                          if (dec === undefined || !px || ownMoney.lastReadAgeMs() === null) return { coin: c.coin, usd: null };
                                          return { coin: c.coin, usd: Math.min(OWN_MONEY_MAX_USD, MAX_TRADE_USD, ownMoney.availableUsd(c.address, px, dec)) };
                                    }),
                                    bot: { ok: verdict.mark === '✅' && v2Input.feedOk !== false, text: verdict.text },
                                    loans: liveBook.loanSplit(fromMs, now),
                              })));
                        } else if (sendHourly) await sendTelegramMessage(withFast(hourlyMessage(REPORT_V2, v2Input, hourInput)));
                  } else if (sendHourly) await sendTelegramMessage(formatHourlyDigest({
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
                  firstHourlyReport = false;
            }
      };
      // Building the report is timed by the stall finder too.
      // sendHourly=false: take the hour's numbers into the 4-hour totals
      // without sending the hourly message (a part-hour at a 4-hour mark).
      // Runs are strictly one after another (a queue), so two runs can never
      // read the same counters (no double take, no lost hour).
      let digestQueue: Promise<void> = Promise.resolve();
      const sendHourlyDigest = (sendHourly = true): Promise<void> => {
            const run = digestQueue.then(() => timedAsync('hourly report', () => sendHourlyDigestInner(sendHourly)).then(() => undefined, () => undefined));
            digestQueue = run;
            return run;
      };
      // Set further down (4-hour report): called right after the top-of-hour
      // hourly when that hour is a 4-hour mark, so the hourly goes first and
      // the 4-hour report uses the same collection (no second take).
      let afterTopOfHour: (() => Promise<void>) | null = null;
      let lastHourlyKey = -1;
      if (REPORT_V2) {
            // Top of each clock hour (+1 s so the time reads 15:00, not 14:59).
            // Recomputed every time, so it never drifts.
            const scheduleNextHourly = () => {
                  const t = Date.now();
                  const next = Math.floor(t / 3_600_000) * 3_600_000 + 3_600_000 + 1_000;
                  setTimeout(() => {
                        scheduleNextHourly();
                        // One hourly per clock hour, even if the clock jumps (review fix).
                        const hourKey = Math.floor(Date.now() / 3_600_000);
                        if (hourKey === lastHourlyKey) return;
                        lastHourlyKey = hourKey;
                        void (async () => {
                              await sendHourlyDigest();
                              try { if (afterTopOfHour) await afterTopOfHour(); } catch (err) { console.error('[report4h] after hourly failed:', err); }
                        })();
                  }, next - t);
            };
            scheduleNextHourly();
      } else setInterval(sendHourlyDigest, 60 * 60 * 1000);
      // Stage timers: where the fire-ready time goes, every 5 min (median, then slowest 5%).
      setInterval(labelled('stall report', () => {
            const sp = stageTimers.take('fiveMin');
            console.log(`[speed] ${sp.median}`);
            console.log(`[speed] ${sp.p95}`);
            // Stall finder: freezes in the last 5 min and what caused them.
            const sf = stallFinder.take('fiveMin');
            // Plus how many gaps the fast scan skipped because prices moved during it.
            console.log(`[stalls] ${formatStallLine(sf)}${gapStaleSkips ? ` · gaps skipped (prices moved during the scan, rescanned): ${gapStaleSkips}` : ''}${gapSamePoolSkips ? ` · gap routes skipped (send just went out on the same pool): ${gapSamePoolSkips}` : ''}`);
            // Feed trade turns (FEED_TRADE_DEFER): how many decide parts waited, the longest line, how long.
            const ft = feedTurns.take();
            if (FEED_TRADE_DEFER && ft.n) console.log(`[feed-turns] 5 min: ${ft.n} trades decided one per loop pass · longest line ${ft.maxDepth} · wait p50 ${ft.p50} / p90 ${ft.p90} / max ${ft.max} ms`);
            gapStaleSkips = 0;
            gapSamePoolSkips = 0;
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
      // Telegram quickly instead of an hour later. REPORT_V2=0 only: with
      // REPORT_V2 the first hourly comes at the next top of the hour, marked
      // "partial (bot restarted)", and the startup alert confirms the deploy.
      if (!REPORT_V2) setTimeout(() => { void sendHourlyDigest(); }, 10 * 60 * 1000);

      // ======================================================================
      // 4-HOUR REPORT (REPORT_V2, default on; REPORT_V2=0 = off). Reporting only.
      // At 00:00, 04:00, 08:00, 12:00, 16:00 and 20:00 (REPORT_4H_TZ, default
      // Toronto): take the last part-hour into the totals, then send the 3
      // messages (report/fourHourReport.ts). The sent mark is saved, so a
      // restart never sends the same report twice. Robinhood-only setup only.
      // ======================================================================
      const REPORT_4H_TZ = process.env.REPORT_4H_TZ || 'America/Toronto';
      let sending4h = false;
      // The mark whose part-hour was already collected: a retry of the same
      // mark never takes the hourly counters again (review fix).
      let collectedMark = '';
      // collect=false: the top-of-hour hourly has just taken this hour's
      // numbers (one collection feeds both). collect=true (fallback, e.g. the
      // bot restarted at 16:10): take the part-hour first, without an hourly message.
      const sendFourHourReport = async (markKey: string, collect = true) => {
            if (!fourHour || sending4h) return;
            sending4h = true;
            let closed = false;
            try {
                  if (collect && collectedMark !== markKey) { collectedMark = markKey; await sendHourlyDigest(false); } // the numbers since the last hourly take
                  collectedMark = markKey;
                  const now = Date.now();
                  // The 4-hour mark this report ends at, and the one it starts at.
                  // (now minus the minutes and seconds past the mark's hour)
                  const markMs = now - zonedParts(now, REPORT_4H_TZ).minute * 60_000 - (now % 60_000);
                  const scheduledFromMs = markMs - 4 * 3600_000;
                  const fromMs = Math.max(scheduledFromMs, fourHour.peek(now).fromMs);
                  const status = chainManager.getStatus() as Record<string, { online: boolean }>;
                  const st = robinhoodWatcher.stats();
                  const rpc = robinhoodReadProvider.router.getStats();
                  const est = gasModel.twoPool(!RH_OWN_MONEY);
                  const mem = memReport ? memReport.sample() : process.memoryUsage();
                  const ws = wsReaderRef?.stats() ?? null;
                  const br = blockReaderStats ? blockReaderStats() : null;
                  const snap: FourHourSnapshot = {
                        live: robinhoodSender.live,
                        loansOn: !RH_OWN_MONEY,
                        pairs: st.pairs, pools: st.pools,
                        gasPerTradeUsd: Number.isFinite(est.usd) ? est.usd : null,
                        gasSamples: est.source === 'old' ? null : est.samples,
                        gasCalibrated: est.source === 'old' ? null : est.calibrated,
                        gasSource: est.source,
                        feePoolsFromSwaps: eventFeeCounts(cache.allForChain('robinhood')).fromEvents,
                        otherStables: stableTally.line(),
                        rivals: rivalWatch.summary(fromMs, now),
                        rivalBotsKnown: rivalWatch.botCount(),
                        newPools: newPoolWatchRef?.summary(fromMs, now) ?? null,
                        thinPools: lastThinPoolCount,
                        memory: { rssMb: Math.round(mem.rss / 1_048_576), peakRssMb: memReport ? Math.round(memReport.peakRss / 1_048_576) : null, heapMb: Math.round(mem.heapUsed / 1_048_576), notes: readMemNotes() },
                        feedOkNow: status.robinhood?.online ?? null,
                        ws: ws ? { healthy: ws.healthy, reconnects: fourHour.delta('ws reconnects', ws.reconnects), todayMessages: ws.todayMessages, cap: Number(process.env.BLOCK_READER_WSS_DAILY ?? 400_000), capped: ws.capped } : null,
                        checkNode: checkNodeLabel,
                        nodeErrors: {
                              blockReaderErrors: br ? fourHour.delta('block reader errors', br.errors) : null,
                              blockReaderRateLimited: br ? fourHour.delta('block reader rate limited', br.rateLimited) : null,
                              freeNodeRests: fourHour.delta('free node switches', rpc.switches),
                        },
                        nodeUsage: [...nodeUsageToday(), ...nodeUsageCounter.reportLines()],
                        loopsOn: loopCfg.enabled,
                        maxLoopPools: loopCfg.maxPools,
                        emergencyStop: killSwitchOn(process.env.KILL_SWITCH) || existsSync(process.env.KILL_FILE ?? 'data/KILL') ? 'on' : 'off',
                  };
                  // Close the period first: a failed send never makes a second copy later.
                  const { totals, prev } = fourHour.close(markKey, now);
                  closed = true;
                  const detail = formatFourHourReport({ tz: REPORT_4H_TZ, scheduledFromMs, toMs: now, totals, prevWins: prev, snap });
                  let msgs: string[] = detail;
                  if (LIVE_LAYOUT) {
                        const w = liveBook.window(fromMs, now), b = liveBook.breakdown(fromMs, now);
                        const live4h = formatLive4h({
                              tz: REPORT_4H_TZ, fromMs, toMs: now, keptUsd: w.usd, won: w.won, missed: w.missed,
                              best: b.best, gasUsd: w.gas, byHour: b.byHour, topPairs: b.topPairs,
                              found: Number.isFinite((totals as any)?.funnel?.found) ? (totals as any).funnel.found : null,
                              loans: liveBook.loanSplit(fromMs, now),
                        });
                        msgs = process.env.LIVE_TELEGRAM_DETAIL === '1' ? [live4h, ...detail] : [live4h];
                  }
                  console.log(`[report4h] sending 4-hour report ${markKey} (${msgs.map((m) => m.length).join('/')} chars)`);
                  for (const m of msgs) await sendTelegramMessage(m);
            } catch (err) {
                  console.error('[telegram] 4-hour report failed:', err);
            } finally {
                  // Never left open: a failure before close() (e.g. a snapshot
                  // read threw) closes the period anyway, so the fallback does
                  // not retry every minute (each retry used to take the hourly
                  // counters again). The numbers of that period are logged as lost.
                  if (!closed) {
                        try { fourHour.close(markKey, Date.now()); console.warn(`[report4h] ${markKey}: report failed before sending, period closed (not sent)`); } catch { /* reporting only */ }
                  }
                  sending4h = false;
            }
      };
      if (fourHour && chainOn('robinhood') && !chainOn('monad') && !chainOn('avalanche')) {
            // Normal path: right after the top-of-hour hourly (hourly first, then
            // the 3 messages of the 4-hour report, same collection).
            afterTopOfHour = async () => {
                  const mark = fourHourMark(Date.now(), REPORT_4H_TZ);
                  if (mark && mark !== fourHour.lastSentKey) await sendFourHourReport(mark, false);
            };
            // Fallback (a restart just after a mark, or the normal path failed):
            // checked every minute, but never in the first 3 minutes of an hour,
            // which belong to the normal path.
            setInterval(labelled('4h report check', () => {
                  const t = Date.now();
                  if (zonedParts(t, REPORT_4H_TZ).minute < 3) return;
                  const mark = fourHourMark(t, REPORT_4H_TZ);
                  if (mark && mark !== fourHour.lastSentKey) void sendFourHourReport(mark, true);
            }), 60_000);
            console.log(`[report4h] 4-hour report on (REPORT_V2), at 00/04/08/12/16/20 ${REPORT_4H_TZ}`);
      }

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
