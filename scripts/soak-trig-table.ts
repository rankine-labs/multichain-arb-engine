// ============================================================================
// SOAK TEST: the fast-lane candidate table (TrigEntry.refreshTable), offline.
//
// Plain English:
//   Live, the bot rebuilds the route table it hands to the Rust fast lane
//   about once a second (~1,700 pools, ~38,700 routes). This script runs the
//   bot's REAL table code (TrigEntry + TriggerFirst.capture, our contract's
//   real calldata and pretend state) at that size, with pool prices changing
//   the way they do live, and prints what it costs:
//     - main-thread time per rebuild (what freezes the bot)
//     - memory the table keeps (heap after a full clean-up, minus the same
//       run without a table)
//     - memory clean-up (GC) time per rebuild, and how many table entries
//       and remembered questions are held
//   Nothing here touches a node, a wallet or the server. The "sidecar" is a
//   fake that just says "taken".
//
// Run (any machine):
//   npx tsc -p tsconfig.scripts.json
//   node --expose-gc .scripts-build/scripts/soak-trig-table.js [options]
// Options (all optional):
//   --pools 1700      pools copy 2 follows
//   --peers 12        pools per coin pair (routes per pool = (peers-1) x 2)
//   --rounds 40       rebuilds to run (one "second" each)
//   --churn 0.10      share of pools whose state changes each second
//   --resync 5        every N seconds ALL pools get a fresh state object
//                     (the 5 s watch-list re-read does this live)
//   --env K=V,K=V     extra settings for the bot code (e.g. TRIG_ENTRY_TABLE_LEAN=0)
// ============================================================================
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PerformanceObserver } from 'perf_hooks';
import { TriggerFirst, TrigCopy2, trigFirstSettings } from '../src/execution/triggerFirst';
import { TrigEntry, EntryCandidate, TablePool, TableRoute, entrySettings } from '../src/execution/trigEntry';
import { JsonlLog } from '../src/execution/localSimHost';
import { LocalSimClient } from '../src/execution/localSim';
import { KIND_V2, KIND_V3 } from '../src/execution/executorCalldata';

// ---- command line ----
const args = process.argv.slice(2);
const opt = (name: string, d: number): number => { const i = args.indexOf(`--${name}`); const v = i >= 0 ? Number(args[i + 1]) : NaN; return Number.isFinite(v) ? v : d; };
const envArg = (() => { const i = args.indexOf('--env'); return i >= 0 ? String(args[i + 1] ?? '') : ''; })();
const POOLS = opt('pools', 1700), PEERS = Math.max(2, opt('peers', 12)), ROUNDS = opt('rounds', 40), CHURN = opt('churn', 0.10), RESYNC = Math.max(1, opt('resync', 5));
const noTable = args.includes('--no-table'); // baseline: same pools, no table (memory reference)

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) { console.error('run with: node --expose-gc ...'); process.exit(2); }
const MB = 1024 * 1024;

// ---- the live settings (two steps, fast lane live, the bot does not ask) ----
const env: Record<string, string> = {
  LOCAL_SIM_TRIGGER_FIRST: 'on', TRIG_ENTRY_TABLE_MS: '0', TRIG_ENTRY_ONE_TRIP: '0', FASTLANE: 'live', TRIG_ENTRY_NODE_ASKS: 'off',
};
for (const kv of envArg.split(',').filter(Boolean)) { const [k, ...v] = kv.split('='); env[k.trim()] = v.join('=').trim(); }

// ---- the fake sidecar (answers the coin balance-slot lookups, takes tables) ----
let tableMsgs = 0, tableBytes = 0;
const client = {
  isConnected: () => true,
  stats: { fallbacks: 0 },
  request: async (m: Record<string, any>) => {
    // The real client turns every message into text (one JSON line).
    if (m.type === 'trig_table') { tableMsgs++; tableBytes += JSON.stringify(m).length; return { ok: true, gen: m.gen }; }
    if (m.type === 'call' && m.calls?.[0]?.data?.startsWith('0x70a08231')) {
      const sd = m.overrides?.[m.calls[0].to]?.stateDiff ?? {};
      const v = Object.values(sd)[0] as string | undefined;
      return { id: m.id, ok: true, results: [{ success: true, output: v ?? '0x' + '0'.repeat(64), gasUsed: '0x1' }] };
    }
    return { id: m.id, ok: false, unknown: 'bad_request' };
  },
} as unknown as LocalSimClient;
const copy2: TrigCopy2 = { running: () => true, notReadyWhy: () => null, waitForTx: async () => 1, forwarder: { newestBlock: () => 1, txBlockOf: () => null } };

