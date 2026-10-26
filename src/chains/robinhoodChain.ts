import WebSocket from 'ws';
import { Worker, SHARE_ENV } from 'worker_threads';
import { join } from 'path';
import {
      ChainCapability, RawChainEvent, PreparedTransaction, FireResult,
} from '../core/types';
import { parseFeedFrame, parseFeedMessages, maxSequenceNumber, FeedMsg, FeedTx } from './nitroFeed';
import { labelled, timed } from '../core/stallFinder';
import { feedWorkerEnabled, unpackFeedMsgs, unpackFeedTxs, toMainHr, FeedFrameOut, FromFeedWorker, ToFeedWorker } from './feedWorkerShared';

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
//
// FEED HELPER THREAD (FEED_WORKER=1, Oct 26; default off): the websocket and
// the heavy reading of each feed message (un-zip, JSON, unpacking, hashes)
// move to a helper thread (chains/feedWorkerEntry.ts), so the main thread
// has more time for fire-first triggers. Everything the main thread does
// with a feed message stays here, in the same order (onWorkerFrame below).
// Reconnects still come ONLY from chainManager: the helper connects when
// connect() asks and only reports "open" / "closed". If the helper thread
// itself dies, it is logged and a fresh (idle) one is started; the next
// health check sees the feed is down and reconnects, as for a dropped
// socket. If the helper can't even start (3 times in a row), the adapter
// goes back to the old in-thread way for the rest of the run (logged).
// FEED_WORKER=0 / missing = exactly the old code path, no thread at all.
// ============================================================================

const SEQUENCER_FEED_URL = 'wss://feed.mainnet.chain.robinhood.com';
// Max wait for the websocket handshake (connect() never hangs past this).
const CONNECT_TIMEOUT_MS = 10_000;
// An open socket that has delivered nothing for this long is treated as dead.
const SILENT_AFTER_OPEN_MS = 60_000;
const RPC_HTTP_URL = process.env.ROBINHOOD_RPC_HTTP ?? 'https://rpc.mainnet.chain.robinhood.com';
// Feed helper thread: pause before starting a fresh one after it died
// (1st, 2nd, 3rd+ time in a row; the count resets once a feed connects).
const WORKER_RESTART_DELAYS_MS = [1_000, 5_000, 30_000];
// Helper failed to even start this many times in a row: use the old
// in-thread way for the rest of the run.
const WORKER_MAX_START_FAILS = 3;

