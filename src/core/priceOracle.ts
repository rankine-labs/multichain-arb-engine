import { ChainName, PoolState } from './types';
import { PoolCache } from './poolCache';

// ============================================================================
// PRICE ORACLE
//
// Every profit calculation and the liquidity ceiling both need a real USD
// price per token. Rather than depending on an external price API (one more
// network call in or near the hot path), we derive price directly from the
// pool cache we already maintain in memory — the same data we're using to
// find arbitrage in the first place.
//
// Method: find a pool pairing the target token directly against a known
// stablecoin. If none exists, hop through one intermediate token (e.g.
// TOKEN/WETH, then WETH/USDC) to get there. No external calls, no added
// latency in the hot path.
// ============================================================================

// Known stablecoins per chain — treated as $1.00 by definition.
// Populate via registerStablecoin() with real addresses per chain before
// this goes live (kept out of source as a hardcoded list so addresses can
// be supplied via config/env rather than requiring a code change).
const STABLECOINS: Record<ChainName, Set<string>> = {
avalanche: new Set(),
monad: new Set(),
robinhood: new Set(),
};

export function registerStablecoin(chain: ChainName, tokenAddress: string) {
STABLECOINS[chain].add(tokenAddress.toLowerCase());
}

export class PriceOracle {
constructor(private cache: PoolCache) {}

isStable(chain: ChainName, tokenAddress: string): boolean {
return STABLECOINS[chain].has(tokenAddress.toLowerCase());
}

// Returns USD price per 1 whole token (18-decimals assumed for now —
// real implementation needs per-token decimals, not a flat assumption).
getUsdPrice(chain: ChainName, tokenAddress: string): number | null {
if (this.isStable(chain, tokenAddress)) return 1.0;

// Direct pass: any cached pool pairing this token against a stablecoin
const direct = this.findDirectStablePool(chain, tokenAddress);
if (direct) return direct;

// One-hop pass: token -> intermediate -> stablecoin
const hopped = this.findOneHopStablePrice(chain, tokenAddress);
if (hopped) return hopped;

return null; // no path to a known price — caller must skip this token
}

private findDirectStablePool(chain: ChainName, tokenAddress: string): number | null {
for (const pool of this.cache.allForChain(chain)) {
if (pool.poolType !== 'v2' || pool.reserveA === undefined || pool.reserveB === undefined) continue;

const isTokenA = pool.tokenA.toLowerCase() === tokenAddress.toLowerCase();
const isTokenB = pool.tokenB.toLowerCase() === tokenAddress.toLowerCase();
if (!isTokenA && !isTokenB) continue;

const otherToken = isTokenA ? pool.tokenB : pool.tokenA;
if (!this.isStable(chain, otherToken)) continue;

const tokenReserve = isTokenA ? pool.reserveA : pool.reserveB;
const stableReserve = isTokenA ? pool.reserveB : pool.reserveA;
if (tokenReserve === 0n) continue;

// price = stable reserve / token reserve (both assumed 18 decimals)
return Number(stableReserve) / Number(tokenReserve);
}
return null;
}

private findOneHopStablePrice(chain: ChainName, tokenAddress: string): number | null {
for (const pool of this.cache.allForChain(chain)) {
if (pool.poolType !== 'v2' || pool.reserveA === undefined || pool.reserveB === undefined) continue;

const isTokenA = pool.tokenA.toLowerCase() === tokenAddress.toLowerCase();
const isTokenB = pool.tokenB.toLowerCase() === tokenAddress.toLowerCase();
if (!isTokenA && !isTokenB) continue;

const intermediate = isTokenA ? pool.tokenB : pool.tokenA;
if (this.isStable(chain, intermediate)) continue; // that's the direct case, already handled

const intermediatePrice = this.findDirectStablePool(chain, intermediate);
if (intermediatePrice === null) continue;

const tokenReserve = isTokenA ? pool.reserveA : pool.reserveB;
const intermediateReserve = isTokenA ? pool.reserveB : pool.reserveA;
if (tokenReserve === 0n) continue;

const tokenPerIntermediate = Number(intermediateReserve) / Number(tokenReserve);
return tokenPerIntermediate * intermediatePrice;
}
return null;
}
}
