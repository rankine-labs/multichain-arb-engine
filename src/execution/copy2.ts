import type { PoolState } from '../core/types';
import type { RpcLog } from '../core/blockReader';
import { isHookedV4, v4KeyMatchesId, v4KeyOf } from './executorCalldata';
import { ROBINHOOD_VENUES } from '../config/robinhoodVenues';
import type { LocalSimClient, SidecarAnswer } from './localSim';
import type { RawLogTap } from '../core/blockReaderWs';

// ============================================================================
// COPY 2, BOT SIDE (sim/COPY2_PLAN.md, workstream C)
//
// Plain English:
//   The fast check (the "arbsim" program next to the bot) can keep a copy of
//   OUR pools that is updated from the pools' own reports ("events" / "logs")
//   instead of replaying every transaction on the chain. For that it needs
//   two things from the bot, and this file provides both:
//
//     1. WHICH pools to follow ("track"): each watched Robinhood pool whose
//        type the copy can follow exactly, with its type and coins:
//          V2         Uniswap V2 style pairs (Uniswap V2, PancakeSwap V2)
//          Solidly    Solidly / Velodrome style pairs (Ramses V2, GIGA Classic)
//          V3         Uniswap V3 and exact copies (SushiSwap V3, Abyss, Goo)
//          PancakeV3  PancakeSwap V3 and its copies (GIGA CL, SwapHood)
//          Algebra    Algebra Integral (Alandale, KittenSwap)
//          V4         Uniswap V4 pools WITHOUT a hook
//        Not followed (the node keeps checking them, as today): V4 pools
//        with a hook (Fables etc.), Ramses V3, Slipstream copies, order
//        books, bins, oracle pools, anything unknown.
//
//     2. EVERY report of those pools, block by block, in order
//        ("pool_logs"): the pools' own events (swap, mint, burn, sync, LP
//        moves, ...), Uniswap V4 events for our V4 pool ids, and coin
//        transfers into / out of our pools (the copy keeps the pools' coin
//        balances too). They come from the block reader's WebSocket (the node
//        pushes them); this file only sorts them per block and passes them
//        on. It never waits for anything slow and never stops the bot: if
//        the fast check's socket is busy the message is dropped, counted,
//        and the next message says "gap" so the copy reloads instead of
//        guessing.
//
//   And it reads back, per pool, whether the copy is READY (exact and
//   current), LOADING or UNSURE. The bot only lets the fast check decide a
//   trade when EVERY pool on the route is ready; otherwise the node decides,
//   exactly as before.
//
// Messages sent (4-byte length + JSON, same socket as everything else):
//   {type:"track", pools:[{address, v4Id?, kind, token0, token1, fee, tickSpacing}]}
//       (answer {ok:true}); sent when the list changes, on (re)connect and
//       every 10 minutes.
//   {type:"pool_logs", block, timestamp?, l1Block?, prevBlock, gap?, logs:[...]}
//       one per block that has events on tracked pools, in block order.
//       prevBlock = the block of the previous pool_logs this connection
//       delivered (-1 = none): if the copy's last block differs, it missed
//       one. gap:true = "something was missed (dropped message, WebSocket
//       outage that could not be filled in): mark pools unsure and reload".
//       timestamp / l1Block come from the sequencer feed (header of that
//       block's message) or from the log itself (blockTimestamp); missing =
//       unknown (the copy must not guess it).
//   {type:"pool_logs", block, late:true, logs}   events that arrived AFTER
//       their block was already passed on (should be very rare): the copy
//       should mark those pools unsure and reload them.
//   {type:"pool_logs", block, reorg:true, logs}  the node took these events
//       back (block replaced): same, mark those pools unsure and reload.
//
// Read only. No keys, no transactions. Never throws into the bot.
// ============================================================================

export type Copy2Kind = 'V2' | 'Solidly' | 'V3' | 'PancakeV3' | 'Algebra' | 'V4';

// One pool for the "track" message (field names as in the plan / Rust side).
export interface Copy2Pool {
  address: string;       // pool contract; for V4 the PoolManager
  v4Id?: string;         // V4 only: the 32-byte pool id
  kind: Copy2Kind;
  token0: string;        // the pool's token0 (V4: currency0, 0x000..0 = native ETH)
  token1: string;
  fee: number;           // V4 only (pips); 0 for other kinds
  tickSpacing: number;   // V4 only; 0 for other kinds
}

export const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
// ERC-20 Transfer(address indexed from, address indexed to, uint256 value).
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ADDR_RE = /^0x[0-9a-f]{40}$/;
const ID_RE = /^0x[0-9a-f]{64}$/;

// The exchanges the bot itself knows by name, and how the copy follows them.
// Anything not listed here (and not an extra venue below) is NOT followed.
const CORE_DEX_KIND: Record<string, Copy2Kind> = {
  'uniswap-v2': 'V2',
  'pancakeswap-v2': 'V2',
  'ramses-v2': 'Solidly',
  'uniswap-v3': 'V3',
  'pancakeswap-v3': 'PancakeV3',
};
// Extra venues (config/robinhoodVenues.ts) by their pricing model.
const VENUE_MODEL_KIND: Record<string, Copy2Kind> = {
  'uniswap-v3': 'V3',
  'pancake-v3': 'PancakeV3',
  'algebra': 'Algebra',
  'solidly': 'Solidly',
};

// The key the copy and the bot use for one pool: the V4 pool id for V4,
// otherwise the pool address (lower case).
export function copy2Key(p: { address: string; v4Id?: string }): string {
  return (p.v4Id ?? p.address).toLowerCase();
}

