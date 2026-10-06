import { ethers } from 'ethers';

// ============================================================================
// COMPETITOR TRACKER (live) -- how fast are the bots we race against?
//
// Plain English:
//   1. Every transaction in Robinhood's sequencer feed is timestamped the
//      moment it reaches us (noteFeedTx).
//   2. When the bot spots a real chance, it hands the triggering trade and
//      the pair's pools to watch().
//   3. A few seconds later (once the blocks exist) we fetch the pools' events
//      around the trigger and look for the first OTHER transaction that
//      touched two pools of that pair in one go: that's a competitor's arb.
//   4. Their speed = when their arb showed up in the feed minus when the
//      trigger showed up. Both times are taken at our server, so network
//      distance to the feed cancels out. We compare it with our own
//      "ready to send" time for the same trigger.
//
// Light on the RPC: one check at a time, at most MAX_QUEUE waiting, ~3 calls
// per check. Never affects trading decisions.
// ============================================================================

export interface RivalResult {
  found: boolean;
  theirMs?: number;      // their arb seen in feed - trigger seen in feed
  ourReadyMs?: number;   // our decision-to-signed time for the same trigger
  txGap?: number;        // their position after the trigger in the same block (1 = right behind)
  blocksLater?: number;
  bot?: string;          // contract their arb called
  profitUsd: number;
}

interface Job { triggerHash: string; triggerSeenMs: number; pools: string[]; ourReadyMs?: number; profitUsd: number; dueAt: number }

// Uniswap V4 pools aren't contracts: they're 32-byte ids inside the
// PoolManager, and their trades show up as PoolManager Swap events with the
// pool id as the first topic. eth_getLogs rejects a 32-byte id as an
// "address", so every rival check involving a V4 pool used to fail silently.
const V4_SWAP_TOPIC = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const isV4Id = (p: string) => p.length === 66;

const MAX_QUEUE = 20;
const CHECK_DELAY_MS = 4_000;   // let the blocks land before looking
const SEEN_TTL_MS = 3 * 60_000;

export class CompetitorTracker {
  private seen = new Map<string, number>();
  private inserts = 0;
  private queue: Job[] = [];
  private busy = false;
  results: RivalResult[] = [];

  constructor(
    private readonly provider: ethers.JsonRpcProvider,
    private readonly now: () => number = Date.now,
    private readonly v4PoolManager?: string, // needed to time rivals on V4 pools
  ) {}

  noteFeedTx(hash: string | undefined, ms: number) {
    if (!hash) return;
    this.seen.set(hash.toLowerCase(), ms);
    if (++this.inserts % 2000 === 0) {
      const cutoff = this.now() - SEEN_TTL_MS;
      for (const [h, t] of this.seen) if (t < cutoff) this.seen.delete(h);
    }
  }

  watch(job: Omit<Job, 'dueAt'>) {
    if (!job.triggerHash || job.pools.length < 2) return;
    if (this.queue.length >= MAX_QUEUE) return; // busy: skip, plenty of samples come later
    if (this.queue.some((j) => j.triggerHash === job.triggerHash)) return;
    this.queue.push({ ...job, triggerHash: job.triggerHash.toLowerCase(), pools: job.pools.map((p) => p.toLowerCase()), dueAt: this.now() + CHECK_DELAY_MS });
    void this.drain();
  }

