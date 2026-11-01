import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TriggerFirst, TrigCopy2, trigFirstSettings } from '../execution/triggerFirst';
import { TrigEntry, EntryCandidate, TablePool, TableRoute, entrySettings, cacheMaxFor, textDigest } from '../execution/trigEntry';
import { loopIndexNeeded } from '../execution/trigEntryLoops';
import { JsonlLog } from '../execution/localSimHost';
import { LocalSimClient } from '../execution/localSim';
import { KIND_V2, KIND_V3 } from '../execution/executorCalldata';

// ============================================================================
// LEAN TABLE (Nov 1, TRIG_ENTRY_TABLE_LEAN) + LOOP INDEX ONLY WHEN USED.
//
// Plain English: the bot's fast-lane table (what the Rust lane trades from)
// is rebuilt every second. The lean table keeps less in memory and stops
// re-writing every route's check question from scratch. These checks prove:
//   1. Every message the bot sends arbsim is EXACTLY the same, byte for byte,
//      with the lean table on and off, over many rebuilds while pool prices
//      move (rows, ids, questions, codes, order, parts).
//   2. With more routes than the old cache limit (2,000), the lean table
//      writes each route's question once; the old code wrote them again
//      after every price re-read (the live CPU problem).
//   3. Answer look-ups are kept only when the bot itself may read them
//      (it asks arbsim in one trip), and still kept with the lean table off.
//   4. The cache-limit and digest helpers, and the loop index switch.
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const USDG = '0x' + '11'.repeat(20);
const WETH = '0x' + '22'.repeat(20);
const LENDER = '0x' + 'cd'.repeat(20);
const poolAddr = (i: number) => '0x' + (0xa000 + i).toString(16).padStart(40, '0');
const coinAddr = (g: number) => '0x' + (0xc000 + g).toString(16).padStart(40, '0');

// The sidecar as the table builder sees it (as in fastlaneTableWire.test.ts):
// answers the coin balance-slot lookups and records every table message as text.
function fakeClient() {
  const tables: string[] = [];
  const client = {
    isConnected: () => true,
    stats: { fallbacks: 0 },
    request: async (m: Record<string, any>) => {
      if (m.type === 'trig_table') { tables.push(JSON.stringify(m)); return { ok: true, gen: m.gen }; }
      if (m.type === 'call' && m.calls?.[0]?.data?.startsWith('0x70a08231')) {
        const sd = m.overrides?.[m.calls[0].to]?.stateDiff ?? {};
        const v = Object.values(sd)[0] as string | undefined;
        return { id: m.id, ok: true, results: [{ success: true, output: v ?? '0x' + '0'.repeat(64), gasUsed: '0x1' }] };
      }
      return { id: m.id, ok: false, unknown: 'bad_request' };
    },
  } as unknown as LocalSimClient;
  return { client, tables };
}
const copy2: TrigCopy2 = { running: () => true, notReadyWhy: () => null, waitForTx: async () => 1, forwarder: { newestBlock: () => 1, txBlockOf: () => null } };

