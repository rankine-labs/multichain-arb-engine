import { ethers } from 'ethers';
import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { STANDARD_V4_TIERS, EXTRA_V4_TIERS } from '../config/v4Tiers';
import { runSteps, Pacer, type Steps } from './chunked';
import type { RawLog } from './universeScan';

// ============================================================================
// UNISWAP V4 POOLS FROM "INITIALIZE" EVENTS (Oct 23, V4_DISCOVER_EVENTS)
//
// Plain English:
//   A Uniswap V4 pool has no address. Until now the bot found a pair's V4
//   pools by GUESSING: it computed the pool id for each of 31 fee / tick
//   spacing settings (config/v4Tiers.ts) and asked V4 whether that pool
//   exists. The Oct 23 missed-gaps study found 59 of 167 hook-free V4 pools
//   on our pairs use OTHER settings (e.g. USDG/microduck 0.78% / spacing 78,
//   ~$25/day of real arbitrage), so the bot never saw them.
//
//   Every V4 pool is born with ONE "Initialize" event on the PoolManager,
//   which lists its full key: coin 0, coin 1, fee, tick spacing, hook. This
//   file reads those events instead of guessing:
//     1. ONE-TIME HISTORY READ: all Initialize events since V4 started, in
//        bounded block ranges on the free node's gentle scan lane (the same
//        lane the chain-wide scan uses for its history reads). The range
//        size adapts: bigger while answers are small, halved when the node
//        refuses or the answer is large. Progress is saved to disk, so a
//        restart carries on where it stopped instead of starting over.
//     2. THEN FOLLOW: once a minute, one log request from the last block read
//        to the newest block (new pools appear a few at a time).
//
//   What is KEPT (memory is bounded on purpose: V4 has ~1 million pools and
//   reading them all into normal objects has run the bot out of memory):
//     - only hook-free pools (pools with hooks are counted and skipped; the
//       hooked pools the bot can read come from config/robinhoodHookedPools.ts
//       and the Fables registry, as before)
//     - only pools the fee list CAN'T find (a setting not in the built-in
//       31-setting list). Pools at a listed setting are already found by
//       guessing, so storing them would only cost memory.
//     - each pool as one 48-byte record in ONE big byte buffer, sorted by
//       coin pair (coin 0, coin 1, fee, spacing), so a pair's pools are found
//       with a binary search. At most V4_DISCOVER_MAX_POOLS records
//       (default 1,500,000 = 72 MB; beyond that new pools are dropped and
//       counted, and the fee-list guessing still works).
//
//   How it's used: the pair watcher (core/pairWatcher.ts) and the chain-wide
//   scan's V4 step (core/v4Lookup.ts) ask v4EventKeysFor(coin A, coin B) and
//   add those pool ids to the ones they already guess. Found pools then go
//   through EXACTLY the same reads and filters as guessed ones (liquidity,
//   depth, coin rules, practice-only rules in config/v4Tiers.ts). The old
//   guessing stays on as the fallback, so nothing is lost if this is off or
//   still reading history.
//
// Settings (.env, optional):
//   V4_DISCOVER_EVENTS=0          off (only the fee-list guessing, old behaviour)
//   V4_DISCOVER_FROM_BLOCK=N      first block of the history read (default 0)
//   V4_DISCOVER_POLL_MS=60000     how often new pools are looked for
//   V4_DISCOVER_MAX_POOLS=1500000 memory cap (records of 48 bytes)
//   V4_DISCOVER_MAX_RANGE=500000  largest block range in one log request
//   V4_DISCOVER_MAX_PER_PAIR=40   at most this many event pools asked about per pair
// ============================================================================

// Initialize(bytes32 indexed id, address indexed currency0, address indexed
// currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)
export const V4_INITIALIZE_TOPIC = ethers.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');

const ZERO_ADDR = '0x' + '0'.repeat(40);

// One Initialize event, decoded. Addresses lowercase; currency0 is the zero
// address for native-ETH pools.
export interface V4InitEvent {
  id: string;               // 32-byte pool id (lowercase hex)
  currency0: string;
  currency1: string;
  fee: number;              // pips (3000 = 0.30%); 0x800000 flag = dynamic fee (hooked pools only)
  tickSpacing: number;
  hooks: string;            // zero address = no hook
  sqrtPriceX96: bigint;     // starting price
  tick: number;
  block: number;
}

