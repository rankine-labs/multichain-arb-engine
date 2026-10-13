import { ethers } from 'ethers';
import { ChainName, DecodedSwap, PoolState, RawChainEvent } from './types';
import { computeAmountOut } from './dexMath';

// ============================================================================
// ROUTER V4 FORMATS: reading Uniswap V4 swaps sent through a Universal Router
// (practice/read-only: this file only READS calldata, it never sends anything)
//
// Plain English:
//   Most Uniswap V4 trades on Robinhood arrive as a Universal Router call
//   execute(commands, inputs[, deadline]). One of the commands is V4_SWAP
//   (command byte 0x10). Its input is itself a little program for the "V4
//   router": a list of 1-byte ACTIONS (swap, pay in, take out...) and one
//   parameter blob per action.
//
//   The older reader in decoder.ts (decodeV4Swap) already reads the simplest
//   kind: "sell exactly X" on a pool WITHOUT a hook. This file reads more:
//     - "buy exactly Y" trades (exact-output, single pool and multi-hop),
//       sized by working out how much the trader must pay for Y in our copy
//       of the pool (the same price maths the bot uses everywhere else);
//     - hooked pools the bot already watches (e.g. Fables), including
//       changing-fee ("dynamic fee") pools, but ONLY where the bot has a fee
//       source for them (Fables: core/fablesFee.ts, via pairWatcher.hookedFee);
//     - newer V4 router versions whose multi-hop format has an extra list.
//   Every swap is matched to the EXACT pool in the bot's pool list by its V4
//   pool id. Anything we can't read safely (unknown pool, unknown layout,
//   changing fee with no fee source, broken data) is skipped and counted as
//   "not readable", never guessed.
//
//   SWITCH: FEED_DECODE_UR_V4=1 turns this on. Unset or 0 = exactly today's
//   behaviour (only the older reader runs). When on and this reader can't
//   read a swap, the older reader still gets its chance, so turning it on
//   never reads FEWER trades than today.
//
//   Multi-hop trades: like the V3 reader (decoder.ts firstV3Hop), we report
//   ONE pool per trade and never chain amounts through later hops:
//     - "sell exactly X" multi-hop: the FIRST hop (where X goes in);
//     - "buy exactly Y" multi-hop: the LAST hop (where Y comes out), because
//       that is the only hop whose amount the calldata tells us.
// ============================================================================

// ---------------------------------------------------------------------------
// Constants, checked against Uniswap's own source code:
//
// Universal Router, contracts/libraries/Commands.sol (universal-router v2.x,
// the version with V4 support):
//   FLAG_ALLOW_REVERT = 0x80   ("don't fail the whole trade if this step fails")
//   COMMAND_TYPE_MASK = 0x3f   (the low 6 bits are the command number)
//   V4_SWAP           = 0x10
// (In the old v1.x Universal Router 0x10 meant SEAPORT_V1_5 instead, so this
// reader is only used for router entries marked as V4-capable, the same rule
// the older reader follows: RouterRegistryEntry.v4WrappedNative.)
export const UR_ALLOW_REVERT_FLAG = 0x80;
export const UR_COMMAND_MASK = 0x3f;
export const UR_CMD_V4_SWAP = 0x10;

// v4-periphery, src/libraries/Actions.sol (the V4 router's action numbers):
export const V4_ACTION = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SWAP_EXACT_IN: 0x07,
  SWAP_EXACT_OUT_SINGLE: 0x08,
  SWAP_EXACT_OUT: 0x09,
  SETTLE: 0x0b,      // (currency, amount, payerIsUser): pay `amount` in
  SETTLE_ALL: 0x0c,  // (currency, maxAmount): pay everything owed, up to max
  SETTLE_PAIR: 0x0d,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
  TAKE_PORTION: 0x10,
  TAKE_PAIR: 0x11,
  CLOSE_CURRENCY: 0x12,
  CLEAR_OR_TAKE: 0x13,
  SWEEP: 0x14,
  WRAP: 0x15,
  UNWRAP: 0x16,
} as const;

// v4-core LPFeeLibrary.sol: a pool whose listed fee is exactly this value has
// a "dynamic fee" that its hook picks at swap time. Real fixed fees are at
// most 1,000,000 pips (100%).
export const V4_DYNAMIC_FEE_FLAG = 0x800000;
const MAX_LP_FEE = 1_000_000;

