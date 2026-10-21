// ============================================================================
// LIVE TIMING (read only): how late do our pools' trade reports arrive,
// compared with the moment the trade first shows up in the sequencer feed?
//
// Plain English:
//   Opens two connections, both read-only, separate from the bot:
//     1. Robinhood's public sequencer feed (the earliest place a trade shows up)
//     2. a Chainstack WebSocket subscription to the swap reports ("logs") of
//        the pools we trade (pairs on 2+ exchanges)
//   For every trade that swapped on our pools, it records when it was first
//   seen in the feed and when its pool report arrived, and prints the delay
//   (median / 90% / 99%). That delay is the "late" part of reacting from pool
//   reports instead of reading trades from the feed. Runs --minutes (default 20).
//   Writes <out>/latency.json + one line per trade.
//
// Safety: reads only. From the bot's .env only CHAINSTACK_WSS_ROBINHOOD is
// read (never printed). Sends nothing, signs nothing.
//
// Run (after `npx tsc -p scripts/sim-compare/tsconfig.json`):
//   node .scripts-build/scripts/sim-compare/liveLatency.js [--minutes 20] [--out DIR]
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync, createWriteStream } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';
import { parseFeedFrame } from '../../src/chains/nitroFeed';
import { decodeSwapLog } from '../../src/core/followMoney';

const BOT_DIR = process.env.BOT_DIR || `${process.env.HOME}/multichain-arb-engine`;
const args = process.argv.slice(2);
const arg = (k: string, d?: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const MINUTES = Number(arg('minutes', '20'));
const OUT = arg('out', `${process.env.HOME}/sim-compare-runs/latency1`)!;
const FEED_URL = arg('feed', 'wss://feed.mainnet.chain.robinhood.com')!;
const RH_POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
mkdirSync(OUT, { recursive: true });
const lc = (s: string) => String(s).toLowerCase();

function wssUrl(): string {
  const m = readFileSync(join(BOT_DIR, '.env'), 'utf8').match(/^\s*CHAINSTACK_WSS_ROBINHOOD\s*=\s*["']?([^"'\s#]+)/m);
  if (!m) throw new Error('CHAINSTACK_WSS_ROBINHOOD not found in .env');
  return m[1];
}

// Pools we trade (pairs on 2+ exchanges).
const watch = JSON.parse(readFileSync(join(BOT_DIR, 'data', 'watched-pools.json'), 'utf8'));
const all: any[] = (watch.pools || []).filter((p: any) => p && p.chain === 'robinhood' && p.poolAddress && p.tokenA && p.tokenB);
const byPair = new Map<string, any[]>();
for (const p of all) { const k = [lc(p.tokenA), lc(p.tokenB)].sort().join('/'); (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(p); }
const addrs: string[] = [], ids: string[] = [];
for (const list of byPair.values()) {
  if (new Set(list.map((p) => p.dex)).size < 2) continue;
  for (const p of list) (lc(p.poolAddress).length === 66 ? ids : addrs).push(lc(p.poolAddress));
}

const feedSeen = new Map<string, number>();   // tx hash -> first time seen in the feed (ms)
const reportSeen = new Map<string, number>(); // tx hash -> first pool report arrival (ms)
const lines = createWriteStream(join(OUT, 'per-trade.jsonl'), { flags: 'a' });
let frames = 0, reports = 0, feedErrors = 0, wsErrors = 0;

function pct(v: number[], p: number) { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }

function main() {
  console.log(`pools we trade: ${addrs.length} contracts + ${ids.length} V4 pools; running ${MINUTES} min`);
  // 1. Sequencer feed (the bot's own parser).
  const openFeed = () => {
    const ws = new WebSocket(FEED_URL);
    ws.on('message', (data) => {
      const now = Date.now(); frames++;
      try { for (const t of parseFeedFrame(JSON.parse(data.toString()))) if (t.hash && !feedSeen.has(lc(t.hash))) feedSeen.set(lc(t.hash), now); } catch { feedErrors++; }
    });
    ws.on('close', () => setTimeout(openFeed, 2000));
    ws.on('error', () => { feedErrors++; });
  };
  openFeed();
  // 2. Chainstack log subscriptions for our pools (chunks of 200 addresses / 100 V4 ids).
  const ws = new WebSocket(wssUrl());
  let sid = 0;
  ws.on('open', () => {
    for (let i = 0; i < addrs.length; i += 200) ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++sid, method: 'eth_subscribe', params: ['logs', { address: addrs.slice(i, i + 200) }] }));
    for (let i = 0; i < ids.length; i += 100) ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++sid, method: 'eth_subscribe', params: ['logs', { address: RH_POOL_MANAGER, topics: [null, ids.slice(i, i + 100)] }] }));
  });
  ws.on('message', (data) => {
    const now = Date.now();
    try {
      const m = JSON.parse(data.toString());
      const l = m?.params?.result; if (!l?.transactionHash || !decodeSwapLog(l)) return;
      reports++;
      const h = lc(l.transactionHash);
      if (reportSeen.has(h)) return;
      reportSeen.set(h, now);
      const f = feedSeen.get(h);
      lines.write(JSON.stringify({ h, block: parseInt(l.blockNumber, 16), feedMs: f ?? null, reportMs: now, delayMs: f !== undefined ? now - f : null }) + '\n');
    } catch { wsErrors++; }
  });
  ws.on('error', () => { wsErrors++; });

  const summary = () => {
    const delays: number[] = [];
    let notInFeed = 0;
    for (const [h, r] of reportSeen) { const f = feedSeen.get(h); if (f === undefined) notInFeed++; else delays.push(r - f); }
    return { minutes: MINUTES, feedFrames: frames, tradesWithPoolReports: reportSeen.size, poolReports: reports, reportsWithoutFeedSighting: notInFeed,
      delayMs_feedToReport: { median: pct(delays, 0.5), p90: pct(delays, 0.9), p99: pct(delays, 0.99), max: delays.length ? Math.max(...delays) : null, n: delays.length },
      feedErrors, wsErrors };
  };
  const t = setInterval(() => console.log(new Date().toISOString().slice(11, 19), JSON.stringify(summary())), 60_000);
  setTimeout(() => {
    clearInterval(t);
    const s = summary();
    writeFileSync(join(OUT, 'latency.json'), JSON.stringify(s, null, 1));
    console.log('SUMMARY ' + JSON.stringify(s));
    process.exit(0);
  }, MINUTES * 60_000);
}
main();
