import { promises as fsp, existsSync, statSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { LocalSimClient, LocalSimClientOptions, LocalSimMode, localSimMode, makeLocalRpc, SidecarAnswer, SidecarTiming, insideMs, LOCAL_UNKNOWN_PREFIX } from './localSim';
import { simulateRoundTrip, SimResult, SIM_EXECUTOR_ADDRESS } from './simulator';
import type { ExecutorHop } from './executorCalldata';
import { classifySimOutcome, isTradeVerdict } from '../core/failReasons';
import type { PoolState } from '../core/types';
import { Copy2Link, Copy2Route, copy2Settings } from './copy2';

// ============================================================================
// FAST CHECK HOST: runs the local simulator ("arbsim" sidecar) inside the bot
//
// Plain English:
//   arbsim is a small program next to the bot that keeps its own copy of
//   Robinhood Chain and answers "what would this trade do?" in about a
//   millisecond. This file is the bot's side of running it day to day:
//
//     - connects to it (it is started by pm2, never by the bot) and, if it
//       isn't there, just says so once a minute; the bot then uses the node
//       for everything, exactly as before
//     - passes it every raw message from the Robinhood live trade feed, so
//       its copy of the chain stays current (one quick hand-off, no waiting)
//     - tells it which accounts to keep ready (our pools, their coins,
//       routers, lenders, our contract), on connect and every 10 minutes
//     - asks it the SAME check the bot asks the node, and writes both answers
//       side by side to data/local-sim-shadow.jsonl, plus an hourly line:
//       "Fast check (practice): N checks, same answer X%, unknown Y%,
//        median Z ms vs node W ms"
//
//   Switch: LOCAL_SIM in .env
//     off (default)  nothing at all: no connection, no extra work
//     shadow         practice: the node still decides everything; the fast
//                    check only runs alongside and is compared
//     on             the fast check decides when it is SURE; when it isn't,
//                    the node decides as today. Needs LOCAL_SIM_CONFIRM=
//                    yes-fast-check as well (like LIVE_SEND_CONFIRM), else
//                    it stays in practice and says why.
//   Automatic step back (on -> practice for 6 hours, Telegram alert):
//     - 1 in 10 fast decisions is re-checked with the node afterwards; if more
//       than 2% of the last 200 re-checks disagree (counted over at least 50,
//       so 2 early disagreements are enough), or
//     - the sidecar reports new "replay mismatches" (its copy of the chain
//       drifted from the real chain).
//
//   Safety: any problem in here is caught and counted, never thrown. Nothing
//   here can send a transaction. It never holds keys.
// ============================================================================

// A trade check, in the shape the simulator takes.
export type LocalTrade = { token: string; amountIn: bigint; hops: ExecutorHop[] };
export type LocalSimOpts = { v3Lender?: string; weth?: string };

// What kind of check it is (for the log and the counters).
//   gap         a sitting gap (standing price difference), checked on the newest state
//   trig        practice "follow a trade" check, right after the trade we follow
//   trig_live   the live "follow a trade" check (check-first, before sending)
//   loop_live   the live loop check (3+ pools, execution/loopLive.ts)
export type LocalKind = 'gap' | 'trig' | 'trig_live' | 'loop_live';

export type LocalQuestion = {
  kind: LocalKind;
  trade: LocalTrade;
  simOpts: LocalSimOpts;
  // Which state to ask about, when the caller knows better (copy 2: "right
  // after block N", the newest block whose pool reports were passed on).
  // Left out: right after the trigger (follow-a-trade) or the newest state.
  at?: Record<string, unknown>;
  triggerHash?: string;     // follow-a-trade: ask "right after this transaction"
  seenMs?: number;          // when the bot saw the trigger in the feed (for timing)
  label?: string;           // short pair/route name for the log
};

// A verdict reduced to what can be compared between the two answers.
export type Verdict = 'profit' | 'loss' | 'fail' | 'unknown';

export type LocalOutcome = {
  sure: boolean;            // true = a real trade verdict the bot may act on
  sim: SimResult;           // the simulator's answer (same shape as a node check)
  verdict: Verdict;
  why?: string;             // unknown: why the sidecar couldn't be sure
  gasUsed?: bigint;         // gas our call used, as the sidecar measured it
  requestMs: number;        // when the question was sent (clock ms)
  answerMs: number;         // when the answer came back (clock ms)
};

// Simulator answer -> verdict. Only answers about the TRADE count as sure:
// profit, loss, or a refusal with a real reason. "No reason", "can't check
// this coin", "local sim unknown", busy nodes: unknown.
export function verdictOf(r: SimResult | null | undefined): Verdict {
  if (!r) return 'unknown';
  if (r.status === 'profit') return 'profit';
  if (r.status === 'loss') return 'loss';
  if (r.status === 'fail') {
    if (r.reason.startsWith(LOCAL_UNKNOWN_PREFIX)) return 'unknown';
    const b = r.bucket ?? classifySimOutcome('fail', r.reason);
    return isTradeVerdict(b) ? 'fail' : 'unknown';
  }
  return 'unknown';
}

// The "why" inside a local-unknown marker ("miss", "timeout", ...).
function unknownWhy(r: SimResult): string {
  if ('reason' in r) {
    const m = /local sim unknown: ([a-z0-9_]+)/.exec(r.reason);
    if (m) return m[1];
    return r.status === 'fail' ? 'no_clear_reason' : r.status;
  }
  return r.status;
}

// ----------------------------------------------------------------------------
// Settings (all from .env; defaults in brackets)
// ----------------------------------------------------------------------------
export type HostSettings = {
  configured: LocalSimMode;          // LOCAL_SIM [off]
  confirmed: boolean;                // LOCAL_SIM_CONFIRM=yes-fast-check
  socketPath: string;                // ARBSIM_SOCKET [/tmp/arbsim.sock]
  timeoutMs: number;                 // LOCAL_SIM_TIMEOUT_MS [60] per question
  deadlineMs: number;                // LOCAL_SIM_DEADLINE_MS [120] whole check
  sampleEvery: number;               // LOCAL_SIM_SAMPLE_EVERY [10] re-check 1 in N fast decisions
  sizeSearch: boolean;               // LOCAL_SIM_SIZE_SEARCH [on] (on mode only)
  maxNewMismatch: number;            // LOCAL_SIM_MAX_NEW_MISMATCH [0] per status poll
  logFile: string;                   // LOCAL_SIM_LOG [data/local-sim-shadow.jsonl]
  maxLogBytes: number;               // LOCAL_SIM_LOG_MAX_BYTES [2 MB]
};

export const LOCAL_SIM_CONFIRM_WORD = 'yes-fast-check';

export function hostSettings(env: Record<string, string | undefined> = process.env): HostSettings {
  const num = (k: string, d: number) => { const v = Number(env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
  return {
    configured: localSimMode(env),
    confirmed: (env.LOCAL_SIM_CONFIRM ?? '').trim() === LOCAL_SIM_CONFIRM_WORD,
    socketPath: env.ARBSIM_SOCKET || '/tmp/arbsim.sock',
    timeoutMs: num('LOCAL_SIM_TIMEOUT_MS', 60),
    deadlineMs: num('LOCAL_SIM_DEADLINE_MS', 120),
    sampleEvery: Math.max(1, Math.round(num('LOCAL_SIM_SAMPLE_EVERY', 10))),
    sizeSearch: env.LOCAL_SIM_SIZE_SEARCH !== '0',
    maxNewMismatch: Number.isFinite(Number(env.LOCAL_SIM_MAX_NEW_MISMATCH)) ? Math.max(0, Number(env.LOCAL_SIM_MAX_NEW_MISMATCH ?? 0)) : 0,
    logFile: env.LOCAL_SIM_LOG || 'data/local-sim-shadow.jsonl',
    maxLogBytes: num('LOCAL_SIM_LOG_MAX_BYTES', 2_000_000),
  };
}

// ----------------------------------------------------------------------------
// Size-capped JSONL log, written in the background (never blocks the bot).
// Lines are collected in memory and appended every couple of seconds. When
// the file passes maxBytes it is renamed to <file>.1 (the old .1 is replaced)
// and a new file starts, so it can never fill the disk.
// ----------------------------------------------------------------------------
export class JsonlLog {
  private buf: string[] = [];
  private size = -1;            // bytes in the file now (-1 = not read yet)
  private writing: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  dropped = 0;

  constructor(readonly file: string, private readonly maxBytes: number, flushEveryMs = 2_000, private readonly maxBuffered = 2_000) {
    if (flushEveryMs > 0) {
      this.timer = setInterval(() => { void this.flush(); }, flushEveryMs);
      this.timer.unref?.();
    }
  }

  add(rec: Record<string, unknown>): void {
    try {
      if (this.buf.length >= this.maxBuffered) { this.dropped++; return; }
      this.buf.push(JSON.stringify(rec, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    } catch { this.dropped++; }
  }

  // Write what's waiting (one write at a time, in order).
  flush(): Promise<void> {
    if (!this.buf.length) return this.writing;
    const lines = this.buf;
    this.buf = [];
    this.writing = this.writing.then(async () => {
      try {
        if (this.size < 0) {
          const dir = dirname(this.file);
          if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
          this.size = existsSync(this.file) ? statSync(this.file).size : 0;
        }
        const text = lines.join('\n') + '\n';
        if (this.size > 0 && this.size + Buffer.byteLength(text) > this.maxBytes) {
          await fsp.rename(this.file, this.file + '.1').catch(() => undefined);
          this.size = 0;
        }
        await fsp.appendFile(this.file, text);
        this.size += Buffer.byteLength(text);
      } catch {
        this.dropped += lines.length; // a full disk etc. must never stop the bot
      }
    });
    return this.writing;
  }

  stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.flush();
  }
}

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
};
const p90 = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * 0.9))];
};
const pct = (n: number, d: number): string => (d ? `${Math.round((100 * n) / d)}%` : 'n/a');
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const short = (h?: string) => (h ? h.slice(0, 12) : undefined);
const profitOf = (r: SimResult | null | undefined): bigint | undefined => (r && r.status === 'profit' ? r.profit : undefined);

