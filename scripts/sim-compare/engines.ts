// ============================================================================
// SIM-COMPARE step 2b: the FAST engine's answer.
//
// Plain English:
//   The harness talks to the fast simulator through ONE narrow door:
//       FastEngine.check(case) -> answer (success, output, gas) or "unknown"
//   so the comparison code never cares HOW the fast side got its answer.
//
//   Engines:
//   1. ArbsimSocketEngine: the real arbsim sidecar over its local socket
//      (sim/DESIGN.md "Socket protocol"). Past blocks need a "pinned" mode,
//      which the sidecar doesn't have yet: see PINNED REQUEST below and the
//      README. Tests the whole thing: arbsim's own state loading + engine.
//   2. FixtureEngine: asks the node for the EXACT state the check touches
//      (prestateTracer) and runs `arbsim check-fixture` on that one file.
//      Works before the live copy exists, and isolates "is the engine
//      right?" from "is arbsim's copy of the chain right?".
//   3. EchoEngine / ScriptedEngine: fakes, for tests and a pipeline dry run.
//      Their results are clearly labelled FAKE in every report.
// ============================================================================
import { spawn } from 'child_process';
import { createConnection, Socket } from 'net';
import { mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Rpc, SIM_EXECUTOR_ADDRESS } from '../../src/execution/simulator';
import { Case, FastResult, NodeRecord, RawAnswer, BlockPrefix, CallObj } from './types';
import { unpackOverrides } from './collect';
import { prefixFor, isNodeTrouble } from './nodeCheck';
import { hex, lc, readJson, writeJsonAtomic } from './util';

export interface FastEngine {
  readonly name: string;          // shown in every report header
  readonly fake: boolean;         // true = test double, its "match rate" means nothing
  check(c: Case): Promise<FastResult>;
  close?(): Promise<void>;
  // Extra numbers for the report (e.g. node requests the engine itself made).
  stats?(): Record<string, unknown>;
}

// Same block settings the bot's replay uses (simulator.ts REPLAY_BLOCK_GAS).
export const REPLAY_BLOCK_GAS = '0x' + (2_000_000_000).toString(16);

// ---------------------------------------------------------------------------
// 1. arbsim socket client
// ---------------------------------------------------------------------------
// Framing (DESIGN.md): 4-byte big-endian length + UTF-8 JSON. Requests carry
// an id; answers echo it and may come back in any order.
export class ArbsimClient {
  private sock: Socket | null = null;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private readonly path: string, private readonly timeoutMs = 30_000) {}

  private connect(): Promise<Socket> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock);
    return new Promise((resolve, reject) => {
      const s = createConnection(this.path);
      s.once('connect', () => { this.sock = s; resolve(s); });
      s.once('error', (e) => { reject(new Error(`arbsim socket ${this.path}: ${e.message}`)); });
      s.on('data', (d: Buffer) => this.onData(d));
      s.on('close', () => {
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('arbsim socket closed')); }
        this.pending.clear();
        this.sock = null;
      });
    });
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > 64 * 1024 * 1024) { this.sock?.destroy(new Error('arbsim sent an oversized frame')); return; }
      if (this.buf.length < 4 + len) return;
      const body = this.buf.subarray(4, 4 + len).toString('utf8');
      this.buf = this.buf.subarray(4 + len);
      let msg: any;
      try { msg = JSON.parse(body); } catch { continue; }
      const p = this.pending.get(Number(msg?.id));
      if (!p) continue;
      this.pending.delete(Number(msg.id));
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  }

  async request(req: Record<string, unknown>): Promise<any> {
    const s = await this.connect();
    const id = this.nextId++;
    const body = Buffer.from(JSON.stringify({ ...req, id }), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length, 0);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`arbsim timed out after ${this.timeoutMs} ms`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      s.write(Buffer.concat([head, body]));
    });
  }

  async close(): Promise<void> { this.sock?.end(); this.sock = null; }
}

