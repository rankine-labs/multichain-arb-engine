import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';
import { ethers } from 'ethers';
import { ChainName, PoolState } from './types';
import { PoolCache } from './poolCache';
import { makeCaller } from './universeScan';
import {
  resolveAndFetchV2Pool, resolveAndFetchSolidlyV2Pool, resolveAllV3Pools, resolveAllV4Pools,
  refetchV2PoolPrice, refetchV3PoolPrice, refetchV4PoolPrice,
  v4PoolId, V3_FEE_TIERS_ALL, V3_TICK_SPACINGS, STANDARD_V4_FEE_TIERS,
} from './poolResolver';

// ============================================================================
// PAIR WATCHER -- automatic, traffic-driven pool discovery
//
// Plain English:
//   An arbitrage needs the SAME pair on two or more pools. When a trade shows
//   up on a pair, this finds EVERY pool for that pair on EVERY DEX and fee
//   tier on the chain, puts them in the pool cache, and keeps their prices
//   refreshed. The next big trade on that pair then has real partner pools
//   to compare against.
//
// Why automatic: the live probe showed Robinhood traffic is mostly
// short-lived memecoin pairs (114 different pairs in 2 minutes). A hand-made
// list would be stale within hours; this follows the actual traffic.
//
// Limits (so it can't overload the RPC):
//   - discovery runs ONE pair at a time from a queue; if the queue is full,
//     new pairs are skipped (if they keep trading they'll be picked up later)
//   - at most `maxPairs` pairs; the least recently traded pair is dropped
//   - each pair is re-discovered at most every `rediscoverMs`; a pair found
//     to have only ONE pool (most memecoins: nothing to arb against) is not
//     re-checked for `singlePoolRecheckMs`
//   - prices refreshed every `refreshMs` in the background (the bot ALSO
//     re-reads the exact pools it's about to use at decision time)
// ============================================================================

export interface Venue {
  dex: string;
  // 'algebra':     Algebra Integral factory, factory.poolByPair(a, b)
  // 'v4-registry': hooked V4 pools listed by a registry (Fables): `factory`
  //                is the StateView, `registry` lists the pools.
  kind: 'v2' | 'solidly' | 'v3-fee' | 'v3-spacing' | 'v4' | 'algebra' | 'v4-registry';
  factory: string;   // kind 'v4': the StateView contract (where V4 prices are read)
  feeBps?: number;   // V2-style pools: swap fee in bps
  poolManager?: string; // kind 'v4' only: where V4 trades go
  weth?: string;     // kind 'v4' only: WETH, which stands in for native ETH
  registry?: string; // kind 'v4-registry': contract with activePools()
  pairFee?: boolean; // kind 'solidly': read each pair's own fee() (in millionths)
}

export interface PairWatcherOptions {
  // Bursty pool lookups (discovery, token symbol/decimals) can use a
  // different node than the steady price refresh. Default: same node.
  discoveryProvider?: ethers.JsonRpcProvider;
  // Called after each background price re-sync (e.g. to re-check gaps).
  onRefreshed?: () => void;
  maxPairs?: number;
  rediscoverMs?: number;
  refreshMs?: number;
  maxQueue?: number;
  singlePoolRecheckMs?: number;
}

type TokenMeta = { symbol: string; decimals: number };

const ERC20_META = ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'];

// Finds every pool for (tokenA, tokenB) across all venues, in parallel.
export async function discoverPairPools(
  provider: ethers.JsonRpcProvider, chain: ChainName, venues: Venue[], tokenA: string, tokenB: string,
): Promise<PoolState[]> {
  // Venues one after another (not all at once) to keep each RPC request small.
  const results: PoolState[][] = [];
  for (const v of venues) results.push(await (async (): Promise<PoolState[]> => {
    try {
      if (v.kind === 'v2') {
        const p = await resolveAndFetchV2Pool(provider, chain, v.dex, v.factory, tokenA, tokenB, v.feeBps ?? 30);
        return p ? [p] : [];
      }
      if (v.kind === 'solidly') {
        // Volatile pairs only: Solidly "stable" pairs use a different curve
        // that the bot's x*y=k maths can't price.
        const vol = await resolveAndFetchSolidlyV2Pool(provider, chain, v.dex, v.factory, tokenA, tokenB, false, v.feeBps ?? 20);
        return vol ? [vol] : [];
      }
      if (v.kind === 'v4') {
        if (!v.poolManager || !v.weth) return [];
        return await resolveAllV4Pools(provider, chain, v.dex, v.factory, v.poolManager, tokenA, tokenB, v.weth);
      }
      return await resolveAllV3Pools(provider, chain, v.dex, v.factory, tokenA, tokenB, v.kind === 'v3-fee' ? 'fee' : 'spacing');
    } catch {
      return [];
    }
  })());
  return results.flat();
}

