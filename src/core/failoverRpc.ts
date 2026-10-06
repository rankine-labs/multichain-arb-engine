import { ethers } from 'ethers';
import { isRateLimited } from '../execution/simulator';
import { endpointLabel } from './endpointLabel';

// ============================================================================
// FAST / HEAVY RPC SPLIT WITH FAILOVER
//
// Plain English:
//   Two places to ask the chain questions:
//     FAST  = Robinhood's own free node. ~8 ms from the server, but it says
//             "slow down" (rate limit) when hit with bursts.
//     HEAVY = Alchemy (ROBINHOOD_RPC_HTTP). ~24 ms, but doesn't throttle us.
//   Prices, blocks and pool lookups (constant, light, time-sensitive) use
//   FAST. Simulations and the chain-wide scan (bursty) use HEAVY.
//
//   If FAST rate-limits, times out or can't be reached, the request is
//   retried on HEAVY straight away and FAST is rested for 5 minutes (all
//   reads go to HEAVY). Then FAST is tried again. One log line per switch,
//   never per request.
//
//   Errors about the call itself (a reverted call, bad parameters) are real
//   answers, not a sick endpoint: they never trigger a switch.
//
//   Oct 2026 additions:
//   - SLOW counts as sick: if a FAST node's typical answer time (smoothed
//     over recent single requests) goes above slowMs (default 300 ms), it's
//     rested too. Before, a throttled node answering in ~1 s was never
//     switched away from, because it never actually errored.
//   - Several FAST nodes: requests rotate between them (spreads our load so
//     no single free node throttles us); a sick one is rested on its own and
//     the others carry on. HEAVY is used only when every FAST node is resting.
//     Extra nodes come from ROBINHOOD_FAST_RPC_EXTRA (comma-separated).
//   - BACKUP nodes (ROBINHOOD_BACKUP_RPC, e.g. Nodeflare): used only when
//     every FAST node is resting, before HEAVY. Keeps HEAVY's quota for
//     simulations; a backup is rested on the same rules (errors / slow).
// ============================================================================

export type RpcSend = (payload: ethers.JsonRpcPayload | ethers.JsonRpcPayload[]) => Promise<Array<ethers.JsonRpcResult | ethers.JsonRpcError>>;

export interface FailoverStats {
  onFast: boolean;          // true = currently reading from FAST
  switches: number;         // times FAST was rested since start
  lastReason?: string;
}

// Is this thrown error a sick-endpoint problem (worth switching for)?
export function isEndpointTrouble(err: unknown): boolean {
  const e = err as { code?: string | number; message?: string; shortMessage?: string; info?: any; error?: any };
  const msg = `${e?.shortMessage ?? ''} ${e?.message ?? ''}`.toLowerCase();
  // ethers wraps HTTP failures as SERVER_ERROR / TIMEOUT; plain fetch errors
  // (DNS, connection refused/reset) arrive as TypeError / NETWORK_ERROR.
  if (e?.code === 'TIMEOUT' || e?.code === 'NETWORK_ERROR' || e?.code === 'SERVER_ERROR') return true;
  if (isRateLimited({ code: typeof e?.code === 'number' ? e.code : undefined, message: msg })) return true;
  return /timeout|timed out|econnreset|econnrefused|enotfound|socket hang up|fetch failed|bad response|429|502|503|504/.test(msg);
}

// Short, safe reason for the log line. Never the raw error: ethers puts the
// request URL in its messages, and a URL can contain an API key.
export function shortReason(err: unknown): string {
  const e = err as { code?: string | number; message?: string };
  const m = String(e?.message ?? err).toLowerCase();
  if (m.includes('maximum retry') || m.includes('429') || m.includes('too many') || m.includes('rate limit')) return 'rate limited';
  if (e?.code === 'TIMEOUT' || m.includes('timeout') || m.includes('timed out')) return 'timed out';
  if (/econnreset|econnrefused|enotfound|socket hang up|fetch failed/.test(m)) return 'could not connect';
  if (/50[234]/.test(m)) return 'server error';
  return 'endpoint error';
}

// Did the endpoint answer, but with "slow down" inside the JSON-RPC reply?
function resultsRateLimited(results: Array<ethers.JsonRpcResult | ethers.JsonRpcError>): string | null {
  for (const r of results) {
    const err = (r as ethers.JsonRpcError).error;
    if (err && isRateLimited({ code: err.code, message: err.message })) return err.message ?? `code ${err.code}`;
  }
  return null;
}

