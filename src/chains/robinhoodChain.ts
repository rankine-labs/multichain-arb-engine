import WebSocket from 'ws';
import {
      ChainCapability, RawChainEvent, PreparedTransaction, FireResult,
} from '../core/types';
import { parseFeedFrame, parseFeedMessages, maxSequenceNumber, FeedMsg } from './nitroFeed';
import { labelled } from '../core/stallFinder';

// ============================================================================
// ROBINHOOD CHAIN ADAPTER
//
// Arbitrum Orbit / Nitro chain. There is NO public mempool to peek into --
// the sequencer decides ordering privately and broadcasts the decision the
// instant it's made, before the trade has actually finished processing.
//
// Confirmed feed: wss://feed.mainnet.chain.robinhood.com
// Ordering model: strictly first-come-first-served. Priority fee does
// NOTHING here -- our entire edge is submission latency, not gas bidding.
// Risk: single sequencer, no redundancy -- needs a liveness check.
//
// RECONNECTION: chainManager.ts already reconnects any adapter that
// reports unhealthy, on a centrally-coordinated 15s cycle -- that is the
// ONLY reconnect trigger. An earlier version of this file added a second,
// independent reconnect loop directly inside the close handler. That was
// a real mistake: confirmed live, the two competed and multiplied into a
// runaway loop (24,000+ requests, HTTP 429 rate-limiting from Robinhood's
// own server, repeated process crashes). This file must NOT self-trigger
// a reconnect. connect() still cleans up any previous socket so it's safe
// to call again whenever chainManager does.
// ============================================================================

const SEQUENCER_FEED_URL = 'wss://feed.mainnet.chain.robinhood.com';
// Max wait for the websocket handshake (connect() never hangs past this).
const CONNECT_TIMEOUT_MS = 10_000;
// An open socket that has delivered nothing for this long is treated as dead.
const SILENT_AFTER_OPEN_MS = 60_000;
const RPC_HTTP_URL = process.env.ROBINHOOD_RPC_HTTP ?? 'https://rpc.mainnet.chain.robinhood.com';

export class RobinhoodChainAdapter implements ChainCapability {
      readonly chain = 'robinhood' as const;
      readonly hasPendingMempool = false;
      readonly orderingModel = 'none' as const;

  private ws: WebSocket | null = null;
      private handlers: ((event: RawChainEvent) => void)[] = [];
      private lastSeqSeen = 0;
      private lastMessageAtMs = 0;
      private openedAtMs = 0;
      // FAST CHECK (execution/localSimHost.ts): told every raw feed message,
      // as text, unchanged, before anything else is done with it. Set only
      // when LOCAL_SIM is shadow/on; it just hands the text on (no waiting).
      private rawTap: ((text: string) => void) | null = null;

  // Pass every raw feed message (text) to `fn`, before it is parsed.
  setRawFrameTap(fn: ((text: string) => void) | null): void {
        this.rawTap = fn;
  }

  // TRIGGER-FIRST (execution/triggerFirst.ts): every feed message, complete
  // (all its signed transactions, block time, sequence number), handed on
  // BEFORE the trades in it are decoded, so the order buffer always holds
  // the trigger's message by the time the bot reacts to it. Set only when
  // LOCAL_SIM_TRIGGER_FIRST is shadow / on; null = no extra work at all.
  // `hr` (trigger-entry per-hop timing): when the websocket message arrived
  // and when it was parsed, high-resolution (performance.now(), ms with
  // decimals), so the entry point can see where the time goes.
  private msgTap: ((msgs: FeedMsg[], receivedAtMs: number, hr?: { recv: number; parsed: number }) => void) | null = null;
  setFeedMsgTap(fn: ((msgs: FeedMsg[], receivedAtMs: number, hr?: { recv: number; parsed: number }) => void) | null): void {
        this.msgTap = fn;
  }

