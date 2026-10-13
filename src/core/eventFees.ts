import { PoolState, ObservedFee } from './types';

// ============================================================================
// FEES SEEN IN SWAP EVENTS (Oct 13, owner approved; switch FEE_FROM_EVENTS)
//
// Plain English:
//   Some pools change their fee all the time ("dynamic fee"): Fables (Uniswap
//   V4 with a hook) and Algebra Integral copies. The bot used to learn their
//   fee only by re-reading the pool every few seconds (or guess 0.30% for a
//   hooked V4 pool it hadn't read). But every swap ANNOUNCES the fee it paid:
//     - Uniswap V4 Swap event, last field "fee" (pips: 1,000,000 = 100%):
//       the full fee that swap was charged (hook-set LP fee + protocol fee).
//     - Algebra Integral Swap event, last two fields overrideFee, pluginFee:
//       overrideFee > 0 means the pool's plugin replaced the normal fee for
//       that swap; pluginFee is an extra fee on top. The swap paid
//       (overrideFee, or the pool's own fee when it is 0) + pluginFee.
//       (Algebra Integral 1.2 AlgebraPool.swap / IAlgebraPoolEvents.Swap.)
//   The block reader already receives these events every block, so the fee
//   comes free (no extra node requests). We keep the latest one per pool and
//   direction and the swap maths uses it while it is NEWER than the last fee
//   read from the chain (a fresh read wins again until the next swap).
//
//   "Newer" is decided by BLOCK NUMBER (review fix, Oct 13): each fee read
//   remembers the chain's block at that moment (feeReadBlock) and an event
//   counts only if its block is after that. So a gap-fill replay of old
//   blocks can never beat a fresher read just because it was processed later.
//
//   Safety rules:
//     - only fees from the last FEE_EVENT_MAX_AGE_MS (default 10 min; also
//       counted in blocks when the current block is known);
//     - DIRECTION-AWARE (review fix, Oct 13): Fables hooks and Algebra
//       Integral plugins can charge a different fee each way. A trade uses
//       the fee seen for ITS direction. If only the other direction was
//       seen, it uses the higher of that and the read fee: never lower.
//       Callers that don't say the direction get the higher of the two
//       directions (or of the one seen and the read fee);
//     - hooked V4 pools with the dynamic flag that never had a swap seen:
//       unchanged (the Fables fee predictor / 0.30% estimate), and counted.
//   FEE_FROM_EVENTS=0 = old behaviour exactly (events ignored).
// ============================================================================

// Is the feature on? Read once at start; tests switch it with setFeeFromEvents.
let enabled = !/^(0|false|off|no)$/i.test((process.env.FEE_FROM_EVENTS ?? '').trim());
let maxAgeMs = (() => {
  const n = Number(process.env.FEE_EVENT_MAX_AGE_MS ?? 600_000);
  return Number.isFinite(n) && n >= 1_000 ? n : 600_000;
})();
let clock: () => number = Date.now;
// The chain's current block, when the bot knows it (shadowMain sets it).
// Fee reads stamp it as feeReadBlock; events must be after it to count.
let headBlock: () => number | null = () => null;
export function setHeadBlockSource(fn: () => number | null): void { headBlock = fn; }
export function currentHeadBlock(): number | null {
  try { const b = headBlock(); return b !== null && Number.isFinite(b) && b > 0 ? Math.floor(b) : null; } catch { return null; }
}
// Blocks per millisecond guess for the block-based age limit (Robinhood ~30 ms blocks).
const BLOCK_MS_GUESS = 30;

export function feeFromEventsOn(): boolean { return enabled; }
// Tests only: switch on/off, change the age limit and the clock.
export function setFeeFromEvents(on: boolean, opts: { maxAgeMs?: number; now?: () => number } = {}): void {
  enabled = on;
  if (opts.maxAgeMs !== undefined) maxAgeMs = opts.maxAgeMs;
  if (opts.now) clock = opts.now;
}

// V4 "dynamic fee" flag in a pool key's fee field (0x800000).
export const V4_DYNAMIC_FLAG = 0x800000;
// A pool whose fee can change from swap to swap.
export function isDynamicFeePool(p: PoolState): boolean {
  return p.variant === 'algebra' || (!!p.v4 && (p.v4.fee >= V4_DYNAMIC_FLAG || !!p.v4.hooks));
}

const validPips = (f: unknown): f is number => typeof f === 'number' && Number.isInteger(f) && f >= 0 && f < 1_000_000;

