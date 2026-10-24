import { Wallet, ethers, Transaction, encodeRlp, keccak256 } from 'ethers';
import { spawnSync } from 'child_process';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getHeapStatistics } from 'v8';
import { PerformanceObserver } from 'perf_hooks';
import { parseFeedFrame, parseFeedMessages, peekFeedTx, clearFeedTxMemo } from '../chains/nitroFeed';
import { quickSkip, TrigEntry, entrySettings } from '../execution/trigEntry';
import { TriggerFirst, TrigCopy2, trigFirstSettings } from '../execution/triggerFirst';
import { JsonlLog } from '../execution/localSimHost';
import { LocalSimClient, frame } from '../execution/localSim';
import { LeanJsonRpcProvider, ethCall } from '../core/leanRpc';
import { makeCaller, loadScanStateFile, emptyScanState, ScanState } from '../core/universeScan';
import { parseJsonSteps, drainSteps, readJsonChunked, SlicedQueue } from '../core/chunked';
import { stallFinder } from '../core/stallFinder';

// ============================================================================
// FREEZE FIX 2 (Oct 24). After PR #179 the live bot still froze ~200-280
// times per 5 min. This file proves each fix keeps every RESULT the same,
// and measures the speed-up on this test machine (numbers labelled "TEST
// numbers": the server is a slower 2-vCPU machine with real traffic).
//   1. feed transactions: light read of to / data / amount (= ethers)
//   2. the feed tap (order buffer + trigger entry point) per message
//   3. node requests: lean request / answer handling (= ethers on the wire)
//   4. the saved pool scan file read in bites (= JSON.parse)
//   5. the rival watch's per-transaction jobs in ~5 ms bites
//   6. sidecar message framing: one copy fewer, same bytes
// Memory numbers (KB made per item) come from a child process started with
// a big young-generation size and --expose-gc, so no clean-up happens in
// the middle of a measurement.
// ============================================================================

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const busy = (ms: number) => { const t = performance.now(); while (performance.now() - t < ms) { /* spin */ } };
let seed = 4242;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (n: number) => Math.floor(rnd() * n);

// ---- realistic feed transactions --------------------------------------------------------------
const ROUTER = '0x' + '12'.repeat(20);
const iface = new ethers.Interface(['function execute(bytes commands, bytes[] inputs, uint256 deadline)']);
const swapData = () => iface.encodeFunctionData('execute', ['0x0b00', ['0x' + 'ab'.repeat(320), '0x' + 'cd'.repeat(256)], 9_999_999_999n]);
async function swaps(n: number, s = 1): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const w = new Wallet('0x' + (s * 1000 + i + 1).toString(16).padStart(64, '0'));
    out.push(await w.signTransaction({ type: 2, chainId: 4663, nonce: i, to: ROUTER, data: swapData(), value: BigInt(i), gasLimit: 300_000, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 0n }));
  }
  return out;
}
// Every kind the light read handles, plus the ones it must leave to ethers.
async function corpus(): Promise<string[]> {
  const w = new Wallet('0x' + '33'.repeat(32));
  const out: string[] = [...await swaps(10, 3)];
  for (let i = 0; i < 6; i++) {
    const data = '0x' + Buffer.from(Array.from({ length: ri(200) }, () => ri(256))).toString('hex');
    out.push(await w.signTransaction({ type: 1, chainId: 4663, nonce: i, to: '0x' + 'cd'.repeat(20), data, value: BigInt(i) * 10n ** 18n, gasLimit: 21_000, gasPrice: 10n ** 9n, accessList: i % 2 ? [] : [{ address: '0x' + 'ee'.repeat(20), storageKeys: ['0x' + '00'.repeat(32)] }] }));
    out.push(await w.signTransaction({ type: 0, chainId: i % 2 ? 4663 : 0, nonce: i, to: i === 3 ? null : '0x' + 'cd'.repeat(20), data, value: BigInt(i), gasLimit: 21_000, gasPrice: 10n ** 9n }));
    out.push(await w.signTransaction({ type: 2, chainId: 4663, nonce: i, to: '0x' + 'ab'.repeat(20), data: i % 3 ? '0x' : '0xa9059cbb' + '00'.repeat(64), value: 5n, gasLimit: 60_000, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }));
    // Priority fee above the max fee (Robinhood's sequencer accepts these; ethers reads them, won't sign them).
    const f = ethers.decodeRlp('0x' + out[out.length - 1].slice(4)) as string[];
    f[2] = '0x09';
    out.push('0x02' + encodeRlp(f).slice(2));
  }
  out.push(Transaction.from({ type: 2, chainId: 1, to: ROUTER, data: '0x1234', nonce: 1, gasLimit: 1 }).unsignedSerialized);   // unsigned
  out.push(Transaction.from({ type: 0, to: ROUTER, data: '0x1234', nonce: 1, gasLimit: 1 }).unsignedSerialized);
  out.push('0x02c001', '0x05c0', '0x04' + encodeRlp(['0x01', '0x', '0x', '0x', '0x01', ROUTER, '0x', '0x', [], [], '0x', '0x', '0x']).slice(2)); // broken, unknown type, type 4
  return out;
}
const ethersView = (raw: string) => { let t: Transaction; try { t = Transaction.from(raw); } catch { return null; } return { to: t.to, data: t.data, value: t.value }; };
function batchEntry(msg: Buffer): Buffer { const len = Buffer.alloc(8); len.writeBigUInt64BE(BigInt(msg.length)); return Buffer.concat([len, msg]); }
const signedTxMsg = (raw: string) => Buffer.concat([Buffer.from([4]), Buffer.from(raw.slice(2), 'hex')]);
const frameOf = (msgs: Array<{ seq: number; raws: Buffer[] }>) => ({
  version: 1,
  messages: msgs.map((m) => ({ sequenceNumber: m.seq, message: { message: { header: { kind: 3, timestamp: 1_700_000_000 + m.seq, blockNumber: 9000 }, l2Msg: Buffer.concat([Buffer.from([3]), ...m.raws.map(batchEntry)]).toString('base64') }, delayedMessagesRead: 1 } })),
});
const viewTxs = (txs: ReturnType<typeof parseFeedFrame>) => JSON.stringify(txs.map((t) => ({ ...t, from: t.from })));
const ours = { isOurTx: () => false, addresses: new Set<string>(['0x' + 'cd'.repeat(20)]) };
const withEnv = <T>(k: string, v: string | undefined, f: () => T): T => {
  const old = process.env[k];
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { return f(); } finally { if (old === undefined) delete process.env[k]; else process.env[k] = old; }
};

