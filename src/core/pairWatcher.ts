import { ethers } from 'ethers';
import { ChainName, PoolState } from './types';
import { PoolCache } from './poolCache';
import {
  resolveAndFetchV2Pool, resolveAndFetchSolidlyV2Pool, resolveAllV3Pools,
  refetchV2PoolPrice, refetchV3PoolPrice,
} from './poolResolver';

// ============================================================================
// PAIR WATCHER -- automatic, traffic-driven pool discovery
//
// Plain English:
//   An arbitrage needs the SAME pair on two or more pools. When a trade shows
//   up on a pair, this finds EVERY pool for that pair on EVERY DEX and fee
//   tier on the chain, puts them in the pool cache, and keeps their prices
//   refreshed. The next big trade on that pair then has real partner pools
//   to compare against.
//
// Why automatic: the live probe showed Robinhood traffic is mostly
// short-lived memecoin pairs (114 different pairs in 2 minutes). A hand-made
// list would be stale within hours; this follows the actual traffic.
//
// Limits (so it can't overload the RPC):
//   - discovery runs ONE pair at a time from a queue; if the queue is full,
//     new pairs are skipped (if they keep trading they'll be picked up later)
//   - at most `maxPairs` pairs; the least recently traded pair is dropped
//   - each pair is re-discovered at most every `rediscoverMs`; a pair found
//     to have only ONE pool (most memecoins: nothing to arb against) is not
//     re-checked for `singlePoolRecheckMs`
//   - prices refreshed every `refreshMs` in the background (the bot ALSO
//     re-reads the exact pools it's about to use at decision time)
// ============================================================================

export interface Venue {
  dex: string;
  kind: 'v2' | 'solidly' | 'v3-fee' | 'v3-spacing';
  factory: string;
  feeBps?: number; // V2-style pools: swap fee in bps
}

export interface PairWatcherOptions {
  maxPairs?: number;
  rediscoverMs?: number;
  refreshMs?: number;
  maxQueue?: number;
  singlePoolRecheckMs?: number;
}

type TokenMeta = { symbol: string; decimals: number };

const ERC20_META = ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'];

// Finds every pool for (tokenA, tokenB) across all venues, in parallel.
export async function discoverPairPools(
  provider: ethers.JsonRpcProvider, chain: ChainName, venues: Venue[], tokenA: string, tokenB: string,
): Promise<PoolState[]> {
  // Venues one after another (not all at once) to keep each RPC request small.
  const results: PoolState[][] = [];
  for (const v of venues) results.push(await (async (): Promise<PoolState[]> => {
    try {
      if (v.kind === 'v2') {
        const p = await resolveAndFetchV2Pool(provider, chain, v.dex, v.factory, tokenA, tokenB, v.feeBps ?? 30);
        return p ? [p] : [];
      }
      if (v.kind === 'solidly') {
        // Volatile pairs only: Solidly "stable" pairs use a different curve
        // that the bot's x*y=k maths can't price.
        const vol = await resolveAndFetchSolidlyV2Pool(provider, chain, v.dex, v.factory, tokenA, tokenB, false, v.feeBps ?? 20);
        return vol ? [vol] : [];
      }
      return await resolveAllV3Pools(provider, chain, v.dex, v.factory, tokenA, tokenB, v.kind === 'v3-fee' ? 'fee' : 'spacing');
    } catch {
      return [];
    }
  })());
  return results.flat();
}

// Re-reads one pool's live price state. Returns null if it couldn't.
export async function refreshPoolState(provider: ethers.JsonRpcProvider, pool: PoolState): Promise<PoolState | null> {
  if (pool.poolType === 'v3') return refetchV3PoolPrice(provider, pool);
  if (pool.poolType === 'v2') return refetchV2PoolPrice(provider, pool);
  return null; // orderbook / bins: not refreshed here
}