// A universe of `groups` coin pairs with `per` pools each. Pool states are
// objects replaced when they change (as the pool cache does); the score and
// the coin price move with them, so changed pools' rows are re-sent.
function universe(groups: number, per: number) {
  type St = { v: number };
  const pools = Array.from({ length: groups * per }, (_, i) => ({ addr: poolAddr(i), g: Math.floor(i / per), start: Math.floor(i / per) % 2 === 0 ? USDG : WETH, kind: i % 2 ? KIND_V3 : KIND_V2 }));
  const states: St[] = pools.map(() => ({ v: 0 }));
  let px = 3456.78;
  const candOf = (bi: number, si: number): EntryCandidate => {
    const buy = pools[bi], sell = pools[si];
    const usdg = buy.start === USDG;
    const dec = usdg ? 6 : 18, p = usdg ? 1 : px;
    const mid = coinAddr(buy.g);
    return {
      label: `C${buy.g}/${usdg ? 'USDG' : 'WETH'} ${buy.addr.slice(-4)}>${sell.addr.slice(-4)}`, buyPool: buy.addr, sellPool: sell.addr, tokenIn: buy.start, tokens: [buy.start, mid],
      keys: usdg ? [buy.addr, sell.addr] : [buy.addr, sell.addr, LENDER], maxSizeUsd: 400, gasUsd: 0.0123,
      build: (usd) => ({
        trade: { token: buy.start, amountIn: BigInt(Math.round((usd / p) * 10 ** Math.min(dec, 9))) * 10n ** BigInt(dec - Math.min(dec, 9)), hops: [
          { kind: buy.kind, pool: buy.addr, tokenIn: buy.start, tokenOut: mid, feeBps: 30 },
          { kind: sell.kind, pool: sell.addr, tokenIn: mid, tokenOut: buy.start, feeBps: 5 },
        ] },
        simOpts: usdg ? {} : { v3Lender: LENDER },
      }),
      usdOf: (u) => Number(u) / 10 ** dec * p,
      host: { buy: states[bi], sell: states[si] },
      fx: { px: p, d: dec, lp: usdg ? 0 : 500 },
    };
  };
  const peers = (i: number) => { const out: number[] = []; for (let j = pools[i].g * per; j < (pools[i].g + 1) * per; j++) if (j !== i) out.push(j); return out; };
  const table = (): TablePool[] => pools.map((p, i) => ({
    pool: p.addr,
    routes: (): TableRoute[] => {
      const out: TableRoute[] = [];
      for (const j of peers(i)) for (const [b, s] of [[i, j], [j, i]]) {
        out.push({ rid: `${pools[b].addr}>${pools[s].addr}:${pools[b].start}`, held: (states[b].v + s) % 5 !== 0, score: ((states[b].v * 7 + states[s].v * 3 + b) % 100) / 10, build: () => candOf(b, s),
          inputs: [states[b], states[s], pools[b].start === USDG ? 1 : px, pools[b].start === USDG ? 6 : 18] });
      }
      return out;
    },
  }));
  // One "second": some pools change price, or every pool gets a fresh object (re-read).
  const tick = (r: number) => {
    if (r % 4 === 3) { for (let i = 0; i < states.length; i++) states[i] = { v: states[i].v }; return; } // re-read: same prices, new objects
    for (let i = 0; i < states.length; i++) if ((i * 31 + r * 17) % 13 === 0) states[i] = { v: states[i].v + 1 };
    if (r % 5 === 4) px = Math.round(px * 1.001 * 100) / 100; // ETH price moves now and then
  };
  return { table, tick, routes: groups * per * (per - 1) * 2 };
}

function entryWith(env: Record<string, string>, u: ReturnType<typeof universe>) {
  const { client, tables } = fakeClient();
  const log = new JsonlLog(join(mkdtempSync(join(tmpdir(), 'lean-')), 'x.jsonl'), 1_000_000, 0);
  const tf = new TriggerFirst({ client, settings: trigFirstSettings(env), copy2: () => copy2, shadowLog: log, hostOn: () => true, log: () => {} });
  let captures = 0;
  const real = tf.capture.bind(tf);
  (tf as any).capture = (...a: Parameters<TriggerFirst['capture']>) => { captures++; return real(...a); };
  const te = new TrigEntry({
    tf, client, shadowLog: log, settings: entrySettings(env, 0.1),
    candidatesFor: () => ({ cands: [], found: 0 }), tableRoutes: u.table,
    isOurTx: () => false, ourAddresses: [], killed: () => false, safety: () => null, failBlocked: () => null, pausedWhy: () => null,
    send: async () => ({}), log: () => {}, lag: () => 0,
  });
  return { te, tables, captures: () => captures };
}

