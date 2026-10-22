import type { PoolState } from '../core/types';
import type { RpcLog } from '../core/blockReader';
import { isHookedV4, v4KeyMatchesId, v4KeyOf } from './executorCalldata';
import { ROBINHOOD_VENUES } from '../config/robinhoodVenues';
import type { LocalSimClient, SidecarAnswer } from './localSim';
import type { RawLogTap } from '../core/blockReaderWs';
import { BlockAssembler, BlockOut, Head, blockMessage, headFromNewHeads } from './copy2Blocks';

// ============================================================================
// COPY 2, BOT SIDE (sim/COPY2_PLAN.md, workstream C)
//
// Plain English:
//   The fast check (the "arbsim" program next to the bot) can keep a copy of
//   OUR pools that is updated from the pools' own reports ("events" / "logs")
//   instead of replaying every transaction on the chain. For that it needs
//   two things from the bot, and this file provides both:
//
//     1. WHICH pools to follow ("track"): each watched Robinhood pool whose
//        type the copy can follow exactly, with its type and coins:
//          V2         Uniswap V2 style pairs (Uniswap V2, PancakeSwap V2)
//          Solidly    Solidly / Velodrome style pairs (Ramses V2, GIGA Classic)
//          V3         Uniswap V3 and exact copies (SushiSwap V3, Abyss, Goo)
//          PancakeV3  PancakeSwap V3 and its copies (GIGA CL, SwapHood)
//          Algebra    Algebra Integral (Alandale, KittenSwap)
//          V4         Uniswap V4 pools WITHOUT a hook
//        Not followed (the node keeps checking them, as today): V4 pools
//        with a hook (Fables etc.), Ramses V3, Slipstream copies, order
//        books, bins, oracle pools, anything unknown.
//
//     2. EVERY report of those pools, block by block, in order
//        ("pool_logs"): the pools' own events (swap, mint, burn, sync, LP
//        moves, ...), Uniswap V4 events for our V4 pool ids, and coin
//        transfers into / out of our pools (the copy keeps the pools' coin
//        balances too). They come from the block reader's WebSocket (the node
//        pushes them); this file only sorts them per block and passes them
//        on. Each block also carries its header (time, parent-chain block,
//        logsBloom) from the WebSocket's newHeads subscription, and blocks
//        go out by EXACTLY the dry-run checker's rules (copy2Blocks.ts), so
//        the live copy behaves like the one being validated. It never stops
//        the bot: if the fast check's socket is busy the message is dropped,
//        counted, and the next message makes the copy reload instead of
//        guessing.
//
//   And it reads back, per pool, whether the copy is READY (exact and
//   current), LOADING or UNSURE. The bot only lets the fast check decide a
//   trade when EVERY pool on the route is ready; otherwise the node decides,
//   exactly as before.
//
// Messages sent (4-byte length + JSON, same socket as everything else):
//   {type:"track", pools:[{address, v4Id?, kind, token0, token1, fee, tickSpacing}]}
//       (answer {ok:true}); sent when the list changes, on (re)connect and
//       every 10 minutes.
//   {type:"pool_logs", block, timestamp, l1Block?, logsBloom, prevBlock, gap?, logs:[...]}
//       one per block that has events on tracked pools, in block order.
//       timestamp / l1Block / logsBloom come from the block's header
//       (newHeads; read from the HTTP node when it never came). With the
//       bloom arbsim marks a pool "pending" (answers "unknown") when the
//       bloom says the pool appears in the block but its report has not
//       arrived yet (dry run #17). A block whose header can't be had is
//       never sent with a guessed time or without a bloom: it is skipped
//       and the copy reloads.
//       prevBlock = block - 1 (every block goes out, so a missing one is
//       noticed by the copy, which then reloads every pool); after anything
//       was missed on our side (dropped message, outage not filled in,
//       block skipped, fresh start) prevBlock = this block (+ gap:true), so
//       the copy reloads.
//       Reports the node took back ("removed") go in the same way (arbsim
//       makes those pools unsure).
//   {type:"block_tick", block, timestamp, l1Block?, logsBloom, prevBlock}
//       "block N had nothing for you", for EVERY block without reports on
//       our pools (with its bloom: a pool whose reports all come late is
//       still noticed).
//   {type:"pool_logs", block, timestamp, l1Block?, late:true, logs}
//       reports that arrived AFTER their block was passed on, with that
//       block's own time (no bloom). arbsim applies them to a pool with
//       nothing after them, else that pool alone reloads.
//
// Read only. No keys, no transactions. Never throws into the bot.
// ============================================================================

export type Copy2Kind = 'V2' | 'Solidly' | 'V3' | 'PancakeV3' | 'Algebra' | 'V4';

// One pool for the "track" message (field names as in the plan / Rust side).
export interface Copy2Pool {
  address: string;       // pool contract; for V4 the PoolManager
  v4Id?: string;         // V4 only: the 32-byte pool id
  kind: Copy2Kind;
  token0: string;        // the pool's token0 (V4: currency0, 0x000..0 = native ETH)
  token1: string;
  fee: number;           // V4 only (pips); 0 for other kinds
  tickSpacing: number;   // V4 only; 0 for other kinds
}

export const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
// ERC-20 Transfer(address indexed from, address indexed to, uint256 value).
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ADDR_RE = /^0x[0-9a-f]{40}$/;
const ID_RE = /^0x[0-9a-f]{64}$/;

// The exchanges the bot itself knows by name, and how the copy follows them.
// Anything not listed here (and not an extra venue below) is NOT followed.
const CORE_DEX_KIND: Record<string, Copy2Kind> = {
  'uniswap-v2': 'V2',
  'pancakeswap-v2': 'V2',
  'ramses-v2': 'Solidly',
  'uniswap-v3': 'V3',
  'pancakeswap-v3': 'PancakeV3',
};
// Extra venues (config/robinhoodVenues.ts) by their pricing model.
const VENUE_MODEL_KIND: Record<string, Copy2Kind> = {
  'uniswap-v3': 'V3',
  'pancake-v3': 'PancakeV3',
  'algebra': 'Algebra',
  'solidly': 'Solidly',
};

// The key the copy and the bot use for one pool: the V4 pool id for V4,
// otherwise the pool address (lower case).
export function copy2Key(p: { address: string; v4Id?: string }): string {
  return (p.v4Id ?? p.address).toLowerCase();
}

