import { Interface } from 'ethers';
import { ChainName, PoolState } from '../core/types';

// ============================================================================
// EXECUTOR CALLDATA BUILDER
//
// Plain English:
//   Turns an opportunity the bot found (a BackrunPlan: buy on one pool, sell
//   on the other) into the exact bytes for ArbExecutor.execute() on-chain
//   (contracts/src/ArbExecutor.sol).
//
//   This file ONLY builds the bytes. It never signs or sends anything. In
//   shadow mode the bot runs it as a dry run to report whether each real
//   opportunity COULD be executed by the contract, and if not, why.
//
// Refuses (returns ok:false with a reason) rather than guessing when:
//   - a pool type the contract can't trade (Kuru orderbook, LFJ LB, stable/V4)
//   - token decimals aren't explicitly known (a wrong guess = amounts off by
//     orders of magnitude, so no default here, unlike the pricing code)
//   - the trade rounds to zero tokens, or the profit floor rounds to zero
//
// Keep EXECUTE_ABI in sync with the contract. The test checks the selector
// against the value compiled from ArbExecutor.sol.
// ============================================================================

export const EXECUTE_ABI = [
  'function execute((address token,uint256 amountIn,uint256 minProfit,uint256 maxBlock,(uint8 kind,address pool,address tokenIn,address tokenOut,uint16 feeBps)[] hops) t, address flashPool)',
  'function executeWithV3Flash((address token,uint256 amountIn,uint256 minProfit,uint256 maxBlock,(uint8 kind,address pool,address tokenIn,address tokenOut,uint16 feeBps)[] hops) t, address lendPool)',
];
export const EXECUTE_SELECTOR = '0x4e773929'; // from `forge inspect ArbExecutor methodIdentifiers`
export const EXECUTE_V3_FLASH_SELECTOR = '0x2448659a'; // cast sig executeWithV3Flash(...)

// How a trade is funded:
//   'v3-flash' -- borrow from a V3 pool (executeWithV3Flash), no capital needed
//   'aave'     -- borrow from Aave (execute with the Aave pool)
//   'own'      -- contract's own balance (execute with address(0))
export type Funding = 'v3-flash' | 'aave' | 'own';

// Must match the KIND_* constants in ArbExecutor.sol.
export const KIND_V2 = 0;
export const KIND_SOLIDLY = 1;
export const KIND_V3 = 2;

// DEX names (PoolState.dex) whose V2-style pairs are Solidly-style, i.e.
// price via the pair's own getAmountOut instead of x*y=k.
// Pharaoh (Avalanche) is a Ramses fork, so its legacy pairs are Solidly too.
const SOLIDLY_DEXES = new Set(['ramses', 'ramses-v2', 'pharaoh']);

// DEXes the contract cannot trade, regardless of how the pool is labelled:
// bin/orderbook/V4 designs that need their own swap integration.
const UNSUPPORTED_DEXES = new Set([
  'lfj-lb', 'traderjoe-lb',   // Liquidity Book bins
  'bean-exchange',            // Bean DLMM (bins)
  'ramses-dlmm',
  'kuru',                     // orderbook
  'uniswap-v4',
]);

const iface = new Interface(EXECUTE_ABI);

export interface ExecutorHop {
  kind: number;
  pool: string;
  tokenIn: string;
  tokenOut: string;
  feeBps: number;
}

export interface BuildInput {
  chain: ChainName;
  tokenIn: string;           // the token the round trip starts and ends in
  buyPool: PoolState;        // tokenIn -> other token
  sellPool: PoolState;       // other token -> tokenIn
  tradeSizeUsd: number;      // plan.sizing.optimalTradeSizeUsd
  netProfitUsd: number;      // plan.profit.conservativeNetProfitUsd (used as the on-chain floor)
  usdPerTokenIn: number;
  tokenInDecimals: number | undefined; // must be known; undefined = refuse
  maxBlock: bigint;          // revert on-chain if mined after this block
  executorAddress?: string;  // ArbExecutor deployed on this chain (optional for dry runs)
  flashPool?: string;        // Aave V3 Pool, if borrowing from Aave
  v3Lender?: string;         // V3 pool to borrow from (preferred when set; see pickV3Lender)
}

