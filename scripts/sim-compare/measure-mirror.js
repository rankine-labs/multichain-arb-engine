#!/usr/bin/env node
// ============================================================================
// MEASURE: would a "your pools only" copy keep up, cheaply? (read only)
//
// Plain English:
//   For a range of recent blocks, finds every transaction that touched one of
//   the bot's watched pools (from the pools' own events), then asks the node
//   which accounts and storage slots each of those transactions read or
//   wrote (prestateTracer). From that it works out:
//     - how many "trades on our pools" happen per second
//     - how much chain data replaying them needs
//     - how fast that data set stops growing (a warm copy only needs the NEW
//       items each second from the node = the daily node cost of option A)
//     - how well a cheap filter ("transaction mentions one of our pools or
//       known routers") would catch them, so we know if we can pick the right
//       transactions from the live feed without running all of them
//   Writes <out>/measure.json and prints a plain summary.
//
// Safety: reads only. From the bot's .env it reads ONLY the --node URL line
// (never printed). Sends nothing, signs nothing.
//
// Run:  node measure-mirror.js --from N --to M [--out DIR] [--rps 4]
//                              [--node CHAINSTACK_RPC_ROBINHOOD] [--max-txs 3000]
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');

const BOT_DIR = process.env.BOT_DIR || `${process.env.HOME}/multichain-arb-engine`;
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const FROM = Number(arg('from'));
const TO = Number(arg('to'));
const OUT = arg('out', `${process.env.HOME}/sim-compare-runs/measure1`);
const RPS = Number(arg('rps', '4'));
const NODE_VAR = arg('node', 'CHAINSTACK_RPC_ROBINHOOD');
const MAX_TXS = Number(arg('max-txs', '3000'));
if (!Number.isFinite(FROM) || !Number.isFinite(TO) || TO < FROM) { console.error('need --from and --to block numbers'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

// Node URL: only the one .env line named by --node; never printed.
function nodeUrl() {
  if (process.env[NODE_VAR]) return process.env[NODE_VAR];
  const text = fs.readFileSync(path.join(BOT_DIR, '.env'), 'utf8');
  const m = text.match(new RegExp(`^\\s*${NODE_VAR}\\s*=\\s*["']?([^"'\\s#]+)`, 'm'));
  if (!m) throw new Error(`${NODE_VAR} not found in .env`);
  return m[1];
}
const NODE = nodeUrl();
let id = 0, last = 0, requests = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Paced JSON-RPC (RPS per second), one retry on busy/network errors.
async function rpc(method, params) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = last + 1000 / RPS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    requests++;
    try {
      const r = await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      if (j.error && /limit|busy|429|timeout/i.test(j.error.message || '')) { await sleep(2000); continue; }
      return j;
    } catch (e) { await sleep(1000); }
  }
  return { error: { message: 'gave up after retries' } };
}
const lc = (s) => String(s).toLowerCase();

// Watched pools (the bot's own list) and their coins.
const watch = JSON.parse(fs.readFileSync(path.join(BOT_DIR, 'data', 'watched-pools.json'), 'utf8'));
const pools = (watch.pools || []).filter((p) => p && p.chain === 'robinhood' && p.poolAddress);
const poolSet = new Set(pools.map((p) => lc(p.poolAddress)));
const tokenSet = new Set(pools.flatMap((p) => [p.tokenA, p.tokenB]).filter(Boolean).map(lc));

