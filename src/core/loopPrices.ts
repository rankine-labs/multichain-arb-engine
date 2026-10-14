import { PoolState } from './types';
import type { ConfirmedInfo } from './poolCache';

// ============================================================================
// LOOP PRICES (loop fix phase 2) -- which pool states the loop finder uses,
// and which trigger trade a loop follows.
//
// Plain English:
//   The audit found loops looked profitable in the model but almost never
//   passed the practice check. Main reasons:
//     1. Loops were priced on PREDICTED pool states (the trade feed guesses
//        each pool's new price before the trade is in a block). Small guess
//        errors add up over 3 to 5 hops.
//     2. The practice check ran on "latest", not right after the trade that
//        opened the loop.
//
//   This file holds the small, testable pieces of the fix:
//     - the switches (all OFF unless LOOP_TRADER=1, each can be turned off);
//     - PendingTrades: remembers feed trades that a block has NOT confirmed
//       yet (which pool, which way, how much, the trade's hash, feed order);
//     - loopPoolState: picks the state the loop finder should use for one
//       pool: the REAL (block or RPC confirmed) state, plus the predicted
//       effect of every trade on that pool still waiting for its block.
//
//   Nothing here sends anything or asks the node anything.
// ============================================================================

export interface LoopFixSwitches {
  realPrices: boolean;        // LOOP_REAL_PRICES: price loops from block-confirmed states (A)
  keepBlockUpdates: boolean;  // LOOP_KEEP_BLOCK_UPDATES: keep block states the main write skipped (B)
  triggerReplay: boolean;     // LOOP_TRIGGER_REPLAY: check loops right after their trigger trade (C)
  modelVsCheck: boolean;      // LOOP_MODEL_VS_CHECK: model vs check report + real loop gas (D)
  cheapScan: boolean;         // LOOP_CHEAP_SCAN: skip unchanged scans, scan in small slices (E)
  sliceMs: number;            // LOOP_SCAN_SLICE_MS: longest single slice of a loop scan (default 8 ms)
  pendingMaxMs: number;       // LOOP_PENDING_MAX_MS: a feed trade no block has confirmed by then is dropped (default 4 s)
}

// Each switch: ON when the loop trader is on (LOOP_TRADER=1), unless set to 0.
// Loop trader off = everything off (and nothing loop-related runs anyway).
export function loopFixFromEnv(env: Record<string, string | undefined> = process.env): LoopFixSwitches {
  const loopsOn = env.LOOP_TRADER === '1' || env.LOOP_TRADER === 'true';
  const on = (k: string) => loopsOn && env[k] !== '0';
  const slice = Number(env.LOOP_SCAN_SLICE_MS ?? 8);
  const pend = Number(env.LOOP_PENDING_MAX_MS ?? 4_000);
  return {
    realPrices: on('LOOP_REAL_PRICES'),
    keepBlockUpdates: on('LOOP_KEEP_BLOCK_UPDATES'),
    triggerReplay: on('LOOP_TRIGGER_REPLAY'),
    modelVsCheck: on('LOOP_MODEL_VS_CHECK'),
    cheapScan: on('LOOP_CHEAP_SCAN'),
    sliceMs: Number.isFinite(slice) && slice > 0 ? Math.min(50, slice) : 8,
    pendingMaxMs: Number.isFinite(pend) && pend >= 500 ? Math.min(30_000, pend) : 4_000,
  };
}

// One feed trade on one pool.
export interface TriggerTrade {
  hash?: string;      // the trade's transaction hash (for the replay check and to match blocks)
  inIsA: boolean;     // true = it sold the pool's tokenA (token0) into the pool
  amountIn: bigint;   // how much it sold
  at: number;         // when we saw it (ms)
  seq?: number;       // its place in the feed's order (filled in by PendingTrades)
}

// ----------------------------------------------------------------------------
// PENDING TRADES (review fix): feed trades waiting for their block.
//
// Plain English:
//   The feed shows a trade before it is in a block. Until the block reader
//   has read that block, the confirmed state of the pool does NOT include the
//   trade yet, so loops must add its predicted effect. Once the block is read,
//   the confirmed state DOES include it, and adding it again would count it
//   twice. So each trade stays "pending" for its pool until a confirmed state
//   is known to include it:
//     - block reader state: the reader says which transaction made the pool's
//       last event in that read. The feed shows trades in exactly the chain's
//       order, so every pending trade seen up to and including that
//       transaction is in the confirmed state: those are dropped, later ones
//       stay pending.
//     - RPC read (block unknown): trades seen more than RPC_MARGIN_MS before
//       the read was saved are taken as included (an RPC read of a busy pool
//       is only saved when the feed has been quiet on it for a while, see
//       PoolCache.upsertIfNotNewer).
//     - safety net: a trade no block has confirmed within LOOP_PENDING_MAX_MS
//       (4 s) is dropped (its block was missed, or it never landed).
//   Loop price for a pool = confirmed state + every pending trade on it, in
//   feed order. The answer is remembered and reused while nothing changes,
//   so an unchanged pool keeps the same state object (cheap scans can skip).
//
// Bounded: at most MAX_POOLS pools with MAX_PER_POOL trades each, and the
// "feed order" memory keeps the last MAX_SEEN transaction hashes.
// ----------------------------------------------------------------------------
interface PoolPending {
  trades: TriggerTrade[];
  // Last answer: reused while the confirmed state and the pending list are unchanged.
  memo?: { conf: PoolState; n: number; lastSeq: number; state: PoolState };
}

