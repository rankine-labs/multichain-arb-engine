import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';
import { PoolState } from './types';
import { PoolCache } from './poolCache';
import { planBackrun } from './backrunPlanner';
import { findStandingGaps } from './gapScanner';
import { classifyFailReason, FailGroup, FAIL_GROUP_LABEL } from './failReasons';
import { buildExecuteCall } from '../execution/executorCalldata';
import { simulateRoundTrip, replayRpc, Rpc, ReplayCall, SimResult } from '../execution/simulator';

// ============================================================================
// RESEARCH LANE -- "were the ones we threw away actually worth something?"
//
// Plain English:
//   The main scanner throws away most price differences before it ever tests
//   them on the real chain: the estimated gain is under $0.50, a partner pool
//   holds under $25k, a coin isn't on the vetted list, or a standing gap is
//   under $20. An Oct 8 audit found that EVERY verified 2-pool win by rival
//   bots had an estimated gain under $0.50, so those bars may be throwing
//   away the very trades rivals are winning.
//
//   This lane takes a small random sample of those thrown-away candidates and
//   tests them on the real chain with the same free test the main checker
//   uses (simulator.ts: our contract's round trip, pretend balances, nothing
//   deployed, nothing spent). It then keeps score per "why it was thrown
//   away", so the numbers can tell us whether a bar is set too high.
//
// What it will NEVER do (by design, not by setting):
//   - send a transaction, sign anything, or call the fire/trade path
//   - add a coin to the vetted list, or treat a coin as vetted
//   - change, lower or "learn" any threshold of the main scanner
//   - touch the main scanner's counters, mute lists or route scores
//   It only reads candidates it is handed and writes its own report and file.
//
// Keeping the main scanner fast:
//   - offer() is called from the trade handler. It only flips a coin (the
//     sample rate) and drops the candidate into a small queue. All the real
//     work (planning, node calls) happens later, on the lane's own timer.
//   - Every node request the lane makes comes out of its own small allowance
//     (RESEARCH_RPC_PER_MIN, default 6 a minute), on top of the checking
//     node's own speed limit and daily allowance (core/nodeBudget.ts).
//   - It waits while the main checker is busy or paused, and stops for the
//     day when the checking node has used most of its daily allowance.
//
// Switch it on in .env:   RESEARCH_LANE=1        (default: off)
// Other settings:         RESEARCH_SAMPLE_PCT    share of rejects to test, % (default 20)
//                         RESEARCH_RPC_PER_MIN   node requests a minute (default 6)
//                         RESEARCH_FLASH=0       skip the flash-loan version of each test
//                         RESEARCH_REPLAY=0      test at the latest block instead of
//                                                right after the trigger trade
//                         RESEARCH_MIN_DEPTH_USD smallest pool worth testing (default 1000)
//                         RESEARCH_GAP_MIN_USD   smallest standing gap worth testing (default 0.25)
//                         RESEARCH_MAX_NODE_SHARE stop when the checking node has used
//                                                this share of its daily allowance (default 0.6)
// ============================================================================

// Why the main scanner rejected the candidate. One rolling score per reason.
export type ResearchReason = 'below_sim_bar' | 'shallow_pool' | 'unvetted_token' | 'gap_below_min';
export const RESEARCH_REASONS: ResearchReason[] = ['below_sim_bar', 'shallow_pool', 'unvetted_token', 'gap_below_min'];

// Plain-English name for each reason, as shown in Telegram and the log.
export const REASON_LABEL: Record<ResearchReason, string> = {
      below_sim_bar: 'estimated gain under the $0.50 check bar',
      shallow_pool: 'partner pool under the $25k depth bar',
      unvetted_token: 'coin not on the vetted list',
      gap_below_min: 'standing gap under the $20 bar',
};

// One candidate the main scanner threw away, with everything needed to test it.
export interface ResearchCandidate {
      reason: ResearchReason;
      source: 'trigger' | 'gap';   // reacting to a trade we saw, or a gap sitting between two pools
      tokenIn: string;             // the coin the round trip starts and ends with
      buyPool: PoolState;          // tokenIn -> other coin
      sellPool: PoolState;         // other coin -> tokenIn
      sizeUsd: number;             // trade size the model picked
      modelGrossUsd: number;       // gain the model estimated (before gas)
      usdPerToken: number;         // USD price of tokenIn
      vetted: boolean;             // both coins on the vetted list (informational only)
      triggerHash?: string;        // the trade we were following (trigger source only)
      note?: string;               // extra detail, e.g. the shallow pool's depth
}

