import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';
import type { ScannedPool, ScanState } from './universeScan';

// ============================================================================
// TOKEN GROUPS -- coins that should be worth the same (loop measurement, step 1)
//
// Plain English:
//   Some coins should be worth the same as each other: dollar coins (USDG,
//   USDC, USDT...), ETH and WETH, the Bitcoin versions (WBTC, cbBTC...),
//   bridged copies of one coin, and the same stock from different issuers.
//   If two of them drift apart, a 3-way loop can pick up the gap. Before we
//   use any coin in a loop, it has to be VERIFIED, because lookalike scam
//   coins copy real names:
//     - the name (symbol) only makes a coin a CANDIDATE, never trusted;
//     - verified = it has a real pool against USDG or WETH with at least
//       $10,000 in it, AND its price there is within 2% of its group's value.
//   Group value: dollars = $1, ETH = WETH's price, Bitcoin / copies / stocks =
//   the price of the group's deepest verified member.
//   Staked ETH (stETH, wstETH, rETH, weETH...) is skipped for now.
//
// The result is saved to data/token-groups.json and printed on the status
// page so a person can review it. Read-only: never trades.
// ============================================================================

export type GroupKind = 'dollar' | 'eth' | 'btc' | 'copy';

export interface GroupCandidate { token: string; symbol: string }

// Best pool of a coin against USDG or WETH (read on chain).
export interface QuotePrice { priceUsd: number; depthUsd: number; pool: string }

export interface GroupMember {
  token: string;           // lowercase
  symbol: string;          // as read on chain (NOT trusted on its own)
  group: string;           // "Dollars", "ETH", "Bitcoin", or "Copies of TSLA"
  kind: GroupKind;
  priceUsd: number;
  depthUsd: number;        // money in its deepest USDG/WETH pool
  offPct: number;          // how far from the group's value
  pool: string;            // that pool
}

export interface Rejected { token: string; symbol: string; group: string; why: string }

export interface TokenGroupsResult {
  version: 1;
  updatedAt: number;
  members: GroupMember[];  // verified only
  rejected: Rejected[];    // candidates that failed (biggest first, capped)
}

export const MIN_GROUP_DEPTH_USD = 10_000;
export const MAX_GROUP_OFF_PCT = 2;

// Staked / yield-bearing ETH: priced differently from ETH, skipped for now.
const STAKED_ETH = /^(st|wst|r|cb|we|ez|rs|os|sw|m|s|b|frx|sfrx|ankr|lido)eth/i;

// Which group a symbol MIGHT belong to (a candidate only).
export function classifySymbol(sym: string): { kind: GroupKind; group: string } | null {
  const s = sym.trim();
  if (!s || s.length > 12) return null;
  const u = s.toUpperCase();
  // Dollars: USDG, USDC, USDT, USDT0, USDC.e, PYUSD, DAI, ...
  if (/^[A-Z]{0,4}\.?USD[A-Z0-9₮]{0,3}(\.[A-Z]{1,2})?$/.test(u) || ['DAI', 'FRAX', 'GHO', 'LUSD', 'SUSD', 'CRVUSD'].includes(u)) {
    return { kind: 'dollar', group: 'Dollars' };
  }
  // ETH and wrapped ETH (not staked versions).
  if (/^(W?ETH|ETH\.E|WETH\.E|AXLETH|AXLWETH)$/.test(u) && !STAKED_ETH.test(s)) return { kind: 'eth', group: 'ETH' };
  // Bitcoin versions: WBTC, cbBTC, tBTC, BTC.b, kBTC, ...
  if (/^[A-Z]{0,4}\.?BTC(\.[A-Z]{1,2})?$/.test(u)) return { kind: 'btc', group: 'Bitcoin' };
  return null;
}

