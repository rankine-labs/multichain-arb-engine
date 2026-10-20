import type { PoolState } from './types';
import { PoolCache } from './poolCache';
import { PendingTrades, loopPoolState } from './loopPrices';
import { LoopTrader, LoopTrade, LoopCheckContext, LoopCheckResult } from './loopTrader';
import type { LoopResult } from './loopFinder';
import { deepEnough, poolDepthUsd, setRealBalanceSource } from './poolPrice';
import { setHeadBlockSource } from './eventFees';
import { drainSteps, Steps } from './chunked';
import type { LoopWorkerInit, LoopBatch, PoolRec, EnvDelta } from './loopWorkerFeed';
import type { CoinTaxGate } from './coinTax';

// ============================================================================
// LOOP WORKER CORE (Oct 15, owner approved). PRACTICE ONLY, NEVER SENDS.
//
// Plain English:
//   This is the loop trader's brain when it runs in its own thread. It keeps
//   its own copy of what it needs:
//     - the loop pools' states as the main thread last sent them (main-cache
//       state, block-confirmed state, and where that came from);
//     - the "pending trades" book (feed trades no block has confirmed yet);
//     - coin prices, decimals, names, the vetted list, gas cost for loops,
//       real V3 balances and the pools rival loops used.
//   On each scan it builds the exact same pool list the main thread used to
//   build (same steps as shadowMain loopScanSteps) and hands it to the very
//   same LoopTrader. Only WHERE it runs changed, not what it does.
//
//   It has no wallet and no sender. Practice checks go through `runCheck`
//   (core/loopWorkerEntry.ts), the same free "pretend" test as before.
//
//   No worker-thread code in here, so the tests can run it directly and
//   compare it with the main-thread version.
// ============================================================================

export interface LoopWorkerCoreDeps {
  // One practice check (eth_call, never sends).
  runCheck: (trade: LoopTrade, ctx?: LoopCheckContext) => Promise<LoopCheckResult>;
  // The loop node's own guard says a check may start (not paused, daily limit not reached).
  canCheckNode: () => boolean;
  // One log line (the 60 a minute limit is applied here, same as before).
  log: (line: string) => void;
  // A practice replay said how much gas our loop used (teaches the main thread's gas model).
  noteGas: (pools: number, gasUsed: bigint) => void;
  // Set the worker-wide real-balance and head-block lookups (true in the worker;
  // tests running several cores side by side may leave it off).
  installGlobals?: boolean;
  // COIN TAX TEST (core/coinTax.ts): missing = off.
  coinTax?: CoinTaxGate;
}

export class LoopWorkerCore {
  readonly trader: LoopTrader;
  private pending: PendingTrades;
  private recs = new Map<string, PoolRec>();
  private keys: string[] = [];
  private extraKeys: string[] | null = null;
  private usd = new Map<string, number | null>();
  private dec = new Map<string, number | null>();
  private sym = new Map<string, string>();
  private tradable = new Map<string, boolean>();
  private dex = new Map<string, boolean>();
  private bal = new Map<string, bigint | null>();
  private rival = new Set<string>();
  private gas: number[] = [];
  private budgetOk = true;
  private head: number | null = null;
  private batchNow = 0;
  private logTimes: number[] = [];
  // Only used for its "predict the pool after this trade" maths (no pools stored).
  private predictor = new PoolCache({ index: false, confirmed: false });
  scans = 0;
  lastScanMs = 0;
  droppedNotes = 0;

  constructor(readonly init: LoopWorkerInit, private deps: LoopWorkerCoreDeps) {
    this.pending = new PendingTrades(init.fix.pendingMaxMs);
    const lc = (t: string) => t.toLowerCase();
    const usdOf = (t: string): number | null => this.usd.get(lc(t)) ?? null;
    // Exact decimals (undefined = unknown): what TOKEN_DECIMALS.robinhood says.
    const exactDec = (t: string): number | undefined => { const d = this.dec.get(lc(t)); return d === null || d === undefined ? undefined : d; };
    // Depth maths guesses 18 for an unknown coin (same as shadowMain decimalsOf).
    const dec18 = (_chain: string, t: string): number => exactDec(t) ?? 18;
    this.depthDec = dec18;
    this.usdOf = usdOf;
    const now = init.fixedClock ? () => this.batchNow : Date.now;
    this.now = now;
    if (deps.installGlobals !== false) {
      setRealBalanceSource((pool, token) => this.bal.get(`${lc(pool)}:${lc(token)}`) ?? undefined);
      setHeadBlockSource(() => this.head);
    }
    this.trader = new LoopTrader(init.loopCfg, {
      bases: init.bases,
      env: {
        decimalsOf: exactDec,
        usdOf,
        depthUsd: (p) => poolDepthUsd(p, dec18, usdOf),
        gasUsd: (hops) => this.gas[hops] ?? NaN,
        rivalPools: () => this.rival,
        isTradable: (t) => this.tradable.get(lc(t)) ?? false,
        now,
      },
      symbolOf: (t) => this.sym.get(lc(t)) ?? `${t.slice(0, 6)}...${t.slice(-4)}`,
      decimalsOf: exactDec,
      canPracticeTest: (p) => this.dex.get(p.dex) ?? false,
      canCheckNow: () => deps.canCheckNode() && this.budgetOk,
      runCheck: (trade, ctx) => deps.runCheck(trade, ctx),
      fix: init.fix,
      noteGas: (pools, gasUsed) => deps.noteGas(pools, gasUsed),
      ...(deps.coinTax ? { coinTax: deps.coinTax } : {}),
      log: (m) => {
        const t = Date.now();
        this.logTimes = this.logTimes.filter((x) => t - x < 60_000);
        if (this.logTimes.length < init.logPerMin) { this.logTimes.push(t); deps.log(m); }
      },
    });
    // Tests only: no time budget, so the answer can't depend on machine speed.
    if (init.testHooks && init.testFinder) Object.assign(this.trader.finder.cfg, init.testFinder);
  }

