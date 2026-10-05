// ============================================================================
// EXPORT TOP PAIRS (makes the backup list the bot starts from)
//
// Runs the same chain-wide scan the bot runs, then prints the top pairs as
// JSON. That JSON is committed as src/config/robinhoodSeedPairs.json, so the
// bot can start watching the right 20 pairs even when its own scan is
// blocked (fresh machine, lost data/ folder, free node rate-limiting).
//   npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/export-top-pairs.js
// ============================================================================
import { ethers } from 'ethers';
import { scanUniverse } from '../src/core/universeScan';
import { ROBINHOOD_SCAN_FACTORIES, ROBINHOOD_TOKENS } from '../src/config/knownAddresses';

const provider = new ethers.JsonRpcProvider(process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com', 4663, { staticNetwork: true });
const TOP = Number(process.env.SEED_PAIRS ?? 20);

(async () => {
  const res = await scanUniverse(provider, ROBINHOOD_SCAN_FACTORIES, { usdToken: ROBINHOOD_TOKENS.USDG, wrappedNative: ROBINHOOD_TOKENS.WETH });
  const sym = (t: string) => res.tokens.get(t.toLowerCase())?.symbol ?? t.slice(0, 8);
  const pairs = res.candidates.slice(0, TOP).map((c) => ({
    a: ethers.getAddress(c.tokenA), b: ethers.getAddress(c.tokenB),
    label: `${sym(c.tokenA)}/${sym(c.tokenB)}`,
  }));
  if (!pairs.length) { console.log(`failed: scan found no pairs${res.errors.length ? ' (' + res.errors.join('; ') + ')' : ''}`); process.exit(0); }
  // One pair per line keeps the annotation readable and the file diff-friendly.
  console.log('SEED_JSON_START');
  console.log('[');
  console.log(pairs.map((p) => '  ' + JSON.stringify(p)).join(',\n'));
  console.log(']');
  console.log('SEED_JSON_END');
  process.exit(0);
})().catch((e) => { console.log(`failed: ${(e as Error).message}`); process.exit(0); });