// What one real-chain test said.
export type SimOutcome =
      | { kind: 'profit'; usd: number; netUsd: number }   // made money; netUsd = after gas
      | { kind: 'loss' }                                   // ended with less than it started
      | { kind: 'fail'; group: FailGroup; raw: string }    // the trade itself would revert
      | { kind: 'skipped'; why: string };                  // not a trade result (allowance, unsupported...)

// One sampled candidate and its test results (kept in the file, newest last).
export interface ResearchRecord {
      at: number;
      reason: ResearchReason;
      source: 'trigger' | 'gap';
      pair: string;
      tokenIn: string;
      buy: { dex: string; pool: string; feeBps: number };
      sell: { dex: string; pool: string; feeBps: number };
      vetted: boolean;
      sizeUsd: number;
      modelGrossUsd: number;
      timing: string;              // when in the chain the test ran
      own?: SimOutcome;            // own-money version (what rivals do, 45 of 46)
      flash?: SimOutcome;          // flash-loan version (what our live trades would do)
      lenderFeeBps?: number;       // fee of the pool lent from, flash version only
      note?: string;
}

// Rolling score for one rejection reason.
export interface ReasonStats {
      offered: number;        // rejects of this kind the main scanner handed us
      sampled: number;        // picked by the sample rate
      dropped: number;        // sampled but pushed out of the queue by newer ones
      noModelGap: number;     // planned again but no gap left in the model (no test needed)
      tested: number;         // got a real answer (made money, lost, or would fail)
      profitable: number;     // made money after gas
      unprofitable: number;   // lost, or made less than gas
      failed: Partial<Record<FailGroup, number>>; // would revert, by plain group
      skipped: number;        // couldn't be tested (allowance, unsupported coin, build problem)
      profitUsd: number;      // total simulated profit after gas, profitable tests only
      bestUsd: number;        // best single simulated profit after gas
      flashTested: number;    // flash-loan versions that got a real answer
      flashProfitable: number;
      flashProfitUsd: number;
}

export const emptyStats = (): ReasonStats => ({
      offered: 0, sampled: 0, dropped: 0, noModelGap: 0, tested: 0, profitable: 0, unprofitable: 0,
      failed: {}, skipped: 0, profitUsd: 0, bestUsd: 0, flashTested: 0, flashProfitable: 0, flashProfitUsd: 0,
});

export interface ResearchConfig {
      enabled: boolean;
      samplePct: number;        // 0-100
      rpcPerMin: number;        // node requests a minute for the whole lane
      queuePerReason: number;   // waiting candidates kept per reason (newest win)
      dedupeMs: number;         // the same route + reason is sampled at most once in this window
      flash: boolean;           // also test the flash-loan version when a lender is known
      replay: boolean;          // trigger candidates: test right after the trigger trade
      maxRecords: number;       // sample records kept in the file
      maxPlausibleShare: number;// profit above this share of the amount put in = bad data, not real
      pauseMs: number;          // rest after the node says "slow down"
      minDepthUsd: number;      // pools thinner than this aren't worth testing at all
      gapMinUsd: number;        // standing gaps smaller than this aren't worth testing
      maxNodeShare: number;     // stop when the checking node's daily allowance is this used
}

const num = (v: string | undefined, fallback: number, min = 0, max = Infinity): number => {
      const n = Number(v);
      return Number.isFinite(n) && v !== undefined && v !== '' ? Math.min(max, Math.max(min, n)) : fallback;
};

// Settings from .env. Off unless RESEARCH_LANE=1 (or "true"/"on").
export function researchConfigFromEnv(env: Record<string, string | undefined> = process.env): ResearchConfig {
      return {
            enabled: /^(1|true|on|yes)$/i.test(env.RESEARCH_LANE ?? ''),
            samplePct: num(env.RESEARCH_SAMPLE_PCT, 20, 0, 100),
            rpcPerMin: num(env.RESEARCH_RPC_PER_MIN, 6, 0, 600),
            queuePerReason: Math.floor(num(env.RESEARCH_QUEUE_PER_REASON, 4, 1, 50)),
            dedupeMs: num(env.RESEARCH_DEDUPE_MS, 2 * 60_000, 0),
            flash: env.RESEARCH_FLASH !== '0',
            replay: env.RESEARCH_REPLAY !== '0',
            maxRecords: Math.floor(num(env.RESEARCH_MAX_RECORDS, 200, 10, 5_000)),
            maxPlausibleShare: num(env.MAX_PLAUSIBLE_PROFIT_SHARE, 0.25, 0),
            pauseMs: num(env.RESEARCH_PAUSE_MS, 5 * 60_000, 0),
            minDepthUsd: num(env.RESEARCH_MIN_DEPTH_USD, 1_000, 0),
            gapMinUsd: num(env.RESEARCH_GAP_MIN_USD, 0.25, 0),
            maxNodeShare: num(env.RESEARCH_MAX_NODE_SHARE, 0.6, 0, 1),
      };
}

