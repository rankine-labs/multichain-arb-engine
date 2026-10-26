// Read-only: classify the last N failed live sends using the chain itself.
// For each failed tx: receipt + revert reason, then replay the SAME call at
// earlier blocks to find when (if ever) it would have worked, and list other
// transactions that touched the same pools in between. Never sends anything.
const fs = require('fs');
const path = require('path');
const APP = path.join(process.env.HOME, 'multichain-arb-engine');
const { ethers } = require(path.join(APP, 'node_modules/ethers'));
const { EXECUTE_ABI } = require(path.join(APP, 'dist/execution/executorCalldata.js'));
const N = Number(process.argv[2] || 20);
const env = Object.fromEntries(fs.readFileSync(path.join(APP, '.env'), 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]));
const URL = env.CHAINSTACK_RPC_ROBINHOOD || env.QUICKNODE_RPC_ROBINHOOD;
let id = 0, calls = 0;
async function rpc(method, params) {
  calls++;
  const r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const j = await r.json();
  return j;
}
const iface = new ethers.Interface([...EXECUTE_ABI,
  'error BadRoute()', 'error Expired()', 'error FlashPoolNotAllowed(address pool)', 'error InsufficientProfit(uint256 got, uint256 wanted)',
  'error NotExecutor()', 'error Reentrancy()', 'error TokenBalanceDropped(address token)', 'error TransferFailed()', 'error UnauthorizedCallback()',
  'error UnexpectedEth()', 'error UnsupportedKind(uint8 kind)', 'error V4NotEnabled()', 'error ZeroAmount()']);
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const V4SWAP = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const hex = (n) => '0x' + n.toString(16);
function why(data) {
  if (!data || data === '0x') return 'revert (no reason)';
  try { const e = iface.parseError(data); return e.name + (e.name === 'InsufficientProfit' ? `(got ${e.args[0]}, wanted ${e.args[1]})` : e.args.length ? `(${[...e.args].join(',')})` : ''); }
  catch { try { return 'Error(' + ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10))[0] + ')'; } catch { return 'revert ' + data.slice(0, 10); } }
}
async function replay(tx, block) {
  const r = await rpc('eth_call', [{ from: tx.from, to: tx.to, data: tx.input, gas: tx.gas }, hex(block)]);
  if (!r.error) return { ok: true };
  const msg = r.error.message || '';
  if (/missing trie|state.*not available|historical|pruned|header not found/i.test(msg)) return { ok: null, why: 'state gone' };
  return { ok: false, why: why(r.error.data) };
}
const tsCache = new Map();
async function ts(b) { if (!tsCache.has(b)) { const r = await rpc('eth_getBlockByNumber', [hex(b), false]); tsCache.set(b, Number(r.result.timestamp)); } return tsCache.get(b); }
// Last block whose timestamp is before the given second (searching back from `hi`).
async function blockBefore(sec, hi) { let lo = hi - 400; while (lo < hi) { const m = Math.ceil((lo + hi) / 2); if ((await ts(m)) < sec) lo = m; else hi = m - 1; } return lo; }
function v4Id(h) {
  const [c0, c1] = h.tokenIn.toLowerCase() < h.tokenOut.toLowerCase() ? [h.tokenIn, h.tokenOut] : [h.tokenOut, h.tokenIn];
  const hooks = Number(h.kind) === 4 ? h.pool : ethers.ZeroAddress;
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint24', 'int24', 'address'], [c0, c1, h.v4Fee, h.v4TickSpacing, hooks]));
}
async function touches(hops, from, to) {
  const addrs = [...new Set(hops.filter((h) => Number(h.kind) < 3).map((h) => h.pool.toLowerCase()))];
  const ids = [...new Set(hops.filter((h) => Number(h.kind) >= 3).map(v4Id))];
  const out = [];
  if (addrs.length) { const r = await rpc('eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(to), address: addrs }]); for (const l of r.result || []) out.push(l); }
  if (ids.length) { const r = await rpc('eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(to), address: PM, topics: [V4SWAP, ids] }]); for (const l of r.result || []) out.push(l); }
  const txs = new Map();
  for (const l of out) txs.set(l.transactionHash, [Number(l.blockNumber), Number(l.transactionIndex)]);
  return [...txs.entries()].map(([h, [b, i]]) => ({ h, b, i })).sort((a, b) => a.b - b.b || a.i - b.i);
}
// Timing lines from the bot logs ("[fire] ... ready Xms ... (sign Yms, send Zms) tx HASH").
function fireLines() {
  const dir = path.join(process.env.HOME, '.pm2/logs');
  const m = new Map();
  for (const f of fs.readdirSync(dir).filter((f) => f.startsWith('dex-arb-shadow-out') && !f.endsWith('.gz'))) {
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!l.includes('[fire] robinhood LIVE')) continue;
      const h = (l.match(/tx (0x[0-9a-f]{64})/) || [])[1]; if (!h) continue;
      const g = (re) => { const x = l.match(re); return x ? Number(x[1]) : null; };
      m.set(h, { src: (l.match(/\((trade|gap|[a-z-]+)\) ready/) || [])[1], readyMs: g(/ready (\d+)ms/), signMs: g(/sign ([\d.]+)ms/), sendMs: g(/send ([\d.]+)ms/) });
    }
  }
  return m;
}
async function timingMode() {
  const lines = fs.readFileSync(path.join(APP, 'data/live-trades.jsonl'), 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const fl = fireLines();
  const out = [];
  for (const s of lines.filter((x) => x.kind === 'sent' && fl.has(x.hash))) {
    const tm = fl.get(s.hash);
    const rc = (await rpc('eth_getTransactionReceipt', [s.hash])).result; if (!rc) continue;
    const L = Number(rc.blockNumber);
    const startSec = Math.floor((s.t - (tm.sendMs || 0)) / 1000);
    const B0 = await blockBefore(startSec, L);
    out.push({ src: tm.src, readyMs: tm.readyMs, signMs: tm.signMs, sendMs: tm.sendMs, blocksToLand: L - B0, landMinusSendSec: (await ts(L)) - startSec, idx: Number(rc.transactionIndex) });
  }
  const q = (a, p) => { const v = a.filter((x) => x !== null && x !== undefined).sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : null; };
  const col = (k, f = () => true) => out.filter(f).map((o) => o[k]);
  console.log('TIMING n', out.length, 'trade', out.filter((o) => o.src === 'trade').length, 'gap', out.filter((o) => o.src === 'gap').length);
  for (const k of ['signMs', 'sendMs', 'blocksToLand', 'landMinusSendSec', 'idx']) console.log(k, 'p50', q(col(k), 0.5), 'p90', q(col(k), 0.9), 'max', q(col(k), 1));
  console.log('readyMs(trade only) p50', q(col('readyMs', (o) => o.src === 'trade'), 0.5), 'p90', q(col('readyMs', (o) => o.src === 'trade'), 0.9), 'max', q(col('readyMs', (o) => o.src === 'trade'), 1));
  console.log('sendMs over 1 s:', out.filter((o) => o.sendMs > 1000).length, 'over 250 ms:', out.filter((o) => o.sendMs > 250).length);
  console.log('rpc calls', calls);
}
(async () => {
  if (process.argv[3] === 'timing') return timingMode();
  const lines = fs.readFileSync(path.join(APP, 'data/live-trades.jsonl'), 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const sent = new Map(lines.filter((x) => x.kind === 'sent').map((x) => [x.hash, x]));
  const failed = lines.filter((x) => x.kind === 'result' && x.status !== 'profit').slice(-N);
  const fl = fireLines();
  const rows = [];
  for (const r of failed) {
    const s = sent.get(r.hash) || {};
    const tx = (await rpc('eth_getTransactionByHash', [r.hash])).result;
    const rc = (await rpc('eth_getTransactionReceipt', [r.hash])).result;
    if (!tx || !rc) { rows.push({ hash: r.hash, label: r.label, cls: 'unknown', note: 'no tx/receipt (dropped?)' }); continue; }
    const L = Number(rc.blockNumber), idx = Number(rc.transactionIndex);
    let dec = null; try { dec = iface.parseTransaction({ data: tx.input }); } catch {}
    const t = dec ? dec.args[0] : null;
    const hops = t ? [...t.hops].map((h) => ({ kind: h.kind, pool: h.pool, tokenIn: h.tokenIn, tokenOut: h.tokenOut, v4Fee: h.v4Fee, v4TickSpacing: h.v4TickSpacing })) : [];
    const tr = await rpc('debug_traceTransaction', [r.hash, { tracer: 'callTracer', tracerConfig: { onlyTopCall: true } }]);
    const reason = tr.result ? why(tr.result.output) : 'trace failed';
    // The trade log time is AFTER the node acknowledged the send; the send
    // itself started sendMs earlier (and the decision a little before that).
    const tm = fl.get(r.hash) || {};
    const sendSec = Math.floor(((s.t || 0) - (tm.sendMs || 0)) / 1000);
    const B0 = s.t ? await blockBefore(sendSec, L) : L - 4;
    const landTs = await ts(L);
    const row = { hash: r.hash.slice(0, 12), label: r.label, src: (fl.get(r.hash) || {}).src, L, idx, behind: L - B0, landSec: landTs - sendSec, reason, maxBlock: t ? Number(t.maxBlock) : null, gasUsd: r.gasUsd, exp: s.expectedProfitUsd ?? r.expectedProfitUsd, fund: s.funding, timing: fl.get(r.hash) || null };
    if (t && Number(t.maxBlock) && Number(t.maxBlock) < L) { row.cls = 'expired'; rows.push(row); continue; }
    if (!/^InsufficientProfit|^ZeroAmount/.test(reason)) { row.cls = /TransferFailed|FlashPool|BadRoute|TokenBalance|Unsupported|V4NotEnabled|Reentrancy|UnexpectedEth|Unauthorized|NotExecutor/.test(reason) ? 'funding/contract' : 'unknown'; rows.push(row); continue; }
    // Replay from 4 blocks before the send up to the block before ours.
    let lastOk = null, gone = false; const seq = [];
    for (let b = B0 - 6; b <= L - 1; b++) { const x = await replay(tx, b); seq.push(x.ok === null ? '?' : x.ok ? '+' : '-'); if (x.ok === null) gone = true; if (x.ok) lastOk = b; }
    row.replay = seq.join('');   // one char per block, B0-6 .. L-1 (+ works, - fails, ? state gone)
    row.lastOkVsLand = lastOk === null ? null : lastOk - L; // -1 = worked right before our block
    if (gone && lastOk === null) { row.cls = 'unknown'; row.note = 'old state not available'; rows.push(row); continue; }
    if (lastOk === null) { row.cls = 'incorrect predicted state'; row.note = 'never worked from 6 blocks before the send started to landing'; }
    else if (lastOk === L - 1) {
      const t2 = (await touches(hops, L, L)).filter((x) => x.b === L && x.i < idx);
      row.cls = t2.length ? 'rival first (same block, ahead of us)' : 'unknown'; row.rivals = t2.length; row.rival1 = t2[0]?.h?.slice(0, 12);
    } else {
      const t2 = (await touches(hops, lastOk + 1, L)).filter((x) => x.b < L || x.i < idx);
      row.cls = lastOk >= B0 ? 'rival first (after we sent)' : 'rival first (before we sent: our view was stale)';
      row.staleBlocks = lastOk >= B0 ? 0 : B0 - lastOk; row.rivals = t2.length; row.rival1 = t2[0]?.h?.slice(0, 12);
    }
    rows.push(row);
  }
  for (const r of rows) console.log(JSON.stringify(r));
  const c = {}; for (const r of rows) c[r.cls] = (c[r.cls] || 0) + 1;
  console.log('SUMMARY', JSON.stringify(c), 'rpc calls', calls);
})().catch((e) => console.log('ERROR', e.message));
