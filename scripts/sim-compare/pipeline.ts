// ============================================================================
// SIM-COMPARE: running the steps (node answers, fast answers, report).
//
// Plain English:
//   - Checks are streamed from cases.jsonl (never all in memory) and worked
//     on a few at a time (--concurrency), at the speed limit (--rps).
//   - Every answer is appended to its file the moment it arrives. Ctrl-C
//     stops cleanly after the checks in flight; --resume (or just running
//     again) skips everything already answered.
//   - A progress line every 30 s: done / total, errors, requests per second,
//     time left.
// ============================================================================
import { existsSync } from 'fs';
import { join } from 'path';
import { Rpc, SIM_EXECUTOR_ADDRESS } from '../../src/execution/simulator';
import { Case, FastRecord, NodeRecord } from './types';
import { nodeAnswer, saveNodeRecord, prefixFor } from './nodeCheck';
import { FastEngine, REPLAY_BLOCK_GAS } from './engines';
import { compareOne, Compared, Tally, Worst, MATCH_RATE_DEFINITION, bucketLine, TABLE_HEAD, readAnswer, Bucket } from './compare';
import { unpackOverrides } from './collect';
import { appendJsonl, hex, loadById, median, pct, readJsonl, writeJsonAtomic, RpcStats } from './util';

export interface RunCtl {
  concurrency: number;
  stop: () => boolean;
  log: (m: string) => void;
  progressMs?: number;       // default 30 s
  now?: () => number;
}

// Runs `work` over every item from `items` with up to `n` in flight.
async function pool<T>(items: AsyncIterable<T>, n: number, stop: () => boolean, work: (x: T) => Promise<void>): Promise<void> {
  const running = new Set<Promise<void>>();
  for await (const x of items) {
    if (stop()) break;
    const p = work(x).catch(() => undefined).finally(() => running.delete(p));
    running.add(p);
    if (running.size >= n) await Promise.race(running);
  }
  await Promise.all(running);
}

async function countLines(file: string): Promise<number> { let n = 0; for await (const _ of readJsonl(file)) n++; return n; }

