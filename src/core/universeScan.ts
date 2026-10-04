import { ethers } from 'ethers';

// ============================================================================
// UNIVERSE SCAN -- find EVERY pair that exists on 2+ pools, chain-wide
//
// Plain English:
//   The pair watcher only learns about a pair after someone trades it. A pair
//   that sits on two DEXes but trades rarely stays invisible. This scan asks
//   every DEX factory for its FULL list of pools instead:
//     - V2-style factories (Uniswap V2, PancakeSwap V2, Ramses V2/Solidly)
//       keep a numbered list: allPairsLength() + allPairs(i)
//     - V3-style factories (Uniswap V3, PancakeSwap V3, Ramses V3) have no
//       list, so we read their PoolCreated event history
//   Then it reads how much money sits in each pool (token balances), groups
//   pools by token pair, and keeps pairs with 2+ pools that each hold at
//   least `minPoolUsd`. Ranked by the SECOND-deepest pool, because an arb is
//   capped by the shallower side.
//
// Cost control: reads go through Multicall3 (hundreds of reads per request)
// when the chain has it; otherwise small batches of single calls.
// ============================================================================

export interface ScanFactory {
  dex: string;
  kind: 'v2' | 'solidly' | 'v3';
  factory: string;
}

export interface ScannedPool {
  dex: string;
  kind: 'v2' | 'solidly' | 'v3';
  pool: string;
  token0: string;
  token1: string;
  stable?: boolean;   // Solidly stable-curve pool (the bot can't price these)
  bal0?: bigint;
  bal1?: bigint;
  usd?: number;       // estimated money in the pool (0 = couldn't price)
}

export interface PairCandidate {
  tokenA: string;
  tokenB: string;
  pools: ScannedPool[];   // liquid, priceable pools only, deepest first
  secondUsd: number;      // money in the 2nd-deepest pool (ranking key)
  dexes: string[];        // distinct DEX names among those pools
}

export interface TokenInfo { symbol: string; decimals: number }

export interface ScanResult {
  poolsPerDex: Record<string, number>;
  totalPools: number;
  multiPoolPairs: number;          // pairs on 2+ pools, before the liquidity filter
  candidates: PairCandidate[];     // pairs on 2+ LIQUID pools, ranked
  tokens: Map<string, TokenInfo>;
  usdPrice: Map<string, number>;
  usedMulticall: boolean;
  errors: string[];
}

export interface ScanOptions {
  usdToken: string;          // a $1 stablecoin (Robinhood: USDG)
  wrappedNative: string;     // WETH; priced from its deepest pool vs usdToken
  minPoolUsd?: number;       // default 2,000
  log?: (msg: string) => void;
}

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const mc3 = new ethers.Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
]);
const v2f = new ethers.Interface([
  'function allPairsLength() view returns (uint256)',
  'function allPairs(uint256) view returns (address)',
]);
const pairI = new ethers.Interface([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function stable() view returns (bool)',
]);
const erc20 = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

type Call = { target: string; data: string };
type CallMany = (calls: Call[]) => Promise<(string | null)[]>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------------------
// Batched reads. Returns raw return data per call (null = call failed).
// ----------------------------------------------------------------------------
export async function makeCaller(provider: ethers.JsonRpcProvider): Promise<{ callMany: CallMany; multicall: boolean }> {
  let multicall = false;
  try { multicall = (await provider.getCode(MULTICALL3)).length > 2; } catch { /* treat as absent */ }

  // One eth_call with up to 2 attempts (transient RPC errors are common on public nodes).
  const rawCall = async (c: Call): Promise<string | null> => {
    for (let i = 0; i < 2; i++) {
      try { return await provider.call({ to: c.target, data: c.data }); }
      catch (err) {
        // A real revert won't fix itself on retry.
        if ((err as any)?.code === 'CALL_EXCEPTION') return null;
        await sleep(300);
      }
    }
    return null;
  };

  if (multicall) {
    const CHUNK = 150;
    const callMany: CallMany = async (calls) => {
      const out: (string | null)[] = new Array(calls.length).fill(null);
      for (let i = 0; i < calls.length; i += CHUNK) {
        const slice = calls.slice(i, i + CHUNK);
        const data = mc3.encodeFunctionData('aggregate3', [slice.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))]);
        const ret = await rawCall({ target: MULTICALL3, data });
        if (!ret) {
          // Whole batch failed (e.g. response too big): fall back to single calls for this chunk.
          for (let j = 0; j < slice.length; j++) out[i + j] = await rawCall(slice[j]);
          continue;
        }
        const [results] = mc3.decodeFunctionResult('aggregate3', ret);
        results.forEach((r: any, j: number) => { out[i + j] = r.success && r.returnData !== '0x' ? r.returnData : null; });
      }
      return out;
    };
    return { callMany, multicall };
  }

  // No Multicall3: 6 calls at a time.
  const callMany: CallMany = async (calls) => {
    const out: (string | null)[] = new Array(calls.length).fill(null);
    for (let i = 0; i < calls.length; i += 6) {
      const res = await Promise.all(calls.slice(i, i + 6).map(rawCall));
      res.forEach((r, j) => { out[i + j] = r; });
    }
    return out;
  };
  return { callMany, multicall };
}

