#!/usr/bin/env node
// ============================================================================
// ROBINHOOD EXTRA DEX DISCOVERY — real, read-only on-chain scan
//
// This is not merely a watchlist: it connects to Robinhood RPC, checks chain
// ID and contract bytecode, queries creation logs for verified factory-shaped
// contracts, and inspects candidate pool token/fee data. Never sends a trade.
//
// Usage:
//   ROBINHOOD_RPC_HTTP=https://YOUR_RPC node scripts/discover-extra-dexes.js
//   EXTRA_DEX_FROM_BLOCK=73266708 EXTRA_DEX_BLOCKS=50000 node scripts/discover-extra-dexes.js
//
// Optional env:
//   EXTRA_DEX_BLOCKS=10000 (bounded to 200000)
//   EXTRA_DEX_FROM_BLOCK=... (default latest - EXTRA_DEX_BLOCKS)
//   EXTRA_DEX_OUTPUT=data/extra-dex-discovery.json
//   EXTRA_DEX_RPC_DELAY_MS=200
//
// This script deliberately does NOT scan Ekubo as a V3 factory. Ekubo has a
// singleton Core and requires its own pool-config discovery and quoting.
// Fables/Metric/GIGA factory addresses are still unknown; do not invent them.
// ============================================================================
'use strict';
const { JsonRpcProvider, Interface, getAddress, isAddress, toBeHex } = require('ethers');
const fs = require('fs');
const path = require('path');
const rpc = process.env.ROBINHOOD_RPC_HTTP || process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const delay = Number(process.env.EXTRA_DEX_RPC_DELAY_MS ?? 200);
const span = Math.min(200000, Math.max(1, Number(process.env.EXTRA_DEX_BLOCKS ?? 10000)));
const output = process.env.EXTRA_DEX_OUTPUT || 'data/extra-dex-discovery.json';

// Project-published contracts. Their presence is checked against live RPC;
// presence alone does not establish fee correctness or executability.
const factories = [
  { dex: 'goo-exchange', address: '0x221A6239E40709792b0d4bdc140fA36158CD41C7', model: 'v3-like',
    source: 'https://goo.exchange/docs/' },
  { dex: 'reisa', address: '0x82Fe4E8b87FfEdE76bC04d74218f588221Ba4e91', model: 'unclassified',
    source: 'https://reisa.fi/docs/developers' },
];
const ekuboCore = '0x00000000000014aA86C5d3c41765bb24e11bd701';
const poolCreated = new Interface([
  'event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)',
  'event PairCreated(address indexed token0,address indexed token1,address pair,uint256)',
]);
const poolIface = new Interface([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
]);
const pause = () => new Promise(resolve => setTimeout(resolve, delay));
async function call(provider, to, name) {
  try {
    const ret = await provider.call({ to, data: poolIface.encodeFunctionData(name) });
    return String(poolIface.decodeFunctionResult(name, ret)[0]);
  } catch { return null; }
}
async function scan(provider, f, from, to) {
  const code = await provider.getCode(f.address);
  const result = { ...f, hasCode: code !== '0x', pools: [], warnings: [] };
  if (code === '0x') {
    result.warnings.push('No deployed code at documented factory address');
    return result;
  }
  // Topic 0 filter avoids unrelated events and bogus addresses.
  const topics = [
    poolCreated.getEvent('PoolCreated').topicHash,
    poolCreated.getEvent('PairCreated').topicHash,
  ];
  for (const topic of topics) {
    for (let start = from; start <= to; start += 2000) {
      const end = Math.min(to, start + 1999);
      let logs;
      try {
        logs = await provider.getLogs({ address: f.address, fromBlock: start, toBlock: end, topics: [topic] });
      } catch (e) {
        result.warnings.push('Log query failed at blocks ' + start + '-' + end + ': ' + String(e.shortMessage || e.message).slice(0, 140));
        continue;
      }
      for (const log of logs) {
        try {
          const parsed = poolCreated.parseLog(log);
          if (!parsed) continue;
          const pool = getAddress(parsed.args.pool || parsed.args.pair);
          if (!isAddress(pool)) continue;
          const [token0, token1, fee, liquidity] = await Promise.all([
            call(provider, pool, 'token0'),
            call(provider, pool, 'token1'),
            call(provider, pool, 'fee'),
            call(provider, pool, 'liquidity'),
          ]);
          result.pools.push({
            pool, token0, token1, fee, liquidity, block: log.blockNumber,
            txHash: log.transactionHash, event: parsed.name,
            adapterReady: false,
          });
        } catch (e) {
          result.warnings.push('Could not decode creation event at ' + log.transactionHash);
        }
      }
      await pause();
    }
  }
  return result;
}
async function main() {
  if (!Number.isSafeInteger(span) || !Number.isFinite(delay) || delay < 0)
    throw new Error('Invalid scan settings');
  const provider = new JsonRpcProvider(rpc, 4663, { staticNetwork: false });
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== 4663) throw new Error('Wrong network; expected chain 4663');
  const latest = await provider.getBlockNumber();
  const start = process.env.EXTRA_DEX_FROM_BLOCK === undefined
    ? Math.max(0, latest - span + 1)
    : Math.max(0, Number(process.env.EXTRA_DEX_FROM_BLOCK));
  if (!Number.isSafeInteger(start) || start > latest) throw new Error('Invalid starting block');
  const end = Math.min(latest, start + span - 1);
  const coreHasCode = (await provider.getCode(ekuboCore)) !== '0x';
  const results = [];
  for (const f of factories) results.push(await scan(provider, f, start, end));
  const report = {
    chainId: 4663, startBlock: start, endBlock: end, latestBlock: latest,
    ekubo: { core: ekuboCore, hasCode: coreHasCode, type: 'singleton', adapterReady: false },
    factories: results, observedAt: new Date().toISOString(),
    warning: 'Read-only discovery. No venue is safe to execute without model-specific historical replay.',
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
main().catch(err => { console.error('[extra-dex]', err.message); process.exitCode = 1; });