// ----------------------------------------------------------------------------
// copy2PoolOf: which copy type a watched pool is, or why it is not followed.
// Conservative on purpose: unknown exchange names are never followed.
// ----------------------------------------------------------------------------
export function copy2PoolOf(pool: PoolState, poolManager: string, skipDexes: ReadonlySet<string> = new Set()): Copy2Pool | { skip: string } {
  try {
    if (pool.chain !== 'robinhood') return { skip: 'not robinhood' };
    const dex = String(pool.dex ?? '').toLowerCase();
    if (skipDexes.has(dex)) return { skip: 'exchange switched off (COPY2_SKIP_DEXES)' };
    const a = String(pool.tokenA ?? '').toLowerCase();
    const b = String(pool.tokenB ?? '').toLowerCase();
    const addr = String(pool.poolAddress ?? '').toLowerCase();
    // Uniswap V4: only pools without a hook, whose key really gives this pool id.
    if (pool.v4) {
      if (dex !== 'uniswap-v4') return { skip: 'V4 pool under another exchange name' };
      if (isHookedV4(pool)) return { skip: 'V4 pool with a hook' };
      if (!ID_RE.test(addr)) return { skip: 'bad V4 pool id' };
      if (!v4KeyMatchesId(pool)) return { skip: 'V4 key does not match the pool id' };
      const pm = String(pool.v4.poolManager ?? '').toLowerCase();
      if (!ADDR_RE.test(pm) || (poolManager && pm !== poolManager.toLowerCase())) return { skip: 'V4 pool on another PoolManager' };
      const k = v4KeyOf(pool);
      const fee = Number(k.fee), ts = Number(k.tickSpacing);
      if (!Number.isInteger(fee) || fee < 0 || fee >= 1_000_000) return { skip: 'V4 fee not a fixed fee' };
      if (!Number.isInteger(ts) || ts <= 0) return { skip: 'bad V4 tick spacing' };
      const t0 = k.currency0.toLowerCase(), t1 = k.currency1.toLowerCase();
      if (!ADDR_RE.test(t0) || !ADDR_RE.test(t1)) return { skip: 'bad V4 coins' };
      return { address: pm, v4Id: addr, kind: 'V4', token0: t0, token1: t1, fee, tickSpacing: ts };
    }
    if (dex === 'uniswap-v4') return { skip: 'V4 pool without its details' };
    if (!ADDR_RE.test(addr) || !ADDR_RE.test(a) || !ADDR_RE.test(b) || a === b) return { skip: 'bad pool or coin address' };
    // Which kind, by exchange name (core) or by the extra venue's model.
    let kind: Copy2Kind | undefined = CORE_DEX_KIND[dex];
    if (!kind) {
      const venue = ROBINHOOD_VENUES.find((v) => v.id === dex);
      kind = venue ? VENUE_MODEL_KIND[venue.model] : undefined;
    }
    if (!kind) return { skip: `exchange type not followed (${dex || 'unknown'})` };
    // The pool's own shape must agree with its exchange type.
    if (kind === 'V2' || kind === 'Solidly') {
      if (pool.poolType !== 'v2' || pool.variant) return { skip: 'pool shape does not match its exchange' };
    } else if (kind === 'Algebra') {
      if (pool.poolType !== 'v3' || pool.variant !== 'algebra') return { skip: 'pool shape does not match its exchange' };
    } else if (pool.poolType !== 'v3' || pool.variant) {
      return { skip: 'pool shape does not match its exchange' };
    }
    // token0 is always the smaller address (V2, Solidly, V3 and Algebra all sort).
    const [token0, token1] = a < b ? [a, b] : [b, a];
    return { address: addr, kind, token0, token1, fee: 0, tickSpacing: 0 };
  } catch {
    return { skip: 'unreadable pool' };
  }
}

const isPool = (x: Copy2Pool | { skip: string }): x is Copy2Pool => !('skip' in x);

// The whole track list from the watched pools (no duplicates), plus how many
// were left out and why (for the log).
export function buildTrackList(pools: Iterable<PoolState | undefined>, poolManager: string, skipDexes: ReadonlySet<string> = new Set()): { pools: Copy2Pool[]; skipped: Record<string, number> } {
  const out = new Map<string, Copy2Pool>();
  const skipped: Record<string, number> = {};
  for (const p of pools) {
    if (!p) continue;
    const r = copy2PoolOf(p, poolManager, skipDexes);
    if (isPool(r)) out.set(copy2Key(r), r);
    else skipped[r.skip] = (skipped[r.skip] ?? 0) + 1;
  }
  return { pools: [...out.values()].sort((x, y) => (copy2Key(x) < copy2Key(y) ? -1 : 1)), skipped };
}

// What the WebSocket must subscribe to so that every event of these pools
// reaches the copy: coin transfers to / from the contract pools (the V4
// PoolManager is left out on purpose: it moves coins for EVERY V4 pool on the
// chain, which would multiply the node bill; V4 pools are followed from the
// PoolManager's own pool-id events).
export function transferFilterOf(pools: readonly Copy2Pool[]): { coins: string[]; pools: string[] } {
  const coins = new Set<string>(), addrs = new Set<string>();
  for (const p of pools) {
    if (p.kind === 'V4') continue;
    addrs.add(p.address.toLowerCase());
    for (const t of [p.token0, p.token1]) if (t && t !== ZERO_ADDR) coins.add(t.toLowerCase());
  }
  return { coins: [...coins].sort(), pools: [...addrs].sort() };
}

// What a live WebSocket subscription really covers (handed over by the block
// reader when it goes live). A pool is only tracked if ALL its events come in.
export interface Copy2Coverage {
  pools: ReadonlySet<string>;          // contract addresses: all their events
  ids: ReadonlySet<string>;            // V4 pool ids: all PoolManager events for them
  transferPools: ReadonlySet<string>;  // coin transfers to / from these addresses
  coins: ReadonlySet<string>;          // ... of these coins
}

export function coveredPools(pools: readonly Copy2Pool[], cov: Copy2Coverage): Copy2Pool[] {
  return pools.filter((p) => {
    if (p.kind === 'V4') return !!p.v4Id && cov.ids.has(p.v4Id.toLowerCase());
    const a = p.address.toLowerCase();
    if (!cov.pools.has(a) || !cov.transferPools.has(a)) return false;
    return [p.token0, p.token1].every((t) => t === ZERO_ADDR || cov.coins.has(t.toLowerCase()));
  });
}

// ----------------------------------------------------------------------------
// FeedBlockTimes (since copy2-h only a fallback for the parent-chain block
// when a block header has none; block messages take time + bloom from the
// header): each block's time and parent-chain (L1) block number, read
// from the sequencer feed messages the bot already receives (the header of
// each message: Robinhood Chain makes one block per feed message, block
// number = sequence number + ARBSIM_L2_BLOCK_OFFSET, 0 on Robinhood).
// Text search only (no second full JSON read of the frame); never throws.
// ----------------------------------------------------------------------------
export class FeedBlockTimes {
  private readonly times = new Map<number, { timestamp: number; l1Block: number }>();
  private newest = -1;
  private newestAt = 0;      // when the newest block was first heard of (clock ms)
  noted = 0;

  constructor(private readonly offset = 0, private readonly keep = 1024, private readonly now: () => number = Date.now) {}

  noteFrame(text: string): void {
    try {
      if (typeof text !== 'string' || text.indexOf('"sequenceNumber"') < 0) return;
      const re = /"sequenceNumber"\s*:\s*(\d+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const seq = Number(m[1]);
        // The header that belongs to this message is the next "header":{...}.
        const h = text.indexOf('"header"', m.index);
        if (h < 0) break;
        const open = text.indexOf('{', h);
        const close = open < 0 ? -1 : text.indexOf('}', open);
        if (close < 0) break;
        // Never read past the next message's sequence number.
        const nextSeq = text.indexOf('"sequenceNumber"', m.index + 1);
        if (nextSeq >= 0 && nextSeq < close) continue;
        const head = text.slice(open, close);
        const ts = /"timestamp"\s*:\s*(\d+)/.exec(head);
        const l1 = /"blockNumber"\s*:\s*(\d+)/.exec(head);
        if (!ts || !l1 || !Number.isSafeInteger(seq)) continue;
        this.set(seq + this.offset, Number(ts[1]), Number(l1[1]));
      }
    } catch { /* a strange frame is simply skipped */ }
  }

  set(block: number, timestamp: number, l1Block: number): void {
    if (!Number.isSafeInteger(block) || block < 0 || !Number.isSafeInteger(timestamp) || timestamp <= 0) return;
    // Nitro never lets a block's time or L1 block number go backwards: a
    // message stamped earlier than its parent block gets the parent's values.
    const parent = this.times.get(block - 1);
    if (parent) { timestamp = Math.max(timestamp, parent.timestamp); l1Block = Math.max(l1Block, parent.l1Block); }
    this.times.set(block, { timestamp, l1Block });
    this.noted++;
    if (block > this.newest) { this.newest = block; this.newestAt = this.now(); }
    if (this.times.size > this.keep) {
      // Forget the oldest ones (insertion order is close to block order).
      const cut = this.times.size - this.keep;
      let i = 0;
      for (const k of this.times.keys()) { if (i++ >= cut) break; this.times.delete(k); }
    }
  }