// ----------------------------------------------------------------------------
// copy2PoolOf: which copy type a watched pool is, or why it is not followed.
// Conservative on purpose: unknown exchange names are never followed.
// ----------------------------------------------------------------------------
export function copy2PoolOf(pool: PoolState, poolManager: string, skipDexes: ReadonlySet<string> = new Set()): Copy2Pool | { skip: string } {
  try {
    if (pool.chain !== 'robinhood') return { skip: 'not robinhood' };
    const dex = String(pool.dex ?? '').toLowerCase();
    if (skipDexes.has(dex)) return { skip: 'exchange switched off (COPY2_SKIP_DEXES)' };
    const a = String(pool.tokenA ?? '').toLowerCase();
    const b = String(pool.tokenB ?? '').toLowerCase();
    const addr = String(pool.poolAddress ?? '').toLowerCase();
    // Uniswap V4: only pools without a hook, whose key really gives this pool id.
    if (pool.v4) {
      if (dex !== 'uniswap-v4') return { skip: 'V4 pool under another exchange name' };
      if (isHookedV4(pool)) return { skip: 'V4 pool with a hook' };
      if (!ID_RE.test(addr)) return { skip: 'bad V4 pool id' };
      if (!v4KeyMatchesId(pool)) return { skip: 'V4 key does not match the pool id' };
      const pm = String(pool.v4.poolManager ?? '').toLowerCase();
      if (!ADDR_RE.test(pm) || (poolManager && pm !== poolManager.toLowerCase())) return { skip: 'V4 pool on another PoolManager' };
      const k = v4KeyOf(pool);
      const fee = Number(k.fee), ts = Number(k.tickSpacing);
      if (!Number.isInteger(fee) || fee < 0 || fee >= 1_000_000) return { skip: 'V4 fee not a fixed fee' };
      if (!Number.isInteger(ts) || ts <= 0) return { skip: 'bad V4 tick spacing' };
      const t0 = k.currency0.toLowerCase(), t1 = k.currency1.toLowerCase();
      if (!ADDR_RE.test(t0) || !ADDR_RE.test(t1)) return { skip: 'bad V4 coins' };
      return { address: pm, v4Id: addr, kind: 'V4', token0: t0, token1: t1, fee, tickSpacing: ts };
    }
    if (dex === 'uniswap-v4') return { skip: 'V4 pool without its details' };
    if (!ADDR_RE.test(addr) || !ADDR_RE.test(a) || !ADDR_RE.test(b) || a === b) return { skip: 'bad pool or coin address' };
    // Which kind, by exchange name (core) or by the extra venue's model.
    let kind: Copy2Kind | undefined = CORE_DEX_KIND[dex];
    if (!kind) {
      const venue = ROBINHOOD_VENUES.find((v) => v.id === dex);
      kind = venue ? VENUE_MODEL_KIND[venue.model] : undefined;
    }
    if (!kind) return { skip: `exchange type not followed (${dex || 'unknown'})` };
    // The pool's own shape must agree with its exchange type.
    if (kind === 'V2' || kind === 'Solidly') {
      if (pool.poolType !== 'v2' || pool.variant) return { skip: 'pool shape does not match its exchange' };
    } else if (kind === 'Algebra') {
      if (pool.poolType !== 'v3' || pool.variant !== 'algebra') return { skip: 'pool shape does not match its exchange' };
    } else if (pool.poolType !== 'v3' || pool.variant) {
      return { skip: 'pool shape does not match its exchange' };
    }
    // token0 is always the smaller address (V2, Solidly, V3 and Algebra all sort).
    const [token0, token1] = a < b ? [a, b] : [b, a];
    return { address: addr, kind, token0, token1, fee: 0, tickSpacing: 0 };
  } catch {
    return { skip: 'unreadable pool' };
  }
}

const isPool = (x: Copy2Pool | { skip: string }): x is Copy2Pool => !('skip' in x);

// The whole track list from the watched pools (no duplicates), plus how many
// were left out and why (for the log).
export function buildTrackList(pools: Iterable<PoolState | undefined>, poolManager: string, skipDexes: ReadonlySet<string> = new Set()): { pools: Copy2Pool[]; skipped: Record<string, number> } {
  const out = new Map<string, Copy2Pool>();
  const skipped: Record<string, number> = {};
  for (const p of pools) {
    if (!p) continue;
    const r = copy2PoolOf(p, poolManager, skipDexes);
    if (isPool(r)) out.set(copy2Key(r), r);
    else skipped[r.skip] = (skipped[r.skip] ?? 0) + 1;
  }
  return { pools: [...out.values()].sort((x, y) => (copy2Key(x) < copy2Key(y) ? -1 : 1)), skipped };
}

// What the WebSocket must subscribe to so that every event of these pools
// reaches the copy: coin transfers to / from the contract pools (the V4
// PoolManager is left out on purpose: it moves coins for EVERY V4 pool on the
// chain, which would multiply the node bill; V4 pools are followed from the
// PoolManager's own pool-id events).
export function transferFilterOf(pools: readonly Copy2Pool[]): { coins: string[]; pools: string[] } {
  const coins = new Set<string>(), addrs = new Set<string>();
  for (const p of pools) {
    if (p.kind === 'V4') continue;
    addrs.add(p.address.toLowerCase());
    for (const t of [p.token0, p.token1]) if (t && t !== ZERO_ADDR) coins.add(t.toLowerCase());
  }
  return { coins: [...coins].sort(), pools: [...addrs].sort() };
}

// What a live WebSocket subscription really covers (handed over by the block
// reader when it goes live). A pool is only tracked if ALL its events come in.
export interface Copy2Coverage {
  pools: ReadonlySet<string>;          // contract addresses: all their events
  ids: ReadonlySet<string>;            // V4 pool ids: all PoolManager events for them
  transferPools: ReadonlySet<string>;  // coin transfers to / from these addresses
  coins: ReadonlySet<string>;          // ... of these coins
}

export function coveredPools(pools: readonly Copy2Pool[], cov: Copy2Coverage): Copy2Pool[] {
  return pools.filter((p) => {
    if (p.kind === 'V4') return !!p.v4Id && cov.ids.has(p.v4Id.toLowerCase());
    const a = p.address.toLowerCase();
    if (!cov.pools.has(a) || !cov.transferPools.has(a)) return false;
    return [p.token0, p.token1].every((t) => t === ZERO_ADDR || cov.coins.has(t.toLowerCase()));
  });
}

// ----------------------------------------------------------------------------
// FeedBlockTimes: each block's time and parent-chain (L1) block number, read
// from the sequencer feed messages the bot already receives (the header of
// each message: Robinhood Chain makes one block per feed message, block
// number = sequence number + ARBSIM_L2_BLOCK_OFFSET, 0 on Robinhood).
// Text search only (no second full JSON read of the frame); never throws.
// ----------------------------------------------------------------------------
export class FeedBlockTimes {
  private readonly times = new Map<number, { timestamp: number; l1Block: number }>();
  private newest = -1;
  noted = 0;

  constructor(private readonly offset = 0, private readonly keep = 1024) {}

