import { ethers, Wallet, keccak256 } from 'ethers';
import { parseFeedMessages, parseFeedFrame, FeedMsg } from '../chains/nitroFeed';
import { FeedOrderBuffer, TriggerFirst, TrigWarmer, TrigCopy2, triggerFirstMode, trigFirstSettings, TrigOutcome } from '../execution/triggerFirst';
import { runCheckFirst } from '../execution/checkFirstFlow';
import { decideCheckFirst } from '../core/checkFirst';
import { JsonlLog } from '../execution/localSimHost';
import { LocalSimClient } from '../execution/localSim';
import { SIM_EXECUTOR_ADDRESS } from '../execution/simulator';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// TRIGGER-FIRST (execution/triggerFirst.ts + checkFirstFlow.ts): the feed's
// complete messages in an order buffer, the question to the fast check with
// the ordered transactions, the off / shadow / on switch, the warmer's budget,
// the log line, and the KEY test: a profitable trigger reaches the sender
// without waiting for pool reports or receipts and without ANY node request.
// The fast check (sidecar) is faked in this process.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Feed frames with real signed transactions (throwaway test keys).
// ---------------------------------------------------------------------------
const walletA = new Wallet('0x' + '11'.repeat(32));
const walletB = new Wallet('0x' + '22'.repeat(32));
async function signed(w: Wallet, nonce: number, to: string, data = '0x'): Promise<string> {
  return w.signTransaction({ type: 2, chainId: 4663, nonce, to, data, value: 0n, gasLimit: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n });
}
const hexBytes = (h: string) => Buffer.from(h.slice(2), 'hex');
function l2Batch(raws: string[]): string {
  const parts: Buffer[] = [Buffer.from([3])];
  for (const r of raws) {
    const inner = Buffer.concat([Buffer.from([4]), hexBytes(r)]);
    const len = Buffer.alloc(8); len.writeBigUInt64BE(BigInt(inner.length));
    parts.push(len, inner);
  }
  return Buffer.concat(parts).toString('base64');
}
function frameOf(msgs: Array<{ seq: number; raws?: string[]; kind?: number; l2?: string; ts?: number }>): unknown {
  return {
    version: 1,
    messages: msgs.map((m) => ({
      sequenceNumber: m.seq,
      message: { message: { header: { kind: m.kind ?? 3, sender: '0xa4b000000000000000000073657175656e636572', blockNumber: 9000, timestamp: m.ts ?? 1_700_000_000 + m.seq }, l2Msg: m.l2 ?? l2Batch(m.raws ?? []) } },
    })),
  };
}

// ---------------------------------------------------------------------------
// A fake fast check (sidecar) and a fake copy 2.
// ---------------------------------------------------------------------------
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const insufficient = (got: bigint) => '0x4e88422a' + word(got) + 'f'.repeat(64);
type Asked = Record<string, any>;
function fakeClient(answer: (m: Asked) => Asked): { client: LocalSimClient; asked: Asked[] } {
  const asked: Asked[] = [];
  const client = {
    isConnected: () => true,
    stats: { fallbacks: 0 },
    request: async (m: Asked) => { asked.push(m); return { id: 1, ...answer(m) }; },
  } as unknown as LocalSimClient;
  return { client, asked };
}
const profitAnswer = (got: bigint) => (m: Asked): Asked => {
  if (m.type === 'warm') return { ok: true, queued: 1 };
  const call = m.calls?.[0];
  if (call?.to?.toLowerCase() === SIM_EXECUTOR_ADDRESS) {
    return { ok: true, us: 900, results: [{ success: false, output: insufficient(got), gasUsed: '0x5208' }], trig: m.feed ? { snapBlock: 100, included: false, triggerOk: true, msgs: 1, txs: 1, later: 0, lastSeq: 101 } : undefined };
  }
  return { ok: false, unknown: 'bad_request' };
};
function fakeCopy2(o: { ready?: boolean; newest?: number; txBlock?: number | null; reportBlock?: number | null } = {}): TrigCopy2 & { waits: number } {
  const c = {
    waits: 0,
    running: () => true,
    notReadyWhy: () => (o.ready === false ? 'pool loading' : null),
    waitForTx: async () => { c.waits++; await sleep(5); return o.reportBlock === undefined ? 101 : o.reportBlock; },
    forwarder: { newestBlock: () => o.newest ?? 100, txBlockOf: () => (o.txBlock === undefined ? null : o.txBlock) },
  };
  return c;
}