async function main() {
  // ---- 4. helpers ----
  assert(cacheMaxFor(2_000, 0) === 2_000 && cacheMaxFor(2_000, 1_000) === 2_000, 'cache limit: never below the old limit');
  assert(cacheMaxFor(2_000, 37_336) === 46_670 && cacheMaxFor(20_000, 37_336) === 46_670, 'cache limit: 1.25x the table at live size (37,336 routes -> 46,670)');
  assert(cacheMaxFor(2_000, 10_000_000) === 200_000, 'cache limit: hard cap 200,000');
  assert(textDigest('abc') === textDigest('abc') && textDigest('abc') !== textDigest('abd') && textDigest('x'.repeat(3000)).length < 40, 'digest: same text same digest, different text different digest, short');
  assert(entrySettings({}).tableLean === true && entrySettings({ TRIG_ENTRY_TABLE_LEAN: '0' }).tableLean === false, 'TRIG_ENTRY_TABLE_LEAN: on by default, 0 = old');
  assert(loopIndexNeeded({}, false) === false && loopIndexNeeded({}, true) === true, 'loop index (not set): only when the bot asks about triggers itself');
  assert(loopIndexNeeded({ TRIG_ENTRY_LOOP_INDEX: '1' }, false) === true && loopIndexNeeded({ TRIG_ENTRY_LOOP_INDEX: 'on' }, false) === true, 'loop index: 1 / on forces it on');
  assert(loopIndexNeeded({ TRIG_ENTRY_LOOP_INDEX: '0' }, true) === false && loopIndexNeeded({ TRIG_ENTRY_LOOP_INDEX: 'off' }, true) === false, 'loop index: 0 / off keeps it off');

  // ---- 1. identical messages, lean on vs off, over 12 rebuilds with moving prices ----
  // Live settings: two steps, fast lane live, the bot does not ask. Small
  // parts so the multi-part path is covered too.
  const live = { LOCAL_SIM_TRIGGER_FIRST: 'on', TRIG_ENTRY_TABLE_MS: '0', TRIG_ENTRY_ONE_TRIP: '0', FASTLANE: 'live', TRIG_ENTRY_NODE_ASKS: 'off', TRIG_ENTRY_TABLE_MAX_BYTES: '60000' };
  for (const [name, extra] of [['live settings (two steps, bot does not ask)', {}], ['one trip, bot asks', { TRIG_ENTRY_ONE_TRIP: '1', TRIG_ENTRY_NODE_ASKS: 'on' }], ['fast lane off (one trip, the old table)', { FASTLANE: 'off', TRIG_ENTRY_ONE_TRIP: '1', TRIG_ENTRY_NODE_ASKS: 'on' }]] as const) {
    const uOld = universe(6, 4), uNew = universe(6, 4);
    const O = entryWith({ ...live, ...extra, TRIG_ENTRY_TABLE_LEAN: '0' }, uOld);
    const N = entryWith({ ...live, ...extra }, uNew);
    for (let r = 0; r < 12; r++) {
      uOld.tick(r); uNew.tick(r);
      await O.te.refreshTable(); await N.te.refreshTable();
    }
    assert(O.tables.length > 12 && O.tables.length === N.tables.length, `${name}: same number of messages (${N.tables.length}), and the table really changed over the run`);
    assert(O.tables.every((t, i) => t === N.tables[i]), `${name}: every message byte for byte the same with the lean table on and off`);
  }

  // ---- 3. answer look-ups kept only when they can be read ----
  {
    const u1 = universe(3, 3), u2 = universe(3, 3), u3 = universe(3, 3);
    const lean = entryWith(live, u1);
    const old = entryWith({ ...live, TRIG_ENTRY_TABLE_LEAN: '0' }, u2);
    const asks = entryWith({ ...live, TRIG_ENTRY_ONE_TRIP: '1', TRIG_ENTRY_NODE_ASKS: 'on' }, u3);
    await lean.te.refreshTable(); await old.te.refreshTable(); await asks.te.refreshTable();
    assert(lean.te.tableInfo().entries === 0 && lean.te.tableInfo().routes === u1.routes, `lean, bot does not ask: no answer look-ups kept (${lean.te.tableInfo().entries}), all ${u1.routes} routes still in the table`);
    assert(old.te.tableInfo().entries === u2.routes, `lean off: look-ups kept as before (${old.te.tableInfo().entries})`);
    assert(asks.te.tableInfo().entries === u3.routes, `lean, bot asks in one trip: look-ups kept (${asks.te.tableInfo().entries})`);
  }

  // ---- 2. more routes than the old 2,000 limit: questions written once ----
  {
    // 120 pairs x 5 pools = 600 pools, 8 routes each = 4,800 routes.
    const uOld = universe(120, 5), uNew = universe(120, 5);
    const O = entryWith({ ...live, TRIG_ENTRY_TABLE_LEAN: '0' }, uOld);
    const N = entryWith(live, uNew);
    await O.te.refreshTable(); await N.te.refreshTable();
    const o1 = O.captures(), n1 = N.captures();
    // A price re-read: every pool gets a new state object (r % 4 === 3).
    uOld.tick(3); uNew.tick(3);
    await O.te.refreshTable(); await N.te.refreshTable();
    const oMore = O.captures() - o1, nMore = N.captures() - n1;
    // Each route is listed under both of its pools: half the rows are unique routes.
    const unique = uNew.routes / 2;
    console.log(`(test numbers) ${uNew.routes} rows / ${unique} routes: questions written from scratch on the first build ${n1}; after a re-read: old ${oMore}, lean ${nMore}`);
    assert(n1 === unique && o1 === unique, `first build: every route written once (both: ${o1} / ${n1})`);
    assert(nMore === 0, `lean: a re-read writes no question again (${nMore})`);
    assert(oMore > unique / 2, `old code: the 2,000-entry cache was wiped, most questions written again (${oMore} of ${unique})`);
    assert(O.tables.length === N.tables.length && O.tables.every((t, i) => t === N.tables[i]), 'and the messages are still the same');
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
