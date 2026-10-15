import type { PoolState } from './types';
import type { ConfirmedInfo } from './poolCache';
import type { TriggerTrade, LoopFixSwitches } from './loopPrices';
import type { LoopTraderConfig, LoopHour } from './loopTrader';
import type { LoopNodeConfig } from './loopNode';

// ============================================================================
// LOOP WORKER: WHAT THE MAIN THREAD SENDS (Oct 15, owner approved). PRACTICE ONLY.
//
// Plain English:
//   The loop trader (finding 3-8 pool loops and practice-checking them) now
//   runs in its OWN thread, the "loop worker" (core/loopWorkerCore.ts and
//   core/loopWorkerEntry.ts). The main thread, which handles the trade feed
//   and the 2-pool money path, only does the cheap part:
//     - every loop scan moment (at most one every 50 ms) it looks at the loop
//       pools and sends ONLY the ones whose state changed since last time;
//     - feed trades (for the loop "pending trades" book) and rival loop wins
//       are written down in a short list and sent with the next message;
//     - coin prices, decimals, names, gas cost for loops and the like are
//       sent when they change (looked at every few seconds).
//   This file holds that cheap part (MainLoopFeeder) and the message shapes.
//   It never runs the loop maths and never sends a trade.
//
// Safety limits:
//   - at most one message per ~50 ms (the existing loop scan pause);
//   - at most 3 messages "in the post" at once: if the worker falls behind,
//     nothing new is sent until it catches up (pool changes are not lost,
//     they are simply sent later in one go; the feed-trade list keeps the
//     newest LOOP_WORKER_MAX_NOTES (5,000) and counts what it dropped);
//   - a big first send (start / worker restart) is split into pieces of at
//     most 250 pools so no single message freezes the main thread.
// ============================================================================

// ---- Message shapes --------------------------------------------------------

// One pool as the main thread sees it: its main-cache state (m), its
// block-confirmed state (c) and where that came from (i). Any may be missing.
export interface PoolRec { m?: PoolState; c?: PoolState; i?: ConfirmedInfo }

// A feed note, in feed order: [0, tx hash] = a feed transaction was seen;
// [1, pool, trade] = a decoded trade on a pool (for the pending-trades book).
export type LoopNote = [0, string] | [1, string, TriggerTrade];

// A rival loop win (only the fields the loop trader's race count needs).
export interface RivalNote { bot: string; pools: number; route?: string[]; grossUsd: number | null; gasUsd: number | null; failed: boolean; t: number }

// Coin / venue facts the loop maths needs, sent when they change.
export interface EnvDelta {
  usd?: [string, number | null][];              // coin -> USD price
  dec?: [string, number | null][];              // coin -> exact decimals (null = not known)
  sym?: [string, string][];                     // coin -> short name for logs
  tradable?: [string, boolean][];               // coin -> on the vetted list
  dex?: [string, boolean][];                    // exchange -> allowed in practice checks
  bal?: [string, string, bigint | null][];      // V3 pool, coin -> real coin balance (null = not known)
  rivalPools?: string[];                        // pools rival loop wins used (last 24 h)
}

export interface LoopBatch {
  t: 'batch';
  seq: number;
  now: number;                 // main thread clock when this was built
  head: number | null;         // chain's current block (for event-fee age)
  gas: number[];               // our gas in USD for a loop of N pools (index = N, 2-8)
  budgetOk: boolean;           // loop node's daily allowance under 80% used
  keys?: string[];             // watched pools, in order (only when the list changed)
  extraKeys?: string[] | null; // extra single loop pools (only when changed; null = feature off)
  pools: [string, PoolRec | null][]; // changed pools (null = forget it)
  notes: LoopNote[];
  droppedNotes: number;        // feed notes dropped because the worker was behind
  rivals: RivalNote[];
  env?: EnvDelta;
  scan: boolean;               // run a loop scan after applying this
  partial: boolean;            // more pieces follow: apply, but wait with the scan
  sync?: boolean;              // tests: answer only after the loop list rebuild settled
}

