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
    spreadLines.push(chainLabel(sec.chain).toUpperCase());
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
