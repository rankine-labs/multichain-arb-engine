import { ethers } from 'ethers';
import { PoolState } from './types';
import { hasExactMath } from './loopFinder';
import { Steps, drainSteps, runSteps } from './chunked';
import { timed } from './stallFinder';

// ============================================================================
// LOOP EXTRA POOLS -- keep single-pool coin pairs fresh, for the loop trader
//
// Plain English:
//   The bot only keeps prices fresh for coin pairs that sit on 2+ pools,
//   because a 2-pool trade needs two pools. Pairs on just ONE pool (e.g.
//   DJT/PONS) were remembered but never updated, so the loop finder could not
//   use them, and loops such as WETH -> DJT -> PONS -> USDG -> WETH (what the
//   rival bot 0xd7572f wins with) were invisible.
//
//   This file picks a few hundred of those single pools ("extra pools") and
//   keeps them fresh, for the LOOP FINDER ONLY:
//     1. PICK: a single pool is picked when it has real money in it
//        (POOL_MIN_DEPTH_USD, $10k) and both of its coins can be reached from
//        WETH/USDG so that the pool can sit on a loop of 3 to LOOP_MAX_POOLS pools. Pools used by
//        rival loop trades come first, then the deepest. At most
//        LOOP_EXTRA_POOLS_MAX (300).
//     2. FIND NEW ONES: the chain-wide scan knows every pool on the chain but
//        not how much money is in it. Promising single pools from the scan get
//        one cheap balance read each, and the ones with money are looked up
//        properly (exact price, fee and coin decimals), a few dozen per round.
//     3. KEEP FRESH: picked pools are added to the block reader's list, so
//        every trade on them updates the price straight from the block (no
//        extra node requests: the reader already fetches every block's events
//        and keeps ours). A bundled re-read every 20 s (1-2 requests) keeps
//        quiet pools counted as fresh and corrects any drift; it never writes
//        over newer block-reader data.
//     4. The selection is rebuilt every 10 minutes and after each chain-wide
//        scan.
//
//   Extra pools are NEVER added to the pair watcher's watch list, so the
//   2-pool gap scanner and the back-run planner never see them. Only the loop
//   finder gets them.
//
// Switch: on only when LOOP_TRADER=1 (LOOP_EXTRA_POOLS=0 forces it off).
// With LOOP_TRADER unset nothing in this file is ever created.
// ============================================================================

const lc = (s: string) => s.toLowerCase();
const pairKey = (a: string, b: string) => [lc(a), lc(b)].sort().join('/');

// ----------------------------------------------------------------------------
// Settings
// ----------------------------------------------------------------------------
export interface LoopExtraConfig {
  enabled: boolean;          // LOOP_TRADER=1 and LOOP_EXTRA_POOLS not 0
  maxSelected: number;       // LOOP_EXTRA_POOLS_MAX (default 300)
  minDepthUsd: number;       // POOL_MIN_DEPTH_USD (default $10,000), same bar as everywhere else
  loopMaxPools: number;      // LOOP_MAX_POOLS (3-8): longest loop a pool must fit on
  rebuildMs: number;         // rebuild the selection this often (10 min)
  minRebuildGapMs: number;   // ...and never twice within this (1 min), even after a scan
  refreshMs: number;         // LOOP_EXTRA_REFRESH_MS: bundled re-read of picked pools (default 20 s, 0 = off)
  lookupsPerRound: number;   // LOOP_EXTRA_LOOKUPS: new single pools looked up per rebuild (default 40)
  balanceChecksPerRound: number; // scan pools given a cheap balance read per rebuild (5,000 = ~13 bundled requests)
  // STALL_FIX_EXTRA_PICK (default on): do the pick in ~5 ms bites from a
  // compact scan index, so it never freezes the bot. Same pools picked.
  // Left out (old tests) = off.
  chunked?: boolean;
}

const num = (raw: string | undefined, dflt: number, min: number, max: number): number => {
  if (raw === undefined || raw.trim() === '') return dflt;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;
};

// loop: the loop trader's own settings (core/loopTrader.ts loopConfigFromEnv).
export function loopExtraConfigFromEnv(
  env: Record<string, string | undefined>,
  loop: { enabled: boolean; maxPools: number; maxPoolAgeMs: number },
  minDepthUsd: number,
): LoopExtraConfig {
  const off = env.LOOP_EXTRA_POOLS === '0' || env.LOOP_EXTRA_POOLS === 'false';
  // Re-read a bit faster than the loop finder's age limit, so a quiet pool
  // never drops out between two re-reads (30 s limit -> every 20 s).
  const dfltRefresh = Math.max(5_000, Math.min(20_000, Math.floor(loop.maxPoolAgeMs * 2 / 3)));
  return {
    enabled: loop.enabled && !off,
    maxSelected: Math.round(num(env.LOOP_EXTRA_POOLS_MAX, 300, 0, 2_000)),
    minDepthUsd,
    loopMaxPools: loop.maxPools,
    rebuildMs: 10 * 60_000,
    minRebuildGapMs: 60_000,
    refreshMs: Math.round(num(env.LOOP_EXTRA_REFRESH_MS, dfltRefresh, 0, 600_000)),
    lookupsPerRound: Math.round(num(env.LOOP_EXTRA_LOOKUPS, 40, 0, 500)),
    balanceChecksPerRound: 5_000,
    chunked: env.STALL_FIX_EXTRA_PICK !== '0' && env.STALL_FIX_EXTRA_PICK !== 'off',
  };
}

// ----------------------------------------------------------------------------
// Coin map helpers (coins = dots, pools = lines)
// ----------------------------------------------------------------------------
type Adj = Map<string, { other: string; pool: string }[]>;

