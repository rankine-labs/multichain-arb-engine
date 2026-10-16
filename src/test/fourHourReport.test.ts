import { FourHourStats, HourSample } from '../report/fourHourStats';
import { formatFourHourReport, FourHourInput, FourHourSnapshot, partsCheck, topIssues, periodLine, fitBlocks, TELEGRAM_LIMIT, LOOP_NO_WIN_TESTS } from '../report/fourHourReport';
import type { RivalSummary } from '../core/rivalWatch';

// ============================================================================
// 4-hour report formatter (report/fourHourReport.ts), reporting only.
//   1. Three messages, each under Telegram's 4,096 limit, tags balanced.
//   2. Coin names and reasons are escaped (no broken HTML).
//   3. Not measured = "n/a", never a made-up number.
//   4. Partial period after a restart is said honestly.
//   5. Practice vs live wording.
//   6. Parts check evidence rules.
//   7. Top issues rules.
//   8. A huge input still fits (whole blocks dropped, never half a tag).
// Prints one full example report (practice mode) at the end.
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const TZ = 'America/Toronto';
const START = Date.UTC(2026, 9, 15, 16, 0, 0); // 12:00 Toronto
const END = START + 4 * 3600_000;               // 16:00 Toronto

function hour(fromMs: number, k = 1): HourSample {
  return {
    fromMs, toMs: fromMs + 3600_000,
    funnel: { tradesRead: 3100 * k, noPool: 410 * k, tooSmall: 900 * k, noPartner: 1200 * k, noUsdPrice: 0, smallerThanFees: 480 * k, found: 110 * k, belowCheckBar: 70 * k, notVetted: 9 * k, sentToCheck: 40 * k },
    checkBarUsd: 0.10,
    checks: { done: 52 * k, makeMoney: 6 * k, loseMoney: 36 * k, wouldFail: 10 * k, tooLate: 3 * k, nodeBusy: 0 },
    timing: { rightAfter: 40 * k, othersInBlock: 9 * k, late: 3 * k },
    benchedRoutes: 4,
    checksAvailable: true,
    race: { won: 2, lost: 1, unclear: 0, wonUsd: 1.1, lostUsd: 0.4 },
    reaction: { n: 200, medianMs: 45, p95Ms: 180 },
    stages: { decode: { n: 200, median: 0.8, p95: 3 }, lookup: { n: 200, median: 0.2, p95: 1.5 }, prices: { n: 200, median: 0.1, p95: 2 }, math: { n: 200, median: 2.1, p95: 9 }, checks: { n: 50, median: 0.4, p95: 2 }, queue: { n: 0, median: null, p95: null }, sign: { n: 0, median: null, p95: null } },
    stalls: { enabled: true, thresholdMs: 50, freezes: 12, worstMs: 240, causes: [['memory clean-up (GC)', 8, 90], ['loop list rebuild', 3, 240]], gcN: 700, gcMs: 25_000 },
    rivalsSpeed: { timed: 8, theirMs: 210, oursMs: 330, weBeat: 2 },
    loops: { found: 130, bestUsd: 4.2, checked: 9, wouldMake: 0, wouldMakeUsd: 0, lost: 8, failed: 1, cantRun: 0, skippedCap: 2, foundByLen: [0, 0, 0, 60, 40, 30], mvcN: 8, modelUsd: 3.2, checkUsd: 0.2, rivalLoops: 3, rivalLonger: 1, nodeRateLimited: 0, nodePaused: 0, nodeBusySkips: 1, nodeText: 'loop node free node (replay ok), rate limited 0, paused 0, skipped node busy 1, today 220/5000', topRoutes: [{ label: 'USDG > WETH > TSLA > USDG', n: 5, bestUsd: 4.2 }, { label: 'WETH > AAPL > USDG > WETH', n: 2, bestUsd: 1.1 }] },
    venues: [['Fables', 6, 1, 0.42], ['UP CL', 3, 0, 0]],
    live: { sent: 0, won: 0, profitUsd: 0, gasUsd: 0 },
    feedDrops: 0,
  };
}

const rivals: RivalSummary = {
  trades: 140, failed: 22, unpriced: 3, junk: 2, uncertain: 5, wins: 81, grossUsd: 19.5, gasUsd: 6.1, gasConfirmedUsd: 4.0, gasFailedUsd: 1.3, gasUnknownUsd: 0.8, gasNotPriced: 0,
  netUsd: 14.2, netWorstUsd: 13.4, medianSizeUsd: 420, medianWinUsd: 0.18, medianGasUsd: 0.03,
  routes: { two: 70, three: 35, fourPlus: 13 }, flash: 10, onOurPools: 90, byPair: [], byBot: [], bots: 6, verifiedBots: 4, whyUncertain: [],
  missed: { notWatched: 12, notWatchedUsd: 2.4, loops: 30, loopsUsd: 5.1 },
};