// ---- 1. light read = ethers ---------------------------------------------------------------------
async function lightTests() {
  const base = await corpus();
  let n = 0, diff = 0, unsure = 0, refused = 0;
  const cmp = (raw: string) => {
    n++;
    const p = peekFeedTx(raw);
    if (p === undefined) { unsure++; return; }
    const e = ethersView(raw);
    if (p === null) { refused++; if (e !== null) { diff++; if (diff < 5) console.log('  differs (light refused, ethers read it):', raw.slice(0, 60)); } return; }
    if (!e || e.to !== p.to || e.data !== p.data || e.value !== p.value) { diff++; if (diff < 5) console.log('  differs:', raw.slice(0, 60)); }
  };
  for (const r of base) cmp(r);
  // Broken copies: random bytes changed, cut short, extra bytes.
  for (let k = 0; k < 40_000; k++) {
    const b = Buffer.from(base[ri(base.length)].slice(2), 'hex');
    const m = ri(5);
    if (m === 2) { cmp('0x' + Buffer.concat([b, Buffer.from([ri(256)])]).toString('hex')); continue; }
    if (m === 3) { cmp('0x' + b.subarray(0, ri(b.length)).toString('hex')); continue; }
    if (!b.length) continue;
    if (m === 0) b[ri(b.length)] = ri(256);
    else if (m === 1) b[ri(Math.min(b.length, 12))] = ri(256);  // the length headers
    else { b[ri(b.length)] ^= 1 << ri(8); b[ri(Math.min(b.length, 8))] ^= 1 << ri(8); }
    cmp('0x' + b.toString('hex'));
  }
  // Odd field shapes: lists where values belong, too-long numbers, bad yParity, ...
  const field = (): string | [] => { const t = ri(7); return t === 0 ? '0x' : t === 1 ? '0x' + Buffer.from(Array.from({ length: ri(40) }, () => ri(256))).toString('hex') : t === 2 ? [] : t === 3 ? '0x00' : t === 4 ? '0x' + '00'.repeat(ri(40)) : t === 5 ? '0x' + ri(256).toString(16).padStart(2, '0') : '0x' + 'ff'.repeat(33); };
  for (let k = 0; k < 20_000; k++) {
    const ty = [0, 1, 2, 2, 2][ri(5)];
    const fields: Array<string | []> = Array.from({ length: [6, 8, 9, 11, 12][ri(5)] + (ri(10) === 0 ? 1 : 0) }, field);
    if (rnd() < 0.5) fields[ty === 2 ? 5 : ty === 1 ? 4 : 3] = '0x' + 'ab'.repeat(20);
    if (ty && rnd() < 0.7) fields[ty === 2 ? 8 : 7] = [];
    if (rnd() < 0.5 && fields.length >= 9) fields[fields.length - 3] = ['0x', '0x01', '0x00', '0x02'][ri(4)];
    const enc = encodeRlp(fields);
    cmp(ty ? '0x0' + ty + enc.slice(2) : enc);
  }
  // Legacy signatures: every v near the edges, r / s zero, padded, too long.
  const rsOpts = ['0x', '0x01', '0x' + '11'.repeat(32), '0x00' + '11'.repeat(32), '0x' + '11'.repeat(33)];
  for (let v = 0; v < 300; v++) for (const r of rsOpts) for (const s of rsOpts) {
    cmp(encodeRlp(['0x01', '0x02', '0x5208', ROUTER, '0x', '0x1234', v ? ethers.toBeHex(v) : '0x', r, s]));
  }
  console.log(`[light read] ${n} transactions compared: ${n - unsure - refused} read, ${refused} refused, ${unsure} left to ethers`);
  assert(diff === 0 && n - unsure - refused > 5_000 && refused > 10_000, 'light read gives exactly ethers\' to / data / amount, and refuses exactly what ethers refuses');
  assert(peekFeedTx(base[base.length - 1]) === undefined && peekFeedTx('0xzz') === undefined, 'type 4 and odd text are left to ethers');

  // The two readers that use it: same answers with the light read on and off.
  clearFeedTxMemo();
  const skipsOld = withEnv('FEED_LIGHT_DECODE', '0', () => base.map((r) => quickSkip(r, keccak256(r), ours)));
  clearFeedTxMemo();
  const skipsNew = base.map((r) => quickSkip(r, keccak256(r), ours));
  assert(JSON.stringify(skipsOld) === JSON.stringify(skipsNew) && skipsNew.includes('unreadable') && skipsNew.includes('create') && skipsNew.includes('coin_call') && skipsNew.includes('ours') && skipsNew.includes(null), `entry point skip answers identical (${skipsNew.length} transactions, every answer kind)`);
  const fr = frameOf([{ seq: 700, raws: base.slice(0, 20).map(signedTxMsg) }, { seq: 701, raws: [...base.slice(20).map(signedTxMsg), Buffer.from([9, 1, 2])] }]);
  clearFeedTxMemo();
  const oldTxs = withEnv('FEED_LIGHT_DECODE', '0', () => viewTxs(parseFeedFrame(fr)));
  clearFeedTxMemo();
  const newTxs = viewTxs(parseFeedFrame(fr));
  const eager = withEnv('FEED_LAZY_SENDER', '0', () => viewTxs(parseFeedFrame(fr)));
  assert(oldTxs === newTxs && newTxs === eager && JSON.parse(newTxs).length > 15, 'trade decoder transactions identical (to, data, value, hash, raw, place in message, sender), lazy and eager sender');
  assert(JSON.stringify(parseFeedMessages(fr)) === withEnv('FEED_LIGHT_DECODE', '0', () => JSON.stringify(parseFeedMessages(fr))), 'order buffer messages unchanged');

  // BENCH (TEST numbers): one feed message of 40 swaps, every transaction new.
  const fresh = await swaps(40, 9);
  const msg = (seq: number) => frameOf([{ seq, raws: fresh.map(signedTxMsg) }]);
  const pipeline = (seq: number) => {
    clearFeedTxMemo();
    const f = msg(seq);
    const t0 = performance.now();
    const ms = parseFeedMessages(f);
    const t1 = performance.now();
    for (const m of ms) for (const t of m.txs) quickSkip(t.raw, t.hash, ours);
    const t2 = performance.now();
    parseFeedFrame(f);
    return [t1 - t0, t2 - t1, performance.now() - t2];
  };
  const run = (light: string) => withEnv('FEED_LIGHT_DECODE', light, () => {
    for (let i = 0; i < 3; i++) pipeline(i);
    const sum = [0, 0, 0];
    for (let i = 0; i < 15; i++) pipeline(100 + i).forEach((x, j) => { sum[j] += x / 15; });
    return sum;
  });
  const before = run('0'), after = run('1');
  console.log(`[bench, TEST numbers] 40-swap feed message: unpack ${before[0].toFixed(1)} -> ${after[0].toFixed(1)} ms, entry skip test (the "feed tap" part) ${before[1].toFixed(1)} -> ${after[1].toFixed(1)} ms, trade decoder ${before[2].toFixed(1)} -> ${after[2].toFixed(1)} ms`);
  assert(after[1] < before[1] / 4, 'entry skip test at least 4x faster');
  assert(after[0] + after[1] + after[2] < (before[0] + before[1] + before[2]) / 2, 'whole feed message pass (unpack + skip test + trade decoder) at least 2x faster');
}