// A pool key the pair watcher / scan can ask V4 about (hook-free).
export interface V4EventKey {
  c0: string;               // lowercase; zero address for native ETH
  c1: string;               // lowercase
  fee: number;
  tickSpacing: number;
  native: boolean;          // c0 is native ETH (the bot uses WETH in its place)
}

// ---------------------------------------------------------------------------
// Decoding (pure, unit-tested)
// ---------------------------------------------------------------------------
const isHex = (s: unknown, len: number): s is string => typeof s === 'string' && s.length === len && /^0x[0-9a-fA-F]*$/.test(s);
const topicAddr = (t: string): string | null => {
  // An indexed address is a 32-byte word whose first 12 bytes are zero.
  if (!isHex(t, 66) || !/^0x0{24}/.test(t)) return null;
  return ('0x' + t.slice(26)).toLowerCase();
};

// Decodes one log; returns null for anything that isn't a well-formed
// Initialize event from `poolManager` (when given).
export function decodeV4InitializeLog(l: RawLog, poolManager?: string): V4InitEvent | null {
  if (!l || !Array.isArray(l.topics) || l.topics.length !== 4) return null;
  if ((l.topics[0] ?? '').toLowerCase() !== V4_INITIALIZE_TOPIC) return null;
  if (poolManager && (l.address ?? '').toLowerCase() !== poolManager.toLowerCase()) return null;
  if ((l as { removed?: boolean }).removed) return null; // dropped in a chain reorg
  const id = l.topics[1];
  if (!isHex(id, 66)) return null;
  const c0 = topicAddr(l.topics[2]), c1 = topicAddr(l.topics[3]);
  if (c0 === null || c1 === null) return null;
  const data = typeof l.data === 'string' ? l.data.replace(/^0x/, '') : '';
  if (data.length < 64 * 5 || !/^[0-9a-fA-F]*$/.test(data)) return null;
  const w = (i: number) => BigInt('0x' + data.slice(64 * i, 64 * (i + 1)));
  const feeW = w(0), tsW = w(1), hooksW = w(2), sqrtW = w(3), tickW = w(4);
  if (feeW >= 1n << 24n) return null;                             // uint24
  const tickSpacing = Number(BigInt.asIntN(24, tsW));             // int24 (sign-extended in the word)
  if (hooksW >= 1n << 160n) return null;                          // address
  return {
    id: id.toLowerCase(), currency0: c0, currency1: c1,
    fee: Number(feeW), tickSpacing,
    hooks: '0x' + hooksW.toString(16).padStart(40, '0'),
    sqrtPriceX96: sqrtW & ((1n << 160n) - 1n),
    tick: Number(BigInt.asIntN(24, tickW)),
    block: l.blockNumber ? Number(BigInt(l.blockNumber)) : 0,
  };
}

// The built-in fee list (4 standard + the extra settings seen on real
// pools). Pools at these settings are found by guessing already, so the
// index doesn't store them. Fixed in code (not read from .env), so the saved
// file means the same thing whatever the .env says.
const BUILTIN_TIERS = new Set([...STANDARD_V4_TIERS, ...EXTRA_V4_TIERS].map(([f, t]) => `${f}:${t}`));
export const isBuiltinV4Tier = (fee: number, tickSpacing: number) => BUILTIN_TIERS.has(`${fee}:${tickSpacing}`);

export type SkipReason = 'hooked' | 'listed' | 'invalid';

// Why an Initialize event is not stored (null = store it).
export function skipReason(e: V4InitEvent): SkipReason | null {
  if (e.hooks !== ZERO_ADDR) return 'hooked';
  // Hook-free V4 pools can't have a dynamic fee and must have fee < 100%
  // and spacing 1..32767 (V4's own rules); anything else is not a real pool.
  if (!(e.fee >= 0 && e.fee < 1_000_000) || !(e.tickSpacing >= 1 && e.tickSpacing <= 32767)) return 'invalid';
  if (!(e.currency0 < e.currency1)) return 'invalid';
  if (isBuiltinV4Tier(e.fee, e.tickSpacing)) return 'listed';
  return null;
}