// Everything the worker needs to start.
export interface LoopWorkerInit {
  t: 'init';
  loopCfg: LoopTraderConfig;
  fix: LoopFixSwitches;
  realPricesOn: boolean;       // LOOP_REAL_PRICES on and the cache keeps the confirmed view
  triggersOn: boolean;         // pending-trades book in use (real prices or trigger replay)
  extraOn: boolean;            // extra single loop pools in use
  bases: string[];             // WETH, USDG
  minDepthUsd: number;         // POOL_MIN_DEPTH_USD
  node: {
    cfg: LoopNodeConfig;       // which node loop checks use (free mode only in the worker)
    maxRps: number;            // LOOP_NODE_MAX_RPS
    freeUrl: string;           // the free public node
    weth: string;
    slotsFile: string | null;  // saved token balance locations (read only in the worker)
    triggerPollMs: number;
    triggerMaxPolls: number;
    sharedBudget: boolean;     // the node has a shared allowance on the main thread (ask permission)
  };
  statsMs: number;             // how often the worker reports its size and memory
  peekMs: number;              // "[loop] hour so far" line (15 min)
  logPerMin: number;           // loop log lines a minute (60, same as before)
  fixedClock?: boolean;        // tests: the worker's clock = the batch's `now`
  testHooks?: boolean;         // tests: allow the 'crash' message and fake checks
  fakeCheck?: 'loss' | 'profit' | 'fail';
  // Tests: finder time limits (Infinity = the answer never depends on machine speed).
  testFinder?: { updateBudgetMs?: number; sliceMs?: number };
}

// Main -> worker.
export type ToWorker =
  | LoopWorkerInit
  | LoopBatch
  | { t: 'permit'; id: number; ok: boolean }
  | { t: 'takeHour'; id: number }
  | { t: 'crash' };

// Worker -> main.
export interface WorkerStats { heapUsed: number; heapTotal: number; cycles: number; pools: number; pending: number; scans: number; lastScanMs: number }
export type FromWorker =
  | { t: 'ready' }
  | { t: 'ack'; seq: number; digest?: string }
  | { t: 'log'; line: string; level?: 'warn' }
  | { t: 'permit'; id: number; at: number } // at = when asked (Date.now, same clock in both threads)
  | { t: 'noteGas'; pools: number; gasUsed: bigint }
  | { t: 'hour'; id: number; h: LoopHour; node: string }
  | { t: 'stats'; s: WorkerStats }
  | { t: 'error'; message: string };

// ---- Switch ----------------------------------------------------------------

// LOOP_WORKER: ON by default when the loop trader is on; LOOP_WORKER=0 runs
// loops in the main thread exactly as before.
export function loopWorkerFromEnv(env: Record<string, string | undefined> = process.env): boolean {
  const loopsOn = env.LOOP_TRADER === '1' || env.LOOP_TRADER === 'true';
  const raw = (env.LOOP_WORKER ?? '').trim().toLowerCase();
  return loopsOn && raw !== '0' && raw !== 'false' && raw !== 'off';
}

// ---- The main thread side --------------------------------------------------

// What the feeder reads from the rest of the bot (all cheap lookups).
export interface LoopSource {
  watchedPairs: () => string[][];               // robinhoodWatcher.watchedPairPools()
  extraKeys: () => string[] | null;             // loopExtra.keys(), null = off
  main: (k: string) => PoolState | undefined;   // cache.get
  confirmed: (k: string) => PoolState | undefined; // cache.getConfirmed
  info: (k: string) => ConfirmedInfo | undefined;  // cache.confirmedInfo
  // Optional faster form of the three above in one lookup (cache.readLoopView):
  // m = main, c = confirmed, e = confirmed entry (a new object on every
  // confirmed write, so confirmedInfo is only built when e changed).
  view?: (k: string, out: { m?: PoolState; c?: PoolState; e?: object }) => void;
  realPrices: boolean;                          // confirmed view in use
  usdOf: (t: string) => number | null;
  decimalsOf: (t: string) => number | undefined; // exact decimals table (no guess)
  symbolOf: (t: string) => string;
  tradable: (t: string) => boolean;
  practiceDex: (dex: string) => boolean;
  gasUsd: (pools: number) => number;
  rivalPools: () => Set<string>;
  balance: (pool: PoolState, token: string) => bigint | undefined; // poolPrice realBalanceOf
  budgetOk: () => boolean;
  head: () => number | null;
  bases: string[];
  now: () => number;
}

