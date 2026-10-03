import {
  formatSuccessfulTrade, formatMissedOpportunity, formatSkippedOpportunity,
  formatHourlyDigest, formatDailyReport, formatStartup, formatExecutionWarning,
  formatPrice, esc,
} from '../core/telegramFormatter';
import { capLength, htmlToPlain } from '../core/telegramSender';

// Checks every Telegram message: right content, readable layout, and valid
// HTML (Telegram rejects a message with unbalanced tags or a raw '<' / '&').

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// Only the tags we use, balanced, and no raw '<' or '&' outside tags/entities.
function validTelegramHtml(html: string): boolean {
  const tags = html.match(/<\/?[a-z]+>/g) ?? [];
  const stack: string[] = [];
  for (const t of tags) {
    const name = t.replace(/[<>/]/g, '');
    if (!['b', 'i', 'pre', 'code'].includes(name)) return false;
    if (t.startsWith('</')) { if (stack.pop() !== name) return false; } else stack.push(name);
  }
  if (stack.length) return false;
  const stripped = html.replace(/<\/?(b|i|pre|code)>/g, '');
  return !/<|>/.test(stripped) && !/&(?!(amp|lt|gt);)/.test(stripped);
}

// ---- trade messages ---------------------------------------------------------
const success = formatSuccessfulTrade({
  chain: 'avalanche', pair: 'WETH/USDC', buyDex: 'traderjoe-v1', sellDex: 'pharaoh',
  tradeSizeUsd: 82_400, fundingMethod: 'Flash Loan',
  grossProfitUsd: 486.21, flashLoanFeeUsd: 41.2, dexAndGasCostsUsd: 58.17,
  netProfitUsd: 386.84, reactionMs: 19, txHash: '0xabc123',
});
assert(success.startsWith('✅ <b>TRADE WON</b> · Avalanche'), 'trade won: header');
assert(success.includes('Net           $386.84'), 'trade won: aligned net profit');
assert(validTelegramHtml(success), 'trade won: valid HTML');

const missed = formatMissedOpportunity({
  chain: 'monad', pair: 'WMON/USDC', optimalTradeUsd: 281_000,
  expectedNetUsd: 927, ourReactionMs: 34, winner: 'Another Searcher',
});
assert(missed.startsWith('❌ <b>MISSED</b> · Monad'), 'missed: header');
assert(missed.includes('Another Searcher'), 'missed: winner shown');
assert(validTelegramHtml(missed), 'missed: valid HTML');

// ---- near miss --------------------------------------------------------------
const near = formatSkippedOpportunity({
  chain: 'monad', pair: 'WMON/USDC', buyDex: 'uniswap-v3', sellDex: 'pancakeswap-v3',
  buyPrice: 0.031423, sellPrice: 0.031159, spreadPct: 0.84,
  grossOpportunityUsd: 35, optimalTradeUsd: 4_200, expectedNetUsd: 12, minRequiredUsd: 20,
});
assert(near.startsWith('⚠️ <b>NEAR MISS</b> · Monad'), 'near miss: header');
assert(near.includes('<b>WMON/USDC</b>  spread 0.84%'), 'near miss: pair + spread line');
assert(near.includes('Net    $12   need $20'), 'near miss: net vs minimum');
assert(near.includes('0.0314') && !/e-\d/.test(near), 'near miss: readable price, no scientific notation');
assert(validTelegramHtml(near), 'near miss: valid HTML');

// DEX names with HTML-special characters must be escaped.
const nasty = formatSkippedOpportunity({
  chain: 'monad', pair: 'A&B/<C>', buyDex: 'x<y', sellDex: 'p&q',
  buyPrice: 1, sellPrice: 1.01, spreadPct: 1, grossOpportunityUsd: 1,
  optimalTradeUsd: 1, expectedNetUsd: 1, minRequiredUsd: 20,
});
assert(validTelegramHtml(nasty) && nasty.includes('A&amp;B/&lt;C&gt;'), 'special characters escaped');