// ----------------------------------------------------------------------------
// The lane's own request allowance: a bucket that refills at perMin a minute
// and holds at most perMin. Never waits: if the bucket is empty the request
// is refused on the spot, so nothing ever queues up behind the lane.
// ----------------------------------------------------------------------------
export class CallBudget {
      private tokens: number;
      private last: number;
      usedHour = 0;
      usedTotal = 0;
      constructor(readonly perMin: number, private readonly now: () => number = Date.now) {
            this.tokens = perMin;
            this.last = now();
      }
      private refill() {
            const t = this.now();
            this.tokens = Math.min(this.perMin, this.tokens + ((t - this.last) / 60_000) * this.perMin);
            this.last = t;
      }
      // Whole requests available right now.
      available(): number { this.refill(); return Math.floor(this.tokens); }
      // Take n requests if there's room; false (and nothing taken) if not.
      tryTake(n = 1): boolean {
            this.refill();
            if (this.tokens < n) return false;
            this.tokens -= n;
            this.usedHour += n;
            this.usedTotal += n;
            return true;
      }
}

// Marker in the "no room" answer, so the lane can tell its own allowance
// running out apart from the node itself saying "slow down".
const BUDGET_MSG = 'research lane allowance used up (429)';

// Wraps the checking node so every request the lane makes is counted against
// the lane's allowance. "429" in the refusal makes the simulator treat it as
// "slow down", never as a trade result.
export function budgetedRpc(rpc: Rpc, budget: CallBudget): Rpc {
      return async (method, params) => {
            if (!budget.tryTake(1)) return { error: { code: 429, message: BUDGET_MSG } };
            return rpc(method, params);
      };
}

// Things the lane needs from the bot. Passed in, so the lane never reaches
// into the trade path and can be tested without a chain.
export interface ResearchDeps {
      rpc: Rpc;                                   // the checking node (same one the main checker uses)
      decimalsOf: (token: string) => number | undefined;
      symbolOf: (token: string) => string;
      // Same lender choice the main checker uses; null = none known (flash test skipped).
      pickLender: (tokenIn: string, buyPool: PoolState, sellPool: PoolState, sizeUsd: number, usdPerToken: number) =>
            { poolAddress: string; dex: string; feeBps: number } | null;
      gasUsd: () => number;                       // gas for one trade, USD
      weth: string;                               // needed for Uniswap V4 hops
      canRun: () => boolean;                      // false while the main checker is busy/paused or the node is near its daily cap
      now?: () => number;
      random?: () => number;                      // 0..1, for sampling (tests pass a fixed one)
      log?: (msg: string) => void;
      simulate?: typeof simulateRoundTrip;        // tests pass a fake
}

type Queued = { key: string; make: () => ResearchCandidate | null; at: number };

// Node can't serve an older block's state (same check the main checker uses).
const STATE_GONE = /missing trie node|historical state|state.*(not available|unavailable)|header not found|unknown block|pruned/i;
// Normal user transactions (skips Arbitrum system transactions), same as the main checker.
const USER_TX_TYPES = new Set(['0x0', '0x1', '0x2', '0x3', '0x4']);
// "Breaks" with no real reason: worth one plain re-test at the end of the block.
const noReason = (r: SimResult) => r.status === 'fail' && /execution reverted\s*$|reverted without data|TransferFailed/.test(r.reason);

export class ResearchLane {
      private queues = new Map<ResearchReason, Queued[]>();
      private recent = new Map<string, number>();      // dedupe: key -> not sampled again until
      private rr = 0;                                    // round-robin pointer over reasons
      private busy = false;
      private pausedUntil = 0;
      private hour = new Map<ResearchReason, ReasonStats>();
      private total = new Map<ResearchReason, ReasonStats>();
      private records: ResearchRecord[] = [];
      private skipWhy = new Map<string, number>();       // this hour: why tests couldn't run
      readonly budget: CallBudget;
      private readonly rpc: Rpc;
      private readonly now: () => number;
      private readonly random: () => number;
      private readonly log: (msg: string) => void;
      private readonly simulate: typeof simulateRoundTrip;

