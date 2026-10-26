// FEED HELPER THREAD (FEED_WORKER, Oct 26). Plain English: with FEED_WORKER=1
// the Robinhood feed is read by a helper thread instead of the main thread.
// This test checks:
//   1. the switch: off unless FEED_WORKER=1 (default = the old code path);
//   2. the helper's packages turn back into EXACTLY the objects the old
//      in-thread code makes (order buffer list and trade decoder list:
//      hashes, raw bytes, sequence numbers, transaction order, senders),
//      also for repeats, broken messages and FEED_SKIP_REPEATS=0;
//   3. end to end with a real helper thread and a local test feed: the bot
//      sees the same fast-check text, order buffer messages and trade events
//      as with the old way, with sensible recv / parsed timings;
//   4. a crashed helper is logged, the feed counts as down, a fresh helper
//      is started and the feed works again after the next connect;
//   5. a helper that can't start at all: after 3 tries the old way is used.
import { join } from 'path';
import { Wallet, ethers, encodeRlp, toBeHex } from 'ethers';
import { WebSocketServer, WebSocket as WsClient } from 'ws';
import { parseFeedFrame, parseFeedMessages, maxSequenceNumber, FeedMsg, clearFeedTxMemo } from '../chains/nitroFeed';
import { feedWorkerEnabled, packFeedFrame, unpackFeedMsgs, unpackFeedTxs, toMainHr, absNow, FeedWorkerState } from '../chains/feedWorkerShared';
import { RobinhoodChainAdapter } from '../chains/robinhoodChain';
import type { RawChainEvent } from '../core/types';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await sleep(10); }
  return cond();
}

// ---- Fixture feed messages (packed exactly the way the Nitro feed does) ----
const ROUTER = '0x89e5db8b5aa49aa85ac63f691524311aeb649eba';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const iface = new ethers.Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline)']);
function batchEntry(msg: Buffer): Buffer { const len = Buffer.alloc(8); len.writeBigUInt64BE(BigInt(msg.length)); return Buffer.concat([len, msg]); }
const signedTxMsg = (raw: string) => Buffer.concat([Buffer.from([4]), Buffer.from(raw.slice(2), 'hex')]);
const batchOf = (parts: Buffer[]) => Buffer.concat([Buffer.from([3]), ...parts.map(batchEntry)]);
const msgOf = (seq: number, l2: Buffer, kind = 3) => ({ sequenceNumber: seq, message: { message: { header: { kind, timestamp: 1_700_000_000 + seq, blockNumber: 9000 + seq }, l2Msg: l2.toString('base64') }, delayedMessagesRead: 1 } });
const frame = (msgs: unknown[]) => JSON.stringify({ version: 1, messages: msgs });

async function fixtures(): Promise<string[]> {
  const w = Wallet.createRandom();
  const w2 = Wallet.createRandom();
  const swaps: string[] = [];
  for (let i = 0; i < 12; i++) {
    const data = iface.encodeFunctionData('execute', ['0x0b08', ['0x' + 'ab'.repeat(200 + i), '0x' + 'cd'.repeat(300)], 9_999_999_999n]);
    swaps.push(await (i % 2 ? w : w2).signTransaction({ type: 2, chainId: 4663, nonce: i, to: ROUTER, data, value: BigInt(i), gasLimit: 400_000, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 0n }));
  }
  const legacy = await w.signTransaction({ type: 0, chainId: 4663, nonce: 50, to: USDG, data: '0xa9059cbb' + '00'.repeat(64), gasLimit: 60_000, gasPrice: 10n ** 9n });
  const transfer = await w.signTransaction({ type: 2, chainId: 4663, nonce: 51, to: w2.address, value: 1n, gasLimit: 21_000, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 0n });
  // Type 2 with a non-empty access list (light read is "not sure": ethers decides).
  const withAl = await w.signTransaction({ type: 2, chainId: 4663, nonce: 52, to: ROUTER, data: '0x12345678', gasLimit: 90_000, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 0n, accessList: [{ address: USDG, storageKeys: ['0x' + '00'.repeat(32)] }] });
  // Priority fee above max fee (Robinhood accepts it; ethers throws from tx.hash).
  const odd = '0x02' + encodeRlp([toBeHex(4663), '0x01', toBeHex(5_000_000_000n), toBeHex(1_000_000n), toBeHex(300_000), '0x' + '22'.repeat(20), '0x', '0x12345678', [], '0x01', '0x' + '33'.repeat(32), '0x' + '44'.repeat(32)]).slice(2);
  const s = swaps.map(signedTxMsg);
  return [
    frame([msgOf(100, signedTxMsg(swaps[0]!))]),                                            // one swap
    frame([msgOf(101, batchOf([s[1]!, batchOf([signedTxMsg(legacy)]), signedTxMsg(transfer), s[2]!]))]), // batch + nested batch + plain transfer
    frame([msgOf(102, batchOf([s[3]!, s[4]!, s[5]!])), msgOf(103, batchOf([s[6]!, signedTxMsg(withAl)]))]), // two messages in one frame
    frame([msgOf(104, signedTxMsg(odd))]),                                                  // odd but accepted tx
    frame([msgOf(105, signedTxMsg(swaps[7]!), 12)]),                                        // not an L2 message (deposit etc.)
    frame([msgOf(106, Buffer.from([6]))]),                                                  // heartbeat
    frame([msgOf(107, Buffer.from([4, 1, 2, 3]))]),                                         // garbage tx bytes
    frame([msgOf(108, Buffer.concat([Buffer.from([3]), Buffer.from([0, 0, 0, 0, 0, 0, 0, 99, 4, 1])]))]), // truncated batch
    'this is not json',                                                                     // malformed frame
    JSON.stringify({ hello: 'world' }),                                                     // unrelated
    frame([msgOf(101, s[1]!), msgOf(102, s[3]!)]),                                          // reconnect backlog: all repeats
    frame([msgOf(108, s[8]!), msgOf(109, batchOf([s[9]!, s[10]!])), msgOf(110, s[11]!)]),   // half repeat, half new
    frame([msgOf(111, batchOf(s.slice(0, 12)))]),                                           // busy message (same txs again)
  ];
}

