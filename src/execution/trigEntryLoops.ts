import * as fs from 'fs';
import type { PoolState } from '../core/types';
import { computeAmountOut } from '../core/dexMath';
import { runSteps, Steps } from '../core/chunked';
import { encodeExecuteRaw, encodeExecuteV3FlashRaw, usdToTokenUnits } from './executorCalldata';
import { loopGasUnits } from '../core/loopTrader';
import type { EntryPick } from './trigEntry';

// ============================================================================
// FIRE-FIRST ENTRY: 3-POOL LOOPS (Oct 23, owner: "maximise income").
//
// Plain English:
//   The fire-first entry point (execution/trigEntry.ts) only tried the "same
//   pair on two exchanges" trade for each pool a feed transaction moved. A
//   24 h chain measurement (results/profit-measure/REPORT.md) showed that on
//   the exchanges our contract trades, 3-pool loops earn about as much as
//   2-pool trades ($722 vs $717 a day) and there are far more chances
//   (412 a day of $0.25+ over all routes vs 96 for 2-pool).
//
//   This file adds 3-pool LOOPS as extra candidates:
//     start coin (USDG or WETH, the coins we hold) -> coin A -> coin B -> start
//   that go through the moved pool. Same entry flow as 2-pool candidates:
//   our exact trade is checked on the replayed feed (trigger-first check,
//   size ladder), and only a sure, profitable answer can be sent.
//
//   HOW IT STAYS CHEAP: the list of loops is worked out AHEAD of time, per
//   pool (the LOOP INDEX), not when a trigger arrives. The index is rebuilt
//   in ~2 ms bites (never freezes the bot) when the set of pools changes,
//   and at least once a minute (so coins that passed the tax test, or
//   exchanges newly cleared, are picked up). A trigger then only looks up
//   its moved pools' loops, gives each a quick price check (remembered while
//   the pools' prices don't change) and builds the best few. No node calls.
//
//   RULES (the same ones live loops use, execution/loopLive.ts):
//     - every exchange on the loop cleared for live trading (liveBlocker:
//       venue rule, practice-only V4 settings, live coin rule),
//     - the contract can run every pool (pool kind supported, hooked V4 key
//       matches its id) and the bot has exact maths for it,
//     - every pool deep enough (the loop finder's depth filter),
//     - every coin on the allowed list (SafetyGate: no meme coins unless
//       vetted), and every middle coin PASSED the coin tax test
//       (data/coin-tax.json, written by the loop finder's tax tester),
//     - a flash lender is never one of the loop's own pools,
//     - loop size limit (LOOP_LIVE_MAX_TRADE_USD, $10,000) and the LOOP LOSS
//       CAP (LOOP_LIVE_LOSS_CAP_USD, $2 of gas a day on failed loops, shared
//       with the live loop sender) before every send.
// ============================================================================
//
// 4-POOL LOOPS (Oct 25, TRIG_ENTRY_LOOP_POOLS_MAX=4; default 3 = off).
//   Live today a rival bot earned ~$11-13 repeating the loop
//   WETH -> PONS -> DJT -> USDG -> WETH (four Uniswap V3 pools). The index
//   above only held 3-pool loops, so the bot never even looked at it. With
//   the setting at 4, the index ALSO holds loops
//     start -> coin A -> coin B -> coin C -> start
//   through each pool, built under exactly the SAME RULES as 3-pool loops
//   (same pool filter, same coin / tax filter, same lender, size and loss
//   cap rules at send time: those don't care how many pools a loop has).
//   They get their OWN share of each pool's list (TRIG_ENTRY_LOOPS4_PER_POOL,
//   8) so they never push 3-pool loops out, and the whole index still keeps
//   to TRIG_ENTRY_LOOP_INDEX_MAX (3-pool loops are counted first).
//   Our contract runs any number of hops; the gas figure for 4 hops comes
//   from loopGasUnits (core/loopTrader.ts: ~635k vs ~507k for 3 hops).
// ============================================================================

const lc = (x: string) => (x ?? '').toLowerCase();

// ---- settings ---------------------------------------------------------------
export type LoopIndexSettings = {
  perPool: number;     // TRIG_ENTRY_LOOPS_PER_POOL [24] loops kept per pool (deepest first)
  maxLoops: number;    // TRIG_ENTRY_LOOP_INDEX_MAX [20000] loops in the whole index
  checkMs: number;     // TRIG_ENTRY_LOOP_INDEX_MS [10000] how often "did the pool set change?" is asked
  rebuildMs: number;   // TRIG_ENTRY_LOOP_REBUILD_MS [60000] rebuilt at least this often anyway
  sliceMs: number;     // a rebuild works at most this long before letting the bot run [2]
  // 4-POOL LOOPS (Oct 25). poolsMax 3 = only 3-pool loops (as before).
  poolsMax: number;    // TRIG_ENTRY_LOOP_POOLS_MAX [3] longest loop in the index (3 or 4)
  perPool4: number;    // TRIG_ENTRY_LOOPS4_PER_POOL [8] 4-pool loops kept per pool, ON TOP of the 3-pool ones
  perCoin4: number;    // TRIG_ENTRY_LOOPS4_PER_COIN [400] 4-pool loops looked at per (start coin, first middle coin)
  maxSteps4: number;   // TRIG_ENTRY_LOOPS4_MAX_STEPS [3000000] work limit for the 4-pool search in one rebuild
};
export function loopIndexSettings(env: Record<string, string | undefined> = process.env): LoopIndexSettings {
  const num = (k: string, d: number, min: number) => { const v = Number(env[k]); return env[k] !== undefined && env[k]!.trim() !== '' && Number.isFinite(v) && v >= min ? v : d; };
  return {
    perPool: Math.round(num('TRIG_ENTRY_LOOPS_PER_POOL', 24, 1)),
    maxLoops: Math.round(num('TRIG_ENTRY_LOOP_INDEX_MAX', 20_000, 1)),
    checkMs: num('TRIG_ENTRY_LOOP_INDEX_MS', 10_000, 500),
    rebuildMs: num('TRIG_ENTRY_LOOP_REBUILD_MS', 60_000, 1_000),
    sliceMs: 2,
    // 3 or 4 only: anything above 4 means 4, anything below 3 means 3.
    poolsMax: Math.min(4, Math.max(3, Math.round(num('TRIG_ENTRY_LOOP_POOLS_MAX', 3, 0)))),
    perPool4: Math.round(num('TRIG_ENTRY_LOOPS4_PER_POOL', 8, 1)),
    perCoin4: Math.round(num('TRIG_ENTRY_LOOPS4_PER_COIN', 400, 1)),
    maxSteps4: Math.round(num('TRIG_ENTRY_LOOPS4_MAX_STEPS', 3_000_000, 1_000)),
  };
}

