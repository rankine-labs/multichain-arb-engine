import { ethers } from 'ethers';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';
import { decodePoolCreatedLog, type RawLog, type ScanFactory } from './universeScan';
import { V4_INITIALIZE_TOPIC, V4_MODIFY_LIQUIDITY_TOPIC, decodeV4Initialize, decodeV4ModifyLiquidity, v4MintAmounts } from './v4Scan';

// ============================================================================
// NEW POOL COUNTER -- measurement only, never trades.
//
// Plain English:
//   When someone opens a new pool for a coin that already trades elsewhere,
//   they set its starting price by hand, and it's often a bit off. The first
//   bot to trade it back into line keeps the difference. Before building
//   anything for that, we count how often it happens and how big it is.
//
// How:
//   1. Once a minute, one log request on the free node (through the gentle
//      scan lane) reads the DEX factories' "new pool" events, plus the events
//      of the few new pools we're still waiting on.
//   2. A new pool only counts if BOTH its coins already have a deep pool
//      somewhere ($10,000+, priced by the bot's price oracle). Brand-new junk
//      coins are ignored on purpose.
//   3. Its starting price is read from its own events, so we see the price
//      the creator set, even if a bot fixed it a block later:
//        - simple pools (V2 / Solidly): the first "Sync" with coins on both
//          sides = first money in, and its amounts.
//        - V3 pools: the "Initialize" price (set at creation, can't move
//          before money arrives) and the first "Mint" (first money in).
//   4. Compare that starting price with the deep pools' price, and record:
//      how far off (%), and roughly how much money went in.
//
// Uniswap V4 (no factory; all pools live in one PoolManager): one extra
// log request a minute on the PoolManager, filtered to just two events:
//   - Initialize: a new pool and the price its creator set (hooked pools,
//     which the bot can't trade, are skipped);
//   - ModifyLiquidity: the first money added; the amounts are worked out
//     from the liquidity and price range (core/v4Scan.ts v4MintAmounts).
// ============================================================================

const SYNC = ethers.id('Sync(uint112,uint112)');          // Uniswap V2 / PancakeSwap V2
const SYNC_256 = ethers.id('Sync(uint256,uint256)');      // Solidly forks (Ramses V2)
const INITIALIZE = ethers.id('Initialize(uint160,int24)'); // V3 (Uniswap, Pancake, Ramses)
const MINT_V3 = ethers.id('Mint(address,address,int24,int24,uint128,uint256,uint256)');

// Price info for one coin (from the bot's price oracle).
export interface RefPrice { px: number; depthUsd: number; pool: string | null }

export interface PendingPool {
  pool: string;            // lowercase
  dex: string;
  kind: ScanFactory['kind'];
  token0: string;          // lowercase
  token1: string;
  createdBlock: number;
  createdAt: number;       // ms
  sqrtPriceX96?: string;   // V3: price set at creation (decimal string, JSON-safe)
}

// One new pool that got its first money, measured.
export interface NewPoolRec {
  t: number;
  pair: string;            // "TSLA/USDG"
  dex: string;
  gapPct: number;          // how far its starting price was from the deep pools' price
  usd: number;             // roughly how much money went in first
}

export interface NewPoolSummary {
  created: number;         // all new pools on the factories we watch
  eligible: number;        // ... for coins that already trade in deep pools
  measured: number;        // ... that got their first money (price measured)
  off05: number; off1: number; off3: number;   // started more than 0.5% / 1% / 3% off
  usd: number;             // money in the measured pools
  usdOff1: number;         // money in the pools that started more than 1% off
  top: NewPoolRec[];       // biggest gaps first (up to 5)
}

export interface NewPoolWatchOptions {
  factories: ScanFactory[];
  // eth_getLogs for these addresses over [from, to] (any topics, unless
  // `topics` is given: used for the V4 PoolManager so its swaps never come back).
  getLogs: (addresses: string[], from: number, to: number, topics?: (string | string[] | null)[]) => Promise<RawLog[]>;
  latestBlock: () => Promise<number>;
  refPrice: (token: string) => RefPrice | null;
  decimals: (token: string) => number | undefined;
  symbol: (token: string) => string;
  now?: () => number;
  minDeepUsd?: number;     // a coin needs a pool this deep to count (default $10,000)
  maxPending?: number;     // pools waiting for their first money (default 200)
  pendingHours?: number;   // give up waiting after this long (default 48 h)
  maxCatchUpBlocks?: number; // after a long stop, don't read further back than this
  log?: (msg: string) => void;
}

const KEEP_MS = 26 * 3600_000;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

