import { LocalSimClient, makeLocalRpc, SidecarAnswer, localUnknownMessage } from './localSim';
import { performance } from 'perf_hooks';
import { simulateRoundTrip, SimResult, SIM_EXECUTOR_ADDRESS } from './simulator';
import { JsonlLog, verdictOf, reasonOf, Verdict, LocalTrade, LocalSimOpts } from './localSimHost';
import type { FeedMsg } from '../chains/nitroFeed';

// ============================================================================
// TRIGGER-FIRST CHECK: our exact trade checked right after the trade we
// follow, the moment the feed shows it (no waiting for pool reports or
// receipts).
//
// Plain English (live Oct 23: we lost all 7 real trades; each chance was
// real, but rivals land at the top of block N+1 while we landed N+2..N+11,
// because every path WAITED: for the followed trade's pool reports (copy 2)
// or for its receipt (node), before checking our trade):
//
//   When the sequencer feed shows the trigger, the bot already holds:
//     - copy 2: the fast check's copy of our pools, kept current from pool
//       reports in the background (published per block, never changed once
//       published)
//     - this file's ORDER BUFFER: the last few hundred feed messages, each
//       with ALL its signed transactions, in sequencer order
//   So it asks the fast check, at once: "take your newest copy version, run
//   every feed transaction sequenced after it (before the trigger, the
//   trigger itself, and the ones after it we already saw: ours lands after
//   them too), then our exact trade" (sidecar: sim/src/check/ordered.rs).
//   If the trigger is already in that version, it is NOT run again: our
//   trade runs on the version plus whatever came after.
//
//   The answer is "profit / loss / fail" only when every step was exact;
//   any doubt is "unknown" and the bot uses its old path, unchanged
//   (missing state anywhere, a hole in the buffer, a message we can't
//   replay, a replayed trade looking at a wallet we only pretended, our
//   test contract's funding overlapping what they read, ...).
//
//   What it buys: we can submit WITHOUT waiting for pool reports or
//   receipts. Whether that lands us in the trigger's block or the next one
//   is something to MEASURE (shadow mode below), not a promise. A local
//   profit is a profit against the simulated state, not a guaranteed
//   profit: the contract's own on-chain min-profit check stays the safety
//   net.
//
//   Switch: LOCAL_SIM_TRIGGER_FIRST in .env
//     off (default)  nothing at all: no buffer, no extra work
//     shadow         practice: computed for every live-path trigger and
//                    logged next to what the existing path decided and
//                    when; it never sends
//     on             a SURE answer decides (profit -> straight on to every
//                    existing safeguard and the sender; loss / fail ->
//                    refused as today); unknown -> the existing path.
//                    Only while the fast check itself is ON (LOCAL_SIM=on +
//                    LOCAL_SIM_CONFIRM, not stepped back); otherwise it
//                    stays in practice.
//
//   Measurement: data/local-sim-shadow.jsonl lines with "k":"trig_first"
//   (one per trigger, written ~8 s after it, when the later facts are in)
//   and an hourly "[trigger-first] hour:" line (see takeHourLine).
//
//   Node use: none in the hot path. Missing state is fetched only by the
//   background WARMER below, with a hard hourly budget of node requests
//   (TRIG_FIRST_WARM_RPC_PER_HOUR, default 60), counted.
//
//   Safety: nothing here signs or sends. Every problem is caught, counted
//   and turned into "unknown"; it never throws into the bot.
//
//   BEST EFFORT + CONFIDENCE (Oct 23, owner: "sufficiently accurate
//   predictions, fast execution, and measured results showing that wins
//   outweigh failed-trade gas"). A wrong prediction only costs gas (about
//   3 cents: the contract reverts a trade under its minimum profit); a late
//   perfect answer earns nothing. So the fast check may now make a few named
//   ASSUMPTIONS instead of saying "unknown" (sim/src/check/ordered.rs BEST
//   EFFORT): sender_funds (the trigger's sender can pay), recent_fill (a
//   value copy 2 re-reads every minute), call_fill (our trade read such a
//   value), skipped_unrelated / skipped_related (a feed transaction we can't
//   run and that can't / might touch our route was left out). Each answer
//   carries a CONFIDENCE: high (nothing assumed), medium (sender_funds /
//   fills / skipped_unrelated), low (skipped_related).
//     - shadow: every level is logged ("conf" / "as" in the trig_first line,
//       and the later same-block re-check's agreement split by confidence
//       and by assumption in the hour line), so we can SEE which
//       assumptions are safe.
//     - on: an answer decides only at TRIG_FIRST_MIN_CONFIDENCE or better
//       (default medium); a lower one goes to the existing path, unchanged.
//     - TRIG_FIRST_STRICT=1: no assumptions at all (the old strict rules).
//       TRIG_FIRST_ASSUME (default "sender_funds,recent_fill,skip") picks
//       which assumptions are allowed.
//   The scoreboard (report/scoreboard.ts) can also put trigger-first back
//   to practice for a while by itself (stepBack), when real sends lose.
// ============================================================================

export type TrigFirstMode = 'off' | 'shadow' | 'on';
export type TrigConfidence = 'high' | 'medium' | 'low';
const CONF_RANK: Record<TrigConfidence, number> = { low: 0, medium: 1, high: 2 };

// TRIG_FIRST_MIN_CONFIDENCE=high|medium|low (anything else: medium).
export function minConfidenceOf(v: string | undefined): TrigConfidence {
  const x = (v ?? '').trim().toLowerCase();
  return x === 'high' || x === 'low' ? x : 'medium';
}
// Is `c` at least `min`?
export function confidenceAtLeast(c: TrigConfidence | undefined, min: TrigConfidence): boolean {
  return CONF_RANK[c ?? 'high'] >= CONF_RANK[min];
}

// LOCAL_SIM_TRIGGER_FIRST=off|shadow|on. Anything else (or unset) = off.
export function triggerFirstMode(env: Record<string, string | undefined> = process.env): TrigFirstMode {
  const v = (env.LOCAL_SIM_TRIGGER_FIRST ?? '').trim().toLowerCase();
  return v === 'shadow' || v === 'on' ? v : 'off';
}

// Settings (all from .env; defaults in brackets).
export type TrigFirstSettings = {
  mode: TrigFirstMode;            // LOCAL_SIM_TRIGGER_FIRST [off]
  bufferMsgs: number;             // TRIG_FIRST_BUFFER_MSGS [600] feed messages kept (~60 s)
  backMsgs: number;               // TRIG_FIRST_BACK_MSGS [8] extra messages sent before the copy's newest block
  maxMsgs: number;                // TRIG_FIRST_MAX_MSGS [48] most messages sent with one question
  timeoutMs: number;              // TRIG_FIRST_TIMEOUT_MS [60] per question to the fast check
  deadlineMs: number;             // TRIG_FIRST_DEADLINE_MS [120] whole check
  warmRpcPerHour: number;         // TRIG_FIRST_WARM_RPC_PER_HOUR [60] node requests the warmer may cause (upper bound)
  warmMinSeen: number;            // TRIG_FIRST_WARM_MIN_SEEN [2] an account is warmed once this many checks missed it
  agreePerHour: number;           // TRIG_FIRST_AGREE_PER_HOUR [600] later same-block re-checks (fast check only, no node)
  agreeWaitMs: number;            // TRIG_FIRST_AGREE_WAIT_MS [5000] wait for the trigger's block reports
  finalizeMs: number;             // TRIG_FIRST_LOG_AFTER_MS [8000] write a trigger's log line this long after its answer
  l2Offset: number;               // ARBSIM_L2_BLOCK_OFFSET [0] block = feed sequence number + this
  strict: boolean;                // TRIG_FIRST_STRICT [0] 1 = no assumptions at all (old strict rules)
  assume: string[];               // TRIG_FIRST_ASSUME [sender_funds,recent_fill,skip] allowed assumptions
  minConfidence: TrigConfidence;  // TRIG_FIRST_MIN_CONFIDENCE [medium] lowest confidence that may send (on mode)
  feedStore: boolean;             // TRIG_FIRST_FEED_STORE [1] hand each feed message to the sidecar once and NAME messages in questions (0 = send them inline every time, as before)
};

