// ============================================================================
// MISSED-TRIGGER MONEY TEST (research, read-only, never sends anything)
//
// Plain English:
//   The bot reacts instantly only to trades it can read from the live feed
//   (known routers). Other trades it notices up to 5 s later. Question: how
//   much money do those unreadable trades create for rival bots?
//
//   For the last MISSED_MINUTES of blocks:
//     1. collect every swap and group them by transaction
//     2. run each transaction through the bot's own feed decoder: readable?
//     3. "arbitrage" = one transaction swapping on 2+ pools; its profit is
//        read from its own coin movements (USDG and WETH only, closed loops
//        only = "confirmed"; anything else is counted but not priced)
//     4. the arbitrage's trigger = the last ordinary (one-transaction,
//        non-arbitrage) swap on any of its pools in the TRIG_BLOCKS before it
//     5. totals by trigger type: readable / unreadable / none (a sitting gap)
//        plus how many blocks after the trigger the rival landed
//
// Settings: MISSED_MINUTES (default 15), TRIG_BLOCKS (default 20 = ~2 s).
// ============================================================================
import { ethers } from 'ethers';
import { TransactionDecoder, DEFAULT_ROUTER_REGISTRY, TOPIC_V2_SWAP, TOPIC_V3_SWAP, TOPIC_PANCAKE_V3_SWAP } from '../src/core/decoder';
import { seedKnownAddresses, ROBINHOOD_TOKENS, ROBINHOOD_V4 } from '../src/config/knownAddresses';
import { RivalWatch } from '../src/core/rivalWatch';

const RPC = process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const provider = new ethers.JsonRpcProvider(RPC, 4663, { staticNetwork: true, batchMaxCount: 20 });
const MINUTES = Number(process.env.MISSED_MINUTES ?? 15);
const TRIG_BLOCKS = Number(process.env.TRIG_BLOCKS ?? 20);
const DEADLINE = Date.now() + Number(process.env.MISSED_MAX_MIN ?? 40) * 60_000;
const TOPIC_V4_SWAP = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const TOPICS = [TOPIC_V2_SWAP, TOPIC_V3_SWAP, TOPIC_PANCAKE_V3_SWAP, TOPIC_V4_SWAP];
const USDG = ROBINHOOD_TOKENS.USDG.toLowerCase(), WETH = ROBINHOOD_TOKENS.WETH.toLowerCase();
const PM = ROBINHOOD_V4.POOL_MANAGER.toLowerCase();
const WETH_USDG_POOL = '0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca'; // Uniswap V3 0.01%
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type L = { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string; transactionIndex: string; logIndex: string };

// eth_getLogs over a range, splitting busy ranges in half.
async function swapLogs(from: number, to: number): Promise<L[]> {
  const out: L[] = [];
  const stack: Array<[number, number, number]> = [[from, to, 0]];
  while (stack.length && Date.now() < DEADLINE) {
    const [f, t, tries] = stack.pop()!;
    try {
      out.push(...(await provider.send('eth_getLogs', [{ fromBlock: ethers.toQuantity(f), toBlock: ethers.toQuantity(t), topics: [TOPICS] }]) as L[]));
    } catch {
      if (t - f >= 4) { const m = Math.floor((f + t) / 2); stack.push([m + 1, t, 0], [f, m, 0]); continue; }
      if (tries < 3) { await sleep(1_000 * (tries + 1)); stack.push([f, t, tries + 1]); }
    }
  }
  return out;
}

const poolOf = (l: L) => (l.topics[0] === TOPIC_V4_SWAP && l.address.toLowerCase() === PM ? l.topics[1].toLowerCase() : l.address.toLowerCase());

function annotate(title: string, lines: string[]) {
  const body = lines.join('\n');
  console.log(`----- ${title} -----\n${body}`);
  console.log(`::notice title=${title}::${body.replace(/%/g, '%25').replace(/\n/g, '%0A')}`);
}

