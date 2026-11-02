import { mkdtempSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HeapSampler, heapSamplerSettings, summarizeHeapProfile, recordHeapSample, HeapProfile } from '../core/heapSampler';

// ============================================================================
// HEAP SAMPLER (Nov 2): proves the on-request allocation sampler
//   1. reads its settings (HEAP_SAMPLER=0 turns it off)
//   2. adds up a profile two ways: by place, and by the nearest bot function
//   3. does nothing until the request file appears, then samples once,
//      deletes the file, logs a line and saves the summary
//   4. with the REAL sampler, throwaway memory made by a test function shows
//      up (memory already cleaned up again is counted too)
// Measurement only: nothing here changes a trade.
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const cf = (functionName: string, url = '', lineNumber = 0) => ({ functionName, url, lineNumber, columnNumber: 0 });
// root > onFrame (ours) > Buffer.from (node) 3000 bytes; root > onFrame > decode (ours) 1000 bytes; root > timer (node) 500
const fake: HeapProfile = {
  head: { id: 1, selfSize: 0, callFrame: cf('(root)'), children: [
    { id: 2, selfSize: 0, callFrame: cf('onFrame', 'file:///app/dist/core/feed.js', 9), children: [
      { id: 3, selfSize: 3000, callFrame: cf('from', 'node:buffer', 1), children: [] },
      { id: 4, selfSize: 1000, callFrame: cf('decode', 'file:///app/dist/core/feed.js', 19), children: [] },
    ] },
    { id: 5, selfSize: 500, callFrame: cf('listOnTimeout', 'node:internal/timers', 5), children: [] },
  ] },
};

async function main() {
  // 1. settings
  assert(heapSamplerSettings({}).enabled, 'on by default (idle until asked)');
  assert(!heapSamplerSettings({ HEAP_SAMPLER: '0' }).enabled && !heapSamplerSettings({ HEAP_SAMPLER: 'off' }).enabled, 'HEAP_SAMPLER=0 / off turns it off');
  assert(heapSamplerSettings({ HEAP_SAMPLER_INTERVAL_KB: '99999' }).intervalBytes === 32 * 1024, 'out-of-range setting falls back to the default');

  // 2. summary
  const s = summarizeHeapProfile(fake, 1);
  assert(s.totalBytes === 4500, 'total adds every self size');
  assert(s.where[0].name === 'from (node:buffer:2)' && s.where[0].bytes === 3000, 'by place: Buffer.from is the top place');
  assert(s.bot[0].name === 'onFrame (feed.js:10)' && s.bot[0].bytes === 3000, 'by bot code: Buffer.from is charged to the bot function that called it');
  assert(s.bot.some((r) => r.name === 'decode (feed.js:20)' && r.bytes === 1000), 'a bot function that allocates itself is its own owner');
  assert(s.bot.some((r) => r.name === '(no bot frame)' && r.bytes === 500), 'memory with no bot function above it is listed separately');

  // 3. request file
  const dir = mkdtempSync(join(tmpdir(), 'heapsamp-'));
  const req = join(dir, 'heap-sample.request');
  const lines: string[] = [];
  let calls = 0;
  const hs = new HeapSampler({
    settings: { ...heapSamplerSettings({}), dir, requestFile: req },
    log: (m) => lines.push(m),
    record: async (secs) => { calls++; assert(secs === 15, 'seconds read from the request file'); return fake; },
  });
  assert((await hs.check()) === null && calls === 0, 'no request file: nothing runs');
  writeFileSync(req, '15\n');
  const line = await hs.check();
  assert(calls === 1 && !existsSync(req), 'request file: one sample, file deleted');
  assert(!!line && line.startsWith('[heap-sampled] 15 s:') && line.includes('onFrame (feed.js:10)'), 'one log line with the top bot function');
  assert(readdirSync(dir).some((f) => f.endsWith('.json')) && readdirSync(dir).some((f) => f.endsWith('.heapprofile')), 'summary and full profile saved');
  const off = new HeapSampler({ settings: { ...heapSamplerSettings({ HEAP_SAMPLER: '0' }), dir, requestFile: req } });
  assert(!off.start(), 'switched off: never starts watching');

  // 4. real sampler: a function that only makes throwaway arrays
  let keep = 0;
  function makeGarbage() { for (let i = 0; i < 2_000; i++) { const a = new Array(256).fill(i); keep += a.length; } }
  const t = setInterval(makeGarbage, 5);
  const real = await recordHeapSample(1, 16 * 1024).finally(() => clearInterval(t));
  const rs = summarizeHeapProfile(real, 1);
  const found = rs.where.find((r) => r.name.startsWith('makeGarbage'));
  assert(!!found && found.bytes > 1_000_000, `real sampler sees throwaway memory (makeGarbage ${found ? Math.round(found.bytes / 1e6) : 0} MB, kept ${keep > 0})`);
}

main().catch((e) => { console.error('FAIL:', e); process.exitCode = 1; });
