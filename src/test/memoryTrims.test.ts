import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ShadowLogger } from '../core/shadowLogger';
import { RivalWatch, RivalRec, RIVAL_KEEP_MS, summarize } from '../core/rivalWatch';
import { PoolCache } from '../core/poolCache';
import { CompetitorTracker, MAX_RESULTS } from '../core/competitorTracker';
import { emptyScanState, addPoolsToState, stateToPools, scanPoolRefs, ScannedPool } from '../core/universeScan';
import { pickScanCandidates } from '../core/loopExtraPools';
import { PoolState } from '../core/types';

// ============================================================================
// Memory trims (Oct 13): the same answers from less memory.
//   - opportunity log keeps only the fields the reports read, finds by id
//   - rival trades: 24 h, shared address text, no per-coin amounts, chunked save
//   - Kuru SDK / ethers v5 not loaded unless Monad is on
//   - chain-wide scan pools handed out one at a time (no second copy)
//   - pool cache prune also forgets "block reader wrote here" notes
//   - competitor results capped at 2,000
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// Each saved rival trade and competitor check prints a line; keep the test output readable.
const realLog = console.log;
const quiet = (m?: unknown) => { if (typeof m === 'string' && (m.startsWith('PASS') || m.startsWith('FAIL'))) realLog(m); };

