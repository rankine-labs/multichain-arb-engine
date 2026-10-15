// Tests for the hourly report version 2 (Oct 15, reporting only):
//   - report/ledgers.ts: last hour / today (Toronto) / 7 days, Toronto
//     midnight, restart, practice and live kept apart
//   - report/hourlyReport.ts: the approved layout in practice and live,
//     partial period, n/a, HTML escaping, length, overall verdict
//   - report/periodStats.ts: the 4-hour running totals
//   - REPORT_V2=0 sends the old hourly message unchanged
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RealMoneyLedger, MoneyLedgers, LedgerSnapshot } from '../report/ledgers';
import { PeriodStats } from '../report/periodStats';
import { formatHourlyV2, hourNumbersFrom, overallVerdict, plainRoute, usd, reportV2On, hourlyMessage, HourlyReportInput, TELEGRAM_MAX_CHARS } from '../report/hourlyReport';
import { formatPlainHourly } from '../core/telegramFormatter';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const dir = () => mkdtempSync(join(tmpdir(), 'rep2-'));
const H = 3_600_000, D = 86_400_000;

// --- Real money ledger: Toronto day, 7 days, restart --------------------------
{
  const file = join(dir(), 'live-money.json');
  // Oct 16, 03:30 UTC = Oct 15, 23:30 Toronto (EDT, UTC-4): still "yesterday".
  let clock = Date.UTC(2026, 9, 16, 3, 30);
  const led = new RealMoneyLedger(file, 'America/Toronto', () => clock);
  led.add({ status: 'profit', gasUsd: 0.10, profitUsd: 2.10 });          // +2.00, Oct 15 Toronto
  clock = Date.UTC(2026, 9, 16, 4, 30);                                   // 00:30 Oct 16 Toronto
  led.add({ status: 'profit', gasUsd: 0.20, profitUsd: 1.20 });          // +1.00, Oct 16
  led.add({ status: 'reverted', gasUsd: 0.30 });                         // failed: gas only
  led.add({ status: 'dropped', gasUsd: 0 });                             // never mined: nothing
  let t = led.totals();
  assert(near(t.today, 1.0), `Toronto midnight: today only counts after 00:00 Toronto (${t.today})`);
  assert(near(t.week, 3.0), `7 days includes yesterday evening (${t.week})`);
  assert(t.todayPeriod.failed === 1 && near(t.todayPeriod.failedCostUsd, 0.3), 'failed trade gas kept apart, not in money made');
  assert(near(t.todayPeriod.gasUsd, 0.5) && t.todayPeriod.won === 1, 'gas paid counts won and failed trades');
  // Restart: a new ledger reads the same file.
  const led2 = new RealMoneyLedger(file, 'America/Toronto', () => clock);
  t = led2.totals();
  assert(near(t.today, 1.0) && near(t.week, 3.0) && t.todayPeriod.failed === 1, 'restart: real money totals survive');
  // 6 days later the Oct 15 trade is still in the 7 days; 7 days later it is not.
  clock = Date.UTC(2026, 9, 21, 12, 0);   // Oct 21 Toronto
  assert(near(led2.totals().week, 3.0), 'Oct 21: Oct 15 still inside the last 7 days');
  clock = Date.UTC(2026, 9, 22, 12, 0);   // Oct 22 Toronto
  assert(near(led2.totals().week, 1.0), 'Oct 22: Oct 15 dropped out of the last 7 days');
  // Old buckets are trimmed (bounded file).
  clock = Date.UTC(2026, 9, 30, 12, 0);
  led2.add({ status: 'profit', gasUsd: 0, profitUsd: 0.5 });
  assert(led2.hourCount() === 1, 'buckets older than 8 days are forgotten');
}

