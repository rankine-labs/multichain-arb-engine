import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FourHourStats, HourSample, MAX_HOURS, fourHourMark, parseLoopNode, loopSampleFrom } from '../report/fourHourStats';

// ============================================================================
// 4-hour stats (report/fourHourStats.ts), reporting only.
//   1. Hour samples and wins add up correctly.
//   2. A restart (new instance, same file) keeps the numbers and counts the restart.
//   3. Closing a period starts a fresh one and remembers last period's wins
//      and the sent mark (also across a restart).
//   4. Running-total deltas handle a restart (total starts again from zero).
//   5. Bounded: never more than MAX_HOURS hour samples.
//   6. The 4-hour marks in Toronto time.
//   7. Loop hour conversion and the loop node line reader.
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// One hour with simple numbers; `k` scales everything so sums are easy to check.
function hour(fromMs: number, k = 1): HourSample {
  return {
    fromMs, toMs: fromMs + 3600_000,
    funnel: { tradesRead: 1000 * k, noPool: 100 * k, tooSmall: 200 * k, noPartner: 300 * k, noUsdPrice: 0, smallerThanFees: 250 * k, found: 150 * k, belowCheckBar: 100 * k, notVetted: 5 * k, sentToCheck: 50 * k },
    checkBarUsd: 0.10,
    checks: { done: 40 * k, makeMoney: 4 * k, loseMoney: 30 * k, wouldFail: 6 * k, tooLate: 2 * k, nodeBusy: k },
    timing: { rightAfter: 30 * k, othersInBlock: 8 * k, late: 2 * k },
    benchedRoutes: 3 * k,
    checksAvailable: true,
    race: { won: k, lost: k, unclear: 0, wonUsd: 1.5 * k, lostUsd: 0.5 * k },
    reaction: { n: 100, medianMs: 40 * k, p95Ms: 200 * k },
    stages: { decode: { n: 100, median: 1 * k, p95: 5 * k }, math: { n: 100, median: 2 * k, p95: 9 * k } },
    stalls: { enabled: true, thresholdMs: 50, freezes: 10 * k, worstMs: 300 * k, causes: [['GC', 6 * k, 80], ['loop scan', 4 * k, 300 * k]], gcN: 500, gcMs: 36_000 },
    rivalsSpeed: { timed: 10, theirMs: 200, oursMs: 300, weBeat: 2 * k },
    loops: { found: 100 * k, bestUsd: 3 * k, checked: 10 * k, wouldMake: 0, wouldMakeUsd: 0, lost: 9 * k, failed: k, cantRun: 0, skippedCap: 0, foundByLen: [0, 0, 0, 50 * k, 30 * k, 20 * k], mvcN: 10 * k, modelUsd: 5 * k, checkUsd: 0.5 * k, rivalLoops: k, rivalLonger: 0, nodeRateLimited: k, nodePaused: 0, nodeBusySkips: 2, nodeText: 'loop node free node (replay ok), rate limited 1, paused 0, today 50/5000', topRoutes: [{ label: 'USDG>WETH>X>USDG', n: 3, bestUsd: 3 * k }] },
    venues: [['Fables', 4 * k, k, 0.4 * k]],
    live: { sent: 0, won: 0, profitUsd: 0, gasUsd: 0 },
    feedDrops: k,
  };
}

const dir = mkdtempSync(join(tmpdir(), 'r4h-'));
const file = join(dir, 'report-4h.json');
let clock = Date.UTC(2026, 9, 15, 16, 0, 0); // 12:00 Toronto
const now = () => clock;