// ---------------------------------------------------------------------------
// The compact pool index
//
// Record (48 bytes): coin0 (20) | coin1 (20) | fee (3, big-endian) |
// tick spacing (3, big-endian) | 2 spare. Sorting the first 46 bytes as raw
// bytes sorts by (coin0, coin1, fee, spacing), so all pools of one pair sit
// next to each other.
// ---------------------------------------------------------------------------
export const V4_RECORD_BYTES = 48;
const PAIR_BYTES = 40;
const KEY_BYTES = 46;

function hexToBuf(addr: string): Buffer { return Buffer.from(addr.replace(/^0x/, '').padStart(40, '0'), 'hex'); }

export function encodeV4Record(c0: string, c1: string, fee: number, tickSpacing: number): Buffer {
  const b = Buffer.alloc(V4_RECORD_BYTES);
  hexToBuf(c0).copy(b, 0);
  hexToBuf(c1).copy(b, 20);
  b.writeUIntBE(fee, 40, 3);
  b.writeUIntBE(tickSpacing, 43, 3);
  return b;
}

function decodeRecord(buf: Buffer, off: number): V4EventKey {
  const c0 = '0x' + buf.toString('hex', off, off + 20);
  return {
    c0, c1: '0x' + buf.toString('hex', off + 20, off + 40),
    fee: buf.readUIntBE(off + 40, 3), tickSpacing: buf.readUIntBE(off + 43, 3),
    native: c0 === ZERO_ADDR,
  };
}

export interface V4PoolIndexStats { stored: number; pending: number; dropped: number }

export class V4PoolIndex {
  private main: Buffer = Buffer.alloc(0);   // sorted, no duplicates
  private n = 0;                            // records in `main`
  // New records not merged into `main` yet, by pair (80 hex chars). Small:
  // merged once it holds `mergeAt` records (and before every save).
  private pending = new Map<string, Buffer[]>();
  private pendingN = 0;
  // Records being merged right now (still visible to lookups meanwhile).
  private merging: Map<string, Buffer[]> | null = null;
  private mergingN = 0;
  private mergeBusy: Promise<void> | null = null;
  dropped = 0;                              // records refused by the memory cap

  constructor(readonly maxPools = 1_500_000, readonly mergeAt = 20_000) {}

  size(): number { return this.n + this.pendingN + this.mergingN; }
  stats(): V4PoolIndexStats { return { stored: this.n, pending: this.pendingN, dropped: this.dropped }; }
  needsMerge(): boolean { return this.pendingN >= this.mergeAt; }

  // Adds one hook-free pool key. Returns false when refused (memory cap).
  add(c0: string, c1: string, fee: number, tickSpacing: number): boolean {
    if (this.size() >= this.maxPools) { this.dropped++; return false; }
    const rec = encodeV4Record(c0, c1, fee, tickSpacing);
    const k = rec.toString('hex', 0, PAIR_BYTES);
    const list = this.pending.get(k);
    // The same pool twice (a block range read again after a restart): keep one.
    if (list?.some((r) => r.compare(rec, 0, KEY_BYTES, 0, KEY_BYTES) === 0)) return true;
    if (list) list.push(rec); else this.pending.set(k, [rec]);
    this.pendingN++;
    return true;
  }