// --- Money ledgers: last hour, practice vs live -------------------------------
{
  let clock = Date.UTC(2026, 9, 15, 18, 0);
  const practice = { checked: () => ({ today: 41.10, week: 312.40 }), couldEarn: () => ({ today: 22.60, week: 140.20 }) };
  const real = new RealMoneyLedger(join(dir(), 'live.json'), 'America/Toronto', () => clock);
  const ml = new MoneyLedgers(practice, real, () => clock);
  ml.notePracticeWin(2.31, 'WETH ramses-v3->uniswap-v2', true);
  ml.notePracticeWin(1.79, 'WETH/USDG gap', true);
  ml.notePracticeWin(2.18, 'ORBIO uniswap-v2->uniswap-v3', false);
  ml.notePracticeWin(5_000, 'junk', true);                    // over the junk limit
  ml.notePracticeWin(-1, 'loss', true);                       // not a win
  // A real result while NOT live never counts (practice can't add real money).
  ml.noteRealResult({ status: 'profit', gasUsd: 0.1, profitUsd: 9 }, false);
  clock += H;
  const s = ml.takePeriod();
  assert(near(s.checked.lastHour, 6.28) && s.checkedCount === 3, `checked wins last hour $6.28 from 3 (${s.checked.lastHour})`);
  assert(near(s.couldEarn.lastHour, 4.10) && s.couldEarnCount === 2, `could earn live last hour $4.10 (${s.couldEarn.lastHour})`);
  assert(s.checked.today === 41.10 && s.checked.week === 312.40 && s.couldEarn.week === 140.20, 'today / 7 days come from the practice totals');
  assert(s.real.lastHour === 0 && s.real.today === 0 && s.real.week === 0, 'practice: real money stays $0.00 (practice never mixed in)');
  assert(s.best?.usd === 2.31 && s.best.label === 'WETH ramses-v3->uniswap-v2', 'best win this hour kept with its label');
  assert(s.periodStartMs === Date.UTC(2026, 9, 15, 18, 0) && s.periodEndMs === clock, 'period window recorded');
  const s2 = ml.takePeriod();
  assert(s2.checked.lastHour === 0 && s2.best === null && s2.periodStartMs === clock, 'take resets the last hour only');
  // Live result: real ledger only, practice untouched.
  ml.noteRealResult({ status: 'profit', gasUsd: 0.25, profitUsd: 3.25 }, true);
  ml.noteRealResult({ status: 'reverted', gasUsd: 0.4 }, true);
  const s3 = ml.peekPeriod();
  assert(near(s3.real.lastHour, 3.0) && near(s3.real.today, 3.0), 'live: real money made = profit minus its gas');
  assert(s3.realPeriod.failed === 1 && near(s3.realPeriod.failedCostUsd, 0.4) && near(s3.realPeriod.gasUsd, 0.65), 'live: gas and failed trades for the line');
  assert(s3.checked.lastHour === 0 && s3.couldEarn.lastHour === 0, 'live results never touch the practice ledgers');
}

