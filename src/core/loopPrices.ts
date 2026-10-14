import { PoolState } from './types';

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
//     - LoopTriggerBook: remembers the feed trades seen since the last loop
//       scan (which pool, which way, how much, and the trade's hash);
//     - loopPoolState: picks the state the loop finder should use for one
//       pool: the REAL (block or RPC confirmed) state, except for a pool the
//       trigger trade just traded on, which gets that one trade's predicted
//       effect applied on top of the real state.
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
}

// Each switch: ON when the loop trader is on (LOOP_TRADER=1), unless set to 0.
// Loop trader off = everything off (and nothing loop-related runs anyway).
export function loopFixFromEnv(env: Record<string, string | undefined> = process.env): LoopFixSwitches {
  const loopsOn = env.LOOP_TRADER === '1' || env.LOOP_TRADER === 'true';
  const on = (k: string) => loopsOn && env[k] !== '0';
  const slice = Number(env.LOOP_SCAN_SLICE_MS ?? 8);
  return {
    realPrices: on('LOOP_REAL_PRICES'),
    keepBlockUpdates: on('LOOP_KEEP_BLOCK_UPDATES'),
    triggerReplay: on('LOOP_TRIGGER_REPLAY'),
    modelVsCheck: on('LOOP_MODEL_VS_CHECK'),
    cheapScan: on('LOOP_CHEAP_SCAN'),
    sliceMs: Number.isFinite(slice) && slice > 0 ? Math.min(50, slice) : 8,
  };
}

// One feed trade on one pool.
export interface TriggerTrade {
  hash?: string;      // the trade's transaction hash (for the replay check)
  inIsA: boolean;     // true = it sold the pool's tokenA (token0) into the pool
  amountIn: bigint;   // how much it sold
  at: number;         // when we saw it (ms)
}

// Feed trades seen since the last loop scan, by pool (lower-case address).
// Bounded: at most MAX_POOLS pools and MAX_PER_POOL trades per pool (a scan
// runs every ~50 ms, so these limits are only hit in a flood).
export class LoopTriggerBook {
  static MAX_POOLS = 500;
  static MAX_PER_POOL = 8;
  private book = new Map<string, TriggerTrade[]>();

  note(pool: string, t: TriggerTrade): void {
    const k = pool.toLowerCase();
    let list = this.book.get(k);
    if (!list) {
      if (this.book.size >= LoopTriggerBook.MAX_POOLS) return;
      list = []; this.book.set(k, list);
    }
    if (list.length >= LoopTriggerBook.MAX_PER_POOL) list.shift();
    list.push(t);
  }

  size(): number { return this.book.size; }

  // Hand over everything noted so far and start a new, empty book.
  take(): Map<string, TriggerTrade[]> {
    const b = this.book;
    this.book = new Map();
    return b;
  }
}

// How a pool's state is predicted after one trade (PoolCache.predictPostTradeState).
export type Predict = (pool: PoolState, inIsA: boolean, amountIn: bigint) => PoolState;

// The state the loop finder should use for one pool.
//   realPrices off: the main cache state (old behaviour: feed predictions included).
//   realPrices on:
//     - a pool the trigger trade(s) of this scan traded on: the confirmed
//       state with ONLY those trades' predicted effect on top (normally one
//       trade). Older feed predictions are NOT stacked up.
//     - every other pool: the confirmed state as is.
//     - no confirmed state: trigger pools fall back to the main state (it
//       already holds the prediction); other pools are left out (we have no
//       real data for them).
export function loopPoolState(
  main: PoolState | undefined, confirmed: PoolState | undefined,
  triggers: TriggerTrade[] | undefined, realPrices: boolean, predict: Predict, now: number,
): PoolState | undefined {
  if (!realPrices) return main;
  if (triggers && triggers.length) {
    if (!confirmed) return main;
    let st = confirmed;
    for (const t of triggers) st = predict(st, t.inIsA, t.amountIn);
    // Fresh for the age filter: the prediction is as new as the trade.
    return st === confirmed ? confirmed : { ...st, lastUpdatedMs: now };
  }
  return confirmed;
}

// Pool (lower-case) -> hash of the latest trigger trade on it, for this scan.
export function triggerHashes(book: Map<string, TriggerTrade[]>): Map<string, { hash: string; at: number }> {
  const out = new Map<string, { hash: string; at: number }>();
  for (const [k, list] of book) {
    for (let i = list.length - 1; i >= 0; i--) {
      const h = list[i].hash;
      if (h) { out.set(k, { hash: h, at: list[i].at }); break; }
    }
  }
  return out;
}
