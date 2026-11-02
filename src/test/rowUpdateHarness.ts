import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TriggerFirst, TrigCopy2, trigFirstSettings } from '../execution/triggerFirst';
import { TrigEntry, EntryCandidate, TablePool, TableRoute, entrySettings, poolShapeKey, poolPriceKey } from '../execution/trigEntry';
import { JsonlLog } from '../execution/localSimHost';
import { LocalSimClient, frame, framePieces } from '../execution/localSim';
import { planExecuteCall } from '../execution/executorCalldata';

// ============================================================================
// Shared by rowUpdate.test.ts and fix10Speed.test.ts (not a test itself):
// a fake arbsim that applies table messages exactly like check/entry.rs
// apply_table (row updates included), and the live-shaped universe of
// trueDelta.test.ts (16 coin pairs of 8 pools, trades seen twice, gas and
// WETH price moving every pass, size cap following the wallet).
// ============================================================================

const USDG = '0x' + '11'.repeat(20);
const WETH = '0x' + '22'.repeat(20);
const LENDER = '0x' + 'cd'.repeat(20);
const poolAddr = (i: number) => '0x' + (0xc000 + i).toString(16).padStart(40, '0');
const coinAddr = (g: number) => '0x' + (0xf000 + g).toString(16).padStart(40, '0');
export type Row = Record<string, any>;

// JSON with object keys sorted (arbsim stores objects with sorted keys).
export const canon = (x: unknown): string => JSON.stringify(x, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, v[k]])) : v));
// A row as arbsim keeps it (check/entry.rs parse_rows): h false if missing,
// s a finite number or none, e text or none, c / f objects or none.
export const asArb = (r: Row): Row => ({ rid: String(r.rid).toLowerCase(), h: r.h === true, s: typeof r.s === 'number' && Number.isFinite(r.s) ? r.s : null, e: typeof r.e === 'string' ? r.e : null, c: r.c && typeof r.c === 'object' && !Array.isArray(r.c) ? r.c : null, f: r.f && typeof r.f === 'object' && !Array.isArray(r.f) ? r.f : null });

// ---- a fake arbsim: check/entry.rs apply_table, row updates included ----
export function fakeArbsim(opts: { patches: boolean; upd: boolean }) {
  let table: Map<string, Row[]> | null = null;
  let gen: number | null = null;
  const log: Array<{ bytes: number; full: boolean; ok: boolean; keys: string[]; upds: number }> = [];
  const msgs: string[] = [];
  let failNext = false;
  const apply = (m: any): Record<string, unknown> => {
    const pools = Object.entries(m.pools as Record<string, unknown>);
    const refuse = (unknown: string) => ({ ok: false, unknown });
    if (failNext) { failNext = false; return refuse('timeout'); }
    if (!m.full && gen !== m.base) return refuse('table_gen');
    const next = new Map(m.full ? [] : table ?? []);
    for (const [k0, v] of pools) {
      const k = k0.toLowerCase();
      if (v === null) { next.delete(k); continue; }
      if (Array.isArray(v)) { next.set(k, (v as Row[]).map(asArb)); continue; }
      if (!opts.patches || m.full) return refuse('bad_request');
      const p = v as { r?: Row[]; s?: Record<string, number | null>; u?: Row[] };
      // (An arbsim without row updates ignores "u" silently: the bot must never send one to it.)
      if (p.u && !opts.upd) return refuse('upd_sent_to_old_arbsim');
      const base = next.get(k);
      if (!base) return refuse('patch_miss');
      const rows = base.slice();
      const at = new Map(rows.map((r, i) => [r.rid, i]));
      for (const [rid, s] of Object.entries(p.s ?? {})) { const i = at.get(rid.toLowerCase()); if (i === undefined) return refuse('patch_miss'); rows[i] = { ...rows[i], s: typeof s === 'number' && Number.isFinite(s) ? s : null }; }
      for (const u of p.u ?? []) {
        const i = at.get(String(u.rid).toLowerCase()); if (i === undefined) return refuse('patch_miss');
        const r = { ...rows[i] };
        if ('h' in u) r.h = u.h;
        if ('s' in u) r.s = typeof u.s === 'number' && Number.isFinite(u.s) ? u.s : null;
        if ('e' in u) r.e = typeof u.e === 'string' ? u.e : null;
        if ('f' in u) r.f = u.f && typeof u.f === 'object' ? u.f : null;
        if ('c' in u) { if (!r.c) return refuse('patch_miss'); r.c = { ...r.c, ...u.c }; }
        rows[i] = r;
      }
      for (const r of p.r ?? []) { const i = at.get(String(r.rid).toLowerCase()); if (i === undefined) return refuse('patch_miss'); rows[i] = asArb(r); }
      next.set(k, rows);
    }
    table = next; gen = m.gen;
    return { ok: true, gen: m.gen, pools: next.size, ...(opts.patches ? { patch: true } : {}), ...(opts.upd ? { upd: true } : {}) };
  };
  const take = (buf: Buffer) => {
    const text = buf.subarray(4).toString('utf8');
    const m = JSON.parse(text);
    const a = apply(m);
    msgs.push(text.replace(/"gen":\d+|"base":-?\d+/g, ''));
    const upds = Object.values(m.pools as Record<string, any>).reduce((n: number, v: any) => n + (v && !Array.isArray(v) && v.u ? v.u.length : 0), 0);
    log.push({ bytes: buf.length, full: !!m.full, ok: a.ok === true, keys: Object.keys(m.pools).sort(), upds });
    return a;
  };
  const client: Record<string, unknown> = {
    isConnected: () => true,
    stats: { fallbacks: 0 },
    request: async (m: Record<string, any>) => {
      if (m.type === 'trig_table') return take(frame({ ...m, id: 1 }));
      if (m.type === 'call' && m.calls?.[0]?.data?.startsWith('0x70a08231')) {
        const sd = m.overrides?.[m.calls[0].to]?.stateDiff ?? {};
        const v = Object.values(sd)[0] as string | undefined;
        return { id: m.id, ok: true, results: [{ success: true, output: v ?? '0x' + '0'.repeat(64), gasUsed: '0x1' }] };
      }
      return { id: m.id, ok: false, unknown: 'bad_request' };
    },
    requestBytes: async (open: Buffer[]) => take(framePieces(open, ',"id":1}')),
  };
  return {
    client: client as unknown as LocalSimClient, log, msgs,
    rows: () => table ?? new Map<string, Row[]>(),
    failNext: () => { failNext = true; },
    restart: () => { table = null; gen = null; },
  };
}
const copy2: TrigCopy2 = { running: () => true, notReadyWhy: () => null, waitForTx: async () => 1, forwarder: { newestBlock: () => 1, txBlockOf: () => null } };

