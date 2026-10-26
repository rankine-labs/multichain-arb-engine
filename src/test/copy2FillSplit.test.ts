import { Copy2Forwarder, Copy2Index, TRANSFER_TOPIC, copy2Settings } from '../execution/copy2';
import type { RpcLog } from '../core/blockReader';

// COPY 2 FILL-IN SPLIT (Oct 26): after a WebSocket outage the copy fills in
// the missed blocks with eth_getLogs. The node refuses any request whose
// address list or topic list is too long ("exceed max topics"), and we follow
// ~1,300 pools and ~900 V4 ids. These tests check, with a fake node that
// refuses long lists exactly like the real one:
//   - the fill-in read cuts every long list into pieces and still gets
//     every report back, each one once;
//   - one failing piece makes the whole read fail (null), as before;
//   - never more than the allowed number of requests run at the same time.
// Fake node only: no network.

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1; }
  else console.log(`PASS: ${msg}`);
}

// ---- made-up addresses / ids --------------------------------------------------
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const hex40 = (n: number, tag: string) => '0x' + tag + n.toString(16).padStart(40 - tag.length, '0');
const hex64 = (n: number) => '0x' + 'ee' + n.toString(16).padStart(62, '0');
const pad = (a: string) => '0x' + '0'.repeat(24) + a.slice(2);
const POOLS = Array.from({ length: 1_300 }, (_, i) => hex40(i, 'a'));
const IDS = Array.from({ length: 900 }, (_, i) => hex64(i));
const COINS = Array.from({ length: 450 }, (_, i) => hex40(i, 'c'));
const CHUNK = 400;

const index: Copy2Index = { pools: new Set(POOLS), ids: new Set(IDS), poolManager: PM, coins: new Set(COINS) };