// ---- a live-sized pool universe ----
const USDG = '0x' + '11'.repeat(20);
const WETH = '0x' + '22'.repeat(20);
const LENDER = '0x' + 'cd'.repeat(20);
const addr = (i: number) => '0x' + (0xa0000 + i).toString(16).padStart(40, '0');
const coin = (g: number) => '0x' + (0xc0000 + g).toString(16).padStart(40, '0');
type State = { chain: string; poolAddress: string; dex: string; poolType: string; tokenA: string; tokenB: string; feeBps: number; sqrtPriceX96: bigint; liquidity: bigint; tick: number; reserveA?: bigint; reserveB?: bigint; lastUpdatedMs: number; lastUpdatedBlock: number; v: number; observedFee?: unknown };
const pools: Array<{ addr: string; start: string; mid: string; kind: number; group: number }> = [];
for (let i = 0; i < POOLS; i++) { const g = Math.floor(i / PEERS); pools.push({ addr: addr(i), start: g % 2 === 0 ? USDG : WETH, mid: coin(g), kind: i % 2 ? KIND_V3 : KIND_V2, group: g }); }
// Each pool's current state object (a NEW object whenever it changes, as the pool cache does).
const states: State[] = pools.map((p, i) => fresh(p, i, 0));
function fresh(p: typeof pools[0], i: number, v: number): State {
  return { chain: 'robinhood', poolAddress: p.addr, dex: p.kind === KIND_V3 ? 'uniswap-v3' : 'uniswap-v2', poolType: p.kind === KIND_V3 ? 'v3' : 'v2', tokenA: p.start, tokenB: p.mid, feeBps: 30,
    sqrtPriceX96: 79228162514264337593543950336n + BigInt(v * 1000 + i), liquidity: 10n ** 21n + BigInt(v), tick: v % 100, reserveA: 10n ** 24n, reserveB: 10n ** 24n + BigInt(v), lastUpdatedMs: Date.now(), lastUpdatedBlock: v, v };
}
const peersOf = (i: number) => { const g = pools[i].group; const out: number[] = []; for (let j = g * PEERS; j < Math.min(POOLS, (g + 1) * PEERS); j++) if (j !== i) out.push(j); return out; };

// A candidate the way shadowMain's entryBuild makes one (new object each
// call, holding both pool states).
function candOf(bi: number, si: number): EntryCandidate {
  const buy = pools[bi], sell = pools[si];
  const usdg = buy.start === USDG;
  const dec = usdg ? 6 : 18, px = usdg ? 1 : 3456.78;
  const host = { buy: states[bi], sell: states[si], tokenIn: buy.start, tokenOut: buy.mid, usdPer: px };
  return {
    label: `MEME${buy.group}/${usdg ? 'USDG' : 'WETH'} ${buy.addr.slice(-4)}>${sell.addr.slice(-4)}`, buyPool: buy.addr, sellPool: sell.addr, tokenIn: buy.start, tokens: [buy.start, buy.mid],
    keys: usdg ? [buy.addr, sell.addr] : [buy.addr, sell.addr, LENDER], maxSizeUsd: 400, gasUsd: 0.0123,
    build: (usd) => ({
      trade: { token: buy.start, amountIn: BigInt(Math.round((usd / px) * 10 ** Math.min(dec, 9))) * 10n ** BigInt(dec - Math.min(dec, 9)), hops: [
        { kind: buy.kind, pool: buy.addr, tokenIn: buy.start, tokenOut: buy.mid, feeBps: 30 },
        { kind: sell.kind, pool: sell.addr, tokenIn: buy.mid, tokenOut: buy.start, feeBps: 5 },
      ] },
      simOpts: usdg ? {} : { v3Lender: LENDER },
    }),
    usdOf: (u) => Number(u) / 10 ** dec * px,
    host,
    fx: { px, d: dec, lp: usdg ? 0 : 500 },
  };
}
// The table source, the way shadowMain's entryTableRoutes lists it.
const tableRoutes = (): TablePool[] => pools.map((p, i) => ({
  pool: p.addr,
  routes: (): TableRoute[] => {
    const out: TableRoute[] = [];
    for (const j of peersOf(i)) for (const [b, s] of [[i, j], [j, i]]) {
      // score: the quick price check, moves with both pools' states
      // (any price move of either pool changes it, so that pool's rows are re-sent, as live)
      const score = ((states[b].v * 7 + states[s].v * 3 + b) % 1000) / 100;
      out.push({ rid: `${pools[b].addr}>${pools[s].addr}:${pools[b].start}`, held: true, score, build: () => candOf(b, s),
        inputs: [states[b], states[b].observedFee, states[s], states[s].observedFee, pools[b].start === USDG ? 1 : 3456.78, pools[b].start === USDG ? 6 : 18] });
    }
    return out;
  },
}));