// Core name for spotting copies: strips a lower-case issuer prefix or suffix
// and ".e"/".b" style bridge tags. "bAAPL", "AAPLx", "AAPL.e" -> "AAPL".
// Copies must still prove themselves with a deep pool and a close price.
export function copyKey(sym: string): string | null {
  let s = sym.trim().replace(/\.[a-zA-Z]{1,2}$/, '');   // AAPL.e -> AAPL
  s = s.replace(/^[a-z]{1,4}(?=[A-Z0-9])/, '');          // bAAPL, axlUSDC -> AAPL, USDC
  s = s.replace(/(?<=[A-Z0-9])[a-z]{1,2}$/, '');          // AAPLx -> AAPL
  s = s.toUpperCase();
  return /^[A-Z0-9]{2,10}$/.test(s) ? s : null;
}

// Candidates by symbol: the fixed groups, plus "copies" (2+ coins sharing a
// core name). Pure: decides nothing about trust.
export function pickCandidates(tokens: GroupCandidate[]): (GroupCandidate & { kind: GroupKind; group: string })[] {
  const out: (GroupCandidate & { kind: GroupKind; group: string })[] = [];
  const byKey = new Map<string, GroupCandidate[]>();
  for (const t of tokens) {
    const c = classifySymbol(t.symbol);
    if (c) { out.push({ ...t, ...c }); continue; }
    if (STAKED_ETH.test(t.symbol)) continue;
    const k = copyKey(t.symbol);
    if (k) (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(t);
  }
  for (const [k, list] of byKey) {
    const uniq = [...new Map(list.map((t) => [t.token.toLowerCase(), t])).values()];
    if (uniq.length >= 2) for (const t of uniq) out.push({ ...t, kind: 'copy', group: `Copies of ${k}` });
  }
  return out;
}

// Verify candidates against their real pools. Pure (unit-tested).
//   prices: each candidate's deepest pool against USDG/WETH (missing = none)
//   anchors: USDG and WETH are the yardsticks themselves and always verified.
export function verifyGroups(
  cands: (GroupCandidate & { kind: GroupKind; group: string })[],
  prices: Map<string, QuotePrice>,
  anchors: { usdg: string; weth: string; wethUsd: number },
  minDepthUsd = MIN_GROUP_DEPTH_USD, maxOffPct = MAX_GROUP_OFF_PCT,
): { members: GroupMember[]; rejected: Rejected[] } {
  const members: GroupMember[] = [];
  const rejected: Rejected[] = [];
  const usdg = anchors.usdg.toLowerCase(), weth = anchors.weth.toLowerCase();
  const byGroup = new Map<string, typeof cands>();
  for (const c of cands) (byGroup.get(c.group) ?? byGroup.set(c.group, []).get(c.group)!).push(c);

  for (const [group, list] of byGroup) {
    const deep: { c: (typeof cands)[number]; q: QuotePrice }[] = [];
    for (const c of list) {
      const t = c.token.toLowerCase();
      if (t === usdg || t === weth) continue; // added below as anchors
      const q = prices.get(t);
      if (!q) { rejected.push({ token: t, symbol: c.symbol, group, why: 'no pool against USDG or WETH' }); continue; }
      if (!(q.depthUsd >= minDepthUsd)) { rejected.push({ token: t, symbol: c.symbol, group, why: `only $${Math.round(q.depthUsd)} in its best pool` }); continue; }
      deep.push({ c, q });
    }
    const kind = list[0].kind;
    // The group's value.
    let value: number | null = null;
    if (kind === 'dollar') value = 1;
    else if (kind === 'eth') value = anchors.wethUsd > 0 ? anchors.wethUsd : null;
    else if (deep.length) value = [...deep].sort((a, b) => b.q.depthUsd - a.q.depthUsd)[0].q.priceUsd;
    const ok: GroupMember[] = [];
    for (const { c, q } of deep) {
      const off = value ? Math.abs(q.priceUsd / value - 1) * 100 : Infinity;
      if (off > maxOffPct) { rejected.push({ token: c.token.toLowerCase(), symbol: c.symbol, group, why: `price $${q.priceUsd.toPrecision(4)} is ${Number.isFinite(off) ? off.toFixed(1) + '%' : 'far'} from the group value` }); continue; }
      ok.push({ token: c.token.toLowerCase(), symbol: c.symbol, group, kind, priceUsd: q.priceUsd, depthUsd: q.depthUsd, offPct: off, pool: q.pool });
    }
    // Copies / Bitcoin need 2+ verified members to be a group at all.
    if ((kind === 'copy' || kind === 'btc') && ok.length < 2) {
      for (const m of ok) rejected.push({ token: m.token, symbol: m.symbol, group, why: 'only verified member of its group' });
      continue;
    }
    members.push(...ok);
  }
  // The yardsticks.
  members.push({ token: usdg, symbol: 'USDG', group: 'Dollars', kind: 'dollar', priceUsd: 1, depthUsd: Infinity, offPct: 0, pool: '' });
  if (anchors.wethUsd > 0) members.push({ token: weth, symbol: 'WETH', group: 'ETH', kind: 'eth', priceUsd: anchors.wethUsd, depthUsd: Infinity, offPct: 0, pool: '' });
  members.sort((a, b) => a.group.localeCompare(b.group) || b.depthUsd - a.depthUsd);
  // Most useful rejections first: the fixed groups (likely lookalikes), then
  // coins with real money but the wrong price, then shallow ones. The long
  // tail of same-name junk coins is cut off.
  const rank = (r: Rejected) => (r.group.startsWith('Copies') ? 10 : 0) + (r.why.startsWith('price') ? 0 : r.why.startsWith('only $') ? 1 : 2);
  rejected.sort((a, b) => rank(a) - rank(b) || a.group.localeCompare(b.group));
  return { members, rejected: rejected.slice(0, 60) };
}

// Pools in the scan that pair a token directly with USDG or WETH.
export function quotePools(pools: ScannedPool[], usdg: string, weth: string): Map<string, ScannedPool[]> {
  const u = usdg.toLowerCase(), w = weth.toLowerCase();
  const out = new Map<string, ScannedPool[]>();
  for (const p of pools) {
    const t0 = p.token0.toLowerCase(), t1 = p.token1.toLowerCase();
    const q = t0 === u || t0 === w ? t0 : t1 === u || t1 === w ? t1 : null;
    if (!q) continue;
    const tok = q === t0 ? t1 : t0;
    if (tok === u || tok === w) { // the WETH/USDG pools themselves: both directions
      (out.get(t0) ?? out.set(t0, []).get(t0)!).push(p);
      (out.get(t1) ?? out.set(t1, []).get(t1)!).push(p);
      continue;
    }
    (out.get(tok) ?? out.set(tok, []).get(tok)!).push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// On-chain reading (through the gentle scan lane)
// ---------------------------------------------------------------------------
type CallMany = (calls: { target: string; data: string }[]) => Promise<(string | null)[]>;
const SEL_SYMBOL = '0x95d89b41';
const SEL_DECIMALS = '0x313ce567';
const SEL_BALANCE = '0x70a08231';
const SEL_RESERVES = '0x0902f1ac';
const SEL_SLOT0 = '0x3850c7bd';
const SEL_STABLE = '0x22be3de1';
const pad = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const big = (r: string | null, i = 0) => { try { return r && r.length >= 2 + 64 * (i + 1) ? BigInt('0x' + r.slice(2 + 64 * i, 2 + 64 * (i + 1))) : null; } catch { return null; } };

export function decodeSymbol(r: string | null): string | null {
  if (!r || r === '0x') return null;
  try {
    if (r.length >= 194) { // dynamic string: offset, length, data
      const len = Number(BigInt('0x' + r.slice(66, 130)));
      if (len > 64) return null;
      return Buffer.from(r.slice(130, 130 + len * 2), 'hex').toString('utf8').replace(/[^\x20-\x7e₮]/g, '') || null;
    }
    return Buffer.from(r.slice(2, 66), 'hex').toString('utf8').replace(/[^\x20-\x7e]/g, '') || null; // bytes32 symbol
  } catch { return null; }
}

// Symbols already read, saved between runs (symbols don't change). Only
// coins paired directly with USDG or WETH are read.
export interface SymbolCache { upTo: number; symbols: Record<string, string> }

export function loadSymbolCache(file: string): SymbolCache {
  try { const d = JSON.parse(readFileSync(file, 'utf8')); if (typeof d.upTo === 'number' && d.symbols) return d; } catch { /* first run */ }
  return { upTo: 0, symbols: {} };
}
const saveJson = (file: string, data: unknown) => {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify(data, null, 1));
    renameSync(file + '.tmp', file);
  } catch { /* best effort */ }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Full build: read new symbols, pick candidates, price them on their real
// pools, verify, save. A few hundred requests the first time (symbols), then
// only new coins' symbols plus a handful of price reads.
export async function buildTokenGroups(deps: {
  callMany: CallMany;
  state: ScanState;
  pools: ScannedPool[];               // stateToPools(state)
  usdg: string; weth: string;
  symbolCacheFile: string;
  outFile: string;
  pauseMs?: number;                   // between symbol bundles (default 2 s)
  log?: (m: string) => void;
}): Promise<TokenGroupsResult> {
  const log = deps.log ?? (() => {});
  const usdg = deps.usdg.toLowerCase(), weth = deps.weth.toLowerCase();
  const qp = quotePools(deps.pools, usdg, weth);

  // 1) Symbols of coins paired with USDG/WETH that we haven't read yet.
  const cache = loadSymbolCache(deps.symbolCacheFile);
  const todo = deps.state.tokens.slice(cache.upTo).filter((t) => qp.has(t.toLowerCase()) && !(t.toLowerCase() in cache.symbols));
  const BUNDLE = 400;
  for (let i = 0; i < todo.length; i += BUNDLE) {
    const slice = todo.slice(i, i + BUNDLE);
    const res = await deps.callMany(slice.map((t) => ({ target: t, data: SEL_SYMBOL })));
    slice.forEach((t, j) => { cache.symbols[t.toLowerCase()] = decodeSymbol(res[j]) ?? ''; });
    if (i + BUNDLE < todo.length) await sleep(deps.pauseMs ?? 2_000);
  }
  cache.upTo = deps.state.tokens.length;
  saveJson(deps.symbolCacheFile, cache);
  log(`[groups] symbols: ${todo.length} new read, ${Object.keys(cache.symbols).length} known`);

  // 2) Candidates by name (never trusted on its own).
  const cands = pickCandidates(Object.entries(cache.symbols).filter(([, s]) => s).map(([token, symbol]) => ({ token, symbol })));
  for (const t of [usdg, weth]) if (!cands.some((c) => c.token === t)) cands.push({ token: t, symbol: t === usdg ? 'USDG' : 'WETH', ...(t === usdg ? { kind: 'dollar' as const, group: 'Dollars' } : { kind: 'eth' as const, group: 'ETH' }) });

  // 3) Price each candidate on its USDG/WETH pools (plus WETH itself).
  const need = [...new Set(cands.map((c) => c.token))];
  const pools = [...new Map(need.flatMap((t) => qp.get(t) ?? []).filter((p) => !p.stable).map((p) => [p.pool.toLowerCase(), p])).values()];
  const toks = [...new Set([...need, usdg, weth, ...pools.flatMap((p) => [p.token0.toLowerCase(), p.token1.toLowerCase()])])];
  const metaRes = await deps.callMany(toks.map((t) => ({ target: t, data: SEL_DECIMALS })));
  const dec = new Map<string, number>();
  toks.forEach((t, i) => { const d = big(metaRes[i]); if (d !== null && d <= 36n) dec.set(t, Number(d)); });
  const calls: { target: string; data: string }[] = [];
  for (const p of pools) {
    calls.push({ target: p.token0, data: SEL_BALANCE + pad(p.pool) }, { target: p.token1, data: SEL_BALANCE + pad(p.pool) });
    calls.push(p.kind === 'v3' ? { target: p.pool, data: SEL_SLOT0 } : { target: p.pool, data: SEL_RESERVES });
    calls.push(p.kind === 'solidly' ? { target: p.pool, data: SEL_STABLE } : { target: p.pool, data: SEL_RESERVES });
  }
  const res = await deps.callMany(calls);
  const read = pools.map((p, i) => {
    const b0 = big(res[i * 4]), b1 = big(res[i * 4 + 1]);
    const d0 = dec.get(p.token0.toLowerCase()), d1 = dec.get(p.token1.toLowerCase());
    if (b0 === null || b1 === null || d0 === undefined || d1 === undefined) return null;
    if (p.kind === 'solidly' && big(res[i * 4 + 3]) === 1n) return null; // stable-curve pool: not a plain price
    let px: number | null = null; // token1 per token0
    if (p.kind === 'v3') {
      const s = big(res[i * 4 + 2]);
      if (s && s > 0n) { const x = Number(s) / 2 ** 96; px = x * x * 10 ** (d0 - d1); }
    } else {
      const r0 = big(res[i * 4 + 2], 0), r1 = big(res[i * 4 + 2], 1);
      if (r0 && r1) px = (Number(r1) / 10 ** d1) / (Number(r0) / 10 ** d0);
    }
    if (!px || !Number.isFinite(px)) return null;
    return { p, px, a0: Number(b0) / 10 ** d0, a1: Number(b1) / 10 ** d1 };
  }).filter((x): x is NonNullable<typeof x> => !!x);

  // WETH's price: its deepest pool against USDG.
  let wethUsd = 0, bestW = 0;
  for (const r of read) {
    const t0 = r.p.token0.toLowerCase(), t1 = r.p.token1.toLowerCase();
    if (!((t0 === weth && t1 === usdg) || (t0 === usdg && t1 === weth))) continue;
    const usdAmt = t0 === usdg ? r.a0 : r.a1;
    const px = t0 === weth ? r.px : 1 / r.px;
    if (usdAmt > bestW) { bestW = usdAmt; wethUsd = px; }
  }
  const quoteUsd = (q: string) => (q === usdg ? 1 : q === weth ? wethUsd : 0);
  const prices = new Map<string, QuotePrice>();
  for (const r of read) {
    const t0 = r.p.token0.toLowerCase(), t1 = r.p.token1.toLowerCase();
    for (const [tok, q, pxInQ, qAmt, tAmt] of [[t0, t1, r.px, r.a1, r.a0], [t1, t0, 1 / r.px, r.a0, r.a1]] as const) {
      const qu = quoteUsd(q);
      if (!qu || tok === usdg) continue;
      const priceUsd = pxInQ * qu;
      // Money in the pool: 2 x the smaller side (a pool stuffed with one coin isn't deep).
      const depthUsd = 2 * Math.min(qAmt * qu, tAmt * priceUsd);
      const prev = prices.get(tok);
      if (!prev || depthUsd > prev.depthUsd) prices.set(tok, { priceUsd, depthUsd, pool: r.p.pool.toLowerCase() });
    }
  }

  // 4) Verify and save.
  const { members, rejected } = verifyGroups(cands, prices, { usdg, weth, wethUsd });
  const out: TokenGroupsResult = { version: 1, updatedAt: Date.now(), members, rejected };
  saveJson(deps.outFile, out);
  log(`[groups] ${groupsStatusLine(out)}`);
  return out;
}

// One line for the status page (and the log): every verified coin by group.
export function groupsStatusLine(r: TokenGroupsResult): string {
  const by = new Map<string, string[]>();
  for (const m of r.members) (by.get(m.group) ?? by.set(m.group, []).get(m.group)!).push(`${m.symbol} ${m.token.slice(0, 6)}…${m.token.slice(-4)} ${Number.isFinite(m.depthUsd) ? '$' + Math.round(m.depthUsd / 1000) + 'k' : 'anchor'}${m.offPct ? ' ' + m.offPct.toFixed(2) + '% off' : ''}`);
  return `verified coins: ${[...by.entries()].map(([g, xs]) => `${g}: ${xs.join(', ')}`).join(' | ')} · ${r.rejected.length} candidate(s) rejected`;
}

export function loadTokenGroups(file: string): TokenGroupsResult | null {
  try { const d = JSON.parse(readFileSync(file, 'utf8')); return d?.version === 1 && Array.isArray(d.members) ? d : null; } catch { return null; }
}
