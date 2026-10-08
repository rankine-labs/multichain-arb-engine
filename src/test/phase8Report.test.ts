import { bandOf, ProfitBands, PROFIT_BAND_LABELS } from '../core/profitBands';
import { formatPlainHourly } from '../core/telegramFormatter';
import { summarize, RivalRec } from '../core/rivalWatch';

// Phase 8 (Oct 8): new hourly report lines: profit bands, check results by
// kind, our own gas, research lane, rival wins we couldn't take, bottom line.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// --- bands ---------------------------------------------------------------
assert(bandOf(0.005) === -1 && bandOf(0.01) === 0 && bandOf(0.0999) === 0 && bandOf(0.10) === 1, 'band edges: under 1c is dust, 1c-10c, 10c starts the next band');
assert(bandOf(0.75) === 2 && bandOf(3) === 3 && bandOf(7) === 4 && bandOf(15) === 5 && bandOf(28.33) === 6, 'bands up to $20+ (our $28.33 win lands in $20+)');
assert(PROFIT_BAND_LABELS.length === 7, '7 bands as in the spec');
const pb = new ProfitBands();
pb.add(0.05, '2026-10-08'); pb.add(0.3, '2026-10-08'); pb.add(0.3, '2026-10-08'); pb.add(0.001, '2026-10-08'); pb.add(28.33, '2026-10-08');
assert(pb.hour[0] === 1 && pb.hour[1] === 2 && pb.hour[6] === 1 && pb.hourDust === 1, 'hour counts per band; dust counted apart');
assert(Math.abs(pb.dayUsd - 28.98) < 1e-9, 'daily dollar total excludes dust');
pb.resetHour();
assert(pb.hour.every((x) => x === 0) && pb.day[1] === 2, 'hour resets, day keeps');
pb.add(1, '2026-10-09');
assert(pb.day[3] === 1 && pb.day[1] === 0, 'new Toronto day resets the daily bands');
assert(ProfitBands.line([0, 2, 0, 0, 0, 0, 1]) === '$0.10-$0.50: 2 · $20+: 1' && ProfitBands.line([0, 0, 0, 0, 0, 0, 0]) === null, 'band line shows only non-empty bands');

// --- rival wins we couldn't take -------------------------------------------
const base: RivalRec = { t: 0, bot: '0xb', pair: 'USDG/WETH', pools: 2, sizeUsd: 500, grossUsd: 0.05, gasUsd: 0.01, failed: false, flash: false, ours: true, conf: 'confirmed' };
const s = summarize([base, { ...base, ours: false }, { ...base, pools: 3, ours: false }, { ...base, pools: 3, grossUsd: 0.005 }]);
assert(s.missed.notWatched === 2 && Math.abs(s.missed.notWatchedUsd - 0.08) < 1e-9 && s.missed.loops === 1, 'missed wins: 2 on pools we don\'t read, 1 loop win (losing loop not counted)');

// --- hourly report lines ------------------------------------------------------
const hourly = formatPlainHourly({
  windowLabel: 'x', live: false, feedOk: true, feedReconnects: 0, pairs: 1, spots: 1, pricesFrom: 'free', freeNodeBusy: 0,
  differencesFound: 3, checks: { done: 4, makeMoney: 2, loseMoney: 1, wouldFail: 1, nodeBusy: 0 }, checksAvailable: true,
  earned: { todayChecked: 0, todayCheckedCount: 0, todayUnchecked: 0, todayUncheckedCount: 0, weekChecked: 0 },
  reactionMs: { typical: 5, slowest5pct: 9 }, topDifferences: [], rivalWins: { ...s, botsKnown: 8, botsVerified: 2 },
  ourGas: { ownUsd: 0.018, flashUsd: 0.027 },
  profitBands: { hour: [1, 2, 0, 0, 0, 0, 0], day: [1, 2, 0, 0, 0, 0, 1], hourUsd: 0.65, dayUsd: 28.98 },
  simOutcomes: [['would make money', 2], ['would lose money', 1], ['node busy, out of allowance or unreachable', 1]],
  research: '🔬 <b>Research lane</b>: 3 tested',
});
assert(hourly.includes('Profitable checks by size this hour: $0.01-$0.10: 1 · $0.10-$0.50: 2') && hourly.includes('Today: ') && hourly.includes('$20+: 1'), 'hourly shows profit bands (hour and today)');
assert(hourly.includes('Check results by kind: would make money 2 · would lose money 1'), 'hourly shows check results by kind');
assert(hourly.includes('Our trade gas right now: 1.80¢ with our own money, 2.70¢ with a loan'), 'hourly shows our real gas cost');
assert(hourly.includes('Research lane'), 'research lane folded into the hourly report');
assert(hourly.includes("Their wins we couldn't take: 2 on pools we don't read"), 'hourly shows rival wins missed by reason');
assert(hourly.includes('<b>Bottom line</b>') && hourly.includes('confirmed only'), 'honest bottom line present');