  // Every stored pool for the exact (c0, c1) key (both lowercase, c0 < c1 as
  // raw addresses; c0 = zero address for native ETH). At most `max`.
  keysForPair(c0: string, c1: string, max = Infinity): V4EventKey[] {
    const out: V4EventKey[] = [];
    const target = Buffer.concat([hexToBuf(c0), hexToBuf(c1)]);
    // Binary search for the first record of this pair.
    let lo = 0, hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.main.compare(target, 0, PAIR_BYTES, mid * V4_RECORD_BYTES, mid * V4_RECORD_BYTES + PAIR_BYTES) < 0) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < this.n && out.length < max; i++) {
      const off = i * V4_RECORD_BYTES;
      if (this.main.compare(target, 0, PAIR_BYTES, off, off + PAIR_BYTES) !== 0) break;
      out.push(decodeRecord(this.main, off));
    }
    const k = target.toString('hex');
    for (const m of [this.merging, this.pending]) for (const r of m?.get(k) ?? []) {
      if (out.length >= max) break;
      const key = decodeRecord(r, 0);
      if (!out.some((o) => o.fee === key.fee && o.tickSpacing === key.tickSpacing)) out.push(key);
    }
    return out;
  }

  // Moves the pending records into the sorted buffer, in ~5 ms bites (the
  // bot runs on one thread; a 1-million-record copy in one go would freeze it).
  async merge(sliceMs = 5): Promise<void> {
    while (this.mergeBusy) await this.mergeBusy;
    if (!this.pendingN) return;
    this.merging = this.pending;
    this.mergingN = this.pendingN;
    this.pending = new Map();
    this.pendingN = 0;
    const job = mergeSteps(this.main, this.n, this.merging);
    // The "busy" marker is cleared only if it is still THIS merge's marker
    // (with no breaks the work can finish before the marker is even set).
    const run: Promise<void> = (async () => {
      try {
        const { buf, n } = sliceMs > 0 ? await runSteps(job, 'v4 index merge', sliceMs) : drain(job);
        this.main = buf; this.n = n;
      } finally {
        this.merging = null;
        this.mergingN = 0;
      }
    })();
    this.mergeBusy = run;
    try { await run; } finally { if (this.mergeBusy === run) this.mergeBusy = null; }
  }

  // The sorted buffer (only after merge()) and loading it back.
  snapshot(): { buf: Buffer; n: number } { return { buf: this.main.subarray(0, this.n * V4_RECORD_BYTES), n: this.n }; }

  // Loads a saved buffer. It must be strictly sorted (which also proves there
  // are no duplicates); checked neighbour by neighbour with short breaks, so
  // a big file never freezes the bot. A damaged file is refused (the
  // history is then read again). Returns false when refused.
  async restore(buf: Buffer, sliceMs = 5): Promise<boolean> {
    if (buf.length % V4_RECORD_BYTES !== 0) return false;
    const n = buf.length / V4_RECORD_BYTES;
    if (n > this.maxPools) return false;
    const pacer = new Pacer('v4 index load', sliceMs || 5, sliceMs > 0);
    for (let i = 1; i < n; i++) {
      if (pacer.due()) await pacer.rest();
      const a = (i - 1) * V4_RECORD_BYTES, b = i * V4_RECORD_BYTES;
      if (buf.compare(buf, a, a + KEY_BYTES, b, b + KEY_BYTES) <= 0) return false;
    }
    this.main = buf; this.n = n;
    this.pending = new Map(); this.pendingN = 0;
    return true;
  }

  // Number of distinct coin pairs in the sorted buffer (merged records only).
  pairCount(): number {
    let pairs = 0;
    for (let i = 0; i < this.n; i++) {
      const a = (i - 1) * V4_RECORD_BYTES, b = i * V4_RECORD_BYTES;
      if (i === 0 || this.main.compare(this.main, a, a + PAIR_BYTES, b, b + PAIR_BYTES) !== 0) pairs++;
    }
    return pairs;
  }
}

function drain<T>(job: Steps<T>): T { for (;;) { const r = job.next(); if (r.done) return r.value; } }

// Merge of a sorted buffer and a batch of new records (sorted here), into a
// new buffer, dropping duplicates. Written as steps (core/chunked.ts).
function* mergeSteps(main: Buffer, n: number, add: Map<string, Buffer[]>): Steps<{ buf: Buffer; n: number }> {
  const recs: Buffer[] = [];
  for (const list of add.values()) for (const r of list) recs.push(r);
  recs.sort((a, b) => a.compare(b, 0, KEY_BYTES, 0, KEY_BYTES));
  yield;
  const out = Buffer.allocUnsafe((n + recs.length) * V4_RECORD_BYTES);
  let i = 0, j = 0, k = 0, since = 0;
  const lastEq = (src: Buffer, off: number) => k > 0 && out.compare(src, off, off + KEY_BYTES, (k - 1) * V4_RECORD_BYTES, (k - 1) * V4_RECORD_BYTES + KEY_BYTES) === 0;
  while (i < n || j < recs.length) {
    let src: Buffer, off: number;
    if (j >= recs.length || (i < n && main.compare(recs[j], 0, KEY_BYTES, i * V4_RECORD_BYTES, i * V4_RECORD_BYTES + KEY_BYTES) <= 0)) { src = main; off = i++ * V4_RECORD_BYTES; }
    else { src = recs[j++]; off = 0; }
    if (!lastEq(src, off)) { src.copy(out, k * V4_RECORD_BYTES, off, off + V4_RECORD_BYTES); out.fill(0, k * V4_RECORD_BYTES + KEY_BYTES, (k + 1) * V4_RECORD_BYTES); k++; }
    if (++since >= 4096) { since = 0; yield; }
  }
  // Copy into an exactly-sized buffer only when duplicates left slack.
  return { buf: k === n + recs.length ? out : Buffer.from(out.subarray(0, k * V4_RECORD_BYTES)), n: k };
}

