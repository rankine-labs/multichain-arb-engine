import { connect, Socket } from 'net';
import type { Rpc } from './simulator';

// ============================================================================
// LOCAL SIMULATOR CLIENT (arbsim sidecar, see sim/DESIGN.md)
//
// Plain English:
//   arbsim is a small program running next to the bot that keeps its own copy
//   of the Robinhood Chain state and can answer "what would this trade do?"
//   in about a millisecond, instead of ~100 ms asking a node. This file is
//   the bot's side of that conversation:
//
//     LocalSimClient   talks to the sidecar over a local socket (a pipe on
//                      the same machine, no network). Many questions can be
//                      in flight at once; each has a short time limit
//                      (default 25 ms). If the sidecar is down or slow, the
//                      answer is simply "unknown" - it never throws and never
//                      blocks the bot. It reconnects by itself.
//
//     makeLocalRpc     looks exactly like the node connection the simulator
//                      already uses (the `Rpc` type), so simulateRoundTrip /
//                      replayRpc / findBalanceSlot work unchanged. It answers
//                      eth_call and eth_simulateV1 from the sidecar, shaped
//                      like a node's answer. When the sidecar can't be sure,
//                      it either asks the real node instead (if a `fallback`
//                      node is given, counted) or returns a plain marker
//                      error that the bot treats as "this check couldn't run"
//                      (never as a trade result, never as a reason to pause).
//
//     localSimMode     reads LOCAL_SIM=off|shadow|on (default off).
//
// Wire format: each message = 4-byte big-endian length + UTF-8 JSON.
// Safety: read-only. No keys, nothing is ever sent to the chain from here.
// ============================================================================

// ---------------------------------------------------------------------------
// The marker error text for "local sim couldn't answer".
//
// It deliberately starts with "replay unavailable": with the existing
// rulebook (core/failReasons.ts classifySimOutcome) that is the ONLY wording
// that is
//   - not a trade verdict (bucket 'replay_unavailable', not contract_revert),
//   - not "overrides unsupported" (which would pause all checks 30 min),
//   - not a rate limit / network problem (which would pause checks 60 s),
//   - not "failed with no reason" (which would trigger a second-opinion check),
// and a replay that gets it already falls back to a plain node check
// (shadowMain runSimulation). The words "local sim unknown: <why>" follow,
// so logs say exactly what happened. Tested in src/test/localSim.test.ts.
// ---------------------------------------------------------------------------
export const LOCAL_UNKNOWN_PREFIX = 'replay unavailable (local sim unknown: ';
export const localUnknownMessage = (why: string): string => `${LOCAL_UNKNOWN_PREFIX}${safeWhy(why)})`;

// Keep the "why" to a short fixed-style word so it can never accidentally
// contain words the rulebook reacts to (e.g. "override", "limit", "exceeded").
function safeWhy(why: string): string {
  const w = String(why ?? 'unknown').toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 40);
  return /override|limit|exceed|quota|too_many|invalid_params|network|revert/.test(w) ? 'sidecar_error' : w || 'unknown';
}

export type LocalSimMode = 'off' | 'shadow' | 'on';

// LOCAL_SIM=off|shadow|on. Anything else (or unset) = off.
export function localSimMode(env: Record<string, string | undefined> = process.env): LocalSimMode {
  const v = (env.LOCAL_SIM ?? '').trim().toLowerCase();
  return v === 'shadow' || v === 'on' ? v : 'off';
}

// ---------------------------------------------------------------------------
// Sidecar answers (see sim/DESIGN.md "Socket protocol").
// ---------------------------------------------------------------------------
export type SidecarCallResult = { success: boolean; output: string; gasUsed: string; halt?: string };
export type SidecarAnswer =
  | { id?: number; ok: true; at?: unknown; results?: SidecarCallResult[]; best?: unknown; tried?: unknown[]; us?: number; [k: string]: unknown }
  | { id?: number; ok: false; unknown: string; missing?: unknown[]; detail?: string; us?: number };

export type LocalSimStats = {
  sent: number;          // questions sent to the sidecar
  answered: number;      // sure answers received
  unknown: number;       // "can't be sure" answers (incl. timeouts / disconnected)
  unknownByWhy: Record<string, number>;
  timeouts: number;
  fallbacks: number;     // questions passed on to the real node instead
  reconnects: number;
  feedSent: number;
  feedDropped: number;   // feed frames dropped (sidecar down / too slow)
  connected: boolean;
};

