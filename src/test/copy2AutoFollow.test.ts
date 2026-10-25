import { AbiCoder, keccak256 } from 'ethers';
import { Copy2Link, copy2Settings, parseCopy2Status, autoPoolOf } from '../execution/copy2';
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
    blockNumber: '0x10',
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

// A fake HTTP node answering eth_getLogs from `events` (by pool id topic).
function fakeRpc(events: any[]) {
  const calls: any[] = [];
  const rpc = async (method: string, params: any[]) => {
    calls.push({ method, params });
    if (method !== 'eth_getLogs') throw new Error('unexpected ' + method);
    const id = params[0].topics[1];
    return events.filter((e) => e.topics[1] === id);
  };
  return { rpc, calls };
}

function makeLink(env: Record<string, string> = {}, events: any[] = []) {
  const client = fakeClient();
  const link = new Copy2Link({ client: client as any, settings: copy2Settings(env), pools: () => [pool(1)], poolManager: PM, now: () => clock, schedule, autoTimers: false, log: () => {} });
  const node = fakeRpc(events);
  link.setBackfillRpc(node.rpc);
  return { link, client, node };
}
const status = (ids: string[]) => ({ ok: true, source: 'pool-events', copy2: { pools: {}, v4Blind: { autoFollow: { on: true, ids } } } });
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

  // ---- following a listed pool --------------------------------------------
  {
    const { link, client, node } = makeLink({}, [initLog(plain.c0, plain.c1, plain.fee, plain.ts), initLog(hooked.c0, hooked.c1, hooked.fee, hooked.ts, hooked.hooks)]);
    link.applyStatus(status([idPlain, idHooked]));
    await settle();
    assert(node.calls.length === 2 && node.calls[0].params[0].address === PM && node.calls[0].params[0].topics[0] === V4_INITIALIZE_TOPIC, 'one eth_getLogs per new pool (PoolManager, Initialize, the id)');
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
    assert(node.calls.length === 2, 'listed again: no new lookup');
    clock += 9 * 60_000;
    link.applyStatus(status([]));
    clock += 6_000;
    assert(link.autoCount() === 1, 'within 10 min of the last listing: still followed');
    clock += 2 * 60_000;
    assert(link.autoCount() === 0 && link.autoCounts.expired === 1 && !link.followList().some((x) => x.v4Id === idPlain), 'not listed for 10 min: dropped (expiry)');
    // Listed again later: known key, no new lookup.
    link.applyStatus(status([idPlain]));
    clock += 6_000;
    assert(link.autoCount() === 1 && node.calls.length === 2, 'listed again later: followed from the kept key, no new node request');
    assert(/auto-followed V4 pools 1/.test(link.hourText() ?? ''), 'hourly line reports auto-follow');
  }

  // ---- caps ---------------------------------------------------------------
  {
    const evs: any[] = [];
    const ids: string[] = [];
    for (let i = 1; i <= 10; i++) { const c1 = addr(0x100 + i); evs.push(initLog(WETH, c1, 3000, 60)); ids.push(v4id(WETH, c1, 3000, 60)); }
    const { link, node } = makeLink({ COPY2_AUTOFOLLOW_MAX: '3' }, evs);
    link.applyStatus(status(ids));
    await settle();
    assert(node.calls.length === 6, `at most 6 lookups a minute (got ${node.calls.length})`);
    clock += 6_000;
    assert(link.autoCount() === 3, 'COPY2_AUTOFOLLOW_MAX=3: at most 3 auto-followed pools');
    clock += 61_000;
    link.applyStatus(status(ids));
    await settle();
    assert(link.autoCount() === 3 && node.calls.length === 6, 'list full: no more lookups');
  }

  // ---- lookup errors back off --------------------------------------------
  {
    const { link, node } = makeLink();
    let fail = true;
    link.setBackfillRpc(async (m: string, ps: any[]) => { node.calls.push({ m, ps }); if (fail) throw new Error('RPS limit'); return [initLog(plain.c0, plain.c1, plain.fee, plain.ts)]; });
    link.applyStatus(status([idPlain]));
    await settle();
    link.applyStatus(status([idPlain]));
    await settle();
    assert(node.calls.length === 1 && link.autoCounts.failed === 1, 'a failed lookup is not repeated at once (node rate limit)');
    fail = false;
    clock += 5 * 60_000 + 1;
    link.applyStatus(status([idPlain]));
    await settle();
    clock += 6_000;
    assert(node.calls.length === 2 && link.autoCount() === 1, 'retried after 5 min, then followed');
  }

  // ---- off -----------------------------------------------------------------
  {
    const { link, node } = makeLink({ COPY2_AUTOFOLLOW_MAX: '0' }, [initLog(plain.c0, plain.c1, plain.fee, plain.ts)]);
    link.applyStatus(status([idPlain]));
    await settle();
    assert(node.calls.length === 0 && link.autoCount() === 0, 'COPY2_AUTOFOLLOW_MAX=0: never looks up or follows');
    const b = makeLink({}, [initLog(plain.c0, plain.c1, plain.fee, plain.ts)]);
    b.link.applyStatus({ ok: true, source: 'pool-events', copy2: { pools: {} } });
    await settle();
    assert(b.node.calls.length === 0 && b.link.autoCount() === 0, 'fast check lists nothing (its default, ARBSIM_V4_AUTOFOLLOW=0): nothing happens');
  }
}

main().catch((e) => { console.error('FAIL: crashed', e); process.exitCode = 1; });