// Plain view of a trade decoder list, with the sender read out (it is lazy).
const viewTxs = (txs: ReturnType<typeof parseFeedFrame>) => JSON.stringify(txs.map((t) => ({ ...t, from: t.from })));
const viewEvents = (evs: RawChainEvent[]) => JSON.stringify(evs.map((e) => ({ ...e, raw: { ...(e.raw as any), from: (e.raw as any).from } })));

// The OLD in-thread steps (robinhoodChain.ts before the helper), as a
// reference: order buffer list, repeat check, trade decoder list.
function oldWay(texts: string[], skipRepeats = true) {
  let last = 0;
  const out: Array<{ msgs: FeedMsg[] | null; txs: string }> = [];
  for (const text of texts) {
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { out.push({ msgs: null, txs: 'bad' }); continue; }
    const msgs = parseFeedMessages(parsed, skipRepeats ? last : undefined);
    const seq = maxSequenceNumber(parsed);
    if (seq !== null) { if (seq <= last) { out.push({ msgs, txs: 'repeat' }); continue; } last = seq; }
    out.push({ msgs, txs: viewTxs(parseFeedFrame(parsed)) });
  }
  return out;
}
function newWay(texts: string[]) {
  const st: FeedWorkerState = { lastSeq: 0 };
  return texts.map((text) => {
    const p = packFeedFrame(text, st, { c: 1, at: Date.now(), recvAbs: absNow(), wantText: true, wantMsgs: true });
    // The package must survive the copy between threads unchanged.
    const q = structuredClone(p);
    if (q.bad) return { msgs: null, txs: 'bad', text: q.text };
    return { msgs: unpackFeedMsgs(q), txs: q.repeat ? 'repeat' : viewTxs(unpackFeedTxs(q)), text: q.text };
  });
}

