import { ethers } from 'ethers';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';

// ============================================================================
// RIVAL WATCH -- what are the other arbitrage bots actually winning?
//
// Plain English:
//   The competitor tracker only looks at chances OUR bot flagged, so it can
//   tell us how fast rivals are but not what we're missing. Rival watch
//   follows the rival bots themselves:
//     1. Every rival bot the tracker has caught (its contract address) is
//        remembered (saved to disk).
//     2. Every trade in the live feed sent to one of those contracts is
//        queued. A few seconds later we read its receipt (1 request).
//     3. From the receipt: which coins went in/out of the bot's contract
//        (its profit, priced in USD) and which pools it traded on.
//     4. Per hour: how many rival trades, roughly how much they made, on which
//        pairs, and whether WE were watching those pools.
//   That shows where the real money is on this chain.
//
// Light on the RPC: at most one receipt per second, queue capped at 100.
// Never affects trading decisions.
// ============================================================================

const TRANSFER = ethers.id('Transfer(address,address,uint256)');
// Swap events of the pool types on Robinhood (V2 / Solidly, V3, PancakeV3, V4).
const SWAP_TOPICS = new Set([
  ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)'),
  ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)'),
  ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)'),
  ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'),
]);
const V4_SWAP = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');

type Log = { address: string; topics: string[]; data: string };
const addrFromTopic = (t: string) => '0x' + t.slice(26).toLowerCase();

export interface RivalTrade { bot: string; tokens: string[]; net: Map<string, bigint>; pools: string[] }

export interface RivalHour {
  trades: number;          // rival trades read this hour
  wins: number;            // ones that made money (priced)
  usd: number;             // total estimated profit (before their gas)
  byPair: [string, number, number][]; // [pair, trades, usd], biggest first
  onOurPools: number;      // trades where every pool used is one we watch
  bots: number;            // distinct rival bots seen trading this hour
}

export class RivalWatch {
  private bots = new Set<string>();
  private queue: { hash: string; bot: string; dueAt: number }[] = [];
  private busy = false;
  private hour = { trades: 0, wins: 0, usd: 0, onOurPools: 0, pairs: new Map<string, { n: number; usd: number }>(), bots: new Set<string>() };

  constructor(
    private readonly rpc: (method: string, params: unknown[]) => Promise<any>,
    private readonly tokenUsd: (token: string, raw: bigint) => number | null,
    private readonly symbol: (token: string) => string,
    private readonly isWatchedPool: (pool: string) => boolean,
    private readonly now: () => number = Date.now,
    private readonly delayMs = 3_000,
  ) {}

  addBot(addr: string | undefined) { if (addr && /^0x[0-9a-fA-F]{40}$/.test(addr)) this.bots.add(addr.toLowerCase()); }
  botCount() { return this.bots.size; }

  // Called for every feed transaction: queue it if it went to a rival bot.
  noteTx(to: string | undefined, hash: string | undefined) {
    if (!to || !hash) return;
    const bot = to.toLowerCase();
    if (!this.bots.has(bot) || this.queue.length >= 100) return;
    this.queue.push({ hash, bot, dueAt: this.now() + this.delayMs });
    void this.drain();
  }

  // Pure: what a rival's trade did, from its receipt logs.
  static analyze(logs: Log[], bot: string): RivalTrade {
    const b = bot.toLowerCase();
    const net = new Map<string, bigint>();
    const pools = new Set<string>();
    for (const l of logs) {
      const t0 = l.topics?.[0];
      if (t0 === TRANSFER && l.topics.length >= 3) {
        const from = addrFromTopic(l.topics[1]);
        const to = addrFromTopic(l.topics[2]);
        if (from !== b && to !== b) continue;
        let v: bigint;
        try { v = BigInt(l.data); } catch { continue; }
        const tok = l.address.toLowerCase();
        net.set(tok, (net.get(tok) ?? 0n) + (to === b ? v : -v));
      } else if (t0 && SWAP_TOPICS.has(t0)) {
        pools.add(t0 === V4_SWAP ? l.topics[1].toLowerCase() : l.address.toLowerCase());
      }
    }
    return { bot: b, tokens: [...net.keys()], net, pools: [...pools] };
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
          const r = await this.rpc('eth_getTransactionReceipt', [job.hash]);
          const rcpt = r?.result ?? r;
          if (!rcpt?.logs || rcpt.status === '0x0') continue; // failed or not found: their loss, not a win
          this.record(RivalWatch.analyze(rcpt.logs, job.bot));
        } catch { /* RPC hiccup: drop this one */ }
        await new Promise((res) => setTimeout(res, 1_000)); // at most ~1 receipt per second
      }
    } finally {
      this.busy = false;
    }
  }

  private record(t: RivalTrade) {
    if (t.pools.length < 2) return; // not an arbitrage (one pool or none)
    let usd = 0;
    let priced = false;
    for (const [tok, v] of t.net) {
      const u = this.tokenUsd(tok, v < 0n ? -v : v);
      if (u === null) continue;
      priced = true;
      usd += v < 0n ? -u : u;
    }
    const pair = [...new Set(t.tokens.map((x) => this.symbol(x)))].sort().join('/') || '?';
    const ours = t.pools.every((p) => this.isWatchedPool(p));
    const h = this.hour;
    h.trades++;
    h.bots.add(t.bot);
    if (ours) h.onOurPools++;
    if (priced && usd > 0) {
      h.wins++;
      h.usd += usd;
      const e = h.pairs.get(pair) ?? { n: 0, usd: 0 };
      e.n++; e.usd += usd;
      h.pairs.set(pair, e);
    }
    console.log(`[rivalwatch] bot ${t.bot.slice(0, 10)} ${pair} ${priced ? `~$${usd.toFixed(2)}` : 'unpriced'} | ${t.pools.length} pools, ${ours ? 'all watched by us' : 'NOT all watched by us'}`);
  }

  // Hourly summary, then reset the hour.
  takeHour(): RivalHour {
    const h = this.hour;
    const out: RivalHour = {
      trades: h.trades, wins: h.wins, usd: h.usd, onOurPools: h.onOurPools, bots: h.bots.size,
      byPair: [...h.pairs.entries()].sort((a, b) => b[1].usd - a[1].usd).map(([p, e]) => [p, e.n, e.usd]),
    };
    this.hour = { trades: 0, wins: 0, usd: 0, onOurPools: 0, pairs: new Map(), bots: new Set() };
    return out;
  }

  load(file: string): number {
    try { for (const b of JSON.parse(readFileSync(file, 'utf8')) as string[]) this.addBot(b); } catch { /* first run */ }
    return this.bots.size;
  }
  save(file: string) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file + '.tmp', JSON.stringify([...this.bots]));
      renameSync(file + '.tmp', file);
    } catch { /* best effort */ }
  }
}
