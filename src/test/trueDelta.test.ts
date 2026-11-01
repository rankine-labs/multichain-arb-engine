import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TriggerFirst, TrigCopy2, trigFirstSettings } from '../execution/triggerFirst';
import { TrigEntry, EntryCandidate, TablePool, TableRoute, entrySettings, poolShapeKey, poolPriceKey, tableDeltaOn, sizeStep } from '../execution/trigEntry';
import { JsonlLog } from '../execution/localSimHost';
import { LocalSimClient, frame, framePieces } from '../execution/localSim';
import { planExecuteCall } from '../execution/executorCalldata';

// ============================================================================
// TRUE DELTA (Nov 1, TRIG_TABLE_DELTA, default on; 0 = exactly the #262 table).
//
// Plain English: with #262 live (20:14 to 20:35 UTC), the bot sent arbsim
// 54 table messages a minute (~190 MB) instead of 28 (~56 MB). Read-only
// checks on the server showed why (see execution/trigEntry.ts TRUE DELTA):
// arbsim took only "change" messages (3 full tables in 4,216 messages, 0
// refused), but the changes were huge: one price move re-sent every pool
// of its coin pair whole, every rebuilt row also differed by gas / WETH
// price drift (the 10 s drift hold never held at 10 to 20 s passes, and
// the size cap, which follows the wallet's WETH value, counted as real),
// and a faster pass sent each move on its own.
//
// These checks rebuild that live condition with the bot's real table code
// (pretend clock, a pass every 10 s, every pool re-read every pass, ~8 pools
// per coin pair as live, ~1.5% of pools trading per pass as measured, each
// trade seen twice: the feed's predicted price, then the block's real one,
// gas and WETH price moving every pass, the size cap following the
// wallet's WETH value) and a fake arbsim that applies every message exactly
// as check/entry.rs apply_table does (patches included), and prove:
//   1. The live failure: the #262 code (TRIG_TABLE_DELTA=0) sends a large
//      part of the table every pass, even passes with no trade.
//   2. True delta: same condition, far fewer bytes and messages; a pass with
//      no real change sends nothing at all.
//   3. Real changes still go at once: right after a trade, arbsim's score
//      for every route through the pool that traded equals a fresh build.
//   4. arbsim's table is EXACTLY what the bot thinks it holds after every
//      pass (row by row, entry ids included), and once the drift window has
//      passed with gas / price still, EXACTLY a fresh full build.
//   5. Twice the pass rate does not mean twice the bytes.
//   6. An older arbsim (no patches): still exactly right (whole pools), still
//      far fewer bytes than #262. A refused patch falls back to a full table.
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const USDG = '0x' + '11'.repeat(20);
const WETH = '0x' + '22'.repeat(20);
const LENDER = '0x' + 'cd'.repeat(20);
const poolAddr = (i: number) => '0x' + (0xc000 + i).toString(16).padStart(40, '0');
const coinAddr = (g: number) => '0x' + (0xf000 + g).toString(16).padStart(40, '0');
type Row = Record<string, any>;

