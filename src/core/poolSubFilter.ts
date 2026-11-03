import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { HANDLED_TOPICS, V4_SWAP_TOPIC, type RpcLog } from './blockReader';
import { topicChunks } from './blockReaderWs';

// ============================================================================
// POOL SUBSCRIPTION FILTER (Nov 2, POOL_SUB_FILTER)
//
// Plain English:
//   The push block reader (core/blockReaderWs.ts) asks the node to push every
//   event of every watched pool. Chainstack bills each pushed event, and the
//   plan is running out. This file decides which watched pools are NOT worth
//   a push subscription, and counts what the push feed really delivers.
//
//   A watched pool is KEPT when ANY of these is true:
//     - copy 2 (the fast check's own copy of our pools) follows it
//     - it was in a trade idea / check / trigger chance / loop find in the
//       last POOL_SUB_USE_DAYS days (default 5)
//     - it holds at least POOL_SUB_MIN_USD (default $2,000), or its money
//       can't be told (unknown = kept, to be safe)
//     - it joined the watch list less than POOL_SUB_NEW_GRACE_H hours ago
//       (default 24; this is also the warm-up after the first start)
//     - the sweep found it busy in the last 24 h (see below)
//   Everything else is DROPPED from the push subscription. A dropped pool is
//   still watched and still priced (the watch list re-reads every pool every
//   5 s); it just doesn't get block-by-block pushes.
//
//   The drop list is worked out ONCE A DAY (POOL_SUB_RECHECK_H, default 24)
//   and kept in data/pool-sub-filter.json, so the many restarts (every
//   deploy) don't reset it. Between re-checks pools only ever come BACK:
//     - copy 2 starts following it          -> back at once
//     - it shows up in a trade idea / check -> back at once
//     - its money goes over the floor        -> back at the next 10 min check
//     - SWEEP: every POOL_SUB_SWEEP_MIN (10) minutes ONE eth_getLogs per
//       2,000 blocks over the dropped pools (cheap: a handful of requests,
//       vs thousands of pushed events saved); a pool with at least
//       POOL_SUB_BUSY_EVENTS (20) events in that window -> back.
//   A changed list is picked up by the push reader at its next renewal
//   (at most every 10 min), so re-adds cost at most one renewal each time.
//
//   POOL_SUB_FILTER:
//     0 / off / unset  OLD BEHAVIOUR: every watched pool subscribed. The
//                      counting and the 10-minute line still run and say
//                      what WOULD be dropped and how many events that saves
//                      (a free dry run before switching on).
//     1 / on           drop list used.
//
//   Every 10 minutes one line:
//     [subfilter] ON|OFF (dry run) · pools subscribed S, dropped D, re-added R
//       · events/min E (pools a, v4 b, transfers c, other d, headers e)
//       · dropped pools' events/min (last 10 min) ...
//
//   Read only. Never sends a transaction. Never logs a node URL.
// ============================================================================

export interface PoolSubSettings {
  on: boolean;            // POOL_SUB_FILTER=1: use the drop list
  useDays: number;        // POOL_SUB_USE_DAYS: a pool used this recently is kept
  minUsd: number;         // POOL_SUB_MIN_USD: a pool with this much money is kept
  newGraceH: number;      // POOL_SUB_NEW_GRACE_H: new watch-list pools are kept this long
  recheckH: number;       // POOL_SUB_RECHECK_H: full re-check of the drop list
  sweepMin: number;       // POOL_SUB_SWEEP_MIN: busy sweep every this many minutes (0 = no sweep)
  busyEvents: number;     // POOL_SUB_BUSY_EVENTS: events in one sweep window that bring a pool back
  sweepRange: number;     // POOL_SUB_SWEEP_RANGE: most blocks in one eth_getLogs
  file: string;           // where the history and drop list are kept
}

const isOn = (v: string | undefined) => /^(1|on|true|yes)$/i.test(String(v ?? '').trim());
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : d;
};

