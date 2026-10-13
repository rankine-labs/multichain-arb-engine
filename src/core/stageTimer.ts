// ============================================================================
// STAGE TIMERS ("where the time goes")
//
// Plain English:
//   "fire-ready" (readyMs) says how long it took from SEEING a trade on the
//   sequencer feed to HOLDING a signed trade. It's 120-194 ms today, but it
//   doesn't say WHERE those milliseconds went. This file splits it into
//   stages, like lap times on a stopwatch:
//
//     wait+decode  feed message received -> trade decoded (includes any time
//                  the message waited because the bot was busy with other work)
//     lookup       find the pool the trade used + its partner pools
//                  (an RPC "resolve" happens here only for pools we don't know)
//     prices       make sure prices are fresh (cache hit, or an RPC re-read)
//     math         plan the back-run and work out the profit
//     checks       bookkeeping + safety gate, up to asking for a signature
//     queue        waiting for the previous trade's turn to finish
//     sign         build + sign the transaction
//     send         the send call itself (live only; not part of fire-ready)
//
//   Measurement only: nothing here changes what the bot does.
//   Every stage is recorded for every trade that REACHES it (so the early
//   stages have lots of samples, sign/send only have fired trades).
//   Reported as median + p95 per stage, plus how often an RPC happened on
//   the hot path (pool resolve, price re-read). Memory is bounded: at most
//   MAX_SAMPLES per stage per window (later samples replace random older ones).
// ============================================================================

import { monitorEventLoopDelay } from 'perf_hooks';
type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;

export const STAGES = ['decode', 'lookup', 'prices', 'math', 'checks', 'queue', 'sign', 'send'] as const;
export type Stage = typeof STAGES[number];

// Names shown in the report (short, plain).
const LABEL: Record<Stage, string> = {
  decode: 'wait+decode', lookup: 'lookup', prices: 'prices', math: 'math',
  checks: 'checks', queue: 'queue', sign: 'sign', send: 'send',
};

const MAX_SAMPLES = 5_000;

// Wall-clock time in ms with sub-millisecond precision (same scale as
// Date.now(), so it can be compared with the feed's receivedAtMs).
export const preciseNow = (): number => performance.timeOrigin + performance.now();

// Median and 95th percentile of a list (null when empty).
export function medianP95(xs: number[]): { n: number; median: number | null; p95: number | null } {
  if (!xs.length) return { n: 0, median: null, p95: null };
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, median: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] };
}

// Readable ms: 0.4 ms -> "0.4", 12.6 ms -> "13".
export function fmtMs(ms: number | null): string {
  if (ms === null) return '?';
  return ms < 10 ? (Math.round(ms * 10) / 10).toString() : Math.round(ms).toString();
}

// Bounded sample list: keeps the first MAX_SAMPLES, then replaces a random
// older one (reservoir sampling), so medians stay fair on a busy hour.
class Samples {
  xs: number[] = [];
  seen = 0;
  add(v: number) {
    if (!Number.isFinite(v)) return;
    this.seen++;
    if (this.xs.length < MAX_SAMPLES) { this.xs.push(v); return; }
    const j = Math.floor(Math.random() * this.seen);
    if (j < MAX_SAMPLES) this.xs[j] = v;
  }
}

export interface StageSummary {
  stages: Record<Stage, { n: number; median: number | null; p95: number | null }>;
  lookupRpc: number;           // feed trades that needed an RPC pool resolve
  lookupRpcWatched: number;    //   ...of which the pair WAS on the watch list (should be ~0 with preload)
  priceRefresh: { n: number; median: number | null; p95: number | null }; // RPC price re-reads on the hot path, and their ms
  trustedWs: number;           // pools used straight from the cache thanks to the WebSocket (would otherwise be re-read)
  loopDelay: { p50: number | null; p99: number | null } | null; // event-loop delay (bot busy elsewhere), ms
}

// One window of measurements (5 minutes, or one hour).
export class StageStats {
  private s = new Map<Stage, Samples>(STAGES.map((st) => [st, new Samples()]));
  private refresh = new Samples();
  lookupRpc = 0;
  lookupRpcWatched = 0;
  trustedWs = 0;

  add(stage: Stage, ms: number) { this.s.get(stage)!.add(Math.max(0, ms)); }
  noteLookupRpc(watchedPair: boolean) { this.lookupRpc++; if (watchedPair) this.lookupRpcWatched++; }
  notePriceRefresh(ms: number) { this.refresh.add(Math.max(0, ms)); }
  noteTrustedWs(pools = 1) { this.trustedWs += pools; }

  summary(loopDelay: StageSummary['loopDelay'] = null): StageSummary {
    const stages = {} as StageSummary['stages'];
    for (const st of STAGES) stages[st] = medianP95(this.s.get(st)!.xs);
    const r = medianP95(this.refresh.xs);
    return { stages, lookupRpc: this.lookupRpc, lookupRpcWatched: this.lookupRpcWatched, priceRefresh: { ...r, n: this.refresh.seen }, trustedWs: this.trustedWs, loopDelay };
  }

  reset() {
    for (const st of STAGES) this.s.set(st, new Samples());
    this.refresh = new Samples();
    this.lookupRpc = this.lookupRpcWatched = this.trustedWs = 0;
  }
}

