import type { PeriodTotals } from './fourHourStats';
import type { RivalSummary } from '../core/rivalWatch';
import type { NewPoolSummary } from '../core/newPoolWatch';
import { plainRoute } from './hourlyReport';

// ============================================================================
// FOUR-HOUR REPORT (formatter only, reporting only)
//
// Plain English:
//   Builds the 4-hour Telegram report: 3 messages, each under Telegram's
//   4,096 character limit, in plain words for the owner. It carries all the
//   detail the old hourly report had, added up over 4 hours.
//     Message 1: money, and what happened to the trades we saw
//     Message 2: loop trades, other bots, exchanges and pools
//     Message 3: speed, connections, gas, parts check, top issues
//   Rules:
//     - every number comes from the input; anything not measured shows "n/a"
//     - every piece of text from the bot (coin names, reasons) is escaped,
//       so Telegram's HTML never breaks
//     - each message is built from whole blocks; if one ever runs too long,
//       whole blocks are dropped from its end (never half a tag)
//   This file is pure: no clock, no network, no files.
// ============================================================================

export const TELEGRAM_LIMIT = 4096;
const SAFE_LIMIT = 4000; // a little room under the hard limit

// What the report reads at send time (levels "right now", not counts).
// null = not measured (shown as "n/a").
export interface FourHourSnapshot {
  live: boolean;                       // real trades on?
  loansOn: boolean;                    // trades may borrow (flash loans)
  pairs: number | null; pools: number | null;
  gasPerTradeUsd: number | null;       // our own-money trade gas right now
  gasSamples: number | null;           // real tests/trades the gas estimate is based on
  gasCalibrated: boolean | null;       // true = from our own measured trades
  gasSource: string | null;            // 'live' | 'fallback' | 'old'
  feePoolsFromSwaps: number | null;    // pools whose fee is read from their swaps
  otherStables: string | null;         // core/stableTally.ts line (today)
  rivals: RivalSummary | null;         // rival trades in this period (core/rivalWatch.ts summary)
  rivalBotsKnown: number | null;
  newPools: NewPoolSummary | null;     // new pools in this period
  thinPools: number | null;            // pools left out: looked deep but real coins too few
  memory: { rssMb: number; peakRssMb: number | null; heapMb: number; notes: string } | null;
  feedOkNow: boolean | null;
  ws: { healthy: boolean; reconnects: number; todayMessages: number; cap: number; capped: boolean } | null; // null = not set up
  checkNode: string | null;            // practice-test node (+ backup), names only
  nodeErrors: { blockReaderErrors: number | null; blockReaderRateLimited: number | null; freeNodeRests: number | null };
  nodeUsage: { name: string; used: number; daily: number }[];
  loopsOn: boolean;
  maxLoopPools: number;
  emergencyStop: 'off' | 'on' | null;  // kill switch state right now (null = unknown)
}

export interface FourHourInput {
  tz: string;                          // e.g. America/Toronto
  scheduledFromMs: number;             // the 4-hour mark this report should start at
  toMs: number;
  totals: PeriodTotals;
  prevWins: { usd: number; n: number } | null;
  snap: FourHourSnapshot;
}

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

export function esc(s: string | number): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const NA = 'n/a';
const money = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? NA : `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`);
const cents = (n: number | null): string => (n === null || !Number.isFinite(n) ? NA : n < 1 ? `${(n * 100).toFixed(n < 0.1 ? 2 : 1)}¢` : money(n));
const int = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? NA : Math.round(n).toLocaleString('en-US'));
const pct = (a: number, b: number): string => (b > 0 ? `${Math.round((100 * a) / b)}%` : '');
const secs = (ms: number | null): string => (ms === null || !Number.isFinite(ms) ? NA : ms < 1000 ? `${(ms / 1000).toFixed(2)} s` : `${(ms / 1000).toFixed(1)} s`);
const msTxt = (ms: number | null): string => (ms === null || !Number.isFinite(ms) ? NA : ms < 10 ? ms.toFixed(1) : String(Math.round(ms)));
const plural = (n: number, one: string, many = one + 's') => (n === 1 ? one : many);

// One aligned "label  value" row for inside <pre> (label padded to width).
const row = (label: string, value: string, width = 22): string => `${label.padEnd(width)} ${value}`;
// A <pre> block from plain rows (each row escaped).
const pre = (rows: string[]): string => `<pre>${rows.map(esc).join('\n')}</pre>`;