function buildAdj(pools: { pool: string; a: string; b: string }[]): Adj {
  const adj: Adj = new Map();
  for (const p of pools) {
    if (p.a === p.b) continue;
    (adj.get(p.a) ?? adj.set(p.a, []).get(p.a)!).push({ other: p.b, pool: p.pool });
    (adj.get(p.b) ?? adj.set(p.b, []).get(p.b)!).push({ other: p.a, pool: p.pool });
  }
  return adj;
}

// Fewest pools from `start` to every coin, up to `limit` pools. `skipPool`:
// pretend this pool doesn't exist (so a pool can't be its own way back).
function hops(adj: Adj, start: string, limit: number, skipPool?: string): Map<string, number> {
  const dist = new Map<string, number>([[start, 0]]);
  let frontier = [start];
  for (let d = 1; d <= limit && frontier.length; d++) {
    const next: string[] = [];
    for (const t of frontier) for (const e of adj.get(t) ?? []) {
      if (e.pool === skipPool || dist.has(e.other)) continue;
      dist.set(e.other, d);
      next.push(e.other);
    }
    frontier = next;
  }
  return dist;
}

const edgeOf = (p: PoolState) => ({ pool: lc(p.poolAddress), a: lc(p.tokenA), b: lc(p.tokenB) });

// ----------------------------------------------------------------------------
// 1) Which single pools to keep fresh (pure: no node requests)
// ----------------------------------------------------------------------------
export interface SelectInput {
  bases: string[];
  loopMaxPools: number;
  cap: number;
  minDepthUsd: number;
  watched: PoolState[];                    // pools of watched pairs (the gap scanner's pools)
  others: PoolState[];                     // every other pool we have a price for (the cache)
  depthUsd: (p: PoolState) => number | null;
  rivalPools?: Set<string>;                // pools seen in rival loop trades (lower-case)
  scanPairCount?: (pairKey: string) => number; // pools the chain-wide scan knows for a pair
}

export interface SelectOutput {
  selected: PoolState[];
  deepSingles: number;   // single pools with enough money (before the reach test)
  reachable: number;     // ...of which can sit on a loop of 3 to LOOP_MAX_POOLS pools
  rivalPicked: number;   // picked pools that a rival loop used
}

export function selectLoopPools(inp: SelectInput): SelectOutput {
  return drainSteps(selectLoopPoolsSteps(inp));
}

// The same pick as selectLoopPools(), written as steps (core/chunked.ts):
// `yield` marks safe places for a break, so the rebuild can run it in ~5 ms
// bites with runSteps(). Same code, so the same pools are picked.
export function* selectLoopPoolsSteps(inp: SelectInput): Steps<SelectOutput> {
  const L = inp.loopMaxPools;
  const rival = inp.rivalPools ?? new Set<string>();
  const watchedKeys = new Set(inp.watched.map((p) => lc(p.poolAddress)));
  const watchedPairs = new Set(inp.watched.map((p) => pairKey(p.tokenA, p.tokenB)));
  const deepOk = (p: PoolState) => { const d = inp.depthUsd(p); return d !== null && d >= inp.minDepthUsd; };
  const usable = (p: PoolState) => hasExactMath(p) && deepOk(p);

  // How many pools we know per pair outside the watch list (a "single" pair has exactly one).
  const perPair = new Map<string, number>();
  const others = inp.others.filter((p) => !watchedKeys.has(lc(p.poolAddress)));
  yield;
  for (let i = 0; i < others.length; i++) {
    if ((i & 1023) === 1023) yield;
    const p = others[i];
    const k = pairKey(p.tokenA, p.tokenB); perPair.set(k, (perPair.get(k) ?? 0) + 1);
  }

  const singles: PoolState[] = [];
  const seen = new Set<string>();
  let step = 0;
  for (const p of others) {
    if ((++step & 255) === 255) yield;
    const k = lc(p.poolAddress), pk = pairKey(p.tokenA, p.tokenB);
    if (seen.has(k) || lc(p.tokenA) === lc(p.tokenB)) continue;
    if (watchedPairs.has(pk)) continue;                         // pair already watched: not ours
    if ((perPair.get(pk) ?? 0) !== 1) continue;                 // 2+ pools known: belongs to the pair watcher
    if ((inp.scanPairCount?.(pk) ?? 0) > 1) continue;           // the scan saw 2+ pools: same
    if (!usable(p)) continue;                                   // no exact maths or too little money
    seen.add(k);
    singles.push(p);
  }

  // Coin map: deep watched pools + deep single pools.
  const adj = buildAdj([...inp.watched.filter(usable), ...singles].map(edgeOf));
  const bases = inp.bases.map(lc);
  const dist = bases.map((b) => hops(adj, b, L));

  // Can this pool sit on a loop of at most L pools through a base coin?
  // base -> ... -> coin A -> (this pool) -> coin B -> ... -> base.
  const fits = (p: PoolState): boolean => {
    const e = edgeOf(p);
    for (let i = 0; i < bases.length; i++) {
      const da = dist[i].get(e.a), db = dist[i].get(e.b);
      if (da === undefined || db === undefined || da + db + 1 > L) continue; // quick "no"
      // Exact "yes": the way back must not use this same pool.
      const dx = hops(adj, bases[i], L - 1, e.pool);
      const xa = dx.get(e.a), xb = dx.get(e.b);
      if (xa !== undefined && xb !== undefined && xa + xb + 1 <= L) return true;
    }
    return false;
  };
  // (Each "fits" test can walk the coin map, so take a break every 16.)
  yield;
  const reach: PoolState[] = [];
  for (let i = 0; i < singles.length; i++) {
    if ((i & 15) === 15) yield;
    if (fits(singles[i])) reach.push(singles[i]);
  }
  yield;

  // Rival coins: coins of pools the rival loops went through (not WETH/USDG,
  // which are on every loop).
  const rivalTokens = new Set<string>();
  for (const p of [...inp.watched, ...inp.others]) if (rival.has(lc(p.poolAddress))) { rivalTokens.add(lc(p.tokenA)); rivalTokens.add(lc(p.tokenB)); }
  yield;
  for (const b of bases) rivalTokens.delete(b);
  const score = (p: PoolState) => (rival.has(lc(p.poolAddress)) ? 4 : 0) + (rivalTokens.has(lc(p.tokenA)) ? 1 : 0) + (rivalTokens.has(lc(p.tokenB)) ? 1 : 0);
  const depth = new Map(reach.map((p) => [p, inp.depthUsd(p) ?? 0] as [PoolState, number]));
  reach.sort((x, y) => score(y) - score(x) || depth.get(y)! - depth.get(x)!);
  const selected = reach.slice(0, Math.max(0, inp.cap));
  return { selected, deepSingles: singles.length, reachable: reach.length, rivalPicked: selected.filter((p) => rival.has(lc(p.poolAddress))).length };
}