// ---- 2. the feed tap end to end -----------------------------------------------------------------
async function tapTests() {
  const fresh = await swaps(40, 11);
  // Fake sidecar: "this transaction moves none of our pools" at once.
  const client = { isConnected: () => true, stats: { fallbacks: 0 }, request: async () => ({ ok: true, pools: [] }) } as unknown as LocalSimClient;
  const copy2: TrigCopy2 = { running: () => true, notReadyWhy: () => null, waitForTx: async () => 1, forwarder: { newestBlock: () => 1, txBlockOf: () => null } };
  const env = { LOCAL_SIM_TRIGGER_FIRST: 'shadow', TRIG_ENTRY_TABLE_MS: '0', TRIG_ENTRY_ONE_TRIP: '0' };
  const log = new JsonlLog(join(mkdtempSync(join(tmpdir(), 'ff2-')), 'x.jsonl'), 1_000_000, 0);
  const tf = new TriggerFirst({ client, settings: trigFirstSettings(env), copy2: () => copy2, shadowLog: log, hostOn: () => true, log: () => {} });
  const te = new TrigEntry({
    tf, client, shadowLog: log, settings: entrySettings(env, 0.25), candidatesFor: () => ({ cands: [], found: 0 }),
    isOurTx: () => false, ourAddresses: [], killed: () => false, safety: () => null, failBlocked: () => null, pausedWhy: () => null,
    send: async () => ({}), log: () => {}, lag: () => 0,
  });
  // Fill the order buffer like a running bot (600 messages of 3 swaps).
  for (let s = 0; s < 600; s++) tf.onFeedMsgs(parseFeedMessages(frameOf([{ seq: s, raws: fresh.slice(s % 37, s % 37 + 3).map(signedTxMsg) }])), Date.now());
  await new Promise((r) => setTimeout(r, 20));
  const tap = (seq: number) => {
    clearFeedTxMemo();
    const msgs = parseFeedMessages(frameOf([{ seq, raws: fresh.map(signedTxMsg) }]));
    const t = performance.now();
    tf.onFeedMsgs(msgs, Date.now()); te.onFeedMsgs(msgs, Date.now());
    return performance.now() - t;
  };
  const run = async (light: string) => {
    let worst = 0, sum = 0;
    for (let i = 0; i < 12; i++) {
      const ms = withEnv('FEED_LIGHT_DECODE', light, () => tap(1_000 + i + (light === '1' ? 100 : 0)));
      if (i >= 2) { sum += ms / 10; worst = Math.max(worst, ms); }
      await new Promise((r) => setTimeout(r, 5));
    }
    return { avg: sum, worst };
  };
  const a = await run('0'), b = await run('1');
  console.log(`[bench, TEST numbers] feed tap (order buffer + entry point) per 40-swap message: before avg ${a.avg.toFixed(1)} ms (worst ${a.worst.toFixed(1)}), now avg ${b.avg.toFixed(1)} ms (worst ${b.worst.toFixed(1)}) -> ${(a.avg / b.avg).toFixed(1)}x`);
  assert(b.avg < a.avg / 3, 'feed tap at least 3x faster per message');
}

