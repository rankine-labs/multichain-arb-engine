// ============================================================================
// UP CL / Fables DRIFT CHECKER (Nov 3). Read only, observe mode.
//
// Plain English:
//   Copy 2 (arbsim) keeps its own copy of every pool it follows. For the
//   Slipstream (UP CL, Raphael) pools and the hooked V4 (Fables) pools it
//   started following on Nov 2, this tool asks, every N blocks:
//     1. copy 2 (through its status socket, a normal "call" question): what
//        are this pool's price (sqrtPrice), tick, liquidity, fee values and
//        the tick data around the price, AT the copy's newest block B?
//     2. the chain (the FREE public node, not Chainstack): the very same
//        calls at the very same block B.
//   Both answers must be equal byte for byte. When they differ it logs by
//   how much (price gap in basis points) and what happened just before
//   (the pool's own events, its gauge's events, fee module / factory /
//   voter / hook events, copy 2's pool state and reload counters).
//
//   Never sends a transaction, never prints node URLs or keys. Copy 2 may
//   read a value it doesn't hold yet from its own node once (normal fill).
//
// Usage (on the server):
//   node scripts/copy2/upcl-drift-check.cjs [--every 40] [--hours 4]
//        [--out ~/rx/upcl/drift] [--pools 0xabc,0xdef] [--once]
//   Output: <out>/events.jsonl (one line per check that was not equal, plus
//   one line per round), <out>/summary.json (per pool totals, rewritten every
//   round), <out>/log.txt (short text lines).
// ============================================================================
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- settings from the command line -----------------------------------------
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes('--' + name);
const EVERY = Number(arg('every', '40'));            // blocks between rounds
const HOURS = Number(arg('hours', '4'));             // stop after this long
const OUT = arg('out', path.join(os.homedir(), 'rx/upcl/drift')).replace(/^~/, os.homedir());
const ONLY = (arg('pools', '') || '').toLowerCase().split(',').filter(Boolean);
const ONCE = flag('once');
const CONTROL = Number(arg('control', '3')); // plain V3 pools checked the same way (control group)
const SOCK = process.env.ARBSIM_SOCKET || '/tmp/arbsim.sock';
// The free public node (repo: src/config/robinhoodEndpoints.ts).
const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951'; // Uniswap V4 PoolManager (Robinhood)
const REPO = path.join(os.homedir(), 'multichain-arb-engine');

const { ethers } = require(path.join(REPO, 'node_modules/ethers'));
fs.mkdirSync(OUT, { recursive: true });
const EV = path.join(OUT, 'events.jsonl');
const LOG = path.join(OUT, 'log.txt');
const SUM = path.join(OUT, 'summary.json');
// Never let a URL reach a file or the screen.
const safe = (e) => String(e?.shortMessage || e?.message || e).replace(/(https?|wss?):\/\/\S+/g, '<url>').slice(0, 200);
const ts = () => new Date().toISOString().slice(11, 19);
const log = (s) => fs.appendFileSync(LOG, `${ts()} ${s}\n`);
const ev = (o) => fs.appendFileSync(EV, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');

// --- ABI helpers --------------------------------------------------------------
const sel = (sig) => ethers.id(sig).slice(0, 10);
const coder = ethers.AbiCoder.defaultAbiCoder();
const enc = (sig, types, vals) => sel(sig) + coder.encode(types, vals).slice(2);
const word = (hex, i) => BigInt('0x' + (hex.slice(2 + 64 * i, 66 + 64 * i) || '0'));
const int24 = (w) => { const t = Number(w & 0xffffffn); return t >= 1 << 23 ? t - (1 << 24) : t; };

// --- copy 2 status socket: 4-byte big-endian length + JSON, both ways --------
let reqId = 1;
function sockAsk(msg, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(SOCK);
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { c.destroy(); reject(new Error('socket timeout')); }, timeoutMs);
    c.on('connect', () => {
      const body = Buffer.from(JSON.stringify({ id: reqId++, ...msg }), 'utf8');
      const head = Buffer.alloc(4); head.writeUInt32BE(body.length, 0);
      c.write(Buffer.concat([head, body]));
    });
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4) {
        const n = buf.readUInt32BE(0);
        if (buf.length >= 4 + n) { clearTimeout(timer); c.end(); try { resolve(JSON.parse(buf.slice(4, 4 + n).toString('utf8'))); } catch (e) { reject(e); } }
      }
    });
    c.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// --- public node: JSON-RPC (batched), with a gentle retry ----------------------
