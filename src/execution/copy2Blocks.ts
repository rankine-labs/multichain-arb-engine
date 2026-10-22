// ============================================================================
// COPY 2: PUTTING ONE BLOCK'S REPORTS TOGETHER (shared by the bot and the
// dry-run checker)
//
// Plain English:
//   arbsim's copy 2 is fed one message per block: the block's pool reports
//   (`pool_logs`) or "nothing for you in this block" (`block_tick`), plus the
//   block header's time, parent-chain block and logsBloom. This file decides
//   WHEN a block is complete enough to send and builds the message.
//
//   It used to live in scripts/sim-compare/copy2Lib.ts (the dry-run checker).
//   It moved here unchanged so the LIVE BOT (execution/copy2.ts) sends blocks
//   by exactly the rules the dry run validates. copy2Lib.ts re-exports it, so
//   the checker behaves as before.
//
//   Rules (BlockAssembler):
//     - a block goes out once its header has arrived and `graceMs` passed
//       since (the node sends a block's reports before its header; the grace
//       covers stragglers), or once something from 2+ blocks later arrived;
//     - a block whose reports came but whose header did not: after
//       HEADERLESS_WAIT_MS if a later block was seen, else after maxWaitMs.
//       It comes out with timestamp null; the caller must read the header
//       from the node first (arbsim refuses a block without a time);
//     - blocks always go out in increasing order (an older block goes with a
//       newer ready one);
//     - a report for a block already sent is "late": returned at once as its
//       own message (no bloom), with the block time remembered at sending.
//   logsBloom (dry run #17): the header's bloom goes on every on-time block
//   message, so arbsim marks a pool "pending" when the bloom says the pool
//   appears in the block but its report has not arrived yet.
//
//   HEADERLESS MODE ({headers: false}; the bot's default, COPY2_HEADERS=off):
//   block headers over the WebSocket cost one billed message per block
//   (~845k a day on Robinhood, more than the provider plan), so without them:
//     - a block goes out as soon as a report of a LATER block arrives, or
//       graceMs after its own first report, whichever comes first;
//     - its time / parent-chain block come from elsewhere (the bot: the
//       sequencer feed; the checker: whatever it was given with addHead),
//       or from the logs' own blockTimestamp. A ready block whose time is
//       not known yet waits at most timeWaitMs more, then comes out with
//       timestamp null (the caller must not send it: never a guessed time);
//     - no logsBloom on any message (arbsim then skips only its bloom rule;
//       the transfer / event pairing rules still apply);
//     - block_tick only for the NEWEST known block, once it is tickMs old
//       and nothing is held (keeps the copy's newest block current);
//     - late reports exactly as with headers.
//
// No network, no timers: the caller passes the clock.
// ============================================================================

export interface Head { block: number; timestamp: number | null; l1Block: number | null; at: number; logsBloom?: string | null }
export interface BlockOut { block: number; timestamp: number | null; l1Block: number | null; logs: any[]; firstLogAt: number | null; headAt: number | null; late?: boolean; logsBloom?: string | null }

// Hex / number -> number (null when missing or unreadable).
const num = (v: unknown): number | null => { if (v === undefined || v === null || v === '') return null; try { return Number(BigInt(v as string)); } catch { return null; } };
// Chain order inside a block: transaction index, then log index.
export const logOrder = (a: any, b: any) => (num(a.transactionIndex) ?? 0) - (num(b.transactionIndex) ?? 0) || (num(a.logIndex) ?? 0) - (num(b.logIndex) ?? 0);

// How long a block whose reports arrived without its header waits for the
// header before it is sent anyway (header then read from the node).
export const HEADERLESS_WAIT_MS = 400;

// Headerless mode settings (see above). timeOf / newestKnown let the bot
// read block times from its sequencer feed; the checker passes headers
// with addHead (only their time is used in this mode).
export interface AssemblerOptions {
  headers?: boolean;      // default true (the dry run #17 rules)
  timeWaitMs?: number;    // headerless: extra wait for a block's time (default 40)
  tickMs?: number;        // headerless: tick the newest known block after this (default 250; 0 = no ticks)
  timeOf?: (block: number) => { timestamp: number; l1Block?: number | null } | undefined;
  newestKnown?: () => { block: number; at: number } | null;
}

export class BlockAssembler {
  private logs = new Map<number, any[]>();
  private firstAt = new Map<number, number>();
  private heads = new Map<number, Head>();
  private sentHeads = new Map<number, Head>(); // headers of the last 256 blocks sent (for late reports)
  private newest = 0;
  lastSent = 0;   // highest block already sent (0 = nothing yet)
  late = 0;       // reports that arrived after their block was sent
  noHeader = 0;   // blocks sent without a header (timestamp unknown)
  private readonly headers: boolean;
  private times = new Map<number, Head>();     // headerless: block times given with addHead (last 1024)
  private newestTime: { block: number; at: number } | null = null;
  constructor(private readonly graceMs = 30, private readonly maxWaitMs = 1500, private readonly opts: AssemblerOptions = {}) {
    this.headers = opts.headers !== false;
  }

