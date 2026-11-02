import { AbiCoder, keccak256 } from 'ethers';
import {
  copy2PoolOf, buildTrackList, coveredPools, outsideAddrsOf, SlipstreamLookup, followFlag, ZERO_ADDR, Copy2Pool, SlipExtras,
} from '../execution/copy2';
import type { PoolState } from '../core/types';

// COPY 2 FOLLOWS MORE POOL TYPES (Nov 2), bot side:
//   - V4 pools WITH a hook (Fables etc.) behind ARBSIM_COPY2_FOLLOW_HOOKED_V4:
//     sent with their hook, which is "watched" (all its events passed on)
//   - Slipstream pools (UP CL / Raphael) behind ARBSIM_COPY2_FOLLOW_UPCL /
//     _RAPHAEL: sent with the contracts their swap reads (watched) and their
//     gauge (reloadOn), looked up from the node (SlipstreamLookup)
//   - flags OFF (the default): exactly the old answers
// No network: a fake node for the lookups.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const AI = '0x00000000000000000000000000000000000000a1';
const USDG = '0x00000000000000000000000000000000000000c2';
const HOOK = '0x594e8e6281edf2d363a0293a50004cf868e7a080';
const UPCL_FACTORY = '0x1ac9db4a2608ba45d6127b1737949b51bb54b7f3';
const SLIP_POOL = '0x1e49a549e9fbbc09e95f7126dce2071511868ade';
const GAUGE = '0xddabc5fc33f359d0c52d783d2091a101ca79e05f';
const SWAP_MOD = '0xa8bdc945be050e451c97f935d7c0d6b0087cf94c';
const UNSTAKED_MOD = '0xbb7a7015fd9744df83d688d5c71c9efe613b976d';
const VOTER = '0x7f749fdd00000000000000000000000000000001';
const DYN = 0x800000;

const v4Id = (c0: string, c1: string, fee: number, ts: number, hooks = ZERO_ADDR) =>
  keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24', 'int24', 'address'], [c0, c1, fee, ts, hooks])).toLowerCase();

const base = { chain: 'robinhood', feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: 1 };
// A Fables pool: native ETH / AI, dynamic fee, spacing 200, hooked.
const fables = (o: Partial<PoolState> = {}): PoolState => ({
  ...base, dex: 'fables', poolType: 'v3', tokenA: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', tokenB: AI,
  poolAddress: v4Id(ZERO_ADDR, AI, DYN, 200, HOOK),
  v4: { fee: DYN, tickSpacing: 200, native: true, poolManager: PM, stateView: PM, hooks: HOOK }, ...o,
} as PoolState);
const upcl = (o: Partial<PoolState> = {}): PoolState => ({
  ...base, dex: 'up-cl', poolType: 'v3', tokenA: USDG, tokenB: AI, poolAddress: SLIP_POOL, ...o,
} as PoolState);

const flags = ['ARBSIM_COPY2_FOLLOW_HOOKED_V4', 'ARBSIM_COPY2_FOLLOW_UPCL', 'ARBSIM_COPY2_FOLLOW_RAPHAEL'];
const setFlags = (on: boolean) => { for (const f of flags) { if (on) process.env[f] = 'on'; else delete process.env[f]; } };

function flagsOff() {
  setFlags(false);
  const f = copy2PoolOf(fables(), PM);
  assert('skip' in f && f.skip === 'V4 pool under another exchange name', 'flag off: a Fables pool is skipped with the old reason');
  const h = copy2PoolOf(fables({ dex: 'uniswap-v4' }), PM);
  assert('skip' in h && h.skip === 'V4 pool with a hook', 'flag off: a hooked uniswap-v4 pool is skipped with the old reason');
  const s = copy2PoolOf(upcl(), PM, new Set(), () => ({ watch: [UPCL_FACTORY], reloadOn: [GAUGE] }));
  assert('skip' in s && s.skip === 'exchange type not followed (up-cl)', 'flag off: an UP CL pool is skipped with the old reason');
  assert(!followFlag('ARBSIM_COPY2_FOLLOW_UPCL'), 'flags default off');
}

