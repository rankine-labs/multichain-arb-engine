// ============================================================================
// SIM-COMPARE: command line. READ ONLY: never signs or sends a transaction.
//
// Build once:   npx tsc -p scripts/sim-compare/tsconfig.json
// Run:          nice -n 19 node --max-old-space-size=128 .scripts-build/scripts/sim-compare/main.js <command> [options]
//
// Commands (each step can be run alone; `all` runs them in order):
//   collect   find the checks the bot would have run       -> cases.jsonl, blocks/
//   node      ask the node each check (the truth)          -> node.jsonl
//   fast      ask the fast engine each check               -> fast-<engine>.jsonl
//   report    compare and write the result                 -> report.json, report.txt
//   all       collect + node + fast + report
//   plan      print what a run would cost (no node use beyond 1 request)
//
// See scripts/sim-compare/README.md for every option and the exact server commands.
// ============================================================================
import { setPriority } from 'os';
import { join, resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { Rpc } from '../../src/execution/simulator';
import { loadBalanceSlots } from '../../src/execution/simulator';
import { loadPoolBook, DEFAULT_SIZES, SizeConfig, routesThrough, allRoutes, flashLendersFromEnv } from './pools';
import { collectCases, getLogsSplit, triggersFromLogs, watchAddresses, dedupeRoutes } from './collect';
import { ArbsimSocketEngine, EchoEngine, FastEngine, FixtureEngine } from './engines';
import { runNodeStep, runFastStep, buildReport, reportText, fastFileOf } from './pipeline';
import { findNodeUrl, makeHarnessRpc, nodeAllowance, writeJsonAtomic, loadById, readJson, sha } from './util';
import { NodeRecord } from './types';
import { writeFileSync } from 'fs';

export interface Opts {
  cmd: string;
  botDir: string;
  out: string | null;
  from: number | null; to: number | null; last: number | null;
  maxCases: number;
  maxRoutesPerTrigger: number;
  standingEvery: number; standingRoutes: number; tradeShare: number;
  rps: number; concurrency: number; maxRequests: number;
  resume: boolean;
  engine: 'arbsim' | 'fixture' | 'echo';
  socket: string;
  arbsimBin: string;
  keepFixtures: boolean;
  node: string | undefined;
  sizes: SizeConfig;
  logChunk: number;
  poolsFile: string | null;
}

const num = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && Number.isFinite(n) ? n : d; };
const list = (v: string | undefined, d: number[]) => (v ? v.split(',').map(Number).filter((x) => x > 0) : d);

export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): Opts {
  const a = new Map<string, string>();
  const flags = new Set<string>();
  let cmd = 'help';
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    if (!x.startsWith('--')) { if (cmd === 'help') cmd = x; continue; }
    const [k, v] = x.slice(2).split('=', 2) as [string, string | undefined];
    if (v !== undefined) a.set(k, v);
    else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) a.set(k, argv[++i]!);
    else flags.add(k);
  }
  const botDir = resolve(a.get('bot-dir') ?? env.BOT_DIR ?? (existsSync('data') ? '.' : `${env.HOME}/multichain-arb-engine`));
  return {
    cmd, botDir,
    out: a.get('out') ?? null,
    from: a.has('from') ? num(a.get('from'), 0) : null, to: a.has('to') ? num(a.get('to'), 0) : null, last: a.has('last') ? num(a.get('last'), 0) : null,
    maxCases: num(a.get('max-cases'), 20_000),
    maxRoutesPerTrigger: num(a.get('routes-per-trade'), 6),
    standingEvery: num(a.get('standing-every'), 20), standingRoutes: num(a.get('standing-routes'), 4),
    tradeShare: Math.min(1, Math.max(0, num(a.get('trade-share'), 1))),
    rps: num(a.get('rps'), 5), concurrency: Math.max(1, num(a.get('concurrency'), 2)), maxRequests: num(a.get('max-requests'), 30_000),
    resume: flags.has('resume') || a.get('resume') === 'true',
    engine: (a.get('engine') as Opts['engine']) ?? 'arbsim',
    socket: a.get('socket') ?? env.ARBSIM_SOCKET ?? '/tmp/arbsim.sock',
    arbsimBin: a.get('arbsim') ?? join(botDir, 'sim/target/release/arbsim'),
    keepFixtures: flags.has('keep-fixtures'),
    node: a.get('node'),
    sizes: { usdg: list(a.get('sizes-usdg'), DEFAULT_SIZES.usdg), weth: list(a.get('sizes-weth'), DEFAULT_SIZES.weth) },
    logChunk: num(a.get('log-chunk'), 500),
    poolsFile: a.get('pools') ?? null,
  };
}