// Price of token0 in token1 units from V2 reserves (decimal-adjusted).
export function v2Price1Per0(r0: bigint, r1: bigint, d0: number, d1: number): number | null {
  if (r0 <= 0n || r1 <= 0n) return null;
  const a = Number(r0) / 10 ** d0, b = Number(r1) / 10 ** d1;
  return a > 0 && b > 0 ? b / a : null;
}

// Price of token0 in token1 units from a V3 sqrtPriceX96 (decimal-adjusted).
export function v3Price1Per0(sqrtPriceX96: bigint, d0: number, d1: number): number | null {
  if (sqrtPriceX96 <= 0n) return null;
  const s = Number(sqrtPriceX96) / 2 ** 96;
  const p = s * s * 10 ** (d0 - d1);
  return Number.isFinite(p) && p > 0 ? p : null;
}

// How far (in %) a pool's price is from what the deep pools say.
// price1Per0: the new pool's price; p0/p1: USD prices from the deep pools.
export function gapPct(price1Per0: number, p0: number, p1: number): number {
  const fair = p0 / p1;
  return Math.abs(price1Per0 / fair - 1) * 100;
}

// Summarise measured pools plus creation counts over a time window.
export function summarizeNewPools(created: number[], eligible: number[], recs: NewPoolRec[], from: number, to: number): NewPoolSummary {
  const inWin = (t: number) => t >= from && t < to;
  const rs = recs.filter((r) => inWin(r.t));
  return {
    created: created.filter(inWin).length,
    eligible: eligible.filter(inWin).length,
    measured: rs.length,
    off05: rs.filter((r) => r.gapPct > 0.5).length,
    off1: rs.filter((r) => r.gapPct > 1).length,
    off3: rs.filter((r) => r.gapPct > 3).length,
    usd: rs.reduce((s, r) => s + r.usd, 0),
    usdOff1: rs.filter((r) => r.gapPct > 1).reduce((s, r) => s + r.usd, 0),
    top: [...rs].sort((a, b) => b.gapPct - a.gapPct).slice(0, 5),
  };
}

const word = (data: string, i: number): bigint | null => {
  const hex = data.startsWith('0x') ? data.slice(2) : data;
  if (hex.length < 64 * (i + 1)) return null;
  try { return BigInt('0x' + hex.slice(64 * i, 64 * (i + 1))); } catch { return null; }
};
const blockOf = (l: RawLog): number => (l.blockNumber ? Number(BigInt(l.blockNumber)) : 0);
const logOrder = (a: RawLog, b: RawLog) => blockOf(a) - blockOf(b) || Number(BigInt(a.logIndex ?? '0x0') - BigInt(b.logIndex ?? '0x0'));

// ---------------------------------------------------------------------------
// The watcher
// ---------------------------------------------------------------------------
export class NewPoolWatch {
  private lastBlock = -1;
  private pending = new Map<string, PendingPool>();
  private created: number[] = [];
  private eligible: number[] = [];
  private recs: NewPoolRec[] = [];
  private hourFrom: number;
  private busy = false;
  private readonly factoryByAddr: Map<string, ScanFactory>;   // address-based factories (not V4)
  private readonly v4Factories: ScanFactory[];
  private readonly now: () => number;
  private readonly minDeepUsd: number;
  private readonly maxPending: number;
  private readonly pendingMs: number;
  private readonly maxCatchUp: number;
  private readonly log: (msg: string) => void;
  errors = 0;              // failed polls since start (shown on the status page)

  constructor(private readonly o: NewPoolWatchOptions) {
    this.factoryByAddr = new Map(o.factories.filter((f) => f.kind !== 'v4').map((f) => [f.factory.toLowerCase(), f]));
    this.v4Factories = o.factories.filter((f) => f.kind === 'v4' && !!f.weth);
    this.now = o.now ?? Date.now;
    this.minDeepUsd = o.minDeepUsd ?? 10_000;
    this.maxPending = o.maxPending ?? 200;
    this.pendingMs = (o.pendingHours ?? 48) * 3600_000;
    this.maxCatchUp = o.maxCatchUpBlocks ?? 1_000_000;
    this.log = o.log ?? ((m) => console.log(m));
    this.hourFrom = this.now();
  }

  pendingCount() { return this.pending.size; }

  // A coin "already trades deep" if the oracle prices it from a pool with
  // $10k+ in it. The new pool itself never counts as its own reference.
  private deepPrice(token: string, newPool: string): RefPrice | null {
    const r = this.o.refPrice(token);
    if (!r || !(r.px > 0) || !(r.depthUsd >= this.minDeepUsd)) return null;
    if (r.pool && r.pool.toLowerCase() === newPool) return null;
    return r;
  }