export type LocalSimClientOptions = {
  socketPath?: string;        // default env ARBSIM_SOCKET or /tmp/arbsim.sock
  timeoutMs?: number;         // per question, default 25
  maxFeedQueue?: number;      // feed frames kept while disconnected, default 256
  maxBufferedBytes?: number;  // feed frames are dropped while this much is unsent, default 4 MB
  maxFrameBytes?: number;     // biggest answer accepted, default 32 MB
  backoffMinMs?: number;      // reconnect wait, doubles up to backoffMaxMs
  backoffMaxMs?: number;
  log?: (msg: string) => void;
  autoConnect?: boolean;      // default true
};

type Pending = { resolve: (a: SidecarAnswer) => void; timer: NodeJS.Timeout };

// ---------------------------------------------------------------------------
// LocalSimClient: the socket connection.
// ---------------------------------------------------------------------------
export class LocalSimClient {
  readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly maxFeedQueue: number;
  private readonly maxBufferedBytes: number;
  private readonly maxFrameBytes: number;
  private readonly backoffMinMs: number;
  private readonly backoffMaxMs: number;
  private readonly log: (msg: string) => void;

  private sock: Socket | null = null;
  private connected = false;
  private closed = false;
  private backoff: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private feedQueue: Buffer[] = [];
  private inbuf: Buffer = Buffer.alloc(0);
  private everConnected = false;

  readonly stats: LocalSimStats = {
    sent: 0, answered: 0, unknown: 0, unknownByWhy: {}, timeouts: 0, fallbacks: 0,
    reconnects: 0, feedSent: 0, feedDropped: 0, connected: false,
  };

  constructor(opts: LocalSimClientOptions = {}) {
    this.socketPath = opts.socketPath ?? process.env.ARBSIM_SOCKET ?? '/tmp/arbsim.sock';
    this.timeoutMs = opts.timeoutMs ?? 25;
    this.maxFeedQueue = opts.maxFeedQueue ?? 256;
    this.maxBufferedBytes = opts.maxBufferedBytes ?? 4 * 1024 * 1024;
    this.maxFrameBytes = opts.maxFrameBytes ?? 32 * 1024 * 1024;
    this.backoffMinMs = opts.backoffMinMs ?? 100;
    this.backoffMaxMs = opts.backoffMaxMs ?? 5_000;
    this.backoff = this.backoffMinMs;
    this.log = opts.log ?? (() => {});
    if (opts.autoConnect !== false) this.connect();
  }

  isConnected(): boolean { return this.connected; }

