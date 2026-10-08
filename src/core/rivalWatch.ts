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
//   New rival bots are found three ways: the competitor tracker (bots that
//   race us), a slow sampler that reads one recent block now and then, and
//   the wallets that run known bots (a new contract sent from the same wallet
//   is probably the same operator's next bot).
//
//   Records are kept 26 h and saved to disk, so the daily report survives
//   restarts. Light on the node: receipts at most ~1/s, sampler 1 block / 15 s.
//   Never affects trading.
//
// HOW MUCH WE TRUST EACH TRADE'S DOLLAR RESULT (Phase 1 fixes, Oct 8)
//   Every trade that went through lands in exactly one bucket:
//     confirmed  - the dollar result is believable: counted in the money
//     uncertain  - we can see the trade but its dollar result could be wrong
//                  (reasons are saved with the trade, e.g. a native ETH leg we
//                  can't see, a junk coin price, coins sent to another wallet)
//     unpriced   - a coin it moved has no price at all
//   Only CONFIRMED trades count toward "made" and "kept". Gas is always
//   counted in full, and the report splits it so the numbers add up:
//     gas total = gas on confirmed + gas on failed + gas on uncertain/unpriced
//     kept      = made - gas on confirmed - gas on failed
//     kept if the unknown trades made nothing = kept - gas on uncertain/unpriced
//
// Junk prices (first fix, Oct 8 morning): a junk coin's price comes from its
// own tiny, lopsided pool, so a trade in it could be "worth" thousands of
// dollars either way (the report once said rivals made -$24,742, and one bot
// made $10,065 from 96 trades). A trade's profit is UNTRUSTED when:
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
// A bot counts as VERIFIED once we've seen it make this many confirmed,
// closed-loop wins (ended with more of a coin and less of none).
export const VERIFIED_BOT_WINS = 3;
// Records kept in memory (26 h window). Each is ~0.5 kB with route + amounts.
const MAX_RECS = 30_000;

const TRANSFER = ethers.id('Transfer(address,address,uint256)');
// WETH wrap/unwrap events. They emit NO Transfer, and the matching native
// ETH movement has no log at all, so the two cancel out: wrapping is not a
// gain or a loss. We only note that it happened (see analyze()).
const WETH_DEPOSIT = ethers.id('Deposit(address,uint256)');
const WETH_WITHDRAWAL = ethers.id('Withdrawal(address,uint256)');
const V4_SWAP = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const SWAP_TOPICS = new Set([
  ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)'),                     // V2 / Solidly
  ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)'),                 // V3
  ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)'), // PancakeSwap V3
  V4_SWAP,                                                                                // Uniswap V4
]);
// REAL flash loans only. A normal V3 swap also pays the bot first and takes
// payment in a callback, but that is ordinary V3 mechanics, not a loan, and
// it emits no Flash event, so it is (correctly) not counted here.
const FLASH_TOPICS = new Set([
  ethers.id('Flash(address,address,uint256,uint256,uint256,uint256)'),            // Uniswap/Pancake V3 flash
  ethers.id('FlashLoan(address,address,address,uint256,uint8,uint256,uint16)'),   // Aave V3
  ethers.id('FlashLoan(address,address,uint256,uint256)'),                        // Balancer
]);

type Log = { address: string; topics: string[]; data: string };
const addrFromTopic = (t: string) => '0x' + t.slice(26).toLowerCase();

// Why a trade's dollar result is not confirmed (saved with the record).
export type UncertainReason =
  | 'v4-native-leg'        // went through a V4 pool that holds plain ETH: that leg has no log, so it's invisible
  | 'v4-pool-unknown'      // went through a V4 pool we can't check for plain ETH
  | 'native-eth-sent'      // the transaction itself carried plain ETH (not visible in logs)
  | 'open-position'        // ended with LESS of some coin: a swap, not a closed arbitrage loop
  | 'profit-sent-elsewhere'// no visible gain, but coins went to a wallet outside the trade
  | 'junk-price'           // impossible profit, or priced from a shallow pool (see isJunkProfit)
  | 'gas-unpriced';        // no ETH price, so gas could not be valued

