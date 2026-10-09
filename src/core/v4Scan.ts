import { ethers } from 'ethers';
import type { PoolState } from './types';

// ============================================================================
// UNISWAP V4 IN THE CHAIN-WIDE SCAN -- shared helpers (read-only).
//
// Plain English:
//   Every other exchange gives each pool its own contract (an address), so
//   the scan can find pools from factory "new pool" events and read a pool's
//   money with token.balanceOf(pool). Uniswap V4 is different: ALL its pools
//   live inside one PoolManager contract and are known by a 32-byte pool id.
//   So for V4:
//     - FIND pools from the PoolManager's Initialize events (filtered by the
//       event's topic, so we never download its flood of Swap events).
//     - Skip pools with a hook (custom add-on code): the bot can't trade
//       them, same rule as the rest of the bot.
//     - READ a pool through StateView (the official read-only helper):
//       getSlot0 (price) + getLiquidity. There is no per-pool balance, so
//       "money in the pool" is its VIRTUAL amounts at the current price:
//         amount0 = L / sqrtPrice,  amount1 = L x sqrtPrice
//       That is the V2-equivalent depth near today's price, which is what an
//       arbitrage trade actually hits (it can overstate a pool whose money
//       sits in a very narrow price range; the bot re-reads exact prices
//       before any decision, so this only affects what gets WATCHED).
//   Native ETH pools: WETH stands in for native ETH (same as the rest of the
//   bot), so a V4 ETH/HOOD pool pairs up with WETH/HOOD pools elsewhere.
// ============================================================================

export const V4_INITIALIZE_TOPIC = ethers.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
export const V4_MODIFY_LIQUIDITY_TOPIC = ethers.id('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)');
export const SEL_V4_SLOT0 = ethers.id('getSlot0(bytes32)').slice(0, 10);
export const SEL_V4_LIQ = ethers.id('getLiquidity(bytes32)').slice(0, 10);

const Q96 = 2n ** 96n;
const ZERO = '0x' + '0'.repeat(40);

// What the scan keeps about a V4 pool (besides its id and coins).
export interface V4Meta {
  fee: number;          // pips (3000 = 0.30%)
  tickSpacing: number;
  native: boolean;      // holds native ETH (WETH stands in for it)
  poolManager: string;
  stateView: string;
}

export interface V4InitDecoded {
  id: string;           // lowercase 0x + 64 hex
  token0: string;       // lowercase (WETH if native ETH)
  token1: string;
  fee: number;
  tickSpacing: number;
  native: boolean;
  hooked: boolean;
  sqrtPriceX96: bigint;
}

const wordAt = (hex: string, i: number): string | null => (hex.length >= 64 * (i + 1) ? hex.slice(64 * i, 64 * (i + 1)) : null);
const toSigned = (v: bigint, bits: number) => (v >= 1n << BigInt(bits - 1) ? v - (1n << BigInt(bits)) : v);

// Pool id = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)).
export function v4IdOf(c0: string, c1: string, fee: number, tickSpacing: number, hooks: string): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint24', 'int24', 'address'], [c0, c1, fee, tickSpacing, hooks])).toLowerCase();
}

// Decode one Initialize log. Returns null when it isn't a valid Initialize,
// or when the id doesn't match the decoded key (self-check: proves the event
// layout was read correctly), or for an ETH/WETH pool (same coin both sides).
// Hooked pools are returned with hooked = true (callers skip them).
export function decodeV4Initialize(log: { topics: readonly string[]; data: string }, weth: string): V4InitDecoded | null {
  if (log.topics.length < 4 || log.topics[0].toLowerCase() !== V4_INITIALIZE_TOPIC) return null;
  const hex = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
  const wFee = wordAt(hex, 0), wTs = wordAt(hex, 1), wHooks = wordAt(hex, 2), wSqrt = wordAt(hex, 3);
  if (!wFee || !wTs || !wHooks || !wSqrt) return null;
  try {
    const id = log.topics[1].toLowerCase();
    const c0 = '0x' + log.topics[2].slice(-40).toLowerCase();
    const c1 = '0x' + log.topics[3].slice(-40).toLowerCase();
    const fee = Number(BigInt('0x' + wFee));
    const tickSpacing = Number(toSigned(BigInt('0x' + wTs), 256));
    const hooks = '0x' + wHooks.slice(-40).toLowerCase();
    if (v4IdOf(c0, c1, fee, tickSpacing, hooks) !== id) return null; // misread: never trust it
    const native = c0 === ZERO;
    const w = weth.toLowerCase();
    const token0 = native ? w : c0;
    if (token0 === c1) return null; // native ETH vs WETH: not a coin pair
    return { id, token0, token1: c1, fee, tickSpacing, native, hooked: hooks !== ZERO, sqrtPriceX96: BigInt('0x' + wSqrt) };
  } catch { return null; }
}

// Virtual amounts at the current price (raw token units). See header.
export function v4VirtualAmounts(sqrtPriceX96: bigint, liquidity: bigint): { a0: bigint; a1: bigint } {
  if (sqrtPriceX96 <= 0n || liquidity <= 0n) return { a0: 0n, a1: 0n };
  return { a0: (liquidity * Q96) / sqrtPriceX96, a1: (liquidity * sqrtPriceX96) / Q96 };
}

