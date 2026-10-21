// ============================================================================
// LIVE REACTION TIME (read only): could we have got there before the rival?
//
// Plain English:
//   History can't tell us when WE would have received the data, so this runs
//   live, next to the bot (own connections, bot untouched), for --minutes:
//     1. Robinhood's public sequencer feed: when each transaction first shows
//        up (the rival's arbitrage included).
//     2. Chainstack WebSocket push of our pools' swap reports (pairs on 2+
//        exchanges) and of new blocks: when each report reaches this server.
//        Reports are also checked on arrival against our pool list (so we
//        know the push only sends our pools: the count question from the
//        timing test).
//     3. Every transaction with 2+ swaps on our pools gets its receipt read
//        and the bot's own arbitrage reader (core/followMoney classifyTx)
//        says if it was an arbitrage.
//     4. For each rival arbitrage: the last earlier change on its pools (the
//        moment the gap it took was last moved), when that change's report
//        reached us, and when the rival's own transaction showed up in the
//        feed. Headroom = rival seen in feed - gap report reached us.
//     5. Our own time to act, measured here:
//          - signing: a THROWAWAY key made by this script (never the bot's
//            key), signing an execute-sized transaction, every 5 s; never sent
//          - sending: round trip of a harmless read (eth_chainId) to the
//            bot's send node (ROBINHOOD_SEND_RPC), every 5 s; half of it is
//            the one-way trip a real trade would take (an estimate)
//          - calculation: --engine-ms (default 5 ms = ~8 engine checks of
//            0.54 ms each, measured on this server in go/no-go #1, rounded
//            up). The live pool copy itself is not built yet.
//        "Would have been in time" = headroom > calculation + signing + send.
//        The rival's feed time is when the feed reached US, a few ms after
//        the sequencer ordered it, so this is slightly generous to us.
//   Writes <out>/reaction.json (summary) and <out>/arbs.jsonl (one line per
//   rival arbitrage; feed it to measureProfit.js --arbs for the dollars).
//
// Safety: reads only. From the bot's .env only CHAINSTACK_WSS_ROBINHOOD,
// CHAINSTACK_RPC_ROBINHOOD and ROBINHOOD_SEND_RPC are read (never printed).
// Signs only with a random throwaway key, sends nothing.
//
// Run (after `npx tsc -p scripts/sim-compare/tsconfig.json`):
//   node .scripts-build/scripts/sim-compare/liveReaction.js [--minutes 60] [--out DIR] [--engine-ms 5]
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { performance } from 'perf_hooks';
import WebSocket from 'ws';
import { ethers } from 'ethers';
import { parseFeedFrame } from '../../src/chains/nitroFeed';
import { decodeSwapLog, classifyTx, receiptGasWei } from '../../src/core/followMoney';
import { ROBINHOOD_TOKENS } from '../../src/config/knownAddresses';

const BOT_DIR = process.env.BOT_DIR || `${process.env.HOME}/multichain-arb-engine`;
const args = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const MINUTES = Number(arg('minutes', '60'));
const OUT = arg('out', `${process.env.HOME}/sim-compare-runs/reaction1`)!;
const ENGINE_MS = Number(arg('engine-ms', '5'));
const RPS = Number(arg('rps', '8'));
const FEED_URL = arg('feed', 'wss://feed.mainnet.chain.robinhood.com')!;
const RH_POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const WETH = ROBINHOOD_TOKENS.WETH.toLowerCase();
mkdirSync(OUT, { recursive: true });
const lc = (s: string) => String(s ?? '').toLowerCase();

// Only these three .env lines are read, never printed.
const envFile = readFileSync(join(BOT_DIR, '.env'), 'utf8');
const envVar = (k: string): string | null => { const m = envFile.match(new RegExp(`^\\s*${k}\\s*=\\s*["']?([^"'\\s#]+)`, 'm')); return m ? m[1] : null; };
const WSS = envVar('CHAINSTACK_WSS_ROBINHOOD');
const HTTP = envVar('CHAINSTACK_RPC_ROBINHOOD');
const SEND = envVar('ROBINHOOD_SEND_RPC') ?? HTTP;
if (!WSS || !HTTP) { console.error('CHAINSTACK_WSS_ROBINHOOD / CHAINSTACK_RPC_ROBINHOOD missing in .env'); process.exit(1); }