// What one event says about the fee (only the fields this file needs, so the
// block reader's PoolUpdate fits without importing it here).
export interface SwapFeeEvent {
  block: number;
  zeroForOne?: boolean;
  v4Fee?: number;
  algebraFee?: { override: number; plugin: number };
}

// The fee the pool's own fee field says (before any event fee): exact pips if
// known, else whole bps (same rule as dexMath.feePipsOf without events).
export function readFeePips(pool: PoolState): number {
  if (validPips(pool.feePips)) return pool.feePips;
  if (pool.v4 && validPips(pool.v4.fee)) return pool.v4.fee;
  return Math.max(0, Math.min(999_999, Math.round(pool.feeBps * 100)));
}

// Store the fee a swap event shows on the pool (changes `pool.observedFee`).
// Returns true when it stored something. Does nothing when switched off.
export function recordEventFee(pool: PoolState, ev: SwapFeeEvent, nowMs: number = clock()): boolean {
  if (!enabled || ev.zeroForOne === undefined) return false;
  const dir: 'z' | 'o' = ev.zeroForOne ? 'z' : 'o';
  let pips: number | null = null;
  if (ev.v4Fee !== undefined && pool.v4) {
    pips = validPips(ev.v4Fee) ? ev.v4Fee : null;
  } else if (ev.algebraFee && pool.variant === 'algebra') {
    const { override, plugin } = ev.algebraFee;
    if (override === 0 && plugin === 0) {
      // The swap paid the pool's own fee, which the bot reads from
      // globalState: forget any older override for this direction.
      if (pool.observedFee?.[dir]) {
        const rest = { ...pool.observedFee };
        delete rest[dir];
        pool.observedFee = rest;
      }
      return false;
    }
    const sum = (override > 0 ? override : readFeePips(pool)) + plugin;
    pips = validPips(sum) ? sum : null;
  }
  if (pips === null) return false;
  const cur = pool.observedFee?.[dir];
  if (cur && cur.block > ev.block) return false;            // never replace a newer one
  const obs: ObservedFee = { pips, block: ev.block, atMs: nowMs };
  pool.observedFee = { ...(pool.observedFee ?? {}), [dir]: obs };
  return true;
}

// Is this event fee still usable? Newer than the last fee read (by block when
// the read's block is known, else by time) and not too old.
function usable(x: ObservedFee | undefined, pool: PoolState, nowMs: number, head: number | null): x is ObservedFee {
  if (!x || !validPips(x.pips)) return false;
  if (nowMs - x.atMs > maxAgeMs) return false;
  if (head !== null && head - x.block > maxAgeMs / BLOCK_MS_GUESS) return false;   // old block replayed late
  if (pool.feeReadBlock !== undefined) return x.block > pool.feeReadBlock;
  return x.atMs >= (pool.feeReadMs ?? 0);
}

// The event fee to use for this pool right now, or null = use the normal fee.
// zeroForOne: the trade's direction (true = selling token0 / tokenA) when the
// caller knows it; undefined = could be either way (most conservative).
export function eventFeePips(pool: PoolState, nowMs: number = clock(), zeroForOne?: boolean): number | null {
  if (!enabled || !pool.observedFee) return null;
  const head = currentHeadBlock();
  const z = usable(pool.observedFee.z, pool, nowMs, head) ? pool.observedFee.z!.pips : null;
  const o = usable(pool.observedFee.o, pool, nowMs, head) ? pool.observedFee.o!.pips : null;
  if (z === null && o === null) return null;
  if (zeroForOne !== undefined) {
    const mine = zeroForOne ? z : o, other = zeroForOne ? o : z;
    if (mine !== null) return mine;                      // seen for this very direction
    return Math.max(other!, readFeePips(pool));          // only the other way seen: never lower
  }
  if (z !== null && o !== null) return Math.max(z, o);   // both seen: the higher
  return Math.max((z ?? o)!, readFeePips(pool));         // one seen, direction unknown: never lower
}

// For the hourly report: pools whose fee currently comes from events, and
// dynamic V4 pools (flag set) that have never had a swap fee seen.
export function eventFeeCounts(pools: Iterable<PoolState>, nowMs: number = clock()): { fromEvents: number; waiting: number } {
  let fromEvents = 0, waiting = 0;
  for (const p of pools) {
    if (eventFeePips(p, nowMs) !== null) fromEvents++;
    else if (p.v4 && (p.v4.fee >= V4_DYNAMIC_FLAG) && !p.observedFee?.z && !p.observedFee?.o) waiting++;
  }
  return { fromEvents, waiting };
}