// One-line text, e.g.
//   Where the time goes (median): wait+decode 1 ms, lookup 0.2 ms (RPC 3x, 0 on watched pairs),
//   prices 0.1 ms (refresh 2x, 80 ms), math 2 ms, checks 0.5 ms, queue 0 ms, sign 2 ms, send 15 ms
// which = 'median' or 'p95'. Stages with no samples are left out.
export function formatStages(sum: StageSummary, which: 'median' | 'p95' = 'median'): string {
  const parts: string[] = [];
  for (const st of STAGES) {
    const x = sum.stages[st];
    if (!x.n) continue;
    let extra = '';
    if (st === 'lookup' && sum.lookupRpc) extra = ` (RPC ${sum.lookupRpc}x, ${sum.lookupRpcWatched} on watched pairs)`;
    if (st === 'prices' && (sum.priceRefresh.n || sum.trustedWs)) {
      const bits: string[] = [];
      if (sum.priceRefresh.n) bits.push(`refresh ${sum.priceRefresh.n}x, ${fmtMs(which === 'median' ? sum.priceRefresh.median : sum.priceRefresh.p95)} ms`);
      if (sum.trustedWs) bits.push(`WebSocket-trusted ${sum.trustedWs}x`);
      extra = ` (${bits.join('; ')})`;
    }
    parts.push(`${LABEL[st]} ${fmtMs(which === 'median' ? x.median : x.p95)} ms${extra}`);
  }
  // RPC counts are shown even if no trade reached that stage's finish line.
  if (!sum.stages.lookup.n && sum.lookupRpc) parts.push(`lookup RPC ${sum.lookupRpc}x (${sum.lookupRpcWatched} on watched pairs)`);
  if (!sum.stages.prices.n && sum.priceRefresh.n) parts.push(`price refresh ${sum.priceRefresh.n}x`);
  if (!parts.length) return `Where the time goes (${which}): no trades measured yet`;
  const loop = sum.loopDelay && sum.loopDelay.p50 !== null ? ` · bot busy (event loop delay) p50 ${fmtMs(sum.loopDelay.p50)} ms, p99 ${fmtMs(sum.loopDelay.p99)} ms` : '';
  return `Where the time goes (${which}): ${parts.join(', ')}${which === 'median' ? loop : ''}`;
}

// A trace follows ONE feed trade through the stages. mark(stage) records
// the time since the previous mark (or since the feed received the trade)
// into every window it was created with.
export class StageTrace {
  private last: number;
  constructor(private readonly sinks: StageStats[], startMs: number) { this.last = startMs; }
  mark(stage: Stage, now = preciseNow()) {
    const ms = now - this.last;
    for (const s of this.sinks) s.add(stage, ms);
    this.last = now;
  }
  // Fire results carry their own queue/sign/send times (measured inside the sender).
  addFire(f: { queueMs?: number; signMs: number; sendMs?: number }) {
    for (const s of this.sinks) {
      if (f.queueMs !== undefined) s.add('queue', f.queueMs);
      s.add('sign', f.signMs);
      if (f.sendMs !== undefined) s.add('send', f.sendMs);
    }
  }
}

// The two windows the bot reports: a 5-minute log line and the hourly
// Telegram report. Plus an event-loop delay monitor: if the bot is busy with
// other work (scans, big reads), a feed message waits before it is even
// looked at, and that shows up here and in "wait+decode".
export class StageTimers {
  readonly fiveMin = new StageStats();
  readonly hour = new StageStats();
  private loop5: IntervalHistogram | null = null;
  private loopHour: IntervalHistogram | null = null;

  constructor(watchEventLoop = true) {
    if (watchEventLoop) {
      try {
        this.loop5 = monitorEventLoopDelay({ resolution: 10 }); this.loop5.enable();
        this.loopHour = monitorEventLoopDelay({ resolution: 10 }); this.loopHour.enable();
      } catch { this.loop5 = this.loopHour = null; }
    }
  }

  begin(receivedAtMs: number): StageTrace { return new StageTrace([this.fiveMin, this.hour], receivedAtMs); }
  noteLookupRpc(watchedPair: boolean) { this.fiveMin.noteLookupRpc(watchedPair); this.hour.noteLookupRpc(watchedPair); }
  notePriceRefresh(ms: number) { this.fiveMin.notePriceRefresh(ms); this.hour.notePriceRefresh(ms); }
  noteTrustedWs(pools = 1) { this.fiveMin.noteTrustedWs(pools); this.hour.noteTrustedWs(pools); }

  private static loopOf(h: IntervalHistogram | null): StageSummary['loopDelay'] {
    if (!h || !h.count) return null;
    // Histogram values are in nanoseconds; the monitor's own resolution (10 ms) is subtracted.
    return { p50: Math.max(0, h.percentile(50) / 1e6 - 10), p99: Math.max(0, h.percentile(99) / 1e6 - 10) };
  }

  // Text for one window, then start a fresh window.
  take(which: 'fiveMin' | 'hour'): { median: string; p95: string; summary: StageSummary } {
    const st = which === 'fiveMin' ? this.fiveMin : this.hour;
    const h = which === 'fiveMin' ? this.loop5 : this.loopHour;
    const summary = st.summary(StageTimers.loopOf(h));
    const out = { median: formatStages(summary, 'median'), p95: formatStages(summary, 'p95'), summary };
    st.reset();
    try { h?.reset(); } catch { /* fine */ }
    return out;
  }
}