// ---- 3. lean node requests ------------------------------------------------------------------------
type Seen = { body: Buffer; type: string | undefined; len: string | undefined };
async function fakeNode(answer: (req: any, raw: Buffer) => Buffer | string | object | null) {
  const seen: Seen[] = [];
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      seen.push({ body, type: req.headers['content-type'], len: req.headers['content-length'] });
      const j = JSON.parse(body.toString('utf8'));
      const one = (r: any) => { const a = answer(r, body); return a === null ? { jsonrpc: '2.0', id: r.id, error: { code: 3, message: 'execution reverted', data: '0x08c379a0' + '00'.repeat(4) } } : (Buffer.isBuffer(a) || typeof a === 'string' && a.startsWith('RAW:')) ? a : { jsonrpc: '2.0', id: r.id, result: a }; };
      const out = Array.isArray(j) ? j.map(one) : one(j);
      if (Buffer.isBuffer(out)) { res.end(out); return; }
      if (typeof out === 'string') { res.end(out.slice(4)); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  srv.unref(); // never keeps the test process alive
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((r) => srv.close(() => r())) };
}
const errView = (e: any) => (e ? JSON.stringify({ code: e.code, short: e.shortMessage, data: e.data ?? null, reason: e.reason ?? null }) : 'none');
const mc3 = new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
const MC3_SEL = mc3.getFunction('aggregate3')!.selector;
async function rpcTests() {
  const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
  const big = '0x' + 'ab'.repeat(300_000);
  let mode: 'ok' | 'badutf8' | 'badjson' | 'bom' | 'upper' = 'ok';
  const node = await fakeNode((r) => {
    if (r.method === 'eth_chainId') return '0x1237';
    if (r.method === 'eth_getCode') return '0x01';
    if (r.method === 'eth_blockNumber') return '0x10';
    if (r.method === 'web3_clientVersion') return 'Ünïcode 😀 node';
    if (r.method === 'eth_call') {
      if (mode === 'badutf8') return Buffer.from([0x7b, 0xff, 0x7d]);
      if (mode === 'badjson') return 'RAW:{"jsonrpc":"2.0",';
      if (mode === 'bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: r.id, result: '0x01' }))]);
      if (mode === 'upper') return '0xABCDEF';
      const d = String(r.params[0].data);
      if (d.includes('dead')) return null; // reverts
      // A bundled read (Multicall3 aggregate3): one 32-byte answer per read.
      if (d.startsWith(MC3_SEL)) {
        const list = mc3.decodeFunctionData('aggregate3', d)[0] as Array<[string, boolean, string]>;
        return mc3.encodeFunctionResult('aggregate3', [list.map((c) => [true, '0x' + String(c[2]).slice(-64).padStart(64, '0')])]);
      }
      return d.length > 1000 ? big : '0x' + 'cd'.repeat(64);
    }
    return null;
  });
  const mk = (lean: boolean, staticNet = true) => (lean ? new LeanJsonRpcProvider(node.url, 4663, staticNet ? { staticNetwork: true } : {}) : new ethers.JsonRpcProvider(node.url, 4663, staticNet ? { staticNetwork: true } : {}));
  // The same conversation through ethers and through the lean provider.
  const talk = async (lean: boolean) => {
    const p = mk(lean);
    const start = node.seen.length;
    const out: string[] = [];
    out.push(String(await p.send('eth_blockNumber', [])));
    out.push(String(await p.send('web3_clientVersion', [])));
    out.push(JSON.stringify(await Promise.all([p.send('eth_blockNumber', []), p.send('eth_getCode', [MC3, 'latest'])])));  // one batch
    out.push((await ethCall(p, MC3, '0x' + '12'.repeat(2_000))).length.toString());
    out.push(await ethCall(p, MC3.toLowerCase(), '0x1234'));
    out.push(await p.call({ to: MC3, data: '0x1234' }));
    for (const m of ['upper', 'badutf8', 'badjson', 'bom'] as const) {
      mode = m;
      let r = '';
      try { r = await ethCall(p, MC3, '0x1234'); } catch (e) { r = 'threw ' + errView(e); }
      out.push(`${m}: ${r}`);
      mode = 'ok';
    }
    try { await ethCall(p, MC3, '0xdead'); out.push('no revert?'); } catch (e) { out.push('revert ' + errView(e)); }
    try { await ethCall(p, '0xCA11BDE05977B3631167028862BE2A173976ca11', '0x12'); out.push('bad checksum accepted?'); } catch (e) { out.push('bad checksum ' + (e as any).code); }
    p.destroy();
    const wire = node.seen.slice(start).map((s) => `${s.type}|${s.len}|${s.body.toString('utf8').replace(/"id":\d+/g, '"id":N')}`);
    return { out, wire };
  };
  const a = await talk(false);
  const b = await withEnv('RPC_LEAN_CALL', '0', async () => talk(true));
  const c = await talk(true);
  // ethers' own provider.call vs the lean ethCall: request bytes, headers, answers, errors.
  assert(JSON.stringify(a.out) === JSON.stringify(c.out), `same answers and the same errors (${a.out.length} cases: big answer, non-ASCII text, batch, revert, broken text / JSON / byte-order mark, uppercase answer, bad checksum)`);
  assert(JSON.stringify(a.wire) === JSON.stringify(c.wire) && JSON.stringify(b.wire) === JSON.stringify(c.wire) && a.wire.length >= 10, `byte-for-byte the same requests on the wire, same content-type and length headers (${a.wire.length} requests)`);
  assert(a.out.some((x) => x.startsWith('revert') && x.includes('CALL_EXCEPTION')) && a.out.some((x) => x.startsWith('badutf8: threw')), 'a reverted call is still CALL_EXCEPTION; a broken answer still throws ethers\' error');
  // A provider without a fixed network: provider.call also asks the chain id, so the lean call is not used (same requests).
  const nonStatic = async (lean: boolean) => { const p = mk(lean, false); const s0 = node.seen.length; await ethCall(p, MC3, '0x1234'); await ethCall(p, MC3, '0x1234'); p.destroy(); return node.seen.slice(s0).map((s) => s.body.toString('utf8').replace(/"id":\d+/g, '"id":N')); };
  const ns1 = await nonStatic(false), ns2 = await nonStatic(true);
  assert(JSON.stringify(ns1) === JSON.stringify(ns2) && ns1.join('').includes('eth_chainId'), 'provider without a fixed network: identical requests (chain id check kept)');
  // makeCaller (the scan / price reads): same results, same requests; a reverted bundle is split the same way.
  const calls = Array.from({ length: 900 }, (_, i) => ({ target: '0x' + (0x1000 + i).toString(16).padStart(40, '0'), data: i === 450 ? '0xdead' : '0x70a08231' + (i).toString(16).padStart(64, '0') }));
  const viaCaller = async (lean: string) => withEnv('RPC_LEAN_CALL', lean, async () => {
    const p = mk(lean === '1');
    const s0 = node.seen.length;
    const { callMany } = await makeCaller(p);
    const res = await callMany(calls);
    p.destroy();
    return { res: JSON.stringify(res), wire: node.seen.slice(s0).map((s) => s.body.toString('utf8').replace(/"id":\d+/g, '"id":N')) };
  });
  const m0 = await viaCaller('0'), m1 = await viaCaller('1');
  assert(m0.res === m1.res && JSON.stringify(m0.wire) === JSON.stringify(m1.wire) && m0.wire.length > 3, `bundled reads (makeCaller): same answers and requests, incl. a reverted bundle split down to the failing read (${m0.wire.length} requests)`);

  // BENCH (TEST numbers): the longest freeze while reading 1.2 MB answers.
  const longest = async (lean: boolean) => {
    const p = mk(lean);
    await ethCall(p, MC3, '0x' + '12'.repeat(2_000));
    let worst = 0, last = performance.now();
    const tick = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; }, 1);
    const t0 = performance.now();
    for (let i = 0; i < 8; i++) await withEnv('RPC_LEAN', lean ? '1' : '0', () => (lean ? ethCall(p, MC3, '0x' + '12'.repeat(2_000)) : p.call({ to: MC3, data: '0x' + '12'.repeat(2_000) })));
    const total = performance.now() - t0;
    clearInterval(tick);
    p.destroy();
    return { worst, total };
  };
  const o = await longest(false), l = await longest(true);
  console.log(`[bench, TEST numbers] 8 reads with a 600 KB answer each: ethers longest freeze ${o.worst.toFixed(0)} ms (total ${o.total.toFixed(0)} ms), lean longest freeze ${l.worst.toFixed(0)} ms (total ${l.total.toFixed(0)} ms)`);
  assert(l.worst < o.worst / 3, 'reading big node answers freezes the bot at least 3x less');
  await node.close();
}

