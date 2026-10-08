import { PoolState, ChainName } from './types';
import { amountInAfterFee } from './dexMath';

// ============================================================================
// POOL CACHE
// Biggest speed advantage in the whole system. A normal bot re-asks the
// blockchain "what's the reserve, what's the tick" every time it needs to
// calculate something. That costs milliseconds we don't have.
// We keep every approved pool's state in RAM and update it as events arrive.
// ============================================================================

export class PoolCache {
  private pools = new Map<string, PoolState>(); // key: `${chain}:${poolAddress}`

    private key(chain: ChainName, poolAddress: string) {
        return `${chain}:${poolAddress.toLowerCase()}`;
          }

            upsert(pool: PoolState) {
                this.pools.set(this.key(pool.chain, pool.poolAddress), pool);
                  }

  // RPC refresh write: skip it if the cached copy changed AFTER the read
  // started (the trade feed applied a newer swap while the RPC call was in
  // flight; the RPC answer may predate that swap and would put the old price
  // back, creating a fake gap). A pool skipped 3 times in a row is written
  // anyway so drift on a very busy pool still gets corrected.
  // Returns true if written.
  // Also skipped within FEED_GRACE_MS of a swap applied from the trade feed:
  // the feed sees a trade before the RPC node has it in a block, so an RPC
  // read started just after still returns the pre-trade price.
  private skips = new Map<string, number>();
  private feedApplied = new Map<string, number>();
  static FEED_GRACE_MS = Number(process.env.FEED_GRACE_MS ?? 2_000);

  // Write a state predicted from a sequenced trade (instant price tracking).
  upsertFromFeed(pool: PoolState, now = Date.now()) {
    const k = this.key(pool.chain, pool.poolAddress);
    this.pools.set(k, { ...pool, lastUpdatedMs: now });
    this.feedApplied.set(k, now);
  }

  upsertIfNotNewer(fresh: PoolState, readStartedMs: number, now = Date.now()): boolean {
    const k = this.key(fresh.chain, fresh.poolAddress);
    const cur = this.pools.get(k);
    const fedAt = this.feedApplied.get(k) ?? 0;
    if (cur && (cur.lastUpdatedMs > readStartedMs || now - fedAt < PoolCache.FEED_GRACE_MS)) {
      const n = (this.skips.get(k) ?? 0) + 1;
      if (n < 3) { this.skips.set(k, n); return false; }
    }
    this.skips.delete(k);
    this.feedApplied.delete(k);
    this.pools.set(k, fresh);
    return true;
  }

                    get(chain: ChainName, poolAddress: string): PoolState | undefined {
                        return this.pools.get(this.key(chain, poolAddress));
                          }

                            // Find every OTHER pool trading the same token pair on the same chain.
                              // This is the core of "is there a second venue to arb against".
                                findPeerPools(chain: ChainName, tokenA: string, tokenB: string, excludePool: string): PoolState[] {
                                    const a = tokenA.toLowerCase();
                                        const b = tokenB.toLowerCase();
                                            const results: PoolState[] = [];
                                                for (const pool of this.pools.values()) {
                                                      if (pool.chain !== chain) continue;
                                                            if (pool.poolAddress.toLowerCase() === excludePool.toLowerCase()) continue;
                                                                  const pa = pool.tokenA.toLowerCase();
                                                                        const pb = pool.tokenB.toLowerCase();
                                                                              const matches = (pa === a && pb === b) || (pa === b && pb === a);
                                                                                    if (matches) results.push(pool);
                                                                                        }
                                                                                            return results;
                                                                                              }

  // Memory: drop pools nobody needs any more (not kept by the caller, e.g.
  // not in a watched pair, and not updated for maxAgeMs). Without this the
  // cache only ever grew: every pool seen in any trade stayed forever and
  // every peer lookup scanned all of them. Returns how many were removed.
  prune(keep: (p: PoolState) => boolean, maxAgeMs: number, now = Date.now()): number {
    let n = 0;
    for (const [k, p] of this.pools) {
      if (keep(p) || now - p.lastUpdatedMs < maxAgeMs) continue;
      this.pools.delete(k);
      this.skips.delete(k);
      this.feedApplied.delete(k);
      n++;
    }
    return n;
  }


                                                                                                allForChain(chain: ChainName): PoolState[] {
                                                                                                    return [...this.pools.values()].filter(p => p.chain === chain);
                                                                                                      }
                                                                                                      
                                                                                                        size(): number {
                                                                                                            return this.pools.size;
                                                                                                              }
                                                                                                              
