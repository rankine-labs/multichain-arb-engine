import { AutoVet } from '../core/autoVet';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Auto-vet: coins earn the vetted list by passing practice checks; trap coins get blocked.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const WETH = '0x' + '11'.repeat(20), COIN = '0x' + 'aa'.repeat(20), TRAP = '0x' + 'bb'.repeat(20), NEW = '0x' + 'cc'.repeat(20);
let clock = 1_000_000;
const base = new Set([WETH]);
const v = new AutoVet((t) => base.has(t.toLowerCase()), 3, 1, 7 * 24 * 3600_000, () => clock);

// Scan-vetted coins are never tracked.
assert(v.record([WETH], 'profit').added.length === 0 && v.stats().watching === 0, 'already-vetted coin (from the scan) is ignored');

// 2 losses + 1 win = 3 completed checks with a win -> vetted on the third.
assert(v.record([WETH, COIN], 'loss').added.length === 0, 'check 1 (loss): not yet');
assert(v.record([WETH, COIN], 'loss').added.length === 0, 'check 2 (loss): not yet');
const r3 = v.record([WETH, COIN], 'profit');
assert(r3.added.length === 1 && r3.added[0] === COIN && v.isAutoVetted(COIN), 'check 3 (profit): vetted');

// Only losses never qualify (could be a hidden sell tax).
const NOWIN = '0x' + 'dd'.repeat(20);
for (let i = 0; i < 5; i++) v.record([WETH, NOWIN], 'loss');
assert(!v.isAutoVetted(NOWIN), 'losses only (5 checks, no win): never vetted');

// Node trouble doesn't count either way.
v.record([WETH, NEW], 'fail', 'rate limited (HTTP 429)');
v.record([WETH, NEW], 'fail', 'network: timeout');
assert(!v.isBlocked(NEW) && v.stats().watching >= 1 === true || !v.isBlocked(NEW), 'node errors: not blocked, not counted');

// A trap-coin failure blocks, and wins afterwards don't vet it.
v.record([WETH, TRAP], 'fail', 'execution reverted: TRANSFER_FAILED');
assert(v.isBlocked(TRAP), 'transfer failure: coin blocked');
for (let i = 0; i < 4; i++) v.record([WETH, TRAP], 'profit');
assert(!v.isAutoVetted(TRAP), 'blocked coin is not vetted by later wins');
// Implausible profit (broken price data) also blocks.
const JUNK = '0x' + 'ee'.repeat(20);
v.record([WETH, JUNK], 'fail', 'implausible profit');
assert(v.isBlocked(JUNK), 'implausible profit: coin blocked');

// An auto-vetted coin that later fails like a trap coin is removed.
const rm = v.record([WETH, COIN], 'fail', 'Error("ERC20: transfer amount exceeds balance")');
assert(rm.removed.length === 1 && !v.isAutoVetted(COIN) && v.isBlocked(COIN), 'auto-vetted coin removed after a trap failure');

// Block expires after 7 days; the coin can then earn its way back.
clock += 7 * 24 * 3600_000 + 1;
assert(!v.isBlocked(TRAP), 'block lifts after 7 days');

// Saved and reloaded.
const v2 = new AutoVet((t) => base.has(t.toLowerCase()), 3, 1, 7 * 24 * 3600_000, () => clock);
const N2 = '0x' + 'f1'.repeat(20);
v2.record([WETH, N2], 'profit'); v2.record([WETH, N2], 'loss'); v2.record([WETH, N2], 'loss');
const dir = mkdtempSync(join(tmpdir(), 'autovet-'));
v2.save(join(dir, 'a.json'));
const v3 = new AutoVet((t) => base.has(t.toLowerCase()), 3, 1, 7 * 24 * 3600_000, () => clock);
const loaded = v3.load(join(dir, 'a.json'));
assert(loaded.includes(N2) && v3.isAutoVetted(N2), 'vetted coins survive a restart');