export type BuildResult =
  | {
      ok: true;
      to: string | undefined;
      data: string;
      amountIn: bigint;
      minProfit: bigint;
      flashPool: string;   // lender address (Aave pool or V3 pool), or zero for own capital
      funding: Funding;
      hops: ExecutorHop[];
    }
  | { ok: false; reason: string };

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Which contract "kind" a pool maps to, or null if the contract can't trade it.
export function kindForPool(pool: PoolState): number | null {
  const dex = pool.dex.toLowerCase();
  if (UNSUPPORTED_DEXES.has(dex)) return null;
  if (pool.poolType === 'v3') return KIND_V3;
  if (pool.poolType === 'v2') return SOLIDLY_DEXES.has(dex) ? KIND_SOLIDLY : KIND_V2;
  return null; // 'orderbook', 'stable'
}

// The other token in a two-token pool.
function otherToken(pool: PoolState, token: string): string | null {
  const t = token.toLowerCase();
  if (pool.tokenA.toLowerCase() === t) return pool.tokenB;
  if (pool.tokenB.toLowerCase() === t) return pool.tokenA;
  return null;
}

// Converts a USD amount into token base units, rounding DOWN.
// Done in fixed-point bigint to avoid float drift on 18-decimal tokens.
export function usdToTokenUnits(usd: number, usdPerToken: number, decimals: number): bigint {
  if (!(usd > 0) || !(usdPerToken > 0) || !Number.isFinite(usd / usdPerToken)) return 0n;
  const tokens = usd / usdPerToken;
  // 1e9 precision on the token amount, then scale to decimals.
  const PRECISION = 9;
  const scaled = BigInt(Math.floor(tokens * 10 ** PRECISION));
  return decimals >= PRECISION
    ? scaled * 10n ** BigInt(decimals - PRECISION)
    : scaled / 10n ** BigInt(PRECISION - decimals);
}

export function buildExecuteCall(input: BuildInput): BuildResult {
  const { buyPool, sellPool } = input;

  // 1. Both pools must be tradeable by the contract.
  const buyKind = kindForPool(buyPool);
  if (buyKind === null) return { ok: false, reason: `buy pool not supported by contract (${buyPool.dex}/${buyPool.poolType})` };
  const sellKind = kindForPool(sellPool);
  if (sellKind === null) return { ok: false, reason: `sell pool not supported by contract (${sellPool.dex}/${sellPool.poolType})` };

  // 2. Route must chain: tokenIn -> mid on buy, mid -> tokenIn on sell.
  const mid = otherToken(buyPool, input.tokenIn);
  if (!mid) return { ok: false, reason: 'tokenIn is not in the buy pool' };
  if (otherToken(sellPool, mid)?.toLowerCase() !== input.tokenIn.toLowerCase()) {
    return { ok: false, reason: 'sell pool does not trade the same pair back to tokenIn' };
  }

  // 3. Amounts, only with explicitly known decimals.
  if (input.tokenInDecimals === undefined) return { ok: false, reason: `unknown decimals for ${input.tokenIn}` };
  const amountIn = usdToTokenUnits(input.tradeSizeUsd, input.usdPerTokenIn, input.tokenInDecimals);
  if (amountIn === 0n) return { ok: false, reason: 'trade size rounds to zero tokens' };
  const minProfit = usdToTokenUnits(input.netProfitUsd, input.usdPerTokenIn, input.tokenInDecimals);
  if (minProfit === 0n) return { ok: false, reason: 'profit floor rounds to zero tokens' };

  const hops: ExecutorHop[] = [
    { kind: buyKind, pool: buyPool.poolAddress, tokenIn: input.tokenIn, tokenOut: mid, feeBps: buyKind === KIND_V2 ? buyPool.feeBps : 0 },
    { kind: sellKind, pool: sellPool.poolAddress, tokenIn: mid, tokenOut: input.tokenIn, feeBps: sellKind === KIND_V2 ? sellPool.feeBps : 0 },
  ];

  const trade = { token: input.tokenIn, amountIn, minProfit, maxBlock: input.maxBlock, hops };
  // Prefer a V3 pool flash loan, then Aave, then own capital.
  if (input.v3Lender) {
    if (hops.some((h) => h.pool.toLowerCase() === input.v3Lender!.toLowerCase())) {
      return { ok: false, reason: 'lender pool is also a trade pool' };
    }
    const data = iface.encodeFunctionData('executeWithV3Flash', [trade, input.v3Lender]);
    return { ok: true, to: input.executorAddress, data, amountIn, minProfit, flashPool: input.v3Lender, funding: 'v3-flash', hops };
  }
  const flashPool = input.flashPool ?? ZERO_ADDRESS;
  const data = iface.encodeFunctionData('execute', [trade, flashPool]);
  const funding: Funding = flashPool === ZERO_ADDRESS ? 'own' : 'aave';
  return { ok: true, to: input.executorAddress, data, amountIn, minProfit, flashPool, funding, hops };
}

