import { AbiCoder, Interface, ZeroAddress, getAddress, keccak256 } from 'ethers';
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
//   - a pool type the contract can't trade (Kuru orderbook, LFJ LB, stable)
//   - a Uniswap V4 pool without its V4 details (fee, tick spacing, PoolManager)
//   - a hooked V4 pool (Fables) whose key (tokens, fee field, tick spacing,
//     hook) does not hash to its pool id: the key would name another pool
//   - token decimals aren't explicitly known (a wrong guess = amounts off by
//     orders of magnitude, so no default here, unlike the pricing code)
//   - the trade rounds to zero tokens, or the profit floor rounds to zero
//
// Keep EXECUTE_ABI in sync with the contract. The test checks the selector
// against the value compiled from ArbExecutor.sol.
// ============================================================================

const HOP_TUPLE = '(uint8 kind,address pool,address tokenIn,address tokenOut,uint16 feeBps,uint24 v4Fee,int24 v4TickSpacing,bool v4Native)';
export const EXECUTE_ABI = [
  `function execute((address token,uint256 amountIn,uint256 minProfit,uint256 maxBlock,${HOP_TUPLE}[] hops) t, address flashPool)`,
  `function executeWithV3Flash((address token,uint256 amountIn,uint256 minProfit,uint256 maxBlock,${HOP_TUPLE}[] hops) t, address lendPool)`,
];
export const EXECUTE_SELECTOR = '0x8da2b32d'; // from `forge inspect ArbExecutor methodIdentifiers`
export const EXECUTE_V3_FLASH_SELECTOR = '0xb0fa7d85'; // same source

// How a trade is funded:
//   'v3-flash' -- borrow from a V3 pool (executeWithV3Flash), no capital needed
//   'aave'     -- borrow from Aave (execute with the Aave pool)
//   'own'      -- contract's own balance (execute with address(0))
export type Funding = 'v3-flash' | 'aave' | 'own';

// Must match the KIND_* constants in ArbExecutor.sol.
export const KIND_V2 = 0;
export const KIND_SOLIDLY = 1;
export const KIND_V3 = 2;
export const KIND_V4 = 3;
// Uniswap V4 pool WITH a hook (Fables on Robinhood). Same calldata layout as
// every other hop: `pool` carries the HOOK address, v4Fee the pool key's fee
// field exactly as registered (Fables: 0x800000, the dynamic-fee flag), and
// the contract takes the PoolManager from its own setV4 setting.
export const KIND_V4_HOOKED = 4;

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
]);

const iface = new Interface(EXECUTE_ABI);

export interface ExecutorHop {
  kind: number;
  pool: string;          // KIND_V4: the PoolManager. KIND_V4_HOOKED: the hook contract.
  tokenIn: string;
  tokenOut: string;
  feeBps: number;
  // V4 kinds only (left out = not a V4 hop; filled with 0/false when encoded):
  v4Fee?: number;         // pool key's fee field (3000 = 0.30%; 0x800000 = dynamic, set by the hook)
  v4TickSpacing?: number;
  v4Native?: boolean;     // pool holds native ETH where we use WETH
  // KIND_V4_HOOKED only, NOT sent to the contract (it uses its own setting):
  // the PoolManager, so the simulator can switch V4 on in its pretend copy.
  v4PoolManager?: string;
}