// One check in flight: the local answer, and later the node's answer.
export class LocalCheck {
  readonly result: Promise<LocalOutcome>;
  local: LocalOutcome | null = null;
  // The last question sent to the sidecar for OUR contract call (for the size search).
  lastSent: Record<string, unknown> | null = null;
  // Timing of the sidecar's reply to OUR contract call (sure or not):
  // inside = arbsim's own time incl. its queue (ms), rt = round trip the
  // bot measured (ms), t = arbsim's split (microseconds). For the log.
  sidecar: { inside?: number; rt?: number; t?: SidecarTiming } | null = null;
  decidedByLocal = false;   // on mode: the fast check made the decision
  sampled = false;          // on mode: this decision is re-checked with the node
  private node: { sim: SimResult | null; startMs: number; endMs: number; where?: string } | null = null;
  private closed = false;   // record written
  private nodeExpected = true;
  readonly startedMs: number;

  constructor(
    private readonly host: LocalSimHost,
    readonly q: LocalQuestion,
    run: (c: LocalCheck) => Promise<LocalOutcome>,
    readonly record: boolean, // false = sidecar down: counted, not written
  ) {
    this.startedMs = host.now();
    this.result = run(this).then((o) => { this.local = o; this.maybeClose(); return o; });
  }

  // The node's answer to the same question (or null = node couldn't run it).
  // startMs: when the node check started.
  nodeDone(sim: SimResult | null, startMs: number, where?: string): void {
    try {
      if (this.node || this.closed) return;
      this.node = { sim, startMs, endMs: this.host.now(), where };
      this.maybeClose();
    } catch { /* never breaks the caller */ }
  }

