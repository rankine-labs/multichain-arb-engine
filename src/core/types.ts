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
  // "Buy exactly Y" trades (Router V4 formats, core/decoderV4Router.ts): the
  // trader named the amount OUT; amountIn above is what our price maths says
  // they pay for it. Unset for normal "sell exactly X" trades.
  exactOut?: boolean;
  amountOutWanted?: bigint;
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
  // FEES SEEN IN SWAP EVENTS (Oct 13, FEE_FROM_EVENTS; core/eventFees.ts).
  // The fee the pool's latest swap really paid, per direction (z = token0
  // sold into the pool, o = token1 sold), read from V4 / Algebra Integral
  // Swap events by the block reader. Used by the swap maths instead of the
  // read fee when it is newer than feeReadBlock (or feeReadMs).
  observedFee?: { z?: ObservedFee; o?: ObservedFee };
  // When this pool's changing fee was last read from the chain (Algebra
  // globalState, hooked V4 fee source). Unset = never re-read since discovery.
  feeReadMs?: number;
  // The chain's block when that read happened (when known). Event fees count
  // only from LATER blocks, so replayed old events never beat a newer read.
  feeReadBlock?: number;
}

// One fee seen in a real swap: pips (1,000,000 = 100%), its block, and when we saw it.
export interface ObservedFee { pips: number; block: number; atMs: number }

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

// ----------------------------------------------------------------------------
// MINIMUM PROFIT TO SEND A TRADE (all chains)
//
// Plain English: the bot only sends a real trade when it expects at least
// this much profit AFTER gas, exchange fees, any loan fee and a 15% safety
// haircut. Was a fixed $20, which meant almost none of our real wins (nearly
// all under $20) would ever be sent once live. Owner decision Oct 11: $0.10.
//
// Why $0.10 is safe: a trade that loses the race costs only its gas (~2
// cents) because the contract cancels any trade that wouldn't make money,
// and the daily loss cap (DAILY_LOSS_CAP_USD) stops the bot if failed
// trades burn too much gas in a day.
//
// Setting: MIN_EXEC_NET_USD (dollars, above 0). Unset, empty, zero or
// invalid -> $0.10 (zero would let through trades whose profit floor rounds
// to nothing).
// Other bars are separate and unchanged: SIM_MIN_GROSS_USD decides what gets
// a practice check, COUNT_MIN_USD what counts in practice reports, and the
// contract's own minProfit check is set per trade from this expected profit.
// ----------------------------------------------------------------------------
export const DEFAULT_MIN_EXEC_NET_USD = 0.10;
export function readMinExecNetUsd(raw: string | undefined = process.env.MIN_EXEC_NET_USD): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MIN_EXEC_NET_USD;
  const v = Number(raw);
  if (Number.isFinite(v) && v > 0) return v;
  // Say so loudly: a typo (e.g. "0,5") must not silently fall back to $0.10.
  console.warn(`[config] MIN_EXEC_NET_USD="${raw}" is not a dollar amount above 0; using $${DEFAULT_MIN_EXEC_NET_USD}`);
  return DEFAULT_MIN_EXEC_NET_USD;
}
export const MIN_NET_PROFIT_USD = readMinExecNetUsd();

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