  // One round: new pools since last time, then any first money in pending ones.
  // Usually ONE log request (two when a new pool for deep coins was just made).
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const latest = await this.o.latestBlock();
      if (this.lastBlock < 0) { this.lastBlock = latest; return; } // first run: start from now
      let from = this.lastBlock + 1;
      if (from > latest) return;
      if (latest - from > this.maxCatchUp) from = latest - this.maxCatchUp; // long stop: skip the oldest part
      this.expire();
      // V4 pending pools are ids, not addresses: they never go in this list.
      const addrs = [...this.factoryByAddr.keys(), ...[...this.pending.values()].filter((p) => p.kind !== 'v4').map((p) => p.pool)];
      const logs = await this.o.getLogs(addrs, from, latest);
      const fresh: PendingPool[] = [];
      const poolLogs: RawLog[] = [];
      for (const l of logs) {
        const addr = (l.address ?? '').toLowerCase();
        const f = this.factoryByAddr.get(addr);
        if (!f) { poolLogs.push(l); continue; }
        const d = decodePoolCreatedLog(l);
        if (!d) continue;
        const p = this.onCreated(f, d, blockOf(l));
        if (p) fresh.push(p);
      }
      // Pools made in this window: read their own events too (they weren't
      // in the address list yet). Rare: only pools for deep coins.
      if (fresh.length) poolLogs.push(...await this.o.getLogs(fresh.map((p) => p.pool), Math.min(...fresh.map((p) => p.createdBlock)), latest));
      this.onPoolLogs(poolLogs);
      for (const f of this.v4Factories) {
        this.onV4Logs(f, await this.o.getLogs([f.factory], from, latest, [[V4_INITIALIZE_TOPIC, V4_MODIFY_LIQUIDITY_TOPIC]]));
      }
      this.lastBlock = latest;
    } catch (err) {
      this.errors++;
      this.log(`[newpools] poll failed, will retry: ${String((err as Error)?.message ?? err).slice(0, 120)}`);
    } finally {
      this.busy = false;
    }
  }

  // A pool creation event. Returns the pool if we'll wait for its first money.
  onCreated(f: ScanFactory, d: { token0: string; token1: string; pool: string }, block: number): PendingPool | null {
    const t = this.now();
    this.created.push(t);
    const pool = d.pool.toLowerCase();
    const t0 = d.token0.toLowerCase(), t1 = d.token1.toLowerCase();
    if (!this.deepPrice(t0, pool) || !this.deepPrice(t1, pool)) return null; // a new/junk coin: ignore
    if (this.o.decimals(t0) === undefined || this.o.decimals(t1) === undefined) return null;
    this.eligible.push(t);
    if (this.pending.size >= this.maxPending || this.pending.has(pool)) return null;
    const p: PendingPool = { pool, dex: f.dex, kind: f.kind, token0: t0, token1: t1, createdBlock: block, createdAt: t };
    this.pending.set(pool, p);
    this.log(`[newpools] new pool ${this.pairName(p)} on ${f.dex}, waiting for its first money`);
    return p;
  }

  // Events from pending pools, oldest first: find each one's starting price.
  onPoolLogs(logs: RawLog[]) {
    for (const l of [...logs].sort(logOrder)) {
      const p = this.pending.get((l.address ?? '').toLowerCase());
      if (!p) continue;
      const t0 = l.topics?.[0];
      const d0 = this.o.decimals(p.token0)!, d1 = this.o.decimals(p.token1)!;
      if (t0 === INITIALIZE) {
        const s = word(l.data, 0);
        if (s) p.sqrtPriceX96 = s.toString();
      } else if ((t0 === SYNC || t0 === SYNC_256) && p.kind !== 'v3') {
        const r0 = word(l.data, 0), r1 = word(l.data, 1);
        if (r0 === null || r1 === null) continue;
        const px = v2Price1Per0(r0, r1, d0, d1);
        if (px !== null) this.measure(p, px, Number(r0) / 10 ** d0, Number(r1) / 10 ** d1);
      } else if (t0 === MINT_V3 && p.kind === 'v3' && p.sqrtPriceX96) {
        // Mint data: sender, amount, amount0, amount1.
        const a0 = word(l.data, 2), a1 = word(l.data, 3);
        const px = v3Price1Per0(BigInt(p.sqrtPriceX96), d0, d1);
        if (px !== null && a0 !== null && a1 !== null) this.measure(p, px, Number(a0) / 10 ** d0, Number(a1) / 10 ** d1);
      }
    }
  }

  // V4 events from the PoolManager, oldest first: new pools (Initialize, with
  // the creator's price) and first money in (ModifyLiquidity adding liquidity).
  onV4Logs(f: ScanFactory, logs: RawLog[]) {
    for (const l of [...logs].sort(logOrder)) {
      const t0 = l.topics?.[0]?.toLowerCase();
      if (t0 === V4_INITIALIZE_TOPIC) {
        const d = decodeV4Initialize(l, f.weth!);
        if (!d || d.hooked) continue; // misread, or a hooked pool the bot can't trade
        const p = this.onCreated(f, { token0: d.token0, token1: d.token1, pool: d.id }, blockOf(l));
        if (p) p.sqrtPriceX96 = d.sqrtPriceX96.toString();
      } else if (t0 === V4_MODIFY_LIQUIDITY_TOPIC) {
        const m = decodeV4ModifyLiquidity(l);
        if (!m || m.liquidityDelta <= 0n) continue;
        const p = this.pending.get(m.id);
        if (!p || p.kind !== 'v4' || !p.sqrtPriceX96) continue;
        const d0 = this.o.decimals(p.token0)!, d1 = this.o.decimals(p.token1)!;
        const sq = BigInt(p.sqrtPriceX96);
        const px = v3Price1Per0(sq, d0, d1);
        const { a0, a1 } = v4MintAmounts(sq, m.tickLower, m.tickUpper, m.liquidityDelta);
        if (px !== null) this.measure(p, px, a0 / 10 ** d0, a1 / 10 ** d1);
      }
    }
  }

  // First money in: compare its price with the deep pools' price, record.
  private measure(p: PendingPool, price1Per0: number, amt0: number, amt1: number) {
    this.pending.delete(p.pool);
    const r0 = this.deepPrice(p.token0, p.pool), r1 = this.deepPrice(p.token1, p.pool);
    if (!r0 || !r1) return; // reference price gone meanwhile: can't judge
    const gap = gapPct(price1Per0, r0.px, r1.px);
    const usd = amt0 * r0.px + amt1 * r1.px;
    if (!Number.isFinite(gap) || !Number.isFinite(usd)) return;
    const rec: NewPoolRec = { t: this.now(), pair: this.pairName(p), dex: p.dex, gapPct: gap, usd };
    this.recs.push(rec);
    this.log(`[newpools] first money in ${rec.pair} on ${p.dex}: started ${gap.toFixed(2)}% off the deep pools' price, ~$${Math.round(usd).toLocaleString('en-US')} in it`);
  }

  private pairName(p: PendingPool) { return `${this.o.symbol(p.token0)}/${this.o.symbol(p.token1)}`; }

  // Drop old records and pools that never got money.
  private expire() {
    const t = this.now();
    for (const [k, p] of this.pending) if (t - p.createdAt > this.pendingMs) this.pending.delete(k);
    const cut = t - KEEP_MS;
    if (this.created.length && this.created[0] < cut) this.created = this.created.filter((x) => x >= cut);
    if (this.eligible.length && this.eligible[0] < cut) this.eligible = this.eligible.filter((x) => x >= cut);
    if (this.recs.length && this.recs[0].t < cut) this.recs = this.recs.filter((r) => r.t >= cut);
    if (this.created.length > 200_000) this.created = this.created.slice(-200_000); // hard memory cap
  }

  // Window [from, to); "to" defaults to just after now, so anything recorded
  // this very millisecond is included.
  summary(from: number, to = this.now() + 1): NewPoolSummary { return summarizeNewPools(this.created, this.eligible, this.recs, from, to); }
  takeHour(): NewPoolSummary { const t = this.now() + 1; const s = this.summary(this.hourFrom, t); this.hourFrom = t; return s; }

  // One status-page line.
  statusLine(s: NewPoolSummary): string {
    return `[newpools] last hour: ${s.created} new pools, ${s.eligible} for deep coins, ${s.measured} got money; started off >0.5%: ${s.off05}, >1%: ${s.off1}, >3%: ${s.off3}; ~$${Math.round(s.usd)} in them; waiting on ${this.pending.size}; errors ${this.errors}`;
  }

  load(file: string) {
    try {
      const d = JSON.parse(readFileSync(file, 'utf8'));
      const cut = this.now() - KEEP_MS;
      if (typeof d.lastBlock === 'number') this.lastBlock = d.lastBlock;
      for (const p of (d.pending ?? []) as PendingPool[]) this.pending.set(p.pool, p);
      this.created = ((d.created ?? []) as number[]).filter((x) => x >= cut);
      this.eligible = ((d.eligible ?? []) as number[]).filter((x) => x >= cut);
      this.recs = ((d.recs ?? []) as NewPoolRec[]).filter((r) => r.t >= cut);
    } catch { /* first run */ }
  }
  save(file: string) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file + '.tmp', JSON.stringify({ lastBlock: this.lastBlock, pending: [...this.pending.values()], created: this.created, eligible: this.eligible, recs: this.recs }));
      renameSync(file + '.tmp', file);
    } catch { /* best effort */ }
  }
}
