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
      // Same-name junk (hundreds of thousands of "copies" on this chain) with
      // no real pool: dropped without a note. Those notes were always cut
      // from the list anyway, and building them all cost a lot of memory.
      if (c.kind === 'copy' && (!q || !(q.depthUsd >= minDepthUsd))) continue;
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
  progressEvery?: number;             // progress line + save every N bundles (default 10)
  minDepthUsd?: number;               // pool money needed to count (default MIN_GROUP_DEPTH_USD)
  depthSlice?: number;                // pools per cheap depth-check slice (default 4,000)
  log?: (m: string) => void;
}): Promise<TokenGroupsResult> {
  const log = deps.log ?? (() => {});
  const usdg = deps.usdg.toLowerCase(), weth = deps.weth.toLowerCase();
  // Coins with a pool against USDG or WETH. A plain set, not a pool list
  // per coin: with ~400,000 such coins the lists cost ~70 MB for nothing.
  // The other side of a USDG/WETH pool (null if it touches neither).
  const otherSide = (p: ScannedPool): string | null => {
    const a = p.token0.toLowerCase(), b = p.token1.toLowerCase();
    return a === usdg || a === weth ? b : b === usdg || b === weth ? a : null;
  };
  const quoted = new Set<string>();
  for (const p of deps.pools) { const o = otherSide(p); if (o) quoted.add(o); }

  // 1) Symbols of coins paired with USDG/WETH that we haven't read yet.
  const cache = loadSymbolCache(deps.symbolCacheFile);
  const todo = deps.state.tokens.slice(cache.upTo).filter((t) => quoted.has(t.toLowerCase()) && !(t.toLowerCase() in cache.symbols));
  // On a big chain this is thousands of names on the gentle scan lane, so it
  // can take a while. Two things keep it visible and restart-safe:
  //  - a progress line every `progressEvery` bundles (the status page shows
  //    the latest one until the list is built), and
  //  - the names read so far are saved at each progress line, so a restart
  //    (e.g. a deploy) resumes where it stopped instead of starting over
  //    (`upTo` only moves when the whole step is done; already-read names
  //    are skipped by the `in cache.symbols` check above).
  const BUNDLE = 400;
  const every = Math.max(1, deps.progressEvery ?? 10);
  const t0 = Date.now();
  log(`[groups] building: reading ${todo.length} coin name(s) (${Object.keys(cache.symbols).length} already known)`);
  for (let i = 0, n = 0; i < todo.length; i += BUNDLE, n++) {
    const slice = todo.slice(i, i + BUNDLE);
    const res = await deps.callMany(slice.map((t) => ({ target: t, data: SEL_SYMBOL })));
    slice.forEach((t, j) => { cache.symbols[t.toLowerCase()] = decodeSymbol(res[j]) ?? ''; });
    const done = Math.min(todo.length, i + BUNDLE);
    if ((n + 1) % every === 0 && done < todo.length) {
      saveJson(deps.symbolCacheFile, cache);
      log(`[groups] building: coin names ${done} of ${todo.length} read (${Math.round((Date.now() - t0) / 1000)}s)`);
    }
    if (done < todo.length) await sleep(deps.pauseMs ?? 2_000);
  }
  cache.upTo = deps.state.tokens.length;
  saveJson(deps.symbolCacheFile, cache);
  log(`[groups] symbols: ${todo.length} new read, ${Object.keys(cache.symbols).length} known (${Math.round((Date.now() - t0) / 1000)}s)`);

  // 2) + 3) Candidates and their prices.
  //
  // On Robinhood Chain names repeat by the thousands (launchpad meme coins),
  // so "2+ coins with the same name" (copies) matched ~400,000 coins. Pricing
  // all of them in full never finished, and just keeping a record per coin
  // ran the bot out of memory. So the money check comes FIRST:
  //   a) WETH's price from the WETH/USDG pools (needed for the money check).
  //   b) Cheap money check on every pool of a named coin: ONE read per pool,
  //      the USDG/WETH balance in it. A pool's "money in it" is 2 x its
  //      smaller side, so a pool holding less than half the minimum in
  //      USDG/WETH can never qualify. Exact (an upper bound): no real coin
  //      is lost. Only a set of the coins that pass is kept.
  //   c) Candidates by name (never trusted on their own): the fixed groups
  //      (dollars, ETH, Bitcoin; few, kept even if shallow so lookalikes
  //      show up as rejected) plus copies among coins that passed (b).
  //   d) Full price read only for the candidates' pools that passed.
  const minDepthUsd = deps.minDepthUsd ?? MIN_GROUP_DEPTH_USD;
  const isAnchor = (p: ScannedPool) => { const a = p.token0.toLowerCase(), b = p.token1.toLowerCase(); return (a === weth && b === usdg) || (a === usdg && b === weth); };
  // Fixed-group coins by name (a few hundred at most, lookalikes included).
  const fixedTok = new Set<string>();
  let named = 0;
  for (const t in cache.symbols) {
    const sym = cache.symbols[t];
    if (!sym || !quoted.has(t)) continue;
    named++;
    if (classifySymbol(sym)) fixedTok.add(t);
  }
  log(`[groups] building: ${named} named coin(s) with USDG/WETH pools, ${fixedTok.size} named like dollars/ETH/Bitcoin`);

  // Full read of some pools: decimals of their coins, balances, price.
  const decCache = new Map<string, number>();
  const readPools = async (ps: ScannedPool[]) => {
    const toks = [...new Set(ps.flatMap((p) => [p.token0.toLowerCase(), p.token1.toLowerCase()]))].filter((t) => !decCache.has(t));
    if (toks.length) {
      const metaRes = await deps.callMany(toks.map((t) => ({ target: t, data: SEL_DECIMALS })));
      toks.forEach((t, i) => { const d = big(metaRes[i]); if (d !== null && d <= 36n) decCache.set(t, Number(d)); });
    }
    const calls: { target: string; data: string }[] = [];
    for (const p of ps) {
      calls.push({ target: p.token0, data: SEL_BALANCE + pad(p.pool) }, { target: p.token1, data: SEL_BALANCE + pad(p.pool) });
      calls.push(p.kind === 'v3' ? { target: p.pool, data: SEL_SLOT0 } : { target: p.pool, data: SEL_RESERVES });
      calls.push(p.kind === 'solidly' ? { target: p.pool, data: SEL_STABLE } : { target: p.pool, data: SEL_RESERVES });
    }
    const res = ps.length ? await deps.callMany(calls) : [];
    return ps.map((p, i) => {
      const b0 = big(res[i * 4]), b1 = big(res[i * 4 + 1]);
      const d0 = decCache.get(p.token0.toLowerCase()), d1 = decCache.get(p.token1.toLowerCase());
      if (b0 === null || b1 === null || d0 === undefined || d1 === undefined) return null;
      if (p.kind === 'solidly' && big(res[i * 4 + 3]) === 1n) return null; // stable-curve pool: not a plain price
      let px: number | null = null; // token1 per token0
      if (p.kind === 'v3') {
        const sq = big(res[i * 4 + 2]);
        if (sq && sq > 0n) { const x = Number(sq) / 2 ** 96; px = x * x * 10 ** (d0 - d1); }
      } else {
        const r0 = big(res[i * 4 + 2], 0), r1 = big(res[i * 4 + 2], 1);
        if (r0 && r1) px = (Number(r1) / 10 ** d1) / (Number(r0) / 10 ** d0);
      }
      if (!px || !Number.isFinite(px)) return null;
      return { p, px, a0: Number(b0) / 10 ** d0, a1: Number(b1) / 10 ** d1 };
    }).filter((x): x is NonNullable<typeof x> => !!x);
  };

  // a) WETH's price: its deepest pool against USDG.
  const anchorRead = await readPools(deps.pools.filter((p) => !p.stable && isAnchor(p)));
  let wethUsd = 0, bestW = 0;
  for (const r of anchorRead) {
    const usdAmt = r.p.token0.toLowerCase() === usdg ? r.a0 : r.a1;
    const px = r.p.token0.toLowerCase() === weth ? r.px : 1 / r.px;
    if (usdAmt > bestW) { bestW = usdAmt; wethUsd = px; }
  }
  const quoteUsd = (q: string) => (q === usdg ? 1 : q === weth ? wethUsd : 0);

  // b) Cheap money check, in slices (progress + a short pause between).
  // Pools are walked straight from the scan list (no big copied list).
  const dU = decCache.get(usdg), dW = decCache.get(weth);
  const passed: ScannedPool[] = [];                // pools with enough USDG/WETH (few)
  const shallow = new Map<string, number>();       // fixed-group coin -> best upper bound (for the rejected list)
  const SLICE = deps.depthSlice ?? 4_000;
  const qOf = (p: ScannedPool) => { const a = p.token0.toLowerCase(); return a === usdg || a === weth ? a : p.token1.toLowerCase(); };
  const tc = Date.now();
  let checked = 0, slices = 0;
  let buf: ScannedPool[] = [];
  const flush = async () => {
    if (!buf.length) return;
    const slice = buf; buf = [];
    const res = await deps.callMany(slice.map((p) => ({ target: qOf(p), data: SEL_BALANCE + pad(p.pool) })));
    slice.forEach((p, j) => {
      const q = qOf(p), d = q === usdg ? dU : dW, bal = big(res[j]);
      if (bal === null || d === undefined) return;
      const upTo = 2 * (Number(bal) / 10 ** d) * quoteUsd(q); // most this pool could count as
      if (upTo >= minDepthUsd) { passed.push(p); return; }
      const tok = q === p.token0.toLowerCase() ? p.token1.toLowerCase() : p.token0.toLowerCase();
      if (fixedTok.has(tok) && upTo > (shallow.get(tok) ?? -1)) shallow.set(tok, upTo);
    });
    checked += slice.length;
    if (++slices % 10 === 0) log(`[groups] building: money check ${checked} pools done, ${passed.length} deep enough (${Math.round((Date.now() - tc) / 1000)}s)`);
    await sleep(deps.pauseMs ?? 2_000);
  };
  for (const p of deps.pools) {
    if (p.stable || isAnchor(p)) continue;
    const t = otherSide(p);
    if (!t || t === usdg || t === weth || !cache.symbols[t]) continue; // not a USDG/WETH pool, or an unnamed coin
    buf.push(p);
    if (buf.length >= SLICE) await flush();
  }
  await flush();

  // c) Candidates: fixed groups + copies among coins with a deep pool.
  const deepTok = new Set<string>();
  for (const p of passed) { const q = qOf(p); deepTok.add(q === p.token0.toLowerCase() ? p.token1.toLowerCase() : p.token0.toLowerCase()); }
  const pick: GroupCandidate[] = [];
  for (const t of new Set([...fixedTok, ...deepTok])) if (cache.symbols[t]) pick.push({ token: t, symbol: cache.symbols[t] });
  const cands = pickCandidates(pick);
  for (const t of [usdg, weth]) if (!cands.some((c) => c.token === t)) cands.push({ token: t, symbol: t === usdg ? 'USDG' : 'WETH', ...(t === usdg ? { kind: 'dollar' as const, group: 'Dollars' } : { kind: 'eth' as const, group: 'ETH' }) });
  const candSet = new Set(cands.map((c) => c.token.toLowerCase()));
  const toRead = passed.filter((p) => { const q = qOf(p); return candSet.has(q === p.token0.toLowerCase() ? p.token1.toLowerCase() : p.token0.toLowerCase()); });
  log(`[groups] building: ${checked} pool(s) checked, ${passed.length} deep enough; ${cands.length} candidate coin(s), pricing ${toRead.length} pool(s)`);

  // d) Full read of the candidates' pools that passed.
  const read = [...anchorRead, ...await readPools(toRead)];
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
  // Coins that only have shallow pools: their best depth (upper bound) so the
  // rejected list says "only $X in its best pool" (price unknown: never used,
  // verifyGroups rejects on depth before it looks at the price).
  for (const [tok, upTo] of shallow) if (!prices.has(tok)) prices.set(tok, { priceUsd: NaN, depthUsd: upTo, pool: '' });

  // 4) Verify and save.
  const { members, rejected } = verifyGroups(cands, prices, { usdg, weth, wethUsd }, minDepthUsd);
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
