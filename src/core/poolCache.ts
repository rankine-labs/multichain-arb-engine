import { PoolState, ChainName } from './types';
import { amountInAfterFee } from './dexMath';

// ============================================================================
// POOL CACHE
// Biggest speed advantage in the whole system. A normal bot re-asks the
// blockchain "what's the reserve, what's the tick" every time it needs to
// calculate something. That costs milliseconds we don't have.
// We keep every approved pool's state in RAM and update it as events arrive.
// ============================================================================

// ----------------------------------------------------------------------------
// LOOKUP INDEXES (Oct 14, freeze phase 1)
//
// Plain English:
//   "Which pools hold token X?" and "which other pools trade X/Y?" used to
//   walk EVERY cached pool, lower-casing two or three addresses per pool
//   each time. The price oracle asked "which pools hold X" several times
//   per coin price, about once a second for every coin, and copied the
//   whole pool list each time; every feed trade asked "which other pools
//   trade this pair". With thousands of pools that was the biggest source
//   of throwaway memory (memory clean-up was ~10% of all time) and part of
//   the 300-700 ms gap-scan freezes.
//
//   Now the cache keeps two small indexes, updated on every write:
//     chain -> pool keys       (allForChain, forChain)
//     chain:token -> pool keys (withToken, findPeerPools)
//   Answers are EXACTLY the same, in the same order (the indexes keep the
//   order pools were first added, like the main list does).
//
// Switch: POOL_INDEX=0 goes back to walking every pool (old behaviour).
// ----------------------------------------------------------------------------
const POOL_INDEX_ON = process.env.POOL_INDEX !== '0';

// ----------------------------------------------------------------------------
// CONFIRMED VIEW (loop fix phase 2, LOOP_REAL_PRICES)
//
// Plain English:
//   The main list holds the bot's BEST GUESS of each pool: when the trade feed
//   sees a trade it writes a PREDICTED state straight away (upsertFromFeed),
//   long before the trade is in a block. That is right for 2-pool trades (we
//   want to act on the trade we just saw), but loops chain 3 to 5 pools, and
//   small prediction errors add up hop after hop, worst in thin meme pools.
//
//   So, only when the loop trader is on (LOOP_TRADER=1) and LOOP_REAL_PRICES
//   is not 0, the cache also remembers the last state that came from REAL
//   chain data: a block the block reader read (upsertFromBlock, or
//   keepBlockState when the main write was skipped) or an RPC re-read
//   (upsert / upsertIfNotNewer). The trade feed never writes here.
//
//   Memory: one small entry per pool, holding a REFERENCE to a state the
//   main list already made (no copy), except when the main write was skipped
//   (keepBlockState makes one state object). Entries are removed together
//   with the pool (prune). Off = nothing is stored at all.
// ----------------------------------------------------------------------------
interface Confirmed {
  pool: PoolState;     // the real-data state (shared with the main list when it was written there too)
  block: number;       // its block number (0 = not known, e.g. some RPC reads)
  at: number;          // when it was written (ms)
  fromBlock: boolean;  // written by the block reader (guards older RPC reads, see upsertIfNotNewer)
  tx?: string;         // block reader: the transaction of the pool's last event in that read (lower-case)
  // Event fees seen after this state was written are on the main copy only:
  // a merged copy is made once and reused while nothing changes.
  merged?: { fee: PoolState['observedFee']; pool: PoolState };
}

// The loop trader switches (read once). Exported for shadowMain and tests.
export function confirmedViewFromEnv(env: Record<string, string | undefined> = process.env): boolean {
  const loopsOn = env.LOOP_TRADER === '1' || env.LOOP_TRADER === 'true';
  return loopsOn && env.LOOP_REAL_PRICES !== '0';
}

// What the loop trader needs to know about a confirmed state to tell which
// feed trades it already includes (core/loopPrices.ts PendingTrades).
export interface ConfirmedInfo { block: number; at: number; fromBlock: boolean; tx?: string }

// An RPC read with no block number must not replace a block-reader state
// written this recently: the RPC node may be a block or so behind, so its
// answer could be OLDER than the exact block state (about 2 blocks here).
export const CONFIRMED_RPC_GRACE_MS = 500;