  get(block: number): { timestamp: number; l1Block: number } | undefined { return this.times.get(block); }
  newestBlock(): number { return this.newest; }
  // The newest block the feed told us about, and when (for "block_tick").
  newestNote(): { block: number; at: number } | null { return this.newest >= 0 ? { block: this.newest, at: this.newestAt } : null; }
}

// ----------------------------------------------------------------------------
// Copy2Forwarder: puts the pushed reports of each block together and passes
// each block on, in order, as one message: by EXACTLY the rules of the
// dry-run checker that validates copy 2 (execution/copy2Blocks.ts, shared
// with scripts/sim-compare/copy2-dryrun.ts):
//   - every block header the WebSocket pushes (newHeads) gives the block's
//     time, parent-chain block and logsBloom;
//   - a block goes out once its header arrived + graceMs (30), or once
//     something 2+ blocks later arrived; a block with reports but no header
//     waits HEADERLESS_WAIT_MS (400) / maxWaitMs (1500), then its header is
//     read from the HTTP node (counted). Never sent without a time or bloom:
//     if the node can't give the header either, the block is skipped and the
//     copy reloads (prevBlock 0), because arbsim only marks "pending" pools
//     from a bloom; without one a late report could be missed (wrong price);
//   - a block with nothing for our pools goes out as block_tick (with its
//     bloom), so the copy also notices a pool whose reports for that block
//     all arrive late;
//   - a report for a block already passed on goes out at once as its own
//     message ("late", no bloom, the block's own time). arbsim applies it to
//     that pool if nothing came after it, else that pool alone reloads.
// On top of the checker's rules (bot only): prevBlock / gap so the copy
// notices a lost message, the same report twice is passed on once (arbsim
// also drops repeats), and fill-in after a WebSocket outage.
// ----------------------------------------------------------------------------
export type Copy2Index = {
  pools: ReadonlySet<string>;   // tracked contract pools
  ids: ReadonlySet<string>;     // tracked V4 pool ids
  poolManager: string;          // V4 PoolManager (lower case)
  coins: ReadonlySet<string>;   // coins of tracked contract pools
  // Each contract pool's own two coins. A coin Transfer to / from a pool is
  // passed on only when the coin is one of THAT pool's coins (same rule as
  // the checker's classifyLog). Missing = any listed coin (older callers).
  poolCoins?: ReadonlyMap<string, readonly string[]>;
};

export type Copy2ForwarderOptions = {
  // Hand one message to the fast check. false = not delivered (socket down or
  // busy): the forwarder then marks the next message "gap".
  send: (msg: Record<string, unknown>) => boolean;
  index: () => Copy2Index;
  // Block time / parent-chain block from the sequencer feed: only used for
  // the parent-chain block when a header has none.
  blockTime?: (block: number) => { timestamp: number; l1Block?: number } | undefined;
  // HTTP node: headers that never came over the WebSocket, and filling in
  // blocks missed while the WebSocket was down. Each call is one request
  // (the caller counts them).
  backfillRpc?: () => ((method: string, params: unknown[]) => Promise<any>) | null;
  graceMs?: number;          // header arrived + this = block complete (default 30, the checker's --grace-ms)
  maxWaitMs?: number;        // headerless block sent anyway after this (default 1500, the checker's)
  headerTries?: number;      // header reads from the node per block (node a little behind: null answer), default 3
  headerRetryMs?: number;    // wait between those reads (default 150)
  maxBackfill?: number;      // most blocks filled in after an outage (default 200)
  pumpMs?: number;           // how often held blocks are looked at (default 10, the checker's)
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => () => void;
  log?: (m: string) => void;
};

const hexNum = (v: unknown): number | null => {
  if (v === undefined || v === null) return null;
  try { const n = Number(BigInt(v as string)); return Number.isSafeInteger(n) && n >= 0 ? n : null; } catch { return null; }
};
const topicAddr = (t: string | undefined): string | null =>
  typeof t === 'string' && t.length === 66 ? ('0x' + t.slice(26)).toLowerCase() : null;
const padAddr = (a: string): string => '0x' + '0'.repeat(24) + a.toLowerCase().slice(2);
const hexBlock = (b: number) => '0x' + b.toString(16);

// The fields of a log the copy needs, as the node sent them.
function slim(l: RpcLog & { blockHash?: string }): Record<string, unknown> {
  const o: Record<string, unknown> = {
    address: l.address, topics: l.topics, data: l.data, blockNumber: l.blockNumber,
    transactionIndex: l.transactionIndex, logIndex: l.logIndex, transactionHash: l.transactionHash,
  };
  if (l.blockHash) o.blockHash = l.blockHash;
  if (l.removed) o.removed = true;
  return o;
}

// A report's identity, as arbsim sees it (copy2/intake.rs log_id + removed).
const logKey = (l: RpcLog): string =>
  `${hexNum(l.transactionIndex) ?? -1}:${hexNum(l.logIndex) ?? -1}:${String(l.transactionHash ?? '').toLowerCase()}:${l.removed ? 1 : 0}`;

const realSchedule = (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); (t as any).unref?.(); return () => clearTimeout(t); };

export class Copy2Forwarder {
  private readonly o: Copy2ForwarderOptions;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly graceMs: number;
  private readonly maxWaitMs: number;

  private active = false;            // the fast check follows our pools (track accepted)
  private mode: 'down' | 'live' | 'backfilling' = 'down';   // the WebSocket side
  private asm: BlockAssembler;
  private held = new Map<number, Set<string>>();   // block -> report ids held (not passed on yet)
  private sentIds = new Map<number, Set<string>>(); // block -> report ids passed on (recent blocks)
  private lateQ: BlockOut[] = [];   // late reports waiting for the pump (keeps them after their block)
  private lastEmitted = -1;          // newest block passed on (or given up on)
  private prevSent = -1;             // newest block delivered on this connection
  private newestSeen = -1;           // newest block any tracked log came from
  private gapFlag = true;            // next message says "gap" (always true for the first one)
  private pumping = false;
  private headerFill = false;        // headers of skipped blocks being read: hold the pump
  private cancelPump: (() => void) | null = null;
  private backfillFrom = -1;         // first block to fill in after an outage (-1 = nothing to fill)
  private liveMin = Infinity;        // lowest block heard live while filling in
  private gapSentAt = 0;             // when the copy was last told "gap"
  private liveSince = 0;
  private txBlock = new Map<string, number>();
  private txWaiters = new Map<string, Array<(b: number) => void>>();
  private noTsLoggedAt = -Infinity;

  readonly counts = { logsIn: 0, logsKept: 0, heads: 0, blocksSent: 0, ticks: 0, msgsDropped: 0, late: 0, lateDup: 0, dupLogs: 0, reorgLogs: 0, gaps: 0, backfills: 0, backfillFails: 0, backfillLogs: 0, noTimestamp: 0, headersFetched: 0, headerFails: 0, headerGaps: 0 };

  constructor(o: Copy2ForwarderOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.schedule = o.schedule ?? realSchedule;
    this.graceMs = Math.max(0, o.graceMs ?? 30);
    this.maxWaitMs = Math.max(1, o.maxWaitMs ?? 1500);
    this.asm = new BlockAssembler(this.graceMs, this.maxWaitMs);
  }

  private log(m: string): void { try { (this.o.log ?? (() => {}))(m); } catch { /* logging only */ } }