// ============================================================================
// MULTICALL POOL DISCOVERY (Oct 2026)
//
// Same result as discoverPairPools(), but in 2 bundled requests instead of
// 10-25 separate ones:
//   round 1: every factory lookup (V2 getPair, Solidly getPair, V3 getPool
//            per fee tier / tick spacing), every V4 pool's liquidity +
//            price (pool ids are computed locally), and token
//            symbol/decimals when asked for
//   round 2: price state of the V2 / V3 pools round 1 found
// Fewer requests = fewer credits used and no bursts that get us
// rate-limited. A rate limit / network error is THROWN (callMany throws),
// so the caller retries later instead of reading "no pools".
// ============================================================================
type CallManyFn = (calls: { target: string; data: string }[]) => Promise<(string | null)[]>;
const iV2F = new ethers.Interface(['function getPair(address,address) view returns (address)']);
const iSolF = new ethers.Interface(['function getPair(address,address,bool) view returns (address)']);
const iV3F = new ethers.Interface(['function getPool(address,address,uint24) view returns (address)']);
const iV3S = new ethers.Interface(['function getPool(address,address,int24) view returns (address)']);
const iPair = new ethers.Interface([
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)', 'function token1() view returns (address)',
]);
const iV3P = new ethers.Interface([
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
  'function liquidity() view returns (uint128)', 'function fee() view returns (uint24)',
  'function token0() view returns (address)', 'function token1() view returns (address)',
]);
const iSV = new ethers.Interface([
  'function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)',
  'function getLiquidity(bytes32) view returns (uint128)',
]);
// Algebra Integral (Alandale): pool lookup and price state.
const iAlgF = new ethers.Interface(['function poolByPair(address,address) view returns (address)']);
const iAlgP = new ethers.Interface(['function globalState() view returns (uint160,int24,uint16,uint8,uint16,bool)']);
// Solidly pairs with their own fee (GIGA Classic): fee() in millionths.
const iPairFee = new ethers.Interface(['function fee() view returns (uint256)']);
// Hooked V4 pool registry (Fables): every live pool's key and id.
const iReg = new ethers.Interface(['function activePools() view returns (tuple(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bytes32 id, bool active)[])']);
const iMeta = new ethers.Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
const iMeta32 = new ethers.Interface(['function symbol() view returns (bytes32)']);

const word = (hex: string | null, i = 0): bigint | null =>
  hex && hex.length >= 2 + 64 * (i + 1) ? BigInt('0x' + hex.slice(2 + 64 * i, 2 + 64 * (i + 1))) : null;
const addrOf = (hex: string | null): string | null => {
  const w = word(hex);
  if (w === null || w === 0n) return null;
  return ethers.getAddress('0x' + w.toString(16).padStart(40, '0').slice(-40));
};
// symbol() can be a string or (older tokens) bytes32.
function decodeSymbol(hex: string | null): string | null {
  if (!hex) return null;
  try { return String(iMeta.decodeFunctionResult('symbol', hex)[0]); } catch { /* try bytes32 */ }
  try { return ethers.decodeBytes32String(String(iMeta32.decodeFunctionResult('symbol', hex)[0])); } catch { return null; }
}

export type MetaResult = { symbol: string; decimals: number } | 'not-a-token';

