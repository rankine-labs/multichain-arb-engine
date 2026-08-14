import WebSocket from 'ws';
import {
  ChainCapability, RawChainEvent, PreparedTransaction, FireResult,
} from '../core/types';

// ============================================================================
// MONAD ADAPTER
//
// No newPendingTransactions support -- explicitly unsupported on Monad, do
// NOT build logic that assumes a normal mempool exists here.
//
// Instead: monadNewHeads / monadLogs, Monad-specific extensions to
// eth_subscribe that publish ~1 second before finalization, on a
// SPECULATIVE basis. Confirmed working via QuickNode on mainnet.
// Alchemy currently documents Monad as testnet-only -- do NOT wire Alchemy
// in as a second racing provider here until that's independently verified
// against Monad mainnet.
//
// Because this is speculative, every pre-armed trade needs a fast
// resimulate-or-abandon check immediately before firing.
//
// RECONNECTION: the close handler used to just log a TODO comment and do
// nothing -- confirmed live, this let the feed go silent indefinitely
// after the socket dropped during a long-running session. Now retries
// with backoff instead of just noting the problem.
// ============================================================================

const QUICKNODE_WS_URL = process.env.MONAD_QUICKNODE_WSS ?? 'wss://REPLACE_WITH_QUICKNODE_MONAD_ENDPOINT';

export class MonadAdapter implements ChainCapability {
    readonly chain = 'monad' as const;
    readonly hasPendingMempool = false;
    readonly orderingModel = 'auction' as const; // still gas-priced, just not via a public mempool

  private ws: WebSocket | null = null;
    private handlers: ((event: RawChainEvent) => void)[] = [];
    private subId: string | null = null;
    private lastMessageAtMs = 0;
    private reorderedCount = 0; // tracked per Phase 1 requirement: measure how often speculative state flips

  private reconnecting = false;
    private reconnectDelayMs = 2000;

  async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
                this.ws = new WebSocket(QUICKNODE_WS_URL);

                                 this.ws.on('open', () => {
                                         this.ws!.send(JSON.stringify({
                                                 id: 1,
                                                 jsonrpc: '2.0',
                                                 method: 'eth_subscribe',
                                                 params: ['monadLogs', {}],
                                         }));
                                         console.log('[monad] connected, subscribing to monadLogs');
                                         this.reconnectDelayMs = 2000; // reset backoff on a real successful connection
                                                  resolve();
                                 });

                                 this.ws.on('message', (raw: WebSocket.RawData) => {
                                         const receivedAtMs = Date.now();
                                         this.lastMessageAtMs = receivedAtMs;

                                                  let parsed: any;
                                         try {
                                                 parsed = JSON.parse(raw.toString());
                                         } catch {
                                                 return;
                                         }

                                                  if (parsed.id === 1 && parsed.result) {
                                                          this.subId = parsed.result;
                                                          return;
                                                  }

                                                  if (parsed.method !== 'eth_subscription') return;

                                                  const params = parsed.params?.result;
                                         if (!params) return;

                                                  const stateType = params.commitState === 'Finalized' ? 'FINALIZED' : 'SPECULATIVE';

                                                  const event: RawChainEvent = {
                                                          chain: 'monad',
                                                          stateType,
                                                          blockOrSeq: params.blockId ?? params.blockNumber ?? 'unknown',
                                                          receivedAtMs,
                                                          raw: params,
                                                  };

                                                  for (const h of this.handlers) h(event);
                                 });

                                 this.ws.on('error', (err) => {
                                         console.error('[monad] feed error', err);
                                         reject(err);
                                 });

                                 this.ws.on('close', () => {
                                         console.warn(`[monad] feed closed, reconnecting in ${this.reconnectDelayMs}ms`);
                                         this.scheduleReconnect();
                                 });
        });
  }

  private scheduleReconnect(): void {
        if (this.reconnecting) return;
        this.reconnecting = true;
        this.ws = null;
        setTimeout(() => {
              this.connect()
              .then(() => { this.reconnecting = false; })
              .catch((err) => {
                    console.error('[monad] reconnect failed:', err.message);
                    this.reconnecting = false;
                    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000); // back off, cap at 30s
                         this.scheduleReconnect();
              });
        }, this.reconnectDelayMs);
  }

  async disconnect(): Promise<void> {
        this.ws?.close();
        this.ws = null;
  }

  onEvent(handler: (event: RawChainEvent) => void): void {
        this.handlers.push(handler);
  }

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
        const wsOpen = this.ws?.readyState === WebSocket.OPEN;
        if (!wsOpen) return { healthy: false, reason: 'monadLogs websocket is not open' };
        const msSinceLastMessage = Date.now() - this.lastMessageAtMs;
        if (this.lastMessageAtMs > 0 && msSinceLastMessage > 30_000) {
              return { healthy: false, reason: `no monad log messages in ${msSinceLastMessage}ms` };
        }
        return { healthy: true };
  }

  recordReorder() {
        this.reorderedCount++;
  }

  getReorderedCount() {
        return this.reorderedCount;
  }

  async fireTransaction(preparedTx: PreparedTransaction): Promise<FireResult> {
        const submittedAtMs = Date.now();
        const txHash = '0x' + 'PLACEHOLDER'.padEnd(64, '0');
        return { submittedAtMs, txHash, method: 'public' };
  }
}
