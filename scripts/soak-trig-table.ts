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
//   --live            LIVE SHAPE (Nov 1): what the plain soak left out and
//                     the live bot has. Each candidate is built the way
//                     shadowMain's buildCheck builds it (the real contract
//                     calldata builder, buildExecuteCall), pools are a live
//                     mix (V2, V3, V4, hooked V4), the score is the real quick
//                     price check (roundTripQuote), and EVERY second the gas
//                     cost in $ and the WETH price move a little (live, the
//                     gas reading changes every 2 s and the ETH price with
//                     every WETH/USDG trade). Prints the longest single
//                     "trig table" stretch and how many went over 50 ms.
//                     With --live the bot code also sees a pretend clock that
//                     moves 1 s per round, or the previous rebuild's real
//                     time if that was longer (live: a pass starts every
//                     second, a slow one delays the next), so time-based
//                     rules (reuse windows, drift re-sends) act as live.
//   --table-ms 1000   (--live) a pass starts this often on the pretend clock
//                     (live: TRIG_ENTRY_TABLE_MS; the server has 10000)
//   --slow 1          (--live) the pretend clock counts each pass's real
//                     time x this (the server is ~3.5 to 5x slower than a
//                     dev box), so a pass that takes 52 s live also takes
//                     52 s on the pretend clock here (QUIET SKIP, Nov 1)
//   --stamped         (QUIET SKIP, Nov 1) like live, one pool in every
//                     other coin pair is an Algebra / hooked V4 pool whose
//                     re-read brings a new "fee read at" stamp (live: 92 of
//                     1,693 pools; 811 share a pair with one)
//   --prof FILE       write a CPU profile of the steady rounds only (after
//                     the from-scratch builds) to FILE (.cpuprofile)
//   --wallet-cap      (TRUE DELTA, Nov 1) like live, each route's size cap is
//                     0.98 x the wallet's value of the start coin (0.5 WETH,
//                     $1,500 USDG), so WETH routes' cap moves with the WETH
//                     price, and own money is part of what a question is made of
//   --predicted       (TRUE DELTA) like live, every trade is seen twice: the
//                     feed's predicted price, then the block's real one (a
//                     little off) on the next round
//   --old-arbsim      (TRUE DELTA) the fake arbsim does not say it reads
//                     patches (as an arbsim from before TRUE DELTA)
// Live-shaped TRUE DELTA comparison (Nov 1, measured: ~1.5% of pools move
// per pass, ~8.5 pools per coin pair, a pass every 10 to 20 s):
//   --live --stamped --wallet-cap --predicted --peers 9 --churn 0.015
//   --resync 1 --table-ms 10000 --slow 20 --rounds 80
//   --env TRIG_ENTRY_TABLE_REUSE_MS=30000[,TRIG_TABLE_DELTA=0]
// ============================================================================
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PerformanceObserver } from 'perf_hooks';
import { TriggerFirst, TrigCopy2, trigFirstSettings } from '../src/execution/triggerFirst';
import { TrigEntry, EntryCandidate, TablePool, TableRoute, entrySettings, tableFastOn, tableQuietOn, poolShapeKey, poolPriceKey as poolPriceKeyOf } from '../src/execution/trigEntry';
import { JsonlLog } from '../src/execution/localSimHost';
import { LocalSimClient, frame, framePieces } from '../src/execution/localSim';
import { KIND_V2, KIND_V3, KIND_V4, KIND_V4_HOOKED, buildExecuteCall, planExecuteCall, checkBuildEncodeOn } from '../src/execution/executorCalldata';
import { roundTripQuote } from '../src/core/profitCalculator';
import { stallFinder } from '../src/core/stallFinder';
import { AbiCoder, keccak256 } from 'ethers';
import { Session } from 'inspector';
import { writeFileSync } from 'fs';

