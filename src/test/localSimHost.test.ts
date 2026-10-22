import { createServer, Server, Socket } from 'net';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { frame, LocalSimClient } from '../execution/localSim';
import { createLocalSimHost, LocalSimHost, JsonlLog, verdictOf, hostSettings } from '../execution/localSimHost';
import { simulateRoundTrip, SIM_EXECUTOR_ADDRESS, Rpc, SimResult } from '../execution/simulator';

// FAST CHECK host (execution/localSimHost.ts): switch, practice mode never
// changing a decision, unknown -> node, ON needs the confirm word, automatic
// step back, feed frames passed on byte for byte, log rotation.
// A fake sidecar runs in this process (no Rust needed).

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(5); }
  return cond();
}

// Fake sidecar: decodes frames, keeps the raw bytes of feed frames, lets the test answer.
type Handler = (msg: any, reply: (ans: any) => void) => void;
class FakeSidecar {
  server: Server;
  seen: any[] = [];
  rawFeedBodies: Buffer[] = [];
  connections = 0;
  sockets: Socket[] = [];
  handler: Handler = (m, reply) => reply({ id: m.id, ok: false, unknown: 'not_ready' });
  constructor(readonly path: string) {
    this.server = createServer((s) => {
      this.connections++;
      this.sockets.push(s);
      let buf = Buffer.alloc(0);
      s.on('data', (c: Buffer) => {
        buf = Buffer.concat([buf, c]);
        while (buf.length >= 4) {
          const len = buf.readUInt32BE(0);
          if (buf.length < 4 + len) break;
          const body = buf.subarray(4, 4 + len);
          const msg = JSON.parse(body.toString('utf8'));
          buf = buf.subarray(4 + len);
          this.seen.push(msg);
          if (msg.type === 'feed') { this.rawFeedBodies.push(Buffer.from(body)); continue; }
          this.handler(msg, (ans) => { if (!s.destroyed) s.write(frame(ans)); });
        }
      });
      s.on('error', () => {});
    });
  }
  listen(): Promise<void> { return new Promise((r) => this.server.listen(this.path, () => r())); }
  stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets = [];
    return new Promise((r) => this.server.close(() => r()));
  }
}

const word = (n: bigint) => n.toString(16).padStart(64, '0');
const insufficient = (got: bigint) => '0x4e88422a' + word(got) + 'f'.repeat(64);
// Answers our contract call with InsufficientProfit(got) (profit verdict), balance probes with the marker.
function answerProfit(got: bigint, gas = '0x5323b'): Handler {
  return (m, reply) => {
    if (m.type === 'warm') return reply({ id: m.id, ok: true, queued: (m.accounts ?? []).length });
    if (m.type === 'status') return reply({ id: m.id, ok: true, replay_mismatch: 0 });
    if (m.type !== 'call') return reply({ id: m.id, ok: false, unknown: 'bad_request' });
    const call = m.calls[m.calls.length - 1];
    if (call.to?.toLowerCase() === SIM_EXECUTOR_ADDRESS) {
      return reply({ id: m.id, ok: true, us: 2400, t: { queue: 100, prep: 50, resolve: 0, facts: 300, runs: [1200, 600], post: 50 }, results: m.calls.map(() => ({ success: false, output: got > 0n ? insufficient(got) : insufficient(0n), gasUsed: gas })) });
    }
    // balanceOf probe: echo the single stateDiff value (slot found).
    const d: any = Object.values(m.overrides ?? {})[0];
    const vals = Object.values(d?.stateDiff ?? {});
    return reply({ id: m.id, ok: true, results: [{ success: true, output: vals[0] ?? '0x' + word(0n), gasUsed: '0x5208' }] });
  };
}

// A node that always says "profit 777".
const node777: Rpc = async (method, params) => {
  const p = params as any[];
  if (method === 'eth_call' && p[0]?.to?.toLowerCase() === SIM_EXECUTOR_ADDRESS) return { error: { code: 3, message: 'execution reverted', data: insufficient(777n) } };
  if (method === 'eth_call') { const d: any = Object.values(p[2] ?? {})[0]; return { result: Object.values(d?.stateDiff ?? {})[0] ?? '0x' + word(0n) }; }
  return { result: null };
};

