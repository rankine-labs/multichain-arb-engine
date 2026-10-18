// ============================================================================
// HOURLY TELEGRAM REPORT, VERSION 2 (Oct 15, owner approved, reporting only)
//
// Plain English:
//   One short message an hour, in plain words, laid out exactly as the owner
//   approved:
//
//     🤖 ROBINHOOD · HOURLY
//     🧪 PRACTICE (no real money yet)           (or "🟢 LIVE (real money)")
//     14:00 – 15:00 Toronto · full hour         (or "partial: ...")
//
//     💰 MONEY       Last hour / Today / 7 days for three lines
//     📈 TRADES THIS HOUR   normal trades, loop trades, races, best win
//     🩺 HEALTH      feed, reaction speed, trades too late, longest freeze,
//                    and an overall verdict
//
//   The same layout is used in practice and live, so nothing changes at
//   go-live except the header and the real money numbers (plus one extra
//   line with gas paid and failed trades).
//
//   Rules:
//     - A number we did not measure is shown as "n/a", never made up.
//     - Tables sit inside <pre> so Telegram shows them in a fixed-width font
//       and the columns line up.
//     - Every piece of text is HTML escaped before it goes in.
//     - No em dashes anywhere (the time range uses an en dash, as approved).
//   Pure function: no clock, no disk, no network. Easy to test.
//   The 4-hour report (src/report/fourHourReport.ts) is built from the same
//   collection of numbers (money ledgers, trades, races), so they agree.
// ============================================================================

import type { LedgerSnapshot } from './ledgers';
// A "wins out of tested" pair for one hour.
export interface WinsTested { won: number; tested: number }
import { formatPlainHourly, PlainHourlyInput } from '../core/telegramFormatter';

// Telegram's hard limit for one message.
export const TELEGRAM_MAX_CHARS = 4096;

// Health limits behind the overall verdict.
export const REACTION_TARGET_MS = 100;    // reaction speed should be under this
export const FREEZE_WARN_MS = 1_000;      // a freeze longer than this is a problem
export const FREEZE_ALARM_MS = 5_000;     // a freeze longer than this is serious on its own
export const TOO_LATE_WARN = 5;           // more trades than this too late to test is a problem
export const NODE_ERRORS_WARN = 10;       // node refusals / switches in the hour before we flag it
// A window shorter than this is called "partial" instead of "full hour".
export const FULL_HOUR_MIN_MS = 57 * 60_000;

export interface HourlyReportInput {
  live: boolean;                  // real money on?
  tz: string;                     // report time zone, e.g. America/Toronto
  tzLabel?: string;               // how the zone is named in the message (default "Toronto")
  restarted: boolean;             // true when the bot started during this window
  money: LedgerSnapshot;          // from MoneyLedgers.takePeriod()
  startLabel?: string;            // start coins for the "Could earn live" note (default "USDG/WETH")
  normal: WinsTested | null;      // 2-pool trades won / tested this hour (null = checking was off)
  loop: WinsTested | null;        // loop trades won / tested (null = loop trader off or no numbers)
  races: { won: number; lost: number; unclear?: number; pending?: number } | null;
  feedOk: boolean | null;         // live trade feed connected right now
  reactionMs: number | null;      // typical reaction time this hour (trade seen to decision)
  tooLate: number | null;         // trades that waited too long in the check line
  longestFreezeMs: number | null; // longest freeze this hour (stall finder)
  nodeErrors: number | null;      // node refusals / switches this hour (used for Overall only)
}

// ----------------------------------------------------------------------------
// Small text helpers
// ----------------------------------------------------------------------------

// Escape the three characters Telegram HTML cares about.
export function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// $1,234.56 (and -$0.12 for a loss). n/a for missing or broken numbers.
export function usd(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return 'n/a';
  // Round first so a tiny negative like -0.001 shows as $0.00, not -$0.00.
  const r = Math.round(x * 100) / 100;
  const s = Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return r < 0 ? `-$${s}` : `$${s}`;
}

// Time of day in the report zone, 24 hour clock: "14:05".
function hhmm(ms: number, tz: string): string {
  return new Date(ms).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
}

