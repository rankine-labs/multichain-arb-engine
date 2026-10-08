import { ChainName } from './types';
import type { RivalSummary } from './rivalWatch';
import type { NewPoolSummary } from './newPoolWatch';
import type { LoopRow, PegRow, LoopQuote } from './crossQuoteMonitor';
import type { GapRow } from './crossQuoteMonitor';

// ============================================================================
// TELEGRAM MESSAGE FORMATTING -- COLD PATH
//
// Builds message text only; sending lives in telegramSender.ts so this stays
// testable without network calls.
//
// Messages use Telegram's HTML mode:
//   <b>bold</b> for headers, <pre>...</pre> for aligned number blocks,
//   <i>italic</i> for footnotes. Anything that comes from data (DEX names,
//   pair labels, commit subjects) goes through esc() first -- an unescaped
//   "<" or "&" would make Telegram reject the whole message.
//
// Style rules (keep new messages consistent):
//   - first line: one emoji + BOLD TITLE + muted context ("· Monad")
//   - numbers live in <pre> blocks, labels padded so values line up
//   - no fields that are always 0 / n/a; omit until real data exists
// ============================================================================

const CHAIN_LABEL: Record<string, string> = {
  avalanche: 'Avalanche',
  monad: 'Monad',
  robinhood: 'Robinhood',
};
export const chainLabel = (c: string): string => CHAIN_LABEL[c] ?? c;

// Escapes the three characters Telegram's HTML mode cares about.
export function esc(s: string | number): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// One aligned "label   value" row for a <pre> block.
function row(label: string, value: string, width = 14): string {
  return `${label.padEnd(width)}${value}`;
}

const usd = (n: number, digits = 0): string =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

// Prices: enough significant digits to be useful at any magnitude
// (3,412.55 / 0.03142 / 0.000004811), never raw float noise.
export function formatPrice(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: abs >= 1000 ? 2 : 4 });
  const leadingZeros = Math.max(0, Math.ceil(-Math.log10(abs)));
  return n.toFixed(Math.min(leadingZeros + 3, 18));
}

const pct = (n: number, digits = 2): string => `${n.toFixed(digits)}%`;

// ----------------------------------------------------------------------------
// Trades (used once live execution exists)
// ----------------------------------------------------------------------------

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
    `✅ <b>TRADE WON</b> · ${esc(chainLabel(params.chain))}`,
    `<b>${esc(params.pair)}</b>  ${esc(params.buyDex)} → ${esc(params.sellDex)}`,
    '<pre>' + [
      row('Size', usd(params.tradeSizeUsd)),
      row('Funding', params.fundingMethod),
      row('Gross', usd(params.grossProfitUsd, 2)),
      row('Flash fee', usd(params.flashLoanFeeUsd, 2)),
      row('DEX + gas', usd(params.dexAndGasCostsUsd, 2)),
      row('Net', usd(params.netProfitUsd, 2)),
      row('Reaction', `${params.reactionMs}ms`),
    ].map(esc).join('\n') + '</pre>',
    `<code>${esc(params.txHash)}</code>`,
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
    `❌ <b>MISSED</b> · ${esc(chainLabel(params.chain))}`,
    `<b>${esc(params.pair)}</b>`,
    '<pre>' + [
      row('Trade', usd(params.optimalTradeUsd)),
      row('Expected net', usd(params.expectedNetUsd)),
      row('Our reaction', `${params.ourReactionMs}ms`),
      row('Winner', params.winner),
    ].map(esc).join('\n') + '</pre>',
    '<i>Competitor landed first</i>',
  ].join('\n');
}

// ----------------------------------------------------------------------------
// Near miss: a real gap that didn't clear the minimum after costs
// ----------------------------------------------------------------------------

export function formatSkippedOpportunity(params: {
  chain: ChainName;
  pair: string;
  buyDex: string;
  sellDex: string;
  buyPrice: number;
  sellPrice: number;
  spreadPct: number;
  grossOpportunityUsd: number;
  optimalTradeUsd: number;
  expectedNetUsd: number;
  minRequiredUsd: number;
}): string {
  const dexWidth = Math.max(params.buyDex.length, params.sellDex.length) + 2;
  return [
    `⚠️ <b>NEAR MISS</b> · ${esc(chainLabel(params.chain))}`,
    `<b>${esc(params.pair)}</b>  spread ${pct(params.spreadPct)}`,
    '<pre>' + [
      row('Buy', `${params.buyDex.padEnd(dexWidth)}${formatPrice(params.buyPrice)}`, 7),
      row('Sell', `${params.sellDex.padEnd(dexWidth)}${formatPrice(params.sellPrice)}`, 7),
      row('Trade', usd(params.optimalTradeUsd), 7),
      row('Gross', usd(params.grossOpportunityUsd), 7),
      row('Net', `${usd(params.expectedNetUsd)}   need ${usd(params.minRequiredUsd)}`, 7),
    ].map(esc).join('\n') + '</pre>',
    '<i>Skipped: under minimum after fees and safety margin</i>',
  ].join('\n');
}

// ----------------------------------------------------------------------------
// Hourly digest: replaces the separate hourly report, chain health,
// matches report and per-pair price checks with ONE message.
// ----------------------------------------------------------------------------

export interface DigestChain {
  chain: string;
  healthy: boolean;
  reconnects: number;
}

export interface DigestSpread {
  pair: string;
  spreadPct: number;
  buyDex: string;
  sellDex: string;
}

export interface DigestSection {
  chain: string;
  spreads: DigestSpread[];  // best spread per pair, any order (sorted here)
  noMatchCount?: number;    // watched pairs with nothing to compare this hour
  note?: string;            // one short line under the chain, e.g. what it's watching
}

export interface WindowStats {
  seen: number;
  won: number;
  lost: number;
  netUsd: number;
  avgReactionMs: number | null;
  p95ReactionMs: number | null;
}