  noteFrame(text: string): void {
    try {
      if (typeof text !== 'string' || text.indexOf('"sequenceNumber"') < 0) return;
      const re = /"sequenceNumber"\s*:\s*(\d+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const seq = Number(m[1]);
        // The header that belongs to this message is the next "header":{...}.
        const h = text.indexOf('"header"', m.index);
        if (h < 0) break;
        const open = text.indexOf('{', h);
        const close = open < 0 ? -1 : text.indexOf('}', open);
        if (close < 0) break;
        // Never read past the next message's sequence number.
        const nextSeq = text.indexOf('"sequenceNumber"', m.index + 1);
        if (nextSeq >= 0 && nextSeq < close) continue;
        const head = text.slice(open, close);
        const ts = /"timestamp"\s*:\s*(\d+)/.exec(head);
        const l1 = /"blockNumber"\s*:\s*(\d+)/.exec(head);
        if (!ts || !l1 || !Number.isSafeInteger(seq)) continue;
        this.set(seq + this.offset, Number(ts[1]), Number(l1[1]));
      }
    } catch { /* a strange frame is simply skipped */ }
  }

  set(block: number, timestamp: number, l1Block: number): void {
    if (!Number.isSafeInteger(block) || block < 0 || !Number.isSafeInteger(timestamp) || timestamp <= 0) return;
    // Nitro never lets a block's time or L1 block number go backwards: a
    // message stamped earlier than its parent block gets the parent's values.
    const parent = this.times.get(block - 1);
    if (parent) { timestamp = Math.max(timestamp, parent.timestamp); l1Block = Math.max(l1Block, parent.l1Block); }
    this.times.set(block, { timestamp, l1Block });
    this.noted++;
    if (block > this.newest) this.newest = block;
    if (this.times.size > this.keep) {
      // Forget the oldest ones (insertion order is close to block order).
      const cut = this.times.size - this.keep;
      let i = 0;
      for (const k of this.times.keys()) { if (i++ >= cut) break; this.times.delete(k); }
    }
  }

  get(block: number): { timestamp: number; l1Block: number } | undefined { return this.times.get(block); }
  newestBlock(): number { return this.newest; }
}

// ----------------------------------------------------------------------------
// Copy2Forwarder: sorts the pushed logs per block and passes each block on,
// in order, as one pool_logs message.
// ----------------------------------------------------------------------------
export type Copy2Index = {
  pools: ReadonlySet<string>;   // tracked contract pools
  ids: ReadonlySet<string>;     // tracked V4 pool ids
  poolManager: string;          // V4 PoolManager (lower case)
  coins: ReadonlySet<string>;   // coins of tracked contract pools
};

export type Copy2ForwarderOptions = {
  // Hand one message to the fast check. false = not delivered (socket down or
  // busy): the forwarder then marks the next message "gap".
  send: (msg: Record<string, unknown>) => boolean;
  index: () => Copy2Index;
  blockTime?: (block: number) => { timestamp: number; l1Block?: number } | undefined;
  // HTTP node for filling in blocks missed while the WebSocket was down.
  backfillRpc?: () => ((method: string, params: unknown[]) => Promise<any>) | null;
  holdMs?: number;        // wait this long after the last log before passing on the newest block (default 4)
  tsWaitMs?: number;      // wait at most this long for a block's time from the feed (default 40)
  maxBackfill?: number;   // most blocks filled in after an outage (default 200)
  maxPendingBlocks?: number; // safety cap on blocks held (default 64)
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
  log?: (m: string) => void;
};

type Pending = { logs: RpcLog[]; keys: Set<string>; firstAt: number };

const hexNum = (v: unknown): number | null => {
  if (v === undefined || v === null) return null;
  try { const n = Number(BigInt(v as string)); return Number.isSafeInteger(n) && n >= 0 ? n : null; } catch { return null; }
};
const topicAddr = (t: string | undefined): string | null =>
  typeof t === 'string' && t.length === 66 ? ('0x' + t.slice(26)).toLowerCase() : null;
const padAddr = (a: string): string => '0x' + '0'.repeat(24) + a.toLowerCase().slice(2);

// The fields of a log the copy needs, as the node sent them.
function slim(l: RpcLog & { blockHash?: string }): Record<string, unknown> {
  const o: Record<string, unknown> = {
    address: l.address, topics: l.topics, data: l.data, blockNumber: l.blockNumber,
    transactionIndex: l.transactionIndex, logIndex: l.logIndex, transactionHash: l.transactionHash,
  };
  if (l.blockHash) o.blockHash = l.blockHash;
  if (l.removed) o.removed = true;
  return o;
}

const realSchedule = (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); (t as any).unref?.(); return () => clearTimeout(t); };

export class Copy2Forwarder {
  private readonly o: Copy2ForwarderOptions;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly holdMs: number;
  private readonly tsWaitMs: number;

  private active = false;            // the fast check follows our pools (track accepted)
  private mode: 'down' | 'live' | 'backfilling' = 'down';   // the WebSocket side
  private pending = new Map<number, Pending>();
  private late = new Map<number, RpcLog[]>();
  private reorg = new Map<number, RpcLog[]>();
  private lastEmitted = -1;          // newest block passed on (or given up on)
  private prevSent = -1;             // newest block delivered on this connection
  private newestSeen = -1;           // newest block any tracked log came from
  private gapFlag = true;            // next message says "gap" (always true for the first one)
  private lastLogAt = 0;
  private cancelFlush: (() => void) | null = null;
  private backfillFrom = -1;         // first block to fill in after an outage (-1 = nothing to fill)
  private gapSentAt = 0;             // when the copy was last told "gap"
  private liveSince = 0;
  private txBlock = new Map<string, number>();
  private txWaiters = new Map<string, Array<(b: number) => void>>();

  readonly counts = { logsIn: 0, logsKept: 0, blocksSent: 0, msgsDropped: 0, late: 0, reorgLogs: 0, gaps: 0, backfills: 0, backfillFails: 0, backfillLogs: 0, noTimestamp: 0, forced: 0 };

  constructor(o: Copy2ForwarderOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.schedule = o.schedule ?? realSchedule;
    this.holdMs = Math.max(0, o.holdMs ?? 4);
    this.tsWaitMs = Math.max(0, o.tsWaitMs ?? 40);
  }

  private log(m: string): void { try { (this.o.log ?? (() => {}))(m); } catch { /* logging only */ } }