const decodeAddr = (ret: string | null): string | null => {
  if (!ret || ret.length < 66) return null;
  try { return ethers.getAddress('0x' + ret.slice(26, 66)); } catch { return null; }
};
const decodeUint = (ret: string | null): bigint | null => {
  if (!ret || ret.length < 66) return null;
  try { return BigInt(ret.slice(0, 66)); } catch { return null; }
};

// ----------------------------------------------------------------------------
// V2 / Solidly: walk allPairs(0..n-1), then read token0/token1 (and stable()).
// ----------------------------------------------------------------------------
export async function listV2Pools(provider: ethers.JsonRpcProvider, callMany: CallMany, f: ScanFactory, maxPairs = 20_000): Promise<ScannedPool[]> {
  const lenRaw = await provider.call({ to: f.factory, data: v2f.encodeFunctionData('allPairsLength') });
  const n = Math.min(Number(decodeUint(lenRaw) ?? 0n), maxPairs);
  if (n === 0) return [];

  const addrs = (await callMany(Array.from({ length: n }, (_, i) => ({ target: f.factory, data: v2f.encodeFunctionData('allPairs', [i]) }))))
    .map(decodeAddr).filter((a): a is string => !!a);

  const tokenCalls: Call[] = [];
  for (const a of addrs) {
    tokenCalls.push({ target: a, data: pairI.encodeFunctionData('token0') }, { target: a, data: pairI.encodeFunctionData('token1') });
    if (f.kind === 'solidly') tokenCalls.push({ target: a, data: pairI.encodeFunctionData('stable') });
  }
  const res = await callMany(tokenCalls);
  const step = f.kind === 'solidly' ? 3 : 2;
  const pools: ScannedPool[] = [];
  addrs.forEach((pool, i) => {
    const t0 = decodeAddr(res[i * step]), t1 = decodeAddr(res[i * step + 1]);
    if (!t0 || !t1) return;
    const p: ScannedPool = { dex: f.dex, kind: f.kind, pool, token0: t0, token1: t1 };
    if (f.kind === 'solidly') p.stable = decodeUint(res[i * step + 2]) === 1n;
    pools.push(p);
  });
  return pools;
}

// ----------------------------------------------------------------------------
// V3: read the factory's PoolCreated events.
//
// Works for Uniswap, PancakeSwap AND Ramses V3 without knowing the exact
// event signature: every variant has token0/token1 as the first two indexed
// topics and the pool address as the LAST word of the data. Factory events
// that aren't pool creations (OwnerChanged, FeeAmountEnabled...) carry no
// data and are skipped.
// ----------------------------------------------------------------------------
export function decodePoolCreatedLog(log: { topics: readonly string[]; data: string }): { token0: string; token1: string; pool: string } | null {
  if (log.topics.length < 3) return null;
  const hex = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
  if (hex.length < 64 || hex.length % 64 !== 0) return null;
  const word = (w: string) => (/^0{24}[0-9a-fA-F]{40}$/.test(w) ? ethers.getAddress('0x' + w.slice(24)) : null);
  const token0 = word(log.topics[1].slice(2)), token1 = word(log.topics[2].slice(2));
  const pool = word(hex.slice(hex.length - 64));
  if (!token0 || !token1 || !pool || token0 === token1) return null;
  if (pool === ethers.ZeroAddress) return null;
  return { token0, token1, pool };
}

// Fetches logs for [from, to]; if the node refuses the range, splits it in half.
export async function getLogsAdaptive(
  provider: ethers.JsonRpcProvider, address: string, from: number, to: number, depth = 0,
): Promise<ethers.Log[]> {
  try {
    return await provider.getLogs({ address, fromBlock: from, toBlock: to });
  } catch (err) {
    if (to - from < 2_000 || depth > 24) {
      // Smallest range still failing: one retry, then give up on it.
      await sleep(500);
      return provider.getLogs({ address, fromBlock: from, toBlock: to });
    }
    const mid = Math.floor((from + to) / 2);
    const left = await getLogsAdaptive(provider, address, from, mid, depth + 1);
    const right = await getLogsAdaptive(provider, address, mid + 1, to, depth + 1);
    return left.concat(right);
  }
}