// ---- a fake arbsim: applies table messages exactly like check/entry.rs ----
// apply_table (full / partial with base / null / rows / TRUE DELTA patch),
// and answers like it ("patch": true when it reads patches). `patches:
// false` = an older arbsim: a patch is "pool rows must be a list".
function fakeArbsim(opts: { patches: boolean }) {
  let table: Map<string, Row[]> | null = null;
  let gen: number | null = null;
  const log: Array<{ bytes: number; full: boolean; pools: number; patches: number; ok: boolean }> = [];
  let failNext = false;
  const apply = (m: any): Record<string, unknown> => {
    const pools = Object.entries(m.pools as Record<string, unknown>);
    const patches = pools.filter(([, v]) => v !== null && !Array.isArray(v)).length;
    const refuse = (unknown: string) => ({ ok: false, unknown });
    if (failNext) { failNext = false; return refuse('timeout'); }
    if (!m.full && gen !== m.base) return refuse('table_gen');
    const next = new Map(m.full ? [] : table ?? []);
    for (const [k0, v] of pools) {
      const k = k0.toLowerCase();
      if (v === null) { next.delete(k); continue; }
      if (Array.isArray(v)) { next.set(k, (v as Row[]).map((r) => ({ ...r, rid: String(r.rid).toLowerCase() }))); continue; }
      if (!opts.patches) return refuse('bad_request');
      if (m.full) return refuse('bad_request');
      const base = next.get(k);
      if (!base) return refuse('patch_miss');
      const rows = base.slice();
      const at = new Map(rows.map((r, i) => [r.rid, i]));
      const p = v as { r?: Row[]; s?: Record<string, number | null> };
      for (const [rid, s] of Object.entries(p.s ?? {})) { const i = at.get(rid.toLowerCase()); if (i === undefined) return refuse('patch_miss'); rows[i] = { ...rows[i], s }; }
      for (const r of p.r ?? []) { const i = at.get(String(r.rid).toLowerCase()); if (i === undefined) return refuse('patch_miss'); rows[i] = { ...r, rid: String(r.rid).toLowerCase() }; }
      next.set(k, rows);
    }
    table = next; gen = m.gen;
    return { ok: true, gen: m.gen, pools: next.size, ...(opts.patches ? { patch: true } : {}) };
  };
  const take = (buf: Buffer) => {
    const m = JSON.parse(buf.subarray(4).toString('utf8'));
    const a = apply(m);
    log.push({ bytes: buf.length, full: !!m.full, pools: Object.keys(m.pools).length, patches: Object.values(m.pools).filter((v) => v !== null && !Array.isArray(v)).length, ok: a.ok === true });
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
    client: client as unknown as LocalSimClient, log,
    rows: () => table ?? new Map<string, Row[]>(),
    failNext: () => { failNext = true; },
    restart: () => { table = null; gen = null; }, // arbsim restarted: holds nothing
  };
}
const copy2: TrigCopy2 = { running: () => true, notReadyWhy: () => null, waitForTx: async () => 1, forwarder: { newestBlock: () => 1, txBlockOf: () => null } };

