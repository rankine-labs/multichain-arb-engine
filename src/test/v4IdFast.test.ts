// Freeze fix (Oct 20): the fast, remembered V4 pool id must equal the old
// ABI-coder one for every input, and the paced ask list must equal the old one.
import { v4Id, v4IdSlow, v4Asks, v4AsksPaced, V4_TIERS, v4IdCacheSize } from '../core/v4Lookup';
import { STANDARD_V4_TIERS } from '../config/v4Tiers';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const ZERO = '0x0000000000000000000000000000000000000000';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const addr = () => '0x' + Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');

(async () => {
  // 1) Same id as the old way: random coins, every tier, negative spacing, native ETH, mixed case.
  let same = 0, n = 0;
  for (let i = 0; i < 300; i++) {
    const a = i % 7 === 0 ? ZERO : addr(), b = i % 5 === 0 ? addr().toUpperCase().replace('0X', '0x') : addr();
    const [fee, ts] = i % 11 === 0 ? [3000, -60] : V4_TIERS[i % V4_TIERS.length];
    n++; if (v4Id(a, b, fee, ts) === v4IdSlow(a, b, fee, ts)) same++;
  }
  assert(same === n, `fast id equals the old ABI-coder id (${same}/${n}, incl. native ETH, negative spacing, mixed case)`);
  assert(v4Id(ZERO, USDG, 500, 10) === v4IdSlow(ZERO, USDG, 500, 10), 'native ETH / USDG 0.05% pool id matches');

  // 2) Remembered: the same ask list again is free, and identical.
  const pairs = Array.from({ length: 200 }, () => ({ quote: rnd() < 0.5 ? USDG : WETH, other: addr() }));
  const tiersFor = (i: number) => (i < 100 ? V4_TIERS : STANDARD_V4_TIERS);
  const t0 = performance.now();
  const first = pairs.flatMap((p, i) => v4Asks([p], WETH, tiersFor(i)));
  const t1 = performance.now();
  const again = pairs.flatMap((p, i) => v4Asks([p], WETH, tiersFor(i)));
  const t2 = performance.now();
  const slowT0 = performance.now();
  for (const a of first) v4IdSlow(a.c0, a.c1, a.fee, a.tickSpacing);
  const slowT1 = performance.now();
  console.log(`  ${first.length} ids: old way ${(slowT1 - slowT0).toFixed(0)} ms · new first time ${(t1 - t0).toFixed(0)} ms · new again ${(t2 - t1).toFixed(1)} ms · remembered ${v4IdCacheSize()}`);
  assert(JSON.stringify(first) === JSON.stringify(again), 'second scan gives the same ask list');
  assert((t2 - t1) < (slowT1 - slowT0) / 5, 'second scan is at least 5x faster than the old way (ids remembered)');

  // 3) Paced version: same list, and it takes breaks (no single long block).
  let longest = 0, last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 1);
  const fresh = Array.from({ length: 300 }, () => ({ quote: USDG, other: addr() }));
  const paced = await v4AsksPaced(fresh, WETH, () => V4_TIERS, 4);
  clearInterval(timer);
  const plain = fresh.flatMap((p) => v4Asks([p], WETH, V4_TIERS));
  assert(JSON.stringify(paced) === JSON.stringify(plain), `paced ask list equals the plain one (${paced.length} asks)`);
  console.log(`  longest gap between timer ticks while pacing: ${longest.toFixed(1)} ms`);
  assert(longest < 60, 'pacing keeps every block short (under 60 ms; was ~1 s per batch)');
})();
