import { AlertCenter, formatNote, formatDuration } from './alerts';

// ============================================================================
// ALERT WATCH -- the rules that decide when something is a problem
//
// Plain English:
//   Every 5 seconds this looks at facts the bot already keeps (is the trade
//   feed open? is the block updates socket live? is the practice-test node
//   paused? how much memory is used? did the loop worker crash?) and tells the
//   alert center "problem" or "fixed". It only READS those facts. It never
//   changes anything the bot does.
//
//   Rules (evidence only, nothing guessed):
//     - Live trade feed down for more than 20 s / back
//     - Block updates socket down (backup polling in use) for more than 60 s / back
//     - Block updates socket daily cap reached: one note per day
//     - Practice-test node paused or out of allowance for more than 2 min / back
//     - More than 10 trades too late to test in 5 min / back to 3 or fewer
//     - A freeze longer than 2 s (at most one alert per 30 min)
//     - Memory over 85% of the limit or RSS over 1.6 GB for 30 s /
//       back under 80% and 1.5 GB
//     - Loop worker crashed / restarted; gave up for the hour
// ============================================================================

const MB = 1024 * 1024;

export interface WatchSources {
  // Each one returns null when that part isn't running (then its rule is skipped).
  feedHealthy?: () => boolean | null;
  wsStatus?: () => { healthy: boolean; capped: boolean } | null;
  checkNodePaused?: () => 'busy' | 'off' | null;
  queueTimeoutsTotal?: () => number | null;   // running count; may reset to 0 (hourly)
  memory?: () => { heapUsed: number; heapLimit: number; rss: number } | null;
  loopWorker?: () => { crashes: number; restarts: number } | null;
}

export interface WatchOptions {
  now?: () => number;
  feedMinDownMs?: number;     // 20 s
  wsMinDownMs?: number;       // 60 s
  nodeMinPausedMs?: number;   // 2 min
  lateLimit?: number;         // 10 trades in the window
  lateWindowMs?: number;      // 5 min
  freezeMs?: number;          // 2 s
  memPct?: number;            // 0.85
  memRssBytes?: number;       // 1.6 GB
}