async function rpcBatch(reqs) {
  const out = [];
  for (let i = 0; i < reqs.length; i += 40) {
    const part = reqs.slice(i, i + 40).map((r, j) => ({ jsonrpc: '2.0', id: i + j, method: r[0], params: r[1] }));
    let res;
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(PUBLIC_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(part), signal: AbortSignal.timeout(15000) });
        res = await r.json();
        if (Array.isArray(res)) break;
      } catch (e) { res = null; }
      await new Promise((r) => setTimeout(r, 1000 * (a + 1)));
    }
    if (!Array.isArray(res)) { for (let j = 0; j < part.length; j++) out.push({ error: 'public node did not answer' }); continue; }
    const byId = new Map(res.map((x) => [x.id, x]));
    for (const p of part) out.push(byId.get(p.id) || { error: 'missing' });
  }
  return out;
}
const rpc1 = async (m, p) => { const [r] = await rpcBatch([[m, p]]); if (r.error) throw new Error(safe(r.error.message || r.error)); return r.result; };

// --- per pool: what to compare -------------------------------------------------
// Slipstream pool: its own views, its factory's fee answers, the tick data
// (bitmap word and the two ticks around the price).
// CORE (what a quote needs: price, tick, liquidity, the swap fee) and EXTRA
// (fee / reward totals, tick data near the price). Asked separately so a value
// copy 2 doesn't hold yet (a "miss") in the extras never hides the core answer.
function slipCalls(p, tick, part) {
  if (part === 'core') {
    return [
      ['slot0', p.address, sel('slot0()')],
      ['liquidity', p.address, sel('liquidity()')],
      ['stakedLiquidity', p.address, sel('stakedLiquidity()')],
      ['fee', p.address, sel('fee()')],
      ['unstakedFee', p.address, sel('unstakedFee()')],
      ...(p.factory ? [['factorySwapFee', p.factory, enc('getSwapFee(address)', ['address'], [p.address])], ['factoryUnstakedFee', p.factory, enc('getUnstakedFee(address)', ['address'], [p.address])]] : []),
    ];
  }
  const c = [
    ['feeGrowth0', p.address, sel('feeGrowthGlobal0X128()')],
    ['feeGrowth1', p.address, sel('feeGrowthGlobal1X128()')],
    ['rewardGrowth', p.address, sel('rewardGrowthGlobalX128()')],
    ['rewardReserve', p.address, sel('rewardReserve()')],
  ];
  if (p.spacing && tick !== null) {
    const comp = Math.floor(tick / p.spacing);
    const lo = comp * p.spacing;
    c.push(['bitmapWord', p.address, enc('tickBitmap(int16)', ['int16'], [comp >> 8])]);
    c.push(['tickLo', p.address, enc('ticks(int24)', ['int24'], [lo])]);
    c.push(['tickHi', p.address, enc('ticks(int24)', ['int24'], [lo + p.spacing])]);
  }
  return c;
}
// Hooked V4 pool: its storage in the PoolManager (_pools[id], slot 6):
// slot0, fee growth x2, liquidity, and the tick bitmap word around the price.
function v4Calls(p, tick, part) {
  const base = BigInt(ethers.keccak256(coder.encode(['bytes32', 'uint256'], [p.id, 6n])));
  if (part === 'core') return [['poolStorage', PM, enc('extsload(bytes32[])', ['bytes32[]'], [[0n, 3n].map((i) => ethers.toBeHex(base + i, 32))])]];
  const slots = [1n, 2n].map((i) => ethers.toBeHex(base + i, 32));
  if (p.spacing && tick !== null) {
    const w = Math.floor(tick / p.spacing) >> 8;
    slots.push(ethers.keccak256(coder.encode(['int16', 'uint256'], [w, base + 5n])));
  }
  return [['poolStorageX', PM, enc('extsload(bytes32[])', ['bytes32[]'], [slots])]];
}