// ---- is the loop index needed at all? (Nov 1) --------------------------------
// Plain English: the loop index (and its coin tax tests, one free-node
// simulation every few seconds) is read in ONE place only: when the bot itself
// asks arbsim about a feed trigger (TrigEntry.processInner, loop candidates).
// With the Rust fast lane deciding (TRIG_ENTRY_NODE_ASKS off), the bot never
// asks, so the index was rebuilt every minute (4-pool search: up to 3,000,000
// steps, ~1-2 s of main-thread work offline) for nothing. Rust keeps its own
// routes; nothing of this index is sent to it.
// TRIG_ENTRY_LOOP_INDEX:
//   1 / on    always build it (old behaviour)
//   0 / off   never build it
//   not set   only when the bot asks about triggers itself (nodeAsks)
export function loopIndexNeeded(env: Record<string, string | undefined>, nodeAsks: boolean): boolean {
  const v = (env.TRIG_ENTRY_LOOP_INDEX ?? '').trim().toLowerCase();
  if (['1', 'on', 'true', 'yes'].includes(v)) return true;
  if (['0', 'off', 'false', 'no'].includes(v)) return false;
  return nodeAsks;
}

// ---- one loop ---------------------------------------------------------------
// start -> tokens[1] -> tokens[2] (-> tokens[3]) -> start, through keys[0..].
// 3 pools (3 coins) or, since Oct 25, 4 pools (4 coins): keys, tokens and
// inIsA always have the same length (= the number of pools).
// inIsA[i]: the coin going INTO pool i is that pool's tokenA (token0).
export type EntryLoop = {
  id: string;                          // "loop:<start>:<pool1>><pool2>><pool3>[><pool4>]" (lower case)
  start: string;                       // lower case
  keys: string[];                      // pool keys (address, or V4 pool id), lower case
  tokens: string[];                    // coins in order, starting with `start` (lower case)
  inIsA: boolean[];
  prio: number;                        // ordering inside a pool's list (higher = first): shallowest pool's depth
};

export function loopId(start: string, keys: string[]): string { return `loop:${lc(start)}:${keys.map(lc).join('>')}`; }

// What the index needs to know about the pools (host: the price cache).
export type LoopRules<P> = {
  key: (p: P) => string;                         // pool key (address / V4 id)
  tokens: (p: P) => [string, string];            // [tokenA, tokenB]
  poolOk: (p: P) => boolean;                     // venue cleared live, contract can run it, exact maths, deep enough
  coinOk: (token: string, isStart: boolean) => boolean; // allowed list; middle coins: tax-tested
  depth?: (p: P) => number;                      // money near the price ($): deeper loops first
  // Optional (Oct 26): same tests as poolOk / coinOk, but say WHICH rule
  // turned the pool or coin away (null = fine). Used only to count reasons
  // for the hourly line; when given, they decide instead of poolOk / coinOk.
  poolWhy?: (p: P) => string | null;
  coinWhy?: (token: string, isStart: boolean) => string | null;
};

// loops: all loops in the index (3- and 4-pool); loops4: of which 4-pool.
// capped: some loops were left out because a limit was reached.
// seen: distinct pools offered; skipped: how many were turned away, by reason.
export type LoopIndexData = { byPool: Map<string, EntryLoop[]>; loops: number; pools: number; capped: boolean; loops4?: number; seen?: number; skipped?: Record<string, number> };

// Options for one build. Only perPool / maxLoops are needed; without
// poolsMax 4 the build is exactly the 3-pool one (as before Oct 25).
export type LoopBuildOpts = { perPool: number; maxLoops: number; poolsMax?: number; perPool4?: number; perCoin4?: number; maxSteps4?: number };

