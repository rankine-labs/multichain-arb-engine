import { FeedMsg, decodeFeedTx, peekFeedTx } from '../chains/nitroFeed';
import { performance } from 'perf_hooks';
import { LocalSimClient, SidecarAnswer } from './localSim';
import { JsonlLog, LocalTrade, LocalSimOpts, reasonOf } from './localSimHost';
import { TriggerFirst, TrigOutcome, TrigConfidence, TrigQuestion, CannedAnswer, CapturedCheck, checkSig, confidenceAtLeast } from './triggerFirst';
import { loopLag } from '../core/loopLag';
import { stallFinder, markStretch } from '../core/stallFinder';
import * as fs from 'fs';

// SEEN LOG (Oct 24, owner approved): one short line per feed transaction
// fire-first looked at (or dropped): "<ms> <hash> <outcome>", outcome =
// pools:<n> | no_pools | dropped | skipped is NOT written | <unknown reason>.
// Lets us line up every rival win against what fire-first saw for the
// trades before it in that block. TRIG_SEEN_LOG=<path> turns it on (e.g.
// data/trig-seen.log); unset or 0 = off (tests never write it). Rotates at TRIG_SEEN_LOG_MB (100 MB, keeps
// one .1 file). Buffered: written about once a second, never on the hot path.
class SeenLog {
  private buf: string[] = [];
  private bytes = 0;
  constructor(private readonly path: string, private readonly maxBytes: number) {
    try { this.bytes = fs.statSync(path).size; } catch { this.bytes = 0; }
    const t = setInterval(() => this.flush(), 1_000);
    t.unref?.();
  }
  add(hash: string, outcome: string): void {
    if (this.buf.length < 50_000) this.buf.push(`${Date.now()} ${hash} ${outcome}`);
  }
  private flush(): void {
    if (!this.buf.length) return;
    const text = this.buf.join('\n') + '\n';
    this.buf = [];
    try {
      if (this.bytes + text.length > this.maxBytes) {
        try { fs.renameSync(this.path, this.path + '.1'); } catch { /* first file */ }
        this.bytes = 0;
      }
      fs.appendFile(this.path, text, () => { /* reporting only */ });
      this.bytes += text.length;
    } catch { /* reporting only */ }
  }
}
function seenLogFromEnv(env: Record<string, string | undefined> = process.env): SeenLog | null {
  const p = (env.TRIG_SEEN_LOG ?? '').trim();
  if (!p || p === '0') return null;
  const mb = Number(env.TRIG_SEEN_LOG_MB ?? 100);
  return new SeenLog(p, (Number.isFinite(mb) && mb > 0 ? mb : 100) * 1_048_576);
}

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
//      lists, exchange / coin rules, lender choice and buildCheck. Ranked
//      (a coin we hold first, then the model's quick price check) and capped
//      at TRIG_ENTRY_MAX_CANDIDATES BEFORE anything is built. More than
//      TRIG_ENTRY_MAX_POOLS moved pools = a suspicious answer: skipped.
//      (Oct 23 fix: the first version named every V4 pool for every V4 swap,
//      see sim/src/check/moved.rs.)
//   3. SIZE + CHECK: each candidate is checked with the full trigger-first
//      check (every feed transaction in sequence order, then our exact
//      trade), at the biggest allowed size of the ladder TRIG_ENTRY_SIZES_USD,
//      and the smaller sizes on the SAME replay in the SAME request (size
//      ladder, after ONE replay). Best-ranked first, TRIG_ENTRY_PARALLEL
//      at a time (TRIG_ENTRY_MAX_CHECKS over all triggers), stopping at the
//      first sure answer good enough to send. The best net after gas wins.
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
// LOAD: never blocks the feed handler (work starts at once, up to the first
// question, or with setImmediate: TRIG_ENTRY_IMMEDIATE), at
// most TRIG_ENTRY_MAX_IN_FLIGHT triggers at once (more = dropped, counted),
// every sidecar question has a timeout and the whole trigger a deadline. No
// node requests at all in this path.
//
// SWITCHES: LOCAL_SIM_TRIGGER_FIRST (off / shadow / on, the same switch as
// the old hook) and TRIG_FIRST_ENTRY (1 = on, the default; 0 = off).
// LOG: data/local-sim-shadow.jsonl lines "k":"trig_entry" (one per trigger
// that moved one of our pools) and an hourly "[trig-entry] hour:" line.
//
// SPEED + VISIBILITY (Oct 23, second pass; live shadow showed ~45 ms p50 /
// ~100 ms p90 from feed to answer while the actual work is ~0.05 ms, i.e.
// almost all of it is WAITING):
//   LOGGING   every answered trigger now logs its best candidate even when
//             it loses (net after gas can be negative; a "loss" answer only
//             says "no profit", so its net is "at most minus gas": nle),
//             a verdict per candidate (cv), and a SAMPLE of the not-
//             profitable answers (TRIG_ENTRY_AGREE_SAMPLE, 1 in 5, at most
//             TRIG_ENTRY_AGREE_SAMPLE_PER_HOUR) gets the later same-block
//             re-check too, so we can see whether "no profit" was right.
//   HOPS      per-hop timestamps (ms after the feed frame arrived, 2
//             decimals) in the log line's `hops` and p50 / p90 per hop in
//             the hourly line: frame parsed, queued, sent to the sidecar,
//             answered (+ the sidecar's own queue wait vs work), candidates
//             built, each check, decision, signed; plus event-loop lag.
//   ONE TRIP  (TRIG_ENTRY_ONE_TRIP=1, default) discovery AND the candidate
//             checks in ONE sidecar question (`trig_entry`, sim/src/server.rs
//             + sim/src/check/entry.rs). The bot keeps a candidate TABLE in
//             the sidecar (refreshed every TRIG_ENTRY_TABLE_MS): per watched
//             pool, its routes with the same ranking facts and our exact
//             check question, built by the same code as the two-step path.
//             The sidecar picks the candidates exactly like the bot, checks
//             them, and the bot reads each answer with its OWN code
//             (TriggerFirst.askOnly with a "canned" answer), so the decision
//             is the same as the two-step path (tested). Anything missing
//             (no table yet, an old sidecar, a changed trade) = the two-step
//             path, unchanged.
//   PRIORITY  the sidecar serves trigger-entry questions first (bounded,
//             sim/src/jobq.rs); the bot starts entry work right inside the
//             feed handler (TRIG_ENTRY_IMMEDIATE=1) and, while it is in
//             flight, big background jobs take shorter bites
//             (TRIG_ENTRY_YIELD_SLICE_MS, core/chunked.ts).
//
// 3-POOL LOOPS (Oct 23, owner: "maximise income"; TRIG_ENTRY_LOOPS=1, the
// default; 0 = 2-pool only as before). A 24 h chain measurement showed 3-pool
// loops earn about as much as 2-pool trades and are ~4x as frequent, but this
// entry point only tried 2-pool routes. Now, for each moved pool, loops
// start coin (USDG / WETH) -> A -> B -> start through that pool are extra
// candidates (execution/trigEntryLoops.ts: precomputed per pool, same live
// rules as live loops). Ranked by the same rule, capped separately
// (TRIG_ENTRY_MAX_LOOPS, 4), checked exactly like 2-pool candidates (our
// exact multi-hop call on the replayed feed, size ladder), and a send goes
// through every safeguard above PLUS the loop ones (loopGate: loop loss cap,
// loop size limit, a loop on the same pools in flight) and the host's loop
// sender. Log: each `cv` entry says its kind (`k`: pair / loop); `fl` / `nl`
// = loops found / built; hourly "by kind" split.
// ============================================================================

export type EntrySettings = {
  enabled: boolean;              // TRIG_FIRST_ENTRY [1] (and LOCAL_SIM_TRIGGER_FIRST not off)
  maxInFlight: number;           // TRIG_ENTRY_MAX_IN_FLIGHT [4] triggers CHECKED at once (they move our pools); more are dropped
  maxDiscover: number;           // TRIG_ENTRY_MAX_DISCOVER [24] triggers asked "which pools?" at once (cheap, ~4 ms); more are dropped
  hotExtra: number;              // TRIG_ENTRY_HOT_EXTRA [16] extra places for transactions sent to a hot target (never dropped first)
  maxCandidates: number;         // TRIG_ENTRY_MAX_CANDIDATES [6] candidate trades built and checked per trigger (best-ranked first)
  maxPools: number;              // TRIG_ENTRY_MAX_POOLS [4] more moved pools than this = suspicious answer, skipped ("too_many_pools")
  parallel: number;              // TRIG_ENTRY_PARALLEL [2] candidate checks of one trigger at once
  maxChecks: number;             // TRIG_ENTRY_MAX_CHECKS [2] candidate checks at once over ALL triggers (sidecar workers: ARBSIM_WORKERS)
  sizesUsd: number[];            // TRIG_ENTRY_SIZES_USD [50,150,400] trade size ladder ($)
  discoverTimeoutMs: number;     // TRIG_ENTRY_DISCOVER_TIMEOUT_MS [40] the "which pools?" question
  deadlineMs: number;            // TRIG_ENTRY_DEADLINE_MS [250] the whole trigger (discover + checks)
  minNetUsd: number;             // MIN_EXEC_NET_USD (the bot's one send minimum)
  lockMs: number;                // how long a trigger stays claimed [120000]
  oneTrip: boolean;              // TRIG_ENTRY_ONE_TRIP [1] discovery + checks in one sidecar question (0 = two steps, as before)
  tableMs: number;               // TRIG_ENTRY_TABLE_MS [1000] how often the candidate table is rebuilt (0 = only when asked)
  tableReuseMs: number;          // TRIG_ENTRY_TABLE_REUSE_MS [5000] a route whose pools did not change keeps its written-down question this long (0 = rebuild every route every time)
  agreeSample: number;           // TRIG_ENTRY_AGREE_SAMPLE [5] re-check 1 in N not-profitable answers (0 = none)
  agreeSamplePerHour: number;    // TRIG_ENTRY_AGREE_SAMPLE_PER_HOUR [120] at most this many of those per hour
  immediate: boolean;            // TRIG_ENTRY_IMMEDIATE [1] start entry work inside the feed handler (0 = after it, setImmediate)
  yieldSliceMs: number;          // TRIG_ENTRY_YIELD_SLICE_MS [2] big jobs' longest bite while entry work runs (0 = no change)
  loops: boolean;                // TRIG_ENTRY_LOOPS [1] also try 3-pool loops through the moved pool (0 = 2-pool only, as before)
  maxLoops: number;              // TRIG_ENTRY_MAX_LOOPS [4] loop candidates built and checked per trigger (on top of TRIG_ENTRY_MAX_CANDIDATES)
  fastlaneFacts: boolean;        // FASTLANE=practice|live: table rows also carry "f" facts for the Rust scanner (off = as before)
};