// Encodes execute() from explicit values (used by the simulator, which sets
// its own minProfit / maxBlock). buildExecuteCall() is the normal path.
export function encodeExecuteRaw(
  trade: { token: string; amountIn: bigint; minProfit: bigint; maxBlock: bigint; hops: ExecutorHop[] },
  flashPool: string = ZERO_ADDRESS,
): string {
  return iface.encodeFunctionData('execute', [trade, flashPool]);
}

// Same, for the V3-pool flash loan entry point.
export function encodeExecuteV3FlashRaw(
  trade: { token: string; amountIn: bigint; minProfit: bigint; maxBlock: bigint; hops: ExecutorHop[] },
  lendPool: string,
): string {
  return iface.encodeFunctionData('executeWithV3Flash', [trade, lendPool]);
}

// Chooses which V3 pool to borrow `token` from: must hold the token, must
// not be one of the trade's pools (a pool is locked while it lends), and
// must be a V3 pool type the contract's flash callbacks support. Picks the
// lowest fee (the loan costs that pool's fee), then the most liquidity.
// Ramses V3 is left out until its flash callback name is verified on a
// live pool (its SWAP callback is verified; the flash one isn't yet).
const FLASH_LENDER_DEXES = new Set(['uniswap-v3', 'pancakeswap-v3']);
export function pickV3Lender(candidates: PoolState[], token: string, exclude: string[]): PoolState | null {
  const t = token.toLowerCase();
  const ex = new Set(exclude.map((a) => a.toLowerCase()));
  const ok = candidates.filter((p) =>
    p.poolType === 'v3' &&
    FLASH_LENDER_DEXES.has(p.dex.toLowerCase()) &&
    !ex.has(p.poolAddress.toLowerCase()) &&
    (p.tokenA.toLowerCase() === t || p.tokenB.toLowerCase() === t) &&
    (p.liquidity ?? 0n) > 0n,
  );
  ok.sort((a, b) => a.feeBps - b.feeBps || (b.liquidity! > a.liquidity! ? 1 : b.liquidity! < a.liquidity! ? -1 : 0));
  return ok[0] ?? null;
}

// Decodes calldata back into its parts (used by tests and for logging).
export function decodeExecuteCall(data: string) {
  return iface.decodeFunctionData('execute', data);
}

// ----------------------------------------------------------------------------
// Execution switch
// ----------------------------------------------------------------------------
// Live firing is NOT implemented: adapters' fireTransaction() are still
// placeholders and nothing here signs transactions. EXECUTION_ENABLED exists
// so that turning it on before that work is done is loud, not silent.
export function executionRequested(): boolean {
  return process.env.EXECUTION_ENABLED === 'true';
}

// Per-chain contract + Aave pool addresses, read from .env when deployed:
//   ARB_EXECUTOR_AVALANCHE, ARB_EXECUTOR_MONAD, ARB_EXECUTOR_ROBINHOOD
//   AAVE_POOL_AVALANCHE (omit on chains without Aave -> own capital)
export function executorConfig(chain: ChainName): { executorAddress?: string; flashPool?: string } {
  const key = chain.toUpperCase();
  return {
    executorAddress: process.env[`ARB_EXECUTOR_${key}`] || undefined,
    flashPool: process.env[`AAVE_POOL_${key}`] || undefined,
  };
}