// Exchange ids in win labels, in plain names ("ramses-v3" -> "Ramses V3").
const DEX_NAMES: Record<string, string> = {
  'uniswap-v2': 'Uniswap V2', 'uniswap-v3': 'Uniswap V3', 'uniswap-v4': 'Uniswap V4',
  'pancakeswap-v2': 'PancakeSwap V2', 'pancakeswap-v3': 'PancakeSwap V3',
  'ramses-v2': 'Ramses V2', 'ramses-v3': 'Ramses V3',
};
function dexName(id: string): string {
  if (DEX_NAMES[id]) return DEX_NAMES[id];
  // Unknown "name-v2" style id: capitalise each part.
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(id)) return id.split('-').map((p) => (/^v\d/.test(p) ? p.toUpperCase() : p[0]!.toUpperCase() + p.slice(1))).join(' ');
  return id;
}

// "WETH ramses-v3->uniswap-v2" -> "WETH Ramses V3 → Uniswap V2".
export function plainRoute(label: string): string {
  return String(label).trim().split(/\s+/).map((word) => {
    if (word.includes('->')) return word.split('->').map(dexName).join(' → ');
    return dexName(word);
  }).join(' ');
}

// Pads a row so the columns line up inside <pre>.
const padR = (s: string, w: number) => (s.length >= w ? s : s + ' '.repeat(w - s.length));
const padL = (s: string, w: number) => (s.length >= w ? s : ' '.repeat(w - s.length) + s);

// "4 wins out of 60 tested" (or n/a).
function winsText(x: WinsTested | null, offWhy: string): string {
  if (!x) return `n/a (${offWhy})`;
  return `${x.won} win${x.won === 1 ? '' : 's'} out of ${x.tested} tested`;
}

// ----------------------------------------------------------------------------
// Overall verdict: ✅ all good / ⚠️ one short reason / 🚨 serious.
// ----------------------------------------------------------------------------
export function overallVerdict(r: Pick<HourlyReportInput, 'feedOk' | 'reactionMs' | 'longestFreezeMs' | 'tooLate' | 'nodeErrors'>): { mark: '✅' | '⚠️' | '🚨'; text: string } {
  const problems: string[] = [];
  if (r.feedOk === false) problems.push('live trade feed down');
  if (r.reactionMs !== null && r.reactionMs > REACTION_TARGET_MS) problems.push(`reaction slow (${Math.round(r.reactionMs)} ms)`);
  if (r.longestFreezeMs !== null && r.longestFreezeMs > FREEZE_WARN_MS) problems.push(`froze for ${(r.longestFreezeMs / 1000).toFixed(1)} s`);
  if (r.tooLate !== null && r.tooLate > TOO_LATE_WARN) problems.push(`${r.tooLate} trades too late to test`);
  if (r.nodeErrors !== null && r.nodeErrors >= NODE_ERRORS_WARN) problems.push(`node errors (${r.nodeErrors})`);
  if (!problems.length) return { mark: '✅', text: 'all good' };
  // Serious: two or more problems at once, or one very long freeze.
  const serious = problems.length >= 2 || (r.longestFreezeMs !== null && r.longestFreezeMs > FREEZE_ALARM_MS);
  const more = problems.length > 1 ? ` (+${problems.length - 1} more: ${problems.slice(1).join(', ')})` : '';
  return { mark: serious ? '🚨' : '⚠️', text: problems[0] + more };
}

// The period line: full hour, or partial with the reason.
export function periodLine(startMs: number, endMs: number, tz: string, tzLabel: string, restarted: boolean): string {
  const range = `${hhmm(startMs, tz)} – ${hhmm(endMs, tz)}`;
  if (endMs - startMs >= FULL_HOUR_MIN_MS && !restarted) return `${range} ${tzLabel} · full hour`;
  return `partial: ${range} ${tzLabel} (${restarted ? 'bot restarted' : 'short hour'})`;
}