export type Confidence = 'confirmed' | 'uncertain' | 'unpriced';

// What one trade did, from its receipt logs (pure, unit-tested).
export interface RivalTrade {
  bot: string;
  net: Map<string, bigint>;     // coin -> change in the trader's balance (bot + its wallet)
  outflow: Map<string, bigint>; // coin -> total the trader sent out (trade size)
  pools: string[];              // pool addresses (V2/V3) and pool ids (V4)
  v4Pools: string[];            // the V4 pool ids among them
  flash: boolean;               // a real flash-loan event fired
  wrapped: boolean;             // WETH was wrapped/unwrapped (accounting-neutral)
  external: string[];           // addresses outside the trade that received coins from it
}

// One saved record (compact; prices already applied). Fields after `ours`
// were added in the Phase 1 fixes; older saved records may lack them.
export interface RivalRec {
  t: number;            // when (ms)
  bot: string;
  pair: string;         // e.g. "USDG/WETH" or "AMZN/USDG/WETH"
  pools: number;        // pools in the route
  sizeUsd: number | null;   // what it put in
  grossUsd: number | null;  // profit before gas (null = coins we can't price)
  gasUsd: number | null;    // gas it paid
  failed: boolean;      // trade reverted (paid gas, did nothing)
  flash: boolean;       // borrowed via a real flash loan
  ours: boolean;        // every pool in the route is one we watch
  thinPrice?: boolean;  // a coin it moved is priced from a pool under $5k
  // --- audit trail (Phase 1) ---
  hash?: string;        // transaction hash
  block?: number;       // block number
  from?: string;        // the wallet that sent it (usually the bot's owner)
  route?: string[];     // pools / V4 pool ids, in log order (max 6)
  deltas?: [string, string][]; // [coin, raw change] for the trader (max 6)
  conf?: Confidence;    // how far we trust the dollar result
  why?: UncertainReason[]; // reasons it is not confirmed
  closedLoop?: boolean; // ended with more of some coin and less of none
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

// Which bucket a record falls in. Works on old saved records too.
export type Bucket = 'failed' | 'unpriced' | 'junk' | 'uncertain' | 'confirmed';
export function bucketOf(r: RivalRec): Bucket {
  if (r.failed) return 'failed';
  if (r.grossUsd === null || r.conf === 'unpriced') return 'unpriced';
  if (isJunkProfit(r)) return 'junk';
  if (r.conf === 'uncertain') return 'uncertain';
  return 'confirmed';
}

// Chain-wide sample (sampler): how many rival-style trades exist in randomly
// read blocks, and how many of those come from bots we follow. This is how we
// estimate what share of the market our numbers cover.
export interface SampleStats {
  blocks: number;        // blocks read
  arbs: number;          // closed-loop multi-pool trades seen in them
  followed: number;      // of those, by a bot (or bot wallet) we follow
  confirmedNetUsd: number; // their confirmed money kept, after gas
  firstBlock: number | null; lastBlock: number | null; // block range covered (for scaling)
}
const emptySample = (): SampleStats => ({ blocks: 0, arbs: 0, followed: 0, confirmedNetUsd: 0, firstBlock: null, lastBlock: null });

export interface RivalSummary {
  trades: number; failed: number; unpriced: number;
  junk: number;                 // profit not trusted (junk coin prices), left out of money totals
  uncertain: number;            // other trades whose dollar result can't be confirmed (see whyUncertain)
  wins: number;                 // CONFIRMED trades that made money after gas
  grossUsd: number;             // made, before gas (confirmed trades only)
  gasUsd: number;               // ALL gas paid (= the three below)
  gasConfirmedUsd: number;      //   on confirmed trades
  gasFailedUsd: number;         //   on failed trades
  gasUnknownUsd: number;        //   on unpriced / junk / uncertain trades
  gasNotPriced: number;         // trades whose gas couldn't be valued (no ETH price)
  netUsd: number;               // kept = grossUsd - gasConfirmedUsd - gasFailedUsd
  netWorstUsd: number;          // kept if every unknown trade made nothing: netUsd - gasUnknownUsd
  medianSizeUsd: number | null; medianWinUsd: number | null; medianGasUsd: number | null;
  routes: { two: number; three: number; fourPlus: number }; // trades that went through (failed ones show 0 pools)
  flash: number; onOurPools: number;
  byPair: [string, number, number][];                          // [pair, wins, net $] (confirmed only)
  byBot: { bot: string; trades: number; netUsd: number; medianSizeUsd: number | null; avgPools: number; flash: number; verified: boolean }[];
  bots: number;
  verifiedBots: number;         // bots in this window that are verified (see VERIFIED_BOT_WINS)
  whyUncertain: [UncertainReason, number][]; // reason -> trades (uncertain + junk)
  sample?: SampleStats;         // chain-wide sample for the same period (hourly only)
  // Confirmed rival wins we could NOT have taken today, and why:
  //   notWatched = a pool in the route is one we don't read (unknown DEX or pool)
  //   loops      = 3+ pool route (our bot only does 2-pool trades)
  missed: { notWatched: number; notWatchedUsd: number; loops: number; loopsUsd: number };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// Adds up records into report numbers. `verified` = bots verified so far
// (from RivalWatch); without it, a bot is verified if this window alone has
// enough confirmed closed-loop wins.
export function summarize(recs: RivalRec[], verified?: Set<string>): RivalSummary {
  const byPair = new Map<string, { n: number; usd: number }>();
  // okN/okPools: trades that went through, and their pool count. Failed
  // trades record 0 pools, so counting them dragged "avg pools" down.
  const byBot = new Map<string, { n: number; usd: number; sizes: number[]; okN: number; okPools: number; flash: number; loopWins: number }>();
  const out: RivalSummary = {
    trades: recs.length, failed: 0, unpriced: 0, junk: 0, uncertain: 0, wins: 0,
    grossUsd: 0, gasUsd: 0, gasConfirmedUsd: 0, gasFailedUsd: 0, gasUnknownUsd: 0, gasNotPriced: 0,
    netUsd: 0, netWorstUsd: 0,
    medianSizeUsd: null, medianWinUsd: null, medianGasUsd: null,
    routes: { two: 0, three: 0, fourPlus: 0 }, flash: 0, onOurPools: 0, byPair: [], byBot: [], bots: 0,
    verifiedBots: 0, whyUncertain: [],
    missed: { notWatched: 0, notWatchedUsd: 0, loops: 0, loopsUsd: 0 },
  };
  const why = new Map<UncertainReason, number>();
  const sizes: number[] = [], wins: number[] = [], gases: number[] = [];
  for (const r of recs) {
    const gas = r.gasUsd ?? 0;
    if (r.gasUsd !== null) { gases.push(r.gasUsd); out.gasUsd += r.gasUsd; } else out.gasNotPriced++;
    if (r.flash) out.flash++;
    if (r.ours) out.onOurPools++;
    const b = byBot.get(r.bot) ?? { n: 0, usd: 0, sizes: [], okN: 0, okPools: 0, flash: 0, loopWins: 0 };
    b.n++; if (r.flash) b.flash++;
    byBot.set(r.bot, b);
    const bucket = bucketOf(r);
    if (bucket === 'failed') { out.failed++; out.gasFailedUsd += gas; b.usd -= gas; continue; }
    // Route shape only for trades that went through.
    b.okN++; b.okPools += r.pools;
    if (r.pools <= 2) out.routes.two++; else if (r.pools === 3) out.routes.three++; else out.routes.fourPlus++;
    if (bucket !== 'confirmed') {
      // Seen, counted, gas counted, but no profit or loss claimed.
      out.gasUnknownUsd += gas;
      if (bucket === 'unpriced') out.unpriced++;
      else if (bucket === 'junk') { out.junk++; why.set('junk-price', (why.get('junk-price') ?? 0) + 1); }
      else out.uncertain++;
      for (const w of r.why ?? []) if (w !== 'junk-price') why.set(w, (why.get(w) ?? 0) + 1);
      continue;
    }
    // Confirmed: real money. Junk/thin-priced sizes are left out of
    // "typical trade size" too, since their dollar size is just as wrong.
    if (r.sizeUsd !== null && !r.thinPrice) { sizes.push(r.sizeUsd); b.sizes.push(r.sizeUsd); }
    out.gasConfirmedUsd += gas;
    out.grossUsd += r.grossUsd!;
    const net = r.grossUsd! - gas;
    b.usd += net;
    if (net > 0) {
      out.wins++; wins.push(net);
      if (r.closedLoop !== false) b.loopWins++;
      if (!r.ours) { out.missed.notWatched++; out.missed.notWatchedUsd += net; }
      if (r.pools >= 3) { out.missed.loops++; out.missed.loopsUsd += net; }
      const p = byPair.get(r.pair) ?? { n: 0, usd: 0 };
      p.n++; p.usd += net; byPair.set(r.pair, p);
    }
  }
  // The identity the report relies on (see the header).
  out.netUsd = out.grossUsd - out.gasConfirmedUsd - out.gasFailedUsd;
  out.netWorstUsd = out.netUsd - out.gasUnknownUsd;
  out.medianSizeUsd = median(sizes); out.medianWinUsd = median(wins); out.medianGasUsd = median(gases);
  out.byPair = [...byPair.entries()].sort((a, b) => b[1].usd - a[1].usd).map(([p, e]) => [p, e.n, e.usd]);
  out.byBot = [...byBot.entries()].map(([bot, e]) => ({
    bot, trades: e.n, netUsd: e.usd, medianSizeUsd: median(e.sizes),
    avgPools: e.okN ? e.okPools / e.okN : 0, flash: e.flash,
    verified: verified ? verified.has(bot) : e.loopWins >= VERIFIED_BOT_WINS,
  })).sort((a, b) => b.netUsd - a.netUsd);
  out.bots = byBot.size;
  out.verifiedBots = out.byBot.filter((b) => b.verified).length;
  out.whyUncertain = [...why.entries()].sort((a, b) => b[1] - a[1]);
  return out;
}

// Where a bot on our list came from (shown in reports; seeds are unproven
// until the bot earns VERIFIED_BOT_WINS confirmed wins in front of us).
export type BotSource = 'seed' | 'tracker' | 'sampler' | 'owner';
interface BotInfo { src: BotSource; trades: number; wins: number; firstSeen: number }

export interface RivalWatchOptions {
  // How much money is in the pool a coin's price comes from (null = no
  // price). Without it, only the profit-vs-size rule flags junk prices.
  priceDepthUsd?: (token: string) => number | null;
  // Does this V4 pool hold plain ETH? true / false, or null if we don't know
  // the pool. Without it, every V4 trade is "uncertain" (we can't rule out an
  // invisible plain-ETH leg).
  v4IsNative?: (poolId: string) => boolean | null;
  // The V4 PoolManager: coins sent there are part of the trade, not "elsewhere".
  v4PoolManager?: string;
}

export class RivalWatch {
  private bots = new Map<string, BotInfo>();
  private owners = new Map<string, string>();         // wallet -> bot it runs (learned from confirmed wins)
  private candidates = new Map<string, number>();     // sampler/owner: address -> profitable multi-pool trades seen
  private queue: { hash: string; bot: string; dueAt: number; value?: bigint; probe?: boolean }[] = [];
  private queued = new Set<string>();                 // hashes already queued (no double counting)
  private busy = false;
  private recs: RivalRec[] = [];
  private hourFrom: number;
  private sample = emptySample();
  private readonly opts: RivalWatchOptions;

