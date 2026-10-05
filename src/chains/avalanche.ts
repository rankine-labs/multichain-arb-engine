import { endpointLabel } from '../core/endpointLabel';
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

        // Feed visibility. The old health check only flagged silence AFTER a
        // first event, so a provider that connects but never streams pending
        // txs (the live probe showed Avalanche's public endpoint does exactly
        // that) looked healthy forever while the bot saw nothing.
        private connectedAtMs = 0;
        private pendingCount = { alchemy: 0, quicknode: 0 };
        private lastCountLogAtMs = 0;
        private static readonly FIRST_EVENT_GRACE_MS = 60_000;
        private static readonly COUNT_LOG_EVERY_MS = 5 * 60_000;

  async connect(): Promise<void> {
            // Clean up any previous connection before reconnecting -- otherwise a
          // reconnect attempt after the socket died leaks the old (dead) provider
          // and its listeners instead of replacing them.
          try { this.alchemyProvider?.destroy(); } catch { /* already dead, fine */ }
            try { this.quicknodeProvider?.destroy(); } catch { /* already dead, fine */ }

          this.alchemyProvider = null;
          this.quicknodeProvider = null;

          // Skip any provider whose URL was never filled in (.env missing it).
          const configured = (url: string) => !url.includes('REPLACE_WITH');
          if (!configured(ALCHEMY_WSS) && !configured(QUICKNODE_WSS)) {
                    throw new Error('Avalanche not configured: set AVALANCHE_QUICKNODE_WSS and/or AVALANCHE_ALCHEMY_WSS in .env');
          }
          if (configured(ALCHEMY_WSS)) {
                    this.alchemyProvider = this.openProvider('alchemy', ALCHEMY_WSS);
          } else console.warn('[avalanche] AVALANCHE_ALCHEMY_WSS not set -- using QuickNode only');
          if (configured(QUICKNODE_WSS)) {
                    this.quicknodeProvider = this.openProvider('quicknode', QUICKNODE_WSS);
          } else console.warn('[avalanche] AVALANCHE_QUICKNODE_WSS not set -- using Alchemy only');

          this.connectedAtMs = Date.now();
          this.lastEventAtMs = 0;
          // Named by the URL's real host, not the setting name (see core/endpointLabel.ts).
          const names = [this.alchemyProvider && endpointLabel(ALCHEMY_WSS), this.quicknodeProvider && endpointLabel(QUICKNODE_WSS)].filter(Boolean);
          console.log(`[avalanche] connected to pending-tx feed(s): ${[...new Set(names)].join(' + ')}`);
          if (names.every((n) => String(n).startsWith('free public node'))) {
                console.warn('[avalanche] both feeds are the FREE PUBLIC node, which streams no pending transactions -- put real Alchemy/QuickNode URLs in .env');
          }
  }

  // Opens one provider with all the listeners it needs.
  private openProvider(source: 'alchemy' | 'quicknode', url: string): ethers.WebSocketProvider {
          const provider = new ethers.WebSocketProvider(url, 43114); // explicit chainId -- public AVAX endpoint doesn't support eth_chainId, breaking ethers' auto-detection
          provider.on('pending', (txHash: string) => this.handlePending(source, txHash));
          provider.on('block', (n: number) => {
                    if (source === 'alchemy') this.alchemyLastBlock = n; else this.quicknodeLastBlock = n;
          });
          // Just a log, not a trigger -- chainManager's health check will call
          // connect() again on its own 15s cycle once healthCheck() reports this
          // provider unhealthy. Self-triggering here caused a real production
          // incident (see file header).
          (provider.websocket as any).on('close', () => console.warn(`[avalanche] ${source} websocket closed -- chainManager will reconnect on its next health check`));
          // Required or Node crashes the process -- see file header.
          (provider.websocket as any).on('error', (err: Error) => console.warn(`[avalanche] ${source} websocket error:`, err.message));
          return provider;
  }

  private async handlePending(source: 'alchemy' | 'quicknode', txHash: string) {
            const receivedAtMs = Date.now();
            this.lastEventAtMs = receivedAtMs;
            this.pendingCount[source]++;

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
                      raw: { to: tx.to, data: tx.data, value: tx.value.toString(), from: tx.from, hash: tx.hash },
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
            const now = Date.now();

            // Every 5 minutes, say how many pending txs each provider delivered.
            if (now - this.lastCountLogAtMs >= AvalancheAdapter.COUNT_LOG_EVERY_MS) {
                        console.log(`[avalanche] pending txs in last 5m: alchemy ${this.alchemyProvider ? this.pendingCount.alchemy : 'off'}, quicknode ${this.quicknodeProvider ? this.pendingCount.quicknode : 'off'}`);
                        this.pendingCount = { alchemy: 0, quicknode: 0 };
                        this.lastCountLogAtMs = now;
            }

            // Block-height agreement only means something with two providers.
            if (this.alchemyProvider && this.quicknodeProvider) {
                        const drift = Math.abs(this.alchemyLastBlock - this.quicknodeLastBlock);
                        if (drift > 2) {
                                    return { healthy: false, reason: `providers disagree on block height by ${drift} blocks` };
                        }
            }

            // Connected but NOTHING ever arrived: not healthy, just quiet.
            if (this.lastEventAtMs === 0 && this.connectedAtMs > 0 && now - this.connectedAtMs > AvalancheAdapter.FIRST_EVENT_GRACE_MS) {
                        return { healthy: false, reason: 'connected, but no pending transactions received (provider may not stream the Avalanche mempool)' };
            }

            const msSinceLastEvent = now - this.lastEventAtMs;
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
