import { ethers } from 'ethers';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';

// ============================================================================
// RIVAL WATCH -- learn from the other arbitrage bots (Stage 0).
//
// Plain English:
//   We want to know, for real, whether there's money on this chain and how the
//   bots that make it work. For every trade a known rival bot makes we read
//   its receipt (1 request) and record:
//     - did it make money, how much, after its gas
//     - how big the trade was (what it put in)
//     - how many pools it went through (2 = simple, 3+ = a loop)
//     - did it borrow (flash loan) or use its own money
//     - did it fail outright (and still pay gas)
//     - were those pools ones WE watch
//   New rival bots are found two ways: the competitor tracker (bots that race
//   us) and a slow sampler that reads one recent block now and then and spots
//   contracts that end a multi-pool trade with more coins than they started.
//
//   Records are kept 26 h and saved to disk, so the daily report survives
//   restarts. Light on the node: receipts at most ~1/s, sampler 1 block / 15 s.
//   Never affects trading.
//
// Junk prices (fix, Oct 8): a junk coin's price comes from its own tiny,
// lopsided pool, so a trade in it could be "worth" thousands of dollars
// either way (the report once said rivals made -$24,742, and one bot made
// $10,065 from 96 trades). A trade's profit is now treated as UNTRUSTED and
// left out of every money total (but still counted) when:
//   - the profit is impossible for what went in: more than 5% of the trade
//     size, or more than $5 when the size is unknown, or
//   - any coin it moved is priced from a pool under $5,000.
// ============================================================================

// Profit bigger than this share of the trade size can't be real arbitrage.
export const MAX_PLAUSIBLE_PROFIT_SHARE = 0.05;
// With no trade size, a "profit" bigger than this is not trusted.
export const MAX_PROFIT_NO_SIZE_USD = 5;
// A coin priced from a pool holding less than this is not trusted.
export const MIN_PRICE_POOL_USD = 5_000;

const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const V4_SWAP = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const SWAP_TOPICS = new Set([
  ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)'),                     // V2 / Solidly
  ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)'),                 // V3
  ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)'), // PancakeSwap V3
  V4_SWAP,                                                                                // Uniswap V4
]);
const FLASH_TOPICS = new Set([
  ethers.id('Flash(address,address,uint256,uint256,uint256,uint256)'),            // Uniswap/Pancake V3 flash
  ethers.id('FlashLoan(address,address,address,uint256,uint8,uint256,uint16)'),   // Aave V3
  ethers.id('FlashLoan(address,address,uint256,uint256)'),                        // Balancer
]);

type Log = { address: string; topics: string[]; data: string };
const addrFromTopic = (t: string) => '0x' + t.slice(26).toLowerCase();

// What one trade did, from its receipt logs (pure, unit-tested).
export interface RivalTrade {
  bot: string;
  net: Map<string, bigint>;   // coin -> change in the bot's balance
  outflow: Map<string, bigint>; // coin -> total the bot sent out (trade size)
  pools: string[];
  flash: boolean;
}

// One saved record (compact; prices already applied).
export interface RivalRec {
  t: number;            // when (ms)
  bot: string;
  pair: string;         // e.g. "USDG/WETH" or "AMZN/USDG/WETH"
  pools: number;        // pools in the route
  sizeUsd: number | null;   // what it put in
  grossUsd: number | null;  // profit before gas (null = coins we can't price)
  gasUsd: number | null;    // gas it paid
  failed: boolean;      // trade reverted (paid gas, did nothing)
  flash: boolean;       // borrowed via flash loan
  ours: boolean;        // every pool in the route is one we watch
  thinPrice?: boolean;  // a coin it moved is priced from a pool under $5k
}

// True when a trade's dollar profit can't be trusted (see the note at the
// top). Failed and unpriced trades have no profit to judge, so false.
export function isJunkProfit(r: RivalRec): boolean {
  if (r.failed || r.grossUsd === null) return false;
  if (r.thinPrice) return true;
  const g = Math.abs(r.grossUsd);
  if (r.sizeUsd !== null && r.sizeUsd > 0) return g > MAX_PLAUSIBLE_PROFIT_SHARE * r.sizeUsd;
  return g > MAX_PROFIT_NO_SIZE_USD;
}

