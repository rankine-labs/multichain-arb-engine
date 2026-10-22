#!/usr/bin/env node
// ============================================================================
// LIVE DRY RUN of the fast check's pool copy (read only, bot untouched)
//
// Plain English:
//   Proves the sidecar's live copy of the chain is right, BEFORE the bot uses
//   it. It runs next to the bot as a completely separate program:
//     1. opens its OWN connection to Robinhood's public sequencer feed and
//        passes every message to a test sidecar (its own socket, not the
//        bot's), exactly like the bot will in practice mode
//     2. tells the sidecar which pools to keep (the bot's watch list file)
//     3. every few seconds picks a random watched pool and asks BOTH the
//        sidecar and the paid node for the pool's price state at the SAME
//        block (V2 getReserves, V3 slot0 + liquidity), and compares them
//        byte for byte
//     4. every minute saves the sidecar's own health numbers
//   Results: one JSON line per probe in <out>/probes.jsonl, status lines in
//   <out>/status.jsonl, and a running summary on screen.
//
// Safety: reads only. Sends nothing to the chain, signs nothing. From the
// bot's .env it reads ONLY the node URL line named by --node (never printed).
//
// Run:  node live-dryrun.js --socket /tmp/arbsim-test.sock --out ~/sim-compare-runs/live1
//         [--minutes 60] [--probe-every-s 5] [--node CHAINSTACK_RPC_ROBINHOOD]
// ============================================================================
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');

const BOT_DIR = process.env.BOT_DIR || `${process.env.HOME}/multichain-arb-engine`;
// ws comes from the bot's own installed packages (no new install on the server).
const WebSocket = require(path.join(BOT_DIR, 'node_modules', 'ws'));

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const SOCKET = arg('socket', '/tmp/arbsim-test.sock');
const OUT = arg('out', `${process.env.HOME}/sim-compare-runs/live1`);
const MINUTES = Number(arg('minutes', '60'));
const PROBE_MS = Number(arg('probe-every-s', '5')) * 1000;
const NODE_VAR = arg('node', 'CHAINSTACK_RPC_ROBINHOOD');
const FEED_URL = arg('feed', 'wss://feed.mainnet.chain.robinhood.com');
fs.mkdirSync(OUT, { recursive: true });

// --- node URL: only the one .env line asked for, never printed ---
function nodeUrl() {
  if (process.env[NODE_VAR]) return process.env[NODE_VAR];
  const text = fs.readFileSync(path.join(BOT_DIR, '.env'), 'utf8');
  const m = text.match(new RegExp(`^\\s*${NODE_VAR}\\s*=\\s*["']?([^"'\\s#]+)`, 'm'));
  if (!m) throw new Error(`${NODE_VAR} not found in .env`);
  return m[1];
}
const NODE = nodeUrl();
let rpcId = 0;
async function rpc(method, params) {
  const r = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(8000) });
  return r.json();
}

