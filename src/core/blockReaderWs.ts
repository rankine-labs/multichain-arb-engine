import WebSocket from 'ws';
import { HANDLED_TOPICS, V4_SWAP_TOPIC, RpcFn, RpcLog, PoolUpdate, parsePoolLogs, latestPerPool, AddressSetCache } from './blockReader';
import { stallFinder } from './stallFinder';
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
//       (Sync / Swap, see HANDLED_TOPICS), by default only from our own pool
//       contracts, plus V4 swaps for our own V4 pool ids (address filter: far
//       fewer billed messages),
//       then double-checks here (same V4 pool-id check as the poll reader).
//     - DAILY CAP: after BLOCK_READER_WSS_DAILY pushed messages in a UTC day
//       the push feed switches off and polling takes over until midnight UTC,
//       so a busy day can't run through the provider plan.
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
  // ADDRESS FILTER (default on): ask the node only for events from our own
  // pools (plus the V4 PoolManager) instead of every pool on the chain. Paid
  // providers bill each pushed message, and our pools are a small share of
  // all chain traffic, so this cuts the bill a lot. When the watch list
  // changes, the subscription is renewed (at most every resubscribeMs).
  addressFilter?: boolean;
  resubscribeMs?: number;                          // default 10 min
  // DAILY CAP: stop the push feed for the rest of the UTC day after this many
  // pushed messages (the poll reader takes over). 0 = no cap. Default 400,000.
  dailyMessageCap?: number;
  // COPY 2 TAP (execution/copy2.ts, fast check "copy 2"). Only set when
  // LOCAL_SIM is shadow/on; unset = this reader behaves exactly as before.
  rawLogTap?: RawLogTap;
}