// ---- GC watch (memory clean-up time) ----
let gcMs = 0, gcN = 0;
new PerformanceObserver((l) => { for (const e of l.getEntries()) { gcMs += e.duration; gcN++; } }).observe({ entryTypes: ['gc'] });

async function main() {
  const log = new JsonlLog(join(mkdtempSync(join(tmpdir(), 'soak-')), 'x.jsonl'), 1_000_000, 0);
  const tf = new TriggerFirst({ client, settings: trigFirstSettings(env), copy2: () => copy2, shadowLog: log, hostOn: () => true, log: () => {} });
  const te = new TrigEntry({
    tf, client, shadowLog: log, settings: entrySettings(env, 0.1),
    candidatesFor: () => ({ cands: [], found: 0 }), tableRoutes,
    isOurTx: () => false, ourAddresses: [], killed: () => false, safety: () => null, failBlocked: () => null, pausedWhy: () => null,
    send: async () => ({}), log: () => {}, lag: () => 0,
  });
  gc!(); gc!();
  const base = process.memoryUsage().heapUsed;
  const busy: number[] = [], wall: number[] = [], gcPer: number[] = [];
  let changedPools = 0;
  for (let r = 0; r < ROUNDS; r++) {
    // Prices move: a share of pools each second, all of them on the re-read.
    const all = r > 0 && r % RESYNC === 0;
    for (let i = 0; i < POOLS; i++) {
      if (all) { states[i] = { ...states[i], lastUpdatedMs: Date.now() }; continue; } // same prices, new object
      if (r > 0 && Math.random() < CHURN) { states[i] = fresh(pools[i], i, states[i].v + 1); changedPools++; }
    }
    if (noTable) { await new Promise((res) => setImmediate(res)); continue; }
    const g0 = gcMs, t0 = performance.now();
    await te.refreshTable();
    wall.push(performance.now() - t0);
    busy.push(te.tableInfo().busyMs);
    gcPer.push(gcMs - g0);
  }
  gc!(); gc!();
  const held = process.memoryUsage().heapUsed - base;
  const info = te.tableInfo();
  const p = (xs: number[], q: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const skip = Math.min(3, Math.max(0, busy.length - 1)); // first rounds build everything from scratch
  const steady = (xs: number[]) => xs.slice(skip);
  console.log(JSON.stringify({
    settings: envArg || '(defaults)', pools: POOLS, routesPerPool: (PEERS - 1) * 2, rounds: ROUNDS, churn: CHURN, resyncEvery: RESYNC, noTable,
    routes: info.routes, reused: info.reused, entriesHeld: info.entries,
    busyMs: { first: Math.round(busy[0] ?? 0), avg: Math.round(avg(steady(busy))), p90: Math.round(p(steady(busy), 0.9)) },
    wallMs: { avg: Math.round(avg(steady(wall))) },
    gcMsPerRebuild: Math.round(avg(steady(gcPer))), gcCount: gcN,
    tableHeldMB: Math.round(held / MB), heapUsedMB: Math.round(process.memoryUsage().heapUsed / MB),
    tableMsgs, tableMB: Math.round(tableBytes / MB), changedPools,
  }, null, 1));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