// ENUMERATION (pure, written as steps so it can run in small bites).
// For each start coin S, each pool p1 with S (S -> X), each pool p2 with X
// (X -> Y, Y not S or X), each pool p3 joining Y and S: the loop
// S -p1-> X -p2-> Y -p3-> S. Both directions come out naturally (the
// reverse is S -p3-> Y -p2-> X -p1-> S). Every loop is filed under each of
// its 3 pools; each pool keeps its `perPool` best (deepest) loops.
export function* buildLoopIndexSteps<P>(pools: P[], startCoins: string[], r: LoopRules<P>, o: LoopBuildOpts): Steps<LoopIndexData> {
  const starts = [...new Set(startCoins.map(lc))];
  const isStart = (t: string) => starts.includes(t);
  // Usable pools (rules), once each.
  const usable: Array<{ p: P; k: string; a: string; b: string; d: number }> = [];
  const seenKeys = new Set<string>();
  const skipped: Record<string, number> = {};
  let n = 0;
  for (const p of pools) {
    if ((++n & 63) === 0) yield;
    let k: string, a: string, b: string;
    try { k = lc(r.key(p)); [a, b] = r.tokens(p).map(lc) as [string, string]; } catch { continue; }
    if (!k || !a || !b || a === b || seenKeys.has(k)) continue;
    seenKeys.add(k);
    // First rule that says no (coin A, coin B, then the pool). Without the
    // optional *Why helpers the old yes/no tests are used with plain labels.
    let why: string | null;
    try {
      const coinWhy = r.coinWhy ?? ((t: string, s: boolean) => (r.coinOk(t, s) ? null : s ? 'start coin not allowed' : 'middle coin not allowed'));
      const poolWhy = r.poolWhy ?? ((q: P) => (r.poolOk(q) ? null : 'pool rule'));
      why = coinWhy(a, isStart(a)) ?? coinWhy(b, isStart(b)) ?? poolWhy(p);
    } catch { why = 'rule error'; }
    if (why) { skipped[why] = (skipped[why] ?? 0) + 1; continue; }
    let d = 0;
    try { d = r.depth ? Number(r.depth(p)) || 0 : 0; } catch { d = 0; }
    usable.push({ p, k, a, b, d });
  }
  const byToken = new Map<string, typeof usable>();
  const byPair = new Map<string, typeof usable>();
  const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
  for (const u of usable) {
    for (const t of [u.a, u.b]) { const l = byToken.get(t) ?? []; l.push(u); byToken.set(t, l); }
    const pk = pairKey(u.a, u.b); const l = byPair.get(pk) ?? []; l.push(u); byPair.set(pk, l);
  }
  const all: EntryLoop[] = [];
  let capped = false;
  outer:
  for (const S of starts) {
    for (const u1 of byToken.get(S) ?? []) {
      const X = u1.a === S ? u1.b : u1.a;
      for (const u2 of byToken.get(X) ?? []) {
        if ((++n & 255) === 0) yield;
        if (u2 === u1) continue;
        const Y = u2.a === X ? u2.b : u2.a;
        if (Y === S || Y === X) continue;
        for (const u3 of byPair.get(pairKey(Y, S)) ?? []) {
          if (u3 === u1 || u3 === u2) continue;
          if (all.length >= o.maxLoops) { capped = true; break outer; }
          const keys: [string, string, string] = [u1.k, u2.k, u3.k];
          all.push({
            id: loopId(S, keys), start: S, keys, tokens: [S, X, Y],
            inIsA: [u1.a === S, u2.a === X, u3.a === Y],
            prio: Math.min(u1.d, u2.d, u3.d),
          });
        }
      }
    }
  }
  // File each loop under its 3 pools, deepest first, capped per pool.
  const byPool = new Map<string, EntryLoop[]>();
  for (const l of all) {
    if ((++n & 255) === 0) yield;
    for (const k of new Set(l.keys)) { const x = byPool.get(k) ?? []; x.push(l); byPool.set(k, x); }
  }
  for (const [k, x] of byPool) {
    if ((++n & 63) === 0) yield;
    x.sort((p, q) => q.prio - p.prio || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
    if (x.length > o.perPool) byPool.set(k, x.slice(0, o.perPool));
  }
  // 4-POOL LOOPS (Oct 25): only when switched on, and only with room left
  // under the whole-index limit (3-pool loops always come first).
  if ((o.poolsMax ?? 3) < 4) return { byPool, loops: all.length, pools: usable.length, capped, seen: seenKeys.size, skipped };
  const room = Math.max(0, o.maxLoops - all.length);
  const f = yield* buildLoops4Steps(usable, starts, {
    perPool: o.perPool4 ?? 8, room, perCoin: o.perCoin4 ?? 400, maxSteps: o.maxSteps4 ?? 3_000_000,
  });
  // Each pool's list: its 3-pool loops first, then its own 4-pool share.
  for (const [k, x] of f.byPool) {
    if ((++n & 63) === 0) yield;
    const three = byPool.get(k);
    byPool.set(k, three ? three.concat(x) : x);
  }
  return { byPool, loops: all.length + f.loops, pools: usable.length, capped: capped || f.capped, loops4: f.loops, seen: seenKeys.size, skipped };
}

// Same order everywhere: deeper (higher prio) first, then by id so a
// rebuild with the same pools gives exactly the same lists.
const byPrio = (p: EntryLoop, q: EntryLoop) => q.prio - p.prio || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0);

