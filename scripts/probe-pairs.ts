// ============================================================================
// ROBINHOOD PAIR PROBE (diagnostic, not part of the bot)
//
// Listens to the live Robinhood sequencer feed and tallies which token pairs
// are actually being swapped (and on which DEX), so the bot watches the
// pairs that matter. Also checks how Ramses V3's factory looks up pools.
//
//   npx tsc -p tsconfig.scripts.json && PROBE_SECONDS=120 node .scripts-build/scripts/probe-pairs.js
// ============================================================================

import WebSocket from 'ws';
import { ethers } from 'ethers';
import { parseFeedFrame } from '../src/chains/nitroFeed';
import { TransactionDecoder, DEFAULT_ROUTER_REGISTRY } from '../src/core/decoder';
import { seedKnownAddresses, ROBINHOOD_RAMSES, ROBINHOOD_TOKENS } from '../src/config/knownAddresses';

const SECONDS = Number(process.env.PROBE_SECONDS ?? 120);
const FEED = 'wss://feed.mainnet.chain.robinhood.com';
const RPC = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';

const registry = structuredClone(DEFAULT_ROUTER_REGISTRY);
seedKnownAddresses(registry);
const decoder = new TransactionDecoder(registry);
const provider = new ethers.JsonRpcProvider(RPC, 4663, { staticNetwork: true });
const erc20 = ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'];

(async () => {
  const pairs = new Map<string, { count: number; dexes: Map<string, number> }>();
  const tokenHits = new Map<string, number>();
  let swaps = 0;

  await new Promise<void>((resolve) => {
    const ws = new WebSocket(FEED);
    const t = setTimeout(() => { ws.terminate(); resolve(); }, SECONDS * 1000);
    ws.on('error', () => { clearTimeout(t); resolve(); });
    ws.on('message', async (raw) => {
      let frame: unknown;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      for (const tx of parseFeedFrame(frame)) {
        const s = await decoder.decode({ chain: 'robinhood', stateType: 'SEQUENCED', blockOrSeq: 0, receivedAtMs: 0, raw: { to: tx.to, data: tx.data, value: tx.value } });
        if (!s) continue;
        swaps++;
        const [a, b] = [s.tokenIn.toLowerCase(), s.tokenOut.toLowerCase()].sort();
        const key = `${a}/${b}`;
        const e = pairs.get(key) ?? { count: 0, dexes: new Map() };
        e.count++;
        e.dexes.set(s.dex, (e.dexes.get(s.dex) ?? 0) + 1);
        pairs.set(key, e);
        for (const tok of [a, b]) tokenHits.set(tok, (tokenHits.get(tok) ?? 0) + 1);
      }
    });
  });

  // Symbols + decimals for every token seen (straight from the token contracts).
  const meta = new Map<string, string>();
  for (const tok of tokenHits.keys()) {
    try {
      const c = new ethers.Contract(tok, erc20, provider);
      const [sym, dec] = await Promise.all([c.symbol(), c.decimals()]);
      meta.set(tok, `${sym}(${dec})`);
    } catch { meta.set(tok, `?(${tok.slice(0, 8)})`); }
  }

  const out: string[] = [`ROBINHOOD ${SECONDS}s: ${swaps} decoded swaps, ${pairs.size} distinct pairs`];
  const top = [...pairs.entries()].sort((x, y) => y[1].count - x[1].count).slice(0, 15);
  for (const [key, e] of top) {
    const [a, b] = key.split('/');
    const dexes = [...e.dexes.entries()].map(([d, n]) => `${d}:${n}`).join(' ');
    out.push(`${String(e.count).padStart(4)}  ${meta.get(a)}/${meta.get(b)}  [${dexes}]  ${a} ${b}`);
  }

  // Ramses V3 factory: keyed by fee (uint24) or by tick spacing (int24)?
  const W = ROBINHOOD_TOKENS.WETH, U = ROBINHOOD_TOKENS.USDG;
  const byFee = new ethers.Contract(ROBINHOOD_RAMSES.V3_FACTORY, ['function getPool(address,address,uint24) view returns (address)'], provider);
  const bySpacing = new ethers.Contract(ROBINHOOD_RAMSES.V3_FACTORY, ['function getPool(address,address,int24) view returns (address)'], provider);
  const feeHits: string[] = [], spacingHits: string[] = [];
  for (const f of [100, 500, 2500, 3000, 10000]) {
    try { const p: string = await byFee.getPool(W, U, f); if (p !== ethers.ZeroAddress) feeHits.push(`${f}:${p.slice(0, 10)}`); } catch { /* */ }
  }
  for (const sp of [1, 5, 10, 50, 60, 100, 200]) {
    try { const p: string = await bySpacing.getPool(W, U, sp); if (p !== ethers.ZeroAddress) spacingHits.push(`${sp}:${p.slice(0, 10)}`); } catch { /* */ }
  }
  out.push(`RAMSES V3 WETH/USDG by fee: ${feeHits.join(' ') || 'none'} | by tickSpacing: ${spacingHits.join(' ') || 'none'}`);

  console.log(out.join('\n'));
  process.exit(0);
})();