export class PendingTrades {
  static MAX_POOLS = 1_000;
  static MAX_PER_POOL = 16;
  static MAX_SEEN = 5_000;
  static RPC_MARGIN_MS = 1_000;
  private pools = new Map<string, PoolPending>();
  private seenSeq = new Map<string, number>();   // feed tx hash -> its place in the feed's order
  private seq = 0;
  private fresh = new Map<string, { hash: string; at: number }>(); // trades since the last scan (trigger hashes)

  constructor(private maxAgeMs = 4_000) {}

  // Every transaction the feed shows, in order (even ones that aren't trades
  // we decode): gives each its place in the chain's order.
  noteFeedTx(hash: string | undefined): void {
    if (!hash) return;
    const h = hash.toLowerCase();
    if (this.seenSeq.has(h)) return;
    this.seenSeq.set(h, ++this.seq);
    if (this.seenSeq.size > PendingTrades.MAX_SEEN) {
      // Forget the oldest 500 (Maps keep insertion order).
      const it = this.seenSeq.keys();
      for (let i = 0; i < 500; i++) { const k = it.next(); if (k.done) break; this.seenSeq.delete(k.value); }
    }
  }

  // A feed trade on `pool`, waiting for its block.
  note(pool: string, t: TriggerTrade): void {
    const k = pool.toLowerCase();
    const hash = t.hash?.toLowerCase();
    if (hash) this.noteFeedTx(hash);
    const seq = (hash ? this.seenSeq.get(hash) : undefined) ?? ++this.seq;
    let pp = this.pools.get(k);
    if (!pp) {
      if (this.pools.size >= PendingTrades.MAX_POOLS) return;
      pp = { trades: [] }; this.pools.set(k, pp);
    }
    if (pp.trades.length >= PendingTrades.MAX_PER_POOL) pp.trades.shift();
    pp.trades.push({ ...t, ...(hash ? { hash } : {}), seq });
    if (hash) this.fresh.set(k, { hash, at: t.at });
  }

  // Pool -> latest trigger trade hash seen since the last call (for the
  // replay check), then start over. Pending trades stay pending.
  takeFresh(): Map<string, { hash: string; at: number }> {
    const f = this.fresh;
    this.fresh = new Map();
    return f;
  }

  // Drop too-old trades everywhere (pools no scan asked about would
  // otherwise keep their slot). Called once per loop scan.
  sweep(now: number): void {
    for (const [k, pp] of this.pools) {
      if (pp.trades.length && now - pp.trades[pp.trades.length - 1].at <= this.maxAgeMs) continue;
      this.pools.delete(k);
    }
  }

  size(): number { return this.pools.size; }
  pendingCount(pool: string): number { return this.pools.get(pool.toLowerCase())?.trades.length ?? 0; }

  // Drop trades the confirmed state already includes, and too-old ones.
  private prune(pp: PoolPending, info: ConfirmedInfo | undefined, now: number): void {
    let cut = -1; // drop trades with seq <= cut
    if (info && info.fromBlock && info.tx) {
      const s = this.seenSeq.get(info.tx);
      if (s !== undefined) cut = s;
    } else if (info && !info.fromBlock) {
      for (const t of pp.trades) if (t.at < info.at - PendingTrades.RPC_MARGIN_MS && (t.seq ?? 0) > cut) cut = t.seq ?? 0;
    }
    if (cut >= 0 || pp.trades.some((t) => now - t.at > this.maxAgeMs)) {
      pp.trades = pp.trades.filter((t) => (t.seq ?? 0) > cut && now - t.at <= this.maxAgeMs);
    }
  }

  // The state loops should use for `pool`: confirmed + still-pending trades.
  // No pending trades = the confirmed state itself (or the main state when
  // there is no confirmed one: it holds the feed's prediction).
  stateFor(pool: string, main: PoolState | undefined, confirmed: PoolState | undefined, info: ConfirmedInfo | undefined,
    predict: Predict, now: number): PoolState | undefined {
    const k = pool.toLowerCase();
    const pp = this.pools.get(k);
    if (!pp) return confirmed;
    this.prune(pp, info, now);
    if (!pp.trades.length) { this.pools.delete(k); return confirmed; }
    if (!confirmed) return main;
    const n = pp.trades.length, lastSeq = pp.trades[n - 1].seq ?? 0;
    const m = pp.memo;
    if (m && m.conf === confirmed && m.n === n && m.lastSeq === lastSeq) return m.state;
    const state = loopPoolState(main, confirmed, pp.trades, true, predict, now)!;
    pp.memo = { conf: confirmed, n, lastSeq, state };
    return state;
  }
}

// How a pool's state is predicted after one trade (PoolCache.predictPostTradeState).
export type Predict = (pool: PoolState, inIsA: boolean, amountIn: bigint) => PoolState;

// The state the loop finder should use for one pool, given the trades on it
// still waiting for their block (feed order).
//   realPrices off: the main cache state (old behaviour: feed predictions included).
//   realPrices on:
//     - pending trades: the confirmed state with their predicted effect on
//       top, one after the other in feed order;
//     - none: the confirmed state as is;
//     - no confirmed state: pools with pending trades fall back to the main
//       state (it already holds the prediction); other pools are left out
//       (we have no real data for them).
export function loopPoolState(
  main: PoolState | undefined, confirmed: PoolState | undefined,
  pending: TriggerTrade[] | undefined, realPrices: boolean, predict: Predict, now: number,
): PoolState | undefined {
  if (!realPrices) return main;
  if (pending && pending.length) {
    if (!confirmed) return main;
    let st = confirmed;
    for (const t of pending) st = predict(st, t.inIsA, t.amountIn);
    // Fresh for the age filter: the prediction is as new as its latest trade.
    return st === confirmed ? confirmed : { ...st, lastUpdatedMs: Math.max(confirmed.lastUpdatedMs, Math.min(now, pending[pending.length - 1].at)) };
  }
  return confirmed;
}