export function poolSubSettingsFromEnv(env: Record<string, string | undefined> = process.env): PoolSubSettings {
  return {
    on: isOn(env.POOL_SUB_FILTER),
    useDays: num(env.POOL_SUB_USE_DAYS, 5),
    minUsd: num(env.POOL_SUB_MIN_USD, 2_000),
    newGraceH: num(env.POOL_SUB_NEW_GRACE_H, 24),
    recheckH: Math.max(1, num(env.POOL_SUB_RECHECK_H, 24)),
    sweepMin: num(env.POOL_SUB_SWEEP_MIN, 10),
    busyEvents: Math.max(1, num(env.POOL_SUB_BUSY_EVENTS, 20)),
    sweepRange: Math.max(100, num(env.POOL_SUB_SWEEP_RANGE, 2_000)),
    file: env.POOL_SUB_FILE || 'data/pool-sub-filter.json',
  };
}

// What the filter needs from the bot (all cheap, all from memory).
export interface PoolSubDeps {
  // Every watched pool key (contract address, or 32-byte V4 pool id), lower case.
  watchKeys: () => readonly string[];
  // Keys copy 2 follows right now (empty set = copy 2 off). Never dropped.
  copy2Keys: () => ReadonlySet<string>;
  // Money in the pool in $ (null = can't tell -> kept).
  depthUsd: (key: string) => number | null;
  // Extra "used" pools pulled at each re-check (e.g. rival loop wins, 24 h).
  extraUsed?: () => Iterable<string>;
  // HTTP node for the busy sweep (eth_blockNumber / eth_getLogs). Missing = no sweep.
  rpc?: (method: string, params: unknown[]) => Promise<any>;
  // Counted once per sweep request (node usage lines).
  countRequest?: () => void;
  poolManager: string;    // V4 PoolManager (V4 pools are swept there by pool id)
  now?: () => number;
  log?: (line: string) => void;
}

// Why a pool was brought back (for the 10-minute line).
type ReaddWhy = 'copy2' | 'used' | 'money' | 'busy';

// What the push reader tells us it delivered, per subscription kind.
export type PushKind = 'pools' | 'v4' | 'tf' | 'heads';

interface SavedState {
  v: 1;
  use: Record<string, number>;        // key -> last time it was used
  firstSeen: Record<string, number>;  // key -> first time on the watch list
  busyAt: Record<string, number>;     // key -> last time the sweep found it busy
  drop: string[];                     // the drop list
  dropAt: number;                     // when the drop list was worked out (0 = never)
  sweptTo: number;                    // last block the sweep covered
}

const ADDR = /^0x[0-9a-f]{40}$/;
const ID = /^0x[0-9a-f]{64}$/;
const HOUR = 3_600_000;
const unpad = (t: unknown): string | null => (typeof t === 'string' && t.length === 66 ? ('0x' + t.slice(26)).toLowerCase() : null);

export class PoolSubFilter {
  readonly s: PoolSubSettings;
  private readonly d: PoolSubDeps;
  private readonly now: () => number;
  private use = new Map<string, number>();
  private firstSeen = new Map<string, number>();
  private busyAt = new Map<string, number>();
  private drop = new Set<string>();       // pools left out of the subscription
  private dropAt = 0;
  private sweptTo = -1;
  private sweeping = false;
  private dirty = false;
  // Counting (10-minute window; the previous window is kept for the line).
  private win = { start: 0, total: 0, byKind: { pools: 0, v4: 0, tf: 0, other: 0, heads: 0 } };
  private perPool = new Map<string, number>();      // this window's events per pool key
  private lastPerPool = new Map<string, number>();  // previous window's
  private readded: Record<ReaddWhy, number> = { copy2: 0, used: 0, money: 0, busy: 0 };
  private readdedTotal = 0;
  private sweeps = { runs: 0, requests: 0, errors: 0 };

  constructor(s: PoolSubSettings, d: PoolSubDeps) {
    this.s = s;
    this.d = d;
    this.now = d.now ?? Date.now;
    this.win.start = this.now();
    this.load();
  }

  private log(line: string): void { try { (this.d.log ?? console.log)(`[subfilter] ${line}`); } catch { /* logging only */ } }

  // ---- history ---------------------------------------------------------------

