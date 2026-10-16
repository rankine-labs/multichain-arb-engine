import { ethers } from 'ethers';
import { RivalWatch, MAX_PLAUSIBLE_PROFIT_SHARE, MAX_PROFIT_NO_SIZE_USD } from './rivalWatch';

// ============================================================================
// FOLLOW THE MONEY -- the pure (no network) part of the arbitrage study.
//
// Plain English:
//   Outside research says other bots make tens of thousands of dollars a day
//   from arbitrage on Robinhood Chain, while our bot only finds about
//   $50-150 a day it could take. This file holds the logic that answers
//   "where does that money go?" from raw chain data:
//     1. read every swap event of every exchange type we know (decodeSwapLog)
//     2. for a transaction that swapped in 2+ pools, work out who gained and
//        lost which coins (classifyTx): an arbitrage ends with more of some
//        coin and less of none
//     3. put dollar prices on coins from the swaps themselves (buildPriceBook)
//     4. turn each arbitrage into dollars, route, exchange, watched or not,
//        and timing (priceArb, timingOf)
//     5. add it all up into a plain-English report and a CSV (buildReport)
//   The script scripts/follow-the-money.ts does the network reading and
//   calls these functions. Everything here is read-only maths: it never
//   sends anything, never touches keys and never changes how the bot trades.
// ============================================================================

// ---------------------------------------------------------------------------
// Swap events of every exchange type the repo knows about.
// ---------------------------------------------------------------------------
export const FTM_TOPICS = {
  // Uniswap V2 copies (Uniswap V2, PancakeSwap V2, most "classic" pairs)
  V2_SWAP: ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)'),
  // Solidly / Velodrome V2 style pairs (sender and recipient first)
  SOLIDLY_SWAP: ethers.id('Swap(address,address,uint256,uint256,uint256,uint256)'),
  // Uniswap V3 copies, Ramses V3, SushiSwap V3, Algebra V1, Slipstream
  V3_SWAP: ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)'),
  // PancakeSwap V3 copies (two extra protocol fee fields)
  PANCAKE_V3_SWAP: ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)'),
  // Algebra Integral copies (Alandale, KittenSwap)
  ALGEBRA_SWAP: ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24,uint24,uint24)'),
  // Uniswap V4 PoolManager (pool id instead of a pool address; Fables too)
  V4_SWAP: ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'),
  // Trader Joe Liquidity Book / DLMM bins (Ramses DLMM style)
  LB_SWAP: ethers.id('Swap(address,address,uint24,bytes32,bytes32,uint24,bytes32,bytes32)'),
  // Balancer V2 vault
  BALANCER_SWAP: ethers.id('Swap(bytes32,address,address,uint256,uint256)'),
  // Curve pools (amounts need extra look-ups, so only counted)
  CURVE_EXCHANGE: ethers.id('TokenExchange(address,int128,uint256,int128,uint256)'),
};

export type SwapKind = 'v2' | 'solidly' | 'v3' | 'pancake-v3' | 'algebra' | 'v4' | 'lb' | 'balancer' | 'curve';

export const SWAP_KIND_BY_TOPIC: Record<string, SwapKind> = {
  [FTM_TOPICS.V2_SWAP]: 'v2',
  [FTM_TOPICS.SOLIDLY_SWAP]: 'solidly',
  [FTM_TOPICS.V3_SWAP]: 'v3',
  [FTM_TOPICS.PANCAKE_V3_SWAP]: 'pancake-v3',
  [FTM_TOPICS.ALGEBRA_SWAP]: 'algebra',
  [FTM_TOPICS.V4_SWAP]: 'v4',
  [FTM_TOPICS.LB_SWAP]: 'lb',
  [FTM_TOPICS.BALANCER_SWAP]: 'balancer',
  [FTM_TOPICS.CURVE_EXCHANGE]: 'curve',
};
export const ALL_SWAP_TOPICS: string[] = Object.keys(SWAP_KIND_BY_TOPIC);

// Short codes so the saved progress file stays small.
export const KIND_CODES: SwapKind[] = ['v2', 'solidly', 'v3', 'pancake-v3', 'algebra', 'v4', 'lb', 'balancer', 'curve'];

const TRANSFER = ethers.id('Transfer(address,address,uint256)');
// Flash loans the rival watch does not already list.
const EXTRA_FLASH_TOPICS = new Set([
  ethers.id('FlashLoan(address,address,uint256)'),            // Morpho Blue
  ethers.id('FlashLoan(address,address,uint256,uint256,uint256)'), // Euler style
]);
// Uniswap V4 pool creation: tells us which two coins a pool id holds.
export const V4_INITIALIZE = ethers.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
export const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

export type RawLog = { address: string; topics: string[]; data: string; logIndex?: string; blockNumber?: string; transactionHash?: string; transactionIndex?: string };

const lc = (x: string) => (x ?? '').toLowerCase();
const addrFromTopic = (t: string) => '0x' + t.slice(26).toLowerCase();
const word = (data: string, i: number): string | null => {
  const hex = data?.startsWith('0x') ? data.slice(2) : data ?? '';
  const w = hex.slice(i * 64, i * 64 + 64);
  return w.length === 64 ? w : null;
};
const uint = (w: string | null): bigint | null => (w === null ? null : BigInt('0x' + w));
const int = (w: string | null): bigint | null => (w === null ? null : BigInt.asIntN(256, BigInt('0x' + w)));
const abs = (x: bigint) => (x < 0n ? -x : x);
const MASK128 = (1n << 128n) - 1n;

// One swap, read from its event. Amounts are from the POOL's side:
// positive = the pool received that coin, negative = the pool paid it out.
export interface DecodedSwap {
  pool: string;          // pool address, or V4 / Balancer pool id
  kind: SwapKind;
  a0?: bigint;           // token0 change for the pool (when the event says)
  a1?: bigint;           // token1 change for the pool
  sender?: string;       // V4 only: who called the PoolManager
  tin?: string;          // Balancer only: coin in (named in the event)
  tout?: string;         // Balancer only: coin out
  ain?: bigint; aout?: bigint;
}