      constructor(readonly config: ResearchConfig, private readonly deps: ResearchDeps) {
            this.now = deps.now ?? Date.now;
            this.random = deps.random ?? Math.random;
            this.log = deps.log ?? ((m) => console.log(m));
            this.simulate = deps.simulate ?? simulateRoundTrip;
            this.budget = new CallBudget(config.rpcPerMin, this.now);
            this.rpc = budgetedRpc(deps.rpc, this.budget);
            for (const r of RESEARCH_REASONS) { this.hour.set(r, emptyStats()); this.total.set(r, emptyStats()); this.queues.set(r, []); }
      }

      get enabled(): boolean { return this.config.enabled; }

      // ---- Called from the main scanner (must stay cheap and never throw) ----
      // reason: why the main scanner rejected it. key: identifies the route,
      // for the "once per route per 2 min" rule (dedupeMs overrides the 2 min,
      // e.g. standing gaps sit there for minutes and only need one test).
      // make: builds the candidate later, on the lane's own time (so planning
      // never slows the scanner).
      offer(reason: ResearchReason, key: string, make: () => ResearchCandidate | null, dedupeMs = this.config.dedupeMs): void {
            if (!this.config.enabled) return;
            try {
                  this.stats(reason, (s) => { s.offered++; });
                  if (!(this.random() * 100 < this.config.samplePct)) return;
                  const now = this.now();
                  const k = `${reason}|${key.toLowerCase()}`;
                  if (now < (this.recent.get(k) ?? -Infinity)) return;
                  this.recent.set(k, now + dedupeMs);
                  if (this.recent.size > 5_000) for (const [rk, until] of this.recent) if (now >= until) this.recent.delete(rk);
                  const q = this.queues.get(reason)!;
                  q.push({ key: k, make, at: now });
                  this.stats(reason, (s) => { s.sampled++; });
                  // Full: the oldest waiting one goes (fresh candidates are worth more).
                  while (q.length > this.config.queuePerReason) { q.shift(); this.stats(reason, (s) => { s.dropped++; }); }
            } catch { /* never let research affect the scanner */ }
      }

      // Waiting candidates, all reasons together (for tests and the log).
      queued(): number { let n = 0; for (const q of this.queues.values()) n += q.length; return n; }

      // ---- The lane's own timer: test at most one candidate per call ----
      // Returns true when it tested (or tried to test) something.
      async tick(): Promise<boolean> {
            if (!this.config.enabled || this.busy) return false;
            if (this.now() < this.pausedUntil) return false;
            if (this.queued() === 0) return false;
            // A trigger test with replay needs ~3 requests: wait until there's room.
            if (this.budget.available() < Math.min(3, Math.max(1, Math.floor(this.config.rpcPerMin)))) return false;
            let ok = false;
            try { ok = this.deps.canRun(); } catch { ok = false; }
            if (!ok) return false;
            const item = this.next();
            if (!item) return false;
            this.busy = true;
            try {
                  await this.process(item.reason, item.q);
            } catch (err) {
                  this.log(`[research] test error (ignored): ${(err as Error).message}`);
            } finally {
                  this.busy = false;
            }
            return true;
      }

      // Next candidate, taking turns between reasons so one busy reason
      // (e.g. thousands of shallow pools) can't crowd out the others.
      private next(): { reason: ResearchReason; q: Queued } | null {
            for (let i = 0; i < RESEARCH_REASONS.length; i++) {
                  const reason = RESEARCH_REASONS[(this.rr + i) % RESEARCH_REASONS.length]!;
                  const q = this.queues.get(reason)!;
                  if (q.length) {
                        this.rr = (this.rr + i + 1) % RESEARCH_REASONS.length;
                        return { reason, q: q.pop()! }; // newest first
                  }
            }
            return null;
      }