// 4-POOL SEARCH (Oct 25), on the pools that already passed every rule.
//
// Plain English: a 4-pool loop is S -> X -> Y -> Z -> S. Instead of trying
// every chain of 4 pools (far too many with ~1,200 pools), it goes:
//   for each start coin S, each coin X next to S, each coin Z next to S:
//   the middle coin Y must be next to BOTH X and Z, so only the SHORTER of
//   X's and Z's neighbour lists is walked, and the other is just asked
//   "do you touch Y?". Small coins have few neighbours, so this is cheap.
// Limits that keep it bounded (the bot never freezes; it yields every 256
// steps, the rebuild runs in ~2 ms bites):
//   - pools: only those that passed the rules (cleared exchange, contract
//     can run it, exact maths, DEPTH filter, allowed and tax-tested coins);
//   - per coin pair: only the 3 deepest pools (fee tiers) are used;
//   - per (start coin, first middle coin): at most perCoin loops looked at,
//     so one busy coin can't eat the whole search;
//   - the whole search: at most maxSteps steps (then "capped" in the
//     hourly line; the per-coin limit above is normal and not reported);
//   - per pool: only the perPool deepest 4-pool loops are KEPT (memory),
//     and the whole 4-pool part fits in `room` (TRIG_ENTRY_LOOP_INDEX_MAX
//     minus the 3-pool loops).
// Both directions come out naturally ((X, Z) and later (Z, X)), and the
// same loop starting at the other coin we hold (USDG vs WETH) is a separate
// loop, just like 3-pool loops.
const PAIR_POOLS4 = 3;
function* buildLoops4Steps(usable: Array<{ k: string; a: string; b: string; d: number }>, starts: string[],
  o: { perPool: number; room: number; perCoin: number; maxSteps: number }): Steps<{ byPool: Map<string, EntryLoop[]>; loops: number; capped: boolean }> {
  type U = { k: string; a: string; b: string; d: number };
  const empty = { byPool: new Map<string, EntryLoop[]>(), loops: 0, capped: o.room <= 0 };
  if (o.room <= 0 || o.perPool <= 0) return empty;
  let n = 0;
  // Neighbours: coin -> (next coin -> its pools, deepest first, top 3).
  const nb = new Map<string, Map<string, U[]>>();
  for (const u of usable) {
    if ((++n & 255) === 0) yield;
    for (const [x, y] of [[u.a, u.b], [u.b, u.a]] as const) {
      let m = nb.get(x); if (!m) { m = new Map(); nb.set(x, m); }
      const l = m.get(y); if (l) l.push(u); else m.set(y, [u]);
    }
  }
  for (const m of nb.values()) for (const [y, l] of m) {
    if ((++n & 255) === 0) yield;
    l.sort((p, q) => q.d - p.d || (p.k < q.k ? -1 : p.k > q.k ? 1 : 0));
    if (l.length > PAIR_POOLS4) m.set(y, l.slice(0, PAIR_POOLS4));
  }
  // Kept loops per pool, best first (at most perPool each).
  const top = new Map<string, EntryLoop[]>();
  const wouldKeep = (k: string, prio: number) => { const a = top.get(k); return !a || a.length < o.perPool || prio >= a[a.length - 1].prio; };
  const keep = (l: EntryLoop) => {
    for (const k of l.keys) {
      let a = top.get(k); if (!a) { a = []; top.set(k, a); }
      if (a.length >= o.perPool && byPrio(l, a[a.length - 1]) >= 0) continue; // not better than this pool's worst
      let i = a.length; while (i > 0 && byPrio(l, a[i - 1]) < 0) i--;
      a.splice(i, 0, l);
      if (a.length > o.perPool) a.pop();
    }
  };
  let capped = false, steps = 0;
  outer:
  for (const S of starts) {
    const nS = nb.get(S);
    if (!nS) continue;
    // Coins next to S, deepest connection first (so limits drop the shallow ones).
    const ends = [...nS.keys()].sort((x, y) => (nS.get(y)![0].d - nS.get(x)![0].d) || (x < y ? -1 : x > y ? 1 : 0));
    for (const X of ends) {
      const nX = nb.get(X)!;
      let made = 0;
      for (const Z of ends) {
        if (++steps > o.maxSteps) { capped = true; break outer; }
        if ((++n & 255) === 0) yield;
        if (Z === X) continue;
        const nZ = nb.get(Z)!;
        const [small, big] = nX.size <= nZ.size ? [nX, nZ] : [nZ, nX];
        for (const Y of small.keys()) {
          if (++steps > o.maxSteps) { capped = true; break outer; }
          if ((++n & 255) === 0) yield;
          if (Y === S || Y === X || Y === Z || !big.has(Y)) continue;
          // Four different coins = four different pairs = four different pools.
          const p1s = nS.get(X)!, p2s = nX.get(Y)!, p3s = nb.get(Y)!.get(Z)!, p4s = nZ.get(S)!;
          for (const u1 of p1s) for (const u2 of p2s) for (const u3 of p3s) for (const u4 of p4s) {
            if (made >= o.perCoin) continue; // per-coin limit: a normal bound, not reported as "capped"
            made++;
            const prio = Math.min(u1.d, u2.d, u3.d, u4.d);
            const keys = [u1.k, u2.k, u3.k, u4.k];
            if (!keys.some((k) => wouldKeep(k, prio))) continue; // too shallow for every one of its pools
            keep({ id: loopId(S, keys), start: S, keys, tokens: [S, X, Y, Z], inIsA: [u1.a === S, u2.a === X, u3.a === Y, u4.a === Z], prio });
          }
        }
      }
    }
  }
  // The loops kept by at least one pool; trimmed to `room` (shallowest out first).
  const kept = new Set<EntryLoop>();
  for (const a of top.values()) for (const l of a) kept.add(l);
  if (kept.size > o.room) {
    const best = [...kept].sort(byPrio).slice(0, o.room);
    const ok = new Set(best);
    for (const [k, a] of top) { const b = a.filter((l) => ok.has(l)); if (b.length) top.set(k, b); else top.delete(k); }
    return { byPool: top, loops: best.length, capped: true };
  }
  return { byPool: top, loops: kept.size, capped };
}