// Optional settings (tests only; the bot uses the defaults).
export interface RobinhoodAdapterOptions {
  feedUrl?: string;        // default: the real sequencer feed
  feedWorker?: boolean;    // default: the FEED_WORKER switch in .env
  workerEntry?: string;    // default: feedWorkerEntry.js next to this file
  log?: (line: string) => void;   // default console.log / console.warn
  warn?: (line: string) => void;
  workerRestartDelaysMs?: number[]; // default WORKER_RESTART_DELAYS_MS
}

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
        this.sendTaps();
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
        this.sendTaps();
  }

  // ---- Feed helper thread state (FEED_WORKER=1 only) -----------------------
  private readonly feedUrl: string;
  private useWorker: boolean;
  private readonly workerEntry: string;
  private readonly log: (line: string) => void;
  private readonly warn: (line: string) => void;
  private readonly restartDelays: number[];
  private worker: Worker | null = null;
  private workerReady = false;
  private workerRestartTimer: NodeJS.Timeout | null = null;
  private workerCrashesInRow = 0;   // for the restart pause
  private workerStartFails = 0;     // died before saying "ready", in a row
  private stopping = false;         // disconnect() called: no restarts
  private connId = 0;               // number of the latest connect()
  private feedOpen = false;         // helper says connection connId is open
  private pendingConnect: ((err?: Error) => void) | null = null;
  // Counters (tests and logs).
  workerStarts = 0;
  workerCrashes = 0;

  constructor(opts: RobinhoodAdapterOptions = {}) {
        this.feedUrl = opts.feedUrl ?? SEQUENCER_FEED_URL;
        this.useWorker = opts.feedWorker ?? feedWorkerEnabled();
        this.workerEntry = opts.workerEntry ?? join(__dirname, 'feedWorkerEntry.js');
        this.log = opts.log ?? ((l) => console.log(l));
        this.warn = opts.warn ?? ((l) => console.warn(l));
        this.restartDelays = opts.workerRestartDelaysMs ?? WORKER_RESTART_DELAYS_MS;
        if (this.useWorker) this.log('[robinhood] FEED_WORKER=1: the feed is read by a helper thread');
  }

  // True while the feed helper thread is in use (tests, status).
  get feedWorkerActive(): boolean { return this.useWorker; }

  async connect(): Promise<void> {
        if (this.useWorker) return this.connectViaWorker();
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
              const ws = new WebSocket(this.feedUrl, { handshakeTimeout: CONNECT_TIMEOUT_MS });
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
                    // Freeze fix (Oct 23): messages we already had (a reconnect's
                    // backlog replay, same sequence number or older) are not
                    // unpacked again or offered as new triggers. FEED_SKIP_REPEATS=0
                    // = old behaviour (every message unpacked and offered).
                    // Timed under its own names, so a freeze report can tell
                    // unpacking from the trigger work that follows.
                    if (this.msgTap) {
                          try {
                                const after = process.env.FEED_SKIP_REPEATS === '0' ? undefined : this.lastSeqSeen;
                                const fm = timed('feed unpack', () => parseFeedMessages(parsed, after));
                                if (fm.length) { const tap = this.msgTap; timed('feed tap', () => tap(fm, receivedAtMs, { recv: recvHr, parsed: performance.now() })); }
                          } catch { /* never breaks the feed */ }
                    }

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
                    const txs = timed('feed decode', () => parseFeedFrame(parsed));
                    this.emitTxs(txs, seq, receivedAtMs);
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

  // One event per contract call with plain { to, data }, which is what the
  // decoder understands (both ways of reading the feed end here).
  private emitTxs(txs: FeedTx[], seq: number | null, receivedAtMs: number): void {
        for (const tx of txs) {
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
  }

  // ==========================================================================
  // FEED HELPER THREAD (FEED_WORKER=1). Everything below is used only then.
  // ==========================================================================

  // Starts the helper thread if it isn't running. Never throws.
  private ensureWorker(): void {
        if (this.worker || this.stopping || !this.useWorker) return;
        if (this.workerRestartTimer) { clearTimeout(this.workerRestartTimer); this.workerRestartTimer = null; }
        let w: Worker;
        try {
              w = new Worker(this.workerEntry, {
                    // Shares the main thread's settings, so switches like
                    // FEED_SKIP_REPEATS / FEED_LIGHT_DECODE read the same values.
                    env: SHARE_ENV,
                    // The main thread's own memory flag must not apply here.
                    execArgv: process.execArgv.filter((a) => !a.startsWith('--max-old-space-size')),
                    resourceLimits: { maxOldGenerationSizeMb: 256 },
              });
        } catch (err) {
              this.onWorkerGone(null, `could not start: ${(err as Error)?.message ?? err}`);
              return;
        }
        // The helper must never be the only thing keeping the bot running.
        w.unref();
        this.worker = w;
        this.workerReady = false;
        this.workerStarts++;
        w.on('message', (m: FromFeedWorker) => this.onWorkerMessage(w, m));
        w.on('error', (err: Error) => { if (this.worker === w) this.warn(`[robinhood] feed helper thread failed: ${err?.message ?? err} (main thread keeps running)`); });
        w.on('exit', (code) => this.onWorkerGone(w, `stopped (exit code ${code})`));
        this.postWorker({ t: 'init', url: this.feedUrl, lastSeq: this.lastSeqSeen, wantText: !!this.rawTap, wantMsgs: !!this.msgTap, connectTimeoutMs: CONNECT_TIMEOUT_MS });
  }

  private postWorker(m: ToFeedWorker): void {
        try { this.worker?.postMessage(m); } catch (err) { this.warn(`[robinhood] feed helper: could not send it a message (${(err as Error)?.message ?? err})`); }
  }

  // Tells the helper which extras to send (raw text for the fast check, the
  // order buffer list) when a tap is set or cleared.
  private sendTaps(): void {
        if (this.useWorker && this.worker) this.postWorker({ t: 'taps', wantText: !!this.rawTap, wantMsgs: !!this.msgTap });
  }

  // The helper thread ended (crash, or it could not start). Logged, never
  // crashes the bot; a fresh idle helper is started after a pause. The feed
  // counts as down, so chainManager's next health check reconnects it.
  private onWorkerGone(w: Worker | null, why: string): void {
        if (w && this.worker !== w) return; // an old helper we already replaced
        const wasReady = this.workerReady;
        this.worker = null;
        this.workerReady = false;
        this.feedOpen = false;
        if (this.stopping) return;
        this.workerCrashes++;
        this.workerCrashesInRow++;
        if (!wasReady) this.workerStartFails++;
        const pending = this.pendingConnect;
        this.pendingConnect = null;
        if (pending) pending(new Error(`feed helper thread ${why}`));
        if (this.workerStartFails >= WORKER_MAX_START_FAILS) {
              this.useWorker = false;
              this.warn(`[robinhood] feed helper thread ${why}; it failed to start ${this.workerStartFails} times in a row, so the feed is read on the main thread again (old way) until the bot restarts`);
              return;
        }
        const delay = this.restartDelays[Math.min(this.workerCrashesInRow, this.restartDelays.length) - 1] ?? 30_000;
        this.warn(`[robinhood] feed helper thread ${why}; starting a fresh one in ${(delay / 1000).toFixed(1)} s (main thread keeps running; chainManager reconnects the feed)`);
        if (this.workerRestartTimer) clearTimeout(this.workerRestartTimer);
        this.workerRestartTimer = setTimeout(() => { this.workerRestartTimer = null; this.ensureWorker(); }, delay);
        this.workerRestartTimer.unref?.();
  }

  private connectViaWorker(): Promise<void> {
        // Fresh connection: the health check must not trust message times
        // from the previous socket (same as the old way).
        this.lastMessageAtMs = 0;
        this.openedAtMs = 0;
        this.feedOpen = false;
        this.stopping = false;
        // A connect() still waiting is replaced by this one (same as the old
        // way, where the new socket replaced the old one).
        const prev = this.pendingConnect;
        this.pendingConnect = null;
        if (prev) prev(new Error('feed connect replaced by a newer connect'));
        this.ensureWorker();
        if (!this.useWorker) return this.connect(); // could not start: old way
        if (!this.worker) return Promise.reject(new Error('feed helper thread could not start (retrying)'));
        const c = ++this.connId;
        return new Promise((resolve, reject) => {
              let settled = false;
              const finish = (err?: Error) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    if (this.pendingConnect === finish) this.pendingConnect = null;
                    if (err) { this.postWorker({ t: 'drop', c }); reject(err); }
                    else resolve();
              };
              // Same limit as the old way (the helper also uses handshakeTimeout).
              const timer = setTimeout(() => finish(new Error(`feed connect timed out after ${CONNECT_TIMEOUT_MS + 2_000}ms`)), CONNECT_TIMEOUT_MS + 2_000);
              this.pendingConnect = finish;
              this.postWorker({ t: 'connect', c });
        });
  }

  private onWorkerMessage(w: Worker, m: FromFeedWorker): void {
        if (this.worker !== w) return;
        switch (m.t) {
              case 'frame': this.onWorkerFrame(m); return;
              case 'ready': this.workerReady = true; this.workerStartFails = 0; return;
              case 'open':
                    if (m.c !== this.connId) return;
                    this.openedAtMs = Date.now();
                    this.feedOpen = true;
                    this.workerCrashesInRow = 0;
                    this.log('[robinhood] sequencer feed connected');
                    this.pendingConnect?.();
                    return;
              case 'error':
                    if (m.c !== this.connId) return;
                    this.warn(`[robinhood] feed error ${m.msg}`);
                    // No-op once connected; health check handles the rest.
                    this.pendingConnect?.(new Error(m.msg));
                    return;
              case 'closed':
                    if (m.c !== this.connId) return;
                    this.feedOpen = false;
                    this.warn('[robinhood] feed closed -- chainManager will reconnect on its next health check');
                    this.pendingConnect?.(new Error('feed closed before it opened'));
                    return;
              case 'log': (m.level === 'warn' ? this.warn : this.log)(m.line); return;
        }
  }

  // One feed message, already read by the helper. Same steps, same order as
  // the old 'message' handler in connect(): fast-check hand-off, order
  // buffer + trigger entry point, repeat check, trade decoder events.
  // Timed under the same stall-finder names ("feed frame", "feed unpack",
  // "feed tap", "feed decode"); "feed unpack" is now only the rebuild of the
  // helper's package, not the reading itself.
  private onWorkerFrame = labelled('feed frame', (f: FeedFrameOut): void => {
        // Arrival time as the helper saw it (Date.now() is one clock for all
        // threads). Messages from an older connection still count (they were
        // received before the reconnect), but don't make the new connection
        // look alive to the health check.
        const receivedAtMs = f.at;
        if (f.c === this.connId) this.lastMessageAtMs = Date.now();
        // recv: when the message arrived in the helper, on THIS thread's
        // performance.now() scale (see feedWorkerShared.ts CLOCKS).
        const recvHr = toMainHr(f.recvAbs);

        if (this.rawTap && typeof f.text === 'string') { try { this.rawTap(f.text); } catch { /* never breaks the feed */ } }
        if (f.bad) return; // malformed frame, dropped (as before)

        if (this.msgTap && f.m) {
              try {
                    const fm = timed('feed unpack', () => unpackFeedMsgs(f));
                    // parsed: when the main thread has the unpacked messages in hand
                    // (helper reading + hand-over + rebuild all come before it).
                    if (fm.length) { const tap = this.msgTap; timed('feed tap', () => tap(fm, receivedAtMs, { recv: recvHr, parsed: performance.now() })); }
              } catch { /* never breaks the feed */ }
        }

        // Repeat check: done by the helper (it keeps the same "last sequence
        // number"); this copy is what a restarted helper starts from.
        const seq = f.seq;
        if (seq !== null) {
              if (f.repeat || seq <= this.lastSeqSeen) return;
              this.lastSeqSeen = seq;
        }
        const txs = timed('feed decode', () => unpackFeedTxs(f));
        this.emitTxs(txs, seq, receivedAtMs);
  });

  // Tests only: make the helper thread fail on purpose.
  crashFeedWorkerForTest(): void { this.postWorker({ t: 'crash' }); }

  async disconnect(): Promise<void> {
          if (this.useWorker) {
                this.stopping = true;
                this.feedOpen = false;
                if (this.workerRestartTimer) { clearTimeout(this.workerRestartTimer); this.workerRestartTimer = null; }
                const w = this.worker;
                this.worker = null;
                this.workerReady = false;
                // Stopping the thread also closes its socket.
                if (w) void w.terminate().catch(() => undefined);
                return;
          }
          this.ws?.close();
          this.ws = null;
  }

  onEvent(handler: (event: RawChainEvent) => void): void {
          this.handlers.push(handler);
  }

  async healthCheck(): Promise<{ healthy: boolean; reason?: string }> {
          const msSinceLastMessage = Date.now() - this.lastMessageAtMs;
          // Helper thread: open = it said "open" for the latest connection
          // and has not said "closed" (or died) since.
          const wsOpen = this.useWorker ? (this.feedOpen && !!this.worker) : this.ws?.readyState === WebSocket.OPEN;

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