// 1. Sums
const a = new FourHourStats(file, now);
a.addHour(hour(clock, 1));
a.addHour(hour(clock + 3600_000, 2));
a.noteWin(1.5, 'WETH uniswap-v3->uniswap-v2', 'ok');
a.noteWin(3.0, 'X/USDG gap', 'otherCoin');
a.noteWin(0.5, 'Y/USDG gap', 'loan');
a.noteWin(-1, 'junk', 'ok');               // ignored
a.noteWin(NaN, 'junk', 'ok');              // ignored
a.noteOutlierBlocked(785);
a.noteOutlierBlocked(60);
a.noteTest(['v3', 'v2'], 0.2);
a.noteTest(['v3', 'v3']);                  // same kind twice counts once
a.noteTest(['orderbook', 'v4']);
let t = a.peek(clock + 2 * 3600_000);
assert(t.funnel.tradesRead === 3000 && t.funnel.noPartner === 900, 'funnel counts add up over hours');
assert(t.checks.done === 120 && t.checks.tooLate === 6 && t.checks.nodeBusy === 3, 'test counts add up');
assert(t.benchedRoutes === 6, 'paused pool pairs: the latest hour is shown (a level, not a sum)');
assert(t.wins.n === 3 && Math.abs(t.wins.usd - 5) < 1e-9, 'wins: 3 counted ($5), junk ignored');
assert(t.wins.best?.usd === 3 && t.wins.best.label === 'X/USDG gap', 'biggest win kept with its label');
assert(t.wins.liveOk.n === 1 && t.wins.leftOut.otherCoin.usd === 3 && t.wins.leftOut.loan.n === 1, 'could-earn-live and left-out buckets');
assert(t.outliers.n === 2 && t.outliers.biggestUsd === 785, 'fake big wins: count and biggest');
assert(t.testsByKind.v3.tests === 2 && t.testsByKind.v3.wins === 1 && t.testsByKind.v2.tests === 1 && t.testsByKind.other.tests === 1 && t.testsByKind.v4.tests === 1, 'tests by pool kind');
assert(t.stalls.freezes === 30 && t.stalls.worstMs === 600, 'freezes add up, longest is the worst');
assert(t.stalls.causes[0][0] === 'GC' && t.stalls.causes[0][1] === 18, 'freeze causes merged by name');
assert(t.stalls.gcPct !== null && Math.abs(t.stalls.gcPct - 1) < 1e-9, 'memory clean-up share of time (72 s of 2 h = 1%)');
assert(t.reaction.usualMs === 60 && t.reaction.slowestMs === 400, 'reaction: weighted usual, worst slowest');
assert(t.stages.math.usualMs === 3 && t.stages.math.slowestMs === 18 && t.stages.math.n === 200, 'stages: weighted usual, worst slowest');
assert(t.loops !== null && t.loops.checked === 30 && t.loops.foundByLen[5] === 60 && t.loops.bestUsd === 6, 'loop numbers add up, best is the best');
assert(t.loops!.nodeRateLimited === 3 && t.loops!.topRoutes[0].bestUsd === 6, 'loop node slow-downs add up; routes merged');
assert(t.venues[0][0] === 'Fables' && t.venues[0][1] === 12 && t.venues[0][2] === 3, 'new exchanges merged by name');
assert(t.race.won === 3 && t.feedDrops === 3 && t.rivalsSpeed.weBeat === 6, 'race, feed drops and speed check add up');
assert(t.coveredMs === 2 * 3600_000 && t.hours === 2 && t.restarts === 0, 'coverage: 2 hours, no restart');

// 2. Restart: a new instance from the same file keeps everything.
a.save();
const b = new FourHourStats(file, now);
t = b.peek(clock + 2 * 3600_000);
assert(t.funnel.tradesRead === 3000 && t.wins.n === 3 && t.outliers.n === 2, 'restart: numbers kept from the file');
assert(t.restarts === 1, 'restart: counted');

// 3. Rollover
clock += 4 * 3600_000; // 16:00 Toronto
const c1 = b.close('2026-10-15T16', clock);
assert(c1.totals.wins.n === 3 && c1.prev === null, 'close: returns the period; no previous period yet');
t = b.peek(clock);
assert(t.hours === 0 && t.wins.n === 0 && t.outliers.n === 0 && t.restarts === 0 && t.fromMs === clock, 'close: fresh period starts at the mark');
assert(b.lastSentKey === '2026-10-15T16', 'close: sent mark remembered');
b.noteWin(2, 'z', 'ok');
const c2 = b.close('2026-10-15T20', clock + 4 * 3600_000);
assert(c2.prev !== null && Math.abs(c2.prev.usd - 5) < 1e-9, 'next close: last period wins handed back for the ▲/▼ line');
const b2 = new FourHourStats(file, now);
assert(b2.lastSentKey === '2026-10-15T20' && Math.abs((b2.prevWins()?.usd ?? 0) - 2) < 1e-9, 'sent mark and last wins survive a restart (never sent twice)');