function snap(over: Partial<FourHourSnapshot> = {}): FourHourSnapshot {
  return {
    live: false, loansOn: false, pairs: 214, pools: 538,
    gasPerTradeUsd: 0.021, gasSamples: 14, gasCalibrated: true, gasSource: 'live', feePoolsFromSwaps: 6,
    otherStables: 'Other stables (today): aUSD gaps 3 ($0.40 model), wins 0 ($0.00, 0 started in aUSD) · UUSD address not known yet · USDe gaps 0 ($0.00 model), wins 0 ($0.00, 0 started in USDe)',
    rivals, rivalBotsKnown: 41,
    newPools: { created: 9, eligible: 3, measured: 1, off05: 1, off1: 0, off3: 0, usd: 12_000, usdOff1: 0, top: [] },
    thinPools: 4,
    memory: { rssMb: 612, peakRssMb: 740, heapMb: 310, notes: 'loop worker heap 95 MB' },
    feedOkNow: true,
    ws: { healthy: true, reconnects: 1, todayMessages: 131_000, cap: 400_000, capped: false },
    checkNode: 'QuickNode (backup: Alchemy)',
    nodeErrors: { blockReaderErrors: 2, blockReaderRateLimited: 0, freeNodeRests: 1 },
    nodeUsage: [{ name: 'QuickNode (checks)', used: 41_000, daily: 100_000 }],
    loopsOn: true, maxLoopPools: 5, emergencyStop: 'off',
    ...over,
  };
}

// A full period: 4 hours plus wins, via the real accumulator.
function period(): FourHourStats {
  const s = new FourHourStats(null, () => START);
  for (let h = 0; h < 4; h++) s.addHour(hour(START + h * 3600_000));
  s.noteWin(2.4, 'WETH uniswap-v3->ramses-v3', 'ok');
  s.noteWin(1.1, 'TSLA/USDG gap', 'ok');
  s.noteWin(0.9, 'AAPL/WETH gap', 'otherCoin');
  s.noteWin(4.0, 'NVDA/USDG gap', 'overSize');
  s.noteOutlierBlocked(785);
  for (let i = 0; i < 30; i++) s.noteTest(['v3', 'v2'], i < 3 ? 0.5 : undefined);
  s.noteTest(['v4', 'v3']);
  return s;
}
const input = (over: Partial<FourHourInput> = {}, snapOver: Partial<FourHourSnapshot> = {}): FourHourInput => ({
  tz: TZ, scheduledFromMs: START, toMs: END, totals: period().peek(END), prevWins: { usd: 6.5, n: 5 }, snap: snap(snapOver), ...over,
});

// A bare "&" (not starting &amp; &lt; &gt;) would make Telegram refuse the message.
const bareAmp = (m: string) => /&(?!amp;|lt;|gt;)/.test(m);
const balanced = (m: string) => !bareAmp(m) && ['pre', 'b', 'i'].every((t) => (m.match(new RegExp(`<${t}>`, 'g')) ?? []).length === (m.match(new RegExp(`</${t}>`, 'g')) ?? []).length);

// 1. Three messages, sizes, headers
const msgs = formatFourHourReport(input());
assert(msgs.length === 3, 'three messages');
msgs.forEach((m, k) => assert(m.length < TELEGRAM_LIMIT, `message ${k + 1} is ${m.length} chars (< ${TELEGRAM_LIMIT})`));
msgs.forEach((m, k) => assert(m.includes(`4-HOUR REPORT (${k + 1}/3)`), `message ${k + 1} has its header`));
msgs.forEach((m, k) => assert(balanced(m), `message ${k + 1}: every tag closed`));
assert(msgs.every((m) => !m.includes('—')), 'no em dashes anywhere');
assert(msgs.every((m) => !bareAmp(m)), 'no bare & anywhere (Telegram HTML)');
assert(msgs[0].includes('Toronto\n\n<b>1 · MONEY</b>'), 'blank line between header and first section');
assert(msgs[0].includes('Practice mode · 12:00 – 16:00 Toronto'), 'period line in Toronto time');
assert(!msgs[0].includes('Partial period'), 'full period: no partial note');
assert(msgs[0].includes('1 · MONEY') && msgs[0].includes('2 · WHAT HAPPENED'), 'message 1: sections 1 and 2');
assert(msgs[1].includes('3 · LOOP TRADES') && msgs[1].includes('4 · OTHER BOTS') && msgs[1].includes('5 · EXCHANGES'), 'message 2: sections 3 to 5');
for (const s of ['6 · SPEED', '7 · CONNECTIONS', '8 · GAS', '9 · PARTS CHECK', '10 · TOP ISSUES']) assert(msgs[2].includes(s), `message 3 has ${s}`);
assert(msgs[0].includes('$8.40 ▲ 29% vs last 4h'), 'checked wins with change vs last 4h ($8.40 vs $6.50)');
assert(msgs[0].includes('Could earn live') && msgs[0].includes('$3.50 (2 wins)'), 'could earn live total');
assert(msgs[0].includes('Fake big wins blocked (too good to be true): 1 (biggest $785.00)'), 'outlier guard line');
assert(msgs[0].includes('12,400'), 'trades seen added over 4 hours (12,400)');