// ---- what the "chain" holds ---------------------------------------------------
// One report per pool, one per V4 id, and one coin transfer per pool (some
// going pool -> pool, which matches both the "from" and the "to" request).
let li = 0;
const mk = (address: string, topics: string[]): RpcLog => ({ address, topics, data: '0x', blockNumber: '0x64', logIndex: '0x' + (li++).toString(16), transactionHash: '0x' + 'ab'.repeat(32) });
const CHAIN: RpcLog[] = [
  ...POOLS.map((p) => mk(p, ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1'])),
  ...IDS.map((id) => mk(PM, ['0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f', id])),
  ...POOLS.map((p, i) => mk(COINS[i % COINS.length], [TRANSFER_TOPIC, pad(p), pad(i % 3 === 0 ? POOLS[(i + 1) % POOLS.length] : hex40(i, 'f'))])),
  // noise that must NOT come back: a pool nobody follows, a stranger's transfer
  mk(hex40(1, 'b'), ['0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1']),
  mk(COINS[0], [TRANSFER_TOPIC, pad(hex40(2, 'f')), pad(hex40(3, 'f'))]),
];
const EXPECTED = 1_300 + 900 + 1_300;

// ---- fake node -----------------------------------------------------------------
// Refuses a long list like the real one; answers like eth_getLogs otherwise;
// counts how many requests are open at once.
type Fake = { rpc: (m: string, p: unknown[]) => Promise<any>; calls: number; maxOpen: number };
function fakeNode(failOn?: (filter: any, n: number) => boolean): Fake {
  const f: Fake = { rpc: async () => null, calls: 0, maxOpen: 0 };
  let open = 0;
  f.rpc = async (method, params) => {
    if (method !== 'eth_getLogs') throw new Error('unexpected ' + method);
    const flt = params[0] as any;
    const n = ++f.calls;
    open++;
    f.maxOpen = Math.max(f.maxOpen, open);
    try {
      await new Promise((r) => setTimeout(r, 1));   // answers take a moment
      const addrs: string[] = Array.isArray(flt.address) ? flt.address : [flt.address];
      const topics: Array<string[] | string | null> = flt.topics ?? [];
      if (addrs.length > CHUNK || topics.some((t) => Array.isArray(t) && t.length > CHUNK)) throw new Error('exceed max topics');
      if (failOn?.(flt, n)) throw new Error('HTTP 429');
      const aset = new Set(addrs.map((a) => a.toLowerCase()));
      return CHAIN.filter((l) => aset.has(l.address.toLowerCase()) && topics.every((t, k) =>
        t === null || (Array.isArray(t) ? t.includes(l.topics[k]) : t === l.topics[k])));
    } finally { open--; }
  };
  return f;
}

function forwarder(parallel?: number): Copy2Forwarder {
  return new Copy2Forwarder({
    send: () => true, index: () => index, backfillRpc: () => null,
    topicChunk: CHUNK, ...(parallel !== undefined ? { fillParallel: parallel } : {}),
    schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
  });
}
// readLogs is private (only the fill-in uses it); the test reaches in.
const readLogs = (f: Copy2Forwarder, rpc: Fake['rpc']) => (f as any).readLogs(rpc, 100, 100) as Promise<RpcLog[] | null>;

async function main() {
  // 1. Old behaviour check: one request with every pool is refused by the fake node.
  {
    const node = fakeNode();
    let refused = false;
    try { await node.rpc('eth_getLogs', [{ address: POOLS }]); } catch (e) { refused = /exceed max topics/.test(String(e)); }
    assert(refused, 'fake node refuses a 1,300-address list (like the real node)');
  }
  // 2. Split read: everything back, once each.
  {
    const node = fakeNode();
    const logs = await readLogs(forwarder(), node.rpc);
    assert(Array.isArray(logs), 'fill-in read with 1,300 pools / 900 ids succeeds (lists are split)');
    const keys = new Set((logs ?? []).map((l) => `${l.blockNumber}:${l.logIndex}`));
    assert(logs?.length === EXPECTED, `every followed report comes back (${logs?.length} of ${EXPECTED})`);
    assert(keys.size === (logs?.length ?? -1), 'no report is kept twice (pool -> pool transfers too)');
    assert(!(logs ?? []).some((l) => l.address === hex40(1, 'b')), 'reports of pools nobody follows are not asked for');
    // 4 pool pieces + 3 id pieces + 2 coin pieces x 4 pool pieces x 2 directions = 23
    assert(node.calls === 23, `request count stays small (${node.calls}, expected 23)`);
    assert(node.maxOpen <= 3, `default: at most 3 requests at once (saw ${node.maxOpen})`);
  }
  // 3. Parallelism bound follows the setting.
  {
    const node = fakeNode();
    const logs = await readLogs(forwarder(1), node.rpc);
    assert(logs?.length === EXPECTED && node.maxOpen === 1, `fillParallel 1: one request at a time (saw ${node.maxOpen})`);
    const node5 = fakeNode();
    await readLogs(forwarder(5), node5.rpc);
    assert(node5.maxOpen <= 5 && node5.maxOpen > 1, `fillParallel 5: at most 5 at once (saw ${node5.maxOpen})`);
  }
  // 4. One piece fails (thrown error, e.g. HTTP 429): the whole read fails, and no more requests are started after it.
  {
    const node = fakeNode((_flt, n) => n === 5);
    let threw = '';
    let got: RpcLog[] | null | undefined;
    try { got = await readLogs(forwarder(), node.rpc); } catch (e) { threw = String((e as Error).message); }
    assert(threw === 'HTTP 429' && got === undefined, 'a failing piece fails the whole read (the fill-in then reloads, as before)');
    assert(node.calls < 23, `after a failure the remaining pieces are not asked for (${node.calls} of 23 sent)`);
  }
  // 5. One piece gives an odd answer (not a list): null, exactly as before.
  {
    const node = fakeNode();
    const odd = async (m: string, p: unknown[]) => ((p[0] as any).topics?.[0] === TRANSFER_TOPIC ? null : node.rpc(m, p));
    const logs = await readLogs(forwarder(), odd);
    assert(logs === null, 'a piece with no proper answer makes the read return null');
  }
  // 6. Settings: chunk shared with the WebSocket setting; parallel has its own.
  {
    const d = copy2Settings({});
    assert(d.topicChunk === 400 && d.fillParallel === 3, 'defaults: 400 per request, 3 at once');
    const s = copy2Settings({ BLOCK_READER_WSS_TOPIC_CHUNK: '250', COPY2_FILL_PARALLEL: '2' });
    assert(s.topicChunk === 250 && s.fillParallel === 2, 'BLOCK_READER_WSS_TOPIC_CHUNK / COPY2_FILL_PARALLEL are read');
  }
}

main().catch((e) => { console.error('FAIL: crashed', e); process.exitCode = 1; });