export class AlertWatch {
  private readonly now: () => number;
  private lastLateTotal: number | null = null;
  private lateIncs: { at: number; n: number }[] = [];
  private loopBase: { crashes: number; restarts: number } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly center: AlertCenter, private readonly src: WatchSources, private readonly o: WatchOptions = {}) {
    this.now = o.now ?? Date.now;
  }

  // Runs the checks every 5 s in the background (never keeps the process alive).
  start(everyMs = 5_000): this {
    if (this.timer) return this;
    this.timer = setInterval(() => this.tick(), everyMs);
    this.timer.unref?.();
    return this;
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  // One round of checks. Each rule is wrapped so a broken fact reader can't
  // stop the others (or ever throw into the bot).
  tick(): void {
    this.safe(() => this.checkFeed());
    this.safe(() => this.checkWs());
    this.safe(() => this.checkNode());
    this.safe(() => this.checkLate());
    this.safe(() => this.checkMemory());
    this.safe(() => this.checkLoopWorker());
    this.safe(() => this.center.tick());
  }

  private safe(f: () => void): void { try { f(); } catch { /* reporting only: ignore */ } }

  private checkFeed(): void {
    const ok = this.src.feedHealthy?.();
    if (ok === null || ok === undefined) return;
    if (!ok) {
      this.center.raise('feed', {
        title: 'Live trade feed disconnected', severity: 'high',
        meaning: "we can't see trades early, so we'll win fewer races",
        happening: 'reconnecting automatically',
        minDurationMs: this.o.feedMinDownMs ?? 20_000,
      });
    } else this.center.clear('feed', 'Live trade feed back', 'was down');
  }

  private checkWs(): void {
    const s = this.src.wsStatus?.();
    if (!s) return;
    if (s.capped) {
      // Daily cap: expected, not broken. One note per UTC day.
      this.center.clear('ws', 'Block updates: switched to backup polling for the rest of the day', 'was down');
      const day = new Date(this.now()).toISOString().slice(0, 10);
      this.center.post(formatNote('Block updates daily limit reached', [
        'What it means: prices update a little slower until midnight UTC (backup polling instead of instant push)',
        "What's happening: nothing to do, the instant feed comes back on its own after midnight UTC",
      ], this.now()), { onceKey: `ws-cap:${day}`, label: 'NOTE: Block updates daily limit reached' });
      return;
    }
    if (!s.healthy) {
      this.center.raise('ws', {
        title: 'Block updates feed down, using backup polling', severity: 'medium',
        meaning: 'prices update a little slower, so some chances may be missed',
        happening: 'reconnecting automatically; backup polling keeps prices updating meanwhile',
        minDurationMs: this.o.wsMinDownMs ?? 60_000,
      });
    } else this.center.clear('ws', 'Block updates feed back (instant again)', 'was down');
  }

  private checkNode(): void {
    if (!this.src.checkNodePaused) return;
    const why = this.src.checkNodePaused();
    if (why) {
      this.center.raise('check-node', {
        title: why === 'off' ? 'Practice-test node switched off for now' : 'Practice-test node paused (busy or out of allowance)',
        severity: 'medium',
        meaning: "we can't test trades on the real chain right now, so practice results are missing",
        happening: why === 'off' ? 'it turns itself back on after 30 min' : 'it retries on its own every minute',
        minDurationMs: this.o.nodeMinPausedMs ?? 120_000,
      });
    } else this.center.clear('check-node', 'Practice-test node working again');
  }

  private checkLate(): void {
    const total = this.src.queueTimeoutsTotal?.();
    if (total === null || total === undefined) return;
    const now = this.now();
    // The count is reset every hour: a smaller number means "started again from 0".
    const inc = this.lastLateTotal === null ? 0 : total >= this.lastLateTotal ? total - this.lastLateTotal : total;
    this.lastLateTotal = total;
    if (inc > 0) this.lateIncs.push({ at: now, n: inc });
    const win = this.o.lateWindowMs ?? 5 * 60_000;
    while (this.lateIncs.length && now - this.lateIncs[0]!.at > win) this.lateIncs.shift();
    const n = this.lateIncs.reduce((a, x) => a + x.n, 0);
    if (n > (this.o.lateLimit ?? 10)) {
      this.center.raise('late', {
        title: 'Many trades too late to test', severity: 'medium',
        meaning: 'the practice-test line is backed up, so some chances are skipped',
        happening: `${n} trades waited over 2 s in the last ${Math.round(win / 60_000)} min; the line clears on its own`,
      });
    } else if (n <= 3) this.center.clear('late', 'Trades are being tested on time again');
  }

  private checkMemory(): void {
    const m = this.src.memory?.();
    if (!m || !(m.heapLimit > 0)) return;
    const pct = m.heapUsed / m.heapLimit;
    const high = pct > (this.o.memPct ?? 0.85) || m.rss > (this.o.memRssBytes ?? 1.6 * 1024 * MB);
    const low = pct < (this.o.memPct ?? 0.85) - 0.05 && m.rss < (this.o.memRssBytes ?? 1.6 * 1024 * MB) - 100 * MB;
    if (high) {
      this.center.raise('memory', {
        title: 'Memory use high', severity: 'high',
        meaning: 'if it keeps growing the bot could crash and restart (a few minutes of missed trades)',
        happening: `using ${Math.round(pct * 100)}% of its memory limit (${Math.round(m.rss / MB)} MB total); watching it`,
        minDurationMs: 30_000,
      });
    } else if (low) this.center.clear('memory', 'Memory back to normal');
  }

  private checkLoopWorker(): void {
    const s = this.src.loopWorker?.();
    if (!s) return;
    if (!this.loopBase) { this.loopBase = { ...s }; return; }
    const crashed = s.crashes > this.loopBase.crashes;
    const restarted = s.restarts > this.loopBase.restarts;
    this.loopBase = { ...s };
    const spec = {
      title: 'Loop finder crashed', severity: 'medium' as const,
      meaning: '3-pool loop chances are not checked until it restarts; normal 2-pool trading is not affected',
      happening: 'restarting automatically',
    };
    if (crashed && restarted && !this.center.isOpen('loop')) {
      // Crashed and already back within one check: one message is enough.
      this.center.event('loop-quick', { ...spec, title: 'Loop finder crashed and restarted itself', happening: 'running again, nothing to do' });
      return;
    }
    if (crashed) this.center.raise('loop', spec);
    if (restarted) this.center.clear('loop', 'Loop finder restarted and running', 'was down');
  }

  // Called by the stall finder for every freeze. Only long ones matter here.
  onFreeze(ms: number, biggestJob?: string | null): void {
    this.safe(() => {
      if (!(ms > (this.o.freezeMs ?? 2_000))) return;
      this.center.event('freeze', {
        title: `Bot froze for ${(ms / 1000).toFixed(1)} s`, severity: 'medium',
        meaning: "while frozen the bot couldn't react to trades, so it may have missed some",
        happening: `running normally again${biggestJob ? ` (mostly busy with: ${biggestJob})` : ''}`,
        cooldownMs: 30 * 60_000,
      });
    });
  }

  // Called with the loop worker's warning lines. "restarted N times in the
  // last hour: loops paused for M min" means it gave up for now.
  onLoopWarn(line: string): void {
    this.safe(() => {
      const m = /restarted (\d+) times in the last hour: loops paused for (\d+) min/.exec(line);
      if (!m) return;
      this.center.event('loop-gave-up', {
        title: 'Loop finder crashed too often, paused', severity: 'medium',
        meaning: '3-pool loop chances are not checked for now; normal 2-pool trading is not affected',
        happening: `it crashed ${m[1]} times in an hour, so it waits ${formatDuration(Number(m[2]) * 60_000)} before trying again`,
        cooldownMs: 60 * 60_000,
      });
    });
  }
}