async function main() {
  console.log(`watch list: ${poolSet.size} pools, ${tokenSet.size} coins; blocks ${FROM}-${TO} (${TO - FROM + 1})`);
  // 1. Every log our pools emitted in the range (chunks of 200 addresses x 250 blocks).
  const addrs = [...poolSet];
  const txs = new Map(); // hash -> { block, index }
  for (let b = FROM; b <= TO; b += 250) {
    const e = Math.min(TO, b + 249);
    for (let i = 0; i < addrs.length; i += 200) {
      const r = await rpc('eth_getLogs', [{ fromBlock: '0x' + b.toString(16), toBlock: '0x' + e.toString(16), address: addrs.slice(i, i + 200) }]);
      if (r.error) { console.log(`getLogs ${b}-${e}: ${String(r.error.message).slice(0, 100)}`); continue; }
      for (const l of r.result || []) txs.set(lc(l.transactionHash), { block: parseInt(l.blockNumber, 16), index: parseInt(l.transactionIndex, 16) });
    }
  }
  const list = [...txs.entries()].sort((a, b) => a[1].block - b[1].block || a[1].index - b[1].index).slice(0, MAX_TXS);
  console.log(`transactions touching our pools: ${txs.size} (measuring ${list.length})`);

  // 2. For each: what it read/wrote (prestateTracer) + its to/input (cheap-filter test).
  const seen = new Set();          // every account / slot needed so far
  const curve = [];                // cumulative unique items after each tx
  const perTx = [];
  const toCounts = new Map();
  let filterHit = 0, traced = 0, failed = 0;
  const knownTo = new Set();       // "to" addresses seen in earlier relevant txs (routers, pools)
  for (const [hash, pos] of list) {
    const [tr, tx] = [await rpc('debug_traceTransaction', [hash, { tracer: 'prestateTracer' }]), await rpc('eth_getTransactionByHash', [hash])];
    if (tr.error || !tr.result || !tx.result) { failed++; continue; }
    traced++;
    let items = 0, fresh = 0;
    for (const [a, acct] of Object.entries(tr.result)) {
      const keys = [`a:${lc(a)}`, ...Object.keys(acct.storage || {}).map((s) => `s:${lc(a)}:${lc(s)}`)];
      for (const k of keys) { items++; if (!seen.has(k)) { seen.add(k); fresh++; } }
    }
    const to = lc(tx.result.to || '');
    const input = lc(tx.result.input || '');
    // Cheap filter: sent straight to a pool or to a contract seen before in a
    // relevant tx, or its data mentions one of our pools or coins.
    const mentions = [...poolSet].some((p) => input.includes(p.slice(2))) || [...tokenSet].some((t) => input.includes(t.slice(2)));
    const hit = poolSet.has(to) || knownTo.has(to) || mentions;
    if (hit) filterHit++;
    knownTo.add(to);
    toCounts.set(to, (toCounts.get(to) || 0) + 1);
    curve.push(seen.size);
    perTx.push({ hash, block: pos.block, items, fresh, hit });
    if (traced % 100 === 0) console.log(`${traced}/${list.length} traced · unique items ${seen.size} · node requests ${requests}`);
  }

  // 3. Summary.
  const seconds = (TO - FROM + 1) / 4; // Robinhood ~4 blocks/s (owner brief)
  const half = Math.floor(perTx.length / 2);
  const freshLate = perTx.slice(half).reduce((s, t) => s + t.fresh, 0);
  const lateSeconds = seconds * (perTx.length - half) / Math.max(1, perTx.length);
  const freshPerSec = lateSeconds > 0 ? freshLate / lateSeconds : null;
  const summary = {
    blocks: TO - FROM + 1, approxSeconds: seconds, poolTxs: txs.size, traced, failed,
    poolTxsPerSecond: +(txs.size / seconds).toFixed(2),
    avgItemsPerTx: +(perTx.reduce((s, t) => s + t.items, 0) / Math.max(1, perTx.length)).toFixed(1),
    uniqueItemsTotal: seen.size,
    newItemsPerSecondSecondHalf: freshPerSec !== null ? +freshPerSec.toFixed(2) : null,
    estNodeReadsPerDayWhenWarm: freshPerSec !== null ? Math.round(freshPerSec * 86400) : null,
    cheapFilterCatches: `${filterHit}/${traced}`,
    topTo: [...toCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
    curveEvery100: curve.filter((_, i) => i % 100 === 99),
    nodeRequestsUsed: requests,
  };
  fs.writeFileSync(path.join(OUT, 'measure.json'), JSON.stringify(summary, null, 1));
  fs.writeFileSync(path.join(OUT, 'per-tx.jsonl'), perTx.map((t) => JSON.stringify(t)).join('\n') + '\n');
  console.log('SUMMARY ' + JSON.stringify(summary));
}
main().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