// ---- hourly digest ----------------------------------------------------------
const digest = formatHourlyDigest({
  windowLabel: '09:00 to 10:00',
  chains: [
    { chain: 'avalanche', healthy: true, reconnects: 0 },
    { chain: 'monad', healthy: true, reconnects: 2 },
    { chain: 'robinhood', healthy: false, reconnects: 1 },
  ],
  stats: { seen: 142, won: 2, lost: 1, netUsd: 64, avgReactionMs: 41.2, p95ReactionMs: 118 },
  sections: [
    { chain: 'monad', noMatchCount: 4, spreads: [
      { pair: 'AUSD/USDC', spreadPct: 0.08, buyDex: 'uniswap-v3', sellDex: 'lfj-v1' },
      { pair: 'WMON/USDC', spreadPct: 0.42, buyDex: 'uniswap-v3', sellDex: 'pancakeswap-v3' },
    ] },
    { chain: 'robinhood', spreads: [{ pair: 'WETH/USDG', spreadPct: 0.15, buyDex: 'ramses-v2', sellDex: 'pancakeswap-v3' }] },
    { chain: 'avalanche', spreads: [] },
  ],
});
assert(digest.startsWith('📊 <b>HOURLY REPORT</b> · 09:00 to 10:00'), 'digest: header with window');
assert(digest.includes('✅ Monad <i>(2 reconnects)</i>'), 'digest: reconnects folded into chain line');
assert(digest.includes('❌ Robinhood'), 'digest: down chain shown');
assert(digest.includes('Seen             142') && digest.includes('Would win          2') && digest.includes('Net (shadow)     $64'), 'digest: aligned stats');
assert(digest.includes('41ms avg · 118ms p95'), 'digest: speed line');
assert(digest.indexOf('WMON/USDC') < digest.indexOf('AUSD/USDC'), 'digest: widest spread first');
assert(digest.includes('4 more pairs: no match'), 'digest: unmatched watch pairs summarised');
assert(digest.includes('AVALANCHE\nno matches this hour'), 'digest: empty chain gets one line');
assert(!/Filtered|All Costs|Best Chain|n\/a/.test(digest), 'digest: no always-zero fields');
assert(validTelegramHtml(digest), 'digest: valid HTML');

// Many pairs: capped per chain, still valid.
const many = formatHourlyDigest({
  windowLabel: 'x', chains: [], stats: { seen: 0, won: 0, lost: 0, netUsd: 0, avgReactionMs: null, p95ReactionMs: null },
  sections: [{ chain: 'monad', spreads: Array.from({ length: 10 }, (_, i) => ({ pair: `T${i}/USDC`, spreadPct: i, buyDex: 'a', sellDex: 'b' })) }],
});
assert(many.includes('+4 more pairs') && !many.includes('Speed'), 'digest: caps pairs per chain, hides speed with no data');

// ---- daily ------------------------------------------------------------------
const daily = formatDailyReport({
  dateLabel: 'Sat Oct 3',
  stats: { seen: 900, won: 18, lost: 7, netUsd: 412, avgReactionMs: 40, p95ReactionMs: 110 },
  bestTradeUsd: 88, largestMissUsd: 140,
  uptimePct: { avalanche: 100, monad: 99.4, robinhood: null },
});
assert(daily.startsWith('📅 <b>DAILY REPORT</b> · Sat Oct 3'), 'daily: header');
assert(daily.includes('Monad up       99.4%') && !daily.includes('Robinhood up'), 'daily: uptime per chain, skips chains with no data');
assert(daily.includes('Best trade $88 · Largest miss $140'), 'daily: best/largest footnote');
assert(validTelegramHtml(daily), 'daily: valid HTML');

// ---- lifecycle --------------------------------------------------------------
const start = formatStartup({ avalanche: { online: true }, monad: { online: true }, robinhood: { online: false } });
assert(start === '▶️ <b>BOT STARTED</b> · shadow mode\n✅ Avalanche  ✅ Monad  ❌ Robinhood', 'startup message');
assert(validTelegramHtml(formatExecutionWarning()), 'execution warning: valid HTML');

// ---- helpers ----------------------------------------------------------------
assert(formatPrice(3412.556) === '3,412.56' && formatPrice(0.031423) === '0.03142' && formatPrice(0.0000048111) === '0.000004811',
  'formatPrice picks sensible precision');
assert(esc('a<b>&c') === 'a&lt;b&gt;&amp;c', 'esc');
assert(htmlToPlain('<b>X</b> &lt;1&gt; &amp;') === 'X <1> &', 'plain-text fallback strips tags, restores characters');
const long = capLength('<pre>' + 'line\n'.repeat(2000) + '</pre>');
assert(long.length <= 4100 && validTelegramHtml(long), 'over-long message trimmed and still valid');
