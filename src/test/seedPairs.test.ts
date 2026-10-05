import { cleanPairs, loadStartPairs, saveStartPairs } from '../core/seedPairs';
import { ROBINHOOD_SEED_PAIRS } from '../config/robinhoodSeedPairs';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Checks the start-pairs list: saved file wins, backup used when the file is
// missing or junk, bad entries dropped, duplicates removed, save/load round trip.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const A = '0x1111111111111111111111111111111111111111', B = '0x2222222222222222222222222222222222222222', C = '0x3333333333333333333333333333333333333333';
const dir = mkdtempSync(join(tmpdir(), 'seed-'));
const file = join(dir, 'top.json');
const backup = [{ a: A, b: C, label: 'A/C' }];

// Missing file -> backup
let r = loadStartPairs(file, backup);
assert(r.source === 'backup' && r.pairs.length === 1 && r.pairs[0].b === C, 'missing file -> backup list');

// Junk file -> backup
writeFileSync(file, 'not json');
r = loadStartPairs(file, backup);
assert(r.source === 'backup', 'unreadable file -> backup list');

// Saved list wins after a save
saveStartPairs(file, [{ a: A, b: B, label: 'A/B' }]);
r = loadStartPairs(file, backup);
assert(r.source === 'saved' && r.pairs.length === 1 && r.pairs[0].b === B, 'saved list wins over backup');

// Cleaning: bad addresses, same token twice, duplicates in either order
const cleaned = cleanPairs([{ a: A, b: B }, { a: B, b: A }, { a: A, b: A }, { a: 'nope', b: B }, null, { a: A }]);
assert(cleaned.length === 1, 'bad, self and duplicate pairs dropped');
assert(cleanPairs('x').length === 0, 'non-array -> empty');

// Empty saved list -> backup; empty backup -> none
writeFileSync(file, '[]');
assert(loadStartPairs(file, backup).source === 'backup', 'empty saved list -> backup');
assert(loadStartPairs(join(dir, 'none.json'), []).source === 'none', 'nothing anywhere -> none');

// The committed backup list itself must be valid
assert(cleanPairs(ROBINHOOD_SEED_PAIRS).length === ROBINHOOD_SEED_PAIRS.length, 'committed backup list is all valid pairs');