  async connect(): Promise<void> {
        // Clean up any previous connection before reconnecting -- otherwise a
        // reconnect attempt after the socket died leaks the old (dead) socket
        // and its listeners instead of replacing them. A no-op 'error'
        // listener stays attached: an old socket that errors while closing
        // with no listener would crash the whole process.
        const old = this.ws;
        if (old) {
              try { old.removeAllListeners(); old.on('error', () => { /* closing, ignore */ }); old.terminate(); } catch { /* already dead, fine */ }
        }
        // Fresh connection: the health check must not trust message times
        // from the previous socket.
        this.lastMessageAtMs = 0;
        this.openedAtMs = 0;

        return new Promise((resolve, reject) => {
              // handshakeTimeout: Cloudflare can accept TCP and never answer the
              // upgrade; without a limit connect() would hang forever and block
              // every later health check (audit fix, Oct 2026).
              const ws = new WebSocket(SEQUENCER_FEED_URL, { handshakeTimeout: CONNECT_TIMEOUT_MS });
              this.ws = ws;
              let settled = false;
              const finish = (err?: Error) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    if (err) {
                          try { ws.terminate(); } catch { /* fine */ }
                          reject(err);
                    } else resolve();
              };
              // Belt and braces on top of handshakeTimeout.
              const timer = setTimeout(() => finish(new Error(`feed connect timed out after ${CONNECT_TIMEOUT_MS + 2_000}ms`)), CONNECT_TIMEOUT_MS + 2_000);

              ws.on('open', () => {
                    this.openedAtMs = Date.now();
                    console.log('[robinhood] sequencer feed connected');
                    finish();
              });

              // Stall finder: each feed frame (parse + split into trades) is
              // timed as "feed frame"; the trades' own work as "feed trade".
              ws.on('message', labelled('feed frame', (raw: WebSocket.RawData) => {
                    const receivedAtMs = Date.now();
                    const recvHr = performance.now();
                    this.lastMessageAtMs = receivedAtMs;

                    const text = raw.toString();
                    // Fast check: the raw message goes to the sidecar first, untouched
                    // (including backlog repeats after a reconnect: it skips those itself).
                    if (this.rawTap) { try { this.rawTap(text); } catch { /* never breaks the feed */ } }

                    let parsed: any;
                    try {
                          parsed = JSON.parse(text);
                    } catch {
                          return; // malformed frame, drop it
                    }

                    // Trigger-first order buffer: every message, also backlog
                    // repeats after a reconnect (the buffer keeps one copy per
                    // sequence number), before the repeat check below.
                    if (this.msgTap) { try { const fm = parseFeedMessages(parsed); this.msgTap(fm, receivedAtMs, { recv: recvHr, parsed: performance.now() }); } catch { /* never breaks the feed */ } }

                    const seq = maxSequenceNumber(parsed);
                    // After a reconnect the broadcaster can replay its backlog.
                    // Frames we've already seen are dropped so the same swap is
                    // never applied to cached prices twice.
                    if (seq !== null) {
                          if (seq <= this.lastSeqSeen) return;
                          this.lastSeqSeen = seq;
                    }

                    // One frame can hold many transactions (see nitroFeed.ts).
                    // Emit one event per contract call with plain { to, data },
                    // which is what the decoder understands.
                    for (const tx of parseFeedFrame(parsed)) {
                          const event: RawChainEvent = {
                                chain: 'robinhood',
                                stateType: 'SEQUENCED',
                                blockOrSeq: tx.sequenceNumber ?? seq ?? 'unknown',
                                receivedAtMs,
                                // rawTx / seq / txIndex: the signed bytes and their place in
                                // the feed (trigger-first replays them in order).
                                raw: withSender({ to: tx.to, data: tx.data, value: tx.value, hash: tx.hash, rawTx: tx.raw, seq: tx.sequenceNumber, txIndex: tx.txIndex }, tx),
                          };
                          for (const h of this.handlers) h(event);
                    }
              }));

              ws.on('error', (err) => {
                    console.error('[robinhood] feed error', err.message);
                    finish(err); // no-op once connected; health check handles the rest
              });

              ws.on('close', () => {
                    console.warn('[robinhood] feed closed -- chainManager will reconnect on its next health check');
                    finish(new Error('feed closed before it opened'));
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
          const msSinceLastMessage = Date.now() - this.lastMessageAtMs;
          const wsOpen = this.ws?.readyState === WebSocket.OPEN;

        if (!wsOpen) {
                return { healthy: false, reason: 'sequencer feed websocket is not open' };
        }
          if (this.lastMessageAtMs > 0 && msSinceLastMessage > 30_000) {
                  return { healthy: false, reason: `no sequencer messages in ${msSinceLastMessage}ms` };
          }
          // Opened but never sent a single message (blocks are ~0.1 s, so the
          // feed is never quiet this long when it works).
          if (this.lastMessageAtMs === 0 && this.openedAtMs > 0 && Date.now() - this.openedAtMs > SILENT_AFTER_OPEN_MS) {
                  return { healthy: false, reason: `feed open ${Math.round((Date.now() - this.openedAtMs) / 1000)}s but no messages` };
          }
          return { healthy: true };
  }

  async fireTransaction(preparedTx: PreparedTransaction): Promise<FireResult> {
          const submittedAtMs = Date.now();

        const txHash = '0x' + 'PLACEHOLDER'.padEnd(64, '0');

        return {
                submittedAtMs,
                txHash,
                method: 'sequencer-direct',
        };
  }
}

// Copies the feed tx's sender onto the event WITHOUT reading it: `from` stays
// lazy (see nitroFeed.ts defineLazyFrom), so the signature is only checked if
// something actually needs the sender (the rival tracker), not for every
// transaction before the bot can act on any of them.
function withSender<T extends object>(raw: T, tx: { from: string | null }): T & { from: string | null } {
  Object.defineProperty(raw, 'from', { enumerable: true, configurable: true, get: () => tx.from });
  return raw as T & { from: string | null };
}
