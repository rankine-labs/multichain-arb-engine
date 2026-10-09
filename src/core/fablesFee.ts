import { ethers } from 'ethers';

// ============================================================================
// FABLES FEE PREDICTOR (read-only, never sends anything)
//
// Plain English:
//   Fables pools live on the normal Uniswap V4 PoolManager, but their listed
//   fee is a "dynamic fee" flag and StateView's lpFee reads 0. The real fee
//   is picked by each pool's hook contract at the moment of the swap.
//
//   Probe runs (scripts/probe-fables-fee.ts, Oct 9) decoded the hooks'
//   function list. Every Fables hook has a public read-only function
//       currentFee(bytes32 poolId, bool zeroForOne) returns (uint24 pips)
//   which returns the fee the NEXT swap in that direction will pay. It takes
//   no swap size, so size does not change the fee. Behind it:
//     - crypto / meme pools: a per-pool flat fee, optionally raised for one
//       direction ("asymmetry"), plus a short, expiring override ("poke")
//       that Fables' off-chain software sets when markets move;
//     - tokenized-stock pools: a trading-calendar floor (market open, closed,
//       holiday "day overrides") plus the same poke override, which decays
//       back down over a few minutes after it is set.
//   So the fee for a swap = currentFee(id, direction) read just before it.
//
//   This module gives the bot:
//     1. fablesFeeCalls / parseFablesFees / readFablesFees: one Multicall3
//        request that reads currentFee for BOTH directions of EVERY Fables
//        pool (2 x ~65 tiny calls), cheap enough for the 5 s price re-sync.
//     2. FablesFeeBook: remembers the latest read per pool and direction and
//        the fees real swaps paid recently (from the Swap event's last word).
//     3. predictFablesFeePips: a pure function that picks the fee to assume
//        for a trade: the fresh hook read when we have one, never lower than
//        anything paid in the last few seconds; otherwise the highest fee
//        recently seen; otherwise a conservative default.
// ============================================================================

// currentFee(bytes32,bool): the fee (pips, 1e6 = 100%) the next swap pays.
export const SEL_FABLES_CURRENT_FEE = ethers.id('currentFee(bytes32,bool)').slice(0, 10);
// V4 fees are in pips; anything at or above 100% is nonsense.
const MAX_SANE_PIPS = 1_000_000;
// Default used when nothing at all is known about a pool (same as the pair
// watcher's HOOKED_V4_FEE_ESTIMATE_PIPS default).
export const FABLES_DEFAULT_FALLBACK_PIPS = 3000;

export interface FablesPoolRef {
  id: string;     // 32-byte V4 pool id (0x + 64 hex)
  hooks: string;  // the pool's hook contract
}

export interface FablesFeeRead {
  zeroForOne: number | null; // fee for selling currency0 (pips), null = unreadable
  oneForZero: number | null; // fee for selling currency1 (pips)
}

// Two calls per pool: currentFee(id, true) then currentFee(id, false).
export function fablesFeeCalls(pools: FablesPoolRef[]): { target: string; data: string }[] {
  const out: { target: string; data: string }[] = [];
  for (const p of pools) {
    const id = p.id.toLowerCase().replace(/^0x/, '').padStart(64, '0');
    out.push({ target: p.hooks, data: SEL_FABLES_CURRENT_FEE + id + '1'.padStart(64, '0') });
    out.push({ target: p.hooks, data: SEL_FABLES_CURRENT_FEE + id + '0'.padStart(64, '0') });
  }
  return out;
}

// Reads the first 32-byte word of a return value as a fee; null when the call
// failed, returned nothing, or returned a value that cannot be a fee.
export function decodeFeeWord(r: string | null | undefined): number | null {
  if (!r || r.length < 66) return null;
  const v = BigInt(r.slice(0, 66));
  return v < BigInt(MAX_SANE_PIPS) ? Number(v) : null;
}

// Matches multicall results (in fablesFeeCalls order) back to pool ids.
export function parseFablesFees(pools: FablesPoolRef[], results: (string | null)[]): Map<string, FablesFeeRead> {
  const out = new Map<string, FablesFeeRead>();
  pools.forEach((p, i) => out.set(p.id.toLowerCase(), { zeroForOne: decodeFeeWord(results[2 * i]), oneForZero: decodeFeeWord(results[2 * i + 1]) }));
  return out;
}

// One bundled read of every pool's current fee in both directions. `callMany`
// is the bot's usual Multicall3 helper (allowFailure per call).
export async function readFablesFees(
  callMany: (calls: { target: string; data: string }[]) => Promise<(string | null)[]>,
  pools: FablesPoolRef[],
): Promise<Map<string, FablesFeeRead>> {
  if (!pools.length) return new Map();
  return parseFablesFees(pools, await callMany(fablesFeeCalls(pools)));
}

// ----------------------------------------------------------------------------
// Pure prediction.
export interface FablesPredictInput {
  nowMs: number;
  // Latest currentFee read for this pool and direction, if any.
  live?: { feePips: number; readAtMs: number } | null;
  // The read before that (lets a steady calendar ramp be continued).
  prev?: { feePips: number; readAtMs: number } | null;
  // How long until our trade lands after nowMs (default 1 s).
  leadMs?: number;
  // Fees real swaps paid in this direction recently (pips + when).
  observed?: { feePips: number; atMs: number }[];
  // How old a live read may be and still be trusted (default 15 s: the bot
  // re-reads every 5 s, so this allows two missed refreshes).
  maxLiveAgeMs?: number;
  // A paid fee newer than this counts as "just now" and acts as a floor on
  // the live read (a poke can raise the fee between our reads). Default 5 s.
  floorWindowMs?: number;
  // How far back observed fees count for the fallback (default 30 min).
  observedWindowMs?: number;
  // Used when nothing is known (default 3000 pips = 0.30%).
  fallbackPips?: number;
}

