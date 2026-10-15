// ============================================================================
// ALERT CENTER -- instant Telegram alerts in plain English
//
// Plain English:
//   Something goes wrong (a feed drops, memory gets high, a live trade fails)
//   and the owner gets ONE short message saying what it means and what the
//   bot is doing about it. When it clears, ONE "FIXED" message says so and how
//   long it lasted.
//
//   Example:
//     🚨 PROBLEM · Live trade feed disconnected
//     15:42 · High
//     What it means: we can't see trades early, so we'll win fewer races
//     What's happening: reconnecting automatically
//
//     ✅ FIXED · Live trade feed back (was down 38 s)
//
// Spam rules:
//   - Dedupe: the same problem (same key) is announced once, not every check.
//   - Cooldown: an unchanged problem that is still going on is repeated at
//     most once per cooldown (default 15 min) as "STILL A PROBLEM".
//   - Min duration: flappy things (a feed blip) must last a while before we
//     say anything. If it clears before that, nothing is sent at all.
//   - Rate limit: at most 10 alerts an hour. Extra ones are held back and
//     listed in ONE summary message when there is room again.
//   - Critical alerts (real money: failed live trade, loss cap hit, live
//     checks failed) skip the cooldown AND the rate limit. Always sent.
//
// Never blocks trading:
//   raise()/clear() only decide and put the message in a small queue. A
//   background loop sends it. A slow or dead Telegram just makes the queue
//   wait (each send gives up after 90 s); the queue is capped, so it can't
//   grow without limit. Nothing here throws back at the caller.
//
// REPORT_V2 (default 1): the new plain alerts. REPORT_V2=0 = the old messages,
// exactly as before, and none of the new alerts.
// ============================================================================

export type Severity = 'high' | 'medium' | 'low';

// What a problem looks like.
export interface AlertSpec {
  title: string;              // short headline, e.g. "Live trade feed disconnected"
  severity: Severity;
  meaning: string;            // what it means for trading / money, in plain words
  happening: string;          // what the bot is doing about it
  details?: string[];         // optional extra lines (trade name, tx hash...)
  critical?: boolean;         // real money: never held back by cooldown or rate limit
  minDurationMs?: number;     // must last this long before we alert (flap filter)
  cooldownMs?: number;        // repeat an unchanged problem at most this often
}

export interface AlertCenterOptions {
  send: (html: string) => Promise<void> | void;   // the Telegram sender
  now?: () => number;                             // clock (tests pass a fake one)
  cooldownMs?: number;                            // default repeat gap (15 min)
  maxPerHour?: number;                            // rate limit (10)
  queueMax?: number;                              // queue size cap (50)
  sendTimeoutMs?: number;                         // give up on one send after this (90 s)
  timeLabel?: (ms: number) => string;             // "15:42" (Toronto time by default)
  log?: (line: string) => void;                   // where to log problems with alerting itself
}

// Is the new reporting style on? REPORT_V2=0 (or "off") turns it off.
export function reportV2On(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.REPORT_V2 ?? '1').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

// Owner rule: no em dashes (or en dashes) anywhere in a message.
export function noDashes(s: string): string {
  return s.replace(/\s*[\u2014\u2013]\s*/g, ' - ');
}