  // A pool was in a trade idea / check / chance / loop find. A dropped pool
  // comes back at once (the push reader picks it up at its next renewal).
  noteUsed(keys: Iterable<string | null | undefined>): void {
    try {
      const t = this.now();
      for (const k0 of keys) {
        if (typeof k0 !== 'string') continue;
        const k = k0.toLowerCase();
        if (!ADDR.test(k) && !ID.test(k)) continue;
        this.use.set(k, t);
        if (this.drop.delete(k)) this.readd('used');
      }
    } catch { /* never throws into the bot */ }
  }

  private readd(why: ReaddWhy): void { this.readded[why]++; this.readdedTotal++; this.dirty = true; }

  // ---- the subscription list -----------------------------------------------

  // The push reader's watch list with the dropped pools taken out (filter
  // on), or unchanged (filter off). Copy 2's pools are never taken out, even
  // if copy 2 started following one after the drop list was made.
  apply(pools: readonly string[], ids: Iterable<string>): { pools: string[]; ids: string[] } {
    const allIds = [...ids];
    if (!this.s.on || this.drop.size === 0) return { pools: [...pools], ids: allIds };
    let c2: ReadonlySet<string>;
    try { c2 = this.d.copy2Keys(); } catch { c2 = new Set(); }
    for (const k of this.drop) if (c2.has(k)) { this.drop.delete(k); this.readd('copy2'); }
    const outP = pools.filter((k) => !this.drop.has(k.toLowerCase()));
    const outI = allIds.filter((k) => !this.drop.has(k.toLowerCase()));
    // Safety: never hand the reader an empty contract list (it would then
    // subscribe to nothing at all). Keep everything instead.
    if (outP.length === 0 && pools.length > 0) return { pools: [...pools], ids: allIds };
    return { pools: outP, ids: outI };
  }

  isDropped(key: string): boolean { return this.s.on && this.drop.has(key.toLowerCase()); }

  // ---- the daily re-check ----------------------------------------------------

  // Who would be dropped right now, and why the rest are kept.
  decide(): { drop: Set<string>; kept: { copy2: number; used: number; money: number; fresh: number; busy: number }; watched: number; keys: Set<string>; graceOnly: Set<string> } {
    const t = this.now();
    const kept = { copy2: 0, used: 0, money: 0, fresh: 0, busy: 0 };
    const drop = new Set<string>();
    const graceOnly = new Set<string>();   // would be dropped once their new-pool grace ends
    let c2: ReadonlySet<string>;
    try { c2 = this.d.copy2Keys(); } catch { c2 = new Set(); }
    try { for (const k of this.d.extraUsed?.() ?? []) if (typeof k === 'string') this.use.set(k.toLowerCase(), Math.max(this.use.get(k.toLowerCase()) ?? 0, t)); } catch { /* optional */ }
    const useCut = t - this.s.useDays * 24 * HOUR;
    const freshCut = t - this.s.newGraceH * HOUR;
    const busyCut = t - 24 * HOUR;
    const keys = [...new Set(this.d.watchKeys().map((k) => k.toLowerCase()))];
    for (const k of keys) {
      if (!this.firstSeen.has(k)) { this.firstSeen.set(k, t); this.dirty = true; }
      if (c2.has(k)) { kept.copy2++; continue; }
      if ((this.use.get(k) ?? 0) >= useCut) { kept.used++; continue; }
      if ((this.busyAt.get(k) ?? 0) >= busyCut) { kept.busy++; continue; }
      let usd: number | null = null;
      try { usd = this.d.depthUsd(k); } catch { usd = null; }
      if (usd === null || !Number.isFinite(usd) || usd >= this.s.minUsd) { kept.money++; continue; }
      // New on the watch list (or the first day after the very first start):
      // kept for now, but listed so the dry run can say what comes later.
      if ((this.firstSeen.get(k) ?? t) > freshCut) { kept.fresh++; graceOnly.add(k); continue; }
      drop.add(k);
    }
    return { drop, kept, watched: keys.length, keys: new Set(keys), graceOnly };
  }