// PINNED REQUEST (proposed to workers A/C, see README "What arbsim needs"):
//   "at": { "pinned": "0x<block>", "env": "next" | "same" }
//     = run on the exact state at the END of that past block (the trigger's
//       parent, or the block before a standing check). arbsim fills every
//       account/slot it needs from the node AT THAT BLOCK (eth_getStorageAt
//       etc. with that block number, batched), waiting for the fill instead
//       of answering "miss". Filled state is kept per pinned block (small
//       LRU, a few blocks) so checks on the same block reuse it.
//   "blockOverrides": { "time", "gasLimit" }  same meaning as eth_simulateV1
//   "validation": false                        same meaning as eth_simulateV1
//   calls = [replayed block txs..., our call]; results come back per call.
//   env "next" (follow-a-trade): the calls run in a NEW block <pinned>+1,
//     exactly like eth_simulateV1 on <pinned> (block number, time from
//     blockOverrides, Arbitrum L1 block number of the real block <pinned>+1).
//   env "same" (standing gap): the call runs in block <pinned>'s own context,
//     exactly like eth_call at <pinned>.
export function pinnedCallRequest(c: Case, prefix: Array<{ from: string; to: string; data: string; value?: string; gas?: string }>): Record<string, unknown> {
  const calls = [...prefix, c.call].map((x) => ({ from: x.from, to: x.to, data: x.data, gas: x.gas ?? '0x7a1200', value: x.value ?? '0x0' }));
  return {
    type: 'call',
    at: { pinned: hex(c.parent), env: c.mode === 'trigger' ? 'next' : 'same' },
    overrides: unpackOverrides(c),
    ...(c.mode === 'trigger' ? { blockOverrides: { gasLimit: REPLAY_BLOCK_GAS, ...(c.time ? { time: c.time } : {}) }, validation: false } : {}),
    calls,
  };
}

// Reads one arbsim "call" answer into a FastResult (our call = the last one).
export function fastFromArbsim(ans: any, expectedCalls: number): FastResult {
  const us = typeof ans?.us === 'number' ? ans.us : undefined;
  if (!ans || ans.ok !== true) {
    const why = ans?.unknown ? `${ans.unknown}${Array.isArray(ans.missing) ? ` (${ans.missing.length} missing)` : ''}` : `error: ${String(ans?.error ?? 'bad answer').slice(0, 120)}`;
    return { status: 'unknown', why, ...(us !== undefined ? { us } : {}) };
  }
  const rs: any[] = Array.isArray(ans.results) ? ans.results : [];
  if (rs.length !== expectedCalls) return { status: 'unknown', why: `arbsim gave ${rs.length} answers for ${expectedCalls} calls` };
  const ours = rs[rs.length - 1];
  let gasUsed: string | null = null;
  try { if (ours?.gasUsed !== undefined && ours.gasUsed !== null) gasUsed = BigInt(ours.gasUsed).toString(); } catch { /* none */ }
  return {
    status: 'answer', success: ours?.success === true, output: String(ours?.output ?? '0x').toLowerCase(), gasUsed,
    prefixStatuses: rs.slice(0, -1).map((r) => (r?.success ? '1' : '0')).join(''), ...(us !== undefined ? { us } : {}),
  };
}

