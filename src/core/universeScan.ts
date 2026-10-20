import { ethers } from 'ethers';
import { v4AsksPaced, findV4Pools, V4_TIERS } from './v4Lookup';
import { STANDARD_V4_TIERS } from '../config/v4Tiers';
import { Steps, drainSteps, runSteps, yieldToLoop, Pacer } from './chunked';
import { timed } from './stallFinder';

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
  kind: 'v2' | 'solidly' | 'v3' | 'v4';   // 'v4': only in scan RESULTS (asked per pair), never in the saved map
  pool: string;       // V4: the 32-byte pool id
  v4?: { fee: number; tickSpacing: number; native: boolean; poolManager: string; stateView: string };
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
  // Uniswap V4 asked per pair (opts.v4): what was checked and found.
  v4?: { singles: number; withMoney: number; pairsAsked: number; found: number; candidatesWithV4: number };
}

export interface ScanOptions {
  usdToken: string;          // a $1 stablecoin (Robinhood: USDG)
  wrappedNative: string;     // WETH; priced from its deepest pool vs usdToken
  minPoolUsd?: number;       // default 2,000
  log?: (msg: string) => void;
  // Largest block range asked for in one log query (default: whole range).
  // On the free node, a ~30 ms-block chain makes a day ~2.9M blocks, so we
  // start with sensible slices instead of one huge ask that gets split anyway.
  maxLogRange?: number;
  // Uniswap V4, asked per pair (core/v4Lookup.ts). Leave out to skip V4.
  v4?: { stateView: string; poolManager: string; maxPairs?: number; pauseMs?: number; extraTierPairs?: number };
  // Go over the full pool list in ~5 ms bites (core/chunked.ts) instead of
  // one long freeze. Same result either way. STALL_FIX_SCAN_EXPAND=0 = off.
  chunked?: boolean;
  // REBUILD_PACED (Oct 15): the rest of the scan's long steps (writing the
  // balance / name reads, reading the names back, pricing, the per-factory
  // "new pools" bookkeeping, the V4 single-pool list) also run in ~5 ms
  // bites, and the read requests are written by hand instead of through
  // ethers (same bytes, ~50x less work). Same result. false = old way.
  paced?: boolean;
  paceMs?: number;           // work between breaks (default 5 ms; tests use 0)
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

// ----------------------------------------------------------------------------
// FAST MULTICALL ANSWER READER (freeze fix phase 2, Oct 14)
//
// Plain English:
//   A Multicall3 bundle of 400 reads comes back as one long piece of hex
//   text holding 400 (worked?, answer) pairs. The general-purpose ethers
//   reader builds lots of temporary objects for every pair, which was the top
//   cause of freezes during the 6-hourly scan ("multicall decode", up to 1.9 s).
//   The layout is simple and fixed, so this reader just walks the hex text
//   by position and cuts out each answer. Same answers as ethers, much less
//   work and memory.
//
//   Safety: every position and length is checked. If ANYTHING looks unusual
//   (a position out of range, a "worked?" flag that isn't 0 or 1, a missing
//   piece), it gives up and returns null, and the caller uses the ethers
//   reader instead, so the answer is always the same as before.
//   SCAN_FAST_DECODE=0 turns it off (always ethers).
//
// The layout (each "word" is 32 bytes = 64 hex characters):
//   word 0            where the list starts (always 32)
//   list start        how many pairs (N)
//   next N words      where each pair starts (counted from just after N)
//   each pair         word 1: worked? (0/1), word 2: where its answer starts
//                     (counted from the pair start), then the answer's length
//                     in bytes, then the answer itself padded to whole words
// ----------------------------------------------------------------------------
const ZERO52 = '0'.repeat(52);
// Reads the word at hex position `pos` as a small number, or -1 if it is too
// big to be a sensible position/length (top 26 bytes must be zero).
const smallWord = (hex: string, pos: number): number => {
  if (pos + 64 > hex.length || !hex.startsWith(ZERO52, pos)) return -1;
  const n = parseInt(hex.slice(pos + 52, pos + 64), 16);
  return Number.isFinite(n) ? n : -1;
};

// ----------------------------------------------------------------------------
// HAND-WRITTEN READ REQUESTS (Oct 15, REBUILD_PACED)
//
// Plain English:
//   Measured: asking ethers to write one "balanceOf(pool)" request costs
//   ~50 microseconds. The scan writes two per pool it reads (tens of
//   thousands of pools) all in one go, which froze the bot for seconds
//   (7.3 s for 50,000 pools on a fast test machine). The request is just a
//   fixed 4-byte code plus the address padded to 32 bytes, so it is written
//   by hand here: exactly the same text ethers writes (tested), ~50x faster.
//   Anything that does not look like a normal address goes to ethers as
//   before (which also reports a bad address as before).
//   Note: ethers also rejects a mixed-case address whose capital letters are
//   a wrong checksum; this writer does not check that. The scan only ever
//   has addresses written by ethers itself (correct checksum) or lower case,
//   so the result is the same for everything the bot actually scans.
// ----------------------------------------------------------------------------
const SEL_BALANCE_OF = '0x70a08231';
// (ADDR_RE / HEX_RE: defined with the fast bundle writer below.)
const PAD24 = '0'.repeat(24);
export function encodeBalanceOf(addr: string): string {
  if (typeof addr !== 'string' || !ADDR_RE.test(addr)) return erc20.encodeFunctionData('balanceOf', [addr]);
  return SEL_BALANCE_OF + PAD24 + addr.slice(2).toLowerCase();
}
// Calls with no inputs are always the same text.
export const CALL_DECIMALS = erc20.encodeFunctionData('decimals');
export const CALL_SYMBOL = erc20.encodeFunctionData('symbol');
export const CALL_STABLE = pairI.encodeFunctionData('stable');

// Reads a symbol() answer (a text) by hand when it is in the standard
// layout (offset 32, length, the letters padded to 32 bytes) and plain
// ASCII. Returns null for anything else, and the caller asks ethers, so
// the answer is always what ethers would give (tested on many samples).
export function fastDecodeString(ret: string | null | undefined): string | null {
  if (typeof ret !== 'string' || ret.length < 2 + 128 || !HEX_RE.test(ret)) return null;
  const hex = ret.slice(2);
  // ethers refuses an answer that is not whole 32-byte words.
  if (hex.length % 64 !== 0 || smallWord(hex, 0) !== 32) return null;
  const len = smallWord(hex, 64);
  if (len < 0 || 128 + Math.ceil(len / 32) * 64 > hex.length) return null;
  let out = '';
  for (let i = 0; i < len; i++) {
    const b = parseInt(hex.slice(128 + i * 2, 130 + i * 2), 16);
    if (!(b < 0x80)) return null; // not plain ASCII: let ethers do it
    out += String.fromCharCode(b);
  }
  return out;
}

// Multicall3 aggregate3 answer -> per-read answer (null = read failed or
// returned nothing). Returns null (not an array) if the text looks unusual:
// the caller then uses the ethers reader.
export function fastDecodeAggregate3(ret: string): (string | null)[] | null {
  if (typeof ret !== 'string' || !ret.startsWith('0x')) return null;
  // ethers always hands back lowercase text; match it exactly.
  const hex = /[A-F]/.test(ret) ? ret.toLowerCase() : ret;
  const H = 2; // hex position of byte 0 (after "0x")
  const totalBytes = (hex.length - H) / 2;
  if (!Number.isInteger(totalBytes) || totalBytes < 64) return null;
  const at = (byte: number) => H + byte * 2; // byte offset -> hex position
  const listOff = smallWord(hex, at(0));
  if (listOff < 0 || listOff % 32 !== 0 || listOff + 32 > totalBytes) return null;
  const n = smallWord(hex, at(listOff));
  const base = listOff + 32; // pair positions are counted from here
  if (n < 0 || base + n * 32 > totalBytes) return null;
  const out: (string | null)[] = new Array(n);
  // Multicall3 always writes the pairs back to back in order (the standard
  // tight layout). We insist on exactly that: anything else goes to ethers.
  let expectRel = n * 32;
  for (let i = 0; i < n; i++) {
    const rel = smallWord(hex, at(base + i * 32));
    if (rel !== expectRel) return null;
    const pair = base + rel;
    if (pair + 64 > totalBytes) return null;
    // worked? flag: exactly 0 or 1 (anything else: let ethers decide).
    const flagPos = at(pair);
    if (!hex.startsWith(ZERO52, flagPos)) return null;
    const flagTail = hex.slice(flagPos + 52, flagPos + 64);
    const ok = flagTail === '000000000001';
    if (!ok && flagTail !== '000000000000') return null;
    const dataRel = smallWord(hex, at(pair + 32));
    if (dataRel !== 64) return null; // answer right after the two pair words
    const lenAt = pair + dataRel;
    const len = smallWord(hex, at(lenAt));
    if (len < 0) return null;
    const start = lenAt + 32;
    // The answer plus its padding must fit inside the text.
    const end = start + Math.ceil(len / 32) * 32;
    if (end > totalBytes) return null;
    out[i] = ok && len > 0 ? '0x' + hex.slice(at(start), at(start + len)) : null;
    expectRel = end - base;
  }
  // Nothing left over after the last answer (again: the standard layout).
  if (base + expectRel !== totalBytes) return null;
  return out;
}

// The same answer with the ethers reader (the old way, and the fallback).
export function ethersDecodeAggregate3(ret: string): (string | null)[] {
  const [results] = mc3.decodeFunctionResult('aggregate3', ret);
  return results.map((r: any) => (r.success && r.returnData !== '0x' ? r.returnData : null));
}

// How many bundles were read the fast way vs fell back to ethers (tests / logs).
export const decodeStats = { fast: 0, fallback: 0 };

// Fast reader first (unless SCAN_FAST_DECODE=0); ethers if it gives up.
export function decodeAggregate3(ret: string): (string | null)[] {
  if (process.env.SCAN_FAST_DECODE !== '0') {
    let fast: (string | null)[] | null = null;
    try { fast = fastDecodeAggregate3(ret); } catch { fast = null; }
    if (fast) { decodeStats.fast++; return fast; }
    decodeStats.fallback++;
  }
  return ethersDecodeAggregate3(ret);
}

// The same trick for the QUESTION we send: ethers took ~50 ms to write out
// one 400-read bundle (measured Oct 14), on top of the reading. This writes
// the exact same text by hand. Anything unusual (a target that isn't a plain
// 0x + 40 hex address, call data that isn't whole bytes of hex) goes to
// ethers instead, so the text sent is always byte-for-byte what ethers writes.
const AGG3_SELECTOR = mc3.getFunction('aggregate3')!.selector.slice(2);
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x(?:[0-9a-fA-F]{2})*$/;
const hexWord = (n: number) => n.toString(16).padStart(64, '0');
const ZERO64 = '0'.repeat(64);
export function fastEncodeAggregate3(calls: { target: string; data: string }[]): string | null {
  const n = calls.length;
  const parts: string[] = ['0x', AGG3_SELECTOR, hexWord(32), hexWord(n)];
  // First the N "where does call i start" words, then the calls themselves.
  // Each call: address, allowFailure = true, where its data starts (always
  // 96 bytes in), the data length, the data padded with zeros to whole words.
  const bodies: string[] = new Array(n);
  let rel = n * 32;
  for (let i = 0; i < n; i++) {
    const c = calls[i];
    if (typeof c?.target !== 'string' || typeof c?.data !== 'string' || !ADDR_RE.test(c.target) || !HEX_RE.test(c.data)) return null;
    const dataHex = c.data.slice(2).toLowerCase();
    const len = dataHex.length / 2;
    const padChars = (64 - (dataHex.length % 64)) % 64;
    parts.push(hexWord(rel));
    bodies[i] = '000000000000000000000000' + c.target.slice(2).toLowerCase() + hexWord(1) + hexWord(96) + hexWord(len)
      + dataHex + ZERO64.slice(0, padChars);
    rel += 128 + (dataHex.length + padChars) / 2;
  }
  for (const b of bodies) parts.push(b);
  return parts.join('');
}
export function encodeAggregate3(calls: { target: string; data: string }[]): string {
  if (process.env.SCAN_FAST_DECODE !== '0') {
    const fast = fastEncodeAggregate3(calls);
    if (fast) return fast;
  }
  return mc3.encodeFunctionData('aggregate3', [calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))]);
}

