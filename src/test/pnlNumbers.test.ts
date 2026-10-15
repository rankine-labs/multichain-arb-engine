import { GapCredit } from '../core/gapCredit';
import { DryRunPnl } from '../core/dryRunPnl';
import { WinSizes } from '../core/routeScore';
import { formatPlainHourly } from '../core/telegramFormatter';

// Oct 15: the hourly report's money numbers must not count one open gap twice,
// must show how much of "today" came from a few big wins, and must label
// which lines leave out standing gaps or include coins we can't trade.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// --- one open gap counts once (only its growth after the first time) --------
{
  const g = new GapCredit();
  assert(g.credit('A>B', 150) === 150, 'first confirmation of a gap counts in full');
  assert(g.credit('A>B', 400) === 250, 'same open gap re-checked after doubling: only the extra $250 counts');
  assert(g.credit('A>B', 300) === 0, 'same open gap, smaller now: nothing new counts');
  assert(g.credit('C>D', 5) === 5, 'a different gap is counted on its own');
  g.closed('A>B');
  assert(g.credit('A>B', 100) === 100, 'after the gap closed, a new gap on the same pools counts in full');
  assert(g.credit('E>F', -1) === 0 && g.credit('E>F', NaN) === 0, 'losses and junk never count');
  // Total for one gap that grew 150 -> 400 is 400 (its biggest size), not 550.
  const g2 = new GapCredit();
  const total = [150, 400].reduce((a, x) => a + g2.credit('X>Y', x), 0);
  assert(total === 400, 'a growing open gap adds up to its biggest confirmed size');
  // Memory guard: the map is wiped instead of growing forever.
  const g3 = new GapCredit(2);
  g3.credit('1', 1); g3.credit('2', 1); g3.credit('3', 1);
  assert([...g3.keys()].length === 1, 'memory guard clears old keys when full');
}

// --- big wins tracked apart in the saved totals -----------------------------
{
  const p = new DryRunPnl(null, 'America/Toronto', () => Date.UTC(2026, 9, 15, 14, 0, 0));
  p.recordVerified(2, 'small');
  p.recordVerified(450, 'BIG1/USDG gap');
  p.recordVerified(20, 'edge');
  const t = p.summary().today;
  assert(t.bigCount === 2 && t.bigUsd === 470, 'wins of $20+ are added up separately');
  assert(t.verifiedUsd === 472 && t.verifiedCount === 3, 'the main total is unchanged');
}

// --- WinSizes can follow Toronto's day -------------------------------------
{
  // 23:00 Toronto on Oct 14 = 03:00 UTC Oct 15 (a new UTC day, same Toronto day).
  let clock = Date.UTC(2026, 9, 15, 2, 0, 0);
  const w = new WinSizes(() => clock, 'America/Toronto');
  w.add(3);
  clock = Date.UTC(2026, 9, 15, 3, 0, 0);
  w.add(3);
  assert(w.today[0] === 2, 'Toronto day: midnight UTC does not reset today');
  clock = Date.UTC(2026, 9, 15, 5, 0, 0); // 01:00 Toronto Oct 15
  w.add(3);
  assert(w.today[0] === 1, 'Toronto day: resets at Toronto midnight');
}

// --- hourly report labels and the "without big wins" line -------------------
{
  const txt = formatPlainHourly({
    windowLabel: 'x', live: false, feedOk: true, feedReconnects: 0, pairs: 1, spots: 1, pricesFrom: 'free', freeNodeBusy: 0,
    differencesFound: 3,
    checks: { done: 4, makeMoney: 2, loseMoney: 1, wouldFail: 1, nodeBusy: 0,
      winSizes: { bars: [1, 2, 5, 10, 20], hour: [1, 0, 0, 0, 0], today: [12, 8, 6, 2, 0], todayUsd: [67, 61, 54, 23, 0] } },
    checksAvailable: true,
    earned: { todayChecked: 1500.08, todayCheckedCount: 90, todayUnchecked: 0, todayUncheckedCount: 0, weekChecked: 4143.95,
      todayBigUsd: 1300, todayBigCount: 3, best: { usd: 480, label: 'ABC/USDG gap' } },
    reactionMs: { typical: 5, slowest5pct: 9 }, topDifferences: [],
    profitBands: { hour: [0, 0, 0, 0, 0, 0, 0], day: [0, 0, 0, 0, 0, 0, 3], hourUsd: 0, dayUsd: 1300 },
  });
  assert(txt.includes('Wins right after a trade we followed, by size (after gas, vetted coins, standing gaps not included), today:'), 'trigger-only win sizes say so');
  assert(!txt.includes('Real wins by size'), 'old misleading label gone');
  assert(txt.includes("Today, all coins incl. ones we can't trade: $20+: 3 (total $1300.00)"), 'band totals say they include coins we cannot trade');
  assert(txt.includes('of that, $1300.00 from 3 wins of $20+ (rare, check before trusting). Without them: $200.08 from 87'), 'shows today without the big wins');
  assert(txt.includes('Biggest today: $480.00 ABC/USDG gap'), 'names the biggest win so it can be found in the logs');
  // No big wins: no extra lines.
  const plain = formatPlainHourly({
    windowLabel: 'x', live: false, feedOk: true, feedReconnects: 0, pairs: 1, spots: 1, pricesFrom: 'free', freeNodeBusy: 0,
    differencesFound: 0, checks: { done: 0, makeMoney: 0, loseMoney: 0, wouldFail: 0, nodeBusy: 0 }, checksAvailable: true,
    earned: { todayChecked: 5, todayCheckedCount: 2, todayUnchecked: 0, todayUncheckedCount: 0, weekChecked: 5, best: { usd: 4, label: 'x' } },
    reactionMs: { typical: null, slowest5pct: null }, topDifferences: [],
  });
  assert(!plain.includes('Without them') && !plain.includes('Biggest today'), 'no big-win lines when there are no $20+ wins');
}
