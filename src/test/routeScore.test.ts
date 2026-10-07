import { RouteScores, WinSizes } from '../core/routeScore';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

let clock = 1_000_000;
const rs = new RouteScores(3, 6 * 3600_000, 0.1, () => clock);
const dud = RouteScores.key('0xA', '0xB');
const good = RouteScores.key('0xC', '0xD');
rs.record(dud, 0); rs.record(dud, -1);
assert(!rs.isBenched(dud), 'two misses: not benched yet');
rs.record(dud, 0.001);
assert(rs.isBenched(dud), 'three tests, never a real win (dust only): benched');
clock += 6 * 3600_000 + 1;
assert(!rs.isBenched(dud), 'comes back after 6 h');
rs.record(good, 0); rs.record(good, 3.5); rs.record(good, 0); rs.record(good, 0);
assert(!rs.isBenched(good), 'a pair that has paid out is never benched');
assert(RouteScores.key('0xAA', '0xbb') === '0xaa>0xbb', 'keys ignore letter case');

const w = new WinSizes(() => clock);
[0.5, 2.5, 6, 28.33].forEach((x) => w.add(x));
assert(w.hour.join(',') === '3,3,2,1,1', 'wins counted at $1/$2/$5/$10/$20 bars');
assert(Math.abs(w.todayUsd[4] - 28.33) < 1e-9 && Math.abs(w.todayUsd[1] - 36.83) < 1e-9, 'money per bar adds up');
w.resetHour();
assert(w.hour.every((x) => x === 0) && w.today[0] === 3, 'hour resets, today keeps');
clock += 24 * 3600_000;
w.add(1.5);
assert(w.today[0] === 1, 'new UTC day starts fresh');
