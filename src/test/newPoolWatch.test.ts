// Tests for the new pool counter (core/newPoolWatch.ts): measurement only.
import { ethers } from 'ethers';
import { unlinkSync } from 'fs';
import { NewPoolWatch, v2Price1Per0, v3Price1Per0, gapPct, summarizeNewPools, NewPoolRec } from '../core/newPoolWatch';
import type { RawLog, ScanFactory } from '../core/universeScan';
import { newPoolsHourlyLine, newPoolsSection, formatRivalDaily } from '../core/telegramFormatter';
import { summarize } from '../core/rivalWatch';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

// Addresses (lowercase, made up).
const V2F = '0x00000000000000000000000000000000000f0002';
const V3F = '0x00000000000000000000000000000000000f0003';
const TSLA = '0x1111111111111111111111111111111111111111';
const USDG = '0x2222222222222222222222222222222222222222';
const JUNK = '0x3333333333333333333333333333333333333333';
const NEWV2 = '0x4444444444444444444444444444444444444444';
const NEWV3 = '0x5555555555555555555555555555555555555555';
const NEWJUNK = '0x6666666666666666666666666666666666666666';
const factories: ScanFactory[] = [{ dex: 'uniswap-v2', kind: 'v2', factory: V2F }, { dex: 'uniswap-v3', kind: 'v3', factory: V3F }];

const topicAddr = (a: string) => '0x' + a.slice(2).padStart(64, '0');
const w = (v: bigint) => v.toString(16).padStart(64, '0');
const q = (n: number) => '0x' + n.toString(16);
const pairCreated = (t0: string, t1: string, pool: string, block: number): RawLog => ({
  address: V2F, topics: [ethers.id('PairCreated(address,address,address,uint256)'), topicAddr(t0), topicAddr(t1)],
  data: '0x' + w(BigInt(pool)) + w(1n), blockNumber: q(block), logIndex: '0x0',
});
const poolCreated = (t0: string, t1: string, pool: string, block: number): RawLog => ({
  address: V3F, topics: [ethers.id('PoolCreated(address,address,uint24,int24,address)'), topicAddr(t0), topicAddr(t1), '0x' + w(3000n)],
  data: '0x' + w(60n) + w(BigInt(pool)), blockNumber: q(block), logIndex: '0x0',
});
const sync = (pool: string, r0: bigint, r1: bigint, block: number, idx = 1): RawLog => ({
  address: pool, topics: [ethers.id('Sync(uint112,uint112)')], data: '0x' + w(r0) + w(r1), blockNumber: q(block), logIndex: q(idx),
});
const init = (pool: string, sqrt: bigint, block: number): RawLog => ({
  address: pool, topics: [ethers.id('Initialize(uint160,int24)')], data: '0x' + w(sqrt) + w(0n), blockNumber: q(block), logIndex: '0x1',
});
const mint = (pool: string, a0: bigint, a1: bigint, block: number): RawLog => ({
  address: pool, topics: [ethers.id('Mint(address,address,int24,int24,uint128,uint256,uint256)'), topicAddr(USDG), '0x' + w(0n), '0x' + w(0n)],
  data: '0x' + w(1n) + w(5n) + w(a0) + w(a1), blockNumber: q(block), logIndex: '0x2',
});