  // ---- switches ------------------------------------------------------------
  // The fast check accepted our track list (true) or is not following pools (false).
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.clearHeld();
    // Whatever the copy had before is no longer known to match: start with "gap".
    this.gapFlag = true;
    this.prevSent = -1;
    if (!on) { this.backfillFrom = -1; }
    else if (this.mode === 'live' || this.mode === 'backfilling') this.liveSince = this.now();
  }
  isActive(): boolean { return this.active; }

  // The WebSocket subscription (with our extra filters) is live.
  onLive(): void {
    try {
      if (this.mode === 'live' || this.mode === 'backfilling') return;
      this.liveSince = this.now();
      if (this.active && this.backfillFrom >= 0) { this.mode = 'backfilling'; void this.backfill(this.backfillFrom); }
      else this.mode = 'live';
      this.backfillFrom = -1;
    } catch { this.mode = 'live'; this.markGap(); }
  }

  // The WebSocket dropped: events from now on are missed until it is back.
  onDown(): void {
    try {
      if (this.mode === 'down') return;
      const wasBackfilling = this.mode === 'backfilling';
      this.mode = 'down';
      // The newest held block may be only partly received: it is filled in later.
      this.clearHeld();
      if (this.active) {
        if (wasBackfilling) { this.backfillFrom = -1; this.markGap(); }    // two outages in a row: just reload
        else if (this.lastEmitted >= 0) this.backfillFrom = this.lastEmitted + 1;
        else this.markGap();
      }
    } catch { this.markGap(); }
  }

  // ---- logs in -------------------------------------------------------------
  // Every log the WebSocket pushed (all subscriptions), as received. Cheap:
  // filter, sort into its block, schedule a pass-on. Never throws.
  onLogs(logs: RpcLog[]): void {
    try {
      if (!this.active || this.mode === 'down') return;
      const idx = this.o.index();
      let newer = false;
      for (const l of logs) {
        this.counts.logsIn++;
        if (!l || !this.relevant(l, idx)) continue;
        const b = hexNum(l.blockNumber);
        const li = hexNum(l.logIndex);
        if (b === null || li === null) continue;
        this.counts.logsKept++;
        if (l.removed) {
          this.counts.reorgLogs++;
          this.push(this.reorg, b, l);
          continue;
        }
        this.noteTx(l.transactionHash, b);
        if (b <= this.lastEmitted) {
          // Its block was already passed on: send it flagged "late".
          this.counts.late++;
          this.push(this.late, b, l);
          continue;
        }
        let p = this.pending.get(b);
        if (!p) {
          p = { logs: [], keys: new Set(), firstAt: this.now() };
          this.pending.set(b, p);
          for (const k of this.pending.keys()) if (k < b) { newer = true; break; }
        }
        const key = `${li}`;
        if (p.keys.has(key)) continue;   // same log from two subscriptions
        p.keys.add(key);
        p.logs.push(l);
        if (b > this.newestSeen) this.newestSeen = b;
      }
      this.lastLogAt = this.now();
      // A newer block started: the older ones are complete, pass them on now.
      this.scheduleFlush(newer || this.late.size || this.reorg.size ? 0 : this.holdMs);
    } catch { /* never breaks the reader */ }
  }

  private push(m: Map<number, RpcLog[]>, b: number, l: RpcLog): void {
    const a = m.get(b);
    if (a) a.push(l); else m.set(b, [l]);
  }

  // Is this log about a tracked pool?
  private relevant(l: RpcLog, idx: Copy2Index): boolean {
    const addr = (l.address || '').toLowerCase();
    if (idx.pools.has(addr)) return true;
    const t0 = (l.topics?.[0] || '').toLowerCase();
    if (addr === idx.poolManager) {
      const id = (l.topics?.[1] || '').toLowerCase();
      return !!id && idx.ids.has(id);
    }
    if (t0 === TRANSFER_TOPIC && (l.topics?.length ?? 0) >= 3 && idx.coins.has(addr)) {
      const from = topicAddr(l.topics[1]), to = topicAddr(l.topics[2]);
      return (!!from && idx.pools.has(from)) || (!!to && idx.pools.has(to));
    }
    return false;
  }

  // ---- logs out ------------------------------------------------------------
  private scheduleFlush(ms: number): void {
    if (this.cancelFlush) {
      if (ms > 0) return;               // already planned
      this.cancelFlush(); this.cancelFlush = null;
    }
    this.cancelFlush = this.schedule(() => { this.cancelFlush = null; this.flush(); }, ms);
  }

  // Pass on every block that is complete. The newest block waits until no
  // log arrived for holdMs (its logs come in one quick burst); a block
  // waits for its time from the feed for at most tsWaitMs.
  flush(force = false): void {
    try {
      if (!this.active || this.mode !== 'live') return;
      for (const [b, logs] of this.reorg) this.sendFlagged(b, logs, 'reorg');
      this.reorg.clear();
      for (const [b, logs] of this.late) this.sendFlagged(b, logs, 'late');
      this.late.clear();
      const blocks = [...this.pending.keys()].sort((x, y) => x - y);
      const t = this.now();
      const maxPending = this.o.maxPendingBlocks ?? 64;
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i]!;
        const p = this.pending.get(b)!;
        const newest = i === blocks.length - 1;
        const overfull = blocks.length - i > maxPending;
        if (newest && !force && !overfull && t - this.lastLogAt < this.holdMs) { this.scheduleFlush(Math.max(1, this.holdMs - (t - this.lastLogAt))); return; }
        const time = this.timeOf(b, p);
        if (!time && !force && !overfull && t - p.firstAt < this.tsWaitMs) { this.scheduleFlush(5); return; }
        if (overfull) this.counts.forced++;
        this.emit(b, p, time);
      }
    } catch { /* never throws */ }
  }

  private timeOf(b: number, p: Pending): { timestamp: number; l1Block?: number } | undefined {
    const f = this.o.blockTime?.(b);
    if (f) return f;
    for (const l of p.logs) {
      const ts = hexNum((l as any).blockTimestamp);
      if (ts !== null && ts > 0) return { timestamp: ts };
    }
    return undefined;
  }

  private emit(b: number, p: Pending, time: { timestamp: number; l1Block?: number } | undefined): void {
    this.pending.delete(b);
    const logs = p.logs.slice().sort((x, y) => ((hexNum(x.transactionIndex) ?? 0) - (hexNum(y.transactionIndex) ?? 0)) || ((hexNum(x.logIndex) ?? 0) - (hexNum(y.logIndex) ?? 0)));
    const msg: Record<string, unknown> = { type: 'pool_logs', block: b, prevBlock: this.prevSent, logs: logs.map(slim) };
    if (time) { msg.timestamp = time.timestamp; if (time.l1Block !== undefined) msg.l1Block = time.l1Block; }
    else this.counts.noTimestamp++;
    const gap = this.gapFlag;
    if (gap) msg.gap = true;
    this.lastEmitted = Math.max(this.lastEmitted, b);
    if (this.send(msg)) {
      this.counts.blocksSent++;
      this.prevSent = b;
      if (gap) { this.gapFlag = false; this.gapSentAt = this.now(); this.counts.gaps++; }
    } else {
      this.counts.msgsDropped++;
      this.gapFlag = true;
    }
  }

  private sendFlagged(b: number, logs: RpcLog[], flag: 'late' | 'reorg'): void {
    if (!this.send({ type: 'pool_logs', block: b, [flag]: true, logs: logs.map(slim) })) { this.counts.msgsDropped++; this.gapFlag = true; }
  }

  private send(msg: Record<string, unknown>): boolean {
    try { return this.o.send(msg) === true; } catch { return false; }
  }

  private markGap(): void { this.gapFlag = true; }

  private clearHeld(): void {
    this.pending.clear();
    this.late.clear();
    this.reorg.clear();
    if (this.cancelFlush) { this.cancelFlush(); this.cancelFlush = null; }
  }

  // ---- fill-in after a WebSocket outage --------------------------------------
  // One read per kind of subscription over the missed blocks (HTTP node),
  // merged with what arrived live meanwhile, then passed on in order.
  // Anything that fails: the copy is told "gap" (it reloads; never a guess).
  private async backfill(from: number): Promise<void> {
    const rpc = this.o.backfillRpc?.() ?? null;
    const done = (ok: boolean) => {
      if (this.mode !== 'backfilling') return;        // went down again meanwhile (onDown handled it)
      if (!ok) { this.counts.backfillFails++; this.markGap(); }
      this.mode = 'live';
      this.flush();
    };
    try {
      if (!rpc) { done(false); return; }
      const headRaw = await rpc('eth_blockNumber', []);
      const head = hexNum(headRaw);
      if (head === null) { done(false); return; }
      if (head < from) { done(true); return; }
      if (head - from + 1 > (this.o.maxBackfill ?? 200)) { this.log('[copy2] outage too long to fill in, the copy reloads instead'); done(false); return; }
      const idx = this.o.index();
      const range = { fromBlock: '0x' + from.toString(16), toBlock: '0x' + head.toString(16) };
      const pools = [...idx.pools], ids = [...idx.ids], coins = [...idx.coins];
      const padded = pools.map(padAddr);
      const asks: Array<Promise<any>> = [];
      if (pools.length) asks.push(rpc('eth_getLogs', [{ ...range, address: pools }]));
      if (ids.length && idx.poolManager) asks.push(rpc('eth_getLogs', [{ ...range, address: idx.poolManager, topics: [null, ids] }]));
      if (coins.length && padded.length) {
        asks.push(rpc('eth_getLogs', [{ ...range, address: coins, topics: [TRANSFER_TOPIC, padded] }]));
        asks.push(rpc('eth_getLogs', [{ ...range, address: coins, topics: [TRANSFER_TOPIC, null, padded] }]));
      }
      const results = await Promise.all(asks);
      if (this.mode !== 'backfilling') return;
      const all: RpcLog[] = [];
      for (const r of results) { if (!Array.isArray(r)) { done(false); return; } all.push(...r); }
      this.counts.backfills++;
      this.counts.backfillLogs += all.length;
      // Merge: same path as live logs (dedupe per block + log index).
      const prevMode = this.mode;
      this.mode = 'live';
      const before = this.lastLogAt;
      this.onLogs(all.filter((l) => !l?.removed));
      this.lastLogAt = before;
      this.mode = prevMode;
      done(true);
    } catch (e) {
      this.log(`[copy2] fill-in after the WebSocket outage failed (${String((e as Error)?.message ?? e).slice(0, 60).replace(/https?:\/\/\S+|wss?:\/\/\S+/g, '[url]')}), the copy reloads instead`);
      done(false);
    }
  }

  // ---- facts for the bot ----------------------------------------------------
  // Logs are flowing and nothing is being filled in right now.
  live(): boolean { return this.active && this.mode === 'live' && !this.gapFlag; }
  // When the copy was last told "gap" (a status taken before that is outdated).
  lastGapAt(): number { return this.gapSentAt; }
  newestBlock(): number { return this.newestSeen; }
  modeText(): string { return !this.active ? 'off' : this.mode === 'live' ? (this.gapFlag ? 'live (gap pending)' : 'live') : this.mode; }

  // The block a transaction's events came in (null = not seen).
  txBlockOf(hash: string | undefined): number | null {
    if (!hash) return null;
    return this.txBlock.get(hash.toLowerCase()) ?? null;
  }

  // Wait until a log of this transaction arrives (it is then in a block).
  // null = not within ms.
  waitForTx(hash: string | undefined, ms: number): Promise<number | null> {
    const h = (hash ?? '').toLowerCase();
    if (!h) return Promise.resolve(null);
    const b = this.txBlock.get(h);
    if (b !== undefined) return Promise.resolve(b);
    return new Promise((resolve) => {
      let finished = false;
      const fin = (v: number | null) => { if (finished) return; finished = true; cancel(); resolve(v); };
      const cancel = this.schedule(() => {
        const list = this.txWaiters.get(h);
        if (list) { const i = list.indexOf(ok); if (i >= 0) list.splice(i, 1); if (!list.length) this.txWaiters.delete(h); }
        fin(null);
      }, Math.max(0, ms));
      const ok = (blk: number) => fin(blk);
      const list = this.txWaiters.get(h);
      if (list) list.push(ok); else this.txWaiters.set(h, [ok]);
      if (this.txWaiters.size > 500) { const first = this.txWaiters.keys().next().value as string; for (const f of this.txWaiters.get(first) ?? []) { try { f(-1); } catch { /* */ } } this.txWaiters.delete(first); }
    }).then((v) => (v === -1 ? null : (v as number | null)));
  }

  private noteTx(hash: string | undefined, b: number): void {
    if (!hash) return;
    const h = hash.toLowerCase();
    if (!this.txBlock.has(h)) {
      this.txBlock.set(h, b);
      if (this.txBlock.size > 5_000) this.txBlock.delete(this.txBlock.keys().next().value as string);
    }
    const w = this.txWaiters.get(h);
    if (w) { this.txWaiters.delete(h); for (const f of w) { try { f(b); } catch { /* */ } } }
  }
}

