// ONE SEND PER GAP (Oct 25, live): one WETH/USDG gap was found as 3 routes
// sharing a pool and all 3 were sent in the same second. Checks (on the
// source, since runGapScan lives inside shadowMain's start-up block):
//   - a route is skipped while one of its pools is held, BEFORE any check
//     budget is used (the skip comes before the rate-limit lines),
//   - both pools are held right before fireTrade (after CONFIRMED),
//   - the hold time is a setting with a 3 s default.
import { readFileSync } from 'fs';
import { join } from 'path';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const src = readFileSync(join(__dirname, '..', '..', 'src', 'shadowMain.ts'), 'utf8');
const skip = src.indexOf('if (gapPoolBusy(g.buyPool.poolAddress) || gapPoolBusy(g.sellPool.poolAddress))');
const budget = src.indexOf('gapTestTimes.push(Date.now())');
const confirmed = src.indexOf('standing gap ${label} CONFIRMED');
const hold = src.indexOf('gapPoolHold(g.buyPool.poolAddress); gapPoolHold(g.sellPool.poolAddress);');
const fire = src.indexOf('await fireTrade({', confirmed);
assert(skip > 0 && budget > 0 && skip < budget, 'busy-pool skip comes before the check budget is used');
assert(confirmed > 0 && hold > confirmed && hold < fire, 'both pools held after CONFIRMED, right before fireTrade');
assert(/GAP_SENT_POOL_HOLD_MS \?\? 3_000/.test(src), 'hold time is a setting, default 3 s');
assert((src.match(/gapPoolHold\(/g) ?? []).length === 3, 'pools held in exactly one place (plus the helper)');