export interface FeederLimits {
  maxInFlight: number;         // messages sent but not yet answered (3)
  maxNotes: number;            // feed notes kept while waiting (5,000)
  maxRivals: number;           // rival notes kept while waiting (500)
  maxPoolsPerBatch: number;    // pools per message (250)
  envEveryMs: number;          // look for changed coin facts this often (2 s)
  balEveryMs: number;          // look for changed real balances this often (10 s)
  rivalEveryMs: number;        // send the rival pool list this often (5 s)
}
export const DEFAULT_FEEDER_LIMITS: FeederLimits = {
  maxInFlight: 3, maxNotes: 5_000, maxRivals: 500, maxPoolsPerBatch: 250,
  envEveryMs: 2_000, balEveryMs: 10_000, rivalEveryMs: 5_000,
};

// What was last sent for one pool (references only, nothing copied).
interface SentRec { m?: PoolState; mFee?: unknown; c?: PoolState; e?: object; ib: number; ia: number; ifb: boolean; it?: string; gen: number }

const sameKeys = (a: string[] | null, b: string[] | null): boolean => {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

export class MainLoopFeeder {
  private sent = new Map<string, SentRec>();
  private lastKeys: string[] | null = null;
  private lastExtra: string[] | null | undefined = undefined; // undefined = never sent
  private notes: LoopNote[] = [];
  private rivals: RivalNote[] = [];
  private dropped = 0;           // notes dropped since the last message
  droppedTotal = 0;              // notes dropped since start (for the status line)
  private seq = 0;
  private inFlight = new Set<number>();
  skippedBusy = 0;               // flushes held back because the worker was behind
  // Coin facts already sent (to send only changes).
  private usd = new Map<string, number | null>();
  private dec = new Map<string, number | null>();
  private sym = new Map<string, string>();
  private trad = new Map<string, boolean>();
  private dex = new Map<string, boolean>();
  private bal = new Map<string, bigint | null>();
  private v3Pools = new Map<string, PoolState>(); // key -> a V3 pool state (for its real balances)
  private lastEnvAt = -Infinity;
  private lastBalAt = -Infinity;
  private lastRivalAt = -Infinity;
  private lastRivalKey = '';
  private morePending = false;   // the last batch was a partial one: send the rest soon
  private gen = 0;               // which build last looked at a pool (finds pools that left the lists)
  private out: { m?: PoolState; c?: PoolState; e?: object } = {};

  constructor(private src: LoopSource, readonly limits: FeederLimits = DEFAULT_FEEDER_LIMITS) {}

  // Feed notes (cheap: one array push). Kept until the next message.
  noteFeedTx(hash: string | undefined): void {
    if (!hash) return;
    this.pushNote([0, hash]);
  }
  noteTrade(pool: string, t: TriggerTrade): void { this.pushNote([1, pool, t]); }
  private pushNote(n: LoopNote): void {
    this.notes.push(n);
    if (this.notes.length > this.limits.maxNotes) {
      // Drop the oldest tenth in one go (cheaper than one at a time).
      const cut = Math.ceil(this.limits.maxNotes / 10);
      this.notes.splice(0, cut);
      this.dropped += cut; this.droppedTotal += cut;
    }
  }
  noteRival(r: RivalNote): void {
    this.rivals.push(r);
    if (this.rivals.length > this.limits.maxRivals) this.rivals.shift();
  }

  hasRivals(): boolean { return this.rivals.length > 0; }
  needsMore(): boolean { return this.morePending; }
  inFlightCount(): number { return this.inFlight.size; }
  busy(): boolean { return this.inFlight.size >= this.limits.maxInFlight; }

  // The worker answered message `seq` (and every one before it).
  ack(seq: number): void { for (const s of this.inFlight) if (s <= seq) this.inFlight.delete(s); }

  // Worker (re)started: forget what was sent, so the next messages carry everything.
  reset(): void {
    this.sent.clear(); this.lastKeys = null; this.lastExtra = undefined;
    this.inFlight.clear();
    this.usd.clear(); this.dec.clear(); this.sym.clear(); this.trad.clear(); this.dex.clear(); this.bal.clear(); this.v3Pools.clear();
    this.lastEnvAt = -Infinity; this.lastBalAt = -Infinity; this.lastRivalAt = -Infinity; this.lastRivalKey = '';
    this.morePending = false;
    // Notes from before the restart refer to the old worker's book: start clean.
    this.notes = []; this.rivals = [];
  }

  // Build the next message, or null when the worker is behind (nothing is
  // lost: changed pools are found again next time). `scan`: a loop scan was asked for.
  build(scan: boolean, sync = false): LoopBatch | null {
    if (this.busy()) { this.skippedBusy++; return null; }
    const s = this.src;
    const now = s.now();
    const batch: LoopBatch = {
      t: 'batch', seq: ++this.seq, now, head: s.head(), gas: this.gasTable(), budgetOk: s.budgetOk(),
      pools: [], notes: this.notes, droppedNotes: this.dropped, rivals: this.rivals, scan, partial: false,
      ...(sync ? { sync: true } : {}),
    };
    this.notes = []; this.rivals = []; this.dropped = 0;
    const env: EnvDelta = {};
    const newTokens: string[] = [];

    // 1. Which pools: the watched pairs' pools in order, then the extra ones.
    const keys: string[] = [];
    for (const pair of s.watchedPairs()) for (const a of pair) keys.push(a);
    if (!sameKeys(keys, this.lastKeys)) { batch.keys = keys; this.lastKeys = keys; }
    const extra = s.extraKeys();
    if (this.lastExtra === undefined || !sameKeys(extra, this.lastExtra)) { batch.extraKeys = extra; this.lastExtra = extra; }

    // 2. Changed pools only (compared by reference: no copying, no maths).
    let sentPools = 0, more = false;
    const gen = ++this.gen;
    const out = this.out;
    const rp = s.realPrices;
    const visit = (k: string) => {
      const was = this.sent.get(k);
      if (was) { if (was.gen === gen) return; was.gen = gen; } // listed twice: once is enough
      if (more) return;
      let m: PoolState | undefined, c: PoolState | undefined, e: object | undefined, i: ConfirmedInfo | undefined;
      if (s.view) {
        s.view(k, out);
        m = out.m;
        if (rp) { c = out.c; e = out.e; }
        if (was && was.m === m && was.mFee === m?.observedFee && was.c === c && was.e === e) return;
        if (rp && e) i = was && was.e === e ? { block: was.ib, at: was.ia, fromBlock: was.ifb, ...(was.it ? { tx: was.it } : {}) } : s.info(k);
      } else {
        m = s.main(k);
        c = rp ? s.confirmed(k) : undefined;
        i = rp ? s.info(k) : undefined;
        if (was && was.m === m && was.mFee === m?.observedFee && was.c === c
          && was.ib === (i?.block ?? -1) && was.ia === (i?.at ?? -1) && was.ifb === (i?.fromBlock ?? false) && was.it === i?.tx) return;
      }
      if (!was && !m && !c) return; // never known, still unknown: nothing to say
      if (sentPools >= this.limits.maxPoolsPerBatch) { more = true; return; }
      sentPools++;
      if (!m && !c) { batch.pools.push([k, null]); this.sent.delete(k); this.v3Pools.delete(k); return; }
      const rec: PoolRec = {};
      if (m) rec.m = m;
      if (c) rec.c = c;
      if (i) rec.i = i;
      batch.pools.push([k, rec]);
      this.sent.set(k, { m, mFee: m?.observedFee, c, e, ib: i?.block ?? -1, ia: i?.at ?? -1, ifb: i?.fromBlock ?? false, it: i?.tx, gen });
      for (const p of [m, c]) {
        if (!p) continue;
        for (const t of [p.tokenA, p.tokenB]) if (!this.usd.has(t.toLowerCase())) { this.usd.set(t.toLowerCase(), null); newTokens.push(t.toLowerCase()); }
        if (!this.dex.has(p.dex)) { const ok = s.practiceDex(p.dex); this.dex.set(p.dex, ok); (env.dex ??= []).push([p.dex, ok]); }
        if (p.poolType === 'v3' && !p.v4 && !this.v3Pools.has(k)) { this.v3Pools.set(k, p); this.addBal(env, p, p.tokenA); this.addBal(env, p, p.tokenB); }
      }
    };
    for (const k of keys) visit(k);
    if (extra) for (const k of extra) visit(k);
    // Pools on neither list any more (not looked at in this build): tell the worker to forget them.
    if (!more) {
      for (const [k, r] of this.sent) if (r.gen !== gen) { batch.pools.push([k, null]); this.sent.delete(k); this.v3Pools.delete(k); }
    }
    batch.partial = more;
    this.morePending = more;
    if (more) batch.scan = false; // scan once everything has arrived

    // 3. Coin facts: new coins at once (so the worker never sees a coin it
    //    knows nothing about), all coins every envEveryMs (changes only).
    for (const b of s.bases) { const t = b.toLowerCase(); if (!this.usd.has(t)) { this.usd.set(t, null); newTokens.push(t); } }
    for (const t of newTokens) this.addToken(env, t, true);
    if (now - this.lastEnvAt >= this.limits.envEveryMs) {
      this.lastEnvAt = now;
      for (const t of this.usd.keys()) this.addToken(env, t, false);
      for (const d of this.dex.keys()) { const ok = s.practiceDex(d); if (ok !== this.dex.get(d)) { this.dex.set(d, ok); (env.dex ??= []).push([d, ok]); } }
    } else {
      // The base coins' USD price sets every loop's USD result: always fresh.
      for (const b of s.bases) this.addUsd(env, b.toLowerCase());
    }
    if (now - this.lastBalAt >= this.limits.balEveryMs) {
      this.lastBalAt = now;
      for (const p of this.v3Pools.values()) { this.addBal(env, p, p.tokenA); this.addBal(env, p, p.tokenB); }
    }
    if (now - this.lastRivalAt >= this.limits.rivalEveryMs) {
      this.lastRivalAt = now;
      let set: Set<string>;
      try { set = s.rivalPools(); } catch { set = new Set(); }
      const list = [...set];
      const key = list.join(',');
      if (key !== this.lastRivalKey) { this.lastRivalKey = key; env.rivalPools = list; }
    }
    if (Object.keys(env).length) batch.env = env;
    this.inFlight.add(batch.seq);
    return batch;
  }

  private gasTable(): number[] {
    const g: number[] = [];
    for (let n = 2; n <= 8; n++) { try { g[n] = this.src.gasUsd(n); } catch { g[n] = NaN; } }
    return g;
  }

  private addUsd(env: EnvDelta, t: string): void {
    let v: number | null;
    try { v = this.src.usdOf(t); } catch { v = null; }
    if (v === undefined) v = null;
    if (this.usd.get(t) !== v || !this.usd.has(t)) { this.usd.set(t, v); (env.usd ??= []).push([t, v]); }
  }

  private addToken(env: EnvDelta, t: string, isNew: boolean): void {
    const s = this.src;
    if (isNew) { this.usd.delete(t); }
    this.addUsd(env, t);
    const d = s.decimalsOf(t) ?? null;
    if (isNew || this.dec.get(t) !== d) { this.dec.set(t, d); (env.dec ??= []).push([t, d]); }
    const y = s.symbolOf(t);
    if (isNew || this.sym.get(t) !== y) { this.sym.set(t, y); (env.sym ??= []).push([t, y]); }
    const ok = s.tradable(t);
    if (isNew || this.trad.get(t) !== ok) { this.trad.set(t, ok); (env.tradable ??= []).push([t, ok]); }
  }

  private addBal(env: EnvDelta, p: PoolState, token: string): void {
    let v: bigint | null;
    try { v = this.src.balance(p, token) ?? null; } catch { v = null; }
    const pool = p.poolAddress;
    const key = `${pool.toLowerCase()}:${token.toLowerCase()}`;
    if (this.bal.has(key) && this.bal.get(key) === v) return;
    this.bal.set(key, v);
    (env.bal ??= []).push([pool.toLowerCase(), token.toLowerCase(), v]);
  }
}

// A short fingerprint of a scan's loop results (tests: worker vs main thread).
export function loopResultsDigest(results: { cycle: { sig: string }; amountIn: bigint; netUsd: number }[] | undefined): string {
  if (!results) return 'off';
  return results.map((r) => `${r.cycle.sig}@${r.amountIn}:${r.netUsd.toFixed(9)}`).join('|');
}