// ---- command line ----
const args = process.argv.slice(2);
const opt = (name: string, d: number): number => { const i = args.indexOf(`--${name}`); const v = i >= 0 ? Number(args[i + 1]) : NaN; return Number.isFinite(v) ? v : d; };
const envArg = (() => { const i = args.indexOf('--env'); return i >= 0 ? String(args[i + 1] ?? '') : ''; })();
const POOLS = opt('pools', 1700), PEERS = Math.max(2, opt('peers', 12)), ROUNDS = opt('rounds', 40), CHURN = opt('churn', 0.10), RESYNC = Math.max(1, opt('resync', 5));
// QUIET SKIP (Nov 1): live pass interval and server slowness on the pretend clock.
const TABLE_MS = Math.max(1, opt('table-ms', 1_000)), SLOW = Math.max(1, opt('slow', 1));
const noTable = args.includes('--no-table'); // baseline: same pools, no table (memory reference)
const LIVE = args.includes('--live');
const TRACE = args.includes('--trace'); // one line per round on stderr
const STAMPED = args.includes('--stamped');
const WALLET_CAP = args.includes('--wallet-cap');
const PREDICTED = args.includes('--predicted');
const OLD_ARBSIM = args.includes('--old-arbsim');
const PROF = (() => { const i = args.indexOf('--prof'); return i >= 0 ? String(args[i + 1] ?? '') : ''; })();
// Steady-state CPU profile (inspector, same process).
const prof = PROF ? new Session() : null;
const post = (m: string, p?: object) => new Promise<any>((res, rej) => prof!.post(m, p ?? {}, (e, r) => (e ? rej(e) : res(r))));

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) { console.error('run with: node --expose-gc ...'); process.exit(2); }
const MB = 1024 * 1024;

// ---- the live settings (two steps, fast lane live, the bot does not ask) ----
const env: Record<string, string> = {
  LOCAL_SIM_TRIGGER_FIRST: 'on', TRIG_ENTRY_TABLE_MS: '0', TRIG_ENTRY_ONE_TRIP: '0', FASTLANE: 'live', TRIG_ENTRY_NODE_ASKS: 'off',
};
for (const kv of envArg.split(',').filter(Boolean)) { const [k, ...v] = kv.split('='); env[k.trim()] = v.join('=').trim(); }
for (const [k, v] of Object.entries(env)) process.env[k] = v; // settings read from process.env by shared helpers
const FAST = tableFastOn(env);
// QUIET SKIP: the price facts shadowMain hands over (stamp-free when on).
const QUIET = tableQuietOn(env);
const poolPriceKey = (p: any) => poolPriceKeyOf(p, QUIET);

