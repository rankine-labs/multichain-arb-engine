import WebSocket from 'ws';
import { HANDLED_TOPICS, V4_SWAP_TOPIC, RpcFn, RpcLog, PoolUpdate, parsePoolLogs, latestPerPool } from './blockReader';
import { endpointLabel } from './endpointLabel';
import { nodeUsage, NodeUsageCounter } from './nodeUsage';

// ============================================================================
// PUSH BLOCK READER -- the node TELLS us about each block's pool events over a
// WebSocket, instead of us asking ~4 times a second.
//
// Plain English:
//   The normal block reader (core/blockReader.ts) "polls": every 0.25 s it
//   asks the node "anything new?". With a WebSocket the node pushes each
//   trade/reserve event to us the moment the block is made. That's faster,
//   and on paid providers it is far fewer requests.
//
//   Turned on only when BLOCK_READER_WSS is set in .env (a wss:// URL from
//   Chainstack, QuickNode, Alchemy, ...). Without it nothing here runs.
//
//   What it does:
//     - Subscribes to the same six event types the poll reader asks for
//       (Sync / Swap, see HANDLED_TOPICS) with no address filter, then keeps
//       only events from our pools here (same as the poll reader's
//       "localFilter" mode, and the same V4 pool-id check).
//     - Hands the results to the SAME function the poll reader uses
//       (onUpdates -> applyUpdate -> cache.upsertFromBlock), so the rest of
//       the bot can't tell which reader found the trade.
//
//   Safety nets:
//     - RECONNECT: if the connection drops it reconnects after 1 s, then
//       2 s, 4 s ... up to 30 s between tries (so a broken provider isn't
//       hammered). The wait goes back to 1 s once events flow again.
//     - STALE CHECK: if nothing at all arrives for 10 s (not even a reply to
//       our keep-alive "ping"), the connection is treated as dead and
//       reconnected. Pings are WebSocket control frames: providers don't
//       bill them.
//     - FALLBACK: while the WebSocket is not healthy, the poll reader runs
//       as before (healthy() tells it when to stay quiet). Nothing is lost
//       while the push feed is down.
//     - GAP FILL: after a reconnect, ONE eth_getLogs over the missed blocks
//       (on the normal HTTP node) so no block is skipped.
//     - REORG: an event marked "removed" (its block was replaced) is never
//       applied; the blocks from there on are re-read over HTTP.
//     - Never crashes the bot: every socket event is caught and counted.
//   Read only. Never sends a transaction. Never logs the URL (only the
//   provider name, e.g. "Chainstack").
// ============================================================================

// The bits of a WebSocket this reader uses. The real one comes from the `ws`
// package (already used by the Monad feed); tests pass a fake.
export interface SocketLike {
  send(data: string): void;
  close(): void;
  terminate?(): void;
  ping?(): void;
  on(event: string, fn: (...args: any[]) => void): unknown;
}

export interface WsBlockReaderOptions {
  url: string;                                     // wss:// URL (never logged)
  httpRpc: RpcFn;                                  // normal HTTP node, for gap fills and reorg re-reads
  httpLabel?: string;                              // its provider name (for the usage counter)
  poolManager: string;                             // Uniswap V4 PoolManager address
  addresses: () => string[];                       // pool contract addresses we watch (lowercase)
  v4Ids: () => Set<string>;                        // V4 pool ids we watch (lowercase)
  onUpdates: (latest: Map<string, PoolUpdate>, toBlock: number) => void;
  // Called when the push feed goes down (healthy=false: the poll reader takes
  // over from lastBlock) or comes back (healthy=true).
  onHealthChange?: (healthy: boolean, lastBlock: number) => void;
  heads?: boolean;                                 // also subscribe to newHeads (extra messages; off by default)
  staleMs?: number;                                // default 10,000
  pingMs?: number;                                 // send a keep-alive ping after this much quiet (default 5,000)
  minBackoffMs?: number;                           // default 1,000
  maxBackoffMs?: number;                           // default 30,000
  maxBackfill?: number;                            // max blocks in one gap fill (default 200)
  flushMs?: number;                                // gather events this long before applying them (default 5)
  connect?: (url: string) => SocketLike;           // test hook; default: the `ws` package
  schedule?: (fn: () => void, ms: number) => () => void;  // test hook; returns a cancel function
  now?: () => number;
  autoTick?: boolean;                              // run the 1 s health check timer (default true; tests drive tick())
  usage?: NodeUsageCounter;
  log?: (line: string) => void;
}