// ----------------------------------------------------------------------------
// The message itself (Telegram HTML).
// ----------------------------------------------------------------------------
export function formatHourlyV2(r: HourlyReportInput): string {
  const m = r.money;
  const tzLabel = (r.tzLabel ?? 'Toronto').slice(0, 40);
  const out: string[] = [];

  out.push('🤖 <b>ROBINHOOD · HOURLY</b>');
  out.push(r.live ? '🟢 <b>LIVE (real money)</b>' : '🧪 PRACTICE (no real money yet)');
  out.push(esc(periodLine(m.periodStartMs, m.periodEndMs, r.tz, tzLabel, r.restarted)));
  out.push('');

  // --- MONEY ----------------------------------------------------------------
  const W0 = 18, W = 11;
  const row = (label: string, x: { lastHour: number; today: number; week: number }) =>
    padR(`  ${label}`, W0) + padL(usd(x.lastHour), W) + padL(usd(x.today), W) + padL(usd(x.week), W);
  const money: string[] = [
    padR('💰 MONEY', W0) + padL('Last hour', W) + padL('Today', W) + padL('7 days', W),
    row('Checked wins', m.checked),
    row('Could earn live', m.couldEarn),
    row('Real money made', m.real),
  ];
  if (r.live) {
    const rp = m.realPeriod;
    money.push(`  Gas paid ${usd(rp.gasUsd)} · Failed trades ${rp.failed} (cost ${usd(rp.failedCostUsd)})`);
  }
  const coins = (r.startLabel ?? 'USDG/WETH').slice(0, 40);
  money.push(`  (Could earn live = starts in ${coins},`, '   fits our own money, no loan)');
  out.push('<pre>' + money.map(esc).join('\n') + '</pre>');

  // --- TRADES THIS HOUR -------------------------------------------------------
  const T0 = 18;
  const tline = (label: string, value: string) => padR(`  ${label}`, T0) + value;
  let races = 'n/a';
  if (r.races) {
    races = `would have won ${r.races.won}, lost ${r.races.lost}`;
    if (r.races.unclear) races += `, unclear ${r.races.unclear}`;
    if (r.races.pending) races += ` (${r.races.pending} still watched)`;
  }
  const best = m.best ? `${usd(m.best.usd)}  ${plainRoute(m.best.label)}` : 'none this hour';
  const trades = [
    '📈 TRADES THIS HOUR',
    tline('Normal trades', winsText(r.normal, 'checking was off')),
    tline('Loop trades', winsText(r.loop, 'no loop numbers')),
    tline('Races', races),
    tline('Best win', best),
  ];
  out.push('<pre>' + trades.map(esc).join('\n') + '</pre>');

  // --- HEALTH -----------------------------------------------------------------
  const H0 = 26;
  const hline = (label: string, value: string) => padR(`  ${label}`, H0) + value;
  const feed = r.feedOk === null ? 'n/a' : r.feedOk ? '✅ connected' : '❌ disconnected';
  const react = r.reactionMs === null ? 'n/a' : `${Math.round(r.reactionMs)} ms  (target under ${REACTION_TARGET_MS})`;
  const freeze = r.longestFreezeMs === null ? 'n/a' : `${(r.longestFreezeMs / 1000).toFixed(1)} s`;
  const verdict = overallVerdict(r);
  const health = [
    '🩺 HEALTH',
    hline('Live trade feed', feed),
    hline('Reaction speed', react),
    hline('Trades too late to test', r.tooLate === null ? 'n/a' : String(r.tooLate)),
    hline('Longest freeze', freeze),
    hline('Overall', `${verdict.mark} ${verdict.text}`),
  ];
  out.push('<pre>' + health.map(esc).join('\n') + '</pre>');

  let text = out.join('\n');
  // Safety net: never go over Telegram's limit (cannot happen with this
  // layout and the label caps above, but must never stop the report being
  // sent). Cut at a line end (so no HTML entity is split) and close any
  // monospace block left open.
  if (text.length > TELEGRAM_MAX_CHARS) {
    text = text.slice(0, text.lastIndexOf('\n', TELEGRAM_MAX_CHARS - 30));
    if ((text.match(/<pre>/g) ?? []).length > (text.match(/<\/pre>/g) ?? []).length) text += '</pre>';
    text += '\n(trimmed)';
  }
  return text;
}

// REPORT_V2 switch: on unless set to exactly "0".
export function reportV2On(env: Record<string, string | undefined> = process.env): boolean {
  return env.REPORT_V2 !== '0';
}

// Which hourly message to send: the new one (v2) or the old long one,
// unchanged, built from the very same numbers (REPORT_V2=0).
export function hourlyMessage(v2: boolean, v2Input: HourlyReportInput, oldInput: PlainHourlyInput): string {
  return v2 ? formatHourlyV2(v2Input) : formatPlainHourly(oldInput);
}
