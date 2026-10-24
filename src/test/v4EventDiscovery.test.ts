// Tests for Uniswap V4 pool discovery from the PoolManager's Initialize
// events (core/v4EventDiscovery.ts) and how it joins the existing V4 lookup.
//
// What must hold:
//   - an Initialize event is decoded exactly (real USDG/microduck-style key
//     0.78% / spacing 78 reproduces the real pool id), junk is refused;
//   - only hook-free pools at settings the fee list can't find are kept;
//   - the compact index finds a pair's pools (plus native-ETH ones for WETH
//     pairs), drops duplicates, survives save/load, respects its memory cap;
//   - the history read goes in bounded ranges, halves on refusals, waits out
//     "slow down", reads every block exactly once, and resumes after a stop;
//   - the pair watcher and the scan ask about event pools ON TOP of the fee
//     list, never twice, and the found pools get the same practice-only rules.
import { ethers } from 'ethers';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  V4_INITIALIZE_TOPIC, decodeV4InitializeLog, skipReason, isBuiltinV4Tier, V4PoolIndex, encodeV4Record, V4_RECORD_BYTES,
  setV4EventIndex, v4EventKeysFor, V4EventDiscovery, countWatchedV4BySource, v4DiscoverConfig, makeV4InitGetLogs,
} from '../core/v4EventDiscovery';
import { v4PoolId } from '../core/poolResolver';
import { discoverPairPoolsMulticall, Venue } from '../core/pairWatcher';
import { v4Asks, v4Id } from '../core/v4Lookup';
import { V4_LOOKUP_TIERS, practiceOnlyReason } from '../config/v4Tiers';
import type { RawLog } from '../core/universeScan';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const lc = (a: string) => a.toLowerCase();
const ZERO = ethers.ZeroAddress;
const PM = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const MDUCK = '0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725'; // the USDG pair at 0.78% / 78 in the missed-gaps study
const WETH = '0x7943e237c7f95da44e0301572d358911207852fa';
const HOOK = '0x00000000000000000000000000000000000000c0';
const iface = new ethers.Interface(['event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)']);

// A real-shaped Initialize log (what eth_getLogs returns).
function initLog(c0: string, c1: string, fee: number, ts: number, block: number, hooks = ZERO, tick = -12345, logIndex = 0): RawLog {
  const id = v4PoolId(c0, c1, fee, ts, hooks);
  const ev = iface.encodeEventLog('Initialize', [id, c0, c1, fee, ts, hooks, 2n ** 96n, tick]);
  return { address: lc(PM), topics: ev.topics, data: ev.data, blockNumber: '0x' + block.toString(16), logIndex: '0x' + logIndex.toString(16) };
}
const sortedPair = (a: string, b: string): [string, string] => (lc(a) < lc(b) ? [lc(a), lc(b)] : [lc(b), lc(a)]);