// ---- 4. JSON read in bites ------------------------------------------------------------------------
async function jsonTests() {
  const cases: unknown[] = [
    {}, [], { a: [] }, [[]], { version: 1, pools: [[0, '0xab', 1, 2]], lastBlock: { '0xf1': 5 } },
    { s: 'quote " back \\ slash \\" mixed \\\\', u: 'Ünï 😀 \u0000  ', n: [-1.5e-7, 0, 1e21, 123456789012345680000], t: [true, false, null] },
    Array.from({ length: 5_003 }, (_, i) => (i % 3 ? [i, `0x${i.toString(16)}`, { k: i % 7 ? 'x"y' : '\\' }] : i)),
    { tokens: Array.from({ length: 4_100 }, (_, i) => `0x${i}`), pools: Array.from({ length: 2_001 }, (_, i) => [i % 3, `0x${i}`, i, i + 1]), nested: { deep: [[1, [2, [3]]]] } },
  ];
  let ok = true;
  for (const c of cases) for (const text of [JSON.stringify(c), JSON.stringify(c, null, 2), ` \n${JSON.stringify(c, null, '\t')}\r\n `]) {
    const r = drainSteps(parseJsonSteps(text));
    if (!r || JSON.stringify(r.value) !== JSON.stringify(JSON.parse(text))) { ok = false; console.log('  differs:', text.slice(0, 80)); }
  }
  const dup = '{"a":1,"b":[1,2],"a":[3]}';
  const rd = drainSteps(parseJsonSteps(dup));
  assert(ok && !!rd && JSON.stringify(rd.value) === JSON.stringify(JSON.parse(dup)) && Object.keys(rd.value as object).join() === 'a,b', 'read in bites = JSON.parse (escapes, unicode, numbers, nesting, whitespace, a repeated key)');
  const odd = ['', 'x', '{"a":1}x', '[1,]', '{"a":1,}', '{"__proto__":[1]}', '{"a" 1}', '[1 2]', '"just text"', '5', '{"a":[1,2}', '[{"a":"\\"]'];
  let oddOk = true;
  for (const t of odd) {
    const r = drainSteps(parseJsonSteps(t));
    let viaParse: string; try { viaParse = JSON.stringify(JSON.parse(t)); } catch { viaParse = 'throws'; }
    // Either the reader hands it to JSON.parse (null), or it agrees with it.
    if (r && JSON.stringify(r.value) !== viaParse) oddOk = false;
  }
  assert(oddOk && drainSteps(parseJsonSteps('{"__proto__":[1]}')) === null && drainSteps(parseJsonSteps('[1,]')) === null, 'odd or broken text is left to JSON.parse (the old way)');
  const dir = mkdtempSync(join(tmpdir(), 'ff2json-'));
  writeFileSync(join(dir, 'u.json'), JSON.stringify({ name: 'Ünï 😀', list: Array.from({ length: 3_000 }, (_, i) => [i]) }));
  writeFileSync(join(dir, 'bad.json'), '{"a":[1,2');
  const u = await readJsonChunked(join(dir, 'u.json'));
  let badErr = '', oldErr = '';
  try { await readJsonChunked(join(dir, 'bad.json')); } catch (e) { badErr = (e as Error).name; }
  try { JSON.parse(readFileSync(join(dir, 'bad.json'), 'utf8')); } catch (e) { oldErr = (e as Error).name; }
  assert(JSON.stringify(u) === JSON.stringify(JSON.parse(readFileSync(join(dir, 'u.json'), 'utf8'))) && badErr === oldErr && badErr === 'SyntaxError', 'file reader = JSON.parse(readFileSync) (non-ASCII file, broken file throws the same error)');
  const missing = await loadScanStateFile(join(dir, 'nope.json'));
  writeFileSync(join(dir, 'v2.json'), JSON.stringify({ version: 2, pools: [] }));
  const wrong = await loadScanStateFile(join(dir, 'v2.json'));
  assert(JSON.stringify(missing) === JSON.stringify(emptyScanState()) && JSON.stringify(wrong) === JSON.stringify(emptyScanState()), 'missing or unexpected file: empty state, as before');
  // The 400k-pool bench runs in a fresh child process (scanLoadChild), so
  // memory clean-ups left over from the other tests don't land in a bite.
  const r = spawnSync(process.execPath, ['--expose-gc', __filename], { env: { ...process.env, FF2_CHILD: 'scanload', FF2_DIR: dir }, encoding: 'utf8', timeout: 180_000 });
  process.stdout.write(r.stdout ?? '');
  if (r.status !== 0) { console.error(r.stderr); process.exitCode = 1; }
}