export function trigFirstSettings(env: Record<string, string | undefined> = process.env): TrigFirstSettings {
  const num = (k: string, d: number, min = 1) => { const v = Number(env[k]); return Number.isFinite(v) && v >= min ? v : d; };
  return {
    mode: triggerFirstMode(env),
    bufferMsgs: Math.round(num('TRIG_FIRST_BUFFER_MSGS', 600, 16)),
    backMsgs: Math.round(num('TRIG_FIRST_BACK_MSGS', 8, 0)),
    maxMsgs: Math.round(num('TRIG_FIRST_MAX_MSGS', 48, 2)),
    timeoutMs: num('TRIG_FIRST_TIMEOUT_MS', 60),
    deadlineMs: num('TRIG_FIRST_DEADLINE_MS', 120),
    warmRpcPerHour: Math.round(num('TRIG_FIRST_WARM_RPC_PER_HOUR', 60, 0)),
    warmMinSeen: Math.round(num('TRIG_FIRST_WARM_MIN_SEEN', 2)),
    agreePerHour: Math.round(num('TRIG_FIRST_AGREE_PER_HOUR', 600, 0)),
    agreeWaitMs: num('TRIG_FIRST_AGREE_WAIT_MS', 5_000),
    finalizeMs: num('TRIG_FIRST_LOG_AFTER_MS', 8_000),
    l2Offset: Math.round(num('ARBSIM_L2_BLOCK_OFFSET', 0, 0)),
    strict: (env.TRIG_FIRST_STRICT ?? '').trim() === '1',
    assume: (env.TRIG_FIRST_ASSUME ?? 'sender_funds,recent_fill,skip').split(',').map((x) => x.trim().toLowerCase()).filter((x) => x === 'sender_funds' || x === 'recent_fill' || x === 'skip'),
    minConfidence: minConfidenceOf(env.TRIG_FIRST_MIN_CONFIDENCE),
    feedStore: (env.TRIG_FIRST_FEED_STORE ?? '1').trim() !== '0',
  };
}

// ----------------------------------------------------------------------------
// ORDER BUFFER: the last N feed messages, complete, by sequence number.
// One copy per sequence number (a reconnect's backlog repeats are ignored);
// the oldest are forgotten first. Holes (a message never received) simply
// aren't there: the fast check then answers "feed_gap".
// ----------------------------------------------------------------------------
export class FeedOrderBuffer {
  private readonly msgs = new Map<number, FeedMsg & { at: number }>();
  private readonly where = new Map<string, number>();   // tx hash -> sequence number
  private lo = Infinity;
  private hi = -1;

  constructor(private readonly keep = 600) {}

  // Returns the messages that were new (speed-3 feed store: handed on once).
  ingest(list: FeedMsg[], at: number): FeedMsg[] {
    const fresh: FeedMsg[] = [];
    for (const m of list) {
      if (!m || !Number.isSafeInteger(m.seq) || this.msgs.has(m.seq)) continue;
      this.msgs.set(m.seq, { ...m, at });
      fresh.push(m);
      for (const t of m.txs) this.where.set(t.hash.toLowerCase(), m.seq);
      if (m.seq < this.lo) this.lo = m.seq;
      if (m.seq > this.hi) this.hi = m.seq;
    }
    // Forget the oldest beyond `keep` (and their transactions' places).
    while (this.msgs.size > this.keep && this.lo <= this.hi) {
      const old = this.msgs.get(this.lo);
      if (old) {
        this.msgs.delete(this.lo);
        for (const t of old.txs) if (this.where.get(t.hash.toLowerCase()) === old.seq) this.where.delete(t.hash.toLowerCase());
      }
      this.lo++;
    }
    if (!this.msgs.size) { this.lo = Infinity; this.hi = -1; }
    return fresh;
  }

  // Feed sequence number of a transaction (undefined = not in the buffer).
  seqOf(hash: string | undefined): number | undefined { return hash ? this.where.get(hash.toLowerCase()) : undefined; }
  get(seq: number): (FeedMsg & { at: number }) | undefined { return this.msgs.get(seq); }
  newest(): number { return this.hi; }
  oldest(): number { return this.msgs.size ? this.lo : -1; }
  size(): number { return this.msgs.size; }
  // Messages from..to that we hold, oldest first (holes left out).
  range(from: number, to: number): FeedMsg[] {
    const out: FeedMsg[] = [];
    for (let s = Math.max(from, this.lo); s <= Math.min(to, this.hi); s++) {
      const m = this.msgs.get(s);
      if (m) out.push(m);
    }
    return out;
  }
}

// ----------------------------------------------------------------------------
// What trigger-first needs from copy 2 (execution/copy2.ts Copy2Link).
// ----------------------------------------------------------------------------
export type TrigCopy2 = {
  running(): boolean;
  notReadyWhy(keys: Array<string | undefined | null>): string | null;
  waitForTx(hash: string | undefined, ms: number): Promise<number | null>;
  forwarder: { newestBlock(): number; txBlockOf(hash: string | undefined): number | null };
};

// One trigger-first question.
export type TrigQuestion = {
  trade: LocalTrade;
  simOpts: LocalSimOpts;
  triggerHash: string;
  seenMs: number;                       // when the feed showed the trigger
  keys: Array<string | undefined | null>; // route pools (copy-2 readiness)
  label?: string;
};

// What the sidecar said about the replay (answer field `trig`).
// conf / assumed / skipped (best effort): how sure, what was assumed, how
// many feed transactions were left out. An older fast check sends none of
// them: its answers are exact (high).
export type TrigInfo = { snapBlock?: number; included?: boolean; triggerOk?: boolean | null; msgs?: number; txs?: number; later?: number; lastSeq?: number; reverted?: number; conf?: TrigConfidence; assumed?: string[]; skipped?: number };

// Entry point size ladder (execution/trigEntry.ts): our trade tried at
// other sizes on the SAME feed replay, in the same request (sidecar
// proto_types.rs WireSizes). One row per extra size.
export type TrigLadderRow = { amount: bigint; status: 'profit' | 'loss' | 'fail' | 'unknown'; profit: bigint };

