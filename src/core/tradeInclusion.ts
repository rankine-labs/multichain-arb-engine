import type { PoolState } from './types';

// ============================================================================
// DOES A FRESH READ ALREADY INCLUDE THE TRADE WE ARE FOLLOWING? (Oct 19)
//
// Plain English:
//   When the bot sees someone's trade in the sequencer feed, it re-reads the
//   traded pool from the node ("fresh price at decision time") and then the
//   planner PREDICTS that trade's effect on the pool. The code assumed the
//   fresh read is always from BEFORE the trade. On Robinhood Chain a trade is
//   in a block within a fraction of a second, so the node often already
//   returns the price AFTER the trade. The planner then applied the same
//   trade a second time: the pool looked about twice as moved as it really
//   was, the bot saw a gap that did not exist, sent the trade, and it failed
//   (first live day: 17 of 17 real trades failed, and in practice about 80%
//   of tested trigger trades lost).
//
//   This check compares three prices of the traded pool:
//     before   = our copy from just before the trade (what we had cached)
//     read     = what the node returned just now
//     expected = before + the trade's predicted effect
//   If the read has already moved at least half of the way from "before"
//   towards "expected", in the same direction, the node has the trade in it:
//   plan with the read AS IS (no second application). Otherwise the read is
//   still from before the trade, and the prediction is applied as before.
//   Pure maths, no network.
// ============================================================================

const Q96 = 2 ** 96;

// One number for "the pool's price" (token1 per token0, raw units), or null.
export function midPrice(p: PoolState): number | null {
  if (p.poolType === 'v2') {
    if (p.reserveA === undefined || p.reserveB === undefined || p.reserveA <= 0n || p.reserveB <= 0n) return null;
    const r = Number(p.reserveB) / Number(p.reserveA);
    return Number.isFinite(r) && r > 0 ? r : null;
  }
  if (p.poolType === 'v3') {
    if (p.sqrtPriceX96 === undefined || p.sqrtPriceX96 <= 0n) return null;
    const s = Number(p.sqrtPriceX96) / Q96;
    const r = s * s;
    return Number.isFinite(r) && r > 0 ? r : null;
  }
  return null;
}

export interface InclusionVerdict {
  includes: boolean;   // true = the read already has the trade in it: don't predict it again
  share: number | null; // how far the read moved, as a share of the predicted move (1 = exactly the trade)
}

// `predict` is the planner's own prediction (PoolCache.predictPostTradeState),
// passed in so this file needs no cache.
export function readIncludesTrade(
  before: PoolState, read: PoolState,
  predict: (p: PoolState) => PoolState,
  minShare = Number(process.env.TRADE_INCLUDED_SHARE ?? 0.5),
): InclusionVerdict {
  // No fresh read (our own copy was used): nothing to double count.
  if (read === before) return { includes: false, share: null };
  const expected = predict(before);
  if (expected === before) return { includes: false, share: null }; // pool can't be predicted
  const pb = midPrice(before), pr = midPrice(read), pe = midPrice(expected);
  if (pb === null || pr === null || pe === null) return { includes: false, share: null };
  const predicted = Math.log(pe / pb);
  if (!(Math.abs(predicted) > 1e-9)) return { includes: false, share: null }; // trade too small to tell
  const share = Math.log(pr / pb) / predicted;
  return { includes: Number.isFinite(share) && share >= minShare, share: Number.isFinite(share) ? share : null };
}