// ----------------------------------------------------------------------------
// 2) Which pools from the chain-wide scan are worth a look (pure)
// ----------------------------------------------------------------------------
export interface ScanPoolRef { pool: string; token0: string; token1: string }

export interface ScanPickInput {
  bases: string[];
  loopMaxPools: number;
  scanPools: Iterable<ScanPoolRef>;  // looped over twice (a list, or the scan state's live view)
  graphPools: PoolState[];          // deep pools we already price (watched + deep cached)
  knownPairs: Set<string>;          // pairs that already have a pool in the cache / watch list
  skip: (pool: string) => boolean;  // looked at recently (no money, or already looked up)
  rivalPools?: Set<string>;
  max: number;
}

// Returns scan pools, best first:
//   tier 0: used by a rival loop trade;
//   tier 1: both coins already on our coin map, close enough to fit a loop;
//   tier 2: a coin NOT on our map yet that joins two coins on the map
//           (e.g. PONS between DJT and USDG): both of its pools are looked at.
// Only pairs the scan saw on exactly one pool.
export function pickScanCandidates(inp: ScanPickInput): (ScanPoolRef & { tier: number })[] {
  const L = inp.loopMaxPools;
  const rival = inp.rivalPools ?? new Set<string>();
  const count = new Map<string, number>();
  for (const p of inp.scanPools) { const k = pairKey(p.token0, p.token1); count.set(k, (count.get(k) ?? 0) + 1); }
  const adj = buildAdj(inp.graphPools.map(edgeOf));
  const bases = inp.bases.map(lc);
  const dist = bases.map((b) => hops(adj, b, L));
  const best = (t: string): number[] => dist.map((d) => d.get(t) ?? Infinity);

  const out: (ScanPoolRef & { tier: number; rank: number })[] = [];
  // tier 2 bookkeeping: off-map coin -> its pools to on-map coins
  const bridge = new Map<string, { ref: ScanPoolRef; nd: number[] }[]>();
  for (const p of inp.scanPools) {
    const a = lc(p.token0), b = lc(p.token1), k = pairKey(a, b);
    if (a === b || count.get(k) !== 1 || inp.knownPairs.has(k) || inp.skip(lc(p.pool))) continue;
    if (rival.has(lc(p.pool))) { out.push({ ...p, tier: 0, rank: 0 }); continue; }
    const da = best(a), db = best(b);
    let fit = Infinity;
    for (let i = 0; i < bases.length; i++) fit = Math.min(fit, da[i] + db[i] + 1);
    if (fit <= L) { out.push({ ...p, tier: 1, rank: fit }); continue; }
    const onA = da.some((x) => x <= L - 2), onB = db.some((x) => x <= L - 2);
    const inA = adj.has(a) || bases.includes(a), inB = adj.has(b) || bases.includes(b);
    if (!inA && onB) { const l = bridge.get(a) ?? []; if (l.length < 20) l.push({ ref: p, nd: db }); bridge.set(a, l); }
    else if (!inB && onA) { const l = bridge.get(b) ?? []; if (l.length < 20) l.push({ ref: p, nd: da }); bridge.set(b, l); }
  }
  for (const list of bridge.values()) {
    if (list.length < 2) continue;
    // Two of its neighbours that fit a loop together: d1 + d2 + 2 pools.
    let fit = Infinity;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++)
      for (let k = 0; k < bases.length; k++) fit = Math.min(fit, list[i].nd[k] + list[j].nd[k] + 2);
    if (fit > L) continue;
    for (const x of list) out.push({ ...x.ref, tier: 2, rank: fit });
  }
  out.sort((x, y) => x.tier - y.tier || x.rank - y.rank);
  return out.slice(0, Math.max(0, inp.max)).map(({ rank: _r, ...rest }) => rest);
}

// ----------------------------------------------------------------------------
// 2b) The same pick, from a compact index of the scan (STALL FIX, Oct 14)
//
// Plain English:
//   pickScanCandidates() above goes over the chain-wide scan's ~400,000
//   pools twice per pick (every 10 min), building about a million throw-away
//   objects and a 400,000-entry list of text keys each time. That froze the
//   bot for hundreds of ms and gave Node's memory clean-up (GC) lots of work.
//
//   Now, once per scan update, we build a compact index of the scan (plain
//   number lists, no text keys): which pools are the only pool of their coin
//   pair ("singles"), and the coin pairs that have 2+ pools. Each pick then
//   only looks at the singles, using numbers, in ~5 ms bites. The answer is
//   exactly the same as pickScanCandidates() (the tests compare the two).
// ----------------------------------------------------------------------------
type ScanStateLike = { tokens: string[]; pools: Array<[number, string, number, number]>; factories: string[] };