export interface FablesPrediction {
  feePips: number;
  // 'hook': fresh currentFee read; 'observed': highest recent paid fee;
  // 'fallback': nothing known, conservative default.
  source: 'hook' | 'observed' | 'fallback';
}

// Rising fee between the previous and the latest read (a calendar ramp, e.g.
// the 30 minutes before the stock market closes): continue the climb up to
// the moment our trade lands. Only small, steady climbs count: a jump of
// more than RAMP_MAX_STEP (an override being set) is not a ramp.
const RAMP_MAX_STEP = 0.1;
export function rampedFee(live: { feePips: number; readAtMs: number }, prev: { feePips: number; readAtMs: number } | null | undefined, atMs: number): number {
  if (!prev) return live.feePips;
  const dt = live.readAtMs - prev.readAtMs, rise = live.feePips - prev.feePips;
  if (dt <= 0 || dt > 20_000 || rise <= 0 || rise > prev.feePips * RAMP_MAX_STEP) return live.feePips;
  const ahead = Math.max(0, atMs - live.readAtMs);
  // Never extrapolate further than one more read interval's worth of climb.
  return Math.ceil(live.feePips + rise * Math.min(1, ahead / dt));
}

export function predictFablesFeePips(inp: FablesPredictInput): FablesPrediction {
  const maxAge = inp.maxLiveAgeMs ?? 15_000;
  const floorWin = inp.floorWindowMs ?? 5_000;
  const obsWin = inp.observedWindowMs ?? 30 * 60_000;
  const fallback = inp.fallbackPips ?? FABLES_DEFAULT_FALLBACK_PIPS;
  const obs = (inp.observed ?? []).filter((o) => o.feePips >= 0 && o.feePips < MAX_SANE_PIPS && o.atMs <= inp.nowMs);
  const live = inp.live && inp.live.feePips >= 0 && inp.live.feePips < MAX_SANE_PIPS ? inp.live : null;
  if (live && inp.nowMs - live.readAtMs <= maxAge) {
    // A swap that paid more AFTER our read means the fee went up since:
    // trust the newer, higher number.
    const newer = obs.filter((o) => o.atMs >= live.readAtMs && inp.nowMs - o.atMs <= floorWin).map((o) => o.feePips);
    const ramp = rampedFee(live, inp.prev, inp.nowMs + (inp.leadMs ?? 1000));
    return { feePips: Math.max(ramp, ...newer), source: 'hook' };
  }
  const recent = obs.filter((o) => inp.nowMs - o.atMs <= obsWin).map((o) => o.feePips);
  if (recent.length) return { feePips: Math.max(...recent, live?.feePips ?? 0), source: 'observed' };
  return { feePips: Math.max(fallback, live?.feePips ?? 0), source: 'fallback' };
}

// ----------------------------------------------------------------------------
// Small stateful book the bot can keep next to its pool cache.
export class FablesFeeBook {
  private live = new Map<string, { feePips: number; readAtMs: number }>();
  private seen = new Map<string, { feePips: number; atMs: number }[]>();
  constructor(private readonly opts: { keepMs?: number; maxPerKey?: number } = {}) {}

  private key(id: string, zeroForOne: boolean) { return `${id.toLowerCase()}:${zeroForOne ? 1 : 0}`; }

  private prev = new Map<string, { feePips: number; readAtMs: number }>();

  // Store a bundled read (readFablesFees result). The read it replaces is
  // kept as `prev` so a steady ramp can be continued.
  applyRead(reads: Map<string, FablesFeeRead>, atMs: number) {
    const put = (k: string, fee: number | null) => {
      if (fee === null) return;
      const old = this.live.get(k);
      if (old && old.readAtMs < atMs) this.prev.set(k, old);
      this.live.set(k, { feePips: fee, readAtMs: atMs });
    };
    for (const [id, r] of reads) {
      put(this.key(id, true), r.zeroForOne);
      put(this.key(id, false), r.oneForZero);
    }
  }

  // Latest read for one pool and direction (null if never read).
  liveFee(id: string, zeroForOne: boolean): { feePips: number; readAtMs: number } | null {
    return this.live.get(this.key(id, zeroForOne)) ?? null;
  }

  // Record a real swap's fee (V4 Swap event: last data word = fee charged;
  // zeroForOne = amount0 < 0, the swapper paid currency0).
  observeSwap(id: string, zeroForOne: boolean, feePips: number, atMs: number) {
    const k = this.key(id, zeroForOne);
    const keep = this.opts.keepMs ?? 30 * 60_000, cap = this.opts.maxPerKey ?? 200;
    const list = (this.seen.get(k) ?? []).filter((o) => atMs - o.atMs <= keep);
    list.push({ feePips, atMs });
    if (list.length > cap) list.splice(0, list.length - cap);
    this.seen.set(k, list);
  }

  predict(id: string, zeroForOne: boolean, nowMs: number, extra: Omit<FablesPredictInput, 'nowMs' | 'live' | 'prev' | 'observed'> = {}): FablesPrediction {
    const k = this.key(id, zeroForOne);
    return predictFablesFeePips({ ...extra, nowMs, live: this.live.get(k) ?? null, prev: this.prev.get(k) ?? null, observed: this.seen.get(k) ?? [] });
  }
}