export interface RivalSummary {
  trades: number; failed: number; unpriced: number;
  junk: number;                 // profit not trusted (junk coin prices), left out of money totals
  wins: number;                 // made money after gas
  grossUsd: number; gasUsd: number; netUsd: number;
  medianSizeUsd: number | null; medianWinUsd: number | null; medianGasUsd: number | null;
  routes: { two: number; three: number; fourPlus: number }; // trades that went through (failed ones show 0 pools)
  flash: number; onOurPools: number;
  byPair: [string, number, number][];                          // [pair, trades, net $]
  byBot: { bot: string; trades: number; netUsd: number; medianSizeUsd: number | null; avgPools: number; flash: number }[];
  bots: number;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function summarize(recs: RivalRec[]): RivalSummary {
  const byPair = new Map<string, { n: number; usd: number }>();
  // okN/okPools: trades that went through, and their pool count. Failed
  // trades record 0 pools, so counting them dragged "avg pools" down.
  const byBot = new Map<string, { n: number; usd: number; sizes: number[]; okN: number; okPools: number; flash: number }>();
  const out: RivalSummary = {
    trades: recs.length, failed: 0, unpriced: 0, junk: 0, wins: 0, grossUsd: 0, gasUsd: 0, netUsd: 0,
    medianSizeUsd: null, medianWinUsd: null, medianGasUsd: null,
    routes: { two: 0, three: 0, fourPlus: 0 }, flash: 0, onOurPools: 0, byPair: [], byBot: [], bots: 0,
  };
  const sizes: number[] = [], wins: number[] = [], gases: number[] = [];
  for (const r of recs) {
    const gas = r.gasUsd ?? 0;
    if (r.gasUsd !== null) { gases.push(r.gasUsd); out.gasUsd += r.gasUsd; }
    if (r.flash) out.flash++;
    if (r.ours) out.onOurPools++;
    const b = byBot.get(r.bot) ?? { n: 0, usd: 0, sizes: [], okN: 0, okPools: 0, flash: 0 };
    b.n++; if (r.flash) b.flash++;
    byBot.set(r.bot, b);
    if (r.failed) { out.failed++; b.usd -= gas; out.netUsd -= gas; continue; }
    // Route shape only for trades that went through.
    b.okN++; b.okPools += r.pools;
    if (r.pools <= 2) out.routes.two++; else if (r.pools === 3) out.routes.three++; else out.routes.fourPlus++;
    // Junk trades (see isJunkProfit) skew "typical trade size" too, so their
    // size is left out along with their profit.
    const junk = isJunkProfit(r);
    if (r.sizeUsd !== null && !r.thinPrice && !junk) { sizes.push(r.sizeUsd); b.sizes.push(r.sizeUsd); }
    if (r.grossUsd === null) { out.unpriced++; continue; }
    if (junk) { out.junk++; continue; } // counted, but no money
    out.grossUsd += r.grossUsd;
    const net = r.grossUsd - gas;
    out.netUsd += net; b.usd += net;
    if (net > 0) {
      out.wins++; wins.push(net);
      const p = byPair.get(r.pair) ?? { n: 0, usd: 0 };
      p.n++; p.usd += net; byPair.set(r.pair, p);
    }
  }
  out.medianSizeUsd = median(sizes); out.medianWinUsd = median(wins); out.medianGasUsd = median(gases);
  out.byPair = [...byPair.entries()].sort((a, b) => b[1].usd - a[1].usd).map(([p, e]) => [p, e.n, e.usd]);
  out.byBot = [...byBot.entries()].map(([bot, e]) => ({ bot, trades: e.n, netUsd: e.usd, medianSizeUsd: median(e.sizes), avgPools: e.okN ? e.okPools / e.okN : 0, flash: e.flash }))
    .sort((a, b) => b.netUsd - a.netUsd);
  out.bots = byBot.size;
  return out;
}

export class RivalWatch {
  private bots = new Set<string>();
  private candidates = new Map<string, number>();     // sampler: address -> profitable multi-pool trades seen
  private queue: { hash: string; bot: string; dueAt: number }[] = [];
  private busy = false;
  private recs: RivalRec[] = [];
  private hourFrom: number;

  constructor(
    private readonly rpc: (method: string, params: unknown[]) => Promise<any>,
    private readonly tokenUsd: (token: string, raw: bigint) => number | null,
    private readonly symbol: (token: string) => string,
    private readonly isWatchedPool: (pool: string) => boolean,
    private readonly weth: string,
    private readonly now: () => number = Date.now,
    private readonly delayMs = 3_000,
    // How much money is in the pool a coin's price comes from (null = no
    // price). Optional: without it, only the profit-vs-size rule applies.
    private readonly priceDepthUsd?: (token: string) => number | null,
  ) { this.hourFrom = now(); }