// ----------------------------------------------------------------------------
// parseCopy2Status: read the fast check's status answer. Tolerant of shapes
// (the Rust side is built in parallel). Recognised:
//   source: "pool-events"                     -> copy 2 is running
//   copy2: { pools: {"<key>": "ready"|..} }   or pools: [{address|key, v4Id?, state}]
//   copy2: { ready: [keys], unsure: [keys], loading: [keys] }
// Anything not clearly "ready" counts as NOT ready (strict).
// ----------------------------------------------------------------------------
export type Copy2PoolState = 'ready' | 'loading' | 'unsure';
export type Copy2Status = { active: boolean; states: Map<string, Copy2PoolState> | null; counts: { ready: number; loading: number; unsure: number; tracked: number } | null };

function stateWord(v: unknown): Copy2PoolState {
  const s = String(typeof v === 'object' && v !== null ? (v as any).state ?? (v as any).status ?? '' : v ?? '').toLowerCase();
  if (s === 'ready') return 'ready';
  if (/load|fill|pending|new/.test(s)) return 'loading';
  return 'unsure';
}

export function parseCopy2Status(s: unknown): Copy2Status {
  const out: Copy2Status = { active: false, states: null, counts: null };
  try {
    if (!s || typeof s !== 'object') return out;
    const st = s as Record<string, any>;
    const c = st.copy2 && typeof st.copy2 === 'object' ? st.copy2 : null;
    const src = String(st.source ?? c?.source ?? '').toLowerCase();
    out.active = src === 'pool-events' || (!!c && c.active !== false && src !== 'feed');
    if (!out.active) return out;
    const body = c ?? st;
    const states = new Map<string, Copy2PoolState>();
    let seen = false;
    const pools = body.pools;
    if (Array.isArray(pools)) {
      seen = true;
      for (const p of pools) {
        if (!p || typeof p !== 'object') continue;
        const key = String(p.v4Id ?? p.v4_id ?? p.key ?? p.address ?? p.pool ?? '').toLowerCase();
        if (key) states.set(key, stateWord(p));
      }
    } else if (pools && typeof pools === 'object') {
      seen = true;
      for (const [k, v] of Object.entries(pools)) states.set(k.toLowerCase(), stateWord(v));
    }
    for (const w of ['ready', 'loading', 'unsure'] as const) {
      if (Array.isArray(body[w])) {
        seen = true;
        for (const k of body[w]) if (typeof k === 'string') states.set(k.toLowerCase(), w);
      }
    }
    if (seen) out.states = states;
    // Counts: from the per-pool list, else from plain numbers if given.
    if (seen) {
      const n = { ready: 0, loading: 0, unsure: 0, tracked: states.size };
      for (const v of states.values()) n[v]++;
      out.counts = n;
    } else {
      const num = (k: string) => (Number.isFinite(Number(body[k])) ? Number(body[k]) : 0);
      const n = { ready: num('ready'), loading: num('loading'), unsure: num('unsure'), tracked: num('tracked') };
      if (n.ready || n.loading || n.unsure || n.tracked) out.counts = { ...n, tracked: n.tracked || n.ready + n.loading + n.unsure };
    }
  } catch { /* unreadable status: treated as "not running" */ }
  return out;
}

