// Read-only probe 2: for a hooked V4 pool and an UP CL pool, what does a swap read / write
// OUTSIDE the pool, and do those outside values change between the pool's own swaps
// (i.e. by transactions that emit no event of the pool)? Compact output. Never prints node URLs.
const path = '/home/ubuntu/multichain-arb-engine/';
const { ethers } = require(path + 'node_modules/ethers');
const fs = require('fs');
const env = Object.fromEntries(fs.readFileSync(path + '.env', 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, '').trim()]; }));
const p = new ethers.JsonRpcProvider(env.CHAINSTACK_RPC_ROBINHOOD || env.ROBINHOOD_RPC_HTTP, 4663, { staticNetwork: true });
const OUT = process.env.HOME + '/rx/follow/' + (process.argv[2] || 'probe2') + '.txt';
const out = []; const log = (...a) => { out.push(a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); fs.writeFileSync(OUT, out.join('\n') + '\n'); };
const safe = (e) => String(e?.shortMessage || e?.message || e).replace(/https?:\/\/\S+/g, '<url>').slice(0, 160);
const s10 = (a) => a.slice(0, 10);
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const V4SWAP = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const V3SWAP = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
async function logsBack(filter, head, span, step, max) {
  const all = [];
  for (let to = head; to > head - span && all.length < max; to -= step) {
    try { all.unshift(...await p.getLogs({ ...filter, fromBlock: Math.max(0, to - step + 1), toBlock: to })); } catch (e) { step = Math.max(500, step >> 1); to += step; }
  }
  return all;
}
// Per swap tx: outside accounts touched (read slots / written slots), and calls made.
async function study(label, poolAddr, swaps, own) {
  const outside = {}; const callsSeen = {};
  let prevPost = null; let drift = 0, compared = 0; const driftSlots = {};
  for (const sw of swaps) {
    let pre, diff, ct;
    try {
      pre = await p.send('debug_traceTransaction', [sw.transactionHash, { tracer: 'prestateTracer' }]);
      diff = await p.send('debug_traceTransaction', [sw.transactionHash, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }]);
      ct = await p.send('debug_traceTransaction', [sw.transactionHash, { tracer: 'callTracer' }]);
    } catch (e) { log(label, 'trace err', safe(e)); continue; }
    // calls made by the pool / PoolManager / hook (where swap code runs)
    const walk = (c, inPool) => {
      const from = c.from.toLowerCase(), to = (c.to || '').toLowerCase();
      const inside = inPool || to === poolAddr;
      if (inside && to !== poolAddr) { const k = `${s10(from)}->${s10(to)}:${(c.input || '').slice(0, 10)}`; callsSeen[k] = (callsSeen[k] || 0) + 1; }
      (c.calls || []).forEach((x) => walk(x, inside));
    };
    walk(ct, false);
    for (const a of Object.keys(pre)) {
      if (!own.includes(a)) continue;
      const r = Object.keys(pre[a].storage || {}); const w = Object.keys(diff.post?.[a]?.storage || {});
      const o = outside[a] || (outside[a] = { read: new Set(), wrote: new Set() }); r.forEach((x) => o.read.add(x)); w.forEach((x) => o.wrote.add(x));
    }
    // drift: values the swap READ in `own` accounts vs what the previous swap of this pool left
    if (prevPost) {
      for (const a of own) for (const [slot, v] of Object.entries(pre[a]?.storage || {})) {
        if (prevPost[a]?.[slot] === undefined) continue;
        compared++;
        if (BigInt(prevPost[a][slot]) !== BigInt(v)) { drift++; const k = `${s10(a)}:${slot.slice(0, 12)}`; driftSlots[k] = (driftSlots[k] || 0) + 1; }
      }
    }
    // state after this tx = pre overlaid with diff.post (diff.post has changed slots only)
    prevPost = {};
    for (const a of own) { prevPost[a] = { ...(pre[a]?.storage || {}) }; for (const [s, v] of Object.entries(diff.post?.[a]?.storage || {})) prevPost[a][s] = v; for (const s of Object.keys(diff.pre?.[a]?.storage || {})) if (!(s in (diff.post?.[a]?.storage || {}))) prevPost[a][s] = '0x0'; }
  }
  log(`${label}: ${swaps.length} swaps studied, blocks ${swaps[0]?.blockNumber}..${swaps[swaps.length - 1]?.blockNumber}`);
  for (const [a, o] of Object.entries(outside)) log(`  ${label} ${s10(a)}: slots read ${o.read.size}, written ${o.wrote.size}`);
  log(`  ${label} calls from swap code:`, Object.entries(callsSeen).sort((x, y) => y[1] - x[1]).slice(0, 25).map(([k, n]) => `${k} x${n}`).join(' | '));
  log(`  ${label} DRIFT between own swaps: ${drift} of ${compared} read values changed by someone else`, JSON.stringify(driftSlots).slice(0, 600));
}
(async () => {
  const head = await p.getBlockNumber();
  log('head', head);
  const pools = JSON.parse(fs.readFileSync(process.env.HOME + '/rx/follow/fables-pools.json', 'utf8'));
  const eai = pools.find((x) => x.sym === 'ETH/AI');
  const aiu = pools.find((x) => x.sym === 'AI/USDG');
  for (const [label, t] of [['FABLES ETH/AI', eai], ['FABLES AI/USDG', aiu]]) {
    if (!t) { log(label, 'not found'); continue; }
    log(label, 'id', t.id, 'hook', t.hooks, 'spacing', t.ts);
    const sw = await logsBack({ address: PM, topics: [V4SWAP, t.id] }, head, 600000, 50000, 12);
    await study(label, PM, sw.slice(-10), [t.hooks.toLowerCase()]);
  }
  // events of the ETH/AI hook
  if (eai) {
    const hl = await logsBack({ address: eai.hooks }, head, 600000, 50000, 2000);
    const byT = {}; for (const l of hl) byT[l.topics[0].slice(0, 12)] = (byT[l.topics[0].slice(0, 12)] || 0) + 1;
    log('ETH/AI hook events last 600k blocks:', byT, 'n', hl.length);
  }
  // UP CL WETH/AI
  const UPF = '0x1ac9dB4a2608ba45D6127B1737949b51Bb54B7F3';
  const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
  const AI = eai ? (eai.c0 === '0x0000000000000000000000000000000000000000' ? eai.c1 : eai.c0) : null;
  const f = new ethers.Contract(UPF, ['function getPool(address,address,int24) view returns (address)', 'function swapFeeModule() view returns (address)', 'function unstakedFeeModule() view returns (address)', 'function poolImplementation() view returns (address)'], p);
  let up = null;
  for (const ts of [1, 10, 50, 100, 200, 2000]) { try { const a = await f.getPool(WETH, AI, ts); if (a !== ethers.ZeroAddress) { log('UPCL WETH/AI spacing', ts, a); up = up || a.toLowerCase(); } } catch {} }
  const mods = [];
  for (const fn of ['swapFeeModule', 'unstakedFeeModule', 'poolImplementation']) { try { const m = await f[fn](); log('UPCL factory', fn, m); mods.push(m.toLowerCase()); } catch { log('UPCL factory', fn, 'fails'); } }
  if (up) {
    const code = await p.getCode(up); log('UPCL pool code bytes', (code.length - 2) / 2, code.length < 120 ? code : '');
    const pc = new ethers.Contract(up, ['function fee() view returns (uint24)', 'function unstakedFee() view returns (uint24)', 'function gauge() view returns (address)', 'function nft() view returns (address)', 'function tickSpacing() view returns (int24)', 'function stakedLiquidity() view returns (uint128)'], p);
    const info = {}; for (const fn of ['fee', 'unstakedFee', 'gauge', 'nft', 'tickSpacing', 'stakedLiquidity']) { try { info[fn] = String(await pc[fn]()); } catch { info[fn] = 'fails'; } } log('UPCL pool', info);
    const sw = await logsBack({ address: up, topics: [V3SWAP] }, head, 600000, 50000, 12);
    await study('UPCL WETH/AI', up, sw.slice(-10), [up, UPF.toLowerCase(), ...mods, ...(info.gauge && info.gauge !== 'fails' ? [info.gauge.toLowerCase()] : [])]);
    const pl = await logsBack({ address: up }, head, 600000, 50000, 3000);
    const byP = {}; for (const l of pl) byP[l.topics[0].slice(0, 12)] = (byP[l.topics[0].slice(0, 12)] || 0) + 1; log('UPCL pool events:', byP);
    const ml = await logsBack({ address: [UPF, ...mods] }, head, 600000, 50000, 2000);
    const byM = {}; for (const l of ml) { const k = s10(l.address) + ':' + l.topics[0].slice(0, 12); byM[k] = (byM[k] || 0) + 1; } log('UPCL factory/module events:', byM);
  }
  log('done');
})().catch((e) => log('fatal', safe(e)));