// Read a hex block number. null when missing / unreadable.
function toNum(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  try { const n = Number(BigInt(v as string)); return Number.isFinite(n) ? n : null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// backfillRange: which blocks to re-read after a reconnect.
//   from = the last block we saw events for (re-read it too: we may have
//          seen only part of it when the connection dropped),
//   to   = the node's newest block.
//   If that is more than maxRange blocks, only the newest maxRange are read
//   (the poll reader was covering the older ones while we were down) and
//   `skipped` says so. null = nothing to read.
// ---------------------------------------------------------------------------
export function backfillRange(lastBlock: number, head: number, maxRange = 200): { from: number; to: number; skipped: boolean } | null {
  if (lastBlock < 0 || head < 0 || !Number.isFinite(lastBlock) || !Number.isFinite(head)) return null;
  if (head < lastBlock) return null;
  const max = Math.max(1, Math.floor(maxRange));
  let from = lastBlock;
  let skipped = false;
  if (head - from + 1 > max) { from = head - max + 1; skipped = true; }
  return { from, to: head, skipped };
}

// Short, safe reason for a socket error. Raw messages can contain the host
// or URL, so only known shapes are kept.
export function wsReason(err: unknown): string {
  const m = String((err as any)?.message ?? err ?? '');
  const http = /unexpected server response:\s*(\d{3})/i.exec(m);
  if (http) return `HTTP ${http[1]}`;
  if (/timed? ?out|timeout/i.test(m)) return 'timed out';
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return 'host not found';
  if (/ECONNREFUSED|ECONNRESET|socket hang up|EPIPE/i.test(m)) return 'could not connect';
  if (/invalid url|invalid ur[il]/i.test(m)) return 'invalid URL';
  return 'socket error';
}

// Default real WebSocket (ws package): 10 s to connect, no compression.
const realConnect = (url: string): SocketLike =>
  new WebSocket(url, { handshakeTimeout: 10_000, perMessageDeflate: false }) as unknown as SocketLike;

// Default timer: a normal setTimeout that doesn't keep the process alive.
const realSchedule = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  (t as any).unref?.();
  return () => clearTimeout(t);
};

export class WsBlockReader {
  private readonly o: WsBlockReaderOptions;
  readonly label: string;                 // e.g. "Chainstack WebSocket"
  private readonly httpLabel: string;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly usage: NodeUsageCounter;
  private readonly staleMs: number;
  private readonly pingMs: number;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;

  private running = false;
  private socket: SocketLike | null = null;
  private gen = 0;                         // connection id: events from an old socket are ignored
  private logsSub: string | null = null;   // subscription id the node gave us for events
  private headsSub: string | null = null;
  private subscribed = false;
  private hadData = false;                 // a real event arrived on this connection (resets the backoff)
  private lastMsgAt = 0;                   // last time ANYTHING arrived (message or pong)
  private lastPingAt = 0;
  private backoffMs: number;
  private cancelReconnect: (() => void) | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private wasHealthy = false;
  private downSince: number;               // when the push feed last stopped being healthy
  private downMsTotal = 0;                 // finished stretches of poll fallback
  private lastBlock = -1;                  // newest block we have events for
  private head = -1;                       // newest block number seen (newHeads or gap fill)
  private everConnected = false;
  private buffer: RpcLog[] = [];
  private cancelFlush: (() => void) | null = null;
  private rereadFrom: number | null = null; // reorg: re-read from this block
  private rereading = false;
  private counts = { messages: 0, logs: 0, updates: 0, reconnects: 0, staleReconnects: 0, subscribeErrors: 0, socketErrors: 0, backfills: 0, backfillSkipped: 0, reorgs: 0 };

  constructor(o: WsBlockReaderOptions) {
    this.o = o;
    this.label = `${endpointLabel(o.url)} WebSocket`;
    this.httpLabel = o.httpLabel ?? 'block reader HTTP';
    this.now = o.now ?? Date.now;
    this.schedule = o.schedule ?? realSchedule;
    this.usage = o.usage ?? nodeUsage;
    this.staleMs = o.staleMs ?? 10_000;
    this.pingMs = o.pingMs ?? 5_000;
    this.minBackoff = o.minBackoffMs ?? 1_000;
    this.maxBackoff = o.maxBackoffMs ?? 30_000;
    this.backoffMs = this.minBackoff;
    this.downSince = this.now();
  }

  private log(line: string): void {
    try { (this.o.log ?? console.log)(`[blockreader:ws] ${line}`); } catch { /* logging must never throw */ }
  }

  // ---- public controls ----------------------------------------------------

  // Connect and keep the feed alive until stop().
  start(): void {
    if (this.running) return;
    this.running = true;
    this.usage.track(this.label);
    this.downSince = this.now();
    this.connect();
    if (this.o.autoTick !== false && !this.tickTimer) {
      this.tickTimer = setInterval(() => this.tick(), 1_000);
      (this.tickTimer as any).unref?.();
    }
  }

  stop(): void {
    this.running = false;
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    this.cancelReconnect?.(); this.cancelReconnect = null;
    this.cancelFlush?.(); this.cancelFlush = null;
    this.dropSocket();
  }

  // True while events are flowing over the WebSocket. While false, the poll
  // reader does the work (shadowMain pauses it only while this is true).
  healthy(): boolean {
    return this.running && this.subscribed && this.now() - this.lastMsgAt <= this.staleMs;
  }

  // The poll reader should be running right now (push feed not healthy).
  fallbackActive(): boolean { return !this.healthy(); }

  // Health check, every second: stale connection -> reconnect; quiet
  // connection -> keep-alive ping; health changes -> tell the bot.
  tick(): void {
    try {
      if (!this.running) return;
      const t = this.now();
      if (this.socket && t - this.lastMsgAt > this.staleMs) {
        this.counts.staleReconnects++;
        this.log(`${this.label}: nothing received for ${Math.round(this.staleMs / 1000)} s, reconnecting (block reader polls meanwhile)`);
        this.dropSocket();
        this.scheduleReconnect();
      } else if (this.socket && this.subscribed && t - this.lastMsgAt >= this.pingMs && t - this.lastPingAt >= this.pingMs) {
        this.lastPingAt = t;
        try { this.socket.ping?.(); } catch { /* a failed ping shows up as staleness */ }
      }
      this.noteHealth();
    } catch (e) {
      this.log(`health check error (${wsReason(e)})`);
    }
  }

  // ---- connection ---------------------------------------------------------

  private connect(): void {
    this.cancelReconnect = null;
    if (!this.running) return;
    const gen = ++this.gen;
    this.subscribed = false;
    this.hadData = false;
    this.logsSub = null;
    this.headsSub = null;
    this.lastMsgAt = this.now();           // the stale check also covers a connect that never finishes
    let sock: SocketLike;
    try {
      sock = (this.o.connect ?? realConnect)(this.o.url);
    } catch (e) {
      this.counts.socketErrors++;
      this.log(`${this.label}: could not open (${wsReason(e)})`);
      this.scheduleReconnect();
      return;
    }
    this.socket = sock;
    // Error listener first: an unhandled 'error' event would crash Node.
    sock.on('error', (e: unknown) => {
      if (gen !== this.gen) return;
      this.counts.socketErrors++;
      this.log(`${this.label}: connection error (${wsReason(e)})`);
      this.dropSocket();
      this.scheduleReconnect();
    });
    sock.on('open', () => {
      if (gen !== this.gen) return;
      try {
        this.lastMsgAt = this.now();
        // Same six event types the poll reader asks for, no address filter.
        sock.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['logs', { topics: [HANDLED_TOPICS] }] }));
        if (this.o.heads) sock.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_subscribe', params: ['newHeads'] }));
      } catch (e) {
        this.counts.socketErrors++;
        this.dropSocket();
        this.scheduleReconnect();
      }
    });
    sock.on('message', (data: unknown) => { if (gen === this.gen) this.onMessage(data); });
    sock.on('pong', () => { if (gen === this.gen) this.lastMsgAt = this.now(); });
    sock.on('close', () => {
      if (gen !== this.gen) return;
      this.log(`${this.label}: connection closed, reconnecting (block reader polls meanwhile)`);
      this.dropSocket();
      this.scheduleReconnect();
    });
  }

  // Forget the current socket (its later events are ignored) and close it.
  private dropSocket(): void {
    const s = this.socket;
    this.gen++;
    this.socket = null;
    this.subscribed = false;
    this.logsSub = null;
    this.headsSub = null;
    if (s) {
      try { s.terminate ? s.terminate() : s.close(); } catch { /* already closed */ }
    }
    this.noteHealth();
  }

  // Try again after the current wait, then double the wait (max 30 s).
  private scheduleReconnect(): void {
    if (!this.running || this.cancelReconnect) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.maxBackoff, this.backoffMs * 2);
    this.counts.reconnects++;
    this.cancelReconnect = this.schedule(() => { this.cancelReconnect = null; this.connect(); }, wait);
  }

  // How long the next reconnect will wait (for tests and the status line).
  nextBackoffMs(): number { return this.backoffMs; }

  // ---- messages -----------------------------------------------------------

  private onMessage(data: unknown): void {
    try {
      this.lastMsgAt = this.now();
      this.counts.messages++;
      this.usage.countWsMessage(this.label);
      const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      let m: any;
      try { m = JSON.parse(text); } catch { return; }   // not JSON: ignore
      if (!m || typeof m !== 'object') return;

      // Replies to our subscribe requests.
      if (m.id === 1 || m.id === 2) {
        if (m.error || typeof m.result !== 'string') {
          // e.g. the provider refuses an address-less log subscription.
          this.counts.subscribeErrors++;
          this.log(`${this.label}: subscription refused (${String(m.error?.message ?? 'no id').slice(0, 80).replace(/https?:\/\/\S+|wss?:\/\/\S+/g, '[url]')}); block reader keeps polling`);
          this.dropSocket();
          this.scheduleReconnect();
          return;
        }
        if (m.id === 1) {
          this.logsSub = m.result;
          this.subscribed = true;
          const reconnect = this.everConnected;
          this.everConnected = true;
          this.log(`${this.label}: live (push events)${reconnect ? ', filling the gap' : ''}`);
          this.noteHealth();
          // Gap fill: blocks we may have missed while disconnected.
          if (reconnect && this.lastBlock >= 0) void this.backfill(this.lastBlock, 'gap');
        } else {
          this.headsSub = m.result;
        }
        return;
      }

      // Pushed events.
      if (m.method === 'eth_subscription' && m.params) {
        const sub = m.params.subscription;
        const r = m.params.result;
        if (sub && sub === this.headsSub) {
          const n = toNum(r?.number);
          if (n !== null && n > this.head) this.head = n;
          this.markData();
          return;
        }
        if (sub && sub === this.logsSub && r) {
          this.markData();
          const logs: RpcLog[] = Array.isArray(r) ? r : [r];
          for (const l of logs) {
            this.counts.logs++;
            if (l?.removed) {
              // Reorg: never apply it; re-read from that block over HTTP.
              this.counts.reorgs++;
              const b = toNum(l.blockNumber);
              if (b !== null) this.rereadFrom = this.rereadFrom === null ? b : Math.min(this.rereadFrom, b);
              continue;
            }
            this.buffer.push(l);
          }
          this.scheduleFlush();
        }
      }
    } catch (e) {
      this.log(`message error (${wsReason(e)})`);
    }
  }

  // A real event arrived: the connection works, so reset the reconnect wait.
  private markData(): void {
    if (!this.hadData) { this.hadData = true; this.backoffMs = this.minBackoff; }
  }

  // Events of one block arrive as separate messages; gather them for a few
  // milliseconds so the bot gets them as one batch (one gap scan, not 20).
  private scheduleFlush(): void {
    if (this.cancelFlush) return;
    this.cancelFlush = this.schedule(() => { this.cancelFlush = null; this.flush(); }, this.o.flushMs ?? 5);
  }

  // Apply everything gathered so far (and start a reorg re-read if needed).
  flush(): void {
    const logs = this.buffer;
    this.buffer = [];
    if (logs.length) this.apply(logs);
    if (this.rereadFrom !== null && !this.rereading) {
      const from = this.rereadFrom;
      this.rereadFrom = null;
      void this.backfill(from, 'reorg');
    }
  }

  // Keep our pools' events (same rules as the poll reader's local filter),
  // decode, keep the newest per pool, hand to the bot.
  private apply(logs: RpcLog[], toBlockHint = -1): void {
    const pm = (this.o.poolManager || '').toLowerCase();
    const addrSet = new Set<string>();
    for (const a of this.o.addresses() ?? []) if (a) addrSet.add(a.toLowerCase());
    if (pm) addrSet.add(pm);
    const ids = this.o.v4Ids() ?? new Set<string>();
    let maxSeen = this.lastBlock;
    const kept: RpcLog[] = [];
    for (const l of logs) {
      if (!l || l.removed) continue;
      const b = toNum(l.blockNumber);
      if (b !== null && b > maxSeen) maxSeen = b;
      const addr = (l.address || '').toLowerCase();
      if (!addrSet.has(addr)) continue;                         // not one of our pools
      if (l.topics?.[0]?.toLowerCase() === V4_SWAP_TOPIC && addr === pm) {
        const id = l.topics[1]?.toLowerCase();
        if (!id || !ids.has(id)) continue;                      // a V4 pool we don't watch
      }
      kept.push(l);
    }
    this.lastBlock = Math.max(maxSeen, toBlockHint);
    if (this.lastBlock > this.head) this.head = this.lastBlock;
    const latest = latestPerPool(parsePoolLogs(kept, pm));
    if (latest.size === 0) return;
    this.counts.updates += latest.size;
    try {
      this.o.onUpdates(latest, this.lastBlock);
    } catch (e: any) {
      // A bug in the receiver must not stop the reader.
      console.error(`[blockreader:ws] onUpdates failed: ${e?.message ?? e}`);
    }
  }

  // One eth_getLogs over the blocks we may have missed (HTTP node).
  // Never throws.
  private async backfill(fromBlock: number, why: 'gap' | 'reorg'): Promise<void> {
    this.rereading = true;
    try {
      const head = toNum(await this.o.httpRpc('eth_blockNumber', []));
      this.usage.countRequest(this.httpLabel);
      if (head === null) return;
      if (head > this.head) this.head = head;
      const range = backfillRange(fromBlock, head, this.o.maxBackfill ?? 200);
      if (!range) return;
      if (range.skipped) this.counts.backfillSkipped++;
      const r = await this.o.httpRpc('eth_getLogs', [{ fromBlock: '0x' + range.from.toString(16), toBlock: '0x' + range.to.toString(16), topics: [HANDLED_TOPICS] }]);
      this.usage.countRequest(this.httpLabel);
      this.counts.backfills++;
      this.apply(Array.isArray(r) ? r : [], range.to);
    } catch (e) {
      this.log(`${why === 'gap' ? 'gap fill' : 'reorg re-read'} failed (${wsReason(e)}); the poll reader covers it`);
    } finally {
      this.rereading = false;
    }
  }

  // ---- health bookkeeping ---------------------------------------------------

  // Track healthy <-> fallback changes: time spent on fallback, and tell the bot.
  private noteHealth(): void {
    const h = this.healthy();
    if (h === this.wasHealthy) return;
    this.wasHealthy = h;
    const t = this.now();
    if (h) { this.downMsTotal += Math.max(0, t - this.downSince); }
    else { this.downSince = t; }
    try { this.o.onHealthChange?.(h, this.lastBlock); } catch { /* receiver bug must not stop the reader */ }
  }

  // Health numbers for the 5-minute [blockreader] line.
  stats(): { healthy: boolean; messages: number; logs: number; updates: number; reconnects: number; staleReconnects: number; subscribeErrors: number; socketErrors: number; backfills: number; backfillSkipped: number; reorgs: number; fallbackSeconds: number; lastBlock: number; head: number } {
    const fallbackMs = this.downMsTotal + (this.wasHealthy ? 0 : Math.max(0, this.now() - this.downSince));
    return { healthy: this.healthy(), ...this.counts, fallbackSeconds: Math.round(fallbackMs / 1000), lastBlock: this.lastBlock, head: this.head };
  }

  // One short piece of text for the [blockreader] log line.
  statusText(): string {
    const s = this.stats();
    return `push ${this.label}: ${s.healthy ? 'live' : 'DOWN (polling)'}, msgs ${s.messages}, reconnects ${s.reconnects}, fallback ${s.fallbackSeconds} s, last block ${s.lastBlock}` +
      (s.backfills ? `, gap fills ${s.backfills}` : '') + (s.reorgs ? `, reorg events ${s.reorgs}` : '') + (s.subscribeErrors ? `, refused ${s.subscribeErrors}` : '');
  }
}
