import WebSocket from 'ws';
import {
  ChainCapability, RawChainEvent, PreparedTransaction, FireResult,
  } from '../core/types';

// ============================================================================
// ROBINHOOD CHAIN ADAPTER
//
// Arbitrum Orbit / Nitro chain. There is NO public mempool to peek into —
// the sequencer decides ordering privately and broadcasts the decision the
// instant it's made, before the trade has actually finished processing.
//
// Confirmed feed: wss://feed.mainnet.chain.robinhood.com
// Ordering model: strictly first-come-first-served. Priority fee does
// NOTHING here — our entire edge is submission latency, not gas bidding.
// Risk: single sequencer, no redundancy — needs a liveness check.
// ============================================================================

const SEQUENCER_FEED_URL = 'wss://feed.mainnet.chain.robinhood.com';
const RPC_HTTP_URL = process.env.ROBINHOOD_RPC_HTTP ?? 'https://rpc.mainnet.chain.robinhood.com';

export class RobinhoodChainAdapter implements ChainCapability {
readonly chain = 'robinhood' as const;
readonly hasPendingMempool = false;
readonly orderingModel = 'none' as const;

private ws: WebSocket | null = null;
private handlers: ((event: RawChainEvent) => void)[] = [];
private lastSeqSeen = 0;
private lastMessageAtMs = 0;

async connect(): Promise<void> {
return new Promise((resolve, reject) => {
this.ws = new WebSocket(SEQUENCER_FEED_URL);

this.ws.on('open', () => {
console.log('[robinhood] sequencer feed connected');
resolve();
});

this.ws.on('message', (raw: WebSocket.RawData) => {
const receivedAtMs = Date.now();
this.lastMessageAtMs = receivedAtMs;

let parsed: any;
try {
parsed = JSON.parse(raw.toString());
} catch {
return; // malformed frame, drop it
}

const seq = parsed.seq ?? parsed.sequenceNumber;
if (typeof seq === 'number') this.lastSeqSeen = seq;

const event: RawChainEvent = {
chain: 'robinhood',
stateType: 'SEQUENCED',
blockOrSeq: seq ?? 'unknown',
receivedAtMs,
raw: parsed,
};

for (const h of this.handlers) h(event);
});

this.ws.on('error', (err) => {
console.error('[robinhood] feed error', err);
reject(err);
});

this.ws.on('close', () => {
console.warn('[robinhood] feed closed — will need reconnect logic in production');
});
});
}

async disconnect(): Promise<void> {
this.ws?.close();
this.ws = null;
}

onEvent(handler: (event: RawChainEvent) => void): void {
this.handlers.push(handler);
}

async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
const msSinceLastMessage = Date.now() - this.lastMessageAtMs;
const wsOpen = this.ws?.readyState === WebSocket.OPEN;

if (!wsOpen) {
return { healthy: false, reason: 'sequencer feed websocket is not open' };
}
if (this.lastMessageAtMs > 0 && msSinceLastMessage > 30_000) {
return { healthy: false, reason: `no sequencer messages in ${msSinceLastMessage}ms` };
}
return { healthy: true };
}

async fireTransaction(preparedTx: PreparedTransaction): Promise<FireResult> {
const submittedAtMs = Date.now();

const txHash = '0x' + 'PLACEHOLDER'.padEnd(64, '0');

return {
submittedAtMs,
txHash,
method: 'sequencer-direct',
};
}
}
