import { DryRunPnl } from '../core/dryRunPnl';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Checks the dry-run earnings tracker: verified and model-only kept apart,
// junk values ignored, days roll over on Toronto time, 7-day total, best
// trade, and totals survive a restart (saved file).

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const file = join(mkdtempSync(join(tmpdir(), 'pnl-')), 'pnl.json');
// 2026-10-05 15:00 Toronto = 19:00 UTC
let clock = Date.UTC(2026, 9, 5, 19, 0, 0);
const p = new DryRunPnl(file, 'America/Toronto', () => clock);

p.recordVerified(25.5, 'NVDA/USDG v3>v4');
p.recordVerified(40, 'WETH/USDG v4>v3');
p.recordModelOnly(30);
p.recordVerified(-3, 'bad');            // ignored
p.recordVerified(NaN, 'bad');           // ignored
let s = p.summary();
assert(Math.abs(s.today.verifiedUsd - 65.5) < 1e-9 && s.today.verifiedCount === 2, 'verified trades added, junk ignored');
assert(s.today.modelUsd === 30 && s.today.modelCount === 1, 'model-only kept separate');
assert(s.today.best?.usd === 40 && s.today.best.label.startsWith('WETH'), 'best trade of the day kept');
assert(p.line().includes('$65.50 verified') && p.line().includes('$30.00 model-only'), 'summary line shows both buckets');

// Day rollover at Toronto midnight (not UTC): 23:30 Toronto is still the same day.
clock = Date.UTC(2026, 9, 6, 3, 30, 0); // 23:30 Toronto on Oct 5
p.recordVerified(10, 'late');
assert(p.summary().today.verifiedUsd === 75.5, 'still the same Toronto day at 23:30');
clock = Date.UTC(2026, 9, 6, 5, 0, 0);  // 01:00 Toronto on Oct 6
p.recordVerified(5, 'next day');
s = p.summary();
assert(s.today.verifiedUsd === 5 && s.last7.verifiedUsd === 80.5 && s.last7.days === 2, 'new day starts at Toronto midnight; 7-day total spans both');

// Survives a restart.
p.save();
const p2 = new DryRunPnl(file, 'America/Toronto', () => clock);
assert(p2.summary().allTime.verifiedUsd === 80.5 && p2.summary().allTime.modelUsd === 30, 'totals survive a restart');

// Days older than 7 drop out of the 7-day total but stay in all-time.
clock = Date.UTC(2026, 9, 14, 17, 0, 0);
assert(p2.summary().last7.verifiedUsd === 0 && p2.summary().allTime.verifiedUsd === 80.5, 'old days leave the 7-day total, stay in all-time');

// Junk data guard: a single "profit" above the per-trade cap is never counted.
{
  const p3 = new DryRunPnl(null, 'America/Toronto', () => clock);
  p3.recordVerified(49_842_419.92, 'COCO junk');
  p3.recordModelOnly(1e9);
  assert(p3.summary().today.verifiedUsd === 0 && p3.summary().today.modelUsd === 0, 'absurd single-trade profits are ignored');
}