  // ---- switches ------------------------------------------------------------
  // The fast check accepted our track list (true) or is not following pools (false).
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    // Whatever the copy had before is no longer known to match: start over
    // with "gap" (the copy reloads), from the next block.
    this.resetBlocks();
    this.gapFlag = true;
    this.prevSent = -1;
    if (!on) { this.backfillFrom = -1; return; }
    if (this.mode === 'live' || this.mode === 'backfilling') this.liveSince = this.now();
  }
  isActive(): boolean { return this.active; }

  // The WebSocket subscriptions (our extra filters + block headers) are live.
  onLive(): void {
    try {
      if (this.mode === 'live' || this.mode === 'backfilling') return;
      this.liveSince = this.now();
      if (this.active && this.backfillFrom >= 0) { this.mode = 'backfilling'; this.liveMin = Infinity; void this.backfill(this.backfillFrom); }
      else this.mode = 'live';
      this.backfillFrom = -1;
    } catch { this.mode = 'live'; this.markGap(); }
  }

  // The WebSocket dropped: events from now on are missed until it is back.
  onDown(): void {
    try {
      if (this.mode === 'down') return;
      const wasBackfilling = this.mode === 'backfilling';
      this.mode = 'down';
      // Held blocks may be only partly received: they are filled in later.
      this.dropHeld();
      if (this.active) {
        if (wasBackfilling) { this.backfillFrom = -1; this.markGap(); }    // two outages in a row: just reload
        else if (this.lastEmitted >= 0) this.backfillFrom = this.lastEmitted + 1;
        else this.markGap();
      }
    } catch { this.markGap(); }
  }

  // ---- headers in ----------------------------------------------------------
  // Every block header the WebSocket pushed (newHeads), as received.
  onHead(raw: unknown): void {
    try {
      if (!this.active || this.mode === 'down') return;
      const h = headFromNewHeads(raw, this.now());
      if (!h) return;
      this.counts.heads++;
      if (this.mode === 'backfilling') { this.liveMin = Math.min(this.liveMin, h.block); this.asm.addHead(h); return; }
      // Headers skipped while the WebSocket stayed up (the node left some
      // out): read them from the node (logs subscriptions are separate, so
      // their reports still come), holding the pump meanwhile so the blocks
      // still go out in order, each with its bloom. As the checker does.
      // (Not when a reload is coming anyway: gap pending.)
      const gap = this.lastEmitted >= 0 && !this.gapFlag ? this.asm.gapBefore(h.block) : null;
      this.asm.addHead(h);
      if (gap && gap.from > this.lastEmitted) void this.fillHeaders(gap.from, gap.to);
      this.schedulePump(this.o.pumpMs ?? 10);
    } catch { /* never breaks the reader */ }
  }

  // ---- logs in -------------------------------------------------------------
  // Every log the WebSocket pushed (all subscriptions), as received. Cheap:
  // filter, put into its block, schedule the pump. Never throws.
  onLogs(logs: RpcLog[]): void {
    try {
      if (!this.active || this.mode === 'down') return;
      const idx = this.o.index();
      const t = this.now();
      let any = false;
      for (const l of logs) {
        this.counts.logsIn++;
        if (!l || !this.relevant(l, idx)) continue;
        const b = hexNum(l.blockNumber);
        if (b === null || hexNum(l.logIndex) === null) continue;
        this.counts.logsKept++;
        if (l.removed) this.counts.reorgLogs++;
        else this.noteTx(l.transactionHash, b);
        if (this.mode === 'backfilling') this.liveMin = Math.min(this.liveMin, b);
        // The same report from two subscriptions (a transfer between two of
        // our pools comes as "from" AND "to"): passed on once.
        const key = logKey(l);
        if (this.held.get(b)?.has(key) || this.sentIds.get(b)?.has(key)) {
          if (this.sentIds.get(b)?.has(key)) this.counts.lateDup++; else this.counts.dupLogs++;
          continue;
        }
        const late = this.asm.addLog(slim(l), t);
        if (late) {
          // Its block was already passed on: its own message, after the pump.
          this.counts.late++;
          this.noteSent(b, key);
          this.lateQ.push(late);
        } else {
          (this.held.get(b) ?? this.held.set(b, new Set()).get(b)!).add(key);
          if (b > this.newestSeen && !l.removed) this.newestSeen = b;
        }
        any = true;
      }
      if (any) this.schedulePump(this.lateQ.length ? 0 : (this.o.pumpMs ?? 10));
    } catch { /* never breaks the reader */ }
  }

  // Is this log about a tracked pool? (the checker's classifyLog rule)
  private relevant(l: RpcLog, idx: Copy2Index): boolean {
    const addr = (l.address || '').toLowerCase();
    const t0 = (l.topics?.[0] || '').toLowerCase();
    if (t0 === TRANSFER_TOPIC && l.topics?.length === 3) {
      // A coin Transfer to / from one of our pools, of one of ITS coins.
      const from = topicAddr(l.topics[1]), to = topicAddr(l.topics[2]);
      for (const side of [from, to]) {
        if (!side || !idx.pools.has(side)) continue;
        const own = idx.poolCoins?.get(side);
        if (own ? own.includes(addr) : idx.coins.has(addr)) return true;
      }
      // A Transfer of a pool's OWN LP token (V2 pairs) is a pool report.
      return idx.pools.has(addr);
    }
    if (idx.pools.has(addr)) return true;
    if (addr === idx.poolManager) {
      const id = (l.topics?.[1] || '').toLowerCase();
      return !!id && idx.ids.has(id);
    }
    return false;
  }

  // ---- blocks out ----------------------------------------------------------
  private schedulePump(ms: number): void {
    if (this.cancelPump) {
      if (ms > 0) return;               // already planned
      this.cancelPump(); this.cancelPump = null;
    }
    this.cancelPump = this.schedule(() => { this.cancelPump = null; void this.pump(); }, Math.max(0, ms));
  }

  // Pass on every block that is complete (in order), then late reports.
  // A block without a header (or without a bloom) gets its header read from
  // the node first. Runs again every pumpMs while blocks are held.
  async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      if (!this.active || this.mode !== 'live' || this.headerFill) return;
      for (const b of this.asm.due(this.now())) {
        if (this.stopped()) return;
        this.held.delete(b.block);
        if (b.timestamp === null || !b.logsBloom) await this.readHeader(b);
        // (The WebSocket may have dropped while the node answered.)
        if (this.stopped()) return;
        this.emit(b);
      }
      this.sendLate();
    } catch { /* never throws */ } finally {
      this.pumping = false;
      if (this.active && this.mode === 'live' && (this.asm.pendingCount() > 0 || this.lateQ.length)) this.schedulePump(this.lateQ.length ? 0 : (this.o.pumpMs ?? 10));
    }
  }

  // The header of a block that went out of the assembler without one (or
  // without a bloom): read from the HTTP node (one request per try).
  private async readHeader(b: BlockOut): Promise<void> {
    const h = await this.fetchHead(b.block);
    if (!h) return;
    b.timestamp = h.timestamp;
    b.l1Block = h.l1Block;
    b.logsBloom = h.logsBloom ?? null;
    this.asm.rememberSent(h);
  }

  private async fetchHead(block: number): Promise<Head | null> {
    const rpc = this.o.backfillRpc?.() ?? null;
    if (!rpc) return null;
    const tries = Math.max(1, this.o.headerTries ?? 3);
    for (let i = 0; i < tries; i++) {
      try {
        const r = await rpc('eth_getBlockByNumber', [hexBlock(block), false]);
        const h = r ? headFromNewHeads(r, this.now()) : null;
        if (h && h.block === block && h.timestamp !== null && h.logsBloom) { this.counts.headersFetched++; return h; }
      } catch { /* try again */ }
      // null = the node is a little behind the WebSocket: ask again shortly.
      if (i + 1 < tries) await new Promise<void>((res) => this.schedule(res, this.o.headerRetryMs ?? 150));
    }
    this.counts.headerFails++;
    return null;
  }

  // Headers the WebSocket skipped (blocks from..to): read from the node.
  private async fillHeaders(from: number, to: number): Promise<void> {
    if (this.headerFill) return;
    this.counts.headerGaps++;
    if (to - from + 1 > (this.o.maxBackfill ?? 200)) { this.markGap(); return; }
    this.headerFill = true;
    try {
      for (let b = from; b <= to; b++) {
        const h = await this.fetchHead(b);
        if (!this.active || this.mode !== 'live') return;
        if (h) this.asm.addHead({ ...h, at: this.now() - 10_000 });
        // A header the node can't give: that block (if it had no reports)
        // would never go out; the copy reloads instead.
        else this.markGap();
      }
    } finally {
      this.headerFill = false;
      this.schedulePump(0);
    }
  }

  private emit(b: BlockOut): void {
    this.lastEmitted = Math.max(this.lastEmitted, b.block);
    if (b.timestamp === null || !b.logsBloom) {
      // Header unknown even from the node. arbsim needs the time to apply
      // the block exactly, and the bloom to notice reports still on their
      // way; it must never get a guess, so this block is NOT passed on and
      // the next message makes the copy reload (prevBlock 0). Routing goes
      // to the node meanwhile.
      this.counts.noTimestamp++;
      this.gapFlag = true;
      if (this.now() - this.noTsLoggedAt > 60_000) { this.noTsLoggedAt = this.now(); this.log(`[copy2] block ${b.block}: its header could not be read (WebSocket and node), the copy reloads instead`); }
      return;
    }
    // Parent-chain block: the header's; the feed's if the header has none.
    if (b.l1Block === null) { const f = this.o.blockTime?.(b.block); if (f?.l1Block !== undefined) b.l1Block = f.l1Block; }
    const msg = blockMessage(b);
    // prevBlock (arbsim reloads every pool when prevBlock >= its first block
    // and it never received prevBlock: copy2/intake.rs process()):
    //   - normally block - 1: every block goes out (ticks included), so a
    //     block that silently went missing is noticed by the copy;
    //   - after a gap (message dropped, block skipped, outage not filled,
    //     fresh start): THIS block, which the copy can't have yet, so it
    //     reloads. (prevBlock 0 never triggered a reload: 0 is below the
    //     copy's first block.) A fresh arbsim has received nothing: no reload.
    msg.prevBlock = this.gapFlag ? b.block : b.block - 1;
    for (const l of b.logs) this.noteSent(b.block, logKey(l as RpcLog));
    this.deliver(b.block, msg, !b.logs.length);
  }

  // Hand a pool_logs / block_tick message over and keep the bookkeeping.
  private deliver(b: number, msg: Record<string, unknown>, tick: boolean): void {
    const gap = this.gapFlag;
    if (gap) msg.gap = true;
    if (this.send(msg)) {
      if (tick) this.counts.ticks++; else this.counts.blocksSent++;
      this.prevSent = b;
      if (gap) { this.gapFlag = false; this.gapSentAt = this.now(); this.counts.gaps++; }
    } else {
      this.counts.msgsDropped++;
      this.gapFlag = true;
    }
  }

  // Late reports: their own message for an ALREADY passed-on block, with
  // that block's own time (no bloom, no prevBlock: as the checker sends
  // them). A reload already coming (gap) covers them; a block whose time is
  // forgotten can't be described exactly: the copy reloads instead.
  private sendLate(): void {
    const q = this.lateQ;
    this.lateQ = [];
    for (const b of q) {
      if (this.gapFlag) return;
      if (b.timestamp === null) { this.markGap(); return; }
      if (b.l1Block === null) { const f = this.o.blockTime?.(b.block); if (f?.l1Block !== undefined) b.l1Block = f.l1Block; }
      const msg = { ...blockMessage(b), late: true };
      if (!this.send(msg)) { this.counts.msgsDropped++; this.gapFlag = true; }
    }
  }

  private noteSent(b: number, key: string): void {
    const s = this.sentIds.get(b);
    if (s) { s.add(key); return; }
    this.sentIds.set(b, new Set([key]));
    if (this.sentIds.size > 64) this.sentIds.delete(this.sentIds.keys().next().value as number);
  }

  private send(msg: Record<string, unknown>): boolean {
    try { return this.o.send(msg) === true; } catch { return false; }
  }

  private markGap(): void { this.gapFlag = true; }
  private stopped(): boolean { return !this.active || this.mode === 'down'; }

  // Held (not passed on) blocks forgotten; what was passed on is kept.
  private dropHeld(): void {
    this.asm.dropPending();
    this.held.clear();
    this.lateQ = [];
    if (this.cancelPump) { this.cancelPump(); this.cancelPump = null; }
  }

  // Start over (track list changed / copy 2 off): a fresh assembler that
  // continues after the newest block already passed on.
  private resetBlocks(): void {
    this.dropHeld();
    this.asm = new BlockAssembler(this.graceMs, this.maxWaitMs);
    if (this.lastEmitted >= 0) this.asm.lastSent = this.lastEmitted;
    this.sentIds.clear();
  }

  // ---- fill-in after a WebSocket outage --------------------------------------
  // One read per kind of subscription over the missed blocks, plus each
  // missed block's header (HTTP node), merged with what arrived live
  // meanwhile, then passed on in order (empty blocks as ticks, as the
  // checker does). Anything that fails: the copy is told "gap" (it reloads;
  // never a guess).
  private async backfill(from: number): Promise<void> {
    const rpc = this.o.backfillRpc?.() ?? null;
    const done = (ok: boolean) => {
      if (this.mode !== 'backfilling') return;        // went down again meanwhile (onDown handled it)
      if (!ok) { this.counts.backfillFails++; this.markGap(); this.asm.dropPending(); this.held.clear(); }
      this.mode = 'live';
      this.schedulePump(0);
    };
    try {
      if (!rpc) { done(false); return; }
      const headRaw = await rpc('eth_blockNumber', []);
      const head = hexNum(headRaw);
      if (head === null) { done(false); return; }
      if (head < from) { done(true); return; }
      if (head - from + 1 > (this.o.maxBackfill ?? 200)) { this.log('[copy2] outage too long to fill in, the copy reloads instead'); done(false); return; }
      const idx = this.o.index();
      const range = { fromBlock: hexBlock(from), toBlock: hexBlock(head) };
      const pools = [...idx.pools], ids = [...idx.ids], coins = [...idx.coins];
      const padded = pools.map(padAddr);
      const asks: Array<Promise<any>> = [];
      if (pools.length) asks.push(rpc('eth_getLogs', [{ ...range, address: pools }]));
      if (ids.length && idx.poolManager) asks.push(rpc('eth_getLogs', [{ ...range, address: idx.poolManager, topics: [null, ids] }]));
      if (coins.length && padded.length) {
        asks.push(rpc('eth_getLogs', [{ ...range, address: coins, topics: [TRANSFER_TOPIC, padded] }]));
        asks.push(rpc('eth_getLogs', [{ ...range, address: coins, topics: [TRANSFER_TOPIC, null, padded] }]));
      }
      const results = await Promise.all(asks);
      if (this.mode !== 'backfilling') return;
      const all: RpcLog[] = [];
      for (const r of results) { if (!Array.isArray(r)) { done(false); return; } all.push(...r); }
      // Each missed block's header (time + bloom), as the checker does.
      // (10 at a time: never a burst of 200 requests at the node.)
      const heads: Array<Head | null> = [];
      for (let b = from; b <= head && this.mode === 'backfilling'; b += 10) {
        const n = Math.min(10, head - b + 1);
        heads.push(...await Promise.all(Array.from({ length: n }, (_, i) => this.fetchHead(b + i))));
      }
      if (this.mode !== 'backfilling') return;
      if (heads.some((h) => !h)) { done(false); return; }
      // Blocks between the node's newest and the first block heard live
      // after the reconnect would be missing (the node is a little behind
      // the WebSocket): the copy reloads instead.
      if (this.liveMin !== Infinity && this.liveMin > head + 1) { done(false); return; }
      this.counts.backfills++;
      this.counts.backfillLogs += all.length;
      // Merge: same path as live logs (one report once), headers already old
      // (due at once).
      this.mode = 'live';
      this.onLogs(all.filter((l) => !l?.removed));
      for (const h of heads) this.asm.addHead({ ...h!, at: this.now() - 10_000 });
      this.mode = 'backfilling';
      done(true);
    } catch (e) {
      this.log(`[copy2] fill-in after the WebSocket outage failed (${String((e as Error)?.message ?? e).slice(0, 60).replace(/https?:\/\/\S+|wss?:\/\/\S+/g, '[url]')}), the copy reloads instead`);
      done(false);
    }
  }

  // ---- facts for the bot ----------------------------------------------------
  // Logs are flowing and nothing is being filled in right now.
  live(): boolean { return this.active && this.mode === 'live' && !this.gapFlag; }
  // When the copy was last told "gap" (a status taken before that is outdated).
  lastGapAt(): number { return this.gapSentAt; }
  // Newest block the copy has (or is about to get): reports seen, or a block sent.
  newestBlock(): number { return Math.max(this.newestSeen, this.prevSent); }
  modeText(): string { return !this.active ? 'off' : this.mode === 'live' ? (this.gapFlag ? 'live (gap pending)' : 'live') : this.mode; }

  // The block a transaction's events came in (null = not seen).
  txBlockOf(hash: string | undefined): number | null {
    if (!hash) return null;
    return this.txBlock.get(hash.toLowerCase()) ?? null;
  }

  // Wait until a log of this transaction arrives (it is then in a block).
  // null = not within ms.
  waitForTx(hash: string | undefined, ms: number): Promise<number | null> {
    const h = (hash ?? '').toLowerCase();
    if (!h) return Promise.resolve(null);
    const b = this.txBlock.get(h);
    if (b !== undefined) return Promise.resolve(b);
    return new Promise((resolve) => {
      let finished = false;
      const fin = (v: number | null) => { if (finished) return; finished = true; cancel(); resolve(v); };
      const cancel = this.schedule(() => {
        const list = this.txWaiters.get(h);
        if (list) { const i = list.indexOf(ok); if (i >= 0) list.splice(i, 1); if (!list.length) this.txWaiters.delete(h); }
        fin(null);
      }, Math.max(0, ms));
      const ok = (blk: number) => fin(blk);
      const list = this.txWaiters.get(h);
      if (list) list.push(ok); else this.txWaiters.set(h, [ok]);
      if (this.txWaiters.size > 500) { const first = this.txWaiters.keys().next().value as string; for (const f of this.txWaiters.get(first) ?? []) { try { f(-1); } catch { /* */ } } this.txWaiters.delete(first); }
    }).then((v) => (v === -1 ? null : (v as number | null)));
  }

  private noteTx(hash: string | undefined, b: number): void {
    if (!hash) return;
    const h = hash.toLowerCase();
    if (!this.txBlock.has(h)) {
      this.txBlock.set(h, b);
      if (this.txBlock.size > 5_000) this.txBlock.delete(this.txBlock.keys().next().value as string);
    }
    const w = this.txWaiters.get(h);
    if (w) { this.txWaiters.delete(h); for (const f of w) { try { f(b); } catch { /* */ } } }
  }
}

