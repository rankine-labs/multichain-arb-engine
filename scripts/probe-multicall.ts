// ============================================================================
// MULTICALL PROBE -- does the bundled pool discovery find exactly what the
// old one-by-one lookups find, on the live chain? And does the one-request
// balance lookup work on real tokens?
//   npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/probe-multicall.js
// Read-only, no keys.
// ============================================================================
import { ethers } from 'ethers';
import { ROBINHOOD_TOKENS, ROBINHOOD_V2, ROBINHOOD_V3, ROBINHOOD_V4, ROBINHOOD_PANCAKE, ROBINHOOD_RAMSES } from '../src/config/knownAddresses';
import { ROBINHOOD_SEED_PAIRS } from '../src/config/robinhoodSeedPairs';
import { discoverPairPools, discoverPairPoolsMulticall, Venue } from '../src/core/pairWatcher';
import { makeCaller } from '../src/core/universeScan';
import { findBalanceSlot, makeRpc } from '../src/execution/simulator';

const URL_ = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const provider = new ethers.JsonRpcProvider(URL_, 4663, { staticNetwork: true, batchMaxCount: 1 });
const VENUES: Venue[] = [
  { dex: 'uniswap-v2', kind: 'v2', factory: ROBINHOOD_V2.FACTORY, feeBps: 30 },
  { dex: 'pancakeswap-v2', kind: 'v2', factory: ROBINHOOD_PANCAKE.V2_FACTORY, feeBps: 25 },
  { dex: 'uniswap-v3', kind: 'v3-fee', factory: ROBINHOOD_V3.FACTORY },
  { dex: 'pancakeswap-v3', kind: 'v3-fee', factory: ROBINHOOD_PANCAKE.V3_FACTORY },
  { dex: 'ramses-v2', kind: 'solidly', factory: ROBINHOOD_RAMSES.V2_FACTORY, feeBps: 20 },
  { dex: 'ramses-v3', kind: 'v3-spacing', factory: ROBINHOOD_RAMSES.V3_FACTORY },
  { dex: 'uniswap-v4', kind: 'v4', factory: ROBINHOOD_V4.STATE_VIEW, poolManager: ROBINHOOD_V4.POOL_MANAGER, weth: ROBINHOOD_TOKENS.WETH },
];

// Count every RPC request the old path makes.
let oldReq = 0;
const origSend = provider._send.bind(provider);
(provider as any)._send = async (p: any) => { oldReq += Array.isArray(p) ? p.length : 1; return origSend(p); };

(async () => {
  const { callMany } = await makeCaller(provider);
  let newReq = 0;
  const countedCallMany = async (calls: { target: string; data: string }[]) => { newReq++; return callMany(calls); };
  const pairs = [{ a: ROBINHOOD_TOKENS.WETH, b: ROBINHOOD_TOKENS.USDG }, ...ROBINHOOD_SEED_PAIRS.slice(0, 7)];
  let same = 0;
  const fp = (p: any) => `${p.dex}|${p.poolAddress.toLowerCase()}|${p.tokenA.toLowerCase()}|${p.tokenB.toLowerCase()}|${p.feeBps}|${p.poolType}|${p.v4?.native ?? ''}`;
  for (const pr of pairs) {
    oldReq = 0;
    const oldPools = await discoverPairPools(provider, 'robinhood', VENUES, pr.a, pr.b);
    const oldN = oldReq;
    newReq = 0;
    const { pools: newPools, meta } = await discoverPairPoolsMulticall(countedCallMany, 'robinhood', VENUES, pr.a, pr.b, [pr.a, pr.b]);
    const A = new Set(oldPools.map(fp)), B = new Set(newPools.map(fp));
    const missing = [...A].filter((x) => !B.has(x)), extra = [...B].filter((x) => !A.has(x));
    const ok = missing.length === 0 && extra.length === 0;
    if (ok) same++;
    const syms = Object.values(meta).map((m) => (m === 'not-a-token' ? '?' : m.symbol)).join('/');
    console.log(`${ok ? 'SAME' : 'DIFF'} ${syms}: ${oldPools.length} pools old (${oldN} requests) vs ${newPools.length} new (${newReq} requests)` +
      (ok ? '' : ` missing=${missing.map((m) => m.split('|')[0]).join(',')} extra=${extra.map((m) => m.split('|')[0]).join(',')}`));
  }
  console.log(`DISCOVERY: ${same}/${pairs.length} pairs identical`);

  // Balance lookup on real tokens (2 requests each, paced).
  const rpc = makeRpc(URL_);
  for (const [name, t] of [['WETH', ROBINHOOD_TOKENS.WETH], ['USDG', ROBINHOOD_TOKENS.USDG]] as const) {
    let n = 0;
    const counted = async (m: string, p: unknown[]) => { n++; return rpc(m, p); };
    try {
      const s = await findBalanceSlot(counted, `probe:${t}`, t);
      console.log(`BALANCE ${name}: ${s && 'key' in s ? 'found' : s && 'unsupported' in s ? 'node refuses overrides' : 'not found'} in ${n} requests`);
    } catch (e) { console.log(`BALANCE ${name}: node busy (${(e as Error).message.slice(0, 50)}) after ${n} requests`); }
    await new Promise((r) => setTimeout(r, 1500));
  }
})();