  // Ask the sidecar a question (`msg` without id). Always resolves: a sure
  // answer, or { ok:false, unknown:"<why>" } (timeout, disconnected, ...).
  request(msg: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<SidecarAnswer> {
    return new Promise((resolve) => {
      try {
        if (!this.connected || !this.sock) { resolve(this.noteUnknown({ ok: false, unknown: 'disconnected' })); return; }
        const id = this.nextId++;
        if (this.nextId > 2_000_000_000) this.nextId = 1; // ids wrap around, never collide in practice
        const timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          this.stats.timeouts++;
          resolve(this.noteUnknown({ id, ok: false, unknown: 'timeout' }));
        }, timeoutMs);
        timer.unref?.();
        this.pending.set(id, { resolve, timer });
        this.stats.sent++;
        this.sock.write(frame({ ...msg, id }));
      } catch (e) {
        resolve(this.noteUnknown({ ok: false, unknown: 'client_error', detail: (e as Error).message }));
      }
    });
  }

  // Forward one raw sequencer-feed websocket frame. Fire-and-forget: no
  // answer. Kept in a small queue while the sidecar is unreachable; dropped
  // (and counted) when the queue is full or the socket is backed up.
  sendFeed(rawFrame: string): void {
    try {
      const buf = frame({ id: 0, type: 'feed', frame: rawFrame });
      if (this.connected && this.sock) {
        if (this.sock.writableLength > this.maxBufferedBytes) { this.stats.feedDropped++; return; }
        this.sock.write(buf);
        this.stats.feedSent++;
        return;
      }
      this.feedQueue.push(buf);
      while (this.feedQueue.length > this.maxFeedQueue) { this.feedQueue.shift(); this.stats.feedDropped++; }
    } catch {
      this.stats.feedDropped++;
    }
  }

  // Stop for good (tests, shutdown). Questions in flight answer "unknown".
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.failAll('closed');
    try { this.sock?.destroy(); } catch { /* already gone */ }
    this.sock = null;
    this.connected = false;
    this.stats.connected = false;
  }

  // -------------------------------------------------------------------------
  private connect(): void {
    if (this.closed) return;
    let s: Socket;
    try {
      s = connect(this.socketPath);
    } catch (e) {
      this.scheduleReconnect(`connect failed: ${(e as Error).message}`);
      return;
    }
    this.sock = s;
    s.unref(); // never keeps the bot process alive on its own
    s.on('connect', () => {
      if (this.sock !== s) return;
      this.connected = true;
      this.stats.connected = true;
      this.backoff = this.backoffMinMs;
      if (this.everConnected) this.stats.reconnects++;
      this.everConnected = true;
      this.log(`[local-sim] connected to ${this.socketPath}`);
      // Send feed frames saved while we were away, in order.
      const q = this.feedQueue;
      this.feedQueue = [];
      for (const b of q) { s.write(b); this.stats.feedSent++; }
    });
    s.on('data', (chunk: Buffer) => this.onData(s, chunk));
    s.on('error', () => { /* 'close' follows and handles it */ });
    s.on('close', () => {
      if (this.sock !== s) return;
      const was = this.connected;
      this.connected = false;
      this.stats.connected = false;
      this.sock = null;
      this.inbuf = Buffer.alloc(0);
      this.failAll('disconnected');
      this.scheduleReconnect(was ? 'connection lost' : 'not reachable');
    });
  }

  private scheduleReconnect(why: string): void {
    if (this.closed || this.reconnectTimer) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.backoffMaxMs);
    // Log only the slower retries, so a stopped sidecar doesn't flood the log.
    if (wait >= this.backoffMaxMs || wait === this.backoffMinMs) this.log(`[local-sim] ${why}, retrying in ${wait} ms`);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, wait);
    this.reconnectTimer.unref?.();
  }

  // Read whole frames out of the incoming bytes and match answers by id.
  private onData(s: Socket, chunk: Buffer): void {
    if (this.sock !== s) return;
    this.inbuf = this.inbuf.length ? Buffer.concat([this.inbuf, chunk]) : chunk;
    while (this.inbuf.length >= 4) {
      const len = this.inbuf.readUInt32BE(0);
      if (len > this.maxFrameBytes) {
        this.log(`[local-sim] answer too big (${len} bytes), reconnecting`);
        s.destroy();
        return;
      }
      if (this.inbuf.length < 4 + len) break;
      const body = this.inbuf.subarray(4, 4 + len);
      this.inbuf = this.inbuf.subarray(4 + len);
      let msg: any;
      try { msg = JSON.parse(body.toString('utf8')); } catch { continue; } // a broken answer: its question times out
      const id = typeof msg?.id === 'number' ? msg.id : -1;
      const p = this.pending.get(id);
      if (!p) continue; // late answer (already timed out) or unsolicited
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.ok === true) { this.stats.answered++; p.resolve(msg as SidecarAnswer); }
      else p.resolve(this.noteUnknown({ ...msg, ok: false, unknown: typeof msg?.unknown === 'string' ? msg.unknown : 'sidecar_error' }));
    }
  }

  private failAll(why: string): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) { clearTimeout(p.timer); p.resolve(this.noteUnknown({ ok: false, unknown: why })); }
  }

  private noteUnknown(a: SidecarAnswer & { ok: false }): SidecarAnswer {
    this.stats.unknown++;
    this.stats.unknownByWhy[a.unknown] = (this.stats.unknownByWhy[a.unknown] ?? 0) + 1;
    return a;
  }
}

// 4-byte big-endian length + UTF-8 JSON.
export function frame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

// ---------------------------------------------------------------------------
// makeLocalRpc: an `Rpc` answered by the sidecar.
// ---------------------------------------------------------------------------
type RpcAnswer = Awaited<ReturnType<Rpc>>;

export type LocalRpcOptions = {
  timeoutMs?: number; // per question (default: the client's)
  // Told about every answer the sidecar couldn't give (for logs / counters).
  onUnknown?: (method: string, why: string) => void;
};

// Which state a block tag means, in sidecar terms. null = not supported here.
export function blockTagToAt(tag: unknown): Record<string, unknown> | null {
  if (tag === undefined || tag === null || tag === 'latest') return { after: 'head' };
  if (typeof tag === 'string' && /^0x[0-9a-fA-F]+$/.test(tag)) return { block: tag.toLowerCase() };
  if (typeof tag === 'object' && typeof (tag as any).blockNumber === 'string' && /^0x[0-9a-fA-F]+$/.test((tag as any).blockNumber)) {
    return { block: (tag as any).blockNumber.toLowerCase() };
  }
  return null; // 'pending', 'safe', 'finalized', 'earliest', block hashes: ask the node
}

// One sidecar call result -> what a node's eth_call returns.
function ethCallAnswer(r: SidecarCallResult): RpcAnswer {
  if (r.success) return { result: r.output };
  const msg = haltMessage(r.halt);
  // geth: revert = code 3 + data (only when there is data); halts: -32000 + words.
  if (!r.halt) return r.output && r.output !== '0x'
    ? { error: { code: 3, message: 'execution reverted', data: r.output } }
    : { error: { code: -32000, message: 'execution reverted' } };
  return { error: { code: -32000, message: msg } };
}

