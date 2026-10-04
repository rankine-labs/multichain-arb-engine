// ============================================================================
// UNIVERSE PROBE (diagnostic): runs the chain-wide pool scan against live
// Robinhood and reports every pair that sits on 2+ pools with real money in
// each. Same code the bot runs at startup (core/universeScan.ts).
//   npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/probe-universe.js
// Env: ROBINHOOD_RPC_URL, SCAN_MIN_USD (default 2000), SCAN_SHOW (default 25)
// ============================================================================
import { ethers } from 'ethers';
import { scanUniverse } from '../src/core/universeScan';
import { ROBINHOOD_SCAN_FACTORIES, ROBINHOOD_TOKENS } from '../src/config/knownAddresses';

const provider = new ethers.JsonRpcProvider(process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com', 4663, { staticNetwork: true });
const MIN_USD = Number(process.env.SCAN_MIN_USD ?? 2_000);
const SHOW = Number(process.env.SCAN_SHOW ?? 25);

// $1,234 / $56k / $1.2M
const usd = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `$${Math.round(v / 1e3)}k` : `$${Math.round(v).toLocaleString('en-US')}`);

(async () => {
  const t0 = Date.now();
  const res = await scanUniverse(provider, ROBINHOOD_SCAN_FACTORIES, {
    usdToken: ROBINHOOD_TOKENS.USDG, wrappedNative: ROBINHOOD_TOKENS.WETH, minPoolUsd: MIN_USD,
    log: (m) => console.log(m), // progress on stdout: shows where a slow scan got to
  });
  const sym = (t: string) => res.tokens.get(t.toLowerCase())?.symbol ?? t.slice(0, 8);
  const ethPx = res.usdPrice.get(ROBINHOOD_TOKENS.WETH.toLowerCase());

  const out: string[] = [];
  out.push(`pools per DEX: ${Object.entries(res.poolsPerDex).map(([d, n]) => `${d} ${n < 0 ? 'FAILED' : n}`).join(', ')}`);
  out.push(`total ${res.totalPools} pools | pairs on 2+ pools: ${res.multiPoolPairs} | with ${usd(MIN_USD)}+ in 2+ pools: ${res.candidates.length}`);
  out.push(`ETH ~${ethPx ? usd(ethPx) : '?'} | multicall: ${res.usedMulticall ? 'yes' : 'no'} | ${Math.round((Date.now() - t0) / 1000)}s`);
  if (res.errors.length) out.push(`errors: ${res.errors.join(' | ')}`);
  out.push('');
  out.push(`top ${Math.min(SHOW, res.candidates.length)} (ranked by 2nd-deepest pool):`);
  res.candidates.slice(0, SHOW).forEach((c, i) => {
    const pools = c.pools.slice(0, 5).map((p) => `${p.dex} ${usd(p.usd ?? 0)}`).join(', ');
    out.push(`${i + 1}. ${sym(c.tokenA)}/${sym(c.tokenB)}: ${c.pools.length} pools on ${c.dexes.length} DEX${c.dexes.length === 1 ? '' : 'es'} -> ${pools}${c.pools.length > 5 ? ', ...' : ''}`);
  });
  console.log(out.join('\n'));
  process.exit(0);
})().catch((err) => { console.log(`scan crashed: ${(err as Error).message}`); process.exit(0); });