// ---------------------------------------------------------------------------
// Process-wide access (like setHookedFeeSource in the pair watcher): the
// pair watcher and the scan ask this, so neither needs new constructor
// arguments. No index set (feature off / not started) = no extra pools.
// ---------------------------------------------------------------------------
let activeIndex: V4PoolIndex | null = null;
let maxPerPair = Number(process.env.V4_DISCOVER_MAX_PER_PAIR ?? 40);
export function setV4EventIndex(idx: V4PoolIndex | null, perPair?: number): void {
  activeIndex = idx;
  if (perPair !== undefined && perPair > 0) maxPerPair = perPair;
}
export const getV4EventIndex = () => activeIndex;

// Hook-free V4 pools found from events for the pair (a, b), including the
// native-ETH versions when one side is WETH. Empty when the feature is off.
export function v4EventKeysFor(a: string, b: string, weth: string): V4EventKey[] {
  const idx = activeIndex;
  if (!idx) return [];
  const x = a.toLowerCase(), y = b.toLowerCase(), w = weth.toLowerCase();
  if (x === y) return [];
  const out = idx.keysForPair(x < y ? x : y, x < y ? y : x, maxPerPair);
  if (x === w || y === w) out.push(...idx.keysForPair(ZERO_ADDR, x === w ? y : x, Math.max(0, maxPerPair - out.length)));
  return out;
}

// ---------------------------------------------------------------------------
// The reader: history first, then new blocks
// ---------------------------------------------------------------------------
export interface V4EventDiscoveryOptions {
  poolManager: string;
  // ONE eth_getLogs request: address = PoolManager, topic0 = Initialize,
  // over [from, to]. Must THROW on refusal / timeout (the range is then
  // halved) and on rate limits (waited out, same range again).
  getLogs: (from: number, to: number) => Promise<RawLog[]>;
  latestBlock: () => Promise<number>;
  file: string;                 // progress + metadata (JSON); the records go to `file`.bin
  index?: V4PoolIndex;
  fromBlock?: number;           // first block of the history read (default 0)
  minRange?: number;            // smallest block range (default 50: busy stretches can hold many pool creations)
  maxRange?: number;            // largest block range (default 500,000)
  startRange?: number;          // first range tried (default 50,000)
  targetLogs?: number;          // aim for about this many events per request (default 3,000)
  pauseMs?: number;             // pause between requests (default 250)
  saveEveryMs?: number;         // save progress at most this often (default 60 s)
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
  sliceMs?: number;             // 0 = no breaks (tests)
}

export interface V4DiscoveryCounts {
  events: number;               // Initialize events read (all)
  stored: number;               // added to the index
  hooked: number;               // skipped: pool has a hook
  listed: number;               // skipped: setting is on the fee list (found by guessing)
  invalid: number;              // skipped: malformed
  requests: number;             // log requests sent (this run)
  errors: number;               // failed requests (this run)
}

interface SavedMeta {
  version: 1;
  poolManager: string;
  fromBlock: number;
  nextBlock: number;            // first block NOT read yet
  backfillTo: number;           // newest block when the history read started (history done when nextBlock > backfillTo)
  backfillDone: boolean;
  records: number;              // records in the .bin file
  counts: Omit<V4DiscoveryCounts, 'requests' | 'errors'>;
  savedAt: number;
}

const isSlowDown = (err: unknown) => /429|too many requests|rate.?limit|exceeded|allowance|try again shortly|budget/i.test(String((err as Error)?.message ?? err));