// Halt reason (revm wording) -> the words a geth-style node uses.
function haltMessage(halt: string | undefined): string {
  const h = String(halt ?? '');
  if (/OutOfGas|out of gas/i.test(h)) return 'out of gas';
  if (/OpcodeNotFound|InvalidFEOpcode|NotActivated/i.test(h)) return 'invalid opcode';
  if (/StackUnderflow/i.test(h)) return 'stack underflow';
  if (/StackOverflow/i.test(h)) return 'stack limit reached';
  if (/InvalidJump/i.test(h)) return 'invalid jump destination';
  if (/^invalid: .*CallGasCostMoreThanGasLimit|intrinsic/i.test(h)) return 'intrinsic gas too low';
  return h ? `execution halted: ${h}` : 'execution reverted';
}

// Sidecar results for an eth_simulateV1 request -> the node's result shape
// (one block, one entry per call), as readReplayAnswer reads it.
function simulateV1Result(results: SidecarCallResult[]): unknown {
  return [{
    calls: results.map((r) => r.success
      ? { status: '0x1', returnData: r.output, gasUsed: r.gasUsed, logs: [] }
      : {
          status: '0x0',
          returnData: r.output || '0x',
          gasUsed: r.gasUsed,
          logs: [],
          error: !r.halt
            ? { code: 3, message: 'execution reverted', ...(r.output && r.output !== '0x' ? { data: r.output } : {}) }
            : { code: -32015, message: haltMessage(r.halt) },
        }),
  }];
}

export function makeLocalRpc(client: LocalSimClient, fallback?: Rpc, opts: LocalRpcOptions = {}): Rpc {
  // "Can't answer": the node answers instead (counted), or the marker error.
  const unknown = async (method: string, params: unknown[], why: string): Promise<RpcAnswer> => {
    try { opts.onUnknown?.(method, why); } catch { /* a logging problem must not break checks */ }
    if (fallback) {
      client.stats.fallbacks++;
      try { return await fallback(method, params); }
      catch (e) { return { error: { message: `network: ${(e as Error).message}` } }; }
    }
    return { error: { message: localUnknownMessage(why) } };
  };

  return async (method, params) => {
    try {
      const p = (params ?? []) as any[];
      if (method === 'eth_call') {
        const at = blockTagToAt(p[1]);
        if (!at) return unknown(method, params, 'unsupported_block_tag');
        const call = p[0];
        if (!call || typeof call !== 'object') return unknown(method, params, 'bad_request');
        const a = await client.request({ type: 'call', at, overrides: p[2] ?? {}, calls: [call] }, opts.timeoutMs);
        if (a.ok !== true) return unknown(method, params, a.unknown);
        const r = a.results?.[0];
        if (!r || a.results!.length !== 1) return unknown(method, params, 'bad_answer');
        return ethCallAnswer(r);
      }
      if (method === 'eth_simulateV1') {
        // Exactly the shape replayRpc sends: one simulated block on top of the
        // given block, validation off. Anything else goes to the node.
        const req = p[0];
        const bscs = req?.blockStateCalls;
        if (!Array.isArray(bscs) || bscs.length !== 1 || req.validation === true || req.traceTransfers || req.returnFullTransactions) {
          return unknown(method, params, 'unsupported_simulate_shape');
        }
        const at = blockTagToAt(p[1]);
        if (!at) return unknown(method, params, 'unsupported_block_tag');
        const b = bscs[0] ?? {};
        const calls = Array.isArray(b.calls) ? b.calls : [];
        if (!calls.length) return unknown(method, params, 'bad_request');
        // Only the block fields the sidecar can change; anything else -> node.
        const bo = b.blockOverrides ?? {};
        const extra = Object.keys(bo).filter((k) => k !== 'time' && k !== 'gasLimit');
        if (extra.length) return unknown(method, params, 'unsupported_block_override');
        const a = await client.request({
          type: 'call', at, nextBlock: true, blockOverrides: bo, overrides: b.stateOverrides ?? {}, calls,
        }, opts.timeoutMs);
        if (a.ok !== true) return unknown(method, params, a.unknown);
        if (!Array.isArray(a.results) || a.results.length !== calls.length) return unknown(method, params, 'bad_answer');
        return { result: simulateV1Result(a.results) };
      }
      // Everything else (receipts, blocks, ...) isn't the sidecar's job.
      return unknown(method, params, 'method_not_local');
    } catch (e) {
      return unknown(method, params as unknown[], 'client_error');
    }
  };
}
