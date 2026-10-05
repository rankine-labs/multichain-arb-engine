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
const HOURS = Number(process.env.ROUTER_HOURS ?? 0.1); // busy chain: 6 min is ~12k swap txs
// Uniswap V4 swaps are logged by the single PoolManager, not by a pool.
const TOPIC_V4_SWAP = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const TOPICS = [TOPIC_V2_SWAP, TOPIC_V3_SWAP, TOPIC_PANCAKE_V3_SWAP, TOPIC_V4_SWAP];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Hard stop: whatever happens, print what we have after this long.
const DEADLINE = Date.now() + Number(process.env.ROUTER_MAX_MIN ?? 20) * 60_000;
let logErrors = 0, lastLogError = '';

// eth_getLogs by topic only (any contract), splitting busy ranges in half.
// A range that keeps failing even when tiny is retried 3 times, then
// skipped and counted (never an endless loop).
async function swapLogs(from: number, to: number): Promise<Array<{ tx: string; topic: string }>> {
  const out: Array<{ tx: string; topic: string }> = [];
  const stack: Array<[number, number, number]> = [[from, to, 0]];
  while (stack.length && Date.now() < DEADLINE) {
    const [f, t, tries] = stack.pop()!;
    try {
      const logs = await provider.send('eth_getLogs', [{ fromBlock: ethers.toQuantity(f), toBlock: ethers.toQuantity(t), topics: [TOPICS] }]) as Array<{ transactionHash: string; topics: string[] }>;
      for (const l of logs) out.push({ tx: l.transactionHash, topic: l.topics[0] });
    } catch (err) {
      lastLogError = String((err as Error).message).slice(0, 120);
      if (t - f >= 4) { const m = Math.floor((f + t) / 2); stack.push([m + 1, t, 0], [f, m, 0]); continue; }
      if (tries < 3) { await sleep(1_000 * (tries + 1)); stack.push([f, t, tries + 1]); continue; }
      logErrors++; // give up on this little range
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
  console.log(`[progress] ${logs.length} swap events collected, looking up transactions...`);

  // One entry per transaction (an aggregator trade can hit several pools).
  const byTx = new Map<string, Set<string>>();
  for (const l of logs) (byTx.get(l.tx) ?? byTx.set(l.tx, new Set()).get(l.tx)!).add(l.topic);
  const hashes = [...byTx.keys()];

  type Row = { txs: number; decoded: number; v4: number; selectors: Map<string, number>; known: boolean };
  const rows = new Map<string, Row>();
  let fetched = 0;
  const txTo = new Map<string, string>();
  for (let i = 0; i < hashes.length && Date.now() < DEADLINE; i += 20) {
    const chunk = hashes.slice(i, i + 20);
    const txs = await Promise.all(chunk.map((h) => provider.getTransaction(h).catch(() => null)));
    for (let k = 0; k < txs.length; k++) {
      const tx = txs[k];
      if (!tx || !tx.to) continue;
      fetched++;
      const to = tx.to.toLowerCase();
      txTo.set(chunk[k], to);
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

  // V2/V3 coverage: the bot can only trade V2/V3 pools, so swaps that touch
  // only V2/V3 pools are the ones that matter for decoding today.
  const nonV4 = [...rows.values()].reduce((s, r) => s + (r.txs - r.v4), 0);
  const nonV4Decoded = [...rows.values()].reduce((s, r) => s + r.decoded, 0);
  const total = [...rows.values()].reduce((s, r) => s + r.txs, 0);
  const decoded = [...rows.values()].reduce((s, r) => s + r.decoded, 0);
  if (logErrors) console.log(`(${logErrors} small block ranges skipped after retries; last error: ${lastLogError})`);
  if (Date.now() >= DEADLINE) console.log('(stopped at the time limit: partial results)');
  console.log(`Last ${HOURS}h (blocks ${from}-${latest.number}, ~${blockSec.toFixed(2)}s/block): ${logs.length} swap events in ${hashes.length} txs, ${fetched} looked up`);
  console.log(`Bot decodes ${decoded}/${total} swap txs (${total ? Math.round((100 * decoded) / total) : 0}%) straight from the feed`);
  console.log(`V2/V3-only swap txs: ${nonV4}, decoded ${nonV4Decoded} (${nonV4 ? Math.round((100 * nonV4Decoded) / nonV4) : 0}%)`);

  // Universal Router copies (same execute() selector, unknown address): which
  // DEX factory do the pools they hit belong to? Decides how to register them.
  const UR_SELECTORS = new Set(['0x3593564c', '0x24856bc3']);
  const known: Record<string, string> = {};
  for (const [addr, e] of Object.entries(DEFAULT_ROUTER_REGISTRY.robinhood)) if (e.factory) known[e.factory.toLowerCase()] = e.dex;
  const factoryIface = new ethers.Interface(['function factory() view returns (address)']);
  const forks = [...rows.entries()].filter(([to, r]) => !r.known && [...r.selectors.keys()].some((x) => UR_SELECTORS.has(x)) && r.txs - r.v4 >= 20)
    .sort((a, b) => (b[1].txs - b[1].v4) - (a[1].txs - a[1].v4)).slice(0, 6);
  for (const [to] of forks) {
    const sample = hashes.filter((h) => txTo.get(h) === to && !byTx.get(h)!.has(TOPIC_V4_SWAP)).slice(0, 6);
    const seen = new Map<string, number>();
    for (const h of sample) {
      const rc = await provider.getTransactionReceipt(h).catch(() => null);
      for (const l of rc?.logs ?? []) {
        if (!TOPICS.includes(l.topics[0])) continue;
        let f = 'no factory()';
        try { f = (factoryIface.decodeFunctionResult('factory', await provider.call({ to: l.address, data: factoryIface.encodeFunctionData('factory') }))[0] as string).toLowerCase(); } catch { /* not a standard pool */ }
        const name = known[f] ?? f;
        seen.set(name, (seen.get(name) ?? 0) + 1);
      }
    }
    console.log(`UR copy ${to}: pools hit -> ${[...seen.entries()].map(([k, n]) => `${k} x${n}`).join(', ') || 'none found'}`);
  }

  console.log('Top senders (to address | swap txs | share | decoded | V4 | known router? | top selectors):');
  const sorted = [...rows.entries()].sort((a, b) => b[1].txs - a[1].txs).slice(0, 18);
  for (const [to, r] of sorted) {
    const sels = [...r.selectors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, n]) => `${s}x${n}`).join(' ');
    const name = DEFAULT_ROUTER_REGISTRY.robinhood[to]?.dex;
    console.log(`${to} | ${r.txs} | ${Math.round((100 * r.txs) / total)}% | ${r.decoded} | ${r.v4} | ${r.known ? 'yes ' + name : 'no'} | ${sels}`);
  }
  process.exit(0);
})().catch((e) => { console.log(`failed: ${(e as Error).message}`); process.exit(0); });