  addBot(addr: string | undefined) { if (addr && /^0x[0-9a-fA-F]{40}$/.test(addr)) this.bots.add(addr.toLowerCase()); }
  botCount() { return this.bots.size; }

  // Every feed transaction: queue it if it went to a rival bot.
  noteTx(to: string | undefined, hash: string | undefined) {
    if (!to || !hash) return;
    const bot = to.toLowerCase();
    if (!this.bots.has(bot) || this.queue.length >= 100) return;
    this.queue.push({ hash, bot, dueAt: this.now() + this.delayMs });
    void this.drain();
  }

  static analyze(logs: Log[], bot: string): RivalTrade {
    const b = bot.toLowerCase();
    const net = new Map<string, bigint>();
    const outflow = new Map<string, bigint>();
    const pools = new Set<string>();
    let flash = false;
    for (const l of logs) {
      const t0 = l.topics?.[0];
      if (!t0) continue;
      if (FLASH_TOPICS.has(t0)) flash = true;
      if (t0 === TRANSFER && l.topics.length >= 3) {
        const from = addrFromTopic(l.topics[1]);
        const to = addrFromTopic(l.topics[2]);
        if (from !== b && to !== b) continue;
        let v: bigint;
        try { v = BigInt(l.data); } catch { continue; }
        const tok = l.address.toLowerCase();
        net.set(tok, (net.get(tok) ?? 0n) + (to === b ? v : -v));
        if (from === b) outflow.set(tok, (outflow.get(tok) ?? 0n) + v);
      } else if (SWAP_TOPICS.has(t0)) {
        pools.add(t0 === V4_SWAP ? l.topics[1].toLowerCase() : l.address.toLowerCase());
      }
    }
    return { bot: b, net, outflow, pools: [...pools], flash };
  }

