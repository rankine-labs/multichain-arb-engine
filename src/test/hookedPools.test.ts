// Tests for the listed hooked V4 pools (config/robinhoodHookedPools.ts).
//
// What must hold:
//   - the hook permission check reads the right address bits (only the two
//     "returns delta" swap flags make a hook unsafe for normal price maths);
//   - the server file is read safely: bad entries skipped, a missing file
//     means "none", duplicates dropped, unsafe hooks never listed;
//   - the listed-hooks venue never passes the live trade gate.
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hookPermissions, hookKeepsSwapMaths, loadHookedPoolFile, listedKeysFor } from '../config/robinhoodHookedPools';
import { isExecutableVenue, isPracticeTestableVenue, extraWatcherVenues } from '../config/robinhoodVenues';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// Hook addresses whose last 14 bits carry the flags (Uniswap v4 Hooks.sol).
const FABLES_LIKE = '0x06a889870c8f83640d6816319f72e2aa579b6080'; // beforeInitialize + beforeSwap (0x2080)
const DELTA_HOOK = '0x00000000000000000000000000000000000000c8'; // beforeSwap + afterSwap + beforeSwapReturnsDelta
const AFTER_DELTA = '0x0000000000000000000000000000000000000044'; // afterSwap + afterSwapReturnsDelta
assert(hookPermissions(FABLES_LIKE).beforeSwap && !hookPermissions(FABLES_LIKE).returnsSwapDelta, 'Fables-style hook: fee hook, amounts untouched');
assert(hookKeepsSwapMaths(FABLES_LIKE), 'Fables-style hook keeps normal swap maths');
assert(!hookKeepsSwapMaths(DELTA_HOOK) && !hookKeepsSwapMaths(AFTER_DELTA), 'returns-delta hooks are unsafe');

// Server file.
const dir = mkdtempSync(join(tmpdir(), 'hooked-'));
const file = join(dir, 'pools.json');
const id1 = '0x' + '11'.repeat(32), id2 = '0x' + '22'.repeat(32);
const ok = { id: id1, currency0: '0x' + '00'.repeat(20), currency1: '0x' + 'ab'.repeat(20), fee: 0x800000, tickSpacing: 60, hooks: FABLES_LIKE, label: 'X/USDG' };
writeFileSync(file, JSON.stringify({ pools: [
  ok,
  { ...ok },                                       // duplicate id
  { ...ok, id: id2, hooks: DELTA_HOOK },           // unsafe hook
  { ...ok, id: '0x1234' },                         // bad id
  { ...ok, id: '0x' + '33'.repeat(32), tickSpacing: 0 }, // bad tick spacing
] }));
const loaded = loadHookedPoolFile(file);
assert(loaded.length === 3, `bad entries skipped when loading (${loaded.length} kept)`);
const keys = listedKeysFor('v4-hooks', loaded);
assert(keys.length === 1 && keys[0].id === id1 && keys[0].hooks === FABLES_LIKE.toLowerCase(), 'duplicates and unsafe hooks never listed');
assert(loadHookedPoolFile(join(dir, 'missing.json')).length === 0, 'missing file: no pools, no error');
writeFileSync(file, '{not json');
assert(loadHookedPoolFile(file).length === 0, 'broken file: no pools, no error');

// Venue gates.
assert(!isExecutableVenue('v4-hooks'), 'listed hooked pools never pass the live trade gate');
assert(isPracticeTestableVenue('v4-hooks'), 'listed hooked pools may be practice-checked');
const ev = extraWatcherVenues({ stateView: '0x' + '04'.repeat(20), poolManager: '0x' + '05'.repeat(20), weth: '0x' + 'cc'.repeat(20) });
assert(!ev.some((v) => v.dex === 'v4-hooks' && !(v.keys?.length)), 'the listed venue is only watched when it has pools');