const word0 = (r: string | null): bigint | null => { try { return r && r.length >= 66 ? BigInt(r.slice(0, 66)) : null; } catch { return null; } };

// The two StateView reads for one pool, and their decoding.
export function v4StateCalls(stateView: string, id: string): { target: string; data: string }[] {
  const pid = id.replace(/^0x/, '');
  return [{ target: stateView, data: SEL_V4_SLOT0 + pid }, { target: stateView, data: SEL_V4_LIQ + pid }];
}
export function decodeV4State(slot0: string | null, liq: string | null): { sqrtPriceX96: bigint; liquidity: bigint } | null {
  const s = word0(slot0), l = word0(liq);
  if (s === null || l === null) return null;
  return { sqrtPriceX96: s, liquidity: l };
}

// "How much of `token` sits in this pool" for any mix of pools, in raw units.
// Ordinary pools: token.balanceOf(pool). V4 pools: virtual amount (above).
// One bundled read. null = couldn't read.
export interface SideRef { pool: string; token0: string; token: string; v4StateView?: string }
type CallMany = (calls: { target: string; data: string }[]) => Promise<(string | null)[]>;
const SEL_BALANCE = '0x70a08231';
const pad = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

export async function readSideAmounts(callMany: CallMany, items: SideRef[]): Promise<(bigint | null)[]> {
  const calls: { target: string; data: string }[] = [];
  const at: number[] = [];
  for (const it of items) {
    at.push(calls.length);
    if (it.v4StateView) calls.push(...v4StateCalls(it.v4StateView, it.pool));
    else calls.push({ target: it.token, data: SEL_BALANCE + pad(it.pool) });
  }
  const res = calls.length ? await callMany(calls) : [];
  return items.map((it, i) => {
    const k = at[i];
    if (!it.v4StateView) return word0(res[k]);
    const st = decodeV4State(res[k], res[k + 1]);
    if (!st) return null;
    const { a0, a1 } = v4VirtualAmounts(st.sqrtPriceX96, st.liquidity);
    return it.token.toLowerCase() === it.token0.toLowerCase() ? a0 : a1;
  });
}

// A PoolState for a scanned V4 pool, shaped exactly like the pair watcher's
// own V4 pools (core/poolResolver.ts resolveAllV4Pools), so the shared
// refresh (refreshPoolsBatch) and pricing (priceOf) work on it unchanged.
export function v4PoolState(p: { dex: string; pool: string; token0: string; token1: string; v4: V4Meta }): PoolState {
  return {
    chain: 'robinhood', dex: p.dex, poolAddress: p.pool, poolType: 'v3',
    tokenA: p.token0, tokenB: p.token1,
    feeBps: Math.round(p.v4.fee / 100), feePips: p.v4.fee,
    lastUpdatedBlock: 0, lastUpdatedMs: 0,
    v4: { fee: p.v4.fee, tickSpacing: p.v4.tickSpacing, native: p.v4.native, poolManager: p.v4.poolManager, stateView: p.v4.stateView },
  } as PoolState;
}

// Coin amounts added by a V4 ModifyLiquidity (for the new pool counter's
// "how much money went in"). Uniswap's standard formulas, in floats (rough
// on purpose). tickLower/tickUpper/liquidityDelta come from the event.
export function v4MintAmounts(sqrtPriceX96: bigint, tickLower: number, tickUpper: number, liquidityDelta: bigint): { a0: number; a1: number } {
  const L = Number(liquidityDelta);
  if (!(L > 0)) return { a0: 0, a1: 0 };
  const sp = Number(sqrtPriceX96) / 2 ** 96;
  const sa = Math.pow(1.0001, tickLower / 2), sb = Math.pow(1.0001, tickUpper / 2);
  if (sp <= sa) return { a0: L * (sb - sa) / (sa * sb), a1: 0 };
  if (sp >= sb) return { a0: 0, a1: L * (sb - sa) };
  return { a0: L * (sb - sp) / (sp * sb), a1: L * (sp - sa) };
}

// Decode a ModifyLiquidity log: pool id, ticks, liquidity change.
export function decodeV4ModifyLiquidity(log: { topics: readonly string[]; data: string }): { id: string; tickLower: number; tickUpper: number; liquidityDelta: bigint } | null {
  if (log.topics.length < 2 || log.topics[0].toLowerCase() !== V4_MODIFY_LIQUIDITY_TOPIC) return null;
  const hex = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
  const a = wordAt(hex, 0), b = wordAt(hex, 1), c = wordAt(hex, 2);
  if (!a || !b || !c) return null;
  try {
    return {
      id: log.topics[1].toLowerCase(),
      tickLower: Number(toSigned(BigInt('0x' + a), 256)),
      tickUpper: Number(toSigned(BigInt('0x' + b), 256)),
      liquidityDelta: toSigned(BigInt('0x' + c), 256),
    };
  } catch { return null; }
}