// The routing logic on its own (no network), so it can be tested with fakes.
type Endpoint = { label: string; send: RpcSend };
type FastState = Endpoint & { restUntil: number; avgMs: number | null; samples: number; backup?: boolean };

export class FailoverRouter {
  private readonly fasts: FastState[];
  private next = 0;
  private stats: FailoverStats = { onFast: true, switches: 0 };

  constructor(
    fast: Endpoint | Endpoint[],
    private readonly heavy: Endpoint | null, // null = no paid node: FAST only
    private readonly opts: { restMs?: number; slowMs?: number; now?: () => number; log?: (line: string) => void; backups?: Endpoint[] } = {},
  ) {
    this.fasts = [
      ...(Array.isArray(fast) ? fast : [fast]).map((f) => ({ ...f, restUntil: 0, avgMs: null, samples: 0 })),
      ...(opts.backups ?? []).map((f) => ({ ...f, restUntil: 0, avgMs: null, samples: 0, backup: true })),
    ];
  }

  private now() { return (this.opts.now ?? Date.now)(); }
  private log(line: string) { (this.opts.log ?? console.log)(line); }
  private get restMs() { return this.opts.restMs ?? 5 * 60_000; }
  private get slowMs() { return this.opts.slowMs ?? Number(process.env.RPC_SLOW_MS ?? 300); }

  getStats(): FailoverStats { return { ...this.stats, onFast: this.onFast() }; }

  // FAST nodes not resting right now. Without a HEAVY node, all of them
  // (nothing to fall back to, so resting would only stop reads).
  // Main FAST nodes first; BACKUP nodes only when every main one is resting.
  private available(): FastState[] {
    const t = this.now();
    const main = this.fasts.filter((f) => !f.backup);
    if (!this.heavy && !this.fasts.some((f) => f.backup)) return main;
    const up = main.filter((f) => t >= f.restUntil);
    if (up.length) return up;
    return this.fasts.filter((f) => f.backup && t >= f.restUntil);
  }

  // Are we reading from FAST right now? (Logs the switch back once.)
  private onFast(): boolean {
    const ok = this.available().length > 0;
    if (ok && !this.stats.onFast) {
      this.stats.onFast = true;
      this.log(`[rpc] fast path back on ${this.available().map((f) => f.label).join(' + ')}`);
    }
    return ok;
  }

  private rest(f: FastState, reason: string) {
    if (!this.heavy && !this.fasts.some((x) => x !== f && (x.backup || !f.backup))) return; // nothing to fall back to
    f.restUntil = this.now() + this.restMs;
    f.avgMs = null; f.samples = 0; // fresh measurement when it comes back
    const stillUp = this.available();
    this.stats.lastReason = reason.slice(0, 120);
    if (stillUp.length) {
      this.log(`[rpc] ${f.label} rested ${Math.round(this.restMs / 60_000)} min (${this.stats.lastReason}); reads on ${stillUp.map((x) => x.label).join(' + ')}`);
    } else if (this.stats.onFast && this.heavy) {
      this.stats.onFast = false;
      this.stats.switches++;
      this.log(`[rpc] fast path -> ${this.heavy.label} for ${Math.round(this.restMs / 60_000)} min (${this.stats.lastReason})`);
    }
  }

  // Smoothed answer time of single requests; too slow = rest the node.
  private noteTime(f: FastState, ms: number) {
    f.avgMs = f.avgMs === null ? ms : f.avgMs * 0.8 + ms * 0.2;
    f.samples++;
    if (f.samples >= 10 && f.avgMs > this.slowMs) this.rest(f, `slow, ~${Math.round(f.avgMs)} ms per answer`);
  }