export async function listV3Pools(provider: ethers.JsonRpcProvider, f: ScanFactory, latestBlock: number): Promise<ScannedPool[]> {
  const logs = await getLogsAdaptive(provider, f.factory, 0, latestBlock);
  const seen = new Set<string>();
  const pools: ScannedPool[] = [];
  for (const l of logs) {
    const d = decodePoolCreatedLog(l);
    if (!d || seen.has(d.pool)) continue;
    seen.add(d.pool);
    pools.push({ dex: f.dex, kind: 'v3', ...d });
  }
  return pools;
}

// ----------------------------------------------------------------------------
// Pricing (pure, unit-tested).
//
// Rough by design -- this only decides WHICH pairs are worth watching; the
// bot re-reads exact prices before any decision.
//   usdToken      = $1
//   wrappedNative = price from its deepest pool against usdToken
//   any other token = price from its deepest pool against usdToken or
//                     wrappedNative (balance ratio; exact for V2, approximate
//                     for V3)
// Pool value = sum of priced sides; if only one side is priced, double it.
// ----------------------------------------------------------------------------
const lc = (a: string) => a.toLowerCase();
const units = (v: bigint | undefined, dec: number) => (v === undefined ? 0 : Number(ethers.formatUnits(v, dec)));

export function derivePrices(pools: ScannedPool[], decimals: Map<string, number>, usdToken: string, wrappedNative: string): Map<string, number> {
  const usd = lc(usdToken), wn = lc(wrappedNative);
  const price = new Map<string, number>([[usd, 1]]);
  const dec = (t: string) => decimals.get(lc(t));

  // Best (deepest quote side) pool per token against a priced quote token.
  const priceAgainst = (quote: string) => {
    const best = new Map<string, { quoteAmt: number; px: number }>();
    for (const p of pools) {
      if (p.stable) continue;
      const t0 = lc(p.token0), t1 = lc(p.token1);
      if (t0 !== quote && t1 !== quote) continue;
      const other = t0 === quote ? t1 : t0;
      if (price.has(other)) continue;
      const dq = dec(quote), dt = dec(other);
      if (dq === undefined || dt === undefined) continue;
      const qAmt = units(t0 === quote ? p.bal0 : p.bal1, dq);
      const tAmt = units(t0 === quote ? p.bal1 : p.bal0, dt);
      if (qAmt <= 0 || tAmt <= 0) continue;
      const qUsd = qAmt * (price.get(quote) ?? 0);
      const prev = best.get(other);
      if (!prev || qUsd > prev.quoteAmt) best.set(other, { quoteAmt: qUsd, px: (qAmt / tAmt) * (price.get(quote) ?? 0) });
    }
    for (const [t, v] of best) if (!price.has(t)) price.set(t, v.px);
  };

  priceAgainst(usd);                 // wrapped native (and others) vs the stablecoin
  if (price.has(wn)) priceAgainst(wn); // everything else vs wrapped native
  return price;
}

export function poolUsd(p: ScannedPool, decimals: Map<string, number>, price: Map<string, number>): number {
  const d0 = decimals.get(lc(p.token0)), d1 = decimals.get(lc(p.token1));
  const p0 = price.get(lc(p.token0)), p1 = price.get(lc(p.token1));
  const v0 = p0 !== undefined && d0 !== undefined ? units(p.bal0, d0) * p0 : undefined;
  const v1 = p1 !== undefined && d1 !== undefined ? units(p.bal1, d1) * p1 : undefined;
  if (v0 !== undefined && v1 !== undefined) return v0 + v1;
  if (v0 !== undefined) return v0 * 2;
  if (v1 !== undefined) return v1 * 2;
  return 0;
}