// Reads one swap event. Returns null for anything that is not a swap we know.
export function decodeSwapLog(l: { address: string; topics: string[]; data: string }): DecodedSwap | null {
  const t0 = l?.topics?.[0]?.toLowerCase();
  if (!t0) return null;
  const kind = SWAP_KIND_BY_TOPIC[t0];
  if (!kind) return null;
  try {
    switch (kind) {
      case 'v2': case 'solidly': {
        // Both store amount0In, amount1In, amount0Out, amount1Out in the data.
        const [i0, i1, o0, o1] = [0, 1, 2, 3].map((i) => uint(word(l.data, i)));
        if (i0 === null || i1 === null || o0 === null || o1 === null) return { pool: lc(l.address), kind };
        return { pool: lc(l.address), kind, a0: i0 - o0, a1: i1 - o1 };
      }
      case 'v3': case 'pancake-v3': case 'algebra': {
        // amount0 / amount1 are already from the pool's side.
        const a0 = int(word(l.data, 0)), a1 = int(word(l.data, 1));
        return a0 === null || a1 === null ? { pool: lc(l.address), kind } : { pool: lc(l.address), kind, a0, a1 };
      }
      case 'v4': {
        // V4 reports the SWAPPER's side (negative = swapper paid), so flip it.
        if (l.topics.length < 3) return null;
        const a0 = int(word(l.data, 0)), a1 = int(word(l.data, 1));
        const pool = l.topics[1].toLowerCase();
        const sender = addrFromTopic(l.topics[2]);
        return a0 === null || a1 === null ? { pool, kind, sender } : { pool, kind, a0: -a0, a1: -a1, sender };
      }
      case 'lb': {
        // Liquidity Book packs two amounts per word: X in the low 128 bits, Y in the high.
        const inW = uint(word(l.data, 1)), outW = uint(word(l.data, 2));
        if (inW === null || outW === null) return { pool: lc(l.address), kind };
        return { pool: lc(l.address), kind, a0: (inW & MASK128) - (outW & MASK128), a1: (inW >> 128n) - (outW >> 128n) };
      }
      case 'balancer': {
        if (l.topics.length < 4) return null;
        const ain = uint(word(l.data, 0)), aout = uint(word(l.data, 1));
        return { pool: l.topics[1].toLowerCase(), kind, tin: addrFromTopic(l.topics[2]), tout: addrFromTopic(l.topics[3]), ...(ain !== null ? { ain } : {}), ...(aout !== null ? { aout } : {}) };
      }
      case 'curve':
        return { pool: lc(l.address), kind };
    }
  } catch { return null; }
  return null;
}

// Who called the pool in a swap event (the bot contract for most arbitrage,
// a DEX router for most normal trades). Null when the event doesn't say.
export function swapCaller(l: { topics: string[] }): string | null {
  const t0 = l?.topics?.[0]?.toLowerCase();
  const kind = t0 ? SWAP_KIND_BY_TOPIC[t0] : undefined;
  if (!kind || kind === 'balancer' || kind === 'curve') return null;
  const t = kind === 'v4' ? l.topics[2] : l.topics[1];
  return t && t.length === 66 ? addrFromTopic(t) : null;
}

// Coins whose decimals we never need to ask the chain for (the bot's own
// TOKEN_DECIMALS in shadowMain: WETH 18, USDG 6). Without USDG here a run
// that never reached the look-up step could not price anything at all.
export const KNOWN_DECIMALS: Record<string, number> = {
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73': 18, // WETH
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 6,  // USDG
};

// ETH price from a Uniswap V3 style pool's slot0 sqrtPriceX96.
//   wethIsToken0 = WETH is the pool's token0 (the lower address)
export function ethUsdFromSqrtPrice(sqrtPriceX96: bigint, wethIsToken0: boolean, wethDec = 18, usdDec = 6): number | null {
  if (sqrtPriceX96 <= 0n) return null;
  const r = Number(sqrtPriceX96) / 2 ** 96;
  const raw = r * r; // token1 per token0, in raw units
  const px = wethIsToken0 ? raw * 10 ** (wethDec - usdDec) : (1 / raw) * 10 ** (wethDec - usdDec);
  return isFinite(px) && px > 0 ? px : null;
}
// ETH price from a V2 pair's reserves.
export function ethUsdFromReserves(rWeth: bigint, rUsd: bigint, wethDec = 18, usdDec = 6): number | null {
  if (rWeth <= 0n || rUsd <= 0n) return null;
  const px = (Number(rUsd) / 10 ** usdDec) / (Number(rWeth) / 10 ** wethDec);
  return isFinite(px) && px > 0 ? px : null;
}

// Order in which to read candidate transactions when time is short: the
// ones most likely to be arbitrage first.
//   - pool caller already PROVEN to be an arbitrage bot in this run: first
//   - known DEX routers (normal user trades): last
//   - otherwise, callers that show up in many multi-pool transactions first
//     (bots repeat; people trading through a router mostly don't)
// `idx` = candidate indexes still to read; returns them reordered.
export function orderCandidates(
  idx: number[], callerOf: (i: number) => string, routers: Set<string>, proven: Map<string, number>,
): number[] {
  const count = new Map<string, number>();
  for (const i of idx) { const c = callerOf(i); if (c) count.set(c, (count.get(c) ?? 0) + 1); }
  const score = (i: number) => {
    const c = callerOf(i);
    if (!c) return 0;
    if (routers.has(c)) return -1;
    return (proven.has(c) ? 1e9 + (proven.get(c) ?? 0) * 1e3 : 0) + (count.get(c) ?? 0);
  };
  // Stable sort: equal scores keep chain order.
  return idx.map((i, k) => ({ i, k, s: score(i) })).sort((a, b) => b.s - a.s || a.k - b.k).map((x) => x.i);
}

// ---------------------------------------------------------------------------
// Classifying one transaction from its receipt.
// ---------------------------------------------------------------------------

// One step of a route: which pool, which coin went in and which came out.
export interface Hop {
  pool: string;
  kind: SwapKind;
  tin?: string; tout?: string;   // coins (lowercase); WETH stands in for plain ETH
  ain?: string; aout?: string;   // raw amounts as text
}

// Everything we keep about one arbitrage (prices are applied later).
export interface ArbRecord {
  hash: string;
  block: number;
  txIndex: number;
  from: string;               // wallet that sent it
  to: string;                 // contract it called
  executor: string;           // whose coins we counted (usually = to)
  executorIsTo: boolean;
  swaps: number;              // swap events
  pools: string[];            // distinct pools, in route order
  hops: Hop[];
  net: [string, string][];    // coin -> raw gain (all >= 0 for an arbitrage)
  outflow: [string, string][];// coin -> raw amount the trader sent out
  sentElsewhere: boolean;     // profit went to a third address in the same tx
  externals: string[];        // those third addresses
  flash: boolean;
  flashHow: 'event' | 'borrow-repay' | null;
  uncertain: string[];        // reasons the result may be off (e.g. hidden plain ETH leg)
  gasWei: string;             // gasUsed * effectiveGasPrice (+ L1 fee when listed separately)
  l1GasUsed?: string;         // Arbitrum: part of gasUsed paid for L1 data
  value?: string;             // plain ETH the transaction carried
}

// What a receipt classification found (arb or the reason it is not one).
export type ClassifyReason = 'one-pool' | 'failed' | 'user-swap' | 'no-gain' | 'arb';
export interface ClassifyResult { reason: ClassifyReason; arb: ArbRecord | null }

export interface ClassifyOptions {
  poolManager?: string;   // Uniswap V4 PoolManager (holds every V4 pool's coins)
  weth: string;           // plain ETH is counted as WETH
  // Which two coins a V4 pool holds (address(0) = plain ETH), when known.
  v4Currencies?: (poolId: string) => { c0: string; c1: string } | null;
}

// Net coin changes for a set of addresses, from Transfer logs (reuses the
// rival watch's own maths so both tools count the same way).
function flowsFor(logs: RawLog[], who: string[], pm?: string) {
  return RivalWatch.analyze(logs as any, who, pm);
}

// Coins sent by `who` to addresses outside the trade.
function recipientsOf(logs: RawLog[], who: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const l of logs) {
    if (l.topics?.[0] !== TRANSFER || l.topics.length < 3) continue;
    const from = addrFromTopic(l.topics[1]), to = addrFromTopic(l.topics[2]);
    if (who.has(from) && !who.has(to)) out.add(to);
  }
  return out;
}