  // No node answer will come (on mode, not sampled; or the check stopped early).
  noNode(): void { this.nodeExpected = false; this.maybeClose(); }

  // Called by the sweeper: give up waiting for the node.
  expire(): void { if (!this.closed) { this.nodeExpected = false; this.maybeClose(true); } }

  isClosed(): boolean { return this.closed; }

  private maybeClose(force = false): void {
    if (this.closed) return;
    if (!this.local && !force) return;
    if (!this.node && this.nodeExpected && !force) return;
    this.closed = true;
    this.host.finish(this, this.node);
  }
}

// ----------------------------------------------------------------------------
// The host
// ----------------------------------------------------------------------------
export type LocalSimHostOptions = {
  env?: Record<string, string | undefined>;
  log?: (msg: string) => void;
  alert?: (text: string) => void;                       // Telegram (plain text)
  warmSource?: () => string[];                          // accounts to keep ready
  now?: () => number;
  client?: LocalSimClient;                              // tests pass their own
  clientOptions?: LocalSimClientOptions;
  warmEveryMs?: number;                                 // default 10 min
  statusEveryMs?: number;                               // default 60 s
  logFlushMs?: number;                                  // default 2 s
  // COPY 2 (execution/copy2.ts): the watched Robinhood pools and the V4
  // PoolManager. Left out = no copy 2 (the host works exactly as before).
  copy2Pools?: () => Iterable<PoolState | undefined>;
  poolManager?: string;
  copy2Link?: Copy2Link;                                // tests pass their own
};

export class LocalSimHost {
  readonly settings: HostSettings;
  readonly client: LocalSimClient;
  readonly shadowLog: JsonlLog;
  readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly alert: (text: string) => void;
  private readonly warmSource: () => string[];
  private timers: NodeJS.Timeout[] = [];
  private open = new Set<LocalCheck>();
  private triggerSeen = new Map<string, number>();
  private autoOffUntil = 0;
  private autoOffWhy = '';
  private onDecisions = 0;
  private samples: boolean[] = [];   // true = re-check agreed
  private lastMismatch: number | null = null;
  private lastStatus: Record<string, unknown> | null = null;
  private notReachableLoggedMs = 0;
  private shadowReasonLogged = false;
  // COPY 2 (execution/copy2.ts). null = not used (old behaviour).
  copy2: Copy2Link | null = null;

  // Hourly counters (taken by takeHourLine).
  private hour = this.freshHour();
  private lateSeen = 0;
  private freshHour() {
    return {
      checks: 0, compared: 0, same: 0, unknown: 0, down: 0, errors: 0,
      decidedLocal: 0, decidedNode: 0, sampleChecks: 0, sampleSame: 0,
      localMs: [] as number[], nodeMs: [] as number[], seenToAnswerMs: [] as number[],
      // arbsim's own time for our contract call (ms, its queue included).
      insideMs: [] as number[],
      unknownWhy: {} as Record<string, number>,
      mismatchNew: 0, autoOffs: 0,
      // Copy 2 only (checks asked about a copy-2 block, at:{block}): the
      // fast check's answer against the node's, so practice mode
      // (LOCAL_SIM=shadow) shows how accurate copy 2 is before it decides.
      //   same / different: both sure, verdicts agree / disagree
      //   unknown: the fast check wasn't sure (the node answered)
      //   noNode: the node gave no usable answer (not compared)
      c2: { checks: 0, same: 0, different: 0, unknown: 0, noNode: 0 },
    };
  }

