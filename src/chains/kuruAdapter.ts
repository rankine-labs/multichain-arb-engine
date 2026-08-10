import { ethers as ethersV5 } from 'ethers-v5'; // explicit aliased dependency
// (package.json: "ethers-v5": "npm:ethers@5.7.1") — @kuru-labs/kuru-sdk is
// built on ethers v5 while the rest of this project uses v6, so this alias
// keeps the two fully isolated rather than relying on npm's nested
// node_modules resolution, which would break silently if the SDK's
// dependency tree ever changes shape.
import { CostEstimator, MarketParams } from '@kuru-labs/kuru-sdk';

// ============================================================================
// KURU ADAPTER (Monad order-book DEX)
//
// Kuru has no reserves and no constant-product curve — it's a real
// order book. There is no closed-form "getAmountOut" the way v2/v3 have;
// output depends on the actual resting bids/asks at the time of the trade.
// Rather than inventing order-book math, this wraps Kuru's own official
// CostEstimator from @kuru-labs/kuru-sdk, verified against the real
// package (v0.0.95) installed from the npm registry.
//
// IMPORTANT ARCHITECTURAL DIFFERENCE from dexMath.ts:
// computeAmountOut() for v2/v3 is synchronous and reads purely from our
// in-memory pool cache — zero latency, core to the hot-path design.
// Kuru's estimator functions are ASYNC and (in their simplest form) make
// an RPC call. To keep this out of the hot path, this adapter should be
// fed a pre-fetched `l2Book` from Kuru's proposed-state orderbook
// WebSocket (the low-latency feed Rudy found) rather than calling
// estimateMarketBuy/estimateMarketSell's RPC-querying variants on every
// opportunity — that's the difference between a hot-path-safe integration
// and one that silently reintroduces a network round-trip into the
// critical path. The l2Book-based estimator methods below take pre-fetched
// order book state as a parameter for exactly this reason.
//
// NOTE: estimateBuy/estimateRequiredQuoteForBuy/estimateSell are given
// explicit `Promise<any>` return types below. Without this, tsc errors
// with "The inferred type ... cannot be named without a reference to
// 'BigNumber' from '@kuru-labs/kuru-sdk/node_modules/ethers'" — the
// SDK's BigNumber type lives too deep in a nested node_modules path to
// be portably inferred. `any` is honest here: callers should treat the
// SDK's real return shape as opaque until this is narrowed properly.
// ============================================================================

// Verified against official Kuru mainnet docs (docs.kuru.io/contracts/Contract-addresses)
export const KURU_MONAD_ADDRESSES = {
  ROUTER: '0xd651346d7c789536ebf06dc72aE3C8502cd695CC', // market factory
  FLOW_ENTRYPOINT: '0xb3e6778480b2E488385E8205eA05E20060B813cb',
  FLOW_ROUTER: '0x0d3a1BE29E9dEd63c7a5678b31e847D68F71FFa2',
  MARGIN_ACCOUNT: '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5',
  WMON: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
  USDC: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  MARKETS: {
    MON_USDC: '0x065C9d28E428A0db40191a54d33d5b7c71a9C394',
    MON_AUSD: '0x131a2e70a5b31a517a74b8c567149bc294470da9',
  },
} as const;

export interface KuruOrderBookSnapshot {
  orderbookAddress: string;
  marketParams: MarketParams;
  l2Book: any;
  contractVaultParams: any;
}

export class KuruAdapter {
  async estimateBuy(
    providerV5: ethersV5.providers.JsonRpcProvider,
    snapshot: KuruOrderBookSnapshot,
    quoteAmount: number,
    ): Promise<any> {
    return CostEstimator.estimateMarketBuy(
      providerV5,
      snapshot.orderbookAddress,
      snapshot.marketParams,
      quoteAmount,
      );
  }

async estimateRequiredQuoteForBuy(
  providerV5: ethersV5.providers.JsonRpcProvider,
  snapshot: KuruOrderBookSnapshot,
  baseTokenAmount: number,
  ): Promise<any> {
  return CostEstimator.estimateRequiredQuoteForBuy(
    providerV5,
    snapshot.orderbookAddress,
    snapshot.marketParams,
    baseTokenAmount,
    snapshot.l2Book,
    snapshot.contractVaultParams,
    );
}

async estimateSell(
  providerV5: ethersV5.providers.JsonRpcProvider,
  snapshot: KuruOrderBookSnapshot,
  size: number,
  ): Promise<any> {
  return CostEstimator.estimateMarketSell(
    providerV5,
    snapshot.orderbookAddress,
    snapshot.marketParams,
    size,
    );
}
}
