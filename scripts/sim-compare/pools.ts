// ============================================================================
// SIM-COMPARE: which pools, which routes, which sizes.
//
// Plain English:
//   The bot's watch list (data/watched-pools.json, written by the bot every
//   10 minutes) says which pools it follows and the coins' decimals. From it
//   we build the same 2-pool round trips the bot checks: buy on one pool of a
//   coin pair, sell on another pool of the SAME pair, start and end in the
//   coin we hold (USDG, else WETH, the bot's "start coin" rule since Oct 16).
//
//   The bot's own code decides everything it can:
//     - kindForPool / canPracticeTestVenue: which pools a check may use
//     - buildExecuteCall: the hops and the amount (exactly as the bot builds them)
//     - pickV3Lender: which pool lends for the flash-loan variant
//   What is simplified (stated in the report and README):
//     - sizes are a fixed list per start coin (--sizes-usdg / --sizes-weth)
//       instead of the bot's per-trade size search; the question "do both
//       engines give the same answer?" doesn't depend on the size chosen
//     - every route is checked with own money, and one size also with a
//       flash loan when a lender exists, so BOTH code paths are compared
//     - pairs with neither USDG nor WETH are skipped (the bot can't start there)
// ============================================================================
import { readFileSync } from 'fs';
import { PoolState } from '../../src/core/types';
import { buildExecuteCall, kindForPool, pickV3Lender, ExecutorHop, KIND_V2, KIND_SOLIDLY, KIND_V3, KIND_V4, KIND_V4_HOOKED } from '../../src/execution/executorCalldata';
import { canPracticeTestVenue } from '../../src/config/robinhoodVenues';
import { ROBINHOOD_TOKENS } from '../../src/config/knownAddresses';
import { bigReviver, lc } from './util';

export const USDG = lc(ROBINHOOD_TOKENS.USDG);
export const WETH = lc(ROBINHOOD_TOKENS.WETH);

export interface PoolBook {
  pools: Map<string, PoolState>;            // lowercase address / V4 id -> pool
  byPair: Map<string, PoolState[]>;         // "tokenA/tokenB" (sorted, lowercase) -> tradeable pools
  meta: Map<string, { symbol: string; decimals: number }>;
  skipped: Record<string, number>;          // why some watched pools can't be used
  savedAt: number | null;
}

export const pairKey = (a: string, b: string) => [lc(a), lc(b)].sort().join('/');

// Route type of one pool, in words used by the report.
export function poolKindLabel(p: PoolState): string | null {
  const k = kindForPool(p);
  if (k === null) return null;
  if (p.variant === 'algebra') return 'Algebra';
  return ({ [KIND_V2]: 'V2', [KIND_SOLIDLY]: 'Solidly', [KIND_V3]: 'V3', [KIND_V4]: 'V4', [KIND_V4_HOOKED]: 'V4-hooked' } as Record<number, string>)[k] ?? `kind${k}`;
}

// Reads the bot's watch-list file. Pools the contract can't trade, or that
// the bot may not practice-test, are left out (counted in `skipped`).
export function loadPoolBook(file: string): PoolBook {
  const d = JSON.parse(readFileSync(file, 'utf8'), bigReviver);
  if (d?.version !== 1 || !Array.isArray(d.pools)) throw new Error(`${file}: not a watch-list file (version 1) from the bot`);
  return buildPoolBook(d.pools as PoolState[], d.meta ?? {}, typeof d.savedAt === 'number' ? d.savedAt : null);
}