// Clock time in the report's zone, e.g. "16:00".
export function clock(ms: number, tz: string): string {
  return new Date(ms).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
}
// Short zone name for the header: "Toronto" for America/Toronto.
const zoneName = (tz: string) => (tz.split('/').pop() ?? tz).replace(/_/g, ' ');

// Joins whole blocks into one message under the limit. If too long, whole
// blocks are dropped from the end and a short note says so.
export function fitBlocks(blocks: string[], limit = SAFE_LIMIT): string {
  const note = '<i>(some lines left out to fit Telegram\'s size limit)</i>';
  // Empty blocks are kept: they are the blank lines between sections.
  let out = blocks.join('\n');
  if (out.length <= limit) return out;
  const keep = [...blocks];
  while (keep.length > 1) {
    keep.pop();
    while (keep.length > 1 && keep[keep.length - 1] === '') keep.pop(); // no blank line before the note
    out = [...keep, note].join('\n');
    if (out.length <= limit) return out;
  }
  // A single block that is itself too long: cut its text (tags removed so nothing is left open).
  const plain = (keep[0] ?? '').replace(/<[^>]+>/g, '');
  return plain.slice(0, Math.max(0, limit - note.length - 2)) + '\n' + note;
}

// ---------------------------------------------------------------------------
// Header (period line, honest about restarts)
// ---------------------------------------------------------------------------

export function periodLine(i: FourHourInput): { line: string; partial: string | null } {
  const t = i.totals;
  const from = Math.max(i.scheduledFromMs, t.fromMs);
  const mode = i.snap.live ? 'LIVE mode (real money)' : 'Practice mode';
  const line = `${mode} · ${clock(from, i.tz)} – ${clock(i.toMs, i.tz)} ${zoneName(i.tz)}`;
  const span = Math.max(1, i.toMs - from);
  const notes: string[] = [];
  if (t.fromMs > i.scheduledFromMs + 2 * 60_000) notes.push(`counting started ${clock(t.fromMs, i.tz)}, not ${clock(i.scheduledFromMs, i.tz)}`);
  if (t.restarts > 0) notes.push(`bot restarted ${t.restarts}x, up to an hour of detail may be missing each time`);
  if (t.dropped) notes.push(`older numbers from ${clock(t.dropped.fromMs, i.tz)} to ${clock(t.dropped.toMs, i.tz)} were not reported (bot was down at their report time) and are not included`);
  if (t.hours === 0) notes.push('no detailed numbers collected yet');
  else if (t.coveredMs < span * 0.9) notes.push(`detailed numbers cover ${Math.round(t.coveredMs / 60_000)} of ${Math.round(span / 60_000)} min`);
  return { line, partial: notes.length ? `Partial period: ${notes.join('; ')}` : null };
}

const header = (i: FourHourInput, part: number): string[] => {
  const p = periodLine(i);
  return [`🔧 <b>ROBINHOOD · 4-HOUR REPORT (${part}/3)</b>`, esc(p.line), ...(p.partial ? [`<i>${esc(p.partial)}</i>`] : [])];
};

// ---------------------------------------------------------------------------
// Section 1: MONEY
// ---------------------------------------------------------------------------

function changeText(now: number, prev: { usd: number } | null): string {
  if (!prev) return 'n/a vs last 4h';
  if (prev.usd <= 0) return now > 0 ? `▲ (last 4h $0.00)` : 'same as last 4h ($0.00)';
  const ch = ((now - prev.usd) / prev.usd) * 100;
  if (Math.abs(ch) < 0.5) return 'same as last 4h';
  return `${ch > 0 ? '▲' : '▼'} ${Math.abs(Math.round(ch))}% vs last 4h`;
}