export async function discoverPairPoolsMulticall(
  callMany: CallManyFn, chain: ChainName, venues: Venue[], tokenA: string, tokenB: string,
  metaFor: string[] = [],
): Promise<{ pools: PoolState[]; meta: Record<string, MetaResult> }> {
  type Pending = { venue: Venue; kind: 'v2' | 'solidly' | 'v3' | 'algebra'; feeKey?: number; spacing?: boolean; idx: number }
    | { venue: Venue; kind: 'v4-registry'; idx: number }
    | { venue: Venue; kind: 'v4'; id: string; fee: number; tickSpacing: number; native: boolean; c0: string; c1: string; liqIdx: number; slotIdx: number };
  const calls: { target: string; data: string }[] = [];
  const pend: Pending[] = [];
  const push = (target: string, data: string) => { calls.push({ target, data }); return calls.length - 1; };

  for (const v of venues) {
    if (v.kind === 'v2') pend.push({ venue: v, kind: 'v2', idx: push(v.factory, iV2F.encodeFunctionData('getPair', [tokenA, tokenB])) });
    else if (v.kind === 'solidly') pend.push({ venue: v, kind: 'solidly', idx: push(v.factory, iSolF.encodeFunctionData('getPair', [tokenA, tokenB, false])) });
    else if (v.kind === 'v3-fee') for (const f of V3_FEE_TIERS_ALL) pend.push({ venue: v, kind: 'v3', feeKey: f, idx: push(v.factory, iV3F.encodeFunctionData('getPool', [tokenA, tokenB, f])) });
    else if (v.kind === 'v3-spacing') for (const sp of V3_TICK_SPACINGS) pend.push({ venue: v, kind: 'v3', feeKey: sp, spacing: true, idx: push(v.factory, iV3S.encodeFunctionData('getPool', [tokenA, tokenB, sp])) });
    else if (v.kind === 'algebra') pend.push({ venue: v, kind: 'algebra', idx: push(v.factory, iAlgF.encodeFunctionData('poolByPair', [tokenA, tokenB])) });
    else if (v.kind === 'v4-registry' && v.registry && v.poolManager && v.weth) pend.push({ venue: v, kind: 'v4-registry', idx: push(v.registry, iReg.encodeFunctionData('activePools')) });
    else if (v.kind === 'v4' && v.poolManager && v.weth) {
      const a = tokenA.toLowerCase(), b = tokenB.toLowerCase(), w = v.weth.toLowerCase();
      const variants: { c0: string; c1: string; native: boolean }[] = [a < b ? { c0: tokenA, c1: tokenB, native: false } : { c0: tokenB, c1: tokenA, native: false }];
      if (a === w || b === w) variants.push({ c0: ethers.ZeroAddress, c1: a === w ? tokenB : tokenA, native: true });
      for (const vr of variants) for (const [fee, tickSpacing] of STANDARD_V4_FEE_TIERS) {
        const id = v4PoolId(vr.c0, vr.c1, fee, tickSpacing);
        pend.push({ venue: v, kind: 'v4', id, fee, tickSpacing, native: vr.native, c0: vr.c0, c1: vr.c1,
          liqIdx: push(v.factory, iSV.encodeFunctionData('getLiquidity', [id])), slotIdx: push(v.factory, iSV.encodeFunctionData('getSlot0', [id])) });
      }
    }
  }
  const metaIdx: Record<string, { sym: number; dec: number }> = {};
  for (const t of metaFor) metaIdx[t.toLowerCase()] = { sym: push(t, iMeta.encodeFunctionData('symbol')), dec: push(t, iMeta.encodeFunctionData('decimals')) };

  const r1 = await callMany(calls); // throws on rate limit / network

  const meta: Record<string, MetaResult> = {};
  for (const [t, ix] of Object.entries(metaIdx)) {
    const dec = word(r1[ix.dec]);
    const sym = decodeSymbol(r1[ix.sym]);
    meta[t] = dec === null || dec > 255n ? 'not-a-token' : { symbol: sym ?? t.slice(0, 8), decimals: Number(dec) };
  }

  const now = Date.now();
  const pools: PoolState[] = [];
  // Round 2: state of the V2 / Solidly / V3 pools that exist.
  const found: { p: Pending & { kind: 'v2' | 'solidly' | 'v3' | 'algebra' }; addr: string; base: number }[] = [];
  const calls2: { target: string; data: string }[] = [];
  // Hooked V4 pools (registry) matching this pair: their state is read in round 2.
  const hooked: { venue: Venue; id: string; fee: number; tickSpacing: number; native: boolean; c1: string; c0: string; hooks: string; base: number }[] = [];
  for (const p of pend) {
    if (p.kind === 'v4-registry') {
      const v = p.venue;
      let list: any[] = [];
      try { list = r1[p.idx] ? (iReg.decodeFunctionResult('activePools', r1[p.idx]!)[0] as any[]) : []; } catch { list = []; }
      const a = tokenA.toLowerCase(), b = tokenB.toLowerCase(), w = v.weth!.toLowerCase();
      for (const e of list) {
        if (!e.active) continue;
        const c0 = String(e.key.currency0).toLowerCase(), c1 = String(e.key.currency1).toLowerCase();
        const native = c0 === ethers.ZeroAddress;
        const x0 = native ? w : c0;
        if (!((x0 === a && c1 === b) || (x0 === b && c1 === a))) continue;
        const base = calls2.length;
        calls2.push({ target: v.factory, data: iSV.encodeFunctionData('getSlot0', [e.id]) }, { target: v.factory, data: iSV.encodeFunctionData('getLiquidity', [e.id]) });
        hooked.push({ venue: v, id: String(e.id), fee: Number(e.key.fee), tickSpacing: Number(e.key.tickSpacing), native, c0, c1, hooks: String(e.key.hooks), base });
      }
      continue;
    }
    if (p.kind === 'v4') {
      const liq = word(r1[p.liqIdx]);
      const sqrt = word(r1[p.slotIdx]);
      if (!liq || !sqrt) continue; // no pool / no liquidity
      pools.push({
        chain, dex: p.venue.dex, poolAddress: p.id, poolType: 'v3',
        tokenA: p.native ? p.venue.weth! : p.c0, tokenB: p.c1,
        sqrtPriceX96: sqrt, liquidity: liq, feeBps: Math.round(p.fee / 100), feePips: Number(p.fee),
        lastUpdatedBlock: 0, lastUpdatedMs: now,
        v4: { fee: p.fee, tickSpacing: p.tickSpacing, native: p.native, poolManager: ethers.getAddress(p.venue.poolManager!.toLowerCase()), stateView: ethers.getAddress(p.venue.factory.toLowerCase()) },
      });
      continue;
    }
    const addr = addrOf(r1[p.idx]);
    if (!addr) continue;
    const base = calls2.length;
    if (p.kind === 'v3') {
      calls2.push({ target: addr, data: iV3P.encodeFunctionData('slot0') }, { target: addr, data: iV3P.encodeFunctionData('liquidity') },
        { target: addr, data: iV3P.encodeFunctionData('token0') }, { target: addr, data: iV3P.encodeFunctionData('token1') });
      if (p.spacing) calls2.push({ target: addr, data: iV3P.encodeFunctionData('fee') });
    } else if (p.kind === 'algebra') {
      // globalState word 0 = sqrt price, word 2 = the fee right now (pips).
      calls2.push({ target: addr, data: iAlgP.encodeFunctionData('globalState') }, { target: addr, data: iV3P.encodeFunctionData('liquidity') },
        { target: addr, data: iV3P.encodeFunctionData('token0') }, { target: addr, data: iV3P.encodeFunctionData('token1') });
    } else {
      calls2.push({ target: addr, data: iPair.encodeFunctionData('getReserves') }, { target: addr, data: iPair.encodeFunctionData('token0') },
        { target: addr, data: iPair.encodeFunctionData('token1') });
      if (p.kind === 'solidly' && p.venue.pairFee) calls2.push({ target: addr, data: iPairFee.encodeFunctionData('fee') });
    }
    found.push({ p: p as Pending & { kind: 'v2' | 'solidly' | 'v3' | 'algebra' }, addr, base });
  }
  const r2 = calls2.length ? await callMany(calls2) : [];
  for (const h of hooked) {
    const sqrt = word(r2[h.base], 0), lpFee = word(r2[h.base], 3), liq = word(r2[h.base + 1]);
    if (!sqrt || !liq || lpFee === null) continue;
    pools.push({
      chain, dex: h.venue.dex, poolAddress: h.id, poolType: 'v3',
      tokenA: h.native ? ethers.getAddress(h.venue.weth!.toLowerCase()) : ethers.getAddress(h.c0), tokenB: ethers.getAddress(h.c1),
      sqrtPriceX96: sqrt, liquidity: liq, feeBps: Math.round(Number(lpFee) / 100), feePips: Number(lpFee),
      lastUpdatedBlock: 0, lastUpdatedMs: now,
      v4: { fee: h.fee, tickSpacing: h.tickSpacing, native: h.native, poolManager: ethers.getAddress(h.venue.poolManager!.toLowerCase()), stateView: ethers.getAddress(h.venue.factory.toLowerCase()), hooks: h.hooks },
    });
  }
  for (const { p, addr, base } of found) {
    if (p.kind === 'algebra') {
      const sqrt = word(r2[base], 0), fee = word(r2[base], 2), liq = word(r2[base + 1]), t0 = addrOf(r2[base + 2]), t1 = addrOf(r2[base + 3]);
      if (!sqrt || !liq || !t0 || !t1 || fee === null) continue;
      pools.push({ chain, dex: p.venue.dex, poolAddress: addr, poolType: 'v3', variant: 'algebra', tokenA: t0, tokenB: t1,
        sqrtPriceX96: sqrt, liquidity: liq, feeBps: Math.round(Number(fee) / 100), feePips: Number(fee), lastUpdatedBlock: 0, lastUpdatedMs: now });
      continue;
    }
    if (p.kind === 'v3') {
      const sqrt = word(r2[base]), liq = word(r2[base + 1]), t0 = addrOf(r2[base + 2]), t1 = addrOf(r2[base + 3]);
      const fee = p.spacing ? word(r2[base + 4]) : BigInt(p.feeKey!);
      if (!sqrt || !liq || !t0 || !t1 || fee === null) continue; // unreadable or no liquidity (same as before)
      pools.push({ chain, dex: p.venue.dex, poolAddress: addr, poolType: 'v3', tokenA: t0, tokenB: t1,
        sqrtPriceX96: sqrt, liquidity: liq, feeBps: Math.round(Number(fee) / 100), feePips: Number(fee), lastUpdatedBlock: 0, lastUpdatedMs: now });
    } else {
      const r0 = word(r2[base], 0), rr1 = word(r2[base], 1), t0 = addrOf(r2[base + 1]), t1 = addrOf(r2[base + 2]);
      if (r0 === null || rr1 === null || !t0 || !t1) continue;
      // Per-pair fee (GIGA Classic): fee() in millionths = pips.
      const pf = p.kind === 'solidly' && p.venue.pairFee ? word(r2[base + 3]) : null;
      const feeFields = pf !== null && pf < 100_000n ? { feeBps: Math.round(Number(pf) / 100), feePips: Number(pf) } : { feeBps: p.venue.feeBps ?? (p.kind === 'solidly' ? 20 : 30) };
      if (p.kind === 'solidly' && p.venue.pairFee && pf === null) continue; // fee unknown: don't guess
      pools.push({ chain, dex: p.venue.dex, poolAddress: addr, poolType: 'v2', tokenA: t0, tokenB: t1,
        reserveA: r0, reserveB: rr1, ...feeFields, lastUpdatedBlock: 0, lastUpdatedMs: now });
    }
  }
  return { pools, meta };
}

