import { ethers } from 'ethers';

// ============================================================================
// BLOCK READER -- read every new block's pool events straight from the node.
//
// Plain English:
//   The bot reacts instantly only to trades it can decode from the sequencer
//   feed (known routers, about half of all trades). Every other trade used to
//   be noticed only by the slower 5 s refresh. Robinhood Chain makes a new
//   block roughly every 0.11 s, so 5 s is ages.
//
//   This reader asks the node, about every 0.11 s, "did any of the pools I
//   watch emit a trade or reserve event since the last block I read?" Those
//   events carry the EXACT state of the pool right after the trade:
//     - V2 style pools (and Solidly copies) emit Sync with both reserves
//     - V3 style pools (Uniswap V3, Slipstream, Algebra, PancakeSwap V3)
//       emit Swap with the new price, liquidity and tick
//     - Uniswap V4 pools all live inside one PoolManager contract, which
//       emits Swap with the pool id plus the new price, liquidity and tick
//   For each pool we keep only its newest event and hand the batch to the
//   bot, which writes that state into its pool cache and re-checks gaps.
//
// Safety:
//   - Read only. Never sends a transaction.
//   - If the node complains we are asking too often (HTTP 429), we pause
//     1 s; any other error pauses 0.5 s; 20 errors in a row pauses 30 s.
//   - If we ever fall far behind (more than maxRange blocks), we jump ahead
//     to recent blocks instead of asking for a huge range, and count it.
// ============================================================================

// A function that sends one request to the node and returns its answer.
export type RpcFn = (method: string, params: unknown[]) => Promise<any>;

// One event ("log") as the node returns it.
export interface RpcLog { address: string; topics: string[]; data: string; blockNumber: string; logIndex: string; transactionIndex?: string; transactionHash?: string; removed?: boolean }

// Exact pool state carried by one event.
export interface PoolUpdate {
  pool: string;          // lowercase pool address, or lowercase 32-byte V4 pool id (from PoolManager Swap topic1)
  kind: 'v2' | 'v3' | 'v4';
  block: number;
  logIndex: number;
  reserve0?: bigint;     // v2 (from Sync)
  reserve1?: bigint;
  sqrtPriceX96?: bigint; // v3/v4 (from Swap)
  liquidity?: bigint;
  tick?: number;
}

// ---------------------------------------------------------------------------
// Event fingerprints ("topics"). Each event type is identified by the hash of
// its name and field types; that hash is the first topic of every log.
// ---------------------------------------------------------------------------

// V2 / Solidly reserve update: Sync(reserve0, reserve1).
export const SYNC_TOPIC = ethers.id('Sync(uint112,uint112)');
// Uniswap V3 / Slipstream / Algebra-compatible Swap.
export const V3_SWAP_TOPIC = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
// PancakeSwap V3 Swap (adds two protocol fee fields at the end).
export const PANCAKE_V3_SWAP_TOPIC = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)');
// Algebra Integral Swap (adds overrideFee and pluginFee at the end).
export const ALGEBRA_INTEGRAL_SWAP_TOPIC = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24,uint24,uint24)');
// Uniswap V4 PoolManager Swap (pool id is the first indexed field).
export const V4_SWAP_TOPIC = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');

// Every topic we ask the node for, in one list (the node ORs them).
export const HANDLED_TOPICS: string[] = [SYNC_TOPIC, V3_SWAP_TOPIC, PANCAKE_V3_SWAP_TOPIC, ALGEBRA_INTEGRAL_SWAP_TOPIC, V4_SWAP_TOPIC];

// The three V3 flavours share the same first five data fields, so they are
// decoded the same way.
const V3_LIKE = new Set([V3_SWAP_TOPIC, PANCAKE_V3_SWAP_TOPIC, ALGEBRA_INTEGRAL_SWAP_TOPIC]);

// ---------------------------------------------------------------------------
// Small decoding helpers. Event data is a string of 32-byte "words" in hex.
// ---------------------------------------------------------------------------

