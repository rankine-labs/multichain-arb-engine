import { Wallet, keccak256 } from 'ethers';
import { FeedMsg } from '../chains/nitroFeed';
import { TriggerFirst, TrigCopy2, trigFirstSettings } from '../execution/triggerFirst';
import { JsonlLog } from '../execution/localSimHost';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// FEED STORE, BOT SIDE (speed-3, Oct 24; execution/triggerFirst.ts):
//   - each new feed message is handed to the sidecar ONCE (`feed_put`),
//     only after the sidecar said it has a store (status.feedStore), and
//     again from scratch after every reconnect;
//   - a question NAMES the messages ([seq, tx count]) only when every one
//     was handed over on this connection; otherwise it carries them, as before;
//   - the named form, expanded, is EXACTLY the old inline feed (same
//     question for the sidecar);
//   - "feed_ref_missing" (the sidecar restarted / lost one): asked again
//     with the messages inline, same question otherwise; one-trip too;
//   - an older sidecar (no store) or TRIG_FIRST_FEED_STORE=0: always inline.
// The sidecar side is tested in sim/tests (trig_first.rs, copy2_intake.rs).

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Asked = Record<string, any>;

const wallet = new Wallet('0x' + '22'.repeat(32));
async function signed(nonce: number): Promise<string> {
  return wallet.signTransaction({ type: 2, chainId: 4663, nonce, to: '0x' + '77'.repeat(20), data: '0x1234', value: 0n, gasLimit: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n });
}
const msgOf = (seq: number, raws: string[]): FeedMsg => ({ seq, ts: 1_700_000_000 + seq, l1: 9000, complete: true, txs: raws.map((r) => ({ hash: keccak256(r), raw: r })) });

const copy2: TrigCopy2 = { running: () => true, notReadyWhy: () => null, waitForTx: async () => 101, forwarder: { newestBlock: () => 100, txBlockOf: () => null } };

// Fake sidecar connection: records questions and one-way messages.
function fakeClient(o: { store: boolean; missing?: () => boolean }) {
  const asked: Asked[] = [];
  const told: Asked[] = [];
  let epoch = 1;
  const client = {
    isConnected: () => true,
    connEpoch: () => epoch,
    stats: { fallbacks: 0 },
    sendOneWay: (m: Asked) => { told.push(m); return true; },
    request: async (m: Asked) => {
      asked.push(m);
      if (m.type === 'status') return { ok: true, ...(o.store ? { feedStore: { cap: 2048, msgs: 0 } } : {}) };
      if (m.feed?.refs && o.missing?.()) {
        if (m.type === 'trig_entry') return { ok: true, disc: { ok: false, unknown: 'feed_ref_missing' } };
        return { ok: false, unknown: 'feed_ref_missing' };
      }
      return { ok: true, pools: [], echo: m.feed };
    },
    reconnect: () => { epoch++; },
  };
  return { client, asked, told };
}

function makeTf(client: unknown, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'feedstore-'));
  return new TriggerFirst({
    client: client as any, settings: trigFirstSettings({ LOCAL_SIM_TRIGGER_FIRST: 'shadow', ...env }), copy2: () => copy2,
    shadowLog: new JsonlLog(join(dir, 'x.jsonl'), 1_000, 0), hostOn: () => true, log: () => {},
  });
}

