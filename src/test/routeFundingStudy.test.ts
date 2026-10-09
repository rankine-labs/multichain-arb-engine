// Tests for the route + funding study maths (core/routeFundingStudy.ts):
// junk wins, net under each way of paying, per-route stats, own-money needs.
import { StudyTrade, isJunkWin, netUnder, pct, bucketStats, capitalNeeds, formatStudy, bucketOf, FUNDING_SETTINGS } from '../core/routeFundingStudy';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;

// A made-up rival win; fields not given take everyday values.
const win = (o: Partial<StudyTrade>): StudyTrade => ({
  block: 1, bot: '0xbot', pools: 2, flashLoan: false, poolPaidFirst: true, verified: true, gainToken: 'USDG',
  grossUsd: 0.05, gasUsd: 0.02, sizeUsd: 200, sizeToken: 'USDG', executable: true, unknownFactory: false, shape: 'a > b', ...o,
});

// 1) Junk: impossible gain for the size.
assert(!isJunkWin({ grossUsd: 0.13, sizeUsd: 600 }), 'a 2-cent-per-$100 gain is normal');
assert(isJunkWin({ grossUsd: 252, sizeUsd: 92 }), '$252 gain on a $92 trade is junk');
assert(isJunkWin({ grossUsd: 6, sizeUsd: 0 }) && !isJunkWin({ grossUsd: 0.02, sizeUsd: 0 }), 'no size: over $5 is junk, cents are not');

// 2) Net under each way of paying.
const own = FUNDING_SETTINGS[0]!, flash9 = FUNDING_SETTINGS[4]!;
assert(near(netUnder(win({}), own)!, 0.03), 'own money, same gas: rival net');
// $200 x 9 bps = $0.18 fee, gas 0.02 x 1.5 = 0.03: 0.05 - 0.03 - 0.18 = -0.16
assert(near(netUnder(win({}), flash9)!, -0.16), '9 bps loan on $200 wipes out a 5-cent gain');
assert(netUnder(win({ sizeUsd: 0 }), flash9) === null && netUnder(win({ sizeUsd: 0 }), own) !== null, 'unknown size: loan fee cannot be worked out, own money still can');

// 3) Percentiles.
assert(pct([], 0.5) === 0 && pct([3, 1, 2], 0.5) === 2 && pct([1, 2, 3, 4], 0.9) === 4, 'nearest-rank percentiles');

// 4) Per-route stats: junk left out, losers left out, funding counts.
const trades = [
  win({}), win({ grossUsd: 0.3, gasUsd: 0.03, sizeUsd: 1000 }),
  win({ grossUsd: 252, sizeUsd: 92 }),                 // junk
  win({ grossUsd: 0.01, gasUsd: 0.02 }),               // lost money after gas: not a win
  win({ verified: false, gainToken: 'other', grossUsd: 0 }),
  win({ flashLoan: true, unknownFactory: true, executable: false }),
];
const s = bucketStats(trades);
assert(s.arbs === 6 && s.verified === 4 && s.junk === 1, 'arbs counted, wins = verified and positive after gas, junk split out');
assert(s.flashLoan === 1 && s.unknownFactory === 1 && s.executable === 2, 'flash loans and unknown factories counted');
assert(near(s.netSum, 0.03 + 0.27 + 0.03), 'rival net summed over clean wins only');
const ownRow = s.funding.find((f) => f.label === own.label)!, f9 = s.funding.find((f) => f.label === flash9.label)!;
assert(ownRow.positive === 3 && f9.positive === 0, 'own money keeps all three clean wins, a 9 bps loan keeps none');

// 5) Own money needed per coin.
const caps = capitalNeeds([...trades, win({ sizeToken: 'WETH', sizeUsd: 3000 })]);
const usdg = caps.find((c) => c.token === 'USDG')!, weth = caps.find((c) => c.token === 'WETH')!;
assert(usdg.wins === 3 && usdg.max === 1000 && weth.wins === 1 && weth.max === 3000, 'own money: biggest single trade per coin, junk left out');

// 6) Buckets and the report text.
assert(bucketOf(2) === '2' && bucketOf(3) === '3' && bucketOf(5) === '4+', 'route length buckets');
const txt = formatStudy([...trades, win({ pools: 3, shape: 'x > y > z' })], { blocks: 100, txs: 500, chainMinutes: 10, windows: 2 });
assert(/\[2 pools\] arbs 6/.test(txt) && /\[3 pools\] arbs 1/.test(txt) && /Own money USDG/.test(txt) && /1x \$0\.0300 x > y > z/.test(txt), 'report lists routes, own money and loop shapes');
assert(/Junk win \(left out\)/.test(txt), 'junk wins listed separately');
const junkLoop = formatStudy([win({ pools: 3, shape: 'j > u > nk', grossUsd: 4000, sizeUsd: 0 })], { blocks: 1, txs: 1, chainMinutes: 1, windows: 1 });
assert(!/x \$\d+\.\d+ j > u > nk/.test(junkLoop) && /Junk win \(left out\): 3 pools/.test(junkLoop), 'junk loops are not counted in the loop shapes');
assert(!/\u2014/.test(txt), 'no long dashes in the report');
