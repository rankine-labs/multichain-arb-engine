import { PoolState, ChainName } from './types';
import { PoolCache } from './poolCache';

// ============================================================================
// POOL DISCOVERY + AUTO-APPROVAL GATES
//
// The bot finds pools on its own. It does NOT trade them just because it
// found them. Every discovered pool has to clear these gates automatically:
//
//   1. Liquidity floor        — thin pools get destroyed by our own trade
//   2. Cross-DEX presence     — no second venue, no arbitrage, ignore it
//   3. Approved exchange only — only DEXs we've vetted a pricing adapter for
//   4. Recent volume          — dead pools don't generate the trigger trades
//   5. (live-trading only)    — automated contract safety check: simulate a
//                                buy + sell, reject taxed/blacklist/honeypot
//                                tokens before real money ever touches them
//
// Gates 1-4 run for shadow-mode monitoring. Gate 5 is a separate, stricter
// gate that must ALSO pass before a pair is eligible for live execution.
// ============================================================================

export interface DiscoveryConfig {
chain: ChainName;
minLiquidityUsd: number;
minRecent24hVolumeUsd: number;
approvedDexes: Set<string>;
}

export interface DiscoveredPoolCandidate {
chain: ChainName;
dex: string;
poolAddress: string;
tokenA: string;
tokenB: string;
estimatedLiquidityUsd: number;
recent24hVolumeUsd: number;
}

export type RejectionReason =
| 'DEX_NOT_APPROVED'
| 'LIQUIDITY_TOO_LOW'
| 'VOLUME_TOO_LOW'
| 'NO_PEER_VENUE'
| 'FAILED_TOKEN_SAFETY_CHECK';

export interface GateResult {
approved: boolean;
approvedForLiveTrading: boolean;
rejections: RejectionReason[];
}

export class PoolDiscoveryEngine {
constructor(
private config: DiscoveryConfig,
private cache: PoolCache,
) {}

// Gates 1-4, run automatically the moment a pool is discovered.
evaluateForMonitoring(candidate: DiscoveredPoolCandidate): GateResult {
const rejections: RejectionReason[] = [];

if (!this.config.approvedDexes.has(candidate.dex)) {
rejections.push('DEX_NOT_APPROVED');
}
if (candidate.estimatedLiquidityUsd < this.config.minLiquidityUsd) {
rejections.push('LIQUIDITY_TOO_LOW');
}
if (candidate.recent24hVolumeUsd < this.config.minRecent24hVolumeUsd) {
rejections.push('VOLUME_TOO_LOW');
}

// Cross-DEX check: is this token pair already cached on another
// approved DEX on the same chain? If not, no arbitrage is possible,
// so there's no point monitoring it yet — it goes on a watchlist
// instead, and gets re-checked whenever a NEW pool is discovered.
const peers = this.cache.findPeerPools(
candidate.chain,
candidate.tokenA,
candidate.tokenB,
candidate.poolAddress,
);
if (peers.length === 0) {
rejections.push('NO_PEER_VENUE');
}

return {
approved: rejections.length === 0,
approvedForLiveTrading: false, // live trading always needs gate 5 too
rejections,
};
}

// Gate 5. Separate and stricter — only runs before a pair is allowed to
// touch real capital. Simulates a small buy then a small sell against the
// token contract (via local eth_call / fork simulation) and rejects on:
//   - sell returns meaningfully less than expected (transfer tax)
//   - sell reverts entirely (blacklist / honeypot)
//   - contract exposes an owner-controlled pause/freeze function
//
// The actual simulate() call is chain-specific (needs a provider), so this
// takes a pre-computed result rather than a provider directly — keeps this
// module chain-agnostic and testable.
evaluateForLiveTrading(
monitoringResult: GateResult,
tokenSafetyCheck: { passed: boolean; reason?: string },
): GateResult {
if (!monitoringResult.approved) {
return { ...monitoringResult, approvedForLiveTrading: false };
}
const rejections = [...monitoringResult.rejections];
if (!tokenSafetyCheck.passed) {
rejections.push('FAILED_TOKEN_SAFETY_CHECK');
}
return {
approved: monitoringResult.approved,
approvedForLiveTrading: rejections.length === 0,
rejections,
};
}

registerApprovedPool(candidate: DiscoveredPoolCandidate, poolType: PoolState['poolType'], feeBps: number) {
this.cache.upsert({
chain: candidate.chain,
dex: candidate.dex,
poolAddress: candidate.poolAddress,
poolType,
tokenA: candidate.tokenA,
tokenB: candidate.tokenB,
feeBps,
lastUpdatedBlock: 0,
lastUpdatedMs: Date.now(),
});
}

    // Real-time gate for pools discovered from live swap traffic (JIT
    // resolution in shadowMain.ts). This is DELIBERATELY NOT the full
    // evaluateForMonitoring() above: that method also requires
    // recent24hVolumeUsd, which needs historical event-log scanning that
    // isn't built yet. Rather than fake a volume number (which would either
    // reject everything or approve everything depending on the placeholder
    // chosen), this checks only what we can honestly verify right now:
    //   - is this DEX one we've actually approved for this chain?
    //   - does the pool have real, non-zero liquidity on both sides?
    // A pool passing this is safe to track and price, not yet proven to
    // have real trading volume. Volume-based rejection remains future work.
    evaluateLiveDiscovery(candidate: {
        chain: ChainName;
        dex: string;
        hasNonZeroLiquidity: boolean;
    }): { approved: boolean; rejections: RejectionReason[] } {
        const rejections: RejectionReason[] = [];

        if (!this.config.approvedDexes.has(candidate.dex)) {
            rejections.push('DEX_NOT_APPROVED');
        }
        if (!candidate.hasNonZeroLiquidity) {
            rejections.push('LIQUIDITY_TOO_LOW');
        }

        return { approved: rejections.length === 0, rejections };
    }
}