export class ArbsimSocketEngine implements FastEngine {
  readonly fake = false;
  readonly name: string;
  private client: ArbsimClient;
  private fillsAtStart: number | null = null;
  private lastStatus: any = null;
  constructor(socketPath: string, private readonly out: string, timeoutMs = 30_000) {
    this.client = new ArbsimClient(socketPath, timeoutMs);
    this.name = 'arbsim-socket (pinned past blocks)';
  }
  async init(): Promise<void> {
    // Status = arbsim's own counters (its node requests show up as "fills").
    try { this.lastStatus = await this.client.request({ type: 'status' }); this.fillsAtStart = Number(this.lastStatus?.fills ?? NaN); } catch { /* reported as unknowns */ }
  }
  async check(c: Case): Promise<FastResult> {
    const prefix = prefixFor(c, this.out);
    if (!prefix) return { status: 'unknown', why: 'harness: block data missing' };
    try {
      const ans = await this.client.request(pinnedCallRequest(c, prefix));
      return fastFromArbsim(ans, prefix.length + 1);
    } catch (e) {
      return { status: 'unknown', why: `socket: ${(e as Error).message.slice(0, 100)}` };
    }
  }
  async close(): Promise<void> {
    try { this.lastStatus = await this.client.request({ type: 'status' }); } catch { /* gone */ }
    await this.client.close();
  }
  stats(): Record<string, unknown> {
    const fills = Number(this.lastStatus?.fills ?? NaN);
    return { arbsimStatus: this.lastStatus, arbsimFillsDuringRun: Number.isFinite(fills) && Number.isFinite(this.fillsAtStart ?? NaN) ? fills - (this.fillsAtStart as number) : null };
  }
}

// ---------------------------------------------------------------------------
// 2. Fixture mode: exact touched state from the node, then `arbsim check-fixture`
// ---------------------------------------------------------------------------
// The state our call sees = the parent block's state + the changes made by
// the replayed trades before it. Those changes come from ONE
// debug_traceBlockByNumber (prestateTracer, diffMode) per trigger block.
// They are given to debug_traceCall as state overrides, together with our
// own pretend state, and the prestateTracer then lists every account and
// slot our call touched, with the values it saw. A second debug_traceCall
// (callTracer) gives that call's own answer = the fixture's "expected".
export type PrestateAcct = { balance?: string; nonce?: number; code?: string; storage?: Record<string, string> };
export type DiffTx = { pre: Record<string, PrestateAcct>; post: Record<string, PrestateAcct> };

// Changes of transactions [0..upto] in order, as geth-style state overrides.
// Rules (geth diffMode): `post` lists only changed fields; a slot in `pre`
// but not in `post` became zero; an account in `pre` but not in `post` was
// deleted (balance 0, nonce 0, no code, storage wiped).
// `only`: block positions to include (the bot's replay runs user txs only, so
// Arbitrum's system txs are left out here too). Not given = all up to `upto`.
export function prefixDiffOverrides(diffs: DiffTx[], upto: number, only?: Set<number>): Record<string, any> {
  const o: Record<string, any> = {};
  const acct = (a: string) => (o[a] ??= {});
  for (let i = 0; i <= upto && i < diffs.length; i++) {
    if (only && !only.has(i)) continue;
    const d = diffs[i];
    if (!d) continue;
    for (const [a0, pre] of Object.entries(d.pre ?? {})) {
      const a = lc(a0);
      const post = Object.entries(d.post ?? {}).find(([k]) => lc(k) === a)?.[1];
      if (!post) { o[a] = { balance: '0x0', nonce: '0x0', code: '0x', state: {} }; continue; }
      for (const slot of Object.keys(pre.storage ?? {})) {
        if (!(post.storage && slot in post.storage)) {
          const x = acct(a);
          if (x.state) x.state[slot] = '0x' + '0'.repeat(64); else (x.stateDiff ??= {})[slot] = '0x' + '0'.repeat(64);
        }
      }
    }
    for (const [a0, post] of Object.entries(d.post ?? {})) {
      const a = lc(a0);
      const x = acct(a);
      if (post.balance !== undefined) x.balance = post.balance;
      if (post.nonce !== undefined) x.nonce = hex(post.nonce);
      if (post.code !== undefined) x.code = post.code;
      for (const [slot, v] of Object.entries(post.storage ?? {})) { if (x.state) x.state[slot] = v; else (x.stateDiff ??= {})[slot] = v; }
    }
  }
  return o;
}