export interface ScanIndex {
  state: ScanStateLike;
  poolCount: number;       // scan pools this index covers (state.pools.length when built)
  tokenCount: number;      // coins this index covers
  factoryCount: number;
  anyPool: boolean;        // at least one usable pool (not V4, a normal address)
  canon: Int32Array;       // coin position -> first position of the same coin (normally itself)
  low: string[];           // coin addresses in lower case (the state's own list when it already is)
  singles: Int32Array;     // positions (in state.pools) of usable pools that are the only pool of their pair
  multi: Map<string, number>; // pair key -> number of pools, only for pairs on 2+ pools
}

// Is this index still right for the scan state? (The scan only ever adds
// pools, coins and factories, so the lengths tell us.)
export function scanIndexFresh(idx: ScanIndex | null, state: ScanStateLike): boolean {
  return !!idx && idx.state === state && idx.poolCount === state.pools.length
    && idx.tokenCount === state.tokens.length && idx.factoryCount === state.factories.length;
}

// Build the index (as steps, see core/chunked.ts). Once per scan update.
// Plain number tables sized up front are used instead of Maps: a Map that
// grows to 400k entries re-sorts itself mid-way (one ~100 ms freeze), and
// every throw-away object or growing list adds to Node's memory clean-up.
export function* buildScanIndexSteps(state: ScanStateLike): Steps<ScanIndex> {
  const P = state.pools.length, T = state.tokens.length, F = state.factories.length;
  const isV4 = state.factories.map((f) => f.split('|')[1] === 'v4');
  // Lower-case coin list (the scan already stores lower case; checked
  // letter by letter, so nothing new is made when it already is).
  let low = state.tokens;
  for (let i = 0; i < T; i++) {
    if ((i & 4095) === 4095) yield;
    if (hasUpper(state.tokens[i])) { low = state.tokens.map(lc); break; }
  }
  yield;
  // Same coin listed twice? Point both at the first one (normally never
  // happens). Number table keyed by a hash of the address text.
  const canon = new Int32Array(T);
  {
    const tmask = tableSize(T) - 1;
    const at = new Int32Array(tmask + 1).fill(-1);
    for (let i = 0; i < T; i++) {
      if ((i & 4095) === 4095) yield;
      const s = low[i];
      let h = textHash(s, false) & tmask;
      while (at[h] !== -1 && low[at[h]] !== s) h = (h + 1) & tmask;
      if (at[h] === -1) { at[h] = i; canon[i] = i; } else canon[i] = at[h];
    }
  }
  // Pools per coin pair. Slot = hash of (smaller coin, larger coin).
  const usable = (row: [number, string, number, number]) => !isV4[row[0]] && row[1].length === 42;
  const cap = tableSize(P), mask = cap - 1;
  const slotA = new Int32Array(cap).fill(-1), slotB = new Int32Array(cap), slotN = new Int32Array(cap);
  // The slot of pair (a, b), a < b: the matching one, or the first free one.
  const slotOf = (a: number, b: number): number => {
    let h = ((Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 0x7f4a7c15, 0x85ebca77)) >>> 0) & mask;
    while (slotA[h] !== -1 && (slotA[h] !== a || slotB[h] !== b)) h = (h + 1) & mask;
    return h;
  };
  let anyPool = false;
  for (let i = 0; i < P; i++) {
    if ((i & 2047) === 2047) yield;
    const row = state.pools[i];
    if (!usable(row)) continue;
    anyPool = true;
    let a = canon[row[2]], b = canon[row[3]];
    if (a > b) { const x = a; a = b; b = x; }
    const h = slotOf(a, b);
    if (slotA[h] === -1) { slotA[h] = a; slotB[h] = b; }
    slotN[h]++;
  }
  // Singles: usable pools that are the only pool of their pair (in scan order).
  const singlesAll = new Int32Array(P);
  let ns = 0;
  for (let i = 0; i < P; i++) {
    if ((i & 2047) === 2047) yield;
    const row = state.pools[i];
    if (!usable(row)) continue;
    let a = canon[row[2]], b = canon[row[3]];
    if (a === b) continue;
    if (a > b) { const x = a; a = b; b = x; }
    if (slotN[slotOf(a, b)] === 1) singlesAll[ns++] = i;
  }
  // Pairs on 2+ pools, by their usual text key (only these few need text).
  const multi = new Map<string, number>();
  for (let h = 0; h < cap; h++) {
    if ((h & 8191) === 8191) yield;
    if (slotN[h] >= 2) multi.set(pairKey(low[slotA[h]], low[slotB[h]]), slotN[h]);
  }
  return { state, poolCount: P, tokenCount: T, factoryCount: F, anyPool, canon, low, singles: singlesAll.slice(0, ns), multi };
}

// Table size: a power of two, at least twice the number of entries.
function tableSize(n: number): number { let c = 1024; while (c < n * 2) c *= 2; return c; }
// Any capital letter (A-Z) in the text?
function hasUpper(s: string): boolean {
  for (let c = 0; c < s.length; c++) { const x = s.charCodeAt(c); if (x >= 65 && x <= 90) return true; }
  return false;
}
// Number hash of a text (FNV-1a). anyCase = treat capital letters as small
// ones (works for addresses: only 0-9, a-f, x), so "0xAb" and "0xab" match.
function textHash(s: string, anyCase: boolean): number {
  let h = 0x811c9dc5;
  for (let c = 0; c < s.length; c++) { let x = s.charCodeAt(c); if (anyCase && x >= 65 && x <= 90) x += 32; h = Math.imul(h ^ x, 0x01000193); }
  return h >>> 0;
}

// Pools the scan knows for a pair, from the index: the count for pairs on
// 2+ pools, otherwise 0. (selectLoopPools only asks "more than one?", so
// this gives the same pick as counting every scan pool.)
export function scanPairCountFromIndex(idx: ScanIndex | null, pk: string): number {
  return idx?.multi.get(pk) ?? 0;
}

export interface IndexedPickInput extends Omit<ScanPickInput, 'scanPools'> { index: ScanIndex }