type Call = { target: string; data: string };
type CallMany = (calls: Call[]) => Promise<(string | null)[]>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------------------
// Batched reads. Returns raw return data per call (null = call failed).
// ----------------------------------------------------------------------------
export async function makeCaller(provider: ethers.JsonRpcProvider): Promise<{ callMany: CallMany; multicall: boolean }> {
  let multicall = false;
  try { multicall = (await provider.getCode(MULTICALL3)).length > 2; } catch { /* treat as absent */ }

  // One eth_call with up to 2 attempts. A revert is a real answer (null).
  // Anything else after 2 tries (rate limit, timeout, network) is THROWN:
  // returning null there made callers read "no pool" and, worse, made a
  // failed bundle fall back to hundreds of single calls (a burst that got us
  // rate-limited). The caller retries later instead.
  const rawCall = async (c: Call): Promise<string | null> => {
    let last: unknown;
    for (let i = 0; i < 2; i++) {
      try { return await provider.call({ to: c.target, data: c.data }); }
      catch (err) {
        if ((err as any)?.code === 'CALL_EXCEPTION') return null;
        last = err;
        await sleep(300);
      }
    }
    throw last;
  };

  if (multicall) {
    const CHUNK = 400; // reads per request
    // One bundle. If the node rejects it as too big (revert / out of gas),
    // split it in half and try each half: a few requests, never hundreds.
    const bundle = async (slice: Call[]): Promise<(string | null)[]> => {
      // Written by hand (same text as ethers, see encodeAggregate3), timed by name.
      const data = timed('multicall encode', () => encodeAggregate3(slice));
      const ret = await rawCall({ target: MULTICALL3, data }); // throws on rate limit / network
      if (ret) {
        // Stall finder: decoding a big bundled answer is timed (measurement only).
        // Fast hand reader, same answers as ethers (see decodeAggregate3 above).
        return timed('multicall decode', () => decodeAggregate3(ret));
      }
      if (slice.length === 1) return [await rawCall(slice[0])];
      const mid = Math.ceil(slice.length / 2);
      return [...(await bundle(slice.slice(0, mid))), ...(await bundle(slice.slice(mid)))];
    };
    const callMany: CallMany = async (calls) => {
      const out: (string | null)[] = [];
      for (let i = 0; i < calls.length; i += CHUNK) {
        // Between bundles, let the rest of the bot run (trades, feed messages)
        // so a scan of thousands of reads never holds the thread for long.
        // Not before the first bundle: a small read (one bundle) is unchanged.
        if (i > 0) await yieldToLoop();
        const res = await bundle(calls.slice(i, i + CHUNK));
        for (const r of res) out.push(r);
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

export type RawLog = { topics: string[]; data: string; address?: string; blockNumber?: string; logIndex?: string; transactionHash?: string; transactionIndex?: string };

// eth_getLogs with a hard timeout (a public node can hang on a huge range).
async function getLogsRaw(provider: ethers.JsonRpcProvider, address: string | string[], from: number, to: number, timeoutMs: number): Promise<RawLog[]> {
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
// A "slow down" answer is NOT a sign the range is too big: wait and ask the
// same range again (splitting on rate limits multiplied requests into a burst).
const isSlowDown = (err: unknown) => /429|too many|rate limit|exceeded|allowance/i.test(String((err as any)?.shortMessage ?? '') + ' ' + String((err as any)?.message ?? err));

export async function getLogsAdaptive(
  provider: ethers.JsonRpcProvider, address: string | string[], from: number, to: number,
  onLogs: (logs: RawLog[]) => void, timeoutMs = 30_000, maxRange = Infinity,
): Promise<void> {
  const MIN_RANGE = 8; // keep splitting: busy stretches can overflow even a few hundred blocks
  // Explicit stack instead of recursion: safe on any range size. Big ranges
  // start as maxRange-sized slices (pushed in reverse so the oldest runs first).
  const stack: Array<[number, number]> = [];
  const step = Number.isFinite(maxRange) && maxRange > 0 ? Math.floor(maxRange) : to - from + 1;
  const slices: Array<[number, number]> = [];
  for (let f = from; f <= to; f += step) slices.push([f, Math.min(to, f + step - 1)]);
  for (let i = slices.length - 1; i >= 0; i--) stack.push(slices[i]);
  let slowDowns = 0;
  while (stack.length) {
    const [f, t] = stack.pop()!;
    try {
      onLogs(await getLogsRaw(provider, address, f, t, timeoutMs));
      slowDowns = 0;
    } catch (err) {
      if (isSlowDown(err)) {
        if (++slowDowns > 6) throw err;                 // node keeps refusing: give up, scan retries later
        await sleep(2_000 * slowDowns);
        stack.push([f, t]);                              // same range again
        continue;
      }
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

export async function listPoolsFromLogs(provider: ethers.JsonRpcProvider, f: ScanFactory, fromBlock: number, toBlock: number, maxRange = Infinity): Promise<ScannedPool[]> {
  const pools: ScannedPool[] = [];
  const seen = new Set<string>();
  await getLogsAdaptive(provider, f.factory, fromBlock, toBlock, (logs) => {
    for (const l of logs) {
      const d = decodePoolCreatedLog(l);
      if (!d || seen.has(d.pool)) continue;
      seen.add(d.pool);
      pools.push({ dex: f.dex, kind: f.kind, ...d });
    }
  }, 30_000, maxRange);
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
  return drainSteps(stateToPoolsSteps(state));
}

// The same list as stateToPools(), written as steps (core/chunked.ts) so it
// can be built in ~5 ms bites with runSteps() instead of freezing the bot
// while ~400,000 pools are expanded. Same code, so the same result.
export function* stateToPoolsSteps(state: ScanState): Steps<ScannedPool[]> {
  // Guard (Oct 9): a V4 scan was briefly live and may have saved V4 pools
  // (32-byte ids, not addresses) in the state. This code can't read them,
  // so they are skipped instead of being sent normal pool calls.
  const out: ScannedPool[] = [];
  const n = state.pools.length;
  for (let i = 0; i < n; i++) {
    if ((i & 2047) === 2047) yield;   // a safe place for a break
    const [fi, pool, i0, i1] = state.pools[i];
    const [dex, kind] = state.factories[fi].split('|');
    if (kind === 'v4' || pool.length !== 42) continue;
    out.push({ dex, kind: kind as ScannedPool['kind'], pool, token0: state.tokens[i0], token1: state.tokens[i1] });
  }
  return out;
}

// The same pools as stateToPools(), but only pool + coins, and WITHOUT
// building a list: each pool is handed out one at a time while the caller
// loops over it, straight from the saved scan state. Used by the loop
// trader's extra pools, which used to keep its own copy of the whole list
// (one small object per pool, 100k+ pools) in memory all the time.
// Can be looped over any number of times; always reflects the current state.
export function scanPoolRefs(state: ScanState): Iterable<{ pool: string; token0: string; token1: string }> {
  return {
    *[Symbol.iterator]() {
      const skip = state.factories.map((f) => f.split('|')[1] === 'v4');
      for (const [fi, pool, i0, i1] of state.pools) {
        if (skip[fi] || pool.length !== 42) continue;
        yield { pool, token0: state.tokens[i0], token1: state.tokens[i1] };
      }
    },
  };
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

// REBUILD_PACED (Oct 15): addPoolsToState() above builds two lookups over
// EVERY coin and pool on the chain (~400,000 each) each time it is called,
// once per factory per scan: 0.3-0.5 s each on a fast test machine, so
// 2-4 s of freezes per scan. The version below builds the two lookups once
// per scan, in ~5 ms bites, and keeps them up to date. Same pools added in
// the same order (tested).
export interface ScanStateIndex { tokenIdx: Map<string, number>; known: Set<string> }

export function* buildScanStateIndexSteps(state: ScanState): Steps<ScanStateIndex> {
  const tokenIdx = new Map<string, number>();
  for (let i = 0; i < state.tokens.length; i++) {
    if ((i & 2047) === 2047) yield;
    tokenIdx.set(state.tokens[i], i);
  }
  const known = new Set<string>();
  for (let i = 0; i < state.pools.length; i++) {
    if ((i & 2047) === 2047) yield;
    known.add(lc(state.pools[i][1]));
  }
  return { tokenIdx, known };
}

// Same as addPoolsToState(state, f, pools), using (and updating) the index.
// Like the old one, a pool is checked against the pools that were in the
// state before this call (so the answer is the same even if the list
// handed in held the same pool twice).
export function* addPoolsToStateSteps(state: ScanState, f: ScanFactory, pools: ScannedPool[], index: ScanStateIndex): Steps<void> {
  const fkey = `${f.dex}|${f.kind}|${lc(f.factory)}`;
  let fi = state.factories.indexOf(fkey);
  if (fi < 0) fi = state.factories.push(fkey) - 1;
  const idx = (t: string) => {
    const k = lc(t);
    let i = index.tokenIdx.get(k);
    if (i === undefined) { i = state.tokens.push(k) - 1; index.tokenIdx.set(k, i); }
    return i;
  };
  const added: string[] = [];
  for (let n = 0; n < pools.length; n++) {
    if ((n & 1023) === 1023) yield;
    const p = pools[n];
    const k = lc(p.pool);
    if (!index.known.has(k)) { state.pools.push([fi, p.pool, idx(p.token0), idx(p.token1)]); added.push(k); }
  }
  for (const k of added) index.known.add(k);
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
  return drainSteps(derivePricesSteps(pools, decimals, usdToken, wrappedNative));
}

// The same pricing written as steps (`yield` = a safe place for a break),
// so the scan can run it in ~5 ms bites (REBUILD_PACED). Same code, same prices.
export function* derivePricesSteps(pools: ScannedPool[], decimals: Map<string, number>, usdToken: string, wrappedNative: string): Steps<Map<string, number>> {
  const usd = lc(usdToken), wn = lc(wrappedNative);
  const price = new Map<string, number>([[usd, 1]]);
  const dec = (t: string) => decimals.get(lc(t));

  // Best (deepest quote side) pool per token against a priced quote token.
  const priceAgainst = function* (quote: string, allowV3: boolean, only?: string): Steps<void> {
    const best = new Map<string, { quoteAmt: number; px: number }>();
    let n = 0;
    for (const p of pools) {
      if ((++n & 2047) === 0) yield;
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

  yield* priceAgainst(usd, false);                              // V2 pools vs the stablecoin (incl. wrapped native)
  if (!price.has(wn)) yield* priceAgainst(usd, true, wn);       // wrapped native from V3 only if no V2 pool exists
  if (price.has(wn)) yield* priceAgainst(wn, false);            // everything else vs wrapped native (V2 only)
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
  return drainSteps(rankCandidatesSteps(pools, minPoolUsd));
}

// The same ranking written as steps (REBUILD_PACED). Same code, same list.
export function* rankCandidatesSteps(pools: ScannedPool[], minPoolUsd: number): Steps<{ multiPoolPairs: number; candidates: PairCandidate[] }> {
  let n = 0;
  const byPair = new Map<string, ScannedPool[]>();
  for (const p of pools) {
    if ((++n & 1023) === 0) yield;
    const k = [lc(p.token0), lc(p.token1)].sort().join('/');
    (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(p);
  }
  let multiPoolPairs = 0;
  const candidates: PairCandidate[] = [];
  for (const group of byPair.values()) {
    if ((++n & 1023) === 0) yield;
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
  // REBUILD_PACED: take a short break about every 5 ms in the long loops
  // below (each stretch between breaks is named "pool scan" for the freeze
  // report). Off: no breaks and ethers writes the requests (old way).
  const paced = !!opts.paced;
  const pacer = new Pacer('pool scan', opts.paceMs ?? 5, paced);
  const sliceMs = opts.paceMs ?? 5;
  const encBal = paced ? encodeBalanceOf : (a: string) => erc20.encodeFunctionData('balanceOf', [a]);
  // The coin / pool lookups used to add new pools (built once, only when a
  // factory has new pools; see addPoolsToStateSteps).
  let stateIndex: ScanStateIndex | null = null;

  // 1) New pools on every factory since the last scan (one factory at a time;
  //    one failing doesn't stop the rest, and its progress isn't saved).
  for (const f of factories) {
    const fk = lc(f.factory);
    const from = (state.lastBlock[fk] ?? -1) + 1;
    if (from > latest) continue;
    try {
      const found = await listPoolsFromLogs(provider, f, from, latest, opts.maxLogRange);
      if (!paced) addPoolsToState(state, f, found);
      else if (found.length) {
        // (With no new pools there is nothing to add: the old call changed nothing either.)
        stateIndex ??= await runSteps(buildScanStateIndexSteps(state), 'pool scan new pools', sliceMs);
        await runSteps(addPoolsToStateSteps(state, f, found, stateIndex), 'pool scan new pools', sliceMs);
      }
      state.lastBlock[fk] = latest;
      log(`[scan] ${f.dex}: +${found.length} pools (blocks ${from}-${latest})`);
    } catch (err) {
      errors.push(`${f.dex}: ${String((err as any)?.shortMessage ?? (err as any)?.message ?? err).slice(0, 120)}`);
    }
  }
  // Done adding new pools: let the big coin/pool lookups go now, so they
  // don't sit in memory (tens of MB) for the rest of the scan.
  stateIndex = null;
  // Steps 1b-2 go over every pool on the chain (~400,000 on Robinhood).
  // Written as steps (core/chunked.ts): with opts.chunked they run in ~5 ms
  // bites so the bot keeps reading trades meanwhile; the result is the same.
  function* prepare(): Steps<{ all: ScannedPool[]; poolsPerDex: Record<string, number>; multi: ScannedPool[]; multiSet: Set<ScannedPool>; relevant: ScannedPool[] }> {
    const all: ScannedPool[] = yield* stateToPoolsSteps(state);
    const poolsPerDex: Record<string, number> = {};
    for (const f of factories) poolsPerDex[f.dex] = 0;
    for (let i = 0; i < all.length; i++) { if ((i & 4095) === 4095) yield; const p = all[i]; poolsPerDex[p.dex] = (poolsPerDex[p.dex] ?? 0) + 1; }

    // 2) Only pairs on 2+ pools can be arbitraged. Read balances for those,
    //    plus each of their tokens' pools against USDG/WETH (to price them).
    const count = new Map<string, number>();
    for (let i = 0; i < all.length; i++) { if ((i & 2047) === 2047) yield; const k = pairKey(all[i]); count.set(k, (count.get(k) ?? 0) + 1); }
    const multi: ScannedPool[] = [];
    for (let i = 0; i < all.length; i++) { if ((i & 2047) === 2047) yield; if ((count.get(pairKey(all[i])) ?? 0) >= 2) multi.push(all[i]); }
    count.clear();
    const quote = new Set([lc(opts.usdToken), lc(opts.wrappedNative)]);
    const needPrice = new Set<string>();
    for (const p of multi) { needPrice.add(lc(p.token0)); needPrice.add(lc(p.token1)); }
    const multiSet = new Set(multi);
    const pricing: ScannedPool[] = [];
    for (let i = 0; i < all.length; i++) {
      if ((i & 2047) === 2047) yield;
      const p = all[i];
      if (!multiSet.has(p) && (
        (quote.has(lc(p.token0)) && needPrice.has(lc(p.token1))) || (quote.has(lc(p.token1)) && needPrice.has(lc(p.token0))))) pricing.push(p);
    }
    return { all, poolsPerDex, multi, multiSet, relevant: multi.concat(pricing) };
  }
  const { all, poolsPerDex, multi, multiSet, relevant } = opts.chunked ? await runSteps(prepare(), 'chain-wide scan processing') : timed('chain-wide scan processing', () => drainSteps(prepare()));
  log(`[scan] ${all.length} pools total; reading balances for ${relevant.length}`);

  // Oct 15 (REBUILD_PACED): this step used to write two requests per pool
  // through ethers in one go (~50 microseconds each): 7.3 s for 50,000
  // pools on a fast test machine, the biggest freeze found. Now written by
  // hand (same text) with short breaks.
  const balCalls: Call[] = [];
  for (const p of relevant) {
    if (pacer.due()) await pacer.rest();
    balCalls.push({ target: p.token0, data: encBal(p.pool) });
    balCalls.push({ target: p.token1, data: encBal(p.pool) });
  }
  const bals = await callMany(balCalls);
  for (let i = 0; i < relevant.length; i++) {
    if (pacer.due()) await pacer.rest();
    const p = relevant[i];
    p.bal0 = decodeUint(bals[i * 2]) ?? 0n; p.bal1 = decodeUint(bals[i * 2 + 1]) ?? 0n;
  }

  // Solidly pools: stable-curve or volatile? (the bot can only price volatile)
  const solid = relevant.filter((p) => p.kind === 'solidly');
  const st = await callMany(solid.map((p) => ({ target: p.pool, data: paced ? CALL_STABLE : pairI.encodeFunctionData('stable') })));
  solid.forEach((p, i) => { p.stable = decodeUint(st[i]) === 1n; });

  // 3) Token decimals + symbols, read from the tokens themselves.
  // (Same list as [...new Set(relevant.flatMap(...))], built with breaks.)
  const tokenSet = new Set<string>();
  for (const p of relevant) {
    if (pacer.due()) await pacer.rest();
    tokenSet.add(lc(p.token0)); tokenSet.add(lc(p.token1));
  }
  const tokenList = [...tokenSet];
  const metaCalls: Call[] = [];
  for (const t of tokenList) {
    if (pacer.due()) await pacer.rest();
    metaCalls.push(
      { target: t, data: paced ? CALL_DECIMALS : erc20.encodeFunctionData('decimals') },
      { target: t, data: paced ? CALL_SYMBOL : erc20.encodeFunctionData('symbol') },
    );
  }
  const metaRes = await callMany(metaCalls);
  const tokens = new Map<string, TokenInfo>();
  const decimals = new Map<string, number>();
  for (let i = 0; i < tokenList.length; i++) {
    if (pacer.due()) await pacer.rest();
    const t = tokenList[i];
    const d = decodeUint(metaRes[i * 2]);
    if (d === null || d > 36n) continue; // not a standard token: its pools are skipped
    let symbol = t.slice(0, 8);
    // Paced: plain names are read by hand (same answer, ~25 microseconds
    // saved per coin); anything unusual still goes to ethers.
    const fast = paced ? fastDecodeString(metaRes[i * 2 + 1]) : null;
    if (fast !== null) symbol = fast;
    else try { symbol = String(erc20.decodeFunctionResult('symbol', metaRes[i * 2 + 1]!)[0]); } catch { /* keep short address */ }
    tokens.set(t, { symbol, decimals: Number(d) });
    decimals.set(t, Number(d));
  }

  // 4) Price, value and rank.
  const usdPrice = paced ? await runSteps(derivePricesSteps(relevant, decimals, opts.usdToken, opts.wrappedNative), 'pool scan pricing', sliceMs)
    : derivePrices(relevant, decimals, opts.usdToken, opts.wrappedNative);
  for (const p of relevant) {
    if (pacer.due()) await pacer.rest();
    p.usd = poolUsd(p, decimals, usdPrice);
  }
  let { multiPoolPairs, candidates } = paced ? await runSteps(rankCandidatesSteps(multi, minPoolUsd), 'pool scan pricing', sliceMs) : rankCandidates(multi, minPoolUsd);

  // 5) Uniswap V4, asked per pair (see core/v4Lookup.ts for why not from
  //    its history). Only pairs with a USDG/WETH side:
  //    a) pairs on ONE exchange so far: one cheap read each (the USDG/WETH
  //       balance in that pool); keep those with real money. They become
  //       candidates if V4 has a pool for them too.
  //    b) pairs already picked: V4 may add a deeper second pool.
  //    Nothing here is saved in the map; a V4 failure never fails the scan.
  let v4: ScanResult['v4'];
  if (opts.v4) {
    try {
      const qs = [lc(opts.usdToken), lc(opts.wrappedNative)];
      const wethUsd = usdPrice.get(qs[1]) ?? 0;
      const qUsd = (q: string) => (q === qs[0] ? 1 : q === qs[1] ? wethUsd : 0);
      const qDec = (q: string) => decimals.get(q);
      if (!(wethUsd > 0) || qDec(qs[0]) === undefined || qDec(qs[1]) === undefined) throw new Error('no WETH price yet');
      const quoteOf = (p: ScannedPool): string | null => {
        const a = lc(p.token0), b = lc(p.token1);
        if (qs.includes(a) && qs.includes(b)) return null; // USDG/WETH itself: plenty of pools already
        return qs.includes(a) ? a : qs.includes(b) ? b : null;
      };
      // a) single-exchange pairs with a USDG/WETH side, one balance read each.
      // (Same list as all.filter(...), built with breaks: ~400,000 pools.)
      const singles: ScannedPool[] = [];
      for (const p of all) {
        if (pacer.due()) await pacer.rest();
        if (!multiSet.has(p) && p.kind !== 'solidly' && quoteOf(p) !== null) singles.push(p);
      }
      const withMoney: ScannedPool[] = [];
      const SLICE = 4_000;
      for (let i = 0; i < singles.length; i += SLICE) {
        const slice = singles.slice(i, i + SLICE);
        const res = await callMany(slice.map((p) => ({ target: quoteOf(p)!, data: encBal(p.pool) })));
        slice.forEach((p, j) => {
          const q = quoteOf(p)!, raw = decodeUint(res[j]);
          if (raw === null) return;
          // 2 x the USDG/WETH side: an upper bound for V3-style pools; the
          // bot re-reads exact prices before any decision.
          const usd = 2 * units(raw, qDec(q)!) * qUsd(q);
          if (usd >= minPoolUsd) { p.usd = usd; withMoney.push(p); }
        });
        if (i + SLICE < singles.length) await sleep(opts.v4.pauseMs ?? 500);
      }
      // Deepest first, capped (memory/time safety).
      withMoney.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
      const kept = withMoney.slice(0, opts.v4.maxPairs ?? 5_000);
      // b) + pairs already picked that have a USDG/WETH side.
      const pairs = new Map<string, { quote: string; other: string }>();
      const addPair = (p: { token0: string; token1: string }) => {
        const q = quoteOf(p as ScannedPool); if (!q) return;
        const other = lc(p.token0) === q ? lc(p.token1) : lc(p.token0);
        pairs.set(pairKey(p), { quote: q, other });
      };
      // Already-picked pairs first, then the deepest single-exchange pairs.
      for (const c of candidates) addPair({ token0: c.tokenA, token1: c.tokenB });
      for (const p of kept) addPair(p);
      // Every pair gets the 4 standard V4 settings. The non-standard ones
      // seen on real pools (config/v4Tiers.ts, ~30 more) go only to the first
      // V4_EXTRA_TIER_PAIRS pairs (default 1,000: the picked pairs and the
      // deepest others), and pairs are asked in batches, so memory and
      // requests stay bounded (the V4 scan has run out of memory before).
      const list = [...pairs.values()];
      const extraN = opts.v4.extraTierPairs ?? 1_000;
      const found: ScannedPool[] = [];
      const BATCH = 300;
      for (let i = 0; i < list.length; i += BATCH) {
        const batch = list.slice(i, i + BATCH);
        // Freeze fix (Oct 20): ids worked out with short breaks (and remembered between scans).
        const asks = await v4AsksPaced(batch, opts.wrappedNative, (j) => (i + j < extraN ? V4_TIERS : STANDARD_V4_TIERS));
        found.push(...await findV4Pools(callMany, asks, {
          stateView: opts.v4.stateView, poolManager: opts.v4.poolManager, weth: opts.wrappedNative,
          quoteUsd: qUsd, quoteDecimals: qDec, minUsd: minPoolUsd,
        }));
        if (i + BATCH < list.length) await sleep(opts.v4.pauseMs ?? 500);
      }
      if (found.length) ({ candidates } = paced ? await runSteps(rankCandidatesSteps([...multi, ...kept, ...found], minPoolUsd), 'pool scan pricing', sliceMs) : rankCandidates([...multi, ...kept, ...found], minPoolUsd));
      v4 = { singles: singles.length, withMoney: withMoney.length, pairsAsked: pairs.size, found: found.length,
        candidatesWithV4: candidates.filter((c) => c.pools.some((p) => p.kind === 'v4')).length };
      log(`[scan] v4 lookup: ${singles.length} single-exchange pairs checked, ${withMoney.length} with $${minPoolUsd}+; asked V4 about ${pairs.size} pairs, found ${found.length} V4 pools with $${minPoolUsd}+`);
    } catch (err) {
      errors.push(`uniswap-v4 lookup: ${String((err as any)?.shortMessage ?? (err as any)?.message ?? err).slice(0, 120)}`);
    }
  }

  return { poolsPerDex, totalPools: all.length, multiPoolPairs, candidates, tokens, usdPrice, usedMulticall: multicall, errors, v4 };
}