async function main() {
  // -------------------------------------------------------------------------
  // 1) Decoding
  // -------------------------------------------------------------------------
  assert(V4_INITIALIZE_TOPIC === iface.getEvent('Initialize')!.topicHash, 'event fingerprint matches the PoolManager\'s Initialize event');
  const [m0, m1] = sortedPair(USDG, MDUCK);
  const l1 = initLog(m0, m1, 7800, 78, 1234);
  const d1 = decodeV4InitializeLog(l1, PM)!;
  assert(!!d1 && d1.currency0 === m0 && d1.currency1 === m1 && d1.fee === 7800 && d1.tickSpacing === 78 && d1.hooks === lc(ZERO) && d1.tick === -12345 && d1.block === 1234 && d1.sqrtPriceX96 === 2n ** 96n, 'Initialize decoded: coins, fee, spacing, hook, price, negative tick, block');
  assert(d1.id === '0xa3318d6ff46aa685b3dcee29cb09211d19a53b142fe503f8ff572258fd4c5aad', 'real USDG/microduck 0.78% / 78 pool id from the missed-gaps study is reproduced');
  assert(lc(v4PoolId(d1.currency0, d1.currency1, d1.fee, d1.tickSpacing)) === d1.id, 'decoded key hashes back to the event\'s pool id');
  assert(decodeV4InitializeLog({ ...l1, address: USDG }, PM) === null, 'event from another contract refused');
  assert(decodeV4InitializeLog({ ...l1, topics: [ethers.id('Swap()'), ...l1.topics.slice(1)] }, PM) === null, 'other event type refused');
  assert(decodeV4InitializeLog({ ...l1, data: l1.data.slice(0, 66) }, PM) === null, 'short data refused');
  assert(decodeV4InitializeLog({ ...l1, removed: true } as RawLog, PM) === null, 'reorged-out log refused');
  assert(decodeV4InitializeLog({ ...l1, topics: l1.topics.slice(0, 3) }, PM) === null, 'missing topic refused');
  const native = decodeV4InitializeLog(initLog(ZERO, USDG, 7800, 78, 5), PM)!;
  assert(native.currency0 === lc(ZERO), 'native-ETH pool keeps the zero address as coin 0');

  // -------------------------------------------------------------------------
  // 2) What is kept
  // -------------------------------------------------------------------------
  assert(skipReason(d1) === null, '0.78% / 78 (not on the fee list) is kept');
  assert(skipReason(decodeV4InitializeLog(initLog(m0, m1, 3000, 60, 1), PM)!) === 'listed', 'standard 0.30% / 60 skipped: the fee list finds it');
  assert(skipReason(decodeV4InitializeLog(initLog(m0, m1, 2500, 25, 1), PM)!) === 'listed', 'extra setting 0.25% / 25 skipped: the fee list finds it');
  assert(skipReason(decodeV4InitializeLog(initLog(m0, m1, 7800, 78, 1, HOOK), PM)!) === 'hooked', 'pool with a hook skipped');
  assert(skipReason({ ...d1, fee: 0x800000 }) === 'invalid' && skipReason({ ...d1, tickSpacing: 0 }) === 'invalid' && skipReason({ ...d1, currency0: m1, currency1: m0 }) === 'invalid', 'impossible hook-free keys skipped');
  assert(isBuiltinV4Tier(500, 10) && isBuiltinV4Tier(32000, 320) && !isBuiltinV4Tier(7800, 78), 'built-in fee list check');

  // -------------------------------------------------------------------------
  // 3) The compact index
  // -------------------------------------------------------------------------
  const idx = new V4PoolIndex(10, 3);
  assert(idx.add(m0, m1, 7800, 78) && idx.add(m0, m1, 50000, 1000), 'pools added');
  idx.add(m0, m1, 7800, 78); // the same pool again (a range read twice)
  assert(idx.size() === 2, 'duplicate in pending dropped');
  assert(idx.keysForPair(m0, m1).length === 2, 'pending pools found before merge');
  await idx.merge(0);
  assert(idx.stats().stored === 2 && idx.stats().pending === 0, 'merged into the sorted buffer');
  idx.add(m0, m1, 7800, 78); // duplicate of a merged one
  idx.add(ZERO, lc(USDG), 7800, 78);
  idx.add('0x' + '1'.repeat(40), '0x' + '2'.repeat(40), 100000, 1000);
  await idx.merge(0);
  assert(idx.stats().stored === 4, 'duplicate of a merged pool dropped on the next merge');
  const ks = idx.keysForPair(m0, m1);
  assert(ks.length === 2 && ks[0].fee === 7800 && ks[1].fee === 50000 && ks.every((k) => !k.native), 'pair lookup after merge: both pools, sorted by fee');
  assert(idx.keysForPair(m0, m1, 1).length === 1, 'per-pair cap respected');
  assert(idx.keysForPair(lc(USDG), lc(WETH)).length === 0, 'unknown pair: nothing');
  assert(idx.pairCount() === 3, 'distinct pair count');
  const snap = idx.snapshot();
  assert(snap.buf.length === 4 * V4_RECORD_BYTES, 'snapshot = 48 bytes per pool');
  const idx2 = new V4PoolIndex(10);
  assert(await idx2.restore(Buffer.from(snap.buf), 0) && idx2.keysForPair(m0, m1).length === 2, 'saved buffer loads back');
  const bad = Buffer.concat([encodeV4Record(m1, m0, 1, 1), encodeV4Record(m0, m1, 1, 1)]);
  assert(!(await new V4PoolIndex(10).restore(bad, 0)) && !(await new V4PoolIndex(10).restore(Buffer.alloc(47), 0)), 'damaged (unsorted / odd-sized) file refused');
  const capped = new V4PoolIndex(2);
  capped.add(m0, m1, 1, 1); capped.add(m0, m1, 2, 2);
  assert(!capped.add(m0, m1, 3, 3) && capped.dropped === 1 && capped.size() === 2, 'memory cap: extra pools refused and counted');

  // Process-wide lookup (what the pair watcher / scan call).
  assert(v4EventKeysFor(USDG, MDUCK, WETH).length === 0, 'no index set: no extra pools (feature off)');
  const wIdx = new V4PoolIndex();
  const [w0, w1] = sortedPair(WETH, MDUCK);
  wIdx.add(w0, w1, 7800, 78);
  wIdx.add(lc(ZERO), lc(MDUCK), 21000, 210);
  wIdx.add(m0, m1, 7800, 78);
  setV4EventIndex(wIdx, 40);
  const wk = v4EventKeysFor(MDUCK.toUpperCase().replace('0X', '0x'), WETH, WETH);
  assert(wk.length === 2 && wk.some((k) => !k.native && k.fee === 7800) && wk.some((k) => k.native && k.fee === 21000 && k.c0 === lc(ZERO)), 'WETH pair: WETH pool and native-ETH pool both found (any letter case)');
  assert(v4EventKeysFor(MDUCK, USDG, WETH).length === 1, 'USDG pair: its pool only, no native variant');

  // -------------------------------------------------------------------------
  // 4) Merging with the fee-list lookup (pair watcher), no duplicates
  // -------------------------------------------------------------------------
  // Index also holds a pool at a LISTED setting (as if RH_V4_MORE_TIERS
  // changed): it must not be asked twice.
  wIdx.add(m0, m1, 3000, 60);
  const SV = '0x00000000000000000000000000000000000000aa';
  const venues: Venue[] = [{ dex: 'uniswap-v4', kind: 'v4', factory: SV, poolManager: PM, weth: WETH }];
  const evId = lc(v4PoolId(ethers.getAddress(m0), ethers.getAddress(m1), 7800, 78));
  const tierId = lc(v4PoolId(ethers.getAddress(m0), ethers.getAddress(m1), 3000, 60));
  const iSV = new ethers.Interface(['function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)', 'function getLiquidity(bytes32) view returns (uint128)']);
  const asked: string[] = [];
  const fake = async (calls: { target: string; data: string }[]) => calls.map((c) => {
    const id = '0x' + c.data.slice(10, 74);
    asked.push(c.data);
    if (id !== evId && id !== tierId) return '0x' + '0'.repeat(64 * 4);
    return c.data.startsWith(iSV.getFunction('getLiquidity')!.selector) ? '0x' + (10n ** 18n).toString(16).padStart(64, '0')
      : iSV.encodeFunctionResult('getSlot0', [2n ** 96n, 0, 0, 7800]);
  });
  const { pools } = await discoverPairPoolsMulticall(fake, 'robinhood', venues, ethers.getAddress(USDG), ethers.getAddress(MDUCK));
  const liqAsks = asked.filter((d) => d.startsWith(iSV.getFunction('getLiquidity')!.selector));
  assert(liqAsks.length === V4_LOOKUP_TIERS.length + 1, `fee list (${V4_LOOKUP_TIERS.length}) + 1 event pool asked; the listed one in the index not asked twice (${liqAsks.length})`);
  assert(pools.length === 2 && pools.some((p) => lc(p.poolAddress) === evId && p.v4?.fee === 7800 && p.v4.tickSpacing === 78 && p.feePips === 7800) && pools.some((p) => lc(p.poolAddress) === tierId), 'event pool and fee-list pool both found, once each, with the event pool\'s real fee');
  assert(new Set(pools.map((p) => lc(p.poolAddress))).size === pools.length, 'no duplicate pools');

  // Scan's V4 asks (core/v4Lookup.ts): same merge.
  const sa = v4Asks([{ quote: USDG, other: MDUCK }], WETH);
  assert(sa.length === V4_LOOKUP_TIERS.length + 1 && sa.some((a) => a.id === v4Id(m0, m1, 7800, 78) && a.fee === 7800), 'scan asks: fee list + the event pool, no duplicate');
  const sw = v4Asks([{ quote: WETH, other: MDUCK }], WETH);
  assert(sw.length === 2 * V4_LOOKUP_TIERS.length + 2 && sw.some((a) => a.native && a.fee === 21000 && a.c0 === lc(ZERO)), 'scan asks for a WETH pair include the native-ETH event pool');
  setV4EventIndex(null);
  assert(v4Asks([{ quote: USDG, other: MDUCK }], WETH).length === V4_LOOKUP_TIERS.length, 'index off: exactly the old asks');

  // -------------------------------------------------------------------------
  // 5) Filters preserved (practice-only rules) and watched-pool counting
  // -------------------------------------------------------------------------
  const evPool = { v4: { fee: 7800, tickSpacing: 78 } };
  assert(practiceOnlyReason(evPool, {}) === null, 'event pool (hook-free) is live-tradable by default, like other hook-free V4 pools');
  assert(/V4_EVENT_POOLS_LIVE/.test(practiceOnlyReason(evPool, { V4_EVENT_POOLS_LIVE: '0' }) ?? ''), 'V4_EVENT_POOLS_LIVE=0: event pools practice only');
  assert(practiceOnlyReason({ v4: { fee: 2500, tickSpacing: 25 } }, { V4_EVENT_POOLS_LIVE: '0' }) === null, 'V4_EVENT_POOLS_LIVE=0 leaves listed settings alone');
  assert(practiceOnlyReason(evPool, { RH_V4_MORE_TIERS: '7800:78', V4_EVENT_POOLS_LIVE: '0' }) === null, 'a setting added to RH_V4_MORE_TIERS counts as listed');
  assert(/non-standard/.test(practiceOnlyReason(evPool, { RH_V4_EXTRA_LIVE: '0' }) ?? ''), 'RH_V4_EXTRA_LIVE=0 still makes it practice only (same as before)');
  assert(practiceOnlyReason({ v4: { fee: 7800, tickSpacing: 78, hooks: HOOK } }, { V4_EVENT_POOLS_LIVE: '0', RH_V4_EXTRA_LIVE: '0' }) === null, 'hooked pools: rule unchanged');
  const cnt = countWatchedV4BySource([{ v4: { fee: 3000, tickSpacing: 60 } }, { v4: { fee: 7800, tickSpacing: 78 } }, { v4: { fee: 7800, tickSpacing: 78, hooks: HOOK } }, {}], V4_LOOKUP_TIERS);
  assert(cnt.tiers === 1 && cnt.events === 1, 'watched V4 pools counted by source (hooked and non-V4 left out)');
  const cfg = v4DiscoverConfig({});
  assert(cfg.enabled && cfg.fromBlock === 0 && cfg.pollMs === 60_000 && cfg.maxPools === 1_500_000 && cfg.maxPerPair === 40, 'defaults: on, from block 0, every minute, 1.5M cap, 40 a pair');
  assert(!v4DiscoverConfig({ V4_DISCOVER_EVENTS: '0' }).enabled && v4DiscoverConfig({ V4_DISCOVER_FROM_BLOCK: '900', V4_DISCOVER_POLL_MS: '5' }).fromBlock === 900 && v4DiscoverConfig({ V4_DISCOVER_POLL_MS: '5' }).pollMs === 10_000, 'switches read, minimum poll interval enforced');

  // makeV4InitGetLogs: one request, PoolManager + Initialize only.
  let sent: any = null;
  const gl = makeV4InitGetLogs(async (m, p) => { sent = { m, p }; return [l1]; }, PM, 1000);
  const got = await gl(16, 31);
  assert(got.length === 1 && sent.m === 'eth_getLogs' && sent.p[0].address === PM && sent.p[0].topics[0] === V4_INITIALIZE_TOPIC && sent.p[0].fromBlock === '0x10' && sent.p[0].toBlock === '0x1f', 'log request: PoolManager address, Initialize topic, hex block range');
  let timedOut = false;
  try { await makeV4InitGetLogs(() => new Promise(() => {}), PM, 20)(1, 2); } catch (e) { timedOut = /timeout/.test(String(e)); }
  assert(timedOut, 'hung request turns into a timeout error');

  // -------------------------------------------------------------------------
  // 6) History read: chunking, refusals, slow-downs, resume
  // -------------------------------------------------------------------------
  const dir = mkdtempSync(join(tmpdir(), 'v4ev-'));
  try {
    const HEAD = 100_000;
    // Chain: 400 events spread over blocks 20,000..99,999; listed, hooked and
    // unlisted mixed; 300 kept.
    const chain: RawLog[] = [];
    for (let i = 0; i < 400; i++) {
      const tok = '0x' + (0x1000 + i).toString(16).padStart(40, 'a');
      const [c0, c1] = sortedPair(USDG, tok);
      const block = 20_000 + i * 199;
      if (i % 8 === 0) chain.push(initLog(c0, c1, 3000, 60, block));            // listed: 50
      else if (i % 8 === 1) chain.push(initLog(c0, c1, 7800, 78, block, HOOK)); // hooked: 50
      else chain.push(initLog(c0, c1, 7800 + i, 78, block));                    // kept: 300
    }
    const inRange = (f: number, t: number) => chain.filter((l) => { const b = Number(BigInt(l.blockNumber!)); return b >= f && b <= t; });
    const reqs: Array<[number, number]> = [];
    let slowOnce = true;
    let failFrom = Infinity;      // simulate the node dying at this block
    const getLogs = async (f: number, t: number) => {
      reqs.push([f, t]);
      if (t - f + 1 > 20_000) throw new Error('block range too large');   // node limit
      if (slowOnce && f > 40_000) { slowOnce = false; throw new Error('429 Too Many Requests'); }
      if (t >= failFrom) throw new Error('connection reset');
      return inRange(f, t);
    };
    const sleeps: number[] = [];
    const file = join(dir, 'v4-pools.json');
    const mk = (index = new V4PoolIndex(1_000, 50)) => new V4EventDiscovery({
      poolManager: PM, getLogs, latestBlock: async () => HEAD, file, index, minRange: 500, maxRange: 64_000, startRange: 50_000,
      targetLogs: 40, pauseMs: 1, saveEveryMs: 0, sleep: async (ms) => { sleeps.push(ms); }, log: () => {}, sliceMs: 0,
    });
    // First run dies at block 70,000 (after the history read is part done).
    failFrom = 70_000;
    const r1 = mk();
    const ok1 = await r1.poll();
    assert(!ok1 && !r1.isBackfillDone(), 'node keeps failing: round stops (no endless retry), history not marked done');
    const p1 = r1.progress();
    assert(p1.next > 20_000 && p1.next <= 70_000 && p1.pct > 0 && p1.pct < 100, `progress saved part way (next block ${p1.next}, ${p1.pct.toFixed(0)}%)`);
    assert(reqs.every(([f, t]) => t >= f) && reqs.some(([f, t]) => t - f + 1 > 20_000) && sleeps.some((s) => s >= 2_000), 'too-big range refused then halved; "slow down" waited out');
    assert(existsSync(file) && existsSync(file + '.bin'), 'progress and records written to disk');
    // Restart (new process): loads, resumes from the saved block.
    failFrom = Infinity;
    reqs.length = 0;
    const r2 = mk();
    const ok2 = await r2.poll();
    assert(ok2 && r2.isBackfillDone(), 'restart: history read finishes');
    assert(reqs.length > 0 && reqs[0][0] >= p1.next - 1 && reqs[0][0] <= p1.next, `restart resumed at block ${reqs[0]?.[0]} (no re-scan from 0)`);
    // Every block from the start to the head read: requests tile without gaps.
    assert(r2.counts.stored === 300 && r2.counts.listed === 50 && r2.counts.hooked === 50, `every event counted once over both runs (kept ${r2.counts.stored}, listed ${r2.counts.listed}, hooked ${r2.counts.hooked})`);
    assert(r2.index.size() === 300, 'index holds exactly the 300 kept pools (no duplicates after resume)');
    assert(reqs.every(([f, t]) => t - f + 1 <= 64_000), 'no request bigger than the max range');
    // A third process loads the finished list and only follows new blocks.
    reqs.length = 0;
    const r3 = mk();
    await r3.load();
    assert(r3.isBackfillDone() && r3.index.size() === 300, 'finished list loads with the "done" mark');
    await r3.poll();
    assert(reqs.length === 0, 'nothing new on chain: no log request (already at the head)');
    // A new pool appears in a new block: picked up by the next round.
    const [n0, n1] = sortedPair(USDG, '0x' + 'b'.repeat(40));
    chain.push(initLog(n0, n1, 21000, 210, HEAD + 5));
    const r4 = new V4EventDiscovery({
      poolManager: PM, getLogs, latestBlock: async () => HEAD + 10, file, index: new V4PoolIndex(1_000, 50), pauseMs: 0, saveEveryMs: 0,
      sleep: async () => {}, log: () => {}, sliceMs: 0,
    });
    await r4.poll();
    assert(r4.index.keysForPair(n0, n1).some((k) => k.fee === 21000 && k.tickSpacing === 210), 'new pool after the history read: found by the next round');
    assert(/history read done/.test(r4.statusLine({ tiers: 3, events: 1 })) && /1 found by events/.test(r4.statusLine({ tiers: 3, events: 1 })), 'status line shows history state and pools found by events vs fee list');
    // A saved file for another PoolManager is not used.
    const other = new V4EventDiscovery({ poolManager: '0x' + '9'.repeat(40), getLogs, latestBlock: async () => HEAD, file, log: () => {}, sliceMs: 0 });
    await other.load();
    assert(other.index.size() === 0 && !other.isBackfillDone(), 'saved list for a different PoolManager ignored (history read again)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error('FAIL: test crashed', e); process.exitCode = 1; });
