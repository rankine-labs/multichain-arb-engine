// ============================================================================
// EVERY-BLOCK READER LOAD TEST (research, read-only, never sends anything)
//
// Plain English:
//   The "every-block reader" idea asks the node for each new block's swaps,
//   about 9 times a second. Can the free public node keep that up?
//
//   For POLL_MINUTES, ask "give me every swap since the last block I saw"
//   every POLL_MS (default 110 ms, about one block), exactly as the reader
//   would. Measure: requests answered vs refused, how long answers take,
//   whether any blocks were skipped, and how many swaps came back.
//
// Settings: POLL_MINUTES (default 10), POLL_MS (default 110), POLL_RPC.
// ============================================================================
import { ethers } from 'ethers';
import { TOPIC_V2_SWAP, TOPIC_V3_SWAP, TOPIC_PANCAKE_V3_SWAP } from '../src/core/decoder';

const RPC = process.env.POLL_RPC ?? process.env.ROBINHOOD_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const MINUTES = Number(process.env.POLL_MINUTES ?? 10);
const POLL_MS = Number(process.env.POLL_MS ?? 110);
const TOPICS = [TOPIC_V2_SWAP, TOPIC_V3_SWAP, TOPIC_PANCAKE_V3_SWAP, ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)')];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc(method: string, params: unknown[]): Promise<{ ok: boolean; ms: number; result?: any; err?: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, ms, err: `HTTP ${res.status}` };
    const j: any = await res.json();
    if (j.error) return { ok: false, ms, err: String(j.error.message ?? j.error.code).slice(0, 60) };
    return { ok: true, ms, result: j.result };
  } catch (e) { return { ok: false, ms: Date.now() - t0, err: String((e as Error).message).slice(0, 60) }; }
}

function annotate(title: string, lines: string[]) {
  const body = lines.join('\n');
  console.log(`----- ${title} -----\n${body}`);
  console.log(`::notice title=${title}::${body.replace(/%/g, '%25').replace(/\n/g, '%0A')}`);
}

(async () => {
  const head0 = await rpc('eth_blockNumber', []);
  if (!head0.ok) { annotate('Every-block load test failed', [`no block number: ${head0.err}`]); return; }
  let last = Number(head0.result);
  const end = Date.now() + MINUTES * 60_000;
  let req = 0, ok = 0, swaps = 0, emptyPolls = 0, gaps = 0;
  const lat: number[] = [], errs = new Map<string, number>();
  let maxBlocksPerPoll = 0;
  while (Date.now() < end) {
    const t0 = Date.now();
    // "Every swap from the block after the last one seen, up to the newest."
    const r = await rpc('eth_getLogs', [{ fromBlock: ethers.toQuantity(last + 1), toBlock: 'latest', topics: [TOPICS] }]);
    req++; lat.push(r.ms);
    if (r.ok) {
      ok++;
      const logs = r.result as Array<{ blockNumber: string }>;
      swaps += logs.length;
      if (!logs.length) emptyPolls++;
      // Advance using the newest block number (also when no swaps came back).
      const h = await rpc('eth_blockNumber', []); req++; lat.push(h.ms);
      if (h.ok) {
        const head = Number(h.result); ok++;
        const covered = head - last;
        if (covered > 5) gaps++; // fell behind by more than ~0.5 s
        maxBlocksPerPoll = Math.max(maxBlocksPerPoll, covered);
        last = Math.max(last, head);
      } else errs.set(h.err!, (errs.get(h.err!) ?? 0) + 1);
    } else {
      errs.set(r.err!, (errs.get(r.err!) ?? 0) + 1);
      if (/429|rate|limit/i.test(r.err!)) await sleep(1_000);
    }
    const wait = POLL_MS - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
  }
  lat.sort((a, b) => a - b);
  const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] ?? 0;
  const perDay = Math.round((req / (MINUTES * 60)) * 86_400);
  annotate('Every-block load test', [
    `Node: ${RPC.replace(/\/v2\/.*/, '/v2/***')} for ${MINUTES} min, one poll every ${POLL_MS} ms (2 requests per poll).`,
    `Requests: ${req} sent, ${ok} answered (${req ? ((100 * ok) / req).toFixed(1) : 0}%), refused/failed: ${req - ok}${errs.size ? ' -> ' + [...errs.entries()].map(([e, n]) => `${e} x${n}`).join(', ') : ''}`,
    `Answer time: median ${pct(0.5)} ms, slowest 5% ${pct(0.95)} ms, worst ${lat[lat.length - 1] ?? 0} ms (from GitHub's servers, not ours).`,
    `Fell behind by more than 5 blocks: ${gaps} times; most blocks in one poll: ${maxBlocksPerPoll}. Swaps returned: ${swaps}; polls with no swaps: ${emptyPolls}.`,
    `At this rate: ~${perDay.toLocaleString('en-US')} requests a day.`,
  ]);
  process.exit(0);
})().catch((e) => { annotate('Every-block load test failed', [String((e as Error).message)]); process.exit(0); });
