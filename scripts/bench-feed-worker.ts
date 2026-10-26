// ============================================================================
// FEED HELPER THREAD BENCHMARK (FEED_WORKER, Oct 26). Synthetic, TEST numbers.
//
// Plain English:
//   How much MAIN-THREAD time one Robinhood feed message costs, the old way
//   (FEED_WORKER=0) vs with the helper thread (FEED_WORKER=1), for a quiet
//   message (3 swaps) and a busy one (40 swaps, ~1 KB each).
//     old way, on the main thread: un-zip (permessage-deflate) + text + JSON
//       + order buffer list (hashes) + trade decoder list (light read)
//     helper, on the main thread: receive the helper's package (the copy
//       between threads, done with a real MessageChannel) + rebuild the
//       same objects. The helper's own time is shown too (not main thread).
//   The websocket's own receive work (network, frame handling) moves too
//   but is not counted here, so the real saving is a bit bigger.
//
// Run: npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/bench-feed-worker.js
// ============================================================================
import { MessageChannel, receiveMessageOnPort } from 'worker_threads';
import { deflateRawSync, inflateRawSync } from 'zlib';
import { Wallet, ethers } from 'ethers';
import { parseFeedFrame, parseFeedMessages, maxSequenceNumber, clearFeedTxMemo } from '../src/chains/nitroFeed';
import { packFeedFrame, unpackFeedMsgs, unpackFeedTxs, absNow, FeedFrameOut } from '../src/chains/feedWorkerShared';

const ROUTER = '0x89e5db8b5aa49aa85ac63f691524311aeb649eba';
const iface = new ethers.Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline)']);
function batchEntry(msg: Buffer): Buffer { const len = Buffer.alloc(8); len.writeBigUInt64BE(BigInt(msg.length)); return Buffer.concat([len, msg]); }
const signedTxMsg = (raw: string) => Buffer.concat([Buffer.from([4]), Buffer.from(raw.slice(2), 'hex')]);

async function swaps(n: number): Promise<string[]> {
  const w = Wallet.createRandom();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const data = iface.encodeFunctionData('execute', ['0x0b08', ['0x' + 'ab'.repeat(320), '0x' + (i.toString(16).padStart(2, '0')).repeat(320)], 9_999_999_999n]);
    out.push(await w.signTransaction({ type: 2, chainId: 4663, nonce: i, to: ROUTER, data, gasLimit: 400_000, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 0n }));
  }
  return out;
}
const frameText = (seq: number, raws: string[]) => JSON.stringify({ version: 1, messages: [{ sequenceNumber: seq, message: { message: { header: { kind: 3, timestamp: 1_700_000_000, blockNumber: 9000 }, l2Msg: Buffer.concat([Buffer.from([3]), ...raws.map(signedTxMsg).map(batchEntry)]).toString('base64') }, delayedMessagesRead: 1 } }] });

// Same tiny per-trade object building in both (the event the decoder gets).
const sink: unknown[] = [];
const emit = (txs: Array<{ to: string; data: string; hash: string; raw: string }>) => { sink.length = 0; for (const t of txs) sink.push({ chain: 'robinhood', raw: { to: t.to, data: t.data, hash: t.hash, rawTx: t.raw } }); };

function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; }

async function bench(label: string, n: number, iters: number) {
  const raws = await swaps(n);
  // Different sequence numbers, so every round is "new" (no repeat skipping).
  const texts = Array.from({ length: iters }, (_, i) => frameText(1_000 + i, raws));
  const zipped = texts.map((t) => deflateRawSync(Buffer.from(t)));
  const kb = (zipped[0]!.length / 1024).toFixed(1), kbText = (Buffer.byteLength(texts[0]!) / 1024).toFixed(1);

  // OLD WAY: everything on the main thread.
  const oldMs: number[] = [], zipMs: number[] = [];
  let last = 0;
  for (let i = 0; i < iters; i++) {
    clearFeedTxMemo(); // each message's transactions are new in real life
    const t0 = performance.now();
    const text = inflateRawSync(zipped[i]!).toString();
    const t1 = performance.now();
    const parsed = JSON.parse(text);
    const msgs = parseFeedMessages(parsed, last);
    const seq = maxSequenceNumber(parsed);
    if (seq !== null) last = seq;
    emit(parseFeedFrame(parsed));
    const t2 = performance.now();
    if (!msgs.length) throw new Error('bench: no messages');
    zipMs.push(t1 - t0); oldMs.push(t2 - t0);
  }

  // HELPER: the helper's part (un-zip + pack + send) vs the main thread's part
  // (receive the package + rebuild + same event building).
  const { port1, port2 } = new MessageChannel();
  const st = { lastSeq: 0 };
  const helperMs: number[] = [], mainMs: number[] = [];
  for (let i = 0; i < iters; i++) {
    clearFeedTxMemo();
    const h0 = performance.now();
    const text = inflateRawSync(zipped[i]!).toString();
    const pkg = packFeedFrame(text, st, { c: 1, at: Date.now(), recvAbs: absNow(), wantText: false, wantMsgs: true });
    port1.postMessage(pkg);
    const h1 = performance.now();
    const got = receiveMessageOnPort(port2)!.message as FeedFrameOut;
    const msgs = unpackFeedMsgs(got);
    emit(unpackFeedTxs(got));
    const m1 = performance.now();
    if (!msgs.length) throw new Error('bench: no messages');
    helperMs.push(h1 - h0); mainMs.push(m1 - h1);
  }
  port1.close(); port2.close();
  // With the fast check on (LOCAL_SIM), the raw text is also handed over.
  const textMs: number[] = [];
  { const { port1: a, port2: b } = new MessageChannel(); for (let i = 0; i < iters; i++) { a.postMessage(texts[i]); const t = performance.now(); receiveMessageOnPort(b); textMs.push(performance.now() - t); } a.close(); b.close(); }

  const o = median(oldMs), m = median(mainMs);
  console.log(`${label} (${n} swaps, ${kbText} KB text, ${kb} KB zipped), median of ${iters}:`);
  console.log(`  old way, main thread:   ${o.toFixed(3)} ms per message (of which un-zip ${median(zipMs).toFixed(3)} ms)`);
  console.log(`  helper,  main thread:   ${m.toFixed(3)} ms per message (+${median(textMs).toFixed(3)} ms when the fast check gets the raw text)`);
  console.log(`  helper,  helper thread: ${median(helperMs).toFixed(3)} ms per message (off the main thread)`);
  console.log(`  main thread saving:     ${(o - m).toFixed(3)} ms per message (${(100 * (1 - m / o)).toFixed(0)}% less)`);
}

async function main() {
  // Warm up (JIT), then measure.
  await bench('warm-up', 5, 50);
  console.log('---');
  await bench('quiet message', 3, 400);
  await bench('busy message', 40, 200);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