function moneySection(i: FourHourInput): string[] {
  const t = i.totals, s = i.snap, w = t.wins;
  const loops = t.loops;
  const rows: string[] = [
    row('Checked wins', `${money(w.usd)} ${changeText(w.usd, i.prevWins)}`),
    row('Could earn live', `${money(w.liveOk.usd)} (${w.liveOk.n} ${plural(w.liveOk.n, 'win')})`),
    // Real money: the hourly money ledger (true account change: won profit
    // minus all gas, failed trades included), so it matches the hourly reports.
    row('Real money made', s.live ? `${money(t.money.realUsd)} (${t.money.realWon} of ${t.live.sent} sent won)` : '$0 (practice)'),
    ...(s.live ? [`Gas paid ${money(t.money.gasUsd)} · Failed trades ${t.money.failed} (cost ${money(t.money.failedCostUsd)})`] : []),
    row('Wins: normal', `${w.n} (${money(w.usd)})`),
    row('Wins: loops', loops ? `${loops.wouldMake} (${money(loops.wouldMakeUsd)}, tests only, not in total)` : s.loopsOn ? NA : 'off'),
    row('Average win', w.n ? money(w.usd / w.n) : NA),
    // Same plain route names as the hourly ("WETH Uniswap V3 → Ramses V3").
    row('Biggest win', w.best ? `${money(w.best.usd)} ${plainRoute(w.best.label)}` : NA),
    row('Gas per trade', s.gasPerTradeUsd === null ? NA : `${cents(s.gasPerTradeUsd)} (estimated, already taken off)`),
    row('Loans', s.loansOn ? 'on (loan fees: n/a, not measured)' : 'off (own money)'),
  ];
  const lo = w.leftOut;
  const left = [
    row("Started in a coin we don't hold", `${money(lo.otherCoin.usd)} (${lo.otherCoin.n})`, 31),
    row('Bigger than our money', `${money(lo.overSize.usd)} (${lo.overSize.n})`, 31),
    row('Needed a loan', `${money(lo.loan.usd)} (${lo.loan.n})`, 31),
  ];
  return [
    '<b>1 · MONEY</b>',
    pre(rows),
    'Left out of "could earn live":',
    pre(left),
    `Fake big wins blocked (too good to be true): ${t.outliers.n}${t.outliers.n ? ` (biggest ${esc(money(t.outliers.biggestUsd))})` : ''}`,
    s.otherStables ? esc(s.otherStables) : 'Other stables: n/a',
  ];
}

// ---------------------------------------------------------------------------
// Section 2: WHAT HAPPENED TO TRADES WE SAW
// ---------------------------------------------------------------------------

function tradesSection(i: FourHourInput): string[] {
  const t = i.totals, f = t.funnel, c = t.checks;
  if (t.hours === 0) return ['<b>2 · WHAT HAPPENED TO TRADES WE SAW</b>', 'n/a (no hourly numbers collected yet this period)'];
  const of = (n: number) => `${int(n).padStart(7)} ${pct(n, f.tradesRead)}`;
  const failedOther = Math.max(0, c.wouldFail - c.tooLate);
  const ofTests = (n: number) => `${int(n).padStart(7)} ${pct(n, c.done)}`;
  const rows = [
    row('Trades seen', int(f.tradesRead).padStart(7), 25),
    row(" ➖ pool we don't track", of(f.noPool), 25),
    row(' ➖ too small to matter', of(f.tooSmall), 25),
    row(' ➖ no second pool', of(f.noPartner), 25),
    ...(f.noUsdPrice ? [row(' ➖ no USD price', of(f.noUsdPrice), 25)] : []),
    row(' ➖ gap smaller than fees', of(f.smallerThanFees), 25),
    row(` ➖ profit under $${t.checkBarUsd.toFixed(2)}`, of(f.belowCheckBar), 25),
    row('Tested on the real chain', int(c.done).padStart(7), 25),
    row(' ✅ would make money', ofTests(c.makeMoney), 25),
    row(' ➖ would lose', ofTests(c.loseMoney), 25),
    row(' ⏳ price moved first', ofTests(c.tooLate), 25),
    row(' ✖️ test failed', ofTests(failedOther), 25),
  ];
  const tm = t.timing;
  const L = [
    '<b>2 · WHAT HAPPENED TO TRADES WE SAW</b>',
    pre(rows),
    `Coins not allowed to trade (tested only): ${int(f.notVetted)}`,
    `Pool pairs paused (keep losing): ${int(t.benchedRoutes)}`,
    tm.rightAfter + tm.othersInBlock + tm.late > 0
      ? `Test timing: ${int(tm.rightAfter)} right after the trade · ${int(tm.othersInBlock)} end of block · ${int(tm.late)} late`
      : 'Test timing: n/a (no timed tests)',
    ...(c.nodeBusy ? [`Test node said "slow down" ${int(c.nodeBusy)}x (tests paused briefly)`] : []),
    '<i>Funnel % are of trades seen; test % are of tests. Tests also include price gaps found without a trade, so the steps overlap and don\'t add up exactly. "Price moved first" = the price changed before the test ran.</i>',
  ];
  return L;
}

// ---------------------------------------------------------------------------
// Section 3: LOOP TRADES
// ---------------------------------------------------------------------------