// 2. Escaping
const evil = period();
evil.noteWin(50, '<b>X&Y</b> gap', 'ok');
const em = formatFourHourReport(input({ totals: evil.peek(END) }, { checkNode: 'Node <script>', otherStables: 'A & B <c>' }));
assert(em[0].includes('&lt;b&gt;X&amp;Y&lt;/b&gt; gap') && !em[0].includes('<b>X&Y'), 'coin label escaped');
assert(em[2].includes('Node &lt;script&gt;') && em[0].includes('A &amp; B &lt;c&gt;'), 'node name and stable line escaped');
assert(em.every(balanced), 'escaped report: tags still balanced');

// 3. n/a when not measured
const empty = new FourHourStats(null, () => START).peek(END);
const nm = formatFourHourReport(input({ totals: empty, prevWins: null }, {
  pairs: null, pools: null, gasPerTradeUsd: null, gasSamples: null, gasCalibrated: null, feePoolsFromSwaps: null, otherStables: null,
  rivals: null, rivalBotsKnown: null, newPools: null, thinPools: null, memory: null, feedOkNow: null, ws: null, checkNode: null,
  nodeErrors: { blockReaderErrors: null, blockReaderRateLimited: null, freeNodeRests: null }, nodeUsage: [], emergencyStop: null,
}));
const all = nm.join('\n');
assert(nm.every((m) => m.length < TELEGRAM_LIMIT) && nm.every(balanced), 'empty input still makes 3 valid messages');
assert(all.includes('Checked wins') && all.includes('n/a vs last 4h'), 'no previous period: change is n/a');
assert(all.includes('Average win            n/a') && all.includes('Biggest win            n/a'), 'no wins: average and biggest are n/a');
assert(all.includes('Gas per trade          n/a') && all.includes('Our trade gas now: n/a'), 'gas not measured: n/a');
assert(all.includes('Watching: n/a pairs, n/a pools') && all.includes('Thin pools skipped (look deep, real coins too few): n/a'), 'pool counts not measured: n/a');
assert(all.includes('Reaction speed: n/a') && all.includes('Memory in use: n/a') && all.includes('Rival trades: n/a'), 'speed, memory, rivals: n/a');
assert(all.includes('n/a (no hourly numbers collected yet this period)'), 'funnel with no hourly numbers says so');
assert(!/\$NaN|NaN|undefined|null/.test(all), 'never prints NaN, undefined or null');

// 4. Partial period
const late = new FourHourStats(null, () => START + 47 * 60_000);
late.addHour(hour(START + 47 * 60_000));
const pl = periodLine(input({ totals: late.peek(END) }));
assert(pl.line.includes('12:47 – 16:00'), 'partial: period starts when counting started (12:47)');
assert(pl.partial !== null && pl.partial.includes('counting started 12:47') && pl.partial.includes('cover 60 of 193 min'), 'partial: says when counting started and how much is covered');
const restarted = period().peek(END); restarted.restarts = 1;
assert((periodLine(input({ totals: restarted })).partial ?? '').includes('bot restarted 1x'), 'partial: restart said honestly');
assert(formatFourHourReport(input({ totals: late.peek(END) }))[1].includes('Partial period'), 'partial note on every message');

// 5. Practice vs live
assert(msgs[0].includes('Real money made        $0 (practice)'), 'practice: real money $0 (practice)');
const liveT = period().peek(END); liveT.live = { sent: 5, won: 3, profitUsd: 2.0, gasUsd: 0.15 };
// Real money comes from the hourly money ledgers (true account change: won
// profit minus all gas, failed trades included), owner decision Oct 15.
liveT.money = { realUsd: 1.75, realWon: 3, gasUsd: 0.25, failed: 1, failedCostUsd: 0.10 };
const lm = formatFourHourReport(input({ totals: liveT }, { live: true }));
assert(lm[0].includes('LIVE mode (real money) · 12:00 – 16:00') && lm[0].includes('$1.75 (3 of 5 sent won)'), 'live: mode line and real money after all gas');
assert(lm[0].includes('Gas paid $0.25 · Failed trades 1 (cost $0.10)'), 'live: gas paid and failed trades line');
assert(lm[0].includes('Loans                  off (own money)'), 'loans off: own money');
assert(formatFourHourReport(input({}, { loansOn: true }))[0].includes('on (loan fees: n/a, not measured)'), 'loans on: fees n/a, not invented');

