import { ChainCapability, RawChainEvent, ChainName } from './types';

// ============================================================================
// CHAIN MANAGER
// The supervisor. Knows which chains are active, healthy, and safe to trade.
// One chain having a bad day (RPC outage, sequencer down, provider drift)
// never stops the others.
// ============================================================================

export class ChainManager {
private adapters = new Map<ChainName, ChainCapability>();
private status = new Map<ChainName, { online: boolean; reason?: string }>();
private globalEventHandlers: ((event: RawChainEvent) => void)[] = [];

register(adapter: ChainCapability) {
this.adapters.set(adapter.chain, adapter);
adapter.onEvent((event) => {
for (const h of this.globalEventHandlers) h(event);
});
}

onEvent(handler: (event: RawChainEvent) => void) {
this.globalEventHandlers.push(handler);
}

async startAll() {
const results = await Promise.allSettled(
[...this.adapters.values()].map(async (a) => {
await a.connect();
this.status.set(a.chain, { online: true });
}),
);

results.forEach((r, i) => {
const chain = [...this.adapters.keys()][i];
if (r.status === 'rejected') {
this.status.set(chain, { online: false, reason: String(r.reason) });
console.error(`[chainManager] ${chain} failed to start:`, r.reason);
                               }
  });
}

async runHealthChecks() {
for (const [chain, adapter] of this.adapters) {
const result = await adapter.healthCheck();
this.status.set(chain, { online: result.healthy, reason: result.reason });
if (!result.healthy) {
console.warn(`[chainManager] ${chain} UNHEALTHY: ${result.reason}`);
    try {
        console.warn(`[chainManager] attempting to reconnect ${chain}...`);
        await adapter.connect();
        this.status.set(chain, { online: true });
        console.warn(`[chainManager] ${chain} reconnected successfully`);
    } catch (err) {
        console.error(`[chainManager] ${chain} reconnect failed:`, err);
    }
                              }
}
}

getStatus() {
return Object.fromEntries(this.status.entries());
}

getAdapter(chain: ChainName): ChainCapability | undefined {
return this.adapters.get(chain);
}

isHealthy(chain: ChainName): boolean {
return this.status.get(chain)?.online ?? false;
}
}