// v4-periphery ActionConstants.sol: OPEN_DELTA (0) = "use whatever amount is
// owed right now", CONTRACT_BALANCE (1 << 255) = "use the router's whole
// balance". Neither tells us a real size from the calldata alone.
const OPEN_DELTA = 0n;
const CONTRACT_BALANCE = 1n << 255n;
const MAX_UINT128 = (1n << 128n) - 1n;

const ZERO = ethers.ZeroAddress.toLowerCase();
const coder = ethers.AbiCoder.defaultAbiCoder();

// Hook-using exchanges whose changing fee the bot already knows how to read
// (shadowMain feeds the Fables fee predictor into pairWatcher.hookedFee, so
// these pools' fee in the pool list is the predicted real fee).
export const FEE_RESOLVED_HOOK_DEXES = new Set(['fables']);

// ---------------------------------------------------------------------------
// The on/off switch. Read on each use so a test (or a restart with a new
// .env) sees the current value. Only "1", "true", "yes" or "on" turn it on.
export function urV4DecodeOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.FEED_DECODE_UR_V4 ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// ---------------------------------------------------------------------------
// Hourly counters for the report ("Router V4 swaps read: N"). Counted once per
// V4_SWAP command that contains at least one swap action.
export interface UrV4Hour {
  read: number;          // swaps read (by this reader or, failing that, the older one)
  exactOut: number;      // ...of which "buy exactly Y" trades
  hooked: number;        // ...of which on hooked pools (e.g. Fables)
  olderReader: number;   // ...of which only the older reader could read
  notReadable: number;   // V4 swaps neither reader could read
  reasons: [string, number][]; // why not readable, most common first
}
const stats = { read: 0, exactOut: 0, hooked: 0, olderReader: 0, notReadable: 0, reasons: new Map<string, number>() };
const MAX_REASONS = 50; // memory guard: reasons are a fixed small set anyway