// ---------------------------------------------------------------------------
// COPY 2 TAP. When the fast check follows our pools from their events, it
// needs EVERY event of those pools, not just Sync/Swap, plus coin transfers
// into / out of them. While tap.wanted() is true (and the address filter is
// on) the subscriptions change like this:
//   1) our pool contracts: ALL their events (instead of Sync/Swap only)
//   3) V4 PoolManager: ALL events for our V4 pool ids (instead of Swap only)
//   4) + coin Transfer events FROM our contract pools (coins of those pools)
//   5) + coin Transfer events TO our contract pools
// The extra events (mint, burn, LP moves...) also reach the normal price
// path, which ignores events it doesn't know (as the poll reader does).
// Every pushed log is handed to tap.onLogs as received (a quick hand-off);
// logs of 4) and 5) go ONLY to the tap. tap.onLive / tap.onDown say when
// all subscriptions are confirmed / when the connection is gone (so the
// copy knows events may have been missed).
// Cost: more pushed (billed) messages, roughly 2-3x today's on the same
// pools (each swap moves two coins), all counted against the daily cap.
// ---------------------------------------------------------------------------
export interface RawLogTap {
  wanted(): boolean;
  transferFilter(): { coins: string[]; pools: string[] } | null;
  onLogs(logs: RpcLog[]): void;
  onLive(coverage: { pools: Set<string>; ids: Set<string>; transferPools: Set<string>; coins: Set<string> }): void;
  onDown(): void;
}
// ERC-20 Transfer(address indexed from, address indexed to, uint256).
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const padTopic = (a: string): string => '0x' + '0'.repeat(24) + a.toLowerCase().slice(2);

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
  private v4Sub: string | null = null;     // second subscription: V4 swaps for OUR pool ids only (address filter mode)
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
  private counts = { messages: 0, logs: 0, updates: 0, reconnects: 0, staleReconnects: 0, subscribeErrors: 0, socketErrors: 0, backfills: 0, backfillSkipped: 0, reorgs: 0, resubscribes: 0 };
  private subSig = '';                     // which addresses the live subscription asked for
  private lastSubAt = 0;                   // when we last (re)subscribed
  private dayKey = '';                     // UTC day the message count belongs to
  private dayMessages = 0;                 // pushed messages today (UTC)
  private capped = false;                  // daily cap hit: push feed off until the next UTC day
  // Copy 2 tap state (see RawLogTap above).
  private tapOn = false;                   // this connection asked for the copy-2 subscriptions
  private tapSubs = new Set<string>();     // subscription ids of 4) and 5) (tap only)
  private tapWaiting = new Set<number>();  // request ids still waiting for their reply
  private tapLive = false;                 // tap.onLive was called for this connection
  private tapRefused = false;              // provider refused a copy-2 subscription: don't ask again
  private tapCoverage: { pools: Set<string>; ids: Set<string>; transferPools: Set<string>; coins: Set<string> } | null = null;
  private tapLogs = 0;                     // logs that reached the tap

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
      this.tickTimer = setInterval(() => stallFinder.run('block reader ws tick', () => this.tick()), 1_000);
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

  // ---- read-only facts for the "trust the WebSocket" price check ----------
  // (core/trustFresh.ts). None of these change how the reader works.
  //
  // Since when the push feed has been healthy WITHOUT a break (null = not
  // healthy now). Any drop, reconnect or subscription renewal starts a new
  // stretch, so a pool last updated before that can never be trusted on the
  // WebSocket's word alone.
  private healthyFrom: number | null = null;
  healthySinceMs(): number | null {
    if (!this.healthy()) { this.healthyFrom = null; return null; }
    // healthy() can flip true before the 1 s tick notices; take "now" then.
    if (this.healthyFrom === null) this.healthyFrom = this.now();
    return this.healthyFrom;
  }
  // Last time real event DATA arrived on each subscription (pongs don't
  // count): 'pools' = our pool contracts, 'v4' = V4 swaps for our pool ids.
  private dataAt = { pools: 0, v4: 0 };
  lastDataAtMs(kind: 'pools' | 'v4'): number { return this.dataAt[kind]; }
  // Is this pool covered RIGHT NOW, and since when? A pool counts only if
  //   - it is in the CURRENT watch list (addresses() / v4Ids()): events of
  //     a pool that left the list (e.g. its pair was dropped over
  //     ROBINHOOD_MAX_PAIRS) are thrown away by apply(), even while it is
  //     still in the subscription and in the cache;
  //   - and, with the address filter on, in the live subscription too (a
  //     newly watched pool joins at the next renewal).
  // Returns the time it has been in the current list without a gap (so a
  // pool that left and came back is only covered from its return), or null.
  // Address filter off: same current-list check (no subscription check).
  private subPools = new Set<string>();
  private subIds = new Set<string>();
  private curSince = new Map<string, number>(); // current-list pool -> in the list since
  private curAt = -Infinity;                    // when curSince was last rebuilt
  // Oct 14: the lists curSince was last built from. Same frozen address list
  // and same id set again = nothing to rebuild (see AddressSetCache).
  private curSrc: { addrs: unknown; ids: unknown } = { addrs: null, ids: null };
  private addrCache = new AddressSetCache();
  // Rebuild the "current list" view. Called by apply() (which reads the list
  // anyway) and by coveredSinceMs() at most once a second.
  private noteCurrent(addrs: Iterable<string>, ids: Iterable<string>, src?: readonly string[]): void {
    const t = this.now();
    // Built from these very lists last time (frozen list): the rebuild would
    // give the same map, so only the time is updated.
    if (src && Object.isFrozen(src) && this.curSrc.addrs === addrs && this.curSrc.ids === ids) { this.curAt = t; return; }
    this.curSrc = { addrs: src && Object.isFrozen(src) ? addrs : null, ids };
    const next = new Map<string, number>();
    for (const x of addrs) if (x) { const k = x.toLowerCase(); next.set(k, this.curSince.get(k) ?? t); }
    for (const x of ids) if (x) { const k = x.toLowerCase(); next.set(k, this.curSince.get(k) ?? t); }
    this.curSince = next;
    this.curAt = t;
  }
  coveredSinceMs(addr: string): number | null {
    if (!this.healthy()) return null;
    if (this.now() - this.curAt > 1_000) {
      try { const src = this.o.addresses() ?? []; this.noteCurrent(src, this.o.v4Ids() ?? new Set<string>(), src); } catch { return null; }
    }
    const a = addr.toLowerCase();
    const since = this.curSince.get(a);
    if (since === undefined) return null;
    if (this.o.addressFilter !== false && !(a.length === 66 ? this.subIds.has(a) : this.subPools.has(a))) return null;
    return since;
  }
  coversPool(addr: string): boolean { return this.coveredSinceMs(addr) !== null; }

  // Health check, every second: stale connection -> reconnect; quiet
  // connection -> keep-alive ping; health changes -> tell the bot.
  tick(): void {
    try {
      if (!this.running) return;
      const t = this.now();
      // New UTC day after a cap: turn the push feed back on.
      if (this.capped && this.utcDay(t) !== this.dayKey) {
        this.capped = false;
        this.dayKey = this.utcDay(t); this.dayMessages = 0;
        this.log(`${this.label}: new day, push feed back on`);
        this.backoffMs = this.minBackoff;
        this.connect();
        this.noteHealth();
        return;
      }
      // Watch list changed: renew the subscription so new pools are included
      // (at most every resubscribeMs, so a busy list doesn't cause churn).
      // Copy 2 switched on or off: renew sooner (at most every 30 s).
      const tapFlip = !!this.o.rawLogTap && this.tapWanted() !== this.tapOn && t - this.lastSubAt >= 30_000;
      if (this.socket && this.subscribed && this.o.addressFilter !== false &&
          (tapFlip || t - this.lastSubAt >= (this.o.resubscribeMs ?? 600_000)) &&
          this.listSig() !== this.subSig) {
        this.counts.resubscribes++;
        this.log(`${this.label}: watch list changed, renewing the subscription`);
        this.dropSocket();
        this.connect();                     // gap fill runs once the new subscription is live
        return;
      }
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
    if (this.capped) return;               // daily cap hit: stay off until the next UTC day (tick() restarts it)
    const gen = ++this.gen;
    this.subscribed = false;
    this.hadData = false;
    this.logsSub = null;
    this.headsSub = null;
    this.v4Sub = null;
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
        // Same six event types the poll reader asks for. With the address
        // filter on (default), only from our pools + the V4 PoolManager.
        //   Filter on: TWO subscriptions, so the node only pushes what we use:
        //     1) Sync/Swap events from our own pool contracts (V2/V3/Solidly/Algebra)
        //     2) V4 Swap events from the PoolManager, only for OUR V4 pool ids
        //        (the PoolManager emits every V4 swap on the chain, so filtering
        //        by pool id there is what keeps the message count down).
        this.lastSubAt = this.now();
        if (this.o.addressFilter !== false) {
          const { pools, ids } = this.subscribeLists();
          this.subSig = this.listSig();
          this.subPools = new Set(pools); this.subIds = new Set(ids); // what this subscription covers (read-only facts above)
          const nonV4 = HANDLED_TOPICS.filter((t) => t !== V4_SWAP_TOPIC);
          // Copy 2 (tap wanted): every event of our pools. Never an
          // address-less request (an empty list could mean "the whole chain").
          const tf = this.tapWanted() && pools.length > 0 ? this.tapFilter() : null;
          this.tapOn = !!tf;
          this.tapSubs = new Set(); this.tapWaiting = new Set(); this.tapLive = false; this.tapCoverage = null;
          sock.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['logs', this.tapOn ? { address: pools } : { address: pools, topics: [nonV4] }] }));
          const pm = (this.o.poolManager || '').toLowerCase();
          const v4 = !!pm && ids.length > 0;
          if (v4) sock.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'eth_subscribe', params: ['logs', { address: pm, topics: this.tapOn ? [null, ids] : [[V4_SWAP_TOPIC], ids] }] }));
          if (tf) {
            const padded = tf.pools.map(padTopic);
            sock.send(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'eth_subscribe', params: ['logs', { address: tf.coins, topics: [TRANSFER_TOPIC, padded] }] }));
            sock.send(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'eth_subscribe', params: ['logs', { address: tf.coins, topics: [TRANSFER_TOPIC, null, padded] }] }));
            this.tapWaiting = new Set(v4 ? [1, 3, 4, 5] : [1, 4, 5]);
            this.tapCoverage = { pools: new Set(pools), ids: new Set(v4 ? ids : []), transferPools: new Set(tf.pools), coins: new Set(tf.coins) };
          }
        } else {
          this.subSig = '';
          sock.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['logs', { topics: [HANDLED_TOPICS] }] }));
        }
        if (this.o.heads) sock.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_subscribe', params: ['newHeads'] }));
      } catch (e) {
        this.counts.socketErrors++;
        this.dropSocket();
        this.scheduleReconnect();
      }
    });
    // Stall finder: each pushed message (parse + keep our pools' events) is
    // timed as "block reader message" (measurement only).
    sock.on('message', (data: unknown) => { if (gen === this.gen) stallFinder.run('block reader message', () => this.onMessage(data)); });
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
    this.tapDown();
    this.gen++;
    this.socket = null;
    this.subscribed = false;
    this.logsSub = null;
    this.headsSub = null;
    this.v4Sub = null;
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
      if (this.countToday()) return;        // daily cap just hit: feed stopped
      const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      let m: any;
      try { m = JSON.parse(text); } catch { return; }   // not JSON: ignore
      if (!m || typeof m !== 'object') return;

      // Replies to the copy-2 transfer subscriptions (only sent when the tap is on).
      if ((m.id === 4 || m.id === 5) && this.tapOn) {
        if (m.error || typeof m.result !== 'string') {
          // Provider refuses this filter: copy 2 stays off on this reader
          // (the fast check falls back to the node), normal events continue.
          this.tapRefused = true;
          this.counts.subscribeErrors++;
          this.log(`${this.label}: copy-2 subscription refused (${String(m.error?.message ?? 'no id').slice(0, 80).replace(/https?:\/\/\S+|wss?:\/\/\S+/g, '[url]')}); copy 2 off, reconnecting without it`);
          this.dropSocket();
          this.scheduleReconnect();
          return;
        }
        this.tapSubs.add(m.result);
        this.tapReplied(m.id);
        return;
      }
      // Replies to our subscribe requests.
      if (m.id === 1 || m.id === 2 || m.id === 3) {
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
          this.tapReplied(1);
        } else if (m.id === 3) {
          this.v4Sub = m.result;
          this.tapReplied(3);
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
        // Copy-2 transfer subscriptions: only for the tap, never the price path.
        if (sub && this.tapSubs.has(sub) && r) {
          this.markData();
          this.toTap(Array.isArray(r) ? r : [r]);
          return;
        }
        if (sub && (sub === this.logsSub || sub === this.v4Sub) && r) {
          this.markData();
          if (sub === this.logsSub) this.dataAt.pools = this.now(); else this.dataAt.v4 = this.now();
          const logs: RpcLog[] = Array.isArray(r) ? r : [r];
          if (this.tapOn) this.toTap(logs);
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

  // What the filtered subscriptions ask for: our pool contracts and our V4
  // pool ids, sorted (so the same lists always give the same signature).
  private subscribeLists(): { pools: string[]; ids: string[] } {
    const pools = new Set<string>();
    for (const a of this.o.addresses() ?? []) if (a && a.length === 42) pools.add(a.toLowerCase());
    const ids = new Set<string>();
    for (const id of this.o.v4Ids() ?? []) if (id && id.length === 66) ids.add(id.toLowerCase());
    return { pools: [...pools].sort(), ids: [...ids].sort() };
  }
  private listSig(): string {
    const { pools, ids } = this.subscribeLists();
    let sig = pools.join(',') + '|' + ids.join(',');
    // Copy 2: whether its subscriptions are wanted, and their coin / pool lists.
    const tf = this.tapWanted() && pools.length > 0 ? this.tapFilter() : null;
    if (tf) sig += '|tap|' + tf.coins.join(',') + '|' + tf.pools.join(',');
    return sig;
  }

  // ---- copy 2 tap helpers (all do nothing without a tap) --------------------
  private tapWanted(): boolean {
    const t = this.o.rawLogTap;
    if (!t || this.tapRefused || this.o.addressFilter === false) return false;
    try { return t.wanted() === true; } catch { return false; }
  }
  // The transfer filter, lower case and sorted; null = nothing to ask for.
  private tapFilter(): { coins: string[]; pools: string[] } | null {
    try {
      const f = this.o.rawLogTap?.transferFilter();
      if (!f) return null;
      const clean = (xs: string[] | undefined) => [...new Set((xs ?? []).filter((a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)).map((a) => a.toLowerCase()))].sort();
      const coins = clean(f.coins), pools = clean(f.pools);
      // Never an empty list: an empty address / topic list could mean "everything".
      return coins.length && pools.length ? { coins, pools } : null;
    } catch { return null; }
  }
  private toTap(logs: RpcLog[]): void {
    this.tapLogs += logs.length;
    try { this.o.rawLogTap?.onLogs(logs); } catch { /* the tap must never break the reader */ }
  }
  // One subscription confirmed; when all are, the tap is live.
  private tapReplied(id: number): void {
    if (!this.tapOn || this.tapLive) return;
    this.tapWaiting.delete(id);
    if (this.tapWaiting.size > 0 || !this.tapCoverage) return;
    this.tapLive = true;
    try { this.o.rawLogTap?.onLive(this.tapCoverage); } catch { /* tap problem: ignored */ }
  }
  // Connection gone (or renewed): events may be missed from here on.
  private tapDown(): void {
    if (!this.tapOn) return;
    this.tapOn = false; this.tapLive = false; this.tapSubs = new Set(); this.tapWaiting = new Set();
    try { this.o.rawLogTap?.onDown(); } catch { /* ignored */ }
  }
  // Copy-2 facts for the status line.
  tapStatus(): { on: boolean; live: boolean; refused: boolean; logs: number } {
    return { on: this.tapOn, live: this.tapLive, refused: this.tapRefused, logs: this.tapLogs };
  }

  private utcDay(t: number): string { return new Date(t).toISOString().slice(0, 10); }

  // Count one pushed message against today's cap. True = cap just hit and
  // the feed was stopped (the poll reader takes over until the next UTC day).
  private countToday(): boolean {
    const t = this.now();
    const d = this.utcDay(t);
    if (d !== this.dayKey) { this.dayKey = d; this.dayMessages = 0; }
    this.dayMessages++;
    const cap = this.o.dailyMessageCap ?? 400_000;
    if (cap > 0 && this.dayMessages >= cap && !this.capped) {
      this.capped = true;
      this.log(`${this.label}: daily cap of ${cap} pushed messages reached, push feed off until midnight UTC (block reader polls meanwhile)`);
      this.dropSocket();
      return true;
    }
    return false;
  }

  // A real event arrived: the connection works, so reset the reconnect wait.
  private markData(): void {
    if (!this.hadData) { this.hadData = true; this.backoffMs = this.minBackoff; }
  }

  // Events of one block arrive as separate messages; gather them for a few
  // milliseconds so the bot gets them as one batch (one gap scan, not 20).
  private scheduleFlush(): void {
    if (this.cancelFlush) return;
    // Stall finder: applying the gathered events is named (measurement only).
    this.cancelFlush = this.schedule(() => { this.cancelFlush = null; stallFinder.run('block reader apply', () => this.flush()); }, this.o.flushMs ?? 5);
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
    const src = this.o.addresses() ?? [];
    const addrSet = this.addrCache.get(src, pm);
    const ids = this.o.v4Ids() ?? new Set<string>();
    this.noteCurrent(addrSet, ids, src); // keep coveredSinceMs() in step with what is really applied
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
    const endDecode = stallFinder.begin('block reader decode');
    let latest: Map<string, PoolUpdate>;
    try { latest = latestPerPool(parsePoolLogs(kept, pm)); } finally { endDecode(); }
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
    this.healthyFrom = h ? (this.healthyFrom ?? t) : null; // start / end of an unbroken healthy stretch
    if (h) { this.downMsTotal += Math.max(0, t - this.downSince); }
    else { this.downSince = t; }
    try { this.o.onHealthChange?.(h, this.lastBlock); } catch { /* receiver bug must not stop the reader */ }
  }

  // Health numbers for the 5-minute [blockreader] line.
  stats(): { healthy: boolean; messages: number; logs: number; updates: number; reconnects: number; staleReconnects: number; subscribeErrors: number; socketErrors: number; backfills: number; backfillSkipped: number; reorgs: number; resubscribes: number; fallbackSeconds: number; lastBlock: number; head: number; todayMessages: number; capped: boolean } {
    const fallbackMs = this.downMsTotal + (this.wasHealthy ? 0 : Math.max(0, this.now() - this.downSince));
    return { healthy: this.healthy(), ...this.counts, fallbackSeconds: Math.round(fallbackMs / 1000), lastBlock: this.lastBlock, head: this.head, todayMessages: this.dayMessages, capped: this.capped };
  }

  // One short piece of text for the [blockreader] log line.
  statusText(): string {
    const s = this.stats();
    return `push ${this.label}: ${s.capped ? 'OFF (daily cap, polling)' : s.healthy ? 'live' : 'DOWN (polling)'}, msgs ${s.messages} (today ${s.todayMessages}), reconnects ${s.reconnects}, fallback ${s.fallbackSeconds} s, last block ${s.lastBlock}` +
      (s.resubscribes ? `, list renewals ${s.resubscribes}` : '') +
      (s.backfills ? `, gap fills ${s.backfills}` : '') + (s.reorgs ? `, reorg events ${s.reorgs}` : '') + (s.subscribeErrors ? `, refused ${s.subscribeErrors}` : '');
  }
}