// Price gap between two sqrtPriceX96 values, in basis points of price.
function priceGapBps(a, b) {
  if (a === 0n || b === 0n) return null;
  const r = Number((a * 10n ** 12n) / b) / 1e12; // sqrt ratio
  return Math.round((r * r - 1) * 1e6) / 100;
}
// Compare one pool's answers; return the list of differences (empty = equal).
function diffOf(p, names, mine, chain) {
  const d = [];
  for (let i = 0; i < names.length; i++) {
    const a = (mine[i] || '').toLowerCase(), b = (chain[i] || '').toLowerCase();
    if (a === b) continue;
    const x = { what: names[i] };
    if (names[i] === 'slot0' && a.length >= 130 && b.length >= 130) {
      x.copySqrt = word(a, 0).toString(); x.chainSqrt = word(b, 0).toString();
      x.copyTick = int24(word(a, 1)); x.chainTick = int24(word(b, 1));
      x.priceGapBps = priceGapBps(word(a, 0), word(b, 0));
    } else if (names[i] === 'poolStorage' || names[i] === 'poolStorageX') {
      // extsload(bytes32[]) answer: offset, length, words.
      const n = Number(word(a, 1));
      const lab = names[i] === 'poolStorage' ? ['slot0', 'liquidity'] : ['feeGrowth0', 'feeGrowth1', 'bitmapWord'];
      x.parts = [];
      for (let k = 0; k < n; k++) {
        const wa = word(a, 2 + k), wb = word(b, 2 + k);
        if (wa === wb) continue;
        const part = { what: lab[k], copy: '0x' + wa.toString(16), chain: '0x' + wb.toString(16) };
        if (lab[k] === 'slot0') {
          const m = (1n << 160n) - 1n;
          part.priceGapBps = priceGapBps(wa & m, wb & m);
          part.copyTick = int24(wa >> 160n); part.chainTick = int24(wb >> 160n);
          part.copyLpFee = Number((wa >> 208n) & 0xffffffn); part.chainLpFee = Number((wb >> 208n) & 0xffffffn);
        }
        x.parts.push(part);
      }
    } else {
      x.copy = a.length > 140 ? a.slice(0, 140) + '..' : a; x.chain = b.length > 140 ? b.slice(0, 140) + '..' : b;
      if (a.length === 66 && b.length === 66) { const wa = BigInt(a), wb = BigInt(b); x.change = (wa - wb).toString(); if (wb !== 0n) x.changePct = Math.round(Number(((wa - wb) * 1000000n) / wb)) / 10000; }
    }
    d.push(x);
  }
  return d;
}

// --- which pools: copy 2's own list (status with pools) -----------------------
// Slipstream pools: kind "slipstream". Hooked V4 pools: kind "v4" whose id
// is a Fables / listed hooked pool (the status list has no hook field; ids
// come from ~/rx/follow/fables-pools.json and src/config/robinhoodHookedPools.ts),
// or the status "hooked" field when arbsim gives it.
function hookedIds() {
  const s = new Map();
  try { for (const x of JSON.parse(fs.readFileSync(path.join(os.homedir(), 'rx/follow/fables-pools.json'), 'utf8'))) s.set(String(x.id).toLowerCase(), { sym: x.sym, spacing: Number(x.ts) || null }); } catch {}
  try { for (const m of fs.readFileSync(path.join(REPO, 'src/config/robinhoodHookedPools.ts'), 'utf8').matchAll(/0x[0-9a-fA-F]{64}/g)) if (!s.has(m[0].toLowerCase())) s.set(m[0].toLowerCase(), { sym: null, spacing: null }); } catch {}
  return s;
}

// Static facts of a pool, read once from the public node (factory, gauge,
// fee modules, voter, tick spacing; V4: hook from Initialize is not needed).
const facts = new Map();
async function factsOf(p) {
  if (facts.has(p.key)) return facts.get(p.key);
  const f = { factory: null, gauge: null, spacing: null, watch: [], sym: p.sym || null };
  try {
    if (p.kind === 'slipstream') {
      const call = (to, sig) => rpc1('eth_call', [{ to, data: sel(sig) }, 'latest']);
      const addrOf = (h) => (h && h.length >= 66 ? '0x' + h.slice(26, 66) : null);
      f.factory = addrOf(await call(p.address, 'factory()'));
      f.gauge = addrOf(await call(p.address, 'gauge()'));
      f.spacing = int24(BigInt(await call(p.address, 'tickSpacing()')));
      for (const sig of ['swapFeeModule()', 'unstakedFeeModule()', 'voter()']) { try { const a = addrOf(await call(f.factory, sig)); if (a && !/^0x0+$/.test(a)) f.watch.push(a); } catch {} }
      f.watch.push(f.factory);
      const sym = async (t) => { try { return coder.decode(['string'], await rpc1('eth_call', [{ to: t, data: sel('symbol()') }, 'latest']))[0]; } catch { return '?'; } };
      if (!f.sym) f.sym = `${await sym(p.token0)}/${await sym(p.token1)}`;
    } else {
      f.spacing = p.spacing; // V4 (from the Fables list) / control V3: nothing to look up
    }
  } catch (e) { log(`facts ${p.key.slice(0, 10)} failed: ${safe(e)}`); }
  facts.set(p.key, f);
  return f;
}