// Most pairs shown per chain, so the message stays readable (and under
// Telegram's 4096-character limit).
const MAX_PAIRS_PER_CHAIN = 6;

function chainStatusLine(chains: DigestChain[]): string {
  return chains
    .map((c) => {
      const icon = c.healthy ? '✅' : '❌';
      const note = c.reconnects > 0 ? ` <i>(${c.reconnects} reconnect${c.reconnects === 1 ? '' : 's'})</i>` : '';
      return `${icon} ${esc(chainLabel(c.chain))}${note}`;
    })
    .join('  ');
}

// Right-aligns count/money values so digits line up in a <pre> block.
const num = (v: string, width = 6): string => v.padStart(width);

function statsBlock(s: WindowStats): string {
  const lines = [
    row('Seen', num(String(s.seen)), 14),
    row('Would win', num(String(s.won)), 14),
    row('Would lose', num(String(s.lost)), 14),
    row('Net (shadow)', num(usd(s.netUsd)), 14),
  ];
  if (s.avgReactionMs !== null) {
    const p95 = s.p95ReactionMs !== null ? ` · ${Math.round(s.p95ReactionMs)}ms p95` : '';
    lines.push(row('Speed', `${Math.round(s.avgReactionMs)}ms avg${p95}`, 14));
  }
  return '<pre>' + lines.map(esc).join('\n') + '</pre>';
}

// Free pre-trade simulation results for the window (see execution/simulator.ts).
export interface SimStats {
  checked: number;
  profit: number;  // real chain says: would have made money
  loss: number;    // would have lost money
  fail: number;    // trade itself would have reverted
  rateLimited?: number; // times the RPC said "slow down" (simulations paused)
}

export function formatHourlyDigest(input: {
  windowLabel: string;           // e.g. "09:00 to 10:00"
  chains: DigestChain[];
  stats: WindowStats;
  sim?: SimStats;
  sections: DigestSection[];
}): string {
  const spreadLines: string[] = [];
  for (const sec of input.sections) {
    spreadLines.push(chainLabel(sec.chain).toUpperCase() + (sec.note ? `  (${sec.note})` : ''));
    const sorted = [...sec.spreads].sort((a, b) => b.spreadPct - a.spreadPct);
    const shown = sorted.slice(0, MAX_PAIRS_PER_CHAIN);
    const pairWidth = Math.max(0, ...shown.map((s) => s.pair.length)) + 2;
    for (const s of shown) {
      spreadLines.push(`${s.pair.padEnd(pairWidth)}${pct(s.spreadPct).padStart(6)}  ${s.buyDex} > ${s.sellDex}`);
    }
    const hidden = sorted.length - shown.length;
    if (hidden > 0) spreadLines.push(`+${hidden} more pair${hidden === 1 ? '' : 's'}`);
    const noMatch = sec.noMatchCount ?? 0;
    if (noMatch > 0) spreadLines.push(`${noMatch} more pair${noMatch === 1 ? '' : 's'}: no match`);
    if (sorted.length === 0 && noMatch === 0) spreadLines.push('no matches this hour');
  }

  return [
    `📊 <b>HOURLY REPORT</b> · ${esc(input.windowLabel)}`,
    '',
    '<b>Chains</b>',
    chainStatusLine(input.chains),
    '',
    '<b>Opportunities</b>',
    statsBlock(input.stats),
    ...(input.sim && input.sim.checked > 0 ? [
      '<b>Real-chain simulation</b>',
      '<pre>' + [
        row('Simulated', num(String(input.sim.checked)), 14),
        row('Profitable', num(String(input.sim.profit)), 14),
        row('Losing', num(String(input.sim.loss)), 14),
        row('Would fail', num(String(input.sim.fail)), 14),
      ].map(esc).join('\n') + '</pre>',
      ...(input.sim.rateLimited ? [`<i>RPC rate-limited ${input.sim.rateLimited}x (simulations paused briefly)</i>`] : []),
    ] : []),
    '<b>Best spread per pair</b>',
    '<pre>' + spreadLines.map(esc).join('\n') + '</pre>',
    '<i>LB pools excluded from pricing</i>',
  ].join('\n');
}

// ----------------------------------------------------------------------------
// PLAIN-ENGLISH HOURLY REPORT (Robinhood)
//
// Written for the owner to read on a phone, not for developers:
//   - every number has a plain label (no "p95", "spread", "pools")
//   - ✅ / ⚠️ / ❌ show good or bad at a glance
//   - "Needs attention" lists only things worth acting on, in plain sentences
// Names used: price differences (not gaps/spreads), trading spots (pools),
// checked (real-chain test), reaction time (trade seen -> decision).
// ----------------------------------------------------------------------------