export function loopConclusion(l: NonNullable<PeriodTotals['loops']>): string {
  if (!l.checked) return 'No loop was tested on the real chain, so nothing is proven yet.';
  if (l.mvcN > 0 && l.modelUsd > 0) {
    const kept = l.checkUsd / l.modelUsd;
    if (kept < 0.25) return `Real tests found much less than the model expected (${Math.round(kept * 100)}% of it): loop estimates are too hopeful.`;
    if (kept < 0.75) return `Real tests found about ${Math.round(kept * 100)}% of what the model expected.`;
    return 'Real tests mostly agreed with the model.';
  }
  if (l.wouldMake === 0) return `0 wins in ${l.checked} real tests: loops are not making money yet.`;
  return `${l.wouldMake} of ${l.checked} real tests would make money.`;
}

function loopSection(i: FourHourInput): string[] {
  const l = i.totals.loops, s = i.snap;
  const head = `<b>3 · LOOP TRADES</b> (practice only, never sent)`;
  if (!s.loopsOn && !l) return [head, '⏸ Loop trader is off.'];
  if (!l) return [head, 'n/a (no loop numbers arrived this period)'];
  const maxP = Math.max(3, Math.min(8, s.maxLoopPools || 5));
  const rows = [`${'Pools'.padEnd(6)}${'Found'.padStart(7)}${'Tested'.padStart(8)}${'Wins'.padStart(6)}${'Lost'.padStart(6)}`];
  for (let n = 3; n <= maxP; n++) rows.push(`${String(n).padEnd(6)}${int(l.foundByLen[n] ?? 0).padStart(7)}${NA.padStart(8)}${NA.padStart(6)}${NA.padStart(6)}`);
  rows.push(`${'All'.padEnd(6)}${int(l.found).padStart(7)}${int(l.checked).padStart(8)}${int(l.wouldMake).padStart(6)}${int(l.lost).padStart(6)}`);
  const L = [head, pre(rows), '<i>Tested/wins/lost are only counted in total, not per loop size (n/a).</i>'];
  L.push(l.mvcN ? `Model said ${esc(money(l.modelUsd))}, real test said ${esc(money(l.checkUsd))} (${l.mvcN} tests, profit before gas)` : 'Model vs real test: n/a (not measured this period)');
  L.push(`→ ${esc(loopConclusion(l))}`);
  if (l.failed || l.cantRun || l.skippedCap) L.push(`Tests that failed ${int(l.failed)} · our contract can't run ${int(l.cantRun)} · not tested (limit or node busy) ${int(l.skippedCap)}`);
  const node = [`slow-downs ${int(l.nodeRateLimited)}`, `paused ${int(l.nodePaused)}`, `busy skips ${int(l.nodeBusySkips)}`];
  L.push(`Loop node: ${node.join(', ')}`);
  if (l.nodeText) L.push(`<i>${esc(l.nodeText)}</i>`);
  if (l.topRoutes.length) {
    L.push(`Biggest loop gaps seen (best ${esc(money(l.bestUsd))}):`);
    l.topRoutes.slice(0, 3).forEach((r, k) => L.push(`  ${k + 1}) ${esc(r.label)}: ${r.n}x, best ${esc(money(r.bestUsd))}`));
  } else L.push(`Biggest loop gap seen: ${esc(money(l.found ? l.bestUsd : null))}`);
  if (l.rivalLoops) L.push(`Rival loop wins: ${l.rivalLoops} (${l.rivalLonger} longer than our max of ${maxP} pools)`);
  return L;
}

// ---------------------------------------------------------------------------
// Section 4: OTHER BOTS
// ---------------------------------------------------------------------------

