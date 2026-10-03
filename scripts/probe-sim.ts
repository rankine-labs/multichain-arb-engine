// ============================================================================
// LIVE SIMULATION PROBE (diagnostic, not part of the bot)
//
// Runs the free pre-trade simulator against REAL pools on each chain's
// public RPC, to confirm: (1) the RPC supports eth_call state overrides,
// (2) we can find real tokens' balance storage, (3) every pool type and
// callback works through the simulator. Pools are in balance, so 'loss' is
// the normal, healthy answer; 'fail' or 'unsupported' means a problem.
//
//   npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/probe-sim.js
// ============================================================================

import { ethers } from 'ethers';
import { makeRpc, simulateRoundTrip, SimResult } from '../src/execution/simulator';
import { KIND_V2, KIND_SOLIDLY, KIND_V3, ExecutorHop } from '../src/execution/executorCalldata';

const RPC = {
  avalanche: process.env.AVALANCHE_RPC_URL ?? 'https://api.avax.network/ext/bc/C/rpc',
  monad: process.env.MONAD_RPC_URL ?? 'https://rpc.monad.xyz',
  robinhood: process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com',
};

const v2Factory = ['function getPair(address,address) view returns (address)'];
const solidlyFactory = ['function getPair(address,address,bool) view returns (address)'];
const v3Factory = ['function getPool(address,address,uint24) view returns (address)'];
const v3Pool = ['function liquidity() view returns (uint128)'];

const fmt = (r: SimResult) => r.status === 'profit' ? `profit ${r.profit}` : r.status === 'fail' || r.status === 'unsupported' ? `${r.status}: ${r.reason}` : r.status;

async function findV3(provider: ethers.Provider, factory: string, a: string, b: string, fees: number[]) {
  const f = new ethers.Contract(factory, v3Factory, provider);
  for (const fee of fees) {
    try {
      const p: string = await f.getPool(a, b, fee);
      if (p !== ethers.ZeroAddress && (await new ethers.Contract(p, v3Pool, provider).liquidity()) > 0n) return p;
    } catch { /* try next tier */ }
  }
  return null;
}

async function run(chain: keyof typeof RPC, label: string, token: string, amountIn: bigint, hops: ExecutorHop[], v3Lender?: string) {
  const r = await simulateRoundTrip(makeRpc(RPC[chain], 20_000), chain, { token, amountIn, hops }, { v3Lender });
  return `${chain} ${label}: ${fmt(r)}`;
}

(async () => {
  const out: string[] = [];
  const h = (kind: number, pool: string, tIn: string, tOut: string, feeBps = 30): ExecutorHop => ({ kind, pool, tokenIn: tIn, tokenOut: tOut, feeBps });

  // ---- Avalanche: TraderJoe v1 <-> Sushi (V2), WAVAX start; and USDC start
  try {
    const p = new ethers.JsonRpcProvider(RPC.avalanche, 43114, { staticNetwork: true });
    const WAVAX = '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', USDC = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
    const joe = await new ethers.Contract('0x9Ad6C38BE94206cA50bb0d90783181662f0Cfa10', v2Factory, p).getPair(WAVAX, USDC);
    const sushi = await new ethers.Contract('0xc35DADB65012eC5796536bD9864eD8773aBc74C4', v2Factory, p).getPair(WAVAX, USDC);
    out.push(await run('avalanche', 'joe->sushi WAVAX', WAVAX, 10n ** 18n, [h(KIND_V2, joe, WAVAX, USDC), h(KIND_V2, sushi, USDC, WAVAX)]));
    out.push(await run('avalanche', 'joe->sushi USDC (proxy token)', USDC, 20n * 10n ** 6n, [h(KIND_V2, joe, USDC, WAVAX), h(KIND_V2, sushi, WAVAX, USDC)]));
  } catch (e) { out.push(`avalanche: setup error ${(e as Error).message}`); }

  // ---- Monad: Uniswap V3 <-> PancakeSwap V3, WMON start
  try {
    const p = new ethers.JsonRpcProvider(RPC.monad, 143, { staticNetwork: true });
    const WMON = '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A', USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
    const uni = await findV3(p, '0x204FAca1764B154221e35c0d20aBb3c525710498', WMON, USDC, [3000, 500, 10000, 100]);
    const cake = await findV3(p, '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', WMON, USDC, [2500, 500, 10000, 100]);
    if (uni && cake) {
      out.push(await run('monad', 'uniV3->cakeV3 WMON', WMON, 10n * 10n ** 18n, [h(KIND_V3, uni, WMON, USDC), h(KIND_V3, cake, USDC, WMON)]));
      out.push(await run('monad', 'uniV3->cakeV3 USDC', USDC, 5n * 10n ** 6n, [h(KIND_V3, uni, USDC, WMON), h(KIND_V3, cake, WMON, USDC)]));
    } else out.push(`monad: pools not found (uni ${uni}, cake ${cake})`);
  } catch (e) { out.push(`monad: setup error ${(e as Error).message}`); }

  // ---- Robinhood: Ramses V2 (Solidly) <-> PancakeSwap V3, WETH and USDG start
  try {
    const p = new ethers.JsonRpcProvider(RPC.robinhood, 4663, { staticNetwork: true });
    const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
    const ramses = await new ethers.Contract('0x43B2Bf9f33036a02fC7A00935571c2A6b0108e66', solidlyFactory, p).getPair(WETH, USDG, false);
    const cake = await findV3(p, '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', WETH, USDG, [2500, 500, 10000, 100]);
    if (cake) {
      out.push(await run('robinhood', 'ramsesV2->cakeV3 WETH', WETH, 10n ** 16n, [h(KIND_SOLIDLY, ramses, WETH, USDG), h(KIND_V3, cake, USDG, WETH)]));
      out.push(await run('robinhood', 'ramsesV2->cakeV3 USDG', USDG, 20n * 10n ** 6n, [h(KIND_SOLIDLY, ramses, USDG, WETH), h(KIND_V3, cake, WETH, USDG)]));
      // Flash-loan version: borrow WETH from a real Uniswap V3 pool (not a trade pool).
      const uniF = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA';
      let lender: string | null = null;
      for (const fee of [500, 3000, 10000, 100]) {
        const p2: string = await new ethers.Contract(uniF, v3Factory, p).getPool(WETH, USDG, fee).catch(() => ethers.ZeroAddress);
        if (p2 !== ethers.ZeroAddress && p2.toLowerCase() !== cake.toLowerCase() && (await new ethers.Contract(p2, v3Pool, p).liquidity()) > 0n) { lender = p2; break; }
      }
      out.push(lender
        ? await run('robinhood', `FLASH LOAN from ${lender.slice(0, 10)} + ramsesV2->cakeV3 WETH`, WETH, 10n ** 16n, [h(KIND_SOLIDLY, ramses, WETH, USDG), h(KIND_V3, cake, USDG, WETH)], lender)
        : 'robinhood flash: no separate Uniswap V3 WETH/USDG lender found');
    } else out.push('robinhood: pancake V3 pool not found');
  } catch (e) { out.push(`robinhood: setup error ${(e as Error).message}`); }

  console.log(out.join('\n'));
  process.exit(0);
})();
