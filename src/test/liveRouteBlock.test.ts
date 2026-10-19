// Live route block (core/routeScore.ts, Oct 19): one failed/losing real check
// or one failed live trade on a pool pair stops REAL sends on that pair for 6 h,
// with no $1 bypass; a real check that makes money lifts it.
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LiveRouteBlock } from '../core/routeScore';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// The two GLXY pools from the first live day (V3 buy, V4 sell).
const V3 = '0xC67C2D20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const V4 = '0x0487ff11bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER = '0x1111111111111111111111111111111111111111';

let now = 1_000_000;
const b = new LiveRouteBlock(6 * 3600_000, () => now);

assert(b.reason(V3, V4) === null && b.count() === 0, 'nothing blocked at start');

// One failed real check is enough (the old bench needed 3 and let $1+ through).
b.block(V3, V4, 'real check failed: ZeroAmount()');
assert(b.reason(V3, V4) === 'real check failed: ZeroAmount()', 'one failed check blocks the pair');
assert(b.reason(V4, V3) !== null, 'blocked in both directions (same two pools)');
assert(b.reason(V3, OTHER) === null, 'other pairs with the same pool are not blocked');
assert(b.reason(V3.toLowerCase(), V4.toUpperCase().replace('0X', '0x')) !== null, 'address case does not matter');
assert(b.count() === 2, 'count: both directions');

// Still blocked just before 6 h, free after.
now += 6 * 3600_000 - 1;
assert(b.reason(V3, V4) !== null, 'still blocked just under 6 h');
now += 2;
assert(b.reason(V3, V4) === null && b.count() === 0, 'free again after 6 h');

// A real check that makes money lifts the block at once.
b.block(V3, V4, 'live trade failed on chain');
b.clear(V3, V4);
assert(b.reason(V3, V4) === null && b.reason(V4, V3) === null, 'a winning real check lifts the block');

// Saved and restored (restart keeps it); expired entries are dropped.
const file = join(mkdtempSync(join(tmpdir(), 'liveblock-')), 'live-blocks.json');
b.block(V3, V4, 'real check: loss');
b.save(file);
const b2 = new LiveRouteBlock(6 * 3600_000, () => now);
assert(b2.load(file) === 2 && b2.reason(V3, V4) === 'real check: loss', 'survives a restart');
now += 7 * 3600_000;
const b3 = new LiveRouteBlock(6 * 3600_000, () => now);
assert(b3.load(file) === 0, 'expired blocks are not restored');
assert(new LiveRouteBlock().load(join(tmpdir(), 'no-such-dir', 'x.json')) === 0, 'missing file: starts empty, no crash');

// Memory guard: entries are bounded.
const small = new LiveRouteBlock(1000, () => now, 10);
for (let i = 0; i < 20; i++) { small.block(`0x${i}`, '0xff', 'x'); now += 2000; }
assert(small.count() <= 2, 'old entries pruned (bounded memory)');