// Groups pools by pair, keeps liquid priceable ones, ranks by 2nd-deepest pool.
export function rankCandidates(pools: ScannedPool[], minPoolUsd: number): { multiPoolPairs: number; candidates: PairCandidate[] } {
  const byPair = new Map<string, ScannedPool[]>();
  for (const p of pools) {
    const k = [lc(p.token0), lc(p.token1)].sort().join('/');
    (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(p);
  }
  let multiPoolPairs = 0;
  const candidates: PairCandidate[] = [];
  for (const group of byPair.values()) {
    if (group.length >= 2) multiPoolPairs++;
    // Solidly stable pools use a curve the bot can't price -> not usable.
    const usable = group.filter((p) => !p.stable && (p.usd ?? 0) >= minPoolUsd).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
    if (usable.length < 2) continue;
    candidates.push({
      tokenA: usable[0].token0, tokenB: usable[0].token1, pools: usable,
      secondUsd: usable[1].usd ?? 0,
      dexes: [...new Set(usable.map((p) => p.dex))],
    });
  }
  candidates.sort((a, b) => b.secondUsd - a.secondUsd);
  return { multiPoolPairs, candidates };
}

// ----------------------------------------------------------------------------
// The full scan.
// ----------------------------------------------------------------------------
export async function scanUniverse(provider: ethers.JsonRpcProvider, factories: ScanFactory[], opts: ScanOptions): Promise<ScanResult> {
  const log = opts.log ?? (() => {});
  const minPoolUsd = opts.minPoolUsd ?? 2_000;
  const errors: string[] = [];
  const { callMany, multicall } = await makeCaller(provider);
  const latest = await provider.getBlockNumber();

  // 1) Every pool on every factory (one factory at a time; one failing doesn't stop the rest).
  const all: ScannedPool[] = [];
  const poolsPerDex: Record<string, number> = {};
  for (const f of factories) {
    try {
      const found = f.kind === 'v3' ? await listV3Pools(provider, f, latest) : await listV2Pools(provider, callMany, f);
      poolsPerDex[f.dex] = found.length;
      all.push(...found);
      log(`[scan] ${f.dex}: ${found.length} pools`);
    } catch (err) {
      poolsPerDex[f.dex] = -1;
      errors.push(`${f.dex}: ${String((err as any)?.shortMessage ?? (err as any)?.message ?? err).slice(0, 120)}`);
    }
  }

  // 2) Only pairs on 2+ pools can be arbitraged -- read balances just for those.
  const count = new Map<string, number>();
  for (const p of all) { const k = [lc(p.token0), lc(p.token1)].sort().join('/'); count.set(k, (count.get(k) ?? 0) + 1); }
  const pricingTokens = new Set([lc(opts.usdToken), lc(opts.wrappedNative)]);
  // Pools that matter: multi-pool pairs, plus every pool against USDG/WETH (needed to price tokens).
  const relevant = all.filter((p) => {
    const k = [lc(p.token0), lc(p.token1)].sort().join('/');
    return (count.get(k) ?? 0) >= 2 || pricingTokens.has(lc(p.token0)) || pricingTokens.has(lc(p.token1));
  });

  const balCalls: Call[] = [];
  for (const p of relevant) {
    balCalls.push({ target: p.token0, data: erc20.encodeFunctionData('balanceOf', [p.pool]) });
    balCalls.push({ target: p.token1, data: erc20.encodeFunctionData('balanceOf', [p.pool]) });
  }
  const bals = await callMany(balCalls);
  relevant.forEach((p, i) => { p.bal0 = decodeUint(bals[i * 2]) ?? 0n; p.bal1 = decodeUint(bals[i * 2 + 1]) ?? 0n; });

  // 3) Token decimals + symbols, read from the tokens themselves.
  const tokenList = [...new Set(relevant.flatMap((p) => [lc(p.token0), lc(p.token1)]))];
  const metaRes = await callMany(tokenList.flatMap((t) => [
    { target: t, data: erc20.encodeFunctionData('decimals') },
    { target: t, data: erc20.encodeFunctionData('symbol') },
  ]));
  const tokens = new Map<string, TokenInfo>();
  const decimals = new Map<string, number>();
  tokenList.forEach((t, i) => {
    const d = decodeUint(metaRes[i * 2]);
    if (d === null || d > 36n) return; // not a standard token: its pools are skipped
    let symbol = t.slice(0, 8);
    try { symbol = String(erc20.decodeFunctionResult('symbol', metaRes[i * 2 + 1]!)[0]); } catch { /* keep short address */ }
    tokens.set(t, { symbol, decimals: Number(d) });
    decimals.set(t, Number(d));
  });

  // 4) Price, value and rank.
  const usdPrice = derivePrices(relevant, decimals, opts.usdToken, opts.wrappedNative);
  for (const p of relevant) p.usd = poolUsd(p, decimals, usdPrice);
  const multi = relevant.filter((p) => (count.get([lc(p.token0), lc(p.token1)].sort().join('/')) ?? 0) >= 2);
  const { multiPoolPairs, candidates } = rankCandidates(multi, minPoolUsd);

  return { poolsPerDex, totalPools: all.length, multiPoolPairs, candidates, tokens, usdPrice, usedMulticall: multicall, errors };
}