  constructor(
    private readonly rpc: (method: string, params: unknown[]) => Promise<any>,
    private readonly tokenUsd: (token: string, raw: bigint) => number | null,
    private readonly symbol: (token: string) => string,
    private readonly isWatchedPool: (pool: string) => boolean,
    private readonly weth: string,
    private readonly now: () => number = Date.now,
    private readonly delayMs = 3_000,
    // Options object, or (older callers) just the price-depth lookup.
    opts?: RivalWatchOptions | ((token: string) => number | null),
  ) {
    this.hourFrom = now();
    this.opts = typeof opts === 'function' ? { priceDepthUsd: opts } : (opts ?? {});
  }

  addBot(addr: string | undefined, src: BotSource = 'tracker') {
    if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return;
    const a = addr.toLowerCase();
    const have = this.bots.get(a);
    if (!have) this.bots.set(a, { src, trades: 0, wins: 0, firstSeen: this.now() });
    else if (src === 'seed') have.src = 'seed'; // seeds keep their label across restarts
  }
  botCount() { return this.bots.size; }
  // Bots that have proven themselves in front of us (closed-loop wins).
  verifiedBots(): Set<string> { return new Set([...this.bots.entries()].filter(([, i]) => i.wins >= VERIFIED_BOT_WINS).map(([a]) => a)); }
  // For reports: how many bots on the list are verified vs still unproven, by source.
  botStatus(): { total: number; verified: number; unproven: number; bySource: Record<BotSource, { total: number; verified: number }> } {
    const bySource = { seed: { total: 0, verified: 0 }, tracker: { total: 0, verified: 0 }, sampler: { total: 0, verified: 0 }, owner: { total: 0, verified: 0 } };
    let verified = 0;
    for (const i of this.bots.values()) {
      bySource[i.src].total++;
      if (i.wins >= VERIFIED_BOT_WINS) { verified++; bySource[i.src].verified++; }
    }
    return { total: this.bots.size, verified, unproven: this.bots.size - verified, bySource };
  }