// --- sidecar client: 4-byte big-endian length + JSON, answers matched by id ---
let sock = null, buf = Buffer.alloc(0), nextId = 1;
const pending = new Map();
function connect() {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCKET);
    s.once('connect', () => { sock = s; resolve(); });
    s.once('error', reject);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const n = buf.readUInt32BE(0);
        if (buf.length < 4 + n) break;
        const msg = JSON.parse(buf.subarray(4, 4 + n).toString('utf8'));
        buf = buf.subarray(4 + n);
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p(msg); }
      }
    });
    s.on('close', () => { console.log('sidecar connection closed'); process.exit(2); });
  });
}
function send(obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  const h = Buffer.alloc(4); h.writeUInt32BE(b.length, 0);
  sock.write(Buffer.concat([h, b]));
}
function ask(obj, timeoutMs = 5000) {
  const id = nextId++;
  return new Promise((resolve) => {
    const t = setTimeout(() => { pending.delete(id); resolve({ id, ok: false, timeout: true }); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    send({ ...obj, id });
  });
}

// --- watch list: pools + their coins (from the bot's own file) ---
function watchList() {
  const d = JSON.parse(fs.readFileSync(path.join(BOT_DIR, 'data', 'watched-pools.json'), 'utf8'));
  const pools = (d.pools || []).filter((p) => p && p.chain === 'robinhood' && p.poolAddress && (p.poolType === 'v2' || p.poolType === 'v3'));
  return pools.map((p) => ({ addr: p.poolAddress.toLowerCase(), type: p.poolType, dex: p.dex, tokens: [p.tokenA, p.tokenB].map((t) => t.toLowerCase()) }));
}

// Price-state reads per pool type (same calls on both sides).
const CALLS = { v2: ['0x0902f1ac'], v3: ['0x3850c7bd', '0x1a686502'] }; // getReserves | slot0, liquidity
const hex = (n) => '0x' + BigInt(n).toString(16);

const stats = { probes: 0, same: 0, different: 0, unknown: 0, nodeErr: 0, frames: 0, unknownWhy: {} };
const probesFile = fs.createWriteStream(path.join(OUT, 'probes.jsonl'), { flags: 'a' });
const statusFile = fs.createWriteStream(path.join(OUT, 'status.jsonl'), { flags: 'a' });

async function probe(pools) {
  const p = pools[Math.floor(Math.random() * pools.length)];
  const calls = CALLS[p.type].map((data) => ({ from: '0x0000000000000000000000000000000000000b07', to: p.addr, data, gas: '0x1e8480', value: '0x0' }));
  const t0 = Date.now();
  const fast = await ask({ type: 'call', at: { after: 'head' }, overrides: {}, calls });
  const ms = Date.now() - t0;
  stats.probes++;
  if (!fast.ok) {
    stats.unknown++;
    const why = fast.unknown || (fast.timeout ? 'timeout' : (fast.error || 'error'));
    stats.unknownWhy[why] = (stats.unknownWhy[why] || 0) + 1;
    probesFile.write(JSON.stringify({ t: Date.now(), pool: p.addr, type: p.type, fast: 'unknown', why, ms }) + '\n');
    return;
  }
  // The block the sidecar answered at: its replayed feed position (feed message
  // N = L2 block N on Robinhood), else its confirmed base block.
  const at = fast.at || {};
  const block = at.seq !== undefined && at.seq !== null ? hex(at.seq) : at.block;
  const results = [];
  for (const c of calls) {
    const r = await rpc('eth_call', [{ to: c.to, data: c.data, from: c.from }, block]);
    if (r.error && !/revert/i.test(r.error.message || '')) { stats.nodeErr++; probesFile.write(JSON.stringify({ t: Date.now(), pool: p.addr, nodeErr: String(r.error.message).slice(0, 120), block }) + '\n'); return; }
    results.push(r.error ? { success: false } : { success: true, output: r.result });
  }
  let same = true;
  fast.results.forEach((f, i) => {
    const n = results[i];
    if (!!f.success !== n.success || (n.success && String(f.output).toLowerCase() !== String(n.output).toLowerCase())) same = false;
  });
  if (same) stats.same++; else stats.different++;
  probesFile.write(JSON.stringify({ t: Date.now(), pool: p.addr, dex: p.dex, type: p.type, block, at, same, ms, ...(same ? {} : { fast: fast.results, node: results }) }) + '\n');
}

async function main() {
  await connect();
  const pools = watchList();
  const accounts = [...new Set(pools.flatMap((p) => [p.addr, ...p.tokens]))];
  const w = await ask({ type: 'warm', accounts }, 20000);
  console.log(`watch list: ${pools.length} V2/V3 pools, ${accounts.length} accounts sent to warm (${w.ok ? 'ok' : 'NOT ok'})`);

  // Feed: our own connection, frames forwarded untouched (fire and forget).
  let ws;
  const openFeed = () => {
    ws = new WebSocket(FEED_URL);
    ws.on('message', (data) => { stats.frames++; send({ id: 0, type: 'feed', frame: data.toString('utf8') }); });
    ws.on('close', () => { console.log('feed closed, reconnecting in 2 s'); setTimeout(openFeed, 2000); });
    ws.on('error', (e) => console.log(`feed error: ${e.message}`));
  };
  openFeed();

  const end = Date.now() + MINUTES * 60_000;
  // Give the copy a minute to warm up before probing.
  setTimeout(() => {
    const timer = setInterval(() => { probe(pools).catch((e) => console.log(`probe error: ${e.message}`)); }, PROBE_MS);
    setTimeout(() => { clearInterval(timer); finish(); }, Math.max(0, end - Date.now()));
  }, 60_000);
  setInterval(async () => {
    const s = await ask({ type: 'status' }, 5000);
    statusFile.write(JSON.stringify({ t: Date.now(), ...s }) + '\n');
    const answered = stats.same + stats.different;
    console.log(`${new Date().toISOString().slice(11, 19)} frames ${stats.frames} | probes ${stats.probes}: same ${stats.same}/${answered} (${answered ? (100 * stats.same / answered).toFixed(1) : '-'}%), different ${stats.different}, unknown ${stats.unknown} ${JSON.stringify(stats.unknownWhy)}, node errors ${stats.nodeErr} | sidecar rss ${s.rssMb ?? '?'} MB`);
  }, 60_000);

  function finish() {
    const answered = stats.same + stats.different;
    const summary = { ...stats, answered, matchPct: answered ? +(100 * stats.same / answered).toFixed(2) : null, minutes: MINUTES };
    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
    console.log('DONE', JSON.stringify(summary));
    setTimeout(() => process.exit(0), 500);
  }
}
main().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
