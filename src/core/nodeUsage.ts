// ============================================================================
// NODE USAGE COUNTER -- how many requests (and pushed WebSocket messages) each
// node has handled today.
//
// Plain English:
//   Paid providers (Chainstack, QuickNode, Alchemy, ...) bill by what you
//   send them AND, for WebSocket subscriptions, by every message they push to
//   you. core/nodeBudget.ts already counts requests for nodes that have a
//   daily allowance. This file is a simpler tally that also covers:
//     - messages pushed over a WebSocket (the push block reader,
//       core/blockReaderWs.ts), counted separately from requests
//     - requests to nodes that have no allowance (e.g. the gap-fill reads
//       the push reader makes after a reconnect)
//   It is counters only (no lists, no timings), so it costs nothing to keep.
//   Counts reset at midnight UTC, which is when providers start a new day.
//
// What shows in the hourly report ("Node usage today"):
//   - pushed messages for every WebSocket node, and
//   - requests for nodes NOT already shown by their daily allowance
//     ("metered" nodes are already listed by nodeBudget, so they are not
//     repeated here).
//   Nothing is added to the report unless one of the new .env settings is in
//   use, because only the new code calls this counter.
// ============================================================================

// One node's numbers for today.
export interface NodeUsageRow {
  label: string;         // provider name + job, e.g. "Chainstack WebSocket"
  requests: number;      // requests sent (a batch of 2 calls counts 2)
  wsMessages: number;    // messages the node pushed to us over a WebSocket
  metered: boolean;      // true = nodeBudget already reports this node's requests
}

// UTC day, e.g. "2026-10-12". Providers count their days in UTC.
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class NodeUsageCounter {
  private day: string;
  private rows = new Map<string, NodeUsageRow>();

  constructor(private readonly now: () => number = Date.now) {
    this.day = dayKey(now());
  }

  // New UTC day: start every count from zero (labels are kept so a node that
  // is configured still shows up, with 0, in the report).
  private rollDay(): void {
    const d = dayKey(this.now());
    if (d === this.day) return;
    this.day = d;
    for (const r of this.rows.values()) { r.requests = 0; r.wsMessages = 0; }
  }

  // Find (or create) the row for a node label.
  private row(label: string, metered = false): NodeUsageRow {
    let r = this.rows.get(label);
    if (!r) { r = { label, requests: 0, wsMessages: 0, metered }; this.rows.set(label, r); }
    if (metered) r.metered = true;
    return r;
  }

  // Make a node appear in the summary even before its first request
  // (so the report shows "0" instead of hiding a node that is silent).
  track(label: string, metered = false): void {
    this.rollDay();
    this.row(label, metered);
  }

  // Count `n` requests to a node. metered=true when nodeBudget already shows
  // this node's requests against a daily allowance.
  countRequest(label: string, n = 1, metered = false): void {
    this.rollDay();
    this.row(label, metered).requests += n;
  }

  // Count `n` messages a node pushed to us over a WebSocket.
  countWsMessage(label: string, n = 1): void {
    this.rollDay();
    this.row(label).wsMessages += n;
  }

  // Today's numbers for every node we have seen.
  summary(): NodeUsageRow[] {
    this.rollDay();
    return [...this.rows.values()].map((r) => ({ ...r }));
  }

  // Lines in the same shape the hourly report's "Node usage today" section
  // already uses ({ name, used, daily }). daily = Infinity prints as
  // "(no daily cap)". Metered nodes' requests are skipped (already listed).
  reportLines(): { name: string; used: number; daily: number }[] {
    const out: { name: string; used: number; daily: number }[] = [];
    for (const r of this.summary()) {
      if (r.wsMessages > 0 || this.isWs(r)) out.push({ name: `${r.label} (pushed messages)`, used: r.wsMessages, daily: Infinity });
      if (!r.metered && (r.requests > 0 || !this.isWs(r))) out.push({ name: `${r.label} (requests)`, used: r.requests, daily: Infinity });
    }
    return out;
  }

  // A WebSocket row is one whose label says so (set by the push reader).
  private isWs(r: NodeUsageRow): boolean { return /websocket/i.test(r.label); }

  // Short one-line text for log lines, e.g. "Chainstack WebSocket 1,204 msgs".
  text(): string {
    return this.summary()
      .map((r) => `${r.label} ${r.requests.toLocaleString('en-US')} req${r.wsMessages ? ` / ${r.wsMessages.toLocaleString('en-US')} msgs` : ''}`)
      .join(', ');
  }
}

// The one counter the bot uses (tests make their own with a fake clock).
export const nodeUsage = new NodeUsageCounter();
