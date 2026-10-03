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
//
// FLAPPING FIXES (Oct 2026) -- the feed was dropping and reconnecting
// every ~15s. Causes found and fixed here:
//   1. connect() resolved as soon as the socket OPENED, before the
//      subscription was accepted. A rejected subscribe (e.g. QuickNode
//      daily quota exhausted) looked like a successful connect, so
//      chainManager never backed off. connect() now resolves only once
//      eth_subscribe returns a subscription id, and rejects on an error.
//   2. No keepalive. Idle/half-dead sockets were silently dropped by the
//      provider or a load balancer. We now ping every 20s and kill the
//      socket if a pong doesn't come back, so a dead feed is detected fast
//      and cleanly instead of hanging.
//   3. connect() had no timeout, so a socket stuck "connecting" could
//      hang chainManager's health loop. It now gives up after 10s.
//   4. lastMessageAtMs carried over from the previous socket, so a fresh
//      connection could be declared stale before its first message. It is
//      now reset on every new connection.
//   5. Close code + reason were never logged, so we couldn't see WHY it
//      dropped. They are now.
//   6. Optional fallback endpoint (MONAD_FALLBACK_WSS). After several
//      short-lived connections in a row on the primary, the adapter
//      switches to the fallback, then tries the primary again later.
// ============================================================================

const PRIMARY_WS_URL = process.env.MONAD_QUICKNODE_WSS ?? 'wss://REPLACE_WITH_QUICKNODE_MONAD_ENDPOINT';
// Used when the primary keeps dropping (e.g. QuickNode daily quota hit).
// Defaults to Monad's public endpoint, confirmed by the live probe to
// support monadLogs. Set MONAD_FALLBACK_WSS=off to disable.
const FALLBACK_ENV = process.env.MONAD_FALLBACK_WSS;
const FALLBACK_WS_URL = FALLBACK_ENV === 'off' ? null : (FALLBACK_ENV || 'wss://rpc.monad.xyz');

// How long to wait for "socket open + subscription accepted" before giving up.
const CONNECT_TIMEOUT_MS = 10_000;
// Keepalive: send a ping this often; if the previous ping got no pong by
// the next tick, the connection is dead and gets terminated.
const PING_INTERVAL_MS = 20_000;
// No log messages for this long on an open socket = treat as stale.
const STALE_AFTER_MS = 30_000;
// A connection that dies sooner than this counts as "short-lived".
const SHORT_LIVED_MS = 60_000;
// This many short-lived connections in a row on the primary -> use fallback.
const SHORT_LIVED_BEFORE_FALLBACK = 3;
// After this long on the fallback, give the primary another chance
// (e.g. QuickNode's daily quota has reset).
const RETRY_PRIMARY_AFTER_MS = 30 * 60_000;

