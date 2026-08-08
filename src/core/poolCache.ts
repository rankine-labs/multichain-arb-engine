import { PoolState, ChainName } from './types';

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
                                                                                                                                                    
                                                                                                                                                          const feeMultiplier = BigInt(10_000 - pool.feeBps);
                                                                                                                                                                const amountInWithFee = (amountIn * feeMultiplier) / 10_000n;
                                                                                                                                                                
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
                                                                                                                                                                                                                                                                              
                                                                                                                                                                                                                                                                                    const feeMultiplier = BigInt(10_000 - pool.feeBps);
                                                                                                                                                                                                                                                                                          const amountInWithFee = (amountIn * feeMultiplier) / 10_000n;
                                                                                                                                                                                                                                                                                          
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
