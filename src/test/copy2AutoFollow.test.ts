import { AbiCoder, keccak256 } from 'ethers';
import { Copy2Link, copy2Settings, parseCopy2Status, autoPoolOf, autoLookupReason } from '../execution/copy2';
import { V4_INITIALIZE_TOPIC, decodeV4InitializeLog } from '../core/v4EventDiscovery';
import type { PoolState } from '../core/types';

// COPY 2 AUTO-FOLLOW (Oct 25, the "V4 blind spot"). Live: checks kept
// missing values of Uniswap V4 pools copy 2 doesn't follow, so every feed
// transaction through such a pool was unanswerable. The fast check now lists
// the V4 pools its checks keep running into (status
// copy2.v4Blind.autoFollow.ids, only when ARBSIM_V4_AUTOFOLLOW=1 there). The
// bot looks up each one's key from its Initialize event and follows it like
// a watched pool if it is plain (no hook). These tests cover the bot side:
// reading the list, the key check, the follow list / subscription, the caps
// (count, lookups a minute), expiry, and "off" (no list = nothing happens).
// Oct 26 rebuild: live, every one of ~1,000 whole-history lookups failed.
// Now the fast check sends each listed pool's key (learned from the
// transactions it ran), so the bot follows it with NO node request; the
// search is only a fallback (after a wait, in a bounded recent window, in
// slices, within an hourly request budget, real error counted and logged).
// Fake clock, fake node, no network.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

let clock = 9_000_000;
const tick = () => new Promise((r) => setImmediate(r));
const schedule = (_fn: () => void, _ms: number) => () => {};

const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const WETH = '0x00000000000000000000000000000000000000e1';
const USDG = '0x00000000000000000000000000000000000000c2';
const ZERO = '0x' + '0'.repeat(40);
const addr = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const word = (n: bigint) => (BigInt.asUintN(256, n)).toString(16).padStart(64, '0');
const pad = (a: string) => '0x' + '0'.repeat(24) + a.slice(2);
const pool = (n: number): PoolState => ({
  chain: 'robinhood', dex: 'uniswap-v2', poolAddress: addr(n), poolType: 'v2', tokenA: WETH, tokenB: USDG,
  feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: 1,
} as PoolState);

// A V4 pool key and its real id.
function v4id(c0: string, c1: string, fee: number, ts: number, hooks = ZERO): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24', 'int24', 'address'], [c0, c1, fee, ts, hooks])).toLowerCase();
}
// The PoolManager's Initialize event for it.
function initLog(c0: string, c1: string, fee: number, ts: number, hooks = ZERO, id = v4id(c0, c1, fee, ts, hooks)) {
  return {
    address: PM, topics: [V4_INITIALIZE_TOPIC, id, pad(c0), pad(c1)],
    data: '0x' + word(BigInt(fee)) + word(BigInt(ts)) + word(BigInt(hooks)) + word(1n << 96n) + word(0n),
    blockNumber: '0x' + (HEAD - 10).toString(16),
  };
}

function fakeClient() {
  const requests: any[] = [];
  return {
    requests,
    isConnected: () => true,
    sendOneWay: () => true,
    request: async (m: Record<string, unknown>) => { requests.push(JSON.parse(JSON.stringify(m))); return { id: m.id, ok: true }; },
  };
}

// A fake HTTP node: eth_blockNumber = HEAD; eth_getLogs answered from
// `events` (by pool id topic and block range). `calls` = every request,
// `logs()` = the eth_getLogs ones.
const HEAD = 3_000_000;
function fakeRpc(events: any[]) {
  const calls: any[] = [];
  const rpc = async (method: string, params: any[]) => {
    calls.push({ method, params });
    if (method === 'eth_blockNumber') return '0x' + HEAD.toString(16);
    if (method !== 'eth_getLogs') throw new Error('unexpected ' + method);
    const id = params[0].topics[1];
    const from = Number(params[0].fromBlock), to = Number(params[0].toBlock);
    return events.filter((e) => e.topics[1] === id && Number(e.blockNumber) >= from && Number(e.blockNumber) <= to);
  };
  return { rpc, calls, logs: () => calls.filter((c) => c.method === 'eth_getLogs') };
}

