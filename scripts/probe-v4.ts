// ============================================================================
// V4 POOL PROBE -- which Uniswap V4 pools exist for the pairs we watch?
//
// Plain English:
//   Every V4 pool is created with an Initialize event on the single
//   PoolManager contract. This reads all of them, keeps the ones whose two
//   tokens are in our watched pairs (native ETH counts as WETH), and prints,
//   per pool: fee, tick spacing, whether it has a hook (custom add-on code),
//   whether it uses native ETH, and its current liquidity. That decides how
//   the V4 support has to be built (hooks? native ETH?).
//   npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/probe-v4.js
// ============================================================================
import { ethers } from 'ethers';
import { getLogsAdaptive, RawLog } from '../src/core/universeScan';
import { ROBINHOOD_V4, ROBINHOOD_TOKENS } from '../src/config/knownAddresses';
import { ROBINHOOD_SEED_PAIRS } from '../src/config/robinhoodSeedPairs';

const provider = new ethers.JsonRpcProvider(process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com', 4663, { staticNetwork: true });
const INIT_TOPIC = ethers.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
const stateView = new ethers.Contract(ROBINHOOD_V4.STATE_VIEW, [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
], provider);
const erc20 = (a: string) => new ethers.Contract(a, ['function symbol() view returns (string)'], provider);

(async () => {
  const weth = ROBINHOOD_TOKENS.WETH.toLowerCase();
  const norm = (a: string) => (a === ethers.ZeroAddress ? weth : a.toLowerCase()); // native ETH ~ WETH
  const wanted = new Set(ROBINHOOD_SEED_PAIRS.map((p) => [p.a.toLowerCase(), p.b.toLowerCase()].sort().join('/')));
  const latest = await provider.getBlockNumber();

  const pools: Array<{ id: string; c0: string; c1: string; fee: number; spacing: number; hooks: string; block: number }> = [];
  let total = 0;
  // Only logs with the Initialize topic (filtering by topic keeps responses small).
  const origSend = provider.send.bind(provider);
  (provider as any).send = (method: string, params: any[]) => {
    if (method === 'eth_getLogs') params[0].topics = [INIT_TOPIC];
    return origSend(method, params);
  };
  await getLogsAdaptive(provider, ROBINHOOD_V4.POOL_MANAGER, 0, latest, (logs: RawLog[]) => {
    for (const l of logs) {
      if (l.topics[0] !== INIT_TOPIC) continue;
      total++;
      const c0 = ethers.getAddress('0x' + l.topics[2].slice(26)), c1 = ethers.getAddress('0x' + l.topics[3].slice(26));
      const key = [norm(c0), norm(c1)].sort().join('/');
      if (!wanted.has(key)) continue;
      const [fee, spacing, hooks] = ethers.AbiCoder.defaultAbiCoder().decode(['uint24', 'int24', 'address', 'uint160', 'int24'], l.data);
      pools.push({ id: l.topics[1], c0, c1, fee: Number(fee), spacing: Number(spacing), hooks: hooks as string, block: parseInt(l.blockNumber ?? '0', 16) });
    }
  }, 60_000);

  const symCache = new Map<string, string>();
  const sym = async (a: string) => {
    if (a === ethers.ZeroAddress) return 'ETH';
    if (!symCache.has(a)) symCache.set(a, await erc20(a).symbol().catch(() => a.slice(0, 8)));
    return symCache.get(a)!;
  };
  console.log(`V4 pools on Robinhood: ${total} total, ${pools.length} for our ${wanted.size} watched pairs`);
  let hookless = 0, native = 0;
  const rows: string[] = [];
  for (const p of pools) {
    const liq: bigint = await stateView.getLiquidity(p.id).catch(() => 0n);
    if (liq === 0n) continue;
    const hasHook = p.hooks !== ethers.ZeroAddress;
    if (!hasHook) hookless++;
    if (p.c0 === ethers.ZeroAddress) native++;
    rows.push(`${await sym(p.c0)}/${await sym(p.c1)} fee ${p.fee / 10000}% spacing ${p.spacing} ${hasHook ? 'HOOK ' + p.hooks.slice(0, 10) : 'no hook'} liq ${liq.toString().length}d id ${p.id.slice(0, 14)}`);
  }
  console.log(`with liquidity: ${rows.length} (no hook: ${hookless}, native ETH: ${native})`);
  for (const r of rows.slice(0, 40)) console.log(r);
  process.exit(0);
})().catch((e) => { console.log(`failed: ${(e as Error).message}`); process.exit(0); });