// ----------------------------------------------------------------------------
// parseCopy2Status: read the fast check's status answer. Tolerant of shapes
// (the Rust side is built in parallel). Recognised:
//   source: "pool-events"                     -> copy 2 is running
//   copy2: { pools: {"<key>": "ready"|..} }   or pools: [{address|key, v4Id?, state}]
//   copy2: { ready: [keys], unsure: [keys], loading: [keys] }
// Anything not clearly "ready" counts as NOT ready (strict).
// ----------------------------------------------------------------------------
export type Copy2PoolState = 'ready' | 'loading' | 'unsure';
export type Copy2Status = { active: boolean; states: Map<string, Copy2PoolState> | null; counts: { ready: number; loading: number; unsure: number; tracked: number } | null };

function stateWord(v: unknown): Copy2PoolState {
  const s = String(typeof v === 'object' && v !== null ? (v as any).state ?? (v as any).status ?? '' : v ?? '').toLowerCase();
  if (s === 'ready') return 'ready';
  if (/load|fill|pending|new/.test(s)) return 'loading';
  return 'unsure';
}

export function parseCopy2Status(s: unknown): Copy2Status {
  const out: Copy2Status = { active: false, states: null, counts: null };
  try {
    if (!s || typeof s !== 'object') return out;
    const st = s as Record<string, any>;
    const c = st.copy2 && typeof st.copy2 === 'object' ? st.copy2 : null;
    const src = String(c?.source ?? st.source ?? '').toLowerCase();
    out.active = src === 'pool-events' || (!!c && c.active !== false && src !== 'feed');
    if (!out.active) return out;
    const body = c ?? st;
    const states = new Map<string, Copy2PoolState>();
    let seen = false;
    // arbsim (sim/src/copy2/intake.rs status_json): `pools` is a count and the
    // per-pool list is `list` ([{address, v4Id, kind, state, reason}]).
    const pools = Array.isArray(body.list) ? body.list : body.pools;
    if (Array.isArray(pools)) {
      seen = true;
      for (const p of pools) {
        if (!p || typeof p !== 'object') continue;
        const key = String(p.v4Id ?? p.v4_id ?? p.key ?? p.address ?? p.pool ?? '').toLowerCase();
        if (key) states.set(key, stateWord(p));
      }
    } else if (pools && typeof pools === 'object') {
      seen = true;
      for (const [k, v] of Object.entries(pools)) states.set(k.toLowerCase(), stateWord(v));
    }
    for (const w of ['ready', 'loading', 'unsure'] as const) {
      if (Array.isArray(body[w])) {
        seen = true;
        for (const k of body[w]) if (typeof k === 'string') states.set(k.toLowerCase(), w);
      }
    }
    if (seen) out.states = states;
    // Counts: from the per-pool list, else from plain numbers if given.
    if (seen) {
      const n = { ready: 0, loading: 0, unsure: 0, tracked: states.size };
      for (const v of states.values()) n[v]++;
      out.counts = n;
    } else {
      const num = (k: string) => (Number.isFinite(Number(body[k])) ? Number(body[k]) : 0);
      const n = { ready: num('ready'), loading: num('loading'), unsure: num('unsure'), tracked: num('tracked') || num('pools') };
      if (n.ready || n.loading || n.unsure || n.tracked) out.counts = { ...n, tracked: n.tracked || n.ready + n.loading + n.unsure };
    }
  } catch { /* unreadable status: treated as "not running" */ }
  return out;
}

