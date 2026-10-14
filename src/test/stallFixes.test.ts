// Tests for the stall fixes (Oct 14): the chunked versions of the big jobs
// must give EXACTLY the same result as the old one-go versions, and must
// let other work run in between (that is the whole point).
//   - runSteps / drainSteps (core/chunked.ts)
//   - loop extra-pool pick from the compact scan index == pickScanCandidates
//   - selectLoopPools in bites == selectLoopPools in one go
//   - chain-wide pool list (stateToPools) in bites == in one go
//   - big JSON saves in pieces == JSON.stringify, byte for byte
//   - a LoopExtraPools rebuild picks the same pools with the fix on and off
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ethers } from 'ethers';
import { drainSteps, runSteps, writeJsonChunked, writeJsonChunkedQueued, jsonPieces, Steps } from '../core/chunked';
import {
  pickScanCandidates, pickScanCandidatesIndexedSteps, buildScanIndexSteps, scanIndexFresh, scanPairCountFromIndex,
  selectLoopPools, selectLoopPoolsSteps, LoopExtraPools, LoopExtraDeps, loopExtraConfigFromEnv,
} from '../core/loopExtraPools';
import { loopConfigFromEnv } from '../core/loopTrader';
import { stateToPools, stateToPoolsSteps, scanPoolRefs, ScanState } from '../core/universeScan';
import type { PoolState } from '../core/types';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// Small repeatable random numbers (same every run).
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const hex40 = (r: () => number) => { let h = ''; for (let i = 0; i < 40; i++) h += '0123456789abcdef'[Math.floor(r() * 16)]; return h; };
// Checksum (mixed-case) address like the scan stores, or lower case.
const addr = (r: () => number, mixed: boolean) => (mixed ? ethers.getAddress('0x' + hex40(r)) : '0x' + hex40(r));

// A random scan state: a few hundred coins, a few thousand pools, a few
// pairs on 2+ pools, some V4 rows and broken pool ids (both skipped).
function randomState(seed: number, opts: { upperToken?: boolean; dupToken?: boolean } = {}) {
  const r = rng(seed);
  const T = 40 + Math.floor(r() * 300);
  const tokens: string[] = [];
  for (let i = 0; i < T; i++) tokens.push(addr(r, false));
  if (opts.upperToken) tokens[5] = tokens[5].toUpperCase().replace('0X', '0x');
  if (opts.dupToken) tokens.push(tokens[7]);   // same coin listed twice
  const factories = ['uniswap-v2|v2|0xf1', 'uniswap-v3|v3|0xf2', 'uniswap-v4|v4|0xf3', 'aero|solidly|0xf4'];
  const pools: Array<[number, string, number, number]> = [];
  const P = 200 + Math.floor(r() * 3000);
  // Coins 0 and 1 are the bases (WETH/USDG); most pools touch them, like memecoins do.
  for (let i = 0; i < P; i++) {
    const fi = Math.floor(r() * factories.length);
    const a = r() < 0.6 ? Math.floor(r() * 2) : Math.floor(r() * tokens.length);
    let b = Math.floor(r() * tokens.length);
    if (r() < 0.02) b = a;                      // a pool with the same coin twice (skipped)
    const pool = r() < 0.02 ? '0x' + hex40(r) + hex40(r).slice(0, 24) : addr(r, r() < 0.7);
    pools.push([fi, pool, r() < 0.5 ? a : b, r() < 0.5 ? b : a]);
  }
  // A few pairs on 2+ pools.
  for (let i = 0; i < 20; i++) { const row = pools[Math.floor(r() * pools.length)]; pools.push([0, addr(r, true), row[3], row[2]]); }
  const state: ScanState = { version: 1, lastBlock: { '0xf1': 123 }, tokens, pools, factories };
  return { state, r };
}

const lc = (s: string) => s.toLowerCase();
const pairKey = (a: string, b: string) => [lc(a), lc(b)].sort().join('/');
const poolOf = (pool: string, a: string, b: string): PoolState => ({ chain: 'robinhood', dex: 'uniswap-v2', poolAddress: pool, poolType: 'v2', tokenA: a, tokenB: b,
  reserveA: 10n ** 24n, reserveB: 10n ** 24n, feeBps: 30, lastUpdatedBlock: 1, lastUpdatedMs: 1 } as PoolState);