// ============================================================================
// Copy2Link: runs copy 2 from the bot's side (created by the fast check host,
// execution/localSimHost.ts, only when LOCAL_SIM is shadow or on).
//
//   - asks the fast check every 2 s how it is doing (status): is it
//     following pools ("pool-events" mode), and which pools are ready
//   - only while it is: asks the block reader's WebSocket for the extra
//     events (the "tap"), and sends the track list of the pools the
//     subscription really covers
//   - passes the pool reports on (Copy2Forwarder)
//   - answers the bot's question "may the fast check decide this route?"
//     (route): yes only if copy 2 runs, the reports are flowing without a
//     gap, its status is fresh, and EVERY pool on the route is ready
//
// Settings (.env):
//   LOCAL_SIM_COPY2          auto (default): used when the fast check runs in
//                            pool-events mode; off: never (old behaviour)
//   COPY2_SKIP_DEXES         exchange names never followed, comma separated
//   COPY2_HOLD_MS            4     wait after a block's last report
//   COPY2_TS_WAIT_MS         40    wait for a block's time from the feed
//   COPY2_STATUS_MS          2000  how often readiness is asked
//   COPY2_MAX_STATUS_AGE_MS  10000 older readiness = not trusted (node decides)
//   COPY2_BACKFILL_MAX       200   most blocks filled in after an outage
//   ARBSIM_L2_BLOCK_OFFSET   0     block number = feed sequence number + this
// ============================================================================
export type Copy2Settings = {
  mode: 'auto' | 'off';
  skipDexes: Set<string>;
  holdMs: number;
  tsWaitMs: number;
  statusEveryMs: number;
  maxStatusAgeMs: number;
  maxBackfill: number;
  l2Offset: number;
};

export function copy2Settings(env: Record<string, string | undefined> = process.env): Copy2Settings {
  const num = (k: string, d: number, min = 0) => { const v = Number(env[k]); return env[k] !== undefined && env[k] !== '' && Number.isFinite(v) && v >= min ? v : d; };
  const mode = (env.LOCAL_SIM_COPY2 ?? '').trim().toLowerCase();
  return {
    mode: mode === 'off' || mode === '0' || mode === 'no' ? 'off' : 'auto',
    skipDexes: new Set((env.COPY2_SKIP_DEXES ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)),
    holdMs: num('COPY2_HOLD_MS', 4),
    tsWaitMs: num('COPY2_TS_WAIT_MS', 40),
    statusEveryMs: num('COPY2_STATUS_MS', 2_000, 200),
    maxStatusAgeMs: num('COPY2_MAX_STATUS_AGE_MS', 10_000, 500),
    maxBackfill: num('COPY2_BACKFILL_MAX', 200, 1),
    l2Offset: num('ARBSIM_L2_BLOCK_OFFSET', 0),
  };
}