// Our own pretend state wins over the replayed changes (same as the node:
// eth_simulateV1 applies our overrides first, and no replayed trade touches
// our pretend contract or its pretend token balance).
export function mergeOverrides(prefix: Record<string, any>, ours: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = JSON.parse(JSON.stringify(prefix));
  for (const [a0, v] of Object.entries(ours)) {
    const a = lc(a0);
    const x = (out[a] ??= {});
    for (const k of ['balance', 'nonce', 'code'] as const) if (v[k] !== undefined) x[k] = v[k];
    if (v.state) { x.state = { ...v.state }; delete x.stateDiff; }
    if (v.stateDiff) { if (x.state) Object.assign(x.state, v.stateDiff); else x.stateDiff = { ...(x.stateDiff ?? {}), ...v.stateDiff }; }
  }
  return out;
}

const ARBSYS = '0x0000000000000000000000000000000000000064';

// Builds the fixture (FIXTURE_FORMAT.md) for one case. Returns null + why
// when the node can't provide it.
export async function buildFixture(rpc: Rpc, c: Case, out: string, cache: { diffs: Map<number, DiffTx[]> }): Promise<{ fixture: any; truth: RawAnswer } | { why: string; busy?: boolean }> {
  const ours = unpackOverrides(c);
  let overrides = ours;
  let header: any;
  if (c.mode === 'trigger') {
    const b = readJson<BlockPrefix & { header?: any; fullHashes?: string[] }>(join(out, 'blocks', `${c.block}.json`));
    if (!b || c.txIndex === null) return { why: 'block data missing' };
    header = b.header ?? null;
    let diffs = cache.diffs.get(c.block);
    if (!diffs) {
      const r = await rpc('debug_traceBlockByNumber', [hex(c.block), { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }]);
      const why = isNodeTrouble(r.error);
      if (r.error) return { why: `traceBlock: ${why ?? String(r.error.message).slice(0, 80)}`, busy: why === 'busy' };
      const list = Array.isArray(r.result) ? (r.result as any[]) : [];
      // One trace per transaction, in block order, or the changes would be
      // applied to the wrong position: refuse rather than guess.
      if (b.fullHashes && list.length !== b.fullHashes.length) return { why: `traceBlock: ${list.length} traces for ${b.fullHashes.length} txs` };
      if (b.fullHashes && list.some((x, i) => x?.txHash && lc(x.txHash) !== b.fullHashes![i])) return { why: 'traceBlock: trace order does not match the block' };
      diffs = list.map((x) => (x?.result ?? x) as DiffTx);
      // Cases arrive in block order, so the last 2 blocks are enough (2 in
      // case parallel checks straddle a block boundary): bounded memory.
      while (cache.diffs.size >= 2) cache.diffs.delete(cache.diffs.keys().next().value as number);
      cache.diffs.set(c.block, diffs);
    }
    const userTxs = new Set(b.calls.map((x) => x.i));
    overrides = mergeOverrides(prefixDiffOverrides(diffs, c.txIndex, userTxs), ours);
  }
  if (!header) {
    const n = c.mode === 'trigger' ? c.block : c.parent;
    const hf = join(out, 'headers', `${n}.json`);
    header = readJson<any>(hf);
    if (!header) {
      const r = await rpc('eth_getBlockByNumber', [hex(n), false]);
      if (r.error || !r.result) return { why: `header: ${String(r.error?.message ?? 'missing').slice(0, 80)}`, busy: isNodeTrouble(r.error) === 'busy' };
      const h = r.result;
      header = { number: h.number, l1BlockNumber: h.l1BlockNumber, timestamp: h.timestamp, baseFeePerGas: h.baseFeePerGas, miner: h.miner, gasLimit: h.gasLimit, mixHash: h.mixHash, difficulty: h.difficulty };
      writeJsonAtomic(hf, header);
    }
  }
  // Trigger: the node's replay simulates block <parent>+1 at the real time
  // with a huge gas limit; the trace asks for the same block settings.
  const blockOverrides = c.mode === 'trigger' ? { number: hex(c.block), time: c.time ?? header.timestamp, gasLimit: REPLAY_BLOCK_GAS } : undefined;
  const trace = async (tracer: string) => rpc('debug_traceCall', [c.call, hex(c.parent), { tracer, stateOverrides: overrides, ...(blockOverrides ? { blockOverrides } : {}) }]);
  const pre = await trace('prestateTracer');
  if (pre.error) { const w = isNodeTrouble(pre.error); return { why: `traceCall prestate: ${w ?? String(pre.error.message).slice(0, 80)}`, busy: w === 'busy' }; }
  const ct = await trace('callTracer');
  if (ct.error) { const w = isNodeTrouble(ct.error); return { why: `traceCall callTracer: ${w ?? String(ct.error.message).slice(0, 80)}`, busy: w === 'busy' }; }
  const prestate: Record<string, PrestateAcct> = {};
  for (const [a, v] of Object.entries(pre.result as Record<string, PrestateAcct>)) {
    if (lc(a) === ARBSYS) continue;
    prestate[a] = { balance: v.balance ?? '0x0', nonce: v.nonce ?? 0, code: v.code ?? '0x', storage: v.storage ?? {} };
  }
  const r = ct.result ?? {};
  const truth: RawAnswer = { success: !r.error, output: String(r.output ?? '0x').toLowerCase(), gasUsed: r.gasUsed !== undefined ? BigInt(r.gasUsed).toString() : null };
  const time = c.mode === 'trigger' ? (c.time ?? header.timestamp) : header.timestamp;
  const fixture = {
    name: `simcmp-${c.id}`,
    source: `sim-compare case ${c.id}: ${c.mode} block ${c.block}${c.txIndex !== null ? ` after tx ${c.txIndex}` : ''}, ${c.route.pair} ${c.route.kinds} ${c.route.sizeLabel}`,
    chainId: 4663,
    block: {
      number: header.l1BlockNumber ?? header.number, timestamp: time, baseFee: header.baseFeePerGas ?? '0x0', coinbase: header.miner ?? '0x' + '0'.repeat(40),
      gasLimit: c.mode === 'trigger' ? REPLAY_BLOCK_GAS : header.gasLimit, prevrandao: header.mixHash ?? '0x' + '0'.repeat(64), difficulty: header.difficulty ?? '0x1',
    },
    l2BlockNumber: hex(c.mode === 'trigger' ? c.block : c.parent),
    tx: { from: c.call.from, to: c.call.to, data: c.call.data, gas: c.call.gas ?? '0x7a1200', value: c.call.value ?? '0x0', gasPrice: '0x0' },
    prestate,
    expected: { success: truth.success, output: truth.output, gasUsed: r.gasUsed ?? null, note: 'debug_traceCall callTracer with the same state as the check (sim-compare)' },
  };
  return { fixture, truth };
}

