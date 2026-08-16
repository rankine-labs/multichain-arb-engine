import { formatSuccessfulTrade, formatMissedOpportunity, formatSkippedOpportunity, formatHourlySummary, formatDailySummary } from '../core/telegramFormatter';

function assert(cond: boolean, msg: string) {
if (!cond) {
console.error(`FAIL: ${msg}`);
process.exitCode = 1;
} else {
console.log(`PASS: ${msg}`);
}
}

const successMsg = formatSuccessfulTrade({
chain: 'avalanche', pair: 'WETH / USDC', buyDex: 'LFJ', sellDex: 'Pharaoh',
tradeSizeUsd: 82_400, fundingMethod: 'Flash Loan',
grossProfitUsd: 486.21, flashLoanFeeUsd: 41.20, dexAndGasCostsUsd: 58.17,
netProfitUsd: 386.84, reactionMs: 19, txHash: '0xabc123',
});
assert(successMsg.includes('DEX ARB EXECUTED'), 'success message has correct header');
assert(successMsg.includes('NET PROFIT: $386.84'), 'success message shows correct net profit');
assert(successMsg.includes('Result: WON'), 'success message declares WON');

const missedMsg = formatMissedOpportunity({
chain: 'avalanche', pair: 'WETH / USDC', optimalTradeUsd: 281_000,
expectedNetUsd: 927, ourReactionMs: 34, winner: 'Another Searcher',
});
assert(missedMsg.includes('LARGE ARB MISSED'), 'missed message has correct header');
assert(missedMsg.includes('Winner: Another Searcher'), 'missed message shows winner');

const skippedMsg = formatSkippedOpportunity({
    chain: 'avalanche', pair: 'WETH.../USDC...', buyDex: 'traderjoe-v1', sellDex: 'pharaoh',
    buyPrice: 42.10, sellPrice: 42.35, spreadPct: 0.59,
    grossOpportunityUsd: 738, optimalTradeUsd: 191_000,
    expectedNetUsd: 24, minRequiredUsd: 30,
});
assert(skippedMsg.includes('SKIPPED'), 'skipped message declares SKIPPED');
assert(skippedMsg.includes('Minimum: $30'), 'skipped message shows the minimum threshold');

const hourly = formatHourlySummary({
activeChains: { avalanche: true, monad: true, robinhood: true },
seen: 12421, filtered: 12019, simulated: 402, profitable: 31, attempted: 13,
won: 9, missed: 4, reverted: 0,
grossProfitUsd: 1927, allCostsUsd: 381, netProfitUsd: 1546,
bestChain: { chain: 'avalanche', profitUsd: 711 },
bestTrade: { pair: 'WETH / USDC', netProfitUsd: 312 },
avgReactionMs: 24, p95ReactionMs: 51,
});
assert(hourly.includes('NET: $1546'), 'hourly summary computes net correctly');
assert(hourly.includes('avalanche ✅'), 'hourly summary shows active chain status');

const daily = formatDailySummary({
netProfitUsd: 5842,
byChain: { avalanche: 2731, monad: 1082, robinhood: 500 },
won: 41, missed: 16, reverted: 2,
fundingOwnCapitalPct: 18, fundingFlashLoanPct: 82,
bestTradeUsd: 742, largestMissedUsd: 1214, uptimePct: 99.9,
});
assert(daily.includes('Net Profit: $5842'), 'daily summary shows correct net profit');
assert(daily.includes('Bot Uptime: 99.9%'), 'daily summary shows uptime');