  // Headerless: a block's time + parent-chain block, from the caller's
  // source, the times given with addHead, or the logs' own blockTimestamp.
  private timeFor(b: number): { timestamp: number; l1Block: number | null } | null {
    try {
      const t = this.opts.timeOf?.(b);
      if (t && Number.isFinite(t.timestamp) && t.timestamp > 0) return { timestamp: t.timestamp, l1Block: t.l1Block ?? null };
    } catch { /* caller's source unreadable: try the others */ }
    const h = this.times.get(b);
    if (h && h.timestamp !== null) return { timestamp: h.timestamp, l1Block: h.l1Block };
    for (const l of this.logs.get(b) ?? []) {
      const ts = num(l?.blockTimestamp);
      if (ts !== null && ts > 0) return { timestamp: ts, l1Block: null };
    }
    return null;
  }

  // Returns a ready "late" message when the block was already sent.
  addLog(log: any, now: number): BlockOut | null {
    const b = num(log?.blockNumber);
    if (b === null) return null;
    if (this.lastSent && b <= this.lastSent) {
      this.late++;
      // The header was already used and forgotten: take the block time we
      // remembered when the block went out (arbsim needs it on every message).
      const h = this.heads.get(b) ?? this.sentHeads.get(b);
      const t = !h && !this.headers ? this.timeFor(b) : null;
      return { block: b, timestamp: h?.timestamp ?? t?.timestamp ?? null, l1Block: h?.l1Block ?? t?.l1Block ?? null, logs: [log], firstLogAt: now, headAt: h?.at ?? null, late: true };
    }
    (this.logs.get(b) ?? this.logs.set(b, []).get(b)!).push(log);
    if (!this.firstAt.has(b)) this.firstAt.set(b, now);
    if (b > this.newest) this.newest = b;
    return null;
  }

  addHead(h: Head): void {
    if (h.block > this.lastHead) this.lastHead = h.block;
    if (!this.headers) {
      // Headerless: only the block's time is kept (never its bloom, never
      // used to decide when a block is complete).
      if (!this.times.has(h.block)) {
        this.times.set(h.block, { block: h.block, timestamp: h.timestamp, l1Block: h.l1Block, at: h.at });
        if (this.times.size > 1024) this.times.delete(this.times.keys().next().value!);
      }
      if (!this.newestTime || h.block > this.newestTime.block) this.newestTime = { block: h.block, at: h.at };
      return;
    }
    if (this.lastSent && h.block <= this.lastSent) return;
    if (!this.heads.has(h.block)) this.heads.set(h.block, h);
    if (h.block > this.newest) this.newest = h.block;
  }

  // Blocks ready to send now, oldest first. Blocks with a header but no
  // reports come out with logs = [] (sent as `block_tick`).
  due(now: number): BlockOut[] {
    if (!this.headers) return this.dueHeaderless(now);
    const pending = [...new Set([...this.logs.keys(), ...this.heads.keys()])].filter((b) => b > this.lastSent).sort((a, b) => a - b);
    let upto = -1;
    for (const b of pending) {
      const h = this.heads.get(b);
      const first = this.firstAt.get(b);
      // A block needs its header (block time) before it can go out: arbsim
      // refuses block messages without a timestamp. So a block whose reports
      // came in before its header waits for the header (normally a few ms),
      // and only after HEADERLESS_WAIT_MS is it sent anyway; the caller then
      // reads the header from the node first (see copy2-dryrun pump()).
      const ready = h
        ? now - h.at >= this.graceMs || this.newest >= b + 2
        : first !== undefined && ((now - first >= Math.min(this.maxWaitMs, HEADERLESS_WAIT_MS) && this.newest >= b + 1) || now - first >= this.maxWaitMs);
      if (ready) upto = b; // everything older is sent with it (order kept)
    }
    const out: BlockOut[] = [];
    for (const b of pending) {
      if (b > upto) break;
      const h = this.heads.get(b);
      const logs = (this.logs.get(b) ?? []).sort(logOrder);
      if (!h && logs.length) this.noHeader++;
      out.push({ block: b, timestamp: h?.timestamp ?? null, l1Block: h?.l1Block ?? null, logs, firstLogAt: this.firstAt.get(b) ?? null, headAt: h?.at ?? null, logsBloom: h?.logsBloom ?? null });
      if (h) this.rememberSent(h);
      this.logs.delete(b); this.firstAt.delete(b); this.heads.delete(b);
      this.lastSent = b;
    }
    return out;
  }