// Re-reads MANY pools' live state in one go through Multicall3 (one RPC
// request for ~100 pools instead of ~150 separate ones). V3: slot0() +
// liquidity(); V2/Solidly: getReserves(). Only the first return words are
// read, which are the same across Uniswap, PancakeSwap and Ramses.
const SEL_SLOT0 = '0x3850c7bd', SEL_LIQ = '0x1a686502', SEL_RESERVES = '0x0902f1ac';
// Algebra Integral: price + current dynamic fee live in globalState().
const SEL_ALG_STATE = ethers.id('globalState()').slice(0, 10);
// V4: same two reads, but asked of the StateView contract with the pool id.
const SEL_V4_SLOT0 = ethers.id('getSlot0(bytes32)').slice(0, 10);
const SEL_V4_LIQ = ethers.id('getLiquidity(bytes32)').slice(0, 10);
export async function refreshPoolsBatch(
  callMany: (calls: { target: string; data: string }[]) => Promise<(string | null)[]>,
  pools: PoolState[],
): Promise<PoolState[]> {
  const calls: { target: string; data: string }[] = [];
  const idx: number[] = []; // start index of each pool's calls
  for (const p of pools) {
    idx.push(calls.length);
    if (p.v4) calls.push({ target: p.v4.stateView, data: SEL_V4_SLOT0 + p.poolAddress.slice(2) }, { target: p.v4.stateView, data: SEL_V4_LIQ + p.poolAddress.slice(2) });
    else if (p.poolType === 'v3' && p.variant === 'algebra') calls.push({ target: p.poolAddress, data: SEL_ALG_STATE }, { target: p.poolAddress, data: SEL_LIQ });
    else if (p.poolType === 'v3') calls.push({ target: p.poolAddress, data: SEL_SLOT0 }, { target: p.poolAddress, data: SEL_LIQ });
    else if (p.poolType === 'v2') calls.push({ target: p.poolAddress, data: SEL_RESERVES });
  }
  const res = await callMany(calls);
  const word = (r: string | null, i: number) => (r && r.length >= 2 + 64 * (i + 1) ? BigInt('0x' + r.slice(2 + 64 * i, 2 + 64 * (i + 1))) : null);
  const now = Date.now();
  const out: PoolState[] = [];
  pools.forEach((p, k) => {
    const i = idx[k];
    if (p.poolType === 'v3') {
      const sqrt = word(res[i], 0), liq = word(res[i + 1], 0);
      // liq may legitimately be 0 (liquidity pulled): store it so the old
      // price is not kept. sqrt 0 / missing = unreadable, skip.
      // Dynamic-fee pools: keep the fee current too (Algebra: globalState
      // word 2; hooked V4: getSlot0 word 3 = the pool's LP fee now).
      const dyn = p.variant === 'algebra' ? word(res[i], 2) : p.v4?.hooks ? word(res[i], 3) : null;
      const fee = dyn !== null && dyn < 1_000_000n ? { feePips: Number(dyn), feeBps: Math.round(Number(dyn) / 100) } : {};
      if (sqrt && liq !== null) out.push({ ...p, ...fee, sqrtPriceX96: sqrt, liquidity: liq, lastUpdatedMs: now });
    } else if (p.poolType === 'v2') {
      const r0 = word(res[i], 0), r1 = word(res[i], 1);
      if (r0 !== null && r1 !== null) out.push({ ...p, reserveA: r0, reserveB: r1, lastUpdatedMs: now });
    }
  });
  return out;
}