function rivalSection(i: FourHourInput): string[] {
  const r = i.snap.rivals, t = i.totals;
  const head = `<b>4 · OTHER BOTS</b>${i.snap.rivalBotsKnown !== null ? ` (following ${i.snap.rivalBotsKnown})` : ''}`;
  const L = [head];
  if (!r) L.push('Rival trades: n/a');
  else if (!r.trades) L.push('No rival trades seen this period.');
  else {
    const unsure = (r.junk ?? 0) + (r.uncertain ?? 0) + r.unpriced;
    const confirmed = r.trades - r.failed - unsure;
    const ok = r.trades - r.failed;
    const share = (a: number) => pct(a, ok) || '0%';
    L.push(pre([
      row('Rival trades seen', `${int(r.trades)} by ${r.bots} ${plural(r.bots, 'bot')}`),
      row(' ✅ made money', int(r.wins)),
      row(' ➖ lost or even', int(Math.max(0, confirmed - r.wins))),
      row(' ✖️ failed', int(r.failed)),
      ...(unsure ? [row(' ❔ result unsure', int(unsure))] : []),
      row('Their total after gas', money(r.netUsd)),
      row('Routes', `2 pools ${share(r.routes.two)} · 3 pools ${share(r.routes.three)} · 4+ ${share(r.routes.fourPlus)}`),
    ]));
    const m = r.missed;
    if (m) L.push(`Their wins we couldn't take: ${m.notWatched} on pools we don't read (${esc(money(m.notWatchedUsd))}), ${m.loops} on 3+ pool loops (${esc(money(m.loopsUsd))})`);
  }
  const sp = t.rivalsSpeed;
  L.push(sp.timed ? `Speed check: ${sp.timed} timed · them ${secs(sp.theirMs)}, us ${secs(sp.oursMs)} · we'd be first ${sp.weBeat}x` : 'Speed check: n/a (no rival timed this period)');
  const rc = t.race;
  if (rc.won + rc.lost + rc.unclear > 0) L.push(`Race check on our wins: we'd have won ${rc.won} (${esc(money(rc.wonUsd))}), lost ${rc.lost} (${esc(money(rc.lostUsd))})${rc.unclear ? `, unclear ${rc.unclear}` : ''}`);
  return L;
}

// ---------------------------------------------------------------------------
// Section 5: EXCHANGES & POOLS
// ---------------------------------------------------------------------------

function poolsSection(i: FourHourInput): string[] {
  const s = i.snap, t = i.totals;
  const L = ['<b>5 · EXCHANGES &amp; POOLS</b>'];
  L.push(`Watching: ${int(s.pairs)} pairs, ${int(s.pools)} pools`);
  const np = s.newPools;
  L.push(np ? `New pools: ${np.created} made, ${np.eligible} for coins that already trade deep, ${np.measured} got money${np.measured ? ` (${np.off1} started 1%+ off)` : ''}` : 'New pools: n/a');
  L.push(t.venues.length
    ? `New exchanges tested: ${t.venues.slice(0, 6).map(([n, tests, wins, usd]) => `${esc(n)} ${tests} ${plural(tests, 'test')}, ${wins} ${plural(wins, 'win')}${wins ? ` ${esc(money(usd))}` : ''}`).join('; ')}`
    : 'New exchanges tested: none this period');
  L.push(`Thin pools skipped (look deep, real coins too few): ${int(s.thinPools)}`);
  return L;
}

// ---------------------------------------------------------------------------
// Section 6: SPEED
// ---------------------------------------------------------------------------

const STAGE_LABELS: [string, string][] = [
  ['decode', 'Read trade'], ['lookup', 'Find pools'], ['prices', 'Prices'], ['math', 'Math'],
  ['checks', 'Checks'], ['queue', 'Queue'], ['sign', 'Sign'], ['send', 'Send'],
];
const REACTION_TARGET_MS = 100;

function speedSection(i: FourHourInput): string[] {
  const t = i.totals, s = i.snap;
  const L = ['<b>6 · SPEED</b>'];
  const r = t.reaction;
  L.push(r.usualMs !== null
    ? `Reaction speed: usually ${secs(r.usualMs)}, slowest ${secs(r.slowestMs)} (target under ${secs(REACTION_TARGET_MS)} ${r.usualMs <= REACTION_TARGET_MS ? '✅' : '❌'})`
    : 'Reaction speed: n/a (no trades timed)');
  const rows = STAGE_LABELS.filter(([k]) => (t.stages[k]?.n ?? 0) > 0).map(([k, label]) => row(label, `${msTxt(t.stages[k].usualMs)} / ${msTxt(t.stages[k].slowestMs)}`, 11));
  if (rows.length) { L.push('Where the time goes (usual / slowest, ms):'); L.push(pre(rows)); }
  else L.push('Where the time goes: n/a (no trades measured)');
  const st = t.stalls;
  if (!st.measured) L.push('Freezes: n/a');
  else if (!st.enabled) L.push('Freezes: n/a (freeze finder off)');
  else {
    const causes = st.causes.slice(0, 3).map(([n, c, mx]) => `${esc(n)} ${c}x (max ${secs(mx)})`).join(', ');
    L.push(`Freezes over ${secs(st.thresholdMs)}: ${int(st.freezes)}${st.freezes ? `, longest ${secs(st.worstMs)}${causes ? ` · main causes: ${causes}` : ''}` : ''}`);
    L.push(`Memory clean-up (GC): ${st.gcPct === null ? NA : `${st.gcPct.toFixed(st.gcPct < 1 ? 2 : 1)}% of the time`} (${int(st.gcN)}x)`);
  }
  const m = s.memory;
  L.push(m ? `Memory in use: ${m.rssMb} MB (peak ${m.peakRssMb === null ? NA : `${m.peakRssMb} MB`}), real data ${m.heapMb} MB${m.notes ? `, ${esc(m.notes)}` : ''}` : 'Memory in use: n/a');
  return L;
}