const HELP = `sim-compare: does arbsim give the same answers as the node? (read only)
  commands: plan | collect | node | fast | report | all
  --last N | --from A --to B     block range (required for collect/all/plan)
  --out DIR                      run folder (default data/sim-compare/<from>-<to>)
  --max-cases 20000              stop collecting after this many checks
  --routes-per-trade 6           at most this many routes per trade followed
  --standing-every 20 --standing-routes 4   standing-gap sample (0 = none)
  --trade-share 1                follow this share of trades (0.2 = 1 in 5, same pick every run)
  --sizes-usdg 100,1000,5000 --sizes-weth 0.03,0.3,1.5
  --rps 5 --concurrency 2 --max-requests 30000   node limits for this run
  --engine arbsim|fixture|echo   fast side (echo = FAKE, pipeline test)
  --socket /tmp/arbsim.sock --arbsim <path to arbsim binary> --keep-fixtures
  --node CHAINSTACK_RPC_ROBINHOOD|SIM_RPC_ROBINHOOD|QUICKNODE_RPC_ROBINHOOD|ROBINHOOD_RPC_HTTP   pick one node setting
  --pools <file>                 watch list (default <bot>/data/watched-pools.json)
  --resume                       continue a stopped run (answers are never asked twice anyway)`;

export async function main(argv: string[]): Promise<number> {
  const o = parseArgs(argv);
  const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
  if (o.cmd === 'help' || !['plan', 'collect', 'node', 'fast', 'report', 'all'].includes(o.cmd)) { console.log(HELP); return o.cmd === 'help' ? 0 : 2; }
  try { setPriority(19); } catch { /* not allowed: fine */ } // lowest CPU priority: the live bot comes first

  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    log('stopping after the checks in flight (Ctrl-C again to quit now). Run the same command with --resume to continue.');
  });
  const stop = () => stopping;

  // ---- node connection (only the URL lines of .env are read) --------------
  let rpc: Rpc | null = null;
  let stats: ReturnType<typeof makeHarnessRpc>['stats'] | null = null;
  const needNode = o.cmd !== 'report' && !(o.cmd === 'fast' && o.engine !== 'fixture');
  if (needNode) {
    const node = findNodeUrl(o.botDir, process.env, o.node);
    if (!node) { log(`no node URL found (looked for SIM_RPC_ROBINHOOD, QUICKNODE_RPC_ROBINHOOD, ROBINHOOD_RPC_HTTP in the environment and ${o.botDir}/.env)`); return 1; }
    const h = makeHarnessRpc(node.url, { rps: o.rps, maxRequests: o.maxRequests, usageFile: join(o.botDir, 'data/node-usage.json') });
    rpc = h.rpc; stats = h.stats;
    const al = nodeAllowance(node.url);
    log(`node: ${node.label} (from ${node.name}; URL not shown) · ${o.rps} req/s · max ${o.maxRequests} requests this run${al && al.daily !== Infinity ? ` · bot used ${al.used}/${al.daily} of today's allowance` : ''}`);
    if (al && al.daily !== Infinity && al.used + Math.min(o.maxRequests, 1000) > al.daily) {
      log('the node\'s daily allowance is nearly used up by the bot: stopping so the bot keeps its checks. Lower --max-requests or run after midnight UTC.');
      return 1;
    }
  }

  // ---- block range + run folder -------------------------------------------
  let from = o.from, to = o.to;
  if (o.last && rpc) {
    const r = await rpc('eth_blockNumber', []);
    if (r.error) { log(`could not read the latest block: ${r.error.message}`); return 1; }
    to = Number(BigInt(r.result)) - 5;           // a few blocks back: settled
    from = to - o.last + 1;
  }
  let out = o.out;
  if (!out) {
    if (from === null || to === null) { log('give --out DIR, or a block range (--last N / --from A --to B)'); return 2; }
    out = join(o.botDir, 'data/sim-compare', `${from}-${to}`);
  }
  out = resolve(out);
  mkdirSync(out, { recursive: true });
  const runFile = join(out, 'run.json');
  const saved = readJson<{ from: number; to: number }>(runFile);
  if ((from === null || to === null) && saved) { from = saved.from; to = saved.to; }
  if (o.last && saved && o.resume) { from = saved.from; to = saved.to; } // --resume keeps the first run's range
  if (from !== null && to !== null) writeJsonAtomic(runFile, { from, to, sizes: o.sizes, standingEvery: o.standingEvery, standingRoutes: o.standingRoutes, routesPerTrade: o.maxRoutesPerTrigger, tradeShare: o.tradeShare });
  log(`run folder: ${out}${from !== null ? ` · blocks ${from}-${to} (${(to! - from + 1).toLocaleString('en-US')})` : ''}`);
  const ctl = { concurrency: o.concurrency, stop, log };

  // ---- plan: what it will cost ----------------------------------------------
  if (o.cmd === 'plan') {
    if (from === null || to === null) { log('plan needs a block range'); return 2; }
    const blocks = to - from + 1;
    const book = loadPoolBook(o.poolsFile ?? join(o.botDir, 'data/watched-pools.json'));
    log(`watch list: ${book.pools.size} usable pools in ${book.byPair.size} pairs (left out: ${JSON.stringify(book.skipped)})`);
    // Count the real trades in the range (a few eth_getLogs requests), then
    // multiply out exactly like collect would.
    const { addresses } = watchAddresses(book);
    const trig = triggersFromLogs(await getLogsSplit(rpc!, addresses, from, to), book).filter((t) => o.tradeShare >= 1 || parseInt(sha(t.txHash, 8), 16) / 0xffffffff < o.tradeShare);
    const refused: Record<string, number> = {};
    const fl = flashLendersFromEnv();
    let trigChecks = 0;
    for (const t of trig) trigChecks += Math.min(o.maxRoutesPerTrigger, dedupeRoutes(routesThrough(book, book.pools.get(t.pool)!, o.sizes, refused, fl)).length);
    const standing = o.standingEvery > 0 ? Math.ceil(blocks / o.standingEvery) * Math.min(o.standingRoutes, allRoutes(book, o.sizes, {}, fl).length) : 0;
    const checks = Math.min(o.maxCases, trigChecks + standing);
    const tBlocks = new Set(trig.map((t) => t.block)).size;
    const req = Math.ceil(blocks / o.logChunk) + tBlocks + checks + 10;
    log(`range has ${trig.length} trades on watched pools in ${tBlocks} blocks -> ~${trigChecks} follow-a-trade + ${standing} standing checks${checks < trigChecks + standing ? ` (capped at --max-cases ${o.maxCases})` : ''}`);
    log(`node requests: collect ~${Math.ceil(blocks / o.logChunk) + tBlocks + 10} + node step ${checks} = ~${req} (fixture mode adds ~2 per check + 1 per trade block)`);
    log(`time at ${o.rps} req/s: ~${Math.ceil(req / o.rps / 60)} min (fixture mode ~${Math.ceil((req + 2 * checks + tBlocks) / o.rps / 60)} min more)`);
    // How far back can this node still answer? A few cheap calls (WETH's
    // total supply) at growing depths, with both methods the checks use.
    if (rpc) {
      const head = Number(BigInt((await rpc('eth_blockNumber', [])).result ?? '0x0'));
      for (const back of [head - from + 1, 1_000, 10_000, 100_000, 1_000_000]) {
        const n = head - back;
        if (n < 1) continue;
        const tag = '0x' + n.toString(16);
        const weth = { to: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', data: '0x18160ddd' };
        const c = await rpc('eth_call', [weth, tag]);
        const s = await rpc('eth_simulateV1', [{ blockStateCalls: [{ calls: [weth] }], validation: false }, tag]);
        const t = await rpc('debug_traceCall', [weth, tag, { tracer: 'prestateTracer' }]);
        const w = (r: { error?: { message?: string } }) => (r.error ? `NO (${String(r.error.message).slice(0, 50)})` : 'ok');
        log(`history ${back.toLocaleString('en-US')} blocks back (${n}): eth_call ${w(c)} · eth_simulateV1 ${w(s)} · debug_traceCall ${w(t)}`);
      }
      log('(each "NO (missing trie node ...)" = the node has dropped that old state: pick a more recent range)');
    }
    return 0;
  }

  // ---- steps ---------------------------------------------------------------
  if (o.cmd === 'collect' || o.cmd === 'all') {
    if (from === null || to === null) { log('collect needs a block range'); return 2; }
    loadBalanceSlots(join(out, 'balance-slots.json')); // the token balance location lookups, saved per run (never the bot's file)
    const book = loadPoolBook(o.poolsFile ?? join(o.botDir, 'data/watched-pools.json'));
    log(`watch list: ${book.pools.size} usable pools in ${book.byPair.size} pairs${book.savedAt ? `, saved ${((Date.now() - book.savedAt) / 3.6e6).toFixed(1)} h ago` : ''} (left out: ${JSON.stringify(book.skipped)})`);
    const st = await collectCases(rpc!, book, { out, from, to, sizes: o.sizes, maxCases: o.maxCases, maxRoutesPerTrigger: o.maxRoutesPerTrigger, standingEvery: o.standingEvery, standingRoutes: o.standingRoutes, tradeShare: o.tradeShare, logChunk: o.logChunk, resume: o.resume || o.cmd === 'all', stop, log });
    writeJsonAtomic(join(out, 'collect-stats.json'), st);
    log(`collect: ${st.triggers} trades on watched pools in ${st.triggerBlocks} blocks · ${st.triggerCases} follow-a-trade + ${st.standingCases} standing checks · bot's decoder would have read ${st.decodedByBot} of the followed trades (${st.notDecodedByBot} via events only)`);
  }
  if (o.cmd === 'node' || o.cmd === 'all') {
    if (stop()) return 130;
    const r = await runNodeStep(rpc!, out, ctl, stats ?? undefined);
    log(`node: asked ${r.asked} · answered ${r.answered} · node errors ${r.nodeErrors} · busy (ask again with --resume) ${r.busySkipped}`);
  }
  let engine: FastEngine | null = null;
  if (o.cmd === 'fast' || o.cmd === 'all' || o.cmd === 'report') {
    if (o.engine === 'echo') engine = new EchoEngine(await loadById<NodeRecord>(join(out, 'node.jsonl')));
    else if (o.engine === 'fixture') engine = new FixtureEngine(rpc ?? (async () => ({ error: { message: 'no node' } })), out, [o.arbsimBin, 'check-fixture', '{file}'], o.keepFixtures);
    else engine = new ArbsimSocketEngine(o.socket, out);
  }
  if ((o.cmd === 'fast' || o.cmd === 'all') && engine) {
    if (stop()) return 130;
    if (engine instanceof ArbsimSocketEngine) await engine.init();
    const r = await runFastStep(engine, out, ctl);
    await engine.close?.();
    log(`fast (${engine.name}): asked ${r.asked} · answered ${r.answered} · unknown ${r.unknown} · to retry ${r.retryLater}`);
    if (engine.stats) writeJsonAtomic(join(out, `engine-stats-${engine.name.split(' ')[0]}.json`), engine.stats());
  }
  if ((o.cmd === 'report' || o.cmd === 'all') && engine) {
    const rep = await buildReport(out, fastFileOf(out, engine), { engine: engine.name, fake: engine.fake });
    const suffix = engine.fake ? '-FAKE' : o.engine === 'fixture' ? '-fixture' : '';
    writeJsonAtomic(join(out, `report${suffix}.json`), rep);
    const txt = reportText(rep);
    writeFileSync(join(out, `report${suffix}.txt`), txt + '\n');
    console.log('\n' + txt);
  }
  if (stats) {
    writeJsonAtomic(join(out, `node-requests-${Date.now()}.json`), stats);
    log(`node requests this run: ${stats.total} (${Object.entries(stats.byMethod).map(([m, n]) => `${m} ${n}`).join(', ')})${stats.retries ? ` · ${stats.retries} retried after "slow down"` : ''}${stats.capHit ? ' · STOPPED AT --max-requests' : ''}`);
  }
  return stopping ? 130 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`sim-compare failed: ${(e as Error).message}`); process.exit(1); });
}