export type TrigOutcome = {
  ladder?: TrigLadderRow[];             // entry point: the other sizes' results (sure answers only)
  sure: boolean;                        // a real profit / loss / fail verdict
  verdict: Verdict;
  sim: SimResult;
  why?: string;                         // unknown: why
  requestMs: number;
  answerMs: number;
  seenMs: number;
  triggerSeq?: number;
  info?: TrigInfo;
  insideMs?: number;                    // the sidecar's own time (ms)
  confidence?: TrigConfidence;          // sure answers: high / medium / low
  assumptions?: string[];               // sure answers: what was assumed ([] = exact)
  // Entry point per-hop timing (execution/trigEntry.ts `hops`): when our
  // check question was sent / its answer read (performance.now() ms), and
  // the sidecar's own split: waiting for a worker (q) and working (w), ms.
  hop?: { s?: number; a?: number; q?: number; w?: number };
};

// ENTRY POINT "one trip" (execution/trigEntry.ts): the sidecar already ran
// our check inside the combined `trig_entry` question. `answer` is that very
// `call` answer; `data` is our call's data as the table sent it (a different
// one = the trade changed since: not used); `seq` = the trigger's feed
// sequence number from the discovery feed.
// `sig` (checkSig): the exact question the table sent (call data, pretend
// state, ladder amounts); our rebuilt question must match it exactly.
export type CannedAnswer = { answer: SidecarAnswer; sig: string; seq: number };

// One string for "exactly this check question": call data + pretend state +
// ladder amounts (what decides the sidecar's answer, besides the feed).
export function checkSig(data: unknown, overrides: unknown, sizes: unknown): string {
  // Long contract codes (our test contract, ~25 KB) stand in as a short
  // fingerprint, worked out once per code (keeps this cheap).
  return JSON.stringify([data ?? null, overrides ?? {}, sizes ?? null], (k, v) => (k === 'code' && typeof v === 'string' && v.length > 200 ? codeTag(v) : v));
}
const codeTags = new Map<string, string>();
function codeTag(code: string): string {
  let t = codeTags.get(code);
  if (t) return t;
  // FNV-1a over the whole code, plus its length.
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) { h ^= code.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  t = `code:${code.length}:${h.toString(16)}`;
  if (codeTags.size > 16) codeTags.clear();
  codeTags.set(code, t);
  return t;
}

// What our exact check question looks like (for the one-trip table): the
// `call` fields a trigger-first check sends, minus the feed.
export type CapturedCheck = { calls: unknown[]; overrides: Record<string, unknown>; sizes?: { amountOffset: number; amounts: string[] }; data: string };

// Unknown reasons that mean "the state we needed wasn't there" (for the
// "required state available" share in the hourly line).
const STATE_REASONS = new Set(['miss', 'unsure_pool', 'pending_reports', 'not_ready', 'stale', 'dirty', 'pool_manager_balance', 'protocol_fee']);

const pctl = (xs: number[], q: number): number | null => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * q))];
};
const pct = (n: number, d: number): string => (d ? `${Math.round((100 * n) / d)}%` : 'n/a');
const short = (h?: string) => (h ? h.slice(0, 12) : undefined);

// The "why" inside a local-unknown marker ("miss", "feed_gap", ...).
function unknownWhy(r: SimResult): string {
  if ('reason' in r) {
    const m = /local sim unknown: ([a-z0-9_]+)/.exec(r.reason);
    if (m) return m[1];
    return r.status === 'fail' ? 'no_clear_reason' : r.status;
  }
  return r.status;
}

// The sidecar's size ladder rows -> TrigLadderRow (bad rows left out).
function readLadder(v: unknown): TrigLadderRow[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: TrigLadderRow[] = [];
  for (const r of v) {
    try {
      const st = (r as { status?: unknown }).status;
      if (st !== 'profit' && st !== 'loss' && st !== 'fail' && st !== 'unknown') continue;
      const p = (r as { profit?: unknown }).profit;
      out.push({ amount: BigInt((r as { amount: string }).amount), status: st, profit: typeof p === 'string' ? BigInt(p) : 0n });
    } catch { /* a bad row is skipped */ }
  }
  return out;
}

// The promise's answer, or null if it takes longer than ms.
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
  });
}

// ----------------------------------------------------------------------------
// WARMER: fetch commonly missed contract state in the background, within a
// hard hourly budget of node requests. Never in the hot path (offered items
// are sent with setImmediate, after the answer was used).
//
// Which items: an account counts as "commonly needed" once
// TRIG_FIRST_WARM_MIN_SEEN separate checks missed something of it (a
// router, a coin, a hook, another pool). One-off items (a single user's
// balance) are not worth a node request and wait.
// Cost (upper bound): the fast check reads one eth_getProof per account
// (all its slots together) plus one eth_getCode per new contract, so an
// item batch costs at most accounts + account items. That is what is
// counted against the budget.
// ----------------------------------------------------------------------------
export type WarmItem = { account: string; slot?: string };

export class TrigWarmer {
  private seen = new Map<string, number>();       // account -> checks that missed it (this hour)
  private done = new Map<string, number>();       // item key -> when sent
  private hourStart: number;
  usedRpc = 0;          // node requests caused this hour (upper bound)
  sentItems = 0;
  skippedBudget = 0;
  skippedRare = 0;

  constructor(
    private readonly send: (msg: Record<string, unknown>) => void,
    private readonly budgetPerHour: number,
    private readonly minSeen: number,
    private readonly now: () => number = Date.now,
  ) { this.hourStart = now(); }

  private roll(): void {
    if (this.now() - this.hourStart < 3_600_000) return;
    this.hourStart = this.now();
    this.usedRpc = 0; this.sentItems = 0; this.skippedBudget = 0; this.skippedRare = 0;
    this.seen.clear();
  }

  // Items one unknown check missed. Returns how many were sent to be fetched.
  offer(items: WarmItem[]): number {
    try {
      this.roll();
      const t = this.now();
      const valid = items.filter((i) => typeof i?.account === 'string' && /^0x[0-9a-fA-F]{40}$/.test(i.account));
      for (const a of new Set(valid.map((i) => i.account.toLowerCase()))) this.seen.set(a, (this.seen.get(a) ?? 0) + 1);
      // Recently sent items wait 10 min (the copy keeps them; a re-ask
      // only means they changed again).
      for (const [k, at] of this.done) if (t - at > 600_000) this.done.delete(k);
      const fresh = valid.filter((i) => !this.done.has(key(i)));
      const common = fresh.filter((i) => (this.seen.get(i.account.toLowerCase()) ?? 0) >= this.minSeen);
      this.skippedRare += fresh.length - common.length;
      if (!common.length) return 0;
      const accounts = new Set(common.map((i) => i.account.toLowerCase()));
      const cost = accounts.size + common.filter((i) => !i.slot).length;
      if (this.usedRpc + cost > this.budgetPerHour) { this.skippedBudget += common.length; return 0; }
      this.usedRpc += cost;
      this.sentItems += common.length;
      for (const i of common) this.done.set(key(i), t);
      const msg: { type: string; accounts: string[]; slots: Record<string, string[]> } = { type: 'warm', accounts: [], slots: {} };
      for (const i of common) {
        if (!i.slot) msg.accounts.push(i.account);
        else (msg.slots[i.account] ??= []).push(i.slot);
      }
      setImmediate(() => { try { this.send(msg); } catch { /* best effort */ } });
      return common.length;
    } catch { return 0; }
  }
}
const key = (i: WarmItem) => `${i.account.toLowerCase()}:${i.slot ?? ''}`;