// Events just before a difference: the pool's own, its gauge's, its fee
// modules' / factory's / voter's (V4: the PoolManager events of its id).
const TOPIC_NAMES = {};
for (const s of ['Swap(address,address,int256,int256,uint160,uint128,int24)', 'Mint(address,address,int24,int24,uint128,uint256,uint256)', 'Burn(address,int24,int24,uint128,uint256,uint256)', 'Collect(address,address,int24,int24,uint128,uint128)', 'CollectFees(uint128,uint128)', 'Flash(address,address,uint256,uint256,uint256,uint256)', 'Deposit(address,uint256,uint128)', 'Withdraw(address,uint256,uint128)', 'ClaimRewards(address,uint256)', 'NotifyReward(address,uint256)', 'Transfer(address,address,uint256)', 'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)', 'ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)', 'Donate(bytes32,address,uint256,uint256)', 'SetCustomFee(address,uint24)', 'DistributeReward(address,address,uint256)', 'GaugeKilled(address)', 'GaugeRevived(address)']) TOPIC_NAMES[ethers.id(s)] = s.split('(')[0];
async function eventsBefore(p, f, from, to) {
  const out = [];
  const addrs = p.kind === 'slipstream' ? [p.address, ...(f.gauge && !/^0x0+$/.test(f.gauge) ? [f.gauge] : []), ...f.watch] : p.kind === 'v3' ? [p.address] : [];
  const reqs = [];
  if (addrs.length) reqs.push(['eth_getLogs', [{ address: addrs, fromBlock: ethers.toQuantity(from), toBlock: ethers.toQuantity(to) }]]);
  if (p.kind === 'v4') reqs.push(['eth_getLogs', [{ address: PM, topics: [null, p.id], fromBlock: ethers.toQuantity(from), toBlock: ethers.toQuantity(to) }]]);
  const res = await rpcBatch(reqs);
  for (const r of res) {
    if (r.error) { out.push({ error: safe(r.error.message || r.error) }); continue; }
    for (const l of r.result || []) {
      const a = l.address.toLowerCase();
      const who = a === p.address ? 'pool' : a === f.gauge ? 'gauge' : a === PM ? 'poolManager' : a === f.factory ? 'factory' : 'feeModuleOrVoter';
      out.push({ block: Number(l.blockNumber), tx: l.transactionHash.slice(0, 12), who, event: TOPIC_NAMES[l.topics[0]] || l.topics[0].slice(0, 10) });
    }
  }
  return out.slice(-40);
}

// --- per pool totals ------------------------------------------------------------
const tot = {}; // key -> {sym, kind, checks, equal, differ, copyUnknown, notReady, chainError, maxGapBps, firstDiff, lastDiff, diffWhat}
const T = (p) => (tot[p.key] = tot[p.key] || { sym: p.sym, kind: p.kind, checks: 0, equal: 0, differ: 0, copyUnknown: 0, notReady: 0, chainError: 0, maxGapBps: 0, firstDiff: null, lastDiff: null, diffWhat: {}, unknownWhy: {}, notReadyWhy: {}, chainErrorWhy: {}, matchOffset: {}, parts: {}, lastEqualBlock: null });
const lastTick = new Map();
const lastEqual = new Map();
const started = Date.now();
let counters0 = null;

// Calls for one pool and one part ('core' / 'extra'); control V3 pools: core only.
function callsOf(p, part) {
  const tick = lastTick.get(p.key) ?? null;
  if (p.kind === 'slipstream') return slipCalls(p, tick, part);
  if (p.kind === 'v4') return v4Calls(p, tick, part);
  return part === 'core' ? [['slot0', p.address, sel('slot0()')], ['liquidity', p.address, sel('liquidity()')], ['fee', p.address, sel('fee()')]] : [];
}