async function main() {
  console.log = quiet;
  const now = 10 * 24 * 3600_000;
  // ---- 1) Opportunity log ---------------------------------------------------
  const opp = (t: number, id: string, net = 1) => ({
    id, chain: 'robinhood', tokenPair: ['0xa', '0xb'], buyDex: 'x', buyPool: '0x1', sellDex: 'y', sellPool: '0x2',
    optimalTradeSizeUsd: 1, grossProfitUsd: 1, costsUsd: {}, conservativeNetProfitUsd: net, scoredAtMs: t, score: 1,
    triggeringEvent: { chain: 'robinhood', stateType: 'SEQUENCED', blockOrSeq: 1, receivedAtMs: t, raw: { data: '0xff' } },
  }) as any;

  // Resolve by id (index), first record with an id wins (same as the old search).
  const log = new ShadowLogger();
  log.record({ opportunity: opp(now, 'a', 5), outcome: 'UNRESOLVED', ourHypotheticalReactionMs: 10 }, now);
  log.record({ opportunity: opp(now, 'b', 7), outcome: 'UNRESOLVED', ourHypotheticalReactionMs: 30 }, now);
  log.record({ opportunity: opp(now, 'a', 99), outcome: 'SKIPPED_LOW_SCORE' }, now); // duplicate id
  log.resolve('a', 'WOULD_HAVE_WON');
  log.resolve('b', 'WOULD_HAVE_LOST', 12, '0xhash');
  log.resolve('nope', 'WOULD_HAVE_WON'); // unknown id: ignored
  const w = log.windowStats(now - 1, now + 1);
  assert(w.seen === 3 && w.won === 1 && w.lost === 1 && w.netUsd === 5, `resolve by id updates the first matching record (seen ${w.seen}, won ${w.won}, net ${w.netUsd})`);
  assert(w.bestWonUsd === 5 && w.largestLostUsd === 7 && w.avgReactionMs === 20 && w.medianReactionMs === 30, 'window stats numbers unchanged (best won, largest lost, reaction times)');
  const sm = log.summary('robinhood');
  assert(sm.opportunitiesSeen === 3 && sm.wouldHaveWon === 1 && sm.skippedLowScore === 1 && sm.hypotheticalNetProfitUsd === '5.00', 'summary() still adds up');
  const dl = log.diagnoseLosses();
  assert(dl.length === 1 && dl[0].id === 'b' && dl[0].competitorReactionMs === 12, 'diagnoseLosses() still finds the loss');

  // TTL: 499 old records + 1 new -> prune at 500 drops the old ones AND their ids.
  const ttl = new ShadowLogger();
  for (let i = 0; i < 499; i++) ttl.record({ opportunity: opp(now - 27 * 3600_000, `old${i}`), outcome: 'UNRESOLVED' }, now);
  ttl.record({ opportunity: opp(now - 25 * 3600_000, 'keep'), outcome: 'UNRESOLVED' }, now);
  assert(ttl.size === 1 && (ttl as any).byId.size === 1, `records older than 26 h dropped, and forgotten by id too (left ${ttl.size}, index ${(ttl as any).byId.size})`);
  ttl.resolve('old3', 'WOULD_HAVE_WON');
  assert(ttl.windowStats(0, now + 1).won === 0, 'resolving a dropped id does nothing');

  // Cap: never more than MAX_RECORDS kept, newest win.
  const capWas = ShadowLogger.MAX_RECORDS;
  ShadowLogger.MAX_RECORDS = 1_000;
  const cap = new ShadowLogger();
  for (let i = 0; i < 2_600; i++) cap.record({ opportunity: opp(now, `c${i}`), outcome: 'UNRESOLVED' }, now);
  assert(cap.size <= 1_000 && (cap as any).byId.size === cap.size, `count cap holds (${cap.size} kept, index ${(cap as any).byId.size})`);
  cap.resolve('c2599', 'WOULD_HAVE_WON'); cap.resolve('c0', 'WOULD_HAVE_WON');
  assert(cap.windowStats(0, now + 1).won === 1, 'newest record still resolvable, oldest gone');
  ShadowLogger.MAX_RECORDS = capWas;

  // ---- 2) Rival trades -------------------------------------------------------
  let clock = now;
  const mk = () => new RivalWatch(async () => ({}), () => null, (x) => x, () => false, '0xweth', () => clock, 0);
  const BOT = '0x' + 'b0'.repeat(20), FROM = '0x' + 'e0'.repeat(20), P1 = '0x' + 'a1'.repeat(20), P2 = '0x' + 'a2'.repeat(20), P3 = '0x' + 'a3'.repeat(20);
  // Fresh copies of the same text each time, like reading receipts does.
  const fresh = (s: string) => (' ' + s).slice(1);
  const rec = (t: number, i: number): RivalRec => ({
    t, bot: fresh(BOT), pair: fresh('USDG/WETH'), pools: 3, sizeUsd: 100 + i, grossUsd: 0.5, gasUsd: 0.01, failed: false, flash: false, ours: i % 2 === 0,
    hash: '0x' + i.toString(16).padStart(64, '0'), block: 1000 + i, from: fresh(FROM), route: [fresh(P1), fresh(P2), fresh(P3)],
    deltas: [[P1, '123']], conf: 'confirmed', closedLoop: true,
  });
  const rw = mk();
  let heard: RivalRec | null = null;
  rw.onRecord = (r) => { heard = r; };
  for (let i = 0; i < 1_200; i++) rw.add(rec(clock - 2000 + i, i));
  const kept = (rw as any).recs as RivalRec[];
  assert(kept.length === 1_200 && kept.every((r) => r.deltas === undefined), 'per-coin amounts (deltas) not kept in memory');
  assert(heard !== null && (heard as RivalRec).deltas !== undefined, 'the loop trader listener still gets the full record');
  assert(kept[0].route === kept[1199].route && rw.sharedCount() <= 6, `repeated addresses and routes share one copy (${rw.sharedCount()} shared texts)`);
  assert(rw.loopRoutePools(0).size === 3 && rw.loopRoutePools(0).has(P2), 'loop route pools still readable');

  // Same report numbers from compact records as from the originals.
  const originals = Array.from({ length: 1_200 }, (_, i) => rec(clock - 2000 + i, i));
  const a = JSON.stringify(summarize(originals, rw.verifiedBots())), b = JSON.stringify(rw.summary(0, clock + 1));
  assert(a === b, 'summary numbers identical to the uncompacted records');

  // Save (chunked, > 2 chunks) and load back.
  const dir = mkdtempSync(join(tmpdir(), 'memtrim-'));
  rw.save(join(dir, 'b.json'), join(dir, 'r.json'));
  const onDisk = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8'));
  assert(Array.isArray(onDisk) && onDisk.length === 1_200 && onDisk[5].hash === kept[5].hash && onDisk[5].deltas === undefined, 'saved file is one plain JSON list (old loaders can read it)');
  const rw2 = mk(); const n2 = rw2.load(join(dir, 'b.json'), join(dir, 'r.json'));
  assert(n2.recs === 1_200 && JSON.stringify(rw2.summary(0, clock + 1)) === b, 'save -> load round trip gives the same report');
  // Empty list saves as valid JSON too.
  const empty = mk(); empty.save(join(dir, 'b0.json'), join(dir, 'r0.json'));
  assert(readFileSync(join(dir, 'r0.json'), 'utf8') === '[]', 'empty record list saves as []');

  // Old file format: has deltas, records up to 26 h old, records missing newer fields.
  const old = [
    { t: clock - 25 * 3600_000, bot: BOT, pair: 'A/B', pools: 2, sizeUsd: 1, grossUsd: 1, gasUsd: 0, failed: false, flash: false, ours: true }, // 25 h old: dropped now
    { t: clock - 3600_000, bot: BOT, pair: 'A/B', pools: 2, sizeUsd: 10, grossUsd: 0.2, gasUsd: 0.01, failed: false, flash: false, ours: true }, // pre-Phase-1 record
    { ...rec(clock - 60_000, 7) },
  ];
  writeFileSync(join(dir, 'old.json'), JSON.stringify(old));
  const rw3 = mk(); const n3 = rw3.load(join(dir, 'none.json'), join(dir, 'old.json'));
  const r3 = (rw3 as any).recs as RivalRec[];
  assert(n3.recs === 2 && r3.every((r) => r.deltas === undefined) && r3[1].hash === old[2].hash, 'old file loads: 24 h kept, deltas left out, audit hash kept');
  assert(JSON.stringify(rw3.summary(clock - 24 * 3600_000, clock + 1)) === JSON.stringify(summarize(old.slice(1) as RivalRec[], rw3.verifiedBots())), 'old file: 24 h report numbers unchanged');

  // 24 h TTL: records older than 24 h are pruned as new ones arrive.
  const rw4 = mk();
  for (let i = 0; i < 499; i++) rw4.add(rec(clock - RIVAL_KEEP_MS - 60_000, i));
  rw4.add(rec(clock, 999)); // 500th: prune
  assert(rw4.recordCount() === 1, `records older than 24 h are dropped (left ${rw4.recordCount()})`);
  assert(rw4.sharedCount() <= 6, 'shared text table shrinks with the records');

  // ---- 3) Kuru SDK / ethers v5 not loaded at startup ------------------------
  const loaded = () => Object.keys(require.cache).some((k) => k.includes('kuru-sdk') || k.includes('ethers-v5'));
  require('../core/poolResolver');
  require('../chains/kuruAdapter');
  assert(!loaded(), 'loading poolResolver / kuruAdapter no longer loads the Kuru SDK or ethers v5');

  // ---- 4) Scan pools: live view = old list ----------------------------------
  const st = emptyScanState();
  const sp = (pool: string, t0: string, t1: string): ScannedPool => ({ dex: 'uni', kind: 'v2', pool, token0: t0, token1: t1 });
  addPoolsToState(st, { dex: 'uni', kind: 'v2', factory: '0x' + 'f1'.repeat(20) } as any, [sp(P1, '0x' + '01'.repeat(20), '0x' + '02'.repeat(20)), sp(P2, '0x' + '02'.repeat(20), '0x' + '03'.repeat(20))]);
  st.factories.push('uni4|v4|0xpm'); st.pools.push([st.factories.length - 1, '0x' + 'cd'.repeat(32), 0, 1]); // a stray V4 entry: skipped by both
  const list = stateToPools(st).map((p) => ({ pool: p.pool, token0: p.token0, token1: p.token1 }));
  const view = [...scanPoolRefs(st)];
  assert(JSON.stringify(list) === JSON.stringify(view) && view.length === 2, 'scan pool view gives exactly the old list');
  assert([...scanPoolRefs(st)].length === 2, 'scan pool view can be looped over again');
  const pools = stateToPools(st);
  assert(pools[0].dex === pools[1].dex && pools[0].kind === 'v2', 'stateToPools still gives exchange name and kind');
  const W = '0x' + '01'.repeat(20), U = '0x' + '03'.repeat(20);
  const pick = (scan: Iterable<{ pool: string; token0: string; token1: string }>) =>
    JSON.stringify(pickScanCandidates({ bases: [W, U], loopMaxPools: 5, scanPools: scan, graphPools: [], knownPairs: new Set(), skip: () => false, rivalPools: new Set([P2.toLowerCase()]), max: 10 }));
  assert(pick(list) === pick(scanPoolRefs(st)), 'loop extra pools pick the same pools from the view as from the list');

  // ---- 5) Small leaks ---------------------------------------------------------
  const c = new PoolCache();
  const base: PoolState = { chain: 'robinhood', dex: 'v2', poolAddress: '', poolType: 'v2', tokenA: '0xa', tokenB: '0xb', feeBps: 30, lastUpdatedBlock: 0, lastUpdatedMs: now };
  c.upsertFromBlock({ ...base, poolAddress: '0xidle' }, now - 5 * 3600_000);
  c.upsertFromBlock({ ...base, poolAddress: '0xbusy' }, now - 60_000);
  assert(c.blockAppliedCount() === 2, 'block reader notes recorded');
  const removed = c.prune(() => false, 2 * 3600_000, now);
  assert(removed === 1 && c.blockAppliedCount() === 1 && !!c.get('robinhood', '0xbusy'), 'prune also forgets the pruned pool\'s block reader note');

  // Competitor results: capped, and readers by position keep their place.
  let t = 0;
  const provider = {
    getTransactionReceipt: async () => ({ blockNumber: 100, index: 1 }),
    send: async () => [],
  } as any;
  const ct = new CompetitorTracker(provider, () => (t += 10_000));
  for (let i = 0; i < MAX_RESULTS + 50; i++) {
    ct.watch({ triggerHash: '0x' + i.toString(16), triggerSeenMs: 0, pools: ['0xp1', '0xp2'], profitUsd: 1 });
    for (let k = 0; k < 6; k++) await new Promise((r) => setImmediate(r));
  }
  assert(ct.results.length === MAX_RESULTS && ct.dropped === 50, `competitor results capped at ${MAX_RESULTS} (have ${ct.results.length}, dropped ${ct.dropped})`);
  assert(ct.summary().checked === MAX_RESULTS, 'summary counts what is kept');
  ct.reset();
  assert(ct.results.length === 0 && ct.dropped === 0, 'reset clears results and the drop count');
}

main().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; }).finally(() => { console.log = realLog; });