async function sameObjects(texts: string[]) {
  // 1. Switch.
  assert(feedWorkerEnabled({}) === false && feedWorkerEnabled({ FEED_WORKER: '0' }) === false && feedWorkerEnabled({ FEED_WORKER: '' }) === false, 'FEED_WORKER missing / 0: off (default, the old way)');
  assert(feedWorkerEnabled({ FEED_WORKER: '1' }) === true && feedWorkerEnabled({ FEED_WORKER: 'on' }) === true, 'FEED_WORKER=1 / on: helper thread');
  const prev = process.env.FEED_WORKER;
  delete process.env.FEED_WORKER;
  const def = new RobinhoodChainAdapter({ log: () => undefined });
  assert(def.feedWorkerActive === false, 'adapter with no setting: old in-thread way, no helper thread');
  if (prev !== undefined) process.env.FEED_WORKER = prev;

  // 2. Same objects, first pass (nothing remembered) and again (remembered).
  for (const pass of ['first', 'second']) {
    if (pass === 'first') clearFeedTxMemo();
    const a = oldWay(texts);
    clearFeedTxMemo();
    const b = newWay(texts);
    let same = a.length === b.length;
    for (let i = 0; i < a.length && same; i++) {
      if (JSON.stringify(a[i]!.msgs) !== JSON.stringify(b[i]!.msgs)) { same = false; console.error(`  frame ${i}: order buffer list differs`); }
      if (a[i]!.txs !== b[i]!.txs) { same = false; console.error(`  frame ${i}: trade list differs`); }
      if (b[i]!.text !== texts[i]) { same = false; console.error(`  frame ${i}: raw text differs`); }
    }
    assert(same, `${pass} pass: helper packages give exactly the old order buffer messages, trade list and raw text (${texts.length} frames)`);
  }
  const counts = oldWay(texts);
  const nMsgTx = counts.reduce((s, x) => s + (x.msgs ?? []).reduce((t, m) => t + m.txs.length, 0), 0);
  assert(nMsgTx >= 20 && counts.some((x) => x.txs === 'repeat') && counts.some((x) => x.msgs?.some((m) => !m.complete)), `fixtures cover transactions (${nMsgTx}), repeats and incomplete messages`);

  // FEED_SKIP_REPEATS=0 and FEED_LAZY_SENDER=0 (read in the helper too).
  process.env.FEED_SKIP_REPEATS = '0';
  process.env.FEED_LAZY_SENDER = '0';
  const a0 = oldWay(texts, false), b0 = newWay(texts);
  delete process.env.FEED_SKIP_REPEATS; delete process.env.FEED_LAZY_SENDER;
  assert(a0.every((x, i) => JSON.stringify(x.msgs) === JSON.stringify(b0[i]!.msgs) && x.txs === b0[i]!.txs), 'FEED_SKIP_REPEATS=0 / FEED_LAZY_SENDER=0: still exactly the same');

  // Not wanted = not sent (no raw text without the fast check, no order buffer list without its tap).
  const p = packFeedFrame(texts[2]!, { lastSeq: 0 }, { c: 1, at: 0, recvAbs: 0, wantText: false, wantMsgs: false });
  assert(p.text === undefined && p.m === undefined && (p.f?.tx.length ?? 0) === 5, 'extras only when wanted; each tx text sent once per package');
  const p2 = packFeedFrame(texts[2]!, { lastSeq: 0 }, { c: 1, at: 0, recvAbs: 0, wantText: false, wantMsgs: true });
  assert(p2.raws.length === 5 && p2.m!.tx.length === 5 && p2.f!.tx.length === 5, 'order buffer and trade lists share one copy of each transaction');
}

// ---- A local test feed (a websocket server sending the fixture frames) ----
async function testFeed(): Promise<{ url: string; wss: WebSocketServer; send: (texts: string[]) => void }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: true });
  await new Promise<void>((r) => wss.on('listening', () => r()));
  const port = (wss.address() as any).port;
  return { url: `ws://127.0.0.1:${port}`, wss, send: (texts) => { for (const c of wss.clients) if (c.readyState === WsClient.OPEN) for (const t of texts) c.send(t); } };
}

type Seen = { text: string[]; msgs: FeedMsg[][]; hr: Array<{ recv: number; parsed: number } | undefined>; at: number[]; events: RawChainEvent[] };
function watch(a: RobinhoodChainAdapter): Seen {
  const s: Seen = { text: [], msgs: [], hr: [], at: [], events: [] };
  a.setRawFrameTap((t) => s.text.push(t));
  a.setFeedMsgTap((m, at, hr) => { s.msgs.push(m); s.at.push(at); s.hr.push(hr); });
  a.onEvent((e) => s.events.push(e));
  return s;
}

const entry = join(__dirname, '..', 'chains', 'feedWorkerEntry.js');