  // Run every 10 minutes by the bot: re-check once a day, bring back pools
  // that got money, forget old history, save, and print the line.
  tick(): void {
    try {
      const t = this.now();
      const due = t - this.dropAt >= this.s.recheckH * HOUR;
      const r = this.decide();
      if (due) {
        this.drop = r.drop;
        this.dropAt = t;
        this.dirty = true;
        this.log(`re-check: ${r.watched} watched pools, ${r.drop.size} dropped from the push feed${this.s.on ? '' : ' (dry run: not applied)'}; kept because copy 2 follows ${r.kept.copy2}, used in ${this.s.useDays} d ${r.kept.used}, money $${this.s.minUsd}+ or unknown ${r.kept.money}, new ${r.kept.fresh}, busy ${r.kept.busy}`);
      } else {
        // Between re-checks pools only come back (never newly dropped).
        let c2: ReadonlySet<string>;
        try { c2 = this.d.copy2Keys(); } catch { c2 = new Set(); }
        for (const k of [...this.drop]) {
          if (r.drop.has(k)) continue;
          this.drop.delete(k);
          // Left the watch list: simply forgotten (not a re-add).
          if (!r.keys.has(k)) { this.dirty = true; continue; }
          this.readd(c2.has(k) ? 'copy2' : 'money');
        }
      }
      this.prune(t);
      this.line(r);
      this.save();
    } catch (e) {
      this.log(`tick failed (ignored): ${(e as Error).message}`);
    }
  }

  private prune(t: number): void {
    const useCut = t - (this.s.useDays + 1) * 24 * HOUR;
    for (const [k, v] of this.use) if (v < useCut) { this.use.delete(k); this.dirty = true; }
    for (const [k, v] of this.busyAt) if (v < t - 48 * HOUR) { this.busyAt.delete(k); this.dirty = true; }
    // First-seen: forget pools that left the watch list over a week ago
    // (bounded file; a pool that comes back starts a fresh grace).
    if (this.firstSeen.size > 20_000) {
      const watched = new Set(this.d.watchKeys().map((k) => k.toLowerCase()));
      for (const k of this.firstSeen.keys()) if (!watched.has(k)) this.firstSeen.delete(k);
      this.dirty = true;
    }
  }

  // ---- counting ----------------------------------------------------------------

  // Every pushed event, as the push reader got it. Cheap (a few map updates).
  countPushed(kind: PushKind, logs: readonly RpcLog[] | null, pm: string): void {
    try {
      if (kind === 'heads') { this.win.total++; this.win.byKind.heads++; return; }
      for (const l of logs ?? []) {
        this.win.total++;
        const addr = (l?.address ?? '').toLowerCase();
        let key: string | null = null;
        if (kind === 'tf') {
          // Coin transfer into / out of a pool: counted for that pool.
          this.win.byKind.tf++;
          const to = unpad(l?.topics?.[2]), from = unpad(l?.topics?.[1]);
          key = to && this.firstSeen.has(to) ? to : from && this.firstSeen.has(from) ? from : (to ?? from);
        } else if (addr === pm && l?.topics?.[1]) {
          this.win.byKind.v4++;
          key = String(l.topics[1]).toLowerCase();
        } else if (this.firstSeen.has(addr) || kind === 'pools') {
          if (this.firstSeen.has(addr)) this.win.byKind.pools++; else this.win.byKind.other++;
          key = addr;
        } else {
          this.win.byKind.other++;
        }
        if (key) this.perPool.set(key, (this.perPool.get(key) ?? 0) + 1);
      }
    } catch { /* counting only */ }
  }

