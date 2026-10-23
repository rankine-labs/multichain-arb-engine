import { Transaction } from 'ethers';
import type { FeedMsg } from '../chains/nitroFeed';
import { LocalSimClient } from './localSim';
import { JsonlLog, LocalTrade, LocalSimOpts } from './localSimHost';
import { TriggerFirst, TrigOutcome, TrigConfidence, TrigQuestion, confidenceAtLeast } from './triggerFirst';

// ============================================================================
// TRIGGER-FIRST ENTRY POINT: every feed transaction is a possible trigger.
//
// Plain English (live Oct 23): trigger-first (execution/triggerFirst.ts)
// only ran inside fireTrade's check-first step, i.e. AFTER
//   (1) the old model guess (backrun planner / profit model) had flagged an
//       arb for that feed trade, and
//   (2) fireTrade's earlier gates (the 6 h "pair blocked (failed recently)"
//       list, benched pairs, ...).
// In ~50 min of practice it ran ONCE: 15 of 16 chances were stopped by
// "pair blocked". Every real chance we had (8 live losses) was opened by a
// normal trade on one of our pools in block N; rivals landed at the top of
// block N+1.
//
// The owner's goal: "see the transaction on the sequencer -> simulate it and
// our trade locally -> submit immediately if profitable and all checks
// pass". We submit WITHOUT waiting for pool reports or receipts.
//
// What this file does, for EVERY Robinhood feed transaction:
//   0. Cheap skip (no work): plain ETH transfers, contract creations, our own
//      transactions, approve / transfer / WETH wrap & unwrap / permit calls.
//   1. DISCOVER: ask the fast check "which of the pools you follow does this
//      transaction move?" (sidecar `trig_discover`: the transaction ALONE,
//      run on copy 2's newest version with the same replay rules and
//      best-effort assumptions; no node; anything it can't run = unknown).
//   2. CANDIDATES: for each moved pool, the routes the bot already knows how
//      to trade: the same pair on another exchange, buy on one and sell on
//      the other, both directions, starting from a coin we hold (USDG /
//      WETH). The host (shadowMain.ts) builds them with the existing pool
//      lists, exchange / coin rules, lender choice and buildCheck. At most
//      TRIG_ENTRY_MAX_CANDIDATES per trigger.
//   3. SIZE + CHECK: each candidate is checked with the full trigger-first
//      check (every feed transaction in sequence order, then our exact
//      trade), at the biggest allowed size of the ladder TRIG_ENTRY_SIZES_USD,
//      and the smaller sizes on the SAME replay in the SAME request (size
//      ladder). The best net profit after gas wins.
//   4. DECIDE: profitable (net >= MIN_EXEC_NET_USD) at confidence >=
//      TRIG_FIRST_MIN_CONFIDENCE ->
//        on mode:     straight to the safeguards below and then the sender
//        shadow mode: logged as "would send", never sent
//
// SAFEGUARDS an entry-point send still goes through (gates() here, then the
// host's fireTrade): kill file / kill switch, SafetyGate (coin allowlist,
// size and daily loss caps), the minimum profit, the confidence floor, the
// 30-min live-fail block on the exact pool pair, the scoreboard's paused
// buckets; then in fireTrade: fit-to-wallet, the outlier guard, live checks,
// the sender.
// DELIBERATELY NOT applied to entry-point sends (they stay for the old paths
// only): the old model guess (we don't need it: our exact trade was checked
// on the replayed feed), and the 6 h "pair blocked" / benched-pair lists
// (they were stopping 15 of 16 chances; a failed entry send blocks its pair
// for 30 min instead).
//
// ONE SEND PER TRIGGER: claim() is a lock shared with the old path; whoever
// claims a trigger first sends, the other doesn't.
//
// LOAD: never blocks the feed handler (work starts with setImmediate), at
// most TRIG_ENTRY_MAX_IN_FLIGHT triggers at once (more = dropped, counted),
// every sidecar question has a timeout and the whole trigger a deadline. No
// node requests at all in this path.
//
// SWITCHES: LOCAL_SIM_TRIGGER_FIRST (off / shadow / on, the same switch as
// the old hook) and TRIG_FIRST_ENTRY (1 = on, the default; 0 = off).
// LOG: data/local-sim-shadow.jsonl lines "k":"trig_entry" (one per trigger
// that moved one of our pools) and an hourly "[trig-entry] hour:" line.
// ============================================================================