// ---------------------------------------------------------------------------
// Section 7: CONNECTIONS
// ---------------------------------------------------------------------------

function connectionsSection(i: FourHourInput): string[] {
  const s = i.snap, t = i.totals;
  const L = ['<b>7 · CONNECTIONS</b>'];
  L.push(`Live trade feed: ${s.feedOkNow === null ? NA : s.feedOkNow ? '✅ connected now' : '❌ down now'}, dropped ${int(t.feedDrops)}x`);
  const ws = s.ws;
  L.push(ws ? `Block updates (WebSocket): ${ws.healthy ? '✅ live' : '❌ not live (backup polling)'}, ${int(ws.todayMessages)} msgs today of ${ws.cap > 0 ? int(ws.cap) : 'no'} cap${ws.capped ? ' ⚠️ cap reached' : ''}, reconnects ${int(ws.reconnects)}` : 'Block updates (WebSocket): not set up (polling only)');
  L.push(`Practice-test node: ${s.checkNode ? esc(s.checkNode) : NA}`);
  const e = s.nodeErrors;
  L.push(`Node errors / slow-downs: test node ${int(t.checks.nodeBusy)} · free node rests ${int(e.freeNodeRests)} · block reader errors ${int(e.blockReaderErrors)}, slow-downs ${int(e.blockReaderRateLimited)}`);
  const capped = s.nodeUsage.filter((u) => Number.isFinite(u.daily) && u.daily > 0).slice(0, 4);
  if (capped.length) L.push(`Node use today: ${capped.map((u) => `${esc(u.name)} ${int(u.used)}/${int(u.daily)}${u.used >= u.daily ? ' ❌' : u.used >= 0.8 * u.daily ? ' ⚠️' : ''}`).join(' · ')}`);
  return L;
}

// ---------------------------------------------------------------------------
// Section 8: GAS
// ---------------------------------------------------------------------------

function gasSection(i: FourHourInput): string[] {
  const s = i.snap;
  const how = s.gasSource === 'fallback' ? ' (fallback value: no fresh gas reading)' : s.gasSource === 'old' ? ' (old method)' : '';
  return [
    '<b>8 · GAS</b>',
    `Our trade gas now: ${cents(s.gasPerTradeUsd)} with our own money${how}`,
    `Estimate based on: ${s.gasSamples === null ? NA : `${int(s.gasSamples)} real ${plural(s.gasSamples, 'test')}`}${s.gasCalibrated === false ? ' (not enough yet, using measured defaults)' : ''}`,
    `Fees read from swaps: ${int(s.feePoolsFromSwaps)} pools`,
  ];
}

// ---------------------------------------------------------------------------
// Section 9: PARTS CHECK (evidence rules, exported for tests)
// ---------------------------------------------------------------------------

export type PartMark = '✅' | '⚠️' | '⏸' | '🔲';
export interface PartRow { name: string; mark: PartMark; why: string }

export const LOOP_NO_WIN_TESTS = 20;   // this many loop tests with 0 wins = warning
const KIND_NO_WIN_TESTS = 20;          // same for one kind of pool maths

