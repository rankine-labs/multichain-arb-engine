import { DecodedSwap } from './types';
import { PoolCache } from './poolCache';

// ============================================================================
// FAST FILTER
//
// We do NOT want to deeply simulate every decoded swap. Most trades can't
// move a pool enough to create arbitrage. This asks cheap questions first:
//   - Do we even track this pool?
//   - Does a peer venue exist to arb against? (redundant fast-path check
//     ahead of full pool discovery re-evaluation)
//   - Is this trade large enough, relative to pool depth, to matter?
//
// Goal: out of maybe 100,000 events, only a few hundred should reach the
// expensive simulate-and-size step.
// ============================================================================

export interface FastFilterConfig {
// Trade must be at least this fraction of pool reserves to be worth
// simulating. Below this, price impact is too small to clear costs.
minTradeToPoolLiquidityRatio: number; // e.g. 0.01 = trade must be >=1% of pool depth
}

export const DEFAULT_FILTER_CONFIG: FastFilterConfig = {
minTradeToPoolLiquidityRatio: 0.01,
};

export type FilterOutcome =
| { pass: true }
| { pass: false; reason: 'POOL_NOT_TRACKED' | 'NO_PEER_VENUE' | 'TRADE_TOO_SMALL' | 'ZERO_AMOUNT' };

export class FastFilter {
constructor(
private cache: PoolCache,
private config: FastFilterConfig = DEFAULT_FILTER_CONFIG,
) {}

evaluate(swap: DecodedSwap): FilterOutcome {
if (swap.amountIn <= 0n) {
return { pass: false, reason: 'ZERO_AMOUNT' };
}

const pool = this.cache.get(swap.chain, swap.poolAddress);
if (!pool) {
return { pass: false, reason: 'POOL_NOT_TRACKED' };
}

const peers = this.cache.findPeerPools(swap.chain, swap.tokenIn, swap.tokenOut, swap.poolAddress);
if (peers.length === 0) {
return { pass: false, reason: 'NO_PEER_VENUE' };
}

// Cheap size check using whichever reserve side matches tokenIn.
// v3 pools don't have simple reserves — fall back to letting v3 through
// to full simulation, since a fast liquidity proxy isn't available here
// without tick-level math.
if (pool.poolType === 'v2' && pool.reserveA !== undefined && pool.reserveB !== undefined) {
const relevantReserve = swap.tokenIn.toLowerCase() === pool.tokenA.toLowerCase()
? pool.reserveA
: pool.reserveB;

if (relevantReserve > 0n) {
const ratio = Number(swap.amountIn) / Number(relevantReserve);
if (ratio < this.config.minTradeToPoolLiquidityRatio) {
return { pass: false, reason: 'TRADE_TOO_SMALL' };
}
}
}

return { pass: true };
}
}
