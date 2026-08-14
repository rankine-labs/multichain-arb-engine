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
// RECONNECTION: chainManager.ts already reconnects any adapter that
// reports unhealthy, on a centrally-coordinated 15s cycle -- that is the
// ONLY reconnect trigger. An earlier version of this file added a second,
// independent reconnect loop directly inside the close handler. That was
// a real mistake: confirmed live on the Robinhood adapter (identical
// pattern), the two competed and multiplied into a runaway loop
// (24,000+ requests, HTTP 429 rate-limiting, repeated process crashes).
// This file must NOT self-trigger a reconnect. connect() still cleans up
// any previous socket so it's safe to call again whenever chainManager does.
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

  async connect(): Promise<void> {
        // Clean up any previous connection before reconnecting -- otherwise a
      // reconnect attempt after the socket died leaks the old (dead) socket
      // and its listeners instead of replacing them.
      try { this.ws?.removeAllListeners(); this.ws?.close(); } catch { /* already dead, fine */ }

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
                                       console.error('[monad] feed error', err.message);
                                       reject(err);
                               });

                               this.ws.on('close', () => {
                                       console.warn('[monad] feed closed -- chainManager will reconnect on its next health check');
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