// The contract doing the work when tx.to is only a forwarder: the address
// (not a pool, not a coin) that both sends and receives the most transfers.
export function findHub(logs: RawLog[], exclude: Set<string>): string | null {
  const tokens = new Set(logs.filter((l) => l.topics?.[0] === TRANSFER).map((l) => lc(l.address)));
  const sends = new Map<string, number>(), gets = new Map<string, number>();
  for (const l of logs) {
    if (l.topics?.[0] !== TRANSFER || l.topics.length < 3) continue;
    const from = addrFromTopic(l.topics[1]), to = addrFromTopic(l.topics[2]);
    sends.set(from, (sends.get(from) ?? 0) + 1);
    gets.set(to, (gets.get(to) ?? 0) + 1);
  }
  let best: string | null = null, bestN = 0;
  for (const [a, s] of sends) {
    const g = gets.get(a) ?? 0;
    if (!g || exclude.has(a) || tokens.has(a) || a === ZERO_ADDR) continue;
    if (s + g > bestN) { best = a; bestN = s + g; }
  }
  return best;
}

// Borrow-then-repay: some outside address (not a pool) sent the trader a coin
// and got at least the same amount of that coin back in the same transaction.
export function borrowRepay(logs: RawLog[], traders: Set<string>, pools: Set<string>): boolean {
  const lent = new Map<string, bigint>(), back = new Map<string, bigint>();
  for (const l of logs) {
    if (l.topics?.[0] !== TRANSFER || l.topics.length < 3) continue;
    const from = addrFromTopic(l.topics[1]), to = addrFromTopic(l.topics[2]);
    let v: bigint; try { v = BigInt(l.data); } catch { continue; }
    const tok = lc(l.address);
    if (!traders.has(from) && traders.has(to) && !pools.has(from) && from !== ZERO_ADDR) {
      const k = tok + '|' + from; lent.set(k, (lent.get(k) ?? 0n) + v);
    } else if (traders.has(from) && !traders.has(to) && !pools.has(to)) {
      const k = tok + '|' + to; back.set(k, (back.get(k) ?? 0n) + v);
    }
  }
  for (const [k, v] of lent) if (v > 0n && (back.get(k) ?? 0n) >= v) return true;
  return false;
}

// Per-pool coin in / coin out, from the Transfer logs (pool's own side).
function poolEdges(logs: RawLog[], pool: string): { tin?: string; tout?: string; ain?: bigint; aout?: bigint } {
  const net = new Map<string, bigint>();
  for (const l of logs) {
    if (l.topics?.[0] !== TRANSFER || l.topics.length < 3) continue;
    const from = addrFromTopic(l.topics[1]), to = addrFromTopic(l.topics[2]);
    if (from !== pool && to !== pool) continue;
    let v: bigint; try { v = BigInt(l.data); } catch { continue; }
    const tok = lc(l.address);
    net.set(tok, (net.get(tok) ?? 0n) + (to === pool ? v : -v));
  }
  let tin: string | undefined, tout: string | undefined, ain = 0n, aout = 0n;
  for (const [t, v] of net) {
    if (v > ain) { ain = v; tin = t; }
    if (-v > aout) { aout = -v; tout = t; }
  }
  return { ...(tin ? { tin, ain } : {}), ...(tout ? { tout, aout } : {}) };
}

// Decides whether one transaction was an arbitrage, and records what it did.
//   logs   = receipt logs, from/to = tx sender and called contract
//   gasWei = what the sender paid for gas
export function classifyTx(
  logs: RawLog[], from: string, to: string | null | undefined, status: string | number | undefined,
  meta: { hash: string; block: number; txIndex: number; gasWei: bigint; l1GasUsed?: bigint; value?: bigint },
  opts: ClassifyOptions,
): ClassifyResult {
  if (status === '0x0' || status === 0) return { reason: 'failed', arb: null };
  const pm = opts.poolManager?.toLowerCase();
  const weth = opts.weth.toLowerCase();
  const fromL = lc(from), toL = lc(to ?? '');

  // 1. Swaps and their pools, in log order.
  const swaps: DecodedSwap[] = [];
  for (const l of logs ?? []) { const s = decodeSwapLog(l); if (s) swaps.push(s); }
  const pools: string[] = [];
  for (const s of swaps) if (!pools.includes(s.pool)) pools.push(s.pool);
  if (pools.length < 2) return { reason: 'one-pool', arb: null };
  const poolSet = new Set(pools);

  // 2. Whose coins count: the called contract and the sender wallet.
  let traders = [toL, fromL].filter((x) => x && x !== ZERO_ADDR);
  let tr = flowsFor(logs, traders, pm);
  let executor = toL, executorIsTo = true;
  if (tr.net.size === 0) {
    // tx.to never touched a coin: it forwarded the call. Find the real worker.
    const hub = findHub(logs, new Set([...poolSet, pm ?? '', fromL]));
    if (hub) {
      traders = [hub, toL, fromL].filter((x) => x && x !== ZERO_ADDR);
      tr = flowsFor(logs, traders, pm);
      executor = hub; executorIsTo = hub === toL;
    }
  }
  const who = new Set(traders);

  // 3. Plain ETH legs of V4 pools leave no Transfer log. When the trader
  // itself called the PoolManager we can add that leg from the Swap event
  // (as WETH, the same way the bot counts plain ETH).
  const net = new Map(tr.net);
  const uncertain: string[] = [];
  for (const s of swaps) {
    if (s.kind !== 'v4' || s.a0 === undefined || s.a1 === undefined) continue;
    const cur = opts.v4Currencies?.(s.pool) ?? null;
    if (!cur) { if (!uncertain.includes('v4-pool-unknown')) uncertain.push('v4-pool-unknown'); continue; }
    const legs: [string, bigint][] = [[lc(cur.c0), -s.a0], [lc(cur.c1), -s.a1]]; // swapper's side again
    for (const [c, d] of legs) {
      if (c !== ZERO_ADDR) continue;
      if (s.sender && who.has(s.sender)) net.set(weth, (net.get(weth) ?? 0n) + d);
      else if (!uncertain.includes('v4-native-leg-hidden')) uncertain.push('v4-native-leg-hidden');
    }
  }

  // 4. Shape: arbitrage = ends with more of something and less of nothing.
  const moves = () => [...net.values()].filter((v) => v !== 0n);
  let sentElsewhere = false;
  let externals: string[] = [];
  if (moves().some((v) => v < 0n)) return { reason: 'user-swap', arb: null };
  if (!moves().some((v) => v > 0n)) {
    // No gain kept, nothing lost: did the gain go straight to a third address?
    externals = [...recipientsOf(logs, who)].filter((a) => !poolSet.has(a) && a !== pm && a !== ZERO_ADDR);
    if (!externals.length) return { reason: 'no-gain', arb: null };
    const wider = flowsFor(logs, [...traders, ...externals], pm);
    const m2 = [...wider.net.values()].filter((v) => v !== 0n);
    if (!m2.length || m2.some((v) => v < 0n)) return { reason: 'no-gain', arb: null };
    net.clear();
    for (const [k, v] of wider.net) net.set(k, v);
    sentElsewhere = true;
  }

  // 5. Flash loan: a real loan event, or the borrow-then-repay pattern.
  let flashHow: ArbRecord['flashHow'] = null;
  if (tr.flash || (logs ?? []).some((l) => EXTRA_FLASH_TOPICS.has(l.topics?.[0]))) flashHow = 'event';
  else if (borrowRepay(logs, who, new Set([...poolSet, pm ?? '']))) flashHow = 'borrow-repay';

  // 6. Route: coin in / coin out per pool.
  const hops: Hop[] = pools.map((p) => {
    const s = swaps.find((x) => x.pool === p)!;
    if (s.kind === 'balancer') return { pool: p, kind: s.kind, tin: s.tin, tout: s.tout, ain: s.ain?.toString(), aout: s.aout?.toString() };
    if (s.kind === 'v4') {
      // Sum every swap event on this pool in the transaction.
      let a0 = 0n, a1 = 0n;
      for (const x of swaps) if (x.pool === p) { a0 += x.a0 ?? 0n; a1 += x.a1 ?? 0n; }
      const cur = opts.v4Currencies?.(p) ?? null;
      if (!cur) return { pool: p, kind: s.kind };
      const c0 = lc(cur.c0) === ZERO_ADDR ? weth : lc(cur.c0), c1 = lc(cur.c1) === ZERO_ADDR ? weth : lc(cur.c1);
      return a0 > 0n ? { pool: p, kind: s.kind, tin: c0, tout: c1, ain: a0.toString(), aout: abs(a1).toString() }
        : { pool: p, kind: s.kind, tin: c1, tout: c0, ain: a1.toString(), aout: abs(a0).toString() };
    }
    const e = poolEdges(logs, p);
    return { pool: p, kind: s.kind, tin: e.tin, tout: e.tout, ain: e.ain?.toString(), aout: e.aout?.toString() };
  });

  const arb: ArbRecord = {
    hash: meta.hash, block: meta.block, txIndex: meta.txIndex,
    from: fromL, to: toL, executor, executorIsTo,
    swaps: swaps.length, pools, hops,
    net: [...net.entries()].filter(([, v]) => v !== 0n).map(([k, v]) => [k, v.toString()]),
    outflow: [...tr.outflow.entries()].filter(([, v]) => v !== 0n).map(([k, v]) => [k, v.toString()]),
    sentElsewhere, externals,
    flash: flashHow !== null, flashHow,
    uncertain,
    gasWei: meta.gasWei.toString(),
    ...(meta.l1GasUsed !== undefined ? { l1GasUsed: meta.l1GasUsed.toString() } : {}),
    ...(meta.value !== undefined ? { value: meta.value.toString() } : {}),
  };
  return { reason: 'arb', arb };
}