// ---- the fake sidecar (answers the coin balance-slot lookups, takes tables) ----
let tableMsgs = 0, tableBytes = 0, patchPools = 0, msgsWithPatch = 0;
// TRUE DELTA: count pools sent as a patch (an object instead of a row list).
const notePatches = (text: string) => { const n = (text.match(/":\{"(?:r|s)":/g) ?? []).length; patchPools += n; if (n) msgsWithPatch++; };
const client = {
  isConnected: () => true,
  stats: { fallbacks: 0 },
  request: async (m: Record<string, any>) => {
    // The real client turns every message into one framed buffer (as here).
    if (m.type === 'trig_table') { tableMsgs++; const f = frame({ ...m, id: 1 }); tableBytes += f.length; notePatches(f.toString('utf8')); return { ok: true, gen: m.gen, ...(OLD_ARBSIM ? {} : { patch: true }) }; }
    if (m.type === 'call' && m.calls?.[0]?.data?.startsWith('0x70a08231')) {
      const sd = m.overrides?.[m.calls[0].to]?.stateDiff ?? {};
      const v = Object.values(sd)[0] as string | undefined;
      return { id: m.id, ok: true, results: [{ success: true, output: v ?? '0x' + '0'.repeat(64), gasUsed: '0x1' }] };
    }
    return { id: m.id, ok: false, unknown: 'bad_request' };
  },
  // The real client's pre-written path (table messages only): same text + id.
  requestBytes: async (open: Buffer[]) => { tableMsgs++; const f = framePieces(open, ',"id":1}'); tableBytes += f.length; notePatches(f.toString('utf8')); return { ok: true, ...(OLD_ARBSIM ? {} : { patch: true }) }; },
} as unknown as LocalSimClient;
const copy2: TrigCopy2 = { running: () => true, notReadyWhy: () => null, waitForTx: async () => 1, forwarder: { newestBlock: () => 1, txBlockOf: () => null } };

// ---- a live-sized pool universe ----
const USDG = '0x' + '11'.repeat(20);
const WETH = '0x' + '22'.repeat(20);
const LENDER = '0x' + 'cd'.repeat(20);
const addr = (i: number) => '0x' + (0xa0000 + i).toString(16).padStart(40, '0');
const coin = (g: number) => '0x' + (0xc0000 + g).toString(16).padStart(40, '0');
type State = { chain: string; poolAddress: string; dex: string; poolType: string; tokenA: string; tokenB: string; feeBps: number; sqrtPriceX96: bigint; liquidity: bigint; tick: number; reserveA?: bigint; reserveB?: bigint; lastUpdatedMs: number; lastUpdatedBlock: number; v: number; observedFee?: unknown; v4?: { poolManager: string; fee: number; tickSpacing: number; hooks: string; native: boolean } };
// LIVE SHAPE: what moves every second live besides pool states.
let gasUsd = 0.0123;      // $ per send (live: gas reading every 2 s x ETH price)
let wethPx = 3456.78;     // $ per WETH (live: moves with WETH/USDG trades)
const GAS_EVERY = Math.max(0, opt('gas-every', LIVE ? 2 : 0)); // seconds between gas moves (0 = never)
const PX_EVERY = Math.max(0, opt('px-every', LIVE ? 1 : 0));   // seconds between WETH price moves (0 = never)
const POOL_MANAGER = '0x' + '44'.repeat(20);
const HOOK = '0x' + '55'.repeat(19) + 'c0';
const ZERO = '0x' + '00'.repeat(20);
// Pool kinds: plain soak = V2 / V3 alternating (as before); live = the live mix.
type Kind = 'v2' | 'v3' | 'v4' | 'v4h';
const kindOf = (i: number): Kind => (!LIVE ? (i % 2 ? 'v3' : 'v2') : (['v2', 'v3', 'v3', 'v2', 'v4', 'v4h'] as Kind[])[i % 6]);
const execKind = (k: Kind) => (k === 'v2' ? KIND_V2 : k === 'v3' ? KIND_V3 : k === 'v4' ? KIND_V4 : KIND_V4_HOOKED);
// A V4 pool's id, exactly as the contract's key hashes (so hooked pools pass v4KeyMatchesId).
const v4Id = (a: string, b: string, hooks: string) => keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24', 'int24', 'address'], [a, b, 3000, 60, hooks]));
const pools: Array<{ addr: string; start: string; mid: string; kind: number; k: Kind; group: number }> = [];
for (let i = 0; i < POOLS; i++) {
  const g = Math.floor(i / PEERS), k = kindOf(i);
  const start = g % 2 === 0 ? USDG : WETH, mid = coin(g);
  // V4 pools have a 32-byte id (unique per pool: the hook address varies by pool for hooked ones).
  const hooks = k === 'v4h' ? HOOK.slice(0, 38) + (i % 4096).toString(16).padStart(4, '0') : ZERO;
  const a = k === 'v4' || k === 'v4h' ? v4Id(start, mid, k === 'v4h' ? hooks : '0x' + (0xd0000 + i).toString(16).padStart(40, '0')) : addr(i);
  pools.push({ addr: a, start, mid, kind: execKind(k), k, group: g });
}
// Each pool's current state object (a NEW object whenever it changes, as the pool cache does).
const states: State[] = pools.map((p, i) => fresh(p, i, 0));
function fresh(p: typeof pools[0], i: number, v: number): State {
  const v4 = p.k === 'v4' || p.k === 'v4h';
  const hooks = p.k === 'v4h' ? HOOK.slice(0, 38) + (i % 4096).toString(16).padStart(4, '0') : ZERO;
  return { chain: 'robinhood', poolAddress: p.addr, dex: v4 ? 'uniswap-v4' : p.kind === KIND_V3 ? 'uniswap-v3' : 'uniswap-v2', poolType: p.kind === KIND_V2 ? 'v2' : 'v3', tokenA: p.start, tokenB: p.mid, feeBps: 30,
    sqrtPriceX96: 79228162514264337593543950336n + BigInt(v * 1000 + i), liquidity: 10n ** 21n + BigInt(v), tick: v % 100, reserveA: 10n ** 24n, reserveB: 10n ** 24n + BigInt(v), lastUpdatedMs: Date.now(), lastUpdatedBlock: v, v,
    ...(v4 ? { v4: { poolManager: POOL_MANAGER, fee: 3000, tickSpacing: 60, hooks: p.k === 'v4h' ? hooks : ZERO, native: false } } : {}) };
}
const peersOf = (i: number) => { const g = pools[i].group; const out: number[] = []; for (let j = g * PEERS; j < Math.min(POOLS, (g + 1) * PEERS); j++) if (j !== i) out.push(j); return out; };
// Pretend clock (--live): 1 s per round.
let simNow = Date.now();
const simStart = simNow;
let firstBytes = 0, firstMsgs = 0;
const pxOf = (start: string) => (start === USDG ? 1 : wethPx);
// --wallet-cap: shadowMain entryBuild's own-money cap (0.98 x the wallet's value), else 400.
const capOf = (usdg: boolean) => (WALLET_CAP ? Math.min(2_000, 0.98 * (usdg ? 1_500 : 0.5 * wethPx)) : 400);

// A candidate the way shadowMain's entryBuild makes one (new object each
// call, holding both pool states).
function candOf(bi: number, si: number): EntryCandidate {
  const buy = pools[bi], sell = pools[si];
  const usdg = buy.start === USDG;
  const dec = usdg ? 6 : 18, px = pxOf(buy.start);
  const bs = states[bi], ss = states[si];
  const host = { buy: bs, sell: ss, tokenIn: buy.start, tokenOut: buy.mid, usdPer: px };
  // Plain soak: the trade by hand (cheap). LIVE: exactly shadowMain's
  // buildCheck (the contract calldata builder, with the same encode setting).
  const build = LIVE
    ? (usd: number) => {
      const input = { chain: 'robinhood' as const, tokenIn: buy.start, buyPool: bs as any, sellPool: ss as any, tradeSizeUsd: usd, netProfitUsd: 1, usdPerTokenIn: px, tokenInDecimals: dec, maxBlock: 0n, v3Lender: usdg ? undefined : LENDER };
      const b = checkBuildEncodeOn() ? buildExecuteCall(input) : planExecuteCall(input);
      if (!b.ok) return null;
      // simOpts exactly as buildCheck gives them (the WETH address lets V4 hops run).
      return { trade: { token: buy.start, amountIn: b.amountIn, hops: b.hops }, simOpts: { v3Lender: usdg ? undefined : LENDER, weth: WETH } };
    }
    : (usd: number) => ({
      trade: { token: buy.start, amountIn: BigInt(Math.round((usd / px) * 10 ** Math.min(dec, 9))) * 10n ** BigInt(dec - Math.min(dec, 9)), hops: [
        { kind: buy.kind, pool: buy.addr, tokenIn: buy.start, tokenOut: buy.mid, feeBps: 30 },
        { kind: sell.kind, pool: sell.addr, tokenIn: buy.mid, tokenOut: buy.start, feeBps: 5 },
      ] },
      simOpts: usdg ? {} : { v3Lender: LENDER },
    });
  return {
    label: `MEME${buy.group}/${usdg ? 'USDG' : 'WETH'} ${buy.addr.slice(-4)}>${sell.addr.slice(-4)}`, buyPool: buy.addr, sellPool: sell.addr, tokenIn: buy.start, tokens: [buy.start, buy.mid],
    keys: usdg ? [buy.addr, sell.addr] : [buy.addr, sell.addr, LENDER], maxSizeUsd: capOf(usdg), gasUsd,
    build,
    usdOf: (u) => Number(u) / 10 ** dec * px,
    host,
    fx: { px, d: dec, lp: usdg ? 0 : 500 },
  };
}
// The table source, the way shadowMain's entryTableRoutes lists it.
const tableRoutes = (): TablePool[] => pools.map((p, i) => ({
  pool: p.addr,
  // FAST TABLE 4 (as shadowMain's entryPoolVer): the pool's and its partners' prices.
  ...(FAST ? { ver: () => { const v: unknown[] = [poolPriceKey(states[i]), states[i].observedFee]; for (const j of peersOf(i)) v.push(pools[j].addr, poolPriceKey(states[j]), states[j].observedFee); return v; } } : {}),
  routes: (): TableRoute[] => {
    const out: TableRoute[] = [];
    for (const j of peersOf(i)) for (const [b, s] of [[i, j], [j, i]]) {
      const usdg = pools[b].start === USDG;
      // score: plain soak = a made-up number that moves with both pools'
      // states; LIVE = the real quick price check at $50 (shadowMain entryScore).
      const rid = `${pools[b].addr}>${pools[s].addr}:${pools[b].start}`;
      const quote = () => roundTripQuote(states[b] as any, states[s] as any, pools[b].start, pxOf(pools[b].start), usdg ? 6 : 18)(50);
      const score = LIVE ? quote() : ((states[b].v * 7 + states[s].v * 3 + b) % 1000) / 100;
      // inputs / live exactly as shadowMain's entryTableRoutes gives them
      // (FAST TABLE: trading details + lender facts; own money here: not
      // live, so Infinity; no lender balance read; no balance-slot rule).
      const px = pxOf(pools[b].start), dec = usdg ? 6 : 18;
      out.push({ rid, held: true, score, build: () => candOf(b, s),
        inputs: FAST ? () => [poolShapeKey(states[b]), poolShapeKey(states[s]), px, dec, WALLET_CAP ? capOf(usdg) : Infinity, 0, false] : [states[b], states[b].observedFee, states[s], states[s].observedFee, px, dec],
        ...(FAST ? { live: [poolPriceKey(states[b]), states[b].observedFee, poolPriceKey(states[s]), states[s].observedFee] } : {}) });
    }
    return out;
  },
}));

// Longest single "trig table" stretch, and how many went over 50 ms.
let tblMaxMs = 0, tblOver50 = 0, tblStretches = 0;
{
  const orig = stallFinder.noteSlice.bind(stallFinder);
  stallFinder.noteSlice = (name: string, start: number, end: number, selfMs?: number) => {
    if (name === 'trig table') { const ms = end - start; tblStretches++; if (ms > tblMaxMs) tblMaxMs = ms; if (ms > 50) tblOver50++; }
    orig(name, start, end, selfMs);
  };
}

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
    ...(LIVE ? { now: () => simNow } : {}),
  });
  gc!(); gc!();
  const base = process.memoryUsage().heapUsed;
  const busy: number[] = [], wall: number[] = [], gcPer: number[] = [], reusedPer: number[] = [];
  const skipStretch = Math.min(3, Math.max(0, ROUNDS - 1));
  let changedPools = 0;
  let landNow: number[] = [], nextLand: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    // Prices move: a share of pools each second, all of them on the re-read.
    const all = r > 0 && r % RESYNC === 0;
    // (a pass starts every TABLE_MS; one that took longer delays the next, as
    // live; its time counts SLOW x, so the clock moves as the server's would)
    if (r > 0) simNow += Math.max(TABLE_MS, Math.round((wall[wall.length - 1] ?? 0) * SLOW));
    if (r > 0 && GAS_EVERY && r % GAS_EVERY === 0) gasUsd *= 1 + (Math.random() - 0.5) * 0.004;
    if (r > 0 && PX_EVERY && r % PX_EVERY === 0) wethPx *= 1 + (Math.random() - 0.5) * 0.0004;
    for (let i = 0; i < POOLS; i++) {
      // (same prices, new object; --stamped: a new "fee read at" stamp for the
      // first pool of every other coin pair, as live re-reads give Algebra /
      // hooked V4 pools)
      if (all) { states[i] = { ...states[i], lastUpdatedMs: Date.now(), ...(STAMPED && i % PEERS === 0 && pools[i].group % 2 === 0 ? { feeReadMs: simNow, feeReadBlock: r } : {}) } as State; }
      // (trades still happen on a re-read round)
      if (r > 0 && Math.random() < CHURN) { states[i] = fresh(pools[i], i, states[i].v + 1); changedPools++; if (PREDICTED) nextLand.push(i); }
    }
    // --predicted: last round's trades land with the block's real price (a little off the prediction).
    for (const i of landNow) { const st = fresh(pools[i], i, states[i].v); states[i] = { ...st, sqrtPriceX96: st.sqrtPriceX96 + 3n, reserveB: (st.reserveB ?? 0n) + 3n }; }
    landNow = nextLand; nextLand = [];
    if (noTable) { await new Promise((res) => setImmediate(res)); continue; }
    if (r === skipStretch) {
      tblMaxMs = 0; tblOver50 = 0; tblStretches = 0; // steady state only (after the from-scratch builds)
      if (prof) { prof.connect(); await post('Profiler.enable'); await post('Profiler.start'); }
    }
    const g0 = gcMs, t0 = performance.now();
    await te.refreshTable();
    wall.push(performance.now() - t0);
    busy.push(te.tableInfo().busyMs);
    gcPer.push(gcMs - g0);
    reusedPer.push(te.tableInfo().reused);
    if (r === 0) { firstBytes = tableBytes; firstMsgs = tableMsgs; }
    if (TRACE) console.error(`round ${r} t=${Math.round((simNow - simStart) / 1000)}s busy=${Math.round(busy[busy.length - 1])}ms wall=${Math.round(wall[wall.length - 1])}ms skipped=${(te as any).tbl?.lastSkipped} held=${(te as any).tbl?.lastHeld} kept=${(te as any).tbl?.lastKeptRoutes} turns=${(te as any).tbl?.lastTurns} reused=${te.tableInfo().reused} msgs=${tableMsgs} MB=${Math.round(tableBytes / MB)}`);
  }
  if (prof) { const { profile } = await post('Profiler.stop'); writeFileSync(PROF, JSON.stringify(profile)); prof.disconnect(); }
  gc!(); gc!();
  const held = process.memoryUsage().heapUsed - base;
  const info = te.tableInfo();
  const p = (xs: number[], q: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const skip = Math.min(3, Math.max(0, busy.length - 1)); // first rounds build everything from scratch
  const steady = (xs: number[]) => xs.slice(skip);
  console.log(JSON.stringify({
    settings: envArg || '(defaults)', live: LIVE, gasEvery: GAS_EVERY, pxEvery: PX_EVERY, pools: POOLS, routesPerPool: (PEERS - 1) * 2, rounds: ROUNDS, churn: CHURN, resyncEvery: RESYNC, noTable,
    heldBackDrift: (te as any).tbl?.lastHeld, poolsSkipped: (te as any).tbl?.lastSkipped, gasOnlyRestops: (te as any).tbl?.lastRestop,
    routes: info.routes, reused: info.reused, reusedAvg: Math.round(avg(steady(reusedPer))), entriesHeld: info.entries,
    trigTableStretch: { maxMs: Math.round(tblMaxMs), over50ms: tblOver50, stretches: tblStretches },
    busyMs: { first: Math.round(busy[0] ?? 0), avg: Math.round(avg(steady(busy))), p90: Math.round(p(steady(busy), 0.9)) },
    wallMs: { avg: Math.round(avg(steady(wall))) },
    gcMsPerRebuild: Math.round(avg(steady(gcPer))), gcCount: gcN,
    tableHeldMB: Math.round(held / MB), heapUsedMB: Math.round(process.memoryUsage().heapUsed / MB),
    tableMsgs, tableMB: Math.round(tableBytes / MB), changedPools,
    // Sent to arbsim per pretend second, after the first (full) table.
    sentMBperSec: Math.round(((tableBytes - firstBytes) / MB / Math.max(1, (simNow - simStart) / 1_000)) * 10) / 10,
    simSeconds: Math.round((simNow - simStart) / 1_000),
    // Table messages to arbsim per pretend minute, after the first (full) table.
    msgsPerMin: Math.round(((tableMsgs - firstMsgs) / Math.max(1, (simNow - simStart) / 60_000)) * 10) / 10,
    // Per pretend minute, after the first (full) table (TRUE DELTA comparison).
    mbPerMin: Math.round(((tableBytes - firstBytes) / MB / Math.max(1, (simNow - simStart) / 60_000)) * 10) / 10,
    firstTableMB: Math.round((firstBytes / MB) * 10) / 10,
    patchPools, msgsWithPatch, walletCap: WALLET_CAP, predicted: PREDICTED, oldArbsim: OLD_ARBSIM,
    delta: (te as any).settings?.tableDelta, lastDelta: (te as any).tbl?.delta,
    tableMs: TABLE_MS, slow: SLOW,
  }, null, 1));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
