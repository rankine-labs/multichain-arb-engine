// ============================================================================
// LIVE FEED PROBE (diagnostic, not part of the bot)
//
// Connects to the real chain feeds for a short time and reports whether the
// bot's parsers actually understand what arrives. Run in CI (GitHub's
// runners can reach the feeds) or on the server:
//
//   npx tsc -p tsconfig.scripts.json && node .scripts-build/scripts/probe-feeds.js
//   (PROBE_SECONDS=60 for a longer listen; default 30s per feed)
//
// Needs no keys. Monad uses MONAD_PROBE_WSS (default: public endpoint) --
// the public endpoint may not support monadLogs; that's reported, not fatal.
// ============================================================================

import WebSocket from 'ws';
import { parseFeedFrame, maxSequenceNumber } from '../src/chains/nitroFeed';
import { TransactionDecoder, DEFAULT_ROUTER_REGISTRY, TOPIC_V2_SWAP, TOPIC_V3_SWAP, TOPIC_PANCAKE_V3_SWAP } from '../src/core/decoder';
import { seedKnownAddresses } from '../src/config/knownAddresses';

const SECONDS = Number(process.env.PROBE_SECONDS ?? 30);
const ROBINHOOD_FEED = 'wss://feed.mainnet.chain.robinhood.com';
const MONAD_WSS = process.env.MONAD_PROBE_WSS ?? 'wss://rpc.monad.xyz';

const registry = structuredClone(DEFAULT_ROUTER_REGISTRY);
seedKnownAddresses(registry);
const decoder = new TransactionDecoder(registry);

function listen(url: string, onOpen: (ws: WebSocket) => void, onMsg: (data: any) => void): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let status = 'connected';
    const done = () => { try { ws.terminate(); } catch { /* */ } resolve(status); };
    const timer = setTimeout(done, SECONDS * 1000);
    ws.on('open', () => onOpen(ws));
    ws.on('message', (raw) => { try { onMsg(JSON.parse(raw.toString())); } catch { /* non-JSON */ } });
    ws.on('error', (e) => { status = `error: ${e.message}`; clearTimeout(timer); done(); });
    ws.on('close', (code) => { if (status === 'connected') status = `closed early (code ${code})`; });
  });
}

async function probeRobinhood(): Promise<string[]> {
  let frames = 0, framesWithMessages = 0, txs = 0, swaps = 0, maxSeq: number | null = null;
  let firstShape = '';
  const routers = new Map<string, number>();
  const status = await listen(ROBINHOOD_FEED, () => {}, async (frame) => {
    frames++;
    if (!firstShape) firstShape = JSON.stringify(frame).slice(0, 300);
    if (Array.isArray(frame?.messages) && frame.messages.length) framesWithMessages++;
    const seq = maxSequenceNumber(frame);
    if (seq !== null) maxSeq = seq;
    for (const tx of parseFeedFrame(frame)) {
      txs++;
      routers.set(tx.to.toLowerCase(), (routers.get(tx.to.toLowerCase()) ?? 0) + 1);
      const swap = await decoder.decode({ chain: 'robinhood', stateType: 'SEQUENCED', blockOrSeq: 0, receivedAtMs: Date.now(), raw: { to: tx.to, data: tx.data } });
      if (swap) swaps++;
    }
  });
  const top = [...routers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([a, n]) => `${a} x${n}${registry.robinhood[a] ? ` (${registry.robinhood[a].dex})` : ''}`);
  return [
    `ROBINHOOD feed: ${status}`,
    `frames ${frames}, with messages ${framesWithMessages}, latest seq ${maxSeq}`,
    `txs parsed ${txs}, decoded as swaps ${swaps}`,
    `top contracts called: ${top.join(' | ') || 'none'}`,
    `first frame: ${firstShape}`,
  ];
}

async function probeMonad(): Promise<string[]> {
  let logs = 0, swapLogs = 0, subResult = 'no response';
  const states = new Map<string, number>();
  let sample = '';
  const status = await listen(MONAD_WSS, (ws) => {
    ws.send(JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'eth_subscribe', params: ['monadLogs', {}] }));
  }, (msg) => {
    if (msg.id === 1) { subResult = msg.result ? 'accepted' : `rejected: ${JSON.stringify(msg.error)}`; return; }
    const r = msg?.params?.result;
    if (!r) return;
    logs++;
    if (!sample) sample = JSON.stringify(r).slice(0, 300);
    states.set(String(r.commitState), (states.get(String(r.commitState)) ?? 0) + 1);
    const t0 = String(r.topics?.[0] ?? '').toLowerCase();
    if (t0 === TOPIC_V2_SWAP || t0 === TOPIC_V3_SWAP || t0 === TOPIC_PANCAKE_V3_SWAP) swapLogs++;
  });
  return [
    `MONAD (${MONAD_WSS}): ${status}, subscribe ${subResult}`,
    `logs ${logs}, Swap logs ${swapLogs}, commit states ${JSON.stringify(Object.fromEntries(states))}`,
    `sample log: ${sample}`,
  ];
}

(async () => {
  const [rh, monad] = await Promise.all([probeRobinhood(), probeMonad()]);
  const out = [...rh, '', ...monad];
  console.log(out.join('\n'));
  process.exit(0);
})();