// --- pools we trade (pairs on 2+ exchanges), as in the other scripts --------
const watch = JSON.parse(readFileSync(join(BOT_DIR, 'data', 'watched-pools.json'), 'utf8'));
const all: any[] = (watch.pools || []).filter((p: any) => p && p.chain === 'robinhood' && p.poolAddress && p.tokenA && p.tokenB);
const byPair = new Map<string, any[]>();
for (const p of all) { const k = [lc(p.tokenA), lc(p.tokenB)].sort().join('/'); (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(p); }
const ours = new Map<string, any>();
for (const list of byPair.values()) if (new Set(list.map((p) => p.dex)).size >= 2) for (const p of list) ours.set(lc(p.poolAddress), p);
const addrs = [...ours.keys()].filter((a) => a.length === 42), ids = [...ours.keys()].filter((a) => a.length === 66);
const v4Currencies = (id: string) => {
  const p = ours.get(lc(id)); if (!p) return null;
  const n = (t: string) => (p.v4?.native && lc(t) === WETH ? '0x0000000000000000000000000000000000000000' : lc(t));
  return { c0: n(p.tokenA), c1: n(p.tokenB) };
};

// --- what we record ---------------------------------------------------------
type Change = { hash: string; block: number; txIndex: number; reportMs: number };
type Tx = { hash: string; block: number; txIndex: number; pools: Set<string>; swaps: number; reportMs: number; prev: Change | null; queued: boolean };
const feedSeen = new Map<string, number>();       // tx hash -> first seen in feed (ms)
const lastChange = new Map<string, Change>();     // pool -> latest change seen
const txs = new Map<string, Tx>();                // tx hash -> what touched our pools
const headSeen = new Map<number, number>();       // block -> header arrival (ms)
const signMs: number[] = [], sendRttMs: number[] = [];
const c = { feedFrames: 0, swapReportsAccepted: 0, reportsNotOurPools: 0, txsOnOurPools: 0, candidates: 0, receiptsRead: 0, receiptErrors: 0, droppedBusy: 0, arbs: 0, wsErrors: 0, feedErrors: 0 };
const arbsFile = join(OUT, 'arbs.jsonl'); writeFileSync(arbsFile, '');
const rows: any[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const later = (a: { block: number; txIndex: number }, b: { block: number; txIndex: number }) => a.block > b.block || (a.block === b.block && a.txIndex > b.txIndex);

// --- rate-limited receipt reader --------------------------------------------
let last = 0, rid = 0, requests = 0;
async function rpc(method: string, params: unknown[]): Promise<any> {
  const w = last + 1000 / RPS - Date.now(); if (w > 0) await sleep(w);
  last = Date.now(); requests++;
  try {
    const r = await fetch(HTTP!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }), signal: AbortSignal.timeout(10_000) });
    return await r.json();
  } catch { return { error: { message: 'network' } }; }
}
const queue: Tx[] = [];
async function receiptWorker() {
  for (;;) {
    const t = queue.shift(); if (!t) { await sleep(100); continue; }
    let r: any = null, tx: any = null;
    for (let a = 0; a < 3 && !(r?.result && tx?.result); a++) {
      [r, tx] = [await rpc('eth_getTransactionReceipt', [t.hash]), await rpc('eth_getTransactionByHash', [t.hash])];
      if (!(r?.result && tx?.result)) await sleep(500);
    }
    if (!r?.result || !tx?.result) { c.receiptErrors++; continue; }
    c.receiptsRead++;
    const g = receiptGasWei(r.result);
    const cl = classifyTx(r.result.logs, tx.result.from, tx.result.to, r.result.status,
      { hash: t.hash, block: t.block, txIndex: t.txIndex, gasWei: g.gasWei, l1GasUsed: g.l1GasUsed }, { weth: WETH, poolManager: RH_POOL_MANAGER, v4Currencies });
    if (!cl.arb) continue;
    c.arbs++;
    const feedMs = feedSeen.get(t.hash) ?? null;
    const p = t.prev;
    const gapBlocks = p ? t.block - p.block : null;
    const bucket = gapBlocks === null ? 'none seen' : gapBlocks === 0 ? 'same block' : gapBlocks === 1 ? '1 block' : gapBlocks <= 4 ? '2-4 blocks' : gapBlocks <= 40 ? '5-40 blocks (1-10 s)' : '>40 blocks';
    const row = {
      hash: t.hash, block: t.block, txIndex: t.txIndex, by: lc(tx.result.to), pools: [...t.pools], bucket, gapBlocks,
      rivalFeedMs: feedMs, rivalReportMs: t.reportMs,
      prevHash: p?.hash ?? null, prevBlock: p?.block ?? null, prevReportMs: p?.reportMs ?? null, prevFeedMs: p ? feedSeen.get(p.hash) ?? null : null,
      // headroom: time between the gap's last change reaching us and the rival showing up
      headroomFromReportMs: feedMs !== null && p ? feedMs - p.reportMs : null,
      headroomFromFeedMs: feedMs !== null && p && feedSeen.has(p.hash) ? feedMs - feedSeen.get(p.hash)! : null,
    };
    rows.push(row); appendFileSync(arbsFile, JSON.stringify(row) + '\n');
  }
}

