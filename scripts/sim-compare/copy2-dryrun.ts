// ============================================================================
// COPY 2 LIVE DRY RUN (read only, bot untouched): is the event-updated pool
// copy exactly right, live?
//
// Plain English:
//   "Copy 2" = arbsim keeps a copy of OUR pools current from the pools' own
//   reports (swaps, mints, burns, syncs, coin transfers), so the bot can check
//   a gap in ~1 ms instead of asking the node (sim/COPY2_PLAN.md). Before the
//   bot relies on it, this script proves it right, next to the bot, as a
//   completely separate program:
//     1. starts its OWN arbsim (the binary you name) on a TEST socket in
//        pool-events mode, with its own small daily node allowance and its own
//        allowance file (never the bot's arbsim, never the bot's socket)
//     2. tells it which pools to follow (`track`: pools whose coin pair is on
//        2+ exchanges in the bot's watch list, of the kinds copy 2 supports)
//     3. opens its OWN Chainstack WebSocket subscription to those pools'
//        reports + coin Transfers to/from them, and hands arbsim one
//        `pool_logs` message per block, in block order (`block_tick` for
//        blocks with nothing on our pools)
//     4. every --every blocks, at that block:
//          a. picks a few READY pools and reads their price, liquidity and
//             coin balances from the copy AND from the node: must be identical
//          b. runs a few real checks (our contract, 2-pool round trips on our
//             pools, a few sizes) with the bot's OWN check code
//             (simulateRoundTrip), once answered by the copy and once by the
//             node, and compares verdict, profit and gas
//     5. writes a plain-English summary every 5 minutes and at the end:
//        pools ready / unsure, pool-state match %, check match %, WRONG count
//        (copy said profit, node said no), node reads used, and how fast the
//        copy is updated after a report arrives
//
//   Files in --out: summary.txt / summary.json (latest), probes.jsonl and
//   checks.jsonl (one line per comparison), status.jsonl (arbsim's own
//   status every 30 s), arbsim.log (the test arbsim's own messages).
//
// Safety: READ ONLY. From the bot's .env it reads ONLY CHAINSTACK_WSS_ROBINHOOD
// and CHAINSTACK_RPC_ROBINHOOD (never printed; the node link is handed to the
// test arbsim through its environment only). Nothing is signed or sent to
// the chain; checks are pretend calls ("what would happen if").
//
// Run on the server (after `npx tsc -p scripts/sim-compare/tsconfig.json`):
//   nice -n 19 node .scripts-build/scripts/sim-compare/copy2-dryrun.js \
//     --arbsim ~/arbsim-copy2/arbsim [--minutes 60] [--out ~/sim-compare-runs/copy2-1] \
//     [--socket /tmp/arbsim-copy2-test.sock] [--every 40] [--pools 2] [--checks 2] \
//     [--rps 3] [--max-node-reads 20000] [--arbsim-cap 3000] [--only-proven]
//   --no-spawn: use an arbsim already running on --socket (started by you).
// ============================================================================
import { spawn, ChildProcess } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, unlinkSync, openSync } from 'fs';
import { createConnection } from 'net';
import { join } from 'path';
import WebSocket from 'ws';
import { PoolState } from '../../src/core/types';
import { simulateRoundTrip, loadBalanceSlots, Rpc, SIM_EXECUTOR_ADDRESS, SimResult } from '../../src/execution/simulator';
import { ROBINHOOD_TOKENS } from '../../src/config/knownAddresses';
import { ArbsimClient } from './engines';
import { buildPoolBook, routesThrough, DEFAULT_SIZES, flashLendersFromEnv, RouteSpec } from './pools';
import { makeHarnessRpc, bigReviver } from './util';
import {
  followedPools, logFilters, classifyLog, BlockAssembler, BlockOut, blockMessage, headFromNewHeads, readCopy2Status, Copy2Status,
  probeCalls, readFastAnswer, rawFromEthCall, compareProbe, rpcFromFast, rpcFromTrace, compareCheck, choosePools, pickSample,
  Score, summaryText, RawAnswer, FastOutcome, Followed, PROBE_FROM, hex,
} from './copy2Lib';