  private depthDec!: (chain: string, t: string) => number;
  private usdOf!: (t: string) => number | null;
  readonly now!: () => number;

  poolCount(): number { return this.recs.size; }
  // Coin name for log lines (same names the loop trader uses).
  symbolOf(t: string): string { return this.sym.get(t.toLowerCase()) ?? `${t.slice(0, 6)}...${t.slice(-4)}`; }
  pendingCount(): number { return this.pending.size(); }

  // Take in one message from the main thread (cheap: no loop maths here).
  apply(b: LoopBatch): void {
    this.batchNow = b.now;
    this.head = b.head;
    this.gas = b.gas;
    this.budgetOk = b.budgetOk;
    if (b.env) this.applyEnv(b.env);
    if (b.keys) this.keys = b.keys;
    if (b.extraKeys !== undefined) this.extraKeys = b.extraKeys;
    for (const [k, rec] of b.pools) { if (rec) this.recs.set(k, rec); else this.recs.delete(k); }
    this.droppedNotes += b.droppedNotes;
    if (this.init.triggersOn) {
      for (const n of b.notes) { if (n[0] === 0) this.pending.noteFeedTx(n[1]); else this.pending.note(n[1], n[2]); }
    }
    for (const r of b.rivals) this.trader.noteRival(r);
  }

  private applyEnv(e: EnvDelta): void {
    for (const [t, v] of e.usd ?? []) this.usd.set(t, v);
    for (const [t, v] of e.dec ?? []) this.dec.set(t, v);
    for (const [t, v] of e.sym ?? []) this.sym.set(t, v);
    for (const [t, v] of e.tradable ?? []) this.tradable.set(t, v);
    for (const [d, v] of e.dex ?? []) this.dex.set(d, v);
    for (const [p, t, v] of e.bal ?? []) this.bal.set(`${p}:${t}`, v);
    if (e.rivalPools) this.rival = new Set(e.rivalPools);
    // Memory bound: forget coins and balances no pool uses any more, now and then.
    if (this.usd.size > 20_000) this.usd.clear();
    if (this.bal.size > 20_000) this.bal.clear();
  }

  // One loop scan, step by step. Same steps as shadowMain loopScanSteps:
  // watched pools first (real prices = confirmed state + pending trades),
  // then the extra single pools, deep enough only, then the loop trader.
  *scanSteps(): Steps<LoopResult[] | undefined> {
    const init = this.init;
    const now = this.now();
    const predict = (p: PoolState, inIsA: boolean, amt: bigint) => this.predictor.predictPostTradeState(p, inIsA, amt);
    const fresh = init.triggersOn ? this.pending.takeFresh() : new Map<string, { hash: string; at: number }>();
    if (init.triggersOn) this.pending.sweep(now);
    const stateOf = (a: string): PoolState | undefined => {
      const r = this.recs.get(a);
      return init.realPricesOn
        ? this.pending.stateFor(a, r?.m, r?.c, r?.i, predict, now)
        : loopPoolState(r?.m, undefined, undefined, false, predict, now);
    };
    const pools: PoolState[] = [];
    let n = 0;
    for (const a of this.keys) {
      const p = stateOf(a);
      if (p && deepEnough(p, this.depthDec, this.usdOf, init.minDepthUsd)) pools.push(p);
      if ((++n & 63) === 0) yield;
    }
    if (this.extraKeys !== null) {
      const have = new Set(pools.map((p) => p.poolAddress.toLowerCase()));
      const maxAge = init.loopCfg.maxPoolAgeMs;
      const extra = init.realPricesOn
        ? this.extraKeys.map(stateOf).filter((p): p is PoolState => !!p && now - p.lastUpdatedMs <= maxAge)
        : this.extraKeys.map((k) => this.recs.get(k)?.m).filter((p): p is PoolState => !!p && now - p.lastUpdatedMs <= maxAge);
      for (const p of extra) {
        if (!have.has(p.poolAddress.toLowerCase()) && deepEnough(p, this.depthDec, this.usdOf, init.minDepthUsd)) pools.push(p);
        if ((++n & 63) === 0) yield;
      }
    }
    const ctx = init.fix.triggerReplay && fresh.size ? { triggers: fresh } : {};
    return yield* this.trader.onUpdateSteps(pools, ctx);
  }

  // The whole scan at once (the worker has no feed to keep responsive).
  scan(): LoopResult[] | undefined {
    const t0 = performance.now();
    try { return drainSteps(this.scanSteps()); }
    finally { this.scans++; this.lastScanMs = performance.now() - t0; }
  }
}