export function partsCheck(i: FourHourInput): PartRow[] {
  const t = i.totals, s = i.snap, c = t.checks, f = t.funnel;
  const out: PartRow[] = [];

  // Normal (2-pool) trades: trades seen, then tested with a real answer.
  if (t.hours === 0) out.push({ name: 'Normal trades', mark: '🔲', why: 'no numbers yet' });
  else if (f.tradesRead === 0 && c.done === 0) out.push({ name: 'Normal trades', mark: '🔲', why: 'not used: no trades seen' });
  else if (c.done === 0) out.push({ name: 'Normal trades', mark: '🔲', why: `not tested: ${int(f.tradesRead)} seen, none reached a test` });
  else if (c.makeMoney + c.loseMoney === 0) out.push({ name: 'Normal trades', mark: '⚠️', why: `all ${c.done} tests failed` });
  else out.push({ name: 'Normal trades', mark: '✅', why: `${c.done} tests, ${c.makeMoney} would make money` });

  // Loop trades.
  const l = t.loops;
  if (!s.loopsOn && !l) out.push({ name: 'Loop trades', mark: '⏸', why: 'switched off' });
  else if (!l || l.checked === 0) out.push({ name: 'Loop trades', mark: '🔲', why: l ? `not tested (${int(l.found)} found)` : 'no numbers this period' });
  else if (l.wouldMake === 0 && l.checked >= LOOP_NO_WIN_TESTS) out.push({ name: 'Loop trades', mark: '⚠️', why: `0 wins in ${l.checked} tests` });
  else if (l.wouldMake === 0) out.push({ name: 'Loop trades', mark: '🔲', why: `only ${l.checked} tests, too few to judge` });
  else out.push({ name: 'Loop trades', mark: '✅', why: `${l.wouldMake} of ${l.checked} tests would make money` });

  // Price maths per pool kind: proven only by a winning real test through that kind.
  for (const k of ['v2', 'v3', 'v4'] as const) {
    const name = `Price math ${k.toUpperCase()}`;
    const x = t.testsByKind[k];
    if (!x || x.tests === 0) out.push({ name, mark: '🔲', why: 'not used in any test' });
    else if (x.wins > 0) out.push({ name, mark: '✅', why: `${x.tests} tests, ${x.wins} would make money` });
    else if (x.tests >= KIND_NO_WIN_TESTS) out.push({ name, mark: '⚠️', why: `${x.tests} tests, no wins` });
    else out.push({ name, mark: '🔲', why: `${x.tests} ${plural(x.tests, 'test')}, too few to judge` });
  }

  // Practice tests themselves (the test node).
  if (t.checksAvailable === false && c.done === 0) out.push({ name: 'Practice tests', mark: '⚠️', why: 'no node could run tests' });
  else if (c.done === 0) out.push({ name: 'Practice tests', mark: '🔲', why: 'not used this period' });
  else if ((c.makeMoney + c.loseMoney) / c.done < 0.5) out.push({ name: 'Practice tests', mark: '⚠️', why: `only ${c.makeMoney + c.loseMoney} of ${c.done} gave an answer` });
  else out.push({ name: 'Practice tests', mark: '✅', why: `${c.makeMoney + c.loseMoney} of ${c.done} gave an answer` });

  // Live sending.
  if (!s.live) out.push({ name: 'Live sending', mark: '⏸', why: 'off (practice mode)' });
  else if (t.live.sent === 0) out.push({ name: 'Live sending', mark: '🔲', why: 'on, nothing sent this period' });
  else if (t.money.realWon === 0) out.push({ name: 'Live sending', mark: '⚠️', why: `${t.live.sent} sent, none won` });
  else out.push({ name: 'Live sending', mark: '✅', why: `${t.money.realWon} of ${t.live.sent} sent won` });

  // Emergency stop: never exercised by itself, so "not tested" unless it is on.
  if (s.emergencyStop === 'on') out.push({ name: 'Emergency stop', mark: '⚠️', why: 'ON now: live sending blocked' });
  else out.push({ name: 'Emergency stop', mark: '🔲', why: s.emergencyStop === 'off' ? 'ready, not triggered this period' : 'state unknown, not tested' });
  return out;
}

// ---------------------------------------------------------------------------
// Section 10: TOP ISSUES (rules, exported for tests)
// Each issue only when the numbers support it. Most serious first, max 5.
// ---------------------------------------------------------------------------

export const TOO_LATE_SHARE = 0.25;    // over 25% of tests too late (and 10+)
export const FREEZE_BAD_MS = 1000;     // a freeze over 1 s
export const FEED_DROPS_BAD = 3;       // live trade feed dropped 3+ times
export const NODE_ERRORS_BAD = 10;     // node errors / slow-downs 10+

