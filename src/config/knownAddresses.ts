import { RouterRegistry } from '../core/decoder';
import { registerStablecoin } from '../core/priceOracle';

  // ============================================================================
  // KNOWN ADDRESSES
  //
  // Real, independently verified addresses go here. Anything not yet
  // verified stays commented out with a note — an unverified address is
  // worse than a missing one, since a wrong router address would silently
  // decode garbage instead of failing loudly.
  // ============================================================================

  // --- Avalanche — verified via LFJ official docs + Snowtrace + Circle docs ---
  export const AVALANCHE_TOKENS = {
  WAVAX: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
    USDC_NATIVE: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // Circle-issued native USDC
    };

export const AVALANCHE_ROUTERS = {
TRADERJOE_V1_ROUTER: '0x60aE616a2155Ee3d9A68541Ba4544862310933d4',
    TRADERJOE_V1_FACTORY: '0x9Ad6C38BE94206cA50bb0d90783181662f0Cfa10', // verified via LFJ official docs
    SUSHISWAP_ROUTER: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', // verified via Snowtrace (real Create Pair history)
    SUSHISWAP_FACTORY: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4', // same address SushiSwap uses on most chains, confirmed on Snowtrace directly
    TRADERJOE_LB_ROUTER: '0x18556DA13313f3532c54711497A8FedAC273220E', // verified via official LFJ docs (V2.2)
    TRADERJOE_LB_FACTORY: '0xb43120c4745967fa9b93E79C149E66B0f2D6Fe0c', // verified via official LFJ docs (V2.2)
};

// --- Monad — verified via official Uniswap deployment docs
// (developers.uniswap.org/docs/protocols/v3/deployments/v3-monad-deployments)
// and official Kuru docs (docs.kuru.io/contracts/Contract-addresses) ---
export const MONAD_TOKENS = {
WMON: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
USDC: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
};

export const MONAD_ROUTERS = {
  UNISWAP_V3_FACTORY: '0x204FAca1764B154221e35c0d20aBb3c525710498',
SWAP_ROUTER_02: '0xfe31F71c1B106EAC32F1a19239c9A9a72ddFB900',
QUOTER_V2: '0x661E93cCa42AfaCB172121EF892830ca3B70F08D',
UNIVERSAL_ROUTER: '0x0D97dc33264BFC1c226207428A79b26757Fb9dc3',
PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
};

// --- Monad: Kuru (order book DEX) — addresses confirmed independently
// against kuruAdapter.ts's existing constants (built from official Kuru
// docs) ---
export const MONAD_KURU = {
  ROUTER: '0xd651346d7c789536ebf06dc72aE3C8502cd695CC', // Router / Market Factory
  FLOW_ENTRYPOINT: '0xb3e6778480b2E488385E8205eA05E20060B813cb',
  FLOW_ROUTER: '0x0d3a1BE29E9dEd63c7a5678b31e847D68F71FFa2',
  MARGIN_ACCOUNT: '0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5',
  MARKETS: {
    MON_USDC: '0x065C9d28E428A0db40191a54d33d5b7c71a9C394',
  },
};

export const MONAD_V4_PENDING = {
POOL_MANAGER: '0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e',
QUOTER: '0xA222dD357a9076D1091ED6aa2e16C9742Dd26891',
STATE_VIEW: '0x77395F3B2E73aE90843717371294fa97CC419d64',
UNIVERSAL_ROUTER: '0x0D97dc33264BFC1c226207428A79b26757Fb9dc3',
};

  // --- Monad: Bean Exchange (DLMM -- same bin-based liquidity model as
  // TraderJoe LB) -- addresses verified via live bytecode check, factory
  // confirmed to return real pool data using the same getAllLBPairs()
  // interface our existing LB resolver already calls ---
  export const MONAD_BEAN = {
          DLMM_FACTORY: '0x8Bb9727Ca742C146563DCcBAfb9308A234e1d242',
          DLMM_ROUTER: '0x721aC9E688E6b86F48b08DB2ba2D4B7bBBd12665',
  };

// Verified via live bytecode check against the real Robinhood Chain
// mainnet RPC (https://rpc.mainnet.chain.robinhood.com, chain ID 4663) —
// every address below has confirmed on-chain bytecode, not just
// documentation. No longer PENDING_VERIFICATION.
export const ROBINHOOD_V4 = {
  POOL_MANAGER: '0x8366A39CC670b4001A1121B8f6a443A643E40951',
  QUOTER: '0x8Dc178eFB8111Bb0973dd9D722Ebeff267C98F94',
    STATE_VIEW: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
  UNIVERSAL_ROUTER: '0x8876789976deCBFcBBBE364623c63652DB8C0904',
};

export const ROBINHOOD_V3 = {
  FACTORY: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
  SWAP_ROUTER_02: '0xCaf681a66D020601342297493863E78C959E5cb2',
  QUOTER_V2: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
};

// v2-style factory/router — resolveAndFetchV2Pool (poolResolver.ts) works
// with this directly, same pattern as TraderJoe/SushiSwap on Avalanche.
export const ROBINHOOD_V2 = {
FACTORY: '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937F',
    ROUTER: '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba',
};

// --- Robinhood Chain — token addresses verified across three independent
// sources: 1inch help docs, Blockscout explorer (direct on-chain lookup),
// and Kansoku Labs docs. ---
export const ROBINHOOD_TOKENS = {
WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
NATIVE_ETH_SENTINEL: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
};

export function seedKnownAddresses(registry: RouterRegistry) {
registry.avalanche[AVALANCHE_ROUTERS.TRADERJOE_V1_ROUTER.toLowerCase()] = {
dex: 'traderjoe-v1',
style: 'v2',
    factory: AVALANCHE_ROUTERS.TRADERJOE_V1_FACTORY,
};
registerStablecoin('avalanche', AVALANCHE_TOKENS.USDC_NATIVE);

    registry.avalanche[AVALANCHE_ROUTERS.SUSHISWAP_ROUTER.toLowerCase()] = {
        dex: 'sushiswap',
        style: 'v2',
        factory: AVALANCHE_ROUTERS.SUSHISWAP_FACTORY,
    };

    registry.avalanche[AVALANCHE_ROUTERS.TRADERJOE_LB_ROUTER.toLowerCase()] = {
        dex: 'traderjoe-lb',
        style: 'lb',
        factory: AVALANCHE_ROUTERS.TRADERJOE_LB_FACTORY,
    };

registry.monad[MONAD_ROUTERS.SWAP_ROUTER_02.toLowerCase()] = {
dex: 'uniswap-v3',
    factory: MONAD_ROUTERS.UNISWAP_V3_FACTORY,
style: 'v3',
};

    registry.monad[MONAD_BEAN.DLMM_ROUTER.toLowerCase()] = {
        dex: 'bean-exchange',
        style: 'lb',
        factory: MONAD_BEAN.DLMM_FACTORY,
    };

    registry.robinhood[ROBINHOOD_V2.ROUTER.toLowerCase()] = {
        dex: 'uniswap-v2',
        style: 'v2',
        factory: ROBINHOOD_V2.FACTORY,
    };

    registry.robinhood[ROBINHOOD_V3.SWAP_ROUTER_02.toLowerCase()] = {
        dex: 'uniswap-v3',
        style: 'v3',
        factory: ROBINHOOD_V3.FACTORY,
    };
registerStablecoin('monad', MONAD_TOKENS.USDC);

registerStablecoin('robinhood', ROBINHOOD_TOKENS.USDG);
}