export function entrySettings(env: Record<string, string | undefined> = process.env, minNetUsd = 0.25): EntrySettings {
  const num = (k: string, d: number, min = 1) => { const v = Number(env[k]); return env[k] !== undefined && env[k]!.trim() !== '' && Number.isFinite(v) && v >= min ? v : d; };
  const sizes = (env.TRIG_ENTRY_SIZES_USD ?? '50,150,400').split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  return {
    enabled: (env.TRIG_FIRST_ENTRY ?? '1').trim() !== '0',
    maxInFlight: Math.round(num('TRIG_ENTRY_MAX_IN_FLIGHT', 4)),
    maxDiscover: Math.round(num('TRIG_ENTRY_MAX_DISCOVER', 24)),
    hotExtra: Math.round(num('TRIG_ENTRY_HOT_EXTRA', 16, 0)),
    maxCandidates: Math.round(num('TRIG_ENTRY_MAX_CANDIDATES', 6)),
    maxPools: Math.round(num('TRIG_ENTRY_MAX_POOLS', 4)),
    parallel: Math.round(num('TRIG_ENTRY_PARALLEL', 2)),
    maxChecks: Math.round(num('TRIG_ENTRY_MAX_CHECKS', 2)),
    sizesUsd: sizes.length ? sizes.slice(0, 6) : [50, 150, 400],
    discoverTimeoutMs: num('TRIG_ENTRY_DISCOVER_TIMEOUT_MS', 40),
    deadlineMs: num('TRIG_ENTRY_DEADLINE_MS', 250),
    minNetUsd,
    lockMs: 120_000,
    oneTrip: (env.TRIG_ENTRY_ONE_TRIP ?? '1').trim() !== '0',
    tableMs: num('TRIG_ENTRY_TABLE_MS', 1_000, 0),
    tableReuseMs: num('TRIG_ENTRY_TABLE_REUSE_MS', 5_000, 0),
    agreeSample: Math.round(num('TRIG_ENTRY_AGREE_SAMPLE', 5, 0)),
    agreeSamplePerHour: Math.round(num('TRIG_ENTRY_AGREE_SAMPLE_PER_HOUR', 120, 0)),
    immediate: (env.TRIG_ENTRY_IMMEDIATE ?? '1').trim() !== '0',
    yieldSliceMs: num('TRIG_ENTRY_YIELD_SLICE_MS', 2, 0),
    loops: (env.TRIG_ENTRY_LOOPS ?? '1').trim() !== '0',
    maxLoops: Math.round(num('TRIG_ENTRY_MAX_LOOPS', 4, 0)),
    fastlaneFacts: fastlaneFactsOn(env),
  };
}

// Calls that never move a pool by themselves (the coin's own functions):
// approve, transfer, transferFrom, WETH deposit / withdraw, permit,
// setApprovalForAll. Sent straight to a coin, they can't open an arb.
const NON_SWAP = new Set(['0x095ea7b3', '0xa9059cbb', '0x23b872dd', '0xd0e30db0', '0x2e1a7d4d', '0xd505accf', '0xa22cb465']);

// The `to` address of a raw feed transaction (lower case), null if unreadable / create.
export function toOf(raw: string): string | null {
  try {
    const p = process.env.FEED_LIGHT_DECODE !== '0' ? peekFeedTx(raw) : undefined;
    if (p === null) return null;
    const tx = p ?? decodeFeedTx(raw);
    return tx?.to ? tx.to.toLowerCase() : null;
  } catch { return null; }
}

// Why a feed transaction needs no work at all (null = look at it).
export function quickSkip(raw: string, hash: string, ours: { isOurTx: (h: string) => boolean; addresses: Set<string> }): string | null {
  if (ours.isOurTx(hash)) return 'ours';
  // Freeze fix 2 (Oct 24): the light read (chains/nitroFeed.ts peekFeedTx)
  // gives `to` and the call data straight from the bytes, with ethers' own
  // accept / refuse rules; ethers' full unpack (decodeFeedTx, ~250 us and
  // ~300 KB of throw-away memory per swap) only when the light read is not
  // sure, or with FEED_LIGHT_DECODE=0. Same answers (tested).
  const p = process.env.FEED_LIGHT_DECODE !== '0' ? peekFeedTx(raw) : undefined;
  if (p === null) return 'unreadable';
  const tx: { to: string | null; data: string } | null = p ?? decodeFeedTx(raw);
  if (!tx) return 'unreadable';
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
  // 3-POOL LOOPS (execution/trigEntryLoops.ts): 'loop' candidates go through
  // the loop safeguards too (loopGate) and the host's loop send. Not given = 'pair'.
  kind?: 'pair' | 'loop';
  // The two keys of its 30-min live-fail block (default [buyPool, sellPool];
  // a loop uses [first pool, its loop id], so one loop's failure blocks that loop).
  failKey?: [string, string];
  // Ranking facts (a start coin we hold, the quick price check in $ before
  // gas, a loop's extra gas already taken off): used to merge loops in among
  // the 2-pool candidates in rank order. Not given = keeps its place.
  rank?: { held: boolean; score: number | null };
  // FAST LANE (Oct 26, sim/src/fastlane/scan.rs): the start coin's USD price
  // and decimals and the lender's fee (pips, 0 = own money), so the Rust
  // scanner can value a result exactly as usdOf / gasUsd do. Only sent to
  // the sidecar when FASTLANE=practice|live. Not given = not sent.
  fx?: { px: number; d: number; lp?: number };
};

// FASTLANE=practice|live (same words as sim/src/fastlane/mode.rs): the
// candidate table also carries each route's facts ("f") for the Rust
// standing-gap scanner. Off (default): the table is exactly as before.
export function fastlaneFactsOn(env: Record<string, string | undefined> = process.env): boolean {
  return ['practice', 'shadow', 'dry', 'live'].includes((env.FASTLANE ?? '').trim().toLowerCase());
}

// The facts row ("f") for one candidate, or null when it can't be valued.
// px keeps 9 significant digits (the bot's own price is a float anyway).
export function fastlaneFacts(c: EntryCandidate): Record<string, unknown> | null {
  const fx = c.fx;
  if (!fx || !(fx.px > 0) || !Number.isFinite(fx.px) || !Number.isInteger(fx.d) || fx.d < 0 || fx.d > 36 || !(c.gasUsd >= 0)) return null;
  const f: Record<string, unknown> = { l: c.label.slice(0, 80), px: Number(fx.px.toPrecision(9)), d: fx.d, g: Number(c.gasUsd.toPrecision(9)) };
  if (fx.lp !== undefined && Number.isFinite(fx.lp) && fx.lp >= 0) f.lp = Math.round(fx.lp);
  return f;
}

// A route's id: "buy>sell:start" (lowercase). Two pools moved by one
// trigger can list the same route; it is checked once.
export function routeId(buyAddr: string, sellAddr: string, start: string): string {
  const lc = (x: string) => (x ?? '').toLowerCase();
  return `${lc(buyAddr)}>${lc(sellAddr)}:${lc(start)}`;
}

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
export type EntryRoute<P> = { buy: P; sell: P; tokenIn: string; tokenOut: string; id: string };
export function enumerateRoutes<P>(keys: string[], r: RouteRules<P>): Array<EntryRoute<P>> {
  const out: Array<EntryRoute<P>> = [];
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
          const id = routeId(r.addr(buy), r.addr(sell), start);
          if (seen.has(id)) continue;
          seen.add(id);
          if (r.venueBlocked(buy, sell)) continue;
          out.push({ buy, sell, tokenIn, tokenOut, id });
        }
      }
    }
  }
  return out;
}

// RANKING before anything is built (cheap): routes starting from a coin we
// actually hold first, then the model's quick price check (higher = better;
// null or not a real number = unknown, last). Returns the best `limit`.
// (The sidecar's one-trip picking, sim/src/check/entry.rs select, does
// exactly the same; tests/fixtures/trig_entry_select.json checks both.)
export function rankRoutes<R>(routes: R[], held: (r: R) => boolean, score: (r: R) => number | null, limit: number): R[] {
  const scored = routes.map((r, i) => { const s = score(r); return { r, i, h: held(r) ? 0 : 1, s: s !== null && Number.isFinite(s) ? s : -Infinity }; });
  scored.sort((a, b) => a.h - b.h || (b.s === a.s ? 0 : b.s > a.s ? 1 : -1) || a.i - b.i);
  return scored.slice(0, Math.max(0, limit)).map((x) => x.r);
}

// MERGE two candidate lists that are each already in rank order (2-pool
// candidates and loop candidates) into one, by the same rule as rankRoutes:
// a start coin we hold first, then the higher quick price check (unknown
// last). Ties keep the first list's candidate first (2-pool before loop).
// A candidate without ranking facts keeps its place in its own list.
export function mergeRanked(a: EntryCandidate[], b: EntryCandidate[]): EntryCandidate[] {
  if (!b.length) return a.slice();
  if (!a.length) return b.slice();
  const key = (c: EntryCandidate) => ({ h: c.rank ? (c.rank.held ? 0 : 1) : 0, s: c.rank && c.rank.score !== null && Number.isFinite(c.rank.score) ? c.rank.score : -Infinity });
  const out: EntryCandidate[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const x = key(a[i]), y = key(b[j]);
    // b goes first only when it is strictly better.
    if (y.h < x.h || (y.h === x.h && y.s > x.s)) out.push(b[j++]); else out.push(a[i++]);
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

// The size ladder of one candidate (shared by the check and the one-trip
// table, so both ask exactly the same): the biggest allowed size of
// TRIG_ENTRY_SIZES_USD is THE trade, the smaller ones ride along as amounts.
export function ladderPlan(c: EntryCandidate, sizesUsd: number[]): { main: number; b: { trade: LocalTrade; simOpts: LocalSimOpts }; others: bigint[] } | null {
  const sizes = sizesUsd.filter((x) => x <= c.maxSizeUsd);
  if (!sizes.length && c.maxSizeUsd > 0) sizes.push(c.maxSizeUsd);
  if (!sizes.length) return null;
  const main = sizes[sizes.length - 1];
  const b = c.build(main);
  if (!b) return null;
  const amt = (usd: number) => (b.trade.amountIn * BigInt(Math.round(usd * 1e6))) / BigInt(Math.round(main * 1e6));
  const others = sizes.slice(0, -1).map(amt).filter((x) => x > 0n);
  return { main, b, others };
}

// The smallest profit (start-coin units) that clears the send minimum
// after gas, by the candidate's OWN money conversion (so the sidecar's stop
// rule "profit >= this" is exactly the bot's "net >= minimum"). null = none.
export function stopUnits(c: EntryCandidate, minNetUsd: number): bigint | null {
  const ok = (u: bigint) => { const n = c.usdOf(u) - c.gasUsd; return Number.isFinite(n) && n >= minNetUsd; };
  if (ok(1n)) return 1n;
  let hi = 2n;
  while (!ok(hi)) { hi *= 2n; if (hi > 1n << 240n) return null; }
  let lo = hi / 2n;
  while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (ok(mid)) hi = mid; else lo = mid; }
  return hi;
}

// A written-down check question with other amounts put in (see
// TrigEntry.captureFor): the call's amountIn word (4th word after the 4-byte
// code) and every pretend-state value that held exactly the old amount (the
// test contract's trading money), plus the ladder amounts.
export function patchAmounts(cap: CapturedCheck, oldAmount: bigint, amount: bigint, others: bigint[]): CapturedCheck {
  const w = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
  const oldW = w(oldAmount).toLowerCase();
  const newW = w(amount);
  const at = 2 + 8 + 3 * 64;
  const data = cap.data.slice(0, at) + newW.slice(2) + cap.data.slice(at + 64);
  const swap = (v: unknown): unknown => {
    if (typeof v === 'string') return v.toLowerCase() === oldW ? newW : v;
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'code' ? x : swap(x)]));
    return v;
  };
  const calls = cap.calls.map((c, i) => (i === 0 ? { ...(c as Record<string, unknown>), data } : c));
  return {
    calls, overrides: swap(cap.overrides) as Record<string, unknown>, data,
    ...(cap.sizes ? { sizes: { amountOffset: cap.sizes.amountOffset, amounts: others.slice(0, 8).map((a) => '0x' + a.toString(16)) } } : {}),
  };
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