// Re-reads one pool's live price state. Returns null if it couldn't.
export async function refreshPoolState(provider: ethers.JsonRpcProvider, pool: PoolState): Promise<PoolState | null> {
  if (pool.v4) return refetchV4PoolPrice(provider, pool);
  if (pool.poolType === 'v3' && pool.variant === 'algebra') {
    // Algebra: one batched read through the same code as the 5 s re-sync.
    const callOne = async (calls: { target: string; data: string }[]) =>
      Promise.all(calls.map((c) => provider.call({ to: c.target, data: c.data }).catch(() => null)));
    return (await refreshPoolsBatch(callOne, [pool]))[0] ?? null;
  }
  if (pool.poolType === 'v3') return refetchV3PoolPrice(provider, pool);
  if (pool.poolType === 'v2') return refetchV2PoolPrice(provider, pool);
  return null; // orderbook / bins: not refreshed here
}

export class PairWatcher {
  private pairs = new Map<string, { tokenA: string; tokenB: string; pools: string[]; discoveredAt: number; lastSeen: number }>();
  // Pairs found by the chain-wide scan (or always-watched like WETH/USDG):
  // never dropped to make room for traffic-driven pairs.
  private pinned = new Set<string>();
  private pinnedTokens = new Map<string, { a: string; b: string }>(); // for retrying
  private retryTimer: NodeJS.Timeout | null = null;
  private inFlight = new Set<string>();           // queued or running
  private queue: Array<{ a: string; b: string }> = [];
  private working = false;
  private singlePool = new Map<string, number>();  // pair -> when it was found to have one pool
  private readonly maxQueue: number;
  private readonly singlePoolRecheckMs: number;
  // Token symbol/decimals. Successes are kept for good; a token that is
  // definitely not a standard ERC-20 (call reverted / bad data) is skipped
  // for an hour. Network errors and rate limits are NOT remembered, so one
  // 429 at startup can't blacklist WETH/USDG for the life of the process.
  private tokenMeta = new Map<string, TokenMeta>();
  private discoveryCallMany: CallManyFn | null = null;
  private badToken = new Map<string, number>(); // token -> when it failed
  private readonly maxPairs: number;
  private readonly rediscoverMs: number;
  private readonly refreshMs: number;
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly discoveryProvider: ethers.JsonRpcProvider;
  private readonly onRefreshed?: () => void;