// The contract expects exactly these hop fields, in this order; V4 fields are
// 0/false for V2/V3 hops. Built field by field so a bot-only field (such as
// v4PoolManager) is never passed to the encoder.
function fullHop(h: ExecutorHop) {
  return {
    kind: h.kind, pool: h.pool, tokenIn: h.tokenIn, tokenOut: h.tokenOut, feeBps: h.feeBps,
    v4Fee: h.v4Fee ?? 0, v4TickSpacing: h.v4TickSpacing ?? 0, v4Native: h.v4Native ?? false,
  };
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

// Robinhood "copy" exchanges (src/config/robinhoodVenues.ts) that are exact
// copies of a V3 exchange we already trade, and which payment callback their
// pools call on our contract. The contract answers all three callback names
// the same way and only checks that the caller is the pool it is swapping
// with right now (no factory or init-code-hash check), so a copy pool works
// as long as its swap() and callback match the original. They all trade as
// KIND_V3 with the pool's own address; nothing else in the calldata differs
// (tick spacing / fee tier is only used to FIND the pool, not to trade it).
// Proved per venue by contracts/test/ForkCopyVenues.t.sol. Whether a venue
// may actually be used is decided elsewhere (isPracticeTestableVenue).
export const COPY_V3_CALLBACK: Readonly<Record<string, 'uniswapV3SwapCallback' | 'pancakeV3SwapCallback'>> = {
  'giga-cl': 'pancakeV3SwapCallback',      // PancakeSwap V3 copy
  'swaphood-v3': 'pancakeV3SwapCallback',  // PancakeSwap V3 copy
  'sushiswap-v3': 'uniswapV3SwapCallback', // Uniswap V3 copy
  'up-cl': 'uniswapV3SwapCallback',        // Slipstream (Velodrome/Aerodrome CL) copy
  'topaz-cl': 'uniswapV3SwapCallback',     // Slipstream copy
  'raphael-cl': 'uniswapV3SwapCallback',   // Slipstream copy
};

// Which contract "kind" a pool maps to, or null if the contract can't trade it.
export function kindForPool(pool: PoolState): number | null {
  const dex = pool.dex.toLowerCase();
  if (UNSUPPORTED_DEXES.has(dex)) return null;
  // V4 needs its pool details. Hookless pools trade as KIND_V4; pools with a
  // hook (Fables) as KIND_V4_HOOKED, which carries the hook address
  // (contracts/test/ForkFablesVenues.t.sol proves it on real Fables pools).
  const hooked = isHookedV4(pool);
  if (dex === 'uniswap-v4') return pool.v4 ? (hooked ? KIND_V4_HOOKED : KIND_V4) : null;
  // Algebra Integral copies (Alandale, KittenSwap): swap() takes the same
  // inputs as Uniswap V3 and pays through algebraSwapCallback, which the
  // contract answers exactly like the V3 callbacks (same caller check). So
  // they trade as an ordinary KIND_V3 hop with the pool's own address.
  // Proved by contracts/test/ForkAlgebraVenues.t.sol. NOTE: only this
  // branch's contract code has that callback; the bot's PRACTICE simulator
  // runs that code, but the contract deployed on chain does not have it yet
  // (a redeploy is needed before a real Algebra trade could work). Real
  // trades are refused anyway: these venues are not isExecutableVenue().
  if (pool.variant === 'algebra') return pool.v4 ? null : KIND_V3;
  // Any other pool carrying V4 details has a 32-byte pool id, not a pool
  // address, so the V3 path can't trade it. Hooked ones (Fables) go through
  // the PoolManager as KIND_V4_HOOKED; hookless ones under another exchange
  // name are not expected and stay refused.
  if (pool.v4) return hooked ? KIND_V4_HOOKED : null;
  if (pool.poolType === 'v3') return KIND_V3;
  if (pool.poolType === 'v2') return SOLIDLY_DEXES.has(dex) ? KIND_SOLIDLY : KIND_V2;
  return null; // 'orderbook', 'stable'
}

// True for a V4 pool with a real (non-zero) hook address.
export function isHookedV4(pool: PoolState): boolean {
  return !!pool.v4?.hooks && pool.v4.hooks.toLowerCase() !== ZERO_ADDRESS;
}

// The V4 pool key of a pool, as the contract will build it: currency0 is
// native ETH (address 0) for native pools (tokenB is then the other coin),
// else tokenA (the bot keeps tokenA = currency0 side for V4 pools).
export function v4KeyOf(pool: PoolState): { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string } {
  const v4 = pool.v4!;
  return {
    currency0: v4.native ? ZeroAddress : pool.tokenA,
    currency1: pool.tokenB,
    fee: v4.fee,
    tickSpacing: v4.tickSpacing,
    hooks: v4.hooks && isHookedV4(pool) ? v4.hooks : ZeroAddress,
  };
}

// Does the key we would send hash to the pool's id (poolAddress)? A wrong fee
// field (e.g. a measured fee instead of the registered 0x800000) or a wrong
// hook would point the swap at a different, likely non-existent, pool.
export function v4KeyMatchesId(pool: PoolState): boolean {
  if (!pool.v4) return false;
  const k = v4KeyOf(pool);
  try {
    const id = keccak256(AbiCoder.defaultAbiCoder().encode(
      ['address', 'address', 'uint24', 'int24', 'address'], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
    return id.toLowerCase() === pool.poolAddress.toLowerCase();
  } catch {
    return false; // bad address or out-of-range fee / tick spacing
  }
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
  // Hooked V4 pools: the key we send must be exactly the pool's own key.
  for (const [k, p, side] of [[buyKind, buyPool, 'buy'], [sellKind, sellPool, 'sell']] as const) {
    if (k === KIND_V4_HOOKED && !v4KeyMatchesId(p)) {
      return { ok: false, reason: `${side} pool: hooked V4 key (tokens, fee ${p.v4?.fee}, tick spacing ${p.v4?.tickSpacing}, hook) does not match its pool id` };
    }
  }

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
    hopFor(buyKind, buyPool, input.tokenIn, mid),
    hopFor(sellKind, sellPool, mid, input.tokenIn),
  ];

  const trade = { token: input.tokenIn, amountIn, minProfit, maxBlock: input.maxBlock, hops: hops.map(fullHop) };
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

// One hop of the route in the contract's format.
export function hopFor(kind: number, pool: PoolState, tokenIn: string, tokenOut: string): ExecutorHop {
  if (kind === KIND_V4) {
    // V4: the trade goes to the PoolManager; the pool is named by its fee,
    // tick spacing and tokens (hookless pools only, enforced by the contract).
    return {
      // getAddress(lowercase): accept any capitalisation (a stored address with
      // a wrong checksum would otherwise make the encoder throw).
      kind, pool: getAddress(pool.v4!.poolManager.toLowerCase()), tokenIn, tokenOut, feeBps: 0,
      v4Fee: pool.v4!.fee, v4TickSpacing: pool.v4!.tickSpacing, v4Native: pool.v4!.native,
    };
  }
  if (kind === KIND_V4_HOOKED) {
    // Hooked V4 (Fables): `pool` is the HOOK; the fee field goes as registered
    // (dynamic-fee flag included). The PoolManager rides along for the
    // simulator only; the contract uses its own setV4 setting.
    return {
      kind, pool: getAddress(pool.v4!.hooks!.toLowerCase()), tokenIn, tokenOut, feeBps: 0,
      v4Fee: pool.v4!.fee, v4TickSpacing: pool.v4!.tickSpacing, v4Native: pool.v4!.native,
      v4PoolManager: getAddress(pool.v4!.poolManager.toLowerCase()),
    };
  }
  return {
    kind, pool: pool.poolAddress, tokenIn, tokenOut, feeBps: kind === KIND_V2 ? pool.feeBps : 0,
    v4Fee: 0, v4TickSpacing: 0, v4Native: false,
  };
}

// Encodes execute() from explicit values (used by the simulator, which sets
// its own minProfit / maxBlock). buildExecuteCall() is the normal path.
export function encodeExecuteRaw(
  trade: { token: string; amountIn: bigint; minProfit: bigint; maxBlock: bigint; hops: ExecutorHop[] },
  flashPool: string = ZERO_ADDRESS,
): string {
  return iface.encodeFunctionData('execute', [{ ...trade, hops: trade.hops.map(fullHop) }, flashPool]);
}

// Same, for the V3-pool flash loan entry point.
export function encodeExecuteV3FlashRaw(
  trade: { token: string; amountIn: bigint; minProfit: bigint; maxBlock: bigint; hops: ExecutorHop[] },
  lendPool: string,
): string {
  return iface.encodeFunctionData('executeWithV3Flash', [{ ...trade, hops: trade.hops.map(fullHop) }, lendPool]);
}

// Chooses which V3 pool to borrow `token` from: must hold the token, must
// not be one of the trade's pools (a pool is locked while it lends), and
// must be a V3 pool type the contract's flash callbacks support. Picks the
// lowest fee (the loan costs that pool's fee), then the most liquidity.
// Ramses V3 verified Oct 2026 by the fork test
// test_fork_robinhood_ramsesV3_asLender (a live pool lent, trades ran, loan repaid).
const FLASH_LENDER_DEXES = new Set(['uniswap-v3', 'pancakeswap-v3', 'ramses-v3']);
//
// canLend (optional): "does this pool really hold enough of the token?" (see
// core/lenderBalances.ts). When given, pools that can't cover the loan with
// room to spare are skipped. Without it, the cheapest pool won even if it
// held almost nothing, and the loan failed ("TF" / "TransferFailed" / "L").
export function pickV3Lender(
  candidates: PoolState[], token: string, exclude: string[],
  canLend?: (pool: string, token: string) => boolean,
): PoolState | null {
  const t = token.toLowerCase();
  const ex = new Set(exclude.map((a) => a.toLowerCase()));
  const ok = candidates.filter((p) =>
    p.poolType === 'v3' &&
    FLASH_LENDER_DEXES.has(p.dex.toLowerCase()) &&
    !ex.has(p.poolAddress.toLowerCase()) &&
    (p.tokenA.toLowerCase() === t || p.tokenB.toLowerCase() === t) &&
    (p.liquidity ?? 0n) > 0n &&
    (!canLend || canLend(p.poolAddress, t)),
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
