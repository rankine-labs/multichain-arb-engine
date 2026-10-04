import { ethers } from 'ethers';

// ============================================================================
// UNIVERSE SCAN -- find EVERY pair that exists on 2+ pools, chain-wide
//
// Plain English:
//   The pair watcher only learns about a pair after someone trades it. A pair
//   that sits on two DEXes but trades rarely stays invisible. This scan asks
//   every DEX factory for its FULL list of pools instead, by reading each
//   factory's pool-creation events (PairCreated / PoolCreated). The result is
//   saved (ScanState) so later scans only read pools created since then.
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
const pairI = new ethers.Interface(['function stable() view returns (bool)']);
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
    const CHUNK = 400; // reads per request; a failed batch falls back to single calls
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
// Pool discovery from factory creation events -- ONE method for every DEX.
//
// Every factory announces each new pool with an event:
//   Uniswap/Pancake V2  PairCreated(token0 idx, token1 idx, address pair, uint n)
//   Solidly (Ramses V2) PairCreated(token0 idx, token1 idx, bool stable, address pair, uint n)
//   Uniswap/Pancake V3  PoolCreated(token0 idx, token1 idx, uint24 fee idx, int24 spacing, address pool)
//   Ramses V3           PoolCreated(token0 idx, token1 idx, int24 spacing idx, address pool)
// In all of them token0/token1 are the first two indexed topics and the pool
// is the last data word that is a real address. Small numbers (counters,
// fee, bool) look like addresses padded with zeros, so a "real address" must
// have a non-zero byte in its first 8 bytes. Factory events that aren't pool
// creations (OwnerChanged, FeeAmountEnabled...) carry no data -> skipped.
//
// Reading events costs one request per ~10k pools, versus 3 calls per pool
// for allPairs(i) + token0() + token1().
// ----------------------------------------------------------------------------
const isRealAddressWord = (w: string) => /^0{24}[0-9a-fA-F]{40}$/.test(w) && !/^0{40}/.test(w);

export function decodePoolCreatedLog(log: { topics: readonly string[]; data: string }): { token0: string; token1: string; pool: string } | null {
  if (log.topics.length < 3) return null;
  const hex = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
  if (hex.length < 64 || hex.length % 64 !== 0) return null;
  const t0 = log.topics[1].slice(2), t1 = log.topics[2].slice(2);
  if (!isRealAddressWord(t0) || !isRealAddressWord(t1) || t0.toLowerCase() === t1.toLowerCase()) return null;
  let pool: string | null = null;
  for (let i = hex.length - 64; i >= 0; i -= 64) {
    const w = hex.slice(i, i + 64);
    if (isRealAddressWord(w)) { pool = w; break; }
  }
  if (!pool) return null;
  const addr = (w: string) => ethers.getAddress('0x' + w.slice(24));
  return { token0: addr(t0), token1: addr(t1), pool: addr(pool) };
}

type RawLog = { topics: string[]; data: string };