// --- settings ---------------------------------------------------------------
const BOT_DIR = process.env.BOT_DIR || `${process.env.HOME}/multichain-arb-engine`;
const args = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k: string) => args.includes(`--${k}`);
const ARBSIM_BIN = arg('arbsim');
const NO_SPAWN = flag('no-spawn');
const SOCKET = arg('socket', '/tmp/arbsim-copy2-test.sock')!;
const OUT = arg('out', `${process.env.HOME}/sim-compare-runs/copy2-1`)!;
const MINUTES = Number(arg('minutes', '60'));
const EVERY = Math.max(1, Number(arg('every', '40')));        // blocks between comparison rounds (~10 s)
const N_POOLS = Number(arg('pools', '2'));                    // pools probed per round
const N_CHECKS = Number(arg('checks', '2'));                  // real checks per round
const RPS = Number(arg('rps', '3'));                          // checker's own node speed limit
const MAX_NODE_READS = Number(arg('max-node-reads', '20000')); // checker's own node reads, whole run
const ARBSIM_CAP = arg('arbsim-cap', '3000')!;                // test arbsim's daily paid-node allowance
const ARBSIM_RPS = arg('arbsim-rps', '2')!;
const GRACE_MS = Number(arg('grace-ms', '30'));
const ONLY_PROVEN = flag('only-proven');
const NODE_GAS = arg('node-gas', 'trace');                    // trace = debug_traceCall (gives gas) | call = plain eth_call
const SUMMARY_MS = 5 * 60_000;
const WETH = ROBINHOOD_TOKENS.WETH.toLowerCase();
const EXECUTOR = SIM_EXECUTOR_ADDRESS.toLowerCase();

if (!ARBSIM_BIN && !NO_SPAWN) { console.error('need --arbsim <path to the arbsim binary built from copy 2> (or --no-spawn with --socket)'); process.exit(1); }
if (SOCKET === '/tmp/arbsim.sock' || SOCKET === process.env.ARBSIM_SOCKET) { console.error('refusing: that is the bot\'s own arbsim socket; use a test socket'); process.exit(1); }
mkdirSync(OUT, { recursive: true });