export class V4EventDiscovery {
  readonly index: V4PoolIndex;
  private nextBlock: number;
  private backfillTo = -1;
  private backfillDone = false;
  private range: number;
  private busy = false;
  private lastSaveAt = 0;
  private loaded = false;
  private newSinceStart = 0;            // pools stored after the history read finished
  private slowDownsInRow = 0;
  private lastError = '';
  readonly counts: V4DiscoveryCounts = { events: 0, stored: 0, hooked: 0, listed: 0, invalid: 0, requests: 0, errors: 0 };
  private readonly o: Required<Omit<V4EventDiscoveryOptions, 'index'>>;

  constructor(opts: V4EventDiscoveryOptions) {
    this.o = {
      fromBlock: 0, minRange: 50, maxRange: 500_000, startRange: 50_000, targetLogs: 3_000, pauseMs: 250, saveEveryMs: 60_000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now, log: (m) => console.log(m), sliceMs: 5,
      ...opts,
      poolManager: opts.poolManager.toLowerCase(),
    } as Required<Omit<V4EventDiscoveryOptions, 'index'>>;
    this.index = opts.index ?? new V4PoolIndex();
    this.nextBlock = this.o.fromBlock;
    this.range = Math.min(this.o.maxRange, Math.max(this.o.minRange, this.o.startRange));
  }

  isBackfillDone() { return this.backfillDone; }
  progress(): { next: number; to: number; pct: number } {
    const span = Math.max(1, this.backfillTo - this.o.fromBlock + 1);
    const pct = this.backfillDone ? 100 : this.backfillTo < 0 ? 0 : Math.min(100, ((this.nextBlock - this.o.fromBlock) / span) * 100);
    return { next: this.nextBlock, to: this.backfillTo, pct };
  }

