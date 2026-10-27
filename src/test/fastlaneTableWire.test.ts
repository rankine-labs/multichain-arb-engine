import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TriggerFirst, TrigCopy2, trigFirstSettings } from '../execution/triggerFirst';
import { TrigEntry, EntryCandidate, TablePool, TableRoute, entrySettings } from '../execution/trigEntry';
import { JsonlLog } from '../execution/localSimHost';
import { LocalSimClient } from '../execution/localSim';
import { KIND_V2, KIND_V3 } from '../execution/executorCalldata';

// ============================================================================
// FAST LANE TABLE WIRING (practice fixes, Oct 27).
//
// Plain English:
//   Live, the Rust standing-gap scanner (sim/src/fastlane/scan.rs) gets its
//   routes from the bot's one-trip candidate table (execution/trigEntry.ts
//   refreshTable -> `trig_table` -> sim/src/check/entry.rs). In the first
//   30-minute practice run it checked ZERO routes. This test builds the table
//   message with the bot's REAL code (TrigEntry + TriggerFirst.capture, our
//   contract's real calldata and pretend state), exactly as the live bot does
//   with FASTLANE=practice, and checks every row carries what the scanner
//   needs: an entry id, the check ("c": calls, overrides, ladder sizes,
//   route keys) and the facts ("f": price, decimals, gas, loan fee).
//
//   The message is also the fixture of the Rust side's test
//   (sim/tests/fastlane_wire.rs: this message -> apply_table -> the
//   scanner's route list = N routes). If the bot's message shape changes,
//   this test fails until the fixture is written again:
//     WRITE_FASTLANE_FIXTURE=1 npm test
//   (then run the Rust test too).
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

const FIXTURE = join(__dirname, '..', '..', 'sim', 'tests', 'fixtures', 'fastlane_bot_table.json');
const USDG = '0x' + '11'.repeat(20);
const WETH = '0x' + '22'.repeat(20);
const MEME = '0x' + '33'.repeat(20);
const LENDER = '0x' + 'cd'.repeat(20);
const poolAddr = (i: number) => '0x' + (0xa000 + i).toString(16).padStart(40, '0');