// Escape the three characters Telegram's HTML mode cares about, and drop dashes.
export function escText(s: string | number): string {
  return noDashes(String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// "15:42" in Toronto time (where the owner is).
export function torontoTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', hour12: false });
}

// How long something lasted, in short plain words: "38 s", "4 min", "1 h 12 min".
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

const SEV_LABEL: Record<Severity, string> = { high: 'High', medium: 'Medium', low: 'Low' };

// Icon at the start: critical (real money) gets a stop sign.
function icon(spec: Pick<AlertSpec, 'severity' | 'critical'>): string {
  if (spec.critical) return '🛑';
  return spec.severity === 'high' ? '🚨' : spec.severity === 'medium' ? '⚠️' : 'ℹ️';
}

// The PROBLEM message. `word` is the headline word ("PROBLEM" or "STILL A PROBLEM"),
// `suffix` goes after the title (e.g. " (for 32 min)").
export function formatProblem(spec: AlertSpec, atMs: number, timeLabel: (ms: number) => string = torontoTime, word = 'PROBLEM', suffix = ''): string {
  return [
    `${icon(spec)} <b>${word}</b> · ${escText(spec.title)}${escText(suffix)}`,
    `${timeLabel(atMs)} · ${SEV_LABEL[spec.severity]}${spec.critical ? ' · real money' : ''}`,
    `What it means: ${escText(spec.meaning)}`,
    `What's happening: ${escText(spec.happening)}`,
    ...(spec.details ?? []).map((d) => escText(d)),
  ].join('\n');
}

// The FIXED message: "✅ FIXED · Live trade feed back (was down 38 s)".
export function formatFixed(text: string, lastedMs: number, word = 'lasted'): string {
  return `✅ <b>FIXED</b> · ${escText(text)} (${escText(word)} ${formatDuration(lastedMs)})`;
}

// A plain notice (not a problem): "ℹ️ NOTE · title" plus lines.
export function formatNote(title: string, lines: string[], atMs: number, timeLabel: (ms: number) => string = torontoTime, emoji = 'ℹ️', word = 'NOTE'): string {
  return [`${emoji} <b>${word}</b> · ${escText(title)}`, timeLabel(atMs), ...lines.map((l) => escText(l))].join('\n');
}

// ---------------------------------------------------------------------------
// The alert center
// ---------------------------------------------------------------------------

interface OpenProblem {
  since: number;        // when we first saw it (this time round)
  alerted: boolean;     // did the owner hear about it (sent, or listed in a summary)?
  lastSentAt: number;   // last time a message about it went out
  fingerprint: string;  // title + severity: a change here counts as a new problem
  spec: AlertSpec;
}

interface QueueItem { html: string; critical: boolean }

export type RaiseResult = 'sent' | 'waiting' | 'repeat' | 'cooldown' | 'held';

export class AlertCenter {
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private readonly maxPerHour: number;
  private readonly queueMax: number;
  private readonly sendTimeoutMs: number;
  private readonly timeLabel: (ms: number) => string;
  private readonly log: (line: string) => void;

  private open = new Map<string, OpenProblem>();
  private lastEventAt = new Map<string, number>();
  private sentTimes: number[] = [];       // non-critical sends in the last hour (rate limit)
  private held: string[] = [];            // headlines held back by the rate limit
  private queue: QueueItem[] = [];
  private draining = false;
  private timer: NodeJS.Timeout | null = null;

  // Counters (for logs / tests).
  sent = 0;
  heldCount = 0;
  dropped = 0;

  constructor(private readonly o: AlertCenterOptions) {
    this.now = o.now ?? Date.now;
    this.cooldownMs = o.cooldownMs ?? 15 * 60_000;
    this.maxPerHour = o.maxPerHour ?? 10;
    this.queueMax = o.queueMax ?? 50;
    this.sendTimeoutMs = o.sendTimeoutMs ?? 90_000;
    this.timeLabel = o.timeLabel ?? torontoTime;
    this.log = o.log ?? ((l) => console.warn(l));
  }

  // Background check every 30 s: sends the "held back" summary once there is
  // room again. Never keeps the process alive on its own.
  start(): this {
    if (this.timer) return this;
    this.timer = setInterval(() => { try { this.tick(); } catch { /* never throw from a timer */ } }, 30_000);
    this.timer.unref?.();
    return this;
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  // Is this problem currently open (seen and not cleared)?
  isOpen(key: string): boolean { return this.open.has(key); }

  // A problem is happening (call it every time you check, while it lasts).
  raise(key: string, spec: AlertSpec): RaiseResult {
    try {
      const now = this.now();
      const fp = `${spec.title}|${spec.severity}|${spec.critical ? 1 : 0}`;
      let p = this.open.get(key);
      if (!p) { p = { since: now, alerted: false, lastSentAt: 0, fingerprint: fp, spec }; this.open.set(key, p); }
      const changed = p.fingerprint !== fp;
      p.spec = spec;
      p.fingerprint = fp;
      // Flap filter: not long enough yet (critical alerts never wait).
      if (!p.alerted && !spec.critical && now - p.since < (spec.minDurationMs ?? 0)) return 'waiting';
      if (!p.alerted || changed) {
        p.alerted = true;
        p.lastSentAt = now;
        return this.deliver(formatProblem(spec, now, this.timeLabel), !!spec.critical, `PROBLEM: ${spec.title}`);
      }
      // Critical: every report goes out (the caller decides how often to report).
      if (spec.critical) { p.lastSentAt = now; return this.deliver(formatProblem(spec, now, this.timeLabel), true, `PROBLEM: ${spec.title}`); }
      // Same problem still going on: remind at most once per cooldown.
      if (now - p.lastSentAt < (spec.cooldownMs ?? this.cooldownMs)) return 'repeat';
      p.lastSentAt = now;
      return this.deliver(formatProblem(spec, now, this.timeLabel, 'STILL A PROBLEM', ` (for ${formatDuration(now - p.since)})`), false, `STILL A PROBLEM: ${spec.title}`);
    } catch (err) {
      this.log(`[alerts] raise failed: ${(err as Error).message}`);
      return 'held';
    }
  }

  // The problem is gone. Sends "FIXED" once, only if the owner heard about the
  // problem. A blip that never reached the min duration just disappears.
  // `word`: "was down" for feeds, "lasted" (default) for everything else.
  clear(key: string, fixedText: string, word = 'lasted'): 'sent' | 'held' | 'silent' | 'none' {
    try {
      const p = this.open.get(key);
      if (!p) return 'none';
      this.open.delete(key);
      if (!p.alerted) return 'silent';
      const r = this.deliver(formatFixed(fixedText, this.now() - p.since, word), !!p.spec.critical, `FIXED: ${fixedText}`);
      return r === 'held' ? 'held' : 'sent';
    } catch (err) {
      this.log(`[alerts] clear failed: ${(err as Error).message}`);
      return 'none';
    }
  }

  // A one-off event (a crash, a failed trade): no "FIXED" follows.
  // Repeats of the same key inside spec.cooldownMs are skipped (critical never is).
  event(key: string, spec: AlertSpec): RaiseResult {
    try {
      const now = this.now();
      if (!spec.critical) {
        const last = this.lastEventAt.get(key);
        if (last !== undefined && now - last < (spec.cooldownMs ?? 0)) return 'cooldown';
      }
      this.lastEventAt.set(key, now);
      this.trimEvents(now);
      return this.deliver(formatProblem(spec, now, this.timeLabel), !!spec.critical, `PROBLEM: ${spec.title}`);
    } catch (err) {
      this.log(`[alerts] event failed: ${(err as Error).message}`);
      return 'held';
    }
  }

  // A ready-made message (startup, safety alerts, info notes).
  // `onceKey` + `everyMs`: send it at most once per that period for that key.
  post(html: string, opts: { critical?: boolean; label?: string; onceKey?: string; everyMs?: number } = {}): RaiseResult {
    try {
      const now = this.now();
      if (opts.onceKey) {
        const last = this.lastEventAt.get(opts.onceKey);
        if (last !== undefined && now - last < (opts.everyMs ?? 24 * 3600_000)) return 'cooldown';
        this.lastEventAt.set(opts.onceKey, now);
        this.trimEvents(now);
      }
      return this.deliver(html, !!opts.critical, opts.label ?? firstLine(html));
    } catch (err) {
      this.log(`[alerts] post failed: ${(err as Error).message}`);
      return 'held';
    }
  }

  // Sends the "held back" summary when the rate limit has room again.
  tick(): void {
    if (!this.held.length) return;
    this.pruneRate(this.now());
    if (this.sentTimes.length >= this.maxPerHour) return;
    const n = this.held.length;
    const shown = this.held.slice(0, 10);
    const lines = [
      `${n} alert${n === 1 ? ' was' : 's were'} held back in the last hour to avoid spam:`,
      ...shown.map((h) => `• ${h}`),
      ...(n > shown.length ? [`• and ${n - shown.length} more`] : []),
      'Real-money alerts are never held back.',
    ];
    this.held = [];
    this.sentTimes.push(this.now());
    this.enqueue({ html: formatNote(`${n} more alert${n === 1 ? '' : 's'}`, lines, this.now(), this.timeLabel, '🔕', 'TOO MANY ALERTS'), critical: false });
  }

  // Waits until everything queued has been handed to the sender (tests).
  async flush(): Promise<void> {
    for (let i = 0; i < 1000 && (this.draining || this.queue.length); i++) await new Promise((r) => setTimeout(r, 1));
  }

  // ---- internals ------------------------------------------------------------

  // Rate limit, then queue. Critical skips the limit.
  private deliver(html: string, critical: boolean, label: string): RaiseResult {
    const now = this.now();
    if (!critical) {
      this.pruneRate(now);
      if (this.sentTimes.length >= this.maxPerHour) {
        this.held.push(noDashes(label));
        if (this.held.length > 200) this.held.splice(0, this.held.length - 200);
        this.heldCount++;
        return 'held';
      }
      this.sentTimes.push(now);
    }
    this.enqueue({ html, critical });
    return 'sent';
  }

  private pruneRate(now: number): void {
    while (this.sentTimes.length && now - this.sentTimes[0]! >= 3_600_000) this.sentTimes.shift();
  }

  // One-off keys are remembered for a day at most (keeps the map small).
  private trimEvents(now: number): void {
    if (this.lastEventAt.size < 500) return;
    for (const [k, t] of this.lastEventAt) if (now - t > 2 * 24 * 3600_000) this.lastEventAt.delete(k);
  }

  // Bounded queue: when full, the oldest non-critical message is dropped first.
  private enqueue(item: QueueItem): void {
    if (this.queue.length >= this.queueMax) {
      const i = this.queue.findIndex((q) => !q.critical);
      this.queue.splice(i >= 0 ? i : 0, 1);
      this.dropped++;
      this.log('[alerts] queue full (Telegram slow or down?): oldest alert dropped');
    }
    this.queue.push(item);
    void this.drain();
  }

  // Sends one message at a time in the background. Each send gives up after
  // sendTimeoutMs so a hung Telegram can't stall the queue forever.
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        try {
          let to: NodeJS.Timeout | undefined;
          const timeout = new Promise<void>((r) => { to = setTimeout(r, this.sendTimeoutMs); to.unref?.(); });
          await Promise.race([Promise.resolve().then(() => this.o.send(item.html)), timeout]);
          if (to) clearTimeout(to);
          this.sent++;
        } catch (err) {
          this.log(`[alerts] send failed: ${(err as Error)?.message ?? err}`);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

// First line of a message without tags, for the "held back" list.
function firstLine(html: string): string {
  return (html.split('\n')[0] ?? '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').slice(0, 80);
}