// --- the measurements of our own time to act --------------------------------
const throwaway = ethers.Wallet.createRandom();   // made here, never funded, never sent
async function measureSelf() {
  const data = ethers.hexlify(ethers.randomBytes(800)); // ~ size of an execute() call
  let nonce = 0;
  for (;;) {
    const t0 = performance.now();
    await throwaway.signTransaction({ type: 2, chainId: 4663, nonce: nonce++, to: '0x7e0f847dd429e7c15ab08686d28710389c1f7837', data, gasLimit: 1_500_000, maxFeePerGas: 10n ** 8n, maxPriorityFeePerGas: 0n });
    signMs.push(performance.now() - t0);
    const t1 = performance.now();
    try {
      await fetch(SEND!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(5_000) });
      sendRttMs.push(performance.now() - t1);
    } catch { /* counted by absence */ }
    await sleep(5_000);
  }
}

function pct(v: number[], p: number) { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); }

function main() {
  console.log(`pools we trade: ${addrs.length} contracts + ${ids.length} V4 pools; running ${MINUTES} min; engine ${ENGINE_MS} ms`);
  // 1. Sequencer feed.
  const openFeed = () => {
    const ws = new WebSocket(FEED_URL);
    ws.on('message', (d) => {
      const now = Date.now(); c.feedFrames++;
      try { for (const t of parseFeedFrame(JSON.parse(d.toString()))) if (t.hash && !feedSeen.has(lc(t.hash))) feedSeen.set(lc(t.hash), now); } catch { c.feedErrors++; }
    });
    ws.on('close', () => setTimeout(openFeed, 2000));
    ws.on('error', () => { c.feedErrors++; });
  };
  openFeed();
  // 2. Chainstack push: new blocks + our pools' reports.
  const addrSet = new Set(addrs), idSet = new Set(ids);
  const openPush = () => {
    const ws = new WebSocket(WSS!);
    let sid = 0;
    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++sid, method: 'eth_subscribe', params: ['newHeads'] }));
      for (let i = 0; i < addrs.length; i += 200) ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++sid, method: 'eth_subscribe', params: ['logs', { address: addrs.slice(i, i + 200) }] }));
      for (let i = 0; i < ids.length; i += 100) ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++sid, method: 'eth_subscribe', params: ['logs', { address: RH_POOL_MANAGER, topics: [null, ids.slice(i, i + 100)] }] }));
    });
    ws.on('message', (d) => {
      const now = Date.now();
      try {
        const m = JSON.parse(d.toString()); const r = m?.params?.result; if (!r) return;
        if (r.parentHash && r.number && !r.transactionHash) { const n = parseInt(r.number, 16); if (!headSeen.has(n)) headSeen.set(n, now); return; }
        const s = r.transactionHash ? decodeSwapLog(r) : null; if (!s) return;
        // Is it really one of our pools? (checks the push's own filtering)
        const pool = lc(s.pool);
        const isOurs = lc(r.address) === RH_POOL_MANAGER ? idSet.has(pool) : addrSet.has(lc(r.address)) && addrSet.has(pool);
        if (!isOurs) { c.reportsNotOurPools++; return; }
        if (r.removed) return;
        c.swapReportsAccepted++;
        const hash = lc(r.transactionHash), block = parseInt(r.blockNumber, 16), txIndex = parseInt(r.transactionIndex, 16);
        let t = txs.get(hash);
        if (!t) { t = { hash, block, txIndex, pools: new Set(), swaps: 0, reportMs: now, prev: null, queued: false }; txs.set(hash, t); c.txsOnOurPools++; }
        // The last earlier change on this pool (before we record this one).
        const lc0 = lastChange.get(pool);
        if (lc0 && lc0.hash !== hash && later(t, lc0) && (!t.prev || later(lc0, t.prev))) t.prev = lc0;
        t.pools.add(pool); t.swaps++;
        const cur = lastChange.get(pool);
        if (!cur || later(t, cur)) lastChange.set(pool, { hash, block, txIndex, reportMs: t.reportMs });
        // 2+ swaps on our pools: possible arbitrage -> read its receipt shortly.
        if (t.swaps === 2 && !t.queued) {
          t.queued = true; c.candidates++;
          if (queue.length > 300) c.droppedBusy++; else setTimeout(() => queue.push(t!), 300);
        }
      } catch { c.wsErrors++; }
    });
    ws.on('close', () => setTimeout(openPush, 2000));
    ws.on('error', () => { c.wsErrors++; });
  };
  openPush();
  receiptWorker();
  measureSelf();

  // Forget old data so memory stays small.
  setInterval(() => {
    const cut = Date.now() - 5 * 60_000;
    for (const [h, t] of feedSeen) if (t < cut) feedSeen.delete(h); else break;
    for (const [h, t] of txs) if (t.reportMs < cut) txs.delete(h); else break;
  }, 60_000);

  const summary = () => {
    const signP50 = pct(signMs, 0.5) ?? 0, oneWay = (pct(sendRttMs, 0.5) ?? 0) / 2;
    const needMs = +(ENGINE_MS + signP50 + oneWay).toFixed(2);
    const byBucket: Record<string, any> = {};
    for (const r of rows) {
      const b = byBucket[r.bucket] ?? (byBucket[r.bucket] = { arbs: 0, timed: 0, inTime: 0, headroomMs: [] as number[] });
      b.arbs++;
      if (r.headroomFromReportMs !== null) { b.timed++; b.headroomMs.push(r.headroomFromReportMs); if (r.headroomFromReportMs > needMs) b.inTime++; }
    }
    const buckets = Object.fromEntries(Object.entries(byBucket).map(([k, b]: any) => [k, { arbs: b.arbs, timed: b.timed, inTime: b.inTime, pctInTime: b.timed ? +(100 * b.inTime / b.timed).toFixed(1) : null, headroomMs_median: pct(b.headroomMs, 0.5), headroomMs_p10: pct(b.headroomMs, 0.1) }]));
    const timed = rows.filter((r) => r.headroomFromReportMs !== null);
    const minutesRun = (Date.now() - started) / 60_000;
    return {
      minutes: +minutesRun.toFixed(1), ...c,
      txsOnOurPoolsPerSec: +(c.txsOnOurPools / (minutesRun * 60)).toFixed(2),
      ourTime: { engineMs_assumed: ENGINE_MS, signMs_median: signP50, signMs_p99: pct(signMs, 0.99), sendRoundTripMs_median: pct(sendRttMs, 0.5), sendRoundTripMs_p90: pct(sendRttMs, 0.9), totalNeedMs: needMs },
      arbsTimed: timed.length, arbsInTime: timed.filter((r) => r.headroomFromReportMs > needMs).length,
      pctInTime: timed.length ? +(100 * timed.filter((r) => r.headroomFromReportMs > needMs).length / timed.length).toFixed(1) : null,
      byGapAge: buckets, nodeRequestsUsed: requests,
    };
  };
  const started = Date.now();
  const t = setInterval(() => console.log(new Date().toISOString().slice(11, 19), JSON.stringify(summary())), 60_000);
  setTimeout(async () => {
    clearInterval(t);
    await sleep(5_000); // let the last receipts finish
    const s = summary();
    writeFileSync(join(OUT, 'reaction.json'), JSON.stringify(s, null, 1));
    console.log('SUMMARY ' + JSON.stringify(s));
    process.exit(0);
  }, MINUTES * 60_000);
}
main();