  // Events per minute in the window that just ended, and the window reset.
  private line(r: ReturnType<PoolSubFilter['decide']>): void {
    const t = this.now();
    const mins = Math.max(1 / 60, (t - this.win.start) / 60_000);
    const per = (n: number) => (n / mins).toFixed(1);
    const k = this.win.byKind;
    // Events of the pools on the drop list (on: should be ~0 once renewed;
    // off: what switching on would save).
    const dropSet = this.s.on ? this.drop : r.drop;
    let dropEv = 0, graceEv = 0;
    for (const key of dropSet) dropEv += this.perPool.get(key) ?? 0;
    for (const key of r.graceOnly) graceEv += this.perPool.get(key) ?? 0;
    // Upside the current rules leave on the table: pools kept ONLY because
    // copy 2 follows them (no use in the window, under the money floor).
    let c2: ReadonlySet<string>;
    try { c2 = this.d.copy2Keys(); } catch { c2 = new Set(); }
    const useCut = t - this.s.useDays * 24 * HOUR;
    let c2Idle = 0, c2IdleEv = 0;
    for (const key of c2) {
      if ((this.use.get(key) ?? 0) >= useCut) continue;
      let usd: number | null = null;
      try { usd = this.d.depthUsd(key); } catch { usd = null; }
      if (usd === null || !Number.isFinite(usd) || usd >= this.s.minUsd) continue;
      c2Idle++; c2IdleEv += this.perPool.get(key) ?? 0;
    }
    // Busiest pools this window (short keys), to see where the events go.
    const top = [...this.perPool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([key, n]) => `${key.slice(0, 8)}${dropSet.has(key) ? '(dropped)' : c2.has(key) ? '(c2)' : ''} ${per(n)}`).join(', ');
    const subscribed = Math.max(0, r.watched - (this.s.on ? this.drop.size : 0));
    const ra = this.readded;
    this.log(`${this.s.on ? 'ON' : 'OFF (dry run, old subscriptions)'} · pools subscribed ${subscribed}, ${this.s.on ? 'dropped' : 'would drop'} ${dropSet.size} of ${r.watched}` +
      ` · re-added ${this.readdedTotal} (copy 2 ${ra.copy2}, used ${ra.used}, money ${ra.money}, busy ${ra.busy})` +
      ` · events/min ${per(this.win.total)} (pools ${per(k.pools)}, v4 ${per(k.v4)}, transfers ${per(k.tf)}, other ${per(k.other)}, headers ${per(k.heads)})` +
      ` · ${this.s.on ? 'dropped pools still pushing' : 'would save'} ${per(dropEv)}/min (~${Math.round(dropEv / mins * 1440).toLocaleString('en-US')}/day)` +
      (r.graceOnly.size ? ` · after the new-pool grace +${r.graceOnly.size} pools (${per(graceEv)}/min)` : '') +
      ` · copy-2-only idle small pools ${c2Idle} (${per(c2IdleEv)}/min, kept by rule)` +
      ` · sweeps ${this.sweeps.runs} (${this.sweeps.requests} requests, ${this.sweeps.errors} errors)` +
      (top ? ` · busiest: ${top}` : '') +
      ` · window ${Math.round(mins)} min`);
    this.lastPerPool = this.perPool;
    this.perPool = new Map();
    this.win = { start: t, total: 0, byKind: { pools: 0, v4: 0, tf: 0, other: 0, heads: 0 } };
  }

  // Facts for tests and the status page.
  stats(): { on: boolean; dropped: number; readded: number; byWhy: Record<ReaddWhy, number>; windowEvents: number; dropAt: number } {
    return { on: this.s.on, dropped: this.drop.size, readded: this.readdedTotal, byWhy: { ...this.readded }, windowEvents: this.win.total, dropAt: this.dropAt };
  }
  droppedKeys(): string[] { return [...this.drop]; }
  lastWindowEvents(key: string): number { return this.lastPerPool.get(key.toLowerCase()) ?? 0; }

  // ---- busy sweep ----------------------------------------------------------------