export interface PlainHourlyInput {
  windowLabel: string;                 // "13:06 to 13:56"
  live: boolean;                       // real trades on?
  feedOk: boolean;                     // live trade feed connected now
  feedReconnects: number;              // times it dropped this hour
  pairs: number;                       // token pairs watched
  spots: number;                       // trading spots (pools)
  pricesFrom: 'free' | 'backup';       // where prices come from right now
  freeNodeBusy: number;                // times the free node had to rest (since start)
  differencesFound: number;            // price differences scored this hour
  // failReasons: why the "wouldn't go through" ones failed, in plain groups,
  // biggest first (see core/failReasons.ts). Optional for older callers.
  checks: { done: number; makeMoney: number; loseMoney: number; wouldFail: number; nodeBusy: number; failReasons?: [string, number][];
    // When trigger checks were tested: right after the trade we followed,
    // after someone else also traded in that block, or late (latest block).
    timing?: { rightAfter: number; othersInBlock: number; late: number };
    // Real wins (after gas, vetted coins) that cleared each bar, this hour and today.
    winSizes?: { bars: number[]; hour: number[]; today: number[]; todayUsd: number[] };
    benchedRoutes?: number; // pool pairs benched for never paying out
  };
  checksAvailable: boolean;            // false = no node can run checks right now
  earned: { todayChecked: number; todayCheckedCount: number; todayUnchecked: number; todayUncheckedCount: number; weekChecked: number };
  reactionMs: { typical: number | null; slowest5pct: number | null };
  otherBots?: { timed: number; theirMs: number | null; oursMs: number | null; weBeat: number };
  // What the rival bots did this hour (core/rivalWatch.ts).
  rivalWins?: RivalSummary & { botsKnown: number; botsVerified?: number };
  // New pools for coins that already trade deep (core/newPoolWatch.ts).
  newPools?: NewPoolSummary;
  topDifferences: { pair: string; pct: number; buyAt: string; sellAt: string }[];
  nodeUsage?: { name: string; used: number; daily: number }[]; // today's requests per node vs allowance
  // Where trades dropped out this hour, step by step (see shadowMain funnel).
  funnel?: {
    tradesRead: number; noPool: number; tooSmall?: number; noPartner: number; noUsdPrice: number; smallerThanFees: number;
    found: number; belowCheckBar: number; checkBarUsd: number; notVetted: number; sentToCheck: number;
    skipped: [string, number][];
  };
}

const NODE_NAMES: Record<string, string> = { public: 'Robinhood (free)', nodeflare: 'Nodeflare (backup)', quicknode: 'QuickNode (checks)', alchemy: 'Alchemy (spare, out until Nov 1)' };

// "uniswap-v3 1%" -> "Uniswap V3 (1% fee)"; "uniswap-v4 0.3% ETH" -> "Uniswap V4 (0.3% fee, ETH)".
const DEX_NAMES: Record<string, string> = {
  'uniswap-v2': 'Uniswap V2', 'uniswap-v3': 'Uniswap V3', 'uniswap-v4': 'Uniswap V4',
  'pancakeswap-v2': 'PancakeSwap V2', 'pancakeswap-v3': 'PancakeSwap V3',
  'ramses-v2': 'Ramses V2', 'ramses-v3': 'Ramses V3',
};
export function plainSpot(label: string): string {
  const [dex, ...rest] = label.trim().split(/\s+/);
  const name = DEX_NAMES[dex] ?? dex;
  const fee = rest.find((r) => r.endsWith('%'));
  const extra = rest.filter((r) => !r.endsWith('%'));
  const bits = [fee ? `${fee} fee` : '', ...extra].filter(Boolean);
  return bits.length ? `${name} (${bits.join(', ')})` : name;
}

const secs = (ms: number): string => (ms < 1000 ? `${(ms / 1000).toFixed(2)} s` : `${(ms / 1000).toFixed(1)} s`);
const money = (n: number): string => `$${n.toFixed(2)}`;
const REACTION_TARGET_MS = 100;