const TOKEN = '0x' + 'ab'.repeat(20);
const LENDER = '0x' + 'cd'.repeat(20);
const trade = { token: TOKEN, amountIn: 1_000_000n, hops: [{ kind: 0, pool: '0x' + 'ee'.repeat(20), tokenIn: TOKEN, tokenOut: '0x' + 'ef'.repeat(20), feeBps: 30 }] };
const simOpts = { v3Lender: LENDER }; // flash mode: no balance-slot lookup

function tmpLog(): { log: JsonlLog; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'trigfirst-'));
  const file = join(dir, 'shadow.jsonl');
  return { log: new JsonlLog(file, 1_000_000, 0), file };
}

async function main() {
  // ---- feed parsing --------------------------------------------------------
  const pool = '0x' + 'ee'.repeat(20);
  const tTrig = await signed(walletA, 0, pool, '0x12345678');
  const tPlain = await signed(walletB, 0, '0x' + '01'.repeat(20)); // plain transfer (no data)
  const tLater = await signed(walletB, 1, pool, '0xabcdef01');
  const msgs = parseFeedMessages(frameOf([{ seq: 100, raws: [tPlain] }, { seq: 101, raws: [tTrig, tLater] }, { seq: 102, kind: 12 }, { seq: 103, l2: Buffer.from([6]).toString('base64') }]));
  assert(msgs.length === 4, 'every feed message is kept, with its sequence number');
  assert(msgs[0].txs.length === 1 && msgs[0].complete, 'plain transfers are kept too (they change state)');
  assert(msgs[1].txs.map((t) => t.hash).join() === [keccak256(tTrig), keccak256(tLater)].join(), 'all transactions, in sequencer order, hash = keccak of the signed bytes');
  assert(msgs[1].txs[0].raw === tTrig, 'the signed bytes exactly as sent');
  assert(!msgs[2].complete && /header kind 12/.test(msgs[2].why ?? ''), 'a deposit message is marked not complete');
  assert(msgs[3].complete && msgs[3].txs.length === 0, 'a heartbeat carries nothing');
  assert(msgs[1].ts === 1_700_000_101 && msgs[1].l1 === 9000, 'block time and parent-chain block from the header');
  const broken = parseFeedMessages(frameOf([{ seq: 5, l2: Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 99, 4]).toString('base64') }]));
  assert(!broken[0].complete, 'a broken batch is marked not complete');
  const fx = parseFeedFrame(frameOf([{ seq: 101, raws: [tTrig, tLater] }]));
  assert(fx[0].raw === tTrig && fx[0].txIndex === 0 && fx[1].txIndex === 1, 'decoded trades carry their signed bytes and place');

  // ---- order buffer --------------------------------------------------------
  const buf = new FeedOrderBuffer(3);
  buf.ingest(msgs, 1);
  assert(buf.seqOf(keccak256(tTrig)) === 101, 'the buffer finds a transaction\'s sequence number');
  buf.ingest([{ ...msgs[1], txs: [] }], 2);
  assert(buf.get(101)!.txs.length === 2, 'a repeated message (reconnect backlog) never replaces the first copy');
  assert(buf.size() === 3 && buf.oldest() === 101 && buf.seqOf(keccak256(tPlain)) === undefined, 'oldest messages forgotten beyond the limit');
  assert(buf.range(99, 103).map((m) => m.seq).join() === '101,102,103', 'range gives the held messages in order');

  // ---- switch ----------------------------------------------------------------
  assert(triggerFirstMode({}) === 'off' && triggerFirstMode({ LOCAL_SIM_TRIGGER_FIRST: 'ON' }) === 'on' && triggerFirstMode({ LOCAL_SIM_TRIGGER_FIRST: 'shadow' }) === 'shadow' && triggerFirstMode({ LOCAL_SIM_TRIGGER_FIRST: 'yes' }) === 'off', 'LOCAL_SIM_TRIGGER_FIRST=off|shadow|on, default off');

  // ---- the question to the fast check -----------------------------------------
  const mk = (env: Record<string, string>, client: LocalSimClient, c2: TrigCopy2 | null, hostOn = true) => {
    const { log, file } = tmpLog();
    const tf = new TriggerFirst({ client, settings: { ...trigFirstSettings(env), finalizeMs: 30, agreeWaitMs: 50 }, copy2: () => c2, shadowLog: log, hostOn: () => hostOn, log: () => {} });
    tf.onFeedMsgs(parseFeedMessages(frameOf([{ seq: 99, raws: [] }, { seq: 100, raws: [tPlain] }, { seq: 101, raws: [tTrig, tLater] }])), 1);
    return { tf, log, file };
  };
  const q = { trade, simOpts, triggerHash: keccak256(tTrig), seenMs: Date.now(), keys: [pool] };
  {
    const { client, asked } = fakeClient(profitAnswer(5_000n));
    const { tf } = mk({ LOCAL_SIM_TRIGGER_FIRST: 'shadow', TRIG_FIRST_BACK_MSGS: '1' }, client, fakeCopy2({ newest: 100 }));
    const out = await tf.check(q);
    assert(out.sure && out.verdict === 'profit' && out.sim.status === 'profit' && out.sim.profit === 5_000n, 'a sure profit from the fast check');
    const sent = asked.find((m) => m.calls?.[0]?.to?.toLowerCase() === SIM_EXECUTOR_ADDRESS)!;
    assert(sent.at?.after === 'head', 'asks about the newest copy version');
    assert(sent.feed?.trigger === keccak256(tTrig).toLowerCase() && sent.feed?.triggerSeq === 101, 'sends the trigger and its sequence number');
    assert(sent.feed.msgs.map((m: any) => m.seq).join() === '99,100,101', 'sends the messages from a little before the copy\'s block up to the newest');
    assert(sent.feed.msgs[2].txs.join() === [tTrig, tLater].join(), 'with every signed transaction of each, in order (also the ones after the trigger)');
    assert(out.info?.snapBlock === 100 && out.triggerSeq === 101, 'keeps what the fast check said about the replay');
  }
  {
    const { client, asked } = fakeClient(() => ({ ok: false, unknown: 'feed_gap' }));
    const { tf } = mk({ LOCAL_SIM_TRIGGER_FIRST: 'on' }, client, fakeCopy2());
    const out = await tf.check(q);
    assert(!out.sure && out.why === 'feed_gap' && asked.length === 1, 'the fast check\'s "unknown" stays unknown, with its reason');
  }
  {
    const { client, asked } = fakeClient(profitAnswer(5_000n));
    let { tf } = mk({ LOCAL_SIM_TRIGGER_FIRST: 'on' }, client, fakeCopy2({ txBlock: 150 }));
    let out = await tf.check(q);
    assert(!out.sure && out.why === 'alignment' && asked.length === 0, 'feed sequence vs the block copy 2 saw it in disagree: unknown, nothing asked');
    ({ tf } = mk({ LOCAL_SIM_TRIGGER_FIRST: 'on' }, client, fakeCopy2({ ready: false })));
    out = await tf.check(q);
    assert(!out.sure && /^copy2_pool_loading/.test(out.why ?? '') && asked.length === 0, 'a route pool not ready in copy 2: unknown, nothing asked');
    ({ tf } = mk({ LOCAL_SIM_TRIGGER_FIRST: 'on' }, client, fakeCopy2()));
    out = await tf.check({ ...q, triggerHash: '0x' + '99'.repeat(32) });
    assert(!out.sure && out.why === 'trigger_not_in_buffer' && asked.length === 0, 'a trigger not in the buffer: unknown, nothing asked');
    ({ tf } = mk({ LOCAL_SIM_TRIGGER_FIRST: 'on' }, client, null));
    out = await tf.check(q);
    assert(!out.sure && out.why === 'copy2_not_running', 'copy 2 not running: unknown');
  }

  // ---- off / shadow / on: who decides ------------------------------------------
  {
    const { client } = fakeClient(profitAnswer(1n));
    assert(!mk({ LOCAL_SIM_TRIGGER_FIRST: 'shadow' }, client, fakeCopy2()).tf.decides(), 'shadow never decides');
    assert(!mk({ LOCAL_SIM_TRIGGER_FIRST: 'on' }, client, fakeCopy2(), false).tf.decides(), 'on, but the fast check is not ON: practice only');
    assert(mk({ LOCAL_SIM_TRIGGER_FIRST: 'on' }, client, fakeCopy2(), true).tf.decides(), 'on + fast check ON: decides');
  }

  // ---- the warmer's budget -------------------------------------------------------
  {
    const sent: any[] = [];
    let t = 0;
    const w = new TrigWarmer((m) => sent.push(m), 3, 2, () => t);
    const router = '0x' + '77'.repeat(20);
    assert(w.offer([{ account: router, slot: '0x1' }]) === 0, 'an account missed once is not warmed yet (rare)');
    assert(w.offer([{ account: router, slot: '0x1' }, { account: router }]) === 2 && w.usedRpc === 2, 'missed again: warmed, cost = 1 proof + 1 code request');
    assert(w.offer([{ account: router, slot: '0x1' }]) === 0, 'the same item is not asked again within 10 min');
    const other = '0x' + '78'.repeat(20);
    w.offer([{ account: other }]);
    assert(w.offer([{ account: other }]) === 0 && w.skippedBudget === 1, 'over the hourly budget: not sent, counted');
    t += 3_600_001;
    w.offer([{ account: other }]);
    assert(w.offer([{ account: other }]) === 1, 'a new hour: budget again');
    await sleep(5);
    assert(sent.length === 2 && sent[0].type === 'warm' && sent[0].slots[router][0] === '0x1' && sent[0].accounts[0] === router, 'sent as the fast check\'s "warm" request');
  }

  // ---- KEY ACCEPTANCE TEST --------------------------------------------------------
  // State available, profitable trigger: the decision reaches the sender WITHOUT
  // copy2WaitForTx, waitForTrade, or any RPC provider request.
  {
    const rpcCalls: string[] = [];
    const origSend = ethers.JsonRpcProvider.prototype.send;
    const origFetch = globalThis.fetch;
    ethers.JsonRpcProvider.prototype.send = async function (method: string) { rpcCalls.push(`provider.${method}`); throw new Error('no node in this test'); };
    (globalThis as any).fetch = async (u: unknown) => { rpcCalls.push(`fetch ${String(u)}`); throw new Error('no network in this test'); };
    const nodeRpc = async (method: string) => { rpcCalls.push(`rpc.${method}`); return { error: { message: 'no node' } }; };
    try {
      const { client } = fakeClient(profitAnswer(2_000_000_000_000_000n)); // 0.002 tokens
      const c2 = fakeCopy2();
      const { tf, file, log } = mk({ LOCAL_SIM_TRIGGER_FIRST: 'on' }, client, c2, true);
      const seenMs = Date.now();
      const tp: Promise<TrigOutcome> = tf.check({ ...q, seenMs });
      let copy2Waits = 0, tradeWaits = 0, nodeChecks = 0, fastStarts = 0;
      const sendCalls: string[] = [];
      const run = await runCheckFirst<object, { status: 'profit'; usd: number } | { status: 'loss' | 'fail'; reason: string }>({
        now: () => Date.now(), mark: () => {},
        trigFirst: tf.decides() ? async () => { const o = await tp; if (!o.sure) return null; tf.noteDecided(q.triggerHash); return o.sim.status === 'profit' ? { status: 'profit', usd: Number(o.sim.profit) / 1e18 * 2_000 } : { status: 'loss', reason: 'loss' }; } : null,
        hasBuilt: true, copy2Running: () => true, copy2Deciding: () => true,
        copy2WaitForTx: async () => { copy2Waits++; return 101; },
        copy2Route: () => ({ at: { block: '0x65' } }),
        startFast: () => { fastStarts++; return {}; },
        fastDecide: async () => null,
        waitForTrade: async () => { tradeWaits++; await nodeRpc('eth_getTransactionReceipt'); return true; },
        nodeCheck: async () => { nodeChecks++; await nodeRpc('eth_call'); return { status: 'fail', reason: 'node' }; },
        noNode: () => {},
      });
      const v = decideCheckFirst(run.c as any, 0.01, 0.25, 100);
      if (v.send) { sendCalls.push('fire'); tf.noteSubmitted(q.triggerHash, Date.now()); }
      assert(run.decidedBy === 'trig_first' && run.waitMs === 0, 'decided by trigger-first, no waiting');
      assert(v.send && v.netUsd > 0.25, 'the verdict says send ($4 profit, all the usual rules)');
      assert(sendCalls.length === 1, 'the trade reaches the sender');
      assert(copy2Waits === 0, 'copy2WaitForTx was never called');
      assert(tradeWaits === 0, 'waitForTrade (receipt polling) was never called');
      assert(nodeChecks === 0 && fastStarts === 0, 'no node check, no other fast check');
      assert(rpcCalls.length === 0, `no RPC provider / network request at all (${rpcCalls.join(', ') || 'none'})`);
      // The log line: written after the answer, with timing and the later
      // same-block re-check (report-based copy 2, no feed).
      // The same-block re-check runs in the background. Wait for its answer
      // (up to 3 s) instead of a fixed 80 ms: on the busy live server the
      // fixed wait was too short and this test blocked a deploy (Oct 28).
      for (let waited = 0; waited < 3_000; waited += 20) {
        const r = (tf as any).recs?.get(q.triggerHash.toLowerCase());
        if (r && r.agree !== undefined) break;
        await sleep(20);
      }
      tf.finish(q.triggerHash.toLowerCase());
      await log.flush();
      const lines = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
      const rec = lines.find((l) => l.k === 'trig_first');
      assert(!!rec && rec.v === 'profit' && rec.dec === 'trig_first' && typeof rec.ansMs === 'number' && typeof rec.subMs === 'number', 'one "trig_first" log line: verdict, decided, feed->answer and feed->submit times');
      assert(rec?.rblk === 101 && rec?.agree === true && rec?.same === true, 'the trigger\'s block reports arrived later; the same trade there agrees (same state)');
      assert(c2.waits === 1, 'the report wait happened only in the background, after the decision');
      assert(rpcCalls.length === 0, 'still no RPC request after the background re-check');
      const hourLine = tf.takeHourLine() ?? '';
      assert(/1 triggers/.test(hourLine) && /answered 1/.test(hourLine) && /feed->submit/.test(hourLine) && /agree 1\/1/.test(hourLine) && /decided 1/.test(hourLine), `hourly line: ${hourLine}`);
    } finally {
      ethers.JsonRpcProvider.prototype.send = origSend;
      (globalThis as any).fetch = origFetch;
    }
  }

  // Unknown answer in "on" mode: the existing path, unchanged (copy 2 wait first).
  {
    const { client } = fakeClient(() => ({ ok: false, unknown: 'stale_fill' }));
    const { tf } = mk({ LOCAL_SIM_TRIGGER_FIRST: 'on' }, client, fakeCopy2(), true);
    const tp = tf.check(q);
    const order: string[] = [];
    const run = await runCheckFirst<object, { status: 'profit'; usd: number }>({
      now: () => Date.now(), mark: () => {},
      trigFirst: async () => { const o = await tp; return o.sure ? { status: 'profit', usd: 1 } : null; },
      hasBuilt: true, copy2Running: () => true, copy2Deciding: () => true,
      copy2WaitForTx: async () => { order.push('copy2WaitForTx'); return 101; },
      copy2Route: () => ({ at: { block: '0x65' } }),
      startFast: () => { order.push('fast'); return {}; },
      fastDecide: async () => ({ status: 'profit', usd: 2 }),
      waitForTrade: async () => { order.push('waitForTrade'); return true; },
      nodeCheck: async () => ({ status: 'profit', usd: 3 }),
      noNode: () => {},
    });
    assert(run.decidedBy === 'local' && order.join() === 'copy2WaitForTx,fast', 'trigger-first unknown -> copy 2 path exactly as before');
    const s = tf.takeHourLine() ?? '';
    assert(/unknown/.test(s) || /answered 0/.test(s), `unknown counted in the hour line: ${s}`);
  }
  // Shadow: never decides; the existing path decides and its time is noted.
  {
    const { client } = fakeClient(profitAnswer(9n));
    const { tf, file, log } = mk({ LOCAL_SIM_TRIGGER_FIRST: 'shadow' }, client, fakeCopy2(), true);
    void tf.check(q);
    const run = await runCheckFirst<object, { status: 'profit'; usd: number }>({
      now: () => Date.now(), mark: () => {},
      trigFirst: tf.decides() ? async () => ({ status: 'profit', usd: 1 }) : null,
      hasBuilt: false, copy2Running: () => false, copy2Deciding: () => false,
      copy2WaitForTx: async () => 1, copy2Route: () => null, startFast: () => null, fastDecide: async () => null,
      waitForTrade: async () => { await sleep(20); return true; },
      nodeCheck: async () => ({ status: 'profit', usd: 3 }),
      noNode: () => {},
    });
    tf.noteExisting(q.triggerHash, Date.now(), 'send (profit)');
    assert(run.decidedBy === 'node', 'shadow: the existing path decided');
    await sleep(80);
    tf.finish(q.triggerHash.toLowerCase());
    await log.flush();
    const rec = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.k === 'trig_first');
    assert(rec?.mode === 'shadow' && rec?.dec === undefined && rec?.exV === 'send (profit)' && typeof rec?.earlierMs === 'number' && rec.earlierMs >= 0, 'shadow line: never decided, the existing path\'s verdict and how much later it decided');
  }

  // ---- BEST EFFORT: what is asked, confidence, gating (Oct 23) ----------------------
  const withConf = (conf?: string, assumed?: string[]) => (m: Asked): Asked => {
    const a = profitAnswer(2_000_000_000_000_000n)(m);
    if (a.trig && conf) a.trig = { ...a.trig, conf, assumed, skipped: (assumed ?? []).reduce((n, x) => n + (x.startsWith('skipped') ? Number(x.split(':')[1] ?? 1) : 0), 0) };
    return a;
  };
  {
    const v4id = '0x' + 'ab'.repeat(32);
    const { client, asked } = fakeClient(withConf('medium', ['sender_funds']));
    const { tf } = mk({ LOCAL_SIM_TRIGGER_FIRST: 'shadow' }, client, fakeCopy2());
    const out = await tf.check({ ...q, keys: [pool, v4id, null, 'garbage'] });
    const sent = asked.find((m) => m.feed)!;
    assert(sent.feed.route.join() === [pool, v4id].join(), 'the route pools (addresses and V4 pool ids) go with the question');
    assert(sent.feed.strict === false && sent.feed.assume.join() === 'sender_funds,recent_fill,skip', 'default: every assumption allowed');
    assert(out.sure && out.confidence === 'medium' && out.assumptions?.join() === 'sender_funds', 'the answer\'s confidence and assumptions are kept');
  }
  {
    const { client, asked } = fakeClient(withConf());
    let { tf } = mk({ LOCAL_SIM_TRIGGER_FIRST: 'shadow', TRIG_FIRST_STRICT: '1' }, client, fakeCopy2());
    let out = await tf.check(q);
    assert(asked[0].feed.strict === true && asked[0].feed.assume.length === 0, 'TRIG_FIRST_STRICT=1: no assumptions asked for');
    assert(out.confidence === 'high' && out.assumptions?.length === 0, 'an answer without confidence (exact / older fast check) = high');
    ({ tf } = mk({ LOCAL_SIM_TRIGGER_FIRST: 'shadow', TRIG_FIRST_ASSUME: 'recent_fill, bogus' }, client, fakeCopy2()));
    out = await tf.check(q);
    assert(asked[1].feed.assume.join() === 'recent_fill', 'TRIG_FIRST_ASSUME picks which assumptions are allowed');
  }
  {
    // Confidence floor (on mode): default medium.
    const { client } = fakeClient(withConf('low', ['skipped_related:1']));
    const { tf } = mk({ LOCAL_SIM_TRIGGER_FIRST: 'on' }, client, fakeCopy2(), true);
    const low = await tf.check(q);
    assert(/confidence low below TRIG_FIRST_MIN_CONFIDENCE=medium/.test(tf.sendGate(low) ?? ''), 'low answer: not allowed to send (default floor medium)');
    assert(tf.sendGate({ ...low, confidence: 'medium' }) === null && tf.sendGate({ ...low, confidence: 'high' }) === null, 'medium and high may send');
    assert(tf.sendGate({ ...low, sure: false, why: 'miss' }) !== null, 'unknown never sends');
    const hi = mk({ LOCAL_SIM_TRIGGER_FIRST: 'on', TRIG_FIRST_MIN_CONFIDENCE: 'high' }, client, fakeCopy2(), true).tf;
    assert(hi.sendGate({ ...low, confidence: 'medium' }) !== null && hi.sendGate({ ...low, confidence: 'high' }) === null, 'TRIG_FIRST_MIN_CONFIDENCE=high: only exact answers send');
    const lo = mk({ LOCAL_SIM_TRIGGER_FIRST: 'on', TRIG_FIRST_MIN_CONFIDENCE: 'low' }, client, fakeCopy2(), true).tf;
    assert(lo.sendGate(low) === null, 'TRIG_FIRST_MIN_CONFIDENCE=low: everything sure sends');
    // In the check-first order: a held-back answer -> the existing path, unchanged.
    const tp = tf.check(q);
    const order: string[] = [];
    const run = await runCheckFirst<object, { status: 'profit'; usd: number }>({
      now: () => Date.now(), mark: () => {},
      trigFirst: async () => { const o = await tp; if (tf.sendGate(o)) return null; tf.noteDecided(q.triggerHash); return { status: 'profit', usd: 4 }; },
      hasBuilt: true, copy2Running: () => true, copy2Deciding: () => true,
      copy2WaitForTx: async () => { order.push('copy2WaitForTx'); return 101; },
      copy2Route: () => ({ at: { block: '0x65' } }),
      startFast: () => { order.push('fast'); return {}; },
      fastDecide: async () => ({ status: 'profit', usd: 2 }),
      waitForTrade: async () => true, nodeCheck: async () => ({ status: 'profit', usd: 3 }), noNode: () => {},
    });
    assert(run.decidedBy === 'local' && order.join() === 'copy2WaitForTx,fast', 'a low-confidence answer goes to the existing path (copy 2), unchanged');
    const line = tf.takeHourLine() ?? '';
    assert(/confidence high 0, medium 0, low 2/.test(line) && /held back by the confidence floor \(medium\) /.test(line), `hour line counts confidence and held-back answers: ${line}`);
  }
  {
    // Shadow logs every level, with the later re-check split by confidence / assumption.
    const { client } = fakeClient(withConf('medium', ['sender_funds', 'skipped_unrelated:2']));
    const { tf, file, log } = mk({ LOCAL_SIM_TRIGGER_FIRST: 'shadow' }, client, fakeCopy2(), true);
    await tf.check(q);
    await sleep(80);
    tf.finish(q.triggerHash.toLowerCase());
    await log.flush();
    const rec = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.k === 'trig_first');
    assert(rec?.conf === 'medium' && rec?.as?.join() === 'sender_funds,skipped_unrelated:2' && rec?.skp === 2 && rec?.agree === true, `log line: conf, assumptions, skipped count, and the later agreement: ${JSON.stringify(rec)}`);
    const line = tf.takeHourLine() ?? '';
    assert(/agree by confidence: medium 1\/1; by assumption: (sender_funds 1\/1, skipped_unrelated 1\/1|skipped_unrelated 1\/1, sender_funds 1\/1)/.test(line), `agreement split by confidence and assumption: ${line}`);
  }
  {
    // Scoreboard step back: trigger-first stops deciding until then.
    const { client } = fakeClient(withConf());
    const { tf } = mk({ LOCAL_SIM_TRIGGER_FIRST: 'on' }, client, fakeCopy2(), true);
    assert(tf.decides(), 'on + fast check ON: decides');
    tf.stepBack(Date.now() + 60_000, 'test');
    assert(!tf.decides() && tf.steppedBackUntil() > 0, 'stepped back: practice only');
    await tf.check(q);
    assert(/STEPPED BACK/.test(tf.takeHourLine() ?? ''), 'shown in the hour line');
  }
}

main().catch((e) => { console.error('FAIL: crashed', e); process.exitCode = 1; });