// --- Formatter ------------------------------------------------------------------
const snap = (over: Partial<LedgerSnapshot> = {}): LedgerSnapshot => ({
  periodStartMs: Date.UTC(2026, 9, 15, 18, 0), periodEndMs: Date.UTC(2026, 9, 15, 19, 0, 1),
  checked: { lastHour: 6.28, today: 41.10, week: 312.40 },
  couldEarn: { lastHour: 4.10, today: 22.60, week: 140.20 },
  real: { lastHour: 0, today: 0, week: 0 },
  realPeriod: { madeUsd: 0, won: 0, gasUsd: 0, failed: 0, failedCostUsd: 0 },
  checkedCount: 4, couldEarnCount: 3,
  best: { usd: 2.31, label: 'WETH ramses-v3->uniswap-v2' },
  ...over,
});
const input = (over: Partial<HourlyReportInput> = {}): HourlyReportInput => ({
  live: false, tz: 'America/Toronto', restarted: false, money: snap(),
  normal: { won: 4, tested: 60 }, loop: { won: 0, tested: 36 }, races: { won: 4, lost: 0 },
  feedOk: true, reactionMs: 26, tooLate: 0, longestFreezeMs: 500, nodeErrors: 0,
  ...over,
});
{
  const msg = formatHourlyV2(input());
  console.log('----- practice sample -----\n' + msg + '\n---------------------------');
  assert(msg.startsWith('🤖 <b>ROBINHOOD · HOURLY</b>\nPractice mode (no real money yet)\n14:00 – 15:00 Toronto · full hour'), 'header, mode and full-hour period line');
  assert(/Checked wins\s+\$6\.28\s+\$41\.10\s+\$312\.40/.test(msg), 'checked wins row: last hour / today / 7 days');
  assert(/Could earn live\s+\$4\.10\s+\$22\.60\s+\$140\.20/.test(msg), 'could earn live row');
  assert(/Real money made\s+\$0\.00\s+\$0\.00\s+\$0\.00/.test(msg), 'real money row is $0.00 in practice');
  assert(msg.includes('(Could earn live = starts in USDG/WETH,') && msg.includes('fits our own money, no loan)'), 'could earn live explained');
  assert(/Normal trades\s+4 wins out of 60 tested/.test(msg) && /Loop trades\s+0 wins out of 36 tested/.test(msg), 'trade counts in plain words');
  assert(/Races\s+would have won 4, lost 0/.test(msg), 'races line');
  assert(msg.includes('Best win') && msg.includes('$2.31  WETH Ramses V3 → Uniswap V2'), 'best win with plain exchange names');
  assert(/Live trade feed\s+✅ connected/.test(msg) && /Reaction speed\s+26 ms  \(target under 100\)/.test(msg), 'feed and reaction speed');
  assert(/Trades too late to test\s+0/.test(msg) && /Longest freeze\s+0\.5 s/.test(msg) && /Overall\s+✅ all good/.test(msg), 'too late, freeze, overall');
  assert(!msg.includes('Gas paid'), 'practice: no gas / failed trades line');
  assert(!/\u2014/.test(msg), 'no em dashes');
  assert((msg.match(/<pre>/g) ?? []).length === 3 && (msg.match(/<\/pre>/g) ?? []).length === 3, 'three monospace blocks, all closed');
  assert(msg.length < TELEGRAM_MAX_CHARS, `fits one Telegram message (${msg.length} chars)`);
  // Columns line up: the three money rows have the same length.
  const pre = msg.split('<pre>')[1]!.split('</pre>')[0]!.split('\n');
  assert(pre[1]!.length === pre[2]!.length && pre[2]!.length === pre[3]!.length, 'money columns are aligned');

  // Live mode: header, real money and the gas / failed line.
  const live = formatHourlyV2(input({
    live: true,
    money: snap({ real: { lastHour: 3.0, today: 12.5, week: 1234.5 }, realPeriod: { madeUsd: 3, won: 1, gasUsd: 0.65, failed: 1, failedCostUsd: 0.4 } }),
  }));
  console.log('----- live sample -----\n' + live + '\n-----------------------');
  assert(live.includes('<b>LIVE (real money)</b>') && !live.includes('Practice mode'), 'live header');
  assert(/Real money made\s+\$3\.00\s+\$12\.50\s+\$1,234\.50/.test(live), 'live: real money row filled (with thousands comma)');
  assert(live.includes('Gas paid $0.65 · Failed trades 1 (cost $0.40)'), 'live: gas paid and failed trades line');

  // Partial period after a restart.
  const part = formatHourlyV2(input({ restarted: true, money: snap({ periodStartMs: Date.UTC(2026, 9, 15, 18, 22) }) }));
  assert(part.includes('partial: 14:22 – 15:00 Toronto (bot restarted)'), 'partial period line after a restart');
  const short = formatHourlyV2(input({ money: snap({ periodStartMs: Date.UTC(2026, 9, 15, 18, 40) }) }));
  assert(short.includes('partial: 14:40 – 15:00 Toronto (short hour)'), 'short window is never called a full hour');

  // n/a for anything not measured.
  const na = formatHourlyV2(input({ normal: null, loop: null, races: null, feedOk: null, reactionMs: null, tooLate: null, longestFreezeMs: null, nodeErrors: null, money: snap({ best: null }) }));
  assert(/Normal trades\s+n\/a \(checking was off\)/.test(na) && /Loop trades\s+n\/a \(no loop numbers\)/.test(na), 'n/a for trades not measured');
  assert(/Races\s+n\/a/.test(na) && /Reaction speed\s+n\/a/.test(na) && /Trades too late to test\s+n\/a/.test(na) && /Longest freeze\s+n\/a/.test(na) && /Live trade feed\s+n\/a/.test(na), 'n/a for health not measured');
  assert(na.includes('none this hour'), 'no win this hour says so');
  assert(/Overall\s+✅ all good/.test(na), 'nothing measured is not treated as a problem');

  // HTML escaping (labels come from coin symbols on chain).
  const evil = formatHourlyV2(input({ money: snap({ best: { usd: 1, label: '<b>X&Y</b> a->b' } }) }));
  assert(evil.includes('&lt;b&gt;X&amp;Y&lt;/b&gt;') && !evil.includes('<b>X'), 'labels are HTML escaped');
  const huge = formatHourlyV2(input({ startLabel: 'x'.repeat(5_000) }));
  assert(huge.length <= TELEGRAM_MAX_CHARS, 'never longer than Telegram allows');

  // Overall verdict rules.
  assert(overallVerdict({ feedOk: false, reactionMs: 20, longestFreezeMs: 0, tooLate: 0, nodeErrors: 0 }).text === 'live trade feed down', 'feed down is a warning');
  const slow = overallVerdict({ feedOk: true, reactionMs: 140, longestFreezeMs: 0, tooLate: 0, nodeErrors: 0 });
  assert(slow.mark === '⚠️' && slow.text === 'reaction slow (140 ms)', 'slow reaction is a warning with the number');
  assert(overallVerdict({ feedOk: true, reactionMs: 20, longestFreezeMs: 1_500, tooLate: 0, nodeErrors: 0 }).mark === '⚠️', 'freeze over 1 s is a warning');
  assert(overallVerdict({ feedOk: true, reactionMs: 20, longestFreezeMs: 0, tooLate: 6, nodeErrors: 0 }).text === '6 trades too late to test', 'more than 5 too late is a warning');
  assert(overallVerdict({ feedOk: true, reactionMs: 20, longestFreezeMs: 0, tooLate: 5, nodeErrors: 0 }).mark === '✅', '5 too late is still fine');
  assert(overallVerdict({ feedOk: true, reactionMs: 20, longestFreezeMs: 0, tooLate: 0, nodeErrors: 12 }).text === 'node errors (12)', 'node errors are a warning');
  const bad = overallVerdict({ feedOk: false, reactionMs: 300, longestFreezeMs: 0, tooLate: 0, nodeErrors: 0 });
  assert(bad.mark === '🚨' && bad.text.startsWith('live trade feed down (+1 more'), 'two problems at once is serious');
  assert(overallVerdict({ feedOk: true, reactionMs: 20, longestFreezeMs: 6_000, tooLate: 0, nodeErrors: 0 }).mark === '🚨', 'a freeze over 5 s is serious on its own');
  assert(usd(-0.123) === '-$0.12' && usd(-0.001) === '$0.00' && usd(NaN) === 'n/a', 'money format (loss, tiny, broken)');
  assert(plainRoute('WETH/USDG gap') === 'WETH/USDG gap', 'gap labels kept as they are');
}