// eth_getLogs with a hard timeout (a public node can hang on a huge range).
async function getLogsRaw(provider: ethers.JsonRpcProvider, address: string, from: number, to: number, timeoutMs: number): Promise<RawLog[]> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('getLogs timeout')), timeoutMs); });
  try {
    return await Promise.race([
      provider.send('eth_getLogs', [{ address, fromBlock: ethers.toQuantity(from), toBlock: ethers.toQuantity(to) }]) as Promise<RawLog[]>,
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Fetches logs for [from, to]; if the node refuses or times out, splits the
// range in half and tries each half (down to MIN_RANGE blocks).
export async function getLogsAdaptive(
  provider: ethers.JsonRpcProvider, address: string, from: number, to: number,
  onLogs: (logs: RawLog[]) => void, timeoutMs = 30_000,
): Promise<void> {
  const MIN_RANGE = 1_000;
  // Explicit stack instead of recursion: safe on any range size.
  const stack: Array<[number, number]> = [[from, to]];
  while (stack.length) {
    const [f, t] = stack.pop()!;
    try {
      onLogs(await getLogsRaw(provider, address, f, t, timeoutMs));
    } catch (err) {
      if (t - f < MIN_RANGE) {
        await sleep(500);
        onLogs(await getLogsRaw(provider, address, f, t, timeoutMs)); // last try; throws if still failing
        continue;
      }
      const mid = Math.floor((f + t) / 2);
      stack.push([mid + 1, t], [f, mid]); // left half processed first
    }
  }
}

export async function listPoolsFromLogs(provider: ethers.JsonRpcProvider, f: ScanFactory, fromBlock: number, toBlock: number): Promise<ScannedPool[]> {
  const pools: ScannedPool[] = [];
  const seen = new Set<string>();
  await getLogsAdaptive(provider, f.factory, fromBlock, toBlock, (logs) => {
    for (const l of logs) {
      const d = decodePoolCreatedLog(l);
      if (!d || seen.has(d.pool)) continue;
      seen.add(d.pool);
      pools.push({ dex: f.dex, kind: f.kind, ...d });
    }
  });
  return pools;
}

// ----------------------------------------------------------------------------
// Saved scan state, so a restart only reads pools created since last time.
// Compact on purpose (Robinhood has 100k+ memecoin pools): tokens are stored
// once in a list and pools refer to them by index.
// ----------------------------------------------------------------------------
export interface ScanState {
  version: 1;
  lastBlock: Record<string, number>;          // factory (lowercase) -> last block scanned
  tokens: string[];                           // lowercase token addresses
  pools: Array<[number, string, number, number]>; // [factory index in `factories`, pool, token0 idx, token1 idx]
  factories: string[];                        // "dex|kind|factory"
}

export function emptyScanState(): ScanState {
  return { version: 1, lastBlock: {}, tokens: [], pools: [], factories: [] };
}

export function stateToPools(state: ScanState): ScannedPool[] {
  return state.pools.map(([fi, pool, i0, i1]) => {
    const [dex, kind] = state.factories[fi].split('|');
    return { dex, kind: kind as ScannedPool['kind'], pool, token0: state.tokens[i0], token1: state.tokens[i1] };
  });
}

export function addPoolsToState(state: ScanState, f: ScanFactory, pools: ScannedPool[]) {
  const fkey = `${f.dex}|${f.kind}|${lc(f.factory)}`;
  let fi = state.factories.indexOf(fkey);
  if (fi < 0) fi = state.factories.push(fkey) - 1;
  const tokenIdx = new Map(state.tokens.map((t, i) => [t, i]));
  const idx = (t: string) => {
    const k = lc(t);
    let i = tokenIdx.get(k);
    if (i === undefined) { i = state.tokens.push(k) - 1; tokenIdx.set(k, i); }
    return i;
  };
  const known = new Set(state.pools.map((p) => lc(p[1])));
  for (const p of pools) if (!known.has(lc(p.pool))) state.pools.push([fi, p.pool, idx(p.token0), idx(p.token1)]);
}

// ----------------------------------------------------------------------------
// Pricing (pure, unit-tested).
//
// Rough by design -- this only decides WHICH pairs are worth watching; the
// bot re-reads exact prices before any decision. But it must never be
// fooled by junk pools, so:
//   - prices come ONLY from V2-style pools, where the balance ratio IS the
//     price. A V3 pool's balances say nothing about price (liquidity can sit
//     entirely on one side), so a memecoin's V3 pool holding 10 WETH and
//     1 token would otherwise price that token at 10 ETH.
//       usdToken      = $1
//       wrappedNative = deepest V2 pool vs usdToken (V3 only if no V2 exists)
//       other tokens  = deepest V2 pool vs usdToken or wrappedNative
//   - a pricing pool needs $2,000+ of USDG/WETH in it (tiny pools are easy to skew)
//   - a pool is worth 2 x its SMALLER priced side (one side priced: 2 x it).
//     Conservative: a pool stuffed with a worthless token isn't "deep".
// ----------------------------------------------------------------------------
const lc = (a: string) => a.toLowerCase();
const units = (v: bigint | undefined, dec: number) => (v === undefined ? 0 : Number(ethers.formatUnits(v, dec)));

const MIN_PRICING_QUOTE_USD = 2_000;

export function derivePrices(pools: ScannedPool[], decimals: Map<string, number>, usdToken: string, wrappedNative: string): Map<string, number> {
  const usd = lc(usdToken), wn = lc(wrappedNative);
  const price = new Map<string, number>([[usd, 1]]);
  const dec = (t: string) => decimals.get(lc(t));

  // Best (deepest quote side) pool per token against a priced quote token.
  const priceAgainst = (quote: string, allowV3: boolean, only?: string) => {
    const best = new Map<string, { quoteAmt: number; px: number }>();
    for (const p of pools) {
      if (p.stable) continue;
      if (p.kind === 'v3' && !allowV3) continue;
      const t0 = lc(p.token0), t1 = lc(p.token1);
      if (t0 !== quote && t1 !== quote) continue;
      const other = t0 === quote ? t1 : t0;
      if (price.has(other) || (only && other !== only)) continue;
      const dq = dec(quote), dt = dec(other);
      if (dq === undefined || dt === undefined) continue;
      const qAmt = units(t0 === quote ? p.bal0 : p.bal1, dq);
      const tAmt = units(t0 === quote ? p.bal1 : p.bal0, dt);
      if (qAmt <= 0 || tAmt <= 0) continue;
      const qUsd = qAmt * (price.get(quote) ?? 0);
      // A pool with almost no USDG/WETH in it is trivially mispriced (anyone
      // can skew a $50 pool): never use it to price a token.
      if (qUsd < MIN_PRICING_QUOTE_USD) continue;
      const prev = best.get(other);
      if (!prev || qUsd > prev.quoteAmt) best.set(other, { quoteAmt: qUsd, px: (qAmt / tAmt) * (price.get(quote) ?? 0) });
    }
    for (const [t, v] of best) if (!price.has(t)) price.set(t, v.px);
  };

  priceAgainst(usd, false);                              // V2 pools vs the stablecoin (incl. wrapped native)
  if (!price.has(wn)) priceAgainst(usd, true, wn);       // wrapped native from V3 only if no V2 pool exists
  if (price.has(wn)) priceAgainst(wn, false);            // everything else vs wrapped native (V2 only)
  return price;
}

export function poolUsd(p: ScannedPool, decimals: Map<string, number>, price: Map<string, number>): number {
  const d0 = decimals.get(lc(p.token0)), d1 = decimals.get(lc(p.token1));
  const p0 = price.get(lc(p.token0)), p1 = price.get(lc(p.token1));
  const v0 = p0 !== undefined && d0 !== undefined ? units(p.bal0, d0) * p0 : undefined;
  const v1 = p1 !== undefined && d1 !== undefined ? units(p.bal1, d1) * p1 : undefined;
  if (v0 !== undefined && v1 !== undefined) return 2 * Math.min(v0, v1);
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
//   state: pass the saved state from last time (or emptyScanState()); it is
//          updated in place with any new pools, ready to be saved again.
// ----------------------------------------------------------------------------
const pairKey = (p: { token0: string; token1: string }) => [lc(p.token0), lc(p.token1)].sort().join('/');

export async function scanUniverse(
  provider: ethers.JsonRpcProvider, factories: ScanFactory[], opts: ScanOptions, state: ScanState = emptyScanState(),
): Promise<ScanResult> {
  const log = opts.log ?? (() => {});
  const minPoolUsd = opts.minPoolUsd ?? 2_000;
  const errors: string[] = [];
  const { callMany, multicall } = await makeCaller(provider);
  const latest = await provider.getBlockNumber();

  // 1) New pools on every factory since the last scan (one factory at a time;
  //    one failing doesn't stop the rest, and its progress isn't saved).
  for (const f of factories) {
    const fk = lc(f.factory);
    const from = (state.lastBlock[fk] ?? -1) + 1;
    if (from > latest) continue;
    try {
      const found = await listPoolsFromLogs(provider, f, from, latest);
      addPoolsToState(state, f, found);
      state.lastBlock[fk] = latest;
      log(`[scan] ${f.dex}: +${found.length} pools (blocks ${from}-${latest})`);
    } catch (err) {
      errors.push(`${f.dex}: ${String((err as any)?.shortMessage ?? (err as any)?.message ?? err).slice(0, 120)}`);
    }
  }
  const all = stateToPools(state);
  const poolsPerDex: Record<string, number> = {};
  for (const f of factories) poolsPerDex[f.dex] = 0;
  for (const p of all) poolsPerDex[p.dex] = (poolsPerDex[p.dex] ?? 0) + 1;

  // 2) Only pairs on 2+ pools can be arbitraged. Read balances for those,
  //    plus each of their tokens' pools against USDG/WETH (to price them).
  const count = new Map<string, number>();
  for (const p of all) { const k = pairKey(p); count.set(k, (count.get(k) ?? 0) + 1); }
  const multi = all.filter((p) => (count.get(pairKey(p)) ?? 0) >= 2);
  const quote = new Set([lc(opts.usdToken), lc(opts.wrappedNative)]);
  const needPrice = new Set(multi.flatMap((p) => [lc(p.token0), lc(p.token1)]));
  const multiSet = new Set(multi);
  const pricing = all.filter((p) => !multiSet.has(p) && (
    (quote.has(lc(p.token0)) && needPrice.has(lc(p.token1))) || (quote.has(lc(p.token1)) && needPrice.has(lc(p.token0)))));
  const relevant = multi.concat(pricing);
  log(`[scan] ${all.length} pools total; reading balances for ${relevant.length}`);

  const balCalls: Call[] = [];
  for (const p of relevant) {
    balCalls.push({ target: p.token0, data: erc20.encodeFunctionData('balanceOf', [p.pool]) });
    balCalls.push({ target: p.token1, data: erc20.encodeFunctionData('balanceOf', [p.pool]) });
  }
  const bals = await callMany(balCalls);
  relevant.forEach((p, i) => { p.bal0 = decodeUint(bals[i * 2]) ?? 0n; p.bal1 = decodeUint(bals[i * 2 + 1]) ?? 0n; });

  // Solidly pools: stable-curve or volatile? (the bot can only price volatile)
  const solid = relevant.filter((p) => p.kind === 'solidly');
  const st = await callMany(solid.map((p) => ({ target: p.pool, data: pairI.encodeFunctionData('stable') })));
  solid.forEach((p, i) => { p.stable = decodeUint(st[i]) === 1n; });

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
  const { multiPoolPairs, candidates } = rankCandidates(multi, minPoolUsd);

  return { poolsPerDex, totalPools: all.length, multiPoolPairs, candidates, tokens, usdPrice, usedMulticall: multicall, errors };
}
