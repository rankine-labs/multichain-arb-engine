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
  // repeated failures back off (30s, 60s, 120s... capped at 5 min) instead
  // of retrying at a fixed 15s no matter how many times it has failed.
  private reconnectBackoff = new Map<ChainName, { failCount: number; nextRetryAt: number }>();

  // When each chain most recently became healthy (after start or a
  // reconnect). Used two ways:
  //   - backoff only clears once a chain has STAYED healthy for a sustained
  //     stretch, not after one good health-check tick;
  //   - a chain that goes unhealthy again BEFORE that stretch is up has
  //     "flapped", and the flap counts as a failure so backoff escalates.
  //     Before this, a socket that opened fine and died 10s later counted
  //     as a success every time, so a flapping feed reconnected every 15s
  //     forever and the backoff never kicked in.
  private stableSince = new Map<ChainName, number>();
  static readonly STABLE_THRESHOLD_MS = 2 * 60_000;

  // shadowMain calls runHealthChecks() from a setInterval. If one cycle is
  // slow (a reconnect waiting on a dead endpoint), the next tick would start
  // a second, overlapping cycle and fire a second reconnect at the same
  // chain -- the same competing-reconnect pattern that once caused the
  // Robinhood runaway loop. Only one cycle is allowed to run at a time.
  private checkInProgress = false;

  // `now` is injectable so tests can control time; production uses Date.now.
  constructor(private readonly now: () => number = Date.now) {}

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
    const chains = [...this.adapters.keys()];
    const results = await Promise.allSettled(
      [...this.adapters.values()].map(async (a) => {
        await a.connect();
        this.status.set(a.chain, { online: true });
        this.stableSince.set(a.chain, this.now());
      }),
    );

    results.forEach((r, i) => {
      const chain = chains[i];
      if (r.status === 'rejected') {
        this.status.set(chain, { online: false, reason: String(r.reason) });
        // Start a backoff right away: without it the first health check
        // (15s later) retries immediately, which is how restart storms turn
        // into provider blocks.
        const delayMs = this.retryDelayMs(1, r.reason);
        this.reconnectBackoff.set(chain, { failCount: 1, nextRetryAt: this.now() + delayMs });
        console.error(`[chainManager] ${chain} failed to start (retry in ${Math.round(delayMs / 1000)}s):`, r.reason);
      }
    });
  }

  // Backoff delay for a given number of consecutive failures.
  static backoffMs(failCount: number): number {
    return Math.min(15_000 * 2 ** failCount, 5 * 60_000);
  }

  // Extra wait when the provider itself told us to go away. Retrying during
  // a provider block keeps the block alive: Robinhood's feed answers 403
  // "Blocked for 1 hour after sustained feed connection rejections", and a
  // retry every 5 min means it never lifts. 429 = rate limited.
  static penaltyMs(err: unknown): number {
    const m = String((err as any)?.message ?? err);
    if (/\b403\b|blocked/i.test(m)) return 65 * 60_000; // sit the whole hour out
    if (/\b429\b|too many/i.test(m)) return 10 * 60_000;
    return 0;
  }

  private retryDelayMs(failCount: number, err: unknown): number {
    return Math.max(ChainManager.backoffMs(failCount), ChainManager.penaltyMs(err));
  }

  async runHealthChecks() {
    if (this.checkInProgress) return; // previous cycle still running -- skip this tick
    this.checkInProgress = true;
    try {
      for (const [chain, adapter] of this.adapters) {
        await this.checkChain(chain, adapter);
      }
    } finally {
      this.checkInProgress = false;
    }
  }

  private async checkChain(chain: ChainName, adapter: ChainCapability) {
    const now = this.now();

    let result: { healthy: boolean; reason?: string };
    try {
      result = await adapter.healthCheck();
    } catch (err) {
      // A health check that throws is unhealthy, not a crash.
      result = { healthy: false, reason: `healthCheck threw: ${String(err)}` };
    }

    // --- Healthy ------------------------------------------------------------
    if (result.healthy) {
      this.status.set(chain, { online: true });
      if (!this.stableSince.has(chain)) this.stableSince.set(chain, now);
      const stableFor = now - (this.stableSince.get(chain) ?? now);
      if (stableFor >= ChainManager.STABLE_THRESHOLD_MS && this.reconnectBackoff.has(chain)) {
        this.reconnectBackoff.delete(chain);
        console.log(`[chainManager] ${chain} stable for ${Math.round(stableFor / 1000)}s -- backoff cleared`);
      }
      return;
    }

    // --- Unhealthy ----------------------------------------------------------
    this.status.set(chain, { online: false, reason: result.reason });
    console.warn(`[chainManager] ${chain} UNHEALTHY: ${result.reason}`);

    // Did it just flap (healthy, then died before the stable threshold)?
    // If so that counts as a failure, exactly like a failed reconnect.
    const healthySince = this.stableSince.get(chain);
    this.stableSince.delete(chain);
    if (healthySince !== undefined) {
      const livedMs = now - healthySince;
      if (livedMs < ChainManager.STABLE_THRESHOLD_MS) {
        const failCount = (this.reconnectBackoff.get(chain)?.failCount ?? 0) + 1;
        const delayMs = ChainManager.backoffMs(failCount);
        this.reconnectBackoff.set(chain, { failCount, nextRetryAt: now + delayMs });
        console.warn(
          `[chainManager] ${chain} flapped (healthy only ${Math.round(livedMs / 1000)}s, ` +
          `${failCount} in a row) -- backing off ${Math.round(delayMs / 1000)}s`,
        );
      }
    }

    // Still inside a backoff window? Leave it alone this tick.
    const backoff = this.reconnectBackoff.get(chain);
    if (backoff && now < backoff.nextRetryAt) return;

    try {
      console.warn(`[chainManager] attempting to reconnect ${chain}...`);
      await adapter.connect();
      this.status.set(chain, { online: true });
      // Start the stability clock from the reconnect. If it dies again
      // before STABLE_THRESHOLD_MS, the flap check above escalates backoff.
      this.stableSince.set(chain, this.now());
      console.warn(`[chainManager] ${chain} reconnected successfully`);
    } catch (err) {
      const failCount = (backoff?.failCount ?? 0) + 1;
      const delayMs = this.retryDelayMs(failCount, err);
      this.reconnectBackoff.set(chain, { failCount, nextRetryAt: this.now() + delayMs });
      console.error(`[chainManager] ${chain} reconnect failed, backing off ${Math.round(delayMs / 1000)}s:`, err);
    }
  }

  getStatus() {
    return Object.fromEntries(this.status.entries());
  }

  // Exposed for tests and reporting: current failure streak per chain.
  getBackoff(chain: ChainName) {
    return this.reconnectBackoff.get(chain);
  }

  getAdapter(chain: ChainName): ChainCapability | undefined {
    return this.adapters.get(chain);
  }

  isHealthy(chain: ChainName): boolean {
    return this.status.get(chain)?.online ?? false;
  }
}