// --- 4-hour running totals --------------------------------------------------------
{
  const file = join(dir(), 'period-stats.json');
  const ps = new PeriodStats(file);
  const h1 = hourNumbersFrom(input());
  const h2 = hourNumbersFrom(input({ loop: null, normal: { won: 1, tested: 10 }, races: { won: 1, lost: 2 }, money: snap({ periodStartMs: Date.UTC(2026, 9, 15, 19, 0), periodEndMs: Date.UTC(2026, 9, 15, 20, 0), best: { usd: 3.5, label: 'big' } }) }));
  ps.add(h1); ps.add(h2);
  const restarted = new PeriodStats(file);   // restart in between
  const p = restarted.peek();
  assert(p.hours === 2 && near(p.money.checkedUsd, 12.56) && near(p.money.couldEarnUsd, 8.2), '4-hour money sums the hours (and survives a restart)');
  assert(p.normal?.won === 5 && p.normal.tested === 70 && p.normal.measuredHours === 2, 'normal trades summed');
  assert(p.loop?.won === 0 && p.loop.tested === 36 && p.loop.measuredHours === 1, 'loop trades: only measured hours summed');
  assert(p.races?.won === 5 && p.races.lost === 2, 'races summed');
  assert(p.best?.usd === 3.5 && p.fromMs === Date.UTC(2026, 9, 15, 18, 0) && p.toMs === Date.UTC(2026, 9, 15, 20, 0), 'best win and window over the 4 hours');
  const taken = restarted.take();
  assert(taken.hours === 2 && restarted.peek().hours === 0 && restarted.peek().loop === null, 'take hands over the totals and starts fresh');
  assert(new PeriodStats(file).peek().hours === 0, 'the fresh start is saved too');
}

// --- REPORT_V2 switch ----------------------------------------------------------------
{
  assert(reportV2On({}) === true && reportV2On({ REPORT_V2: '1' }) === true, 'REPORT_V2 unset or 1: new report');
  assert(reportV2On({ REPORT_V2: '0' }) === false, 'REPORT_V2=0: old report');
  const oldInput = {
    windowLabel: '13:06 to 14:06', live: false, feedOk: true, feedReconnects: 0,
    pairs: 60, spots: 261, pricesFrom: 'free' as const, freeNodeBusy: 0, differencesFound: 93,
    checks: { done: 60, makeMoney: 4, loseMoney: 50, wouldFail: 6, nodeBusy: 0 }, checksAvailable: true,
    earned: { todayChecked: 41.1, todayCheckedCount: 9, todayUnchecked: 0, todayUncheckedCount: 0, weekChecked: 312.4 },
    reactionMs: { typical: 26, slowest5pct: 80 }, topDifferences: [],
  };
  assert(hourlyMessage(false, input(), oldInput) === formatPlainHourly(oldInput), 'REPORT_V2=0: the old hourly message, unchanged');
  assert(hourlyMessage(true, input(), oldInput) === formatHourlyV2(input()), 'REPORT_V2=1: the new hourly message');
}
