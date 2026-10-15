import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { AlertCenter, AlertSpec, reportV2On, torontoTime, escText, formatNote } from './alerts';
import { AlertWatch, WatchSources } from './alertWatch';

// ============================================================================
// ALERT HOOKS -- the small plug points shadowMain calls
//
// Plain English:
//   shadowMain calls one of these at each place an alert used to be sent (or
//   should be). With REPORT_V2=0 every hook sends exactly the old message (or
//   nothing, where there was none) so the old behaviour is kept. With
//   REPORT_V2 on (default) the message goes through the alert center in the
//   new plain style.
//
//   Also here: "why did the bot restart?" On exit the bot writes
//   data/last-exit.json (time, exit code, signal). While running it writes
//   data/alert-state.json every minute (mode, last seen alive). At startup:
//     - exit file newer than the last heartbeat + a signal = stopped normally
//       (deploy or pm2 restart)
//     - exit file with a non-zero code = crashed
//     - no exit file = stopped without warning (crash, out of memory, reboot)
//   Mode (practice / live) is compared with the saved one: a change gets its
//   own message.
//
// Nothing here can block or break trading: every hook is wrapped, and sends
// are queued in the background.
// ============================================================================

type Send = (html: string) => Promise<void> | void;
export type Mode = 'practice' | 'live';

export interface HooksOptions {
  send: Send;
  v2?: boolean;                       // default: REPORT_V2 (on unless 0)
  dataDir?: string;                   // default 'data'
  now?: () => number;
  center?: AlertCenter;               // tests pass their own
  modeReadyWaitMs?: number;           // live: wait this long for the first live check result (3 min)
}

interface SavedState { mode?: Mode; aliveAt?: number }
interface SavedExit { at?: number; code?: number; signal?: string }

const modeLabel = (m: Mode) => (m === 'live' ? 'Live (real money)' : 'Practice (no real money)');

// Why the last run ended, in plain words (null = unknown, e.g. first run).
export function restartReason(state: SavedState | null, exit: SavedExit | null, timeLabel: (ms: number) => string = torontoTime): string | null {
  const alive = state?.aliveAt ?? 0;
  if (exit && (exit.at ?? 0) >= alive - 2_000) {
    if (exit.signal) return `stopped normally (deploy or pm2 restart, ${exit.signal})`;
    if (!exit.code) return 'stopped normally';
    return `crashed (exit code ${exit.code})`;
  }
  if (state && alive > 0) return `stopped without warning (crash, out of memory or server reboot). Last seen running at ${timeLabel(alive)}`;
  return null;
}

export class AlertHooks {
  readonly v2: boolean;
  readonly center: AlertCenter;
  watch: AlertWatch | null = null;
  private readonly send: Send;
  private readonly dir: string;
  private readonly now: () => number;
  private mode: Mode = 'practice';
  private pendingModeChange: { from: Mode; to: Mode; at: number } | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private lastSignal: string | undefined;
  // Saved files as they were BEFORE this run wrote anything (read once by
  // installExitRecorder, used by startup). undefined = not read yet.
  private savedState: SavedState | null | undefined;
  private savedExit: SavedExit | null | undefined;
  // The heartbeat only writes once startup() has read the old state and set
  // the real mode (review fix: it used to overwrite the file first).
  private started = false;
  // Last live check result seen (so a mode change after startup can say it).
  private liveChecks: string | null = null;
  // "Live trade could not be sent": one entry per kind of error (bounded).
  private sendFails = new Map<string, { windowStart: number; extra: number; lastLabel: string; lastError: string; timer: NodeJS.Timeout | null }>();
  static SEND_FAIL_WINDOW_MS = 5 * 60_000;
  static SEND_FAIL_KINDS_MAX = 50;

  constructor(o: HooksOptions) {
    this.send = o.send;
    this.v2 = o.v2 ?? reportV2On();
    this.dir = o.dataDir ?? 'data';
    this.now = o.now ?? Date.now;
    this.center = o.center ?? new AlertCenter({ send: o.send, now: this.now });
    this.modeReadyWaitMs = o.modeReadyWaitMs ?? 3 * 60_000;
  }
  private readonly modeReadyWaitMs: number;