  // Every feed transaction: queue it if it went to a rival bot, or came from
  // a wallet that runs one (catches an operator's new or second contract).
  noteTx(to: string | undefined, hash: string | undefined, from?: string, value?: string | bigint) {
    if (!to || !hash) return;
    const bot = to.toLowerCase();
    const known = this.bots.has(bot);
    const viaOwner = !known && !!from && this.owners.has(from.toLowerCase());
    if ((!known && !viaOwner) || this.queue.length >= 100 || this.queued.has(hash)) return;
    let v: bigint | undefined;
    try { v = value !== undefined && value !== null ? BigInt(value) : undefined; } catch { v = undefined; }
    this.queued.add(hash);
    if (this.queued.size > 5_000) this.queued.clear(); // bounded memory
    this.queue.push({ hash, bot, dueAt: this.now() + this.delayMs, value: v, probe: viaOwner });
    void this.drain();
  }

  // Reads one trade from its receipt logs. `traders` = the bot contract plus
  // (optionally) the wallet that sent the transaction: profit is often swept
  // to the owner wallet in the same transaction, and moves between the two
  // are internal, not gains or losses.
  static analyze(logs: Log[], traders: string | string[], v4PoolManager?: string): RivalTrade {
    const who = new Set((Array.isArray(traders) ? traders : [traders]).filter(Boolean).map((x) => x.toLowerCase()));
    const bot = [...who][0];
    const pm = v4PoolManager?.toLowerCase();
    const net = new Map<string, bigint>();
    const outflow = new Map<string, bigint>();
    const pools = new Set<string>();
    const v4Pools = new Set<string>();
    const sentTo = new Set<string>();
    let flash = false, wrapped = false;
    for (const l of logs) {
      const t0 = l.topics?.[0];
      if (!t0) continue;
      if (FLASH_TOPICS.has(t0)) flash = true;
      if (t0 === TRANSFER && l.topics.length >= 3) {
        const from = addrFromTopic(l.topics[1]);
        const to = addrFromTopic(l.topics[2]);
        const fromUs = who.has(from), toUs = who.has(to);
        if (fromUs === toUs) continue; // not ours, or bot <-> owner wallet (internal)
        let v: bigint;
        try { v = BigInt(l.data); } catch { continue; }
        const tok = l.address.toLowerCase();
        net.set(tok, (net.get(tok) ?? 0n) + (toUs ? v : -v));
        if (fromUs) { outflow.set(tok, (outflow.get(tok) ?? 0n) + v); sentTo.add(to); }
      } else if ((t0 === WETH_DEPOSIT || t0 === WETH_WITHDRAWAL) && l.topics.length >= 2 && who.has(addrFromTopic(l.topics[1]))) {
        // Wrap/unwrap by the trader: WETH and plain ETH swap places 1:1 with
        // no Transfer log, so leaving both out keeps the accounting right.
        wrapped = true;
      } else if (SWAP_TOPICS.has(t0)) {
        if (t0 === V4_SWAP) { const id = l.topics[1].toLowerCase(); pools.add(id); v4Pools.add(id); }
        else pools.add(l.address.toLowerCase());
      }
    }
    // Coins sent to something that isn't a pool in this trade (or the V4
    // PoolManager, which holds every V4 pool's coins) went "elsewhere".
    const external = [...sentTo].filter((a) => !pools.has(a) && a !== pm);
    return { bot, net, outflow, pools: [...pools], v4Pools: [...v4Pools], flash, wrapped, external };
  }

