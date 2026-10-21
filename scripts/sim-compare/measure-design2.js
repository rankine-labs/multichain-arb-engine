#!/usr/bin/env node
// ============================================================================
// VERIFY DESIGN 2 (read only): "pairs we trade" copy, updated from pool events,
// trigger replay with the trader's own balances assumed.
//
// Plain English:
//   Uses only the pools of pairs that trade on 2+ exchanges (where arbitrage
//   is possible), from the bot's watch list. For every transaction in a block
//   range that touched those pools it asks the node:
//     (a) what the transaction READ (prestateTracer)
//     (b) what it CHANGED (prestateTracer diffMode)
//   and answers the three questions the design depends on:
//     Q1  How often do these pools change? (events per second)
//     Q2  What chain data does replaying a trigger need, by kind:
//           our pools | pools' coin balances | the trader's own data
//           (assumed in the design, never fetched) | other contracts
//           (routers etc.: fetched once, then cached)
//         -> node lookups per day once warm = NEW "other" items per second
//     Q3  When one of our pools trades, which of its storage slots change,
//         and how many different slots per pool type? (decides whether the
//         pool's events are enough to keep the copy exact)
//   Writes <out>/design2.json + a plain summary.
//
// Safety: reads only; reads ONLY the --node URL line from the bot's .env.
// Run: node measure-design2.js --from N --to M [--out DIR] [--rps 4] [--max-txs 1500]
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const BOT_DIR = process.env.BOT_DIR || `${process.env.HOME}/multichain-arb-engine`;
const { ethers } = require(path.join(BOT_DIR, 'node_modules', 'ethers'));

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const FROM = Number(arg('from')), TO = Number(arg('to'));
const OUT = arg('out', `${process.env.HOME}/sim-compare-runs/design2`);
const RPS = Number(arg('rps', '4'));
const NODE_VAR = arg('node', 'CHAINSTACK_RPC_ROBINHOOD');
const MAX_TXS = Number(arg('max-txs', '1500'));
fs.mkdirSync(OUT, { recursive: true });

function nodeUrl() {
  if (process.env[NODE_VAR]) return process.env[NODE_VAR];
  const m = fs.readFileSync(path.join(BOT_DIR, '.env'), 'utf8').match(new RegExp(`^\\s*${NODE_VAR}\\s*=\\s*["']?([^"'\\s#]+)`, 'm'));
  if (!m) throw new Error(`${NODE_VAR} not in .env`);
  return m[1];
}
const NODE = nodeUrl();
let id = 0, last = 0, requests = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params) {
  for (let a = 0; a < 3; a++) {
    const w = last + 1000 / RPS - Date.now(); if (w > 0) await sleep(w);
    last = Date.now(); requests++;
    try {
      const j = await (await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(20000) })).json();
      if (j.error && /limit|busy|429|timeout/i.test(j.error.message || '')) { await sleep(2000); continue; }
      return j;
    } catch { await sleep(1000); }
  }
  return { error: { message: 'gave up' } };
}
const lc = (s) => String(s).toLowerCase();

// --- "pairs we trade": pairs with pools on 2+ different exchanges ---
const watch = JSON.parse(fs.readFileSync(path.join(BOT_DIR, 'data', 'watched-pools.json'), 'utf8'));
const all = (watch.pools || []).filter((p) => p && p.chain === 'robinhood' && p.poolAddress && p.tokenA && p.tokenB);
const byPair = new Map();
for (const p of all) {
  const k = [lc(p.tokenA), lc(p.tokenB)].sort().join('/');
  (byPair.get(k) || byPair.set(k, []).get(k)).push(p);
}
const pools = new Map(); // addr -> { type, dex, pair }
for (const [k, list] of byPair) {
  if (new Set(list.map((p) => p.dex)).size < 2) continue;
  for (const p of list) pools.set(lc(p.poolAddress), { type: `${p.dex}:${p.poolType}`, pair: k });
}
const tokens = new Set([...pools.values()].flatMap((p) => p.pair.split('/')));

// Pools' own coin-balance slots (so they're not mistaken for traders' balances),
// using the balance-slot locations the bot already learned (data/balance-slots.json).
let slotSpecs = {};
try { slotSpecs = JSON.parse(fs.readFileSync(path.join(BOT_DIR, 'data', 'balance-slots.json'), 'utf8')); } catch { /* none */ }
const abi = ethers.AbiCoder.defaultAbiCoder();
const poolBalanceKeys = new Set();
const specByToken = new Map();
const balKey = (spec, holder) => lc(spec.layout === 'vyper' ? ethers.keccak256(abi.encode(['uint256', 'address'], [spec.slot, holder])) : ethers.keccak256(abi.encode(['address', 'uint256'], [holder, spec.slot])));
for (const [k, spec] of Object.entries(slotSpecs)) {
  if (spec && (spec.layout === 'solidity' || spec.layout === 'vyper')) specByToken.set(lc(k.split(':').pop()), spec);
  const token = lc(k.split(':').pop());
  if (!tokens.has(token) || !spec) continue;
  for (const addr of pools.keys()) {
    const key = spec.layout === 'vyper' ? ethers.keccak256(abi.encode(['uint256', 'address'], [spec.slot, addr])) : ethers.keccak256(abi.encode(['address', 'uint256'], [addr, spec.slot]));
    poolBalanceKeys.add(`${token}:${lc(key)}`);
  }
}