  // Reads the saved progress and records. A missing or damaged file (or one
  // made for a different PoolManager / start block) = start from scratch.
  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const meta = JSON.parse(await readFile(this.o.file, 'utf8')) as SavedMeta;
      if (meta?.version !== 1 || meta.poolManager !== this.o.poolManager || meta.fromBlock !== this.o.fromBlock) throw new Error('different settings');
      const bin = meta.records > 0 ? await readFile(this.o.file + '.bin') : Buffer.alloc(0);
      if (bin.length !== meta.records * V4_RECORD_BYTES || !(await this.index.restore(bin, this.o.sliceMs))) throw new Error('records file damaged');
      this.nextBlock = meta.nextBlock;
      this.backfillTo = meta.backfillTo;
      this.backfillDone = meta.backfillDone;
      Object.assign(this.counts, meta.counts);
      this.o.log(`[v4events] loaded ${meta.records.toLocaleString('en-US')} saved V4 pools; ${this.backfillDone ? 'history read done' : `history read ${this.progress().pct.toFixed(1)}% done, carrying on`} from block ${this.nextBlock}`);
    } catch (err) {
      const why = String((err as Error)?.message ?? err);
      if (!/ENOENT/.test(why)) this.o.log(`[v4events] saved V4 pool list not used (${why.slice(0, 80)}); reading the history again`);
    } finally {
      this.loaded = true; // only now may save() write (it would otherwise overwrite the file being read)
    }
  }

  // Saves the progress (records first, then the progress file, each written
  // to a temp file and renamed, so a crash never leaves a half file; a crash
  // between the two only means some blocks are read again, and duplicates
  // are dropped).
  async save(): Promise<void> {
    // Never before the saved list was read back: an empty save would wipe it.
    if (!this.loaded) return;
    await this.index.merge(this.o.sliceMs);
    const { buf, n } = this.index.snapshot();
    const meta: SavedMeta = {
      version: 1, poolManager: this.o.poolManager, fromBlock: this.o.fromBlock,
      nextBlock: this.nextBlock, backfillTo: this.backfillTo, backfillDone: this.backfillDone, records: n,
      counts: { events: this.counts.events, stored: this.counts.stored, hooked: this.counts.hooked, listed: this.counts.listed, invalid: this.counts.invalid },
      savedAt: this.o.now(),
    };
    try {
      await mkdir(dirname(this.o.file), { recursive: true });
      await writeFile(this.o.file + '.bin.tmp', buf);
      await rename(this.o.file + '.bin.tmp', this.o.file + '.bin');
      await writeFile(this.o.file + '.tmp', JSON.stringify(meta));
      await rename(this.o.file + '.tmp', this.o.file);
      this.lastSaveAt = this.o.now();
    } catch (err) {
      this.o.log(`[v4events] save failed (will retry): ${String((err as Error)?.message ?? err).slice(0, 100)}`);
    }
  }

  // Takes events (from any source: the history read, the minute poll, or a
  // block reader that already has them) and stores the new hook-free pools.
  async ingest(logs: RawLog[]): Promise<number> {
    let added = 0;
    const pacer = new Pacer('v4 event decode', this.o.sliceMs || 5, this.o.sliceMs > 0);
    for (const l of logs) {
      if (pacer.due()) await pacer.rest();
      const e = decodeV4InitializeLog(l, this.o.poolManager);
      if (!e) continue;
      this.counts.events++;
      const why = skipReason(e);
      if (why) { this.counts[why]++; continue; }
      if (this.index.add(e.currency0, e.currency1, e.fee, e.tickSpacing)) { this.counts.stored++; added++; }
    }
    if (this.index.needsMerge()) await this.index.merge(this.o.sliceMs);
    return added;
  }

  // One round: read from the next unread block to the newest block, in
  // adaptive ranges. The first round after a fresh start is the history
  // read (can take a while; it saves as it goes). Returns false when the
  // node kept refusing (the next round carries on from the same block).
  async poll(): Promise<boolean> {
    if (this.busy) return true;
    this.busy = true;
    try {
      if (!this.loaded) await this.load();
      const head = await this.o.latestBlock();
      if (this.backfillTo < 0) {
        this.backfillTo = head;
        this.o.log(`[v4events] reading every Uniswap V4 pool creation from block ${this.nextBlock} to ${head} (one time; saved as it goes)`);
      }
      let failsAtMin = 0;                 // failures at the smallest range, in a row
      while (this.nextBlock <= head) {
        const from = this.nextBlock;
        const to = Math.min(head, from + this.range - 1);
        let logs: RawLog[];
        try {
          this.counts.requests++;
          logs = await this.o.getLogs(from, to);
          failsAtMin = 0;
          this.slowDownsInRow = 0;
        } catch (err) {
          this.counts.errors++;
          this.lastError = String((err as Error)?.message ?? err).slice(0, 120);
          if (isSlowDown(err)) {
            // "Slow down" is not "range too big": wait, then the same range.
            if (++this.slowDownsInRow > 6) { this.o.log(`[v4events] node keeps saying slow down; pausing until the next round (${this.lastError})`); return false; }
            await this.o.sleep(2_000 * this.slowDownsInRow);
            continue;
          }
          // Refused / timed out / too many results: halve the range (the
          // usual answer to a range that is too big), down to minRange.
          if (this.range > this.o.minRange) { this.range = Math.max(this.o.minRange, Math.floor(this.range / 2)); continue; }
          // Already at the smallest range: a few slow retries, then give up
          // until the next round (which starts from this same block).
          if (++failsAtMin >= 4) { this.o.log(`[v4events] log read failed at block ${from} (${this.lastError}); will retry next round`); return false; }
          await this.o.sleep(1_000 * failsAtMin);
          continue;
        }
        const added = await this.ingest(logs);
        if (this.backfillDone) this.newSinceStart += added;
        this.nextBlock = to + 1;
        // Adapt: aim for ~targetLogs events per request.
        if (logs.length > this.o.targetLogs) this.range = Math.max(this.o.minRange, Math.floor(this.range / 2));
        else if (logs.length < this.o.targetLogs / 4) this.range = Math.min(this.o.maxRange, this.range * 2);
        if (!this.backfillDone && this.nextBlock > this.backfillTo) {
          this.backfillDone = true;
          await this.index.merge(this.o.sliceMs);
          this.o.log(`[v4events] history read done: ${this.counts.events.toLocaleString('en-US')} V4 pools created so far; kept ${this.index.size().toLocaleString('en-US')} hook-free ones at settings the fee list can't find (${this.counts.listed.toLocaleString('en-US')} at listed settings, ${this.counts.hooked.toLocaleString('en-US')} with hooks skipped) in ${this.counts.requests} requests`);
          await this.save();
        } else if (this.o.now() - this.lastSaveAt >= this.o.saveEveryMs) {
          await this.save();
        }
        if (this.nextBlock <= head && this.o.pauseMs > 0) await this.o.sleep(this.o.pauseMs);
      }
      return true;
    } catch (err) {
      this.counts.errors++;
      this.lastError = String((err as Error)?.message ?? err).slice(0, 120);
      this.o.log(`[v4events] round failed, will retry: ${this.lastError}`);
      return false;
    } finally {
      this.busy = false;
    }
  }

  // One status-page line. `watched` = V4 pools in the watch list by how they
  // were found (from countWatchedV4BySource), when the caller has them.
  statusLine(watched?: { tiers: number; events: number }): string {
    const p = this.progress();
    const hist = this.backfillDone ? 'history read done' : `history read ${p.pct.toFixed(1)}% (block ${p.next.toLocaleString('en-US')} of ${p.to.toLocaleString('en-US')})`;
    const st = this.index.stats();
    const w = watched ? `; watched V4 pools: ${watched.tiers} found by fee list, ${watched.events} found by events` : '';
    return `[v4events] ${this.index.size().toLocaleString('en-US')} extra V4 pools known (settings not on the fee list); ${hist}; ${this.newSinceStart} new since; skipped ${this.counts.hooked.toLocaleString('en-US')} hooked, ${this.counts.listed.toLocaleString('en-US')} on the fee list${st.dropped ? `, ${st.dropped} over the memory cap` : ''}; ${this.counts.requests} requests, ${this.counts.errors} errors${this.counts.errors && this.lastError ? ` (last: ${this.lastError.slice(0, 60)})` : ''}${w}`;
  }
}