      private async process(reason: ResearchReason, item: Queued): Promise<void> {
            let c: ResearchCandidate | null = null;
            try { c = item.make(); } catch { c = null; }
            if (!c || !(c.sizeUsd > 0) || !(c.usdPerToken > 0)) {
                  this.stats(reason, (s) => { s.noModelGap++; });
                  return;
            }
            const decimals = this.deps.decimalsOf(c.tokenIn);
            const pair = `${this.deps.symbolOf(c.buyPool.tokenA)}/${this.deps.symbolOf(c.buyPool.tokenB)}`;
            const rec: ResearchRecord = {
                  at: this.now(), reason, source: c.source, pair, tokenIn: c.tokenIn,
                  buy: { dex: c.buyPool.dex, pool: c.buyPool.poolAddress, feeBps: c.buyPool.feeBps },
                  sell: { dex: c.sellPool.dex, pool: c.sellPool.poolAddress, feeBps: c.sellPool.feeBps },
                  vetted: c.vetted, sizeUsd: round(c.sizeUsd, 2), modelGrossUsd: round(c.modelGrossUsd, 4), timing: 'latest block',
                  note: c.note,
            };
            if (decimals === undefined) {
                  rec.own = { kind: 'skipped', why: 'coin decimals unknown' };
            } else {
                  // Where in the chain to test. Trigger candidates: replay the
                  // trigger's block up to the trigger, then our trade (the exact
                  // moment a backrun lands, before any rival). Else: latest block.
                  const spot = c.source === 'trigger' && c.triggerHash && this.config.replay ? await this.findSpot(c.triggerHash) : null;
                  // Own money first (rivals trade with their own money, 45 of 46).
                  const own = await this.runOne(c, decimals, null, spot);
                  rec.own = own.outcome;
                  rec.timing = own.timing;
                  // Then the flash-loan version, only if it's cheap: a lender is
                  // known and the allowance has a request to spare. Not after a
                  // "no room / node busy" answer (it would just be refused too),
                  // but yes after "can't test this coin with own money": the flash
                  // version doesn't need the coin's balance location, so it may
                  // still give an answer.
                  const ownBlocked = own.outcome.kind === 'skipped' && /allowance|node busy|built/.test(own.outcome.why);
                  if (this.config.flash && !ownBlocked && this.budget.available() >= 1) {
                        let lender: ReturnType<ResearchDeps['pickLender']> = null;
                        try { lender = this.deps.pickLender(c.tokenIn, c.buyPool, c.sellPool, c.sizeUsd, c.usdPerToken); } catch { lender = null; }
                        if (lender) {
                              rec.flash = (await this.runOne(c, decimals, lender, spot)).outcome;
                              rec.lenderFeeBps = lender.feeBps;
                        }
                  }
            }
            this.score(rec);
            this.keep(rec);
            this.log(`[research] ${REASON_LABEL[reason]} | ${pair} ${rec.buy.dex}@${rec.buy.pool.slice(0, 10)}->${rec.sell.dex}@${rec.sell.pool.slice(0, 10)}` +
                  ` | model gross $${c.modelGrossUsd.toFixed(3)} on $${c.sizeUsd.toFixed(0)}${c.vetted ? '' : ' (coin not vetted)'}` +
                  ` | own money: ${describe(rec.own)}${rec.flash ? ` | flash loan (${(rec.lenderFeeBps ?? 0) / 100}% fee): ${describe(rec.flash)}` : ''}` +
                  ` | ${rec.timing}${c.note ? ` | ${c.note}` : ''}`);
      }

      // One real-chain test. lender null = own money.
      private async runOne(
            c: ResearchCandidate, decimals: number, lender: { poolAddress: string } | null,
            spot: { block: string; parent: string; prefix: ReplayCall[]; time?: string } | null,
      ): Promise<{ outcome: SimOutcome; timing: string }> {
            const built = buildExecuteCall({
                  chain: 'robinhood', tokenIn: c.tokenIn, buyPool: c.buyPool, sellPool: c.sellPool,
                  tradeSizeUsd: c.sizeUsd, netProfitUsd: 1, usdPerTokenIn: c.usdPerToken,
                  tokenInDecimals: decimals, maxBlock: 0n, v3Lender: lender?.poolAddress,
            });
            if ('reason' in built) return { outcome: { kind: 'skipped', why: `trade couldn't be built (${built.reason})` }, timing: 'not tested' };
            const trade = { token: c.tokenIn, amountIn: built.amountIn, hops: built.hops };
            const opts = { v3Lender: lender?.poolAddress, weth: this.deps.weth };
            let timing = 'latest block';
            let r: SimResult;
            if (spot) {
                  r = await this.simulate(replayRpc(this.rpc, spot.parent, spot.prefix, spot.time), 'robinhood', trade, opts);
                  timing = 'right after trigger';
                  // Replay not possible, or "breaks" with no reason (seen on Ramses
                  // V3 inside replays): one plain test at the end of the trigger's block.
                  if (('reason' in r && (r.reason.startsWith('replay unavailable') || STATE_GONE.test(r.reason))) || noReason(r)) {
                        const r2 = await this.simulate(this.rpc, 'robinhood', trade, { ...opts, blockTag: spot.block });
                        if (!('reason' in r2 && STATE_GONE.test(r2.reason)) && r2.status !== 'rate_limited') { r = r2; timing = 'end of trigger block'; }
                  }
            } else {
                  r = await this.simulate(this.rpc, 'robinhood', trade, opts);
            }
            return { outcome: this.toOutcome(r, built.amountIn, decimals, c.usdPerToken), timing };
      }