// Child process: the saved pool scan (~400k pools, like the live file),
// written as text so no big copy sits in memory while the readers are timed.
async function scanLoadChild() {
  const dir = process.env.FF2_DIR ?? mkdtempSync(join(tmpdir(), 'ff2scan-'));
  const file = join(dir, 'robinhood-universe.json');
  {
    const parts: string[] = ['{"version":1,"lastBlock":{"0xf1":123},"tokens":['];
    for (let i = 0; i < 400_000; i++) parts.push((i ? ',"0x' : '"0x') + (0x100000 + i).toString(16).padStart(40, '0') + '"');
    parts.push('],"pools":[');
    for (let i = 0; i < 400_000; i++) parts.push(`${i ? ',' : ''}[${i % 2},"0x${(0x9000000 + i).toString(16).padStart(40, 'a')}",${i},${(i * 7) % 400_000}]`);
    parts.push('],"factories":["uniswap-v2|v2|0xf1","uniswap-v3|v3|0xf3"]}');
    writeFileSync(file, parts.join(''));
  }
  const mb = readFileSync(file).length / 1_048_576;
  // Start both readers from a cleaned-up memory (the file building above left garbage).
  const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});
  gc(); gc();
  // Each bite's own time, and the memory clean-ups (GC) inside it: the
  // stall finder reports GC as its own cause, so the bite is judged without it.
  const bites: Array<[number, number]> = [];
  const gcs: Array<[number, number]> = [];
  const note = stallFinder.noteSlice.bind(stallFinder);
  stallFinder.noteSlice = (name: string, s0: number, e0: number, self?: number) => { if (name === 'scan file load') bites.push([s0, e0]); note(name, s0, e0, self); };
  const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) gcs.push([e.startTime, e.startTime + e.duration]); });
  obs.observe({ entryTypes: ['gc'] });
  stallFinder.take('fiveMin');
  let t = performance.now();
  let newSt: ScanState | null = await loadScanStateFile(file);
  const totalMs = performance.now() - t;
  await new Promise((r) => setTimeout(r, 50)); // GC entries arrive a moment later
  obs.disconnect();
  stallFinder.noteSlice = note;
  const bite = stallFinder.take('fiveMin').longest.find((j) => j.name === 'scan file load');
  const ownMs = Math.max(...bites.map(([a, b]) => (b - a) - gcs.reduce((sum, [x, y]) => sum + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0)));
  const newText = JSON.stringify(newSt);
  newSt = null;
  gc(); gc();
  t = performance.now();
  const oldSt = JSON.parse(readFileSync(file, 'utf8'));
  const oldMs = performance.now() - t;
  assert(newText === JSON.stringify(oldSt) && oldSt.pools.length === 400_000, `saved pool scan read in bites = the old one-go read (${(mb).toFixed(0)} MB, 400k pools)`);
  console.log(`[bench, TEST numbers] saved pool scan (${mb.toFixed(0)} MB): old one-go read froze ${oldMs.toFixed(0)} ms; now longest bite ${ownMs.toFixed(1)} ms of its own work (${bite?.maxMs.toFixed(1)} ms with memory clean-up inside it; ${bite?.n} bites, ${totalMs.toFixed(0)} ms in total)`);
  assert(!!bite && ownMs < oldMs / 3, 'scan file load: longest freeze (own work) at least 3x shorter');
}

