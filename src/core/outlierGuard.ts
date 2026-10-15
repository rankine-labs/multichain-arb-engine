// ============================================================================
// OUTLIER GUARD (Oct 15, owner approved) -- "too good to be true" profits.
//
// Plain English:
//   Oct 15 report: "Biggest today: $784.95 USDG/ORBIO gap". A practice check
//   said a sitting gap on a small coin (shallowest pool ~$11k) would make
//   ~$785, and no rival bot ever took it. Real 2-pool wins on this chain are
//   $0.10 to $20. A huge profit that sits open for anyone is almost always
//   not real money. Why the check can still say "profit":
//     - the profit is paid in the START coin of the round trip. For the
//       ORBIO gap that coin was ORBIO, not USDG (the gap scanner starts from
//       token1 when it has a price, and USDG is token0). The dollar figure is
//       "ORBIO coins x our ORBIO price", and ORBIO's price comes from thin
//       pools (the "ORBIO problem", core/v3BalanceBook.ts). More coins of a
//       coin nobody can sell in size is not more dollars.
//     - the practice check gives our contract a pretend balance of the start
//       coin (simulator.ts own-money trick). The real contract holds only
//       USDG and WETH.
//   So a big profit is only trusted when:
//     1. it is paid in an anchor coin (USDG or WETH), whose dollar price is
//        not in doubt, AND
//     2. a SECOND, independent check agrees: the same trade run again on a
//        different node still shows most of the profit, and the same trade at
//        HALF size shows a profit that scales the way a real price gap does
//        (between 40% and 95% of the full-size profit; a real gap's profit
//        grows with size but more slowly than the size).
//   Anything else is "outlier": live trading refuses to send it, and
//   practice numbers ("money we'd have made") don't count it.
//
//   Normal wins are never touched: anything under OUTLIER_MIN_USD ($20) is
//   never an outlier, whatever its share of the trade size.
//
// Switches (.env):
//   OUTLIER_GUARD=0       turn the guard off (default on)
//   OUTLIER_MAX_USD=50    profit above this (after gas) is an outlier
//   OUTLIER_MAX_PCT=2     profit above this % of the trade size is an outlier
//   OUTLIER_MIN_USD=20    profit at or under this is never an outlier
// ============================================================================

import type { SimResult } from '../execution/simulator';

export interface OutlierConfig {
  on: boolean;
  maxUsd: number;     // absolute profit line (USD, after gas)
  maxPct: number;     // profit as % of trade size
  minUsd: number;     // never an outlier at or under this
}

// A setting read safely: missing, empty, junk or not above 0 = the default.
const num = (v: string | undefined, dflt: number): number => {
  if (v === undefined || v.trim() === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

export function readOutlierConfig(env: Record<string, string | undefined> = process.env): OutlierConfig {
  return {
    // Only an explicit off value turns it off; anything else keeps it on.
    on: !/^(0|off|false|no)$/i.test((env.OUTLIER_GUARD ?? '').trim()),
    maxUsd: num(env.OUTLIER_MAX_USD, 50),
    maxPct: num(env.OUTLIER_MAX_PCT, 2),
    minUsd: num(env.OUTLIER_MIN_USD, 20),
  };
}

// Is this profit "too good to be true" and in need of the second check?
// netUsd: expected profit after costs. sizeUsd: trade size in USD.
export function isOutlier(netUsd: number, sizeUsd: number, cfg: OutlierConfig): boolean {
  if (!cfg.on) return false;
  if (!Number.isFinite(netUsd)) return true;              // broken number: never trust it
  if (netUsd <= cfg.minUsd) return false;                 // normal wins are never touched
  if (netUsd > cfg.maxUsd) return true;
  if (!(sizeUsd > 0)) return true;                        // no size to compare against: not trusted
  return (netUsd / sizeUsd) * 100 > cfg.maxPct;
}

// Half-size profit must be between these shares of the full-size profit.
export const HALF_SIZE_MIN_SHARE = 0.4;
export const HALF_SIZE_MAX_SHARE = 0.95;
// The second node's full-size profit must be at least this share of the first.
export const SECOND_NODE_MIN_SHARE = 0.5;

export type OutlierVerdict = { ok: true; detail: string } | { ok: false; reason: string };

// The second, independent check for an outlier. Only runs the two extra
// simulations when the profit coin is an anchor coin.
//   tokenIn:      the coin the trade starts and ends with (the profit coin)
//   anchors:      coins whose USD price we trust (USDG, WETH)
//   amountIn:     the trade's start amount (raw units)
//   firstProfit:  profit the first check reported (raw units of tokenIn)
//   simulate:     runs the SAME route for a given start amount on a
//                 DIFFERENT node than the first check
export async function confirmOutlier(o: {
  tokenIn: string;
  anchors: string[];
  amountIn: bigint;
  firstProfit: bigint;
  simulate: (amountIn: bigint) => Promise<SimResult>;
}): Promise<OutlierVerdict> {
  const t = o.tokenIn.toLowerCase();
  if (!o.anchors.some((a) => a.toLowerCase() === t)) {
    return { ok: false, reason: 'profit paid in a coin whose dollar price is not trusted (not USDG/WETH)' };
  }
  if (!(o.amountIn > 1n) || !(o.firstProfit > 0n)) return { ok: false, reason: 'nothing to compare (no amount or no profit)' };
  // 1) Same trade, full size, other node.
  const full = await o.simulate(o.amountIn);
  if (full.status !== 'profit') return { ok: false, reason: `second check (other node) said ${describe(full)}` };
  if (Number(full.profit) < SECOND_NODE_MIN_SHARE * Number(o.firstProfit)) {
    return { ok: false, reason: `second check (other node) shows only ${pct(full.profit, o.firstProfit)} of the first profit` };
  }
  // 2) Same trade at half size: a real gap's profit shrinks, but by less than half.
  const half = await o.simulate(o.amountIn / 2n);
  if (half.status !== 'profit') return { ok: false, reason: `half-size check said ${describe(half)}` };
  const share = Number(half.profit) / Number(full.profit);
  if (!(share >= HALF_SIZE_MIN_SHARE && share <= HALF_SIZE_MAX_SHARE)) {
    return { ok: false, reason: `half-size profit is ${Math.round(share * 100)}% of full size (a real gap gives ${HALF_SIZE_MIN_SHARE * 100}-${HALF_SIZE_MAX_SHARE * 100}%)` };
  }
  return { ok: true, detail: `confirmed on a second node (${pct(full.profit, o.firstProfit)} of first), half size ${Math.round(share * 100)}%` };
}

// Short words for a check result that wasn't a profit.
function describe(r: SimResult): string {
  if (r.status === 'loss') return 'loss';
  if (r.status === 'profit') return 'profit';
  return `${r.status}${'reason' in r && r.reason ? ` (${r.reason.slice(0, 60)})` : ''}`;
}
const pct = (a: bigint, b: bigint): string => `${Math.round((Number(a) / Number(b)) * 100)}%`;