type LinkClient = Pick<LocalSimClient, 'request' | 'sendOneWay' | 'isConnected'>;

export type Copy2LinkOptions = {
  client: LinkClient;
  settings: Copy2Settings;
  pools: () => Iterable<PoolState | undefined>;   // the watched Robinhood pools
  poolManager: string;
  now?: () => number;
  log?: (m: string) => void;
  schedule?: (fn: () => void, ms: number) => () => void;
  autoTimers?: boolean;                             // default true (tests drive it by hand)
};

export type Copy2Route = { at: { block: string }; block: number };

const EMPTY_INDEX: Copy2Index = { pools: new Set(), ids: new Set(), poolManager: '', coins: new Set() };

export class Copy2Link {
  readonly forwarder: Copy2Forwarder;
  readonly times: FeedBlockTimes;
  readonly tap: RawLogTap;
  private readonly o: Copy2LinkOptions;
  private readonly now: () => number;
  private timers: NodeJS.Timeout[] = [];

  private sidecarOn = false;                         // the fast check says it follows pools
  private states: Map<string, Copy2PoolState> | null = null;
  private statusCounts: Copy2Status['counts'] = null;
  private statusAt = 0;
  private desired: Copy2Pool[] = [];
  private desiredAt = -Infinity;
  private desiredSkipped: Record<string, number> = {};
  private coverage: Copy2Coverage | null = null;
  private tracked: Copy2Pool[] = [];
  private trackedSig = '';
  private trackOk = false;
  private trackBusy = false;
  private index: Copy2Index = EMPTY_INDEX;
  private backfillRpc: ((method: string, params: unknown[]) => Promise<any>) | null = null;
  private loggedState = '';

  // Hourly counters (taken by hourText).
  private hour = { fast: 0, notReady: {} as Record<string, number> };

  constructor(o: Copy2LinkOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    const s = o.settings;
    this.times = new FeedBlockTimes(s.l2Offset);
    this.forwarder = new Copy2Forwarder({
      send: (m) => o.client.sendOneWay(m),
      index: () => this.index,
      blockTime: (b) => this.times.get(b),
      backfillRpc: () => this.backfillRpc,
      holdMs: s.holdMs,
      tsWaitMs: s.tsWaitMs,
      maxBackfill: s.maxBackfill,
      now: this.now,
      schedule: o.schedule,
      log: (m) => this.log(m),
    });
    // What the block reader's WebSocket calls (see core/blockReaderWs.ts RawLogTap).
    this.tap = {
      wanted: () => s.mode !== 'off' && this.sidecarOn,
      transferFilter: () => transferFilterOf(this.desiredList()),
      onLogs: (logs) => this.forwarder.onLogs(logs),
      onLive: (cov) => {
        this.coverage = cov;
        this.forwarder.onLive();
        void this.sendTrack(false);
      },
      onDown: () => this.forwarder.onDown(),
    };
    if (o.autoTimers !== false && s.mode !== 'off') {
      const every = (fn: () => void, ms: number) => { const t = setInterval(() => { try { fn(); } catch { /* never throws */ } }, ms); t.unref?.(); this.timers.push(t); };
      every(() => { void this.pollStatus(); }, s.statusEveryMs);
      every(() => { void this.sendTrack(false); this.logIfChanged(); }, 30_000);
      every(() => { void this.sendTrack(true); }, 10 * 60_000);
    }
  }

  private log(m: string): void { try { (this.o.log ?? console.log)(m); } catch { /* logging only */ } }

  // The HTTP node used to fill in blocks missed during a WebSocket outage.
  setBackfillRpc(rpc: ((method: string, params: unknown[]) => Promise<any>) | null): void { this.backfillRpc = rpc; }

  // Every raw sequencer-feed message (for block times). Cheap; only while copy 2 runs.
  noteFeed(text: string): void { if (this.sidecarOn) this.times.noteFrame(text); }

  // The pools copy 2 should follow (from the watch list, rebuilt at most every 5 s).
  desiredList(): Copy2Pool[] {
    const t = this.now();
    if (t - this.desiredAt >= 5_000) {
      try {
        const r = buildTrackList(this.o.pools(), this.o.poolManager, this.o.settings.skipDexes);
        this.desired = r.pools;
        this.desiredSkipped = r.skipped;
      } catch { /* keep the last list */ }
      this.desiredAt = t;
    }
    return this.desired;
  }

  // The fast check (re)connected: it may have restarted, so start over.
  onClientConnect(): void {
    this.trackOk = false;
    this.trackedSig = '';
    this.forwarder.setActive(false);
    void this.pollStatus();
  }

  // ---- status ---------------------------------------------------------------
  async pollStatus(): Promise<void> {
    try {
      if (this.o.settings.mode === 'off' || !this.o.client.isConnected()) return;
      const a: SidecarAnswer = await this.o.client.request({ type: 'status', pools: true }, 2_000);
      if (a.ok !== true) return;
      this.applyStatus(a);
    } catch { /* next poll */ }
  }

  applyStatus(a: unknown): void {
    const st = parseCopy2Status(a);
    const was = this.sidecarOn;
    this.sidecarOn = st.active;
    this.states = st.states;
    this.statusCounts = st.counts;
    this.statusAt = this.now();
    if (!st.active) {
      if (was) this.log('[copy2] the fast check is not following pools (pool-events mode off): copy 2 routing off');
      this.trackOk = false;
      this.forwarder.setActive(false);
      return;
    }
    if (!was) this.log('[copy2] the fast check follows our pools from their events (pool-events mode): asking the WebSocket for the extra events');
    if (!this.trackOk) void this.sendTrack(false);
  }