export class PoolCache {
  private pools = new Map<string, PoolState>(); // key: `${chain}:${poolAddress}`
  // Index: chain -> keys of its pools (insertion order = main list order).
  private byChain = new Map<string, Set<string>>();
  // Index: `${chain}:${token lowercase}` -> keys of pools holding that token.
  private byToken = new Map<string, Set<string>>();
  // Lower-cased tokens a pool was indexed under (to unindex it exactly).
  private indexedAs = new Map<string, { chain: string; a: string; b: string }>();
  readonly indexed: boolean;
  // Confirmed view (see above). Empty and unused when switched off.
  private confirmed = new Map<string, Confirmed>();
  readonly confirmedOn: boolean;

  constructor(opts: { index?: boolean; confirmed?: boolean } = {}) {
    this.indexed = opts.index ?? POOL_INDEX_ON;
    this.confirmedOn = opts.confirmed ?? confirmedViewFromEnv();
  }

  // Remember a real-data state in the confirmed view. Never called for feed
  // predictions. An older block never replaces a newer one.
  private confirm(k: string, pool: PoolState, block: number, now: number, fromBlock: boolean, tx?: string): void {
    if (!this.confirmedOn) return;
    const cur = this.confirmed.get(k);
    if (cur && block > 0 && cur.block > block) return;
    // Block unknown (some RPC reads): don't replace a fresh block state.
    if (cur && block <= 0 && cur.fromBlock && cur.block > 0 && now - cur.at < CONFIRMED_RPC_GRACE_MS) return;
    this.confirmed.set(k, { pool, block, at: now, fromBlock, ...(tx ? { tx } : {}) });
  }

    private key(chain: ChainName, poolAddress: string) {
        return `${chain}:${poolAddress.toLowerCase()}`;
          }

  // Every write goes through here so the indexes always match the main list.
  private put(k: string, pool: PoolState): void {
    if (this.indexed) {
      const prev = this.indexedAs.get(k);
      // Same chain + tokens as before (the usual case: a price update): nothing to do.
      if (!prev || prev.chain !== pool.chain || prev.a !== pool.tokenA.toLowerCase() || prev.b !== pool.tokenB.toLowerCase()) {
        if (prev) this.unindex(k, prev);
        const ent = { chain: pool.chain as string, a: pool.tokenA.toLowerCase(), b: pool.tokenB.toLowerCase() };
        this.indexedAs.set(k, ent);
        addTo(this.byChain, ent.chain, k);
        addTo(this.byToken, `${ent.chain}:${ent.a}`, k);
        addTo(this.byToken, `${ent.chain}:${ent.b}`, k);
      }
    }
    this.pools.set(k, pool);
  }

  private unindex(k: string, ent: { chain: string; a: string; b: string }): void {
    removeFrom(this.byChain, ent.chain, k);
    removeFrom(this.byToken, `${ent.chain}:${ent.a}`, k);
    removeFrom(this.byToken, `${ent.chain}:${ent.b}`, k);
    this.indexedAs.delete(k);
  }

  private drop(k: string): void {
    this.pools.delete(k);
    this.confirmed.delete(k);
    if (this.indexed) { const ent = this.indexedAs.get(k); if (ent) this.unindex(k, ent); }
  }

  // Plain write: pool discovery and RPC reads (never the trade feed), so it
  // also counts as real data for the confirmed view.
  upsert(pool: PoolState) {
    const k = this.key(pool.chain, pool.poolAddress);
    this.put(k, pool);
    this.confirm(k, pool, pool.lastUpdatedBlock ?? 0, Date.now(), false);
  }

  // RPC refresh write: skip it if the cached copy changed AFTER the read
  // started (the trade feed applied a newer swap while the RPC call was in
  // flight; the RPC answer may predate that swap and would put the old price
  // back, creating a fake gap). A pool skipped 3 times in a row is written
  // anyway so drift on a very busy pool still gets corrected.
  // Returns true if written.
  // Also skipped within FEED_GRACE_MS of a swap applied from the trade feed:
  // the feed sees a trade before the RPC node has it in a block, so an RPC
  // read started just after still returns the pre-trade price.
  private skips = new Map<string, number>();
  private feedApplied = new Map<string, number>();
  static FEED_GRACE_MS = Number(process.env.FEED_GRACE_MS ?? 2_000);

  // Write a state predicted from a sequenced trade (instant price tracking).
  upsertFromFeed(pool: PoolState, now = Date.now()) {
    const k = this.key(pool.chain, pool.poolAddress);
    this.put(k, { ...pool, lastUpdatedMs: now });
    this.feedApplied.set(k, now);
  }