// One watched pool's routes for the one-trip table (host: the same route
// rules, ranking facts and build as candidatesFor).
// `inputs` (freeze fix, Oct 23, optional): what this route's written-down
// question is made from, as things that are replaced (never edited) when
// they change: the two pool states, their seen-fee records, the start
// coin's price and decimals. Same things (===) as last time = the question
// written last time is reused (up to TRIG_ENTRY_TABLE_REUSE_MS old) instead
// of being built again (~1 ms each). Not given = always rebuilt.
export type TableRoute = { rid: string; held: boolean; score: number | null; build: () => EntryCandidate | null; inputs?: unknown[] };
// `routes` may be a function (freeze fix): then a pool's routes are listed
// only when the table builder reaches that pool, in small bites, instead
// of every pool's routes in one go before building starts.
export type TablePool = { pool: string; routes: TableRoute[] | (() => TableRoute[]) };

export type EntryDeps = {
  tf: TriggerFirst;
  client: LocalSimClient;
  shadowLog: JsonlLog;
  settings?: EntrySettings;
  env?: Record<string, string | undefined>;
  // Candidate trades for the pools the trigger moved: the host lists the
  // routes (cheap), ranks them (rankRoutes: a coin we hold first, then the
  // model's quick price check) and BUILDS ONLY the best `limit`. found = how
  // many routes there were before the cap.
  candidatesFor: (poolKeys: string[], limit: number) => { cands: EntryCandidate[]; found: number };
  // ONE TRIP: every watched pool with its routes (enumerateRoutes for that
  // pool alone, in order). Not given = one trip off (two steps, as before).
  tableRoutes?: () => TablePool[];
  // 3-POOL LOOPS (TRIG_ENTRY_LOOPS=1): loop candidates through the moved
  // pools, ranked and capped at `limit` BEFORE anything is built (host:
  // precomputed loop index, execution/trigEntryLoops.ts). Not given = none.
  loopCandidatesFor?: (poolKeys: string[], limit: number) => { cands: EntryCandidate[]; found: number };
  // Extra safeguards for a loop send (loop loss cap, loop size limit, a loop
  // on these pools in flight, ...). null = fine. Not given = loops never sent.
  loopGate?: (p: EntryPick) => string | null;
  // One extra hourly text (the loop index / loop sends), optional.
  loopHourText?: () => string | null;
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
  lag?: () => number;                     // event-loop lag right now (ms); default core/loopLag.ts
};