// ============================================================================
// Copy2Link: runs copy 2 from the bot's side (created by the fast check host,
// execution/localSimHost.ts, only when LOCAL_SIM is shadow or on).
//
//   - asks the fast check every 2 s how it is doing (status): is it
//     following pools ("pool-events" mode), and which pools are ready
//   - only while it is: asks the block reader's WebSocket for the extra
//     events (the "tap"), and sends the track list of the pools the
//     subscription really covers
//   - passes the pool reports on (Copy2Forwarder)
//   - answers the bot's question "may the fast check decide this route?"
//     (route): yes only if copy 2 runs, the reports are flowing without a
//     gap, its status is fresh, and EVERY pool on the route is ready
//
// Settings (.env):
//   LOCAL_SIM_COPY2          auto (default): used when the fast check runs in
//                            pool-events mode; off: never (old behaviour)
//   COPY2_SKIP_DEXES         exchange names never followed, comma separated
//   COPY2_GRACE_MS           30    a block is complete this long after its
//                                  header (the dry run's --grace-ms)
//   COPY2_HEADERLESS_MAX_MS  1500  a block whose header never came is sent
//                                  (header read from the node) after this
//   COPY2_STATUS_MS          2000  how often readiness is asked
//   COPY2_MAX_STATUS_AGE_MS  10000 older readiness = not trusted (node decides)
//   COPY2_BACKFILL_MAX       200   most blocks filled in after an outage
//   COPY2_WSS_MAX_PCT        80    copy 2's WebSocket subscriptions (incl.
//                                  newHeads, ~1 message per block) stop for
//                                  the rest of the UTC day once today's pushed
//                                  messages reach this % of
//                                  BLOCK_READER_WSS_DAILY, so the price feed
//                                  keeps its share (0 = no copy-2 limit)
//   ARBSIM_L2_BLOCK_OFFSET   0     block number = feed sequence number + this
// ============================================================================
export type Copy2Settings = {
  mode: 'auto' | 'off';
  skipDexes: Set<string>;
  graceMs: number;
  headerlessMaxMs: number;
  statusEveryMs: number;
  maxStatusAgeMs: number;
  maxBackfill: number;
  wssMaxPct: number;
  l2Offset: number;
};