export function buildPoolBook(list: PoolState[], metaObj: Record<string, { symbol: string; decimals: number }>, savedAt: number | null = null): PoolBook {
  const meta = new Map<string, { symbol: string; decimals: number }>();
  for (const [t, m] of Object.entries(metaObj)) if (m && Number.isInteger(m.decimals)) meta.set(lc(t), m);
  // The two coins we hold always have known decimals (same table as the bot).
  if (!meta.has(WETH)) meta.set(WETH, { symbol: 'WETH', decimals: 18 });
  if (!meta.has(USDG)) meta.set(USDG, { symbol: 'USDG', decimals: 6 });
  const pools = new Map<string, PoolState>();
  const byPair = new Map<string, PoolState[]>();
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  for (const p of list) {
    if (!p || p.chain !== 'robinhood' || !p.poolAddress || !p.tokenA || !p.tokenB) { skip('not a Robinhood pool'); continue; }
    if (kindForPool(p) === null) { skip(`contract can't trade ${p.dex}/${p.poolType}`); continue; }
    if (!canPracticeTestVenue(p.dex)) { skip(`venue ${p.dex} not practice-tested`); continue; }
    const addr = lc(p.poolAddress);
    if (pools.has(addr)) continue;
    pools.set(addr, p);
    const k = pairKey(p.tokenA, p.tokenB);
    (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(p);
  }
  return { pools, byPair, meta, skipped, savedAt };
}

export const symbolOf = (book: PoolBook, t: string) => book.meta.get(lc(t))?.symbol ?? t.slice(0, 8);

// The coin a round trip on this pair starts and ends with (null = skip pair).
export function startCoinOf(a: string, b: string): string | null {
  const s = new Set([lc(a), lc(b)]);
  if (s.has(USDG)) return USDG;
  if (s.has(WETH)) return WETH;
  return null;
}

export interface SizeConfig { usdg: number[]; weth: number[] }
export const DEFAULT_SIZES: SizeConfig = { usdg: [100, 1000, 5000], weth: [0.03, 0.3, 1.5] };

// One fully built route: what simulateRoundTrip needs, plus labels.
export interface RouteSpec {
  pair: string;
  token: string;
  amountIn: bigint;
  sizeLabel: string;
  hops: ExecutorHop[];
  kinds: string;
  buyPool: PoolState; sellPool: PoolState;
  funding: 'own' | 'flash';
  v3Lender: string | null;
}

// Every route the bot could check between `buy` and `sell` (buy on `buy`,
// sell on `sell`), at each size, own money; plus one flash-loan variant.
// Built by the bot's own buildExecuteCall; a route it refuses is skipped
// and counted in `refused`.
export function routesFor(
  book: PoolBook, buy: PoolState, sell: PoolState, sizes: SizeConfig,
  refused: Record<string, number>, flashLenders: Set<string> | null,
): RouteSpec[] {
  const token = startCoinOf(buy.tokenA, buy.tokenB);
  if (!token) { refused['pair has neither USDG nor WETH'] = (refused['pair has neither USDG nor WETH'] ?? 0) + 1; return []; }
  const dec = book.meta.get(token)?.decimals;
  const list = token === USDG ? sizes.usdg : sizes.weth;
  const sym = symbolOf(book, token);
  const kinds = `${poolKindLabel(buy)}>${poolKindLabel(sell)}`;
  const pair = `${symbolOf(book, buy.tokenA)}/${symbolOf(book, buy.tokenB)}`;
  const out: RouteSpec[] = [];
  // usdPerTokenIn = 1 makes "tradeSizeUsd" a plain token amount, so the
  // bot's own rounding (usdToTokenUnits) turns it into base units.
  const build = (size: number, v3Lender?: string) => buildExecuteCall({
    chain: 'robinhood', tokenIn: token, buyPool: buy, sellPool: sell, tradeSizeUsd: size, netProfitUsd: size / 1e6 || 1e-9,
    usdPerTokenIn: 1, tokenInDecimals: dec, maxBlock: 0n, ...(v3Lender ? { v3Lender } : {}),
  });
  for (const size of list) {
    const b = build(size);
    if ('reason' in b) { refused[b.reason] = (refused[b.reason] ?? 0) + 1; continue; }
    out.push({ pair, token, amountIn: b.amountIn, sizeLabel: `${size} ${sym}`, hops: b.hops, kinds, buyPool: buy, sellPool: sell, funding: 'own', v3Lender: null });
  }
  // Flash variant at the middle size, borrowing like the bot does (cheapest
  // V3 pool holding the coin, never one of the trade's own pools).
  const mid = list[Math.floor(list.length / 2)];
  if (mid !== undefined) {
    const candidates = [...book.pools.values()].filter((p) => !flashLenders || flashLenders.has(lc(p.poolAddress)));
    const lender = pickV3Lender(candidates, token, [buy.poolAddress, sell.poolAddress]);
    if (lender) {
      const b = build(mid, lender.poolAddress);
      if (!('reason' in b)) out.push({ pair, token, amountIn: b.amountIn, sizeLabel: `${mid} ${sym} (flash)`, hops: b.hops, kinds, buyPool: buy, sellPool: sell, funding: 'flash', v3Lender: lender.poolAddress });
      else refused[b.reason] = (refused[b.reason] ?? 0) + 1;
    } else refused['no flash lender for the coin'] = (refused['no flash lender for the coin'] ?? 0) + 1;
  }
  return out;
}

// All routes through pool `p` and each other pool of its pair, both directions.
export function routesThrough(book: PoolBook, p: PoolState, sizes: SizeConfig, refused: Record<string, number>, flashLenders: Set<string> | null): RouteSpec[] {
  const partners = (book.byPair.get(pairKey(p.tokenA, p.tokenB)) ?? []).filter((q) => lc(q.poolAddress) !== lc(p.poolAddress));
  const out: RouteSpec[] = [];
  for (const q of partners) out.push(...routesFor(book, p, q, sizes, refused, flashLenders), ...routesFor(book, q, p, sizes, refused, flashLenders));
  return out;
}

// Every route on every watched pair (for standing-gap sampling).
export function allRoutes(book: PoolBook, sizes: SizeConfig, refused: Record<string, number>, flashLenders: Set<string> | null): RouteSpec[] {
  const out: RouteSpec[] = [];
  for (const ps of book.byPair.values()) {
    for (const a of ps) for (const b of ps) if (a !== b) out.push(...routesFor(book, a, b, sizes, refused, flashLenders));
  }
  return out;
}

// FLASH_LENDERS_ROBINHOOD from the environment (NOT read from the bot's
// .env, which we never read beyond node URLs). Not set = any pool, which is
// what the bot's practice checks do when the list isn't set either.
export function flashLendersFromEnv(env: Record<string, string | undefined> = process.env): Set<string> | null {
  const s = new Set((env.FLASH_LENDERS_ROBINHOOD ?? '').split(',').map((a) => lc(a.trim())).filter(Boolean));
  return s.size ? s : null;
}