// Ask copy 2 and the chain; count and log. Returns 'equal' / 'differ' /
// 'unknown' (copy 2 had no answer) / 'chainError' / 'none' (no calls).
async function checkPart(p, f, t, part, counters) {
  const calls = callsOf(p, part);
  if (!calls.length) return 'none';
  const pt = (t.parts[part] = t.parts[part] || { equal: 0, differ: 0, copyUnknown: 0, chainError: 0 });
  const bump = (o, w) => { o[w] = (o[w] || 0) + 1; };
  // 1. copy 2's answer at its newest block.
  let a;
  try { a = await sockAsk({ type: 'call', at: { after: 'head' }, calls: calls.map(([, to, data]) => ({ to, data })) }); } catch (e) { pt.copyUnknown++; bump(t.unknownWhy, part + ' socket: ' + safe(e)); return 'unknown'; }
  if (!a.ok) { pt.copyUnknown++; bump(t.unknownWhy, part + ' ' + String(a.unknown || 'unknown') + (a.detail ? ': ' + String(a.detail).slice(0, 40) : '')); return 'unknown'; }
  const block = Number(BigInt(a.at.block));
  // 2. the chain's answer at the same block (public node).
  const res = await rpcBatch(calls.map(([, to, data]) => ['eth_call', [{ to, data }, ethers.toQuantity(block)]]));
  const bad = res.find((r) => r.error && !/revert/i.test(JSON.stringify(r.error)));
  if (bad) { pt.chainError++; bump(t.chainErrorWhy, safe(bad.error.message || bad.error).slice(0, 60)); return 'chainError'; }
  const mine = a.results.map((r) => (r.success ? r.output : 'revert'));
  const chain = res.map((r) => (r.error ? 'revert' : r.result));
  if (part === 'core') {
    try {
      if (p.kind === 'v4') lastTick.set(p.key, int24(word(chain[0], 2) >> 160n));
      else lastTick.set(p.key, int24(word(chain[0], 1)));
    } catch {}
  }
  const d = diffOf(p, calls.map((c) => c[0]), mine, chain);
  if (!d.length) { pt.equal++; if (part === 'core') { t.equal++; t.lastEqualBlock = block; lastEqual.set(p.key, block); } return 'equal'; }
  pt.differ++;
  if (part === 'core') { t.differ++; t.firstDiff = t.firstDiff ?? block; t.lastDiff = block; }
  for (const x of d) bump(t.diffWhat, x.what);
  const gap = d.map((x) => x.priceGapBps ?? (x.parts || []).map((y) => y.priceGapBps).find((v) => v != null)).find((v) => v != null);
  if (gap != null && Math.abs(gap) > Math.abs(t.maxGapBps)) t.maxGapBps = gap;
  // 3. Which chain block does copy 2's answer match? (B-2..B+2: tells a
  //    one-block lag / lead apart from a real wrong value.)
  let matchesBlock = null;
  try {
    const offs = [-2, -1, 1, 2];
    const rs = await rpcBatch(offs.flatMap((o) => calls.map(([, to, data]) => ['eth_call', [{ to, data }, ethers.toQuantity(block + o)]])));
    offs.forEach((o, i) => {
      const c = rs.slice(i * calls.length, (i + 1) * calls.length).map((r) => (r.error ? 'revert' : r.result));
      if (matchesBlock === null && !diffOf(p, calls.map((x) => x[0]), mine, c).length) matchesBlock = o;
    });
  } catch {}
  bump(t.matchOffset, String(matchesBlock));
  // 4. What happened just before (since the last time it was equal, max 3000 blocks).
  const from = Math.max(block - 3000, (lastEqual.get(p.key) ?? block - 300) + 1);
  let before = [];
  try { before = await eventsBefore(p, f, from, block + 2); } catch (e) { before = [{ error: safe(e) }]; }
  ev({ kind: 'differ', part, pool: p.key, sym: t.sym, poolKind: p.kind, block, matchesBlock, lastEqual: lastEqual.get(p.key) ?? null, copyEvents: p.events, diffs: d, before, counters });
  log(`DIFF ${part} ${t.sym || ''} ${p.key.slice(0, 10)} @${block} copy=chain@${matchesBlock === null ? 'none' : (matchesBlock > 0 ? '+' : '') + matchesBlock} ${d.map((x) => x.what + (x.priceGapBps != null ? `(${x.priceGapBps}bps)` : '')).join(',')} before:${before.map((b) => (b.block - block) + b.who + ':' + b.event).slice(-6).join(' ')}`);
  return 'differ';
}

