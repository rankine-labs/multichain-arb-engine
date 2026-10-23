import { performance } from 'perf_hooks';

// ============================================================================
// EVENT-LOOP LAG PROBE (trigger-entry speed, Oct 23)
//
// Plain English:
//   The bot runs on ONE thread. When that thread is busy with something
//   long (a gap scan bite, a report, decoding a big feed frame), anything
//   that arrives meanwhile, like the sidecar's answer to a trigger check,
//   waits until it is free. That wait is "event-loop lag".
//
//   This probe sets a tiny timer every `everyMs` (20 ms) and notes how much
//   later than planned it actually fired. That delay IS the lag at that
//   moment. It costs almost nothing (one timer, a few numbers).
//
//     now()      the worst lag seen in the last ~200 ms (ms, 2 decimals):
//                written into each trigger's log line ("hops.lag")
//     takeHour() p50 / p90 / max of every probe this hour (hourly line)
//
//   The timer never keeps the bot running by itself (unref).
// ============================================================================
export class LagProbe {
  private timer: NodeJS.Timeout | null = null;
  private expected = 0;
  private recent: Array<{ at: number; lag: number }> = [];
  private hour: number[] = [];

  constructor(private readonly everyMs = 20, private readonly windowMs = 200) {}

  start(): void {
    if (this.timer) return;
    this.expected = performance.now() + this.everyMs;
    this.timer = setInterval(() => this.tick(), this.everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  running(): boolean { return this.timer !== null; }

  private tick(): void {
    const t = performance.now();
    const lag = Math.max(0, t - this.expected);
    this.expected = t + this.everyMs;
    this.recent.push({ at: t, lag });
    while (this.recent.length && t - this.recent[0].at > this.windowMs) this.recent.shift();
    this.hour.push(lag);
    if (this.hour.length > 200_000) this.hour.shift(); // memory bound (~1 h at 20 ms)
  }

  // Worst lag in the last window (ms, 2 decimals); 0 when not running.
  now(): number {
    if (!this.timer) return 0;
    // The current wait (a probe that is overdue right now) counts too.
    const overdue = Math.max(0, performance.now() - this.expected);
    let m = overdue;
    for (const r of this.recent) if (r.lag > m) m = r.lag;
    return Math.round(m * 100) / 100;
  }

  // This hour's lag: p50 / p90 / max (ms), then starts a new hour.
  takeHour(): { p50: number; p90: number; max: number; n: number } | null {
    const xs = this.hour;
    this.hour = [];
    if (!xs.length) return null;
    const a = xs.slice().sort((x, y) => x - y);
    const at = (q: number) => Math.round(a[Math.min(a.length - 1, Math.floor(a.length * q))] * 100) / 100;
    return { p50: at(0.5), p90: at(0.9), max: Math.round(a[a.length - 1] * 100) / 100, n: a.length };
  }
}

// One probe for the whole bot (started by the trigger entry point).
export const loopLag = new LagProbe();