async function main() {
  const raws = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((n) => signed(n)));
  const trig = raws[5];
  const trigHash = keccak256(trig);

  // The reference: the same buffer with the store switched off (old feed).
  const off = fakeClient({ store: true });
  const tfOff = makeTf(off.client, { TRIG_FIRST_FEED_STORE: '0' });
  tfOff.onFeedMsgs([msgOf(95, [raws[0]]), msgOf(96, [raws[1], raws[2]])], Date.now());
  tfOff.onFeedMsgs([msgOf(97, []), msgOf(98, [raws[3]]), msgOf(99, [raws[4], trig]), msgOf(100, [raws[6]])], Date.now());
  const ref = tfOff.buildFeed(trigHash, []);
  assert(!('why' in ref) && Array.isArray((ref as any).feed.msgs) && !(ref as any).feed.refs, 'store off: messages inline');
  assert(off.told.length === 0 && !off.asked.some((m) => m.type === 'status'), 'store off: nothing handed over, sidecar not asked');

  // Store on: the first messages arrive before the sidecar has said it has a store.
  const on = fakeClient({ store: true });
  const tf = makeTf(on.client);
  tf.onFeedMsgs([msgOf(95, [raws[0]]), msgOf(96, [raws[1], raws[2]])], Date.now());
  assert(on.told.length === 0 && on.asked.filter((m) => m.type === 'status').length === 1, 'asks the sidecar once whether it has a store; nothing handed over before the answer');
  await sleep(5);
  tf.onFeedMsgs([msgOf(97, []), msgOf(98, [raws[3]]), msgOf(99, [raws[4], trig]), msgOf(100, [raws[6]])], Date.now());
  assert(on.told.length === 1 && on.told[0].type === 'feed_put' && on.told[0].msgs.map((m: Asked) => m.seq).join(',') === '97,98,99,100', 'new messages handed over once, in one feed_put');
  // A repeat (reconnect backlog) is not handed over again.
  tf.onFeedMsgs([msgOf(99, [raws[4], trig])], Date.now());
  assert(on.told.length === 1, 'a repeated message is not handed over again');
  // 95 / 96 were never handed over: questions reaching back to them carry the messages.
  const b1 = tf.buildFeed(trigHash, []);
  assert(!('why' in b1) && Array.isArray((b1 as any).feed.msgs), 'a message not handed over on this connection: messages inline');
  assert(JSON.stringify((b1 as any).feed) === JSON.stringify((ref as any).feed), 'inline feed identical to the store-off feed');
  // Messages 101.. all handed over: named.
  const more = await Promise.all([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21].map((n) => signed(n)));
  for (let s = 101; s <= 112; s++) tf.onFeedMsgs([msgOf(s, [more[s - 101]])], Date.now());
  tfOff.onFeedMsgs([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112].map((s) => msgOf(s, [more[s - 101]])), Date.now());
  const h2 = keccak256(more[110 - 101]);
  // The old question for a given buffer (store off).
  const refOf = (list: FeedMsg[], h: string, keys: string[]) => {
    const t = makeTf(fakeClient({ store: true }).client, { TRIG_FIRST_FEED_STORE: '0' });
    t.onFeedMsgs(list, Date.now());
    return (t.buildFeed(h, keys) as any).feed;
  };
  const list101 = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112].map((s) => msgOf(s, [more[s - 101]]));
  // (copy at 100: the feed reaches back 8 more than the copy -> 92.., so use a copy close to the trigger)
  (copy2.forwarder as any).newestBlock = () => 106;
  const named = tf.buildFeed(h2, ['0x' + 'ab'.repeat(20)]);
  const inline = tfOff.buildFeed(h2, ['0x' + 'ab'.repeat(20)]);
  const nf = (named as any).feed, inf = (inline as any).feed;
  assert(Array.isArray(nf.refs) && !nf.msgs && nf.refs.map((r: number[]) => r.join(':')).join(',') === inf.msgs.map((m: Asked) => `${m.seq}:${m.txs.length}`).join(','), 'all handed over: the question names the same messages ([seq, count])');
  const { refs: _r, ...restN } = nf; const { msgs: _m, ...restI } = inf;
  assert(JSON.stringify(restN) === JSON.stringify(restI), 'everything else in the feed is the same (trigger, seq, route, assumptions)');
  assert(JSON.stringify(nf).length * 5 < JSON.stringify(inf).length, `the question is much smaller (${JSON.stringify(nf).length} vs ${JSON.stringify(inf).length} chars)`);

  // feed_ref_missing: asked again with exactly the inline feed.
  let missOnce = true;
  const lost = fakeClient({ store: true, missing: () => { const m = missOnce; missOnce = false; return m; } });
  const tfL = makeTf(lost.client);
  tfL.onFeedMsgs([msgOf(1, [])], Date.now());
  await sleep(5);
  for (let s = 101; s <= 112; s++) tfL.onFeedMsgs([msgOf(s, [more[s - 101]])], Date.now());
  const bl = tfL.buildFeed(h2, ['0x' + 'ab'.repeat(20)]);
  const a = await tfL.requestFeed({ type: 'trig_discover', at: { after: 'head' }, feed: (bl as any).feed }, 100);
  const qs = lost.asked.filter((m) => m.type === 'trig_discover');
  assert(qs.length === 2 && !!qs[0].feed.refs && JSON.stringify(qs[1].feed) === JSON.stringify(refOf([msgOf(1, []), ...list101], h2, ['0x' + 'ab'.repeat(20)])), 'feed_ref_missing: asked again with the messages inline, identical to the old question');
  assert(a.ok === true && tfL.storeStats.missing === 1 && tfL.storeStats.resent === 1, 'the second answer is used, counted');
  // After that, until new messages are handed over, questions carry the messages.
  const after = tfL.buildFeed(h2, ['0x' + 'ab'.repeat(20)]);
  assert(Array.isArray((after as any).feed.msgs), 'after a miss: messages inline until handed over again');
  // One trip: the discovery inside says feed_ref_missing -> asked again inline.
  missOnce = true;
  for (let s = 113; s <= 124; s++) tfL.onFeedMsgs([msgOf(s, [])], Date.now());
  (copy2.forwarder as any).newestBlock = () => 115;
  const h3 = keccak256(more[11]);
  // (trigger 112 is still held; the newest messages were handed over, but 107.. 112 were before the miss)
  const b3 = tfL.buildFeed(h3, []);
  void b3;
  const one = await tfL.requestFeed({ type: 'trig_entry', at: { after: 'head' }, feed: { trigger: h3, triggerSeq: 112, refs: [[112, 1]] } }, 100);
  const e = lost.asked.filter((m) => m.type === 'trig_entry');
  assert(e.length === 2 && Array.isArray(e[1].feed.msgs) && e[1].feed.msgs[0].seq === 112 && one.ok === true, 'one trip: discovery lacking a message -> asked again with it inline');

  // Reconnect: everything handed over before is forgotten; the store is asked again.
  (copy2.forwarder as any).newestBlock = () => 106;
  on.client.reconnect();
  const before = on.asked.filter((m) => m.type === 'status').length;
  tf.onFeedMsgs([msgOf(113, [])], Date.now());
  assert(on.asked.filter((m) => m.type === 'status').length === before + 1 && on.told.every((m) => !m.msgs.some((x: Asked) => x.seq === 113)), 'reconnect: store asked again, nothing handed over until it answers');
  const rb = tf.buildFeed(h2, []);
  assert(!('why' in rb) && Array.isArray((rb as any).feed?.msgs), `reconnect: questions carry the messages until they are handed over again ${JSON.stringify(rb).slice(0, 80)}`);

  // An older sidecar (no store): never hands anything over, always inline.
  const old = fakeClient({ store: false });
  const tfO = makeTf(old.client);
  tfO.onFeedMsgs([msgOf(1, [])], Date.now());
  await sleep(5);
  for (let s = 101; s <= 112; s++) tfO.onFeedMsgs([msgOf(s, [more[s - 101]])], Date.now());
  (copy2.forwarder as any).newestBlock = () => 106;
  const ob = tfO.buildFeed(h2, ['0x' + 'ab'.repeat(20)]);
  assert(old.told.length === 0 && JSON.stringify((ob as any).feed) === JSON.stringify(refOf([msgOf(1, []), ...list101], h2, ['0x' + 'ab'.repeat(20)])), 'older sidecar: nothing handed over, the old question');

  // A client without the new calls (tests / older code): inline, no errors.
  const bare = { isConnected: () => true, stats: { fallbacks: 0 }, request: async () => ({ ok: true }) };
  const tfB = makeTf(bare);
  for (let s = 101; s <= 112; s++) tfB.onFeedMsgs([msgOf(s, [more[s - 101]])], Date.now());
  const bb = tfB.buildFeed(h2, ['0x' + 'ab'.repeat(20)]);
  assert(JSON.stringify((bb as any).feed) === JSON.stringify(refOf(list101, h2, ['0x' + 'ab'.repeat(20)])), 'client without connEpoch / sendOneWay: the old question');
}

main().catch((e) => { console.error('FAIL: threw', e); process.exitCode = 1; });