      private toOutcome(r: SimResult, amountIn: bigint, decimals: number, usdPerToken: number): SimOutcome {
            if (r.status === 'rate_limited') {
                  // Our own allowance ran out: just wait for it to refill. The node
                  // itself said "slow down": rest the whole lane so the main
                  // checker gets the node to itself.
                  if (!r.reason.includes(BUDGET_MSG)) this.pausedUntil = this.now() + this.config.pauseMs;
                  return { kind: 'skipped', why: r.reason.includes(BUDGET_MSG) ? 'lane allowance used up' : 'checking node busy' };
            }
            if (r.status === 'unsupported') return { kind: 'skipped', why: `can't test this coin (${r.reason.slice(0, 60)})` };
            if (r.status === 'loss') return { kind: 'loss' };
            if (r.status === 'fail') return { kind: 'fail', group: classifyFailReason(r.reason), raw: r.reason.slice(0, 120) };
            // Profit, but sanity-checked in coins (a bad USD price can't hide it):
            // a 2-pool arb never makes a quarter of what it put in.
            if (!(amountIn > 0n) || Number(r.profit) / Number(amountIn) > this.config.maxPlausibleShare) {
                  return { kind: 'fail', group: 'stale', raw: 'implausible profit (bad coin or pool data)' };
            }
            const usd = (Number(r.profit) / 10 ** decimals) * usdPerToken;
            let gas = 0;
            try { gas = this.deps.gasUsd(); } catch { gas = 0; }
            return { kind: 'profit', usd: round(usd, 6), netUsd: round(usd - gas, 6) };
      }

      // Where the trigger trade landed and the trades before it in its block.
      // One look only (the lane runs a little after the trade, so it has
      // normally landed); not found = test at the latest block instead.
      private async findSpot(hash: string): Promise<{ block: string; parent: string; prefix: ReplayCall[]; time?: string } | null> {
            if (hash.includes('PLACEHOLDER')) return null;
            try {
                  const rc = await this.rpc('eth_getTransactionReceipt', [hash]);
                  if (rc.error || !rc.result?.blockNumber) return null;
                  const n = BigInt(rc.result.blockNumber);
                  const idx = Number(rc.result.transactionIndex);
                  const b = await this.rpc('eth_getBlockByNumber', [rc.result.blockNumber, true]);
                  const txs: any[] = b.result?.transactions ?? [];
                  const prefix: ReplayCall[] = txs.slice(0, idx + 1)
                        .filter((t) => t?.to && USER_TX_TYPES.has(String(t.type ?? '0x0').toLowerCase()))
                        .map((t) => ({ from: t.from, to: t.to, data: t.input ?? t.data ?? '0x', value: t.value, gas: t.gas }));
                  if (!prefix.length || txs[idx]?.hash?.toLowerCase() !== hash.toLowerCase()) return null;
                  return { block: rc.result.blockNumber, parent: '0x' + (n - 1n).toString(16), prefix, time: b.result?.timestamp };
            } catch { return null; }
      }

      // ---- Scoring ----
      private stats(reason: ResearchReason, f: (s: ReasonStats) => void) {
            f(this.hour.get(reason)!);
            f(this.total.get(reason)!);
      }

      private score(rec: ResearchRecord) {
            // The headline result: own money when it got an answer, else flash.
            const primary = rec.own && rec.own.kind !== 'skipped' ? rec.own : rec.flash && rec.flash.kind !== 'skipped' ? rec.flash : rec.own ?? rec.flash;
            this.stats(rec.reason, (s) => {
                  if (!primary || primary.kind === 'skipped') { s.skipped++; return; }
                  s.tested++;
                  if (primary.kind === 'profit' && primary.netUsd > 0) {
                        s.profitable++;
                        s.profitUsd += primary.netUsd;
                        s.bestUsd = Math.max(s.bestUsd, primary.netUsd);
                  } else if (primary.kind === 'profit' || primary.kind === 'loss') s.unprofitable++;
                  else s.failed[primary.group] = (s.failed[primary.group] ?? 0) + 1;
                  if (rec.flash && rec.flash.kind !== 'skipped') {
                        s.flashTested++;
                        if (rec.flash.kind === 'profit' && rec.flash.netUsd > 0) { s.flashProfitable++; s.flashProfitUsd += rec.flash.netUsd; }
                  }
            });
            for (const o of [rec.own, rec.flash]) if (o?.kind === 'skipped') this.skipWhy.set(o.why, (this.skipWhy.get(o.why) ?? 0) + 1);
      }

      private keep(rec: ResearchRecord) {
            this.records.push(rec);
            if (this.records.length > this.config.maxRecords) this.records.splice(0, this.records.length - this.config.maxRecords);
      }