// Same answer as pickScanCandidates(), from the index (as steps).
// Same rules in the same order; the only differences are how it is done:
// numbers instead of text keys, and a pool address is only turned into
// lower case (a new piece of text) when its answer depends on it.
export function* pickScanCandidatesIndexedSteps(inp: IndexedPickInput): Steps<(ScanPoolRef & { tier: number })[]> {
  const L = inp.loopMaxPools;
  const rival = inp.rivalPools ?? new Set<string>();
  const idx = inp.index, st = idx.state, T = idx.tokenCount, canon = idx.canon;
  const adj = buildAdj(inp.graphPools.map(edgeOf));
  const bases = inp.bases.map(lc);
  const dist = bases.map((b) => hops(adj, b, L));
  const nb = bases.length;
  yield;
  // Per coin, as small numbers: pools from each base coin (FAR = can't reach
  // within L pools; any sum with FAR is above every loop length), and
  // whether the coin is on our coin map.
  const FAR = 127;
  const D = bases.map(() => new Int8Array(T).fill(FAR));
  const onMap = new Uint8Array(T);
  // Coins named in knownPairs, to turn those pairs into number keys.
  const knownTokens = new Set<string>();
  for (const pk of inp.knownPairs) { const s = pk.indexOf('/'); if (s > 0) { knownTokens.add(pk.slice(0, s)); knownTokens.add(pk.slice(s + 1)); } }
  const knownTokenAt = new Map<string, number>();
  for (let i = 0; i < T; i++) {
    if ((i & 2047) === 2047) yield;
    if (canon[i] !== i) continue;
    const s = idx.low[i];
    for (let k = 0; k < nb; k++) { const d = dist[k].get(s); if (d !== undefined) D[k][i] = d; }
    if (adj.has(s) || bases.includes(s)) onMap[i] = 1;
    if (knownTokens.has(s)) knownTokenAt.set(s, i);
  }
  const known = new Set<number>();
  for (const pk of inp.knownPairs) {
    const s = pk.indexOf('/');
    if (s <= 0) continue;
    const a = knownTokenAt.get(pk.slice(0, s)), b = knownTokenAt.get(pk.slice(s + 1));
    if (a !== undefined && b !== undefined) known.add(a < b ? a * T + b : b * T + a);
  }
  // Rival pools by a case-blind hash: only a hash match needs the real check.
  const rivalHash = new Set<number>();
  for (const k of rival) rivalHash.add(textHash(k, true));
  const isRival = (raw: string): boolean => rival.size > 0 && rivalHash.has(textHash(raw, true)) && rival.has(lc(raw));
  yield;

  // Results go into buckets by (tier, rank) in the order found. Reading the
  // buckets in order gives exactly what a stable sort by tier then rank
  // gives (what pickScanCandidates does), without sorting a big list, and
  // only the first `max` results are ever turned into objects.
  const buckets: number[][] = [];
  const put = (pi: number, tier: number, rank: number) => { const b = tier * 32 + Math.min(31, rank); (buckets[b] ??= []).push(pi); };
  const ref = (pi: number): ScanPoolRef => { const r = st.pools[pi]; return { pool: r[1], token0: st.tokens[r[2]], token1: st.tokens[r[3]] }; };
  // Tier 2 bookkeeping, as fixed-size number lists: which off-map coin,
  // which pool, and the other coin's distance from each base. "Recently
  // looked at" (skip) is checked later, and only for coins that could make
  // a pair of pools at all (most coins have just one pool).
  const singles = idx.singles;
  const bTok = new Int32Array(singles.length), bPool = new Int32Array(singles.length), bNd = new Int8Array(singles.length * nb);
  let nbr = 0;
  for (let j = 0; j < singles.length; j++) {
    if ((j & 1023) === 1023) yield;
    const pi = singles[j], row = st.pools[pi];
    const a = canon[row[2]], b = canon[row[3]];
    if (known.has(a < b ? a * T + b : b * T + a)) continue;
    if (isRival(row[1])) { if (!inp.skip(lc(row[1]))) put(pi, 0, 0); continue; }
    let fit = Infinity, onA = false, onB = false;
    for (let k = 0; k < nb; k++) {
      const da = D[k][a], db = D[k][b];
      if (da + db + 1 < fit) fit = da + db + 1;
      if (da <= L - 2) onA = true;
      if (db <= L - 2) onB = true;
    }
    if (fit <= L) { if (!inp.skip(lc(row[1]))) put(pi, 1, fit); continue; }
    if (!onMap[a] && onB) { bTok[nbr] = a; bPool[nbr] = pi; for (let k = 0; k < nb; k++) bNd[nbr * nb + k] = D[k][b]; nbr++; }
    else if (!onMap[b] && onA) { bTok[nbr] = b; bPool[nbr] = pi; for (let k = 0; k < nb; k++) bNd[nbr * nb + k] = D[k][a]; nbr++; }
  }
  yield;
  // A coin needs 2+ pools to be a bridge; skip only ever removes pools, so
  // coins with fewer than 2 before the skip check can be left out right away.
  const raw = new Uint8Array(T);
  for (let e = 0; e < nbr; e++) { if ((e & 4095) === 4095) yield; if (raw[bTok[e]] < 2) raw[bTok[e]]++; }
  // Keep at most 20 pools per off-map coin (first ones seen, not looked at
  // recently), then group the coins with 2+ pools, in the order each coin
  // was first seen.
  const kept = new Uint8Array(T);
  const accepted = new Uint8Array(nbr);
  for (let e = 0; e < nbr; e++) {
    if ((e & 1023) === 1023) yield;
    const t = bTok[e];
    if (raw[t] < 2 || kept[t] >= 20) continue;
    if (inp.skip(lc(st.pools[bPool[e]][1]))) continue;
    kept[t]++; accepted[e] = 1;
  }
  const groups = new Map<number, number[]>();
  for (let e = 0; e < nbr; e++) {
    if ((e & 4095) === 4095) yield;
    if (!accepted[e] || kept[bTok[e]] < 2) continue;
    (groups.get(bTok[e]) ?? groups.set(bTok[e], []).get(bTok[e])!).push(e);
  }
  let g = 0;
  for (const list of groups.values()) {
    if ((++g & 255) === 255) yield;
    // Two of its neighbours that fit a loop together: d1 + d2 + 2 pools.
    let fit = Infinity;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++)
      for (let k = 0; k < nb; k++) fit = Math.min(fit, bNd[list[i] * nb + k] + bNd[list[j] * nb + k] + 2);
    if (fit > L) continue;
    for (const e of list) put(bPool[e], 2, fit);
  }
  // Best first (tier, then rank), at most `max`.
  const max = Math.max(0, inp.max);
  const result: (ScanPoolRef & { tier: number })[] = [];
  for (let b = 0; b < buckets.length && result.length < max; b++) {
    const list = buckets[b];
    if (!list) continue;
    const tier = Math.floor(b / 32);
    for (let i = 0; i < list.length && result.length < max; i++) {
      if ((result.length & 1023) === 1023) yield;
      result.push({ ...ref(list[i]), tier });
    }
  }
  return result;
}

