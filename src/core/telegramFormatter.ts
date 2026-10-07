import { ChainName } from './types';

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
    timing?: { rightAfter: number; othersInBlock: number; late: number } };
  checksAvailable: boolean;            // false = no node can run checks right now
  earned: { todayChecked: number; todayCheckedCount: number; todayUnchecked: number; todayUncheckedCount: number; weekChecked: number };
  reactionMs: { typical: number | null; slowest5pct: number | null };
  otherBots?: { timed: number; theirMs: number | null; oursMs: number | null; weBeat: number };
  topDifferences: { pair: string; pct: number; buyAt: string; sellAt: string }[];
  nodeUsage?: { name: string; used: number; daily: number }[]; // today's requests per node vs allowance
  // Where trades dropped out this hour, step by step (see shadowMain funnel).
  funnel?: {
    tradesRead: number; noPool: number; tooSmall?: number; noPartner: number; noUsdPrice: number; smallerThanFees: number;
    found: number; belowCheckBar: number; checkBarUsd: number; notVetted: number; sentToCheck: number;
    skipped: [string, number][];
  };
}

const NODE_NAMES: Record<string, string> = { public: 'Robinhood (free)', nodeflare: 'Nodeflare (backup)', quicknode: 'QuickNode (checks)', alchemy: 'Alchemy (scan)' };

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
      if (tm.othersInBlock) bits.push(`${tm.othersInBlock} after another bot also traded`);
      if (tm.late) bits.push(`${tm.late} tested late`);
      L.push(`  Test timing: ${bits.join(', ')}`);
    }
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