// How the V4 pools in the watch list were found: hook-free pools at a
// setting on the fee list (V4_LOOKUP_TIERS, passed in) were found by
// guessing; hook-free pools at any other setting can only have come from the
// event index. Hooked pools are not counted (they come from fixed lists).
export function countWatchedV4BySource(pools: Iterable<{ v4?: { fee: number; tickSpacing: number; hooks?: string } }>, lookupTiers: readonly (readonly [number, number])[]): { tiers: number; events: number } {
  const listed = new Set(lookupTiers.map(([f, t]) => `${f}:${t}`));
  let tiers = 0, events = 0;
  for (const p of pools) {
    const v = p.v4;
    if (!v || (v.hooks && !/^0x0{40}$/i.test(v.hooks))) continue;
    if (listed.has(`${v.fee}:${v.tickSpacing}`)) tiers++; else events++;
  }
  return { tiers, events };
}

// Reads the .env switches (V4_DISCOVER_*). Exported for the tests.
export function v4DiscoverConfig(env: Record<string, string | undefined> = process.env) {
  const num = (k: string, d: number) => { const v = Number(env[k]); return env[k] !== undefined && env[k] !== '' && Number.isFinite(v) && v >= 0 ? v : d; };
  return {
    enabled: env.V4_DISCOVER_EVENTS !== '0' && env.V4_DISCOVER_EVENTS !== 'off',
    fromBlock: num('V4_DISCOVER_FROM_BLOCK', 0),
    pollMs: Math.max(10_000, num('V4_DISCOVER_POLL_MS', 60_000)),
    maxPools: Math.max(1_000, num('V4_DISCOVER_MAX_POOLS', 1_500_000)),
    maxRange: Math.max(500, num('V4_DISCOVER_MAX_RANGE', 500_000)),
    maxPerPair: Math.max(1, num('V4_DISCOVER_MAX_PER_PAIR', 40)),
  };
}

// The one log request the reader needs, on any JSON-RPC sender (the bot
// passes its gentle scan lane on the free node). Only the PoolManager's
// Initialize events are asked for, so answers stay small. A hard timeout
// turns a hung request into an error (the range is then halved).
export function makeV4InitGetLogs(send: (method: string, params: unknown[]) => Promise<unknown>, poolManager: string, timeoutMs = 30_000): (from: number, to: number) => Promise<RawLog[]> {
  const toHex = (n: number) => '0x' + n.toString(16);
  return async (from, to) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('getLogs timeout')), timeoutMs); });
    try {
      const r = await Promise.race([send('eth_getLogs', [{ address: poolManager, topics: [V4_INITIALIZE_TOPIC], fromBlock: toHex(from), toBlock: toHex(to) }]), timeout]);
      if (!Array.isArray(r)) throw new Error('eth_getLogs returned no list');
      return r as RawLog[];
    } finally { if (timer) clearTimeout(timer); }
  };
}