// Gas paid by a receipt, in wei. Arbitrum chains already include the L1 part
// in gasUsed (gasUsedForL1 just says how much of it); OP-style chains list
// the L1 fee separately (l1Fee), which is added.
export function receiptGasWei(r: any): { gasWei: bigint; l1GasUsed?: bigint } {
  const q = (x: any): bigint => { try { return x === undefined || x === null ? 0n : BigInt(x); } catch { return 0n; } };
  const gasWei = q(r?.gasUsed) * q(r?.effectiveGasPrice ?? r?.gasPrice) + q(r?.l1Fee);
  return r?.gasUsedForL1 !== undefined ? { gasWei, l1GasUsed: q(r.gasUsedForL1) } : { gasWei };
}

// ---------------------------------------------------------------------------
// Prices from the swaps themselves.
// ---------------------------------------------------------------------------

// One seen exchange rate: `rate` units of `quote` per 1 unit of `token`,
// `quoteAmt` = how much quote coin changed hands (for volume / weighting).
export interface PriceObs { block: number; pool: string; token: string; quote: string; rate: number; quoteAmt: number }

// Builds exchange-rate observations from one swap with known coins/decimals.
// Only rates against a "quote" coin (a dollar coin or WETH) are kept.
export function obsFromSwap(
  block: number, pool: string, t0: string, t1: string, a0: bigint, a1: bigint,
  dec0: number, dec1: number, isQuote: (t: string) => boolean,
): PriceObs[] {
  if (a0 === 0n || a1 === 0n || (a0 > 0n) === (a1 > 0n)) return []; // not a clean swap
  const x0 = Number(abs(a0)) / 10 ** dec0, x1 = Number(abs(a1)) / 10 ** dec1;
  if (!(x0 > 0) || !(x1 > 0) || !isFinite(x0) || !isFinite(x1)) return [];
  const out: PriceObs[] = [];
  if (isQuote(t1)) out.push({ block, pool, token: lc(t0), quote: lc(t1), rate: x1 / x0, quoteAmt: x1 });
  if (isQuote(t0)) out.push({ block, pool, token: lc(t1), quote: lc(t0), rate: x0 / x1, quoteAmt: x0 });
  return out;
}

export interface PriceAt { usd: number; how: 'stable' | 'pool' | 'fixed'; pool?: string; volumeUsd: number }

export interface PriceBook {
  ethAt(block: number): number | null;
  usdAt(token: string, block: number): PriceAt | null;
  priced(): string[];
}

// Median of the k observations nearest in block to `block` (series sorted by block).
function nearestMedian(series: { block: number; usd: number }[], block: number, k: number): number | null {
  if (!series.length) return null;
  let lo = 0, hi = series.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (series[mid].block < block) lo = mid + 1; else hi = mid; }
  let l = lo - 1, r = lo;
  const pick: number[] = [];
  while (pick.length < k && (l >= 0 || r < series.length)) {
    const dl = l >= 0 ? block - series[l].block : Infinity;
    const dr = r < series.length ? series[r].block - block : Infinity;
    if (dl <= dr) pick.push(series[l--].usd); else pick.push(series[r++].usd);
  }
  pick.sort((a, b) => a - b);
  return pick[Math.floor(pick.length / 2)] ?? null;
}