// ---- a live-shaped universe ----
// `groups` coin pairs of `per` pools. Size cap as shadowMain's entryBuild:
// own money, 0.98 x the wallet's value of the start coin, so WETH routes'
// cap moves with the WETH price (live: the wallet holds less than $2,000).
type St = Record<string, any>;
export function universe(groups: number, per: number) {
  const pools = Array.from({ length: groups * per }, (_, i) => {
    const g = Math.floor(i / per);
    return { addr: poolAddr(i), g, start: g % 2 === 0 ? USDG : WETH, mid: coinAddr(g), kind: i % 2 ? 'v3' : 'v2' };
  });
  const stateOf = (i: number, v: number, wobble = 0): St => {
    const p = pools[i];
    return {
      chain: 'robinhood', poolAddress: p.addr, dex: p.kind === 'v3' ? 'uniswap-v3' : 'uniswap-v2', poolType: p.kind, tokenA: p.start, tokenB: p.mid, feeBps: 30,
      sqrtPriceX96: 79228162514264337593543950336n + BigInt(v * 997 + i + wobble), liquidity: 10n ** 21n, tick: 0, reserveA: 10n ** 24n, reserveB: 10n ** 24n + BigInt(v * 1000 + wobble),
      lastUpdatedMs: v, lastUpdatedBlock: v,
    };
  };
  const ver = pools.map(() => 0);
  const states: St[] = pools.map((_, i) => stateOf(i, 0));
  let px = 3456.78, gas = 0.0123;
  const WALLET_WETH = 0.5, WALLET_USDG = 1500;
  // Trades seen last pass as the feed's prediction: the block's real price comes this pass.
  let predicted: number[] = [], landed: number[] = [];
  const peers = (i: number) => { const out: number[] = []; for (let j = pools[i].g * per; j < (pools[i].g + 1) * per; j++) if (j !== i) out.push(j); return out; };
  const pk = (s: St) => poolPriceKey(s, true);
  const capOf = (usdg: boolean) => Math.min(2_000, 0.98 * (usdg ? WALLET_USDG : WALLET_WETH * px));
  const candOf = (bi: number, si: number): EntryCandidate => {
    const buy = pools[bi], sell = pools[si];
    const usdg = buy.start === USDG, dec = usdg ? 6 : 18, p = usdg ? 1 : px;
    const bs = states[bi], ss = states[si], g = gas;
    return {
      label: `D${buy.g}/${usdg ? 'USDG' : 'WETH'} ${buy.addr.slice(-4)}>${sell.addr.slice(-4)}`, buyPool: buy.addr, sellPool: sell.addr, tokenIn: buy.start, tokens: [buy.start, buy.mid],
      keys: usdg ? [buy.addr, sell.addr] : [buy.addr, sell.addr, LENDER], maxSizeUsd: capOf(usdg), gasUsd: g,
      build: (usd) => {
        const b = planExecuteCall({ chain: 'robinhood', tokenIn: buy.start, buyPool: bs as any, sellPool: ss as any, tradeSizeUsd: usd, netProfitUsd: 1, usdPerTokenIn: p, tokenInDecimals: dec, maxBlock: 0n, v3Lender: usdg ? undefined : LENDER });
        return b.ok ? { trade: { token: buy.start, amountIn: b.amountIn, hops: b.hops }, simOpts: { v3Lender: usdg ? undefined : LENDER, weth: WETH } } : null;
      },
      usdOf: (u) => Number(u) / 10 ** dec * p,
      fx: { px: p, d: dec, lp: usdg ? 0 : 500 },
    };
  };
  // As shadowMain's entryTableRoutes / entryPoolVer.
  const table = (): TablePool[] => pools.map((p, i) => ({
    pool: p.addr,
    ver: () => { const v: unknown[] = [pk(states[i])]; for (const j of peers(i)) v.push(pools[j].addr, pk(states[j])); return v; },
    routes: (): TableRoute[] => {
      const out: TableRoute[] = [];
      for (const j of peers(i)) for (const [b, s] of [[i, j], [j, i]]) {
        const usdg = pools[b].start === USDG, pxNow = usdg ? 1 : px, dec = usdg ? 6 : 18;
        // Quick price check: moves with both pools' prices, and (WETH
        // routes, priced in $) with the WETH price, as roundTripQuote does.
        const score = Number((BigInt(states[b].reserveB) - BigInt(states[s].reserveB)) % 1000n) / 100 + (usdg ? 0 : px / 1e5);
        out.push({
          rid: `${pools[b].addr}>${pools[s].addr}:${pools[b].start}`, held: true, score, build: () => candOf(b, s),
          // (inputs as shadowMain entryTableInputs: trading details, coin price, own money in $.)
          inputs: () => [poolShapeKey(states[b]), poolShapeKey(states[s]), pxNow, dec, capOf(usdg), 0, false],
          live: [pk(states[b]), states[b].observedFee, pk(states[s]), states[s].observedFee],
        });
      }
      return out;
    },
  }));
  // One live pass: every pool re-read (new object, same price), last pass's
  // predicted trades land with the block's real price (a little off the
  // prediction), this pass's trades show up as predictions, gas and the
  // WETH price move (unless held still).
  const tick = (r: number, o: { trades?: number[]; drift?: boolean } = {}) => {
    for (let i = 0; i < states.length; i++) states[i] = { ...states[i], lastUpdatedMs: states[i].lastUpdatedMs + 1 };
    for (const i of predicted) states[i] = stateOf(i, ver[i], 3); // the block's real price
    landed = predicted;
    predicted = [];
    for (const i of o.trades ?? []) { ver[i]++; states[i] = stateOf(i, ver[i]); predicted.push(i); }
    if (o.drift ?? true) { gas = Math.round(gas * (r % 2 ? 1.013 : 0.99) * 1e6) / 1e6; px = Math.round(px * (r % 3 ? 1.0007 : 0.9995) * 100) / 100; }
  };
  // (A pass with no real change = nothing traded this pass and nothing landed from the last one.)
  return { table, tick, pools, n: pools.length, routes: groups * per * (per - 1) * 2, predictedNow: () => predicted.slice(), landedNow: () => landed.slice() };
}