function hookedV4() {
  setFlags(true);
  const f = copy2PoolOf(fables(), PM);
  assert('kind' in f && f.kind === 'V4' && f.hooks === HOOK && f.fee === DYN && f.tickSpacing === 200, 'flag on: a Fables pool is followed as V4 with its hook and the dynamic-fee flag');
  assert('kind' in f && JSON.stringify(f.watch) === JSON.stringify([HOOK]) && !f.reloadOn, 'its hook is watched (all its events passed on)');
  assert('kind' in f && f.v4Id === v4Id(ZERO_ADDR, AI, DYN, 200, HOOK) && f.token0 === ZERO_ADDR, 'id = the key WITH the hook; native ETH is currency0');
  const wrongHook = copy2PoolOf(fables({ v4: { fee: DYN, tickSpacing: 200, native: true, poolManager: PM, stateView: PM, hooks: '0x00000000000000000000000000000000000000ee' } }), PM);
  assert('skip' in wrongHook && wrongHook.skip === 'V4 key does not match the pool id', 'a hook that does not give the pool id is refused (never a guess)');
  const otherPm = copy2PoolOf(fables({ v4: { fee: DYN, tickSpacing: 200, native: true, poolManager: '0x00000000000000000000000000000000000000dd', stateView: PM, hooks: HOOK } }), PM);
  assert('skip' in otherPm, 'a hooked pool on another PoolManager is refused');
  // A plain (no hook) pool under another name is still not followed.
  const plainOther = copy2PoolOf(fables({ poolAddress: v4Id(ZERO_ADDR, AI, 3000, 60), v4: { fee: 3000, tickSpacing: 60, native: true, poolManager: PM, stateView: PM } }), PM);
  assert('skip' in plainOther && plainOther.skip === 'V4 pool under another exchange name', 'a hook-free pool under another exchange name: unchanged (skipped)');
  // A hook-free pool may NOT use the dynamic-fee flag.
  const dynNoHook = copy2PoolOf(fables({ dex: 'uniswap-v4', poolAddress: v4Id(ZERO_ADDR, AI, DYN, 200), v4: { fee: DYN, tickSpacing: 200, native: true, poolManager: PM, stateView: PM } }), PM);
  assert('skip' in dynNoHook && dynNoHook.skip === 'V4 fee not a fixed fee', 'dynamic fee without a hook: refused as before');
}

function slipstream() {
  setFlags(true);
  const wait = copy2PoolOf(upcl(), PM, new Set(), () => null);
  assert('skip' in wait && wait.skip === 'Slipstream pool waiting for its factory / gauge lookup', 'flag on, not looked up yet: waits (not followed)');
  const x: SlipExtras = { watch: [UPCL_FACTORY, SWAP_MOD, UNSTAKED_MOD, VOTER], reloadOn: [GAUGE] };
  const p = copy2PoolOf(upcl(), PM, new Set(), () => x);
  assert('kind' in p && p.kind === 'Slipstream' && p.token0 === AI && p.token1 === USDG && p.address === SLIP_POOL, 'flag on: UP CL -> Slipstream, token0 the smaller address');
  assert('kind' in p && p.watch!.length === 4 && p.reloadOn![0] === GAUGE, 'with its watched contracts and its gauge');
  const bad = copy2PoolOf(upcl(), PM, new Set(), () => ({ watch: [], reloadOn: [], bad: 'Slipstream pool from another factory' }));
  assert('skip' in bad && bad.skip === 'Slipstream pool from another factory', 'a pool of another factory is refused');
  const shape = copy2PoolOf(upcl({ variant: 'algebra' }), PM, new Set(), () => x);
  assert('skip' in shape, 'shape must match (v3, no variant)');
  delete process.env.ARBSIM_COPY2_FOLLOW_UPCL;
  const off = copy2PoolOf(upcl(), PM, new Set(), () => x);
  assert('skip' in off, 'its own flag: UPCL off = not followed even with RAPHAEL on');
  const raph = copy2PoolOf(upcl({ dex: 'raphael-cl' }), PM, new Set(), () => x);
  assert('kind' in raph && raph.kind === 'Slipstream', 'Raphael has its own flag (on here)');
  setFlags(true);
  // Track list and coverage: a pool is sent only when every outside contract is subscribed.
  const list = buildTrackList([fables(), upcl()], PM, new Set(), () => x).pools;
  assert(list.length === 2, 'both kinds in the track list');
  const outs = outsideAddrsOf(list);
  assert(outs.includes(HOOK) && outs.includes(GAUGE) && outs.includes(UPCL_FACTORY) && outs.length === 6, 'outside contracts = hook + factory + 2 modules + voter + gauge');
  const full = { pools: new Set([SLIP_POOL, ...outs]), ids: new Set([list.find((q) => q.kind === 'V4')!.v4Id!]), transferPools: new Set([SLIP_POOL]), coins: new Set([AI, USDG]) };
  assert(coveredPools(list, full).length === 2, 'all subscribed: both covered');
  const noGauge = { ...full, pools: new Set([...full.pools].filter((a) => a !== GAUGE)) };
  assert(coveredPools(list, noGauge).length === 1 && coveredPools(list, noGauge)[0].kind === 'V4', 'gauge not subscribed yet: that Slipstream pool waits');
  const noHook = { ...full, pools: new Set([...full.pools].filter((a) => a !== HOOK)) };
  assert(coveredPools(list, noHook).every((q: Copy2Pool) => q.kind !== 'V4'), 'hook not subscribed yet: the hooked pool waits');
}