  // Write an EXACT state read from a mined block (core/blockReader.ts). Not
  // marked as a feed prediction, so the reader's next block for the same pool
  // is never held back; an RPC refresh that started earlier still can't
  // overwrite it (lastUpdatedMs is newer than that read's start).
  // tx (optional, loop trader only): the transaction of the event that
  // produced this state, so loops know which feed trades it already includes.
  upsertFromBlock(pool: PoolState, now = Date.now(), tx?: string) {
    const k = this.key(pool.chain, pool.poolAddress);
    const st = { ...pool, lastUpdatedMs: now };
    this.put(k, st);
    this.blockApplied.set(k, now);
    // Same object in the confirmed view (a reference, not a copy).
    this.confirm(k, st, st.lastUpdatedBlock, now, true, tx);
  }

  // LOOP_KEEP_BLOCK_UPDATES: the block reader read an EXACT state but left
  // the main list alone (the feed wrote a prediction moments ago, see
  // shadowMain applyUpdate). Before, that real state was simply thrown away.
  // Now it goes into the confirmed view only: the main list (and so every
  // 2-pool trade) is not touched at all. An older block never overwrites a
  // newer one. Returns true if kept.
  keepBlockState(pool: PoolState, block: number, now = Date.now(), tx?: string): boolean {
    if (!this.confirmedOn) return false;
    const k = this.key(pool.chain, pool.poolAddress);
    if (!this.pools.has(k)) return false; // only pools the cache knows (keeps memory bounded)
    const cur = this.confirmed.get(k);
    if (cur && cur.block > block) return false;
    this.confirmed.set(k, { pool: { ...pool, lastUpdatedBlock: block, lastUpdatedMs: now }, block, at: now, fromBlock: true, ...(tx ? { tx } : {}) });
    return true;
  }

  // Where the confirmed state came from (block, when, which transaction). undefined = none.
  confirmedInfo(chain: ChainName, poolAddress: string): ConfirmedInfo | undefined {
    const c = this.confirmed.get(this.key(chain, poolAddress));
    return c ? { block: c.block, at: c.at, fromBlock: c.fromBlock, ...(c.tx ? { tx: c.tx } : {}) } : undefined;
  }

  // The last REAL-data state of a pool (block reader or RPC read), never a
  // feed prediction. undefined = none (or the view is off). Event fees seen
  // since (kept on the main copy, core/eventFees.ts) are carried over, so
  // dynamic-fee pools use their latest real fee.
  getConfirmed(chain: ChainName, poolAddress: string): PoolState | undefined {
    const k = this.key(chain, poolAddress);
    const c = this.confirmed.get(k);
    if (!c) return undefined;
    return this.withFee(c, this.pools.get(k));
  }

  // The confirmed state with the main copy's latest event fees (see getConfirmed).
  private withFee(c: Confirmed, main: PoolState | undefined): PoolState {
    if (!main || main === c.pool || main.observedFee === c.pool.observedFee) return c.pool;
    if (!c.merged || c.merged.fee !== main.observedFee) c.merged = { fee: main.observedFee, pool: { ...c.pool, observedFee: main.observedFee } };
    return c.merged.pool;
  }

  // LOOP WORKER (main thread side, core/loopWorkerFeed.ts): in ONE lookup,
  // the main state (m), the confirmed state exactly as getConfirmed gives it
  // (c), and the confirmed entry itself (e). `e` is a new object on every
  // confirmed write, so "e changed" tells whether confirmedInfo changed
  // without building it. Read only; fills `out` (no new objects).
  readLoopView(chain: ChainName, poolAddress: string, out: { m?: PoolState; c?: PoolState; e?: object }): void {
    this.readLoopViewKey(this.key(chain, poolAddress), out);
  }
  // Same, with the cache's own key (from cacheKey) worked out once and
  // remembered by the caller: saves making a lower-case copy every time.
  cacheKey(chain: ChainName, poolAddress: string): string { return this.key(chain, poolAddress); }
  readLoopViewKey(k: string, out: { m?: PoolState; c?: PoolState; e?: object }): void {
    const main = this.pools.get(k);
    const c = this.confirmed.get(k);
    out.m = main;
    out.e = c;
    out.c = c ? this.withFee(c, main) : undefined;
  }