// Most older tests look at the fallback search alone: no wait for a key.
function makeLink(env: Record<string, string> = { COPY2_AUTOFOLLOW_KEY_WAIT_S: '0' }, events: any[] = [], logs: string[] = []) {
  const client = fakeClient();
  const link = new Copy2Link({ client: client as any, settings: copy2Settings(env), pools: () => [pool(1)], poolManager: PM, now: () => clock, schedule, autoTimers: false, log: (m) => logs.push(m) });
  const node = fakeRpc(events);
  link.setBackfillRpc(node.rpc);
  return { link, client, node };
}
const status = (ids: string[], keys: Record<string, unknown> = {}) => ({ ok: true, source: 'pool-events', copy2: { pools: {}, v4Blind: { autoFollow: { on: true, ids, keys } } } });
const keyOf = (c0: string, c1: string, fee: number, ts: number, hooks = ZERO) => ({ currency0: c0, currency1: c1, fee, tickSpacing: ts, hooks });
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

async function main() {
  const plain = { c0: ZERO, c1: USDG, fee: 7800, ts: 78 };              // native ETH / USDG 0.78 %, spacing 78
  const idPlain = v4id(plain.c0, plain.c1, plain.fee, plain.ts);
  const hooked = { c0: WETH, c1: USDG, fee: 3000, ts: 60, hooks: addr(0xbeef) };
  const idHooked = v4id(hooked.c0, hooked.c1, hooked.fee, hooked.ts, hooked.hooks);

  // ---- reading the fast check's list --------------------------------------
  const st = parseCopy2Status(status([idPlain.toUpperCase().replace('0X', '0x'), 'junk']));
  assert(st.autoFollow.length === 1 && st.autoFollow[0] === idPlain, 'status: auto-follow ids read (lower case), junk dropped');
  assert(parseCopy2Status({ ok: true, source: 'pool-events', copy2: { pools: {} } }).autoFollow.length === 0, 'status without the list (older fast check / auto-follow off): empty');

  // ---- the key check ------------------------------------------------------
  const p = autoPoolOf(decodeV4InitializeLog(initLog(plain.c0, plain.c1, plain.fee, plain.ts) as any, PM), PM);
  assert(!('skip' in p) && p.v4Id === idPlain && p.kind === 'V4' && p.address === PM && p.fee === 7800 && p.tickSpacing === 78 && p.token0 === ZERO, 'plain pool from its Initialize event: followable, exactly its key');
  const h = autoPoolOf(decodeV4InitializeLog(initLog(hooked.c0, hooked.c1, hooked.fee, hooked.ts, hooked.hooks) as any, PM), PM);
  assert('skip' in h && /hook/.test(h.skip), 'pool with a hook: never auto-followed');
  const lie = autoPoolOf(decodeV4InitializeLog(initLog(plain.c0, plain.c1, plain.fee, plain.ts, ZERO, idHooked) as any, PM), PM);
  assert('skip' in lie && /does not match/.test(lie.skip), 'key that does not hash to the id: refused');
  assert('skip' in autoPoolOf(null, PM), 'no event: refused');

  // ---- defaults -----------------------------------------------------------
  const d = copy2Settings({});
  assert(d.autoFollowMax === 200 && d.autoFollowTtlMs === 600_000 && d.autoFollowLookupsPerMin === 6, 'defaults: at most 200 pools, 10 min after the fast check stops listing, 6 lookups a minute');
  assert(d.autoFollowKeyWaitMs === 120_000 && d.autoFollowLookbackBlocks === 2_000_000 && d.autoFollowRequestsPerHour === 60 && d.autoFollowRange === 500_000, 'defaults: wait 2 min for the key, then search the last 2,000,000 blocks in 500,000-block slices, at most 60 node requests an hour');

  // ---- following a listed pool --------------------------------------------
  {
    const { link, client, node } = makeLink(undefined, [initLog(plain.c0, plain.c1, plain.fee, plain.ts), initLog(hooked.c0, hooked.c1, hooked.fee, hooked.ts, hooked.hooks)]);
    link.applyStatus(status([idPlain, idHooked]));
    await settle();
    assert(node.logs().length === 2 && node.logs()[0].params[0].address === PM && node.logs()[0].params[0].topics[0] === V4_INITIALIZE_TOPIC && node.logs()[0].params[0].topics[1] === idPlain, 'one eth_getLogs per new pool (PoolManager, Initialize, the id), found in the newest slice');
    const keys = link.followList().map((x) => (x.v4Id ?? x.address).toLowerCase());
    assert(keys.includes(idPlain) && !keys.includes(idHooked), 'the plain pool joins the follow list, the hooked one does not');
    assert(link.heldTargets().ids.includes(idPlain) && link.tap.extraTargets!().ids.includes(idPlain), 'its id goes to the WebSocket subscription (next renewal)');
    assert(link.autoCount() === 1 && link.autoCounts.notPlain === 1, 'counted: 1 auto-followed, 1 not plain');
    // Track: only once the subscription really covers it.
    link.tap.onLive({ pools: new Set([addr(1)]), ids: new Set(), transferPools: new Set([addr(1)]), coins: new Set([WETH, USDG]) });
    await settle();
    const t1 = [...client.requests].reverse().find((r) => r.type === 'track');
    assert(!!t1 && !t1.pools.some((x: any) => x.v4Id === idPlain), 'not tracked before the subscription covers its events');
    link.tap.onLive({ pools: new Set([addr(1)]), ids: new Set([idPlain]), transferPools: new Set([addr(1)]), coins: new Set([WETH, USDG]) });
    await settle();
    const t2 = [...client.requests].reverse().find((r) => r.type === 'track');
    assert(!!t2 && t2.pools.some((x: any) => x.v4Id === idPlain && x.kind === 'V4' && x.fee === 7800), 'tracked once covered: copy 2 loads it like any V4 pool');
    // Listed again: no second lookup. Not listed for the TTL: dropped.
    link.applyStatus(status([idPlain]));
    await settle();
    const before = node.calls.length;
    assert(before === 4, `2 searches = 2 head reads + 2 log reads (got ${before})`);
    assert(node.calls.length === before, 'listed again: no new lookup');
    clock += 9 * 60_000;
    link.applyStatus(status([]));
    clock += 6_000;
    assert(link.autoCount() === 1, 'within 10 min of the last listing: still followed');
    clock += 2 * 60_000;
    assert(link.autoCount() === 0 && link.autoCounts.expired === 1 && !link.followList().some((x) => x.v4Id === idPlain), 'not listed for 10 min: dropped (expiry)');
    // Listed again later: known key, no new lookup.
    link.applyStatus(status([idPlain]));
    clock += 6_000;
    assert(link.autoCount() === 1 && node.calls.length === before, 'listed again later: followed from the kept key, no new node request');
    assert(/auto-followed V4 pools 1/.test(link.hourText() ?? ''), 'hourly line reports auto-follow');
  }

  // ---- caps ---------------------------------------------------------------
  {
    const evs: any[] = [];
    const ids: string[] = [];
    for (let i = 1; i <= 10; i++) { const c1 = addr(0x100 + i); evs.push(initLog(WETH, c1, 3000, 60)); ids.push(v4id(WETH, c1, 3000, 60)); }
    const { link, node } = makeLink({ COPY2_AUTOFOLLOW_MAX: '3', COPY2_AUTOFOLLOW_KEY_WAIT_S: '0' }, evs);
    link.applyStatus(status(ids));
    await settle();
    assert(node.logs().length === 6, `at most 6 lookups a minute (got ${node.logs().length})`);
    clock += 6_000;
    assert(link.autoCount() === 3, 'COPY2_AUTOFOLLOW_MAX=3: at most 3 auto-followed pools');
    clock += 61_000;
    link.applyStatus(status(ids));
    await settle();
    assert(link.autoCount() === 3 && node.logs().length === 6, 'list full: no more lookups');
  }

  // ---- lookup errors back off --------------------------------------------
  {
    const { link, node } = makeLink();
    let fail = true;
    link.setBackfillRpc(async (m: string, ps: any[]) => { node.calls.push({ m, ps }); if (m === 'eth_blockNumber') return '0x' + HEAD.toString(16); if (fail) throw new Error('RPS limit'); return [initLog(plain.c0, plain.c1, plain.fee, plain.ts)]; });
    link.applyStatus(status([idPlain]));
    await settle();
    link.applyStatus(status([idPlain]));
    await settle();
    assert(node.calls.length === 2 && link.autoCounts.failed === 1, 'a failed lookup is not repeated at once (node rate limit)');
    fail = false;
    clock += 5 * 60_000 + 1;
    link.applyStatus(status([idPlain]));
    await settle();
    clock += 6_000;
    assert(node.calls.length === 4 && link.autoCount() === 1, 'retried after 5 min, then followed');
  }

  // ---- off -----------------------------------------------------------------
  {
    const { link, node } = makeLink({ COPY2_AUTOFOLLOW_MAX: '0', COPY2_AUTOFOLLOW_KEY_WAIT_S: '0' }, [initLog(plain.c0, plain.c1, plain.fee, plain.ts)]);
    link.applyStatus(status([idPlain]));
    await settle();
    assert(node.calls.length === 0 && link.autoCount() === 0, 'COPY2_AUTOFOLLOW_MAX=0: never looks up or follows');
    const b = makeLink(undefined, [initLog(plain.c0, plain.c1, plain.fee, plain.ts)]);
    b.link.applyStatus({ ok: true, source: 'pool-events', copy2: { pools: {} } });
    await settle();
    assert(b.node.calls.length === 0 && b.link.autoCount() === 0, 'fast check lists nothing (its default, ARBSIM_V4_AUTOFOLLOW=0): nothing happens');
  }

  // ==== Oct 26 rebuild ======================================================
  // ---- keys from the fast check's own runs: no node request -----------------
  {
    const st2 = parseCopy2Status(status([idPlain], { [idPlain.toUpperCase().replace('0X', '0x')]: keyOf(plain.c0, plain.c1, plain.fee, plain.ts), junk: {} }));
    const k = st2.autoFollowKeys.get(idPlain);
    assert(!!k && k.fee === 7800 && k.tickSpacing === 78 && k.currency0 === ZERO && st2.autoFollowKeys.size === 1, 'status: keys read next to the ids (lower case), junk dropped');
    const logs: string[] = [];
    const { link, node } = makeLink({}, [], logs);
    link.applyStatus(status([idPlain, idHooked], { [idPlain]: keyOf(plain.c0, plain.c1, plain.fee, plain.ts), [idHooked]: keyOf(hooked.c0, hooked.c1, hooked.fee, hooked.ts, hooked.hooks) }));
    await settle();
    assert(node.calls.length === 0, 'key sent by the fast check: followed with NO node request');
    assert(link.autoCount() === 1 && link.followList().some((x) => x.v4Id === idPlain && x.fee === 7800 && x.tickSpacing === 78), 'the plain pool is followed from that key');
    assert(link.autoCounts.fromCalls === 1 && link.autoCounts.notPlain === 1 && link.autoCounts.lookups === 0, 'counted: 1 from the fast check\'s runs, 1 not plain (hook), 0 searches');
    assert(logs.some((m) => /no node request/.test(m)), 'log says where the key came from');
    assert(/key from the fast check's runs 1/.test(link.hourText() ?? ''), 'hourly line: keys from the fast check\'s runs');
    clock += 10 * 60_000;
    link.applyStatus(status([idHooked], { [idHooked]: keyOf(hooked.c0, hooked.c1, hooked.fee, hooked.ts, hooked.hooks) }));
    await settle();
    assert(node.calls.length === 0 && link.autoCounts.notPlain === 1, 'hooked pool listed again: no search, not counted twice');
  }

  // ---- a key that does not hash to the id is refused ------------------------
  {
    const { link, node } = makeLink({}, [initLog(plain.c0, plain.c1, plain.fee, plain.ts)]);
    link.applyStatus(status([idPlain], { [idPlain]: keyOf(plain.c0, plain.c1, 3000, plain.ts) }));
    await settle();
    assert(link.autoCount() === 0 && link.autoCounts.keyBad === 1 && node.calls.length === 0, 'wrong key for the id: refused (bad keys 1), not followed');
    clock += 121_000;
    link.applyStatus(status([idPlain], { [idPlain]: keyOf(plain.c0, plain.c1, 3000, plain.ts) }));
    await settle();
    assert(link.autoCount() === 1 && link.autoCounts.fromLookups === 1, 'after the wait, the fallback search finds the real key');
  }

  // ---- no key: wait, then a bounded search -----------------------------------
  {
    const { link, node } = makeLink({}, []);
    link.applyStatus(status([idPlain]));
    await settle();
    clock += 60_000;
    link.applyStatus(status([idPlain]));
    await settle();
    assert(node.calls.length === 0, 'no key yet: no search during the first 2 minutes (the fast check usually sends it)');
    clock += 61_000;
    link.applyStatus(status([idPlain]));
    await settle();
    const gl = node.logs().map((c) => c.params[0]);
    const from = gl.map((p) => Number(p.fromBlock)), to = gl.map((p) => Number(p.toBlock));
    assert(gl.length === 4, `not found: 2,000,000 blocks searched in 4 slices of 500,000 (got ${gl.length})`);
    assert(to[0] === HEAD && Math.min(...from) === HEAD - 2_000_000 + 1 && gl.every((p, i) => Number(p.toBlock) - Number(p.fromBlock) + 1 <= 500_000 && (i === 0 || Number(p.toBlock) === from[i - 1] - 1)), 'newest slice first, back-to-back, never beyond the window');
    assert(gl.every((p) => p.toBlock !== 'latest' && p.fromBlock !== '0x0'), 'never a whole-history search');
    assert(link.autoCounts.notFound === 1 && link.autoCounts.requests === 5, 'counted: not found 1, node requests 5 (head + 4 slices)');
    // Not found waits an hour.
    clock += 30 * 60_000;
    link.applyStatus(status([idPlain]));
    await settle();
    assert(node.calls.length === 5, 'not found: not searched again within the hour');
  }
  {
    // V4_DISCOVER_FROM_BLOCK is a floor too; a smaller lookback / range.
    const { link, node } = makeLink({ COPY2_AUTOFOLLOW_KEY_WAIT_S: '0', COPY2_AUTOFOLLOW_LOOKBACK_BLOCKS: '100000', V4_DISCOVER_MAX_RANGE: '40000', V4_DISCOVER_FROM_BLOCK: String(HEAD - 50_000) }, []);
    link.applyStatus(status([idPlain]));
    await settle();
    const gl = node.logs().map((c) => c.params[0]);
    assert(gl.length === 2 && Number(gl[1].fromBlock) === HEAD - 50_000, 'search stops at V4_DISCOVER_FROM_BLOCK when that is newer than the window');
    const off = makeLink({ COPY2_AUTOFOLLOW_KEY_WAIT_S: '0', COPY2_AUTOFOLLOW_LOOKBACK_BLOCKS: '0' }, [initLog(plain.c0, plain.c1, plain.fee, plain.ts)]);
    off.link.applyStatus(status([idPlain]));
    await settle();
    assert(off.node.calls.length === 0 && off.link.autoCount() === 0, 'COPY2_AUTOFOLLOW_LOOKBACK_BLOCKS=0: no fallback search (keys from the fast check only)');
    // A key arriving later still works.
    off.link.applyStatus(status([idPlain], { [idPlain]: keyOf(plain.c0, plain.c1, plain.fee, plain.ts) }));
    assert(off.link.autoCount() === 1 && off.node.calls.length === 0, 'then followed as soon as the fast check sends the key');
  }

  // ---- hourly request budget -------------------------------------------------
  {
    const evs: any[] = [];
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) { const c1 = addr(0x200 + i); ids.push(v4id(WETH, c1, 3000, 60)); }
    const { link, node } = makeLink({ COPY2_AUTOFOLLOW_KEY_WAIT_S: '0', COPY2_AUTOFOLLOW_REQUESTS_PER_HOUR: '6' }, evs);
    link.applyStatus(status(ids));
    await settle();
    assert(node.calls.length === 6, `COPY2_AUTOFOLLOW_REQUESTS_PER_HOUR=6: at most 6 node requests (got ${node.calls.length})`);
    assert(link.autoCounts.budget >= 1, 'searches over the budget are postponed and counted');
  }

  // ---- the real error, counted and logged (URL masked), smaller slices -------
  {
    const logs: string[] = [];
    const { link } = makeLink(undefined, [], logs);
    let n = 0;
    link.setBackfillRpc(async (m: string) => {
      if (m === 'eth_blockNumber') return '0x' + HEAD.toString(16);
      n++;
      if (n === 1) { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }
      throw new Error('request to https://robinhood-mainnet.core.chainstack.com/abc123secret failed: -32005 block range too large');
    });
    link.applyStatus(status([idPlain]));
    await settle();
    clock += 5 * 60_000 + 1;
    link.applyStatus(status([idPlain]));
    await settle();
    assert(link.autoCounts.failed === 2 && link.autoErrors['timeout'] === 1, 'a timeout is counted as "timeout"');
    const other = Object.keys(link.autoErrors).find((k) => k !== 'timeout') ?? '';
    assert(/block range too large/.test(other) && !/chainstack|abc123secret/.test(other) && /<url>/.test(other), 'the node\'s own error is counted, with the URL (and its key) masked');
    assert(logs.filter((m) => /key search for V4 pool/.test(m)).length === 2 && !logs.some((m) => /abc123secret/.test(m)), 'the first errors are logged, never the URL');
    assert(logs.some((m) => /250,000-block slices/.test(m)) && logs.some((m) => /125,000-block slices/.test(m)), 'after a timeout / refusal later searches use half-size slices');
    assert(/search errors 2 \(/.test(link.hourText() ?? ''), 'hourly line: search errors with reasons');
    assert(autoLookupReason(new Error('HTTP 429')) === 'HTTP 429' && autoLookupReason('x https://a.b/c?k=1 y') === 'x <url> y', 'error reasons: short, URLs masked');
  }
}

main().catch((e) => { console.error('FAIL: crashed', e); process.exitCode = 1; });