// ----------------------------------------------------------------------------
// Bundling: lookups that run at the same time share one node request.
// ----------------------------------------------------------------------------
export type CallMany = (calls: { target: string; data: string }[]) => Promise<(string | null)[]>;

// Wraps a batched reader so calls made in the same moment (e.g. 10 pair
// lookups started together) go out as ONE bundled request instead of ten.
export function coalesceCallMany(callMany: CallMany): CallMany {
  let queue: { calls: { target: string; data: string }[]; resolve: (r: (string | null)[]) => void; reject: (e: unknown) => void }[] = [];
  let scheduled = false;
  const flush = async () => {
    const batch = queue; queue = []; scheduled = false;
    const all = batch.flatMap((b) => b.calls);
    try {
      const res = await callMany(all);
      let i = 0;
      for (const b of batch) { b.resolve(res.slice(i, i + b.calls.length)); i += b.calls.length; }
    } catch (e) { for (const b of batch) b.reject(e); }
  };
  return (calls) => new Promise((resolve, reject) => {
    queue.push({ calls, resolve, reject });
    if (!scheduled) { scheduled = true; setTimeout(() => { void flush(); }, 0); }
  });
}

// ----------------------------------------------------------------------------
// Wiring helpers (also used by the tests to prove "off = no change")
// ----------------------------------------------------------------------------

// The block reader's pool list: watched pools, plus extra pools when on.
// With extra pools off (null) this is exactly the watched list.
export function readerAddresses(watched: string[], extra: { addresses(): string[] } | null): string[] {
  if (!extra) return watched;
  const set = new Set(watched);
  for (const a of extra.addresses()) set.add(a);
  return [...set];
}

// After the block reader wrote new prices: what should run?
//   'gap'  = at least one watched pool moved: the gap scan (which also runs the loop scan)
//   'loop' = only extra pools moved: the loop scan alone (the gap scan has nothing new)
//   'none' = nothing written
// With extra pools off (null), any write means 'gap', exactly as before.
export function afterReaderWrite(applied: string[], extra: { has(pool: string): boolean } | null, watchedSet: () => Set<string>): 'gap' | 'loop' | 'none' {
  if (!applied.length) return 'none';
  if (!extra) return 'gap';
  let ws: Set<string> | null = null;
  for (const k of applied) {
    if (!extra.has(k)) return 'gap';
    ws ??= watchedSet();
    if (ws.has(lc(k))) return 'gap';   // also watched (pair became watched later)
  }
  return 'loop';
}

// ----------------------------------------------------------------------------
// 3) The keeper: picks, looks up, reads and re-reads.
// ----------------------------------------------------------------------------
export interface LoopExtraDeps {
  bases: string[];
  getPool: (pool: string) => PoolState | undefined;    // cache lookup
  cachePools: () => PoolState[];                       // every cached pool on this chain
  watchedPools: () => string[][];                      // pair watcher's pools per watched pair
  scanPools: () => Iterable<ScanPoolRef>;              // chain-wide scan's pool list ([] = none yet)
  // The chain-wide scan's saved state itself (null = none yet). Given: the
  // pick uses the compact index (cfg.chunked). Not given: scanPools() as before.
  scanState?: () => ScanStateLike | null;
  depthUsd: (p: PoolState) => number | null;
  usdOf: (token: string) => number | null;
  decimalsOf: (token: string) => number | undefined;
  rivalPools: () => Set<string>;
  // Cheap reads (balances) on the gentle lane. Throws on node trouble.
  callMany: CallMany;
  // Exact lookup of one pair (PairWatcher.lookupPair): writes the cache, never the watch list.
  lookupPair: (a: string, b: string, callMany: CallMany) => Promise<PoolState[]>;
  // Bundled price re-read (pairWatcher refreshPoolsBatch) and the safe cache write (upsertIfNotNewer).
  readStates: (pools: PoolState[], callMany: CallMany) => Promise<PoolState[]>;
  writeState: (fresh: PoolState, readStartedMs: number) => boolean;
  now: () => number;
  log?: (msg: string) => void;
}

const erc20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
const DUST_MEMORY_MS = 6 * 3600_000;    // a scan pool without money is not looked at again for 6 h
const LOOKUP_MEMORY_MS = 6 * 3600_000;  // a looked-up pair is not looked up again for 6 h
const MEMORY_MAX = 100_000;             // bound on the "looked at" memories