// The LOOP INDEX: rebuilt in the background (bites), swapped in whole when
// done; a trigger only reads it. Never throws into the bot.
export class EntryLoopIndex<P> {
  private data: LoopIndexData = { byPool: new Map(), loops: 0, pools: 0, capped: false };
  private building = false;
  private lastFp = '';
  private lastBuiltAt = 0;
  lastMs = 0;
  builds = 0;
  constructor(
    readonly s: LoopIndexSettings,
    private readonly src: {
      pools: () => P[];                    // the pools copy 2 follows (the sidecar can replay only those)
      startCoins: string[];
      rules: () => LoopRules<P>;           // fresh each rebuild (tax results, coin rules change)
      now?: () => number;
      log?: (m: string) => void;
    },
  ) {}

  private now(): number { return (this.src.now ?? Date.now)(); }

  // Loops through this pool (deepest first), or none.
  loopsFor(key: string): EntryLoop[] { return this.data.byPool.get(lc(key)) ?? []; }
  info(): { loops: number; loops4: number; pools: number; capped: boolean; lastMs: number; builds: number; ageMs: number; seen: number; skipped: Record<string, number> } {
    return { loops: this.data.loops, loops4: this.data.loops4 ?? 0, pools: this.data.pools, capped: this.data.capped, lastMs: this.lastMs, builds: this.builds, ageMs: this.lastBuiltAt ? this.now() - this.lastBuiltAt : -1,
      seen: this.data.seen ?? 0, skipped: this.data.skipped ?? {} };
  }

  // Rebuild if the pool set changed or the index is older than rebuildMs.
  // `force`: rebuild anyway. Resolves true when a new index was put in place.
  async maybeRebuild(force = false): Promise<boolean> {
    if (this.building) return false;
    let pools: P[];
    let fp: string;
    try {
      pools = this.src.pools();
      const r = this.src.rules();
      fp = pools.map((p) => lc(r.key(p))).sort().join(',');
    } catch { return false; }
    const stale = this.now() - this.lastBuiltAt >= this.s.rebuildMs;
    if (!force && !stale && fp === this.lastFp) return false;
    this.building = true;
    const t0 = performance.now();
    try {
      const data = await runSteps(buildLoopIndexSteps(pools, this.src.startCoins, this.src.rules(), this.s), 'trig loop index', this.s.sliceMs);
      this.data = data;
      this.lastFp = fp;
      this.lastBuiltAt = this.now();
      this.builds++;
      return true;
    } catch (e) {
      this.src.log?.(`[trig-entry] loop index rebuild failed (kept the old one): ${(e as Error).message}`);
      return false;
    } finally {
      this.lastMs = Math.round((performance.now() - t0) * 100) / 100;
      this.building = false;
    }
  }

  // Background timer (unref'd): asks every checkMs.
  start(): void {
    void this.maybeRebuild(true);
    const t = setInterval(() => { void this.maybeRebuild(); }, this.s.checkMs);
    t.unref?.();
  }
}

// Hourly-line text for the reasons pools were left out of the loop index,
// biggest first, e.g. "1766 pools offered, left out: venue not cleared 900, ...".
export function loopSkipText(seen: number, skipped: Record<string, number>, top = 6): string {
  const list = Object.entries(skipped).sort((x, y) => y[1] - x[1]);
  if (!list.length) return `${seen} pools offered, none left out`;
  const shown = list.slice(0, top).map(([k, v]) => `${k} ${v}`).join(', ');
  const rest = list.slice(top).reduce((t, [, v]) => t + v, 0);
  return `${seen} pools offered, left out: ${shown}${rest ? `, other ${rest}` : ''}`;
}

// ---- per trigger: the moved pools' loops, ranked and capped -------------------
// Loops through any moved pool, each once (by id), in index order; then the
// same ranking as 2-pool routes (a start coin we hold first, then the quick
// price check). found = how many loops there were before the cap.
export function pickLoops(keys: string[], loopsFor: (key: string) => EntryLoop[], held: (l: EntryLoop) => boolean, score: (l: EntryLoop) => number | null, limit: number,
  rank: <R>(routes: R[], held: (r: R) => boolean, score: (r: R) => number | null, limit: number) => R[]): { loops: EntryLoop[]; found: number } {
  const seen = new Set<string>();
  const list: EntryLoop[] = [];
  for (const k of keys) for (const l of loopsFor(k)) { if (seen.has(l.id)) continue; seen.add(l.id); list.push(l); }
  if (!list.length || limit <= 0) return { loops: [], found: list.length };
  return { loops: rank(list, held, score, limit), found: list.length };
}

// QUICK PRICE CHECK of one loop (the model's maths, no node): profit in $ of
// a `usdSize` trade through the loop's pools' current states (3 or 4), before gas. null =
// can't price it. Same pool maths as the 2-pool quick check (roundTripQuote).
export function loopQuoteUsd(pools: PoolState[], inIsA: boolean[], usdSize: number, usdPer: number, dec: number): number | null {
  if (!(usdSize > 0) || !(usdPer > 0) || pools.length !== inIsA.length) return null;
  const scale = 10 ** dec;
  let amt: bigint | null = BigInt(Math.floor((usdSize / usdPer) * scale));
  for (let i = 0; i < pools.length; i++) {
    amt = computeAmountOut(pools[i], inIsA[i], amt);
    if (amt === null || amt <= 0n) return null;
  }
  return (Number(amt) / scale) * usdPer - usdSize;
}