// Prices for every coin we saw traded against a dollar coin or WETH.
//   - dollar coins = $1
//   - WETH from its swaps against dollar coins (or `ethFallbackUsd`)
//   - other coins from their busiest pool against a dollar coin or WETH,
//     taking the median of the 7 swaps nearest in time
export function buildPriceBook(obs: PriceObs[], stables: Set<string>, weth: string, opts: { k?: number; ethFallbackUsd?: number | null } = {}): PriceBook {
  const k = opts.k ?? 7;
  const W = weth.toLowerCase();
  const st = new Set([...stables].map(lc));
  const ethSeries = obs.filter((o) => o.token === W && st.has(o.quote)).map((o) => ({ block: o.block, usd: o.rate })).sort((a, b) => a.block - b.block);
  const fallback = opts.ethFallbackUsd ?? null;
  const ethAt = (b: number): number | null => nearestMedian(ethSeries, b, k) ?? fallback;
  const quoteUsd = (q: string, b: number) => (st.has(q) ? 1 : q === W ? ethAt(b) : null);
  // Per coin, per pool: dollar series and dollar volume.
  const per = new Map<string, Map<string, { series: { block: number; usd: number }[]; vol: number }>>();
  for (const o of obs) {
    if (st.has(o.token) || o.token === W) continue;
    const qp = quoteUsd(o.quote, o.block);
    if (qp === null) continue;
    const m = per.get(o.token) ?? new Map();
    const e = m.get(o.pool) ?? { series: [], vol: 0 };
    e.series.push({ block: o.block, usd: o.rate * qp });
    e.vol += o.quoteAmt * qp;
    m.set(o.pool, e); per.set(o.token, m);
  }
  const main = new Map<string, { pool: string; series: { block: number; usd: number }[]; vol: number }>();
  for (const [t, m] of per) {
    let best: { pool: string; series: { block: number; usd: number }[]; vol: number } | null = null;
    for (const [pool, e] of m) if (!best || e.vol > best.vol) best = { pool, ...e };
    if (best) { best.series.sort((a, b) => a.block - b.block); main.set(t, best); }
  }
  const ethVol = obs.filter((o) => o.token === W && st.has(o.quote)).reduce((s, o) => s + o.quoteAmt, 0);
  return {
    ethAt,
    usdAt(token: string, block: number): PriceAt | null {
      const t = lc(token);
      if (st.has(t)) return { usd: 1, how: 'stable', volumeUsd: Infinity };
      if (t === W) {
        const e = ethAt(block);
        return e === null ? null : { usd: e, how: ethSeries.length ? 'pool' : 'fixed', volumeUsd: ethSeries.length ? ethVol : Infinity };
      }
      const m = main.get(t);
      if (!m) return null;
      const u = nearestMedian(m.series, block, k);
      return u === null ? null : { usd: u, how: 'pool', pool: m.pool, volumeUsd: m.vol };
    },
    priced: () => [...st, ...(ethSeries.length || fallback ? [W] : []), ...main.keys()],
  };
}

// ---------------------------------------------------------------------------
// One arbitrage in dollars.
// ---------------------------------------------------------------------------

export type Trust = 'ok' | 'unpriced' | 'doubtful';
export type Timing = 'backrun-big' | 'backrun-small' | 'prev-block' | 'standalone';

export interface PricedArb {
  rec: ArbRecord;
  timeMs: number;
  sizeUsd: number | null;
  grossUsd: number | null;
  gasUsd: number | null;
  netUsd: number | null;
  trust: Trust;
  doubtWhy: string[];
  profitToken: string;
  path: string;            // e.g. "USDG > WETH > USDG"
  dexes: string[];         // exchange per pool (same order as rec.pools)
  watched: 'all' | 'some' | 'none';
  unwatchedPools: string[];
  supportedAll: boolean;   // every pool on an exchange our bot can trade
  timing: Timing;
  unpricedWhy: string[];   // why the dollar result is missing, e.g. "no market price: TOK"
}

export interface PriceCtx {
  book: PriceBook;
  decimals: (token: string) => number | null;
  symbol: (token: string) => string;
  dexOf: (pool: string) => string;
  isWatched: (pool: string) => boolean;
  botCanTrade: (dex: string) => boolean;
  timeOf: (block: number) => number;
  timing: (rec: ArbRecord) => Timing;
  thinVolumeUsd?: number;  // a coin priced from less trading than this is "thin" (default $1,000)
  weth?: string;           // WETH address (only used to explain "no ETH price")
}

// Dollar value of a raw coin amount (null if no price or no decimals).
export function usdOf(ctx: Pick<PriceCtx, 'book' | 'decimals'>, token: string, raw: bigint, block: number): { usd: number; thin: boolean; volumeUsd: number } | null {
  const d = ctx.decimals(token);
  const p = ctx.book.usdAt(token, block);
  if (d === null || d === undefined || !p) return null;
  return { usd: (Number(raw) / 10 ** d) * p.usd, thin: false, volumeUsd: p.volumeUsd };
}

export function priceArb(rec: ArbRecord, ctx: PriceCtx): PricedArb {
  const thinV = ctx.thinVolumeUsd ?? 1_000;
  const doubtWhy: string[] = [];
  // Same-trade prices: a coin with no market price can still be valued from
  // a hop in this very transaction that swapped it for a priced coin.
  const localUsd = (token: string): number | null => {
    for (const h of rec.hops) {
      if (!h.tin || !h.tout || !h.ain || !h.aout) continue;
      const other = h.tin === token ? h.tout : h.tout === token ? h.tin : null;
      if (!other) continue;
      const amtT = BigInt(h.tin === token ? h.ain : h.aout), amtO = BigInt(h.tin === token ? h.aout : h.ain);
      const u = usdOf(ctx, other, amtO, rec.block);
      const d = ctx.decimals(token);
      if (u && d !== null && amtT > 0n) return u.usd / (Number(amtT) / 10 ** d);
    }
    return null;
  };
  const unpricedWhy: string[] = [];
  const why = (w: string) => { if (!unpricedWhy.includes(w)) unpricedWhy.push(w); };
  const value = (token: string, raw: bigint): number | null => {
    const u = usdOf(ctx, token, raw, rec.block);
    if (u) { if (u.volumeUsd < thinV && !doubtWhy.includes('thin-price')) doubtWhy.push('thin-price'); return u.usd; }
    const per = localUsd(token);
    const d = ctx.decimals(token);
    if (per !== null && d !== null) { if (!doubtWhy.includes('same-trade-price')) doubtWhy.push('same-trade-price'); return (Number(raw) / 10 ** d) * per; }
    return null;
  };
  // Records why a coin in the result could not be valued (for diagnostics).
  const explain = (token: string) => {
    const name = ctx.symbol(token);
    if (ctx.decimals(token) === null || ctx.decimals(token) === undefined) why(`coin decimals unknown: ${name}`);
    else if (token.toLowerCase() === (ctx.weth ?? '').toLowerCase() && ctx.book.ethAt(rec.block) === null) why('no ETH price');
    else why(`no market price: ${name}`);
  };

  let gross = 0, unpriced = false;
  for (const [t, v] of rec.net) { const u = value(t, BigInt(v)); if (u === null) { unpriced = true; explain(t); } else gross += u; }
  if (!rec.net.length) why('no coin gain recorded');
  // Trade size: what went into the first pool, else the biggest coin sent out.
  let size: number | null = null;
  const h0 = rec.hops[0];
  if (h0?.tin && h0.ain) size = value(h0.tin, BigInt(h0.ain));
  if (size === null) for (const [t, v] of rec.outflow) { const u = value(t, BigInt(v)); if (u !== null) size = Math.max(size ?? 0, u); }
  const eth = ctx.book.ethAt(rec.block);
  const gasUsd = eth === null ? null : (Number(BigInt(rec.gasWei)) / 1e18) * eth;
  const grossUsd = unpriced || !rec.net.length ? null : gross;
  // Same plausibility rule as the rival watch: a "profit" over 5% of the
  // trade size is almost always a bad price, not real arbitrage.
  if (grossUsd !== null) {
    if (size !== null && size > 0 ? grossUsd > MAX_PLAUSIBLE_PROFIT_SHARE * size : grossUsd > MAX_PROFIT_NO_SIZE_USD) doubtWhy.push('too-good-to-be-true');
  }
  for (const u of rec.uncertain) if (u === 'v4-native-leg-hidden') doubtWhy.push(u);
  const trust: Trust = grossUsd === null ? 'unpriced'
    : doubtWhy.some((w) => w === 'too-good-to-be-true' || w === 'thin-price' || w === 'v4-native-leg-hidden') ? 'doubtful' : 'ok';

  // Profit coin(s) and the route as coin names.
  const gainers = rec.net.filter(([, v]) => BigInt(v) > 0n).map(([t]) => ctx.symbol(t));
  const profitToken = gainers.length === 1 ? gainers[0] : gainers.length ? 'mixed' : '?';
  const path: string[] = [];
  for (const h of rec.hops) {
    if (!path.length) path.push(h.tin ? ctx.symbol(h.tin) : '?');
    path.push(h.tout ? ctx.symbol(h.tout) : '?');
  }
  const dexes = rec.pools.map((p) => ctx.dexOf(p));
  const watchedN = rec.pools.filter((p) => ctx.isWatched(p)).length;
  return {
    rec, timeMs: ctx.timeOf(rec.block),
    sizeUsd: size, grossUsd, gasUsd,
    netUsd: grossUsd === null ? null : grossUsd - (gasUsd ?? 0),
    trust, doubtWhy, profitToken, path: path.join(' > '), dexes,
    watched: watchedN === rec.pools.length ? 'all' : watchedN ? 'some' : 'none',
    unwatchedPools: rec.pools.filter((p) => !ctx.isWatched(p)),
    supportedAll: dexes.every((d) => ctx.botCanTrade(d)),
    timing: ctx.timing(rec),
    unpricedWhy: grossUsd === null ? unpricedWhy : [],
  };
}