export function entryWith(env: Record<string, string>, src: () => TablePool[], clock: { t: number }, arb: { patches: boolean; upd: boolean } = { patches: true, upd: true }) {
  const A = fakeArbsim(arb);
  const log = new JsonlLog(join(mkdtempSync(join(tmpdir(), 'rowupd-')), 'x.jsonl'), 1_000_000, 0);
  const tf = new TriggerFirst({ client: A.client, settings: trigFirstSettings(env), copy2: () => copy2, shadowLog: log, hostOn: () => true, log: () => {} });
  const lines: string[] = [];
  const te = new TrigEntry({
    tf, client: A.client, shadowLog: log, settings: entrySettings(env, 0.1),
    candidatesFor: () => ({ cands: [], found: 0 }), tableRoutes: src,
    isOurTx: () => false, ourAddresses: [], killed: () => false, safety: () => null, failBlocked: () => null, pausedWhy: () => null,
    send: async () => ({}), log: (m) => lines.push(m), lag: () => 0, now: () => clock.t,
  });
  return { te, A, lines, T: () => (te as any).tbl };
}

// What the bot thinks arbsim holds vs what the fake arbsim holds (sorted keys, as arbsim stores them).
export const botView = (T: any) => new Map([...(T.pools as Map<string, { rows: Row[] }>)].map(([k, v]) => [k, canon(v.rows.map(asArb))]));
export const arbView = (m: Map<string, Row[]>) => new Map([...m].map(([k, rows]) => [k, canon(rows)]));
export const noIds = (m: Map<string, Row[]>) => new Map([...m].map(([k, rows]) => [k, canon(rows.map(({ e: _e, ...r }) => r))]));
export const sameMap = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

