#!/usr/bin/env node
// ============================================================================
// POOL COVERAGE: how many of the bot's watched pools are of each kind?
//
// Plain English: reads the bot's watch list (data/watched-pools.json) and
// counts pools by exchange + pool type (+ Uniswap V4 with or without a hook),
// for ALL watched pools and for pools in pairs that trade on 2+ exchanges
// (where arbitrage is possible). Read only, no node calls.
//
// Run: node pool-coverage.js [path/to/watched-pools.json]
// ============================================================================
'use strict';
const path = require('path');
const file = process.argv[2] || path.join(process.env.HOME, 'multichain-arb-engine', 'data', 'watched-pools.json');
const d = require(file);
const lc = (s) => String(s || '').toLowerCase();
const pools = (d.pools || []).filter((p) => p && p.chain === 'robinhood' && p.poolAddress && p.tokenA && p.tokenB);

// Pairs that trade on 2+ different exchanges.
const byPair = new Map();
for (const p of pools) { const k = [lc(p.tokenA), lc(p.tokenB)].sort().join('/'); if (!byPair.has(k)) byPair.set(k, []); byPair.get(k).push(p); }
const multi = new Set();
for (const list of byPair.values()) if (new Set(list.map((p) => p.dex)).size >= 2) for (const p of list) multi.add(p);

// Kind label: exchange | pool type | V4 hook status | variant.
const ZERO = /^0x0*$/;
function kind(p) {
  const v4 = lc(p.poolAddress).length === 66;
  let k = `${p.dex} | ${p.poolType}`;
  if (v4) k += p.v4 && p.v4.hooks && !ZERO.test(lc(p.v4.hooks)) ? ' | v4 HOOKED' : ' | v4 no-hook';
  if (p.variant) k += ` | ${p.variant}`;
  return k;
}
const count = (list) => { const m = new Map(); for (const p of list) m.set(kind(p), (m.get(kind(p)) || 0) + 1); return m; };
const allM = count(pools), multiM = count([...multi]);
console.log('ALL watched pools:', pools.length, '| in pairs on 2+ exchanges:', multi.size, '| pairs:', byPair.size, '(2+ exchanges:', [...byPair.values()].filter((l) => new Set(l.map((p) => p.dex)).size >= 2).length + ')');
console.log('all  2+ex  kind');
for (const [k, v] of [...allM.entries()].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(4), String(multiM.get(k) || 0).padStart(5), ' ', k);