// Returns this hour's numbers and starts a fresh hour.
export function takeUrV4Hour(): UrV4Hour {
  const out: UrV4Hour = {
    read: stats.read, exactOut: stats.exactOut, hooked: stats.hooked, olderReader: stats.olderReader,
    notReadable: stats.notReadable, reasons: [...stats.reasons.entries()].sort((a, b) => b[1] - a[1]),
  };
  stats.read = stats.exactOut = stats.hooked = stats.olderReader = stats.notReadable = 0;
  stats.reasons.clear();
  return out;
}
function noteNotReadable(reason: string) {
  stats.notReadable++;
  if (stats.reasons.has(reason) || stats.reasons.size < MAX_REASONS) stats.reasons.set(reason, (stats.reasons.get(reason) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// V4 pool id = keccak256(abi.encode(currency0, currency1, fee, tickSpacing,
// hooks)). Same formula as core/v4Lookup.ts v4Id and core/poolResolver.ts
// v4PoolId, but with the real hook address (those two assume no hook).
// Lowercase, like the pool list stores it.
export function v4PoolIdOf(c0: string, c1: string, fee: number, tickSpacing: number, hooks: string): string {
  return ethers.keccak256(coder.encode(['address', 'address', 'uint24', 'int24', 'address'], [c0, c1, fee, tickSpacing, hooks])).toLowerCase();
}

// ABI layouts of the swap actions' parameters (v4-periphery IV4Router.sol).
const POOL_KEY = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const PATH_KEY = 'tuple(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)';
// ExactInputSingleParams / ExactOutputSingleParams (same shape; the two
// amounts are amountIn+amountOutMinimum or amountOut+amountInMaximum).
const SINGLE = [`tuple(${POOL_KEY} poolKey,bool zeroForOne,uint128 amount,uint128 limit,bytes hookData)`];
// ExactInputParams / ExactOutputParams (currency = currencyIn / currencyOut).
const MULTI = [`tuple(address currency,${PATH_KEY}[] path,uint128 amount,uint128 limit)`];
// Newer V4 router versions add a per-hop price-limit list right after the
// path (same as decoder.ts V4_EXACT_IN_V2). The list itself is not needed.
const MULTI_WITH_HOP_LIMITS = [`tuple(address currency,${PATH_KEY}[] path,uint256[] hopLimits,uint128 amount,uint128 limit)`];

// Reads 32-byte word number i of an ABI blob (null if the blob is too short).
function wordAt(hex: string, i: number): bigint | null {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length < (i + 1) * 64) return null;
  try { return BigInt('0x' + h.slice(i * 64, (i + 1) * 64)); } catch { return null; }
}

// Which layout a blob uses, checked from its raw layout so a wrong guess can
// never "decode" into nonsense amounts. Each params blob is abi.encode(struct):
// word 0 points at the struct; inside it, the pointer to the first list or
// bytes field tells how many fixed fields come before it.
//   single:  hookData pointer = 9 words (0x120) -> the standard layout
//   multi:   path pointer = 4 words (0x80) -> standard; 5 words (0xa0) -> with hop limits
function layoutOf(param: string, kind: 'single' | 'multi'): string[] | null {
  const ptr = wordAt(param, 0);
  if (ptr === null || ptr % 32n !== 0n || ptr > 32n * 16n) return null;
  const base = Number(ptr / 32n);
  if (kind === 'single') return wordAt(param, base + 8) === 0x120n ? SINGLE : null;
  const pathPtr = wordAt(param, base + 1);
  if (pathPtr === 0x80n) return MULTI;
  if (pathPtr === 0xa0n) return MULTI_WITH_HOP_LIMITS;
  return null;
}

// ---------------------------------------------------------------------------
// What the caller gives us.
export interface UrV4Context {
  chain: ChainName;
  wrappedNative: string;   // native ETH (address 0) is reported as this token
  poolLookup: (chain: ChainName, poolAddress: string) => PoolState | undefined;
  event: RawChainEvent;
  txValue: bigint;         // native ETH sent with the transaction
}

// One swap step as written in the calldata, before matching it to a pool.
interface Leg {
  c0: string; c1: string; fee: number; tickSpacing: number; hooks: string; // the pool key
  currencyIn: string; currencyOut: string;
  exactOut: boolean;
  amount: bigint;   // amount in ("sell exactly") or amount out ("buy exactly")
  limit: bigint;    // most the trader will pay ("buy exactly"); unused otherwise
}

type Outcome = { swap: DecodedSwap } | { reason: string };

// The pool key of the pool between two currencies (V4 sorts them by address;
// native ETH = address 0 always sorts first).
function keyBetween(a: string, b: string): [string, string] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

// Turns one swap action into a Leg, or a reason it can't be read.
function legOf(action: number, param: string): Leg | { reason: string } {
  const single = action === V4_ACTION.SWAP_EXACT_IN_SINGLE || action === V4_ACTION.SWAP_EXACT_OUT_SINGLE;
  const exactOut = action === V4_ACTION.SWAP_EXACT_OUT_SINGLE || action === V4_ACTION.SWAP_EXACT_OUT;
  const layout = layoutOf(param, single ? 'single' : 'multi');
  if (!layout) return { reason: 'unknown V4 router format' };
  let x: any;
  try { [x] = coder.decode(layout, param); } catch { return { reason: 'broken swap data' }; }
  if (single) {
    const k = x.poolKey;
    const c0 = String(k.currency0), c1 = String(k.currency1);
    return {
      c0, c1, fee: Number(k.fee), tickSpacing: Number(k.tickSpacing), hooks: String(k.hooks).toLowerCase(),
      currencyIn: x.zeroForOne ? c0 : c1, currencyOut: x.zeroForOne ? c1 : c0,
      exactOut, amount: BigInt(x.amount), limit: BigInt(x.limit),
    };
  }
  const path = x.path as any[];
  if (!path?.length) return { reason: 'broken swap data' };
  if (!exactOut) {
    // "Sell exactly": first hop = currencyIn -> path[0].intermediateCurrency.
    const hop = path[0];
    const a = String(x.currency), b = String(hop.intermediateCurrency);
    const [c0, c1] = keyBetween(a, b);
    return { c0, c1, fee: Number(hop.fee), tickSpacing: Number(hop.tickSpacing), hooks: String(hop.hooks).toLowerCase(),
      currencyIn: a, currencyOut: b, exactOut, amount: BigInt(x.amount), limit: BigInt(x.limit) };
  }
  // "Buy exactly": the router walks the path BACKWARDS from currencyOut
  // (V4Router._swapExactOutput). The last element names the pool that pays
  // out currencyOut: path[last].intermediateCurrency -> currencyOut.
  const hop = path[path.length - 1];
  const a = String(hop.intermediateCurrency), b = String(x.currency);
  const [c0, c1] = keyBetween(a, b);
  return { c0, c1, fee: Number(hop.fee), tickSpacing: Number(hop.tickSpacing), hooks: String(hop.hooks).toLowerCase(),
    currencyIn: a, currencyOut: b, exactOut,
    amount: BigInt(x.amount),
    // amountInMaximum caps the FIRST hop's input; for the last hop of a
    // multi-hop trade there is no cap we can know, so none is applied.
    limit: path.length === 1 ? BigInt(x.limit) : MAX_UINT128 };
}

// How much the trader actually paid in for an "open amount" (amountIn = 0)
// trade: a SETTLE / SETTLE_ALL action for that currency, or, for native ETH,
// the ETH sent with the transaction. 0 = unknown. Same rule as the older
// reader in decoder.ts (decodeV4Swap's paidIn).
function paidIn(currency: string, actions: Uint8Array, params: string[], txValue: bigint): bigint {
  const c = currency.toLowerCase();
  for (let k = 0; k < actions.length && k < params.length; k++) {
    try {
      if (actions[k] === V4_ACTION.SETTLE) {
        const [cur, amt] = coder.decode(['address', 'uint256', 'bool'], params[k]);
        const a = BigInt(amt);
        if (String(cur).toLowerCase() === c && a > 0n && a < CONTRACT_BALANCE) return a;
      } else if (actions[k] === V4_ACTION.SETTLE_ALL) {
        const [cur, max] = coder.decode(['address', 'uint256'], params[k]);
        const a = BigInt(max);
        if (String(cur).toLowerCase() === c && a > 0n && a < CONTRACT_BALANCE) return a;
      }
    } catch { /* not that shape: keep looking */ }
  }
  return c === ZERO && txValue > 0n ? txValue : 0n;
}

// Smallest amount in that buys at least `amountOut` from this pool, by the
// bot's own price maths (core/dexMath.ts computeAmountOut), and no more than
// `max`. null = can't be done within `max` (our copy of the price is then
// probably out of date) or the pool has no price data.
export function inputForOutput(pool: PoolState, tokenInIsA: boolean, amountOut: bigint, max: bigint): bigint | null {
  if (amountOut <= 0n || max <= 0n) return null;
  const outAt = (x: bigint) => computeAmountOut(pool, tokenInIsA, x);
  const top = outAt(max);
  if (top === null || top < amountOut) return null;
  let lo = 1n, hi = max; // answer is in [lo, hi]; at most ~128 steps
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const got = outAt(mid);
    if (got !== null && got >= amountOut) hi = mid; else lo = mid + 1n;
  }
  return lo;
}

// Matches a Leg to the bot's pool list and builds the decoded swap.
function swapOfLeg(leg: Leg, ctx: UrV4Context, actions: Uint8Array, params: string[]): Outcome {
  const hooked = leg.hooks !== ZERO;
  const dynamic = leg.fee === V4_DYNAMIC_FEE_FLAG;
  if (!dynamic && (leg.fee < 0 || leg.fee > MAX_LP_FEE)) return { reason: 'broken swap data' };
  if (dynamic && !hooked) return { reason: 'broken swap data' }; // V4 refuses this combination
  const id = v4PoolIdOf(leg.c0, leg.c1, leg.fee, leg.tickSpacing, leg.hooks);
  const pool = ctx.poolLookup(ctx.chain, id);
  if (!pool || !pool.v4) return { reason: hooked ? 'hooked pool not watched' : 'pool not watched' };
  if (hooked) {
    // The pool list must know this exact hook (it does for Fables pools).
    if ((pool.v4.hooks ?? '').toLowerCase() !== leg.hooks) return { reason: 'hooked pool not watched' };
    // Changing fee: only where the bot has a fee source for that exchange.
    if (dynamic && !FEE_RESOLVED_HOOK_DEXES.has(pool.dex)) return { reason: 'changing-fee pool with no fee source' };
  }
  const asToken = (c: string) => (c.toLowerCase() === ZERO ? ctx.wrappedNative : c);
  const tokenIn = asToken(leg.currencyIn), tokenOut = asToken(leg.currencyOut);
  // Sanity: the pool list's tokens must be this trade's two tokens.
  const tIn = tokenIn.toLowerCase(), tA = pool.tokenA.toLowerCase(), tB = pool.tokenB.toLowerCase();
  if (!((tIn === tA && tokenOut.toLowerCase() === tB) || (tIn === tB && tokenOut.toLowerCase() === tA))) return { reason: 'pool tokens do not match' };

  let amountIn: bigint;
  if (!leg.exactOut) {
    amountIn = leg.amount === OPEN_DELTA ? paidIn(leg.currencyIn, actions, params, ctx.txValue) : leg.amount;
    if (amountIn <= 0n || amountIn >= CONTRACT_BALANCE) return { reason: 'amount not in the calldata' };
  } else {
    if (leg.amount === OPEN_DELTA) return { reason: 'amount not in the calldata' };
    const max = leg.limit > 0n ? leg.limit : MAX_UINT128;
    const need = inputForOutput(pool, tIn === tA, leg.amount, max);
    if (need === null) return { reason: 'buy-exact trade could not be sized' };
    amountIn = need;
  }
  const fee = !dynamic ? leg.fee : pool.feePips;
  return {
    swap: {
      chain: ctx.chain,
      dex: pool.dex,
      poolAddress: pool.poolAddress, // the exact V4 pool id, as the pool list stores it
      tokenIn, tokenOut, amountIn,
      feeTier: fee,
      exactOut: leg.exactOut || undefined,
      amountOutWanted: leg.exactOut ? leg.amount : undefined,
      stateType: ctx.event.stateType,
      detectedAtMs: ctx.event.receivedAtMs,
    },
  };
}

const SWAP_ACTIONS = new Set<number>([V4_ACTION.SWAP_EXACT_IN_SINGLE, V4_ACTION.SWAP_EXACT_IN, V4_ACTION.SWAP_EXACT_OUT_SINGLE, V4_ACTION.SWAP_EXACT_OUT]);

// Reads one V4_SWAP command's input (abi.encode(bytes actions, bytes[] params)).
// Returns the first swap it can read, or the reason the first swap action
// couldn't be read. `none` = no swap action at all (nothing to count).
export function decodeUrV4Input(input: string, ctx: UrV4Context): Outcome | { none: true } {
  let actions: Uint8Array, params: string[];
  try {
    const [a, p] = coder.decode(['bytes', 'bytes[]'], input);
    actions = ethers.getBytes(a as string);
    params = p as string[];
  } catch {
    return { reason: 'broken swap data' };
  }
  let firstReason: string | null = null;
  for (let j = 0; j < actions.length && j < params.length; j++) {
    if (!SWAP_ACTIONS.has(actions[j])) continue;
    let out: Outcome;
    try {
      const leg = legOf(actions[j], params[j]);
      out = 'reason' in leg ? leg : swapOfLeg(leg, ctx, actions, params);
    } catch {
      out = { reason: 'broken swap data' }; // never let odd calldata crash the feed
    }
    if ('swap' in out) return out;
    firstReason ??= out.reason;
  }
  return firstReason ? { reason: firstReason } : { none: true };
}

// The pool keys of every swap action this reader understands in one V4_SWAP
// input (empty if none). Used by the read-only probe (scripts/probe-urv4.ts)
// to look the pools up on chain before decoding.
export interface V4PoolKeyInfo { id: string; c0: string; c1: string; fee: number; tickSpacing: number; hooks: string; action: number }
export function v4PoolKeysIn(input: string): V4PoolKeyInfo[] {
  const out: V4PoolKeyInfo[] = [];
  try {
    const [a, p] = coder.decode(['bytes', 'bytes[]'], input);
    const actions = ethers.getBytes(a as string), params = p as string[];
    for (let j = 0; j < actions.length && j < params.length; j++) {
      if (!SWAP_ACTIONS.has(actions[j])) continue;
      try {
        const leg = legOf(actions[j], params[j]);
        if ('reason' in leg) continue;
        out.push({ id: v4PoolIdOf(leg.c0, leg.c1, leg.fee, leg.tickSpacing, leg.hooks), c0: leg.c0, c1: leg.c1, fee: leg.fee, tickSpacing: leg.tickSpacing, hooks: leg.hooks, action: actions[j] });
      } catch { /* skip this action */ }
    }
  } catch { /* broken input: no keys */ }
  return out;
}

// What decoder.ts calls for each V4_SWAP command when the switch is on.
// `older` = the older reader for the same command (decoder.ts decodeV4Swap),
// tried when this reader can't read it, so being on never reads less than
// today. Updates the hourly counters.
export function readUrV4Command(input: string, ctx: UrV4Context, older: () => DecodedSwap | null): DecodedSwap | null {
  const out = decodeUrV4Input(input, ctx);
  if ('swap' in out) {
    stats.read++;
    if (out.swap.exactOut) stats.exactOut++;
    if (ctx.poolLookup(ctx.chain, out.swap.poolAddress)?.v4?.hooks) stats.hooked++;
    return out.swap;
  }
  let fallback: DecodedSwap | null = null;
  try { fallback = older(); } catch { fallback = null; }
  if (fallback) { stats.read++; stats.olderReader++; return fallback; }
  if ('reason' in out) noteNotReadable(out.reason);
  return null;
}