  async send(payload: ethers.JsonRpcPayload | ethers.JsonRpcPayload[]): Promise<Array<ethers.JsonRpcResult | ethers.JsonRpcError>> {
    // Try each available FAST node at most once, starting with the next in turn.
    const tried = new Set<FastState>();
    while (this.onFast()) {
      const avail = this.available().filter((f) => !tried.has(f));
      if (!avail.length) break;
      const f = avail[this.next++ % avail.length];
      tried.add(f);
      const t0 = this.now();
      let results: Array<ethers.JsonRpcResult | ethers.JsonRpcError>;
      try {
        results = await f.send(payload);
      } catch (err) {
        // No paid node to fall back to, or a non-endpoint error: pass it on.
        if ((!this.heavy && !this.available().some((x) => x !== f)) || !isEndpointTrouble(err)) throw err;
        this.rest(f, shortReason(err));
        continue;
      }
      if (this.heavy && resultsRateLimited(results)) { this.rest(f, 'rate limited'); continue; }
      if (!Array.isArray(payload)) this.noteTime(f, this.now() - t0);
      return results;
    }
    if (!this.heavy) throw new Error('no RPC node available');
    return this.heavy.send(payload);
  }
}

// FAST requests: short timeout and NO built-in retries. ethers normally
// retries a 429 with growing waits (seconds); we'd rather switch to HEAVY
// immediately than sit and wait.
function fastRequest(url: string, timeoutMs: number): ethers.FetchRequest {
  const req = new ethers.FetchRequest(url);
  req.timeout = timeoutMs;
  req.setThrottleParams({ maxAttempts: 1 });
  return req;
}

// A normal ethers provider (drop-in for JsonRpcProvider) that routes every
// request through FailoverRouter.
export class FailoverJsonRpcProvider extends ethers.JsonRpcProvider {
  readonly router: FailoverRouter;
  private readonly heavyProvider: ethers.JsonRpcProvider | null;

  private readonly extraFast: ethers.JsonRpcProvider[];

  // extraFastUrls: more FAST nodes to rotate reads across (e.g. a keyed
  // QuickNode / Nodeflare endpoint), from ROBINHOOD_FAST_RPC_EXTRA.
  private readonly backupProviders: ethers.JsonRpcProvider[];

  constructor(fastUrl: string, heavyUrl: string | null, chainId: number, opts: { restMs?: number; fastTimeoutMs?: number; slowMs?: number; extraFastUrls?: string[]; backupUrls?: string[] } = {}) {
    super(fastRequest(fastUrl, opts.fastTimeoutMs ?? 5_000), chainId, { staticNetwork: true });
    this.heavyProvider = heavyUrl && heavyUrl !== fastUrl ? new ethers.JsonRpcProvider(heavyUrl, chainId, { staticNetwork: true }) : null;
    const heavyProvider = this.heavyProvider;
    const extras = (opts.extraFastUrls ?? []).filter((u) => u && u !== fastUrl && u !== heavyUrl);
    this.extraFast = extras.map((u) => new ethers.JsonRpcProvider(fastRequest(u, opts.fastTimeoutMs ?? 5_000), chainId, { staticNetwork: true }));
    const backups = (opts.backupUrls ?? []).filter((u) => u && u !== fastUrl && u !== heavyUrl && !extras.includes(u));
    this.backupProviders = backups.map((u) => new ethers.JsonRpcProvider(fastRequest(u, opts.fastTimeoutMs ?? 5_000), chainId, { staticNetwork: true }));
    this.router = new FailoverRouter(
      [
        { label: endpointLabel(fastUrl), send: (p) => super._send(p) },
        ...this.extraFast.map((prov, i) => ({ label: endpointLabel(extras[i]), send: (p: ethers.JsonRpcPayload | ethers.JsonRpcPayload[]) => prov._send(p) })),
      ],
      heavyProvider ? { label: endpointLabel(heavyUrl!), send: (p) => heavyProvider._send(p) } : null,
      {
        restMs: opts.restMs, slowMs: opts.slowMs,
        backups: this.backupProviders.map((prov, i) => ({ label: endpointLabel(backups[i]) + ' (backup)', send: (p: ethers.JsonRpcPayload | ethers.JsonRpcPayload[]) => prov._send(p) })),
      },
    );
  }

  override async _send(payload: ethers.JsonRpcPayload | ethers.JsonRpcPayload[]): Promise<Array<ethers.JsonRpcResult>> {
    return this.router.send(payload) as Promise<Array<ethers.JsonRpcResult>>;
  }

  override destroy() { this.heavyProvider?.destroy(); for (const p of [...this.extraFast, ...this.backupProviders]) p.destroy(); super.destroy(); }
}