export function copy2Settings(env: Record<string, string | undefined> = process.env): Copy2Settings {
  const num = (k: string, d: number, min = 0) => { const v = Number(env[k]); return env[k] !== undefined && env[k] !== '' && Number.isFinite(v) && v >= min ? v : d; };
  const mode = (env.LOCAL_SIM_COPY2 ?? '').trim().toLowerCase();
  return {
    mode: mode === 'off' || mode === '0' || mode === 'no' ? 'off' : 'auto',
    skipDexes: new Set((env.COPY2_SKIP_DEXES ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)),
    graceMs: num('COPY2_GRACE_MS', 30),
    headerlessMaxMs: num('COPY2_HEADERLESS_MAX_MS', 1_500, 1),
    statusEveryMs: num('COPY2_STATUS_MS', 2_000, 200),
    maxStatusAgeMs: num('COPY2_MAX_STATUS_AGE_MS', 10_000, 500),
    maxBackfill: num('COPY2_BACKFILL_MAX', 200, 1),
    wssMaxPct: Math.min(100, num('COPY2_WSS_MAX_PCT', 80)),
    l2Offset: num('ARBSIM_L2_BLOCK_OFFSET', 0),
  };
}

type LinkClient = Pick<LocalSimClient, 'request' | 'sendOneWay' | 'isConnected'>;

export type Copy2LinkOptions = {
  client: LinkClient;
  settings: Copy2Settings;
  pools: () => Iterable<PoolState | undefined>;   // the watched Robinhood pools
  poolManager: string;
  now?: () => number;
  log?: (m: string) => void;
  schedule?: (fn: () => void, ms: number) => () => void;
  autoTimers?: boolean;                             // default true (tests drive it by hand)
};

export type Copy2Route = { at: { block: string }; block: number };

const EMPTY_INDEX: Copy2Index = { pools: new Set(), ids: new Set(), poolManager: '', coins: new Set() };

export class Copy2Link {
  readonly forwarder: Copy2Forwarder;
  readonly times: FeedBlockTimes;
  readonly tap: RawLogTap;
  private readonly o: Copy2LinkOptions;
  private readonly now: () => number;
  private timers: NodeJS.Timeout[] = [];

  private sidecarOn = false;                         // the fast check says it follows pools
  private states: Map<string, Copy2PoolState> | null = null;
  private statusCounts: Copy2Status['counts'] = null;
  private statusAt = 0;
  private desired: Copy2Pool[] = [];
  private desiredAt = -Infinity;
  private desiredSkipped: Record<string, number> = {};
  private coverage: Copy2Coverage | null = null;
  private tracked: Copy2Pool[] = [];
  private trackedSig = '';
  private trackOk = false;
  private trackBusy = false;
  private index: Copy2Index = EMPTY_INDEX;
  private backfillRpc: ((method: string, params: unknown[]) => Promise<any>) | null = null;
  private loggedState = '';

  // Hourly counters (taken by hourText).
  private hour = { fast: 0, notReady: {} as Record<string, number> };

  constructor(o: Copy2LinkOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    const s = o.settings;
    this.times = new FeedBlockTimes(s.l2Offset, 1024, this.now);
    this.forwarder = new Copy2Forwarder({
      send: (m) => o.client.sendOneWay(m),
      index: () => this.index,
      blockTime: (b) => this.times.get(b),
      backfillRpc: () => this.backfillRpc,
      graceMs: s.graceMs,
      maxWaitMs: s.headerlessMaxMs,
      maxBackfill: s.maxBackfill,
      now: this.now,
      schedule: o.schedule,
      log: (m) => this.log(m),
    });
    // What the block reader's WebSocket calls (see core/blockReaderWs.ts RawLogTap).
    this.tap = {
      wanted: () => s.mode !== 'off' && this.sidecarOn,
      transferFilter: () => transferFilterOf(this.desiredList()),
      onLogs: (logs) => this.forwarder.onLogs(logs),
      onHead: (h) => this.forwarder.onHead(h),
      dailyShare: () => s.wssMaxPct / 100,
      onLive: (cov) => {
        this.coverage = cov;
        this.forwarder.onLive();
        void this.sendTrack(false);
      },
      onDown: () => this.forwarder.onDown(),
    };
    if (o.autoTimers !== false && s.mode !== 'off') {
      const every = (fn: () => void, ms: number) => { const t = setInterval(() => { try { fn(); } catch { /* never throws */ } }, ms); t.unref?.(); this.timers.push(t); };
      every(() => { void this.pollStatus(); }, s.statusEveryMs);
      every(() => { void this.sendTrack(false); this.logIfChanged(); }, 30_000);
      every(() => { void this.sendTrack(true); }, 10 * 60_000);
    }
  }

  private log(m: string): void { try { (this.o.log ?? console.log)(m); } catch { /* logging only */ } }

  // The HTTP node used to fill in blocks missed during a WebSocket outage.
  setBackfillRpc(rpc: ((method: string, params: unknown[]) => Promise<any>) | null): void { this.backfillRpc = rpc; }

  // Every raw sequencer-feed message (parent-chain block for a header that
  // has none). Cheap; only while copy 2 runs.
  noteFeed(text: string): void { if (this.sidecarOn) this.times.noteFrame(text); }

  // The pools copy 2 should follow (from the watch list, rebuilt at most every 5 s).
  desiredList(): Copy2Pool[] {
    const t = this.now();
    if (t - this.desiredAt >= 5_000) {
      try {
        const r = buildTrackList(this.o.pools(), this.o.poolManager, this.o.settings.skipDexes);
        this.desired = r.pools;
        this.desiredSkipped = r.skipped;
      } catch { /* keep the last list */ }
      this.desiredAt = t;
    }
    return this.desired;
  }

  // The fast check (re)connected: it may have restarted, so start over.
  onClientConnect(): void {
    this.trackOk = false;
    this.trackedSig = '';
    this.forwarder.setActive(false);
    void this.pollStatus();
  }

  // ---- status ---------------------------------------------------------------
  async pollStatus(): Promise<void> {
    try {
      if (this.o.settings.mode === 'off' || !this.o.client.isConnected()) return;
      const a: SidecarAnswer = await this.o.client.request({ type: 'status', pools: true }, 2_000);
      if (a.ok !== true) return;
      this.applyStatus(a);
    } catch { /* next poll */ }
  }