function progress(ctl: RunCtl, label: string, total: number, get: () => { done: number; extra: string }, stats?: RpcStats) {
  const now = ctl.now ?? Date.now;
  const t0 = now();
  const timer = setInterval(() => {
    const { done, extra } = get();
    const secs = (now() - t0) / 1000;
    const rate = secs > 0 ? done / secs : 0;
    const left = rate > 0 ? Math.max(0, total - done) / rate : NaN;
    const req = stats ? ` · node ${stats.total} req (${(stats.total / Math.max(1, secs)).toFixed(1)}/s)` : '';
    ctl.log(`[${label}] ${done}/${total} done${extra}${req} · ${isFinite(left) ? `~${Math.ceil(left / 60)} min left` : 'estimating'}`);
  }, ctl.progressMs ?? 30_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ---- Step 2a: node answers ----------------------------------------------------
export async function runNodeStep(rpc: Rpc, out: string, ctl: RunCtl, stats?: RpcStats): Promise<{ asked: number; answered: number; nodeErrors: number; busySkipped: number }> {
  const casesFile = join(out, 'cases.jsonl');
  const done = await loadById<NodeRecord>(join(out, 'node.jsonl'));
  const total = await countLines(casesFile);
  const r = { asked: 0, answered: 0, nodeErrors: 0, busySkipped: 0 };
  let finished = done.size;
  const stopProgress = progress(ctl, 'node', total, () => ({ done: finished, extra: ` · ${r.nodeErrors} node errors · ${r.busySkipped} busy (retry later)` }), stats);
  try {
    await pool(readJsonl<Case>(casesFile), ctl.concurrency, () => ctl.stop() || !!stats?.capHit, async (c) => {
      if (done.has(c.id)) return;
      r.asked++;
      const rec = await nodeAnswer(rpc, c, out);
      if (!rec) { r.busySkipped++; return; }      // not saved: asked again next run
      saveNodeRecord(out, rec);
      done.set(c.id, rec);
      finished++;
      if (rec.status === 'answer') r.answered++; else r.nodeErrors++;
    });
  } finally { stopProgress(); }
  return r;
}

// Unknowns that are about the harness or a busy node, not about the engine:
// not saved, so the next run asks again.
export const RETRY_LATER = /^(node busy|socket:|harness:)/;

// ---- Step 2b: fast answers ----------------------------------------------------
export function fastFileOf(out: string, engine: FastEngine): string {
  const slug = engine.name.split(' ')[0]!.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  return join(out, `fast-${engine.fake ? 'FAKE-' : ''}${slug}.jsonl`);
}

export async function runFastStep(engine: FastEngine, out: string, ctl: RunCtl, onlyNodeAnswered = true): Promise<{ file: string; asked: number; answered: number; unknown: number; retryLater: number }> {
  const casesFile = join(out, 'cases.jsonl');
  const file = fastFileOf(out, engine);
  const done = await loadById<FastRecord>(file);
  const node = onlyNodeAnswered ? await loadById<NodeRecord>(join(out, 'node.jsonl')) : null;
  const total = await countLines(casesFile);
  const r = { file, asked: 0, answered: 0, unknown: 0, retryLater: 0 };
  let finished = done.size;
  const stopProgress = progress(ctl, 'fast', total, () => ({ done: finished, extra: ` · ${r.unknown} unknown` }));
  try {
    await pool(readJsonl<Case>(casesFile), ctl.concurrency, ctl.stop, async (c) => {
      if (done.has(c.id)) return;
      // No point asking the fast side when the node couldn't answer either.
      if (node && node.get(c.id)?.status !== 'answer') return;
      r.asked++;
      const t0 = Date.now();
      const result = await engine.check(c);
      if (result.status === 'unknown' && RETRY_LATER.test(result.why)) { r.retryLater++; return; }
      const rec: FastRecord = { id: c.id, engine: engine.name, result, ms: Date.now() - t0 };
      appendJsonl(file, rec);
      done.set(c.id, rec);
      finished++;
      if (result.status === 'answer') r.answered++; else r.unknown++;
    });
  } finally { stopProgress(); }
  return r;
}

// ---- Step 3: report -------------------------------------------------------------
export interface Report {
  header: { title: string; matchRateDefinition: string; engine: string; engineIsFake: boolean; out: string; generatedAt: string; blocks: { from: number | null; to: number | null } };
  totals: Bucket;
  byMode: Record<string, Bucket>;
  byRouteType: Record<string, Bucket>;
  byFunding: Record<string, Bucket>;
  byTriggerSource: Record<string, Bucket>;
  fixtureMode?: { engineVsExactState: Bucket; exactStateVsNodeReplay: Bucket };
  timing: { fastUsMedian: number | null; fastUsP95: number | null; nodeMsMedian: number | null; nodeMsP95: number | null };
  unknownReasons: Record<string, number>;
  nodeErrorReasons: Record<string, number>;
  worst: Array<Record<string, unknown>>;
  notes: string[];
}

// Everything needed to reproduce one check on any node: the exact request
// body the bot's path sends (eth_simulateV1 or eth_call) and the case itself.
export function reproRequest(c: Case, out: string): { method: string; params: unknown[] } | null {
  const overrides = unpackOverrides(c);
  if (c.mode === 'trigger') {
    const prefix = prefixFor(c, out);
    if (!prefix) return null;
    return {
      method: 'eth_simulateV1',
      params: [{ blockStateCalls: [{ blockOverrides: { gasLimit: REPLAY_BLOCK_GAS, ...(c.time ? { time: c.time } : {}) }, stateOverrides: overrides, calls: [...prefix, c.call] }], validation: false }, hex(c.parent)],
    };
  }
  return { method: 'eth_call', params: [c.call, hex(c.parent), overrides] };
}

const inc = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
const reasonKey = (s: string) => s.replace(/0x[0-9a-f]{6,}/gi, '0x…').replace(/\d{3,}/g, 'N').slice(0, 80);

export async function buildReport(out: string, fastFile: string | null, info: { engine: string; fake: boolean }): Promise<Report> {
  const node = await loadById<NodeRecord>(join(out, 'node.jsonl'));
  const fast = fastFile && existsSync(fastFile) ? await loadById<FastRecord>(fastFile) : new Map<string, FastRecord>();
  const total = new Tally();
  const byMode = new Map<string, Tally>(), byKind = new Map<string, Tally>(), byFunding = new Map<string, Tally>(), bySource = new Map<string, Tally>();
  const tOf = (m: Map<string, Tally>, k: string) => m.get(k) ?? m.set(k, new Tally()).get(k)!;
  const fxEngine = new Tally(), fxState = new Tally();
  let fixtureSeen = false;
  const worst = new Worst<Compared & { c: Case }>(20);
  const unknownReasons: Record<string, number> = {}, nodeErrorReasons: Record<string, number> = {};
  const fastUs: number[] = [], nodeMs: number[] = [];
  let minB: number | null = null, maxB: number | null = null;
  for await (const c of readJsonl<Case>(join(out, 'cases.jsonl'))) {
    minB = minB === null ? c.block : Math.min(minB, c.block);
    maxB = maxB === null ? c.block : Math.max(maxB, c.block);
    const n = node.get(c.id), f = fast.get(c.id);
    const x = compareOne(c, n, f);
    for (const t of [total, tOf(byMode, c.mode === 'trigger' ? 'follow-a-trade' : 'standing gap'), tOf(byKind, c.route.kinds), tOf(byFunding, c.funding === 'flash' ? 'flash loan' : 'own money')]) t.add(x);
    // Follow-a-trade only: would the bot's feed decoder have seen this trade?
    // (Event-only trades are a superset of what the bot follows live.)
    if (c.mode === 'trigger') tOf(bySource, c.decodedByBot === true ? 'bot decoder reads it' : c.decodedByBot === false ? 'seen in events only' : 'not recorded').add(x);
    if (x.group === 'fast_unknown') inc(unknownReasons, reasonKey(x.unknownWhy ?? ''));
    if (x.group === 'node_error') inc(nodeErrorReasons, reasonKey(x.nodeError ?? ''));
    if (x.fastUs !== undefined) fastUs.push(x.fastUs);
    if (x.nodeMs !== undefined) nodeMs.push(x.nodeMs);
    if (x.severity > 0) worst.add({ ...x, c });
    // Fixture mode: the engine's answer vs the exact-state trace (engine
    // accuracy alone), and that trace vs the node's replay (does the
    // fixture's state equal what the bot's check saw?).
    if (f?.result.status === 'answer' && f.result.note) {
      try {
        const note = JSON.parse(f.result.note);
        if (note?.truth && n?.status === 'answer') {
          fixtureSeen = true;
          const truthRec: NodeRecord = { id: c.id, status: 'answer', raw: note.truth, via: 'eth_call', ms: 0 };
          fxEngine.add(compareOne(c, truthRec, f));
          fxState.add(compareOne(c, n, { id: c.id, engine: 'trace', result: { status: 'answer', ...note.truth }, ms: 0 }));
        }
      } catch { /* not a fixture note */ }
    }
  }
  const obj = (m: Map<string, Tally>) => Object.fromEntries([...m.entries()].sort((a, b) => b[1].result().checks - a[1].result().checks).map(([k, t]) => [k, t.result()]));
  const fmtRead = (r?: { verdict: string; profit: bigint | null; error: string }) => (r ? `${r.verdict}${r.profit !== null ? ` ${r.profit}` : ''} (${r.error})` : '-');
  const worstOut = worst.list().map((w) => {
    const n = node.get(w.id), f = fast.get(w.id);
    const repro = reproRequest(w.c, out);
    const reproFile = join(out, 'repro', `${w.id}.json`);
    if (repro) writeJsonAtomic(reproFile, { case: w.c, request: { jsonrpc: '2.0', id: 1, ...repro }, note: 'The 20 KB "@executor" placeholder in case.overrides is already expanded inside request.params.' });
    return {
      id: w.id, group: w.group, mode: w.mode, block: w.c.block, txIndex: w.c.txIndex, triggerHash: w.c.triggerHash,
      route: `${w.c.route.pair} ${w.c.route.buyDex}@${w.c.route.buyPool.slice(0, 12)} -> ${w.c.route.sellDex}@${w.c.route.sellPool.slice(0, 12)} (${w.c.route.kinds}) ${w.c.route.sizeLabel}`,
      node: fmtRead(w.node), fast: fmtRead(w.fast),
      profitDiff: w.profitDiff?.toString() ?? null, profitDiffPct: w.profitDiffPct ?? null, gasDiff: w.gasDiff ?? null, prefixMismatch: w.prefixMismatch ?? null,
      nodeRaw: n?.raw ?? null, fastRaw: f?.result ?? null,
      reproFile: repro ? reproFile : null,
    };
  });
  const totals = total.result();
  const notes = [
    'Sizes are a fixed list per start coin (not the bot\'s per-trade size search); every route is checked with own money, and one size also with a flash loan.',
    'Standing-gap checks use a plain eth_call (like the bot), which reports no gas, so gas is compared on follow-a-trade checks only.',
    'Follow-a-trade checks replay the trade\'s block on the block before (eth_simulateV1), exactly like the bot\'s replayRpc; checks whose replay the node refused are node errors, not matches or mismatches.',
  ];
  if (info.fake) notes.unshift('FAKE ENGINE: this run tests the harness only. Its match rate says NOTHING about arbsim.');
  if (totals.prefixMismatches) notes.push(`${totals.prefixMismatches} checks: the replayed trades before ours succeeded/failed differently on the two sides (state before our trade differed).`);
  return {
    header: {
      title: `ARBSIM vs NODE comparison (go/no-go #2)${info.fake ? ' -- FAKE ENGINE, HARNESS TEST ONLY' : ''}`,
      matchRateDefinition: MATCH_RATE_DEFINITION, engine: info.engine, engineIsFake: info.fake, out, generatedAt: new Date().toISOString(), blocks: { from: minB, to: maxB },
    },
    totals, byMode: obj(byMode), byRouteType: obj(byKind), byFunding: obj(byFunding), byTriggerSource: obj(bySource),
    ...(fixtureSeen ? { fixtureMode: { engineVsExactState: fxEngine.result(), exactStateVsNodeReplay: fxState.result() } } : {}),
    timing: { fastUsMedian: median(fastUs), fastUsP95: pct(fastUs, 0.95), nodeMsMedian: median(nodeMs), nodeMsP95: pct(nodeMs, 0.95) },
    unknownReasons, nodeErrorReasons, worst: worstOut, notes,
  };
}

// The plain-English version (report.txt).
export function reportText(r: Report): string {
  const t = r.totals;
  const L: string[] = [];
  const pc = (x: number | null) => (x === null ? '-' : `${x.toFixed(1)}%`);
  L.push(r.header.title);
  L.push('='.repeat(r.header.title.length));
  L.push(`Engine: ${r.header.engine}`);
  L.push(`Blocks: ${r.header.blocks.from ?? '-'} to ${r.header.blocks.to ?? '-'} · made ${r.header.generatedAt}`);
  L.push('');
  L.push('HOW THE MATCH RATE IS COUNTED');
  L.push(r.header.matchRateDefinition);
  L.push('');
  L.push(`MATCH RATE: ${pc(t.matchRatePct)}  (${t.exact} exact of ${t.checks} checks the node answered)`);
  L.push(`Same verdict (profit/loss/fail): ${pc(t.verdictMatchPct)} · wrong verdict: ${t.diffVerdict} · right verdict, different detail: ${t.sameVerdictDiff}`);
  L.push(`Fast side answered: ${pc(t.coveragePct)} of checks (unknown ${t.fastUnknown}, not answered ${t.notAnswered}) · exact when it answered: ${pc(t.matchAmongAnsweredPct)}`);
  L.push(`Both said profit: ${t.profit.bothProfit} · same amount to the last unit: ${t.profit.exactAmount} · median diff ${t.profit.medianDiffPct ?? '-'}% · worst ${t.profit.maxDiffPct ?? '-'}%`);
  L.push(`Gas compared: ${t.gas.compared} · exact ${t.gas.exact} · median off ${t.gas.medianAbsDiff ?? '-'} · 95% within ${t.gas.p95AbsDiff ?? '-'} · worst ${t.gas.maxAbsDiff ?? '-'}`);
  L.push(`Node could not answer (left out): ${t.nodeErrors}`);
  L.push(`Time per check: fast median ${r.timing.fastUsMedian ?? '-'} us (95%: ${r.timing.fastUsP95 ?? '-'} us) · node median ${r.timing.nodeMsMedian ?? '-'} ms (95%: ${r.timing.nodeMsP95 ?? '-'} ms)`);
  if (r.fixtureMode) {
    L.push('');
    L.push('FIXTURE MODE, split in two:');
    L.push(`  engine vs exact touched state (engine accuracy alone): ${pc(r.fixtureMode.engineVsExactState.matchRatePct)} of ${r.fixtureMode.engineVsExactState.checks}`);
    L.push(`  exact-state trace vs node replay (is the fixture state right?): ${pc(r.fixtureMode.exactStateVsNodeReplay.matchRatePct)} of ${r.fixtureMode.exactStateVsNodeReplay.checks}`);
  }
  const table = (title: string, m: Record<string, Bucket>) => {
    L.push('');
    L.push(title);
    L.push(TABLE_HEAD);
    for (const [k, b] of Object.entries(m)) L.push(bucketLine(k, b));
  };
  L.push('');
  L.push(TABLE_HEAD);
  L.push(bucketLine('ALL', t));
  table('BY KIND OF CHECK', r.byMode);
  table('BY ROUTE TYPE (buy pool > sell pool)', r.byRouteType);
  table('BY FUNDING', r.byFunding);
  if (Object.keys(r.byTriggerSource).length) table('FOLLOW-A-TRADE: WHO COULD SEE THE TRADE', r.byTriggerSource);
  L.push('(match = exact; verdict = same profit/loss/fail; wrong = different verdict; detail = same verdict, different numbers/error)');
  const reasons = (title: string, m: Record<string, number>) => {
    const e = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (!e.length) return;
    L.push('');
    L.push(title);
    for (const [k, v] of e) L.push(`  ${String(v).padStart(6)}  ${k}`);
  };
  reasons('WHY THE FAST SIDE SAID "UNKNOWN"', r.unknownReasons);
  reasons('WHY THE NODE COULD NOT ANSWER', r.nodeErrorReasons);
  L.push('');
  L.push(`WORST MISMATCHES (${r.worst.length}; full details + a ready-to-send request in report.json and repro/)`);
  r.worst.forEach((w, i) => {
    L.push(`${String(i + 1).padStart(2)}. [${w.group}] ${w.mode} block ${w.block}${w.txIndex !== null ? ` tx ${w.txIndex}` : ''} · ${w.route}`);
    L.push(`    node: ${w.node}`);
    L.push(`    fast: ${w.fast}${w.gasDiff !== null ? ` · gas diff ${w.gasDiff}` : ''}${w.prefixMismatch ? ' · REPLAYED TRADES DIFFER' : ''}`);
    if (w.reproFile) L.push(`    repro: ${w.reproFile}`);
  });
  L.push('');
  L.push('NOTES');
  for (const n of r.notes) L.push(`- ${n}`);
  return L.join('\n');
}

export { readAnswer, SIM_EXECUTOR_ADDRESS };