// --- the two .env lines (never printed) -------------------------------------
const envText = (() => { try { return readFileSync(join(BOT_DIR, '.env'), 'utf8'); } catch { return ''; } })();
const envVar = (k: 'CHAINSTACK_WSS_ROBINHOOD' | 'CHAINSTACK_RPC_ROBINHOOD'): string | null => {
  const m = envText.match(new RegExp(`^\\s*(?:export\\s+)?${k}\\s*=\\s*["']?([^"'\\s#]+)`, 'm'));
  return process.env[k] || (m ? m[1]! : null);
};
const WSS = envVar('CHAINSTACK_WSS_ROBINHOOD');
const HTTP = envVar('CHAINSTACK_RPC_ROBINHOOD');
if (!WSS || !HTTP) { console.error('CHAINSTACK_WSS_ROBINHOOD / CHAINSTACK_RPC_ROBINHOOD missing in .env'); process.exit(1); }
// Any text we print goes through this, so a node link can never leak into a log.
const redact = (s: unknown) => String(s).split(WSS).join('<wss>').split(HTTP).join('<node>');
const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${redact(s)}`);

// --- checker's own node connection (speed limit + run cap + the bot's allowance, read only)
const harness = makeHarnessRpc(HTTP, { rps: RPS, maxRequests: MAX_NODE_READS, usageFile: join(BOT_DIR, 'data/node-usage.json') });
const node: Rpc = harness.rpc;
// The bot's saved coin balance locations, read only (never written: slotReadOnly).
loadBalanceSlots(join(BOT_DIR, 'data/balance-slots.json'));

const score = new Score();
const writeLine = (file: string, rec: unknown) => appendFileSync(join(OUT, file), JSON.stringify(rec, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n');

// --- watch list -> pools we follow ------------------------------------------
let book = buildPoolBook([], {});
function loadFollowed(): Followed {
  const d = JSON.parse(readFileSync(join(BOT_DIR, 'data', 'watched-pools.json'), 'utf8'), bigReviver);
  const list: PoolState[] = d.pools ?? [];
  const f = followedPools(list, WETH, ONLY_PROVEN);
  // Routes for real checks: only between pools copy 2 follows.
  book = buildPoolBook([...f.pools.values()].map((x) => x.pool), d.meta ?? {});
  return f;
}
let followed = loadFollowed();
score.tracked = followed.pools.size;
score.notFollowed = followed.notFollowed;

// --- the test arbsim ---------------------------------------------------------
let child: ChildProcess | null = null;
const canConnect = (p: string) => new Promise<boolean>((res) => { const s = createConnection(p); s.once('connect', () => { s.end(); res(true); }); s.once('error', () => res(false)); });
async function startArbsim(): Promise<void> {
  if (NO_SPAWN) { if (!(await canConnect(SOCKET))) throw new Error(`--no-spawn: nothing answers on ${SOCKET}`); return; }
  if (existsSync(SOCKET)) {
    if (await canConnect(SOCKET)) throw new Error(`${SOCKET} is in use by another program; pick another --socket`);
    unlinkSync(SOCKET); // stale file from an earlier run
  }
  // Minimal environment: nothing from the bot except the paid node link
  // (handed over here, never printed) and the test settings below.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp',
    ARBSIM_SOURCE: 'pool-events', ARBSIM_SOCKET: SOCKET,
    ARBSIM_NODE_URL: HTTP!, ARBSIM_NODE_DAILY_CAP: ARBSIM_CAP, ARBSIM_NODE_RPS: ARBSIM_RPS,
    ARBSIM_BUDGET_FILE: join(OUT, 'arbsim-node-budget.json'),
  };
  // Extra test settings: --arbsim-env ARBSIM_X=1 (ARBSIM_ names only).
  args.forEach((a, i) => { if (a === '--arbsim-env') { const m = /^(ARBSIM_[A-Z0-9_]+)=(.*)$/.exec(args[i + 1] ?? ''); if (m) env[m[1]!] = m[2]!; } });
  const logFd = openSync(join(OUT, 'arbsim.log'), 'a');
  child = spawn('nice', ['-n', '10', ARBSIM_BIN!, 'serve', SOCKET], { env, stdio: ['ignore', logFd, logFd] });
  child.on('exit', (code, sig) => { log(`test arbsim stopped (code ${code}, signal ${sig}); see ${join(OUT, 'arbsim.log')}`); child = null; });
  for (let i = 0; i < 300 && !(await canConnect(SOCKET)); i++) await new Promise((r) => setTimeout(r, 100));
  if (!(await canConnect(SOCKET))) throw new Error('test arbsim did not open its socket within 30 s (see arbsim.log)');
}
const calls = new ArbsimClient(SOCKET, 30_000);   // questions (call / status / track)
const feed = new ArbsimClient(SOCKET, 1_500);     // one connection for the block messages, so their order is kept

async function arbsimStatus(): Promise<Copy2Status | null> {
  try { const s = await calls.request({ type: 'status', pools: true }); const st = readCopy2Status(s); score.arbsimStatus(st); return st; } catch { return null; }
}

async function sendTrack(): Promise<void> {
  const pools = [...followed.pools.values()].map((x) => x.track);
  try {
    const a = await calls.request({ type: 'track', pools });
    score.trackOk = a?.ok === true;
    log(`track: ${pools.length} pools sent, arbsim ${a?.ok ? 'accepted' : `refused: ${JSON.stringify(a).slice(0, 200)}`}`);
  } catch (e) { score.trackOk = false; log(`track: no answer (${(e as Error).message})`); }
}

// --- feeding blocks to the copy ---------------------------------------------
const asm = new BlockAssembler(GRACE_MS);
const recentlyChanged = new Map<string, number>(); // pool key -> last block it had a report
let backfilling = false;
let timingWatch: { block: number; since: number; sentAt: number } | null = null;
let roundBusy = false;
let lastRoundBlock = 0;
const appliedWaiters: Array<{ block: number; resolve: () => void }> = [];
let copyBlock = 0;

function noteApplied(block: number) {
  if (block <= copyBlock) return;
  copyBlock = block;
  for (let i = appliedWaiters.length - 1; i >= 0; i--) if (appliedWaiters[i]!.block <= block) { appliedWaiters[i]!.resolve(); appliedWaiters.splice(i, 1); }
}
const waitApplied = (block: number, ms: number) => new Promise<boolean>((res) => {
  if (copyBlock >= block) return res(true);
  const t = setTimeout(() => res(false), ms);
  appliedWaiters.push({ block, resolve: () => { clearTimeout(t); res(true); } });
});

function sendBlock(b: BlockOut) {
  const msg = blockMessage(b);
  score.blocksSent++;
  if (!b.logs.length) score.ticksSent++;
  for (const l of b.logs) {
    if (l.removed) score.removedLogs++;
    const c = classifyLog(l, followed);
    if (c === 'transfer') score.transfersSent++; else score.logsSent++;
    if (c === 'pool') {
      const a = l.address.toLowerCase();
      const key = followed.pools.has(a) ? a : (l.topics?.[1] ?? '').toLowerCase();
      if (followed.pools.has(key)) recentlyChanged.set(key, b.block);
    }
  }
  const since = b.firstLogAt;
  const sentAt = Date.now();
  feed.request(msg).then((a) => {
    // arbsim answers block messages: that answer = "copy updated".
    if (a?.ok === true) { score.ackMode = 'answer'; if (since !== null && b.logs.length) score.updateMs.push(Date.now() - since); score.applyMs.push(Date.now() - sentAt); noteApplied(b.block); }
    else if (a && a.ok === false && score.blocksSent < 5) log(`arbsim refused a block message: ${JSON.stringify(a).slice(0, 200)}`);
  }).catch(() => {
    // No answer (fire-and-forget like `feed`): measure through `status` instead.
    if (score.ackMode === 'unknown') score.ackMode = 'status';
    if (score.ackMode === 'status' && b.logs.length && since !== null && !timingWatch) timingWatch = { block: b.block, since, sentAt };
  });
  if (b.block - lastRoundBlock >= EVERY && !roundBusy && !b.late) { lastRoundBlock = b.block; void runRound(b.block); }
}

// Status-based "copy updated" timing (only when arbsim doesn't answer block messages).
// Polls only while something waits for it (a timing sample or a round).
let polling = false;
setInterval(async () => {
  if (polling || score.ackMode === 'answer' || (!timingWatch && !appliedWaiters.length)) return;
  polling = true;
  const st = await arbsimStatus();
  polling = false;
  if (st?.block) noteApplied(st.block);
  if (timingWatch && st?.block && st.block >= timingWatch.block) { score.updateMs.push(Date.now() - timingWatch.since); score.applyMs.push(Date.now() - timingWatch.sentAt); timingWatch = null; }
  else if (timingWatch && Date.now() - timingWatch.since > 5_000) timingWatch = null;
}, 50);

// Sends finished blocks in order. A block that still has no block time
// (its header never came over the WebSocket) gets its header read from the
// node first: arbsim refuses block messages without a timestamp.
let pumping = false;
async function pump() {
  if (backfilling || pumping) return;
  pumping = true;
  try {
    for (const b of asm.due(Date.now())) {
      if (b.timestamp === null) {
        const h = await node('eth_getBlockByNumber', [hex(b.block), false]);
        const head = h.result ? headFromNewHeads(h.result, Date.now()) : null;
        if (head) { b.timestamp = head.timestamp; b.l1Block = head.l1Block; score.headersFetched = (score.headersFetched ?? 0) + 1; }
      }
      if (b.timestamp === null) { score.blocksNoTime = (score.blocksNoTime ?? 0) + 1; continue; } // can't send without a time: arbsim will see a gap and reload
      sendBlock(b);
    }
  } finally { pumping = false; }
}
setInterval(() => { void pump(); }, 10);

// Missed blocks (e.g. the WebSocket dropped): read them back from the node
// with the same filters, so the copy never skips a report.
async function backfill(from: number, to: number) {
  if (to - from > 500) { log(`missed ${to - from + 1} blocks, too many to read back: copy 2 can no longer be trusted, restart this run`); return; }
  backfilling = true;
  try {
    score.gapsBackfilled++; score.gapBlocks += to - from + 1;
    for (const f of logFilters(followed)) {
      const r = await node('eth_getLogs', [{ ...f, fromBlock: hex(from), toBlock: hex(to) }]);
      for (const l of (r.result as any[]) ?? []) if (classifyLog(l, followed)) asm.addLog(l, Date.now());
    }
    for (let b = from; b <= to; b++) {
      const h = await node('eth_getBlockByNumber', [hex(b), false]);
      const head = h.result ? headFromNewHeads(h.result, Date.now() - 10_000) : null;
      if (head) asm.addHead(head);
    }
  } finally { backfilling = false; }
}

function openPush() {
  const ws = new WebSocket(WSS!);
  let sid = 0, subscribed = 0, refused = 0;
  ws.on('open', () => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++sid, method: 'eth_subscribe', params: ['newHeads'] }));
    for (const f of logFilters(followed)) ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++sid, method: 'eth_subscribe', params: ['logs', f] }));
  });
  ws.on('message', (d) => {
    const now = Date.now();
    let m: any; try { m = JSON.parse(d.toString()); } catch { return; }
    if (m.id !== undefined) { if (m.error) { refused++; log(`subscription refused: ${String(m.error.message).slice(0, 120)}`); } else if (++subscribed === sid) log(`subscribed: ${subscribed - 1} report filters + new blocks (${refused} refused)`); return; }
    const r = m?.params?.result; if (!r) return;
    if (r.parentHash && r.number && !r.transactionHash) {
      const h = headFromNewHeads(r, now); if (!h) return;
      const gap = asm.gapBefore(h.block);
      asm.addHead(h);
      if (gap && !backfilling) void backfill(gap.from, gap.to);
      return;
    }
    if (!classifyLog(r, followed)) { score.ignoredLogs++; return; }
    const late = asm.addLog(r, now);
    if (late) { if (late.timestamp !== null) sendBlock(late); else score.blocksNoTime++; }
  });
  ws.on('close', () => { log('WebSocket closed, reconnecting in 2 s'); setTimeout(openPush, 2000); });
  ws.on('error', (e) => log(`WebSocket error: ${e.message}`));
}

// --- one comparison round ---------------------------------------------------
async function askFast(block: number, overrides: Record<string, unknown>, cs: Array<{ from: string; to: string; data: string; gas?: string; value?: string }>): Promise<FastOutcome> {
  try {
    const a = await calls.request({ type: 'call', at: { block: hex(block) }, overrides, calls: cs.map((c) => ({ from: c.from, to: c.to, data: c.data, gas: c.gas ?? '0x1e8480', value: c.value ?? '0x0' })) });
    return readFastAnswer(a, cs.length);
  } catch (e) { return { kind: 'unknown', why: `socket: ${(e as Error).message.slice(0, 80)}` }; }
}

async function probePool(block: number, key: string) {
  const t = followed.pools.get(key)!.track;
  const pc = probeCalls(t);
  const fast = await askFast(block, {}, pc.map((c) => ({ from: PROBE_FROM, to: c.to, data: c.data })));
  const nodeAns: Array<RawAnswer | null> = [];
  for (const c of pc) { const r = await node('eth_call', [{ from: PROBE_FROM, to: c.to, data: c.data }, hex(block)]); nodeAns.push(rawFromEthCall(r)); }
  const cmp = compareProbe(fast, nodeAns);
  score.addProbe(cmp.verdict, cmp.verdict === 'fast-unsure' || cmp.verdict === 'fast-missing' ? cmp.diffs[0] : undefined);
  writeLine('probes.jsonl', { t: Date.now(), block, pool: key, kind: t.kind, dex: followed.pools.get(key)!.pool.dex, verdict: cmp.verdict, labels: pc.map((c) => c.label), ...(cmp.verdict === 'same' ? {} : { diffs: cmp.diffs, fast, node: nodeAns }) });
}

// The bot's own check, answered by the copy (fast) or by the node, at `block`.
// Everything except our contract call (e.g. a coin's balance location, read
// once and kept) goes to the node on both sides.
function fastRpc(block: number, cap: { raw: RawAnswer | null; unknown: string | null }): Rpc {
  return async (method, params) => {
    const p = params as any[];
    if (method !== 'eth_call' || String(p[0]?.to).toLowerCase() !== EXECUTOR) { return node(method, params); }
    const o = await askFast(block, p[2] ?? {}, [p[0]]);
    cap.raw = o.kind === 'answer' ? o.results[0]! : null; cap.unknown = o.kind === 'unknown' ? o.why : null;
    return rpcFromFast(o);
  };
}
let traceWorks = NODE_GAS === 'trace';
function nodeRpc(cap: { raw: RawAnswer | null }): Rpc {
  return async (method, params) => {
    const p = params as any[];
   
    if (method !== 'eth_call' || String(p[0]?.to).toLowerCase() !== EXECUTOR) return node(method, params);
    if (traceWorks) {
      // callTracer gives the same answer as eth_call PLUS the gas used.
      const r = await node('debug_traceCall', [p[0], p[1], { tracer: 'callTracer', stateOverrides: p[2] ?? {} }]);
      if (r.result) { const t = rpcFromTrace(r.result); cap.raw = t.raw; return t.rpc; }
      if (/not (found|available|supported)|does not exist|unknown method/i.test(String(r.error?.message))) { traceWorks = false; log('node has no debug_traceCall: gas is not compared'); }
      else return r; // busy / network: reported as node trouble
    }
    const r = await node(method, params);
    cap.raw = rawFromEthCall(r);
    return r;
  };
}

async function runCheck(block: number, route: RouteSpec) {
  const trade = { token: route.token, amountIn: route.amountIn, hops: route.hops };
  const opts = { weth: ROBINHOOD_TOKENS.WETH, blockTag: hex(block), slotReadOnly: true, ...(route.v3Lender ? { v3Lender: route.v3Lender } : {}) };
  // Copy first (its version of this block is newest now), then the node.
  const fc = { raw: null as RawAnswer | null, unknown: null as string | null };
  const t0 = Date.now();
  const fast: SimResult = await simulateRoundTrip(fastRpc(block, fc), 'robinhood', trade, opts);
  const fastMs = Date.now() - t0;
  const nc = { raw: null as RawAnswer | null };
  const nodeR: SimResult = await simulateRoundTrip(nodeRpc(nc), 'robinhood', trade, opts);
  const cmp = compareCheck(fast, nodeR, fc.raw, nc.raw, fc.unknown);
  score.addCheck(cmp, fc.unknown ?? undefined);
  writeLine('checks.jsonl', {
    t: Date.now(), block, pair: route.pair, kinds: route.kinds, size: route.sizeLabel, funding: route.funding,
    buy: route.buyPool.poolAddress, sell: route.sellPool.poolAddress, ...cmp, fastMs,
    fast: { status: fast.status, profit: fast.status === 'profit' ? fast.profit : undefined, why: fc.unknown ?? ('reason' in fast ? fast.reason : undefined) },
    node: { status: nodeR.status, profit: nodeR.status === 'profit' ? nodeR.profit : undefined, why: 'reason' in nodeR ? nodeR.reason : undefined },
    ...(cmp.verdict === 'exact' ? {} : { fastRaw: fc.raw, nodeRaw: nc.raw }),
  });
}

async function runRound(block: number) {
  roundBusy = true;
  try {
    // Wait (up to 3 s) until the copy says it has applied this block.
    await waitApplied(block, 3_000);
    if (harness.stats.capHit) return;
    const st = (await arbsimStatus()) ?? readCopy2Status({});
    const keys = [...followed.pools.keys()];
    const changed = [...recentlyChanged.entries()].filter(([, b]) => b > block - EVERY * 4).map(([k]) => k);
    const seed = `round-${block}`;
    // a. pool state
    const { pools } = choosePools(keys, st, changed, N_POOLS, seed);
    for (const k of pools) await probePool(block, k);
    // b. real checks: routes through pools that just changed (else any), both pools ready
    const ready = (k: string) => !st.ready || st.ready.has(k);
    const base = (changed.length ? changed : keys).filter(ready);
    const routes: RouteSpec[] = [];
    const refused: Record<string, number> = {};
    for (const k of pickSample(base, 4, seed + ':routes')) {
      const p = book.pools.get(k); if (!p) continue;
      routes.push(...routesThrough(book, p, DEFAULT_SIZES, refused, flashLendersFromEnv()).filter((r) => ready(r.buyPool.poolAddress.toLowerCase()) && ready(r.sellPool.poolAddress.toLowerCase())));
    }
    for (const r of pickSample(routes, N_CHECKS, seed + ':checks')) await runCheck(block, r);
  } catch (e) { log(`round at block ${block} failed: ${(e as Error).message}`); }
  finally { roundBusy = false; }
}

// --- summaries ----------------------------------------------------------------
function writeSummary(final: boolean) {
  score.nodeReads = harness.stats.total; // the harness counts every request it really sent
  const j = score.json();
  const txt = summaryText(j, final);
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(j, null, 1));
  writeFileSync(join(OUT, 'summary.txt'), txt + '\n');
  console.log('\n' + txt + '\n');
}

async function main() {
  log(`following ${followed.pools.size} pools (${Object.entries(followed.notFollowed).map(([k, n]) => `${n} not followed: ${k}`).join('; ') || 'all followed'}); run ${MINUTES} min, round every ${EVERY} blocks`);
  await startArbsim();
  log(`test arbsim ${NO_SPAWN ? 'found' : 'started'} on ${SOCKET} (pool-events mode, daily paid-node allowance ${ARBSIM_CAP})`);
  await arbsimStatus();
  await sendTrack();
  openPush();
  // Watch list changes: re-read every 10 min and re-send `track` if it changed.
  setInterval(() => {
    try {
      const before = JSON.stringify([...followed.pools.values()].map((x) => x.track));
      const f = loadFollowed();
      if (JSON.stringify([...f.pools.values()].map((x) => x.track)) !== before) { followed = f; score.tracked = f.pools.size; score.notFollowed = f.notFollowed; void sendTrack(); }
    } catch (e) { log(`watch list re-read failed: ${(e as Error).message}`); }
  }, 10 * 60_000);
  setInterval(async () => { try { writeLine('status.jsonl', { t: Date.now(), ...(await calls.request({ type: 'status', pools: true })) }); } catch { /* arbsim gone: logged by exit */ } }, 30_000);
  setInterval(() => writeSummary(false), SUMMARY_MS);
  const stop = async () => {
    await arbsimStatus();
    writeSummary(true);
    child?.kill('SIGTERM');
    setTimeout(() => process.exit(0), 500);
  };
  setTimeout(stop, MINUTES * 60_000);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
main().catch((e) => { console.error('ERROR', redact((e as Error).message)); child?.kill('SIGTERM'); process.exit(1); });
