#!/usr/bin/env node
// ============================================================================
// ROBINHOOD UNKNOWN FACTORY VERIFIER — READ ONLY
//
// Goal: identify the five unknown factory prefixes found in rival replays.
// This does NOT guess addresses from 6 hex digits. It requires exact 20-byte
// addresses from the rival trace/log, then checks code and known read-only
// factory methods on Robinhood RPC. It never sends transactions.
//
// Usage:
//   ROBINHOOD_RPC_URL=https://YOUR_RPC node scripts/verify-unknown-dexes.js \
//     0xFULL_FACTORY_ADDRESS_1 0xFULL_FACTORY_ADDRESS_2
//
// No secrets, no wallet, no deployment, no write RPC methods.
// Output is JSON; unknown factory identity remains UNVERIFIED until code,
// protocol ownership, pool factory linkage, and pool math are confirmed.
// ============================================================================
'use strict';
const { JsonRpcProvider, Contract, isAddress, getAddress, keccak256 } = require('ethers');

const prefixes = ['0x16494a', '0x1ac9db', '0xece6ec', '0x548186', '0xaa5865'];
const rpc = process.env.ROBINHOOD_RPC_URL || process.env.RPC_URL;
const args = process.argv.slice(2);

const factoryAbi = [
  'function feeAmountTickSpacing(uint24) view returns (int24)',
  'function getPool(address,address,uint24) view returns (address)',
  'function allPairsLength() view returns (uint256)',
  'function poolByPair(address,address) view returns (address)',
  'function owner() view returns (address)',
];

async function probe(provider, address) {
  const code = await provider.getCode(address);
  const result = {
    address, matchingAuditPrefix: prefixes.find(p => address.toLowerCase().startsWith(p)) || null,
    deployed: code !== '0x', codeBytes: (code.length - 2) / 2,
    codeHash: code === '0x' ? null : keccak256(code),
    probes: {}, protocol: 'UNVERIFIED', classification: 'UNVERIFIED',
  };
  if (code === '0x') return result;
  const contract = new Contract(address, factoryAbi, provider);
  // Successful calls are suggestive only; proxies, fallbacks and selector
  // collisions mean no single call establishes a protocol identity.
  for (const [name, call] of [
    ['owner', () => contract.owner()],
    ['allPairsLength', () => contract.allPairsLength()],
    ['feeAmountTickSpacing500', () => contract.feeAmountTickSpacing(500)],
  ]) {
    try {
      const value = await call();
      result.probes[name] = { ok: true, value: String(value) };
    } catch (error) {
      result.probes[name] = { ok: false, reason: String(error.shortMessage || error.message).slice(0, 140) };
    }
  }
  return result;
}

async function main() {
  if (!rpc) throw new Error('Set ROBINHOOD_RPC_URL or RPC_URL');
  if (!args.length) throw new Error('Supply full factory addresses, not 0x123456 prefixes');
  const invalid = args.filter(x => !isAddress(x));
  if (invalid.length) throw new Error('Invalid full addresses: ' + invalid.join(', '));
  const provider = new JsonRpcProvider(rpc);
  const network = await provider.getNetwork();
  const factories = [];
  for (const addr of [...new Set(args.map(getAddress))]) {
    factories.push(await probe(provider, addr));
  }
  console.log(JSON.stringify({
    chainId: String(network.chainId),
    auditPrefixes: prefixes,
    checkedAt: new Date().toISOString(),
    warning: 'RPC code and selector checks do NOT prove DEX identity or safe execution',
    factories,
  }, null, 2));
}

main().catch(err => {
  console.error('Verification failed:', err.message);
  process.exitCode = 1;
});