  // Block number of the confirmed state (for tests / reports). 0 = none or unknown.
  confirmedBlock(chain: ChainName, poolAddress: string): number { return this.confirmed.get(this.key(chain, poolAddress))?.block ?? 0; }
  // For tests / memory checks: how many pools have a confirmed state.
  confirmedCount(): number { return this.confirmed.size; }
  // When the block reader last wrote each pool. An RPC refresh that started
  // before that is never force-written over it (see upsertIfNotNewer).
  private blockApplied = new Map<string, number>();

  // True if the trade feed wrote a predicted state for this pool in the last
  // `ms` milliseconds (the block reader then leaves that pool alone, so an
  // older block can't overwrite a newer prediction).
  fedWithin(chain: ChainName, poolAddress: string, ms: number, now = Date.now()): boolean {
    return now - (this.feedApplied.get(this.key(chain, poolAddress)) ?? 0) < ms;
  }

  // When the block reader / trade feed last wrote this pool (0 = never).
  // Read-only; used by the "trust the WebSocket" price check
  // (core/trustFresh.ts) to know WHERE the cached state came from.
  blockAppliedAt(chain: ChainName, poolAddress: string): number { return this.blockApplied.get(this.key(chain, poolAddress)) ?? 0; }
  feedAppliedAt(chain: ChainName, poolAddress: string): number { return this.feedApplied.get(this.key(chain, poolAddress)) ?? 0; }

  upsertIfNotNewer(fresh: PoolState, readStartedMs: number, now = Date.now()): boolean {
    const k = this.key(fresh.chain, fresh.poolAddress);
    const cur = this.pools.get(k);
    const fedAt = this.feedApplied.get(k) ?? 0;
    // Exact block-reader data newer than this read: never overwrite it, not
    // even after repeated skips (the read can only be older).
    if (cur && (this.blockApplied.get(k) ?? 0) > readStartedMs) return false;
    if (cur && (cur.lastUpdatedMs > readStartedMs || now - fedAt < PoolCache.FEED_GRACE_MS)) {
      const n = (this.skips.get(k) ?? 0) + 1;
      if (n < 3) { this.skips.set(k, n); return false; }
    }
    this.skips.delete(k);
    this.feedApplied.delete(k);
    this.put(k, fresh);
    // Confirmed view: an RPC read is real data, unless the block reader put a
    // newer exact state there after this read started (keepBlockState can do
    // that without touching blockApplied above).
    const c = this.confirmed.get(k);
    if (!(c && c.fromBlock && c.at > readStartedMs)) this.confirm(k, fresh, fresh.lastUpdatedBlock ?? 0, now, false);
    return true;
  }

                    get(chain: ChainName, poolAddress: string): PoolState | undefined {
                        return this.pools.get(this.key(chain, poolAddress));
                          }

                            // Find every OTHER pool trading the same token pair on the same chain.
                              // This is the core of "is there a second venue to arb against".
                                findPeerPools(chain: ChainName, tokenA: string, tokenB: string, excludePool: string): PoolState[] {
                                    const a = tokenA.toLowerCase();
                                        const b = tokenB.toLowerCase();
                                            const results: PoolState[] = [];
    if (this.indexed) {
      // Index: walk the pools of the token with fewer pools, keep those whose
      // other token matches. Same pools, same order as the full walk below.
      const sa = this.byToken.get(`${chain}:${a}`), sb = this.byToken.get(`${chain}:${b}`);
      if (!sa || !sb) return results;
      const small = sa.size <= sb.size ? sa : sb;
      const ex = `${chain}:${excludePool.toLowerCase()}`;
      for (const k of small) {
        if (k === ex) continue;
        const ent = this.indexedAs.get(k)!;
        if ((ent.a === a && ent.b === b) || (ent.a === b && ent.b === a)) results.push(this.pools.get(k)!);
      }
      return results;
    }
                                                for (const pool of this.pools.values()) {
                                                      if (pool.chain !== chain) continue;
                                                            if (pool.poolAddress.toLowerCase() === excludePool.toLowerCase()) continue;
                                                                  const pa = pool.tokenA.toLowerCase();
                                                                        const pb = pool.tokenB.toLowerCase();
                                                                              const matches = (pa === a && pb === b) || (pa === b && pb === a);
                                                                                    if (matches) results.push(pool);
                                                                                        }
                                                                                            return results;
                                                                                              }

