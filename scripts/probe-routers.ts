// ============================================================================
// ROUTER PROBE -- which contracts send the swaps the bot can't read yet?
//
// Plain English:
//   Every swap on Robinhood leaves a Swap event on the pool it hit. This
//   collects those events for the last few hours, looks up the transaction
//   behind each one, and runs it through the bot's own decoder (the same
//   code that reads the live feed). Result: a table of "who sent these
//   swaps, how many, and how many the bot understood", so we know exactly
//   which aggregators / routers are worth teaching the bot next.
//   npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/probe-routers.js
//   ROUTER_HOURS (default 6) = how far back to look.
// ============================================================================
import { ethers } from 'ethers';
import { TransactionDecoder, DEFAULT_ROUTER_REGISTRY, TOPIC_V2_SWAP, TOPIC_V3_SWAP, TOPIC_PANCAKE_V3_SWAP } from '../src/core/decoder';
import { seedKnownAddresses } from '../src/config/knownAddresses';

const RPC = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const provider = new ethers.JsonRpcProvider(RPC, 4663, { staticNetwork: true, batchMaxCount: 20 });
const HOURS = Number(process.env.ROUTER_HOURS ?? 6);
// Uniswap V4 swaps are logged by the single PoolManager, not by a pool.
const TOPIC_V4_SWAP = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const TOPICS = [TOPIC_V2_SWAP, TOPIC_V3_SWAP, TOPIC_PANCAKE_V3_SWAP, TOPIC_V4_SWAP];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eth_getLogs by topic only (any contract), splitting busy ranges in half.
async function swapLogs(from: number, to: number): Promise<Array<{ tx: string; topic: string }>> {
  const out: Array<{ tx: string; topic: string }> = [];
  const stack: Array<[number, number]> = [[from, to]];
  while (stack.length) {
    const [f, t] = stack.pop()!;
    try {
      const logs = await provider.send('eth_getLogs', [{ fromBlock: ethers.toQuantity(f), toBlock: ethers.toQuantity(t), topics: [TOPICS] }]) as Array<{ transactionHash: string; topics: string[] }>;
      for (const l of logs) out.push({ tx: l.transactionHash, topic: l.topics[0] });
    } catch {
      if (t - f < 4) { await sleep(500); stack.push([f, t]); continue; } // tiny range failing = rate limit: wait, retry
      const m = Math.floor((f + t) / 2);
      stack.push([m + 1, t], [f, m]);
    }
  }
  return out;
}

(async () => {
  seedKnownAddresses(DEFAULT_ROUTER_REGISTRY);
  const decoder = new TransactionDecoder(DEFAULT_ROUTER_REGISTRY);
  const latest = await provider.getBlock('latest');
  if (!latest) throw new Error('no latest block');
  // Find the block HOURS ago from the average block time over the last 10k blocks.
  const older = await provider.getBlock(latest.number - 10_000);
  const blockSec = older ? (latest.timestamp - older.timestamp) / 10_000 : 0.25;
  const from = Math.max(0, latest.number - Math.round((HOURS * 3600) / Math.max(blockSec, 0.05)));
  const logs = await swapLogs(from, latest.number);

  // One entry per transaction (an aggregator trade can hit several pools).
  const byTx = new Map<string, Set<string>>();
  for (const l of logs) (byTx.get(l.tx) ?? byTx.set(l.tx, new Set()).get(l.tx)!).add(l.topic);
  const hashes = [...byTx.keys()];

  type Row = { txs: number; decoded: number; v4: number; selectors: Map<string, number>; known: boolean };
  const rows = new Map<string, Row>();
  let fetched = 0;
  for (let i = 0; i < hashes.length; i += 20) {
    const chunk = hashes.slice(i, i + 20);
    const txs = await Promise.all(chunk.map((h) => provider.getTransaction(h).catch(() => null)));
    for (let k = 0; k < txs.length; k++) {
      const tx = txs[k];
      if (!tx || !tx.to) continue;
      fetched++;
      const to = tx.to.toLowerCase();
      const row = rows.get(to) ?? { txs: 0, decoded: 0, v4: 0, selectors: new Map(), known: !!DEFAULT_ROUTER_REGISTRY.robinhood[to] };
      rows.set(to, row);
      row.txs++;
      if (byTx.get(chunk[k])!.has(TOPIC_V4_SWAP)) row.v4++;
      const sel = tx.data.slice(0, 10);
      row.selectors.set(sel, (row.selectors.get(sel) ?? 0) + 1);
      const ev = { chain: 'robinhood' as const, stateType: 'SEQUENCED' as const, blockOrSeq: 0, receivedAtMs: Date.now(), raw: { to: tx.to, data: tx.data, value: tx.value.toString() } };
      const d = await decoder.decode(ev).catch(() => null);
      if (d) row.decoded++;
    }
  }

  const total = [...rows.values()].reduce((s, r) => s + r.txs, 0);
  const decoded = [...rows.values()].reduce((s, r) => s + r.decoded, 0);
  console.log(`Last ${HOURS}h (blocks ${from}-${latest.number}, ~${blockSec.toFixed(2)}s/block): ${logs.length} swap events in ${hashes.length} txs, ${fetched} looked up`);
  console.log(`Bot decodes ${decoded}/${total} swap txs (${total ? Math.round((100 * decoded) / total) : 0}%) straight from the feed`);
  console.log('Top senders (to address | swap txs | share | decoded | V4 | known router? | top selectors):');
  const sorted = [...rows.entries()].sort((a, b) => b[1].txs - a[1].txs).slice(0, 18);
  for (const [to, r] of sorted) {
    const sels = [...r.selectors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, n]) => `${s}x${n}`).join(' ');
    const name = DEFAULT_ROUTER_REGISTRY.robinhood[to]?.dex;
    console.log(`${to} | ${r.txs} | ${Math.round((100 * r.txs) / total)}% | ${r.decoded} | ${r.v4} | ${r.known ? 'yes ' + name : 'no'} | ${sels}`);
  }
  process.exit(0);
})().catch((e) => { console.log(`failed: ${(e as Error).message}`); process.exit(0); });
