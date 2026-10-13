// ============================================================================
// TRUST FRESH (SPEED_TRUST_WS): skip the decision-time RPC price re-read when
// the WebSocket block reader PROVES our cached copy is current.
//
// Plain English:
//   Before deciding on a trade, the bot makes sure the pool prices it uses
//   are fresh. Today's rule (unchanged): a cached price updated in the last
//   FRESH_MS (35 s) is used as is; anything older is re-read over RPC
//   (~20-80 ms, sometimes up to the 1.5 s timeout) while the trade waits.
//
//   The WebSocket block reader (core/blockReaderWs.ts) pushes every price
//   event of our pools, every block. If it has been working WITHOUT A BREAK
//   since a pool's last update, then "no event" really means "no change", and
//   the cached copy is still right even if it is older than 35 s. This file
//   decides when that is safe enough to skip the re-read. ALL must hold:
//
//     1. switch on (SPEED_TRUST_WS, default on) and the WebSocket reader exists
//     2. WebSocket healthy right now, AND healthy without a break since
//        (pool's last update - LAG margin). Any drop / reconnect / renewal in
//        between = not trusted (we may have missed an event in that window).
//     3. the pool is in the live subscription (new pools join at the next renewal)
//     4. real event data arrived on that subscription in the last
//        SPEED_TRUST_WS_DATA_MS (3 s): proves the subscription is really
//        delivering, not just answering keep-alive pings
//     5. the cached copy is EXACT chain state, not a prediction from the
//        trade feed (a prediction is only trusted by today's 35 s rule)
//     6. no block-reader write landed just before an RPC write (a lagging
//        read node could have put an older price back over it)
//     7. not older than SPEED_TRUST_WS_MAX_AGE_MS (120 s)
//     8. pool kind: V2-style pools (Uniswap V2, PancakeSwap V2, Ramses V2)
//        only, by default. Their Sync event fires on EVERY reserve change,
//        including liquidity adds/removes. V3/V4 pools change liquidity with
//        Mint/Burn events the readers do NOT follow, so an old V3 copy could
//        have the right price but the wrong depth. SPEED_TRUST_WS_V3=1 would
//        include them (not recommended).
//
//   Anything that fails a test falls back to today's rule, unchanged. So this
//   switch can only remove RPC re-reads, never add one, and never touches a
//   pool the WebSocket isn't watching.
//
// Why not "updated in the last 2-3 s"? Every pool that fresh is already used
// from the cache by today's 35 s rule, so a 2-3 s window would change
// nothing. The re-reads that DO happen are for pools older than 35 s, which
// is exactly what the continuity checks above make safe. The 3 s number is
// used where it matters: test 4 (the subscription must have delivered data
// in the last 3 s, ~100 blocks at ~30 ms per block).
// ============================================================================

import { PoolState } from './types';

export interface TrustFreshConfig {
  enabled: boolean;
  maxAgeMs: number;      // oldest cached copy the WebSocket can vouch for
  dataMs: number;        // the subscription must have delivered data this recently
  lagMarginMs: number;   // safety margin for read-node lag / push delay
  includeV3: boolean;    // also trust V3/V4 pools (liquidity changes not followed)
}

export function trustFreshConfigFromEnv(env: Record<string, string | undefined> = process.env): TrustFreshConfig {
  const num = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    enabled: env.SPEED_TRUST_WS !== '0' && env.SPEED_TRUST_WS !== 'off',
    maxAgeMs: num(env.SPEED_TRUST_WS_MAX_AGE_MS, 120_000),
    dataMs: num(env.SPEED_TRUST_WS_DATA_MS, 3_000),
    lagMarginMs: num(env.SPEED_TRUST_WS_LAG_MS, 2_000),
    includeV3: env.SPEED_TRUST_WS_V3 === '1',
  };
}

// What the check needs from the WebSocket reader (WsBlockReader has these).
export interface WsFacts {
  healthy(): boolean;
  healthySinceMs(): number | null;
  coversPool(addr: string): boolean;
  lastDataAtMs(kind: 'pools' | 'v4'): number;
}
// What it needs from the pool cache (PoolCache has these).
export interface CacheFacts {
  blockAppliedAt(chain: PoolState['chain'], addr: string): number;
  feedAppliedAt(chain: PoolState['chain'], addr: string): number;
}

// V2-style = reserves pool (Sync event on every change). Hooked/V4 and
// order books are never V2-style.
const isV2Style = (p: PoolState) => p.poolType === 'v2' && !p.v4;

// The decision. Returns null when trusted, or the first reason it isn't
// (handy for tests and for logging).
export function wsTrustProblem(p: PoolState, ws: WsFacts | null, cache: CacheFacts, cfg: TrustFreshConfig, now = Date.now()): string | null {
  if (!cfg.enabled) return 'switch off';
  if (!ws) return 'no WebSocket reader';
  if (!isV2Style(p) && !(cfg.includeV3 && p.poolType === 'v3')) return 'pool kind not covered (V3/V4 liquidity changes not followed)';
  if (!ws.healthy()) return 'WebSocket not healthy';
  const since = ws.healthySinceMs();
  if (since === null) return 'WebSocket not healthy';
  const stateMs = p.lastUpdatedMs;
  if (!(stateMs > 0)) return 'pool never refreshed';
  if (since > stateMs - cfg.lagMarginMs) return 'WebSocket had a break since this pool was last updated';
  if (now - stateMs > cfg.maxAgeMs) return 'older than the WebSocket trust limit';
  if (!ws.coversPool(p.poolAddress)) return 'pool not in the live subscription';
  const kind = p.poolAddress.length === 66 ? 'v4' : 'pools';
  if (now - ws.lastDataAtMs(kind) > cfg.dataMs) return 'no recent WebSocket data';
  const fedAt = cache.feedAppliedAt(p.chain, p.poolAddress);
  if (fedAt && fedAt >= stateMs) return 'cached copy is a trade-feed prediction';
  const blockAt = cache.blockAppliedAt(p.chain, p.poolAddress);
  if (blockAt && blockAt < stateMs && stateMs - blockAt < cfg.lagMarginMs) return 'RPC write right after a block write (possible lagging node)';
  return null;
}