async function main() {
  // ---------------------------------------------------------------------------
  // 1) runSteps gives the same answer as drainSteps, and lets timers run
  // ---------------------------------------------------------------------------
  {
    function* job(n: number): Steps<number> {
      let s = 0;
      for (let i = 0; i < n; i++) { if ((i & 1023) === 1023) yield; s = (s + Math.sqrt(i) * 7) % 1_000_003; }
      return s;
    }
    const n = 3_000_000;
    const t0 = performance.now();
    const one = drainSteps(job(n));
    const oneMs = performance.now() - t0;
    let ticks = 0;
    const iv = setInterval(() => { ticks++; }, 1);
    let imm = 0;
    const spin = () => { imm++; if (imm < 1e6) setImmediate(spin); };
    setImmediate(spin);
    const chunked = await runSteps(job(n), 'test job', 5);
    clearInterval(iv);
    const turns = imm;
    imm = 1e6;   // stop the spinner
    assert(chunked === one, 'runSteps result == drainSteps result');
    assert(turns > 2 || oneMs < 10, `other work ran between bites (${turns} turns while a ${Math.round(oneMs)} ms job ran)`);
  }

  // ---------------------------------------------------------------------------
  // 2) Extra-pool pick: compact index == old pickScanCandidates
  // ---------------------------------------------------------------------------
  {
    let same = 0, total = 0, nonEmpty = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { state, r } = randomState(seed * 7919, { upperToken: seed % 5 === 0, dupToken: seed % 7 === 0 });
      const T = state.tokens;
      const bases = [T[0], T[1]];
      // Coin map: a few deep pools we "already price" around the bases.
      const graphPools: PoolState[] = [];
      for (let i = 0; i < 25; i++) { const a = T[Math.floor(r() * T.length)], b = r() < 0.5 ? T[Math.floor(r() * 2)] : T[Math.floor(r() * T.length)]; if (a !== b) graphPools.push(poolOf(addr(r, false), a, b)); }
      const knownPairs = new Set<string>(graphPools.map((p) => pairKey(p.tokenA, p.tokenB)));
      for (let i = 0; i < 10; i++) { const row = state.pools[Math.floor(r() * state.pools.length)]; knownPairs.add(pairKey(T[row[2]], T[row[3]])); }
      const rivalPools = new Set<string>();
      for (let i = 0; i < 5; i++) rivalPools.add(lc(state.pools[Math.floor(r() * state.pools.length)][1]));
      const skipSet = new Set<string>();
      for (let i = 0; i < 30; i++) skipSet.add(lc(state.pools[Math.floor(r() * state.pools.length)][1]));
      const idx = drainSteps(buildScanIndexSteps(state));
      for (const L of [3, 4, 5, 8]) for (const max of [5, 50, 100_000]) {
        const inp = { bases, loopMaxPools: L, graphPools, knownPairs, skip: (k: string) => skipSet.has(k), rivalPools, max };
        const oldOut = pickScanCandidates({ ...inp, scanPools: scanPoolRefs(state) });
        const newOut = drainSteps(pickScanCandidatesIndexedSteps({ ...inp, index: idx }));
        total++;
        if (oldOut.length) nonEmpty++;
        if (JSON.stringify(oldOut) === JSON.stringify(newOut)) same++;
        else if (same + 1 === total) console.error(`  first difference: seed ${seed}, L ${L}, max ${max}: old ${oldOut.length}, new ${newOut.length}`);
      }
      // Pair counts used by the selection: same "more than one?" answer.
      const count = new Map<string, number>();
      for (const p of scanPoolRefs(state)) { const k = pairKey(p.token0, p.token1); count.set(k, (count.get(k) ?? 0) + 1); }
      let countsOk = true;
      for (const [k, c] of count) if ((scanPairCountFromIndex(idx, k) > 1) !== (c > 1) || (c > 1 && scanPairCountFromIndex(idx, k) !== c)) countsOk = false;
      if (!countsOk) { assert(false, `seed ${seed}: index pair counts differ from a full count`); break; }
    }
    assert(same === total && nonEmpty > total / 2, `extra-pool pick from the index == old pick (${same}/${total} cases, ${nonEmpty} with candidates)`);
    // In bites, with other work in between: still the same.
    const { state } = randomState(424242);
    const idx = await runSteps(buildScanIndexSteps(state), 'test index', 0.05);
    const inp = { bases: [state.tokens[0], state.tokens[1]], loopMaxPools: 5, graphPools: [poolOf('0x' + 'a'.repeat(40), state.tokens[0], state.tokens[2]), poolOf('0x' + 'b'.repeat(40), state.tokens[2], state.tokens[1])], knownPairs: new Set<string>(), skip: () => false, max: 10_000 };
    const a = pickScanCandidates({ ...inp, scanPools: scanPoolRefs(state) });
    const b = await runSteps(pickScanCandidatesIndexedSteps({ ...inp, index: idx }), 'test pick', 0.05);
    assert(JSON.stringify(a) === JSON.stringify(b) && a.length > 0, `index pick run in tiny bites == old pick (${a.length} candidates)`);
    // Index freshness: a new pool in the scan means rebuild.
    assert(scanIndexFresh(idx, state), 'index is fresh for its own scan state');
    state.pools.push([0, '0x' + 'c'.repeat(40), 3, 4]);
    assert(!scanIndexFresh(idx, state), 'index is stale after the scan adds a pool');
  }

  // ---------------------------------------------------------------------------
  // 3) selectLoopPools in bites == in one go
  // ---------------------------------------------------------------------------
  {
    let ok = 0, total = 0;
    for (let seed = 1; seed <= 15; seed++) {
      const r = rng(seed * 104729);
      const coins: string[] = [];
      for (let i = 0; i < 60; i++) coins.push(addr(r, false));
      const mk = () => { const a = coins[Math.floor(r() * coins.length)], b = r() < 0.4 ? coins[Math.floor(r() * 2)] : coins[Math.floor(r() * coins.length)]; return poolOf(addr(r, true), a, b); };
      const watched: PoolState[] = [];
      for (let i = 0; i < 20; i++) watched.push(mk());
      const others: PoolState[] = [];
      for (let i = 0; i < 400; i++) others.push(mk());
      const depth = new Map<PoolState, number>();
      for (const p of [...watched, ...others]) depth.set(p, Math.floor(r() * 100_000));
      const rivalPools = new Set([lc(others[3].poolAddress), lc(others[9].poolAddress)]);
      for (const L of [3, 5]) {
        const inp = { bases: [coins[0], coins[1]], loopMaxPools: L, cap: 30, minDepthUsd: 10_000, watched, others, depthUsd: (p: PoolState) => depth.get(p) ?? null, rivalPools, scanPairCount: (k: string) => (k.charCodeAt(5) % 7 === 0 ? 2 : 1) };
        const a = selectLoopPools(inp);
        const b = await runSteps(selectLoopPoolsSteps(inp), 'test select', 0.05);
        total++;
        if (JSON.stringify({ ...a, selected: a.selected.map((p) => p.poolAddress) }) === JSON.stringify({ ...b, selected: b.selected.map((p) => p.poolAddress) })) ok++;
      }
    }
    assert(ok === total, `selectLoopPools in bites == in one go (${ok}/${total})`);
  }

  // ---------------------------------------------------------------------------
  // 4) Chain-wide pool list in bites == in one go
  // ---------------------------------------------------------------------------
  {
    const { state } = randomState(99);
    const a = stateToPools(state);
    const b = await runSteps(stateToPoolsSteps(state), 'test list', 0.05);
    assert(a.length > 0 && JSON.stringify(a) === JSON.stringify(b), `stateToPools in bites == in one go (${a.length} pools)`);
    assert(a.every((p) => p.kind !== ('v4' as any) && p.pool.length === 42), 'V4 rows and broken pool ids still skipped');
  }

  // ---------------------------------------------------------------------------
  // 5) Big JSON saves in pieces == JSON.stringify, byte for byte; and yield
  // ---------------------------------------------------------------------------
  {
    const dir = mkdtempSync(join(tmpdir(), 'stallfix-'));
    // Scan-state-like: big arrays one level down.
    const big: ScanState = { version: 1, lastBlock: { a: 1, b: 2 }, tokens: [], pools: [], factories: ['x|v2|0x1'] };
    for (let i = 0; i < 60_000; i++) big.tokens.push('0x' + i.toString(16).padStart(40, '0'));
    for (let i = 0; i < 120_000; i++) big.pools.push([0, '0x' + (i * 7).toString(16).padStart(40, '0'), i % 60_000, (i * 3) % 60_000]);
    const f1 = join(dir, 'scan.json');
    let turns = 0;
    let stop = false;
    const spin = () => { turns++; if (!stop) setImmediate(spin); };
    setImmediate(spin);
    await writeJsonChunked(f1, big, 'test save', 2);
    stop = true;
    assert(readFileSync(f1, 'utf8') === JSON.stringify(big), 'scan file written in pieces == JSON.stringify (byte for byte)');
    assert(!existsSync(f1 + '.tmp'), 'temp file renamed away (atomic save)');
    assert(turns > 2, `other work ran during the save (${turns} turns)`);
    // Odd values follow JSON.stringify's rules exactly.
    const odd: any = { a: undefined, b: () => 1, c: null, d: [1, undefined, () => 2, 'x'], e: new Date(0), f: { g: [1, 2], h: undefined }, list: Array.from({ length: 2_500 }, (_, i) => (i % 3 ? { i, u: undefined } : undefined)), s: 'quote " and \\ slash', n: NaN };
    assert(Array.from(jsonPieces(odd)).join('') === JSON.stringify(odd), 'pieces == JSON.stringify for undefined / functions / dates / NaN / nested');
    const arr = Array.from({ length: 5_000 }, (_, i) => [i, `p${i}`]);
    assert(Array.from(jsonPieces(arr)).join('') === JSON.stringify(arr), 'pieces == JSON.stringify for a big top-level list');
    // Two saves of the same file at once: one after the other, last one wins.
    const f2 = join(dir, 'q.json');
    await Promise.all([writeJsonChunkedQueued(f2, { v: 1, list: big.pools.slice(0, 5_000) }), writeJsonChunkedQueued(f2, { v: 2 })]);
    assert(readFileSync(f2, 'utf8') === JSON.stringify({ v: 2 }), 'queued saves of one file run in order (no clash on the temp file)');
  }

  // ---------------------------------------------------------------------------
  // 6) A whole LoopExtraPools rebuild: fix on (index, bites) == fix off
  // ---------------------------------------------------------------------------
  {
    const { state, r } = randomState(31337);
    const T = state.tokens;
    const W = T[0], U = T[1];
    // Cache: a few watched pools and single pools we already price.
    const cache = new Map<string, PoolState>();
    const watchedPairs: string[][] = [];
    for (let i = 0; i < 6; i++) {
      const a = poolOf(addr(r, false), W, T[2 + i]), b = poolOf(addr(r, false), W, T[2 + i]);
      cache.set(lc(a.poolAddress), a); cache.set(lc(b.poolAddress), b);
      watchedPairs.push([a.poolAddress, b.poolAddress]);
    }
    const usdg = poolOf(addr(r, false), U, W); const usdg2 = poolOf(addr(r, false), U, W);
    cache.set(lc(usdg.poolAddress), usdg); cache.set(lc(usdg2.poolAddress), usdg2);
    watchedPairs.push([usdg.poolAddress, usdg2.poolAddress]);
    for (let i = 0; i < 80; i++) { const p = poolOf(addr(r, false), T[2 + Math.floor(r() * 30)], T[2 + Math.floor(r() * 30)]); if (p.tokenA !== p.tokenB) cache.set(lc(p.poolAddress), p); }
    const lookups: string[][] = [];
    const mkDeps = (withState: boolean): LoopExtraDeps => ({
      bases: [W, U],
      getPool: (k) => cache.get(lc(k)),
      cachePools: () => [...cache.values()],
      watchedPools: () => watchedPairs,
      scanPools: () => scanPoolRefs(state),
      scanState: withState ? () => state : undefined,
      depthUsd: () => 50_000,
      usdOf: (t) => (t === W || t === U ? 1 : null),
      decimalsOf: () => 18,
      rivalPools: () => new Set([lc(state.pools[10][1])]),
      // Every balance check says "plenty of money".
      callMany: async (calls) => calls.map(() => '0x' + (10n ** 24n).toString(16).padStart(64, '0')),
      lookupPair: async (a, b) => { lookups.push([a, b]); return []; },
      readStates: async (pools) => pools,
      writeState: () => true,
      now: () => 1_000_000,
      log: (m) => console.log('  ' + m),
    });
    const base = loopExtraConfigFromEnv({ LOOP_TRADER: '1' }, loopConfigFromEnv({ LOOP_TRADER: '1' }), 10_000);
    const off = new LoopExtraPools({ ...base, chunked: false }, mkDeps(false));
    await off.rebuild('test', true);
    const offLookups = lookups.splice(0).map((x) => x.join('/')).sort();
    const on = new LoopExtraPools({ ...base, chunked: true }, mkDeps(true));
    await on.rebuild('test', true);
    const onLookups = lookups.splice(0).map((x) => x.join('/')).sort();
    assert(base.chunked === true, 'STALL_FIX_EXTRA_PICK is on by default');
    assert(loopExtraConfigFromEnv({ LOOP_TRADER: '1', STALL_FIX_EXTRA_PICK: '0' }, loopConfigFromEnv({ LOOP_TRADER: '1' }), 10_000).chunked === false, 'STALL_FIX_EXTRA_PICK=0 turns it off');
    assert(JSON.stringify(on.keys().sort()) === JSON.stringify(off.keys().sort()), `rebuild: same pools selected with the fix on and off (${on.size()})`);
    assert(JSON.stringify(on.last) === JSON.stringify(off.last), 'rebuild: same counts (balance checks, lookups, reachable)');
    assert(JSON.stringify(onLookups) === JSON.stringify(offLookups) && onLookups.length > 0, `rebuild: same pairs looked up (${onLookups.length})`);
  }
}

main().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; });