export function topIssues(i: FourHourInput): string[] {
  const t = i.totals, s = i.snap, c = t.checks;
  const out: { sev: number; text: string }[] = [];
  if (s.emergencyStop === 'on') out.push({ sev: 100, text: 'Emergency stop is ON. Impact: no live trades can be sent. Fix: remove data/KILL and make sure KILL_SWITCH is not on, if that was not on purpose.' });
  if (s.live && t.live.sent > 0 && t.money.realUsd < 0) out.push({ sev: 95, text: `Live trading lost ${money(t.money.realUsd)} this period. Impact: real money down. Fix: check the losing trades before raising sizes.` });
  if (t.checksAvailable === false && c.done === 0) out.push({ sev: 90, text: 'Practice tests could not run. Impact: no win is proven. Fix: check the test node key and allowance.' });
  if (s.feedOkNow === false || t.feedDrops >= FEED_DROPS_BAD) out.push({ sev: 85, text: `Live trade feed ${s.feedOkNow === false ? 'is down now' : `dropped ${t.feedDrops}x`}. Impact: trades missed while it was down. Fix: check the feed node; tell me if it repeats.` });
  if (t.stalls.enabled && t.stalls.worstMs > FREEZE_BAD_MS) {
    const cause = t.stalls.causes[0]?.[0];
    out.push({ sev: 80, text: `Bot froze for up to ${secs(t.stalls.worstMs)}${cause ? ` (main cause: ${cause})` : ''}. Impact: slow reactions, other bots get there first. Fix: split up or move ${cause ?? 'that job'} off the main thread.` });
  }
  const nodeErr = c.nodeBusy + (s.nodeErrors.blockReaderErrors ?? 0) + (s.nodeErrors.blockReaderRateLimited ?? 0);
  if (nodeErr >= NODE_ERRORS_BAD) out.push({ sev: 70, text: `Node errors or slow-downs: ${nodeErr}. Impact: tests and price updates paused at times. Fix: check node allowances and the backup node.` });
  if (c.done >= 10 && c.tooLate / c.done > TOO_LATE_SHARE) out.push({ sev: 65, text: `${c.tooLate} of ${c.done} tests were too late (price had moved). Impact: test results are less reliable. Fix: test right after the trade (faster test node).` });
  if (c.done >= 20 && (c.makeMoney + c.loseMoney) / c.done < 0.5) out.push({ sev: 60, text: `Only ${c.makeMoney + c.loseMoney} of ${c.done} tests gave a clear answer. Impact: most chances can't be judged. Fix: look at the main failure reasons in the logs.` });
  const l = t.loops;
  if (l && l.checked >= LOOP_NO_WIN_TESTS && l.wouldMake === 0) out.push({ sev: 50, text: `Loop trades: 0 wins in ${l.checked} real tests. Impact: loops add no money yet. Fix: keep them in practice; the loop price model needs to match the real tests first.` });
  if (t.reaction.usualMs !== null && t.reaction.usualMs > 1000) out.push({ sev: 45, text: `Reaction is slow (usually ${secs(t.reaction.usualMs)}). Impact: other bots would win most races. Fix: see where the time goes (section 6).` });
  for (const u of s.nodeUsage) if (Number.isFinite(u.daily) && u.daily > 0 && u.used >= u.daily) out.push({ sev: 40, text: `${u.name} used its whole daily allowance. Impact: its job is paused until the daily reset. Fix: raise the plan or lower its use.` });
  return out.sort((a, b) => b.sev - a.sev).slice(0, 5).map((x) => x.text);
}

// ---------------------------------------------------------------------------
// The three messages
// ---------------------------------------------------------------------------

export function formatFourHourReport(i: FourHourInput): [string, string, string] {
  const m1 = fitBlocks([...header(i, 1), '', ...moneySection(i), '', ...tradesSection(i)]);
  const m2 = fitBlocks([...header(i, 2), '', ...loopSection(i), '', ...rivalSection(i), '', ...poolsSection(i)]);
  const parts = partsCheck(i).map((p) => `${p.mark} ${esc(p.name)}: ${esc(p.why)}`);
  const issues = topIssues(i);
  const m3 = fitBlocks([
    ...header(i, 3), '',
    ...speedSection(i), '',
    ...connectionsSection(i), '',
    ...gasSection(i), '',
    '<b>9 · PARTS CHECK</b>', ...parts,
    '<i>✅ working · ⚠️ warning · ⏸ switched off · 🔲 not used or not tested this period</i>', '',
    '<b>10 · TOP ISSUES</b>',
    ...(issues.length ? issues.map((x, k) => `${k + 1}. ${esc(x)}`) : ['✅ No issues found in the numbers.']),
  ]);
  return [m1, m2, m3];
}
