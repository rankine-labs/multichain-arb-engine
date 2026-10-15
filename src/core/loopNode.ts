import type { Rpc, SimResult, ReplayCall } from '../execution/simulator';
import { isRateLimited } from '../execution/simulator';
import type { LoopTrade, LoopCheckResult } from './loopTrader';

// ============================================================================
// LOOP CHECK NODE (Oct 15, owner approved). PRACTICE ONLY, NEVER SENDS.
//
// Plain English:
//   Loop practice checks used to run on the main checking node (Chainstack)
//   and took one of the 2-pool check line's two slots for 1-3 seconds each.
//   2-pool checks then waited too long and were dropped ("waited too long in
//   the check line"). Now loop checks run on their OWN node, by default the
//   free public Robinhood node, and Chainstack is kept for 2-pool checks only.
//
// Switches (.env):
//   LOOP_CHECK_NODE=free   (default) loop checks on the free public node
//   LOOP_CHECK_NODE=main   old behaviour: loop checks on the main checking
//                          node, sharing the 2-pool check line
//   LOOP_CHECK_RPC=<url>   (only with free) use this node instead of the
//                          free public one. The URL is never logged.
//   LOOP_CHECK_DAILY       most loop checks a day on the loop node
//                          (default 3000, 0 = no daily limit). Toronto day.
//
// The free node has other jobs (price reads, the gentle pool scan, second
// opinions for 2-pool checks). To protect them, the loop node gets its own
// "slow down" guard: when it says "too many requests" (or can't be reached),
// loop checks pause 60 s, then 2 min, 4 min... up to 10 min if it keeps
// happening. One clean check resets the pause back to 60 s.
//
// Not every node supports the replay method (eth_simulateV1). The first time
// a loop needs a replay, the node is asked once. If it doesn't have the
// method, loops skip the replay and test at the end of the trigger's block
// (or on the latest block), and the hourly line says "replay not supported
// on loop node". The question is not repeated more than once per 10 min
// while the answer is unclear (busy node), and never again once known.
// ============================================================================

export type LoopNodeMode = 'free' | 'main';

export interface LoopNodeConfig {
  mode: LoopNodeMode;
  customUrl: string | null;   // LOOP_CHECK_RPC (free mode only); never logged
  label: string;              // plain name for logs, never a URL
  dailyCap: number;           // LOOP_CHECK_DAILY, Infinity = no limit
  backoffStartMs: number;     // first pause after "slow down" (60 s)
  backoffMaxMs: number;       // longest pause (10 min)
}

// Reads the switches. A typo in LOOP_CHECK_NODE means the safe default (free)
// with a warning, so Chainstack is never used for loops by accident.
export function loopNodeFromEnv(env: Record<string, string | undefined> = process.env, warn: (m: string) => void = console.warn): LoopNodeConfig {
  const raw = (env.LOOP_CHECK_NODE ?? '').trim().toLowerCase();
  let mode: LoopNodeMode = 'free';
  if (raw === 'main') mode = 'main';
  else if (raw !== '' && raw !== 'free') warn(`[loop] LOOP_CHECK_NODE=${env.LOOP_CHECK_NODE} is not "free" or "main", using free`);
  const url = (env.LOOP_CHECK_RPC ?? '').trim();
  let customUrl: string | null = null;
  if (url) {
    if (mode === 'main') warn('[loop] LOOP_CHECK_RPC is ignored because LOOP_CHECK_NODE=main');
    else if (!/^https?:\/\//i.test(url)) warn('[loop] LOOP_CHECK_RPC is not an http(s) address, using the free public node');
    else customUrl = url;
  }
  const d = Number(env.LOOP_CHECK_DAILY ?? 3_000);
  const dailyCap = !Number.isFinite(d) || d < 0 ? 3_000 : d === 0 ? Infinity : Math.round(d);
  const label = mode === 'main' ? 'main checking node' : customUrl ? 'own node (LOOP_CHECK_RPC)' : 'free public node';
  return { mode, customUrl, label, dailyCap, backoffStartMs: 60_000, backoffMaxMs: 10 * 60_000 };
}

// Does this error mean "this node has no such method"? (eth_simulateV1 missing)
export function isMethodMissing(err: { code?: number; message?: string } | undefined): boolean {
  if (!err) return false;
  if (err.code === -32601) return true;
  return /method .*(not found|does not exist|not supported|not available|is not)|unsupported method|unknown method|no such method|not whitelisted/i.test(err.message ?? '');
}

export type ReplaySupport = 'unknown' | 'yes' | 'no';

// Numbers for the hourly loop line.
export interface LoopNodeHour {
  label: string;
  mode: LoopNodeMode;
  replay: ReplaySupport;
  rateLimited: number;        // "slow down" / unreachable answers seen this hour
  pauses: number;             // loop pauses started this hour
  pausedForMs: number;        // pause time left right now (0 = not paused)
  today: number;              // loop checks started today on the loop node
  dailyCap: number;
  busySkips?: number;         // checks skipped because the shared node was busy (LoopNodeThrottle)
}

// Plain one-liner for the hourly / 15 minute loop line and Telegram.
export function loopNodeText(h: LoopNodeHour): string {
  if (h.mode === 'main') return 'loop node main checking node';
  const replay = h.replay === 'yes' ? 'replay ok' : h.replay === 'no' ? 'replay not supported on loop node' : 'replay not tested yet';
  const parts = [`loop node ${h.label} (${replay})`, `rate limited ${h.rateLimited}`, `paused ${h.pauses}`];
  if (h.pausedForMs > 0) parts.push(`paused now ${Math.ceil(h.pausedForMs / 1_000)} s`);
  if (h.busySkips) parts.push(`skipped node busy ${h.busySkips}`);
  parts.push(`today ${h.today}${Number.isFinite(h.dailyCap) ? `/${h.dailyCap}` : ''}`);
  return parts.join(', ');
}

const torontoDay = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });

// The guard for the loop node: pauses, daily limit, replay support.
// Only used when LOOP_CHECK_NODE is free (main mode = old behaviour).
export class LoopNodeGuard {
  private pausedUntil = 0;
  private backoffMs: number;
  private limitedThisCheck = false;
  private day: string;
  private today = 0;
  private hour = { rateLimited: 0, pauses: 0 };
  replay: ReplaySupport = 'unknown';
  private nextProbeAt = 0;
  private probing: Promise<void> | null = null;

  constructor(
    readonly cfg: LoopNodeConfig,
    private readonly now: () => number = Date.now,
    private readonly log: (m: string) => void = console.log,
    private readonly dayOf: (ms: number) => string = torontoDay,
  ) {
    this.backoffMs = cfg.backoffStartMs;
    this.day = dayOf(now());
  }

  private rollDay() { const d = this.dayOf(this.now()); if (d !== this.day) { this.day = d; this.today = 0; } }

  // May a loop check start now? (not paused, daily limit not reached)
  canCheck(): boolean {
    this.rollDay();
    return this.now() >= this.pausedUntil && this.today < this.cfg.dailyCap;
  }

  // A loop check is starting on the loop node.
  noteStart(): void { this.rollDay(); this.today++; this.limitedThisCheck = false; }

  // The node said "slow down" (or could not be reached). Starts a pause unless
  // one is already running (several answers in one check = one pause).
  noteRateLimit(): void {
    this.hour.rateLimited++;
    this.limitedThisCheck = true;
    const t = this.now();
    if (t < this.pausedUntil) return;
    this.pausedUntil = t + this.backoffMs;
    this.hour.pauses++;
    this.log(`[loop] ${this.cfg.label} said slow down: loop checks paused ${Math.round(this.backoffMs / 1_000)} s (2-pool checks not affected)`);
    this.backoffMs = Math.min(this.cfg.backoffMaxMs, this.backoffMs * 2);
  }