  // Receipt -> saved record (null if it isn't a multi-pool trade).
  toRec(rcpt: any, bot: string, t = this.now()): RivalRec | null {
    const failed = rcpt.status === '0x0';
    const gasWei = BigInt(rcpt.gasUsed ?? '0x0') * BigInt(rcpt.effectiveGasPrice ?? '0x0');
    const gasUsd = this.tokenUsd(this.weth, gasWei);
    if (failed) return { t, bot, pair: '(failed)', pools: 0, sizeUsd: null, grossUsd: null, gasUsd, failed: true, flash: false, ours: false };
    const tr = RivalWatch.analyze(rcpt.logs ?? [], bot);
    if (tr.pools.length < 2) return null; // not an arbitrage
    let gross = 0, priced = false, unpricedMove = false;
    for (const [tok, v] of tr.net) {
      if (v === 0n) continue;
      const u = this.tokenUsd(tok, v < 0n ? -v : v);
      if (u === null) { unpricedMove = true; continue; }
      priced = true; gross += v < 0n ? -u : u;
    }
    let size: number | null = null;
    for (const [tok, v] of tr.outflow) { const u = this.tokenUsd(tok, v); if (u !== null) size = Math.max(size ?? 0, u); }
    const pair = [...new Set([...tr.net.keys()].map((x) => this.symbol(x)))].sort().join('/') || '?';
    // Any coin it moved priced from a shallow pool? Then its dollar numbers
    // can't be trusted (a $500 pool can show any price).
    let thinPrice = false;
    if (this.priceDepthUsd) {
      for (const tok of new Set([...tr.net.keys(), ...tr.outflow.keys()])) {
        if ((tr.net.get(tok) ?? 0n) === 0n && !tr.outflow.get(tok)) continue;
        const d = this.priceDepthUsd(tok);
        if (d !== null && d < MIN_PRICE_POOL_USD) { thinPrice = true; break; }
      }
    }
    return {
      t, bot, pair, pools: tr.pools.length, sizeUsd: size,
      grossUsd: priced && !unpricedMove ? gross : null, gasUsd, failed: false, flash: tr.flash,
      ours: tr.pools.every((p) => this.isWatchedPool(p)),
      ...(thinPrice ? { thinPrice: true } : {}),
    };
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
          if (rcpt?.blockNumber) {
            const rec = this.toRec(rcpt, job.bot);
            if (rec) this.add(rec);
          }
        } catch { /* RPC hiccup: drop this one */ }
        await new Promise((res) => setTimeout(res, 1_000));
      }
    } finally {
      this.busy = false;
    }
  }

  add(rec: RivalRec) {
    this.recs.push(rec);
    const cutoff = this.now() - 26 * 3600_000;
    if (this.recs.length > 50_000 || (this.recs.length % 500 === 0 && this.recs[0]?.t < cutoff)) this.recs = this.recs.filter((r) => r.t >= cutoff).slice(-50_000);
    const net = rec.grossUsd !== null ? rec.grossUsd - (rec.gasUsd ?? 0) : null;
    // Junk-priced trades are logged without "~$" so the status page doesn't add them up.
    const money = net === null ? (rec.failed ? `gas $${(rec.gasUsd ?? 0).toFixed(4)}` : 'unpriced')
      : isJunkProfit(rec) ? `junk price (said $${net.toFixed(2)}, ignored)` : `~$${net.toFixed(4)}`;
    console.log(`[rivalwatch] bot ${rec.bot.slice(0, 10)} ${rec.failed ? 'FAILED' : rec.pair} ${money} | ${rec.pools} pools, size ${rec.sizeUsd === null ? '?' : '$' + rec.sizeUsd.toFixed(0)}, gas ${rec.gasUsd === null ? '?' : '$' + rec.gasUsd.toFixed(4)}${rec.flash ? ', flash loan' : ''}, ${rec.ours ? 'all watched by us' : 'NOT all watched by us'}`);
  }

  // Sampler: read one recent block's receipts and spot new rival bots.
  // A contract becomes a "rival" after 2 trades where it went through 2+
  // pools and ended with more of some coin and less of none (a trading app
  // that passes coins on to a user ends with nothing, so it's not counted).
  async sampleBlock(blockTag: string): Promise<number> {
    const r = await this.rpc('eth_getBlockReceipts', [blockTag]);
    const rcpts: any[] = r?.result ?? r ?? [];
    if (!Array.isArray(rcpts)) return 0;
    let added = 0;
    for (const rc of rcpts) {
      if (rc.status !== '0x1' || !rc.to) continue;
      const to = rc.to.toLowerCase();
      if (this.bots.has(to)) continue;
      const tr = RivalWatch.analyze(rc.logs ?? [], to);
      if (tr.pools.length < 2) continue;
      const moves = [...tr.net.values()].filter((v) => v !== 0n);
      if (!moves.length || moves.some((v) => v < 0n)) continue;
      const n = (this.candidates.get(to) ?? 0) + 1;
      this.candidates.set(to, n);
      if (n >= 2) { this.bots.add(to); this.candidates.delete(to); added++; console.log(`[rivalwatch] new rival bot found by sampling: ${to}`); }
    }
    if (this.candidates.size > 5_000) this.candidates.clear();
    return added;
  }

  // Summaries for the reports.
  summary(fromMs: number, toMs = this.now()): RivalSummary { return summarize(this.recs.filter((r) => r.t >= fromMs && r.t < toMs)); }
  // When the earliest saved record at/after fromMs is (for "last N hours" labels).
  firstRecordMs(fromMs: number): number { const r = this.recs.find((x) => x.t >= fromMs); return r ? r.t : this.now(); }
  takeHour(): RivalSummary { const s = this.summary(this.hourFrom); this.hourFrom = this.now(); return s; }

  load(botsFile: string, recsFile: string): { bots: number; recs: number } {
    try { for (const b of JSON.parse(readFileSync(botsFile, 'utf8')) as string[]) this.addBot(b); } catch { /* first run */ }
    try {
      const cutoff = this.now() - 26 * 3600_000;
      const rows = JSON.parse(readFileSync(recsFile, 'utf8')) as RivalRec[];
      this.recs = rows.filter((r) => r.t >= cutoff);
    } catch { /* first run */ }
    return { bots: this.bots.size, recs: this.recs.length };
  }
  save(botsFile: string, recsFile: string) {
    const write = (file: string, data: unknown) => {
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file + '.tmp', JSON.stringify(data));
        renameSync(file + '.tmp', file);
      } catch { /* best effort */ }
    };
    write(botsFile, [...this.bots]);
    write(recsFile, this.recs);
  }
}