  constructor(
    private readonly chain: ChainName,
    private readonly provider: ethers.JsonRpcProvider,
    private readonly venues: Venue[],
    private readonly cache: PoolCache,
    // Called once per new token with its real on-chain symbol/decimals, so
    // pricing and trade sizing never guess decimals for a discovered token.
    private readonly onToken: (address: string, meta: TokenMeta) => void,
    opts: PairWatcherOptions = {},
  ) {
    this.discoveryProvider = opts.discoveryProvider ?? provider;
    this.onRefreshed = opts.onRefreshed;
    this.maxPairs = opts.maxPairs ?? 40;
    this.rediscoverMs = opts.rediscoverMs ?? 10 * 60_000;
    this.refreshMs = opts.refreshMs ?? 30_000;
    this.maxQueue = opts.maxQueue ?? 20;
    // 15 min (was 1 h): a rate-limited read during discovery looks like a
    // missing pool, so a real 2-pool pair could be ignored for an hour.
    this.singlePoolRecheckMs = opts.singlePoolRecheckMs ?? 15 * 60_000;
  }

  private key(a: string, b: string) {
    return [a.toLowerCase(), b.toLowerCase()].sort().join('/');
  }

  // Note a trade on (a, b). Starts discovery if the pair is new or stale.
  // Never throws, never blocks the caller.
  touch(a: string, b: string): void {
    const k = this.key(a, b);
    const now = Date.now();
    const entry = this.pairs.get(k);
    if (entry) entry.lastSeen = now;
    if (this.inFlight.has(k)) return;
    if (entry && now - entry.discoveredAt < this.rediscoverMs) return;
    const single = this.singlePool.get(k);
    if (single !== undefined && now - single < this.singlePoolRecheckMs) return;
    if (this.queue.length >= this.maxQueue) return; // busy: skip, it'll come back if it keeps trading
    this.inFlight.add(k);
    this.queue.push({ a, b });
    void this.drain();
  }