// The sidecar as the table builder sees it: answers the coin balance-slot
// lookups (a balanceOf with a pretend balance reads it back) and records
// every table message.
function fakeClient() {
  const tables: Array<Record<string, any>> = [];
  const client = {
    isConnected: () => true,
    stats: { fallbacks: 0 },
    request: async (m: Record<string, any>) => {
      if (m.type === 'trig_table') { tables.push(JSON.parse(JSON.stringify(m))); return { ok: true, gen: m.gen }; }
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

// 4 watched pools (MEME/USDG and MEME/WETH on two exchanges each); each pool's
// routes: buy here / sell on the peer and the other way, from the coin we
// hold. USDG routes use our own money, WETH routes a V3 flash loan.
function universe() {
  const pools = [0, 1, 2, 3].map((i) => ({ addr: poolAddr(i), start: i < 2 ? USDG : WETH, kind: i % 2 ? KIND_V3 : KIND_V2 }));
  const peerOf = (i: number) => pools[i ^ 1];
  const candOf = (buy: typeof pools[0], sell: typeof pools[0]): EntryCandidate => {
    const usdg = buy.start === USDG;
    const dec = usdg ? 6 : 18;
    const px = usdg ? 1 : 3456.78;
    return {
      label: `MEME/${usdg ? 'USDG' : 'WETH'} ${buy.addr.slice(-4)}>${sell.addr.slice(-4)}`, buyPool: buy.addr, sellPool: sell.addr, tokenIn: buy.start, tokens: [buy.start, MEME],
      keys: usdg ? [buy.addr, sell.addr] : [buy.addr, sell.addr, LENDER], maxSizeUsd: 400, gasUsd: 0.0123,
      build: (usd) => ({
        trade: { token: buy.start, amountIn: BigInt(Math.round((usd / px) * 10 ** Math.min(dec, 9))) * 10n ** BigInt(dec - Math.min(dec, 9)), hops: [
          { kind: buy.kind, pool: buy.addr, tokenIn: buy.start, tokenOut: MEME, feeBps: 30 },
          { kind: sell.kind, pool: sell.addr, tokenIn: MEME, tokenOut: buy.start, feeBps: 5 },
        ] },
        simOpts: usdg ? {} : { v3Lender: LENDER },
      }),
      usdOf: (u) => Number(u) / 10 ** dec * px,
      fx: { px, d: dec, lp: usdg ? 0 : 500 },
    };
  };
  const routesOf = (i: number): TableRoute[] => [[pools[i], peerOf(i)], [peerOf(i), pools[i]]].map(([buy, sell]) => ({
    rid: `${buy.addr}>${sell.addr}:${buy.start}`, held: true, score: 1, build: () => candOf(buy, sell), inputs: [buy.addr, sell.addr, 1],
  }));
  return { table: (): TablePool[] => pools.map((p, i) => ({ pool: p.addr, routes: () => routesOf(i) })) };
}

function entryWith(env: Record<string, string>) {
  const { client, tables } = fakeClient();
  const log = new JsonlLog(join(mkdtempSync(join(tmpdir(), 'flwire-')), 'x.jsonl'), 1_000_000, 0);
  const tf = new TriggerFirst({ client, settings: trigFirstSettings(env), copy2: () => copy2, shadowLog: log, hostOn: () => true, log: () => {} });
  const te = new TrigEntry({
    tf, client, shadowLog: log, settings: entrySettings(env, 0.1),
    candidatesFor: () => ({ cands: [], found: 0 }), tableRoutes: universe().table,
    isOurTx: () => false, ourAddresses: [], killed: () => false, safety: () => null, failBlocked: () => null, pausedWhy: () => null,
    send: async () => ({}), log: () => {}, lag: () => 0,
  });
  return { te, tables };
}

// The message with entry ids replaced by a fixed label (they are counters).
function canonical(m: Record<string, any>): string {
  const pools: Record<string, any> = {};
  for (const k of Object.keys(m.pools).sort()) pools[k] = m.pools[k].map((r: any) => ({ ...r, e: r.e === null ? null : 'id' }));
  return JSON.stringify({ type: m.type, full: m.full, codes: m.codes, pools });
}

async function main() {
  const env = { LOCAL_SIM_TRIGGER_FIRST: 'shadow', TRIG_ENTRY_TABLE_MS: '0', FASTLANE: 'practice' };
  const A = entryWith(env);
  const ok = await A.te.refreshTable();
  assert(ok && A.tables.length === 1, 'the bot sent one full table message');
  const m = A.tables[0];
  const rows = Object.values(m.pools as Record<string, any[]>).flat();
  assert(rows.length === 8, `8 routes (4 pools x 2 directions): ${rows.length}`);
  assert(rows.every((r) => typeof r.e === 'string' && r.e.length > 0), 'every row has an entry id (the scanner skips rows without one)');
  assert(rows.every((r) => r.c && Array.isArray(r.c.calls) && r.c.calls.length === 1 && r.c.overrides && r.c.sizes && Array.isArray(r.c.route)), 'every row has its check: one call, pretend state, ladder sizes, route keys');
  assert(rows.every((r) => r.f && r.f.px > 0 && Number.isInteger(r.f.d) && r.f.g > 0), 'FASTLANE=practice: every row carries the scanner\'s facts (price, decimals, gas)');
  assert(rows.filter((r) => r.f.lp === 500).length === 4 && rows.filter((r) => r.c.route.includes(LENDER)).length === 4, 'flash routes: loan fee and the lender key');

  // FASTLANE off: exactly the old table (no facts).
  const B = entryWith({ ...env, FASTLANE: 'off' });
  await B.te.refreshTable();
  const rowsOff = Object.values(B.tables[0].pools as Record<string, any[]>).flat();
  assert(rowsOff.length === 8 && rowsOff.every((r) => r.f === undefined && r.c), 'FASTLANE=off: same rows, no facts');

  // The Rust test's fixture (sim/tests/fastlane_wire.rs).
  if (process.env.WRITE_FASTLANE_FIXTURE === '1') {
    writeFileSync(FIXTURE, JSON.stringify(m, null, 1) + '\n');
    console.log(`wrote ${FIXTURE}`);
  }
  assert(existsSync(FIXTURE), 'the Rust side\'s fixture exists');
  if (existsSync(FIXTURE)) {
    const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    assert(canonical(fx) === canonical(m), 'the Rust fixture is exactly what the bot sends today (WRITE_FASTLANE_FIXTURE=1 to rewrite)');
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
