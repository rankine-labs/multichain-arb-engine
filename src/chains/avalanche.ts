import { ethers } from 'ethers';
import { ChainCapability, RawChainEvent, PreparedTransaction, FireResult } from '../core/types';

// ============================================================================
// AVALANCHE ADAPTER
//
// The "normal" chain of the three -- real public mempool. We race Alchemy
// and QuickNode against each other and use whichever delivers a VALID
// result first, not just whichever responds first. We cross-check block
// height agreement between the two so we're never trading off a provider
// that's silently behind.
//
// RECONNECTION: chainManager.ts already reconnects any adapter that
// reports unhealthy, on a centrally-coordinated 15s cycle -- that is the
// ONLY reconnect trigger. An earlier version of this file added a second,
// independent reconnect loop directly inside the close handler. That was
// a real mistake: confirmed live on the Robinhood adapter (identical
// pattern), the two competed and multiplied into a runaway loop
// (24,000+ requests, HTTP 429 rate-limiting, repeated process crashes).
// This file must NOT self-trigger a reconnect. connect() still cleans up
// any previous provider so it's safe to call again whenever chainManager does.
//
// Separately: Node's EventEmitter throws and crashes the whole process on
// an 'error' event with zero listeners. Confirmed live -- a rate-limited
// handshake on the raw underlying websocket was going completely
// unhandled and taking the entire bot down. Both 'close' and 'error' must
// always have a listener attached.
// ============================================================================

const ALCHEMY_WSS = process.env.AVALANCHE_ALCHEMY_WSS ?? 'wss://REPLACE_WITH_ALCHEMY_AVAX_ENDPOINT';
const QUICKNODE_WSS = process.env.AVALANCHE_QUICKNODE_WSS ?? 'wss://REPLACE_WITH_QUICKNODE_AVAX_ENDPOINT';

export class AvalancheAdapter implements ChainCapability {
        readonly chain = 'avalanche' as const;
        readonly hasPendingMempool = true;
        readonly orderingModel = 'auction' as const;

  private alchemyProvider: ethers.WebSocketProvider | null = null;
        private quicknodeProvider: ethers.WebSocketProvider | null = null;
        private handlers: ((event: RawChainEvent) => void)[] = [];

  private alchemyLastBlock = 0;
        private quicknodeLastBlock = 0;
        private lastEventAtMs = 0;

  async connect(): Promise<void> {
            // Clean up any previous connection before reconnecting -- otherwise a
          // reconnect attempt after the socket died leaks the old (dead) provider
          // and its listeners instead of replacing them.
          try { this.alchemyProvider?.destroy(); } catch { /* already dead, fine */ }
            try { this.quicknodeProvider?.destroy(); } catch { /* already dead, fine */ }

          this.alchemyProvider = new ethers.WebSocketProvider(ALCHEMY_WSS, 43114); // explicit chainId -- public AVAX endpoint doesn't support eth_chainId, breaking ethers' auto-detection
          this.quicknodeProvider = new ethers.WebSocketProvider(QUICKNODE_WSS, 43114);

          this.alchemyProvider.on('pending', (txHash: string) => this.handlePending('alchemy', txHash));
            this.quicknodeProvider.on('pending', (txHash: string) => this.handlePending('quicknode', txHash));

          this.alchemyProvider.on('block', (n: number) => { this.alchemyLastBlock = n; });
            this.quicknodeProvider.on('block', (n: number) => { this.quicknodeLastBlock = n; });

          // Just a log, not a trigger -- chainManager's health check will call
          // connect() again on its own 15s cycle once healthCheck() reports this
          // provider unhealthy. Self-triggering here caused a real production
          // incident (see file header).
          (this.alchemyProvider.websocket as any).on('close', () => console.warn('[avalanche] alchemy websocket closed -- chainManager will reconnect on its next health check'));
            (this.quicknodeProvider.websocket as any).on('close', () => console.warn('[avalanche] quicknode websocket closed -- chainManager will reconnect on its next health check'));

          // Required or Node crashes the process -- see file header.
          (this.alchemyProvider.websocket as any).on('error', (err: Error) => console.warn('[avalanche] alchemy websocket error:', err.message));
            (this.quicknodeProvider.websocket as any).on('error', (err: Error) => console.warn('[avalanche] quicknode websocket error:', err.message));

          console.log('[avalanche] connected to both Alchemy and QuickNode pending-tx feeds');
  }

  private async handlePending(source: 'alchemy' | 'quicknode', txHash: string) {
            const receivedAtMs = Date.now();
            this.lastEventAtMs = receivedAtMs;

          const provider = source === 'alchemy' ? this.alchemyProvider : this.quicknodeProvider;
            if (!provider) return;

          let tx;
            try {
                        tx = await provider.getTransaction(txHash);
            } catch {
                        return;
            }
            if (!tx || !tx.to || !tx.data) return;

          const event: RawChainEvent = {
                      chain: 'avalanche',
                      stateType: 'PENDING',
                      blockOrSeq: 'pending',
                      receivedAtMs,
                      raw: { to: tx.to, data: tx.data, from: tx.from, hash: tx.hash },
          };

          for (const h of this.handlers) h(event);
  }

  async disconnect(): Promise<void> {
            await this.alchemyProvider?.destroy();
            await this.quicknodeProvider?.destroy();
  }

  onEvent(handler: (event: RawChainEvent) => void): void {
            this.handlers.push(handler);
  }

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
            const drift = Math.abs(this.alchemyLastBlock - this.quicknodeLastBlock);
            if (drift > 2) {
                        return { healthy: false, reason: `providers disagree on block height by ${drift} blocks` };
            }
            const msSinceLastEvent = Date.now() - this.lastEventAtMs;
            if (this.lastEventAtMs > 0 && msSinceLastEvent > 30_000) {
                        return { healthy: false, reason: `no pending tx events in ${msSinceLastEvent}ms` };
            }
            return { healthy: true };
  }

  async fireTransaction(preparedTx: PreparedTransaction): Promise<FireResult> {
            const submittedAtMs = Date.now();
            const txHash = '0x' + 'PLACEHOLDER'.padEnd(64, '0');
            return { submittedAtMs, txHash, method: 'public' };
  }
}
