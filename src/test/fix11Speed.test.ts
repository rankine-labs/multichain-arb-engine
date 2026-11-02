import { buildTrackList } from '../execution/copy2';
import { mixedPools } from './fix11Pools';

// ============================================================================
// FIX 11 speed check (TEST machine numbers; the server is busier). Skipped
// on the live server (SKIP_TIMING_TESTS=1, scripts/run-tests.js); GitHub's
// checks run it before every merge.
// Copy 2's track list over 3,000 watched V4 pools, rebuilt like every 5 s:
// the repeat build must be clearly faster with the V4 key memo than without.
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';

function timeIt(fn: () => unknown, reps: number): number {
  let best = Infinity;
  for (let i = 0; i < reps; i++) { const t = performance.now(); fn(); best = Math.min(best, performance.now() - t); }
  return best;
}

const pools = mixedPools(3_000);
process.env.COPY2_V4_KEY_MEMO = '0';
const off = timeIt(() => buildTrackList(pools, PM), 3);
delete process.env.COPY2_V4_KEY_MEMO;
buildTrackList(pools, PM);   // first build fills the memo
const on = timeIt(() => buildTrackList(pools, PM), 3);
console.log(`[fix 11, TEST numbers] track list over ${pools.length} pools: old ${off.toFixed(1)} ms -> memo ${on.toFixed(1)} ms (${(off / Math.max(on, 0.01)).toFixed(1)}x)`);
assert(on * 3 < off, 'repeat track list build at least 3x faster with the V4 key memo');

// Second fix: the hooked-V4 registry answer (1,000 pools) decoded per pair
// lookup (old) vs remembered while the answer text is the same (new).
import { registryList } from '../core/pairWatcher';
import { registryAnswer } from './fix11Pools';
const answer = registryAnswer(1_000);
const REG = '0x00000000000000000000000000000000000000aa';
process.env.PAIR_REGISTRY_MEMO = '0';
const regOff = timeIt(() => registryList(REG, answer), 3);
delete process.env.PAIR_REGISTRY_MEMO;
registryList(REG, answer);   // first lookup decodes and remembers
const regOn = timeIt(() => registryList(REG, answer), 3);
console.log(`[fix 11, TEST numbers] registry list of 1,000 pools per pair lookup: old ${regOff.toFixed(1)} ms -> memo ${regOn.toFixed(2)} ms`);
assert(regOn * 10 < regOff, 'repeat registry read at least 10x faster with the memo');