export class LoopExtraPools {
  private selected = new Set<string>();          // lower-case pool keys
  private dustUntil = new Map<string, number>(); // scan pool -> skip until
  private lookedUntil = new Map<string, number>(); // scan pool -> skip until
  private lastRebuild = -Infinity;
  private rebuilding = false;
  private refreshing = false;
  private timers: NodeJS.Timeout[] = [];
  private bundled: CallMany;
  last = { selected: 0, deepSingles: 0, reachable: 0, rivalPicked: 0, balanceChecks: 0, lookups: 0, lookupErrors: 0, at: 0 };

  constructor(readonly cfg: LoopExtraConfig, private deps: LoopExtraDeps) {
    this.bundled = coalesceCallMany(deps.callMany);
  }

  // The compact scan index (see buildScanIndexSteps), built in ~5 ms bites
  // the first time and again only after the scan state changed. null when
  // there's no scan state yet.
  private index: ScanIndex | null = null;
  private async scanIndex(): Promise<ScanIndex | null> {
    const st = this.deps.scanState?.() ?? null;
    if (!st) return null;
    if (!scanIndexFresh(this.index, st)) {
      this.index = null;   // drop the old one first (memory)
      this.index = await runSteps(buildScanIndexSteps(st), 'extra-pool scan index');
    }
    return this.index;
  }

  // ---- What the rest of the bot asks --------------------------------------
  has(pool: string): boolean { return this.selected.has(lc(pool)); }
  size(): number { return this.selected.size; }
  // Pool addresses (V2/V3) for the block reader.
  addresses(): string[] { return [...this.selected].filter((k) => k.length === 42); }
  // V4 pool ids for the block reader.
  v4Ids(): Set<string> { return new Set([...this.selected].filter((k) => k.length === 66)); }
  keys(): string[] { return [...this.selected]; }

  // Picked pools whose price is fresh (read within maxAgeMs). Only these go to the loop finder.
  freshPools(maxAgeMs: number): PoolState[] {
    const now = this.deps.now(), out: PoolState[] = [];
    for (const k of this.selected) { const p = this.deps.getPool(k); if (p && now - p.lastUpdatedMs <= maxAgeMs) out.push(p); }
    return out;
  }
  status(maxAgeMs: number): { fresh: number; selected: number } { return { fresh: this.freshPools(maxAgeMs).length, selected: this.selected.size }; }
  statusText(maxAgeMs: number): string { const s = this.status(maxAgeMs); return `loop extra pools: ${s.fresh} fresh / ${s.selected} selected`; }

  // ---- Timers --------------------------------------------------------------
  start(firstDelayMs = 3 * 60_000): void {
    if (this.timers.length) return;
    this.timers.push(setTimeout(() => { void this.rebuild('start'); }, firstDelayMs));
    this.timers.push(setInterval(() => { void this.rebuild('timer'); }, this.cfg.rebuildMs));
    if (this.cfg.refreshMs > 0) this.timers.push(setInterval(() => { void this.refresh(); }, this.cfg.refreshMs));
    for (const t of this.timers) (t as any).unref?.();
  }
  stop(): void { for (const t of this.timers) clearTimeout(t); this.timers = []; }

  // The chain-wide scan finished: rebuild now (unless one ran in the last minute).
  noteScanUpdated(): void { void this.rebuild('scan'); }

