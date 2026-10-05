// ============================================================================
// SUGGEST FLASH LENDERS (helper for deploying the contract)
//
// The contract only borrows from pools its owner approved. This lists, for
// every token in the pairs the bot watches, the 2 deepest V3 pools that can
// lend it (Uniswap / PancakeSwap / Ramses V3, all verified by fork tests).
// Two per token so one can lend while the other is part of the trade.
//   npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/suggest-lenders.js
// Output: a comma list for FLASH_LENDERS (deploy) and FLASH_LENDERS_ROBINHOOD (.env).
// ============================================================================
import { ethers } from 'ethers';
import { scanUniverse } from '../src/core/universeScan';
import { ROBINHOOD_SCAN_FACTORIES, ROBINHOOD_TOKENS } from '../src/config/knownAddresses';

const provider = new ethers.JsonRpcProvider(process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com', 4663, { staticNetwork: true });
const LENDER_DEXES = new Set(['uniswap-v3', 'pancakeswap-v3', 'ramses-v3']);
const PAIRS = Number(process.env.LENDER_PAIRS ?? 20);

(async () => {
  const res = await scanUniverse(provider, ROBINHOOD_SCAN_FACTORIES, { usdToken: ROBINHOOD_TOKENS.USDG, wrappedNative: ROBINHOOD_TOKENS.WETH });
  const cands = res.candidates.slice(0, PAIRS);
  const sym = (t: string) => res.tokens.get(t.toLowerCase())?.symbol ?? t.slice(0, 8);
  const tokens = new Set(cands.flatMap((c) => [c.tokenA.toLowerCase(), c.tokenB.toLowerCase()]));
  // Every liquid V3 pool from the scan, by token it holds, deepest first.
  const pools = cands.flatMap((c) => c.pools).filter((p) => LENDER_DEXES.has(p.dex));
  const chosen = new Map<string, string>(); // pool -> reason
  const lines: string[] = [];
  for (const t of tokens) {
    const holding = pools.filter((p) => p.token0.toLowerCase() === t || p.token1.toLowerCase() === t)
      .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0)).slice(0, 2);
    for (const p of holding) chosen.set(p.pool.toLowerCase(), `${sym(t)} via ${p.dex}`);
    lines.push(`${sym(t)}: ${holding.map((p) => `${p.dex} ~$${Math.round(p.usd ?? 0).toLocaleString('en-US')}`).join(', ') || 'no V3 lender found'}`);
  }
  console.log(`Flash lenders for ${tokens.size} tokens in the top ${cands.length} pairs:`);
  for (const l of lines) console.log(l);
  console.log('');
  console.log(`FLASH_LENDERS=${[...chosen.keys()].map((a) => ethers.getAddress(a)).join(',')}`);
  process.exit(0);
})().catch((e) => { console.log(`failed: ${(e as Error).message}`); process.exit(0); });