// ----------------------------------------------------------------------------
// One trigger's record (written to the log once, ~finalizeMs after its answer).
// ----------------------------------------------------------------------------
type TrigRecord = {
  hash: string;
  label?: string;
  out: TrigOutcome;
  existingMs?: number;                  // shadow: when the existing path decided
  existingVerdict?: string;
  submittedMs?: number;                 // on: when our trade was signed
  reportBlock?: number | null;          // the trigger's block (its pool reports)
  reportMs?: number;                    // when those reports arrived
  agree?: boolean;                      // later same-block re-check agrees
  agreeVerdict?: Verdict;
  agreeProfit?: bigint;                 // the re-check's profit (when it said profit)
  sameState?: boolean;                  // nothing after the trigger was replayed
  agreeSkipped?: string;
  decided?: boolean;                    // on: this answer decided the trade
  written: boolean;
};

export type TriggerFirstOptions = {
  client: LocalSimClient;
  settings?: TrigFirstSettings;
  env?: Record<string, string | undefined>;
  copy2: () => TrigCopy2 | null;
  shadowLog: JsonlLog;
  // Does the fast check decide right now (LOCAL_SIM=on, confirmed, not
  // stepped back)? Trigger-first "on" decides only then.
  hostOn: () => boolean;
  log?: (m: string) => void;
  now?: () => number;
};

// One feed message as a question carries it (and as `feed_put` hands it over).
export function feedMsgWire(m: FeedMsg): Record<string, unknown> {
  return { seq: m.seq, ts: m.ts, l1: m.l1, txs: m.txs.map((t) => t.raw), complete: m.complete, ...(m.why ? { why: m.why } : {}) };
}

export class TriggerFirst {
  readonly settings: TrigFirstSettings;
  readonly buffer: FeedOrderBuffer;
  readonly warmer: TrigWarmer;
  private readonly client: LocalSimClient;
  private readonly o: TriggerFirstOptions;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly recs = new Map<string, TrigRecord>();
  private agreeTimes: number[] = [];
  private hour = this.freshHour();
  private onNotOnLogged = false;

  private freshHour() {
    return {
      seen: 0, profit: 0, loss: 0, fail: 0, unknown: 0, stateMissing: 0,
      unknownWhy: {} as Record<string, number>,
      ansMs: [] as number[], submitMs: [] as number[], earlierMs: [] as number[],
      reportAfterAnswerMs: [] as number[],
      included: 0, replayedTxs: 0,
      agree: 0, disagree: 0, sameAgree: 0, sameDisagree: 0, notCompared: 0, alignMismatch: 0,
      decided: 0, errors: 0,
      // Best effort: sure answers by confidence, answers held back by the
      // confidence floor (on), later re-check agreement [agree, compared]
      // by confidence and by assumption kind ("exact" = none).
      conf: { high: 0, medium: 0, low: 0 } as Record<TrigConfidence, number>,
      heldBack: 0,
      agreeByConf: {} as Record<string, [number, number]>,
      agreeByAssume: {} as Record<string, [number, number]>,
    };
  }

