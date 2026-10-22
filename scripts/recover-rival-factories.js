#!/usr/bin/env node
// ============================================================================
// RECOVER FACTORY ADDRESSES FROM OBSERVED RIVAL POOLS — READ ONLY
//
// Input: complete pool contract addresses seen in rival transactions.
// Output: full factory() / factory-like contract addresses, bytecode presence,
//         and whether the address matches the five audit prefixes.
//
// Does NOT identify a DEX solely by its factory address. Cross-check against
// protocol docs, creation logs, source verification, and on-chain behavior.
// No private keys, transactions, or token approvals are used.
//
// Example:
// ROBINHOOD_RPC_URL=https://your-rpc node scripts/recover-rival-factories.js \
//   0xPOOL_ADDRESS_1 0xPOOL_ADDRESS_2
// ============================================================================
'use strict';
const { JsonRpcProvider, Contract, isAddress, getAddress, id } = require('ethers');
const rpc = process.env.ROBINHOOD_RPC_URL || process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const prefixes = ['0x16494a', '0x1ac9db', '0xece6ec', '0x548186', '0xaa5865'];
const abi = [
  'function factory() view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function poolType() view returns (uint8)',
];
const addresses = process.argv.slice(2);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function safe(call) {
  try { return { ok: true, value: String(await call()) }; }
  catch (e) { return { ok: false, error: String(e.shortMessage || e.message).slice(0, 120) }; }
}

async function main() {
  if (!addresses.length || addresses.some(a => !isAddress(a)))
    throw new Error('Supply one or more complete 20-byte pool addresses');
  const provider = new JsonRpcProvider(rpc);
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== 4663) throw new Error('Expected Robinhood mainnet chain ID 4663; got ' + chainId);
  const results = [];
  for (const pool of [...new Set(addresses.map(getAddress))]) {
    const contract = new Contract(pool, abi, provider);
    const code = await provider.getCode(pool);
    const result = { pool, hasCode: code !== '0x', factory: null,
      token0: null, token1: null, fee: null, auditPrefix: null, status: 'UNVERIFIED' };
    if (code !== '0x') {
      for (const key of ['factory', 'token0', 'token1', 'fee']) {
        const value = await safe(() => contract[key]());
        result[key] = value.ok ? value.value : null;
      }
      if (result.factory && isAddress(result.factory)) {
        result.auditPrefix = prefixes.find(p => result.factory.toLowerCase().startsWith(p)) || null;
        result.factoryHasCode = (await provider.getCode(result.factory)) !== '0x';
      }
    }
    results.push(result);
    await pause(250);
  }
  console.log(JSON.stringify({ chainId, auditPrefixes: prefixes, results,
    note: 'Factory identity and pricing adapter require separate independent verification.' }, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
