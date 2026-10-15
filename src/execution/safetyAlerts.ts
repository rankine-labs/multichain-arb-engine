import { formatLossCapHit, formatLossCapWarning, formatLivePaused } from '../core/telegramFormatter';
import { formatProblem } from '../report/alerts';

// ============================================================================
// SAFETY ALERTS -- Telegram messages when live sending gets paused
//
// Plain English:
//   The safety gate (fastSender.ts) quietly stops live trades for several
//   reasons. Some only skip ONE trade (too big, coin not vetted, too many
//   sends this minute). Others stop ALL sending until someone acts or the day
//   ends. Those are the ones you need to hear about:
//     - daily loss cap reached (DAILY_LOSS_CAP_USD): paused until midnight UTC
//     - kill switch on (data/KILL file or KILL_SWITCH=on)
//     - a bad safety setting in .env (e.g. "5,000" instead of 5000)
//   Plus an early warning when 75% of the daily loss cap is used.
//
// No spam: each alert is sent at most ONCE per reason per day. The day is the
// UTC day, the same day the loss cap resets on.
// Only used in live mode (practice mode never loses money).
//
// Style: v2 = true (REPORT_V2, the default in shadowMain) uses the plain
// "PROBLEM / What it means / What's happening" style. v2 = false keeps the
// old messages word for word. Which alerts fire, and when, is the same.
// notify's 2nd argument says "real money, never hold back" (loss cap hit,
// live sending paused); the 75% warning is not critical.
// ============================================================================

export type PauseKind = 'loss-cap' | 'kill-switch' | 'bad-setting';

// Which "stops everything" reason a safety gate message is, if any.
// Per-trade reasons (size, allowlist, rate limit) return null: no alert.
export function pauseKindOf(reason: string): PauseKind | null {
  if (/daily loss cap/i.test(reason)) return 'loss-cap';
  if (/kill switch/i.test(reason)) return 'kill-switch';
  if (/bad safety setting/i.test(reason)) return 'bad-setting';
  return null;
}

// What to do about each pause, in plain words.
const FIX: Record<Exclude<PauseKind, 'loss-cap'>, string> = {
  'kill-switch': 'To resume: delete the data/KILL file and make sure KILL_SWITCH is not on in .env (restart if you changed .env).',
  'bad-setting': 'All live sends are blocked until the setting is fixed in .env and the bot is restarted.',
};

export class SafetyAlerts {
  private sentToday = new Set<string>();
  private day = '';

  constructor(
    private readonly notify: (html: string, critical?: boolean) => Promise<void> | void,
    private readonly capUsd: number,
    private readonly chain = 'robinhood',
    private readonly now: () => number = Date.now,
    private readonly v2 = false,
  ) {}

  // True the first time a key is seen today (then remembers it until tomorrow).
  private firstToday(key: string): boolean {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) { this.day = d; this.sentToday.clear(); }
    if (this.sentToday.has(key)) return false;
    this.sentToday.add(key);
    return true;
  }

  private send(html: string, critical = false) {
    try {
      const p = this.notify(html, critical);
      if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => { /* logged by sender */ });
    } catch { /* an alert problem must never affect trading */ }
  }

  // Cap reached: one alert per day, and no "75%" warning after it.
  private capHit(lostTodayUsd: number) {
    const first = this.firstToday('loss-cap');
    this.sentToday.add('loss-75');
    if (!first) return;
    if (!this.v2) return this.send(formatLossCapHit(this.chain, lostTodayUsd, this.capUsd), true);
    this.send(formatProblem({
      title: 'Daily loss cap hit, live trading paused', severity: 'high', critical: true,
      meaning: `we lost $${lostTodayUsd.toFixed(2)} today (cap $${this.capUsd.toFixed(2)}, counting trades still waiting for a receipt)`,
      happening: 'no real trades until midnight UTC, then it resumes on its own',
      details: ['To resume sooner: raise DAILY_LOSS_CAP_USD in .env and restart the bot.'],
    }, this.now()), true);
  }

  // Call after every loss is recorded, with today's total loss so far.
  onLoss(lostTodayUsd: number) {
    if (!(this.capUsd > 0)) return;
    if (lostTodayUsd >= this.capUsd) {
      this.capHit(lostTodayUsd);
    } else if (lostTodayUsd >= 0.75 * this.capUsd) {
      if (this.firstToday('loss-75')) {
        // Critical (review fix): real money, never held back by the rate limit.
        this.send(!this.v2 ? formatLossCapWarning(this.chain, lostTodayUsd, this.capUsd) : formatProblem({
          title: '75% of the daily loss cap used', severity: 'high', critical: true,
          meaning: `we lost $${lostTodayUsd.toFixed(2)} of the $${this.capUsd.toFixed(2)} allowed today (gas on lost races plus any losing trades)`,
          happening: `still trading; real trades stop for the day at $${this.capUsd.toFixed(2)}`,
        }, this.now()), true);
      }
    }
  }

  // Call when the safety gate stops a LIVE trade, with its reason.
  // lostTodayUsd: loss so far including trades still waiting for a receipt
  // (that's what the gate compares against the cap).
  onBlocked(reason: string, lostTodayUsd: number) {
    const kind = pauseKindOf(reason);
    if (!kind) return;
    if (kind === 'loss-cap') {
      this.capHit(lostTodayUsd);
      return;
    }
    if (!this.firstToday(kind)) return;
    this.send(!this.v2 ? formatLivePaused(this.chain, reason, FIX[kind]) : formatProblem({
      title: kind === 'kill-switch' ? 'Kill switch on, live trading paused' : 'Bad safety setting, live trading paused',
      severity: 'high', critical: true,
      meaning: 'no real trades are being sent',
      happening: FIX[kind],
      details: [`Reason: ${reason}`],
    }, this.now()), true);
  }
}
