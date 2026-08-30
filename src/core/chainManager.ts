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
    // Chains that keep failing health checks (a persistently rate-limited
    // RPC, for example) used to get a reconnect attempt every single check
    // -- 15 seconds, forever, hammering an already-overloaded endpoint.
    // Tracks a per-chain failure count and the next allowed retry time so
    // repeated failures back off (15s, 30s, 60s...) instead of retrying
    // at a fixed 15s no matter how many times it has already failed.
    private reconnectBackoff = new Map<ChainName, { failCount: number; nextRetryAt: number }>();

      // A chain that keeps briefly reconnecting and dropping again (a flapping
      // websocket, not a clean outage) would reset the backoff above to zero
      // on every single brief success, so it could never actually escalate.
      // Tracks when a chain most recently became healthy so the backoff only
      // clears once it has genuinely stayed healthy for a sustained stretch,
      // not just for one health-check tick.
      private stableSince = new Map<ChainName, number>();
      private static readonly STABLE_THRESHOLD_MS = 2 * 60_000;

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
      this.stableSince.delete(chain);
    const backoff = this.reconnectBackoff.get(chain);
    const now = Date.now();
    if (backoff && now < backoff.nextRetryAt) {
        continue;
    }
    try {
        console.warn(`[chainManager] attempting to reconnect ${chain}...`);
        await adapter.connect();
        this.status.set(chain, { online: true });
        if (!this.stableSince.has(chain)) this.stableSince.set(chain, now);
        console.warn(`[chainManager] ${chain} reconnected successfully`);
    } catch (err) {
        const failCount = (backoff?.failCount ?? 0) + 1;
        const delayMs = Math.min(15_000 * 2 ** failCount, 5 * 60_000);
        this.reconnectBackoff.set(chain, { failCount, nextRetryAt: now + delayMs });
        console.error(`[chainManager] ${chain} reconnect failed, backing off ${Math.round(delayMs / 1000)}s:`, err);
    }
} else {
const now = Date.now();
      if (!this.stableSince.has(chain)) this.stableSince.set(chain, now);
      const stableFor = now - (this.stableSince.get(chain) ?? now);
      if (stableFor >= ChainManager.STABLE_THRESHOLD_MS) {
            this.reconnectBackoff.delete(chain);
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