async function endToEnd(texts: string[]) {
  const feed = await testFeed();
  const logs: string[] = [];
  const quiet = { log: (l: string) => logs.push(l), warn: (l: string) => logs.push(l) };
  const oldA = new RobinhoodChainAdapter({ feedUrl: feed.url, feedWorker: false, ...quiet });
  const newA = new RobinhoodChainAdapter({ feedUrl: feed.url, feedWorker: true, workerEntry: entry, workerRestartDelaysMs: [200, 200, 200], ...quiet });
  const so = watch(oldA), sn = watch(newA);
  await oldA.connect();
  await newA.connect();
  assert(newA.feedWorkerActive && (await newA.healthCheck()).healthy, 'helper thread: connected through it, health check says healthy');
  // Both adapters get the same frames; the "half repeat" frame is after the backlog.
  const half = Math.floor(texts.length / 2);
  const before = absNow();
  feed.send(texts.slice(0, half));
  await sleep(50);
  feed.send(texts.slice(half));
  const nEv = await waitFor(() => sn.text.length === texts.length && so.text.length === texts.length && sn.events.length === so.events.length && sn.events.length > 0, 5_000);
  assert(nEv, `every frame arrived both ways (${so.text.length} / ${sn.text.length} frames)`);
  assert(JSON.stringify(so.text) === JSON.stringify(sn.text), 'fast-check hand-off: same raw text, same order');
  assert(JSON.stringify(so.msgs) === JSON.stringify(sn.msgs), `order buffer + trigger entry point: same messages (${sn.msgs.length} calls, hashes, raw, seq, tx order)`);
  // receivedAtMs differs (each adapter's own arrival time); everything else must match.
  const strip = (e: RawChainEvent[]) => e.map((x) => ({ ...x, receivedAtMs: 0 }));
  assert(viewEvents(strip(so.events)) === viewEvents(strip(sn.events)), `trade decoder events: same (${sn.events.length} events, incl. senders)`);
  const hrOk = sn.hr.every((h) => !!h && h.recv >= toMainHr(before) - 1 && h.recv <= h.parsed + 0.001 && h.parsed <= performance.now());
  assert(hrOk, 'recv / parsed timings: on the main thread clock, recv (in the helper) before parsed (main has the messages)');
  assert(sn.at.every((t) => Math.abs(t - Date.now()) < 10_000), 'receivedAtMs: a normal wall-clock time');
  const ld = sn.hr.map((h) => h!.parsed - h!.recv).sort((x, y) => x - y);
  console.log(`  (info) helper recv -> main has messages: p50 ${ld[Math.floor(ld.length / 2)]?.toFixed(2)} ms, max ${ld[ld.length - 1]?.toFixed(2)} ms`);

  // ---- 4. Crash: logged, feed down, fresh helper, works after reconnect ----
  newA.crashFeedWorkerForTest();
  const down = await waitFor(() => newA.workerCrashes === 1, 3_000);
  assert(down && !(await newA.healthCheck()).healthy, 'helper crashed: counted, health check says the feed is down (chainManager reconnects)');
  assert(logs.some((l) => /feed helper thread .*starting a fresh one/.test(l)), 'helper crash is logged');
  const restarted = await waitFor(() => newA.workerStarts === 2, 3_000);
  assert(restarted, 'a fresh helper thread is started after the pause');
  await newA.connect(); // what chainManager does on its next health check
  assert((await newA.healthCheck()).healthy, 'reconnected through the fresh helper');
  const evBefore = sn.events.length, oldBefore = so.events.length;
  // Backlog replay (repeats, nothing new) then one new message.
  feed.send(texts);
  const l2 = Buffer.from(JSON.parse(texts[0]!).messages[0].message.message.l2Msg, 'base64');
  const more = [200, 201, 202].map((seq) => frame([msgOf(seq, l2)]));
  feed.send(more);
  await waitFor(() => sn.events.length - evBefore >= 3 && so.events.length - oldBefore >= 3, 3_000);
  assert(sn.events.length - evBefore === so.events.length - oldBefore && sn.events.length - evBefore === 3, `after the restart: repeats skipped, new messages decoded (${sn.events.length - evBefore} new events, old way ${so.events.length - oldBefore})`);
  assert(JSON.stringify(so.msgs.slice(-3)) === JSON.stringify(sn.msgs.slice(-3)), 'after the restart: order buffer still the same as the old way (last-seen sequence number carried over)');

  // ---- Feed server goes away: closed, unhealthy, reconnect fails cleanly ----
  for (const c of feed.wss.clients) c.terminate();
  await waitFor(() => logs.filter((l) => l.includes('feed closed')).length >= 1, 2_000);
  assert(!(await newA.healthCheck()).healthy, 'socket closed by the feed: health check says down');
  await new Promise<void>((r) => feed.wss.close(() => r()));
  let failed = false;
  try { await newA.connect(); } catch { failed = true; }
  assert(failed, 'connect to a dead feed fails (rejects) instead of hanging; chainManager backs off as before');

  await newA.disconnect(); await oldA.disconnect();
}

async function startFails() {
  const warns: string[] = [];
  const a = new RobinhoodChainAdapter({ feedUrl: 'ws://127.0.0.1:9', feedWorker: true, workerEntry: join(__dirname, 'no-such-helper.js'), workerRestartDelaysMs: [50, 50, 50], log: () => undefined, warn: (l) => warns.push(l) });
  let rejected = 0;
  for (let i = 0; i < 3; i++) { try { await a.connect(); } catch { rejected++; } await sleep(120); }
  await waitFor(() => !a.feedWorkerActive, 3_000);
  assert(!a.feedWorkerActive && warns.some((l) => l.includes('read on the main thread again')), `helper can't start 3 times: back to the old in-thread way, logged (connect failures ${rejected})`);
  await a.disconnect();
}

async function main() {
  const texts = await fixtures();
  await sameObjects(texts);
  await endToEnd(texts);
  await startFails();
}

main().catch((err) => { console.error('FAIL: test crashed', err); process.exitCode = 1; });