                                                                                                                // Applies a predicted post-trade reserve change WITHOUT touching the real
                                                                                                                  // cached state — used by the future-state simulator to answer
                                                                                                                    // "if this pending trade lands, what would the price look like?"
                                                                                                                      //
                                                                                                                        // v2 pools: exact constant-product math.
                                                                                                                          // v3 pools: approximated using "virtual reserves" derived from the
                                                                                                                            // current sqrtPriceX96 and active liquidity (x = L/sqrtP, y = L*sqrtP).
                                                                                                                              // This is exact for trades that stay within the current tick's liquidity
                                                                                                                                // range, and is the standard simplification used for fast estimation —
                                                                                                                                  // it will UNDERSTATE price impact for trades large enough to cross into
                                                                                                                                    // a neighboring tick range with different liquidity. Good enough for
                                                                                                                                      // shadow-mode sizing; real execution should re-verify with a proper
                                                                                                                                        // quoter call (e.g. QuoterV2) immediately before firing.
                                                                                                                                          predictPostTradeState(pool: PoolState, tokenInIsA: boolean, amountIn: bigint): PoolState {
                                                                                                                                              if (pool.poolType === 'v2') {
                                                                                                                                                    if (pool.reserveA === undefined || pool.reserveB === undefined) return pool;
                                                                                                                                                    
                                                                                                                                                          // Same fee maths as the sizing code (dexMath.ts), so prediction and sizing agree.
                                                                                                                                                                const amountInWithFee = amountInAfterFee(pool, amountIn);
                                                                                                                                                                
                                                                                                                                                                      if (tokenInIsA) {
                                                                                                                                                                              const newReserveA = pool.reserveA + amountIn;
                                                                                                                                                                                      const newReserveB = (pool.reserveA * pool.reserveB) / (pool.reserveA + amountInWithFee);
                                                                                                                                                                                              return { ...pool, reserveA: newReserveA, reserveB: newReserveB };
                                                                                                                                                                                                    } else {
                                                                                                                                                                                                            const newReserveB = pool.reserveB + amountIn;
                                                                                                                                                                                                                    const newReserveA = (pool.reserveA * pool.reserveB) / (pool.reserveB + amountInWithFee);
                                                                                                                                                                                                                            return { ...pool, reserveA: newReserveA, reserveB: newReserveB };
                                                                                                                                                                                                                                  }
                                                                                                                                                                                                                                      }
                                                                                                                                                                                                                                      
                                                                                                                                                                                                                                          if (pool.poolType === 'v3') {
                                                                                                                                                                                                                                                if (pool.sqrtPriceX96 === undefined || pool.liquidity === undefined) return pool;
                                                                                                                                                                                                                                                
                                                                                                                                                                                                                                                      const Q96 = 1n << 96n;
                                                                                                                                                                                                                                                            // Virtual reserves at the current price, within the active tick's
                                                                                                                                                                                                                                                                  // liquidity: x (tokenA-equivalent) = L * Q96 / sqrtP, y (tokenB) = L * sqrtP / Q96
                                                                                                                                                                                                                                                                        const virtualX = (pool.liquidity * Q96) / pool.sqrtPriceX96;
                                                                                                                                                                                                                                                                              const virtualY = (pool.liquidity * pool.sqrtPriceX96) / Q96;
                                                                                                                                                                                                                                                                              
                                                                                                                                                                                                                                                                                    // Same fee maths as the sizing code (dexMath.ts), so prediction and sizing agree.
                                                                                                                                                                                                                                                                                          const amountInWithFee = amountInAfterFee(pool, amountIn);
                                                                                                                                                                                                                                                                                          
                                                                                                                                                                                                                                                                                                // Same constant-product relationship (virtualX * virtualY = k) applied
                                                                                                                                                                                                                                                                                                      // to the virtual reserves, then converted back into a new sqrtPriceX96.
                                                                                                                                                                                                                                                                                                            let newVirtualX: bigint;
                                                                                                                                                                                                                                                                                                                  let newVirtualY: bigint;
                                                                                                                                                                                                                                                                                                                  
                                                                                                                                                                                                                                                                                                                        if (tokenInIsA) {
                                                                                                                                                                                                                                                                                                                                newVirtualX = virtualX + amountInWithFee;
                                                                                                                                                                                                                                                                                                                                        newVirtualY = (virtualX * virtualY) / newVirtualX;
                                                                                                                                                                                                                                                                                                                                              } else {
                                                                                                                                                                                                                                                                                                                                                      newVirtualY = virtualY + amountInWithFee;
                                                                                                                                                                                                                                                                                                                                                              newVirtualX = (virtualX * virtualY) / newVirtualY;
                                                                                                                                                                                                                                                                                                                                                                    }
                                                                                                                                                                                                                                                                                                                                                                    
                                                                                                                                                                                                                                                                                                                                                                          if (newVirtualX === 0n) return pool; // guard against div-by-zero on extreme input
                                                                                                                                                                                                                                                                                                                                                                          
                                                                                                                                                                                                                                                                                                                                                                                // sqrtP = sqrt(y/x) — reconstruct via the identity newSqrtP = L*Q96/newVirtualX
                                                                                                                                                                                                                                                                                                                                                                                      const newSqrtPriceX96 = (pool.liquidity * Q96) / newVirtualX;
                                                                                                                                                                                                                                                                                                                                                                                      
                                                                                                                                                                                                                                                                                                                                                                                            return { ...pool, sqrtPriceX96: newSqrtPriceX96 };
                                                                                                                                                                                                                                                                                                                                                                                                }
                                                                                                                                                                                                                                                                                                                                                                                                
                                                                                                                                                                                                                                                                                                                                                                                                    // orderbook / stable pool math not implemented yet — return unchanged
                                                                                                                                                                                                                                                                                                                                                                                                        // so callers can detect "no prediction available" via unchanged state.
                                                                                                                                                                                                                                                                                                                                                                                                            return pool;
                                                                                                                                                                                                                                                                                                                                                                                                              }
                                                                                                                                                                                                                                                                                                                                                                                                              }