  private async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const job = this.queue[0];
        const wait = job.dueAt - this.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.queue.shift();
        try {
          const r = await this.check(job);
          if (r) {
            this.results.push(r);
            console.log(r.found
              ? `[rival] arb found: theirs ${r.theirMs ?? '?'}ms, ours ${r.ourReadyMs ?? '?'}ms, ${r.txGap !== undefined ? `${r.txGap} tx behind trigger` : `${r.blocksLater} block(s) later`}, bot ${r.bot?.slice(0, 10) ?? '?'} ($${Math.round(r.profitUsd)} gap)`
              : `[rival] no rival arb within 8 blocks ($${Math.round(r.profitUsd)} gap)`);
          }
        } catch { /* RPC hiccup: drop this sample */ }
      }
    } finally {
      this.busy = false;
    }
  }

  // Pure part, unit-tested: given the pair's events around the trigger, find
  // the first other transaction that touched 2+ of the pair's pools.
  static findRivalArb(
    logs: { transactionHash: string; transactionIndex: number; blockNumber: number; address: string }[],
    pools: string[], trigger: { hash: string; block: number; index: number },
  ): { hash: string; block: number; index: number } | null {
    const byTx = new Map<string, { block: number; index: number; pools: Set<string> }>();
    const poolSet = new Set(pools.map((p) => p.toLowerCase()));
    for (const l of logs) {
      const addr = l.address.toLowerCase();
      if (!poolSet.has(addr)) continue;
      const h = l.transactionHash.toLowerCase();
      const e = byTx.get(h) ?? { block: l.blockNumber, index: l.transactionIndex, pools: new Set<string>() };
      e.pools.add(addr);
      byTx.set(h, e);
    }
    let best: { hash: string; block: number; index: number } | null = null;
    for (const [hash, e] of byTx) {
      if (hash === trigger.hash.toLowerCase() || e.pools.size < 2) continue;
      const after = e.block > trigger.block || (e.block === trigger.block && e.index > trigger.index);
      if (!after) continue;
      if (!best || e.block < best.block || (e.block === best.block && e.index < best.index)) best = { hash, block: e.block, index: e.index };
    }
    return best;
  }

  private async check(job: Job): Promise<RivalResult | null> {
    const receipt = await this.provider.getTransactionReceipt(job.triggerHash);
    if (!receipt) return null; // trigger never landed (reverted/dropped)
    type RawLog = { transactionHash: string; transactionIndex: string; blockNumber: string; address: string; topics: string[] };
    const range = { fromBlock: ethers.toQuantity(receipt.blockNumber), toBlock: ethers.toQuantity(receipt.blockNumber + 8) };
    const addrs = job.pools.filter((p) => !isV4Id(p));
    const v4Ids = job.pools.filter(isV4Id);
    const [plain, v4] = await Promise.all([
      addrs.length ? this.provider.send('eth_getLogs', [{ address: addrs, ...range }]) as Promise<RawLog[]> : Promise.resolve([] as RawLog[]),
      v4Ids.length && this.v4PoolManager
        ? this.provider.send('eth_getLogs', [{ address: this.v4PoolManager, topics: [V4_SWAP_TOPIC, v4Ids], ...range }]) as Promise<RawLog[]>
        : Promise.resolve([] as RawLog[]),
    ]);
    const toLog = (l: RawLog, address: string) => ({ transactionHash: l.transactionHash, transactionIndex: Number(l.transactionIndex), blockNumber: Number(l.blockNumber), address });
    // A V4 swap counts as touching "the pool" whose id is in topic 1.
    const logs = [...plain.map((l) => toLog(l, l.address)), ...v4.map((l) => toLog(l, (l.topics?.[1] ?? '').toLowerCase()))];
    const rival = CompetitorTracker.findRivalArb(logs, job.pools, { hash: job.triggerHash, block: receipt.blockNumber, index: receipt.index });
    if (!rival) return { found: false, ourReadyMs: job.ourReadyMs, profitUsd: job.profitUsd };
    const seenAt = this.seen.get(rival.hash);
    let bot: string | undefined;
    try { bot = (await this.provider.getTransaction(rival.hash))?.to?.toLowerCase() ?? undefined; } catch { /* optional */ }
    return {
      found: true,
      theirMs: seenAt !== undefined ? seenAt - job.triggerSeenMs : undefined,
      ourReadyMs: job.ourReadyMs,
      txGap: rival.block === receipt.blockNumber ? rival.index - receipt.index : undefined,
      blocksLater: rival.block - receipt.blockNumber,
      bot,
      profitUsd: job.profitUsd,
    };
  }

  // Summary for reports; call reset() after reporting.
  summary() {
    const found = this.results.filter((r) => r.found);
    const theirs = found.map((r) => r.theirMs).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
    const ours = this.results.map((r) => r.ourReadyMs).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
    const med = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length / 2)] : null);
    const beat = found.filter((r) => r.theirMs !== undefined && r.ourReadyMs !== undefined && r.ourReadyMs < r.theirMs).length;
    const bots = new Map<string, number>();
    for (const r of found) if (r.bot) bots.set(r.bot, (bots.get(r.bot) ?? 0) + 1);
    const topBot = [...bots.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      checked: this.results.length, found: found.length,
      theirMedianMs: med(theirs), theirFastestMs: theirs[0] ?? null, ourMedianMs: med(ours),
      beatCount: beat, comparable: found.filter((r) => r.theirMs !== undefined && r.ourReadyMs !== undefined).length,
      rightBehind: found.filter((r) => r.txGap === 1).length,
      bots: bots.size, topBotShare: topBot && found.length ? Math.round((100 * topBot[1]) / found.length) : 0,
    };
  }

  reset() { this.results = []; }
}
