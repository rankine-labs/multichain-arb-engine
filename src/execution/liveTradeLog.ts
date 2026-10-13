import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs';
import { dirname } from 'path';
import type { LiveResult } from './liveTracker';

// ============================================================================
// LIVE TRADE LOG -- a small file that records every real (live) send
//
// Plain English:
//   The status page (deploy/status-report.js, GitHub issue #15) runs as a
//   separate program and can't see inside the bot. So the bot writes one line
//   per live event to data/live-trades.jsonl, and the status page reads it.
//   Each line is one JSON object ("JSONL"). Kinds of line:
//     sent         a real trade was sent (has the tx hash, pair/route, size)
//     send_failed  the send itself was refused by the node (nothing on chain)
//     result       the receipt came back: won / reverted / dropped, with $
//     blocked      how many trades the safety gate stopped, by reason
//                  (added up and written at most once a minute, so a busy
//                  minute is one line, not thousands)
//   Only written in LIVE mode. Practice mode never writes this file.
//
// Size cap: when the file passes LIVE_LOG_MAX_BYTES (default 2 MB) it is
// renamed to live-trades.jsonl.1 (replacing the older one) and a fresh file
// starts. So at most ~4 MB on disk, ever.
//
// Never throws: a disk problem here must never affect trading.
// ============================================================================

export type LiveRecordKind = 'sent' | 'send_failed' | 'result' | 'blocked';

export interface LiveTradeRecord {
  t: number;                 // when (milliseconds since 1970, UTC)
  kind: LiveRecordKind;
  hash?: string;             // transaction hash (sent / result)
  label?: string;            // pair and route, e.g. "WETH/USDG uniswap-v3>uniswap-v2"
  sizeUsd?: number;          // trade size in USD (sent / send_failed)
  expectedProfitUsd?: number;
  status?: 'won' | 'reverted' | 'dropped'; // result only
  profitUsd?: number | null; // profit before gas from the contract (won only; null = price unknown)
  gasUsd?: number;           // gas paid in USD (result only)
  netUsd?: number;           // profit after gas: won = profit - gas, reverted = -gas, dropped = 0
  error?: string;            // send_failed only
  counts?: Record<string, number>; // blocked only: reason -> how many
}

export class LiveTradeLog {
  private blocked = new Map<string, number>();
  private lastFlush: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly file = 'data/live-trades.jsonl',
    private readonly maxBytes = Number(process.env.LIVE_LOG_MAX_BYTES ?? 2_000_000),
    private readonly now: () => number = Date.now,
    flushEveryMs = 60_000,
  ) {
    this.lastFlush = now();
    // Write the blocked counts once a minute even if no new block comes in.
    // unref(): this timer never keeps the program alive on its own.
    if (flushEveryMs > 0) {
      this.timer = setInterval(() => this.flushBlocked(), flushEveryMs);
      this.timer.unref?.();
    }
  }

  stop() { if (this.timer) clearInterval(this.timer); this.flushBlocked(); }

  // Add one line to the file (rotating first if it got too big).
  append(rec: Omit<LiveTradeRecord, 't'> & { t?: number }) {
    try {
      const dir = dirname(this.file);
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      if (existsSync(this.file) && statSync(this.file).size > this.maxBytes) renameSync(this.file, this.file + '.1');
      appendFileSync(this.file, JSON.stringify({ t: this.now(), ...rec }) + '\n');
    } catch (err) {
      console.warn('[livelog] could not write live trade log:', (err as Error).message);
    }
  }

  // A real trade went out (we have a tx hash).
  sent(hash: string, label: string, sizeUsd: number, expectedProfitUsd: number) {
    this.append({ kind: 'sent', hash, label, sizeUsd: round(sizeUsd), expectedProfitUsd: round(expectedProfitUsd, 4) });
  }

  // The node refused the send: nothing reached the chain, no gas paid.
  sendFailed(label: string, sizeUsd: number, error: string) {
    this.append({ kind: 'send_failed', label, sizeUsd: round(sizeUsd), error: error.slice(0, 160) });
  }

  // The receipt came back (or the trade was never mined).
  result(r: LiveResult) {
    const status = r.status === 'profit' ? 'won' : r.status;
    const netUsd = status === 'won' ? (r.profitUsd ?? 0) - r.gasUsd : status === 'reverted' ? -r.gasUsd : 0;
    this.append({
      kind: 'result', hash: r.hash, label: r.label, status,
      profitUsd: r.profitUsd === undefined ? (status === 'won' ? null : undefined) : round(r.profitUsd, 4),
      gasUsd: round(r.gasUsd, 4), netUsd: round(netUsd, 4), expectedProfitUsd: round(r.expectedProfitUsd, 4),
    });
  }

  // The safety gate stopped a live trade. Counted in memory, written once a minute.
  noteBlocked(reason: string) {
    this.blocked.set(reason, (this.blocked.get(reason) ?? 0) + 1);
    if (this.now() - this.lastFlush >= 60_000) this.flushBlocked();
  }

  flushBlocked() {
    this.lastFlush = this.now();
    if (!this.blocked.size) return;
    const counts = Object.fromEntries(this.blocked);
    this.blocked.clear();
    this.append({ kind: 'blocked', counts });
  }
}

// Keep the file small and readable: no 17-digit floats.
function round(n: number, digits = 2): number {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