export class PairWatcher {
  private pairs = new Map<string, { tokenA: string; tokenB: string; pools: string[]; discoveredAt: number; lastSeen: number }>();
  // Pairs found by the chain-wide scan (or always-watched like WETH/USDG):
  // never dropped to make room for traffic-driven pairs.
  private pinned = new Set<string>();
  private inFlight = new Set<string>();           // queued or running
  private queue: Array<{ a: string; b: string }> = [];
  private working = false;
  private singlePool = new Map<string, number>();  // pair -> when it was found to have one pool
  private readonly maxQueue: number;
  private readonly singlePoolRecheckMs: number;
  private tokenMeta = new Map<string, TokenMeta | null>();
  private readonly maxPairs: number;
  private readonly rediscoverMs: number;
  private readonly refreshMs: number;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly chain: ChainName,
    private readonly provider: ethers.JsonRpcProvider,
    private readonly venues: Venue[],
    private readonly cache: PoolCache,
    // Called once per new token with its real on-chain symbol/decimals, so
    // pricing and trade sizing never guess decimals for a discovered token.
    private readonly onToken: (address: string, meta: TokenMeta) => void,
    opts: PairWatcherOptions = {},
  ) {
    this.maxPairs = opts.maxPairs ?? 40;
    this.rediscoverMs = opts.rediscoverMs ?? 10 * 60_000;
    this.refreshMs = opts.refreshMs ?? 30_000;
    this.maxQueue = opts.maxQueue ?? 20;
    this.singlePoolRecheckMs = opts.singlePoolRecheckMs ?? 60 * 60_000;
  }

  private key(a: string, b: string) {
    return [a.toLowerCase(), b.toLowerCase()].sort().join('/');
  }

  // Note a trade on (a, b). Starts discovery if the pair is new or stale.
  // Never throws, never blocks the caller.
  touch(a: string, b: string): void {
    const k = this.key(a, b);
    const now = Date.now();
    const entry = this.pairs.get(k);
    if (entry) entry.lastSeen = now;
    if (this.inFlight.has(k)) return;
    if (entry && now - entry.discoveredAt < this.rediscoverMs) return;
    const single = this.singlePool.get(k);
    if (single !== undefined && now - single < this.singlePoolRecheckMs) return;
    if (this.queue.length >= this.maxQueue) return; // busy: skip, it'll come back if it keeps trading
    this.inFlight.add(k);
    this.queue.push({ a, b });
    void this.drain();
  }

  // Works through the queue one pair at a time.
  private async drain(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length) {
        const { a, b } = this.queue.shift()!;
        try {
          await this.discover(a, b);
        } catch (err) {
          console.warn(`[pairs] ${this.chain} discovery failed:`, (err as Error).message);
        } finally {
          this.inFlight.delete(this.key(a, b));
        }
      }
    } finally {
      this.working = false;
    }
  }

  // Awaitable version, used at startup for pairs we always want.
  // pin = keep this pair even when traffic-driven pairs fill the list.
  async watch(a: string, b: string, opts: { pin?: boolean } = {}): Promise<number> {
    if (opts.pin) this.pinned.add(this.key(a, b));
    await this.discover(a, b);
    return this.pairs.get(this.key(a, b))?.pools.length ?? 0;
  }

  private async discover(a: string, b: string): Promise<void> {
    const k = this.key(a, b);
    // Exact decimals first: a pool on a token with unknown decimals is never used.
    const [ma, mb] = await Promise.all([this.meta(a), this.meta(b)]);
    if (!ma || !mb) return;

    const pools = await discoverPairPools(this.provider, this.chain, this.venues, a, b);
    for (const p of pools) this.cache.upsert(p);
    // One pool = nothing to arb against: remember that, don't track the pair.
    if (pools.length < 2) {
      this.singlePool.set(k, Date.now());
      if (this.singlePool.size > 5_000) this.singlePool.clear(); // bound memory
      return;
    }
    const now = Date.now();
    const prev = this.pairs.get(k);
    this.pairs.set(k, { tokenA: a, tokenB: b, pools: pools.map((p) => p.poolAddress), discoveredAt: now, lastSeen: prev?.lastSeen ?? now });
    if (!prev) {
      console.log(`[pairs] ${this.chain} watching ${ma.symbol}/${mb.symbol}: ${pools.length} pools (${pools.map((p) => `${p.dex}${p.poolType === 'v3' ? ` ${p.feeBps / 100}%` : ''}`).join(', ')})`);
    }
    this.evictIfNeeded();
  }

  // Symbol + decimals straight from the token contract (cached; null = unreadable).
  private async meta(token: string): Promise<TokenMeta | null> {
    const t = token.toLowerCase();
    if (this.tokenMeta.has(t)) return this.tokenMeta.get(t)!;
    let m: TokenMeta | null = null;
    try {
      const c = new ethers.Contract(token, ERC20_META, this.provider);
      const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
      m = { symbol: String(symbol), decimals: Number(decimals) };
      this.onToken(t, m);
    } catch { /* not a standard token; skip pairs that use it */ }
    this.tokenMeta.set(t, m);
    return m;
  }

  private evictIfNeeded() {
    while (this.pairs.size > this.maxPairs) {
      let oldestKey: string | null = null, oldest = Infinity;
      for (const [k, v] of this.pairs) {
        if (this.pinned.has(k)) continue; // pinned pairs are never dropped
        if (v.lastSeen < oldest) { oldest = v.lastSeen; oldestKey = k; }
      }
      if (!oldestKey) break;
      this.pairs.delete(oldestKey); // stops refreshing; decision-time refresh still covers any use
    }
  }

  // Background price refresh for every watched pool.
  start(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => { this.refreshAll().catch(() => { /* best effort */ }); }, this.refreshMs);
  }

  async refreshAll(): Promise<void> {
    const addrs = [...this.pairs.values()].flatMap((p) => p.pools);
    // Small batches to stay gentle on the RPC.
    for (let i = 0; i < addrs.length; i += 10) {
      await Promise.all(addrs.slice(i, i + 10).map(async (addr) => {
        const pool = this.cache.get(this.chain, addr);
        if (!pool) return;
        const fresh = await refreshPoolState(this.provider, pool);
        if (fresh) this.cache.upsert(fresh);
      }));
    }
  }

  stats() {
    let pools = 0;
    for (const p of this.pairs.values()) pools += p.pools.length;
    return { pairs: this.pairs.size, pools, pinned: this.pinned.size, queued: this.queue.length, singlePoolPairs: this.singlePool.size };
  }
}
