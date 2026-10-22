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

export class BlockAssembler {
  private logs = new Map<number, any[]>();
  private firstAt = new Map<number, number>();
  private heads = new Map<number, Head>();
  private sentHeads = new Map<number, Head>(); // headers of the last 256 blocks sent (for late reports)
  private newest = 0;
  lastSent = 0;   // highest block already sent (0 = nothing yet)
  late = 0;       // reports that arrived after their block was sent
  noHeader = 0;   // blocks sent without a header (timestamp unknown)
  constructor(private readonly graceMs = 30, private readonly maxWaitMs = 1500) {}

  // Returns a ready "late" message when the block was already sent.
  addLog(log: any, now: number): BlockOut | null {
    const b = num(log?.blockNumber);
    if (b === null) return null;
    if (this.lastSent && b <= this.lastSent) {
      this.late++;
      // The header was already used and forgotten: take the block time we
      // remembered when the block went out (arbsim needs it on every message).
      const h = this.heads.get(b) ?? this.sentHeads.get(b);
      return { block: b, timestamp: h?.timestamp ?? null, l1Block: h?.l1Block ?? null, logs: [log], firstLogAt: now, headAt: h?.at ?? null, late: true };
    }
    (this.logs.get(b) ?? this.logs.set(b, []).get(b)!).push(log);
    if (!this.firstAt.has(b)) this.firstAt.set(b, now);
    if (b > this.newest) this.newest = b;
    return null;
  }

  addHead(h: Head): void {
    if (h.block > this.lastHead) this.lastHead = h.block;
    if (this.lastSent && h.block <= this.lastSent) return;
    if (!this.heads.has(h.block)) this.heads.set(h.block, h);
    if (h.block > this.newest) this.newest = h.block;
  }

  // Blocks ready to send now, oldest first. Blocks with a header but no
  // reports come out with logs = [] (sent as `block_tick`).
  due(now: number): BlockOut[] {
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
    let n = this.heads.size;
    for (const b of this.logs.keys()) if (!this.heads.has(b)) n++;
    return n;
  }
  // The WebSocket dropped: forget everything held but not sent (a held block
  // may be only partly received; it is read back from the node later). What
  // was SENT is kept: the block numbers and their headers (late reports).
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
