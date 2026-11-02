import { mkdtempSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FreezeNamer, freezeNamerSettings, NamerProfile, formatNamedLine } from '../core/freezeNamer';
import { StallFinder } from '../core/stallFinder';

// ============================================================================
// FREEZE NAMER (Nov 2): proves the namer
//   1. reads its settings (and FREEZE_NAMER=0 turns it off)
//   2. keeps ONLY profile samples inside a freeze, and names them by step and
//      function; time with no sample is "not running", idle is "idle"
//   3. a freeze that crosses two profile pieces is added up once
//   4. with the REAL profiler and the REAL stall finder, a 150 ms busy job
//      is named, and the profiler's clock lines up with the stall finder's
//   5. the stall finder still tells its old listeners the same thing
// Measurement only: nothing here changes a trade.
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A small fake profile: root > onMessage (ours) > JSON.parse (built-in), plus idle.
// Samples every 1 ms from t0.
function fakeProfile(t0: number, ids: number[]): NamerProfile {
  return {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2, 5, 6] },
      { id: 2, callFrame: { functionName: 'emit', url: 'node:events', lineNumber: 10 }, children: [3] },
      { id: 3, callFrame: { functionName: 'onMessage', url: 'file:///app/dist/shadowMain.js', lineNumber: 99 }, children: [4] },
      { id: 4, callFrame: { functionName: 'parse', url: '', lineNumber: -1 }, children: [] },
      { id: 5, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 }, children: [] },
      { id: 6, callFrame: { functionName: '(garbage collector)', url: '', lineNumber: -1 }, children: [] },
    ],
    startTime: t0, endTime: t0 + ids.length * 1_000,
    samples: ids, timeDeltas: ids.map((_, i) => (i === 0 ? 0 : 1_000)),
  };
}

function settingsTests() {
  const d = freezeNamerSettings({});
  assert(d.enabled && d.chunkMs === 10_000 && d.intervalUs === 1_000 && d.minutes === 120 && d.minFreezeMs === 50, 'defaults: on, 10 s pieces, 1 ms sampling, 120 min, freezes over 50 ms');
  assert(!freezeNamerSettings({ FREEZE_NAMER: '0' }).enabled && !freezeNamerSettings({ FREEZE_NAMER: 'off' }).enabled, 'FREEZE_NAMER=0 / off turns it off');
  assert(freezeNamerSettings({ FREEZE_NAMER_CHUNK_S: '9999' }).chunkMs === 10_000, 'out-of-range setting falls back to the default');
}

function fakeTests() {
  const logs: string[] = [];
  const s = { ...freezeNamerSettings({}), minFreezeMs: 50 };
  const n = new FreezeNamer({ settings: s, log: (m) => logs.push(m) });
  // Pretend the profiler is running (no real session), clock offset 0.
  (n as any).running = true;
  // Profile piece A: 0..200 ms. 0-49 idle, 50-149 onMessage>JSON.parse, 150-169 GC, 170-199 idle.
  const ids = [...Array(50).fill(5), ...Array(100).fill(4), ...Array(20).fill(6), ...Array(30).fill(5)];
  const A = fakeProfile(0, ids);
  // Freeze 1: 40..180 ms (140 ms). Freeze 2 (before the profile) is ignored for samples.
  n.noteFreeze(40, 180, 140, null);
  n.noteFreeze(0, 30, 30, null);   // under 50 ms: ignored
  n.readPiece(A);
  const sum = n.take();
  const step = sum.steps.find((r) => r.name === 'onMessage (shadowMain.js:100)');
  assert(sum.freezes === 1 && Math.round(sum.frozenMs) === 140, 'one freeze over 50 ms counted (the 30 ms one ignored)');
  assert(!!step && Math.round(step.totalMs) === 100, `our code named as the step: onMessage 100 ms (got ${step?.totalMs})`);
  assert(sum.fns.some((r) => r.name === 'parse' && Math.round(r.totalMs) === 100), 'running function named: JSON.parse 100 ms');
  assert(sum.fns.some((r) => r.name === '(garbage collector)' && Math.round(r.totalMs) === 20), 'memory clean-up inside the freeze: 20 ms');
  assert(Math.round(sum.idleMs) === 20, `idle inside the freeze counted apart: 10 ms before + 10 ms after = 20 ms (got ${sum.idleMs})`);
  assert(Math.round(sum.sampledMs) === 140 && Math.round(sum.notRunningMs) === 0, 'whole freeze sampled, nothing "not running"');
  assert(sum.byCause[0].cause === 'other' && sum.byCause[0].n === 1, 'a freeze with no named job is grouped under "other"');
  assert(sum.worst.length === 1 && sum.worst[0].ms === 140, 'worst freezes listed');

  // A freeze across two pieces, with a hole between them (process not running).
  const B = fakeProfile(1_000_000, Array(100).fill(4));     // 1000..1100 ms
  const C = fakeProfile(1_150_000, Array(100).fill(4));     // 1150..1250 ms
  n.noteFreeze(1_050, 1_200, 150, 'table rebuild');
  n.readPiece(B);
  assert(n.take().freezes === 0, 'freeze not finished in the first piece: waits for the next one');
  n.readPiece(C);
  const two = n.take();
  assert(two.freezes === 1 && Math.round(two.sampledMs) === 100 && Math.round(two.notRunningMs) === 50, `crossing two pieces: 50 + 50 ms sampled once, 50 ms gap = not running (got ${two.sampledMs}/${two.notRunningMs})`);
  assert(two.byCause[0].cause === 'table rebuild', 'cause from the stall finder kept');
  const line = formatNamedLine(two);
  assert(line.startsWith('[freeze-named] 5 min: 1 freezes') && line.includes('not running 50 ms') && line.includes('onMessage'), 'log line: ' + line.slice(0, 160));
}

