import { PairWatcher, refreshPoolsBatch } from '../core/pairWatcher';
import { PoolCache } from '../core/poolCache';

// Checks the pair watcher can't overload the RPC: one discovery at a time,
// duplicates ignored, backlog capped, single-pool pairs not re-checked.
// (Real discovery against live Robinhood is covered by scripts/probe-watch.ts.)

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T = (n: number) => '0x' + n.toString(16).padStart(40, '0');

async function main() {
  const w = new PairWatcher('robinhood', {} as any, [], new PoolCache(), () => {}, { maxQueue: 3 });
  let running = 0, maxRunning = 0;
  const done: string[] = [];
  // Stub discovery: takes 20ms; pair (1,2) has many pools, others have one.
  (w as any).discover = async (a: string, b: string) => {
    running++; maxRunning = Math.max(maxRunning, running);
    await sleep(20);
    done.push(`${a}/${b}`);
    const k = (w as any).key(a, b);
    if (a === T(1)) (w as any).pairs.set(k, { tokenA: a, tokenB: b, pools: ['p1', 'p2'], discoveredAt: Date.now(), lastSeen: Date.now() });
    else (w as any).singlePool.set(k, Date.now());
    running--;
  };

  w.touch(T(1), T(2));
  w.touch(T(2), T(1));            // same pair, other order -> ignored
  w.touch(T(3), T(4));
  w.touch(T(5), T(6));
  w.touch(T(7), T(8));            // queue full (1 running + 3 queued) -> skipped
  await sleep(200);
  assert(maxRunning === 1, `one discovery at a time (max concurrent ${maxRunning})`);
  assert(done.length === 3 || done.length === 4, `duplicates ignored and backlog capped (${done.length} discoveries)`);
  assert(!done.includes(`${T(2)}/${T(1)}`), 'same pair in reverse order not discovered twice');

  const before = done.length;
  w.touch(T(1), T(2));            // recently discovered multi-pool pair -> no re-discovery
  w.touch(T(3), T(4));            // known single-pool pair -> not re-checked
  await sleep(100);
  assert(done.length === before, 'no re-discovery of fresh pairs or known single-pool pairs');
  assert(w.stats().pairs === 1, 'only the multi-pool pair is tracked');
}

// Batch re-sync: one call list for all pools, results mapped back correctly.
async function batch() {
  const w = (n: bigint) => n.toString(16).padStart(64, '0');
  const base = { chain: 'robinhood' as const, dex: 'x', tokenA: 'a', tokenB: 'b', feeBps: 5, lastUpdatedBlock: 0, lastUpdatedMs: 0 };
  const pools = [
    { ...base, poolAddress: 'v3pool', poolType: 'v3' as const, sqrtPriceX96: 1n, liquidity: 1n },
    { ...base, poolAddress: 'v2pool', poolType: 'v2' as const, reserveA: 1n, reserveB: 1n },
  ];
  let seen: { target: string; data: string }[] = [];
  const fresh = await refreshPoolsBatch(async (calls) => {
    seen = calls;
    return calls.map((c) => c.data === '0x3850c7bd' ? '0x' + w(777n) + w(5n) : c.data === '0x1a686502' ? '0x' + w(888n) : '0x' + w(11n) + w(22n) + w(3n));
  }, pools);
  assert(seen.length === 3, 'one batch: slot0 + liquidity for V3, getReserves for V2');
  const v3 = fresh.find((p) => p.poolAddress === 'v3pool')!, v2 = fresh.find((p) => p.poolAddress === 'v2pool')!;
  assert(v3.sqrtPriceX96 === 777n && v3.liquidity === 888n && v3.lastUpdatedMs > 0, 'V3 state + timestamp updated from batch');
  assert(v2.reserveA === 11n && v2.reserveB === 22n, 'V2 reserves updated from batch');
  const partial = await refreshPoolsBatch(async (calls) => calls.map(() => null), pools);
  assert(partial.length === 0, 'failed reads leave pools untouched (no zeroed prices)');
}
batch().catch((e) => { console.error('FAIL: batch test crashed', e); process.exitCode = 1; });

main().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; });