// Quick price checks remembered per loop while its pool states (replaced,
// never edited, by the price cache) and the start coin's price are the same.
export class LoopScoreMemo {
  private m = new Map<string, { s: unknown[]; px: number; v: number | null }>();
  hits = 0;
  misses = 0;
  constructor(private readonly max = 20_000) {}
  get(id: string, states: unknown[], px: number, f: () => number | null): number | null {
    const e = this.m.get(id);
    if (e && e.px === px && e.s.length === states.length && e.s.every((x, i) => x === states[i])) { this.hits++; return e.v; }
    this.misses++;
    let v: number | null;
    try { v = f(); } catch { v = null; }
    if (v !== null && !Number.isFinite(v)) v = null;
    if (this.m.size >= this.max) this.m.clear(); // memory bound
    this.m.set(id, { s: states.slice(), px, v });
    return v;
  }
}

// ---- coin tax results, read-only (data/coin-tax.json) -------------------------
// The loop finder's tax tester (core/coinTax.ts, possibly in the loop worker
// thread) writes its results to this file once a minute. Same expiry rule:
// a passed coin counts for 6 h, then it is "not tested" again until re-tested.
export class CoinTaxFileView {
  private recs = new Map<string, { v: string; at: number }>();
  private readAt = 0;
  constructor(private readonly file: string, private readonly okMs = 6 * 3600_000, private readonly now: () => number = Date.now, private readonly reread = 60_000) {}
  // Re-read the file if the last read is older than `reread` (rebuilds only, never on a trigger).
  refresh(): void {
    const t = this.now();
    if (this.readAt && t - this.readAt < this.reread) return;
    this.readAt = t;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const next = new Map<string, { v: string; at: number }>();
      for (const [k, r] of Object.entries<any>(j?.coins ?? {})) if (typeof r?.v === 'string' && Number.isFinite(r?.at)) next.set(k.toLowerCase(), { v: r.v, at: r.at });
      this.recs = next;
    } catch { /* no file yet: nothing passed */ }
  }
  // 'ok' only while the pass is fresh; 'taxed' / 'blocked' stay bad; else undefined.
  verdict(token: string): 'ok' | 'taxed' | 'blocked' | undefined {
    const r = this.recs.get(lc(token));
    if (!r) return undefined;
    if (r.v === 'ok') return this.now() - r.at <= this.okMs ? 'ok' : undefined;
    return r.v === 'taxed' || r.v === 'blocked' ? r.v : undefined;
  }
  size(): number { return this.recs.size; }
}

// ---- asking for coin tax tests (Oct 26) ------------------------------------------
// The loop list only uses a middle coin that passed the tax test in the last
// 6 h. The tester used to belong to the old loop finder (LOOP_TRADER), which is
// off, so every pass expired and the list emptied. This asks a tax book to test
// the middle coins of the pools the loop list is offered: allowed coins only
// (the safety gate is unchanged), start coins (USDG / WETH) never. The book
// itself skips coins with a fresh result, caps its queue and its rate.
// Returns how many coins were asked for.
export function askLoopTaxTests<P>(
  pools: P[],
  r: { tokens: (p: P) => [string, string]; holder: (p: P) => string | null; allowed: (t: string) => boolean },
  startCoins: string[],
  book: { verdict: (t: string) => string | undefined; request: (t: string, holder: string) => void },
): number {
  const starts = new Set(startCoins.map(lc));
  const asked = new Set<string>();
  for (const p of pools) {
    let tokens: [string, string], holder: string | null;
    try { tokens = r.tokens(p); holder = r.holder(p); } catch { continue; }
    if (!holder) continue;
    for (const raw of tokens) {
      const t = lc(raw);
      if (!t || starts.has(t) || asked.has(t)) continue;
      try { if (!r.allowed(t)) continue; } catch { continue; }
      // Fresh pass or a known bad result: nothing to do (the book re-tests bad coins after 24 h itself).
      const v = book.verdict(t);
      if (v === 'ok') continue;
      asked.add(t);
      book.request(t, holder);
    }
  }
  return asked.size;
}

// ---- the guarded loop send -------------------------------------------------------
// What a loop candidate carries for its send (EntryCandidate.host).
export type EntryLoopHost = { kind: 'loop'; loop: EntryLoop; base: string; usdPer: number; dec: number; coins: string[] };

export type EntryLoopSendSettings = {
  lossCapUsd: number;       // LOOP_LIVE_LOSS_CAP_USD [2] gas lost on failed loops a day (shared with live loops)
  maxTradeUsd: number;      // LOOP_LIVE_MAX_TRADE_USD [10000]
  blockMs: number;          // a loop that failed on chain is not sent again for this long [30 min]
};