async function lookup() {
  const word = (a: string) => '0x' + '0'.repeat(24) + a.slice(2);
  const answers: Record<string, string> = {};
  const sel = (sig: string) => keccak256(new TextEncoder().encode(sig)).slice(0, 10);
  answers[SLIP_POOL + sel('factory()')] = word(UPCL_FACTORY);
  answers[SLIP_POOL + sel('gauge()')] = word(GAUGE);
  answers[UPCL_FACTORY + sel('swapFeeModule()')] = word(SWAP_MOD);
  answers[UPCL_FACTORY + sel('unstakedFeeModule()')] = word(UNSTAKED_MOD);
  answers[UPCL_FACTORY + sel('voter()')] = word(VOTER);
  let calls = 0;
  const rpc = async (method: string, params: any[]) => {
    calls++;
    if (method !== 'eth_call') throw new Error('unexpected');
    return answers[params[0].to.toLowerCase() + params[0].data] ?? '0x';
  };
  let t = 1_000_000;
  const l = new SlipstreamLookup(() => rpc, () => t);
  assert(l.get(SLIP_POOL, 'up-cl') === null, 'first ask: not known yet (lookup started)');
  await new Promise((r) => setTimeout(r, 10));
  const x = l.get(SLIP_POOL, 'up-cl');
  assert(!!x && x.watch.join() === [UPCL_FACTORY, SWAP_MOD, UNSTAKED_MOD, VOTER].join() && x.reloadOn.join() === GAUGE, 'looked up: factory + swap fee module + unstaked fee module + voter watched; gauge reloads');
  const n = calls;
  t += 300_000;
  l.get(SLIP_POOL, 'up-cl');
  await new Promise((r) => setTimeout(r, 10));
  assert(calls === n, 'fresh for 10 minutes (no new node call)');
  t += 400_000;
  l.get(SLIP_POOL, 'up-cl');
  await new Promise((r) => setTimeout(r, 10));
  assert(calls === n + 5, 'after 10 minutes the pool and its factory are looked at again (2 + 3 calls)');
  // A pool of another factory is refused.
  answers[SLIP_POOL + sel('factory()')] = word('0x00000000000000000000000000000000000000ff');
  const l2 = new SlipstreamLookup(() => rpc, () => t);
  l2.get(SLIP_POOL, 'up-cl');
  await new Promise((r) => setTimeout(r, 10));
  assert(l2.get(SLIP_POOL, 'up-cl')?.bad === 'Slipstream pool from another factory', 'another factory: refused');
  // No gauge: nothing reloads it, looked at again after a minute.
  answers[SLIP_POOL + sel('factory()')] = word(UPCL_FACTORY);
  answers[SLIP_POOL + sel('gauge()')] = word(ZERO_ADDR);
  const l3 = new SlipstreamLookup(() => rpc, () => t);
  l3.get(SLIP_POOL, 'up-cl');
  await new Promise((r) => setTimeout(r, 10));
  assert(l3.get(SLIP_POOL, 'up-cl')?.reloadOn.length === 0 && l3.counts.noGauge === 1, 'no gauge: reloadOn empty (counted)');
  const c3 = calls;
  t += 61_000;
  l3.get(SLIP_POOL, 'up-cl');
  await new Promise((r) => setTimeout(r, 10));
  assert(calls > c3, 'a pool without a gauge is looked at again after a minute');
  // Node trouble: no answer, nothing followed.
  const l4 = new SlipstreamLookup(() => async () => { throw new Error('down'); }, () => t);
  l4.get(SLIP_POOL, 'up-cl');
  await new Promise((r) => setTimeout(r, 10));
  assert(l4.get(SLIP_POOL, 'up-cl') === null && l4.counts.failed === 1, 'node error: still unknown (not followed), counted');
}

(async () => {
  flagsOff();
  hookedV4();
  slipstream();
  await lookup();
  setFlags(false);
})();
