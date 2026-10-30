// FIRE-FIRST ENTRY: 5-POOL LOOPS (Oct 26, owner: "up to 5 coin loops").
//
// Plain English: builds a small fake pool set with one 5-coin cycle
//   WETH -> PONS -> DJT -> AI -> USDG -> WETH
// and checks:
//   (a) with TRIG_ENTRY_LOOP_POOLS_MAX=4 there are no 5-pool loops;
//   (b) with =5 the cycle is listed under each of its 5 pools, both ways,
//       with the right coins and pool directions;
//   (c) an untested middle coin keeps the loop out;
//   (d) 3- and 4-pool loops come first and are never pushed out (room);
//   (e) the per-pool cap holds;
//   (f) the gas figure for 5 pools is higher than for 4;
// plus a CPU number for a ~1,200-pool set (test machine only): the rebuild
// must keep yielding (never block the bot for long in one bite).
import { buildLoopIndexSteps, LoopRules, LoopBuildOpts, loopIndexSettings, EntryLoop } from '../execution/trigEntryLoops';
import { drainSteps } from '../core/chunked';
import { loopGasUnits } from '../core/loopTrader';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const A = (n: number) => '0x' + n.toString(16).padStart(2, '0').repeat(20);
const USDG = A(1), WETH = A(2), PONS = A(3), DJT = A(4), AI = A(5), TAXY = A(6);

type P = { k: string; a: string; b: string; dex: string; depth: number };
// The 5-coin cycle (no shorter loop exists among these pools).
const p1: P = { k: A(0x31), a: WETH, b: PONS, dex: 'uni', depth: 50_000 };
const p2: P = { k: A(0x32), a: PONS, b: DJT, dex: 'uni', depth: 40_000 };
const p3: P = { k: A(0x33), a: DJT, b: AI, dex: 'uni', depth: 35_000 };
const p4: P = { k: A(0x34), a: AI, b: USDG, dex: 'uni', depth: 30_000 };
const p5: P = { k: A(0x35), a: USDG, b: WETH, dex: 'uni', depth: 100_000 };
const CYCLE = [p1, p2, p3, p4, p5];
// A second 5-coin cycle through an untested coin (TAXY instead of AI).
const pT1: P = { k: A(0x36), a: DJT, b: TAXY, dex: 'uni', depth: 90_000 };
const pT2: P = { k: A(0x37), a: TAXY, b: USDG, dex: 'uni', depth: 90_000 };

const rules = (taxOk = new Set<string>()): LoopRules<P> => ({
  key: (p) => p.k, tokens: (p) => [p.a, p.b],
  poolOk: (p) => p.dex !== 'blocked-dex',
  coinOk: (t, isStart) => isStart || t !== TAXY || taxOk.has(t),
  depth: (p) => p.depth,
});
const set = (max: string, o: Partial<LoopBuildOpts> = {}) => ({ ...loopIndexSettings({ TRIG_ENTRY_LOOP_POOLS_MAX: max }), ...o });
const build = (pools: P[], r: LoopRules<P>, o: LoopBuildOpts) => drainSteps(buildLoopIndexSteps(pools, [USDG, WETH], r, o));
const five = (l: EntryLoop) => l.keys.length === 5;

// (a) off at 4
{
  const d = build(CYCLE, rules(), set('4'));
  assert((d.loops5 ?? 0) === 0 && d.loops === 0, 'TRIG_ENTRY_LOOP_POOLS_MAX=4: no 5-pool loops (and no shorter loop exists here)');
}

// (b) on at 5: listed under all 5 pools, both directions, from both coins we hold
{
  const d = build(CYCLE, rules(), set('5'));
  assert((d.loops5 ?? 0) === d.loops && d.loops === 4, `=5: 4 loops (2 directions x 2 start coins), got ${d.loops}`);
  for (const p of CYCLE) assert((d.byPool.get(p.k) ?? []).filter(five).length === 4, `pool ${p.k.slice(0, 6)} lists all 4 five-pool loops`);
  const fwd = (d.byPool.get(p1.k) ?? []).find((l) => l.start === WETH && l.keys[0] === p1.k)!;
  assert(!!fwd && fwd.tokens.join() === [WETH, PONS, DJT, AI, USDG].join(), 'WETH loop coins in order: WETH, PONS, DJT, AI, USDG');
  assert(fwd.inIsA.join() === [true, true, true, true, true].join(), 'pool directions: each coin goes in as tokenA here');
  const rev = (d.byPool.get(p1.k) ?? []).find((l) => l.start === WETH && l.keys[0] === p5.k)!;
  assert(!!rev && rev.tokens.join() === [WETH, USDG, AI, DJT, PONS].join() && rev.inIsA.join() === [false, false, false, false, false].join(), 'reverse direction: coins and directions flipped');
  assert(fwd.prio === 30_000, 'loop depth = its shallowest pool');
}