async function main() {
  console.log(`pairs on 2+ exchanges: ${[...byPair.values()].filter((l) => new Set(l.map((p) => p.dex)).size >= 2).length} of ${byPair.size}; pools ${pools.size} of ${all.length}; coins ${tokens.size}; known pool-balance keys ${poolBalanceKeys.size}`);
  // Q1: transactions touching these pools.
  const addrs = [...pools.keys()];
  const txs = new Map(); let events = 0;
  for (let b = FROM; b <= TO; b += 250) {
    const e = Math.min(TO, b + 249);
    for (let i = 0; i < addrs.length; i += 200) {
      const r = await rpc('eth_getLogs', [{ fromBlock: '0x' + b.toString(16), toBlock: '0x' + e.toString(16), address: addrs.slice(i, i + 200) }]);
      for (const l of r.result || []) { events++; txs.set(lc(l.transactionHash), { block: parseInt(l.blockNumber, 16), index: parseInt(l.transactionIndex, 16) }); }
    }
  }
  const list = [...txs.entries()].sort((a, b) => a[1].block - b[1].block || a[1].index - b[1].index).slice(0, MAX_TXS);
  console.log(`events ${events}, transactions ${txs.size} (measuring ${list.length})`);

  // Q2 + Q3.
  const seen = { pool: new Set(), poolBalance: new Set(), trader: new Set(), other: new Set(), code: new Set() };
  const fresh = { pool: 0, poolBalance: 0, trader: 0, other: 0, code: 0 };
  const freshLate = { pool: 0, poolBalance: 0, trader: 0, other: 0, code: 0 };
  const changed = new Map(); // type -> { swaps, slotCounts: Map(slot->n), perSwap: [] }
  let done = 0;
  for (const [hash, pos] of list) {
    const [pre, diff, tx] = [await rpc('debug_traceTransaction', [hash, { tracer: 'prestateTracer' }]), await rpc('debug_traceTransaction', [hash, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }]), await rpc('eth_getTransactionByHash', [hash])];
    if (!pre.result || !diff.result || !tx.result) continue;
    const late = done >= list.length / 2;
    const from = lc(tx.result.from);
    const note = (cat, key) => { if (!seen[cat].has(key)) { seen[cat].add(key); fresh[cat]++; if (late) freshLate[cat]++; } };
    for (const [a0, acct] of Object.entries(pre.result)) {
      const a = lc(a0);
      if (acct.code && acct.code !== '0x') note('code', a);
      const cat = pools.has(a) ? 'pool' : tokens.has(a) ? 'token' : a === from ? 'trader' : 'other';
      if (cat !== 'token') note(cat === 'pool' ? 'pool' : cat, `a:${a}`);
      for (const s of Object.keys(acct.storage || {})) {
        if (cat === 'pool') note('pool', `${a}:${lc(s)}`);
        // Coin slots: our pools' balances (from events) | the trader's OWN balance
        // (assumed "enough", never fetched) | anything else, e.g. routers'
        // balances or allowances (conservatively counted as fetched).
        else if (cat === 'token') {
          const spec = specByToken.get(a);
          const k = `${a}:${lc(s)}`;
          note(poolBalanceKeys.has(k) ? 'poolBalance' : spec && balKey(spec, from) === lc(s) ? 'trader' : 'other', k);
        }
        else if (cat === 'trader') note('trader', `${a}:${lc(s)}`);
        else note('other', `${a}:${lc(s)}`);
      }
    }
    for (const [a0, post] of Object.entries(diff.result.post || {})) {
      const a = lc(a0); const p = pools.get(a); if (!p) continue;
      const slots = Object.keys(post.storage || {}).map(lc);
      const c = changed.get(p.type) || { swaps: 0, slotCounts: new Map(), perSwap: [] };
      c.swaps++; c.perSwap.push(slots.length);
      for (const s of slots) c.slotCounts.set(s, (c.slotCounts.get(s) || 0) + 1);
      changed.set(p.type, c);
    }
    done++;
    if (done % 100 === 0) console.log(`${done}/${list.length} · node requests ${requests}`);
  }
  const seconds = (TO - FROM + 1) / 4;
  const lateSec = seconds / 2;
  const perSec = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +(v / lateSec).toFixed(2)]));
  const q3 = {};
  for (const [type, c] of changed) {
    const top = [...c.slotCounts.entries()].sort((a, b) => b[1] - a[1]);
    const always = top.filter(([, n]) => n >= 0.9 * c.swaps).map(([s]) => s.slice(0, 10) + '…');
    q3[type] = { swaps: c.swaps, slotsChangedPerSwapAvg: +(c.perSwap.reduce((s, x) => s + x, 0) / c.swaps).toFixed(1), slotsChangedMax: Math.max(...c.perSwap), differentSlotsSeen: top.length, slotsInNearlyEverySwap: always.length };
  }
  const summary = {
    blocks: TO - FROM + 1, seconds, pools: pools.size, events, transactions: txs.size, measured: done,
    Q1_eventsPerSecond: +(events / seconds).toFixed(2), Q1_txsPerSecond: +(txs.size / seconds).toFixed(2),
    Q2_uniqueItems: Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.size])),
    Q2_newPerSecondSecondHalf: perSec(freshLate),
    Q2_nodeLookupsPerDayWarm_otherPlusCode: Math.round(((freshLate.other + freshLate.code) / lateSec) * 86400),
    Q3_changedSlotsByPoolType: q3,
    nodeRequestsUsed: requests,
  };
  fs.writeFileSync(path.join(OUT, 'design2.json'), JSON.stringify(summary, null, 1));
  console.log('SUMMARY ' + JSON.stringify(summary));
}
main().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