async function main() {
  // --- pure price math -----------------------------------------------------------
  assert(near(v2Price1Per0(10n * 10n ** 18n, 2_000n * 10n ** 6n, 18, 6)!, 200), 'V2: 10 TSLA vs 2,000 USDG = $200');
  assert(v2Price1Per0(0n, 5n, 18, 6) === null, 'V2: empty pool has no price');
  // sqrtPriceX96 for price 200 (token1/token0 in raw units: 200 * 1e6 / 1e18).
  const sqrt200 = BigInt(Math.round(Math.sqrt(200 * 1e6 / 1e18) * 2 ** 96));
  assert(near(v3Price1Per0(sqrt200, 18, 6)!, 200, 1e-9), 'V3: sqrtPriceX96 -> $200');
  assert(near(gapPct(202, 200, 1), 1) && near(gapPct(196, 200, 1), 2), 'gap % both directions');

  // --- the watcher ---------------------------------------------------------------
  let clock = 1_000_000;
  let latest = 100;
  const calls: { addrs: string[]; from: number; to: number }[] = [];
  let chainLogs: RawLog[] = [];
  const logsFor = (addrs: string[], from: number, to: number) => {
    calls.push({ addrs, from, to });
    const set = new Set(addrs.map((a) => a.toLowerCase()));
    return chainLogs.filter((l) => set.has((l.address ?? '').toLowerCase()) && Number(BigInt(l.blockNumber!)) >= from && Number(BigInt(l.blockNumber!)) <= to);
  };
  const deep = new Map([[TSLA, { px: 200, depthUsd: 80_000, pool: '0xdeep' }], [USDG, { px: 1, depthUsd: Infinity, pool: null }],
    [JUNK, { px: 0.01, depthUsd: 900, pool: '0xtiny' }]]);
  const lines: string[] = [];
  const watch = new NewPoolWatch({
    factories, getLogs: async (a, f, t) => logsFor(a, f, t), latestBlock: async () => latest,
    refPrice: (t) => deep.get(t) ?? null, decimals: (t) => (t === USDG ? 6 : 18),
    symbol: (t) => (t === TSLA ? 'TSLA' : t === USDG ? 'USDG' : 'JUNK'), now: () => clock, log: (m) => lines.push(m),
  });

  await watch.poll();
  assert(calls.length === 0, 'first poll only notes the current block (no backfill)');

  // Block 101: a V2 TSLA/USDG pool is created AND funded 1% too cheap
  // ($198) in the same transaction; a bot fixes it in block 102 (ignored:
  // we want the price the creator set). A junk coin pool is also created.
  chainLogs = [
    pairCreated(TSLA, USDG, NEWV2, 101), sync(NEWV2, 10n * 10n ** 18n, 1_980n * 10n ** 6n, 101),
    sync(NEWV2, 99n * 10n ** 17n, 1_990n * 10n ** 6n, 102),
    pairCreated(JUNK, USDG, NEWJUNK, 101), sync(NEWJUNK, 10n ** 24n, 10n ** 6n, 101),
    // A V3 TSLA/USDG pool created empty at a price 4% too high ($208).
    poolCreated(TSLA, USDG, NEWV3, 101), init(NEWV3, BigInt(Math.round(Math.sqrt(208 * 1e6 / 1e18) * 2 ** 96)), 101),
  ];
  latest = 102; clock += 60_000;
  await watch.poll();
  assert(calls.length === 2 && calls[0].addrs.length === 2 && calls[0].from === 101, 'one request for the factories, one for the brand-new pools');
  let s = watch.summary(0);
  assert(s.created === 3 && s.eligible === 2, '3 new pools, 2 for coins that already trade deep (junk ignored)');
  assert(s.measured === 1 && near(s.top[0].gapPct, 1, 1e-6) && near(s.top[0].usd, 3_980, 1e-6), 'V2 pool: started 1% off with ~$3,980 in it (the creator\'s price, not the fixed one)');
  assert(watch.pendingCount() === 1, 'V3 pool waits for its first money');

  // Block 103: first Mint into the V3 pool. One request now (factories + pending pool).
  chainLogs.push(mint(NEWV3, 5n * 10n ** 18n, 500n * 10n ** 6n, 103));
  latest = 103; clock += 60_000;
  calls.length = 0;
  await watch.poll();
  assert(calls.length === 1 && calls[0].addrs.includes(NEWV3) && calls[0].from === 103, 'next round: one request covers factories + pending pool');
  s = watch.summary(0);
  assert(s.measured === 2 && s.off05 === 2 && s.off1 === 2 && s.off3 === 1 && watch.pendingCount() === 0, 'V3 pool measured: 4% off counts in all three buckets');
  assert(near(s.usd, 3_980 + 5 * 200 + 500, 1e-6), 'money in measured pools adds up');
  assert(lines.some((l) => l.includes('first money in TSLA/USDG on uniswap-v3: started 4.00% off')), 'log line for the status page');

  // A new pool whose only deep price is ITSELF is not compared with itself.
  deep.set(TSLA, { px: 200, depthUsd: 80_000, pool: '0x7777777777777777777777777777777777777777' });
  chainLogs.push(pairCreated(TSLA, USDG, '0x7777777777777777777777777777777777777777', 104));
  latest = 104; clock += 60_000;
  await watch.poll();
  assert(watch.summary(0).eligible === 2, 'a pool is never its own reference price');

  // Hourly: takeHour resets the window.
  const h = watch.takeHour();
  assert(h.created === 4 && watch.takeHour().created === 0, 'hourly counts reset after each hour');

  // A failing node: counted, retried next time, block not skipped.
  const bad = new NewPoolWatch({ factories, getLogs: async () => { throw new Error('429 too many'); }, latestBlock: async () => latest,
    refPrice: () => null, decimals: () => 18, symbol: () => 'X', now: () => clock, log: () => {} });
  await bad.poll(); latest = 110; await bad.poll();
  assert(bad.errors === 1, 'a failed poll is counted (and retried next round)');

  // Save / load keeps the day's numbers across a restart.
  const file = `.test-build/newpools-${process.pid}.json`;
  watch.save(file);
  const again = new NewPoolWatch({ factories, getLogs: async () => [], latestBlock: async () => latest, refPrice: () => null, decimals: () => 18, symbol: () => 'X', now: () => clock, log: () => {} });
  again.load(file);
  try { unlinkSync(file); } catch { /* already gone */ }
  assert(again.summary(0).measured === 2 && again.summary(0).created === 4, 'restart keeps measured pools and counts');

  // --- summary + Telegram ----------------------------------------------------------
  const recs: NewPoolRec[] = [
    { t: 10, pair: 'TSLA/USDG', dex: 'uniswap-v3', gapPct: 4, usd: 2_000 },
    { t: 20, pair: 'AAPL/WETH', dex: 'uniswap-v2', gapPct: 0.7, usd: 10_000 },
    { t: 99, pair: 'OLD/USDG', dex: 'uniswap-v2', gapPct: 9, usd: 1 },
  ];
  const sum = summarizeNewPools([5, 10, 20, 30], [10, 20], recs, 0, 50);
  assert(sum.created === 4 && sum.measured === 2 && sum.off05 === 2 && sum.off1 === 1 && sum.off3 === 1 && sum.usdOff1 === 2_000, 'window summary');
  const line = newPoolsHourlyLine(sum);
  assert(line.includes('New pools') && line.includes('2 got money') && line.includes('1 by 3%+') && !line.includes('—'), 'hourly line in plain English');
  const sec = newPoolsSection(sum).join('\n');
  assert(sec.includes('TSLA/USDG on Uniswap V3: started 4.00% off') && sec.includes('more than 1%: 1'), 'daily section lists the biggest gaps');
  const daily = formatRivalDaily({ dateLabel: 'x', hours: 24, summary: summarize([]), botsKnown: 0, newPools: sum });
  assert(daily.includes('No rival trades recorded yet.') && daily.includes('<b>New pools</b>'), 'morning report carries the New pools section');
}
main();