// ---- a live-shaped universe ----
// `groups` coin pairs of `per` pools. Size cap as shadowMain's entryBuild:
// own money, 0.98 x the wallet's value of the start coin, so WETH routes'
// cap moves with the WETH price (live: the wallet holds less than $2,000).
type St = Record<string, any>;
function universe(groups: number, per: number) {
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

function entryWith(env: Record<string, string>, src: () => TablePool[], clock: { t: number }, patches = true) {
  const A = fakeArbsim({ patches });
  const log = new JsonlLog(join(mkdtempSync(join(tmpdir(), 'delta-')), 'x.jsonl'), 1_000_000, 0);
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

// arbsim's table without entry ids (to compare with a fresh build, whose ids differ).
const noIds = (m: Map<string, Row[]>) => new Map([...m].map(([k, rows]) => [k, JSON.stringify(rows.map(({ e: _e, ...r }) => r))]));
const sameMap = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
// What the bot thinks arbsim holds (its own record), entry ids included.
const botView = (T: any) => new Map([...(T.pools as Map<string, { rows: Row[] }>)].map(([k, v]) => [k, JSON.stringify(v.rows)]));
const arbView = (m: Map<string, Row[]>) => new Map([...m].map(([k, rows]) => [k, JSON.stringify(rows)]));

async function main() {
  // Live settings: two steps, the bot does not ask, live kept-question window.
  const live = { LOCAL_SIM_TRIGGER_FIRST: 'on', TRIG_ENTRY_TABLE_MS: '0', TRIG_ENTRY_ONE_TRIP: '0', FASTLANE: 'live', TRIG_ENTRY_NODE_ASKS: 'off', TRIG_ENTRY_TABLE_MAX_BYTES: '400000', TRIG_ENTRY_TABLE_REUSE_MS: '30000' };
  // ~8 pools per coin pair (live: 1,690 pools in 200 pairs).
  const GROUPS = 16, PER = 8;

  // ---- settings ----
  assert(tableDeltaOn({}) && !tableDeltaOn({ TRIG_TABLE_DELTA: '0' }) && !tableDeltaOn({ TRIG_TABLE_QUIET: '0' }), 'TRIG_TABLE_DELTA: on by default; 0 (or the quiet skip off) = the #262 table exactly');
  assert(entrySettings({}).tableDeltaDriftMs === 600_000 && entrySettings({ TRIG_TABLE_QUIET_MS: '90000' }).tableDeltaDriftMs === 90_000 && entrySettings({ TRIG_TABLE_DELTA_DRIFT_MS: '30000' }).tableDeltaDriftMs === 30_000,
    'drift window: the quiet window (10 min) by default, settable');
  assert(sizeStep(1690, [50, 150, 400]) === sizeStep(1694, [50, 150, 400]) && sizeStep(1690, [50, 150, 400]) !== sizeStep(800, [50, 150, 400]) && sizeStep(140, [50, 150, 400]) !== sizeStep(160, [50, 150, 400]),
    'size step: a WETH-price wobble of the size cap is drift; the wallet halving or a ladder size no longer fitting is real');

  // ---- 1, 2, 5. the live condition: #262 vs true delta ----
  // ~1.5% of pools trade per pass (live: 22 to 32 of 1,690 pools moved per
  // ~14 s); every 3rd pass nothing trades. 72 passes = 12 minutes with the
  // live windows (quiet turns and drift every 5 to 10 min), so turns and
  // drift both happen inside the run.
  const tradesAt = (r: number, n: number) => (r % 3 === 2 ? [] : [(r * 37 + 5) % n, (r * 53 + 11) % n]);
  const runLive = async (env: Record<string, string>, stepMs: number, passes: number, patches = true) => {
    const u = universe(GROUPS, PER);
    const c = { t: 1_000_000 };
    const E = entryWith(env, u.table, c, patches);
    await E.te.refreshTable();
    const first = E.A.log.length;
    const full = E.A.log.reduce((a, m) => a + m.bytes, 0);
    let quietPassMsgs = 0, quietPasses = 0, exactEveryPass = true, passesWithSend = 0;
    for (let r = 0; r < passes; r++) {
      // (Same trades per minute whatever the pass rate.)
      const trades = stepMs === 10_000 ? tradesAt(r, u.n) : r % 2 === 0 ? tradesAt(r / 2, u.n) : [];
      u.tick(r, { trades });
      c.t += stepMs;
      const before = E.A.log.length;
      await E.te.refreshTable();
      if (!trades.length && !u.landedNow().length) { quietPasses++; quietPassMsgs += E.A.log.length - before; }
      if (E.A.log.length > before) passesWithSend++;
      if (!sameMap(botView(E.T()), arbView(E.A.rows()))) exactEveryPass = false;
    }
    const after = E.A.log.slice(first);
    const minutes = (passes * stepMs) / 60_000;
    return { u, E, full, passesWithSend, msgs: after.length, bytes: after.reduce((a, m) => a + m.bytes, 0), perMin: (x: number) => Math.round((x / minutes) * 10) / 10, quietPassMsgs, quietPasses, exactEveryPass, fulls: after.filter((m) => m.full).length, refused: after.filter((m) => !m.ok).length };
  };
  const envQ = { ...live };
  const P = 72;
  const old = await runLive({ ...envQ, TRIG_TABLE_DELTA: '0' }, 10_000, P);
  const neu = await runLive(envQ, 10_000, P);
  const fullBytes = old.full; // the first (full) table, all its parts
  const kb = (b: number) => `${Math.round(b / 1024)} KB`;
  console.log(`  (test numbers) full table ${kb(fullBytes)}; per pass: #262 ${kb(old.bytes / P)} in ${(old.msgs / P).toFixed(2)} messages, true delta ${kb(neu.bytes / P)} in ${(neu.msgs / P).toFixed(2)} messages`);
  assert(old.bytes / P >= 0.12 * fullBytes && old.passesWithSend === P,
    `live condition, #262 code (TRIG_TABLE_DELTA=0): every one of ${P} passes re-sends a big part of the table (${Math.round((100 * old.bytes) / P / fullBytes)}% of a full table per pass on average, ${(old.msgs / P).toFixed(1)} messages; live with more moving pools: about half)`);
  assert(neu.bytes * 8 <= old.bytes, `true delta: bytes to arbsim ${kb(old.bytes)} -> ${kb(neu.bytes)} over the same ${P} passes (${(old.bytes / Math.max(1, neu.bytes)).toFixed(1)}x less)`);
  assert(neu.msgs <= old.msgs, `true delta: messages ${old.msgs} -> ${neu.msgs}`);
  assert(neu.refused === 0 && neu.fulls === 0 && old.refused === 0, 'no message refused, no full table re-sent (both)');
  assert(neu.exactEveryPass, 'true delta: after every pass arbsim holds exactly what the bot thinks it holds (row by row, entry ids included, patches applied as check/entry.rs does)');

  // A pass with no real change sends nothing (default 10 min windows: no
  // quiet turn or drift due in 3 min); gas, WETH price and re-reads still move.
  {
    const u = universe(GROUPS, PER);
    const c = { t: 1_000_000 };
    const E = entryWith(live, u.table, c);
    await E.te.refreshTable();
    let msgsQuiet = 0, quietPasses = 0, msgsTrade = 0;
    for (let r = 0; r < 18; r++) {
      const trades = r % 3 === 0 ? [(r * 29 + 7) % u.n] : [];
      u.tick(r, { trades });
      c.t += 10_000;
      const b = E.A.log.length;
      await E.te.refreshTable();
      if (!trades.length && !u.landedNow().length) { quietPasses++; msgsQuiet += E.A.log.length - b; }
      // (The pass after a trade: the block's real price lands; it is a real change.)
      else msgsTrade += E.A.log.length - b;
    }
    assert(quietPasses >= 5 && msgsQuiet === 0, `a pass with no real change (re-reads, gas and WETH price moving) sends nothing: ${msgsQuiet} messages in ${quietPasses} such passes`);
    assert(msgsTrade > 0, `passes with a trade still send (${msgsTrade} messages)`);
  }

  // ---- 5. twice the pass rate, same trades per minute ----
  {
    const fast = neu, slow = await runLive(envQ, 20_000, P / 2);
    const oldFast = old, oldSlow = await runLive({ ...envQ, TRIG_TABLE_DELTA: '0' }, 20_000, P / 2);
    assert(fast.bytes <= 1.3 * slow.bytes, `true delta: a pass every 10 s vs every 20 s, same 12 minutes, same trades: ${kb(slow.bytes)} -> ${kb(fast.bytes)} (#262: ${kb(oldSlow.bytes)} -> ${kb(oldFast.bytes)})`);
  }

  // ---- 3 and 4. real changes at once; exactly a fresh build once drift has gone ----
  {
    // Reference: the old full rebuild (every route, every pass, sent at once).
    const u = universe(GROUPS, PER), uRef = universe(GROUPS, PER);
    const c = { t: 1_000_000 }, cRef = { t: 1_000_000 };
    // (Quiet window 60 s here, 10 min live: every pool's turn, and with it
    // its drift, comes within 2 x 60 s.)
    const env = { ...live, TRIG_TABLE_QUIET_MS: '60000' };
    const N = entryWith(env, u.table, c), R = entryWith({ ...live, TRIG_TABLE_FAST: '0' }, uRef.table, cRef);
    await N.te.refreshTable(); await R.te.refreshTable();
    let scoresAtOnce = true, checkedRoutes = 0, differsMid = false, exact = true;
    let lastTrades: number[] = [];
    for (let r = 0; r < 30; r++) {
      const moving = r < 12;
      const trades = moving && r % 3 !== 2 ? [(r * 41 + 3) % u.n] : [];
      u.tick(r, { trades, drift: moving }); uRef.tick(r, { trades, drift: moving });
      c.t += 10_000; cRef.t += 10_000;
      await N.te.refreshTable(); await R.te.refreshTable();
      if (!sameMap(botView(N.T()), arbView(N.A.rows()))) exact = false;
      // Every route through a pool whose price just changed: arbsim's score = a fresh build's.
      const moved = new Set([...trades, ...u.predictedNow()].map((i) => u.pools[i].addr.toLowerCase()));
      // (and last pass's trades: the block's real price lands this pass)
      const lastMoved = new Set(lastTrades.map((i) => u.pools[i].addr.toLowerCase()));
      lastTrades = trades;
      for (const [k, rows] of R.A.rows()) {
        const mine = N.A.rows().get(k) ?? [];
        rows.forEach((row, i) => {
          const pools = String(row.rid).split(':')[0].split('>');
          if (pools.some((p) => moved.has(p) || lastMoved.has(p)) && moving) {
            checkedRoutes++;
            if (mine[i]?.s !== row.s) scoresAtOnce = false;
          }
        });
      }
      if (r === 12 && !sameMap(noIds(N.A.rows()), noIds(R.A.rows()))) differsMid = true;
    }
    assert(checkedRoutes > 0 && scoresAtOnce, `real changes go at once: right after each trade, the score arbsim holds for every route through the pool that traded equals a fresh build (${checkedRoutes} route checks)`);
    assert(differsMid, 'drift waits: right after gas / WETH price stop moving, arbsim still has older stop amounts for some routes');
    assert(exact, 'after every one of 30 passes arbsim holds exactly what the bot thinks it holds');
    assert(sameMap(noIds(N.A.rows()), noIds(R.A.rows())), `once every pool's quiet turn / drift window (60 s here, 10 min live) has passed, arbsim holds EXACTLY a fresh full build, drift included (${N.A.rows().size} pools, ${[...N.A.rows().values()].reduce((a, r) => a + r.length, 0)} rows)`);
  }

  // ---- 6. an older arbsim (no patches); a refused patch; an arbsim restart ----
  {
    const oldArb = await runLive(envQ, 10_000, P, false);
    assert(oldArb.exactEveryPass && oldArb.refused === 0, 'older arbsim (does not say it reads patches): never sent a patch, exactly right after every pass (whole pools)');
    assert(oldArb.bytes <= old.bytes, `older arbsim: no more bytes than #262 (${kb(old.bytes)} -> ${kb(oldArb.bytes)}; patches are where the big saving is)`);

    const u = universe(GROUPS, PER);
    const c = { t: 1_000_000 };
    const E = entryWith(live, u.table, c);
    await E.te.refreshTable();
    u.tick(0, { trades: [3] }); c.t += 10_000; await E.te.refreshTable();
    // The next message is refused (a timeout): the bot sends a full table next time.
    E.A.failNext();
    u.tick(1, { trades: [20] }); c.t += 10_000; await E.te.refreshTable();
    u.tick(2, { trades: [] }); c.t += 10_000; await E.te.refreshTable();
    const lastFull = E.A.log.filter((m) => m.full && m.ok).length;
    assert(lastFull === 2 && sameMap(botView(E.T()), arbView(E.A.rows())), `a refused message: next pass sends a full table of exactly what the bot holds (${lastFull} full tables taken, tables match)`);
    // arbsim restarted (holds nothing): the next change is refused (table_gen), then a full table.
    E.A.restart();
    u.tick(3, { trades: [40] }); c.t += 10_000; await E.te.refreshTable();
    u.tick(4, { trades: [] }); c.t += 10_000; await E.te.refreshTable();
    assert(sameMap(botView(E.T()), arbView(E.A.rows())) && E.A.rows().size === u.n, 'arbsim restarted: after the refusal a full table, then exactly right again');
  }

  // ---- the 5-minute table line ----
  {
    const u = universe(4, 4);
    const c = { t: 1_000_000 };
    const E = entryWith(live, u.table, c);
    const real = Date.now;
    let fake = real();
    (Date as any).now = () => fake;
    try {
      await E.te.refreshTable();
      fake += 301_000;
      u.tick(0, { trades: [1] }); c.t += 10_000; await E.te.refreshTable();
    } finally { (Date as any).now = real; }
    const line = E.lines.find((l) => l.startsWith('[trig-entry] table 5 min:')) ?? '';
    assert(/passes, \d+ messages \(\d+ full\), [\d.]+ MB; true delta on \(patches on\): rows \d+, scores \d+, whole pools \d+, drift rows \d+ sent \/ \d+ waiting/.test(line), `5-minute table line: "${line}"`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