// Split the hex data into 32-byte words. Returns null if the data is malformed.
function words(data: string): string[] | null {
  if (typeof data !== 'string' || !data.startsWith('0x')) return null;
  const hex = data.slice(2);
  if (hex.length % 64 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out: string[] = [];
  for (let i = 0; i < hex.length; i += 64) out.push(hex.slice(i, i + 64));
  return out;
}

// Read a word as a positive whole number.
const asUint = (w: string): bigint => BigInt('0x' + w);
// Read a word as a signed number (the tick can be negative). The node pads
// negative numbers with leading "f"s to the full 32 bytes, so reading it as a
// 256-bit signed number gives the right answer.
const asInt = (w: string): bigint => BigInt.asIntN(256, BigInt('0x' + w));

// Read a block number or log index, which the node sends as hex text.
function toNum(v: string | undefined): number | null {
  if (v === undefined || v === null) return null;
  try {
    const n = Number(BigInt(v));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// parsePoolLogs: turn raw logs into exact pool states.
// Ignores logs the node marked "removed" (a block that got replaced), logs we
// don't recognise, malformed logs, and V4 swaps that did not come from the
// real PoolManager.
// ---------------------------------------------------------------------------
export function parsePoolLogs(logs: RpcLog[], poolManager: string): PoolUpdate[] {
  const pm = (poolManager || '').toLowerCase();
  const out: PoolUpdate[] = [];
  for (const l of logs ?? []) {
    if (!l || l.removed) continue;
    const t0 = l.topics?.[0]?.toLowerCase();
    if (!t0) continue;
    const block = toNum(l.blockNumber);
    const logIndex = toNum(l.logIndex);
    if (block === null || logIndex === null) continue;   // pending logs have no block yet
    const w = words(l.data);
    if (!w) continue;
    const address = (l.address || '').toLowerCase();

    if (t0 === SYNC_TOPIC) {
      // V2 / Solidly: data = reserve0, reserve1.
      if (w.length < 2) continue;
      out.push({ pool: address, kind: 'v2', block, logIndex, reserve0: asUint(w[0]!), reserve1: asUint(w[1]!) });
    } else if (V3_LIKE.has(t0)) {
      // V3 family: data = amount0, amount1, sqrtPriceX96, liquidity, tick, ...
      if (w.length < 5) continue;
      out.push({ pool: address, kind: 'v3', block, logIndex, sqrtPriceX96: asUint(w[2]!), liquidity: asUint(w[3]!), tick: Number(asInt(w[4]!)) });
    } else if (t0 === V4_SWAP_TOPIC) {
      // V4: only trust it if it came from the real PoolManager. The pool id
      // is topic 1; data = amount0, amount1, sqrtPriceX96, liquidity, tick, fee.
      if (!pm || address !== pm) continue;
      const id = l.topics[1]?.toLowerCase();
      if (!id || w.length < 5) continue;
      out.push({ pool: id, kind: 'v4', block, logIndex, sqrtPriceX96: asUint(w[2]!), liquidity: asUint(w[3]!), tick: Number(asInt(w[4]!)) });
    }
    // Anything else (including V2 Swap events, which carry no reserves) is ignored.
  }
  return out;
}

// ---------------------------------------------------------------------------
// latestPerPool: keep only the newest update for each pool (highest block,
// then highest position inside that block).
// ---------------------------------------------------------------------------
export function latestPerPool(updates: PoolUpdate[]): Map<string, PoolUpdate> {
  const m = new Map<string, PoolUpdate>();
  for (const u of updates) {
    const cur = m.get(u.pool);
    if (!cur || u.block > cur.block || (u.block === cur.block && u.logIndex > cur.logIndex)) m.set(u.pool, u);
  }
  return m;
}

// ---------------------------------------------------------------------------
// The polling loop.
// ---------------------------------------------------------------------------
export interface BlockReaderOptions {
  rpc: RpcFn;
  poolManager: string;
  addresses: () => string[];        // pool contract addresses to watch (lowercase); V4 pools are matched via poolManager + topic1
  v4Ids: () => Set<string>;         // V4 pool ids we watch (lowercase)
  onUpdates: (latest: Map<string, PoolUpdate>, toBlock: number) => void;
  pollMs?: number;                  // default 110
  headEveryMs?: number;             // eth_blockNumber refresh, default 2000
  maxRange?: number;                // max blocks per eth_getLogs (default 200); if behind more, jump to head - maxRange and count a skip
  now?: () => number;
}

// Pauses after errors (milliseconds).
const RATE_LIMIT_PAUSE_MS = 1000;
const ERROR_PAUSE_MS = 500;
const LONG_PAUSE_MS = 30_000;
const LONG_PAUSE_AFTER = 20;        // errors in a row before the long pause
const TIMING_SAMPLES = 200;         // how many recent request timings to keep for the median

// Does this error mean "you are asking too often"?
function isRateLimit(err: any): boolean {
  const msg = String(err?.message ?? err ?? '');
  const code = err?.code ?? err?.status ?? err?.error?.code;
  return /429|rate.?limit|too many requests/i.test(msg) || code === 429 || code === -32005;
}

// Does this error just mean "there is no new block yet"? Some nodes refuse a
// request whose start block is past the newest block instead of answering
// with an empty list. That is normal at our speed, not a failure.
function isAheadOfHead(err: any): boolean {
  const msg = String(err?.message ?? err ?? '');
  return /invalid block range|fromblock.*(greater|after|beyond)|block range.*(invalid|beyond)|beyond current head/i.test(msg);
}

export class BlockReader {
  private readonly o: BlockReaderOptions;
  private readonly pollMs: number;
  private readonly headEveryMs: number;
  private readonly maxRange: number;
  private readonly now: () => number;

  private last = -1;                 // last block fully read (-1 = not started yet)
  private head = -1;                 // newest block the node told us about
  private headAt = -Infinity;        // when we last asked for the newest block
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private delayMs: number;           // wait before the next poll
  private errorsInRow = 0;
  private timings: number[] = [];    // recent eth_getLogs durations (ms)
  private counts = { polls: 0, ok: 0, errors: 0, rateLimited: 0, updates: 0, skippedRanges: 0 };

  constructor(o: BlockReaderOptions) {
    this.o = o;
    this.pollMs = o.pollMs ?? 110;
    this.headEveryMs = o.headEveryMs ?? 2000;
    this.maxRange = Math.max(1, o.maxRange ?? 200);
    this.now = o.now ?? (() => Date.now());
    this.delayMs = this.pollMs;
  }

  // Start the loop. Each poll waits for the previous one to finish, so
  // requests never pile up.
  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try { await this.pollOnce(); } catch (e) { /* pollOnce never throws, this is a last safety net */ }
      if (!this.running) return;
      this.timer = setTimeout(tick, this.delayMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  // Stop the loop. A poll already in flight finishes but schedules nothing.
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // How long the loop will wait before the next poll (reflects any error pause).
  nextDelayMs(): number {
    return this.delayMs;
  }

  // One poll. Never throws: errors are counted and set a pause instead.
  async pollOnce(): Promise<void> {
    this.counts.polls++;
    try {
      // 1. Refresh the newest block number every headEveryMs (and on the first poll).
      const t = this.now();
      if (this.head < 0 || t - this.headAt >= this.headEveryMs) {
        const h = toNum(await this.o.rpc('eth_blockNumber', []));
        if (h === null) throw new Error('eth_blockNumber returned an unreadable value');
        this.head = Math.max(this.head, h);
        this.headAt = t;
      }

      // 2. First poll: start reading at the current newest block (no history).
      if (this.last < 0) this.last = this.head - 1;

      // 3. Too far behind? Jump ahead instead of requesting a giant range.
      if (this.head - this.last > this.maxRange) {
        this.last = this.head - this.maxRange;
        this.counts.skippedRanges++;
      }

      // 4. Which contracts to ask about: our pools plus the V4 PoolManager.
      const pm = (this.o.poolManager || '').toLowerCase();
      const addrSet = new Set<string>();
      for (const a of this.o.addresses() ?? []) if (a) addrSet.add(a.toLowerCase());
      if (pm) addrSet.add(pm);
      if (addrSet.size === 0) {
        // Nothing to watch. Never send an address-less request (it would
        // return every event on the chain).
        this.succeed();
        return;
      }

      // 5. Ask for all handled events since the last block we read.
      const headBefore = this.head;
      const started = this.now();
      let logs: RpcLog[];
      try {
        const r = await this.o.rpc('eth_getLogs', [{
          fromBlock: '0x' + (this.last + 1).toString(16),
          toBlock: 'latest',
          address: [...addrSet],
          topics: [HANDLED_TOPICS],
        }]);
        logs = Array.isArray(r) ? r : [];
      } catch (e) {
        if (!isAheadOfHead(e)) throw e;
        logs = [];   // no new block yet, nothing to read
      }
      this.recordTiming(this.now() - started);

      // 6. V4 swaps arrive for every pool in the PoolManager; keep only ours.
      const ids = this.o.v4Ids() ?? new Set<string>();
      const kept = logs.filter((l) => {
        if (!l || l.topics?.[0]?.toLowerCase() !== V4_SWAP_TOPIC) return true;
        if ((l.address || '').toLowerCase() !== pm) return true;   // parse step rejects it anyway
        const id = l.topics[1]?.toLowerCase();
        return !!id && ids.has(id);
      });

      // 7. Move our bookmark forward: to the newest block seen in the logs,
      //    and to the head we knew before asking (the request covered it).
      let maxSeen = this.last;
      for (const l of logs) {
        if (l?.removed) continue;
        const b = toNum(l?.blockNumber);
        if (b !== null && b > maxSeen) maxSeen = b;
      }
      this.last = Math.max(this.last, maxSeen, headBefore);
      if (this.last > this.head) this.head = this.last;

      // 8. Decode, keep the newest state per pool, hand it to the bot.
      const latest = latestPerPool(parsePoolLogs(kept, pm));
      this.succeed();
      if (latest.size > 0) {
        this.counts.updates += latest.size;
        try {
          this.o.onUpdates(latest, this.last);
        } catch (e: any) {
          // A bug in the receiver must not stop the reader.
          console.error(`[blockReader] onUpdates failed: ${e?.message ?? e}`);
        }
      }
    } catch (e) {
      this.fail(e);
    }
  }

  // Bookkeeping for a good poll.
  private succeed(): void {
    this.counts.ok++;
    this.errorsInRow = 0;
    this.delayMs = this.pollMs;
  }

  // Bookkeeping for a failed poll: count it and choose the pause.
  private fail(e: unknown): void {
    this.counts.errors++;
    this.errorsInRow++;
    const limited = isRateLimit(e);
    if (limited) this.counts.rateLimited++;
    if (this.errorsInRow >= LONG_PAUSE_AFTER) this.delayMs = LONG_PAUSE_MS;
    else this.delayMs = limited ? RATE_LIMIT_PAUSE_MS : ERROR_PAUSE_MS;
  }

  // Remember how long a request took (keeps only the most recent ones).
  private recordTiming(ms: number): void {
    this.timings.push(ms);
    if (this.timings.length > TIMING_SAMPLES) this.timings.shift();
  }

  // Health numbers for the status line.
  stats(): { polls: number; ok: number; errors: number; rateLimited: number; updates: number; skippedRanges: number; lastBlock: number; lagBlocks: number; medianMs: number } {
    const s = [...this.timings].sort((a, b) => a - b);
    let medianMs = 0;
    if (s.length) {
      const mid = Math.floor(s.length / 2);
      medianMs = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
    }
    return {
      ...this.counts,
      lastBlock: this.last,
      lagBlocks: this.head >= 0 && this.last >= 0 ? Math.max(0, this.head - this.last) : 0,
      medianMs,
    };
  }
}