// 4. Deltas
assert(b2.delta('x', 10) === 10, 'delta: first reading is all new');
assert(b2.delta('x', 15) === 5, 'delta: growth since last reading');
assert(b2.delta('x', 3) === 3, 'delta: smaller total = bot restarted, all of it is new');
assert(b2.delta('y', NaN) === 0, 'delta: broken value counts 0');

// 5. Bounded
const m = new FourHourStats(null, now);
for (let i = 0; i < MAX_HOURS + 5; i++) m.addHour(hour(clock + i * 3600_000));
assert(m.peek().hours === MAX_HOURS, `never more than ${MAX_HOURS} hour samples kept`);

// Broken file: starts fresh, no crash.
require('fs').writeFileSync(file, '{not json');
const broken = new FourHourStats(file, now);
assert(broken.peek().hours === 0 && broken.lastSentKey === '', 'unreadable file: starts fresh');

// 6. Marks (Oct 15 2026: Toronto is UTC-4)
const tz = 'America/Toronto';
assert(fourHourMark(Date.UTC(2026, 9, 15, 20, 0, 30), tz) === '2026-10-15T16', '16:00:30 Toronto is the 16:00 mark');
assert(fourHourMark(Date.UTC(2026, 9, 15, 20, 29, 0), tz) === '2026-10-15T16', '16:29 still inside the grace window');
assert(fourHourMark(Date.UTC(2026, 9, 15, 20, 45, 0), tz) === null, '16:45 is not a mark');
assert(fourHourMark(Date.UTC(2026, 9, 15, 19, 0, 0), tz) === null, '15:00 is not a mark');
assert(fourHourMark(Date.UTC(2026, 9, 16, 4, 2, 0), tz) === '2026-10-16T00', 'midnight Toronto is the 00:00 mark of the new day');

// 7. Loops
const pn = parseLoopNode('loop node free node (replay ok), rate limited 3, paused 1, skipped node busy 2, today 50/5000');
assert(pn.rateLimited === 3 && pn.paused === 1 && pn.busySkips === 2, 'loop node line: numbers read');
const pm = parseLoopNode('loop node main checking node');
assert(pm.rateLimited === null && pm.busySkips === null, 'loop node line without numbers: n/a');
const ls = loopSampleFrom({
  found: 5, bestUsd: 1, checked: 2, wouldMake: 1, wouldMakeUsd: 0.3, lost: 1, failed: 0, cantRun: 0, cantRunWhy: [], skippedCap: 0,
  foundByLen: [0, 0, 0, 3, 2], topRoutes: [{ label: 'A>B>C', n: 2, bestUsd: 1 }], updates: 0, medianMs: null, slowestMs: null, cycles: 0, capped: false,
  cyclesByLen: [], rebuild: null, rival: { loops: 2, comparable: 1, weFound: 0, leadMsMedian: null, longer: 1, unseen: 0, topBot: null },
  checkVsEstimate: { n: 2, medianEstUsd: null, medianResultUsd: null, medianDelayMs: null, lossesQuick: 0, lossesSlow: 1, topFail: null, modelVsCheck: [{ timing: 'latest', n: 2, modelUsd: 1.2, checkUsd: 0.3, losses: 1 }] },
}, 'loop node free node (replay ok), rate limited 0, paused 0, today 1/5000');
assert(ls.mvcN === 2 && ls.modelUsd === 1.2 && ls.rivalLonger === 1 && ls.nodeBusySkips === 0, 'loop hour converted (model vs test, rival, node)');

rmSync(dir, { recursive: true, force: true });
assert(!existsSync(dir), 'temp folder cleaned up');