  // The check finished. A clean one (no "slow down" during it) resets the
  // pause length back to 60 s. A node that can't do state overrides at all
  // pauses loop checks for 30 min (same rule as the 2-pool checker).
  noteResult(r: SimResult): void {
    if (r.status === 'rate_limited') { this.noteRateLimit(); return; }
    if (r.status === 'unsupported' && /override|does not support/i.test(r.reason)) {
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + 30 * 60_000);
      this.hour.pauses++;
      this.log(`[loop] ${this.cfg.label} can't run practice checks (${r.reason.slice(0, 80)}): loop checks paused 30 min`);
      return;
    }
    if (!this.limitedThisCheck) this.backoffMs = this.cfg.backoffStartMs;
  }

  private markNoReplay(): void {
    if (this.replay === 'no') return;
    this.replay = 'no';
    this.log(`[loop] replay not supported on loop node (${this.cfg.label}): loops test at the end of the trigger's block instead`);
  }

  // Wraps the loop node so every answer is watched: "slow down" answers start
  // a pause, and a "no such method" answer to eth_simulateV1 marks replay as
  // not supported. Answers themselves pass through unchanged.
  watch(rpc: Rpc): Rpc {
    return async (method, params) => {
      const r = await rpc(method, params);
      if (r.error) {
        if (isRateLimited(r.error) || (r.error.message ?? '').startsWith('network:')) this.noteRateLimit();
        else if (method === 'eth_simulateV1' && isMethodMissing(r.error)) this.markNoReplay();
      } else if (method === 'eth_simulateV1' && this.replay === 'unknown') this.replay = 'yes';
      return r;
    };
  }

  // Asks the node ONCE whether it has eth_simulateV1 (an empty replay on the
  // latest block). Busy / unreachable = still unknown, asked again at most
  // once per 10 min (replays are still tried meanwhile and fall back cleanly).
  async probeReplay(rpc: Rpc): Promise<ReplaySupport> {
    if (this.replay !== 'unknown' || this.now() < this.nextProbeAt) return this.replay;
    if (!this.probing) {
      this.nextProbeAt = this.now() + 10 * 60_000;
      this.probing = (async () => {
        try {
          const r = await rpc('eth_simulateV1', [{ blockStateCalls: [{ calls: [] }] }, 'latest']);
          if (!r.error) this.replay = 'yes';
          else if (isMethodMissing(r.error)) this.markNoReplay();
          else if (isRateLimited(r.error) || (r.error.message ?? '').startsWith('network:')) { /* unclear: ask later */ }
          else this.replay = 'yes'; // the method exists (it just didn't like the empty test)
          if (this.replay === 'yes') this.log(`[loop] ${this.cfg.label} supports replay (eth_simulateV1)`);
        } catch { /* unclear: ask later */ }
        finally { this.probing = null; }
      })();
    }
    await this.probing;
    return this.replay;
  }

  private snapshot(): LoopNodeHour {
    this.rollDay();
    return { label: this.cfg.label, mode: this.cfg.mode, replay: this.replay, rateLimited: this.hour.rateLimited, pauses: this.hour.pauses,
      pausedForMs: Math.max(0, this.pausedUntil - this.now()), today: this.today, dailyCap: this.cfg.dailyCap };
  }
  // The hour so far (nothing reset).
  peekHour(): LoopNodeHour { return this.snapshot(); }
  // The hour's numbers, and start a new hour (today's count is kept).
  takeHour(): LoopNodeHour { const s = this.snapshot(); this.hour = { rateLimited: 0, pauses: 0 }; return s; }
}

// ----------------------------------------------------------------------------
// LOOP NODE THROTTLE (Oct 15, owner approved). Price reads for 2-pool trades
// (the money path) share the free node's speed limit (8 a second). Loops must
// never slow them down, so EVERY loop request first passes this gate:
//   1. loops' own limit: at most LOOP_NODE_MAX_RPS (default 2) requests in
//      any one second;
//   2. the shared allowance must have room: nobody waiting in its queue,
//      under half its speed limit used in the last second, and a free slot
//      right now. So a loop request never waits in the shared queue, and is
//      never placed ahead of a price read.
// If the gate stays shut, the request waits in small steps, up to 2 s in
// total per loop check. After that the check gives up quietly: "skipped:
// node busy" (counted in the hour line, NOT a "slow down" pause).
// ----------------------------------------------------------------------------
export interface SharedHeadroom { pending: number; usedLastSec: number; tokens: number; rps: number }

// Thrown when a loop check gave up waiting (caught in shadowMain loopCheck).
export class LoopNodeBusy extends Error { constructor() { super('skipped: node busy'); } }

export function loopMaxRpsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.LOOP_NODE_MAX_RPS ?? 2);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 50) : 2;
}

export class LoopNodeThrottle {
  private sent: number[] = [];   // when loop requests went out (last second)
  private waitedMs = 0;          // waited so far in the current loop check
  busySkips = 0;                 // checks given up this hour (read by the hour line)

  constructor(
    readonly maxRps: number,
    private readonly shared: () => SharedHeadroom | null,   // null = node with no shared allowance
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    readonly maxWaitMs = 2_000,
    private readonly stepMs = 50,
  ) {}

  // A new loop check: its 2 s waiting allowance starts again.
  beginCheck(): void { this.waitedMs = 0; }

  // Is the shared allowance quiet enough for a loop request?
  sharedHasRoom(): boolean {
    const h = this.shared();
    if (!h) return true;
    return h.pending === 0 && h.usedLastSec < 0.5 * h.rps && h.tokens >= 1;
  }

  private ownHasRoom(t: number): boolean {
    while (this.sent.length && t - this.sent[0] >= 1_000) this.sent.shift();
    return this.sent.length < this.maxRps;
  }

  // Waits for the gate, or throws LoopNodeBusy after 2 s of waiting in this check.
  async gate(): Promise<void> {
    for (;;) {
      const t = this.now();
      if (this.ownHasRoom(t) && this.sharedHasRoom()) { this.sent.push(t); return; }
      if (this.waitedMs + this.stepMs > this.maxWaitMs) throw new LoopNodeBusy();
      this.waitedMs += this.stepMs;
      await this.sleep(this.stepMs);
    }
  }

  // The loop node with the gate in front of every request.
  wrap(rpc: Rpc): Rpc {
    return async (method, params) => { await this.gate(); return rpc(method, params); };
  }