  constructor(opts: LocalSimHostOptions = {}) {
    this.settings = hostSettings(opts.env ?? process.env);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(m));
    this.alert = opts.alert ?? (() => {});
    this.warmSource = opts.warmSource ?? (() => []);
    // The client's own messages: "retrying" lines at most once a minute.
    const clientLog = (m: string) => {
      if (/retrying|not reachable|connection lost/.test(m)) {
        if (this.now() - this.notReachableLoggedMs < 60_000) return;
        this.notReachableLoggedMs = this.now();
        this.log(`${m} (fast check unavailable, every check uses the node)`);
        return;
      }
      this.log(m);
    };
    this.client = opts.client ?? new LocalSimClient({
      socketPath: this.settings.socketPath, timeoutMs: this.settings.timeoutMs, log: clientLog,
      onConnect: () => { void this.sendWarm(); try { this.copy2?.onClientConnect(); } catch { /* never breaks the connection */ } },
      ...(opts.clientOptions ?? {}),
    });
    // COPY 2: only when the bot hands over its watched pools and it isn't
    // switched off (LOCAL_SIM_COPY2=off). Does nothing until the fast check
    // says it runs in pool-events mode.
    const c2 = copy2Settings(opts.env ?? process.env);
    if (opts.copy2Link) this.copy2 = opts.copy2Link;
    else if (opts.copy2Pools && c2.mode !== 'off') {
      this.copy2 = new Copy2Link({ client: this.client, settings: c2, pools: opts.copy2Pools, poolManager: opts.poolManager ?? '', now: this.now, log: (m) => this.log(m) });
    }
    if (this.copy2 && this.client.isConnected()) this.copy2.onClientConnect();
    this.shadowLog = new JsonlLog(this.settings.logFile, this.settings.maxLogBytes, opts.logFlushMs ?? 2_000);
    const every = (fn: () => void, ms: number) => { const t = setInterval(() => { try { fn(); } catch { /* never throws */ } }, ms); t.unref?.(); this.timers.push(t); };
    every(() => { void this.sendWarm(); }, opts.warmEveryMs ?? 10 * 60_000);
    every(() => { void this.pollStatus(); }, opts.statusEveryMs ?? 60_000);
    every(() => this.sweep(), 15_000);
    if (this.settings.configured === 'on' && !this.settings.confirmed) {
      this.log(`[local-sim] LOCAL_SIM=on but LOCAL_SIM_CONFIRM is not "${LOCAL_SIM_CONFIRM_WORD}": staying in practice (shadow), the node decides`);
      this.shadowReasonLogged = true;
    }
    this.log(`[local-sim] fast check ${this.modeText()} (socket ${this.settings.socketPath})`);
  }

  // ---- mode ---------------------------------------------------------------
  // Does the fast check decide right now? (on + confirmed + not stepped back)
  isOn(): boolean {
    if (this.settings.configured !== 'on' || !this.settings.confirmed) return false;
    if (this.autoOffUntil && this.now() < this.autoOffUntil) return false;
    if (this.autoOffUntil) {
      this.autoOffUntil = 0;
      this.samples = [];
      this.log('[local-sim] 6 h practice period over: fast check deciding again');
      this.safeAlert('⚡ FAST CHECK back ON (the 6 h practice period after the automatic step back is over)');
    }
    return true;
  }
  modeText(): string {
    if (this.isOn()) return 'ON (decides when sure)';
    if (this.settings.configured === 'on' && this.autoOffUntil > this.now()) return `practice (stepped back automatically: ${this.autoOffWhy})`;
    return 'practice (shadow: the node decides)';
  }

  // ---- feed ---------------------------------------------------------------
  // The raw live-feed message, passed on unchanged. Fire-and-forget.
  forwardFeed(text: string): void {
    try { this.client.sendFeed(text); } catch { /* never breaks the feed */ }
    // Copy 2: each block's time and L1 block number come from the feed.
    try { this.copy2?.noteFeed(text); } catch { /* never breaks the feed */ }
  }

  // ---- copy 2 ----------------------------------------------------------------
  // Copy 2 is running (the fast check follows our pools from their events).
  // Its answers are then about whole blocks: "right after this transaction"
  // is not available, so follow-a-trade checks wait for the trade's block.
  copy2Running(): boolean { try { return !!this.copy2?.running(); } catch { return false; } }

  // May the fast check decide a route with these pools (addresses, V4 ids,
  // the loan pool)? Returns the state to ask about, or null = the node
  // decides (copy 2 not running, a pool not ready, reports not flowing...).
  copy2Route(keys: Array<string | undefined | null>, minBlock = -1): Copy2Route | null {
    try { return this.copy2?.route(keys, minBlock) ?? null; } catch { return null; }
  }

  // Copy 2: wait until the trade's pool reports arrived (= it is in a block).
  // The block number, or null (copy 2 not running / not seen within ms).
  copy2WaitForTx(hash: string | undefined, ms: number): Promise<number | null> {
    try { return this.copy2?.waitForTx(hash, ms) ?? Promise.resolve(null); } catch { return Promise.resolve(null); }
  }

  // When the bot saw a trigger trade (only for trades that go to a check).
  noteTrigger(hash: string | undefined, seenMs: number): void {
    if (!hash) return;
    this.triggerSeen.set(hash.toLowerCase(), seenMs);
    if (this.triggerSeen.size > 2_000) this.triggerSeen.delete(this.triggerSeen.keys().next().value as string);
  }
  seenMsOf(hash?: string): number | undefined { return hash ? this.triggerSeen.get(hash.toLowerCase()) : undefined; }

  // ---- warm list ----------------------------------------------------------
  async sendWarm(): Promise<void> {
    try {
      if (!this.client.isConnected()) return;
      const all = [...new Set(this.warmSource().filter((a) => typeof a === 'string' && ADDR_RE.test(a)).map((a) => a.toLowerCase()))];
      for (let i = 0; i < all.length; i += 1_000) {
        const a = await this.client.request({ type: 'warm', accounts: all.slice(i, i + 1_000) }, 5_000);
        if (a.ok !== true) { this.log(`[local-sim] warm list not accepted (${(a as { unknown: string }).unknown})`); return; }
      }
      this.log(`[local-sim] warm list sent: ${all.length} accounts`);
    } catch (e) {
      this.hour.errors++;
    }
  }

  // ---- status / auto step back -------------------------------------------
  async pollStatus(): Promise<void> {
    try {
      if (!this.client.isConnected()) return;
      const s = await this.client.request({ type: 'status' }, 1_000);
      if (s.ok !== true) return;
      this.lastStatus = s as Record<string, unknown>;
      const mm = Number((s as Record<string, unknown>).replay_mismatch ?? NaN);
      if (!Number.isFinite(mm)) return;
      if (this.lastMismatch === null || mm < this.lastMismatch) { this.lastMismatch = mm; return; } // first poll / sidecar restarted
      const added = mm - this.lastMismatch;
      this.lastMismatch = mm;
      if (added > 0) {
        this.hour.mismatchNew += added;
        this.log(`[local-sim] sidecar reports ${added} new replay mismatch(es) (its copy drifted from the chain)`);
        if (added > this.settings.maxNewMismatch && this.isOn()) this.stepBack(`${added} new replay mismatch(es) in the sidecar`);
      }
    } catch { this.hour.errors++; }
  }

  private stepBack(why: string): void {
    this.autoOffUntil = this.now() + 6 * 3_600_000;
    this.autoOffWhy = why;
    this.hour.autoOffs++;
    this.samples = [];
    this.log(`[local-sim] FAST CHECK STEPPED BACK to practice for 6 h: ${why}. The node decides meanwhile.`);
    this.safeAlert(`⚠️ FAST CHECK stepped back to practice for 6 hours\nWhy: ${why}\nThe node decides every trade meanwhile (same as before the fast check). Nothing to do; to switch it off for good set LOCAL_SIM=off.`);
  }
  private safeAlert(t: string): void { try { this.alert(t); } catch { /* reporting only */ } }

  // On mode: should this fast decision be re-checked with the node? (1 in N)
  shouldSample(): boolean {
    this.onDecisions++;
    return this.onDecisions % this.settings.sampleEvery === 0;
  }

  // A re-check came back: did it agree? Steps back above 2% disagreement.
  private noteSample(agree: boolean): void {
    this.samples.push(agree);
    if (this.samples.length > 200) this.samples.shift();
    this.hour.sampleChecks++;
    if (agree) this.hour.sampleSame++;
    const bad = this.samples.filter((x) => !x).length;
    if (this.isOn() && bad / Math.max(this.samples.length, 50) > 0.02) {
      this.stepBack(`${bad} of the last ${this.samples.length} node re-checks disagreed (over 2%)`);
    }
  }

  // ---- checks -------------------------------------------------------------
  // Ask the sidecar the same check the node gets. Starts at once; the caller
  // may await `.result` (on mode) or ignore it (shadow). Never throws.
  begin(q: LocalQuestion): LocalCheck {
    const connected = this.client.isConnected();
    return this.track(new LocalCheck(this, q, (c) => this.runLocal(c), connected));
  }

  private track(c: LocalCheck): LocalCheck {
    this.open.add(c);
    if (this.open.size > 500) { const first = this.open.values().next().value as LocalCheck; first.expire(); }
    return c;
  }

  private async runLocal(c: LocalCheck): Promise<LocalOutcome> {
    const requestMs = this.now();
    const q = c.q;
    const unknown = (why: string): LocalOutcome => ({
      sure: false, verdict: 'unknown', why, requestMs, answerMs: this.now(),
      sim: { status: 'fail', reason: `${LOCAL_UNKNOWN_PREFIX}${why})`, bucket: 'replay_unavailable' },
    });
    try {
      if (!this.client.isConnected()) return unknown('disconnected');
      let gasUsed: bigint | undefined;
      const at = q.at ?? (q.triggerHash ? { afterTx: q.triggerHash.toLowerCase() } : { after: 'head' });
      const rpc = makeLocalRpc(this.client, undefined, {
        timeoutMs: this.settings.timeoutMs,
        at,
        onAnswer: (_m: string, a: SidecarAnswer, sent: Record<string, unknown>) => {
          const call = (sent.calls as Array<{ to?: string }> | undefined)?.[0];
          if (call?.to?.toLowerCase() !== SIM_EXECUTOR_ADDRESS) return;
          c.lastSent = sent;
          const g = (a as { results?: Array<{ gasUsed?: string }> }).results?.[0]?.gasUsed;
          try { gasUsed = g ? BigInt(g) : undefined; } catch { gasUsed = undefined; }
        },
        onReply: (_m: string, a: SidecarAnswer, sent: Record<string, unknown>) => {
          const call = (sent.calls as Array<{ to?: string }> | undefined)?.[0];
          if (call?.to?.toLowerCase() !== SIM_EXECUTOR_ADDRESS) return;
          c.sidecar = { inside: insideMs(a), rt: typeof a.rtMs === 'number' ? a.rtMs : undefined, t: a.t };
        },
      });
      // slotReadOnly: a local answer may READ the bot's "where does this coin
      // keep balances" notes, never add to them (so it can't change node checks).
      const sim = await withDeadline(
        simulateRoundTrip(rpc, 'robinhood', q.trade, { ...q.simOpts, slotReadOnly: true }),
        this.settings.deadlineMs,
      );
      if (!sim) return unknown('deadline');
      const verdict = verdictOf(sim);
      if (verdict === 'unknown') return { ...unknown(unknownWhy(sim)), sim };
      return { sure: true, sim, verdict, gasUsed, requestMs, answerMs: this.now() };
    } catch {
      this.hour.errors++;
      return unknown('client_error');
    }
  }

  // On mode: find a better size with the sidecar, never above the size the
  // bot already picked (which already obeys every size cap and the wallet
  // fit), never below 1/8 of it. null = none better / not possible.
  async sizeSearch(c: LocalCheck): Promise<{ amountIn: bigint; profit: bigint; gasUsed?: bigint } | null> {
    try {
      if (!this.settings.sizeSearch || !c.local?.sure || c.local.sim.status !== 'profit' || !c.lastSent) return null;
      const sent = c.lastSent as { at?: unknown; overrides?: Record<string, { stateDiff?: Record<string, string> }>; calls?: Array<{ data?: string; to?: string; from?: string; gas?: string }> };
      const call = sent.calls?.[0];
      const data = call?.data;
      const amountIn = c.q.trade.amountIn;
      if (!call || !data || amountIn < 8n) return null;
      // amountIn sits in the 4th 32-byte word after the 4-byte code (both
      // execute and executeWithV3Flash: [trade offset][lender][token][amountIn]).
      // Checked, not assumed: if it isn't there, no size search.
      const AMOUNT_OFFSET = 96;
      const word = data.slice(2 + 8 + AMOUNT_OFFSET * 2, 2 + 8 + AMOUNT_OFFSET * 2 + 64);
      if (word.length !== 64 || BigInt('0x' + word) !== amountIn) return null;
      // Own money: the test contract's pretend balance must follow each size.
      const ov = sent.overrides ?? {};
      const tokenKey = Object.keys(ov).find((k) => k.toLowerCase() === c.q.trade.token.toLowerCase());
      const diff = tokenKey ? ov[tokenKey]?.stateDiff ?? {} : {};
      const slots = Object.keys(diff);
      if (!c.q.simOpts.v3Lender && slots.length !== 1) return null;
      const amountSlots = c.q.simOpts.v3Lender ? [] : [{ account: tokenKey!, slot: slots[0] }];
      const hex = (n: bigint) => '0x' + n.toString(16);
      const a = await this.client.request({
        type: 'size_search', at: sent.at, overrides: ov,
        template: { from: call.from, to: call.to, gas: call.gas, data },
        amountOffset: AMOUNT_OFFSET, amountSlots,
        range: { lo: hex(amountIn / 8n), hi: hex(amountIn), steps: 10 },
      }, Math.max(this.settings.timeoutMs, 30));
      if (a.ok !== true) return null;
      const best = (a as { best?: { amount?: string; profit?: string; gasUsed?: string } | null }).best;
      if (!best?.amount || !best.profit) return null;
      const amt = BigInt(best.amount), profit = BigInt(best.profit);
      if (amt <= 0n || amt > amountIn || profit <= c.local.sim.profit) return null;
      return { amountIn: amt, profit, gasUsed: best.gasUsed ? BigInt(best.gasUsed) : undefined };
    } catch {
      this.hour.errors++;
      return null;
    }
  }

  // ---- record -------------------------------------------------------------
  // Both answers in (or the node's isn't coming): count and write one line.
  finish(c: LocalCheck, node: { sim: SimResult | null; startMs: number; endMs: number; where?: string } | null): void {
    try {
      this.open.delete(c);
      const l = c.local;
      if (!c.record) { this.hour.down++; return; }
      if (!l) return;
      const nv = node ? verdictOf(node.sim) : undefined;
      const seen = c.q.seenMs ?? this.seenMsOf(c.q.triggerHash);
      this.hour.checks++;
      this.hour.localMs.push(l.answerMs - l.requestMs);
      if (c.sidecar?.inside !== undefined) { this.hour.insideMs.push(c.sidecar.inside); if (this.hour.insideMs.length > 5_000) this.hour.insideMs.shift(); }
      if (seen !== undefined) this.hour.seenToAnswerMs.push(l.answerMs - seen);
      if (node) this.hour.nodeMs.push(node.endMs - node.startMs);
      if (!l.sure) { this.hour.unknown++; const w = l.why ?? 'unknown'; this.hour.unknownWhy[w] = (this.hour.unknownWhy[w] ?? 0) + 1; }
      // Decisions only (practice "trig" checks never decide anything).
      if (c.decidedByLocal) this.hour.decidedLocal++; else if (this.settings.configured === 'on' && c.q.kind !== 'trig') this.hour.decidedNode++;
      const both = l.sure && nv !== undefined && nv !== 'unknown';
      const same = both && l.verdict === nv;
      if (both) { this.hour.compared++; if (same) this.hour.same++; }
      // Copy 2 (asked about a block the copy follows): its own tally.
      const c2Block = (c.q.at as { block?: unknown } | undefined)?.block;
      const isC2 = typeof c2Block === 'string';
      if (isC2) {
        const t = this.hour.c2;
        t.checks++;
        if (!l.sure) t.unknown++;
        else if (nv === undefined || nv === 'unknown') t.noNode++;
        else if (same) t.same++;
        else t.different++;
      }
      if (c.sampled && both) this.noteSample(same);
      if (this.hour.localMs.length > 5_000) { this.hour.localMs.shift(); }
      if (this.hour.nodeMs.length > 5_000) { this.hour.nodeMs.shift(); }
      if (this.hour.seenToAnswerMs.length > 5_000) { this.hour.seenToAnswerMs.shift(); }
      const gasN = node?.sim && (node.sim.status === 'profit' || node.sim.status === 'loss') ? node.sim.gasUsed : undefined;
      this.shadowLog.add({
        t: this.now(), k: c.q.kind, mode: c.decidedByLocal ? 'on' : 'shadow', pair: c.q.label, tx: short(c.q.triggerHash),
        // local answer
        lv: l.verdict, lp: profitOf(l.sim), lg: l.gasUsed, lu: l.sure ? undefined : l.why,
        lms: l.answerMs - l.requestMs, lseen: seen !== undefined ? l.answerMs - seen : undefined,
        // arbsim's own time for our contract call (ms, queue included), the
        // socket round trip the bot measured (ms) and arbsim's split (us):
        // lms much above lrt = the bot's own wait; lrt much above lus =
        // socket / the bot reading late; lt says which arbsim step.
        lus: c.sidecar?.inside, lrt: c.sidecar?.rt, lt: c.sidecar?.t,
        // node answer (absent = no node check: on mode, not re-checked)
        nv, np: profitOf(node?.sim), ng: gasN,
        nr: node?.sim && 'reason' in node.sim ? node.sim.reason.slice(0, 80) : node?.sim && node.sim.status !== 'profit' && node.sim.status !== 'loss' ? node.sim.status : undefined,
        nms: node ? node.endMs - node.startMs : undefined, nseen: node && seen !== undefined ? node.endMs - seen : undefined, nwhere: node?.where,
        same: both ? same : undefined, dec: c.decidedByLocal ? 'local' : 'node', smp: c.sampled || undefined,
        // copy 2: the block the fast check was asked about (absent = not a copy-2 check)
        c2blk: isC2 ? c2Block : undefined,
        // timestamps (clock ms): trigger seen in feed, question sent, answer back
        seen, sent: l.requestMs, ans: l.answerMs,
      });
    } catch { this.hour.errors++; }
  }

  // Live: a follow-a-trade send was signed. Proves "trigger seen -> signed".
  noteSigned(triggerHash: string | undefined, seenMs: number, signedMs: number, decidedBy: 'local' | 'node'): void {
    try {
      this.shadowLog.add({ t: this.now(), k: 'signed', tx: short(triggerHash), dec: decidedBy, seen: seenMs, signed: signedMs, seenToSignedMs: signedMs - seenMs });
    } catch { /* reporting only */ }
  }

  // Checks whose node answer never came (the node check stopped early): written after 60 s.
  private sweep(): void {
    const cut = this.now() - 60_000;
    for (const c of [...this.open]) if (c.startedMs < cut) c.expire();
  }

  // ---- hourly line ---------------------------------------------------------
  // "Fast check (practice): N checks, same answer X%, unknown Y%, median Z ms vs node W ms"
  // Takes and resets the hour's counters. null = nothing to say.
  takeHourLine(): string | null {
    const h = this.hour;
    this.hour = this.freshHour();
    const label = this.isOn() ? 'on' : 'practice';
    const parts: string[] = [];
    // Copy 2: pools ready / unsure, checks routed to the fast check vs the node.
    let c2: string | null = null;
    try { c2 = this.copy2?.hourText() ?? null; } catch { c2 = null; }
    if (!h.checks && !h.down) {
      let line = this.client.isConnected() ? `Fast check (${label}): connected, no checks this hour` : `Fast check (${label}): sidecar not reachable, the node did every check`;
      if (c2) line += `; ${c2}`;
      this.log(`[local-sim] hour: ${line}`);
      return line;
    }
    const lm = median(h.localMs), nm = median(h.nodeMs), sm = median(h.seenToAnswerMs);
    parts.push(`${h.checks} checks`);
    parts.push(`same answer ${pct(h.same, h.compared)}`);
    parts.push(`unknown ${pct(h.unknown, h.checks)}`);
    parts.push(`median ${lm ?? 'n/a'} ms vs node ${nm ?? 'n/a'} ms`);
    let line = `Fast check (${label}): ${parts.join(', ')}`;
    if (sm !== null) line += ` (trade seen to answer ${sm} ms)`;
    if (this.settings.configured === 'on') line += `; decided by fast check ${h.decidedLocal}, by node ${h.decidedNode}, re-checks agreed ${h.sampleSame}/${h.sampleChecks}`;
    if (h.down) line += `; sidecar down for ${h.down} checks`;
    if (h.mismatchNew) line += `; ${h.mismatchNew} replay mismatch(es)`;
    if (h.autoOffs) line += '; STEPPED BACK to practice';
    if (h.c2.checks) line += `; copy 2 vs node: ${h.c2.checks} checks, same ${h.c2.same}, different ${h.c2.different}, fast check unsure ${h.c2.unknown}${h.c2.noNode ? `, node no answer ${h.c2.noNode}` : ''} (same answer ${pct(h.c2.same, h.c2.same + h.c2.different)})`;
    if (c2) line += `; ${c2}`;
    const whys = Object.entries(h.unknownWhy).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w} ${n}`).join(', ');
    // arbsim's own time (vs the bot-side median above) and answers that came
    // after the bot had given up: log only.
    const st = this.client.stats;
    const late = st.lateAnswers - this.lateSeen;
    this.lateSeen = st.lateAnswers;
    const im = median(h.insideMs), ip = p90(h.insideMs);
    const timing = im !== null ? ` | arbsim own time median ${im} ms, p90 ${ip} ms` : '';
    const lateTxt = late > 0 ? ` | ${late} answer(s) came after the ${this.settings.timeoutMs} ms timeout (median ${median(st.lateMs) ?? 'n/a'} ms after sending; arbsim own time median ${median(st.lateInsideMs) ?? 'n/a'} ms)` : '';
    this.log(`[local-sim] hour: ${line}${whys ? ` | unknown because: ${whys}` : ''}${timing}${lateTxt}${h.errors ? ` | errors ${h.errors}` : ''}${this.shadowLog.dropped ? ` | log lines dropped ${this.shadowLog.dropped}` : ''}`);
    return line;
  }

  status(): Record<string, unknown> | null { return this.lastStatus; }

  stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const c of [...this.open]) c.expire();
    try { this.copy2?.stop(); } catch { /* already stopped */ }
    try { this.client.close(); } catch { /* already closed */ }
    return this.shadowLog.stop();
  }
}

// The promise's answer, or null if it takes longer than ms.
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
  });
}

// Start the fast check when it's switched on and Robinhood is traded.
// Returns null (and does nothing at all: no socket) when LOCAL_SIM=off.
export function createLocalSimHost(robinhoodOn: boolean, opts: LocalSimHostOptions = {}): LocalSimHost | null {
  try {
    if (!robinhoodOn || localSimMode(opts.env ?? process.env) === 'off') return null;
    return new LocalSimHost(opts);
  } catch (e) {
    (opts.log ?? console.log)(`[local-sim] could not start the fast check (${(e as Error).message}); using the node for everything`);
    return null;
  }
}
