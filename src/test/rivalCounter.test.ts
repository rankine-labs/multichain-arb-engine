import { CompetitorTracker, MAX_RESULTS } from '../core/competitorTracker';

// "New rival bots" reader (shadowMain): it reads the competitor tracker's
// results with resultsSince() and remembers where it got to. Checks that
// results added after the hourly reset() are still handed over (before
// Oct 13 they were skipped), and that the 2,000 cap's trimming never makes
// the reader skip a kept result or get the same one twice.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// Keep the tracker's own "[rival] ..." lines out of the test output.
const realLog = console.log;
console.log = (m?: unknown) => { if (typeof m === 'string' && (m.startsWith('PASS') || m.startsWith('FAIL'))) realLog(m); };

async function main() {
  // Fake node: every trigger landed, no rival found. Each result carries
  // its own number in profitUsd so we can tell exactly which ones we got.
  let t = 0;
  const provider = {
    getTransactionReceipt: async () => ({ blockNumber: 100, index: 1 }),
    send: async () => [],
  } as any;
  const ct = new CompetitorTracker(provider, () => (t += 10_000));
  let n = 0;
  const add = async (count: number) => {
    for (let i = 0; i < count; i++) {
      ct.watch({ triggerHash: '0x' + (++n).toString(16), triggerSeenMs: 0, pools: ['0xp1', '0xp2'], profitUsd: n });
      for (let k = 0; k < 6; k++) await new Promise((r) => setImmediate(r));
    }
  };

  // The reader, exactly as shadowMain does it.
  let seen = 0;
  const got: number[] = [];
  const read = () => { const { items, next } = ct.resultsSince(seen); seen = next; for (const r of items) got.push(r.profitUsd); };

  // Hour 1: 30 results, read them all.
  await add(30);
  read();
  assert(got.length === 30 && got[0] === 1 && got[29] === 30, `hour 1: all 30 results read (got ${got.length})`);
  read();
  assert(got.length === 30, 'reading again with nothing new gets nothing');

  // Hourly reset, then hour 2 finds only 5. The old position counter sat at
  // 30 and would skip these 5 until 31+ results came in.
  ct.reset();
  await add(5);
  read();
  assert(got.length === 35 && got.slice(30).join(',') === '31,32,33,34,35', `after reset: the 5 new results are read (got ${got.slice(30).join(',')})`);

  // Reset with nothing read in between still works (nothing new, nothing lost).
  ct.reset();
  read();
  assert(got.length === 35, 'reset with no new results: nothing handed out');

  // Trimming: add more than the cap between two reads. Only the newest
  // MAX_RESULTS are still kept; the reader gets exactly those, once each.
  ct.reset();
  got.length = 0;
  await add(MAX_RESULTS + 50);
  read();
  assert(got.length === MAX_RESULTS && got[0] === 36 + 50 && got[got.length - 1] === n,
    `over the cap: reads the ${MAX_RESULTS} kept results (got ${got.length}, ${got[0]}..${got[got.length - 1]})`);

  // Trimming after a read: 10 more push the oldest kept ones out. Reader
  // gets just the 10 new ones, no repeats, no gaps.
  got.length = 0;
  await add(10);
  read();
  assert(got.length === 10 && got[0] === n - 9 && got[9] === n, `trim after read: exactly the 10 new results (got ${got.length})`);
  const all = new Set<number>();
  let dup = false;
  // Mixed run: reads between small batches while the cap keeps trimming.
  got.length = 0;
  const startN = n;
  for (let b = 0; b < 5; b++) { await add(7); read(); }
  for (const x of got) { if (all.has(x)) dup = true; all.add(x); }
  assert(!dup && got.length === 35 && got[0] === startN + 1 && got[34] === n, 'reads between batches while trimming: no skips, no double counts');
}

main().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; }).finally(() => { console.log = realLog; });
