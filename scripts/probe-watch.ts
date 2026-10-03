// ============================================================================
// PAIR WATCHER PROBE (diagnostic): runs the bot's real pool discovery against
// live Robinhood for WETH/USDG and the busiest pairs seen in 60s of traffic,
// and reports every pool found per DEX / fee tier.
//   npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/probe-watch.js
// ============================================================================
import WebSocket from 'ws';
import { ethers } from 'ethers';
import { parseFeedFrame } from '../src/chains/nitroFeed';
import { TransactionDecoder, DEFAULT_ROUTER_REGISTRY } from '../src/core/decoder';
import { seedKnownAddresses, ROBINHOOD_TOKENS, ROBINHOOD_V2, ROBINHOOD_V3, ROBINHOOD_PANCAKE, ROBINHOOD_RAMSES } from '../src/config/knownAddresses';
import { discoverPairPools, Venue } from '../src/core/pairWatcher';

const provider = new ethers.JsonRpcProvider(process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com', 4663, { staticNetwork: true });
const VENUES: Venue[] = [
  { dex: 'uniswap-v2', kind: 'v2', factory: ROBINHOOD_V2.FACTORY, feeBps: 30 },
  { dex: 'pancakeswap-v2', kind: 'v2', factory: ROBINHOOD_PANCAKE.V2_FACTORY, feeBps: 25 },
  { dex: 'uniswap-v3', kind: 'v3-fee', factory: ROBINHOOD_V3.FACTORY },
  { dex: 'pancakeswap-v3', kind: 'v3-fee', factory: ROBINHOOD_PANCAKE.V3_FACTORY },
  { dex: 'ramses-v2', kind: 'solidly', factory: ROBINHOOD_RAMSES.V2_FACTORY, feeBps: 20 },
  { dex: 'ramses-v3', kind: 'v3-spacing', factory: ROBINHOOD_RAMSES.V3_FACTORY },
];

(async () => {
  const registry = structuredClone(DEFAULT_ROUTER_REGISTRY);
  seedKnownAddresses(registry);
  const decoder = new TransactionDecoder(registry);
  const counts = new Map<string, { a: string; b: string; n: number }>();
  await new Promise<void>((resolve) => {
    const ws = new WebSocket('wss://feed.mainnet.chain.robinhood.com');
    const t = setTimeout(() => { ws.terminate(); resolve(); }, 60_000);
    ws.on('error', () => { clearTimeout(t); resolve(); });
    ws.on('message', async (raw) => {
      let f: unknown; try { f = JSON.parse(raw.toString()); } catch { return; }
      for (const tx of parseFeedFrame(f)) {
        const s = await decoder.decode({ chain: 'robinhood', stateType: 'SEQUENCED', blockOrSeq: 0, receivedAtMs: 0, raw: { to: tx.to, data: tx.data, value: tx.value } });
        if (!s) continue;
        const k = [s.tokenIn.toLowerCase(), s.tokenOut.toLowerCase()].sort().join('/');
        const e = counts.get(k) ?? { a: s.tokenIn, b: s.tokenOut, n: 0 }; e.n++; counts.set(k, e);
      }
    });
  });
  const pairs = [{ a: ROBINHOOD_TOKENS.WETH, b: ROBINHOOD_TOKENS.USDG, n: -1 }, ...[...counts.values()].sort((x, y) => y.n - x.n).slice(0, 8)];
  const out: string[] = [];
  let multi = 0;
  for (const p of pairs) {
    const pools = await discoverPairPools(provider, 'robinhood', VENUES, p.a, p.b);
    if (pools.length > 1) multi++;
    const sym = async (t: string) => { try { return await new ethers.Contract(t, ['function symbol() view returns (string)'], provider).symbol(); } catch { return t.slice(0, 8); } };
    out.push(`${await sym(p.a)}/${await sym(p.b)} (${p.n < 0 ? 'always' : p.n + ' swaps'}): ${pools.length} pools -> ${pools.map((x) => `${x.dex}${x.poolType === 'v3' ? ' ' + x.feeBps / 100 + '%' : ''}`).join(', ') || 'none'}`);
  }
  out.push(`pairs with 2+ pools (arbitrable): ${multi} of ${pairs.length}`);
  console.log(out.join('\n'));
  process.exit(0);
})();