  // ---- track ----------------------------------------------------------------
  // Send the list of pools copy 2 follows: watched, a supported type, and
  // fully covered by the live WebSocket subscription.
  async sendTrack(force: boolean): Promise<void> {
    if (this.trackBusy) return;
    try {
      if (!this.sidecarOn || !this.coverage || !this.o.client.isConnected()) return;
      const list = coveredPools(this.desiredList(), this.coverage);
      const sig = list.map(copy2Key).join(',');
      if (!force && this.trackOk && sig === this.trackedSig) return;
      this.trackBusy = true;
      const a = await this.o.client.request({ type: 'track', pools: list }, 5_000);
      if (a.ok !== true) {
        this.trackOk = false;
        this.forwarder.setActive(false);
        this.log(`[copy2] track list not accepted (${(a as { unknown?: string }).unknown ?? 'no reason'}); the node decides every check`);
        return;
      }
      const changed = sig !== this.trackedSig;
      this.tracked = list;
      this.trackedSig = sig;
      this.index = indexOf(list, this.o.poolManager);
      this.trackOk = true;
      this.forwarder.setActive(true);
      if (changed) {
        const skipped = Object.entries(this.desiredSkipped).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([w, n]) => `${w} ${n}`).join(', ');
        const notCovered = this.desired.length - list.length;
        this.log(`[copy2] following ${list.length} pools (${kindCounts(list) || 'none'})${notCovered ? `, ${notCovered} wait for the next WebSocket renewal` : ''}${skipped ? ` | not followed: ${skipped}` : ''}`);
      }
    } catch {
      /* next try */
    } finally {
      this.trackBusy = false;
    }
  }

  // ---- routing ----------------------------------------------------------------
  // Why the fast check may NOT decide a route with these pools right now
  // (null = it may). Keys: pool addresses, V4 pool ids, the loan pool.
  notReadyWhy(keys: Array<string | undefined | null>): string | null {
    if (this.o.settings.mode === 'off' || !this.sidecarOn) return 'copy 2 not running';
    if (!this.trackOk) return 'track list not accepted yet';
    if (!this.forwarder.live()) return 'pool reports not flowing';
    const t = this.now();
    if (t - this.statusAt > this.o.settings.maxStatusAgeMs) return 'readiness too old';
    if (this.statusAt <= this.forwarder.lastGapAt()) return 'reloading after a gap';
    if (!this.states) return 'readiness not reported';
    let any = false;
    for (const k of keys) {
      if (!k) continue;
      any = true;
      const key = k.toLowerCase();
      const isTracked = key.length === 66 ? this.index.ids.has(key) : this.index.pools.has(key);
      if (!isTracked) return 'pool not followed';
      const s = this.states.get(key);
      if (s !== 'ready') return s === 'loading' ? 'pool loading' : 'pool unsure';
    }
    return any ? null : 'no pools given';
  }

  // The route's `at` for the fast check (state right after the newest block
  // whose reports were passed on, at least minBlock), or null = the node
  // decides. Counted for the hourly line.
  route(keys: Array<string | undefined | null>, minBlock = -1): Copy2Route | null {
    const why = this.notReadyWhy(keys);
    const block = Math.max(minBlock, this.forwarder.newestBlock());
    if (why || block < 0) {
      const w = why ?? 'no block yet';
      this.hour.notReady[w] = (this.hour.notReady[w] ?? 0) + 1;
      return null;
    }
    this.hour.fast++;
    return { at: { block: '0x' + block.toString(16) }, block };
  }

  // Copy 2 is running (the fast check's old "replay the feed" answers, like
  // "right after this transaction", are then not available).
  running(): boolean { return this.o.settings.mode !== 'off' && this.sidecarOn; }

  // Wait until a transaction's pool reports arrived (it is then in a block).
  waitForTx(hash: string | undefined, ms: number): Promise<number | null> {
    if (!this.running()) return Promise.resolve(null);
    return this.forwarder.waitForTx(hash, ms);
  }

  // ---- reporting ----------------------------------------------------------------
  // e.g. "copy 2: 412 ready, 3 unsure, 5 loading of 420 pools; routed to fast check 120,
  //       to node 30 (pool unsure 20, readiness too old 10); pool reports live: 5321 blocks passed on"
  hourText(): string | null {
    const h = this.hour;
    this.hour = { fast: 0, notReady: {} };
    if (this.o.settings.mode === 'off') return null;
    if (!this.sidecarOn) return 'copy 2: not running (fast check not in pool-events mode)';
    const c = this.statusCounts;
    const f = this.forwarder.counts;
    const node = Object.values(h.notReady).reduce((x, y) => x + y, 0);
    const whys = Object.entries(h.notReady).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w} ${n}`).join(', ');
    return [
      c ? `copy 2: ${c.ready} ready, ${c.unsure} unsure, ${c.loading} loading of ${c.tracked} pools` : `copy 2: following ${this.tracked.length} pools (readiness not reported)`,
      `routed to fast check ${h.fast}, to node ${node}${whys ? ` (${whys})` : ''}`,
      `pool reports ${this.forwarder.modeText()}: ${f.blocksSent} blocks passed on${f.msgsDropped ? `, ${f.msgsDropped} DROPPED` : ''}${f.gaps ? `, ${f.gaps} gaps` : ''}${f.late ? `, ${f.late} late` : ''}${f.backfills ? `, ${f.backfills} outages filled in` : ''}${f.backfillFails ? `, ${f.backfillFails} not filled` : ''}${f.noTimestamp ? `, ${f.noTimestamp} without block time` : ''}`,
    ].join('; ');
  }

  // Short state, logged when it changes (checked every 30 s).
  stateLine(): string {
    return `${this.sidecarOn ? 'on' : 'off'} / following ${this.trackOk ? this.tracked.length : 'none'} / reports ${this.forwarder.modeText()}`;
  }
  logIfChanged(): void {
    const s = this.stateLine();
    if (s !== this.loggedState) { this.loggedState = s; this.log(`[copy2] ${s}`); }
  }

  trackedPools(): readonly Copy2Pool[] { return this.tracked; }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.forwarder.setActive(false);
  }
}

function indexOf(list: readonly Copy2Pool[], poolManager: string): Copy2Index {
  const pools = new Set<string>(), ids = new Set<string>(), coins = new Set<string>();
  for (const p of list) {
    if (p.kind === 'V4') { if (p.v4Id) ids.add(p.v4Id.toLowerCase()); continue; }
    pools.add(p.address.toLowerCase());
    for (const t of [p.token0, p.token1]) if (t !== ZERO_ADDR) coins.add(t.toLowerCase());
  }
  return { pools, ids, poolManager: (poolManager || '').toLowerCase(), coins };
}

function kindCounts(list: readonly Copy2Pool[]): string {
  const n: Record<string, number> = {};
  for (const p of list) n[p.kind] = (n[p.kind] ?? 0) + 1;
  return Object.entries(n).map(([k, v]) => `${k} ${v}`).join(', ');
}