// A busy job with a clear name (shows up in the real profile).
function slowJobForNamerTest(ms: number) { const end = performance.now() + ms; let x = 0; while (performance.now() < end) x += Math.sqrt(x + 1); return x; }

async function realTests() {
  const dir = mkdtempSync(join(tmpdir(), 'namer-'));
  const logs: string[] = [];
  const sf = new StallFinder({ enabled: true });
  const n = new FreezeNamer({ settings: { ...freezeNamerSettings({}), dir, chunkMs: 60_000 }, log: (m) => logs.push(m), time: (name) => sf.begin(name) });
  const old: Array<[number, string | null]> = [];
  sf.onStall((ms, job) => old.push([ms, job]));
  sf.onStallWindow((s, e, ms, job) => n.noteFreeze(s, e, ms, job));
  sf.start();
  assert(n.start(), 'real profiler starts');
  await sleep(120);
  slowJobForNamerTest(150);
  await sleep(120);
  const c0 = performance.now();
  n.cut();                    // piece 1 is held
  const cutMs = performance.now() - c0;
  await sleep(60);
  n.cut();                    // piece 1 is read now
  const sum = n.take();
  const hit = sum.steps.find((r) => r.name.includes('slowJobForNamerTest'));
  console.log(`[freeze namer, TEST] freezes ${sum.freezes}, ${Math.round(sum.frozenMs)} ms frozen, ${Math.round(sum.sampledMs)} ms sampled; top step ${sum.steps[0]?.name} ${Math.round(sum.steps[0]?.totalMs ?? 0)} ms; cut ${cutMs.toFixed(1)} ms`);
  assert(sum.freezes >= 1, 'the real stall finder saw the 150 ms freeze and the namer read it');
  assert(!!hit && hit.totalMs >= 100, `the busy job is named with >= 100 ms (got ${hit?.totalMs})`);
  assert(sum.sampledMs >= 0.8 * sum.frozenMs, 'profiler clock lines up with the stall finder clock (>= 80% of the freeze sampled)');
  // Speed check (skipped on the live server like the other timing tests):
  // a cut must be cheap, or the namer would cause the freezes it measures.
  if (process.env.SKIP_TIMING_TESTS === '1') console.log(`SKIP (speed check, SKIP_TIMING_TESTS=1): cut ${cutMs.toFixed(1)} ms`);
  else assert(cutMs < 15, `a cut is cheap: ${cutMs.toFixed(1)} ms (under 15 ms; a full profiler restart was 30+ ms)`);
  assert(old.length >= 1 && typeof old[0][0] === 'number', 'old stall listeners still told (ms, job)');
  n.noteFreeze(0, 1, 100, null);
  await n.report('test');
  assert(readdirSync(dir).some((f) => f.startsWith('freeze-named-') && f.endsWith('.json')), 'JSON summary saved');
  const saved = JSON.parse(readFileSync(join(dir, readdirSync(dir).filter((f) => f.startsWith('freeze-named-'))[0]), 'utf8'));
  assert(Array.isArray(saved.steps) && Array.isArray(saved.worst), 'JSON summary has steps and worst freezes');
  n.stop('test done');
  sf.stop();
  assert(!n.running && logs.some((l) => l.includes('profiler off')), 'stops cleanly and says so');
  const off = new FreezeNamer({ settings: { ...freezeNamerSettings({ FREEZE_NAMER: '0' }) } });
  assert(!off.start() && !off.running, 'switched off: never starts the profiler');
  // Self stop after FREEZE_NAMER_MINUTES.
  let clock = 0;
  const short = new FreezeNamer({ settings: { ...freezeNamerSettings({}), minutes: 1, chunkMs: 60_000 }, now: () => clock, log: () => undefined });
  short.start();
  clock = 61_000;
  short.cut();
  assert(!short.running, 'turns itself off after FREEZE_NAMER_MINUTES');
}

async function main() {
  settingsTests();
  fakeTests();
  await realTests();
}
main().catch((e) => { console.error('FAIL: crashed', e); process.exitCode = 1; });