export interface EntryLoopSendDeps {
  now: () => number;
  live: () => boolean;                                    // really sending real trades
  // Live loops' own loss today and pause (execution/loopLive.ts): one shared cap.
  otherLossTodayUsd: () => number;
  otherPaused: () => boolean;
  // Our gas for a loop of `pools` pools (3 or 4; missing = 3, as before Oct 25).
  gasUsd: (flash: boolean, pools?: number) => number;
  isOutlier: (netUsd: number, sizeUsd: number) => boolean;
  safety: (sizeUsd: number, coins: string[]) => string | null;
  ready: () => string | null;                             // live readiness checks
  deadline: () => bigint | null;                          // null = block info stale
  executor: () => string | undefined;
  gasLimitOk: (gasUnits: number) => boolean;
  ownCovers: (token: string, amount: bigint) => boolean;  // the contract holds the whole amount (live)
  lenderOk: (lender: string, token: string, amount: bigint) => boolean; // still holds enough to lend
  lenderFeePips: (lender: string) => number;
  fire: (to: string, data: string) => Promise<{ live: boolean; txHash?: string; error?: string; signedAtMs?: number; skipped?: string }>;
  // After a real send: the same bookkeeping as other live trades (trade file, tracker, pending gas, scoreboard).
  afterSent: (hash: string, info: { label: string; sizeUsd: number; netUsd: number; flash: { lender: string; feePips: number } | null; kinds: number[]; poolKeys: string[]; gasUsd: number; failKey: [string, string]; pick: EntryPick }) => void;
  log: (m: string) => void;
  alert?: (html: string) => void;
  dayOf?: (ms: number) => string;
}

const torontoDay = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

export class EntryLoopSender {
  private day: string;
  private lossToday = 0;
  private pausedDay: string | null = null;
  private inflight = new Map<string, { id: string; pools: string[]; holdUsd: number; at: number }>();
  private failedUntil = new Map<string, number>();
  readonly hour = { gated: 0, sent: 0, dry: 0, won: 0, failed: 0, gasLostUsd: 0, why: {} as Record<string, number> };

  constructor(readonly s: EntryLoopSendSettings, private readonly d: EntryLoopSendDeps) { this.day = this.dayOf(d.now()); }

  private dayOf(ms: number): string { return (this.d.dayOf ?? torontoDay)(ms); }
  private rollDay(): void { const x = this.dayOf(this.d.now()); if (x !== this.day) { this.day = x; this.lossToday = 0; } }
  lossTodayUsd(): number { this.rollDay(); return this.lossToday; }
  pausedToday(): boolean { this.rollDay(); return this.pausedDay === this.day; }
  isOurs(hash: string): boolean { return this.inflight.has(lc(hash)); }
  private held(): { pools: Set<string>; ids: Set<string>; usd: number } {
    const t = this.d.now(), pools = new Set<string>(), ids = new Set<string>();
    let usd = 0;
    for (const [h, e] of this.inflight) {
      if (t - e.at > 10 * 60_000) { this.inflight.delete(h); continue; } // a lost result never holds forever
      ids.add(e.id); for (const p of e.pools) pools.add(p); usd += e.holdUsd;
    }
    return { pools, ids, usd };
  }

  // LOOP SAFEGUARDS checked by the entry point's gates() (null = fine):
  // loop loss cap (counting trades still in flight as if they fail, and the
  // live loop sender's losses), live loops paused today, loop size limit,
  // this loop failed on chain recently, a loop on these pools in flight.
  gate(p: EntryPick): string | null {
    const h = p.cand.host as EntryLoopHost | undefined;
    if (!h || h.kind !== 'loop') return 'not a loop candidate';
    if (this.pausedToday() || this.d.otherPaused()) return 'loop loss cap reached today';
    if (p.sizeUsd > this.s.maxTradeUsd) return `over the loop size limit ($${this.s.maxTradeUsd})`;
    const until = this.failedUntil.get(h.loop.id);
    if (until && until > this.d.now()) return 'this loop failed on chain recently';
    const fl = this.held();
    if (fl.ids.has(h.loop.id) || h.loop.keys.some((k) => fl.pools.has(k))) return 'a loop on these pools is still in flight';
    const flash = !!p.q.simOpts?.v3Lender;
    if (this.lossTodayUsd() + this.d.otherLossTodayUsd() + fl.usd + this.d.gasUsd(flash, h.loop.keys.length) > this.s.lossCapUsd) return 'loop loss cap (counting trades in flight)';
    return null;
  }

  private skip(why: string): { why: string } { this.hour.gated++; const k = why.replace(/\$[\d.,]+/g, '$N').slice(0, 60); this.hour.why[k] = (this.hour.why[k] ?? 0) + 1; return { why }; }

