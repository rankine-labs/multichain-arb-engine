import { createServer, Server, Socket } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LocalSimClient, makeLocalRpc, localSimMode, localUnknownMessage, blockTagToAt, frame, LOCAL_UNKNOWN_PREFIX,
} from '../execution/localSim';
import { readReplayAnswer, replayRpc, simulateRoundTrip, isRateLimited, isNoReasonFail, SIM_EXECUTOR_ADDRESS, Rpc } from '../execution/simulator';
import { classifySimOutcome, isTradeVerdict } from '../core/failReasons';

// Local simulator client (arbsim sidecar): framing, timeouts, reconnects,
// "unknown" answers that the bot never mistakes for a trade result, and
// eth_simulateV1 answers that read exactly like a node's.
// A fake sidecar runs in this process (no Rust needed).

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fake sidecar: decodes frames, lets the test decide each answer.
// ---------------------------------------------------------------------------
type Handler = (msg: any, reply: (ans: any) => void) => void;
class FakeSidecar {
  server: Server;
  seen: any[] = [];
  sockets: Socket[] = [];
  handler: Handler = (m, reply) => reply({ id: m.id, ok: false, unknown: 'not_ready' });
  constructor(readonly path: string) {
    this.server = createServer((s) => {
      this.sockets.push(s);
      let buf = Buffer.alloc(0);
      s.on('data', (c: Buffer) => {
        buf = Buffer.concat([buf, c]);
        while (buf.length >= 4) {
          const len = buf.readUInt32BE(0);
          if (buf.length < 4 + len) break;
          const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
          buf = buf.subarray(4 + len);
          this.seen.push(msg);
          if (msg.type === 'feed') continue; // no answer for feed frames
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

async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(5); }
  return cond();
}

const INSUFFICIENT = '0x4e88422a' + (123456n).toString(16).padStart(64, '0') + 'f'.repeat(64);

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'arbsim-test-'));
  const sock = join(dir, 'arbsim.sock');
  try {
    // 1. Mode switch.
    assert(localSimMode({}) === 'off' && localSimMode({ LOCAL_SIM: 'garbage' }) === 'off', 'LOCAL_SIM unset/unknown -> off');
    assert(localSimMode({ LOCAL_SIM: 'shadow' }) === 'shadow' && localSimMode({ LOCAL_SIM: ' ON ' }) === 'on', 'LOCAL_SIM shadow / on');

    // 2. The "unknown" marker is never a trade verdict, never "overrides
    //    unsupported", never a rate limit, never "no reason" (second opinion).
    for (const why of ['miss', 'timeout', 'disconnected', 'dirty', 'stale', 'not_ready', 'override_x', 'rate limit exceeded', 'execution reverted']) {
      const m = localUnknownMessage(why);
      const bucket = classifySimOutcome('fail', m);
      assert(m.startsWith(LOCAL_UNKNOWN_PREFIX) && m.includes('local sim unknown: '), `marker wording for "${why}": ${m}`);
      assert(bucket === 'replay_unavailable' && !isTradeVerdict(bucket), `"${why}" -> bucket replay_unavailable (not a trade verdict)`);
      assert(!isRateLimited({ message: m }), `"${why}" is not a rate limit`);
      assert(!/override|too many arguments|invalid params/i.test(m), `"${why}" never reads as "overrides unsupported"`);
      assert(!isNoReasonFail({ status: 'fail', reason: m }), `"${why}" doesn't trigger a second-opinion recheck`);
    }
    // ...and through the real simulator it comes back as a non-verdict 'fail'.
    {
      const unknownRpc: Rpc = async (method, params) => {
        const p = params as any[];
        if (p[0]?.data?.startsWith('0x70a08231')) { const diff = Object.values(p[2])[0] as any; return { result: Object.values(diff.stateDiff)[0] }; }
        return { error: { message: localUnknownMessage('miss') } };
      };
      const r = await simulateRoundTrip(unknownRpc, 'localsim-test', { token: '0x0000000000000000000000000000000000000001', amountIn: 1n, hops: [] });
      assert(r.status === 'fail' && r.bucket === 'replay_unavailable', `simulateRoundTrip: unknown -> fail/replay_unavailable (got ${r.status}/${r.bucket})`);
      assert('reason' in r && r.reason.startsWith('replay unavailable'), 'shadowMain falls back to a node check on this reason (startsWith "replay unavailable")');
    }

    // 3. Block tags.
    assert(JSON.stringify(blockTagToAt('latest')) === '{"after":"head"}' && JSON.stringify(blockTagToAt(undefined)) === '{"after":"head"}', "'latest' -> after head");
    assert(JSON.stringify(blockTagToAt('0x1A')) === '{"block":"0x1a"}', 'hex block -> block');
    assert(blockTagToAt('pending') === null && blockTagToAt('0x' + 'ab'.repeat(32)) !== null, 'pending not served locally');

    // 4. Sidecar not running: answers "unknown" right away, never throws.
    const lonely = new LocalSimClient({ socketPath: join(dir, 'nobody.sock'), backoffMinMs: 10, backoffMaxMs: 20 });
    const a0 = await lonely.request({ type: 'status' });
    assert(a0.ok === false && (a0 as any).unknown === 'disconnected', 'no sidecar -> unknown: disconnected');
    const rpc0 = makeLocalRpc(lonely);
    const r0 = await rpc0('eth_call', [{ to: '0x01', data: '0x' }, 'latest']);
    assert(r0.error?.message === localUnknownMessage('disconnected'), 'no sidecar -> marker error from the Rpc');
    // Feed frames queue (bounded) while disconnected.
    for (let i = 0; i < 300; i++) lonely.sendFeed(`{"n":${i}}`);
    assert(lonely.stats.feedDropped === 44, `feed queue bounded at 256 (dropped ${lonely.stats.feedDropped})`);
    lonely.close();

    // 5. Real conversation with the fake sidecar.
    const fake = new FakeSidecar(sock);
    await fake.listen();
    const client = new LocalSimClient({ socketPath: sock, timeoutMs: 50, backoffMinMs: 10, backoffMaxMs: 40 });
    assert(await waitFor(() => client.isConnected()), 'client connects');

    // 5a. Framing + pipelining: answers come back out of order, matched by id.
    fake.handler = (m, reply) => setTimeout(() => reply({ id: m.id, ok: true, results: [{ success: true, output: '0x' + String(m.tag).padStart(2, '0'), gasUsed: '0x5208' }] }), m.tag === 1 ? 20 : 1);
    const [x1, x2, x3] = await Promise.all([1, 2, 3].map((tag) => client.request({ type: 'call', tag })));
    assert((x1 as any).results[0].output === '0x01' && (x2 as any).results[0].output === '0x02' && (x3 as any).results[0].output === '0x03', 'pipelined answers matched by id (out of order)');
    // A big message (122-key stateDiff + long data) frames correctly.
    const bigDiff: Record<string, string> = {};
    for (let i = 0; i < 122; i++) bigDiff['0x' + i.toString(16).padStart(64, '0')] = '0x' + (1000 + i).toString(16).padStart(64, '0');
    let seenDiff: any = null;
    fake.handler = (m, reply) => { seenDiff = m; reply({ id: m.id, ok: true, results: [{ success: true, output: '0x' + '00'.repeat(31) + '07', gasUsed: '0x6000' }] }); };
    const rpc = makeLocalRpc(client);
    const token = '0x00000000000000000000000000000000000000cc';
    const rb = await rpc('eth_call', [{ to: token, data: '0x70a08231' + '00'.repeat(32) + 'ab'.repeat(20000) }, 'latest', { [token]: { stateDiff: bigDiff } }]);
    assert(rb.result === '0x' + '00'.repeat(31) + '07', 'eth_call success -> result hex');
    assert(Object.keys(seenDiff.overrides[token].stateDiff).length === 122 && seenDiff.type === 'call' && seenDiff.at.after === 'head', 'findBalanceSlot-style 122-key stateDiff passed through intact');

    // 5b. eth_call revert -> node-style error with the revert data.
    fake.handler = (m, reply) => reply({ id: m.id, ok: true, results: [{ success: false, output: INSUFFICIENT, gasUsed: '0x53000' }] });
    const rr = await rpc('eth_call', [{ from: '0x0b', to: SIM_EXECUTOR_ADDRESS, data: '0x8da2b32d' }, '0x10', {}]);
    assert(rr.error?.code === 3 && rr.error?.data === INSUFFICIENT && rr.error?.message === 'execution reverted', 'eth_call revert -> code 3 + data');
    assert(JSON.stringify(fake.seen[fake.seen.length - 1].at) === '{"block":"0x10"}', 'hex block tag -> {block}');
    fake.handler = (m, reply) => reply({ id: m.id, ok: true, results: [{ success: false, output: '0x', gasUsed: '0x7a1200', halt: 'OutOfGas(Basic)' }] });
    const rh = await rpc('eth_call', [{ to: '0x01' }, 'latest']);
    assert(rh.error?.message === 'out of gas' && rh.error?.data === undefined, 'halt -> node wording, no data');

    // 5c. eth_simulateV1 exactly as replayRpc sends it, answer read by readReplayAnswer.
    let simReq: any = null;
    fake.handler = (m, reply) => {
      simReq = m;
      reply({ id: m.id, ok: true, results: m.calls.map((_: any, i: number) => i < m.calls.length - 1
        ? { success: true, output: '0x', gasUsed: '0x1d4c0' }
        : { success: false, output: INSUFFICIENT, gasUsed: '0x5323b' }) });
    };
    const trigger = { from: '0x00000000000000000000000000000000000000aa', to: '0x00000000000000000000000000000000000000bb', data: '0x1234', value: '0x0', gas: '0x30d40' };
    const replay = replayRpc(rpc, '0x99', [trigger], '0x6543');
    const ov = { [SIM_EXECUTOR_ADDRESS]: { code: '0x6000', stateDiff: { ['0x' + '00'.repeat(32)]: '0x' + '00'.repeat(31) + '01' } } };
    const ra = await replay('eth_call', [{ from: '0x0b', to: SIM_EXECUTOR_ADDRESS, data: '0x8da2b32d', gas: '0x7a1200' }, 'latest', ov]);
    assert(simReq?.type === 'call' && simReq.nextBlock === true && JSON.stringify(simReq.at) === '{"block":"0x99"}', 'eth_simulateV1 -> call on the parent block, as the NEXT block');
    assert(simReq.calls.length === 2 && simReq.calls[0].data === '0x1234' && simReq.blockOverrides.time === '0x6543' && simReq.overrides[SIM_EXECUTOR_ADDRESS].code === '0x6000', 'trigger first, block time + overrides passed');
    assert(ra.error?.data === INSUFFICIENT && (ra.error as any).gasUsed === '0x5323b' && (ra.error as any).via === 'eth_simulateV1', 'replay answer: revert data + gasUsed, read like a node');
    // Same answer as a node's eth_simulateV1 result going through readReplayAnswer.
    const nodeShape = [{ calls: [{ status: '0x1', returnData: '0x', gasUsed: '0x1d4c0', logs: [] }, { status: '0x0', returnData: '0x', gasUsed: '0x5323b', logs: [], error: { code: 3, message: 'execution reverted', data: INSUFFICIENT } }] }];
    assert(JSON.stringify(readReplayAnswer(nodeShape, 2)) === JSON.stringify(ra), 'local answer identical to a real node answer after readReplayAnswer');
    // Full path: simulateRoundTrip over the replay reads the profit.
    fake.handler = (m, reply) => {
      const isProbe = m.calls.length === 1 && String(m.calls[0].data).startsWith('0x70a08231');
      if (isProbe) { // findBalanceSlot: answer with the marker value of the first stateDiff key
        const d = Object.values(m.overrides)[0] as any;
        reply({ id: m.id, ok: true, results: [{ success: true, output: Object.values(d.stateDiff)[0], gasUsed: '0x6000' }] });
        return;
      }
      reply({ id: m.id, ok: true, results: m.calls.map((_: any, i: number) => i < m.calls.length - 1 ? { success: true, output: '0x', gasUsed: '0x5208' } : { success: false, output: INSUFFICIENT, gasUsed: '0x5323b' }) });
    };
    const sr = await simulateRoundTrip(replayRpc(rpc, '0x99', [trigger]), 'localsim-e2e', { token: '0x0000000000000000000000000000000000000002', amountIn: 10n, hops: [] });
    assert(sr.status === 'profit' && (sr as any).profit === 123456n && (sr as any).gasUsed === 0x5323bn, `end to end: profit 123456 + gas read through simulateRoundTrip (got ${sr.status})`);

    // 5d. Unknown / timeout -> marker; with fallback -> the node answers, counted.
    fake.handler = (m, reply) => reply({ id: m.id, ok: false, unknown: 'miss', missing: [{ account: '0x01', slot: '0x02' }] });
    const ru = await rpc('eth_call', [{ to: '0x01' }, 'latest']);
    assert(ru.error?.message === localUnknownMessage('miss'), 'sidecar unknown -> marker error');
    fake.handler = () => { /* never answers */ };
    const t0 = Date.now();
    const rt = await rpc('eth_call', [{ to: '0x01' }, 'latest']);
    const took = Date.now() - t0;
    assert(rt.error?.message === localUnknownMessage('timeout') && took < 500, `no answer -> timeout marker after ~50 ms (took ${took} ms)`);
    let nodeCalls = 0;
    const node: Rpc = async () => { nodeCalls++; return { result: '0xfeed' }; };
    const withFb = makeLocalRpc(client, node);
    const rf = await withFb('eth_call', [{ to: '0x01' }, 'latest']);
    assert(rf.result === '0xfeed' && nodeCalls === 1 && client.stats.fallbacks === 1, 'unknown + fallback -> node answers transparently, counted');
    const rn = await withFb('eth_getTransactionReceipt', ['0xabc']);
    assert(rn.result === '0xfeed' && nodeCalls === 2, 'other methods go to the fallback node');
    const rn2 = await rpc('eth_getTransactionReceipt', ['0xabc']);
    assert(rn2.error?.message === localUnknownMessage('method_not_local'), 'other methods without fallback -> marker');
    // Unsupported simulate shapes go to the node instead of being guessed.
    const rv = await rpc('eth_simulateV1', [{ blockStateCalls: [{ calls: [{ to: '0x01' }] }], validation: true }, 'latest']);
    assert(rv.error?.message === localUnknownMessage('unsupported_simulate_shape'), 'validation:true simulate not served locally');
    const rbo = await rpc('eth_simulateV1', [{ blockStateCalls: [{ calls: [{ to: '0x01' }], blockOverrides: { baseFeePerGas: '0x1' } }] }, 'latest']);
    assert(rbo.error?.message === localUnknownMessage('unsupported_block_override'), 'unknown block override not served locally');

    // 5e. Feed frames are forwarded, no answer expected.
    const before = fake.seen.length;
    client.sendFeed('{"version":1,"messages":[]}');
    assert(await waitFor(() => fake.seen.length === before + 1), 'feed frame forwarded');
    assert(fake.seen[fake.seen.length - 1].type === 'feed' && fake.seen[fake.seen.length - 1].frame === '{"version":1,"messages":[]}', 'feed frame untouched');

    // 5f. Sidecar dies mid-question: in-flight question answers "unknown",
    //     then the client reconnects by itself when it's back.
    fake.handler = () => {};
    const inflight = client.request({ type: 'call' }, 2000);
    await sleep(10);
    await fake.stop();
    const dead = await inflight;
    assert(dead.ok === false && (dead as any).unknown === 'disconnected', 'in-flight question -> unknown on disconnect (not left hanging)');
    for (let i = 0; i < 5; i++) client.sendFeed(`{"while_down":${i}}`);
    const fake2 = new FakeSidecar(sock);
    await fake2.listen();
    assert(await waitFor(() => client.isConnected(), 3000), 'client reconnects with backoff');
    assert(client.stats.reconnects === 1, 'reconnect counted');
    assert(await waitFor(() => fake2.seen.filter((m) => m.type === 'feed').length === 5), 'feed frames queued while down are delivered after reconnect');
    fake2.handler = (m, reply) => reply({ id: m.id, ok: true, results: [{ success: true, output: '0x01', gasUsed: '0x5208' }] });
    const back = await rpc('eth_call', [{ to: '0x01' }, 'latest']);
    assert(back.result === '0x01', 'works again after reconnect');

    // 5g. Garbage from the sidecar never crashes the bot.
    fake2.handler = (m, reply) => reply({ id: m.id, ok: true, results: 'nope' });
    const g = await rpc('eth_call', [{ to: '0x01' }, 'latest']);
    assert(!!g.error?.message?.startsWith(LOCAL_UNKNOWN_PREFIX), 'malformed answer -> marker, no crash');

    client.close();
    await fake2.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error('FAIL: test crashed', e); process.exitCode = 1; });