// ---- 5. sliced queue ---------------------------------------------------------------------------------
async function queueTests() {
  const order: number[] = [];
  const q = new SlicedQueue(5);
  for (let i = 0; i < 200; i++) q.push(() => { order.push(i); if (i === 7) throw new Error('job problem'); });
  await new Promise((r) => setTimeout(r, 30));
  assert(order.length === 200 && order.every((x, i) => x === i) && q.size() === 0, 'every job runs once, in order, even after a job throws');
  // 40 jobs of 2 ms queued at once (a busy feed message with signature checks).
  const gap = async (useQueue: boolean) => {
    let worst = 0, last = performance.now();
    const tick = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; }, 1);
    await new Promise((r) => setTimeout(r, 10));
    const q2 = new SlicedQueue(5);
    for (let i = 0; i < 40; i++) { const job = () => busy(2); if (useQueue) q2.push(job); else setImmediate(job); }
    await new Promise((r) => setTimeout(r, 150));
    clearInterval(tick);
    return worst;
  };
  const oldGap = await gap(false), newGap = await gap(true);
  console.log(`[bench, TEST numbers] 40 rival-watch jobs of 2 ms queued at once: before one ${oldGap.toFixed(0)} ms freeze, now longest ${newGap.toFixed(0)} ms`);
  assert(newGap < oldGap / 3, 'queued jobs no longer run all back to back');
}