(async () => {
  seedKnownAddresses(DEFAULT_ROUTER_REGISTRY);
  const decoder = new TransactionDecoder(DEFAULT_ROUTER_REGISTRY);
  const latest = await provider.getBlock('latest');
  const older = await provider.getBlock(latest!.number - 10_000);
  const blockSec = older ? (latest!.timestamp - older.timestamp) / 10_000 : 0.11;
  const from = latest!.number - Math.round((MINUTES * 60) / Math.max(blockSec, 0.05));

  // WETH price from the deep WETH/USDG pool (token0 = WETH 18 dec, token1 = USDG 6 dec).
  const slot0 = await provider.call({ to: WETH_USDG_POOL, data: '0x3850c7bd' });
  const sqrtP = Number(BigInt(slot0.slice(0, 66))) / 2 ** 96;
  const ethUsd = sqrtP * sqrtP * 1e12;

  const logs = await swapLogs(from, latest!.number);
  // Per transaction: block, position, pools touched.
  const txs = new Map<string, { block: number; idx: number; pools: Set<string> }>();
  for (const l of logs) {
    const t = txs.get(l.transactionHash) ?? { block: Number(l.blockNumber), idx: Number(l.transactionIndex), pools: new Set<string>() };
    t.pools.add(poolOf(l)); txs.set(l.transactionHash, t);
  }
  const ordered = [...txs.entries()].sort((a, b) => a[1].block - b[1].block || a[1].idx - b[1].idx);
  console.log(`[progress] ${logs.length} swaps in ${ordered.length} txs over ${latest!.number - from} blocks; ETH $${ethUsd.toFixed(0)}`);

  // Ordinary swaps (1 pool) need a readable/unreadable verdict; arbitrages need receipts.
  const readable = new Map<string, boolean>();
  const ordinary = ordered.filter(([, t]) => t.pools.size === 1).map(([h]) => h);
  for (let i = 0; i < ordinary.length && Date.now() < DEADLINE; i += 20) {
    const chunk = ordinary.slice(i, i + 20);
    const got = await Promise.all(chunk.map((h) => provider.getTransaction(h).catch(() => null)));
    for (let k = 0; k < chunk.length; k++) {
      const tx = got[k];
      if (!tx || !tx.to) continue;
      const d = await decoder.decode({ chain: 'robinhood', stateType: 'SEQUENCED', blockOrSeq: 0, receivedAtMs: Date.now(), raw: { to: tx.to, data: tx.data, value: tx.value.toString() } } as any).catch(() => null);
      readable.set(chunk[k], !!d);
    }
  }

  // Arbitrages: priced from their own coin movements.
  type Arb = { hash: string; block: number; idx: number; pools: Set<string>; usd: number | null };
  const arbs: Arb[] = [];
  const arbList = ordered.filter(([, t]) => t.pools.size >= 2);
  for (let i = 0; i < arbList.length && Date.now() < DEADLINE; i += 20) {
    const chunk = arbList.slice(i, i + 20);
    const rcs = await Promise.all(chunk.map(([h]) => provider.send('eth_getTransactionReceipt', [h]).catch(() => null)));
    for (let k = 0; k < chunk.length; k++) {
      const rc = rcs[k]; const [h, t] = chunk[k];
      if (!rc || rc.status !== '0x1') continue;
      const traders = [String(rc.to ?? '').toLowerCase(), String(rc.from ?? '').toLowerCase()].filter(Boolean);
      const tr = RivalWatch.analyze(rc.logs ?? [], traders, PM);
      let usd: number | null = 0, neg = false;
      for (const [tok, v] of tr.net) {
        if (v === 0n) continue;
        if (v < 0n) { neg = true; break; }
        if (tok.toLowerCase() === USDG) usd! += Number(v) / 1e6;
        else if (tok.toLowerCase() === WETH) usd! += (Number(v) / 1e18) * ethUsd;
        else { usd = null; break; }
      }
      const gas = Number(BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice ?? '0x0')) / 1e18 * ethUsd;
      // Closed loop in USDG/WETH with a gain: confirmed. Junk guard: over $5,000 = broken pool.
      const net = neg || usd === null ? null : usd - gas;
      arbs.push({ hash: h, block: t.block, idx: t.idx, pools: t.pools, usd: net !== null && net > 0 && net < 5_000 ? net : null });
    }
  }

  // Trigger for each arbitrage: last ordinary swap on any of its pools, in the TRIG_BLOCKS before it.
  type Cls = 'readable' | 'unreadable' | 'none';
  const stats: Record<Cls, { n: number; priced: number; usd: number; big: number; lag: number[] }> = {
    readable: { n: 0, priced: 0, usd: 0, big: 0, lag: [] }, unreadable: { n: 0, priced: 0, usd: 0, big: 0, lag: [] }, none: { n: 0, priced: 0, usd: 0, big: 0, lag: [] },
  };
  const ordIdx = ordered.filter(([, t]) => t.pools.size === 1);
  let j = 0;
  const recent: Array<[string, { block: number; idx: number; pools: Set<string> }]> = [];
  const bigUnreadable: string[] = [];
  for (const a of arbs) {
    while (j < ordIdx.length && (ordIdx[j][1].block < a.block || (ordIdx[j][1].block === a.block && ordIdx[j][1].idx < a.idx))) recent.push(ordIdx[j++]);
    while (recent.length && recent[0][1].block < a.block - TRIG_BLOCKS) recent.shift();
    let trig: [string, { block: number; idx: number; pools: Set<string> }] | null = null;
    for (let r = recent.length - 1; r >= 0; r--) if ([...recent[r][1].pools].some((p) => a.pools.has(p))) { trig = recent[r]; break; }
    const cls: Cls = !trig ? 'none' : readable.get(trig[0]) ? 'readable' : readable.has(trig[0]) ? 'unreadable' : 'none';
    const s = stats[cls];
    s.n++;
    if (trig) s.lag.push(a.block - trig[1].block);
    if (a.usd !== null) { s.priced++; s.usd += a.usd; if (a.usd >= 1) { s.big++; if (cls === 'unreadable') bigUnreadable.push(`$${a.usd.toFixed(2)} ${a.block - trig![1].block} blk after ${trig![0].slice(0, 12)}`); } }
  }
  const perDay = (24 * 60) / MINUTES;
  const lagText = (xs: number[]) => {
    if (!xs.length) return 'n/a';
    const b = (lo: number, hi: number) => xs.filter((x) => x >= lo && x <= hi).length;
    return `same block ${b(0, 0)}, 1 block ${b(1, 1)}, 2-3 blocks ${b(2, 3)}, 4+ blocks ${b(4, 1e9)}`;
  };
  const lines = [
    `Window: ${MINUTES} min (blocks ${from}-${latest!.number}), ${ordered.length} swap txs, ${arbs.length} successful arbitrages. Confirmed = closed USDG/WETH loop, after gas.`,
    ...(['readable', 'unreadable', 'none'] as Cls[]).map((c) => {
      const s = stats[c];
      const name = c === 'readable' ? 'Trigger the bot CAN read' : c === 'unreadable' ? 'Trigger the bot CANNOT read' : 'No trigger (sitting gap)';
      return `${name}: ${s.n} arbs, ${s.priced} confirmed $${s.usd.toFixed(2)} (~$${(s.usd * perDay).toFixed(0)}/day at this pace), $1+: ${s.big}; rival landed after trigger: ${lagText(s.lag)}`;
    }),
    `Biggest unreadable-trigger wins: ${bigUnreadable.slice(0, 8).join(' | ') || 'none'}`,
    Date.now() >= DEADLINE ? '(stopped at the time limit: partial results)' : '',
  ];
  annotate('Missed-trigger money test', lines);
  process.exit(0);
})().catch((e) => { annotate('Missed-trigger money test failed', [String((e as Error).message)]); process.exit(0); });