// (c) untested middle coin keeps its loop out; passing the test lets it in
{
  const pools = [...CYCLE, pT1, pT2];
  const off = build(pools, rules(), set('5'));
  assert(![...off.byPool.values()].flat().some((l) => l.tokens.includes(TAXY)), 'untested coin: no loop through it');
  const on = build(pools, rules(new Set([TAXY])), set('5'));
  assert([...on.byPool.values()].flat().some((l) => l.tokens.includes(TAXY) && five(l)), 'after passing the tax test: the TAXY 5-pool loop is listed');
}

// (d) 3- and 4-pool loops first: with the index cap equal to the shorter loops, 5-pool get no room
{
  // Add a 3-pool loop: WETH-PONS (p1), PONS-USDG, USDG-WETH (p5).
  const p3a: P = { k: A(0x38), a: PONS, b: USDG, dex: 'uni', depth: 20_000 };
  const pools = [...CYCLE, p3a];
  const full = build(pools, rules(), set('5'));
  const short = full.loops - (full.loops4 ?? 0) - (full.loops5 ?? 0);
  assert(short > 0 && (full.loops5 ?? 0) > 0, `both kinds exist when there is room (3-pool ${short}, 5-pool ${full.loops5})`);
  const tight = build(pools, rules(), set('5', { maxLoops: short + (full.loops4 ?? 0) }));
  assert((tight.loops5 ?? 0) === 0 && tight.loops === short + (tight.loops4 ?? 0) && tight.capped, 'no room left: 5-pool loops left out, shorter loops kept, "capped" reported');
}

// (e) per-pool cap
{
  const d = build(CYCLE, rules(), set('5', { perPool5: 2 }));
  for (const p of CYCLE) assert((d.byPool.get(p.k) ?? []).filter(five).length <= 2, `perPool5=2 holds on pool ${p.k.slice(0, 6)}`);
}

// (f) gas
assert(loopGasUnits(5) > loopGasUnits(4) && loopGasUnits(4) > loopGasUnits(3), `gas grows with pools: 3=${loopGasUnits(3)} 4=${loopGasUnits(4)} 5=${loopGasUnits(5)}`);

// ---- CPU (TEST NUMBERS ONLY): ~1,200 pools, 3+4+5-pool loops ----------------------------
{
  let kk = 0x1000;
  const key = () => '0x' + (kk++).toString(16).padStart(40, '0');
  const coins = Array.from({ length: 400 }, (_, i) => '0x' + (0x5000 + i).toString(16).padStart(40, '0'));
  const big: P[] = [p5];
  for (let i = 0; i < 400; i++) {
    const c = coins[i];
    if (i % 10 < 7) big.push({ k: key(), a: WETH, b: c, dex: 'uni', depth: 1e4 + (i * 37) % 9e4 });
    if (i % 2 === 0) big.push({ k: key(), a: c, b: USDG, dex: 'uni', depth: 1e4 + (i * 53) % 9e4 });
  }
  for (let i = 0; i < 720; i++) big.push({ k: key(), a: coins[i % 400], b: coins[(i * 7 + 13) % 400], dex: 'uni', depth: 5e3 + (i * 29) % 5e4 });
  const r: LoopRules<P> = { key: (p) => p.k, tokens: (p) => [p.a, p.b], poolOk: () => true, coinOk: () => true, depth: (p) => p.depth };
  const run = (max: string) => {
    const job = buildLoopIndexSteps(big, [USDG, WETH], r, set(max));
    let worst = 0; const t0 = performance.now(); let t = t0;
    for (;;) { const s = job.next(); const now = performance.now(); worst = Math.max(worst, now - t); t = now; if (s.done) return { ms: now - t0, worst, d: s.value }; }
  };
  const a = run('4'), b = run('5');
  console.log(`[bench, test numbers only] ${big.length} pools: up to 4-pool ${a.d.loops} loops in ${a.ms.toFixed(1)} ms; up to 5-pool ${b.d.loops} loops (${b.d.loops4} 4-pool, ${b.d.loops5} 5-pool${b.d.capped ? ', capped' : ''}) in ${b.ms.toFixed(1)} ms; longest stretch between breaks ${b.worst.toFixed(2)} ms`);
  assert((b.d.loops5 ?? 0) > 0, 'big set: 5-pool loops found');
  assert(b.worst < 50, `rebuild keeps yielding: longest stretch ${b.worst.toFixed(2)} ms (generous test-machine bound)`);
  assert(b.d.loops <= loopIndexSettings({}).maxLoops, 'whole-index cap holds');
}