  // One eth_getLogs per sweepRange blocks (and per 400 pools / ids) over the
  // dropped pools since the last sweep. A pool with busyEvents or more
  // events comes back. Only while the filter is on and something is dropped.
  async sweep(): Promise<void> {
    if (!this.s.on || !this.d.rpc || this.sweeping || this.drop.size === 0) return;
    this.sweeping = true;
    this.sweeps.runs++;
    try {
      const head = Number(BigInt(await this.call('eth_blockNumber', [])));
      if (!Number.isFinite(head) || head <= 0) return;
      // First sweep: look back about one sweep window (assume ~10 blocks/s,
      // capped at one range so the first sweep is as cheap as the others).
      let from = this.sweptTo >= 0 ? this.sweptTo + 1 : head - Math.min(this.s.sweepRange, Math.max(1, this.s.sweepMin) * 600) + 1;
      // Never more than 3 ranges in one go (after a long pause the old part is skipped).
      if (head - from + 1 > this.s.sweepRange * 3) from = head - this.s.sweepRange * 3 + 1;
      if (from > head) return;
      const pools = [...this.drop].filter((k) => ADDR.test(k));
      const ids = [...this.drop].filter((k) => ID.test(k));
      const pm = this.d.poolManager.toLowerCase();
      const counts = new Map<string, number>();
      for (let a = from; a <= head; a += this.s.sweepRange) {
        const b = Math.min(head, a + this.s.sweepRange - 1);
        const range = { fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) };
        for (const part of topicChunks(pools, 400)) {
          const logs: RpcLog[] = await this.call('eth_getLogs', [{ ...range, address: part, topics: [HANDLED_TOPICS.filter((t) => t !== V4_SWAP_TOPIC)] }]);
          for (const l of Array.isArray(logs) ? logs : []) { const k = (l?.address ?? '').toLowerCase(); counts.set(k, (counts.get(k) ?? 0) + 1); }
        }
        if (pm) for (const part of topicChunks(ids, 400)) {
          const logs: RpcLog[] = await this.call('eth_getLogs', [{ ...range, address: pm, topics: [[V4_SWAP_TOPIC], part] }]);
          for (const l of Array.isArray(logs) ? logs : []) { const k = String(l?.topics?.[1] ?? '').toLowerCase(); counts.set(k, (counts.get(k) ?? 0) + 1); }
        }
      }
      this.sweptTo = head;
      const t = this.now();
      for (const [k, n] of counts) {
        if (n < this.s.busyEvents || !this.drop.has(k)) continue;
        this.drop.delete(k);
        this.busyAt.set(k, t);
        this.readd('busy');
      }
    } catch {
      this.sweeps.errors++;
    } finally {
      this.sweeping = false;
    }
  }

  private async call(method: string, params: unknown[]): Promise<any> {
    this.sweeps.requests++;
    try { this.d.countRequest?.(); } catch { /* counting only */ }
    return this.d.rpc!(method, params);
  }

  // ---- saved state -----------------------------------------------------------------

  private load(): void {
    try {
      if (!existsSync(this.s.file)) return;
      const j = JSON.parse(readFileSync(this.s.file, 'utf8')) as Partial<SavedState>;
      if (!j || j.v !== 1) return;
      const m = (o: unknown) => new Map(Object.entries(o && typeof o === 'object' ? o as Record<string, number> : {}).filter(([, v]) => typeof v === 'number'));
      this.use = m(j.use); this.firstSeen = m(j.firstSeen); this.busyAt = m(j.busyAt);
      this.drop = new Set(Array.isArray(j.drop) ? j.drop.filter((k) => typeof k === 'string').map((k) => k.toLowerCase()) : []);
      this.dropAt = typeof j.dropAt === 'number' ? j.dropAt : 0;
      this.sweptTo = typeof j.sweptTo === 'number' ? j.sweptTo : -1;
    } catch {
      this.log('saved state unreadable, starting fresh (nothing is dropped for the first day)');
    }
  }

  save(force = false): void {
    if (!this.dirty && !force) return;
    try {
      const out: SavedState = {
        v: 1, use: Object.fromEntries(this.use), firstSeen: Object.fromEntries(this.firstSeen), busyAt: Object.fromEntries(this.busyAt),
        drop: [...this.drop], dropAt: this.dropAt, sweptTo: this.sweptTo,
      };
      mkdirSync(dirname(this.s.file), { recursive: true });
      const tmp = `${this.s.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(out));
      renameSync(tmp, this.s.file);
      this.dirty = false;
    } catch (e) {
      this.log(`save failed (ignored): ${(e as Error).message}`);
    }
  }
}