export type EntrySettings = {
  enabled: boolean;              // TRIG_FIRST_ENTRY [1] (and LOCAL_SIM_TRIGGER_FIRST not off)
  maxInFlight: number;           // TRIG_ENTRY_MAX_IN_FLIGHT [4] triggers worked on at once; more are dropped
  maxCandidates: number;         // TRIG_ENTRY_MAX_CANDIDATES [6] candidate trades checked per trigger
  sizesUsd: number[];            // TRIG_ENTRY_SIZES_USD [50,150,400] trade size ladder ($)
  discoverTimeoutMs: number;     // TRIG_ENTRY_DISCOVER_TIMEOUT_MS [40] the "which pools?" question
  deadlineMs: number;            // TRIG_ENTRY_DEADLINE_MS [250] the whole trigger (discover + checks)
  minNetUsd: number;             // MIN_EXEC_NET_USD (the bot's one send minimum)
  lockMs: number;                // how long a trigger stays claimed [120000]
};

export function entrySettings(env: Record<string, string | undefined> = process.env, minNetUsd = 0.25): EntrySettings {
  const num = (k: string, d: number, min = 1) => { const v = Number(env[k]); return Number.isFinite(v) && v >= min ? v : d; };
  const sizes = (env.TRIG_ENTRY_SIZES_USD ?? '50,150,400').split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  return {
    enabled: (env.TRIG_FIRST_ENTRY ?? '1').trim() !== '0',
    maxInFlight: Math.round(num('TRIG_ENTRY_MAX_IN_FLIGHT', 4)),
    maxCandidates: Math.round(num('TRIG_ENTRY_MAX_CANDIDATES', 6)),
    sizesUsd: sizes.length ? sizes.slice(0, 6) : [50, 150, 400],
    discoverTimeoutMs: num('TRIG_ENTRY_DISCOVER_TIMEOUT_MS', 40),
    deadlineMs: num('TRIG_ENTRY_DEADLINE_MS', 250),
    minNetUsd,
    lockMs: 120_000,
  };
}

// Calls that never move a pool by themselves (the coin's own functions):
// approve, transfer, transferFrom, WETH deposit / withdraw, permit,
// setApprovalForAll. Sent straight to a coin, they can't open an arb.
const NON_SWAP = new Set(['0x095ea7b3', '0xa9059cbb', '0x23b872dd', '0xd0e30db0', '0x2e1a7d4d', '0xd505accf', '0xa22cb465']);

// Why a feed transaction needs no work at all (null = look at it).
export function quickSkip(raw: string, hash: string, ours: { isOurTx: (h: string) => boolean; addresses: Set<string> }): string | null {
  if (ours.isOurTx(hash)) return 'ours';
  let tx: Transaction;
  try { tx = Transaction.from(raw); } catch { return 'unreadable'; }
  if (!tx.to) return 'create';
  if (ours.addresses.has(tx.to.toLowerCase())) return 'ours';
  const data = tx.data ?? '0x';
  if (data.length < 10) return 'plain_transfer';
  if (NON_SWAP.has(data.slice(0, 10).toLowerCase())) return 'coin_call';
  return null;
}