  // Works through the queue one pair at a time.
  private async drain(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length) {
        const { a, b } = this.queue.shift()!;
        try {
          await this.discover(a, b);
        } catch (err) {
          console.warn(`[pairs] ${this.chain} discovery failed:`, (err as Error).message);
        } finally {
          this.inFlight.delete(this.key(a, b));
        }
      }
    } finally {
      this.working = false;
    }
  }

  // Awaitable version, used at startup for pairs we always want.
  // pin = keep this pair even when traffic-driven pairs fill the list.
  async watch(a: string, b: string, opts: { pin?: boolean } = {}): Promise<number> {
    if (opts.pin) { this.pinned.add(this.key(a, b)); this.pinnedTokens.set(this.key(a, b), { a, b }); }
    // Already watched and recently checked (e.g. restored from the last run): no lookup needed.
    const known = this.pairs.get(this.key(a, b));
    if (!known || Date.now() - known.discoveredAt >= this.rediscoverMs) await this.discover(a, b);
    return this.pairs.get(this.key(a, b))?.pools.length ?? 0;
  }

  private async discover(a: string, b: string): Promise<void> {
    const k = this.key(a, b);
    // Exact decimals are needed (a pool on a token with unknown decimals is
    // never used). Unknown tokens' symbol/decimals ride along in the same
    // bundled request as the pool lookups.
    const now0 = Date.now();
    for (const t of [a, b]) {
      const failedAt = this.badToken.get(t.toLowerCase());
      if (failedAt !== undefined && now0 - failedAt < 60 * 60_000) return; // known non-token, skip for now
    }
    const metaFor = [a, b].filter((t) => !this.tokenMeta.has(t.toLowerCase()));
    this.discoveryCallMany ??= (await makeCaller(this.discoveryProvider)).callMany;
    const { pools, meta: gotMeta } = await discoverPairPoolsMulticall(this.discoveryCallMany, this.chain, this.venues, a, b, metaFor);
    for (const [t, m] of Object.entries(gotMeta)) {
      if (m === 'not-a-token') { this.badToken.set(t, Date.now()); if (this.badToken.size > 5_000) this.badToken.clear(); continue; }
      this.tokenMeta.set(t, m);
      this.onToken(t, m);
    }
    const ma = this.tokenMeta.get(a.toLowerCase()), mb = this.tokenMeta.get(b.toLowerCase());
    if (!ma || !mb) return;
    for (const p of pools) this.cache.upsert(p);
    // One pool = nothing to arb against: remember that, don't track the pair.
    if (pools.length < 2) {
      this.singlePool.set(k, Date.now());
      if (this.singlePool.size > 5_000) this.singlePool.clear(); // bound memory
      return;
    }
    const now = Date.now();
    const prev = this.pairs.get(k);
    this.pairs.set(k, { tokenA: a, tokenB: b, pools: pools.map((p) => p.poolAddress), discoveredAt: now, lastSeen: prev?.lastSeen ?? now });
    if (!prev) {
      console.log(`[pairs] ${this.chain} watching ${ma.symbol}/${mb.symbol}: ${pools.length} pools (${pools.map((p) => `${p.dex}${p.poolType === 'v3' ? ` ${p.feeBps / 100}%` : ''}${p.v4?.native ? ' ETH' : ''}`).join(', ')})`);
    }
    this.evictIfNeeded();
  }

  // Symbol + decimals straight from the token contract (null = unreadable now).
  private async meta(token: string): Promise<TokenMeta | null> {
    const t = token.toLowerCase();
    const known = this.tokenMeta.get(t);
    if (known) return known;
    const failedAt = this.badToken.get(t);
    if (failedAt !== undefined && Date.now() - failedAt < 60 * 60_000) return null;
    try {
      const c = new ethers.Contract(token, ERC20_META, this.discoveryProvider);
      const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
      const m = { symbol: String(symbol), decimals: Number(decimals) };
      this.tokenMeta.set(t, m);
      this.badToken.delete(t);
      this.onToken(t, m);
      return m;
    } catch (err) {
      // Only a definite answer ("this contract can't do that") is remembered.
      const code = (err as { code?: string }).code;
      if (code === 'CALL_EXCEPTION' || code === 'BAD_DATA') {
        this.badToken.set(t, Date.now());
        if (this.badToken.size > 5_000) this.badToken.clear(); // bound memory
      }
      return null;
    }
  }

  private evictIfNeeded() {
    while (this.pairs.size > this.maxPairs) {
      let oldestKey: string | null = null, oldest = Infinity;
      for (const [k, v] of this.pairs) {
        if (this.pinned.has(k)) continue; // pinned pairs are never dropped
        if (v.lastSeen < oldest) { oldest = v.lastSeen; oldestKey = k; }
      }
      if (!oldestKey) break;
      this.pairs.delete(oldestKey); // stops refreshing; decision-time refresh still covers any use
    }
  }

  // Background price refresh for every watched pool.
  start(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => { this.refreshAll().catch(() => { /* best effort */ }); }, this.refreshMs);
    // Pinned pairs (from the scan / start list) are known to have 2+ pools.
    // If discovery found fewer (usually a rate-limited lookup, which looks
    // like "no pool"), try again every 15 min instead of never.
    this.retryTimer = setInterval(() => { this.retryPinned(); }, this.pinnedRetryMs);
  }

  private readonly pinnedRetryMs = Number(process.env.PINNED_RETRY_MS ?? 15 * 60_000);

  // Queue discovery for pinned pairs that aren't watched yet. Returns how many.
  retryPinned(): number {
    let n = 0;
    for (const [k, t] of this.pinnedTokens) {
      if (this.pairs.has(k) || this.inFlight.has(k)) continue;
      this.singlePool.delete(k); // allow it through
      this.inFlight.add(k);
      this.queue.push(t);
      n++;
    }
    if (n) void this.drain();
    return n;
  }

  // Background re-sync of every watched pool from the chain. With instant
  // price tracking (prices updated from the trade feed), this is the safety
  // net that corrects drift from trades the bot can't decode. One Multicall3
  // request per round; falls back to single calls if Multicall3 is missing.
  private callMany: ((calls: { target: string; data: string }[]) => Promise<(string | null)[]>) | null = null;
  private refreshing = false;
  lastRefreshMs = 0;
  async refreshAll(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const pools = [...this.pairs.values()].flatMap((p) => p.pools)
        .map((a) => this.cache.get(this.chain, a)).filter((p): p is PoolState => !!p);
      if (!pools.length) return;
      this.callMany ??= (await makeCaller(this.provider)).callMany;
      // Read started now: anything the trade feed wrote after this moment is
      // newer than (or at best equal to) what the RPC returns, so keep it.
      const readStartedMs = Date.now();
      for (const fresh of await refreshPoolsBatch(this.callMany, pools)) this.cache.upsertIfNotNewer(fresh, readStartedMs);
      this.lastRefreshMs = Date.now();
      try { this.onRefreshed?.(); } catch { /* a listener error must not break refreshing */ }
    } finally {
      this.refreshing = false;
    }
  }

  // ---- Remember the watch list across restarts ---------------------------
  // Saved: watched pairs, their pools' last state, pinned pairs and token
  // symbol/decimals. Loaded at startup, so a restart doesn't re-discover
  // 20-60 pairs at once (a burst of requests every deploy). Pairs are still
  // re-checked later on the normal schedule.
  save(file: string) {
    try {
      const pools: PoolState[] = [];
      for (const p of this.pairs.values()) for (const a of p.pools) { const st = this.cache.get(this.chain, a); if (st) pools.push(st); }
      const data = {
        version: 1, chain: this.chain, savedAt: Date.now(),
        pairs: [...this.pairs.values()].map((p) => ({ a: p.tokenA, b: p.tokenB, pools: p.pools })),
        pinned: [...this.pinnedTokens.values()],
        meta: Object.fromEntries(this.tokenMeta),
        pools,
      };
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file + '.tmp', JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? { $b: v.toString() } : v)));
      renameSync(file + '.tmp', file);
    } catch { /* best effort */ }
  }

  // Returns how many pairs were restored.
  load(file: string, maxAgeMs = 24 * 3600_000): number {
    try {
      const d = JSON.parse(readFileSync(file, 'utf8'), (_k, v) => (v && typeof v === 'object' && typeof v.$b === 'string' ? BigInt(v.$b) : v));
      if (d?.version !== 1 || d.chain !== this.chain || Date.now() - d.savedAt > maxAgeMs) return 0;
      for (const [t, m] of Object.entries(d.meta ?? {})) { this.tokenMeta.set(t, m as TokenMeta); this.onToken(t, m as TokenMeta); }
      for (const p of d.pools ?? []) this.cache.upsert({ ...p, lastUpdatedMs: 0 }); // refreshed on the next re-sync
      const now = Date.now();
      for (const p of d.pairs ?? []) this.pairs.set(this.key(p.a, p.b), { tokenA: p.a, tokenB: p.b, pools: p.pools, discoveredAt: now, lastSeen: now });
      for (const t of d.pinned ?? []) { const k = this.key(t.a, t.b); this.pinned.add(k); this.pinnedTokens.set(k, t); }
      return this.pairs.size;
    } catch { return 0; }
  }

  // Pool addresses per watched pair (for the standing-gap scanner).
  watchedPairPools(): string[][] { return [...this.pairs.values()].map((p) => p.pools); }

  stats() {
    let pools = 0;
    for (const p of this.pairs.values()) pools += p.pools.length;
    let pinnedWatched = 0;
    for (const k of this.pinned) if (this.pairs.has(k)) pinnedWatched++;
    return { pairs: this.pairs.size, pools, pinned: this.pinned.size, pinnedWatched, queued: this.queue.length, singlePoolPairs: this.singlePool.size };
  }
}