// 6. Parts check
const pc = (i: FourHourInput) => Object.fromEntries(partsCheck(i).map((p) => [p.name, p]));
let p = pc(input());
assert(p['Normal trades'].mark === '✅' && p['Practice tests'].mark === '✅' && p['Practice tests'].why === '168 of 208 gave an answer', 'normal trades and practice tests working (168 of 208 answered)');
assert(p['Loop trades'].mark === '⚠️' && p['Loop trades'].why === '0 wins in 36 tests', `loops: 0 wins in ${LOOP_NO_WIN_TESTS}+ tests = warning`);
assert(p['Price math V3'].mark === '✅' && p['Price math V2'].mark === '✅', 'V2/V3 maths proven by winning tests');
assert(p['Price math V4'].mark === '🔲' && p['Price math V4'].why.includes('too few'), 'V4: 1 test, too few to judge');
assert(p['Live sending'].mark === '⏸' && p['Emergency stop'].mark === '🔲', 'practice: live sending off; emergency stop not tested');
p = pc(input({ totals: empty }, { loopsOn: false }));
assert(p['Normal trades'].mark === '🔲' && p['Loop trades'].mark === '⏸' && p['Price math V2'].mark === '🔲', 'nothing happened: not used; loops off = switched off');
p = pc(input({ totals: liveT }, { live: true, emergencyStop: 'on' }));
assert(p['Live sending'].mark === '✅' && p['Emergency stop'].mark === '⚠️', 'live sending working; emergency stop ON = warning');
const fewLoops = period().peek(END); fewLoops.loops!.checked = 5;
assert(pc(input({ totals: fewLoops }))['Loop trades'].mark === '🔲', 'loops: 5 tests with 0 wins = too few to judge, not a warning');
const allFail = period().peek(END); allFail.checks = { ...allFail.checks, makeMoney: 0, loseMoney: 0 };
assert(pc(input({ totals: allFail }))['Normal trades'].mark === '⚠️', 'all tests failed = warning');

// 7. Top issues
let iss = topIssues(input());
assert(iss.some((x) => x.startsWith('Loop trades: 0 wins in 36 real tests.')), 'issue: loops 0 wins');
assert(iss.every((x) => x.includes('Impact:') && x.includes('Fix:')), 'every issue has Impact and Fix');
assert(!iss.some((x) => /froze|feed/i.test(x)), 'no freeze or feed issue without the numbers');
const bad = period().peek(END);
bad.stalls.worstMs = 1800; bad.feedDrops = 4; bad.checks = { ...bad.checks, tooLate: 100, nodeBusy: 12 };
iss = topIssues(input({ totals: bad }, { emergencyStop: 'on' }));
assert(iss.length === 5, 'at most 5 issues');
assert(iss[0].startsWith('Emergency stop is ON'), 'most serious first');
assert(iss.some((x) => x.includes('froze for up to 1.8 s (main cause: memory clean-up (GC))')), 'issue: freeze over 1 s with main cause');
assert(iss.some((x) => x.includes('dropped 4x')), 'issue: feed drops');
assert(topIssues(input({ totals: empty }, { loopsOn: false })).length === 0, 'quiet period: no issues');
assert(formatFourHourReport(input({ totals: empty }, { loopsOn: false }))[2].includes('✅ No issues found in the numbers.'), 'no issues line');

// 8. Huge input still fits
const huge = period().peek(END);
huge.venues = Array.from({ length: 200 }, (_, k) => [`Exchange ${'<x>'.repeat(30)} ${k}`, 9, 1, 0.1] as [string, number, number, number]);
huge.loops!.topRoutes = Array.from({ length: 6 }, (_, k) => ({ label: 'A > B > '.repeat(60) + k, n: 1, bestUsd: 1 }));
const hm = formatFourHourReport(input({ totals: huge }, { otherStables: 'x'.repeat(5000) }));
assert(hm.every((m) => m.length < TELEGRAM_LIMIT), `huge input: all under ${TELEGRAM_LIMIT} (${hm.map((m) => m.length).join('/')})`);
assert(hm.every(balanced), 'huge input: tags still balanced');
assert(hm[0].includes('left out to fit'), 'huge input: says lines were left out');
const f = fitBlocks(['<b>a</b>', '<pre>' + 'y'.repeat(5000) + '</pre>'], 100);
assert(f.length <= 100 && balanced(f), 'fitBlocks: drops whole blocks, never half a tag');

// Example report for the owner (practice mode, real formatter, sample numbers).
console.log('\n----- EXAMPLE (practice) -----');
for (const m of msgs) console.log(`\n${m}\n[${m.length} chars]`);