      // ---- Reading the results ----
      statsFor(reason: ResearchReason, window: 'hour' | 'total' = 'total'): ReasonStats {
            return structuredClone((window === 'hour' ? this.hour : this.total).get(reason)!);
      }
      recentRecords(): ResearchRecord[] { return this.records.slice(); }

      // Plain-English report for Telegram (HTML-safe). window 'hour' = since
      // the last takeHour(); 'total' = since this lane's file was started.
      summary(window: 'hour' | 'total' = 'hour'): string {
            const src = window === 'hour' ? this.hour : this.total;
            const lines: string[] = [];
            lines.push(`<b>Research lane</b> (test only, never trades) · ${window === 'hour' ? 'last hour' : 'since start'}`);
            let any = false;
            for (const r of RESEARCH_REASONS) {
                  const s = src.get(r)!;
                  if (!s.offered && !s.tested) continue;
                  any = true;
                  const fails = Object.entries(s.failed).filter(([, n]) => n).map(([g, n]) => `${n} ${FAIL_GROUP_LABEL[g as FailGroup]}`).join(', ');
                  lines.push(`• ${esc(REASON_LABEL[r])}: ${s.offered} thrown away, ${s.sampled} sampled, ${s.tested} tested` +
                        (s.tested ? `: <b>${s.profitable} made money</b> ($${s.profitUsd.toFixed(2)} total, best $${s.bestUsd.toFixed(2)}), ${s.unprofitable} didn't${fails ? `, would fail: ${esc(fails)}` : ''}` : '') +
                        (s.flashTested ? ` · with a flash loan: ${s.flashProfitable} of ${s.flashTested} made money ($${s.flashProfitUsd.toFixed(2)})` : '') +
                        (s.noModelGap ? ` · ${s.noModelGap} had no gap left` : '') +
                        (s.skipped ? ` · ${s.skipped} couldn't be tested` : ''));
            }
            if (!any) lines.push('• nothing thrown away yet');
            if (window === 'hour') {
                  lines.push(`Node requests used: ${this.budget.usedHour} (limit ${this.config.rpcPerMin}/min)` +
                        (this.skipWhy.size ? ` · not tested because: ${esc([...this.skipWhy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w} (${n})`).join(', '))}` : ''));
            }
            return lines.join('\n');
      }

      // Returns the hourly report, then starts a new hour.
      takeHour(): string {
            const text = this.summary('hour');
            for (const r of RESEARCH_REASONS) this.hour.set(r, emptyStats());
            this.skipWhy.clear();
            this.budget.usedHour = 0;
            return text;
      }

      // ---- Saved to disk (data/research-lane.json), small and bounded ----
      save(file: string): void {
            try {
                  mkdirSync(dirname(file), { recursive: true });
                  const out = { version: 1, savedAt: this.now(), totals: Object.fromEntries(this.total), records: this.records.slice(-this.config.maxRecords) };
                  writeFileSync(file + '.tmp', JSON.stringify(out));
                  renameSync(file + '.tmp', file); // atomic: never a half-written file
            } catch { /* best effort: research must never affect the bot */ }
      }

      // Restores totals and records from an earlier run. Bad/missing file = start fresh.
      load(file: string): number {
            try {
                  const j = JSON.parse(readFileSync(file, 'utf8'));
                  if (j?.version !== 1) return 0;
                  for (const r of RESEARCH_REASONS) {
                        const t = j.totals?.[r];
                        if (t && typeof t === 'object') this.total.set(r, { ...emptyStats(), ...t, failed: { ...(t.failed ?? {}) } });
                  }
                  if (Array.isArray(j.records)) this.records = j.records.slice(-this.config.maxRecords);
                  return this.records.length;
            } catch { return 0; }
      }
}

// ----------------------------------------------------------------------------
// Helpers the bot uses to turn a rejection into a candidate
// ----------------------------------------------------------------------------

// The trigger trade had no partner pool $25k+ deep. Plans the backrun against
// the THINNER partner pools instead (at least minDepthUsd), with the exact
// same cost inputs the main scanner uses, so the only difference tested is
// the depth bar. null = no thin partner either, or no gap in the model.
export function planShallowCandidate(input: {
      cache: PoolCache;
      victim: PoolState;
      swap: { tokenIn: string; tokenOut: string; amountIn: bigint; stateType: any };
      usdPerToken: number | null;
      tokenInDecimals: number | undefined;
      isDeep: (p: PoolState) => boolean;
      depthUsd: (p: PoolState) => number | null;
      minDepthUsd: number;
      gasUsd: number;
      vetted: boolean;
      triggerHash?: string;
}): ResearchCandidate | null {
      const { cache, victim, swap, usdPerToken } = input;
      if (usdPerToken === null || !(usdPerToken > 0) || input.tokenInDecimals === undefined) return null;
      const thin = cache.findPeerPools(victim.chain, swap.tokenIn, swap.tokenOut, victim.poolAddress)
            .filter((p) => !input.isDeep(p) && (input.depthUsd(p) ?? 0) >= input.minDepthUsd);
      let best: ReturnType<typeof planBackrun> = null;
      let bestPeer: PoolState | null = null;
      for (const peer of thin) {
            const plan = planBackrun(cache, victim, peer, swap, usdPerToken, {
                  gasPriceUsd: input.gasUsd, dexFeeBps: { buy: victim.feeBps, sell: peer.feeBps },
                  flashLoanFeeBps: 9, usingFlashLoan: true, safetyMarginPct: 0.15,
            }, input.tokenInDecimals);
            if (plan && (!best || plan.sizing.grossProfitUsd > best.sizing.grossProfitUsd)) { best = plan; bestPeer = peer; }
      }
      if (!best || !bestPeer) return null;
      const d = input.depthUsd(bestPeer);
      return {
            reason: 'shallow_pool', source: 'trigger', tokenIn: swap.tokenIn,
            buyPool: best.buyPool, sellPool: best.sellPool,
            sizeUsd: best.sizing.optimalTradeSizeUsd, modelGrossUsd: best.sizing.grossProfitUsd,
            usdPerToken, vetted: input.vetted, triggerHash: input.triggerHash,
            note: `thin partner ${bestPeer.dex} ~$${Math.round(d ?? 0)} deep`,
      };
}

// Standing gaps the main scanner ignores, sorted into two reasons:
//   gap_below_min: both pools deep enough, gap under the main $20 bar
//   shallow_pool:  the gap involves a pool under the main depth bar
// Uses own-money costs (no flash fee), like the rivals. Reads prices
// already in memory only: no node requests.
export function findResearchGaps(
      pairs: PoolState[][],
      isDeep: (p: PoolState) => boolean,
      depthUsd: (p: PoolState) => number | null,
      decimalsOf: (token: string) => number | undefined,
      usdOf: (token: string) => number | null,
      opts: { mainMinUsd: number; researchMinUsd: number; minDepthUsd: number; gasUsd: number; maxTradeUsd: number },
): { reason: ResearchReason; gap: ReturnType<typeof findStandingGaps>[number] }[] {
      const gapOpts = { minProfitUsd: opts.researchMinUsd, flashFee: 0, gasUsd: opts.gasUsd, maxTradeUsd: opts.maxTradeUsd };
      const out: { reason: ResearchReason; gap: ReturnType<typeof findStandingGaps>[number] }[] = [];
      const deep = pairs.map((ps) => ps.filter(isDeep));
      for (const g of findStandingGaps(deep, decimalsOf, usdOf, gapOpts)) {
            if (g.profitUsd < opts.mainMinUsd) out.push({ reason: 'gap_below_min', gap: g });
      }
      const wide = pairs.map((ps) => ps.filter((p) => (depthUsd(p) ?? 0) >= opts.minDepthUsd));
      for (const g of findStandingGaps(wide, decimalsOf, usdOf, gapOpts)) {
            if (!isDeep(g.buyPool) || !isDeep(g.sellPool)) out.push({ reason: 'shallow_pool', gap: g });
      }
      return out;
}

// Turns a standing gap into a candidate.
export function gapCandidate(reason: ResearchReason, g: ReturnType<typeof findStandingGaps>[number], vetted: boolean): ResearchCandidate {
      return {
            reason, source: 'gap', tokenIn: g.quote, buyPool: g.buyPool, sellPool: g.sellPool,
            sizeUsd: g.sizeUsd, modelGrossUsd: g.profitUsd, usdPerToken: g.quoteUsd, vetted,
            note: `standing gap, model ~$${g.profitUsd.toFixed(2)} after gas`,
      };
}

function describe(o: SimOutcome | undefined): string {
      if (!o) return 'not tested';
      if (o.kind === 'profit') return `${o.netUsd > 0 ? 'MADE' : 'too small:'} $${o.usd.toFixed(4)} ($${o.netUsd.toFixed(4)} after gas)`;
      if (o.kind === 'loss') return 'lost money';
      if (o.kind === 'fail') return `would fail (${FAIL_GROUP_LABEL[o.group]}: ${o.raw})`;
      return `not tested (${o.why})`;
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