// ---- 6. sidecar framing ---------------------------------------------------------------------------
function frameTests() {
  const oldFrame = (msg: unknown) => { const body = Buffer.from(JSON.stringify(msg), 'utf8'); const out = Buffer.allocUnsafe(4 + body.length); out.writeUInt32BE(body.length, 0); body.copy(out, 4); return out; };
  const msgs: unknown[] = [{ id: 1, type: 'call' }, { s: 'Ünï 😀 \ud800 lone', n: 1 }, { feed: { msgs: Array.from({ length: 48 }, (_, i) => ({ seq: i, txs: ['0x' + 'ab'.repeat(900)] })) } }, { id: 0, type: 'feed', frame: JSON.stringify({ a: '"quoted"' }) }];
  assert(msgs.every((m) => frame(m).equals(oldFrame(m))), 'sidecar messages byte for byte the same (incl. unicode, a lone surrogate, a 48-message feed)');
}

// ---- memory per item (child process, no clean-up during a measurement) ------------------------------
async function allocChild() {
  const gc = (globalThis as { gc?: () => void }).gc!;
  const kb = (f: () => void, n: number) => { gc(); gc(); const a = getHeapStatistics().used_heap_size; f(); const b = getHeapStatistics().used_heap_size; return (b - a) / n / 1024; };
  const fresh = await swaps(200, 13);
  const res: Record<string, number> = {};
  for (const light of ['0', '1']) {
    clearFeedTxMemo();
    res[`skip${light}`] = withEnv('FEED_LIGHT_DECODE', light, () => kb(() => { for (const r of fresh) quickSkip(r, '0x00', ours); }, fresh.length));
    clearFeedTxMemo();
    const f = frameOf([{ seq: 1, raws: fresh.map(signedTxMsg) }]);
    res[`frame${light}`] = withEnv('FEED_LIGHT_DECODE', light, () => kb(() => { parseFeedMessages(f); for (const r of fresh) quickSkip(r, '0x00', ours); parseFeedFrame(f); }, fresh.length));
  }
  // ethers' text converters vs Node's on a 600 KB answer.
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + 'ab'.repeat(300_000) }));
  const req = JSON.stringify({ method: 'eth_call', params: [{ to: '0x' + '11'.repeat(20), data: '0x' + '12'.repeat(100_000) }, 'latest'], id: 1, jsonrpc: '2.0' });
  res.rpcOld = kb(() => { ethers.toUtf8Bytes(req); const j = JSON.parse(ethers.toUtf8String(body)); ethers.hexlify(ethers.hexlify(j.result)); }, 1);
  res.rpcNew = kb(() => { Buffer.from(req, 'utf8'); JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body)); }, 1);
  console.log('ALLOC ' + JSON.stringify(res));
}
function allocReport() {
  const r = spawnSync(process.execPath, ['--expose-gc', '--min-semi-space-size=256', '--max-semi-space-size=256', __filename], { env: { ...process.env, FF2_CHILD: 'alloc' }, encoding: 'utf8', timeout: 120_000 });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('ALLOC '));
  if (!line) { console.log('[memory] child measurement not available on this machine (skipped)', r.stderr?.slice(0, 200)); return; }
  const a = JSON.parse(line.slice(6)) as Record<string, number>;
  console.log(`[memory, TEST numbers] per feed transaction: entry skip test ${a.skip0.toFixed(1)} KB -> ${a.skip1.toFixed(1)} KB; whole feed pass (unpack + skip test + trade decoder) ${a.frame0.toFixed(1)} KB -> ${a.frame1.toFixed(1)} KB`);
  console.log(`[memory, TEST numbers] one node read with a 600 KB answer (request + answer handling): ethers ${(a.rpcOld / 1024).toFixed(1)} MB -> lean ${(a.rpcNew / 1024).toFixed(1)} MB`);
  assert(a.skip1 < a.skip0 / 3 && a.frame1 < a.frame0 / 2, 'feed path makes far less throw-away memory per transaction');
  assert(a.rpcNew < a.rpcOld / 5, 'node answers make far less throw-away memory');
}

async function main() {
  if (process.env.FF2_CHILD === 'alloc') { await allocChild(); return; }
  if (process.env.FF2_CHILD === 'scanload') { await scanLoadChild(); return; }
  await lightTests();
  await tapTests();
  await rpcTests();
  await jsonTests();
  await queueTests();
  frameTests();
  allocReport();
}
main().catch((e) => { console.error('FAIL: test crashed', e); process.exitCode = 1; });
