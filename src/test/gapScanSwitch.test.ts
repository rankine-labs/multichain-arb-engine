// MAIN-BOT DIET (Oct 26): the standing-gap scan (~29% of the main bot's
// work in live CPU profiles) is skipped when its results can't be sent.
// Checks the switch (core/gapScanner.ts gapScanEnabled) and that
// runGapScan in shadowMain returns at once when it is off.
import { readFileSync } from 'fs';
import { join } from 'path';
import { gapScanEnabled } from '../core/gapScanner';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// Live today: fire-first only, gaps may not send -> scan off.
assert(gapScanEnabled({ FIRE_FIRST_ONLY: '1', GAP_LIVE_WITH_FIRE_FIRST: '0' }) === false, 'fire-first only + gaps not live: scan off');
assert(gapScanEnabled({ FIRE_FIRST_ONLY: '1' }) === false, 'fire-first only, gap switch unset: scan off');
// Gaps may send -> scan on.
assert(gapScanEnabled({ FIRE_FIRST_ONLY: '1', GAP_LIVE_WITH_FIRE_FIRST: '1' }) === true, 'gaps allowed with fire-first: scan on');
assert(gapScanEnabled({}) === true, 'not fire-first only (old setup): scan on');
// Owner override both ways.
assert(gapScanEnabled({ FIRE_FIRST_ONLY: '1', GAP_SCAN: '1' }) === true, 'GAP_SCAN=1 forces the scan on');
assert(gapScanEnabled({ GAP_SCAN: '0' }) === false, 'GAP_SCAN=0 turns it off');

const src = readFileSync(join(__dirname, '..', '..', 'src', 'shadowMain.ts'), 'utf8');
const start = src.indexOf('const runGapScan = async () => {');
const guard = src.indexOf('if (!GAP_SCAN_ON) return;', start);
const busy = src.indexOf('if (gapRunning)', start);
assert(start > 0 && guard > start && guard < busy, 'runGapScan returns at once when the scan is off (before any work)');