async function round() {
  const st = await sockAsk({ type: 'status', pools: true }, 30000);
  const c2 = st.copy2;
  if (!c2 || !Array.isArray(c2.list)) { log('status has no copy2 pool list'); return; }
  const hooked = hookedIds();
  const pools = [];
  for (const e of c2.list) {
    const addr = String(e.address).toLowerCase();
    if (e.kind === 'slipstream') pools.push({ key: addr, kind: 'slipstream', address: addr, state: e.state, reason: e.reason, events: e.events, token0: e.token0, token1: e.token1 });
    else if (e.kind === 'v4' && e.v4Id && (e.hooked || hooked.has(String(e.v4Id).toLowerCase()))) {
      const h = hooked.get(String(e.v4Id).toLowerCase()) || {};
      pools.push({ key: String(e.v4Id).toLowerCase(), kind: 'v4', address: PM, id: String(e.v4Id).toLowerCase(), state: e.state, reason: e.reason, events: e.events, sym: h.sym, spacing: h.spacing || e.tickSpacing || null });
    }
  }
  // Control group (--control N): N plain Uniswap V3 pools copy 2 has long
  // followed, most events first. They should always match: if they do not,
  // the checker (block alignment), not the UP CL logic, is wrong.
  const v3 = c2.list.filter((e) => e.kind === 'v3' && e.state === 'ready').sort((x, y) => y.events - x.events).slice(0, CONTROL);
  for (const e of v3) pools.push({ key: String(e.address).toLowerCase(), kind: 'v3', address: String(e.address).toLowerCase(), state: e.state, reason: e.reason, events: e.events, sym: 'control-v3' });
  const wanted = ONLY.length ? pools.filter((p) => ONLY.some((o) => p.key.startsWith(o))) : pools;
  // copy 2 counters that tell what happened (reloads by gauge, watched events, ...)
  const cn = c2.counters || {};
  const pick = (o) => ({ watchEvents: o.watch_events, watchReloads: o.watch_reloads, watchVerifies: o.watch_verifies, watchSameBlock: o.watch_same_block_unsure, unfollowed: o.unfollowed_changed });
  const counters = pick(cn);
  // Slipstream token addresses are not in the status list: read from chain once.
  let equal = 0, differ = 0, unknown = 0, notReady = 0;
  for (const p of wanted) {
    const t = T(p);
    t.checks++;
    if (p.state !== 'ready') { t.notReady++; notReady++; const w = String(p.reason || p.state).slice(0, 80); t.notReadyWhy[w] = (t.notReadyWhy[w] || 0) + 1; continue; }
    if (p.kind === 'slipstream' && !p.token0 && !facts.has(p.key)) {
      try { p.token0 = '0x' + (await rpc1('eth_call', [{ to: p.address, data: sel('token0()') }, 'latest'])).slice(26); p.token1 = '0x' + (await rpc1('eth_call', [{ to: p.address, data: sel('token1()') }, 'latest'])).slice(26); } catch {}
    }
    const f = await factsOf(p);
    if (!t.sym && f.sym) t.sym = f.sym;
    p.factory = f.factory; p.spacing = p.spacing || f.spacing;
    for (const part of ['core', 'extra']) {
      const r = await checkPart(p, f, t, part, counters);
      if (part === 'core') {
        if (r === 'equal') { equal++; } else if (r === 'differ') { differ++; } else if (r === 'unknown') { unknown++; }
        if (r !== 'equal') break; // extras only when the core matched
      }
    }
  }
  counters0 = counters0 || counters;
  ev({ kind: 'round', block: c2.lastBlock, pools: wanted.length, equal, differ, unknown, notReady, counters, byKind: c2.byKind });
  log(`round @${c2.lastBlock} pools ${wanted.length}: equal ${equal}, differ ${differ}, copy unknown ${unknown}, not ready ${notReady}`);
  fs.writeFileSync(SUM, JSON.stringify({ since: new Date(started).toISOString(), now: new Date().toISOString(), counters0, counters, pools: tot }, null, 1));
}

(async () => {
  log(`start: every ${EVERY} blocks, ${HOURS} h, out ${OUT}`);
  let lastBlock = 0;
  while (Date.now() - started < HOURS * 3600e3) {
    try {
      const s = await sockAsk({ type: 'status' }, 30000);
      const b = s?.copy2?.lastBlock || 0;
      if (b && b - lastBlock >= EVERY) { lastBlock = b; await round(); if (ONCE) break; }
    } catch (e) { log('round failed: ' + safe(e)); }
    await new Promise((r) => setTimeout(r, 2000));
  }
  log('done');
})();
