import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

// ============================================================================
// COPY 2: FOLLOW ONLY THE ACTIVE POOLS (Nov 5, COPY2_ACTIVE_MAX; off by default)
//
// Plain English:
//   Copy 2 (the fast check's own copy of our pools) normally follows EVERY
//   watched Robinhood pool (~1,500-1,800). Each one must be loaded from a
//   node first, and loads that take too long are thrown away and redone.
//   On a free node plan (Alchemy: 500 units a second) that is too much: in
//   the Nov 5 free test, 12 minutes at the plan's safe speed still left ~800
//   pools loading, and most of them never trade.
//
//   With COPY2_ACTIVE_MAX=N (> 0) copy 2 follows only about N pools: the
//   pairs that are BUSY right now, whole pairs at a time (a trade needs two
//   pools of the same pair):
//     - busy = events the push feed delivered for the pool in the last
//       10-20 minutes (counted by the push filter, core/poolSubFilter.ts);
//     - each pair's score is the sum of its pools' events; busiest pairs
//       first, at most COPY2_ACTIVE_PER_PAIR (8) of each pair's pools (its
//       busiest), until N pools are picked;
//     - a pool that is not in any watched pair (loop extra pool) is left out;
//     - right after a start (too few events counted yet) the list saved by
//       the last run (data/copy2-active.json, under 24 h old) is used; with
//       no saved list, pairs are ranked by the money in their pools.
//   Worked out again every COPY2_ACTIVE_REFRESH_S (300) seconds. Pools that
//   drop off stay followed for copy 2's own drop grace (COPY2_DROP_GRACE_S,
//   COPY2_DROP_GRACE_MAX), so a pair that goes quiet for a moment is not
//   reloaded when it comes back.
//
//   0 / unset = OFF: exactly the old behaviour (every watched pool).
//   Reads only memory and one small file. Never sends anything.
// ============================================================================

export interface Copy2ActiveSettings {
  max: number;        // COPY2_ACTIVE_MAX: about this many pools (0 = off)
  perPair: number;    // COPY2_ACTIVE_PER_PAIR: most pools taken from one pair
  refreshMs: number;  // COPY2_ACTIVE_REFRESH_S in ms
  minEvents: number;  // COPY2_ACTIVE_MIN_EVENTS: events needed before ranking by events
  file: string;       // COPY2_ACTIVE_FILE: the saved list
}

const num = (v: string | undefined, d: number, min = 0): number => {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n >= min ? n : d;
};

export function copy2ActiveSettings(env: Record<string, string | undefined> = process.env): Copy2ActiveSettings {
  return {
    max: Math.floor(num(env.COPY2_ACTIVE_MAX, 0)),
    perPair: Math.max(2, Math.floor(num(env.COPY2_ACTIVE_PER_PAIR, 8))),
    refreshMs: 1000 * num(env.COPY2_ACTIVE_REFRESH_S, 300, 10),
    minEvents: Math.floor(num(env.COPY2_ACTIVE_MIN_EVENTS, 200)),
    file: env.COPY2_ACTIVE_FILE || 'data/copy2-active.json',
  };
}

export interface Copy2ActiveDeps {
  pairs: () => readonly (readonly string[])[];      // watched pairs, each a list of pool keys
  events: () => ReadonlyMap<string, number>;        // recent pushed events per pool key (lower case)
  depthUsd: (key: string) => number | null;         // money in the pool ($), null = unknown
  now?: () => number;
  log?: (line: string) => void;
}

const DAY = 24 * 3_600_000;

export class Copy2ActivePicker {
  readonly s: Copy2ActiveSettings;
  private readonly d: Copy2ActiveDeps;
  private readonly now: () => number;
  private chosen: Set<string> | null = null;
  private at = -Infinity;
  last: { from: string; pools: number; pairs: number; of: number } | null = null;

  constructor(s: Copy2ActiveSettings, d: Copy2ActiveDeps) {
    this.s = s;
    this.d = d;
    this.now = d.now ?? Date.now;
  }

  get on(): boolean { return this.s.max > 0; }

  // The keys copy 2 should follow, out of `keys` (order kept). Off = `keys`.
  filter(keys: readonly string[]): string[] {
    if (!this.on) return [...keys];
    try {
      const t = this.now();
      if (!this.chosen || t - this.at >= this.s.refreshMs) {
        this.chosen = this.pick(keys);
        this.at = t;
      }
      const c = this.chosen;
      return keys.filter((k) => c.has(k.toLowerCase()));
    } catch (e) {
      // Never break copy 2: on any error, the old behaviour.
      try { (this.d.log ?? console.log)(`[copy2-active] pick failed (following all pools): ${(e as Error).message}`); } catch { /* logging only */ }
      return [...keys];
    }
  }

  private pick(keys: readonly string[]): Set<string> {
    const wanted = new Set(keys.map((k) => k.toLowerCase()));
    // Pairs restricted to the keys copy 2 could follow at all.
    const groups: string[][] = [];
    for (const p of this.d.pairs()) {
      const g = [...new Set(p.map((k) => k.toLowerCase()))].filter((k) => wanted.has(k));
      if (g.length >= 2) groups.push(g);
    }
    const ev = this.d.events();
    let total = 0;
    for (const k of wanted) total += ev.get(k) ?? 0;
    let from: string;
    let score: (k: string) => number;
    if (total >= this.s.minEvents) {
      from = 'events';
      score = (k) => ev.get(k) ?? 0;
    } else {
      const saved = this.loadSaved();
      if (saved) {
        from = 'saved list';
        score = (k) => (saved.has(k) ? 1 : 0) + (ev.get(k) ?? 0);
      } else {
        from = 'money';
        score = (k) => { const v = this.d.depthUsd(k); return v !== null && Number.isFinite(v) ? v : 0; };
      }
    }
    const ranked = groups.map((g) => {
      const members = g.map((k) => ({ k, s: score(k) })).sort((a, b) => b.s - a.s).slice(0, this.s.perPair);
      return { members, s: members.reduce((a, m) => a + m.s, 0) };
    }).filter((g) => g.s > 0).sort((a, b) => b.s - a.s);
    const out = new Set<string>();
    let pairs = 0;
    for (const g of ranked) {
      if (out.size >= this.s.max) break;
      for (const m of g.members) out.add(m.k);
      pairs++;
    }
    this.last = { from, pools: out.size, pairs, of: wanted.size };
    try { (this.d.log ?? console.log)(`[copy2-active] following ${out.size} of ${wanted.size} pools (${pairs} busiest pairs, ranked by ${from}; COPY2_ACTIVE_MAX ${this.s.max})`); } catch { /* logging only */ }
    if (from === 'events') this.save(out);
    return out;
  }

  private loadSaved(): Set<string> | null {
    try {
      if (!existsSync(this.s.file)) return null;
      const j = JSON.parse(readFileSync(this.s.file, 'utf8')) as { at?: number; keys?: unknown };
      if (typeof j.at !== 'number' || this.now() - j.at > DAY || !Array.isArray(j.keys)) return null;
      const s = new Set(j.keys.filter((k): k is string => typeof k === 'string').map((k) => k.toLowerCase()));
      return s.size ? s : null;
    } catch { return null; }
  }

  private save(keys: Set<string>): void {
    try {
      mkdirSync(dirname(this.s.file), { recursive: true });
      const tmp = this.s.file + '.tmp';
      writeFileSync(tmp, JSON.stringify({ at: this.now(), keys: [...keys] }));
      renameSync(tmp, this.s.file);
    } catch { /* best effort */ }
  }
}
