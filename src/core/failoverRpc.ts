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
export class FailoverRouter {
  private restUntil = 0;
  private stats: FailoverStats = { onFast: true, switches: 0 };

  constructor(
    private readonly fast: { label: string; send: RpcSend },
    private readonly heavy: { label: string; send: RpcSend } | null, // null = no paid node: FAST only
    private readonly opts: { restMs?: number; now?: () => number; log?: (line: string) => void } = {},
  ) {}

  private now() { return (this.opts.now ?? Date.now)(); }
  private log(line: string) { (this.opts.log ?? console.log)(line); }
  private get restMs() { return this.opts.restMs ?? 5 * 60_000; }

  getStats(): FailoverStats { return { ...this.stats, onFast: this.onFast() }; }

  // Are we reading from FAST right now? (Logs the switch back once.)
  private onFast(): boolean {
    if (!this.heavy) return true;
    if (this.now() < this.restUntil) return false;
    if (!this.stats.onFast) {
      this.stats.onFast = true;
      this.log(`[rpc] fast path back on ${this.fast.label}`);
    }
    return true;
  }

  private rest(reason: string) {
    this.restUntil = this.now() + this.restMs;
    if (this.stats.onFast) {
      this.stats.onFast = false;
      this.stats.switches++;
      this.stats.lastReason = reason.slice(0, 120);
      this.log(`[rpc] fast path -> ${this.heavy!.label} for ${Math.round(this.restMs / 60_000)} min (${this.stats.lastReason})`);
    }
  }

  async send(payload: ethers.JsonRpcPayload | ethers.JsonRpcPayload[]): Promise<Array<ethers.JsonRpcResult | ethers.JsonRpcError>> {
    if (!this.onFast()) return this.heavy!.send(payload);
    let results: Array<ethers.JsonRpcResult | ethers.JsonRpcError>;
    try {
      results = await this.fast.send(payload);
    } catch (err) {
      // No paid node to fall back to, or a non-endpoint error: pass it on.
      if (!this.heavy || !isEndpointTrouble(err)) throw err;
      this.rest(shortReason(err));
      return this.heavy.send(payload);
    }
    const limited = this.heavy ? resultsRateLimited(results) : null;
    if (limited) {
      this.rest('rate limited');
      return this.heavy!.send(payload); // resend the whole batch on HEAVY
    }
    return results;
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

  constructor(fastUrl: string, heavyUrl: string | null, chainId: number, opts: { restMs?: number; fastTimeoutMs?: number } = {}) {
    super(fastRequest(fastUrl, opts.fastTimeoutMs ?? 5_000), chainId, { staticNetwork: true });
    this.heavyProvider = heavyUrl && heavyUrl !== fastUrl ? new ethers.JsonRpcProvider(heavyUrl, chainId, { staticNetwork: true }) : null;
    const heavyProvider = this.heavyProvider;
    this.router = new FailoverRouter(
      { label: endpointLabel(fastUrl), send: (p) => super._send(p) },
      heavyProvider ? { label: endpointLabel(heavyUrl!), send: (p) => heavyProvider._send(p) } : null,
      { restMs: opts.restMs },
    );
  }

  override async _send(payload: ethers.JsonRpcPayload | ethers.JsonRpcPayload[]): Promise<Array<ethers.JsonRpcResult>> {
    return this.router.send(payload) as Promise<Array<ethers.JsonRpcResult>>;
  }

  override destroy() { this.heavyProvider?.destroy(); super.destroy(); }
}