  // Memory: drop pools nobody needs any more (not kept by the caller, e.g.
  // not in a watched pair, and not updated for maxAgeMs). Without this the
  // cache only ever grew: every pool seen in any trade stayed forever and
  // every peer lookup scanned all of them. Returns how many were removed.
  prune(keep: (p: PoolState) => boolean, maxAgeMs: number, now = Date.now()): number {
    let n = 0;
    for (const [k, p] of this.pools) {
      if (keep(p) || now - p.lastUpdatedMs < maxAgeMs) continue;
      this.drop(k);
      this.skips.delete(k);
      this.feedApplied.delete(k);
      this.blockApplied.delete(k); // (Oct 13) was missed: one entry per pruned pool stayed forever
      n++;
    }
    return n;
  }


                                                                                                allForChain(chain: ChainName): PoolState[] {
    if (this.indexed) {
      // Index: only this chain's pools, no full walk (same order as below).
      const ks = this.byChain.get(chain);
      const out: PoolState[] = [];
      if (ks) for (const k of ks) out.push(this.pools.get(k)!);
      return out;
    }
                                                                                                    return [...this.pools.values()].filter(p => p.chain === chain);
                                                                                                      }

  // Walk one chain's pools WITHOUT making a copy of the list (for loops
  // that only read). Don't add or remove pools while walking.
  *forChain(chain: ChainName): IterableIterator<PoolState> {
    if (this.indexed) {
      const ks = this.byChain.get(chain);
      if (ks) for (const k of ks) yield this.pools.get(k)!;
      return;
    }
    for (const p of this.pools.values()) if (p.chain === chain) yield p;
  }

  // Pools on `chain` holding `token`, in the same order as allForChain.
  withToken(chain: ChainName, token: string): PoolState[] {
    const t = token.toLowerCase();
    const out: PoolState[] = [];
    if (this.indexed) {
      const ks = this.byToken.get(`${chain}:${t}`);
      if (ks) for (const k of ks) out.push(this.pools.get(k)!);
      return out;
    }
    for (const p of this.pools.values()) {
      if (p.chain !== chain) continue;
      if (p.tokenA.toLowerCase() === t || p.tokenB.toLowerCase() === t) out.push(p);
    }
    return out;
  }
                                                                                                      
                                                                                                        // For tests / memory checks: how many pools have a "block reader wrote here" note.
  blockAppliedCount(): number { return this.blockApplied.size; }

  size(): number {
                                                                                                            return this.pools.size;
                                                                                                              }
                                                                                                              