// One candidate trade (built by the host from its pool lists).
export type EntryCandidate = {
  label: string;                 // e.g. "WETH/USDG uniswap-v3>fables"
  buyPool: string;               // pool addresses (30-min block, scoreboard)
  sellPool: string;
  tokenIn: string;               // start coin (one we hold)
  tokens: string[];              // coins it touches (allowlist)
  keys: string[];                // route keys (copy-2 readiness, best-effort skipping)
  maxSizeUsd: number;            // biggest size allowed (trade caps, wallet)
  gasUsd: number;                // gas cost of one send ($)
  // Our exact trade at this size (buildCheck), or null if it can't be built.
  build: (sizeUsd: number) => { trade: LocalTrade; simOpts: LocalSimOpts } | null;
  usdOf: (units: bigint) => number;       // start-coin units -> $
  host?: unknown;                // host data for the send (pool objects, ...)
};

// ROUTES for the pools a trigger moved (pure, so it can be tested): the same
// pair on another exchange, buy on one pool and sell on the other, both
// directions, starting from a coin we hold, with the venue rule (exchange
// cleared for trading) and the coin rule (both coins on the allowed list).
export type RouteRules<P> = {
  pool: (key: string) => P | undefined;          // a moved pool, by its key
  peers: (p: P) => P[];                          // same pair, other pools
  addr: (p: P) => string;
  tokens: (p: P) => [string, string];
  startCoins: string[];                          // coins we hold (USDG / WETH)
  coinAllowed: (token: string) => boolean;       // SafetyGate allowlist
  venueBlocked: (buy: P, sell: P) => string | null; // exchange not cleared for trading
};
export function enumerateRoutes<P>(keys: string[], r: RouteRules<P>): Array<{ buy: P; sell: P; tokenIn: string; tokenOut: string }> {
  const out: Array<{ buy: P; sell: P; tokenIn: string; tokenOut: string }> = [];
  const seen = new Set<string>();
  const lc = (x: string) => (x ?? '').toLowerCase();
  const starts = r.startCoins.map(lc);
  for (const k of keys) {
    const p = r.pool(k);
    if (!p) continue;
    const [a, b] = r.tokens(p);
    if (!a || !b || !r.coinAllowed(a) || !r.coinAllowed(b)) continue;
    for (const peer of r.peers(p)) {
      if (lc(r.addr(peer)) === lc(r.addr(p))) continue;
      for (const start of starts) {
        if (lc(a) !== start && lc(b) !== start) continue;
        const tokenIn = lc(a) === start ? a : b;
        const tokenOut = tokenIn === a ? b : a;
        for (const [buy, sell] of [[p, peer], [peer, p]] as Array<[P, P]>) {
          const id = `${lc(r.addr(buy))}>${lc(r.addr(sell))}:${start}`;
          if (seen.has(id)) continue;
          seen.add(id);
          if (r.venueBlocked(buy, sell)) continue;
          out.push({ buy, sell, tokenIn, tokenOut });
        }
      }
    }
  }
  return out;
}

// The chosen trade.
export type EntryPick = {
  cand: EntryCandidate;
  sizeUsd: number;
  amountIn: bigint;
  profitUnits: bigint;
  netUsd: number;                // after gas
  out: TrigOutcome;              // the check's answer (confidence, assumptions)
  q: TrigQuestion;
};

export type EntryDeps = {
  tf: TriggerFirst;
  client: LocalSimClient;
  shadowLog: JsonlLog;
  settings?: EntrySettings;
  env?: Record<string, string | undefined>;
  // Candidate trades for the pools the trigger moved (venue / coin rules
  // already applied by the host; not capped).
  candidatesFor: (poolKeys: string[]) => EntryCandidate[];
  isOurTx: (hash: string) => boolean;
  ourAddresses: string[];                 // our executor contract(s), our bot wallet(s)
  // SAFEGUARDS (null = fine, else why not). See the file header.
  killed: () => boolean;                  // kill file / kill switch
  safety: (sizeUsd: number, tokens: string[]) => string | null;   // SafetyGate (allowlist, caps, daily loss)
  failBlocked: (buyPool: string, sellPool: string) => string | null; // 30-min live-fail block on the pair
  pausedWhy: (conf: TrigConfidence | undefined, assumptions: string[] | undefined) => string | null; // scoreboard
  // The guarded send (host fireTrade: fit-to-wallet, outlier guard, live
  // checks, sender). Resolves with when it was signed (undefined = not sent).
  send: (pick: EntryPick, trigger: { hash: string; seenMs: number }) => Promise<{ signedMs?: number; why?: string }>;
  now?: () => number;
  log?: (m: string) => void;
};

