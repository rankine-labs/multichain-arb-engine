// ============================================================================
// CORE TYPES — shared vocabulary between the Chain Manager, chain adapters,
// and the core engine (decoder, filter, pool cache, profit calculator).
// ============================================================================

export type ChainName = 'avalanche' | 'monad' | 'robinhood';

// What kind of state a piece of data represents. This matters a lot —
// SPECULATIVE data (Monad) or SEQUENCED-BUT-NOT-EXECUTED data (Robinhood)
// must never be treated the same as FINALIZED data.
export type StateType = 'PENDING' | 'SPECULATIVE' | 'SEQUENCED' | 'FINALIZED';

export interface RawChainEvent {
    chain: ChainName;
  stateType: StateType;
  blockOrSeq: number | string;   // block number, or Robinhood sequence number
  receivedAtMs: number;          // Date.now() when WE received it, for latency tracking
  raw: unknown;                  // untouched payload from the provider
}

export interface DecodedSwap {
    chain: ChainName;
  dex: string;
  poolAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  // undefined until we predict it — Robinhood's feed never includes a result
  amountOutObserved?: bigint;
  // V3 fee tier from the calldata (e.g. 500 = 0.05%), when known. Lets the
  // bot find the exact pool the trade used, not just any tier of the pair.
  feeTier?: number;
  stateType: StateType;
  detectedAtMs: number;
}

export interface PoolState {
    chain: ChainName;
  dex: string;
  poolAddress: string;
  poolType: 'v2' | 'v3' | 'orderbook' | 'stable';
  tokenA: string;
  tokenB: string;
  reserveA?: bigint;      // v2-style
  reserveB?: bigint;
  sqrtPriceX96?: bigint;  // v3-style
  liquidity?: bigint;     // v3-style
  feeBps: number;
  // Exact pool fee in pips (1,000,000 = 100%, 3000 = 0.30%), when known.
  // Optional: V3 fees like 250 pips (0.025%) don't fit whole-number feeBps.
  // The swap maths (core/dexMath.ts feePipsOf) prefers this over feeBps.
  feePips?: number;
  lastUpdatedBlock: number;
  lastUpdatedMs: number;
  // Uniswap V4 pools only. poolAddress is then the 32-byte pool id (V4
  // pools live inside one PoolManager, they have no address of their own).
  // tokenA is the pool's currency0 side (WETH stands in for native ETH).
  v4?: {
    fee: number;          // in pips (3000 = 0.30%)
    tickSpacing: number;
    native: boolean;      // the pool holds native ETH where we use WETH
    poolManager: string;  // where trades go
    stateView: string;    // where prices are read
    hooks?: string;       // hooked pools (e.g. Fables): the hook contract; fee then changes per swap
  };
  // How to read this pool's price (default: the Uniswap V3 slot0()).
  // 'algebra': Algebra Integral copies (Alandale) keep it in globalState(),
  // with a dynamic fee in globalState word 2.
  variant?: 'algebra';
}

export interface ArbOpportunity {
    id: string;
  chain: ChainName;
  tokenPair: [string, string];
  buyDex: string;
  buyPool: string;
  sellDex: string;
  sellPool: string;
  optimalTradeSizeUsd: number;
  grossProfitUsd: number;
  costsUsd: {
    dexFees: number;
    gas: number;
    flashLoanFee: number;
    slippageBuffer: number;
    safetyMargin: number;
  };
  conservativeNetProfitUsd: number;
  triggeringEvent: RawChainEvent;
  scoredAtMs: number;
  score: number; // 0-100, see OpportunityScorer
}

export const MIN_NET_PROFIT_USD = 20;

// ----------------------------------------------------------------------------
// ChainCapability — every chain adapter implements this. The core engine
// never needs to know whether it's talking to a normal mempool, a
// speculative feed, or a sequencer feed. That difference is fully contained
// inside each adapter.
// ----------------------------------------------------------------------------
export interface ChainCapability {
    readonly chain: ChainName;

  // Does this chain expose a real pending-transaction mempool?
  readonly hasPendingMempool: boolean;

  // How does priority fee affect ordering here?
  // 'auction'   -> normal gas bidding wars (Avalanche)
  // 'none'      -> strictly first-come-first-served (Robinhood)
  readonly orderingModel: 'auction' | 'none';

  // Connect to whatever early-signal feed this chain offers.
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // Subscribe to the earliest useful signal. Emits RawChainEvent.
  onEvent(handler: (event: RawChainEvent) => void): void;

  // Chain-specific "is this safe to trade right now" check
  // (e.g. sequencer liveness on Robinhood, provider agreement on Avalanche).
  healthCheck(): Promise<{ healthy: boolean; reason?: string }>;

  // Chain-specific firing logic. Handles private submission if available.
  fireTransaction(preparedTx: PreparedTransaction): Promise<FireResult>;
}

export interface PreparedTransaction {
    chain: ChainName;
  to: string;
  data: string;
  value: bigint;
  gasLimit: bigint;
  nonce: number;
  // undefined on Robinhood — priority fee has no effect there
  maxPriorityFeePerGas?: bigint;
  maxFeePerGas?: bigint;
  minAcceptableOutput: bigint; // on-chain safety check enforces this
}

export interface FireResult {
    submittedAtMs: number;
  txHash: string;
  method: 'public' | 'private-relay' | 'sequencer-direct';
}