export function formatPlainHourly(r: PlainHourlyInput): string {
  const attention: string[] = [];
  const L: string[] = [];

  L.push(`🤖 <b>ROBINHOOD</b> · last hour (${esc(r.windowLabel)})`);
  L.push(`Mode: ${r.live ? '<b>LIVE (real money)</b>' : 'practice run (no real trades)'}`);
  L.push(`Live trade feed: ${r.feedOk ? '✅ connected' : '❌ disconnected'}${r.feedReconnects ? ` (dropped ${r.feedReconnects}x, reconnected)` : ''}`);
  if (!r.feedOk) attention.push('The live trade feed is down. The bot is retrying on its own; tell me if this repeats.');
  L.push(`Watching: ${r.pairs} token pairs across ${r.spots} trading spots`);
  L.push(`Getting prices from: ${r.pricesFrom === 'free' ? 'Robinhood (free) ✅' : 'backup node ⚠️ (Robinhood free node was busy)'}`);
  if (r.pricesFrom !== 'free') attention.push('Prices are coming from the backup right now because the free Robinhood node asked us to slow down.');
  L.push('');

  if (r.funnel) {
    const f = r.funnel;
    const n = (x: number) => x.toLocaleString('en-US');
    L.push('<b>What happened to trades this hour</b>');
    L.push(`Trades read from the live feed: ${n(f.tradesRead)}`);
    const out: string[] = [];
    if (f.noPool) out.push(`${n(f.noPool)} trading spot not recognised`);
    if (f.tooSmall) out.push(`${n(f.tooSmall)} trade too small to move the price`);
    if (f.noPartner) out.push(`${n(f.noPartner)} no second trading spot with $25k+ to compare`);
    if (f.noUsdPrice) out.push(`${n(f.noUsdPrice)} token has no USD price`);
    if (f.smallerThanFees) out.push(`${n(f.smallerThanFees)} price difference smaller than the fees`);
    for (const o of out) L.push(`  ➖ ${esc(o)}`);
    L.push(`Worth a look after fees: ${n(f.found)}`);
    const out2: string[] = [];
    if (f.belowCheckBar) out2.push(`${n(f.belowCheckBar)} estimated gain under $${f.checkBarUsd.toFixed(2)} (too small to check)`);
    if (f.notVetted) out2.push(`${n(f.notVetted)} token not on the vetted list`);
    for (const o of out2) L.push(`  ➖ ${esc(o)}`);
    L.push(`Sent to be checked: ${n(f.sentToCheck)}`);
    for (const [why, c] of f.skipped.slice(0, 4)) L.push(`  ➖ ${n(c)} not checked: ${esc(why)}`);
    L.push('');
  }
  L.push(`<b>Price differences found:</b> ${r.differencesFound}`);
  if (!r.checksAvailable && r.checks.done === 0) {
    L.push('Checked (real test): ❌ none, checking is off');
    attention.push('Checks are off: no node can run them. Adding the QuickNode key turns them back on.');
  } else {
    L.push(`Checked (real test): ${r.checks.done}`);
    L.push(`  ✅ would make money: ${r.checks.makeMoney}`);
    L.push(`  ➖ would lose money: ${r.checks.loseMoney}`);
    L.push(`  ✖️ wouldn't go through: ${r.checks.wouldFail}`);
    // Why they wouldn't go through, so you can tell bad coins (skip them)
    // from a bug on our side (needs fixing) at a glance.
    if (r.checks.wouldFail > 0 && r.checks.failReasons?.length) {
      L.push('     Why:');
      for (const [why, c] of r.checks.failReasons.slice(0, 5)) L.push(`     • ${esc(why)}: ${c}`);
      // A bug on our side is the one worth acting on: flag it.
      const ours = r.checks.failReasons.find(([why]) => why.startsWith('our bot'));
      if (ours) attention.push(`${ours[1]} check(s) failed because our bot built the trade wrong. Tell me and I'll fix it.`);
    }
    if (r.checks.nodeBusy) L.push(`  (checking node said "slow down" ${r.checks.nodeBusy}x, checks paused briefly)`);
    const tm = r.checks.timing;
    if (tm && tm.rightAfter + tm.othersInBlock + tm.late > 0) {
      const bits = [`${tm.rightAfter} right after the trade we followed`];
      if (tm.othersInBlock) bits.push(`${tm.othersInBlock} at the end of its block`);
      if (tm.late) bits.push(`${tm.late} tested late`);
      L.push(`  Test timing: ${bits.join(', ')}`);
    }
    // Wins by size: decides where the firing bar should be ($20 today).
    const ws = r.checks.winSizes;
    if (ws && ws.today.some((x) => x > 0)) {
      L.push('  Real wins by size (after gas), today:');
      L.push('  ' + ws.bars.map((b, i) => `$${b}+: ${ws.today[i]} ($${ws.todayUsd[i].toFixed(0)})`).join(' · '));
    }
    if (r.checks.benchedRoutes) L.push(`  Skipping ${r.checks.benchedRoutes} pair(s) of trading spots that never pay out`);
  }
  L.push('');

  L.push('<b>Money we\'d have made</b> (if we won every race)');
  L.push(`Today, checked: ${money(r.earned.todayChecked)} from ${r.earned.todayCheckedCount} trade${r.earned.todayCheckedCount === 1 ? '' : 's'}`);
  if (r.earned.todayUncheckedCount) L.push(`Looks good but not checked yet: ${money(r.earned.todayUnchecked)} from ${r.earned.todayUncheckedCount} (not trustworthy)`);
  L.push(`Last 7 days, checked: ${money(r.earned.weekChecked)}`);
  L.push('');

  const t = r.reactionMs;
  if (t.typical !== null) {
    const ok = t.typical <= REACTION_TARGET_MS;
    L.push(`<b>Reaction time</b> (trade seen → decision): usually ${secs(t.typical)}${t.slowest5pct !== null ? `, slowest ones ${secs(t.slowest5pct)}+` : ''}. Target: under ${secs(REACTION_TARGET_MS)} ${ok ? '✅' : '❌'}`);
    if (!ok && t.typical > 1_000) attention.push(`Reaction time is slow (usually ${secs(t.typical)}). Other bots would beat us to most trades.`);
  }
  if (r.otherBots && r.otherBots.timed > 0) {
    const o = r.otherBots;
    L.push(`Other bots timed: ${o.timed}${o.theirMs !== null && o.oursMs !== null ? `. Them ${secs(o.theirMs)}, us ${secs(o.oursMs)}` : ''}${o.weBeat ? `, we'd have been first ${o.weBeat}x` : ''}`);
  }
  L.push('');

  // What the other bots did: where the real money is, and how they make it.
  const rw = r.rivalWins;
  if (rw && (rw.trades > 0 || rw.botsKnown > 0)) {
    L.push(`<b>What other bots did this hour</b> (following ${rw.botsKnown} bot${rw.botsKnown === 1 ? '' : 's'}${rw.botsVerified !== undefined ? `, ${rw.botsVerified} verified` : ''})`);
    if (!rw.trades) { L.push('No trades by them this hour.'); const c = sampleLine(rw); if (c) L.push(c); }
    else L.push(...rivalLines(rw));
    L.push('');
  }

  if (r.newPools) { L.push(newPoolsHourlyLine(r.newPools)); L.push(''); }

  if (r.nodeUsage?.length) {
    L.push('<b>Node usage today</b> (requests vs daily allowance)');
    for (const u of r.nodeUsage) {
      const label = NODE_NAMES[u.name] ?? u.name;
      if (u.daily === Infinity || !Number.isFinite(u.daily)) { L.push(`• ${esc(label)}: ${u.used.toLocaleString('en-US')} (no daily cap)`); continue; }
      const share = u.used / u.daily;
      const mark = share >= 1 ? '❌' : share >= 0.8 ? '⚠️' : '✅';
      L.push(`• ${esc(label)}: ${u.used.toLocaleString('en-US')} of ${u.daily.toLocaleString('en-US')} ${mark}`);
      if (share >= 1) attention.push(`${label} used its whole allowance for today; its job is paused until midnight UTC (8 pm Toronto).`);
      else if (share >= 0.8) attention.push(`${label} is at ${Math.round(share * 100)}% of today's allowance.`);
    }
    L.push('');
  }

  if (r.topDifferences.length) {
    L.push('<b>Biggest price differences</b> (before fees, not profit)');
    for (const d of r.topDifferences.slice(0, 5)) {
      L.push(`• ${esc(d.pair)} ${d.pct.toFixed(1)}%: buy on ${esc(plainSpot(d.buyAt))}, sell on ${esc(plainSpot(d.sellAt))}`);
    }
    L.push('');
  }

  L.push(attention.length ? `⚠️ <b>Needs attention</b>\n${attention.map((a) => '• ' + esc(a)).join('\n')}` : '✅ Nothing needs your attention.');
  return L.join('\n');
}

export function formatPlainDaily(input: {
  dateLabel: string;
  differencesFound: number;
  earnedChecked: number; earnedCheckedCount: number;
  weekChecked: number;
  feedUptimePct: number | null;
}): string {
  return [
    `📅 <b>DAILY SUMMARY</b> · ${esc(input.dateLabel)}`,
    `Price differences found: ${input.differencesFound}`,
    `Money we'd have made today so far (checked): ${money(input.earnedChecked)} from ${input.earnedCheckedCount} trade${input.earnedCheckedCount === 1 ? '' : 's'}`,
    `Last 7 days (checked): ${money(input.weekChecked)}`,
    ...(input.feedUptimePct !== null ? [`Live trade feed up: ${input.feedUptimePct.toFixed(1)}% of the day ${input.feedUptimePct >= 99 ? '✅' : '⚠️'}`] : []),
  ].join('\n');
}

// ----------------------------------------------------------------------------
// Daily report
// ----------------------------------------------------------------------------

export function formatDailyReport(input: {
  dateLabel: string;                           // e.g. "Sat Oct 3"
  stats: WindowStats;
  bestTradeUsd: number | null;                 // best would-have-won net
  largestMissUsd: number | null;               // biggest would-have-lost net
  uptimePct: Record<string, number | null>;    // per chain, null = no data
}): string {
  const uptimeLines = Object.entries(input.uptimePct)
    .filter(([, v]) => v !== null)
    .map(([c, v]) => row(`${chainLabel(c)} up`, num(pct(v as number, 1)), 14));

  const extras: string[] = [];
  if (input.bestTradeUsd !== null) extras.push(`Best trade ${usd(input.bestTradeUsd)}`);
  if (input.largestMissUsd !== null) extras.push(`Largest miss ${usd(input.largestMissUsd)}`);

  return [
    `📅 <b>DAILY REPORT</b> · ${esc(input.dateLabel)}`,
    '<pre>' + [
      row('Seen', num(String(input.stats.seen)), 14),
      row('Would win', num(String(input.stats.won)), 14),
      row('Would lose', num(String(input.stats.lost)), 14),
      row('Net (shadow)', num(usd(input.stats.netUsd)), 14),
      ...uptimeLines,
    ].map(esc).join('\n') + '</pre>',
    ...(extras.length ? [`<i>${esc(extras.join(' · '))}</i>`] : []),
  ].join('\n');
}

// ----------------------------------------------------------------------------
// Lifecycle
// ----------------------------------------------------------------------------

export function formatStartup(chains: Record<string, { online: boolean }>): string {
  const line = Object.entries(chains)
    .map(([c, s]) => `${s.online ? '✅' : '❌'} ${esc(chainLabel(c))}`)
    .join('  ');
  return [`▶️ <b>BOT STARTED</b> · shadow mode`, line].join('\n');
}

export function formatExecutionWarning(): string {
  return [
    '⚠️ <b>EXECUTION_ENABLED is set</b>',
    'Live trading is not built yet. Bot is still shadow-only.',
  ].join('\n');
}


// ----------------------------------------------------------------------------
// Rival bots, in plain English (hourly section + daily report).
// ----------------------------------------------------------------------------
const cents = (n: number | null): string => (n === null ? '?' : n < 1 ? `${(n * 100).toFixed(n < 0.1 ? 2 : 1)}¢` : money(n));
const share = (a: number, b: number): string => (b ? `${Math.round((100 * a) / b)}%` : '0%');

// Plain-English labels for why a trade's dollar result isn't confirmed.
const WHY_LABEL: Record<string, string> = {
  'v4-native-leg': 'plain-ETH pool leg we can\'t see',
  'v4-pool-unknown': 'V4 pool we can\'t check',
  'native-eth-sent': 'sent plain ETH',
  'open-position': 'not a closed loop',
  'profit-sent-elsewhere': 'coins sent to another wallet',
  'junk-price': 'junk coin price',
  'gas-unpriced': 'gas not priced',
};

// Trades whose dollar result we trust (went through, priced, not junk, not uncertain).
const trustedTrades = (s: RivalSummary): number => s.trades - s.failed - s.unpriced - (s.junk ?? 0) - (s.uncertain ?? 0);

function rivalLines(s: RivalSummary): string[] {
  const L: string[] = [];
  const ok = s.trades - s.failed;     // trades that went through
  const unsure = (s.junk ?? 0) + (s.uncertain ?? 0);
  const confirmed = trustedTrades(s);
  L.push(`Trades: ${s.trades} by ${s.bots} bot${s.bots === 1 ? '' : 's'}${s.verifiedBots !== undefined ? ` (${s.verifiedBots} verified)` : ''}`);
  L.push(`  ✅ made money after gas (confirmed): ${s.wins}`);
  L.push(`  ➖ broke even or lost (confirmed): ${Math.max(0, confirmed - s.wins)}`);
  // Seen but dollar result not trusted: never shown as profit or loss.
  if (unsure) {
    const why = (s.whyUncertain ?? []).slice(0, 3).map(([w, n]) => `${WHY_LABEL[w] ?? w} ${n}`).join(', ');
    L.push(`  ❔ dollar result uncertain (left out of the money below): ${unsure}${why ? ` (${why})` : ''}`);
  }
  if (s.unpriced) L.push(`  ❔ coins we can't price: ${s.unpriced}`);
  if (s.failed) L.push(`  ✖️ failed but still paid gas: ${s.failed}`);
  // The money lines add up exactly: kept = made - gas on confirmed - gas on failed.
  const gc = s.gasConfirmedUsd ?? s.gasUsd, gf = s.gasFailedUsd ?? 0, gu = s.gasUnknownUsd ?? 0;
  L.push(`Money (confirmed trades): made ${money(s.grossUsd)} - gas ${money(gc)} - failed-trade gas ${money(gf)} = kept ${money(s.netUsd)}`);
  if (gu > 0) L.push(`Gas on uncertain/unpriced trades: ${money(gu)} (if those made nothing, kept ${money(s.netWorstUsd ?? s.netUsd - gu)})`);
  L.push(`Typical trade: puts in ${s.medianSizeUsd === null ? '?' : money(s.medianSizeUsd)}, a win makes ${cents(s.medianWinUsd)}, gas ${cents(s.medianGasUsd)}`);
  // Route shapes only count trades that went through (failed ones show 0 pools).
  L.push(`Routes (trades that went through): 2 pools ${share(s.routes.two, ok)}, 3 pools ${share(s.routes.three, ok)}, 4+ pools ${share(s.routes.fourPlus, ok)}`);
  // Flash = a real flash-loan event. A normal V3 swap paying first is NOT a loan.
  L.push(`Money source: own money ${share(ok - s.flash, ok)}, flash loans ${share(s.flash, ok)}`);
  for (const [pair, n, usd] of s.byPair.slice(0, 5)) L.push(`  • ${esc(pair)}: ${n} wins, ${money(usd)}`);
  L.push(`On trading spots we watch: ${s.onOurPools} of ${s.trades}`);
  const c = sampleLine(s);
  if (c) L.push(c);
  return L;
}

// Chain-wide sample: what share of the market these numbers cover.
function sampleLine(s: RivalSummary): string | null {
  const sm = s.sample;
  return sm && sm.blocks ? `Chain sample: ${sm.blocks} blocks read, ${sm.arbs} rival-style trades, ${share(sm.followed, sm.arbs)} by bots we follow` : null;
}


// Lessons the numbers teach, one line each.
export function rivalLessons(s: RivalSummary): string[] {
  const out: string[] = [];
  const ok = s.trades - s.failed;
  if (s.medianWinUsd !== null && s.medianSizeUsd) out.push(`A typical win makes ${cents(s.medianWinUsd)} on ${money(s.medianSizeUsd)} put in (${((100 * s.medianWinUsd) / s.medianSizeUsd).toFixed(2)}%). Tiny margins, lots of trades.`);
  if (s.medianWinUsd !== null && s.medianGasUsd) out.push(`Gas is about ${cents(s.medianGasUsd)} a trade, so one typical win pays for about ${Math.floor(s.medianWinUsd / s.medianGasUsd)} misses.`);
  const loops = s.routes.three + s.routes.fourPlus;
  if (ok) out.push(`${share(loops, ok)} of their trades that went through are 3+ pool loops. Our bot can't do those yet.`);
  if (ok) out.push(`${share(s.flash, ok)} used flash loans; the rest used their own money.`);
  if (s.trades) out.push(`${share(s.onOurPools, s.trades)} were on pools we watch. The rest is money we can't even see yet.`);
  if (s.failed) out.push(`${s.failed} trades failed outright and still paid gas. Sending lots and accepting misses is part of the game.`);
  if (s.junk) out.push(`${s.junk} trades were in junk coins whose prices can't be trusted, so their "profit" is left out.`);
  if (s.uncertain) out.push(`${s.uncertain} more trades had a dollar result we can't confirm (e.g. a plain-ETH leg), so they're left out too. Their gas still counts.`);
  if (s.sample && s.sample.arbs >= 10) out.push(`In sampled blocks we follow the bots behind ${share(s.sample.followed, s.sample.arbs)} of rival-style trades. The rest of the market is bigger than these numbers.`);
  return out;
}

// Stage 0 verdict: is there enough money here, and is gas cheap enough?
// Judged only on trades with a trustworthy dollar result.
export function rivalVerdict(s: RivalSummary, hours: number): string {
  const perDay = hours > 0 ? (s.netUsd * 24) / hours : 0;
  const gasOk = s.medianGasUsd !== null && s.medianWinUsd !== null && s.medianGasUsd * 4 <= s.medianWinUsd;
  if (trustedTrades(s) < 20) return `⏳ Not enough rival trades with a trustworthy dollar result yet (${Math.max(0, trustedTrades(s))}) to judge. Give it more time.`;
  if (perDay < 100) return `⚠️ Small pie: the bots we follow keep about ${money(perDay)} a day after gas. Probably not worth building more here unless it grows.`;
  if (!gasOk) return `⚠️ Gas is too high compared with a typical win (${cents(s.medianGasUsd)} gas vs ${cents(s.medianWinUsd)} win). Tiny trades would struggle.`;
  return `✅ Worth building Stage 1: the bots we follow keep about ${money(perDay)} a day after gas, and gas is cheap compared with a win.`;
}

export function formatRivalDaily(input: { dateLabel: string; hours: number; summary: RivalSummary; botsKnown: number; botsVerified?: number; newPools?: NewPoolSummary }): string {
  const s = input.summary;
  const L: string[] = [];
  // "New pools" section goes at the end (also when there are no rival trades yet).
  const withNewPools = (out: string[]) => (input.newPools ? [...out, '', ...newPoolsSection(input.newPools)] : out);
  L.push(`📚 <b>RIVAL BOT REPORT</b> · ${esc(input.dateLabel)} (last ${Math.round(input.hours)} h)`);
  L.push(`Following ${input.botsKnown} rival bot${input.botsKnown === 1 ? '' : 's'}${input.botsVerified !== undefined ? ` (${input.botsVerified} verified with 3+ confirmed wins, the rest unproven)` : ''}. Numbers are for those bots only, so the real total is at least this.`);
  L.push('');
  if (!s.trades) { L.push('No rival trades recorded yet.'); return withNewPools(L).join('\n'); }
  L.push(...rivalLines(s));
  L.push('');
  L.push('<b>Top bots</b> (kept after gas)');
  for (const b of s.byBot.slice(0, 5)) {
    L.push(`  • ${b.bot.slice(0, 8)}…${b.verified ? '' : ' (unproven)'}: ${b.trades} trades, kept ${money(b.netUsd)}, puts in ${b.medianSizeUsd === null ? '?' : money(b.medianSizeUsd)}, ${b.avgPools.toFixed(1)} pools avg (trades that went through)${b.flash ? `, flash loans ${b.flash}x` : ''}`);
  }
  L.push('');
  L.push('<b>What we learn</b>');
  for (const l of rivalLessons(s)) L.push(`  • ${l}`);
  L.push('');
  L.push(`<b>Verdict</b>: ${rivalVerdict(s, input.hours)}`);
  return withNewPools(L).join('\n');
}

// ----------------------------------------------------------------------------
// New pools (core/newPoolWatch.ts): how often a new pool for a coin that
// already trades deep starts at an off price. Measurement only.
// ----------------------------------------------------------------------------
const usd0 = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

export function newPoolsHourlyLine(s: NewPoolSummary): string {
  if (!s.measured) return `<b>New pools</b>: ${s.created} made, ${s.eligible} for coins that already trade deep, none got money yet.`;
  return `<b>New pools</b>: ${s.created} made, ${s.eligible} for coins that already trade deep, ${s.measured} got money. Started off price: ${s.off05} by 0.5%+, ${s.off1} by 1%+, ${s.off3} by 3%+ (about ${usd0(s.usd)} in them).`;
}

export function newPoolsSection(s: NewPoolSummary): string[] {
  const L: string[] = ['<b>New pools</b> (last 24 h, measurement only)'];
  L.push(`New pools made: ${s.created}. For coins that already trade in a deep pool ($10k+): ${s.eligible}. Got their first money: ${s.measured}.`);
  if (!s.measured) { L.push('None to measure yet.'); return L; }
  L.push(`Started more than 0.5% off: ${s.off05} · more than 1%: ${s.off1} · more than 3%: ${s.off3}`);
  L.push(`Money in them: about ${usd0(s.usd)} (in the ones 1%+ off: ${usd0(s.usdOff1)})`);
  for (const r of s.top.slice(0, 3)) L.push(`  • ${esc(r.pair)} on ${esc(plainSpot(r.dex))}: started ${r.gapPct.toFixed(2)}% off, about ${usd0(r.usd)} in it`);
  const verdict = s.off1 >= 5 ? '✅ Off-price new pools are common. Worth a closer look at catching them.'
    : s.off1 ? '⚠️ It happens, but rarely so far. Keep counting.'
      : '➖ No new pool started more than 1% off. Nothing to catch yet.';
  L.push(verdict);
  return L;
}


// ----------------------------------------------------------------------------
// MARKET OPEN REPORT: do USDG and ETH pools of the same token disagree more
// around the 9:30 stock market open than the rest of the day?
// ----------------------------------------------------------------------------
export function formatMarketOpenReport(input: { dateLabel: string; tokens: number; rows: GapRow[] }): string {
  const L: string[] = [];
  const pc = (x: number) => `${x.toFixed(2)}%`;
  const mins = (s: number) => (s < 60 ? `${Math.round(s)} s` : `${(s / 60).toFixed(1)} min`);
  L.push(`📈 <b>MARKET OPEN REPORT</b> · ${esc(input.dateLabel)} (9:00 to 10:30)`);
  L.push(`Watching ${input.tokens} tokens that trade in both a USDG pool and an ETH pool. A "gap" is how far the two prices disagree. "After fees" is what's left once both pools' fees and the ETH/USDG swap are paid. Measurement only, no trades.`);
  L.push('');
  const rows = input.rows.filter((r) => r.open.samples > 0);
  if (!rows.length) { L.push('No measurements during the open (bot restarted, or a holiday).'); return L.join('\n'); }
  const paying = rows.filter((r) => r.open.maxNetPct > 0);
  L.push(`<b>Biggest gaps at the open</b>`);
  for (const r of rows.slice(0, 8)) {
    const net = r.open.maxNetPct > 0 ? `after fees ${pc(r.open.maxNetPct)}, worth trading for ${mins(r.open.secondsProfitable)}` : 'not enough after fees';
    const rest = r.rest.samples ? ` · rest of day max ${pc(r.rest.maxGapPct)}` : '';
    L.push(`  • ${esc(r.symbol)}: gap up to ${pc(r.open.maxGapPct)} (${net})${rest}`);
  }
  L.push('');
  const openAvg = rows.reduce((s, r) => s + r.open.maxGapPct, 0) / rows.length;
  const restRows = rows.filter((r) => r.rest.samples > 0);
  const restAvg = restRows.length ? restRows.reduce((s, r) => s + r.rest.maxGapPct, 0) / restRows.length : null;
  L.push(`Typical biggest gap per token: open ${pc(openAvg)}${restAvg !== null ? `, rest of day ${pc(restAvg)}` : ''}`);
  L.push(`Tokens with a gap worth trading after fees at the open: ${paying.length} of ${rows.length}`);
  L.push('');
  const verdict = paying.length >= 3 && paying.some((r) => r.open.secondsProfitable >= 30)
    ? '✅ Real gaps at the open that last long enough to trade. Worth building "market open mode" on top of Stage 1.'
    : paying.length
      ? '⚠️ A few gaps after fees, but small or brief. Watch a few more mornings before building anything.'
      : '❌ No gaps worth trading after fees this morning. Pools stay in line; watch a few more mornings to be sure.';
  L.push(`<b>Verdict</b>: ${verdict}`);
  return L.join('\n');
}


// ----------------------------------------------------------------------------
// LOOP REPORT (loop measurement, Phase A): do 3-way loops through coins that
// should be worth the same have real gaps after fees? Measurement only.
// ----------------------------------------------------------------------------
const pc2 = (x: number) => `${x.toFixed(2)}%`;
const dur = (s: number) => (s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(1)} h`);

// Plain verdict: is it worth building the loop trader?
// A loop paying over 10% after fees isn't believable on a working market
// (usually a junk coin that only sometimes looks normal), so it doesn't count.
const credible = (r: LoopRow) => !r.broken && r.stats.maxNetPct > 0 && r.stats.maxNetPct <= 10;

export function loopVerdict(rows: LoopRow[], pegs: PegRow[]): string {
  const good = rows.filter(credible);
  // Bar for "worth building": several tokens paying for 2+ minutes in total,
  // or 2+ tokens with 0.3%+ after fees lasting a full minute in one go.
  // One lucky token isn't enough to build a trader on.
  const lasting = good.filter((r) => r.stats.secondsProfitable >= 120);
  const strong = good.filter((r) => r.stats.maxNetPct >= 0.3 && r.stats.longestRunS >= 60);
  const pegGood = pegs.filter((p) => p.stats.maxNetPct > 0 && p.stats.secondsProfitable >= 60);
  if (!rows.some((r) => r.stats.samples > 0) && !pegs.length) return '⏳ No measurements yet (just started, or nothing to watch). Wait for the next report.';
  if (lasting.length >= 3 || strong.length >= 2) return `✅ Worth building the loop trader: ${lasting.length} token(s) had loops paying after fees for 2+ minutes${strong.length ? `, ${strong.length} with 0.3%+ lasting a minute or more in one go` : ''}.`;
  if (good.length || pegGood.length) return '⚠️ Some loops pay after fees, but they are small or brief. Keep measuring a few more days before building.';
  return '❌ No loop paid after fees in this period. Not worth building the loop trader yet.';
}

export function formatLoopReport(input: {
  dateLabel: string; hours: number; tokens: number; quotes: LoopQuote[]; rows: LoopRow[]; pegs: PegRow[];
}): string {
  const L: string[] = [];
  L.push(`🔁 <b>LOOP REPORT</b> · ${esc(input.dateLabel)} (last ${input.hours < 1 ? input.hours.toFixed(1) : Math.round(input.hours)} h)`);
  L.push('Measurement only, no trades. A loop goes coin A → token → coin B → back to coin A, through 3 pools. "After fees" is what is left once all 3 pools\' fees are paid, on a small trade (a big trade moves the price and gets less).');
  const byGroup = new Map<string, string[]>();
  for (const q of input.quotes) (byGroup.get(q.group) ?? byGroup.set(q.group, []).get(q.group)!).push(q.symbol);
  L.push(`Watching ${input.tokens} token(s) across ${input.quotes.length} verified coins: ${[...byGroup.entries()].map(([g, xs]) => `${g} (${xs.join(', ')})`).join('; ') || 'none yet'}.`);
  L.push('');

  const rows = input.rows.filter((r) => r.stats.samples > 0);
  const ok = rows.filter((r) => !r.broken);
  const paying = ok.filter((r) => r.stats.maxNetPct > 0);
  L.push('<b>Loops with a gap after fees</b>');
  if (!paying.length) L.push('  None.');
  for (const r of paying.slice(0, 6)) {
    const b = r.stats.best;
    L.push(`  • ${esc(r.symbol)}: up to ${pc2(r.stats.maxNetPct)} after fees, worth trading for ${dur(r.stats.secondsProfitable)} in total (longest stretch ${dur(r.stats.longestRunS)})${credible(r) ? '' : ' ⚠️ over 10%: probably a junk coin, not counted in the verdict'}`);
    if (b) L.push(`     Route: ${esc(b.route)}. Shallowest pool about $${Math.round(b.shallowUsd).toLocaleString('en-US')}.`);
  }
  const close = ok.filter((r) => r.stats.maxNetPct <= 0).sort((a, b) => b.stats.maxGapPct - a.stats.maxGapPct).slice(0, 3);
  if (close.length) {
    L.push('<b>Biggest gaps that did not cover the fees</b>');
    for (const r of close) L.push(`  • ${esc(r.symbol)}: gap up to ${pc2(r.stats.maxGapPct)} before fees (best after fees ${Number.isFinite(r.stats.maxNetPct) ? pc2(r.stats.maxNetPct) : 'n/a'})`);
  }
  L.push('');

  L.push('<b>Inside the groups</b> (coins that should be worth the same)');
  if (!input.pegs.length) L.push('  No direct pools between same-value coins found yet.');
  for (const p of input.pegs.slice(0, 8)) {
    const s = p.stats;
    const two = Number.isFinite(s.maxNetPct) ? `; two pools apart after fees: ${s.maxNetPct > 0 ? `${pc2(s.maxNetPct)}, for ${dur(s.secondsProfitable)}` : 'never enough'}` : '';
    const what = p.group === 'ETH vs WETH' ? `up to ${pc2(s.maxDevPct)} apart` : `up to ${pc2(s.maxDevPct)} off ${/^Copies/.test(p.group) ? 'its usual ratio' : '1 to 1'}`;
    L.push(`  • ${esc(p.label)} (${esc(p.group)}): ${what}${two}`);
  }
  L.push('');

  const broken = rows.filter((r) => r.broken);
  if (broken.length) {
    L.push(`<b>Ignored as broken</b> (gap above 10% nearly all the time): ${broken.slice(0, 8).map((r) => `${esc(r.symbol)} (${r.stats.maxGapPct > 0 ? r.stats.maxGapPct.toFixed(0) + '%' : 'over 50%'})`).join(', ')}`);
    L.push('');
  }
  L.push(`<b>Verdict</b>: ${loopVerdict(input.rows, input.pegs)}`);
  return L.join('\n');
}