// ---------------------------------------------------------------------------
// Timing: did the arbitrage come right after someone else's swap on the same
// pool (a "backrun"), or on its own?
// ---------------------------------------------------------------------------

// Compact swap row kept from the event scan:
//   [block, txIndex, pool index, kind code, a0 text, a1 text]
export type SwapRow = [number, number, number, number, string, string];

// Rows must be sorted by block. Returns the first row index for `block`.
export function firstRowOfBlock(rows: SwapRow[], block: number): number {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid][0] < block) lo = mid + 1; else hi = mid; }
  return lo;
}

// Looks for swaps on the arbitrage's pools by OTHER transactions just before
// it: earlier in the same block, or in the previous block.
//   swapUsd = dollar size of a swap row (null if unknown); big = at least bigUsd.
export function timingOf(
  rec: { block: number; txIndex: number; pools: string[] }, rows: SwapRow[], poolIndex: (p: string) => number | undefined,
  swapUsd: (row: SwapRow) => number | null, bigUsd: number,
): Timing {
  const idx = new Set(rec.pools.map(poolIndex).filter((x) => x !== undefined));
  let sameAny = false, sameBig = false, prev = false;
  for (let i = firstRowOfBlock(rows, rec.block - 1); i < rows.length && rows[i][0] <= rec.block; i++) {
    const r = rows[i];
    if (!idx.has(r[2])) continue;
    if (r[0] === rec.block) {
      if (r[1] >= rec.txIndex) continue;
      sameAny = true;
      const u = swapUsd(r);
      if (u !== null && u >= bigUsd) sameBig = true;
    } else prev = true;
  }
  return sameBig ? 'backrun-big' : sameAny ? 'backrun-small' : prev ? 'prev-block' : 'standalone';
}

// ---------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------

export interface ReportInput {
  dateLabel: string;            // e.g. 2026-10-16
  fromBlock: number; toBlock: number;
  fromMs: number; toMs: number;
  swaps: number;                // swap events seen
  swapTxs: number;              // transactions with at least one swap
  multiSwapTxs: number;         // transactions with 2+ swap events
  multiPoolTxs: number;         // transactions with swaps in 2+ different pools (checked)
  checked: number;              // of those, receipts actually read
  reasons: Record<string, number>; // classification counts
  arbs: PricedArb[];
  botName?: (addr: string) => string;
  pairOf: (pool: string) => string;     // "WETH/USDG" or "?"
  dexSupport: (dex: string) => string;  // "trades" / "practice only" / "reads prices only" / "no"
  watchInfo: string;            // where the watch list came from
  ethUsd: number | null;
  bigSwapUsd: number;
  notes: string[];              // extra lines (data files missing, etc.)
  diag?: ReportDiag;            // how well pricing worked (diagnostics section)
}

// Numbers that show whether pricing worked, and why not when it didn't.
export interface ReportDiag {
  coinsNeeded: number; coinsWithDecimals: number;
  poolsNeeded: number; poolsWithTokens: number;
  priceObs: number;             // exchange rates seen (swaps against USDG / dollar coins / WETH)
  ethObs: number;               // of those, WETH against a dollar coin
  ethSource: string;            // where the ETH price came from
  coverage?: string;            // e.g. "read 8,360 of 35,263 (most promising first)"
}

