// Read-only probe: what a Fables (hooked V4) and an UP CL (Slipstream) swap read and write,
// and which events their outside contracts emit. Never prints node URLs.
const path = '/home/ubuntu/multichain-arb-engine/';
const { ethers } = require(path + 'node_modules/ethers');
const fs = require('fs');
const env = Object.fromEntries(fs.readFileSync(path + '.env', 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, '').trim()]; }));
const url = env.CHAINSTACK_RPC_ROBINHOOD || env.ROBINHOOD_RPC_HTTP;
const p = new ethers.JsonRpcProvider(url, 4663, { staticNetwork: true });
const out = []; const log = (...a) => { const s = a.map((x) => typeof x === 'string' ? x : JSON.stringify(x, (k, v) => typeof v === 'bigint' ? v.toString() : v)).join(' '); out.push(s); };
const safe = (e) => String(e?.shortMessage || e?.message || e).replace(/https?:\/\/\S+/g, '<url>').slice(0, 200);
const PM = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'.toLowerCase();
const REG = '0x159a113e012593d9b3cc63ad45e30f0467e13ef3';
const UPF = '0x1ac9dB4a2608ba45D6127B1737949b51Bb54B7F3';
const iReg = new ethers.Interface(['function activePools() view returns (tuple(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bytes32 id, bool active)[])']);
const V4SWAP = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const V3SWAP = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
const sym = async (a) => { if (a === ethers.ZeroAddress) return 'ETH'; try { return ethers.AbiCoder.defaultAbiCoder().decode(['string'], await p.call({ to: a, data: '0x95d89b41' }))[0]; } catch { return '?'; } };
async function logsBack(filter, head, span, step) {
  const all = [];
  for (let to = head; to > head - span && all.length < 400; to -= step) {
    try { all.push(...await p.getLogs({ ...filter, fromBlock: Math.max(0, to - step + 1), toBlock: to })); } catch (e) { log('getLogs err', safe(e)); step = Math.max(1000, step >> 1); }
  }
  return all;
}
async function traceTx(h, label, focus) {
  try {
    const ct = await p.send('debug_traceTransaction', [h, { tracer: 'callTracer' }]);
    const calls = [];
    const walk = (c, d) => { calls.push(`${'  '.repeat(d)}${c.type} ${c.from.slice(0, 10)}->${c.to?.slice(0, 10)} ${c.input?.slice(0, 10)}${c.error ? ' ERR ' + c.error : ''}`); (c.calls || []).forEach((x) => walk(x, d + 1)); };
    walk(ct, 0);
    log(`${label} callTracer (${calls.length} calls):`); calls.slice(0, 60).forEach((c) => log('  ' + c));
    const pd = await p.send('debug_traceTransaction', [h, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }]);
    const pre = await p.send('debug_traceTransaction', [h, { tracer: 'prestateTracer' }]);
    for (const a of focus) {
      const k = a.toLowerCase();
      const read = Object.keys(pre[k]?.storage || {}).length;
      const wrote = Object.keys(pd.post?.[k]?.storage || {}).length;
      log(`  ${label} ${a}: slots read ${read}, slots written ${wrote}`, wrote ? Object.keys(pd.post[k].storage).slice(0, 12) : '');
    }
    log(`  ${label} accounts read:`, Object.keys(pre).map((x) => x.slice(0, 10) + ':' + Object.keys(pre[x].storage || {}).length));
    log(`  ${label} accounts written:`, Object.keys(pd.post || {}).map((x) => x.slice(0, 10) + ':' + Object.keys(pd.post[x].storage || {}).length));
  } catch (e) { log('trace err', safe(e)); }
}
(async () => {
  const head = await p.getBlockNumber();
  log('head', head);
  // ---- Fables ----
  const raw = iReg.decodeFunctionResult('activePools', await p.call({ to: REG, data: iReg.encodeFunctionData('activePools') }))[0];
  const pools = raw.map((r) => ({ id: r.id, c0: r.key.currency0.toLowerCase(), c1: r.key.currency1.toLowerCase(), fee: Number(r.key.fee), ts: Number(r.key.tickSpacing), hooks: r.key.hooks.toLowerCase(), active: r.active }));
  const hooks = [...new Set(pools.map((x) => x.hooks))];
  log('fables pools', pools.length, 'hooks', hooks.length, 'fees', [...new Set(pools.map((x) => x.fee))]);
  let target = null;
  for (const x of pools) { const s0 = await sym(x.c0), s1 = await sym(x.c1); x.sym = `${s0}/${s1}`; if (/^AI$/.test(s0) || /^AI$/.test(s1)) target = x; }
  log('fables WETH/AI', target);
  for (const h of hooks) { const code = await p.getCode(h); log('hook', h, 'code bytes', (code.length - 2) / 2, 'pools', pools.filter((x) => x.hooks === h).map((x) => x.sym).join(',')); }
  if (target) {
    const sw = await logsBack({ address: PM, topics: [V4SWAP, target.id] }, head, 400000, 50000);
    log('fables WETH/AI swaps found', sw.length);
    if (sw.length) await traceTx(sw[sw.length - 1].transactionHash, 'FABLES', [target.hooks, PM]);
    if (sw.length > 1) await traceTx(sw[0].transactionHash, 'FABLES2', [target.hooks, PM]);
  }
  // events of every hook (what changes hook storage outside swaps?)
  const hl = await logsBack({ address: hooks }, head, 400000, 50000);
  const byT = {}; for (const l of hl) { const k = l.address.slice(0, 10) + ' ' + l.topics[0].slice(0, 12); byT[k] = (byT[k] || 0) + 1; }
  log('hook events (last 400k blocks):', byT);
  const lastHookLog = hl.filter((l) => target && l.address.toLowerCase() === target.hooks).slice(-1)[0];
  if (lastHookLog) { log('last WETH/AI hook event', lastHookLog.blockNumber, lastHookLog.topics[0].slice(0, 12)); await traceTx(lastHookLog.transactionHash, 'HOOKEV', [target.hooks]); }
  fs.writeFileSync(process.env.HOME + '/rx/follow/fables-pools.json', JSON.stringify(pools, null, 1));
  // ---- UP CL ----
  const f = new ethers.Contract(UPF, ['function getPool(address,address,int24) view returns (address)', 'function swapFeeModule() view returns (address)', 'function unstakedFeeModule() view returns (address)', 'function owner() view returns (address)', 'function poolImplementation() view returns (address)'], p);
  const ai = target ? (target.sym.startsWith('AI') ? target.c0 : target.c1) : null;
  for (const fn of ['swapFeeModule', 'unstakedFeeModule', 'poolImplementation', 'owner']) { try { log('upcl factory', fn, await f[fn]()); } catch (e) { log('upcl factory', fn, 'fails'); } }
  let up = null;
  if (ai) for (const ts of [1, 10, 50, 100, 200, 2000]) { try { const a = await f.getPool(WETH, ai, ts); if (a !== ethers.ZeroAddress) { log('upcl WETH/AI spacing', ts, a); up = up || a; } } catch {} }
  if (up) {
    const code = await p.getCode(up); log('upcl pool code bytes', (code.length - 2) / 2, code.length < 200 ? code : '');
    const pc = new ethers.Contract(up, ['function slot0() view returns (uint160,int24,uint16,uint16,uint16,bool)', 'function fee() view returns (uint24)', 'function unstakedFee() view returns (uint24)', 'function gauge() view returns (address)', 'function nft() view returns (address)', 'function liquidity() view returns (uint128)', 'function stakedLiquidity() view returns (uint128)', 'function factory() view returns (address)'], p);
    for (const fn of ['slot0', 'fee', 'unstakedFee', 'gauge', 'nft', 'liquidity', 'stakedLiquidity', 'factory']) { try { log('upcl', fn, await pc[fn]()); } catch (e) { log('upcl', fn, 'fails'); } }
    const s = []; for (let i = 0; i < 24; i++) s.push(i + ':' + (await p.getStorage(up, i)).replace(/^0x0+/, '0x')); log('upcl storage 0..23', s.join(' '));
    const sw = await logsBack({ address: up, topics: [V3SWAP] }, head, 400000, 50000);
    log('upcl WETH/AI swaps found', sw.length);
    const mods = []; try { mods.push(await f.swapFeeModule()); } catch {} try { mods.push(await f.unstakedFeeModule()); } catch {}
    if (sw.length) await traceTx(sw[sw.length - 1].transactionHash, 'UPCL', [up, UPF, ...mods]);
    const ml = await logsBack({ address: [UPF, ...mods] }, head, 400000, 50000);
    const byM = {}; for (const l of ml) { const k = l.address.slice(0, 10) + ' ' + l.topics[0].slice(0, 12); byM[k] = (byM[k] || 0) + 1; }
    log('upcl factory/module events (last 400k):', byM);
    const pl = await logsBack({ address: up }, head, 400000, 50000);
    const byP = {}; for (const l of pl) { const k = l.topics[0].slice(0, 12); byP[k] = (byP[k] || 0) + 1; } log('upcl pool events (last 400k):', byP);
  }
})().catch((e) => log('fatal', safe(e))).finally(() => fs.writeFileSync(process.env.HOME + '/rx/follow/probe1.txt', out.join('\n') + '\n'));
