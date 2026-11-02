// Read-only probe 3: are outside changes ALWAYS announced by an event?
//  Fables: the hook slots a swap reads, sampled every STEP blocks over SPAN blocks;
//          every change must fall in an interval holding an event of that hook.
//  UP CL:  pool slots that changed between two own swaps with NO pool event between
//          them, and whether a gauge event explains each. Never prints node URLs.
const path = '/home/ubuntu/multichain-arb-engine/';
const { ethers } = require(path + 'node_modules/ethers');
const fs = require('fs');
const env = Object.fromEntries(fs.readFileSync(path + '.env', 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, '').trim()]; }));
const p = new ethers.JsonRpcProvider(env.CHAINSTACK_RPC_ROBINHOOD || env.ROBINHOOD_RPC_HTTP, 4663, { staticNetwork: true });
const OUT = process.env.HOME + '/rx/follow/probe3.txt';
const out = []; const log = (...a) => { out.push(a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); fs.writeFileSync(OUT, out.join('\n') + '\n'); };
const safe = (e) => String(e?.shortMessage || e?.message || e).replace(/https?:\/\/\S+/g, '<url>').slice(0, 160);
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const V4SWAP = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const V3SWAP = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
const SPAN = Number(process.argv[2] || 600000), STEP = Number(process.argv[3] || 2000);
async function logsRange(filter, from, to, step) {
  const all = [];
  for (let a = from; a <= to; a += step) { const b = Math.min(to, a + step - 1); try { all.push(...await p.getLogs({ ...filter, fromBlock: a, toBlock: b })); } catch (e) { if (step <= 500) { log('getLogs fail', safe(e)); continue; } all.push(...await logsRange(filter, a, b, step >> 1)); } }
  return all;
}
async function lastSwap(filter, head) { for (let to = head; to > head - SPAN; to -= 50000) { const l = await logsRange(filter, to - 49999, to, 50000); if (l.length) return l[l.length - 1]; } return null; }
async function sampleCheck(label, acct, slots, evFilter, head) {
  const from = head - SPAN;
  const ev = (await logsRange(evFilter, from, head, 50000)).map((l) => l.blockNumber).sort((a, b) => a - b);
  let prev = null, changes = 0, explained = 0; const unexplained = [];
  for (let b = from; b <= head; b += STEP) {
    let vals;
    try { vals = await Promise.all(slots.map((s) => p.getStorage(acct, s, b))); } catch (e) { log(label, 'read fail', b, safe(e)); continue; }
    if (prev) slots.forEach((s, i) => { if (prev.v[i] !== vals[i]) { changes++; const has = ev.some((x) => x > prev.b && x <= b); if (has) explained++; else unexplained.push(`${s.slice(0, 8)}@${prev.b}-${b}`); } });
    prev = { b, v: vals };
  }
  log(`${label}: ${slots.length} slots sampled every ${STEP} blocks over ${SPAN}; events ${ev.length}; value changes ${changes}, with an event in the same interval ${explained}, WITHOUT ${unexplained.length}`, unexplained.slice(0, 8).join(' '));
}
(async () => {
  const head = await p.getBlockNumber(); log('head', head);
  const pools = JSON.parse(fs.readFileSync(process.env.HOME + '/rx/follow/fables-pools.json', 'utf8'));
  for (const sym of ['ETH/AI', 'AI/USDG']) {
    const t = pools.find((x) => x.sym === sym); if (!t) continue;
    const sw = await lastSwap({ address: PM, topics: [V4SWAP, t.id] }, head); if (!sw) { log(sym, 'no swap'); continue; }
    const pre = await p.send('debug_traceTransaction', [sw.transactionHash, { tracer: 'prestateTracer' }]);
    const slots = Object.keys(pre[t.hooks]?.storage || {});
    log(`FABLES ${sym} hook ${t.hooks.slice(0, 10)} slots a swap reads:`, slots.map((s) => s.slice(0, 14)).join(' '));
    await sampleCheck(`FABLES ${sym}`, t.hooks, slots, { address: t.hooks }, head);
  }
  // UP CL WETH/AI: gauge events, and swaps with no pool event between them
  const up = '0x1e49a549e9fbbc09e95f7126dce2071511868ade';
  const gauge = '0xddabc5fc33f359d0c52d783d2091a101ca79e05f';
  const ge = await logsRange({ address: gauge }, head - SPAN, head, 50000);
  const byG = {}; for (const l of ge) byG[l.topics[0].slice(0, 12)] = (byG[l.topics[0].slice(0, 12)] || 0) + 1;
  log('UPCL gauge events', byG, 'n', ge.length);
  const pe = await logsRange({ address: up }, head - SPAN, head, 50000);
  const swaps = pe.filter((l) => l.topics[0] === V3SWAP);
  let pairs = 0, drifted = 0, byGauge = 0; const which = {};
  for (let i = swaps.length - 1; i > 0 && pairs < 25; i--) {
    const a = swaps[i - 1], b = swaps[i];
    const between = pe.filter((l) => (l.blockNumber > a.blockNumber || (l.blockNumber === a.blockNumber && l.index > a.index)) && (l.blockNumber < b.blockNumber || (l.blockNumber === b.blockNumber && l.index < b.index)));
    if (between.length) continue;
    pairs++;
    let preB, diffA, preA;
    try {
      preA = await p.send('debug_traceTransaction', [a.transactionHash, { tracer: 'prestateTracer' }]);
      diffA = await p.send('debug_traceTransaction', [a.transactionHash, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }]);
      preB = await p.send('debug_traceTransaction', [b.transactionHash, { tracer: 'prestateTracer' }]);
    } catch (e) { log('trace err', safe(e)); continue; }
    const after = { ...(preA[up]?.storage || {}), ...(diffA.post?.[up]?.storage || {}) };
    let d = false;
    for (const [s, v] of Object.entries(preB[up]?.storage || {})) { if (after[s] !== undefined && BigInt(after[s]) !== BigInt(v)) { d = true; which[s] = (which[s] || 0) + 1; } }
    if (d) { drifted++; if (ge.some((l) => l.blockNumber >= a.blockNumber && l.blockNumber <= b.blockNumber)) byGauge++; }
  }
  log(`UPCL WETH/AI: ${pairs} swap pairs with no pool event between; ${drifted} saw pool values change anyway; ${byGauge} of those had a gauge event between`, JSON.stringify(which).slice(0, 500));
  log('done');
})().catch((e) => log('fatal', safe(e)));