// A candidate's kind (2-pool pair unless it says loop).
const kindOf = (c: EntryCandidate): 'pair' | 'loop' => (c.kind === 'loop' ? 'loop' : 'pair');
const pctl = (xs: number[], q: number): number | null => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * q))];
};
const pct = (n: number, d: number): string => (d ? `${Math.round((100 * n) / d)}%` : 'n/a');
const keep = (a: number[], v: number) => { a.push(v); if (a.length > 5_000) a.shift(); };
const r2 = (x: number) => Math.round(x * 100) / 100;
const hex = (n: bigint) => '0x' + n.toString(16);
const VALID_KEY = /^0x[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$/;

// The promise's answer, or null if it takes longer than ms.
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), Math.max(1, ms));
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
  });
}
const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r));
// The long-code list is tidied once it grows past this many (see compactCodes).
const CODES_SOFT_MAX = 8;
// Same things, one by one (===), same count.
function sameItems(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// High-resolution times of one feed frame (performance.now() ms).
export type FrameTimes = { recv: number; parsed?: number; queued?: number };

// One table entry (the bot's side): the candidate, and our call's data as
// sent (to recognise the answer), or "check it the old way" (fallback).
type TableMeta = { cand: EntryCandidate; sig?: string; fallback?: boolean };

// Hourly per-hop names (ms): see takeHourLine.
const HOP_NAMES = ['parse', 'start', 'sent', 'rtt', 'scQueue', 'scWork', 'scCpu', 'scPlan', 'scEvm', 'scDirty', 'other', 'build', 'check', 'decide', 'lag'] as const;
type HopName = (typeof HOP_NAMES)[number];

export class TrigEntry {
  readonly settings: EntrySettings;
  private readonly d: EntryDeps;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly lagNow: () => number;
  private readonly ours: { isOurTx: (h: string) => boolean; addresses: Set<string> };
  private inFlight = 0;
  // ONE SEND PER TRIGGER (shared with the old path): trigger hash -> who and when.
  private readonly claims = new Map<string, { who: string; at: number }>();
  private hour = this.freshHour();
  private sampleCount = 0;
  private sampleTimes: number[] = [];
  private oneTripOffUntil = 0;

  private freshHour() {
    return {
      feedTxs: 0, skipped: 0, dropped: 0, droppedBusy: 0, hotKept: 0, inCopy: 0, asked: 0, discovered: 0, touching: 0,
      answered: 0, profitable: 0, profitUsd: 0, wouldSend: 0, sent: 0, held: 0, errors: 0,
      discoverMs: [] as number[], answerMs: [] as number[], submitMs: [] as number[],
      unknownWhy: {} as Record<string, number>, heldWhy: {} as Record<string, number>,
      // best net after gas of every answered trigger (profitable or not)
      net: { over: 0, small: 0, slightLoss: 0, loss: 0 },
      // later same-block re-check of a SAMPLE of not-profitable answers
      smp: { asked: 0, agree: 0, disagree: 0, missed: 0, notCompared: 0 },
      // one trip: used / why not
      one: { used: 0, why: {} as Record<string, number> },
      // per candidate kind (2-pool pair / 3-pool loop): built, checked, best answer profitable, would send, sent
      kind: { pair: { built: 0, checked: 0, profitable: 0, wouldSend: 0, sent: 0 }, loop: { built: 0, checked: 0, profitable: 0, wouldSend: 0, sent: 0 } },
      loopErrors: 0,
      hops: Object.fromEntries(HOP_NAMES.map((n) => [n, [] as number[]])) as Record<HopName, number[]>,
    };
  }

  constructor(deps: EntryDeps) {
    this.d = deps;
    this.settings = deps.settings ?? entrySettings(deps.env ?? process.env);
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((m) => console.log(m));
    this.lagNow = deps.lag ?? (() => loopLag.now());
    this.ours = { isOurTx: deps.isOurTx, addresses: new Set(deps.ourAddresses.map((a) => a.toLowerCase())) };
    const one = this.oneTripOn() ? `one trip (table every ${this.settings.tableMs} ms)` : 'two steps';
    this.log(`[trig-entry] ${this.active() ? deps.tf.mode() : 'off'}: every feed transaction checked as a possible trigger (max ${this.settings.maxDiscover} asked "which pools?" and ${this.settings.maxInFlight} checked at once, ${this.settings.maxCandidates} candidates each, sizes $${this.settings.sizesUsd.join('/$')}, ${one})`);
    if (this.active()) {
      if (!deps.lag) loopLag.start();
      if (this.oneTripOn() && this.settings.tableMs > 0) {
        const t = setInterval(() => { void this.refreshTable(); }, this.settings.tableMs);
        t.unref?.();
      }
    }
  }

  // Working at all? (TRIG_FIRST_ENTRY=1 and trigger-first not off.)
  active(): boolean { return this.settings.enabled && this.d.tf.mode() !== 'off'; }
  oneTripOn(): boolean { return this.settings.oneTrip && !!this.d.tableRoutes; }
  // Background jobs' longest bite right now (core/chunked.ts setSliceCap):
  // short while a trigger is being worked on, else no cap (0).
  sliceCapMs(): number { return this.inFlight > 0 ? this.settings.yieldSliceMs : 0; }

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
  // Cheap: the skip test per transaction, then work starts AT ONCE
  // (TRIG_ENTRY_IMMEDIATE=1: the question is on its way to the sidecar
  // before the rest of the bot handles this frame) or right after
  // (setImmediate).
  onFeedMsgs(msgs: FeedMsg[], at: number, hr?: { recv: number; parsed?: number }): void {
    if (!this.active()) return;
    const recv = hr?.recv ?? performance.now();
    for (const m of msgs) {
      for (const t of m?.txs ?? []) {
        this.hour.feedTxs++;
        try {
          const sk = quickSkip(t.raw, t.hash, this.ours);
          // GAP FIX 3 (Oct 24): skipped ones are logged too (with the reason),
          // to find gap-making swaps that never reach "which pools?".
          if (sk) { this.hour.skipped++; if (sk !== 'ours') this.seen?.add(t.hash.toLowerCase(), `skip_${sk}`); continue; }
        } catch { this.hour.skipped++; this.seen?.add(t.hash.toLowerCase(), 'skip_error'); continue; }
        // NO DROP (Oct 24, live: 45% of feed txs were dropped here while 4
        // triggers were being CHECKED, before we even knew if they moved our
        // pools). The cheap "which pools?" question now has its own, bigger
        // limit (TRIG_ENTRY_MAX_DISCOVER); only triggers that move our pools
        // take one of the TRIG_ENTRY_MAX_IN_FLIGHT check places (process).
        // Overloaded: drop (counted), never queue up behind the feed.
        // GAP FIX 2 (Oct 24): never drop a transaction sent to a contract
        // whose transactions recently moved our pools (a router, a pool, a
        // bot contract: learned below, "hot"); those get TRIG_ENTRY_HOT_EXTRA
        // more places. Live: 3 of 13 gap-making swaps behind rival wins were
        // dropped here as "busy".
        const full = this.inFlight >= Math.max(this.settings.maxDiscover, this.settings.maxInFlight);
        // Always read `to` (a few microseconds): it is how hot targets are
        // learned in the first place (bug Oct 25: only read once some were
        // known, so none ever were).
        const to = toOf(t.raw);
        const isHot = !!to && this.hot.has(to);
        if (full && !(isHot && this.inFlight < Math.max(this.settings.maxDiscover, this.settings.maxInFlight) + this.settings.hotExtra)) { this.hour.dropped++; this.seen?.add(t.hash.toLowerCase(), 'dropped'); continue; }
        if (full) this.hour.hotKept++;
        if (to) this.toByHash.set(t.hash.toLowerCase(), to);
        this.inFlight++;
        const hash = t.hash.toLowerCase();
        const times: FrameTimes = { recv, parsed: hr?.parsed, queued: performance.now() };
        // Timed as "trig entry" (its own name in the freeze report, not
        // part of "feed frame"); the parts after its waits are named too.
        const run = () => { const end = stallFinder.begin('trig entry'); try { void this.process(hash, at, times).catch(() => { this.hour.errors++; }).finally(() => { this.inFlight--; }); } finally { end(); } };
        if (this.settings.immediate) run(); else setImmediate(run);
      }
    }
  }

  inFlightNow(): number { return this.inFlight; }

  // ---- hot targets (GAP FIX 2) ---------------------------------------------------
  // Contracts whose transactions moved our pools in the last ~30 min.
  private readonly hot = new Map<string, number>();
  private readonly toByHash = new Map<string, string>();
  private noteHot(to: string): void {
    const now = this.now();
    this.hot.set(to, now);
    if (this.hot.size > 2_000) for (const [k, v] of this.hot) if (now - v > 1_800_000) this.hot.delete(k);
  }
  hotCount(): number { return this.hot.size; }

  // ---- one trigger ------------------------------------------------------------
  // Check places in use (triggers that move our pools, being sized and
  // checked); at most TRIG_ENTRY_MAX_IN_FLIGHT.
  private checking = 0;
  checkingNow(): number { return this.checking; }

  // SEEN LOG (see the top of the file): only with TRIG_SEEN_LOG set.
  private readonly seen: SeenLog | null = seenLogFromEnv();

  async process(hash: string, seenMs: number, times?: FrameTimes): Promise<EntryRecord | null> {
    const slot: { held: boolean; out?: string } = { held: false };
    try { return await this.processInner(hash, seenMs, times, slot); }
    finally {
      if (slot.held) this.checking--;
      this.toByHash.delete(hash);
      if (this.toByHash.size > 5_000) this.toByHash.clear();
      this.seen?.add(hash, slot.out ?? 'other');
    }
  }

  private async processInner(hash: string, seenMs: number, times: FrameTimes | undefined, slot: { held: boolean; out?: string }): Promise<EntryRecord | null> {
    const s = this.settings;
    const h = this.hour;
    const deadlineAt = seenMs + s.deadlineMs;
    const T = times ?? { recv: performance.now() };
    const rel = (x: number | undefined) => (x === undefined ? undefined : r2(x - T.recv));
    const hops: Hops = { parse: rel(T.parsed), queue: rel(T.queued), start: rel(performance.now()), lag: this.lagNow() };
    h.asked++;
    const unknown = (why: string) => { h.unknownWhy[why] = (h.unknownWhy[why] ?? 0) + 1; slot.out ??= why; return null; };
    // 1. DISCOVER: which of our pools does it move? (no node)
    const built = this.d.tf.buildFeed(hash, []);
    if ('why' in built) return unknown(`discover_${built.why}`);
    let a: Record<string, unknown> | null = null;
    // ONE TRIP: discovery + candidate checks in one question.
    let one: Record<string, unknown> | null = null;
    let oneWhy: string | undefined;
    if (this.oneTripOn() && this.tbl.ackGen >= 0 && this.now() >= this.oneTripOffUntil) {
      const left = Math.max(1, deadlineAt - this.now());
      hops.dSent = rel(performance.now());
      let r: Record<string, unknown> | null = null;
      try {
        r = await withDeadline(this.d.tf.requestFeed({
          type: 'trig_entry', at: { after: 'head' }, feed: built.feed, limit: s.maxCandidates, maxPools: s.maxPools,
          minConf: this.d.tf.settings.minConfidence, budgetUs: Math.max(1_000, Math.round((left - 10) * 1_000)), gen: this.tbl.ackGen,
        }, left), left + 20);
      } catch { r = null; }
      markStretch('trig entry');
      hops.dAns = rel(performance.now());
      hops.lagA = this.lagNow();
      if (r && r.ok === true && r.disc && typeof r.disc === 'object') { one = r; a = r.disc as Record<string, unknown>; }
      else if (r && r.unknown === 'bad_request') {
        // An older sidecar without `trig_entry`: two steps for 10 min.
        this.oneTripOffUntil = this.now() + 600_000;
        oneWhy = 'sidecar_too_old';
        this.log('[trig-entry] the sidecar does not know the one-trip question (older arbsim?): two steps for 10 min');
      } else {
        const ms = this.now() - seenMs;
        keep(h.discoverMs, ms);
        return unknown(`one_trip_${String(r?.unknown ?? 'timeout')}`);
      }
      if (one) {
        const sc = one.t as { queue?: number } | undefined;
        hops.scQ = typeof sc?.queue === 'number' ? r2(sc.queue / 1_000) : undefined;
        hops.scW = typeof one.us === 'number' ? r2((one.us as number) / 1_000) : undefined;
        hops.dW = typeof a!.us === 'number' ? r2((a!.us as number) / 1_000) : undefined;
      }
    } else if (this.oneTripOn()) oneWhy = this.tbl.ackGen < 0 ? 'no_table_yet' : 'sidecar_too_old';
    if (!one) {
      hops.dSent = rel(performance.now());
      try {
        a = await withDeadline(this.d.tf.requestFeed({ type: 'trig_discover', at: { after: 'head' }, feed: built.feed }, s.discoverTimeoutMs), s.discoverTimeoutMs + 20);
      } catch { a = null; }
      markStretch('trig entry');
      hops.dAns = rel(performance.now());
      hops.lagA = this.lagNow();
      const t = (a as { t?: { queue?: number } } | null)?.t;
      hops.scQ = typeof t?.queue === 'number' ? r2(t.queue / 1_000) : undefined;
      hops.scW = typeof a?.us === 'number' ? r2((a.us as number) / 1_000) : undefined;
    }
    // The sidecar's own phase split (speed-3): CPU time, building the replay
    // plan (feed read / hashes / senders), EVM runs, waiting for a block
    // being applied (ms). CPU much lower than work = it was waiting.
    if (a) {
      const ph = (a as { ph?: Record<string, unknown> }).ph;
      const ms = (v: unknown) => (typeof v === 'number' ? r2(v / 1_000) : undefined);
      hops.scC = ms((a as { cpu?: unknown }).cpu);
      if (ph) { hops.scP = ms(ph.plan); hops.scE = ms(ph.evm); hops.scD = ms(ph.dirtyWait); }
    }
    const discoverMs = this.now() - seenMs;
    keep(h.discoverMs, discoverMs);
    if (!a) return unknown('discover_timeout');
    if (a.ok !== true) return unknown(`discover_${String(a.unknown ?? 'unknown')}`);
    h.discovered++;
    const pools = Array.isArray(a.pools) ? (a.pools as unknown[]).filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase()) : [];
    if (!pools.length) { slot.out = 'no_pools'; return null; } // doesn't move any pool we follow: nothing to do
    slot.out = `pools:${pools.length}`;
    if (a.inCopy === true) { h.inCopy++; slot.out = `pools:${pools.length}:in_copy`; }
    // GAP FIX 2: remember who this transaction was sent to (hot target).
    { const to = this.toByHash.get(hash); if (to) this.noteHot(to); }
    h.touching++;
    // A check place (NO DROP above): all taken = too busy for this one.
    if (this.checking >= s.maxInFlight) { h.droppedBusy++; return unknown('busy_checking'); }
    this.checking++;
    slot.held = true;
    // Debug: per moved pool, which kinds of its values changed (sidecar, capped small).
    const moved = Array.isArray(a.moved) ? (a.moved as unknown[]).slice(0, 4).map((m) => (Array.isArray(m) ? `${String(m[0]).slice(0, 12)}:${Array.isArray(m[1]) ? (m[1] as unknown[]).slice(0, 4).join('+') : ''}` : '')).filter(Boolean) : undefined;
    const rec: EntryRecord = {
      hash, seenMs, pools: pools.slice(0, 8), poolCount: pools.length, moved, discoverMs, discConf: typeof a.conf === 'string' ? a.conf : undefined,
      discAssumed: Array.isArray(a.assumed) ? (a.assumed as string[]).slice(0, 8) : undefined,
      tried: 0, candidates: 0, found: 0, hops,
    };
    // GUARD: one transaction really moves 1-2 pools (a router: a few). Many
    // more = the answer can't be right (live Oct 23: every V4 pool at once):
    // skipped, counted, never enumerated.
    if (pools.length > s.maxPools) { rec.unknown = 'too_many_pools'; unknown('too_many_pools'); this.finish(rec); return rec; }
    // 2. CANDIDATES: listed, ranked and capped BEFORE anything is built.
    //    One trip: the sidecar already picked them from the table, the
    //    same way (and checked them); the bot looks up its own entries.
    let cands: EntryCandidate[] = [];
    let oneTrip: { metas: TableMeta[]; answers: Map<number, SidecarAnswer | null>; seq: number } | null = null;
    if (one && Array.isArray(one.sel)) {
      const sel = (one.sel as unknown[]).map((x) => String(x));
      const metas = sel.map((id) => this.tbl.meta.get(id));
      if (metas.every((m): m is TableMeta => !!m)) {
        const byId = new Map<string, SidecarAnswer | null>();
        for (const c of Array.isArray(one.cands) ? (one.cands as Array<{ e?: unknown; a?: unknown }>) : []) byId.set(String(c.e), (c.a ?? null) as SidecarAnswer | null);
        const answers = new Map<number, SidecarAnswer | null>();
        sel.forEach((id, i) => { if (byId.has(id)) answers.set(i, byId.get(id)!); });
        oneTrip = { metas, answers, seq: Number((built.feed as { triggerSeq?: number }).triggerSeq) };
        cands = metas.map((m) => m.cand);
        rec.found = Number(one.found ?? cands.length);
        rec.one = 1;
        h.one.used++;
      } else oneWhy = 'table_changed';
    } else if (one) {
      oneWhy = one.table === 'none' ? 'no_table' : 'no_selection';
      if (one.table === 'none') this.tbl.needFull = true;
    }
    if (!oneTrip) {
      try { const r = this.d.candidatesFor(pools, s.maxCandidates); cands = r.cands.slice(0, s.maxCandidates); rec.found = r.found; } catch { h.errors++; }
    }
    if (oneWhy) { rec.one = oneWhy; h.one.why[oneWhy] = (h.one.why[oneWhy] ?? 0) + 1; }
    // 3-POOL LOOPS (TRIG_ENTRY_LOOPS=1): their own cap (TRIG_ENTRY_MAX_LOOPS),
    // from the precomputed loop index (no node). Two steps: merged in among
    // the 2-pool candidates in rank order. One trip: the sidecar's table has
    // 2-pool routes only, so loops go after them (checked the two-step way
    // only if no 2-pool answer was good enough to send).
    if (s.loops && s.maxLoops > 0 && this.d.loopCandidatesFor) {
      try {
        const lr = this.d.loopCandidatesFor(pools, s.maxLoops);
        const lcs = lr.cands.slice(0, s.maxLoops).map((c) => (c.kind === 'loop' ? c : { ...c, kind: 'loop' as const }));
        rec.foundLoops = lr.found;
        rec.loops = lcs.length;
        if (lcs.length) cands = oneTrip ? [...cands, ...lcs] : mergeRanked(cands, lcs);
      } catch { h.loopErrors++; }
    }
    for (const c of cands) h.kind[kindOf(c)].built++;
    hops.built = rel(performance.now());
    rec.candidates = cands.length;
    if (!cands.length) { rec.unknown = 'no_candidates'; unknown('no_candidates'); this.finishHops(rec, T); this.finish(rec); return rec; }
    // 3. SIZE + CHECK, best-ranked first, a few at once (bounded per
    //    trigger and over all triggers), stopping at the first SURE answer
    //    that would be sent (profitable after gas at the confidence floor).
    const left = Math.max(1, deadlineAt - this.now());
    const results = oneTrip
      ? await this.runOneTrip(cands, oneTrip, hash, seenMs, left, rec, one!)
      : await this.runRanked(cands, hash, seenMs, left, rec);
    markStretch('trig entry');
    rec.answerMs = this.now() - seenMs;
    keep(h.answerMs, rec.answerMs);
    // Per-check hops: [sent, answered, sidecar queue, sidecar work] (ms).
    hops.checks = results.map((r) => [rel(r.out.hop?.s) ?? null, rel(r.out.hop?.a) ?? null, r.out.hop?.q ?? null, r.out.hop?.w ?? null]);
    // Every candidate's verdict (log), and the best one even when it loses.
    for (const r of results) h.kind[kindOf(r.cand)].checked++;
    rec.cv = results.map((r) => ({
      k: kindOf(r.cand), l: r.cand.label.slice(0, 40), v: r.out.sure ? r.out.verdict : 'unknown', n: r.view ? r2(r.view.netUsd) : undefined,
      s: r.view ? Math.round(r.view.sizeUsd) : undefined, r: r.out.sure ? (r.out.verdict === 'fail' ? reasonOf(r.out.sim)?.slice(0, 60) : undefined) : r.out.why,
      c: r.out.sure ? r.out.confidence : undefined,
    }));
    const viewBest = results.filter((r) => r.out.sure && r.view).sort((x, y) => y.view!.netUsd - x.view!.netUsd)[0];
    if (viewBest) rec.view = { label: viewBest.cand.label, sizeUsd: viewBest.view!.sizeUsd, netUsd: viewBest.view!.netUsd, verdict: viewBest.view!.verdict, le: viewBest.view!.le, conf: viewBest.out.confidence, as: viewBest.out.assumptions };
    const picks = results.filter((r) => !!r);
    const sure = picks.filter((r) => r.out.sure);
    if (!sure.length) {
      const why = picks.find((r) => r.out.why)?.out.why ?? (picks.length ? 'unknown' : 'deadline');
      rec.unknown = why; unknown(why); hops.dec = rel(performance.now()); this.finishHops(rec, T); this.finish(rec); return rec;
    }
    h.answered++;
    if (rec.view) {
      const n = rec.view.netUsd;
      if (n > 0.25) h.net.over++; else if (n >= 0) h.net.small++; else if (n >= -0.1) h.net.slightLoss++; else h.net.loss++;
    }
    const best = sure.map((r) => r.pick).filter((p): p is EntryPick => !!p).sort((x, y) => y.netUsd - x.netUsd)[0];
    if (best) {
      rec.best = { label: best.cand.label, sizeUsd: best.sizeUsd, netUsd: best.netUsd, conf: best.out.confidence, as: best.out.assumptions, kind: kindOf(best.cand) };
    }
    // 4. DECIDE.
    hops.dec = rel(performance.now());
    if (!best || !(best.netUsd >= s.minNetUsd)) {
      // Not profitable: a SAMPLE gets the later same-block re-check too.
      const sample = viewBest && this.takeSample() ? { q: viewBest.q, out: viewBest.out, cand: viewBest.cand } : undefined;
      if (sample) rec.sampled = true;
      this.finishHops(rec, T);
      this.finish(rec, best, sample);
      return rec;
    }
    h.profitable++;
    h.profitUsd += best.netUsd;
    const bk = h.kind[kindOf(best.cand)];
    bk.profitable++;
    const held = this.gates(best);
    rec.held = held ?? undefined;
    if (held) { h.held++; const k = held.split(':')[0]; h.heldWhy[k] = (h.heldWhy[k] ?? 0) + 1; }
    const deciding = this.d.tf.decides();
    if (!held && !deciding) { h.wouldSend++; bk.wouldSend++; rec.wouldSend = true; }
    if (!held && deciding) {
      if (!this.claim(hash, 'entry')) { rec.held = 'already sent by the old path'; }
      else {
        rec.wouldSend = true;
        bk.wouldSend++;
        try {
          const r = await this.d.send(best, { hash, seenMs });
          if (r.signedMs !== undefined) { rec.submitMs = r.signedMs - seenMs; keep(h.submitMs, rec.submitMs); h.sent++; bk.sent++; hops.sign = rec.submitMs; }
          else rec.held = `not sent: ${r.why ?? 'stopped by a safeguard'}`;
        } catch { h.errors++; rec.held = 'send error'; }
      }
    }
    this.finishHops(rec, T);
    this.finish(rec, best);
    return rec;
  }

  // 1 in TRIG_ENTRY_AGREE_SAMPLE not-profitable answers, at most
  // TRIG_ENTRY_AGREE_SAMPLE_PER_HOUR an hour.
  private takeSample(): boolean {
    const s = this.settings;
    if (s.agreeSample <= 0 || s.agreeSamplePerHour <= 0) return false;
    this.sampleCount++;
    if (this.sampleCount % s.agreeSample !== 0) return false;
    const t = this.now();
    this.sampleTimes = this.sampleTimes.filter((x) => t - x < 3_600_000);
    if (this.sampleTimes.length >= s.agreeSamplePerHour) return false;
    this.sampleTimes.push(t);
    return true;
  }

  // Hourly per-hop numbers (ms) of one trigger.
  private finishHops(rec: EntryRecord, _T: FrameTimes): void {
    try {
      const x = rec.hops;
      if (!x) return;
      const H = this.hour.hops;
      const add = (n: HopName, v: number | undefined | null) => { if (typeof v === 'number' && Number.isFinite(v)) keep(H[n], v); };
      add('parse', x.parse);
      add('start', x.start);
      add('sent', x.dSent);
      const rtt = x.dAns !== undefined && x.dSent !== undefined ? x.dAns - x.dSent : undefined;
      add('rtt', rtt);
      add('scQueue', x.scQ);
      add('scWork', x.scW);
      add('scCpu', x.scC);
      add('scPlan', x.scP);
      add('scEvm', x.scE);
      add('scDirty', x.scD);
      if (rtt !== undefined && x.scW !== undefined) add('other', r2(rtt - (x.scQ ?? 0) - x.scW));
      if (x.built !== undefined && x.dAns !== undefined) add('build', r2(x.built - x.dAns));
      for (const c of x.checks ?? []) if (c[0] !== null && c[1] !== null) add('check', r2(c[1] - c[0]));
      add('decide', x.dec);
      add('lag', x.lag);
    } catch { /* reporting only */ }
  }

  // ONE TRIP: read the sidecar's answers best-ranked first with the bot's
  // own code (TriggerFirst.askOnly, canned), stopping at the first one the
  // bot would send, exactly like runRanked with one check at a time.
  // Candidates the sidecar didn't get to (it stopped where the bot would
  // not, or ran out of time) and entries it could not prepare are checked
  // the old way, so nothing is lost.
  private async runOneTrip(
    cands: EntryCandidate[], ot: { metas: TableMeta[]; answers: Map<number, SidecarAnswer | null>; seq: number },
    hash: string, seenMs: number, leftMs: number, rec: EntryRecord, one: Record<string, unknown>,
  ): Promise<CandResult[]> {
    const until = this.now() + leftMs;
    const out: CandResult[] = [];
    let i = 0;
    for (; i < cands.length; i++) {
      if (!ot.answers.has(i) || this.now() >= until) break;
      const m = ot.metas[i];
      rec.tried++;
      let r: CandResult | null;
      const oldWay = () => withDeadline(this.withSlot(() => this.checkCandidate(cands[i], hash, seenMs), until), Math.max(1, until - this.now()));
      if (m.fallback) r = await oldWay();
      else {
        const a = ot.answers.get(i) ?? null;
        r = a && m.sig ? await this.checkCandidate(cands[i], hash, seenMs, { answer: a, sig: m.sig, seq: ot.seq }) : null;
        // Our trade is not exactly the one the table sent: ask the old way.
        if (r && !r.out.sure && r.out.why === 'one_trip_mismatch') { rec.oneMismatch = (rec.oneMismatch ?? 0) + 1; r = await oldWay(); }
      }
      if (r) out.push(r);
      if (this.good(r)) { rec.early = i + 1 < cands.length || undefined; return out; }
    }
    if (i < cands.length && this.now() < until) {
      rec.oneRest = cands.length - i;
      out.push(...(await this.runRanked(cands.slice(i), hash, seenMs, until - this.now(), rec)));
    }
    if (one.cut === true) rec.oneCut = true;
    return out;
  }

  // Would the bot send on this answer (before the safeguards)?
  private good(r: CandResult | null): boolean {
    return !!r && r.out.sure && !!r.pick && r.pick.netUsd >= this.settings.minNetUsd && confidenceAtLeast(r.out.confidence, this.d.tf.settings.minConfidence);
  }

  // Candidates in rank order, TRIG_ENTRY_PARALLEL at a time, within the
  // deadline. Stops at the first sure answer good enough to send (safe: it
  // passed the full check; a better-ranked candidate was asked first or at
  // the same time). Those still running are not waited for.
  private runRanked(cands: EntryCandidate[], hash: string, seenMs: number, leftMs: number, rec: EntryRecord): Promise<CandResult[]> {
    const s = this.settings;
    const until = this.now() + leftMs;
    const out: CandResult[] = [];
    return new Promise((resolve) => {
      let next = 0, running = 0, done = false;
      const finish = () => { if (!done) { done = true; resolve(out.slice()); } };
      const launch = () => {
        while (!done && running < Math.max(1, s.parallel) && next < cands.length) {
          const c = cands[next++];
          running++;
          rec.tried++;
          void withDeadline(this.withSlot(() => this.checkCandidate(c, hash, seenMs), until), Math.max(1, until - this.now()))
            .then((r) => {
              running--;
              if (r) out.push(r);
              if (this.good(r)) { rec.early = next < cands.length || running > 0 || undefined; finish(); return; }
              if (this.now() >= until || (next >= cands.length && running === 0)) { finish(); return; }
              launch();
            }, () => { running--; launch(); if (next >= cands.length && running === 0) finish(); });
        }
        if (next >= cands.length && running === 0) finish();
      };
      launch();
      const t = setTimeout(finish, Math.max(1, leftMs) + 5);
      t.unref?.();
    });
  }

  // At most TRIG_ENTRY_MAX_CHECKS candidate checks at once over all
  // triggers (the sidecar has few workers; the old paths use them too).
  // A check whose turn comes after its trigger's deadline is not run.
  private slotsUsed = 0;
  private readonly waiting: Array<() => void> = [];
  private async withSlot<T>(f: () => Promise<T | null>, until: number): Promise<T | null> {
    if (this.slotsUsed >= Math.max(1, this.settings.maxChecks)) {
      await new Promise<void>((r) => this.waiting.push(r));
    } else this.slotsUsed++;
    try {
      if (this.now() >= until) return null;
      return await f();
    } finally {
      const w = this.waiting.shift();
      if (w) w(); else this.slotsUsed--;
    }
  }

  // SAFEGUARDS checked here before the host's own (see the file header).
  // null = all pass. The old model guess and the 6 h liveBlocks / bench
  // lists are deliberately NOT checked for entry-point sends.
  gates(p: EntryPick): string | null {
    if (this.d.killed()) return 'kill switch on';
    if (!(p.netUsd >= this.settings.minNetUsd)) return `under the send minimum ($${this.settings.minNetUsd})`;
    if (!confidenceAtLeast(p.out.confidence, this.d.tf.settings.minConfidence)) return `confidence ${p.out.confidence} below ${this.d.tf.settings.minConfidence}`;
    const [fa, fbk] = p.cand.failKey ?? [p.cand.buyPool, p.cand.sellPool];
    const fb = this.d.failBlocked(fa, fbk);
    if (fb) return `${kindOf(p.cand) === 'loop' ? 'loop' : 'pair'} blocked 30 min: ${fb}`;
    const sg = this.d.safety(p.sizeUsd, p.cand.tokens);
    if (sg) return `safety: ${sg}`;
    const pz = this.d.pausedWhy(p.out.confidence, p.out.assumptions);
    if (pz) return `scoreboard: ${pz}`;
    // 3-pool loops: the loop safeguards too (loop loss cap, loop size limit, ...).
    if (kindOf(p.cand) === 'loop') {
      if (!this.d.loopGate) return 'loop: no loop sender';
      let lg: string | null;
      try { lg = this.d.loopGate(p); } catch (e) { lg = `loop check error: ${(e as Error).message}`; }
      if (lg) return `loop: ${lg}`;
    }
    return null;
  }

  // One candidate: the full trigger-first check at the biggest size of the
  // ladder, the smaller sizes on the same replay; its best size. `canned`
  // (one trip): the sidecar's answer is already here; read it, don't ask.
  private async checkCandidate(c: EntryCandidate, hash: string, seenMs: number, canned?: CannedAnswer): Promise<CandResult | null> {
    const plan = ladderPlan(c, this.settings.sizesUsd);
    if (!plan) return null;
    const { main, b, others } = plan;
    const q: TrigQuestion = { trade: b.trade, simOpts: b.simOpts, triggerHash: hash, seenMs, keys: c.keys, label: c.label };
    const out = await this.d.tf.askOnly(q, others, canned);
    markStretch('trig entry');
    if (!out.sure) return { out, cand: c, q };
    // Every size: net after gas; the best one. (A profit bigger than the
    // trade itself is bad data, never used.) `pick` = the best PROFITABLE
    // size (decisions, unchanged); `view` = the best of every size,
    // losses included (logging only: a "loss" answer only says "no
    // profit", so its net is at most minus gas).
    const rows: Array<{ amount: bigint; profit: bigint; sizeUsd: number; status: string }> = [];
    const st = out.sim.status;
    if (st === 'profit' || st === 'loss') rows.push({ amount: b.trade.amountIn, profit: st === 'profit' ? out.sim.profit : 0n, sizeUsd: main, status: st });
    for (const r of out.ladder ?? []) if (r.status === 'profit' || r.status === 'loss') rows.push({ amount: r.amount, profit: r.profit, sizeUsd: (main * Number(r.amount)) / Number(b.trade.amountIn), status: r.status });
    let pick: EntryPick | undefined;
    let view: CandResult['view'];
    for (const r of rows) {
      if (r.status === 'loss' || r.profit <= 0n) {
        const net = -c.gasUsd;
        if (!view || net > view.netUsd) view = { sizeUsd: r.sizeUsd, netUsd: net, verdict: 'loss', le: true };
        continue;
      }
      if (r.profit > r.amount) continue;
      const net = c.usdOf(r.profit) - c.gasUsd;
      if (!Number.isFinite(net)) continue;
      if (!pick || net > pick.netUsd) pick = { cand: c, sizeUsd: r.sizeUsd, amountIn: r.amount, profitUnits: r.profit, netUsd: net, out, q };
      if (!view || net > view.netUsd || view.le) view = { sizeUsd: r.sizeUsd, netUsd: net, verdict: 'profit' };
    }
    return { out, pick, view, cand: c, q };
  }

  // ---- ONE TRIP TABLE ------------------------------------------------------------
  // Plain English: about once a second, every watched pool's routes are
  // built (the host's own route rules, ranking facts and buildCheck), our
  // exact check question is written down for each (TriggerFirst.capture),
  // and the pools whose routes changed are sent to the sidecar
  // (`trig_table`). Long contract codes are sent once as "$code:<n>".
  // Work is done in ~2 ms bites (never freezes the bot). Old entries stay
  // known for 30 s, so answers already on their way can still be read.
  private readonly tbl = {
    gen: 0, ackGen: -1, needFull: true, building: false,
    pools: new Map<string, { fp: string; rows: unknown[]; ids: string[] }>(),
    meta: new Map<string, TableMeta>(),
    retired: new Map<string, number>(),
    codes: [] as string[],
    seq: 0, lastMs: 0, lastRoutes: 0, lastReused: 0, sends: 0, sendFails: 0,
  };

  tableInfo(): { ackGen: number; pools: number; entries: number; lastMs: number; routes: number; reused: number } {
    return { ackGen: this.tbl.ackGen, pools: this.tbl.pools.size, entries: this.tbl.meta.size, lastMs: this.tbl.lastMs, routes: this.tbl.lastRoutes, reused: this.tbl.lastReused };
  }

  // Rebuild the table and send what changed. true = the sidecar holds it.
  //
  // FREEZE FIX (Oct 23), same table, cheaper and in named bites:
  //   - every stretch of work is timed as "trig table" (it used to show up
  //     as unnamed "other" in the freeze report), at most ~2 ms each;
  //   - a pool's routes are listed when the builder reaches it (the host
  //     may pass them as a function), not all pools at once up front;
  //   - a route whose inputs did not change (same pool states, same coin
  //     price, same size cap, gas, route pools; see TableRoute.inputs)
  //     keeps the question written last time, for up to
  //     TRIG_ENTRY_TABLE_REUSE_MS (default 5 s), instead of building it
  //     again. Safe for decisions: when a trigger uses a table entry the bot
  //     still rebuilds its own trade and only accepts the sidecar's answer
  //     if it is EXACTLY the same question (checkSig); anything else is
  //     checked the old way;
  //   - the "did this pool change?" fingerprint reuses each route's text
  //     instead of turning the whole question into text again every second.
  async refreshTable(): Promise<boolean> {
    const T = this.tbl;
    if (T.building || !this.oneTripOn() || !this.active()) return false;
    T.building = true;
    const t0 = performance.now();
    // Named stretches: `pause()` ends the current one, lets the bot run,
    // and starts a new one.
    let endStretch = stallFinder.begin('trig table');
    let slice = performance.now();
    const pause = async () => { endStretch(); await yieldNow(); endStretch = stallFinder.begin('trig table'); slice = performance.now(); };
    const waitFor = async <X>(p: Promise<X>): Promise<X> => { endStretch(); try { return await p; } finally { endStretch = stallFinder.begin('trig table'); } };
    try {
      const src = this.d.tableRoutes!();
      const now = this.now();
      const reuseMs = this.settings.tableReuseMs;
      const sizesKey = this.settings.sizesUsd.join(',');
      const fresh = new Map<string, { fp: string; rows: Array<Record<string, unknown>>; metas: Array<TableMeta | null> }>();
      let routes = 0, reused = 0;
      for (const tp of src) {
        const key = (tp.pool ?? '').toLowerCase();
        if (!key || fresh.has(key)) continue;
        if (performance.now() - slice > 2) await pause();
        let rs: TableRoute[];
        try { rs = typeof tp.routes === 'function' ? tp.routes() : tp.routes; } catch { rs = []; }
        const rows: Array<Record<string, unknown>> = [];
        const metas: Array<TableMeta | null> = [];
        const fps: string[] = [];
        for (const r of rs) {
          routes++;
          if (performance.now() - slice > 2) await pause();
          let cand: EntryCandidate | null = null;
          try { cand = r.build(); } catch { cand = null; }
          const score = r.score !== null && Number.isFinite(r.score) ? r.score : null;
          if (!cand) { rows.push({ rid: r.rid.toLowerCase(), h: r.held, s: score, e: null }); metas.push(null); fps.push(JSON.stringify([r.rid, r.held, score, null])); continue; }
          const meta: TableMeta = { cand };
          // Reuse last time's written-down question when nothing it is made of changed.
          const rid = r.rid.toLowerCase();
          const sameAs = this.memoKey(cand, sizesKey);
          const memo = reuseMs > 0 && r.inputs ? this.tblMemo.get(rid) : undefined;
          let c: Record<string, unknown> | null = null;
          let cJson: string;
          if (memo && now - memo.at <= reuseMs && memo.codesEpoch === this.codesEpoch && memo.sameAs === sameAs && sameItems(memo.inputs, r.inputs!)) {
            c = memo.c; cJson = memo.cJson;
            if (memo.sig !== undefined) meta.sig = memo.sig;
            if (memo.fallback) meta.fallback = true;
            reused++;
          } else {
            const plan = ladderPlan(cand, this.settings.sizesUsd);
            if (plan) {
              const cap = await this.captureForTimed(cand, plan, waitFor);
              const stop = stopUnits(cand, this.settings.minNetUsd);
              if (cap && stop !== null) {
                c = {
                  calls: cap.calls, overrides: this.codeRefs(cap.overrides), ...(cap.sizes ? { sizes: cap.sizes } : {}),
                  route: cand.keys.filter((k): k is string => typeof k === 'string' && VALID_KEY.test(k)).map((k) => k.toLowerCase()),
                  stop: hex(stop), amt: hex(plan.b.trade.amountIn),
                };
                meta.sig = checkSig(cap.data, cap.overrides, cap.sizes);
              } else meta.fallback = true;
            }
            cJson = c === null ? 'null' : JSON.stringify(c);
            if (reuseMs > 0 && r.inputs) {
              if (this.tblMemo.size > 20_000) this.tblMemo.clear(); // memory bound
              // (Numbers only change in compactCodes, after the build: codesEpoch then moves on.)
              this.tblMemo.set(rid, { at: now, inputs: r.inputs.slice(), sameAs, codesEpoch: this.codesEpoch, c, cJson, sig: meta.sig, fallback: meta.fallback });
            } else this.tblMemo.delete(rid);
          }
          // Fast lane only: the facts the Rust scanner values results with.
          const fl = this.settings.fastlaneFacts && c ? fastlaneFacts(cand) : null;
          rows.push(fl ? { rid, h: r.held, s: score, e: '', c, f: fl } : { rid, h: r.held, s: score, e: '', c });
          metas.push(meta);
          // Fingerprint: the route's small facts + its question's text (exactly
          // the same text as before for the same question, so "changed?" is the
          // same answer as when the whole list was turned into text).
          fps.push(JSON.stringify([r.rid, r.held, score, cand.label, cand.gasUsd, cand.maxSizeUsd, !!meta.fallback]) + cJson + (fl ? JSON.stringify(fl) : ''));
        }
        fresh.set(key, { fp: fps.join('\n'), rows, metas });
      }
      // Memo entries of routes that are gone: forgotten once old.
      if (this.tblMemo.size) for (const [k, m] of this.tblMemo) if (now - m.at > Math.max(reuseMs, 1_000) * 3) this.tblMemo.delete(k);
      // What changed since the last table (new ids only for changed pools).
      const changed: Record<string, unknown[] | null> = {};
      for (const [key, f] of fresh) {
        const old = T.pools.get(key);
        if (old && old.fp === f.fp) continue;
        if (old) for (const id of old.ids) T.retired.set(id, now);
        const ids: string[] = [];
        f.rows.forEach((row, i) => {
          if (row.e === null) return;
          const id = `${T.gen + 1}.${++T.seq}`;
          row.e = id;
          ids.push(id);
          T.meta.set(id, f.metas[i]!);
        });
        T.pools.set(key, { fp: f.fp, rows: f.rows, ids });
        changed[key] = f.rows;
      }
      for (const [key, old] of [...T.pools]) {
        if (fresh.has(key)) continue;
        for (const id of old.ids) T.retired.set(id, now);
        T.pools.delete(key);
        changed[key] = null;
      }
      // Forget entries retired more than 30 s ago.
      for (const [id, at] of [...T.retired]) if (now - at > 30_000) { T.retired.delete(id); T.meta.delete(id); }
      T.lastRoutes = routes;
      T.lastReused = reused;
      // Long-code list tidy-up, once the whole table is built (see compactCodes).
      if (T.codes.length > CODES_SOFT_MAX) this.compactCodes();
      if (!Object.keys(changed).length && !T.needFull) return T.ackGen >= 0;
      const full = T.needFull || T.ackGen < 0;
      const gen = T.gen + 1;
      const pools = full ? Object.fromEntries([...T.pools].map(([k, v]) => [k, v.rows])) : changed;
      T.gen = gen;
      T.sends++;
      const a = await waitFor(this.d.client.request({ type: 'trig_table', gen, full, base: T.ackGen, codes: T.codes, pools }, 3_000));
      if (a.ok === true) { T.ackGen = gen; T.needFull = false; return true; }
      T.sendFails++;
      T.needFull = true;
      return false;
    } catch {
      this.hour.errors++;
      T.needFull = true;
      return false;
    } finally {
      endStretch();
      T.lastMs = r2(performance.now() - t0);
      T.building = false;
    }
  }

  // Reuse memory of the one-trip table (see refreshTable): route id ->
  // what its question was made of, and the question as written.
  private readonly tblMemo = new Map<string, { at: number; inputs: unknown[]; sameAs: string; codesEpoch: number; c: Record<string, unknown> | null; cJson: string; sig?: string; fallback?: boolean }>();
  // Bumped whenever the long-code list is renumbered (compactCodes): questions
  // written before that point at old list positions and are never reused.
  private codesEpoch = 0;
  // The candidate's own facts that its question depends on (besides `inputs`).
  private memoKey(c: EntryCandidate, sizesKey: string): string {
    return JSON.stringify([c.label, c.buyPool, c.sellPool, c.tokenIn, c.maxSizeUsd, c.gasUsd, c.keys, sizesKey, this.settings.minNetUsd]);
  }
  private captureForTimed(cand: EntryCandidate, plan: NonNullable<ReturnType<typeof ladderPlan>>, waitFor: <X>(p: Promise<X>) => Promise<X>): Promise<CapturedCheck | null> {
    return waitFor(this.captureFor(cand, plan));
  }

  // Our exact check question for one candidate at its ladder. Writing it
  // down costs ~1 ms (the same encoding a real check does), so it is done
  // once per route SHAPE (coin, hops, lender, number of sizes) and later
  // only the amounts are put in (the amountIn word of the call and the test
  // contract's pretend balance, exactly what the sidecar's size ladder
  // changes too). If that ever differs from a fresh build, the answer is
  // simply not recognised and that candidate is checked the old way.
  private readonly capCache = new Map<string, { cap: CapturedCheck; amount: bigint }>();
  private async captureFor(cand: EntryCandidate, plan: NonNullable<ReturnType<typeof ladderPlan>>): Promise<CapturedCheck | null> {
    const t = plan.b.trade;
    const key = JSON.stringify({ token: t.token, hops: t.hops, o: plan.b.simOpts, n: plan.others.length }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    const hit = this.capCache.get(key);
    if (hit) return patchAmounts(hit.cap, hit.amount, t.amountIn, plan.others);
    const q: TrigQuestion = { trade: t, simOpts: plan.b.simOpts, triggerHash: '', seenMs: 0, keys: cand.keys, label: cand.label };
    const cap = await this.d.tf.capture(q, plan.others);
    if (!cap) return null;
    if (this.capCache.size > 2_000) this.capCache.clear(); // memory bound
    this.capCache.set(key, { cap, amount: t.amountIn });
    return cap;
  }

  // Long contract codes in the pretend state -> "$code:<n>" (sent once per
  // table message in `codes`; the sidecar looks each row's codes up in the
  // NEWEST list it was sent).
  //
  // BUG FIX (Oct 23): when a 9th different code turned up, the list used to
  // be emptied right there, in the middle of a rebuild. Rows written earlier
  // (in this rebuild, or kept from earlier ones) still said "$code:3" of the
  // OLD list, so the sidecar would have run their checks with the wrong
  // contract code (or none). Now a code's number never changes while any
  // row may use it: new codes are only added during a rebuild, and the list
  // is tidied (compactCodes) only after the whole table is built, with every
  // held row renumbered at the same moment and a full table sent.
  private codeRefs(ov: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [acct, v] of Object.entries(ov ?? {})) {
      const o = v as Record<string, unknown>;
      if (o && typeof o.code === 'string' && o.code.length > 200) {
        let i = this.tbl.codes.indexOf(o.code);
        if (i < 0) i = this.tbl.codes.push(o.code) - 1;
        out[acct] = { ...o, code: `$code:${i}` };
      } else out[acct] = v;
    }
    return out;
  }

  // The list grew past CODES_SOFT_MAX: keep only the codes the current
  // table's rows still use (in first-use order), renumber those rows (new
  // row objects; questions remembered for reuse are not edited, they are
  // simply not reused any more: codesEpoch), and send the whole table with
  // the new list in one message. If every code is still in use, nothing
  // changes (the list may then be longer than CODES_SOFT_MAX: correct first).
  private compactCodes(): void {
    const T = this.tbl;
    const ref = (v: unknown): number | null => {
      const m = typeof v === 'string' ? /^\$code:(\d+)$/.exec(v) : null;
      return m ? Number(m[1]) : null;
    };
    const used = new Map<number, number>();   // old number -> new number
    const keep: string[] = [];
    for (const { rows } of T.pools.values()) {
      for (const row of rows as Array<Record<string, any>>) {
        for (const acct of Object.values((row?.c?.overrides ?? {}) as Record<string, any>)) {
          const i = ref(acct?.code);
          if (i !== null && !used.has(i) && i < T.codes.length) { used.set(i, keep.length); keep.push(T.codes[i]); }
        }
      }
    }
    if (keep.length === T.codes.length) return; // all still used: numbers stay
    for (const [key, v] of T.pools) {
      const rows = (v.rows as Array<Record<string, any>>).map((row) => {
        const ov = row?.c?.overrides as Record<string, any> | undefined;
        if (!ov) return row;
        let touched = false;
        const nov: Record<string, unknown> = {};
        for (const [acct, o] of Object.entries(ov)) {
          const i = ref(o?.code);
          if (i !== null) { touched = true; nov[acct] = { ...o, code: used.has(i) ? `$code:${used.get(i)}` : o.code }; } else nov[acct] = o;
        }
        return touched ? { ...row, c: { ...row.c, overrides: nov } } : row;
      });
      T.pools.set(key, { ...v, rows });
    }
    T.codes = keep;
    this.codesEpoch++;
    T.needFull = true;
  }

  // ---- log line -----------------------------------------------------------------
  // Written once the later same-block re-check is in (or after finalize ms).
  // `sample`: a not-profitable answer picked for the re-check (see takeSample).
  private finish(rec: EntryRecord, best?: EntryPick, sample?: { q: TrigQuestion; out: TrigOutcome; cand: EntryCandidate }): void {
    const write = (ag?: Awaited<ReturnType<TriggerFirst['agreeLater']>>, cand?: EntryCandidate) => {
      try {
        // The re-check's net after gas (loss: at most minus gas).
        let agNet: number | undefined;
        if (ag && cand) {
          if (ag.agV === 'profit' && ag.agP !== undefined) agNet = r2(cand.usdOf(ag.agP) - cand.gasUsd);
          else if (ag.agV === 'loss') agNet = r2(-cand.gasUsd);
        }
        if (sample) {
          const S = this.hour.smp;
          S.asked++;
          if (ag?.agree === true) S.agree++; else if (ag?.agree === false) S.disagree++; else S.notCompared++;
          if (agNet !== undefined && agNet >= this.settings.minNetUsd) S.missed++;
        }
        const v = rec.view;
        this.d.shadowLog.add({
          t: this.now(), k: 'trig_entry', mode: this.d.tf.mode(), tx: rec.hash.slice(0, 12),
          // what it moved, how sure the "which pools" answer was
          pools: rec.pools, np: rec.poolCount, dconf: rec.discConf, das: rec.discAssumed?.length ? rec.discAssumed : undefined,
          // debug: per moved pool (first 12 hex chars), which kinds of its values changed
          mv: rec.moved?.length ? rec.moved : undefined,
          // candidates: routes found, built (best-ranked, capped), checked; stopped early?
          found: rec.found, cands: rec.candidates, tried: rec.tried, early: rec.early,
          // 3-pool loops: found through the moved pools (before the cap), built; kind of the best
          fl: rec.foundLoops, nl: rec.loops || undefined, bk: rec.best?.kind,
          // the best route, size, net after gas: the best PROFITABLE one if
          // any, else the best answer even when it loses (bv = its verdict;
          // nle = a loss answer only says "no profit": net is AT MOST this)
          best: v?.label ?? rec.best?.label, size: v ? Math.round(v.sizeUsd) : rec.best ? Math.round(rec.best.sizeUsd) : undefined,
          net: v ? r2(v.netUsd) : rec.best ? r2(rec.best.netUsd) : undefined, bv: v?.verdict, nle: v?.le || undefined,
          conf: v?.conf ?? rec.best?.conf, as: (v?.as ?? rec.best?.as)?.length ? (v?.as ?? rec.best?.as) : undefined, u: rec.unknown,
          // every checked candidate: label, verdict, net, size, reason (fail / unknown), confidence
          cv: rec.cv?.length ? rec.cv : undefined,
          // decision: would send (shadow) / sent (on), or what held it back
          would: rec.wouldSend || undefined, held: rec.held,
          // one trip used (1) or why not; candidates the sidecar left to the old way; ran out of its time
          one: rec.one, oneRest: rec.oneRest, oneCut: rec.oneCut, oneMis: rec.oneMismatch,
          // timing (ms after the feed showed it)
          discMs: rec.discoverMs, ansMs: rec.answerMs, subMs: rec.submitMs,
          // per hop (ms after the feed frame arrived, 2 decimals; see Hops)
          hops: rec.hops,
          // later same-block re-check of the best candidate (as trig_first lines);
          // smp = a not-profitable answer sampled for it; agNet = the re-check's net
          smp: rec.sampled || undefined, agree: ag?.agree, agV: ag?.agV, agNet, same: ag?.same, agSkip: ag?.agSkip, rblk: ag?.rblk, rAfterMs: ag?.rAfterMs,
          seen: rec.seenMs,
        });
      } catch { this.hour.errors++; }
    };
    const target = best?.out.sure ? { q: best.q, out: best.out, cand: best.cand } : sample?.out.sure ? sample : undefined;
    if (!target) { write(); return; }
    // The re-check waits for the trigger's block reports (bounded by the
    // trigger-first settings); never holds up anything else.
    void withDeadline(this.d.tf.agreeLater(target.q, target.out), this.d.tf.settings.finalizeMs).then((ag) => stallFinder.run('trig entry log', () => write(ag ?? { agSkip: 'not in time' }, target.cand)));
  }

  // ---- hourly line --------------------------------------------------------------
  // "[trig-entry] hour: shadow: 36000 feed txs, 12000 looked at (dropped 0),
  //  moving our pools 300 (3%), answered 250 (83%), profitable 4 ($3.10),
  //  would send 3, sent 0; feed->discover p50 4 ms p90 9 ms; feed->answer
  //  ...; best net: >$0.25 4, $0-0.25 10, -$0.10-0 200, <-$0.10 36;
  //  not-profitable sample re-checked 50: agree 48/49, missed chances 1;
  //  one trip 240 (two steps: no_table_yet 3); hops p50/p90 ms: ...;
  //  event-loop lag p50 0.4 p90 2.1 max 14 ms | unknown because: ..."
  takeHourLine(): string | null {
    try {
      const h = this.hour;
      this.hour = this.freshHour();
      const lag = this.d.lag ? null : loopLag.takeHour();
      if (!this.active()) return null;
      const ms = (xs: number[]) => (xs.length ? `p50 ${pctl(xs, 0.5)} ms, p90 ${pctl(xs, 0.9)} ms` : 'n/a');
      const top = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ${n}`).join(', ');
      const parts = [
        `${h.feedTxs} feed txs, ${h.asked} looked at (skipped ${h.skipped}, dropped ${h.dropped} overloaded, ${h.droppedBusy} moving our pools but all ${this.settings.maxInFlight} check places busy)`,
        `moving our pools ${h.touching} (${pct(h.touching, h.discovered)} of ${h.discovered} answered; ${h.inCopy} already in our copy, checked on it; ${h.hotKept} hot kept instead of dropped, ${this.hot.size} hot targets)`,
        `answered ${h.answered} (${pct(h.answered, h.touching)})`,
        `profitable ${h.profitable} ($${h.profitUsd.toFixed(2)} after gas)`,
        `would send ${h.wouldSend}, sent ${h.sent}${h.held ? `, held back ${h.held} (${top(h.heldWhy)})` : ''}`,
        `feed->discover ${ms(h.discoverMs)}`, `feed->answer ${ms(h.answerMs)}`,
      ];
      if (h.submitMs.length) parts.push(`feed->submit ${ms(h.submitMs)}`);
      const n = h.net;
      if (n.over + n.small + n.slightLoss + n.loss) parts.push(`best net after gas: over $0.25 ${n.over}, $0-0.25 ${n.small}, -$0.10-0 ${n.slightLoss}, under -$0.10 ${n.loss}`);
      const S = h.smp;
      if (S.asked) parts.push(`not-profitable sample re-checked ${S.asked}: agree ${S.agree}/${S.agree + S.disagree}${S.notCompared ? `, not compared ${S.notCompared}` : ''}, missed chances (re-check profitable) ${S.missed}`);
      const K = h.kind;
      if (this.settings.loops || K.loop.built) parts.push(`by kind (built/checked/profitable/would send/sent): pair ${K.pair.built}/${K.pair.checked}/${K.pair.profitable}/${K.pair.wouldSend}/${K.pair.sent}, loop ${K.loop.built}/${K.loop.checked}/${K.loop.profitable}/${K.loop.wouldSend}/${K.loop.sent}${h.loopErrors ? ` (loop errors ${h.loopErrors})` : ''}`);
      if (this.d.loopHourText) { try { const t = this.d.loopHourText(); if (t) parts.push(t); } catch { /* reporting only */ } }
      if (this.oneTripOn()) parts.push(`one trip ${h.one.used}${Object.keys(h.one.why).length ? ` (two steps: ${top(h.one.why)})` : ''}; table ${this.tbl.pools.size} pools / ${this.tbl.lastRoutes} routes (${this.tbl.lastReused} reused unchanged), rebuilt in ${this.tbl.lastMs} ms`);
      const hp = HOP_NAMES.filter((k) => h.hops[k].length).map((k) => `${k} ${pctl(h.hops[k], 0.5)}/${pctl(h.hops[k], 0.9)}`);
      if (hp.length) parts.push(`hops p50/p90 ms: ${hp.join(', ')}`);
      const fs = this.d.tf.storeStats;
      if (fs && (fs.refQs || fs.inlineQs)) {
        parts.push(`feed store: questions naming messages ${fs.refQs}, with messages ${fs.inlineQs}, messages handed over ${fs.puts}${fs.putFails ? ` (${fs.putFails} not)` : ''}${fs.missing ? `, sidecar lacked one ${fs.missing}x (asked again ${fs.resent})` : ''}`);
        fs.refQs = 0; fs.inlineQs = 0; fs.puts = 0; fs.putFails = 0; fs.missing = 0; fs.resent = 0;
      }
      if (lag) parts.push(`event-loop lag p50 ${lag.p50} ms, p90 ${lag.p90} ms, max ${lag.max} ms`);
      const line = `Trigger-first entry (${this.d.tf.decides() ? 'on' : this.d.tf.mode()}): ${parts.join('; ')}`;
      const whys = top(h.unknownWhy);
      this.log(`[trig-entry] hour: ${line}${whys ? ` | unknown because: ${whys}` : ''}${h.errors ? ` | errors ${h.errors}` : ''}`);
      return line;
    } catch { return null; }
  }
}

type CandResult = {
  out: TrigOutcome;
  pick?: EntryPick;
  // The best size of every size, losses included (logging only).
  view?: { sizeUsd: number; netUsd: number; verdict: 'profit' | 'loss'; le?: boolean };
  cand: EntryCandidate;
  q: TrigQuestion;
};

// PER-HOP TIMESTAMPS of one trigger: ms after the feed frame arrived
// (performance.now(), 2 decimals), and the sidecar's own split.
export type Hops = {
  parse?: number;     // frame parsed (feed messages unpacked)
  queue?: number;     // this transaction queued as a possible trigger
  start?: number;     // its work started
  dSent?: number;     // discover (or one-trip) question sent
  dAns?: number;      // its answer read
  scQ?: number;       // ...of which the sidecar waited for a worker (ms)
  scW?: number;       // ...and worked (ms; one trip: discovery + every check)
  dW?: number;        // one trip: discovery's share of that work (ms)
  scC?: number;       // ...the sidecar thread's CPU time for it (ms; much lower than scW = waiting)
  scP?: number;       // ...of which building the replay plan (feed read, hashes, senders) (ms)
  scE?: number;       // ...of which EVM runs (ms)
  scD?: number;       // ...of which waiting for a block that had arrived but wasn't applied (ms)
  built?: number;     // candidates ready
  checks?: Array<[number | null, number | null, number | null, number | null]>; // per check: sent, answered, sidecar queue, sidecar work (one trip: only work)
  dec?: number;       // decision made
  sign?: number;      // our trade signed (on mode)
  lag?: number;       // event-loop lag when the frame arrived (worst of the last ~200 ms)
  lagA?: number;      // ...and when the first answer was read
};

// One trigger's facts (for its log line; process() returns it for tests).
export type EntryRecord = {
  hash: string;
  seenMs: number;
  pools: string[];                // moved pools (first 8)
  poolCount: number;              // how many moved
  moved?: string[];               // debug: "<pool>:<kinds>" (first 4)
  found: number;                  // routes found before the cap
  foundLoops?: number;            // 3-pool loops through the moved pools, before the cap
  loops?: number;                 // loop candidates built (capped at TRIG_ENTRY_MAX_LOOPS)
  early?: boolean;                // stopped at the first good answer
  discoverMs: number;
  discConf?: string;
  discAssumed?: string[];
  candidates: number;             // built (best-ranked, capped)
  tried: number;                  // actually checked
  answerMs?: number;
  submitMs?: number;
  unknown?: string;
  best?: { label: string; sizeUsd: number; netUsd: number; conf?: TrigConfidence; as?: string[]; kind?: 'pair' | 'loop' };
  // The best answer even when it loses (log): net after gas (le = at most).
  view?: { label: string; sizeUsd: number; netUsd: number; verdict: 'profit' | 'loss'; le?: boolean; conf?: TrigConfidence; as?: string[] };
  cv?: Array<{ k: 'pair' | 'loop'; l: string; v: string; n?: number; s?: number; r?: string; c?: TrigConfidence }>;
  sampled?: boolean;              // a not-profitable answer picked for the re-check
  one?: 1 | string;               // one trip used (1), or why not
  oneRest?: number;               // candidates checked the old way after the one trip
  oneCut?: boolean;               // the sidecar ran out of its time budget
  oneMismatch?: number;           // one-trip answers not used (our call differed from the table's): checked the old way
  hops?: Hops;
  wouldSend?: boolean;
  held?: string;
};