// Hides the API key embedded in provider URLs before anything gets logged.
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/...`;
  } catch {
    return '(invalid url)';
  }
}

export class MonadAdapter implements ChainCapability {
  readonly chain = 'monad' as const;
  readonly hasPendingMempool = false;
  readonly orderingModel = 'auction' as const; // still gas-priced, just not via a public mempool

  private ws: WebSocket | null = null;
  private handlers: ((event: RawChainEvent) => void)[] = [];
  private subId: string | null = null;
  private lastMessageAtMs = 0;
  private reorderedCount = 0; // tracked per Phase 1 requirement: measure how often speculative state flips

  // Monad re-sends a log as its block moves through commit stages
  // (proposed -> voted -> finalized). Only the FIRST sighting is passed on,
  // otherwise one swap would be evaluated and counted 3-4 times. Bounded so
  // it can't grow forever.
  private seenLogs = new Set<string>();
  private static readonly SEEN_LOGS_MAX = 20_000;

  // Keepalive state for the current socket.
  private pingTimer: NodeJS.Timeout | null = null;
  private awaitingPong = false;

  // Endpoint selection / flap tracking.
  private openedAtMs = 0;
  private consecutiveShortLived = 0;
  private usingFallbackSinceMs: number | null = null;

  constructor() {
    if (!FALLBACK_WS_URL) {
      console.log('[monad] fallback endpoint disabled (MONAD_FALLBACK_WSS=off) -- primary only');
    }
  }

  // Picks which endpoint the next connection should use.
  private pickUrl(): { url: string; label: 'primary' | 'fallback' } {
    const now = Date.now();

    // Been on the fallback a while -> give the primary another shot.
    if (this.usingFallbackSinceMs !== null && now - this.usingFallbackSinceMs >= RETRY_PRIMARY_AFTER_MS) {
      console.warn('[monad] retrying primary endpoint after time on fallback');
      this.usingFallbackSinceMs = null;
      this.consecutiveShortLived = 0;
    }

    // Primary keeps dropping right after connecting -> switch to fallback.
    if (
      FALLBACK_WS_URL &&
      this.usingFallbackSinceMs === null &&
      this.consecutiveShortLived >= SHORT_LIVED_BEFORE_FALLBACK
    ) {
      console.warn(`[monad] primary dropped ${this.consecutiveShortLived} times in a row -- switching to fallback`);
      this.usingFallbackSinceMs = now;
      this.consecutiveShortLived = 0;
    }

    if (this.usingFallbackSinceMs !== null && FALLBACK_WS_URL) {
      return { url: FALLBACK_WS_URL, label: 'fallback' };
    }
    return { url: PRIMARY_WS_URL, label: 'primary' };
  }

  // Stops the keepalive and detaches/closes the current socket.
  private teardown() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.awaitingPong = false;
    this.subId = null;
    const old = this.ws;
    this.ws = null;
    if (old) {
      try {
        old.removeAllListeners();
        // Keep a no-op error listener: a late error on a detached socket
        // with no listener would crash the whole process.
        old.on('error', () => { /* already discarded */ });
        old.terminate();
      } catch { /* already dead, fine */ }
    }
  }

  async connect(): Promise<void> {
    // Clean up any previous connection before reconnecting -- otherwise a
    // reconnect attempt after the socket died leaks the old (dead) socket
    // and its listeners instead of replacing them.
    this.teardown();

    const { url, label } = this.pickUrl();
    const ws = new WebSocket(url);
    this.ws = ws;
    // Fresh connection = fresh staleness clock (fix #4).
    this.lastMessageAtMs = 0;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (err) {
          // Failed connect counts toward switching endpoints.
          if (label === 'primary') this.consecutiveShortLived++;
          if (this.ws === ws) this.teardown();
          reject(err);
        } else {
          resolve();
        }
      };

      // Fix #3: never hang forever waiting for open + subscribe.
      const timeout = setTimeout(
        () => finish(new Error(`connect timed out after ${CONNECT_TIMEOUT_MS}ms (${label} ${redactUrl(url)})`)),
        CONNECT_TIMEOUT_MS,
      );

      ws.on('open', () => {
        this.openedAtMs = Date.now();
        ws.send(JSON.stringify({
          id: 1,
          jsonrpc: '2.0',
          method: 'eth_subscribe',
          params: ['monadLogs', {}],
        }));
        console.log(`[monad] socket open on ${label} (${redactUrl(url)}), subscribing to monadLogs`);

        // Fix #2: keepalive ping/pong.
        this.awaitingPong = false;
        this.pingTimer = setInterval(() => {
          if (this.ws !== ws) return;
          if (this.awaitingPong) {
            console.warn('[monad] no pong since last ping -- terminating dead socket');
            ws.terminate(); // fires 'close'; chainManager reconnects on next check
            return;
          }
          this.awaitingPong = true;
          try { ws.ping(); } catch { /* close handler will deal with it */ }
        }, PING_INTERVAL_MS);
      });

      ws.on('pong', () => {
        this.awaitingPong = false;
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        const receivedAtMs = Date.now();

        let parsed: any;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          return;
        }

        // Subscription response (fix #1): only now is the feed really live.
        if (parsed.id === 1) {
          if (parsed.result) {
            this.subId = parsed.result;
            this.lastMessageAtMs = receivedAtMs;
            console.log(`[monad] subscribed to monadLogs on ${label}`);
            finish();
          } else {
            const msg = parsed.error?.message ?? JSON.stringify(parsed.error ?? parsed);
            console.error(`[monad] eth_subscribe rejected on ${label}: ${msg}`);
            finish(new Error(`eth_subscribe rejected: ${msg}`));
          }
          return;
        }

        if (parsed.method !== 'eth_subscription') return;
        this.lastMessageAtMs = receivedAtMs;

        const params = parsed.params?.result;
        if (!params) return;

        const stateType = params.commitState === 'Finalized' ? 'FINALIZED' : 'SPECULATIVE';

        // De-duplicate across commit stages (see seenLogs above).
        const logId = params.transactionHash !== undefined && params.logIndex !== undefined
          ? `${params.transactionHash}:${params.logIndex}`
          : null;
        if (logId) {
          if (this.seenLogs.has(logId)) return;
          this.seenLogs.add(logId);
          if (this.seenLogs.size > MonadAdapter.SEEN_LOGS_MAX) {
            // Drop the oldest half (Sets iterate in insertion order).
            let drop = this.seenLogs.size / 2;
            for (const k of this.seenLogs) { if (drop-- <= 0) break; this.seenLogs.delete(k); }
          }
        }

        const event: RawChainEvent = {
          chain: 'monad',
          stateType,
          blockOrSeq: params.blockId ?? params.blockNumber ?? 'unknown',
          receivedAtMs,
          raw: params,
        };

        for (const h of this.handlers) h(event);
      });

      ws.on('error', (err) => {
        console.error(`[monad] feed error on ${label}:`, err.message);
        finish(err);
      });

      ws.on('close', (code: number, reasonBuf: Buffer) => {
        if (this.ws !== ws) return; // an old socket we already replaced
        const reason = reasonBuf?.toString() || 'no reason given';
        const livedMs = this.openedAtMs ? Date.now() - this.openedAtMs : 0;

        // Track short-lived connections on the primary for fallback (fix #6).
        if (label === 'primary' && settled) {
          if (livedMs < SHORT_LIVED_MS) this.consecutiveShortLived++;
          else this.consecutiveShortLived = 0;
        }

        // Fix #5: say WHY it closed.
        console.warn(
          `[monad] feed closed on ${label} after ${Math.round(livedMs / 1000)}s ` +
          `(code ${code}: ${reason}) -- chainManager will reconnect on its next health check`,
        );

        if (this.pingTimer) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
        this.subId = null;
        finish(new Error(`socket closed before subscribing (code ${code}: ${reason})`));
      });
    });
  }

  async disconnect(): Promise<void> {
    this.teardown();
  }

  onEvent(handler: (event: RawChainEvent) => void): void {
    this.handlers.push(handler);
  }

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
    const wsOpen = this.ws?.readyState === WebSocket.OPEN;
    if (!wsOpen) return { healthy: false, reason: 'monadLogs websocket is not open' };
    if (!this.subId) return { healthy: false, reason: 'monadLogs subscription not active' };
    const msSinceLastMessage = Date.now() - this.lastMessageAtMs;
    if (this.lastMessageAtMs > 0 && msSinceLastMessage > STALE_AFTER_MS) {
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