  applyStatus(a: unknown): void {
    const st = parseCopy2Status(a);
    const was = this.sidecarOn;
    this.sidecarOn = st.active;
    this.states = st.states;
    this.statusCounts = st.counts;
    this.statusAt = this.now();
    if (!st.active) {
      if (was) this.log('[copy2] the fast check is not following pools (pool-events mode off): copy 2 routing off');
      this.trackOk = false;
      this.forwarder.setActive(false);
      return;
    }
    if (!was) this.log('[copy2] the fast check follows our pools from their events (pool-events mode): asking the WebSocket for the extra events');
    if (!this.trackOk) void this.sendTrack(false);
  }

  // ---- track ----------------------------------------------------------------
  // Send the list of pools copy 2 follows: watched, a supported type, and
  // fully covered by the live WebSocket subscription.
  async sendTrack(force: boolean): Promise<void> {
    if (this.trackBusy) return;
    try {
      if (!this.sidecarOn || !this.coverage || !this.o.client.isConnected()) return;
      const list = coveredPools(this.desiredList(), this.coverage);
      const sig = list.map(copy2Key).join(',');
      if (!force && this.trackOk && sig === this.trackedSig) return;
      this.trackBusy = true;
      const a = await this.o.client.request({ type: 'track', pools: list }, 5_000);
      if (a.ok !== true) {
        this.trackOk = false;
        this.forwarder.setActive(false);
        this.log(`[copy2] track list not accepted (${(a as { unknown?: string }).unknown ?? 'no reason'}); the node decides every check`);
        return;
      }
      const changed = sig !== this.trackedSig;
      this.tracked = list;
      this.trackedSig = sig;
      this.index = indexOf(list, this.o.poolManager);
      this.trackOk = true;
      this.forwarder.setActive(true);
      if (changed) {
        const skipped = Object.entries(this.desiredSkipped).sort((x, y) => y[1] - x[1]).slice(0, 4).map(([w, n]) => `${w} ${n}`).join(', ');
        const notCovered = this.desired.length - list.length;
        this.log(`[copy2] following ${list.length} pools (${kindCounts(list) || 'none'})${notCovered ? `, ${notCovered} wait for the next WebSocket renewal` : ''}${skipped ? ` | not followed: ${skipped}` : ''}`);
      }
    } catch {
      /* next try */
    } finally {
      this.trackBusy = false;
    }
  }

  // ---- routing ----------------------------------------------------------------
  // Why the fast check may NOT decide a route with these pools right now
  // (null = it may). Keys: pool addresses, V4 pool ids, the loan pool.
  notReadyWhy(keys: Array<string | undefined | null>): string | null {
    if (this.o.settings.mode === 'off' || !this.sidecarOn) return 'copy 2 not running';
    if (!this.trackOk) return 'track list not accepted yet';
    if (!this.forwarder.live()) return 'pool reports not flowing';
    const t = this.now();
    if (t - this.statusAt > this.o.settings.maxStatusAgeMs) return 'readiness too old';
    if (this.statusAt <= this.forwarder.lastGapAt()) return 'reloading after a gap';
    if (!this.states) return 'readiness not reported';
    let any = false;
    for (const k of keys) {
      if (!k) continue;
      any = true;
      const key = k.toLowerCase();
      const isTracked = key.length === 66 ? this.index.ids.has(key) : this.index.pools.has(key);
      if (!isTracked) return 'pool not followed';
      const s = this.states.get(key);
      if (s !== 'ready') return s === 'loading' ? 'pool loading' : 'pool unsure';
    }
    return any ? null : 'no pools given';
  }

  // The route's `at` for the fast check (state right after the newest block
  // whose reports were passed on, at least minBlock), or null = the node
  // decides. Counted for the hourly line.
  route(keys: Array<string | undefined | null>, minBlock = -1): Copy2Route | null {
    const why = this.notReadyWhy(keys);
    const block = Math.max(minBlock, this.forwarder.newestBlock());
    if (why || block < 0) {
      const w = why ?? 'no block yet';
      this.hour.notReady[w] = (this.hour.notReady[w] ?? 0) + 1;
      return null;
    }
    this.hour.fast++;
    return { at: { block: '0x' + block.toString(16) }, block };
  }

  // Copy 2 is running (the fast check's old "replay the feed" answers, like
  // "right after this transaction", are then not available).
  running(): boolean { return this.o.settings.mode !== 'off' && this.sidecarOn; }

  // Wait until a transaction's pool reports arrived (it is then in a block).
  waitForTx(hash: string | undefined, ms: number): Promise<number | null> {
    if (!this.running()) return Promise.resolve(null);
    return this.forwarder.waitForTx(hash, ms);
  }

  // ---- reporting ----------------------------------------------------------------
  // e.g. "copy 2: 412 ready, 3 unsure, 5 loading of 420 pools; routed to fast check 120,
  //       to node 30 (pool unsure 20, readiness too old 10); pool reports live: 5321 blocks passed on"
  hourText(): string | null {
    const h = this.hour;
    this.hour = { fast: 0, notReady: {} };
    if (this.o.settings.mode === 'off') return null;
    if (!this.sidecarOn) return 'copy 2: not running (fast check not in pool-events mode)';
    const c = this.statusCounts;
    const f = this.forwarder.counts;
    const node = Object.values(h.notReady).reduce((x, y) => x + y, 0);
    const whys = Object.entries(h.notReady).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w} ${n}`).join(', ');
    return [
      c ? `copy 2: ${c.ready} ready, ${c.unsure} unsure, ${c.loading} loading of ${c.tracked} pools` : `copy 2: following ${this.tracked.length} pools (readiness not reported)`,
      `routed to fast check ${h.fast}, to node ${node}${whys ? ` (${whys})` : ''}`,
      `pool reports ${this.forwarder.modeText()}: ${f.blocksSent} blocks passed on${f.msgsDropped ? `, ${f.msgsDropped} DROPPED` : ''}${f.gaps ? `, ${f.gaps} gaps` : ''}${f.late ? `, ${f.late} late` : ''}${f.backfills ? `, ${f.backfills} outages filled in` : ''}${f.backfillFails ? `, ${f.backfillFails} not filled` : ''}${f.noTimestamp ? `, ${f.noTimestamp} skipped (no header)` : ''}${f.headersFetched ? `, ${f.headersFetched} headers read from the node` : ''}`,
    ].join('; ');
  }

  // Short state, logged when it changes (checked every 30 s).
  stateLine(): string {
    return `${this.sidecarOn ? 'on' : 'off'} / following ${this.trackOk ? this.tracked.length : 'none'} / reports ${this.forwarder.modeText()}`;
  }
  logIfChanged(): void {
    const s = this.stateLine();
    if (s !== this.loggedState) { this.loggedState = s; this.log(`[copy2] ${s}`); }
  }

  trackedPools(): readonly Copy2Pool[] { return this.tracked; }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.forwarder.setActive(false);
  }
}

function indexOf(list: readonly Copy2Pool[], poolManager: string): Copy2Index {
  const pools = new Set<string>(), ids = new Set<string>(), coins = new Set<string>();
  const poolCoins = new Map<string, string[]>();
  for (const p of list) {
    if (p.kind === 'V4') { if (p.v4Id) ids.add(p.v4Id.toLowerCase()); continue; }
    const a = p.address.toLowerCase();
    pools.add(a);
    const own = [p.token0, p.token1].filter((t) => t !== ZERO_ADDR).map((t) => t.toLowerCase());
    poolCoins.set(a, own);
    for (const t of own) coins.add(t);
  }
  return { pools, ids, poolManager: (poolManager || '').toLowerCase(), coins, poolCoins };
}

function kindCounts(list: readonly Copy2Pool[]): string {
  const n: Record<string, number> = {};
  for (const p of list) n[p.kind] = (n[p.kind] ?? 0) + 1;
  return Object.entries(n).map(([k, v]) => `${k} ${v}`).join(', ');
}