  // Receipt -> saved record (null if it isn't a multi-pool trade).
  // ctx.value = plain ETH the transaction carried (from the feed), if known.
  toRec(rcpt: any, bot: string, t = this.now(), ctx: { value?: bigint } = {}): RivalRec | null {
    const failed = rcpt.status === '0x0';
    const gasWei = BigInt(rcpt.gasUsed ?? '0x0') * BigInt(rcpt.effectiveGasPrice ?? '0x0');
    const gasUsd = this.tokenUsd(this.weth, gasWei);
    const hash: string | undefined = rcpt.transactionHash ?? undefined;
    const block = rcpt.blockNumber ? Number(BigInt(rcpt.blockNumber)) : undefined;
    const from: string | undefined = rcpt.from ? String(rcpt.from).toLowerCase() : undefined;
    const audit = { ...(hash ? { hash } : {}), ...(block !== undefined ? { block } : {}), ...(from ? { from } : {}) };
    if (failed) return { t, bot, pair: '(failed)', pools: 0, sizeUsd: null, grossUsd: null, gasUsd, failed: true, flash: false, ours: false, ...audit };
    const traders = from && from !== bot.toLowerCase() ? [bot, from] : [bot];
    const tr = RivalWatch.analyze(rcpt.logs ?? [], traders, this.opts.v4PoolManager);
    if (tr.pools.length < 2) return null; // not an arbitrage

    // Dollar value of the result.
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
    if (this.opts.priceDepthUsd) {
      for (const tok of new Set([...tr.net.keys(), ...tr.outflow.keys()])) {
        if ((tr.net.get(tok) ?? 0n) === 0n && !tr.outflow.get(tok)) continue;
        const d = this.opts.priceDepthUsd(tok);
        if (d !== null && d < MIN_PRICE_POOL_USD) { thinPrice = true; break; }
      }
    }

    // Shape and confidence.
    const moves = [...tr.net.values()].filter((v) => v !== 0n);
    const closedLoop = moves.length > 0 && moves.every((v) => v > 0n);
    const why: UncertainReason[] = [];
    for (const id of tr.v4Pools) {
      const native = this.opts.v4IsNative ? this.opts.v4IsNative(id) : null;
      if (native === true) { why.push('v4-native-leg'); break; }
      if (native === null) { why.push('v4-pool-unknown'); break; }
    }
    if (ctx.value && ctx.value > 0n) why.push('native-eth-sent');
    if (moves.some((v) => v < 0n)) why.push('open-position');
    if (!moves.some((v) => v > 0n) && tr.external.length) why.push('profit-sent-elsewhere');
    if (gasUsd === null) why.push('gas-unpriced');
    const grossUsd = priced && !unpricedMove ? gross : null;
    const base: RivalRec = {
      t, bot, pair, pools: tr.pools.length, sizeUsd: size, grossUsd, gasUsd, failed: false, flash: tr.flash,
      ours: tr.pools.every((p) => this.isWatchedPool(p)),
      ...(thinPrice ? { thinPrice: true } : {}),
      ...audit,
      route: tr.pools.slice(0, 6),
      deltas: [...tr.net.entries()].filter(([, v]) => v !== 0n).slice(0, 6).map(([k, v]) => [k, v.toString()]),
      closedLoop,
    };
    if (isJunkProfit(base)) why.push('junk-price');
    const conf: Confidence = grossUsd === null ? 'unpriced' : why.length ? 'uncertain' : 'confirmed';
    return { ...base, conf, ...(why.length ? { why } : {}) };
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
            const rec = this.toRec(rcpt, job.bot, this.now(), { value: job.value });
            if (rec && job.probe) this.considerOwnerTrade(rec);
            else if (rec) this.add(rec);
          }
        } catch { /* RPC hiccup: drop this one */ }
        await new Promise((res) => setTimeout(res, 1_000));
      }
    } finally {
      this.busy = false;
    }
  }

  // A trade sent by a known bot's wallet to a contract we don't follow yet:
  // only a confirmed, closed-loop win counts, and two of them make it a bot.
  private considerOwnerTrade(rec: RivalRec) {
    if (bucketOf(rec) !== 'confirmed' || !rec.closedLoop || (rec.grossUsd ?? 0) - (rec.gasUsd ?? 0) <= 0) return;
    const n = (this.candidates.get(rec.bot) ?? 0) + 1;
    this.candidates.set(rec.bot, n);
    if (n >= 2) {
      this.addBot(rec.bot, 'owner'); this.candidates.delete(rec.bot);
      console.log(`[rivalwatch] new rival bot found via its owner wallet: ${rec.bot}`);
      this.add(rec);
    }
  }

  add(rec: RivalRec) {
    this.recs.push(rec);
    const cutoff = this.now() - 26 * 3600_000;
    if (this.recs.length > MAX_RECS || (this.recs.length % 500 === 0 && this.recs[0]?.t < cutoff)) this.recs = this.recs.filter((r) => r.t >= cutoff).slice(-MAX_RECS);
    // Bot track record (for "verified") and its owner wallet.
    const info = this.bots.get(rec.bot);
    const bucket = bucketOf(rec);
    const net = rec.grossUsd !== null ? rec.grossUsd - (rec.gasUsd ?? 0) : null;
    if (info) {
      info.trades++;
      if (bucket === 'confirmed' && rec.closedLoop !== false && net !== null && net > 0) {
        info.wins++;
        if (rec.from && rec.from !== rec.bot) this.owners.set(rec.from, rec.bot);
        if (this.owners.size > 2_000) this.owners.clear();
      }
    }
    // Only confirmed trades get "~$" so the status page adds up only those.
    const money = bucket === 'failed' ? `gas $${(rec.gasUsd ?? 0).toFixed(4)}`
      : bucket === 'unpriced' ? 'unpriced'
      : bucket === 'junk' ? `junk price (said $${net!.toFixed(2)}, ignored)`
      : bucket === 'uncertain' ? `uncertain (${(rec.why ?? []).join(',')}; said $${net!.toFixed(4)}, ignored)`
      : `~$${net!.toFixed(4)}`;
    console.log(`[rivalwatch] bot ${rec.bot.slice(0, 10)} ${rec.failed ? 'FAILED' : rec.pair} ${money} | ${rec.pools} pools, size ${rec.sizeUsd === null ? '?' : '$' + rec.sizeUsd.toFixed(0)}, gas ${rec.gasUsd === null ? '?' : '$' + rec.gasUsd.toFixed(4)}${rec.flash ? ', flash loan' : ''}, ${rec.ours ? 'all watched by us' : 'NOT all watched by us'}${rec.hash ? ` tx ${rec.hash}` : ''}`);
  }

  // Sampler: read one recent block's receipts. Two jobs:
  //  1) find new rival bots: a contract becomes a "rival" after 2 trades
  //     where it went through 2+ pools and (together with the wallet that
  //     sent it) ended with more of some coin and less of none. A trading app
  //     passes coins on to its user, so the user ends with LESS of what they
  //     paid: not a closed loop, never counted.
  //  2) measure coverage: of the rival-style trades in sampled blocks, how
  //     many come from bots we already follow.
  async sampleBlock(blockTag: string): Promise<number> {
    const r = await this.rpc('eth_getBlockReceipts', [blockTag]);
    const rcpts: any[] = r?.result ?? r ?? [];
    if (!Array.isArray(rcpts)) return 0;
    const bn = Number(BigInt(blockTag));
    this.sample.blocks++;
    this.sample.firstBlock = this.sample.firstBlock === null ? bn : Math.min(this.sample.firstBlock, bn);
    this.sample.lastBlock = this.sample.lastBlock === null ? bn : Math.max(this.sample.lastBlock, bn);
    let added = 0;
    for (const rc of rcpts) {
      if (rc.status !== '0x1' || !rc.to) continue;
      const to = rc.to.toLowerCase();
      const from = rc.from ? String(rc.from).toLowerCase() : undefined;
      const tr = RivalWatch.analyze(rc.logs ?? [], from ? [to, from] : [to], this.opts.v4PoolManager);
      if (tr.pools.length < 2) continue;
      const moves = [...tr.net.values()].filter((v) => v !== 0n);
      if (!moves.length || moves.some((v) => v < 0n)) continue;
      // A rival-style trade. Coverage numbers:
      const followed = this.bots.has(to) || (!!from && this.owners.has(from));
      this.sample.arbs++;
      if (followed) this.sample.followed++;
      const rec = this.toRec(rc, to);
      if (rec && bucketOf(rec) === 'confirmed') this.sample.confirmedNetUsd += rec.grossUsd! - (rec.gasUsd ?? 0);
      if (followed) continue;
      const n = (this.candidates.get(to) ?? 0) + 1;
      this.candidates.set(to, n);
      if (n >= 2) { this.addBot(to, 'sampler'); this.candidates.delete(to); added++; console.log(`[rivalwatch] new rival bot found by sampling: ${to}`); }
    }
    if (this.candidates.size > 5_000) this.candidates.clear();
    return added;
  }

  // Summaries for the reports.
  summary(fromMs: number, toMs = this.now()): RivalSummary { return summarize(this.recs.filter((r) => r.t >= fromMs && r.t < toMs), this.verifiedBots()); }
  // When the earliest saved record at/after fromMs is (for "last N hours" labels).
  firstRecordMs(fromMs: number): number { const r = this.recs.find((x) => x.t >= fromMs); return r ? r.t : this.now(); }
  // Hourly: the hour's trades plus the chain-wide sample for the same hour.
  takeHour(): RivalSummary {
    const s = this.summary(this.hourFrom);
    s.sample = this.sample;
    this.sample = emptySample();
    this.hourFrom = this.now();
    return s;
  }

  load(botsFile: string, recsFile: string): { bots: number; recs: number } {
    try {
      // Old format: ["0x..", ...]. New format: [{ a, src, trades, wins, firstSeen }, ...].
      for (const b of JSON.parse(readFileSync(botsFile, 'utf8')) as (string | { a: string; src?: BotSource; trades?: number; wins?: number; firstSeen?: number })[]) {
        if (typeof b === 'string') { this.addBot(b, 'tracker'); continue; }
        this.addBot(b.a, b.src ?? 'tracker');
        const i = this.bots.get(b.a.toLowerCase());
        if (i) { i.trades = b.trades ?? 0; i.wins = b.wins ?? 0; i.firstSeen = b.firstSeen ?? i.firstSeen; }
      }
    } catch { /* first run */ }
    try {
      const cutoff = this.now() - 26 * 3600_000;
      const rows = JSON.parse(readFileSync(recsFile, 'utf8')) as RivalRec[];
      this.recs = rows.filter((r) => r.t >= cutoff).slice(-MAX_RECS);
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
    write(botsFile, [...this.bots.entries()].map(([a, i]) => ({ a, ...i })));
    write(recsFile, this.recs);
  }
}