// Reads `arbsim check-fixture` output. Accepted shapes (first that fits):
//   { "success": bool, "output": "0x..", "gasUsed": "0x.."|n }   (also under "result")
//   the revm bench report: correctness.success.revm / correctness.output.revm / correctness.gas.revm_tx_level_gas
export function parseFixtureOutput(stdout: string): { success: boolean; output: string; gasUsed: string | null } | null {
  let j: any = null;
  try { j = JSON.parse(stdout); } catch {
    const last = stdout.trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
    try { j = last ? JSON.parse(last) : null; } catch { j = null; }
  }
  if (!j) return null;
  const g = (v: unknown) => { try { return v === undefined || v === null ? null : BigInt(v as string).toString(); } catch { return null; } };
  const base = typeof j.success === 'boolean' ? j : typeof j.result?.success === 'boolean' ? j.result : null;
  if (base) return { success: base.success, output: String(base.output ?? '0x').toLowerCase(), gasUsed: g(base.gasUsed ?? base.txGas) };
  const c = j.correctness;
  if (c && typeof c.success?.revm === 'boolean') return { success: c.success.revm, output: String(c.output?.revm ?? '0x').toLowerCase(), gasUsed: g(c.gas?.revm_tx_level_gas) };
  return null;
}

// Runs a command with a time limit; resolves with stdout (never throws).
export function runCmd(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { if (stdout.length < 4_000_000) stdout += d; });
    p.stderr.on('data', (d) => { if (stderr.length < 20_000) stderr += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => { clearTimeout(t); resolve({ code: null, stdout, stderr: stderr + e.message }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
  });
}

export class FixtureEngine implements FastEngine {
  readonly fake = false;
  readonly name: string;
  private cache = { diffs: new Map<number, DiffTx[]>() };
  private dir: string;
  constructor(private readonly rpc: Rpc, private readonly out: string, private readonly cmd: string[], private readonly keepAll = false, private readonly timeoutMs = 20_000) {
    this.name = `fixture mode (node prestate -> ${cmd.join(' ')})`;
    this.dir = join(out, 'fixtures');
    mkdirSync(this.dir, { recursive: true });
  }
  async check(c: Case): Promise<FastResult> {
    const built = await buildFixture(this.rpc, c, this.out, this.cache);
    if ('why' in built) return { status: 'unknown', why: `${built.busy ? 'node busy: ' : ''}${built.why}` };
    const file = join(this.dir, `${c.id}.json`);
    writeFileSync(file, JSON.stringify(built.fixture));
    const args = this.cmd.slice(1).map((a) => a.replace('{file}', file));
    if (!this.cmd.some((a) => a.includes('{file}'))) args.push(file);
    const t0 = process.hrtime.bigint();
    const r = await runCmd(this.cmd[0]!, args, this.timeoutMs);
    const us = Number((process.hrtime.bigint() - t0) / 1000n);
    const got = parseFixtureOutput(r.stdout);
    if (!got) return { status: 'unknown', why: `check-fixture gave no readable answer (exit ${r.code}): ${r.stderr.trim().slice(0, 100)}`, us };
    const sameAsTruth = got.success === built.truth.success && got.output === built.truth.output;
    // Fixture files are 100-300 KB: keep only the interesting ones.
    if (sameAsTruth && !this.keepAll) { try { unlinkSync(file); } catch { /* fine */ } }
    return { status: 'answer', ...got, us, note: JSON.stringify({ truth: built.truth, fixture: sameAsTruth && !this.keepAll ? null : file }) };
  }
}

// ---------------------------------------------------------------------------
// 3. Fakes
// ---------------------------------------------------------------------------
// Copies the node's own answer: a pipeline dry run must show 100%.
export class EchoEngine implements FastEngine {
  readonly fake = true;
  readonly name = 'FAKE echo (copies the node answer; pipeline test only)';
  constructor(private readonly nodeAnswers: Map<string, NodeRecord>) {}
  async check(c: Case): Promise<FastResult> {
    const n = this.nodeAnswers.get(c.id);
    if (!n || n.status !== 'answer' || !n.raw) return { status: 'unknown', why: 'echo: no node answer to copy' };
    return { status: 'answer', success: n.raw.success, output: n.raw.output, gasUsed: n.raw.gasUsed, ...(n.prefixStatuses !== undefined ? { prefixStatuses: n.prefixStatuses } : {}), us: 1 };
  }
}

// Answers from a function (tests).
export class ScriptedEngine implements FastEngine {
  readonly fake = true;
  constructor(readonly name: string, private readonly fn: (c: Case) => FastResult | Promise<FastResult>) {}
  async check(c: Case): Promise<FastResult> { return this.fn(c); }
}

export { SIM_EXECUTOR_ADDRESS };
export type { CallObj };