const pctl = (xs: number[], q: number): number | null => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * q))];
};
const pct = (n: number, d: number): string => (d ? `${Math.round((100 * n) / d)}%` : 'n/a');
const keep = (a: number[], v: number) => { a.push(v); if (a.length > 5_000) a.shift(); };

// The promise's answer, or null if it takes longer than ms.
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), Math.max(1, ms));
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
  });
}

export class TrigEntry {
  readonly settings: EntrySettings;
  private readonly d: EntryDeps;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly ours: { isOurTx: (h: string) => boolean; addresses: Set<string> };
  private inFlight = 0;
  // ONE SEND PER TRIGGER (shared with the old path): trigger hash -> who and when.
  private readonly claims = new Map<string, { who: string; at: number }>();
  private hour = this.freshHour();

  private freshHour() {
    return {
      feedTxs: 0, skipped: 0, dropped: 0, asked: 0, discovered: 0, touching: 0,
      answered: 0, profitable: 0, profitUsd: 0, wouldSend: 0, sent: 0, held: 0, errors: 0,
      discoverMs: [] as number[], answerMs: [] as number[], submitMs: [] as number[],
      unknownWhy: {} as Record<string, number>, heldWhy: {} as Record<string, number>,
    };
  }

  constructor(deps: EntryDeps) {
    this.d = deps;
    this.settings = deps.settings ?? entrySettings(deps.env ?? process.env);
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((m) => console.log(m));
    this.ours = { isOurTx: deps.isOurTx, addresses: new Set(deps.ourAddresses.map((a) => a.toLowerCase())) };
    this.log(`[trig-entry] ${this.active() ? deps.tf.mode() : 'off'}: every feed transaction checked as a possible trigger (max ${this.settings.maxInFlight} at once, ${this.settings.maxCandidates} candidates each, sizes $${this.settings.sizesUsd.join('/$')})`);
  }

  // Working at all? (TRIG_FIRST_ENTRY=1 and trigger-first not off.)
  active(): boolean { return this.settings.enabled && this.d.tf.mode() !== 'off'; }

  // ---- shared per-trigger lock --------------------------------------------
  // true = this caller may send for this trigger (first claim, or its own).
  claim(hash: string | undefined, who: 'entry' | 'old'): boolean {
    if (!hash) return true;
    const h = hash.toLowerCase();
    const t = this.now();
    if (this.claims.size > 5_000) for (const [k, v] of this.claims) if (t - v.at > this.settings.lockMs) this.claims.delete(k);
    const c = this.claims.get(h);
    if (c && t - c.at <= this.settings.lockMs && c.who !== who) return false;
    if (!c) this.claims.set(h, { who, at: t });
    return true;
  }

  // ---- the feed tap (robinhoodChain.ts setFeedMsgTap) ------------------------
  // Called for every feed message, right after the order buffer took it.
  // Cheap: the skip test per transaction, then work is started later.
  onFeedMsgs(msgs: FeedMsg[], at: number): void {
    if (!this.active()) return;
    for (const m of msgs) {
      for (const t of m?.txs ?? []) {
        this.hour.feedTxs++;
        try {
          if (quickSkip(t.raw, t.hash, this.ours)) { this.hour.skipped++; continue; }
        } catch { this.hour.skipped++; continue; }
        // Overloaded: drop (counted), never queue up behind the feed.
        if (this.inFlight >= this.settings.maxInFlight) { this.hour.dropped++; continue; }
        this.inFlight++;
        const hash = t.hash.toLowerCase();
        setImmediate(() => {
          void this.process(hash, at).catch(() => { this.hour.errors++; }).finally(() => { this.inFlight--; });
        });
      }
    }
  }

  inFlightNow(): number { return this.inFlight; }