                                                                                                                // Applies a predicted post-trade reserve change WITHOUT touching the real
                                                                                                                  // cached state — used by the future-state simulator to answer
                                                                                                                    // "if this pending trade lands, what would the price look like?"
                                                                                                                      //
                                                                                                                        // v2 pools: exact constant-product math.
                                                                                                                          // v3 pools: approximated using "virtual reserves" derived from the
                                                                                                                            // current sqrtPriceX96 and active liquidity (x = L/sqrtP, y = L*sqrtP).
                                                                                                                              // This is exact for trades that stay within the current tick's liquidity
                                                                                                                                // range, and is the standard simplification used for fast estimation —
                                                                                                                                  // it will UNDERSTATE price impact for trades large enough to cross into
                                                                                                                                    // a neighboring tick range with different liquidity. Good enough for
                                                                                                                                      // shadow-mode sizing; real execution should re-verify with a proper
                                                                                                                                        // quoter call (e.g. QuoterV2) immediately before firing.
                                                                                                                                          predictPostTradeState(pool: PoolState, tokenInIsA: boolean, amountIn: bigint): PoolState {
                                                                                                                                              if (pool.poolType === 'v2') {
                                                                                                                                                    if (pool.reserveA === undefined || pool.reserveB === undefined) return pool;
                                                                                                                                                    
                                                                                                                                                          // Same fee maths as the sizing code (dexMath.ts), so prediction and sizing agree.
                                                                                                                                                                const amountInWithFee = amountInAfterFee(pool, amountIn, tokenInIsA);
                                                                                                                                                                
                                                                                                                                                                      if (tokenInIsA) {
                                                                                                                                                                              const newReserveA = pool.reserveA + amountIn;
                                                                                                                                                                                      const newReserveB = (pool.reserveA * pool.reserveB) / (pool.reserveA + amountInWithFee);
                                                                                                                                                                                              return { ...pool, reserveA: newReserveA, reserveB: newReserveB };
                                                                                                                                                                                                    } else {
                                                                                                                                                                                                            const newReserveB = pool.reserveB + amountIn;
                                                                                                                                                                                                                    const newReserveA = (pool.reserveA * pool.reserveB) / (pool.reserveB + amountInWithFee);
                                                                                                                                                                                                                            return { ...pool, reserveA: newReserveA, reserveB: newReserveB };
                                                                                                                                                                                                                                  }
                                                                                                                                                                                                                                      }
                                                                                                                                                                                                                                      
                                                                                                                                                                                                                                          if (pool.poolType === 'v3') {
                                                                                                                                                                                                                                                if (pool.sqrtPriceX96 === undefined || pool.liquidity === undefined) return pool;
                                                                                                                                                                                                                                                
                                                                                                                                                                                                                                                      const Q96 = 1n << 96n;
                                                                                                                                                                                                                                                            // Virtual reserves at the current price, within the active tick's
                                                                                                                                                                                                                                                                  // liquidity: x (tokenA-equivalent) = L * Q96 / sqrtP, y (tokenB) = L * sqrtP / Q96
                                                                                                                                                                                                                                                                        const virtualX = (pool.liquidity * Q96) / pool.sqrtPriceX96;
                                                                                                                                                                                                                                                                              const virtualY = (pool.liquidity * pool.sqrtPriceX96) / Q96;
                                                                                                                                                                                                                                                                              
                                                                                                                                                                                                                                                                                    // Same fee maths as the sizing code (dexMath.ts), so prediction and sizing agree.
                                                                                                                                                                                                                                                                                          const amountInWithFee = amountInAfterFee(pool, amountIn, tokenInIsA);
                                                                                                                                                                                                                                                                                          
                                                                                                                                                                                                                                                                                                // Same constant-product relationship (virtualX * virtualY = k) applied
                                                                                                                                                                                                                                                                                                      // to the virtual reserves, then converted back into a new sqrtPriceX96.
                                                                                                                                                                                                                                                                                                            let newVirtualX: bigint;
                                                                                                                                                                                                                                                                                                                  let newVirtualY: bigint;
                                                                                                                                                                                                                                                                                                                  
                                                                                                                                                                                                                                                                                                                        if (tokenInIsA) {
                                                                                                                                                                                                                                                                                                                                newVirtualX = virtualX + amountInWithFee;
                                                                                                                                                                                                                                                                                                                                        newVirtualY = (virtualX * virtualY) / newVirtualX;
                                                                                                                                                                                                                                                                                                                                              } else {
                                                                                                                                                                                                                                                                                                                                                      newVirtualY = virtualY + amountInWithFee;
                                                                                                                                                                                                                                                                                                                                                              newVirtualX = (virtualX * virtualY) / newVirtualY;
                                                                                                                                                                                                                                                                                                                                                                    }
                                                                                                                                                                                                                                                                                                                                                                    
                                                                                                                                                                                                                                                                                                                                                                          if (newVirtualX === 0n) return pool; // guard against div-by-zero on extreme input
                                                                                                                                                                                                                                                                                                                                                                          
                                                                                                                                                                                                                                                                                                                                                                                // sqrtP = sqrt(y/x) — reconstruct via the identity newSqrtP = L*Q96/newVirtualX
                                                                                                                                                                                                                                                                                                                                                                                      const newSqrtPriceX96 = (pool.liquidity * Q96) / newVirtualX;
                                                                                                                                                                                                                                                                                                                                                                                      
                                                                                                                                                                                                                                                                                                                                                                                            return { ...pool, sqrtPriceX96: newSqrtPriceX96 };
                                                                                                                                                                                                                                                                                                                                                                                                }
                                                                                                                                                                                                                                                                                                                                                                                                
                                                                                                                                                                                                                                                                                                                                                                                                    // orderbook / stable pool math not implemented yet — return unchanged
                                                                                                                                                                                                                                                                                                                                                                                                        // so callers can detect "no prediction available" via unchanged state.
                                                                                                                                                                                                                                                                                                                                                                                                            return pool;
                                                                                                                                                                                                                                                                                                                                                                                                              }
                                                                                                                                                                                                                                                                                                                                                                                                              }

// Index helpers: add / remove a pool key under an index entry (empty
// entries are deleted so the index never keeps dead tokens around).
function addTo(m: Map<string, Set<string>>, k: string, v: string): void {
  let s = m.get(k);
  if (!s) { s = new Set(); m.set(k, s); }
  s.add(v);
}
function removeFrom(m: Map<string, Set<string>>, k: string, v: string): void {
  const s = m.get(k);
  if (!s) return;
  s.delete(v);
  if (s.size === 0) m.delete(k);
}