// Top reasons trades stayed unpriced, with counts.
export function unpricedReasons(arbs: PricedArb[], top = 10): [string, number][] {
  const m = new Map<string, number>();
  for (const a of arbs) if (a.trust === 'unpriced') for (const w of a.unpricedWhy.length ? a.unpricedWhy : ['unknown']) m.set(w, (m.get(w) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
}

// $1,234 / $56.7k / $1.2M; small values with cents.
export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '?';
  const s = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${s}$${(a / 1e3).toFixed(1)}k`;
  if (a >= 100) return `${s}$${Math.round(a).toLocaleString('en-US')}`;
  return `${s}$${a.toFixed(2)}`;
}
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((100 * a) / b)}%` : '-');
const median = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 8)}..${a.slice(-4)}` : a);

export function sizeBucket(v: number | null): string {
  if (v === null) return 'unknown';
  return v < 500 ? 'under $500' : v < 2_000 ? '$500-2k' : v < 5_000 ? '$2k-5k' : '$5k+';
}
export function profitBucket(v: number | null): string {
  if (v === null) return 'unknown';
  return v < 0 ? 'lost money' : v < 1 ? 'under $1' : v < 5 ? '$1-5' : v < 20 ? '$5-20' : v < 100 ? '$20-100' : '$100+';
}
export const routeBucket = (n: number) => (n <= 2 ? '2 pools' : n === 3 ? '3 pools' : '4+ pools');

// Groups trusted arbitrages by a key and adds up trades and net dollars.
function split(arbs: PricedArb[], key: (a: PricedArb) => string | string[], order?: string[]): { key: string; n: number; net: number }[] {
  const m = new Map<string, { n: number; net: number }>();
  for (const a of arbs) {
    const ks = key(a);
    for (const k of Array.isArray(ks) ? [...new Set(ks)] : [ks]) {
      const e = m.get(k) ?? { n: 0, net: 0 };
      e.n++; e.net += a.netUsd ?? 0; m.set(k, e);
    }
  }
  const rows = [...m.entries()].map(([k, e]) => ({ key: k, ...e }));
  if (order) return rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return rows.sort((a, b) => b.net - a.net);
}

function table(head: string[], rows: string[][]): string[] {
  return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)];
}

export function buildReport(r: ReportInput): { md: string; csv: string; totals: { netUsd: number; perDayUsd: number; grossUsd: number; gasUsd: number; trades: number } } {
  const hours = Math.max((r.toMs - r.fromMs) / 3_600_000, 1 / 60);
  const ok = r.arbs.filter((a) => a.trust === 'ok');
  const doubtful = r.arbs.filter((a) => a.trust === 'doubtful');
  const unpriced = r.arbs.filter((a) => a.trust === 'unpriced');
  const sum = (xs: PricedArb[], f: (a: PricedArb) => number | null) => xs.reduce((s, a) => s + (f(a) ?? 0), 0);
  const gross = sum(ok, (a) => a.grossUsd);
  const gasOk = sum(ok, (a) => a.gasUsd);
  const gasAll = sum(r.arbs, (a) => a.gasUsd);
  const net = gross - gasOk;
  const perDay = (net * 24) / hours;
  const name = r.botName ?? ((a: string) => a);
  const L: string[] = [];
  const iso = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  L.push(`# Follow the money: arbitrage on Robinhood Chain (${r.dateLabel})`);
  L.push('');
  L.push('Read-only study of real chain data. Nothing was traded or changed.');
  L.push('');
  L.push('## The period');
  L.push(`- From ${iso(r.fromMs)} to ${iso(r.toMs)} (about ${hours.toFixed(1)} hours)`);
  L.push(`- Blocks ${r.fromBlock.toLocaleString('en-US')} to ${r.toBlock.toLocaleString('en-US')} (${(r.toBlock - r.fromBlock + 1).toLocaleString('en-US')} blocks)`);
  L.push(`- Swaps seen: ${r.swaps.toLocaleString('en-US')} in ${r.swapTxs.toLocaleString('en-US')} transactions`);
  L.push(`- Transactions with 2+ swaps: ${r.multiSwapTxs.toLocaleString('en-US')} (with 2+ different pools: ${r.multiPoolTxs.toLocaleString('en-US')}, read in full: ${r.checked.toLocaleString('en-US')})`);
  L.push(`- Arbitrage transactions found: ${r.arbs.length.toLocaleString('en-US')} (dollar value trusted: ${ok.length}, doubtful: ${doubtful.length}, no price: ${unpriced.length})`);
  const rs = Object.entries(r.reasons).filter(([k]) => k !== 'arb').map(([k, v]) => `${k} ${v}`).join(', ');
  if (rs) L.push(`- Not arbitrage: ${rs} (user-swap = ended with less of a coin, a normal trade)`);
  L.push(`- ETH price used: ${fmtUsd(r.ethUsd)}`);
  L.push('');
  L.push('## The money');
  L.push(`- Profit before gas (trusted trades): ${fmtUsd(gross)}`);
  L.push(`- Gas on those trades: ${fmtUsd(gasOk)} (gas on ALL arbitrage trades: ${fmtUsd(gasAll)})`);
  L.push(`- Kept after gas: **${fmtUsd(net)}**, about **${fmtUsd(perDay)} per day** at this pace`);
  L.push(`- Doubtful trades (left out): ${doubtful.length}, they claimed ${fmtUsd(sum(doubtful, (a) => a.netUsd))} (usually bad prices on thin coins)`);
  L.push(`- Trades we could not price (left out): ${unpriced.length}`);
  L.push(`- Failed (reverted) attempts are not visible in this study, so their wasted gas is not counted.`);
  L.push('');

  // Top bots.
  const bots = new Map<string, PricedArb[]>();
  for (const a of r.arbs) { const k = a.rec.executor; const l = bots.get(k) ?? []; l.push(a); bots.set(k, l); }
  const botRows = [...bots.entries()].map(([bot, list]) => {
    const t = list.filter((a) => a.trust === 'ok');
    const n = t.reduce((s, a) => s + (a.netUsd ?? 0), 0);
    const routes = [0, 0, 0];
    for (const a of list) routes[a.rec.pools.length <= 2 ? 0 : a.rec.pools.length === 3 ? 1 : 2]++;
    const flash = list.filter((a) => a.rec.flash).length;
    return {
      bot, trades: list.length, trusted: t.length, net: n, avg: t.length ? n / t.length : null,
      size: median(t.map((a) => a.sizeUsd).filter((x): x is number => x !== null)),
      routes, watchedAll: list.filter((a) => a.watched === 'all').length,
      flash, wallets: new Set(list.map((a) => a.rec.from)).size,
    };
  }).sort((a, b) => b.net - a.net || b.trades - a.trades);
  L.push('## Who makes the money (top 15 bots)');
  L.push(`${bots.size} different bot contracts made arbitrage trades.`);
  L.push('');
  L.push(...table(['#', 'Bot contract', 'Trades', 'Kept after gas', 'Avg per trade', 'Typical size', 'Routes 2/3/4+', 'All pools watched by us', 'Flash loan', 'Wallets'],
    botRows.slice(0, 15).map((b, i) => [String(i + 1), name(b.bot), `${b.trades} (${b.trusted} priced)`, fmtUsd(b.net), fmtUsd(b.avg), fmtUsd(b.size),
      b.routes.join('/'), pct(b.watchedAll, b.trades), b.flash === 0 ? 'no' : b.flash === b.trades ? 'yes' : `sometimes (${b.flash})`, String(b.wallets)])));
  const top3 = botRows.slice(0, 3).reduce((s, b) => s + b.net, 0);
  L.push('');
  L.push(`Top 3 bots keep ${pct(top3, net)} of the money.`);
  L.push('');

  // Splits.
  const splitBlock = (title: string, rows: { key: string; n: number; net: number }[], note?: string) => {
    L.push(`### ${title}`);
    if (note) L.push(note);
    L.push(...table(['', 'Trades', 'Kept after gas', 'Share of money'], rows.map((x) => [x.key, String(x.n), fmtUsd(x.net), pct(x.net, net)])));
    L.push('');
  };
  L.push('## Where the money is (trusted trades only)');
  L.push('');
  splitBlock('Pools we watch vs not', split(ok, (a) => (a.watched === 'all' ? 'every pool watched by us' : a.watched === 'some' ? 'some pools watched' : 'no pool watched')));
  splitBlock('Route length', split(ok, (a) => routeBucket(a.rec.pools.length), ['2 pools', '3 pools', '4+ pools']), 'Our bot takes 2-pool trades; 3+ pools are loops.');
  splitBlock('Exchange', split(ok, (a) => a.dexes).map((x) => ({ ...x, key: `${x.key} (our bot: ${r.dexSupport(x.key)})` })),
    'A trade that uses two exchanges counts under both, so shares can add up to more than 100%.');
  splitBlock('Exchange combination', split(ok, (a) => [...new Set(a.dexes)].sort().join(' + ')).slice(0, 12));
  splitBlock('Coin the profit was taken in', split(ok, (a) => a.profitToken).slice(0, 12));
  splitBlock('Trade size', split(ok, (a) => sizeBucket(a.sizeUsd), ['under $500', '$500-2k', '$2k-5k', '$5k+', 'unknown']));
  splitBlock('Profit per trade (after gas)', split(ok, (a) => profitBucket(a.netUsd), ['lost money', 'under $1', '$1-5', '$5-20', '$20-100', '$100+', 'unknown']));
  splitBlock('Exchanges our bot can trade', split(ok, (a) => (a.supportedAll ? 'every pool on an exchange our bot trades' : 'needs an exchange our bot does not trade')));

  // Top unwatched pools.
  const up = new Map<string, { n: number; net: number }>();
  for (const a of ok) for (const p of new Set(a.unwatchedPools)) { const e = up.get(p) ?? { n: 0, net: 0 }; e.n++; e.net += a.netUsd ?? 0; up.set(p, e); }
  const dexByPool = new Map<string, string>();
  for (const a of r.arbs) a.rec.pools.forEach((p, i) => dexByPool.set(p, a.dexes[i]));
  L.push('## Top 20 pools we do NOT watch, by money made through them');
  L.push('A trade counts in full for every unwatched pool it used.');
  L.push('');
  L.push(...table(['#', 'Pool', 'Exchange', 'Pair', 'Trades', 'Money through it', 'Our bot can trade this exchange'],
    [...up.entries()].sort((a, b) => b[1].net - a[1].net).slice(0, 20).map(([p, e], i) => {
      const d = dexByPool.get(p) ?? '?';
      return [String(i + 1), p, d, r.pairOf(p), String(e.n), fmtUsd(e.net), r.dexSupport(d)];
    })));
  L.push('');

  // Timing.
  const tim = split(ok, (a) => a.timing, ['backrun-big', 'backrun-small', 'prev-block', 'standalone']);
  const tname: Record<string, string> = {
    'backrun-big': `right after a big swap (${fmtUsd(r.bigSwapUsd)}+) on the same pool, same block`,
    'backrun-small': 'right after a smaller swap on the same pool, same block',
    'prev-block': 'a swap on the same pool one block earlier',
    'standalone': 'no swap on its pools just before (standalone)',
  };
  L.push('## Timing: reacting to a trade, or on their own?');
  L.push(...table(['', 'Trades', 'Kept after gas', 'Share of money'], tim.map((x) => [tname[x.key] ?? x.key, String(x.n), fmtUsd(x.net), pct(x.net, net)])));
  L.push('');

  // What this means: simple rules on the numbers above.
  L.push('## What this means');
  const means: string[] = [];
  const nw = split(ok, (a) => a.watched);
  const netOf = (rows: { key: string; net: number }[], k: string) => rows.find((x) => x.key === k)?.net ?? 0;
  const notAll = net - netOf(nw, 'all');
  if (!ok.length) means.push('No trusted arbitrage was found in this period, so there is nothing to conclude yet. Try a longer period (--hours 24).');
  else {
    means.push(`Other bots kept about ${fmtUsd(perDay)} a day in this sample (outside research said up to about $65k a day; our bot finds about $50-150 a day).`);
    if (notAll > 0.5 * net) means.push(`${pct(notAll, net)} of the money went through at least one pool our bot does not watch. Watching more pools is the first lever.`);
    else means.push(`${pct(net - notAll, net)} of the money went through pools we already watch. The gap is speed or maths, not coverage.`);
    const rl = split(ok, (a) => routeBucket(a.rec.pools.length));
    const loops = net - netOf(rl, '2 pools');
    if (loops > 0.3 * net) means.push(`${pct(loops, net)} of the money came from loops (3+ pools). 2-pool trades alone miss that.`);
    const unsup = net - netOf(split(ok, (a) => (a.supportedAll ? 'y' : 'n')), 'y');
    if (unsup > 0.3 * net) means.push(`${pct(unsup, net)} of the money needed an exchange our bot cannot trade today.`);
    const back = netOf(tim, 'backrun-big') + netOf(tim, 'backrun-small');
    if (back > 0.5 * net) means.push(`${pct(back, net)} of the money came right after another swap in the same block: this is a speed race (backrunning).`);
    else if (netOf(tim, 'standalone') > 0.5 * net) means.push('Most money came from standalone trades, not from reacting to a swap: prices drifting apart between blocks.');
    if (top3 > 0.7 * net) means.push(`A few bots dominate: the top 3 keep ${pct(top3, net)}.`);
    const flashN = ok.filter((a) => a.rec.flash).length;
    means.push(`${pct(flashN, ok.length)} of trusted trades used a flash loan (borrowed money); the rest used their own coins.`);
    const small = ok.filter((a) => (a.netUsd ?? 0) < 1).length;
    if (small > 0.5 * ok.length) means.push(`${pct(small, ok.length)} of trades kept under $1 each: the money is many tiny trades.`);
    if (unpriced.length > 0.3 * r.arbs.length) means.push(`${pct(unpriced.length, r.arbs.length)} of arbitrage trades could not be priced, so the real total is likely higher than shown.`);
  }
  for (const m of means) L.push(`- ${m}`);
  L.push('');
  if (r.diag) {
    const d = r.diag;
    L.push('## Diagnostics (how well the pricing worked)');
    if (d.coverage) L.push(`- Coverage: ${d.coverage}`);
    L.push(`- Coins with known decimals: ${d.coinsWithDecimals} of ${d.coinsNeeded}`);
    L.push(`- Pools with known coins: ${d.poolsWithTokens} of ${d.poolsNeeded} (arbitrage pools plus the busiest pools)`);
    L.push(`- Price observations: ${d.priceObs.toLocaleString('en-US')} (WETH against dollar coins: ${d.ethObs.toLocaleString('en-US')})`);
    L.push(`- ETH price source: ${d.ethSource}`);
    const ur = unpricedReasons(r.arbs);
    if (ur.length) {
      L.push('- Why trades stayed unpriced (a trade can have more than one reason):');
      for (const [w, n] of ur) L.push(`  - ${w}: ${n}`);
    } else L.push('- No trade stayed unpriced.');
    L.push('');
  }
  L.push('## Notes');
  L.push(`- Watch list: ${r.watchInfo}`);
  for (const n of r.notes) L.push(`- ${n}`);
  L.push('- "Trusted" = every coin priced from a busy pool and the profit is under 5% of the trade size (same rule as the rival watch).');
  L.push('- Times are estimated from block numbers (spread evenly between the first and last block).');
  L.push('- Arbitrage is spotted from coin movements: the bot contract and the wallet that sent it end with more of a coin and less of none. Exchanges whose swaps leave no event we know are not counted.');

  // CSV with one line per arbitrage.
  const head = ['hash', 'block', 'time_utc', 'bot', 'wallet', 'pools', 'swaps', 'route', 'exchanges', 'watched', 'bot_can_trade', 'profit_coin', 'size_usd', 'gross_usd', 'gas_usd', 'net_usd', 'trust', 'doubt', 'flash', 'sent_elsewhere', 'timing', 'pool_list'];
  const esc = (x: unknown) => { const s = x === null || x === undefined ? '' : String(x); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const n2 = (x: number | null) => (x === null ? '' : x.toFixed(4));
  const csv = [head.join(','), ...r.arbs.map((a) => [
    a.rec.hash, a.rec.block, new Date(a.timeMs).toISOString(), a.rec.executor, a.rec.from, a.rec.pools.length, a.rec.swaps, a.path,
    [...new Set(a.dexes)].join('+'), a.watched, a.supportedAll ? 'yes' : 'no', a.profitToken, n2(a.sizeUsd), n2(a.grossUsd), n2(a.gasUsd), n2(a.netUsd),
    a.trust, a.doubtWhy.join(';'), a.rec.flashHow ?? 'no', a.rec.sentElsewhere ? 'yes' : 'no', a.timing, a.rec.pools.join(';'),
  ].map(esc).join(','))].join('\n') + '\n';

  return { md: L.join('\n') + '\n', csv, totals: { netUsd: net, perDayUsd: perDay, grossUsd: gross, gasUsd: gasOk, trades: ok.length } };
}

export { short as shortAddr };