  // Headerless rules (see the file header).
  private dueHeaderless(now: number): BlockOut[] {
    const pending = [...this.logs.keys()].filter((b) => b > this.lastSent).sort((a, b) => a - b);
    const waitTime = Math.max(0, this.opts.timeWaitMs ?? 40);
    let upto = -1;
    for (const b of pending) {
      const first = this.firstAt.get(b) ?? now;
      const complete = this.newest > b || now - first >= this.graceMs;
      const timed = this.timeFor(b) !== null || now - first >= this.graceMs + waitTime;
      if (complete && timed) upto = b; // everything older is sent with it (order kept)
    }
    const out: BlockOut[] = [];
    for (const b of pending) {
      if (b > upto) break;
      const t = this.timeFor(b);
      const logs = (this.logs.get(b) ?? []).sort(logOrder);
      if (!t) this.noHeader++;
      out.push({ block: b, timestamp: t?.timestamp ?? null, l1Block: t?.l1Block ?? null, logs, firstLogAt: this.firstAt.get(b) ?? null, headAt: null, logsBloom: null });
      if (t) this.rememberSent({ block: b, timestamp: t.timestamp, l1Block: t.l1Block, at: now });
      this.logs.delete(b); this.firstAt.delete(b);
      this.lastSent = b;
    }
    // Nothing held: "nothing for you" for the newest known block.
    const tickMs = this.opts.tickMs ?? 250;
    if (tickMs > 0 && pending.every((b) => b <= upto)) {
      let nk: { block: number; at: number } | null = null;
      try { nk = this.opts.newestKnown ? this.opts.newestKnown() : this.newestTime; } catch { nk = null; }
      if (nk && nk.block > this.lastSent && now - nk.at >= tickMs) {
        const t = this.timeFor(nk.block);
        if (t) {
          out.push({ block: nk.block, timestamp: t.timestamp, l1Block: t.l1Block, logs: [], firstLogAt: null, headAt: null, logsBloom: null });
          this.rememberSent({ block: nk.block, timestamp: t.timestamp, l1Block: t.l1Block, at: now });
          this.lastSent = nk.block;
          if (nk.block > this.newest) this.newest = nk.block;
        }
      }
    }
    return out;
  }

  // Blocks missed between the newest header seen so far and a newly seen
  // header (e.g. after a reconnect): [from, to] to read back from the node,
  // or null. Call BEFORE addHead for that header.
  gapBefore(block: number): { from: number; to: number } | null {
    const last = Math.max(this.lastHead, this.lastSent);
    if (!last || block <= last + 1) return null;
    return { from: last + 1, to: block - 1 };
  }
  private lastHead = 0;

  // ---- additions for the live bot (the checker never calls these) ----------
  // Blocks held, not sent yet (the bot keeps its pump timer running only
  // while there are some).
  pendingCount(): number {
    if (!this.headers) { let k = 0; for (const b of this.logs.keys()) if (b > this.lastSent) k++; return k; }
    let n = this.heads.size;
    for (const b of this.logs.keys()) if (!this.heads.has(b)) n++;
    return n;
  }
  // The WebSocket dropped: forget everything held but not sent (a held block
  // may be only partly received; it is read back from the node later). What
  // was SENT is kept: the block numbers and their headers (late reports).
  usesHeaders(): boolean { return this.headers; }
  dropPending(): void {
    this.logs.clear(); this.firstAt.clear(); this.heads.clear();
    this.newest = this.lastSent;
  }
  // A header read from the node after its block went out headerless: keep
  // its time for late reports of that block.
  rememberSent(h: Head): void {
    this.sentHeads.set(h.block, h);
    if (this.sentHeads.size > 256) this.sentHeads.delete(this.sentHeads.keys().next().value!);
  }
}

// The messages for one finished block (plan shapes).
// The header's logsBloom goes along (not on late messages): arbsim then
// answers "unknown" for a pool whose reports for that block may still be on
// their way, until it has checked the block's logs (dry run #17).
export function blockMessage(b: BlockOut): Record<string, unknown> {
  const bloom = !b.late && b.logsBloom ? { logsBloom: b.logsBloom } : {};
  if (!b.logs.length) return { type: 'block_tick', block: b.block, timestamp: b.timestamp, ...(b.l1Block !== null ? { l1Block: b.l1Block } : {}), ...bloom };
  return { type: 'pool_logs', block: b.block, timestamp: b.timestamp, ...(b.l1Block !== null ? { l1Block: b.l1Block } : {}), logs: b.logs, ...bloom };
}

// A newHeads push (or an eth_getBlockByNumber answer) -> Head. A bloom that
// is not exactly 256 bytes of hex is left out (never passed on half-read).
export function headFromNewHeads(r: any, now: number): Head | null {
  const block = num(r?.number);
  if (block === null) return null;
  const bloom = typeof r.logsBloom === 'string' && /^0x[0-9a-fA-F]{512}$/.test(r.logsBloom) ? r.logsBloom : null;
  return { block, timestamp: num(r.timestamp), l1Block: num(r.l1BlockNumber), at: now, ...(bloom ? { logsBloom: bloom } : {}) };
}