  // The hour's "skipped: node busy" count, and start a new hour.
  takeBusy(): number { const n = this.busySkips; this.busySkips = 0; return n; }
}

// ----------------------------------------------------------------------------
// ONE LOOP PRACTICE CHECK (moved here from shadowMain so it can be tested).
// Every node request goes through `rpc` (the loop node) or, only when
// secondOpinion is given, through that one. Nothing else is ever called.
//
// Order (LOOP_TRIGGER_REPLAY on and a trigger trade known):
//   1. find the trigger's block (receipt polling + block fetch)
//   2. replay that block up to the trigger, then our loop ("right after trigger")
//      - replay not possible / not supported: end of the trigger's block
//      - that block's state gone: latest ("tested late")
//   3. "breaks, no reason": plain check at the end of the trigger's block,
//      then (main mode only) the free node as a second opinion. On the free
//      node there is no other node to ask without touching Chainstack, so the
//      second opinion is skipped and the loop node's own answer is kept.
// No trigger (or replay off): one check on the latest block.
// ----------------------------------------------------------------------------
export interface LoopSpot { block: string; parent: string; prefix: ReplayCall[]; time?: string }
export interface LoopCheckDeps {
  rpc: Rpc;                                 // the loop node
  secondOpinion: Rpc | null;                // main mode: the free node; free mode: null (skipped)
  simulate: (rpc: Rpc, trade: LoopTrade, opts: { weth?: string; blockTag?: string }) => Promise<SimResult>;
  findSpot: (rpc: Rpc, hash: string) => Promise<LoopSpot | null>;
  replay: (rpc: Rpc, parent: string, prefix: ReplayCall[], time?: string) => Rpc;
  stateGone: RegExp;
  weth: string;
  triggerReplay: boolean;                   // LOOP_TRIGGER_REPLAY
  tagLatest: boolean;                       // add timing 'latest' to a no-trigger answer (replay or model-vs-check on)
  replayAllowed: () => boolean;             // false = the loop node has no eth_simulateV1
  lean: boolean;                            // free mode: don't repeat the exact same check twice
}

const noReason = (x: SimResult) => x.status === 'fail' && /execution reverted\s*$|reverted without data|TransferFailed/.test(x.reason);

export async function runLoopCheck(d: LoopCheckDeps, trade: LoopTrade, triggerHash?: string): Promise<LoopCheckResult> {
  const rpc = d.rpc;
  const simOpts = { weth: d.weth };
  const follow = d.triggerReplay && !!triggerHash && !triggerHash.includes('PLACEHOLDER');
  if (!follow) {
    const r = await d.simulate(rpc, trade, simOpts);
    // Switches off: exactly the old answer. On: say it ran on latest.
    return d.tagLatest ? { ...r, timing: 'latest' } : r;
  }
  let r: SimResult;
  let timing: string;
  let atBlock = false; // r already came from a plain check at the end of the trigger's block
  const spot = await d.findSpot(rpc, triggerHash!);
  if (spot) {
    const tryReplay = d.replayAllowed();
    if (tryReplay) {
      r = await d.simulate(d.replay(rpc, spot.parent, spot.prefix, spot.time), trade, simOpts);
      timing = 'right after trigger';
    } else {
      r = { status: 'fail', reason: 'replay unavailable (not supported on loop node)' };
      timing = '';
    }
    if ('reason' in r && (r.reason.startsWith('replay unavailable') || d.stateGone.test(r.reason))) {
      r = await d.simulate(rpc, trade, { ...simOpts, blockTag: spot.block });
      timing = 'end of trigger block';
      atBlock = true;
      if ('reason' in r && d.stateGone.test(r.reason)) { r = await d.simulate(rpc, trade, simOpts); timing = 'tested late'; atBlock = false; }
    }
  } else {
    r = await d.simulate(rpc, trade, simOpts);
    timing = 'tested late';
  }
  // "Breaks" with no real reason: second opinion (see the header).
  if (noReason(r)) {
    let r2 = !spot ? r : d.lean && atBlock ? r : await d.simulate(rpc, trade, { ...simOpts, blockTag: spot.block });
    // Free mode, answer already from the end of the block: keep its label.
    let where = spot ? (d.lean && atBlock ? timing : 'end of trigger block (replay failed)') : timing;
    if (d.secondOpinion && (r2.status === 'rate_limited' || noReason(r2) || ('reason' in r2 && d.stateGone.test(r2.reason)))) {
      const r3 = await d.simulate(d.secondOpinion, trade, simOpts);
      if (r3.status !== 'rate_limited') { r2 = r3; where = 'tested late on free node (replay failed)'; }
    }
    if (r2.status !== 'rate_limited') { r = r2; timing = where; }
  }
  return { ...r, timing };
}
