import { ArbOpportunity, ChainName } from './types';

  // ============================================================================
  // TELEGRAM REPORTING — COLD PATH
  //
  // Per the architecture doc: Telegram should NOT show every technical
  // event, only what's useful to us as operators. This module only builds
  // message strings — actual sending (HTTP POST to the Telegram Bot API)
  // belongs in a thin sender wired in once a bot token exists, kept
  // separate so this stays testable without network calls.
  // ============================================================================

  export function formatSuccessfulTrade(params: {
chain: ChainName;
pair: string;
buyDex: string;
sellDex: string;
tradeSizeUsd: number;
fundingMethod: 'Flash Loan' | 'Own Capital';
grossProfitUsd: number;
flashLoanFeeUsd: number;
dexAndGasCostsUsd: number;
netProfitUsd: number;
reactionMs: number;
txHash: string;
}): string {
  return [
  'DEX ARB EXECUTED',
  `Chain: ${params.chain}`,
  `Pair: ${params.pair}`,
`Buy: ${params.buyDex}`,
  `Sell: ${params.sellDex}`,
  `Trade Size: $${params.tradeSizeUsd.toFixed(2)}`,
  `Funding: ${params.fundingMethod}`,
  `Gross Profit: $${params.grossProfitUsd.toFixed(2)}`,
  `Flash Loan Fee: $${params.flashLoanFeeUsd.toFixed(2)}`,
  `DEX + Gas Costs: $${params.dexAndGasCostsUsd.toFixed(2)}`,
  `NET PROFIT: $${params.netProfitUsd.toFixed(2)}`,
  `Reaction After Trigger: ${params.reactionMs}ms`,
  'Result: WON',
  `TX: ${params.txHash}`,
  ].join('\n');
        }

export function formatMissedOpportunity(params: {
chain: ChainName;
pair: string;
optimalTradeUsd: number;
expectedNetUsd: number;
ourReactionMs: number;
winner: string;
                 }): string {
  return [
  'LARGE ARB MISSED',
  `Chain: ${params.chain}`,
  `Pair: ${params.pair}`,
  `Optimal Trade: $${params.optimalTradeUsd.toFixed(0)}`,
  `Expected Net: $${params.expectedNetUsd.toFixed(0)}`,
  `Our Reaction: ${params.ourReactionMs}ms`,
  `Winner: ${params.winner}`,
  'Reason: Competitor landed first.',
  ].join('\n');
            }

// Only significant skips get sent — routine below-threshold skips stay in
// the analytics DB, not Telegram, per "no play-by-play noise."
export function formatSkippedOpportunity(params: {
chain: ChainName;
grossOpportunityUsd: number;
optimalTradeUsd: number;
expectedNetUsd: number;
minRequiredUsd: number;
                   }): string {
  return [
  'LARGE OPPORTUNITY SKIPPED',
  `Chain: ${params.chain}`,
  `Gross Opportunity: $${params.grossOpportunityUsd.toFixed(0)}`,
  `Optimal Trade: $${params.optimalTradeUsd.toFixed(0)}`,
  `Expected Net: $${params.expectedNetUsd.toFixed(0)}`,
  `Minimum: $${params.minRequiredUsd.toFixed(0)}`,
  'Decision: SKIPPED',
  'Reason: Profit below minimum after fees and safety margin.',
  ].join('\n');
              }

export interface HourlySummaryInput {
  activeChains: Record<ChainName, boolean>;
seen: number;
filtered: number;
simulated: number;
profitable: number;
attempted: number;
won: number;
missed: number;
reverted: number;
grossProfitUsd: number;
allCostsUsd: number;
netProfitUsd: number;
bestChain: { chain: ChainName; profitUsd: number };
bestTrade: { pair: string; netProfitUsd: number };
avgReactionMs: number;
p95ReactionMs: number;
}

export function formatHourlySummary(input: HourlySummaryInput): string {
  const chainLines = Object.entries(input.activeChains)
  .map(([chain, active]) => `${chain} ${active ? '✅' : '❌'}`)
.join('\n');

return [
  'DEX ARB HOURLY REPORT',
  '',
  'ACTIVE CHAINS',
  chainLines,
  '',
  'OPPORTUNITIES',
  `Seen: ${input.seen}`,
  `Filtered: ${input.filtered}`,
  `Simulated: ${input.simulated}`,
  `Profitable: ${input.profitable}`,
  `Attempted: ${input.attempted}`,
  '',
  'RESULTS',
  `Won: ${input.won}`,
  `Missed: ${input.missed}`,
  `Reverted: ${input.reverted}`,
  '',
  'PROFIT',
  `Gross: $${input.grossProfitUsd.toFixed(0)}`,
  `All Costs: $${input.allCostsUsd.toFixed(0)}`,
  `NET: $${input.netProfitUsd.toFixed(0)}`,
  '',
  'BEST CHAIN',
  `${input.bestChain.chain}: $${input.bestChain.profitUsd.toFixed(0)}`,
  '',
  'BEST TRADE',
  input.bestTrade.pair,
  `$${input.bestTrade.netProfitUsd.toFixed(0)} net`,
  '',
  'PERFORMANCE',
  `Average Reaction: ${input.avgReactionMs.toFixed(0)}ms`,
  `Fast 95% of Time: ${input.p95ReactionMs.toFixed(0)}ms`,
  ].join('\n');
          }

export interface DailySummaryInput {
  netProfitUsd: number;
byChain: Record<ChainName, number>;
won: number;
missed: number;
reverted: number;
fundingOwnCapitalPct: number;
fundingFlashLoanPct: number;
bestTradeUsd: number;
largestMissedUsd: number;
uptimePct: number;
}

export function formatDailySummary(input: DailySummaryInput): string {
  const byChainLines = Object.entries(input.byChain)
  .map(([chain, profit]) => `${chain}: $${profit.toFixed(0)}`)
  .join('\n');

return [
  'DEX ARB DAILY REPORT',
  '',
  `Net Profit: $${input.netProfitUsd.toFixed(0)}`,
  '',
  'BY CHAIN',
  byChainLines,
  '',
  `Trades Won: ${input.won}`,
  `Missed: ${input.missed}`,
  `Reverted: ${input.reverted}`,
  '',
  'Funding:',
  `Own Capital: ${input.fundingOwnCapitalPct.toFixed(0)}%`,
  `Flash Loans: ${input.fundingFlashLoanPct.toFixed(0)}%`,
  '',
  `Best Trade: $${input.bestTradeUsd.toFixed(0)}`,
  `Largest Missed Opportunity: $${input.largestMissedUsd.toFixed(0)}`,
  `Bot Uptime: ${input.uptimePct.toFixed(1)}%`,
  ].join('\n');
                }