  // The send: the same steps as a live loop after its check (loopLive.ts):
  // outlier guard, safety gate, live checks, deadline, funding still there,
  // gas limit, the contract call with profit floor = the checked net, sender.
  // Funding is EXACTLY what the check used (own money, or that lender).
  async send(p: EntryPick, _trig: { hash: string; seenMs: number }): Promise<{ signedMs?: number; why?: string }> {
    try {
      const h = p.cand.host as EntryLoopHost;
      const g = this.gate(p);
      if (g) return this.skip(g);
      if (this.d.isOutlier(p.netUsd, p.sizeUsd)) return this.skip('outlier profit (too good to be true)');
      const unsafe = this.d.safety(p.sizeUsd, h.coins);
      if (unsafe) return this.skip(`safety gate: ${unsafe}`);
      const live = this.d.live();
      if (live) { const nr = this.d.ready(); if (nr) return this.skip(nr); }
      const deadline = live ? this.d.deadline() : 0n;
      if (deadline === null) return this.skip('block info stale');
      const trade = p.q.trade;
      const lender = p.q.simOpts?.v3Lender;
      const amountIn = p.amountIn;
      if (live) {
        if (lender) { if (!this.d.lenderOk(lender, trade.token, amountIn)) return this.skip('lender no longer holds enough'); }
        else if (!this.d.ownCovers(trade.token, amountIn)) return this.skip('own money too low for this loop');
      }
      if (!this.d.gasLimitOk(loopGasUnits(trade.hops.length) + (lender ? 100_000 : 0))) return this.skip('sender gas limit too low for this loop');
      const minProfit = usdToTokenUnits(p.netUsd, h.usdPer, h.dec);
      if (minProfit <= 0n) return this.skip('profit floor rounds to zero');
      const to = this.d.executor();
      if (live && !to) return this.skip('no trade contract set');
      const call = { token: trade.token, amountIn, minProfit, maxBlock: deadline, hops: trade.hops };
      const data = lender ? encodeExecuteV3FlashRaw(call, lender) : encodeExecuteRaw(call);
      const fired = await this.d.fire(to ?? '0x0000000000000000000000000000000000000000', data);
      if (!fired.live || !live) { this.hour.dry++; return { signedMs: fired.signedAtMs, why: fired.signedAtMs === undefined ? 'dry run' : undefined }; }
      if (fired.skipped) { this.d.log(`[trig-entry] loop ${fired.skipped}: ${p.cand.label}`); return this.skip('rust is sender'); }
      if (!fired.txHash) { this.d.log(`[trig-entry] loop SEND FAILED ${p.cand.label}: ${fired.error ?? 'no hash'}`); return this.skip('node refused the send'); }
      const gasUsd = this.d.gasUsd(!!lender, h.loop.keys.length);
      this.inflight.set(lc(fired.txHash), { id: h.loop.id, pools: h.loop.keys.slice(), holdUsd: gasUsd, at: this.d.now() });
      if (this.inflight.size > 500) this.inflight.delete(this.inflight.keys().next().value as string);
      this.hour.sent++;
      const flash = lender ? { lender, feePips: this.d.lenderFeePips(lender) } : null;
      this.d.log(`[trig-entry] loop SENT ${p.cand.label}: $${p.netUsd.toFixed(2)} after gas on $${Math.round(p.sizeUsd)} (${flash ? `flash loan ${flash.feePips / 10_000}%` : 'own money'}), tx ${fired.txHash}`);
      this.d.afterSent(fired.txHash, { label: p.cand.label, sizeUsd: p.sizeUsd, netUsd: p.netUsd, flash, kinds: trade.hops.map((x) => x.kind), poolKeys: h.loop.keys.slice(), gasUsd, failKey: p.cand.failKey ?? [p.cand.buyPool, p.cand.sellPool], pick: p });
      return { signedMs: fired.signedAtMs ?? this.d.now() };
    } catch (e) {
      return this.skip(`error: ${(e as Error).message}`);
    }
  }

  // The final result of one of OUR entry loop trades (live tracker). Other
  // hashes are ignored. Failed: its gas counts toward the loop loss cap and
  // the loop waits blockMs.
  noteResult(r: { hash: string; status: 'profit' | 'reverted' | 'dropped'; gasUsd: number; label?: string }): void {
    const e = this.inflight.get(lc(r.hash));
    if (!e) return;
    this.inflight.delete(lc(r.hash));
    this.rollDay();
    if (r.status === 'profit') { this.hour.won++; return; }
    if (r.status === 'dropped') return; // never mined: no gas lost
    this.hour.failed++;
    const gas = Number.isFinite(r.gasUsd) ? r.gasUsd : 0;
    this.hour.gasLostUsd += gas;
    this.lossToday += gas;
    this.failedUntil.set(e.id, this.d.now() + this.s.blockMs);
    if (this.failedUntil.size > 2_000) { const t = this.d.now(); for (const [k, v] of this.failedUntil) if (v <= t) this.failedUntil.delete(k); }
    if (this.lossToday + this.d.otherLossTodayUsd() >= this.s.lossCapUsd && this.pausedDay !== this.day) {
      this.pausedDay = this.day;
      const msg = `Fire-first loops PAUSED until tomorrow: $${(this.lossToday + this.d.otherLossTodayUsd()).toFixed(2)} of gas lost on failed loop trades today (limit $${this.s.lossCapUsd.toFixed(2)}). 2-pool trades keep running.`;
      this.d.log(`[trig-entry] ${msg}`);
      this.d.alert?.(`⏸️ <b>FIRE-FIRST LOOPS PAUSED</b>\n${msg}`);
    }
  }

  // One plain line for the hourly report; resets the hour.
  hourLine(): string {
    const h = this.hour;
    const why = Object.entries(h.why).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} ${n}`).join('; ');
    const line = `loops sent ${h.sent}${h.dry ? `, dry run ${h.dry}` : ''}, won ${h.won}, failed ${h.failed} (gas $${h.gasLostUsd.toFixed(2)}), loop gas lost today $${(this.lossTodayUsd() + this.d.otherLossTodayUsd()).toFixed(2)}/$${this.s.lossCapUsd.toFixed(2)}${this.pausedToday() ? ', PAUSED' : ''}${why ? ` | stopped: ${why}` : ''}`;
    Object.assign(this.hour, { gated: 0, sent: 0, dry: 0, won: 0, failed: 0, gasLostUsd: 0, why: {} });
    return line;
  }
}