// Flash-loan trade (no balance-slot probe needed).
const TRADE = { token: '0x00000000000000000000000000000000000000aa', amountIn: 1_000_000n, hops: [] as any[] };
const SIMOPTS = { v3Lender: '0x00000000000000000000000000000000000000bb' };

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'arbsim-host-'));
  const sock = join(dir, 'arbsim.sock');
  const quiet = () => {};
  const baseEnv = { ARBSIM_SOCKET: sock, LOCAL_SIM_LOG: join(dir, 'shadow.jsonl') };
  const fake = new FakeSidecar(sock);
  await fake.listen();
  const hosts: LocalSimHost[] = [];
  const mk = (env: Record<string, string>, extra: Partial<Parameters<typeof createLocalSimHost>[1]> = {}) => {
    const h = createLocalSimHost(true, { env: { ...baseEnv, ...env }, log: quiet, logFlushMs: 0, statusEveryMs: 3_600_000, warmEveryMs: 3_600_000, clientOptions: { backoffMinMs: 20, backoffMaxMs: 50 }, ...extra });
    if (h) hosts.push(h);
    return h;
  };
  try {
    // ---- 1. OFF = nothing at all --------------------------------------------
    const before = fake.connections;
    assert(createLocalSimHost(true, { env: { ...baseEnv }, log: quiet }) === null, 'LOCAL_SIM unset -> no host');
    assert(createLocalSimHost(true, { env: { ...baseEnv, LOCAL_SIM: 'off' }, log: quiet }) === null, 'LOCAL_SIM=off -> no host');
    assert(createLocalSimHost(false, { env: { ...baseEnv, LOCAL_SIM: 'shadow' }, log: quiet }) === null, 'Robinhood not traded -> no host');
    await sleep(100);
    assert(fake.connections === before && fake.seen.length === 0, 'off mode: no socket activity at all');

    // ---- 2. ON needs the confirm word -----------------------------------------
    const logs: string[] = [];
    const noConfirm = mk({ LOCAL_SIM: 'on' }, { log: (m) => logs.push(m) })!;
    assert(!noConfirm.isOn() && logs.some((l) => /LOCAL_SIM_CONFIRM/.test(l) && /practice/.test(l)), 'LOCAL_SIM=on without LOCAL_SIM_CONFIRM -> practice, and the log says why');
    assert(!mk({ LOCAL_SIM: 'on', LOCAL_SIM_CONFIRM: 'yes' })!.isOn(), 'wrong confirm word -> practice');
    assert(mk({ LOCAL_SIM: 'on', LOCAL_SIM_CONFIRM: 'yes-fast-check' })!.isOn(), 'LOCAL_SIM=on + LOCAL_SIM_CONFIRM=yes-fast-check -> on');
    assert(!mk({ LOCAL_SIM: 'shadow', LOCAL_SIM_CONFIRM: 'yes-fast-check' })!.isOn(), 'shadow stays practice even with the confirm word');
    assert(hostSettings({}).socketPath === '/tmp/arbsim.sock', 'default socket /tmp/arbsim.sock');

    // ---- 3. Feed forwarding: byte for byte ------------------------------------
    const shadow = mk({ LOCAL_SIM: 'shadow' })!;
    assert(await waitFor(() => shadow.client.isConnected()), 'shadow host connects');
    const frames = [
      '{"version":1,"messages":[{"sequenceNumber":123,"message":{"message":{"header":{"kind":3},"l2Msg":"BAL+/="}}}]}',
      '  {"weird": "spacing" ,"unicode":"héllo ✓ \\u00e9"}  ',
      'not json at all \u0000 \t',
      'x'.repeat(200_000),
    ];
    const n0 = fake.rawFeedBodies.length;
    for (const f of frames) shadow.forwardFeed(f);
    assert(await waitFor(() => fake.rawFeedBodies.length === n0 + frames.length), 'every feed frame arrives');
    const got = fake.rawFeedBodies.slice(n0).map((b) => JSON.parse(b.toString('utf8')));
    assert(got.every((m, i) => m.type === 'feed' && m.frame === frames[i]), 'feed frames are passed on unchanged (byte-identical text, in order)');
    assert(got.every((m, i) => Buffer.from(m.frame, 'utf8').equals(Buffer.from(frames[i], 'utf8'))), 'feed frame bytes identical after the socket');

    // ---- 4. Warm list ------------------------------------------------------------
    fake.handler = answerProfit(500n);
    const warmHost = mk({ LOCAL_SIM: 'shadow' }, { warmSource: () => ['0x' + 'AB'.repeat(20), '0x' + 'ab'.repeat(20), 'not-an-address', '0x' + '11'.repeat(32)] })!;
    assert(await waitFor(() => fake.seen.some((m) => m.type === 'warm' && m.accounts?.length === 1 && m.accounts[0] === '0x' + 'ab'.repeat(20))), 'warm list sent on connect: addresses only, lower case, no duplicates');

    // ---- 5. Shadow never changes the node's answer ----------------------------
    // Sidecar says profit 500, node says profit 777: the decision uses 777.
    const nodeAlone = await simulateRoundTrip(node777, 'robinhood', TRADE, SIMOPTS);
    const lc = shadow.begin({ kind: 'gap', trade: TRADE, simOpts: SIMOPTS, label: 'T/U gap' });
    const nodeWith = await simulateRoundTrip(node777, 'robinhood', TRADE, SIMOPTS);
    lc.nodeDone(nodeWith, Date.now() - 5, 'latest');
    const lo = await lc.result;
    assert(nodeAlone.status === 'profit' && nodeWith.status === 'profit' && (nodeWith as any).profit === 777n && JSON.stringify(nodeAlone, (_k, v) => typeof v === 'bigint' ? String(v) : v) === JSON.stringify(nodeWith, (_k, v) => typeof v === 'bigint' ? String(v) : v), 'shadow: node answer identical with and without the fast check');
    assert(lo.sure && lo.verdict === 'profit' && (lo.sim as any).profit === 500n && lo.gasUsed === 0x5323bn, 'shadow: fast answer read through simulateRoundTrip (profit + gas)');
    assert(!shadow.isOn(), 'shadow: fast check never decides');
    // Same-verdict counting: 1 compared, same verdict (profit vs profit).
    // Disagreeing verdict: sidecar says loss, node says profit.
    fake.handler = answerProfit(0n);
    const lc2 = shadow.begin({ kind: 'trig', trade: TRADE, simOpts: SIMOPTS, triggerHash: '0x' + 'cd'.repeat(32), seenMs: Date.now() - 3 });
    const lo2 = await lc2.result;
    assert(lo2.verdict === 'loss', 'fast check loss verdict read');
    assert(fake.seen.some((m) => m.type === 'call' && m.at?.afterTx === '0x' + 'cd'.repeat(32)), 'follow-a-trade check asks "right after the trigger" (at.afterTx)');
    assert(fake.seen.some((m) => m.type === 'call' && m.at?.after === 'head'), 'sitting-gap check asks at the newest state (after: head)');
    lc2.nodeDone(nodeWith, Date.now() - 80, 'right after trigger');
    // Unknown answer: counted as unknown.
    fake.handler = (m, reply) => reply({ id: m.id, ok: false, unknown: 'miss', missing: [] });
    const lc3 = shadow.begin({ kind: 'gap', trade: TRADE, simOpts: SIMOPTS });
    const lo3 = await lc3.result;
    assert(!lo3.sure && lo3.verdict === 'unknown' && lo3.why === 'miss', 'sidecar unknown -> not sure (why: miss)');
    lc3.nodeDone(nodeWith, Date.now() - 50, 'latest');
    await shadow.shadowLog.flush();
    const lines = readFileSync(baseEnv.LOCAL_SIM_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const trig = lines.find((l) => l.k === 'trig');
    assert(lines.length >= 3 && trig && trig.lv === 'loss' && trig.nv === 'profit' && trig.same === false && trig.np === '777' && typeof trig.lms === 'number' && typeof trig.lseen === 'number' && trig.seen && trig.sent && trig.ans, 'shadow log line: both verdicts, profits, times, timestamps (seen / sent / answer)');
    assert(lines.some((l) => l.lu === 'miss'), 'shadow log line carries the unknown reason');

    // ---- 5b. Copy 2 disagreement: the node again AT THE COPY'S BLOCK (copy2-q) ----
    // Copy (at block 0x10) says profit, the node (later) says loss.
    fake.handler = answerProfit(500n);
    const lossSim = { status: 'loss', reason: 'ends with less' } as any;
    const asked: string[] = [];
    const reAlerts: string[] = [];
    for (const [nodeThere, want] of [[{ status: 'profit', profit: 400n } as any, 'EARLY'], [lossSim, 'MISMATCH']] as const) {
      const h = mk({ LOCAL_SIM: 'shadow' }, { alert: (t) => reAlerts.push(t), nodeAtBlock: async (_q, tag) => { asked.push(tag); return nodeThere; } })!;
      assert(await waitFor(() => h.client.isConnected()), 'recheck host connects');
      const c = h.begin({ kind: 'gap', trade: TRADE, simOpts: SIMOPTS, at: { block: '0x10' }, label: 'VIRTUAL/WETH gap' });
      await c.result;
      c.nodeDone(lossSim, Date.now() - 125, 'latest');
      await sleep(20);
      await h.shadowLog.flush();
      const re = readFileSync(baseEnv.LOCAL_SIM_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.k === 'recheck');
      const last = re[re.length - 1];
      assert(last && last.c2blk === '0x10' && last.lv === 'profit' && last.nv === 'loss' && String(last.result).startsWith(want), `disagreement asked again at the copy's block -> "${want}" (${last?.result})`);
      const line = h.takeHourLine() ?? '';
      assert(want === 'EARLY' ? /EARLY \(copy right, gap closed after\) 1, MISMATCH at same moment 0/.test(line) : /EARLY \(copy right, gap closed after\) 0, MISMATCH at same moment 1/.test(line), `hourly line counts it (${line})`);
    }
    assert(asked.length === 2 && asked.every((t) => t === '0x10'), 'the node is asked pinned at the copy block');
    assert(reAlerts.length === 1 && /MISMATCH at same moment/.test(reAlerts[0]), 'only a MISMATCH alerts');
    // Agreement: no re-check.
    const h3 = mk({ LOCAL_SIM: 'shadow' }, { nodeAtBlock: async (_q, tag) => { asked.push(tag); return lossSim; } })!;
    assert(await waitFor(() => h3.client.isConnected()), 'host connects');
    const c3 = h3.begin({ kind: 'gap', trade: TRADE, simOpts: SIMOPTS, at: { block: '0x11' } });
    await c3.result;
    c3.nodeDone({ status: 'profit', profit: 450n } as any, Date.now() - 100, 'latest');
    await sleep(20);
    assert(asked.length === 2, 'same verdict: no re-check');
    assert(trig.lus === 2.5 && typeof trig.lrt === 'number' && trig.lt?.runs?.length === 2, `shadow log line carries arbsim's own time (lus ${trig.lus}), the round trip (lrt) and arbsim's split (lt)`);
    const hourLine = shadow.takeHourLine()!;
    assert(/^Fast check \(practice\): 3 checks, same answer 50%, unknown 33%, median \d+ ms vs node \d+ ms/.test(hourLine), `hour line in the agreed wording: "${hourLine}"`);

    // ---- 6. Unknown -> the node decides (on mode) ------------------------------
    const on = mk({ LOCAL_SIM: 'on', LOCAL_SIM_CONFIRM: 'yes-fast-check' }, { alert: (t) => alerts.push(t) })!;
    const alerts: string[] = [];
    assert(await waitFor(() => on.client.isConnected()), 'on host connects');
    fake.handler = (m, reply) => reply({ id: m.id, ok: false, unknown: 'dirty' });
    // What shadowMain's fastDecide does: sure -> use it, unknown -> node.
    const decide = async (h: LocalSimHost, nodeRpc: Rpc): Promise<{ by: 'local' | 'node'; r: SimResult }> => {
      const c = h.begin({ kind: 'gap', trade: TRADE, simOpts: SIMOPTS });
      const o = await c.result;
      if (h.isOn() && o.sure) { c.decidedByLocal = true; if (h.shouldSample()) c.sampled = true; else c.noNode(); return { by: 'local', r: o.sim }; }
      const r = await simulateRoundTrip(nodeRpc, 'robinhood', TRADE, SIMOPTS);
      c.nodeDone(r, Date.now());
      return { by: 'node', r };
    };
    const d1 = await decide(on, node777);
    assert(d1.by === 'node' && (d1.r as any).profit === 777n, 'on mode: unknown -> node path unchanged');
    // Sidecar down entirely -> node (and never hangs).
    const downHost = mk({ LOCAL_SIM: 'on', LOCAL_SIM_CONFIRM: 'yes-fast-check', ARBSIM_SOCKET: join(dir, 'nobody.sock') })!;
    const t0 = Date.now();
    const d2 = await decide(downHost, node777);
    assert(d2.by === 'node' && (d2.r as any).profit === 777n && Date.now() - t0 < 500, 'sidecar not running -> node decides at once');
    fake.handler = answerProfit(500n);
    const d3 = await decide(on, node777);
    assert(d3.by === 'local' && (d3.r as any).profit === 500n, 'on mode: sure fast answer is used');

    // ---- 7. Automatic step back ------------------------------------------------
    // (a) re-checks disagreeing > 2% (min. 50 counted -> 2 disagreements trigger it).
    const sampleHost = mk({ LOCAL_SIM: 'on', LOCAL_SIM_CONFIRM: 'yes-fast-check', LOCAL_SIM_SAMPLE_EVERY: '1' }, { alert: (t) => alerts.push(t) })!;
    assert(await waitFor(() => sampleHost.client.isConnected()), 'sample host connects');
    const recheck = async (nodeSays: SimResult) => {
      const c = sampleHost.begin({ kind: 'gap', trade: TRADE, simOpts: SIMOPTS });
      await c.result;
      c.decidedByLocal = true;
      assert(sampleHost.shouldSample(), 'sample every 1 -> sampled');
      c.sampled = true;
      c.nodeDone(nodeSays, Date.now());
    };
    await recheck({ status: 'profit', profit: 1n, bucket: 'profit' });
    assert(sampleHost.isOn(), 'agreeing re-check keeps it on');
    await recheck({ status: 'loss', bucket: 'real_loss' });
    assert(sampleHost.isOn(), '1 disagreement out of 2 (counted over 50 = 2%) is not over 2%: still on');
    await recheck({ status: 'loss', bucket: 'real_loss' });
    assert(!sampleHost.isOn() && /stepped back/i.test(sampleHost.modeText()), '2 disagreements (> 2%) -> stepped back to practice');
    assert(alerts.some((a) => /FAST CHECK stepped back to practice for 6 hours/.test(a)), 'Telegram alert on step back');
    // (b) replay mismatches rising in the sidecar status.
    let mm = 3;
    fake.handler = (m, reply) => m.type === 'status' ? reply({ id: m.id, ok: true, replay_mismatch: mm }) : answerProfit(500n)(m, reply);
    await on.pollStatus();
    assert(on.isOn(), 'first status poll only sets the starting point');
    await on.pollStatus();
    assert(on.isOn(), 'no new mismatches: stays on');
    mm = 5;
    await on.pollStatus();
    assert(!on.isOn() && alerts.some((a) => /replay mismatch/.test(a)), 'replay_mismatch rising -> stepped back + alert');
    // Back on after 6 h (fake clock).
    let fakeNow = Date.now();
    const clockHost = mk({ LOCAL_SIM: 'on', LOCAL_SIM_CONFIRM: 'yes-fast-check' }, { now: () => fakeNow })!;
    assert(await waitFor(() => clockHost.client.isConnected()), 'clock host connects');
    mm = 0;
    await clockHost.pollStatus();
    mm = 9;
    await clockHost.pollStatus();
    assert(!clockHost.isOn(), 'clock host stepped back');
    fakeNow += 6 * 3_600_000 + 1;
    assert(clockHost.isOn(), 'after 6 h it decides again');

    // ---- 8. Size search: never above the size asked -----------------------------
    fake.handler = (m, reply) => {
      if (m.type === 'size_search') {
        return reply({ id: m.id, ok: true, best: { amount: '0x' + (400_000n).toString(16), profit: '0x' + (900n).toString(16), gasUsed: '0x1' }, tried: [] });
      }
      return answerProfit(500n)(m, reply);
    };
    const realTrade = { token: TRADE.token, amountIn: 1_000_000n, hops: [{ kind: 0, pool: '0x00000000000000000000000000000000000000c1', tokenIn: TRADE.token, tokenOut: '0x00000000000000000000000000000000000000c2', feeBps: 30 }] };
    const sc = sampleHost.begin({ kind: 'gap', trade: realTrade, simOpts: SIMOPTS });
    await sc.result;
    const best = await sampleHost.sizeSearch(sc);
    const ss = fake.seen.filter((m) => m.type === 'size_search').pop();
    assert(!!best && best.amountIn === 400_000n && best.profit === 900n, 'size search: smaller, better size accepted');
    assert(ss && ss.amountOffset === 96 && BigInt(ss.range.hi) === 1_000_000n && BigInt(ss.range.lo) === 125_000n, 'size search asked between 1/8 and the size the bot picked (never above)');
    fake.handler = (m, reply) => m.type === 'size_search'
      ? reply({ id: m.id, ok: true, best: { amount: '0x' + (2_000_000n).toString(16), profit: '0x' + (99_999n).toString(16) }, tried: [] })
      : answerProfit(500n)(m, reply);
    const sc2 = sampleHost.begin({ kind: 'gap', trade: realTrade, simOpts: SIMOPTS });
    await sc2.result;
    assert((await sampleHost.sizeSearch(sc2)) === null, 'size search answer above the size asked is refused');

    // ---- 9. Verdict rules ---------------------------------------------------------
    assert(verdictOf({ status: 'fail', reason: 'replay unavailable (local sim unknown: miss)' }) === 'unknown', 'marker -> unknown');
    assert(verdictOf({ status: 'fail', reason: 'execution reverted' }) === 'unknown', 'no-reason failure -> unknown (not a verdict)');
    assert(verdictOf({ status: 'fail', reason: 'BadRoute()', bucket: 'contract_revert' }) === 'fail', 'real refusal -> fail verdict');
    assert(verdictOf({ status: 'rate_limited', reason: 'x' }) === 'unknown', 'rate limited -> unknown');

    // ---- 10. Log rotation ------------------------------------------------------------
    const logFile = join(dir, 'rot.jsonl');
    const jl = new JsonlLog(logFile, 2_000, 0);
    for (let i = 0; i < 30; i++) { jl.add({ i, pad: 'p'.repeat(100) }); await jl.flush(); }
    assert(existsSync(logFile + '.1') && statSync(logFile).size <= 2_000 && statSync(logFile + '.1').size <= 2_000, 'log rotates at the size cap (file + .1, both under the cap)');
    writeFileSync(join(dir, 'blocker'), 'x');
    const bad = new JsonlLog(join(dir, 'blocker', 'cant.jsonl'), 2_000, 0);
    bad.add({ a: 1 });
    await bad.flush();
    assert(bad.dropped === 1, 'log write failure is counted, never thrown');
    // Default cap is 2 MB.
    assert(hostSettings({}).maxLogBytes === 2_000_000, 'default log cap 2 MB');
    void warmHost;
  } finally {
    for (const h of hosts) await h.stop();
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error('FAIL: test crashed', e); process.exitCode = 1; });
void LocalSimClient;