  // ---- Rebuild -------------------------------------------------------------
  async rebuild(reason: string, force = false): Promise<boolean> {
    const now = this.deps.now();
    if (this.rebuilding) return false;
    if (!force && now - this.lastRebuild < this.cfg.minRebuildGapMs) return false;
    this.rebuilding = true;
    this.lastRebuild = now;
    try {
      const watchedLists = this.deps.watchedPools();
      const watchedKeys = new Set(watchedLists.flat().map(lc));
      const watched = [...watchedKeys].map((k) => this.deps.getPool(k)).filter((p): p is PoolState => !!p);
      const deepOk = (p: PoolState) => { const d = this.deps.depthUsd(p); return d !== null && d >= this.cfg.minDepthUsd; };

      // A) New single pools from the chain-wide scan (cheap balance read, then exact lookup).
      let balanceChecks = 0, lookups = 0, lookupErrors = 0;
      // STALL FIX (cfg.chunked): use the compact scan index, in ~5 ms bites.
      // Off (or no scan state given): the old one-go pick over the full list.
      const indexed = !!this.cfg.chunked && !!this.deps.scanState && this.cfg.lookupsPerRound > 0;
      const index = indexed ? await this.scanIndex() : null;
      const scan = this.cfg.lookupsPerRound > 0 && !indexed ? this.deps.scanPools() : [];
      // Any pools at all? (works for a list or a live view of the scan state)
      if (indexed ? !!index?.anyPool : !scan[Symbol.iterator]().next().done) {
        const cached = this.deps.cachePools();
        const knownPairs = new Set<string>();
        for (const p of watched) knownPairs.add(pairKey(p.tokenA, p.tokenB));
        for (const p of cached) knownPairs.add(pairKey(p.tokenA, p.tokenB));
        const graphPools = [...watched, ...cached.filter((p) => !watchedKeys.has(lc(p.poolAddress)))].filter((p) => hasExactMath(p) && deepOk(p));
        const t = this.deps.now();
        const pickInput = {
          bases: this.deps.bases, loopMaxPools: this.cfg.loopMaxPools, graphPools, knownPairs,
          skip: (k: string) => (this.dustUntil.get(k) ?? 0) > t || (this.lookedUntil.get(k) ?? 0) > t,
          rivalPools: this.deps.rivalPools(), max: this.cfg.balanceChecksPerRound,
        };
        const cands = index
          ? await runSteps(pickScanCandidatesIndexedSteps({ ...pickInput, index }), 'extra-pool pick')
          : timed('extra-pool pick', () => pickScanCandidates({ ...pickInput, scanPools: scan }));
        // Cheap money check: one balanceOf for a coin we can price (rival pools skip it).
        const toCheck: { ref: ScanPoolRef & { tier: number }; token: string; usd: number; dec: number }[] = [];
        const passed: { ref: ScanPoolRef & { tier: number }; est: number }[] = [];
        for (const c of cands) {
          if (c.tier === 0) { passed.push({ ref: c, est: Infinity }); continue; }
          for (const tok of [c.token0, c.token1]) {
            const usd = this.deps.usdOf(tok), dec = this.deps.decimalsOf(tok);
            if (usd && usd > 0 && dec !== undefined) { toCheck.push({ ref: c, token: tok, usd, dec }); break; }
          }
        }
        if (toCheck.length) {
          balanceChecks = toCheck.length;
          const res = await this.deps.callMany(toCheck.map((x) => ({ target: x.token, data: erc20.encodeFunctionData('balanceOf', [x.ref.pool]) })));
          const t2 = this.deps.now();
          toCheck.forEach((x, i) => {
            const r = res[i];
            if (!r || r.length < 66) return;             // unreadable now: try again next round
            // 2 x the side we can price: an upper bound for V3-style pools;
            // the exact lookup below decides for real.
            const est = 2 * (Number(BigInt(r.slice(0, 66))) / 10 ** x.dec) * x.usd;
            if (est >= this.cfg.minDepthUsd) passed.push({ ref: x.ref, est });
            else this.dustUntil.set(lc(x.ref.pool), t2 + DUST_MEMORY_MS);
          });
        }
        passed.sort((a, b) => a.ref.tier - b.ref.tier || b.est - a.est);
        // Exact lookups, 10 at a time (their reads share bundled requests).
        const todo = passed.slice(0, this.cfg.lookupsPerRound);
        for (let i = 0; i < todo.length; i += 10) {
          await Promise.all(todo.slice(i, i + 10).map(async ({ ref }) => {
            try {
              await this.deps.lookupPair(ref.token0, ref.token1, this.bundled);
              lookups++;
              this.lookedUntil.set(lc(ref.pool), this.deps.now() + LOOKUP_MEMORY_MS);
            } catch { lookupErrors++; }   // node trouble: tried again next round
          }));
        }
        if (this.dustUntil.size > MEMORY_MAX) this.dustUntil.clear();
        if (this.lookedUntil.size > MEMORY_MAX) this.lookedUntil.clear();
      }

      // B) Pick from everything we now have a price for.
      let scanPairCount: (k: string) => number;
      if (indexed) {
        // The scan may have grown during the lookups: refresh the index if so.
        const idx2 = await this.scanIndex();
        scanPairCount = (k) => scanPairCountFromIndex(idx2, k);
      } else {
        const scanCount = new Map<string, number>();
        timed('extra-pool scan count', () => { for (const p of scan) { const k = pairKey(p.token0, p.token1); scanCount.set(k, (scanCount.get(k) ?? 0) + 1); } });
        scanPairCount = (k) => scanCount.get(k) ?? 0;
      }
      const selInput: SelectInput = {
        bases: this.deps.bases, loopMaxPools: this.cfg.loopMaxPools, cap: this.cfg.maxSelected, minDepthUsd: this.cfg.minDepthUsd,
        watched, others: this.deps.cachePools().filter((p) => !watchedKeys.has(lc(p.poolAddress))),
        depthUsd: this.deps.depthUsd, rivalPools: this.deps.rivalPools(), scanPairCount,
      };
      const sel = this.cfg.chunked
        ? await runSteps(selectLoopPoolsSteps(selInput), 'extra-pool select')
        : timed('extra-pool select', () => selectLoopPools(selInput));
      const next = new Set(sel.selected.map((p) => lc(p.poolAddress)));
      const added = sel.selected.filter((p) => !this.selected.has(lc(p.poolAddress)));
      // Follow them in the block reader FIRST, then read their state: a trade
      // in between is caught by the reader, and the read never overwrites it.
      this.selected = next;
      // Node trouble here is fine: the 20 s re-read tries again, and a pool
      // without a fresh price is simply left out of the loop finder.
      if (added.length) await this.readAndWrite(added).catch(() => 0);
      this.last = { selected: next.size, deepSingles: sel.deepSingles, reachable: sel.reachable, rivalPicked: sel.rivalPicked, balanceChecks, lookups, lookupErrors, at: this.deps.now() };
      this.deps.log?.(`[loop] extra single pools (${reason}): ${next.size} selected (${sel.rivalPicked} used by rival loops, ${added.length} new) of ${sel.reachable} that fit a loop / ${sel.deepSingles} with $${this.cfg.minDepthUsd}+; scan: ${balanceChecks} balance checks, ${lookups} pairs looked up${lookupErrors ? `, ${lookupErrors} lookups failed` : ''}`);
      return true;
    } catch (err) {
      this.deps.log?.(`[loop] extra single pools rebuild failed (kept the old list): ${(err as Error).message}`);
      return false;
    } finally {
      this.rebuilding = false;
    }
  }

  // ---- Bundled re-read -----------------------------------------------------
  // Every refreshMs: re-read every picked pool in one bundled request (two
  // for 300 pools). Never overwrites newer block-reader data (writeState =
  // the cache's upsertIfNotNewer, which respects it).
  async refresh(): Promise<number> {
    if (this.refreshing || !this.selected.size) return 0;
    this.refreshing = true;
    try {
      const pools = [...this.selected].map((k) => this.deps.getPool(k)).filter((p): p is PoolState => !!p);
      return await this.readAndWrite(pools);
    } catch { return 0; /* node busy: the next round tries again; stale pools simply drop out of the finder */ }
    finally { this.refreshing = false; }
  }

  private async readAndWrite(pools: PoolState[]): Promise<number> {
    if (!pools.length) return 0;
    const started = this.deps.now();
    const fresh = await this.deps.readStates(pools, this.deps.callMany);
    let n = 0;
    for (const f of fresh) if (this.deps.writeState(f, started)) n++;
    return n;
  }
}