  constructor(opts: TriggerFirstOptions) {
    this.o = opts;
    this.settings = opts.settings ?? trigFirstSettings(opts.env ?? process.env);
    this.client = opts.client;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(m));
    this.buffer = new FeedOrderBuffer(this.settings.bufferMsgs);
    this.warmer = new TrigWarmer((m) => { void this.client.request(m, 5_000).catch(() => undefined); }, this.settings.warmRpcPerHour, this.settings.warmMinSeen, this.now);
    this.log(`[trigger-first] ${this.settings.mode} (warm budget ${this.settings.warmRpcPerHour} node requests/h)`);
  }

  mode(): TrigFirstMode { return this.settings.mode; }

  // Back to practice until untilMs (scoreboard overall step back). Logged.
  private stepBackUntil = 0;
  stepBack(untilMs: number, why: string): void {
    if (untilMs <= this.stepBackUntil) return;
    this.stepBackUntil = untilMs;
    this.log(`[trigger-first] stepped back to practice until ${new Date(untilMs).toISOString()}: ${why}`);
  }
  steppedBackUntil(): number { return this.stepBackUntil > this.now() ? this.stepBackUntil : 0; }

  // May this SURE answer decide (on mode)? null = yes; else why not (the
  // existing path then decides). Only the confidence is judged here; the
  // host adds the scoreboard's paused buckets.
  sendGate(out: TrigOutcome): string | null {
    if (!out.sure) return `unknown (${out.why ?? 'no reason'})`;
    if (!confidenceAtLeast(out.confidence, this.settings.minConfidence)) {
      this.hour.heldBack++;
      return `confidence ${out.confidence} below TRIG_FIRST_MIN_CONFIDENCE=${this.settings.minConfidence}`;
    }
    return null;
  }

  // Does a SURE trigger-first answer decide the trade right now?
  decides(): boolean {
    if (this.settings.mode !== 'on') return false;
    // Stepped back to practice by the scoreboard (real sends lost money).
    if (this.now() < this.stepBackUntil) return false;
    if (this.o.hostOn()) return true;
    if (!this.onNotOnLogged) { this.onNotOnLogged = true; this.log('[trigger-first] LOCAL_SIM_TRIGGER_FIRST=on but the fast check is not ON (LOCAL_SIM=on + LOCAL_SIM_CONFIRM, not stepped back): practice only'); }
    return false;
  }

  // Every feed message (robinhoodChain.ts setFeedMsgTap). Cheap.
  onFeedMsgs(msgs: FeedMsg[], at: number): void {
    let fresh: FeedMsg[] = [];
    try { fresh = this.buffer.ingest(msgs, at); } catch { this.hour.errors++; }
    if (fresh.length) this.putFeed(fresh);
  }

  // ---- FEED STORE (speed-3, Oct 24) -----------------------------------------
  // Plain English: every trigger-first question used to carry up to 48 feed
  // messages with all their signed transactions (~0.5 MB of text), and every
  // candidate check of a trigger carried them again. Turning that into text
  // here, and back into bytes + hashes + senders in the sidecar, was most of
  // the ~18 ms the sidecar spent per question (bench: ~14 ms -> ~1.4 ms).
  // Now each feed message goes to the sidecar ONCE, when it arrives
  // (`feed_put`, same socket, so it is there before any question naming it),
  // and questions name the messages ([sequence number, transaction count]).
  // Same answers: the sidecar rebuilds exactly these messages (tested); a
  // question is sent the old way whenever any message in it was not handed
  // over on THIS connection, or the sidecar does not have the store (an
  // older sidecar), and again the old way if the sidecar says it lacks one
  // ("feed_ref_missing", e.g. it restarted).
  private storeEpoch = -1;            // connection the store answer is for
  private storeOn = false;            // the sidecar on that connection has a store
  private storeAsking = false;
  private readonly putOk = new Map<number, { n: number; epoch: number }>();
  readonly storeStats = { puts: 0, putFails: 0, refQs: 0, inlineQs: 0, missing: 0, resent: 0 };

  // Is the store usable on the current connection? (Asks the sidecar once per connection.)
  private storeReady(): boolean {
    if (!this.settings.feedStore) return false;
    const c = this.client as Partial<LocalSimClient>;
    if (typeof c.connEpoch !== 'function' || typeof c.sendOneWay !== 'function' || !this.client.isConnected()) return false;
    const ep = c.connEpoch();
    if (ep !== this.storeEpoch) {
      this.storeOn = false;
      this.putOk.clear();
      if (!this.storeAsking) {
        this.storeAsking = true;
        void this.client.request({ type: 'status' }, 2_000).then((a) => {
          const fs = (a as { feedStore?: { cap?: unknown } }).feedStore;
          this.storeEpoch = ep;
          this.storeOn = a.ok === true && !!fs && typeof fs.cap === 'number' && fs.cap > 0;
          this.log(`[trigger-first] feed store ${this.storeOn ? 'on: feed messages handed to the fast check once, questions name them' : 'not in this fast check: messages sent with every question'}`);
        }, () => undefined).finally(() => { this.storeAsking = false; });
      }
      return false;
    }
    return this.storeOn;
  }

  private putFeed(fresh: FeedMsg[]): void {
    try {
      if (!this.storeReady()) return;
      const ep = (this.client as LocalSimClient).connEpoch();
      const msg = { type: 'feed_put', msgs: fresh.map((m) => feedMsgWire(m)) };
      if ((this.client as LocalSimClient).sendOneWay(msg)) {
        this.storeStats.puts += fresh.length;
        for (const m of fresh) this.putOk.set(m.seq, { n: m.txs.length, epoch: ep });
        // Bounded: forget messages the order buffer no longer holds.
        const lo = this.buffer.oldest();
        if (this.putOk.size > this.settings.bufferMsgs * 2) for (const k of this.putOk.keys()) if (k < lo) this.putOk.delete(k);
      } else this.storeStats.putFails += fresh.length;
    } catch { this.storeStats.putFails += fresh.length; }
  }

  // The `msgs` part of a feed, or `refs` naming them when every one was
  // handed over on this connection.
  private feedMsgsPart(msgs: FeedMsg[]): Record<string, unknown> {
    if (msgs.length && this.storeReady()) {
      const ep = (this.client as LocalSimClient).connEpoch();
      if (msgs.every((m) => { const p = this.putOk.get(m.seq); return !!p && p.epoch === ep && p.n === m.txs.length; })) {
        this.storeStats.refQs++;
        return { refs: msgs.map((m) => [m.seq, m.txs.length]) };
      }
    }
    this.storeStats.inlineQs++;
    return { msgs: msgs.map((m) => feedMsgWire(m)) };
  }

  // A feed that names messages -> the same feed with the messages inline
  // (from the order buffer). null = one is no longer held.
  private inlineFeed(feed: Record<string, unknown>): Record<string, unknown> | null {
    const refs = feed.refs as Array<[number, number]> | undefined;
    if (!Array.isArray(refs)) return null;
    const msgs: FeedMsg[] = [];
    for (const [seq, n] of refs) {
      const m = this.buffer.get(seq);
      if (!m || m.txs.length !== n) return null;
      msgs.push(m);
    }
    // Same fields in the same order, `msgs` where `refs` was.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(feed)) {
      if (k === 'refs') out.msgs = msgs.map((m) => feedMsgWire(m));
      else out[k] = v;
    }
    return out;
  }

  // Send a question that carries a feed; if the sidecar lacks a named
  // message, ask again with the messages inline (same question otherwise).
  // Also used by the entry point (execution/trigEntry.ts).
  async requestFeed(msg: Record<string, unknown>, timeoutMs: number): Promise<SidecarAnswer> {
    const t0 = this.now();
    const a = await this.client.request(msg, timeoutMs);
    const feed = msg.feed as Record<string, unknown> | undefined;
    const missing = (x: unknown) => !!x && typeof x === 'object' && (x as { unknown?: unknown }).unknown === 'feed_ref_missing';
    if (!feed || !Array.isArray(feed.refs) || !(missing(a) || missing((a as { disc?: unknown }).disc))) return a;
    this.storeStats.missing++;
    this.putOk.clear(); // what we handed over is not all there: old way until new messages are handed over
    const inline = this.inlineFeed(feed);
    const left = timeoutMs - (this.now() - t0);
    if (!inline || left < 1) return a;
    this.storeStats.resent++;
    return this.client.request({ ...msg, feed: inline }, left);
  }

  // The client the checks use: every question goes through requestFeed.
  private readonly feedClient: LocalSimClient = ((self: TriggerFirst) => ({
    request: (m: Record<string, unknown>, t?: number) => self.requestFeed(m, t ?? self.settings.timeoutMs),
    isConnected: () => self.client.isConnected(),
    get stats() { return self.client.stats; },
  }))(this) as unknown as LocalSimClient;

  // ---- the check ------------------------------------------------------------
  // Ask the fast check now. Never throws; "unknown" on any doubt.
  async check(q: TrigQuestion): Promise<TrigOutcome> {
    const requestMs = this.now();
    const unknown = (why: string, extra: Partial<TrigOutcome> = {}): TrigOutcome => ({
      sure: false, verdict: 'unknown', why, requestMs, answerMs: this.now(), seenMs: q.seenMs,
      sim: { status: 'fail', reason: localUnknownMessage(why), bucket: 'replay_unavailable' }, ...extra,
    });
    let out: TrigOutcome;
    try {
      out = await this.ask(q, requestMs, unknown);
    } catch {
      this.hour.errors++;
      out = unknown('client_error');
    }
    this.track(q, out);
    return out;
  }

  // The `feed` part of a trigger-first question for this trigger (the
  // ordered feed messages around it), or why it can't be asked. Shared by
  // the checks here and the ENTRY POINT's "which pools does it move?"
  // question (execution/trigEntry.ts). No node, no waiting.
  buildFeed(hash: string, keys: Array<string | undefined | null>): { feed: Record<string, unknown>; seq: number } | { why: string; seq?: number } {
    const s = this.settings;
    const c2 = this.o.copy2();
    if (!c2 || !c2.running()) return { why: 'copy2_not_running' };
    const h = (hash ?? '').toLowerCase();
    const seq = this.buffer.seqOf(h);
    if (seq === undefined) return { why: 'trigger_not_in_buffer' };
    // Copy 2 saw the trigger's pool reports in a block: it must be the
    // block its feed sequence number says (else the two can't be lined up).
    const seenBlock = c2.forwarder.txBlockOf(h);
    if (seenBlock !== null && seenBlock !== seq + s.l2Offset) { this.hour.alignMismatch++; return { why: 'alignment', seq }; }
    // Which messages to send: from a little before the copy's newest block
    // (or the trigger, if older) up to the newest message we hold. The
    // fast check uses only those after its own version, and says
    // "feed_gap" if they don't reach back far enough.
    const newest = this.buffer.newest();
    const c2Block = c2.forwarder.newestBlock();
    const c2Seq = c2Block >= 0 ? c2Block - s.l2Offset : seq;
    let from = Math.min(seq, c2Seq) - s.backMsgs;
    from = Math.max(from, newest - s.maxMsgs + 1);
    if (from > seq) return { why: 'trigger_too_old', seq };
    const msgs = this.buffer.range(from, newest);
    const feed = {
      trigger: h, triggerSeq: seq,
      // The messages, or (feed store) their names: see requestFeed.
      ...this.feedMsgsPart(msgs),
      // Best effort: our route (which feed transactions could matter) and
      // which assumptions are allowed (strict = none at all).
      route: keys.filter((k): k is string => typeof k === 'string' && /^0x[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$/.test(k)).map((k) => k.toLowerCase()),
      strict: s.strict,
      assume: s.strict ? [] : s.assume,
    };
    return { feed, seq };
  }

  // ENTRY POINT (execution/trigEntry.ts): the same check as check(), NOT
  // counted or logged here (the entry point keeps its own numbers and log
  // line, so many candidate trades on one trigger don't overwrite this
  // file's per-trigger record). `sizes`: other trade amounts to try on the
  // same replay (size ladder), answered in `ladder`.
  // `canned` (one trip): read the sidecar's answer from the combined
  // question instead of asking again; everything else is the same code.
  // Entry checks are marked `prio` (the sidecar's fast lane, sim/src/jobq.rs).
  async askOnly(q: TrigQuestion, sizes?: bigint[], canned?: CannedAnswer): Promise<TrigOutcome> {
    const requestMs = this.now();
    const unknown = (why: string, extra: Partial<TrigOutcome> = {}): TrigOutcome => ({
      sure: false, verdict: 'unknown', why, requestMs, answerMs: this.now(), seenMs: q.seenMs,
      sim: { status: 'fail', reason: localUnknownMessage(why), bucket: 'replay_unavailable' }, ...extra,
    });
    try { return await this.ask(q, requestMs, unknown, sizes, canned, true); } catch { return unknown('client_error'); }
  }

  // ONE TRIP TABLE (execution/trigEntry.ts): the exact check question this
  // trade would send (same code path as a real check: our contract's
  // calldata, pretend state, size ladder), WITHOUT asking anything about it.
  // The token's balance location may be looked up from the sidecar (once
  // per token, like any check). null = it couldn't be worked out.
  async capture(q: TrigQuestion, sizes?: bigint[]): Promise<CapturedCheck | null> {
    try {
      let got: CapturedCheck | null = null;
      const ladderReq = sizes?.length ? { amountOffset: 96, amounts: sizes.slice(0, 8).map((a) => '0x' + a.toString(16)) } : undefined;
      const plain = makeLocalRpc(this.client, undefined, { timeoutMs: 300 });
      const rpc = async (method: string, params: unknown[]) => {
        const p = (params ?? []) as any[];
        if (method === 'eth_call' && String(p[0]?.to ?? '').toLowerCase() === SIM_EXECUTOR_ADDRESS) {
          got = { calls: [p[0]], overrides: (p[2] ?? {}) as Record<string, unknown>, ...(ladderReq ? { sizes: ladderReq } : {}), data: String(p[0]?.data ?? '') };
          return { error: { message: localUnknownMessage('captured') } };
        }
        return plain(method, params);
      };
      await withDeadline(simulateRoundTrip(rpc as any, 'robinhood', q.trade, { ...q.simOpts, slotReadOnly: true }), 2_000);
      return got;
    } catch { return null; }
  }

  // ENTRY POINT: the later same-block re-check of one answer (the same one
  // check() runs for its own triggers, same hourly budget). Fields as in
  // the trig_first line: agree / agV / same / agSkip, rblk, rAfterMs.
  // agP: the re-check's profit (start-coin units) when it said profit, so
  // the entry point can log the re-check's net too.
  async agreeLater(q: TrigQuestion, out: TrigOutcome): Promise<{ agree?: boolean; agV?: Verdict; agP?: bigint; same?: boolean; agSkip?: string; rblk?: number; rAfterMs?: number }> {
    const rec: TrigRecord = { hash: q.triggerHash.toLowerCase(), label: q.label, out, written: false };
    if (this.settings.mode === 'off' || !this.client.isConnected()) return { agSkip: 'off or disconnected' };
    await this.afterReports(q, rec);
    return { agree: rec.agree, agV: rec.agreeVerdict, agP: rec.agreeProfit, same: rec.sameState, agSkip: rec.agreeSkipped, rblk: rec.reportBlock ?? undefined, rAfterMs: rec.reportMs !== undefined ? rec.reportMs - out.answerMs : undefined };
  }

  private async ask(q: TrigQuestion, requestMs: number, unknown: (why: string, extra?: Partial<TrigOutcome>) => TrigOutcome, sizes?: bigint[], canned?: CannedAnswer, prio = false): Promise<TrigOutcome> {
    const s = this.settings;
    if (s.mode === 'off') return unknown('off');
    if (!canned && !this.client.isConnected()) return unknown('disconnected');
    const c2 = this.o.copy2();
    if (!c2 || !c2.running()) return unknown('copy2_not_running');
    const nr = c2.notReadyWhy(q.keys);
    if (nr) return unknown(`copy2_${nr.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`.slice(0, 40));
    // One trip: the feed was already replayed in the combined question.
    let feed: Record<string, unknown> = {};
    let seq: number;
    if (canned) seq = canned.seq;
    else {
      const built = this.buildFeed(q.triggerHash, q.keys);
      if ('why' in built) return unknown(built.why, built.seq !== undefined ? { triggerSeq: built.seq } : {});
      ({ feed, seq } = built);
    }
    // One trip: a stand-in connection that hands back the combined
    // question's answer for OUR call (only if it is exactly the call the
    // table sent), and "unknown" for anything else.
    const client: LocalSimClient = canned ? ({
      isConnected: () => true,
      stats: { fallbacks: 0 },
      request: async (m: Record<string, unknown>) => {
        const c = (m.calls as Array<{ to?: string; data?: string }> | undefined)?.[0];
        if (c?.to?.toLowerCase() !== SIM_EXECUTOR_ADDRESS || checkSig(c?.data, m.overrides, m.sizes) !== canned.sig) return { ok: false, unknown: 'one_trip_mismatch' };
        const a = canned.answer as Record<string, unknown>;
        return a.ok === true ? a : { ...a, ok: false, unknown: typeof a.unknown === 'string' ? a.unknown : 'sidecar_error' };
      },
    } as unknown as LocalSimClient) : this.feedClient;
    const hop: NonNullable<TrigOutcome['hop']> = {};
    // Size ladder (entry point): amountIn is the 4th 32-byte word after the
    // 4-byte code of both executor calls (localSimHost.ts sizeSearch).
    const ladderReq = sizes?.length ? { sizes: { amountOffset: 96, amounts: sizes.slice(0, 8).map((a) => '0x' + a.toString(16)) } } : {};
    let ladder: TrigLadderRow[] | undefined;
    let info: TrigInfo | undefined;
    let missing: WarmItem[] = [];
    let insideMs: number | undefined;
    const rpc = makeLocalRpc(client, undefined, {
      timeoutMs: s.timeoutMs,
      at: { after: 'head' },
      extra: { feed, ...ladderReq, ...(prio ? { prio: true } : {}) },
      onSend: (_m: string, sent: Record<string, unknown>) => {
        const call = (sent.calls as Array<{ to?: string }> | undefined)?.[0];
        if (!canned && call?.to?.toLowerCase() === SIM_EXECUTOR_ADDRESS) hop.s = performance.now();
      },
      onReply: (_m: string, a: SidecarAnswer, sent: Record<string, unknown>) => {
        const call = (sent.calls as Array<{ to?: string }> | undefined)?.[0];
        if (call?.to?.toLowerCase() !== SIM_EXECUTOR_ADDRESS) return;
        if (!canned) hop.a = performance.now();
        const tq = (a as { t?: { queue?: unknown } }).t?.queue;
        if (typeof tq === 'number') hop.q = Math.round(tq / 10) / 100;
        if (typeof a.us === 'number') hop.w = Math.round(a.us / 10) / 100;
        if (typeof a.us === 'number') insideMs = Math.round(a.us / 100) / 10;
        if (a.ok === true) info = (a as { trig?: TrigInfo }).trig;
        if (a.ok === true) ladder = readLadder((a as { sizes?: unknown }).sizes);
        else missing = Array.isArray((a as { missing?: unknown[] }).missing) ? ((a as { missing?: WarmItem[] }).missing ?? []) : [];
      },
    });
    const sim = await withDeadline(simulateRoundTrip(rpc, 'robinhood', q.trade, { ...q.simOpts, slotReadOnly: true }), s.deadlineMs);
    if (!sim) return unknown('deadline', { triggerSeq: seq, insideMs, hop });
    const verdict = verdictOf(sim);
    if (missing.length) this.warmer.offer(missing);
    if (verdict === 'unknown') return { ...unknown(unknownWhy(sim), { triggerSeq: seq, insideMs, hop }), sim };
    // How sure (an older fast check sends no confidence: exact = high).
    const ti = info as TrigInfo | undefined;
    const confidence: TrigConfidence = ti?.conf === 'medium' || ti?.conf === 'low' ? ti.conf : 'high';
    const assumptions = Array.isArray(ti?.assumed) ? ti!.assumed!.filter((x) => typeof x === 'string').slice(0, 8) : [];
    return { sure: true, sim, verdict, requestMs, answerMs: this.now(), seenMs: q.seenMs, triggerSeq: seq, info, insideMs, confidence, assumptions, hop, ...(ladder ? { ladder } : {}) };
  }

  // ---- what happened next (for the log) -------------------------------------
  private track(q: TrigQuestion, out: TrigOutcome): void {
    try {
      const h = this.hour;
      h.seen++;
      if (out.sure) {
        if (out.verdict === 'profit') h.profit++; else if (out.verdict === 'loss') h.loss++; else h.fail++;
        h.conf[out.confidence ?? 'high']++;
        if (out.info?.included) h.included++;
        h.replayedTxs += out.info?.txs ?? 0;
      } else {
        h.unknown++;
        const w = out.why ?? 'unknown';
        h.unknownWhy[w] = (h.unknownWhy[w] ?? 0) + 1;
        if (STATE_REASONS.has(w)) h.stateMissing++;
      }
      h.ansMs.push(out.answerMs - out.seenMs);
      if (h.ansMs.length > 5_000) h.ansMs.shift();
      const hash = q.triggerHash.toLowerCase();
      const rec: TrigRecord = { hash, label: q.label, out, written: false };
      this.recs.set(hash, rec);
      if (this.recs.size > 2_000) { const first = this.recs.keys().next().value as string; this.finish(first); }
      // The trigger's block reports (no node): when they arrive, and the
      // same trade re-checked on the report-based copy at that block.
      if (this.settings.mode !== 'off' && this.client.isConnected()) void this.afterReports(q, rec);
      const t = setTimeout(() => this.finish(hash), this.settings.finalizeMs);
      t.unref?.();
    } catch { this.hour.errors++; }
  }

  private async afterReports(q: TrigQuestion, rec: TrigRecord): Promise<void> {
    try {
      const c2 = this.o.copy2();
      if (!c2) { rec.agreeSkipped = 'no copy 2'; return; }
      const blk = await c2.waitForTx(rec.hash, this.settings.agreeWaitMs);
      rec.reportBlock = blk;
      if (blk === null) { rec.agreeSkipped = 'trigger block reports not seen'; return; }
      rec.reportMs = this.now();
      if (rec.out.triggerSeq !== undefined && blk !== rec.out.triggerSeq + this.settings.l2Offset) this.hour.alignMismatch++;
      if (!rec.out.sure) { rec.agreeSkipped = 'answer was unknown'; return; }
      const t = this.now();
      this.agreeTimes = this.agreeTimes.filter((x) => t - x < 3_600_000);
      if (this.agreeTimes.length >= this.settings.agreePerHour) { rec.agreeSkipped = 'hourly re-check budget used'; return; }
      this.agreeTimes.push(t);
      // The same exact trade, on copy 2's report-based version of the
      // trigger's block (no feed replay at all).
      const rpc = makeLocalRpc(this.client, undefined, { timeoutMs: Math.max(this.settings.timeoutMs, 200), at: { block: '0x' + blk.toString(16) } });
      const r = await withDeadline(simulateRoundTrip(rpc, 'robinhood', q.trade, { ...q.simOpts, slotReadOnly: true }), 2_000);
      const v = verdictOf(r);
      rec.agreeVerdict = v;
      if (r && r.status === 'profit') rec.agreeProfit = r.profit;
      if (v === 'unknown') { rec.agreeSkipped = `re-check unknown (${r ? unknownWhy(r) : 'deadline'})`; return; }
      rec.agree = v === rec.out.verdict;
      // Exactly the same state: nothing after the trigger was replayed and
      // the trigger's block is the last message replayed (or held).
      const i = rec.out.info;
      rec.sameState = !!i && (i.later ?? 0) === 0 && i.lastSeq !== undefined && i.lastSeq + this.settings.l2Offset === blk;
    } catch { rec.agreeSkipped = 'error'; }
  }

  // Shadow: the existing path reached its decision for this trigger.
  noteExisting(hash: string | undefined, decidedMs: number, verdict: string): void {
    try {
      const rec = hash ? this.recs.get(hash.toLowerCase()) : undefined;
      if (!rec || rec.existingMs !== undefined) return;
      rec.existingMs = decidedMs;
      rec.existingVerdict = verdict;
    } catch { /* reporting only */ }
  }

  // On: this answer decided the trade; signedMs = when it was signed.
  noteDecided(hash: string | undefined): void {
    const rec = hash ? this.recs.get(hash.toLowerCase()) : undefined;
    if (rec) rec.decided = true;
  }
  noteSubmitted(hash: string | undefined, signedMs: number): void {
    try {
      const rec = hash ? this.recs.get(hash.toLowerCase()) : undefined;
      if (rec && rec.submittedMs === undefined) rec.submittedMs = signedMs;
    } catch { /* reporting only */ }
  }

  // Write one trigger's line and count its timing / agreement.
  finish(hash: string): void {
    try {
      const rec = this.recs.get(hash);
      if (!rec || rec.written) return;
      rec.written = true;
      this.recs.delete(hash);
      const h = this.hour;
      const o = rec.out;
      const keep = (a: number[], v: number) => { a.push(v); if (a.length > 5_000) a.shift(); };
      if (rec.submittedMs !== undefined) keep(h.submitMs, rec.submittedMs - o.seenMs);
      // How much earlier than the report-based path:
      //   shadow: the existing path's decision time minus our answer time
      //   on:     the trigger's block reports arriving minus our submit time
      let earlier: number | undefined;
      if (rec.submittedMs !== undefined && rec.reportMs !== undefined) earlier = rec.reportMs - rec.submittedMs;
      else if (rec.existingMs !== undefined && o.sure) earlier = rec.existingMs - o.answerMs;
      if (earlier !== undefined) keep(h.earlierMs, earlier);
      if (rec.reportMs !== undefined) keep(h.reportAfterAnswerMs, rec.reportMs - o.answerMs);
      if (rec.decided) h.decided++;
      if (rec.agree === true) { h.agree++; if (rec.sameState) h.sameAgree++; }
      else if (rec.agree === false) { h.disagree++; if (rec.sameState) h.sameDisagree++; }
      else if (o.sure) h.notCompared++;
      // Agreement split by confidence and by assumption kind: which
      // assumptions are safe.
      if (rec.agree !== undefined) {
        const add = (m: Record<string, [number, number]>, k: string) => { const v = m[k] ?? (m[k] = [0, 0]); if (rec.agree) v[0]++; v[1]++; };
        add(h.agreeByConf, o.confidence ?? 'high');
        const kinds = [...new Set((o.assumptions ?? []).map((a) => a.split(':')[0]))];
        for (const k of kinds.length ? kinds : ['exact']) add(h.agreeByAssume, k);
      }
      this.o.shadowLog.add({
        t: this.now(), k: 'trig_first', mode: this.settings.mode, dec: rec.decided ? 'trig_first' : undefined,
        pair: rec.label, tx: short(rec.hash), seq: o.triggerSeq,
        // the answer
        v: o.verdict, p: o.sim.status === 'profit' ? o.sim.profit : undefined, r: reasonOf(o.sim), u: o.sure ? undefined : o.why,
        // best effort: how sure, what was assumed, feed transactions left out
        conf: o.sure ? o.confidence : undefined, as: o.assumptions?.length ? o.assumptions : undefined, skp: o.info?.skipped || undefined,
        // what was replayed (sidecar): copy block, trigger already in it,
        // messages / txs replayed, txs after the trigger, trigger reverted?
        snap: o.info?.snapBlock, incl: o.info?.included, trigOk: o.info?.triggerOk, msgs: o.info?.msgs, txs: o.info?.txs, later: o.info?.later,
        // timing (ms): feed seen -> answer, sidecar's own time, feed seen -> signed
        ansMs: o.answerMs - o.seenMs, lus: o.insideMs, subMs: rec.submittedMs !== undefined ? rec.submittedMs - o.seenMs : undefined,
        // the existing path (shadow): its verdict and how much later it decided
        exV: rec.existingVerdict, exMs: rec.existingMs !== undefined ? rec.existingMs - o.seenMs : undefined, earlierMs: earlier,
        // the trigger's block reports: block, ms after our answer
        rblk: rec.reportBlock ?? undefined, rAfterMs: rec.reportMs !== undefined ? rec.reportMs - o.answerMs : undefined,
        // later re-check of the same trade on the report-based copy at that block
        agree: rec.agree, agV: rec.agreeVerdict, same: rec.sameState, agSkip: rec.agreeSkipped,
        seen: o.seenMs, sent: o.requestMs, ans: o.answerMs,
      });
    } catch { this.hour.errors++; }
  }

  // ---- hourly line ------------------------------------------------------------
  // "[trigger-first] hour: shadow: 40 triggers, answered 22 (55%: profit 3,
  //  loss 12, fail 7), required state there 80%, unknown: miss 10, ...;
  //  feed->answer p50 9 ms p90 30 ms; earlier than the existing path p50
  //  410 ms; later same-block re-checks agree 20/21 (same state 15/15);
  //  warming 12 node requests (budget 60/h)"
  takeHourLine(): string | null {
    try {
      for (const k of [...this.recs.keys()]) { const r = this.recs.get(k); if (r && this.now() - r.out.answerMs >= this.settings.finalizeMs) this.finish(k); }
      const h = this.hour;
      this.hour = this.freshHour();
      if (this.settings.mode === 'off') return null;
      const w = this.warmer;
      const warm = `warming ${w.usedRpc} node requests (upper bound; budget ${this.settings.warmRpcPerHour}/h), ${w.sentItems} items${w.skippedBudget ? `, ${w.skippedBudget} over budget` : ''}`;
      if (!h.seen) {
        const line = `Trigger-first (${this.settings.mode}): no triggers this hour; buffer ${this.buffer.size()} feed messages; ${warm}`;
        this.log(`[trigger-first] hour: ${line}`);
        return line;
      }
      const ans = h.profit + h.loss + h.fail;
      const whys = Object.entries(h.unknownWhy).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ${n}`).join(', ');
      const ms = (xs: number[]) => (xs.length ? `p50 ${pctl(xs, 0.5)} ms, p90 ${pctl(xs, 0.9)} ms` : 'n/a');
      const parts = [
        `${h.seen} triggers`,
        `answered ${ans} (${pct(ans, h.seen)}: profit ${h.profit}, loss ${h.loss}, fail ${h.fail}; trigger already in the copy ${h.included}; confidence high ${h.conf.high}, medium ${h.conf.medium}, low ${h.conf.low})`,
        `required state there ${pct(h.seen - h.stateMissing, h.seen)}`,
        `feed->answer ${ms(h.ansMs)}`,
      ];
      if (h.submitMs.length) parts.push(`feed->submit ${ms(h.submitMs)}`);
      if (h.earlierMs.length) parts.push(`earlier than the report-based path ${ms(h.earlierMs)}`);
      if (h.reportAfterAnswerMs.length) parts.push(`trigger's block reports came ${ms(h.reportAfterAnswerMs)} after our answer`);
      parts.push(`later same-block re-checks agree ${h.agree}/${h.agree + h.disagree} (exact same state ${h.sameAgree}/${h.sameAgree + h.sameDisagree})${h.notCompared ? `, not compared ${h.notCompared}` : ''}`);
      const split = (m: Record<string, [number, number]>) => Object.entries(m).sort((a, b) => b[1][1] - a[1][1]).map(([k, [a, n]]) => `${k} ${a}/${n}`).join(', ');
      if (h.agree + h.disagree) parts.push(`agree by confidence: ${split(h.agreeByConf)}; by assumption: ${split(h.agreeByAssume)}`);
      if (this.settings.mode === 'on') parts.push(`decided ${h.decided}${h.heldBack ? `, held back by the confidence floor (${this.settings.minConfidence}) ${h.heldBack}` : ''}`);
      if (this.steppedBackUntil()) parts.push(`STEPPED BACK to practice until ${new Date(this.stepBackUntil).toISOString().slice(11, 16)} UTC`);
      if (h.alignMismatch) parts.push(`ALIGNMENT MISMATCH ${h.alignMismatch} (feed sequence vs block: check ARBSIM_L2_BLOCK_OFFSET)`);
      parts.push(warm);
      const line = `Trigger-first (${this.settings.mode}): ${parts.join('; ')}`;
      this.log(`[trigger-first] hour: ${line}${whys ? ` | unknown because: ${whys}` : ''}${h.errors ? ` | errors ${h.errors}` : ''}`);
      return line;
    } catch { return null; }
  }
}