  // Old-style direct send (REPORT_V2=0), never throws or blocks.
  private sendOld(html: string): void {
    try {
      const p = this.send(html);
      if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => { /* logged by sender */ });
    } catch { /* reporting only */ }
  }

  private guard(f: () => void): void { try { f(); } catch (err) { console.warn(`[alerts] hook failed: ${(err as Error)?.message ?? err}`); } }

  // ---- Live money alerts ---------------------------------------------------

  // SafetyAlerts (loss cap, kill switch, bad setting, 75% warning).
  // SafetyAlerts already formats the right style and sends each reason once a day.
  safetyNotify(html: string, critical = false): void {
    this.guard(() => { if (!this.v2) this.sendOld(html); else this.center.post(html, { critical }); });
  }

  // The live trade tracker's own messages (TRADE WON / REVERTED / DROPPED).
  // With REPORT_V2 the REVERTED one is replaced by onLiveResult's plain alert.
  liveTrackerNotify(html: string): void {
    this.guard(() => {
      if (!this.v2) return this.sendOld(html);
      if (html.includes('<b>TRADE REVERTED</b>')) return;
      this.center.post(html, { critical: true, label: firstWords(html) });
    });
  }

  // Every live trade result. A revert = trade failed on-chain: critical, each one.
  onLiveResult(r: { status: string; label: string; gasUsd: number; hash: string }): void {
    this.guard(() => {
      if (!this.v2 || r.status !== 'reverted') return;
      this.center.event(`live-fail:${r.hash}`, {
        title: 'Live trade failed on-chain', severity: 'high', critical: true,
        meaning: `we paid $${r.gasUsd.toFixed(2)} gas but the trade did not go through (someone was faster or the price moved)`,
        happening: 'nothing to do; this happens now and then. The daily loss cap stops sending if it adds up',
        details: [`Trade: ${r.label}`, `Tx: ${r.hash}`],
      });
    });
  }

  // A live trade could not even be sent (node refused it, network error).
  // Review fix (no flood): one alert per KIND of error. The first failure of
  // a kind is sent right away (critical). More of the same kind within 5 min
  // are counted and sent as ONE "N more in 5 min" message at the end of the
  // 5 minutes (also critical, so never held back). A quiet 5 minutes ends it.
  liveSendFailed(label: string, error: string): void {
    this.guard(() => {
      if (!this.v2) return;
      const kind = errorKind(error);
      const now = this.now();
      const s = this.sendFails.get(kind);
      if (s) { s.extra++; s.lastLabel = label; s.lastError = String(error).slice(0, 160); return; }
      // Bounded: forget the oldest kind that has nothing waiting.
      if (this.sendFails.size >= AlertHooks.SEND_FAIL_KINDS_MAX) {
        for (const [k, v] of this.sendFails) if (!v.extra) { if (v.timer) clearTimeout(v.timer); this.sendFails.delete(k); break; }
      }
      const entry = { windowStart: now, extra: 0, lastLabel: label, lastError: String(error).slice(0, 160), timer: null as NodeJS.Timeout | null };
      this.sendFails.set(kind, entry);
      this.center.event(`live-send-fail:${kind}`, {
        title: 'Live trade could not be sent', severity: 'high', critical: true,
        meaning: 'a real trade was ready but the node did not accept it, so nothing was traded (no cost)',
        happening: 'the bot keeps going and tries the next chance normally. More of the same error in the next 5 min come as one message',
        details: [`Trade: ${label}`, `Error: ${String(error).slice(0, 160)}`],
      });
      this.armSendFailTimer(kind);
    });
  }

  // End of a 5 minute window for one kind of send error: one roll-up message
  // if more came in (and keep watching), otherwise forget the kind.
  private armSendFailTimer(kind: string): void {
    const e = this.sendFails.get(kind);
    if (!e) return;
    e.timer = setTimeout(() => this.guard(() => this.flushSendFails(kind)), AlertHooks.SEND_FAIL_WINDOW_MS);
    e.timer.unref?.();
  }

  // Exposed for tests (the timer calls it).
  flushSendFails(kind: string): void {
    const e = this.sendFails.get(kind);
    if (!e) return;
    if (!e.extra) { this.sendFails.delete(kind); return; }
    const n = e.extra;
    e.extra = 0; e.windowStart = this.now();
    this.center.post(formatNote(`Live trade could not be sent: ${n} more in 5 min`, [
      `Same error: ${e.lastError}`,
      `Last trade: ${e.lastLabel}`,
      'Nothing was traded (no cost). Still watching; the next roll-up comes in 5 min if it keeps happening.',
    ], this.now(), torontoTime, '🛑', 'STILL FAILING'), { critical: true, label: 'Live trade could not be sent (roll-up)' });
    this.armSendFailTimer(kind);
  }

  // Readiness checks before real sends failed (retried every 5 min).
  liveChecksFailed(problems: string[]): void {
    this.guard(() => {
      if (!this.v2) {
        this.sendOld(`🛑 <b>LIVE CHECKS FAILED</b> · sends blocked\n${problems.map((p) => '• ' + p.replace(/[<>&]/g, '')).join('\n')}`);
        return;
      }
      this.center.raise('live-checks', {
        title: 'Live checks failed, real trades blocked', severity: 'high', critical: true,
        meaning: 'the bot will NOT send real trades until these are fixed',
        happening: 'checking again every 5 min',
        details: problems.map((p) => `• ${p}`),
      });
      this.liveChecks = `live checks FAILED: ${problems.join('; ')}`;
      this.resolveModeChange(this.liveChecks);
    });
  }

  liveChecksPassed(): void {
    this.guard(() => {
      if (!this.v2) return;
      this.center.clear('live-checks', 'Live checks passed, real trades allowed');
      this.liveChecks = 'live checks passed, ready to send real trades';
      this.resolveModeChange(this.liveChecks);
    });
  }

  // Bot wallet can't pay gas for a trade at the gas cap.
  lowGas(msg: string): void {
    this.guard(() => {
      if (!this.v2) return this.sendOld(`⚠️ <b>LOW GAS</b> · ${msg}`);
      this.center.raise('low-gas', {
        title: 'Bot wallet low on gas', severity: 'high', critical: true,
        meaning: "real trades will fail or be skipped if the wallet can't pay gas",
        happening: 'add ETH to the bot wallet (checked again at the next restart)',
        details: [msg],
      });
    });
  }

  // ---- Startup / restart / mode -------------------------------------------

  // Call once when the bot is up. `oldMessage` = the old startup text (REPORT_V2=0).
  startup(oldMessage: () => string, chains: Record<string, { online: boolean }>, live: boolean): void {
    this.guard(() => {
      this.mode = live ? 'live' : 'practice';
      if (!this.v2) { this.sendOld(oldMessage()); return; }
      // The files as they were before this run touched them.
      const state = this.savedState !== undefined ? this.savedState : this.read<SavedState>('alert-state.json');
      const exit = this.savedExit !== undefined ? this.savedExit : this.read<SavedExit>('last-exit.json');
      const now = this.now();
      const why = restartReason(state, exit);
      const feeds = Object.entries(chains).map(([c, s]) => `${s.online ? '✅' : '❌'} ${c.charAt(0).toUpperCase()}${c.slice(1)}`).join('  ');
      this.center.post([
        `🔄 <b>Bot restarted at ${torontoTime(now)}.</b> ${live ? 'Live mode (real money).' : 'Practice mode.'}`,
        ...(why ? [`Why: ${escText(why)}`] : []),
        ...(feeds ? [`Feeds: ${escText(feeds)}`] : []),
      ].join('\n'), { label: 'Bot restarted' });
      // Mode change since the last run?
      if (state?.mode && state.mode !== this.mode) {
        this.pendingModeChange = { from: state.mode, to: this.mode, at: now };
        if (this.mode === 'practice') this.resolveModeChange('no real trades will be sent');
        // Live checks may already have finished before startup: say the result.
        else if (this.liveChecks) this.resolveModeChange(this.liveChecks);
        else setTimeout(() => this.resolveModeChange('live checks have not finished yet (a separate alert follows if they fail)'), this.modeReadyWaitMs).unref?.();
      }
      this.started = true;
      this.saveState();
      try { if (exit) unlinkSync(join(this.dir, 'last-exit.json')); } catch { /* fine */ }
    });
  }

  // Sends the mode change message once, with readiness.
  private resolveModeChange(readiness: string): void {
    const m = this.pendingModeChange;
    if (!m) return;
    this.pendingModeChange = null;
    this.center.post(formatNote(`Mode changed: ${m.from === 'live' ? 'Live' : 'Practice'} to ${m.to === 'live' ? 'Live' : 'Practice'}`, [
      `Was: ${modeLabel(m.from)}`,
      `Now: ${modeLabel(m.to)}`,
      `Since: ${torontoTime(m.at)}`,
      `Readiness: ${readiness}`,
    ], this.now(), torontoTime, '🔁', 'MODE CHANGE'), { critical: true, label: 'MODE CHANGE' });
  }

  // Remember mode + "alive" every minute, and record how the process exits.
  // Only called by the real bot (tests don't touch process signals).
  installExitRecorder(): void {
    this.guard(() => {
      if (!this.v2) return;
      // Read what the LAST run left BEFORE anything is written (review fix:
      // startup() runs minutes later and must see the old mode / alive time).
      this.savedState = this.read<SavedState>('alert-state.json');
      this.savedExit = this.read<SavedExit>('last-exit.json');
      // Writes nothing until startup() has run (see saveState).
      this.heartbeat = setInterval(() => this.saveState(), 60_000);
      this.heartbeat.unref?.();
      for (const sig of ['SIGINT', 'SIGTERM'] as const) process.prependListener(sig, () => { this.lastSignal = sig; });
      process.on('exit', (code) => {
        try { this.write('last-exit.json', { at: Date.now(), code, signal: this.lastSignal }); } catch { /* best effort */ }
      });
    });
  }

  // Starts the rule checks (feeds, memory, freezes...). REPORT_V2 only.
  startWatch(sources: WatchSources): AlertWatch | null {
    if (!this.v2) return null;
    try {
      this.watch = new AlertWatch(this.center, sources, { now: this.now }).start();
      this.center.start();
    } catch (err) { console.warn(`[alerts] watch failed to start: ${(err as Error)?.message ?? err}`); }
    return this.watch;
  }

  onFreeze(ms: number, job?: string | null): void { this.watch?.onFreeze(ms, job); }
  onLoopWarn(line: string): void { this.watch?.onLoopWarn(line); }

  // Generic: raise / clear from anywhere (REPORT_V2 only).
  raise(key: string, spec: AlertSpec): void { this.guard(() => { if (this.v2) this.center.raise(key, spec); }); }
  clear(key: string, text: string, word?: string): void { this.guard(() => { if (this.v2) this.center.clear(key, text, word); }); }

  // ---- small file helpers --------------------------------------------------
  private saveState(): void {
    if (!this.started) return; // never overwrite the last run's state before startup() read it
    try { this.write('alert-state.json', { mode: this.mode, aliveAt: this.now() }); } catch { /* best effort */ }
  }
  private write(name: string, obj: unknown): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, name), JSON.stringify(obj));
  }
  private read<T>(name: string): T | null {
    try { return JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as T; } catch { return null; }
  }
}

// The kind of a send error, so the same problem is one alert: numbers, hex
// and quoted parts removed, first 60 characters.
export function errorKind(error: string): string {
  return String(error ?? '').toLowerCase().replace(/0x[0-9a-f]+/g, '0x').replace(/"[^"]*"|'[^']*'/g, '""')
    .replace(/\d+(\.\d+)?/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 60) || 'unknown';
}

function firstWords(html: string): string {
  return (html.split('\n')[0] ?? '').replace(/<[^>]+>/g, '').slice(0, 80);
}