  // ---- one trigger ------------------------------------------------------------
  async process(hash: string, seenMs: number): Promise<EntryRecord | null> {
    const s = this.settings;
    const h = this.hour;
    const deadlineAt = seenMs + s.deadlineMs;
    h.asked++;
    const unknown = (why: string) => { h.unknownWhy[why] = (h.unknownWhy[why] ?? 0) + 1; return null; };
    // 1. DISCOVER: which of our pools does it move? (no node)
    const built = this.d.tf.buildFeed(hash, []);
    if ('why' in built) return unknown(`discover_${built.why}`);
    let a: Record<string, unknown> | null;
    try {
      a = await withDeadline(this.d.client.request({ type: 'trig_discover', at: { after: 'head' }, feed: built.feed }, s.discoverTimeoutMs), s.discoverTimeoutMs + 20);
    } catch { a = null; }
    const discoverMs = this.now() - seenMs;
    keep(h.discoverMs, discoverMs);
    if (!a) return unknown('discover_timeout');
    if (a.ok !== true) return unknown(`discover_${String(a.unknown ?? 'unknown')}`);
    h.discovered++;
    const pools = Array.isArray(a.pools) ? (a.pools as unknown[]).filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase()) : [];
    if (!pools.length) return null; // doesn't move any pool we follow: nothing to do
    h.touching++;
    const rec: EntryRecord = {
      hash, seenMs, pools, discoverMs, discConf: typeof a.conf === 'string' ? a.conf : undefined,
      discAssumed: Array.isArray(a.assumed) ? (a.assumed as string[]).slice(0, 8) : undefined,
      tried: 0, candidates: 0,
    };
    // 2. CANDIDATES (host rules), capped.
    let cands: EntryCandidate[] = [];
    try { cands = this.d.candidatesFor(pools); } catch { h.errors++; }
    rec.candidates = cands.length;
    cands = cands.slice(0, s.maxCandidates);
    rec.tried = cands.length;
    if (!cands.length) { rec.unknown = 'no_candidates'; unknown('no_candidates'); this.finish(rec); return rec; }
    // 3. SIZE + CHECK every candidate at once (each one sidecar request).
    const left = Math.max(1, deadlineAt - this.now());
    const results = await Promise.all(cands.map((c) => withDeadline(this.checkCandidate(c, hash, seenMs), left)));
    rec.answerMs = this.now() - seenMs;
    keep(h.answerMs, rec.answerMs);
    const picks = results.filter((r): r is CandResult => !!r);
    const sure = picks.filter((r) => r.out.sure);
    if (!sure.length) {
      const why = picks.find((r) => r.out.why)?.out.why ?? (picks.length ? 'unknown' : 'deadline');
      rec.unknown = why; unknown(why); this.finish(rec); return rec;
    }
    h.answered++;
    const best = sure.map((r) => r.pick).filter((p): p is EntryPick => !!p).sort((x, y) => y.netUsd - x.netUsd)[0];
    if (best) {
      rec.best = { label: best.cand.label, sizeUsd: best.sizeUsd, netUsd: best.netUsd, conf: best.out.confidence, as: best.out.assumptions };
    }
    // 4. DECIDE.
    if (!best || !(best.netUsd >= s.minNetUsd)) { this.finish(rec, best); return rec; }
    h.profitable++;
    h.profitUsd += best.netUsd;
    const held = this.gates(best);
    rec.held = held ?? undefined;
    if (held) { h.held++; const k = held.split(':')[0]; h.heldWhy[k] = (h.heldWhy[k] ?? 0) + 1; }
    const deciding = this.d.tf.decides();
    if (!held && !deciding) { h.wouldSend++; rec.wouldSend = true; }
    if (!held && deciding) {
      if (!this.claim(hash, 'entry')) { rec.held = 'already sent by the old path'; }
      else {
        rec.wouldSend = true;
        try {
          const r = await this.d.send(best, { hash, seenMs });
          if (r.signedMs !== undefined) { rec.submitMs = r.signedMs - seenMs; keep(h.submitMs, rec.submitMs); h.sent++; }
          else rec.held = `not sent: ${r.why ?? 'stopped by a safeguard'}`;
        } catch { h.errors++; rec.held = 'send error'; }
      }
    }
    this.finish(rec, best);
    return rec;
  }

  // SAFEGUARDS checked here before the host's own (see the file header).
  // null = all pass. The old model guess and the 6 h liveBlocks / bench
  // lists are deliberately NOT checked for entry-point sends.
  gates(p: EntryPick): string | null {
    if (this.d.killed()) return 'kill switch on';
    if (!(p.netUsd >= this.settings.minNetUsd)) return `under the send minimum ($${this.settings.minNetUsd})`;
    if (!confidenceAtLeast(p.out.confidence, this.d.tf.settings.minConfidence)) return `confidence ${p.out.confidence} below ${this.d.tf.settings.minConfidence}`;
    const fb = this.d.failBlocked(p.cand.buyPool, p.cand.sellPool);
    if (fb) return `pair blocked 30 min: ${fb}`;
    const sg = this.d.safety(p.sizeUsd, p.cand.tokens);
    if (sg) return `safety: ${sg}`;
    const pz = this.d.pausedWhy(p.out.confidence, p.out.assumptions);
    if (pz) return `scoreboard: ${pz}`;
    return null;
  }

  // One candidate: the full trigger-first check at the biggest size of the
  // ladder, the smaller sizes on the same replay; its best size.
  private async checkCandidate(c: EntryCandidate, hash: string, seenMs: number): Promise<CandResult | null> {
    const sizes = this.settings.sizesUsd.filter((x) => x <= c.maxSizeUsd);
    if (!sizes.length && c.maxSizeUsd > 0) sizes.push(c.maxSizeUsd);
    if (!sizes.length) return null;
    const main = sizes[sizes.length - 1];
    const b = c.build(main);
    if (!b) return null;
    const amt = (usd: number) => (b.trade.amountIn * BigInt(Math.round(usd * 1e6))) / BigInt(Math.round(main * 1e6));
    const others = sizes.slice(0, -1).map(amt).filter((x) => x > 0n);
    const q: TrigQuestion = { trade: b.trade, simOpts: b.simOpts, triggerHash: hash, seenMs, keys: c.keys, label: c.label };
    const out = await this.d.tf.askOnly(q, others);
    if (!out.sure) return { out };
    // Every profitable size: net after gas; the best one. (A profit bigger
    // than the trade itself is bad data, never used.)
    const rows: Array<{ amount: bigint; profit: bigint; sizeUsd: number }> = [];
    if (out.sim.status === 'profit') rows.push({ amount: b.trade.amountIn, profit: out.sim.profit, sizeUsd: main });
    for (const r of out.ladder ?? []) if (r.status === 'profit') rows.push({ amount: r.amount, profit: r.profit, sizeUsd: (main * Number(r.amount)) / Number(b.trade.amountIn) });
    let pick: EntryPick | undefined;
    for (const r of rows) {
      if (r.profit <= 0n || r.profit > r.amount) continue;
      const net = c.usdOf(r.profit) - c.gasUsd;
      if (!Number.isFinite(net)) continue;
      if (!pick || net > pick.netUsd) pick = { cand: c, sizeUsd: r.sizeUsd, amountIn: r.amount, profitUnits: r.profit, netUsd: net, out, q };
    }
    return { out, pick };
  }

  // ---- log line -----------------------------------------------------------------
  // Written once the later same-block re-check is in (or after finalize ms).
  private finish(rec: EntryRecord, best?: EntryPick): void {
    const write = (ag?: Awaited<ReturnType<TriggerFirst['agreeLater']>>) => {
      try {
        this.d.shadowLog.add({
          t: this.now(), k: 'trig_entry', mode: this.d.tf.mode(), tx: rec.hash.slice(0, 12),
          // what it moved, how sure the "which pools" answer was
          pools: rec.pools, dconf: rec.discConf, das: rec.discAssumed?.length ? rec.discAssumed : undefined,
          // candidates: found / checked; the best route, size, net after gas
          cands: rec.candidates, tried: rec.tried,
          best: rec.best?.label, size: rec.best ? Math.round(rec.best.sizeUsd) : undefined, net: rec.best ? Math.round(rec.best.netUsd * 100) / 100 : undefined,
          conf: rec.best?.conf, as: rec.best?.as?.length ? rec.best.as : undefined, u: rec.unknown,
          // decision: would send (shadow) / sent (on), or what held it back
          would: rec.wouldSend || undefined, held: rec.held,
          // timing (ms after the feed showed it)
          discMs: rec.discoverMs, ansMs: rec.answerMs, subMs: rec.submitMs,
          // later same-block re-check of the best candidate (as trig_first lines)
          agree: ag?.agree, agV: ag?.agV, same: ag?.same, agSkip: ag?.agSkip, rblk: ag?.rblk, rAfterMs: ag?.rAfterMs,
          seen: rec.seenMs,
        });
      } catch { this.hour.errors++; }
    };
    if (!best?.out.sure) { write(); return; }
    // The re-check waits for the trigger's block reports (bounded by the
    // trigger-first settings); never holds up anything else.
    void withDeadline(this.d.tf.agreeLater(best.q, best.out), this.d.tf.settings.finalizeMs).then((ag) => write(ag ?? { agSkip: 'not in time' }));
  }

  // ---- hourly line --------------------------------------------------------------
  // "[trig-entry] hour: shadow: 36000 feed txs, 12000 looked at (dropped 0),
  //  moving our pools 300 (3%), answered 250 (83%), profitable 4 ($3.10),
  //  would send 3, sent 0; feed->discover p50 4 ms p90 9 ms; feed->answer
  //  ...; unknown: ..."
  takeHourLine(): string | null {
    try {
      const h = this.hour;
      this.hour = this.freshHour();
      if (!this.active()) return null;
      const ms = (xs: number[]) => (xs.length ? `p50 ${pctl(xs, 0.5)} ms, p90 ${pctl(xs, 0.9)} ms` : 'n/a');
      const top = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ${n}`).join(', ');
      const parts = [
        `${h.feedTxs} feed txs, ${h.asked} looked at (skipped ${h.skipped}, dropped ${h.dropped} overloaded)`,
        `moving our pools ${h.touching} (${pct(h.touching, h.discovered)} of ${h.discovered} answered)`,
        `answered ${h.answered} (${pct(h.answered, h.touching)})`,
        `profitable ${h.profitable} ($${h.profitUsd.toFixed(2)} after gas)`,
        `would send ${h.wouldSend}, sent ${h.sent}${h.held ? `, held back ${h.held} (${top(h.heldWhy)})` : ''}`,
        `feed->discover ${ms(h.discoverMs)}`, `feed->answer ${ms(h.answerMs)}`,
      ];
      if (h.submitMs.length) parts.push(`feed->submit ${ms(h.submitMs)}`);
      const line = `Trigger-first entry (${this.d.tf.decides() ? 'on' : this.d.tf.mode()}): ${parts.join('; ')}`;
      const whys = top(h.unknownWhy);
      this.log(`[trig-entry] hour: ${line}${whys ? ` | unknown because: ${whys}` : ''}${h.errors ? ` | errors ${h.errors}` : ''}`);
      return line;
    } catch { return null; }
  }
}

type CandResult = { out: TrigOutcome; pick?: EntryPick };

// One trigger's facts (for its log line; process() returns it for tests).
export type EntryRecord = {
  hash: string;
  seenMs: number;
  pools: string[];
  discoverMs: number;
  discConf?: string;
  discAssumed?: string[];
  candidates: number;
  tried: number;
  answerMs?: number;
  submitMs?: number;
  unknown?: string;
  best?: { label: string; sizeUsd: number; netUsd: number; conf?: TrigConfidence; as?: string[] };
  wouldSend?: boolean;
  held?: string;
};
