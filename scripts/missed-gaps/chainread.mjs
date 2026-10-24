// ============================================================================
// MISSED GAPS - chain read (read-only, public node). Runs on GitHub Actions.
//
// Plain English:
//   For every pool on the real arbitrage loops we are studying, read how much
//   money sits in it (V2 reserves / V3+V4 price and liquidity / V3 real coin
//   balances), so the bot's own depth rule ($10k near the price) can be
//   applied. Read twice when possible:
//     - "latest"  : today's state (always works)
//     - "at"      : the block just before the arbitrage (works only while the
//                   public node still keeps that history; null otherwise)
//   Never sends anything, never needs a key.
//
//   node scripts/missed-gaps/chainread.mjs <in.json> <out.json>
//   in.json = { pools: [{id, dex, kind: 'v2'|'v3'|'v4', t0, t1}], hist: [{id, block}] }
// ============================================================================
import { readFileSync, writeFileSync } from 'fs';
import { ethers } from 'ethers';

const RPC = process.env.MG_RPC || 'https://rpc.mainnet.chain.robinhood.com';
const STATE_VIEW = '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b'; // Robinhood V4 StateView (src/config/knownAddresses.ts)
const [inFile, outFile] = process.argv.slice(2);
const input = JSON.parse(readFileSync(inFile, 'utf8'));

// Function selectors (first 4 bytes of keccak of the signature).
const SEL = {
  reserves: '0x0902f1ac', slot0: '0x3850c7bd', liquidity: '0x1a686502', fee: '0xddca3f43',
  balanceOf: '0x70a08231',
  v4slot0: ethers.id('getSlot0(bytes32)').slice(0, 10), v4liq: ethers.id('getLiquidity(bytes32)').slice(0, 10),
};
const pad = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const ZERO = '0x0000000000000000000000000000000000000000';

// The calls that describe one pool's state (target, data, name).
function callsFor(p) {
  if (p.kind === 'v2') return [{ to: p.id, data: SEL.reserves, k: 'reserves' }];
  if (p.kind === 'v4') return [
    { to: STATE_VIEW, data: SEL.v4slot0 + pad(p.id), k: 'slot0' },
    { to: STATE_VIEW, data: SEL.v4liq + pad(p.id), k: 'liquidity' },
  ];
  const out = [
    { to: p.id, data: SEL.slot0, k: 'slot0' },
    { to: p.id, data: SEL.liquidity, k: 'liquidity' },
    { to: p.id, data: SEL.fee, k: 'fee' },
  ];
  // Real coin balances (the bot caps V3 depth at what the pool really holds).
  for (const [i, t] of [p.t0, p.t1].entries()) if (t && t !== ZERO) out.push({ to: t, data: SEL.balanceOf + pad(p.id), k: `bal${i}` });
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let httpN = 0, limited = 0;
// One JSON-RPC batch with retries on rate limits / network errors.
async function batch(reqs) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      httpN++;
      const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reqs), signal: AbortSignal.timeout(20_000) });
      if (res.status === 429) { limited++; await sleep(1000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (!Array.isArray(j)) throw new Error('not a batch answer');
      if (j.some((x) => x?.error?.code === 429 || /rate|limit/i.test(x?.error?.message ?? ''))) { limited++; await sleep(1000 * (attempt + 1)); continue; }
      return j;
    } catch (e) { await sleep(800 * (attempt + 1)); }
  }
  return reqs.map((r) => ({ id: r.id, error: { message: 'gave up' } }));
}

// Run many eth_calls (each {to,data,tag}) in batches; returns results by index.
async function runCalls(calls, size = 40) {
  const out = new Array(calls.length).fill(null);
  for (let i = 0; i < calls.length; i += size) {
    const part = calls.slice(i, i + size);
    const reqs = part.map((c, j) => ({ jsonrpc: '2.0', id: i + j, method: 'eth_call', params: [{ to: c.to, data: c.data }, c.tag] }));
    const ans = await batch(reqs);
    for (const a of ans) out[a.id] = a.error ? { err: String(a.error.message ?? 'error').slice(0, 80) } : { r: a.result };
    await sleep(150);
  }
  return out;
}

const pools = new Map(input.pools.map((p) => [p.id, p]));
const head = await batch([{ jsonrpc: '2.0', id: 0, method: 'eth_blockNumber', params: [] }]);
const headBlock = parseInt(head[0].result, 16);
console.log(`head block ${headBlock}, ${pools.size} pools, ${input.hist.length} historical reads`);

// 1. Latest state of every pool.
const latestCalls = [];
for (const p of pools.values()) for (const c of callsFor(p)) latestCalls.push({ ...c, pool: p.id, tag: 'latest' });
const latestRes = await runCalls(latestCalls);
const latest = {};
latestCalls.forEach((c, i) => { (latest[c.pool] ??= {})[c.k] = latestRes[i]; });
console.log(`latest done (${httpN} http, ${limited} limited)`);

// 2. History probe: is old state still there? Try the oldest and newest asked blocks first.
const hist = {};
const blocks = [...new Set(input.hist.map((h) => h.block))].sort((a, b) => a - b);
let oldestOk = null;
if (blocks.length) {
  // Binary search for the oldest block whose state the node still serves.
  const anyPool = input.hist[0].id;
  const probe = async (b) => {
    const c = callsFor(pools.get(anyPool))[0];
    const r = await runCalls([{ ...c, tag: '0x' + b.toString(16) }]);
    return r[0] && r[0].r && r[0].r !== '0x';
  };
  let lo = blocks[0], hi = headBlock;
  if (await probe(lo)) oldestOk = lo;
  else {
    while (hi - lo > 2000) { const mid = Math.floor((lo + hi) / 2); if (await probe(mid)) hi = mid; else lo = mid; }
    oldestOk = hi;
  }
  console.log(`oldest block with state: ~${oldestOk} (${((headBlock - oldestOk) / 9.63 / 3600).toFixed(1)} h back)`);
  const want = input.hist.filter((h) => h.block >= oldestOk);
  const hc = [];
  for (const h of want) { const p = pools.get(h.id); if (!p) continue; for (const c of callsFor(p)) hc.push({ ...c, pool: h.id, block: h.block, tag: '0x' + h.block.toString(16) }); }
  const hr = await runCalls(hc);
  hc.forEach((c, i) => { ((hist[c.block] ??= {})[c.pool] ??= {})[c.k] = hr[i]; });
  console.log(`history: ${want.length} of ${input.hist.length} reads were recent enough`);
}

writeFileSync(outFile, JSON.stringify({ rpc: RPC, headBlock, readAtMs: Date.now(), oldestStateBlock: oldestOk, http: httpN, limited, latest, hist }));
console.log(`saved ${outFile} (${httpN} http, ${limited} limited)`);
